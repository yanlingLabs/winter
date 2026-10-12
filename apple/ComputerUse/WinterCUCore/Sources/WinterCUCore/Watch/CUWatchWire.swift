import CoreGraphics
import Foundation

// WAKE TRIGGERS, the helper's half (PROTOCOL.md §4.13): the daemon arms a WATCH on a bound target — "wake the session
// when the user clicks [12]", "when “Sent” appears" — and the helper tells it once, with a `watchEvent`, when that
// happens (`fired`) or can no longer happen (`lost`). One-shot. These are the wire shapes; the decisions are
// `CUWatchJudge`'s and the engine is `CUWatcher`.

/// `watch.arm`'s `condition`: exactly one of the kinds below, with its own fields.
/// - `clicked {ref}` — the user clicks the element (or something inside it): hardware input only;
/// - `appeared {text}` — the text comes to be shown in the window;
/// - `gone {ref}` / `gone {text}` — the element, or the text, is no longer shown;
/// - `changed {ref, settleMs?}` — the user changes the field's value; fires once it has stopped changing;
/// - `titled {title}` — the window's title comes to contain the text.
public struct CUWatchConditionWire: Codable, Equatable, Sendable {
    public var kind: String
    public var ref: Int?
    public var text: String?
    public var title: String?
    public var settleMs: Int?

    public init(kind: String, ref: Int? = nil, text: String? = nil, title: String? = nil, settleMs: Int? = nil) {
        self.kind = kind
        self.ref = ref
        self.text = text
        self.title = title
        self.settleMs = settleMs
    }
}

/// `watch.arm {targetId, watchId, condition, expiresAt?}`.
public struct WatchArmParams: Codable, Equatable, Sendable {
    public var targetId: String
    /// The daemon's own id for the trigger (`wk_<12 hex>`): every `watchEvent` names it.
    public var watchId: String
    public var condition: CUWatchConditionWire
    /// Epoch ms. The DAEMON expires the trigger; the helper drops the watch silently a little after this, as a backstop.
    public var expiresAt: Double?

    public init(targetId: String, watchId: String, condition: CUWatchConditionWire, expiresAt: Double? = nil) {
        self.targetId = targetId
        self.watchId = watchId
        self.condition = condition
        self.expiresAt = expiresAt
    }
}

/// The watched element as the user sees it: its role words and accessible name (as `state()` prints them).
public struct CUWatchElement: Codable, Equatable, Sendable {
    public var role: String
    public var name: String
    public init(role: String, name: String) {
        self.role = role
        self.name = name
    }
}

/// `watch.arm`'s answer. Screen-derived: the daemon fences both for the model.
public struct WatchArmResult: Codable, Equatable, Sendable {
    public var element: CUWatchElement?
    /// "Mail — Inbox": the app's name and the bound window's title (as `state()`'s header prints it).
    public var targetLabel: String
    public init(element: CUWatchElement?, targetLabel: String) {
        self.element = element
        self.targetLabel = targetLabel
    }
}

/// `watch.cancel {watchId}` → `{}`. Idempotent: an unknown or ended watch is no error.
public struct WatchCancelParams: Codable, Equatable, Sendable {
    public var watchId: String
    public init(watchId: String) { self.watchId = watchId }
}

public struct WatchCancelResult: Codable, Equatable, Sendable {
    public init() {}
}

/// The one event that ends a watch — the `watchEvent` notification.
public struct CUWatchEvent: Sendable, Equatable {
    public enum Outcome: String, Sendable { case fired, lost }
    public let watchId: String
    public let outcome: Outcome
    /// Epoch ms of the user's action (or of the loss).
    public let at: Double
    /// fired: what happened in a few words ("clicked", "appeared", "gone", "changed", "title now “…”"). Never a value the
    /// user typed, never coordinates. Screen-derived (a title): the daemon fences it.
    public let detail: String?
    /// lost: why, in the helper's own words ("the app quit", "the window closed", "the element is gone").
    public let reason: String?

    public init(watchId: String, outcome: Outcome, at: Double, detail: String? = nil, reason: String? = nil) {
        self.watchId = watchId
        self.outcome = outcome
        self.at = at
        self.detail = detail
        self.reason = reason
    }
}

/// What the helper draws while a watch is armed (WinterCUPresentation's ring and pill), for ONE watch whose bound window
/// is frontmost on the active Space. Frames are in screen points, top-left origin.
public struct CUWatchShown: Sendable, Equatable {
    public let watchId: String
    /// The condition's kind (`clicked`, `changed`, …): the pill's fixed sentence is chosen by it.
    public let kind: String
    /// The element's own label (its accessible name, else its role words); nil for the window-wide kinds — the pill then
    /// names nothing the model wrote.
    public let label: String?
    /// The element's frame (the ring); nil for the window-wide kinds.
    public let elementFrame: CGRect?
    public let windowFrame: CGRect

    public init(watchId: String, kind: String, label: String?, elementFrame: CGRect?, windowFrame: CGRect) {
        self.watchId = watchId
        self.kind = kind
        self.label = label
        self.elementFrame = elementFrame
        self.windowFrame = windowFrame
    }
}

/// TEST-ONLY (a live-test instance): `test.userClick {pid, name}` clicks the named element of that app with a real,
/// pointer-moving click stamped `CUWatchTestStamp` — the one synthetic input a watch counts as the user's, and only on a
/// live-test instance (`CUWatcher.countsTestInput`).
public struct TestUserClickParams: Codable, Equatable, Sendable {
    public var pid: Int32
    /// The element's accessible title or description, exactly.
    public var name: String
    public init(pid: Int32, name: String) {
        self.pid = pid
        self.name = name
    }
}

public struct TestUserClickResult: Codable, Equatable, Sendable {
    /// The element was found and the click posted.
    public var clicked: Bool
    public init(clicked: Bool) { self.clicked = clicked }
}

/// The mark on the live-test click (`test.userClick`): distinct from `CUEventStamp`, which never counts as the user's.
public enum CUWatchTestStamp {
    /// "WAKETEST" as eight ASCII bytes.
    public static let value: Int64 = 0x5741_4B45_5445_5354
}
