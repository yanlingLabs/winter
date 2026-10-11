import CoreGraphics
import Foundation

/// The keyboard reroute that guards the focus blip (`CUCore+Blip`): while the bound window holds the window
/// server's key focus for a moment, the user's own key events — addressed to the target, since it has the key
/// focus — are posted to the user's app instead and dropped from the target, so nothing the user types is lost
/// or lands in the agent's app. The helper's own events (stamped `CUEventStamp`) pass. It counts what it
/// rerouted, never what was typed.

/// Installs the reroute's keyboard tap. The live one is a HEAD tap on the target pid for key down, key up and
/// flags changed; tests use a fake.
public protocol CUKeyTapInstalling: AnyObject {
    /// A head tap on `pid` for event types 10, 11 and 12. Each event goes to `handle`, whose nil drops it.
    /// Returns the tap's removal (safe to call more than once), or nil when no tap could be made.
    func installKeyTap(pid: pid_t, handle: @escaping (CGEvent) -> CGEvent?) -> (() -> Void)?
}

/// One reroute: installed just before the blip, removed when the user's app has the key focus again (or at the
/// blip's deadline).
final class CUKeyReroute {
    let target: pid_t
    let victim: pid_t
    private let installer: CUKeyTapInstalling
    private let post: (CGEvent, pid_t) -> Void
    private let lock = NSLock()
    private var remove: (() -> Void)?
    private var _rerouted = 0
    private var _passed = 0

    /// True while the user's keys reaching the target are THEIRS to keep there — the target is their front app (they
    /// switched into it): passed through, never posted to the app they left.
    private let passThrough: () -> Bool
    private var _passedThrough = 0

    init(target: pid_t, victim: pid_t, installer: CUKeyTapInstalling, post: @escaping (CGEvent, pid_t) -> Void,
         passThrough: @escaping () -> Bool = { false }) {
        self.target = target
        self.victim = victim
        self.installer = installer
        self.post = post
        self.passThrough = passThrough
    }

    /// Installs the tap; false when it could not be made (the blip then does not run).
    func begin() -> Bool {
        guard let r = installer.installKeyTap(pid: target, handle: { [weak self] e in self.map { $0.handle(e) } ?? e }) else {
            return false
        }
        lock.withLock { remove = r }
        return true
    }

    /// What the tap does with one key event: the helper's own passes; anything else (the user's) is posted to
    /// the user's app and dropped from the target.
    func handle(_ event: CGEvent) -> CGEvent? {
        if CUEventStamp.isOurs(event.getIntegerValueField(.eventSourceUserData)) {
            lock.withLock { _passed += 1 }
            return event
        }
        if passThrough() {
            lock.withLock { _passedThrough += 1 }
            return event
        }
        if let copy = event.copy() { post(copy, victim) }
        lock.withLock { _rerouted += 1 }
        return nil
    }

    /// Removes the tap (once). Returns how many events it rerouted.
    @discardableResult
    func end() -> Int {
        let (r, n) = lock.withLock { () -> ((() -> Void)?, Int) in
            let r = remove
            remove = nil
            return (r, _rerouted)
        }
        r?()
        return n
    }

    var isInstalled: Bool { lock.withLock { remove != nil } }
    var rerouted: Int { lock.withLock { _rerouted } }
    var passed: Int { lock.withLock { _passed } }
    var passedThrough: Int { lock.withLock { _passedThrough } }
}

/// No tap (test cores): the blip never runs.
final class CUNoKeyTapInstaller: CUKeyTapInstalling {
    func installKeyTap(pid: pid_t, handle: @escaping (CGEvent) -> CGEvent?) -> (() -> Void)? { nil }
}

/// The live tap: `CGEvent.tapCreateForPid` at the head, on its own run-loop thread (the act's queue runs no
/// run loop). The removal disables and invalidates it and stops the thread, which frees the context last.
public final class CULiveKeyTapInstaller: CUKeyTapInstalling {
    public init() {}

    public func installKeyTap(pid: pid_t, handle: @escaping (CGEvent) -> CGEvent?) -> (() -> Void)? {
        let box = CUKeyTapBox(handle: handle)
        let refcon = Unmanaged.passRetained(box).toOpaque()
        guard let port = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .defaultTap,
                                                 eventsOfInterest: CUFocusTaps.mask(CUFocusTaps.keyboardTypes),
                                                 callback: keyRerouteTapCallback, userInfo: refcon) else {
            Unmanaged<CUKeyTapBox>.fromOpaque(refcon).release()
            return nil
        }
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
            box.setRunLoop(CFRunLoopGetCurrent())
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            ready.signal()
            while !Thread.current.isCancelled, CFRunLoopRunInMode(.defaultMode, 0.05, false) != .stopped {}
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
            // The callback can no longer run: free its context.
            Unmanaged<CUKeyTapBox>.fromOpaque(refcon).release()
        }
        thread.name = "Winter key reroute tap"
        thread.start()
        guard ready.wait(timeout: .now() + 0.1) == .success else {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
            thread.cancel()
            return nil
        }
        let lock = NSLock()
        var removed = false
        return {
            let first = lock.withLock { () -> Bool in
                defer { removed = true }
                return !removed
            }
            guard first else { return }
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
            thread.cancel()
            if let rl = box.runLoop { CFRunLoopStop(rl) }
        }
    }
}

/// The C callback's context (it cannot capture).
final class CUKeyTapBox: @unchecked Sendable {
    let handle: (CGEvent) -> CGEvent?
    private let lock = NSLock()
    private var _runLoop: CFRunLoop?
    init(handle: @escaping (CGEvent) -> CGEvent?) { self.handle = handle }
    func setRunLoop(_ rl: CFRunLoop) { lock.withLock { _runLoop = rl } }
    var runLoop: CFRunLoop? { lock.withLock { _runLoop } }
}

/// The reroute tap's callback: the handler decides; nil drops the event. A tap the system disabled passes
/// events on (it is about to be removed anyway).
private let keyRerouteTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(event) }
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let box = Unmanaged<CUKeyTapBox>.fromOpaque(refcon).takeUnretainedValue()
    guard let out = box.handle(event) else { return nil }
    return Unmanaged.passUnretained(out)
}
