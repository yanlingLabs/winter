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
                extraArguments: ["--lok-root", vendorRoot.path]))
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
    /// never assert a key TileMath and the production code would disagree about. **Part switching is
    /// NOT exercised against real LOK data**: every `gate.*` fixture in this repo has exactly one
    /// part (`OfficeHelperLiveTests`'s own `Expectation` table — no multi-sheet/multi-slide fixture
    /// exists), so `subscribeTiles(part: 0, ...)` is called a second time as the closest honest proxy
    /// (proves the wire call survives a repeat ask) rather than a real cross-part switch. The
    /// PLUMBING for a part switch (`OfficeTileCanvasView.setActivePart` resubscribing) is proven live
    /// at the recorder level in `OfficeTileCanvasViewTests` instead — disclosed, not silently skipped.
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
                extraArguments: ["--lok-root", vendorRoot.path]))
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

        // --- Part: gate.xlsx has exactly one sheet (parts == 1) — see this test's own header for
        // why a genuine cross-part switch cannot be exercised against real data here. Proves the
        // repeat call at least survives, not a part boundary. ---
        XCTAssertEqual(doc.parts, 1, "if this ever changes, extend this test to a real second-part ask")
        runtime.subscribeTiles(path: gatePath, part: 0, zoomPPT: zoomPPT1000, viewportTwips: coldViewport)
        try? await Task.sleep(nanoseconds: 200_000_000) // let it settle; nothing new is expected

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
                extraArguments: ["--lok-root", vendorRoot.path]))
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
        guard let helperPID = host.officeHelperSupervisor?.process?.processIdentifier else {
            return XCTFail("supervisor has no live process to check")
        }
        XCTAssertTrue(isProcessAlive(helperPID), "the reload must not have gone through a supervisor "
                      + "restart — the helper process identity itself must be unchanged")

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
