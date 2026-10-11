import AppKit
import CoreGraphics
import Foundation

/// The Focus Guardian's decision core: WHOSE MOVE a change of the user's front app or desktop is — the one rule every
/// path asks (PROTOCOL.md §4.12) — and everything that rule reads, kept in one place so the paths cannot disagree:
/// where the user is (their PLACE), what the agent did to which app and when (its CAUSES, per pid), the user's input
/// that can switch apps or desktops, their physical clicks into the agent's windows, a desktop visit in progress, the
/// consented foreground, the restores issued. The live wiring (`CUCore+Guardian`) only feeds it facts and carries out
/// what it decides.
///
/// The contract (the invariants the model-based test checks — against the WORLD's own record of who caused each change,
/// never against this core):
/// - I1. Only a change that brought forward an app the agent TOUCHED — bound, acted on, launched, opened, sent a
///   synthetic event, raised or restored, per pid, within its causal window (or while an operation on it runs) — or
///   the agent's INDIRECT effect can ever be undone. An app the agent never touched coming forward is the user's,
///   unless it is the agent's indirect effect: an already-running app coming forward while the agent is active (within
///   the causal window of an act that could cause it — a click, a key, an AppleScript, an open, a launch, on any app)
///   with NO input of the user's the session tap saw since that act (a link the agent clicked opening in a browser, a
///   file its AppleScript opened in Preview) — undone like a theft, their place unchanged, and the model told
///   (`indirect`). Never undone even then: an app's FIRST activation after a launch the agent did not make (the user's
///   own slow launch: theirs), and a system dialog (UserNotificationCenter, CoreServicesUIAgent, SecurityAgent — a
///   permission or authentication prompt the user must be able to answer): left in front, not their place, and said
///   (`unexplained`).
/// - I2. Once a change is the user's, nothing undoes it, and every restore goes to the CURRENT place (`view`), never
///   to one captured before it — a restore that lands after they moved elsewhere is the restore's, never adopted.
/// - I3. A key the user types goes to where they are at that moment (the reroute asks `keyPlace`) — never into a
///   target that took the front without being judged their move, never into an app they left.
/// - I4. A touched app that comes forward with no switch-capable input of the user's for it is undone (and a typing
///   burst into it stops). Each switch input explains ONE change — the first it fits, whoever's app that is.
/// - I5. Every path that can see a change asks `judge`, with the time its own operation began, and acts only on its
///   full verdict: only `.agent` and `.indirect` are ever undone — a desktop visit's switch, the consented foreground and
///   an `unexplained` system dialog are left alone by every path. A state already judged gets the same verdict until new facts
///   arrive.

/// What the user is looking at, as the guardian tracks it.
public struct CUGuardedView: Equatable, Sendable {
    public var app: pid_t?
    public var space: UInt64?
    public init(app: pid_t? = nil, space: UInt64? = nil) {
        self.app = app
        self.space = space
    }
}

/// Whose move a change of the user's front app or desktop is (`CUFocusGuardianCore.judge`).
public enum CUMoveOwner: Equatable, Sendable {
    /// Nothing moved: the state IS the user's place (read by a path as "the user is where they belong").
    case theirPlace
    /// The user's own move: never undone, and their place follows it.
    case user(String)
    /// The consented foreground: the agent's, allowed.
    case consented
    /// The agent's or the target's own doing: undone.
    case agent(String)
    /// A desktop visit's own switch: neither undone nor adopted while it lasts.
    case visit
    /// The agent's INDIRECT effect (I1): an app it never touched, already running, came forward while it was active with
    /// no input of the user's since its last cause — undone like a theft, and said to the model.
    case indirect(String)
    /// A system dialog (a permission or authentication prompt) that came up while the agent was active with no input of
    /// the user's: left in front for them to answer — never undone, never their place — and said to the model.
    case unexplained(String)

    /// The user's — their place, or their move.
    public var isUsers: Bool {
        switch self {
        case .theirPlace, .user: return true
        default: return false
        }
    }

    /// Undone (I4): the agent's or the target's own doing — the only verdict any path may act against. Every other one is
    /// left alone: the user's, a visit's, the consented foreground's, an untouched app's (I5).
    public var undoes: Bool {
        switch self {
        case .agent, .indirect: return true
        default: return false
        }
    }

    public var words: String {
        switch self {
        case .theirPlace: return "already the user's place"
        case .user(let why): return "the user's: \(why)"
        case .consented: return "the consented foreground"
        case .agent(let why): return "the agent's: \(why)"
        case .visit: return "a desktop visit"
        case .indirect(let why): return "the agent's indirect effect: \(why)"
        case .unexplained(let why): return "left alone, not the user's place: \(why)"
        }
    }
}

/// One look at the user's front app and desktop that a path asks the rule about.
public struct CUMoveQuery: Equatable, Sendable {
    /// The front app and the active Space now.
    public var app: pid_t?
    public var space: UInt64?
    /// When the caller's own operation began: switch input counts from then, or from `switchWindow` back if that is
    /// earlier. Nil — an observer that only knows the change happened — `switchWindow` back.
    public var since: TimeInterval?
    /// Where the caller's own operation began: the user's place when the guard is not running.
    public var from: CUGuardedView?
    /// The front app's process start and bundle id — read only while the agent has a launch pending.
    public var appStartedAt: TimeInterval?
    public var appBundle: String?
    /// Whether switch-capable input can be seen at all (the session tap runs).
    public var inputObservable: Bool
    /// With no input source: the user's last physical click (HID state).
    public var clickAt: TimeInterval?
    /// For a change of desktop: the other apps it brought forward — those the agent touched whose window is shown on the
    /// new desktop. The desktop change can be the agent's doing through one of them (a raise, a visit, a restore).
    public var shown: [pid_t]
    /// The user's last hardware ACTION the session tap saw (a key, a click, a scroll, a gesture — never a pointer move):
    /// an app the agent never touched coming forward after it is theirs (I1).
    public var hardwareAt: TimeInterval?
    /// The front app is system UI — a permission or authentication dialog's process (UserNotificationCenter,
    /// CoreServicesUIAgent, SecurityAgent), or an app that is not a regular one: never undone as an indirect effect.
    public var appIsSystemUI: Bool

    public init(app: pid_t?, space: UInt64?, since: TimeInterval? = nil, from: CUGuardedView? = nil,
                appStartedAt: TimeInterval? = nil, appBundle: String? = nil, inputObservable: Bool = true, clickAt: TimeInterval? = nil,
                shown: [pid_t] = [], hardwareAt: TimeInterval? = nil, appIsSystemUI: Bool = false) {
        self.app = app
        self.space = space
        self.since = since
        self.from = from
        self.appStartedAt = appStartedAt
        self.appBundle = appBundle
        self.inputObservable = inputObservable
        self.clickAt = clickAt
        self.shown = shown
        self.hardwareAt = hardwareAt
        self.appIsSystemUI = appIsSystemUI
    }
}

public struct CUFocusGuardianCore: Sendable {
    /// With no input source, how recent a physical click must be to make a change the user's.
    public static let userInputWindow: TimeInterval = 0.4
    /// How long after the agent's cause (an act, a synthetic event, a raise, a restore, an open, a launch, an
    /// operation's end) a change of that app may still be the agent's doing.
    public static let causalWindow: TimeInterval = 1.5
    /// How far back an observer (which does not know when the change began) counts switch input.
    public static let switchWindow: TimeInterval = 1
    /// A desktop change that follows the user's own move into an app, within this, is part of that move.
    public static let followOnWindow: TimeInterval = 1.5
    /// How long a physical click into a window claims the activation it causes.
    public static let clickClaimWindow: TimeInterval = 1.5
    /// A repeat offender: this many thefts within the window.
    public static let repeatCount = 3
    public static let repeatWindow: TimeInterval = 10
    /// The longest a visit mode lasts if its end is never told (a visit takes ~0.5–3 s).
    public static let visitMaxSeconds: TimeInterval = 10
    /// How long after a restore's last activation it may still land and be heard (AXFrontmost takes ~0.3 s across
    /// desktops, NSWorkspace's notification more): the app it restored coming forward once the user's place has moved
    /// away from it is the restore's late landing — undone, never adopted (I2). Measured from the LAST attempt (every
    /// retry notes it): an app the restore brought back long ago coming forward again is not its doing.
    public static let restoreLateWindow: TimeInterval = 0.8
    /// How long after a switch input its change can still be HEARD — the switcher's, the Dock's or a swipe's own latency
    /// (10 ms to ~0.35 s) plus NSWorkspace's notification (≤ 13 ms measured, run108): within it, an agent's cause that
    /// cannot raise a window (an act, a synthetic event) never outranks the input (the review of round 8: a busy script's
    /// next act, 30 ms after the user's ⌘ release and before the switcher's activation, made their ⌘-Tab into the target
    /// "the agent's").
    public static let switchLandWindow: TimeInterval = 0.45

