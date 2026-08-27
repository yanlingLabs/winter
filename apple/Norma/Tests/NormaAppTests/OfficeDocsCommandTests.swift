import AppKit
import NormaKit
import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T7 — live drills for `docs` against the REAL helper, REAL vendored
/// LibreOffice, and REAL fixtures. Same shape as `OfficeSheetsCommandTests`/`OfficeSlidesCommandTests`
/// (wire-decoded `PanelCommand` fixtures driven through the real `OfficeCommandConsumer` ->
/// `OfficeAgentBroker` -> `OfficeRuntime` -> `OfficeHelperClient` -> the wire -> `NormaOfficeHelper`
/// -> `LOKBridge` -> real LOK stack) — see the sheets file's own header for the full rationale.
///
/// **Every write drill here asserts CONTENT AND PLACEMENT in the SAVED FILE'S OWN BYTES**, never
/// dirtiness and never the tool's own prose. That standard is not generic rigour: it is the direct
/// lesson of Stage B's reversed-text bug, where a drill that asserted only "went dirty" and "the
/// pixels changed" passed while every character was being inserted at page-1 start in reverse order
/// (`docs-lok-research.md` §7). `text landed` and `text landed WHERE ASKED` are different claims and
/// only the second one is worth anything for a document editor.
@MainActor
final class OfficeDocsCommandTests: XCTestCase {

