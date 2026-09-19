import Foundation
import XCTest
@testable import WinterChatKit

/// Search — Exa's ANSWER mode, one call, a written answer plus its sources. Every test drives
/// `ScriptedChatHTTP`; none reach the network. The two security properties (the key never in an error
/// string, dangerous citations stripped-and-counted) are pinned here, not just asserted in a comment.
final class SearchToolTests: XCTestCase {
    private let key = "exa-secret-key-abc123"

    private func answerBody(_ answer: String?, _ citations: [[String: Any]]?) -> ScriptedChatHTTP.Step {
        var object: [String: Any] = [:]
        if let answer { object["answer"] = answer }
        if let citations { object["citations"] = citations }
        return .json(object)
    }

    // MARK: - happy path

    func testAnswerAndSourcesRenderInOneCallWithTheRightRequestBody() async {
        let http = ScriptedChatHTTP([answerBody("Swift 6 ships strict concurrency.", [
            ["title": "First", "url": "https://a.test/1"],
            ["title": "Second", "url": "https://b.test/2"],
        ])])

        let result = await SearchTool.run(query: "swift concurrency", key: key, http: http)

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, """
        Swift 6 ships strict concurrency.

        Sources:
        1. First
           https://a.test/1
        2. Second
           https://b.test/2
        """)
        XCTAssertEqual(http.requestCount, 1, "one call returns the answer AND its sources")
        XCTAssertEqual(http.requests[0].url?.absoluteString, "https://api.exa.ai/answer")
        // ONE field, and that is the whole body: `/answer` has no `numResults` dial.
        XCTAssertEqual(http.bodyString(0), #"{"query":"swift concurrency"}"#)
        XCTAssertEqual(http.requests[0].value(forHTTPHeaderField: "x-api-key"), key)
    }