    /// The user's PLACE: where they are, by their own moves. Every restore goes here, read when it runs.
    public private(set) var view = CUGuardedView()
    /// When the user last moved to `view` themselves.
    public private(set) var viewAt: TimeInterval = -.infinity
    public private(set) var active = false
    /// The one exemption: the consented foreground, for one app, until a deadline — and the user's place before it came
    /// forward (its end gives the front back there, unless the user moved meanwhile).
    private var exemptApp: pid_t?
    private var exemptUntil: TimeInterval = 0
    private var exemptPrevious: CUGuardedView?
    /// When the consented foreground's own activation was issued: its landing (within `restoreLateWindow`) is the
    /// consent's — never taken for a switch of the user's that a moment later brings them elsewhere (found by the model-based
    /// test: the held app's landing took the user's Dock click, and the Dock's own activation was undone).
    private var exemptIssuedAt: TimeInterval = -.infinity
    /// When each app was last judged in front: a late activation notification of one seen since the last notification is
    /// a change already judged.
    private var seenFront: [pid_t: TimeInterval] = [:]
    /// Theft times per app, for repeat detection.
    private var thefts: [pid_t: [TimeInterval]] = [:]
    /// The user physically clicked into this app's window: its coming forward is theirs until `until` — used up by the
    /// first change it explains, and gone once they move anywhere else.
    private var claim: (app: pid_t, until: TimeInterval)?
    /// A DESKTOP VISIT in progress (the user agreed to be taken to `visitApp`'s desktop): until its end (or the
    /// deadline), the switch there and the way back are the agent's own — neither undone nor adopted — unless the rule
    /// finds the user moved (`visitSawUserInput`: where they went is then theirs, and the visit leaves them there).
    private var visitApp: pid_t?
    private var visitUser: pid_t?
    private var visitUntil: TimeInterval = 0
    private var visitStartedAt: TimeInterval = 0
    public private(set) var visitSawUserInput = false
    /// The agent's causes: the last time it did something to each app that could bring it forward, operations still
    /// running on an app (an act, an AppleScript, a bind's window wait, a visit), and launches pending.
    private var causes: [pid_t: TimeInterval] = [:]
    /// The same for causes that can bring a window or a desktop forward (an activation, a raise, a main-window write, a
    /// visit, a restore, an AppleScript): the only kind that can make a desktop change through an app that stays in the
    /// background, and the only kind that outranks the user's switch input it follows.
    private var raises: [pid_t: TimeInterval] = [:]
    /// Until when an app stays touched after an operation on it ENDED (an act, a blip, a span, a launch, a visit): its
    /// delayed reactions are still the agent's — but an end is no new action, so it never makes the user's input during
    /// the operation "before the agent's last cause".
    private var touchedUntil: [pid_t: TimeInterval] = [:]
    private var raiseTouchedUntil: [pid_t: TimeInterval] = [:]
    /// What the agent did to an app while it was ALREADY in front (an act on the user's own front app): it can't have
    /// brought it forward, so it counts only once the app has left the front (a later return of it may be its doing) —
    /// never for the change that put it there.
    private var frontGlow: [pid_t: (at: TimeInterval, raise: Bool)] = [:]
    /// The agent's last CAUSE on an app while it was in front (an action, an operation's start — never an end): once the
    /// app leaves the front it is that app's last cause, so the user's input from before it explains no later return of
    /// the app (found by the model-based test: their click into the target, then the agent's act there, then the target
    /// coming back after they left was "theirs" by that click).
    private var frontCause: [pid_t: (at: TimeInterval, raise: Bool)] = [:]
    /// Operations begun on an app while it was in front (and how many of them can raise): they count as spans once it
    /// leaves the front.
    private var frontSpans: [pid_t: (n: Int, raise: Int)] = [:]
    private var spans: [pid_t: Int] = [:]
    /// The running spans that can raise a window or a desktop (an AppleScript, a bind's window wait, a useWindow — an
    /// act cannot).
    private var raiseSpans: [pid_t: Int] = [:]
    private var launches: [Int: (since: TimeInterval, bundle: String?)] = [:]
    private var launchSeq = 0
    /// The restores issued, per app (I2's late landing).
    private var restoredAt: [pid_t: TimeInterval] = [:]
    /// The agent's last cause on ANY app (an act, a synthetic event, a span's start, a launch, a visit, an action on the
    /// front app): I1's refinement asks whether the user's input came after it.
    public private(set) var lastCauseAny: TimeInterval = -.infinity {
        didSet { if lastCauseAny > oldValue { causeTimes.append(lastCauseAny); if causeTimes.count > 64 { causeTimes.removeFirst(causeTimes.count - 64) } } }
    }
    /// The agent's causes (on any app) and the user's hardware actions, in time order: a state already seen is judged on
    /// the facts from before it was first seen (`upTo`) — never on input or a cause that came after (found by the
    /// model-based test: a click of theirs a second after an app came forward on its own made it, on a second look, "theirs").
    private var causeTimes: [TimeInterval] = []
    private var hardwareTimes: [TimeInterval] = []
    /// Apps launched since the guard began that the agent did not launch, until their first activation: that one is the
    /// user's (their own slow launch — never undone as an indirect effect).
    private var othersLaunches: [pid_t: TimeInterval] = [:]
    /// How long a launch's first activation is waited for.
    static let launchFirstWindow: TimeInterval = 60
    /// The user's input that can switch apps or desktops (fed by the session tap, the gesture monitor and the clicks).
    var input = CUSwitchInput()
    /// Bumped whenever new input of the user's arrives: a state judged before it is judged again.
    private var evidence = 0
    /// The last state judged, its verdict, and the facts it was judged on (the user's input so far, the agent's last
    /// cause on that app): new facts of either kind and it is judged again.
    private var judged: (app: pid_t?, space: UInt64?, owner: CUMoveOwner, evidence: Int, cause: TimeInterval, seenAt: TimeInterval,
                         before: CUGuardedView)?
    /// The last state any path looked at: what a change is a change FROM (which app or desktop it moved) — the user's
    /// place can be stale, and a desktop switch must never explain an app coming forward on the desktop that was already
    /// shown.
    private var lastSeen: CUGuardedView?
    /// Why the last judgement went as it did, whether it was a fresh one, and whether its theft was a repeat.
    public private(set) var lastReason = ""
    public private(set) var lastFresh = false
    public private(set) var lastRepeatOffender = false

    public init() {}

    // MARK: guarding

    /// Starts guarding, seeding the user's place. Idempotent.
    public mutating func begin(view: CUGuardedView) {
        if !active {
            self.view = view
            viewAt = -.infinity
            judged = nil
        }
        active = true
    }

    public mutating func end() {
        active = false
        thefts.removeAll()
        exemptApp = nil
        exemptPrevious = nil
        claim = nil
        judged = nil
        lastSeen = nil
        restoredAt.removeAll()
        if visitApp != nil { endVisit() }
    }

    // MARK: the agent's causes

