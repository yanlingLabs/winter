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
//
// Polish round 2 (daemon-oauth lane's contract additions):
// - `login(name:confirmIssuerChange:)` can be refused typed `mcp_issuer_change_requires_confirmation`
//   (`McpIssuerChangeConfirmation`, carrying both origins) when a server's issuer moved since the
//   last sign-in — the sheet shows both and retries with `confirmIssuerChange: true` on confirm. The
//   protocol keeps a one-arg `login(name:)` convenience (a protocol EXTENSION, not a requirement) so
//   the ordinary first call reads exactly as it did before this addition.
// - `McpLoginStart` gained `authorizeOrigin` — the origin the browser will ACTUALLY land on, shown
//   next to `issuerOrigin` only when they differ (`mcpAuthorizeOriginNote`, `LibraryMcpOAuth.swift`).
// - `setClientSecret` now RETURNS the `issuerOrigin` it saved against (`"Secret saved for <origin>"`)
//   instead of `Void` — still never echoes the secret itself.
// - `McpAuthRpcCode` closes the vocabulary of `error.data.code` values these four calls can refuse
//   with (`RpcError.mcpAuthCode`), same "closed enum + `.unknown`-less because the app-side mapper
//   already has its own `nil`-falls-back-to-generic-text rule" posture as `HandoffRpcCode`/
//   `CredentialRpcCode` beside this file.
//
// Polish round 3 (daemon-oauth lane's client-secret contract): a client secret is a bearer credential
// for whoever the daemon says holds it, so this file no longer lets the SecureField appear before the
// user has seen and agreed to WHO that is.
// - NEW read-only `clientSecretIssuer(name:)` (`mcp.clientSecretIssuer`, writes nothing) — the client-
//   secret sheet's FIRST call, before it ever shows the field. Answers the FULL `issuer` (the identity
//   the secret is actually bound to) plus `issuerOrigin`/`authorizeOrigin` for context.
// - `setClientSecret` now REQUIRES `expectedIssuer` — the issuer the user just confirmed — and can be
//   refused `mcp_expected_issuer_required` (`RpcError.mcpExpectedIssuerRequired`, carrying the issuer
//   it needed) or `mcp_issuer_changed` (`RpcError.mcpIssuerChanged`, the NEW issuer) when it no longer
//   matches; either sends the sheet back to a re-confirm step, never a silent resubmit with the old
//   value — the secret was already cleared by then (`McpClientSecretSheetModel`'s own discipline), so
//   "re-confirm" necessarily means the user re-enters it too. The result gained `issuer` (alongside the
//   pre-existing `issuerOrigin`) — `McpClientSecretSaved` — and "Secret saved for <origin>" became
//   "Secret saved for <issuer>".
// - `McpIssuerChangeConfirmation` (`mcp.login`'s own issuer-change refusal) gained `storedIssuer`/
//   `newIssuer` alongside its two origins — the sign-in sheet shows the full issuers now, origins
//   demoted to a secondary line.
// -----------------------------------------------------------------------------------------------

/// `mcp.login`'s reply: `{loginId, authUrl, issuerOrigin, authorizeOrigin}`. `issuerOrigin` here is
/// the AUTHORITATIVE value (this call's own, not the `mcp.list` row's `oauthIssuerOrigin` hint, which
/// may be absent or stale) — the sign-in sheet shows THIS one before it ever opens a browser.
/// `authorizeOrigin` is the origin the BROWSER actually lands on for the authorize step — usually the
/// same as `issuerOrigin`, but not guaranteed to be (a metadata-declared authorization endpoint on a
/// different host); shown only when it differs (`mcpAuthorizeOriginNote`).
public struct McpLoginStart: Equatable, Sendable {
    public let loginId: String
    public let authUrl: URL
    public let issuerOrigin: String
    public let authorizeOrigin: String

    public init(loginId: String, authUrl: URL, issuerOrigin: String, authorizeOrigin: String) {
        self.loginId = loginId
        self.authUrl = authUrl
        self.issuerOrigin = issuerOrigin
        self.authorizeOrigin = authorizeOrigin
    }
}

