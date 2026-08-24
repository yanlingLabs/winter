import AppKit
import NormaKit
import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T6 — live drills for `slides` against the REAL helper, REAL vendored
/// LibreOffice, and REAL fixtures. Mirrors `OfficeSheetsCommandTests.swift`'s own established shape
/// exactly (fixtures/boilerplate, wire-decoded `PanelCommand` fixtures driven through the real
/// `OfficeCommandConsumer` -> `OfficeAgentBroker` -> `OfficeRuntime` -> `OfficeHelperClient` -> the
/// wire -> `NormaOfficeHelper` -> `LOKBridge` -> real LOK stack) — see that file's own header for the
/// full rationale, not repeated here.
@MainActor
final class OfficeSlidesCommandTests: XCTestCase {

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
            .appendingPathComponent("officeslidescommand-\(UUID().uuidString.prefix(8))", isDirectory: true)
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
            XCTFail("slides \(command.action) never answered")
            return Sent(sessionId: command.sessionId, commandId: command.commandId, ok: false, result: nil)
        }
        return sent
    }

    // MARK: - F-0 regression (fix round 1, Critical) — set_text no longer partially applies

    /// **The reviewer's own live reproduction, replayed as a permanent regression test.**
    /// `add_slide layout:"title_only"` then `set_text title:… body:…` on that new slide used to
    /// write the title, refuse on the missing body placeholder, leave the adopted tab dirty, and
    /// its own refusal text led with "…nothing was written" while the title demonstrably had been.
    /// Ruling 1 (layout is write-only, no read-back) makes this reachable with no pre-check
    /// available to the model — `info`/`read` cannot tell it in advance that `title_only` has no
    /// body placeholder without this exact call. `slidesSetTextOnDedicatedThread`'s two-pass fix
    /// (verify both named placeholders exist before writing either) should refuse cleanly here,
    /// before any keystroke, leaving the new slide's title untouched AND the adopted document
    /// clean enough for the NEXT write (on a different slide) to succeed — the wedge's own
    /// signature was exactly that every later write got refused for "unsaved changes in an open
    /// tab" until the human intervened.
    func testLiveSetTextRefusesCleanlyRatherThanPartiallyApplyingWhenOnlyOnePlaceholderExists() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly")

        let addResult = await send(command("office.slides.add_slide",
                                           args: ["path": path, "at": 4, "layout": "title_only"],
                                           sessionId: "S1", commandId: "pcmd_f0_add"), through: host)
        XCTAssertTrue(addResult.ok, "\(addResult)")

        // The reviewer's exact repro: title AND body on a slide with no body placeholder.
        let setResult = await send(command("office.slides.set_text",
                                           args: ["path": path, "slide": 4, "title": "PROBETITLE", "body": "PROBEBODY"],
                                           sessionId: "S1", commandId: "pcmd_f0_set"), through: host)
        XCTAssertFalse(setResult.ok, "a slide with no body placeholder must refuse this call")
        let refusalText = setResult.result ?? ""
        XCTAssertFalse(refusalText.contains("nothing was written If"),
                       "the run-on the reviewer quoted verbatim must be gone: \(refusalText)")
        XCTAssertFalse(refusalText.lowercased().contains("probetitle"),
                       "a refusal must never claim success by naming the value that was NOT written: \(refusalText)")

        // The title must NOT have been written — the whole point of pre-validation.
        let readResult = await send(command("office.slides.read", args: ["path": path, "slide": 4],
                                            sessionId: "S1", commandId: "pcmd_f0_read"), through: host)
        XCTAssertTrue(readResult.ok, "\(readResult)")
        XCTAssertFalse((readResult.result ?? "").contains("PROBETITLE"),
                       "title must be untouched after a refused set_text: \(readResult)")

        // The document must NOT be wedged — a write to a DIFFERENT slide must still succeed.
        let laterResult = await send(command("office.slides.set_text", args: ["path": path, "slide": 1, "title": "LATER WRITE SUCCEEDS"],
                                             sessionId: "S1", commandId: "pcmd_f0_later"), through: host)
        XCTAssertTrue(laterResult.ok, "the adopted document must not be left dirty by the refused call: \(laterResult)")
    }

    // MARK: - Refusal-path live drills — pre-checks that exist but had no live confirmation yet

    /// `notPresentation` (a slides verb on a spreadsheet), `slideNotFound` (out-of-range `slide`/`at`/
    /// `to` on `read`/`set_text`/`delete_slide`/`reorder`/`add_slide`), and `lastSlide` (deleting a
    /// presentation's only remaining slide) all had pre-checks written and unit-tested against the
    /// fake bridge (`OfficeCommandConsumerTests`) since early in this task, but never independently
    /// confirmed against the REAL engine — every one of them refuses BEFORE any UNO dispatch, so nothing
    /// here should be timing-sensitive the way the write mechanisms are, but "should never be
    /// timing-sensitive" is exactly the kind of claim this task's own house rule says to verify, not
    /// assume.
    func testLiveRefusalPathsForNotPresentationSlideNotFoundAndLastSlide() async throws {
        try requireLiveEngine()

        // --- notPresentation: office.slides.info on a spreadsheet. ---
        do {
            let path = try makeWritableCopy(of: "gate.xlsx")
            let stateDir = makeScratchDirectory()
            let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
            await host.directory.refresh()
            let result = await send(command("office.slides.info", args: ["path": path], sessionId: "S1", commandId: "pcmd_notpres"), through: host)
            XCTAssertFalse(result.ok, "info on a spreadsheet must refuse")
            let text = (result.result ?? "").lowercased()
            XCTAssertTrue(text.contains("presentation"), "\(result)")
        }

        // --- slideNotFound: read/set_text/delete_slide/reorder/add_slide, all on three-slide.odp
        // (3 slides, valid indices 1-3; slide 5 / at 5 are out of range). ---
        let path = try makeWritableCopy(of: "three-slide.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let readResult = await send(command("office.slides.read", args: ["path": path, "slide": 5], sessionId: "S1", commandId: "pcmd_nf_read"), through: host)
        XCTAssertFalse(readResult.ok, "read on an out-of-range slide must refuse")
        XCTAssertTrue((readResult.result ?? "").contains("slide 5"), "\(readResult)")

        let setResult = await send(command("office.slides.set_text", args: ["path": path, "slide": 5, "title": "x"], sessionId: "S1", commandId: "pcmd_nf_set"), through: host)
        XCTAssertFalse(setResult.ok, "set_text on an out-of-range slide must refuse")
        XCTAssertTrue((setResult.result ?? "").contains("slide 5"), "\(setResult)")

        let deleteResult = await send(command("office.slides.delete_slide", args: ["path": path, "slide": 5], sessionId: "S1", commandId: "pcmd_nf_delete"), through: host)
        XCTAssertFalse(deleteResult.ok, "delete_slide on an out-of-range slide must refuse")
        XCTAssertTrue((deleteResult.result ?? "").contains("slide 5"), "\(deleteResult)")

        let reorderResult = await send(command("office.slides.reorder", args: ["path": path, "slide": 5, "to": 1], sessionId: "S1", commandId: "pcmd_nf_reorder_slide"), through: host)
        XCTAssertFalse(reorderResult.ok, "reorder with an out-of-range `slide` must refuse")
        XCTAssertTrue((reorderResult.result ?? "").contains("slide 5"), "\(reorderResult)")

        let reorderToResult = await send(command("office.slides.reorder", args: ["path": path, "slide": 1, "to": 5], sessionId: "S1", commandId: "pcmd_nf_reorder_to"), through: host)
        XCTAssertFalse(reorderToResult.ok, "reorder with an out-of-range `to` must refuse")
        XCTAssertTrue((reorderToResult.result ?? "").contains("slide 5"), "\(reorderToResult)")

        let addResult = await send(command("office.slides.add_slide", args: ["path": path, "at": 99], sessionId: "S1", commandId: "pcmd_nf_add"), through: host)
        XCTAssertFalse(addResult.ok, "add_slide with an out-of-range `at` must refuse")
        XCTAssertTrue((addResult.result ?? "").contains("slide 99"), "\(addResult)")

        // --- lastSlide: gate.odp has exactly one slide (confirmed against its own content.xml
        // before this test was written) — deleting it must refuse. ---
        let gatePath = try makeWritableCopy(of: "gate.odp")
        let gateStateDir = makeScratchDirectory()
        let gateHost = makeLiveHost(stateDir: gateStateDir, dirs: [SessionDirEntry(path: (gatePath as NSString).deletingLastPathComponent, locked: true)])
        await gateHost.directory.refresh()
        let lastSlideResult = await send(command("office.slides.delete_slide", args: ["path": gatePath, "slide": 1], sessionId: "S1", commandId: "pcmd_last_slide"), through: gateHost)
        XCTAssertFalse(lastSlideResult.ok, "deleting a presentation's only slide must refuse")
        XCTAssertTrue((lastSlideResult.result ?? "").lowercased().contains("only one slide"), "\(lastSlideResult)")
    }

    // MARK: - Probe A live drill — the Tab-cycling text mechanism, against real content

    /// **The first live test of `selectSlidePlaceholderOnDedicatedThread`/`readSelectedShapeText
    /// OnDedicatedThread` against real content.** `three-slide.fodp` (this task's own fixture) has
    /// three slides, each with a REAL title+outline placeholder frame and distinct, known text
    /// ("Norma T6 Slide One/Two/Three", "first/second/third bullet") — if Tab-cycling and the
    /// `GRAPHIC_SELECTION`-based verification actually work, `info` (which now reads every slide's
    /// title, ruling 2) must report exactly this content, in order, and `read` must return both
    /// title AND body for one slide directly.
    func testLiveSlidesInfoReadsRealTitlesFromThreeSlideFixture() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.fodp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        // Distinct commandIds — `OfficeAgentBroker.perform`'s own `requestId`-keyed memoization
        // (deliberate, Task 2's own design) returns the FIRST call's cached outcome verbatim for a
        // repeated commandId; two `send()` calls sharing the default "pcmd_1" is exactly the trap
        // task-3-report.md §6 already documented hitting once (there, a wire-decode collision; here,
        // the identical mechanism). Never reuse the default across more than one `send()` in the same
        // test.
        let infoResult = await send(command("office.slides.info", args: ["path": path], sessionId: "S1", commandId: "pcmd_info"), through: host)
        XCTAssertTrue(infoResult.ok, "\(infoResult)")
        let infoText = infoResult.result ?? ""
        XCTAssertTrue(infoText.contains("3 slides"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide One"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide Two"), infoText)
        XCTAssertTrue(infoText.contains("Norma T6 Slide Three"), infoText)
        XCTAssertFalse(infoText.lowercased().contains("layout"), "info must never mention layout: \(infoText)")

        let readResult = await send(command("office.slides.read", args: ["path": path, "slide": 2], sessionId: "S1", commandId: "pcmd_read"), through: host)
        XCTAssertTrue(readResult.ok, "\(readResult)")
        let readText = readResult.result ?? ""
        XCTAssertTrue(readText.contains("Norma T6 Slide Two"), readText)
        XCTAssertTrue(readText.contains("second bullet"), readText)
    }

    // MARK: - Probe B live drill — is `reorder` reachable at all in a headless session?

    /// office-agent-tools T6, Probe B — `slides-lok-research.md` §2's own "R1": no arbitrary-index
    /// move UNO command exists at all; the only primitives are selection-based
    /// `MovePageUp`/`Down`/`First`/`Last`, and whether headless `setPart` drives that selection at
    /// all (there is no Slide Sorter panel to show, headless) was flagged as undeterminable from
    /// source — "the single biggest risk to `reorder` being implementable at this pin. Probe it
    /// FIRST, before building anything on top of it."
    ///
    /// Deliberately targets slide 2 (index 1), never slide 1 (index 0): a freshly-opened document's
    /// own DEFAULT selection is plausibly page 0, so a move that happened to target index 0 could
    /// "succeed" for a reason unrelated to `setPart` actually driving `MovePage*`'s own selection —
    /// indistinguishable from a lucky no-op. A move targeting index 1 cannot be explained by a stale
    /// default selection left over from document load.
    ///
    /// The three-position readout (not just "did slide 2 change") answers reachability AND the
    /// `setPart`-drives-selection question in the SAME run: if the WRONG page had moved instead
    /// (selection did not follow `setPart`), this would show up as a violated expectation at a
    /// DIFFERENT index than the one predicted below, not merely as "nothing changed."
    ///
    /// Reads via `independentClient` — a raw `OfficeHelperClient`, never adopted into any
    /// `OfficeRuntime` — mirroring the resume message's own "probes run on harness-opened disposable
    /// fixtures, agent view only, never adopted" instruction.
    func testProbeInvestigatesWhetherReorderIsReachableHeadless() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.odp")
        let gatePath = try makeWritableCopy(of: "gate.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [
            SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true),
            SessionDirEntry(path: (gatePath as NSString).deletingLastPathComponent, locked: true),
        ])
        await host.directory.refresh()

        // `officeHelperSupervisor.client` is nil until something has driven a command through the
        // full stack at least once (every existing use of this raw client across both command-test
        // files does the same priming send first — this is the established house pattern, not a
        // probe-specific workaround). Primes against `gate.odp`, a throwaway, UNRELATED single-slide
        // fixture — never `three-slide.odp` — so the probe's own document is never touched by the
        // broker/runtime at all, only by the raw client below, start to finish.
        let primed = await send(command("office.slides.info", args: ["path": gatePath], sessionId: "S1",
                                        commandId: "pcmd_prime"), through: host)
        XCTAssertTrue(primed.ok, "\(primed)")

        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the probe")
        }
        let docId = "slides-reorder-probe"
        _ = try await client.open(docId: docId, path: path)

        // Baseline — all three, in original order, ground-truthed against the fixture's own content.
        let before0 = try await client.slidesRead(docId: docId, slide: 0)
        let before1 = try await client.slidesRead(docId: docId, slide: 1)
        let before2 = try await client.slidesRead(docId: docId, slide: 2)
        XCTAssertEqual(before0.title, "Norma T6 Slide One")
        XCTAssertEqual(before1.title, "Norma T6 Slide Two")
        XCTAssertEqual(before2.title, "Norma T6 Slide Three")

        // Index 1 -> index 2: one MovePageDown-equivalent step.
        let count = try await client.slidesManagePage(docId: docId, op: .reorder, slide: 1, at: nil, to: 2, layout: nil)
        XCTAssertEqual(count, 3, "reorder must never change the slide count")

        let after0 = try await client.slidesRead(docId: docId, slide: 0)
        let after1 = try await client.slidesRead(docId: docId, slide: 1)
        let after2 = try await client.slidesRead(docId: docId, slide: 2)

        XCTAssertEqual(after0.title, "Norma T6 Slide One",
                       "index 0 must be untouched by a move that targeted index 1 — if THIS fails instead of "
                           + "index 1/2, setPart did not scope the move the way this call assumed")
        XCTAssertEqual(after1.title, "Norma T6 Slide Three",
                       "the content that was at index 2 must have shifted up to index 1")
        XCTAssertEqual(after2.title, "Norma T6 Slide Two",
                       "the slide this call targeted (index 1) must now be at index 2")

        try await client.close(docId: docId)
    }

    /// **The two-part discriminator, through save+reopen** — task-6-brief.md's own non-negotiable
    /// proof shape, and the exact gap Stage B's own T4 shipped a wrong-part edit before inventing:
    /// `set_text` on slide 2 must change slide 2 AND leave slides 1/3 untouched, proven from the
    /// SAVED FILE'S OWN BYTES (a genuinely independent reopen, bypassing the adopted runtime this
    /// call itself used — the same discipline `OfficeSheetsCommandTests`' own partial-failure drill
    /// established), never merely from the in-memory state the write itself produced.
    func testLiveSetTextChangesOnlyTheTargetedSlideProvenBySaveAndIndependentReopen() async throws {
        try requireLiveEngine()
        // `.odp` (packaged), NOT `.fodp` (flat XML) — `OfficeSaveFormat(pathExtension:)` has no case
        // for the flat variant (`saveAsOnDedicatedThread` throws "format not captured at open"),
        // confirmed live before this fixture existed. `three-slide.odp` is a byte-for-byte content
        // conversion of `three-slide.fodp` (same 3 slides, same real title/outline placeholders,
        // same text) into a real ODF package — content.xml/styles.xml/meta.xml/settings.xml/
        // META-INF/manifest.xml — so both fixtures describe the identical presentation, one flat
        // (read-only drills, easy to diff) and one packaged (write drills, which need a real save
        // target). `.fodp` stays the source of record; `.odp` is the compiled artifact.
        let path = try makeWritableCopy(of: "three-slide.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        // ADOPT first — deliberately, not a broker-minted open. A call that mints its OWN open closes
        // it again afterward (rule 2), fire-and-forget, over the SAME shared wire connection/seq
        // stream this test's own "independent" reopen below also uses
        // (`officeHelperSupervisor?.client` is the identical `OfficeHelperClient` the broker's own
        // Driver closures call into) — racing an `open()` against that still-in-flight `close()`
        // produced a genuine live failure (`"unexpected reply: closed(seq: 4, ...)"`), and waiting on
        // `documents[path] == nil` does NOT close the race: that flag is set OPTIMISTICALLY
        // (`OfficeRuntime.Driver.close`'s own doc comment — "optimistic removal in the reducer"),
        // before the close's own wire round trip actually completes. Adopting sidesteps the whole
        // race structurally: an ADOPTED document is never auto-closed by the broker at all, so there
        // is no close to race against.
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly")

        let setResult = await send(command("office.slides.set_text",
                                           args: ["path": path, "slide": 2, "title": "CHANGED TITLE", "body": "CHANGED BODY"],
                                           sessionId: "S1", commandId: "pcmd_set"), through: host)
        XCTAssertTrue(setResult.ok, "\(setResult)")

        guard let independentClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the independent reopen")
        }
        let independentDocId = "slides-set-text-two-part-reopen"
        _ = try await independentClient.open(docId: independentDocId, path: path)

        // Slide 2 (index 1, 0-based) — CHANGED, read from the SAVED file.
        let savedSlide2 = try await independentClient.slidesRead(docId: independentDocId, slide: 1)
        XCTAssertEqual(savedSlide2.title, "CHANGED TITLE",
                       "slide 2's title must be changed in the SAVED file, not just in memory")
        XCTAssertEqual(savedSlide2.body, "CHANGED BODY",
                       "slide 2's body must be changed in the SAVED file, not just in memory")

        // Slide 1 (index 0) — the two-part discriminator's OTHER half: genuinely untouched.
        let savedSlide1 = try await independentClient.slidesRead(docId: independentDocId, slide: 0)
        XCTAssertEqual(savedSlide1.title, "Norma T6 Slide One",
                       "slide 1 must be UNTOUCHED by a write aimed at slide 2 — a wrong-part edit "
                           + "would show up here, not on slide 2 itself")
        XCTAssertEqual(savedSlide1.body, "first bullet", "slide 1's body must also be untouched")

        // Slide 3 (index 2) — the SAME discriminator on the other side of the target.
        let savedSlide3 = try await independentClient.slidesRead(docId: independentDocId, slide: 2)
        XCTAssertEqual(savedSlide3.title, "Norma T6 Slide Three", "slide 3 must be UNTOUCHED")
        XCTAssertEqual(savedSlide3.body, "third bullet", "slide 3's body must also be untouched")

        try await independentClient.close(docId: independentDocId)

        // Filesystem-level seal, independent of every LOK abstraction above. The reads via
        // `independentClient` prove the WIRE/BROKER/HELPER path reports the right content, but they
        // still go through the same LOK process as the write — whether `documentLoad` on a
        // still-open path dedups to the SAME in-memory model rather than genuinely re-parsing disk is
        // not something this bridge's own API surface can distinguish. `content.xml` inside the saved
        // `.odp` zip is ground truth no LOK abstraction sits between: if the write only ever reached
        // memory and never reached `.uno:Save`'s own bytes, this is where that would show.
        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("CHANGED TITLE"), "saved content.xml must contain the new title text")
        XCTAssertTrue(contentXML.contains("CHANGED BODY"), "saved content.xml must contain the new body text")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Three"), "saved content.xml must still contain slide 3's untouched title")
        XCTAssertTrue(contentXML.contains("third bullet"), "saved content.xml must still contain slide 3's untouched body")
        XCTAssertFalse(contentXML.contains("Norma T6 Slide Two"), "slide 2's OLD title must be gone from the saved bytes, not just superseded in a read")
    }

    /// **The OTHER discriminator `set_text` needs — not cross-SLIDE, cross-FIELD, on the SAME slide.**
    /// `slides.ts`'s own documented contract: an absent `title`/`body` key means "leave this
    /// placeholder alone," never "clear it" — the identical absent-means-untouched contract `sheets
    /// format`'s attributes established. The two-part discriminator test above only ever exercises
    /// title+body together; this proves each field independently, through the same save+reopen +
    /// filesystem-seal discipline, on two fresh copies so neither call's own state can bleed into the
    /// other's reading.
    func testLiveSetTextTitleOnlyAndBodyOnlyLeaveTheOtherFieldUntouchedProvenBySaveAndIndependentReopen() async throws {
        try requireLiveEngine()

        // --- title-only: body must survive untouched. ---
        do {
            let path = try makeWritableCopy(of: "three-slide.odp")
            let stateDir = makeScratchDirectory()
            let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
            await host.directory.refresh()
            let runtime = host.officeRuntime(for: "S1")
            runtime.open(path)
            let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
            XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly (title-only)")

            let setResult = await send(command("office.slides.set_text",
                                               args: ["path": path, "slide": 2, "title": "TITLE ONLY CHANGED"],
                                               sessionId: "S1", commandId: "pcmd_set_title_only"), through: host)
            XCTAssertTrue(setResult.ok, "\(setResult)")

            guard let independentClient = host.officeHelperSupervisor?.client else {
                return XCTFail("no live client for the independent reopen (title-only)")
            }
            let docId = "slides-set-title-only-two-part-reopen"
            _ = try await independentClient.open(docId: docId, path: path)
            let saved = try await independentClient.slidesRead(docId: docId, slide: 1)
            XCTAssertEqual(saved.title, "TITLE ONLY CHANGED", "title must be changed in the saved file")
            XCTAssertEqual(saved.body, "second bullet", "body must survive UNTOUCHED when only title is named")
            try await independentClient.close(docId: docId)

            let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
            XCTAssertTrue(contentXML.contains("TITLE ONLY CHANGED"), "saved content.xml must contain the new title")
            XCTAssertTrue(contentXML.contains("second bullet"), "saved content.xml must still contain the untouched original body")
        }

        // --- body-only: title must survive untouched. ---
        do {
            let path = try makeWritableCopy(of: "three-slide.odp")
            let stateDir = makeScratchDirectory()
            let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
            await host.directory.refresh()
            let runtime = host.officeRuntime(for: "S1")
            runtime.open(path)
            let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
            XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly (body-only)")

            let setResult = await send(command("office.slides.set_text",
                                               args: ["path": path, "slide": 2, "body": "BODY ONLY CHANGED"],
                                               sessionId: "S1", commandId: "pcmd_set_body_only"), through: host)
            XCTAssertTrue(setResult.ok, "\(setResult)")

            guard let independentClient = host.officeHelperSupervisor?.client else {
                return XCTFail("no live client for the independent reopen (body-only)")
            }
            let docId = "slides-set-body-only-two-part-reopen"
            _ = try await independentClient.open(docId: docId, path: path)
            let saved = try await independentClient.slidesRead(docId: docId, slide: 1)
            XCTAssertEqual(saved.title, "Norma T6 Slide Two", "title must survive UNTOUCHED when only body is named")
            XCTAssertEqual(saved.body, "BODY ONLY CHANGED", "body must be changed in the saved file")
            try await independentClient.close(docId: docId)

            let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
            XCTAssertTrue(contentXML.contains("BODY ONLY CHANGED"), "saved content.xml must contain the new body")
            XCTAssertTrue(contentXML.contains("Norma T6 Slide Two"), "saved content.xml must still contain the untouched original title")
        }
    }

    // MARK: - `reorder` multi-step live drill — the two-part discriminator, through save+reopen

    /// Probe B (`testProbeInvestigatesWhetherReorderIsReachableHeadless`) only ran a single step
    /// (index 1 -> index 2). `slidesReorderOnDedicatedThread`'s own multi-step composition (repeated
    /// `MovePageUp`/`Down` dispatches) was implemented on the strength of research's own "clamps
    /// safely at the document boundary" finding but never independently live-verified. This is that
    /// verification: slide 1 (index 0) moves to position 3 (index 2), a distance-2 move requiring TWO
    /// `MovePageDown` dispatches in sequence. Adjacent-swap arithmetic predicts
    /// `[One, Two, Three] -> [Two, Three, One]` (step 1 swaps 0<->1: `[Two, One, Three]`; step 2 swaps
    /// 1<->2, where `One` now sits: `[Two, Three, One]`) — the full three-position readout again,
    /// through save+reopen and the raw `content.xml` seal, the same standard every other write verb
    /// here has met.
    func testLiveReorderMultiStepMovesAcrossTwoPositionsProvenBySaveAndIndependentReopen() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly")

        let reorderResult = await send(command("office.slides.reorder", args: ["path": path, "slide": 1, "to": 3],
                                               sessionId: "S1", commandId: "pcmd_reorder_multistep"), through: host)
        XCTAssertTrue(reorderResult.ok, "\(reorderResult)")

        guard let independentClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the independent reopen")
        }
        let independentDocId = "slides-reorder-multistep-two-part-reopen"
        _ = try await independentClient.open(docId: independentDocId, path: path)

        let infoAfter = try await independentClient.slidesInfo(docId: independentDocId)
        XCTAssertEqual(infoAfter.count, 3, "reorder must never change the slide count")

        let savedSlide1 = try await independentClient.slidesRead(docId: independentDocId, slide: 0)
        XCTAssertEqual(savedSlide1.title, "Norma T6 Slide Two", "index 0 must now hold what was slide 2")
        let savedSlide2 = try await independentClient.slidesRead(docId: independentDocId, slide: 1)
        XCTAssertEqual(savedSlide2.title, "Norma T6 Slide Three", "index 1 must now hold what was slide 3")
        let savedSlide3 = try await independentClient.slidesRead(docId: independentDocId, slide: 2)
        XCTAssertEqual(savedSlide3.title, "Norma T6 Slide One", "index 2 must now hold the slide this call targeted — moved two full positions")
        XCTAssertEqual(savedSlide3.body, "first bullet", "the moved slide's own body must have traveled with it, not been left behind or duplicated")

        try await independentClient.close(docId: independentDocId)

        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide One"), "saved content.xml must still contain the moved slide's title")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Two"), "saved content.xml must still contain the shifted slide 2's title")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Three"), "saved content.xml must still contain the shifted slide 3's title")
    }

    // MARK: - `add_slide` live drill — this IS the probe for InsertPage's relative-insert semantics

    /// **`InsertPage`'s own landing position was UNRESOLVED from source** (`slides-lok-research.md`'s
    /// own "flagged for live-testing rather than guessed"). This test is that live test, run against
    /// `slidesAddOnDedicatedThread`'s own first-attempt implementation (`setPart`-then-bare-
    /// `InsertPage`, `MovePageFirst` as a position-0 correction) — three independent scenarios, each
    /// on its own fresh copy so a failure in one is never entangled with another: append (`at`
    /// omitted), insert in the middle (`at` = 2), insert at the very front (`at` = 1). Each asserts
    /// every ORIGINAL slide's own title is exactly where the shift predicts — never the new slide's
    /// own content, which is expected to be empty and proves nothing about WHERE it landed. The
    /// middle-insert scenario additionally goes through the full save+reopen two-part-discriminator
    /// treatment (independent reopen + raw `content.xml` filesystem seal), matching the standard
    /// `set_text`/`delete_slide` already met — the other two scenarios check via the same adopted
    /// session's own `info` call, which is sufficient to confirm POSITION (this test's actual subject)
    /// without re-paying the full save+reopen cost three times over.
    func testLiveAddSlideInsertsAtEveryRequestedPosition() async throws {
        try requireLiveEngine()

        // --- Scenario 1: `at` omitted -> append at the end. ---
        do {
            let path = try makeWritableCopy(of: "three-slide.odp")
            let stateDir = makeScratchDirectory()
            let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
            await host.directory.refresh()
            let runtime = host.officeRuntime(for: "S1")
            runtime.open(path)
            let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
            XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly")

            let addResult = await send(command("office.slides.add_slide", args: ["path": path],
                                               sessionId: "S1", commandId: "pcmd_add_append"), through: host)
            XCTAssertTrue(addResult.ok, "\(addResult)")

            let infoResult = await send(command("office.slides.info", args: ["path": path],
                                                sessionId: "S1", commandId: "pcmd_info_append"), through: host)
            XCTAssertTrue(infoResult.ok, "\(infoResult)")
            let infoText = infoResult.result ?? ""
            XCTAssertTrue(infoText.contains("4 slides"), infoText)
            XCTAssertTrue(infoText.hasPrefix("4 slides") || infoText.contains("4 slides"), infoText)
            // Original three, in order, at positions 1/2/3 — the new (empty) slide at position 4.
            let lines = infoText.split(separator: "\n")
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("1. ") && $0.contains("Norma T6 Slide One") }), infoText)
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("2. ") && $0.contains("Norma T6 Slide Two") }), infoText)
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("3. ") && $0.contains("Norma T6 Slide Three") }), infoText)
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("4. ") }), "there must be a 4th slide line: \(infoText)")
        }

        // --- Scenario 2: `at` = 2 -> insert in the middle, full save+reopen discriminator. ---
        let middlePath = try makeWritableCopy(of: "three-slide.odp")
        let middleStateDir = makeScratchDirectory()
        let middleHost = makeLiveHost(stateDir: middleStateDir, dirs: [SessionDirEntry(path: (middlePath as NSString).deletingLastPathComponent, locked: true)])
        await middleHost.directory.refresh()
        let middleRuntime = middleHost.officeRuntime(for: "S1")
        middleRuntime.open(middlePath)
        let middleOpened = await waitUntilLive { middleRuntime.stateSnapshot.documents[middlePath] != nil || middleRuntime.stateSnapshot.phase == .failed }
        XCTAssertTrue(middleOpened, "setup: three-slide.odp must open cleanly (middle scenario)")

        let addMiddleResult = await send(command("office.slides.add_slide", args: ["path": middlePath, "at": 2],
                                                  sessionId: "S1", commandId: "pcmd_add_middle"), through: middleHost)
        XCTAssertTrue(addMiddleResult.ok, "\(addMiddleResult)")

        guard let independentClient = middleHost.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the independent reopen")
        }
        let independentDocId = "slides-add-middle-two-part-reopen"
        _ = try await independentClient.open(docId: independentDocId, path: middlePath)
        let infoAfter = try await independentClient.slidesInfo(docId: independentDocId)
        XCTAssertEqual(infoAfter.count, 4, "add_slide must produce exactly 4 slides")

        // Index 0 — untouched (was slide 1, still slide 1).
        let savedSlide1 = try await independentClient.slidesRead(docId: independentDocId, slide: 0)
        XCTAssertEqual(savedSlide1.title, "Norma T6 Slide One", "slide 1 must be untouched by an insert at position 2")
        // Index 1 — the new, empty slide (this is where `at: 2` landed it).
        // Index 2 — what WAS slide 2, shifted down one.
        let savedSlide3 = try await independentClient.slidesRead(docId: independentDocId, slide: 2)
        XCTAssertEqual(savedSlide3.title, "Norma T6 Slide Two", "the original slide 2 must have shifted to position 3")
        // Index 3 — what WAS slide 3, shifted down one.
        let savedSlide4 = try await independentClient.slidesRead(docId: independentDocId, slide: 3)
        XCTAssertEqual(savedSlide4.title, "Norma T6 Slide Three", "the original slide 3 must have shifted to position 4")

        try await independentClient.close(docId: independentDocId)

        let contentXML = try readODFEntry(atPath: middlePath, entry: "content.xml")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide One"), "saved content.xml must still contain slide 1's untouched title")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Two"), "saved content.xml must still contain the shifted slide 2's title")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Three"), "saved content.xml must still contain the shifted slide 3's title")

        // --- Scenario 3: `at` = 1 -> insert at the very front. ---
        do {
            let path = try makeWritableCopy(of: "three-slide.odp")
            let stateDir = makeScratchDirectory()
            let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
            await host.directory.refresh()
            let runtime = host.officeRuntime(for: "S1")
            runtime.open(path)
            let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
            XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly (front scenario)")

            let addResult = await send(command("office.slides.add_slide", args: ["path": path, "at": 1],
                                               sessionId: "S1", commandId: "pcmd_add_front"), through: host)
            XCTAssertTrue(addResult.ok, "\(addResult)")

            let infoResult = await send(command("office.slides.info", args: ["path": path],
                                                sessionId: "S1", commandId: "pcmd_info_front"), through: host)
            XCTAssertTrue(infoResult.ok, "\(infoResult)")
            let infoText = infoResult.result ?? ""
            let lines = infoText.split(separator: "\n")
            // The new (empty) slide at position 1 — original three shifted to positions 2/3/4.
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("2. ") && $0.contains("Norma T6 Slide One") }), infoText)
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("3. ") && $0.contains("Norma T6 Slide Two") }), infoText)
            XCTAssertTrue(lines.contains(where: { $0.hasPrefix("4. ") && $0.contains("Norma T6 Slide Three") }), infoText)
        }
    }

    // MARK: - `delete_slide` live drill — the two-part discriminator, through save+reopen

    /// Mirrors `set_text`'s own two-part-discriminator test exactly in spirit: `delete_slide` on
    /// slide 2 must remove ONLY slide 2's own content, leave slide 1's and (what was) slide 3's own
    /// content genuinely intact — just shifted down one position — and this must be true from the
    /// SAVED FILE'S OWN BYTES, not merely from the in-memory state the write itself produced. Adopts
    /// first (same race-avoidance reasoning `testLiveSetTextChangesOnlyTheTargetedSlideProvenBySave
    /// AndIndependentReopen`'s own header explains) so `delete_slide` never mints-and-closes its own
    /// open, and the independent reopen below never races that close.
    func testLiveDeleteSlideRemovesOnlyTheTargetedSlideProvenBySaveAndIndependentReopen() async throws {
        try requireLiveEngine()
        let path = try makeWritableCopy(of: "three-slide.odp")
        let stateDir = makeScratchDirectory()
        let host = makeLiveHost(stateDir: stateDir, dirs: [SessionDirEntry(path: (path as NSString).deletingLastPathComponent, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntilLive { runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(opened, "setup: three-slide.odp must open cleanly")

        let deleteResult = await send(command("office.slides.delete_slide", args: ["path": path, "slide": 2],
                                              sessionId: "S1", commandId: "pcmd_delete"), through: host)
        XCTAssertTrue(deleteResult.ok, "\(deleteResult)")

        guard let independentClient = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client for the independent reopen")
        }
        let independentDocId = "slides-delete-two-part-reopen"
        _ = try await independentClient.open(docId: independentDocId, path: path)

        let infoAfter = try await independentClient.slidesInfo(docId: independentDocId)
        XCTAssertEqual(infoAfter.count, 2, "delete_slide must leave exactly 2 slides")

        // Index 0 — untouched (was slide 1, still slide 1).
        let savedSlide1 = try await independentClient.slidesRead(docId: independentDocId, slide: 0)
        XCTAssertEqual(savedSlide1.title, "Norma T6 Slide One", "slide 1 must be UNTOUCHED by a delete that targeted slide 2")
        XCTAssertEqual(savedSlide1.body, "first bullet", "slide 1's body must also be untouched")

        // Index 1 — what WAS slide 3, now shifted down to occupy slide 2's old position. This is the
        // two-part discriminator's own proof that the RIGHT slide was removed: if slide 1 had been
        // deleted instead (or some other wrong-part failure), this position would read "Slide One" or
        // stay empty, not "Slide Three".
        let savedSlide2 = try await independentClient.slidesRead(docId: independentDocId, slide: 1)
        XCTAssertEqual(savedSlide2.title, "Norma T6 Slide Three", "the surviving third slide must have shifted into the deleted slide's old position")
        XCTAssertEqual(savedSlide2.body, "third bullet")

        try await independentClient.close(docId: independentDocId)

        // Filesystem-level seal, same discipline `91ad38ce` established for `set_text`.
        let contentXML = try readODFEntry(atPath: path, entry: "content.xml")
        XCTAssertFalse(contentXML.contains("Norma T6 Slide Two"), "deleted slide's title must be gone from the saved bytes")
        XCTAssertFalse(contentXML.contains("second bullet"), "deleted slide's body must be gone from the saved bytes")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide One"), "saved content.xml must still contain slide 1's untouched title")
        XCTAssertTrue(contentXML.contains("Norma T6 Slide Three"), "saved content.xml must still contain the surviving third slide's title")
    }

    /// `unzip -p` for a single entry inside a saved ODF (zip-based, same container format as OOXML)
    /// document — mirrors `OfficeSheetsCommandTests.readOOXMLEntry`'s own shape exactly (shell out to
    /// a well-understood system tool rather than reimplement zip reading), kept as a local copy per
    /// that suite's own established per-file-helper convention.
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
