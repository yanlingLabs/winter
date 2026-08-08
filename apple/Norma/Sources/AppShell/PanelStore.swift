import Foundation
import Combine
import NormaProtocol

/// panel-shell T9: tab state keyed by session. Switching sessions swaps which set is shown; it
/// never MERGES or clears — a session's tabs are its own and survive being switched away from,
/// because the fold that produced them is durable in the daemon either way.
///
/// Stores the FULL fold (`PanelTabState` — tabs AND `activeTabId`, `PanelTab.swift`), not just the
/// tab array: restoring a departed session has to bring back which tab was active too, or a switch
/// back would silently lose that.
struct PanelTabsBySession: Equatable {
    private var bySession: [String: PanelTabState] = [:]

    /// Replaces `sessionId`'s tab state with the fold of `events` — swap, never merge. The
    /// event-driven shape this type is unit-tested directly through (`PanelSessionSwapTests`).
    /// `PanelStore` below does NOT call this: it needs to fold a session's buffered events ON TOP OF
    /// an already-seeded `PanelTabState` (`foldPanelTabs`'s own `startingFrom:` parameter, added for
    /// exactly that — review round 1, Important 1), which this fold-from-empty-only method cannot
    /// express; it calls `set(sessionId:state:)` below with the result instead.
    mutating func apply(sessionId: String, events: [SessionEvent]) {
        bySession[sessionId] = foldPanelTabs(events)
    }

    /// Seeds/replaces `sessionId`'s tab state directly from an already-folded result — `panel.list`'s
    /// wire shape (`PanelListResult`, methods.ts) is ALREADY `{tabs, activeTabId}`, never raw events,
    /// so `apply(sessionId:events:)` above cannot consume it. Same swap-never-merge contract.
    mutating func set(sessionId: String, state: PanelTabState) {
        bySession[sessionId] = state
    }

    /// An unseen session has no tabs — not an error. The panel opens empty and `panel.list` fills
    /// it, so a lookup that races the fetch must return empty rather than trap.
    func tabs(for sessionId: String) -> [PanelTab] {
        bySession[sessionId]?.tabs ?? []
    }

    /// Sibling of `tabs(for:)` — a switch-back has to restore which tab was active, not just which
    /// tabs existed.
    func activeTabId(for sessionId: String) -> String? {
        bySession[sessionId]?.activeTabId
    }
}

