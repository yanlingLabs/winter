import Foundation
import Darwin

/// Native-only event storage. Wakeups carry no authority/data; events are polled
/// on the JavaScript thread. Each accepted operation reserves its terminal slot.
public final class NativeEventChannel: @unchecked Sendable {
    public enum Reservation: Sendable { case ordinary, control, shutdown }
    private let lock = NSLock()
    private var nextOperation: UInt64 = 1
    private var sequence: UInt64 = 0
    private var owners: Set<UInt64> = []
    private var controlOwners: Set<UInt64> = []
    private var shutdownOwners: Set<UInt64> = []
    private var terminal: Set<UInt64> = []
    private var queue: [(NativeEvent, Int)] = []
    private var outputBytes = 0
    private var outputEvents = 0
    private let scope: NativeScope
    private let readFD: Int32
    private let writeFD: Int32
    public let operationLimit: Int
    public let outputLimit: Int
    public var eventFD: Int32 { readFD }

    public init(scope: NativeScope, operationLimit: Int = 128, outputLimit: Int = 4 * 1024 * 1024) throws {
        self.scope = scope; self.operationLimit = operationLimit; self.outputLimit = outputLimit
        var fds: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else { throw NativeFailure("event_channel_unavailable", "Cannot create native event wakeup channel") }
        readFD = fds[0]; writeFD = fds[1]
        for fd in fds { _ = fcntl(fd, F_SETFL, O_NONBLOCK); _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        var enabled: Int32 = 1
        _ = setsockopt(writeFD, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
    }
    deinit { Darwin.close(readFD); Darwin.close(writeFD) }

    public func reserve(_ reservation: Reservation = .ordinary) -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        guard nextOperation < UInt64.max else { return nil }
        switch reservation {
        case .ordinary: guard owners.count - controlOwners.count - shutdownOwners.count < operationLimit else { return nil }
        case .control: guard controlOwners.count < 16 else { return nil }
        case .shutdown: guard shutdownOwners.isEmpty else { return nil }
        }
        let id = nextOperation; nextOperation += 1; owners.insert(id)
        if reservation == .control { controlOwners.insert(id) }
        if reservation == .shutdown { shutdownOwners.insert(id) }
        return id
    }
    public func emit(_ id: UInt64, kind: NativeEventKind, status: NativeTerminalStatus? = nil,
                     code: String? = nil, message: String? = nil, bytes: [UInt8]? = nil,
                     exitCode: Int32? = nil, result: [String: String]? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        guard owners.contains(id), !terminal.contains(id) else { throw NativeFailure("terminal_owned", "Operation already terminated or unknown") }
        let size = bytes?.count ?? 0
        let output = kind == .stdout || kind == .stderr
        if output && size == 0 { return }
        guard size <= 16 * 1024, outputBytes + size <= outputLimit, !output || outputEvents < 4096,
              (message?.utf8.count ?? 0) <= 2048,
              result?.count ?? 0 <= 128,
              result?.reduce(0, { $0 + $1.key.utf8.count + $1.value.utf8.count }) ?? 0 <= 64 * 1024 else {
            throw NativeFailure("output_backpressure", "Native output queue is full; execution must cancel visibly")
        }
        if kind == .terminal { terminal.insert(id) }
        sequence += 1
        let event = NativeEvent(scope: scope, operationId: String(id), sequence: sequence, kind: kind,
                                terminalStatus: status, code: code, message: message,
                                dataBase64: bytes.map { Data($0).base64EncodedString() }, exitCode: exitCode, result: result)
        queue.append((event, size)); outputBytes += size
        if output { outputEvents += 1 }
        var wake: UInt8 = 1
        _ = Darwin.write(writeFD, &wake, 1) // EAGAIN means a wakeup is already pending.
    }
    public func pollAllocated(_ allocate: (String) -> UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
        lock.lock(); defer { lock.unlock() }
        guard let (event, size) = queue.first else { return nil }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(event), let pointer = allocate(String(decoding: data, as: UTF8.self)) else { return nil }
        queue.removeFirst(); outputBytes -= size
        if event.kind == .stdout || event.kind == .stderr { outputEvents -= 1 }
        if event.kind == .terminal, let id = UInt64(event.operationId) { owners.remove(id); controlOwners.remove(id); shutdownOwners.remove(id); terminal.remove(id) }
        if queue.isEmpty {
            var buffer = [UInt8](repeating: 0, count: 512)
            while Darwin.read(readFD, &buffer, buffer.count) > 0 {}
        }
        return pointer
    }
    public func pollJSON() -> String? {
        guard let pointer = pollAllocated({ strdup($0) }) else { return nil }
        defer { free(pointer) }; return String(cString: pointer)
    }
    public func counts() -> (operations: Int, outputBytes: Int) {
        lock.lock(); defer { lock.unlock() }; return (owners.count, outputBytes)
    }
}
