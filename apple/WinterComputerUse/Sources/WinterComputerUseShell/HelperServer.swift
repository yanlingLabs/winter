import Darwin
import Foundation

public enum HelperServerError: Error, CustomStringConvertible {
    case posix(String)
    case alreadyRunning(String)

    public var description: String {
        switch self {
        case .posix(let message): return message
        case .alreadyRunning(let path): return "another helper is already listening on \(path)"
        }
    }
}

/// `hello` params. The shell's own method, so its shape lives here. `client` is "daemon" or "app" (Winter.app).
public struct HelloParams: Codable, Equatable, Sendable {
    public var `protocol`: Int
    public var client: String
    public var home: String
}

public struct HelloResult: Codable, Equatable, Sendable {
    public var `protocol`: Int
    public var helperVersion: String
    public var pid: Int32
}

/// The helper's Unix socket server: `<home>/run/computer-use.sock`, mode 0600, NDJSON JSON-RPC 2.0.
///
/// Per connection, in order: the peer check (before anything is read — a peer that is neither the daemon nor
/// Winter.app is closed with no response); then the first request must be `hello`, whose `client` must be one
/// the peer's code satisfies (a protocol or home mismatch, or a claimed identity it lacks, is answered and the
/// connection closed); then every request the client may make runs in its own task, so a slow call never
/// queues `cancel` behind it. Answers go out through one serial write queue per connection, in completion
/// order.
///
/// The two clients: the DAEMON drives everything, owns the sessions it uses (its close ends them) and gets the
/// `escPressed` / `targetLost` / `permissionsChanged` notifications; WINTER.APP may only say `hello`, read
/// `status` and subscribe to a session's view stream (`view.*`), owns nothing, and gets only `view.*`
/// notifications. Neither connection keeps the helper from its idle quit.
///
/// Raw POSIX sockets, one reader thread per connection, like `WinterOfficeHelper`'s server: the helper only
/// ever has a daemon or two connected.
public final class HelperServer: @unchecked Sendable {
    public struct Configuration: Sendable {
        public var socketPath: String
        /// Canonical (`realpath`) home this helper serves.
        public var home: String
        public var helperVersion: String
        /// Requests one connection may have in flight before new ones are answered `busy`.
        public var maxInFlightPerConnection: Int
        /// How often the listener checks its socket file still exists (and re-binds if something deleted it).
        public var socketCheckInterval: TimeInterval

        public init(socketPath: String, home: String, helperVersion: String,
                    maxInFlightPerConnection: Int = 64, socketCheckInterval: TimeInterval = 2) {
            self.socketPath = socketPath
            self.home = home
            self.helperVersion = helperVersion
            self.maxInFlightPerConnection = maxInFlightPerConnection
            self.socketCheckInterval = socketCheckInterval
        }
    }

    private let config: Configuration
    private let authenticator: PeerAuthenticator
    private let dispatcher: RPCDispatcher
    private let coordinator: HelperCoordinator
    private let inFlight: InFlightRegistry
    private let log: HelperLog

    private let lock = NSLock()
    private var listenFD: Int32 = -1
    private var boundInode: ino_t = 0
    private var stopped = false
    private var nextConnectionID = 0
    private var connections: [Int: Connection] = [:]
    /// sessionId → the connections that have used it. A session is ended when the last of them closes.
    private var sessionOwners: [String: Set<Int>] = [:]
    private var watchdog: DispatchSourceTimer?

    public init(configuration: Configuration, authenticator: PeerAuthenticator, dispatcher: RPCDispatcher,
                coordinator: HelperCoordinator, inFlight: InFlightRegistry, log: HelperLog) {
        self.config = configuration
        self.authenticator = authenticator
        self.dispatcher = dispatcher
        self.coordinator = coordinator
        self.inFlight = inFlight
        self.log = log
    }

    // MARK: - Listening

