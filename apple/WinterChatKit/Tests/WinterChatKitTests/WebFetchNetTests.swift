import Foundation
import XCTest
@testable import WinterChatKit

/// `WebFetchNet` — the redirect walk. The property this file exists for is **every hop is guarded**:
/// the dangerous-domain floor and the private-address policy are re-applied at the top of every
/// iteration, hop 0 included, so a refused host reached through an intermediate redirect is refused
/// exactly like one reached directly. `RedirectAndCapTests` pins that property for `PageFetcher`'s own
/// (differently-shaped) loop; this is its counterpart for the loop `WebFetch` actually uses.
final class WebFetchNetTests: XCTestCase {
    private func options(dangerousAdded: [String] = [], maxBytes: Int = 4096,
                         timeout: TimeInterval = 2) -> WebFetchNet.Options {
        WebFetchNet.Options(dangerousAdded: dangerousAdded, userAgent: "winter-test",
                           timeout: timeout, maxBytes: maxBytes)
    }

    private func perform(_ url: String, _ http: ScriptedChatHTTP,
                         options: WebFetchNet.Options? = nil,
                         prompt: String = "p",
                         signal: ChatAbortSignal? = nil) async -> WebFetchNet.Outcome {
        await WebFetchNet.perform(inputURL: url, prompt: prompt, http: http,
                                  options: options ?? self.options(), signal: signal)
    }

    // MARK: - every hop is guarded

    /// With same-host-only auto-following, a followed hop's host can differ from hop 0's only by a
    /// leading `www.` — so that is exactly the shape a per-hop floor check has to catch, and exactly
    /// the shape a hop-0-only check would miss.
    func testTheDangerousDomainFloorIsReAppliedOnAFollowedHop() async {
        let http = ScriptedChatHTTP([.redirect(status: 301, location: "https://www.corp.test/final")])
        let outcome = await perform("https://corp.test/start", http,
                                    options: options(dangerousAdded: ["www.corp.test"]))
        guard case .blockedDomain(let host) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(host, "www.corp.test")
        XCTAssertEqual(http.requestCount, 1, "the blocked hop is never requested")
    }

    func testHopZeroIsGuardedToo() async {
        let http = ScriptedChatHTTP([])
        guard case .blockedDomain(let host) = await perform("https://pastebin.com/x", http) else {
            return XCTFail()
        }
        XCTAssertEqual(host, "pastebin.com")
        XCTAssertEqual(http.requestCount, 0)
    }

    // MARK: - auto-follow eligibility

