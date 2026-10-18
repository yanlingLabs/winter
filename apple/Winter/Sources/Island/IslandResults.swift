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

// MARK: - Who owns the top

/// What the island's activity panel draws under the housing.
enum IslandActivitySlot: Equatable {
    case none
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
