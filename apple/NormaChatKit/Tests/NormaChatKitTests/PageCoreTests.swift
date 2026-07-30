import Foundation
import XCTest
@testable import NormaChatKit

/// PageCore: the cache (TTL, origin-aware eviction, in-flight dedupe), the fetch pipeline
/// (timeout/cancellation composition, post-redirect dangerous block, HTML vs raw-text paths), and
/// link extraction with the hostname-scoped ad filter.
///
/// Every clock here is FAKE (a plain `Date` handed to `get`/`put`, exactly as the TS passes `now`)
/// — no test sleeps to age an entry. The only real waiting is a sub-100 ms scripted timeout, which
/// is measuring the timeout itself.
final class PageCoreTests: XCTestCase {
    // MARK: - helpers

    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func page(_ url: String, lines: [String] = ["body"], links: [PageLink] = [],
                      at: Date? = nil) -> CleanPage {
        CleanPage(resolvedURL: url, title: "t", lines: lines, links: links,
                  fetchedAt: at ?? t0, fromCache: false)
    }

    /// A page whose estimated byte weight is approximately `bytes`.
    private func heavyPage(_ url: String, bytes: Int) -> CleanPage {
        page(url, lines: [String(repeating: "x", count: max(0, bytes - url.utf8.count - 2))])
    }

    private func makeFetcher(_ steps: [ScriptedChatHTTP.Step],
                             cache: PageCache,
                             timeout: TimeInterval = 5,
                             dangerousAdded: [String] = [],
                             maxBytes: Int = PageFetcher.defaultMaxBytes,
                             audit: PageAuditSink? = nil) -> (PageFetcher, ScriptedChatHTTP) {
        let http = ScriptedChatHTTP(steps)
        let clock = t0
        let fetcher = PageFetcher(http: http, cache: cache, dangerousAdded: dangerousAdded,
                                  timeout: timeout, maxBytes: maxBytes, audit: audit,
                                  now: { clock })
        return (fetcher, http)
    }

    // MARK: - cache: TTL

    func testPutThenGetInsideTheTtlServesTheCachedCopy() async {
        let cache = PageCache()
        await cache.put(page("https://a.test/1", lines: ["one", "two"]), now: t0)

        let hit = await cache.get("https://a.test/1", now: t0.addingTimeInterval(59 * 60))
        XCTAssertEqual(hit?.lines, ["one", "two"])
        XCTAssertEqual(hit?.fromCache, true, "a served copy must announce itself as cached")
    }

    func testEntryExpiresExactlyAtTheTtlBoundaryAndIsDropped() async {
        let cache = PageCache(ttl: 3600)
        await cache.put(page("https://a.test/1"), now: t0)

        let atBoundary = await cache.get("https://a.test/1", now: t0.addingTimeInterval(3600))
        XCTAssertNil(atBoundary, "TTL is `now >= expiresAt`, same as the TS")
        let count = await cache.count
        XCTAssertEqual(count, 0, "an expired entry is removed on the miss, not left to leak")
    }

    func testStoredPageIsAlwaysStoredAsNotFromCache() async {
        let cache = PageCache()
        var incoming = page("https://a.test/1")
        incoming.fromCache = true
        await cache.put(incoming, now: t0)
        let hit = await cache.get("https://a.test/1", now: t0)
        XCTAssertEqual(hit?.fromCache, true)
    }

    // MARK: - cache: LRU + eviction

    func testGetRefreshesRecencySoTheRefreshedEntrySurvivesEviction() async {
        let cache = PageCache(maxEntries: 2)
        await cache.put(page("https://a.test/1"), now: t0)
        await cache.put(page("https://a.test/2"), now: t0)
        _ = await cache.get("https://a.test/1", now: t0) // 1 becomes most-recently-used
        await cache.put(page("https://a.test/3"), now: t0)

        let keys = await cache.keysOldestFirst
        XCTAssertEqual(keys, ["https://a.test/1", "https://a.test/3"], "the untouched entry (2) evicts")
    }

