import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// The socket path was too long for `sockaddr_un.sun_path` (104 bytes on macOS, including the NUL
/// terminator — so 103 usable bytes), or a POSIX call failed. Both are reported with the raw
/// `errno` string rather than a generic message: this runs unattended, spawned by the supervisor,
/// with its stderr the only place a bind/listen failure is ever going to surface.
public enum OfficeHelperServerError: Error, CustomStringConvertible {
    case posix(String)
    public var description: String {
        switch self {
        case .posix(let message): return message
        }
    }
}

/// Office Stage A Task 2 — the helper's Unix-socket listener plus per-connection protocol
/// handler. Runs identically whether started from `NormaOfficeHelper`'s real `main.swift` or the
/// out-of-process test fixture's (`Tests/OfficeHelperFixtureSources/main.swift`): the fixture
/// exists to drive THIS code's failure paths for real, over a real socket, not to reimplement
/// them — so `OfficeSupervisorTests` proves something about the actual protocol handler, not
/// about a second, hand-rolled stand-in that could drift from it.
///
/// LibreOfficeKit is NOT loaded here — Task 3's job. `open`/`close` are pure bookkeeping against
/// `documents`, which feeds the idle-exit accounting below and nothing else yet.
///
/// **Raw POSIX sockets, not `NWListener`.** The app-side client already has a natural fit in
/// NormaKit's `UnixSocketTransport` (`NWConnection` over `.unix(path:)`, precedented by the
/// daemon connection); the LISTENER side has no equivalent in-repo precedent, and Network.framework's
/// local-endpoint-bind API for a Unix-domain listener is far less travelled than its connect-side
/// API. `socket`/`bind`/`listen`/`accept` is the boring, well-understood way to own the passive
/// side of an AF_UNIX SOCK_STREAM socket, and this helper only ever expects a handful of
/// concurrent connections (the app; later, the daemon) — no need for anything more elaborate than
/// one thread per accepted connection, each doing blocking reads.
public final class OfficeHelperServer {

    /// Test-only behavior injection — see `Tests/OfficeHelperFixtureSources/main.swift`. Every
    /// field defaults to "behave exactly like production," so `NormaOfficeHelper`'s real
    /// `main.swift` never has to construct anything but `Hooks()`.
    public struct Hooks: Sendable {
        /// When true, every connection still reads and decodes frames — so `documents`/connection
        /// bookkeeping and idle-exit accounting stay real — but never WRITES a reply. Simulates a
        /// helper that accepted a connection and then hung, for the supervisor's
        /// handshake-timeout retry path.
        public var suppressReplies: Bool
        /// Called synchronously, on the connection's own thread, immediately after a `helloOk`
        /// reply is written to the socket. The fixture's "die after hello" mode sets this to
        /// `_exit(0)` — simulates a crash immediately after a successful handshake, for the
        /// supervisor's death-detection path.
        public var afterHelloOkWritten: (@Sendable () -> Void)?

        public init(suppressReplies: Bool = false, afterHelloOkWritten: (@Sendable () -> Void)? = nil) {
            self.suppressReplies = suppressReplies
            self.afterHelloOkWritten = afterHelloOkWritten
        }
    }

    private let socketPath: String
    private let statePath: String
    private let expectedToken: String
    private let idleExitSeconds: Double
    private let hooks: Hooks
    private let log: (String) -> Void

    private var listenFD: Int32 = -1

    /// Every mutable field below is touched ONLY from `stateQueue` (accessed via `.sync`, never
    /// `.async`, so idle-exit accounting is never stale by even one connection open/close when a
    /// test inspects timing) — connection threads call in, they never touch these directly.
    private let stateQueue = DispatchQueue(label: "office-helper.state")
    private var documents: Set<String> = []
    private var connectionCount = 0
    private var idleTimer: DispatchSourceTimer?
    private var nextConnectionId = 0

