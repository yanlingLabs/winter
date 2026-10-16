import Foundation
import WinterKit

// The Winter island's routing (`docs/claude/island.md`): where a pending card shows. Pure — the focus facts are handed
// in (`IslandFocus`), so `IslandRoutingTests` drives every rule with injected state.
//
//   1. From Dispatch, or a Dispatch-spawned child: through the Dispatch pill while it is visible (its own floating
//      cards, as before); on top, in the island, while it is not.
//   2. From any other session: HIDDEN on top while that session's host is in front — a Winter window showing it that
//      is key or main with Winter frontmost, or its EXACT terminal window/tab (matched through the client's tty);
//      on top otherwise. A host whose frontness cannot be told counts as not in front: the card shows.
//   3. View requests (the desktop switch): ALWAYS on top.
// Every pending card is in the island's "Needs you" list whatever its placement.

/// Where a card goes.
enum IslandPlacement: Equatable {
    /// On top: born from the housing as a pill or a rectangle.
    case top
    /// The Dispatch pill shows it (its own floating cards).
    case dispatchPill
    /// Not on top: its host is in front, where the user already sees it.
    case hidden
}

/// Whether a terminal (by tty) is the one in front, as `TerminalWindowMatcher` judged it.
enum TerminalFrontness: Equatable {
    case front
    case notFront
    /// No exact match was possible — the card then shows.
    case unknown
}

/// The focus facts the routing reads. Built live by `IslandFocusReader`; by hand in tests.
struct IslandFocus {
    /// The Dispatch pill is on screen.
    var dispatchPillVisible = false
    /// The Dispatch coordinator session(s) this app knows (`session.list`'s mode "dispatch").
    var dispatchSessionIds: Set<String> = []
    /// Winter is the frontmost app.
    var winterFrontmost = false
    /// The sessions shown by a Winter window (the app window or a detached one) that is key or main.
    var keyOrMainWindowSessionIds: Set<String> = []
    /// Is the terminal with this tty (`/dev/ttys004`) the frontmost window/tab?
    var terminalFrontness: (String) -> TerminalFrontness = { _ in .unknown }
}

enum IslandRouter {
    /// PURE: is this card from Dispatch or one of its children?
    static func isDispatchFamily(_ card: IslandCard, dispatchSessionIds: Set<String>) -> Bool {
        if card.facts.mode == "dispatch" { return true }
        if card.facts.origin == "dispatch-child" { return true }
        if let parent = card.facts.parentSessionId, dispatchSessionIds.contains(parent) { return true }
        if dispatchSessionIds.contains(card.answerSessionId) || dispatchSessionIds.contains(card.sessionId) { return true }
        return false
    }

    /// PURE: is one of the card's hosts in front right now?
    static func hostInFront(_ card: IslandCard, focus: IslandFocus) -> Bool {
        if focus.winterFrontmost, focus.keyOrMainWindowSessionIds.contains(card.answerSessionId) { return true }
        for host in card.hosts where host.role != "remote" {
            guard let tty = host.tty, !tty.isEmpty else { continue }
            if focus.terminalFrontness(tty) == .front { return true }
        }
        return false
    }

    /// PURE: the rule table.
    static func placement(of card: IslandCard, focus: IslandFocus) -> IslandPlacement {
        if card.kind == .viewRequest { return .top }
        if isDispatchFamily(card, dispatchSessionIds: focus.dispatchSessionIds) {
            return focus.dispatchPillVisible ? .dispatchPill : .top
        }
        return hostInFront(card, focus: focus) ? .hidden : .top
    }

    /// PURE: the ttys the routing would have to judge for these cards (only the non-Dispatch, non-view cards that are
    /// not already hidden by a Winter window) — what the live reader looks up, so a card set with none reads nothing.
    static func ttysToJudge(_ cards: [IslandCard], focus: IslandFocus) -> Set<String> {
        var out = Set<String>()
        for card in cards where card.kind != .viewRequest && !isDispatchFamily(card, dispatchSessionIds: focus.dispatchSessionIds) {
            for host in card.hosts where host.role != "remote" {
                if let tty = host.tty, !tty.isEmpty { out.insert(tty) }
            }
        }
        return out
    }
}
