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
    /// The user typed or clicked (physical HID) within the attribution window just before this.
    public var hadRecentUserInput: Bool
    /// This activation was caused by the helper's own synthetic event (never counts as the user).
    public var fromSyntheticEvent: Bool
    /// The app is one the agent touched (a bound target's, a document opened in it, or acted on just now): only
    /// such an app can be a thief. Any other app coming forward is the user's choice.
    public var suspect: Bool
    public init(app: pid_t, space: UInt64? = nil, hadRecentUserInput: Bool, fromSyntheticEvent: Bool = false,
                suspect: Bool = true) {
        self.app = app
        self.space = space
        self.hadRecentUserInput = hadRecentUserInput
        self.fromSyntheticEvent = fromSyntheticEvent
        self.suspect = suspect
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

    public init() {}

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
    }

    /// The user physically clicked a window of `app` (a bound target's): the user's app and Space are now that
    /// app and the Space it is on — immediately, before any activation arrives — and the activation it causes
    /// is theirs. The guardian never fights a user who clicks into the agent's app.
    public mutating func userClicked(app: pid_t, space: UInt64?, now: TimeInterval) {
        guard active else { return }
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

    /// Decide what one activation means and update the tracked view.
    public mutating func handle(_ a: CUActivation, now: TimeInterval) -> CUGuardianVerdict {
        guard active else { return .ignore }
        // An app the agent never touched: the user's choice, always — it becomes the user's app and is never undone.
        if !a.suspect {
            view = CUGuardedView(app: a.app, space: a.space ?? view.space)
            thefts[a.app] = nil
            return .userSwitch
        }
        // The user clicked into this app's window: theirs, whatever the timing.
        if claimed(a.app, now: now) {
            view = CUGuardedView(app: a.app, space: a.space ?? view.space)
            return .userSwitch
        }
        // The user's own switch: physical input just before it, and not one of our synthetic events.
        if a.hadRecentUserInput, !a.fromSyntheticEvent {
            view = CUGuardedView(app: a.app, space: a.space ?? view.space)
            return .userSwitch
        }
        // The consented foreground rung for this app, within its deadline.
        if let e = exemptApp, e == a.app, now < exemptUntil {
            view = CUGuardedView(app: a.app, space: a.space ?? view.space)
            return .userSwitch
        }
        // Already the user's app and Space: nothing moved.
        if a.app == view.app, a.space == nil || a.space == view.space { return .ignore }
        // Theft, whatever the app.
        var times = (thefts[a.app] ?? []).filter { now - $0 < Self.repeatWindow }
        times.append(now)
        thefts[a.app] = times
        return .theft(restore: view, thief: a.app, repeatOffender: times.count >= Self.repeatCount)
    }

    /// A Space change observed on its own (no activation): a theft to put back only when the agent CAUSED it
    /// (`caused`: within the causal window of something it did) and the user gave no input; otherwise the user's
    /// — and the user's place is now that Space, with its front app (`front`), so a later restore returns them
    /// there. Returns the restore view for a theft, nil when it was the user's.
    public mutating func handleSpaceChange(to space: UInt64?, front: pid_t? = nil, hadRecentUserInput: Bool, caused: Bool = true,
                                           now: TimeInterval) -> CUGuardedView? {
        guard active, let space, space != view.space else { return nil }
        if !caused || hadRecentUserInput || (claimApp != nil && now <= claimUntil) {
            view = CUGuardedView(app: front ?? view.app, space: space)
            return nil
        }
        return view
    }
}