/// panel-shell T7/T9: the app-side view of the daemon's panel tab state, session-keyed — daemon-owned
/// and event-sourced, exactly like `SessionModel` (`Model/SessionModel.swift`). Holds every session
/// this shell has ever shown the panel for at once (`PanelTabsBySession` above), and publishes ONLY
/// the CURRENT one's slice through `tabs`/`activeTabId` — `switchSession(to:)` swaps which slice that
/// is; it never clears a departed session's entry.
///
/// **One code path for live/replayed events.** `apply(_:)` is the sole per-event mutator. It is fed
/// EXTERNALLY by whatever already pumps the live `NormaClient.events` stream — mirroring
/// `SessionFeed.handle` → `SessionModel.apply` exactly (`ShellSessionHost.attachFresh`'s `onEvent`
/// hook, the SAME one that already forwards to `SessionDirectory.handle`) — rather than subscribing
/// to `client.events` itself: `AsyncStream` delivers each element to exactly one waiting consumer, so
/// a second independent iterator over the SAME stream would race the existing pump for events instead
/// of seeing every one of them. Replayed (post-`attach`) and live events arrive over that identical
/// stream/pump in this codebase, so one `apply(_:)` call per event — with no separate "this one's a
/// replay" branch — is what "folds replayed ones on attach" means here: there is no second path that
/// could go out of sync with it. The caller filters by `sessionId` before ever calling `apply(_:)`
/// (the `SessionModel.apply` precedent, `SessionFeed.handle`'s own `.pinned` branch) — this store
/// does NOT re-derive "is this the attached session" itself.
///
/// **Per-session raw-event buffers, never one shared buffer.** Task 7 kept a single `panelEvents`
/// array and refolded the whole thing on every arrival. Under session-keyed storage that single
/// buffer would accumulate session A's events, then session B's after a hop, and refolding the MIX
/// would merge two sessions' tabs into one list — exactly the failure this task exists to prevent,
/// and invisible to `PanelTabsBySession`'s own pure-struct tests, which never touch `apply(_:)` at
/// all (`PanelStoreSessionSwapTests` pins the store itself). `switchSession(to:)` starts the target
/// session's buffer EMPTY: replay always redelivers a session's complete history from `seq` 0 on
/// every attach/repin (`SessionFeed.start()`), so a stale partial buffer from a PRIOR attachment to
/// the very same session must never survive to be double-counted against the fresh replay. The
/// DEPARTING session's buffer/seed are dropped outright, not merely left unread (review round 1,
/// Minor 4) — this store is host-owned now (app-lifetime, not per-attachment), so every session ever
/// shown would otherwise accumulate a working-buffer entry forever; only the FOLDED
/// `PanelTabsBySession` entry needs to survive a switch, and a re-attach rebuilds the working buffer
/// from `seq` 0 regardless of whether this cleanup ran.
///
/// **A `panel.list` seed is a FOLD STARTING POINT, not a value replay can stomp (review round 1,
/// Important 1).** The first version of this fix seeded `PanelTabsBySession` directly and then kept
/// refolding each session's buffer FROM EMPTY on every new event — which discarded the seed the
/// instant the first replayed event arrived, since replay always redelivers a session's COMPLETE
/// history (the paragraph above) into a fold that only knew about that one buffered event. A
/// `panel.list` snapshot showing 3 tabs would collapse to 1, then rebuild across the whole replay —
/// worse than doing nothing, since it destroys the very thing `panel.list` exists to provide.
/// `seedBySession` fixes this: `applyFetchedSnapshot` freezes the snapshot there, and `apply(_:)`
/// folds each arriving event's session buffer ON TOP of that frozen seed (`foldPanelTabs`'s
/// `startingFrom:`) rather than from empty. Idempotent by construction (`foldPanelTabs`'s own doc
/// comment) — replaying an event the seed already reflects is a no-op, so the seed cannot be
/// overwritten by the very history it was a summary of.
///
/// **Indifferent to provenance by construction, not by a check.** `panel_tab_opened/closed/
/// activated/navigated` carry no "who did this" field on the wire (events.ts's `PanelTab*Event`
/// schemas, mirrored verbatim in NormaProtocol) — a human's `panel.openTab` tap and the agent's
/// browser-tool open both resolve, daemon-side, to the identical event, and this store has no path
/// that mutates `tabs`/`activeTabId` other than folding one of those four. There is deliberately no
/// second, optimistic-local-mutation path for a UI action to take instead — see `foldPanelTabs`'s
/// own doc comment (`PanelTab.swift`) for why `panelCommand`, the one panel case that IS an
/// action-shaped verb, never reaches the fold either.
@MainActor
final class PanelStore: ObservableObject {
    @Published private(set) var tabs: [PanelTab] = []
    @Published private(set) var activeTabId: String?

    /// Which session's slice is currently published. `nil` until the first `apply(_:)` or an
    /// explicit `switchSession(to:)` — Task 7's own `PanelStoreTests` construct a bare `PanelStore()`
    /// and call `apply(_:)` with no switch at all, so a nil id must still publish something sensible:
    /// `apply(_:)` treats nil as "whatever session this very event belongs to" (see its own body),
    /// never as "nothing is current" — `detach()` is the only thing that means the latter, and it
    /// only ever runs after a real `switchSession(to:)` in production.
    private(set) var currentSessionId: String?

    private var bySession = PanelTabsBySession()

