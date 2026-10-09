import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The live Focus Guardian: `CUCore` drives `CUFocusGuardianCore` from system-wide activation and
/// active-Space notifications, attributing each to the user (physical input just before it) or the agent, and
/// restoring the user the instant an agent-caused one lands — at any delay, so a document that opens or an app
/// that activates itself seconds later is caught too. Gated by the private-path setting; off, the per-action
/// user-view guard stays the only backstop. The keyboard reroute (thief → victim) is NOT enabled here.
extension CUCore {
    /// How long the guardian treats an activation as following one of our own synthetic events.
    static let guardianSyntheticWindow: TimeInterval = 0.6
    /// The restore's deadline.
    static let guardianRestoreDeadlineMs: Double = 2000

    /// Starts guarding for a bound target (private path only). Returns whether it counted this target, so the
    /// caller releases it symmetrically.
    @discardableResult
    func startGuardian(privatePath: Bool) -> Bool {
        guard privatePath else { return false }
        guardianLock.lock(); defer { guardianLock.unlock() }
        guardianRefs += 1
        if guardianRefs == 1 {
            guardianCore.begin(view: CUGuardedView(app: sys.frontmostPid(), space: sys.activeSpace()))
            installGuardianObservers()
            startCPSTap()
        }
        return true
    }

    func stopGuardian() {
        guardianLock.lock(); defer { guardianLock.unlock() }
        guard guardianRefs > 0 else { return }
        guardianRefs -= 1
        guard guardianRefs == 0 else { return }
        guardianCore.end()
        for o in guardianObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        guardianObservers.removeAll()
        stopCPSTap()
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
        let now = clock.nowSeconds()
        let userInput = secondsSinceUserInput < CUFocusGuardianCore.userInputWindow
        let synthetic = now - lastSyntheticActivationAt < Self.guardianSyntheticWindow
        let activation = CUActivation(app: pid, space: sys.activeSpace(), hadRecentUserInput: userInput, fromSyntheticEvent: synthetic)
        guardianLock.lock()
        let verdict = guardianCore.handle(activation, now: now)
        guardianLock.unlock()
        guard case .theft(let restore, let thief, let repeatOffender) = verdict else { return }
        dispatchRestore(restore, thief: thief, repeatOffender: repeatOffender, cause: "\(appName(thief)) came to the front")
    }

    func onSpaceChange() {
        let now = clock.nowSeconds()
        let userInput = secondsSinceUserInput < CUFocusGuardianCore.userInputWindow
        guardianLock.lock()
        let restore = guardianCore.handleSpaceChange(to: sys.activeSpace(), hadRecentUserInput: userInput, now: now)
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
            _ = cpsReleaseOverride?(id) ?? skyLight.releaseKeyFocus(id: id)
            fallthrough
        case .drop:
            // A protected target lost key focus to a thief without an app activation: put the user back on
            // the victim. The victim is the bound target; restore its app to the front.
            let victim = guardianLock.withLock { focusTheftGuard.suppression?.victimPID }
            if let victim {
                dispatchRestore(CUGuardedView(app: victim, space: sys.activeSpace()), thief: subjectPID, repeatOffender: false,
                                cause: "\(appName(subjectPID)) took key focus")
            }
        case .pass:
            break
        }
        return verdict
    }

    /// One left-mouse-down the listen-only tap saw. A helper-origin click (our stamp) is ignored. A PHYSICAL
    /// click whose topmost window under the point belongs to a bound target is the user choosing the agent's
    /// app: the guardian takes that app and its Space as the user's at once (before the 0.4 s heuristic) and
    /// claims the activation it causes; and, as ChatGPT's helper does, the target is activated so the click
    /// works normally even though the focus enforcer may have told it it was already active. Returns the pid
    /// claimed, for the test.
    @discardableResult
    func onPhysicalClick(at point: CGPoint, userData: Int64, now: Double) -> pid_t? {
        guard !CUEventStamp.isOurs(userData) else { return nil }
        guard guardianLock.withLock({ guardianCore.active }) else { return nil }
        let own = getpid()
        guard let hit = sys.windowStack().first(where: { $0.pid != own && $0.alpha > 0 && $0.frame.contains(point) }),
              boundTargetPids().contains(hit.pid) else { return nil }
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
        // The CPS notifications (key-focus thefts) and every left-mouse-down (the user's own clicks).
        let mask: CGEventMask = (CGEventMask(1) << CUFocusTaps.processNotificationType)
            | (CGEventMask(1) << CGEventType.leftMouseDown.rawValue)
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
    if type == .leftMouseDown {
        core.onPhysicalClick(at: event.location, userData: event.getIntegerValueField(.eventSourceUserData),
                             now: core.clock.nowSeconds())
        return Unmanaged.passUnretained(event)
    }
    func f(_ n: UInt32) -> Int64 { event.getIntegerValueField(CGEventField(rawValue: n)!) }
    core.onCPSNotification(recipientPID: pid_t(f(CUFocusField.targetPID)), subtype: f(CUFocusField.cpsSubtype),
                           subjectPID: pid_t(f(CUFocusField.subjectPID)), theftID: Int32(truncatingIfNeeded: f(CUFocusField.theftID)),
                           now: core.clock.nowSeconds())
    return Unmanaged.passUnretained(event)
}
