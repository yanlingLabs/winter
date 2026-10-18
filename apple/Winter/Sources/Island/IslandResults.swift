import Foundation
import WinterKit

// The Winter island's turn-result cards (phase 2, `docs/claude/island.md`): a session's turn ended with the session idle
// while its host is NOT in front → a rounded rectangle born from the housing with the session's title, the last
// assistant text (two lines) and Open / ✕. Ephemeral: it never counts as "waiting for you", never counts on the strip or
// Needs you; unhovered it goes back up into the housing after `IslandQueue.selfCompactAfter` and is gone. Pure state with
// an injected clock (`IslandResultsTests`).
//
// Which results are born at all (`IslandResultQueue.shouldBear`) — drop, never defer:
//   - from Dispatch or a Dispatch-spawned child while the Dispatch pill is visible: dropped (the pill shows its own);
//   - while the session's host is in front (its Winter window key/main, its exact terminal): dropped — the user sees it;
//   - one first seen long after the turn ended (`maxAgeAtBirth`: the app just connected, a stale list): dropped.
// The daemon publishes only turns that ended IDLE (a 1.5 s settle, no automated-loop turns, no card still waiting).

struct IslandResultQueue: Equatable {
    /// How long an unhovered result shows.
    static let showFor: TimeInterval = IslandQueue.selfCompactAfter
    /// After the pointer leaves a result whose time is up, it stays this long more.
    static let hoverLeaveGrace: TimeInterval = IslandQueue.hoverLeaveGrace
    /// A result first seen more than this long after its turn ended is not born.
    static let maxAgeAtBirth: TimeInterval = 60
    /// A result held while a card needing an answer owns the top is born when the top frees — within this long, else dropped.
    static let holdAtMost: TimeInterval = 30

    struct Entry: Equatable {
        let id: String
        /// When it goes back up by itself (nil while held off the top).
        var dismissAt: TimeInterval?
        /// When it arrived (a held one is dropped `holdAtMost` after).
        let arrivedAt: TimeInterval
    }

    /// The result on top.
    private(set) var current: Entry?
    /// The newest result that arrived while the top was busy (a card needing an answer), born when it frees.
    private(set) var held: Entry?
    private(set) var hovered = false
    /// Every id ever arrived — a result is born at most once, whatever later lists say.
    private(set) var seen: Set<String> = []

    /// When the queue next changes by itself, nil when nothing is due.
    var nextDeadline: TimeInterval? {
        var out: TimeInterval?
        if let at = current?.dismissAt, !hovered { out = at }
        if let h = held { out = min(out ?? .infinity, h.arrivedAt + Self.holdAtMost) }
        return out
    }

    /// PURE: is a result born at all? (Dispatch's while its pill shows, one whose host is in front, a stale one: no.)
    static func shouldBear(placement: IslandPlacement, ageSeconds: TimeInterval) -> Bool {
        placement == .top && ageSeconds <= maxAgeAtBirth
    }

    /// A result arrives. `busy`: a card needing an answer owns the top — it is held until that clears. A newer result
    /// replaces an older one (which never comes back). Returns false for one seen before.
    @discardableResult
    mutating func arrive(_ id: String, busy: Bool, now: TimeInterval) -> Bool {
        guard seen.insert(id).inserted else { return false }
        if busy {
            held = Entry(id: id, dismissAt: nil, arrivedAt: now)
            return true
        }
        current = Entry(id: id, dismissAt: now + Self.showFor, arrivedAt: now)
        hovered = false
        return true
    }

    /// The top's owner changed: busy (a card needing an answer is on top) or free. Busy takes the current result off
    /// the top (it goes back up); free bears the held one.
    mutating func setBusy(_ busy: Bool, now: TimeInterval) {
        if busy {
            if let cur = current { held = Entry(id: cur.id, dismissAt: nil, arrivedAt: now) }
            current = nil
            hovered = false
        } else if current == nil, let h = held {
            held = nil
            if now - h.arrivedAt <= Self.holdAtMost {
                current = Entry(id: h.id, dismissAt: now + Self.showFor, arrivedAt: h.arrivedAt)
            }
        }
    }

    mutating func hover(_ on: Bool, now: TimeInterval) {
        guard current != nil, on != hovered else { return }
        hovered = on
        if !on, var cur = current, let at = cur.dismissAt, at < now + Self.hoverLeaveGrace {
            cur.dismissAt = now + Self.hoverLeaveGrace
            current = cur
        }
    }

    /// A result that is not born (Dispatch's while its pill shows, its host in front, a stale one) is never born later.
    mutating func markSeen(_ id: String) { seen.insert(id) }

