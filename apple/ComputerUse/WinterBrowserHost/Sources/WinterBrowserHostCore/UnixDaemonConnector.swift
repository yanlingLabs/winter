import Darwin
import Foundation

/// The real `DaemonConnecting`: a Unix socket to `<home>/run/browser.sock`, verified BEFORE anything is written, then a
/// reader thread that splits the daemon's NDJSON (1 MiB per line at most) and hands each line to the relay's queue.
public final class UnixDaemonConnector: DaemonConnecting {
    private let socketPath: String
    private let requirement: String
    private let verification: DaemonVerification
    private let queue: DispatchQueue

    public init(socketPath: String, requirement: String, verification: DaemonVerification = .codeSigning, queue: DispatchQueue) {
        self.socketPath = socketPath
        self.requirement = requirement
        self.verification = verification
        self.queue = queue
    }

    public func connect(onLine: @escaping (Data) -> Void, onClose: @escaping () -> Void) -> DaemonConnectResult {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return .unavailable("socket(): \(String(cString: strerror(errno)))") }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else {
            Darwin.close(fd)
            return .unavailable("the socket path is too long")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: pathBytes)
            raw[pathBytes.count] = 0
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else {
            let why = String(cString: strerror(errno))
            Darwin.close(fd)
            return .unavailable(why)
        }
        if let refusal = verification.refusal(socket: fd, requirement: requirement) {
            Darwin.close(fd)
            return .unverified(refusal)
        }
        let link = UnixDaemonLink(fd: fd)
        let queue = self.queue
        let thread = Thread {
            var decoder = LineDecoder()
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            readLoop: while true {
                let n = read(fd, &buffer, buffer.count)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                do {
                    for line in try decoder.push(Data(buffer[0 ..< n])) {
                        queue.async { onLine(line) }
                    }
                } catch {
                    break readLoop
                }
            }
            link.finish()
            queue.async { onClose() }
        }
        thread.name = "winter-browser-host.daemon-reader"
        thread.start()
        return .connected(link)
    }
}

final class UnixDaemonLink: DaemonLink {
    private let fd: Int32
    private let lock = NSLock()
    private var open = true

    init(fd: Int32) {
        self.fd = fd
    }

    func send(_ line: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard open else { return false }
        return line.withUnsafeBytes { raw -> Bool in
            guard var p = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = write(fd, p, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                left -= n
                p = p.advanced(by: n)
            }
            return true
        }
    }

    /// Ends the connection; the reader thread wakes, closes the descriptor and reports the close.
    func close() {
        lock.lock()
        defer { lock.unlock() }
        if open { shutdown(fd, SHUT_RDWR) }
    }

    /// The reader thread is done with the descriptor.
    func finish() {
        lock.lock()
        defer { lock.unlock() }
        guard open else { return }
        open = false
        Darwin.close(fd)
    }
}

/// `RelayScheduler` on a dispatch queue.
public struct QueueScheduler: RelayScheduler {
    let queue: DispatchQueue
    public init(queue: DispatchQueue) { self.queue = queue }
    public func after(_ seconds: TimeInterval, _ block: @escaping () -> Void) {
        queue.asyncAfter(deadline: .now() + seconds, execute: block)
    }
}