    /// The agent did something to `pid` that can bring it forward: a change of it within `causalWindow` may be its doing.
    /// `raise`: it can bring a window or a desktop forward (an activation, a raise, a main-window write).
    public mutating func noteCause(_ pid: pid_t, raise: Bool = false, now: TimeInterval) {
        causes[pid] = max(causes[pid] ?? -.infinity, now)
        if raise { raises[pid] = max(raises[pid] ?? -.infinity, now) }
        lastCauseAny = max(lastCauseAny, now)
    }

    /// The agent did something to `pid` while it was the front app: touched once it leaves the front (see `frontGlow`).
    public mutating func noteFrontAfterglow(_ pid: pid_t, raise: Bool = false, now: TimeInterval, cause: Bool = true) {
        frontGlow[pid] = (now, raise || (frontGlow[pid]?.raise ?? false))
        // An operation's END on it is no new cause (found by the model-based test: an act on the user's front app ending
        // after their key made an app that came forward a moment later "the agent's indirect effect").
        if cause {
            lastCauseAny = max(lastCauseAny, now)
            frontCause[pid] = (max(frontCause[pid]?.at ?? -.infinity, now), raise || (frontCause[pid]?.raise ?? false))
        }
    }

    /// An operation on `pid` ended (an act, a blip): it stays touched for `causalWindow` — without being a new cause.
    public mutating func noteAfterglow(_ pid: pid_t, raise: Bool = false, now: TimeInterval) {
        touchedUntil[pid] = max(touchedUntil[pid] ?? -.infinity, now + Self.causalWindow)
        if raise { raiseTouchedUntil[pid] = max(raiseTouchedUntil[pid] ?? -.infinity, now + Self.causalWindow) }
    }

    /// An operation on `pid` runs (an act, an AppleScript, a bind's window wait, a visit): it counts as touched
    /// throughout — begun while the app is in front (`whileFront`), only once it has left the front (see `frontGlow`).
    /// `raise`: the operation can bring a window or a desktop forward (not an act).
    public mutating func beginSpan(_ pid: pid_t, whileFront: Bool = false, raise: Bool = true, now: TimeInterval) {
        lastCauseAny = max(lastCauseAny, now)
        if whileFront {
            var f = frontSpans[pid] ?? (0, 0)
            f.n += 1
            if raise { f.raise += 1 }
            frontSpans[pid] = f
            frontCause[pid] = (max(frontCause[pid]?.at ?? -.infinity, now), raise || (frontCause[pid]?.raise ?? false))
            return
        }
        spans[pid, default: 0] += 1
        if raise { raiseSpans[pid, default: 0] += 1 }
        noteCause(pid, raise: raise, now: now)
    }

    /// The operation ended: touched for `causalWindow` more (an afterglow, not a new cause). `raise` as it began.
    public mutating func endSpan(_ pid: pid_t, raise: Bool = true, now: TimeInterval) {
        if var f = frontSpans[pid], f.n > 0 {
            f.n -= 1
            if raise, f.raise > 0 { f.raise -= 1 }
            frontSpans[pid] = f.n > 0 ? f : nil
            noteFrontAfterglow(pid, raise: raise, now: now, cause: false)
            return
        }
        guard let n = spans[pid] else { return }
        spans[pid] = n > 1 ? n - 1 : nil
        if raise, let r = raiseSpans[pid] { raiseSpans[pid] = r > 1 ? r - 1 : nil }
        noteAfterglow(pid, raise: raise, now: now)
    }

    /// The agent may launch an app: once its bundle is known (`setLaunchBundle`), an app of that bundle whose process
    /// started after `now` is touched until `endLaunch`, and the launched pid for `causalWindow` after.
    public mutating func beginLaunch(bundle: String? = nil, now: TimeInterval) -> Int {
        launchSeq += 1
        launches[launchSeq] = (now, bundle)
        lastCauseAny = max(lastCauseAny, now)
        return launchSeq
    }

    public mutating func setLaunchBundle(_ token: Int, _ bundle: String?) {
        launches[token]?.bundle = bundle
    }

    /// The most recent pending launch is for `bundle` (when the caller does not know its launch).
    public mutating func setLatestLaunchBundle(_ bundle: String?) {
        guard let k = launches.keys.max() else { return }
        launches[k]?.bundle = bundle
    }

    public mutating func endLaunch(_ token: Int, pid: pid_t?, now: TimeInterval) {
        launches[token] = nil
        if let pid { noteAfterglow(pid, raise: true, now: now) }
    }

    public var launchPending: Bool { launches.values.contains { $0.bundle != nil } }

    /// A restore re-activated `pid` (the user's place, as it was then): it may land late.
    public mutating func noteRestore(_ pid: pid_t, now: TimeInterval) {
        restoredAt = restoredAt.filter { now - $0.value <= Self.restoreLateWindow }
        restoredAt[pid] = now
    }

    /// An app a restore re-activated, coming forward after the user's place moved away from it since: the restore's late
    /// landing (I2) — touched, so it is undone (back to where they went).
    func restoreLate(_ app: pid_t, now: TimeInterval) -> TimeInterval? {
        guard let r = restoredAt[app], now - r <= Self.restoreLateWindow, viewAt > r, view.app != app else { return nil }
        return r
    }

    /// Whether the agent touched `app` recently enough that its coming forward can be the agent's doing.
    public func isTouched(_ app: pid_t?, startedAt: TimeInterval? = nil, bundle: String? = nil, now: TimeInterval) -> Bool {
        guard let app else { return false }
        if (spans[app] ?? 0) > 0 { return true }
        // A visit's apps — the way there and the way back are the agent's — while it lasts.
        if visiting(now: now), app == visitApp || app == visitUser { return true }
        if let c = causes[app], now - c <= Self.causalWindow { return true }
        if let u = touchedUntil[app], now <= u { return true }
        if restoreLate(app, now: now) != nil { return true }
        // An app the agent is launching: its process started after the launch began, and it is that bundle (a launch
        // counts once its bundle is known — the bind's resolver says so as it launches).
        if let s = startedAt {
            for l in launches.values where l.bundle != nil && s >= l.since - 0.25 && (bundle == nil || l.bundle == bundle) {
                return true
            }
        }
        return false
    }

    /// When the agent last did something to `app` (−∞ for never).
    public func lastCause(_ app: pid_t?) -> TimeInterval { app.flatMap { causes[$0] } ?? -.infinity }

    /// When the agent last did something to `app` that can raise a window or a desktop (−∞ for never).
    public func lastRaise(_ app: pid_t?) -> TimeInterval { app.flatMap { raises[$0] } ?? -.infinity }

    /// Whether the agent did something to `app` recently that can bring a window or a desktop forward.
    public func isRaiseTouched(_ app: pid_t, now: TimeInterval) -> Bool {
        if (raiseSpans[app] ?? 0) > 0 { return true }
        if visiting(now: now), app == visitApp || app == visitUser { return true }
        if let r = raises[app], now - r <= Self.causalWindow { return true }
        if let u = raiseTouchedUntil[app], now <= u { return true }
        return false
    }

    /// The apps that can make a desktop change while staying in the background, now (for `CUMoveQuery.shown`).
    public func raiseTouchedApps(now: TimeInterval) -> [pid_t] {
        var apps = Set(raiseSpans.keys)
        for (a, r) in raises where now - r <= Self.causalWindow { apps.insert(a) }
        for (a, u) in raiseTouchedUntil where now <= u { apps.insert(a) }
        if visiting(now: now) { if let a = visitApp { apps.insert(a) }; if let u = visitUser { apps.insert(u) } }
        return Array(apps).sorted()
    }

    /// Whether the agent was active at `at` (≤ now): an operation running (on any app, the front one included), a launch
    /// pending, a visit, or a cause or an operation's end within the causal window.
    public func agentActive(now: TimeInterval, at: TimeInterval? = nil) -> Bool {
        let t = at ?? now
        if !spans.isEmpty || !frontSpans.isEmpty || !launches.isEmpty || visiting(now: now) { return true }
        if t - lastCause(upTo: t) <= Self.causalWindow { return true }
        if touchedUntil.values.contains(where: { t <= $0 }) { return true }
        return frontGlow.values.contains { $0.at <= t && t - $0.at <= Self.causalWindow }
    }

