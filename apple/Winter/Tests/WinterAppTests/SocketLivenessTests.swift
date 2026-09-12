import Darwin
import XCTest
@testable import Winter

/// Whole-branch review regression: `DaemonSupervisorDeps.live`'s `socketExists` is a Unix-socket
/// LIVENESS probe (`unixSocketIsLive`), not a file-presence check. The bug it guards against: a
/// dead daemon leaves a STALE socket FILE on disk; a presence check reads that as "reachable" →
/// supervisor goes `.connectOnly` → never spawns the bundled daemon → engine permanently down on
/// the next launch. A liveness probe reads the stale file as NOT live → supervisor spawns →
/// `acquireLock` unlinks the stale file → healthy.
///
/// These tests operate ONLY on sockets under a per-test temp dir — never the real
/// `~/.winter/run/core.sock`.
final class SocketLivenessTests: XCTestCase {
    private var tempDir: String!

    override func setUpWithError() throws {
        // A SHORT `/tmp` path, not `NSTemporaryDirectory()` — macOS `sun_path` is only 104 bytes and
        // the `/var/folders/.../T/` temp dir alone nearly fills it, which would trip the bind guard
        // and skip the listening-socket tests. `/tmp/nl.<8hex>/x.sock` stays comfortably short.
        tempDir = "/tmp/nl.\(UUID().uuidString.prefix(8))"
        try FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: tempDir)
    }

    private func path(_ name: String) -> String { (tempDir as NSString).appendingPathComponent(name) }

    /// Binds + listens a real AF_UNIX socket at `path`, returns its fd (caller closes it). This is
    /// the "a daemon is actually listening" positive case.
    private func makeListeningSocket(at path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("socket() failed") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw XCTSkip("temp path too long for sun_path") }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) }
        }
        guard bound == 0 else { close(fd); throw XCTSkip("bind() failed errno=\(errno)") }
        guard listen(fd, 1) == 0 else { close(fd); throw XCTSkip("listen() failed errno=\(errno)") }
        return fd
    }

    // MARK: - unixSocketIsLive

    func testLiveForAListeningSocket() throws {
        let p = path("live.sock")
        let server = try makeListeningSocket(at: p)
        defer { close(server); unlink(p) }
        XCTAssertTrue(unixSocketIsLive(path: p), "a socket with a real listener must read as live")
    }

    func testNotLiveForAStaleSocketFile() {
        // A plain file standing in for the stale socket a dead daemon leaves behind — connect()
        // gives ECONNREFUSED/ENOTSOCK, never a successful connect.
        let p = path("stale.sock")
        XCTAssertTrue(FileManager.default.createFile(atPath: p, contents: Data()))
        XCTAssertFalse(unixSocketIsLive(path: p), "a stale socket FILE with no listener must read as NOT live")
    }

    func testNotLiveForAStaleSocketFileLeftByAClosedListener() throws {
        // The most faithful stale case: a socket that WAS bound+listened, then its fd closed —
        // closing an AF_UNIX socket does not unlink the path, so the file lingers with no listener,
        // exactly like a crashed daemon's leftover socket.
        let p = path("closed.sock")
        let server = try makeListeningSocket(at: p)
        close(server) // listener gone, but the file remains on disk
        defer { unlink(p) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: p), "closing the socket must leave the file (the stale-file scenario)")
        XCTAssertFalse(unixSocketIsLive(path: p), "a socket file whose listener has gone must read as NOT live")
    }

    func testNotLiveForAMissingFile() {
        XCTAssertFalse(unixSocketIsLive(path: path("does-not-exist.sock")), "a missing socket file (ENOENT) must read as NOT live")
    }

    // MARK: - the supervisor decision (the actual regression)

    /// The bug end-to-end: with `.live`-style `socketExists` (the liveness probe) over a STALE
    /// socket file, `DaemonSupervisor.start()` must decide `.supervising` and SPAWN — not
    /// `.connectOnly`. Under the OLD file-presence check this returned `.connectOnly` and stranded a
    /// dead engine. `FakeDaemonProcess` keeps the spawn from launching anything real.
    @MainActor
    func testSupervisorSpawnsOverAStaleSocketFileInsteadOfConnectOnly() {
        let stale = path("core.sock")
        XCTAssertTrue(FileManager.default.createFile(atPath: stale, contents: Data()))
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x/winter-core" },
            socketExists: { unixSocketIsLive(path: stale) }, // the real .live probe, over the stale file
            isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() },
            now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .supervising, "a stale socket FILE must NOT short-circuit the supervisor to connectOnly")
        XCTAssertEqual(spawned, 1, "the supervisor must spawn its bundled daemon so acquireLock can unlink the stale socket")
    }

    /// The complementary guarantee: a genuinely LIVE socket still short-circuits to `.connectOnly`
    /// (the dev-decoupling contract — a hand-run daemon holding the socket is left untouched).
    @MainActor
    func testSupervisorStaysConnectOnlyOverALiveSocket() throws {
        let live = path("core.sock")
        let server = try makeListeningSocket(at: live)
        defer { close(server); unlink(live) }
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x/winter-core" },
            socketExists: { unixSocketIsLive(path: live) },
            isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() },
            now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly, "a genuinely live socket must still short-circuit — never spawn a second daemon onto it")
        XCTAssertEqual(spawned, 0)
    }
}
