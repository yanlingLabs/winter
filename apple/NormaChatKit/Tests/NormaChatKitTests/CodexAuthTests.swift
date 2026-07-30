import CryptoKit
import Foundation
import XCTest
@testable import NormaChatKit

// File-scope so the `@Sendable` clock closures below capture immutable values rather than the
// test case instance.
private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
private let config = AuthFixture.testConfig

/// The phone's own Codex OAuth — a faithful Swift port of `packages/core/src/providers/pkce.ts`
/// + `codex-oauth.ts` + `codex-config.ts`. Every request field is asserted against the exact
/// bytes the TS daemon sends, because the two clients hit the same OpenAI endpoints and any
/// divergence is a fingerprint difference we did not choose.
///
/// No test here touches the network: `ChatHTTP` is the only egress and `ScriptedChatHTTP` is the
/// only implementation these tests ever construct.
final class CodexAuthTests: XCTestCase {

    // MARK: - parity constants

    /// `originator: "norma"` is a DELIBERATE ToS decision (codex-config.ts's long comment): Norma
    /// self-identifies rather than impersonating codex-rs's first-party `codex_cli_rs`. This test
    /// exists to make reverting it to a first-party value a red build, on the phone as on the Mac.
    func testShippedConfigMatchesCodexConfigTsLiterally() {
        let c = CodexConfig.codex
        XCTAssertEqual(c.clientId, "app_EMoamEEZ73f0CkXaXp7hrann")
        XCTAssertEqual(c.authorizeURL.absoluteString, "https://auth.openai.com/oauth/authorize")
        XCTAssertEqual(c.tokenURL.absoluteString, "https://auth.openai.com/oauth/token")
        XCTAssertEqual(c.scope, "openid profile email offline_access api.connectors.read api.connectors.invoke")
        XCTAssertEqual(c.backendURL.absoluteString, "https://chatgpt.com/backend-api/codex")
        XCTAssertEqual(c.redirectURI, "http://localhost:1455/auth/callback")
        XCTAssertEqual(c.headers["OpenAI-Beta"], "responses=experimental")
        XCTAssertEqual(c.headers["originator"], "norma")
        XCTAssertEqual(c.headers.count, 2)
    }