    /// The agent's last cause on any app at or before `t`.
    func lastCause(upTo t: TimeInterval) -> TimeInterval { causeTimes.last { $0 <= t } ?? -.infinity }

    /// An app was launched (NSWorkspace) — not by the agent when it is not touched by a launch of the agent's: its first
    /// activation is the user's.
    public mutating func appLaunched(_ pid: pid_t, startedAt: TimeInterval? = nil, bundle: String? = nil, now: TimeInterval) {
        guard !isTouched(pid, startedAt: startedAt, bundle: bundle, now: now) else { return }
        othersLaunches = othersLaunches.filter { now - $0.value <= Self.launchFirstWindow }
        othersLaunches[pid] = now
    }

    /// The user's hardware action (a key, a click, a scroll, a gesture — never a pointer move), as the session tap saw it.
    public mutating func noteHardwareAction(now: TimeInterval) {
        hardwareTimes.append(now)
        hardwareTimes.removeAll { now - $0 > Self.keepFacts }
    }

    /// Whether input of the user's came after the agent's last cause on any app and by `upTo` (I1's refinement).
    func theirInputSinceTheAgent(upTo: TimeInterval, hardwareAt: TimeInterval?) -> Bool {
        let cause = lastCause(upTo: upTo)
        if hardwareTimes.contains(where: { $0 > cause && $0 <= upTo }) { return true }
        if let h = hardwareAt, h > cause, h <= upTo { return true }
        return false
    }

    /// How long the facts above are kept.
    static let keepFacts: TimeInterval = 10

    // MARK: the user's input

    /// One input event the session tap saw (already known to be the user's — hardware, not the helper's own).
    /// `secure`: Secure Event Input is on (the tap sees the modifiers but no keys — measured, run107).
    public mutating func inputEvent(type: CGEventType, flags: CGEventFlags, keycode: Int64 = -1, secure: Bool = false,
                                    now: TimeInterval) {
        if input.event(type: type, flags: flags, keycode: keycode, secure: secure, now: now) { evidence += 1 }
    }

    /// Input that can switch by itself: a click on the Dock, on a window of an app that is not in front (or on another
    /// display), on a status item, a banner or a floating panel, a trackpad swipe the gesture monitor saw.
    mutating func noteSwitch(now: TimeInterval, _ kind: CUSwitchInput.Kind = .app, target: pid_t? = nil) {
        input.note(now, kind, target: target)
        evidence += 1
    }

    /// The user physically clicked a window of `app` (an app's ordinary window, a bound target's, the desktop's Finder):
    /// the activation it causes is claimed as theirs. Their place moves there only once that activation is SEEN (judged
    /// theirs): a click that activates nothing (a drag out of a background window) moves nothing (the review of round 8:
    /// a theft before the next notification was "put back" into the clicked window's app).
    public mutating func userClicked(app: pid_t, space: UInt64?, now: TimeInterval) {
        evidence += 1
        claim = (app, now + Self.clickClaimWindow)
    }

    /// The user physically clicked into a window of the app ALREADY in front (a bound target's — held in front for a
    /// script, or in front by a change not judged theirs yet): no activation will come, and they are working in it — their
    /// place now (found by the model-based test: the hold's end gave the front back over their click into the held app).
    public mutating func userClickedFront(app: pid_t, space: UInt64?, now: TimeInterval) {
        evidence += 1
        claim = (app, now + Self.clickClaimWindow)
        guard active, !visiting(now: now) else { return }
        view = CUGuardedView(app: app, space: space ?? view.space)
        viewAt = now
        thefts[app] = nil
        exemptPrevious = nil
        judged = nil
    }

    // MARK: the one rule

    /// WHOSE MOVE the user's front app and desktop being `q.app` / `q.space` now is. In order:
    /// 0. It is their place (`view`; the caller's `from` when not guarding): nothing moved — `.theirPlace` (a change back
    ///    there uses up the switch input that took them there).
    /// 0'. The same state judged before, with no new input of theirs and no new cause of the agent's on that app since: the
    ///    same verdict (so every path agrees about one change, and no input is used twice).
    /// 1. I1 — the agent did not touch that app: a switch input of theirs that fits — or input of theirs since the agent's
    ///    last cause on any app, or an agent not active — makes it the user's; otherwise (an indirect effect of the
    ///    agent's action, as far as anyone can tell) `.unexplained`: neither undone nor adopted.
    /// 2. They clicked into its window (a claim): the user's.
    /// 3. A desktop change following their own move into that app (no agent cause on it since): the user's.
    /// 4. Switch-capable input of theirs AFTER the agent's last RAISING cause on that app — and after its last cause of any
    ///    kind, unless the change is heard within `switchLandWindow` of the input (#8): the user's. Each input explains
    ///    one change only (the first it fits).
    /// 5. No input source (no session tap): a physical click of theirs, after the agent's cause, just before: the user's.
    /// 6. A desktop visit in progress: its own (their input in the visited app included: the visit's end decides).
    /// 7. The consented foreground for that app: allowed.
    /// 8. Otherwise the agent's — undone.
    /// A user's verdict moves their place there (I2), uses up their claim, and during a visit means they moved.
    public mutating func judge(_ q: CUMoveQuery, now: TimeInterval) -> CUMoveOwner {
        let place = active ? view : (q.from ?? view)
        lastFresh = false
        lastRepeatOffender = false
        // An app that has left the front: what the agent did to it while it was there counts from now on.
        for (pid, f) in frontSpans where pid != q.app {
            frontSpans[pid] = nil
            spans[pid, default: 0] += f.n
            if f.raise > 0 { raiseSpans[pid, default: 0] += f.raise }
        }
        for (pid, g) in frontGlow where pid != q.app {
            frontGlow[pid] = nil
            touchedUntil[pid] = max(touchedUntil[pid] ?? -.infinity, g.at + Self.causalWindow)
            if g.raise { raiseTouchedUntil[pid] = max(raiseTouchedUntil[pid] ?? -.infinity, g.at + Self.causalWindow) }
        }
        for (pid, c) in frontCause where pid != q.app {
            frontCause[pid] = nil
            causes[pid] = max(causes[pid] ?? -.infinity, c.at)
            if c.raise { raises[pid] = max(raises[pid] ?? -.infinity, c.at) }
        }
        let previous = lastSeen ?? place
        let current = CUGuardedView(app: q.app, space: q.space)
        lastSeen = current
        if let a = q.app { seenFront[a] = now }
        if let app = q.app, app == place.app, q.space == nil || place.space == nil || q.space == place.space {
            // Their place's desktop not known (an activation heard late, of an app with windows on several): it is this one.
            if active, view.space == nil, let sp = q.space { view.space = sp }
            // A change BACK to their place uses up the switch input that took them there (#4: left unused, it explained
            // another app's activation a moment later) — never the landing of a restore of ours, which no input caused.
            if previous != current, restoredAt[app].map({ now - $0 > Self.restoreLateWindow }) ?? true {
                let (appMoved, desktopMoved) = Self.moved(q, from: previous)
                input.useOldest(from: now - Self.switchWindow, upTo: now, app: appMoved, desktop: desktopMoved, front: app, heardAt: now)
            }
            // Back at their place: a claim of a click elsewhere is gone (they moved on from it).
            if previous != current, let c = claim, c.app != app { claim = nil }
            judged = nil
            lastReason = CUMoveOwner.theirPlace.words
            return .theirPlace
        }
        if let j = judged, j.app == q.app, j.space == q.space, j.cause == lastCause(q.app) {
            // The same verdict until new facts arrive — and a user's move stays theirs even then (I5: new input can make a
            // change theirs, never take it back; found by the model-based test: a key of theirs re-judged their Dock click
            // into the target, whose switch input was used up, as the agent's).
            if j.evidence == evidence || j.owner.isUsers {
                lastReason = j.owner.words + " (judged before)"
                return j.owner
            }
        }
        // A state already seen, judged again on new facts: input that came after it was first seen can't have caused it.
        // (Only while nothing new of the agent's happened to that app: a new cause means the state may have been left and
        // reached again, unseen.)
        let again = judged.flatMap { $0.app == q.app && $0.space == q.space && $0.cause == lastCause(q.app) ? $0 : nil }
        let seenAt = again?.seenAt ?? now
        let before = again?.before ?? (previous == current ? place : previous)
        let (owner, use) = decide(q, place: place, before: before, upTo: seenAt, now: now)
        switch use {
        case .instant(let at, let keep)?: input.use(at, heardAt: seenAt, keepSecond: keep)
        case .oldest(let app, let desktop)?:
            input.useOldest(from: now - Self.switchWindow, upTo: seenAt, app: app, desktop: desktop, front: q.app, heardAt: seenAt)
        case nil: break
        }
        judged = (q.app, q.space, owner, evidence, lastCause(q.app), seenAt, before)
        lastFresh = true
        lastReason = owner.words
        switch owner {
        case .user:
            if visiting(now: now) { visitSawUserInput = true }
            view = CUGuardedView(app: q.app ?? view.app, space: q.space ?? view.space)
            viewAt = now
            if let a = q.app { thefts[a] = nil }
            claim = nil
            exemptPrevious = nil
        case .consented:
            if exemptPrevious == nil, view.app != q.app { exemptPrevious = view }
            view = CUGuardedView(app: q.app ?? view.app, space: q.space ?? view.space)
        case .agent:
            if let a = q.app {
                var times = (thefts[a] ?? []).filter { now - $0 < Self.repeatWindow }
                times.append(now)
                thefts[a] = times
                lastRepeatOffender = times.count >= Self.repeatCount
            }
        case .indirect:
            if let a = q.app {
                var times = (thefts[a] ?? []).filter { now - $0 < Self.repeatWindow }
                times.append(now)
                thefts[a] = times
                lastRepeatOffender = times.count >= Self.repeatCount
            }
        case .visit, .theirPlace, .unexplained:
            break
        }
        if let a = q.app, owner.isUsers || owner.undoes { othersLaunches[a] = nil }  // its first activation, judged
        return owner
    }

