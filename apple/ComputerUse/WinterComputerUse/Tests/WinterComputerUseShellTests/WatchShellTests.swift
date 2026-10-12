import CoreGraphics
import Foundation
import WinterComputerUseShell
import WinterCUCore
import WinterCUPresentation
import XCTest

/// The watches as the daemon reaches them (PROTOCOL.md §4.13), recorded.
final class FakeWatches: WatchService, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var armed: [(params: WatchArmParams, connection: Int)] = []
    private(set) var cancelled: [String] = []
    private(set) var closedConnections: [Int] = []
    /// "begin:<target or *>" / "end:<target or *>", in order.
    private(set) var ownInput: [String] = []
    var answer = WatchArmResult(element: CUWatchElement(role: "button", name: "Send"), targetLabel: "Mail — Inbox")
    var armError: Error?

    func arm(_ p: WatchArmParams, connection: Int) async throws -> WatchArmResult {
        if let armError { throw armError }
        lock.withLock { armed.append((p, connection)) }
        return answer
    }
    func cancel(watchId: String) { lock.withLock { cancelled.append(watchId) } }
    func connectionClosed(_ connection: Int) { lock.withLock { closedConnections.append(connection) } }
    func ownInputBegan(targetId: String?) -> CUOwnInputToken {
        lock.withLock { ownInput.append("begin:\(targetId ?? "*")") }
        return CUOwnInputToken(pid: targetId == nil ? nil : 7, counted: true)
    }
    func ownInputEnded(_ token: CUOwnInputToken) {
        lock.withLock { ownInput.append("end:\(token.counted ? "x" : "-")") }
    }
}

