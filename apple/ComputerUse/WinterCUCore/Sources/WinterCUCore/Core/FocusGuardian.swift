import AppKit
import CoreGraphics
import Foundation

/// The Focus Guardian's decision core: WHOSE MOVE a change of the user's front app or desktop is — the one rule every
/// path asks (PROTOCOL.md §4.12) — and everything that rule reads, kept in one place so the paths cannot disagree:
/// where the user is (their PLACE), what the agent did to which app and when (its CAUSES, per pid), the user's input
/// that can switch apps or desktops, their physical clicks into the agent's windows, a desktop visit in progress, the
/// consented foreground. The live wiring (`CUCore+Guardian`) only feeds it facts and carries out what it decides.
///
/// The contract (the invariants the model-based test checks after every step):
/// - I1. Only a change that brought forward an app the agent TOUCHED — bound, acted on, launched, opened, sent a
///   synthetic event, raised or restored, per pid, within its causal window (or while an operation on it runs) — can
///   ever be undone. An app the agent never touched coming forward is always the user's.
/// - I2. Once a change is the user's, nothing undoes it, and every restore goes to the CURRENT place (`view`), never
///   to one captured before it.
/// - I3. A key the user types goes to their place at that moment (the reroute asks `keyPlace`) — never into a target
///   that took the front without being judged their move, never into an app they left.
/// - I4. A touched app that comes forward with no switch-capable input of the user's since the agent's last cause on
///   it is undone (and a typing burst into it stops).
/// - I5. Every path that can see a change asks `judge`, with the time its own operation began; a state already judged
///   gets the same verdict until new input of the user's arrives, so two paths never disagree about one change.

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

    /// The user's — their place, or their move.
    public var isUsers: Bool {
        switch self {
        case .theirPlace, .user: return true
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
        }
    }
}

/// One look at the user's front app and desktop that a path asks the rule about.
public struct CUMoveQuery: Equatable, Sendable {
    /// The front app and the active Space now.
    public var app: pid_t?
    public var space: UInt64?
    /// When the change could have begun (the caller's own operation's start): switch input counts from then. Nil — an
    /// observer that only knows the change happened — `switchWindow` back.
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

    public init(app: pid_t?, space: UInt64?, since: TimeInterval? = nil, from: CUGuardedView? = nil,
                appStartedAt: TimeInterval? = nil, appBundle: String? = nil, inputObservable: Bool = true, clickAt: TimeInterval? = nil,
                shown: [pid_t] = []) {
        self.app = app
        self.space = space
        self.since = since
        self.from = from
        self.appStartedAt = appStartedAt
        self.appBundle = appBundle
        self.inputObservable = inputObservable
        self.clickAt = clickAt
        self.shown = shown
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

    /// The user's PLACE: where they are, by their own moves. Every restore goes here, read when it runs.
    public private(set) var view = CUGuardedView()
    /// When the user last moved to `view` themselves.
    public private(set) var viewAt: TimeInterval = -.infinity
    public private(set) var active = false
    /// The one exemption: the consented foreground rung, for one app, until a deadline.
    private var exemptApp: pid_t?
    private var exemptUntil: TimeInterval = 0
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
    public private(set) var visitSawUserInput = false
    /// The agent's causes: the last time it did something to each app that could bring it forward, operations still
    /// running on an app (an AppleScript, a bind's window wait, a visit), and launches pending.
    private var causes: [pid_t: TimeInterval] = [:]
    /// The same for causes that can bring a window or a desktop forward (an activation, a raise, a main-window write, a
    /// visit, a restore): the only kind that can make a desktop change through an app that stays in the background.
    private var raises: [pid_t: TimeInterval] = [:]
    private var spans: [pid_t: Int] = [:]
    private var launches: [Int: (since: TimeInterval, bundle: String?)] = [:]
    private var launchSeq = 0
    /// The user's input that can switch apps or desktops (fed by the session tap, the gesture monitor and the clicks).
    var input = CUSwitchInput()
    /// Bumped whenever new input of the user's arrives: a state judged before it is judged again.
    private var evidence = 0
    /// The last state judged, its verdict, and the facts it was judged on (the user's input so far, the agent's last
    /// cause on that app): new facts of either kind and it is judged again.
    private var judged: (app: pid_t?, space: UInt64?, owner: CUMoveOwner, evidence: Int, cause: TimeInterval)?
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
        claim = nil
        judged = nil
        if visitApp != nil { endVisit() }
    }

