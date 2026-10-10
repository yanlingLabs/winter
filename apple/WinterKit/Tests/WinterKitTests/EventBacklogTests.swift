import XCTest
import WinterProtocol
@testable import WinterKit

/// Shaped like the real `UnixSocketTransport`: `close()` delivers `.closed` and THEN finishes the stream — which is
/// what makes the client emit a `.connection(.disconnected)` after a deliberate `close()` has already finished
/// its own event stream. (`ScriptedTransport.close()` only finishes, so it never shows this.)
final class ClosingTransport: WinterTransport, SentLineRecording, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }
    func open() async throws {}
    func send(_ data: Data) async throws {
        lock.lock(); defer { lock.unlock() }
        _sent.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
    }
    func close() { cont.yield(.closed(nil)); cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
    func feedEvent(_ json: String) { feed(#"{"jsonrpc":"2.0","method":"event","params":\#(json)}"#) }
}

/// Collects what a consumer task saw, safely from async code.
actor Collected<T: Sendable> {
    private(set) var items: [T] = []
    func add(_ item: T) { items.append(item) }
}

private func connectedClient() async throws -> (WinterClient, ClosingTransport) {
    let t = ClosingTransport()
    let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "test")
    async let connected: Void = client.connect()
    let hello = try await waitForSent(t, count: 1)[0]
    t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
    try await connected
    return (client, t)
}

private func sessionCreated(_ n: Int) -> String {
    #"{"type":"session_created","seq":\#(n),"sessionId":"s_\#(n)","ts":5,"scope":"global"}"#
}

private func eventually(timeout: TimeInterval = 3, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return await condition()
}

/// A hang report said "reducerBacklog=1 oldestEventAge=4886 s" for a feed that was merely idle (or closed): the
/// client had counted an event onto its stream that nothing would ever take off it.
final class EventBacklogTests: XCTestCase {
    // MARK: - The ledger itself

    private final class Clock: @unchecked Sendable { var t: TimeInterval = 10 }

    func testUndoTakesBackExactlyTheNoteItWasGiven() {
        let clock = Clock()
        let traffic = EventTraffic(clock: { clock.t })
        let a = traffic.noteYielded(); clock.t += 1
        let b = traffic.noteYielded(); clock.t += 1
        let c = traffic.noteYielded(); clock.t += 1
        XCTAssertNotNil(a); XCTAssertNotNil(c)
        traffic.undo(b!)
        XCTAssertEqual(traffic.backlog, 2)
        XCTAssertEqual(traffic.oldestAge, 3, accuracy: 0.001, "the first is still the oldest")
        traffic.noteConsumed()
        XCTAssertEqual(traffic.oldestAge, 1, accuracy: 0.001, "and after it the THIRD, the second was taken back")
        traffic.undo(b!)
        XCTAssertEqual(traffic.backlog, 1, "taking back a note twice, or one already gone, changes nothing")
        traffic.noteConsumed()
        traffic.undo(c!)
        XCTAssertEqual(traffic.backlog, 0, "a note the consumer has already counted off is not taken back a second time")
    }

    /// The producer notes BEFORE it yields and takes the note back when the stream refused the element; the consumer
    /// counts off what it received, from another thread. However they interleave the ledger must end at zero.
    private final class Stream: @unchecked Sendable {
        private let lock = NSLock()
        private var held = 0
        private var open = true
        func put() { lock.lock(); held += 1; lock.unlock() }
        func finish() { lock.lock(); open = false; lock.unlock() }
        /// 1 = took one, 0 = nothing now, -1 = nothing and nothing more is coming.
        func take() -> Int {
            lock.lock(); defer { lock.unlock() }
            if held > 0 { held -= 1; return 1 }
            return open ? 0 : -1
        }
    }

    func testNotesAndTakeBacksBalanceAgainstAConcurrentConsumer() {
        let traffic = EventTraffic()
        let stream = Stream()
        let finished = expectation(description: "consumer drained the stream")
        let consumer = Thread {
            while true {
                switch stream.take() {
                case 1: traffic.noteConsumed()
                case 0: Thread.sleep(forTimeInterval: 0.0001)
                default: finished.fulfill(); return
                }
            }
        }
        consumer.start()
        for n in 0..<20_000 {
            let ticket = traffic.noteYielded()
            if n % 3 == 0 { // the stream refused this one
                if let ticket { traffic.undo(ticket) }
            } else {
                stream.put()
            }
        }
        stream.finish()
        wait(for: [finished], timeout: 10)
        XCTAssertEqual(traffic.backlog, 0, "every note was counted off or taken back")
        XCTAssertEqual(traffic.oldestAge, 0)
    }

    func testRetiredTrafficForgetsEverythingAndCountsNothingMore() {
        let traffic = EventTraffic(clock: { 1 })
        for _ in 0..<5 { traffic.noteYielded() }
        XCTAssertEqual(traffic.backlog, 5)
        traffic.retire()
        XCTAssertEqual(traffic.backlog, 0)
        XCTAssertEqual(traffic.oldestAge, 0)
        XCTAssertTrue(traffic.isRetired)
        XCTAssertNil(traffic.noteYielded(), "nothing is counted once the consumer is gone")
        XCTAssertEqual(traffic.backlog, 0)
        XCTAssertEqual(traffic.noteConsumed(), 0)
    }

    // MARK: - A client's stream

    /// The shape of the report: a yield onto a stream that has already ended must not be counted as waiting.
    func testAYieldOntoAFinishedStreamIsNotCounted() async throws {
        let (client, _) = try await connectedClient()
        await client.close()
        XCTAssertEqual(client.traffic.backlog, 0)
        client.emit(.connection(.disconnected))
        client.emit(.connection(.reconnecting(attempt: 1)))
        XCTAssertEqual(client.traffic.backlog, 0, "the stream is over: nothing will ever take these")
        XCTAssertEqual(client.traffic.oldestAge, 0)
    }

    /// The same thing as it really happens: `close()` makes the transport deliver `.closed`, the pump turns it into a
    /// `.connection(.disconnected)` — after `close()` finished the stream — and used to count it forever.
    func testADeliberateCloseLeavesNothingCountedAsWaiting() async throws {
        let (client, _) = try await connectedClient()
        let seen = Collected<Int>()
        let reader = Task {
            var n = 0
            for await _ in client.events { client.traffic.noteConsumed(); n += 1; await seen.add(n) }
        }
        await client.close()
        await reader.value
        // The pump delivers `.closed` after close() returns; give it time to run (nothing observable says when).
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(client.traffic.backlog, 0, "a .disconnected yielded onto the finished stream was counted as waiting")
        XCTAssertEqual(client.traffic.oldestAge, 0)
    }

    /// A consumer whose task is cancelled ends the stream under it (`AsyncStream` cancels the whole stream, not just
    /// the one iterator), and the events it still held are left behind: they must not stay counted as waiting.
    func testAStreamCancelledUnderItsConsumerLeavesNoBacklog() async throws {
        let (client, t) = try await connectedClient()
        for n in 1...3 { t.feedEvent(sessionCreated(n)) }
        let buffered = await eventually { client.traffic.backlog == 3 }
        XCTAssertTrue(buffered)
        let consumer = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000) // returns at once: the task is cancelled below
            for await _ in client.events { return } // asks for the next element with its task cancelled
        }
        consumer.cancel()
        await consumer.value
        XCTAssertTrue(client.traffic.isRetired, "the stream was cancelled under its consumer")
        XCTAssertEqual(client.traffic.backlog, 0)
        t.feedEvent(sessionCreated(4))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(client.traffic.backlog, 0, "and nothing more is counted onto a stream that takes nothing")
    }

    // MARK: - A second reader of the client's events

    private func providerLoginProgress(_ n: Int, _ line: String) -> String {
        #"{"type":"provider_login_progress","sessionId":"$system","seq":\#(n),"ts":5,"provider":"anthropic","line":"\#(line)"}"#
    }

    private func providerLoginFinished(_ n: Int) -> String {
        #"{"type":"provider_login_finished","sessionId":"$system","seq":\#(n),"ts":5,"provider":"anthropic","ok":true}"#
    }

    /// The sign-in sheet's `loginUpdates()` used to be a second `for await` over the MAIN feed client's `events`: it
    /// took events away from the feed's reader (a transcript missing them), and cancelling it ended the stream for
    /// the reader too. Now it is a side stream: the one reader sees every event, before, during and after.
    func testLoginUpdatesIsASideStreamThatTakesNothingFromTheOneReader() async throws {
        let (client, t) = try await connectedClient()
        let readerSaw = Collected<Int>()
        let reader = Task {
            for await ev in client.events {
                client.traffic.noteConsumed()
                if case .session(let e) = ev { await readerSaw.add(e.seq) }
            }
        }
        let updates = LiveAnthropicAuthClient(client: client).loginUpdates()
        let loginSaw = Collected<String>()
        let loginTask = Task {
            for await update in updates {
                switch update {
                case .progress(let line): await loginSaw.add("progress:\(line)")
                case .finished(let ok, _): await loginSaw.add("finished:\(ok)")
                }
            }
        }
        for n in 1...3 { t.feedEvent(sessionCreated(n)) }
        t.feedEvent(providerLoginProgress(10, "Opening browser"))
        t.feedEvent(providerLoginFinished(11))
        for n in 4...6 { t.feedEvent(sessionCreated(n)) }
        let firstSix = await eventually { await readerSaw.items.count == 8 }
        let readerItems = await readerSaw.items
        XCTAssertTrue(firstSix, "the reader missed events: \(readerItems)")
        XCTAssertEqual(readerItems, [1, 2, 3, 10, 11, 4, 5, 6], "every event, in order — the login ones included")
        let loginOk = await eventually { await loginSaw.items.count == 2 }
        let loginItems = await loginSaw.items
        XCTAssertTrue(loginOk)
        XCTAssertEqual(loginItems, ["progress:Opening browser", "finished:true"])

        // The sheet is dismissed: its task is cancelled while it waits for the next update. That used to end the
        // client's whole stream.
        loginTask.cancel()
        await loginTask.value
        for n in 7...8 { t.feedEvent(sessionCreated(n)) }
        let after = await eventually { await readerSaw.items.count == 10 }
        let afterItems = await readerSaw.items
        XCTAssertTrue(after, "the reader's stream ended when the sign-in sheet closed: \(afterItems)")
        XCTAssertEqual(client.traffic.backlog, 0)

        await client.close()
        await reader.value
    }

    func testAnObserverSeesOnlyWhatItAsksForAndEndsWhenTheClientCloses() async throws {
        let (client, t) = try await connectedClient()
        let stream = client.observe { event in
            if case .session(let e) = event, e.seq % 2 == 0 { return true }
            return false
        }
        let saw = Collected<Int>()
        let observer = Task { for await ev in stream { if case .session(let e) = ev { await saw.add(e.seq) } } }
        for n in 1...6 { t.feedEvent(sessionCreated(n)) }
        let got = await eventually { await saw.items.count == 3 }
        let items = await saw.items
        XCTAssertTrue(got)
        XCTAssertEqual(items, [2, 4, 6])
        // The observer never touched the client's own stream: its six events are all still there.
        XCTAssertEqual(client.traffic.backlog, 6)
        await client.close()
        await observer.value // returns: the observer's stream ended with the client
        var lateIterator = client.observe { _ in true }.makeAsyncIterator()
        let late = await lateIterator.next()
        XCTAssertNil(late, "an observer asked for after close() is over already")
    }
}
