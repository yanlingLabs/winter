import AppKit
import ApplicationServices
import Foundation

/// What the user is looking at: the active Space and the frontmost app.
struct CUUserView: Equatable, Sendable {
    var space: UInt64?
    var front: pid_t?
}

/// Background steps that touch the app's key or main window. Nothing proves in advance that an app takes one
/// quietly, so each use is checked, and one that ever moved the user's view is not used again.
enum CUBackgroundStep: String, Sendable {
    case focusRecords = "key focus without raise (focus records)"
    case axMain = "AXMain on the bound window"
}

/// The user-view guard: everything Winter does in the background must leave the user where they are — on
/// their desktop (Space), in their app. Only the consented foreground rung may bring the target forward.
///
/// Every act is checked: the active Space and the front process before, and again after (waiting up to
/// `userViewSettleMs` for a reaction the act set off — an app that activates itself on a click in its
/// address field does so a few ms after the event), plus a late look 300 ms on. A move is logged as a fault
/// with the route, said in the result, and undone where it is the target's doing: the user's app is
/// re-activated at once, its key window raised in it first so macOS goes back to the desktop that window is
/// on (switching Spaces directly needs Dock injection, which Winter does not do).
extension CUCore {
    func userView() -> CUUserView { CUUserView(space: sys.activeSpace(), front: sys.frontmostPid()) }

    /// The view once it differs from `before`, or after `settleMs` when it doesn't.
    func view(after before: CUUserView, settleMs: Double) -> CUUserView {
        var now = userView()
        var waited = 0.0
        while now == before, waited < settleMs {
            clock.pause(ms: 20)
            waited += 20
            now = userView()
        }
        return now
    }

    /// One act under the guard (on the pid queue). Notes from this act's background steps, and from the late
    /// check of the act before, are added to its detail. A failed act's error is its result, so its notes wait
    /// for the next act that succeeds.
    func guardingUserView(_ p: TargetActParams, _ t: CUTarget, _ body: () throws -> ActOutcome) throws -> ActOutcome {
        let seq = t.beginAct()
        // Held in front for this script, or inside a desktop visit (the user agreed to either): the app being in
        // front is no view moved.
        if holdsForeground(t) || isVisiting(t) { t.consentedForeground = true }
        let before = userView()
        let startedAt = clock.nowSeconds()
        t.actStart = (before.front, before.space, startedAt)
        let route = { (o: ActOutcome?) in "\(Self.actionName(p.action)) (\(o.map { Self.routeName($0.rung) } ?? "failed"))" }
        let outcome: ActOutcome
        do {
            outcome = try body()
        } catch {
            // The act refused because the app came to the front meanwhile: that change is the user's (or the app's
            // own, which the guardian answers) — never "undone" here, which would pull the user back out of the app
            // they chose (review of round 4).
            if Self.isAppInFront(error) { throw error }
            // The error is the result; what moved is said with the next one.
            checkAfterAct(before, t, seq: seq, route: route(nil), since: startedAt)
            throw error
        }
        checkAfterAct(before, t, seq: seq, route: route(outcome), since: startedAt)
        let notes = t.takeViewNotes()
        guard !notes.isEmpty else { return outcome }
        return ActOutcome(rung: outcome.rung, detail: ([outcome.detail].compactMap { $0 } + notes).joined(separator: "; "))
    }

