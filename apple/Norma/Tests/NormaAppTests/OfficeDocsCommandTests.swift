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

    override func tearDown() {
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

    /// **The read-then-write interleave, which is a data-loss vector and not a formality.**
    /// `read` selects the WHOLE DOCUMENT (`.uno:SelectAll`) on the agent view, and LOK's `paste`
    /// REPLACES the current selection. Without the `resetSelection` that follows every read, an
    /// `insert` on an already-read document pastes over the entire body — and a naive "does the
    /// document contain the inserted text" check PASSES on that wreckage, because the document then
    /// *is* the inserted text. So this drill reads first, writes second, and asserts every original
    /// paragraph SURVIVED.
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
    func testLiveAHumanUndoOnTheirOwnViewCannotTakeBackAnAgentEditAndSilentlyDoesNothing() async throws {
        let (path, host, runtime) = try await openLive("two-page.odt")
        let appended = "UNDOMARKER one two three four"
        let result = await send(command("office.docs.append", args: ["path": path, "text": appended],
                                        sessionId: "S1", commandId: "pcmd_undo_append"), through: host)
        XCTAssertTrue(result.ok, "\(result)")

        // The USER-FACING undo door — literally what ⌘Z dispatches (`OfficeRuntime.postUndo`), on
        // the PRIMARY view, which is the whole point: the agent wrote on its own second view.
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
        XCTAssertTrue(text.contains("UNDOMARKER"),
                      "LOK refuses a cross-view undo outside repair mode — the agent's edit must still "
                        + "be there after the human's own ⌘Z (docundo.cxx:456-472): \(text)")
        XCTAssertTrue(text.contains("all 4 paragraphs"),
                      "and the paragraph the agent added must still be there too: \(text)")
        XCTAssertFalse(runtime.stateSnapshot.documents[path]?.dirty ?? true,
                       "a refused undo must not even mark the document modified — nothing happened at all")
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
