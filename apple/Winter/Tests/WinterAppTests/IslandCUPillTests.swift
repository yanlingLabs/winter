import XCTest
import WinterKit
@testable import Winter

/// The island's computer-use pill: its state from event sequences — start, update, stop with the linger, several
/// sessions — and the words, the agent cursor's own (the bubble beside Winter's cursor) before the script's.
final class IslandCUPillTests: XCTestCase {
    private func item(_ sid: String, lastAt: Int = 1, running: Bool = true, title: String? = nil, apps: [String] = [],
                      sessionTitle: String? = nil) -> IslandComputerUseItem {
        IslandComputerUseItem(sessionId: sid, startedAt: 1, lastAt: lastAt, running: running, title: title, apps: apps,
                              session: IslandSessionFacts(mode: "code", title: sessionTitle))
    }

    func testStartUpdateAndStopWithTheLinger() {
        var s = IslandCUState()
        XCTAssertNil(s.presentation())
        // Start: the script's words until the cursor says something.
        s.apply([item("s1", apps: ["Chrome"], sessionTitle: "Publish the post")], now: 0)
        XCTAssertEqual(s.presentation()?.line, "Using Chrome")
        XCTAssertEqual(s.presentation()?.title, "Publish the post")
        XCTAssertEqual(s.activeSessionIds, ["s1"])
        XCTAssertNil(s.nextDeadline, "no clock while it works")
        // Update: the cursor's own caption, with the app.
        s.cursor(sessionId: "s1", kind: "caption", text: "Clicking “Publish”", appName: "Google Chrome", now: 1)
        XCTAssertEqual(s.presentation()?.line, "Clicking “Publish” in Google Chrome")
        // The press of that same click keeps the better words…
        s.cursor(sessionId: "s1", kind: "press", text: nil, appName: "Google Chrome", now: 1.2)
        XCTAssertEqual(s.presentation()?.line, "Clicking “Publish” in Google Chrome")
        // …a wait says what it waits for, and its end goes back to the script's words.
        s.cursor(sessionId: "s1", kind: "waitBegin", text: "Status: Published", appName: "Google Chrome", now: 3)
        XCTAssertEqual(s.presentation()?.line, "Waiting for “Status: Published”")
        s.cursor(sessionId: "s1", kind: "waitEnd", text: nil, appName: "Google Chrome", now: 4)
        XCTAssertEqual(s.presentation()?.line, "Using Chrome")
        // A new script with a title: its words.
        s.apply([item("s1", lastAt: 5, title: "Filing the form", apps: ["Chrome"])], now: 5)
        XCTAssertEqual(s.presentation()?.line, "Filing the form")
        // Between scripts (not running) it stays.
        s.apply([item("s1", lastAt: 6, running: false, title: "Filing the form", apps: ["Chrome"])], now: 6)
        XCTAssertEqual(s.presentation()?.line, "Filing the form")
        // Stop: the turn ended → it lingers, then goes.
        s.apply([], now: 10)
        XCTAssertEqual(s.presentation()?.lingering, true)
        XCTAssertEqual(s.nextDeadline, 10 + IslandCUState.linger)
        XCTAssertEqual(s.activeSessionIds, [], "the cursor is no longer followed")
        s.tick(now: 10 + IslandCUState.linger - 0.1)
        XCTAssertNotNil(s.presentation())
        s.tick(now: 10 + IslandCUState.linger)
        XCTAssertNil(s.presentation())
        XCTAssertNil(s.nextDeadline)
    }

    func testBackWithinTheLingerTakesThePillBackAtOnce() {
        var s = IslandCUState()
        s.apply([item("s1")], now: 0)
        s.cursor(sessionId: "s1", kind: "type", text: nil, appName: "Notes", now: 0.5)
        s.apply([], now: 1)
        XCTAssertEqual(s.presentation()?.lingering, true)
        s.apply([item("s1", lastAt: 2)], now: 2)
        XCTAssertEqual(s.presentation()?.lingering, false)
        XCTAssertEqual(s.presentation()?.line, "Typing in Notes", "it keeps its words until it says something new")
        XCTAssertNil(s.nextDeadline)
    }