    func testASameHostRedirectIsFollowedAndTheFinalUrlIsReported() async {
        let http = ScriptedChatHTTP([
            .redirect(status: 307, location: "/next"),
            .plainText("BODY"),
        ])
        guard case .success(let finalURL, let status, let statusText, _, let body) = await perform("https://a.test/start", http) else {
            return XCTFail()
        }
        XCTAssertEqual(finalURL, "https://a.test/next", "a relative Location resolves against the current hop")
        XCTAssertEqual(status, 200)
        XCTAssertEqual(statusText, "OK")
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "BODY")
    }

    /// The SDK's own fidelity-#7 comment claims an explicit `:443` is not normalised and so is NOT
    /// followed. WHATWG elides a scheme's default port at parse time, so `target.port` is empty there
    /// too and the hop IS eligible — this pins the measured behaviour, and the divergence from that
    /// comment is deliberate.
    func testAnExplicitDefaultPortIsStillTheSamePortAndIsFollowed() async {
        let http = ScriptedChatHTTP([
            .redirect(status: 301, location: "https://a.test:443/next"),
            .plainText("BODY"),
        ])
        guard case .success = await perform("https://a.test/start", http) else { return XCTFail() }
        XCTAssertEqual(http.requestCount, 2)
    }

    func testACrossSchemeRedirectIsNotFollowed() async {
        let http = ScriptedChatHTTP([.redirect(status: 301, location: "http://a.test/next")])
        guard case .redirectBlocked(let message) = await perform("https://a.test/start", http) else {
            return XCTFail()
        }
        XCTAssertTrue(message.hasPrefix("REDIRECT DETECTED:"))
        XCTAssertEqual(http.requestCount, 1)
    }

    func testANonDefaultPortChangeIsNotFollowed() async {
        let http = ScriptedChatHTTP([.redirect(status: 301, location: "https://a.test:8443/next")])
        guard case .redirectBlocked = await perform("https://a.test/start", http) else { return XCTFail() }
    }

    func testACrossHostRedirectIsNotFollowed() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "https://b.test/next")])
        guard case .redirectBlocked = await perform("https://a.test/start", http) else { return XCTFail() }
    }

    /// A target carrying embedded credentials is never followed, AND the credentials never reach the
    /// relayed line: WHATWG's `origin` drops userinfo and so does this renderer.
    func testATargetWithEmbeddedCredentialsIsNotFollowedAndItsUserinfoIsNeverEchoed() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "https://user:pw@a.test/next")])
        guard case .redirectBlocked(let message) = await perform("https://a.test/start", http) else {
            return XCTFail()
        }
        XCTAssertFalse(message.contains("user:pw"))
        XCTAssertFalse(message.contains("pw@"))
        XCTAssertTrue(message.contains("https://a.test/next"))
    }

    /// A path-scoped preapproved entry bounds auto-following even on the SAME host: leaving `/doc`
    /// stops being an eligible hop.
    func testLeavingAPreapprovedPathScopeStopsTheAutoFollow() async {
        let http = ScriptedChatHTTP([.redirect(status: 301, location: "https://go.dev/blog/x")])
        guard case .redirectBlocked = await perform("https://go.dev/doc/tutorial", http) else { return XCTFail() }

        // Staying inside the scope is still followed.
        let inside = ScriptedChatHTTP([.redirect(status: 301, location: "https://go.dev/doc/deeper"), .plainText("B")])
        guard case .success = await perform("https://go.dev/doc/tutorial", inside) else { return XCTFail() }
    }

    // MARK: - hop bound

    /// The bound counts redirects FOLLOWED, not requests: the initial request is never a hop, so the
    /// walk permits it plus up to 10 followed redirects — 11 requests — before refusing the 11th.
    func testTenFollowedRedirectsAreAllowedAndTheEleventhIsRefused() async {
        var allowed: [ScriptedChatHTTP.Step] = (1 ... 10).map { .redirect(status: 302, location: "/hop\($0)") }
        allowed.append(.plainText("BODY"))
        let ok = ScriptedChatHTTP(allowed)
        guard case .success = await perform("https://a.test/start", ok) else { return XCTFail("10 hops must be allowed") }
        XCTAssertEqual(ok.requestCount, 11)

        let tooMany = ScriptedChatHTTP((1 ... 11).map { .redirect(status: 302, location: "/hop\($0)") })
        guard case .tooManyRedirects(let message) = await perform("https://a.test/start", tooMany) else {
            return XCTFail()
        }
        XCTAssertEqual(message, "Too many redirects (exceeded 10)")
    }

    // MARK: - the Location header itself

    /// The WHATWG basic-URL-parser preprocessing `new URL()` applies and `Foundation.URL` does not:
    /// surrounding C0-or-space is trimmed and every tab/LF/CR anywhere inside is removed before the
    /// value reaches the parser. A raw LF cannot survive `HTTPURLResponse`'s own header storage, so the
    /// reachable half of the class is the surrounding whitespace and an embedded TAB.
    func testWhatwgPreprocessingIsAppliedToLocationBeforeResolving() async {
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "  /ne\tx t  "), .plainText("B")])
        guard case .success(let finalURL, _, _, _, _) = await perform("https://a.test/start", http) else {
            return XCTFail()
        }
        XCTAssertEqual(finalURL, "https://a.test/nex%20t",
                       "the tab is removed and the surrounding spaces trimmed; the inner space is percent-encoded")
    }

    func testAnOverlongRedirectTargetIsWithheldRatherThanRelayed() {
        let long = "https://a.test/" + String(repeating: "p", count: 1_200)
        let message = WebFetchNet.renderRedirectDetected(currentURL: "https://a.test/start",
                                                        target: URL(string: long)!,
                                                        status: 302, prompt: "p")
        XCTAssertTrue(message.contains("more characters withheld: too long to relay]"))
        XCTAssertTrue(message.hasSuffix("report the redirect instead."))
        XCTAssertFalse(message.contains("Please use WebFetch again"))
    }

    func testAnOverlongHostnameIsNamedAsUnfetchable() {
        let host = String(repeating: "a", count: 300)
        let message = WebFetchNet.renderRedirectDetected(currentURL: "https://a.test/start",
                                                        target: URL(string: "https://\(host)/x")!,
                                                        status: 302, prompt: "p")
        XCTAssertTrue(message.contains("[hostname longer than any DNS name (255 characters): not a fetchable address]"))
        XCTAssertTrue(message.hasSuffix("report the redirect instead."))
    }

    // MARK: - the fixed reason-phrase table

    func testReasonPhrasesComeFromTheFixedTableNotTheLocalisedSystemOne() {
        XCTAssertEqual(WebFetchURL.reasonPhrase(200), "OK")
        XCTAssertEqual(WebFetchURL.reasonPhrase(301), "Moved Permanently")
        XCTAssertEqual(WebFetchURL.reasonPhrase(404), "Not Found")
        XCTAssertEqual(WebFetchURL.reasonPhrase(429), "Too Many Requests")
        XCTAssertEqual(WebFetchURL.reasonPhrase(500), "Internal Server Error")
        XCTAssertEqual(WebFetchURL.reasonPhrase(599), "Unknown Status")
        // The system table is lowercased and localised, which is why it is not used.
        XCTAssertNotEqual(HTTPURLResponse.localizedString(forStatusCode: 404), "Not Found")
    }

    func testNumbersAreRenderedEnUSWhateverTheDeviceLocaleIs() {
        XCTAssertEqual(WebFetchURL.groupedEnUS(10_485_760), "10,485,760")
        XCTAssertEqual(WebFetchURL.groupedEnUS(50_000), "50,000")
        XCTAssertEqual(WebFetchURL.groupedEnUS(4), "4")
    }

    // MARK: - caps and cancellation

    func testTheSizeCapRefusesRatherThanTruncating() async {
        let http = ScriptedChatHTTP([.generatedHTML(byteCount: 9_000)])
        guard case .sizeExceeded(let message) = await perform("https://a.test/big", http) else { return XCTFail() }
        XCTAssertEqual(message, "The response body exceeded WebFetch's 4,096-byte limit and was not retrieved.")
    }

    func testAnAbortedCallerNeverReachesTheNetwork() async {
        let signal = ChatAbortSignal()
        signal.abort()
        let http = ScriptedChatHTTP([.plainText("B")])
        guard case .aborted = await perform("https://a.test/x", http, signal: signal) else { return XCTFail() }
        XCTAssertEqual(http.requestCount, 0)
    }

    func testAnInterruptMidFlightIsAbortedAndNotATimeout() async {
        let signal = ChatAbortSignal()
        let http = ScriptedChatHTTP([.hang])
        let task = Task { await self.perform("https://a.test/x", http, options: self.options(timeout: 30), signal: signal) }
        try? await TestGate.poll(until: { http.requestCount == 1 })
        signal.abort()
        guard case .aborted = await task.value else { return XCTFail() }
    }

    func testATransportFailuresOwnMessageNeverReachesTheOutcome() async {
        let http = ScriptedChatHTTP([.failure(FakeTransportError())])
        guard case .networkError(let message) = await perform("https://a.test/x", http) else { return XCTFail() }
        XCTAssertEqual(message, "FakeTransportError", "the error's TYPE, never its message")
    }

    // MARK: - fetch-time rejects, per hop

    func testTheFetchTimeRejectsAreReAppliedToEveryHop() async {
        // claude validates the raw input once; this walk re-validates every upgraded hop, which is
        // strictly stricter. A same-host redirect into a >2000-character url is refused.
        let longPath = String(repeating: "q", count: 2_100)
        let http = ScriptedChatHTTP([.redirect(status: 302, location: "/\(longPath)")])
        guard case .invalidURL(let message) = await perform("https://a.test/start", http) else { return XCTFail() }
        XCTAssertEqual(message, WebFetchURL.fetchTimeInvalidURL)
        XCTAssertEqual(http.requestCount, 1)
    }
}

