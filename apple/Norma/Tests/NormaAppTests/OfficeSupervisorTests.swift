import XCTest
@testable import Norma

/// Office Stage A Task 2 — `OfficeHelperSupervisor` against `NormaOfficeHelperFixture`, a real
/// spawnable stand-in process (NOT an in-memory `Process` double, unlike `DaemonSupervisorTests`'
/// `FakeDaemonProcess`) — deliberately, because the risk this task exists to retire is the actual
/// wire protocol over a real kernel Unix socket, not just the retry/backoff state machine in
/// isolation. The fixture links the SAME `OfficeHelperServer` the real helper does (see
/// `Tests/OfficeHelperFixtureSources/main.swift`), so these tests exercise the real protocol
/// handler under three real failure modes.
///
/// Scratch socket paths are deliberately SHORT (`/tmp/off-XXXXXXXX`, not
/// `FileManager.default.temporaryDirectory`): `sockaddr_un.sun_path` is 104 bytes on macOS (103
/// usable), and this repo's own default temp directory plus a reasonable subdirectory name can
/// come close to that ceiling — a long scratch path would fail `bind()` with a confusing error
/// that has nothing to do with what the test is trying to prove.
@MainActor
final class OfficeSupervisorTests: XCTestCase {
    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/off-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    private func fixtureExecutableURL() -> URL {
        // Bare `type: tool` products land directly in BUILT_PRODUCTS_DIR, sibling to Norma.app —
        // the same place project.yml's "Embed NormaHelper" script reads `NormaHelper` from
        // (`"${BUILT_PRODUCTS_DIR}/NormaHelper"`). NormaAppTests is TEST_HOST-hosted inside
        // Norma.app, so `Bundle.main` here IS the host app's bundle.
        Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelperFixture")
    }

    /// Short timings so the "3 attempts, all failing" test costs low single-digit seconds, not the
    /// brief's real production 5s/attempt. Production code (`Configuration.production()`) never
    /// goes through this initializer.
    private func configuration(mode: String, idleExitSeconds: Int? = nil) -> OfficeHelperSupervisor.Configuration {
        OfficeHelperSupervisor.Configuration(
            helperExecutableURL: fixtureExecutableURL(),
            socketDirectory: makeScratchDirectory(),
            handshakeTimeout: 1.0,
            maxAttempts: 3,
            backoff: 0.05,
            idleExitSeconds: idleExitSeconds,
            extraArguments: ["--mode", mode])
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000) // 20ms
        }
        return true
    }

    // MARK: - Handshake success

    func testHandshakeSucceedsAgainstTheFixtureInOkMode() async throws {
        let supervisor = OfficeHelperSupervisor(configuration: configuration(mode: "ok"))
        await supervisor.start()

        XCTAssertEqual(supervisor.state, .ready)
        XCTAssertNotNil(supervisor.client)

        var iterator = supervisor.events.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .ready(lokVersion: officeWireStageALOKVersionPlaceholder))

        // The renamed client (xpc -> client; see OfficeHelperSupervisor's own header) answers a
        // real ping over the real connection.
        let client = try XCTUnwrap(supervisor.client)
        try await client.ping()
    }

    // MARK: - Handshake timeout -> 3 attempts -> .helperUnavailable

    func testHandshakeTimeoutExhaustsAllAttemptsThenHelperUnavailable() async {
        // "silent" mode: the fixture accepts every connection and decodes every frame (so this
        // genuinely exercises the per-attempt handshake timeout, not just "no listener yet") but
        // never writes a reply — every one of the 3 attempts times out.
        let supervisor = OfficeHelperSupervisor(configuration: configuration(mode: "silent"))
        await supervisor.start()

        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.client)

        var iterator = supervisor.events.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .helperUnavailable)
    }

    // MARK: - Death after a successful handshake -> .helperDied

    func testHelperDyingRightAfterHandshakeIsReportedAsHelperDied() async {
        // "dieAfterHello" mode: replies helloOk normally (so the supervisor reaches .ready), then
        // calls _exit(0) immediately — proving the DEATH path, not the handshake-timeout path.
        let supervisor = OfficeHelperSupervisor(configuration: configuration(mode: "dieAfterHello"))
        await supervisor.start()
        XCTAssertEqual(supervisor.state, .ready, "must reach ready before it can be observed dying")

        // Death detection (process termination handler + connection close) fires asynchronously,
        // sometime after start() already returned — poll state rather than racing the events
        // AsyncStream directly (see OfficeWireConnection's own header for why racing an AsyncStream
        // against a timeout is a real hang trap, not just theoretical).
        let becameStopped = await waitUntil(timeout: 5.0) { supervisor.state == .stopped }
        XCTAssertTrue(becameStopped, "expected .helperDied to flip state to .stopped within 5s")
        XCTAssertNil(supervisor.client)

        // By the time state == .stopped is observable, both yields have already happened (the
        // state mutation and the eventsContinuation.yield are the same call site, in order) — safe
        // to drain synchronously now.
        var iterator = supervisor.events.makeAsyncIterator()
        let first = await iterator.next()
        let second = await iterator.next()
        XCTAssertEqual(first, .ready(lokVersion: officeWireStageALOKVersionPlaceholder))
        XCTAssertEqual(second, .helperDied)
    }

    // MARK: - Token mismatch -> refused

    /// Deliberately bypasses `OfficeHelperSupervisor` (which always presents the CORRECT token it
    /// generated itself) and drives the wire protocol directly against the fixture in "ok" mode —
    /// the fixture implements the SAME token check the real helper does
    /// (`OfficeHelperServer.handleOpeningLine`), so this proves the protocol's own refusal
    /// behavior, which is what "token mismatch -> refused" is actually about.
    func testTokenMismatchOnTheSocketIsRefused() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path

        let process = Process()
        process.executableURL = fixtureExecutableURL()
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", "the-real-token", "--mode", "ok"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "fixture never created its socket file")

        let connection = OfficeWireConnection(socketPath: socketPath)
        try await connection.open()
        try await connection.send(.hello(seq: 1, role: .app, token: "definitely-the-wrong-token"))

        guard let reply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("no reply to a mismatched-token hello")
            return
        }
        XCTAssertEqual(reply, .refused(seq: 1, reason: "token mismatch"))

        // Refusal ends the connection — refuse-never-ignore means a reply is always sent, not that
        // the connection survives an auth failure (see OfficeHelperServer's own doc comment).
        let closed = await waitUntil(timeout: 5.0) { connection.isClosed }
        XCTAssertTrue(closed, "helper should close the connection after refusing a bad hello")
    }
}
