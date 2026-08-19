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

    func testRealHelperBindsHandshakesPingsAndIdleExits() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run. "
                        + "This pin goes live the moment it's built.")

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        let token = "live-smoke-token"

        let process = Process()
        process.executableURL = helperURL
        // 1s idle-exit (not the brief's real 120s default): this test bounds its own wait at 8s
        // below, not two real minutes, to prove idle-exit happens at all.
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", token, "--idle-exit-seconds", "1"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "real helper never created its socket file")

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
        // Stage A has no LibreOfficeKit loaded yet (Task 3) — this pins the honest placeholder,
        // not a guessed real version string.
        XCTAssertEqual(lokVersion, officeWireStageALOKVersionPlaceholder)

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
