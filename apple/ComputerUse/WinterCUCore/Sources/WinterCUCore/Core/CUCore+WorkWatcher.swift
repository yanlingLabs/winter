import AppKit
import CoreGraphics
import Foundation

/// The WORK WATCHER (round 10's MEDIUM #5, the user's ruling): while any target is bound — and only then — a narrow
/// listen-only session tap sees the user's own keys, clicks and scrolls, so I6 ("hands off an app the user is working
/// in") also knows of work done BETWEEN scripts, when the guardian's tap is down. It never blocks or alters an event,
/// logs no content (no key, no text, no position), and attributes an event only to a bound app in front (the window
/// server's receiving process for a key; the window under the point for a click or a scroll). Its mask holds no pointer
/// moves, so an idle Mac sends it nothing. A public API (`CGEvent.tapCreate`, listen-only — the helper's Accessibility
/// grant covers it), so it does not depend on the private event path: I6 holds with it off too. While the guardian runs,
/// its own tap does this, and the watcher's callback steps aside.
extension CUCore {
    /// The event types the watcher listens for: key down, the three mouse-down buttons, and the scroll wheel.
    static let workWatcherMask: CGEventMask = {
        let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        return types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    }()

    /// Starts the watcher when a target is bound and none runs; stops it when none is bound. Cheap; called at every bind
    /// and release.
    func updateWorkWatcher() {
        let bound = !boundTargets().isEmpty
        if bound { startWorkWatcher() } else { stopWorkWatcher() }
    }

    func startWorkWatcher() {
        guard guardianLiveTapEnabled else { return }
        let box: UnsafeMutableRawPointer? = workWatcherLock.withLock {
            guard workWatcherThread == nil else { return nil }
            return Unmanaged.passRetained(CUCPSTapContext(core: self)).toOpaque()
        }
        guard let box else { return }
        guard let port = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                           eventsOfInterest: Self.workWatcherMask, callback: workWatcherCallback, userInfo: box) else {
            Unmanaged<CUCPSTapContext>.fromOpaque(box).release()
            CULog.guardian.notice("the work watcher could not start (no event tap)")
            return
        }
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            // A long wait: the tap's events wake the run loop; nothing else needs it (a cancel is seen within 5 s).
            while !Thread.current.isCancelled, CFRunLoopRunInMode(.defaultMode, 5, false) != .stopped {}
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
            Unmanaged<CUCPSTapContext>.fromOpaque(box).release()
        }
        thread.name = "Winter work watcher"
        workWatcherLock.withLock {
            workWatcherThread = thread
            workWatcherPort = port
        }
        thread.start()
        CULog.guardian.notice("the work watcher is on (a target is bound)")
    }

    func stopWorkWatcher() {
        let (thread, port) = workWatcherLock.withLock { () -> (Thread?, CFMachPort?) in
            defer { workWatcherThread = nil; workWatcherPort = nil }
            return (workWatcherThread, workWatcherPort)
        }
        guard let thread else { return }
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        thread.cancel()
        CULog.guardian.notice("the work watcher is off (nothing is bound)")
    }

    var workWatcherRunning: Bool { workWatcherLock.withLock { workWatcherThread != nil } }

    /// One event the watcher saw. While the guardian runs its own tap handles it; else the user's own action on a bound
    /// app in front is their work in it.
    func noteWatchedEvent(type: CGEventType, sourcePid: Int64, userData: Int64, flags: CGEventFlags, keycode: Int64,
                          location: CGPoint, targetPid: Int64) {
        guard !guardianRunning, CUHardwareInput.classify(type: type, sourcePid: sourcePid, userData: userData) == .action else { return }
        switch type {
        case .leftMouseDown:
            // A click into an ordinary window of a bound app (not a ⌘-click): work in it once it is in front.
            guard !flags.contains(.maskCommand), let hit = windowUnder(location), hit.layer == 0,
                  boundTargetPids().contains(hit.pid) else { return }
            if guardianLock.withLock({ guardianCore.userWorkingApp == hit.pid }) { return }
            userInteracted(hit.pid)
        default:
            noteUserInteraction(type: type, flags: flags, keycode: keycode, location: location, targetPid: targetPid)
        }
    }
}

/// The work watcher's tap callback (a C function: it cannot capture). Listen-only: the event goes on unchanged.
private let workWatcherCallback: CGEventTapCallBack = { _, type, event, refcon in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(event) }
    guard let refcon, let core = Unmanaged<CUCPSTapContext>.fromOpaque(refcon).takeUnretainedValue().core else {
        return Unmanaged.passUnretained(event)
    }
    core.noteWatchedEvent(type: type, sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID),
                          userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
                          keycode: type == .keyDown ? event.getIntegerValueField(.keyboardEventKeycode) : -1,
                          location: event.location,
                          targetPid: type == .keyDown ? event.getIntegerValueField(.eventTargetUnixProcessID) : 0)
    return Unmanaged.passUnretained(event)
}
