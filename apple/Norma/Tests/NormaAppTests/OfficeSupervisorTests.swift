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
        // Task 4 debt (pre-existing, flagged in task-3-report.md): every sibling test in this file
        // that spawns a fixture process explicitly tears it down via `addTeardownBlock`; this one,
        // spawned INDIRECTLY through the supervisor's own `start()`, never did — the fixture's
        // default `--idle-exit-seconds` is 120 (no override passed here), so a leaked process from
        // this test would sit alive for up to two real minutes after the test itself finished.
        addTeardownBlock { if let process = supervisor.process, process.isRunning { process.terminate() } }

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

        // F5 (T2 review): pins maxAttempts=3 (this file's `configuration(mode:)`) as LOAD-BEARING,
        // not merely documentation the test happens to stay green under. Without this floor, the
        // test would pass identically with maxAttempts silently dropped to 1 (an implementation
        // change nothing else here would catch). Post-F1/F2 fix, each of the 3 attempts now costs
        // close to the full handshakeTimeout=1.0s (silent mode never replies, so nextFrame always
        // runs out its budget) — floor: 3×1.0 + 2×0.05 = 3.10s. 2.5s is generous-but-discriminating:
        // comfortably below the real 3.10s floor, while still well above what 1 attempt (~1.0s) or
        // 2 attempts (~2.05s) would produce, so either regressing silently fails this assertion.
        // **Wave fix (T2-F5)**: this floor does NOT similarly pin `backoff=0.05` — 3×1.0 + 2×0 =
        // 3.0s would still clear 2.5s if backoff silently dropped to 0, so that specific regression
        // is not what this assertion catches (the doc claim above was overbroad on that point).
        XCTAssertGreaterThanOrEqual(elapsed, 2.5,
            "3 attempts at handshakeTimeout=1.0s + 2×0.05s backoff should floor around 3.10s "
            + "(measured \(elapsed)s) — maxAttempts/backoff may have silently changed")

        var iterator = supervisor.events.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first, .helperUnavailable)
    }

    // MARK: - F3 (T3 review): the timeout-kill path must send SIGKILL, not SIGTERM

    /// T3's own carry #4 measured that SIGTERM is intercepted once LOK is loaded (an EARNED
    /// finding against the REAL helper — see `OfficeHelperLiveTests`'s SIGTERM test) and switched
    /// `OfficeHelperSupervisor.forceKill` to SIGKILL. Nothing asserted WHICH signal the supervisor
    /// actually sends, though — a future refactor back to `process.terminate()` (SIGTERM) would
    /// stay green here with no test noticing. This is that tripwire: drives a real attempt through
    /// the handshake-TIMEOUT kill path. "silent" mode DOES bind and accept the connection (per its
    /// own definition at `testHandshakeTimeoutExhaustsAllAttemptsThenHelperUnavailable`'s comment:
    /// "accepts every connection and decodes every frame... but never writes a reply") — so the
    /// socket-file poll succeeds immediately and it is the POST-CONNECT hello-wait's own deadline
    /// (`attemptOnce`'s `guard succeeded else { ...; Self.forceKill(process); ... }`) that actually
    /// fires here, not the earlier socket-file-poll deadline. Either `forceKill` call site would
    /// prove the same fact about the SIGNAL sent; this test happens to exercise this one. Inspects
    /// the killed process's own termination directly via `lastAttemptProcess` — see that
    /// property's own header on `OfficeHelperSupervisor` for why it exists: a FAILED attempt's
    /// process is otherwise unobservable, a local variable inside `attemptOnce`, never assigned to
    /// the public `process` property, which only ever holds a SUCCESSFUL attempt.
    ///
    /// `terminationStatus`, not `terminationReason`, is the discriminator: the fixture is LOK-free
    /// (`FakeOfficeDocumentBridge`, no crash-handler installed), so a bare process dying from
    /// EITHER SIGTERM or SIGKILL's own default disposition reads `.terminationReason ==
    /// .uncaughtSignal` regardless of which signal it was — only `.terminationStatus` (POSIX
    /// convention: the raw signal number, for a death-by-uncaught-signal) actually tells 9 apart
    /// from 15.
    func testHandshakeTimeoutKillPathSendsSIGKILLNotSIGTERM() async throws {
        // maxAttempts: 1 keeps this deterministic and cheap — one timed-out attempt is all this
        // needs; the retry-count/backoff floor is already `testHandshakeTimeoutExhaustsAllAttempts...`'s
        // own job, not this test's.
        let supervisor = OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
            helperExecutableURL: fixtureExecutableURL(), socketDirectory: makeScratchDirectory(),
            handshakeTimeout: 1.0, maxAttempts: 1, backoff: 0.05, idleExitSeconds: nil,
            extraArguments: ["--mode", "silent"]))

        await supervisor.start()
        XCTAssertEqual(supervisor.state, .stopped, "a single timed-out attempt with maxAttempts=1 must exhaust immediately")

        let killedProcess = try XCTUnwrap(supervisor.lastAttemptProcess,
            "attemptOnce should have recorded the process it spawned (and then killed) even though the attempt failed")
        // Safe even if it already exited (returns immediately) — guarantees the OS has actually
        // reaped it and populated terminationStatus/terminationReason before we read either below,
        // rather than racing Foundation's own asynchronous SIGCHLD handling.
        killedProcess.waitUntilExit()

        XCTAssertEqual(killedProcess.terminationReason, .uncaughtSignal,
            "the LOK-free fixture has no signal handler to intercept — a bare kill (either signal) "
            + "should always read as .uncaughtSignal here")
        XCTAssertEqual(killedProcess.terminationStatus, SIGKILL,
            "supervisor's timeout-kill path must send SIGKILL (9); a regression back to "
            + "process.terminate() would leave this at SIGTERM (15) — carry #4's whole point")
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

    // MARK: - Task 4: multicast (two connections, one doc owner: pushes to both; close by
    // non-owner refused) — also proves F8 (per-connection push-seq) as a side effect: two
    // connections receiving the SAME logical invalidation get DIFFERENT seq numbers, each dense
    // within its OWN stream, not a shared server-wide counter.

    /// A tiny, lock-protected async-push collector — the same shape
    /// `OfficeHelperLiveTests.testDocumentEventPushDoesNotStarveAConcurrentPingReply` already
    /// established for `onDocumentEvent`, reused here for `onInvalidated` (pushes are delivered on
    /// the connection's own reader thread, no isolation promise — see `OfficeWireConnection`'s own
    /// header).
    private final class PushCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var invalidations: [(seq: UInt64, docId: String, keys: [TileKey])] = []
        private var tileSeqs: [UInt64] = []
        func recordInvalidation(seq: UInt64, docId: String, keys: [TileKey]) {
            lock.lock(); invalidations.append((seq, docId, keys)); lock.unlock()
        }
        func recordTile(seq: UInt64) {
            lock.lock(); tileSeqs.append(seq); lock.unlock()
        }
        func invalidationsSnapshot() -> [(seq: UInt64, docId: String, keys: [TileKey])] {
            lock.lock(); defer { lock.unlock() }; return invalidations
        }
        func tileSeqsSnapshot() -> [UInt64] {
            lock.lock(); defer { lock.unlock() }; return tileSeqs
        }
    }

    func testMulticastInvalidationReachesBothSubscribersWithPerConnectionSeqAndCloseByNonOwnerIsRefused() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path

        let process = Process()
        process.executableURL = fixtureExecutableURL()
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", "t", "--mode", "multicastInvalidate"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }
        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared)

        let docId = "doc-\(UUID().uuidString.prefix(8))"
        let rect = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120)
        let key0 = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)

        // Connection A: opens the doc (becomes the OWNER) and subscribes.
        let connectionA = OfficeWireConnection(socketPath: socketPath)
        try await connectionA.open()
        addTeardownBlock { connectionA.close() }
        try await connectionA.send(.hello(seq: 1, role: .app, token: "t"))
        guard case .helloOk = await connectionA.nextFrame(timeout: 5.0) else { return XCTFail("A hello failed") }
        try await connectionA.send(.open(seq: 2, docId: docId, path: "/tmp/whatever-\(docId)"))
        guard case .opened = await connectionA.nextFrame(timeout: 5.0) else { return XCTFail("A open failed") }
        try await connectionA.send(.subscribeTiles(seq: 3, docId: docId, part: 0, zoomPPT: 1000, viewportTwips: rect))
        guard case .subscribed = await connectionA.nextFrame(timeout: 5.0) else { return XCTFail("A subscribe failed") }

        // Connection B: never opens — only subscribes to the doc A already opened.
        let connectionB = OfficeWireConnection(socketPath: socketPath)
        try await connectionB.open()
        addTeardownBlock { connectionB.close() }
        try await connectionB.send(.hello(seq: 1, role: .app, token: "t"))
        guard case .helloOk = await connectionB.nextFrame(timeout: 5.0) else { return XCTFail("B hello failed") }
        try await connectionB.send(.subscribeTiles(seq: 2, docId: docId, part: 0, zoomPPT: 1000, viewportTwips: rect))
        guard case .subscribed = await connectionB.nextFrame(timeout: 5.0) else { return XCTFail("B subscribe failed") }

        let collectorA = PushCollector()
        let collectorB = PushCollector()
        connectionA.onInvalidated = { seq, docId, keys in collectorA.recordInvalidation(seq: seq, docId: docId, keys: keys) }
        connectionB.onInvalidated = { seq, docId, keys in collectorB.recordInvalidation(seq: seq, docId: docId, keys: keys) }
        connectionA.onTile = { seq, _, _, _, _, _, _ in collectorA.recordTile(seq: seq) }

        // Step 1: A paints ONE real tile (so the invalidation below has something to bump — an
        // EMPTY cache has nothing to report; see TileCache.invalidate's own header). "multicastInvalidate"
        // mode fires its synthetic trigger after EVERY accepted tileRequest, including this one —
        // and routeDocumentEvent ALWAYS pushes the raw OfficeDocumentEvent to the opener (T3's
        // original, unconditional contract — preserved even when zero tile keys end up bumped, as
        // here: the cache is still empty at the moment this first trigger fires). That is A's
        // allocator's FIRST use (seq 1, .documentEvent, not observed by this test); A's OWN .tile
        // push for its own request is therefore the allocator's SECOND use — seq 2, not 1.
        try await connectionA.send(.tileRequest(seq: 4, docId: docId, keys: [key0]))
        guard case .tileRequestAccepted = await connectionA.nextFrame(timeout: 5.0) else { return XCTFail("A tileRequest not accepted") }
        let tileArrived = await waitUntil(timeout: 5.0) { !collectorA.tileSeqsSnapshot().isEmpty }
        XCTAssertTrue(tileArrived, "expected connection A's tileRequest to produce a .tile push before triggering the invalidation")
        XCTAssertEqual(collectorA.tileSeqsSnapshot(), [2],
            "A's push allocator: seq 1 was the raw documentEvent push from this same trigger (unobserved by this test, "
            + "onDocumentEvent not wired up); this .tile push is the allocator's 2nd mint, not its 1st")

        // Step 2: B sends an EMPTY tileRequest — a legal, already wire-tested shape
        // (OfficeWireCodecTests) — purely to trigger this fixture mode's synthetic invalidation
        // AFTER both connections are confirmed subscribed.
        try await connectionB.send(.tileRequest(seq: 3, docId: docId, keys: []))
        guard case .tileRequestAccepted = await connectionB.nextFrame(timeout: 5.0) else { return XCTFail("B tileRequest not accepted") }

        let bothReceived = await waitUntil(timeout: 5.0) {
            !collectorA.invalidationsSnapshot().isEmpty && !collectorB.invalidationsSnapshot().isEmpty
        }
        XCTAssertTrue(bothReceived, "both subscribers must receive the invalidated push (multicast)")

        let pushA = try XCTUnwrap(collectorA.invalidationsSnapshot().first)
        let pushB = try XCTUnwrap(collectorB.invalidationsSnapshot().first)
        XCTAssertEqual(pushA.docId, docId)
        XCTAssertEqual(pushB.docId, docId)
        XCTAssertEqual(Set(pushA.keys), [key0], "the bumped key set must be the one real tile that was painted")
        XCTAssertEqual(Set(pushB.keys), [key0])

        // F8: the seq is per-CONNECTION, never a shared server-wide counter, for the IDENTICAL
        // logical event delivered to both. A's own allocator has now minted seq 1 (its own raw
        // documentEvent push from step 1's trigger) and seq 2 (its own .tile push) — this
        // .invalidated push is A's allocator's 3rd mint (seq 3) plus the raw documentEvent push
        // THIS trigger ALSO sends to the opener first (seq 4 would be next... concretely: this
        // trigger mints seq 3 for A's own raw documentEvent, then seq 4 for A's .invalidated
        // multicast copy). B's connection has never minted a push before this exact moment, so B's
        // is its allocator's FIRST-EVER mint (seq 1) — proof the two connections' allocators are
        // independent, not a shared server-wide counter (which could never produce "B's first push
        // is seq 1" this late into A's own, much longer, push history if it were shared).
        XCTAssertEqual(pushA.seq, 4, "A's 4th push overall (2 earlier .documentEvent/.tile pushes, then this trigger's own opener-documentEvent, then this multicast copy)")
        XCTAssertEqual(pushB.seq, 1, "B's first-ever push on its OWN independent allocator")

        // Close attempts.
        try await connectionB.send(.close(seq: 10, docId: docId))
        guard case .error(_, let reasonB) = await connectionB.nextFrame(timeout: 5.0) else {
            return XCTFail("expected B's close to be refused")
        }
        XCTAssertEqual(reasonB, "notOwner", "F7: a non-owner connection may not close a doc it did not open")

        try await connectionA.send(.close(seq: 11, docId: docId))
        guard case .closed = await connectionA.nextFrame(timeout: 5.0) else {
            return XCTFail("expected A (the real owner) to close successfully")
        }
    }

    // MARK: - Fix round 1, discretionary: O(n²) ingest regression test — Task 5.5 re-pointed
    //
    // `OfficeWireConnection.ingest`'s newline scan used to restart from `buffer.startIndex` on
    // EVERY call, making total scan cost quadratic in a long line's byte count for a payload that
    // (rung 1's base64 `.tile` pushes always did) arrived split across many separate socket reads —
    // caught during Task 4's own transport measurement as a confounder, fixed with a
    // `scannedPrefixLength` cursor (see that property's own header in `OfficeWireConnection.swift`).
    //
    // **Task 5.5 update**: rung 2 moves tile pixels out of any scanned line entirely — a `.tile`
    // push is now a small NDJSON header plus `byteCount` raw bytes consumed by a pure LENGTH check
    // (`buffer.count >= header.byteCount`), never a scan. The specific quadratic mechanism this test
    // was written to catch (re-scanning an ever-growing buffer for a `\n` inside a multi-hundred-KB
    // line) can no longer occur for tiles AT ALL — there is no scan in the payload-accumulation path
    // to regress. Re-pointed at the new loop rather than deleted (the brief's own instruction):
    // still proves fragmented delivery of a ~1MiB payload completes fast and byte-exact, and the
    // mutation check below (temporarily reintroducing the STRUCK-DOWN hazard — scanning payload
    // bytes for `\n` — the landmine itself) is the honest way to "re-verify separation" for a loop
    // shape that no longer has the old bug available to revert to.

    /// Binds, listens, and — on a background thread, so the accept+write sequence never blocks the
    /// caller — accepts exactly ONE connection. Returns the bound listening fd (already `listen()`-
    /// ing), or `nil` after failing the test, so callers can share this setup while choosing their
    /// own write strategy (fixed chunk size vs. seeded-variable, below).
    @discardableResult
    private func bindAndListenScratchSocket(at path: String) -> Int32? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { XCTFail("socket() failed errno=\(errno)"); return nil }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else { XCTFail("scratch socket path too long for sockaddr_un"); return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let buffer = raw.bindMemory(to: UInt8.self)
            for index in 0..<capacity { buffer[index] = 0 }
            for (index, byte) in pathBytes.enumerated() { buffer[index] = byte }
        }
        let bound = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { close(fd); XCTFail("bind() failed errno=\(errno)"); return nil }
        guard listen(fd, 1) == 0 else { close(fd); XCTFail("listen() failed errno=\(errno)"); return nil }
        return fd
    }

    /// Accepts exactly ONE connection on `fd` and writes `data` in `chunkSize`-byte pieces,
    /// back-to-back with no artificial delay between them (a real fragmented arrival is exactly
    /// this: many separate small deliveries, not a slow-drip one — this test cares about SCAN/
    /// buffering cost under fragmentation, not about simulating network latency).
    private func writeInFixedChunks(fd: Int32, data: Data, chunkSize: Int) {
        Thread {
            let clientFD = accept(fd, nil, nil)
            guard clientFD >= 0 else { return }
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                var offset = 0
                while offset < raw.count {
                    let thisChunk = min(chunkSize, raw.count - offset)
                    let written = write(clientFD, raw.baseAddress!.advanced(by: offset), thisChunk)
                    guard written > 0 else { break } // peer gone or real error -- nothing more to do
                    offset += written
                }
            }
            close(clientFD)
            close(fd)
        }.start()
    }

    /// Convenience wrapper matching this test's own pre-existing call shape (bind + fixed-chunk
    /// write in one call) — every EXISTING call site in this file uses this name.
    private func startChunkedWritePeer(at path: String, data: Data, chunkSize: Int) {
        guard let fd = bindAndListenScratchSocket(at: path) else { return }
        writeInFixedChunks(fd: fd, data: data, chunkSize: chunkSize)
    }

    /// Task 5.5 — a tiny deterministic PRNG (xorshift64), NOT cryptographic, chosen ONLY for
    /// reproducibility: the same `seed` produces the exact same chunk-size sequence on every run, so
    /// a rare boundary-position failure this fuzzes into existence is exactly as reproducible as any
    /// other test failure — unlike `Int.random`/`SystemRandomNumberGenerator`, which would make one
    /// vanish on re-run.
    private struct SeededXorshift {
        private var state: UInt64
        init(seed: UInt64) { state = seed == 0 ? 0xdead_beef : seed }
        mutating func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }
        mutating func nextInt(in range: ClosedRange<Int>) -> Int {
            let span = UInt64(range.upperBound - range.lowerBound + 1)
            return range.lowerBound + Int(next() % span)
        }
    }

    /// Accepts exactly ONE connection on `fd` and writes `data` in VARIABLE-sized pieces drawn from
    /// `seed` (`chunkRange` per write, re-rolled every write) — deliberately hits many different
    /// relative offsets across a run (a boundary landing mid-header, exactly on the header/payload
    /// transition, deep inside a payload, or exactly on a SECOND frame's own header/payload
    /// transition when a chunk happens to be large enough to span both) without hand-enumerating
    /// each case.
    private func writeInVariableChunks(fd: Int32, data: Data, seed: UInt64, chunkRange: ClosedRange<Int> = 1...8192) {
        Thread {
            let clientFD = accept(fd, nil, nil)
            guard clientFD >= 0 else { return }
            var rng = SeededXorshift(seed: seed)
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                var offset = 0
                while offset < raw.count {
                    let thisChunk = min(rng.nextInt(in: chunkRange), raw.count - offset)
                    let written = write(clientFD, raw.baseAddress!.advanced(by: offset), thisChunk)
                    guard written > 0 else { break }
                    offset += written
                }
            }
            close(clientFD)
            close(fd)
        }.start()
    }

    func testIngestStaysLinearNotQuadraticForALongLineDeliveredInManySmallChunks() async throws {
        // Task 5.5: the envelope is now HEADER (small NDJSON line) + `byteCount` raw bytes — no
        // single giant "line" exists anymore. Built via the real `encodedLine()`/`tilePayload`
        // production path (not hand-written JSON), so this exercises the exact bytes `ingest` has
        // to buffer/scan/consume for a real tile push.
        let bigPixels = Data(repeating: 0x41, count: TileMath.bytesPerTile)
        let frame = OfficeWireFrame.tile(seq: 1, docId: "regression-doc",
                                          key: TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0),
                                          generation: 0, width: 512, height: 512, pixels: bigPixels)
        let header = frame.encodedLine()
        let payload = try XCTUnwrap(frame.tilePayload)
        XCTAssertLessThan(header.count, 300, "setup: the HEADER line must stay small under rung 2 — the size moved to the payload")
        XCTAssertEqual(payload.count, TileMath.bytesPerTile, "setup: the payload must be exactly one tile's worth of bytes")
        let wireBytes = header + payload

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        // 1024 bytes/chunk: ~1,025 separate writes for a ~1MiB payload (plus one for the header) --
        // deliberately far below any socket buffer size, so this is NOT relying on best-effort OS
        // coalescing to prove fragmentation happened; it is guaranteed by construction.
        startChunkedWritePeer(at: socketPath, data: wireBytes, chunkSize: 1024)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)

        // `.tile` is an unprompted PUSH — `ingest`'s own switch routes it straight to the `onTile`
        // callback and NEVER into `frameQueue`, deliberately (see that function's own comment: a
        // push must not be misattributed to whichever caller happens to be waiting on `nextFrame`
        // at the moment it arrives). `nextFrame` would therefore never resolve with this frame at
        // all — it would sit unconsumed until this test's own peer closes the connection, at which
        // point `ingestClosed` resolves any outstanding wait with `nil`. Registering `onTile`
        // BEFORE `open()` (matching every other live `.tile`-receiving test in this codebase, e.g.
        // `OfficeHelperLiveTests`'s own collector-pattern tests) is the only correct way to observe
        // this push at all.
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            private var received: (docId: String, key: TileKey, pixels: Data)?
            func record(_ docId: String, _ key: TileKey, _ pixels: Data) {
                lock.lock(); received = (docId, key, pixels); lock.unlock()
            }
            func snapshot() -> (docId: String, key: TileKey, pixels: Data)? {
                lock.lock(); defer { lock.unlock() }; return received
            }
        }
        let box = Box()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.record(docId, key, pixels) }

        try await connection.open()

        let start = Date()
        let arrived = await waitUntil(timeout: 15.0) { box.snapshot() != nil }
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertTrue(arrived, "onTile never fired for the ~1MiB fragmented payload")
        guard let received = box.snapshot() else {
            return XCTFail("onTile never fired with a usable payload")
        }
        XCTAssertEqual(received.docId, "regression-doc")
        XCTAssertEqual(received.key, TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0))
        XCTAssertEqual(received.pixels, bigPixels, "the ~1MiB payload must arrive byte-for-byte intact across ~1,025 fragments")

        // The regression bar: payload-accumulation mode does a pure `buffer.count >= byteCount`
        // comparison per `ingest` call, never a scan — so this should complete in well under a
        // second regardless of fragmentation. Generous (not hair-trigger) on purpose, matching this
        // suite's own established discretion for timing assertions.
        XCTAssertLessThan(elapsed, 1.0,
            "ingest took \(elapsed)s for a ~1MiB payload in 1024-byte fragments -- payload-accumulation "
            + "mode should never scan, so this should be comfortably sub-second")
    }

    /// **Wave fix (T5.5 review Minor-A)**: the O(n²) test above now exercises the TILE path, which
    /// rung 2 moved off any scan entirely (see its own header) — it can no longer regress the thing
    /// `scannedPrefixLength` actually guards today: a large CONTROL frame's newline scan
    /// (`subscribed`/`invalidated` can carry up to `TileMath.maxTilesPerRectEnumeration` keys of
    /// JSON, thousands of bytes — `OfficeWireConnection.scannedPrefixLength`'s own header names
    /// this exactly). This test fills that gap: a `.subscribed` reply at the PRODUCTION ceiling
    /// (4096 keys, the largest this wire can ever legally carry), delivered in small chunks, must
    /// stay fast.
    ///
    /// **Ceiling calibrated by the mutation method** (this file's own established practice — see
    /// the O(n²) test above): `scannedPrefixLength`'s effect was temporarily reverted
    /// (`searchStart` forced to `buffer.startIndex` on every call, restoring the pre-Task-4
    /// quadratic rescan) in a scratch build, this exact test run against it, then restored.
    /// Measured 2026-08-19 (a 199,661-byte line, 4096 keys, 8-byte chunks — 24,958 fragments):
    /// fixed 0.029s/0.030s (two runs), mutated 0.471s. A first calibration pass at 64-byte chunks
    /// (fixed 0.023s, mutated 0.070s) was rejected as too close together — only ~3x apart and both
    /// under 100ms, indistinguishable from scheduling/socket noise on a busy machine; the fragment
    /// count needed to be pushed harder, not the frame size, to get a reliable separation (the
    /// frame is already at the wire's own production ceiling — see below). Ceiling set to 0.15s:
    /// ~5x the fixed measurement, ~3x below the mutated one — comfortably discriminating without
    /// being hair-triggered on a loaded CI machine.
    func testIngestStaysLinearNotQuadraticForALargeControlFrameDeliveredInManySmallChunks() async throws {
        var keys: [TileKey] = []
        var probe = OfficeWireFrame.subscribed(seq: 1, docId: "large-control-doc", keys: keys)
        while keys.count < TileMath.maxTilesPerRectEnumeration {
            keys.append(TileKey(part: 0, zoomPPT: 1000, tileX: keys.count, tileY: 0))
            probe = .subscribed(seq: 1, docId: "large-control-doc", keys: keys)
        }
        let line = probe.encodedLine()
        XCTAssertEqual(keys.count, TileMath.maxTilesPerRectEnumeration, "setup: built at the production ceiling")
        XCTAssertGreaterThan(line.count, 150_000, "setup: the control frame must be genuinely large, not a token fixture")

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        // 8 bytes/chunk -- much smaller than the retired tile test's 1024, deliberately: at
        // coarser chunk sizes (1KB, even 64B) a header this size fragments into too few pieces
        // for a quadratic rescan to separate from ordinary scheduling/socket noise -- exactly the
        // class of ceiling that already produced one green-for-wrong-reason regression in this
        // suite's own history (Task 4 review). See this test's own header for the actual
        // calibration numbers at both chunk sizes.
        startChunkedWritePeer(at: socketPath, data: line, chunkSize: 8)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        try await connection.open()
        defer { connection.close() }

        let start = Date()
        let reply = await connection.nextFrame(timeout: 30.0)
        let elapsed = Date().timeIntervalSince(start)

        guard case .subscribed(let seq, let docId, let receivedKeys) = reply else {
            return XCTFail("expected .subscribed, got \(String(describing: reply))")
        }
        XCTAssertEqual(seq, 1)
        XCTAssertEqual(docId, "large-control-doc")
        XCTAssertEqual(receivedKeys.count, TileMath.maxTilesPerRectEnumeration)

        XCTAssertLessThan(elapsed, 0.15,
            "ingest took \(elapsed)s for a \(line.count)-byte control frame in 8-byte fragments -- "
          + "linear scannedPrefixLength should be comfortably faster than this")
    }

    // MARK: - Task 5.5 — rung-2 tile transport: pure reader tests
    //
    // All five tests below drive `OfficeWireConnection.ingest` over a real Unix socket via the raw,
    // hand-rolled peers above (`startChunkedWritePeer`/`writeInVariableChunks`) — no LOK, no live
    // helper, no `OfficeHelperServer` on the other end. This is deliberate: these are claims about
    // the READER alone (framing, fragmentation, refusal), independent of anything the server ever
    // actually sends — the same reasoning the O(n²) test right above already established for this
    // file.

    /// Hand-built (NOT via `OfficeWireFrame.encodedLine()`), specifically so `byteCount` can
    /// disagree with whatever bytes (if any) actually follow — exactly what the byteCount-refusal
    /// tests below need to prove `ingest`'s exact-size-or-refuse check fires off the HEADER alone,
    /// never by waiting to see what shows up after it.
    private func rawTileHeaderLine(byteCount: Int, seq: UInt64 = 1, docId: String = "d") -> Data {
        let json = "{\"type\":\"tile\",\"seq\":\(seq),\"docId\":\"\(docId)\","
            + "\"key\":{\"part\":0,\"zoomPPT\":1000,\"tileX\":0,\"tileY\":0},"
            + "\"generation\":0,\"width\":512,\"height\":512,\"byteCount\":\(byteCount)}\n"
        return Data(json.utf8)
    }

    /// A locked box collecting every `onTile` firing, plus an `onClosed` latch — the shared
    /// observation rig every test below needs (some assert a tile arrived, some assert the
    /// connection closed and NOTHING arrived).
    private final class TileArrivalBox: @unchecked Sendable {
        private let lock = NSLock()
        private var arrivals: [(docId: String, key: TileKey, pixels: Data)] = []
        private var closed = false
        func recordTile(_ docId: String, _ key: TileKey, _ pixels: Data) {
            lock.lock(); arrivals.append((docId, key, pixels)); lock.unlock()
        }
        func recordClosed() { lock.lock(); closed = true; lock.unlock() }
        func snapshot() -> (arrivals: [(docId: String, key: TileKey, pixels: Data)], closed: Bool) {
            lock.lock(); defer { lock.unlock() }; return (arrivals, closed)
        }
    }

    /// Fuzz (a few seeds): TWO real tiles, back-to-back on one connection, delivered through
    /// VARIABLE-sized chunks — different boundary positions on every seed, including (whenever a
    /// large chunk happens to span it) a boundary landing inside the SECOND tile's own header while
    /// the first tile's payload-accumulation mode is still technically "just finished." Exercises
    /// the brief's own ask ("header/payload boundary split across arbitrary chunk boundaries") far
    /// more thoroughly than any one hand-picked split could.
    func testTileHeaderAndPayloadSurviveVariableChunkFragmentation() async throws {
        for seed: UInt64 in [1, 2, 3] {
            let key0 = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
            let key1 = TileKey(part: 0, zoomPPT: 1000, tileX: 1, tileY: 0)
            let pixels0 = Data(repeating: 0x11, count: TileMath.bytesPerTile)
            let pixels1 = Data(repeating: 0x22, count: TileMath.bytesPerTile)
            let frame0 = OfficeWireFrame.tile(seq: 1, docId: "fuzz-doc", key: key0, generation: 0,
                                               width: 512, height: 512, pixels: pixels0)
            let frame1 = OfficeWireFrame.tile(seq: 2, docId: "fuzz-doc", key: key1, generation: 0,
                                               width: 512, height: 512, pixels: pixels1)
            let wireBytes = frame0.encodedLine() + frame0.tilePayload! + frame1.encodedLine() + frame1.tilePayload!

            let stateDir = makeScratchDirectory()
            let socketPath = stateDir.appendingPathComponent("office.sock").path
            guard let fd = bindAndListenScratchSocket(at: socketPath) else { return }
            writeInVariableChunks(fd: fd, data: wireBytes, seed: seed)

            let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
            XCTAssertTrue(socketAppeared, "seed \(seed): setup — the hand-rolled peer's socket file never appeared")

            let connection = OfficeWireConnection(socketPath: socketPath)
            let box = TileArrivalBox()
            connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
            try await connection.open()
            defer { connection.close() }

            let bothArrived = await waitUntil(timeout: 10.0) { box.snapshot().arrivals.count >= 2 }
            XCTAssertTrue(bothArrived, "seed \(seed): expected both tiles, got \(box.snapshot().arrivals.count)")

            let arrivals = box.snapshot().arrivals
            let byKey = Dictionary(uniqueKeysWithValues: arrivals.map { ($0.key, $0.pixels) })
            XCTAssertEqual(byKey[key0], pixels0, "seed \(seed): tile 0 payload must arrive byte-exact")
            XCTAssertEqual(byKey[key1], pixels1, "seed \(seed): tile 1 payload must arrive byte-exact")
            XCTAssertTrue(arrivals.allSatisfy { $0.docId == "fuzz-doc" }, "seed \(seed): docId must survive fragmentation")
        }
    }

    /// The one split position the brief names literally: EXACTLY on the header/payload boundary —
    /// chunk 1 is the header line and nothing else, chunk 2 is the entire payload and nothing else.
    /// A seeded fuzz run might never happen to land exactly here by chance; this pins it explicitly.
    func testHeaderPayloadBoundarySplitExactlyAtTheBoundary() async throws {
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let pixels = Data(repeating: 0x33, count: TileMath.bytesPerTile)
        let frame = OfficeWireFrame.tile(seq: 1, docId: "boundary-doc", key: key, generation: 0,
                                          width: 512, height: 512, pixels: pixels)
        let header = frame.encodedLine()

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        guard let fd = bindAndListenScratchSocket(at: socketPath) else { return }
        Thread {
            let clientFD = accept(fd, nil, nil)
            guard clientFD >= 0 else { return }
            _ = header.withUnsafeBytes { write(clientFD, $0.baseAddress, $0.count) }
            _ = pixels.withUnsafeBytes { write(clientFD, $0.baseAddress, $0.count) }
            close(clientFD)
            close(fd)
        }.start()

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        try await connection.open()
        defer { connection.close() }

        let arrived = await waitUntil(timeout: 5.0) { !box.snapshot().arrivals.isEmpty }
        XCTAssertTrue(arrived, "onTile never fired for a header-then-payload two-write delivery")
        XCTAssertEqual(box.snapshot().arrivals.first?.pixels, pixels)
    }

    /// THE LANDMINE, directly: a payload that is `0x0A` in EVERY byte — the single most adversarial
    /// input a newline-scanning reader could receive. Delivered in small fixed chunks (reusing the
    /// O(n²) test's own peer) so a broken implementation that still scanned payload bytes for `\n`
    /// would misread nearly every byte as a line terminator, not just an occasional unlucky one.
    func testTilePayloadContainingOnly0x0ABytesArrivesIntact() async throws {
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let pixels = Data(repeating: 0x0A, count: TileMath.bytesPerTile)
        let frame = OfficeWireFrame.tile(seq: 1, docId: "landmine-doc", key: key, generation: 0,
                                          width: 512, height: 512, pixels: pixels)
        let wireBytes = frame.encodedLine() + pixels

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        startChunkedWritePeer(at: socketPath, data: wireBytes, chunkSize: 4096)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        try await connection.open()
        defer { connection.close() }

        let arrived = await waitUntil(timeout: 10.0) { !box.snapshot().arrivals.isEmpty }
        XCTAssertTrue(arrived, "onTile never fired for an all-0x0A payload")
        let received = box.snapshot().arrivals.first
        XCTAssertEqual(received?.pixels, pixels, "an all-0x0A payload must survive byte-for-byte — "
                        + "a broken newline-scanning reader would fragment or truncate this")
        XCTAssertEqual(received?.pixels.count, TileMath.bytesPerTile)
    }

    /// EOF mid-payload: the header arrives, byteCount is legal, but the peer vanishes partway
    /// through the payload. Refuse-never-ignore's own answer here (there is no reply mechanism for
    /// a push, so nothing can be "answered"): the connection observes closed, cleanly, and no
    /// partial/corrupt tile is ever handed to `onTile`.
    func testEOFMidPayloadClosesTheConnectionWithoutDeliveringATile() async throws {
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let pixels = Data(repeating: 0x44, count: TileMath.bytesPerTile)
        let frame = OfficeWireFrame.tile(seq: 1, docId: "eof-doc", key: key, generation: 0,
                                          width: 512, height: 512, pixels: pixels)
        let header = frame.encodedLine()
        let partialPayload = pixels.prefix(TileMath.bytesPerTile / 2) // half the promised bytes, then silence

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        guard let fd = bindAndListenScratchSocket(at: socketPath) else { return }
        Thread {
            let clientFD = accept(fd, nil, nil)
            guard clientFD >= 0 else { return }
            _ = header.withUnsafeBytes { write(clientFD, $0.baseAddress, $0.count) }
            _ = partialPayload.withUnsafeBytes { write(clientFD, $0.baseAddress, $0.count) }
            close(clientFD) // EOF -- the other half of the promised byteCount never arrives
            close(fd)
        }.start()

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        connection.onClosed = { box.recordClosed() }
        try await connection.open()
        defer { connection.close() }

        let closed = await waitUntil(timeout: 5.0) { box.snapshot().closed }
        XCTAssertTrue(closed, "the connection must observe closed after EOF mid-payload, not hang forever")
        XCTAssertTrue(box.snapshot().arrivals.isEmpty, "a truncated payload must never reach onTile as a partial/corrupt tile")
        XCTAssertTrue(connection.isClosed)
    }

    /// `byteCount: 0` — refused, not treated as "a legitimately empty tile." Answers the brief's own
    /// "byteCount 0: legal? define" with the SAME exact-size-or-refuse rule every other wrong
    /// byteCount gets (see `ingest`'s own comment): 0 is simply not the one legal size
    /// (`TileMath.bytesPerTile`), so it needs no special-case reasoning of its own. Refusal is
    /// observable the same way EOF-mid-payload's is: the connection closes, `onTile` never fires.
    func testTileByteCountZeroRefusesTheConnection() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        startChunkedWritePeer(at: socketPath, data: rawTileHeaderLine(byteCount: 0), chunkSize: 4096)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        connection.onClosed = { box.recordClosed() }
        try await connection.open()
        defer { connection.close() }

        let closed = await waitUntil(timeout: 5.0) { box.snapshot().closed }
        XCTAssertTrue(closed, "a byteCount:0 tile header must refuse (close) the connection")
        XCTAssertTrue(box.snapshot().arrivals.isEmpty, "byteCount:0 must never be treated as a legitimate empty tile")
    }

    /// **Wave fix (T5.5 review Minor-B)** — a `"tile"`-typed line whose OWN structure fails to
    /// decode (here: missing `height`) must refuse the connection exactly like a structurally-valid-
    /// but-wrong `byteCount` already does above — NOT log-and-continue the way every OTHER malformed
    /// line does (`.rejected`'s own treatment; see `OfficeWireInbound.tileHeaderMalformed`'s own
    /// header for the desync hazard this closes). Proven with a bait: a well-formed `"ping"` line
    /// placed immediately after the malformed tile header. Under the pre-fix behavior (fall through
    /// to `.rejected`'s "log and keep scanning"), this ping would eventually surface via `nextFrame`
    /// — the tile line's own missing payload bytes never arrive, so the scan just keeps looking for
    /// the next newline and finds this one; under the fix, the connection is torn down before the
    /// scan ever reaches it. The falsifiable proof that no garbage-line scan happens, not merely that
    /// nothing bad happened to fire on this particular input.
    func testMalformedTileHeaderRefusesTheConnectionRatherThanScanningThePayloadAsGarbageLines() async throws {
        // Missing "height" — a required field `TileWireHeader` cannot decode without.
        let malformedHeader = Data(#"{"type":"tile","seq":1,"docId":"d","key":{"part":0,"zoomPPT":1000,"tileX":0,"tileY":0},"generation":0,"width":512,"byteCount":100}"#.utf8) + Data([0x0A])
        let baitPing = Data(#"{"type":"ping","seq":2}"#.utf8) + Data([0x0A])
        let wireBytes = malformedHeader + baitPing

        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        // Small chunks: proves the refusal survives fragmented delivery of the malformed header
        // itself, not just a monolithic one.
        startChunkedWritePeer(at: socketPath, data: wireBytes, chunkSize: 16)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        connection.onClosed = { box.recordClosed() }
        try await connection.open()
        defer { connection.close() }

        let reply = await connection.nextFrame(timeout: 3.0)
        XCTAssertNil(reply, "the bait \"ping\" line after the malformed tile header must NEVER "
                     + "surface — the connection must refuse before its scan ever reaches it")
        let closed = await waitUntil(timeout: 5.0) { box.snapshot().closed }
        XCTAssertTrue(closed, "a malformed tile header must refuse (close) the connection, like the "
                     + "byteCount-mismatch case already does")
        XCTAssertTrue(box.snapshot().arrivals.isEmpty)
    }

    /// A hostile-huge `byteCount` (comfortably larger than any real tile could ever be, and larger
    /// than this test will ever send) must be refused OFF THE HEADER ALONE — promptly, never by
    /// entering payload-accumulation mode and waiting to see whether that many bytes eventually
    /// arrive (they never will here; this is exactly the unbounded-buffer/DoS shape the T4 review's
    /// own `TileMath.maxTilesPerRectEnumeration`/`isZoomPPTValid` precedent refuses server-side for
    /// the identical reason). The short timeout below is itself part of the claim: a reader that
    /// mistakenly WAITED for the declared byteCount would still be sitting there well past it.
    func testTileByteCountHugeRefusesTheConnectionPromptlyWithoutAccumulating() async throws {
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        // Only the header is ever sent — no payload bytes follow, on purpose: if the reader ever
        // mistakenly entered payload-accumulation mode for this byteCount, it would simply hang
        // (nothing more is coming), and the timeout below would fail loudly rather than silently
        // passing for the wrong reason.
        startChunkedWritePeer(at: socketPath, data: rawTileHeaderLine(byteCount: 999_999_999), chunkSize: 4096)

        let socketAppeared = await waitUntil(timeout: 5.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "setup: the hand-rolled peer's socket file never appeared")

        let connection = OfficeWireConnection(socketPath: socketPath)
        let box = TileArrivalBox()
        connection.onTile = { _, docId, key, _, _, _, pixels in box.recordTile(docId, key, pixels) }
        connection.onClosed = { box.recordClosed() }
        let start = Date()
        try await connection.open()
        defer { connection.close() }

        // 10s wait budget (generous, absorbs CI slowness) vs. a 1.0s ASSERTION ceiling well below
        // it: a reader that mistakenly entered payload-accumulation mode for 999,999,999 bytes
        // would still be sitting in `waitUntil` at the 1.0s mark (nothing more is ever sent), so
        // comparing `elapsed` against the SAME number used to bound the wait would be tautological
        // — this gap is what makes "promptly, not a timeout-shaped wait" a real claim, not a
        // trivially-true one.
        let closed = await waitUntil(timeout: 10.0) { box.snapshot().closed }
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertTrue(closed, "a hostile-huge byteCount must refuse (close) the connection promptly, not hang")
        XCTAssertLessThan(elapsed, 1.0, "refusal took \(elapsed)s -- should be near-instant (decode-time), "
                            + "not a timeout-shaped wait for bytes that were never coming")
        XCTAssertTrue(box.snapshot().arrivals.isEmpty)
    }
}