/// `mcp.login`'s typed refusal when the server's issuer changed since a prior sign-in (`error.data`
/// on `mcp_issuer_change_requires_confirmation`) — both FULL issuers (`storedIssuer`/`newIssuer`,
/// polish round 3) plus both origins, so the confirmation sheet can show "this server now signs in
/// through NEW; it used to be STORED" with the issuers as the primary fact and the origins secondary,
/// rather than a bare refusal.
public struct McpIssuerChangeConfirmation: Equatable, Sendable {
    public let storedIssuer: String
    public let newIssuer: String
    public let storedIssuerOrigin: String
    public let newIssuerOrigin: String

    public init(storedIssuer: String, newIssuer: String, storedIssuerOrigin: String, newIssuerOrigin: String) {
        self.storedIssuer = storedIssuer
        self.newIssuer = newIssuer
        self.storedIssuerOrigin = storedIssuerOrigin
        self.newIssuerOrigin = newIssuerOrigin
    }
}

/// `mcp.clientSecretIssuer`'s reply (read-only, writes nothing) — the client-secret sheet's FIRST
/// call, before it ever shows the SecureField. `issuer` is the FULL identity the secret is actually
/// bound to (what the sheet's confirm step names as the primary fact); `issuerOrigin`/
/// `authorizeOrigin` are secondary context, same relationship as `McpLoginStart`'s own pair.
public struct McpClientSecretIssuer: Equatable, Sendable {
    public let name: String
    public let issuer: String
    public let issuerOrigin: String
    public let authorizeOrigin: String

    public init(name: String, issuer: String, issuerOrigin: String, authorizeOrigin: String) {
        self.name = name
        self.issuer = issuer
        self.issuerOrigin = issuerOrigin
        self.authorizeOrigin = authorizeOrigin
    }
}

/// `mcp.setClientSecret`'s successful reply (polish round 3: gained `issuer` alongside the
/// pre-existing `issuerOrigin`) — "Secret saved for `<issuer>`" reads the former, never the latter.
public struct McpClientSecretSaved: Equatable, Sendable {
    public let issuer: String
    public let issuerOrigin: String

    public init(issuer: String, issuerOrigin: String) {
        self.issuer = issuer
        self.issuerOrigin = issuerOrigin
    }
}

/// `mcp.setClientSecret`'s `mcp_expected_issuer_required` refusal data — the daemon needed
/// `expectedIssuer` to match ITS issuer, and names what that is so the sheet can re-confirm.
public struct McpExpectedIssuerRequired: Equatable, Sendable {
    public let issuer: String
    public let issuerOrigin: String

    public init(issuer: String, issuerOrigin: String) {
        self.issuer = issuer
        self.issuerOrigin = issuerOrigin
    }
}

