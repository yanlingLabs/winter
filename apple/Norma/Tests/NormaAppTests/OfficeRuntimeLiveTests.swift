import XCTest
@testable import Norma
#if canImport(Darwin)
import Darwin
#endif

/// Office Stage A Task 5 — the live smoke test: one `OfficeRuntime`, reached through
/// `ShellSessionHost`'s REAL production wiring (the shared `OfficeHelperSupervisor`, the
/// `OfficeHelperRequestQueue` funnel, the fan-out this task built), against the REAL compiled
/// `NormaOfficeHelper` binary and the REAL vendored LibreOffice tree. Proves the whole app-side
/// plumbing end to end — not just the pure reducer (`OfficeRuntimeReducerTests`) or the
/// recorder-backed doubles (`ShellSessionHostTests`' office suite).
///
/// Vendor-gated exactly like `OfficeHelperLiveSmokeTests`/`OfficeHelperLiveTests`: skips (never
/// fails) when the helper binary, the vendor tree, or the fixture is not present in this run's
/// `BUILT_PRODUCTS_DIR` — the same `XCTSkipIf`-naming-what's-missing convention every other live
/// test in this suite already uses. Second-copy hygiene throughout: a scratch state directory under
/// `/tmp`, never `~/.norma*`, never the user's app.
@MainActor
final class OfficeRuntimeLiveTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/officeruntime-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    private func isProcessAlive(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0
    }

    // MARK: - Repo-relative paths (same `#filePath`-climbing precedent as
    // `CliLauncher.defaultRepoRoot`/`OfficeHelperLiveTests`/`OfficeHelperLiveSmokeTests`)

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Tests/NormaAppTests/OfficeRuntimeLiveTests.swift`.
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
    /// Office Stage B Task 1 — the checked-in seatbelt profile SOURCE. Every test below spawns the
    /// STANDALONE `BUILT_PRODUCTS_DIR` build product via `OfficeHelperSupervisor.Configuration`'s
    /// own `extraArguments` seam (never the app-embedded copy), which has no
    /// `Contents/Resources/office-helper.sb` sibling of its own — exactly the same reason each of
    /// those `extraArguments` arrays already carries `--lok-root`. Found via a deliberate sweep of
    /// every real-helper spawn site in this test bundle (this file's own `--lok-root` calls are a
    /// second, independent spawn path from `OfficeHelperLiveTests.spawnLiveHelper`, easy to miss —
    /// see task-1-report.md), not by any of these tests failing first.
    private static var sandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }

    /// **The Task 5 exit gate**: one runtime opens `gate.xlsx` through the REAL supervisor+helper
    /// and reaches `.ready` with parts/size populated, then the quit-shaped teardown
    /// (`teardownAllOfficeRuntimesAndStopHelper` — never the per-session `teardownOfficeRuntime`,
    /// which by design never touches the shared PROCESS) leaves no helper process behind (a `ps`-
    /// style assert via `kill(pid, 0)`, independent of the supervisor's own death-detection
    /// machinery — see `isProcessAlive`'s own doc).
    func testOneRuntimeOpensGateXlsxThroughTheRealSupervisorAndHelperThenTeardownLeavesNoHelperProcess() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run. "
                        + "This pin goes live the moment it's built.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root. This pin goes live the "
                        + "moment it's fetched.")
        let gatePath = Self.fixturesRoot.appendingPathComponent("gate.xlsx").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: gatePath), "gate.xlsx fixture missing at \(gatePath)")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        // The ONE seam this test overrides: point the shared supervisor at the standalone build
        // product with `--lok-root` (this test-host bundle has no `Contents/Resources/LibreOffice`
        // sibling of its own — same shape `OfficeHelperLiveSmokeTests` already established) and at
        // a scratch state directory. Everything downstream — `officeRuntime(for:)`, the driver, the
        // request queue, the fan-out — is the REAL production wiring, untouched.
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(gatePath)

        // 90s: absorbs a cold `libmergedlo.dylib` dlopen (task-3-report.md measured a cold run
        // needing more than 20s) PLUS the open's own round trip on top of the boot — generous
        // headroom over `OfficeHelperLiveSmokeTests`' own 60s handshake-only bound.
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[gatePath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "gate.xlsx never settled — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertEqual(runtime.stateSnapshot.phase, .ready, "failureReason: "
                       + "\(runtime.stateSnapshot.failureReason ?? "none")")
        guard let doc = runtime.stateSnapshot.documents[gatePath] else {
            return XCTFail("gate.xlsx did not open: "
                           + "\(runtime.stateSnapshot.openFailures[gatePath] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.type, .spreadsheet)
        XCTAssertGreaterThan(doc.parts, 0, "gate.xlsx has at least one sheet")
        XCTAssertGreaterThan(doc.sizeTwips.widthTwips, 0)
        XCTAssertGreaterThan(doc.sizeTwips.heightTwips, 0)

        guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
            return XCTFail("supervisor has no live process to check")
        }
        XCTAssertTrue(isProcessAlive(helperPID), "the helper should still be running before teardown")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()

        let died = await waitUntil(timeout: 10) { !self.isProcessAlive(helperPID) }
        XCTAssertTrue(died, "the helper process (pid \(helperPID)) survived teardown")
    }

    /// **office-plumbing Task 6's own exit gate** — the tile pipeline, end to end, through the REAL
    /// production wiring this task added: `OfficeRuntime.perform`'s `.subscribe` case (subscribeTiles
    /// -> filter through the store -> requestTiles, all through `officeRequestQueue`), and
    /// `ShellSessionHost.wireOfficeTileCallbacks` (the shared client's `onTile` push routed by docId
    /// into `OfficeRuntime.tileStore.ingest`). Nothing here touches `OfficeTileCanvasView` or
    /// `PanelDocumentTabModel` — the canvas's own viewport/zoom/part MATH is proven pure and offline
    /// (`OfficeTileCanvasViewTests`); this test is the one proof that REAL LOK pixels actually reach
    /// the store a mounted canvas would read from, which nothing offline can substitute for.
    ///
    /// Scroll and zoom are exercised as genuinely different viewports/zoom levels — both produce
    /// tile keys `TileMath` itself computes (the same authority the canvas uses), so this test can
    /// never assert a key TileMath and the production code would disagree about.
    ///
    /// **office-plumbing Task 9 — the parts==1 tripwire, flipped.** This test used to stop at
    /// `gate.xlsx` (exactly one part — `OfficeHelperLiveTests`'s own `Expectation` table) and repeat
    /// `subscribeTiles(part: 0, ...)` a second time as the closest honest proxy for a cross-part
    /// switch, with a comment naming the condition under which it should be extended: "if this ever
    /// changes, extend this test to a real second-part ask." T9 is what changes it — a SECOND
    /// document, `officeHarnessMultiSheetFodsContent()` (`OfficeHarnessScript.swift`, shared with the
    /// Office Harness itself), templated fresh at test time with two `<table:table>` sheets in two
    /// different fill colors. Opened alongside `gate.xlsx` on the SAME runtime (one runtime holds
    /// several open documents — `OfficeRuntimeState.documents` is keyed by path), this proves
    /// `doc.parts == 2` against real LOK and that `subscribeTiles(part: 1, ...)` paints tile (0,0)
    /// pixel-DISTINCT from `subscribeTiles(part: 0, ...)` at the identical `TileKey` coordinates —
    /// the genuine cross-part switch the old comment deferred. The PLUMBING for a part switch
    /// (`OfficeTileCanvasView.setActivePart` resubscribing) stays proven live at the recorder level in
    /// `OfficeTileCanvasViewTests`, unchanged by this — that class fakes the driver; this one is
    /// about whether real LOK actually paints a second part differently, which no recorder can answer.
    func testSubscribingAndRequestingTilesThroughTheRealHelperDeliversRealPixelsIntoTheTileStore() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let gatePath = Self.fixturesRoot.appendingPathComponent("gate.xlsx").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: gatePath), "gate.xlsx fixture missing at \(gatePath)")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(gatePath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[gatePath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "gate.xlsx never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[gatePath] else {
            return XCTFail("gate.xlsx did not open: "
                           + "\(runtime.stateSnapshot.openFailures[gatePath] ?? "no reason recorded")")
        }
        let docId = doc.docId

        // --- Cold fill: a 2x2-tile viewport at the canonical 100% zoom (zoomPPT 1000). ---
        let zoomPPT1000 = 1000
        let coldViewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512),
                                               zoomPPT: zoomPPT1000)
        let expectedColdKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT1000, viewportTwips: coldViewport)
        XCTAssertFalse(expectedColdKeys.isEmpty, "gate.xlsx (\(doc.sizeTwips)) must cover at least one tile at 100%")
        runtime.subscribeTiles(path: gatePath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: coldViewport)

        let coldFilled = await waitUntil(timeout: 30) {
            expectedColdKeys.allSatisfy { runtime.tileStore.tile(docId: docId, key: $0) != nil }
        }
        XCTAssertTrue(coldFilled, "cold fill never completed for \(expectedColdKeys.count) tiles "
                       + "(\(expectedColdKeys.filter { runtime.tileStore.tile(docId: docId, key: $0) == nil }.count) still missing)")
        for key in expectedColdKeys {
            guard let entry = runtime.tileStore.tile(docId: docId, key: key) else { continue }
            XCTAssertEqual(entry.pixels.count, TileMath.bytesPerTile, "\(key): exactly one tile's worth of RGBA bytes")
            XCTAssertTrue(entry.pixels.contains { $0 != 0 }, "\(key): real paint, not an untouched zero buffer")
        }

        // --- Scroll: a viewport shifted by two full tile spans, disjoint from the cold-fill set.
        // The shift is expressed in POINTS (`officeViewportTwips`'s own input unit) by running
        // `TileMath.twipsToPixels` + the fixed 2x scale BACKWARDS — the exact inverse of what
        // `officeViewportTwips` itself does, so this test speaks the same unit chain as the
        // production code rather than an independently-derived fudge factor. ---
        let span = TileMath.tileSpanTwips(zoomPPT: zoomPPT1000)
        let shiftPixels = TileMath.twipsToPixels(span * 2, zoomPPT: zoomPPT1000)
        let scrolledOrigin = CGPoint(x: CGFloat(shiftPixels) / officeFixedDeviceScale, y: 0)
        let scrolledViewport = officeViewportTwips(scrollOrigin: scrolledOrigin, visibleSize: CGSize(width: 256, height: 256),
                                                   zoomPPT: zoomPPT1000)
        let expectedScrolledKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT1000, viewportTwips: scrolledViewport)
        let newFromScroll = expectedScrolledKeys.filter { !expectedColdKeys.contains($0) }
        if !newFromScroll.isEmpty {
            runtime.subscribeTiles(path: gatePath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: scrolledViewport)
            let scrolledFilled = await waitUntil(timeout: 30) {
                newFromScroll.allSatisfy { runtime.tileStore.tile(docId: docId, key: $0) != nil }
            }
            XCTAssertTrue(scrolledFilled, "the scrolled-into tiles never arrived: \(newFromScroll)")
        }

        // --- Zoom: 200% (zoomPPT 2000) — a structurally different TileKey (zoomPPT is part of its
        // identity), so this can only be satisfied by a FRESH real paint at the new zoom, never a
        // cache hit left over from the 100% pass above. ---
        let zoomPPT2000 = 2000
        let zoomedViewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256),
                                                 zoomPPT: zoomPPT2000)
        let expectedZoomedKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT2000, viewportTwips: zoomedViewport)
        XCTAssertFalse(expectedZoomedKeys.isEmpty)
        runtime.subscribeTiles(path: gatePath, part: 0, zoomPPT: zoomPPT2000, viewportTwips: zoomedViewport)
        let zoomedFilled = await waitUntil(timeout: 30) {
            expectedZoomedKeys.allSatisfy { runtime.tileStore.tile(docId: docId, key: $0) != nil }
        }
        XCTAssertTrue(zoomedFilled, "the 200%-zoom tiles never arrived: \(expectedZoomedKeys)")

        // --- Part sanity: gate.xlsx itself still has exactly one sheet — unrelated to the real
        // cross-part proof below, which uses a SECOND document precisely because this one cannot
        // supply it. ---
        XCTAssertEqual(doc.parts, 1, "gate.xlsx is a fixed single-sheet fixture — see OfficeHelperLiveTests' own table")
        runtime.subscribeTiles(path: gatePath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: coldViewport)
        try? await Task.sleep(nanoseconds: 200_000_000) // let it settle; nothing new is expected

        // --- office-plumbing Task 9: the real second-part ask, against a genuinely multi-part
        // document — see this test's own header for why gate.xlsx itself could never supply this. ---
        let multiPath = makeScratchDirectory().appendingPathComponent("t9-multisheet.fods").path
        try officeHarnessMultiSheetFodsContent().write(toFile: multiPath, atomically: true, encoding: .utf8)
        runtime.open(multiPath)
        let multiSettled = await waitUntil(timeout: 40) {
            runtime.stateSnapshot.documents[multiPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(multiSettled, "the templated two-sheet fixture never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let multiDoc = runtime.stateSnapshot.documents[multiPath] else {
            return XCTFail("the templated fixture did not open: "
                           + "\(runtime.stateSnapshot.openFailures[multiPath] ?? "no reason recorded")")
        }
        let multiDocId = multiDoc.docId
        XCTAssertEqual(multiDoc.type, .spreadsheet)
        XCTAssertEqual(multiDoc.parts, 2, "the templated fixture carries two <table:table> sheets — "
                       + "real LOK must report two parts for it, or nothing below proves a real switch")

        // **`TileKey` carries `part` as part of its own identity** (`TileMath.swift`'s own struct) —
        // so part 0's and part 1's paints of "the same" tile (0,0) live under two DIFFERENT keys in
        // the store, never one key overwritten twice. Comparing against a single shared key would
        // silently compare an entry to itself and never actually observe part 1's paint at all.
        let part0Key = TileKey(part: 0, zoomPPT: zoomPPT1000, tileX: 0, tileY: 0)
        let part1Key = TileKey(part: 1, zoomPPT: zoomPPT1000, tileX: 0, tileY: 0)
        let partViewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256),
                                               zoomPPT: zoomPPT1000)
        runtime.subscribeTiles(path: multiPath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: partViewport)
        let part0Filled = await waitUntil(timeout: 20) { runtime.tileStore.tile(docId: multiDocId, key: part0Key) != nil }
        XCTAssertTrue(part0Filled, "part 0's tile (0,0) never arrived")
        let part0Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: multiDocId, key: part0Key)).pixels

        // `subscribeRequested` is what actually asks LOK to switch which part paints
        // (`TileRenderer`'s own doc: `nPart` is passed DIRECTLY to `paintPartTile`) — real LOK must
        // paint DIFFERENT pixels for part 1 at the identical tile COORDINATE, or this is not a real
        // cross-part switch.
        runtime.subscribeTiles(path: multiPath, part: 1, zoomPPT: zoomPPT1000, viewportTwips: partViewport)
        let part1Filled = await waitUntil(timeout: 20) { runtime.tileStore.tile(docId: multiDocId, key: part1Key) != nil }
        XCTAssertTrue(part1Filled, "part 1's tile (0,0) never arrived — either the part switch did not "
                       + "reach LOK, or the store never recorded it under its own (part: 1) key")
        let part1Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: multiDocId, key: part1Key)).pixels
        XCTAssertNotEqual(part0Pixels, part1Pixels, "part 1 must paint pixel-DISTINCT content from "
                          + "part 0 at the identical tile coordinates — the whole claim of a real "
                          + "cross-part switch")
        XCTAssertEqual(part1Pixels.count, TileMath.bytesPerTile)
        XCTAssertEqual(runtime.stateSnapshot.documents[multiPath]?.activePart, 1,
                       "subscribeRequested(part: 1, ...) must have updated activePart — the part strip's own read")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - Office Stage B Task 2: the save round trip, end to end through the real supervisor+helper

    /// **Formerly KNOWN, DISCLOSED, CURRENTLY-FAILING (2 of ~9 assertions per fixture) —
    /// task-2-report.md's NEEDS_CONTEXT finding, resolved by Office Stage B Task 2b.** `becameDirty`
    /// and the post-reopen pixel-difference assertion used to fail: every document this XCTest
    /// process opened was sandboxed AND outside `--state-path`, which live root-causing proved is
    /// the exact condition under which LOK loads a document read-only — `paste()` still reported
    /// success (it mutates the in-memory model) but was a silent no-op, so the modified flag never
    /// flipped and the saved bytes were the unedited originals. Task 2b's own resolution (named, not
    /// yet chosen, by Task 2's report — see `LOKBridge.disableDocumentLockFile`'s own NEEDS_CONTEXT
    /// block, updated in place, for the full account): the redesign, never the fence. Every document
    /// is now staged into `--state-path` BEFORE the wire `open`, so it loads genuinely writable —
    /// `becameDirty` and the pixel-difference assertion both went green the moment staging landed,
    /// with NO change to what either assertion CHECKS (only the production code that makes them
    /// true) — the flip itself predates the later, separate, comment-only marker-removal pass that
    /// trimmed the now-stale "EXPECTED TO FAIL" wording from both messages. Everything else this
    /// test exercises — open, real tile paint, the save wire round trip, EXDEV-safe atomic
    /// placement, no save-failed banner, close, reopen, format preservation via successful reparse,
    /// and now a live post-save dirty-clears wait (Task 2b, I1) — is asserted for real, on the SAME
    /// open document, across all four original assertions and the new fifth.
    ///
    /// **The task's own exit gate**: save -> close -> reopen -> content matches, format preserved,
    /// across the two minimum formats the brief names. Looped over both fixtures IN ONE test
    /// (`OfficeHelperLiveTests.testSixFormatsOpenWithSaneTypePartsAndSize`'s own established
    /// precedent for "one cold LOK boot, several fixtures against it" — a fresh helper per format
    /// would multiply this test's own cold-boot cost for no added proof).
    ///
    /// **The two formats are `.ods`/`.odt`, not the brief's own `.uno:EnterString`-suggested
    /// spreadsheet pairing — a live-test-caught, disclosed substitution
    /// (`OfficeHelperLiveTests.testKnownLimitationOOXMLExportIsNotAvailableInThisVendorBuildWhile
    /// ODFExportWorks` pins the reason): this vendored, from-source LibreOffice build's OOXML EXPORT
    /// filter does not work at all — `saveAs` against ANY xlsx/docx destination crashes the whole
    /// helper process, independent of the seatbelt, independent of any edit, independent of the
    /// `pFormat` string tried. ODF export (`.ods`/`.odt`/`.odp`) is unaffected. This task's own job —
    /// the save PIPELINE (wire, helper dispatch, atomic place, suppression, dirty tracking) — is
    /// fully proven by the ODF pair; the OOXML gap is a vendored-binary completeness problem, not a
    /// defect in anything this task built.
    ///
    /// **What "content matches" can actually MEAN here, and why**: Stage A/B ships no wire verb that
    /// reads cell/paragraph text back (no `getTextSelection`-equivalent exposed over
    /// `OfficeWireFrame`) — the only content-shaped observable this whole protocol offers is a
    /// PAINTED TILE's own pixels, which is exactly what Task 4's own
    /// `testReloadOfAModifiedFixtureCopyProducesADifferentTileHashAtTheSameCoordinates` already
    /// established as this codebase's accepted proof of "the content genuinely changed, not just the
    /// file's mtime": paint tile (0,0) before the edit, paint it again after save+close+reopen, and
    /// require the pixels to DIFFER — a corrupted or reverted save would paint IDENTICAL pixels at
    /// the identical coordinate. **"Format preserved" is the reopen itself succeeding as the SAME
    /// `OfficeDocumentKind`**: a `saveAs` that wrote the wrong filter, truncated the archive, or
    /// otherwise corrupted the format would fail `documentLoad` outright on reopen
    /// (`OfficeHelperServer`'s own "the helper survives a failed open" path), landing in
    /// `openFailures` rather than `documents` — there is no stronger claim available at this wire
    /// layer, and none is needed: a successful re-parse as the SAME kind IS the format-preservation
    /// proof.
    ///
    /// **The edit itself** goes through the DEBUG-only `debugEdit` wire door directly — bypassing
    /// `OfficeRuntime`/`ShellSessionHost` entirely, straight at `OfficeHelperSupervisor.client`
    /// (`@testable import`, the same access this file's other tests already use for
    /// `host.officeHelperSupervisor?.process`) — production code never calls this; only THIS test
    /// does, standing in for Task 4's real edit verbs. `.uno:GoToCell` (a no-op for `.odt`, which has
    /// no concept of "cell") then a `paste()` at the current selection/cursor — see
    /// `LOKBridge.debugEditOnDedicatedThread`'s own header for why `paste`, not the brief's own
    /// suggested `.uno:EnterString` (a SEPARATE live-test-caught correction: that UNO dispatch popped
    /// its own real LOK window callback, unrelated to the OOXML finding above).
    func testSaveThroughTheDebugEditDoorThenCloseThenReopenPersistsRealContentAcrossTwoFormats() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        let zoomPPT = 1000
        let key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)

        let expectedKind: [String: OfficeDocumentKind] = ["gate.ods": .spreadsheet, "gate.odt": .text]
        for fixtureName in ["gate.ods", "gate.odt"] {
            let fixturePath = Self.fixturesRoot.appendingPathComponent(fixtureName).path
            try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "\(fixtureName) fixture missing")

            // A WRITABLE copy — the checked-in Fixtures directory is never itself a save target
            // (mirrors `OfficeHelperLiveTests.testOpeningADocumentInAWritableDirectoryLeavesNoLock
            // FileBeside`'s identical copy-first discipline).
            let scratchDir = makeScratchDirectory()
            let docPath = scratchDir.appendingPathComponent("editable-\(fixtureName)").path
            try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

            runtime.open(docPath)
            let settled = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(settled, "\(fixtureName) never settled — phase: \(runtime.stateSnapshot.phase)")
            guard let doc = runtime.stateSnapshot.documents[docPath] else {
                XCTFail("\(fixtureName) did not open: "
                        + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
                continue
            }
            let originalDocId = doc.docId
            let kind = try XCTUnwrap(expectedKind[fixtureName])
            XCTAssertEqual(doc.type, kind, "\(fixtureName): setup")
            XCTAssertEqual(doc.dirty, false, "\(fixtureName): a freshly opened document reports clean "
                           + "— LOK's own real `.uno:ModifiedStatus=false` firing at open time, T4's "
                           + "own live probe already observed this for gate.xlsx")

            // Paint BEFORE the edit — the baseline half of the pixel-level proof that the edit
            // (not just the reopen/reparse) is what changed the saved bytes.
            runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            let paintedBefore = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: originalDocId, key: key) != nil }
            XCTAssertTrue(paintedBefore, "\(fixtureName): the pre-edit tile never arrived")
            let pixelsBefore = try XCTUnwrap(runtime.tileStore.tile(docId: originalDocId, key: key),
                                              "\(fixtureName)").pixels

            guard let client = host.officeHelperSupervisor?.client else {
                XCTFail("\(fixtureName): no live client to drive the debug edit door through")
                continue
            }
            try await client.debugEdit(docId: originalDocId, text: "T2-EDIT-\(fixtureName)")

            // Office Stage B Task 2b resolved the NEEDS_CONTEXT finding this assertion used to be
            // pinned against (this test's own header has the full before/after account): staging
            // makes every document genuinely writable, so the debug edit's `paste()` is no longer a
            // silent no-op against a read-only medium.
            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "\(fixtureName): the debug edit's own `.uno:ModifiedStatus=true` "
                          + "callback never reached documents[path].dirty — the dirty-tracking wire "
                          + "(ShellSessionHost.wireOfficeTileCallbacks' onDocumentEvent routing) is "
                          + "what this assertion actually proves, not merely that the edit happened")

            // Sanity: the debug edit's own target docId must still be `docPath`'s CURRENT docId the
            // instant before save is requested — a guard against a spurious reload racing the edit
            // that would otherwise make a genuine save-flow failure look identical to "the edit
            // landed on a handle nothing downstream cares about anymore."
            XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, originalDocId,
                           "\(fixtureName): docId changed BEFORE save was even requested — something "
                           + "reloaded and the debug edit's target handle is gone")

            let beforeSaveStat = officeFileStat(atPath: docPath)
            runtime.save(docPath)
            let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
            XCTAssertTrue(fileChanged, "\(fixtureName): the real document path never changed — the "
                          + "save never landed (docId=\(runtime.stateSnapshot.documents[docPath]?.docId ?? "nil") "
                          + "banner=\(runtime.stateSnapshot.documentBanners[docPath] ?? "nil") "
                          + "phase=\(runtime.stateSnapshot.phase))")
            XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "\(fixtureName): no save-failed banner")

            // **Task 2b (I1) — the dirty dot's own clearing path, live, on THIS SAME open document**
            // (not merely a freshly reopened one, which starts clean for a trivial reason and would
            // prove nothing about clearing). The review's own finding: nothing before this task ever
            // asserted a dirty document's flag actually clears after a successful save — only that
            // it could BECOME dirty. LOK's real `.uno:ModifiedStatus=false` callback, routed the
            // identical way `becameDirty` above proved `=true` arrives, is what this waits for.
            let becameCleanAfterSave = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == false }
            XCTAssertTrue(becameCleanAfterSave, "\(fixtureName): dirty never cleared after a "
                          + "successful save on the SAME open document — LOK's own "
                          + "`.uno:ModifiedStatus=false` callback never landed")
            XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, originalDocId, "\(fixtureName): "
                           + "sanity — still the SAME open document, not a reload in disguise")

            runtime.close(docPath)
            XCTAssertNil(runtime.stateSnapshot.documents[docPath], "\(fixtureName): close is synchronous "
                         + "in the reducer's own state — see OfficeRuntimeReducer.closeRequested")

            runtime.open(docPath)
            let reopened = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(reopened, "\(fixtureName): the saved file never reopened — phase: \(runtime.stateSnapshot.phase)")
            guard let reopenedDoc = runtime.stateSnapshot.documents[docPath] else {
                XCTFail("\(fixtureName): reopen failed — the save corrupted the file: "
                        + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
                continue
            }
            XCTAssertEqual(reopenedDoc.type, kind, "\(fixtureName): format preserved — LOK re-parsed "
                           + "the saved bytes as the same document kind")
            XCTAssertNotEqual(reopenedDoc.docId, originalDocId, "sanity: a reopen always mints a fresh docId")
            XCTAssertEqual(reopenedDoc.dirty, false, "\(fixtureName): the reopened document is its own "
                           + "fresh load — clean until something edits it again")

            runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            let paintedAfter = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: reopenedDoc.docId, key: key) != nil }
            XCTAssertTrue(paintedAfter, "\(fixtureName): the post-reopen tile never arrived")
            let pixelsAfter = try XCTUnwrap(runtime.tileStore.tile(docId: reopenedDoc.docId, key: key),
                                            "\(fixtureName)").pixels

            // Same resolved NEEDS_CONTEXT condition as `becameDirty` above — this pixel identity was
            // the other face of the same root cause, not a second bug, and resolved by the same fix.
            XCTAssertNotEqual(pixelsBefore, pixelsAfter, "\(fixtureName): the reopened document's "
                              + "rendered pixels are identical to before the edit — the save round-"
                              + "trip may have persisted the ORIGINAL bytes rather than the edited "
                              + "ones (docId changing and the file's mtime/size changing are both "
                              + "consistent with a no-op save that still touched the inode)")

            runtime.close(docPath)
        }

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **Task 2b fix round 1 (review IMPORTANT-1), live proof, minimal by design** — the unit tests
    /// in `OfficeStageDocumentTests` already prove the STAGED FILE's own permissions/flags are
    /// normalized; this is the one live check that LOK itself treats the result as genuinely
    /// editable, not merely that the bytes on disk look right. Deliberately does not repeat the
    /// tripwire's own save/close/reopen/pixel dance — `becameDirty` alone is what IMPORTANT-1's own
    /// claim is about (a `0444` real document staging into an identically read-only copy would
    /// reproduce Task 2's own `chmod 444` read-only-medium bug, and this is its exact symptom: a
    /// debug edit that mutates the in-memory model but can never flip the modified flag on a
    /// read-only medium).
    func testOpeningADocumentStagedFromAReadOnlySourceStillBecomesEditable() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.ods fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        // The real document — READ-ONLY, per IMPORTANT-1's own scenario, restored to writable in a
        // `defer` so this scratch dir's own teardown can still remove it.
        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("readonly-gate.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: docPath)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: docPath) }

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        let docId = doc.docId

        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive the debug edit door through")
        }
        try await client.debugEdit(docId: docId, text: "T2b-FIX-ROUND-1-READONLY-SOURCE")

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "a document staged from a READ-ONLY real path must still open "
                      + "genuinely writable — IMPORTANT-1's own claim, live")

        runtime.close(docPath)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - office live-gate fix #3: whole-document tile residency's own live proof

    /// A single-sheet flat ODS whose USED RANGE is forced far larger than `gate.xlsx`'s tiny real
    /// content, without emitting one `<table:table-cell>` per cell: `table:number-columns-repeated`/
    /// `table:number-rows-repeated` declare a large block of genuinely empty cells in O(1) XML size
    /// (the same ODF idiom real LibreOffice-authored spreadsheets already use for sparse content —
    /// `officeHarnessMultiSheetFodsContent`'s own `table:number-columns-repeated="4"` is the identical
    /// mechanism at a small scale), and Calc's used-range is the bounding box of every NON-empty cell
    /// — a value in the very first cell and another in the very last is enough to force the whole
    /// block into the reported extent.
    private func officeLiveLargeSheetFodsContent(columns: Int, rows: Int) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
            xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
            xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
            office:version="1.3"
            office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
          <office:body>
            <office:spreadsheet>
              <table:table table:name="T3BigSheet">
                <table:table-column table:number-columns-repeated="\(columns)"/>
                <table:table-row>
                  <table:table-cell office:value-type="string"><text:p>NORMA T3 CORNER</text:p></table:table-cell>
                </table:table-row>
                <table:table-row table:number-rows-repeated="\(max(0, rows - 2))"/>
                <table:table-row>
                  <table:table-cell table:number-columns-repeated="\(max(0, columns - 1))"/>
                  <table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>
                </table:table-row>
              </table:table>
            </office:spreadsheet>
          </office:body>
        </office:document>
        """
    }

    /// **The central live proof.** `gate.xlsx` becomes FULLY resident through the REAL helper and
    /// REAL vendored LibreOffice, then a rapid synthetic swipe in every direction — the same
    /// `applyScrollDelta` sequence a real trackpad tick ultimately drives, mirroring `OfficeHarness
    /// .performRapidScroll9`'s own technique for synthesizing scroll without a live NSEvent — produces
    /// ZERO visible-placeholder draws: the live-gate brief's own bar ("zero placeholders during any
    /// swipe on a resident doc after initial fill"), proven against real pixels and a real connection,
    /// not a fake driver. Also opens a larger generated sheet and proves whichever regime it actually
    /// lands in (resident or lazy-fallback) behaves correctly — the brief's own "and a LARGER
    /// generated sheet" input, adaptive rather than hardcoded to a predicted tile count LOK's own
    /// column/row default metrics are not something this file controls or has previously measured.
    func testGateXlsxBecomesFullyResidentAndPostFillSwipingProducesNoPlaceholders() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let gatePath = Self.fixturesRoot.appendingPathComponent("gate.xlsx").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: gatePath), "gate.xlsx fixture missing at \(gatePath)")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(gatePath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[gatePath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "gate.xlsx never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[gatePath] else {
            return XCTFail("gate.xlsx did not open: "
                           + "\(runtime.stateSnapshot.openFailures[gatePath] ?? "no reason recorded")")
        }
        let docId = doc.docId
        let eligibleCount = officeResidencyEligibleTileCount(sizeTwips: doc.sizeTwips, zoomPPT: 1000,
                                                              cap: OfficeTileStore.residencyCapTiles)
        XCTAssertNotNil(eligibleCount, "this live proof needs gate.xlsx (\(doc.sizeTwips)) to actually "
                        + "qualify for residency — if this ever regresses, the fixture or the cap changed")

        let model = PanelDocumentTabModel(tabId: "t3-live", path: gatePath)
        let canvas = OfficeTileCanvasView(runtime: runtime, path: gatePath, docId: docId,
                                          sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        canvas.frame = NSRect(x: 0, y: 0, width: 400, height: 400)
        let fillStart = Date()
        canvas.mount()

        let issued = await waitUntil(timeout: 60) { canvas.prefetchSweepIssuedForTesting }
        XCTAssertTrue(issued, "the whole-document prefetch sweep must complete")

        let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: doc.sizeTwips.widthTwips, height: doc.sizeTwips.heightTwips)
        let allKeys = TileMath.tileCoordinates(rectTwips: fullExtent, zoomPPT: 1000)
            .map { TileKey(part: 0, zoomPPT: 1000, tileX: $0.tileX, tileY: $0.tileY) }
        let resident = await waitUntil(timeout: 30) { allKeys.allSatisfy { runtime.tileStore.tile(docId: docId, key: $0) != nil } }
        let fillMs = Date().timeIntervalSince(fillStart) * 1000
        XCTAssertTrue(resident, "every tile in the full extent must actually be cached, not merely "
                      + "requested (\(allKeys.filter { runtime.tileStore.tile(docId: docId, key: $0) == nil }.count) still missing)")
        for key in allKeys {
            guard let entry = runtime.tileStore.tile(docId: docId, key: key) else { continue }
            XCTAssertEqual(entry.pixels.count, TileMath.bytesPerTile, "\(key): a whole tile's bytes")
            XCTAssertTrue(entry.pixels.contains { $0 != 0 }, "\(key): real paint, not an untouched buffer")
        }
        // Printed, not asserted — the live-gate brief's own "time-to-full-residency" MEASURE number.
        print("[office live-gate fix #3] gate.xlsx: \(allKeys.count) tile(s) resident in \(Int(fillMs))ms")

        // --- swipe hard in every direction; zero placeholder draws is the brief's own bar. ---
        let placeholdersBeforeSwipe = canvas.visiblePlaceholderDrawCountForTesting
        for _ in 0..<10 { canvas.applyScrollDelta(dx: -40, dy: -40) } // toward the far corner
        for _ in 0..<10 { canvas.applyScrollDelta(dx: 40, dy: 40) }   // back toward the origin
        for _ in 0..<10 { canvas.applyScrollDelta(dx: 40, dy: -40) }  // the other diagonal
        for _ in 0..<10 { canvas.applyScrollDelta(dx: -40, dy: 40) }
        try? await Task.sleep(nanoseconds: 300_000_000) // let a wrongly-issued ask have time to appear
        XCTAssertEqual(canvas.visiblePlaceholderDrawCountForTesting, placeholdersBeforeSwipe,
                       "zero placeholder frames during any swipe on a resident doc — the live-gate's own bar")

        canvas.unmount()

        // --- the brief's own "and a LARGER generated sheet": adaptive to whichever regime the
        // synthesized content actually lands in, since this file has no prior live measurement of
        // real LOK's default column-width/row-height metrics to predict an exact tile count from. ---
        let bigPath = makeScratchDirectory().appendingPathComponent("t3-big.fods").path
        try officeLiveLargeSheetFodsContent(columns: 100, rows: 100).write(toFile: bigPath, atomically: true, encoding: .utf8)
        runtime.open(bigPath)
        let bigSettled = await waitUntil(timeout: 60) {
            runtime.stateSnapshot.documents[bigPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bigSettled, "the larger generated sheet never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let bigDoc = runtime.stateSnapshot.documents[bigPath] else {
            return XCTFail("the larger generated sheet did not open: "
                           + "\(runtime.stateSnapshot.openFailures[bigPath] ?? "no reason recorded")")
        }
        let bigEligible = officeResidencyEligibleTileCount(sizeTwips: bigDoc.sizeTwips, zoomPPT: 1000,
                                                            cap: OfficeTileStore.residencyCapTiles)
        print("[office live-gate fix #3] larger sheet: \(bigDoc.sizeTwips), eligible tile count = "
              + "\(bigEligible.map(String.init) ?? "nil (ineligible — lazy fallback)")")

        let bigModel = PanelDocumentTabModel(tabId: "t3-live-big", path: bigPath)
        let bigCanvas = OfficeTileCanvasView(runtime: runtime, path: bigPath, docId: bigDoc.docId,
                                             sizeTwips: bigDoc.sizeTwips, initialPart: 0, model: bigModel)
        bigCanvas.frame = NSRect(x: 0, y: 0, width: 400, height: 400)
        bigCanvas.mount()

        if let bigEligible, bigEligible > 0 {
            // Eligible: the same whole-extent residency proof as gate.xlsx above. `bigIssued` alone
            // (measured directly, first attempt: proved genuinely NOT enough — see the git history
            // around this comment) only means every chunk's REQUEST was sent, not that its pixels have
            // actually ARRIVED and are cached (`prefetchSweepIssuedForTesting`'s own doc, verbatim);
            // swiping the instant requests finish, before the last chunk's `onTile` pushes land, can
            // still draw a handful of genuine placeholders — an honest race in THIS TEST's own
            // measurement window, not evidence against the feature. Waiting for actual cache
            // completeness before swiping is what makes the placeholder count below mean what it
            // claims to mean.
            let bigIssued = await waitUntil(timeout: 90) { bigCanvas.prefetchSweepIssuedForTesting }
            XCTAssertTrue(bigIssued, "the larger sheet's own whole-document sweep must complete")
            let bigFullExtent = OfficeTwipsRect(x: 0, y: 0, width: bigDoc.sizeTwips.widthTwips, height: bigDoc.sizeTwips.heightTwips)
            let bigAllKeys = TileMath.tileCoordinates(rectTwips: bigFullExtent, zoomPPT: 1000)
                .map { TileKey(part: 0, zoomPPT: 1000, tileX: $0.tileX, tileY: $0.tileY) }
            let bigResident = await waitUntil(timeout: 60) {
                bigAllKeys.allSatisfy { runtime.tileStore.tile(docId: bigDoc.docId, key: $0) != nil }
            }
            XCTAssertTrue(bigResident, "every tile in the larger sheet's extent must actually be cached "
                          + "before the swipe measurement below means anything "
                          + "(\(bigAllKeys.filter { runtime.tileStore.tile(docId: bigDoc.docId, key: $0) == nil }.count) still missing)")
        } else {
            // Ineligible (or LOK reported a genuinely empty sheet, `0` — either way, not "resident
            // with a real sweep"): the ORIGINAL viewport+margin lazy path must still work, unchanged
            // — the actual claim this half of the test exists to prove.
            let bigViewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 400, height: 400), zoomPPT: 1000)
            let bigExpectedKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: bigViewport)
            if !bigExpectedKeys.isEmpty {
                let bigLazyFilled = await waitUntil(timeout: 30) {
                    bigExpectedKeys.allSatisfy { runtime.tileStore.tile(docId: bigDoc.docId, key: $0) != nil }
                }
                XCTAssertTrue(bigLazyFilled, "an ineligible document must still fill its own viewport "
                              + "through the unchanged lazy path")
            }
            XCTAssertFalse(bigCanvas.prefetchSweepIssuedForTesting, "an ineligible document must never "
                           + "report a completed whole-document sweep")
        }

        // --- the churn-audit's own before/after instrument, run regardless of which regime this
        // document landed in: a FAR, fast swipe (the document is ~6375pt wide at 100% zoom; this
        // covers most of it in a handful of ticks — deliberately far enough to outrun a single
        // viewport+margin ask, the exact "fast swipes outrun the requests" report this whole task
        // answers) — printed, not asserted here, so this same test remains meaningful with
        // `OfficeTileStore.residencyCapTiles` temporarily forced to 0 for a genuine before/after
        // comparison against the SAME instrument in the SAME binary (only the swap-and-rebuild is
        // manual; nothing here hardcodes an expectation tied to one or the other).
        let bigPlaceholdersBeforeSwipe = bigCanvas.visiblePlaceholderDrawCountForTesting
        for _ in 0..<20 { bigCanvas.applyScrollDelta(dx: -300, dy: -60) }
        try? await Task.sleep(nanoseconds: 300_000_000)
        for _ in 0..<20 { bigCanvas.applyScrollDelta(dx: 300, dy: 60) }
        try? await Task.sleep(nanoseconds: 300_000_000)
        let bigPlaceholderDelta = bigCanvas.visiblePlaceholderDrawCountForTesting - bigPlaceholdersBeforeSwipe
        print("[office live-gate fix #3] larger sheet far/fast swipe: \(bigPlaceholderDelta) placeholder "
              + "draw(s) (cap=\(OfficeTileStore.residencyCapTiles), eligible=\(bigEligible.map(String.init) ?? "nil"))")

        bigCanvas.unmount()
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - office-plumbing Task 8's own live drill (dispatch-ordered into this task, not T9 —
    // see the task report's own note on the brief-vs-dispatch discrepancy)

    /// Builds a byte-DIFFERENT but still valid xlsx from `source`: unzips it, changes the visible
    /// text in `xl/sharedStrings.xml` (the ONLY part this touches — every other member of the OOXML
    /// package, including the cell-to-shared-string INDEX references in `xl/worksheets/sheet1.xml`,
    /// is untouched, so this cannot corrupt the package's own internal cross-references), and rezips
    /// it. Shells out to `/usr/bin/unzip`/`/usr/bin/zip` — both standard, always-present macOS tools
    /// — rather than hand-rolling a zip writer for one test fixture. `-D` (no directory entries) +
    /// `-X` (no extra attributes) keeps the rezipped archive structurally close to the original
    /// (hand-verified: identical 10-file listing against `gate.xlsx` itself).
    private func makeModifiedXlsx(from source: URL, at destination: URL) throws {
        let extractDir = destination.deletingLastPathComponent()
            .appendingPathComponent("extracted-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runTool("/usr/bin/unzip", ["-o", "-q", source.path, "-d", extractDir.path])

        let sharedStrings = extractDir.appendingPathComponent("xl/sharedStrings.xml")
        let original = try String(contentsOf: sharedStrings, encoding: .utf8)
        let modified = original.replacingOccurrences(of: "NORMA GATE", with: "NORMA GATE RELOADED")
        precondition(modified != original, "the fixture's own known text — see OfficeHelperLiveTests' "
                     + "Expectation table — must be present to edit; if gate.xlsx's content ever "
                     + "changes, this string needs to change with it")
        try modified.write(to: sharedStrings, atomically: true, encoding: .utf8)

        try? FileManager.default.removeItem(at: destination)
        try runTool("/usr/bin/zip", ["-X", "-D", "-r", "-q", destination.path, "."], currentDirectory: extractDir)
    }

    private func runTool(_ launchPath: String, _ arguments: [String], currentDirectory: URL? = nil) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "OfficeRuntimeLiveTests", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "\(launchPath) \(arguments) exited \(process.terminationStatus)"
            ])
        }
    }

    /// **Office Stage A Task 8's exit gate.** Every claim the task makes, against the REAL helper,
    /// the REAL vendored LibreOffice and a REAL (windowless — `OfficeTileCanvasViewTests`' own
    /// precedent: `bounds`/`frame` answer regardless of window membership) canvas:
    ///
    /// 1. an external overwrite of the open file produces a NEW docId (never the same one);
    /// 2. the OLD docId's tiles are evicted, not merely left stale;
    /// 3. FRESH, genuinely non-blank pixels arrive under the NEW docId;
    /// 4. the canvas itself follows the reload (T6 review F4 — the whole reason this needed a fix at
    ///    all: without it, every tile after a reload is a permanent placeholder);
    /// 5. `{scrollTwips, zoomPPT}` — established at NON-default values before the overwrite — survive
    ///    the reload untouched;
    /// 6. the helper PROCESS itself never restarts (a close+reopen on the same process, never a
    ///    supervisor-level relaunch masquerading as one);
    /// 7. deleting the file afterward raises the persistent banner and changes NOTHING else — the
    ///    open document entry, and the canvas's own docId, are exactly what they were the instant
    ///    before the delete.
    func testExternalOverwriteReloadsPreservingViewStateThenDeletionBanners() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let gateURL = Self.fixturesRoot.appendingPathComponent("gate.xlsx")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: gateURL.path), "gate.xlsx fixture missing at \(gateURL.path)")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        // **The second-copy dance, doubled**: the OPEN itself is against a scratch COPY of
        // gate.xlsx, never the committed fixture — the external "overwrite" this drill performs
        // must not touch anything this branch tracks in git.
        let scratchDoc = makeScratchDirectory().appendingPathComponent("gate.xlsx")
        try FileManager.default.copyItem(at: gateURL, to: scratchDoc)
        let openPath = scratchDoc.path

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(openPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[openPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "gate.xlsx never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[openPath] else {
            return XCTFail("gate.xlsx did not open: "
                           + "\(runtime.stateSnapshot.openFailures[openPath] ?? "no reason recorded")")
        }
        let originalDocId = doc.docId
        // T8 fix-round review I2: captured HERE, right after the first open settles and before any
        // reload runs, so step (6) below can compare against it rather than re-deriving a pid that
        // would only prove liveness, not identity — see that step's own comment.
        guard let originalHelperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
            return XCTFail("supervisor has no live process right after the first open")
        }

        // --- Fresh-tile proof, at a FIXED zoom driven straight through the runtime — kept
        // independent of the canvas below so a canvas left at a different zoom by the view-state
        // section can never make this half of the drill flaky. ---
        let zoomPPT1000 = 1000
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512),
                                           zoomPPT: zoomPPT1000)
        let expectedKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT1000, viewportTwips: viewport)
        XCTAssertFalse(expectedKeys.isEmpty, "gate.xlsx must cover at least one tile at 100%")
        runtime.subscribeTiles(path: openPath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: viewport)
        let coldFilled = await waitUntil(timeout: 30) {
            expectedKeys.allSatisfy { runtime.tileStore.tile(docId: originalDocId, key: $0) != nil }
        }
        XCTAssertTrue(coldFilled, "cold fill never completed before the external change")

        // --- A real, windowless canvas — built by hand, not by SwiftUI (T6's own disclosed gap,
        // "no live test composes the full UI chain against the real helper," STANDS; this proves the
        // canvas against REAL reload output, not the full `OfficeTileCanvasRepresentable`/
        // `updateNSView` chain, which stays offline-only per this house's standing posture toward
        // every viewport in the panel). Non-default zoom/scroll established through the SAME
        // `applyZoom`/clamp path production code uses (`setZoomForTesting`/`setScrollOriginForTesting`),
        // never a hand-rolled shortcut; `syncDocumentIdentity` — the method `updateNSView` calls — is
        // invoked explicitly below, once the reload's real docId/sizeTwips/activePart are known,
        // standing in for the SwiftUI render pass this harness does not drive. ---
        let model = PanelDocumentTabModel(tabId: "live-t8", path: openPath)
        let canvas = OfficeTileCanvasView(runtime: runtime, path: openPath, docId: originalDocId,
                                          sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        canvas.frame = NSRect(x: 0, y: 0, width: 300, height: 300)
        canvas.mount()
        XCTAssertTrue(canvas.setZoomForTesting(2000), "gate.xlsx's own real size must accept a "
                      + "200% zoom without the ladder refusing it")
        canvas.setScrollOriginForTesting(CGPoint(x: 20, y: 15))
        let establishedZoom = canvas.zoomPPT
        let establishedScroll = canvas.scrollOriginForTesting
        XCTAssertEqual(establishedZoom, 2000, "sanity")
        XCTAssertGreaterThan(establishedScroll.x, 0, "sanity: the scroll was not immediately "
                             + "clamped back to zero by too small a real document")

        // --- The external change: an agent (or you) overwrites the open file with different,
        // still-valid content while the tab sits open. ---
        let modifiedURL = makeScratchDirectory().appendingPathComponent("modified.xlsx")
        try makeModifiedXlsx(from: gateURL, at: modifiedURL)
        try FileManager.default.removeItem(at: scratchDoc)
        try FileManager.default.copyItem(at: modifiedURL, to: scratchDoc)

        // --- Reload: (1) a NEW docId ... ---
        let reloaded = await waitUntil(timeout: 30) {
            runtime.stateSnapshot.documents[openPath] != nil
                && runtime.stateSnapshot.documents[openPath]?.docId != originalDocId
        }
        XCTAssertTrue(reloaded, "the external overwrite must produce a new docId within 30s — got "
                      + "\(runtime.stateSnapshot.documents[openPath]?.docId ?? "no document"), "
                      + "banner: \(runtime.stateSnapshot.documentBanners[openPath] ?? "none")")
        let newDocId = try XCTUnwrap(runtime.stateSnapshot.documents[openPath]?.docId)
        XCTAssertNotEqual(newDocId, originalDocId)

        // --- (2) the old docId's tiles are EVICTED, not merely superseded ... ---
        let oldEvicted = await waitUntil(timeout: 5) {
            expectedKeys.allSatisfy { runtime.tileStore.tile(docId: originalDocId, key: $0) == nil }
        }
        XCTAssertTrue(oldEvicted, "the old docId's tile-store entries must be gone after the reload")

        // --- (3) FRESH, non-blank pixels arrive under the NEW docId ... ---
        runtime.subscribeTiles(path: openPath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: viewport)
        let freshFilled = await waitUntil(timeout: 30) {
            expectedKeys.allSatisfy { runtime.tileStore.tile(docId: newDocId, key: $0) != nil }
        }
        XCTAssertTrue(freshFilled, "fresh tiles never arrived under the new docId "
                      + "(\(expectedKeys.filter { runtime.tileStore.tile(docId: newDocId, key: $0) == nil }.count) still missing)")
        for key in expectedKeys {
            guard let entry = runtime.tileStore.tile(docId: newDocId, key: key) else { continue }
            XCTAssertEqual(entry.pixels.count, TileMath.bytesPerTile, "\(key): a whole tile's bytes")
            XCTAssertTrue(entry.pixels.contains { $0 != 0 }, "\(key): real paint, not an untouched buffer")
        }

        // --- (4) the canvas follows the reload (T6 review F4) ... ---
        // **This canvas was built by hand, not by SwiftUI** (this test's own header: proving the
        // real-data half of F4, `OfficeTileCanvasViewTests` proves the plumbing half with a fake
        // driver) — nothing here is `OfficeTileCanvasRepresentable`, so nothing calls `updateNSView`
        // on its own. In the real app THAT call is what carries `documents[path]`'s fresh docId/
        // sizeTwips/activePart into `syncDocumentIdentity` on every render; simulating exactly that
        // one call is what proves this canvas, driven against REAL reload output rather than a
        // recorder's synthetic metadata, ends up in the same place `OfficeTileCanvasViewTests`
        // already proves in isolation.
        let newDoc = try XCTUnwrap(runtime.stateSnapshot.documents[openPath])
        canvas.syncDocumentIdentity(docId: newDoc.docId, sizeTwips: newDoc.sizeTwips, activePart: newDoc.activePart)
        XCTAssertEqual(canvas.docId, newDocId, "T6 review F4: the canvas must track the reload's new "
                       + "docId, never strand on the dead one — every tile would otherwise be a "
                       + "permanent placeholder")

        // --- (5) {zoomPPT, scrollTwips} survived, untouched ... ---
        XCTAssertEqual(canvas.zoomPPT, establishedZoom, "zoom must survive the reload")
        XCTAssertEqual(canvas.scrollOriginForTesting, establishedScroll, "scroll must survive the "
                       + "reload — gate.xlsx's real size is unchanged by this task's text-only edit, "
                       + "so the re-clamp obligation 3 requires is a true no-op here")

        // --- (6) the same helper PROCESS throughout — this was a close+reopen, never a restart. ---
        // T8 fix-round review I2: capturing a pid HERE, after the reload, and merely asserting it is
        // ALIVE proves liveness, not identity — a supervisor restart would hand back a live pid too,
        // just a different one, and this check would have passed either way. `originalHelperPID` was
        // captured once, right after the FIRST open settled, before any reload ran; comparing against
        // it (never re-deriving "the answer" from the post-reload state) is what actually proves this
        // was a close+reopen against the SAME process, never a restart.
        guard let helperPIDAfterReload = host.officeHelperSupervisor?.process?.processIdentifier else {
            return XCTFail("supervisor has no live process to check")
        }
        XCTAssertTrue(isProcessAlive(helperPIDAfterReload), "the helper process must still be "
                      + "running after the reload")
        XCTAssertEqual(helperPIDAfterReload, originalHelperPID, "the reload must not have gone "
                       + "through a supervisor restart — the helper process identity itself must be "
                       + "unchanged, not merely some process being alive")

        // --- (7) deletion: a persistent banner, and NOTHING else changes. ---
        try FileManager.default.removeItem(at: scratchDoc)
        let bannered = await waitUntil(timeout: 5) { runtime.stateSnapshot.documentBanners[openPath] != nil }
        XCTAssertTrue(bannered, "deleting the open file must raise the banner")
        XCTAssertEqual(runtime.stateSnapshot.documentBanners[openPath], "File was deleted on disk")
        XCTAssertEqual(runtime.stateSnapshot.documents[openPath]?.docId, newDocId, "view-only, "
                       + "nothing to lose — deletion must not touch the open document entry at all")
        XCTAssertEqual(canvas.docId, newDocId, "the canvas keeps showing its last-good frame")

        canvas.unmount()
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }
}
