import CoreGraphics
import os
import XCTest
import WinterKit
import WinterSessionKit
@testable import Winter

/// ComputerV2 Phase 1b — the phone mirror's source inside Winter.app. The phone is shown exactly what the Mac's own
/// mirror shows (the same calls feed both), and a PHONE WATCH IS A VIEWER IN ITS OWN RIGHT (controller ruling
/// 2026-10-10): while it watches, the session is subscribed with pictures over the coordinator's one helper
/// connection — at the phone's own caps when no visible window wants them — whether or not a Winter window shows the
/// session, ref-counted beside the windows. The Mac's panel model is fed pictures only while it can be seen.
@MainActor
final class RemoteMirrorHubTests: XCTestCase {

    /// What a phone's watch was delivered.
    final class Phone: @unchecked Sendable {
        private let lock = OSAllocatedUnfairLock(initialState: [MirrorUpdate]())
        var updates: [MirrorUpdate] { lock.withLock { $0 } }
        var frames: [MirrorFrame] { updates.compactMap { if case .frame(let f) = $0 { return f }; return nil } }
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

    private static let phoneCaps = FakeHelperClient.SubscribeOptions(maxFps: MirrorWire.activeFps, maxWidth: MirrorWire.maxLongEdge)
    private static let macDefault = FakeHelperClient.SubscribeOptions(maxFps: nil, maxWidth: nil)
    private static let notes = MirrorUpdate.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true)

    private func rig(targets: [String: [HelperTarget]] = ["s1": [.fake("t1", app: "Notes")]]) -> Rig {
        let client = FakeHelperClient()
        for (session, list) in targets { client.setTargets(list, for: session) }
        let hub = RemoteMirrorHub()
        let sinks = Sinks()
        let coordinator = MirrorCoordinator(client: client,
                                            makeSink: { id in let s = RecordingSink(); sinks.byId[id] = s; return s },
                                            sleep: { _ in await Task.yield() },
                                            remote: hub)
        return Rig(coordinator: coordinator, client: client, hub: hub, sinks: sinks)
    }

    private func phoneWatch(_ hub: RemoteMirrorHub, _ session: String = "s1") async -> (Phone, RemoteMirrorWatch) {
        let phone = Phone()
        let watch = await hub.watch(sessionId: session, deliver: { phone.deliver($0) })
        return (phone, watch)
    }

    private func openMainWindow(_ r: Rig, session: String = "s1", visible: Bool = true) {
        r.coordinator.setWindow(MirrorWindow(id: "shell", kind: .shell, sessionId: session, width: 900, isVisible: visible))
    }

    private func frameLogCount(_ r: Rig, _ session: String = "s1") -> Int {
        r.sinks.byId[session]?.log.filter { $0.hasPrefix("frame:") }.count ?? 0
    }

    // MARK: - A viewer in its own right

    func testAPhoneWatchWithNoMacWindowSubscribesAtThePhonesCapsAndGetsPictures() async {
        let r = rig()
        let (phone, _) = await phoneWatch(r.hub)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") }, "\(r.client.calls)")
        XCTAssertEqual(r.client.calls, ["connect", "subscribe:s1"], "the coordinator's one connection — and never a launch")
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [true])
        XCTAssertEqual(r.client.options(for: "s1"), [Self.phoneCaps], "the helper captures no more than the phone takes")
        XCTAssertEqual(r.coordinator.remoteViewerCount("s1"), 1)
        await expect({ phone.updates.contains(Self.notes) }, "\(phone.updates)")

