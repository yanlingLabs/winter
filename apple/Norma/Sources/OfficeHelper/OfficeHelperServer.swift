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

/// Task 3 — what `OfficeHelperServer` needs from something that can load/unload documents.
/// `LOKBridge` (the real implementation, `NormaOfficeHelper` only) and `FakeOfficeDocumentBridge`
/// (below, used by `NormaOfficeHelperFixture`'s spy binary) both conform — `OfficeHelperServer`
/// itself never touches a LOK symbol, matching Task 2's own design: `NormaOfficeHelperFixture`
/// links this file UNCHANGED and must keep building without the bridging header / LOK C symbols
/// `LOKBridge.swift` needs (see project.yml: that one file is excluded from the fixture target).
public protocol OfficeDocumentBridge: AnyObject {
    /// A short, honest self-description for `helloOk.lokVersion` — the real LOK `BuildId` for
    /// `LOKBridge`, `officeWireStageALOKVersionPlaceholder` for the fake. Read once, before the
    /// first `hello` ever answers.
    var lokVersionString: String { get }

    /// Loads `path` under `docId`. Throws (never traps/crashes the process) on any failure — a
    /// garbage document, an unreadable path, or any other `documentLoad`-shaped failure.
    /// `OfficeHelperServer` translates a thrown error into `openFailed` and keeps serving —
    /// the helper surviving a bad document is the whole point of this being a thrown Swift error,
    /// not a fatal one.
    func open(docId: String, path: String) throws -> OfficeDocumentMetadata

    /// Destroys `docId`'s handle, if any is tracked. A no-op (not an error) for an untracked
    /// `docId` — matches `close`'s wire-level idempotence (`OfficeHelperServer` itself is the
    /// source of truth for "is this docId open"; a bridge is never asked to close something it
    /// never opened in a well-behaved server, but must not crash if it happens).
    func close(docId: String)

    /// Fires for every asynchronous, unprompted event a still-open document produces (real LOK
    /// callbacks for `LOKBridge`; never for the fake, which has nothing to push). Set ONCE, by
    /// `OfficeHelperServer` at construction, before any document ever opens.
    var onEvent: ((String, OfficeDocumentEvent) -> Void)? { get set }
}

