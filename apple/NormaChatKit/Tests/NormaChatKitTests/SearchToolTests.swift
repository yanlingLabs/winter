import Foundation
import XCTest
@testable import NormaChatKit

/// Search — the Exa-backed single-call web search. Every test drives `ScriptedChatHTTP`; none reach
/// the network. The two security properties (key never in an error string, dangerous results
/// stripped-and-counted) are pinned here, not just asserted in a comment.
final class SearchToolTests: XCTestCase {
    private let key = "exa-secret-key-abc123"

    private func exaBody(_ results: [[String: Any]]) -> ScriptedChatHTTP.Step {
        .json(["results": results])
    }

    // MARK: - happy path

    func testResultsAndExcerptsRenderInOneCallWithTheRightRequestBody() async {
        let http = ScriptedChatHTTP([exaBody([
            ["title": "First", "url": "https://a.test/1", "text": "excerpt one"],
            ["title": "Second", "url": "https://b.test/2", "text": "excerpt two"],
        ])])

        let result = await SearchTool.run(query: "swift concurrency", key: key, http: http)

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, """
        1. First
           https://a.test/1
           excerpt one

        2. Second
           https://b.test/2
           excerpt two
        """)
        XCTAssertEqual(http.requestCount, 1, "one call returns results AND excerpts — no second round-trip")
        // The single-call property: `contents` rides the same request body as `query`.
        let body = http.bodyString(0)
        XCTAssertTrue(body.contains("\"query\""))
        XCTAssertTrue(body.contains("\"numResults\""))
        XCTAssertTrue(body.contains("\"maxCharacters\""))
        XCTAssertEqual(http.requests[0].value(forHTTPHeaderField: "x-api-key"), key)
    }

    func testMissingExcerptRendersThePlaceholder() async {
        let http = ScriptedChatHTTP([exaBody([["title": "T", "url": "https://a.test/1"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("(no excerpt)"))
    }

    func testNoResultsIsStatedPlainly() async {
        let http = ScriptedChatHTTP([exaBody([])])
        let result = await SearchTool.run(query: "obscure thing", key: key, http: http)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "no results for obscure thing")
    }

    // MARK: - dangerous-result stripping (Critical 1)

    func testDangerousResultsAreStrippedAndTheWithheldCountIsStated() async {
        let http = ScriptedChatHTTP([exaBody([
            ["title": "Safe", "url": "https://a.test/1", "text": "keep me"],
            ["title": "Paste", "url": "https://raw.pastebin.com/xyz", "text": "secret dump"],
            ["title": "Tunnel", "url": "https://abc.ngrok.io/p", "text": "tunnelled"],
        ])])

        let result = await SearchTool.run(query: "q", key: key, http: http)

        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.contains("https://a.test/1"), "the safe result survives")
        XCTAssertFalse(result.content.contains("pastebin.com"), "a dangerous result is never shown to the model")
        XCTAssertFalse(result.content.contains("ngrok.io"))
        XCTAssertTrue(result.content.contains("[2 results withheld — matched the dangerous-domain list]"),
                      "the withheld count is stated so the filter is never silent")
    }

    func testASingleWithheldResultIsGrammaticallySingular() async {
        let http = ScriptedChatHTTP([exaBody([
            ["title": "Safe", "url": "https://a.test/1", "text": "keep"],
            ["title": "Paste", "url": "https://pastebin.com/x", "text": "dump"],
        ])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("[1 result withheld — matched the dangerous-domain list]"))
    }

    func testAllResultsWithheldStillStatesTheCount() async {
        let http = ScriptedChatHTTP([exaBody([["title": "P", "url": "https://pastebin.com/x", "text": "dump"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertEqual(result.content, "no results for q\n\n[1 result withheld — matched the dangerous-domain list]")
    }

    func testUserAddedDangerousDomainsAlsoStrip() async {
        let http = ScriptedChatHTTP([exaBody([["title": "Corp", "url": "https://drop.corp.test/f", "text": "x"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http, dangerousAdded: ["corp.test"])
        XCTAssertTrue(result.content.contains("[1 result withheld"))
    }

    // MARK: - the key never leaks

    func testNoKeyReturnsTheStoreAKeyError() async {
        let http = ScriptedChatHTTP([])
        let result = await SearchTool.run(query: "q", key: nil, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, SearchTool.noKeyMessage)
        XCTAssertEqual(http.requestCount, 0, "no key, no request")
    }

    func testEmptyKeyIsTreatedAsNoKey() async {
        let result = await SearchTool.run(query: "q", key: "", http: ScriptedChatHTTP([]))
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, SearchTool.noKeyMessage)
    }

    /// The load-bearing security test: a transport failure must NEVER carry the key (or any caught
    /// error detail) into the model-visible result.
    func testTheApiKeyNeverAppearsInAnyErrorString() async {
        let http = ScriptedChatHTTP([.failure(FakeTransportError())])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: could not reach the search service")
        XCTAssertFalse(result.content.contains(key), "the key must never reach the model or a log")
    }

    /// T7 review M4 (whole-branch ride-along). The key-on-redirect property was covered only through
    /// `PageFetcher`'s use of the SHARED non-following `sendCapped`; Search is the boundary that
    /// actually carries `x-api-key`, so the property is pinned HERE too. A 302 must be delivered as
    /// a result — never chased — so the key cannot ride an `Authorization`-style header to whatever
    /// host `Location` names. Asserted on request COUNT and on the requested host, because a
    /// following transport would show up as a second request and only as a second request.
    func testA302IsNeverFollowedSoTheApiKeyCannotReachTheRedirectTarget() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "https://attacker.test/collect")])
        let result = await SearchTool.run(query: "q", key: key, http: http)

        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: HTTP 302")
        XCTAssertFalse(result.content.contains(key))
        XCTAssertEqual(http.requestCount, 1, "the redirect TARGET is never even requested")
        XCTAssertEqual(http.requests[0].url?.host, "api.exa.ai")
        XCTAssertFalse(http.requests.contains { $0.url?.host == "attacker.test" })
        // …and the one request that DID carry the key went to Exa, nowhere else.
        for request in http.requests where request.value(forHTTPHeaderField: "x-api-key") != nil {
            XCTAssertEqual(request.url?.host, "api.exa.ai")
        }
    }

    // MARK: - failure classification

    func testHttpErrorStatusIsSurfacedWithoutABody() async {
        let http = ScriptedChatHTTP([.text("internal detail that must not surface", status: 503)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: HTTP 503")
    }

    func testMalformedResultsAreAParseError() async {
        let http = ScriptedChatHTTP([.json(["results": "not an array"])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: malformed response from search service")
    }

    func testUnparseableBodyIsAParseError() async {
        let http = ScriptedChatHTTP([.text("<html>not json</html>", status: 200)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: could not parse response")
    }

    func testAbsentResultsFieldIsNoResultsNotAnError() async {
        let http = ScriptedChatHTTP([.json(["somethingElse": 1])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "no results for q")
    }

    // MARK: - count clamp

    func testMaxResultsIsClampedToTheAllowedRange() async {
        let http = ScriptedChatHTTP([exaBody([["title": "T", "url": "https://a.test/1", "text": "x"]])])
        _ = await SearchTool.run(query: "q", key: key, http: http, maxResults: 999)
        // Body's numResults is clamped to MAX_RESULTS (10), never the model's 999.
        XCTAssertTrue(http.bodyString(0).contains("\"numResults\":10"))
    }
}