    public init(socketPath: String, statePath: String, expectedToken: String,
                idleExitSeconds: Double = 120, hooks: Hooks = Hooks(),
                log: @escaping (String) -> Void = { message in
                    FileHandle.standardError.write(Data((message + "\n").utf8))
                }) {
        self.socketPath = socketPath
        self.statePath = statePath
        self.expectedToken = expectedToken
        self.idleExitSeconds = idleExitSeconds
        self.hooks = hooks
        self.log = log
    }

    /// Binds, listens, and starts accepting on a dedicated background thread. Returns once the
    /// socket is bound and listening — the moment a caller (the app-side supervisor, polling for
    /// the socket file) can start connecting.
    public func start() throws {
        try FileManager.default.createDirectory(atPath: statePath, withIntermediateDirectories: true)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw OfficeHelperServerError.posix("socket() failed: \(String(cString: strerror(errno)))")
        }

        // A stale socket file from a previous run that died without cleanup would otherwise fail
        // bind() with EADDRINUSE. Best-effort: ENOENT (nothing there) is not an error worth
        // reporting.
        unlink(socketPath)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            close(fd)
            throw OfficeHelperServerError.posix(
                "socket path too long for sockaddr_un.sun_path (\(pathBytes.count) bytes, limit "
                + "\(capacity - 1)): \(socketPath)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let buffer = raw.bindMemory(to: UInt8.self)
            for index in 0..<capacity { buffer[index] = 0 }
            for (index, byte) in pathBytes.enumerated() { buffer[index] = byte }
        }

