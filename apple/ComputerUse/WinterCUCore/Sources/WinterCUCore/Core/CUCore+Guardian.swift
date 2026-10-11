import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The live Focus Guardian: `CUCore` drives `CUFocusGuardianCore` from system-wide activation and
/// active-Space notifications, attributing each to the user or the agent, and restoring the user the instant an
/// agent-caused one lands. Two rules keep it from ever fighting the USER (live: it re-activated "the user's
/// previous app" each time they switched to Terminal, the app they were working in):
/// - it runs only while the agent is acting — from a script's start (`script.active`) to its end plus a short
///   tail for delayed activations — never merely because targets are bound;
/// - CAUSALITY, not identity: an activation or a Space change counts as the agent's only when it comes within
///   `guardianCausalWindow` after something the agent did that could cause it — an act on that app, a focus blip
///   ending, a document opened or an app launched (live: the user swiping to Safari's desktop to watch the agent
///   was pulled back, Safari being a bound app). Anything else is the user's, whatever the app.
/// And any hardware input in the last second (trackpad gestures, Mission Control, ⌘Tab, the Dock) makes an
/// activation or Space switch the user's even inside that window; and once the user has moved somewhere, that is
/// where a later restore returns them. Gated by the private-path setting; off, the per-action user-view guard
/// stays the only backstop. The keyboard reroute runs only inside the focus blip (CUCore+Blip).
extension CUCore {
    /// How long the guardian treats an activation as following one of our own synthetic events.
    static let guardianSyntheticWindow: TimeInterval = 0.6
    /// The restore's deadline.
    static let guardianRestoreDeadlineMs: Double = 2000
    /// How long the guard outlives the last script (an app activating itself a moment after the end).
    static let guardianTail: TimeInterval = 3
    /// How long after its cause (an act, a blip, an open or a launch) a change may still be the agent's doing.
    static let guardianCausalWindow: TimeInterval = 1.5
    /// Hardware input this recent makes an activation or a Space switch the user's.
    static let guardianHardwareWindow: TimeInterval = 1

    // MARK: when it runs

    /// A script started or ended in a session (the daemon's `script.active`, and `session.ended`): the guard
    /// runs while any script does, and for `guardianTail` after the last one ends.
    public func scriptActivity(sessionId: String, active: Bool) {
        var arm = false
        var tailFrom = false
        guardianLock.withLock {
            if active {
                guardianScripts.insert(sessionId)
                guardianTailWork?.cancel()
                guardianTailWork = nil
                arm = guardianPrivatePath
            } else if guardianScripts.remove(sessionId) != nil, guardianScripts.isEmpty {
                tailFrom = true
            }
        }
        if !active {
            releaseHeldForeground(sessionId: sessionId)
            // The script ended: its open desktop visit closes now (the user returned).
            Task { [weak self] in _ = await self?.closeVisit(of: sessionId, reason: .scriptEnded) }
        }
        if arm { _ = startGuardian(privatePath: true) }
        if tailFrom {
            let work = guardianTailSchedule(Self.guardianTail) { [weak self] in self?.endGuardIfIdle() }
            guardianLock.withLock { guardianTailWork = work }
        }
    }

    /// The tail ran out: the guard stops unless a script started meanwhile.
    func endGuardIfIdle() {
        let idle = guardianLock.withLock { guardianScripts.isEmpty }
        if idle { stopGuardian() }
    }

    /// The private-path setting as the daemon sends it with each bind and act: the guard runs only with it on.
    func noteGuardianPrivatePath(_ on: Bool) {
        let arm = guardianLock.withLock { () -> Bool in
            guardianPrivatePath = on
            return on && !guardianScripts.isEmpty
        }
        if arm { _ = startGuardian(privatePath: true) }
    }

    /// A document was opened in `pid`, or it was launched: a cause for it to come forward.
    func noteGuardianOpened(_ pid: pid_t) { noteGuardianCause(pid) }

    /// The agent acted on `pid` (or a focus blip on it ended): a cause for it to come forward.
    func noteGuardianActed(_ pid: pid_t) { noteGuardianCause(pid) }

    func noteGuardianCause(_ pid: pid_t) {
        let now = clock.nowSeconds()
        guardianLock.withLock {
            guardianCauses[pid] = now
            guardianLastCause = now
        }
    }

