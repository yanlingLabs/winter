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
            issuerOrigin: "https://mcp.linear.app"
        ))
        let model = makeModel(fake: fake, issuerOriginHint: "https://stale.example")

        await model.start()

        XCTAssertEqual(fake.loginCalls, ["linear"])
        XCTAssertEqual(model.phase, .confirmOrigin(issuerOrigin: "https://mcp.linear.app"))
        XCTAssertEqual(model.authUrl?.absoluteString, "https://mcp.linear.app/authorize?state=xyz")
    }

    /// `mcp.login` throwing is a `.failure`, discovered synchronously — same terminal shape as a
    /// later poll failure.
    func testStartFailureTransitionsToFailureImmediately() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .failure(FakeMcpAuthClient.SimpleError())
        let model = makeModel(fake: fake)

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "couldn't start sign-in"))
    }

    /// `continueSignIn()` opens the (unsanitized, query-and-all) `authUrl` exactly once and moves to
    /// `.waiting` — the ONE point this model ever touches a browser.
    func testContinueSignInOpensTheAuthUrlOnceAndStartsWaiting() async {
        let fake = FakeMcpAuthClient()
        fake.loginResult = .success(McpLoginStart(
            loginId: "lg_1", authUrl: URL(string: "https://mcp.linear.app/authorize?state=xyz")!,
            issuerOrigin: "https://mcp.linear.app"
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
}