/// `PreapprovedHosts` / `PrivateAddress` / `WebFetchURL` — the pure predicates the walk and the
/// executor read.
final class WebFetchPredicateTests: XCTestCase {
    func testTheExtractedListHasTheMeasuredShape() {
        XCTAssertEqual(PreapprovedHosts.entries.count, 92, "92 literals, as extracted")
        XCTAssertEqual(Set(PreapprovedHosts.entries).count, 91, "91 distinct — learn.microsoft.com is listed twice")
        XCTAssertEqual(PreapprovedHosts.entries.filter { $0.contains("/") }.count, 9, "9 path-scoped")
    }

    func testHostMatchingIsExactWithNoSubdomains() {
        XCTAssertTrue(PreapprovedHosts.isPreapproved(URL(string: "https://react.dev/learn")!))
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://blog.react.dev/learn")!),
                       "claude's own matcher is an exact hostname match")
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://notreact.dev/")!))
    }

    func testPathScopedEntriesBoundOnASlash() {
        XCTAssertTrue(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/doc")!))
        XCTAssertTrue(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/doc/tutorial")!))
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/documentation")!),
                       "a prefix that is not `/`-bounded is not a child")
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/blog")!))
    }

    func testTheEncodedTraversalGuardRefusesAPathScopedMatch() {
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/doc%2f..%2fadmin")!))
        XCTAssertFalse(PreapprovedHosts.isPreapproved(URL(string: "https://go.dev/doc%252e%252e/admin")!))
    }

    func testAScopeMatchesTheWwwVariantThreeWays() {
        // A scope matched on `claude.com/docs` still resolves for a `www.`-prefixed hop, which is what
        // keeps the third hop of a `www.` chain bounded instead of unrestricted.
        let scope = PreapprovedHosts.scopeOf(URL(string: "https://www.claude.com/docs/a")!)
        XCTAssertEqual(scope, PreapprovedHosts.Match(host: "claude.com", pathPrefix: "/docs"))
        XCTAssertTrue(PreapprovedHosts.staysWithinScope(scope!, URL(string: "https://www.claude.com/docs/b")!))
        XCTAssertFalse(PreapprovedHosts.staysWithinScope(scope!, URL(string: "https://www.claude.com/other")!))
    }

    func testCgnatIsPrivateHereAndAbsentFromTheDaemonMirroringGuard() {
        XCTAssertTrue(PrivateAddress.isLexicallyPrivate("100.64.0.1"))
        XCTAssertTrue(PrivateAddress.isLexicallyPrivate("100.127.255.255"))
        XCTAssertFalse(PrivateAddress.isLexicallyPrivate("100.63.255.255"), "just below the /10")
        XCTAssertFalse(PrivateAddress.isLexicallyPrivate("100.128.0.1"), "just above it")
        // `ssrfGuard` is a byte-for-byte mirror of the daemon's guard and deliberately does NOT carry
        // this range; that is why the classification lives in its own type.
        XCTAssertNil(ssrfGuard("https://100.64.0.1/x"))
    }

    func testTheReservedNameRuleCoversAllFourSdkForms() {
        for host in ["localhost", "app.localhost", "local", "printer.local", "PRINTER.LOCAL", "printer.local."] {
            XCTAssertTrue(PrivateAddress.isLexicallyPrivate(host), host)
        }
        for host in ["notlocalhost.test", "localhost.example.com", "a.test"] {
            XCTAssertFalse(PrivateAddress.isLexicallyPrivate(host), host)
        }
    }

    func testIpv4MappedIpv6GoesThroughTheSameTable() {
        XCTAssertTrue(PrivateAddress.isLexicallyPrivate("::ffff:127.0.0.1"))
        XCTAssertTrue(PrivateAddress.isLexicallyPrivate("::ffff:7f00:1"))
        XCTAssertTrue(PrivateAddress.isLexicallyPrivate("::ffff:100.64.0.1"))
        XCTAssertFalse(PrivateAddress.isLexicallyPrivate("::ffff:1.1.1.1"))
    }

    func testAnOrdinaryDnsNameIsNotLexicallyDecidable() {
        XCTAssertNil(PrivateAddress.classifyLexically("example.com"))
        XCTAssertEqual(PrivateAddress.classifyLexically("1.1.1.1")?.addressClass, .publicAddress)
    }

    func testTheLabelCountFollowsWhatwgNotFoundation() {
        // An IPv6 literal is ONE label there, four to a naive split over Foundation's bracket-stripped
        // host — this is the check that keeps `[::ffff:127.0.0.1]` from sailing through.
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "https://[::ffff:127.0.0.1]/")!), 1)
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "https://[::1]/")!), 1)
        // A numeric host is canonicalised to a dotted quad before the count there, so it passes the
        // label rule and is refused by the ADDRESS policy instead — with its far better text.
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "https://2130706433/")!), 4)
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "https://a.test/")!), 2)
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "https://localhost/")!), 1)
        XCTAssertEqual(WebFetchURL.labelCount(of: URL(string: "file:///etc/passwd")!), 1, "no host at all")
    }

    func testTheThreeFetchTimeRejects() {
        XCTAssertEqual(WebFetchURL.fetchTimeRefusal(URL(string: "https://a.test/" + String(repeating: "x", count: 2100))!), .tooLong)
        XCTAssertEqual(WebFetchURL.fetchTimeRefusal(URL(string: "https://u:p@a.test/")!), .embeddedCredentials)
        XCTAssertEqual(WebFetchURL.fetchTimeRefusal(URL(string: "https://localhost/")!), .singleLabelHostname)
        XCTAssertNil(WebFetchURL.fetchTimeRefusal(URL(string: "https://a.test/x")!))
    }

    func testTheUpgradeOnlyTouchesHttp() {
        XCTAssertEqual(WebFetchURL.upgradeToHTTPS(URL(string: "http://a.test:8080/x?q=1#f")!).absoluteString,
                       "https://a.test:8080/x?q=1#f")
        XCTAssertEqual(WebFetchURL.upgradeToHTTPS(URL(string: "https://a.test/x")!).absoluteString, "https://a.test/x")
        XCTAssertEqual(WebFetchURL.upgradeToHTTPS(URL(string: "ftp://a.test/x")!).absoluteString, "ftp://a.test/x")
    }
}
