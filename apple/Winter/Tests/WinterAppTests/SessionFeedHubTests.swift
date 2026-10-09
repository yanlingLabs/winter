import XCTest
import Combine
import AppKit
import WinterProtocol
import WinterKit
@testable import Winter

/// One feed per session however many surfaces show it (`SessionFeedHub`): a second surface on a session joins the
/// first's feed instead of opening a harness of its own, every event is decoded and folded once, and the socket closes
/// when the LAST surface lets go — not when either does.
@MainActor
final class SessionFeedHubTests: XCTestCase {
    // MARK: - Rig

    /// What the hub's factory made, in order: the feed, the model it folds into, and the connection it speaks on.
    private struct Made {
        let sessionId: String
        let feed: SessionFeed
        let session: SessionModel
        let transport: FeedScriptedTransport
    }

    @MainActor
    private final class Rig {
        var made: [Made] = []
        lazy var hub = SessionFeedHub { [unowned self] sessionId in
            let t = FeedScriptedTransport()
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: sessionId), session: session)
            self.made.append(Made(sessionId: sessionId, feed: feed, session: session, transport: t))
            return (feed, session)
        }
        func made(for sessionId: String) -> [Made] { made.filter { $0.sessionId == sessionId } }
    }

    /// Hello, then the attach the feed asks for — both answered, each by its METHOD: a surface's own wiring may put a
    /// request of its own on the connection between them.
    private func answerHandshake(_ t: FeedScriptedTransport, lastSeq: Int = 0) async {
        func request(_ method: String) -> [String: Any]? {
            t.sent.map { feedLineJSON($0) }.first { $0["method"] as? String == method }
        }
        await feedWaitUntil { request("protocol.hello") != nil }
        if let hello = request("protocol.hello") {
            t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        }
        await feedWaitUntil { request("session.attach") != nil }
        if let attach = request("session.attach") {
            t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":\#(lastSeq)}}"#)
        }
    }

    private func methods(_ t: FeedScriptedTransport) -> [String] { t.sent.compactMap { feedLineJSON($0)["method"] as? String } }

    private func turnStarted(_ sessionId: String, seq: Int = 1) -> String {
        #"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"threadId":"main"}}"#
    }

    private func panelOpened(_ sessionId: String, tabId: String, seq: Int) -> String {
        #"{"jsonrpc":"2.0","method":"event","params":{"type":"panel_tab_opened","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)","kind":"web","url":null,"title":null}}"#
    }

    // MARK: - Sharing

    func testTwoSurfacesOnOneSessionShareOneFeedAndOneAttach() async throws {
        let rig = Rig()
        let first = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let second = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { first.release(); second.release() }

        XCTAssertEqual(rig.made.count, 1, "the second surface opened no harness of its own")
        XCTAssertTrue(first.feed === second.feed)
        XCTAssertTrue(first.session === second.session)
        XCTAssertEqual(rig.hub.liveFeedCount, 1)
        XCTAssertEqual(rig.hub.holders(of: "S1"), 2)

        let t = rig.made[0].transport
        await answerHandshake(t)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(methods(t), ["protocol.hello", "session.attach"], "one connection, one attach: \(t.sent)")
    }

    func testADifferentSessionGetsItsOwnFeed() async throws {
        let rig = Rig()
        let a = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let b = try XCTUnwrap(rig.hub.lease(sessionId: "S2"))
        defer { a.release(); b.release() }
        XCTAssertEqual(rig.made.count, 2)
        XCTAssertFalse(a.feed === b.feed)
        XCTAssertEqual(rig.hub.liveFeedCount, 2)
    }

    func testAnEventIsFoldedOnceWhoeverIsLookingAtIt() async throws {
        let rig = Rig()
        let pill = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let window = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { pill.release(); window.release() }
        // The window keeps a model of its own that follows the shared one, as a detached window's does.
        let windowModel = SessionModel()
        windowModel.follow(window.session)

        var upstreamPublishes = 0, upstreamEvents = 0, followerEvents = 0, tapped = 0
        let watch = pill.session.$state.dropFirst().sink { _ in upstreamPublishes += 1 }
        let eventsWatch = pill.session.events.sink { _ in upstreamEvents += 1 }
        let followerWatch = windowModel.events.sink { _ in followerEvents += 1 }
        window.onEvent = { event in if case .session(let e) = event, e.sessionId == "S1" { tapped += 1 } }
        defer { watch.cancel(); eventsWatch.cancel(); followerWatch.cancel() }

        let t = rig.made[0].transport
        await answerHandshake(t)
        await feedWaitUntil { pill.session.state.status != .disconnected }
        upstreamPublishes = 0; upstreamEvents = 0; followerEvents = 0; tapped = 0

        // A user message: one publish from the fold (a turn_started also rolls the working verb, a second).
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"user_message","seq":1,"sessionId":"S1","ts":0,"threadId":"main","text":"hi","clientName":"cli"}}"#)
        await feedWaitUntil { windowModel.state.exchanges.count == 1 }
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(pill.session.state.exchanges.count, 1)
        XCTAssertEqual(windowModel.state.exchanges.count, 1, "the window's own model shows it")
        XCTAssertEqual(upstreamPublishes, 1, "the shared model folded the event once")
        XCTAssertEqual(upstreamEvents, 1)
        XCTAssertEqual(followerEvents, 1, "and the window's model was handed it, not given a second fold")
        XCTAssertEqual(tapped, 1, "the window's tap on the feed saw it once")
        XCTAssertEqual(t.sent.filter { feedLineJSON($0)["method"] as? String == "session.attach" }.count, 1)
    }

    // MARK: - Teardown

    func testTheFeedStaysUpUntilTheLastSurfaceLetsGo() async throws {
        let rig = Rig()
        let pill = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let window = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let t = rig.made[0].transport
        await answerHandshake(t)
        await feedWaitUntil { window.session.state.status != .disconnected }

        pill.release()
        XCTAssertEqual(rig.hub.holders(of: "S1"), 1)
        XCTAssertFalse(window.feed.isStopped, "the pill closing took the window's feed with it")
        t.feed(turnStarted("S1"))
        await feedWaitUntil { window.session.state.turnRunning }
        XCTAssertTrue(window.session.state.turnRunning, "the window still gets its events")

        window.release()
        XCTAssertTrue(rig.made[0].feed.isStopped, "the last surface letting go stops it")
        XCTAssertEqual(rig.hub.liveFeedCount, 0)
        XCTAssertEqual(rig.hub.holders(of: "S1"), 0)

        // …and the session can be taken again: a fresh feed.
        let again = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { again.release() }
        XCTAssertEqual(rig.made.count, 2)
        XCTAssertFalse(again.feed === rig.made[0].feed)
    }

    func testEitherSurfaceMayLetGoFirst() async throws {
        let rig = Rig()
        let a = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let b = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        a.release()
        XCTAssertFalse(b.feed.isStopped)
        b.release()
        XCTAssertTrue(rig.made[0].feed.isStopped)
        // A lease released twice counts once.
        let c = try XCTUnwrap(rig.hub.lease(sessionId: "S2"))
        let d = try XCTUnwrap(rig.hub.lease(sessionId: "S2"))
        c.release(); c.release()
        XCTAssertEqual(rig.hub.holders(of: "S2"), 1)
        XCTAssertFalse(d.feed.isStopped)
        d.release()
    }

    func testAReleasedSurfacesTapsGoWithIt() async throws {
        let rig = Rig()
        let a = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let b = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { b.release() }
        var aSaw = 0, bSaw = 0
        a.onEvent = { _ in aSaw += 1 }
        b.onEvent = { _ in bSaw += 1 }
        let t = rig.made[0].transport
        await answerHandshake(t)
        await feedWaitUntil { b.session.state.status != .disconnected }

        t.feed(turnStarted("S1", seq: 1))
        await feedWaitUntil { aSaw > 0 && bSaw > 0 }
        a.release()
        let aBefore = aSaw
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_completed","seq":2,"sessionId":"S1","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}}"#)
        await feedWaitUntil { !b.session.state.turnRunning }
        XCTAssertEqual(aSaw, aBefore, "a released surface's tap hears nothing more")
        XCTAssertGreaterThan(bSaw, 1, "the other surface's still does")
    }

    func testAFeedThatCannotBeMadeLeasesNothing() {
        let hub = SessionFeedHub { _ in nil }
        XCTAssertNil(hub.lease(sessionId: "S1"))
        XCTAssertEqual(hub.liveFeedCount, 0)
    }

    // MARK: - Joining a feed that is already up

    func testASurfaceJoiningAFeedThatIsAlreadyAttachedIsToldSo() async throws {
        let rig = Rig()
        let first = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { first.release() }
        await answerHandshake(rig.made[0].transport, lastSeq: 7)
        await feedWaitUntil { first.session.state.status != .disconnected }

        let late = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { late.release() }
        var connected = 0
        var attach: (String, Int?)?
        late.onConnected = { connected += 1 }
        late.onAttach = { attach = ($0, $1) }
        await feedWaitUntil { connected > 0 && attach != nil }

        XCTAssertEqual(connected, 1, "told the feed is connected, once")
        XCTAssertEqual(attach?.0, "S1")
        XCTAssertNil(attach?.1, "no replay is coming for a surface that joins late: nil")
    }

    func testASurfaceThatJoinsFirstHearsTheRealAttachCeiling() async throws {
        let rig = Rig()
        let lease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { lease.release() }
        var attaches: [Int?] = []
        var connected = 0
        lease.onAttach = { _, ceiling in attaches.append(ceiling) }
        lease.onConnected = { connected += 1 }
        await answerHandshake(rig.made[0].transport, lastSeq: 42)
        await feedWaitUntil { connected > 0 }
        XCTAssertEqual(attaches, [42])
        XCTAssertEqual(connected, 1)
    }

    // MARK: - Moving between sessions (the shell's hop, a window's switch in place)

    func testMovingTheOnlyHolderRePinsTheSameFeedOnTheSameSocket() async throws {
        let rig = Rig()
        let lease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { lease.release() }
        let t = rig.made[0].transport
        await answerHandshake(t)
        await feedWaitUntil { lease.session.state.status != .disconnected }
        let feedBefore = lease.feed

        let attached = lease.move(to: "S2")
        XCTAssertEqual(lease.sessionId, "S2", "the lease is on S2 the moment move returns")
        XCTAssertTrue(lease.feed === feedBefore, "the same feed goes along")
        XCTAssertEqual(rig.hub.holders(of: "S1"), 0)
        XCTAssertEqual(rig.hub.holders(of: "S2"), 1)
        XCTAssertEqual(rig.hub.liveFeedCount, 1)

        await feedWaitUntil { t.sent.count >= 3 }
        let second = feedLineJSON(t.sent[2])
        XCTAssertEqual(second["method"] as? String, "session.attach")
        XCTAssertEqual((second["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        t.feed(#"{"jsonrpc":"2.0","id":\#(second["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await attached.value
        XCTAssertEqual(methods(t), ["protocol.hello", "session.attach", "session.attach"], "a hop is one attach on the same socket")
        XCTAssertEqual(rig.made.count, 1)
    }

    func testMovingOffASessionOthersStillHoldLeavesItsFeedBe() async throws {
        let rig = Rig()
        let staying = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let moving = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { staying.release(); moving.release() }
        await answerHandshake(rig.made[0].transport)
        await feedWaitUntil { staying.session.state.status != .disconnected }

        moving.move(to: "S2")
        XCTAssertEqual(rig.made.count, 2, "S2 gets a feed of its own")
        XCTAssertFalse(moving.feed === staying.feed)
        XCTAssertEqual(moving.feed.pinnedSessionId, "S2")
        XCTAssertEqual(staying.feed.pinnedSessionId, "S1")
        XCTAssertFalse(rig.made[0].feed.isStopped, "the surface left behind keeps its feed")
        XCTAssertEqual(rig.made[0].transport.sent.count, 2, "and nothing was re-attached on it")
        XCTAssertEqual(rig.hub.holders(of: "S1"), 1)
        XCTAssertEqual(rig.hub.holders(of: "S2"), 1)
    }

    func testMovingOntoASessionThatIsAlreadyOpenJoinsItsFeed() async throws {
        let rig = Rig()
        let moving = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let there = try XCTUnwrap(rig.hub.lease(sessionId: "S2"))
        defer { there.release() }
        await answerHandshake(rig.made(for: "S1")[0].transport)
        await answerHandshake(rig.made(for: "S2")[0].transport)
        await feedWaitUntil { there.session.state.status != .disconnected }

        let attached = moving.move(to: "S2")
        XCTAssertTrue(moving.feed === there.feed, "the session is already on screen: one feed")
        XCTAssertTrue(rig.made(for: "S1")[0].feed.isStopped, "and nobody held the one it left")
        XCTAssertEqual(rig.hub.holders(of: "S2"), 2)
        XCTAssertEqual(rig.hub.liveFeedCount, 1)
        await attached.value // already attached: returns at once
        moving.release()
        XCTAssertEqual(rig.hub.holders(of: "S2"), 1)
        XCTAssertFalse(there.feed.isStopped)
    }

    func testTapsFollowALeaseOntoItsNewFeed() async throws {
        let rig = Rig()
        let moving = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let staying = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { staying.release(); moving.release() }
        var heard: [String] = []
        moving.onEvent = { event in if case .session(let e) = event { heard.append(e.sessionId) } }
        await answerHandshake(rig.made[0].transport)
        await feedWaitUntil { staying.session.state.status != .disconnected }
        moving.move(to: "S2")
        let t2 = rig.made(for: "S2")[0].transport
        await answerHandshake(t2)
        await feedWaitUntil { moving.session.state.status != .disconnected }

        t2.feed(turnStarted("S2"))
        await feedWaitUntil { heard.contains("S2") }
        XCTAssertTrue(heard.contains("S2"), "the surface's tap is on the feed it moved to")
        rig.made[0].transport.feed(turnStarted("S1", seq: 2))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(heard.contains("S1"), "and not on the one it left")
    }

    // MARK: - A standalone lease (a surface's own feed)

    func testAStandaloneLeaseStartsAndStopsItsOwnFeed() async throws {
        let t = FeedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let lease = SessionFeedLease(standalone: feed, session: session)
        XCTAssertFalse(lease.isShared)
        XCTAssertEqual(lease.sessionId, "S1")
        lease.begin()
        lease.begin() // idempotent
        await answerHandshake(t)
        await feedWaitUntil { session.state.status != .disconnected }
        XCTAssertEqual(methods(t), ["protocol.hello", "session.attach"])

        lease.move(to: "S2")
        XCTAssertEqual(lease.sessionId, "S2")
        await feedWaitUntil { t.sent.count >= 3 }
        XCTAssertEqual((feedLineJSON(t.sent[2])["params"] as? [String: Any])?["sessionId"] as? String, "S2")

        lease.release()
        XCTAssertTrue(feed.isStopped)
    }

    // MARK: - Following

    func testAFollowingModelShowsTheUpstreamsStateAndRelaysItsEvents() async throws {
        let upstream = SessionModel()
        let follower = SessionModel()
        follower.follow(upstream)
        var events = 0
        let watch = follower.events.sink { _ in events += 1 }
        defer { watch.cancel() }

        upstream.apply(try decode(#"{"type":"user_message","seq":1,"sessionId":"S1","ts":0,"threadId":"main","text":"hi","clientName":"cli"}"#))
        upstream.apply(try decode(#"{"type":"turn_started","seq":2,"sessionId":"S1","ts":0,"threadId":"main"}"#))
        XCTAssertTrue(follower.state.turnRunning)
        XCTAssertEqual(follower.state.exchanges.first?.prompt, "hi")
        XCTAssertEqual(events, 2)
        XCTAssertTrue(follower.liveThinking === upstream.liveThinking, "one buffer of live reasoning, not a copy")

        upstream.isLoadingHistory = true
        XCTAssertTrue(follower.isLoadingHistory)

        follower.stopFollowing()
        upstream.apply(try decode(#"{"type":"turn_completed","seq":3,"sessionId":"S1","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#))
        XCTAssertTrue(follower.state.turnRunning, "an unfollowed model keeps what it last showed")
    }

    func testFollowingAnotherModelEmptiesFirstAndTakesItsStateOneTurnLater() async throws {
        let a = SessionModel(), b = SessionModel()
        a.apply(try decode(#"{"type":"user_message","seq":1,"sessionId":"A","ts":0,"threadId":"main","text":"from a","clientName":"cli"}"#))
        b.apply(try decode(#"{"type":"user_message","seq":1,"sessionId":"B","ts":0,"threadId":"main","text":"from b","clientName":"cli"}"#))
        let surface = SessionModel()
        surface.follow(a)
        XCTAssertEqual(surface.state.exchanges.first?.prompt, "from a", "a first follow takes the state at once")

        var counts: [Int] = []
        let watch = surface.$state.map(\.exchanges.count).sink { counts.append($0) }
        defer { watch.cancel() }
        surface.follow(b, resetting: true)
        XCTAssertTrue(surface.state.exchanges.isEmpty, "emptied first — the transcript's landing logic keys on a count that falls to zero")
        XCTAssertTrue(surface.isLoadingHistory)
        await feedWaitUntil { surface.state.exchanges.first?.prompt == "from b" }
        XCTAssertEqual(surface.state.exchanges.first?.prompt, "from b")
        XCTAssertEqual(counts, [1, 0, 1], "one, then none, then the new session's one")

        // …and it follows b now, not a.
        a.apply(try decode(#"{"type":"turn_started","seq":2,"sessionId":"A","ts":0,"threadId":"main"}"#))
        XCTAssertFalse(surface.state.turnRunning)
        b.apply(try decode(#"{"type":"turn_started","seq":2,"sessionId":"B","ts":0,"threadId":"main"}"#))
        XCTAssertTrue(surface.state.turnRunning)
    }

    func testAModelCannotFollowItself() {
        let m = SessionModel()
        m.follow(m)
        XCTAssertNil(m.following)
    }

    private func decode(_ json: String) throws -> SessionEvent {
        try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    // MARK: - The surfaces, on one shared feed

    /// The case this exists for: a child session's pill (its plume) and a detached window on the same child. Closing
    /// the window leaves the pill's feed running; the pill letting go then stops it.
    func testADetachedWindowAndAPillOnTheSameSessionShareOneFeed() async throws {
        let rig = Rig()
        let pillLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let windowLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let windowModel = SessionModel()
        windowModel.follow(windowLease.session)
        let controller = DetachedWindowController(lease: windowLease, session: windowModel,
                                                  frame: NSRect(x: 100, y: 100, width: 600, height: 400), title: "child")
        controller.show()
        defer { controller.close(); pillLease.release() }

        XCTAssertEqual(rig.made.count, 1, "the window opened on the pill's feed")
        let t = rig.made[0].transport
        await answerHandshake(t)
        await feedWaitUntil { windowModel.state.status != .disconnected }
        t.feed(turnStarted("S1"))
        await feedWaitUntil { windowModel.state.turnRunning && pillLease.session.state.turnRunning }
        XCTAssertTrue(windowModel.state.turnRunning)
        XCTAssertTrue(pillLease.session.state.turnRunning)
        XCTAssertEqual(methods(t).filter { $0 == "session.attach" }.count, 1, "one attach for both surfaces: \(t.sent)")

        controller.close()
        XCTAssertEqual(rig.hub.holders(of: "S1"), 1, "the window's hold is gone")
        XCTAssertFalse(pillLease.feed.isStopped, "closing the window did not stop the pill's feed")
        pillLease.release()
        XCTAssertTrue(rig.made[0].feed.isStopped, "the pill was the last")
    }

    /// The same, from the other side: the window is the one left holding it.
    func testThePillLettingGoLeavesTheWindowsFeedRunning() async throws {
        let rig = Rig()
        let pillLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let windowLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let windowModel = SessionModel()
        windowModel.follow(windowLease.session)
        let controller = DetachedWindowController(lease: windowLease, session: windowModel,
                                                  frame: NSRect(x: 100, y: 100, width: 600, height: 400), title: "child")
        controller.show()
        defer { controller.close() }
        await answerHandshake(rig.made[0].transport)
        pillLease.release()
        XCTAssertFalse(rig.made[0].feed.isStopped)
        controller.close()
        XCTAssertTrue(rig.made[0].feed.isStopped)
        XCTAssertEqual(rig.hub.liveFeedCount, 0)
    }

    /// The shell on a session a detached window also shows: one feed between them; the shell hiding does not close the
    /// window's, and the window closing does not detach the shell.
    func testTheShellAndADetachedWindowOnOneSessionShareAFeed() async throws {
        let rig = Rig()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, hub: rig.hub)

        let windowLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let windowModel = SessionModel()
        windowModel.follow(windowLease.session)
        let controller = DetachedWindowController(lease: windowLease, session: windowModel,
                                                  frame: NSRect(x: 100, y: 100, width: 600, height: 400), title: "w")
        controller.show()
        defer { controller.close() }

        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(rig.made.count, 1, "the shell joined the window's feed")
        XCTAssertEqual(rig.hub.holders(of: "S1"), 2)
        XCTAssertEqual(host.attachment?.feed.pinnedSessionId, "S1")

        await answerHandshake(rig.made[0].transport)
        await feedWaitUntil { host.attachment?.session.state.status != .disconnected }
        rig.made[0].transport.feed(turnStarted("S1"))
        await feedWaitUntil { windowModel.state.turnRunning && host.attachment?.session.state.turnRunning == true }
        XCTAssertTrue(windowModel.state.turnRunning)
        XCTAssertTrue(host.attachment?.session.state.turnRunning ?? false, "the shell's model shows it too")

        host.setShellVisible(false) // the shell detaches
        XCTAssertNil(host.attachedSessionId)
        XCTAssertEqual(rig.hub.holders(of: "S1"), 1)
        XCTAssertFalse(rig.made[0].feed.isStopped, "the window's feed is still up")
        controller.close()
        XCTAssertTrue(rig.made[0].feed.isStopped)
    }

    /// The shell hopping off a session a detached window also shows leaves the window's feed alone.
    func testTheShellHoppingOffASharedSessionLeavesTheWindowsFeedAlone() async throws {
        let rig = Rig()
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, hub: rig.hub)
        let windowLease = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { windowLease.release() }

        host.setShellVisible(true)
        host.select("S1")
        await answerHandshake(rig.made[0].transport)
        host.select("S2") // a hop: S1 is held by the window too, so the shell gets a feed of its own onto S2
        XCTAssertEqual(rig.made.count, 2)
        XCTAssertEqual(rig.hub.holders(of: "S1"), 1)
        XCTAssertEqual(rig.hub.holders(of: "S2"), 1)
        XCTAssertFalse(rig.made[0].feed.isStopped)
        XCTAssertEqual(host.attachedSessionId, "S2")
        XCTAssertEqual(host.attachment?.feed.pinnedSessionId, "S2")
        XCTAssertTrue(host.attachment?.session.following === rig.made[1].session, "its model follows S2's")
        host.setShellVisible(false)
    }
    // MARK: - Joining a feed that is already attached

    /// A lease says whether the feed it landed on was already attached — the surfaces that were there first got the
    /// replay, a later joiner's taps hear only what comes after.
    func testALeaseKnowsWhetherItJoinedAFeedThatWasAlreadyAttached() async throws {
        let rig = Rig()
        let first = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        let early = try XCTUnwrap(rig.hub.lease(sessionId: "S1")) // before the attach answers: its taps hear the replay
        XCTAssertFalse(first.joinedAttachedFeed)
        XCTAssertFalse(early.joinedAttachedFeed)

        await answerHandshake(rig.made[0].transport)
        await feedWaitUntil { rig.made[0].feed.isAttached }
        let late = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        XCTAssertTrue(late.joinedAttachedFeed, "the replay is over for the feed it joined")

        // A move onto an attached session joins it; a re-pin of the only holder's own feed does not.
        let mover = try XCTUnwrap(rig.hub.lease(sessionId: "S9"))
        mover.move(to: "S1")
        XCTAssertTrue(mover.joinedAttachedFeed)
        let solo = try XCTUnwrap(rig.hub.lease(sessionId: "S5"))
        solo.move(to: "S6")
        XCTAssertFalse(solo.joinedAttachedFeed, "its feed re-attaches: the replay comes to it")
        for lease in [first, early, late, mover, solo] { lease.release() }
    }

    /// The shell joining a session another surface already shows has no replay to rebuild its panel tabs from: they
    /// are `panel.list`'s snapshot, and a tab opened live before the answer is folded on top of it, not instead of it.
    func testAShellJoiningAnAttachedFeedTakesItsPanelTabsFromTheSnapshotPlusTheLiveTail() async throws {
        let rig = Rig()
        let mgmt = ShellScriptedTransport()
        let client = WinterClient(makeTransport: { mgmt }, token: "tok", clientName: "orb")
        let connecting = Task { try? await client.connect() }
        await feedWaitUntil { mgmt.sent.count >= 1 }
        let hello = feedLineJSON(mgmt.sent[0])
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await connecting.value

        let holder = try XCTUnwrap(rig.hub.lease(sessionId: "S1"))
        defer { holder.release() }
        await answerHandshake(rig.made[0].transport)
        await feedWaitUntil { rig.made[0].feed.isAttached }

        let host = ShellSessionHost(directory: SessionDirectory(lister: { [] }), hub: rig.hub, managementClient: client)
        defer { host.setShellVisible(false) }
        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(rig.made.count, 1, "the shell joined the holder's feed")

        // A tab is opened live before panel.list answers.
        rig.made[0].transport.feed(panelOpened("S1", tabId: "live", seq: 1))
        await feedWaitUntil { host.panelStore.tabs.map(\.tabId) == ["live"] }
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        let request = try XCTUnwrap(mgmt.sent.map { feedLineJSON($0) }.first { $0["method"] as? String == "panel.list" })
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(request["id"] as! Int),"result":{"tabs":[{"tabId":"snap","kind":"web","url":null,"title":null}],"activeTabId":"snap"}}"#)
        await feedWaitUntil { host.panelStore.tabs.count == 2 }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["snap", "live"])
    }
}
