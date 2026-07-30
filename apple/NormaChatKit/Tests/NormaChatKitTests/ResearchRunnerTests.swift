import Foundation
import XCTest
@testable import NormaChatKit

/// The ephemeral research sub-agent. Every test drives a SCRIPTED provider (no real model) and
/// `ScriptedChatHTTP` (no network). The load-bearing properties: FetchPage is the ONLY tool
/// (structural), the model/effort are the hardcoded research constants, the ONE model-fallback
/// retry fires on an unknown-model error but NOT a network error, and the deadline genuinely tears
/// down an in-flight fetch.
final class ResearchRunnerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeRunner(_ steps: [ScriptedChatHTTP.Step], timeout: TimeInterval = 30,
                            dangerousAdded: [String] = []) -> (ResearchRunner, ScriptedChatHTTP) {
        let http = ScriptedChatHTTP(steps)
        let cache = PageCache()
        let clock = t0
        let fetcher = PageFetcher(http: http, cache: cache, dangerousAdded: dangerousAdded,
                                  timeout: timeout, tool: "FetchPage", now: { clock })
        return (ResearchRunner(fetcher: fetcher, dangerousAdded: dangerousAdded), http)
    }

    // MARK: - happy path + structural tool check

    func testHappyPathReadsSeedFollowsALinkAndReturnsTheReport() async {
        let (runner, http) = makeRunner([
            .html("<p>See <a href=\"https://next.test/\">next</a></p>"),
            .html("<p>final content</p>"),
        ])
        let provider = ScriptedChatProvider([
            [fetchPageCall("c1", ["https://next.test/"]), .done(.toolCalls)],
            [.textDelta("Answer: 42. https://next.test/ lines:1-1"), .done(.endTurn)],
        ])

        let result = await runner.run(query: "what is X", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "Answer: 42. https://next.test/ lines:1-1")
        XCTAssertEqual(http.requestCount, 2, "one seed fetch + one FetchPage fetch")

        // Structural: FetchPage is the ONLY tool, and the research constants are what was sent.
        XCTAssertEqual(provider.request(0).tools.map(\.name), ["FetchPage"])
        XCTAssertEqual(provider.request(0).model, "gpt-5.4-mini")
        XCTAssertEqual(provider.request(0).reasoningEffort, "low")
        XCTAssertEqual(provider.request(0).instructions, ResearchRunner.systemPrompt)
        XCTAssertTrue(provider.request(0).messageText.contains("Research query: what is X"))
        XCTAssertTrue(provider.request(0).messageText.contains("https://seed.test/ (fresh fetch)"))
        // The fetched page is fed back to the model.
        XCTAssertTrue((provider.request(1).firstToolResultOutput ?? "").contains("https://next.test/ (fresh fetch)"))
    }

    // MARK: - model fallback (unknown-model ONLY)

    func testModelFallbackFiresExactlyOnceOnAnUnknownModelError() async {
        let (runner, _) = makeRunner([.html("<p>seed body</p>")])
        let provider = ScriptedChatProvider([
            [.error(ProviderError(code: .badRequest, message: "unknown model gpt-5.4-mini"))],
            [.textDelta("ok. https://seed.test/ lines:1-1"), .done(.endTurn)],
        ])

        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "ok. https://seed.test/ lines:1-1")
        XCTAssertEqual(provider.requestCount, 2, "one retry, no more")
        XCTAssertEqual(provider.request(0).model, "gpt-5.4-mini", "the primary model is tried first")
        XCTAssertEqual(provider.request(1).model, "gpt-5.6-luna", "the retry is on the fallback model")
    }

    /// The control the brief names: a NETWORK error must NOT burn the fallback — it is a hard failure
    /// on the primary model, with no second (luna) request.
    func testANetworkErrorDoesNotFallBack() async {
        let (runner, _) = makeRunner([.html("<p>seed body</p>")])
        let provider = ScriptedChatProvider([
            [.error(ProviderError(code: .network, message: "connection reset"))],
        ])

        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "provider error (network): connection reset. Pages read: 1.")
        XCTAssertEqual(provider.requestCount, 1, "no fallback request was ever made")
    }

    /// The fallback rule in isolation — the exact trigger criteria, so a future edit can't loosen it
    /// silently.
    func testLooksLikeBadModelErrorTriggerCriteria() {
        let model = "gpt-5.4-mini"
        func check(_ code: ProviderError.Code, _ message: String) -> Bool {
            ResearchRunner.looksLikeBadModelError(ProviderError(code: code, message: message), model: model)
        }
        XCTAssertTrue(check(.badRequest, "unknown model gpt-5.4-mini"))
        XCTAssertTrue(check(.server, "the model is deprecated"), "an unknown-model phrase retries regardless of code")
        XCTAssertTrue(check(.badRequest, "no such model: gpt-5.4-mini"), "a bad_request naming the current model retries")
        XCTAssertFalse(check(.badRequest, "gpt-5.4-mini's maximum context length is 128000"), "context length never retries")
        XCTAssertFalse(check(.network, "gpt-5.4-mini unreachable"), "naming the model under a non-bad_request code does not retry")
        XCTAssertFalse(check(.badRequest, "malformed function arguments"), "a bad_request not about the model does not retry")
    }

    // MARK: - deadline genuinely kills an in-flight fetch

    func testDeadlineKillsAnInFlightFetch() async {
        let (runner, _) = makeRunner([.html("<p>seed</p>"), .hang], timeout: 30)
        let provider = ScriptedChatProvider([
            [fetchPageCall("c1", ["https://slow.test/"]), .done(.toolCalls)],
        ])

        let started = ContinuousClock.now
        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .milliseconds(80))
        let elapsed = ContinuousClock.now - started

        // The proof the fetch was TORN DOWN, not waited out: the run returns far inside the scripted
        // 3600 s hang.
        XCTAssertLessThan(elapsed, .seconds(5), "the deadline cancelled the in-flight fetch")
        XCTAssertFalse(result.isError, "a timeout resolves with a partial report, never a hard error")
        XCTAssertTrue(result.content.contains("Research timed out before finishing"))
        XCTAssertTrue(result.content.contains("Not read: https://slow.test/"))
        XCTAssertTrue(result.content.contains("pages read: 2"))
    }

    // MARK: - budget + caps

    func testPageBudgetExhaustionIsInformationalNotAFailure() async {
        let (runner, _) = makeRunner([.html("<p>seed</p>"), .html("<p>p1</p>"), .html("<p>p2</p>")])
        let provider = ScriptedChatProvider([
            [fetchPageCall("c1", ["https://u1.test/", "https://u2.test/", "https://u3.test/", "https://u4.test/"]), .done(.toolCalls)],
            [.textDelta("done."), .done(.endTurn)],
        ])

        _ = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30), maxPages: 3)

        // seed(1) + 2 fetched = 3 (the budget); u3/u4 are skipped and stated.
        let toolResult = provider.request(1).firstToolResultOutput ?? ""
        XCTAssertTrue(toolResult.contains("page budget exhausted (3 pages read) — not fetched: https://u3.test/, https://u4.test/"))
    }

    func testAHugeFetchedPageIsCappedBeforeItReachesTheNextRequest() async {
        let bigHTML = "<p>" + String(repeating: "a", count: 30_000) + "</p>"
        let (runner, _) = makeRunner([.html("<p>seed</p>"), .html(bigHTML)])
        let provider = ScriptedChatProvider([
            [fetchPageCall("c1", ["https://big.test/"]), .done(.toolCalls)],
            [.textDelta("done. https://big.test/ lines:1-1"), .done(.endTurn)],
        ])

        _ = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        let toolResult = provider.request(1).firstToolResultOutput ?? ""
        XCTAssertLessThanOrEqual(toolResult.utf16.count, ReadPageTool.perPageCharCap,
                                 "a single huge page is capped at the per-page ceiling")
        XCTAssertTrue(toolResult.contains("[page content truncated at 20000 chars"))
    }

    // MARK: - unknown tool + honest failures

    func testACallToAnyToolButFetchPageIsRejected() async {
        let (runner, _) = makeRunner([.html("<p>seed</p>")])
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Bash", argumentsJSON: "{}"), .done(.toolCalls)],
            [.textDelta("done."), .done(.endTurn)],
        ])

        _ = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertEqual(provider.request(1).firstToolResultOutput,
                       "unknown tool: Bash — only FetchPage is available in this run")
    }

    func testAnEmptyFinalReportIsAHardError() async {
        let (runner, _) = makeRunner([.html("<p>seed</p>")])
        let provider = ScriptedChatProvider([[.done(.endTurn)]])

        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "no report was produced — the model finished with no text (pages read: 1).")
    }

    func testAStreamThatEndsWithoutDoneIsAHardError() async {
        let (runner, _) = makeRunner([.html("<p>seed</p>")])
        let provider = ScriptedChatProvider([[]]) // no done, no error — ambiguous end

        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("the provider stream ended unexpectedly"))
    }

    // MARK: - seed failures

    func testAnHttpFailingSeedIsAHardError() async {
        let (runner, _) = makeRunner([.text("nope", status: 500)])
        let provider = ScriptedChatProvider([])

        let result = await runner.run(query: "q", urls: ["https://seed.test/"], provider: provider, deadline: .seconds(30))

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("could not read the seed page https://seed.test/"))
        XCTAssertEqual(provider.requestCount, 0, "no model call is made when the seed can't be read")
    }

    func testADangerousSeedIsRefusedBeforeAnyModelCall() async {
        let (runner, http) = makeRunner([])
        let provider = ScriptedChatProvider([])

        let result = await runner.run(query: "q", urls: ["https://pastebin.com/x"], provider: provider, deadline: .seconds(30))

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("pastebin.com"))
        XCTAssertEqual(http.requestCount, 0, "a blocked seed never reaches the network")
        XCTAssertEqual(provider.requestCount, 0)
    }

    // MARK: - clamp

    func testMaxPagesClamps() {
        XCTAssertEqual(ResearchRunner.clampMaxPages(nil), 5)
        XCTAssertEqual(ResearchRunner.clampMaxPages(0), 1)
        XCTAssertEqual(ResearchRunner.clampMaxPages(-4), 1)
        XCTAssertEqual(ResearchRunner.clampMaxPages(9), 9)
        XCTAssertEqual(ResearchRunner.clampMaxPages(100), 15)
    }
}
