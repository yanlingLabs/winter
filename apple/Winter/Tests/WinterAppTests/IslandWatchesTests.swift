import XCTest
import WinterKit
@testable import Winter

/// The island's Watches tab: every armed computer-use watch with its session, target, condition and time armed, and Stop
/// (`computerUse.wakes.cancel`).
@MainActor
final class IslandWatchesTests: XCTestCase {
    private func watch(_ id: String, condition: String = "clicked", element: String? = "“Submit for review”", armedAt: Int = 1_000,
                       expiresAt: Int = 3_600_000, title: String? = "List the extension") -> IslandWatchItem {
        IslandWatchItem(sessionId: "s1", wakeId: id, condition: condition, targetLabel: "Chrome — Developer Dashboard",
                        elementLabel: element, armedAt: armedAt, expiresAt: expiresAt,
                        session: IslandSessionFacts(mode: "code", title: title))
    }

    func testTheRowsWords() {
        XCTAssertEqual(islandWatchConditionLine(watch("a")), "You click “Submit for review”")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "appeared", element: "“Saved”")), "“Saved” appears")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "gone", element: nil)), "Something goes away")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "titled", element: "“Done”")), "The title becomes “Done”")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "submitted", element: nil)), "You submit the form")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "navigated", element: nil)), "The page changes")
        XCTAssertEqual(islandWatchConditionLine(watch("a", condition: "changed", element: "“Name”")), "You change “Name”")
        XCTAssertEqual(islandWatchSessionLine(watch("a")), "List the extension")
        XCTAssertEqual(islandWatchSessionLine(watch("a", title: nil)), "Session")
        XCTAssertEqual(islandWatchTimeLine(watch("a", armedAt: 0, expiresAt: 60 * 60_000), nowMs: 4 * 60_000),
                       "armed 4 min ago · 56 min left")
        XCTAssertEqual(islandWatchTimeLine(watch("a", armedAt: 0, expiresAt: 3 * 60 * 60_000), nowMs: 30_000),
                       "armed just now · 2 h 59 min left")
        XCTAssertEqual(islandWatchSymbol("clicked"), "cursorarrow.click")
    }

    func testTheTabListsTheArmedWatchesOldestFirstAndStopDisarms() async {
        let store = IslandActivityStore()
        var cancelled: [String] = []
        store.disarm = { sid, id in cancelled.append("\(sid)/\(id)"); return true }
        store.apply(IslandActivitySnapshot(watches: [watch("w2", armedAt: 2_000), watch("w1", armedAt: 1_000)]))
        XCTAssertEqual(store.watches.map(\.wakeId), ["w1", "w2"])
        store.disarmWatch(store.watches[0])
        XCTAssertTrue(store.disarming.contains("w1"))
        store.disarmWatch(store.watches[0])
        let done = await eventually { !store.disarming.contains("w1") }
        XCTAssertTrue(done)
        XCTAssertEqual(cancelled, ["s1/w1"], "one cancel, however many clicks")
        XCTAssertEqual(store.watches.map(\.wakeId), ["w2"], "gone at once; the daemon's notice confirms")
    }

    func testAFailedStopSaysSo() async {
        let store = IslandActivityStore()
        store.disarm = { _, _ in false }
        store.apply(IslandActivitySnapshot(watches: [watch("w1")]))
        store.disarmWatch(store.watches[0])
        let done = await eventually { store.disarmErrors["w1"] != nil }
        XCTAssertTrue(done)
        XCTAssertEqual(store.watches.map(\.wakeId), ["w1"])
        XCTAssertFalse(store.disarming.contains("w1"))
        // The watch ends anyway (fired, expired): its line goes with it.
        store.apply(IslandActivitySnapshot(watches: []))
        XCTAssertTrue(store.disarmErrors.isEmpty)
    }

    func testTheWatchesTabIsRegistered() {
        XCTAssertEqual(IslandTabRegistry.watches.id, "watches")
        var tabs = IslandTabState()
        XCTAssertTrue(tabs.select("watches"))
        XCTAssertEqual(tabs.selected?.title, "Watches")
    }
}
