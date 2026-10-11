import AppKit
import CoreGraphics
import Foundation

/// The Focus Guardian: while the agent is acting (a script runs, plus a short tail), NO app it touched may take
/// the user's front app, key focus or desktop because of the agent — at any delay (user rule 2026-10-09); and an
/// app it did not touch coming forward is always the user's own choice. It is event-driven, not per-action: it watches every activation the moment it happens and, when
/// one was not the user's own doing, puts the user back at once.
///
/// This is the PURE decision core — attribution (user vs agent), the restore plan, repeat-offender detection
/// and the one exemption — so it is tested on fakes. The live wiring (`CUCore` observers, HID recency, the
/// SLSDisableUpdate restore) feeds it facts and carries out its plans.

/// What the user is looking at, as the guardian tracks it.
public struct CUGuardedView: Equatable, Sendable {
    public var app: pid_t?
    public var space: UInt64?
    public init(app: pid_t? = nil, space: UInt64? = nil) {
        self.app = app
        self.space = space
    }
}

/// One activation the guardian was told about.
public struct CUActivation: Equatable, Sendable {
    public var app: pid_t
    public var space: UInt64?
    /// Input of the user's that can SWITCH apps or desktops just before it (`CUSwitchInput`: a ⌘/⌃ hold with no chord
    /// seen, ⌘-Tab, a gesture, a click on the Dock or a target's window). Typing in their own app is not — round 6 took
    /// any key as "the user's", so a target that activated itself while they typed was adopted as their place. During a
    /// desktop visit: any action of theirs since it began (noted, never decided on then).
    public var switchInput: Bool
    /// This activation followed one of the helper's own synthetic events.
    public var fromSyntheticEvent: Bool
    /// The app is one the agent touched (a bound target's, a document opened in it, or acted on just now): only
    /// such an app can be a thief. Any other app coming forward is the user's choice.
    public var suspect: Bool
    /// Switch-capable input can be seen at all (the session tap runs).
    public var inputObservable: Bool
    /// A physical click of theirs within `userInputWindow` (the HID state) — read only when no input source runs.
    public var clickRecent: Bool
    public init(app: pid_t, space: UInt64? = nil, switchInput: Bool, fromSyntheticEvent: Bool = false,
                suspect: Bool = true, inputObservable: Bool = true, clickRecent: Bool = false) {
        self.app = app
        self.space = space
        self.switchInput = switchInput
        self.fromSyntheticEvent = fromSyntheticEvent
        self.suspect = suspect
        self.inputObservable = inputObservable
        self.clickRecent = clickRecent
    }
}

/// Whose move a change of the user's front app or desktop is — the ONE decision every path asks
/// (`CUFocusGuardianCore.whoseMove`).
public enum CUMoveOwner: Equatable, Sendable {
    /// The user's own: never undone, and the guardian's view of their place follows it.
    case user(String)
    /// The consented foreground: the agent's, allowed.
    case consented
    /// The agent's or the target's own doing: undone.
    case agent(String)
    /// A desktop visit's own switch: neither undone nor adopted while it lasts.
    case visit

    public var isUsers: Bool { if case .user = self { return true } else { return false } }
    public var words: String {
        switch self {
        case .user(let why): return "the user's: \(why)"
        case .consented: return "the consented foreground"
        case .agent(let why): return "the agent's: \(why)"
        case .visit: return "a desktop visit"
        }
    }
}

/// The facts one change is judged on.
public struct CUMoveFacts: Equatable, Sendable {
    /// The front app after the change, and the active Space.
    public var app: pid_t?
    public var space: UInt64?
    /// Switch-capable input of the user's since the change could have begun (see `CUActivation.switchInput`).
    public var switchInput: Bool
    /// Something the agent did could have caused it: an act on that app, a blip, an open or a launch within
    /// `guardianCausalWindow`, or one of its synthetic events within `guardianSyntheticWindow`.
    public var agentCaused: Bool
    public var inputObservable: Bool
    public var clickRecent: Bool
    /// Judge it even during a desktop visit (the visit's own late-switch watch).
    public var ignoreVisit: Bool
    public init(app: pid_t?, space: UInt64?, switchInput: Bool, agentCaused: Bool, inputObservable: Bool = true,
                clickRecent: Bool = false, ignoreVisit: Bool = false) {
        self.app = app
        self.space = space
        self.switchInput = switchInput
        self.agentCaused = agentCaused
        self.inputObservable = inputObservable
        self.clickRecent = clickRecent
        self.ignoreVisit = ignoreVisit
    }
}

/// What the guardian decides to do about one activation.
public enum CUGuardianVerdict: Equatable, Sendable {
    /// The user's own switch (or an exempt action): respected, and it becomes the new "user's app"/"space".
    case userSwitch
    /// Theft: put the user back to `restore`, and tell them. `repeatOffender` when the same app did this
    /// three or more times in ten seconds.
    case theft(restore: CUGuardedView, thief: pid_t, repeatOffender: Bool)
    /// Nothing to do (the activation is already the user's current app, or the guardian is idle).
    case ignore
}