    /// Binds and listens; returns once a client can connect. The home must exist (the helper never creates a
    /// Winter home); its `run/` directory is created 0700 if missing.
    public func start() throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: config.home, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw HelperServerError.posix("the Winter home \(config.home) does not exist")
        }
        let runDir = (config.socketPath as NSString).deletingLastPathComponent
        if !FileManager.default.fileExists(atPath: runDir) {
            try FileManager.default.createDirectory(atPath: runDir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        try bindListener()
        startWatchdog()
    }

    /// Re-binds when the socket file is gone (something cleaned `run/` under a live helper). Cheap; also called
    /// when LaunchServices re-opens the running app.
    public func ensureListening() {
        lock.lock()
        let isStopped = stopped
        lock.unlock()
        guard !isStopped else { return }
        var st = stat()
        if lstat(config.socketPath, &st) == 0 { return }
        guard errno == ENOENT else { return }
        log.info("socket file \(config.socketPath) disappeared — listening again")
        do { try bindListener() } catch { log.error("could not re-bind: \(error)") }
    }

    private func bindListener() throws {
        let path = config.socketPath
        let pathBytes = Array(path.utf8)
        var addr = sockaddr_un()
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            throw HelperServerError.posix("socket path too long for sockaddr_un (\(pathBytes.count) bytes, limit \(capacity - 1)): \(path)")
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for index in 0..<capacity { raw[index] = 0 }
            for (index, byte) in pathBytes.enumerated() { raw[index] = byte }
        }

        // A live listener at the path is another helper serving this home: refuse rather than steal it. A
        // dead one (connection refused) is a stale file from a helper that did not clean up.
        if probeLive(addr: addr) { throw HelperServerError.alreadyRunning(path) }
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperServerError.posix("socket() failed: \(String(cString: strerror(errno)))") }
        // 0600 from the moment the file exists, not after a chmod.
        let previousMask = umask(0o177)
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        let bindErrno = errno
        umask(previousMask)
        guard bound == 0 else {
            close(fd)
            throw HelperServerError.posix("bind() failed on \(path): \(String(cString: strerror(bindErrno)))")
        }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            unlink(path)
            throw HelperServerError.posix("listen() failed: \(message)")
        }
        var st = stat()
        lstat(path, &st)

        lock.lock()
        let old = listenFD
        listenFD = fd
        boundInode = st.st_ino
        lock.unlock()
        if old >= 0 { close(old) }

        log.info("listening on \(path)")
        let thread = Thread { [weak self] in self?.acceptLoop(fd: fd) }
        thread.name = "computer-use.accept"
        thread.start()
    }

    private func probeLive(addr: sockaddr_un) -> Bool {
        var addr = addr
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return result == 0
    }

    private func startWatchdog() {
        guard config.socketCheckInterval > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + config.socketCheckInterval, repeating: config.socketCheckInterval)
        timer.setEventHandler { [weak self] in self?.ensureListening() }
        timer.resume()
        watchdog = timer
    }

    /// Stops listening, removes the socket file (if it is still ours) and drops every connection.
    public func stop() {
        lock.lock()
        stopped = true
        let fd = listenFD
        listenFD = -1
        let inode = boundInode
        let open = Array(connections.values)
        lock.unlock()
        watchdog?.cancel()
        watchdog = nil
        if fd >= 0 { close(fd) }
        var st = stat()
        if lstat(config.socketPath, &st) == 0, st.st_ino == inode { unlink(config.socketPath) }
        open.forEach { $0.shutdownNow() }
    }

    private func acceptLoop(fd listener: Int32) {
        while true {
            let clientFD = accept(listener, nil, nil)
            if clientFD < 0 {
                if errno == EINTR || errno == ECONNABORTED { continue }
                return // the listener was closed (stop, or a re-bind replaced it)
            }
            var on: Int32 = 1
            setsockopt(clientFD, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            lock.lock()
            if stopped { lock.unlock(); close(clientFD); return }
            nextConnectionID += 1
            let id = nextConnectionID
            lock.unlock()
            let thread = Thread { [weak self] in self?.serve(fd: clientFD, id: id) }
            thread.name = "computer-use.conn.\(id)"
            thread.start()
        }
    }

    // MARK: - Notifications

    /// Sends a daemon notification to every daemon connection (never to Winter.app).
    public func broadcast(_ notification: HelperNotification) {
        guard let line = RPCOutbound.notification(method: notification.method, params: AnyEncodable(notification.params)) else { return }
        lock.lock()
        let daemons = connections.values.filter { $0.isReady && $0.client == .daemon }
        lock.unlock()
        daemons.forEach { $0.send(line) }
    }

    /// A `view.*` event line for one Winter.app connection.
    public func sendEvent(to id: Int, _ line: Data) {
        appConnection(id)?.send(line)
    }

    /// A `view.frame` line for one Winter.app connection, coalesced per target: if the previous frame for that
    /// target has not been written yet, this one replaces it.
    public func sendFrame(to id: Int, key: String, _ line: Data) {
        appConnection(id)?.sendLatest(key: key, line)
    }

    private func appConnection(_ id: Int) -> Connection? {
        lock.lock(); defer { lock.unlock() }
        guard let connection = connections[id], connection.isReady, connection.client == .app else { return nil }
        return connection
    }

    /// What each client may call after `hello`.
    public static let appMethods: Set<String> = ["status", "view.subscribe", "view.unsubscribe"]

    public static func permits(_ client: PeerClientKind, _ method: String) -> Bool {
        switch client {
        case .app: return appMethods.contains(method)
        // Frames reach only Winter.app clients: the daemon has no business in the view stream.
        case .daemon: return !method.hasPrefix("view.")
        }
    }

    // MARK: - One connection

    private func serve(fd: Int32, id: Int) {
        // Authentication comes first: nothing is read from a peer that is neither the daemon nor Winter.app.
        let decision = authenticator.authorize(socket: fd)
        guard case .accept(let pid, let clients) = decision else {
            if case .reject(let reason) = decision { log.info("connection \(id) refused: \(reason)") }
            close(fd)
            return
        }
        let connection = Connection(id: id, fd: fd, verified: clients)
        lock.lock()
        connections[id] = connection
        lock.unlock()
        log.info("connection \(id) from pid \(pid) (\(clients.map(\.rawValue).sorted().joined(separator: "/")))")

        readLoop(connection)
        teardown(connection)
    }

    private func readLoop(_ connection: Connection) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        var scanFrom = 0
        while true {
            let n = chunk.withUnsafeMutableBytes { read(connection.fd, $0.baseAddress, $0.count) }
            if n < 0, errno == EINTR { continue }
            if n <= 0 { return }
            buffer.append(contentsOf: chunk[0..<n])
            while let newline = buffer[scanFrom...].firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                let keepGoing = line.count > RPCWire.maxRequestLineBytes ? refuseOversize(connection) : handleLine(Data(line), connection)
                buffer.removeSubrange(buffer.startIndex...newline)
                scanFrom = buffer.startIndex
                if !keepGoing { return }
            }
            scanFrom = buffer.endIndex
            if buffer.count > RPCWire.maxRequestLineBytes {
                _ = refuseOversize(connection)
                return
            }
        }
    }

    private func refuseOversize(_ connection: Connection) -> Bool {
        log.error("connection \(connection.id): a request line exceeded 1 MiB — closing")
        connection.send(RPCOutbound.error(id: .null, .invalidParams("a request line is at most 1 MiB")))
        return false
    }

    /// One request line. Returns false to close the connection.
    private func handleLine(_ line: Data, _ connection: Connection) -> Bool {
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { return true }
        switch RPCInbound.parse(line) {
        case .invalid(let id, let error):
            connection.send(RPCOutbound.error(id: id, error))
            return connection.isReady
        case .notification(let method):
            log.info("connection \(connection.id): ignored a notification (\(method)) — notifications only go helper → daemon")
            return true
        case .request(let id, let method, let params):
            guard connection.isReady else { return hello(id: id, method: method, params: params, connection) }
            if method == "hello" {
                connection.send(RPCOutbound.error(id: id, .invalidParams("hello was already answered on this connection")))
                return true
            }
            dispatch(id: id, method: method, params: params, connection)
            return true
        }
    }

    private func hello(id: JSONValue, method: String, params: JSONValue?, _ connection: Connection) -> Bool {
        guard method == "hello" else {
            connection.send(RPCOutbound.error(id: id, .protocolMismatch("the first request must be hello")))
            return false
        }
        let p: HelloParams
        do {
            p = try RPCDispatcher.decode(HelloParams.self, params)
        } catch {
            connection.send(RPCOutbound.error(id: id, RPCError.from(error)))
            return false
        }
        guard p.protocol == RPCWire.protocolVersion else {
            connection.send(RPCOutbound.error(id: id, RPCError(code: "protocol_mismatch",
                message: "this helper speaks protocol \(RPCWire.protocolVersion), not \(p.protocol)",
                data: ["expected": .number(Double(RPCWire.protocolVersion))])))
            return false
        }
        guard let client = PeerClientKind(rawValue: p.client) else {
            connection.send(RPCOutbound.error(id: id, .protocolMismatch("the clients are \"daemon\" and \"app\"")))
            return false
        }
        guard connection.verified.contains(client) else {
            connection.send(RPCOutbound.error(id: id, RPCError(code: "not_allowed",
                message: "this peer's code is not the \(client == .daemon ? "daemon" : "Winter app") it says it is",
                data: ["reason": .string("identity")])))
            return false
        }
        guard HelperIdentity.canonicalPath(p.home) == config.home else {
            connection.send(RPCOutbound.error(id: id, RPCError(code: "home_mismatch",
                message: "this helper serves a different Winter home", data: ["home": .string(config.home)])))
            return false
        }
        connection.markReady(as: client)
        connection.send(RPCOutbound.response(id: id, result: AnyEncodable(
            HelloResult(protocol: RPCWire.protocolVersion, helperVersion: config.helperVersion, pid: getpid()))))
        if client == .daemon {
            DispatchQueue.main.async { [coordinator] in MainActor.assumeIsolated { coordinator.connectionOpened(connection.id) } }
        }
        log.info("connection \(connection.id): hello (\(client.rawValue))")
        return true
    }

    private func dispatch(id: JSONValue, method: String, params: JSONValue?, _ connection: Connection) {
        guard let client = connection.client, HelperServer.permits(client, method) else {
            connection.send(RPCOutbound.error(id: id, RPCError(code: "not_allowed",
                message: "\(method) is not available to this client", data: ["reason": .string("client")])))
            return
        }
        // Ownership is recorded here, on the reader thread, so it always precedes this connection's teardown.
        // Only the daemon owns sessions: Winter.app subscribing to one must neither keep it alive nor end it.
        if client == .daemon, let sessionId = params?["sessionId"]?.stringValue, !sessionId.isEmpty {
            lock.lock()
            sessionOwners[sessionId, default: []].insert(connection.id)
            lock.unlock()
        }
        if inFlight.count(connection: connection.id) >= config.maxInFlightPerConnection {
            connection.send(RPCOutbound.error(id: id, .busy("too many requests in flight on this connection")))
            return
        }
        // `cancel`'s own `callId` names the call to stop, not itself.
        let callId = method == "cancel" ? nil : params?["callId"]?.stringValue
        let request = PendingRequest(id: id, callId: callId) { [weak connection] line in
            connection?.send(line)
        }
        inFlight.add(request, connection: connection.id)
        let task = Task.detached { [dispatcher, inFlight] in
            do {
                let result = try await dispatcher.handle(method: method, params: params,
                                                         context: RequestContext(connectionID: connection.id, client: client))
                request.answer(result: result)
            } catch {
                request.answer(error: RPCError.from(error))
            }
            inFlight.remove(request)
        }
        request.attach(task)
    }

    private func teardown(_ connection: Connection) {
        connection.closeAfterFlush()
        lock.lock()
        connections.removeValue(forKey: connection.id)
        var orphaned: [String] = []
        for (sessionId, owners) in sessionOwners where owners.contains(connection.id) {
            let rest = owners.subtracting([connection.id])
            if rest.isEmpty { orphaned.append(sessionId); sessionOwners.removeValue(forKey: sessionId) } else { sessionOwners[sessionId] = rest }
        }
        lock.unlock()
        let pending = inFlight.cancelAll(connection: connection.id)
        log.info("connection \(connection.id) closed (\(pending.count) in flight, \(orphaned.count) session(s) ended)")
        let id = connection.id
        guard connection.client == .daemon else {
            // Winter.app (or a peer that never said hello): its subscriptions go, nothing else.
            DispatchQueue.main.async { [coordinator] in MainActor.assumeIsolated { coordinator.viewHub.connectionClosed(id) } }
            return
        }
        Task.detached { [dispatcher, coordinator] in
            // Let cancelled work wind down (bounded), so nothing it binds outlives the session's end below.
            await withTaskGroup(of: Void.self) { group in
                group.addTask { for p in pending { await p.finished() } }
                group.addTask { try? await Task.sleep(nanoseconds: 2_000_000_000) }
                await group.next()
                group.cancelAll()
            }
            // The daemon that used these sessions is gone: drop their per-session state, as `session.ended` does.
            for sessionId in orphaned.sorted() {
                _ = try? await dispatcher.handle(method: "session.ended", params: .object(["sessionId": .string(sessionId)]))
            }
            await coordinator.connectionClosed(id)
        }
    }
}