        let bindResult = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw OfficeHelperServerError.posix("bind() failed on \(socketPath): \(message)")
        }

        guard listen(fd, 8) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw OfficeHelperServerError.posix("listen() failed: \(message)")
        }

        listenFD = fd
        log("[OfficeHelperServer] listening on \(socketPath)")

        let acceptThread = Thread { [weak self] in self?.acceptLoop() }
        acceptThread.name = "office-helper.accept"
        acceptThread.start()

        stateQueue.sync { refreshIdleStateLocked() }
    }

    // MARK: - Accept loop

    private func acceptLoop() {
        while true {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                // EBADF/EINVAL: the listening fd was torn down out from under us. There is
                // currently no `stop()` (nothing in Task 2 calls one — every exit path is
                // `_exit(0)`, which takes this thread with it), so in practice this only fires if
                // that ever changes; exiting the loop quietly is still the right shape.
                if errno == EBADF || errno == EINVAL { return }
                log("[OfficeHelperServer] accept() error: \(String(cString: strerror(errno)))")
                continue
            }
            let connectionId = stateQueue.sync { () -> Int in
                nextConnectionId += 1
                connectionCount += 1
                refreshIdleStateLocked()
                return nextConnectionId
            }
            let connectionThread = Thread { [weak self] in
                self?.handleConnection(fd: clientFD, id: connectionId)
            }
            connectionThread.name = "office-helper.conn.\(connectionId)"
            connectionThread.start()
        }
    }

    // MARK: - Per-connection handling

    private func handleConnection(fd: Int32, id: Int) {
        defer {
            close(fd)
            stateQueue.sync {
                connectionCount -= 1
                refreshIdleStateLocked()
            }
        }

        var authenticated = false
        var buffer = Data()
        var readBuffer = [UInt8](repeating: 0, count: 64 * 1024)

        while true {
            let bytesRead = readBuffer.withUnsafeMutableBytes { raw -> Int in
                read(fd, raw.baseAddress, raw.count)
            }
            if bytesRead <= 0 { return } // 0 = peer closed; <0 = read error — either way, done.
            buffer.append(contentsOf: readBuffer[0..<bytesRead])

            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                buffer.removeSubrange(buffer.startIndex...newlineIndex)
                guard let line = String(data: lineData, encoding: .utf8) else { continue }

                if !authenticated {
                    guard handleOpeningLine(line, fd: fd) else { return } // reply sent; done either way
                    authenticated = true
                    continue
                }
                handlePostAuthLine(line, fd: fd)
            }
        }
    }

    /// The pre-auth gate: the first frame on a connection MUST be a `hello` carrying the token
    /// this helper was launched with. Anything else — wrong type, malformed hello, wrong token —
    /// gets exactly one reply and the connection ends (refuse-never-ignore still means a reply is
    /// always sent; it does not mean the connection survives an auth failure). Returns `true` only
    /// when authentication succeeded, in which case the caller keeps reading on this connection.
    private func handleOpeningLine(_ line: String, fd: Int32) -> Bool {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.hello(let seq, _, let token)):
            guard token == expectedToken else {
                writeReply(.refused(seq: seq, reason: "token mismatch"), fd: fd)
                return false
            }
            // `role` is accepted but not yet branched on — Stage A gives app and agent the same
            // credential and the same greeting; Stage C is what gives the daemon its own token and
            // its own verbs.
            writeReply(.helloOk(seq: seq, lokVersion: officeWireStageALOKVersionPlaceholder), fd: fd)
            hooks.afterHelloOkWritten?()
            return true
        case .frame(let frame):
            writeReply(.error(seq: frame.seq, reason: "not authenticated"), fd: fd)
            return false
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), fd: fd)
            return false
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), fd: fd)
            return false
        }
    }

    /// Post-auth: every line gets exactly one reply; nothing here ever closes the connection on
    /// its own initiative (only a read error/EOF does, in `handleConnection`) — a bad frame after
    /// a good handshake is a protocol violation to answer, not a reason to drop a session the
    /// client may recover from.
    private func handlePostAuthLine(_ line: String, fd: Int32) {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.ping(let seq)):
            writeReply(.pong(seq: seq), fd: fd)
        case .frame(.open(let seq, let docId, let path)):
            _ = path // Stage A: no LOK, so the path is validated-by-decoding only; Task 3 uses it.
            stateQueue.sync {
                documents.insert(docId)
                refreshIdleStateLocked()
            }
            writeReply(.opened(seq: seq, docId: docId), fd: fd)
        case .frame(.close(let seq, let docId)):
            stateQueue.sync {
                documents.remove(docId)
                refreshIdleStateLocked()
            }
            writeReply(.closed(seq: seq, docId: docId), fd: fd)
        case .frame(.hello(let seq, _, _)):
            writeReply(.error(seq: seq, reason: "already authenticated"), fd: fd)
        case .frame(let frame):
            // helloOk/refused/pong/opened/closed/error: structurally valid frames that are never
            // legal for a CLIENT to send — the helper only ever sends these.
            writeReply(.error(seq: frame.seq, reason: "unexpected"), fd: fd)
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), fd: fd)
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), fd: fd)
        }
    }

    private func writeReply(_ frame: OfficeWireFrame, fd: Int32) {
        guard !hooks.suppressReplies else { return }
        let data = frame.encodedLine()
        _ = data.withUnsafeBytes { raw -> Int in
            write(fd, raw.baseAddress, raw.count)
        }
    }

    // MARK: - Idle-exit accounting

    /// Must run ON `stateQueue`. "Zero documents AND zero clients" per the brief: re-evaluated
    /// after every connection open/close and every open/close frame, so the 120s (or, in tests, a
    /// far shorter override) countdown always measures from the LAST moment the helper had any
    /// reason to stay alive, not from process launch.
    private func refreshIdleStateLocked() {
        idleTimer?.cancel()
        idleTimer = nil
        guard documents.isEmpty && connectionCount == 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        timer.schedule(deadline: .now() + idleExitSeconds)
        timer.setEventHandler { [log, idleExitSeconds] in
            log("[OfficeHelperServer] idle \(idleExitSeconds)s with zero documents and zero clients — exiting")
            // Global constraint (plan header, binding on every helper teardown path, not only
            // Task 3's LOK static-destructor crash): _exit(0), never a normal return/exit() that
            // would run atexit/static-destructor cleanup.
            _exit(0)
        }
        timer.resume()
        idleTimer = timer
    }
}
