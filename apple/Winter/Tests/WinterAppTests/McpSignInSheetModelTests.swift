import XCTest
import WinterKit
@testable import Winter

/// WS-25 (MCP OAuth): `mcpSignInPollOutcome`'s pure state machine, then `McpSignInSheetModel`
/// driven against `FakeMcpAuthClient` with an injected no-op/fast `sleep` and a recording `openURL`
/// — no socket/transport, and no real browser ever opens.
@MainActor
final class McpSignInSheetModelTests: XCTestCase {
    // MARK: - mcpSignInPollOutcome (pure)

    func testDoneIsSuccess() {
        let outcome = mcpSignInPollOutcome(status: McpLoginStatus(state: .done), attempt: 1, maxAttempts: 300)
        XCTAssertEqual(outcome, .success)
    }

    func testFailedUsesTheDaemonsErrorWhenGiven() {
        let outcome = mcpSignInPollOutcome(
            status: McpLoginStatus(state: .failed, error: "the authorization server refused"),
            attempt: 1, maxAttempts: 300
        )
        XCTAssertEqual(outcome, .failed(reason: "the authorization server refused"))
    }

    func testFailedFallsBackToAGenericReasonWhenTheDaemonSendsNone() {
        let outcome = mcpSignInPollOutcome(status: McpLoginStatus(state: .failed), attempt: 1, maxAttempts: 300)
        XCTAssertEqual(outcome, .failed(reason: "sign-in failed"))
    }

    func testExpiredIsAFailureNamedExpired() {
        let outcome = mcpSignInPollOutcome(status: McpLoginStatus(state: .expired), attempt: 1, maxAttempts: 300)
        XCTAssertEqual(outcome, .failed(reason: "this sign-in attempt expired — try signing in again"))
    }

    func testPendingBelowTheCapKeepsWaiting() {
        let outcome = mcpSignInPollOutcome(status: McpLoginStatus(state: .pending), attempt: 299, maxAttempts: 300)
        XCTAssertEqual(outcome, .stillWaiting)
    }

    /// The CLIENT-SIDE cap, reached while the daemon still says pending — worded as a timeout, not
    /// as the daemon's own "expired" (this file's header note on the distinction).
    func testPendingAtTheCapIsAClientSideTimeout() {
        let outcome = mcpSignInPollOutcome(status: McpLoginStatus(state: .pending), attempt: 300, maxAttempts: 300)
        XCTAssertEqual(outcome, .failed(reason: "sign-in timed out — try again"))
    }

    /// An unrecognized state word (a newer daemon) is an IMMEDIATE failure, never extra pending
    /// attempts — naming the word so it's at least legible.
    func testUnknownStateIsAnImmediateFailureNamingTheWord() {
        let outcome = mcpSignInPollOutcome(
            status: McpLoginStatus(state: .unknown("stalled")), attempt: 1, maxAttempts: 300
        )
        if case .failed(let reason) = outcome {
            XCTAssertTrue(reason.contains("stalled"))
        } else {
            XCTFail("an unknown state must fail immediately, not keep waiting")
        }
    }

    // MARK: - mcpAuthErrorText / mcpAuthorizeOriginNote (pure, polish round 2)

    /// Every typed code the daemon-oauth lane's contract names maps to its own plain sentence.
    func testMcpAuthErrorTextMapsEveryTypedCode() {
        let cases: [(String, String)] = [
            ("mcp_server_not_found", "this server isn't configured"),
            ("mcp_oauth_not_applicable", "this server doesn't use sign-in"),
            ("mcp_oauth_config_invalid", "this server's sign-in configuration is invalid"),
            ("mcp_project_untrusted", "trust this project first"),
            ("mcp_scope_needs_cwd", "this action needs a project directory this panel doesn't have"),
            ("mcp_client_secret_unavailable", "no client secret is stored for this server"),
            ("mcp_client_secret_issuer_mismatch", "this server's sign-in configuration points somewhere it shouldn't"),
            ("mcp_login_failed", "sign-in failed"),
            ("mcp_secret_needs_user_scope", "client secrets can only be set at user scope"),
            ("mcp_not_preregistered", "this server has no pre-registered client to set a secret for"),
            ("mcp_discovery_failed", "couldn't discover this server's sign-in details"),
            // The SDK's own raw codes share the daemon-wrapped mismatch's wording.
            ("client_secret_issuer_mismatch", "this server's sign-in configuration points somewhere it shouldn't"),
            ("metadata_issuer_mismatch", "this server's sign-in configuration points somewhere it shouldn't"),
        ]
        for (code, expected) in cases {
            let error = RpcError(code: -1, message: "refused", data: .object(["code": .string(code)]))
            XCTAssertEqual(mcpAuthErrorText(error), expected, "code \(code)")
        }
    }