    // MARK: the agent's causes

    /// The agent did something to `pid` that can bring it forward: a change of it within `causalWindow` may be its doing.
    /// `raise`: it can bring a window or a desktop forward (an activation, a raise, a main-window write).
    public mutating func noteCause(_ pid: pid_t, raise: Bool = false, now: TimeInterval) {
        causes[pid] = max(causes[pid] ?? -.infinity, now)
        if raise { raises[pid] = max(raises[pid] ?? -.infinity, now) }
    }

    /// An operation on `pid` runs (an AppleScript, a bind's window wait, a visit): it counts as touched throughout.
    public mutating func beginSpan(_ pid: pid_t, now: TimeInterval) {
        spans[pid, default: 0] += 1
        noteCause(pid, raise: true, now: now)
    }

    /// The operation ended: touched for `causalWindow` more.
    public mutating func endSpan(_ pid: pid_t, now: TimeInterval) {
        guard let n = spans[pid] else { return }
        spans[pid] = n > 1 ? n - 1 : nil
        noteCause(pid, raise: true, now: now)
    }

    /// The agent may launch an app: once its bundle is known (`setLaunchBundle`), an app of that bundle whose process
    /// started after `now` is touched until `endLaunch`, and the launched pid for `causalWindow` after.
    public mutating func beginLaunch(bundle: String? = nil, now: TimeInterval) -> Int {
        launchSeq += 1
        launches[launchSeq] = (now, bundle)
        return launchSeq
    }

    public mutating func setLaunchBundle(_ token: Int, _ bundle: String?) {
        launches[token]?.bundle = bundle
    }

    /// The most recent pending launch is for `bundle`.
    public mutating func setLatestLaunchBundle(_ bundle: String?) {
        guard let k = launches.keys.max() else { return }
        launches[k]?.bundle = bundle
    }

    public mutating func endLaunch(_ token: Int, pid: pid_t?, now: TimeInterval) {
        launches[token] = nil
        if let pid { noteCause(pid, raise: true, now: now) }
    }

    public var launchPending: Bool { launches.values.contains { $0.bundle != nil } }

