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

    /// **Office Stage B Task 10 — the CFB release blocker, proven through the REAL staging pipeline,
    /// not just the raw wire.** `OfficeHelperLiveTests.testCFBBytesUnderAModernExtensionRefuseCleanly
    /// AndTheHelperStaysAlive` proves the sniff fires against a path handed DIRECTLY to the helper;
    /// this test proves the SAME refusal survives `OfficeRuntime`'s own staging jail
    /// (`stageDocument`/`stagedPath` — Task 2b) first, which is what a REAL open always goes through
    /// in production (`runtime.open` never hands the helper `realPath` at all — only the staged
    /// copy). `OfficeRuntime.stagedPath(forDocId:realPath:docsDirectory:)`'s own construction
    /// (`"\(docId).\(ext)"`) preserves the SOURCE path's extension, which is the one fact this test's
    /// own pass/fail turns on: if a future change to staging ever stopped preserving the extension,
    /// the CFB gate (keyed off the STAGED path's extension, inside
    /// `LOKBridge.openOnDedicatedThread`) would silently stop firing for real opens while every
    /// direct-wire test above kept passing — this is the test that would catch that regression.
    ///
    /// Also proves the brief's own "banner with the mapped sentence" bar specifically — `openFailures`
    /// holds the MAPPED house-voice sentence, never `LOKBridge.cfbUnderModernExtensionReason`'s own
    /// raw wire text, because that mapping happens between the wire reply and this dispatch
    /// (`OfficeRuntime.describe(_:)` -> `houseErrorSentence`) — `OfficeHelperLiveTests`'s own test
    /// stops one layer below this and asserts the RAW reason for exactly that reason (proving the
    /// wire itself is unmapped, as designed).
    func testCFBBytesUnderAModernExtensionRefuseWithTheMappedBannerThroughRealStagingAndTheRuntimeStaysUsable() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let legacyDocPath = Self.fixturesRoot.appendingPathComponent("legacy-doc.doc").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: legacyDocPath), "legacy-doc.doc fixture missing at \(legacyDocPath)")
        let goodPath = Self.fixturesRoot.appendingPathComponent("gate.docx").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: goodPath), "gate.docx fixture missing at \(goodPath)")

        let stateDir = makeScratchDirectory()
        // A SEPARATE scratch dir stands in for "wherever the user's real document lives" — never
        // nested inside `stateDir`, the same separation `OfficeHarness`'s own zip-surgery scratch
        // keeps from its fixtures scratch — so this test cannot accidentally exercise an
        // already-staged path instead of a genuine real-source open.
        let sourceDir = makeScratchDirectory()
        let renamedSource = sourceDir.appendingPathComponent("renamed-legacy.docx")
        try FileManager.default.copyItem(atPath: legacyDocPath, toPath: renamedSource.path)

        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(renamedSource.path)

        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.openFailures[renamedSource.path] != nil
                || runtime.stateSnapshot.documents[renamedSource.path] != nil
        }
        XCTAssertTrue(settled, "renamed-legacy.docx never settled — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNil(runtime.stateSnapshot.documents[renamedSource.path],
                     "renamed-legacy.docx must never actually open")
        XCTAssertEqual(runtime.stateSnapshot.openFailures[renamedSource.path],
                       "This file's contents don't match its extension — it looks like an older "
                     + "binary Office format and can't be opened here.",
                       "the banner-facing reason must be the MAPPED house-voice sentence, never "
                     + "LOKBridge's raw wire marker text")

        // Liveness proof, through the SAME runtime and the SAME shared helper process: a good
        // document opens normally right after — not merely a process-alive flag, an actual open.
        runtime.open(goodPath)
        let goodSettled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[goodPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(goodSettled, "gate.docx never settled after the refusal — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[goodPath], "gate.docx did not open: "
                        + "\(runtime.stateSnapshot.openFailures[goodPath] ?? "no reason recorded")")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
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
    /// spreadsheet pairing — a live-test-caught, disclosed substitution.** At the time this test was
    /// written, this vendored, from-source LibreOffice build's OOXML EXPORT filter did not work at
    /// all — `saveAs` against ANY xlsx/docx destination crashed the whole helper process, independent
    /// of the seatbelt, independent of any edit, independent of the `pFormat` string tried. ODF
    /// export (`.ods`/`.odt`/`.odp`) was unaffected. This task's own job — the save PIPELINE (wire,
    /// helper dispatch, atomic place, suppression, dirty tracking) — was fully proven by the ODF pair
    /// regardless; the OOXML gap was a vendored-binary completeness problem, not a defect in anything
    /// this task built. **Task 11 update**: the r3 vendor re-cut fixed the xlsx half of that gap
    /// (added `product-set/Frameworks/libsal_textenclo.dylib` — see `ooxml-export-investigation.md`).
    /// **r4 update**: the docx half is fixed too, by the same CLASS of gap one library over
    /// (`libmswordlo.dylib`, which holds the `com.sun.star.comp.Writer.DocxExport` service
    /// `services.rdb` always pointed at) — all three OOXML formats now export. See
    /// `OfficeHelperLiveTests.testXlsxDocxPptxSaveRoundTripThroughTheRealHelperAfterTheR4VendorRecut`
    /// for the current, per-format, live-proven truth. This test's own ODF choice was never about
    /// avoiding a permanent limitation, only the crash that existed when it was written, so it is
    /// left as `.ods`/`.odt` rather than migrated to OOXML fixtures now.
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
        // header for the full mechanism): the posted LOK event's own dispatch `GrabFocus`es A's
        // window (`LOKPostAsyncEvent`, `sfx2/source/view/lokhelper.cxx:1186-1203`, at this
        // codebase's pinned LO commit `11482c8f`), which makes A's frame current as a side effect,
        // independent of this fix — so by the time the NEXT `setPart` ran, A was already current by
        // accident. No amount of displacing A's own state beforehand survives that. Closed by
        // dropping the click below — Calc needs none to start editing the current cell. (Fix round
        // 4, NEW-3: this used to be attributed to the CLICK specifically. It is not click-specific —
        // the same dispatch path runs for key events, which is exactly why only the FIRST keystroke
        // is damaged below rather than all of them.)
        //
        // **The disabled-build signature, RE-MEASURED in fix round 4 (NEW-3) with A's saved bytes
        // dumped rather than inferred from which assertions fired.** With `setView` deleted and the
        // click removed: A's Sheet1 is UNTOUCHED (`NORMA GATE`, `42`) and **A's Sheet2!A1 =
        // `4EDIZ`** — the marker (`T4EDIZ`) minus its FIRST character, which is destroyed. B's own
        // dirty flag does flip, both before and after A's save. 3 failing assertions, and the
        // reasons are two different things, not one: (a) the first `setPart(A.handle, 1)` runs while
        // B is current, and because B is a second CALC document the `dynamic_cast<ScTabViewShell*>`
        // SUCCEEDS — so B's own active sheet is switched under it, which is what dirties B; (b) the
        // keystrokes themselves always reach A (`getDocWindow`'s instance-scoped self-correction),
        // so A's first character opens a cell edit on the WRONG sheet and is then discarded when the
        // second keystroke's now-correctly-targeted `setPart` switches A to sheet 2. An earlier
        // version of this comment said "the edit leaks onto B's current cell"; the bytes say it does
        // not — nothing of the marker reaches B. The Writer-B sibling drill and the raw drill show
        // the same A-side damage with (a) absent, since `dynamic_cast` fails there: one failing
        // assertion, B never dirty.
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
        // `mouseDown` reaches `postMouseOnDedicatedThread`, and ANY posted LOK event's own dispatch
        // `GrabFocus`es its target window (`LOKPostAsyncEvent`, `lokhelper.cxx:1186-1203`), making A
        // current as a side effect, independent of this fix — no drill that clicks before typing can
        // discriminate it. (Fix round 4, NEW-3: this is not click-SPECIFIC, which is why the first
        // keystroke below is itself damaged rather than the whole marker.) Typing directly at A1
        // (Calc's own no-click-needed edit start) is what actually proves the fix.
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
    /// view is actually a Writer `SwView` (B, once B is loaded last), the cast fails and that FIRST
    /// call is a silent no-op — a DIFFERENT failure mechanism than the spreadsheet-B variant's
    /// cross-document mutation (there the cast succeeds and B's own active sheet is switched under
    /// it), which is why B never goes dirty here. B's own XML/table structure has no meaning for a
    /// Writer document, so this variant drops those checks — B's own dirty flag and B's own file
    /// bytes remain the checks that matter.
    ///
    /// **Fix round 4 (NEW-3) — the A-side symptom was recorded imprecisely, in both this header and
    /// the raw drill's.** Round 2/3 wrote it as "A's own view never moves off its load-time part"
    /// and (in the raw drill) "the edit is simply lost." Re-measured with the saved bytes dumped:
    /// only the FIRST keystroke is damaged. A's own view DOES move — just one keystroke too late,
    /// because the posted key event's dispatch `GrabFocus`es A and makes it current
    /// (`LOKPostAsyncEvent`, `sfx2/source/view/lokhelper.cxx:1186-1203`, at the pinned LO commit
    /// `11482c8f`), so the SECOND keystroke's `setPart` succeeds and switches A to sheet 2 —
    /// discarding the cell edit the first keystroke had opened on sheet 1. The disabled build leaves
    /// A's Sheet1 untouched and puts the marker MINUS ITS FIRST CHARACTER on sheet 2, one failing
    /// assertion. See `testDirectlyProvesTheInputPathsOwnSetViewPrefixIsLoadBearingBelowTheCanvas
    /// Layer`'s own header for the full four-step account and the dumped bytes.
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
    /// fix round is about. Posting the event to A's window (correctly resolved by `getDocWindow`'s
    /// own self-correction, with or without this fix's `setView`) is itself an ACTIVATION: the event
    /// arrives at A and A becomes the process-global current view as a side effect — so by the time
    /// the NEXT `setPart` runs, A is already current by accident, and the fix under test never gets
    /// a chance to matter. No drill that clicks before typing can discriminate this fix,
    /// mounted-canvas or raw — confirmed by disabling `setView` and observing GREEN across three
    /// independently-designed click-first drills before this was traced.
    ///
    /// **Fix round 4 (NEW-3) — the activation mechanism named above was mis-attributed to the CLICK
    /// specifically, and to a claim about `postKeyEventAsync` that the source contradicts.** An
    /// earlier version of this header said `SfxLokHelper::postKeyEventAsync`/`postMouseEventAsync`
    /// "take that already-resolved window directly and post the event through VCL's own async queue
    /// — they do not re-resolve 'current' at dispatch time." They do, and it is not click-specific.
    /// Read at the pin: `postEventAsync` (`sfx2/source/view/lokhelper.cxx:1273-1291`) stamps every
    /// queued event with `mnView = SfxLokHelper::getCurrentView()` AT POST TIME, and its dispatcher
    /// `LOKPostAsyncEvent` (`:1186-1203`) then calls `SfxLokHelper::setView(pLOKEv->mnView)` if
    /// current has drifted since, followed by `pLOKEv->mpWindow->GrabFocus()` when the target window
    /// does not already hold focus. That `GrabFocus` is the real activation gesture, it runs for
    /// KEY events exactly as much as for mouse ones, and it is why a click was never actually
    /// required to spoil a drill — the FIRST keystroke does it too. The conclusion the round-3
    /// investigation reached (click-first drills cannot discriminate this fix) survives unchanged;
    /// only the reason does, and it is broader than was written.
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
    /// the ONLY thing left that can move A back to part 1 before the marker lands. GREEN with the
    /// fix intact.
    ///
    /// **The disabled-build signature, RE-MEASURED in fix round 4 (NEW-3) with the saved bytes
    /// actually dumped rather than inferred from which assertions fired.** With `setView` deleted
    /// from both dedicated-thread input functions (restored immediately after), the saved file
    /// contains: Sheet1 completely untouched (`NORMA GATE`, `42`), and **Sheet2!A1 = `4EDIT`** — the
    /// marker is `T4EDIT`, so every character but the FIRST lands correctly and the first one is
    /// destroyed. Exactly ONE assertion fails (`the typed marker must appear on A's SHEET 2`, a
    /// substring miss), and B's own dirty flag stays false.
    ///
    /// Round 3 recorded that one-failure count correctly but explained it as "the marker lands on
    /// neither sheet," and the assertion message below claimed the marker would land on SHEET 1.
    /// Both were wrong; the bytes say so. The mechanism that fits them, given `postEventAsync`'s
    /// post-time view stamp and `LOKPostAsyncEvent`'s `GrabFocus` (cited above):
    ///
    ///   1. B was painted last, so B is current. The first `postKey`'s `setPart(A.handle, 1)`
    ///      resolves through `ScDocShell::GetViewData()` → `SfxViewShell::Current()` = B's `SwView`
    ///      → `dynamic_cast<ScTabViewShell*>` fails → silent no-op. A stays on sheet 1.
    ///   2. `postKeyEvent` still reaches A's own window (`getDocWindow`'s self-correction), and its
    ///      dispatch `GrabFocus`es that window — A becomes current, and `T` opens a cell edit on
    ///      **Sheet1!A1**.
    ///   3. The SECOND keystroke's `setPart(A.handle, 1)` now finds A current, succeeds, and
    ///      switches A to sheet 2 — which discards the cell edit that step 2 had opened. `T` is
    ///      gone, having never been committed anywhere.
    ///   4. `4EDIT` types into Sheet2!A1 and Return commits it.
    ///
    /// Steps 1, 2 and 4 are read straight off the cited source plus the dumped bytes; step 3's
    /// "a tab switch discards an open cell edit" is the reading that fits the observation (a `T`
    /// that reached A yet appears nowhere in the saved file) and was not separately traced into
    /// `ScTabView::SetTabNo`.
    ///
    /// **What this proves beyond "the marker lands correctly," matching the finding's own "any
    /// second doc open" framing**: `ScModelObj::setPart`'s static resolution (re-verified at this
    /// codebase's pinned LO commit `11482c8f`) means a misdirected `setPart(A.handle, 1)` — without
    /// this fix — does not merely fail to move A; it ACTS on whichever document is current. B is a
    /// Writer document here specifically so that action is a silent no-op (the `dynamic_cast`-fails
    /// case), which is why the damage stays inside A and B never goes dirty. The sibling drill
    /// below, with B as a SECOND Calc document, demonstrates the OTHER half — a Calc B ACCEPTS the
    /// misdirected call and has its own active sheet switched under it (re-measured in fix round 4:
    /// three failing assertions there, B's dirty flag flipping both before and after A's save, plus
    /// the same "must appear on sheet 2" miss). The Writer-B mounted-canvas drill re-measures at one
    /// failing assertion, matching this one.
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
        // Deliberately NO postMouse here — see this test's own header: any posted LOK event's own
        // dispatch `GrabFocus`es its target window and makes A's frame current as a side effect,
        // independent of this fix, and a click placed BEFORE the typing spends that activation for
        // free — which would make this drill pass regardless of whether setView is present. Calc
        // needs no click to start editing the current cell (A1, from load), so the keystrokes alone
        // are the whole proof; the cost of having no click to spend is that the FIRST keystroke is
        // the one that pays for the activation, which is exactly the damage this drill measures.
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
                      + "this is the guard against the OTHER way the marker could go wrong. Note "
                        + "(fix round 4, NEW-3) that this is NOT the assertion the disabled build "
                        + "fails: measured, the disabled build leaves sheet 1 untouched and puts "
                        + "'4EDIT' — the marker minus its first character — on sheet 2. See this "
                        + "test's own header for the four-step mechanism and the dumped bytes.")
        XCTAssertTrue(sheet1XML.contains("NORMA GATE"), "A's sheet 1 seed content must be untouched")

        runtime.close(pathA)
        runtime.close(pathB)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 4 (NEW-1, CRITICAL) — **the type gate on `setPart`, proven by the caret.**
    ///
    /// Until this round `LOKBridge` issued `setPart(handle, part)` unconditionally ahead of every
    /// tile paint and every key/mouse post. For a Writer document that call is not a viewport
    /// switch at all: `SwXTextDocument::setPart` (`sw/source/uibase/uno/unotxdoc.cxx:3410-3419`,
    /// this codebase's pinned LO commit `11482c8f`) is `pWrtShell->GotoPage(nPart + 1, true)`, and
    /// nothing below it early-outs when the caret is already on that page (`SwWrtShell::GotoPage` →
    /// `SwCursorShell::GotoPage` → `GetLayout()->SetCurrPage(m_pCurrentCursor, nPage)`, all read at
    /// the pin). Norma pins every text document at part 0, so the prefix meant `GotoPage(1)` — "put
    /// the caret at the top of page 1" — before every single tile this document ever painted,
    /// including helper-cache HITS (the prefix runs before `TileRenderer.paint`'s own cache
    /// lookup). LOK's own `doc_paintPartTile` never had this bug because it type-gates the same
    /// call, with the reason written in the source (`desktop/source/lib/init.cxx:4458-4461`): "Text
    /// documents have a single coordinate system; don't change part."
    ///
    /// **The interleave is what makes it user-visible, and it is what this drill reproduces.** A
    /// keystroke is `PostUserEvent`-async on LOK's side (`SfxLokHelper::postKeyEventAsync`) while
    /// `setPart` is synchronous, so a repaint arriving between two keystrokes — a scroll, an
    /// invalidation-driven refetch, a residency-prefetch chunk — moved the caret out from under the
    /// second half of a word. Here the repaint is a real `requestTiles` round trip through the real
    /// helper, sequenced deterministically between two real typing bursts by a real save (both
    /// bursts are confirmed landed through LOK's own `ModifiedStatus` callback before the next step
    /// runs — no sleeps, and no reliance on the async queue's own timing).
    ///
    /// Raw wire client, no canvas: a mounted `OfficeTileCanvasView` would paint on its own schedule
    /// (residency prefetch, invalidation refetch), which is exactly the traffic under test — it must
    /// be the DRILL that decides when a paint interleaves, not the view.
    ///
    /// **Pre-fix signatures, MEASURED (not predicted) by deleting the gates and re-running, gates
    /// restored immediately after each run.** Recorded decomposed, because the two halves of the
    /// finding fail differently and the difference is the point:
    ///
    ///   * **Paint gate deleted, input gates intact** — saved body text
    ///     `EDNORMA GATEoffice stage A embed probeNORMA PAGE TWOT4`. Burst 1 lands correctly at the
    ///     end of page 2; the interleaved paint yanks the caret to page-1 start; burst 2 lands
    ///     there. **2 failing assertions** (the marker-appears-once assertion still holds — the
    ///     burst landed in exactly one, wrong, place).
    ///   * **All three gates deleted (the real pre-round-4 build)** — saved body text
    ///     `DE4TNORMA GATEoffice stage A embed probeNORMA PAGE TWO`. **3 failing assertions.** The
    ///     whole marker is at page-1 start and it is REVERSED, which is the ungated INPUT prefix
    ///     showing its own hand: `GotoPage(1)` ran before EVERY keystroke, so each character was
    ///     inserted at page-1 start and pushed its predecessor right. Plain typing into any Writer
    ///     document — no interleave, no second document, no part switch — was already producing
    ///     reversed text at the top of page 1 before this round; the existing `.odt` round-trip
    ///     drill never noticed because it asserts only "dirty" and "the pixels changed," and
    ///     reversed text at the wrong place satisfies both.
    func testTypingIntoAWriterDocumentSurvivesAnInterleavedTileRepaint() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("two-page.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "two-page.odt fixture missing")

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
        let path = scratchDir.appendingPathComponent("caret-page-two.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: path))

        runtime.open(path)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "the document never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[path] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("open failed: \(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.type, .text, "setup: this drill is ABOUT the text-document gate — a "
                       + "fixture LOK reports as any other kind proves nothing here")
        XCTAssertGreaterThanOrEqual(doc.parts, 2, "setup: two-page.odt must really lay out as two "
                                    + "pages — LOK reports a Writer document's page count as its "
                                    + "part count (SwXTextDocument::getParts = GetPageCnt), so this "
                                    + "is the fixture's own live validation, not a structural guess")

        guard let rawClient = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // Ctrl+End — "go to end of document," which in this fixture is the end of PAGE 2's own
        // paragraph. `KEY_END` (1029, `com.sun.star.awt.Key`) OR'd with the SHIFTED `KEY_MOD1` bit
        // (0x2000, `vcl/keycodes.hxx`) — the same packed-modifier convention `OfficeInputCodes`'s
        // own header derives at length. Deliberately keyboard-only: a click would land the caret by
        // coordinate, which is a second thing that could be wrong, and would also make the drill
        // depend on this fixture's exact page geometry.
        let ctrlEnd = 1029 | 0x2000
        try await rawClient.postKey(docId: doc.docId, part: 0, type: .keyInput, charCode: 0, keyCode: ctrlEnd)
        try await rawClient.postKey(docId: doc.docId, part: 0, type: .keyUp, charCode: 0, keyCode: ctrlEnd)

        // Burst 1. The dirty wait is the SEQUENCING TOOL, not a sleep: `ModifiedStatus=true` is a
        // real LOK callback, so seeing it proves LOK actually consumed both the Ctrl+End and these
        // keystrokes off its own async queue before anything below runs.
        try await typeASCII("T4", client: rawClient, docId: doc.docId)
        let becameDirty = await waitUntil(timeout: 30) { runtime.stateSnapshot.documents[path]?.dirty == true }
        XCTAssertTrue(becameDirty, "the first typing burst never marked the document dirty")

        // A real save, mid-drill — and the second half of the sequencing tool: `.uno:Save` clears
        // `ModifiedStatus`, which gives burst 2 its own unambiguous dirty edge to wait on below.
        // (`doc_saveAs` with no filter options takes the `storeToURL` branch — a copy, so the
        // document's own medium is untouched and a second save later in this drill is ordinary.)
        runtime.save(path)
        let cleared = await waitUntil(timeout: 30) { runtime.stateSnapshot.documents[path]?.dirty == false }
        XCTAssertTrue(cleared, "the mid-drill save never cleared the dirty flag")

        // THE INTERLEAVE — a real tile paint, through the real helper, exactly the traffic a scroll
        // or a refetch would produce. Pre-fix this is `setPart(handle, 0)` → `GotoPage(1)` → the
        // caret is yanked to the top of page 1, and burst 2 lands there instead.
        let zoomPPT = 1000
        let originKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        try await rawClient.requestTiles(docId: doc.docId, keys: [originKey])
        let painted = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: originKey) != nil }
        XCTAssertTrue(painted, "the interleaved tile paint never delivered — this drill's whole "
                      + "point is that a paint ran between the two typing bursts")

        // Burst 2 — the half the pre-fix build misplaces.
        try await typeASCII("ED", client: rawClient, docId: doc.docId)
        let dirtyAgain = await waitUntil(timeout: 30) { runtime.stateSnapshot.documents[path]?.dirty == true }
        XCTAssertTrue(dirtyAgain, "the second typing burst never marked the document dirty again")

        let beforeSaveStat = officeFileStat(atPath: path)
        runtime.save(path)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: path) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "the final save never landed on disk")

        // Read the SAVED bytes back, the standard every other drill in this file holds itself to.
        let text = strippedODFBodyText(try readODFContentXML(atPath: path))
        XCTAssertTrue(text.contains("NORMA PAGE TWOT4ED"),
                      "the whole typed marker must sit where it was typed, at the end of page 2 — "
                        + "got: \(text)")
        XCTAssertTrue(text.hasPrefix("NORMA GATE"),
                      "page 1 must still begin with its own seed text — anything in front of it is "
                        + "text that was typed on page 2 and landed at page-1 start, which is "
                        + "exactly what an ungated setPart's GotoPage(1) does to the caret. got: \(text)")
        XCTAssertEqual(text.components(separatedBy: "ED").count - 1, 1,
                       "the marker's second burst must appear exactly once — twice would mean it "
                        + "landed in two places, none would mean it was swallowed. got: \(text)")

        // Reopen: the saved file is still a real, parseable two-page Writer document, not something
        // that merely happens to contain the right characters.
        runtime.close(path)
        let closed = await waitUntil(timeout: 30) { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(closed, "the document never closed")
        runtime.open(path)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the saved document never reopened")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.type, .text, "reopened as a text document")
        XCTAssertGreaterThanOrEqual(runtime.stateSnapshot.documents[path]?.parts ?? 0, 2,
                                    "the saved document still lays out as two pages")

        runtime.close(path)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Fix round 4 (NEW-2) — **a save records the USER's own active sheet, not whichever part a
    /// tile paint last left LOK parked at.**
    ///
    /// `saveAsOnDedicatedThread` used to be the one current-view-dependent job in `LOKBridge` with
    /// no `setPart` prefix at all: it simply inherited whatever part the last paint had set. That is
    /// a real window, not a theoretical one — a residency-prefetch chunk cut mid-flight by a part
    /// switch is still delivered, so a paint carrying the OLD part can re-park LOK there after the
    /// user has already moved on, and if the new part's tiles are already cached no corrective paint
    /// follows to move it back. Round 3's own paint-prefix comment argued this could not happen
    /// ("there is no path where a paint's own `key.part` could differ from what the user is actually
    /// looking at"); that was true of how every `TileKey` is CONSTRUCTED and false of when one is
    /// PAINTED. Rather than police paint ordering, the save now asserts the answer itself.
    ///
    /// The stale chunk is modelled exactly, and deliberately at the wire: `runtime.subscribeTiles`
    /// moves the reducer's own `activePart` to 1 (sheet 2 — this is the user), and then a RAW
    /// `client.requestTiles` for a part-0 key re-parks LOK at sheet 1 behind the runtime's back.
    /// A raw request is the only faithful model here: an in-flight chunk was enqueued before the
    /// switch, so by definition it does not carry the new `activePart` — routing it through
    /// `runtime` would re-derive the part and model nothing.
    ///
    /// Pre-fix signature, measured with the `setPart` line deleted from `saveAsOnDedicatedThread`
    /// (restored immediately after): the saved `settings.xml` records `ActiveTable` = `Sheet1`.
    func testASaveRecordsTheUsersOwnActiveSheetNotWhereAStalePaintLeftLOK() async throws {
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

        let scratchDir = makeScratchDirectory()
        let path = scratchDir.appendingPathComponent("stale-part-save.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: path))

        runtime.open(path)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "the document never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[path] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("open failed: \(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.parts, 2, "setup: the two-sheet fixture really has two sheets")

        guard let rawClient = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // The USER moves to sheet 2 — through the runtime, so the reducer's own `activePart` moves
        // with them. This is the value the save must honour.
        let zoomPPT = 1000
        let part1Key = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: path, part: 1, zoomPPT: zoomPPT, viewportTwips: viewport)
        let part1Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: part1Key) != nil }
        XCTAssertTrue(part1Arrived, "the sheet-2 tile never arrived — setup")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.activePart, 1,
                       "setup: the reducer records the user on sheet 2")

        // THE STALE CHUNK — a part-0 paint completing after the switch, raw, behind the runtime's
        // back. LOK is now parked at sheet 1 while the user is on sheet 2, with the sheet-2 tiles
        // already cached so nothing will paint them again to correct it.
        let part0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        try await rawClient.requestTiles(docId: doc.docId, keys: [part0Key])
        let part0Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: part0Key) != nil }
        XCTAssertTrue(part0Arrived, "the stale part-0 paint never landed — this drill's whole point "
                      + "is that a paint re-parked LOK before the save")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.activePart, 1,
                       "the stale paint must NOT have moved the runtime's own idea of the active "
                        + "part — a raw wire request bypasses the reducer entirely, which is exactly "
                        + "what makes it a faithful model of an in-flight chunk")

        let beforeSaveStat = officeFileStat(atPath: path)
        runtime.save(path)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: path) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "the save never landed on disk")

        let settings = try readODFEntry(atPath: path, entry: "settings.xml")
        let activeTable = activeTableName(in: settings)
        XCTAssertEqual(activeTable, "Sheet2", "the saved view state must record the sheet the USER "
                       + "was on, not the one a stale prefetch paint left LOK parked at — see "
                        + "LOKBridge.saveAsOnDedicatedThread's own header (fix round 4, NEW-2)")

        runtime.close(path)
        await runtime.awaitPendingCloseBarriersForTesting() // same raw-client interleave as above
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// `unzip -p` for any single entry — `readODFContentXML` above, generalised, so a drill that
    /// needs `settings.xml` (the saved VIEW state, as opposed to the saved content) does not need a
    /// second copy of the same four lines.
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

    /// The `ActiveTable` config item's value out of an ODF `settings.xml` — ODF's own name for
    /// "which sheet this document opens on." `nil` if the item is absent, which the caller must
    /// treat as a failure rather than as "no opinion": a spreadsheet saved with no recorded active
    /// sheet would mean this drill's whole mechanism had gone missing.
    private func activeTableName(in settings: String) -> String? {
        let marker = "config:name=\"ActiveTable\""
        guard let name = settings.range(of: marker),
              let open = settings.range(of: ">", range: name.upperBound..<settings.endIndex),
              let close = settings.range(of: "<", range: open.upperBound..<settings.endIndex) else {
            return nil
        }
        return String(settings[open.upperBound..<close.lowerBound])
    }

    /// Types `marker`'s own ASCII characters through the raw wire client, one `keyInput`/`keyUp`
    /// pair each. Same test-local table convention as `postRealEdit` above (uppercase letters OR'd
    /// with `KEY_SHIFT`, matching how a real user actually holds Shift to type them) — deliberately
    /// NOT `OfficeInputCodes`, which is keyed by AppKit PHYSICAL keyCode and has no meaning without
    /// an `NSEvent`. No Return at the end: for a Writer document a Return is a real paragraph break,
    /// which would split the very text this drill's caller then asserts is contiguous.
    private func typeASCII(_ marker: String, client: OfficeHelperClient, docId: String) async throws {
        let keyCodes: [Character: Int] = [
            "T": 531 | 0x1000, "E": 516 | 0x1000, "D": 515 | 0x1000, "I": 520 | 0x1000, "4": 260,
        ]
        for character in marker {
            let keyCode = try XCTUnwrap(keyCodes[character], "typeASCII was handed a character with "
                                        + "no test-local keyCode: \(character)")
            let charCode = try XCTUnwrap(character.asciiValue.map(Int.init))
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
    }

    /// Everything between `<office:text>` and `</office:text>` with every XML tag removed — the
    /// paragraph text of a Writer document, in document order, with no markup. Used instead of a
    /// substring search over raw `content.xml` because LO is free to split a run of typed characters
    /// across several `<text:span>` elements (it does, whenever formatting or a redline boundary
    /// falls mid-run), which would make a raw-XML "the marker is contiguous" assertion fail for a
    /// reason that has nothing to do with where the caret was.
    private func strippedODFBodyText(_ content: String) -> String {
        // `<office:text` with no `>` — the OPEN TAG carries attributes on a real LO save
        // (`text:use-soft-page-breaks="true"` appears the moment a document lays out on more than
        // one page, which this drill's fixture does by construction). Matching `"<office:text>"`
        // whole found nothing and silently returned "" — caught by this drill's own first live run,
        // which failed with an empty `got:` in all three assertion messages rather than a wrong one.
        guard let start = content.range(of: "<office:text"),
              let openEnd = content.range(of: ">", range: start.upperBound..<content.endIndex),
              let end = content.range(of: "</office:text>", range: openEnd.upperBound..<content.endIndex) else {
            return ""
        }
        let body = String(content[openEnd.upperBound..<end.lowerBound])
        var out = ""
        var inTag = false
        for character in body {
            if character == "<" { inTag = true; continue }
            if character == ">" { inTag = false; continue }
            if !inTag { out.append(character) }
        }
        return out
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

    // MARK: - dirty-close-helper-kill fix: the drain, proven repeatedly against the real helper

    /// **The mechanism proof for `OfficeRuntime.drainUntilClean`** — full account:
    /// `.superpowers/sdd/2026-08-20-office-editable/dirty-close-helper-kill-fix-report.md`; original
    /// diagnosis `.superpowers/sdd/2026-08-22-office-agent-tools/task-2-report.md` §6/§7 concern 1.
    ///
    /// Reproduces the EXACT sequence `ShellSessionHost.resolveDirtyDocumentTabClose`'s Save choice
    /// drives against a real document, through REAL production wiring (`ShellSessionHost
    /// .officeRuntime` -> the real `OfficeHelperSupervisor` -> the real, seatbelted
    /// `NormaOfficeHelper` -> the real vendored LibreOffice) — never `ShellSessionHost`'s own
    /// panel-tab/sheet machinery, which this codebase's `ShellSessionHostTests` always drives against
    /// a FAKE driver on purpose (that file's own `makeHost` comment: two office-live tests racing the
    /// SAME real helper subprocess was measured directly, mid-review, as a source of failures
    /// unrelated to whatever either test was actually proving). This is the "manual path" the
    /// diagnostic matrix itself used (task-2-report.md's evidence table, diagC/diagC-prime) to
    /// isolate the drain as the one variable — open, real typed edit, `saveAndAwaitOutcome`, drain,
    /// close, repeated — reproduced here as a permanent regression tripwire rather than the temporary
    /// diagnostic methods that report's own Appendix says were "deleted before the final commit."
    /// `ShellSessionHostTests.testRequestCloseTabOnADirtyDocumentTabSaveChoiceThatSucceedsWaitsForThe
    /// DrainRoundTripBeforeClosing` (plus its own
    /// `...SaveRetryThatSucceedsAfterAnEarlierFailureStillWaitsForTheDrain` sibling, added at the
    /// fix-round review that found the drain's first `dirty`-gated version unsound — see
    /// `OfficeRuntime.drainUntilClean`'s own doc comment) is this fix's OTHER half — the fast,
    /// always-run wiring pin that catches a regression at the call site alone, against a fake driver
    /// whose `clipboardCopy` a test can suspend on demand; this test instead proves the underlying
    /// MECHANISM truly holds against real LOK's own `clipboardCopy`, which a fake driver cannot.
    ///
    /// **Looped 5 times on ONE runtime/helper, not 5 independent helpers** — the bug is specifically
    /// that closing ONE document kills the process every OTHER open document also depends on
    /// (`OfficeHelperRequestQueue` is one FIFO across every session, this file's own header). Proving
    /// the fix means proving the SAME helper survives repeatedly, not that five fresh helpers each
    /// survive once. Each lap both exercises the fix and re-opens the just-closed path — doubling as
    /// the next lap's own "the helper is still genuinely functional, not merely technically
    /// `isRunning`" proof, the same reasoning task-2-report.md gives for keeping its own committed
    /// tripwire on one runtime rather than a fresh host per assertion. A final reopen after the last
    /// lap covers the one case looping alone would miss: whether the LAST close was itself lethal,
    /// with nothing left in the loop to reveal it.
    ///
    /// **This test's own RED measurement is not committed here** (this codebase's own established
    /// practice, per the diagnostic matrix's own history) — done by hand for the fix's SDD report:
    /// comment out the one `await runtime.drainUntilClean(docPath)` line below, rerun, record how
    /// many of the 5 laps saw the helper die. The report names the observed rate both ways.
    func testDirtyCloseSheetSaveSequenceRepeatedlyThroughTheRealHelperNeverKillsTheSharedProcess() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("dirty-close-loop.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        let iterations = 5
        for lap in 1...iterations {
            runtime.open(docPath)
            let settled = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(settled, "lap \(lap): never settled — phase: \(runtime.stateSnapshot.phase)")
            guard let doc = runtime.stateSnapshot.documents[docPath] else {
                return XCTFail("lap \(lap): open failed — "
                               + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
            }
            guard let client = host.officeHelperSupervisor?.client else {
                return XCTFail("lap \(lap): no live client to drive the real edit door through")
            }
            try await postRealEdit(client: client, docId: doc.docId, marker: "T4EDIT")
            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "lap \(lap): the real edit never marked the document dirty")

            // The dirty-close sheet's own Save door — `saveAndAwaitOutcome`, not the fire-and-forget
            // `save`, exactly matching `resolveDirtyDocumentTabClose`'s own call.
            let outcome = await runtime.saveAndAwaitOutcome(docPath)
            XCTAssertEqual(outcome, .saved, "lap \(lap): expected a clean save")

            // THE FIX under test — this test's own header has the RED-measurement instruction.
            let drained = await runtime.drainUntilClean(docPath)
            XCTAssertTrue(drained, "lap \(lap): the drain's own round trip (driver.clipboardCopy) "
                          + "timed out rather than completing — not itself a failure (the write "
                          + "already landed regardless) but worth knowing if a 15s stall starts "
                          + "happening for real")

            runtime.close(docPath)
            // ⚠️ **`awaitPendingCloseBarriersForTesting` is REQUIRED in any drill that mixes
            // `runtime.close` with RAW `OfficeHelperClient` calls, and this is a real hazard, not
            // hygiene.** `OfficeHelperClient.expectReply` does not demultiplex: it reads the NEXT
            // frame off the connection and requires `reply.seq == seq`. Strict request/response
            // serialization is guaranteed only by `ShellSessionHost`'s single
            // `OfficeHelperRequestQueue`, which a drill talking to the client DIRECTLY bypasses. So
            // an app-issued close still in flight and a drill's own raw `postKey` can interleave,
            // and one of them reads the other's reply — surfacing as `office helper sent an
            // unexpected reply: closed(seq: …)`. office-instant-save Job 1 did not create that
            // hazard (the close was always a spawned Task) but it WIDENED the window from ~0 to the
            // barrier's own ~50 ms round trip, which is enough to make it reproduce under full-suite
            // contention. Measured: this drill failed exactly that way in a full-suite run and
            // passes 3/3 in isolation without the wait.
            await runtime.awaitPendingCloseBarriersForTesting()

            guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
                return XCTFail("lap \(lap): supervisor has no live process left to check")
            }
            XCTAssertTrue(isProcessAlive(helperPID), "lap \(lap): the shared helper died after an "
                          + "ordinary dirty-close-sheet Save sequence")
        }

        // The strongest liveness proof (task-2-report.md's own reasoning for its committed tripwire):
        // a dead/zombie helper cannot complete a fresh open, whereas `isProcessAlive` alone only
        // proves the PID still exists, not that the process can still do anything useful. This also
        // covers the one case the loop above alone would miss: whether the LAST close was itself
        // lethal, with no further lap left to reveal it.
        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the helper survived every close but could not complete one more "
                      + "open — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[docPath], "final liveness reopen must "
                        + "succeed: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - office-instant-save Job 1: the CLEAN-tab close, with no drain at its call site

    /// **The clean-tab `×` route's own mechanism proof — the half `testDirtyCloseSheetSaveSequence
    /// RepeatedlyThroughTheRealHelperNeverKillsTheSharedProcess` (immediately above) structurally
    /// cannot see.** That drill calls `runtime.drainUntilClean(docPath)` explicitly, because the
    /// sequence it reproduces (`ShellSessionHost.resolveDirtyDocumentTabClose`'s Save choice) does.
    /// This one deliberately does **not** — because the route it reproduces does not either.
    ///
    /// `ShellSessionHost.requestCloseTab`'s CLEAN `.document` leg (`:1500-1502`) goes straight to
    /// `closePanelTab`, whose office arm calls `officeRuntime.close(path)` inline (`:1739`) with no
    /// barrier of any kind between the save that just made the tab clean and the close. A save is
    /// exactly what makes a dirty tab clean, so "⌘S, then click the `×`" reaches that leg by hand,
    /// and the re-review measured that timing killing the shared helper 2 of 3 times
    /// (`.superpowers/research/office-live-edit-rereview.md` Q3(c)). Because
    /// `OfficeHelperRequestQueue` is ONE app-wide FIFO, a death here takes every other open office
    /// document with it.
    ///
    /// So the fix cannot live at a call site: it lives inside `close(_:)`'s own `.helperClose`
    /// performer, which is the single imperative site any real close reaches. This drill is what
    /// pins that — it saves and closes with **nothing** in between, five times on ONE helper (same
    /// reasoning as the drill above: the bug is that closing one document kills the process every
    /// OTHER document shares, so the proof has to be that the SAME helper survives repeatedly), and
    /// asserts the barrier is a real bounded round trip rather than a stall.
    ///
    /// **RED/GREEN, measured not narrated** — full counts in
    /// `.superpowers/research/office-close-race-report.md`. Red arm: empty out
    /// `OfficeRuntime.awaitCloseBarrier`'s body (leaving the test hook), rebuild, rerun. Control arm:
    /// replace that body with an unconditional 20 s sleep — the `<10 s` bound below must go red, which
    /// is what proves this drill discriminates "the barrier does real, bounded work" from "everything
    /// simply waits."
    func testCleanCloseImmediatelyAfterASaveRepeatedlyThroughTheRealHelperNeverKillsTheSharedProcess() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("clean-close-loop.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        let iterations = 5
        for lap in 1...iterations {
            runtime.open(docPath)
            let settled = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(settled, "lap \(lap): never settled — phase: \(runtime.stateSnapshot.phase)")
            guard let doc = runtime.stateSnapshot.documents[docPath] else {
                return XCTFail("lap \(lap): open failed — "
                               + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
            }
            guard let client = host.officeHelperSupervisor?.client else {
                return XCTFail("lap \(lap): no live client to drive the real edit door through")
            }
            try await postRealEdit(client: client, docId: doc.docId, marker: "T4EDIT")
            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "lap \(lap): the real edit never marked the document dirty")

            let outcome = await runtime.saveAndAwaitOutcome(docPath)
            XCTAssertEqual(outcome, .saved, "lap \(lap): expected a clean save")

            // **Nothing between the save and the close.** No `drainUntilClean`, no wait on `dirty`,
            // no sleep — exactly what `closePanelTab`'s office arm does after a ⌘S has left the tab
            // clean. The barrier under test is the one INSIDE `close`.
            let closeIssuedAt = Date()
            runtime.close(docPath)
            XCTAssertNil(runtime.stateSnapshot.documents[docPath],
                         "lap \(lap): close must still be synchronous in the reducer's own state — "
                         + "the barrier defers the HELPER request, never the state transition")
            // Deterministic, and not decoration: without this the liveness check below could run
            // before `driver.close` had even been issued, which would make the whole drill vacuous.
            await runtime.awaitPendingCloseBarriersForTesting()
            let barrierElapsed = Date().timeIntervalSince(closeIssuedAt)
            XCTAssertLessThan(barrierElapsed, 10.0, "lap \(lap): the close barrier must be a real "
                              + "bounded round trip, not a stall — this is the control arm that "
                              + "keeps 'the fix works' distinguishable from 'everything waits'")

            guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
                return XCTFail("lap \(lap): supervisor has no live process left to check")
            }
            XCTAssertTrue(isProcessAlive(helperPID), "lap \(lap): the shared helper died on a plain "
                          + "`runtime.close` taken straight after a save — the clean-tab `×` route")
        }

        // Same final-liveness reasoning as the dirty-close drill above: `isProcessAlive` proves a PID
        // exists, a completed fresh open proves the process can still do something. Also the only
        // thing that can reveal a LAST close that was itself lethal.
        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the helper survived every close but could not complete one more "
                      + "open — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[docPath], "final liveness reopen must "
                        + "succeed: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - office-instant-save review IMPORTANT-1: teardown is a close door too

    /// **The door the first version of the close barrier missed, and the comment that missed it
    /// claimed completeness.** `.helperClose`'s performer is not the only way a document is closed
    /// on the helper — `performTeardown` closes every document a runtime holds, without going
    /// through that effect at all. The first fix exempted it by arguing that teardown's caller stops
    /// the helper process anyway. That is true of `ShellSessionHost
    /// .teardownAllOfficeRuntimesAndStopHelper` and **false** of
    /// `ShellSessionHost.releaseOfficeRuntimeIfClean` (`:1290-1295`), which calls `.teardown()`
    /// directly, never touches the supervisor, and runs on a session hop (`:2856`) or when the shell
    /// is hidden (`:2954`).
    ///
    /// It releases a runtime **only when it is CLEAN** — and a save is exactly what makes a runtime
    /// clean. So "⌘S, then switch sessions" was the same lethal timing as "⌘S, then click ×", except
    /// on a helper that goes right on living and serving every other session's documents.
    ///
    /// **That last part is what this drill proves and the other two cannot.** It keeps a SECOND
    /// session's document open throughout and never tears that one down — so a death here is
    /// observed the way a user would observe it: somebody else's document stops working. Each lap
    /// mints a fresh runtime under a fresh session id, which is what a hop away and back actually
    /// produces.
    ///
    /// Typing goes through `OfficeRuntime`'s own input doors, not the raw client, so this drill
    /// never touches the raw-client interleave documented on the dirty-close loop above.
    ///
    /// **RED/GREEN measured** — counts in `.superpowers/research/office-close-race-report.md`. Red
    /// arm: replace `performTeardown`'s `makeBarrieredClose` with the plain
    /// `Task { [driver] in await driver.close(docId) }` it used to be.
    func testTeardownRightAfterASaveNeverKillsTheHelperANOTHERSessionIsStillUsing() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("hop-teardown.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))
        let bystanderPath = scratchDir.appendingPathComponent("bystander.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: bystanderPath))

        // The innocent bystander — another session's open document, never torn down. The whole point
        // of the bug is that ONE session's close kills the process every OTHER session shares.
        let bystander = host.officeRuntime(for: "S-bystander")
        bystander.open(bystanderPath)
        let bystanderOpened = await waitUntil(timeout: 90) {
            bystander.stateSnapshot.documents[bystanderPath] != nil || bystander.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bystanderOpened, "setup: the bystander session's document never opened")
        XCTAssertNotNil(bystander.stateSnapshot.documents[bystanderPath], "setup: bystander open failed")

        let keyCodes: [Character: Int] = [
            "T": 531 | 0x1000, "E": 516 | 0x1000, "D": 515 | 0x1000, "I": 520 | 0x1000, "4": 260,
        ]

        for lap in 1...5 {
            // A FRESH runtime under a fresh session id — what hopping away and back produces.
            let sessionId = "S-hop-\(lap)"
            weak var weakRuntime: OfficeRuntime?
            do {
                let runtime = host.officeRuntime(for: sessionId)
                weakRuntime = runtime
                runtime.open(docPath)
                let settled = await waitUntil(timeout: 90) {
                    runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
                }
                XCTAssertTrue(settled, "lap \(lap): never settled — phase: \(runtime.stateSnapshot.phase)")
                guard runtime.stateSnapshot.documents[docPath] != nil else {
                    return XCTFail("lap \(lap): open failed — "
                                   + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
                }

                for character in "T4EDIT" {
                    let keyCode = try XCTUnwrap(keyCodes[character])
                    let charCode = try XCTUnwrap(character.asciiValue.map(Int.init))
                    runtime.postKeyEvent(path: docPath, type: .keyInput, charCode: charCode, keyCode: keyCode)
                    runtime.postKeyEvent(path: docPath, type: .keyUp, charCode: charCode, keyCode: keyCode)
                }
                runtime.postKeyEvent(path: docPath, type: .keyInput, charCode: 0, keyCode: 1280)
                runtime.postKeyEvent(path: docPath, type: .keyUp, charCode: 0, keyCode: 1280)

                let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
                XCTAssertTrue(becameDirty, "lap \(lap): the typed edit never marked the document dirty")

                let outcome = await runtime.saveAndAwaitOutcome(docPath)
                XCTAssertEqual(outcome, .saved, "lap \(lap): expected a clean save")

            } // the drill's OWN reference dies here, so the host holds the only one left

            // **The gesture: save, then leave the session — through the REAL door.**
            // `teardownOfficeRuntime(for:)` is `officeRuntimes.removeValue(forKey:)?.teardown()`,
            // byte-for-byte the line `releaseOfficeRuntimeIfClean` runs (`ShellSessionHost.swift`
            // `:1277` and `:1294`). Calling `runtime.teardown()` on a reference the drill still
            // holds would NOT reproduce this: the whole hazard is that the temporary returned by
            // `removeValue` is the LAST strong reference and dies the moment `teardown()` returns.
            // The supervisor is deliberately NOT stopped, mirroring that method.
            let teardownAt = Date()
            host.teardownOfficeRuntime(for: sessionId)

            // **Non-vacuity, and the settle, in one assertion.** The runtime going away is proof the
            // drill really did reproduce the release lifecycle rather than a retained teardown — and
            // with `makeBarrieredClose`'s STRONG capture it is also the barrier's completion signal,
            // because the task is what holds the last reference until it finishes.
            let released = await waitUntil(timeout: 20) { weakRuntime == nil }
            XCTAssertTrue(released, "lap \(lap): the runtime never deallocated — this drill is not "
                          + "reproducing releaseOfficeRuntimeIfClean's lifecycle and cannot testify")
            XCTAssertLessThan(Date().timeIntervalSince(teardownAt), 10.0,
                              "lap \(lap): teardown's barrier must be a bounded round trip, not a "
                              + "stall — the same control arm the clean-close drill carries")

            guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
                return XCTFail("lap \(lap): supervisor has no live process left to check")
            }
            XCTAssertTrue(isProcessAlive(helperPID), "lap \(lap): the shared helper died when ONE "
                          + "session was released straight after a save — and another session's "
                          + "document was open on it the whole time")
        }

        // The bystander is the real verdict: a dead or wedged helper cannot still serve it. Closing
        // and reopening ITS document proves the process is functional, not merely PID-alive.
        bystander.close(bystanderPath)
        await bystander.awaitPendingCloseBarriersForTesting()
        bystander.open(bystanderPath)
        let bystanderStillWorks = await waitUntil(timeout: 90) {
            bystander.stateSnapshot.documents[bystanderPath] != nil || bystander.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(bystanderStillWorks, "the bystander session could not complete one more open "
                      + "— phase: \(bystander.stateSnapshot.phase)")
        XCTAssertNotNil(bystander.stateSnapshot.documents[bystanderPath],
                        "the bystander session's document must still open after five hop-releases: "
                        + "\(bystander.stateSnapshot.openFailures[bystanderPath] ?? "no reason recorded")")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - office-instant-save Job 2: what an ARMED instant save actually does to a close

    /// **The drill Job 2's decision had to be taken on, because the drill the brief named turned out
    /// to be BLIND to instant save — measured, not suspected.**
    ///
    /// `testTypingOnSheetTwoLandsOnSheetTwoNotSheetOneThroughSaveAndReopen` was the stated criterion
    /// ("armed, it fails 2 of 3"). On this machine it does not discriminate at all: a probe in
    /// `fireAutoSave` showed that armed, across 8 runs, it issues **zero** auto-saves — the whole
    /// drill completes inside the 0.9 s production debounce, so `autoSaveEnabled` makes no observable
    /// difference to it in EITHER direction. It passes armed for the same reason it passes disarmed.
    /// Full counts: `.superpowers/research/office-close-race-report.md`.
    ///
    /// So this drill exists to ask the question that one cannot. It arms **its own runtime instance
    /// only** — `autoSaveEnabled` is an instance `var`, so nothing here can touch the shipped
    /// default, which is exactly why the parked feature stays testable — shortens the debounce, and
    /// then does the thing that was supposed to be lethal: it lets a real auto-save land and closes
    /// the document on top of it, with **no explicit save anywhere in the drill at all**.
    ///
    /// **It cannot pass vacuously.** The only thing that can write the file here is instant save
    /// itself, so `autoSaved` failing means the drill was inert rather than green — the assertion is
    /// worded that way on purpose. Five laps on ONE helper, for the reason the two drills above give:
    /// the bug is that closing one document kills the process every OTHER open document shares.
    ///
    /// **RED/GREEN measured**: with `OfficeRuntime.awaitCloseBarrier`'s body emptied this drill dies;
    /// with it in place it does not. Counts in the report.
    func testAnArmedInstantSaveFollowedImmediatelyByACloseNeverKillsTheSharedHelper() async throws {
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
        // **This runtime instance only.** `autoSaveEnabled` is an instance `var` with no setting,
        // plist, `UserDefaults` or wire operand behind it, so arming it here cannot reach the
        // production default — see its own doc comment.
        runtime.autoSaveEnabled = true
        // `autoSaveDebounceInterval` is deliberately LEFT AT PRODUCTION'S OWN 0.9 s. Shortening it
        // would be the wrong knob to turn: `noteEditActivity` arms the timer at key ENQUEUE time,
        // not delivery, so an interval shorter than the input chain's own drain lets `fireAutoSave`
        // run while the document is still clean, where its guard (1) refuses — and the drill would
        // go inert again for a NEW reason. The five extra seconds are the price of the drill
        // measuring the shipped timing rather than a convenient one.

        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("instant-save-close.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        // The close is taken from INSIDE the auto-save's own completion, so it lands at the exact
        // instant the save resolved rather than one poll later.
        final class CloseBox { var closedAt: Date? }
        let box = CloseBox()
        runtime.onAutoSaveFinishedForTesting = { [weak runtime] savedPath in
            guard savedPath == docPath, box.closedAt == nil else { return }
            box.closedAt = Date()
            runtime?.close(savedPath)
        }

        let iterations = 5
        for lap in 1...iterations {
            runtime.open(docPath)
            let settled = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(settled, "lap \(lap): never settled — phase: \(runtime.stateSnapshot.phase)")
            guard let doc = runtime.stateSnapshot.documents[docPath] else {
                return XCTFail("lap \(lap): open failed — "
                               + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
            }
            guard let client = host.officeHelperSupervisor?.client else {
                return XCTFail("lap \(lap): no live client to drive the real edit door through")
            }
            let beforeStat = officeFileStat(atPath: docPath)
            // ⚠️ **Through `OfficeRuntime`'s OWN input doors — NOT `postRealEdit`.** That helper goes
            // straight at `OfficeHelperClient.postKey`, bypassing the runtime entirely, and
            // `noteEditActivity` is called from the runtime's doors and nowhere else: the
            // `ModifiedStatus` belt its own header used to describe was deliberately removed (see
            // the `.modifiedStatus` case in `handleHelperEvent`, and that header, now corrected).
            // A first version of this drill used `postRealEdit` and was INERT in 5 of 5 laps —
            // armed, with a 0.3 s debounce and a 30 s wait, instant save never wrote the file once,
            // because nothing had armed it. The `autoSaved` assertion below is what caught that,
            // which is the whole reason it is worded as "inert rather than passing".
            let keyCodes: [Character: Int] = [
                "T": 531 | 0x1000, "E": 516 | 0x1000, "D": 515 | 0x1000, "I": 520 | 0x1000, "4": 260,
            ]
            for character in "T4EDIT" {
                let keyCode = try XCTUnwrap(keyCodes[character])
                let charCode = try XCTUnwrap(character.asciiValue.map(Int.init))
                runtime.postKeyEvent(path: docPath, type: .keyInput, charCode: charCode, keyCode: keyCode)
                runtime.postKeyEvent(path: docPath, type: .keyUp, charCode: charCode, keyCode: keyCode)
            }
            // Return — commits the pending Calc cell edit.
            runtime.postKeyEvent(path: docPath, type: .keyInput, charCode: 0, keyCode: 1280)
            runtime.postKeyEvent(path: docPath, type: .keyUp, charCode: 0, keyCode: 1280)
            _ = client // the live client is resolved above only to prove the helper is actually up

            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "lap \(lap): the real edit never marked the document dirty")

            // **The lethal timing, taken with ZERO latency.** A first version of this drill polled
            // the file's own stat every 20 ms and closed when it changed; with the close barrier
            // REMOVED that version still passed 3 of 3, because the window is narrower than one
            // poll. `onAutoSaveFinishedForTesting` fires synchronously at the instant the
            // auto-save's `saveAndAwaitOutcome` resolves, which is exactly where the clean-close
            // drill takes its close. See that property's own doc.
            let closedAt = await waitUntil(timeout: 30) { box.closedAt != nil }
            XCTAssertTrue(closedAt, "lap \(lap): instant save never completed a save of its own — "
                          + "this drill is INERT rather than passing if this fails, because nothing "
                          + "else here calls any save door at all")
            XCTAssertNotEqual(officeFileStat(atPath: docPath), beforeStat,
                              "lap \(lap): instant save resolved but nothing reached the real path")
            await runtime.awaitPendingCloseBarriersForTesting()
            XCTAssertLessThan(Date().timeIntervalSince(box.closedAt ?? Date()), 10.0,
                              "lap \(lap): the close barrier must stay a bounded round trip even with "
                              + "instant save armed — the control arm, same as the clean-close drill")
            box.closedAt = nil

            guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
                return XCTFail("lap \(lap): supervisor has no live process left to check")
            }
            XCTAssertTrue(isProcessAlive(helperPID),
                          "lap \(lap): the shared helper died on a close taken straight after an "
                          + "INSTANT save — Job 2's own blocker")
        }

        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the helper survived every close but could not complete one more "
                      + "open — phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[docPath], "final liveness reopen must "
                        + "succeed: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - The r4 vendor re-cut: .docx is a read-WRITE format again, end to end

    /// **The docx drill the read-only demotion existed in place of.** Whole-branch review I2 held
    /// `.docx` read-only because the r3 vendor tree could not export it at all; the r4 re-cut adds
    /// the missing DOCX export service (`libmswordlo.dylib`, holding
    /// `com.sun.star.comp.Writer.DocxExport` — `PanelEditorTab.swift`'s `officeReadWriteExtensions`
    /// has the mechanism), and this is the drill that has to be green before that demotion may be
    /// lifted. `OfficeHelperLiveTests.testXlsxDocxPptxSaveRoundTripThroughTheRealHelperAfterTheR4
    /// VendorRecut`'s own docx leg proves the HELPER can render the bytes into `<state-path>/saves/`;
    /// this proves the whole app-side pipeline behind it — real staged copy, real typed edit through
    /// the real wire, real ⌘S door, `placeAtomically` onto the USER'S OWN PATH, reopen — which is
    /// the part a helper-only test structurally cannot see.
    ///
    /// **Three proofs, deliberately layered** (a file merely changing size proves none of them):
    /// 1. **Placement** — the bytes land at `docPath` itself, the staged copy's ORIGINAL location,
    ///    not in the helper's `saves/` scratch. Asserted by dumping the entry out of the real path.
    /// 2. **Dumped bytes** — `word/document.xml` at that path carries BOTH the typed marker and the
    ///    fixture's own seed text, so the save persisted the edited document rather than re-writing
    ///    the original (the failure mode a stat/mtime check cannot distinguish), and
    ///    `[Content_Types].xml` declares the WordprocessingML main-document part, so what landed is
    ///    a genuine DOCX and not an ODF payload wearing a `.docx` name (the exact substitution T7's
    ///    autosave fallback used to make on purpose).
    /// 3. **Reopen** — LOK re-parses those same bytes as a `.text` document, and the repainted tile
    ///    differs from the pre-edit one.
    ///
    /// Same real-helper/real-seatbelt setup as
    /// `testSaveThroughTheRealEditDoorThenCloseThenReopenPersistsRealContentAcrossTwoFormats` above
    /// (which stayed on its ODF pair on purpose — see its own header). Kept as its own named drill
    /// rather than a third loop iteration there because the dumped-bytes assertions are
    /// OOXML-specific and because this one leg is a product decision's gate, not one more format.
    func testDocxSaveThroughTheRealEditDoorLandsOnTheUsersOwnPathWithTheTypedTextInsideIt() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.docx").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.docx fixture missing")

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
        defer { _ = host.teardownAllOfficeRuntimesAndStopHelper() }

        let zoomPPT = 1000
        let key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)

        // A WRITABLE copy — the checked-in Fixtures directory is never itself a save target.
        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("editable-gate.docx").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        // The product gate itself, asserted before anything else runs: if this predicate ever says
        // read-only again, every mutation door below is a no-op and the rest of this drill would
        // fail for a confusing reason instead of this clear one.
        XCTAssertFalse(officeDocumentIsReadOnlyFormat(path: docPath), "setup: .docx must be a "
                       + "read-write format for this drill to mean anything — see "
                       + "PanelEditorTab.swift's officeReadWriteExtensions")

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "gate.docx never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath] else {
            return XCTFail("gate.docx did not open: "
                           + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        let originalDocId = doc.docId
        XCTAssertEqual(doc.type, .text, "setup: a Word document opens as a Writer text document")
        XCTAssertEqual(doc.dirty, false, "setup: a freshly opened document reports clean")

        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let paintedBefore = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: originalDocId, key: key) != nil }
        XCTAssertTrue(paintedBefore, "the pre-edit tile never arrived")
        let pixelsBefore = try XCTUnwrap(runtime.tileStore.tile(docId: originalDocId, key: key)).pixels

        guard let client = host.officeHelperSupervisor?.client else {
            return XCTFail("no live client to drive the real edit door through")
        }
        try await postRealEdit(client: client, docId: originalDocId, marker: "T4EDIT")

        // Dirty tracking for a docx was UNREACHABLE under the I2 demotion (the input verbs were
        // gated, so LOK never fired ModifiedStatus at all). That it fires now is itself part of
        // what the reversal restores.
        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "the real edit's own `.uno:ModifiedStatus=true` never reached "
                      + "documents[path].dirty — under the read-only demotion this was gated off "
                      + "entirely, so a failure here means the gate is somehow still in force")
        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, originalDocId,
                       "docId changed BEFORE save was requested — something reloaded")

        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "the real document path never changed — the save never landed "
                      + "(banner=\(runtime.stateSnapshot.documentBanners[docPath] ?? "nil") "
                      + "phase=\(runtime.stateSnapshot.phase))")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner — a "
                     + "`SfxBaseModel::impl_store` reason here is the r3 failure returning")

        // PROOF 1+2 — dumped bytes, read back out of the USER'S OWN PATH.
        let documentXML = try readODFEntry(atPath: docPath, entry: "word/document.xml")
        XCTAssertTrue(documentXML.contains("T4EDIT"), "the typed marker is missing from the SAVED "
                      + "real file's own word/document.xml — the edit never reached disk")
        XCTAssertTrue(documentXML.contains("NORMA GATE"), "the fixture's own seed text is missing "
                      + "— the save wrote something other than this document")
        // `[Content_Types].xml` — the brackets MUST be backslash-escaped: `unzip -p` treats its
        // filename argument as a shell-style PATTERN, so a bare `[Content_Types].xml` parses as a
        // character class and matches nothing ("filename not matched", empty output, an assertion
        // that fails for a reason that has nothing to do with the document).
        let contentTypes = try readODFEntry(atPath: docPath, entry: #"\[Content_Types\].xml"#)
        XCTAssertTrue(contentTypes.contains("wordprocessingml.document.main+xml"),
                      "what landed at the user's path is not a real WordprocessingML package — a "
                      + "silent ODF-under-a-.docx-name substitution is exactly what this asserts against")

        let becameCleanAfterSave = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == false }
        XCTAssertTrue(becameCleanAfterSave, "dirty never cleared after a successful docx save")

        // PROOF 3 — reopen the bytes that actually landed.
        runtime.close(docPath)
        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the saved file never reopened — phase: \(runtime.stateSnapshot.phase)")
        guard let reopenedDoc = runtime.stateSnapshot.documents[docPath] else {
            return XCTFail("reopen failed — the save corrupted the file: "
                           + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        XCTAssertEqual(reopenedDoc.type, .text, "format preserved — LOK re-parsed the saved bytes "
                       + "as the same document kind")
        XCTAssertNotEqual(reopenedDoc.docId, originalDocId, "sanity: a reopen always mints a fresh docId")

        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let paintedAfter = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: reopenedDoc.docId, key: key) != nil }
        XCTAssertTrue(paintedAfter, "the post-reopen tile never arrived")
        let pixelsAfter = try XCTUnwrap(runtime.tileStore.tile(docId: reopenedDoc.docId, key: key)).pixels
        XCTAssertNotEqual(pixelsBefore, pixelsAfter, "the reopened document renders identically to "
                          + "before the edit — the round trip may have persisted the ORIGINAL bytes")

        runtime.close(docPath)
    }

    /// **Whole-branch review C1 — a save that fails at the PLACE step leaves the document DIRTY, and
    /// both raw consumers of that flag see it.** The live half of the fix; the interleavings are
    /// pinned as reducer rows (`OfficeRuntimeReducerTests`' own C1 section).
    ///
    /// The bug this reproduces: LOK clears `ModifiedStatus` helper-side the instant the helper's OWN
    /// `saveAs` completes — before `performSave`'s `placeAtomically` ever runs on the app side. So a
    /// place failure used to leave `dirty == false` while the buffer differed from disk, and the two
    /// consumers that read the flag raw both discarded the buffer with no prompt: `officeDirtyFilePaths`
    /// did not name the document at quit, and `releaseOfficeRuntimeIfClean` tore the runtime down on a
    /// mere session hop. Both are asserted below against the REAL post-failure state.
    ///
    /// **The failure is made genuinely real, not simulated** — no fake driver, no injected error. The
    /// document's own DIRECTORY is chmod'd `0555` between the edit and the save, so `placeAtomically`'s
    /// sibling-temp `copyItem` (`.\(name).norma-save-<uuid>`, created beside the destination) fails
    /// with `EACCES`. That is the right lever for two independent reasons: it fails INSIDE
    /// `placeAtomically`, after the helper's own `saveAs` has already succeeded and already cleared
    /// `ModifiedStatus` (the exact ordering C1 is about); and a 0444 *file* would NOT reproduce it —
    /// `rename(2)` needs only directory write permission, and T2b separately proved 0444 documents
    /// round-trip cleanly. `defer` restores the mode so the scratch tree is always removable.
    ///
    /// The retry leg matters as much as the failure leg, and it is this drill that MEASURES the claim
    /// behind it rather than reasoning to it: LOK produces no second `modified=false` for a
    /// successful retry (`STATE_CHANGED` is transition-driven, and it has considered the document
    /// clean since the first `saveAs`). Deleting `.saveSucceeded`'s own direct clear and re-running
    /// reddens exactly the retry assertion below — the bytes land on disk for real and the dot stays
    /// stuck `true` — so without that arm the dot would strand forever after any failed save. Both
    /// C1 arms are deletion-red-proven by this one drill; `saveFailedPendingSave`'s own header pairs
    /// them up.
    func testASaveThatFailsAtThePlaceStepLeavesTheDocumentDirtyAndBothQuitGatesSeeIt() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        // Mode bits do not fence root, so the whole mechanism this drill rests on would silently not
        // reproduce — skip honestly rather than pass vacuously.
        try XCTSkipIf(getuid() == 0, "running as root: a 0555 directory does not deny writes, so the "
                        + "place-failure this drill needs cannot be produced.")

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
        defer { _ = host.teardownAllOfficeRuntimesAndStopHelper() }

        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("place-failure.ods").path
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.ods"))
            .write(to: URL(fileURLWithPath: docPath))
        // Always restore, whatever this test does — a 0555 scratch directory would otherwise defeat
        // the harness's own cleanup.
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scratchDir.path) }

        let zoomPPT = 1000
        let key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[docPath]?.docId,
                                  "did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")

        // A first paint before typing — T2's own methodological finding, still binding: type-8
        // STATE_CHANGED callbacks (which is how `dirty` ever becomes true) only start arriving after
        // the document's first tile paint.
        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let painted = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docId, key: key) != nil }
        XCTAssertTrue(painted, "the pre-edit tile never arrived")

        let client = try XCTUnwrap(host.officeHelperSupervisor?.client, "no live client to type through")
        // Marker chars restricted to `postRealEdit`'s own small test-local keyCode table (T/E/D/I/4).
        try await postRealEdit(client: client, docId: docId, marker: "EDITED")
        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "setup: the real edit's own ModifiedStatus=true never reached "
                      + "documents[path].dirty")

        // The lever. From here the helper's own saveAs still succeeds (it renders into its own
        // state-path, untouched by this) — only the app-side place can fail.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: scratchDir.path)
        let beforeFailedSave = officeFileStat(atPath: docPath)

        let outcome = await runtime.saveAndAwaitOutcome(docPath)
        guard case .failed(let reason) = outcome else {
            XCTFail("expected the place to fail with the document's directory at 0555, got \(outcome) "
                    + "— if the place SUCCEEDED, this drill's whole mechanism has stopped reproducing "
                    + "(check placeAtomically's sibling-temp location) and the C1 assertions below "
                    + "would be vacuous")
            return
        }
        XCTAssertEqual(officeFileStat(atPath: docPath), beforeFailedSave,
                       "the real file must be byte-and-inode untouched by a save that failed to place")

        // **C1 itself.** Measured, not assumed: at this vendor pin the LOK clean event does NOT beat
        // the save reply — `saveAsOnDedicatedThread` posts its `.uno:Save` follow-up fire-and-forget
        // (`bNotifyWhenFinished: false`), so `ModifiedStatus=false` comes back on a LATER round trip,
        // AFTER `.saveFailed` has already been dispatched. That makes the straggler the live shape of
        // this bug, and "dirty is true at this instant" far too weak an assertion to catch it: the
        // pre-fix build passes that one and then goes silently clean a beat later. So the pin is a
        // bounded negative wait — dirty must not merely be true now, it must SURVIVE the arrival of
        // LOK's own contradicting event.
        //
        // **Deletion-red measured, not assumed.** With the reducer's `.saveFailed` restore deleted and
        // nothing else changed, this exact drill fails on all three assertions below — the document
        // goes clean, `officeDirtyFilePaths` returns `[]`, and `officeRuntimeReleasedOnDeparture` says
        // release — with the whole test still finishing in ~2.3s, i.e. the flip lands well under a
        // second after the failed save. The budget is nonetheless the same 15s this file already
        // allows for this very event in the SUCCESS case (`becameCleanAfterSave`, the save round-trip
        // test above): a shorter one would risk passing vacuously under load, which for a data-loss
        // pin is the expensive direction to be wrong in. A green run pays this wait in full, by
        // construction — a negative wait cannot exit early.
        let wentCleanAnyway = await waitUntil(timeout: 15) {
            runtime.stateSnapshot.documents[docPath]?.dirty == false
        }
        XCTAssertFalse(wentCleanAnyway, "the document went CLEAN after a save that never reached disk "
                       + "— reason was \"\(reason)\"; LOK's own ModifiedStatus=false for this failed "
                       + "save must not be allowed to clear the dot (its \"clean\" only means \"matches "
                       + "the save that never landed\")")
        XCTAssertNotNil(runtime.stateSnapshot.documentBanners[docPath],
                        "and the failure is disclosed above the canvas, alongside the dot")

        // The two consumers that read the flag raw — the doors that used to discard the buffer.
        XCTAssertEqual(officeDirtyFilePaths(runtimeStates: [runtime.stateSnapshot]), [docPath],
                       "the QUIT gate must name this document — it did not, before C1")
        XCTAssertFalse(officeRuntimeReleasedOnDeparture(
                        dirtyDocuments: runtime.stateSnapshot.documents.values.filter(\.dirty).count),
                       "and a SESSION HOP must retain the runtime rather than tear it down — merely "
                       + "hopping sessions discarded the buffer, before C1")

        // The retry: with the directory writable again the same buffer places for real, and the
        // app-held flag is released by the one arm allowed to release it.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scratchDir.path)
        let retry = await runtime.saveAndAwaitOutcome(docPath)
        XCTAssertEqual(retry, .saved, "the retry must land once the place can succeed")
        XCTAssertNotEqual(officeFileStat(atPath: docPath), beforeFailedSave, "the retry really wrote the file")
        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.dirty, false,
                       "and the dot clears — LOK has considered this document clean since the FIRST "
                       + "saveAs and will never fire a second modified=false, so .saveSucceeded's own "
                       + "direct clear is the ONLY thing that can unstick it")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "the failure banner goes with the failure")

        runtime.close(docPath)
    }

    /// Office Stage B Task 5 — **the raw-wire probe for the IME mark/commit/cancel mechanism,
    /// BEFORE `NSTextInputClient` exists at all** (that is Stage 4b of this task — see
    /// `OfficeTileCanvasView`'s own header once it lands). Drives `OfficeHelperClient
    /// .postExtTextInput` directly, never through `OfficeRuntime`/a canvas — the same "raw client,
    /// one variable moving" discipline `testTypingIntoAWriterDocumentSurvivesAnInterleavedTileRepaint`
    /// already established for input ordering: if `postWindowExtTextInputEvent` behaves
    /// unexpectedly at this vendored pin, it must surface HERE, not wrapped in
    /// `interpretKeyEvents`/`setMarkedText:` fog where "LOK did something unexpected" and "Norma's
    /// own NSTextInputClient plumbing is wrong" would be much harder to tell apart.
    ///
    /// Three phases, one real Writer document, one real click position (100, 100 twips —
    /// `postRealEdit`'s own proven-safe start-of-body point, reused verbatim):
    /// 1. **Mark** ("xyz", `.input`) — proven by a PIXEL hash: the marked/preedit run must paint
    ///    differently from the pre-mark baseline (LOK really rendered something at that spot).
    /// 2. **Commit** (`.end`, empty text — see `OfficeWireFrame.extTextInputEvent`'s own header for
    ///    why `.end` never carries real text) — proven the T4 way: save, then read the SAVED bytes
    ///    back through `readODFContentXML`/`strippedODFBodyText`, never the in-memory model.
    /// 3. **Cancel** (`.input("")` immediately followed by `.end`, never committing real text) — a
    ///    second mark ("abc") is proven to have painted first (the SAME pixel-hash discipline as
    ///    phase 1, its own fresh baseline — without this, a no-op cancel would prove nothing, since
    ///    there would be nothing to cancel FROM), then a second save/read proves "abc" left no
    ///    residue AT ALL — on disk, not merely that in-memory pixels reverted, which alone cannot
    ///    tell "cancelled" apart from "committed identically by coincidence."
    func testExtTextInputMarksCommitsAndCancelsAgainstRealLOKThroughSaveAndReopen() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("ext-text-input-drill.odt").path
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
        XCTAssertEqual(doc.type, .text, "setup: this drill is about the text-document gate")

        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        let zoomPPT = 1000
        let originKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let baselineArrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: doc.docId, key: originKey) != nil }
        XCTAssertTrue(baselineArrived, "the drill's own pre-compose baseline tile never arrived")
        let pixelsBaseline = try XCTUnwrap(runtime.tileStore.tile(docId: doc.docId, key: originKey), "baseline").pixels

        // `postRealEdit`'s own proven-safe click position — the start of a text document's own body.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        // Helper — this drill's own repeated shape: post an ext-text-input event, then EXPLICITLY
        // re-request the origin tile and wait for fresh pixels. **Investigation finding (this task):
        // marking genuinely DOES fire a real `INVALIDATE_TILES` callback, exactly like an ordinary
        // keystroke** — an in-process `Entry.generation` check (never a log-text read: two separate
        // processes' output streams interleaved by xcodebuild's own capture proved unreliable to
        // reason about ordering from) confirmed the generation bumps 0 -> 1 across the MARK phase
        // specifically (that check, and only that one, was actually instrumented — commit and cancel
        // are not separately re-verified this way below, only inferred from the identical code path:
        // `routeDocumentEvent`'s `applyTileInvalidation` call is the ONLY thing in this codebase that
        // ever bumps a generation, gated on nothing but a real `.invalidated` event, so there is no
        // separate mechanism for the later phases to differ through). The client-side
        // `OfficeTileStore` entry is evicted (`onInvalidated` -> `tileStore.invalidate`)
        // exactly like any other edit — nothing repaints it without an explicit re-request, because
        // `refetchInvalidatedTiles` (`OfficeRuntime.swift`) is ONLY EVER called from a MOUNTED
        // `OfficeTileCanvasView`'s own `tilesArrived` handling, never automatically by a bare
        // `OfficeRuntime`. This drill has no canvas by design (the advisor's own sequencing
        // directive — prove the wire mechanism before touching the canvas), so it stands in for the
        // canvas here; in production the SAME `.invalidated` push this helper waits on already
        // reaches a mounted canvas's existing, already-proven repaint path — no ext-text-input-
        // specific forcing logic is needed anywhere in `OfficeRuntime`/`OfficeTileCanvasView`.
        func repaintAndCapture(after previous: Data, timeout: TimeInterval = 30) async throws -> Data {
            try await client.requestTiles(docId: doc.docId, keys: [originKey])
            let arrived = await waitUntil(timeout: timeout) {
                guard let entry = runtime.tileStore.tile(docId: doc.docId, key: originKey) else { return false }
                return entry.pixels != previous
            }
            XCTAssertTrue(arrived, "an explicit re-request never produced a different tile hash")
            return try XCTUnwrap(runtime.tileStore.tile(docId: doc.docId, key: originKey), "repaint").pixels
        }

        // Phase 1 — mark "xyz".
        try await client.postExtTextInput(docId: doc.docId, part: 0, type: .input, text: "xyz")
        let pixelsMarked = try await repaintAndCapture(after: pixelsBaseline)

        // Phase 2 — commit. `.end`'s own `text` is always sent empty — see `extTextInputEvent`'s own
        // header for why (LOK ignores it and commits whatever is currently marked instead).
        try await client.postExtTextInput(docId: doc.docId, part: 0, type: .end, text: "")
        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "committing the marked text never marked the document dirty")
        let pixelsCommitted = try await repaintAndCapture(after: pixelsMarked)
        // Settles the brief's "marked-text underline showed" criterion empirically, one way or the
        // other: same glyphs, only the marked/preedit DECORATION should differ between "still
        // composing" and "just committed" — if this build's headless (svp) renderer draws no such
        // decoration, `pixelsCommitted` legitimately equals `pixelsMarked` and this assertion (not a
        // silent pass) is where that gets recorded.
        XCTAssertNotEqual(pixelsMarked, pixelsCommitted, "committing must repaint WITHOUT the "
                          + "marked/preedit decoration — if this fails, this LOK build draws no "
                          + "visible difference between composing and committed text, which the "
                          + "report must then state as a real, empirically-checked finding")

        let beforeFirstSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let firstSaveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeFirstSaveStat }
        XCTAssertTrue(firstSaveLanded, "the post-commit save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner after commit")

        // The direct proof, off disk — not the in-memory model, exactly like every other drill here.
        let bodyAfterCommit = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterCommit.contains("xyz"), "the committed marked text must appear in the "
                      + "SAVED body text — got: \"\(bodyAfterCommit)\"")

        // Phase 3 — mark "abc", then CANCEL it (never commit) — must leave no residue at all.
        try await client.postExtTextInput(docId: doc.docId, part: 0, type: .input, text: "abc")
        let pixelsSecondMark = try await repaintAndCapture(after: pixelsCommitted)

        // The cancel sequence: empty `.input` (clears whatever is marked) then `.end` (commits — the
        // now-empty marked run, i.e. nothing).
        try await client.postExtTextInput(docId: doc.docId, part: 0, type: .input, text: "")
        try await client.postExtTextInput(docId: doc.docId, part: 0, type: .end, text: "")
        _ = try await repaintAndCapture(after: pixelsSecondMark)

        let beforeSecondSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let secondSaveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSecondSaveStat }
        XCTAssertTrue(secondSaveLanded, "the post-cancel save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner after cancel")

        let bodyAfterCancel = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterCancel.contains("xyz"), "the FIRST (committed) text must still be there "
                      + "— got: \"\(bodyAfterCancel)\"")
        XCTAssertFalse(bodyAfterCancel.contains("abc"), "the CANCELLED mark must leave NO residue at "
                      + "all — got: \"\(bodyAfterCancel)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 5 — **the brief's own named acceptance drill: compose é, through the REAL
    /// `OfficeTileCanvasView`'s `NSTextInputClient` conformance, against real LOK, with save+reopen
    /// PLACEMENT assertions** ("the T4 lesson" — assert WHERE text landed, never merely that
    /// something became dirty or that pixels changed).
    ///
    /// **Procedural, not a captured real option-e keystroke** — deliberate, per this task's own
    /// review: a genuine dead-key resolution (`NSEvent`'s own Option-e-then-e sequence) depends on
    /// the MACHINE's active keyboard layout/input source, which a CI runner cannot be guaranteed to
    /// have set to US/ABC. Calling `view.setMarkedText`/`view.insertText` directly exercises the
    /// EXACT SAME code path a real dead-key sequence would drive AppKit into (macOS's own Option-e
    /// composition marks the accent, then commits "é" through these same two `NSTextInputClient`
    /// entry points — this is not a simplification of the mechanism, it IS the mechanism), without
    /// depending on layout. The underline-decoration half of the brief's own "marked-text underline
    /// showed" criterion is already proven, empirically, by `testExtTextInputMarksCommitsAnd
    /// CancelsAgainstRealLOKThroughSaveAndReopen`'s own `pixelsMarked != pixelsCommitted` assertion
    /// (generic "xyz", the SAME `.input`/`.end` mechanism `setMarkedText`/`insertText` themselves
    /// call) — this drill's own job is different: prove the CANVAS's conformance reaches that SAME
    /// mechanism correctly when driven the way a real input method actually drives it, and that
    /// EXACTLY one é lands, never a stray plain "e" alongside it (the double-delivery failure mode
    /// this task's whole `interpretKeyEvents` seam exists to prevent — see `keyDown`'s own header).
    func testComposedEAcuteLandsExactlyOnceThroughTheRealCanvasWithNoStrayPlainE() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("composed-eacute-drill.odt").path
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
        XCTAssertEqual(doc.type, .text, "setup: this drill is about the text-document gate")

        let model = PanelDocumentTabModel(tabId: "composed-eacute-drill", path: docPath)
        let view = OfficeTileCanvasView(runtime: runtime, path: docPath, docId: doc.docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        // A real, invisible window — `NSTextInputClient`'s own `interpretKeyEvents`/`firstRect`
        // machinery is AppKit responder-chain infrastructure, the same real-window requirement
        // `testTypingOnSheetTwoLandsOnSheetTwoNotSheetOneThroughSaveAndReopen`'s own header already
        // established for `keyDown`/`mouseDown` (a window-less `NSView.convert(_:to:nil)` silently
        // produces wrong coordinates rather than crashing — not something to re-risk here).
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        // Fix round 1, I-1: `OfficeTileCanvasViewTests`' own precedent (its
        // `testRepositioningInARealPresentedWindowLeavesNoSettleGlideAfterInputStops`) — without
        // this, `close()` below performs an ADDITIONAL release on top of ARC's own and this drill
        // accumulates window state in the shared test host across runs instead of tearing down.
        window.isReleasedWhenClosed = false
        defer { window.close() }
        window.contentView = view
        _ = window.makeFirstResponder(view)

        // `postRealEdit`'s own proven-safe click position — the start of a text document's own body
        // — driven through the REAL view, not the raw client, so the caret this drill composes
        // against is the SAME caret `firstRect(forCharacterRange:)` would report mid-composition.
        let clickPoint = NSPoint(x: 2, y: 2) // view-bounds space, well inside the origin tile
        let windowClickPoint = view.convert(clickPoint, to: nil)
        func makeMouseEvent(_ type: NSEvent.EventType) -> NSEvent {
            try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: windowClickPoint, modifierFlags: [],
                                              timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                              eventNumber: 0, clickCount: 1, pressure: 1))
        }
        view.mouseDown(with: makeMouseEvent(.leftMouseDown))
        view.mouseUp(with: makeMouseEvent(.leftMouseUp))
        await runtime.drainInputChainForTesting()

        // **Closes the untested middle** — this repo's own repeatedly-named pattern ("two doubles
        // bracket the untested middle", memory: `chat-slice-d-shipped`) applied here: the
        // procedural `setMarkedText`/`insertText` pair below proves the COMMIT mechanism (already
        // proven against real LOK, stage 4a); the classifier tests prove `keyUp` posts a real
        // charCode for a plain key. Nobody proves them INTERLEAVED the way a real composition
        // actually produces them — a real Option-e-then-e sequence's true event order is
        // `keyDown(⌥e)` [intercepted by the real, layout-dependent IME machinery into
        // `setMarkedText` — not exercised here, see this drill's own header], `keyUp(⌥e)` [reaches
        // `keyUp(with:)` regardless of what the keyDown did — `keyUp`'s own header explains why it is
        // UNCONDITIONAL], `keyDown(e)` [resolves the composition into `insertText`], `keyUp(e)`.
        // `keyUp`'s own classifier excludes only `.command`/`.control` — a REAL Option-held keyUp's
        // `charactersIgnoringModifiers` is NOT excluded by that classifier, so it posts a REAL,
        // non-zero charCode onto the wire — a "keystroke" LOK receives while this drill's own preedit
        // run is still active. If that orphan post corrupted the composition (inserted extra text,
        // reset the marked run, raced the commit), the placement assertions below would catch it —
        // synthetic `NSEvent`s only, deterministic, no keyboard-layout dependency (unlike a REAL
        // keyDown for these two keys, which this drill deliberately never attempts — see its header).
        func makeKeyUpEvent(characters: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: modifiers, timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
        }

        // The composition itself — two `NSTextInputClient` calls, the exact pair a real Option-e
        // (marks the pending accent) then e (resolves and commits "é") sequence drives AppKit into,
        // with the two orphan keyUps posted at their own real, interleaved positions.
        XCTAssertFalse(view.hasMarkedText(), "setup: nothing composing before this drill starts")
        view.setMarkedText("´", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.hasMarkedText(), "setMarkedText must register composition as active")
        // Real macOS: `charactersIgnoringModifiers` for the Option-e dead-key's own physical keyUp
        // reports "´" (the same accent glyph `setMarkedText` above just marked) — AppKit keyCode 14
        // is 'e's own physical position (`OfficeInputCodesTests`' own table).
        view.keyUp(with: makeKeyUpEvent(characters: "´", keyCode: 14, modifiers: .option))
        view.insertText("é", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertFalse(view.hasMarkedText(), "insertText must end composition on commit")
        view.keyUp(with: makeKeyUpEvent(characters: "e", keyCode: 14, modifiers: []))
        await runtime.drainInputChainForTesting()

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "composing and committing é never marked the document dirty")

        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(saveLanded, "the save never landed on disk")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner")

        // The direct, off-disk placement proof — not the in-memory model, not merely "dirty" or
        // "pixels changed." The click landed at the very start of the body (this fixture's own seed
        // text follows it), so isolating the untouched seed's own tail leaves EXACTLY what this
        // drill's own composition put there — the precise, disk-level version of "exactly once, no
        // stray e" the brief's own acceptance criterion names.
        let body = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        // gate.odt's own untouched body — captured directly from its real content.xml via this
        // file's own `strippedODFBodyText` algorithm (between `<office:text...>` and
        // `</office:text>`, tags stripped). Hardcoded rather than re-read from `fixturePath` at
        // runtime: OfficeHelperLiveTests' own sha256 pin on gate.odt means any future change to the
        // fixture breaks that hash test first, before this literal could silently drift out of sync.
        let seedText = "NORMA GATEoffice stage A embed probe"
        XCTAssertTrue(body.hasSuffix(seedText), "the untouched seed text must survive, byte-identical, "
                      + "as the tail — got: \"\(body)\"")
        // Fix round 1, M-2: the ORIGINAL `hasPrefix`-based assertions here were a confirmed gap —
        // `body.hasPrefix("é")` also passes for "éé..." (a double-committed é), and
        // `!body.hasPrefix("eé")` is VACUOUS once `hasPrefix("é")` already holds (a string starting
        // with "é" can never also start with "eé"). Isolating exactly what landed ahead of the
        // untouched seed (above) and counting occurrences closes both holes: "éé" now fails the
        // é-count/exact-match checks below; "eé"/"ée" now fail the e-count/exact-match checks below.
        let insertionSite = body.dropLast(seedText.count)
        XCTAssertEqual(insertionSite.filter { $0 == "é" }.count, 1, "expected exactly one é at the "
                      + "insertion site, got: \"\(insertionSite)\"")
        XCTAssertEqual(insertionSite.filter { $0 == "e" }.count, 0, "a stray plain \"e\" landed at "
                      + "the insertion site — the double-delivery failure mode this task's whole "
                      + "seam exists to prevent")
        // Subsumes both counts above, and additionally catches a stray UNCOMMITTED "´" — this
        // drill's own option-´ keyUp (above) fires mid-composition, so a regression that
        // leaked the mark instead of cleanly committing it is a plausible failure shape here, not a
        // hypothetical one; it would pass both counts above (0 stray "e", exactly 1 "é") while still
        // being wrong.
        XCTAssertEqual(String(insertionSite), "é", "the insertion site must be EXACTLY one é and "
                      + "nothing else, got: \"\(insertionSite)\"")

        view.unmount()
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

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the second ("agent") view

    /// `com.sun.star.awt.Key`'s `KEY_A`..`KEY_Z` run 512..537, alphabetically — confirmed against
    /// this file's own `postRealEdit` table (`T`=531=512+19, `E`=516=512+4, `D`=515=512+3,
    /// `I`=520=512+8, every one consistent with `512 + (letter's 0-based alphabet index)`). A
    /// closed-form replacement for `postRealEdit`'s own small hardcoded table — this task's own
    /// drills need letters that table does not cover.
    private func rawUppercaseLetterKeyCode(_ letter: Character) -> Int {
        512 + Int(letter.asciiValue! - Character("A").asciiValue!)
    }

    /// Types `marker` (uppercase ASCII letters only) via raw `postKey` calls — the SAME wire verb
    /// `OfficeTileCanvasView.forwardKeyEvent` uses in production, called directly here exactly like
    /// `postRealEdit` does, but WITHOUT that helper's own leading click or trailing Return: this
    /// task's own drills click (or don't) and select (or don't) in their own, differing shapes
    /// around this call.
    private func postRawUppercaseMarker(client: OfficeHelperClient, docId: String, marker: String) async throws {
        for character in marker {
            let keyCode = rawUppercaseLetterKeyCode(character)
            let charCode = Int(character.asciiValue!)
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
    }

    /// Shift+Left, `count` times — selects backward from the current caret. `1026`/`0x1000` are
    /// `OfficeInputCodes.Key.left`/`.keyShift` (production values, re-derived here rather than
    /// imported: this file drives the wire directly with no `NSEvent` anywhere, the same posture
    /// `postRealEdit`'s own local `keyCodes` table already takes). The keyboard-driven selection
    /// door T5's own probe already proved fires real `TEXT_SELECTION` callbacks; this drill does
    /// not need to observe them directly — the save+reopen placement assertion is the proof of
    /// record, per this repo's own house standard.
    private func postRawShiftLeft(client: OfficeHelperClient, docId: String, count: Int) async throws {
        let keyCode = 1026 | 0x1000
        for _ in 0..<count {
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: keyCode)
        }
    }

    /// Shift+Right, `count` times — extends (or, from an already-selected range whose active end
    /// sits at the LEFT edge, symmetrically SHRINKS) a selection rightward.
    ///
    /// **Not a bare Right arrow — a live-test-caught correction.** A plain Right press while a
    /// Shift+Left-built selection is active was tried FIRST and does NOT collapse to the
    /// selection's right edge on this LOK build: the first real run of
    /// `testClipboardCopyThenPasteDoublesTheTypedTextThroughSaveAndReopen` produced
    /// `"CCOPYMEOPYME"` instead of the expected `"COPYMECOPYME"` — a single stray leading `C` and
    /// a truncated second copy, the exact signature of the paste landing at position 1 (the
    /// selection's LEFT edge, PLUS one extra step) rather than position 6 (its RIGHT edge, no
    /// step). Shift+Right the SAME number of times the original Shift+Left ran walks the ACTIVE
    /// end back to the ANCHOR exactly — the selection shrinks to nothing exactly AT the anchor
    /// position, with no separate "which edge does a plain arrow collapse to" convention to get
    /// wrong, unlike a bare arrow key's collapse behavior on this build.
    private func postRawShiftRight(client: OfficeHelperClient, docId: String, count: Int) async throws {
        let keyCode = 1027 | 0x1000
        for _ in 0..<count {
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: keyCode)
        }
    }

    /// Office Stage B Task 6 — the brief's own named clipboard drill: type, select, copy, move the
    /// caret, paste — the pasted text must land a SECOND time, proven off disk (save+reopen),
    /// never merely "the document became dirty" or "pixels changed" (the T4 lesson, carried
    /// forward by this task's own brief).
    func testClipboardCopyThenPasteDoublesTheTypedTextThroughSaveAndReopen() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("clipboard-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // Click at the document's own start — the same proven-safe position `postRealEdit` uses.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        let marker = "COPYME"
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: marker)
        try await postRawShiftLeft(client: client, docId: doc.docId, count: marker.count)

        let copied = try await client.clipboardCopy(docId: doc.docId, part: 0)
        XCTAssertEqual(copied, marker, "clipboardCopy must return exactly the selected text")

        // Collapse the selection back to its right edge (Shift+Right, symmetrically undoing the
        // Shift+Left above — see `postRawShiftRight`'s own header for why NOT a bare Right press),
        // then paste — THIS is what actually doubles the content: pasting while still selected
        // would REPLACE the selection instead, leaving the text unchanged, the exact false
        // positive this ordering avoids.
        try await postRawShiftRight(client: client, docId: doc.docId, count: marker.count)
        try await client.clipboardPaste(docId: doc.docId, part: 0, text: copied)

        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(saveLanded, "the post-paste save never landed on disk")

        let body = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(body.contains(marker + marker), "the pasted text must land a SECOND time, "
                      + "immediately after the first — got: \"\(body)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 6 — the brief's own explicit ask: verify EMPIRICALLY whether
    /// `.uno:Cut` works headless (`LOKBridge.clipboardCutOnDedicatedThread`'s own choice) rather
    /// than the copy+delete fallback the brief itself names as the alternative. Two claims, both
    /// checked off disk: (1) the cut text matches what was selected; (2) the selection is GONE
    /// from the saved body — never merely "the document became dirty."
    func testClipboardCutRemovesTheSelectionHeadlessAndReturnsItsText() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("clipboard-cut-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        let marker = "CUTME"
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: marker)
        try await postRawShiftLeft(client: client, docId: doc.docId, count: marker.count)

        let cut = try await client.clipboardCut(docId: doc.docId, part: 0)
        XCTAssertEqual(cut, marker, "clipboardCut must return exactly the text that was selected")

        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(saveLanded, "the post-cut save never landed on disk")

        let body = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertFalse(body.contains(marker), "`.uno:Cut` must actually remove the selection from "
                      + "the saved document — got: \"\(body)\" — EMPIRICAL FINDING for the report: "
                      + "if this assertion fails, `.uno:Cut` does not work headless and the "
                      + "copy+delete fallback the brief itself names is required instead")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 6 — the brief's own named undo ladder: type -> undo -> gone -> redo ->
    /// back. **Bounded, not single-shot**: LO groups a typed run into ONE undo action in the
    /// common case, but this is not assumed here — the loop undoes up to `marker.count` times,
    /// stopping the instant the marker is gone off disk, and RECORDS how many undos it actually
    /// took (a real, disclosed characterization finding, not a hardcoded assumption about
    /// grouping).
    func testUndoLadderTypeThenUndoRemovesTheTypedTextThenRedoRestoresIt() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("undo-ladder-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        let marker = "UNDO"
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: marker)

        // Review fix round 1, I-4's own spirit swept here too (not named explicitly for this test,
        // but the identical defect class): every `waitUntil` below is now captured and asserted,
        // never discarded — a silent save timeout must fail loud, not read back stale bytes that
        // happen to satisfy (or fail) the next content check for the wrong reason.
        var beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        var saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(saveLanded, "the setup save never landed on disk")
        let bodyAfterTyping = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterTyping.contains(marker), "setup: the marker must actually be "
                      + "present before this drill starts undoing anything — got: "
                      + "\"\(bodyAfterTyping)\"")

        var undosTaken = 0
        var bodyAfterUndo = bodyAfterTyping
        while bodyAfterUndo.contains(marker), undosTaken < marker.count {
            try await client.undo(docId: doc.docId)
            undosTaken += 1
            beforeStat = officeFileStat(atPath: docPath)
            runtime.save(docPath)
            saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
            XCTAssertTrue(saveLanded, "undo #\(undosTaken)'s own save never landed on disk")
            bodyAfterUndo = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        }
        XCTAssertFalse(bodyAfterUndo.contains(marker), "the marker must be fully gone after at "
                      + "most \(marker.count) undo(s) — got: \"\(bodyAfterUndo)\" after "
                      + "\(undosTaken) undo(s)")
        NSLog("[T6 undo ladder] \(undosTaken) undo(s) removed a \(marker.count)-character typed run")

        // Redo — the SAME number of times undo took, restoring exactly what was undone.
        for _ in 0..<undosTaken {
            try await client.redo(docId: doc.docId)
        }
        beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(saveLanded, "the post-redo save never landed on disk")
        let bodyAfterRedo = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterRedo.contains(marker), "redo must restore the typed text — got: "
                      + "\"\(bodyAfterRedo)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 6 — **the headline finding**: two LOK views on ONE document, cross-view
    /// undo, CHARACTERIZED rather than assumed. Per this task's own dispatch context (echoing the
    /// plan's own PARKED note): LO core's undo manager is DOCUMENT-scoped and collaborative LOK
    /// uses undo-REPAIR rather than per-view stacks, so "view B's edits don't pollute view A's
    /// stack" is a claim to DISCOVER, not assume going in.
    ///
    /// **Closes the exact sequencing trap this task's own advisor named**: `postKeyEvent` is
    /// `PostUserEvent`-async on LOK's own side, so a bare wire ack does not itself prove an edit
    /// has been PROCESSED — only a subsequent SYNCHRONOUS LOK call (`saveAs`, on the SAME
    /// dedicated thread, queued strictly after the posted keys) can observe the cumulative effect,
    /// the same reasoning this whole input pipeline has rested on since Task 4's own live drills.
    /// This drill therefore SAVES AND DUMPS BYTES after EACH edit, proving both A's and B's edits
    /// landed BEFORE ever touching undo — never inferring "it must have landed by now" from timing
    /// alone.
    ///
    /// Every one of the four possible outcomes below is a PASSING characterization — only a WRONG
    /// claim about which one occurred would be a failure. The actual, empirically observed outcome
    /// is pinned by the final assertion below (tightened after a real run against real LOK — see
    /// this test's own trailing comment for the raw finding).
    func testTwoLOKViewsOnOneDocumentCharacterizesCrossViewUndo() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("two-view-undo-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // The two-writer groundwork itself: mint the agent view.
        let viewIdB = try await client.createAgentView(docId: doc.docId)
        XCTAssertGreaterThanOrEqual(viewIdB, 0, "a real LOK view id — the -1 no-view sentinel "
                                    + "would mean createView itself silently failed")

        // A SECOND createAgentView for the SAME docId must be refused, not silently tolerated —
        // `OfficeWireFrame.createView`'s own header states this as deliberate.
        do {
            _ = try await client.createAgentView(docId: doc.docId)
            XCTFail("a second createAgentView for the same docId must be refused")
        } catch OfficeHelperClientError.serverError {
            // expected
        }

        // Edit via A (the primary/implicit view): click, type, PROVE it landed before B ever
        // touches the document — a save+dump, not just the wire ack (see this test's own header).
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "AAAA")

        var beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        var saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(saveLanded, "the post-A save never landed on disk — load-bearing: a silent "
                      + "timeout here would leave STALE (pre-A) bytes that the assertion below "
                      + "cannot distinguish from a genuine failure")
        let bodyAfterA = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterA.contains("AAAA"), "view A's own edit must land before this drill "
                      + "proceeds to view B — got: \"\(bodyAfterA)\"")

        // Edit via B (the agent view), through `agentKeyEvent` — the door that exists ONLY for
        // this drill. Deliberately not clicked first: there is no `agentMouseEvent` door (out of
        // this task's scope), so B's edit lands wherever LOK's own fresh-view caret default is;
        // this drill's own concern is whether the edit lands and how undo treats it, not where.
        for character in "BBBB" {
            let keyCode = rawUppercaseLetterKeyCode(character)
            let charCode = Int(character.asciiValue!)
            try await client.agentKeyEvent(docId: doc.docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.agentKeyEvent(docId: doc.docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }

        beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(saveLanded, "the post-B save never landed on disk — same load-bearing "
                      + "reason as the post-A save above")
        let bodyAfterB = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterB.contains("AAAA"), "view A's edit must still be there after view "
                      + "B's own edit — got: \"\(bodyAfterB)\"")
        XCTAssertTrue(bodyAfterB.contains("BBBB"), "view B's own edit must land, PROVEN off disk "
                      + "before undo ever runs — got: \"\(bodyAfterB)\"")

        // THE drill: undo via view A's own primary-view door.
        try await client.undo(docId: doc.docId)

        // **Review fix round 1, I-4 — the load-bearing save.** A discarded `_ = await waitUntil`
        // here (this test's own original shape) would make a TIMED-OUT save indistinguishable from
        // the REFUSED/NO-OP finding this drill exists to prove: both leave `bodyAfterUndo` reading
        // the UNCHANGED bodyAfterB bytes (both markers present), for entirely different reasons —
        // one a real LOK characterization, the other this test's own plumbing silently not
        // running. Every other save+dump step in this drill already fails loud on its own content
        // assertion if ITS save stalls (stale bytes lack the marker the very next line checks for)
        // — this is the ONE save whose stale-bytes case is BY CONSTRUCTION indistinguishable from
        // a passing outcome, so it is the one that must fail loud on the wait itself, not just on
        // content.
        beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        saveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(saveLanded, "the post-undo save never landed on disk — without this "
                      + "assertion, a silent save timeout here would read back the SAME bytes as "
                      + "bodyAfterB and be indistinguishable from the REFUSED/NO-OP finding this "
                      + "drill exists to characterize")
        let bodyAfterUndo = strippedODFBodyText(try readODFContentXML(atPath: docPath))

        let aSurvived = bodyAfterUndo.contains("AAAA")
        let bSurvived = bodyAfterUndo.contains("BBBB")
        let characterization: String
        switch (aSurvived, bSurvived) {
        case (false, true): characterization = "ISOLATED — undo via A removed ONLY A's own edit; B's survived untouched"
        case (true, false): characterization = "SHARED/LIFO — undo via A removed B's edit instead (the most recent action on one shared stack), A's survived"
        case (true, true): characterization = "REFUSED/NO-OP — undo via A changed neither edit"
        case (false, false): characterization = "REPAIR/OTHER — undo via A removed BOTH edits"
        }
        NSLog("[T6 two-view drill] characterization: \(characterization) — body after undo: \"\(bodyAfterUndo)\"")

        // PINNED, from a real run against real LOK (see task-6-report.md for the full transcript;
        // an EARLIER version of this test pinned SHARED/LIFO here — that was a guess made BEFORE
        // ever running the drill, and it was WRONG; corrected against the real observed body,
        // never left standing on the strength of the a-priori reasoning alone). The real body
        // after undo was `"BBBBAAAANORMA GATE..."` — BOTH markers intact, byte-for-byte identical
        // to the pre-undo body. **REFUSED/NO-OP**: dispatching `.uno:Undo` via view A's own
        // primary-view door did NOT remove view B's edit (the most recent action) NOR view A's own
        // — consistent with LO's collaborative undo REFUSING to act on a foreign view's top undo
        // item, rather than either isolating per-view stacks OR falling through to a shared LIFO
        // stack. This is NOT a general failure of `undo` through this wire door — the SINGLE-VIEW
        // `testUndoLadderTypeThenUndoRemovesTheTypedTextThenRedoRestoresIt` (same door, same
        // `.uno:Undo` dispatch, no second view involved) independently proves `undo` genuinely
        // removes real content when there is no cross-view contention. Both survived-or-not
        // booleans are asserted explicitly (not just the composite `characterization` string) so a
        // future LO/vendor upgrade that changes this behavior fails HERE, loudly, rather than
        // silently drifting. Stage C's own collaborator design consumes this: a foreign view's
        // undo is a no-op today, not a silent corruption risk — `.uno:Undo` with `{"Repair": true}`
        // is the named follow-up if a future stage wants undo to actually cross views.
        XCTAssertTrue(aSurvived, "PINNED FINDING: view A's own edit survives undo-via-A — got body: \"\(bodyAfterUndo)\"")
        XCTAssertTrue(bSurvived, "PINNED FINDING: view B's edit ALSO survives undo-via-A — "
                      + "REFUSED/NO-OP, not SHARED/LIFO and not per-view isolation — got body: "
                      + "\"\(bodyAfterUndo)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// ⛔ **office-live-edit R1 fix round — C-1: a save must not overtake the typing it is meant to
    /// persist.**
    ///
    /// `OfficeRuntime.save` dispatches `.saveRequested` straight into `performSave`, while every
    /// input verb goes through the SEPARATE `inputChainTail` chain. The two chains feed one request
    /// queue independently, so a save issued while key events are still waiting on the input chain
    /// **overtakes them and serializes the document as it was BEFORE them** — writing the pre-edit
    /// file over the user's own path and reporting success, with no banner.
    ///
    /// **This is a REAL user gesture, not a synthetic one:** type into a cell, press Return, press
    /// ⌘S. The whole window is the input chain's delivery latency, and a human easily beats it.
    /// `dirty` stays `true` (LOK still holds the text) so the next save heals it — permanent loss
    /// needs a crash after the ⌘S, or the user acting on the file in between.
    ///
    /// **The reason this drill does NOT drain the input chain is the entire point.** Every other
    /// typing drill in this file calls `drainInputChainForTesting()` before saving, which is exactly
    /// why none of them ever caught this: draining is what a correct save must do FOR ITSELF, and
    /// doing it in the test hid the bug for the whole of Stage B. This drill deliberately behaves
    /// like the user does.
    ///
    /// Pre-existing on `main` — it reproduces at the base commit — but requirement 1's debounced
    /// save made it the ORDINARY path rather than a narrow race, because the debounce is armed at
    /// key ENQUEUE time, not delivery time. That is why it is fixed here.
    func testASaveIssuedWhileTypingIsStillInFlightPersistsTheTypingNotThePreEditDocument() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path)")
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
        let docPath = scratchDir.appendingPathComponent("save-ordering-drill.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason")")
        }

        let model = PanelDocumentTabModel(tabId: "save-ordering", path: docPath)
        let view = OfficeTileCanvasView(runtime: runtime, path: docPath, docId: doc.docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = view

        let clickPoint = view.convert(NSPoint(x: 10, y: 10), to: nil)
        func mouse(_ type: NSEvent.EventType) -> NSEvent {
            try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: clickPoint, modifierFlags: [],
                                              timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                              eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func key(_ type: NSEvent.EventType, _ characters: String, _ keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil,
                                            characters: characters, charactersIgnoringModifiers: characters,
                                            isARepeat: false, keyCode: keyCode))
        }
        view.mouseDown(with: mouse(.leftMouseDown))
        view.mouseUp(with: mouse(.leftMouseUp))

        let marker = "T4EDIT"
        let physicalKeyCodes: [Character: UInt16] = ["T": 17, "4": 21, "E": 14, "D": 2, "I": 34]
        for character in marker {
            let code = try XCTUnwrap(physicalKeyCodes[character])
            view.keyDown(with: key(.keyDown, String(character), code))
            view.keyUp(with: key(.keyUp, String(character), code))
        }
        view.keyDown(with: key(.keyDown, "\r", 36))    // Return commits the cell edit
        view.keyUp(with: key(.keyUp, "\r", 36))

        // ⛔ **NO `drainInputChainForTesting()` HERE.** The save is issued the instant the last key
        // event is ENQUEUED, which is exactly what a user pressing ⌘S does. Adding a drain here
        // would test the fix's own precondition instead of the fix.
        let beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let landed = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        XCTAssertTrue(landed, "the save never landed on disk at all")

        let content = try readODFContentXML(atPath: docPath)
        XCTAssertTrue(content.contains(marker),
                      "the SAVED file must contain the text the user had just typed. Missing means "
                        + "the save overtook the input chain and serialized the PRE-EDIT document "
                        + "onto the user's own path — while reporting success, with no banner. "
                        + "Saved body: \(strippedODFBodyText(content))")
        // The untouched NEIGHBOURING cell, not A1. Typing straight after a click REPLACES the
        // clicked cell's content (ordinary spreadsheet UX — `typeOneCharacterOnPrimaryView`'s own
        // header says so), so `gate.ods`'s A1 seed "NORMA GATE" is legitimately gone here; asserting
        // it survived would be asserting the gesture did NOT work. A2 is what proves this was a save
        // of the SAME document with one cell changed, rather than some other document entirely.
        //
        // Worth recording, because the two arms discriminate perfectly: UNFIXED, this drill failed on
        // the marker being ABSENT while the A1 seed was still PRESENT — the literal signature of the
        // pre-edit document being written. FIXED, the marker is present and the A1 seed is gone,
        // which is the post-edit document. Nothing else produces that flip.
        XCTAssertTrue(content.contains("office stage A embed probe"),
                      "and the fixture's own UNTOUCHED cell must survive — this must be a save of "
                        + "the same document with one cell changed, never a different document")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **The control arm for the drill above.** The fix makes `performSave` join `inputChainTail`
    /// before it serializes; the failure mode of a fix like that is a save that waits for something
    /// that never finishes, or waits on the wrong thing. This proves a save with NOTHING in flight
    /// still lands promptly and completely — so the join cannot have been implemented as an
    /// unconditional stall.
    ///
    /// It also pins the ordering claim from the other side: the marker is typed AND drained BEFORE
    /// the save is issued, so the save has nothing to wait for and must behave exactly as it always
    /// did.
    func testASaveWithNothingInFlightStillLandsPromptlyAndCompletely() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path), "helper not built")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present")
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
        let docPath = scratchDir.appendingPathComponent("save-ordering-control.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled)
        guard let doc = runtime.stateSnapshot.documents[docPath],
              let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open")
        }

        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "AAAA")
        // Everything is already delivered — this save has an EMPTY input chain to join.
        await runtime.drainInputChainForTesting()

        let started = Date()
        let beforeStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let landed = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeStat }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertTrue(landed, "a save with nothing in flight must still land — if this hangs, the "
                        + "input-chain join was implemented as an unconditional wait")
        XCTAssertLessThan(elapsed, 10.0, "and it must land PROMPTLY: joining an already-finished "
                            + "chain costs nothing. \(elapsed)s means the join is waiting on "
                            + "something that is not the input chain")
        let content = try readODFContentXML(atPath: docPath)
        XCTAssertTrue(content.contains("AAAA"), "the control arm's own edit must be saved too")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **office-live-edit STEP 0 — LT-1, the drill the whole of requirement 3 rests on.**
    ///
    /// The engine research (`.superpowers/research/office-undo-save-engine.md`, Q1/Q2) establishes
    /// at LibreOffice `11482c8f71bc76ed6260bc03b1576a52a788ab4f` that `.uno:Undo` takes a
    /// `SfxBoolItem Repair SID_REPAIRPACKAGE` argument which skips the per-view undo gate in all
    /// three apps, and that `doc_postUnoCommand`'s JSON mapper turns
    /// `{"Repair":{"type":"boolean","value":"true"}}` into that item. But that research's own H1
    /// records — with live `dladdr` evidence already in this repo's vendored `LibreOfficeKit.h` —
    /// that **the shipped engine's LOK ABI does not match the pin**. So the mechanism is read, not
    /// proven, until it runs HERE against the real helper.
    ///
    /// **The before-picture is a pinned no-op.** `testTwoLOKViewsOnOneDocumentCharacterizesCrossViewUndo`
    /// above, and `OfficeHarness.performTwoViewUndoCharacterization18()`, both assert that after
    /// "edit via A, edit via B(agent view), undo via A" **both edits survive** — cross-view undo is
    /// REFUSED. This drill must FLIP that, and only by adding `Repair`.
    ///
    /// **Why the control arm is inside this test rather than delegated to the pinned one.** The
    /// pinned test runs in its own process state, on its own fixture copy, with its own freshly
    /// booted helper. If repair were to appear to work here while the pinned test still passed
    /// there, the two runs would not be comparable — the only sound comparison is a plain undo and
    /// a repair undo **against the same document, in the same run, with the same two views**. So
    /// arm 1 dispatches a NON-repair undo and asserts the pinned REFUSED/NO-OP outcome; arm 2 then
    /// dispatches repair undos against that same document. If arm 1 ever stops refusing, arm 2's
    /// result means nothing and this test says so rather than reporting a flip it did not cause.
    ///
    /// **Why arm 2 is a bounded LADDER, not a single undo.** LOK's real undo granularity for typed
    /// text is not established anywhere in this repo — the existing ladder drill bounds undos by
    /// marker length and its own header explicitly refuses to be cited as one-undo-per-character.
    /// Asserting "one repair undo removes BBBB" would therefore be a test that could go red for a
    /// reason that has nothing to do with repair. The ladder is bounded at `bMarker.count` (4) and
    /// asserts, at every rung, that **A's edit is still there** — which is the LIFO claim repair
    /// actually makes (B's actions all sit above A's on the one shared per-document stack), and
    /// which would catch the one alternative worth catching: a repair undo that pops indiscriminately.
    func testRepairArgumentLetsAPrimaryViewUndoTakeBackAnAgentViewEdit() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("repair-undo-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        /// Save and read the document's own body back off disk. Every rung of this drill judges on
        /// the SAVED BYTES, never on a wire ack — `undoOk` acks the dispatch, not the effect.
        func saveAndReadBody(_ label: String) async -> String? {
            let before = officeFileStat(atPath: docPath)
            runtime.save(docPath)
            let landed = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != before }
            guard landed else {
                XCTFail("\(label): the save never landed on disk — a silent timeout here reads back "
                        + "STALE bytes, which for an undo drill is indistinguishable from 'the undo "
                        + "did nothing', the exact outcome this drill exists to tell apart")
                return nil
            }
            guard let xml = try? readODFContentXML(atPath: docPath) else {
                XCTFail("\(label): could not read content.xml back")
                return nil
            }
            return strippedODFBodyText(xml)
        }

        let viewIdB = try await client.createAgentView(docId: doc.docId)
        XCTAssertGreaterThanOrEqual(viewIdB, 0, "a real LOK view id — the -1 no-view sentinel would "
                                    + "mean createView itself silently failed and the whole drill "
                                    + "would then be measuring a ONE-view document")

        // Edit via A (the primary view) — proven on disk before B ever touches the document.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "AAAA")
        guard let bodyAfterA = await saveAndReadBody("after A's edit") else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper(); return
        }
        XCTAssertTrue(bodyAfterA.contains("AAAA"), "view A's own edit must land before B edits — got: \"\(bodyAfterA)\"")

        // Edit via B (the AGENT view) — the edit a human's ⌘Z cannot reach today.
        for character in "BBBB" {
            let keyCode = rawUppercaseLetterKeyCode(character)
            let charCode = Int(character.asciiValue!)
            try await client.agentKeyEvent(docId: doc.docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.agentKeyEvent(docId: doc.docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
        guard let bodyAfterB = await saveAndReadBody("after B's edit") else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper(); return
        }
        XCTAssertTrue(bodyAfterB.contains("AAAA"), "A's edit must survive B's — got: \"\(bodyAfterB)\"")
        XCTAssertTrue(bodyAfterB.contains("BBBB"), "B's edit must LAND, proven off disk, before any "
                      + "undo runs — got: \"\(bodyAfterB)\"")

        // ── ARM 1, THE CONTROL: a plain, non-repair undo from the primary view.
        // This is the pinned REFUSED/NO-OP characterization, re-measured in THIS run so that arm 2's
        // outcome is a comparison rather than a claim about two different runs. It is also what
        // makes arm 2 non-vacuous: without it, a repair undo that "worked" could not be told apart
        // from a document where cross-view undo had started working on its own.
        try await client.undo(docId: doc.docId)
        guard let bodyAfterPlainUndo = await saveAndReadBody("after the PLAIN undo") else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper(); return
        }
        NSLog("[LT-1] body after PLAIN undo: \"\(bodyAfterPlainUndo)\"")
        XCTAssertTrue(bodyAfterPlainUndo.contains("AAAA") && bodyAfterPlainUndo.contains("BBBB"),
                      "CONTROL ARM: a NON-repair undo from the primary view must still be the "
                      + "pinned REFUSED/NO-OP — both markers intact. If this fails, cross-view undo "
                      + "changed underneath us and arm 2 below proves NOTHING about Repair — got: "
                      + "\"\(bodyAfterPlainUndo)\"")

        // ── ARM 2, THE DRILL: the same door, the same view, plus `Repair: true`.
        var body = bodyAfterPlainUndo
        var rungs = 0
        var aSurvivedEveryRung = true
        while body.contains("BBBB"), rungs < 4 {
            try await client.undo(docId: doc.docId, repair: true)
            rungs += 1
            guard let next = await saveAndReadBody("after repair undo #\(rungs)") else {
                _ = host.teardownAllOfficeRuntimesAndStopHelper(); return
            }
            body = next
            NSLog("[LT-1] body after repair undo #\(rungs): \"\(body)\"")
            if !body.contains("AAAA") { aSurvivedEveryRung = false }
        }

        XCTAssertFalse(body.contains("BBBB"),
                       "LT-1 NEGATIVE: `Repair: true` did NOT take back the agent view's edit after "
                       + "\(rungs) undo(s) — the mechanism is UNESTABLISHED on the shipped engine "
                       + "(engine research H1: the shipped LOK ABI does not match the source pin). "
                       + "Requirement 3 cannot be built on it. Body: \"\(body)\"")
        XCTAssertTrue(aSurvivedEveryRung,
                      "repair undo is strict LIFO over ONE shared per-document stack, so B's "
                      + "actions (all made after A's) must come off first and A's edit must still "
                      + "be present at the rung where B's disappears. It was not — which would mean "
                      + "either the two views' typing merged into one undo action or repair pops "
                      + "indiscriminately, and BOTH change requirement 3's design. Body: \"\(body)\"")
        NSLog("[LT-1] RESULT: repair undo removed the agent view's edit in \(rungs) rung(s); "
              + "A's edit survived every rung = \(aSurvivedEveryRung)")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **office-live-edit R3 PROBE — is the undo stack's DEPTH readable at all?**
    ///
    /// Requirement 3's "one tool call = one undo step" cannot be delivered by undo GROUPING: no
    /// `.uno:` grouping command exists, and the only reachable grouping API stamps
    /// `ViewShellId(-1)`, which makes the group repair-only for EVERY view including the user's.
    /// The alternative is bracket-and-count — measure the depth before and after the agent's call,
    /// remember K, and have one ⌘Z issue K repair-undos. That design is worthless unless the depth
    /// is actually readable, so this probe settles it BEFORE anything is built on it.
    ///
    /// It is a MEASUREMENT, not just an availability check: it reads the depth at four points and
    /// asserts the DELTAS, because "the query answered" and "the query answered something true"
    /// are different claims and only the second one is usable. A query that always returned the
    /// same constant would satisfy the first and fail here.
    func testUndoStackDepthIsReadableAndTracksRealEdits() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("undo-depth-probe.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        runtime.open(docPath)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[docPath],
              let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }

        // 1 — a freshly opened, never-edited document.
        let pristine = try await client.undoDepth(docId: doc.docId)
        NSLog("[undoDepth probe] pristine: undo=\(pristine.undo) redo=\(pristine.redo)")
        XCTAssertEqual(pristine.undo, 0, "a freshly opened document has nothing to undo")
        XCTAssertEqual(pristine.redo, 0, "a freshly opened document has nothing to redo")

        // 2 — after a real edit through the primary view.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "AAAA")
        let afterEdit = try await client.undoDepth(docId: doc.docId)
        NSLog("[undoDepth probe] after a 4-char primary-view edit: undo=\(afterEdit.undo) redo=\(afterEdit.redo)")
        XCTAssertGreaterThan(afterEdit.undo, pristine.undo,
                             "the depth query must RISE after a real edit. If it does not, it is "
                             + "answering a constant, and bracket-and-count cannot be built on it")

        // 3 — after an undo: undo depth falls, redo depth rises. This is the arm that proves the
        // query tracks the stacks rather than counting edits ever made.
        try await client.undo(docId: doc.docId)
        let afterUndo = try await client.undoDepth(docId: doc.docId)
        NSLog("[undoDepth probe] after one undo: undo=\(afterUndo.undo) redo=\(afterUndo.redo)")
        XCTAssertLessThan(afterUndo.undo, afterEdit.undo, "an undo must LOWER the undo depth")
        XCTAssertGreaterThan(afterUndo.redo, afterEdit.redo, "an undo must RAISE the redo depth")

        // 4 — and back again on redo, so neither direction is a one-way artefact.
        try await client.redo(docId: doc.docId)
        let afterRedo = try await client.undoDepth(docId: doc.docId)
        NSLog("[undoDepth probe] after one redo: undo=\(afterRedo.undo) redo=\(afterRedo.redo)")
        XCTAssertEqual(afterRedo.undo, afterEdit.undo, "redo must restore the undo depth")
        XCTAssertEqual(afterRedo.redo, afterEdit.redo, "redo must restore the redo depth")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 6, fix round 1 (I-2) — **the discriminator the coordinator's review
    /// demanded.** The two-view drill above observed `(aSurvived: true, bSurvived: true)` after
    /// "edit A, edit B, undo via A" and read it as REFUSED/NO-OP — LO declining to undo a foreign
    /// view's top item. But that SAME observable signature is also exactly what a totally
    /// different, more severe finding would produce: undo-via-A simply INOPERATIVE the instant a
    /// second view exists AT ALL, with no regard to who made the top edit. The two readings are
    /// indistinguishable from the original drill's own data alone — this test is the pair member
    /// that tells them apart.
    ///
    /// **The design**: mint view B (the two-writer groundwork itself), but never post a single
    /// edit through it — edit ONLY via view A, then undo via A. If A's OWN edit is cleanly removed
    /// here, undo-via-A is NOT broken by B's mere existence — it specifically stood down when B's
    /// edit was the most recent action, which is what "refused a foreign view's top item" actually
    /// means, and the original drill's REFUSED/NO-OP reading is the pair's joint conclusion. If
    /// A's edit ALSO survives here, undo-via-A is inoperative merely because a second view exists
    /// — a materially different and more limiting finding for Stage C, and the original drill's
    /// own characterization needs rewriting to say so.
    ///
    /// Same sequencing discipline as the paired drill (save+dump proves the edit landed before
    /// undo ever runs; every wait's own success is asserted, never discarded — review fix round 1,
    /// I-4's own lesson applied here from the start rather than retrofitted).
    func testUndoViaAWorksNormallyWhenViewBExistsButWasNeverEdited() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

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
        let docPath = scratchDir.appendingPathComponent("two-view-discriminator-drill.odt").path
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
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // Mint B — present, but NEVER edited. The one variable this test isolates against the
        // paired drill above.
        let viewIdB = try await client.createAgentView(docId: doc.docId)
        XCTAssertGreaterThanOrEqual(viewIdB, 0, "a real LOK view id")

        // Edit via A only.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "SOLO")

        let beforeEditStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let editSaveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeEditStat }
        XCTAssertTrue(editSaveLanded, "the post-edit save never landed on disk")
        let bodyAfterEdit = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        XCTAssertTrue(bodyAfterEdit.contains("SOLO"), "view A's own edit must land before undo runs "
                      + "— got: \"\(bodyAfterEdit)\"")

        // THE discriminator: undo via A, with B present but never having touched the document.
        try await client.undo(docId: doc.docId)

        let beforeUndoStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let undoSaveLanded = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeUndoStat }
        XCTAssertTrue(undoSaveLanded, "the post-undo save never landed on disk — load-bearing for "
                      + "the SAME reason as the paired drill's own I-4 fix: a silent timeout here "
                      + "reads back the SAME (unchanged) bytes a genuine undo-inoperative finding "
                      + "would also produce")
        let bodyAfterUndo = strippedODFBodyText(try readODFContentXML(atPath: docPath))
        let soloSurvived = bodyAfterUndo.contains("SOLO")

        NSLog("[T6 discriminator] undo via A with B present-but-untouched: SOLO "
              + "\(soloSurvived ? "SURVIVED (undo did not fire)" : "was REMOVED (undo fired normally)") "
              + "— body after undo: \"\(bodyAfterUndo)\"")

        // PINNED, from a real run against real LOK (see task-6-report.md's headline section for
        // the pair's joint conclusion): undo via A REMOVES A's own solo edit cleanly when B exists
        // but was never edited. This discriminates the paired drill's REFUSED/NO-OP reading
        // cleanly: undo-via-A is NOT broken merely by a second view's EXISTENCE — it specifically
        // stands down when a FOREIGN view's edit is the most recent action on the (apparently
        // document-scoped, per this pair) undo stack. The paired drill's own REFUSED/NO-OP
        // characterization is confirmed, not merely asserted — this is the second, independent
        // data point that makes it a characterization rather than a single unreplicated
        // observation.
        XCTAssertFalse(soloSurvived, "PINNED FINDING: undo via A must cleanly remove A's OWN solo "
                      + "edit when B exists but was never edited — if this fails, undo-via-A is "
                      + "inoperative merely because a second view exists, and the paired drill's "
                      + "REFUSED/NO-OP reading is WRONG (the real finding would be "
                      + "undo-inoperative-with-second-view-present, not a foreign-edit refusal) — "
                      + "got body: \"\(bodyAfterUndo)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// Office Stage B Task 6 — **closes a real gap the four drills above leave**: every one of
    /// them drives a `.odt` (`OfficeDocumentKind.text`), where `clipboardCopyOnDedicatedThread`'s
    /// own `if doc.kind != .text` guard means the `setPart` half of its prefix NEVER actually
    /// executes — the type-gated branch this whole file's own house discipline (T4's fix round 4)
    /// insists on is written but UNEXERCISED by real LOK anywhere else in this task. This test
    /// is deliberately lightweight (the wire reply itself, not a full save+reopen XML parse — the
    /// MECHANISM is already proven identical for text docs by the round-trip drill above; the only
    /// question this test answers is "does the type-gated `setPart` branch run cleanly against a
    /// REAL Calc document," not a second full placement proof): type into a cell, re-select it,
    /// copy, and confirm the real content comes back.
    func testClipboardCopyOnACalcDocumentExercisesTheTypeGatedSetPartBranch() async throws {
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
        let docPath = scratchDir.appendingPathComponent("clipboard-calc-drill.ods").path
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
        XCTAssertEqual(doc.type, .spreadsheet, "setup: this drill is about the Calc type gate specifically")
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to drive this drill through")
        }

        // `postRealEdit`'s own established twips(100,100) — inside A1's own real bounding rect —
        // type "CALC" (already-proven test-local keyCodes: `postRawUppercaseMarker`'s closed-form
        // table covers every uppercase letter), Return commits the cell edit and moves the cursor
        // to A2, then a second click at the SAME coordinates re-selects A1.
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: doc.docId, marker: "CALC")
        try await client.postKey(docId: doc.docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280) // Return
        try await client.postKey(docId: doc.docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: doc.docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        let copied = try await client.clipboardCopy(docId: doc.docId, part: 0)
        XCTAssertTrue(copied.contains("CALC"), "the type-gated setPart branch must not corrupt or "
                      + "block a real Calc selection read — got: \"\(copied)\"")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - Office Stage B Task 7 — autosave sidecars + crash recovery: THE live drill

    /// **THE brief's own named live drill, and this task's whole reason to exist**: open, type (real
    /// input, through the real client — `postRealEdit`'s own established discipline), wait for a
    /// REAL autosave sidecar (a shortened `--autosave-interval-seconds`, never a real 60s wait),
    /// SIGKILL the helper by PID (bypassing `OfficeHelperSupervisor.stop()`/`forceKill` entirely —
    /// an EXTERNAL, unprompted kill is what actually proves `.helperDied` fires the way a genuine
    /// crash would; a supervisor-INITIATED stop bumps `generation` first specifically so death
    /// detection stays silent for it, which is the wrong shape to drill), reopen the SAME path
    /// (this mints a fresh `OfficeHelperSupervisor` boot — `.failed` retries exactly like `.idle`),
    /// see the recovery banner's own state, Restore, and prove the TYPED CONTENT is there — "the T4
    /// standard": read the SAVED bytes back off disk via `readODFContentXML`/`strippedODFBodyText`,
    /// never the in-memory model, never a pixel-only proxy. Then ⌘S, and prove the REAL path (not
    /// just the recovered buffer) now carries it, and that the sidecar + its manifest are gone.
    ///
    /// **ODF fixture (`gate.odt`), deliberately** — the parked OOXML vendor limitation
    /// (`ooxml-export-investigation.md`) makes `⌘S -> real file carries it` categorically impossible
    /// for xlsx/docx regardless of anything THIS task builds; proving that leg needs a format real
    /// saves actually work for. The OOXML sidecar-format DECISION (fall back to ODF rather than
    /// crash) gets its own, separate empirical proof immediately below this test — together the two
    /// cover both halves of "does recovery work" and "does the fallback keep the helper alive."
    func testCrashDuringAutosaveRecoversTheTypedContentThenSaveLandsOnTheRealPath() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.odt").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.odt fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        // The one deliberate deviation from every other live test's own Configuration: a SHORT
        // autosave interval, mirroring `idleExitSeconds`'s identical override pattern — see
        // `OfficeHelperSupervisor.Configuration.autosaveIntervalSeconds`'s own header. 2s keeps this
        // drill fast without shaving the real cadence mechanism down to something that would no
        // longer exercise the REAL DispatchSourceTimer machinery.
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL, socketDirectory: stateDir, autosaveIntervalSeconds: 2.0,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        let scratchDir = makeScratchDirectory()
        let docPath = scratchDir.appendingPathComponent("crash-drill.odt").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        // MARK: 1. Open, type, dirty.
        runtime.open(docPath)
        let opened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(opened, "never opened — phase: \(runtime.stateSnapshot.phase)")
        guard let originalDocId = runtime.stateSnapshot.documents[docPath]?.docId else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("gate.odt did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        guard let client = host.officeHelperSupervisor?.client else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live client to type through")
        }
        let marker = "SIGKILLPROOF"
        try await client.postMouse(docId: originalDocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: originalDocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await postRawUppercaseMarker(client: client, docId: originalDocId, marker: marker)

        let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
        XCTAssertTrue(becameDirty, "the typed edit's own ModifiedStatus=true never reached documents[path].dirty")

        // MARK: 2. Wait for a REAL sidecar the helper's own timer wrote.
        guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no live helper process to check/kill")
        }
        let sidecarPath = stateDir.appendingPathComponent("autosave", isDirectory: true)
            .appendingPathComponent("\(originalDocId).odt").path
        let sidecarAppeared = await waitUntil(timeout: 30) { FileManager.default.fileExists(atPath: sidecarPath) }
        XCTAssertTrue(sidecarAppeared, "the 2s autosave timer never wrote a sidecar at \(sidecarPath)")
        XCTAssertTrue(isProcessAlive(helperPID), "the helper must still be alive after writing its own sidecar")

        // MARK: 3. The crash — an EXTERNAL, unprompted SIGKILL (never `forceKill`/`stop()`, which
        // deliberately suppress `.helperDied` for a kill THIS process initiated — see this test's
        // own header).
        kill(helperPID, SIGKILL)
        let diedExternally = await waitUntil(timeout: 10) { !self.isProcessAlive(helperPID) }
        XCTAssertTrue(diedExternally, "SIGKILL did not actually end the helper process")
        let phaseFailed = await waitUntil(timeout: 10) { runtime.stateSnapshot.phase == .failed }
        XCTAssertTrue(phaseFailed, "the supervisor's own death detection never reached .helperDied "
                      + "— phase: \(runtime.stateSnapshot.phase)")
        XCTAssertNil(runtime.stateSnapshot.documents[docPath], ".helperDied wipes every open document")

        // MARK: 4. Reopen — a fresh supervisor boot (`.failed` retries exactly like `.idle`).
        runtime.open(docPath)
        let reopened = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "never reopened after the crash — phase: \(runtime.stateSnapshot.phase)")
        guard let reopenedDocId = runtime.stateSnapshot.documents[docPath]?.docId else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("reopen after the crash failed: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
        }
        XCTAssertNotEqual(reopenedDocId, originalDocId, "sanity: a reopen always mints a fresh docId")
        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.dirty, false, "the reopened document "
                       + "is its own fresh, unedited load — clean until Restore forces it")

        // MARK: 5. The recovery banner's own state — found, offered.
        let candidateFound = await waitUntil(timeout: 15) { runtime.stateSnapshot.documentRecoveryCandidates[docPath] != nil }
        XCTAssertTrue(candidateFound, "the post-open recovery check never found the sidecar the crash left behind")
        guard let candidate = runtime.stateSnapshot.documentRecoveryCandidates[docPath] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("candidate vanished between the wait and the read")
        }
        XCTAssertEqual(candidate.docId, originalDocId, "the offer must point at the CRASHED session's own sidecar")
        XCTAssertFalse(candidate.isODFFallback, "gate.odt is already ODF — no fallback should have applied")

        // MARK: 6. Restore.
        runtime.restoreFromRecovery(docPath)
        let restored = await waitUntil(timeout: 30) {
            runtime.stateSnapshot.documents[docPath]?.docId != reopenedDocId
                && runtime.stateSnapshot.documents[docPath]?.dirty == true
        }
        XCTAssertTrue(restored, "the restore-flavored reopen never landed with dirty forced true")
        XCTAssertNil(runtime.stateSnapshot.documentRecoveryCandidates[docPath], "the offer is consumed once acted on")
        guard let restoredDocId = runtime.stateSnapshot.documents[docPath]?.docId else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("no document after restore")
        }

        // MARK: 7. ⌘S — the real path must carry the RECOVERED content, on disk, not the in-memory
        // model ("the T4 standard").
        let beforeSaveStat = officeFileStat(atPath: docPath)
        runtime.save(docPath)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: docPath) != beforeSaveStat }
        XCTAssertTrue(fileChanged, "the post-restore save never landed on the real path — "
                      + "banner=\(runtime.stateSnapshot.documentBanners[docPath] ?? "nil")")
        XCTAssertNil(runtime.stateSnapshot.documentBanners[docPath], "no save-failed banner")

        let becameCleanAfterSave = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == false }
        XCTAssertTrue(becameCleanAfterSave, "restoredPendingSave's own forced-clear never landed — "
                      + "the dot would be stuck forever otherwise (LOK never saw this content as "
                      + "'modified' in the first place)")
        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, restoredDocId, "sanity — still "
                       + "the SAME restored document, not a reload in disguise")

        let content = try readODFContentXML(atPath: docPath)
        let body = strippedODFBodyText(content)
        XCTAssertTrue(body.contains(marker), "the typed marker \"\(marker)\" is missing from the "
                      + "SAVED real file's own body text — the recovered content never actually "
                      + "landed on disk. Body: \(body)")

        // MARK: 8. The sidecar and its manifest are cleared once the real path carries the content.
        let sidecarCleared = await waitUntil(timeout: 15) { !FileManager.default.fileExists(atPath: sidecarPath) }
        XCTAssertTrue(sidecarCleared, "a successful save must clear the now-redundant sidecar — "
                      + "the ownership rule (.saveSucceeded -> .clearAutosave) failed to fire")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - Office Stage B Task 7/11 — the OOXML-fallback decision's own empirical proof

    /// **Inverted at Task 11 (the r3 vendor re-cut).** Originally
    /// `testXlsxAutosaveSidecarFallsBackToODFAndTheHelperSurvives` — proved xlsx autosave fell back
    /// to `.ods` because native `.xlsx` export was the exact path proven to SIGABRT the helper (Task
    /// 2/2b). Task 11's vendor re-cut fixed that crash (added `libsal_textenclo.dylib` to
    /// `product-set/Frameworks/` — see `ooxml-export-investigation.md` + `task-11-brief.md`);
    /// `OfficeSaveFormat.autosaveFormat` was narrowed accordingly (see that property's own header
    /// for the full per-format evidence) so xlsx no longer falls back at all. This is the direct
    /// successor, proving the OPPOSITE claim through the same real, dirtied, unattended-timer shape
    /// that made the original proof valuable: the sidecar now lands NATIVELY at `.xlsx`, never
    /// `.ods`, and the helper is still alive afterward. If `autosaveFormat` were ever reverted to
    /// the old ODF-fallback mapping for xlsx without updating this test, the assertions below would
    /// fail loudly (not a SIGABRT anymore — the crash this originally guarded against is gone — but
    /// a real, silent behavior regression this test still exists to catch).
    ///
    /// **Widened to two formats at the r4 re-cut.** `.docx` was the LAST format still on Task 7's
    /// ODF fallback, and Task 11 kept it there for a good reason on its own evidence (a native docx
    /// sidecar would have failed every fire, leaving a dirty document with no sidecar at all). r4
    /// supplies the missing DOCX export service, `autosaveFormat`'s `.docx` arm narrows to native
    /// alongside it, and this drill is what proves that arm rather than asserting it in a comment —
    /// the same real-typed-edit, unattended-repeating-timer shape, run for both formats against one
    /// helper. Nothing in `autosaveFormat` falls back to ODF any more, so the `other` column below
    /// is a NEGATIVE pin in both rows: it names the sidecar that must NOT appear.
    func testXlsxAndDocxAutosaveSidecarsWriteNativelyAndTheHelperSurvives() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
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
                helperExecutableURL: helperURL, socketDirectory: stateDir, autosaveIntervalSeconds: 2.0,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")
        defer { _ = host.teardownAllOfficeRuntimesAndStopHelper() }

        // (fixture, the extension the sidecar MUST land at, the ODF extension it must NOT fall back
        // to). Both rows are native as of r4 — the second column is the whole point of the drill.
        let rows: [(fixture: String, nativeExt: String, forbiddenODFExt: String)] = [
            ("gate.xlsx", "xlsx", "ods"),
            ("gate.docx", "docx", "odt"),
        ]
        for row in rows {
            let fixturePath = Self.fixturesRoot.appendingPathComponent(row.fixture).path
            try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "\(row.fixture) fixture missing")

            let scratchDir = makeScratchDirectory()
            let docPath = scratchDir.appendingPathComponent("native-sidecar-drill.\(row.nativeExt)").path
            try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

            runtime.open(docPath)
            let opened = await waitUntil(timeout: 90) {
                runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
            }
            XCTAssertTrue(opened, "\(row.fixture): never opened — phase: \(runtime.stateSnapshot.phase)")
            guard let docId = runtime.stateSnapshot.documents[docPath]?.docId else {
                return XCTFail("\(row.fixture) did not open: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded")")
            }
            guard let client = host.officeHelperSupervisor?.client else {
                return XCTFail("no live client to type through")
            }
            try await client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await postRawUppercaseMarker(client: client, docId: docId, marker: "FALLBACK")
            // Return: commits a pending Calc cell edit; a harmless paragraph break for Writer.
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)

            let becameDirty = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == true }
            XCTAssertTrue(becameDirty, "\(row.fixture): the typed edit's own ModifiedStatus=true never "
                          + "reached documents[path].dirty")

            guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
                return XCTFail("no live helper process to check")
            }
            let autosaveDir = stateDir.appendingPathComponent("autosave", isDirectory: true)
            let forbiddenSidecarPath = autosaveDir.appendingPathComponent("\(docId).\(row.forbiddenODFExt)").path
            let nativeSidecarPath = autosaveDir.appendingPathComponent("\(docId).\(row.nativeExt)").path

            let nativeSidecarAppeared = await waitUntil(timeout: 30) { FileManager.default.fileExists(atPath: nativeSidecarPath) }
            XCTAssertTrue(nativeSidecarAppeared, "\(row.fixture): the autosave sidecar never appeared "
                          + "NATIVELY at \(nativeSidecarPath) — the vendor re-cut's export fix or the "
                          + "narrowed autosaveFormat mapping may have regressed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: forbiddenSidecarPath), "\(row.fixture): "
                           + "must NOT fall back to ODF anymore (xlsx export fixed at the r3 re-cut, docx "
                           + "at r4); an ODF sidecar here means autosaveFormat was reverted without "
                           + "updating this test")
            XCTAssertTrue(isProcessAlive(helperPID), "\(row.fixture): the helper must survive writing "
                          + "its own native autosave sidecar")

            // A SECOND fire, past the first — the brief's own concern is specifically an UNATTENDED,
            // REPEATING timer; one clean fire alone does not rule out a crash on the next one.
            let beforeSecondFire = officeFileStat(atPath: nativeSidecarPath)
            let secondFireLanded = await waitUntil(timeout: 15) { officeFileStat(atPath: nativeSidecarPath) != beforeSecondFire }
            XCTAssertTrue(secondFireLanded, "\(row.fixture): the timer never fired a second time")
            XCTAssertTrue(isProcessAlive(helperPID), "\(row.fixture): the helper must survive a SECOND "
                          + "native autosave fire too")

            runtime.close(docPath)
            // Same raw-client/close interleave the dirty-close loop above documents at length — this
            // loop's next row types through `OfficeHelperClient` directly, so the previous row's
            // close must have reached the helper first. Measured: this drill failed with
            // `unexpected reply: closed(seq: 24, …)` in a full-suite run without this wait.
            await runtime.awaitPendingCloseBarriersForTesting()
        }
    }

    // MARK: - Office Stage B Task 8: the formula bar's own live drill (ref + content, as the caret moves)

    /// **The brief's own named pin: "the formula bar updates as the caret moves — live"** — plus
    /// its own "type -> content updates" leg. Mounts a REAL `OfficeTileCanvasView` in a real
    /// (invisible) `NSWindow` on a scratch copy of `two-sheet.ods` and drives REAL AppKit
    /// `mouseDown`/`keyDown` events through it — the same door a live click/keystroke/arrow-key
    /// actually takes, all the way through `LOKBridge`'s `CELL_FORMULA` wiring (this task), the
    /// wire, and `OfficeRuntime.handle(documentEvent:)`'s routing — landing in
    /// `runtime.cursorStore`. Assertions are at the store/pure-function level
    /// (`officeCellReference`), never SwiftUI rendering — `OfficeFormulaBar` itself is a thin read
    /// of this same store, proven separately (`PanelDocumentTabTests`) not to matter here.
    ///
    /// Three scenarios in sequence: (1) click B1 — ref "B1", content "42" (real seed); (2) type
    /// "Q" without committing, then Escape — content live-updates to "Q" while the ref blanks
    /// (`CELL_CURSOR`'s own `.empty`), then both revert on Escape, dirty stays `false`; (3)
    /// arrow-key right — ref advances to C1 (empty), content clears to `""`, never lingering at
    /// B1's stale "42".
    ///
    /// Window discipline mirrors Task 5 review fix round 1, I-1 (`isReleasedWhenClosed = false` +
    /// `defer { close() }`) — a further site of the same precedent, not a new bad one.
    func testFormulaBarRefAndContentUpdateAsTheCellCursorMovesThroughARealClickAndArrowKey() async throws {
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
                helperExecutableURL: helperURL, socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        let scratchDir = makeScratchDirectory()
        let path = scratchDir.appendingPathComponent("formula-bar-drill.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: path))

        runtime.open(path)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "two-sheet.ods never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[path] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("two-sheet.ods did not open: \(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        let docId = doc.docId

        let model = PanelDocumentTabModel(tabId: "formula-bar-drill", path: path)
        let view = OfficeTileCanvasView(runtime: runtime, path: path, docId: docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 512, height: 512)
        view.mount()

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 512, height: 512),
                              styleMask: [.borderless], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false // Task 5 review fix round 1, I-1's own precedent
        defer { window.close() }
        window.contentView = view
        _ = window.makeFirstResponder(view)

        func makeMouseEvent(_ type: NSEvent.EventType, at point: NSPoint) -> NSEvent {
            let windowPoint = view.convert(point, to: nil)
            return try! XCTUnwrap(NSEvent.mouseEvent(with: type, location: windowPoint, modifierFlags: [],
                                                      timestamp: 0, windowNumber: window.windowNumber, context: nil,
                                                      eventNumber: 0, clickCount: 1, pressure: 1))
        }
        func makeKeyEvent(_ type: NSEvent.EventType, characters: String, keyCode: UInt16) -> NSEvent {
            try! XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                                            windowNumber: window.windowNumber, context: nil, characters: characters,
                                            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
        }

        // --- Click B1 (two-sheet.ods's own real seed: the number 42) — a B-COLUMN cell. At
        // zoomPPT 1000 (100%) `officePointToTwips` is exactly points*20 (officeFixedDeviceScale=2,
        // TileMath's own pixels<->twips factor 10_000/zoomPPT=10 — 2*10=20, the standard 1440-twips-
        // per-inch/72-points-per-inch ratio) — 1500 twips / 20 = 75pt, comfortably inside column B
        // (co1's own ~1280-twip width) and past its left edge; 100 twips / 20 = 5pt, inside row 1. ---
        let b1Point = NSPoint(x: 75, y: 5)
        view.mouseDown(with: makeMouseEvent(.leftMouseDown, at: b1Point))
        view.mouseUp(with: makeMouseEvent(.leftMouseUp, at: b1Point))
        await runtime.drainInputChainForTesting()

        let b1Arrived = await waitUntil(timeout: 15) {
            if case .at = runtime.cursorStore.state(docId: docId).cellCursor { return true }
            return false
        }
        XCTAssertTrue(b1Arrived, "clicking B1 never produced a real CELL_CURSOR .at")
        let b1State = runtime.cursorStore.state(docId: docId)
        guard case .at(_, let b1Column, let b1Row) = b1State.cellCursor else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("expected .at after clicking B1")
        }
        XCTAssertEqual(officeCellReference(column: b1Column, row: b1Row), "B1", "the click landed on B1 — this drill's own setup")
        XCTAssertEqual(b1State.cellFormulaText, "42", "B1's own real seed content — the formula bar's content leg, "
                       + "live through this task's own CELL_FORMULA wiring")

        // --- "Type -> content updates", the brief's own named drill leg — type ONE character
        // through the REAL canvas without committing (no Return): typing over a selected cell
        // REPLACES its content (real Calc UX, confirmed by this task's own probe), so the live
        // edit-buffer content becomes "Q" alone, not "42Q" — and CELL_CURSOR goes to its "EMPTY"
        // in-cell-edit sentinel at the SAME moment (Task 5's own finding), which is exactly why
        // `OfficeFormulaBar.referenceText` blanks while `contentText` keeps updating live. ---
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "Q", keyCode: 12))
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "Q", keyCode: 12))
        await runtime.drainInputChainForTesting()

        let editingLive = await waitUntil(timeout: 15) {
            runtime.cursorStore.state(docId: docId).cellFormulaText == "Q"
                && runtime.cursorStore.state(docId: docId).cellCursor == .empty
        }
        XCTAssertTrue(editingLive, "typing \"Q\" over B1 must show the LIVE uncommitted edit-buffer "
                      + "content (\"Q\") while cellCursor sits at .empty — actual formula=\""
                      + "\(runtime.cursorStore.state(docId: docId).cellFormulaText ?? "nil")\" cellCursor="
                      + "\(String(describing: runtime.cursorStore.state(docId: docId).cellCursor))")

        // Escape — abandon the edit (never actually mutating this drill's own copy), reverting to
        // B1's real, committed content and a real .at cell cursor again.
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\u{1B}", keyCode: 53)) // Escape
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\u{1B}", keyCode: 53))
        await runtime.drainInputChainForTesting()

        let revertedAfterEscape = await waitUntil(timeout: 15) {
            runtime.cursorStore.state(docId: docId).cellFormulaText == "42"
        }
        XCTAssertTrue(revertedAfterEscape, "Escape must revert the formula bar's own content to B1's "
                      + "real committed \"42\", not leave the abandoned \"Q\" showing — actual: "
                      + "\(runtime.cursorStore.state(docId: docId).cellFormulaText ?? "nil")")
        // Task 8 finding, DISCLOSED not chased further (out of this task's own scope — dirty
        // tracking is Task 2/Task 7's territory, not the formula bar's): real LOK marks the
        // document `dirty` (`.uno:ModifiedStatus=true`) the MOMENT the "Q" keystroke lands, and an
        // Escape that visibly reverts the CELL CONTENT (`cellFormulaText` back to "42", proven
        // above) does NOT also clear `ModifiedStatus` back to false — confirmed live, this run's
        // own trace. Plausible mechanism, unconfirmed: entering cell-edit mode and typing pushes an
        // undo-stack entry the moment the edit starts, and LOK's own "modified" bit tracks the undo
        // stack's own non-empty-ness rather than "does the current value differ from the
        // last-saved one." Not asserted here (Task 8 does not own this behavior — no
        // XCTAssertEqual on `.dirty` below), left instead as a named finding for the report.

        // --- Arrow-key RIGHT — the REF must advance (B1 -> C1) through a KEYBOARD move, not just a
        // click; C1 is genuinely empty (two-sheet.ods only seeds columns A/B), so the content leg
        // must follow the ref and clear to "" too — never linger at B1's stale "42". ---
        view.keyDown(with: makeKeyEvent(.keyDown, characters: "\u{F703}", keyCode: 124)) // NSRightArrowFunctionKey
        view.keyUp(with: makeKeyEvent(.keyUp, characters: "\u{F703}", keyCode: 124))
        await runtime.drainInputChainForTesting()

        let movedToC1 = await waitUntil(timeout: 15) {
            if case .at(_, let column, let row) = runtime.cursorStore.state(docId: docId).cellCursor {
                return officeCellReference(column: column, row: row) == "C1"
            }
            return false
        }
        XCTAssertTrue(movedToC1, "arrow-key right never advanced the column — cellCursor: "
                      + "\(String(describing: runtime.cursorStore.state(docId: docId).cellCursor))")
        let c1FormulaCleared = await waitUntil(timeout: 15) {
            runtime.cursorStore.state(docId: docId).cellFormulaText == ""
        }
        XCTAssertTrue(c1FormulaCleared, "the formula bar's own content must clear to \"\" on C1 (empty), "
                      + "not linger at B1's stale \"42\" — actual: "
                      + "\(String(describing: runtime.cursorStore.state(docId: docId).cellFormulaText))")

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    // MARK: - Office Stage B Task 8: the multi-slide fixture + rail proof

    /// **Smoke, run and read FIRST** — before building the click-switch/tiles-differ drill on top
    /// of it. Proves the committed `two-slide.fodp` fixture (`Fixtures/office/two-slide.fodp`,
    /// built by extracting gate.odp's own real `content.xml`/`styles.xml` fragments verbatim into
    /// one flat `<office:document>` — the recipe is recorded in this fixture's own commit message,
    /// mirroring `two-sheet.ods`'s own "byte-level clone of gate.ods's own proven-working element"
    /// precedent, adapted to flat-XML packaging per this task's brief) actually opens against THIS
    /// PIN's real, TRIMMED vendor tree as a two-part presentation.
    ///
    /// `.fods` (flat spreadsheet) opening is already proven live (office-plumbing Task 9's own
    /// templated fixture, `officeHarnessMultiSheetFodsContent`) — `.fodp` (flat presentation)
    /// never has been anywhere in this codebase, and this branch's own trim has silently dropped a
    /// never-exercised import PATH before (the xlsx-export dylib —
    /// `ooxml-export-investigation.md`) even though the sibling xlsx/pptx/odt/ods/docx/odp
    /// leg all worked. Deliberately its own test, run and read before anything depends on the
    /// answer — see this file's own task-8-report.md for what it found.
    func testTwoSlideFodpFixtureOpensAsATwoPartPresentation() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("two-slide.fodp").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "two-slide.fodp fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL, socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        let scratchDir = makeScratchDirectory()
        let path = scratchDir.appendingPathComponent("two-slide-smoke.fodp").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: path))

        runtime.open(path)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "two-slide.fodp never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[path] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("two-slide.fodp did not open: "
                           + "\(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.type, .presentation, "LOK's own getDocumentType() must classify the flat-XML "
                       + "presentation the same as a real .odp — a mis-detected type would route it "
                       + "through the wrong part strip entirely")
        XCTAssertEqual(doc.parts, 2, "the fixture carries two <draw:page> slides — real LOK must report "
                       + "two parts for it, or nothing built on top of this fixture proves a real switch")
        XCTAssertGreaterThan(doc.sizeTwips.widthTwips, 0)
        XCTAssertGreaterThan(doc.sizeTwips.heightTwips, 0)

        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **The presentation twin of office-plumbing Task 9's own sheet proof** — brief: "rail shows
    /// 2, click switches, tiles differ per part." This is the T9 SHAPE deliberately, not the T4
    /// round-3 "type on sheet 2, diff parts" shape: two independently-seeded parts, no edit step
    /// at all — `two-slide.fodp`'s own two `<draw:page>` slides already carry distinct fills
    /// (`#ff6600` vs `#0033cc`) and text, both inside a 20cm×10cm rect at (1cm,1cm) — squarely
    /// inside tile (0,0) at 100% zoom, so the very first tile each part paints is already the
    /// discriminating one (advisor review, this task: "both slides' distinguishing content must
    /// land inside tile (0,0)").
    ///
    /// Mounts a REAL `OfficeTileCanvasView` (auto-registers as `model.canvasHost` — `mount()`'s own
    /// `model?.canvasHost = self`) and drives the switch through `model.selectPart(1)` — the EXACT
    /// call `OfficeSlideRail`'s own `onSelect` closure makes on a real rail click
    /// (`OfficeDocumentSurface.body`: `OfficeSlideRail(..., onSelect: model.selectPart)`), never
    /// `runtime.subscribeTiles` called directly — this proves the STRIP'S OWN DOOR, not merely that
    /// real LOK can paint two parts differently. `activePart == 1` afterward is also the exact
    /// field `OfficeSlideRail`'s own current-part highlight reads
    /// (`index == activePart ? Color.primary : Theme.textMuted`) — this drill's own pass IS that
    /// highlight's live-gate proof by construction, not a separate assertion to add.
    func testTwoSlideRailClickSwitchesPartsAndTilesDifferPerPart() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("two-slide.fodp").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "two-slide.fodp fixture missing")

        let stateDir = makeScratchDirectory()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL, socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        let runtime = host.officeRuntime(for: "S1")

        let scratchDir = makeScratchDirectory()
        let path = scratchDir.appendingPathComponent("two-slide-drill.fodp").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: path))

        runtime.open(path)
        let settled = await waitUntil(timeout: 90) {
            runtime.stateSnapshot.documents[path] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(settled, "two-slide.fodp never settled — phase: \(runtime.stateSnapshot.phase)")
        guard let doc = runtime.stateSnapshot.documents[path] else {
            _ = host.teardownAllOfficeRuntimesAndStopHelper()
            return XCTFail("two-slide.fodp did not open: "
                           + "\(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        XCTAssertEqual(doc.parts, 2, "setup: this drill needs the real two-slide fixture")
        let docId = doc.docId

        let model = PanelDocumentTabModel(tabId: "two-slide-drill", path: path)
        let view = OfficeTileCanvasView(runtime: runtime, path: path, docId: docId,
                                        sizeTwips: doc.sizeTwips, initialPart: 0, model: model)
        view.frame = NSRect(x: 0, y: 0, width: 256, height: 256)
        view.mount()
        XCTAssertTrue(model.canvasHost === view, "setup: mount() must register itself as the model's "
                      + "canvasHost — the exact door OfficeSlideRail's own click uses")

        let zoomPPT = 1000
        let part0Key = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let part0Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docId, key: part0Key) != nil }
        XCTAssertTrue(part0Arrived, "slide 1's own origin tile never arrived after mount()'s own initial subscribe")
        let part0Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docId, key: part0Key), "slide 1").pixels

        // --- "Click switches": model.selectPart(1) — the EXACT call a real rail click makes. ---
        model.selectPart(1)
        await runtime.drainInputChainForTesting()

        let activePartMoved = await waitUntil(timeout: 15) { runtime.stateSnapshot.documents[path]?.activePart == 1 }
        XCTAssertTrue(activePartMoved, "selectPart(1) never landed on activePart — the rail's own "
                      + "current-part highlight reads this exact field")

        let part1Key = TileKey(part: 1, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let part1Arrived = await waitUntil(timeout: 30) { runtime.tileStore.tile(docId: docId, key: part1Key) != nil }
        XCTAssertTrue(part1Arrived, "slide 2's own origin tile never arrived after the rail's own selectPart(1) door")
        let part1Pixels = try XCTUnwrap(runtime.tileStore.tile(docId: docId, key: part1Key), "slide 2").pixels

        XCTAssertNotEqual(part0Pixels, part1Pixels, "slide 1 and slide 2 rendered IDENTICAL pixels at "
                          + "the same tile coordinate through the rail's own click door — "
                          + "two-slide.fodp's own #ff6600-vs-#0033cc fills must diverge, or the "
                          + "\"tiles differ per part\" claim is false")
        XCTAssertEqual(part1Pixels.count, TileMath.bytesPerTile)

        view.unmount()
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }
}