    /// Whether `pid` coming forward now can be the agent's doing: within `guardianCausalWindow` of a cause for it.
    func guardianSuspect(_ pid: pid_t, now: TimeInterval) -> Bool {
        guardianLock.withLock { guardianCauses[pid].map { now - $0 <= Self.guardianCausalWindow } ?? false }
    }

    /// Whether a Space change now can be the agent's doing: within `guardianCausalWindow` of any cause.
    func guardianSpaceChangeCaused(now: TimeInterval) -> Bool {
        guardianLock.withLock { guardianLastCause >= 0 && now - guardianLastCause <= Self.guardianCausalWindow }
    }

    /// Recent user input: physical mouse/keys (HID state, the original 0.4 s window), or ANY hardware-origin event
    /// the listen-only tap saw in the last `guardianHardwareWindow` (trackpad gestures, scrolls, moves included).
    func userInputRecent(now: TimeInterval) -> Bool {
        if secondsSinceUserInput < CUFocusGuardianCore.userInputWindow { return true }
        let last = guardianLock.withLock { lastHardwareInputAt }
        return last >= 0 && now - last <= Self.guardianHardwareWindow
    }

    /// One event the listen-only session tap saw (not a type-21 process notification): the user's input only when
    /// `CUHardwareInput` says so — the window server's own events around an activation or a desktop change are not.
    func noteTapEvent(type: CGEventType, sourcePid: Int64, userData: Int64, flags: CGEventFlags = [], now: TimeInterval) {
        let kind = CUHardwareInput.classify(type: type, sourcePid: sourcePid, userData: userData)
        if kind != .none { noteHardwareInput(now: now, move: kind == .move) }
        if kind == .action, Self.canSwitch(type: type, flags: flags) { noteSwitchInput(now: now) }
    }

    /// Hardware input that can switch the front app or the desktop by itself: a key or modifier change with ⌘ or ⌃ held
    /// (⌘-Tab, ⌘-`, ⌃-arrows — the modifier's own press is seen even where the switcher takes the chord), and a
    /// trackpad gesture (a swipe between desktops, Mission Control's). A click counts only on a target's window or the
    /// Dock (`onPhysicalClick`). Typing, scrolling and pointer moves never do. Pure.
    static func canSwitch(type: CGEventType, flags: CGEventFlags) -> Bool {
        switch type.rawValue {
        case CGEventType.keyDown.rawValue, CGEventType.flagsChanged.rawValue:
            return flags.contains(.maskCommand) || flags.contains(.maskControl)
        case 18, 29, 30, 31, 32: return true  // rotate, gesture, magnify, swipe, smart magnify
        default: return false
        }
    }

    func noteSwitchInput(now: TimeInterval) { guardianLock.withLock { lastSwitchInputAt = now } }

    /// Whether switch-capable input can be seen at all: the session tap or the gesture monitor runs.
    var switchInputObservable: Bool {
        switchInputObservableOverride ?? guardianLock.withLock { cpsTapPort != nil || guardianGestureMonitor != nil }
    }

    /// The listen-only tap (or the gesture monitor) saw a hardware-origin event (source pid 0, not ours). `move`:
    /// only the pointer moved — input for the guardian's attribution, but never an ACTION a desktop visit counts.
    func noteHardwareInput(now: TimeInterval, move: Bool = false) {
        guardianLock.withLock {
            lastHardwareInputAt = now
            if !move { lastHardwareActionAt = now }
        }
    }

    /// Starts guarding (private path only). Idempotent; returns whether it is running.
    @discardableResult
    func startGuardian(privatePath: Bool) -> Bool {
        guard privatePath else { return false }
        guardianLock.lock(); defer { guardianLock.unlock() }
        guard guardianRefs == 0 else { return true }
        guardianRefs = 1
        guardianCore.begin(view: CUGuardedView(app: sys.frontmostPid(), space: sys.activeSpace()))
        installGuardianObservers()
        startCPSTap()
        startGestureMonitor()
        CULog.guardian.notice("guarding the user's view while a script runs")
        return true
    }