    /// The originator literal on an actual recorded request — the shape Task 8's ResponsesClient
    /// sends. Mirrors `codex-oauth.ts`'s `post()` header block exactly.
    func testResponsesRequestCarriesOriginatorNorma() {
        let request = CodexConfig.codex.responsesRequest(
            accessToken: "at_1", accountId: "acct_42", body: Data("{}".utf8))
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://chatgpt.com/backend-api/codex/responses")
        XCTAssertEqual(request.value(forHTTPHeaderField: "originator"), "norma")
        XCTAssertEqual(request.value(forHTTPHeaderField: "OpenAI-Beta"), "responses=experimental")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer at_1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "chatgpt-account-id"), "acct_42")
        XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/json")
        XCTAssertEqual(request.httpBody, Data("{}".utf8))
    }

    /// TS spreads `...(tokens.accountId ? {...} : {})` — a nil account must omit the header, not
    /// send an empty one.
    func testResponsesRequestOmitsAccountHeaderWhenUnknown() {
        let request = CodexConfig.codex.responsesRequest(
            accessToken: "at_1", accountId: nil, body: Data())
        XCTAssertNil(request.value(forHTTPHeaderField: "chatgpt-account-id"))
    }

    // MARK: - PKCE

    /// RFC 7636 Appendix B's published vector — an external check that the S256 derivation is
    /// right, not just self-consistent.
    func testPkceChallengeMatchesRfc7636Vector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    /// pkce.ts: `randomBytes(48).toString("base64url")` → 64 chars, inside RFC's 43…128.
    func testGeneratedVerifierMatchesTsShape() {
        let a = PKCE.generate()
        let b = PKCE.generate()
        XCTAssertEqual(a.verifier.count, 64)
        XCTAssertNotEqual(a.verifier, b.verifier)
        XCTAssertNil(a.verifier.range(of: "[^A-Za-z0-9_-]", options: .regularExpression),
                     "verifier must be base64url with no padding")
        XCTAssertEqual(a.challenge.count, 43)
        XCTAssertNil(a.challenge.range(of: "[^A-Za-z0-9_-]", options: .regularExpression))
        let expected = AuthFixture.base64url(Data(SHA256.hash(data: Data(a.verifier.utf8))))
        XCTAssertEqual(a.challenge, expected)
    }

    // MARK: - authorize URL

    /// Byte-exact against `pkce.ts`'s `new URLSearchParams({...}).toString()` — same seven params,
    /// same ORDER, same application/x-www-form-urlencoded escaping (space → `+`).
    func testAuthorizeURLIsByteCompatibleWithTs() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let handle = CodexAuth(config: config).beginFlow(pkce: pkce, state: "st_1")
        XCTAssertEqual(handle.authorizationURL.absoluteString, """
        https://auth.test.invalid/oauth/authorize?response_type=code&client_id=app_test\
        &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback\
        &scope=openid+profile+email+offline_access&state=st_1\
        &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256
        """)
        XCTAssertEqual(handle.state, "st_1")
        XCTAssertEqual(handle.redirectURI, "http://localhost:1455/auth/callback")
    }

    /// pkce.ts: `randomBytes(16).toString("base64url")` → 22 chars.
    func testGeneratedStateIsUnguessable() {
        let a = CodexAuth.randomState()
        XCTAssertEqual(a.count, 22)
        XCTAssertNotEqual(a, CodexAuth.randomState())
        XCTAssertNil(a.range(of: "[^A-Za-z0-9_-]", options: .regularExpression))
    }

    // MARK: - token exchange

    func testTokenExchangeRequestIsByteCompatibleWithTs() async throws {
        let http = ScriptedChatHTTP([.json(["access_token": "at_1", "expires_in": 3600])])
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let handle = CodexAuth(config: config).beginFlow(pkce: pkce, state: "st_1")
        _ = try await handle.complete(
            callbackURL: URL(string: "http://localhost:1455/auth/callback?code=authcode_1&state=st_1")!,
            http: http, now: { t0 })

        XCTAssertEqual(http.requestCount, 1)
        let request = http.requests[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://auth.test.invalid/oauth/token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/x-www-form-urlencoded")
        // pkce.ts sends exactly ONE header — no originator, no OpenAI-Beta on the auth endpoint.
        XCTAssertEqual(request.allHTTPHeaderFields?.count, 1)
        XCTAssertEqual(http.bodyString(), """
        grant_type=authorization_code&client_id=app_test&code=authcode_1\
        &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback\
        &code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
        """)
    }

    func testTokenExchangeDecodesTokensAndAccountId() async throws {
        let http = ScriptedChatHTTP([.json([
            "access_token": "at_1", "refresh_token": "rt_1",
            "id_token": AuthFixture.idToken(account: "acct_42"), "expires_in": 3600,
        ])])
        let handle = CodexAuth(config: config).beginFlow(pkce: PKCE.generate(), state: "st_1")
        let tokens = try await handle.complete(
            callbackURL: URL(string: "http://localhost:1455/auth/callback?code=c&state=st_1")!,
            http: http, now: { t0 })

        XCTAssertEqual(tokens.accessToken, "at_1")
        XCTAssertEqual(tokens.refreshToken, "rt_1")
        XCTAssertEqual(tokens.accountId, "acct_42")
        XCTAssertEqual(tokens.expiresAt, t0.addingTimeInterval(3600))
    }

    /// pkce.ts: `expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000`.
    func testMissingExpiresInDefaultsToOneHour() async throws {
        let http = ScriptedChatHTTP([.json(["access_token": "at_1"])])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        let tokens = try await handle.complete(
            callbackURL: URL(string: "http://localhost:1455/auth/callback?code=c&state=st_1")!,
            http: http, now: { t0 })
        XCTAssertEqual(tokens.expiresAt, t0.addingTimeInterval(3600))
        XCTAssertNil(tokens.refreshToken)
        XCTAssertNil(tokens.idToken)
        XCTAssertNil(tokens.accountId)
    }

    /// The TS callback server checks `state` BEFORE it looks at `code` — a CSRF'd callback must
    /// never reach the token endpoint, even when it carries a plausible code.
    func testStateMismatchIsRejectedBeforeAnyHttp() async {
        let http = ScriptedChatHTTP([.json(["access_token": "should_never_be_requested"])])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        await XCTAssertThrowsErrorAsync(
            try await handle.complete(
                callbackURL: URL(string: "http://localhost:1455/auth/callback?code=evil&state=WRONG")!,
                http: http, now: { t0 })
        ) { XCTAssertEqual($0 as? CodexAuthError, .stateMismatch) }
        XCTAssertEqual(http.requestCount, 0)
    }

    func testCallbackWithoutCodeIsRejectedBeforeAnyHttp() async {
        let http = ScriptedChatHTTP([.json(["access_token": "should_never_be_requested"])])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        await XCTAssertThrowsErrorAsync(
            try await handle.complete(
                callbackURL: URL(string: "http://localhost:1455/auth/callback?state=st_1")!,
                http: http, now: { t0 })
        ) { XCTAssertEqual($0 as? CodexAuthError, .missingCode) }
        XCTAssertEqual(http.requestCount, 0)
    }

    /// pkce.ts: `token exchange failed: HTTP ${status}${snippet ? ` — ${snippet}` : ""}`, body
    /// sliced to 200 chars.
    func testTokenExchangeFailureIsTypedAndCarriesABoundedBodySnippet() async {
        let long = String(repeating: "x", count: 500)
        let http = ScriptedChatHTTP([.text(long, status: 400)])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        await XCTAssertThrowsErrorAsync(
            try await handle.complete(
                callbackURL: URL(string: "http://localhost:1455/auth/callback?code=c&state=st_1")!,
                http: http, now: { t0 })
        ) { error in
            guard case .tokenExchangeFailed(let status, let body)? = error as? CodexAuthError else {
                return XCTFail("expected .tokenExchangeFailed, got \(error)")
            }
            XCTAssertEqual(status, 400)
            XCTAssertEqual(body.count, 200)
            XCTAssertEqual("\(CodexAuthError.tokenExchangeFailed(status: 400, body: "boom"))",
                           "token exchange failed: HTTP 400 — boom")
            XCTAssertEqual("\(CodexAuthError.tokenExchangeFailed(status: 400, body: ""))",
                           "token exchange failed: HTTP 400")
        }
    }

    func testMalformedTokenResponseIsTyped() async {
        let http = ScriptedChatHTTP([.text("not json at all", status: 200)])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        await XCTAssertThrowsErrorAsync(
            try await handle.complete(
                callbackURL: URL(string: "http://localhost:1455/auth/callback?code=c&state=st_1")!,
                http: http, now: { t0 })
        ) { XCTAssertEqual($0 as? CodexAuthError, .malformedTokenResponse) }
    }

    /// A transport failure is NOT an auth error — it propagates untouched so the caller can retry.
    func testTransportFailurePropagates() async {
        let http = ScriptedChatHTTP([.failure(FakeTransportError())])
        let handle = CodexAuth(config: config).beginFlow(state: "st_1")
        await XCTAssertThrowsErrorAsync(
            try await handle.complete(
                callbackURL: URL(string: "http://localhost:1455/auth/callback?code=c&state=st_1")!,
                http: http, now: { t0 })
        ) { XCTAssertEqual($0 as? FakeTransportError, FakeTransportError()) }
    }

    // MARK: - whole flow through the browser leg

    /// The platform seam: on iOS the closure is an `ASWebAuthenticationSession`; here it is the
    /// same "user completes auth" simulation the TS test does in `openBrowser`.
    func testSignInDrivesTheBrowserLegAndExchangesTheCode() async throws {
        let http = ScriptedChatHTTP([.json([
            "access_token": "at_1", "refresh_token": "rt_1",
            "id_token": AuthFixture.idToken(account: "acct_42"), "expires_in": 3600,
        ])])
        let seen = Recorder<URL>()
        let tokens = try await CodexAuth(config: config).signIn(http: http, browser: { url in
            seen.record(url)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            let state = items.first { $0.name == "state" }!.value!
            let redirect = items.first { $0.name == "redirect_uri" }!.value!
            return URL(string: "\(redirect)?code=authcode_1&state=\(state)")!
        }, now: { t0 })

        XCTAssertEqual(tokens.accessToken, "at_1")
        XCTAssertEqual(tokens.accountId, "acct_42")
        XCTAssertEqual(seen.values.count, 1)
        XCTAssertEqual(seen.values.first?.host, "auth.test.invalid")
        XCTAssertTrue(http.bodyString().contains("code=authcode_1"))
    }

    /// User cancelled the sheet: the browser leg's error is the caller's error, and nothing was
    /// exchanged.
    func testSignInPropagatesBrowserLegFailure() async {
        let http = ScriptedChatHTTP([])
        await XCTAssertThrowsErrorAsync(
            try await CodexAuth(config: config).signIn(http: http, browser: { _ in
                throw FakeTransportError()
            }, now: { t0 })
        ) { XCTAssertEqual($0 as? FakeTransportError, FakeTransportError()) }
        XCTAssertEqual(http.requestCount, 0)
    }

    /// Two flows must never share a verifier/state.
    func testEachFlowGetsFreshPkceAndState() {
        let auth = CodexAuth(config: config)
        let a = auth.beginFlow()
        let b = auth.beginFlow()
        XCTAssertNotEqual(a.state, b.state)
        XCTAssertNotEqual(a.authorizationURL, b.authorizationURL)
    }

    // MARK: - refresh

    /// The margin is the ONE place this port deliberately adds to the TS (which refreshes only
    /// reactively on HTTP 401). Pinned so a silent change is a red build.
    func testRefreshMarginIsSixtySeconds() {
        XCTAssertEqual(TokenState.refreshMargin, 60)
    }

    func testNeedsRefreshBoundaryMath() {
        let expiry = t0.addingTimeInterval(3600)
        let state = TokenState(accessToken: "at_1", refreshToken: "rt_1", expiresAt: expiry)
        XCTAssertFalse(state.needsRefresh(now: t0))
        XCTAssertFalse(state.needsRefresh(now: expiry.addingTimeInterval(-61)))
        // Boundary is INCLUSIVE: at exactly `expiresAt - margin` the token is due.
        XCTAssertTrue(state.needsRefresh(now: expiry.addingTimeInterval(-60)))
        XCTAssertTrue(state.needsRefresh(now: expiry))
        XCTAssertTrue(state.needsRefresh(now: expiry.addingTimeInterval(1)))
        // An explicit margin overrides the default.
        XCTAssertFalse(state.needsRefresh(now: expiry.addingTimeInterval(-60), margin: 30))
    }

    func testRefreshIfNeededIsANoOpWhileFresh() async throws {
        let http = ScriptedChatHTTP([.json(["access_token": "must_not_be_fetched"])])
        var state = TokenState(accessToken: "at_1", refreshToken: "rt_1",
                               expiresAt: t0.addingTimeInterval(3600))
        let refreshed = try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        XCTAssertFalse(refreshed)
        XCTAssertEqual(state.accessToken, "at_1")
        XCTAssertEqual(http.requestCount, 0)
    }

    func testRefreshRequestIsByteCompatibleWithTs() async throws {
        let http = ScriptedChatHTTP([.json(["access_token": "at_2", "expires_in": 3600])])
        var state = TokenState(accessToken: "at_1", refreshToken: "rt_1", expiresAt: t0)
        let refreshed = try await state.refreshIfNeeded(http: http, config: config, now: { t0 })

        XCTAssertTrue(refreshed)
        XCTAssertEqual(state.accessToken, "at_2")
        XCTAssertEqual(state.expiresAt, t0.addingTimeInterval(3600))
        XCTAssertEqual(http.requestCount, 1)
        XCTAssertEqual(http.requests[0].url?.absoluteString, "https://auth.test.invalid/oauth/token")
        XCTAssertEqual(http.requests[0].value(forHTTPHeaderField: "content-type"),
                       "application/x-www-form-urlencoded")
        XCTAssertEqual(http.bodyString(), "grant_type=refresh_token&client_id=app_test&refresh_token=rt_1")
    }

    /// codex-oauth.ts: "refresh grants usually return no id_token and may not rotate the refresh
    /// token: never let nulls clobber known-good identity fields."
    func testRefreshNeverClobbersIdentityWithNulls() async throws {
        let http = ScriptedChatHTTP([.json(["access_token": "at_2", "expires_in": 3600])])
        var state = TokenState(accessToken: "at_1", refreshToken: "rt_1",
                               idToken: AuthFixture.idToken(account: "acct_42"),
                               accountId: "acct_42", expiresAt: t0)
        _ = try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        XCTAssertEqual(state.accessToken, "at_2")
        XCTAssertEqual(state.refreshToken, "rt_1")
        XCTAssertEqual(state.accountId, "acct_42")
        XCTAssertEqual(state.idToken, AuthFixture.idToken(account: "acct_42"))
    }

    func testRefreshAdoptsRotatedIdentityWhenPresent() async throws {
        let http = ScriptedChatHTTP([.json([
            "access_token": "at_2", "refresh_token": "rt_2",
            "id_token": AuthFixture.idToken(account: "acct_99"), "expires_in": 3600,
        ])])
        var state = TokenState(accessToken: "at_1", refreshToken: "rt_1",
                               idToken: AuthFixture.idToken(account: "acct_42"),
                               accountId: "acct_42", expiresAt: t0)
        _ = try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        XCTAssertEqual(state.refreshToken, "rt_2")
        XCTAssertEqual(state.accountId, "acct_99")
    }

    /// A failed refresh must leave the stored state untouched — the caller decides whether to
    /// re-run the whole flow (the TS's "run: norma login" branch).
    func testRefreshFailureIsTypedAndLeavesStateUntouched() async {
        let http = ScriptedChatHTTP([.text(#"{"error":"invalid_grant"}"#, status: 401)])
        var state = TokenState(accessToken: "at_1", refreshToken: "rt_1", expiresAt: t0)
        await XCTAssertThrowsErrorAsync(
            try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        ) { error in
            guard case .tokenExchangeFailed(let status, let body)? = error as? CodexAuthError else {
                return XCTFail("expected .tokenExchangeFailed, got \(error)")
            }
            XCTAssertEqual(status, 401)
            XCTAssertTrue(body.contains("invalid_grant"))
        }
        XCTAssertEqual(state.accessToken, "at_1")
        XCTAssertEqual(state.refreshToken, "rt_1")
        XCTAssertEqual(state.expiresAt, t0)
    }

    /// Never leak the credential we sent: the refresh token must not appear in the error text.
    func testRefreshErrorNeverEchoesTheRefreshToken() async {
        let http = ScriptedChatHTTP([.text("invalid_grant", status: 400)])
        var state = TokenState(accessToken: "at_1", refreshToken: "super_secret_rt", expiresAt: t0)
        await XCTAssertThrowsErrorAsync(
            try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        ) { XCTAssertFalse("\($0)".contains("super_secret_rt")) }
    }

    func testRefreshWithoutARefreshTokenIsTypedAndMakesNoRequest() async {
        let http = ScriptedChatHTTP([.json(["access_token": "must_not_be_fetched"])])
        var state = TokenState(accessToken: "at_1", refreshToken: nil, expiresAt: t0)
        await XCTAssertThrowsErrorAsync(
            try await state.refreshIfNeeded(http: http, config: config, now: { t0 })
        ) { XCTAssertEqual($0 as? CodexAuthError, .missingRefreshToken) }
        XCTAssertEqual(http.requestCount, 0)
    }

    // MARK: - account id decoding

    /// Mirrors the TS test: real claim decodes, junk is nil rather than a throw.
    func testDecodeAccountId() {
        XCTAssertEqual(CodexAuth.decodeAccountId(idToken: AuthFixture.idToken(account: "acct_9")), "acct_9")
        XCTAssertNil(CodexAuth.decodeAccountId(idToken: "not.a.jwt"))
        XCTAssertNil(CodexAuth.decodeAccountId(idToken: "nodots"))
        XCTAssertNil(CodexAuth.decodeAccountId(idToken: "h.\(AuthFixture.base64url(Data(#"{"sub":"x"}"#.utf8))).s"))
    }
}

// MARK: - helpers

/// XCTAssertThrowsError has no async form in this toolchain's XCTest.
func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath, line: UInt = #line,
    _ verify: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error to be thrown", file: file, line: line)
    } catch {
        verify(error)
    }
}

final class Recorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [T] = []
    var values: [T] { lock.lock(); defer { lock.unlock() }; return storage }
    func record(_ value: T) { lock.lock(); storage.append(value); lock.unlock() }
}
