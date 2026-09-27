import Foundation

// -----------------------------------------------------------------------------------------------
// WS-25 (MCP OAuth), Mac lane — the Library MCP tab's sign-in/out door: `mcp.login` /
// `mcp.loginStatus` / `mcp.logout` / `mcp.setClientSecret` (spec `WS-25-mcp-oauth.md` §2, the local-
// role RPCs the Mac lane calls; the daemon lane implements them in parallel).
//
// Same seam posture as `AnthropicAuthClient.swift` beside this file, for the same reason: the
// protocol exists so the owning view-model is unit-testable against a hand-written fake with no
// socket/transport involved, and `LiveMcpAuthClient` is its thin production implementation over
// `WinterClient.request` — there is still no generated Swift type for an RPC METHOD's result
// (`WinterProtocol` mirrors `SessionEvent` variants only), so every call here hand-decodes its
// `JSONValue`, exactly like every other method wrapper in this kit.
//
// **Deliberately NO `scope`/`cwd` parameter anywhere in this protocol**, even though the wire
// contract carries both (`{name, scope?, cwd?}`): the Library MCP tab that is this client's one
// caller is CWD-LESS BY DESIGN (`LibraryMcpTab.swift`'s own header, caveat 1 — passing a `cwd` to
// `mcp.list` SPAWNS that project's servers, so the tab never has one to pass here either, and
// `mcp.list`'s own cwd-less call never returns a project-scoped row to sign in to). Omitting both
// params lets the daemon apply its own default scope rather than this client inventing one; a
// future project-scoped MCP surface with an actual `cwd` in hand would need its own client, not an
// overload of this one.
//
// **`authUrl` is never sanitized.** Unlike the Console login's `urlHint` (`AnthropicAuthClient.swift`
// strips its query — the one-time code lives there), an MCP OAuth `authUrl` carries the PKCE
// `state`/`code_challenge` the authorization server needs verbatim; stripping it would break the
// flow. It is opened, never rendered as text and never logged.
// -----------------------------------------------------------------------------------------------

/// `mcp.login`'s reply: `{loginId, authUrl, issuerOrigin}`. `issuerOrigin` here is the AUTHORITATIVE
/// value (this call's own, not the `mcp.list` row's `oauthIssuerOrigin` hint, which may be absent or
/// stale) — the sign-in sheet shows THIS one before it ever opens a browser.
public struct McpLoginStart: Equatable, Sendable {
    public let loginId: String
    public let authUrl: URL
    public let issuerOrigin: String

    public init(loginId: String, authUrl: URL, issuerOrigin: String) {
        self.loginId = loginId
        self.authUrl = authUrl
        self.issuerOrigin = issuerOrigin
    }
}

/// `mcp.loginStatus`'s own state word. A closed enum WITH an escape hatch (`.unknown`) rather than a
/// bare `String`: the sign-in sheet's poller (`McpLoginSheetModel`, `apple/Winter/Sources/Library/`)
/// treats every one of the four known words as a terminal-or-continue decision it understands, and
/// an unrecognized fifth word from a newer daemon as an IMMEDIATE, plainly-named failure — never an
/// unbounded spin against a value this build has no rule for.
public enum McpLoginState: Equatable, Sendable {
    case pending
    case done
    case failed
    case expired
    case unknown(String)

    public init(wire: String) {
        switch wire {
        case "pending": self = .pending
        case "done": self = .done
        case "failed": self = .failed
        case "expired": self = .expired
        default: self = .unknown(wire)
        }
    }
}

/// `mcp.loginStatus`'s reply: `{state, error?}`.
public struct McpLoginStatus: Equatable, Sendable {
    public let state: McpLoginState
    public let error: String?

    public init(state: McpLoginState, error: String? = nil) {
        self.state = state
        self.error = error
    }
}

/// The app's one seam onto every MCP-OAuth RPC. `McpLoginSheetModel`/`McpToolsModel`'s sign-out and
/// client-secret actions (`apple/Winter/Sources/Library/LibraryMcpOAuth.swift`) depend on THIS
/// protocol, never on `WinterClient` directly, so all three are unit-testable against a hand-written
/// fake.
public protocol McpAuthClient: Sendable {
    /// Starts a sign-in attempt for the external server named `name` (`mcp.list`'s own `name`
    /// field). Returns once the daemon has a `loginId`/`authUrl` ready — NOT once the user has
    /// finished in their browser; the terminal outcome is only ever learned by polling
    /// `loginStatus(loginId:)`.
    func login(name: String) async throws -> McpLoginStart
    func loginStatus(loginId: String) async throws -> McpLoginStatus
    /// `forgetClient`: "Also forget this app's registration with the server" — `nil` omits the wire
    /// key entirely (the daemon's own default, a best-effort token revoke that KEEPS the client
    /// registration) rather than this client inventing a default of its own.
    func logout(name: String, forgetClient: Bool?) async throws
    /// For a server configured with a pre-registered `oauth.clientId`. Never logged, never retained
    /// past this one call — see `McpClientSecretSheetModel`'s own discipline.
    func setClientSecret(name: String, secret: String) async throws
}

/// The production implementation — every call routes through `WinterClient.request`, same as
/// `LiveAnthropicAuthClient`/`LiveCredentialsClient` beside this file.
public final class LiveMcpAuthClient: McpAuthClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    public func login(name: String) async throws -> McpLoginStart {
        let r = try await client.request("mcp.login", params: .object(["name": .string(name)]))
        guard let loginId = r["loginId"]?.stringValue,
              let authUrlString = r["authUrl"]?.stringValue,
              let authUrl = URL(string: authUrlString),
              let issuerOrigin = r["issuerOrigin"]?.stringValue
        else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.login")
        }
        return McpLoginStart(loginId: loginId, authUrl: authUrl, issuerOrigin: issuerOrigin)
    }

    public func loginStatus(loginId: String) async throws -> McpLoginStatus {
        let r = try await client.request("mcp.loginStatus", params: .object(["loginId": .string(loginId)]))
        guard let wireState = r["state"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.loginStatus")
        }
        return McpLoginStatus(state: McpLoginState(wire: wireState), error: r["error"]?.stringValue)
    }

    public func logout(name: String, forgetClient: Bool?) async throws {
        var params: [String: JSONValue] = ["name": .string(name)]
        if let forgetClient { params["forgetClient"] = .bool(forgetClient) }
        let r = try await client.request("mcp.logout", params: .object(params))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "mcp.logout returned ok:false")
        }
    }

    public func setClientSecret(name: String, secret: String) async throws {
        let r = try await client.request("mcp.setClientSecret", params: .object([
            "name": .string(name), "secret": .string(secret),
        ]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "mcp.setClientSecret returned ok:false")
        }
    }
}
