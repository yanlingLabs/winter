import XCTest
import WinterKit
import WinterProtocol
@testable import Winter

/// The Winter island's store: the strip's count, the routing applied to the queue, self-compaction through the one
/// wake-up, answers, and the desktop-switch card read back out of the daemon's sentence.
@MainActor
final class IslandStoreTests: XCTestCase {
    private var now: TimeInterval = 0
    private var wakes: [TimeInterval?] = []

    private func makeStore(focus: IslandFocus = IslandFocus()) -> IslandStore {
        let store = IslandStore()
        store.clock = { [unowned self] in self.now }
        store.scheduleWake = { [unowned self] in self.wakes.append($0) }
        store.focus = { focus }
        return store
    }

    private func approval(_ id: String, session: String = "s_code", facts: IslandSessionFacts = IslandSessionFacts(),
                          hosts: [IslandHost] = []) -> IslandCard {
        IslandCard(callId: id, sessionId: session, answerSessionId: session, kind: .approval,
                   payload: .approval(toolName: "Bash", summary: "ls \(id)", reviewerReason: nil, options: []),
                   facts: facts, hosts: hosts)
    }

    func testTheStripCountsEveryPendingCardWhereverItShows() {
        let focus = IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"], winterFrontmost: true,
                                keyOrMainWindowSessionIds: ["s_front"])
        let store = makeStore(focus: focus)
        XCTAssertEqual(store.strip.waitingCount, 0)
        XCTAssertNil(store.strip.countLabel)
        store.apply([
            approval("a"),                                                        // on top
            approval("b", session: "s_front"),                                    // hidden: its window is in front
            approval("c", session: "s_disp", facts: IslandSessionFacts(mode: "dispatch")), // through the pill
        ])
        XCTAssertEqual(store.strip.waitingCount, 3)
        XCTAssertEqual(store.strip.countLabel, "3")
        XCTAssertEqual(store.placements[approval("b", session: "s_front").id], .hidden)
        XCTAssertEqual(store.placements[approval("c", session: "s_disp").id], .dispatchPill)
        XCTAssertEqual(store.queue.ids, [approval("a").id], "only the card placed on top is born on top")
        XCTAssertEqual(islandBadgeLabel(2), "2 waiting")
    }

    func testANewCardReplacesTheCurrentAndTheOneWakeUpSelfCompactsIt() {
        let store = makeStore()
        store.apply([approval("a")])
        XCTAssertEqual(store.currentCard?.callId, "a")
        XCTAssertEqual(wakes.last ?? nil, IslandQueue.selfCompactAfter)
        now = 1
        store.apply([approval("a"), approval("b")])
        XCTAssertEqual(store.currentCard?.callId, "b")
        XCTAssertEqual(store.queue.badgeCount, 1)
        now = 1 + IslandQueue.selfCompactAfter
        store.tick()
        XCTAssertNil(store.currentCard)
        XCTAssertEqual(store.queue.badgeCount, 2)
        XCTAssertEqual(wakes.last ?? 0, nil, "nothing due: the wake-up is cancelled")
        // Both are still in the list until answered.
        XCTAssertEqual(store.cards.count, 2)
    }

    func testHoverDefersTheNewcomerAndAClickSwapsThem() {
        let store = makeStore()
        store.apply([approval("a")])
        store.hoverCurrent(true)
        store.apply([approval("a"), approval("b")])
        XCTAssertEqual(store.currentCard?.callId, "a")
        XCTAssertEqual(store.waitingCard?.callId, "b")
        store.clickWaiting()
        XCTAssertEqual(store.currentCard?.callId, "b")
        XCTAssertNil(store.waitingCard)
    }

    func testACardHiddenBehindItsHostLeavesTheTopAndComesBackToTheBadgeNotAsANewPop() async {
        var focus = IslandFocus()
        let store = IslandStore()
        store.clock = { [unowned self] in self.now }
        store.focus = { focus }
        let card = approval("a", hosts: [IslandHost(clientName: "tui", tty: "/dev/ttys004")])
        store.apply([card])
        XCTAssertEqual(store.currentCard?.id, card.id)
        // The user switches to that terminal: hidden there.
        focus.terminalFrontness = { _ in .front }
        store.readTerminals = { ttys in Dictionary(uniqueKeysWithValues: ttys.map { ($0, .front) }) }
        await store.reroute()
        XCTAssertNil(store.currentCard)
        XCTAssertEqual(store.placements[card.id], .hidden)
        XCTAssertEqual(store.strip.waitingCount, 1, "still in the list and the count")
        // They leave the terminal: back, as a compacted card.
        store.readTerminals = { ttys in Dictionary(uniqueKeysWithValues: ttys.map { ($0, .notFront) }) }
        await store.reroute()
        XCTAssertNil(store.currentCard)
        XCTAssertEqual(store.queue.compacted.map(\.id), [card.id])
    }

    func testAnAnswerGoesToTheAnswerSessionAndTheCardLeavesTheTop() async {
        let store = makeStore()
        var sent: [(String, String, Bool, String?)] = []
        store.responder = IslandResponder(
            approval: { sid, callId, approved, optionId in
                await MainActor.run { sent.append((sid, callId, approved, optionId)) }
                return true
            },
            question: { _, _, _, _ in true }, elicitationURL: { _, _ in nil }, elicitation: { _, _, _ in .sent })
        let child = IslandCard(callId: "c1", sessionId: "s_disp", answerSessionId: "s_child", kind: .viewRequest,
                               payload: .viewRequest(app: "Safari", bundleId: "com.apple.Safari", reason: ""))
        store.apply([child])
        store.answerApproval(child, approved: true)
        XCTAssertTrue(store.inFlight.contains(child.id))
        for _ in 0..<200 where !store.inFlight.isEmpty { try? await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(store.inFlight.isEmpty)
        XCTAssertEqual(sent.first?.0, "s_child")
        XCTAssertEqual(sent.first?.1, "c1")
        XCTAssertEqual(sent.first?.2, true)
        XCTAssertEqual(sent.first?.3, "switch", "the desktop switch's ✓ is its `switch` option")
        XCTAssertNil(store.currentCard)
        // A list fetched before the answer landed does not bring it back on top.
        store.apply([child])
        XCTAssertFalse(store.queue.ids.contains(child.id))
    }

    func testTheDesktopSwitchCardIsToldByItsShapeAndItsWordsReadBack() {
        let summary = "Switch to Safari's desktop for a moment? Safari (com.apple.Safari) — to click in Safari, which it accepts only with its window on screen. Winter brings you back right after; with no answer within a minute, it switches."
        let words = DesktopVisitCardWords.parse(toolName: "ComputerV2", summary: summary, onTimeout: "allow", optionIds: ["switch"])
        XCTAssertEqual(words?.app, "Safari")
        XCTAssertEqual(words?.bundleId, "com.apple.Safari")
        XCTAssertEqual(words?.reason, "to click in Safari, which it accepts only with its window on screen")
        XCTAssertNil(DesktopVisitCardWords.parse(toolName: "ComputerV2", summary: summary, onTimeout: nil, optionIds: ["switch"]),
                     "an ordinary ComputerV2 card is an approval")
        XCTAssertNil(DesktopVisitCardWords.parse(toolName: "Bash", summary: summary, onTimeout: "allow", optionIds: ["switch"]))
        XCTAssertEqual(DesktopVisitCardWords.parse(toolName: "ComputerV2", summary: "something else", onTimeout: "allow",
                                                   optionIds: ["switch"])?.app, "the app")
    }

    func testAPendingItemBecomesItsCard() throws {
        let json = #"{"type":"approval_requested","seq":4,"ts":1,"sessionId":"s_c","threadId":"main","callId":"c9","toolName":"ComputerV2","summary":"Switch to Mail's desktop for a moment? Mail (com.apple.mail) — to type. Winter brings you back right after; with no answer within a minute, it switches.","options":[{"id":"switch","label":"Switch now"}],"onTimeout":"allow","expiresAt":99}"#
        let event = try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        let item = IslandPendingItem(sessionId: "s_c", answerSessionId: "s_c", kind: .approval, event: event,
                                     session: IslandSessionFacts(title: "Inbox zero"), hosts: [])
        let card = try XCTUnwrap(IslandCard.from(item))
        XCTAssertEqual(card.kind, .viewRequest)
        XCTAssertEqual(card.payload, .viewRequest(app: "Mail", bundleId: "com.apple.mail", reason: "to type"))
        XCTAssertEqual(card.expiresAt, 99)
        XCTAssertEqual(card.sessionLabel, "Inbox zero")
        XCTAssertEqual(islandBodyText(card), "Winter needs your view for a sec on Mail")
    }
}