    /// Whether the agent touched `app` recently enough that its coming forward can be the agent's doing.
    public func isTouched(_ app: pid_t?, startedAt: TimeInterval? = nil, bundle: String? = nil, now: TimeInterval) -> Bool {
        guard let app else { return false }
        if (spans[app] ?? 0) > 0 { return true }
        // A visit's apps — the way there and the way back are the agent's — while it lasts.
        if visiting(now: now), app == visitApp || app == visitUser { return true }
        if let c = causes[app], now - c <= Self.causalWindow { return true }
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

    /// Whether the agent did something to `app` recently that can bring a window or a desktop forward.
    public func isRaiseTouched(_ app: pid_t, now: TimeInterval) -> Bool {
        if (spans[app] ?? 0) > 0 { return true }
        if visiting(now: now), app == visitApp || app == visitUser { return true }
        if let r = raises[app], now - r <= Self.causalWindow { return true }
        return false
    }

    /// The apps that can make a desktop change while staying in the background, now (for `CUMoveQuery.shown`).
    public func raiseTouchedApps(now: TimeInterval) -> [pid_t] {
        var apps = Set(spans.keys)
        for (a, r) in raises where now - r <= Self.causalWindow { apps.insert(a) }
        if visiting(now: now) { if let a = visitApp { apps.insert(a) }; if let u = visitUser { apps.insert(u) } }
        return Array(apps).sorted()
    }

    // MARK: the user's input

    /// One input event the session tap saw (already known to be the user's — hardware, not the helper's own).
    /// `secure`: Secure Event Input is on (the tap sees no keys, so a ⌘/⌃ hold can't be told from a shortcut).
    public mutating func inputEvent(type: CGEventType, flags: CGEventFlags, keycode: Int64 = -1, secure: Bool = false,
                                    now: TimeInterval) {
        if input.event(type: type, flags: flags, keycode: keycode, secure: secure, now: now) { evidence += 1 }
    }

    /// Input that can switch by itself: a click on the Dock or on a window of an app that is not in front (or on
    /// another display), a trackpad swipe the gesture monitor saw.
    public mutating func noteSwitch(now: TimeInterval) {
        input.note(now)
        evidence += 1
    }

    /// The user physically clicked a window of `app` (a bound target's): theirs — the activation it causes is claimed,
    /// and their place is that app and the Space it is on, at once.
    public mutating func userClicked(app: pid_t, space: UInt64?, now: TimeInterval) {
        input.note(now)
        evidence += 1
        claim = (app, now + Self.clickClaimWindow)
        guard active else { return }
        // During a desktop visit where they go is decided by the rule when the front changes, or at the visit's end.
        if visiting(now: now) { return }
        view = CUGuardedView(app: app, space: space ?? view.space)
        viewAt = now
        thefts[app] = nil
        judged = nil
    }

    // MARK: the one rule

    /// WHOSE MOVE the user's front app and desktop being `q.app` / `q.space` now is. In order:
    /// 0. It is their place (`view`; the caller's `from` when not guarding): nothing moved — `.theirPlace`.
    /// 0'. The same state judged before, with no new input of theirs and no new cause of the agent's on that app since: the
    ///     same verdict (so every path agrees about one change, and no input is used twice).
    /// 1. I1 — the agent did not touch that app: the user's.
    /// 2. They clicked into its window (a claim): the user's.
    /// 3. A desktop change following their own move into that app (no agent cause on it since): the user's.
    /// 4. Switch-capable input of theirs AFTER the agent's last cause on that app (and after `since`): the user's — each
    ///    such input explains one change only (the first after it).
    /// 5. No input source (no session tap): a physical click of theirs, after the agent's cause, just before: the user's.
    /// 6. A desktop visit in progress: its own (their input in the visited app included: the visit's end decides).
    /// 7. The consented foreground for that app: allowed.
    /// 8. Otherwise the agent's — undone.
    /// A user's verdict moves their place there (I2), uses up their claim, and during a visit means they moved.
    public mutating func judge(_ q: CUMoveQuery, now: TimeInterval) -> CUMoveOwner {
        let place = active ? view : (q.from ?? view)
        lastFresh = false
        lastRepeatOffender = false
        if let app = q.app, app == place.app, q.space == nil || place.space == nil || q.space == place.space {
            judged = nil
            lastReason = CUMoveOwner.theirPlace.words
            return .theirPlace
        }
        if let j = judged, j.app == q.app, j.space == q.space, j.evidence == evidence, j.cause == lastCause(q.app) {
            lastReason = j.owner.words + " (judged before)"
            return j.owner
        }
        let owner = decide(q, place: place, now: now)
        // Each switch input explains the first change after it, never a later one.
        input.consume(through: now)
        judged = (q.app, q.space, owner, evidence, lastCause(q.app))
        lastFresh = true
        lastReason = owner.words
        switch owner {
        case .user:
            if visiting(now: now) { visitSawUserInput = true }
            view = CUGuardedView(app: q.app ?? view.app, space: q.space ?? view.space)
            viewAt = now
            if let a = q.app { thefts[a] = nil }
            claim = nil
        case .consented:
            view = CUGuardedView(app: q.app ?? view.app, space: q.space ?? view.space)
        case .agent:
            if let a = q.app {
                var times = (thefts[a] ?? []).filter { now - $0 < Self.repeatWindow }
                times.append(now)
                thefts[a] = times
                lastRepeatOffender = times.count >= Self.repeatCount
            }
        case .visit, .theirPlace:
            break
        }
        return owner
    }

    private func decide(_ q: CUMoveQuery, place: CUGuardedView, now: TimeInterval) -> CUMoveOwner {
        let visit = visiting(now: now)
        if let why = usersEvidence(q, place: place, now: now) {
            // On the visited desktop, their input in the visited app is no move away: the visit's end decides.
            if visit, let a = q.app, a == visitApp { return .visit }
            return .user(why)
        }
        if visit { return .visit }
        if let a = q.app, a == exemptApp, now < exemptUntil { return .consented }
        return .agent(q.inputObservable
            ? "the agent touched it, and no input of the user's that switches apps or desktops came after"
            : "the agent touched it, and no input source tells more")
    }

    /// Why the change is the user's (rules 1–5), or nil.
    private func usersEvidence(_ q: CUMoveQuery, place: CUGuardedView, now: TimeInterval) -> String? {
        let app = q.app
        // What the change brought forward that the agent touched: the front app (any cause can make an app activate
        // itself), and the apps whose window a desktop change showed (only a cause that raises can do that).
        let front = isTouched(app, startedAt: q.appStartedAt, bundle: q.appBundle, now: now)
        let shown = q.shown.filter { $0 != app && isRaiseTouched($0, now: now) }
        if !front && shown.isEmpty {
            return "the agent did not touch it — an app it never touched coming forward is always the user's"
        }
        let cause = max(front ? lastCause(app) : -.infinity, shown.map { raises[$0] ?? -.infinity }.max() ?? -.infinity)
        if let a = app, let c = claim, c.app == a, now <= c.until {
            return "they clicked into its window"
        }
        if let a = app, a == place.app, viewAt >= now - Self.followOnWindow, cause <= viewAt {
            return "the desktop change that came with their own move into it"
        }
        let from = q.since ?? (now - Self.switchWindow)
        if input.explains(from: from, after: cause, now: now) {
            return "their input that switches apps or desktops (⌘-Tab, ⌃-arrows, a swipe, the Dock, a click on another app's window), after the agent's last action on it"
        }
        if !q.inputObservable, let c = q.clickAt, now - c <= Self.userInputWindow, c > cause {
            return "a click of theirs just before it (no input source tells more)"
        }
        return nil
    }

    // MARK: the consented foreground

    /// The consented foreground rung takes the front for one action: its activation is allowed until `until`.
    public mutating func exempt(_ app: pid_t, until: TimeInterval) {
        // A longer exemption of the same app (an app held in front for a script) is never cut short.
        if exemptApp == app, exemptUntil > until { return }
        exemptApp = app
        exemptUntil = until
    }

    /// Ends `app`'s exemption now (its hold ended).
    public mutating func endExempt(_ app: pid_t) {
        guard exemptApp == app else { return }
        exemptApp = nil
        exemptUntil = 0
    }

    // MARK: desktop visits

    /// A visit is in progress at `now` (begun, not ended, within its safety deadline).
    public func visiting(now: TimeInterval) -> Bool { visitApp != nil && now <= visitUntil }

    /// The user agreed to be taken to `app`'s desktop from `user`'s: until `endVisit` (or the deadline — `maxSeconds`,
    /// the primitive's own, else `visitMaxSeconds`), its own switches are neither undone nor adopted. Both apps count as
    /// touched while it lasts (the way there and the way back are the agent's), and for the causal window after.
    public mutating func beginVisit(app: pid_t, user: pid_t? = nil, now: TimeInterval, maxSeconds: TimeInterval = visitMaxSeconds) {
        if visitApp != nil { endVisit(now: now) }
        visitApp = app
        visitUser = user
        visitUntil = now + maxSeconds
        visitSawUserInput = false
        noteCause(app, raise: true, now: now)
        if let user { noteCause(user, raise: true, now: now) }
    }

    /// The open visit runs on: its visit mode lasts until `until` (the safety cap, re-armed as work starts and ends).
    public mutating func extendVisit(until: TimeInterval) {
        guard visitApp != nil else { return }
        visitUntil = until
    }

    /// The visit is over: returns whether the rule found the user moved during it. Their place is still the pre-visit
    /// one unless they moved.
    @discardableResult
    public mutating func endVisit(now: TimeInterval? = nil) -> Bool {
        let saw = visitSawUserInput
        // Its apps stay touched for the causal window after it (a late switch of its making is still the agent's).
        if let now {
            if let a = visitApp { noteCause(a, raise: true, now: now) }
            if let u = visitUser { noteCause(u, raise: true, now: now) }
        }
        visitApp = nil
        visitUser = nil
        visitUntil = 0
        visitSawUserInput = false
        return saw
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
/// the user's own app (review of round 6). Each is an INSTANT that explains one change only, the first after it:
/// - a ⌘ or ⌃ held and released with no chord seen in the hold — the switcher swallows ⌘-Tab, ⌃-arrows, so only the
///   modifier shows; a chord the tap sees (⌘S, ⌘-click, ⌃-scroll) went to an app and switches nothing;
/// - a switching chord the tap does see: ⌘-Tab, ⌘-`, ⌃-←/→/↑/↓;
/// - a trackpad rotate, magnify, swipe or smart magnify (types 18, 30, 31, 32) — never the generic gesture type 29,
///   which the window server sends with any touch on the trackpad (two-finger scrolls included — not measured here:
///   it needs hardware); the global gesture monitor still notes swipes by their begin/end markers;
/// - a click on the Dock, on a window of an app that is not in front, or into a bound target's window (`note`).
/// And a ⌃ hold with no chord seen WHILE it lasts (the desktop switcher acts during it). Under Secure Event Input the
/// tap sees no keys, so a hold can't be told from a shortcut: no hold counts then. Pure.
struct CUSwitchInput {
    /// Instants not yet used, oldest first.
    private(set) var instants: [TimeInterval] = []
    /// The last instant seen (for the log), used or not.
    private(set) var lastAt: TimeInterval = -1
    /// A ⌘/⌃ hold in progress: since when, whether a chord was seen in it, whether ⌃ is in it, and whether it began
    /// under Secure Event Input.
    private var hold: (since: TimeInterval, chord: Bool, control: Bool, secure: Bool)?
    /// A hold whose release was never seen is not trusted past this.
    static let holdMax: TimeInterval = 10
    /// Instants older than this are dropped.
    static let keep: TimeInterval = 10
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
                    hold = (now, false, flags.contains(.maskControl), secure)
                    return flags.contains(.maskControl) && !secure
                }
                if flags.contains(.maskControl), hold?.control == false { hold?.control = true; return !(hold?.secure ?? true) }
                return false
            }
            guard let h = hold else { return false }
            hold = nil
            guard !h.chord, !h.secure, !secure else { return false }  // a chord an app got, or keys the tap could not see
            add(now)
            return true
        case CGEventType.keyDown.rawValue:
            if (flags.contains(.maskCommand) && Self.commandSwitchKeys.contains(keycode))
                || (flags.contains(.maskControl) && Self.controlSwitchKeys.contains(keycode)) {
                add(now)  // a switching chord the tap saw
                return true
            }
            if Self.modifier(flags), hold != nil { hold?.chord = true }  // a chord an app got: no switch
        case 1, 3, 25, 22, 6, 7, 27:  // mouse down (left, right, other), scroll, drags — with ⌘/⌃ held, a chord
            if Self.modifier(flags), hold != nil { hold?.chord = true }
        case let t where Self.switchGestures.contains(t):
            add(now)
            return true
        default:
            break
        }
        return false
    }

    mutating func note(_ now: TimeInterval) { add(now) }

    private mutating func add(_ now: TimeInterval) {
        lastAt = now
        instants.removeAll { now - $0 > Self.keep }
        instants.append(now)
    }

    /// Whether switch input explains a change seen at `now`: an instant not yet used, at or after `from`, after the
    /// agent's last cause on the app — or a ⌃ hold with no chord that began after that cause and still lasts.
    func explains(from: TimeInterval, after cause: TimeInterval, now: TimeInterval) -> Bool {
        if instants.contains(where: { $0 >= from && $0 > cause && $0 <= now }) { return true }
        if let h = hold, h.control, !h.chord, !h.secure, h.since > cause, now - h.since < Self.holdMax { return true }
        return false
    }

    /// The change seen at `now` used every instant up to it.
    mutating func consume(through now: TimeInterval) { instants.removeAll { $0 <= now } }

    /// For tests and the log: whether input that could switch came between `from` and `seenAt`, used or not.
    func seen(from: TimeInterval, seenAt: TimeInterval, window: TimeInterval) -> Bool {
        if lastAt >= 0, lastAt >= max(from, seenAt - window), lastAt <= seenAt { return true }
        if let h = hold, h.control, !h.chord, h.since >= from, seenAt - h.since < Self.holdMax { return true }
        return false
    }
}