/// The closed set of `error.data.code` values `login`/`loginStatus`/`logout`/`setClientSecret` can
/// refuse with (daemon-oauth lane's contract). Two members (`sdkClientSecretIssuerMismatch`/
/// `sdkMetadataIssuerMismatch`) are the SDK's OWN raw codes rather than the daemon's `mcp_`-prefixed
/// wrapper — carried here as their own cases (not folded into `clientSecretIssuerMismatch`) because
/// they are literally different wire strings; `mcpAuthErrorText` (`LibraryMcpOAuth.swift`) is what
/// gives all three the same user-facing sentence.
public enum McpAuthRpcCode: String, Equatable, Sendable {
    case issuerChangeRequiresConfirmation = "mcp_issuer_change_requires_confirmation"
    case serverNotFound = "mcp_server_not_found"
    case oauthNotApplicable = "mcp_oauth_not_applicable"
    case oauthConfigInvalid = "mcp_oauth_config_invalid"
    case projectUntrusted = "mcp_project_untrusted"
    case scopeNeedsCwd = "mcp_scope_needs_cwd"
    case clientSecretUnavailable = "mcp_client_secret_unavailable"
    case clientSecretIssuerMismatch = "mcp_client_secret_issuer_mismatch"
    case loginFailed = "mcp_login_failed"
    case secretNeedsUserScope = "mcp_secret_needs_user_scope"
    case notPreregistered = "mcp_not_preregistered"
    case discoveryFailed = "mcp_discovery_failed"
    case sdkClientSecretIssuerMismatch = "client_secret_issuer_mismatch"
    case sdkMetadataIssuerMismatch = "metadata_issuer_mismatch"
    /// Polish round 3: `setClientSecret` refused because it was called without `expectedIssuer`
    /// matching what the daemon expects — carries the issuer/origin it needed
    /// (`RpcError.mcpExpectedIssuerRequired`). The Mac client always sends `expectedIssuer` (the
    /// confirm step made it mandatory), so this is a defensive case, not the ordinary door — the
    /// ordinary "it changed since you confirmed" door is `issuerChanged` below.
    case expectedIssuerRequired = "mcp_expected_issuer_required"
    /// `setClientSecret` refused because the issuer changed between the confirm step and the
    /// submit — carries only the NEW issuer (`RpcError.mcpIssuerChanged`), no origin.
    case issuerChanged = "mcp_issuer_changed"
}

extension RpcError {
    /// `nil` for a transport error, an untyped RPC failure, or a `data.code` this build doesn't
    /// recognize (a newer daemon) — same "unrecognized reads as nothing to say, never a crash"
    /// posture as `HandoffRpcCode`'s own `handoffCode`.
    public var mcpAuthCode: McpAuthRpcCode? {
        guard let code = data?["code"]?.stringValue else { return nil }
        return McpAuthRpcCode(rawValue: code)
    }

    /// Non-`nil` only for `mcp_issuer_change_requires_confirmation`, and only when all four fields
    /// are actually present — a malformed refusal (the code but not the data it promises) falls
    /// through to `nil` rather than this type inventing an empty issuer or origin.
    public var mcpIssuerChangeConfirmation: McpIssuerChangeConfirmation? {
        guard mcpAuthCode == .issuerChangeRequiresConfirmation,
              let storedIssuer = data?["storedIssuer"]?.stringValue,
              let newIssuer = data?["newIssuer"]?.stringValue,
              let storedOrigin = data?["storedIssuerOrigin"]?.stringValue,
              let newOrigin = data?["newIssuerOrigin"]?.stringValue
        else { return nil }
        return McpIssuerChangeConfirmation(storedIssuer: storedIssuer, newIssuer: newIssuer,
                                            storedIssuerOrigin: storedOrigin, newIssuerOrigin: newOrigin)
    }

    /// Non-`nil` only for `mcp_expected_issuer_required`, and only when both fields are present.
    public var mcpExpectedIssuerRequired: McpExpectedIssuerRequired? {
        guard mcpAuthCode == .expectedIssuerRequired,
              let issuer = data?["issuer"]?.stringValue,
              let issuerOrigin = data?["issuerOrigin"]?.stringValue
        else { return nil }
        return McpExpectedIssuerRequired(issuer: issuer, issuerOrigin: issuerOrigin)
    }

