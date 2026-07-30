import CryptoKit
import Foundation
import Security

/// The phone's own ChatGPT sign-in — a faithful Swift port of the daemon's
/// `packages/core/src/providers/pkce.ts` (authorization-code + PKCE flow, token exchange, refresh)
/// and `packages/core/src/providers/codex-config.ts` (the codex-rs parity constants).
///
/// The port is deliberately BYTE-FAITHFUL: same parameters, same order, same
/// application/x-www-form-urlencoded escaping, same single `content-type` header on the auth
/// endpoint. The phone and the Mac are two clients of the same OpenAI endpoints; any difference
/// between them is a fingerprint we did not choose to have.
///
/// The one structural difference from the daemon: there is no loopback HTTP server here. The Mac
/// spins up `Bun.serve` on 127.0.0.1:1455 to catch the redirect; a phone hands the authorize URL
/// to `ASWebAuthenticationSession` and gets the callback URL back. `CodexAuth` therefore takes the
/// browser leg as a closure (`CodexBrowserLeg`) and never imports AuthenticationServices, which
/// keeps the kit platform-neutral and lets macOS `swift test` drive the whole flow.

// MARK: - parity constants

/// Mirrors `codex-config.ts`'s `CODEX`. Provenance for every value lives in that file's header
/// comment (codex-rs @ 216dee1189fd589ea6c0741a5f92f578a3ca4640); when it changes there, it
/// changes here — `CodexAuthTests.testShippedConfigMatchesCodexConfigTsLiterally` is the tripwire.
public struct CodexConfig: Sendable, Equatable {
    /// Hydra / Auth0 OAuth application id — shared by all Codex CLI clients.
    public var clientId: String
    public var authorizeURL: URL
    public var tokenURL: URL
    /// The daemon's loopback callback. codex-rs registers port 1455; a phone substitutes whatever
    /// redirect its browser leg can actually intercept, and the SAME value is echoed in the token
    /// exchange (OAuth requires the two to match).
    public var redirectURI: String
    public var scope: String
    /// ChatGPT Codex backend base — append `/responses`.
    public var backendURL: URL
    /// Static headers for BACKEND requests (never for the auth endpoint — `pkce.ts` sends only a
    /// content-type there, and so do we).
    public var headers: [String: String]

    public init(clientId: String, authorizeURL: URL, tokenURL: URL, redirectURI: String,
                scope: String, backendURL: URL, headers: [String: String]) {
        self.clientId = clientId
        self.authorizeURL = authorizeURL
        self.tokenURL = tokenURL
        self.redirectURI = redirectURI
        self.scope = scope
        self.backendURL = backendURL
        self.headers = headers
    }

    public static let codex = CodexConfig(
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        authorizeURL: URL(string: "https://auth.openai.com/oauth/authorize")!,
        tokenURL: URL(string: "https://auth.openai.com/oauth/token")!,
        redirectURI: "http://localhost:1455/auth/callback",
        scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
        backendURL: URL(string: "https://chatgpt.com/backend-api/codex")!,
        headers: [
            "OpenAI-Beta": "responses=experimental",
            // Originator header — identifies the client to the ChatGPT backend. We SELF-IDENTIFY
            // as "norma" rather than sending codex-rs's first-party value "codex_cli_rs". This is
            // the same deliberate go-public ToS decision the daemon made (codex-config.ts's long
            // comment): Norma is an independent client and says so honestly. Do NOT revert to a
            // first-party value to chase fingerprint parity — on the phone no less than the Mac.
            "originator": "norma",
        ]
    )