    /// Only the four PERSISTED panel-lifecycle events accumulate here (see `apply(_:)`) — a
    /// browsing session is ~10-50 events (the bound `PanelTabNavigatedEvent`'s own doc comment,
    /// events.ts, names for exactly this reason), so re-folding one session's whole buffer on every
    /// arrival stays cheap, and reusing `foldPanelTabs` verbatim means this store can never drift
    /// from the pure function `PanelTabFoldTests` exercises directly. Keyed by sessionId — see the
    /// type's own doc comment for why a single shared buffer cannot survive a hop, and why the
    /// DEPARTING session's entry is deleted (not merely left stale) on every `switchSession(to:)`.
    private var eventsBySession: [String: [SessionEvent]] = [:]

    /// The frozen `panel.list` seed each session's buffer folds ON TOP OF — see the type doc's
    /// "fold starting point" section for why this exists at all. Written once per switch, by
    /// `applyFetchedSnapshot` (never by `apply(_:)`, which only ever READS it); cleared alongside
    /// `eventsBySession` on `switchSession(to:)`/`detach()` for the identical reason.
    private var seedBySession: [String: PanelTabState] = [:]

    /// Apply one event — live or replayed, see the type's own doc comment for why there is only
    /// this one path. Anything that isn't one of the four persisted panel-lifecycle cases (every
    /// other `SessionEvent`, INCLUDING `panelCommand`) is a no-op: this store recognizes exactly
    /// the same four cases `foldPanelTabs` does, for the same reason — no seq/ordering bookkeeping
    /// happens here either, since `NormaClient` already owns dedupe/ordering upstream of whatever
    /// pump calls this.
    ///
    /// The event's OWN `sessionId` (read straight off its payload — every one of the four structs
    /// carries it, `SessionEvent.swift`) decides which session's buffer it joins, never
    /// `currentSessionId`: the caller has already filtered to the attached session before calling
    /// this (the type doc's own point), so in production the two always agree — but keying off the
    /// event itself, rather than trusting the caller's context, is what keeps `PanelStoreTests`
    /// (Task 7, constructs a bare store and applies events with no `switchSession` call at all)
    /// green unmodified: while `currentSessionId` is nil, the publish gate below (`sessionId ==
    /// (currentSessionId ?? sessionId)`) is trivially true for whatever session THIS event names,
    /// so a bare store simply publishes each applied event's own session — exactly the
    /// single-session behavior that file already pins, since every event it applies shares one id.
    func apply(_ event: SessionEvent) {
        let sessionId: String
        switch event {
        case .panelTabOpened(let v): sessionId = v.sessionId
        case .panelTabClosed(let v): sessionId = v.sessionId
        case .panelTabActivated(let v): sessionId = v.sessionId
        case .panelTabNavigated(let v): sessionId = v.sessionId
        default: return
        }
        eventsBySession[sessionId, default: []].append(event)
        // Fold the WHOLE buffer again, every time — cheap (the type doc's own "~10-50 events"
        // note) — but starting from the frozen `panel.list` seed, not from empty (review round 1,
        // Important 1). Re-deriving `foldPanelTabs(seed, buffer-so-far)` fresh on each arrival,
        // rather than mutating a running total, is what makes this safe regardless of how many
        // times it runs: a growing buffer folded onto the SAME seed converges to one answer, it
        // never compounds.
        let seed = seedBySession[sessionId] ?? PanelTabState()
        let folded = foldPanelTabs(eventsBySession[sessionId] ?? [], startingFrom: seed)
        bySession.set(sessionId: sessionId, state: folded)
        if sessionId == (currentSessionId ?? sessionId) {
            publish(for: sessionId)
        }
    }

