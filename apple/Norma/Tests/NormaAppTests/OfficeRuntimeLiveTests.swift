import XCTest
import AppKit
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
    // MARK: - Office Stage B Task 4: the typing drill — the REAL production path, not the wire client

    /// **The typing drill.** Every criteria-1-through-4 live test in `OfficeHelperLiveTests.swift`
    /// drives the wire directly (`OfficeHelperClient.postKey`/`postMouse`) — proof that the
    /// helper/store/multicast machinery is correct, but NOT proof that `OfficeTileCanvasView`'s own
    /// `keyDown`/`mouseDown` ever actually reach it. This test is that proof: a REAL
    /// `OfficeTileCanvasView`, mounted against a REAL `OfficeRuntime` wired to the REAL supervisor+
    /// helper (`ShellSessionHost`'s own production wiring — the same posture every other test in
    /// this file already takes), fed SYNTHETIC but real `NSEvent`s through its actual overrides —
    /// `NSEvent.mouseEvent`/`.keyEvent` are genuine AppKit factory methods (unlike `.scrollWheel`,
    /// which `OfficeTileCanvasView`'s own `setScrollOriginForTesting` comment notes has none — key
    /// and mouse button events are not in that same boat).
    ///
    /// The full path this exercises, start to finish: a synthetic `NSEvent` -> `OfficeInputCodes`
    /// (the AppKit->LOK encoding) -> `OfficeTileCanvasView.forwardMouseEvent`/`forwardKeyEvent` ->
    /// `OfficeRuntime.postMouseEvent`/`postKeyEvent` (the input-ordering chain) -> the Driver ->
    /// `OfficeHelperClient` -> the wire -> `LOKBridge` -> REAL LOK -> a real callback ->
    /// `OfficeHelperServer`'s multicast -> the wire -> `OfficeWireConnection`/`OfficeHelperClient` ->
    /// `ShellSessionHost.wireOfficeTileCallbacks` -> `OfficeTileStore.invalidate` -> `tilesArrived`
    /// -> `OfficeTileCanvasView.handleTilesArrived` -> `OfficeRuntime.refetchInvalidatedTiles` (the
    /// fix this same task made — without it, this drill would never see a fresh tile at all, since
    /// nothing else re-subscribes on a static viewport) -> a fresh `.tile` push -> `ingest` -> a
    /// DIFFERENT `CGImage` at the caret's own tile. Pixel-diffed at the end, not merely "an event
    /// fired somewhere."
    func testTheTypingDrillARealKeyDownThroughTheRealCanvasViewReachesLOKAndTheCaretTileRepaints() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
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

        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("typing-drill-gate.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }

        let model = PanelDocumentTabModel(tabId: "typing-drill", path: docPath)
        let view = OfficeTileCanvasView(runtime: runtime, path: docPath, docId: doc.docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let zoomPPT = 1000
        let originKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let baselineArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: originKey) != nil }
        XCTAssertTrue(baselineArrived, "the drill's own baseline (pre-typing) tile never arrived")
        let pixelsBefore = try XCTUnwrap(runtime.tileStore.tile(docId: doc.docId, key: originKey), "baseline").pixels

        // A view-local click point of (10, 10) points -> twips (200, 200) at zoomPPT 1000
        // (officePointToTwips's own unit chain) — inside A1's own real bounding rect (observed live,
        // in the criteria-1-4 tests, as roughly x:[0,1265) y:[0,254) twips) and inside the origin
        // tile this drill watches. `NSEvent.mouseEvent`/`.keyEvent` are genuine AppKit factories —
        // unlike `.scrollWheel`, there is nothing synthetic-unfriendly about these two event types.
        // **Live-test-caught correction**: `NSView.convert(_:from:nil)` — what `forwardMouseEvent`
        // actually calls — is only well-defined once the view has a REAL window (`self.window !=
        // nil`); a first attempt at this drill left the view window-less and reached WILDLY wrong
        // twips (a real firing at y≈9930-13005, roughly two tile-rows below A1, not the intended
        // click point at all) — never a crash, just silently the wrong cell, so the ONLY tell was
        // the caret-region tile this drill watches never repainting (a genuinely different, real
        // edit landed two tiles away instead). A real (never-ordered-front, invisible — this
        // process's own window list stays empty for `HarnessQuietTests`' own "nothing shown at full
        // opacity" check) `NSWindow` fixes this, AND `view.convert(_:to:nil)` — the SAME conversion
        // `forwardMouseEvent` will later invert — is used to compute the event's own `location`
        // rather than hand-guessing window-base coordinates, so this drill stays correct regardless
        // of this window's exact geometry.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view
        let clickPoint = NSPoint(x: 10, y: 10) // view-bounds space — inside the origin tile (0,0)
        let windowClickPoint = view.convert(clickPoint, to: nil)
        func makeMouseEvent(_ type: NSEvent.EventType) -> NSEvent {
            try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: windowClickPoint, modifierFlags: [],
                                              timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                              eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false,
                                            keyCode: keyCode))
        }

        view.mouseDown(with: makeMouseEvent(.leftMouseDown))
        view.mouseUp(with: makeMouseEvent(.leftMouseUp))
        // 'Z' — AppKit physical keyCode 6 (verified in `OfficeInputCodesTests`), a letter this
        // fixture's own A1 seed content ("NORMA GATE") does not already contain, so a successful
        // insertion is unambiguously this drill's own doing, not a coincidence of existing content.
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "Z", keyCode: 6))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "Z", keyCode: 6))
        // Return — commits the pending cell edit (Calc's own semantics; the criteria-1-4 live test's
        // own header names why an uncommitted edit is the wrong note to end a typing sequence on).
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\r", keyCode: 36))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\r", keyCode: 36))

        // The input-ordering chain (`OfficeRuntime.postKeyEvent`'s own header) means every post
        // above is already ENQUEUED synchronously by the time `keyUp` returns — this only awaits
        // their actual delivery to the driver, not merely their having been queued.
        await runtime.drainInputChainForTesting()

        let repainted = await waitUntil(timeout: 30) {
            guard let entry = runtime.tileStore.tile(docId: doc.docId, key: originKey) else { return false }
            return entry.pixels != pixelsBefore
        }
        XCTAssertTrue(repainted, "the typing drill's own caret-region tile never showed a different pixel "
                      + "hash — key -> LOK -> invalidation -> a fresh tile is the thing this test exists "
                      + "to prove, start to finish, through the REAL keyDown/mouseDown overrides")

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "a real typed character must also mark the document dirty, through the "
                      + "SAME ModifiedStatus wire this task's own migrated tripwire depends on")

        view.unmount()
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 1, F2 (CRITICAL) — **the two-part live drill.** Reads `content.xml` out of a real
    /// saved `.ods` via `/usr/bin/unzip -p`, the same "shell out to a well-understood system tool
    /// rather than reimplement it" precedent `OfficeEmbedLayoutTests`' own symlink check already
    /// uses for `find`. Slices the flat XML by sheet name (`<table:table table:name="..."` to the
    /// next `</table:table>`) — sheets never nest in ODF, so a simple substring search between two
    /// markers is exact, not a heuristic, for this fixture.
    private func readODFContentXML(atPath path: String) throws -> String {
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        unzip.arguments = ["-p", path, "content.xml"]
        let pipe = Pipe()
        unzip.standardOutput = pipe
        try unzip.run()
        unzip.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return try XCTUnwrap(String(data: data, encoding: .utf8), "content.xml was not valid UTF-8")
    }

    /// `nil` if `sheetName` is not present at all — a real failure mode this drill wants to FAIL
    /// loudly on (a two-sheet fixture that reopens with only one sheet is not "sheet 1 unchanged,"
    /// it is a corrupted save), never silently treated as "nothing to check."
    private func extractTableXML(_ content: String, sheetName: String) -> String? {
        let marker = "<table:table table:name=\"\(sheetName)\""
        guard let start = content.range(of: marker) else { return nil }
        guard let end = content.range(of: "</table:table>", range: start.upperBound..<content.endIndex) else { return nil }
        return String(content[start.lowerBound..<end.upperBound])
    }

    /// Fix round 1, F2 (CRITICAL) — **input is now part-scoped; this is the live proof.** Before
    /// this fix, `postKeyEvent`/`postMouseEvent` carried no part at all — a keystroke posted while
    /// viewing sheet 2 silently landed wherever LOK's own internal "current part" happened to be
    /// (never communicated over this wire, and never necessarily sheet 2), persisted by save, with
    /// no visible repaint to notice by. Drives through the REAL `OfficeTileCanvasView` (`view
    /// .mouseDown`/`.keyDown`, exactly like `testTheTypingDrillARealKeyDownThroughTheRealCanvasView
    /// ReachesLOKAndTheCaretTileRepaints` right above) rather than a raw wire client — a raw
    /// `client.postKey`/`postMouse` call bypasses `OfficeRuntime.postKeyEvent`'s own `activePart`
    /// read entirely (it takes `part` as an explicit caller-supplied argument, always `0` in every
    /// OTHER live test in this file), which is exactly the code path this fix lives in and a
    /// wire-level-only test would never actually exercise.
    func testTypingOnSheetTwoLandsOnSheetTwoNotSheetOneThroughSaveAndReopen() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("two-sheet.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "two-sheet.ods fixture missing")

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

        // A WRITABLE copy — the checked-in Fixtures directory is never itself a save target (same
        // discipline every other live test in this file already follows).
        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("two-part-drill.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.parts, 2, "setup: the fixture's own two <table:table> elements — if this "
                       + "fails, the hand-built fixture itself is the problem, not F2's fix")

        // initialPart: 1 -- sheet 2 (0-indexed) is the ACTIVE part from the very first
        // `subscribeTiles` call `mount()` fires (`performSubscribe`'s own `runtime.subscribeTiles
        // (path:part: part, ...)` call, using `self.part` from `initialPart`) — this is what sets
        // `state.documents[docPath].activePart = 1`, the value F2's fix reads at keystroke time.
        let model = PanelDocumentTabModel(tabId: "two-part-drill", path: docPath)
        let view = OfficeTileCanvasView(runtime: runtime, path: docPath, docId: doc.docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 1, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let zoomPPT = 1000
        let originKeyPart1 = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let baselineArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: originKeyPart1) != nil }
        XCTAssertTrue(baselineArrived, "sheet 2's own baseline (pre-typing) tile never arrived — setup")

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view
        // Same view-local click point the single-part typing drill already proved lands inside A1's
        // real bounding rect (200, 200 twips at zoomPPT 1000) — this fixture's Sheet2 clones Sheet1's
        // own column/row geometry verbatim (see two-sheet.ods's own provenance in this task's report),
        // so the same point lands on Sheet2's A1 too.
        let clickPoint = NSPoint(x: 10, y: 10)
        let windowClickPoint = view.convert(clickPoint, to: nil)
        func makeMouseEvent(_ type: NSEvent.EventType) -> NSEvent {
            try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: windowClickPoint, modifierFlags: [],
                                              timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                              eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false,
                                            keyCode: keyCode))
        }

        view.mouseDown(with: makeMouseEvent(.leftMouseDown))
        view.mouseUp(with: makeMouseEvent(.leftMouseUp))
        // "T4EDIT" — the SAME marker string and AppKit-keyCode table `postRealEdit` below uses (real
        // physical keyCodes this time, since `forwardKeyEvent` runs these through `OfficeInputCodes`,
        // not a hand-picked `com.sun.star.awt.Key` value): T=17, 4=21, E=14, D=2, I=34 (verified in
        // `OfficeInputCodesTests`).
        let marker = "T4EDIT"
        let physicalKeyCodes: [Character: UInt16] = ["T": 17, "4": 21, "E": 14, "D": 2, "I": 34]
        for character in marker {
            let keyCode = try XCTUnwrap(physicalKeyCodes[character])
            let characters = String(character)
            view.keyDown(with: makeKeyEvent(.keyDown, characters: characters, keyCode: keyCode))
            view.keyUp(with: makeKeyEvent(.keyUp, characters: characters, keyCode: keyCode))
        }
        // Return — commits the pending cell edit.
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\r", keyCode: 36))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\r", keyCode: 36))

        await runtime.drainInputChainForTesting()

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "the real edit's own ModifiedStatus callback never landed")

        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "the save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner")

        // The direct proof: read the SAVED file's own XML back, off disk — not the in-memory model,
        // which cannot distinguish "landed on the right part" from "landed on some part."
        let content = try readODFContentXML(atPath: docPath)
        let sheet1XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet1"), "Sheet1 must still exist")
        let sheet2XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet2"), "Sheet2 must still exist")
        XCTAssertTrue(sheet2XML.contains(marker), "the typed marker must appear on SHEET 2 — this is "
                      + "F2's fix: input now carries the SAME part the viewport was showing")
        XCTAssertFalse(sheet1XML.contains(marker), "the typed marker must NOT leak onto sheet 1 — "
                      + "the pre-fix failure mode this drill exists to close")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "sheet 1's own original seed content must be "
                      + "completely untouched, not merely marker-free")

        view.unmount()
        runtime.close(docPath)
        XCTAssertNil(runtime.stateSnapshot.documents[docPath], "close is synchronous in the reducer's own state")

        // Reopen — the round-trip half: the saved file is still a genuinely valid two-part document,
        // not merely a file that happens to contain the right string somewhere.
        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the saved file never reopened — phase: \(runtime.stateSnapshot.phase)")
        guard let reopenedDoc = runtime.stateSnapshot.documents[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("reopen failed — the save corrupted the file: "
                    + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        XCTAssertEqual(reopenedDoc.parts, 2, "the saved file is still genuinely two-part after reopening")

        runtime.close(docPath)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 2 (CRITICAL) — **the two-DOCUMENT live drill.** Fix round 1's own two-PART drill
    /// (immediately above) proved input carries the right part — but with only ONE document ever
    /// open in that drill, it could not see LOK's OWN hazard: `setPart` (Calc's own
    /// `ScModelObj::setPart`, confirmed by reading `sc/source/ui/unoobj/docuno.cxx` directly) resolves
    /// through `ScDocShell::GetViewData()` — a PROCESS-GLOBAL "current view," not `pThis`'s own
    /// document handle — while `postKeyEvent`/`postMouseEvent`/`paintTile` all correctly resolve via
    /// the per-instance `pDocShell->GetBestViewShell()`. Norma's helper holds MANY documents open in
    /// ONE process and never called LOK's view-management API at all (`createView`/`setView` never
    /// appeared anywhere in `LOKBridge` before this fix) — so with two documents open, typing into
    /// the NON-current one silently mutated the OTHER document's active part instead of the target's,
    /// exactly F2's original symptom, now with a second document as an innocent bystander.
    ///
    /// This drill opens A (`two-sheet.ods`) then B (`two-sheet.ods`, a second copy) — B LAST, so B's
    /// view is LOK's own process-global "current" one at load time (`documentLoad`'s own
    /// create-a-view-per-load semantics, confirmed by reading `desktop/source/lib/init.cxx`'s
    /// `doc_createView`/`SfxLokHelper::createView`) — then proves THREE things while B stays current
    /// throughout: (1) **paint** — `paintPartTile` on A's part 0 and part 1 must render genuinely
    /// DIFFERENT pixels (the pre-fix bug's signature: A's own view never actually moves, since the
    /// mutation silently lands on B instead, so every part request for A renders the SAME frozen
    /// content); (2) **input** — a real keystroke typed into A's sheet 2 lands on SHEET 2, exactly
    /// like the single-document drill above, but now proven safe with a genuine second document
    /// competing for "current"; (3) **B is untouched** — B's own dirty flag never flips and B's own
    /// part/content survive completely undisturbed by anything done to A.
    func testTypingOnDocumentASheetTwoIsUnaffectedByDocumentBBeingTheMostRecentlyLoadedCurrentView() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("two-sheet.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "two-sheet.ods fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        // ONE runtime/supervisor/helper — the multi-document-in-one-process shape the bug requires.
        let runtime = host.officeRuntime(for: "S1")

        let scratchDir = makeScratchDirectory()
        let pathA = scratchDir.appendingPathComponent("doc-a-two-part-drill.ods").path
        let pathB = scratchDir.appendingPathComponent("doc-b-most-recent.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: pathA))
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: pathB))

        // A first.
        runtime.open(pathA)
        let aSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathA] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(aSettled, "A never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docA = runtime.stateSnapshot.documents[pathA] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("A did not open: \(runtime.stateSnapshot.openFailures[pathA] ?? "no reason recorded")")
        }
        XCTAssertEqual(docA.parts, 2, "setup: A is the same two-sheet fixture as the single-document drill")

        // B LAST — B's view becomes LOK's own process-global "current" one at load time.
        runtime.open(pathB)
        let bSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bSettled, "B never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docB = runtime.stateSnapshot.documents[pathB] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("B did not open: \(runtime.stateSnapshot.openFailures[pathB] ?? "no reason recorded")")
        }
        XCTAssertEqual(docB.parts, 2, "setup: B is the same two-sheet fixture as A")

        // (1) THE PAINT DETECTOR — while B is current, A's part 0 and part 1 tiles must render
        // genuinely different pixels. The pre-fix bug's signature: `paintPartTile(A, part: 1)`'s own
        // `doc_setPartImpl` mutates whichever view is GLOBALLY current (B's), never A's own — so A's
        // view stays frozen at part 0 for BOTH requests, and the two tiles come back byte-identical.
        let zoomPPT = 1000
        let aPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let aPart1Key = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)

        runtime.subscribeTiles(path: pathA, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let aPart0Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aPart0Key) != nil }
        XCTAssertTrue(aPart0Arrived, "A's part 0 tile never arrived, with B current")
        let aPart0Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: aPart0Key), "A part 0").pixels

        runtime.subscribeTiles(path: pathA, part: 1, zoomPPT: zoomPPT, viewportTwips: viewport)
        let aPart1Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aPart1Key) != nil }
        XCTAssertTrue(aPart1Arrived, "A's part 1 tile never arrived, with B current")
        let aPart1Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: aPart1Key), "A part 1").pixels

        XCTAssertNotEqual(aPart0Pixels, aPart1Pixels, "A's part 0 and part 1 tiles rendered IDENTICAL "
                          + "pixels while B was the process-global current view — this is paintPartTile's "
                          + "own cross-document hazard: A's own view never actually moved off part 0, "
                          + "because the setPart mutation silently landed on B's view instead")

        // (2) THE INPUT PROOF — real typing into A's sheet 2, with B still current throughout.
        let model = PanelDocumentTabModel(tabId: "two-doc-drill-a", path: pathA)
        let view = OfficeTileCanvasView(runtime: runtime, path: pathA, docId: docA.docId,
                                        sizeTwips: docA.sizeTwips, initialPart: 1, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view
        // No click helper here — see below: this drill's own input proof is deliberately keyboard-only.
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false,
                                            keyCode: keyCode))
        }

        // **Fix round 3 (IMPORTANT-B) — the input interleave.** Without this, the paint detector
        // above (and `view.mount()`'s own subscribe, both carrying their OWN `setView(A)` prefix)
        // is the last thing to touch "current" before the click/typing below — A is ALREADY current
        // by the time input runs, so deleting JUST `postKeyOnDedicatedThread`/
        // `postMouseOnDedicatedThread`'s own `setView` lines would still leave this drill green (the
        // re-review's own finding).
        //
        // **Two things this interleave must do, not one — found empirically, not assumed.** A
        // straight port of the save interleave's own shape (touch ONLY B, right before the click)
        // measured GREEN even with `postKeyOnDedicatedThread`/`postMouseOnDedicatedThread`'s own
        // `setView` lines deliberately deleted. Two separate reasons, both traced, not guessed:
        //
        // (i) `two-sheet.ods` is well under `OfficeTileStore.residencyCapTiles` (128), so `view
        // .mount()` (at `initialPart: 1`) kicks off `evaluateResidencyIfNeeded`'s own whole-document
        // background prefetch sweep for A — an uncontrolled, asynchronous stream of
        // `paintTileOnDedicatedThread` calls for A's OWN part, each carrying its OWN `setView(A)`
        // (fix round 2) prefix, still actively repainting A well after a bare B-touch landed, racing
        // it and winning. Drained first below (`prefetchSweepIssuedForTesting` — "every chunk of the
        // CURRENT sweep was issued," per that property's own header — means no FURTHER paint call
        // for A will originate from THIS sweep) so nothing but this interleave's own two touches and
        // the click can touch "current."
        //
        // (ii) Even fully drained, a bare B-touch STILL measured green — a deeper reason, an
        // interaction with fix round 3's OWN other finding (IMPORTANT-A): `paintTileOnDedicatedThread`
        // now ALSO issues `setPart` (not just `setView`) on every paint, including the mount-time
        // paint at `initialPart: 1` above. That paint already left A's OWN actual LOK-level part
        // correctly at 1 BEFORE input ever runs — so input's own `setPart` call has nothing left to
        // DO; a misdirected (view-less) `setPart(A.handle, 1)` while B is current is harmless BY
        // ACCIDENT, since A never needed to move. Closed by making A's own part GENUINELY wrong right
        // before the click: re-request A's OWN part 0 (the paint detector's own `aPart0Key`) — this
        // paint carries its OWN correct `setView(A)`+`setPart(A, 0)` prefix (unaffected by any bug in
        // the INPUT path) and genuinely moves A's real state to part 0 — THEN touch B, which moves
        // "current" to B without touching A's part again.
        //
        // (iii) Even with (i) and (ii) both applied, this drill STILL measured green with `setView`
        // deleted — a THIRD reason, found only after removing the click entirely (see
        // `testDirectlyProvesTheInputPathsOwnSetViewPrefixIsLoadBearingBelowTheCanvasLayer`'s own
        // header for the full mechanism): `view.mouseDown`'s own posted LOK mouse-down is itself a
        // VCL/SFX activation gesture that makes A's frame current as a side effect, independent of
        // this fix — so by the time the first keystroke's own `setPart` ran, A was already current by
        // accident. No amount of displacing A's own state beforehand survives a click that reasserts
        // it. Closed by dropping the click below — Calc needs none to start editing the current cell.
        //
        // **The actual observed disabled-build signature, corrected from an earlier, wrong
        // prediction**: with `setView` deleted and the click removed, the marker lands on NEITHER of
        // A's own sheets — B (a second Calc document here) accepts the misdirected `setPart`/
        // `postKeyEvent` instead (`dynamic_cast<ScTabViewShell*>` succeeds on a Calc sibling), so B's
        // OWN dirty flag flips and the edit leaks onto B's current cell, not A's sheet 1. Confirmed
        // live: 3 failing assertions (B's dirty flag before AND after A's save, plus the sheet-2
        // miss below) — contrast the Writer-B sibling drill and the raw drill, where the identical
        // misdirected call is a silent no-op (`dynamic_cast` fails) and the edit is simply lost
        // rather than leaked.
        let sweepDrained = await waitUntil(timeout: 30) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(sweepDrained, "A's own background residency-prefetch sweep never finished issuing "
                      + "its chunks — the input interleave below cannot discriminate anything while it's "
                      + "still racing to repaint A")

        // A DELIBERATELY FRESH key (`tileX: 3`, never requested anywhere else in this drill) — the
        // origin tile (`aPart0Key`) is already cached from the paint detector above, and
        // `requestNeeded`'s own dedup (`OfficeRuntime.swift`, shared by `.subscribe` and prefetch) is
        // "a no-op for a key already re-cached or already in flight" — re-asking for an already-
        // cached key is NOT guaranteed to reach the wire (or LOK) a second time. A never-before-seen
        // key has no cache entry to satisfy, so this is guaranteed to issue a REAL
        // `paintTileOnDedicatedThread(A, part: 0)` call — the thing that must actually move A's own
        // LOK-level part to 0, not merely a Swift-level bookkeeping call.
        //
        // **Through the RAW client, not `runtime.subscribeTiles` — a second live-caught trap.** A
        // first attempt used `runtime.subscribeTiles(path: pathA, part: 0, ...)` for this
        // displacement, exactly like every other tile request in this file — and it broke the drill
        // even WITH the real fix intact: `.subscribeRequested`'s own reducer case
        // (`OfficeRuntime.swift`) sets `next.documents[path]?.activePart = part` as a SIDE EFFECT of
        // any subscribe — so this "just displace LOK's own state" step ALSO silently told the
        // REDUCER "the user is now looking at part 0," and `OfficeRuntime.postMouseEvent`/
        // `postKeyEvent` read exactly that value to decide what part to put on the INPUT wire. The
        // click/type below would then correctly (from the reducer's now-corrupted perspective) target
        // part 0 — passing or failing regardless of the setView fix, for a reason that has nothing to
        // do with it. The raw client's own `requestTiles(docId:keys:)` bypasses the reducer entirely
        // (no `.subscribeRequested` dispatch, no `activePart` write) — a real LOK paint call with
        // none of the app-level side effects, leaving `state.documents[pathA].activePart` at 1
        // (whatever `view.mount()` established) throughout, exactly matching what a real user's next
        // keystroke should target.
        let aFreshPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 3, tileY: 0)
        guard let rawClient = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive the displacement through")
        }
        try await rawClient.requestTiles(docId: docA.docId, keys: [aFreshPart0Key])
        let aDisplacedToPart0 = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aFreshPart0Key) != nil }
        XCTAssertTrue(aDisplacedToPart0, "A's fresh part 0 tile (the interleave's own displacement) never arrived")

        let bOriginKeyBeforeInput = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: pathB, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let bTileArrivedBeforeInput = await waitUntil(timeout: 30) {
            runtime.tileStore.tile(docId: docB.docId, key: bOriginKeyBeforeInput) != nil
        }
        XCTAssertTrue(bTileArrivedBeforeInput, "B's own tile request (the input interleave) never arrived")

        // Deliberately NO click here (see `testDirectlyProvesTheInputPathsOwnSetViewPrefixIs
        // LoadBearingBelowTheCanvasLayer`'s own header for the full mechanism, found AFTER this
        // drill's own click-first shape measured green with setView deleted): `NSEvent`-driven
        // `mouseDown` reaches `postMouseOnDedicatedThread`, whose posted LOK event is itself a VCL
        // activation gesture that makes A current as a side effect, independent of this fix — no
        // drill that clicks before typing can discriminate it. Typing directly at A1 (Calc's own
        // no-click-needed edit start) is what actually proves the fix.
        // "T4EDIZ" — every character's physical keyCode already verified elsewhere in this file
        // (T/4/E/D/I in the single-document drill above, Z in the earlier typing-drill test) — no new
        // keyCode guesses introduced by this drill. Distinct from the single-document drill's own
        // "T4EDIT" marker, so a stray cross-test fixture leak could never masquerade as a pass here.
        let marker = "T4EDIZ"
        let physicalKeyCodes: [Character: UInt16] = ["T": 17, "4": 21, "E": 14, "D": 2, "I": 34, "Z": 6]
        for character in marker {
            let keyCode = try XCTUnwrap(physicalKeyCodes[character])
            let characters = String(character)
            view.keyDown(with: makeKeyEvent(.keyDown, characters: characters, keyCode: keyCode))
            view.keyUp(with: makeKeyEvent(.keyUp, characters: characters, keyCode: keyCode))
        }
        // Return — commits the pending cell edit.
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\r", keyCode: 36))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\r", keyCode: 36))

        await runtime.drainInputChainForTesting()

        let aBecameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == true }
        XCTAssertTrue(aBecameDirty, "A's real edit never marked A dirty")

        // (3) B is untouched, checkpoint 1 — before A is even saved.
        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.dirty, false,
                       "B's dirty flag flipped — A's edit (or A's own part-switch) leaked onto B")

        // **The save interleave — makes the save assertion below actually discriminate.** Without
        // this, A's OWN typing above (each keystroke's `setView` prefix) is the last thing to touch
        // "current," so A would already happen to be current by the time save runs below — a save
        // bug would pass by accident, the exact "green for the wrong reason" shape this task's own
        // history has hit before. One setView-prefixed job against B (a real tile request — the SAME
        // shape a user switching to glance at B's tab would cause) puts B back in the globally-
        // current seat, which is also the more production-shaped sequence: type in A, glance at B,
        // ⌘S.
        let bOriginKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: pathB, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let bTileArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docB.docId, key: bOriginKey) != nil }
        XCTAssertTrue(bTileArrived, "B's own tile request (the save interleave) never arrived")

        let aBeforeSaveStat = officeFileStat(atPath: pathA)
        runtime.save(pathA)
        let aFileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: pathA) != aBeforeSaveStat }
        XCTAssertTrue(aFileChanged, "A's save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[pathA], "no save-failed banner for A")

        // A's own dirty flag must clear after the save — `saveAsOnDedicatedThread` carries the SAME
        // `setView` prefix `postKeyOnDedicatedThread`/`postMouseOnDedicatedThread`/
        // `paintTileOnDedicatedThread` do, precisely because `.uno:Save` (dispatched via
        // `postUnoCommand`'s fire-and-forget follow-up, after the real `saveAs` C-API call) resolves
        // its target frame through `comphelper::dispatchCommand` called with just (command,
        // arguments) — the 2-argument call site, relying on a defaulted listener
        // (`comphelper/source/misc/dispatchcommand.cxx`) — `xDesktop->getActiveFrame()`, the SAME
        // process-global "current frame" concept `setPart` was found to misuse, not the document-
        // scoped `SfxLokHelper::getViewId` lookup `doc_postUnoCommand` performs earlier in its own
        // body (that earlier lookup is used only for its PDF-save special case and its unmodified-
        // skip gate — never to target the dispatch itself). THIS wait, immediately downstream of the
        // save interleave above, is that fix's own regression tripwire: without the prefix in
        // `saveAsOnDedicatedThread`, this assertion is RED here (confirmed live, fix round 2's own
        // report has the transcript) — B, reasserted current by the interleave, receives A's
        // `.uno:Save` dispatch instead of A, so A's `ModifiedStatus=false` never fires.
        let aDirtyCleared = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == false }
        XCTAssertTrue(aDirtyCleared, "A's dirty flag never cleared after save — see this test's own header: "
                      + "`.uno:Save`'s dispatch may have landed on B's frame instead of A's")

        let content = try readODFContentXML(atPath: pathA)
        let sheet1XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet1"), "Sheet1 must still exist")
        let sheet2XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet2"), "Sheet2 must still exist")
        XCTAssertTrue(sheet2XML.contains(marker), "the typed marker must appear on A's SHEET 2")
        XCTAssertFalse(sheet1XML.contains(marker), "the typed marker must NOT leak onto A's sheet 1")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "A's sheet 1 seed content must be untouched")

        // (3) B is untouched, checkpoint 2 — after A's full save (the highest-risk moment, given the
        // `.uno:Save` active-frame hazard documented above). B was never explicitly edited or saved
        // by this test, so its file on disk must still be byte-for-byte whatever `documentLoad` last
        // read.
        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.dirty, false,
                       "B's dirty flag flipped after A's save — A's `.uno:Save` dispatch leaked onto B")
        let bBytesUnchanged = try Data(contentsOf: URL(fileURLWithPath: pathB))
        let bOriginalBytes = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        XCTAssertEqual(bBytesUnchanged, bOriginalBytes, "B's own file on disk changed — nothing in this "
                       + "test ever asked to write B")

        view.unmount()
        runtime.close(pathA)
        runtime.close(pathB)
        XCTAssertNil(runtime.stateSnapshot.documents[pathA], "close is synchronous in the reducer's own state")
        XCTAssertNil(runtime.stateSnapshot.documents[pathB], "close is synchronous in the reducer's own state")

        // Reopen BOTH — A's own round-trip (still genuinely two-part after the save) and B's own
        // round-trip (still genuinely two-part, never corrupted by anything done to A).
        runtime.open(pathA)
        let aReopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathA] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(aReopened, "A never reopened — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertEqual(runtime.stateSnapshot.documents[pathA]?.parts, 2, "A is still genuinely two-part")
        runtime.close(pathA)

        runtime.open(pathB)
        let bReopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bReopened, "B never reopened — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.parts, 2, "B is still genuinely two-part, "
                       + "never corrupted by anything done to A")
        runtime.close(pathB)

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 2 (CRITICAL) — **the Writer-B sibling.** Same drill as the spreadsheet-B variant
    /// above, with B now a WRITER document (`gate.odt`) — the coordinator's own named "no-op case":
    /// per `docuno.cxx`, `ScModelObj::setPart`'s `ScDocShell::GetViewData()` internally
    /// `dynamic_cast`s the process-global current view down to a Calc view shell; when that current
    /// view is actually a Writer `SwView` (B, once B is loaded last), the cast fails and the whole
    /// call is a silent no-op — a DIFFERENT failure mechanism than the spreadsheet-B variant's
    /// cross-document mutation, but the SAME observable symptom for A: A's own view never moves off
    /// its load-time part, so a part-1 request renders A's frozen part-0 content. B's own XML/table
    /// structure has no meaning for a Writer document, so this variant drops those checks — B's own
    /// dirty flag and B's own file bytes remain the checks that matter.
    func testTypingOnDocumentAIsUnaffectedWhenDocumentBIsAWriterDocumentTheDynamicCastNoOpCase() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePathA = Self.fixturesRoot.appendingPathComponent("two-sheet.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathA), "two-sheet.ods fixture missing")
        let fixturePathB = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathB), "gate.odt fixture missing")

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

        let scratchDir = makeScratchDirectory()
        let pathA = scratchDir.appendingPathComponent("doc-a-writer-b-drill.ods").path
        let pathB = scratchDir.appendingPathComponent("doc-b-writer.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePathA)).write(to: URL(fileURLWithPath: pathA))
        try Data(contentsOf: URL(fileURLWithPath: fixturePathB)).write(to: URL(fileURLWithPath: pathB))

        runtime.open(pathA)
        let aSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathA] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(aSettled, "A never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docA = runtime.stateSnapshot.documents[pathA] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("A did not open: \(runtime.stateSnapshot.openFailures[pathA] ?? "no reason recorded")")
        }
        XCTAssertEqual(docA.parts, 2, "setup: A is the same two-sheet fixture as the other drills")

        // B LAST — a WRITER document, so B's view becomes the process-global current one, and it is
        // NOT a Calc view.
        runtime.open(pathB)
        let bSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bSettled, "B never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docB = runtime.stateSnapshot.documents[pathB] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("B did not open: \(runtime.stateSnapshot.openFailures[pathB] ?? "no reason recorded")")
        }
        XCTAssertEqual(docB.type, .text, "setup: B must genuinely be a Writer document for this to be "
                       + "the dynamic_cast no-op case")

        // THE PAINT DETECTOR — while a WRITER document is current, A's part 0 and part 1 tiles must
        // still render genuinely different pixels.
        let zoomPPT = 1000
        let aPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let aPart1Key = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)

        runtime.subscribeTiles(path: pathA, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let aPart0Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aPart0Key) != nil }
        XCTAssertTrue(aPart0Arrived, "A's part 0 tile never arrived, with a Writer document B current")
        let aPart0Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: aPart0Key), "A part 0").pixels

        runtime.subscribeTiles(path: pathA, part: 1, zoomPPT: zoomPPT, viewportTwips: viewport)
        let aPart1Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aPart1Key) != nil }
        XCTAssertTrue(aPart1Arrived, "A's part 1 tile never arrived, with a Writer document B current")
        let aPart1Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: aPart1Key), "A part 1").pixels

        XCTAssertNotEqual(aPart0Pixels, aPart1Pixels, "A's part 0 and part 1 tiles rendered IDENTICAL "
                          + "pixels while a Writer document was current — the dynamic_cast no-op case: "
                          + "setPart silently did nothing, so A's view never moved off part 0")

        // THE INPUT PROOF.
        let model = PanelDocumentTabModel(tabId: "writer-b-drill-a", path: pathA)
        let view = OfficeTileCanvasView(runtime: runtime, path: pathA, docId: docA.docId,
                                        sizeTwips: docA.sizeTwips, initialPart: 1, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view
        // No click helper here — see the spreadsheet-B drill's own header: deliberately keyboard-only.
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false,
                                            keyCode: keyCode))
        }

        // Fix round 3 (IMPORTANT-B) — the input interleave; see the spreadsheet-B drill's own header
        // for the full account of why this needs THREE steps (drain A's own background residency-
        // prefetch sweep first, then genuinely displace A's own LOK-level part via a fresh never-
        // cached key, then touch B) to actually discriminate the input path's own `setView` prefix —
        // two simpler attempts (a bare B-touch; a bare B-touch after draining the sweep) both
        // measured green with `postKeyOnDedicatedThread`/`postMouseOnDedicatedThread`'s own `setView`
        // lines deliberately deleted, for reasons traced there, not guessed.
        let sweepDrained = await waitUntil(timeout: 30) { view.prefetchSweepIssuedForTesting }
        XCTAssertTrue(sweepDrained, "A's own background residency-prefetch sweep never finished issuing "
                      + "its chunks — the input interleave below cannot discriminate anything while it's "
                      + "still racing to repaint A")

        // Through the RAW client, not `runtime.subscribeTiles` — see the spreadsheet-B drill's own
        // header for why: `.subscribeRequested`'s reducer case sets `activePart` as a side effect,
        // which would corrupt what the click/type below puts on the input wire regardless of the
        // setView fix, for a reason that has nothing to do with it.
        let aFreshPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 3, tileY: 0)
        guard let rawClient = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive the displacement through")
        }
        try await rawClient.requestTiles(docId: docA.docId, keys: [aFreshPart0Key])
        let aDisplacedToPart0 = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aFreshPart0Key) != nil }
        XCTAssertTrue(aDisplacedToPart0, "A's fresh part 0 tile (the interleave's own displacement) never arrived")

        let bOriginKeyBeforeInput = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: pathB, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let bTileArrivedBeforeInput = await waitUntil(timeout: 30) {
            runtime.tileStore.tile(docId: docB.docId, key: bOriginKeyBeforeInput) != nil
        }
        XCTAssertTrue(bTileArrivedBeforeInput, "B's own tile request (the input interleave) never arrived")

        // Deliberately NO click — see the spreadsheet-B drill's own header for the mechanism (a click
        // is a VCL activation side effect independent of this fix).
        let marker = "T4EDIZ"
        let physicalKeyCodes: [Character: UInt16] = ["T": 17, "4": 21, "E": 14, "D": 2, "I": 34, "Z": 6]
        for character in marker {
            let keyCode = try XCTUnwrap(physicalKeyCodes[character])
            let characters = String(character)
            view.keyDown(with: makeKeyEvent(.keyDown, characters: characters, keyCode: keyCode))
            view.keyUp(with: makeKeyEvent(.keyUp, characters: characters, keyCode: keyCode))
        }
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\r", keyCode: 36))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\r", keyCode: 36))

        await runtime.drainInputChainForTesting()

        let aBecameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == true }
        XCTAssertTrue(aBecameDirty, "A's real edit never marked A dirty")
        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.dirty, false,
                       "B's dirty flag flipped — A's edit leaked onto the Writer document B")

        // The save interleave — see the spreadsheet-B drill's own header for why this is needed to
        // make the dirty-cleared wait below actually discriminate, rather than pass by accident
        // because A's own typing was simply the last thing to touch "current."
        let bOriginKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: pathB, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let bTileArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docB.docId, key: bOriginKey) != nil }
        XCTAssertTrue(bTileArrived, "B's own tile request (the save interleave) never arrived")

        let aBeforeSaveStat = officeFileStat(atPath: pathA)
        runtime.save(pathA)
        let aFileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: pathA) != aBeforeSaveStat }
        XCTAssertTrue(aFileChanged, "A's save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[pathA], "no save-failed banner for A")
        // Regression tripwire for `saveAsOnDedicatedThread`'s own `setView` prefix — see the
        // spreadsheet-B drill's own header for the full mechanism.
        let aDirtyCleared = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == false }
        XCTAssertTrue(aDirtyCleared, "A's dirty flag never cleared after save")

        let content = try readODFContentXML(atPath: pathA)
        let sheet1XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet1"), "Sheet1 must still exist")
        let sheet2XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet2"), "Sheet2 must still exist")
        XCTAssertTrue(sheet2XML.contains(marker), "the typed marker must appear on A's SHEET 2")
        XCTAssertFalse(sheet1XML.contains(marker), "the typed marker must NOT leak onto A's sheet 1")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "A's sheet 1 seed content must be untouched")

        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.dirty, false,
                       "B's dirty flag flipped after A's save — A's `.uno:Save` dispatch leaked onto B")
        let bBytesUnchanged = try Data(contentsOf: URL(fileURLWithPath: pathB))
        let bOriginalBytes = try Data(contentsOf: URL(fileURLWithPath: fixturePathB))
        XCTAssertEqual(bBytesUnchanged, bOriginalBytes, "B's own file on disk changed — nothing in this "
                       + "test ever asked to write B")

        view.unmount()
        runtime.close(pathA)
        runtime.close(pathB)

        runtime.open(pathB)
        let bReopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bReopened, "B never reopened — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertEqual(runtime.stateSnapshot.documents[pathB]?.type, .text, "B is still genuinely a "
                       + "Writer document, never corrupted by anything done to A")
        runtime.close(pathB)

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 3 (IMPORTANT-A) — **the discriminating drill for `getAlternativeViewForPaint`'s own
    /// unfiltered scan.** Round 2's `setView` prefix closes `doc_paintPartTile`'s "no alternative
    /// view found" branch (the direct `doc_setPartImpl` call) — but `getAlternativeViewForPaint`
    /// (`desktop/source/lib/init.cxx:4387-4414`, this codebase's pinned LO commit `11482c8f`) has its
    /// OWN, separate hazard: it searches every open view-shell for one already sitting at the
    /// requested part/mode with a matching render-state string, with NO `DocId` filter — a bystander
    /// document of ANY type can match. On a match, `doc_paintPartTile` skips `setPart` ENTIRELY
    /// (`nViewId != nOrigViewId`, the "found an alternative" branch) and paints via the REQUESTING
    /// document's own view, unmoved — `doc_paintTile`/`ScModelObj::paintTile` is instance-scoped, so
    /// it renders whatever `pThis`'s own view is ACTUALLY sitting at, mislabeled as the requested
    /// part.
    ///
    /// Round 2's own two drills never exercised this branch: both request part 0 THEN part 1 BEFORE
    /// any typing, while A's view is still at its load-time default (part 0) — the part-1 request is
    /// the only one with a mismatch to search over, and nothing is sitting at part 1 to match. This
    /// drill inverts that: type into A's sheet 2 FIRST (moves A's own LOK-level part to 1 via the
    /// existing input-path `setPart`), so a LATER "part 0" request is the one with a mismatch — with
    /// B (freshly opened, sitting at LOK's own part-0/mode-0 defaults, never touched again) as
    /// EXACTLY the kind of no-DocId-filtered false-positive match the finding names. B is a WRITER
    /// document (`gate.odt`) deliberately — the finding's own most pointed phrasing ("a Writer
    /// bystander matches every part-0 request unconditionally") is not a coincidence: a Writer
    /// document's `getPart()`/`getEditMode()` trivially read 0/0 regardless of any real "sheet"
    /// concept, maximizing the chance its render-state also coincides with a fresh Calc view's own.
    ///
    /// Remedy, chosen deliberately: `paintTileOnDedicatedThread` now issues `setPart(doc.handle,
    /// key.part)` immediately after its existing `setView` prefix, BEFORE calling `paintPartTile`.
    /// This does not merely narrow the search's blast radius — it prevents the search from ever
    /// being reached at all: `doc_paintPartTile`'s own trigger condition
    /// (`nPart != doc_getPart(pThis)`) is the FIRST thing it checks, and by the time it runs, `pThis`
    /// own document is already sitting at the requested part — the mismatch that summons
    /// `getAlternativeViewForPaint` never arises.
    ///
    /// **The caveat the remedy earns, checked, not assumed**: `setPart` genuinely moves the
    /// document's own active-sheet state (`ScModelObj::setPart`'s own `pTabView->SelectTabPage`) —
    /// calling it on every paint would be unsafe if any paint ever carried a part OTHER than the
    /// canvas's own currently-active one (a background/prefetch paint silently stealing the "active
    /// sheet" from under the user, corrupting what an ODS save records as selected). Checked directly
    /// against this codebase, not assumed: `officeResidencyPrefetchOrder` (`OfficeTileCanvasView
    /// .swift`) takes ONE `part` parameter and stamps every `TileKey` it produces with it; its one
    /// call site, `evaluateResidencyIfNeeded`, passes `part: part` — the view's own current
    /// `self.part`, always. There is no code path in this codebase that ever requests a tile for a
    /// part other than the requesting canvas's own currently active one, so the simpler,
    /// unconditional prefix (matching input's own established convention) is safe here — the more
    /// complex tracked-current-part alternative was considered and set aside as solving a risk this
    /// codebase's own call graph does not have.
    func testRequestingPartZeroAfterTypingOnSheetTwoRendersSheetOneNotAStaleBystanderMatch() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePathA = Self.fixturesRoot.appendingPathComponent("two-sheet.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathA), "two-sheet.ods fixture missing")
        let fixturePathB = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathB), "gate.odt fixture missing")

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

        let scratchDir = makeScratchDirectory()
        let pathA = scratchDir.appendingPathComponent("doc-a-bystander-drill.ods").path
        let pathB = scratchDir.appendingPathComponent("doc-b-bystander.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePathA)).write(to: URL(fileURLWithPath: pathA))
        try Data(contentsOf: URL(fileURLWithPath: fixturePathB)).write(to: URL(fileURLWithPath: pathB))

        runtime.open(pathA)
        let aSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathA] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(aSettled, "A never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docA = runtime.stateSnapshot.documents[pathA] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("A did not open: \(runtime.stateSnapshot.openFailures[pathA] ?? "no reason recorded")")
        }
        XCTAssertEqual(docA.parts, 2, "setup: A is the same two-sheet fixture as the other drills")

        // B LAST — freshly opened, sitting at LOK's own part-0/mode-0 defaults, never touched again.
        runtime.open(pathB)
        let bSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bSettled, "B never settled — phase: \(runtime.stateSnapshot.phase)")
        guard runtime.stateSnapshot.documents[pathB] != nil else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("B did not open: \(runtime.stateSnapshot.openFailures[pathB] ?? "no reason recorded")")
        }

        // Type into A's sheet 2 FIRST — moves A's own LOK-level part to 1, so the LATER part-0
        // request below is the one with a mismatch to search over (see this test's own header for
        // why round 2's own drills never exercised this ordering).
        let model = PanelDocumentTabModel(tabId: "bystander-drill-a", path: pathA)
        let view = OfficeTileCanvasView(runtime: runtime, path: pathA, docId: docA.docId,
                                        sizeTwips: docA.sizeTwips, initialPart: 1, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let zoomPPT = 1000
        let originKeyPart1 = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let baselineArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: originKeyPart1) != nil }
        XCTAssertTrue(baselineArrived, "sheet 2's own baseline tile never arrived — setup")

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view
        let clickPoint = NSPoint(x: 10, y: 10)
        let windowClickPoint = view.convert(clickPoint, to: nil)
        func makeMouseEvent(_ type: NSEvent.EventType) -> NSEvent {
            try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: windowClickPoint, modifierFlags: [],
                                              timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                              eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false,
                                            keyCode: keyCode))
        }

        view.mouseDown(with: makeMouseEvent(.leftMouseDown))
        view.mouseUp(with: makeMouseEvent(.leftMouseUp))
        let marker = "T4EDIZ"
        let physicalKeyCodes: [Character: UInt16] = ["T": 17, "4": 21, "E": 14, "D": 2, "I": 34, "Z": 6]
        for character in marker {
            let keyCode = try XCTUnwrap(physicalKeyCodes[character])
            let characters = String(character)
            view.keyDown(with: makeKeyEvent(.keyDown, characters: characters, keyCode: keyCode))
            view.keyUp(with: makeKeyEvent(.keyUp, characters: characters, keyCode: keyCode))
        }
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\r", keyCode: 36))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\r", keyCode: 36))

        await runtime.drainInputChainForTesting()

        let aBecameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == true }
        XCTAssertTrue(aBecameDirty, "A's real edit never marked A dirty — setup")

        // THE DISCRIMINATING REQUEST — directly, bypassing the canvas's own (possibly already-
        // correct) `activePart`, exactly like the paint detector in the other two-document drills:
        // request A's part 0 AND part 1 tiles and assert they render genuinely different pixels. The
        // pre-fix bug's signature: with B a matching bystander, the part-0 request finds B via
        // `getAlternativeViewForPaint`'s unfiltered scan, skips `setPart` entirely, and paints A's
        // OWN view exactly as-is — still at part 1 — so the "part 0" and "part 1" tiles come back
        // byte-identical (both showing sheet 2).
        let originKeyPart0 = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: pathA, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let part0Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: originKeyPart0) != nil }
        XCTAssertTrue(part0Arrived, "A's part 0 tile never arrived, requested after typing on sheet 2 with B open")
        let part0Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: originKeyPart0), "A part 0").pixels

        runtime.subscribeTiles(path: pathA, part: 1, zoomPPT: zoomPPT, viewportTwips: viewport)
        let part1Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: originKeyPart1) != nil }
        XCTAssertTrue(part1Arrived, "A's part 1 tile never arrived, requested after typing on sheet 2 with B open")
        let part1Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docA.docId, key: originKeyPart1), "A part 1").pixels

        XCTAssertNotEqual(part0Pixels, part1Pixels, "A's part 0 and part 1 tiles rendered IDENTICAL pixels "
                          + "after typing moved A to sheet 2, with a bystander (B) open at part 0 — "
                          + "getAlternativeViewForPaint's own unfiltered scan found B, skipped setPart "
                          + "entirely, and painted A's own (still-sheet-2) view mislabeled as part 0")

        // Round-trip proof: the part-0 tile's content must actually BE sheet 1 — not merely different
        // from part 1's, which a different-but-still-wrong render would also satisfy. Save + read the
        // real XML back, the same standard every other drill in this file holds itself to.
        let beforeSaveStat = officeFileStat(atPath: pathA)
        runtime.save(pathA)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: pathA) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "A's save never landed on disk")
        let content = try readODFContentXML(atPath: pathA)
        let sheet1XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet1"), "Sheet1 must still exist")
        let sheet2XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet2"), "Sheet2 must still exist")
        XCTAssertTrue(sheet2XML.contains(marker), "the typed marker must appear on SHEET 2")
        XCTAssertFalse(sheet1XML.contains(marker), "the typed marker must NOT leak onto sheet 1")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "sheet 1's own seed content must be untouched — "
                      + "this is the save-side half of the same proof: the saved file's own ACTIVE part "
                      + "reflects where the user's real typing left it (sheet 2), not wherever a stray "
                      + "prefetch/paint last painted, since every paint's own part always matches the "
                      + "requesting canvas's own active part in this codebase (see this test's own header)")

        view.unmount()
        runtime.close(pathA)
        runtime.close(pathB)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 3 (IMPORTANT-B) — **the deletion-red proof, at the layer where the lines under test
    /// actually live.** Earlier interleave designs (mounted-canvas, with a real `NSEvent`-driven click
    /// before typing; this same drill's own first cut, also click-first) all measured GREEN with
    /// `postKeyOnDedicatedThread`/`postMouseOnDedicatedThread`'s own `setView` lines deliberately
    /// deleted. The actual confound, found by direct source read rather than by iterating on
    /// interleave shape, is the CLICK itself, not the canvas: `ScModelObj::postMouseEvent`/
    /// `::postKeyEvent` (`docuno.cxx:819`/`825`, this codebase's pinned LO commit `11482c8f`) resolve
    /// their target window through `getDocWindow()` (`docuno.cxx:718-732`) →
    /// `ScDocShell::GetBestViewShell(false)` (`docsh4.cxx:3085`) — INSTANCE-scoped, and
    /// self-correcting: it takes `ScTabViewShell::GetActiveViewShell()` first, then explicitly
    /// REJECTS it if `GetViewData().GetDocShell() != this`, falling back to a by-frame lookup scoped
    /// to the target document — unlike `setPart`'s own resolution (`ScDocShell::GetViewData()`,
    /// `docsh4.cxx:3069-3074`), which is the naive `SfxViewShell::Current()` dynamic_cast this whole
    /// fix round is about. `SfxLokHelper::postKeyEventAsync`/`postMouseEventAsync`
    /// (`lokhelper.cxx:1294-1375`) then take that already-resolved window directly and post the event
    /// through VCL's own async queue — they do not re-resolve "current" at dispatch time. A mouse
    /// button-down delivered to a window is itself a VCL/SFX activation gesture: posting it to A's
    /// window (correctly resolved via `getDocWindow`'s own self-correction, with or without this
    /// fix's `setView`) makes A's frame the process-global "current" one as a SIDE EFFECT of the click
    /// landing — so by the time the FIRST keystroke's own `setPart` runs, A is already current by
    /// accident, and the fix under test never gets a chance to matter. No drill that clicks before
    /// typing can discriminate this fix, mounted-canvas or raw — confirmed by disabling `setView` and
    /// observing GREEN across three independently-designed click-first drills before this was traced.
    ///
    /// **The actual proof: remove the click.** Calc's own real UX needs no click to start editing the
    /// current cell — the cursor is already at A1 from `documentLoad`, and a keystroke alone enters
    /// edit mode there (confirmed empirically: this drill, keyboard-only, still lands its marker with
    /// the fix intact). This is also the more production-honest shape: a user who switches sheets via
    /// the part strip (`setActivePart`) and types immediately never clicks the canvas first — `part`
    /// riding the input wire on its own is exactly the scenario that needs proving. With the click
    /// gone: raw `requestTiles` genuinely parks A at part 0 (the paint prefix's own
    /// `setView`+`setPart`, unaffected by anything under test here); a second raw `requestTiles`
    /// against B makes B current; a raw `postKey` (no `postMouse` at all) sequence with `part: 1` is
    /// the ONLY thing left that can move A back to part 1 before the marker lands. Confirmed both
    /// ways: GREEN with the fix intact, RED — `XCTAssertTrue failed - the typed marker must appear on
    /// A's SHEET 2` — with `setView` deleted from both dedicated-thread input functions, restored
    /// immediately after.
    ///
    /// **What this proves beyond "the marker lands correctly," matching the finding's own "any
    /// second doc open" framing**: `ScModelObj::setPart`'s static resolution (re-verified at this
    /// codebase's pinned LO commit `11482c8f`) means a misdirected `setPart(A.handle, 1)` — without
    /// this fix — does not merely fail to move A; it ACTS on whichever document is current. B is a
    /// Writer document here specifically so that action is a silent no-op (the `dynamic_cast`-fails
    /// case): the marker lands on neither sheet, and B's own dirty flag never flips (confirmed: this
    /// drill's disabled-build run shows exactly ONE failing assertion, the "must appear on sheet 2"
    /// one). The sibling drill below, with B as a SECOND Calc document, demonstrates the OTHER half —
    /// a Calc B accepts the misdirected call, and the marker leaks onto B's own current cell instead
    /// (confirmed: three failing assertions there — B's dirty flag flips both before and after A's
    /// save, plus the same "must appear on sheet 2" miss).
    func testDirectlyProvesTheInputPathsOwnSetViewPrefixIsLoadBearingBelowTheCanvasLayer() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePathA = Self.fixturesRoot.appendingPathComponent("two-sheet.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathA), "two-sheet.ods fixture missing")
        let fixturePathB = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePathB), "gate.odt fixture missing")

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

        let scratchDir = makeScratchDirectory()
        let pathA = scratchDir.appendingPathComponent("doc-a-raw-proof.ods").path
        let pathB = scratchDir.appendingPathComponent("doc-b-raw-proof.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePathA)).write(to: URL(fileURLWithPath: pathA))
        try Data(contentsOf: URL(fileURLWithPath: fixturePathB)).write(to: URL(fileURLWithPath: pathB))

        runtime.open(pathA)
        let aSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathA] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(aSettled, "A never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docA = runtime.stateSnapshot.documents[pathA] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("A did not open: \(runtime.stateSnapshot.openFailures[pathA] ?? "no reason recorded")")
        }
        XCTAssertEqual(docA.parts, 2, "setup: A is the same two-sheet fixture as the other drills")

        // B LAST — B's view becomes the process-global current one at load time.
        runtime.open(pathB)
        let bSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[pathB] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bSettled, "B never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let docB = runtime.stateSnapshot.documents[pathB] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("B did not open: \(runtime.stateSnapshot.openFailures[pathB] ?? "no reason recorded")")
        }

        guard let rawClient = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // NO canvas view anywhere in this drill — no prefetch sweep, no invalidation-driven refetch,
        // no healing actor. Genuinely park A at part 0, through a real paint (the paint prefix's own
        // setView+setPart, unaffected by anything under test here).
        let zoomPPT = 1000
        let aPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        try await rawClient.requestTiles(docId: docA.docId, keys: [aPart0Key])
        let aParkedAtPart0 = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docA.docId, key: aPart0Key) != nil }
        XCTAssertTrue(aParkedAtPart0, "A's part 0 tile never arrived — setup")

        // Make B current — nothing left to touch "current" between here and the input below.
        let bPart0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        try await rawClient.requestTiles(docId: docB.docId, keys: [bPart0Key])
        let bCurrent = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docB.docId, key: bPart0Key) != nil }
        XCTAssertTrue(bCurrent, "B's part 0 tile never arrived — setup")

        // THE PROOF — real input, part 1 (sheet 2), with B still current. Only the input path's own
        // setView+setPart can move A from its parked part 0 back to part 1 before the marker lands.
        // Deliberately NO postMouse here — see this test's own header: a click is itself a VCL
        // activation gesture that makes A's frame current as a side effect, independent of this fix,
        // which would make this drill pass regardless of whether setView is present. Calc needs no
        // click to start editing the current cell (A1, from load), so the keystrokes alone are the
        // whole proof.
        let marker = "T4EDIT"
        let keyCodes: [Character: Int] = [
            "T": 531 | 0x1000, "E": 516 | 0x1000, "D": 515 | 0x1000, "I": 520 | 0x1000, "4": 260,
        ]
        for character in marker {
            let keyCode = try XCTUnwrap(keyCodes[character])
            let charCode = try XCTUnwrap(character.asciiValue.map(Int.init))
            try await rawClient.postKey(docId: docA.docId, part: 1, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await rawClient.postKey(docId: docA.docId, part: 1, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
        // Return — commits the pending Calc cell edit.
        try await rawClient.postKey(docId: docA.docId, part: 1, type: .keyInput, charCode: 0, keyCode: 1280)
        try await rawClient.postKey(docId: docA.docId, part: 1, type: .keyUp, charCode: 0, keyCode: 1280)

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[pathA]?.dirty == true }
        XCTAssertTrue(becameDirty, "A's real edit never marked A dirty")

        let beforeSaveStat = officeFileStat(atPath: pathA)
        runtime.save(pathA)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: pathA) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "A's save never landed on disk")

        let content = try readODFContentXML(atPath: pathA)
        let sheet1XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet1"), "Sheet1 must still exist")
        let sheet2XML = try XCTUnwrap(extractTableXML(content, sheetName: "Sheet2"), "Sheet2 must still exist")
        XCTAssertTrue(sheet2XML.contains(marker), "the typed marker must appear on A's SHEET 2 — this is "
                      + "the input path's OWN setView+setPart prefix moving A from its parked part 0 "
                      + "back to part 1, with nothing else around to do it")
        XCTAssertFalse(sheet1XML.contains(marker), "the typed marker must NOT leak onto A's sheet 1 — "
                      + "without the fix, this is exactly where it would land (A stays parked at part "
                      + "0 because the misdirected setPart acts on B, a Writer document, instead)")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "A's sheet 1 seed content must be untouched")

        runtime.close(pathA)
        runtime.close(pathB)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 4 — the shared real-edit helper both migrated tests below use: a real
    /// mouse click (positions LOK's own cursor/selection — twips (100, 100), inside both A1's own
    /// real bounding rect for a spreadsheet AND the very start of a text document's body,
    /// empirically the same shape the criteria-1-4 live tests in `OfficeHelperLiveTests.swift`
    /// already use) then real `postKey` calls for `marker`'s own characters, committed with Return.
    /// `keyCodes` is a small, TEST-LOCAL table (not `OfficeInputCodes`, which is keyed by AppKit
    /// PHYSICAL keyCode — there is no `NSEvent` anywhere in this wire-level helper) of exactly the
    /// `com.sun.star.awt.Key` base codes this file's own marker text needs, uppercase letters OR'd
    /// with `KEY_SHIFT` (`0x1000`) — matching how a real user actually holds Shift to type them,
    /// the same packed-modifier convention `OfficeInputCodes`'s own header derives at length.
    private func postRealEdit(client: OfficeHelperClient, docId: String, marker: String) async throws {
        try await client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        let keyCodes: [Character: Int] = [
            "T": 531 | 0x1000, "E": 516 | 0x1000, "D": 515 | 0x1000, "I": 520 | 0x1000, "4": 260,
        ]
        for character in marker {
            let keyCode = try XCTUnwrap(keyCodes[character], "postRealEdit's own marker text used a "
                                        + "character with no test-local keyCode: \(character)")
            let charCode = try XCTUnwrap(character.asciiValue.map(Int.init))
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
        // Return — commits a pending Calc cell edit (Calc's own semantics); a harmless paragraph
        // break for Writer, which does not change whether the document is now dirty or whether its
        // rendered pixels differ, this test's own two proofs either way.
        try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280)
        try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)
    }

    /// **Office Stage B Task 4 — migrated off the DEBUG-only `debugEdit` door, now that a real one
    /// exists.** Before this task, the edit went straight at `OfficeHelperSupervisor.client
    /// .debugEdit` — bypassing `OfficeRuntime`/`ShellSessionHost` entirely — dispatching
    /// `.uno:GoToCell` (a no-op for `.odt`, which has no concept of "cell") then a `paste()` at the
    /// current selection/cursor. That whole door, and its `paste()` mechanism, is GONE — removed in
    /// the same commit as this migration, per the dispatch's own "no green gap" instruction. The
    /// real replacement (`postRealEdit`, below) is a real mouse click (positions LOK's own
    /// cursor/selection — there is no other door for this now) then real `postKey` calls, the exact
    /// same wire verb `OfficeTileCanvasView.forwardKeyEvent` uses in production, just called
    /// directly here (bypassing the canvas view itself, which is `OfficeRuntimeLiveTests
    /// .testTheTypingDrillARealKeyDownThroughTheRealCanvasViewReachesLOKAndTheCaretTileRepaints`'s
    /// own, separate job) — this test's own scope stays exactly what it always was: a SAVE/
    /// persistence round trip, not a canvas-forwarding proof.
    func testSaveThroughTheRealEditDoorThenCloseThenReopenPersistsRealContentAcrossTwoFormats() async throws {
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
                XCTFail("\(fixtureName): no live client to drive the real edit door through")
                continue
            }
            try await postRealEdit(client: client, docId: originalDocId, marker: "T4EDIT")

            // Office Stage B Task 2b resolved the NEEDS_CONTEXT finding this assertion used to be
            // pinned against (this test's own header has the full before/after account): staging
            // makes every document genuinely writable, so a real edit is no longer a silent no-op
            // against a read-only medium.
            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "\(fixtureName): the real edit's own `.uno:ModifiedStatus=true` "
                          + "callback never reached documents[path].dirty — the dirty-tracking wire "
                          + "(ShellSessionHost.wireOfficeTileCallbacks' onDocumentEvent routing) is "
                          + "what this assertion actually proves, not merely that the edit happened")

            // Sanity: the edit's own target docId must still be `docPath`'s CURRENT docId the
            // instant before save is requested — a guard against a spurious reload racing the edit
            // that would otherwise make a genuine save-flow failure look identical to "the edit
            // landed on a handle nothing downstream cares about anymore."
            XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, originalDocId,
                           "\(fixtureName): docId changed BEFORE save was even requested — something "
                           + "reloaded and the edit's target handle is gone")

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
    /// real edit that mutates the in-memory model but can never flip the modified flag on a
    /// read-only medium). Office Stage B Task 4 — migrated off `debugEdit` to `postRealEdit`
    /// (this file's own shared helper, below), same reasoning as the tripwire's own migration.
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
            return XCTFail("no live client to drive the real edit door through")
        }
        try await postRealEdit(client: client, docId: docId, marker: "T4EDIT")

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
