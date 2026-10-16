import XCTest
import WinterKit
@testable import Winter

/// The Winter island's routing rules (`IslandRouter`), with injected focus state.
final class IslandRoutingTests: XCTestCase {
    private func card(_ kind: IslandCard.Kind = .approval, session: String = "s_code", facts: IslandSessionFacts = IslandSessionFacts(),
                      hosts: [IslandHost] = [], logSession: String? = nil) -> IslandCard {
        let payload: IslandCardPayload
        switch kind {
        case .approval: payload = .approval(toolName: "Bash", summary: "rm -rf build", reviewerReason: nil, options: [])
        case .question: payload = .question([])
        case .elicitation: payload = .elicitation(serverName: "Linear", message: "", host: "linear.app", origin: "https://linear.app")
        case .viewRequest: payload = .viewRequest(app: "Safari", bundleId: "com.apple.Safari", reason: "")
        }
        return IslandCard(callId: "c1", sessionId: logSession ?? session, answerSessionId: session, kind: kind, payload: payload,
                          facts: facts, hosts: hosts)
    }

    // Rule 1: Dispatch and its children.

    func testDispatchCardsGoThroughThePillWhileItIsVisibleAndOnTopOtherwise() {
        let dispatch = card(session: "s_disp", facts: IslandSessionFacts(mode: "dispatch"))
        var focus = IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"])
        XCTAssertEqual(IslandRouter.placement(of: dispatch, focus: focus), .dispatchPill)
        focus.dispatchPillVisible = false
        XCTAssertEqual(IslandRouter.placement(of: dispatch, focus: focus), .top)
    }

    func testADispatchChildIsDispatchFamilyByOriginOrByItsCoordinator() {
        let byOrigin = card(session: "s_child", facts: IslandSessionFacts(origin: "dispatch-child", parentSessionId: "s_disp"))
        let byParent = card(session: "s_child2", facts: IslandSessionFacts(parentSessionId: "s_disp"))
        let mirrored = card(session: "s_child3", logSession: "s_disp")
        let focus = IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"])
        for c in [byOrigin, byParent, mirrored] {
            XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .dispatchPill)
        }
        // Even with its own terminal in front: a child's card follows Dispatch's rule.
        var hidden = focus
        hidden.dispatchPillVisible = false
        hidden.terminalFrontness = { _ in .front }
        let withTerminal = card(session: "s_child", facts: IslandSessionFacts(origin: "dispatch-child"),
                                hosts: [IslandHost(clientName: "tui", tty: "/dev/ttys004")])
        XCTAssertEqual(IslandRouter.placement(of: withTerminal, focus: hidden), .top)
    }

    // Rule 2: any other session.

    func testACodeSessionInAKeyOrMainWinterWindowIsHiddenOnlyWhileWinterIsFrontmost() {
        let c = card(session: "s_code", hosts: [IslandHost(clientName: "orb")])
        var focus = IslandFocus(winterFrontmost: true, keyOrMainWindowSessionIds: ["s_code"])
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .hidden)
        focus.winterFrontmost = false
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .top, "Winter behind another app: the card shows")
        focus.winterFrontmost = true
        focus.keyOrMainWindowSessionIds = ["s_other"]
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .top, "another session's window in front")
    }

    func testATerminalSessionIsHiddenOnlyWhileItsExactTerminalIsInFront() {
        let c = card(session: "s_cli", hosts: [IslandHost(clientName: "tui", role: "harness", tty: "/dev/ttys004")])
        var focus = IslandFocus()
        focus.terminalFrontness = { $0 == "/dev/ttys004" ? .front : .notFront }
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .hidden)
        focus.terminalFrontness = { _ in .notFront }
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .top)
        focus.terminalFrontness = { _ in .unknown }
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .top, "no exact match: show it")
    }

    func testAPhoneHostNeverHidesACard() {
        let c = card(session: "s_cli", hosts: [IslandHost(clientName: "iphone-gateway", role: "remote", tty: "/dev/ttys009")])
        var focus = IslandFocus()
        focus.terminalFrontness = { _ in .front }
        XCTAssertEqual(IslandRouter.placement(of: c, focus: focus), .top)
    }

    // Rule 3: view requests.

    func testAViewRequestIsAlwaysOnTop() {
        let fromDispatch = card(.viewRequest, session: "s_disp", facts: IslandSessionFacts(mode: "dispatch"))
        let fromFrontWindow = card(.viewRequest, session: "s_code")
        var focus = IslandFocus(dispatchPillVisible: true, dispatchSessionIds: ["s_disp"], winterFrontmost: true,
                                keyOrMainWindowSessionIds: ["s_code"])
        focus.terminalFrontness = { _ in .front }
        XCTAssertEqual(IslandRouter.placement(of: fromDispatch, focus: focus), .top)
        XCTAssertEqual(IslandRouter.placement(of: fromFrontWindow, focus: focus), .top)
    }

    func testOnlyTheTerminalsThatCanHideACardAreRead() {
        let cards = [
            card(session: "s_cli", hosts: [IslandHost(clientName: "tui", tty: "/dev/ttys004")]),
            card(.viewRequest, session: "s_v", hosts: [IslandHost(clientName: "tui", tty: "/dev/ttys005")]),
            card(session: "s_disp", facts: IslandSessionFacts(mode: "dispatch"), hosts: [IslandHost(clientName: "tui", tty: "/dev/ttys006")]),
            card(session: "s_p", hosts: [IslandHost(clientName: "iphone-gateway", role: "remote", tty: "/dev/ttys007")]),
        ]
        XCTAssertEqual(IslandRouter.ttysToJudge(cards, focus: IslandFocus()), ["/dev/ttys004"])
    }
}
