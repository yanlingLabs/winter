import Foundation

/// A monotonic millisecond clock plus a sleep, injectable so the settle and wait loops run against a fake
/// clock in tests.
public protocol CUClock: Sendable {
    func nowMs() -> Double
    func sleep(ms: Double) async throws
    /// A short blocking pause on the calling thread (the engine's polls and settles). A simulated clock advances
    /// instead of sleeping, so the whole engine can run in simulated time (the guardian's model-based test).
    func pause(ms: Double)
}

public extension CUClock {
    /// Monotonic seconds (for the focus guardian's windows).
    func nowSeconds() -> Double { nowMs() / 1000 }
    func pause(ms: Double) { if ms > 0 { usleep(useconds_t(ms * 1000)) } }
}

public struct CUSystemClock: CUClock {
    public init() {}
    public func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
    public func sleep(ms: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, ms) * 1_000_000))
    }
}

/// The UI-quiet decision (spec §7), with no I/O:
/// - settled once `quietMs` have passed with no activity AND the `floorMs` minimum has elapsed;
/// - timed out once `timeoutMs` have passed without that.
/// Activity is any AX notification from the target pid, or a change in its window list (a new sheet,
/// dialog or menu). The caller feeds it activity timestamps and asks for a verdict.
public struct CUSettleMachine: Sendable, Equatable {
    public enum Verdict: Sendable, Equatable {
        /// Keep waiting; check again after at most `checkInMs`.
        case waiting(checkInMs: Double)
        case settled(waitedMs: Int)
        case timedOut(waitedMs: Int)
    }

    public let startedAt: Double
    public let quietMs: Double
    public let timeoutMs: Double
    public let floorMs: Double
    public private(set) var lastActivityAt: Double
    public private(set) var activityCount = 0

    /// `lastActivityAt` is the newest activity known before the wait began — the last AX notification or the
    /// action that prompted the wait — so a burst that started just before still has to die down. With none
    /// known, the wait itself is the baseline and a full `quietMs` must pass.
    public init(startedAt: Double, quietMs: Double, timeoutMs: Double, floorMs: Double = 30,
                lastActivityAt: Double? = nil) {
        self.startedAt = startedAt
        self.quietMs = max(0, quietMs)
        self.timeoutMs = max(0, timeoutMs)
        self.floorMs = max(0, floorMs)
        self.lastActivityAt = lastActivityAt ?? startedAt
    }

    public mutating func activity(at t: Double) {
        if t > lastActivityAt { lastActivityAt = t }
        activityCount += 1
    }

    public func evaluate(now: Double) -> Verdict {
        let elapsed = now - startedAt
        let quietFor = now - lastActivityAt
        if elapsed >= floorMs, quietFor >= quietMs { return .settled(waitedMs: Int(elapsed.rounded())) }
        if elapsed >= timeoutMs { return .timedOut(waitedMs: Int(elapsed.rounded())) }
        let untilQuiet = quietMs - quietFor
        let untilFloor = floorMs - elapsed
        let untilTimeout = timeoutMs - elapsed
        return .waiting(checkInMs: max(1, min(max(untilQuiet, untilFloor), untilTimeout)))
    }
}

/// What the settle loop polls: the newest activity timestamp for a pid (AX notifications) and a signature
/// of its window list. Live: `CUAXActivityMonitor` + the window server; tests: a scripted fake.
public protocol CUActivitySource: Sendable {
    /// Clock time (same clock as the loop) of the latest AX notification from `pid`, nil if none yet.
    func lastNotificationMs(pid: pid_t) -> Double?
    /// Changes whenever the pid's window list changes (windows, sheets, menus).
    func windowSignature(pid: pid_t) -> Int
}

/// Runs a settle machine against an activity source until it settles or times out.
public struct CUSettler: Sendable {
    public let clock: CUClock
    public let source: CUActivitySource
    /// Upper bound on one sleep, so window-list changes are noticed promptly.
    public var pollMs: Double = 25

    public init(clock: CUClock, source: CUActivitySource, pollMs: Double = 25) {
        self.clock = clock
        self.source = source
        self.pollMs = pollMs
    }

    public struct Outcome: Sendable, Equatable {
        public var settled: Bool
        public var waitedMs: Int
        /// "quiet" | "cap" (spec §7's telemetry exit reasons; "condition" belongs to waitFor).
        public var exit: String
    }

    /// `lastActionMs`: when the helper last acted on this target — it counts as activity, so a wait that starts
    /// right after an action cannot settle before the app has had `quietMs` to react.
    public func waitIdle(pid: pid_t, quietMs: Double, timeoutMs: Double, floorMs: Double = 30,
                         lastActionMs: Double? = nil,
                         isCancelled: @Sendable () -> Bool = { false }) async throws -> Outcome {
        let start = clock.nowMs()
        var lastNotification = source.lastNotificationMs(pid: pid)
        let known = [lastNotification, lastActionMs].compactMap { $0 }.max()
        var machine = CUSettleMachine(startedAt: start, quietMs: quietMs, timeoutMs: timeoutMs, floorMs: floorMs,
                                      lastActivityAt: known)
        var signature = source.windowSignature(pid: pid)
        while true {
            if isCancelled() || Task.isCancelled { throw CUError.cancelled }
            let now = clock.nowMs()
            if let n = source.lastNotificationMs(pid: pid), n != lastNotification {
                lastNotification = n
                machine.activity(at: n)
            }
            let sig = source.windowSignature(pid: pid)
            if sig != signature {
                signature = sig
                machine.activity(at: now)
            }
            switch machine.evaluate(now: now) {
            case .settled(let w): return Outcome(settled: true, waitedMs: w, exit: "quiet")
            case .timedOut(let w): return Outcome(settled: false, waitedMs: w, exit: "cap")
            case .waiting(let checkIn): try await clock.sleep(ms: min(checkIn, pollMs))
            }
        }
    }
}
