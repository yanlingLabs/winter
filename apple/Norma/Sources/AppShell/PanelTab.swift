import SwiftUI
import NormaProtocol

/// panel-shell T7: UI-drawn categories for a panel tab. A separate type from the wire's
/// `SessionEvent.PanelTabKind` (NormaProtocol) — same cases, deliberately not reused directly
/// so the tab-content boundary below never depends on the protocol module. `init(_:)` converts the
/// wire type to this one with an EXHAUSTIVE SWITCH, never a `rawValue` force-unwrap: the wire type
/// is CLOSED by design (its own doc comment, `SessionEvent.swift`, explains why a tab's kind picks
/// the rendering view and so can't have a reasonable fallback), so a future case added there must
/// fail THIS switch to compile rather than crash at runtime on an un-mapped raw string.
///
/// **diff-tabs Task 9: `.diff` is the fifth case, and its arrival is the tripwire above working as
/// designed.** Task 4 added `diff` to the WIRE enum, which broke `init(_:)` below and nothing else —
/// exactly the failure the doc comment promised, and the reason the app target sat red from Task 4
/// until this one. Adding it here then reds every exhaustive switch over THIS enum in turn (the
/// favicon glyph, the display title, the content factory), which is the same mechanism one layer
/// down.
enum PanelTabKind: String, Codable, Equatable {
    case web, document, code, note, diff

    init(_ wire: SessionEvent.PanelTabKind) {
        switch wire {
        case .web: self = .web
        case .document: self = .document
        case .code: self = .code
        case .note: self = .note
        case .diff: self = .diff
        }
    }
}

/// One tab in the panel — folded from the daemon's persisted `panel_tab_*` events (`foldPanelTabs`
/// below), never constructed by a local UI action directly. `tabId` (never `id` on the wire,
/// matching NormaProtocol/`packages/protocol/src/methods.ts`) is the daemon-minted identity; `id`
/// is a computed alias so this can be `Identifiable` for SwiftUI lists without a second stored
/// property to keep in sync with it.
struct PanelTab: Identifiable, Equatable {
    let tabId: String
    let kind: PanelTabKind
    var url: String?
    var title: String?
    /// diff-tabs Task 9: which persisted diff this tab shows — set only on a `.diff` tab, `nil` on
    /// every other kind and on every tab minted before this feature existed.
    ///
    /// **It is the DEDUPE KEY, which is why it has to survive both of the app's fold paths.** A
    /// transcript chip's second click must ACTIVATE the tab its first click opened rather than mint
    /// a duplicate (`ShellSessionHost.openDiffTab`), and the only thing the two clicks share is this
    /// id — `tabId` is daemon-minted per tab, so a duplicate would be indistinguishable from the
    /// original by every other field. The two paths are `foldPanelTabs` below (the live/replayed
    /// `panel_tab_opened` event) and `ShellSessionHost.refreshPanelTabs`'s `panel.list` snapshot;
    /// dropping it from EITHER makes the dedupe fail silently after the corresponding transition
    /// (a replay, or an attach/hop respectively).
    ///
    /// Defaulted, like `url`/`title` are optional, so every pre-existing construction site
    /// (`BrowserRuntime`, `SpikeCloseLeak`, the fold tests) keeps compiling and keeps meaning
    /// exactly what it meant: a tab with no diff.
    var diffId: String? = nil
    var id: String { tabId }
}

/// panel-shell T7: the tab-content boundary. Written ONCE — LibreOffice, Monaco and markdown all
/// slot in behind it without touching the frame. In this plan the only implementation is a
/// placeholder; Plan B replaces `.web` with CEF.
protocol PanelTabContent {
    var kind: PanelTabKind { get }
    var title: String { get }
    var icon: Image { get }
    @ViewBuilder func makeChrome() -> AnyView
    @ViewBuilder func makeContent() -> AnyView
}

/// The fold's result — mirrors the TS `PanelTabState` (`packages/core/src/panel/store.ts`) field
/// for field: an ordered tab list plus an optional active id.
struct PanelTabState: Equatable {
    var tabs: [PanelTab] = []
    var activeTabId: String?
}

