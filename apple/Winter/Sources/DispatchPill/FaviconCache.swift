import AppKit
import ImageIO
import UniformTypeIdentifiers

/// The favicons the plume throws (`PlumeThrow.Kind.site`), fetched straight from each site — never
/// through a third-party favicon service, which would be told every site Dispatch reads — and kept
/// ON DISK, so a site met once is drawn instantly on every later turn and every later launch.
///
/// Lookup order for a host: memory → disk → network. On disk an icon is a small normalised PNG
/// (`<host>.png`, `iconPixelSize` square); one older than `freshFor` is still drawn at once and
/// refreshed quietly behind it. A site with no usable icon leaves a `<host>.miss` marker, and is not
/// asked again for `missRetryAfter` — its tiles show a globe meanwhile.
///
/// From the network: `https://<host>/favicon.ico` first; failing that, the site's home page is read
/// (capped) for its `<link rel="icon">` / `apple-touch-icon` (`faviconLinkHref`), and that is
/// fetched. Requests go out on an EPHEMERAL session — no cookies, nothing of the user's sent along —
/// and only to public names (`plumeFaviconHostAllowed`), never an IP literal or a local name.
@MainActor
final class FaviconCache {
    static let shared = FaviconCache(directory: FaviconCache.defaultDirectory())

    static let memoryCapacity = 256
    static let maxIconBytes = 256 * 1024
    static let maxPageBytes = 512 * 1024
    static let iconPixelSize = 64
    static let freshFor: TimeInterval = 30 * 24 * 3600
    static let missRetryAfter: TimeInterval = 3 * 24 * 3600
    /// The disk folder is pruned (oldest first) back to this many entries, once per launch.
    static let maxDiskEntries = 3000
    static let pruneOlderThan: TimeInterval = 120 * 24 * 3600

    /// Fetches `url`, returning its body only for a 200 no larger than `maxBytes`. Injectable so the
    /// tests never touch the network.
    typealias Fetch = @Sendable (_ url: URL, _ maxBytes: Int) async -> Data?

    private let directory: URL?
    private let fetch: Fetch
    private let now: @Sendable () -> Date
    private var images: [String: NSImage] = [:]
    private var pending: Set<String> = []
    private var missedThisRun: Set<String> = []
    private var pruned = false

    /// `directory` nil keeps everything in memory only.
    init(directory: URL?, fetch: @escaping Fetch = FaviconCache.networkFetch,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.directory = directory
        self.fetch = fetch
        self.now = now
    }

    /// `~/Library/Caches/<bundle id>/Favicons` — the dev and dist apps each keep their own.
    nonisolated static func defaultDirectory() -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        return caches.appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.winter.app", isDirectory: true)
            .appendingPathComponent("Favicons", isDirectory: true)
    }

    /// The host's favicon if it is in memory; otherwise nil, starting the disk-then-network lookup
    /// the first time asked. Called every frame by the plume, so it must stay cheap: it never blocks.
    func image(for host: String) -> NSImage? {
        if let image = images[host] { return image }
        guard plumeFaviconHostAllowed(host), !pending.contains(host), !missedThisRun.contains(host),
              images.count + pending.count < Self.memoryCapacity else { return nil }
        pending.insert(host)
        Task { await self.resolve(host) }
        return nil
    }

    var pendingCountForTesting: Int { pending.count }

    private func resolve(_ host: String) async {
        defer { pending.remove(host) }
        pruneOnce()
        let directory = self.directory
        let now = self.now()
        let stored = await Task.detached { FaviconCache.readDisk(host: host, in: directory, now: now) }.value
        switch stored {
        case .icon(let data, let age):
            if let image = NSImage(data: data) {
                images[host] = image
                if age > Self.freshFor { await refresh(host) }
                return
            }
        case .miss(let age) where age < Self.missRetryAfter:
            missedThisRun.insert(host)
            return
        case .miss, .nothing:
            break
        }
        await refresh(host)
    }

    /// Fetch afresh and keep the result (an icon, or a miss marker). A failed REFRESH of an icon
    /// already held keeps the old one.
    private func refresh(_ host: String) async {
        let fetch = self.fetch
        let png = await Task.detached { await FaviconCache.download(host: host, fetch: fetch) }.value
        let directory = self.directory
        if let png, let image = NSImage(data: png) {
            images[host] = image
            await Task.detached { FaviconCache.writeDisk(host: host, png: png, in: directory) }.value
        } else if images[host] == nil {
            missedThisRun.insert(host)
            await Task.detached { FaviconCache.writeDisk(host: host, png: nil, in: directory) }.value
        }
    }

    private func pruneOnce() {
        guard !pruned, let directory else { return }
        pruned = true
        let now = self.now()
        Task.detached(priority: .utility) {
            FaviconCache.prune(directory, now: now, keep: FaviconCache.maxDiskEntries,
                               olderThan: FaviconCache.pruneOlderThan)
        }
    }

    // MARK: - Disk (nonisolated — run off the main actor)

    enum Stored: Equatable {
        case icon(Data, age: TimeInterval)
        case miss(age: TimeInterval)
        case nothing
    }

    nonisolated static func readDisk(host: String, in directory: URL?, now: Date) -> Stored {
        guard let directory else { return .nothing }
        let fm = FileManager.default
        let icon = directory.appendingPathComponent(host + ".png")
        if let data = try? Data(contentsOf: icon), !data.isEmpty {
            return .icon(data, age: age(of: icon, now: now))
        }
        let miss = directory.appendingPathComponent(host + ".miss")
        if fm.fileExists(atPath: miss.path) { return .miss(age: age(of: miss, now: now)) }
        return .nothing
    }

    /// An icon (`png`) or, for nil, a miss marker. Writing one removes the other.
    nonisolated static func writeDisk(host: String, png: Data?, in directory: URL?) {
        guard let directory else { return }
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let icon = directory.appendingPathComponent(host + ".png")
        let miss = directory.appendingPathComponent(host + ".miss")
        if let png {
            try? png.write(to: icon, options: .atomic)
            try? fm.removeItem(at: miss)
        } else {
            try? Data().write(to: miss, options: .atomic)
        }
    }

    nonisolated static func prune(_ directory: URL, now: Date, keep: Int, olderThan: TimeInterval) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        var dated = files.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (url, date) in dated where now.timeIntervalSince(date) > olderThan { try? fm.removeItem(at: url) }
        dated.removeAll { now.timeIntervalSince($0.1) > olderThan }
        guard dated.count > keep else { return }
        for (url, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(dated.count - keep) { try? fm.removeItem(at: url) }
    }

    private nonisolated static func age(of url: URL, now: Date) -> TimeInterval {
        let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return now.timeIntervalSince(date)
    }

    // MARK: - Network

    private nonisolated static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 6
        config.timeoutIntervalForResource = 10
        return URLSession(configuration: config)
    }()

    nonisolated static let networkFetch: Fetch = { url, maxBytes in
        var request = URLRequest(url: url)
        request.setValue("Winter", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              !data.isEmpty, data.count <= maxBytes else { return nil }
        return data
    }

    /// `/favicon.ico`, else the home page's declared icon — normalised to a small PNG, or nil.
    nonisolated static func download(host: String, fetch: Fetch) async -> Data? {
        if let root = URL(string: "https://\(host)/favicon.ico"),
           let data = await fetch(root, maxIconBytes), let png = faviconNormalizedPNG(data) {
            return png
        }
        guard let home = URL(string: "https://\(host)/"),
              let page = await fetch(home, maxPageBytes),
              let html = String(data: page, encoding: .utf8) ?? String(data: page, encoding: .isoLatin1),
              let href = faviconLinkHref(inHTML: html),
              let icon = faviconResolvedURL(href, host: host),
              let data = await fetch(icon, maxIconBytes) else { return nil }
        return faviconNormalizedPNG(data)
    }
}

