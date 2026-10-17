import Foundation

// The Winter island's queue (`docs/claude/island.md`): what is on top, born from the housing. Pure state with an
// injected clock — `IslandQueueTests` drives it; the store schedules ONE wake-up at `nextDeadline` (none while nothing
// is due, so an idle island runs no timer).
//
//   - Cards do not stack: a new card REPLACES the current one, which compacts (the strip's waiting count + Needs you).
//   - …unless the current one is HOVERED (or is a view request, whose countdown must stay visible): the newcomer
//     waits as a small compact pill just below it, and expands when the current one clears or self-compacts, or when
//     the user CLICKS it — which tucks the current one away (compacted).
//   - Approvals and questions SELF-COMPACT after `selfCompactAfter` when not hovered: into the strip's left wing (the
//     amber symbol and its count — nothing else is drawn for them) AND the Needs-you list, where a click on that wing
//     opens the island. They stay pending until answered anywhere (`resolve`).
//   - View requests keep their own countdown: they never self-compact.

struct IslandQueue: Equatable {
    /// How long an approval or question stays expanded before it compacts by itself (unhovered).
    static let selfCompactAfter: TimeInterval = 6
    /// After the pointer leaves an expanded card whose time is up, it stays this long more before compacting.
    static let hoverLeaveGrace: TimeInterval = 1.5

    struct Entry: Equatable {
        let id: String
        let selfCompacts: Bool
        /// When it compacts by itself (nil: never — a view request).
        var compactAt: TimeInterval?
    }

    /// Expanded on top.
    private(set) var current: Entry?
    /// The compact pill waiting just below the current card.
    private(set) var waiting: Entry?
    /// Compacted cards, oldest first (counted on the strip's left wing, listed in Needs you).
    private(set) var compacted: [Entry] = []
    /// The pointer is over the current card.
    private(set) var currentHovered = false
    /// The user is typing into the current card (its panel holds the keyboard): it is held exactly like a hovered one —
    /// never replaced, never compacted — so no keystroke can land anywhere else.
    private(set) var currentTyping = false
    /// Hovered or typed into: the current card stays.
    var currentHeld: Bool { currentHovered || currentTyping }

    var isEmpty: Bool { current == nil && waiting == nil && compacted.isEmpty }

    /// Every card the queue holds.
    var ids: Set<String> {
        var out = Set(compacted.map(\.id))
        if let current { out.insert(current.id) }
        if let waiting { out.insert(waiting.id) }
        return out
    }

    /// When the queue next has something to do by itself (a self-compaction), nil when nothing is due.
    var nextDeadline: TimeInterval? {
        guard let current, !currentHeld else { return nil }
        return current.compactAt
    }

    private func entry(_ id: String, selfCompacts: Bool, now: TimeInterval) -> Entry {
        Entry(id: id, selfCompacts: selfCompacts, compactAt: selfCompacts ? now + Self.selfCompactAfter : nil)
    }

    /// A card arrives on top. A card the queue already holds is left where it is.
    mutating func arrive(_ id: String, selfCompacts: Bool, now: TimeInterval) {
        guard !ids.contains(id) else { return }
        let new = entry(id, selfCompacts: selfCompacts, now: now)
        guard let cur = current else {
            current = new
            currentHovered = false
            currentTyping = false
            return
        }
        // Hovered, typed into, or a view request counting down: the newcomer waits below as a compact pill.
        if currentHeld || !cur.selfCompacts {
            if let old = waiting {
                // A view request keeps the waiting slot over an approval or question; otherwise the newer waits there.
                if !old.selfCompacts && new.selfCompacts {
                    compact(new)
                    return
                }
                compact(old)
            }
            waiting = new
            return
        }
        // Replace: the current card compacts.
        compact(cur)
        current = new
        currentHovered = false
    }

    /// The pointer entered or left the current card.
    mutating func hoverCurrent(_ hovered: Bool, now: TimeInterval) {
        guard current != nil, hovered != currentHovered else { return }
        currentHovered = hovered
        if !hovered { graceAfterRelease(now: now) }
    }

    /// The current card's panel took (or gave back) the keyboard.
    mutating func typingCurrent(_ typing: Bool, now: TimeInterval) {
        guard current != nil, typing != currentTyping else { return }
        currentTyping = typing
        if !typing { graceAfterRelease(now: now) }
    }

    private mutating func graceAfterRelease(now: TimeInterval) {
        guard !currentHeld, var cur = current, let at = cur.compactAt, at < now + Self.hoverLeaveGrace else { return }
        cur.compactAt = now + Self.hoverLeaveGrace
        current = cur
    }

    /// The clock: self-compacts the current card when it is due (and unhovered), then the waiting one expands.
    mutating func tick(now: TimeInterval) {
        guard let cur = current, !currentHeld, let at = cur.compactAt, now >= at else { return }
        compact(cur)
        current = nil
        promoteWaiting(now: now)
    }

    /// The user clicked the waiting pill: the current card is tucked away (compacted) and the waiting one expands.
    mutating func clickWaiting(now: TimeInterval) {
        guard let w = waiting else { return }
        if let cur = current { compact(cur) }
        waiting = nil
        current = entry(w.id, selfCompacts: w.selfCompacts, now: now)
        currentHovered = false
        currentTyping = false
    }

    /// A card was answered anywhere (or is no longer pending): gone from every place. When it was the current card,
    /// the waiting one expands.
    mutating func resolve(_ id: String, now: TimeInterval) {
        compacted.removeAll { $0.id == id }
        if waiting?.id == id { waiting = nil }
        if current?.id == id {
            current = nil
            currentHovered = false
            currentTyping = false
            promoteWaiting(now: now)
        }
    }

    /// Put a card straight into the compacted set (it was on top before, and comes back after being hidden).
    mutating func addCompacted(_ id: String, selfCompacts: Bool) {
        guard !ids.contains(id) else { return }
        compacted.append(Entry(id: id, selfCompacts: selfCompacts, compactAt: nil))
    }

    private mutating func promoteWaiting(now: TimeInterval) {
        guard let w = waiting else { return }
        waiting = nil
        current = entry(w.id, selfCompacts: w.selfCompacts, now: now)
        currentHovered = false
        currentTyping = false
    }

    private mutating func compact(_ e: Entry) {
        compacted.removeAll { $0.id == e.id }
        compacted.append(Entry(id: e.id, selfCompacts: e.selfCompacts, compactAt: nil))
    }
}
