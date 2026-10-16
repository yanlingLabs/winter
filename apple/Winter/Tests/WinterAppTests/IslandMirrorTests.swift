import XCTest
import WinterKit
@testable import Winter

/// The island's computer-use mirror: pictures ONLY while a mirror is on screen — started when the in-island mirror shows,
/// stopped the instant it closes, handed to a detached window without a stop and a restart, stopped when the last
/// window closes — and the coordinator's island subscriptions (the pill's cursor without frames, the mirror's frames at
/// the island's caps).
@MainActor
final class IslandMirrorTests: XCTestCase {
    private final class FakeCapture: IslandMirrorCapture {
        var log: [String] = []
        func startCapture(sessionId: String) { log.append("start:\(sessionId)") }
        func stopCapture(sessionId: String) { log.append("stop:\(sessionId)") }
    }

    func testTheStreamRunsOnlyWhileTheMirrorIsVisible() {
        let capture = FakeCapture()
        let m = IslandMirrorLifecycle(capture: capture)
        m.setIslandMirror(nil)
        XCTAssertEqual(capture.log, [], "nothing on screen: nothing captured")
        m.setIslandMirror("s1")
        m.setIslandMirror("s1")
        XCTAssertEqual(capture.log, ["start:s1"])
        // The island yields to a card (or opens): the mirror is not visible — stopped at once.
        m.setIslandMirror(nil)
        XCTAssertEqual(capture.log, ["start:s1", "stop:s1"])
        // Another session's pill takes the mirror: one stops, the other starts.
        m.setIslandMirror("s1")
        m.setIslandMirror("s2")
        XCTAssertEqual(capture.log, ["start:s1", "stop:s1", "start:s1", "start:s2", "stop:s1"])
        m.closeAll()
        XCTAssertEqual(capture.log.last, "stop:s2")
        XCTAssertEqual(m.holders(of: "s2"), 0)
    }

    func testADetachHandsTheStreamOverWithoutStoppingItAndTheLastCloseStopsIt() {
        let capture = FakeCapture()
        let m = IslandMirrorLifecycle(capture: capture)
        m.setIslandMirror("s1")
        XCTAssertEqual(m.detach(windowId: "w1"), "s1")
        // The island collapses after the handover: no stop, no restart.
        m.setIslandMirror(nil)
        XCTAssertEqual(capture.log, ["start:s1"], "one continuous capture")
        XCTAssertEqual(m.holders(of: "s1"), 1)
        // The pill opened again beside the detached window: still one capture.
        m.setIslandMirror("s1")
        m.setIslandMirror(nil)
        XCTAssertEqual(capture.log, ["start:s1"])
        m.closeDetached(windowId: "w1")
        XCTAssertEqual(capture.log, ["start:s1", "stop:s1"])
        XCTAssertNil(m.detach(windowId: "w2"), "nothing to detach while no mirror shows")
        m.openDetached(windowId: "w3", sessionId: "s2")
        m.closeDetached(windowId: "w3")
        m.closeDetached(windowId: "w3")
        XCTAssertEqual(capture.log, ["start:s1", "stop:s1", "start:s2", "stop:s2"])
    }

    func testADetachedMirrorClosesWhenItsSessionsComputerUseEnds() {
        var cu = IslandCUState()
        let item = IslandComputerUseItem(sessionId: "s1", startedAt: 1, lastAt: 1, running: true)
        cu.apply([item], now: 0)
        XCTAssertFalse(islandDetachedMirrorEnded(sessionId: "s1", cu: cu))
        cu.apply([], now: 1)
        XCTAssertFalse(islandDetachedMirrorEnded(sessionId: "s1", cu: cu), "lingering")
        cu.tick(now: 1 + IslandCUState.linger)
        XCTAssertTrue(islandDetachedMirrorEnded(sessionId: "s1", cu: cu))
    }

    func testADetachedMirrorOpensAtTheBottomRightAwayFromTheTopCentre() {
        let visible = CGRect(x: 0, y: 80, width: 1512, height: 870)
        let f = IslandDetachedMirrorPanel.initialFrame(visible: visible)
        XCTAssertEqual(f.maxX, visible.maxX - IslandDetachedMirrorPanel.inset)
        XCTAssertEqual(f.minY, visible.minY + IslandDetachedMirrorPanel.inset)
        XCTAssertGreaterThan(f.minX, visible.midX, "clear of the island and the top centre")
    }

    func testWithAPhoneWatchingTheIslandMirrorCapturesAtTheIslandsRateAndThePhoneGetsItsOwnBack() {
        let coordinator = MirrorCoordinator(client: FakeHelperClient(), makeSink: { _ in RecordingSink() }, sleep: { _ in await Task.yield() })
        coordinator.addRemoteViewer("s1")
        XCTAssertEqual(coordinator.subscription(for: "s1"), .phone)
        coordinator.startCapture(sessionId: "s1")
        XCTAssertEqual(coordinator.subscription(for: "s1"), .island, "one capture at the larger rate; the phone's relay paces itself to 5 fps")
        coordinator.stopCapture(sessionId: "s1")
        XCTAssertEqual(coordinator.subscription(for: "s1"), .phone)
        coordinator.shutdown()
    }

    func testTheCoordinatorFollowsThePillsCursorWithoutFramesAndTheMirrorWithFramesAtTheIslandsCaps() async {
        let client = FakeHelperClient()
        client.setTargets([.fake("t1", app: "Google Chrome")], for: "s1")
        let coordinator = MirrorCoordinator(client: client, makeSink: { _ in RecordingSink() }, sleep: { _ in await Task.yield() })
        var heard: [String] = []
        coordinator.onIslandCursor = { sid, kind, text, app in heard.append("\(sid):\(kind):\(text ?? "-"):\(app ?? "-")") }

        coordinator.setIslandCursorSessions(["s1"])
        let subscribed = await eventually { client.frameFlags(for: "s1") == [false] }
        XCTAssertTrue(subscribed, "\(client.calls)")
        client.push(.cursor(HelperCursor(sessionId: "s1", targetId: "t1", kind: "caption", point: .zero, text: "Clicking “Publish”")))
        let got = await eventually { !heard.isEmpty }
        XCTAssertTrue(got)
        XCTAssertEqual(heard, ["s1:caption:Clicking “Publish”:Google Chrome"])

        // The mirror opens: frames, at the island's caps.
        coordinator.startCapture(sessionId: "s1")
        let frames = await eventually { client.frameFlags(for: "s1") == [false, true] }
        XCTAssertTrue(frames, "\(client.frameFlags(for: "s1"))")
        XCTAssertEqual(client.options(for: "s1").last,
                       FakeHelperClient.SubscribeOptions(maxFps: MirrorCoordinator.islandMaxFps, maxWidth: MirrorCoordinator.islandMaxWidth))
        XCTAssertTrue(coordinator.isReceivingFrames(sessionId: "s1"))

        // It closes: frames off at once, the cursor still followed.
        coordinator.stopCapture(sessionId: "s1")
        let off = await eventually { client.frameFlags(for: "s1") == [false, true, false] }
        XCTAssertTrue(off, "\(client.frameFlags(for: "s1"))")
        // The pill goes: unsubscribed, and the connection closes with nothing wanted.
        coordinator.setIslandCursorSessions([])
        let gone = await eventually { client.calls.contains("unsubscribe:s1") && client.calls.last == "disconnect" }
        XCTAssertTrue(gone, "\(client.calls)")
        coordinator.shutdown()
    }
}