    /// Which switch input a verdict used up: the one that explained it (`keep`: an untouched app's — it stays a second,
    /// short-lived explanation when heard right after the input), or the oldest one that fits the change.
    enum InputUse: Equatable { case instant(TimeInterval, keep: Bool), oldest(app: Bool, desktop: Bool) }

    private func decide(_ q: CUMoveQuery, place: CUGuardedView, before: CUGuardedView, upTo: TimeInterval,
                        now: TimeInterval) -> (CUMoveOwner, InputUse?) {
        let visit = visiting(now: now)
        let app = q.app
        // What the change brought forward that the agent touched: the app that came to the front (any cause can make an
        // app activate itself) — and, only when no other app came forward (their own app stayed in front while the
        // desktop changed), the apps whose window the new desktop shows (only a cause that raises can do that).
        let front = isTouched(app, startedAt: q.appStartedAt, bundle: q.appBundle, now: now)
        let shown = app == before.app ? q.shown.filter { $0 != app && isRaiseTouched($0, now: now) } : []
        let (appMoved, desktopMoved) = Self.moved(q, from: before)
        // While guarding, the observers judge every change as it comes, so a path's late look counts only the input of
        // the last `switchWindow`. Not guarding, nothing judged the change when it came: from the caller's own start,
        // however long ago — and never less than `switchWindow` back.
        var from = active ? now - Self.switchWindow : min(q.since ?? now, now - Self.switchWindow)
        if visit { from = max(from, visitStartedAt) }
        // The first activation of an app the user launched (not the agent): theirs — during a visit too (they moved).
        if !front, let a = app, let l = othersLaunches[a], now - l <= Self.launchFirstWindow {
            return (.user("the first activation of an app the user launched"), nil)
        }
        // I1 — an app the agent never touched (during a visit, what it brings up is the visit's: below).
        if !front && shown.isEmpty, !visit {
            if let i = input.explanation(from: from, after: -.infinity, raiseAfter: -.infinity, now: upTo,
                                         app: appMoved, desktop: desktopMoved, front: app, targetedFirst: false) {
                return (.user("their input that switches apps or desktops, to an app the agent never touched"), .instant(i, keep: true))
            }
            // Its INDIRECT effect (a link it clicked opening in another app, a file it opened, a system agent's dialog):
            // the agent was active and the tap saw no input of theirs since its last cause — neither undone nor adopted.
            if q.inputObservable, agentActive(now: now, at: upTo), !theirInputSinceTheAgent(upTo: upTo, hardwareAt: q.hardwareAt) {
                // A system dialog (permission, authentication): theirs to answer — left in front, said.
                if q.appIsSystemUI {
                    return (.unexplained("a system dialog came up after the agent's action, with no input of the user's since"), nil)
                }
                return (.indirect("an app the agent never touched came forward right after its action, with no input of the user's since"), nil)
            }
            return (.user("the agent did not touch it — an app it never touched coming forward after input of theirs is theirs"), nil)
        }
        // The consented foreground's own landing: the consent's (before any input of the user's that came meanwhile).
        if let a = app, a == exemptApp, now < exemptUntil, now - exemptIssuedAt <= Self.restoreLateWindow,
           !(claim.map { $0.app == a && now <= $0.until } ?? false) {
            return (.consented, nil)
        }
        let late = app.flatMap { restoreLate($0, now: now) } ?? -.infinity
        let cause = max(front ? max(lastCause(app), late) : -.infinity, shown.map { raises[$0] ?? -.infinity }.max() ?? -.infinity)
        let raiseCause = max(front ? max(lastRaise(app), late) : -.infinity, shown.map { raises[$0] ?? -.infinity }.max() ?? -.infinity)
        if let a = app, let c = claim, c.app == a, now <= c.until {
            if visit, a == visitApp { return (.visit, nil) }
            // The click's own instant is used up by this change (one input, one change — found by the model-based test:
            // left unused, it made the app's return a moment after the user had left it "theirs").
            return (.user("they clicked into its window"), input.targeted(a, upTo: upTo).map { .instant($0, keep: false) })
        }
        if let a = app, a == place.app, viewAt >= now - Self.followOnWindow, cause <= viewAt {
            if visit, a == visitApp { return (.visit, nil) }
            return (.user("the desktop change that came with their own move into it"), .oldest(app: appMoved, desktop: desktopMoved))
        }
        // A restore's late landing (an app touched only by our restore of it) is never a switch's SECOND explanation: the
        // input that took them elsewhere was used by that move.
        // Nor the consented foreground's own landing.
        let onlyLate = (late > -.infinity && !isTouchedByTheAgent(app, q: q, now: now)) || (app != nil && app == exemptApp && now < exemptUntil)
        if let i = input.explanation(from: from, after: cause, raiseAfter: raiseCause, now: upTo,
                                     app: appMoved, desktop: desktopMoved, front: app, seconds: !onlyLate) {
            // On the visited desktop, their input in the visited app is no move away: the visit's end decides.
            if visit, let a = app, a == visitApp { return (.visit, nil) }
            return (.user("their input that switches apps or desktops (⌘-Tab, ⌃-arrows, a swipe, the Dock, a click on another app's window), after the agent's last action that could raise it"), .instant(i, keep: false))
        }
        if !q.inputObservable, let c = q.clickAt, now - c <= Self.userInputWindow, c > cause, c <= upTo, !visit || c >= visitStartedAt {
            if visit, let a = app, a == visitApp { return (.visit, nil) }
            return (.user("a click of theirs just before it (no input source tells more)"), nil)
        }
        if visit { return (.visit, nil) }
        if let a = app, a == exemptApp, now < exemptUntil { return (.consented, nil) }
        return (.agent(q.inputObservable
            ? "the agent touched it, and no input of the user's that switches apps or desktops came after"
            : "the agent touched it, and no input source tells more"), nil)
    }

