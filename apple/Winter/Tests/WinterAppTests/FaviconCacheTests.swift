import XCTest
import AppKit
@testable import Winter

/// The plume's favicons: the EXACT icon url a web tool reported is what is fetched; with none, one
/// `/favicon.ico` attempt; an in-memory dedupe (never disk) so a tile drawn every frame never
/// refetches and a failure stays a globe; public https hosts only. The network is a stub throughout.
@MainActor
final class FaviconCacheTests: XCTestCase {
    /// Every URL the stub was asked for, and what it answers.
    private final class StubNetwork: @unchecked Sendable {
        private let lock = NSLock()
        private var _asked: [URL] = []
        var answers: [String: Data] = [:]
        var asked: [URL] { lock.withLock { _asked } }
        var fetch: FaviconCache.Fetch {
            { [self] url, maxBytes in
                self.lock.withLock { self._asked.append(url) }
                guard let data = self.lock.withLock({ self.answers[url.absoluteString] }), data.count <= maxBytes else { return nil }
                return data
            }
        }
    }

    private func png(side: Int, color: NSColor = .systemOrange) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        color.setFill()
        NSRect(x: 0, y: 0, width: side, height: side).fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }

    private func waitForImage(_ cache: FaviconCache, host: String, iconURL: String?, timeout: TimeInterval = 3) -> NSImage? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let image = cache.image(host: host, iconURL: iconURL) { return image }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        return cache.image(host: host, iconURL: iconURL)
    }

    private func waitUntilSettled(_ cache: FaviconCache, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, cache.pendingCountForTesting > 0 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    // MARK: - What is fetched

    func testTheToolsIconURLIsFetchedExactlyAndOnlyOnce() {
        let net = StubNetwork()
        let icon = "https://cdn.example.net/beta/icon-32.png"
        net.answers[icon] = png(side: 32)
        let cache = FaviconCache(fetch: net.fetch)
        XCTAssertNil(cache.image(host: "beta.example.org", iconURL: icon), "never blocks: nil while it loads")
        XCTAssertNotNil(waitForImage(cache, host: "beta.example.org", iconURL: icon))
        for _ in 0..<50 { XCTAssertNotNil(cache.image(host: "beta.example.org", iconURL: icon)) } // every frame
        XCTAssertEqual(net.asked.map(\.absoluteString), [icon], "the exact url, once — no favicon.ico, no home page")
    }

    func testWithNoIconURLTheHostsFaviconIcoIsTriedOnceThenAGlobe() {
        let net = StubNetwork() // answers nothing
        let cache = FaviconCache(fetch: net.fetch)
        XCTAssertNil(cache.image(host: "nothing.example", iconURL: nil))
        waitUntilSettled(cache)
        for _ in 0..<20 { XCTAssertNil(cache.image(host: "nothing.example", iconURL: nil)) }
        waitUntilSettled(cache)
        XCTAssertEqual(net.asked.map(\.absoluteString), ["https://nothing.example/favicon.ico"],
                       "one attempt, then the failure is remembered for the run — never the home page")
    }

    func testTheFallbackLoadsWhenTheSiteHasAFaviconIco() {
        let net = StubNetwork()
        net.answers["https://www.apple.com/favicon.ico"] = png(side: 16)
        let cache = FaviconCache(fetch: net.fetch)
        XCTAssertNotNil(waitForImage(cache, host: "www.apple.com", iconURL: nil))
    }

    func testAFailedIconURLStaysAGlobeAndIsNotRetried() {
        let net = StubNetwork()
        let cache = FaviconCache(fetch: net.fetch)
        let icon = "https://a.example.com/missing.png"
        XCTAssertNil(cache.image(host: "a.example.com", iconURL: icon))
        waitUntilSettled(cache)
        XCTAssertNil(cache.image(host: "a.example.com", iconURL: icon))
        waitUntilSettled(cache)
        XCTAssertEqual(net.asked.count, 1)
    }

    func testTwoCachesShareNothing_NothingIsPersisted() {
        let net = StubNetwork()
        let icon = "https://a.example.com/i.png"
        net.answers[icon] = png(side: 32)
        XCTAssertNotNil(waitForImage(FaviconCache(fetch: net.fetch), host: "a.example.com", iconURL: icon))
        let relaunched = FaviconCache(fetch: net.fetch)
        XCTAssertNotNil(waitForImage(relaunched, host: "a.example.com", iconURL: icon))
        XCTAssertEqual(net.asked.count, 2, "a new run asks again: no disk cache to go stale")
    }

    func testAPrivateHostOrIconIsNeverFetched() {
        let net = StubNetwork()
        let cache = FaviconCache(fetch: net.fetch)
        for host in ["localhost", "192.168.1.10", "printer.local"] { XCTAssertNil(cache.image(host: host, iconURL: nil)) }
        // A private or plain-http ICON on a public page falls back to the page's own favicon.ico.
        XCTAssertNil(cache.image(host: "a.example.com", iconURL: "https://10.0.0.5/i.png"))
        XCTAssertNil(cache.image(host: "b.example.com", iconURL: "http://b.example.com/i.png"))
        waitUntilSettled(cache)
        XCTAssertEqual(Set(net.asked.map(\.absoluteString)), ["https://a.example.com/favicon.ico", "https://b.example.com/favicon.ico"])
    }

    func testTheIconIsKeptSmall() throws {
        let net = StubNetwork()
        let icon = "https://big.example/apple-touch-icon.png"
        net.answers[icon] = png(side: 256)
        let cache = FaviconCache(fetch: net.fetch)
        let image = try XCTUnwrap(waitForImage(cache, host: "big.example", iconURL: icon))
        let rep = try XCTUnwrap(image.representations.first as? NSBitmapImageRep)
        XCTAssertEqual(rep.pixelsWide, FaviconCache.iconPixelSize)
    }

    // MARK: - Pure helpers

    func testTheRequestURLIsTheToolsIconElseTheHostsFaviconIco() {
        XCTAssertEqual(faviconRequestURL(host: "a.com", iconURL: "https://cdn.a.com/i.png")?.absoluteString, "https://cdn.a.com/i.png")
        XCTAssertEqual(faviconRequestURL(host: "a.com", iconURL: nil)?.absoluteString, "https://a.com/favicon.ico")
        XCTAssertEqual(faviconRequestURL(host: "a.com", iconURL: "http://a.com/i.png")?.absoluteString, "https://a.com/favicon.ico", "https only")
        XCTAssertEqual(faviconRequestURL(host: "a.com", iconURL: "https://127.0.0.1/i.png")?.absoluteString, "https://a.com/favicon.ico")
        XCTAssertNil(faviconRequestURL(host: "intranet", iconURL: "https://cdn.a.com/i.png"), "a private page host fetches nothing")
    }

    func testARedirectIsFollowedOnlyToAPublicHttpsName() {
        XCTAssertTrue(faviconRedirectAllowed(URL(string: "https://cdn.example.com/i.png")))
        XCTAssertFalse(faviconRedirectAllowed(URL(string: "http://cdn.example.com/i.png")))
        XCTAssertFalse(faviconRedirectAllowed(URL(string: "https://192.168.0.1/i.png")))
        XCTAssertFalse(faviconRedirectAllowed(URL(string: "https://router.local/i.png")))
        XCTAssertFalse(faviconRedirectAllowed(nil))
    }

    func testAnyImageIsNormalisedToASmallPNGAndJunkIsRefused() throws {
        let normalised = try XCTUnwrap(faviconNormalizedPNG(png(side: 180)))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: normalised))
        XCTAssertEqual(rep.pixelsWide, FaviconCache.iconPixelSize)
        XCTAssertNil(faviconNormalizedPNG(Data("<html>not an image</html>".utf8)))
        XCTAssertNil(faviconNormalizedPNG(Data()))
    }
}