/// PURE: rebuild tab state by replaying persisted panel events in order. Mirrors `foldPanelTabs`
/// (`packages/core/src/panel/store.ts`) case for case:
///
///  - `panelTabOpened` — appended UNLESS `tabId` is already open (a daemon-minted id should never
///    repeat, but the dedupe costs nothing and matches the TS guard exactly).
///  - `panelTabClosed` — removes the tab; clears `activeTabId` only when the closed tab WAS active.
///  - `panelTabActivated` — ignored for an unknown `tabId` rather than activating a tab that
///    doesn't exist.
///  - `panelTabNavigated` — an UNKNOWN tab is ignored rather than created: navigation is a fact
///    ABOUT a tab, and resurrecting a closed one would let a stale in-flight report undo a close.
///
/// `panelCommand` is deliberately absent from this switch, exactly as `panel_command` is absent
/// from the TS switch — it is TRANSIENT (`SessionEvent.transientTypes`/`.isTransient`,
/// NormaProtocol), never persisted, and carries no tab state; folding it would record the same
/// navigation twice, once as intent and once as the reported fact. Every other `SessionEvent` case
/// (including every OTHER transient — `assistantDelta`, `sessionActivity`, etc.) falls through the
/// same `default` — this fold never needs to ASK "is this transient": it simply doesn't recognize
/// anything but the four panel-lifecycle cases it lists explicitly, the same case-omission the TS
/// fold uses (it never consults `TRANSIENT_EVENT_TYPES` either).
///
/// panel-shell T9 (review round 1, Important 1): `startingFrom` — defaulted to an empty state, so
/// every pre-existing call site (`PanelTabFoldTests`, `PanelTabsBySession.apply`) is untouched —
/// lets a caller fold a batch of events ON TOP OF an already-known state instead of from scratch.
/// `PanelStore.apply(_:)` is the one production caller that needs this: without it, a `panel.list`
/// snapshot that seeded 3 tabs would be discarded and rebuilt from just ONE tab the moment the next
/// replayed event arrived, because replaying always redelivers a session's COMPLETE history
/// (`fromSeq: 0`, `SessionFeed.start()`) into a fold that otherwise only knew about that one event.
/// Safe because every case above is IDEMPOTENT against its own prior output — re-processing an
/// event whose effect the seed already reflects (`opened` for an already-open id, `closed` for an
/// already-absent one, `activated`/`navigated` writing the same value again) is a no-op, so folding
/// a session's full replayed history on top of its own already-correct snapshot converges to the
/// identical answer rather than compounding.
func foldPanelTabs(_ events: [SessionEvent], startingFrom initial: PanelTabState = PanelTabState()) -> PanelTabState {
    var tabs: [PanelTab] = initial.tabs
    var activeTabId: String? = initial.activeTabId

    for event in events {
        switch event {
        case .panelTabOpened(let v):
            if !tabs.contains(where: { $0.tabId == v.tabId }) {
                // diff-tabs Task 9: `diffId` rides through — see `PanelTab.diffId` for why losing it
                // on this path (or on the `panel.list` snapshot path) breaks chip dedupe silently.
                tabs.append(PanelTab(tabId: v.tabId, kind: PanelTabKind(v.kind), url: v.url,
                                     title: v.title, diffId: v.diffId))
            }
        case .panelTabClosed(let v):
            tabs.removeAll { $0.tabId == v.tabId }
            if activeTabId == v.tabId { activeTabId = nil }
        case .panelTabActivated(let v):
            if tabs.contains(where: { $0.tabId == v.tabId }) { activeTabId = v.tabId }
        case .panelTabNavigated(let v):
            if let i = tabs.firstIndex(where: { $0.tabId == v.tabId }) {
                tabs[i].url = v.url
                tabs[i].title = v.title
            }
        default:
            break // panelCommand (transient, no state) and every non-panel event type
        }
    }
    return PanelTabState(tabs: tabs, activeTabId: activeTabId)
}
