import ApplicationServices
import Foundation

/// Watches bound apps through `AXObserver` and records when each pid last emitted an AX notification — the
/// settle loop's main signal (spec §7) — and, separately, its last value change (evidence that a typed or
/// pasted edit landed). Observers live on one dedicated run-loop thread, so no AX callback ever runs on the
/// main thread. Destroyed-element notifications also wake the target-lost check.
final class CUAXActivityMonitor: @unchecked Sendable {
    static let notifications: [String] = [
        kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXValueChangedNotification,
        kAXUIElementDestroyedNotification, kAXCreatedNotification, kAXLayoutChangedNotification,
        kAXSelectedChildrenChangedNotification, kAXSelectedTextChangedNotification, kAXTitleChangedNotification,
        kAXWindowCreatedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
        kAXWindowMiniaturizedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification,
        kAXSheetCreatedNotification, kAXRowCountChangedNotification, kAXSelectedRowsChangedNotification,
        kAXResizedNotification, kAXMovedNotification, kAXAnnouncementRequestedNotification,
    ]
    static let valueNotifications: Set<String> = [kAXValueChangedNotification, kAXSelectedTextChangedNotification]

    /// The observer thread's run loop, shared without retaining the monitor (the thread runs forever).
    private final class RunLoopBox: @unchecked Sendable {
        let lock = NSLock()
        var runLoop: CFRunLoop?
        let ready = DispatchSemaphore(value: 0)
        var started = false
    }

    private let clock: CUClock
    private let lock = NSLock()
    private var last: [pid_t: Double] = [:]
    private var lastValue: [pid_t: Double] = [:]
    private var observers: [pid_t: AXObserver] = [:]
    private let box = RunLoopBox()
    /// Called (off the main thread) when an element of `pid` is destroyed.
    var onDestroyed: (@Sendable (pid_t) -> Void)?
    /// Called (off the main thread) with a new window's element: remembered, so the window stays reachable after
    /// it leaves this Space (an AppKit window has no AX element on another Space unless one was vended here).
    var onWindowCreated: (@Sendable (pid_t, AXUIElement) -> Void)?

    init(clock: CUClock) {
        self.clock = clock
    }

    /// The observers carry an unretained pointer to the monitor, so their sources go before it does.
    deinit {
        let all = lock.withLock { Array(observers.values) }
        if let rl = box.lock.withLock({ box.runLoop }) {
            for o in all { CFRunLoopRemoveSource(rl, AXObserverGetRunLoopSource(o), .defaultMode) }
        }
    }

    func lastNotificationMs(pid: pid_t) -> Double? {
        lock.withLock { last[pid] }
    }

    func lastValueChangeMs(pid: pid_t) -> Double? {
        lock.withLock { lastValue[pid] }
    }

    fileprivate func windowCreated(pid: pid_t, element: AXUIElement) { onWindowCreated?(pid, element) }

    fileprivate func record(pid: pid_t, notification: String) {
        let t = clock.nowMs()
        lock.withLock {
            last[pid] = t
            if Self.valueNotifications.contains(notification) { lastValue[pid] = t }
        }
        if notification == kAXUIElementDestroyedNotification { onDestroyed?(pid) }
    }

    /// Starts observing `pid` (idempotent, race-free: a concurrent second caller's observer is dropped).
    /// Returns false when the observer could not be created (no Accessibility grant, or the app is gone).
    @discardableResult
    func watch(pid: pid_t) -> Bool {
        if lock.withLock({ observers[pid] != nil }) { return true }
        guard let rl = ensureThread() else { return false }
        var observer: AXObserver?
        guard AXObserverCreate(pid, cuAXObserverCallback, &observer) == .success, let observer else { return false }
        let app = AX.app(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var added = 0
        for n in Self.notifications where AXObserverAddNotification(observer, app, n as CFString, refcon) == .success {
            added += 1
        }
        guard added > 0 else { return false }
        // Re-check under the lock: if another caller won, drop this observer before its source is scheduled.
        let won: Bool = lock.withLock {
            if observers[pid] != nil { return false }
            observers[pid] = observer
            return true
        }
        guard won else { return true }
        CFRunLoopAddSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
        CFRunLoopWakeUp(rl)
        return true
    }

    func unwatch(pid: pid_t) {
        let observer: AXObserver? = lock.withLock {
            last[pid] = nil
            lastValue[pid] = nil
            return observers.removeValue(forKey: pid)
        }
        if let observer, let rl = box.lock.withLock({ box.runLoop }) {
            CFRunLoopRemoveSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
        }
    }

    private func ensureThread() -> CFRunLoop? {
        let box = self.box
        let start: Bool = box.lock.withLock {
            if box.started { return false }
            box.started = true
            return true
        }
        if start {
            // The thread captures only the box, never the monitor.
            let t = Thread {
                let rl = CFRunLoopGetCurrent()!
                // A port keeps the run loop alive while no observer is attached yet.
                RunLoop.current.add(Port(), forMode: .default)
                box.lock.withLock { box.runLoop = rl }
                box.ready.signal()
                while true { CFRunLoopRunInMode(.defaultMode, 3600, false) }
            }
            t.name = "WinterCUCore.ax-observers"
            t.qualityOfService = .userInitiated
            t.start()
        }
        if let rl = box.lock.withLock({ box.runLoop }) { return rl }
        _ = box.ready.wait(timeout: .now() + 2)
        box.ready.signal()  // let any other first-time waiter through too
        return box.lock.withLock { box.runLoop }
    }
}

private func cuAXObserverCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString,
                                  _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    let monitor = Unmanaged<CUAXActivityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return }
    if (notification as String) == kAXWindowCreatedNotification { monitor.windowCreated(pid: pid, element: element) }
    monitor.record(pid: pid, notification: notification as String)
}
