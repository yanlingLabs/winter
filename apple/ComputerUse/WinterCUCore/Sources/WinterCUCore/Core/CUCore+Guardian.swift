import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// The live Focus Guardian: `CUCore` feeds `CUFocusGuardianCore` the facts — what the agent does to which app
/// (`noteGuardianCause`, spans, launches), the user's input that can switch (the session tap, the gesture monitor,
/// their clicks) — and asks it, from EVERY path that sees the user's front app or desktop change, whose move that was
/// (`judgeMove`, the one rule: PROTOCOL.md §4.12). Two rules keep it from ever fighting the USER (live: it re-activated
/// "the user's previous app" each time they switched to Terminal, the app they were working in):
/// - it runs only while the agent is acting — from a script's start (`script.active`) to its end plus a short tail
///   for delayed activations — never merely because targets are bound;
/// - only an app the agent TOUCHED (per pid, within its causal window) can ever be undone; anything else coming
///   forward is the user's, whatever the app.
/// Every restore goes to the user's CURRENT place, read when it runs. Gated by the private-path setting; off, the
/// per-action user-view guard stays the only backstop. The keyboard reroute runs only inside the focus blip
/// (CUCore+Blip), and sends the user's keys to their place by the same rule (`keyPlace`).
extension CUCore {
    /// The restore's deadline.
    static let guardianRestoreDeadlineMs: Double = 2000
    /// How long the guard outlives the last script (an app activating itself a moment after the end).
    static let guardianTail: TimeInterval = 3
    /// How long after its cause a change may still be the agent's doing (`CUFocusGuardianCore.causalWindow`).
    static var guardianCausalWindow: TimeInterval { CUFocusGuardianCore.causalWindow }

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

    // MARK: the agent's causes (I1: only what it touched can be undone)

    /// A document was opened in `pid`, or it was launched: a cause for it to come forward.
    func noteGuardianOpened(_ pid: pid_t) { noteGuardianCause(pid, raise: true) }

    /// The agent acted on `pid`: a cause for it to come forward.
    func noteGuardianActed(_ pid: pid_t) { noteGuardianCause(pid) }

