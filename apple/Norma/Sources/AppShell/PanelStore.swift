import Foundation
import Combine
import NormaProtocol

/// panel-shell T7: the app-side view of the daemon's panel tab state for the CURRENT session —
/// daemon-owned and event-sourced, exactly like `SessionModel` (`Model/SessionModel.swift`).
/// Session-KEYED storage (multiple sessions' tabs held at once, swap-not-merge on focus change) is
/// Task 9's `PanelTabsBySession`, layered on top of this one; this store only ever holds a single
/// session's worth of tab state.
///
/// **One code path.** `apply(_:)` is the sole mutator. It is fed EXTERNALLY by whatever already
/// pumps the live `NormaClient.events` stream — mirroring `SessionFeed.handle` → `SessionModel
/// .apply` exactly — rather than subscribing to `client.events` itself: `AsyncStream` delivers each
/// element to exactly one waiting consumer, so a second independent iterator over the SAME stream
/// would race `SessionFeed`'s own pump for events instead of seeing every one of them. Replayed
/// (post-`attach`) and live events arrive over that identical stream/pump in this codebase, so one
/// `apply(_:)` call per event — with no separate "this one's a replay" branch — is what "folds
/// replayed ones on attach" means here: there is no second path that could go out of sync with it.
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

    /// Only the four PERSISTED panel-lifecycle events accumulate here (see `apply(_:)`) — a
    /// browsing session is ~10-50 events (the bound `PanelTabNavigatedEvent`'s own doc comment,
    /// events.ts, names for exactly this reason), so re-folding the whole buffer on every arrival
    /// stays cheap, and reusing `foldPanelTabs` verbatim means this store can never drift from the
    /// pure function `PanelTabFoldTests` exercises directly.
    private var panelEvents: [SessionEvent] = []

    /// Apply one event — live or replayed, see the type's own doc comment for why there is only
    /// this one path. Anything that isn't one of the four persisted panel-lifecycle cases (every
    /// other `SessionEvent`, INCLUDING `panelCommand`) is a no-op: this store recognizes exactly
    /// the same four cases `foldPanelTabs` does, for the same reason — no seq/ordering bookkeeping
    /// happens here either, since `NormaClient` already owns dedupe/ordering upstream of whatever
    /// pump calls this.
    func apply(_ event: SessionEvent) {
        switch event {
        case .panelTabOpened, .panelTabClosed, .panelTabActivated, .panelTabNavigated:
            panelEvents.append(event)
        default:
            return
        }
        let state = foldPanelTabs(panelEvents)
        tabs = state.tabs
        activeTabId = state.activeTabId
    }
}