    /// Stops guarding (the tail ran out, or the helper is going away). Idempotent.
    func stopGuardian() {
        guardianLock.lock(); defer { guardianLock.unlock() }
        guard guardianRefs > 0 else { return }
        guardianRefs = 0
        guardianCore.end()
        // With the observers gone an activation of a stranded app is no longer seen: the marks would go stale (the
        // user may give the app a key window meanwhile), so they go now.
        forgetStranded()
        guardianCauses.removeAll()
        guardianLastCause = -1
        for o in guardianObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        guardianObservers.removeAll()
        stopCPSTap()
        stopGestureMonitor()
        CULog.guardian.notice("stopped guarding: no script running")
    }

    var guardianRunning: Bool { guardianLock.withLock { guardianRefs > 0 } }

    /// The user's trackpad and Dock gestures (swipes between Spaces, Mission Control, magnify) as they happen,
    /// through a global event monitor — the session tap does not see every gesture the system consumes. Each is
    /// hardware input for attribution. Off in tests (`guardianLiveTapEnabled`).
    func startGestureMonitor() {
        guard guardianLiveTapEnabled, guardianGestureMonitor == nil else { return }
        let mask: NSEvent.EventTypeMask = [.gesture, .swipe, .magnify, .rotate, .beginGesture, .endGesture, .smartMagnify,
                                           .pressure, .directTouch, .scrollWheel, .mouseMoved, .leftMouseDown, .rightMouseDown,
                                           .otherMouseDown, .keyDown, .flagsChanged]
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                guard let self else { return }
                // A gesture has no event of its own (hardware); anything else must come from no process and not be
                // the helper's own (another app's synthetic input is not the user's).
                // The monitor only sees what real input delivers to other apps, so a gesture's begin/end counts here.
                let kind = event.cgEvent.map {
                    CUHardwareInput.classify(type: $0.type, sourcePid: $0.getIntegerValueField(.eventSourceUnixProcessID),
                                             userData: $0.getIntegerValueField(.eventSourceUserData), markers: true)
                } ?? (event.type == .mouseMoved ? .move : .action)
                guard kind != .none else { return }
                let now = self.clock.nowSeconds()
                self.noteHardwareInput(now: now, move: kind == .move)
                let gestures: Set<NSEvent.EventType> = [.gesture, .swipe, .magnify, .rotate, .beginGesture, .endGesture, .smartMagnify]
                if kind == .action, gestures.contains(event.type)
                    || Self.canSwitch(type: event.cgEvent?.type ?? .null, flags: event.cgEvent?.flags ?? []) {
                    self.noteSwitchInput(now: now)
                }
            }
            let stale = self.guardianLock.withLock { () -> Bool in
                if self.guardianRefs == 0 { return true }
                self.guardianGestureMonitor = monitor
                return false
            }
            if stale, let monitor { NSEvent.removeMonitor(monitor) }
        }
    }

    /// Called with `guardianLock` held (from `stopGuardian`).
    func stopGestureMonitor() {
        guard let monitor = guardianGestureMonitor else { return }
        guardianGestureMonitor = nil
        DispatchQueue.main.async { NSEvent.removeMonitor(monitor) }
    }

    /// The consented foreground rung takes the front for one action: exempt that app briefly.
    func guardianExempt(_ pid: pid_t) {
        guardianLock.lock(); defer { guardianLock.unlock() }
        guardianCore.exempt(pid, until: clock.nowSeconds() + 5)
    }

    /// Call right before posting a synthetic activation, so the activation it causes is not read as the user.
    func noteSyntheticActivation() {
        guardianLock.lock(); defer { guardianLock.unlock() }
        lastSyntheticActivationAt = clock.nowSeconds()
    }

    /// Notes the guardian left for the next tool result (a restore happened between acts).
    func takeGuardianNotes() -> [String] {
        guardianLock.lock(); defer { guardianLock.unlock() }
        let notes = pendingGuardianNotes
        pendingGuardianNotes = []
        return notes
    }

    private func installGuardianObservers() {
        let ws = NSWorkspace.shared.notificationCenter
        guardianObservers.append(ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) {
            [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.onActivation(pid: app.processIdentifier)
        })
        guardianObservers.append(ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) {
            [weak self] _ in self?.onSpaceChange()
        })
    }

    /// The least time since any physical mouse-down, key-down or modifier change (HID state) — how the
    /// guardian tells the user's own switch from the agent's. Replaceable by tests.
    var secondsSinceUserInput: TimeInterval {
        if let o = secondsSinceUserInputOverride { return o() }
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .flagsChanged]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .greatestFiniteMagnitude
    }

    /// Runs a restore inline in tests (synchronous), else off the main queue so the observer never blocks.
    private func dispatchRestore(_ restore: CUGuardedView, thief: pid_t, repeatOffender: Bool, cause: String) {
        if guardianRestoreSync {
            guardianRestore(restore, thief: thief, repeatOffender: repeatOffender, cause: cause)
        } else {
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                guardianRestore(restore, thief: thief, repeatOffender: repeatOffender, cause: cause)
            }
        }
    }

    func onActivation(pid: pid_t) {
        noteStranded(pid, false)  // really activated: it has its key window back (or the user picks one)
        let now = clock.nowSeconds()
        // During a desktop visit only input AFTER it began is the user's (never the click that allowed it).
        let visit = visitInput(now: now)
        let userInput = visit ?? userInputRecent(now: now)
        if visit == true { noteVisitUserMove() }
        let synthetic = now - lastSyntheticActivationAt < Self.guardianSyntheticWindow
        let activation = CUActivation(app: pid, space: sys.activeSpace(), hadRecentUserInput: userInput, fromSyntheticEvent: synthetic,
                                      suspect: guardianSuspect(pid, now: now))
        guardianLock.lock()
        let verdict = guardianCore.handle(activation, now: now)
        let reason = guardianCore.lastReason
        guardianLock.unlock()
        guard case .theft(let restore, let thief, let repeatOffender) = verdict else {
            // An app the agent just acted on came forward and was left alone: say why (which attribution fired).
            if activation.suspect {
                let hid = secondsSinceUserInput
                let tap = guardianLock.withLock { lastHardwareInputAt }
                CULog.guardian.notice("\(self.appName(pid), privacy: .public) came to the front soon after the agent acted on it — left alone: \(reason, privacy: .public) (HID input \(hid < 1e6 ? String(format: "%.2f s", hid) : "never", privacy: .public) ago, tap input \(tap >= 0 ? String(format: "%.2f s", now - tap) : "never", privacy: .public) ago, synthetic \(synthetic, privacy: .public))")
            }
            return
        }
        dispatchRestore(restore, thief: thief, repeatOffender: repeatOffender, cause: "\(appName(thief)) came to the front")
    }

    func onSpaceChange() {
        let now = clock.nowSeconds()
        let visit = visitInput(now: now)
        let userInput = visit ?? userInputRecent(now: now)
        if visit == true { noteVisitUserMove() }
        let caused = guardianSpaceChangeCaused(now: now)
        let front = sys.frontmostPid()
        guardianLock.lock()
        let restore = guardianCore.handleSpaceChange(to: sys.activeSpace(), front: front, hadRecentUserInput: userInput,
                                                     caused: caused, now: now)
        guardianLock.unlock()
        guard let restore else { return }
        dispatchRestore(restore, thief: restore.app ?? 0, repeatOffender: false, cause: "the desktop changed")
    }

    /// Puts the user back: updates suspended, the user's app re-activated and its window raised, the Space
    /// returned, within the deadline — then a fault log and a note for the next result. Runs OFF the main
    /// queue (dispatched by the observers / the CPS tap), so a restore never blocks the UI or event delivery.
    func guardianRestore(_ restore: CUGuardedView, thief: pid_t, repeatOffender: Bool, cause: String) {
        guard let user = restore.app, user != thief else { return }
        let cid = skyLight.disableUpdate()
        defer { if let cid { skyLight.reenableUpdate(cid) } }
        let before = CUUserView(space: restore.space, front: user)
        let ended = restoreUserView(before, user: user)
        let thiefName = appName(thief)
        CULog.guardian.fault("\(thiefName, privacy: .public) took the user's front/desktop (\(cause, privacy: .public)); put back \(ended == before ? "ok" : "incompletely", privacy: .public)")
        var note = "\(thiefName) tried to come to the front; you were put back"
        if ended != before, ended.space != restore.space { note += ", but macOS stayed on the other desktop (switching back needs the user)" }
        if repeatOffender { note += ". \(thiefName) keeps doing this — avoid the action that launches or focuses it" }
        guardianLock.lock()
        pendingGuardianNotes.append(note)
        guardianLock.unlock()
    }

    private func appName(_ pid: pid_t) -> String {
        NSRunningApplication(processIdentifier: pid)?.localizedName ?? sys.processName(pid: pid) ?? "An app"
    }
}

