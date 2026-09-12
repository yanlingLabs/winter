import XCTest
import WinterProtocol
@testable import WinterKit

/// Scripted transport: records outbound lines; the test feeds inbound lines/closure manually.
final class ScriptedTransport: WinterTransport, SentLineRecording, @unchecked Sendable {
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
    func close() { cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
    func dropConnection() { cont.yield(.closed(nil)) }
}

/// Conformed to by any test transport that records the lines it has sent, so `waitForSent` can be
/// reused across scripted transports (ScriptedTransport, FlakySendTransport, ...).
protocol SentLineRecording: AnyObject {
    var sent: [String] { get }
}

/// Polls until the transport has `count` sent lines (the actor pump is async).
func waitForSent(_ t: some SentLineRecording, count: Int, timeout: TimeInterval = 2) async throws -> [String] {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if t.sent.count >= count { return t.sent }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("timed out waiting for \(count) sent lines; got \(t.sent)")
    return t.sent
}

func decodeLine(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

/// Like ScriptedTransport, but `send()` throws starting with the SECOND call — the first call
/// (hello, during connect()) succeeds and is recorded normally; every call after that fails
/// before it can record anything, simulating a transport whose socket dies right as a caller
/// tries to write to it.
final class FlakySendTransport: WinterTransport, SentLineRecording, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var sendCalls = 0
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }
    func open() async throws {}
    func send(_ data: Data) async throws {
        lock.lock()
        sendCalls += 1
        let isFirstCall = sendCalls == 1
        if isFirstCall { _sent.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)) }
        lock.unlock()
        if !isFirstCall { throw RpcError(code: -6, message: "simulated socket write failure") }
    }
    func close() { cont.finish() }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }
}

final class WinterClientTests: XCTestCase {
    func makeClient(_ t: ScriptedTransport) -> WinterClient {
        WinterClient(makeTransport: { t }, token: "tok64", clientName: "test-client")
    }