public struct CUFocusGuardianCore: Sendable {
    /// How long after physical input an activation still counts as the user's own.
    public static let userInputWindow: TimeInterval = 0.4
    /// A repeat offender: this many thefts within the window.
    public static let repeatCount = 3
    public static let repeatWindow: TimeInterval = 10

    public private(set) var view = CUGuardedView()
    public private(set) var active = false
    /// The one exemption: the consented foreground rung, for one app, until a deadline.
    private var exemptApp: pid_t?
    private var exemptUntil: TimeInterval = 0
    /// Theft times per app, for repeat detection.
    private var thefts: [pid_t: [TimeInterval]] = [:]
    /// The user physically clicked into this app's window: its activation (and a Space change that comes with
    /// it) is the user's until `claimUntil`, whatever the 0.4 s input heuristic says.
    private var claimApp: pid_t?
    private var claimUntil: TimeInterval = 0
    /// How long a physical click claims the activation it causes (an app can take a while to activate).
    public static let clickClaimWindow: TimeInterval = 1.5
    /// A DESKTOP VISIT in progress (the user agreed to be taken to `visitApp`'s desktop for one primitive, and
    /// brought back right after): until `visitUntil`, the switch there and the way back are the agent's own —
    /// neither undone nor adopted as the user's view, which stays what it was before the visit, so a failed
    /// return can still be restored. User input during it is only noted (`visitSawUserInput`): whether the user
    /// went somewhere of their own is decided when the visit ends, by where they are then.
    private var visitApp: pid_t?
    private var visitUntil: TimeInterval = 0
    public private(set) var visitSawUserInput = false
    /// The longest a visit mode lasts if its end is never told (a visit takes ~0.5–3 s).
    public static let visitMaxSeconds: TimeInterval = 10

    public init() {}

    /// A visit is in progress at `now` (begun, not ended, within its safety deadline).
    public func visiting(now: TimeInterval) -> Bool { visitApp != nil && now <= visitUntil }

    /// The user agreed to be taken to `app`'s desktop for one primitive: until `endVisit` (or the deadline —
    /// `maxSeconds`, the primitive's own, else `visitMaxSeconds`), its activation and the Space changes are the
    /// visit's own.
    public mutating func beginVisit(app: pid_t, now: TimeInterval, maxSeconds: TimeInterval = visitMaxSeconds) {
        visitApp = app
        visitUntil = now + maxSeconds
        visitSawUserInput = false
    }

    /// The open visit runs on: its visit mode lasts until `until` (the safety cap, re-armed as work starts and ends).
    public mutating func extendVisit(until: TimeInterval) {
        guard visitApp != nil else { return }
        visitUntil = until
    }

    /// The visit is over: returns whether user input was seen during it (the caller decides, by where the user
    /// is now, whether they moved somewhere themselves). The user's view is still the pre-visit one.
    @discardableResult
    public mutating func endVisit() -> Bool {
        let saw = visitSawUserInput
        visitApp = nil
        visitUntil = 0
        visitSawUserInput = false
        return saw
    }

    /// The user is somewhere of their own now (they moved during a visit): that is where later restores return them.
    public mutating func adoptUserView(_ v: CUGuardedView) {
        guard active else { return }
        view = v
    }

    /// Starts guarding, seeding the user's current view. Idempotent.
    public mutating func begin(view: CUGuardedView) {
        if !active { self.view = view }
        active = true
    }
    public mutating func end() {
        active = false
        thefts.removeAll()
        exemptApp = nil
        claimApp = nil
        visitApp = nil
        visitSawUserInput = false
    }

    /// The user physically clicked a window of `app` (a bound target's): the user's app and Space are now that
    /// app and the Space it is on — immediately, before any activation arrives — and the activation it causes
    /// is theirs. The guardian never fights a user who clicks into the agent's app.
    public mutating func userClicked(app: pid_t, space: UInt64?, now: TimeInterval) {
        guard active else { return }
        // During a desktop visit a click is noted, not adopted: where the user ends up decides at its end.
        if visiting(now: now) { visitSawUserInput = true; return }
        view = CUGuardedView(app: app, space: space ?? view.space)
        claimApp = app
        claimUntil = now + Self.clickClaimWindow
        thefts[app] = nil
    }

    private func claimed(_ app: pid_t, now: TimeInterval) -> Bool { claimApp == app && now <= claimUntil }

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

    /// The user changed Space themselves (a user-attributed activation or a user-input-backed space change):
    /// record it as the user's.
    public mutating func noteUserSpace(_ space: UInt64?) {
        if let space { view.space = space }
    }

    /// Why the last `handle` decided as it did, in a few words (the live log names it for an activation of an app the
    /// agent had just acted on that was NOT undone — the next live run can then say which attribution fired).
    public private(set) var lastReason = ""

