import Foundation
import Darwin

/// Reservations include both in-flight and unconsumed terminal events, so a
/// slow consumer cannot silently lose completion/error events.
public final class EventQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var nextID: UInt64 = 1
    private var outstanding = 0
    private var events: [String] = []
    public let limit: Int
    public init(limit: Int = 128) { self.limit = limit }
    public func reserve() -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        guard outstanding < limit, nextID < UInt64.max else { return nil }
        let id = nextID; nextID += 1; outstanding += 1
        return id
    }
    public func finish(_ event: String) {
        lock.lock(); defer { lock.unlock() }
        events.append(event)
    }
    public func poll() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !events.isEmpty else { return nil }
        outstanding -= 1
        return events.removeFirst()
    }
    public func pollAllocated(_ allocate: (String) -> UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
        lock.lock(); defer { lock.unlock() }
        guard let event = events.first, let value = allocate(event) else { return nil }
        events.removeFirst()
        outstanding -= 1
        return value
    }
}
