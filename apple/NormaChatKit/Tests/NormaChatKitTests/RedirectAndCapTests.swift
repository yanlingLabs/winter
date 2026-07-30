import Foundation
import XCTest
@testable import NormaChatKit

/// The manual redirect loop (`followRedirects`) and the streaming body cap (`collectCapped`) —
/// the two halves of `ssrfGuard` parity that are about the TRANSPORT rather than the address check.
///
/// Why the loop is manual at all: a compliant first URL must not be able to 302 into a private
/// address or a known exfiltration host. A transport that chases redirects itself makes every hop
/// after the first invisible, and therefore unguarded.
final class RedirectAndCapTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func makeFetcher(_ steps: [ScriptedChatHTTP.Step],
                             cache: PageCache = PageCache(),
                             maxBytes: Int = PageFetcher.defaultMaxBytes,
                             dangerousAdded: [String] = []) -> (PageFetcher, ScriptedChatHTTP, PageCache) {
        let http = ScriptedChatHTTP(steps)
        let clock = t0
        return (PageFetcher(http: http, cache: cache, dangerousAdded: dangerousAdded,
                            timeout: 5, maxBytes: maxBytes, now: { clock }), http, cache)
    }

    // MARK: - redirect following

    func testRedirectsAreFollowedAndTheFinalUrlIsTheResolvedOne() async throws {
        let (fetcher, http, _) = makeFetcher([
            .redirect(status: 301, location: "https://docs.test/b"),
            .redirect(status: 302, location: "/c"), // relative — resolved against the CURRENT hop
            .html("<p>arrived</p>"),
        ])

        let page = try await fetcher.fetch(url: "https://docs.test/a")

        XCTAssertEqual(page.lines, ["arrived"])
        XCTAssertEqual(page.resolvedURL, "https://docs.test/c", "the citation cites the final address")
        XCTAssertEqual(http.requestedURLs, ["https://docs.test/a", "https://docs.test/b", "https://docs.test/c"])
    }

    /// `MAX_REDIRECT_HOPS = 3`: three redirects are followed, the fourth is refused.
    func testThreeHopsAreAllowed() async throws {
        let (fetcher, http, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/2"),
            .redirect(status: 302, location: "https://docs.test/3"),
            .redirect(status: 302, location: "https://docs.test/4"),
            .html("<p>ok</p>"),
        ])

        let page = try await fetcher.fetch(url: "https://docs.test/1")
        XCTAssertEqual(page.lines, ["ok"])
        XCTAssertEqual(http.requestCount, 4)
    }

    func testAFourthRedirectIsRefused() async throws {
        let (fetcher, http, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/2"),
            .redirect(status: 302, location: "https://docs.test/3"),
            .redirect(status: 302, location: "https://docs.test/4"),
            .redirect(status: 302, location: "https://docs.test/5"),
        ])

        await XCTAssertThrowsPageError(outcome: .tooManyRedirects, message: "too many redirects (>3 hops)") {
            _ = try await fetcher.fetch(url: "https://docs.test/1")
        }
        XCTAssertEqual(http.requestCount, 4, "the 5th address is never requested")
    }

    /// The missing-`Location` check comes BEFORE the hop bound, so a malformed redirect reads as
    /// malformed rather than as "too many hops" — the TS orders it the same way.
    func testRedirectWithNoLocationIsAnHttpErrorNotAHopBound() async throws {
        let (fetcher, _, _) = makeFetcher([.redirect(status: 302, location: nil)])

        await XCTAssertThrowsPageError(outcome: .httpError,
                                       message: "redirect (302) with no Location header") {
            _ = try await fetcher.fetch(url: "https://docs.test/a")
        }
    }

    func testMissingLocationIsReportedEvenOnTheHopThatWouldOtherwiseExceedTheBound() async throws {
        let (fetcher, _, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/2"),
            .redirect(status: 302, location: "https://docs.test/3"),
            .redirect(status: 302, location: "https://docs.test/4"),
            .redirect(status: 307, location: nil), // hop 3: bound would fire, but Location is checked first
        ])

        await XCTAssertThrowsPageError(outcome: .httpError,
                                       message: "redirect (307) with no Location header") {
            _ = try await fetcher.fetch(url: "https://docs.test/1")
        }
    }

    // MARK: - the guard applies to EVERY hop

    /// The headline hole this fix round closes: hop 0 is a perfectly ordinary public URL, and the
    /// redirect target is the user's router.
    func testCompliantFirstHopRedirectingIntoAPrivateAddressIsBlocked() async throws {
        let (fetcher, http, cache) = makeFetcher([
            .redirect(status: 302, location: "http://192.168.1.1/admin"),
        ])

        await XCTAssertThrowsPageError(outcome: .ssrfRefused,
                                       message: "refusing to fetch a private address") {
            _ = try await fetcher.fetch(url: "https://safe.example/go")
        }
        XCTAssertEqual(http.requestCount, 1, "the private address is never requested")
        let count = await cache.count
        XCTAssertEqual(count, 0)
    }

    func testRedirectIntoLoopbackAndMetadataAddressesAreBlocked() async throws {
        for target in ["http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/",
                       "http://[::1]/", "http://localhost/", "http://[::ffff:a00:1]/"] {
            let (fetcher, _, _) = makeFetcher([.redirect(status: 302, location: target)])
            await XCTAssertThrowsPageError(outcome: .ssrfRefused) {
                _ = try await fetcher.fetch(url: "https://safe.example/go")
            }
        }
    }

    func testRedirectIntoANonHttpSchemeIsBlocked() async throws {
        let (fetcher, http, _) = makeFetcher([.redirect(status: 302, location: "file:///etc/passwd")])

        await XCTAssertThrowsPageError(outcome: .ssrfRefused,
                                       message: "only http(s) urls are allowed") {
            _ = try await fetcher.fetch(url: "https://safe.example/go")
        }
        XCTAssertEqual(http.requestCount, 1)
    }

    /// A LATER hop is guarded too, not just the first redirect.
    func testTheGuardRunsOnEveryHopNotJustTheFirstRedirect() async throws {
        let (fetcher, http, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/2"),
            .redirect(status: 302, location: "https://docs.test/3"),
            .redirect(status: 302, location: "http://10.1.2.3/internal"),
        ])

        await XCTAssertThrowsPageError(outcome: .ssrfRefused,
                                       message: "refusing to fetch a private address") {
            _ = try await fetcher.fetch(url: "https://docs.test/1")
        }
        XCTAssertEqual(http.requestCount, 3)
    }

    // MARK: - streaming body cap

    /// `collectCapped` must stop PULLING at the cap. A pull-counting source proves it: if the body
    /// were read whole and then sliced, the counter would read the full generated size.
    func testCollectCappedStopsPullingAtTheCap() async throws {
        let counter = ByteCounter()
        let stream = CountingByteStream(source: .generated(count: 1_000_000, byte: UInt8(ascii: "a")),
                                        counter: counter)

        let (body, truncated) = try await collectCapped(stream, maxBytes: 100)

        XCTAssertEqual(body.count, 100)
        XCTAssertTrue(truncated)
        XCTAssertEqual(counter.value, 100, "the producer was never asked for byte 101")
    }

    func testCollectCappedReturnsEverythingWhenUnderTheCap() async throws {
        let counter = ByteCounter()
        let stream = CountingByteStream(source: .data([UInt8]("hello".utf8)), counter: counter)

        let (body, truncated) = try await collectCapped(stream, maxBytes: 100)

        XCTAssertEqual(String(decoding: body, as: UTF8.self), "hello")
        XCTAssertFalse(truncated)
        XCTAssertEqual(counter.value, 5)
    }

    /// End-to-end through the fetcher: an oversized page is truncated DURING collection, so the
    /// transport is never asked to hand over the rest.
    func testOversizedBodyIsTruncatedMidStreamNotBuffered() async throws {
        let (fetcher, http, _) = makeFetcher([.generatedHTML(byteCount: 1_000_000)], maxBytes: 512)

        let page = try await fetcher.fetch(url: "https://big.test/page")

        XCTAssertEqual(page.lines, [String(repeating: "a", count: 512)])
        XCTAssertEqual(http.pulled.value, 512,
                       "the fetcher stopped the stream at the cap instead of buffering 1 MB")
    }

    /// …and at the real production cap, so the number itself is exercised rather than only the
    /// mechanism. `MAX_FETCH_BYTES` is 5 MB, same as `web.ts`.
    func testProductionCapIsFiveMegabytesAndIsEnforcedMidStream() async throws {
        XCTAssertEqual(PageFetcher.defaultMaxBytes, 5 * 1024 * 1024)

        let overCap = PageFetcher.defaultMaxBytes + 4096
        let (fetcher, http, _) = makeFetcher([.generatedHTML(byteCount: overCap)])

        let page = try await fetcher.fetch(url: "https://big.test/page")

        XCTAssertEqual(page.lines.first?.count, PageFetcher.defaultMaxBytes)
        XCTAssertEqual(http.pulled.value, PageFetcher.defaultMaxBytes,
                       "never pulled the 4 KB past the cap")
    }

    /// A redirect's body is never pulled at all — otherwise a 4-hop chain could stream `maxBytes`
    /// per hop before the loop ever reached a real page.
    func testRedirectBodiesAreNeverPulled() async throws {
        let (fetcher, http, _) = makeFetcher([
            .redirect(status: 302, location: "https://docs.test/b"),
            .html("<p>x</p>"),
        ])

        _ = try await fetcher.fetch(url: "https://docs.test/a")
        XCTAssertEqual(http.pulled.value, "<p>x</p>".utf8.count, "only the final page's body was read")
    }

    /// Non-2xx bodies are likewise never read (the TS calls `readCapped` only on the success path).
    func testErrorStatusBodiesAreNeverPulled() async throws {
        let (fetcher, http, _) = makeFetcher([.html(String(repeating: "x", count: 10_000), status: 500)])

        await XCTAssertThrowsPageError(outcome: .httpError, message: "fetch failed: 500") {
            _ = try await fetcher.fetch(url: "https://docs.test/a")
        }
        XCTAssertEqual(http.pulled.value, 0)
    }
}