    /// `mcp_issuer_change_requires_confirmation` answers `nil` here — it drives its own confirmation
    /// phase and must never be shown as flat error text.
    func testMcpAuthErrorTextAnswersNilForTheIssuerChangeCode() {
        let error = RpcError(code: -1, message: "issuer changed", data: .object([
            "code": .string("mcp_issuer_change_requires_confirmation"),
        ]))
        XCTAssertNil(mcpAuthErrorText(error))
    }

    /// An untyped error (no `data.code` at all, or a code this build doesn't recognize) answers
    /// `nil` — every catch site falls back to its own generic sentence.
    func testMcpAuthErrorTextAnswersNilForUntypedOrUnrecognizedErrors() {
        XCTAssertNil(mcpAuthErrorText(FakeMcpAuthClient.SimpleError()))
        XCTAssertNil(mcpAuthErrorText(RpcError(code: -1, message: "plain")))
        XCTAssertNil(mcpAuthErrorText(RpcError(code: -1, message: "new",
                                                data: .object(["code": .string("mcp_something_newer")]))))
    }

    func testMcpAuthorizeOriginNoteIsNilWhenTheOriginsMatch() {
        XCTAssertNil(mcpAuthorizeOriginNote(issuerOrigin: "https://mcp.linear.app",
                                             authorizeOrigin: "https://mcp.linear.app"))
    }

    func testMcpAuthorizeOriginNoteNamesTheAuthorizeOriginWhenItDiffers() {
        XCTAssertEqual(
            mcpAuthorizeOriginNote(issuerOrigin: "https://mcp.linear.app", authorizeOrigin: "https://auth.linear.app"),
            "You'll sign in at https://auth.linear.app."
        )
    }

    // MARK: - McpSignInSheetModel

    private func makeModel(
        fake: FakeMcpAuthClient,
        issuerOriginHint: String? = nil,
        maxAttempts: Int = 300,
        openURL: @escaping (URL) -> Void = { _ in }
    ) -> McpSignInSheetModel {
        McpSignInSheetModel(
            client: fake, serverName: "linear", issuerOriginHint: issuerOriginHint,
            maxAttempts: maxAttempts, pollIntervalNanos: 1,
            openURL: openURL,
            sleep: { _ in }
        )
    }

    /// `start()` calls `mcp.login` and moves to `.confirmOrigin` with THAT call's own authoritative
    /// origin — never the row's hint, even when one was given.
    func testStartMovesToConfirmOriginWithLoginsOwnAuthoritativeOrigin() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .success(McpLoginStart(
            loginId: "lg_9", authUrl: URL(string: "https://mcp.linear.app/authorize?state=xyz")!,
            issuerOrigin: "https://mcp.linear.app", authorizeOrigin: "https://mcp.linear.app"
        ))
        let model = makeModel(fake: fake, issuerOriginHint: "https://stale.example")

        await model.start()

