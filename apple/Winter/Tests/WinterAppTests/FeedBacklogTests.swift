import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// A hang report once said "attachedSessions=3 … reducerBacklog=1 oldestEventAge=4886.0 s": one event "waiting" for 81
/// minutes, the count never growing. Nothing was waiting. A deliberate `close()` finishes the client's stream and
/// the transport's `.closed` then arrives, which the pump turned into a `.connection(.disconnected)` yielded onto the
/// finished stream and counted for good; and a stopped feed that a closed window or a released lease still held went
/// on reporting its session as attached and that count as a backlog. These pin that a hang report tells the truth.
@MainActor
final class FeedBacklogTests: XCTestCase {
    /// A feed's `start()` on its own task, with a flag for "it returned": a test waits on the flag and FAILS when the
    /// feed never returns, where a wait on the task itself would last as long as the feed kept retrying. The task is
    /// cancelled when the test ends, so a feed that does not stop on its own cannot outlive it.
    private final class Started {
        private(set) var returned = false
        private(set) var task: Task<Void, Never>?
        func begin(_ feed: SessionFeed) {
            task = Task { @MainActor [self] in
                await feed.start()
                returned = true
            }
        }
        deinit { task?.cancel() }
    }

    private func sessionCreated(_ n: Int) -> String {
        #"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":\#(n),"sessionId":"S\#(n)","ts":5,"scope":"global"}}"#
    }

    private func waitFor(_ t: FeedScriptedTransport, sent n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    /// A pinned feed over a scripted transport, connected and attached (the attach answered).
    private func attachedFeed(sessionId: String, transport t: FeedScriptedTransport) async -> (SessionFeed, Started) {
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "test", mode: .pinned(sessionId: sessionId), session: SessionModel())
        let started = Started()
        started.begin(feed)
        await waitFor(t, sent: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(feedLineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitFor(t, sent: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(feedLineJSON(t.sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await feedWaitUntil { feed.isConnected }
        return (feed, started)
    }

    private func reported(_ sessionId: String) -> FeedDiagnostics? {
        FeedRegistry.shared.snapshot.first { $0.sessionId == sessionId }
    }

    // MARK: - A stopped feed that something still holds

    /// The incident: the feed is stopped (its window closed, its lease released) but still alive, and its client's
    /// `.disconnected` — yielded after the stream finished — was counted as waiting, aging by the second.
    func testAStoppedFeedThatIsStillHeldLeavesTheHangReport() async throws {
        let t = FeedScriptedTransport()
        let (feed, started) = await attachedFeed(sessionId: "s_stopped_held", transport: t)
        XCTAssertNotNil(reported("s_stopped_held"), "a live feed is in the report")

        feed.stop()
        await feedWaitUntil { started.returned }
        XCTAssertTrue(started.returned, "stop() did not end the feed's start()")
        try await Task.sleep(nanoseconds: 300_000_000) // the transport's `.closed` reaches the pump after `close()`

        // `feed` is still held by this test, exactly as a released lease or a closed window's controller holds it.
        XCTAssertNil(reported("s_stopped_held"), "a stopped feed is not a live feed: its session is not attached any more")
        XCTAssertEqual(feed.client.traffic.backlog, 0, "the .disconnected after the stream ended was counted as waiting")
        XCTAssertEqual(feed.client.traffic.oldestAge, 0)
        XCTAssertEqual(feed.diagnostics.backlog, 0)
        XCTAssertEqual(feed.diagnostics.oldestEventAge, 0)
        withExtendedLifetime(feed) {}
    }

    /// Events that reached the client's stream while the feed was still connecting have no reader yet. If the feed is
    /// let go then, they will never be taken — and must not be reported as a backlog.
    func testEventsLeftOnTheStreamWhenAFeedIsStoppedMidAttachAreNoBacklog() async throws {
        let t = FeedScriptedTransport()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "test", mode: .pinned(sessionId: "s_mid_attach"), session: SessionModel())
        let started = Started()
        started.begin(feed)
        await waitFor(t, sent: 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(feedLineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitFor(t, sent: 2) // the attach is on the wire, unanswered: the reader has not started
        for n in 1...3 { t.feed(sessionCreated(n)) }
        await feedWaitUntil { feed.client.traffic.backlog == 3 }
        XCTAssertEqual(reported("s_mid_attach")?.backlog, 3, "three events wait for a reader that has not started")

        feed.stop()
        XCTAssertNil(reported("s_mid_attach"))
        XCTAssertEqual(feed.client.traffic.backlog, 0)
        XCTAssertEqual(feed.diagnostics.backlog, 0)

        // The stopped feed does not go on to start a reader or mark itself connected once its attach settles.
        await feedWaitUntil { started.returned }
        XCTAssertTrue(started.returned)
        XCTAssertFalse(feed.isConnected)
        XCTAssertEqual(feed.client.traffic.backlog, 0)
        withExtendedLifetime(feed) {}
    }

    // MARK: - A feed whose reader has ended

    /// The reader ends for a reason other than `stop()` (the client closed from outside): nothing is going to take
    /// what the stream held, and the feed must not report it.
    func testAFeedWhoseReaderEndedReportsNoPhantomBacklog() async throws {
        let t = FeedScriptedTransport()
        let (feed, started) = await attachedFeed(sessionId: "s_reader_ended", transport: t)
        await feed.client.close()
        await feedWaitUntil { started.returned } // the reader ended with the stream
        XCTAssertTrue(started.returned)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(feed.client.traffic.backlog, 0)
        XCTAssertEqual(reported("s_reader_ended")?.backlog ?? 0, 0)
        XCTAssertEqual(reported("s_reader_ended")?.oldestEventAge ?? 0, 0)
        feed.stop()
        withExtendedLifetime(feed) {}
    }

    // MARK: - A feed stopped before it connected

    /// A surface that takes a hold on a session's feed and lets go within the same turn: `start()` is scheduled for the
    /// next turn and used to run after `stop()` — connecting a client nobody closes.
    func testAFeedStoppedBeforeItsStartRanNeverConnects() async throws {
        let t = FeedScriptedTransport()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "test", mode: .pinned(sessionId: "s_never_started"), session: SessionModel())
        feed.stop()
        let started = Started()
        started.begin(feed)
        await feedWaitUntil(2) { started.returned }
        XCTAssertTrue(started.returned, "a stopped feed's start() went on to connect")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(t.sent.isEmpty, "a stopped feed opened a connection: \(t.sent)")
        XCTAssertNil(reported("s_never_started"))
        withExtendedLifetime(feed) {}
    }

    /// `stop()` lands while the first connect is awaiting its hello: the feed stops retrying, whether or not its owner
    /// cancels the start task as well.
    func testAFeedStoppedWhileConnectingStopsRetrying() async throws {
        let t = FeedScriptedTransport()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "test", mode: .pinned(sessionId: "s_stopped_connecting"), session: SessionModel())
        let started = Started()
        started.begin(feed)
        await waitFor(t, sent: 1) // the hello, never answered
        feed.stop()
        await feedWaitUntil { started.returned }
        XCTAssertTrue(started.returned, "a stopped feed went on retrying its connect")
        XCTAssertEqual(t.sent.filter { feedLineJSON($0)["method"] as? String == "protocol.hello" }.count, 1,
                       "a stopped feed sent another hello: \(t.sent)")
        withExtendedLifetime(feed) {}
    }
}
