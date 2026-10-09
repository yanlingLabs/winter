import Foundation

/// Something the idle timer can cancel.
public protocol IdleCancellable: AnyObject {
    func cancel()
}

/// When the countdown fires. Injected so the timer is tested with a fake clock.
@MainActor public protocol IdleScheduler: AnyObject {
    func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable
}

/// The helper quits after `interval` (10 minutes) continuously idle — no bound target, no mirror and no running
/// script, whether or not the daemon is connected (the coordinator decides what "busy" means and calls
/// `update`). Becoming busy at any point stops the countdown;
/// becoming idle again starts it over from zero. Updates that do not change the state change nothing.
@MainActor public final class IdleQuitTimer {
    public let interval: TimeInterval
    private let scheduler: IdleScheduler
    private let onIdle: @MainActor () -> Void
    private var pending: IdleCancellable?
    private var busy = true

    public init(interval: TimeInterval, scheduler: IdleScheduler, onIdle: @escaping @MainActor () -> Void) {
        self.interval = interval
        self.scheduler = scheduler
        self.onIdle = onIdle
    }

    public var isCountingDown: Bool { pending != nil }

    public func update(busy nowBusy: Bool) {
        if nowBusy {
            busy = true
            pending?.cancel()
            pending = nil
            return
        }
        guard busy || pending == nil else { return }
        busy = false
        pending?.cancel()
        pending = scheduler.schedule(after: interval) { [weak self] in
            guard let self, !self.busy else { return }
            self.pending = nil
            self.onIdle()
        }
    }
}

/// The real clock: one-shot main-queue timers WITH leeway, so the system can fire them together with other
/// wake-ups instead of waking the CPU for each (a plain `asyncAfter` has none: every hub timer, the idle quit and
/// the off-screen stills each woke it on their own).
@MainActor public final class MainQueueIdleScheduler: IdleScheduler {
    private final class Item: IdleCancellable {
        let source: DispatchSourceTimer
        init(_ source: DispatchSourceTimer) { self.source = source }
        func cancel() { source.cancel() }
    }

    public init() {}

    /// A fifth of the delay, at most 5 s: a 1 s poll may slip 0.2 s, the 10-minute idle quit 5 s.
    public nonisolated static func leeway(for seconds: TimeInterval) -> DispatchTimeInterval {
        .milliseconds(Int((min(5, max(0.01, seconds * 0.2)) * 1000).rounded()))
    }

    public func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable {
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + max(0, seconds), leeway: Self.leeway(for: seconds))
        source.setEventHandler { [source] in
            // One-shot: the cancel also releases this handler (and the source it holds).
            source.cancel()
            MainActor.assumeIsolated { fire() }
        }
        source.resume()
        return Item(source)
    }
}
