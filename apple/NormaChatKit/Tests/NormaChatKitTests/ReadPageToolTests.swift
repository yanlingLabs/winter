import Foundation
import XCTest
@testable import NormaChatKit

/// ReadPage — the batched page-reading tool. Fetches ride `ScriptedChatHTTP`; the research seam is a
/// recording stub (the real runner is exercised in `ResearchRunnerTests`).
final class ReadPageToolTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeFetcher(_ steps: [ScriptedChatHTTP.Step], cache: PageCache,
                             dangerousAdded: [String] = [], timeout: TimeInterval = 5) -> (PageFetcher, ScriptedChatHTTP) {
        let http = ScriptedChatHTTP(steps)
        let clock = t0
        return (PageFetcher(http: http, cache: cache, dangerousAdded: dangerousAdded,
                            timeout: timeout, now: { clock }), http)
    }

    private func args(_ pages: [[String: Any]]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: ["pages": pages]), as: UTF8.self)
    }

    // MARK: - single page

    func testSinglePageIsCleanedNumberedCitedAndFresh() async {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([.html("<h1>Title</h1><p>Hello <a href=\"/next\">next</a>.</p>")], cache: cache)

        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x"]]), fetcher: fetcher)

        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.hasPrefix("https://docs.test/x\n"), "the resolved url is the first line")
        XCTAssertTrue(result.content.contains("Title — lines:1-"))
        XCTAssertTrue(result.content.contains("(fresh fetch)"))
        XCTAssertTrue(result.content.contains("1→"), "the body is 1-based line-numbered")
        XCTAssertTrue(result.content.contains("\nLinks:\n"))
        XCTAssertTrue(result.content.contains("https://docs.test/next"))
        XCTAssertEqual(http.requestCount, 1)
    }

    func testLineRangeSlicesAndTheHeaderReportsIt() async {
        let cache = PageCache()
        let html = "<p>one<br>two<br>three<br>four</p>"
        let (fetcher, _) = makeFetcher([.html(html)], cache: cache)

        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x", "lineStart": 2, "lineEnd": 3]]), fetcher: fetcher)

        XCTAssertTrue(result.content.contains("lines:2-3 of 4"))
        XCTAssertTrue(result.content.contains("2→two"))
        XCTAssertTrue(result.content.contains("3→three"))
        XCTAssertFalse(result.content.contains("1→one"))
        XCTAssertFalse(result.content.contains("4→four"))
    }

    func testACachedReadAnnouncesItselfAsCached() async {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([.html("<p>once</p>")], cache: cache)

        let first = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x"]]), fetcher: fetcher)
        let second = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x"]]), fetcher: fetcher)

        XCTAssertTrue(first.content.contains("(fresh fetch)"))
        XCTAssertTrue(second.content.contains("(cached)"), "a cache hit is stated so the model knows the bytes are unchanged")
        XCTAssertEqual(http.requestCount, 1, "the second read never re-fetches")
    }

    func testTheResolvedUrlIsCitedAfterARedirect() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/final"),
            .html("<p>final</p>"),
        ], cache: cache)

        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/start"]]), fetcher: fetcher)

        XCTAssertTrue(result.content.hasPrefix("requested: https://docs.test/start → resolved: https://docs.test/final\n"),
                      "the input is stated once; every citation after cites the resolved url")
    }

    // MARK: - dangerous domains

    func testDangerousUrlIsHardBlockedNamingTheReasonWithNoEgress() async {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([], cache: cache)

        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://raw.pastebin.com/secrets"]]), fetcher: fetcher)

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("pastebin.com"), "the refusal names the matched host")
        XCTAssertTrue(result.content.contains("ReadPage has no approval flow"))
        XCTAssertEqual(http.requestCount, 0, "blocked before any network")
    }

    func testDangerousLinksAreStrippedFromTheLinksTailWithACount() async {
        let cache = PageCache()
        let html = "<p><a href=\"https://pastebin.com/x\">paste</a> and <a href=\"https://safe.test/y\">safe</a></p>"
        let (fetcher, _) = makeFetcher([.html(html)], cache: cache)

        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x"]]), fetcher: fetcher)

        // The stripping targets the structured `Links:` TAIL — the inline body text still renders
        // links as `text (href)`, exactly as the TS does (only `page.links` is filtered).
        let tail = result.content.components(separatedBy: "\nLinks:\n").last ?? ""
        XCTAssertTrue(tail.contains("https://safe.test/y"), "the safe link is listed")
        XCTAssertFalse(tail.contains("pastebin.com"), "the dangerous link is never listed in the Links tail")
        XCTAssertTrue(tail.contains("(1 link withheld — matched the dangerous-domain list)"))
    }

    // MARK: - batching

    func testOneBadEntryDoesNotFailTheWholeBatch() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.html("<p>good page</p>")], cache: cache)

        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://docs.test/good"], ["url": "https://pastebin.com/bad"]]),
            fetcher: fetcher)

        XCTAssertFalse(result.isError, "a batch with any success is not an error")
        XCTAssertTrue(result.content.contains("## Page 1"))
        XCTAssertTrue(result.content.contains("## Page 2"))
        XCTAssertTrue(result.content.contains("good page"))
        XCTAssertTrue(result.content.contains("pastebin.com"), "the failed section names why it failed")
    }

    func testABatchWhereEveryEntryFailsIsAnError() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://pastebin.com/a"], ["url": "https://ngrok.io/b"]]),
            fetcher: fetcher)
        XCTAssertTrue(result.isError)
    }

    func testHttpFailureIsAnIsolatedEntryFailure() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.text("nope", status: 500)], cache: cache)
        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://docs.test/x"]]), fetcher: fetcher)
        XCTAssertTrue(result.isError, "a single failing entry surfaces as an error result")
        XCTAssertTrue(result.content.hasPrefix("https://docs.test/x: "), "the input url labels the failing section")
    }

    // MARK: - arg validation

    func testQueryAndLineRangeAreMutuallyExclusive() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://d.test/x", "query": "q", "lineStart": 1]]),
            fetcher: fetcher)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "query and line ranges are mutually exclusive per entry")
    }

    func testMalformedArgsJsonIsAnError() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let result = await ReadPageTool.run(argumentsJSON: "{ not json", fetcher: fetcher)
        XCTAssertTrue(result.isError)
    }

    func testEmptyPagesArrayIsAnError() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let result = await ReadPageTool.run(argumentsJSON: "{\"pages\":[]}", fetcher: fetcher)
        XCTAssertTrue(result.isError)
    }

    func testMoreThanEightPagesIsAnError() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let pages = (0 ..< 9).map { ["url": "https://d.test/\($0)"] }
        let result = await ReadPageTool.run(argumentsJSON: args(pages), fetcher: fetcher)
        XCTAssertTrue(result.isError)
    }

    // MARK: - research delegation

    func testQueryEntryDelegatesToTheResearchHook() async {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([], cache: cache)
        let recorder = RecordingResearchHook(response: ToolResult(callId: "", content: "RESEARCH REPORT", isError: false))

        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://seed.test/", "query": "how does X work", "max_pages": 7]]),
            fetcher: fetcher, research: recorder.hook)

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "RESEARCH REPORT")
        XCTAssertEqual(recorder.calls.count, 1)
        XCTAssertEqual(recorder.calls[0].query, "how does X work")
        XCTAssertEqual(recorder.calls[0].url, "https://seed.test/")
        XCTAssertEqual(recorder.calls[0].maxPages, 7)
        XCTAssertEqual(http.requestCount, 0, "the seed is fetched by the sub-agent, not ReadPage")
    }

    func testQueryEntryWithoutAResearchHookIsUnavailable() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let result = await ReadPageTool.run(argumentsJSON: args([["url": "https://seed.test/", "query": "q"]]), fetcher: fetcher)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "research is not available in this session yet")
    }

    func testAResearchFailureIsAnIsolatedEntryFailure() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.html("<p>ok</p>")], cache: cache)
        let recorder = RecordingResearchHook(response: ToolResult(callId: "", content: "could not read the seed page", isError: true))

        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://docs.test/ok"], ["url": "https://seed.test/", "query": "q"]]),
            fetcher: fetcher, research: recorder.hook)

        XCTAssertFalse(result.isError, "the plain page succeeded, so the batch is not an error")
        XCTAssertTrue(result.content.contains("could not read the seed page"))
    }

    func testDangerousSeedForAQueryEntryNeverStartsResearch() async {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([], cache: cache)
        let recorder = RecordingResearchHook(response: ToolResult(callId: "", content: "should not happen", isError: false))

        let result = await ReadPageTool.run(
            argumentsJSON: args([["url": "https://pastebin.com/x", "query": "q"]]),
            fetcher: fetcher, research: recorder.hook)

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.contains("research has no approval flow"))
        XCTAssertEqual(recorder.calls.count, 0, "a blocked seed never reaches the sub-agent")
    }
}

/// Records what ReadPage hands the research seam and returns a fixed `ToolResult`.
final class RecordingResearchHook: @unchecked Sendable {
    struct Call { let query: String; let url: String; let maxPages: Int? }
    private let lock = NSLock()
    private var storage: [Call] = []
    private let response: ToolResult

    init(response: ToolResult) { self.response = response }

    var calls: [Call] { lock.withLock { storage } }

    var hook: ReadPageTool.ResearchHook {
        { [self] query, url, maxPages, _ in
            lock.withLock { storage.append(Call(query: query, url: url, maxPages: maxPages)) }
            return response
        }
    }
}