    /// Touched by the agent's own causes (not merely by a restore of ours).
    private func isTouchedByTheAgent(_ app: pid_t?, q: CUMoveQuery, now: TimeInterval) -> Bool {
        guard let app else { return false }
        if (spans[app] ?? 0) > 0 || (visiting(now: now) && (app == visitApp || app == visitUser)) { return true }
        if let c = causes[app], now - c <= Self.causalWindow { return true }
        if let u = touchedUntil[app], now <= u { return true }
        if let s = q.appStartedAt {
            for l in launches.values where l.bundle != nil && s >= l.since - 0.25 && (q.appBundle == nil || l.bundle == q.appBundle) {
                return true
            }
        }
        return false
    }

    /// Whether the change brought forward an app the agent touched (I1), as `judge` would read it now (for tests).
    public func touches(_ q: CUMoveQuery, now: TimeInterval) -> Bool {
        let before = lastSeen ?? view
        if isTouched(q.app, startedAt: q.appStartedAt, bundle: q.appBundle, now: now) { return true }
        return q.app == before.app && q.shown.contains { $0 != q.app && isRaiseTouched($0, now: now) }
    }

    /// What a change moved, against the state before it: the front app, the desktop (unknown counts as moved).
    static func moved(_ q: CUMoveQuery, from place: CUGuardedView) -> (app: Bool, desktop: Bool) {
        (q.app != place.app, q.space == nil || place.space == nil || q.space != place.space)
    }

    // MARK: the consented foreground

    /// The consented foreground takes the front (for one action, or held for a script): its activation is allowed until
    /// `until`.
    public mutating func exempt(_ app: pid_t, until: TimeInterval, now: TimeInterval? = nil) {
        if let now { exemptIssuedAt = now }
        // A longer exemption of the same app (an app held in front for a script) is never cut short.
        if exemptApp == app, exemptUntil > until { return }
        if exemptApp != app { exemptPrevious = nil }
        exemptApp = app
        exemptUntil = until
    }

    /// Ends `app`'s exemption now (its hold or its action ended): the user's place is the one before it again — unless
    /// they moved meanwhile (their move is their place). Judged afresh from now on.
    public mutating func endExempt(_ app: pid_t) {
        guard exemptApp == app else { return }
        exemptApp = nil
        exemptUntil = 0
        if let prev = exemptPrevious, view.app == app { view = prev }
        exemptPrevious = nil
        judged = nil
    }

    // MARK: desktop visits

    /// A visit is in progress at `now` (begun, not ended, within its safety deadline).
    public func visiting(now: TimeInterval) -> Bool { visitApp != nil && now <= visitUntil }

    /// The user agreed to be taken to `app`'s desktop from `user`'s: until `endVisit` (or the deadline — `maxSeconds`,
    /// the primitive's own, else `visitMaxSeconds`), its own switches are neither undone nor adopted. Both apps count as
    /// touched while it lasts (the way there and the way back are the agent's), the target for the causal window after.
    public mutating func beginVisit(app: pid_t, user: pid_t? = nil, now: TimeInterval, maxSeconds: TimeInterval = visitMaxSeconds) {
        if visitApp != nil { endVisit(now: now) }
        visitApp = app
        visitUser = user
        visitUntil = now + maxSeconds
        visitStartedAt = now
        visitSawUserInput = false
        // What was judged before it is judged again: what the visit brings up is its own (I5), never a theft undone in
        // the middle of it (found by the model-based test: an app judged the agent's indirect effect a moment before the
        // visit, heard again during it, was undone over the visit's switch).
        judged = nil
        noteCause(app, raise: true, now: now)
    }

    /// The open visit runs on: its visit mode lasts until `until` (the safety cap, re-armed as work starts and ends).
    public mutating func extendVisit(until: TimeInterval) {
        guard visitApp != nil else { return }
        visitUntil = until
    }

    /// The visit is over: returns whether the rule found the user moved during it. Their place is still the pre-visit
    /// one unless they moved. A state judged a visit's is judged afresh from now on (its verdict ended with it).
    @discardableResult
    public mutating func endVisit(now: TimeInterval? = nil) -> Bool {
        let saw = visitSawUserInput
        // Its target stays touched for the causal window after it (a late switch of its making is still the agent's) —
        // never the user's own app, which is their place to come back to.
        if let now, let a = visitApp { noteAfterglow(a, raise: true, now: now) }
        visitApp = nil
        visitUser = nil
        visitUntil = 0
        visitSawUserInput = false
        judged = nil
        return saw
    }

    /// An app was activated and is no longer in front (heard of late, after whatever came next): that past change judged
    /// by the one rule as if seen live — the user's (their switch input, their click, I1): their place before what came
    /// next (adopted, `.user`); an untouched app with no input of theirs since the agent's last cause: `.unexplained`,
    /// not adopted; anything else (the agent's, a visit's, the consented foreground's): gone already, nothing to do (nil).
    /// Nil too during a visit, for their place already, or when what is in front now was already judged a MOVE of theirs
    /// (`live`: newer history). NSWorkspace posts activations in order, so what is in front now came forward AFTER this
    /// app: a verdict on it given before this was heard (their place, a theft) is judged again, from this app (found by the
    /// model-based test: a restore's late landing over the user's ⌘-Tab, heard before the ⌘-Tab's own activation, was
    /// "their place" — and their move was lost). `space`: the desktop it came forward on, as far as its windows tell
    /// (nil: unknown — then their place's desktop is learned when they are seen there).
    public mutating func adoptPast(_ app: pid_t, space: UInt64?, live: CUGuardedView, hardwareAt: TimeInterval? = nil,
                                   inputObservable: Bool = true, seenSince: TimeInterval = -.infinity, now: TimeInterval) -> CUMoveOwner? {
        guard active, app != view.app else { return nil }
        // During a visit only the user's click into that app's window (a claim) is judged: they moved, and the visit's end
        // brings them back THERE (found by the model-based test: a click during the visit's way there, the way there
        // landing after it, and the end took them to where the visit began).
        let clicked = claim.map { $0.app == app && now <= $0.until } ?? false
        if visiting(now: now) {
            guard clicked else { return nil }
            visitSawUserInput = true
            view = CUGuardedView(app: app, space: space ?? view.space)
            viewAt = now
            claim = nil
            return .user("they clicked into its window during a desktop visit")
        }
        // Already seen in front since the notification before this one: this change was judged then.
        if let s = seenFront[app], s >= seenSince { return nil }
        if let j = judged, j.app == live.app, j.space == live.space, j.owner.isUsers { return nil }
        // What is in front now is their place (judged theirs): a change before it, heard late, takes nothing back (I5 —
        // found by the model-based test: the Dock click's app on the other display, heard after the change it was paired
        // with, made that change the agent's) — unless they CLICKED into that app's window: that was their move, and
        // what came after it is judged from there (the model-based test: a restore landing 6 ms after their click into
        // another display's window).
        if !clicked, live.app == view.app, live.space == nil || view.space == nil || live.space == view.space { return nil }
        let q = CUMoveQuery(app: app, space: space, inputObservable: inputObservable, hardwareAt: hardwareAt)
        let (owner, use) = decide(q, place: view, before: lastSeen ?? view, upTo: now, now: now)
        switch owner {
        case .user:
            switch use {
            case .instant(let at, let keep)?: input.use(at, heardAt: now, keepSecond: keep)
            case .oldest(let a, let d)?: input.useOldest(from: now - Self.switchWindow, upTo: now, app: a, desktop: d, front: app, heardAt: now)
            case nil: break
            }
            view = CUGuardedView(app: app, space: space)
            lastSeen = CUGuardedView(app: app, space: space)
            viewAt = now
            thefts[app] = nil
            claim = nil
            exemptPrevious = nil
            judged = nil  // what is in front now is judged afresh, as a change from this app
            return owner
        case .unexplained:
            return owner
        default:
            return nil
        }
    }

    /// The user is somewhere of their own now (they moved during a visit): that is where later restores return them.
    public mutating func adoptUserView(_ v: CUGuardedView, now: TimeInterval? = nil) {
        guard active else { return }
        view = v
        if let now { viewAt = now }
        judged = nil
    }
}

