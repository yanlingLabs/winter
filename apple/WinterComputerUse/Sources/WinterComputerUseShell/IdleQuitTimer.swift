import Foundation

/// Something the idle timer can cancel.
public protocol IdleCancellable: AnyObject {
    func cancel()
}

/// When the countdown fires. Injected so the timer is tested with a fake clock.
@MainActor public protocol IdleScheduler: AnyObject {
    func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable
}

/// The helper quits after `interval` (10 minutes) continuously idle — no connection and no bound target (the
/// coordinator decides what "busy" means and calls `update`). Becoming busy at any point stops the countdown;
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

/// The real clock: the main queue.
@MainActor public final class MainQueueIdleScheduler: IdleScheduler {
    private final class Item: IdleCancellable {
        let work: DispatchWorkItem
        init(_ work: DispatchWorkItem) { self.work = work }
        func cancel() { work.cancel() }
    }

    public init() {}

    public func schedule(after seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> IdleCancellable {
        let work = DispatchWorkItem { MainActor.assumeIsolated { fire() } }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        return Item(work)
    }
}