final class WatchShellTests: XCTestCase {
    private func decode<T: Decodable>(_ t: T.Type, _ v: AnyEncodable) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(v))
    }

    func testTheWatchMethodsExistOnlyWithAWatcherAndReachIt() async throws {
        let bare = await Rig()
        XCTAssertFalse(bare.dispatcher.methods.contains("watch.arm"))
        let watches = FakeWatches()
        let rig = await Rig(watches: watches)
        XCTAssertTrue(rig.dispatcher.methods.contains("watch.arm"))
        XCTAssertTrue(rig.dispatcher.methods.contains("watch.cancel"))
        XCTAssertFalse(rig.dispatcher.methods.contains("test.userClick"), "never on an ordinary helper")
        let r = try await rig.dispatcher.handle(
            method: "watch.arm",
            params: json(#"{"targetId":"t3","watchId":"wk_0123456789ab","condition":{"kind":"clicked","ref":12},"expiresAt":1760000000000}"#),
            context: RequestContext(connectionID: 9, client: .daemon))
        XCTAssertEqual(try decode(WatchArmResult.self, r), watches.answer)
        XCTAssertEqual(watches.armed.first?.connection, 9, "the arming connection is the watch's owner")
        XCTAssertEqual(watches.armed.first?.params,
                       WatchArmParams(targetId: "t3", watchId: "wk_0123456789ab", condition: CUWatchConditionWire(kind: "clicked", ref: 12),
                                      expiresAt: 1_760_000_000_000))
        _ = try await rig.dispatcher.handle(method: "watch.cancel", params: json(#"{"watchId":"wk_0123456789ab"}"#))
        XCTAssertEqual(watches.cancelled, ["wk_0123456789ab"])
        rig.dispatcher.connectionClosed(9)
        XCTAssertEqual(watches.closedConnections, [9])
    }

    func testAnArmRefusalReachesTheDaemonAsItsTypedError() async throws {
        let watches = FakeWatches()
        watches.armError = CUError.notAllowed("already_met", "\u{201C}Saved\u{201D} is already shown in Mail — nothing to wait for; check state()")
        let rig = await Rig(watches: watches)
        do {
            _ = try await rig.dispatcher.handle(method: "watch.arm",
                                                params: json(#"{"targetId":"t1","watchId":"wk_1","condition":{"kind":"appeared","text":"Saved"}}"#))
            XCTFail("armed")
        } catch {
            let e = RPCError.from(error)
            XCTAssertEqual(e.code, "not_allowed")
            XCTAssertEqual(e.data["reason"], .string("already_met"))
        }
    }

    func testEveryRequestThatCanSendInputIsWintersOwnWhileItRuns() async throws {
        let watches = FakeWatches()
        let rig = await Rig(watches: watches)
        for sample in engineSamples { rig.core.results[sample.method] = json(sample.result) }
        for method in ["target.act", "target.applescript", "target.foreground", "target.useWindow", "target.bind", "apps.openDocument"] {
            let sample = try XCTUnwrap(engineSamples.first { $0.method == method }, method)
            _ = try await rig.dispatcher.handle(method: method, params: json(sample.params))
        }
        XCTAssertEqual(watches.ownInput, [
            "begin:t1", "end:x", "begin:t1", "end:x", "begin:t1", "end:x", "begin:t1", "end:x",
            "begin:*", "end:x", "begin:*", "end:x",
        ], "one app's input around a target's request; every app's around a bind or an open")
        // A read is no input.
        let snap = try XCTUnwrap(engineSamples.first { $0.method == "target.snapshot" })
        _ = try await rig.dispatcher.handle(method: "target.snapshot", params: json(snap.params))
        XCTAssertEqual(watches.ownInput.count, 12)
    }

    func testAFailedActIsStillCountedAndEnded() async throws {
        let watches = FakeWatches()
        let rig = await Rig(watches: watches)
        rig.core.errors["target.act"] = CUError.refused(.secureField, "no")
        let sample = try XCTUnwrap(engineSamples.first { $0.method == "target.act" })
        do { _ = try await rig.dispatcher.handle(method: "target.act", params: json(sample.params)) } catch {}
        XCTAssertEqual(watches.ownInput, ["begin:t1", "end:x"])
    }

    func testTheLiveTestClickExistsOnlyOnALiveTestInstanceWithWatches() async throws {
        let clicks = ClickLog()
        let rig = await Rig(watches: FakeWatches(), liveTest: true, userClicker: { p in
            await clicks.add(p)
            return TestUserClickResult(clicked: true)
        })
        XCTAssertTrue(rig.dispatcher.methods.contains("test.userClick"))
        let r = try await rig.dispatcher.handle(method: "test.userClick", params: json(#"{"pid":4242,"name":"Submit"}"#))
        XCTAssertEqual(try decode(TestUserClickResult.self, r), TestUserClickResult(clicked: true))
        let asked = await clicks.params
        XCTAssertEqual(asked, [TestUserClickParams(pid: 4242, name: "Submit")])
        let noWatcher = await Rig(liveTest: true)
        XCTAssertFalse(noWatcher.dispatcher.methods.contains("test.userClick"))
    }

    func testTheTestClickIsStampedAsTheUsersOrAsWintersOwn() {
        XCTAssertEqual(TestUserClicker.stamp(TestUserClickParams(pid: 1, name: "x")), CUWatchTestStamp.value)
        XCTAssertEqual(TestUserClicker.stamp(TestUserClickParams(pid: 1, name: "x", stamp: "user")), CUWatchTestStamp.value)
        XCTAssertEqual(TestUserClicker.stamp(TestUserClickParams(pid: 1, name: "x", stamp: "winter")), CUWatchTestStamp.winterOwn)
        XCTAssertNotEqual(CUWatchTestStamp.value, CUWatchTestStamp.winterOwn)
    }

    func testAWatchEventIsTheDaemonsNotification() {
        let fired = HelperNotification.watchEvent(CUWatchEvent(watchId: "wk_1", outcome: .fired, at: 1_760_000_000_123.4, detail: "clicked"))
        XCTAssertEqual(fired.method, "watchEvent")
        XCTAssertEqual(fired.params, .object(["watchId": .string("wk_1"), "outcome": .string("fired"), "at": .number(1_760_000_000_123),
                                              "detail": .string("clicked")]))
        let lost = HelperNotification.watchEvent(CUWatchEvent(watchId: "wk_2", outcome: .lost, at: 5, reason: "the app quit"))
        XCTAssertEqual(lost.params, .object(["watchId": .string("wk_2"), "outcome": .string("lost"), "at": .number(5),
                                             "reason": .string("the app quit")]))
    }

    @MainActor func testAnArmedWatchKeepsTheHelperUpEvenWithNothingBound() {
        let clock = FakeIdleScheduler()
        let rig = Rig()
        var quits = 0
        rig.coordinator.attach(idleTimer: IdleQuitTimer(interval: 600, scheduler: clock) { quits += 1 })
        rig.coordinator.setArmedWatches(1)
        // The script's binding goes (a reset, the worker's idle end): the watch still holds the helper.
        rig.coordinator.targetBound(sessionId: "s_1", pid: 10, windowID: 20, appName: "Mail", mirror: false)
        rig.coordinator.sessionEnded(sessionId: "s_1")
        clock.advance(by: 8 * 3600)
        XCTAssertEqual(quits, 0, "an armed watch waits up to 8 h with the helper up")
        rig.coordinator.setArmedWatches(0)
        clock.advance(by: 599)
        XCTAssertEqual(quits, 0)
        clock.advance(by: 1)
        XCTAssertEqual(quits, 1, "ten minutes after the last watch ended")
    }

    @MainActor func testTheCoordinatorSendsWatchEventsAndDrawsTheRings() {
        let rig = Rig()
        rig.coordinator.watchEvent(CUWatchEvent(watchId: "wk_1", outcome: .fired, at: 1, detail: "clicked"))
        XCTAssertEqual(rig.notifications, [.watchEvent(CUWatchEvent(watchId: "wk_1", outcome: .fired, at: 1, detail: "clicked"))])
        let window = CGRect(x: 0, y: 0, width: 300, height: 200)
        rig.coordinator.showWatches([CUWatchShown(watchId: "wk_1", kind: "clicked", label: "Send", elementFrame: CGRect(x: 1, y: 1, width: 9, height: 9),
                                                  windowFrame: window)])
        XCTAssertEqual(rig.rings.shown.last, [CUWatchRing(watchId: "wk_1", kind: "clicked", label: "Send",
                                                          elementFrame: CGRect(x: 1, y: 1, width: 9, height: 9), windowFrame: window)])
    }
}

actor ClickLog {
    var params: [TestUserClickParams] = []
    func add(_ p: TestUserClickParams) { params.append(p) }
}
