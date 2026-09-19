import Foundation
import XCTest
@testable import WinterChatKit

/// `WebFetch` — the executor. Every test drives `ScriptedChatHTTP` for the page and
/// `ScriptedChatProvider` for the digest model; none touches the network or a real model.
///
/// The load-bearing properties pinned here: **no raw page text reaches a tool_result** except on
/// claude's own preapproved-markdown passthrough; a private/loopback target is refused with ZERO
/// egress; the digest prompt is assembled byte-for-byte as claude assembles it; and the cache stores
/// the PAGE, so a second call with a different prompt re-asks the model rather than replaying the
/// first answer.
final class WebFetchToolTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func args(_ url: String, _ prompt: String = "what is this page about?") -> String {
        let data = try! JSONSerialization.data(withJSONObject: ["url": url, "prompt": prompt])
        return String(decoding: data, as: UTF8.self)
    }

    /// A digest model that answers `answer` in one round.
    private func digester(_ answer: String, inputTokens: Int = 0, outputTokens: Int = 0) -> ScriptedChatProvider {
        var events: [ProviderEvent] = [.textDelta(answer)]
        if inputTokens > 0 || outputTokens > 0 {
            events.append(.usage(inputTokens: inputTokens, outputTokens: outputTokens))
        }
        events.append(.done(.endTurn))
        return ScriptedChatProvider([events])
    }

    private func deps(_ http: ScriptedChatHTTP,
                      _ provider: any ChatProvider,
                      cache: WebFetchCache = WebFetchCache(),
                      dangerousAdded: [String] = [],
                      now: Date? = nil) -> WebFetchTool.Deps {
        let clock = now ?? t0
        return WebFetchTool.Deps(http: http, cache: cache, digestProvider: provider,
                                 digestModel: "gpt-5.6-luna", dangerousAdded: dangerousAdded,
                                 timeout: 2, maxBytes: 4096, now: { clock })
    }

    // MARK: - input validation

    func testInputValidationTextsAreClaudesOwn() async {
        let cases: [(String, String)] = [
            ("[]", "Error: input must be an object"),
            ("not json", "Error: input must be an object"),
            (#"{"prompt":"p"}"#, "Error: url must be a non-empty string"),
            (#"{"url":"","prompt":"p"}"#, "Error: url must be a non-empty string"),
            (#"{"url":123,"prompt":"p"}"#, "Error: url must be a non-empty string"),
            (#"{"url":"https://a.test/"}"#, "Error: prompt must be a string"),
            (#"{"url":"https://a.test/","prompt":7}"#, "Error: prompt must be a string"),
        ]
        for (json, expected) in cases {
            let http = ScriptedChatHTTP([])
            let outcome = await WebFetchTool.run(argumentsJSON: json, deps: deps(http, digester("x")))
            XCTAssertTrue(outcome.result.isError)
            XCTAssertEqual(outcome.result.content, expected, "for \(json)")
            XCTAssertEqual(http.requestCount, 0)
        }
    }

    /// The shapes `new URL()` THROWS on, which must reach claude's parse-failure sentence rather than
    /// the (different) fetch-time reject. `Foundation.URL` parses every one of them.
    func testWhatwgParseFailuresReachTheParseFailureSentence() async {
        for raw in ["hello", "/relative/path", "http://", "https://999.999.999.999/", "https://1.2.3.4.5/", "https://08.8.8.8/", "https://1..2/"] {
            let http = ScriptedChatHTTP([])
            let outcome = await WebFetchTool.run(argumentsJSON: args(raw), deps: deps(http, digester("x")))
            XCTAssertTrue(outcome.result.isError, raw)
            XCTAssertEqual(outcome.result.content, WebFetchURL.parseFailureMessage(raw), "for \(raw)")
            XCTAssertEqual(http.requestCount, 0, "\(raw) must not reach the network")
        }
    }

    // MARK: - private / loopback: REFUSED, with zero egress

    /// The daemon's own adversarial corpus spellings. Under claude's order the fetchable-url rule runs
    /// BEFORE the address policy, so the corpus splits into two texts — and the split is itself the
    /// thing worth pinning, because both halves refuse and neither reaches the network.
    func testEveryPrivateSpellingIsRefusedWithoutEgress() async {
        // Four-label (or numeric, which WHATWG canonicalises to four) hosts and two-label reserved
        // names pass the label rule and are then refused by the address policy.
        let denied = [
            "https://192.168.1.1/admin",
            "https://127.0.0.1:8080/x",
            "https://169.254.169.254/latest/meta-data/",
            "https://100.64.0.1/x",          // RFC 6598 CGNAT — private HERE, absent from `ssrfGuard`
            "https://app.localhost/x",       // the SDK's `*.localhost` rule, which `ssrfGuard` lacks
            "https://printer.local/status",
            "https://10.0.0.1/x",
            "https://172.16.0.1/x",
            "https://0.0.0.0/x",
            "https://2130706433/x",          // 127.0.0.1 in decimal
            "https://0xc0a80101/x",          // 192.168.1.1 in hex
            "https://0300.0250.0.1/x",       // 192.168.0.1 in octal
        ]
        for raw in denied {
            let http = ScriptedChatHTTP([])
            let outcome = await WebFetchTool.run(argumentsJSON: args(raw), deps: deps(http, digester("x")))
            XCTAssertTrue(outcome.result.isError, raw)
            XCTAssertTrue(outcome.result.content.contains("it is a private/loopback address, and this session's policy denies WebFetch access to private addresses."),
                          "\(raw) → \(outcome.result.content)")
            XCTAssertTrue(outcome.result.content.hasSuffix(WebFetchURL.fetchableTargetShape),
                          "the refusal ends with the one sentence about what is fetchable at all")
            XCTAssertEqual(http.requestCount, 0, "\(raw) must not reach the network")
        }

        // IPv6 literals are ONE label in WHATWG (`hostname` keeps the brackets), so they never get as
        // far as the address policy — in claude either. Both spellings of loopback, and the
        // IPv4-mapped form Foundation refuses to canonicalise.
        for raw in ["https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://[fe80::1]/x"] {
            let http = ScriptedChatHTTP([])
            let outcome = await WebFetchTool.run(argumentsJSON: args(raw), deps: deps(http, digester("x")))
            XCTAssertTrue(outcome.result.isError, raw)
            XCTAssertEqual(outcome.result.content, WebFetchURL.fetchTimeInvalidURL, "for \(raw)")
            XCTAssertEqual(http.requestCount, 0, "\(raw) must not reach the network")
        }
    }

    func testTheHttpToHttpsUpgradeIsUnconditional() async {
        let http = ScriptedChatHTTP([.html("<p>hi</p>")])
        _ = await WebFetchTool.run(argumentsJSON: args("http://a.test/x"), deps: deps(http, digester("A")))
        XCTAssertEqual(http.requestedURLs, ["https://a.test/x"])
    }

    /// The upgrade does NOT rescue a plain-http private target: it is still private after it.
    func testAPlainHttpLoopbackTargetIsStillRefused() async {
        let http = ScriptedChatHTTP([])
        let outcome = await WebFetchTool.run(argumentsJSON: args("http://127.0.0.1:5173/"), deps: deps(http, digester("x")))
        XCTAssertTrue(outcome.result.isError)
        XCTAssertTrue(outcome.result.content.hasPrefix("WebFetch will not reach 127.0.0.1:"))
        XCTAssertEqual(http.requestCount, 0)
    }

    // MARK: - the dangerous-domain floor

    func testAFloorListedHostIsRefusedBeforeAnyEgress() async {
        let http = ScriptedChatHTTP([])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://raw.pastebin.com/xyz"), deps: deps(http, digester("x")))
        XCTAssertTrue(outcome.result.isError)
        // Fidelity #6: NO trailing period.
        XCTAssertEqual(outcome.result.content, "Winter is unable to fetch from raw.pastebin.com")
        XCTAssertEqual(http.requestCount, 0)
    }

    func testAUserAddedEntryIsAFloorToo() async {
        let http = ScriptedChatHTTP([])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://drop.corp.test/f"),
                                            deps: deps(http, digester("x"), dangerousAdded: ["*.corp.test"]))
        XCTAssertTrue(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "Winter is unable to fetch from drop.corp.test")
        XCTAssertEqual(http.requestCount, 0)
    }

    // MARK: - redirects

    func testASameHostRedirectIsFollowedAndTheFinalPageIsDigested() async {
        let http = ScriptedChatHTTP([
            .redirect(status: 301, location: "https://a.test/final"),
            .html("<p>the final page</p>"),
        ])
        let provider = digester("A summary.")
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/start"), deps: deps(http, provider))
        XCTAssertFalse(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "A summary.")
        XCTAssertEqual(http.requestedURLs, ["https://a.test/start", "https://a.test/final"])
        XCTAssertTrue(provider.request(0).messageText.contains("the final page"))
    }

    func testAWwwEquivalentRedirectIsFollowed() async {
        let http = ScriptedChatHTTP([
            .redirect(status: 302, location: "https://www.a.test/final"),
            .html("<p>www page</p>"),
        ])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/start"), deps: deps(http, digester("A")))
        XCTAssertFalse(outcome.result.isError)
        XCTAssertEqual(http.requestCount, 2)
    }

    func testACrossHostRedirectIsReturnedToTheModelVerbatimAndIsNotAnError() async {
        let http = ScriptedChatHTTP([.redirect(status: 301, location: "https://b.test/moved?q=1#frag")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/start", "who wrote it?"),
                                            deps: deps(http, digester("never called")))
        XCTAssertFalse(outcome.result.isError, "the fetch WORKED; the redirect is information, not a failure")
        XCTAssertEqual(outcome.result.content, """
        REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.

        Original URL: https://a.test/start
        Redirect URL (from the server's Location header — server-supplied, not verified): https://b.test/moved?q=1#frag
        Status: 301 Moved Permanently

        To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
        - url: "https://b.test/moved?q=1#frag"
        - prompt: "who wrote it?"
        """)
        XCTAssertEqual(http.requestCount, 1, "the redirect target is never fetched")
    }

    func testANonHttpRedirectTargetHasItsUrlLineWithheld() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "javascript:alert(1)")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/start"), deps: deps(http, digester("x")))
        XCTAssertFalse(outcome.result.isError)
        XCTAssertTrue(outcome.result.content.contains("Redirect URL: (withheld — the server sent a redirect target that is not a valid http(s) URL)"))
        XCTAssertTrue(outcome.result.content.hasSuffix("The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead."))
        XCTAssertFalse(outcome.result.content.contains("javascript:"), "the opaque target is never interpolated")
    }

    func testABlankLocationIsAnHttpErrorNotARedirectMessage() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: nil)])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/start"), deps: deps(http, digester("x")))
        XCTAssertFalse(outcome.result.isError)
        XCTAssertTrue(outcome.result.content.hasPrefix("The server returned HTTP 302 Found."))
        XCTAssertFalse(outcome.result.content.contains("REDIRECT DETECTED"))
    }

    // MARK: - non-2xx

    func testANonTwoHundredIsNotAnErrorResultAndCarriesTheFixedReasonPhrase() async {
        let http = ScriptedChatHTTP([.text("server-internal detail", status: 404)])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, digester("x")))
        XCTAssertFalse(outcome.result.isError, "the server ANSWERED; that is information the model acts on")
        XCTAssertEqual(outcome.result.content, """
        The server returned HTTP 404 Not Found.

        The response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.
        """)
        XCTAssertFalse(outcome.result.content.contains("server-internal detail"))
    }

    func testANumericRetryAfterIsRelayedAndANonNumericOneIsNot() async {
        var http = ScriptedChatHTTP([.response(status: 429, body: Data(), headers: ["Retry-After": "30"])])
        var outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, digester("x")))
        XCTAssertTrue(outcome.result.content.contains("HTTP 429 Too Many Requests.\nRetry-After: 30"))

        http = ScriptedChatHTTP([.response(status: 429, body: Data(), headers: ["Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"])])
        outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, digester("x")))
        XCTAssertFalse(outcome.result.content.contains("Retry-After"), "a date-form Retry-After is not relayed")
    }

    // MARK: - size cap

    func testABodyPastTheCapIsREFUSED_notTruncated() async {
        // `PageFetcher` hands back a usable truncated page at its cap; WebFetch refuses, and that is
        // the divergence that made a shared fetcher impossible.
        let http = ScriptedChatHTTP([.generatedHTML(byteCount: 9_000)])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/big"), deps: deps(http, digester("x")))
        XCTAssertTrue(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "The response body exceeded WebFetch's 4,096-byte limit and was not retrieved.")
    }

    func testABodyExactlyAtTheCapIsASuccess() async {
        let http = ScriptedChatHTTP([.generatedHTML(byteCount: 4_096)])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/exact"), deps: deps(http, digester("A")))
        XCTAssertFalse(outcome.result.isError, "the SDK's boundary is `total > cap`, not `>=`")
        XCTAssertEqual(outcome.result.content, "A")
    }

    // MARK: - content kinds

    func testHtmlIsConvertedAndOnlyTheAnswerReachesTheToolResult() async {
        let provider = digester("It is a greeting page.")
        let http = ScriptedChatHTTP([.html("<h1>Hello</h1><p>secret body text</p><a href=\"https://x.test/\">link</a>")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))

        XCTAssertEqual(outcome.result.content, "It is a greeting page.")
        XCTAssertFalse(outcome.result.content.contains("secret body text"),
                       "NO raw page text may reach a tool_result outside the preapproved passthrough")
        // The converted markdown DID reach the digest model, which is where it belongs.
        XCTAssertTrue(provider.request(0).messageText.contains("# Hello"))
        XCTAssertTrue(provider.request(0).messageText.contains("secret body text"))
    }

    func testPlainTextIsPassedToTheDigestRaw() async {
        let provider = digester("A list of numbers.")
        let http = ScriptedChatHTTP([.plainText("1\n2\n3")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertTrue(provider.request(0).messageText.contains("---\n1\n2\n3\n---"))
    }

    func testBinaryContentIsReportedAndNeverDigestedOrCached() async {
        let cache = WebFetchCache()
        let provider = ScriptedChatProvider([])
        let http = ScriptedChatHTTP([.response(status: 200, body: Data([0x89, 0x50, 0x4E, 0x47]),
                                               headers: ["Content-Type": "image/png"])])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/logo.png"),
                                            deps: deps(http, provider, cache: cache))
        XCTAssertFalse(outcome.result.isError, "the fetch worked")
        XCTAssertEqual(outcome.result.content,
                       "The fetched content is binary (content-type: image/png, 4 bytes). Binary content was not retrieved: no session temp directory is available in this context.")
        XCTAssertEqual(provider.requestCount, 0, "the digest model is never called for a binary body")
        let count = await cache.count
        XCTAssertEqual(count, 0, "binary responses are never cached")
    }

    /// Fidelity #10: only `text/html` converts. `application/xhtml+xml` is raw text.
    func testXhtmlIsTextNotHtml() {
        XCTAssertEqual(WebFetchTool.classifyContentType("text/html; charset=utf-8"), .html)
        XCTAssertEqual(WebFetchTool.classifyContentType("application/xhtml+xml"), .text)
        XCTAssertEqual(WebFetchTool.classifyContentType(""), .text)
        XCTAssertEqual(WebFetchTool.classifyContentType("application/json"), .text)
        XCTAssertEqual(WebFetchTool.classifyContentType("application/pdf"), .binary)
    }

    // MARK: - the digest pass

    func testTheDigestPromptIsAssembledExactlyAsClaudeAssemblesIt() async {
        let provider = digester("A.")
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://a.test/x", "who wrote it?"), deps: deps(http, provider))

        let request = provider.request(0)
        XCTAssertEqual(request.model, "gpt-5.6-luna", "the BARE wire model id, never a tag")
        XCTAssertNil(request.instructions, "the digest pass sends no system prompt")
        XCTAssertTrue(request.tools.isEmpty, "and no tools")
        XCTAssertNil(request.reasoningEffort, "it is an extraction pass, not a reasoning one")
        XCTAssertEqual(request.input.count, 1)
        XCTAssertEqual(request.messageText,
                       "\nWeb page content:\n---\nPAGE\n---\n\nwho wrote it?\n\n\(WebFetchTool.strictGuidelines)\n")
    }

    func testAPreapprovedHostGetsThePermissiveGuidelines() async {
        let provider = digester("A.")
        let http = ScriptedChatHTTP([.html("<p>docs</p>")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://react.dev/learn"), deps: deps(http, provider))
        XCTAssertTrue(provider.request(0).messageText.hasSuffix("\(WebFetchTool.permissiveGuidelines)\n"))
    }

    func testAPreapprovedPathScopedEntryOnlyCoversItsOwnPath() async {
        let provider = digester("A.")
        var http = ScriptedChatHTTP([.html("<p>x</p>")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://go.dev/doc/tutorial"), deps: deps(http, provider))
        XCTAssertTrue(provider.request(0).messageText.contains(WebFetchTool.permissiveGuidelines))

        let strictProvider = digester("A.")
        http = ScriptedChatHTTP([.html("<p>x</p>")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://go.dev/blog/whatever"), deps: deps(http, strictProvider))
        XCTAssertTrue(strictProvider.request(0).messageText.contains(WebFetchTool.strictGuidelines))
    }

    func testPreapprovedMarkdownUnderTheCapSkipsTheDigestEntirely() async {
        let provider = ScriptedChatProvider([])
        let http = ScriptedChatHTTP([.response(status: 200, body: Data("# Docs\n\nverbatim.".utf8),
                                               headers: ["Content-Type": "text/markdown"])])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://react.dev/learn"), deps: deps(http, provider))
        XCTAssertEqual(outcome.result.content, "# Docs\n\nverbatim.",
                       "claude's one verbatim passthrough, and the only path on which raw page text is a tool_result")
        XCTAssertEqual(provider.requestCount, 0)
    }

    func testNonPreapprovedMarkdownIsStillDigested() async {
        let provider = digester("A summary.")
        let http = ScriptedChatHTTP([.response(status: 200, body: Data("# Docs".utf8),
                                               headers: ["Content-Type": "text/markdown"])])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertEqual(outcome.result.content, "A summary.")
        XCTAssertEqual(provider.requestCount, 1)
    }

    func testTheContentShownToTheDigestModelIsCappedWithClaudesOwnNotice() async {
        let long = String(repeating: "x", count: WebFetchTool.digestContentCap + 500)
        let provider = digester("A.")
        let http = ScriptedChatHTTP([.plainText(long)])
        // Headroom for a page bigger than the digest cap.
        let clock = t0
        let d = WebFetchTool.Deps(http: http, cache: WebFetchCache(), digestProvider: provider,
                                 digestModel: "m", timeout: 2, maxBytes: 200_000, now: { clock })
        _ = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: d)
        XCTAssertTrue(provider.request(0).messageText.contains("\n\n[Content truncated due to length...]"))
    }

    func testAProviderErrorIsAFixedSentenceNeverTheProvidersOwnMessage() async {
        let provider = ScriptedChatProvider([[.error(ProviderError(code: .server, message: "http://user:pw@proxy:3128 failed"))]])
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertTrue(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "The digest model failed.")
        XCTAssertFalse(outcome.result.content.contains("proxy"))
    }

    func testAnEmptyDigestAnswerIsClaudesNoResponseText() async {
        let provider = ScriptedChatProvider([[.textDelta("   "), .done(.endTurn)]])
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertFalse(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "No response from model")
    }

    func testTheDigestPassesTokenUsageBackToTheCaller() async {
        let provider = digester("A.", inputTokens: 1234, outputTokens: 56)
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertEqual(outcome.usage, ToolUsage(inputTokens: 1234, outputTokens: 56))
    }

    func testAnOverlongDigestAnswerIsCappedWithTheResultMarker() async {
        let provider = digester(String(repeating: "z", count: WebFetchTool.resultCap + 100))
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: deps(http, provider))
        XCTAssertTrue(outcome.result.content.hasSuffix("\n\n[Result truncated at 50,000 characters.]"))
    }

    // MARK: - the cache

    func testTheSecondCallServesTheCachedPageButRE_ASKSTheModel() async {
        let cache = WebFetchCache()
        let first = digester("First answer.")
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let a = await WebFetchTool.run(argumentsJSON: args("https://a.test/x", "question one"),
                                       deps: deps(http, first, cache: cache))
        XCTAssertEqual(a.result.content, "First answer.")

        let second = digester("Second answer.")
        let b = await WebFetchTool.run(argumentsJSON: args("https://a.test/x", "question two"),
                                       deps: deps(http, second, cache: cache))
        XCTAssertEqual(http.requestCount, 1, "the PAGE came from the cache")
        XCTAssertEqual(b.result.content, "Second answer.", "the ANSWER did not — a new prompt is a new question")
        XCTAssertTrue(second.request(0).messageText.contains("question two"))
    }

    func testAnExpiredEntryIsRefetched() async {
        let cache = WebFetchCache()
        let http = ScriptedChatHTTP([.plainText("PAGE"), .plainText("PAGE AGAIN")])
        _ = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"),
                                   deps: deps(http, digester("A"), cache: cache, now: t0))
        let later = t0.addingTimeInterval(WebFetchCache.defaultTTL + 1)
        let second = digester("B")
        _ = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"),
                                   deps: deps(http, second, cache: cache, now: later))
        XCTAssertEqual(http.requestCount, 2)
        XCTAssertTrue(second.request(0).messageText.contains("PAGE AGAIN"))
    }

    /// The cache is keyed on the REQUESTED url, and what it stores can have come from a different host
    /// (the walk auto-follows a `www.` variant). A hit must therefore re-check BOTH hosts against the
    /// floor as it stands NOW, not as it stood when the page was cached.
    func testACacheHitReChecksTheFloorAgainstTheEntrysFinalHost() async {
        let cache = WebFetchCache()
        let http = ScriptedChatHTTP([
            .redirect(status: 301, location: "https://www.corp.test/final"),
            .plainText("PAGE"),
        ])
        let first = await WebFetchTool.run(argumentsJSON: args("https://corp.test/start"),
                                           deps: deps(http, digester("A"), cache: cache))
        XCTAssertEqual(first.result.content, "A")

        // The user adds the WWW host to the dangerous list. The cache key (`corp.test`) still does not
        // match it; the entry's final url does.
        let blocked = await WebFetchTool.run(argumentsJSON: args("https://corp.test/start"),
                                             deps: deps(http, digester("A"), cache: cache,
                                                        dangerousAdded: ["www.corp.test"]))
        XCTAssertTrue(blocked.result.isError)
        XCTAssertEqual(blocked.result.content, "Winter is unable to fetch from www.corp.test")
    }

    // MARK: - cancellation

    func testAnAlreadyAbortedCallIsInterruptedWithoutEgress() async {
        let signal = ChatAbortSignal()
        signal.abort()
        let http = ScriptedChatHTTP([])
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"),
                                            deps: deps(http, digester("x")), signal: signal)
        XCTAssertTrue(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "WebFetch was interrupted.")
        XCTAssertEqual(http.requestCount, 0)
    }

    func testAStalledFetchTimesOutWithTheSharedSentence() async {
        let http = ScriptedChatHTTP([.hang])
        let clock = t0
        let d = WebFetchTool.Deps(http: http, cache: WebFetchCache(), digestProvider: digester("x"),
                                 digestModel: "m", timeout: 0.2, maxBytes: 4096, now: { clock })
        let outcome = await WebFetchTool.run(argumentsJSON: args("https://a.test/x"), deps: d)
        XCTAssertTrue(outcome.result.isError)
        XCTAssertEqual(outcome.result.content, "WebFetch timed out after 200ms.")
    }
}
