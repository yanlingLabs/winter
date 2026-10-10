import CoreGraphics
import os
import XCTest
import WinterKit
import WinterSessionKit
@testable import Winter

/// ComputerV2 Phase 1b — the phone mirror's source inside Winter.app: the phone is shown exactly what the Mac's own
/// mirror shows (the same calls feed both), and watching from the phone changes NOTHING about what the Mac
/// subscribes to — no session added, no frames asked for, no helper connection (the never-move-the-view rule).
@MainActor
final class RemoteMirrorHubTests: XCTestCase {

    /// What a phone's watch was delivered.
    final class Phone: @unchecked Sendable {
        private let lock = OSAllocatedUnfairLock(initialState: [MirrorUpdate]())
        var updates: [MirrorUpdate] { lock.withLock { $0 } }
        func deliver(_ u: MirrorUpdate) { lock.withLock { $0.append(u) } }
    }

    private func expect(_ condition: @MainActor () -> Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async {
        let ok = await eventually(2, condition)
        XCTAssertTrue(ok, message, file: file, line: line)
    }

    private struct Rig {
        let coordinator: MirrorCoordinator
        let client: FakeHelperClient
        let hub: RemoteMirrorHub
        let sinks: Sinks
    }

    final class Sinks { var byId: [String: RecordingSink] = [:] }

    private func rig() -> Rig {
        let client = FakeHelperClient()
        let hub = RemoteMirrorHub()
        let sinks = Sinks()
        let coordinator = MirrorCoordinator(client: client,
                                            makeSink: { id in let s = RecordingSink(); sinks.byId[id] = s; return s },
                                            sleep: { _ in await Task.yield() },
                                            remote: hub)
        return Rig(coordinator: coordinator, client: client, hub: hub, sinks: sinks)
    }

    private func phoneWatch(_ hub: RemoteMirrorHub, _ session: String) async -> (Phone, RemoteMirrorWatch) {
        let phone = Phone()
        let watch = await hub.watch(sessionId: session, deliver: { phone.deliver($0) })
        return (phone, watch)
    }

    private func openMainWindow(_ r: Rig, session: String = "s1", visible: Bool = true, targets: [HelperTarget] = [.fake("t1", app: "Notes")]) async {
        r.client.setTargets(targets, for: session)
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: session, width: 900, isVisible: visible))
        await expect({ r.coordinator.applied.contains(session) && r.coordinator.state(for: session).isVisible })
    }

    // MARK: - Never starts anything

    func testWatchingASessionNoWindowShowsStartsNothingAndShowsNothing() async {
        let r = rig()
        let (phone, _) = await phoneWatch(r.hub, "s1")
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(phone.updates, [.clear], "nothing is on show for the session")
        XCTAssertTrue(r.client.calls.isEmpty, "no connection, no subscription — the phone never makes the Mac capture")
        XCTAssertTrue(r.coordinator.desiredSessions.isEmpty)
        XCTAssertFalse(r.coordinator.isConnected)
    }

    func testWatchingNeverTurnsFramesOnForAHiddenWindow() async {
        let r = rig()
        await openMainWindow(r, visible: false)
        let (phone, _) = await phoneWatch(r.hub, "s1")
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false], "still the one frameless subscription")
        XCTAssertFalse(r.coordinator.isReceivingFrames(sessionId: "s1"))
        XCTAssertEqual(phone.updates, [.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: false)],
                       "the panel and its app, honestly marked without pictures")
    }

    // MARK: - The same picture as the Mac

    func testAPhoneSeesWhatTheMacsMirrorShows() async {
        let r = rig()
        await openMainWindow(r)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        r.client.push(.frame(.fake("s1", "t1", seq: 1, bytes: 9)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:9:720x540" })

        let (phone, _) = await phoneWatch(r.hub, "s1")
        XCTAssertEqual(phone.updates.first, .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        guard case .frame(let first)? = phone.updates.dropFirst().first else { return XCTFail("the newest picture at once: \(phone.updates)") }
        XCTAssertEqual(first.jpeg.count, 9)
        XCTAssertEqual(first.width, 720)

        r.client.push(.cursor(HelperCursor(sessionId: "s1", targetId: "t1", kind: "press", point: CGPoint(x: 5, y: 6), count: 1)))
        r.client.push(.frame(.fake("s1", "t1", seq: 2, bytes: 11)))
        await expect({ phone.updates.count == 4 }, "\(phone.updates)")
        XCTAssertEqual(phone.updates[2], .cursor(MirrorCursor(kind: "press", point: CGPoint(x: 5, y: 6), count: 1)))
        guard case .frame(let second) = phone.updates[3] else { return XCTFail() }
        XCTAssertEqual(second.jpeg.count, 11)
        XCTAssertGreaterThan(second.seq, first.seq)
        XCTAssertEqual(r.sinks.byId["s1"]?.log.suffix(2), ["cursor:press:5,6", "frame:11:720x540"], "the Mac's own mirror is untouched by the tee")
    }

    func testAnotherBoundTargetTakingOverResetsThePhonesPictureToo() async {
        let r = rig()
        await openMainWindow(r, targets: [.fake("t1", app: "Notes")])
        let (phone, _) = await phoneWatch(r.hub, "s1")
        r.client.push(.bound(sessionId: "s1", target: .fake("t2", app: "Mail")))
        await expect({ phone.updates.contains(.reset) }, "\(phone.updates)")
        XCTAssertTrue(phone.updates.contains(.show(app: "Mail", windowSize: CGSize(width: 800, height: 600), others: 1, live: true)), "\(phone.updates)")
    }

    func testTheWindowBecomingVisibleOrHiddenIsToldToThePhone() async {
        let r = rig()
        await openMainWindow(r, visible: false)
        let (phone, _) = await phoneWatch(r.hub, "s1")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: true))
        await expect({ phone.updates.last == .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true) }, "\(phone.updates)")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "s1", width: 900, isVisible: false))
        await expect({ phone.updates.last == .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: false) }, "\(phone.updates)")
    }

    func testTheTargetReleasedOrTheWindowClosedClearsThePhone() async {
        let r = rig()
        await openMainWindow(r)
        let (phone, _) = await phoneWatch(r.hub, "s1")
        r.client.push(.released(sessionId: "s1", targetId: "t1"))
        await expect({ phone.updates.last == .clear }, "\(phone.updates)")

        let r2 = rig()
        await openMainWindow(r2)
        let (phone2, _) = await phoneWatch(r2.hub, "s1")
        r2.coordinator.removeWindow(id: "shell")
        await expect({ phone2.updates.last == .clear }, "\(phone2.updates)")
    }

    func testAnUnwatchedPhoneGetsNothingMoreAndTheHubForgetsAnIdleSession() async {
        let r = rig()
        await openMainWindow(r)
        let (phone, watch) = await phoneWatch(r.hub, "s1")
        XCTAssertEqual(r.hub.watcherCount(sessionId: "s1"), 1)
        await r.hub.unwatch(watch)
        XCTAssertEqual(r.hub.watcherCount(sessionId: "s1"), 0)
        let before = phone.updates.count
        r.client.push(.frame(.fake("s1", "t1", seq: 3, bytes: 5)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:5:720x540" })
        XCTAssertEqual(phone.updates.count, before)

        r.coordinator.removeWindow(id: "shell")
        await expect({ r.hub.snapshotCount == 0 }, "a session nothing shows and nobody watches leaves no entry behind")
    }

    func testTwoSessionsAreKeptApart() async {
        let r = rig()
        r.client.setTargets([.fake("t1", app: "Notes")], for: "a")
        r.client.setTargets([.fake("t9", app: "Mail")], for: "b")
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: "a", width: 900))
        r.coordinator.setWindow(MirrorWindow(id: "det", kind: .detached, sessionId: "b", width: 900))
        await expect({ r.coordinator.applied == ["a", "b"] })
        let (phoneA, _) = await phoneWatch(r.hub, "a")
        let (phoneB, _) = await phoneWatch(r.hub, "b")
        XCTAssertEqual(phoneA.updates.first, .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        XCTAssertEqual(phoneB.updates.first, .show(app: "Mail", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        r.client.push(.frame(.fake("b", "t9", bytes: 3)))
        await expect({ phoneB.updates.count == 2 })
        XCTAssertEqual(phoneA.updates.count, 1)
    }
}
