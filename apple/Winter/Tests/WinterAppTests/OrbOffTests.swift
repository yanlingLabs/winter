import XCTest
import Combine
import WinterProtocol
import AppKit
@testable import Winter

/// A surface that is not on screen must not exist as a SwiftUI tree. The orb is off by default (the dispatch pill is
/// the summon surface), yet its `GlassRootView` was built at launch and kept in a hidden panel — where SwiftUI keeps
/// running `TimelineView`s: with an unread reply the orb's liquid redrew for as long as the app lived, ~21,000
/// wake-ups a second in an otherwise idle Winter. The tree now exists only between `show()` and `hide()`.
@MainActor
final class OrbOffTests: XCTestCase {
    private func event(_ fields: [String: Any]) -> SessionEvent { ReplayBufferTests.event(fields, session: "s_orb") }

    /// A whole turn the orb itself started (clientName "orb"), with a reply, finished.
    private func finishedOrbTurn(on session: SessionModel, seq start: Int = 1) {
        session.apply(event(["type": "user_message", "seq": start, "ts": 1, "threadId": "main", "text": "hi", "clientName": "orb"]))
        session.apply(event(["type": "turn_started", "seq": start + 1, "ts": 2, "threadId": "main"]))
        session.apply(event(["type": "assistant_message", "seq": start + 2, "ts": 3, "threadId": "main", "text": "An answer."]))
        session.apply(event(["type": "turn_completed", "seq": start + 3, "ts": 4, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]))
    }

    private func waitFor(_ seconds: Double = 2, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    func testAnOrbThatIsOffHoldsNoSwiftUITreeAndItsLiquidNeverSteps() async throws {
        let session = SessionModel()
        let controller = OrbWindowController(session: session)
        XCTAssertFalse(controller.isVisible)
        XCTAssertFalse(controller.hasContentForTesting, "built at launch, hidden: that was the bug")
        var steps = 0
        let watch = controller.fluidModel.$sim.dropFirst().sink { _ in steps += 1 }

        finishedOrbTurn(on: session)
        await waitFor { controller.fieldAdapter.hasUnread }
        XCTAssertTrue(controller.fieldAdapter.hasUnread, "an answer arrived while the orb was off: unread, for the next Show Orb")
        XCTAssertGreaterThanOrEqual(controller.fieldAdapter.fluidState.levelForTesting, 0, "the field model says unread — and there is no tree to show it")

        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertEqual(steps, 0, "no orb steps over two seconds with the orb off")
        XCTAssertFalse(controller.hasContentForTesting)
        withExtendedLifetime(watch) {}
    }

    func testTurningTheOrbOnBuildsItAndOffReleasesIt() async throws {
        let session = SessionModel()
        let controller = OrbWindowController(session: session)
        finishedOrbTurn(on: session)
        await waitFor { controller.fieldAdapter.hasUnread }
        var steps = 0
        let watch = controller.fluidModel.$sim.dropFirst().sink { _ in steps += 1 }

        controller.show()
        XCTAssertTrue(controller.hasContentForTesting, "on: the tree is built")
        weak var first = controller.hostingViewForTesting
        XCTAssertNotNil(first)
        await waitFor { steps > 0 }
        XCTAssertGreaterThan(steps, 0, "an unread orb on screen breathes")

        controller.hide()
        XCTAssertFalse(controller.hasContentForTesting, "off: the tree is dropped")
        try await Task.sleep(nanoseconds: 300_000_000) // let SwiftUI's last pass and the autorelease pool drain
        XCTAssertNil(first, "…and nothing keeps the hosting view alive")
        let atOff = steps
        try await Task.sleep(nanoseconds: 2_000_000_000)
        XCTAssertEqual(steps, atOff, "no orb steps over two seconds once it is off")

        controller.show()
        XCTAssertTrue(controller.hasContentForTesting, "on again: rebuilt")
        XCTAssertNotNil(controller.hostingViewForTesting)
        controller.hide()
        withExtendedLifetime(watch) {}
    }

    func testAHiddenOrbMarksTheSameTurnsUnreadThatTheViewWould() async throws {
        // Not started by the orb, with a readable reply: unread (the user's only signal on the Mac).
        let sessionA = SessionModel()
        let a = OrbWindowController(session: sessionA)
        sessionA.apply(event(["type": "user_message", "seq": 1, "ts": 1, "threadId": "main", "text": "hi", "clientName": "phone"]))
        sessionA.apply(event(["type": "turn_started", "seq": 2, "ts": 2, "threadId": "main"]))
        sessionA.apply(event(["type": "assistant_message", "seq": 3, "ts": 3, "threadId": "main", "text": "An answer."]))
        sessionA.apply(event(["type": "turn_completed", "seq": 4, "ts": 4, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]))
        await waitFor { a.fieldAdapter.hasUnread }
        XCTAssertTrue(a.fieldAdapter.hasUnread)

        // Not started by the orb, nothing to read: not unread.
        let sessionB = SessionModel()
        let b = OrbWindowController(session: sessionB)
        sessionB.apply(event(["type": "user_message", "seq": 1, "ts": 1, "threadId": "main", "text": "hi", "clientName": "phone"]))
        sessionB.apply(event(["type": "turn_started", "seq": 2, "ts": 2, "threadId": "main"]))
        sessionB.apply(event(["type": "turn_completed", "seq": 3, "ts": 3, "threadId": "main", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]))
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(b.fieldAdapter.hasUnread, "nothing was said, so nothing is unread")
    }
}

private extension FluidState {
    /// The level inside `.unread`, so a test can compare without naming it.
    var levelForTesting: Double { if case .unread(let level) = self { return level } else { return -1 } }
}