    /// The `/responses` request shape from `codex-oauth.ts`'s `post()` — same URL, same headers,
    /// same conditional account header. Task 8's ResponsesClient builds its streaming request from
    /// this; it lives here so the originator literal has exactly one home.
    public func responsesRequest(accessToken: String, accountId: String?, body: Data) -> URLRequest {
        var request = URLRequest(url: backendURL.appendingPathComponent("responses"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")
        if let accountId, !accountId.isEmpty {
            request.setValue(accountId, forHTTPHeaderField: "chatgpt-account-id")
        }
        // Applied last, exactly like the TS spread order — the static headers win.
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = body
        return request
    }
}

// MARK: - errors

public enum CodexAuthError: Error, Equatable, CustomStringConvertible, LocalizedError {
    /// The callback's `state` did not match the one we minted — possible CSRF, abort (the TS
    /// callback server's first check, before it ever looks at the code).
    case stateMismatch
    case missingCode
    /// `refreshIfNeeded` on a token set that never carried a refresh token: re-run the flow.
    case missingRefreshToken
    /// Non-2xx from the token endpoint. `body` is the response text capped at 200 chars — the
    /// request body (which carries the code/refresh token) is never included.
    case tokenExchangeFailed(status: Int, body: String)
    case malformedTokenResponse

    public var description: String {
        switch self {
        case .stateMismatch: return "OAuth state mismatch — possible CSRF, aborting login"
        case .missingCode: return "callback missing code"
        case .missingRefreshToken: return "not signed in — no refresh token"
        case .tokenExchangeFailed(let status, let body):
            return "token exchange failed: HTTP \(status)\(body.isEmpty ? "" : " — \(body)")"
        case .malformedTokenResponse: return "token endpoint returned an unreadable body"
        }
    }

    public var errorDescription: String? { description }
}

// MARK: - PKCE

/// `pkce.ts`'s `generatePkce()`: a 48-byte base64url verifier (64 chars, inside RFC 7636's 43–128)
/// and its S256 challenge.
public struct PKCE: Sendable, Equatable {
    public let verifier: String
    public let challenge: String

    /// INTERNAL (review M3): a caller-chosen verifier is the PKCE secret handed to an attacker.
    /// Production mints one with `generate()`; the RFC-7636 test vectors reach this via `@testable`.
    init(verifier: String) {
        self.verifier = verifier
        self.challenge = Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func generate() -> PKCE {
        PKCE(verifier: Base64URL.encode(randomBytes(48)))
    }
}

// MARK: - token state

/// The credential set the phone holds. Mirrors `pkce.ts`'s `OAuthTokens`; persisted by
/// `ChatKeychain` as JSON with `expiresAt` in epoch MILLISECONDS, the daemon store's unit.
public struct TokenState: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String?
    public var idToken: String?
    public var accountId: String?
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String? = nil, idToken: String? = nil,
                accountId: String? = nil, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        self.accountId = accountId
        self.expiresAt = expiresAt
    }

    /// Refresh this long before `expiresAt`.
    ///
    /// DELIBERATE DIVERGENCE from the daemon, which has no proactive margin at all: `codex-oauth.ts`
    /// refreshes only REACTIVELY, when the backend answers 401. That is fine for a Mac on a desk
    /// and poor for a phone, where the round trip that discovers the expiry may be the one that
    /// fails on a flaky link mid-turn. The reactive path stays the authority (Task 8's
    /// ResponsesClient still refreshes once on 401); this margin just avoids sending a request we
    /// already know is stale. 60s is well inside the 3600s token lifetime and generous against
    /// device clock skew.
    public static let refreshMargin: TimeInterval = 60

    /// Boundary is INCLUSIVE (`now >= expiresAt - margin` is due), matching the daemon's other
    /// expiry check — `computer-use.ts`'s `now < expiresAt - EXPIRY_SKEW_MS` means fresh.
    public func needsRefresh(now: Date, margin: TimeInterval = TokenState.refreshMargin) -> Bool {
        now >= expiresAt.addingTimeInterval(-margin)
    }

    /// Refreshes in place when due, and reports whether it did. On failure the state is left
    /// exactly as it was — a failed refresh must not destroy a credential the user can still fix
    /// by signing in again.
    ///
    /// Mirrors `codex-oauth.ts`'s merge rule verbatim: "refresh grants usually return no id_token
    /// and may not rotate the refresh token: never let nulls clobber known-good identity fields."
    @discardableResult
    public mutating func refreshIfNeeded(http: ChatHTTP, config: CodexConfig = .codex,
                                         margin: TimeInterval = TokenState.refreshMargin,
                                         now: @Sendable () -> Date = { Date() }) async throws -> Bool {
        guard needsRefresh(now: now(), margin: margin) else { return false }
        self = try await refreshed(http: http, config: config, now: now)
        return true
    }

    /// One UNCONDITIONAL refresh POST, returning the merged result (never mutates `self`). The
    /// primitive `TokenSource` (Task 8) serializes through an actor so two concurrent turns at the
    /// margin share ONE POST — factored out of `refreshIfNeeded` so both the proactive-margin path
    /// and the reactive 401 path use the exact same merge rule and neither re-checks the margin.
    ///
    /// Merge rule mirrors `codex-oauth.ts` verbatim: "refresh grants usually return no id_token and
    /// may not rotate the refresh token: never let nulls clobber known-good identity fields."
    public func refreshed(http: ChatHTTP, config: CodexConfig = .codex,
                          now: @Sendable () -> Date = { Date() }) async throws -> TokenState {
        guard let refreshToken else { throw CodexAuthError.missingRefreshToken }
        let fresh = try await CodexAuth.exchange(
            tokenURL: config.tokenURL,
            params: [
                ("grant_type", "refresh_token"),
                ("client_id", config.clientId),
                ("refresh_token", refreshToken),
            ],
            http: http, now: now)
        var merged = self
        merged.accessToken = fresh.accessToken
        merged.expiresAt = fresh.expiresAt
        if let rotated = fresh.refreshToken { merged.refreshToken = rotated }
        if let id = fresh.idToken { merged.idToken = id }
        if let account = fresh.accountId { merged.accountId = account }
        return merged
    }

    private enum CodingKeys: String, CodingKey {
        case accessToken, refreshToken, idToken, accountId, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
        idToken = try c.decodeIfPresent(String.self, forKey: .idToken)
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
        // Epoch MILLISECONDS — the unit codex-oauth.ts's store writes, not Foundation's
        // since-2001 default. Sub-millisecond precision is dropped; nothing depends on it.
        expiresAt = Date(timeIntervalSince1970: Double(try c.decode(Int64.self, forKey: .expiresAt)) / 1000)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accessToken, forKey: .accessToken)
        try c.encodeIfPresent(refreshToken, forKey: .refreshToken)
        try c.encodeIfPresent(idToken, forKey: .idToken)
        try c.encodeIfPresent(accountId, forKey: .accountId)
        try c.encode(Int64((expiresAt.timeIntervalSince1970 * 1000).rounded()), forKey: .expiresAt)
    }
}

