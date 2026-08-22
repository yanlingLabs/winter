import XCTest
@testable import Norma

/// Office Stage A Task 2 — the one test in this task that touches the REAL, compiled
/// `NormaOfficeHelper` binary rather than the test fixture (`OfficeSupervisorTests` uses the
/// fixture for everything else, deliberately — see that file's header). Proves the actual shipped
/// process binds, accepts, handshakes, answers a ping, and idle-exits, against a scratch state
/// directory — never `~/.norma*`, never the user's app.
///
/// Skips (does not fail) if the real helper was not built into this run's `BUILT_PRODUCTS_DIR` —
/// the same shape `EditorPlumbingTests`' `bridge-protocol.js` pin uses (`XCTSkipIf`, with a
/// message naming exactly what's missing): a live gate that goes live the moment the artifact
/// exists, not a hard requirement of every possible test invocation (e.g. a target list that
/// doesn't include `NormaOfficeHelper`).
///
/// Task 3 update: this binary now boots REAL LibreOfficeKit unconditionally (main.swift's boot
/// sequencing runs before the socket even binds) — this test spawns the STANDALONE build product
/// (`BUILT_PRODUCTS_DIR/NormaOfficeHelper`, not the app-embedded copy; `OfficeHelperLiveTests`'
/// `.officeLive` class owns the embedded-root proof), which has no `Contents/Resources/LibreOffice`
/// sibling of its own — so it now ALSO needs `--lok-root` pointing at the vendor tree, and is
/// ALSO vendor-gated. `lokVersion` is no longer the Stage-A placeholder (one of the sentinel's 4
/// pinned call sites — see `officeWireStageALOKVersionPlaceholder`'s own header); the STRICT
/// VERSION-PIN comparison lives in `OfficeHelperLiveTests` (this file's own scope stays "the
/// supervision contract," not LOK specifics).
final class OfficeHelperLiveSmokeTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/offlive-\(UUID().uuidString.prefix(8))", isDirectory: true)
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

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Tests/NormaAppTests/OfficeHelperLiveSmokeTests.swift`
    /// — five `deletingLastPathComponent()` hops strip the filename, `NormaAppTests`, `Tests`,
    /// `Norma`, `apple`, leaving `<repoRoot>` (same climbing pattern as `CliLauncher.defaultRepoRoot`).
    private static var vendorProductSetRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url.appendingPathComponent("apple/Norma/vendor/libreoffice/product-set", isDirectory: true)
    }
    /// Office Stage B Task 1 — same repo-root climb as `vendorProductSetRoot` above, for the
    /// checked-in seatbelt profile SOURCE. This test spawns the STANDALONE `BUILT_PRODUCTS_DIR`
    /// build product directly (never the app-embedded copy — see this file's own header), which has
    /// no `Contents/Resources/office-helper.sb` sibling of its own, so — exactly like `--lok-root`
    /// a few lines below — it needs an explicit `--sandbox-profile` override or `main.swift`'s
    /// default (no-override) two-dirs-up resolution finds nothing and this helper refuses to boot at
    /// all (fail-closed, by design: found via a deliberate sweep of every OTHER real-helper spawn
    /// site in this test bundle after `OfficeHelperLiveTests.spawnLiveHelper` was fixed, not by this
    /// test failing first — see task-1-report.md).
    private static var sandboxProfilePath: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }

    func testRealHelperBindsHandshakesPingsAndIdleExits() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run. "
                        + "This pin goes live the moment it's built.")
        // Task 3: this standalone build product has no Contents/Resources/LibreOffice sibling of
        // its own (that only exists inside the app-embedded copy) — --lok-root points it at the
        // vendor tree instead, same shape either way (Frameworks/+Resources/ as real siblings).
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root. This pin goes live the "
                        + "moment it's fetched.")

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        let token = "live-smoke-token"

        let process = Process()
        process.executableURL = helperURL
        // 1s idle-exit (not the brief's real 120s default): this test bounds its own wait at 8s
        // below, not two real minutes, to prove idle-exit happens at all.
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", token, "--idle-exit-seconds", "1",
                              "--lok-root", vendorRoot.path,
                              "--sandbox-profile", Self.sandboxProfilePath.path]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }

        // 60s: matches OfficeHelperLiveTests' own measured bound (a cold libmergedlo.dylib dlopen
        // this OS session needed more than 20s; see that file's comment for the full measurement).
        let socketAppeared = await waitUntil(timeout: 60.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "real helper never created its socket file (LOK boot now runs before bind — "
                        + "a cold dlopen can need well over the old 5s budget; see task-3 report)")

        let connection = OfficeWireConnection(socketPath: socketPath)
        try await connection.open()

        try await connection.send(.hello(seq: 1, role: .app, token: token))
        guard let helloReply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("no reply to hello from the real helper")
            return
        }
        guard case .helloOk(let seq, let lokVersion) = helloReply else {
            XCTFail("expected helloOk from the real helper, got \(helloReply)")
            return
        }
        XCTAssertEqual(seq, 1)
        // Task 3: LOK now boots for real even for this "just prove the supervision contract" test
        // — one of the lok-not-loaded sentinel's 4 pinned call sites (see that constant's own
        // header). The STRICT VERSION-PIN-vs-BuildId comparison lives in OfficeHelperLiveTests;
        // this assertion only proves LOK really did boot here (not the placeholder, not empty).
        XCTAssertNotEqual(lokVersion, officeWireStageALOKVersionPlaceholder)
        XCTAssertFalse(lokVersion.isEmpty)

        try await connection.send(.ping(seq: 2))
        guard let pingReply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("no reply to ping from the real helper")
            return
        }
        XCTAssertEqual(pingReply, .pong(seq: 2))

        // Idle-exit: zero open documents (never opened one) and, once this connection closes,
        // zero clients — the real helper should self-terminate via _exit(0) within a few seconds
        // of the 1s idle window above.
        connection.close()
        let exited = await waitUntil(timeout: 8.0) { !process.isRunning }
        XCTAssertTrue(exited, "real helper did not idle-exit within the bound")
    }
}