/// One accepted, authenticated connection: its fd, its serial write queue, the client kinds its code verified
/// as, and — once `hello` succeeded — the one it is.
final class Connection: @unchecked Sendable {
    let id: Int
    let fd: Int32
    let verified: Set<PeerClientKind>
    private let writeQueue: DispatchQueue
    private let lock = NSLock()
    private var _client: PeerClientKind?
    private var closed = false
    private var latest: [String: Data] = [:]

    init(id: Int, fd: Int32, verified: Set<PeerClientKind>) {
        self.id = id
        self.fd = fd
        self.verified = verified
        writeQueue = DispatchQueue(label: "computer-use.conn.\(id).write")
    }

    var isReady: Bool {
        lock.lock(); defer { lock.unlock() }
        return _client != nil && !closed
    }

    var client: PeerClientKind? {
        lock.lock(); defer { lock.unlock() }
        return _client
    }

    func markReady(as client: PeerClientKind) {
        lock.lock(); _client = client; lock.unlock()
    }

    /// At most one unwritten line per `key`: a newer one replaces it. A slow reader (a busy Winter.app) gets the
    /// newest frame instead of a queue that grows with every frame it has not read yet.
    func sendLatest(key: String, _ line: Data) {
        lock.lock()
        let scheduled = latest[key] != nil
        latest[key] = line
        lock.unlock()
        guard !scheduled else { return }
        writeQueue.async { [self] in
            lock.lock()
            let next = latest.removeValue(forKey: key)
            let isClosed = closed
            lock.unlock()
            guard !isClosed, let next else { return }
            Connection.writeAll(next, fd: fd)
        }
    }

    func send(_ line: Data) {
        writeQueue.async { [self] in
            lock.lock(); let isClosed = closed; lock.unlock()
            guard !isClosed else { return }
            Connection.writeAll(line, fd: fd)
        }
    }

    /// Everything already queued is written first; then the fd is closed and later sends are dropped.
    func closeAfterFlush() {
        writeQueue.async { [self] in
            lock.lock()
            let wasClosed = closed
            closed = true
            lock.unlock()
            if !wasClosed { close(fd) }
        }
    }

    /// Unblocks the reader (it sees EOF and tears the connection down).
    func shutdownNow() {
        Darwin.shutdown(fd, SHUT_RDWR)
    }

    static func writeAll(_ data: Data, fd: Int32) {
        data.withUnsafeBytes { raw in
            guard var pointer = raw.baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let n = write(fd, pointer, remaining)
                if n < 0 {
                    if errno == EINTR { continue }
                    return
                }
                remaining -= n
                pointer = pointer.advanced(by: n)
            }
        }
    }
}