    /// Task 9: the shell attached/hopped to a different session — swap which slice is published.
    /// Deletes the DEPARTING session's working buffer/seed outright (review round 1, Minor 4 — this
    /// store is host-owned/app-lifetime now, so leaving them would accumulate one entry per session
    /// ever shown, forever; only the FOLDED `PanelTabsBySession` entry needs to survive, and a
    /// re-attach rebuilds the working state from `seq` 0 regardless). Starts the TARGET session's
    /// buffer/seed fresh (same reasoning as the type doc's "per-session raw-event buffers" section)
    /// and immediately republishes whatever `PanelTabsBySession` already has cached for it (empty
    /// for a never-seen session — `tabs(for:)`'s own contract — or the last-known state for a
    /// returning one), so the panel never shows a stale, unrelated session's tabs even for one frame
    /// while the fresh `panel.list` fetch and replay are in flight.
    func switchSession(to sessionId: String) {
        if let departing = currentSessionId, departing != sessionId {
            eventsBySession.removeValue(forKey: departing)
            seedBySession.removeValue(forKey: departing)
        }
        currentSessionId = sessionId
        eventsBySession[sessionId] = []
        seedBySession.removeValue(forKey: sessionId)
        publish(for: sessionId)
    }

    /// Task 9: nothing is attached — the panel shows nothing, but nothing already learned about any
    /// session is discarded (a later re-attach, even to the SAME session, still benefits from what's
    /// already cached in `PanelTabsBySession`). Deletes the departed session's working buffer/seed
    /// for the identical reason `switchSession(to:)` does (review round 1, Minor 4) — detaching is
    /// the OTHER way a session stops being current, so it needs the same cleanup.
    func detach() {
        if let departing = currentSessionId {
            eventsBySession.removeValue(forKey: departing)
            seedBySession.removeValue(forKey: departing)
        }
        currentSessionId = nil
        tabs = []
        activeTabId = nil
    }

    /// Task 9: seeds `sessionId` from a `panel.list` fetch — the app's instant-display answer on a
    /// session switch, ahead of whatever the slower full replay eventually redelivers (`ShellSession
    /// Host.attachFresh`/`hop` fire the fetch the moment the switch happens; this is where its result
    /// lands). Freezes the snapshot into `seedBySession` — the fold-starting-point every subsequent
    /// `apply(_:)` for this session builds on top of (review round 1, Important 1's fix; see the
    /// type doc's "fold starting point" section for why a snapshot written only into
    /// `PanelTabsBySession` directly would otherwise be destroyed by the very first replayed event).
    ///
    /// Dropped — never applied — if replay has ALREADY started delivering this session's own events
    /// since the last `switchSession(to:)`: replay redelivers the COMPLETE history from seq 0 every
    /// attach, so once it is under way it can only tie or be STALER than this snapshot, and applying
    /// an older one on top would regress a fold already in progress
    /// (`PanelStoreSessionSwapTests.testFetchedSnapshotIsDroppedIfReplayAlreadyStartedForThatSession`).
    /// review round 1, Minor 3: `switchSession(to:)` clearing the buffer on every switch is exactly
    /// what makes this guard's window REACHABLE at all (a session whose buffer was never cleared
    /// would already be non-empty from a prior visit, dropping the fetch unconditionally) — a
    /// disclosed, accepted trade, not a new one: an overlapping SAME-session fetch resolving out of
    /// order can still land here with an empty buffer and overwrite a fresher seed with a staler
    /// one; `panel.list` carries no seq to order by. Never a WRONG-session read either way — a
    /// response for a session the shell has since switched AWAY from still lands correctly, keyed
    /// to that session, just not currently shown.
    func applyFetchedSnapshot(sessionId: String, tabs: [PanelTab], activeTabId: String?) {
        guard (eventsBySession[sessionId] ?? []).isEmpty else { return }
        let state = PanelTabState(tabs: tabs, activeTabId: activeTabId)
        seedBySession[sessionId] = state
        bySession.set(sessionId: sessionId, state: state)
        if sessionId == currentSessionId {
            publish(for: sessionId)
        }
    }

    private func publish(for sessionId: String) {
        tabs = bySession.tabs(for: sessionId)
        activeTabId = bySession.activeTabId(for: sessionId)
    }
}