    func testSeveralSessionsShowTheMostRecentAndACount() {
        var s = IslandCUState()
        s.apply([item("s1"), item("s2")], now: 0)
        XCTAssertEqual(s.presentation()?.count, 2)
        XCTAssertEqual(s.presentation()?.countLabel, "2")
        s.cursor(sessionId: "s1", kind: "scroll", text: "down", appName: "Safari", now: 1)
        XCTAssertEqual(s.presentation()?.sessionId, "s1")
        XCTAssertEqual(s.presentation()?.line, "Scrolling in Safari")
        s.cursor(sessionId: "s2", kind: "key", text: "cmd+s", appName: "Notes", now: 2)
        XCTAssertEqual(s.presentation()?.sessionId, "s2", "the most recently active one")
        XCTAssertEqual(s.presentation()?.line, "Pressing ⌘S in Notes")
        // Its host in front: the other one shows, counted alone.
        XCTAssertEqual(s.presentation(hidden: ["s2"])?.sessionId, "s1")
        XCTAssertEqual(s.presentation(hidden: ["s2"])?.countLabel, nil)
        XCTAssertNil(s.presentation(hidden: ["s1", "s2"]))
        // One stops: no linger while another still works.
        s.apply([item("s1")], now: 3)
        XCTAssertEqual(s.presentation()?.sessionId, "s1")
        XCTAssertEqual(s.presentation()?.lingering, false)
        XCTAssertNil(s.nextDeadline)
        // A cursor event for a session that is not using the computer changes nothing.
        let before = s
        s.cursor(sessionId: "s9", kind: "type", text: nil, appName: "Mail", now: 4)
        XCTAssertEqual(s, before)
    }

    func testRungFourMarksTheRealMouseInUseUntilItEnds() {
        var s = IslandCUState()
        s.apply([item("s1"), item("s2")], now: 0)
        XCTAssertFalse(s.usingRealMouse)
        s.cursor(sessionId: "s2", kind: "foreground", text: "on", appName: "Notes", now: 1)
        XCTAssertTrue(s.usingRealMouse)
        XCTAssertEqual(s.presentation()?.line, "Using your mouse")
        s.cursor(sessionId: "s2", kind: "foreground", text: "off", appName: "Notes", now: 2)
        XCTAssertFalse(s.usingRealMouse)
        s.cursor(sessionId: "s1", kind: "foreground", text: nil, appName: "Notes", now: 3)
        XCTAssertTrue(s.usingRealMouse)
        s.apply([item("s2")], now: 4)
        XCTAssertFalse(s.usingRealMouse, "the session's turn ended: its pointer is the user's again")
    }

    func testTheRealMouseIsClearedWhenTheSessionLeavesAndWhenTheHelperIsLost() {
        var s = IslandCUState()
        s.apply([item("s1")], now: 0)
        s.cursor(sessionId: "s1", kind: "foreground", text: "on", appName: "Notes", now: 1)
        s.apply([], now: 2)
        XCTAssertFalse(s.usingRealMouse)
        XCTAssertEqual(s.lingering?.usingMouse, false)
        // Back within the linger: no rung 4 comes back with it.
        s.apply([item("s1", lastAt: 3)], now: 3)
        XCTAssertFalse(s.usingRealMouse)
        // The helper's connection lost mid-rung-4: its `foreground off` will never come.
        s.cursor(sessionId: "s1", kind: "foreground", text: "on", appName: "Notes", now: 4)
        XCTAssertTrue(s.usingRealMouse)
        s.helperConnectionLost()
        XCTAssertFalse(s.usingRealMouse)
        XCTAssertNotNil(s.presentation(), "the pill stays: only the step-aside ends")
    }

    func testTheCursorsWordsAndTheScriptsWords() {
        XCTAssertEqual(islandCUActionLine(kind: "caption", text: "Choosing File › Save", appName: "Notes"), "Choosing File › Save in Notes")
        XCTAssertEqual(islandCUActionLine(kind: "caption", text: "Clicking “Save” in Notes", appName: "Notes"), "Clicking “Save” in Notes")
        XCTAssertEqual(islandCUActionLine(kind: "waitBegin", text: "Saved", appName: "Notes"), "Waiting for “Saved”")
        XCTAssertEqual(islandCUActionLine(kind: "waitBegin", text: nil, appName: "Notes"), "Waiting in Notes")
        XCTAssertEqual(islandCUActionLine(kind: "paste", text: nil, appName: nil), "Typing")
        XCTAssertEqual(islandCUActionLine(kind: "drag", text: nil, appName: "Finder"), "Dragging in Finder")
        XCTAssertEqual(islandCUActionLine(kind: "foreground", text: "on", appName: "Notes"), "Using your mouse")
        XCTAssertNil(islandCUActionLine(kind: "foreground", text: "off", appName: "Notes"))
        for quiet in ["move", "target", "idle", "done", "refused", "caption"] {
            XCTAssertNil(islandCUActionLine(kind: quiet, text: nil, appName: "Notes"), quiet)
        }
        XCTAssertEqual(islandKeyComboLabel("cmd+shift+z"), "⌘⇧Z")
        XCTAssertEqual(islandKeyComboLabel("return"), "↩")
        XCTAssertEqual(islandCUScriptLine(item("s", title: "  ")), computerV2FallbackLabel)
        XCTAssertEqual(islandCUScriptLine(item("s", apps: ["Mail", "Notes", "Xcode"])), "Using Mail, Notes")
        XCTAssertEqual(IslandCUPresentation(sessionId: "s", line: "x", count: 1, title: nil, lingering: false).accessibilityLabel,
                       "Computer use: x. Show the live view.")
    }
}