        XCTAssertEqual(fake.loginCalls.count, 1)
        XCTAssertEqual(fake.loginCalls[0].name, "linear")
        XCTAssertEqual(fake.loginCalls[0].confirmIssuerChange, false)
        XCTAssertEqual(model.phase, .confirmOrigin(issuerOrigin: "https://mcp.linear.app",
                                                    authorizeOrigin: "https://mcp.linear.app"))
        XCTAssertEqual(model.authUrl?.absoluteString, "https://mcp.linear.app/authorize?state=xyz")
    }

    /// `mcp.login` throwing an UNTYPED error is a `.failure` with the generic sentence, discovered
    /// synchronously — same terminal shape a later poll failure would produce.
    func testStartFailureTransitionsToFailureImmediately() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = makeModel(fake: fake)

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "couldn't start sign-in"))
    }

    /// A TYPED refusal (`error.data.code`) is mapped through `mcpAuthErrorText` instead of the
    /// generic "couldn't start sign-in" sentence.
    func testStartFailureUsesTheTypedErrorTextWhenTheCodeIsRecognized() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .failure(RpcError(code: -1, message: "refused",
                                              data: .object(["code": .string("mcp_project_untrusted")])))
        let model = makeModel(fake: fake)

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "trust this project first"))
    }

    /// `mcp.login` refused `mcp_issuer_change_requires_confirmation` moves to its OWN phase, never a
    /// flat failure — the sheet needs both origins to ask the user, not just a sentence.
    func testStartMovesToConfirmIssuerChangeOnThatTypedRefusal() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .failure(RpcError(code: -1, message: "issuer changed", data: .object([
            "code": .string("mcp_issuer_change_requires_confirmation"),
            "storedIssuerOrigin": .string("https://old.example"),
            "newIssuerOrigin": .string("https://new.example"),
        ])))
        let model = makeModel(fake: fake)

        await model.start()

        XCTAssertEqual(model.phase, .confirmIssuerChange(storedIssuerOrigin: "https://old.example",
                                                           newIssuerOrigin: "https://new.example"))
    }

    /// `confirmIssuerChangeAndRetry()` retries `mcp.login` with `confirmIssuerChange: true`, and a
    /// second success moves on to `.confirmOrigin` exactly like an ordinary first-try login.
    func testConfirmIssuerChangeAndRetryRetriesLoginWithTheFlagSet() async {
        let fake = FakeMcpAuthClient()
        fake.loginResults = [
            .failure(RpcError(code: -1, message: "issuer changed", data: .object([
                "code": .string("mcp_issuer_change_requires_confirmation"),
                "storedIssuerOrigin": .string("https://old.example"),
                "newIssuerOrigin": .string("https://new.example"),
            ]))),
            .success(McpLoginStart(
                loginId: "lg_2", authUrl: URL(string: "https://new.example/authorize")!,
                issuerOrigin: "https://new.example", authorizeOrigin: "https://new.example"
            )),
        ]
        let model = makeModel(fake: fake)
        await model.start()
        XCTAssertEqual(model.phase, .confirmIssuerChange(storedIssuerOrigin: "https://old.example",
                                                          newIssuerOrigin: "https://new.example"))

        await model.confirmIssuerChangeAndRetry()

        XCTAssertEqual(fake.loginCalls.count, 2)
        XCTAssertEqual(fake.loginCalls[1].confirmIssuerChange, true)
        XCTAssertEqual(model.phase, .confirmOrigin(issuerOrigin: "https://new.example",
                                                    authorizeOrigin: "https://new.example"))
    }

    /// A no-op from any phase other than `.confirmIssuerChange` — no stray retry from a second tap
    /// or a phase change that raced ahead of the button.
    func testConfirmIssuerChangeAndRetryIsANoOpOutsideThatPhase() async {
        let fake = FakeMcpAuthClient()
        let model = makeModel(fake: fake)
        await model.start() // moves to .confirmOrigin

        await model.confirmIssuerChangeAndRetry()

        XCTAssertEqual(fake.loginCalls.count, 1, "the retry must not have called login() again")
    }

    /// `continueSignIn()` opens the (unsanitized, query-and-all) `authUrl` exactly once and moves to
    /// `.waiting` — the ONE point this model ever touches a browser.
    func testContinueSignInOpensTheAuthUrlOnceAndStartsWaiting() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .success(McpLoginStart(
            loginId: "lg_1", authUrl: URL(string: "https://mcp.linear.app/authorize?state=xyz")!,
            issuerOrigin: "https://mcp.linear.app", authorizeOrigin: "https://mcp.linear.app"
        ))
        fake.loginStatusResults = [.success(McpLoginStatus(state: .pending))]
        var opened: [URL] = []
        let model = makeModel(fake: fake, openURL: { opened.append($0) })

        await model.start()
        model.continueSignIn()

        XCTAssertEqual(opened.map(\.absoluteString), ["https://mcp.linear.app/authorize?state=xyz"])
        await feedWaitUntil { model.phase == .waiting }
        model.cancel()
    }

    /// A no-op from any phase other than `.confirmOrigin` — no double-open from a stray second tap.
    func testContinueSignInIsANoOpBeforeConfirmOrigin() {
        let fake = FakeMcpAuthClient()
        var opened: [URL] = []
        let model = makeModel(fake: fake, openURL: { opened.append($0) })

        model.continueSignIn()

        XCTAssertTrue(opened.isEmpty)
        if case .starting = model.phase {} else { XCTFail("phase must stay .starting") }
    }

    /// The poll loop keeps going while the daemon says pending, then stops on `done`.
    func testPollingSucceedsAfterSeveralPendingReplies() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [
            .success(McpLoginStatus(state: .pending)),
            .success(McpLoginStatus(state: .pending)),
            .success(McpLoginStatus(state: .done)),
        ]
        let model = makeModel(fake: fake)
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { model.phase == .success }
        XCTAssertEqual(model.phase, .success)
        XCTAssertEqual(fake.loginStatusCalls.count, 3)
    }

    /// A thrown `loginStatus` (a transport hiccup mid-poll) is a plain, immediately-shown failure —
    /// never a silent retry loop.
    func testPollingFailsPlainlyWhenLoginStatusThrows() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [.failure(FakeMcpAuthClient.SimpleError())]
        let model = makeModel(fake: fake)
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { model.phase != .waiting }
        XCTAssertEqual(model.phase, .failure(reason: "couldn't check the sign-in status"))
    }

    /// A TYPED refusal from `loginStatus` is mapped through `mcpAuthErrorText` too, not just
    /// `login`'s own catch.
    func testPollingUsesTheTypedErrorTextWhenLoginStatusRefusesTyped() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [.failure(RpcError(code: -1, message: "gone",
                                                       data: .object(["code": .string("mcp_server_not_found")])))]
        let model = makeModel(fake: fake)
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { model.phase != .waiting }
        XCTAssertEqual(model.phase, .failure(reason: "this server isn't configured"))
    }

    /// The 5-minute cap, exercised with a small `maxAttempts` so the test stays fast — a permanently
    /// `.pending` daemon eventually times out on THIS side rather than polling forever.
    func testPollingTimesOutAtMaxAttempts() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [.success(McpLoginStatus(state: .pending))]
        let model = makeModel(fake: fake, maxAttempts: 3)
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { model.phase != .waiting }
        XCTAssertEqual(model.phase, .failure(reason: "sign-in timed out — try again"))
        XCTAssertEqual(fake.loginStatusCalls.count, 3)
    }

    /// `cancel()` stops the poll — no further `loginStatus` calls land after it, even though the
    /// fake would happily keep answering `.pending` forever.
    func testCancelStopsFurtherPolling() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [.success(McpLoginStatus(state: .pending))]
        // A real (short) delay per attempt so there is an actual window to cancel inside, rather
        // than the no-delay default racing every attempt through before `cancel()` runs.
        let model = McpSignInSheetModel(
            client: fake, serverName: "linear", issuerOriginHint: nil,
            maxAttempts: 100_000, pollIntervalNanos: 20_000_000,
            openURL: { _ in },
            sleep: { try? await Task.sleep(nanoseconds: $0) }
        )
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { fake.loginStatusCalls.count >= 1 }
        model.cancel()
        let countAtCancel = fake.loginStatusCalls.count
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(fake.loginStatusCalls.count, countAtCancel, "no poll may land after cancel()")
    }

    // MARK: - reportClose (polish round: Esc-after-done still refreshes)

    /// `reportClose()` returns `true` the FIRST time only — this is the guard
    /// `McpSignInSheet`'s `onDisappear` relies on to avoid a second `onAuthChanged()` round-trip
    /// when a button already reported the close before SwiftUI tore the sheet down.
    func testReportCloseReturnsTrueOnceThenFalse() {
        let fake = FakeMcpAuthClient()
        let model = makeModel(fake: fake)

        XCTAssertTrue(model.reportClose())
        XCTAssertFalse(model.reportClose())
        XCTAssertFalse(model.reportClose())
    }

    /// `reportClose()` stops polling too — same guarantee as `cancel()`, since it calls it.
    func testReportCloseStopsFurtherPolling() async {
        let fake = FakeMcpAuthClient()
        fake.loginStatusResults = [.success(McpLoginStatus(state: .pending))]
        let model = McpSignInSheetModel(
            client: fake, serverName: "linear", issuerOriginHint: nil,
            maxAttempts: 100_000, pollIntervalNanos: 20_000_000,
            openURL: { _ in },
            sleep: { try? await Task.sleep(nanoseconds: $0) }
        )
        await model.start()
        model.continueSignIn()

        await feedWaitUntil(2) { fake.loginStatusCalls.count >= 1 }
        model.reportClose()
        let countAtClose = fake.loginStatusCalls.count
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(fake.loginStatusCalls.count, countAtClose, "no poll may land after reportClose()")
    }
}