    /// ✕, Open, or the session moved on (a new turn): gone.
    mutating func dismiss(_ id: String) {
        if current?.id == id { current = nil; hovered = false }
        if held?.id == id { held = nil }
    }

    mutating func tick(now: TimeInterval) {
        if let h = held, now - h.arrivedAt > Self.holdAtMost { held = nil }
        guard let cur = current, !hovered, let at = cur.dismissAt, now >= at else { return }
        current = nil
    }
}

// MARK: - Fired plan alarms' notices

/// The notices of fired plan alarms (`docs/claude/usage.md`) — NEVER lost (review 2026-10-18): the daemon keeps each one
/// (in usage.db, across restarts) until it is acknowledged, and this queue acknowledges one only when the user dismissed
/// it (✕), opened it (↗, a click), or it was on screen its WHOLE `showFor`. So, unlike a turn result:
///   - no age limit: one that fired while the app was away or asleep is shown when it comes back;
///   - they queue in the order they fired: a second never replaces the first, and a turn result never takes their place;
///   - while the top is not theirs (`blocked` — a card needing an answer, the open island, the agent's real mouse) they
///     wait, however long; one cut short goes back to the head of the line and is shown again whole.
/// Pure, with the clock passed in (`IslandResultsTests`).
struct IslandAlarmQueue: Equatable {
    /// How long an unhovered notice shows (longer than a result: news the user asked for).
    static let showFor: TimeInterval = 12
    /// After the pointer leaves a notice whose time is up, it stays this long more.
    static let hoverLeaveGrace: TimeInterval = IslandQueue.hoverLeaveGrace

    struct Shown: Equatable {
        let id: String
        var dismissAt: TimeInterval
    }

    /// Waiting to be shown, oldest fired first.
    private(set) var waiting: [String] = []
    /// The notice on screen.
    private(set) var current: Shown?
    private(set) var hovered = false
    /// The top is not the notices' now.
    private(set) var blocked = false
    /// Acknowledged here (never shown again, whatever a list still says before the daemon catches up).
    private(set) var done: Set<String> = []

    /// When the current notice has had its full time, nil when nothing is due.
    var nextDeadline: TimeInterval? {
        guard let current, !hovered else { return nil }
        return current.dismissAt
    }

    /// The daemon's list (fired order): new ones join the line, ones it no longer lists (acknowledged elsewhere) go.
    mutating func sync(_ ids: [String], now: TimeInterval) {
        let listed = Set(ids)
        waiting.removeAll { !listed.contains($0) }
        if let cur = current, !listed.contains(cur.id) { current = nil; hovered = false }
        for id in ids where !done.contains(id) && current?.id != id && !waiting.contains(id) { waiting.append(id) }
        advance(now: now)
    }

    /// The top became the notices' or stopped being. A notice cut short waits at the head of the line, shown whole later.
    mutating func setBlocked(_ on: Bool, now: TimeInterval) {
        guard on != blocked else { return }
        blocked = on
        if on, let cur = current {
            waiting.insert(cur.id, at: 0)
            current = nil
            hovered = false
        }
        advance(now: now)
    }

    mutating func hover(_ on: Bool, now: TimeInterval) {
        guard current != nil, on != hovered else { return }
        hovered = on
        if !on, var cur = current, cur.dismissAt < now + Self.hoverLeaveGrace {
            cur.dismissAt = now + Self.hoverLeaveGrace
            current = cur
        }
    }

    /// The clock moved: a notice shown its whole time is done — returns its id (to acknowledge), and the next one shows.
    mutating func tick(now: TimeInterval) -> String? {
        guard let cur = current, !hovered, now >= cur.dismissAt else { return nil }
        current = nil
        done.insert(cur.id)
        advance(now: now)
        return cur.id
    }

    /// ✕ or ↗ (or a click on it): done.
    mutating func finish(_ id: String, now: TimeInterval) {
        done.insert(id)
        waiting.removeAll { $0 == id }
        if current?.id == id { current = nil; hovered = false }
        advance(now: now)
    }

    private mutating func advance(now: TimeInterval) {
        guard current == nil, !blocked, !waiting.isEmpty else { return }
        current = Shown(id: waiting.removeFirst(), dismissAt: now + Self.showFor)
    }
}