    /// An operation on `pid` ended (an act, a focus blip, a bind): its delayed reactions are still the agent's for the
    /// causal window — without being a new cause, so the user's input during it still counts after its start.
    func noteGuardianAfterglow(_ pid: pid_t, raise: Bool = false) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.noteAfterglow(pid, raise: raise, now: now) }
    }

    /// `raise`: the cause can bring a window or a desktop forward (an activation, a raise, a main-window write, a return).
    /// When `pid` is already the front app, whatever brought it forward came before and is judged on its own: what the
    /// agent does to it then counts only once it has left the front (`noteFrontAfterglow`), never as a cause of the move
    /// that put it there (the model-based test: an act begun 70 ms after their ⌘-Tab into the target made that move
    /// "the agent's").
    func noteGuardianCause(_ pid: pid_t, raise: Bool = false) {
        let now = clock.nowSeconds()
        let front = sys.frontmostPid() == pid
        guardianLock.withLock {
            if front { guardianCore.noteFrontAfterglow(pid, raise: raise, now: now) } else { guardianCore.noteCause(pid, raise: raise, now: now) }
        }
    }

    /// Call right before posting a synthetic event to `pid` (an activation, a deactivation, a focus record): an
    /// activation of THAT app right after it is not the user's by itself. Per app — a mark on the target never makes
    /// another app's activation the agent's (review of round 7: one global mark made the user's click into Mail a theft).
    func noteSyntheticActivation(_ pid: pid_t) { noteGuardianCause(pid) }

    /// An operation on `pid` that may bring it forward at any time while it runs (an AppleScript, a bind's window wait,
    /// a `useWindow`): touched throughout, and for the causal window after.
    func beginGuardianSpan(_ pid: pid_t) {
        let now = clock.nowSeconds()
        let front = sys.frontmostPid() == pid
        guardianLock.withLock { guardianCore.beginSpan(pid, whileFront: front, now: now) }
    }

    func endGuardianSpan(_ pid: pid_t) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.endSpan(pid, now: now) }
    }

    /// The agent is about to launch an app (a bind's): an app whose process starts meanwhile is the agent's.
    func beginGuardianLaunch() -> Int {
        let now = clock.nowSeconds()
        return guardianLock.withLock { guardianCore.beginLaunch(now: now) }
    }

    /// The bundle the pending launch is for, when the bind knows it (the default resolver does): only that app's
    /// process counts as the launch's.
    func noteGuardianLaunchBundle(_ bundle: String?) {
        guardianLock.withLock { guardianCore.setLatestLaunchBundle(bundle) }
    }

    func endGuardianLaunch(_ token: Int, pid: pid_t?) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.endLaunch(token, pid: pid, now: now) }
    }

    /// Whether `pid` coming forward now can be the agent's doing (for the log and tests).
    func guardianTouched(_ pid: pid_t, now: TimeInterval? = nil) -> Bool {
        let at = now ?? clock.nowSeconds()
        return guardianLock.withLock { guardianCore.isTouched(pid, now: at) }
    }

    // MARK: whose move — the one rule (`CUFocusGuardianCore.judge`)

    /// Whose move the user's view being `v` now is. `since`: when the caller's own operation began (switch input counts
    /// from then); nil for an observer. `from`: where that operation began (the user's place when the guard is off).
    /// Every path that sees the user's front app or desktop change asks this — and nothing else.
    @discardableResult
    func judgeMove(_ v: CUUserView, since: TimeInterval?, from: CUUserView? = nil, path: String) -> CUMoveOwner {
        judgeMoveDetailed(v, since: since, from: from, path: path).owner
    }

    /// The facts of the user's view being `v` now, as the rule reads them.
    func moveQuery(_ v: CUUserView, since: TimeInterval?, from: CUUserView? = nil) -> CUMoveQuery {
        let now = clock.nowSeconds()
        let observable = switchInputObservable
        let clickAt: TimeInterval? = observable ? nil : now - secondsSinceUserClick
        let launching = guardianLock.withLock { guardianCore.launchPending }
        let started = launching ? v.front.flatMap { pid in sys.processAge(pid: pid).map { now - $0 } } : nil
        let bundle = launching ? v.front.flatMap { sys.bundleId(pid: $0) } : nil
        // A desktop change: the apps the agent touched (with a cause that raises) whose window it showed.
        let placeSpace = guardianPlace()?.space ?? from?.space
        var shown: [pid_t] = []
        if let s = v.space, let p = placeSpace, s != p {
            let candidates = guardianLock.withLock { guardianCore.raiseTouchedApps(now: now) }
            shown = candidates.filter { pid in pid != v.front && sys.windows(pid: pid).contains { $0.onScreen } }
        }
        return CUMoveQuery(app: v.front, space: v.space, since: since,
                           from: from.map { CUGuardedView(app: $0.front, space: $0.space) },
                           appStartedAt: started, appBundle: bundle, inputObservable: observable, clickAt: clickAt, shown: shown)
    }

    func judgeMoveDetailed(_ v: CUUserView, since: TimeInterval?, from: CUUserView? = nil, path: String)
        -> (owner: CUMoveOwner, repeatOffender: Bool) {
        let now = clock.nowSeconds()
        let q = moveQuery(v, since: since, from: from)
        let (owner, fresh, repeatOffender, why) = guardianLock.withLock { () -> (CUMoveOwner, Bool, Bool, String) in
            let o = guardianCore.judge(q, now: now)
            return (o, guardianCore.lastFresh, guardianCore.lastRepeatOffender, guardianCore.lastReason)
        }
        moveJudged?(path, v, owner)
        if fresh {
            CULog.guardian.notice("\(path, privacy: .public): front \(v.front.map { self.appName($0) } ?? "?", privacy: .public), space \(v.space.map(String.init) ?? "?", privacy: .public) — \(why, privacy: .public)")
        }
        return (owner, repeatOffender)
    }

    /// Whether the user's view being `v` now is theirs — their place, or their own move.
    func isUsersMove(_ v: CUUserView, since: TimeInterval?, from: CUUserView? = nil, path: String) -> Bool {
        judgeMove(v, since: since, from: from, path: path).isUsers
    }

    /// The user's place, while guarding.
    func guardianPlace() -> CUGuardedView? {
        guardianLock.withLock { guardianCore.active ? guardianCore.view : nil }
    }

    /// I3 — where a key of the USER's goes while a focus blip holds the target's window key (the reroute asks for each
    /// one): their place by the one rule. Nothing moved since the blip began: the app they were in. They moved (into the
    /// target — the key stays there — or to another app): there. The target (or anything) took the front without being
    /// their move: their place as the guardian knows it, else the app they were in.
    func keyPlace(target: pid_t, user: pid_t, space: UInt64?, since: TimeInterval, startWasTheirs: Bool) -> pid_t {
        let now = userView()
        // Nothing moved since the blip began: the app they were in then, when that was their place (judged as the blip
        // began — a move of theirs the guardian had not heard of yet counts: their ⌘-Tab out of the target, then the blip,
        // then their key passed into the target, the model-based test); else (an app that had taken the front by itself
        // and not been put back yet) their place as the guardian knows it.
        if now.front == user, space == nil || now.space == nil || now.space == space {
            return startWasTheirs ? user : (guardianPlace()?.app ?? user)
        }
        let owner = judgeMove(now, since: since, from: CUUserView(space: space, front: user), path: "a key of the user's in the focus blip")
        if owner.isUsers, let f = now.front { return f }
        // Not their move: their place as the guardian knows it — only ever set by their own moves.
        return guardianPlace()?.app ?? user
    }

    // MARK: the user's input

    /// One event the listen-only session tap saw (not a type-21 process notification): the user's input only when
    /// `CUHardwareInput` says so — the window server's own events around an activation or a desktop change are not.
    func noteTapEvent(type: CGEventType, sourcePid: Int64, userData: Int64, flags: CGEventFlags = [], keycode: Int64 = -1,
                      now: TimeInterval) {
        let kind = CUHardwareInput.classify(type: type, sourcePid: sourcePid, userData: userData)
        if kind != .none { noteHardwareInput(now: now, move: kind == .move) }
        guard kind == .action else { return }
        let secure = (type == .flagsChanged || type == .keyDown) && secureInputOn
        guardianLock.withLock { guardianCore.inputEvent(type: type, flags: flags, keycode: keycode, secure: secure, now: now) }
    }

    /// A click on the Dock or on another app's window (`.app`), or a trackpad swipe or a click on another display's
    /// desktop (`.desktop`): input that can switch by itself.
    func noteSwitchInput(now: TimeInterval, _ kind: CUSwitchInput.Kind = .app, target: pid_t? = nil) {
        guardianLock.withLock { guardianCore.noteSwitch(now: now, kind, target: target) }
    }

    /// Whether switch-capable input can be seen at all: the session tap runs (the gesture monitor alone sees no
    /// modifiers it can pair, nor the user's clicks).
    var switchInputObservable: Bool {
        switchInputObservableOverride ?? guardianLock.withLock { cpsTapPort != nil }
    }

    /// Secure Event Input is on (a password field somewhere has it): the tap sees no keys, so a ⌘/⌃ hold can't be told
    /// from a shortcut and no hold counts. Whether the tap still sees modifier changes then is not measured (it needs a
    /// key-event tap in a probe, which asks for Input Monitoring).
    var secureInputOn: Bool { secureInputOverride ?? IsSecureEventInputEnabled() }

    /// The listen-only tap (or the gesture monitor) saw a hardware-origin event (source pid 0, not ours). `move`:
    /// only the pointer moved.
    func noteHardwareInput(now: TimeInterval, move: Bool = false) {
        guardianLock.withLock {
            lastHardwareInputAt = now
            if !move { lastHardwareActionAt = now }
        }
    }

    // MARK: guarding

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
        for o in guardianObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        guardianObservers.removeAll()
        stopCPSTap()
        stopGestureMonitor()
        CULog.guardian.notice("stopped guarding: no script running")
    }

    var guardianRunning: Bool { guardianLock.withLock { guardianRefs > 0 } }

    /// The user's trackpad and Dock gestures (swipes between Spaces, Mission Control, magnify) as they happen,
    /// through a global event monitor — the session tap does not see every gesture the system consumes. Each is
    /// hardware input; a swipe, magnify, rotate or its begin/end marker can switch — never the generic gesture event,
    /// which comes with any touch (a two-finger scroll in the user's own app). Off in tests (`guardianLiveTapEnabled`).
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
                // Switching gestures only (modifiers are the session tap's: the two seeing one press out of order would
                // leave a hold that never ends).
                let switching: Set<NSEvent.EventType> = [.swipe, .magnify, .rotate, .beginGesture, .endGesture, .smartMagnify]
                if kind == .action, switching.contains(event.type) { self.noteSwitchInput(now: now, .desktop) }
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
        let now = clock.nowSeconds()
        guardianLock.withLock {
            guardianCore.noteCause(pid, raise: true, now: now)
            guardianCore.exempt(pid, until: now + 5)
        }
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

    /// The least time since any physical mouse-down, key-down or modifier change (HID state) — for the log.
    /// Replaceable by tests.
    var secondsSinceUserInput: TimeInterval {
        if let o = secondsSinceUserInputOverride { return o() }
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .flagsChanged]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .greatestFiniteMagnitude
    }

    /// The least time since a physical mouse-down (HID state; the helper's own posted clicks never count — measured
    /// on 2026-10-11). Read only when no session tap runs. Replaceable by tests.
    var secondsSinceUserClick: TimeInterval {
        if let o = secondsSinceUserClickOverride { return o() }
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .greatestFiniteMagnitude
    }

    // MARK: the observers

    /// An app was activated (NSWorkspace). The notification is only a TRIGGER: what is judged is the live front app and
    /// desktop as they are now — a late notification of an app that is no longer in front judges nothing stale.
    func onActivation(pid: pid_t) {
        appActivated(pid: pid)  // really activated: it has its key window back (or the user picks one)
        // An app the agent never touched was activated, and something else is in front already: that activation was the
        // user's (I1) — their place went there before whatever came next, and a theft after it is put back THERE (the
        // model-based test: an app came forward 5 ms after it, before the guardian heard of either).
        if let front = sys.frontmostPid(), front != pid {
            let now = clock.nowSeconds()
            let live = CUGuardedView(app: front, space: sys.activeSpace())
            // The desktop it came forward on, as its windows tell: the one shown now if it has a window there, else its one
            // desktop if it has a single one, else unknown.
            let spaces = Set(sys.windows(pid: pid).filter { CUWindowServer.isRealWindow($0) }.flatMap { sys.windowSpaces($0.id) ?? [] })
            let space: UInt64? = live.space.flatMap { spaces.contains($0) ? $0 : nil } ?? (spaces.count == 1 ? spaces.first : nil)
            if guardianLock.withLock({ guardianCore.adoptPast(pid, space: space, live: live, now: now) }) {
                CULog.guardian.notice("\(self.appName(pid), privacy: .public) activated (the agent never touched it) and is no longer in front: it was the user's place before that")
            }
        }
        observe("\(appName(pid)) activated")
    }

    func onSpaceChange() { observe("the desktop changed") }

    /// One observer's look: the live view judged by the one rule. The agent's: the user put back (to their place as it is
    /// when the restore runs). The user's during a visit: the visit closes, leaving them there.
    func observe(_ what: String) {
        guard guardianLock.withLock({ guardianCore.active }) else { return }
        let now = userView()
        let (owner, repeatOffender) = judgeMoveDetailed(now, since: nil, path: what)
        switch owner {
        case .user:
            if guardianLock.withLock({ guardianCore.visitSawUserInput }) { noteVisitUserMove() }
        case .agent:
            guard let thief = now.front else { return }
            dispatchRestore(thief: thief, repeatOffender: repeatOffender, cause: "\(appName(thief)) came to the front")
        case .theirPlace, .consented, .visit:
            break
        }
    }

    /// Runs a restore inline in tests (synchronous), else off the main queue so the observer never blocks.
    private func dispatchRestore(thief: pid_t, repeatOffender: Bool, cause: String) {
        if guardianRestoreSync {
            guardianRestore(thief: thief, repeatOffender: repeatOffender, cause: cause)
        } else {
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                guardianRestore(thief: thief, repeatOffender: repeatOffender, cause: cause)
            }
        }
    }

    /// I2 — puts the user back at their place AS IT IS NOW (the guardian's view; `fallback` when not guarding — never a
    /// place captured before they moved): updates suspended, their app re-activated and its window raised, the Space
    /// returned, within the deadline — then a fault log and a note for the next result. Nothing when they are there
    /// already (unless `force`: the front is theirs but the key focus is not), or when their place is the thief itself.
    /// Runs OFF the main queue (dispatched by the observers), so a restore never blocks the UI or event delivery.
    func guardianRestore(thief: pid_t, fallback: CUGuardedView? = nil, repeatOffender: Bool = false, force: Bool = false,
                         cause: String) {
        guard let place = guardianPlace() ?? fallback, let user = place.app, user != thief else { return }
        let target = CUUserView(space: place.space, front: user)
        let now = userView()
        guard force || now.front != user || (place.space != nil && now.space != nil && now.space != place.space) else { return }
        // The user's own place is never marked as touched by bringing them back to it (that made their next move back
        // into it, under Secure Event Input, the agent's — the model-based test); a retry never lands over a move of
        // theirs (`restoreUserView` asks the rule before each one).
        let cid = skyLight.disableUpdate()
        defer { if let cid { skyLight.reenableUpdate(cid) } }
        let ended = restoreUserView(target, user: user)
        let thiefName = appName(thief)
        CULog.guardian.fault("\(thiefName, privacy: .public) took the user's front/desktop (\(cause, privacy: .public)); put back \(ended == target ? "ok" : "incompletely", privacy: .public)")
        var note = "\(thiefName) tried to come to the front; you were put back"
        if ended != target, ended.space != target.space { note += ", but macOS stayed on the other desktop (switching back needs the user)" }
        if repeatOffender { note += ". \(thiefName) keeps doing this — avoid the action that launches or focuses it" }
        guardianLock.withLock { pendingGuardianNotes.append(note) }
    }

    func appName(_ pid: pid_t) -> String {
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

    /// One left-mouse-down the listen-only tap saw. A helper-origin click (our stamp) is ignored. A PHYSICAL click on a
    /// window of an app that is not in front (or on another display's desktop, or into a bound target's window) is the
    /// user moving there: their place is that app and its desktop at once — before any activation arrives, so a theft
    /// landing in between is put back THERE (the model-based test: it was put back to where they had been before the
    /// click) — and the activation it causes is claimed as theirs. A bound target is also activated, so the click works
    /// normally even though the focus enforcer may have told it it was already active. A ⌘-click works a window in the
    /// background (no activation): no move. A click on the Dock can switch apps (its target unknown). Returns the pid
    /// claimed, for the test.
    @discardableResult
    func onPhysicalClick(at point: CGPoint, userData: Int64, flags: CGEventFlags = [], now: Double) -> pid_t? {
        guard !CUEventStamp.isOurs(userData) else { return nil }
        guard guardianLock.withLock({ guardianCore.active }) else { return nil }
        let own = getpid()
        // The topmost window under the point — the helper's own panels included: a click on one (the desktop-switch
        // prompt) is on no other app.
        guard let hit = sys.windowStack().first(where: { $0.alpha > 0 && $0.frame.contains(point) }), hit.pid != own else { return nil }
        if hit.ownerName == "Dock" {
            noteSwitchInput(now: now, .app)
            return nil
        }
        let front = sys.frontmostPid()
        let elsewhere = sys.activeSpace().flatMap { active in sys.windowSpaces(hit.id).map { !$0.contains(active) } } ?? false
        let isTarget = boundTargetPids().contains(hit.pid)
        guard !flags.contains(.maskCommand), hit.pid != front || elsewhere || isTarget else { return nil }
        // A click on a window is for ITS app: it explains that app coming forward (and its desktop), nothing else.
        if elsewhere { noteSwitchInput(now: now, .desktop, target: hit.pid) }
        if hit.pid != front { noteSwitchInput(now: now, .app, target: hit.pid) }
        let space = elsewhere ? sys.windowSpaces(hit.id)?.first : sys.activeSpace()
        guardianLock.withLock { guardianCore.userClicked(app: hit.pid, space: space, now: now) }
        let name = appName(hit.pid)
        CULog.guardian.notice("the user clicked into \(name, privacy: .public)'s window \(hit.id, privacy: .public): their place now")
        if isTarget, sys.frontmostPid() != hit.pid {
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
                          userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
                          keycode: type == .keyDown ? event.getIntegerValueField(.keyboardEventKeycode) : -1, now: core.clock.nowSeconds())
    }
    if type == .leftMouseDown {
        core.onPhysicalClick(at: event.location, userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
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