    /// Non-`nil` only for `mcp_issuer_changed`, and only when `data.issuer` is present. No origin —
    /// this refusal's own contract carries just the new issuer.
    public var mcpIssuerChanged: String? {
        guard mcpAuthCode == .issuerChanged else { return nil }
        return data?["issuer"]?.stringValue
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
    /// `loginStatus(loginId:)`. `confirmIssuerChange: true` retries a call that was refused
    /// `mcp_issuer_change_requires_confirmation` (`RpcError.mcpIssuerChangeConfirmation`), after the
    /// user has seen both origins and agreed; `false` (the plain `login(name:)` convenience below)
    /// omits the wire key entirely rather than sending an explicit `false`.
    func login(name: String, confirmIssuerChange: Bool) async throws -> McpLoginStart
    func loginStatus(loginId: String) async throws -> McpLoginStatus
    /// `forgetClient`: "Also forget this app's registration with the server" — `nil` omits the wire
    /// key entirely (the daemon's own default, a best-effort token revoke that KEEPS the client
    /// registration) rather than this client inventing a default of its own.
    func logout(name: String, forgetClient: Bool?) async throws
    /// Read-only (writes nothing) — the client-secret sheet's FIRST call, before it ever shows the
    /// SecureField. Answers who the secret would actually be bound to, so the sheet can ask the user
    /// to confirm before asking for anything sensitive.
    func clientSecretIssuer(name: String) async throws -> McpClientSecretIssuer
    /// For a server configured with a pre-registered `oauth.clientId`. Never logged, never retained
    /// past this one call — see `McpClientSecretSheetModel`'s own discipline. `expectedIssuer` is the
    /// issuer the user confirmed via `clientSecretIssuer(name:)`; a mismatch by the time this call
    /// reaches the daemon refuses typed (`RpcError.mcpExpectedIssuerRequired`/`.mcpIssuerChanged`)
    /// rather than silently saving against a DIFFERENT issuer than what was shown. Returns the
    /// issuer/origin the daemon actually saved against, for "Secret saved for <issuer>".
    @discardableResult
    func setClientSecret(name: String, secret: String, expectedIssuer: String) async throws -> McpClientSecretSaved
}

extension McpAuthClient {
    /// The ordinary first call — no issuer-change confirmation to retry with yet.
    public func login(name: String) async throws -> McpLoginStart {
        try await login(name: name, confirmIssuerChange: false)
    }
}

/// The production implementation — every call routes through `WinterClient.request`, same as
/// `LiveAnthropicAuthClient`/`LiveCredentialsClient` beside this file.
public final class LiveMcpAuthClient: McpAuthClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    public func login(name: String, confirmIssuerChange: Bool) async throws -> McpLoginStart {
        var params: [String: JSONValue] = ["name": .string(name)]
        if confirmIssuerChange { params["confirmIssuerChange"] = .bool(true) }
        let r = try await client.request("mcp.login", params: .object(params))
        guard let loginId = r["loginId"]?.stringValue,
              let authUrlString = r["authUrl"]?.stringValue,
              let authUrl = URL(string: authUrlString),
              let issuerOrigin = r["issuerOrigin"]?.stringValue,
              let authorizeOrigin = r["authorizeOrigin"]?.stringValue
        else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.login")
        }
        return McpLoginStart(loginId: loginId, authUrl: authUrl, issuerOrigin: issuerOrigin,
                              authorizeOrigin: authorizeOrigin)
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

    public func clientSecretIssuer(name: String) async throws -> McpClientSecretIssuer {
        let r = try await client.request("mcp.clientSecretIssuer", params: .object(["name": .string(name)]))
        guard let n = r["name"]?.stringValue,
              let issuer = r["issuer"]?.stringValue,
              let issuerOrigin = r["issuerOrigin"]?.stringValue,
              let authorizeOrigin = r["authorizeOrigin"]?.stringValue
        else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.clientSecretIssuer")
        }
        return McpClientSecretIssuer(name: n, issuer: issuer, issuerOrigin: issuerOrigin, authorizeOrigin: authorizeOrigin)
    }

    @discardableResult
    public func setClientSecret(name: String, secret: String, expectedIssuer: String) async throws -> McpClientSecretSaved {
        let r = try await client.request("mcp.setClientSecret", params: .object([
            "name": .string(name), "secret": .string(secret), "expectedIssuer": .string(expectedIssuer),
        ]))
        guard r["ok"]?.boolValue == true,
              let issuer = r["issuer"]?.stringValue,
              let issuerOrigin = r["issuerOrigin"]?.stringValue
        else {
            throw RpcError(code: -3, message: "invalid result from server for mcp.setClientSecret")
        }
        return McpClientSecretSaved(issuer: issuer, issuerOrigin: issuerOrigin)
    }
}