/// REDACTED under reflection (review M4). Default struct reflection renders every stored property,
/// so `"\(tokens)"`, `String(describing:)`, `dump()`, `os_log("\(state)")` or even a SwiftUI
/// `Text("\(state)")` printed the access token, the refresh token and the id token verbatim — and
/// the phone app *will* log. `Codable` is untouched: `ChatKeychain` still round-trips the real
/// values; only the human-readable rendering is scrubbed.
///
/// `CustomReflectable` is required alongside the two string protocols, not instead of them: `dump()`
/// and the debugger's variable view walk the `Mirror`, which by default still enumerates every
/// stored property regardless of `description`. Redacting one and not the other closes half the hole.
extension TokenState: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "TokenState(account: \(accountId ?? "—"), expiresAtMs: \(Int64((expiresAt.timeIntervalSince1970 * 1000).rounded())), refreshToken: \(refreshToken == nil ? "absent" : "<redacted>"), accessToken: <redacted>)"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [
            "accountId": accountId as Any,
            "expiresAt": expiresAt,
            "accessToken": "<redacted>",
            "refreshToken": refreshToken == nil ? "absent" : "<redacted>",
            "idToken": idToken == nil ? "absent" : "<redacted>",
        ], displayStyle: .struct)
    }
}

// MARK: - the flow

/// One in-flight sign-in: the URL to open, plus the `state`/`verifier` the callback is checked and
/// exchanged against. Hold it for exactly as long as the browser sheet is up.
public struct AuthHandle: Sendable {
    public let authorizationURL: URL
    public let state: String
    public let redirectURI: String
    let verifier: String
    let config: CodexConfig

    /// The redirect the browser leg captured. `state` is checked BEFORE the code is even read —
    /// same order as the TS callback server, so a CSRF'd callback never reaches the token endpoint.
    public func complete(callbackURL: URL, http: ChatHTTP,
                         now: @Sendable () -> Date = { Date() }) async throws -> TokenState {
        let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state else {
            throw CodexAuthError.stateMismatch
        }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw CodexAuthError.missingCode
        }
        return try await complete(code: code, http: http, now: now)
    }

    /// For a browser leg that hands back a bare code (already state-checked by the caller).
    public func complete(code: String, http: ChatHTTP,
                         now: @Sendable () -> Date = { Date() }) async throws -> TokenState {
        try await CodexAuth.exchange(
            tokenURL: config.tokenURL,
            params: [
                ("grant_type", "authorization_code"),
                ("client_id", config.clientId),
                ("code", code),
                ("redirect_uri", redirectURI),
                ("code_verifier", verifier),
            ],
            http: http, now: now)
    }
}