// MARK: - Pure helpers (`FaviconCacheTests`)

/// PURE: the best icon a page declares — `apple-touch-icon` (large, opaque PNG) over `icon` /
/// `shortcut icon`; never a `mask-icon` (a monochrome stencil) or an SVG (ImageIO cannot draw one).
func faviconLinkHref(inHTML html: String) -> String? {
    guard let tagRegex = try? NSRegularExpression(pattern: #"<link\b[^>]*>"#, options: [.caseInsensitive]),
          let attrRegex = try? NSRegularExpression(
              pattern: #"([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#) else { return nil }
    var best: (rank: Int, href: String)?
    let whole = NSRange(html.startIndex..., in: html)
    for tag in tagRegex.matches(in: html, range: whole) {
        guard let tagRange = Range(tag.range, in: html) else { continue }
        let text = String(html[tagRange])
        var attrs: [String: String] = [:]
        for m in attrRegex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let k = Range(m.range(at: 1), in: text) else { continue }
            let value = (2...4).lazy.compactMap { Range(m.range(at: $0), in: text) }.first.map { String(text[$0]) } ?? ""
            attrs[text[k].lowercased()] = value
        }
        let rel = (attrs["rel"] ?? "").lowercased()
        guard let href = attrs["href"]?.trimmingCharacters(in: .whitespaces), !href.isEmpty,
              !rel.contains("mask"), !href.lowercased().hasSuffix(".svg"), !href.lowercased().hasPrefix("data:") else { continue }
        let rank: Int
        if rel.contains("apple-touch-icon") { rank = 3 } else if rel.split(separator: " ").contains("icon") { rank = 2 } else { continue }
        if best == nil || rank > best!.rank { best = (rank, href) }
    }
    return best?.href
}

/// PURE: an icon href resolved against the site's home page — https only (a protocol-relative `//`
/// href is taken as https), and only to a public name; a plain-http or private icon is not fetched.
func faviconResolvedURL(_ href: String, host: String) -> URL? {
    guard let base = URL(string: "https://\(host)/"),
          let url = URL(string: href, relativeTo: base)?.absoluteURL,
          url.scheme?.lowercased() == "https",
          let iconHost = url.host?.lowercased(), plumeFaviconHostAllowed(iconHost) else { return nil }
    return url
}

/// PURE: any image ImageIO reads (ICO, PNG, JPEG, GIF, …) as a square PNG of at most `pixelSize` —
/// an ICO's largest frame, scaled down. Nil for anything that is not an image.
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