    /// WHOSE MOVE a change of the user's front app or desktop is — the one decision every path asks: the guardian's
    /// activation and Space observers, the focus blip's make-key step and its every key and its end, a background
    /// click's preparation, the act's after-check and a desktop visit's late-switch watch (review of rounds 3–6: each
    /// had decided on its own, with different inputs, and every round two of them disagreed). In order:
    /// 1. A desktop visit in progress: its own (unless the visit's watch asks — `ignoreVisit`).
    /// 2. The user claimed the app: a physical click into its window, or a move a path already judged theirs
    ///    (`userMoved`) — theirs.
    /// 3. Input of theirs that can switch apps or desktops just before it (`switchInput`) — theirs, even right after
    ///    one of the helper's synthetic events (it is above that check on purpose).
    /// 4. The consented foreground for that app — allowed.
    /// 5. Nothing the agent did could have caused it — theirs.
    /// 6. No input source to tell (no session tap): a physical click of theirs just before it — theirs.
    /// 7. Otherwise the agent's (or the target's own) — undone. Typing in their own app is no switch: a target that
    ///    activates itself while they type is undone.
    public mutating func whoseMove(_ f: CUMoveFacts, now: TimeInterval) -> CUMoveOwner {
        let owner: CUMoveOwner
        if !f.ignoreVisit, visiting(now: now) {
            owner = .visit
        } else if let app = f.app, claimed(app, now: now) {
            owner = .user("they clicked into it, or moved there themselves")
        } else if f.switchInput {
            owner = .user("their input that switches apps or desktops (⌘-Tab, a gesture, the Dock, a click on its window)")
        } else if let app = f.app, let e = exemptApp, e == app, now < exemptUntil {
            owner = .consented
        } else if !f.agentCaused {
            owner = .user("nothing the agent did could have caused it")
        } else if !f.inputObservable, f.clickRecent {
            owner = .user("a click of theirs just before it (no input source tells more)")
        } else {
            owner = .agent(f.inputObservable ? "no input of the user's that switches apps or desktops" : "no input source: taken as the agent's")
        }
        lastReason = owner.words
        return owner
    }

    /// A path judged a change the user's (`whoseMove`): their place is now `app` on `space`, and the activation that
    /// change brings is claimed as theirs — so the guardian never restores over it when its notification comes later.
    public mutating func userMoved(app: pid_t?, space: UInt64?, now: TimeInterval) {
        guard active, let app else { return }
        view = CUGuardedView(app: app, space: space ?? view.space)
        claimApp = app
        claimUntil = now + Self.clickClaimWindow
        thefts[app] = nil
    }

    /// Decide what one activation means and update the tracked view.
    public mutating func handle(_ a: CUActivation, now: TimeInterval) -> CUGuardianVerdict {
        guard active else { lastReason = "not guarding"; return .ignore }
        let owner = whoseMove(CUMoveFacts(app: a.app, space: a.space, switchInput: a.switchInput,
                                          agentCaused: a.suspect || a.fromSyntheticEvent, inputObservable: a.inputObservable,
                                          clickRecent: a.clickRecent), now: now)
        switch owner {
        case .visit:
            // The target coming forward (and the user's app coming back after) is the visit's own; input only noted.
            if a.switchInput { visitSawUserInput = true }
            return .ignore
        case .user, .consented:
            view = CUGuardedView(app: a.app, space: a.space ?? view.space)
            if owner.isUsers { thefts[a.app] = nil }
            return .userSwitch
        case .agent:
            // Already the user's app and Space: nothing moved.
            if a.app == view.app, a.space == nil || a.space == view.space { lastReason = "already the user's app"; return .ignore }
            var times = (thefts[a.app] ?? []).filter { now - $0 < Self.repeatWindow }
            times.append(now)
            thefts[a.app] = times
            return .theft(restore: view, thief: a.app, repeatOffender: times.count >= Self.repeatCount)
        }
    }

    /// A Space change observed on its own (no activation): a theft to put back only when the agent CAUSED it
    /// (`caused`: within the causal window of something it did) and the user gave no input; otherwise the user's
    /// — and the user's place is now that Space, with its front app (`front`), so a later restore returns them
    /// there. Returns the restore view for a theft, nil when it was the user's.
    public mutating func handleSpaceChange(to space: UInt64?, front: pid_t? = nil, switchInput: Bool, caused: Bool = true,
                                           inputObservable: Bool = true, clickRecent: Bool = false,
                                           now: TimeInterval) -> CUGuardedView? {
        guard active, let space, space != view.space else { return nil }
        let owner = whoseMove(CUMoveFacts(app: front, space: space, switchInput: switchInput, agentCaused: caused,
                                          inputObservable: inputObservable, clickRecent: clickRecent), now: now)
        switch owner {
        case .visit:
            // A desktop visit's own Space changes (there and back) are neither undone nor adopted mid-visit.
            if switchInput { visitSawUserInput = true }
            return nil
        case .user, .consented:
            view = CUGuardedView(app: front ?? view.app, space: space)
            return nil
        case .agent:
            return view
        }
    }
}