    func testEntryCountCapEvictsOldestFirst() async {
        let cache = PageCache(maxEntries: 3)
        for i in 1 ... 5 { await cache.put(page("https://a.test/\(i)"), now: t0) }
        let keys = await cache.keysOldestFirst
        XCTAssertEqual(keys, ["https://a.test/3", "https://a.test/4", "https://a.test/5"])
    }

    /// Pass 1: research's own reserved byte share is trimmed proactively, among research entries
    /// ONLY, even when the overall caps are nowhere near hit.
    func testResearchEntriesAreTrimmedToTheirReservedByteShareAmongThemselves() async {
        // 30 KB total, 1/3 research share = 10 KB. Entry cap is deliberately generous so this is
        // purely the byte-share pass.
        let cache = PageCache(maxEntries: 100, maxBytes: 30_000, researchByteShare: 1.0 / 3.0)
        await cache.put(heavyPage("https://user.test/keep", bytes: 8_000), now: t0, origin: .user)
        await cache.put(heavyPage("https://r.test/1", bytes: 6_000), now: t0, origin: .research)
        await cache.put(heavyPage("https://r.test/2", bytes: 6_000), now: t0, origin: .research)

        let keys = await cache.keysOldestFirst
        XCTAssertTrue(keys.contains("https://user.test/keep"), "a user entry is never touched by pass 1")
        XCTAssertFalse(keys.contains("https://r.test/1"), "the oldest research entry pays for the share")
        XCTAssertTrue(keys.contains("https://r.test/2"))
    }

    /// Pass 2, the fix-round-2 bug the TS shipped: the entry-COUNT trim used to be origin-BLIND, so
    /// a pile of tiny research entries could evict a user's page with the byte budget nearly empty.
    func testCountPressureFromResearchNeverEvictsAUserEntry() async {
        let cache = PageCache(maxEntries: 5, maxBytes: 60 * 1024 * 1024)
        await cache.put(page("https://user.test/keep"), now: t0, origin: .user)
        for i in 1 ... 20 { await cache.put(page("https://r.test/\(i)"), now: t0, origin: .research) }

        let keys = await cache.keysOldestFirst
        XCTAssertTrue(keys.contains("https://user.test/keep"),
                      "no number of research entries may push out the user's own page")
        XCTAssertEqual(keys.count, 5)
    }

    /// Pass 3: only once every research entry is gone can a user entry be evicted — and then only by
    /// the user's OWN reading activity.
    func testUserEntriesEvictOnlyAfterEveryResearchEntryIsGone() async {
        let cache = PageCache(maxEntries: 2)
        await cache.put(page("https://user.test/old"), now: t0, origin: .user)
        await cache.put(page("https://r.test/1"), now: t0, origin: .research)
        await cache.put(page("https://user.test/new"), now: t0, origin: .user)

        var keys = await cache.keysOldestFirst
        XCTAssertEqual(keys, ["https://user.test/old", "https://user.test/new"])

        await cache.put(page("https://user.test/newest"), now: t0, origin: .user)
        keys = await cache.keysOldestFirst
        XCTAssertEqual(keys, ["https://user.test/new", "https://user.test/newest"],
                       "with no research left, the user's own oldest page is the one that goes")
    }

    func testRePuttingTheSameKeyReplacesRatherThanDoubleCounts() async {
        let cache = PageCache()
        await cache.put(heavyPage("https://a.test/1", bytes: 5_000), now: t0)
        let firstBytes = await cache.bytes
        await cache.put(heavyPage("https://a.test/1", bytes: 5_000), now: t0)
        let secondBytes = await cache.bytes
        let count = await cache.count
        XCTAssertEqual(firstBytes, secondBytes)
        XCTAssertEqual(count, 1)
    }

    // MARK: - fetch: happy paths

    func testHtmlPageIsCleanedTitledAndLinkExtracted() async throws {
        let cache = PageCache()
        let html = """
        <html><head><title>Ignored</title></head><body><h1>Real Title</h1>\
        <p>Hello <a href="/next">next page</a>.</p></body></html>
        """
        let (fetcher, http) = makeFetcher([.html(html)], cache: cache)

        let page = try await fetcher.fetch(url: "https://docs.test/start")

        XCTAssertEqual(page.resolvedURL, "https://docs.test/start")
        XCTAssertEqual(page.title, "Real Title", "h1 wins over <title>")
        XCTAssertEqual(page.lines, htmlToTextLines(html), "lines are exactly the cleaner's output")
        XCTAssertEqual(page.links, [PageLink(href: "https://docs.test/next", text: "next page")])
        XCTAssertFalse(page.fromCache)
        XCTAssertEqual(http.requestCount, 1)
    }

