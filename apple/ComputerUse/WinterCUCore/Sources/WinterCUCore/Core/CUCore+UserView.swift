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
            usleep(20_000)
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
        let route = { (o: ActOutcome?) in "\(Self.actionName(p.action)) (\(o.map { Self.routeName($0.rung) } ?? "failed"))" }
        let outcome: ActOutcome
        do {
            outcome = try body()
        } catch {
            // The error is the result; what moved is said with the next one.
            checkAfterAct(before, t, seq: seq, route: route(nil))
            throw error
        }
        checkAfterAct(before, t, seq: seq, route: route(outcome))
        let notes = t.takeViewNotes()
        guard !notes.isEmpty else { return outcome }
        return ActOutcome(rung: outcome.rung, detail: ([outcome.detail].compactMap { $0 } + notes).joined(separator: "; "))
    }

    private func checkAfterAct(_ before: CUUserView, _ t: CUTarget, seq: Int, route: String) {
        guard !t.consentedForeground else { return }
        let after = view(after: before, settleMs: userViewSettleMs)
        if after != before {
            t.addViewNote(viewMoved(before, after, t, route: route, late: false))
        } else if userViewLateCheck {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.lateCheck(before, t, seq: seq, route: route)
            }
        }
    }

    /// 300 ms on: only the target having taken the front is undone this late (anything else may be the user's
    /// own doing by now), and only while no newer act has started.
    func lateCheck(_ before: CUUserView, _ t: CUTarget, seq: Int, route: String) {
        guard t.actSeq == seq, !t.consentedForeground else { return }
        let now = userView()
        guard now.front == t.pid, before.front != t.pid else { return }
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
        // Undone only when it is the target's doing: it took the front, or the desktop moved under this act.
        guard let user = before.front, user != pid, targetFront || (spaceMoved && !late) else { return what }
        let back = restoreUserView(before, user: user)
        if back == before { return what + " — the user's \(spaceMoved ? "desktop and app were" : "app was") put back" }
        if spaceMoved, back.space != before.space {
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
    @discardableResult
    func restoreUserView(_ before: CUUserView, user: pid_t, window recorded: AXUIElement? = nil) -> CUUserView {
        if before.space != nil, userView().space != before.space,
           let window = recorded ?? ax.element(ax.application(user), kAXFocusedWindowAttribute) {
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
        while now != before, clock.nowMs() < deadline {
            usleep(30_000)
            now = userView()
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

    /// A bind or `useWindow` (which may launch the app or move its window here) checked
    /// like an act: what moved the user's view is put back where it is the app's doing, and said.
    func viewNoteAfterBind(_ before: CUUserView, app: String, pid: pid_t, route: String) -> String? {
        let after = view(after: before, settleMs: userViewSettleMs)
        guard after != before else { return nil }
        return viewMoved(before, after, app: app, pid: pid, route: route, late: false)
    }

    // MARK: background steps, checked every time

    func isRetired(_ step: CUBackgroundStep) -> Bool { retiredStepsLock.withLock { retiredSteps.contains(step) } }

    /// Runs a background step and checks the user's view `stepSettleMs` later. A step that moved it is undone,
    /// the view restored, the act told, and the step never used again. False: skipped, failed or undone.
    func backgroundStep(_ step: CUBackgroundStep, _ t: CUTarget, run: () -> Bool, undo: () -> Void) -> Bool {
        guard !isRetired(step) else { return false }
        let before = userView()
        guard run() else { return false }
        let after = view(after: before, settleMs: stepSettleMs)
        guard after != before else { return true }
        undo()
        retiredStepsLock.withLock { _ = retiredSteps.insert(step) }
        let said = viewMoved(before, after, t, route: step.rawValue, late: false)
        t.addViewNote("\(said) (\(step.rawValue) is no longer used)")
        return false
    }

    /// Makes the bound window key without raising it or activating the app (yabai's focus records), when the
    /// app is in the background and the private path is on. Returns the undo: the user's key window handed back.
    /// The user's app resigns active while it lasts, so it is used ONLY inside the focus blip (`beginBlip`, with
    /// the keyboard reroute on) — never for typing, clicks or reads.
    func keyWithoutRaise(_ t: CUTarget) -> (() -> Void)? {
        guard skyLight.canFocusWithoutRaise, let user = sys.frontmostPid(), user != t.pid else { return nil }
        let userWindow = ax.element(ax.application(user), kAXFocusedWindowAttribute).flatMap { ax.windowID($0) }
        let sky = skyLight
        let (tp, tw) = (t.pid, t.windowID)
        let undo = { [self] in
            if let userWindow { sky.restoreFocus(previousPid: user, previousWindowID: userWindow, targetPid: tp, targetWindowID: tw) }
            // The hand-back's defocus leaves the app with NO key window (measured) — while accessibility may still name
            // a focused element in its main window. Remembered, so the next make-key step does not take it for key.
            noteStranded(tp, true)
        }
        // The focus record makes the app active, but its key window is the one it already had: after an earlier
        // blip's hand-back the app holds NO key window, and a later blip left it so (live 2026-10-10: the second
        // paste of a run read Edit › Paste disabled and took no ⌘V; keys for the Docs window went nowhere). Once the
        // app has taken the activation, the bound window is made its key window — only when it is not (`makeKeyInApp`).
        var made = "no make-key step"
        guard backgroundStep(.focusRecords, t, run: { [self] in
            guard sky.focusWithoutRaise(pid: tp, windowID: tw) else { return false }
            made = makeKeyInApp(t) { [self] in
                // After the deactivation the app is told it is active again (the blip keeps it so), to the app alone.
                noteSyntheticActivation()
                _ = focusEnforcer(for: t, privatePath: true)?.forceActivation(windowID: tw)
            }
            return true
        }, undo: { _ = undo() })
        else { return nil }
        CULog.act.notice("\(t.appName, privacy: .public): window \(tw, privacy: .public) made key without raising (\(made, privacy: .public))")
        return { _ = undo() }
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
            return .leave("its focus is in no window accessibility can name")
        }
        if let id = ax.windowID(w) { if id == t.windowID { return .key } } else if let bound, CFEqual(w, bound) { return .key }
        let sub = ax.string(w, kAXSubroleAttribute)
        guard ax.string(w, kAXRoleAttribute) == kAXWindowRole, sub == nil || sub == kAXStandardWindowSubrole else {
            return .leave("another of its windows (\(sub ?? "a panel")) holds the keys")
        }
        return .otherKey
    }

    /// Transient UI of the app is open — a menu (AppKit's menu window, layer 101, or one accessibility lists), a
    /// popover, a sheet: an on-screen window of the app at the normal or menu level that accessibility does not list
    /// among its windows. The make-key records and the deactivation would close it (measured on 2026-10-11 with a
    /// probe app of our own: an open context menu and a transient popover both closed), so nothing is sent.
    func transientUIOpen(_ t: CUTarget) -> Bool {
        let app = ax.application(t.pid)
        let listed = Set(ax.elements(app, kAXWindowsAttribute).compactMap { ax.windowID($0) })
        let unlisted = sys.windowStack().contains {
            $0.pid == t.pid && $0.id != t.windowID && !listed.contains($0.id) && ($0.layer == 0 || $0.layer == 101)
                && $0.alpha > 0.05 && $0.frame.width >= 4 && $0.frame.height >= 4
        }
        if unlisted { return true }
        guard let bound = try? windowElement(t) else { return false }
        return !Self.openMenus(app: app, boundWindow: bound, ax: ax).isEmpty
    }

    /// The bound window made its app's KEY window, after an activation the caller just posted (the blip's focus
    /// record, or a click's synthetic activation) — and only when it is not already: nothing while transient UI is
    /// open; nothing when it is key; the records alone when the app holds no key window; for another standard window
    /// key, the deactivation, `keySwitchGapMs`, `reactivate`, then the records. The window server's front is read
    /// again right before the deactivation and before the records: if the user brought the app forward meanwhile,
    /// nothing more is sent (their own key window is never touched). Returns what it did, for the log.
    func makeKeyInApp(_ t: CUTarget, reactivate: () -> Void) -> String {
        guard makeKeyApplies(t) else { return "the make-key step does not apply" }
        if transientUIOpen(t) { return "left as it is: a menu, popover or sheet of the app is open" }
        // The activation is taken a moment later: a key window it brings back shows then. An app our own hand-back
        // left with no key window is known to hold none, whatever accessibility says.
        let stranded = isStranded(t.pid)
        var decision: KeyInApp = stranded ? .noKeyWindow : keyInApp(t)
        let deadline = clock.nowMs() + keyInAppSettleMs
        while !stranded, decision == .noKeyWindow, clock.nowMs() < deadline {
            usleep(10_000)
            decision = keyInApp(t)
        }
        let inFront = { [self] in sys.frontmostPid() == t.pid }
        switch decision {
        case .key:
            return "already its app's key window"
        case .leave(let why):
            return "left as it is: \(why)"
        case .noKeyWindow:
            guard !inFront() else { return "stopped: the app came to the front" }
            guard skyLight.makeKeyWindow(pid: t.pid, windowID: t.windowID) else { return "make-key records refused" }
            noteStranded(t.pid, false)
            return "the app held no key window — make-key records"
        case .otherKey:
            guard !inFront() else { return "stopped: the app came to the front" }
            releaseOtherKeyWindow(t)
            reactivate()
            guard !inFront() else { return "stopped: the app came to the front" }
            guard skyLight.makeKeyWindow(pid: t.pid, windowID: t.windowID) else { return "make-key records refused" }
            noteStranded(t.pid, false)
            return "another of its windows was key — it resigned, then make-key records"
        }
    }

    /// Apps a blip's hand-back left with no key window (until the make-key step names one, or the app is activated).
    func noteStranded(_ pid: pid_t, _ stranded: Bool) {
        strandLock.withLock { if stranded { strandedPids.insert(pid) } else { strandedPids.remove(pid) } }
    }

    func isStranded(_ pid: pid_t) -> Bool { strandLock.withLock { strandedPids.contains(pid) } }

    /// The synthetic deactivation, so another of the app's windows resigns key, then `keySwitchGapMs` for the
    /// app to take it before the records that follow (live: with no gap one switch in six was lost; 20 ms
    /// and up, none in twelve).
    func releaseOtherKeyWindow(_ t: CUTarget) {
        guard let enforcer = focusEnforcer(for: t, privatePath: true) else { return }
        noteSyntheticActivation()  // the guardian must not read it as the user's
        if enforcer.deactivate(), keySwitchGapMs > 0 { usleep(useconds_t(keySwitchGapMs * 1000)) }
    }

    /// Before a window-targeted click in the background: the synthetic activation, then the bound window made its
    /// app's key window when it is not (`makeKeyInApp`), so the click reaches the page instead of being taken as
    /// the click that makes the window key (AppKit's first click; live: the page's own “Tools” menu never opened, a
    /// click on a canvas only made its window key). Never when the click goes to another window of the app (a sheet,
    /// popover or panel under the point: `clickWindow`). Posted to the app alone: nothing is raised, nothing
    /// activates, the user's key focus stays. False — nothing posted — when it does not apply (the private path off,
    /// the click elsewhere, no enforcer); a caller that posted the synthetic activation alone before still does.
    @discardableResult
    func keyForClick(_ t: CUTarget, privatePath: Bool, clickWindow: UInt32) -> Bool {
        guard privatePath, clickWindow == t.windowID, makeKeyApplies(t), let enforcer = focusEnforcer(for: t, privatePath: true) else {
            return false
        }
        noteSyntheticActivation()
        _ = enforcer.forceActivation(windowID: t.windowID)
        let made = makeKeyInApp(t) { [self] in
            noteSyntheticActivation()
            _ = enforcer.forceActivation(windowID: t.windowID)
        }
        CULog.act.notice("click in \(t.appName, privacy: .public): window \(t.windowID, privacy: .public) — \(made, privacy: .public)")
        return true
    }

    /// Makes the bound window the app's main window (menu commands and keys apply to it), checked like any
    /// background step.
    func makeBoundWindowMain(_ t: CUTarget) {
        // Capture-only: the cached "window" is the application element — never written.
        guard t.accessible, let w = try? windowElement(t), ax.bool(w, kAXMainAttribute) != true else { return }
        _ = backgroundStep(.axMain, t, run: { (try? ax.set(w, kAXMainAttribute, kCFBooleanTrue)) != nil }, undo: {})
    }
}
