import XCTest
import NormaProtocol
@testable import Norma

/// panel-shell T9: proves `PanelTabsBySession`'s session-keyed swap semantics — the brief's three
/// scenarios, verbatim in name and assertion. `PanelTabOpened`/`PanelTabNavigated` etc. expose no
/// public memberwise init outside the NormaProtocol module (only `Codable`'s synthesized
/// `init(from:)` is public — see `PanelTabFoldTests.ev(_:)`'s own doc comment for the same fact),
/// so — exactly like that sibling file — events here are built by decoding wire JSON, never by
/// calling an enum case with the struct's field names as labels.
final class PanelSessionSwapTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func opened(sessionId: String, tabId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"panel_tab_opened","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)","kind":"web","url":null,"title":null}"#)
    }

    private func navigated(sessionId: String, tabId: String, url: String, title: String, seq: Int = 2) -> SessionEvent {
        ev(#"{"type":"panel_tab_navigated","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)","url":"\#(url)","title":"\#(title)"}"#)
    }

    func testTabsAreKeyedBySession() {
        var store = PanelTabsBySession()
        store.apply(sessionId: "s1", events: [opened(sessionId: "s1", tabId: "t1")])
        store.apply(sessionId: "s2", events: [opened(sessionId: "s2", tabId: "t2")])
        XCTAssertEqual(store.tabs(for: "s1").map(\.tabId), ["t1"])
        XCTAssertEqual(store.tabs(for: "s2").map(\.tabId), ["t2"])
    }

    func testSwitchingBackRestoresTheEarlierSession() {
        var store = PanelTabsBySession()
        store.apply(sessionId: "s1", events: [
            opened(sessionId: "s1", tabId: "t1", seq: 1),
            navigated(sessionId: "s1", tabId: "t1", url: "https://a", title: "A", seq: 2),
        ])
        store.apply(sessionId: "s2", events: [])
        // switching away must not clear what s1 had. Count first, then index — a bare `.first?.url`
        // alone would pass vacuously if the fold had wrongly dropped the tab entirely (the exact
        // discipline PanelTabFoldTests.swift's own doc comment names, and Task 5's PLAN DEFECT #6
        // in this plan's progress.md).
        XCTAssertEqual(store.tabs(for: "s1").count, 1)
        XCTAssertEqual(store.tabs(for: "s1").first?.url, "https://a")
    }

    func testUnknownSessionHasNoTabsRatherThanCrashing() {
        let store = PanelTabsBySession()
        XCTAssertEqual(store.tabs(for: "never-seen"), [])
    }
}

/// panel-shell T9: `PanelStore`'s OWN session-awareness — the guard against the failure this task
/// exists to prevent. Task 7's `PanelStore` accumulated ONE un-keyed raw-event buffer forever; a
/// hop that kept appending to it would refold session A's and session B's events TOGETHER into one
/// merged tab list — invisible to `PanelTabsBySession`'s own pure-struct tests above, which never
/// exercise `PanelStore.apply(_:)` at all. These pin the store itself.
@MainActor
final class PanelStoreSessionSwapTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func opened(sessionId: String, tabId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"panel_tab_opened","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)","kind":"web","url":null,"title":null}"#)
    }

    func testSwitchingSessionsShowsTheNewSessionsTabsNotAMergeOfBoth() {
        let store = PanelStore()
        store.apply(opened(sessionId: "s1", tabId: "t1"))
        XCTAssertEqual(store.tabs.map(\.tabId), ["t1"])

        store.switchSession(to: "s2")
        XCTAssertEqual(store.tabs, [], "an unseen session shows empty, not s1's leftover tab")

        store.apply(opened(sessionId: "s2", tabId: "t2"))
        XCTAssertEqual(store.tabs.map(\.tabId), ["t2"], "s1's tab must never bleed into s2's list")
    }

    func testSwitchingBackRestoresWhatWasLiveFoldedEarlier() {
        let store = PanelStore()
        store.apply(opened(sessionId: "s1", tabId: "t1"))
        store.switchSession(to: "s2")
        store.switchSession(to: "s1")
        XCTAssertEqual(store.tabs.map(\.tabId), ["t1"], "switching back restores s1's own tabs")
    }

    func testDetachPublishesEmptyButKeepsTheCache() {
        let store = PanelStore()
        store.apply(opened(sessionId: "s1", tabId: "t1"))
        store.detach()
        XCTAssertEqual(store.tabs, [], "nothing attached — the panel shows nothing")
        store.switchSession(to: "s1")
        XCTAssertEqual(store.tabs.map(\.tabId), ["t1"], "re-attaching to s1 still finds its cached tab")
    }

    func testFetchedSnapshotSeedsAnEmptySessionInstantly() {
        let store = PanelStore()
        store.switchSession(to: "s1")
        store.applyFetchedSnapshot(
            sessionId: "s1",
            tabs: [PanelTab(tabId: "t1", kind: .web, url: nil, title: nil)],
            activeTabId: "t1"
        )
        XCTAssertEqual(store.tabs.map(\.tabId), ["t1"])
        XCTAssertEqual(store.activeTabId, "t1")
    }

    /// The narrow race the fetch and replay share: a slow `panel.list` response landing AFTER
    /// replay has already started delivering this session's own events must never regress what
    /// replay already folded — it can only tie or be stale, never authoritative, once replay is
    /// under way.
    func testFetchedSnapshotIsDroppedIfReplayAlreadyStartedForThatSession() {
        let store = PanelStore()
        store.switchSession(to: "s1")
        store.apply(opened(sessionId: "s1", tabId: "live"))
        store.applyFetchedSnapshot(sessionId: "s1", tabs: [], activeTabId: nil)
        XCTAssertEqual(store.tabs.map(\.tabId), ["live"], "a fetch racing behind replay must not regress it")
    }
}