    func testNonHtmlBodyIsNotCleanedAndCrlfIsNormalised() async throws {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.plainText("  keep   spacing\r\nline two\r\n")], cache: cache)

        let page = try await fetcher.fetch(url: "https://docs.test/raw.txt")

        XCTAssertEqual(page.lines, ["  keep   spacing", "line two", ""],
                       "raw text keeps its own whitespace; only CRLF is normalised")
        XCTAssertEqual(page.title, "-")
        XCTAssertTrue(page.links.isEmpty)
    }

    func testSecondFetchOfTheSameUrlIsServedFromCacheWithNoSecondRequest() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([.html("<p>once</p>")], cache: cache)

        _ = try await fetcher.fetch(url: "https://docs.test/x")
        let second = try await fetcher.fetch(url: "https://docs.test/x")

        XCTAssertTrue(second.fromCache)
        XCTAssertEqual(http.requestCount, 1, "a scripted double with one step would throw on a second call")
    }

    func testBodyIsCappedAtMaxBytes() async throws {
        let cache = PageCache()
        let body = "<p>" + String(repeating: "a", count: 500) + "</p>"
        let (fetcher, _) = makeFetcher([.html(body)], cache: cache, maxBytes: 20)

        let page = try await fetcher.fetch(url: "https://docs.test/big")
        XCTAssertEqual(page.lines, ["aaaaaaaaaaaaaaaaa"], "20 bytes = `<p>` + 17 a's, cleaned")
    }

    func testAuditLineIsEmittedForEveryOutcome() async throws {
        let cache = PageCache()
        let box = AuditBox()
        let (fetcher, _) = makeFetcher([.html("<p>x</p>")], cache: cache, audit: { box.append($0) })

        _ = try await fetcher.fetch(url: "https://docs.test/x")
        _ = try await fetcher.fetch(url: "https://docs.test/x")

        XCTAssertEqual(box.lines.map(\.outcome), ["ok", "ok"])
        XCTAssertEqual(box.lines.map(\.fromCache), [false, true])
        XCTAssertEqual(box.lines.map(\.tool), ["ReadPage", "ReadPage"])
    }

    // MARK: - fetch: failure classification

    func testHttpErrorStatusIsClassifiedAndNothingIsCached() async throws {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.text("nope", status: 503)], cache: cache)

        await XCTAssertThrowsPageError(outcome: .httpError) {
            _ = try await fetcher.fetch(url: "https://docs.test/x")
        }
        let count = await cache.count
        XCTAssertEqual(count, 0)
    }

    func testTransportFailureIsANetworkErrorNotATimeout() async throws {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.failure(FakeTransportError())], cache: cache)

        await XCTAssertThrowsPageError(outcome: .networkError) {
            _ = try await fetcher.fetch(url: "https://docs.test/x")
        }
    }

    /// Review Minor 1: the whole `ssrfGuard` — including "invalid url" and the non-http(s) refusal —
    /// audits as `ssrf_refused`, exactly as `followRedirects` maps `kind: "ssrf"` on the Mac.
    func testNonHttpSchemeIsRefusedBeforeAnyRequest() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([], cache: cache)

        await XCTAssertThrowsPageError(outcome: .ssrfRefused) {
            _ = try await fetcher.fetch(url: "file:///etc/passwd")
        }
        XCTAssertEqual(http.requestCount, 0)
    }

    // MARK: - fetch: timeout + cancellation composition

    /// The 15 s default (here shortened) is a ceiling that applies even when the caller passes NO
    /// signal at all — the fix-round-1 CRITICAL in the TS was exactly an unbounded fetch.
    func testTimeoutFiresWithNoCallerSignal() async throws {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher([.hang], cache: cache, timeout: 0.05)

        await XCTAssertThrowsPageError(outcome: .timeout) {
            _ = try await fetcher.fetch(url: "https://slow.test/x")
        }
    }

    /// …and the caller's own signal can fire FIRST, well inside that ceiling. Both legs of the
    /// composition are live.
    func testCallerSignalAbortsInsideTheTimeoutCeiling() async throws {
        let cache = PageCache()
        let gate = TestGate()
        let (fetcher, _) = makeFetcher([.gated(gate, then: .html("<p>never</p>"))], cache: cache, timeout: 30)
        let signal = ChatAbortSignal()

        let fetch = Task { try await fetcher.fetch(url: "https://slow.test/x", signal: signal) }
        try await gate.waitUntilArrived()
        signal.abort()

        await XCTAssertThrowsPageError(outcome: .timeout) { _ = try await fetch.value }
        XCTAssertFalse(gate.isOpen, "the abort, not the scripted response, ended the fetch")
    }

    /// Review Minor 2: this used to assert `requestCount <= 1`, i.e. it PERMITTED the egress its own
    /// name denies — and the egress was real, because the task was created before `onAbort` was
    /// attached. Now the send short-circuits on an already-aborted signal, so the assertion is the
    /// one the name promises. It matters: with the LAN threat model behind `ssrfGuard`, "we already
    /// sent it, then cancelled" is not the same as "we never sent it".
    func testAnAlreadyAbortedSignalNeverReachesTheNetwork() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([.hang], cache: cache, timeout: 30)
        let signal = ChatAbortSignal()
        signal.abort()

        await XCTAssertThrowsPageError(outcome: .timeout) {
            _ = try await fetcher.fetch(url: "https://slow.test/x", signal: signal)
        }
        XCTAssertEqual(http.requestCount, 0, "zero egress — not one request that is cancelled afterwards")
    }

    // MARK: - dangerous domains

    func testDangerousRequestUrlIsBlockedBeforeAnyEgress() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([], cache: cache)

        await XCTAssertThrowsPageError(outcome: .dangerousDomain) {
            _ = try await fetcher.fetch(url: "https://raw.pastebin.com/secrets")
        }
        XCTAssertEqual(http.requestCount, 0, "the block is BEFORE the fetch, by user design")
    }

    /// The probed hole in the TS: a SAFE url that 302s INTO a dangerous host. The egress already
    /// happened, but the content must never reach the model or the cache.
    func testRedirectIntoADangerousHostIsBlockedAndNotCached() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher(
            [.redirect(status: 302, location: "https://transfer.sh/dropped")],
            cache: cache
        )

        await XCTAssertThrowsPageError(outcome: .dangerousDomainRedirect) {
            _ = try await fetcher.fetch(url: "https://safe.example/go")
        }
        let count = await cache.count
        XCTAssertEqual(count, 0, "the dangerous host's content never reaches the cache")
        XCTAssertEqual(http.requestCount, 1, "the redirect TARGET is never even requested")
    }

    func testRedirectReCheckHonoursTheUserAddedList() async throws {
        let cache = PageCache()
        let (fetcher, _) = makeFetcher(
            [.redirect(status: 302, location: "https://drop.corp.test/f")],
            cache: cache, dangerousAdded: ["corp.test"]
        )

        await XCTAssertThrowsPageError(outcome: .dangerousDomainRedirect) {
            _ = try await fetcher.fetch(url: "https://safe.example/go")
        }
    }

    // MARK: - in-flight dedupe

    func testConcurrentCallersForTheSameUrlShareOneFetch() async throws {
        let cache = PageCache()
        let gate = TestGate()
        let (fetcher, http) = makeFetcher([.gated(gate, then: .html("<p>shared</p>"))], cache: cache)
        let url = "https://docs.test/shared"

        let initiator = Task { try await fetcher.fetch(url: url) }
        try await gate.waitUntilArrived()
        let joiner = Task { try await fetcher.fetch(url: url) }
        try await TestGate.poll { await cache.inFlightWaiters(url) == 1 }

        gate.open()
        let a = try await initiator.value
        let b = try await joiner.value

        XCTAssertEqual(a.lines, ["shared"])
        XCTAssertEqual(b.lines, ["shared"])
        XCTAssertEqual(http.requestCount, 1, "one real fetch, two callers")
    }

    /// A joiner's abort detaches THAT caller only — proven by the joiner returning while the shared
    /// fetch is still held open, and the initiator still getting its page afterwards.
    func testJoinerAbortDetachesWithoutKillingTheSharedFetch() async throws {
        let cache = PageCache()
        let gate = TestGate()
        let (fetcher, http) = makeFetcher([.gated(gate, then: .html("<p>shared</p>"))], cache: cache, timeout: 30)
        let url = "https://docs.test/shared"

        let initiator = Task { try await fetcher.fetch(url: url) }
        try await gate.waitUntilArrived()

        let joinerSignal = ChatAbortSignal()
        let joiner = Task { try await fetcher.fetch(url: url, signal: joinerSignal) }
        try await TestGate.poll { await cache.inFlightWaiters(url) == 1 }
        joinerSignal.abort()

        do {
            _ = try await joiner.value
            XCTFail("the joiner should have detached")
        } catch {
            XCTAssertEqual(error as? ChatAbortError, .aborted)
        }
        XCTAssertFalse(gate.isOpen, "the joiner returned while the shared fetch was still in flight")

        gate.open()
        let page = try await initiator.value
        XCTAssertEqual(page.lines, ["shared"])
        XCTAssertEqual(http.requestCount, 1)
    }

    /// A joiner's origin is merged into the STORED tag, and `user` wins over `research` — a stronger
    /// claim on protection from eviction never loses to a weaker one.
    func testUserJoinerUpgradesAResearchInitiatorsCacheTag() async throws {
        let cache = PageCache()
        let gate = TestGate()
        let (fetcher, _) = makeFetcher([.gated(gate, then: .html("<p>shared</p>"))], cache: cache)
        let url = "https://docs.test/shared"

        let initiator = Task { try await fetcher.fetch(url: url, origin: .research) }
        try await gate.waitUntilArrived()
        let joiner = Task { try await fetcher.fetch(url: url, origin: .user) }
        try await TestGate.poll { await cache.inFlightWaiters(url) == 1 }

        gate.open()
        _ = try await initiator.value
        _ = try await joiner.value

        let stored = await cache.origin(of: url)
        XCTAssertEqual(stored, .user)
    }

    func testInFlightEntryIsClearedAfterFailureSoALaterCallerRefetches() async throws {
        let cache = PageCache()
        let (fetcher, http) = makeFetcher([.text("nope", status: 500), .html("<p>ok now</p>")], cache: cache)

        await XCTAssertThrowsPageError(outcome: .httpError) {
            _ = try await fetcher.fetch(url: "https://docs.test/x")
        }
        let page = try await fetcher.fetch(url: "https://docs.test/x")

        XCTAssertEqual(page.lines, ["ok now"])
        XCTAssertEqual(http.requestCount, 2)
        let inFlight = await cache.inFlightCount
        XCTAssertEqual(inFlight, 0)
    }

    // MARK: - link extraction + the ad filter

    func testLinksAreAbsoluteDedupedAndFilteredOfNoise() {
        let html = """
        <a href="/a">First</a>
        <a href="/a">Duplicate, different text</a>
        <a href="https://other.test/b">Absolute</a>
        <a href="#section">Fragment only</a>
        <a href="mailto:x@y.test">Mail</a>
        <a href="javascript:alert(1)">Script</a>
        """
        let links = extractLinks(html, baseURL: "https://base.test/dir/page")

        XCTAssertEqual(links, [
            PageLink(href: "https://base.test/a", text: "First"),
            PageLink(href: "https://other.test/b", text: "Absolute"),
        ])
    }

    func testAdTrackerBareHostEntriesMatchExactlyOrAsASubdomain() {
        let html = """
        <a href="https://doubleclick.net/x">exact</a>
        <a href="https://stats.doubleclick.net/x">subdomain</a>
        <a href="https://notdoubleclick.net/x">lookalike</a>
        <a href="https://example.test/doubleclick.net.html">path mention</a>
        """
        let hrefs = extractLinks(html, baseURL: "https://base.test/").map(\.href)

        XCTAssertEqual(hrefs, ["https://notdoubleclick.net/x", "https://example.test/doubleclick.net.html"])
    }

    /// `facebook.com/tr` is host-scoped AND path-boundary-aware: the real Meta Pixel lives on
    /// `www.facebook.com/tr`, while `/trending` and `/travel` are ordinary pages that must survive.
    func testAdTrackerHostPathEntryIsBoundaryAware() {
        let html = """
        <a href="https://facebook.com/tr?id=1">pixel</a>
        <a href="https://www.facebook.com/tr">www pixel</a>
        <a href="https://facebook.com/tr/child">child</a>
        <a href="https://facebook.com/trending">trending</a>
        <a href="https://facebook.com/travel">travel</a>
        <a href="https://other.test/tr">other host</a>
        """
        let hrefs = extractLinks(html, baseURL: "https://base.test/").map(\.href)

        XCTAssertEqual(hrefs, [
            "https://facebook.com/trending",
            "https://facebook.com/travel",
            "https://other.test/tr",
        ])
    }

    /// Nested-anchor semantics: an `<a>` opening inside an already-consumed anchor span is skipped,
    /// exactly as the original combined regex's `lastIndex` jump skipped it.
    func testNestedAnchorsFollowTheConsumedSpanRule() {
        let html = #"<a href="/outer">outer <a href="/inner">inner</a></a><a href="/after">after</a>"#
        let hrefs = extractLinks(html, baseURL: "https://base.test/").map(\.href)
        XCTAssertEqual(hrefs, ["https://base.test/outer", "https://base.test/after"])
    }

    func testAnchorWithNoClosingTagAnywhereYieldsNothing() {
        XCTAssertTrue(extractLinks(#"<a href="/x">dangling"#, baseURL: "https://base.test/").isEmpty)
    }

    // MARK: - WHATWG URL parity (the two classes a 28,000-case differential fuzz against the live
    // TS surfaced; the cleaner itself was byte-identical on all 28,000). Pinned here because the
    // fuzz harness needs both runtimes and so cannot live in the committed suite.

    /// `new URL(...)` strips leading/trailing C0-or-space and REMOVES tab/LF/CR anywhere in the
    /// input; `Foundation.URL` percent-encodes them instead.
    func testHrefPreprocessingMatchesTheWhatwgBasicParser() {
        XCTAssertEqual(whatwgPreprocess("  /lead  "), "/lead")
        XCTAssertEqual(whatwgPreprocess("/a\nb\tc\rd"), "/abcd")
        XCTAssertEqual(whatwgPreprocess("\u{01}/ctl\u{1F}"), "/ctl")
        XCTAssertEqual(whatwgPreprocess("/keep\u{00A0}nbsp"), "/keep\u{00A0}nbsp", "only ASCII controls go")
    }

    /// WHATWG gives every special-scheme URL a NON-EMPTY path; `URLComponents` does not. Review
    /// Important 2 — the 4th divergence class, and the most reachable of the four: it needs only an
    /// ordinary `<a href="https://example.com">`, where the other three needed malformed input.
    /// A page linking both `https://example.com` and `https://example.com/` (overwhelmingly common)
    /// would otherwise yield two `CleanPage.links` entries on the phone and one on the Mac, and
    /// downstream two cache keys for one page.
    ///
    /// These are the exact 8 shapes the reviewer's 24-case realistic differential found diverging;
    /// the other 16 already agreed and are covered by the sibling tests.
    func testEmptyPathNormalisesToSlashLikeWhatwg() {
        let cases: [(href: String, expected: String)] = [
            ("https://example.com", "https://example.com/"),
            ("//example.com", "https://example.com/"),
            ("https://example.com?q=1", "https://example.com/?q=1"),
            ("https://example.com#f", "https://example.com/#f"),
            ("http://u:p@example.com", "http://u:p@example.com/"),
            ("https://ex.com:8080", "https://ex.com:8080/"),
            ("HTTPS://EX.COM", "https://ex.com/"),
            ("https://example.com:443", "https://example.com/"),
        ]
        for (href, expected) in cases {
            let html = "<a href=\"\(href)\">x</a>"
            XCTAssertEqual(extractLinks(html, baseURL: "https://base.test/dir/page").map(\.href), [expected],
                           "WHATWG divergence for href \(href)")
        }
    }

    /// The failure this class actually causes downstream: the bare and slashed spellings must dedupe
    /// to ONE link, as they do in JS.
    func testBareAndSlashedAuthorityDedupeToOneLink() {
        let html = #"<a href="https://example.com">bare</a><a href="https://example.com/">slashed</a>"#
        XCTAssertEqual(extractLinks(html, baseURL: "https://base.test/").map(\.href), ["https://example.com/"])
    }

    /// A lowercase scheme + host and an elided default port. These are the dedupe key here and the
    /// cache key downstream — `HTTP://Example.COM/A` must not read as a different page.
    func testResolvedHrefIsWhatwgNormalised() {
        let html = """
        <a href="HTTP://Example.COM/A">upper</a>
        <a href="https://x.test:443/p">default port</a>
        <a href="http://y.test:80/q">default port http</a>
        <a href="https://z.test:8443/r">non-default port survives</a>
        <a href="http://example.com/A">already lowercase, must dedupe with the first</a>
        """
        let hrefs = extractLinks(html, baseURL: "https://base.test/").map(\.href)

        XCTAssertEqual(hrefs, [
            "http://example.com/A",
            "https://x.test/p",
            "http://y.test/q",
            "https://z.test:8443/r",
        ], "path case is preserved; only scheme/host fold and default ports elide")
    }

    // MARK: - linearity guard

    // The whole reason this port keeps the two-pass/monotonic-pointer shape, and the reason these
    // probes use the shape they do.
    //
    // THE ADVERSARIAL SHAPE IS THE **ABSENT** CLOSE, NOT A DISTANT ONE. An earlier version of these
    // probes used "many opens + ONE distant close", which the TS's own linearity test explicitly
    // keeps SMALL because it is fast even pre-fix (`page-core.test.ts:255-262`: the first open
    // absorbs everything up to the close, so there is only ever one long scan). Measured by the
    // reviewer on the pre-fix combined lazy regexes, at 80k/20k opens:
    //
    //     shape                              V8 (bun)     ICU (NSRegularExpression)
    //     80k opens + 1 distant close           0.8 ms          11 ms      <- inert as a probe
    //     20k opens, close ABSENT           21,296 ms      57,504 ms      <- the real thing
    //
    // With no close after them, EVERY open independently rescans to end-of-string. That is the
    // O(n²) the linearization exists to kill, and it is what a "simplify it back to one regex"
    // regression reintroduces. Each probe below therefore prefixes ONE properly-closed pair (so the
    // `closes.isEmpty` short-circuit cannot carry the test on its own and the pointer logic really
    // runs) and then piles on 20,000 opens that never close.
    //
    // CEILING CALIBRATION — measured, not guessed. I built a deliberately-quadratic mutant
    // (`replacePaired`/`convertHeadings`/`extractLinks`/`stripTags` each swapped back for the single
    // combined `OPEN[\s\S]*?CLOSE` regex they replaced), ran these probes against it, then restored.
    // Debug build, same machine, same inputs:
    //
    //     probe                          linear     quadratic mutant     ratio    verdict
    //     convertAnchors                 70.6 ms          57,669 ms       816x    mutant FAILS
    //     convertHeadings                35.9 ms          11,484 ms       320x    mutant FAILS
    //     stripPairedLiteral(script)     48.7 ms          31,396 ms       644x    mutant FAILS
    //     stripPairedLiteral(style)      43.4 ms          25,566 ms       589x    mutant FAILS
    //     stripPairedLiteral(head)       38.4 ms          24,543 ms       640x    mutant FAILS
    //     extractLinks                   16.3 ms          59,326 ms      3636x    mutant FAILS
    //
    // A 1 s ceiling sits ~14x above the slowest linear run and ~11x below the FASTEST mutant run,
    // so it is both non-flaky and genuinely discriminating. (The old distant-close probes cleared a
    // 5 s ceiling by ~450x even when quadratic — they could not fail. Review Important 1.)
    private static let quadraticProbeOpens = 20_000
    private static let linearityCeiling = Duration.seconds(1)

    func testAnchorPairingStaysLinearWhenTheCloseIsAbsent() {
        let soup = #"<a href="/first">closed</a>"# + String(repeating: #"<a href="/x">t"#, count: Self.quadraticProbeOpens)
        assertFast("convertAnchors") { _ = htmlToText(soup) }
    }

    func testHeadingPairingStaysLinearWhenTheCloseIsAbsent() {
        let soup = "<h1>closed</h1>" + String(repeating: "<h1>t", count: Self.quadraticProbeOpens)
        assertFast("convertHeadings") { _ = htmlToText(soup) }
    }

    /// `web.ts:93-111` names script/style/head as the DOMINANT pre-fix cost — `htmlToText` runs on
    /// every byte of every HTML fetch, so a re-quadraticised strip pass hurts more than the anchor
    /// one. These three passes previously had no probe at all (review Important 1).
    func testScriptStyleHeadStripsStayLinearWhenTheCloseIsAbsent() {
        for (name, closed, open) in [("script", "<script>x</script>", "<script x"),
                                     ("style", "<style>x</style>", "<style y"),
                                     ("head", "<head>x</head>", "<head z")] {
            let soup = closed + String(repeating: open, count: Self.quadraticProbeOpens)
            assertFast("stripPairedLiteral(\(name))") { _ = htmlToText(soup) }
        }
    }

    /// `extractLinks` has its own pairing loop, separate from the cleaner's.
    func testLinkExtractionStaysLinearWhenTheCloseIsAbsent() {
        let soup = #"<a href="/first">closed</a>"# + String(repeating: #"<a href="/x">t"#, count: Self.quadraticProbeOpens)
        assertFast("extractLinks") { _ = extractLinks(soup, baseURL: "https://base.test/") }
    }

    /// Pairing CORRECTNESS on the distant-close shape still matters — it just belongs in a
    /// correctness test, not a timing one. (`testNestedAnchorsFollowTheConsumedSpanRule` covers the
    /// nested case; this covers the plain one.)
    func testDistantCloseStillPairsWithTheFirstOpenOnly() {
        let soup = String(repeating: #"<a href="/x">t"#, count: 3) + "</a>"
        XCTAssertEqual(extractLinks(soup, baseURL: "https://base.test/").map(\.href), ["https://base.test/x"])
    }

    private func assertFast(_ what: String, _ body: () -> Void, file: StaticString = #filePath, line: UInt = #line) {
        let started = ContinuousClock.now
        body()
        let elapsed = ContinuousClock.now - started
        XCTAssertLessThan(elapsed, Self.linearityCeiling,
                          "\(what) went superlinear: \(elapsed)", file: file, line: line)
    }
}

// MARK: - test helpers

private final class AuditBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [PageAuditLine] = []
    var lines: [PageAuditLine] { lock.withLock { storage } }
    func append(_ line: PageAuditLine) { lock.withLock { storage.append(line) } }
}

extension XCTestCase {
    /// `message`, when given, is asserted verbatim — the refusal text is the audit/transcript surface
    /// and has to match the TS byte for byte, not merely classify the same way.
    func XCTAssertThrowsPageError(outcome: PageFetchOutcome,
                                  message expectedMessage: String? = nil,
                                  file: StaticString = #filePath,
                                  line: UInt = #line,
                                  _ body: () async throws -> Void) async {
        do {
            try await body()
            XCTFail("expected a PageFetchError(\(outcome.rawValue))", file: file, line: line)
        } catch let error as PageFetchError {
            XCTAssertEqual(error.outcome, outcome, "message was: \(error.message)", file: file, line: line)
            if let expectedMessage {
                XCTAssertEqual(error.message, expectedMessage, file: file, line: line)
            }
        } catch {
            XCTFail("expected a PageFetchError(\(outcome.rawValue)), got \(error)", file: file, line: line)
        }
    }
}
