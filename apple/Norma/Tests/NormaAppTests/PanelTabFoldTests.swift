import XCTest
import NormaKit
import NormaProtocol
@testable import Norma

/// panel-shell T7: mirrors Task 5's TS fold tests (`packages/core/test/panel/store.test.ts`) case
/// for case — same five scenarios, same assertions, proving the Swift fold's semantics match the
/// daemon's `foldPanelTabs` (`packages/core/src/panel/store.ts`) exactly.
///
/// `ev(_:)` decodes real wire JSON — the `WorkflowReducerTests`/`SessionModelTests` idiom — rather
/// than constructing `SessionEvent.PanelTabOpened`/etc. payloads directly: those NormaProtocol
/// structs have no PUBLIC memberwise init (only `Codable`'s synthesized `init(from:)` is public;
/// see `SessionEvent.swift`'s own precedent — `UserMessage`/`TurnStarted`/etc. spell out an
/// explicit `public init` exactly where a Swift PRODUCER needs to construct one directly), so
/// decoding wire JSON is the only construction path available outside the NormaProtocol module.
final class PanelTabFoldTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func opened(tabId: String, kind: String = "web", url: String? = nil, title: String? = nil, seq: Int = 1) -> SessionEvent {
        let urlField = url.map { "\"\($0)\"" } ?? "null"
        let titleField = title.map { "\"\($0)\"" } ?? "null"
        return ev(#"{"type":"panel_tab_opened","seq":\#(seq),"sessionId":"s1","ts":0,"tabId":"\#(tabId)","kind":"\#(kind)","url":\#(urlField),"title":\#(titleField)}"#)
    }

    private func closed(tabId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"panel_tab_closed","seq":\#(seq),"sessionId":"s1","ts":0,"tabId":"\#(tabId)"}"#)
    }

    private func activated(tabId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"panel_tab_activated","seq":\#(seq),"sessionId":"s1","ts":0,"tabId":"\#(tabId)"}"#)
    }

    private func navigated(tabId: String, url: String, title: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"panel_tab_navigated","seq":\#(seq),"sessionId":"s1","ts":0,"tabId":"\#(tabId)","url":"\#(url)","title":"\#(title)"}"#)
    }

