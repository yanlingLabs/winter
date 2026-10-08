import ApplicationServices
import Foundation

/// Watches bound apps through `AXObserver` and records when each pid last emitted an AX notification — the
/// settle loop's main signal (spec §7). Observers live on one dedicated run-loop thread, so no AX callback
/// ever runs on the main thread. Destroyed-element notifications also wake the target-lost check.
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

    private let clock: CUClock
    private let lock = NSLock()
    private var last: [pid_t: Double] = [:]
    private var observers: [pid_t: AXObserver] = [:]
    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)
    /// Called (off the main thread) when an element of `pid` is destroyed.
    var onDestroyed: (@Sendable (pid_t) -> Void)?

    init(clock: CUClock) {
        self.clock = clock
    }

    func lastNotificationMs(pid: pid_t) -> Double? {
        lock.lock(); defer { lock.unlock() }
        return last[pid]
    }

    /// Records activity the helper caused itself is NOT done here: the action time is passed to the settler.
    fileprivate func record(pid: pid_t, notification: String) {
        let t = clock.nowMs()
        lock.lock()
        last[pid] = t
        lock.unlock()
        if notification == kAXUIElementDestroyedNotification { onDestroyed?(pid) }
    }

    /// Starts observing `pid` (idempotent). Returns false when the observer could not be created
    /// (no Accessibility grant, or the app is gone).
    @discardableResult
    func watch(pid: pid_t) -> Bool {
        lock.lock()
        if observers[pid] != nil { lock.unlock(); return true }
        lock.unlock()
        guard let rl = ensureThread() else { return false }
        var observer: AXObserver?
        let err = AXObserverCreate(pid, cuAXObserverCallback, &observer)
        guard err == .success, let observer else { return false }
        let app = AX.app(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var added = 0
        for n in Self.notifications where AXObserverAddNotification(observer, app, n as CFString, refcon) == .success {
            added += 1
        }
        guard added > 0 else { return false }
        CFRunLoopAddSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
        CFRunLoopWakeUp(rl)
        lock.lock()
        observers[pid] = observer
        lock.unlock()
        return true
    }

    func unwatch(pid: pid_t) {
        lock.lock()
        let observer = observers.removeValue(forKey: pid)
        last[pid] = nil
        let rl = runLoop
        lock.unlock()
        if let observer, let rl {
            CFRunLoopRemoveSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
        }
    }

    private func ensureThread() -> CFRunLoop? {
        lock.lock()
        if let rl = runLoop { lock.unlock(); return rl }
        lock.unlock()
        let t = Thread { [weak self] in
            guard let self else { return }
            let rl = CFRunLoopGetCurrent()!
            // A port keeps the run loop alive while no observer is attached yet.
            let port = Port()
            RunLoop.current.add(port, forMode: .default)
            self.lock.lock()
            self.runLoop = rl
            self.lock.unlock()
            self.ready.signal()
            while true { CFRunLoopRunInMode(.defaultMode, 3600, false) }
        }
        t.name = "WinterCUCore.ax-observers"
        t.qualityOfService = .userInitiated
        lock.lock()
        let started = thread != nil
        if !started { thread = t }
        lock.unlock()
        if !started { t.start() }
        _ = ready.wait(timeout: .now() + 2)
        ready.signal()  // let any other waiter through too
        lock.lock(); defer { lock.unlock() }
        return runLoop
    }
}

private func cuAXObserverCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString,
                                  _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    let monitor = Unmanaged<CUAXActivityMonitor>.fromOpaque(refcon).takeUnretainedValue()
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return }
    monitor.record(pid: pid, notification: notification as String)
}