    private func checkAfterAct(_ before: CUUserView, _ t: CUTarget, seq: Int, route: String, since: TimeInterval) {
        guard !t.consentedForeground else { return }
        let after = view(after: before, settleMs: userViewSettleMs)
        if after != before {
            // The user's own move during the act (the one rule, from the act's start — uncapped: a long act's after-check
            // still sees switch input from its beginning): left alone.
            if isUsersMove(after, since: since, from: before, path: "\(route): the after-check") {
                CULog.act.notice("\(route, privacy: .public) in \(t.appName, privacy: .public): the user moved during it — left there")
                return
            }
            t.addViewNote(viewMoved(before, after, t, route: route, late: false))
        } else if userViewLateCheck {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.lateCheck(before, t, seq: seq, route: route, since: since)
            }
        }
    }

    /// 300 ms on: only the target having taken the front is undone this late (anything else may be the user's
    /// own doing by now), and only while no newer act has started — and never the user's own move.
    func lateCheck(_ before: CUUserView, _ t: CUTarget, seq: Int, route: String, since: TimeInterval? = nil) {
        guard t.actSeq == seq, !t.consentedForeground else { return }
        let now = userView()
        guard now.front == t.pid, before.front != t.pid else { return }
        if isUsersMove(now, since: since, from: before, path: "\(route): the late check") { return }
        t.addViewNote("after the previous action, " + viewMoved(before, now, t, route: route, late: true))
    }

    /// Logs a moved view as a fault, puts back what the target moved, and says what happened in one clause.
    func viewMoved(_ before: CUUserView, _ after: CUUserView, _ t: CUTarget, route: String, late: Bool) -> String {
        viewMoved(before, after, app: t.appName, pid: t.pid, route: route, late: late)
    }

    func viewMoved(_ before: CUUserView, _ after: CUUserView, app: String, pid: pid_t, route: String, late: Bool) -> String {
        let targetFront = after.front == pid && before.front != pid
        let spaceMoved = before.space != nil && after.space != nil && before.space != after.space
        CULog.act.fault("""
            \(route, privacy: .public) in \(app, privacy: .public) moved the user's view\(late ? " (late)" : "", privacy: .public): \
            front \(before.front.map(String.init) ?? "?", privacy: .public) → \(after.front.map(String.init) ?? "?", privacy: .public), \
            space \(before.space.map(String.init) ?? "?", privacy: .public) → \(after.space.map(String.init) ?? "?", privacy: .public)
            """)
        let what = targetFront && spaceMoved ? "\(app) activated itself and macOS switched desktops"
            : targetFront ? "\(app) activated itself"
            : spaceMoved ? "macOS switched desktops during the action"
            : "the frontmost app changed during the action"
        // Undone only when it is the target's doing: it took the front, or the desktop moved under this act. Put back to
        // the user's place AS IT IS NOW (I2) — the guardian's, else where the act began.
        guard let first = before.front, first != pid, targetFront || (spaceMoved && !late) else { return what }
        let place = guardianPlace().map { CUUserView(space: $0.space, front: $0.app) } ?? before
        guard let user = place.front, user != pid else { return what }
        let back = restoreUserView(place, user: user)
        if back == place { return what + " — the user's \(spaceMoved ? "desktop and app were" : "app was") put back" }
        if spaceMoved, back.space != place.space {
            return what + (back.front == user ? " — the user's app was put back in front, but macOS stayed on the other desktop (switching back needs the user)"
                                              : " — neither the user's app nor their desktop could be put back")
        }
        return what + " — the user's app could not be put back in front"
    }

    /// Re-activates the user's app, raising its key window first so macOS returns to the desktop that window
    /// is on, and retries the activation the way activateWithOptions does: again every `restoreRetryMs` while
    /// the app is not front, polling every 30 ms, until the view is back or `restoreDeadlineMs` (2 s) passes.
    /// Never on the main queue: the guardian dispatches it, and the per-act guard runs on the target's pid
    /// queue. Returns the view it ends on.
    /// `window`: the user's window to raise — recorded BEFORE something took them away (a desktop visit), since by
    /// now the app's focused window can be another one (the target's, when the user's app is the target app).
    /// `raiseFocused`: with no recorded window, raise the app's focused window (the guardian's restore); false raises
    /// nothing then (a visit's return, whose own choice of window found none of the user's).
    @discardableResult
    func restoreUserView(_ before: CUUserView, user: pid_t, window recorded: AXUIElement? = nil, raiseFocused: Bool = true) -> CUUserView {
        if before.space != nil, userView().space != before.space,
           let window = recorded ?? (raiseFocused ? ax.element(ax.application(user), kAXFocusedWindowAttribute) : nil) {
            try? ax.perform(window, kAXRaiseAction)
        }
        _ = sys.activate(pid: user)
        // A background process's activation can be refused (cooperative activation, macOS 14+; measured on 26.6:
        // refused for a whole 2 s); the app made frontmost over accessibility is not (~5 ms here, ~0.3 s across
        // desktops). Both, at once and on every retry.
        try? ax.set(ax.application(user), kAXFrontmostAttribute, kCFBooleanTrue)
        var lastActivate = clock.nowMs()
        var attempts = 1
        var now = userView()
        let deadline = lastActivate + restoreDeadlineMs
        let startedAt = clock.nowSeconds()
        let placeAtStart = guardianPlace()
        while now != before, clock.nowMs() < deadline {
            clock.pause(ms: 30)
            now = userView()
            // I2 — while it waits, the restore is never retried over the user: another app in front now is judged by the
            // one rule (their move ends the restore), and their place having moved on meanwhile ends it too (the model-
            // based test: a retry 22 ms after a Dock click of theirs pulled them back out of the app they chose).
            if guardianPlace() != placeAtStart { break }
            if let f = now.front, f != user, isUsersMove(now, since: startedAt, from: before, path: "a restore, before trying again") { break }
            if now.front != user, clock.nowMs() - lastActivate >= restoreRetryMs, clock.nowMs() < deadline {
                _ = sys.activate(pid: user)
                try? ax.set(ax.application(user), kAXFrontmostAttribute, kCFBooleanTrue)
                lastActivate = clock.nowMs()
                attempts += 1
                now = userView()
            }
        }
        if attempts > 1 {
            CULog.guardian.notice("restore: activated the user's app \(attempts, privacy: .public) times; \(now == before ? "back" : "not back within the deadline", privacy: .public)")
        }
        return now
    }

    /// A bind, `useWindow` or AppleScript (which may launch the app, reopen it, move its window here or run for
    /// minutes) checked like an act: a change of the user's view is judged by the one rule from the operation's start
    /// (`since`) — theirs is left alone; the app's own is put back to the user's place as it is NOW, and said.
    func viewNoteAfterBind(_ before: CUUserView, app: String, pid: pid_t, route: String, since: TimeInterval) -> String? {
        let after = view(after: before, settleMs: userViewSettleMs)
        guard after != before else { return nil }
        if isUsersMove(after, since: since, from: before, path: "\(route): the after-check") {
            CULog.act.notice("\(route, privacy: .public) in \(app, privacy: .public): the user moved during it — left there")
            return nil
        }
        return viewMoved(before, after, app: app, pid: pid, route: route, late: false)
    }

    // MARK: background steps, checked every time

    func isRetired(_ step: CUBackgroundStep) -> Bool { retiredStepsLock.withLock { retiredSteps.contains(step) } }

    enum StepResult: Equatable {
        /// Ran, and the user's view stayed (or the change was the user's own).
        case ran
        /// Not run: retired, or it failed.
        case notRun
        /// Ran and moved the user's view: undone, the view restored, the step retired.
        case undone
    }

    /// Runs a background step and checks the user's view `stepSettleMs` later. A step that moved it is undone,
    /// the view restored, the act told, and the step never used again.
    /// `usersOwn`: a change of the view that is the USER's doing (they brought the target forward themselves, with
    /// their own input) — never the step's: nothing undone, the step not retired, nobody pulled back out of the app they
    /// chose (review of round 4: a ⌘-Tab into the target during a typing burst retired the focus records for the
    /// helper's life and yanked the user back to their previous app).
    func backgroundStep(_ step: CUBackgroundStep, _ t: CUTarget, run: () -> Bool, undo: () -> Void,
                        usersOwn: (CUUserView) -> Bool = { _ in false }) -> StepResult {
        guard !isRetired(step) else { return .notRun }
        let before = userView()
        guard run() else { return .notRun }
        let after = view(after: before, settleMs: stepSettleMs)
        guard after != before else { return .ran }
        if usersOwn(after) {
            CULog.act.notice("\(step.rawValue, privacy: .public) in \(t.appName, privacy: .public): the user brought it forward meanwhile — their move, left as it is")
            return .ran
        }
        undo()
        retiredStepsLock.withLock { _ = retiredSteps.insert(step) }
        let said = viewMoved(before, after, t, route: step.rawValue, late: false)
        t.addViewNote("\(said) (\(step.rawValue) is no longer used)")
        return .undone
    }


    /// How a focus blip's start went (`keyWithoutRaise`).
    enum BlipStart {
        /// The focus records are unavailable or retired: no blip (nothing was posted).
        case unavailable
        /// Refused before anything was posted (the user's view untouched).
        case refusedBeforeAnything(CUError)
        /// The app activated itself on the focus record (no input of the user's behind it): undone, the user's view
        /// put back, the focus records retired — and nothing may be typed (review of round 4: the act typed on with no
        /// blip, into the app's key window).
        case undone(CUError)
        /// The bound window holds the key focus; `undo` hands it back.
        case keyed(undo: () -> Void)
        /// Posted, then refused: the blip must END the ordinary way (hand-back, the wait for the user's app, the
        /// guardian's restore) before the refusal is thrown.
        case refused(undo: () -> Void, CUError)
        /// The user brought the target app forward meanwhile: refused, and the key focus is theirs — never handed back
        /// (that would pull them out of the app they chose).
        case userTookTheApp(CUError)
    }

    /// Makes the bound window key without raising it or activating the app (yabai's focus records), when the
    /// app is in the background and the private path is on. Its undo hands the key focus back to the user's window —
    /// the one accessibility names, else their app's frontmost window as the window server lists it, else none named
    /// (the defocus still goes to the target; the blip's end restores the user's app if their key focus is not back).
    /// The user's app resigns active while it lasts, so it is used ONLY inside the focus blip (`beginBlip`, with
    /// the keyboard reroute on) — never for typing, clicks or reads. A REFUSAL (`focus_not_placed`, `app_in_front`):
    /// the bound window could not be made the one the app's keys go to — a panel, dialog or another app window holds
    /// them, where they would go can't be told, or the app came to the front meanwhile: keys (and a menu command, which
    /// acts where the keys go) sent then would land in another window (review of round 3). What can be decided without
    /// the focus record (the app's window list unreadable) is refused before anything is posted.
    func keyWithoutRaise(_ t: CUTarget) -> BlipStart {
        guard skyLight.canFocusWithoutRaise, let user = sys.frontmostPid(), user != t.pid else { return .unavailable }
        if makeKeyApplies(t), case .unknown(let why) = transientUI(t) {
            return .refusedBeforeAnything(CUError.refused(.focusNotPlaced, "where \(t.appName)'s keys would go can't be told (\(why)), so nothing was typed — try again, or click the field first"))
        }
        // The hand-back names the user's window accessibility names — else NONE, and the app takes back its own key
        // window (measured 2026-10-11 on probe apps of ours: a window-0 record gave each its key window back — the one
        // that had been key, not the frontmost one the window server lists, which round 6 named and which made the wrong
        // window key: review of round 6, a Finder window behind other apps over the desktop's selection).
        let userWindow = ax.element(ax.application(user), kAXFocusedWindowAttribute).flatMap { ax.windowID($0) }
        let sky = skyLight
        let (tp, tw) = (t.pid, t.windowID)
        let undo = { [self] in
            // With no window of theirs to name, the record still takes the key focus from the target (review of round 4:
            // nothing at all was posted then, and the target kept the user's keys).
            sky.restoreFocus(previousPid: user, previousWindowID: userWindow ?? 0, targetPid: tp, targetWindowID: tw)
            // The hand-back's defocus leaves the app with NO key window (measured) — while accessibility may still name
            // a focused element in its main window. Remembered, so the next make-key step does not take it for key.
            noteStranded(tp, true)
        }
        // The focus record makes the app active, but its key window is the one it already had: after an earlier
        // blip's hand-back the app holds NO key window, and a later blip left it so (live 2026-10-10: the second
        // paste of a run read Edit › Paste disabled and took no ⌘V; keys for the Docs window went nowhere). Once the
        // app has taken the activation, the bound window is made its key window — only when it is not (`makeKeyInApp`).
        var made = MakeKeyOutcome.notApplicable
        let stepStart = clock.nowSeconds()
        let startView = userView()
        // Whose move a change during the step is: the one rule, never the step's own guess.
        let usersMove = { [self] (now: CUUserView) -> Bool in
            isUsersMove(now, since: stepStart, from: startView, path: "the focus blip's make-key step")
        }
        let step = backgroundStep(.focusRecords, t, run: { [self] in
            // The focus record is a synthetic event too: an activation right after it is not the user's by itself
            // (review of round 6: only the other-key-window step marked one).
            noteSyntheticActivation(tp)
            guard sky.focusWithoutRaise(pid: tp, windowID: tw) else { return false }
            made = makeKeyInApp(t) { [self] in
                // After the deactivation the app is told it is active again (the blip keeps it so), to the app alone.
                noteSyntheticActivation(tp)
                _ = focusEnforcer(for: t, privatePath: true)?.forceActivation(windowID: tw)
            }
            return true
        }, undo: { _ = undo() }, usersOwn: usersMove)
        switch step {
        case .notRun:
            return .unavailable
        case .undone:
            return .undone(activatedItselfRefusal(t))
        case .ran:
            break
        }
        CULog.act.notice("\(t.appName, privacy: .public): window \(tw, privacy: .public) made key without raising (\(made.words, privacy: .public))")
        // The front moved during the step after its settle (or the user's move it already judged): judged again, by the
        // same rule — the user's: no hand-back; the app's own: the blip ends the ordinary way, which puts them back.
        if let front = sys.frontmostPid(), front != user {
            if isUsersMove(userView(), since: stepStart, from: startView, path: "the focus blip's make-key step, after it") {
                CULog.act.notice("\(t.appName, privacy: .public): nothing sent in the focus blip — the user moved (front \(front, privacy: .public))")
                return .userTookTheApp(usersMoveRefusal(t, front: front, typed: false))
            }
            return .refused(undo: undo, activatedItselfRefusal(t))
        }
        if let refusal = keysRefusal(made, t) {
            CULog.act.notice("\(t.appName, privacy: .public): nothing sent in the focus blip — \(refusal.message, privacy: .public)")
            return .refused(undo: undo, refusal)
        }
        return .keyed(undo: undo)
    }

    /// The user moved — into the target app, or to another app — while keys were about to go (or going) to it.
    func usersMoveRefusal(_ t: CUTarget, front: pid_t, typed: Bool) -> CUError {
        let stop = typed ? "the typing was stopped" : "nothing was typed"
        let msg = front == t.pid
            ? "\(t.appName) came to the front — the user brought it forward (their switch: ⌘-Tab, a click, the Dock), so \(stop); check state(), and try again if it is still wanted"
            : "the user switched to another app while keys were going to \(t.appName), so \(stop) — they were left where they went; check state(), and try again if it is still wanted"
        return CUError.refused(.appInFront, msg)
    }

    /// The target activated itself (no switch of the user's behind it): undone, the user's app put back.
    func activatedItselfRefusal(_ t: CUTarget) -> CUError {
        CUError.refused(.focusNotPlaced, "\(t.appName) activated itself when its window was being made key; the user's app was put back and nothing was typed — check state(), and try again")
    }

    /// Whether keys may go out after the make-key step: yes when it did not apply, the window was key already, or the
    /// records named it; otherwise only when the app's keys go to the bound window anyway (a popover or context menu of
    /// it, a sheet on it) — never while where they go can't be told, or the app came to the front.
    func keysRefusal(_ made: MakeKeyOutcome, _ t: CUTarget) -> CUError? {
        switch made {
        case .notApplicable, .alreadyKey, .made:
            return nil
        case .appInFront:
            return CUError.refused(.appInFront, "\(t.appName) came to the front while its window was being made key — the user may be using it now, so nothing was typed; check state(), and try again if it is still wanted")
        case .unknown(let why):
            return CUError.refused(.focusNotPlaced, "where \(t.appName)'s keys would go can't be told (\(why)), so nothing was typed — try again, or click the field first")
        case .recordsRefused:
            return CUError.refused(.focusNotPlaced, "\(t.appName)'s window could not be made its key window, so nothing was typed — click the field first, or use setValue(ref, text) if it takes a value")
        case .transientOpen, .left:
            switch whereKeysGo(t) {
            case .boundWindow:
                return nil
            case .elsewhere(let what):
                return CUError.refused(.focusNotPlaced, "\(t.appName)'s keys go to \(what), not the bound window, so nothing was typed — close it or ask the user to, or bind that window with useWindow if it is the one meant")
            case .unknown(let why):
                return CUError.refused(.focusNotPlaced, "where \(t.appName)'s keys would go can't be told (\(why)), so nothing was typed — click the field first")
            }
        }
    }

    enum KeysGo: Equatable { case boundWindow, elsewhere(String), unknown(String) }

    /// Where the app's keys go now, by its focused element: the bound window (its element, a popover or context menu of
    /// it — their elements name it as their window, measured with a probe app of our own — or a sheet on it), another
    /// of its windows (named), or unknown.
    func whereKeysGo(_ t: CUTarget) -> KeysGo {
        guard let f = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute) else {
            return .unknown("it reports no focused element")
        }
        let bound = try? windowElement(t)
        let isBound = { [self] (w: AXUIElement) -> Bool in
            if let id = ax.windowID(w) { return id == t.windowID }
            return bound.map { CFEqual(w, $0) } ?? false
        }
        let w: AXUIElement? = ax.string(f, kAXRoleAttribute) == kAXWindowRole ? f : ax.element(f, kAXWindowAttribute)
        guard let w else {
            if let bound, inBoundWindow(f, t, bound) == true { return .boundWindow }
            // An element with no window of its own (some Java, Qt and custom toolkits): the app's focused window says
            // whose it is (review of round 4: refused for good, the advice to click first looping).
            if boundWindowIsKeyInApp(t) == true { return .boundWindow }
            return .unknown("its focus is in no window accessibility can name")
        }
        if isBound(w) { return .boundWindow }
        // A sheet on the bound window: its own element, its parent the window.
        if ax.string(w, kAXRoleAttribute) == kAXSheetRole || ax.string(w, kAXSubroleAttribute) == "AXSheet",
           let parent = ax.element(w, kAXParentAttribute), isBound(parent) {
            return .boundWindow
        }
        let title = ax.string(w, kAXTitleAttribute).flatMap { $0.isEmpty ? nil : " \u{201C}\(String($0.prefix(60)))\u{201D}" } ?? ""
        switch ax.string(w, kAXSubroleAttribute) {
        case kAXFloatingWindowSubrole?, "AXSystemFloatingWindow"?: return .elsewhere("its floating window\(title)")
        case kAXDialogSubrole?, kAXSystemDialogSubrole?: return .elsewhere("its dialog\(title)")
        default: return .elsewhere("another of its windows\(title)")
        }
    }

    /// The make-key step may apply: the records can be posted, the app is in the background (the window server's
    /// front, read now), the bound window is on this desktop (a window on another Space keeps the routes it had), and
    /// the app is not Chromium-based unless measured otherwise (`makeKeyChromium`).
    func makeKeyApplies(_ t: CUTarget) -> Bool {
        guard t.accessible, skyLight.canFocusWithoutRaise, !t.isChromium || makeKeyChromium, sys.frontmostPid() != t.pid else { return false }
        return sys.window(id: t.windowID)?.onScreen == true
    }

    /// The app's key window as accessibility shows it, read after an activation: its focused element's window. A
    /// stranded app (no key window — after a blip's hand-back) answers NO focused element, while its
    /// `AXFocusedWindow` still names its main window (measured on 2026-10-11), so that attribute is never asked.
    enum KeyInApp: Equatable {
        /// The bound window is its app's key window: nothing is sent.
        case key
        /// The app holds no key window: the records alone name the bound one.
        case noKeyWindow
        /// Another STANDARD window of the app is key: the deactivation first (the records only take where no window
        /// is key), then the activation and the records.
        case otherKey
        /// Not touched, and why: a panel, sheet, dialog or popover holds the keys, or the focus can't be placed.
        case leave(String)
    }

    func keyInApp(_ t: CUTarget) -> KeyInApp {
        guard let f = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute) else { return .noKeyWindow }
        let bound = try? windowElement(t)
        let w: AXUIElement? = ax.string(f, kAXRoleAttribute) == kAXWindowRole ? f : ax.element(f, kAXWindowAttribute)
        guard let w else {
            if let bound, inBoundWindow(f, t, bound) == true { return .key }
            // No window of its own (some Java, Qt and custom toolkits typed into before round 4): the app's focused
            // window is the bound one.
            if boundWindowIsKeyInApp(t) == true { return .key }
            return .leave("its focus is in no window accessibility can name")
        }
        if let id = ax.windowID(w) { if id == t.windowID { return .key } } else if let bound, CFEqual(w, bound) { return .key }
        let sub = ax.string(w, kAXSubroleAttribute)
        guard ax.string(w, kAXRoleAttribute) == kAXWindowRole, sub == nil || sub == kAXStandardWindowSubrole else {
            return .leave("another of its windows (\(sub ?? "a panel")) holds the keys")
        }
        return .otherKey
    }

    enum TransientUI: Equatable {
        case none
        case open(String)
        /// It can't be told: accessibility did not list the app's windows (a timeout reads as an empty list), or a
        /// window it lists could not be identified while an unlisted one is on screen.
        case unknown(String)
    }

    /// Transient UI of the app — a menu (AppKit's menu window, layer 101, or one accessibility lists), a popover, a
    /// sheet: an on-screen window of the app at the normal or menu level that accessibility does not list among its
    /// windows. The make-key records and the deactivation would close it (measured on 2026-10-11 with a probe app of
    /// our own: an open context menu and a transient popover both closed), so nothing is sent while one is open — or
    /// while that can't be told: an unreadable window list made every other window of the app look "unlisted" (review
    /// of round 3), so a list that can't be read is unknown, never "none" and never "open".
    func transientUI(_ t: CUTarget) -> TransientUI {
        let app = ax.application(t.pid)
        guard let raw = ax.attribute(app, kAXWindowsAttribute), CFGetTypeID(raw) == CFArrayGetTypeID(),
              let list = raw as? [AXUIElement], !list.isEmpty else {
            return .unknown("accessibility did not list \(t.appName)'s windows")
        }
        var listed = Set<UInt32>()
        var unidentified = 0
        for w in list { if let id = ax.windowID(w) { listed.insert(id) } else { unidentified += 1 } }
        let unlisted = sys.windowStack().filter {
            $0.pid == t.pid && $0.id != t.windowID && !listed.contains($0.id) && ($0.layer == 0 || $0.layer == 101)
                && $0.alpha > 0.05 && $0.frame.width >= 4 && $0.frame.height >= 4
        }
        if unlisted.contains(where: { $0.layer == 101 }) { return .open("a menu of the app is open") }
        if !unlisted.isEmpty {
            // A listed window that could not be identified may be the one that looks unlisted.
            if unidentified > 0 { return .unknown("a window of \(t.appName) could not be identified") }
            return .open("a popover or sheet of the app is open")
        }
        guard let bound = try? windowElement(t) else { return .none }
        return Self.openMenus(app: app, boundWindow: bound, ax: ax).isEmpty ? .none : .open("a menu of the app is open")
    }

    /// What the make-key step did (`makeKeyInApp`).
    enum MakeKeyOutcome: Equatable {
        /// It does not apply here (no records possible, Chromium, the app in front, the window off this desktop).
        case notApplicable
        /// Transient UI of the app is open: nothing sent.
        case transientOpen(String)
        /// Whether transient UI is open can't be told: nothing sent.
        case unknown(String)
        /// Already its app's key window: nothing sent.
        case alreadyKey
        /// Not touched: a panel, dialog or sheet holds the keys, or the focus is in no window accessibility can name.
        case left(String)
        /// The app came to the front meanwhile (the user's doing, or its own): nothing more sent.
        case appInFront
        /// The records could not be posted.
        case recordsRefused
        /// The records were sent (after the deactivation, when another window was key).
        case made(String)

        var words: String {
            switch self {
            case .notApplicable: return "the make-key step does not apply"
            case .transientOpen(let why): return "left as it is: \(why)"
            case .unknown(let why): return "left as it is: \(why)"
            case .alreadyKey: return "already its app's key window"
            case .left(let why): return "left as it is: \(why)"
            case .appInFront: return "stopped: the app came to the front"
            case .recordsRefused: return "make-key records refused"
            case .made(let how): return how
            }
        }
    }

    /// The bound window made its app's KEY window, after an activation the caller just posted (the blip's focus
    /// record, or a click's synthetic activation) — and only when it is not already: nothing while transient UI is
    /// open (or that can't be told); nothing when it is key; the records alone when the app holds no key window; for
    /// another standard window key, the deactivation, `keySwitchGapMs`, `reactivate`, then the records. The window
    /// server's front is read again right before the deactivation and before the records: if the user brought the app
    /// forward meanwhile, nothing more is sent (their own key window is never touched).
    func makeKeyInApp(_ t: CUTarget, reactivate: () -> Void) -> MakeKeyOutcome {
        // Every caller checked the app was in the background before its activation: in front now, it came forward.
        if sys.frontmostPid() == t.pid { return .appInFront }
        guard makeKeyApplies(t) else { return .notApplicable }
        switch transientUI(t) {
        case .open(let why):
            // An app our own hand-back left with no key window: what is still open survived that loss of the key
            // focus — not a menu or a transient popover (they close with it; measured with a probe app of ours), but an
            // attached completion or autocomplete window of the bound window (review of round 4: refused at a typing
            // run's second burst). The keys must reach the window, so it is named as for an app with no key window
            // (the next key opens such a list again) — unless the keys provably go to another window.
            if isStranded(t.pid), case .elsewhere = whereKeysGo(t) { return .transientOpen(why) }
            if !isStranded(t.pid) { return .transientOpen(why) }
            CULog.act.notice("\(t.appName, privacy: .public): \(why, privacy: .public), and the app holds no key window after our hand-back — an attached list; the window is named")
        case .unknown(let why): return .unknown(why)
        case .none: break
        }
        // The activation is taken a moment later: a key window it brings back shows then — read every time, the app's
        // own answer (review of round 3: a stale "stranded" mark, left from an earlier script while another window of
        // the app was made key by the user, skipped this read; the records alone don't take over a key window, and the
        // keys went into the other one). The mark only overrides a `.key` answer (accessibility can name a focused
        // element in a window that is no longer key after our hand-back), never another window's.
        let stranded = isStranded(t.pid)
        var decision = keyInApp(t)
        let deadline = clock.nowMs() + keyInAppSettleMs
        while decision == .noKeyWindow, clock.nowMs() < deadline {
            clock.pause(ms: 10)
            decision = keyInApp(t)
        }
        if stranded, decision == .key { decision = .noKeyWindow }
        let inFront = { [self] in sys.frontmostPid() == t.pid }
        switch decision {
        case .key:
            return .alreadyKey
        case .leave(let why):
            return .left(why)
        case .noKeyWindow:
            guard !inFront() else { return .appInFront }
            guard skyLight.makeKeyWindow(pid: t.pid, windowID: t.windowID) else { return .recordsRefused }
            noteStranded(t.pid, false)
            return .made("the app held no key window — make-key records")
        case .otherKey:
            guard !inFront() else { return .appInFront }
            releaseOtherKeyWindow(t)
            reactivate()
            guard !inFront() else { return .appInFront }
            guard skyLight.makeKeyWindow(pid: t.pid, windowID: t.windowID) else { return .recordsRefused }
            noteStranded(t.pid, false)
            return .made("another of its windows was key — it resigned, then make-key records")
        }
    }

    /// Apps a blip's hand-back left with no key window — until the make-key step names one, the app is really activated
    /// (by anyone: the always-on activation observer, `appActivated`), its last target is lost, or its pid dies. Never
    /// tied to the guardian's life (round 4 forgot the marks when it stopped, 3 s after a script: the next script's
    /// first click into the Docs page read the stale "key" answer, sent no records, and the click only made the window
    /// key — the page's menu never opened, live 2026-10-11).
    func noteStranded(_ pid: pid_t, _ stranded: Bool) {
        strandLock.withLock { if stranded { strandedPids.insert(pid) } else { strandedPids.remove(pid) } }
    }

    func isStranded(_ pid: pid_t) -> Bool { strandLock.withLock { strandedPids.contains(pid) } }

    /// An app was activated (NSWorkspace): it holds its key window again, so its mark goes — when it is the front app as
    /// the notification is handled. A notification that comes late, the app no longer in front (one our own focus records
    /// set off, delivered after the blip's hand-back re-marked it), changes nothing.
    func appActivated(pid: pid_t) {
        guard sys.frontmostPid() == pid else { return }
        noteStranded(pid, false)
    }

    /// The synthetic deactivation, so another of the app's windows resigns key, then `keySwitchGapMs` for the
    /// app to take it before the records that follow (live: with no gap one switch in six was lost; 20 ms
    /// and up, none in twelve).
    func releaseOtherKeyWindow(_ t: CUTarget) {
        guard let enforcer = focusEnforcer(for: t, privatePath: true) else { return }
        noteSyntheticActivation(t.pid)  // the guardian must not read it as the user's
        if enforcer.deactivate(), keySwitchGapMs > 0 { clock.pause(ms: keySwitchGapMs) }
    }

    /// Before a window-targeted click in the background: the synthetic activation, then the bound window made its
    /// app's key window when it is not (`makeKeyInApp`), so the click reaches the page instead of being taken as
    /// the click that makes the window key (AppKit's first click; live: the page's own “Tools” menu never opened, a
    /// click on a canvas only made its window key). Never when the click goes to another window of the app (a sheet,
    /// popover or panel under the point: `clickWindow`). Posted to the app alone: nothing is raised, nothing
    /// activates, the user's key focus stays. `.notApplied` — nothing posted — when it does not apply (the private
    /// path off, the click elsewhere, no enforcer); a caller that posted the synthetic activation alone before still
    /// does. `.appInFront`: the app came to the front meanwhile (review of round 3: the click went out anyway, into what
    /// was now the user's front app) — the caller sends no click (`clickRefusal`).
    /// `.activatedItself`: it came to the front by its own doing (the one decision, `classifyMove`) — not sent either.
    enum ClickPrep: Equatable { case notApplied, prepared, appInFront, activatedItself }

    func keyForClick(_ t: CUTarget, privatePath: Bool, clickWindow: UInt32) -> ClickPrep {
        guard privatePath, clickWindow == t.windowID, makeKeyApplies(t), let enforcer = focusEnforcer(for: t, privatePath: true) else {
            return .notApplied
        }
        let prepStart = clock.nowSeconds()
        let startView = userView()
        noteSyntheticActivation(t.pid)
        _ = enforcer.forceActivation(windowID: t.windowID)
        let made = makeKeyInApp(t) { [self] in
            noteSyntheticActivation(t.pid)
            _ = enforcer.forceActivation(windowID: t.windowID)
        }
        CULog.act.notice("click in \(t.appName, privacy: .public): window \(t.windowID, privacy: .public) — \(made.words, privacy: .public)")
        guard made == .appInFront || sys.frontmostPid() == t.pid else { return .prepared }
        // Whose move it was decides (review of round 6: the synthetic marks just posted made the guardian take a ⌘-Tab of
        // the user's for a theft and pull them back out): the user's → told to the guardian, the click not sent; the
        // app's own → not sent, and the guardian puts the user back.
        return isUsersMove(userView(), since: prepStart, from: startView, path: "a background click's preparation") ? .appInFront : .activatedItself
    }

    /// The click not sent because the app activated itself while it was being prepared.
    func clickActivatedItselfRefusal(_ t: CUTarget) -> CUError {
        CUError.refused(.focusNotPlaced, "\(t.appName) activated itself while the click was being prepared; the user's app is put back and the click was not sent — check state(), and try again")
    }

    /// An `app_in_front` refusal.
    static func isAppInFront(_ error: Error) -> Bool {
        guard let e = error as? CUError, e.code == "refused" else { return false }
        return e.data?["reason"] == .string(CUFloorReason.appInFront.rawValue)
    }

    /// The click not sent because the app came to the front while it was being prepared.
    func clickRefusal(_ t: CUTarget) -> CUError {
        CUError.refused(.appInFront, "\(t.appName) came to the front while the click was being prepared — the user may be using it now, so the click was not sent; check state(), and click again if it is still wanted")
    }

    /// Makes the bound window the app's main window (menu commands and keys apply to it), checked like any
    /// background step.
    func makeBoundWindowMain(_ t: CUTarget) {
        // Capture-only: the cached "window" is the application element — never written.
        guard t.accessible, let w = try? windowElement(t), ax.bool(w, kAXMainAttribute) != true else { return }
        let start = clock.nowSeconds()
        let startView = userView()
        noteGuardianCause(t.pid, raise: true)  // a main-window write can bring the window's desktop forward
        // A change meanwhile is judged by the one rule (review of round 7: it was always the step's).
        _ = backgroundStep(.axMain, t, run: { (try? ax.set(w, kAXMainAttribute, kCFBooleanTrue)) != nil }, undo: {},
                           usersOwn: { [self] in isUsersMove($0, since: start, from: startView, path: "making the bound window main") })
    }
}