    private func command(commandId: String = "c1", tabId: String? = "t1", seq: Int = 1) -> SessionEvent {
        let tabIdField = tabId.map { "\"\($0)\"" } ?? "null"
        return ev(#"{"type":"panel_command","seq":\#(seq),"sessionId":"s1","ts":0,"commandId":"\#(commandId)","tabId":\#(tabIdField),"action":"navigate","url":"https://a","deadlineMs":15000}"#)
    }

    // MARK: - Task 5's five cases, mirrored

    func testOpenThenNavigateLeavesTheTabAtItsLatestUrl() {
        let state = foldPanelTabs([
            opened(tabId: "t1", seq: 1),
            navigated(tabId: "t1", url: "https://a", title: "A", seq: 2),
            navigated(tabId: "t1", url: "https://b", title: "B", seq: 3),
        ])
        XCTAssertEqual(state.tabs, [PanelTab(tabId: "t1", kind: .web, url: "https://b", title: "B")])
    }

    func testClosingATabRemovesItAndClearsActiveIfItWasActive() {
        let state = foldPanelTabs([
            opened(tabId: "t1", seq: 1),
            activated(tabId: "t1", seq: 2),
            closed(tabId: "t1", seq: 3),
        ])
        XCTAssertEqual(state.tabs, [])
        XCTAssertNil(state.activeTabId)
    }

    func testNavigationForAnUnknownTabIsIgnoredNotResurrecting() {
        let state = foldPanelTabs([
            navigated(tabId: "ghost", url: "https://x", title: "X", seq: 1),
        ])
        XCTAssertEqual(state.tabs, [])
    }

    func testOpenOrderIsPreserved() {
        let state = foldPanelTabs([
            opened(tabId: "t1", seq: 1),
            opened(tabId: "t2", seq: 2),
        ])
        XCTAssertEqual(state.tabs.map(\.tabId), ["t1", "t2"])
    }

    /// `noUncheckedIndexedAccess` doesn't exist in Swift, but the discipline the TS test's own
    /// comment names still applies: assert the count FIRST, then index — a bare `tabs.first?.url`
    /// alone would pass vacuously if the fold had wrongly dropped the tab entirely.
    func testPanelCommandNeverAffectsFoldedState() {
        let state = foldPanelTabs([
            opened(tabId: "t1", seq: 1),
            command(tabId: "t1", seq: 2),
        ])
        XCTAssertEqual(state.tabs.count, 1)
        XCTAssertNil(state.tabs.first?.url)
    }

    // MARK: - diff-tabs Task 9: the diff kind and its identity, through BOTH fold paths

    /// **Fold path 1 of 2 — the live/replayed `panel_tab_opened` event.**
    ///
    /// The wire's `diffId` has to reach `PanelTab.diffId`, because that is the only key
    /// `ShellSessionHost.openDiffTab`'s dedupe can compare a chip against: `tabId` is minted per tab,
    /// so a second click on the same chip would be indistinguishable from a first one without it and
    /// would mint a duplicate tab. Dropping the field here fails NO compile — the fold would simply
    /// build a `PanelTab` with the defaulted `nil` — which is exactly why it is pinned.
    func testTheFoldCarriesADiffTabsKindAndItsDiffId() {
        let state = foldPanelTabs([
            ev(#"{"type":"panel_tab_opened","seq":1,"sessionId":"s1","ts":0,"tabId":"t1","kind":"diff","url":null,"title":"engine.ts","diffId":"d_abc123"}"#),
        ])
        XCTAssertEqual(state.tabs, [PanelTab(tabId: "t1", kind: .diff, url: nil,
                                             title: "engine.ts", diffId: "d_abc123")])
    }

    /// The other direction: a `.web` tab (and every pre-feature `panel_tab_opened`, which carries no
    /// `diffId` key at all) folds to `diffId == nil` — absent must not become an empty string or any
    /// other stand-in that would then MATCH another tab's absent id in the dedupe.
    func testANonDiffTabCarriesNoDiffId() {
        let state = foldPanelTabs([opened(tabId: "t1", seq: 1)])
        XCTAssertEqual(state.tabs.count, 1)
        XCTAssertNil(state.tabs.first?.diffId)
    }
}

/// `PanelStore.apply(_:)` is the ONE code path (live and replayed events both arrive through it —
/// see the type's own doc comment, `PanelStore.swift`) — these tests exercise it directly rather
/// than leaving it covered only transitively through `foldPanelTabs`.
@MainActor
final class PanelStoreTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    /// Applying events one at a time (as `apply(_:)` requires — the ONLY entry point, whether the
    /// event is a live arrival or part of an attach replay) must reach the exact same state as
    /// folding the same events in one batch — proving the store adds no extra logic beyond
    /// `foldPanelTabs` that could drift from it.
    func testApplyingEventsOneAtATimeMatchesTheBatchFold() {
        let events = [
            ev(#"{"type":"panel_tab_opened","seq":1,"sessionId":"s1","ts":0,"tabId":"t1","kind":"web","url":null,"title":null}"#),
            ev(#"{"type":"panel_tab_navigated","seq":2,"sessionId":"s1","ts":0,"tabId":"t1","url":"https://a","title":"A"}"#),
            ev(#"{"type":"panel_tab_activated","seq":3,"sessionId":"s1","ts":0,"tabId":"t1"}"#),
        ]
        let store = PanelStore()
        for e in events { store.apply(e) }
        let batch = foldPanelTabs(events)
        XCTAssertEqual(store.tabs, batch.tabs)
        XCTAssertEqual(store.activeTabId, batch.activeTabId)
    }

    func testApplyIgnoresPanelCommand() {
        let store = PanelStore()
        store.apply(ev(#"{"type":"panel_tab_opened","seq":1,"sessionId":"s1","ts":0,"tabId":"t1","kind":"web","url":null,"title":null}"#))
        store.apply(ev(#"{"type":"panel_command","seq":2,"sessionId":"s1","ts":0,"commandId":"c1","tabId":"t1","action":"navigate","url":"https://a","deadlineMs":15000}"#))
        XCTAssertEqual(store.tabs.count, 1)
        XCTAssertNil(store.tabs.first?.url)
    }

    /// A session event with nothing to do with the panel (here, `session_created`) must be a
    /// silent no-op — the store recognizes exactly the four panel-lifecycle cases, nothing else.
    func testApplyIgnoresUnrelatedSessionEvents() {
        let store = PanelStore()
        store.apply(ev(#"{"type":"session_created","seq":1,"sessionId":"s1","ts":0,"scope":"user"}"#))
        XCTAssertEqual(store.tabs, [])
        XCTAssertNil(store.activeTabId)
    }

    // MARK: - diff-tabs Task 9: fold path 2 of 2 — the `panel.list` snapshot seed

    /// **`panel.list` → `PanelTab`, `diffId` intact.**
    ///
    /// The app re-seeds the panel store from this snapshot on EVERY attach and hop
    /// (`ShellSessionHost.refreshPanelTabs`), so this mapping — not the event fold — is what a diff
    /// tab's identity survives on past the moment it was opened. A drop here is invisible until the
    /// user comes back to the session, and then the chip re-mints a tab that is already open.
    func testTheSnapshotFoldCarriesDiffIdAndDropsAnUnknownKind() {
        let tabs = panelTabs(fromSnapshot: [
            PanelTabInfo(tabId: "t1", kind: "diff", url: nil, title: "engine.ts", diffId: "d_abc123"),
            PanelTabInfo(tabId: "t2", kind: "web", url: "https://a", title: "A", diffId: nil),
            PanelTabInfo(tabId: "t3", kind: "hologram", url: nil, title: nil, diffId: nil),
        ])
        XCTAssertEqual(tabs, [
            PanelTab(tabId: "t1", kind: .diff, url: nil, title: "engine.ts", diffId: "d_abc123"),
            PanelTab(tabId: "t2", kind: .web, url: "https://a", title: "A", diffId: nil),
        ], "an unparseable kind drops that tab; every other field rides through untouched")
    }

    /// …and the seeded store actually publishes it — the mapping being right is worth nothing if
    /// `applyFetchedSnapshot` is not the thing the app reads back.
    func testASeededDiffTabKeepsItsDiffIdInTheStore() {
        let store = PanelStore()
        store.switchSession(to: "s1")
        store.applyFetchedSnapshot(
            sessionId: "s1",
            tabs: panelTabs(fromSnapshot: [
                PanelTabInfo(tabId: "t1", kind: "diff", url: nil, title: "engine.ts", diffId: "d_abc123"),
            ]),
            activeTabId: "t1")
        XCTAssertEqual(store.tabs.first?.diffId, "d_abc123")
        XCTAssertEqual(store.allSessionTabStates["s1"]?.tabs.first?.diffId, "d_abc123")
    }
}
