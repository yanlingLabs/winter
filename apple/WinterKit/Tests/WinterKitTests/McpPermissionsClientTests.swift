import XCTest
import WinterProtocol
@testable import WinterKit

/// WS-26: `LiveMcpPermissionsClient` over a scripted transport — the exact params it sends, and how it
/// decodes `mcp.tools` (unknown words dropped, never guessed at).
final class McpPermissionsClientTests: XCTestCase {
    func connected() async throws -> (WinterClient, ScriptedTransport) {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "perm-test")
        async let c: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    func roundTrip<T>(_ t: ScriptedTransport, sentIndex: Int, result: String, _ call: @escaping () async throws -> T) async throws -> (request: [String: Any], value: T) {
        async let v = call()
        let sent = try await waitForSent(t, count: sentIndex + 1)
        let req = decodeLine(sent[sentIndex])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(result)}"#)
        return (req, try await v)
    }

    func testToolsDecodesOneServerAndNamesOnlyIt() async throws {
        let (client, t) = try await connected()
        let live = LiveMcpPermissionsClient(client: client)
        let result = #"""
        {"ok":true,"servers":[{"name":"cf","status":"connected","allTools":"ask","listed":true,"tools":[
          {"name":"workers_list","toolName":"mcp__cf__workers_list","description":"List","readOnly":true,"permission":"allow","source":"default"},
          {"name":"d1_delete","toolName":"mcp__cf__d1_delete","readOnly":false,"setting":"allow","permission":"deny","source":"rule","rules":[{"behavior":"deny","rule":"mcp__cf__d1_*"},{"behavior":"sometimes","rule":"x"}]},
          {"name":"weird","toolName":"mcp__cf__weird","readOnly":false,"permission":"maybe","source":"default"}
        ]}]}
        """#
        let (req, server) = try await roundTrip(t, sentIndex: 1, result: result.replacingOccurrences(of: "\n", with: "")) { try await live.tools(server: "cf") }
        XCTAssertEqual(req["method"] as? String, "mcp.tools")
        XCTAssertEqual(req["params"] as? [String: String], ["server": "cf"])
        let s = try XCTUnwrap(server)
        XCTAssertEqual(s.allTools, .ask)
        XCTAssertTrue(s.listed)
        XCTAssertEqual(s.tools.map(\.name), ["workers_list", "d1_delete"])
        XCTAssertEqual(s.tools[0], McpToolPermissionRow(name: "workers_list", toolName: "mcp__cf__workers_list", description: "List", readOnly: true, permission: .allow, source: "default"))
        XCTAssertEqual(s.tools[1].setting, .allow)
        XCTAssertEqual(s.tools[1].permission, .deny)
        XCTAssertEqual(s.tools[1].rules, [McpToolRule(behavior: .deny, rule: "mcp__cf__d1_*")])
    }

    func testSetToolPermissionSendsDefaultForNilAndResetOnlyWhenAsked() async throws {
        let (client, t) = try await connected()
        let live = LiveMcpPermissionsClient(client: client)
        let (r1, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true,"server":"cf","tool":"x","permission":"default"}"#) {
            try await live.setToolPermission(server: "cf", tool: "x", permission: nil, resetTools: false)
        }
        XCTAssertEqual(r1["method"] as? String, "mcp.setToolPermission")
        XCTAssertEqual(r1["params"] as? [String: String], ["server": "cf", "tool": "x", "permission": "default"])
        let (r2, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"server":"cf","tool":"*","permission":"deny"}"#) {
            try await live.setToolPermission(server: "cf", tool: "*", permission: .deny, resetTools: true)
        }
        let p2 = try XCTUnwrap(r2["params"] as? [String: Any])
        XCTAssertEqual(p2["permission"] as? String, "deny")
        XCTAssertEqual(p2["resetTools"] as? Bool, true)
    }
}