// MARK: the listen-only CPS key-focus tap (a steal without an app activation)

extension CUCore {
    /// One type-21 process-notification the CPS tap saw: feed the theft state machine (protecting the bound
    /// targets), release a disallowed theft by its token, and restore the victim. Testable; the live tap calls
    /// it. Returns the verdict for the test.
    @discardableResult
    func onCPSNotification(recipientPID: pid_t, subtype: Int64, subjectPID: pid_t, theftID: Int32, now: Double) -> CUFocusGuard.Verdict {
        let boundPids = boundTargetPids()
        let verdict: CUFocusGuard.Verdict = guardianLock.withLock {
            for pid in boundPids { focusTheftGuard.protect(pid) }
            return focusTheftGuard.handle(CUFocusNotification(recipientPID: recipientPID, subtype: subtype, subjectPID: subjectPID, theftID: theftID))
        }
        switch verdict {
        case .release(let id):
            // A bound target's (synthetic) key focus was taken: the theft is released so the target keeps it. The
            // TARGET is never brought forward — the guardian protects only the user's app and Space (live: a
            // restore of the "victim" put the agent's fixture in front of the user). If the thief really came to
            // the front, the activation observer puts the user back.
            _ = cpsReleaseOverride?(id) ?? skyLight.releaseKeyFocus(id: id)
        case .drop, .pass:
            break
        }
        return verdict
    }