    func testAMissingTitleRendersTheDash() async {
        let http = ScriptedChatHTTP([answerBody("A.", [["url": "https://a.test/1"], ["title": "   ", "url": "https://b.test/2"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertEqual(result.content, """
        A.

        Sources:
        1. -
           https://a.test/1
        2. -
           https://b.test/2
        """)
    }

    func testAnEmptyAnswerIsStatedPlainly() async {
        let http = ScriptedChatHTTP([answerBody("   ", [["title": "T", "url": "https://a.test/1"]])])
        let result = await SearchTool.run(query: "obscure thing", key: key, http: http)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "no answer for obscure thing")
    }

    func testAnAbsentAnswerFieldIsAlsoNoAnswerNotAnError() async {
        let http = ScriptedChatHTTP([answerBody(nil, nil)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, "no answer for q")
    }

    func testAnAnswerWithNoCitationsIsMarkedUnsourced() async {
        let http = ScriptedChatHTTP([answerBody("Probably 42.", [])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.content, """
        Probably 42.

        [unsourced — the search service returned no sources; say so if you repeat this]
        """)
    }

    func testAtMostTwentyCitationsAreRendered() async {
        let citations = (1 ... 25).map { ["title": "T\($0)", "url": "https://a.test/\($0)"] }
        let http = ScriptedChatHTTP([answerBody("A.", citations)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("20. T20"))
        XCTAssertFalse(result.content.contains("21. T21"))
    }

    // MARK: - truncation markers (two, at two different caps)

    func testAnOverlongAnswerIsMarkedTruncatedRatherThanSilentlyCut() async {
        let long = String(repeating: "x", count: SearchTool.answerChars + 50)
        let http = ScriptedChatHTTP([answerBody(long, [["title": "T", "url": "https://a.test/1"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("[answer truncated]"))
        XCTAssertTrue(result.content.contains("Sources:"), "the sources list survives the answer cap")
    }

    /// The TOTAL cap is a SECOND, independent marker, and it can only be reached through the SOURCES:
    /// the answer is already bounded at `answerChars`, so a long answer alone never gets there. Twenty
    /// citations with long titles do — nothing bounds a provider-supplied title.
    func testTheWholeResponseIsCappedWithItsOwnMarker() async {
        let longTitle = String(repeating: "t", count: 1_700)
        let citations = (1 ... 20).map { ["title": longTitle, "url": "https://a.test/\($0)"] }
        let http = ScriptedChatHTTP([answerBody("A short answer.", citations)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.hasSuffix("\n\n[truncated]"), "the whole-response cap states itself")
        XCTAssertEqual(truncateUTF16Count(result.content), SearchTool.totalOutputChars + "\n\n[truncated]".utf16.count,
                       "the marker rides a few bytes past the cap (slice-then-append), exactly as the TS does")
    }

    // MARK: - dangerous-citation stripping

    func testDangerousCitationsAreStrippedAndTheWithheldCountIsStated() async {
        let http = ScriptedChatHTTP([answerBody("A.", [
            ["title": "Safe", "url": "https://a.test/1"],
            ["title": "Paste", "url": "https://raw.pastebin.com/xyz"],
            ["title": "Tunnel", "url": "https://abc.ngrok.io/p"],
        ])])

        let result = await SearchTool.run(query: "q", key: key, http: http)

        XCTAssertFalse(result.isError)
        XCTAssertTrue(result.content.contains("https://a.test/1"), "the safe citation survives")
        XCTAssertFalse(result.content.contains("pastebin.com"), "a dangerous citation is never shown to the model")
        XCTAssertFalse(result.content.contains("ngrok.io"))
        XCTAssertTrue(result.content.contains("[2 sources withheld — matched the dangerous-domain list]"),
                      "the withheld count is stated so the filter is never silent")
    }

    func testASingleWithheldSourceIsGrammaticallySingular() async {
        let http = ScriptedChatHTTP([answerBody("A.", [
            ["title": "Safe", "url": "https://a.test/1"],
            ["title": "Paste", "url": "https://pastebin.com/x"],
        ])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("[1 source withheld — matched the dangerous-domain list]"))
    }

    func testEveryCitationWithheldIsSaidSoInTheUnsourcedMarker() async {
        let http = ScriptedChatHTTP([answerBody("A.", [["title": "P", "url": "https://pastebin.com/x"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertEqual(result.content, """
        A.

        [unsourced — every source was withheld by the dangerous-domain list; say so if you repeat this]

        [1 source withheld — matched the dangerous-domain list]
        """)
    }

    func testUserAddedDangerousDomainsAlsoStrip() async {
        let http = ScriptedChatHTTP([answerBody("A.", [["title": "Corp", "url": "https://drop.corp.test/f"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http, dangerousAdded: ["corp.test"])
        XCTAssertTrue(result.content.contains("[1 source withheld"))
    }

    /// The entry spellings the runtime child's own matcher honours and a bare-string check did not.
    func testWildcardSchemeAndPathShapedUserEntriesAllStrip() async {
        for entry in ["*.corp.test", ".corp.test", "https://corp.test", "corp.test:8443", "corp.test/admin", "user@corp.test", "corp.test."] {
            let http = ScriptedChatHTTP([answerBody("A.", [["title": "Corp", "url": "https://drop.corp.test/f"]])])
            let result = await SearchTool.run(query: "q", key: key, http: http, dangerousAdded: [entry])
            XCTAssertTrue(result.content.contains("[1 source withheld"), "entry \(entry) must strip the citation")
        }
    }

    func testAnInternationalizedUserEntryMatchesThePunycodedCitation() async {
        let http = ScriptedChatHTTP([answerBody("A.", [["title": "IDN", "url": "https://xn--e1afmkfd.xn--p1ai/f"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http, dangerousAdded: ["пример.рф"])
        XCTAssertTrue(result.content.contains("[1 source withheld"))
    }

    func testTheTrailingDotBypassIsClosedOnTheCitationSide() async {
        let http = ScriptedChatHTTP([answerBody("A.", [["title": "P", "url": "https://pastebin.com./raw/x"]])])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.content.contains("[1 source withheld"))
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

    /// Search is the boundary that actually carries `x-api-key`, so the no-redirect property is pinned
    /// HERE as well as on the shared transport. A 302 must be delivered as a result — never chased —
    /// so the key cannot ride onward to whatever host `Location` names. Asserted on request COUNT and
    /// on the requested host, because a following transport shows up only as a second request.
    func testA302IsNeverFollowedSoTheApiKeyCannotReachTheRedirectTarget() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "https://attacker.test/collect")])
        let result = await SearchTool.run(query: "q", key: key, http: http)

        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, SearchTool.statusMessage(302))
        XCTAssertFalse(result.content.contains(key))
        XCTAssertEqual(http.requestCount, 1, "the redirect TARGET is never even requested")
        XCTAssertEqual(http.requests[0].url?.host, "api.exa.ai")
        XCTAssertFalse(http.requests.contains { $0.url?.host == "attacker.test" })
        for request in http.requests where request.value(forHTTPHeaderField: "x-api-key") != nil {
            XCTAssertEqual(request.url?.host, "api.exa.ai")
        }
    }

    // MARK: - failure classification: one actionable sentence, never the provider's body

    func testEveryDocumentedStatusMapsToItsOwnActionableSentence() async {
        let expectations: [(Int, String)] = [
            (401, "the stored Exa API key was rejected"),
            (403, "the stored Exa API key was rejected"),
            (402, "out of credits or over its budget"),
            (429, "rate-limiting this key"),
            (400, "rejected the request as malformed"),
            (503, "the search service is unavailable (HTTP 503)"),
        ]
        for (status, fragment) in expectations {
            let http = ScriptedChatHTTP([.text("internal detail that must not surface", status: status)])
            let result = await SearchTool.run(query: "q", key: key, http: http)
            XCTAssertTrue(result.isError)
            XCTAssertTrue(result.content.contains(fragment), "HTTP \(status) → \(result.content)")
            XCTAssertFalse(result.content.contains("internal detail"),
                           "the provider's own body must never cross into the tool result")
        }
    }

    func testMalformedCitationsAreAParseError() async {
        for body: ScriptedChatHTTP.Step in [
            .json(["answer": "A.", "citations": "not an array"]),
            .json(["answer": "A.", "citations": [NSNull()]]),
            .json(["answer": "A.", "citations": [1, 2]]),
            .json(["answer": 42, "citations": []]),
        ] {
            let result = await SearchTool.run(query: "q", key: key, http: ScriptedChatHTTP([body]))
            XCTAssertTrue(result.isError)
            XCTAssertEqual(result.content, "search failed: malformed response from search service")
        }
    }

    func testUnparseableBodyIsAParseError() async {
        let http = ScriptedChatHTTP([.text("<html>not json</html>", status: 200)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: could not parse response")
    }

    func testANonObjectJsonBodyIsAlsoAParseError() async {
        let http = ScriptedChatHTTP([.text("[1,2,3]", status: 200)])
        let result = await SearchTool.run(query: "q", key: key, http: http)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search failed: could not parse response")
    }

    // MARK: - cancellation

    func testAnAlreadyAbortedSignalTimesOutWithoutEgress() async {
        let signal = ChatAbortSignal()
        signal.abort()
        let http = ScriptedChatHTTP([])
        let result = await SearchTool.run(query: "q", key: key, http: http, signal: signal)
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.content, "search timed out for q")
        XCTAssertEqual(http.requestCount, 0)
    }
}
