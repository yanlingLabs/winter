import XCTest
import WinterProtocol
@testable import WinterKit

/// The Winter island's client half: the hello's `capabilities` (on every hello, reconnects included) and
/// `island.pending`'s decoding.
final class IslandClientTests: XCTestCase {
    func testCapabilitiesRideEveryHelloIncludingTheReconnect() async throws {
        let tA = ScriptedTransport()
        let tB = ScriptedTransport()
        let box = TransportBox(transports: [tA, tB])
        let client = WinterClient(makeTransport: { box.next() }, token: "tok", clientName: "orb", requestTimeout: .seconds(2))
        await client.setClientCapabilities([WinterClient.capabilityIsland])

        async let connected: Void = client.connect()
        let helloA = decodeLine(try await waitForSent(tA, count: 1)[0])
        XCTAssertEqual((helloA["params"] as? [String: Any])?["capabilities"] as? [String], ["island"])
        tA.feed(#"{"jsonrpc":"2.0","id":\#(helloA["id"] as! Int),"result":{"ok":true}}"#)
        try await connected

        tA.dropConnection()
        let helloB = decodeLine(try await waitForSent(tB, count: 1, timeout: 5)[0])
        XCTAssertEqual(helloB["method"] as? String, "protocol.hello")
        XCTAssertEqual((helloB["params"] as? [String: Any])?["capabilities"] as? [String], ["island"],
                       "a reconnect that dropped the flag would send the desktop-switch prompt back to the helper")
        tB.feed(#"{"jsonrpc":"2.0","id":\#(helloB["id"] as! Int),"result":{"ok":true}}"#)
        await client.close()
    }

    func testAHelloWithoutCapabilitiesSendsNoKey() async throws {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "orb")
        async let connected: Void = client.connect()
        let hello = decodeLine(try await waitForSent(t, count: 1)[0])
        XCTAssertNil((hello["params"] as? [String: Any])?["capabilities"])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await connected
        await client.close()
    }

    func testDecodesAPendingItemAndSkipsAnUnknownEvent() throws {
        let json = #"""
        {"items":[
          {"sessionId":"s_child","answerSessionId":"s_child","kind":"approval",
           "event":{"type":"approval_requested","seq":4,"ts":1,"sessionId":"s_child","threadId":"main","callId":"c1","toolName":"Bash","summary":"rm -rf build"},
           "session":{"mode":"code","origin":"dispatch-child","parentSessionId":"s_disp","title":"Clean up"},
           "hosts":[{"clientName":"tui","role":"harness","tty":"/dev/ttys004"}]},
          {"sessionId":"s2","answerSessionId":"s2","kind":"question",
           "event":{"type":"from_the_future","seq":1,"ts":1,"sessionId":"s2","threadId":"main"},
           "session":{},"hosts":[]}
        ]}
        """#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let items = (value["items"]?.arrayValue ?? []).compactMap(WinterClient.decodeIslandItem)
        XCTAssertEqual(items.count, 1)
        let item = try XCTUnwrap(items.first)
        XCTAssertEqual(item.kind, .approval)
        XCTAssertEqual(item.session, IslandSessionFacts(mode: "code", origin: "dispatch-child", parentSessionId: "s_disp", title: "Clean up"))
        XCTAssertEqual(item.hosts, [IslandHost(clientName: "tui", role: "harness", tty: "/dev/ttys004")])
        guard case .approvalRequested(let a) = item.event else { return XCTFail("expected an approval") }
        XCTAssertEqual(a.callId, "c1")
    }

    func testIslandHostsAndUsageDecode() throws {
        let hostsJSON = #"{"sessions":[{"sessionId":"s1","hosts":[{"clientName":"cli-chat","role":"harness","tty":"/dev/ttys003"},{"role":"x"}]},{"hosts":[]}]}"#
        let hosts = WinterClient.decodeIslandHosts(try JSONDecoder().decode(JSONValue.self, from: Data(hostsJSON.utf8)))
        XCTAssertEqual(hosts, ["s1": [IslandHost(clientName: "cli-chat", role: "harness", tty: "/dev/ttys003")]])

        let usageJSON = #"{"windows":[{"rateLimitType":"five_hour","status":"allowed_warning","utilization":0.8,"resetsAt":1900000000000,"at":5,"sessionId":"s1"},{"rateLimitType":"x"}],"subscription":{"status":"allowed","resetsAt":1800000000000,"at":2},"background":{"kind":"limited","resumeAt":9,"inputTokens":10,"outputTokens":4},"session":{"sessionId":"s1","turns":2,"inputTokens":100,"outputTokens":20,"contextTokens":30000,"contextWindow":200000,"model":"example/model-x"}}"#
        let usage = WinterClient.decodeIslandUsage(try JSONDecoder().decode(JSONValue.self, from: Data(usageJSON.utf8)))
        XCTAssertEqual(usage.windows, [IslandUsageWindow(rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.8,
                                                         resetsAt: 1_900_000_000_000, at: 5, sessionId: "s1")])
        XCTAssertEqual(usage.subscription, .init(status: "allowed", resetsAt: 1_800_000_000_000, at: 2))
        XCTAssertEqual(usage.background, .init(limited: true, resumeAt: 9, inputTokens: 10, outputTokens: 4))
        XCTAssertEqual(usage.session, .init(sessionId: "s1", turns: 2, inputTokens: 100, outputTokens: 20, contextTokens: 30_000,
                                            contextWindow: 200_000, model: "example/model-x"))
        let empty = WinterClient.decodeIslandUsage(.object([:]))
        XCTAssertEqual(empty, IslandUsageSnapshot(windows: [], background: .init(limited: false, inputTokens: 0, outputTokens: 0)))
    }
}
