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
    /// and release. The decision and the start or stop happen under ONE lock (review of round 12, MEDIUM #1: a release's
    /// stop could run after a concurrent bind's start found the thread still there, leaving it off with a target bound; two
    /// binds could both start a tap, one leaking).
    func updateWorkWatcher() {
        guard guardianLiveTapEnabled || workWatcherStarter != nil else { return }
        workWatcherLock.withLock {
            let bound = !boundTargets().isEmpty
            if bound, workWatcherStop == nil {
                workWatcherStop = (workWatcherStarter ?? { [self] in startWorkWatcherTap() })()
                if workWatcherStop != nil { CULog.guardian.notice("the work watcher is on (a target is bound)") }
            } else if !bound, let stop = workWatcherStop {
                workWatcherStop = nil
                stop()
                CULog.guardian.notice("the work watcher is off (nothing is bound)")
            }
        }
    }

    /// The live tap and its run-loop thread; the way to stop them. Under `workWatcherLock`.
    private func startWorkWatcherTap() -> (() -> Void)? {
        let box = Unmanaged.passRetained(CUCPSTapContext(core: self)).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                           eventsOfInterest: Self.workWatcherMask, callback: workWatcherCallback, userInfo: box) else {
            Unmanaged<CUCPSTapContext>.fromOpaque(box).release()
            CULog.guardian.notice("the work watcher could not start (no event tap)")
            return nil
        }
        workWatcherPort = port
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            // A long wait: the tap's events wake the run loop; nothing else needs it (a cancel is seen within 5 s). A run
            // loop with no source left (the port invalidated) returns at once: the thread ends then, never spins.
            while !Thread.current.isCancelled {
                let r = CFRunLoopRunInMode(.defaultMode, 5, false)
                if r == .stopped || r == .finished { break }
            }
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
            Unmanaged<CUCPSTapContext>.fromOpaque(box).release()
        }
        thread.name = "Winter work watcher"
        thread.start()
        return { [weak self] in
            CGEvent.tapEnable(tap: port, enable: false)
            thread.cancel()
            self?.workWatcherPort = nil
        }
    }

    /// The tap was disabled by the system (a slow callback, or the user's secure input): on again.
    func reenableWorkWatcherTap() {
        workWatcherLock.withLock { if let port = workWatcherPort { CGEvent.tapEnable(tap: port, enable: true) } }
    }

    var workWatcherRunning: Bool { workWatcherLock.withLock { workWatcherStop != nil } }

    /// One event the watcher saw. While the guardian runs its own tap handles it; else the user's own action on a bound
    /// app in front is their work in it.
    func noteWatchedEvent(type: CGEventType, sourcePid: Int64, userData: Int64, flags: CGEventFlags, keycode: Int64,
                          location: CGPoint, targetPid: Int64) {
        guard !guardianRunning, CUHardwareInput.classify(type: type, sourcePid: sourcePid, userData: userData) == .action else { return }
        // (Its time too: the secure-input rule takes recent input of theirs as what corroborates work.)
        noteHardwareInput(now: clock.nowSeconds())
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
    guard let refcon, let core = Unmanaged<CUCPSTapContext>.fromOpaque(refcon).takeUnretainedValue().core else {
        return Unmanaged.passUnretained(event)
    }
    // Disabled by the system (review of round 12, LOW): on again — a listen-only tap left off would see nothing more.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        core.reenableWorkWatcherTap()
        return Unmanaged.passUnretained(event)
    }
    core.noteWatchedEvent(type: type, sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID),
                          userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
                          keycode: type == .keyDown ? event.getIntegerValueField(.keyboardEventKeycode) : -1,
                          location: event.location,
                          targetPid: type == .keyDown ? event.getIntegerValueField(.eventTargetUnixProcessID) : 0)
    return Unmanaged.passUnretained(event)
}
