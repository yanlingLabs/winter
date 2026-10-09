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

    func onActivation(pid: pid_t) {
        let now = clock.nowSeconds()
        let userInput = secondsSinceUserInput < CUFocusGuardianCore.userInputWindow
        let synthetic = now - lastSyntheticActivationAt < Self.guardianSyntheticWindow
        let activation = CUActivation(app: pid, space: sys.activeSpace(), hadRecentUserInput: userInput, fromSyntheticEvent: synthetic)
        guardianLock.lock()
        let verdict = guardianCore.handle(activation, now: now)
        guardianLock.unlock()
        guard case .theft(let restore, let thief, let repeatOffender) = verdict else { return }
        guardianRestore(restore, thief: thief, repeatOffender: repeatOffender, cause: "\(appName(thief)) came to the front")
    }

    func onSpaceChange() {
        let now = clock.nowSeconds()
        let userInput = secondsSinceUserInput < CUFocusGuardianCore.userInputWindow
        guardianLock.lock()
        let restore = guardianCore.handleSpaceChange(to: sys.activeSpace(), hadRecentUserInput: userInput, now: now)
        guardianLock.unlock()
        guard let restore else { return }
        guardianRestore(restore, thief: restore.app ?? 0, repeatOffender: false, cause: "the desktop changed")
    }

    /// Puts the user back: updates suspended, the user's app re-activated and its window raised, the Space
    /// returned, within the deadline — then a fault log and a note for the next result.
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