/// Hardware input that can switch the front app or the desktop by itself — never typing, scrolling or a pointer move in
/// the user's own app (review of round 6). Each is an INSTANT that explains one change only, the first it fits:
/// - a ⌘ or ⌃ held and released with no chord seen in the hold — the switcher swallows ⌘-Tab, ⌃-arrows, so only the
///   modifier shows; a chord the tap sees (⌘S, ⌘-click, ⌃-scroll) went to an app and switches nothing;
/// - a switching chord the tap does see: ⌘-Tab, ⌘-`, ⌃-←/→/↑/↓;
/// - a trackpad rotate, magnify, swipe or smart magnify (types 18, 30, 31, 32) — never the generic gesture type 29,
///   which the window server sends with any touch on the trackpad (two-finger scrolls included); the global gesture
///   monitor still notes swipes by their begin/end markers;
/// - a click on the Dock, on a window of an app that is not in front, into a bound target's window, on the empty
///   desktop, on a status item, a banner or a floating panel (`note`).
/// And a ⌃ hold with no chord seen WHILE it lasts (the desktop switcher acts during it). Under Secure Event Input the tap
/// sees the modifiers but no key (measured on 2026-10-11, run107): a ⌘-Tab looks exactly like a ⌘ tap, so a chordless
/// ⌘ hold's release counts — briefly (`secureLife`: the switcher acts 10–70 ms after the release, so a stray ⌘C can
/// explain only a change heard right after it) — and a ⌃ hold counts as it does without secure input. Pure.
struct CUSwitchInput {
    /// What a switch can change: the front app (⌘-Tab, the Dock, a click on another app's window), or the desktop
    /// (⌃-arrows, a swipe). An app switch to an app on another desktop takes the desktop along (one change).
    enum Kind: Equatable { case app, desktop }
    /// Instants not yet used, oldest first; `target`: the app it was for, when known (a click on its window); `life`:
    /// how long after it a change it explains may be heard.
    private(set) var instants: [(at: TimeInterval, kind: Kind, target: pid_t?, life: TimeInterval)] = []
    /// Instants an untouched app's change used within `secondHeard` of them: still a SECOND explanation for a change
    /// heard until `until` (#4: an app that activated itself at the moment of the user's ⌘-Tab took its release, and their
    /// ⌘-Tab into the target, landing right after, was undone).
    private(set) var seconds: [(at: TimeInterval, kind: Kind, target: pid_t?, until: TimeInterval)] = []
    /// The last instant seen (for the log), used or not.
    private(set) var lastAt: TimeInterval = -1
    /// A ⌘/⌃ hold in progress: since when, whether a chord was seen in it, whether ⌃ is in it, and whether it began
    /// under Secure Event Input.
    private var hold: (since: TimeInterval, chord: Bool, control: Bool, secure: Bool, used: Bool, tabs: [TimeInterval])?
    /// The last ⌃ hold with no chord, once released: the desktops it passed are HEARD a moment later (NSWorkspace), and
    /// it still explains them then (found by the model-based test: a ⌃-arrow heard after the ⌃ went up was undone).
    private var lastControlHold: (since: TimeInterval, end: TimeInterval)?
    /// A hold whose release was never seen is not trusted past this.
    static let holdMax: TimeInterval = 10
    /// Instants older than this are dropped.
    static let keep: TimeInterval = 10
    /// A hold's release with no key seen (a ⌘-Tab under Secure Event Input, a ⌃ hold whose arrows were not seen) explains
    /// only a change heard within this of it (the switcher's or the desktop's latency and NSWorkspace's notification).
    static let secureLife: TimeInterval = 0.7
    /// An instant used up by an untouched app's change heard within this of it stays a second explanation …
    static let secondHeard: TimeInterval = 0.1
    /// … for a change heard until this long after the instant.
    static let secondLife: TimeInterval = 0.15
    /// Keys that switch apps, windows or desktops with ⌘ (Tab, `) or ⌃ (the arrows: Spaces, Mission Control).
    static let commandSwitchKeys: Set<Int64> = [48, 50]
    static let controlSwitchKeys: Set<Int64> = [123, 124, 125, 126]
    /// Gesture types that switch (rotate, magnify, swipe, smart magnify) — not 29 (see above).
    static let switchGestures: Set<UInt32> = [18, 30, 31, 32]

    static func modifier(_ flags: CGEventFlags) -> Bool { flags.contains(.maskCommand) || flags.contains(.maskControl) }

    /// Returns whether it added evidence (an instant, or a ⌃ hold that counts while it lasts).
    @discardableResult
    mutating func event(type: CGEventType, flags: CGEventFlags, keycode: Int64 = -1, secure: Bool = false, now: TimeInterval) -> Bool {
        switch type.rawValue {
        case CGEventType.flagsChanged.rawValue:
            if Self.modifier(flags) {
                if hold == nil {
                    hold = (now, false, flags.contains(.maskControl), secure, false, [])
                    return flags.contains(.maskControl)
                }
                if flags.contains(.maskControl), hold?.control == false { hold?.control = true; return true }
                return false
            }
            guard let h = hold else { return false }
            hold = nil
            if h.control, !h.chord { lastControlHold = (h.since, now) }
            // A ⌘-Tab switches at the RELEASE (the switcher stays up while ⌘ is held): its Tabs not used yet become one
            // instant there — one switch, and after anything the agent did while the switcher was up (found by the
            // model-based test: an act's main-window write between their Tab and their release undid their ⌘-Tab).
            if !h.tabs.isEmpty, now - h.since < Self.holdMax {
                let before = instants.count
                instants.removeAll { i in i.kind == .app && i.target == nil && h.tabs.contains(i.at) }
                if instants.count < before { add(now, .app); return true }
                return false
            }
            guard !h.chord else { return false }  // a chord an app got
            // A ⌃ hold that already explained the desktop switch it made (while it lasted): its release is no second
            // switch (found by the model-based test: the release's instant, left unused, made an untouched app's coming
            // forward a moment later "the user's").
            guard !h.used else { return false }
            // A release with no key seen (a ⌘-Tab whose Tab the tap did not get — Secure Event Input, or the switcher
            // took it; a ⌃ hold whose arrows it did not get): what it switched lands within moments of the release, so it
            // explains only a change heard that soon (found by the model-based test: a ⌃ hold whose desktop switch was
            // never heard on its own — the user's click on another display came first — explained an app's own coming
            // forward 0.7 s later).
            add(now, h.control ? .desktop : .app, life: Self.secureLife)
            return true
        case CGEventType.keyDown.rawValue:
            if flags.contains(.maskControl), Self.controlSwitchKeys.contains(keycode) {
                add(now, .desktop)  // ⌃-arrow, seen: the desktop switches now — the hold's release is no second switch
                hold?.chord = true
                return true
            }
            if flags.contains(.maskCommand), Self.commandSwitchKeys.contains(keycode) {
                add(now, .app)  // ⌘-Tab or ⌘-`, seen: a switch (⌘-Tab's moves to the release, above)
                hold?.chord = true
                if keycode == 48 { hold?.tabs.append(now) }
                return true
            }
            if Self.modifier(flags), hold != nil { hold?.chord = true }  // a chord an app got: no switch
        case 1, 3, 25, 22, 6, 7, 27:  // mouse down (left, right, other), scroll, drags — with ⌘/⌃ held, a chord
            if Self.modifier(flags), hold != nil { hold?.chord = true }
        case let t where Self.switchGestures.contains(t):
            add(now, .desktop)
            return true
        default:
            break
        }
        return false
    }

    mutating func note(_ now: TimeInterval, _ kind: Kind = .app, target: pid_t? = nil) { add(now, kind, target: target) }

    private mutating func add(_ now: TimeInterval, _ kind: Kind, target: pid_t? = nil, life: TimeInterval = keep) {
        lastAt = now
        instants.removeAll { now - $0.at > Self.keep }
        seconds.removeAll { now > $0.until }
        instants.append((now, kind, target, life))
    }

    /// Whether an instant of `kind` can explain a change that moved the front app (`app`) and/or the desktop.
    static func fits(_ kind: Kind, app: Bool, desktop: Bool) -> Bool { kind == .app ? app : desktop }