/// REDACTED under reflection (review M4), same reasoning as `TokenState`'s: the PKCE `verifier` is a
/// stored property, so any interpolation of a live handle leaked the secret the code exchange is
/// bound to. The `state` shown here is the CSRF token, which is only meaningful in-flight and is what
/// a log actually needs for correlation.
extension AuthHandle: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "AuthHandle(state: \(state), redirectURI: \(redirectURI), verifier: <redacted>)"
    }
    public var debugDescription: String { description }
    public var customMirror: Mirror {
        Mirror(self, children: [
            "authorizationURL": authorizationURL,
            "state": state,
            "redirectURI": redirectURI,
            "verifier": "<redacted>",
        ], displayStyle: .struct)
    }
}

/// Opens the authorize URL and returns the redirect the provider sent the user back to.
///
/// iOS implements this with `ASWebAuthenticationSession` (its `presentationContextProvider`
/// supplies the anchor window) and rethrows a user cancellation; tests implement it by scripting
/// the callback. Anything it throws reaches the caller untouched.
public typealias CodexBrowserLeg = @Sendable (URL) async throws -> URL

public struct CodexAuth: Sendable {
    public let config: CodexConfig

    public init(config: CodexConfig = .codex) {
        self.config = config
    }

    /// Mints PKCE + state and builds the authorize URL. Byte-compatible with `pkce.ts`: the same
    /// seven parameters in the same order, escaped the way `URLSearchParams.toString()` escapes.
    ///
    /// (Unlike the TS this is neither async nor throwing — the asyncness there is only
    /// `crypto.subtle.digest`, which CryptoKit does synchronously, and nothing here can fail.)
    ///
    /// The ONLY public entry, and it takes no arguments (review M3): both seeds are security
    /// material — `state` is the CSRF token this flow's callback is checked against, `verifier` the
    /// PKCE secret — and a public injection point invites a caller (or a task copy-pasting a test)
    /// to pass a fixed or guessable one, quietly defeating the check the rest of this file is
    /// careful to get right. The seeded form below is `internal`, reachable only via `@testable`.
    public func beginFlow() -> AuthHandle {
        beginFlow(pkce: .generate(), state: CodexAuth.randomState())
    }

    /// Seeded entry — TESTS ONLY (see `beginFlow()`). `state` has no default deliberately: it is
    /// what makes this overload unambiguous with the public no-arg one.
    func beginFlow(pkce: PKCE = .generate(), state: String) -> AuthHandle {
        let query = FormURLEncoded.encode([
            ("response_type", "code"),
            ("client_id", config.clientId),
            ("redirect_uri", config.redirectURI),
            ("scope", config.scope),
            ("state", state),
            ("code_challenge", pkce.challenge),
            ("code_challenge_method", "S256"),
        ])
        var components = URLComponents(url: config.authorizeURL, resolvingAgainstBaseURL: false)!
        components.percentEncodedQuery = query
        return AuthHandle(authorizationURL: components.url!, state: state,
                          redirectURI: config.redirectURI, verifier: pkce.verifier, config: config)
    }

    /// The whole ceremony: mint → browser leg → state check → token exchange.
    public func signIn(http: ChatHTTP, browser: CodexBrowserLeg,
                       now: @Sendable () -> Date = { Date() }) async throws -> TokenState {
        let handle = beginFlow()
        let callbackURL = try await browser(handle.authorizationURL)
        return try await handle.complete(callbackURL: callbackURL, http: http, now: now)
    }

    /// `pkce.ts`: `randomBytes(16).toString("base64url")`.
    public static func randomState() -> String {
        Base64URL.encode(randomBytes(16))
    }

    /// `pkce.ts`'s `decodeAccountId` — reads `chatgpt_account_id` out of the id_token's payload.
    /// Never throws: an unreadable token is simply an unknown account (the TS catches too).
    public static func decodeAccountId(idToken: String) -> String? {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count >= 2, let payload = Base64URL.decode(String(parts[1])),
              let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let auth = json["https://api.openai.com/auth"] as? [String: Any]
        else { return nil }
        return auth["chatgpt_account_id"] as? String
    }

    // MARK: - token endpoint