    func testConnectSendsHelloAndResolvesOnResponse() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        let connectTask = Task { try await client.connect() }
        let sent = try await waitForSent(t, count: 1)
        let hello = decodeLine(sent[0])
        XCTAssertEqual(hello["method"] as? String, "protocol.hello")
        let params = hello["params"] as? [String: Any]
        XCTAssertEqual(params?["protocolVersion"] as? Int, 0)
        XCTAssertEqual(params?["role"] as? String, "harness")
        XCTAssertEqual(params?["token"] as? String, "tok64")
        XCTAssertEqual(params?["clientName"] as? String, "test-client")
        let id = hello["id"] as! Int
        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true,"serverVersion":"0.0.1","protocolVersion":0}}"#)
        try await connectTask.value // does not throw
    }

    func testRequestCorrelationOutOfOrder() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let helloLine = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(helloLine)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        async let r1 = client.request("session.list", params: nil)
        async let r2 = client.request("task.list", params: .object(["sessionId": .string("s_1")]))
        let sent = try await waitForSent(t, count: 3)
        let id1 = decodeLine(sent[1])["id"] as! Int
        let id2 = decodeLine(sent[2])["id"] as! Int
        // answer in REVERSE order
        t.feed(#"{"jsonrpc":"2.0","id":\#(id2),"result":{"ok":true,"tasks":[]}}"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(id1),"result":{"sessions":[]}}"#)
        let v1 = try await r1
        let v2 = try await r2
        XCTAssertNotNil(v1["sessions"])
        XCTAssertEqual(v2["ok"]?.boolValue, true)
    }

    func testServerErrorSurfacesAsRpcError() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        async let r: JSONValue = client.request("session.attach", params: .object(["sessionId": .string("s_x")]))
        let sent = try await waitForSent(t, count: 2)
        let id = decodeLine(sent[1])["id"] as! Int
        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"error":{"code":-32600,"message":"unknown session"}}"#)
        do { _ = try await r; XCTFail("expected throw") }
        catch let e as RpcError { XCTAssertEqual(e.message, "unknown session") }
    }

    func testEventsFlowToTheStreamAndUnknownWraps() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        var iter = client.events.makeAsyncIterator()
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_delta","seq":3,"sessionId":"s_1","ts":1,"threadId":"main","delta":"hi"}}"#)
        guard case .session(.assistantDelta(let d)) = await iter.next() else { return XCTFail() }
        XCTAssertEqual(d.delta, "hi")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"future_thing","seq":4,"sessionId":"s_1","ts":2}}"#)
        guard case .unknown(let raw) = await iter.next() else { return XCTFail() }
        XCTAssertTrue(raw.contains("future_thing"))
    }

    /// Phase 5e T1 (reviewer maturity — the WinterKit-trap task): the NEW `tool_review` variant
    /// must decode as a REAL case (not fall back to `.unknown`, the way `testEventsFlowToTheStream
    /// AndUnknownWraps`'s `future_thing` does above) and both exhaustive accessor switches
    /// (`var seq`/`var sessionId`, WinterClient.swift) must return its values — this is what would
    /// have failed to compile before this task's switch sync.
    func testToolReviewEventDecodesAndAccessorsWork() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        var iter = client.events.makeAsyncIterator()
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"tool_review","seq":9,"sessionId":"s_1","ts":5,"threadId":"main","toolName":"bash","verdict":"unsafe","reason":"recursive delete outside cwd","summary":"bash rm -rf /tmp/x"}}"#)
        guard case .session(.toolReview(let v)) = await iter.next() else { return XCTFail() }
        XCTAssertEqual(v.toolName, "bash")
        XCTAssertEqual(v.verdict, "unsafe")
        XCTAssertEqual(SessionEvent.toolReview(v).seq, 9)
        XCTAssertEqual(SessionEvent.toolReview(v).sessionId, "s_1")
    }

    /// task-30 (push-notification track — another WinterKit-trap task, same shape as
    /// testToolReviewEventDecodesAndAccessorsWork above): the NEW `notification_requested` variant
    /// must decode as a REAL case and both exhaustive accessor switches (`var seq`/`var
    /// sessionId`) must return its values — this is what would have failed to compile before this
    /// task's switch sync. Also pins that it is NOT treated as transient (unlike assistantDelta/
    /// the lease events) — nothing here bypasses the normal seq-dedupe path.
    func testNotificationRequestedEventDecodesAndAccessorsWork() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        var iter = client.events.makeAsyncIterator()
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"notification_requested","seq":9,"sessionId":"s_1","ts":5,"threadId":"main","title":"Winter","message":"migration finished"}}"#)
        guard case .session(.notificationRequested(let v)) = await iter.next() else { return XCTFail() }
        XCTAssertEqual(v.title, "Winter")
        XCTAssertEqual(v.message, "migration finished")
        XCTAssertEqual(SessionEvent.notificationRequested(v).seq, 9)
        XCTAssertEqual(SessionEvent.notificationRequested(v).sessionId, "s_1")
    }

    func testConnectionDropFailsPendingAndYieldsDisconnected() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        var iter = client.events.makeAsyncIterator()
        async let r: JSONValue = client.request("session.list", params: nil)
        _ = try await waitForSent(t, count: 2)
        t.dropConnection()
        do { _ = try await r; XCTFail("expected throw") }
        catch let e as RpcError { XCTAssertEqual(e.message, "connection closed") }
        guard case .connection(.disconnected) = await iter.next() else { return XCTFail() }
    }

    func testRequestTimesOut() async throws {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "c", requestTimeout: .milliseconds(80))
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected
        do { _ = try await client.request("session.list", params: nil); XCTFail("expected timeout") }
        catch let e as RpcError { XCTAssertTrue(e.message.contains("timed out")) }
    }

    /// AMENDMENT 4 regression: a send() failure (not a timeout, not a server error response) must
    /// surface via sendFailed()'s own error/code — "transport send failed" — distinct from the
    /// timeout path's "timed out" wording.
    func testSendFailureResumesWithTransportError() async throws {
        let t = FlakySendTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "flaky")
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        do {
            _ = try await client.request("session.list", params: nil)
            XCTFail("expected throw")
        } catch let e as RpcError {
            XCTAssertEqual(e.code, -5)
            XCTAssertTrue(e.message.contains("transport send failed"), "got: \(e.message)")
        }
    }

    /// AMENDMENT 3 regression: close() must fail pending requests immediately rather than leaving
    /// them to linger until their per-request timeout — assert both the error and that it resolves
    /// well under the (5s default) request timeout.
    func testDeliberateCloseFailsPendingImmediately() async throws {
        let t = ScriptedTransport()
        let client = makeClient(t)
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        async let r: JSONValue = client.request("session.list", params: nil)
        _ = try await waitForSent(t, count: 2)
        let start = Date()
        await client.close()
        do {
            _ = try await r
            XCTFail("expected throw")
        } catch let e as RpcError {
            XCTAssertEqual(e.message, "connection closed")
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 2.0, "close() must fail pending requests promptly, not wait out the request timeout")
    }

    func testDeliberateCloseFinishesEventStream() async throws {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "close-ends")
        async let connected: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await connected
        var iter = client.events.makeAsyncIterator()
        await client.close()
        // the stream must END (nil), not hang — bounded by the test's own timeout behavior
        let ev = await iter.next()
        if case .connection(.disconnected)? = ev {
            let final = await iter.next()
            XCTAssertNil(final)
        } else {
            XCTAssertNil(ev)
        }
    }
}