/// `NormaOfficeHelperFixture`'s bridge — behaves exactly like Task 2's own Stage-A bookkeeping
/// (every `open` "succeeds" with placeholder metadata nobody asserts on; `close` no-ops; nothing is
/// ever pushed). `OfficeSupervisorTests` never calls `open`/`close` at all (its scenarios are
/// handshake/death-detection, not document-shaped) — this exists so the fixture's `main.swift`
/// has SOMETHING to construct `OfficeHelperServer` with, honestly reporting "no real LOK here"
/// via `officeWireStageALOKVersionPlaceholder` for `helloOk.lokVersion`.
public final class FakeOfficeDocumentBridge: OfficeDocumentBridge {
    public let lokVersionString = officeWireStageALOKVersionPlaceholder
    public var onEvent: ((String, OfficeDocumentEvent) -> Void)?
    public init() {}
    public func open(docId: String, path: String) throws -> OfficeDocumentMetadata {
        OfficeDocumentMetadata(type: .other, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 0, heightTwips: 0))
    }
    public func close(docId: String) {}
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

    /// Task 3 — one per accepted connection: the raw fd plus a write lock BOTH the reply path
    /// (`writeReply`, called from this connection's own thread) and the async push path (LOK
    /// callbacks, arriving on `LOKBridge`'s dedicated thread — see `OfficeHelperServer`'s own
    /// header below) must hold before writing, so the two streams can never interleave bytes on
    /// the wire. `ownedDocIds` (guarded by `stateQueue`, not `writeLock` — a different concern)
    /// is this connection's own subset of `docOwner`'s keys, so connection teardown can close
    /// exactly the documents IT opened without scanning the whole table.
    private final class ConnectionWriter {
        let fd: Int32
        let writeLock = NSLock()
        var ownedDocIds: Set<String> = []
        init(fd: Int32) { self.fd = fd }
    }

    private let socketPath: String
    private let statePath: String
    private let expectedToken: String
    private let idleExitSeconds: Double
    private let hooks: Hooks
    private let documentBridge: OfficeDocumentBridge
    private let log: (String) -> Void

    private var listenFD: Int32 = -1

    /// Every mutable field below is touched ONLY from `stateQueue` (accessed via `.sync`, never
    /// `.async`, so idle-exit accounting is never stale by even one connection open/close when a
    /// test inspects timing) — connection threads call in, they never touch these directly.
    ///
    /// **Invariant: no code running under `stateQueue.sync` may call into `documentBridge`.**
    /// `documentBridge.open`/`.close` block on `LOKBridge`'s own dedicated thread, which can
    /// synchronously invoke `pushSeqAllocator`/`docOwner` lookups (via `onEvent`, wired in `init`
    /// below) from INSIDE that same blocked call — calling into the bridge while already holding
    /// `stateQueue` would risk exactly the kind of cross-lock ordering that turns into a deadlock
    /// the moment the two paths ever nest. Every call site below copies what it needs out of
    /// `stateQueue` first, then calls the bridge, then (if necessary) re-enters `stateQueue`
    /// separately for bookkeeping.
    private let stateQueue = DispatchQueue(label: "office-helper.state")
    /// docId -> the connection that opened it. Doubles as Task 2's old `documents` set for
    /// idle-exit accounting (`docOwner.isEmpty`) — one table, not two that could drift apart.
    private var docOwner: [String: ConnectionWriter] = [:]
    private var connectionCount = 0
    private var idleTimer: DispatchSourceTimer?
    private var nextConnectionId = 0
    /// Mints `seq` for HELPER-INITIATED `documentEvent` pushes — a separate stream from any
    /// client's own request `seq`s (see `OfficeWireFrame.documentEvent`'s own header).
    private let pushSeqAllocator = OfficeWireSeqAllocator()

    public init(socketPath: String, statePath: String, expectedToken: String,
                idleExitSeconds: Double = 120, hooks: Hooks = Hooks(),
                documentBridge: OfficeDocumentBridge,
                log: @escaping (String) -> Void = { message in
                    FileHandle.standardError.write(Data((message + "\n").utf8))
                }) {
        self.socketPath = socketPath
        self.statePath = statePath
        self.expectedToken = expectedToken
        self.idleExitSeconds = idleExitSeconds
        self.hooks = hooks
        self.documentBridge = documentBridge
        self.log = log
        documentBridge.onEvent = { [weak self] docId, event in
            self?.routeDocumentEvent(docId: docId, event: event)
        }
    }

    /// The async-push counterpart to `writeReply` — called from whatever thread `documentBridge`
    /// fires its callback on (LOKBridge's dedicated thread, for the real bridge; never, for the
    /// fake). Copies the owning connection's `ConnectionWriter` reference out of `stateQueue`
    /// FIRST, then writes under only that writer's own lock — never while holding `stateQueue` (a
    /// blocking socket write inside `stateQueue.sync` would wedge idle-exit accounting behind a
    /// slow/stuck client for as long as the write takes).
    private func routeDocumentEvent(docId: String, event: OfficeDocumentEvent) {
        guard let writer = stateQueue.sync(execute: { docOwner[docId] }) else { return }
        let seq = pushSeqAllocator.nextSeq()
        let frame = OfficeWireFrame.documentEvent(seq: seq, docId: docId, event: event)
        writer.writeLock.lock()
        writeAll(frame.encodedLine(), fd: writer.fd)
        writer.writeLock.unlock()
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
        let writer = ConnectionWriter(fd: fd)
        defer {
            close(fd)
            // Task 3: a connection that disconnects without explicitly closing its documents
            // (a crash, a dropped socket) must not leak them — copy the owned set out, close each
            // OUTSIDE stateQueue (the bridge-call invariant above), then remove the bookkeeping in
            // a second, separate stateQueue hop.
            let owned = stateQueue.sync { () -> Set<String> in
                connectionCount -= 1
                return writer.ownedDocIds
            }
            for docId in owned {
                documentBridge.close(docId: docId)
            }
            stateQueue.sync {
                for docId in owned { docOwner.removeValue(forKey: docId) }
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
            if bytesRead == 0 { return } // peer closed
            if bytesRead < 0 {
                // F6 (T2 review): EINTR — this read() was interrupted by a signal before any data
                // arrived; the CONNECTION is still perfectly valid, only this one call was cut
                // short. Treating it the same as a real error/EOF (the previous `bytesRead <= 0`
                // check did) would drop a healthy connection over nothing more than an interrupted
                // system call. Any other errno IS a real read error — done.
                if errno == EINTR { continue }
                return
            }
            buffer.append(contentsOf: readBuffer[0..<bytesRead])

            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                buffer.removeSubrange(buffer.startIndex...newlineIndex)
                guard let line = String(data: lineData, encoding: .utf8) else {
                    // F4 fix (T2 review): this used to `continue` — silently dropping a line that
                    // isn't even valid UTF-8, never answering it. Refuse-never-ignore's whole point
                    // is that EVERY line gets a reply; bytes that can't even become a `String`
                    // still owe one — proven live: without this, whoever sent it starves for its
                    // own full request timeout instead of being told anything. `seq` is
                    // unrecoverable (there is no JSON to read one from), so this is the same
                    // sentinel-seq path `OfficeWireCodec.decodeInbound`'s `.unreadable` case
                    // already uses for a line that IS valid UTF-8 but isn't valid JSON.
                    writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
                    if !authenticated { return } // same pre-auth rule as every other opening violation
                    continue
                }

                if !authenticated {
                    guard handleOpeningLine(line, writer: writer) else { return } // reply sent; done either way
                    authenticated = true
                    continue
                }
                handlePostAuthLine(line, writer: writer)
            }
        }
    }

    /// The pre-auth gate: the first frame on a connection MUST be a `hello` carrying the token
    /// this helper was launched with. Anything else — wrong type, malformed hello, wrong token —
    /// gets exactly one reply and the connection ends (refuse-never-ignore still means a reply is
    /// always sent; it does not mean the connection survives an auth failure). Returns `true` only
    /// when authentication succeeded, in which case the caller keeps reading on this connection.
    private func handleOpeningLine(_ line: String, writer: ConnectionWriter) -> Bool {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.hello(let seq, _, let token)):
            guard token == expectedToken else {
                writeReply(.refused(seq: seq, reason: "token mismatch"), writer: writer)
                return false
            }
            // `role` is accepted but not yet branched on — Stage A gives app and agent the same
            // credential and the same greeting; Stage C is what gives the daemon its own token and
            // its own verbs.
            writeReply(.helloOk(seq: seq, lokVersion: documentBridge.lokVersionString), writer: writer)
            hooks.afterHelloOkWritten?()
            return true
        case .frame(let frame):
            writeReply(.error(seq: frame.seq, reason: "not authenticated"), writer: writer)
            return false
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
            return false
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
            return false
        }
    }

    /// Post-auth: every line gets exactly one reply; nothing here ever closes the connection on
    /// its own initiative (only a read error/EOF does, in `handleConnection`) — a bad frame after
    /// a good handshake is a protocol violation to answer, not a reason to drop a session the
    /// client may recover from.
    private func handlePostAuthLine(_ line: String, writer: ConnectionWriter) {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.ping(let seq)):
            writeReply(.pong(seq: seq), writer: writer)
        case .frame(.open(let seq, let docId, let path)):
            // Task 3: open is REAL now. Double-open ruling (this task's own carry, decided here):
            // a second `open` of an already-tracked `docId` is `error{alreadyOpen}`, checked and
            // answered WITHOUT ever calling the bridge — real LOK document handles are not
            // idempotently re-openable the way Task 2's pure bookkeeping was (a silent re-load
            // would leak or double-own a handle); `close` first is the honest way to reload the
            // same docId. `close` itself stays idempotent (see its own case below) — there is no
            // equivalent double-destruction risk.
            let alreadyOpen = stateQueue.sync { docOwner[docId] != nil }
            if alreadyOpen {
                writeReply(.error(seq: seq, reason: "alreadyOpen"), writer: writer)
                return
            }
            do {
                // Never called while holding stateQueue (the bridge-call invariant above) — this
                // line runs on the connection's own thread with no lock held at all.
                let metadata = try documentBridge.open(docId: docId, path: path)
                stateQueue.sync {
                    docOwner[docId] = writer
                    writer.ownedDocIds.insert(docId)
                    refreshIdleStateLocked()
                }
                writeReply(.opened(seq: seq, docId: docId, type: metadata.type, parts: metadata.parts,
                                    sizeTwips: metadata.sizeTwips), writer: writer)
            } catch {
                // The helper SURVIVES a failed open (the brief's own garbage-file requirement) —
                // nothing here tears down the bridge or the connection; the next `open` (even of
                // the SAME docId, since it was never tracked) works normally.
                writeReply(.openFailed(seq: seq, docId: docId, reason: "\(error)"), writer: writer)
            }
        case .frame(.close(let seq, let docId)):
            // Idempotent: closing an untracked docId still acks `closed` (Task 2's own precedent,
            // unchanged) — the bridge itself tolerates being asked to close something it never
            // opened (see `OfficeDocumentBridge.close`'s own doc comment), so this never needs to
            // branch on whether docOwner actually had it.
            documentBridge.close(docId: docId)
            stateQueue.sync {
                if let owner = docOwner.removeValue(forKey: docId) {
                    owner.ownedDocIds.remove(docId)
                }
                refreshIdleStateLocked()
            }
            writeReply(.closed(seq: seq, docId: docId), writer: writer)
        case .frame(.hello(let seq, _, _)):
            writeReply(.error(seq: seq, reason: "already authenticated"), writer: writer)
        case .frame(let frame):
            // helloOk/openFailed/refused/pong/opened/closed/error/documentEvent: structurally
            // valid frames that are never legal for a CLIENT to send — the helper only ever sends
            // these.
            writeReply(.error(seq: frame.seq, reason: "unexpected"), writer: writer)
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
        }
    }

    /// Task 3: takes `writer.writeLock` — the SAME lock the async push path
    /// (`routeDocumentEvent`) takes around its own write to this connection's `fd` — so a reply
    /// and a push can never interleave bytes on the wire.
    private func writeReply(_ frame: OfficeWireFrame, writer: ConnectionWriter) {
        guard !hooks.suppressReplies else { return }
        writer.writeLock.lock()
        writeAll(frame.encodedLine(), fd: writer.fd)
        writer.writeLock.unlock()
    }

    /// Writes every byte of `data` to `fd`, looping past partial writes and retrying on EINTR (F6,
    /// T2 review). POSIX permits a single `write()` to a blocking socket to accept fewer bytes than
    /// requested even when it isn't full — today's frames are a few dozen bytes and this has never
    /// been observed to matter, but Task 3's real LOK version strings (and later document content)
    /// make a partial write plausible for the first time. A real write ERROR (EPIPE, ECONNRESET,
    /// ...) stops here rather than looping forever — the read loop's next `read()` will observe the
    /// closed connection and return on its own.
    private func writeAll(_ data: Data, fd: Int32) {
        data.withUnsafeBytes { raw in
            var offset = 0
            let total = raw.count
            while offset < total {
                let n = write(fd, raw.baseAddress!.advanced(by: offset), total - offset)
                if n > 0 {
                    offset += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    return
                }
            }
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
        guard docOwner.isEmpty && connectionCount == 0 else { return }
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
