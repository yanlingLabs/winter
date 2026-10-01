import AppKit
import ImageIO
import UniformTypeIdentifiers

/// The favicons the plume throws (`PlumeThrow.Kind.site`), fetched from the EXACT icon url the web
/// tool reported for the site (`tool_result.siteIcons`: Exa's `favicon` for a search source, the
/// fetched page's own declared icon for a fetch) — never guessed from a home page, and never through
/// a third-party favicon service of Winter's choosing.
///
/// **This is not a persistent cache.** Nothing is written to disk and nothing outlives the app's run:
/// the icon url arrives fresh with every result, so a stored copy could only ever be staler than what
/// the tool just said. What is kept is a small in-memory DEDUPE, keyed by the icon url, so a tile
/// redrawn every frame (and the same site met again this run) does not refetch — the decoded images
/// (at most `memoryCapacity`, least recently drawn dropped first), the urls still in flight, and the
/// ones that failed (a globe, not retried for `failureRetryAfter`).
///
/// With no icon url known (an older daemon or runtime, a source Exa had no favicon for) the site gets
/// ONE attempt at `https://<host>/favicon.ico`, deduped the same way, then a globe.
///
/// Requests go out on an EPHEMERAL session — no cookies, nothing of the user's sent along — only over
/// https, and only to public names (`plumeFaviconHostAllowed`) for the page AND the icon, re-checked
/// on every redirect hop (`faviconRedirectAllowed`): never an IP literal or a local name.
@MainActor
final class FaviconCache {
    static let shared = FaviconCache()

    /// The most decoded icons one run holds; past it the least recently drawn is dropped (and simply
    /// fetched again if its site comes back). Failures and in-flight fetches are capped the same.
    static let memoryCapacity = 256
    /// A failed icon url stays a globe this long, then may be tried again (an offline moment must not
    /// grey a site out for the rest of a long-running menu-bar app's life).
    static let failureRetryAfter: TimeInterval = 5 * 60
    static let maxIconBytes = 256 * 1024
    static let iconPixelSize = 64

    /// Fetches `url`, returning its body only for a 200 no larger than `maxBytes`. Injectable so the
    /// tests never touch the network.
    typealias Fetch = @Sendable (_ url: URL, _ maxBytes: Int) async -> Data?

    private let fetch: Fetch
    private let now: () -> Date
    private var images: [URL: NSImage] = [:]
    /// `images`' keys, least recently drawn first.
    private var recency: [URL] = []
    private var pending: Set<URL> = []
    private var failed: [URL: Date] = [:]

    init(fetch: @escaping Fetch = FaviconCache.networkFetch, now: @escaping () -> Date = { Date() }) {
        self.fetch = fetch
        self.now = now
    }

    /// The site's icon if it is in memory; otherwise nil, starting the one fetch of it the first time
    /// asked. Called every frame by the plume, so it must stay cheap: it never blocks.
    func image(host: String, iconURL: String?) -> NSImage? {
        guard let url = faviconRequestURL(host: host, iconURL: iconURL) else { return nil }
        if let image = images[url] {
            if recency.last != url, let i = recency.firstIndex(of: url) { recency.append(recency.remove(at: i)) }
            return image
        }
        if let failedAt = failed[url] {
            guard now().timeIntervalSince(failedAt) >= Self.failureRetryAfter else { return nil }
            failed[url] = nil
        }
        guard !pending.contains(url), pending.count < Self.memoryCapacity else { return nil }
        pending.insert(url)
        Task { await self.load(url) }
        return nil
    }

    var pendingCountForTesting: Int { pending.count }
    var imageCountForTesting: Int { images.count }
    var failedCountForTesting: Int { failed.count }

    private func load(_ url: URL) async {
        defer { pending.remove(url) }
        let fetch = self.fetch
        let png = await Task.detached { () -> Data? in
            let data = await fetch(url, FaviconCache.maxIconBytes)
            return data.flatMap { faviconNormalizedPNG($0) }
        }.value
        if let png, let image = NSImage(data: png) {
            images[url] = image
            recency.append(url)
            while recency.count > Self.memoryCapacity { images[recency.removeFirst()] = nil }
        } else {
            if failed.count >= Self.memoryCapacity, let oldest = failed.min(by: { $0.value < $1.value })?.key {
                failed[oldest] = nil
            }
            failed[url] = now()
        }
    }

    // MARK: - Network

    /// The ephemeral, cookie-less session every icon request uses. `protocolClasses` is the tests' seam
    /// (a stub `URLProtocol`), so the real request path — redirect guard included — runs without a network.
    nonisolated static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 6
        config.timeoutIntervalForResource = 10
        if let protocolClasses { config.protocolClasses = protocolClasses }
        return URLSession(configuration: config)
    }

    private nonisolated static let session = makeSession()

    /// Re-checks every redirect hop: an icon url on a public host must not be bounced to a private one.
    private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? {
            faviconRedirectAllowed(request.url) ? request : nil
        }
    }

    /// The one request path: `url` on `session`, every redirect hop through `RedirectGuard`; the body
    /// only for a final 200 no larger than `maxBytes`.
    nonisolated static func download(_ url: URL, maxBytes: Int, session: URLSession) async -> Data? {
        var request = URLRequest(url: url)
        request.setValue("Winter", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await session.data(for: request, delegate: RedirectGuard()),
              (response as? HTTPURLResponse)?.statusCode == 200,
              !data.isEmpty, data.count <= maxBytes else { return nil }
        return data
    }

    nonisolated static let networkFetch: Fetch = { url, maxBytes in
        await download(url, maxBytes: maxBytes, session: session)
    }
}

// MARK: - Pure helpers (`FaviconCacheTests`)

/// PURE: what the pill fetches for a site — the tool's icon url when it is https to a public name
/// (`plumeIconURLAllowed`), else the page host's own `https://<host>/favicon.ico`; nil when the page
/// host itself is not a public name (nothing is fetched for it at all).
func faviconRequestURL(host: String, iconURL: String?) -> URL? {
    guard plumeFaviconHostAllowed(host) else { return nil }
    if let iconURL, plumeIconURLAllowed(iconURL), let url = URL(string: iconURL) { return url }
    return URL(string: "https://\(host)/favicon.ico")
}

/// PURE: a redirect the icon fetch may follow — https, to a public name only.
func faviconRedirectAllowed(_ url: URL?) -> Bool {
    guard let url else { return false }
    return plumeIconURLAllowed(url.absoluteString)
}

/// PURE: any image ImageIO reads (ICO, PNG, JPEG, GIF, …) as a square PNG of at most `pixelSize` —
/// an ICO's largest frame, scaled down. Nil for anything that is not an image (an SVG included:
/// ImageIO cannot draw one, and the tile shows a globe).
func faviconNormalizedPNG(_ data: Data, pixelSize: Int = FaviconCache.iconPixelSize) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let count = CGImageSourceGetCount(source)
    guard count > 0 else { return nil }
    var bestIndex = 0
    var bestWidth = 0
    for i in 0..<count {
        let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any]
        let width = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
        if width > bestWidth { bestWidth = width; bestIndex = i }
    }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: pixelSize,
        kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, bestIndex, options as CFDictionary),
          image.width > 0, image.height > 0 else { return nil }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
}
