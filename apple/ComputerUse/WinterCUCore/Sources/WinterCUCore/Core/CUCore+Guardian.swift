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

    /// An operation on `pid` that may bring it forward at any time while it runs (an act, an AppleScript, a bind's window
    /// wait, a `useWindow`): touched throughout, and for the causal window after. `raise`: it can bring a window or a
    /// desktop forward (not an act — whose cause never outranks the user's switch input it follows, #8).
    func beginGuardianSpan(_ pid: pid_t, raise: Bool = true) {
        let now = clock.nowSeconds()
        let front = sys.frontmostPid() == pid
        guardianLock.withLock { guardianCore.beginSpan(pid, whileFront: front, raise: raise, now: now) }
    }

    func endGuardianSpan(_ pid: pid_t, raise: Bool = true) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.endSpan(pid, raise: raise, now: now) }
    }

    /// The agent is about to launch an app (a bind's): an app whose process starts meanwhile is the agent's.
    func beginGuardianLaunch() -> Int {
        let now = clock.nowSeconds()
        // (No opener cause of any reach here: the launch pending counts for the app it is for once its bundle is known,
        // and the bundle's own opener cause is noted then — round 14: opens and launches reach the app they open.)
        return guardianLock.withLock { guardianCore.beginLaunch(now: now) }
    }

    /// The bundle the pending launch is for, when the bind knows it (the default resolver does): only that app's
    /// process counts as the launch's — the launch of the bind that asks (`bindLaunchToken`, review of round 8: two
    /// binds at once could swap their bundles), else the latest.
    func noteGuardianLaunchBundle(_ bundle: String?) {
        let token = CUCore.bindLaunchToken
        let now = clock.nowSeconds()
        guardianLock.withLock {
            if let token { guardianCore.setLaunchBundle(token, bundle) } else { guardianCore.setLatestLaunchBundle(bundle) }
            guardianCore.noteOpenerCause(now: now, scope: bundle.map { .apps([$0]) } ?? .any)
        }
    }

    func endGuardianLaunch(_ token: Int, pid: pid_t?) {
        let now = clock.nowSeconds()
        // What it opened: its bundle as named, else the process's own; unknown — any app.
        let named = guardianLock.withLock { guardianCore.launchBundle(token) }
        let bundle = named ?? pid.flatMap { sys.bundleId(pid: $0) }
        guardianLock.withLock {
            guardianCore.noteOpenerCause(now: now, scope: bundle.map { .apps([$0]) } ?? .any)
            guardianCore.endLaunch(token, pid: pid, now: now)
        }
    }

    /// A restore of ours re-activates `pid` now (I2: its late landing, after the user moved elsewhere, is the restore's).
    func noteRestore(_ pid: pid_t) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.noteRestore(pid, now: now) }
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
        // (Always read: an app started a moment ago, not by the agent, comes forward on its first activation as the
        // user's own launch even when NSWorkspace's launch notice was never heard — review of round 9, MEDIUM #5. The
        // bundle too: whether an opener act of the agent's could have opened it — round 14's queue item 1.)
        let started = v.front.flatMap { pid in sys.processAge(pid: pid).map { now - $0 } }
        let bundle = v.front.flatMap { sys.bundleId(pid: $0) }
        // A desktop change: the apps the agent touched (with a cause that raises) whose window it showed.
        let placeSpace = guardianPlace()?.space ?? from?.space
        var shown: [pid_t] = []
        if let s = v.space, let p = placeSpace, s != p {
            let candidates = guardianLock.withLock { guardianCore.raiseTouchedApps(now: now) }
            shown = candidates.filter { pid in pid != v.front && sys.windows(pid: pid).contains { $0.onScreen } }
        }
        let hardware = guardianLock.withLock { lastHardwareActionAt }
        return CUMoveQuery(app: v.front, space: v.space, since: since,
                           from: from.map { CUGuardedView(app: $0.front, space: $0.space) },
                           appStartedAt: started, appBundle: bundle, inputObservable: observable, clickAt: clickAt, shown: shown,
                           hardwareAt: hardware, appIsSystemUI: v.front.map { isSystemUI($0) } ?? false,
                           secureInput: secureInputOn)
    }

    /// Round 10: an act that can open or bring forward ANOTHER app (a press or click, Return/Space/Enter, a menu
    /// command, a typed newline) — the only kind after which an untouched app's coming forward can be clearly the
    /// agent's. Pure.
    static func actCanOpenApps(_ a: CUAction) -> Bool {
        switch a {
        case .click, .action, .menu: return true
        case .key(let k):
            let c = k.combo.lowercased()
            return ["return", "enter", "space", "kp_enter"].contains { c.hasSuffix($0) }
        case .type(let t): return t.text.contains("\n") || t.text.contains("\r")
        case .paste(let t): return t.text.contains("\n")
        case .setValue, .scroll, .drag, .select, .hover: return false
        }
    }

    /// The agent did something that can open another app (an opener act, an AppleScript, an open, a launch) — `scope`:
    /// which apps it can open.
    func noteGuardianOpener(_ scope: CUOpenerScope = .any) {
        let now = clock.nowSeconds()
        guardianLock.withLock { guardianCore.noteOpenerCause(now: now, scope: scope) }
    }

    /// The apps an act on `t` can open or bring forward (round 14's queue item 1 — a third party's activations right
    /// after a click in Chrome were undone as the agent's): `t` itself; for an app that is not a web browser, the
    /// default handlers of web and mail links (a link it opens lands there — a browser's links stay in it); for a menu
    /// command, the Help viewer and the default browser (a Help menu item opens either). Finder, the Dock and launchers
    /// open any app, and so does an act on a target whose bundle is unknown. Never an arbitrary app like Terminal.
    func openerScope(_ a: CUAction?, _ t: CUTarget) -> CUOpenerScope {
        guard let b = t.bundleId, !Self.opensAnyApp.contains(b) else { return .any }
        var apps: Set<String> = [b]
        let menu: Bool = { if case .menu? = a { return true }; return false }()
        // Finder only for an act that can reveal in it — a menu command or a pressed control named like "Show/Reveal in
        // Finder" (review of round 15, MEDIUM #3b: Finder in every reach undid a third party's `open .`).
        let named: AXUIElement? = Self.actRef(a).flatMap { try? element($0, in: t) }
        let words: String = {
            if case .menu(let m)? = a { return m.path.joined(separator: " ") }
            return named.map { e in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute].compactMap { ax.string(e, $0) }.joined(separator: " ") } ?? ""
        }()
        if words.lowercased().contains("finder") { apps.insert("com.apple.finder") }
        // The default web and mail handlers: a non-browser's links land there. A browser's own web links stay in it, but
        // its mailto: opens the mail app; a menu command uses the same list (Help › Contact Support, Share › Email).
        for scheme in isWebBrowser(t) && !menu ? ["mailto"] : ["http", "https", "mailto"] {
            if let h = defaultHandler(scheme) { apps.insert(h) }
        }
        if menu { apps.insert("com.apple.helpviewer") }
        // The pressed element's own link: its scheme's handler (zoommtg:, slack:, x-apple.systempreferences:, …) — never a
        // web link's in a browser, which opens it itself (review of round 15, MEDIUM #3b).
        if let e = named, let scheme = linkScheme(e), !(["http", "https"].contains(scheme) && isWebBrowser(t) && !menu),
           let h = defaultHandler(scheme) {
            apps.insert(h)
        }
        return .apps(apps)
    }

    /// The element an act names (its ref), when it names one.
    static func actRef(_ a: CUAction?) -> Int? {
        switch a {
        case .click(let c)?: return c.ref
        case .action(let x)?: return x.ref
        case .key(let k)?: return k.into
        default: return nil
        }
    }

    /// The scheme of the link `e` is (or sits in, up to two levels): its `AXURL`'s.
    func linkScheme(_ e: AXUIElement) -> String? {
        var n: AXUIElement? = e
        for _ in 0..<3 {
            guard let x = n else { return nil }
            if let v = ax.attribute(x, "AXURL") {
                let url: URL? = CFGetTypeID(v) == CFURLGetTypeID() ? (v as! CFURL) as URL : (v as? String).flatMap(URL.init(string:))
                if let s = url?.scheme?.lowercased(), !s.isEmpty { return s }
            }
            n = ax.element(x, kAXParentAttribute)
        }
        return nil
    }

    /// The interactive launchers whose panel a Return launches from (R17-d (ii)): Spotlight and the common launchers.
    static let launcherPanels: Set<String> = ["com.apple.Spotlight", "com.runningwithcrayons.Alfred", "com.raycast.macos",
                                              "com.obdev.LaunchBar"]
    func isInteractiveLauncher(_ pid: pid_t) -> Bool { sys.bundleId(pid: pid).map(Self.launcherPanels.contains) ?? false }

    /// Apps whose acts can open any other app: Finder (a document opens in its app), the Dock, launchers.
    static let opensAnyApp: Set<String> = [
        "com.apple.finder", "com.apple.dock", "com.apple.Spotlight", "com.runningwithcrayons.Alfred",
        "com.raycast.macos", "com.obdev.LaunchBar",
    ]

    /// The bundle id of the app that opens `scheme:` links by default (nil: none or unknown). Cached a minute per scheme
    /// (review of round 14, LOW: up to four LaunchServices lookups per opener act); a change of the default app is seen
    /// within that.
    func defaultHandler(_ scheme: String) -> String? {
        if let o = defaultHandlerOverride { return o(scheme) }
        let now = clock.nowSeconds()
        if let c = defaultHandlerLock.withLock({ defaultHandlerCache[scheme] }), now - c.at < 60 { return c.bundle }
        let found = lookUpDefaultHandler(scheme)
        defaultHandlerLock.withLock { defaultHandlerCache[scheme] = (found, now) }
        return found
    }

    private func lookUpDefaultHandler(_ scheme: String) -> String? {
        guard let url = URL(string: scheme == "mailto" ? "mailto:someone@example.invalid" : "\(scheme)://example.invalid"),
              let app = NSWorkspace.shared.urlForApplication(toOpen: url) else { return nil }
        return Bundle(url: app)?.bundleIdentifier
    }

    /// The system's dialog processes (a permission or authentication prompt the user must be able to answer), and any
    /// app that is not a regular one: never undone as the agent's indirect effect (I1).
    static let systemDialogBundles: Set<String> = ["com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent",
                                                   "com.apple.SecurityAgent", "com.apple.CoreServicesUIAgent"]
    func isSystemUI(_ pid: pid_t) -> Bool {
        if let b = sys.bundleId(pid: pid), Self.systemDialogBundles.contains(b) { return true }
        return sys.isRegularApp(pid) == false
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
            if case .unexplained = owner, let app = v.front { noteUnexplained(app) }
            if case .indirect = owner, let app = v.front { noteIndirect(app) }
        }
        return (owner, repeatOffender)
    }

    /// Whether the user's view being `v` now is left alone — anything but the agent's own doing (I5: a visit's switch,
    /// the consented foreground, an untouched app's coming forward, and the user's own move are never undone by any
    /// path, review of round 8).
    func leftAlone(_ v: CUUserView, since: TimeInterval?, from: CUUserView? = nil, path: String) -> Bool {
        !judgeMove(v, since: since, from: from, path: path).undoes
    }

    /// A system dialog came up after the agent's action with no input of the user's: left for them to answer — the next
    /// result says so (an unfenced daemon line) and counts it.
    func noteUnexplained(_ app: pid_t) {
        let name = appName(app)
        let dialog = isSystemUI(app)
        CULog.guardian.fault("\(name, privacy: .public) came forward around the agent's action (\(dialog ? "a system dialog" : "maybe the user's doing", privacy: .public)): left in front")
        // Round 10 (the user's ruling): not clearly the agent's — left in front, never adopted, said.
        let note = dialog
            ? "\(name) (a system dialog) came up after your action — it was left in front for the user to answer; avoid the action that raises it, or ask the user"
            : "\(name) came forward around your action — it may have been your action's doing or the user's; it was left in front (the user's view may have moved)"
        guardianLock.withLock {
            if !pendingGuardianNotes.contains(note) { pendingGuardianNotes.append(note) }
            pendingViewMovedBy.append(name)
        }
        guardianNoted?(note)
    }

    /// The agent's indirect effect (I1): an app it never touched came forward after its action with no input of the
    /// user's — undone (the observer's restore); the next result says so and counts it.
    func noteIndirect(_ app: pid_t) {
        let name = appName(app)
        CULog.guardian.fault("\(name, privacy: .public) came forward after the agent's action, with no input of the user's: the agent's indirect effect — sent back")
        let note = "\(name) came forward after your action and was sent back — avoid that (a link opens in the background when clicked; apps.open and browsers.open work without bringing anything forward)"
        guardianLock.withLock {
            if !pendingGuardianNotes.contains(note) { pendingGuardianNotes.append(note) }
            pendingViewMovedBy.append(name)
        }
        guardianNoted?(note)
    }

    /// An app was launched (NSWorkspace): unless the agent launched it, its first activation is the user's.
    func onAppLaunched(pid: pid_t) {
        let now = clock.nowSeconds()
        // The agent's own launch (a bind's, its bundle named before it launched) is no user's launch.
        let started = sys.processAge(pid: pid).map { now - $0 }
        let bundle = sys.bundleId(pid: pid)
        let observable = switchInputObservable, secure = secureInputOn
        guardianLock.withLock {
            guardianCore.appLaunched(pid, startedAt: started, bundle: bundle, now: now, inputObservable: observable, secureInput: secure)
        }
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
            guard startWasTheirs else { return guardianPlace()?.app ?? user }
            // Left alone as the blip began without being their place (the consented foreground, a visit, a dialog): asked
            // again — a hold that has ended since makes it the agent's now, and the key goes to their place (the
            // model-based test: a key typed in the 3 ms before the hold's give-back landed went to the held app).
            if guardianPlace().map({ $0.app == user }) ?? true { return user }
            let owner = judgeMove(now, since: since, path: "a key of the user's in the focus blip")
            return owner.undoes ? (guardianPlace()?.app ?? user) : user
        }
        let owner = judgeMove(now, since: since, from: CUUserView(space: space, front: user), path: "a key of the user's in the focus blip")
        // Not undone (their move, a visit, the consented foreground, an untouched app that came forward): the key goes to
        // what is in front, where they are looking.
        if !owner.undoes, let f = now.front { return f }
        // Not their move: their place as the guardian knows it — only ever set by their own moves.
        return guardianPlace()?.app ?? user
    }

    // MARK: the user's input

    /// One event the listen-only session tap saw (not a type-21 process notification): the user's input only when
    /// `CUHardwareInput` says so — the window server's own events around an activation or a desktop change are not.
    func noteTapEvent(type: CGEventType, sourcePid: Int64, userData: Int64, flags: CGEventFlags = [], keycode: Int64 = -1,
                      location: CGPoint? = nil, targetPid: Int64 = 0, scrollPhase: Int64 = 0, momentumPhase: Int64 = 0,
                      now: TimeInterval) {
        let kind = CUHardwareInput.classify(type: type, sourcePid: sourcePid, userData: userData)
        // (Not the user's — a synthetic event, the helper's own: nothing to read, not even Secure Event Input — round 17b.)
        guard kind != .none else { return }
        // Secure Event Input sampled on every tap event of the user's, not only at judgments (R17-a, the user's ruling) —
        // and 4 times a second while the guardian runs (`pollSecureInput`, round 17b): on at any moment of the quiet window,
        // never quiet.
        let secureNow = secureInputOn
        guardianLock.withLock { guardianCore.noteSecureInputIfChanged(secureNow, now: now) }
        noteHardwareInput(now: now, move: kind == .move)
        guard kind == .action else { return }
        // The launch rule's facts (R17-d, the controller's ruling): input that can launch an app (i), and an interactive
        // launcher's Return — a key the window server delivers to Spotlight's or a launcher's panel (ii).
        if CUHardwareInput.canLaunch(type: type, flags: flags, keycode: keycode) {
            let launcher = type == .keyDown && (keycode == 36 || keycode == 76) && targetPid > 0
                && isInteractiveLauncher(pid_t(truncatingIfNeeded: targetPid))
            guardianLock.withLock {
                guardianCore.noteLaunchCapableInput(now: now)
                if launcher { guardianCore.noteLauncherInput(now: now) }
            }
        }
        // Typing into the app in front (no ⌘/⌃, not Escape): an app left in front becomes their place — a restore never
        // pulls them out of it (the ruling, round 16).
        if type == .keyDown, !flags.contains(.maskCommand), !flags.contains(.maskControl), keycode != 53 {
            let front = sys.frontmostPid()
            guardianLock.withLock { guardianCore.userInputInFront(front, now: now) }
        }
        // A scroll in the app in front's own window: USE of an app left in front — their place, as typing in it is (round
        // 18, the controller's ruling: scrolling there is work per I6). (The window under the pointer is read only while the
        // app in front is a left one.)
        // R18-b (the controller's ruling): only a scroll whose gesture BEGAN after the app came forward — a gesture's
        // began event since then, or a plain wheel event (no phase) — never momentum, nor the tail of a gesture begun
        // before it.
        if type == .scrollWheel {
            if scrollPhase == Self.scrollPhaseBegan { guardianLock.withLock { scrollGestureBeganAt = now } }
            if momentumPhase == 0, let p = location, let front = sys.frontmostPid(),
               let since = guardianLock.withLock({ guardianCore.isLeftInFront(front) ? guardianCore.frontSince(front) : nil }),
               scrollPhase == 0 || guardianLock.withLock({ scrollGestureBeganAt.map { $0 >= since } ?? false }),
               windowUnder(p)?.pid == front {
                guardianLock.withLock { guardianCore.userInputInFront(front, now: now) }
            }
        }
        noteUserInteraction(type: type, flags: flags, keycode: keycode, location: location, targetPid: targetPid)
        let secure = (type == .flagsChanged || type == .keyDown) && secureNow
        guardianLock.withLock { guardianCore.inputEvent(type: type, flags: flags, keycode: keycode, secure: secure, now: now) }
    }

    /// Round 10 (user ruling): the user WORKING in an app — a key while it is in front (not a switch chord: ⌘-Tab, ⌘-`,
    /// ⌃-arrows), a right or other click or a scroll in its window while it is in front (a left click is the click
    /// handler's) — makes the agent hands-off it until it leaves the front. Only bound targets matter, so nothing is read
    /// for any other front app.
    /// `targetPid`: the process the window server delivers the event to (the annotated session tap's
    /// `eventTargetUnixProcessID`; 0 when it says none): a key typed into Spotlight's, a launcher's, the emoji picker's or
    /// a menu-bar item's panel goes to THAT process while the bound app stays in front — never work in the bound app
    /// (review of round 10, MEDIUM #3: the key was put on the front app).
    func noteUserInteraction(type: CGEventType, flags: CGEventFlags, keycode: Int64, location: CGPoint?, targetPid: Int64 = 0) {
        // (Fed by the guardian's tap while it runs, by the work watcher otherwise — whoever calls has checked the event is
        // the user's.)
        guard let front = sys.frontmostPid(), boundTargetPids().contains(front) else { return }
        switch type {
        case .keyDown:
            // Typing (no ⌘ or ⌃): a ⌘/⌃ chord may be the system's (⌘-Space, ⌘-Tab, ⌃-arrows), not work in the app —
            // found by the model-based test (the user's ⌘-Space for Spotlight refused the agent's next act). Nor ⌥-Space (a
            // launcher's hotkey: Alfred, Raycast), nor Escape (their Esc stops the agent, or closes a panel of the system's).
            guard Self.isTypingKey(flags: flags, keycode: keycode) else { return }
            if targetPid > 0 {
                let receiver = pid_t(truncatingIfNeeded: targetPid)
                guard receiver == front || sys.isContentProcess(receiver, of: front) else { return }
            }
            // A focus blip's reroute on the app in front decides where each key of the user's goes — to THEIR place unless
            // their own move took them there — and marks the work itself when it lets one through into the app (round 17,
            // the review of round 16: round 16's seed-51 fix guessed it from "the app in front is not their place", and the
            // session tap can see a key before the reroute's tap decides it).
            if let r = activeKeyReroute, r.isInstalled, r.target == front { return }
            if guardianLock.withLock({ guardianCore.userWorkingApp == front }) { return }  // marked already: nothing more read
            userInteracted(front)
        case .rightMouseDown, .otherMouseDown, .scrollWheel:
            if guardianLock.withLock({ guardianCore.userWorkingApp == front }) { return }  // marked already: no window lookup
            // A scroll comes in bursts of dozens of events: the window under the pointer is read at most every 250 ms
            // (review of round 12, LOW — a full window-list read per event over another app).
            if type == .scrollWheel {
                let now = clock.nowSeconds()
                let due = guardianLock.withLock { () -> Bool in
                    guard now - lastScrollWorkCheck >= 0.25 else { return false }
                    lastScrollWorkCheck = now
                    return true
                }
                guard due else { return }
            }
            guard let point = location, windowUnder(point)?.pid == front else { return }
            userInteracted(front)
        default:
            return
        }
    }

    /// The topmost window under `point` that takes clicks (the helper's own click-through windows let them through).
    func windowUnder(_ point: CGPoint) -> CUWindowServerWindow? {
        let own = getpid()
        return sys.windowStack().filter { $0.alpha > 0 && $0.frame.contains(point) }.first { $0.pid != own || ownWindowTakesClicks($0) }
    }

    /// A key that is typing in the app it reaches (I6): no ⌘ or ⌃ (a chord may be the system's: ⌘-Space, ⌘-Tab, ⌃-arrows),
    /// not ⌥-Space (a launcher's hotkey), not Escape (it stops the agent, or closes a panel of the system's).
    static func isTypingKey(flags: CGEventFlags, keycode: Int64) -> Bool {
        !flags.contains(.maskCommand) && !flags.contains(.maskControl) && !(flags.contains(.maskAlternate) && keycode == 49) && keycode != 53
    }

    func userInteracted(_ app: pid_t) {
        let front = sys.frontmostPid()
        let now = clock.nowSeconds()
        let changed = guardianLock.withLock { () -> Bool in
            defer { guardianCore.userInteracted(app, front: front, now: now) }
            return guardianCore.userWorkingApp != app
        }
        if changed { CULog.guardian.notice("the user is working in \(self.appName(app), privacy: .public): hands off it until it leaves the front") }
    }

    /// One reading of Secure Event Input for the guardian (its 4 Hz poll; round 17b, the review of round 17's M2).
    func pollSecureInput(now: TimeInterval? = nil) {
        let on = secureInputOn
        let t = now ?? clock.nowSeconds()
        guardianLock.withLock { guardianCore.noteSecureInputIfChanged(on, now: t) }
    }

    /// Whether the user is working in `pid` now (round 10): the agent does not act on it.
    func userIsWorking(in pid: pid_t) -> Bool {
        // (Read whether or not the guardian runs: the mark outlasts it, and the always-on activation observer ends it.)
        let front = sys.frontmostPid()
        let now = clock.nowSeconds()
        return guardianLock.withLock { guardianCore.userIsWorking(in: pid, front: front, now: now) }
    }

    /// TEST-ONLY (the live suite's runner, through a live-test helper's `test.activate {asUser}` / `test.userInput`): the
    /// facts a person's input would leave — hardware input now, and either their switch to `pid` (a click on its window
    /// or its Dock tile: input for that app, claimed) or their work in it (a click into its window while it is in front).
    /// The runner's own activation carries no hardware input, so without this its "user switch" reads as the agent's.
    public func testUserInput(pid: pid_t, switching: Bool) {
        let now = clock.nowSeconds()
        noteHardwareInput(now: now)
        if switching {
            noteSwitchInput(now: now, .app, target: pid)
            guardianLock.withLock { guardianCore.userClicked(app: pid, space: nil, now: now) }
        } else {
            userInteracted(pid)
        }
    }

    /// The work mark alone (no Secure Event Input evidence — an act's own typing changes the text): for the checks INSIDE
    /// an act already in flight, before each focus placement, key and paste.
    func refuseIfUserWorkMarked(_ t: CUTarget) throws {
        guard userIsWorking(in: t.pid) else { return }
        CULog.act.notice("act in \(t.appName, privacy: .public): the user started working in it while the act ran — stopped")
        throw CUError.refused(.userWorking, Self.userWorkingWords(t.appName))
    }

    /// The `user_working` refusal's words: what lets the agent act again (live 2026-10-20: "wait and retry" kept a child
    /// retrying for three minutes while the app stayed in front).
    static func userWorkingWords(_ app: String) -> String {
        "the user is working in \(app) right now — ask the user to switch away from \(app) for a moment, or to say go ahead (their next message lets you act)"
    }

    /// The user let the agent go ahead in these apps (`work.lift`, from the daemon: the user's own message to a session
    /// that was refused there — never a session releasing the app): each one's work mark lifts — until they work in it anew.
    public func workLift(_ p: WorkLiftParams) async throws -> WorkLiftResult {
        let lifted = guardianLock.withLock { p.pids.filter { guardianCore.liftUserWork($0) } }
        for pid in lifted { CULog.guardian.notice("the user's work mark on \(self.appName(pid), privacy: .public) lifted (\(p.reason ?? "the daemon", privacy: .public))") }
        return WorkLiftResult(lifted: lifted)
    }

    /// The refusal while the user is working in the target (round 10).
    func refuseWhileUserWorks(_ t: CUTarget) throws {
        // Under Secure Event Input the tap sees no key: when the bound app in front holds it itself (a password or a
        // secure field of its own has the keyboard), the user is taken to be working in it (review of round 10, LOW #10).
        // Corroborated (review of round 12, MEDIUM #3: Terminal's Secure Keyboard Entry holds it whenever Terminal is in
        // front, and a user switching there only to look must block nothing): a secure field of the app has the focus, or
        // input of theirs came in the last 2.5 s. The owner may be a true part of the app (a WebContent's password field).
        // Review of round 13, MEDIUM #6: recent hardware input is no corroboration (the ⌘-Tab that brought the app forward
        // blocked a looker for 2.5 s, and letters typed under it are never seen) — TYPING is: the focused element's text
        // changed since the agent last looked (`secureTypingBase`, refreshed at each of its acts' end), which marks the
        // user working in the app until it leaves the front (the ordinary I6 mark).
        // The user's ruling (round 14): KEEP the safe side — a bound front app under Secure Keyboard Entry whose text
        // changes (their typing, or a command's streaming output: the two can't be told apart) is the user working, and
        // the agent waits until the app leaves the front; the refusal says why.
        enum SecureWork { case none, secureField, textChanging }
        let secureWork: SecureWork = {
            guard secureInputOn, sys.frontmostPid() == t.pid, let owner = secureInputOwnerPid(),
                  owner == t.pid || sys.isContentProcess(owner, of: t.pid) else {
                guardianLock.withLock { t.secureTypingBase = nil; t.secureTextChanged = false }
                return .none
            }
            let focused = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute)
            if focused.flatMap({ ax.string($0, kAXSubroleAttribute) }) == kAXSecureTextFieldSubrole { return .secureField }
            let now = secureTypingState(t)
            let base = guardianLock.withLock { () -> (focus: AXIdentity?, chars: Int?)? in
                let b = t.secureTypingBase
                if b == nil || b?.focus != now.focus { t.secureTypingBase = now }
                return b
            }
            guard let base, base.focus == now.focus, let a = base.chars, let b = now.chars, a != b else {
                // (Once seen, it holds while the app stays in front — the sticky I6 mark — and keeps its reason.)
                return guardianLock.withLock { t.secureTextChanged } ? .textChanging : .none
            }
            CULog.act.notice("act in \(t.appName, privacy: .public): its text changed since the agent's last act, under Secure Event Input — the user typing (or its output: the same, by the user's ruling)")
            guardianLock.withLock { t.secureTextChanged = true }
            userInteracted(t.pid)
            return .textChanging
        }()
        switch secureWork {
        case .textChanging:
            CULog.act.notice("act in \(t.appName, privacy: .public): refused — Secure Keyboard Entry, its text changing")
            throw CUError.refused(.userWorking, "\(t.appName) is in front with Secure Keyboard Entry on and its text is changing — Winter waits until you switch away")
        case .secureField:
            CULog.act.notice("act in \(t.appName, privacy: .public): refused — a secure field of it has the keyboard")
            throw CUError.refused(.userWorking, "\(t.appName) is in front with a password field focused (Secure Event Input) — Winter waits until you switch away")
        case .none:
            break
        }
        // A granted requestForeground card lifted the mark that was there when the user said yes (`holdForegroundNow`);
        // their work in the app since marks it anew and stops the agent here as anywhere (the review of 2026-10-20).
        guard userIsWorking(in: t.pid) else { return }
        CULog.act.notice("act in \(t.appName, privacy: .public): refused — the user is working in it")
        throw CUError.refused(.userWorking, Self.userWorkingWords(t.appName))
    }

    /// The focused element of `t`'s app and how many characters it holds (Secure Event Input's typing evidence).
    func secureTypingState(_ t: CUTarget) -> (focus: AXIdentity?, chars: Int?) {
        let focused = ax.element(ax.application(t.pid), kAXFocusedUIElementAttribute)
        let chars = focused.flatMap { ax.attribute($0, "AXNumberOfCharacters") as? NSNumber }?.intValue
            ?? focused.flatMap { ax.string($0, kAXValueAttribute) }?.utf16.count
        return (focused.map { AXIdentity(element: $0) }, chars)
    }

    /// After an act on `t` under Secure Event Input: what it typed is the agent's, never taken for the user's typing.
    func refreshSecureTypingBase(_ t: CUTarget) {
        guard secureInputOn, sys.frontmostPid() == t.pid else { return }
        let now = secureTypingState(t)
        guardianLock.withLock { t.secureTypingBase = now }
    }

    /// The process holding Secure Event Input (the session's `kCGSSessionSecureInputPID`), when one does.
    func secureInputOwnerPid() -> pid_t? {
        if let o = secureInputOwnerOverride { return o }
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any],
              let n = d["kCGSSessionSecureInputPID"] as? NSNumber, n.int32Value > 0 else { return nil }
        return n.int32Value
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

    /// Secure Event Input is on (Terminal's Secure Keyboard Entry while it is in front, a password field): the tap sees
    /// the modifiers but no keys (measured on 2026-10-11 with a probe of our own, run107: a separate process's ⌘ press
    /// and release reached the listen-only session tap, its key did not), so a ⌘ tap counts as a ⌘-Tab, briefly.
    var secureInputOn: Bool { secureInputOverride ?? IsSecureEventInputEnabled() }

    /// The listen-only tap (or the gesture monitor) saw a hardware-origin event (source pid 0, not ours). `move`:
    /// only the pointer moved.
    func noteHardwareInput(now: TimeInterval, move: Bool = false) {
        guardianLock.withLock {
            lastHardwareInputAt = now
            if !move {
                lastHardwareActionAt = now
                guardianCore.noteHardwareAction(now: now)
            }
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
        // (Never in a test's core: the machine's REAL activations — another app, a probe running meanwhile — reached the
        // model-based test's simulated world as an unknown pid and failed a seed, round 14.)
        if guardianLiveTapEnabled {
            installGuardianObservers()
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now(), repeating: .milliseconds(250), leeway: .milliseconds(50))
            timer.setEventHandler { [weak self] in self?.pollSecureInput() }
            timer.resume()
            secureInputPoll = timer
        }
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
        secureInputPoll?.cancel()
        secureInputPoll = nil
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

    /// The consented foreground rung takes the front for one action: exempt that app briefly. (Already in front — the
    /// user's own move into it, heard or not — its activation is no cause of its being there.)
    func guardianExempt(_ pid: pid_t) {
        let now = clock.nowSeconds()
        let front = sys.frontmostPid() == pid
        guardianLock.withLock {
            if front { guardianCore.noteFrontAfterglow(pid, raise: true, now: now) } else { guardianCore.noteCause(pid, raise: true, now: now) }
            guardianCore.exempt(pid, until: now + 5, now: now)
        }
    }

    /// Before the agent takes the user's view anywhere (a desktop visit, the consented foreground): the state in front
    /// now is judged first, so a move of theirs that landed a moment before — not heard of yet — is their place before
    /// the agent's own switch is laid over it (found by the model-based test: their ⌘-Tab 15 ms before a visit was "the
    /// visit's", and the visit's end took them back to the app they had left).
    @discardableResult
    func judgeBeforeTaking(_ path: String) -> CUMoveOwner? {
        guard guardianRunning else { return nil }
        return judgeMove(userView(), since: nil, path: path)
    }

    /// Notes the guardian left for the next tool result (a restore happened between acts).
    func takeGuardianNotes() -> [String] {
        guardianLock.lock(); defer { guardianLock.unlock() }
        let notes = pendingGuardianNotes
        pendingGuardianNotes = []
        return notes
    }

    /// The notes, and the apps that came forward after the agent's action with no input of the user's (a metric).
    func takeGuardianReport() -> (notes: [String], viewMovedBy: [String]) {
        guardianLock.lock(); defer { guardianLock.unlock() }
        defer { pendingGuardianNotes = []; pendingViewMovedBy = [] }
        return (pendingGuardianNotes, pendingViewMovedBy)
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
        // A launch the agent did not make: the app's first activation is the user's (their own slow launch, I1).
        guardianObservers.append(ws.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) {
            [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.onAppLaunched(pid: app.processIdentifier)
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
        let heardAt = clock.nowSeconds()
        guardianLock.withLock { guardianCore.activationHeard(pid, now: heardAt) }
        // An app was activated, and something else is in front already: that past change is judged by the one rule — the
        // user's: their place went there before whatever came next, and a theft after it is put back THERE (the model-based
        // test: an app came forward 5 ms after it, before the guardian heard of either).
        if let front = sys.frontmostPid(), front != pid {
            let now = clock.nowSeconds()
            let live = CUGuardedView(app: front, space: sys.activeSpace())
            // The desktop it came forward on, as its windows tell: its one desktop if it has windows on a single one, else
            // unknown (an app with windows here and on another desktop may have taken the user to either — found by the
            // model-based test).
            let spaces = Set(sys.windows(pid: pid).filter { CUWindowServer.isRealWindow($0) }.flatMap { sys.windowSpaces($0.id) ?? [] })
            let space: UInt64? = spaces.count == 1 ? spaces.first : nil
            let observable = switchInputObservable
            let owner = guardianLock.withLock {
                guardianCore.adoptPast(pid, space: space, live: live, hardwareAt: lastHardwareActionAt, inputObservable: observable,
                                       seenSince: lastActivationHeardAt, now: now)
            }
            switch owner {
            case .user?:
                CULog.guardian.notice("\(self.appName(pid), privacy: .public) activated and is no longer in front — the user's move (\(owner?.words ?? "", privacy: .public)): it was their place before that")
            case .unexplained?:
                noteUnexplained(pid)
            default:
                break
            }
        }
        observe("\(appName(pid)) activated")
        guardianLock.withLock { lastActivationHeardAt = clock.nowSeconds() }
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
        case .indirect:
            // Said by `noteIndirect`: the restore leaves no second note.
            guard let thief = now.front else { return }
            dispatchRestore(thief: thief, repeatOffender: repeatOffender, cause: "\(appName(thief)) came forward after the agent's action", silent: true)
        case .theirPlace, .consented, .visit, .unexplained:
            break
        }
    }

    /// Runs a restore inline in tests (synchronous), else off the main queue so the observer never blocks.
    private func dispatchRestore(thief: pid_t, repeatOffender: Bool, cause: String, silent: Bool = false) {
        if let schedule = guardianRestoreDispatch {
            schedule { [weak self] in self?.guardianRestore(thief: thief, repeatOffender: repeatOffender, cause: cause, silent: silent) }
        } else if guardianRestoreSync {
            guardianRestore(thief: thief, repeatOffender: repeatOffender, cause: cause, silent: silent)
        } else {
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                guardianRestore(thief: thief, repeatOffender: repeatOffender, cause: cause, silent: silent)
            }
        }
    }

    /// I2 — puts the user back at their place AS IT IS NOW (the guardian's view; `fallback` when not guarding — never a
    /// place captured before they moved): updates suspended, their app re-activated and its window raised, the Space
    /// returned, within the deadline — then a fault log and a note for the next result. Nothing when they are there
    /// already (unless `force`: the front is theirs but the key focus is not), or when their place is the thief itself.
    /// Runs OFF the main queue (dispatched by the observers), so a restore never blocks the UI or event delivery.
    func guardianRestore(thief: pid_t, fallback: CUGuardedView? = nil, repeatOffender: Bool = false, force: Bool = false,
                         cause: String, silent: Bool = false) {
        let now = userView()
        // The thief may be their own app — the desktop changed under it (a raise of the agent's on another desktop): the
        // desktop is put back (found by the model-based test: nothing was restored, the user left on the other desktop).
        guard let place = guardianPlace() ?? fallback, let user = place.app,
              user != thief || (place.space != nil && now.space != nil && now.space != place.space) else { return }
        let target = CUUserView(space: place.space, front: user)
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
        if !silent {
            guardianLock.withLock { pendingGuardianNotes.append(note) }
            guardianNoted?(note)
        }
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

    /// One left-mouse-down the listen-only tap saw. A helper-origin click (our stamp) is ignored. The window the
    /// click reaches decides what it is (the review of round 8):
    /// - the helper's own CLICK-THROUGH panels (the agent cursor's overlay, the size of the target's window; the mirror
    ///   panel over its traffic lights) are passed through — the click reaches what is under them (it was taken for "on
    ///   no other app" and the user's click into the target, "taking over", was undone); a panel of ours that takes clicks
    ///   (the desktop-switch prompt) is no switch;
    /// - an ordinary window (layer 0) of a regular app that is not in front, on another display, or a bound target's:
    ///   the activation it causes is CLAIMED as the user's (a switch instant for that app, and the claim) — their place
    ///   moves there once that activation is seen (a drag out of a background window activates nothing and moves
    ///   nothing); a bound target is also activated, so the click works normally even though the focus enforcer may
    ///   have told it it was already active;
    /// - anything else — the Dock, a status item or the menu bar, a Notification Center banner (which activates its
    ///   app), Picture in Picture, a floating or non-activating panel: a switch instant for any app, no claim (what it
    ///   activates, if anything, is not known from the click);
    /// - no window: the empty desktop — Finder comes forward: claimed for Finder.
    /// A ⌘-click works a window in the background (no activation): no move. Returns the pid claimed, for the test.
    @discardableResult
    func onPhysicalClick(at point: CGPoint, userData: Int64, flags: CGEventFlags = [], clickCount: Int64 = 1, now: Double) -> pid_t? {
        guard !CUEventStamp.isOurs(userData) else { return nil }
        guard guardianLock.withLock({ guardianCore.active }) else { return nil }
        let own = getpid()
        let stack = sys.windowStack().filter { $0.alpha > 0 && $0.frame.contains(point) }
        guard let hit = stack.first(where: { $0.pid != own || ownWindowTakesClicks($0) }) else {
            return desktopClick(now: now, flags: flags)
        }
        guard hit.pid != own else { return nil }  // a panel of ours that takes clicks: on no other app
        if hit.ownerName == "Dock" {
            // A click on an app's Dock tile is input for THAT app — claimed like a click into its window (found by the
            // model-based test: an untargeted Dock click was taken by an app that came forward on its own a moment
            // before the clicked one, which was then undone). Anything else in the Dock: an app switch of no known app.
            guard let app = sys.dockItemApp(at: point, dockPid: hit.pid), app != own else {
                noteSwitchInput(now: now, .app)
                // A tile that LAUNCHES (an app not running, Launchpad) — an interactive launcher (R17-d (ii)); the Trash, a
                // stack, a minimized window, a separator, or a tile that can't be read are not (R18-a).
                if sys.dockItemLaunches(at: point, dockPid: hit.pid) == true {
                    guardianLock.withLock { guardianCore.noteLauncherInput(now: now) }
                }
                return nil
            }
            // The FRONT app's tile (R17-b, the controller's ruling): their place AT THE CLICK, as a click into its window
            // already in front is — no activation may come to claim it later (seed 1020: the click on T's tile while T was in
            // front, an earlier restore of P landing 11 ms on, and the engine's place stayed P).
            if app == sys.frontmostPid() {
                guardianLock.withLock {
                    guardianCore.noteSwitch(now: now, .app, target: app, quiet: true)
                    guardianCore.userClickedFront(app: app, space: sys.activeSpace(), now: now)
                }
                CULog.guardian.notice("the user clicked \(self.appName(app), privacy: .public) in the Dock while it is in front: their place")
                return app
            }
            noteSwitchInput(now: now, .app, target: app)
            guardianLock.withLock { guardianCore.userClicked(app: app, space: nil, now: now) }
            CULog.guardian.notice("the user clicked \(self.appName(app), privacy: .public) in the Dock: claimed as their move")
            return app
        }
        guard !flags.contains(.maskCommand) else { return nil }
        // A double-click in a Finder window on an application or a document — an interactive launcher (R17-d (ii)); never
        // on a folder, nor where it can't be read (R18-a).
        if clickCount >= 2, hit.layer == 0, sys.bundleId(pid: hit.pid) == "com.apple.finder",
           sys.finderItemLaunches(at: point, finderPid: hit.pid) == true {
            guardianLock.withLock { guardianCore.noteLauncherInput(now: now) }
        }
        // A click into an ordinary window of a bound target: the user is working in it (round 10) — hands off it until it
        // leaves the front.
        if hit.layer == 0, boundTargetPids().contains(hit.pid) { userInteracted(hit.pid) }
        // Not an ordinary window of a regular app: what it activates (if anything) is not known from the click.
        guard hit.layer == 0, sys.isRegularApp(hit.pid) != false else {
            noteSwitchInput(now: now, .app)
            CULog.guardian.notice("the user clicked \(hit.ownerName, privacy: .public)'s window \(hit.id, privacy: .public) (layer \(hit.layer, privacy: .public)): input that may switch")
            return nil
        }
        let front = sys.frontmostPid()
        let elsewhere = sys.activeSpace().flatMap { active in sys.windowSpaces(hit.id).map { !$0.contains(active) } } ?? false
        let isTarget = boundTargetPids().contains(hit.pid)
        // A click into the app already in front is still input for THAT app: should their place move before the click
        // lands (a desktop switch of theirs right after), the app coming back is theirs (seed 1067).
        if hit.pid == front, !elsewhere {
            guardianLock.withLock {
                guardianCore.noteSwitch(now: now, .app, target: hit.pid, quiet: true)
                guardianCore.userInputInFront(hit.pid, now: now)  // a click in an app left in front: their place (round 16)
            }
        }
        guard hit.pid != front || elsewhere || isTarget else { return nil }
        if hit.pid == front, !elsewhere {
            // Into the bound target that is in front already: no activation will come — their place now.
            guardianLock.withLock { guardianCore.userClickedFront(app: hit.pid, space: sys.activeSpace(), now: now) }
            CULog.guardian.notice("the user clicked into \(self.appName(hit.pid), privacy: .public), in front already: their place")
            return hit.pid
        }
        // A click on a window is for ITS app: it explains that app coming forward (and its desktop), nothing else — ONE
        // input for one change (an app switch takes the desktop along; found by the model-based test: a click on another
        // display's window left a second instant that made the app's own coming forward later "theirs").
        if hit.pid != front { noteSwitchInput(now: now, .app, target: hit.pid) } else if elsewhere { noteSwitchInput(now: now, .desktop, target: hit.pid) }
        let space = elsewhere ? sys.windowSpaces(hit.id)?.first : sys.activeSpace()
        guardianLock.withLock { guardianCore.userClicked(app: hit.pid, space: space, now: now) }
        let name = appName(hit.pid)
        CULog.guardian.notice("the user clicked into \(name, privacy: .public)'s window \(hit.id, privacy: .public): claimed as their move")
        if isTarget, sys.frontmostPid() != hit.pid {
            // The window clicked comes forward with its app — never the app's main window elsewhere (an activation alone
            // follows that one, to its desktop: found by the model-based test, a click into the target's window here took
            // the user to the desktop of its other window). Only once the button comes up WITHOUT a drag (review of round
            // 9, #8): a drag out of a background window activates nothing — a file dragged from a background Finder into
            // Mail must not bring Finder up over the drop.
            guardianLock.withLock { pendingClickBring = (hit.pid, hit.id, point, now) }
        }
        return hit.pid
    }

    /// The user's left button came up (the session tap): a click — not a drag — into a bound target's background window
    /// brings that window forward with its app now.
    func onPhysicalMouseUp(at point: CGPoint, userData: Int64, now: Double) {
        guard !CUEventStamp.isOurs(userData) else { return }
        guard let p = guardianLock.withLock({ () -> (pid: pid_t, wid: UInt32, at: CGPoint, time: Double)? in
            defer { pendingClickBring = nil }
            return pendingClickBring
        }) else { return }
        guard now - p.time <= 2, hypot(point.x - p.at.x, point.y - p.at.y) <= Self.clickSlop else {
            CULog.guardian.notice("the user dragged out of \(self.appName(p.pid), privacy: .public)'s window: nothing brought forward")
            // A drag claims nothing either: its button-down's claim goes (the ordinary-target survey's seed 54 — a drag
            // out of T's window later explained T's landing as "they clicked into its window", and the work mark refused
            // the agent).
            guardianLock.withLock { guardianCore.dropClaim(app: p.pid) }
            return
        }
        guard sys.frontmostPid() != p.pid else { return }
        // (Its landing is the click's — round 19, the guardian's `noteClickBring`.)
        let clickedSpace = sys.windowSpaces(p.wid)?.first ?? sys.activeSpace()
        guardianLock.withLock { guardianCore.noteClickBring(p.pid, clickAt: p.time, space: clickedSpace, now: clock.nowSeconds()) }
        let bring = { [weak self] in
            guard let self else { return }
            if let w = self.targetWindowElement(pid: p.pid, windowID: p.wid) { try? self.ax.perform(w, kAXRaiseAction) }
            _ = self.sys.activate(pid: p.pid)
        }
        if guardianRestoreSync { bring() } else { DispatchQueue.global(qos: .userInitiated).async(execute: bring) }
    }

    /// How far the pointer may move between a button's down and up and still be a click (points).
    static let clickSlop: CGFloat = 4

    /// The accessibility element of a bound target's window `windowID` (its bound window's, else the app's listing).
    func targetWindowElement(pid: pid_t, windowID: UInt32) -> AXUIElement? {
        if let t = boundTargets().first(where: { $0.pid == pid && $0.windowID == windowID }), let w = try? windowElement(t) { return w }
        return CUAXWindows.list(pid: pid, ax: ax, server: sys.windows(pid: pid)).first { $0.id == windowID }?.element
    }

    /// A click on the empty desktop (no window under it — the desktop's own window is not in the stack): Finder comes
    /// forward on this desktop — claimed as the user's (the review of round 8: with Finder bound and touched, it was
    /// undone).
    private func desktopClick(now: Double, flags: CGEventFlags) -> pid_t? {
        // (Finder in front already: still claimed — something else may come forward before its activation lands.)
        guard !flags.contains(.maskCommand), let finder = sys.runningPid(bundleId: "com.apple.finder") else { return nil }
        noteSwitchInput(now: now, .app, target: finder)
        guardianLock.withLock { guardianCore.userClicked(app: finder, space: sys.activeSpace(), now: now) }
        CULog.guardian.notice("the user clicked the empty desktop: Finder's coming forward claimed as their move")
        return finder
    }

    /// Whether a window of the helper's own takes clicks (the desktop-switch prompt) rather than letting them through (the
    /// cursor overlay, the mirror panel): the presentation says which (`ownClickableWindows`), else by level — the prompt
    /// floats at the status-bar level, the click-through panels at the floating one.
    func ownWindowTakesClicks(_ w: CUWindowServerWindow) -> Bool {
        if let set = ownClickableWindows { return set().contains(w.id) }
        return w.layer >= Int(CGWindowLevelForKey(.statusWindow))
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
            // (A run loop with no source left returns `.finished` at once: the thread ends then, never spins.)
            while !Thread.current.isCancelled {
                let r = CFRunLoopRunInMode(.defaultMode, 0.25, false)
                if r == .stopped || r == .finished { break }
            }
        }
        thread.name = "Winter CPS focus tap"
        cpsTapThread = thread
        thread.start()
    }

    /// The CPS tap was disabled by the system (a slow callback, or secure input): on again (review of round 12, LOW).
    func reenableCPSTap() {
        guardianLock.withLock { if let port = cpsTapPort { CGEvent.tapEnable(tap: port, enable: true) } }
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
/// returns the event unchanged (listen-only ignores the return); a tap the system disabled is enabled again.
private let cpsTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon, let core = Unmanaged<CUCPSTapContext>.fromOpaque(refcon).takeUnretainedValue().core else {
        return Unmanaged.passUnretained(event)
    }
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        core.reenableCPSTap()
        return Unmanaged.passUnretained(event)
    }
    // Hardware-origin input (no source process, not ours, a type a person makes): the user's own — a pointer move
    // told apart.
    if type.rawValue != CUFocusTaps.processNotificationType {
        let pointer = type == .rightMouseDown || type == .otherMouseDown || type == .scrollWheel
        let scroll = type == .scrollWheel
        core.noteTapEvent(type: type, sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID),
                          userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
                          keycode: type == .keyDown ? event.getIntegerValueField(.keyboardEventKeycode) : -1,
                          location: pointer ? event.location : nil,
                          targetPid: type == .keyDown ? event.getIntegerValueField(.eventTargetUnixProcessID) : 0,
                          scrollPhase: scroll ? event.getIntegerValueField(.scrollWheelEventScrollPhase) : 0,
                          momentumPhase: scroll ? event.getIntegerValueField(.scrollWheelEventMomentumPhase) : 0,
                          now: core.clock.nowSeconds())
    }
    if type == .leftMouseDown {
        core.onPhysicalClick(at: event.location, userData: event.getIntegerValueField(.eventSourceUserData), flags: event.flags,
                             clickCount: event.getIntegerValueField(.mouseEventClickState), now: core.clock.nowSeconds())
        return Unmanaged.passUnretained(event)
    }
    if type == .leftMouseUp {
        core.onPhysicalMouseUp(at: event.location, userData: event.getIntegerValueField(.eventSourceUserData), now: core.clock.nowSeconds())
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
    /// Input that can launch an app (the launch rule's (1), R17-d (i), the controller's ruling): a button down, Return or
    /// Enter, a key with ⌘, ⌃ or ⌥, a function key — never plain character typing, a key-up, a scroll or a pointer move.
    static func canLaunch(type: CGEventType, flags: CGEventFlags, keycode: Int64) -> Bool {
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown: return true
        case .keyDown:
            if keycode == 36 || keycode == 76 || functionKeys.contains(keycode) { return true }
            return flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate)
        default: return false
        }
    }
    /// F1–F20's virtual key codes.
    static let functionKeys: Set<Int64> = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]

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
