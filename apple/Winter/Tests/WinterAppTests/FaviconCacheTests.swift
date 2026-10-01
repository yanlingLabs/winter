import XCTest
import AppKit
@testable import Winter

/// The plume's favicon cache: memory → disk → network, the miss marker, the stale refresh, the home
/// page's declared icon, and the pure parsing/normalising helpers. The network is a stub throughout.
@MainActor
final class FaviconCacheTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("WinterFaviconTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

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

    private func waitForImage(_ cache: FaviconCache, _ host: String, timeout: TimeInterval = 3) -> NSImage? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let image = cache.image(for: host) { return image }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        return cache.image(for: host)
    }

    private func waitUntilSettled(_ cache: FaviconCache, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, cache.pendingCountForTesting > 0 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    // MARK: - Memory → disk → network

    func testASiteMetOnceIsDrawnFromDiskOnEveryLaterLaunch() {
        let net = StubNetwork()
        net.answers["https://example.com/favicon.ico"] = png(side: 32)
        let first = FaviconCache(directory: directory, fetch: net.fetch)
        XCTAssertNil(first.image(for: "example.com"), "never blocks: nil while it looks")
        XCTAssertNotNil(waitForImage(first, "example.com"))
        XCTAssertEqual(net.asked.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("example.com.png").path))

        let offline = StubNetwork()
        let relaunched = FaviconCache(directory: directory, fetch: offline.fetch)
        XCTAssertNotNil(waitForImage(relaunched, "example.com"), "a later launch reads it from disk")
        XCTAssertTrue(offline.asked.isEmpty, "…without asking the site again")
    }

    func testTheIconIsKeptSmallOnDisk() throws {
        let net = StubNetwork()
        net.answers["https://big.example/favicon.ico"] = png(side: 256)
        let cache = FaviconCache(directory: directory, fetch: net.fetch)
        _ = waitForImage(cache, "big.example")
        waitUntilSettled(cache)
        let stored = try Data(contentsOf: directory.appendingPathComponent("big.example.png"))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: stored))
        XCTAssertEqual(rep.pixelsWide, FaviconCache.iconPixelSize)
    }

    func testASiteWithNoIconIsNotAskedAgainForAWhile() {
        let net = StubNetwork() // answers nothing
        var clock = Date() // the markers carry real modification times
        let cache = FaviconCache(directory: directory, fetch: net.fetch, now: { [clock] in clock })
        XCTAssertNil(cache.image(for: "nothing.example"))
        waitUntilSettled(cache)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("nothing.example.miss").path))
        let askedOnce = net.asked.count
        XCTAssertEqual(askedOnce, 2, "favicon.ico, then the home page")
        XCTAssertNil(cache.image(for: "nothing.example"))
        waitUntilSettled(cache)
        XCTAssertEqual(net.asked.count, askedOnce, "this run remembers the miss")

        let soon = FaviconCache(directory: directory, fetch: net.fetch, now: { [clock] in clock })
        XCTAssertNil(soon.image(for: "nothing.example"))
        waitUntilSettled(soon)
        XCTAssertEqual(net.asked.count, askedOnce, "a relaunch inside the retry window does not ask")

        clock = clock.addingTimeInterval(FaviconCache.missRetryAfter + 3600)
        let later = FaviconCache(directory: directory, fetch: net.fetch, now: { [clock] in clock })
        XCTAssertNil(later.image(for: "nothing.example"))
        waitUntilSettled(later)
        XCTAssertGreaterThan(net.asked.count, askedOnce, "past the retry window it is tried again")
    }

    func testAStaleIconIsDrawnAtOnceAndRefreshedBehindIt() throws {
        let old = png(side: 32, color: .systemRed)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("stale.example.png")
        try faviconNormalizedPNG(old)!.write(to: file)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-FaviconCache.freshFor - 3600)],
                                              ofItemAtPath: file.path)
        let net = StubNetwork()
        net.answers["https://stale.example/favicon.ico"] = png(side: 48, color: .systemGreen)
        let cache = FaviconCache(directory: directory, fetch: net.fetch)
        XCTAssertNotNil(waitForImage(cache, "stale.example"))
        waitUntilSettled(cache)
        XCTAssertEqual(net.asked.map(\.absoluteString), ["https://stale.example/favicon.ico"], "refreshed once")
        let modified = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        XCTAssertLessThan(Date().timeIntervalSince(modified), 60, "the fresh copy replaced the stale one")
    }

    func testTheHomePagesDeclaredIconIsUsedWhenThereIsNoFaviconIco() {
        let net = StubNetwork()
        net.answers["https://news.example/"] = Data(#"""
        <html><head>
        <link rel="mask-icon" href="/mask.svg" color="#000">
        <link rel="icon" type="image/png" href="/static/icon-32.png">
        </head></html>
        """#.utf8)
        net.answers["https://news.example/static/icon-32.png"] = png(side: 32)
        let cache = FaviconCache(directory: directory, fetch: net.fetch)
        XCTAssertNotNil(waitForImage(cache, "news.example"))
        XCTAssertEqual(net.asked.map(\.absoluteString), [
            "https://news.example/favicon.ico", "https://news.example/", "https://news.example/static/icon-32.png",
        ])
    }

    func testAPrivateHostIsNeverFetched() {
        let net = StubNetwork()
        let cache = FaviconCache(directory: directory, fetch: net.fetch)
        for host in ["localhost", "192.168.1.10", "printer.local"] { XCTAssertNil(cache.image(for: host)) }
        waitUntilSettled(cache)
        XCTAssertTrue(net.asked.isEmpty)
    }

    func testPruningKeepsTheNewestEntries() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let now = Date()
        for i in 0..<5 {
            let url = directory.appendingPathComponent("s\(i).example.png")
            try Data([1]).write(to: url)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(Double(-i) * 60)], ofItemAtPath: url.path)
        }
        let ancient = directory.appendingPathComponent("old.example.png")
        try Data([1]).write(to: ancient)
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-FaviconCache.pruneOlderThan - 60)],
                                              ofItemAtPath: ancient.path)
        FaviconCache.prune(directory, now: now, keep: 3, olderThan: FaviconCache.pruneOlderThan)
        let left = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        XCTAssertEqual(left, ["s0.example.png", "s1.example.png", "s2.example.png"])
    }

    // MARK: - Pure helpers

    func testThePagesBestIconIsChosen() {
        XCTAssertEqual(faviconLinkHref(inHTML: #"<link rel="icon" href="/a.png"><link rel="apple-touch-icon" href="/touch.png">"#),
                       "/touch.png", "the large touch icon wins")
        XCTAssertEqual(faviconLinkHref(inHTML: #"<LINK REL='shortcut icon' HREF='/f.ico'>"#), "/f.ico")
        XCTAssertEqual(faviconLinkHref(inHTML: "<link rel=icon href=/bare.png>"), "/bare.png", "unquoted attributes")
        XCTAssertNil(faviconLinkHref(inHTML: #"<link rel="icon" href="/logo.svg"><link rel="mask-icon" href="/m.png">"#),
                     "never an SVG or a mask")
        XCTAssertNil(faviconLinkHref(inHTML: #"<link rel="stylesheet" href="/s.css">"#))
        XCTAssertNil(faviconLinkHref(inHTML: #"<link rel="icon" href="data:image/png;base64,AAAA">"#))
    }

    func testAnIconHrefResolvesOnlyToAPublicHttpsURL() {
        XCTAssertEqual(faviconResolvedURL("/i.png", host: "a.com")?.absoluteString, "https://a.com/i.png")
        XCTAssertEqual(faviconResolvedURL("//cdn.a.com/i.png", host: "a.com")?.absoluteString, "https://cdn.a.com/i.png")
        XCTAssertEqual(faviconResolvedURL("img/i.png", host: "a.com")?.absoluteString, "https://a.com/img/i.png")
        XCTAssertNil(faviconResolvedURL("http://a.com/i.png", host: "a.com"), "https only")
        XCTAssertNil(faviconResolvedURL("https://10.0.0.5/i.png", host: "a.com"), "never a private address")
    }

    func testAnyImageIsNormalisedToASmallPNGAndJunkIsRefused() throws {
        let normalised = try XCTUnwrap(faviconNormalizedPNG(png(side: 180)))
        let rep = try XCTUnwrap(NSBitmapImageRep(data: normalised))
        XCTAssertEqual(rep.pixelsWide, FaviconCache.iconPixelSize)
        XCTAssertNil(faviconNormalizedPNG(Data("<html>not an image</html>".utf8)))
        XCTAssertNil(faviconNormalizedPNG(Data()))
    }
}
