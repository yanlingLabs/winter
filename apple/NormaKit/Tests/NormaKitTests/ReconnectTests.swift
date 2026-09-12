import XCTest
@testable import WinterKit

final class ReconnectTests: XCTestCase {
    func testReconnectReattachesFromLastSeq() async throws {
        // factory hands out transport A, then transport B
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "rc", requestTimeout: .seconds(2))

        async let connected: Void = client.connect()
        let helloA = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloA)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        // attach and see one event at seq 6
        async let attached = client.attach(sessionId: "s_1", fromSeq: 0)
        let sentA = try await waitForSent(tA, count: 2)
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sentA[1])["id"] as! Int),"result":{"ok":true,"lastSeq":6}}"#)
        _ = try await attached
        var iter = client.events.makeAsyncIterator()
        // NOTE (amendment 1/2): connect() no longer yields .connection(.connected) — removed in
        // Task 7 because AsyncStream pre-iterator FIFO buffering made it the first value every
        // iterator observed, contradicting these tests. So there is no .connected event to skip
        // here; the first iter.next() below is the turn_started session event.
        tA.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":6,"sessionId":"s_1","ts":1,"threadId":"main"}}"#)
        guard case .session? = await iter.next() else { return XCTFail() }

        // drop A → client must reconnect via B: hello then re-attach fromSeq=6
        tA.dropConnection()
        // BRIEF BUG (adjudicated, see report): brief has `count: 2` here, but the re-attach line
        // cannot exist yet — connect() awaits the hello *response* (fed below) before returning,
        // and only then does reconnectLoop call attach(). Structurally only 1 line (hello) can be
        // sent to tB at this point; proven empirically (5s timeout stuck at 1 line). Fixed to
        // count: 1 — the second waitForSent(tB, count: 2) below (after feeding the hello
        // response) is where the re-attach line actually appears.
        let sentB = try await waitForSent(tB, count: 1, timeout: 5)
        let helloB = decodeLine(sentB[0])
        XCTAssertEqual(helloB["method"] as? String, "protocol.hello")
        tB.feed(#"{"jsonrpc":"2.0","id":\#(helloB["id"] as! Int),"result":{"ok":true}}"#)
        let reattach = decodeLine(try await waitForSent(tB, count: 2)[1])
        XCTAssertEqual(reattach["method"] as? String, "session.attach")
        XCTAssertEqual((reattach["params"] as? [String: Any])?["fromSeq"] as? Int, 6)
        tB.feed(#"{"jsonrpc":"2.0","id":\#(reattach["id"] as! Int),"result":{"ok":true,"lastSeq":6}}"#)

        // events observed: disconnected → reconnecting(1) → connected
        var states: [ConnectionState] = []
        for _ in 0..<3 {
            if case .connection(let s)? = await iter.next() { states.append(s) }
        }
        XCTAssertEqual(states.first, .disconnected)
        XCTAssertEqual(states.last, .connected)
        XCTAssertTrue(states.contains(.reconnecting(attempt: 1)))
    }

    func testDeliberateCloseDoesNotReconnect() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "rc2")
        async let connected: Void = client.connect()
        let hello = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        await client.close()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(tB.sent.isEmpty, "close() must not trigger reconnection")
    }

    /// Review fix 1 regression: a disconnect that lands WHILE reconnectLoop is already in flight
    /// (the replacement transport itself drops mid-handshake, before its hello is answered) must
    /// not spawn a second concurrent loop. Without the `reconnecting` guard, the mid-handshake
    /// drop's onDisconnected() → startReconnect() would start a duplicate loop racing the
    /// original one against the same factory-supplied transports, producing duplicate hello
    /// traffic on whichever transport both loops eventually touch.
    func testMidHandshakeDropDoesNotSpawnSecondLoop() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let tC = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB, tC])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "rc3")

        async let connected: Void = client.connect()
        let helloA = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloA)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        async let attached = client.attach(sessionId: "s_1", fromSeq: 0)
        let sentA = try await waitForSent(tA, count: 2)
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sentA[1])["id"] as! Int),"result":{"ok":true,"lastSeq":3}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()

        // drop A → reconnectLoop starts; attempt 1 draws B from the factory.
        tA.dropConnection()
        let sentB = try await waitForSent(tB, count: 1, timeout: 5)
        let helloB = decodeLine(sentB[0])
        XCTAssertEqual(helloB["method"] as? String, "protocol.hello")
        // B drops mid-handshake — its hello is never answered. This re-delivers .closed through
        // the pump while the FIRST loop is still awaiting connect(); onDisconnected() fires again
        // but must be a no-op (the `reconnecting` guard), not a second loop.
        tB.dropConnection()

        // attempt 2 draws C from the factory — answer it normally.
        let sentC1 = try await waitForSent(tC, count: 1, timeout: 5)
        let helloC = decodeLine(sentC1[0])
        XCTAssertEqual(helloC["method"] as? String, "protocol.hello")
        tC.feed(#"{"jsonrpc":"2.0","id":\#(helloC["id"] as! Int),"result":{"ok":true}}"#)
        let sentC2 = try await waitForSent(tC, count: 2, timeout: 5)
        let reattach = decodeLine(sentC2[1])
        XCTAssertEqual(reattach["method"] as? String, "session.attach")
        tC.feed(#"{"jsonrpc":"2.0","id":\#(reattach["id"] as! Int),"result":{"ok":true,"lastSeq":3}}"#)

        var lastState: ConnectionState?
        for _ in 0..<8 {
            if case .connection(let s)? = await iter.next() {
                lastState = s
                if s == .connected { break }
            }
        }
        XCTAssertEqual(lastState, .connected)

        // No duplicate hello traffic on C from a second concurrent loop.
        let helloCount = tC.sent.compactMap { decodeLine($0)["method"] as? String }.filter { $0 == "protocol.hello" }.count
        XCTAssertEqual(helloCount, 1, "expected exactly one hello on C; got \(tC.sent)")

        // Give a stray second loop's own (independently-backed-off) next attempt time to fire
        // before checking the factory call count — a duplicate loop's redundant work can land on
        // a throwaway fallback transport rather than tC itself, so it wouldn't show up above.
        try await Task.sleep(nanoseconds: 1_500_000_000)

        // Exactly 3 factory calls total: initial connect (A), attempt 1 (B), attempt 2 (C). A
        // second concurrent loop would drive a 4th independent call (draining the box and pulling
        // a throwaway fallback transport) even when its traffic doesn't land on tC itself.
        XCTAssertEqual(box.callCount, 3, "factory called more than 3 times — a second reconnect loop is running")
    }

    /// Review fix 2 regression: close() landing during the backoff Task.sleep must abort the
    /// in-flight reconnect attempt outright, rather than letting it establish a live transport
    /// after a deliberate close (which nothing would then ever close).
    ///
    /// Synchronizes on the `.reconnecting(attempt: 1)` event before calling close() — this
    /// deterministically places close() inside the loop's backoff sleep window, rather than
    /// racing it against reconnectLoop's own startup (which the pre-existing `!deliberatelyClosed`
    /// guard in startReconnect() would trivially win, testing nothing new).
    func testCloseDuringBackoffAbortsReconnect() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "rc4")
        async let connected: Void = client.connect()
        let helloA = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloA)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        var iter = client.events.makeAsyncIterator()
        tA.dropConnection() // reconnectLoop starts
        guard case .connection(.disconnected)? = await iter.next() else { return XCTFail("expected disconnected") }
        guard case .connection(.reconnecting(attempt: 1))? = await iter.next() else { return XCTFail("expected reconnecting(1)") }
        // The loop is now inside its 0.5s backoff sleep — close() landing here must abort the
        // attempt rather than let it proceed to connect() once the sleep elapses.
        await client.close()
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertTrue(tB.sent.isEmpty, "close() during backoff must abort the reconnect attempt")
    }

    func testReattachServerErrorKeepsConnectionAndDetaches() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "m1")

        // connect + attach on A
        async let connected: Void = client.connect()
        let helloA = try await waitForSent(tA, count: 1)[0]
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloA)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected
        async let attached = client.attach(sessionId: "s_gone", fromSeq: 0)
        let sentA = try await waitForSent(tA, count: 2)
        tA.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sentA[1])["id"] as! Int),"result":{"ok":true,"lastSeq":3}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        // drop A → reconnect via B: answer hello OK, answer re-attach with a SERVER error
        tA.dropConnection()
        let helloB = try await waitForSent(tB, count: 1, timeout: 5)[0]
        tB.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloB)["id"] as! Int),"result":{"ok":true}}"#)
        let reattach = try await waitForSent(tB, count: 2)[1]
        XCTAssertEqual(decodeLine(reattach)["method"] as? String, "session.attach")
        tB.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(reattach)["id"] as! Int),"error":{"code":-32600,"message":"unknown session"}}"#)

        // states: disconnected → reconnecting(1) → CONNECTED (not an endless retry)
        var states: [ConnectionState] = []
        for _ in 0..<3 {
            if case .connection(let s)? = await iter.next() { states.append(s) }
        }
        XCTAssertEqual(states.last, .connected)
        // detached: a fresh attach must be possible; internal session pointer cleared
        let detached = await client.attachedSessionId
        XCTAssertNil(detached)
        // and B stays the live transport: a new request goes out on B, not a third transport
        Task { _ = try? await client.request("session.list", params: nil) }
        let after = try await waitForSent(tB, count: 3)
        XCTAssertEqual(decodeLine(after[2])["method"] as? String, "session.list")
    }
}

/// Thread-safe FIFO of scripted transports for the reconnect factory. Also counts calls: a
/// second concurrent reconnect loop calls the factory independently, so `callCount` running
/// ahead of the expected number of (re)connect attempts is a reliable tell — even if the extra
/// loop's traffic doesn't land on a transport a test happens to be watching (e.g. it drains the
/// box and gets a throwaway fallback transport instead of racing onto an observed one).
final class TransportBox: @unchecked Sendable {
    private let lock = NSLock()
    private var transports: [ScriptedTransport]
    private var _callCount = 0
    var callCount: Int { lock.lock(); defer { lock.unlock() }; return _callCount }
    init(transports: [ScriptedTransport]) { self.transports = transports }
    func next() -> ScriptedTransport {
        lock.lock(); defer { lock.unlock() }
        _callCount += 1
        return transports.isEmpty ? ScriptedTransport() : transports.removeFirst()
    }
}