    /// Whether switch input explains a change seen at `now`: an instant not yet used, at or after `from`, after the
    /// agent's last cause on the app (taken as one that can raise it) — or a ⌃ hold with no chord that began after that
    /// cause and still lasts.
    func explains(from: TimeInterval, after cause: TimeInterval, now: TimeInterval, app: Bool = true, desktop: Bool = true,
                  front: pid_t? = nil) -> Bool {
        explanation(from: from, after: cause, raiseAfter: cause, now: now, app: app, desktop: desktop, front: front) != nil
    }

    /// What explains a change heard at `now` that moved the front app (`app`) and/or the desktop: the oldest instant of a
    /// kind that fits, within its life, after the agent's last RAISING cause on the app — and after its last cause of any
    /// kind, unless heard within `switchLandWindow` of the instant (#8: an act's cause landing between the user's
    /// release and the switcher's activation never outranks their input) — then a second explanation (above); or, for a
    /// ⌃ hold going on (which explains every desktop it passes), −∞, nothing to use up. An instant for a known app
    /// explains only that app coming forward (`front`).
    func explanation(from: TimeInterval, after cause: TimeInterval, raiseAfter: TimeInterval, now: TimeInterval,
                     app: Bool = true, desktop: Bool = true, front: pid_t? = nil, seconds useSeconds: Bool = true,
                     targetedFirst: Bool = true) -> TimeInterval? {
        let ok = { (at: TimeInterval, kind: Kind, target: pid_t?) -> Bool in
            at >= from && at <= now && Self.fits(kind, app: app, desktop: desktop) && (target == nil || target == front)
                && at > raiseAfter && (at > cause || now - at <= CUFocusGuardianCore.switchLandWindow)
        }
        // An instant for this very app (a click on its window) before any other: the oldest untargeted one may be the
        // switch another app's change is about to need (the model-based test: a Dock click's instant explained a click
        // into a bound window, and the Dock's own activation found none).
        // A ⌘-Tab whose ⌘ is still down has not switched yet (the switcher switches at the release): it explains nothing
        // until then (found by the model-based test: their Tab, ⌘ still held, explained a swipe's landing — and their ⌘-Tab
        // itself then found nothing).
        let pending = self.pendingTabs(now: now)
        let alive = { (i: (at: TimeInterval, kind: Kind, target: pid_t?, life: TimeInterval)) in
            ok(i.at, i.kind, i.target) && now - i.at <= i.life && !pending.contains(i.at)
        }
        // (An app the agent never touched is the user's whichever input it pairs with: the LATEST that fits is the one that
        // made it — found by the model-based test: a drag out of its window, 0.3 s before their ⌘-Tab to it, took the
        // landing, and the ⌘-Tab's release then explained the next desktop switch, whose own arrow explained an indirect
        // effect.)
        if targetedFirst, let f = front, let i = instants.first(where: { $0.target == f && alive($0) }) { return i.at }
        // The kind the change is about first: an app switch for a change of the front app (a ⌘-Tab, the Dock — the desktop
        // came along), a desktop switch for a change of the desktop alone (found by the model-based test: an unused swipe
        // explained the ⌘-Tab's own landing, and the ⌘-Tab's release then explained an indirect effect a moment later).
        // The latest input before the change first: a change lands 10–350 ms after the input that made it, and an older one
        // left unused (a click on a status item, a ⌘ tap) must not take a fresh switch's own landing — leaving the fresh one
        // to explain a theft a moment later (found by the model-based test).
        let primary: Kind = app ? .app : .desktop
        if let i = instants.last(where: { $0.kind == primary && alive($0) }) { return i.at }
        if let i = instants.last(where: alive) { return i.at }
        if useSeconds, let s = seconds.first(where: { ok($0.at, $0.kind, $0.target) && now <= $0.until }) { return s.at }
        // A ⌃ hold going on: begun after the agent's last raising cause (an act's cause during it never outranks it, #8 —
        // found by the model-based test: a busy script's next act, after the user's ⌃ went down, undid their ⌃-arrow).
        if desktop, let h = hold, h.control, !h.chord, h.since > raiseAfter, h.since > cause || raiseAfter != cause,
           h.since <= now, now - h.since < Self.holdMax {
            return -.infinity
        }
        if desktop, let h = lastControlHold, h.since > raiseAfter, h.since > cause || raiseAfter != cause, h.since >= from,
           now - h.end <= CUFocusGuardianCore.switchLandWindow {
            return -.infinity
        }
        return nil
    }

    /// The latest instant for `app` (a click on its window) up to `upTo`, used or not explained otherwise.
    func targeted(_ app: pid_t, upTo: TimeInterval) -> TimeInterval? {
        instants.last { $0.target == app && $0.at <= upTo && upTo - $0.at <= $0.life }?.at
    }

    /// The Tabs of a ⌘-Tab still held (not switched yet).
    func pendingTabs(now: TimeInterval) -> [TimeInterval] {
        guard let h = hold, now - h.since < Self.holdMax else { return [] }
        return h.tabs
    }

    /// The instant a change was explained by is used up — kept as a second, short-lived explanation when an untouched
    /// app's change heard right after it used it (`keepSecond`).
    mutating func use(_ instant: TimeInterval, heardAt: TimeInterval? = nil, keepSecond: Bool = false) {
        if instant == -.infinity { hold?.used = true; return }  // a ⌃ hold going on explained it
        if let i = instants.firstIndex(where: { $0.at == instant }) {
            let used = instants.remove(at: i)
            if keepSecond, let h = heardAt, h - used.at <= Self.secondHeard {
                seconds.append((used.at, used.kind, used.target, used.at + Self.secondLife))
            }
        } else if let s = seconds.firstIndex(where: { $0.at == instant }) {
            seconds.remove(at: s)
        }
    }

    /// A change decided otherwise (their place again, a desktop change following their move, an untouched app) uses up
    /// the oldest instant since `from` of a kind that fits it (#4) — the same way.
    mutating func useOldest(from: TimeInterval, upTo: TimeInterval, app: Bool = true, desktop: Bool = true, front: pid_t? = nil,
                            heardAt: TimeInterval) {
        let pending = pendingTabs(now: heardAt)
        let fitting = { (i: (at: TimeInterval, kind: Kind, target: pid_t?, life: TimeInterval)) in
            i.at >= from && i.at <= upTo && heardAt - i.at <= i.life && Self.fits(i.kind, app: app, desktop: desktop)
                && (i.target == nil || i.target == front) && !pending.contains(i.at)
        }
        let primary: Kind = app ? .app : .desktop
        if let i = instants.last(where: { $0.kind == primary && fitting($0) }) ?? instants.last(where: fitting) {
            use(i.at, heardAt: heardAt, keepSecond: true)
        }
    }

    /// For the model-based test's trace (diagnostics only): the seconds, the hold, the last ⌃ hold.
    var debugState: String {
        let sec = seconds.map { String(format: "%.3f→%.3f", $0.at, $0.until) }.joined(separator: " ")
        let h = hold.map { String(format: "hold %.3f%@%@", $0.since, $0.control ? "⌃" : "⌘", $0.chord ? " chord" : "") } ?? ""
        let l = lastControlHold.map { String(format: "⌃ released %.3f", $0.end) } ?? ""
        return [sec.isEmpty ? "" : "seconds \(sec)", h, l].filter { !$0.isEmpty }.joined(separator: "; ")
    }

    /// Every instant up to `now` used (tests).
    mutating func consume(through now: TimeInterval) {
        instants.removeAll { $0.at <= now }
        seconds.removeAll { $0.at <= now }
    }

    /// For tests and the log: whether input that could switch came between `from` and `seenAt`, used or not.
    func seen(from: TimeInterval, seenAt: TimeInterval, window: TimeInterval) -> Bool {
        if lastAt >= 0, lastAt >= max(from, seenAt - window), lastAt <= seenAt { return true }
        if let h = hold, h.control, !h.chord, h.since >= from, seenAt - h.since < Self.holdMax { return true }
        return false
    }
}