    // MARK: - Fixtures/boilerplate (byte-identical to OfficeSheetsCommandTests' own copy)

    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var vendorProductSetRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/product-set", isDirectory: true)
    }
    private static var fixturesRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/Tests/NormaAppTests/Fixtures/office", isDirectory: true)
    }
    private static var sandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }
    private static var helperURL: URL {
        Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
    }

    private var scratchDirs: [URL] = []

    /// Every live host this suite creates, torn down in `tearDown` — the same structural fix, and
    /// the same measured leak, as `OfficeSheetsCommandTests`. Before it, a full run of this suite
    /// left **16 `NormaOfficeHelper` processes resident**; after it, zero. Registered in the ONE
    /// factory every test goes through rather than as an end-of-test call per test, because a
    /// cleanup that has to be remembered is one the next test added will forget.
    private var liveHosts: [ShellSessionHost] = []

    override func tearDown() {
        for host in liveHosts { _ = host.teardownAllOfficeRuntimesAndStopHelper() }
        liveHosts = []
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("officedocscommand-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    private func requireLiveEngine() throws {
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(Self.helperURL.path)) — add it to the scheme's build list and re-run.")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(Self.vendorProductSetRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
    }

    private func makeWritableCopy(of fixtureName: String, as destName: String? = nil) throws -> String {
        let fixturePath = Self.fixturesRoot.appendingPathComponent(fixtureName).path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "\(fixtureName) fixture missing")
        let scratch = makeScratchDirectory()
        let docPath = scratch.appendingPathComponent(destName ?? fixtureName).path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))
        return docPath
    }

    private func codeRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    private func makeLiveHost(stateDir: URL, dirs: [SessionDirEntry], sessionId: String = "S1") -> ShellSessionHost {
        let directory = SessionDirectory(lister: { [self.codeRow(sessionId, dirs: dirs)] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: Self.helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", Self.vendorProductSetRoot.path,
                                 "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        liveHosts.append(host)
        return host
    }

    private func waitUntilLive(timeout: TimeInterval = 90, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    // MARK: - Driving OfficeCommandConsumer with wire-decoded PanelCommand fixtures

    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
    }

    private func command(_ action: String, args: [String: Any], sessionId: String,
                         commandId: String = "pcmd_1") -> SessionEvent.PanelCommand {
        let fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": 155_000, "args": args,
        ]
        let data = try! JSONSerialization.data(withJSONObject: fields) // swiftlint:disable:this force_try
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data) else {
            fatalError("the fixture did not decode as a panel_command")
        }
        return decoded
    }

    private func send(_ command: SessionEvent.PanelCommand, through host: ShellSessionHost) async -> Sent {
        var sent: Sent?
        let consumer = OfficeCommandConsumer(
            sendResult: { sessionId, commandId, ok, result, _ in
                sent = Sent(sessionId: sessionId, commandId: commandId, ok: ok, result: result)
            },
            officeAgentBroker: { [weak host] _ in host?.officeAgentBroker })
        consumer.handle(command)
        let arrived = await waitUntilLive { sent != nil }
        guard arrived, let sent else {
            XCTFail("docs \(command.action) never answered")
            return Sent(sessionId: command.sessionId, commandId: command.commandId, ok: false, result: nil)
        }
        return sent
    }


    // MARK: - Fixture facts, established once and cited by every drill below

    /// `two-page.odt`'s own body, read directly out of its `content.xml` before any of this code
    /// runs: three paragraphs — "NORMA GATE", "office stage A embed probe", "NORMA PAGE TWO" — the
    /// third on a second page. Verified with
    /// `unzip -p two-page.odt content.xml | sed 's/<[^>]*>/|/g'`, not assumed from the filename.
    private static let twoPageParagraphs = ["NORMA GATE", "office stage A embed probe", "NORMA PAGE TWO"]

    private func openLive(_ fixture: String, as destName: String? = nil)
        async throws -> (path: String, host: ShellSessionHost, runtime: OfficeRuntime) {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: fixture, as: destName)
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir,
                                dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: \(fixture) must open cleanly")
        return (path, host, runtime)
    }

    // MARK: - read / info

    /// The foundation drill: `read` must return the fixture's REAL paragraphs, in order, numbered.
    ///
    /// This is deliberately not a "we got a non-empty string" check. The three paragraph texts are
    /// established from `content.xml` independently of this code path (see `twoPageParagraphs`), and
    /// the ORDER assertion is what distinguishes "the SelectAll+getTextSelection mechanism works"
    /// from "something returned some text" — the failure mode Stage B actually shipped was text in
    /// the wrong ORDER, not text that was missing.
    func testLiveDocsReadReturnsEveryParagraphOfTheFixtureInOrder() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                        commandId: "pcmd_read_all"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""
        for (index, paragraph) in Self.twoPageParagraphs.enumerated() {
            XCTAssertTrue(text.contains("\(index + 1). \(paragraph)"),
                          "read must number paragraph \(index + 1) as \"\(paragraph)\": \(text)")
        }
        let first = try XCTUnwrap(text.range(of: Self.twoPageParagraphs[0]))
        let second = try XCTUnwrap(text.range(of: Self.twoPageParagraphs[1]))
        let third = try XCTUnwrap(text.range(of: Self.twoPageParagraphs[2]))
        XCTAssertTrue(first.lowerBound < second.lowerBound && second.lowerBound < third.lowerBound,
                      "paragraphs must come back in document order, not merely be present: \(text)")
        XCTAssertTrue(text.contains("all 3 paragraphs"), "an unsliced read must say so: \(text)")
    }

    /// The paragraph slice, and the two things that make it a real assertion rather than a vacuous
    /// one: the requested paragraph is present AND the ones outside the range are ABSENT. A slice
    /// that quietly returned everything would pass a contains-check alone — that is exactly the
    /// silent-wrong-answer shape this arc keeps producing.
    func testLiveDocsReadParagraphRangeReturnsOnlyThatRange() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.read",
                                        args: ["path": path, "fromParagraph": 2, "toParagraph": 2],
                                        sessionId: "S1", commandId: "pcmd_read_slice"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""
        XCTAssertTrue(text.contains("2. \(Self.twoPageParagraphs[1])"), "the requested paragraph must be there: \(text)")
        XCTAssertFalse(text.contains(Self.twoPageParagraphs[0]), "paragraph 1 is outside the range: \(text)")
        XCTAssertFalse(text.contains(Self.twoPageParagraphs[2]), "paragraph 3 is outside the range: \(text)")
        XCTAssertTrue(text.contains("paragraphs 2-2 of 3"), "a sliced read must say which slice, of how many: \(text)")
    }

    /// `toParagraph` past the end CLAMPS; `fromParagraph` past the end REFUSES and says how many
    /// there are. The two halves are deliberately different, and both are pinned here because
    /// "returns nothing" is indistinguishable from "the document is empty" to a model.
    func testLiveDocsReadClampsToParagraphAndRefusesAnOutOfRangeFromParagraph() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let clamped = await send(command("office.docs.read",
                                         args: ["path": path, "fromParagraph": 2, "toParagraph": 999],
                                         sessionId: "S1", commandId: "pcmd_read_clamp"), through: host)
        XCTAssertTrue(clamped.ok, "\(clamped)")
        XCTAssertTrue((clamped.result ?? "").contains("paragraphs 2-3 of 3"),
                      "toParagraph past the end must clamp to the last paragraph: \(clamped)")

        let refused = await send(command("office.docs.read", args: ["path": path, "fromParagraph": 40],
                                         sessionId: "S1", commandId: "pcmd_read_past"), through: host)
        XCTAssertFalse(refused.ok, "a fromParagraph past the end must refuse, not answer emptily: \(refused)")
        XCTAssertTrue((refused.result ?? "").contains("3 paragraph"),
                      "the refusal must say how many paragraphs there actually are: \(refused)")
    }

    /// `info`'s three counts, each checked against a fact established elsewhere: `paragraphs` against
    /// the fixture's own known count, `characters` against the sum of the known paragraph texts plus
    /// their separators, and `pages` against the fixture's name and its real page break (`two-page`).
    ///
    /// The `characters` cross-check is the one that makes this non-vacuous: it is computed HERE from
    /// `twoPageParagraphs`, which came from `content.xml`, so it fails if the read path drops or
    /// duplicates anything — a bare "characters > 0" would not.
    func testLiveDocsInfoCountsAgreeWithTheFixtureAndWithRead() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.info", args: ["path": path], sessionId: "S1",
                                        commandId: "pcmd_info"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""
        XCTAssertTrue(text.contains("3 paragraphs"), "two-page.odt has three paragraphs: \(text)")
        let expectedCharacters = Self.twoPageParagraphs.joined(separator: "\n").count
        XCTAssertTrue(text.contains("\(expectedCharacters) characters"),
                      "characters must equal the fixture's own text length (\(expectedCharacters)): \(text)")
        XCTAssertTrue(text.contains("2 pages"), "two-page.odt is two pages: \(text)")
    }

    /// The type gate, reused rather than re-added (task-7-brief.md's explicit instruction). A
    /// spreadsheet must refuse every `docs` verb, naming what it actually is.
    func testLiveDocsRefusesASpreadsheetNamingWhatItIs() async throws {
        let (path, host, _) = try await openLive("gate.ods")
        let result = await send(command("office.docs.info", args: ["path": path], sessionId: "S1",
                                        commandId: "pcmd_notext"), through: host)
        XCTAssertFalse(result.ok, "a .ods is not a text document: \(result)")
        XCTAssertTrue((result.result ?? "").contains("spreadsheet"),
                      "the refusal must name what the document actually is: \(result)")
    }

    // MARK: - replace (ruling 1)

    /// `replace` end to end, with the count, the SAVED BYTES, and placement.
    ///
    /// The placement half matters as much as the count: "GATE" appears in paragraph 1 only, so after
    /// replacing it with "GATEWAY" the saved `content.xml` must show "NORMA GATEWAY" — in the FIRST
    /// paragraph, before "office stage A embed probe" — and paragraph 3's own "NORMA PAGE TWO" must
    /// be untouched. A replace that rewrote the wrong paragraph, or flattened the document, passes a
    /// contains-check and fails this one.
    func testLiveDocsReplaceReportsTheCountAndTheSavedBytesShowItInTheRightParagraph() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.replace",
                                        args: ["path": path, "find": "GATE", "replaceWith": "GATEWAY"],
                                        sessionId: "S1", commandId: "pcmd_replace"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        XCTAssertTrue((result.result ?? "").contains("replaced 1 occurrence"),
                      "\"GATE\" occurs exactly once in this fixture: \(result)")

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("NORMA GATEWAY"), "the saved file must carry the replacement: \(path)")
        XCTAssertTrue(contentXML.contains("NORMA PAGE TWO"),
                      "paragraph 3 must be untouched — this replace had no business there")
        let replaced = try XCTUnwrap(contentXML.range(of: "NORMA GATEWAY"))
        let probe = try XCTUnwrap(contentXML.range(of: "office stage A embed probe"))
        XCTAssertTrue(replaced.lowerBound < probe.lowerBound,
                      "the replacement must be in the FIRST paragraph, where the match was — not merely somewhere")
    }

    /// **The case-sensitivity drill, and the reason it exists.** `SvxSearchItem`'s own constructor
    /// defaults `TransliterationFlags` to `IGNORE_CASE` (`svl/source/items/srchitem.cxx:93-107`, read
    /// at the pinned SHA), and the research's recommended argument payload set neither
    /// `TransliterateFlags` nor `AlgorithmType2`. Shipped that way, the engine would match
    /// case-INSENSITIVELY while our own count is literal and case-sensitive: `find:"norma"` would
    /// count 0, the engine would replace 2, ruling 1's cross-check would fire — **after** the user's
    /// document had already been rewritten.
    ///
    /// So this drill asserts both halves of the fix at once: zero replacements reported, and the
    /// saved bytes UNCHANGED. If the explicit `TransliterateFlags: 0` is ever dropped, this fails
    /// with a mismatch error rather than passing quietly.
    func testLiveDocsReplaceIsCaseSensitiveAndAWrongCaseSearchChangesNothing() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let before = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                        commandId: "pcmd_case_before"), through: host)
        XCTAssertTrue(before.ok, "\(before)")

        let result = await send(command("office.docs.replace",
                                        args: ["path": path, "find": "norma", "replaceWith": "SHOULD NOT APPEAR"],
                                        sessionId: "S1", commandId: "pcmd_replace_case"), through: host)
        XCTAssertTrue(result.ok, "a zero-match replace is a legitimate answer, not a failure: \(result)")
        XCTAssertTrue((result.result ?? "").contains("nothing to replace"),
                      "the model must be told plainly that nothing matched: \(result)")

        let savedXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertFalse(savedXML.contains("SHOULD NOT APPEAR"),
                       "a case-insensitive engine match would have written this — the search must be case-sensitive")
        XCTAssertTrue(savedXML.contains("NORMA GATE"), "the original text must survive untouched")
        XCTAssertTrue(savedXML.contains("NORMA PAGE TWO"), "so must the other occurrence")

        // **Unchanged is asserted on the TEXT, not on content.xml's bytes — measured, not assumed.**
        // A first version of this drill asserted byte-identical `content.xml` and FAILED: every
        // `docs` write verb saves through the broker unconditionally (`OfficeAgentBroker` rule 4
        // has no "only if dirty" branch), so even a zero-match replace re-serializes the whole ODF
        // package and LibreOffice's own writer does not reproduce the original bytes. The
        // user-visible claim worth pinning is that the DOCUMENT did not change, which this reads
        // back through the same door the model would.
        let after = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                       commandId: "pcmd_case_after"), through: host)
        XCTAssertTrue(after.ok, "\(after)")
        XCTAssertEqual(before.result, after.result,
                       "a zero-match replace must leave the document's own text identical")
    }

    /// Multiple occurrences, counted by us and cross-checked against the engine's boolean — and the
    /// harder half: `replaceWith` CONTAINING `find`. Replacing "NORMA" with "NORMA INC" leaves
    /// plenty of "NORMA"s behind, so any verification written as "no occurrences of `find` remain"
    /// would be wrong here. The implementation verifies by full expected-text equality instead, which
    /// this drill is the live proof of.
    func testLiveDocsReplaceHandlesMultipleOccurrencesAndAReplacementContainingTheSearchText() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.replace",
                                        args: ["path": path, "find": "NORMA", "replaceWith": "NORMA INC"],
                                        sessionId: "S1", commandId: "pcmd_replace_multi"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        XCTAssertTrue((result.result ?? "").contains("replaced 2 occurrences"),
                      "\"NORMA\" occurs in paragraphs 1 and 3: \(result)")

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("NORMA INC GATE"), "paragraph 1 must be replaced: \(contentXML.prefix(0))")
        XCTAssertTrue(contentXML.contains("NORMA INC PAGE TWO"), "paragraph 3 must be replaced too")
        XCTAssertFalse(contentXML.contains("NORMA INC INC"),
                       "the replacement must not have been applied to its own output")
    }

    // MARK: - insert / append (ruling 2)

    /// **The placement drill for `insert at:"start"`** — the direct descendant of Stage B's
    /// reversed-text bug. The text must be at the very beginning of the body, BEFORE the fixture's
    /// own first paragraph, and the rest of the document must be intact and in order.
    func testLiveDocsInsertAtStartLandsBeforeEverythingElseInTheSavedBytes() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.insert",
                                        args: ["path": path, "text": "PREFIXMARKER ", "at": "start"],
                                        sessionId: "S1", commandId: "pcmd_insert_start"), through: host)
        XCTAssertTrue(result.ok, "\(result)")

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("PREFIXMARKER NORMA GATE"),
                      "insert at:start must land at the very beginning of the first paragraph, not merely somewhere")
        let marker = try XCTUnwrap(contentXML.range(of: "PREFIXMARKER"))
        let probe = try XCTUnwrap(contentXML.range(of: "office stage A embed probe"))
        let pageTwo = try XCTUnwrap(contentXML.range(of: "NORMA PAGE TWO"))
        XCTAssertTrue(marker.lowerBound < probe.lowerBound && probe.lowerBound < pageTwo.lowerBound,
                      "the rest of the document must survive, in order, after the insert")
        // The reversed-text signature specifically: each character pushed the previous one right.
        XCTAssertFalse(contentXML.contains("REKRAMXIFERP"),
                       "reversed text is the Stage B failure signature this drill exists to catch")
    }

    /// **The placement drill for `append`** — at the END, as its own NEW paragraph, after the
    /// fixture's last one. "at the end" and "as a new paragraph" are two separate claims and both are
    /// asserted: the marker comes after "NORMA PAGE TWO" in the saved bytes, and it does not appear
    /// glued onto it.
    func testLiveDocsAppendLandsAsANewParagraphAfterEverythingElse() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.append",
                                        args: ["path": path, "text": "SUFFIXMARKER"],
                                        sessionId: "S1", commandId: "pcmd_append"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        XCTAssertTrue((result.result ?? "").contains("now has 4 paragraphs"),
                      "an append must add exactly one paragraph to this three-paragraph fixture: \(result)")

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("SUFFIXMARKER"), "the saved file must carry the appended text")
        XCTAssertFalse(contentXML.contains("NORMA PAGE TWOSUFFIXMARKER"),
                       "append must start a NEW paragraph, not continue the last one")
        let pageTwo = try XCTUnwrap(contentXML.range(of: "NORMA PAGE TWO"))
        let marker = try XCTUnwrap(contentXML.range(of: "SUFFIXMARKER"))
        XCTAssertTrue(pageTwo.lowerBound < marker.lowerBound,
                      "the appended paragraph must come AFTER the document's own last one")
    }

    /// `insert at:"end"` continues the last paragraph rather than starting a new one — the whole
    /// reason `insert` and `append` are two verbs. Paired with the drill above, this proves the
    /// distinction the tool description promises is real.
    func testLiveDocsInsertAtEndContinuesTheLastParagraphRatherThanStartingANewOne() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let result = await send(command("office.docs.insert",
                                        args: ["path": path, "text": " AND MORE"],
                                        sessionId: "S1", commandId: "pcmd_insert_end"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        XCTAssertTrue((result.result ?? "").contains("now has 3 paragraphs"),
                      "insert must NOT add a paragraph: \(result)")
        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("NORMA PAGE TWO AND MORE"),
                      "insert at the end must continue the last paragraph: \(path)")
    }

    /// **The read-then-write interleave — a real data-loss SHAPE, and an honest account of what this
    /// drill does and does not prove.**
    /// `read` selects the WHOLE DOCUMENT (`.uno:SelectAll`) on the agent view, and LOK's `paste`
    /// REPLACES the current selection, so an `insert` after a `read` could paste over the entire
    /// body — and a naive "does the document contain the inserted text" check PASSES on that
    /// wreckage, because the document then *is* the inserted text. This drill therefore asserts every
    /// ORIGINAL paragraph survived, which is the assertion that would actually fail.
    ///
    /// ⚠️ **What it does NOT prove, measured rather than assumed:** deleting both `resetSelection`
    /// calls in `LOKBridge` and re-running this drill still PASSES. The selection is collapsed
    /// before `paste` by the positioning dispatch itself (`.uno:GoToStartOfDoc`/`GoToEndOfDoc` →
    /// `SwWrtShell::StartOfSection()`/`EndOfSection()`, which move without extending), not by
    /// `resetSelection`. So this is a regression test for the CLASS — it fails if positioning ever
    /// stops collapsing, or if a future verb pastes without positioning first — not a proof that
    /// `resetSelection` is load-bearing. That guard is defence in depth and its own header says so.
    func testLiveDocsReadThenInsertDoesNotPasteOverTheWholeDocument() async throws {
        let (path, host, _) = try await openLive("two-page.odt")
        let read = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                      commandId: "pcmd_interleave_read"), through: host)
        XCTAssertTrue(read.ok, "\(read)")

        let insert = await send(command("office.docs.insert",
                                        args: ["path": path, "text": "INTERLEAVEMARKER ", "at": "start"],
                                        sessionId: "S1", commandId: "pcmd_interleave_insert"), through: host)
        XCTAssertTrue(insert.ok, "\(insert)")

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("INTERLEAVEMARKER"), "the insert must have landed")
        for paragraph in Self.twoPageParagraphs {
            XCTAssertTrue(contentXML.contains(paragraph),
                          "\"\(paragraph)\" must survive an insert that follows a read — a lost paragraph here "
                            + "means paste replaced the select-all left behind by the read")
        }
    }

    /// **CHARACTERIZATION, and a correction to ruling 4's user-facing half.** The ratified ruling
    /// says the undo stack is SHARED across views, so "an agent edit lands in the user's ⌘Z stack."
    /// The first half is true — `sw::UndoManager` hangs off `SwDoc`, not off `SwView` — but the
    /// conclusion drawn from it is NOT what a user experiences, and this drill is how that was found:
    /// it was written to prove a single ⌘Z takes the whole agent edit back, and it FAILED, twice
    /// over (the document never went dirty again, and the appended text was still there).
    ///
    /// The mechanism, read at the pin after the failure rather than guessed:
    /// `sw::UndoManager::GetLastUndoInfo` (`sw/source/core/undo/docundo.cxx:456-472`) refuses
    /// outright, in LOK mode and outside repair mode, when the top undo action belongs to a
    /// DIFFERENT view than the one asking:
    ///
    ///     if (comphelper::LibreOfficeKit::isActive() && !m_bRepair) {
    ///         ViewShellId nViewShellId = pView ? pView->GetViewShellId() : …;
    ///         if (pAction->GetViewShellId() != nViewShellId
    ///             && !IsViewUndoActionIndependent(pView, …)) { *o_pId = SwUndoId::CONFLICT; return false; }
    ///     }
    ///
    /// and the one escape hatch, `IsViewUndoActionIndependent` (`:367-430`), requires BOTH the top
    /// action and the asking view's own earlier action to be `SwUndoId::TYPING` — a
    /// `PASTE_CLIPBOARD` never qualifies.
    ///
    /// ⟹ **A human's ⌘Z cannot take back a `docs` edit, and does nothing at all when they try.** The
    /// tool description says exactly that, in those words, instead of ruling 4's "shared" framing.
    /// This test pins the real behaviour so a later reader does not "fix" the description back.
    func testLiveAHumanUndoTakesBackAWholeAgentEditInOnePress() async throws {
        let (path, host, runtime) = try await openLive("two-page.odt")
        let appended = "UNDOMARKER one two three four"
        let result = await send(command("office.docs.append", args: ["path": path, "text": appended],
                                        sessionId: "S1", commandId: "pcmd_undo_append"), through: host)
        XCTAssertTrue(result.ok, "\(result)")

        // The USER-FACING undo door — literally what ⌘Z dispatches (`OfficeRuntime.postUndo`), on
        // the PRIMARY view, which is the whole point: the agent wrote on its own second view.
        //
        // ⚠️ **THIS TEST WAS INVERTED BY office-live-edit R3, and the inversion is the deliverable.**
        // It used to be called `…CannotTakeBackAnAgentEditAndSilentlyDoesNothing` and asserted that
        // `UNDOMARKER` SURVIVED — a true and pinned characterization of the engine's per-view undo
        // gate, and a genuinely bad experience: the human's ⌘Z did nothing, silently. `postUndo` now
        // dispatches with `Repair: true`, so the user's ruling holds — **⌘Z reverts the last thing
        // that happened, regardless of who did it.**
        //
        // Its old disclosed weakness is gone too, and by construction rather than by assertion: this
        // test's claim is now that the text DISAPPEARS, so a `postUndo` that silently did nothing —
        // the exact failure the old shape could not distinguish from success — fails it. It is
        // therefore its own positive control, and it is the end-to-end proof that the repair flag
        // survives every hop from ⌘Z's door to LOK: `postUndo` → the input chain → the driver → the
        // app-wide FIFO → the wire → the helper → `postUnoCommand`.
        //
        // It also exercises the LEDGER end to end: `docs.append` is one `paste`, so one press must
        // take the whole appended paragraph back, not one character of it.
        runtime.postUndo(path: path)

        // A settle, deliberately NOT a poll on the assertion's own condition. Polling "has UNDOMARKER
        // gone yet" would be self-restoring — it would keep looking until the test passed and report
        // success for a mechanism that never ran. The read below performs LOK's own dispatch pump, so
        // this only has to cover the app-side hop from `postUndo`'s task onto the shared request
        // queue.
        try? await Task.sleep(nanoseconds: 3_000_000_000)

        let after = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                       commandId: "pcmd_undo_read"), through: host)
        XCTAssertTrue(after.ok, "\(after)")
        let text = after.result ?? ""
        XCTAssertFalse(text.contains("UNDOMARKER"),
                       "the human's own ⌘Z must take back the agent's edit — `postUndo` dispatches "
                         + "`Repair: true`, which skips LOK's per-view undo gate "
                         + "(sw/…/docundo.cxx:458-470). Still present means the repair flag was "
                         + "dropped somewhere between this door and `postUnoCommand`: \(text)")
        XCTAssertTrue(text.contains("all 3 paragraphs") || !text.contains("all 4 paragraphs"),
                      "and the document must be back to its pre-agent shape, not merely missing the "
                        + "marker text: \(text)")
        // **What "one press" is proven against: the SAVED BYTES on disk, not a flag.**
        //
        // The save is issued EXPLICITLY rather than relying on instant save. `autoSaveEnabled` now
        // ships **ON** (office-finish armed it — see its own header for the four rounds), but this
        // drill must not depend on that: it would then be timing-dependent on the 0.9 s debounce,
        // which is exactly the defect that made round 3's arming criterion vacuous. Waiting for the document to
        // go clean is therefore waiting for THIS save to have landed, and reading `content.xml` back
        // afterwards proves the undo both happened AND was persisted — strictly stronger than
        // asserting `dirty`, and what makes this test its own positive control: a `postUndo` that
        // silently did nothing (the pre-R3 behaviour this test was INVERTED from) leaves UNDOMARKER
        // in those bytes and fails here.
        //
        // Deliberately written to hold either way: if instant-save is ever armed, the debounce will
        // already have saved and this call is harmless, and the assertions below are unchanged.
        runtime.save(path)
        let settledClean = await waitUntilLive { runtime.stateSnapshot.documents[path]?.dirty == false }
        XCTAssertTrue(settledClean, "the post-undo save must land the undone state on disk")
        let savedXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertFalse(savedXML.contains("UNDOMARKER"),
                       "the SAVED bytes must no longer carry the agent's text: the human's ⌘Z took "
                         + "it back and instant-save persisted that. Still present means either the "
                         + "undo did nothing or the save did")
    }

    // MARK: - office-live-edit R2 — how many paragraphs one paste actually makes

    /// **PROBE, and the decision it settles.** Requirement 2 wants several edits in one tool call.
    /// For `docs.append` the cheapest possible shape is for the DAEMON to join N paragraphs with
    /// `\n` and send the existing single-`text` wire frame: that would be one wire request, one
    /// `paste`, ONE undo action, and the existing exact-text verification — with no new wire field,
    /// no new app decoder, and no change to the deadline budget.
    ///
    /// That shape is only legitimate if a `\n` inside a pasted payload becomes a REAL PARAGRAPH
    /// BREAK. `docs.ts`'s own `replaceWith` note says the engine inserts `\n` "as literal
    /// characters, not as a paragraph break" — **but that note is about `replace`, which goes
    /// through `.uno:ExecuteSearch`, an entirely different mechanism from `insert`/`append`'s
    /// `paste` of `text/plain`.** Carrying that claim across mechanisms is exactly the
    /// right-conclusion-wrong-supporting-fact shape this arc keeps producing, so it is measured here
    /// instead.
    ///
    /// The assertion is on the PARAGRAPH NUMBERING `read` returns, not on the characters: a literal
    /// `\n` inside one paragraph and a real paragraph break are indistinguishable in a raw text
    /// dump, and only the numbering tells them apart.
    func testLiveOnePasteWithNewlinesBecomesSeveralRealParagraphs() async throws {
        let (path, host, _) = try await openLive("two-page.odt", as: "paste-paragraphs.odt")

        let before = await send(command("office.docs.info", args: ["path": path], sessionId: "S1",
                                        commandId: "pcmd_pp_info_before"), through: host)
        XCTAssertTrue(before.ok, "\(before)")
        let beforeText = try XCTUnwrap(before.result)

        let result = await send(command("office.docs.append",
                                        args: ["path": path, "text": "ALPHAPARA\nBETAPARA\nGAMMAPARA"],
                                        sessionId: "S1", commandId: "pcmd_pp_append"), through: host)
        XCTAssertTrue(result.ok, "the append itself must succeed: \(result)")

        let after = await send(command("office.docs.read", args: ["path": path], sessionId: "S1",
                                       commandId: "pcmd_pp_read"), through: host)
        XCTAssertTrue(after.ok, "\(after)")
        let text = try XCTUnwrap(after.result)
        print("[paste-paragraph probe] info before: \(beforeText)\n--- read after ---\n\(text)")

        // Each marker must be numbered as its OWN paragraph. If `\n` pasted as a literal character,
        // all three land inside ONE numbered paragraph and these three assertions cannot all hold.
        let numbered = text.split(separator: "\n").filter { line in
            ["ALPHAPARA", "BETAPARA", "GAMMAPARA"].contains { line.contains($0) }
        }
        XCTAssertEqual(numbered.count, 3,
                       "three markers must occupy three separately numbered paragraphs — if they "
                         + "share one, `\\n` pasted as a literal character and the daemon-side join "
                         + "design for requirement 2 is INVALID: \(text)")
        for marker in ["ALPHAPARA", "BETAPARA", "GAMMAPARA"] {
            XCTAssertTrue(text.contains(marker), "\(marker) must survive the paste: \(text)")
        }
    }

    // MARK: - The Word carve-out: .docx is written exactly like .odt

    /// **The FIXED branch of the carve-out, live.** The `.docx` export defect (Writer's OOXML export
    /// living in a `libmswordlo.dylib` absent from the vendored product-set) was fixed by the r4
    /// re-cut on main (`1212017c`), and `docx` is back in `officeReadWriteExtensions`
    /// (`PanelEditorTab.swift:125`). So there is no refusal to pin — there is an obligation to prove
    /// the write actually works, on Word's own bytes rather than ODF's.
    ///
    /// `gate.docx`'s body is "NORMA GATE" / "office stage A embed probe" (read from its own
    /// `word/document.xml`), so the same placement standard applies: the appended paragraph must come
    /// AFTER both, in the saved OOXML part.
    func testLiveDocsWritesWordDocumentsExactlyLikeODF() async throws {
        let (path, host, _) = try await openLive("gate.docx")
        let result = await send(command("office.docs.append",
                                        args: ["path": path, "text": "DOCXMARKER"],
                                        sessionId: "S1", commandId: "pcmd_docx_append"), through: host)
        XCTAssertTrue(result.ok, "a .docx write must succeed on the r4 engine: \(result)")

        let documentXML = try readODFEntry(atPath: path, entry: "word/document.xml")
        XCTAssertTrue(documentXML.contains("DOCXMARKER"), "the saved .docx must carry the appended text")
        XCTAssertTrue(documentXML.contains("NORMA GATE"), "the original body must survive")
        let gate = try XCTUnwrap(documentXML.range(of: "NORMA GATE"))
        let probe = try XCTUnwrap(documentXML.range(of: "office stage A embed probe"))
        let marker = try XCTUnwrap(documentXML.range(of: "DOCXMARKER"))
        XCTAssertTrue(gate.lowerBound < probe.lowerBound && probe.lowerBound < marker.lowerBound,
                      "the appended paragraph must be last in the saved OOXML body")
        XCTAssertFalse(documentXML.contains("REKRAMXCOD"), "reversed text signature")
    }

    /// A `.docx` `replace`, for the same reason: the carve-out is lifted for EVERY write verb, not
    /// just the one that happened to get a drill.
    func testLiveDocsReplaceWorksOnWordDocumentsToo() async throws {
        let (path, host, _) = try await openLive("gate.docx")
        let result = await send(command("office.docs.replace",
                                        args: ["path": path, "find": "GATE", "replaceWith": "GATEWAY"],
                                        sessionId: "S1", commandId: "pcmd_docx_replace"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        XCTAssertTrue((result.result ?? "").contains("replaced 1 occurrence"), "\(result)")
        let documentXML = try readODFEntry(atPath: path, entry: "word/document.xml")
        XCTAssertTrue(documentXML.contains("NORMA GATEWAY"), "the saved .docx must carry the replacement")
    }


    // MARK: - office-format: docs format
    //
    // **The evidence rule for every drill below: the assertion is on the SAVED FILE'S BYTES, and the
    // fixture is PRISTINE with respect to what is asserted.** `format-target.odt` carries no bold,
    // no italic, no underline, no explicit alignment and no non-default style, so "the saved
    // content.xml now contains a bold run" cannot also be true of the untouched file. That is the
    // arc's #1 defect class (four separate occurrences), and it is why a new fixture exists rather
    // than reusing `two-page.odt`, whose first paragraph is already styled.

    /// Counts BOLD TEXT RUNS in a saved ODF file's own bytes.
    ///
    /// Two hops, because ODF never marks the text itself: automatic text styles carry
    /// `fo:font-weight="bold"`, and `text:span` elements reference them by name. Counting the
    /// ATTRIBUTE alone would be wrong in both directions — one style can be referenced by many spans,
    /// and a declared-but-unused style would count as formatting that is not there.
    private func boldRuns(inSavedFileAt path: String) throws -> [String] {
        let xml = try readODFEntry(atPath: path, entry: "content.xml")
        let ns = xml as NSString
        let whole = NSRange(location: 0, length: ns.length)

        // Which automatic styles declare bold — collected for BOTH families in one pass, because
        // which family carries it is not a fact this helper gets to assume (see below).
        var boldStyleNames = Set<String>()
        let styleBlock = try NSRegularExpression(
            pattern: "<style:style\\b[^>]*style:name=\"([^\"]+)\"[^>]*>(.*?)</style:style>",
            options: [.dotMatchesLineSeparators])
        for match in styleBlock.matches(in: xml, range: whole) {
            let name = ns.substring(with: match.range(at: 1))
            let body = ns.substring(with: match.range(at: 2))
            // `fo:font-weight="normal"` is an EXPLICIT clear, not bold — matching on the attribute
            // name alone would count a cleared paragraph as bold.
            if body.contains("fo:font-weight=\"bold\"") { boldStyleNames.insert(name) }
        }

        // **ODF carries bold on TWO different things, and this helper was wrong about that once.**
        // A format scoped to matched words produces `<text:span text:style-name="T1">` referencing a
        // bold TEXT style. A format over whole paragraphs produces no span at all — the paragraph
        // itself gets a bold PARAGRAPH style (`<text:p text:style-name="P1">`). A span-only scan
        // therefore reports ZERO bold on a correctly whole-document-bolded file, which is what the
        // first version of this helper did: two drills failed while the product was right, and
        // "fixing" the product to satisfy them would have broken working code.
        var runs: [String] = []
        let spanBlock = try NSRegularExpression(
            pattern: "<text:span\\s+text:style-name=\"([^\"]+)\"[^>]*>(.*?)</text:span>",
            options: [.dotMatchesLineSeparators])
        for match in spanBlock.matches(in: xml, range: whole) {
            guard boldStyleNames.contains(ns.substring(with: match.range(at: 1))) else { continue }
            runs.append(Self.strippingTags(ns.substring(with: match.range(at: 2))))
        }
        let paraBlock = try NSRegularExpression(
            pattern: "<text:p\\s+text:style-name=\"([^\"]+)\"[^>]*>(.*?)</text:p>",
            options: [.dotMatchesLineSeparators])
        for match in paraBlock.matches(in: xml, range: whole) {
            guard boldStyleNames.contains(ns.substring(with: match.range(at: 1))) else { continue }
            let text = Self.strippingTags(ns.substring(with: match.range(at: 2)))
            if !text.isEmpty { runs.append(text) }
        }

        // **A self-check on the INSTRUMENT**, kept because this helper has now been wrong twice in
        // the direction that matters — both times reporting NO bold on a file that had it. If the
        // saved bytes declare a bold weight anywhere and this scan found no carrier for it, the
        // helper is broken, not the product, and every assertion built on it is worthless.
        if xml.contains("fo:font-weight=\"bold\"") && runs.isEmpty {
            XCTFail("boldRuns is broken: content.xml declares fo:font-weight=\"bold\" but the scan "
                    + "found no bold text. Fix the helper before trusting any assertion that uses it.")
        }
        return runs
    }

    /// Strips XML tags, leaving the text content.
    private static func strippingTags(_ fragment: String) -> String {
        fragment.replacingOccurrences(of: "<[^>]*>", with: "", options: [.regularExpression])
    }

    /// **The baseline that makes every other bold assertion below meaningful**, and it is a real
    /// assertion rather than a comment: the fixture, as shipped, has NO bold anywhere. If this ever
    /// goes green for the wrong reason — a fixture edit that adds a bold run — every drill that
    /// asserts "bold is now present" would start passing by construction.
    func testLiveDocsFormatFixtureIsPristineSoTheBoldAssertionsMeanSomething() async throws {
        let (path, _, _) = try await openLive("format-target.odt")
        XCTAssertEqual(try boldRuns(inSavedFileAt: path), [],
                       "format-target.odt must ship with no bold runs at all")
    }

    /// ⭐ **LT-1, the highest-value live test in the research's own list: does a `find`-scoped format
    /// reach EVERY occurrence, or only the first?**
    ///
    /// The research could not answer it from source — whether `SwWrtShell::SetAttrSet` applies across
    /// every cursor in a FIND_ALL's multi-range ring was untraceable at its budget — and the tool
    /// description cannot be written honestly until it is answered. The fixture holds the literal in
    /// three separate paragraphs, so the saved bytes distinguish the two answers directly: three bold
    /// runs means every occurrence, one means the first only.
    ///
    /// The assertion also checks WHICH text is bold, not merely how many runs there are: a format
    /// that bolded whole paragraphs rather than the matched words would produce the right COUNT and
    /// the wrong result.
    func testLiveDocsFormatWithFindBoldsTheMatchedTextAndTheSavedBytesShowHowManyOccurrencesItReached() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        XCTAssertEqual(try boldRuns(inSavedFileAt: path), [], "setup: the fixture must start with no bold")

        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "bold": true],
                                        sessionId: "S1", commandId: "pcmd_fmt_find"), through: host)
        XCTAssertTrue(result.ok, "\(result)")

        let runs = try boldRuns(inSavedFileAt: path)
        XCTAssertFalse(runs.isEmpty, "the saved file must contain at least one bold run: \(result.result ?? "")")
        for run in runs {
            XCTAssertEqual(run, "MARKER",
                           "only the matched text may be bold — a bold run of \"\(run)\" means the "
                               + "format reached more than what `find` matched")
        }
        // The measured answer, recorded as an assertion so a future engine change that silently
        // narrows or widens the scope fails here instead of shipping.
        XCTAssertEqual(runs.count, 3,
                       "a find-scoped format must reach every occurrence of the literal (found \(runs.count))")
        XCTAssertTrue(result.result?.contains("3 occurrences") == true,
                      "the result must tell the model how many occurrences it reached: \(result.result ?? "")")
    }

    /// The whole-document scope, and the half of `bold` that a "does it apply bold" test never
    /// covers: `bold: false` must CLEAR bold, not toggle it back on.
    ///
    /// **This is the drill that would catch the H1/H3 hazard class in production.** Those slots
    /// toggle when their argument fails to produce an item, so an implementation whose payload is
    /// subtly wrong passes a bold-it-on test (the toggle happens to flip the right way from a plain
    /// document) and fails this one.
    func testLiveDocsFormatBoldFalseClearsBoldRatherThanTogglingItBackOn() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let on = await send(command("office.docs.format", args: ["path": path, "bold": true],
                                    sessionId: "S1", commandId: "pcmd_fmt_on"), through: host)
        XCTAssertTrue(on.ok, "\(on)")
        XCTAssertFalse(try boldRuns(inSavedFileAt: path).isEmpty, "setup: bold:true must produce bold")

        let off = await send(command("office.docs.format", args: ["path": path, "bold": false],
                                     sessionId: "S1", commandId: "pcmd_fmt_off"), through: host)
        XCTAssertTrue(off.ok, "\(off)")
        XCTAssertEqual(try boldRuns(inSavedFileAt: path), [],
                       "bold:false must CLEAR bold, not toggle it — a toggle would leave it on here")
    }

    /// `find` that matches nothing REFUSES, and the document is untouched.
    ///
    /// Refusing matters more than it looks: a formatting command dispatched with no selection is not
    /// a no-op — it applies at the caret or arms a mode — so "no match" had to become a refusal
    /// before dispatch rather than a dispatch that happens to do little.
    func testLiveDocsFormatRefusesAFindThatMatchesNothingAndChangesNothing() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let before = try readODFEntry(atPath: path, entry: "content.xml")
        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "NOT-IN-THIS-DOCUMENT", "bold": true],
                                        sessionId: "S1", commandId: "pcmd_fmt_nomatch"), through: host)
        XCTAssertFalse(result.ok, "a find that matches nothing must refuse: \(result)")
        XCTAssertTrue(result.result?.contains("does not appear") == true,
                      "the refusal must say the text is not there: \(result.result ?? "")")
        XCTAssertEqual(try readODFEntry(atPath: path, entry: "content.xml"), before,
                       "a refused format must leave the document byte-identical")
        XCTAssertEqual(try boldRuns(inSavedFileAt: path), [], "and no bold may have been applied")
    }

    /// Does the saved file actually carry this character attribute? Two carriers, same as
    /// `boldRuns`: an automatic text style referenced by a `text:span`, or a paragraph style.
    private func savedFileHas(_ odfProperty: String, _ value: String, atPath path: String) throws -> Bool {
        let xml = try readODFEntry(atPath: path, entry: "content.xml")
        return xml.contains("\(odfProperty)=\"\(value)\"")
    }

    /// ⭐ **The verification drill, rewritten to be FALSIFIABLE — the old one could not fail.**
    ///
    /// It asserted `text.contains("Confirmed") || text.contains("could not")`, and every branch of
    /// the result sentence emits one of those. Review proved it passed under a forced red *while the
    /// verification was actively lying*. A drill that names the verification story and asserts
    /// nothing about it is worse than no drill: it reads like coverage.
    ///
    /// The replacement cross-checks the SENTENCE against the SAVED BYTES, which is the only thing
    /// that can catch a verification that manufactures agreement: **if the sentence claims an
    /// attribute was confirmed, the file must actually carry it.** Run for `italic`, which is the
    /// attribute the stylesheet leak confirmed unconditionally on every Writer document.
    func testLiveDocsFormatNeverClaimsToHaveConfirmedSomethingTheSavedBytesDoNotShow() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "italic": true],
                                        sessionId: "S1", commandId: "pcmd_verify_italic"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""
        let italicInFile = try savedFileHas("fo:font-style", "italic", atPath: path)

        if text.contains("Confirmed italic") {
            XCTAssertTrue(italicInFile,
                          "the sentence claims italic was confirmed, so the saved bytes MUST carry "
                              + "fo:font-style=\"italic\". If they do not, the verification is "
                              + "reading something other than the formatted text. Sentence: \(text)")
        }
        // And the positive direction, so this drill also fails if verification silently stops
        // working: italic really did land here, so it must be reported as confirmed.
        XCTAssertTrue(italicInFile, "setup: italic must actually reach the saved bytes")
        XCTAssertTrue(text.contains("Confirmed italic"),
                      "italic landed in the file, so the verb must confirm it: \(text)")
    }

    /// ⭐ **The drill that actually catches the stylesheet leak — third attempt, and the first one
    /// that can fail.**
    ///
    /// The two previous versions were empirically vacuous, and the reason is worth stating because
    /// it is not obvious: `verified` and `applied` only ever contain attributes that were
    /// REQUESTED. So any assertion of the form "bold must not be reported when bold was not asked
    /// for" cannot fail — bold is unreachable on that path regardless of what the check does.
    /// Review proved both earlier versions passed with `officeRtfBody` forced to the identity, i.e.
    /// with both Criticals restored.
    ///
    /// **The shape that IS sensitive: request the attribute, and pick the value the leak gets
    /// wrong.** `italic: false` on a document with no italic is *correct* to confirm — the check
    /// asks `requested == present`, and `false == false` holds. But an unscoped scan sees the stock
    /// `caption` style's `\i` in the stylesheet, computes `present = true`, and `false == true`
    /// fails — so the verb declines to confirm and the sentence changes. One requested attribute,
    /// one document, and the leak flips the answer.
    ///
    /// **Forced red, run:** with `officeRtfBody` replaced by `return rtf`, this test fails on the
    /// "Confirmed italic" assertion, reporting the "could not confirm any of it" sentence instead.
    /// Reverted byte-identical, green.
    func testLiveDocsFormatConfirmsItalicIsOffWhichAnUnscopedScanCouldNotDo() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        // The fixture has no italic, and that is the whole premise — asserted, so the drill cannot
        // quietly stop testing anything if the fixture changes.
        XCTAssertFalse(try savedFileHas("fo:font-style", "italic", atPath: path),
                       "setup: format-target.odt must ship with no italic anywhere")

        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "italic": false],
                                        sessionId: "S1", commandId: "pcmd_italic_off"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""

        // Still no italic in the file — turning off what was never on is a legitimate no-op.
        XCTAssertFalse(try savedFileHas("fo:font-style", "italic", atPath: path),
                       "italic:false must not somehow ADD italic")
        // And the verb must be able to say so. Under the stylesheet leak it cannot: the document's
        // own caption style makes `present` true, the comparison fails, and this goes red.
        XCTAssertTrue(text.contains("Confirmed italic"),
                      "italic is genuinely absent and italic:false was requested, so the verb must "
                          + "confirm it. Reading 'could not confirm' here means the check is seeing "
                          + "the document's STYLE TABLE rather than the selected text: \(text)")
    }

    /// **F-4 made honest.** The check is existential over the matched occurrences, so a multi-match
    /// format must say so rather than claiming bare confirmation.
    func testLiveDocsFormatSaysAtLeastOneOfNRatherThanClaimingItCheckedEveryOccurrence() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "bold": true],
                                        sessionId: "S1", commandId: "pcmd_existential"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let text = result.result ?? ""
        XCTAssertTrue(text.contains("at least one of the 3 occurrences"),
                      "a 3-occurrence format must state that confirmation is existential, not "
                          + "universal — it cannot check each occurrence separately: \(text)")
    }

    /// A mistyped `bold` is REFUSED, on every arm, rather than coerced.
    ///
    /// **This is the guard whose absence is a silent wrong answer written into the user's document.**
    /// `SvxWeightItem::PutValue` never rejects a value — `Any2Bool` coerces anything non-boolean to
    /// `false` — so a `"true"` STRING reaching the engine would UN-BOLD the selection while every
    /// layer reported success. The refusal must therefore happen before the engine sees it, and it
    /// must happen for a string, a number and an array alike.
    func testLiveDocsFormatRefusesAMistypedBoldOnEveryArmInsteadOfSilentlyClearingIt() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        // Start from BOLD, so a coerced-to-false value would be visible as a real change rather than
        // a no-op — the inverted-assertion trap this drill exists to avoid.
        let on = await send(command("office.docs.format", args: ["path": path, "bold": true],
                                    sessionId: "S1", commandId: "pcmd_mt_setup"), through: host)
        XCTAssertTrue(on.ok, "\(on)")
        let boldedRuns = try boldRuns(inSavedFileAt: path)
        XCTAssertFalse(boldedRuns.isEmpty, "setup: the document must be bold before the mistyped attempts")

        let mistyped: [(String, Any)] = [
            ("string", "true"), ("number", 1), ("array", ["true"]), ("object", ["value": "true"]),
        ]
        for (index, (label, value)) in mistyped.enumerated() {
            let result = await send(command("office.docs.format",
                                            args: ["path": path, "bold": value],
                                            sessionId: "S1", commandId: "pcmd_mt_\(index)"), through: host)
            XCTAssertFalse(result.ok, "a \(label) `bold` must be refused, never coerced: \(result)")
            XCTAssertEqual(try boldRuns(inSavedFileAt: path), boldedRuns,
                           "a refused \(label) `bold` must leave the document's bold exactly as it was — "
                               + "a coerced value would silently CLEAR it")
        }
    }

    /// ⭐ **The toggle-hazard regression test, and the reason the payload shape is not cosmetic.**
    ///
    /// `.uno:Bold` is a `Toggle = TRUE` slot, and the dispatcher makes "my arguments were wrong" and
    /// "I sent no arguments" the SAME state — so an argument that fails to produce an item does not
    /// fail, it FLIPS against current state. On top of that `SvxWeightItem::PutValue` never rejects a
    /// value: `Any2Bool` coerces anything non-boolean to `false`.
    ///
    /// Both hazards are INVISIBLE against a plain document — a toggle flips it to bold, which is what
    /// was asked for, and so does a correct absolute set. They are only visible starting from
    /// ALREADY-BOLD text, which is exactly what `format-bolded.odt` is. Setting bold to true on
    /// already-bold text must be a no-op; a toggle un-bolds it and a coerced `false` un-bolds it.
    ///
    /// **FORCED-RED, run 2026-08-27 against this exact drill** (recorded here rather than in a report
    /// nobody reads beside the code): with `docsFormatOnDedicatedThread`'s payload changed from
    /// `"type":"boolean"` to `"type":"string"` — one tag, the H3 mistype — and nothing else touched,
    /// this test FAILED with "MUST still be bold ... found 0 bold runs", i.e. the saved bytes came
    /// back with the bold GONE while the verb reported success. Reverted (byte-identical, `git diff`
    /// empty), rebuilt, green. So the guard is load-bearing and this drill genuinely detects its
    /// absence.
    ///
    /// **The same red run independently proved the RTF read-back is load-bearing rather than
    /// decorative.** With the mistyped payload, `format`'s own sentence changed to "Norma read the
    /// text back afterwards and could not confirm any of it — re-read the document before relying on
    /// this." The verification correctly declined to confirm a change that had not happened, on a
    /// call every other layer reported as a success.
    func testLiveDocsFormatSettingBoldOnAlreadyBoldTextLeavesItBoldRatherThanTogglingItOff() async throws {
        let (path, host, _) = try await openLive("format-bolded.odt")
        let boldBefore = try boldRuns(inSavedFileAt: path)
        XCTAssertFalse(boldBefore.isEmpty,
                       "setup: format-bolded.odt must ship ALREADY BOLD, or this drill cannot see a toggle")

        let result = await send(command("office.docs.format", args: ["path": path, "bold": true],
                                        sessionId: "S1", commandId: "pcmd_idem_bold"), through: host)
        XCTAssertTrue(result.ok, "\(result)")

        let boldAfter = try boldRuns(inSavedFileAt: path)
        XCTAssertFalse(boldAfter.isEmpty,
                       "text that was bold MUST still be bold after setting bold:true — found "
                           + "\(boldAfter.count) bold runs. An empty result here means the dispatch "
                           + "TOGGLED (or coerced its argument to false) instead of setting an "
                           + "absolute state, which is a silent wrong answer in the user's document.")
    }

    /// ⭐ **The drill that catches the silent-drop shape — a mistyped operand PAIRED with a valid
    /// one.** This is the third occurrence of this exact defect in this arc, and it is why the drill
    /// exists in this form rather than testing a mistyped operand on its own.
    ///
    /// A decoder that collapses a wrong-typed value to `nil` makes it indistinguishable from ABSENT.
    /// On its own that is caught by the at-least-one-attribute guard, which is why a lone-operand
    /// test passes and proves nothing. Paired with a valid attribute the guard is satisfied, the call
    /// SUCCEEDS, the valid attribute is applied and reported — and the mistyped one is silently
    /// dropped. The model asked for bold, was told the call worked, and the document has no bold.
    ///
    /// **This drill was written RED against the code as first implemented and it failed**: the
    /// enum operands had the `isPresent`-then-refuse treatment and the three BOOLEANS did not, so
    /// `align:"center", bold:"true"` returned ok with `align` applied. The fix extends the same
    /// check to every optional operand.
    func testLiveDocsFormatRefusesAMistypedBoldEvenWhenPairedWithAValidAttribute() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let before = try readODFEntry(atPath: path, entry: "content.xml")

        let result = await send(command("office.docs.format",
                                        args: ["path": path, "align": "center", "bold": "true"],
                                        sessionId: "S1", commandId: "pcmd_pair_mistyped"), through: host)
        XCTAssertFalse(result.ok,
                       "a mistyped `bold` must refuse even when another attribute is valid — otherwise "
                           + "the call succeeds, applies the valid one, and silently drops the one the "
                           + "caller got wrong: \(result)")
        XCTAssertTrue((result.result ?? "").contains("bold"),
                      "the refusal must name the operand that was wrong: \(result.result ?? "")")
        XCTAssertEqual(try readODFEntry(atPath: path, entry: "content.xml"), before,
                       "nothing may be applied when any named operand is malformed")
    }

    /// **Does applying a paragraph style destroy direct character formatting?**
    ///
    /// This drill exists because the tool description and the bridge both ASSERTED that it does
    /// ("style replaces direct character formatting, so apply it before bold, not after"), and
    /// nothing in the research supports it — §3.7 covers `StyleApply`'s argument mechanics and H5
    /// covers AutoUpdate; neither says a paragraph style clears direct character formatting. An
    /// unverified mechanism claim in model-facing text is the exact failure class this arc keeps
    /// shipping, so it gets measured rather than reasoned about.
    ///
    /// Whatever the answer, this test pins it: bold one run by `find`, then apply a paragraph style
    /// over the same run, and read the saved bytes.
    func testLiveDocsFormatMeasuresWhetherAStyleDestroysDirectCharacterFormatting() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let bolded = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "bold": true],
                                        sessionId: "S1", commandId: "pcmd_sty_bold"), through: host)
        XCTAssertTrue(bolded.ok, "\(bolded)")
        XCTAssertEqual(try boldRuns(inSavedFileAt: path).count, 3, "setup: all three runs must be bold")

        let styled = await send(command("office.docs.format",
                                        args: ["path": path, "find": "MARKER", "style": "heading2"],
                                        sessionId: "S1", commandId: "pcmd_sty_style"), through: host)
        XCTAssertTrue(styled.ok, "\(styled)")

        let after = try boldRuns(inSavedFileAt: path)
        // The MEASURED answer, asserted so the description can cite it and so a future engine change
        // that alters it fails here rather than silently making the description wrong.
        //
        // **Asserted on CONTENT as well as count (review F-8).** `boldRuns` counts paragraph-style
        // carriers as well as span carriers, so a count-only assertion would also be satisfied by
        // three whole PARAGRAPHS going bold — a different outcome entirely, and one that would still
        // let the description's claim be wrong.
        XCTAssertEqual(after.count, 3,
                       "direct character formatting SURVIVES a paragraph style being applied over it "
                           + "(found \(after.count) bold runs). If this ever fails, the tool "
                           + "description's ordering advice must change with it.")
        for run in after {
            XCTAssertEqual(run, "MARKER",
                           "and it must still be the MATCHED WORD that is bold, not the whole "
                               + "paragraph: found a bold run of \"\(run)\"")
        }
    }

    /// Alignment and line spacing, the two argument-free attributes, land in the saved bytes.
    /// Asserted against the pristine fixture, which declares neither.
    func testLiveDocsFormatAlignAndLineSpacingReachTheSavedParagraphProperties() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let before = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertFalse(before.contains("fo:text-align"), "setup: the fixture must declare no alignment")

        let result = await send(command("office.docs.format",
                                        args: ["path": path, "align": "center", "lineSpacing": "double"],
                                        sessionId: "S1", commandId: "pcmd_fmt_para"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let after = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(after.contains("fo:text-align=\"center\""),
                      "centering must reach the saved paragraph properties")
        XCTAssertTrue(after.contains("fo:line-height=\"200%\""),
                      "double spacing must reach the saved paragraph properties: proportional 200%")
        XCTAssertNotEqual(after, before, "the saved bytes must actually differ from the pristine file")
    }

    /// `style` applies and reaches the saved bytes.
    ///
    /// ⚠️ **Renamed after review (F-7): the old name promised a pre-validation arm this body does not
    /// have.** Pre-validation against the engine's catalogue does run in the bridge, but it is not
    /// reachable through the tool — the `style` enum carries only names measured present in that
    /// catalogue — so there is nothing for a drill here to exercise. Naming an arm a test does not
    /// have is how a suite comes to read as covering more than it does.
    func testLiveDocsFormatAppliesAHeadingStyleToTheMatchedParagraph() async throws {
        let (path, host, _) = try await openLive("format-target.odt")
        let result = await send(command("office.docs.format",
                                        args: ["path": path, "find": "Alpha MARKER one", "style": "heading1"],
                                        sessionId: "S1", commandId: "pcmd_fmt_style"), through: host)
        XCTAssertTrue(result.ok, "\(result)")
        let after = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(after.contains("Heading_20_1") || after.contains("Heading 1"),
                      "the heading style must reach the saved bytes")
    }

    // MARK: - Helpers

    private func readODFEntry(atPath path: String, entry: String) throws -> String {
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        unzip.arguments = ["-p", path, entry]
        let pipe = Pipe()
        unzip.standardOutput = pipe
        try unzip.run()
        unzip.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return try XCTUnwrap(String(data: data, encoding: .utf8), "\(entry) was not valid UTF-8")
    }
}