        r.client.push(.frame(.fake("s1", "t1", seq: 1, bytes: 9)))
        await expect({ phone.frames.count == 1 }, "\(phone.updates)")
        XCTAssertEqual(phone.frames.first?.jpeg.count, 9)
        XCTAssertEqual(frameLogCount(r), 0, "no Mac panel can be seen: its model decodes nothing")
    }

    func testTheHubMakesTheCoordinatorWhenThePhoneWatchesFirst() async {
        let client = FakeHelperClient()
        client.setTargets([.fake("t1")], for: "s1")
        let hub = RemoteMirrorHub()
        var made: MirrorCoordinator?
        hub.makeCoordinator = {
            if made == nil { made = MirrorCoordinator(client: client, makeSink: { _ in RecordingSink() }, sleep: { _ in await Task.yield() }, remote: hub) }
            return made
        }
        _ = await phoneWatch(hub)
        XCTAssertNotNil(made)
        XCTAssertTrue(hub.coordinator === made, "the coordinator registers itself with the hub it was made with")
        await expect({ made?.isReceivingFrames(sessionId: "s1") == true })
    }

    func testClosingTheMacWindowKeepsThePhonesPicturesFlowing() async {
        let r = rig()
        openMainWindow(r)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        let (phone, _) = await phoneWatch(r.hub)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(r.client.options(for: "s1"), [Self.macDefault], "a visible window: the Mac's own options, unchanged by the phone")

        r.coordinator.removeWindow(id: "shell")
        await expect({ r.client.options(for: "s1") == [Self.macDefault, Self.phoneCaps] }, "\(r.client.options(for: "s1"))")
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "the phone still holds the subscription")
        XCTAssertEqual(r.client.count("disconnect"), 0)
        r.client.push(.frame(.fake("s1", "t1", seq: 2, bytes: 13)))
        await expect({ phone.frames.contains { $0.jpeg.count == 13 } }, "\(phone.updates)")
        XCTAssertFalse(phone.updates.contains(.clear), "the window closing never takes the phone's mirror down: \(phone.updates)")
    }

    func testThePhoneLeavingClosesTheSubscriptionWhenNoWindowHoldsIt() async {
        let r = rig()
        let (phone, watch) = await phoneWatch(r.hub)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        await r.hub.unwatch(watch)
        await expect({ r.client.count("unsubscribe:s1") == 1 && r.client.count("disconnect") == 1 }, "\(r.client.calls)")
        XCTAssertTrue(r.coordinator.applied.isEmpty)
        XCTAssertEqual(r.coordinator.remoteViewerCount("s1"), 0)
        let before = phone.updates.count
        r.client.push(.frame(.fake("s1", "t1", seq: 3, bytes: 5)))
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(phone.updates.count, before, "nothing after the watch ended")
        await expect({ r.hub.snapshotCount == 0 }, "nothing left behind")
    }

    func testThePhoneLeavingNeverStopsTheMacsPanel() async {
        let r = rig()
        openMainWindow(r)
        let (_, watch) = await phoneWatch(r.hub)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        await r.hub.unwatch(watch)
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0)
        XCTAssertEqual(r.coordinator.appliedSubscription(sessionId: "s1"), .mac)
        r.client.push(.frame(.fake("s1", "t1", seq: 4, bytes: 7)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:7:720x540" }, "the Mac's own mirror goes on")
    }

    func testTwoPhonesAreTwoViewers() async {
        let r = rig()
        let (_, a) = await phoneWatch(r.hub)
        let (phoneB, b) = await phoneWatch(r.hub)
        XCTAssertEqual(r.coordinator.remoteViewerCount("s1"), 2)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") })
        await r.hub.unwatch(a)
        try? await Task.sleep(nanoseconds: 60_000_000)
        XCTAssertEqual(r.client.count("unsubscribe:s1"), 0, "the other phone still watches")
        r.client.push(.frame(.fake("s1", "t1", seq: 5, bytes: 6)))
        await expect({ phoneB.frames.contains { $0.jpeg.count == 6 } })
        await r.hub.unwatch(b)
        await expect({ r.client.count("unsubscribe:s1") == 1 })
        await r.hub.unwatch(b) // a repeat stop is a no-op, never a negative count
        XCTAssertEqual(r.coordinator.remoteViewerCount("s1"), 0)
    }

    func testAHiddenMacWindowIsSubscribedWithPicturesForThePhoneAndItsPanelGetsTheNewestWhenShown() async {
        let r = rig()
        openMainWindow(r, visible: false)
        await expect({ r.coordinator.applied.contains("s1") })
        XCTAssertEqual(r.client.frameFlags(for: "s1"), [false], "a hidden window alone gets no pictures")
        let (phone, _) = await phoneWatch(r.hub)
        await expect({ r.coordinator.appliedSubscription(sessionId: "s1") == .phone }, "\(r.client.options(for: "s1"))")
        r.client.push(.frame(.fake("s1", "t1", seq: 1, bytes: 8)))
        r.client.push(.frame(.fake("s1", "t1", seq: 2, bytes: 10)))
        await expect({ phone.frames.count == 2 }, "\(phone.updates)")
        XCTAssertEqual(frameLogCount(r), 0, "the hidden panel decodes nothing")

        openMainWindow(r, visible: true)
        await expect({ r.coordinator.appliedSubscription(sessionId: "s1") == .mac })
        XCTAssertEqual(r.sinks.byId["s1"]?.log.last, "frame:10:720x540", "the panel comes up with the newest picture, not grey")
    }

    // MARK: - The same picture as the Mac

    func testAPhoneSeesWhatTheMacsMirrorShows() async {
        let r = rig()
        openMainWindow(r)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") && r.coordinator.state(for: "s1").isVisible })
        r.client.push(.frame(.fake("s1", "t1", seq: 1, bytes: 9)))
        await expect({ r.sinks.byId["s1"]?.log.last == "frame:9:720x540" })

        let (phone, _) = await phoneWatch(r.hub)
        XCTAssertEqual(phone.updates.first, .show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true))
        guard case .frame(let first)? = phone.updates.dropFirst().first else { return XCTFail("the newest picture at once: \(phone.updates)") }
        XCTAssertEqual(first.jpeg.count, 9)

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
        let (phone, _) = await phoneWatch(r.hub)
        await expect({ phone.updates.contains(Self.notes) })
        r.client.push(.bound(sessionId: "s1", target: .fake("t2", app: "Mail")))
        await expect({ phone.updates.contains(.reset) }, "\(phone.updates)")
        XCTAssertTrue(phone.updates.contains(.show(app: "Mail", windowSize: CGSize(width: 800, height: 600), others: 1, live: true)), "\(phone.updates)")
    }

    func testTheTargetReleasedClearsThePhone() async {
        let r = rig()
        let (phone, _) = await phoneWatch(r.hub)
        await expect({ phone.updates.contains(Self.notes) })
        r.client.push(.released(sessionId: "s1", targetId: "t1"))
        await expect({ phone.updates.last == .clear }, "\(phone.updates)")
    }

    func testASessionUsingNoComputerShowsNothingAndCapturesNothing() async {
        let r = rig(targets: [:])
        let (phone, _) = await phoneWatch(r.hub)
        await expect({ r.coordinator.applied.contains("s1") })
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(phone.updates, [.clear], "nothing bound, nothing to show — the helper captures only bound windows")
    }

    func testAMissingHelperIsRetriedQuietlyAndNeverLaunched() async {
        let r = rig()
        r.client.scriptConnect([.socketMissing, .socketMissing, nil])
        let (phone, watch) = await phoneWatch(r.hub)
        await expect({ r.coordinator.isReceivingFrames(sessionId: "s1") }, "\(r.client.calls)")
        XCTAssertEqual(r.client.count("connect"), 3, "only connects: the daemon alone launches the helper")
        XCTAssertTrue(phone.updates.contains(Self.notes))
        await r.hub.unwatch(watch)
        await expect({ r.client.count("disconnect") == 1 })
    }

    func testTwoSessionsAreKeptApart() async {
        let r = rig(targets: ["a": [.fake("t1", app: "Notes")], "b": [.fake("t9", app: "Mail")]])
        let (phoneA, _) = await phoneWatch(r.hub, "a")
        let (phoneB, _) = await phoneWatch(r.hub, "b")
        await expect({ r.coordinator.applied == ["a", "b"] })
        await expect({ phoneA.updates.contains(.show(app: "Notes", windowSize: CGSize(width: 800, height: 600), others: 0, live: true)) })
        await expect({ phoneB.updates.contains(.show(app: "Mail", windowSize: CGSize(width: 800, height: 600), others: 0, live: true)) })
        let aBefore = phoneA.updates.count
        r.client.push(.frame(.fake("b", "t9", bytes: 3)))
        await expect({ phoneB.frames.count == 1 })
        XCTAssertEqual(phoneA.updates.count, aBefore)
    }
}
