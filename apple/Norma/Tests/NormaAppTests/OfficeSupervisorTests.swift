import XCTest
@testable import Norma
#if canImport(Darwin)
import Darwin
#endif

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

    /// Short timings so the "3 attempts, all failing" test costs low single-digit seconds, not
    /// production's real per-attempt budget (`Configuration.production()`'s `handshakeTimeout`,
    /// raised from the brief's 5.0s to 30.0s in Task 3 — see that property's own comment: LOK boot
    /// now runs before the socket even binds, and a cold `dlopen` of the merged dylib measured
    /// well over 5s). Production code (`Configuration.production()`) never goes through this
    /// initializer — this fixture uses the FAKE bridge (no real LOK), so its own handshake is fast
    /// regardless of what production's real-world timeout needs to be.
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
        let start = Date()
        await supervisor.start()
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.client)

        // F5 (T2 review): pins maxAttempts=3 and backoff=0.05 (this file's `configuration(mode:)`)
        // as LOAD-BEARING, not merely documentation the test happens to stay green under. Without
        // this floor, the test would pass identically with maxAttempts silently dropped to 1 (an
        // implementation change nothing else here would catch). Post-F1/F2 fix, each of the 3
        // attempts now costs close to the full handshakeTimeout=1.0s (silent mode never replies,
        // so nextFrame always runs out its budget) — floor: 3×1.0 + 2×0.05 = 3.10s. 2.5s is
        // generous-but-discriminating: comfortably below the real 3.10s floor, while still well
        // above what 1 attempt (~1.0s) or 2 attempts (~2.05s) would produce, so either regressing
        // silently fails this assertion.
        XCTAssertGreaterThanOrEqual(elapsed, 2.5,
            "3 attempts at handshakeTimeout=1.0s + 2×0.05s backoff should floor around 3.10s "
            + "(measured \(elapsed)s) — maxAttempts/backoff may have silently changed")

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

    // MARK: - F1: a stale socket file from a prior dead helper must not block the next attempt

    /// Binds, listens, then closes WITHOUT unlinking — leaves a real Unix-domain-socket special
    /// file on disk with nothing listening on it, exactly what a KILLED helper leaves behind
    /// (Task 2: SIGTERM's default disposition runs no unlink-on-exit cleanup; Task 3 switched the
    /// supervisor's kill signal to SIGKILL — carry #4, `OfficeHelperSupervisor.forceKill`'s own
    /// header — which is stricter still, since no userspace handler can intercept it to clean up
    /// either. Either way: only a helper that reaches its OWN `start()` unlinks stale paths, and a
    /// killed one never gets that far again). Mirrors
    /// `OfficeHelperServer.start()`'s own bind sequence exactly, deliberately, so this is a
    /// faithful reproduction of the artifact rather than a guess at its shape.
    private func leaveStaleSocketFile(at path: String) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else { return }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let buffer = raw.bindMemory(to: UInt8.self)
            for index in 0..<capacity { buffer[index] = 0 }
            for (index, byte) in pathBytes.enumerated() { buffer[index] = byte }
        }
        _ = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                // Qualified `Darwin.bind` — this test file's broader import surface
                // (`@testable import Norma` + `XCTest`) puts an unrelated INSTANCE method named
                // `bind` in scope, which the compiler otherwise prefers over Darwin's global
                // `bind()` free function at this call site.
                Darwin.bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        listen(fd, 1)
        // `defer { close(fd) }` above closes without ever calling unlink(path) — the special file
        // stays on disk, dead.
    }

    func testStaleSocketFileFromAPriorDeadHelperDoesNotBlockTheNextAttempt() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        leaveStaleSocketFile(at: socketPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath),
                      "setup: the stale socket file must exist before the attempt runs")

        // maxAttempts: 1 — this isolates the exact claim: a FRESH attempt, the moment it starts,
        // must not be slowed by a stale file some EARLIER generation left behind. (The end-to-end
        // "attempt 1 dies, attempt 2 recovers" shape is already what
        // testHandshakeSucceedsAgainstTheFixtureInOkMode + this repro TOGETHER cover — this test
        // pins the mechanism directly rather than depending on a real attempt 1 to fail first.)
        let supervisor = OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
            helperExecutableURL: fixtureExecutableURL(), socketDirectory: stateDir,
            handshakeTimeout: 5.0, maxAttempts: 1, backoff: 0.05, idleExitSeconds: nil,
            extraArguments: ["--mode", "ok"]))

        let start = Date()
        await supervisor.start()
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertEqual(supervisor.state, .ready)
        // Discriminates the fix (F1, T2 review): WITHOUT the supervisor unlinking the socket path
        // before spawning, this attempt would connect into the stale/dead inode and — measured by
        // the review — burn close to UnixSocketTransport's own ~3s internal connect timeout before
        // ever reaching the fresh listener. A genuinely fixed attempt (fresh helper, fresh socket
        // file) completes in well under a second, matching this file's other handshake-success
        // timings. Asserting elapsed time, not just the `.ready` outcome, is what actually tells
        // "fixed" apart from "coincidentally still passing" (a 5s handshakeTimeout would eventually
        // succeed either way, just slowly).
        XCTAssertLessThan(elapsed, 2.0,
            "handshake against a fresh helper should not be slowed by a stale socket file a prior "
            + "dead helper left behind (measured \(elapsed)s)")
    }

    // MARK: - F3: start() while already .ready is a no-op, never a second, orphaning generation

    func testStartWhileReadyIsANoOpAndDoesNotOrphanTheRunningHelper() async throws {
        let supervisor = OfficeHelperSupervisor(configuration: configuration(mode: "ok"))
        await supervisor.start()
        XCTAssertEqual(supervisor.state, .ready)
        let firstProcess = try XCTUnwrap(supervisor.process)
        let firstGeneration = supervisor.generation
        XCTAssertTrue(firstProcess.isRunning)
        addTeardownBlock { if firstProcess.isRunning { firstProcess.terminate() } }

        await supervisor.start() // F3 fix: must be a no-op — already .ready, not .notStarted/.stopped

        XCTAssertEqual(supervisor.state, .ready)
        XCTAssertEqual(supervisor.generation, firstGeneration, "a redundant start() must not begin a new generation")
        let secondProcess = try XCTUnwrap(supervisor.process)
        XCTAssertTrue(firstProcess === secondProcess,
                      "must be the literal SAME Process — a redundant start() must spawn nothing")
        XCTAssertTrue(firstProcess.isRunning, "the original helper must still be running, not orphaned")
        XCTAssertNotNil(supervisor.client)
    }

    // MARK: - F4: refuse-never-ignore covers even bytes that aren't valid UTF-8

    func testInvalidUTF8AsTheFirstLineGetsAMalformedReplyThenCloses() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path

        let process = Process()
        process.executableURL = fixtureExecutableURL()
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", "t", "--mode", "ok"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }
        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared)

        let connection = OfficeWireConnection(socketPath: socketPath)
        try await connection.open()
        // 0xFF/0xFE: not a valid UTF-8 sequence in any position. Sent as the very first line — the
        // pre-auth gate — so this also exercises the "no `String(data:encoding:.utf8)` even
        // possible" path `OfficeWireCodec.decodeInbound` never sees at all.
        try await connection.sendRaw(Data([0xFF, 0xFE, 0x0A]))

        guard let reply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("no reply to an invalid-UTF-8 first line — the refuse-never-ignore hole F4 fixes")
            return
        }
        XCTAssertEqual(reply, .error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"))

        // Pre-auth rule: one violation ends the connection, same as every other opening failure.
        let closed = await waitUntil(timeout: 5.0) { connection.isClosed }
        XCTAssertTrue(closed, "an invalid first line is a pre-auth violation and should close the connection")
    }

    func testInvalidUTF8AfterHelloGetsAMalformedReplyAndStaysOpen() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path

        let process = Process()
        process.executableURL = fixtureExecutableURL()
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", "t", "--mode", "ok"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }
        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared)

        let connection = OfficeWireConnection(socketPath: socketPath)
        try await connection.open()
        try await connection.send(.hello(seq: 1, role: .app, token: "t"))
        guard let helloReply = await connection.nextFrame(timeout: 5.0), case .helloOk = helloReply else {
            XCTFail("handshake failed")
            return
        }

        try await connection.sendRaw(Data([0xFF, 0xFE, 0x0A]))
        guard let malformedReply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("no reply to a post-auth invalid-UTF-8 line")
            return
        }
        XCTAssertEqual(malformedReply, .error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"))

        // Post-auth rule: nothing here closes the connection on its own initiative — it must still
        // answer an ordinary request afterward.
        try await connection.send(.ping(seq: 2))
        guard let pongReply = await connection.nextFrame(timeout: 5.0) else {
            XCTFail("connection appears closed after the malformed line — post-auth should stay open")
            return
        }
        XCTAssertEqual(pongReply, .pong(seq: 2))
    }
}