    /// One left-mouse-down the listen-only tap saw. A helper-origin click (our stamp) is ignored. A PHYSICAL
    /// click whose topmost window under the point belongs to a bound target is the user choosing the agent's
    /// app: the guardian takes that app and its Space as the user's at once (before the 0.4 s heuristic) and
    /// claims the activation it causes; and the target is activated so the click
    /// works normally even though the focus enforcer may have told it it was already active. Returns the pid
    /// claimed, for the test.
    @discardableResult
    func onPhysicalClick(at point: CGPoint, userData: Int64, now: Double) -> pid_t? {
        guard !CUEventStamp.isOurs(userData) else { return nil }
        guard guardianLock.withLock({ guardianCore.active }) else { return nil }
        let own = getpid()
        guard let hit = sys.windowStack().first(where: { $0.pid != own && $0.alpha > 0 && $0.frame.contains(point) }) else { return nil }
        // A click on the Dock (an app's icon) can switch apps: the user's move for a visit's late-switch watch.
        if hit.ownerName == "Dock" { noteSwitchInput(now: now) }
        guard boundTargetPids().contains(hit.pid) else { return nil }
        noteSwitchInput(now: now)
        let space = sys.activeSpace()
        guardianLock.withLock { guardianCore.userClicked(app: hit.pid, space: space, now: now) }
        let name = appName(hit.pid)
        CULog.guardian.notice("the user clicked into \(name, privacy: .public)'s window \(hit.id, privacy: .public): theirs, not a theft")
        if sys.frontmostPid() != hit.pid {
            let pid = hit.pid
            if guardianRestoreSync { _ = sys.activate(pid: pid) } else {
                DispatchQueue.global(qos: .userInitiated).async { [sys] in _ = sys.activate(pid: pid) }
            }
        }
        return hit.pid
    }

    /// Starts the listen-only type-21 tap on its own run-loop thread. Listen-only (`.listenOnly`) so a mistake
    /// can never drop or alter the user's events — it only observes, releases a theft token and restores.
    /// Best-effort: nil when the tap can't be created (the didActivate guardian still covers the common case).
    func startCPSTap() {
        guard guardianLiveTapEnabled, cpsTapThread == nil else { return }
        let box = Unmanaged.passRetained(CUCPSTapContext(core: self)).toOpaque()
        // Every event type, listen-only: the CPS notifications (key-focus thefts), every left-mouse-down (the user's
        // own clicks), and the time of any hardware-origin event (trackpad gestures included) for attribution.
        let mask: CGEventMask = CGEventMask.max
        guard let port = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap,
                                           options: .listenOnly, eventsOfInterest: mask, callback: cpsTapCallback, userInfo: box) else {
            Unmanaged<CUCPSTapContext>.fromOpaque(box).release()
            return
        }
        cpsTapPort = port
        let thread = Thread {
            let source = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            while !Thread.current.isCancelled, CFRunLoopRunInMode(.defaultMode, 0.25, false) != .stopped {}
        }
        thread.name = "Winter CPS focus tap"
        cpsTapThread = thread
        thread.start()
    }

    /// Tears down the CPS tap. Called from `stopGuardian`, which already holds `guardianLock`, so it resets
    /// the theft guard WITHOUT taking the lock again (a re-entrant NSLock would deadlock).
    func stopCPSTap() {
        cpsTapThread?.cancel()
        cpsTapThread = nil
        if let port = cpsTapPort { CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port) }
        cpsTapPort = nil
        focusTheftGuard = CUFocusGuard()
    }
}

