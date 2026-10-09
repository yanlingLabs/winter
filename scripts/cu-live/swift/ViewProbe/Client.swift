import Darwin
import Foundation

// The socket half of cu-live-viewprobe: connect, hello, subscribe, then print what arrives.

/// Exit codes the rig's runner relies on.
enum ProbeExit {
    static let clean: Int32 = 0
    static let failed: Int32 = 2
    static let closedByPeer: Int32 = 3
}

/// Dispatch sources must outlive `run()`'s scope.
private var signalSources: [DispatchSourceSignal] = []

final class ProbeClient: @unchecked Sendable {
    private let options: ProbeOptions
    private var fd: Int32 = -1
    private let lock = NSLock() // serialises socket writes and stdout lines (several threads print)
    private var subscribed = false
    private var shuttingDown = false

    init(options: ProbeOptions) {
        self.options = options
    }

    // MARK: Output

    private func print(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        var bytes = Array((line + "\n").utf8)
        var offset = 0
        while offset < bytes.count {
            let n = bytes.withUnsafeMutableBufferPointer { write(STDOUT_FILENO, $0.baseAddress! + offset, $0.count - offset) }
            if n < 0 {
                if errno == EINTR { continue }
                exit(ProbeExit.clean) // the reader went away: nothing left to report to
            }
            offset += n
        }
    }

    private func fail(_ message: String, code: Int32 = ProbeExit.failed) -> Never {
        print(ProbeProtocol.errorLine(message))
        exit(code)
    }

    private func send(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard fd >= 0 else { return }
        var offset = 0
        data.withUnsafeBytes { raw in
            while offset < data.count {
                let n = write(fd, raw.baseAddress! + offset, data.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    return
                }
                offset += n
            }
        }
    }

    // MARK: Connect

    /// The helper refuses to bind a path longer than sockaddr_un holds, so there would be nothing to connect to.
    static func socketPathProblem(_ path: String) -> String? {
        let capacity = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        let length = path.utf8.count
        return length < capacity ? nil : "socket path is \(length) bytes; sockaddr_un holds at most \(capacity - 1)"
    }

    private func connectSocket() -> String? {
        if let problem = Self.socketPathProblem(options.socket) { return problem }
        var address = sockaddr_un()
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        let path = Array(options.socket.utf8)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for index in 0..<capacity { raw[index] = 0 }
            for (index, byte) in path.enumerated() { raw[index] = byte }
        }
        let socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else { return "socket() failed: \(String(cString: strerror(errno)))" }
        var on: Int32 = 1
        setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard result == 0 else {
            let reason = String(cString: strerror(errno))
            close(socketFD)
            return "cannot connect to \(options.socket): \(reason)"
        }
        fd = socketFD
        return nil
    }

    // MARK: Shutdown

    /// Unsubscribes, gives the helper a moment to process it, and exits 0. Safe to call from any thread, once.
    private func shutdown() {
        lock.lock()
        let already = shuttingDown
        shuttingDown = true
        let wasSubscribed = subscribed
        lock.unlock()
        guard !already else { return }
        if wasSubscribed { send(ProbeProtocol.unsubscribe(session: options.session)) }
        usleep(200_000)
        exit(ProbeExit.clean)
    }

    private func installStopTriggers() {
        // SIGTERM/SIGINT on a global queue: the main thread is blocked reading the socket.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [weak self] in self?.shutdown() }
            source.resume()
            signalSources.append(source)
        }
        // stdin EOF is the normal stop signal from the runner.
        let watcher = Thread { [weak self] in
            var buffer = [UInt8](repeating: 0, count: 256)
            while true {
                let n = read(STDIN_FILENO, &buffer, buffer.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { break }
            }
            self?.shutdown()
        }
        watcher.name = "cu-live-viewprobe.stdin"
        watcher.start()
    }

    // MARK: Run

    /// Blocks reading the socket; only ever exits the process.
    func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        if let problem = connectSocket() { fail(problem) }
        installStopTriggers()
        send(ProbeProtocol.hello(home: options.home))

        var pending = Data()
        var chunk = [UInt8](repeating: 0, count: 256 * 1024)
        var helloAnswered = false
        let maxLine = 64 << 20 // far above the helper's own 16 MiB response cap
        while true {
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0, errno == EINTR { continue }
            if n <= 0 {
                lock.lock(); let stopping = shuttingDown; lock.unlock()
                if stopping { exit(ProbeExit.clean) }
                fail(helloAnswered
                     ? "the helper closed the connection"
                     : "the helper closed the connection before answering hello (it checks the peer's code signature first: "
                       + "the probe must be signed with Winter's team and identifier com.winter.app.dev)",
                     code: ProbeExit.closedByPeer)
            }
            pending.append(contentsOf: chunk[0..<n])
            while let newline = pending.firstIndex(of: 0x0A) {
                let line = Data(pending[pending.startIndex..<newline])
                pending.removeSubrange(pending.startIndex...newline)
                if !line.isEmpty { handle(line, helloAnswered: &helloAnswered) }
            }
            if pending.count > maxLine { fail("a line from the helper exceeded \(maxLine) bytes") }
        }
    }

    private func handle(_ line: Data, helloAnswered: inout Bool) {
        switch ProbeProtocol.decode(line) {
        case .failure(let id, let message):
            switch id {
            case ProbeProtocol.helloId: fail("hello rejected — \(message)")
            case ProbeProtocol.subscribeId: fail("view.subscribe rejected — \(message)")
            default: break // an unsubscribe answer, or a stray one
            }
        case .result(let id, let result):
            if id == ProbeProtocol.helloId {
                helloAnswered = true
                send(ProbeProtocol.subscribe(session: options.session, maxFps: options.maxFps, maxWidth: options.maxWidth))
            } else if id == ProbeProtocol.subscribeId {
                lock.lock(); subscribed = true; lock.unlock()
                print(ProbeProtocol.subscribedLine(targets: (result["targets"] as? [Any]) ?? []))
            }
        case .notification(let method, let params):
            if let text = ProbeProtocol.eventLine(method: method, params: params) { print(text) }
        case .ignored:
            break
        }
    }
}
