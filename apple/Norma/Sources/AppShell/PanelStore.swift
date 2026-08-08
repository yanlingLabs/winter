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
    /// event-driven shape this type is unit-tested through (`PanelSessionSwapTests`); `PanelStore`
    /// below reuses it verbatim as its own per-session projection, appending one more event to that
    /// session's own running log on every live/replayed arrival.
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
/// the very same session must never survive to be double-counted against the fresh replay.
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
    /// arrival stays cheap, and reusing `foldPanelTabs` (via `PanelTabsBySession.apply`) verbatim
    /// means this store can never drift from the pure function `PanelTabFoldTests` exercises
    /// directly. Keyed by sessionId — see the type's own doc comment for why a single shared buffer
    /// cannot survive a hop.
    private var eventsBySession: [String: [SessionEvent]] = [:]

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
        bySession.apply(sessionId: sessionId, events: eventsBySession[sessionId] ?? [])
        if sessionId == (currentSessionId ?? sessionId) {
            publish(for: sessionId)
        }
    }

    /// Task 9: the shell attached/hopped to a different session — swap which slice is published.
    /// Starts that session's raw-event buffer empty (see the type doc's "per-session raw-event
    /// buffers" section) and immediately republishes whatever `PanelTabsBySession` already has
    /// cached for it (empty for a never-seen session — `tabs(for:)`'s own contract — or the
    /// last-known state for a returning one), so the panel never shows a stale, unrelated session's
    /// tabs even for one frame while the fresh `panel.list` fetch and replay are in flight.
    func switchSession(to sessionId: String) {
        currentSessionId = sessionId
        eventsBySession[sessionId] = []
        publish(for: sessionId)
    }

    /// Task 9: nothing is attached — the panel shows nothing, but nothing already learned about any
    /// session is discarded (a later re-attach, even to the SAME session, still benefits from what's
    /// already cached).
    func detach() {
        currentSessionId = nil
        tabs = []
        activeTabId = nil
    }

    /// Task 9: seeds `sessionId` from a `panel.list` fetch — the app's instant-display answer on a
    /// session switch, ahead of whatever the slower full replay eventually redelivers (`ShellSession
    /// Host.attachFresh`/`hop` fire the fetch the moment the switch happens; this is where its result
    /// lands). Dropped — never applied — if replay has ALREADY started delivering this session's own
    /// events since the last `switchSession(to:)`: replay redelivers the COMPLETE history from seq 0
    /// every attach, so once it is under way it can only tie or be STALER than this snapshot, and
    /// applying an older one on top would regress a fold already in progress
    /// (`PanelStoreSessionSwapTests.testFetchedSnapshotIsDroppedIfReplayAlreadyStartedForThatSession`).
    /// A response for a session the shell has since switched AWAY from still lands correctly, keyed
    /// to that session — just not currently shown; a stale response after a rapid double-hop is
    /// therefore harmless by construction, never a source of showing the wrong session's tabs.
    func applyFetchedSnapshot(sessionId: String, tabs: [PanelTab], activeTabId: String?) {
        guard (eventsBySession[sessionId] ?? []).isEmpty else { return }
        bySession.set(sessionId: sessionId, state: PanelTabState(tabs: tabs, activeTabId: activeTabId))
        if sessionId == currentSessionId {
            publish(for: sessionId)
        }
    }

    private func publish(for sessionId: String) {
        tabs = bySession.tabs(for: sessionId)
        activeTabId = bySession.activeTabId(for: sessionId)
    }
}
