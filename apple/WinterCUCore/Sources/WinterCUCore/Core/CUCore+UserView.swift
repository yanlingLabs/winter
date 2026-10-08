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
    /// is on, then waits up to 600 ms for the view to come back. Returns the view it ends on.
    @discardableResult
    func restoreUserView(_ before: CUUserView, user: pid_t) -> CUUserView {
        if before.space != nil, userView().space != before.space,
           let window = ax.element(ax.application(user), kAXFocusedWindowAttribute) {
            try? ax.perform(window, kAXRaiseAction)
        }
        _ = sys.activate(pid: user)
        var now = userView()
        let deadline = clock.nowMs() + (userViewSettleMs > 0 ? 600 : 0)
        while now != before, clock.nowMs() < deadline {
            usleep(30_000)
            now = userView()
        }
        return now
    }

    /// A bind or `useWindow` (which may launch the app, ask it to reopen, or ask it for a new window) checked
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

    /// Makes the bound window key in its app without raising it or activating the app (yabai's focus records),
    /// when the app is in the background and the private path is on. Returns the undo: the user's key window
    /// handed back.
    func keyWithoutRaise(_ t: CUTarget) -> (() -> Void)? {
        guard skyLight.canFocusWithoutRaise, let user = sys.frontmostPid(), user != t.pid else { return nil }
        let userWindow = ax.element(ax.application(user), kAXFocusedWindowAttribute).flatMap { ax.windowID($0) }
        let sky = skyLight
        let (tp, tw) = (t.pid, t.windowID)
        let undo = {
            if let userWindow { sky.restoreFocus(previousPid: user, previousWindowID: userWindow, targetPid: tp, targetWindowID: tw) }
        }
        guard backgroundStep(.focusRecords, t, run: { sky.focusWithoutRaise(pid: tp, windowID: tw) }, undo: { _ = undo() })
        else { return nil }
        CULog.act.notice("\(t.appName, privacy: .public): window \(tw, privacy: .public) made key without raising")
        return { _ = undo() }
    }

    /// Makes the bound window the app's main window (menu commands and keys apply to it), checked like any
    /// background step.
    func makeBoundWindowMain(_ t: CUTarget) {
        guard let w = try? windowElement(t), ax.bool(w, kAXMainAttribute) != true else { return }
        _ = backgroundStep(.axMain, t, run: { (try? ax.set(w, kAXMainAttribute, kCFBooleanTrue)) != nil }, undo: {})
    }
}