    /// `pkce.ts`'s `exchange()`. One POST, one header, a form body in the caller's order.
    static func exchange(tokenURL: URL, params: [(String, String)], http: ChatHTTP,
                         now: @Sendable () -> Date) async throws -> TokenState {
        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = Data(FormURLEncoded.encode(params).utf8)

        let (data, response) = try await http.send(request)
        guard (200..<300).contains(response.statusCode) else {
            // Only the RESPONSE body is surfaced, capped like the TS's `.slice(0, 200)` — the
            // request body (code / refresh token) never appears in an error.
            let text = String(decoding: data, as: UTF8.self)
            throw CodexAuthError.tokenExchangeFailed(status: response.statusCode,
                                                     body: String(text.prefix(200)))
        }
        guard let decoded = try? JSONDecoder().decode(TokenResponse.self, from: data) else {
            throw CodexAuthError.malformedTokenResponse
        }
        return TokenState(
            accessToken: decoded.accessToken,
            refreshToken: decoded.refreshToken,
            idToken: decoded.idToken,
            accountId: decoded.idToken.flatMap { decodeAccountId(idToken: $0) },
            expiresAt: now().addingTimeInterval(decoded.expiresIn ?? 3600))
    }

    private struct TokenResponse: Decodable {
        let accessToken: String
        let refreshToken: String?
        let idToken: String?
        let expiresIn: Double?

        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case refreshToken = "refresh_token"
            case idToken = "id_token"
            case expiresIn = "expires_in"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            accessToken = try c.decode(String.self, forKey: .accessToken)
            refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
            idToken = try c.decodeIfPresent(String.self, forKey: .idToken)
            // T5-review M1: coerce a STRING `expires_in` the way the TS does (`Number(j.expires_in)`
            // in pkce.ts) rather than hard-rejecting the whole token response. OpenAI's token
            // endpoint has been observed to send `expires_in` as a JSON string on some responses; a
            // strict `Double`-only decode would throw and surface as `.malformedTokenResponse`,
            // signing the user out over a wire shape the daemon accepts fine. A numeric string
            // coerces to its value; anything unparseable (or absent) falls through to `nil`, which
            // the caller defaults to 3600s — never a NaN expiry.
            if let n = try? c.decodeIfPresent(Double.self, forKey: .expiresIn) {
                expiresIn = n
            } else if let s = try? c.decodeIfPresent(String.self, forKey: .expiresIn) {
                expiresIn = Double(s.trimmingCharacters(in: .whitespaces))
            } else {
                expiresIn = nil
            }
        }
    }
}

// MARK: - encoding helpers

/// Byte-compatible with JS `new URLSearchParams(pairs).toString()`: the
/// application/x-www-form-urlencoded serializer — unreserved set `A-Za-z0-9*-._`, space as `+`,
/// everything else percent-encoded from its UTF-8 bytes in UPPERCASE hex.
///
/// Foundation's own percent-encoding does not match (it leaves `/` and `:` bare in a query and
/// writes space as `%20`), which is why this is hand-rolled: the daemon and the phone must put the
/// same bytes on the wire.
enum FormURLEncoded {
    static func encode(_ pairs: [(String, String)]) -> String {
        pairs.map { "\(escape($0.0))=\(escape($0.1))" }.joined(separator: "&")
    }

    static func escape(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.utf8.count)
        for byte in value.utf8 {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, // 0-9 A-Z a-z
                 0x2A, 0x2D, 0x2E, 0x5F:                // * - . _
                out.append(Character(UnicodeScalar(byte)))
            case 0x20:
                out.append("+")
            default:
                out.append("%")
                out.append(hexDigits[Int(byte >> 4)])
                out.append(hexDigits[Int(byte & 0x0F)])
            }
        }
        return out
    }

    private static let hexDigits = Array("0123456789ABCDEF")
}

/// Node's `base64url` encoding: standard base64, `+`→`-`, `/`→`_`, no padding.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ string: String) -> Data? {
        var s = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s.append(String(repeating: "=", count: (4 - s.count % 4) % 4))
        return Data(base64Encoded: s)
    }
}

/// CSPRNG bytes for the verifier and the state. `SecRandomCopyBytes` rather than Swift's
/// `SystemRandomNumberGenerator` so the security guarantee is explicit at the call site.
func randomBytes(_ count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
    return Data(bytes)
}
