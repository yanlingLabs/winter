import Foundation
import IOKit
import IOKit.pwr_mgt

/// What the launcher does with one system power message. A pure function of the message number, so the decision is tested
/// without ever sleeping a machine.
public struct PowerMessageAction: Equatable, Sendable {
    /// Acknowledge the change (`IOAllowPowerChange`). Always true for the messages that ask: the launcher never vetoes a sleep and
    /// never delays one beyond the time it takes to run this decision.
    public let acknowledge: Bool
    public let report: PowerEvent?
}

public enum PowerMessages {
    // iokit_common_msg(x) = 0xE0000000 | x. The macros are function-like, so Swift cannot import them; the numbers are IOMessage.h's.
    public static let canSystemSleep: UInt32 = 0xE000_0270
    public static let systemWillSleep: UInt32 = 0xE000_0280
    public static let systemWillNotSleep: UInt32 = 0xE000_0290
    public static let systemHasPoweredOn: UInt32 = 0xE000_0300
    public static let systemWillPowerOn: UInt32 = 0xE000_0320

    public static func action(for messageType: UInt32) -> PowerMessageAction? {
        switch messageType {
        // "Can the system sleep?" is a question about idle sleep. The answer is always yes: the launcher holds no assertion and vetoes nothing.
        case canSystemSleep: return PowerMessageAction(acknowledge: true, report: nil)
        // The quiesce point. Reported, then acknowledged at once.
        case systemWillSleep: return PowerMessageAction(acknowledge: true, report: .willSleep)
        // The machine is awake again.
        case systemHasPoweredOn: return PowerMessageAction(acknowledge: false, report: .didWake)
        default: return nil
        }
    }
}

/// Quiesce and wake notifications from `IORegisterForSystemPower`. It OBSERVES: there is no `IOPMAssertion*` anywhere in this
/// package (a test pins that), so the launcher never keeps the machine awake and never blocks a sleep.
public final class PowerObserver {
    public typealias Handler = @Sendable (PowerEvent) -> Void
    private var notificationPort: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private var rootPort: io_connect_t = 0
    private let queue: DispatchQueue
    private let handler: Handler
    private var started = false

    public init(queue: DispatchQueue, handler: @escaping Handler) { self.queue = queue; self.handler = handler }

    public enum Failure: Error { case registrationFailed }

    public func start() throws {
        guard !started else { return }
        let callback: IOServiceInterestCallback = { refcon, _, messageType, argument in
            guard let refcon else { return }
            Unmanaged<PowerObserver>.fromOpaque(refcon).takeUnretainedValue().receive(messageType, argument: argument)
        }
        var port: IONotificationPortRef?
        let connection = IORegisterForSystemPower(Unmanaged.passUnretained(self).toOpaque(), &port, callback, &notifier)
        guard connection != 0, let port else { throw Failure.registrationFailed }
        rootPort = connection; notificationPort = port
        IONotificationPortSetDispatchQueue(port, queue)
        started = true
    }

    private func receive(_ messageType: UInt32, argument: UnsafeMutableRawPointer?) {
        guard let action = PowerMessages.action(for: messageType) else { return }
        // Report first (the quiesce point), THEN let the system go: the handler is synchronous work on the session queue.
        if let event = action.report { handler(event) }
        if action.acknowledge { IOAllowPowerChange(rootPort, Int(bitPattern: argument)) }
    }

    public func stop() {
        guard started else { return }
        started = false
        IODeregisterForSystemPower(&notifier)
        IOServiceClose(rootPort)
        if let notificationPort { IONotificationPortDestroy(notificationPort) }
        notificationPort = nil; rootPort = 0
    }
    deinit { stop() }
}

/// The only `PowerReporting` in this slice: a bounded record. The contract has no line for power events yet, so nothing is sent
/// upward; the record exists so a later contract revision (and the tests) can see what the launcher observed.
public final class PowerLedger: PowerReporting, @unchecked Sendable {
    public struct Entry: Equatable, Sendable { public let event: PowerEvent; public let atMs: Int64 }
    private let lock = NSLock()
    private var entries: [Entry] = []
    private let capacity: Int
    private let clock: @Sendable () -> Int64
    public init(capacity: Int = 64, clock: @escaping @Sendable () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }) { self.capacity = capacity; self.clock = clock }
    public func report(_ event: PowerEvent) {
        lock.lock(); defer { lock.unlock() }
        entries.append(Entry(event: event, atMs: clock()))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
    }
    public var recorded: [Entry] { lock.lock(); defer { lock.unlock() }; return entries }
}
