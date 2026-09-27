import Foundation

// -----------------------------------------------------------------------------------------------
// WS-26 — CONNECTOR PERMISSIONS, the Mac's door: `mcp.tools` (a server's actions, each with the stored
// permission, what applies and why) and `mcp.setToolPermission` (the write). The daemon owns the store
// (`settings.mcp.toolPermissions`), the matrix and the enforcement (`core/src/agent/mcp/connector-
// permissions.ts`); this client only reads and writes. Both are LOCAL-role methods — the phone answers the
// approval cards these settings produce, it never changes them.
//
// Same seam posture as `McpAuthClient` beside this file: a protocol so the Library page's model is
// unit-testable against a hand-written fake, and a thin live implementation over `WinterClient.request`
// that hand-decodes the `JSONValue` (there is no generated Swift type for an RPC result).
//
// **No `cwd`.** `mcp.tools` takes one, and like `mcp.list` a cwd makes the daemon probe that project's
// servers — the Library tab is cwd-less by design (`LibraryMcpTab.swift`'s caveat 1), so this door has no
// cwd to pass and asks only about the user's own servers and the plugins'.
// -----------------------------------------------------------------------------------------------

/// The three things a user can store about an action. "Default" is the absence of one (`nil`).
public enum McpToolPermission: String, CaseIterable, Equatable, Sendable {
    case allow
    case ask
    case deny
}

/// A claude-grammar rule in `sdk/settings.json` that names the action (the daemon's own matching).
public struct McpToolRule: Equatable, Sendable {
    public let behavior: McpToolPermission
    public let rule: String

    public init(behavior: McpToolPermission, rule: String) {
        self.behavior = behavior
        self.rule = rule
    }
}

/// One action of a connector, as `mcp.tools` reports it.
public struct McpToolPermissionRow: Equatable, Identifiable, Sendable {
    public var id: String { name }
    /// The BARE name, as the server calls it.
    public let name: String
    /// `mcp__<server>__<tool>` — what the model calls and a transcript shows.
    public let toolName: String
    public let description: String?
    /// The server marked it `readOnlyHint: true` in its last `tools/list`.
    public let readOnly: Bool
    /// The action's OWN stored value; `nil` when it has none (the server's all-actions value, a rule or
    /// the default then applies — `permission`/`source`).
    public let setting: McpToolPermission?
    /// What a chat or dispatch session does with it.
    public let permission: McpToolPermission
    /// `"tool"` | `"server"` | `"rule"` | `"default"` — an open string (a newer daemon may grow one).
    public let source: String
    public let rules: [McpToolRule]

    public init(name: String, toolName: String, description: String? = nil, readOnly: Bool,
                setting: McpToolPermission? = nil, permission: McpToolPermission, source: String,
                rules: [McpToolRule] = []) {
        self.name = name
        self.toolName = toolName
        self.description = description
        self.readOnly = readOnly
        self.setting = setting
        self.permission = permission
        self.source = source
        self.rules = rules
    }
}

/// One server's actions (`mcp.tools`' `servers[]`).
public struct McpToolsServer: Equatable, Sendable {
    public let name: String
    /// The daemon's status word, verbatim (`connected`, `needs-auth`, `disabled`, …).
    public let status: String
    /// The server's all-actions value, when one is stored.
    public let allTools: McpToolPermission?
    /// `false` — the daemon has no listing yet (never probed, or it needs a sign-in); `tools` then holds
    /// only actions with a stored value.
    public let listed: Bool
    public let tools: [McpToolPermissionRow]

    public init(name: String, status: String, allTools: McpToolPermission? = nil, listed: Bool, tools: [McpToolPermissionRow]) {
        self.name = name
        self.status = status
        self.allTools = allTools
        self.listed = listed
        self.tools = tools
    }

    /// PURE: one `servers[]` entry off the wire, or `nil` when it lacks what every entry carries. A row
    /// whose `permission` is a word this build does not know is dropped rather than guessed at.
    public static func decode(_ s: JSONValue) -> McpToolsServer? {
        guard let name = s["name"]?.stringValue, let status = s["status"]?.stringValue else { return nil }
        let tools: [McpToolPermissionRow] = (s["tools"]?.arrayValue ?? []).compactMap { t in
            guard let n = t["name"]?.stringValue,
                  let wire = t["toolName"]?.stringValue,
                  let permission = t["permission"]?.stringValue.flatMap(McpToolPermission.init(rawValue:)),
                  let source = t["source"]?.stringValue
            else { return nil }
            let rules: [McpToolRule] = (t["rules"]?.arrayValue ?? []).compactMap { r in
                guard let b = r["behavior"]?.stringValue.flatMap(McpToolPermission.init(rawValue:)),
                      let rule = r["rule"]?.stringValue else { return nil }
                return McpToolRule(behavior: b, rule: rule)
            }
            return McpToolPermissionRow(
                name: n, toolName: wire, description: t["description"]?.stringValue,
                readOnly: t["readOnly"]?.boolValue ?? false,
                setting: t["setting"]?.stringValue.flatMap(McpToolPermission.init(rawValue:)),
                permission: permission, source: source, rules: rules)
        }
        return McpToolsServer(
            name: name, status: status,
            allTools: s["allTools"]?.stringValue.flatMap(McpToolPermission.init(rawValue:)),
            listed: s["listed"]?.boolValue ?? false,
            tools: tools)
    }
}

/// The app's seam onto the two connector-permission RPCs.
public protocol McpPermissionsClient: Sendable {
    /// One server's actions; `nil` when the daemon reports nothing under that name.
    func tools(server: String) async throws -> McpToolsServer?
    /// Store `permission` for `tool` (`"*"`: every action of the server), or clear it (`nil` → the
    /// wire's `"default"`). `resetTools` (all-actions only) also clears every per-action value.
    func setToolPermission(server: String, tool: String, permission: McpToolPermission?, resetTools: Bool) async throws
}

/// The production implementation, over `WinterClient.request`.
public final class LiveMcpPermissionsClient: McpPermissionsClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    public func tools(server: String) async throws -> McpToolsServer? {
        let r = try await client.request("mcp.tools", params: .object(["server": .string(server)]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.tools")
        }
        return (r["servers"]?.arrayValue ?? []).compactMap(McpToolsServer.decode).first { $0.name == server }
    }

    public func setToolPermission(server: String, tool: String, permission: McpToolPermission?, resetTools: Bool) async throws {
        var params: [String: JSONValue] = [
            "server": .string(server), "tool": .string(tool), "permission": .string(permission?.rawValue ?? "default"),
        ]
        if resetTools { params["resetTools"] = .bool(true) }
        let r = try await client.request("mcp.setToolPermission", params: .object(params))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "mcp.setToolPermission returned ok:false")
        }
    }
}