/// Whether anyone can see the screen (review 2026-10-18): an alarm's notice counts its time only on an awake, unlocked
/// screen in the active console session — away, it waits (`IslandAlarmQueue.setBlocked`), so one that fires while the
/// user is gone is never acknowledged unseen. Fed by the system's own signals (`IslandActivityController`): the screen
/// lock's `com.apple.screenIsLocked`/`Unlocked` (DistributedNotificationCenter), `NSWorkspace`'s `screensDidSleep`/
/// `screensDidWake` and `sessionDidResignActive`/`sessionDidBecomeActive`. Pure (`IslandResultsTests`).
struct IslandScreenPresence: Equatable {
    enum Signal: Equatable {
        case locked, unlocked, displaysSlept, displaysWoke, sessionResigned, sessionActivated
    }

    private(set) var locked = false
    private(set) var displaysAsleep = false
    private(set) var sessionInactive = false

    /// Nobody can see the screen: locked, its displays asleep, or another user's session in front.
    var away: Bool { locked || displaysAsleep || sessionInactive }

    mutating func note(_ signal: Signal) {
        switch signal {
        case .locked: locked = true
        case .unlocked: locked = false
        case .displaysSlept: displaysAsleep = true
        case .displaysWoke: displaysAsleep = false
        case .sessionResigned: sessionInactive = true
        case .sessionActivated: sessionInactive = false
        }
    }
}

// MARK: - Who owns the top

/// What the island's activity panel draws under the housing.
enum IslandActivitySlot: Equatable {
    case none
    /// A turn result, or a fired plan alarm's notice (`IslandAlarmQueue`; the notice first).
    case result(String)
    /// The computer-use pill (`expanded`: as its mirror).
    case computerUse(sessionId: String, expanded: Bool)
}

/// The activity panel's decision.
struct IslandActivityDecision: Equatable {
    let slot: IslandActivitySlot

    static let none = IslandActivityDecision(slot: .none)
}

/// PURE precedence of everything born from the housing (`IslandActivityArbiterTests`):
///
///   0. the agent uses the REAL mouse (rung 4) → nothing here: no click of the user's or the agent's may land on the
///      island while the pointer is the agent's (the helper refuses a hardware click a Winter window covers);
///   1. the island open → nothing here (its tabs show it all; the Watches tab lists the computer's waits);
///   2. a card needing an answer (approval, question, link, view request) expanded on top, or waiting under it → nothing
///      here: the computer-use pill and its mirror YIELD (hidden, the mirror's capture stopped), a result is held;
///   3. a turn result;
///   4. the computer-use pill (or its mirror, when the user opened it).
/// Compacted cards draw nothing under the housing (only the strip's count), so 3 and 4 always hang from the housing.
enum IslandActivityArbiter {
    static func decide(cardOnTop: Bool, islandOpen: Bool, result: String?, computerUse: String?,
                       mirrorOpen: Bool, realMouse: Bool = false) -> IslandActivityDecision {
        if realMouse || islandOpen || cardOnTop { return .none }
        if let result { return IslandActivityDecision(slot: .result(result)) }
        if let computerUse { return IslandActivityDecision(slot: .computerUse(sessionId: computerUse, expanded: mirrorOpen)) }
        return .none
    }
}

// MARK: - Routing activity like a card

extension IslandRouter {
    /// PURE: where a session's activity (its computer-use pill, its result) goes — the same rule table as its cards
    /// (`placement(of:focus:)`): Dispatch's family through the pill while it shows, any other session hidden while its
    /// host is in front.
    static func placement(sessionId: String, facts: IslandSessionFacts, hosts: [IslandHost], focus: IslandFocus) -> IslandPlacement {
        placement(of: probe(sessionId: sessionId, facts: facts, hosts: hosts), focus: focus)
    }

    /// The ttys that judging these sessions needs.
    static func ttysToJudge(sessions: [(sessionId: String, facts: IslandSessionFacts, hosts: [IslandHost])], focus: IslandFocus) -> Set<String> {
        ttysToJudge(sessions.map { probe(sessionId: $0.sessionId, facts: $0.facts, hosts: $0.hosts) }, focus: focus)
    }

    /// A stand-in card carrying only what routing reads (the session, its facts and hosts).
    private static func probe(sessionId: String, facts: IslandSessionFacts, hosts: [IslandHost]) -> IslandCard {
        IslandCard(callId: "activity", sessionId: sessionId, answerSessionId: sessionId, kind: .approval,
                   payload: .approval(toolName: "", summary: "", reviewerReason: nil, options: []), facts: facts, hosts: hosts)
    }
}

/// PURE: a result card's title — the session's title, else what kind of session it is.
func islandResultTitle(_ item: IslandResultItem) -> String {
    if let title = item.session.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
    switch item.session.mode {
    case "dispatch": return "Dispatch"
    case "chat": return "Chat"
    default: return item.session.origin == "dispatch-child" ? "Dispatch task" : "Session"
    }
}