/// The refcon the C tap callback carries (it cannot capture).
final class CUCPSTapContext {
    weak var core: CUCore?
    init(core: CUCore) { self.core = core }
}

/// The listen-only CPS tap callback: reads the type-21 notification's fields and hands them to the core. It
/// returns the event unchanged (listen-only ignores the return, but a disabled tap is re-enabled).
private let cpsTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        return Unmanaged.passUnretained(event)
    }
    guard let refcon, let core = Unmanaged<CUCPSTapContext>.fromOpaque(refcon).takeUnretainedValue().core else {
        return Unmanaged.passUnretained(event)
    }
    // Hardware-origin input (no source process, not ours, a type a person makes): the user's own — a pointer move
    // told apart.
    if type.rawValue != CUFocusTaps.processNotificationType {
        core.noteTapEvent(type: type, sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID),
                          userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags, now: core.clock.nowSeconds())
    }
    if type == .leftMouseDown {
        core.onPhysicalClick(at: event.location, userData: event.getIntegerValueField(.eventSourceUserData),
                             now: core.clock.nowSeconds())
        return Unmanaged.passUnretained(event)
    }
    guard type.rawValue == CUFocusTaps.processNotificationType else { return Unmanaged.passUnretained(event) }
    func f(_ n: UInt32) -> Int64 { event.getIntegerValueField(CGEventField(rawValue: n)!) }
    core.onCPSNotification(recipientPID: pid_t(f(CUFocusField.targetPID)), subtype: f(CUFocusField.cpsSubtype),
                           subjectPID: pid_t(f(CUFocusField.subjectPID)), theftID: Int32(truncatingIfNeeded: f(CUFocusField.theftID)),
                           now: core.clock.nowSeconds())
    return Unmanaged.passUnretained(event)
}

/// What one input event is to the guardian. Pure.
enum CUHardwareInput: Equatable {
    /// Not the user's: a process posted it (synthetic), the helper did (its stamp), or it is no input at all.
    case none
    /// The pointer moved, and nothing else.
    case move
    /// A click, a key, a scroll, a drag, a gesture.
    case action

    /// The event types a person makes: buttons, drags, keys, scrolls, the tablet, and trackpad gestures (gesture,
    /// magnify, swipe, rotate, smart magnify, pressure, direct touch). A WHITELIST: the window server puts other
    /// events on the session with no source process whenever an app activates or the desktop changes — mouse
    /// entered/exited (8, 9), AppKit-defined (13), and the gesture begin/end markers (19, 20) — measured live on
    /// macOS 26 with no input at all (the live gate, 2026-10-10: counted as the user's, they made an app that
    /// activated itself a second after the agent's click "the user's switch", never undone).
    static let userTypes: Set<UInt32> = [1, 2, 3, 4, 6, 7, 10, 11, 12, 18, 22, 23, 24, 25, 26, 27, 29, 30, 31, 32, 34, 37]
    /// The gesture begin/end markers: the user's only where the window server never puts them on its own — the
    /// global gesture monitor, which sees what real input delivers to other apps (a swipe between desktops).
    static let gestureMarkers: Set<UInt32> = [19, 20]

    static func classify(type: CGEventType, sourcePid: Int64, userData: Int64, markers: Bool = false) -> CUHardwareInput {
        guard sourcePid == 0, !CUEventStamp.isOurs(userData) else { return .none }
        if type == .mouseMoved { return .move }
        return userTypes.contains(type.rawValue) || (markers && gestureMarkers.contains(type.rawValue)) ? .action : .none
    }
}
