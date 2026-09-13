import XCTest
import WinterKit
@testable import Winter

/// Winter Phase 10a Task A2: `AnthropicLoginSheetModel` — the "Waiting for your browser…" sheet's
/// state machine. Drives it against `FakeAnthropicAuthClient`'s scripted `loginUpdates()` stream
/// (no socket/transport involved). Uses `feedWaitUntil` (`SessionFeedTests.swift`, shared target-
/// wide, same posture as `ProviderPaneModelTests`'s own reuse of it) to await the model's
/// `@Published` state catching up to an emitted stream event, since delivery crosses a real
/// `Task` boundary (`AnthropicLoginSheetModel.start()`'s own consuming task).
@MainActor
final class AnthropicLoginSheetModelTests: XCTestCase {
    // MARK: - line → URL extraction

    /// Fix round 1, MAJOR: the extracted URL must have its query (where the one-time code lives)
    /// stripped — `?code=abc123` must be GONE, not merely hidden behind a generic link label.
    func testUrlFallbackExtractsHttpsUrlFromLine() {
        let url = AnthropicLoginSheetModel.urlFallback(in: "Open this to continue: https://console.anthropic.com/oauth?code=abc123")
        XCTAssertEqual(url?.absoluteString, "https://console.anthropic.com/oauth")
        XCTAssertFalse(url?.absoluteString.contains("code=") ?? true)
    }

    /// A fragment (`#...`) must be stripped too, same as a query.
    func testUrlFallbackStripsFragmentToo() {
        let url = AnthropicLoginSheetModel.urlFallback(in: "https://console.anthropic.com/oauth#code=abc123")
        XCTAssertEqual(url?.absoluteString, "https://console.anthropic.com/oauth")
    }

    func testUrlFallbackReturnsNilWhenLineHasNoUrl() {
        XCTAssertNil(AnthropicLoginSheetModel.urlFallback(in: "waiting for the browser…"))
    }

    // MARK: - displayLines (fix round 1, MAJOR: never render a code-carrying line as plain text)

    /// A line with NO extractable URL that still contains `code=` must be dropped entirely.
    func testDisplayLinesDropsNonUrlLineContainingCode() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)
        await model.start()
        fake.emit(.progress("your code=abc123 is shown on the page"))
        fake.emit(.progress("waiting for the browser…"))

        await feedWaitUntil { model.lines.count >= 2 }
        XCTAssertEqual(model.displayLines, ["waiting for the browser…"])
    }

    /// A line WITH an extractable URL is kept even though its raw text contains `code=` — it's
    /// rendered as a fixed-label `Link` to the SANITIZED url, never as the raw line.
    func testDisplayLinesKeepsUrlLineEvenThoughItContainsCode() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)
        await model.start()
        fake.emit(.progress("Open https://console.anthropic.com/oauth?code=abc123 to continue"))

        await feedWaitUntil { !model.lines.isEmpty }
        XCTAssertEqual(model.displayLines, ["Open https://console.anthropic.com/oauth?code=abc123 to continue"])
    }

    // MARK: - success/failure transitions

    /// `start()` subscribes to `loginUpdates()` before `login()` even resolves — a progress line
    /// emitted right after `start()` returns must still reach `model.lines`, and the fallback URL
    /// inside it must be extractable via the pure helper above.
    func testStartAppendsProgressLinesAsTheyArrive() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)

        await model.start()
        XCTAssertEqual(fake.loginCallCount, 1)
        fake.emit(.progress("Open https://console.anthropic.com/oauth to continue"))

        await feedWaitUntil { !model.lines.isEmpty }
        XCTAssertEqual(model.lines, ["Open https://console.anthropic.com/oauth to continue"])
        XCTAssertEqual(model.phase, .waiting)
    }

    /// `provider_login_finished { ok: true }` → `.success`.
    func testFinishedOkTransitionsToSuccess() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)

        await model.start()
        fake.emit(.finished(ok: true, reason: nil))

        await feedWaitUntil { model.phase != .waiting }
        XCTAssertEqual(model.phase, .success)
    }

    /// `provider_login_finished { ok: false, reason }` → `.failure(reason)`.
    func testFinishedNotOkTransitionsToFailureWithReason() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)

        await model.start()
        fake.emit(.finished(ok: false, reason: "the code was rejected"))

        await feedWaitUntil { model.phase != .waiting }
        XCTAssertEqual(model.phase, .failure(reason: "the code was rejected"))
    }

    /// `login()` itself throwing (the daemon couldn't even start the login binary) is a `.failure`
    /// too — the SAME terminal shape as a later `provider_login_finished` reporting one, just
    /// discovered synchronously instead of over the stream.
    func testLoginThrowingTransitionsToFailureImmediately() async {
        let fake = FakeAnthropicAuthClient()
        fake.loginResult = .failure(FakeAnthropicAuthClient.SimpleError())
        let model = AnthropicLoginSheetModel(client: fake)

        await model.start()

        XCTAssertEqual(model.phase, .failure(reason: "couldn't start sign-in"))
    }

    // MARK: - code submit

    /// The trimmed code reaches `submitLoginCode` exactly once, and the field is cleared
    /// immediately regardless of the RPC's outcome (a one-time secret, never retained for a retry).
    func testSubmitCodeCallsRpcWithTrimmedCodeOnceAndClearsField() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)
        model.code = "  ABC-123  "

        await model.submitCode()

        XCTAssertEqual(fake.submitLoginCodeCalls, ["ABC-123"])
        XCTAssertEqual(model.code, "")
        XCTAssertNil(model.submitErrorText)
        XCTAssertFalse(model.submitting)
    }

    /// An empty (or whitespace-only) code never reaches the RPC.
    func testSubmitCodeSkipsRpcWhenFieldIsEmpty() async {
        let fake = FakeAnthropicAuthClient()
        let model = AnthropicLoginSheetModel(client: fake)
        model.code = "   "

        await model.submitCode()

        XCTAssertTrue(fake.submitLoginCodeCalls.isEmpty)
    }

    /// A thrown `submitLoginCode` surfaces as `submitErrorText` — the field still cleared (the code
    /// was already sent to the wire once; it is not retained regardless of the reply).
    func testSubmitCodeErrorSurfacesAsSubmitErrorText() async {
        let fake = FakeAnthropicAuthClient()
        fake.submitLoginCodeResult = .failure(FakeAnthropicAuthClient.SimpleError())
        let model = AnthropicLoginSheetModel(client: fake)
        model.code = "wrong-code"

        await model.submitCode()

        XCTAssertNotNil(model.submitErrorText)
        XCTAssertEqual(model.code, "")
        XCTAssertFalse(model.submitting)
    }
}
