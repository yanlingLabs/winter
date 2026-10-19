import AppKit
import Darwin
import Foundation
import ImageIO

// The island's Servers tab, links and logos (`docs/claude/island.md`): which of a server's TCP ports speak HTTP (a
// link that opens it in the browser), and the server's icon.
//
//   - LOOPBACK ONLY, by construction: the one connect here (`IslandHTTP.fetch`) takes an `IslandLoopback` — 127.0.0.1
//     or ::1 —, never a host name, so nothing leaves the machine; a redirect or an icon link is followed only when
//     `IslandHTTP.loopbackTarget` maps it to loopback AND to one of the server's own ports (anything else is never
//     fetched). Plain HTTP/1.0, no proxy, no cookie, 400 ms per request, the status line and headers plus at most 64 KB
//     of a page (1 MB of an icon).
//   - Off the main thread, at most `IslandServerProbes.limit` (8) at a time, on a dispatch queue (blocking sockets never
//     sit on Swift's cooperative pool), and only from the tab's own refresh while it shows. A DEFINITE answer (HTTP,
//     refused, closed, not HTTP) is kept for the server's lifetime; a port that took the connection but said nothing in
//     time (a dev server compiling its first page) is asked again later, backing off (`IslandServers.retryAfter`).
//   - THE ICON LADDER: (a) the page's `<link rel="icon" | "shortcut icon" | "apple-touch-icon">`, then `/favicon.ico`
//     — loopback, the server's own ports; (b) image files in the project (its folder, its npm package's folder):
//     `favicon`, `logo`, `icon` (.png .jpg .jpeg .ico .icns) there or in `public/`, `static/`, `assets/`, `resources/`
//     — no deeper, no link followed (`O_NOFOLLOW` on the folder and the file), ≤ 1 MB read from the opened file;
//     (c) the row's symbol. Every candidate is decoded OFF the main thread into a small thumbnail by ImageIO (at most
//     `thumbnailPixels`, none over `maxDimension` a side); svg is not read.

/// Where a listening port answers on loopback: 127.0.0.1 (a listener on 127.0.0.1 or 0.0.0.0), else ::1 (on ::1 or
/// ::). A port bound only to another address has none.
enum IslandLoopback: Equatable, Hashable {
    case v4, v6

    /// A link's host: `localhost`, or `[::1]` for a port only on v6 (a browser may try 127.0.0.1 first).
    var linkHost: String { self == .v4 ? "localhost" : "[::1]" }

    /// PURE: a v4 listener's address (host order) — 127.x.x.x or 0.0.0.0 answer on 127.0.0.1.
    static func of(v4 address: UInt32) -> IslandLoopback? {
        address == 0 || address >> 24 == 127 ? .v4 : nil
    }

    /// PURE: a v6 listener's 16 bytes — ::1 or :: answer on ::1; a v4-mapped loopback (::ffff:127.x) on 127.0.0.1.
    static func of(v6 bytes: [UInt8]) -> IslandLoopback? {
        guard bytes.count == 16 else { return nil }
        if bytes.allSatisfy({ $0 == 0 }) { return .v6 }
        if bytes.prefix(15).allSatisfy({ $0 == 0 }), bytes[15] == 1 { return .v6 }
        if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 0xff, bytes[11] == 0xff, bytes[12] == 127 { return .v4 }
        return nil
    }
}

/// A loopback address to GET: the family, the port, the path (with its query).
struct IslandLoopbackTarget: Equatable, Hashable {
    let host: IslandLoopback
    let port: UInt16
    let path: String

    var url: URL? { URL(string: "http://\(host.linkHost):\(port)\(path)") }
}

/// A parsed HTTP response: its status, headers (lowercased names) and the start of its body.
struct IslandHTTPResponse: Equatable {
    let status: Int
    let headers: [String: String]
    let body: Data

    var isHTML: Bool { headers["content-type"]?.lowercased().contains("text/html") == true }
    var isRedirect: Bool { (300..<400).contains(status) }
}

/// What a port said to `GET /`: whether it speaks HTTP, serves a page, and the page's icons (loopback, its own ports).
/// `late`: it took the connection but answered nothing in time — not an answer: asked again later, never kept.
struct IslandHTTPProbe: Equatable {
    var isHTTP = false
    var isHTML = false
    var iconLinks: [IslandLoopbackTarget] = []
    var late = false
}

/// One request's outcome: an HTTP answer; a DEFINITE no (refused, closed, not HTTP); or late (connected, nothing — or
/// not yet a status line — within the deadline).
enum IslandHTTPFetch: Equatable {
    case response(IslandHTTPResponse)
    case notHTTP
    case late

    var response: IslandHTTPResponse? {
        if case .response(let response) = self { return response }
        return nil
    }
}

/// A server's link: one of its HTTP ports, opened at `http://localhost:<port>/`.
struct IslandServerLink: Equatable, Identifiable {
    let port: UInt16
    let host: IslandLoopback
    let isHTML: Bool

    var id: UInt16 { port }
    var url: URL { URL(string: "http://\(host.linkHost):\(port)/")! }
    /// "localhost:3888".
    var label: String { "\(host.linkHost):\(port)" }
}

enum IslandHTTP {
    static let timeout: TimeInterval = 0.4
    static let pageLimit = 64 * 1024
    static let iconLimit = 1024 * 1024
    /// Redirects followed — loopback only.
    static let maxRedirects = 2

    // MARK: Pure

    /// The response in `data` (the status line `HTTP/1.x NNN`, the headers, the body up to `maxBody`); nil when it is
    /// not HTTP.
    static func parse(_ data: Data, maxBody: Int = pageLimit) -> IslandHTTPResponse? {
        let bytes = [UInt8](data)
        var end: Int?
        var bodyStart = 0
        for i in bytes.indices {
            if i + 3 < bytes.count, bytes[i] == 13, bytes[i + 1] == 10, bytes[i + 2] == 13, bytes[i + 3] == 10 {
                end = i
                bodyStart = i + 4
                break
            }
            if i + 1 < bytes.count, bytes[i] == 10, bytes[i + 1] == 10 {
                end = i
                bodyStart = i + 2
                break
            }
        }
        // No blank line yet (a server that sent only its headers before the deadline): the headers alone.
        let headEnd = end ?? bytes.count
        let head = String(decoding: bytes[..<headEnd], as: UTF8.self)
        var lines = head.split(omittingEmptySubsequences: true, whereSeparator: { $0 == "\n" || $0 == "\r\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !lines.isEmpty else { return nil }
        let statusLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard statusLine.count >= 2, statusLine[0].hasPrefix("HTTP/1.") || statusLine[0] == "HTTP/2",
              statusLine[1].count == 3, let status = Int(statusLine[1]) else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if headers[name] == nil { headers[name] = value }
        }
        let body = end == nil ? Data() : Data(bytes[bodyStart...].prefix(maxBody))
        return IslandHTTPResponse(status: status, headers: headers, body: body)
    }

    /// A page's icon links, in order — `icon` and `shortcut icon` before `apple-touch-icon`.
    static func iconLinks(_ html: String) -> [String] {
        guard let tag = try? NSRegularExpression(pattern: "<link\\b[^>]*>", options: [.caseInsensitive]),
              let attribute = try? NSRegularExpression(
                pattern: "([A-Za-z][A-Za-z0-9_-]*)\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))") else { return [] }
        var icons: [String] = []
        var touch: [String] = []
        let ns = html as NSString
        for match in tag.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let text = ns.substring(with: match.range) as NSString
            var rel = ""
            var href: String?
            for a in attribute.matches(in: text as String, range: NSRange(location: 0, length: text.length)) {
                let name = text.substring(with: a.range(at: 1)).lowercased()
                let value = [3, 4, 5].lazy.map { a.range(at: $0) }.first { $0.location != NSNotFound }
                    .map { text.substring(with: $0) } ?? ""
                if name == "rel" { rel = value.lowercased() } else if name == "href" { href = value }
            }
            guard let href, !href.isEmpty else { continue }
            let words = Set(rel.split(separator: " ").map(String.init))
            if words.contains("apple-touch-icon") || words.contains("apple-touch-icon-precomposed") {
                touch.append(href)
            } else if words.contains("icon") {
                icons.append(href)
            }
        }
        return icons + touch
    }

    /// `href` resolved against `base`, when it is plain HTTP on loopback (`localhost`, 127.0.0.1, ::1) — the ONLY way
    /// a redirect or an icon link is followed; anything else (another host, https, data:) is nil and never fetched.
    static func loopbackTarget(_ href: String, base: IslandLoopbackTarget) -> IslandLoopbackTarget? {
        guard let baseURL = base.url, let url = URL(string: href, relativeTo: baseURL)?.absoluteURL,
              url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return nil }
        let family: IslandLoopback
        switch host {
        case "localhost": family = base.host
        case "127.0.0.1": family = .v4
        case "::1", "[::1]": family = .v6
        default: return nil
        }
        guard let port = UInt16(exactly: url.port ?? 80) else { return nil }
        var path = url.path(percentEncoded: true)
        if path.isEmpty { path = "/" }
        if let query = url.query(percentEncoded: true) { path += "?\(query)" }
        return IslandLoopbackTarget(host: family, port: port, path: path)
    }

    // MARK: Loopback I/O (blocking: call off the main thread)

    /// GET `target` — HTTP/1.0, `Connection: close` — and read the status line, the headers and at most `maxBody` of the
    /// body within `timeout` (connect, send and read together). Nil: no answer (late included), or not HTTP.
    static func get(_ target: IslandLoopbackTarget, maxBody: Int, timeout: TimeInterval = timeout) -> IslandHTTPResponse? {
        fetch(target, maxBody: maxBody, timeout: timeout).response
    }

    /// `get`, telling a definite no (refused, closed, not HTTP) from a late one (the connection taken, no status line in
    /// time).
    static func fetch(_ target: IslandLoopbackTarget, maxBody: Int, timeout: TimeInterval = timeout) -> IslandHTTPFetch {
        let deadline = Date().addingTimeInterval(timeout)
        let fd = socket(target.host == .v4 ? AF_INET : AF_INET6, SOCK_STREAM, 0)
        guard fd >= 0 else { return .notHTTP }
        defer { close(fd) }
        var on: Int32 = 1
        // A server that closes early must never SIGPIPE the app.
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let started: Int32
        switch target.host {
        case .v4:
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = target.port.bigEndian
            address.sin_addr.s_addr = UInt32(0x7f00_0001).bigEndian
            started = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
        case .v6:
            var address = sockaddr_in6()
            address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            address.sin6_family = sa_family_t(AF_INET6)
            address.sin6_port = target.port.bigEndian
            address.sin6_addr = in6addr_loopback
            started = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) }
            }
        }
        if started != 0 {
            guard errno == EINPROGRESS else { return .notHTTP }
            // Not connected in time (a full backlog): late; refused: a definite no.
            guard wait(fd, Int16(POLLOUT), until: deadline) else { return .late }
            var error: Int32 = 0
            var length = socklen_t(MemoryLayout<Int32>.size)
            guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0, error == 0 else { return .notHTTP }
        }
        let request = "GET \(target.path) HTTP/1.0\r\nHost: \(target.host.linkHost):\(target.port)\r\nUser-Agent: Winter\r\n"
            + "Accept: text/html,*/*;q=0.8\r\nConnection: close\r\n\r\n"
        var pending = Array(request.utf8)[...]
        while !pending.isEmpty {
            guard wait(fd, Int16(POLLOUT), until: deadline) else { return .late }
            let sent = pending.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }
            if sent < 0 {
                if errno == EAGAIN || errno == EINTR { continue }
                return .notHTTP
            }
            pending = pending.dropFirst(sent)
        }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        // Enough read: the headers and `maxBody` of the body (or a header block far too long to be one).
        func enough() -> Bool {
            guard let range = data.range(of: Data("\r\n\r\n".utf8)) ?? data.range(of: Data("\n\n".utf8)) else {
                return data.count > 64 * 1024
            }
            return data.count - range.upperBound >= maxBody
        }
        var ended = false
        while !enough() {
            guard wait(fd, Int16(POLLIN), until: deadline) else { break }
            let read = recv(fd, &buffer, buffer.count, 0)
            if read > 0 {
                data.append(buffer, count: read)
            } else if read == 0 || (errno != EAGAIN && errno != EINTR) {
                ended = true
                break
            }
        }
        if let response = parse(data, maxBody: maxBody) { return .response(response) }
        // Closed, or a whole line that is not a status line: not HTTP. Nothing yet (or half a first line) at the
        // deadline: late.
        return ended || data.contains(10) ? .notHTTP : .late
    }

    /// `GET /` on a port: HTTP or not, a page or not, the page's icons — following a redirect (twice at most) and
    /// keeping an icon link only on loopback and on one of `ports` (the server's own; nil: this port only); anything
    /// else is not fetched (the port still speaks HTTP: it gets its link, no page, no icon).
    static func probe(_ host: IslandLoopback, port: UInt16, ports: Set<UInt16>? = nil) -> IslandHTTPProbe {
        let own = ports ?? [port]
        func allowed(_ href: String, base: IslandLoopbackTarget) -> IslandLoopbackTarget? {
            loopbackTarget(href, base: base).flatMap { own.contains($0.port) ? $0 : nil }
        }
        var target = IslandLoopbackTarget(host: host, port: port, path: "/")
        var response: IslandHTTPResponse
        switch fetch(target, maxBody: pageLimit) {
        case .response(let first): response = first
        case .notHTTP: return IslandHTTPProbe()
        case .late: return IslandHTTPProbe(late: true)
        }
        var result = IslandHTTPProbe(isHTTP: true)
        var hops = 0
        while response.isRedirect, hops < maxRedirects {
            guard let location = response.headers["location"], let next = allowed(location, base: target),
                  let followed = get(next, maxBody: pageLimit) else { return result }
            target = next
            response = followed
            hops += 1
        }
        guard !response.isRedirect, response.isHTML else { return result }
        result.isHTML = true
        let html = String(data: response.body, encoding: .utf8) ?? String(decoding: response.body, as: UTF8.self)
        result.iconLinks = iconLinks(html).compactMap { allowed($0, base: target) }
        return result
    }

    private static func wait(_ fd: Int32, _ events: Int16, until deadline: Date) -> Bool {
        while true {
            let remaining = Int32(max(0, deadline.timeIntervalSinceNow * 1000).rounded(.up))
            guard remaining > 0 else { return false }
            var entry = pollfd(fd: fd, events: events, revents: 0)
            let ready = poll(&entry, 1, remaining)
            if ready < 0, errno == EINTR { continue }
            return ready > 0 && entry.revents & (events | Int16(POLLHUP) | Int16(POLLERR)) != 0
        }
    }
}

// MARK: - The icon ladder

enum IslandServerIcons {
    static let maxFileSize = 1024 * 1024
    /// The thumbnail's longest side, in pixels (the row's 30 pt icon at 2× and some).
    static let thumbnailPixels = 96
    /// An image any side of which is longer than this is not decoded at all.
    static let maxDimension = 4096
    /// The project's own image files, in order (`favicon`, then `logo`, then `icon`). No svg: ImageIO does not read it.
    static let projectNames: [String] = ["favicon", "logo", "icon"].flatMap { base in
        ["png", "ico", "icns", "jpg", "jpeg"].map { "\(base).\($0)" }
    }
    /// Where they are looked for in a folder: itself, then these — no deeper.
    static let projectFolders = ["", "public", "static", "assets", "resources"]

    /// The only formats an icon is decoded from (UTIs): an icon link or a project file that is anything else — a PDF,
    /// a RAW, a movie ImageIO happens to read — is no icon.
    static let iconTypes: Set<String> = ["public.png", "com.microsoft.ico", "com.apple.icns", "public.jpeg",
                                         "com.compuserve.gif", "org.webmproject.webp"]

    /// A small thumbnail of untrusted image bytes — ImageIO, off the main thread (this runs on `IslandServerProbes`'
    /// queue); nil when it is not one of `iconTypes`, or any side is over `maxDimension`.
    static func thumbnail(_ data: Data) -> CGImage? {
        guard !data.isEmpty, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?, iconTypes.contains(type),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= maxDimension, height <= maxDimension else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                        kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceShouldCacheImmediately: true,
                                        kCGImageSourceThumbnailMaxPixelSize: thumbnailPixels]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// (a) the page's icon links, then `/favicon.ico` — on loopback, `pages` the server's HTTP ports (a page first).
    static func fromHTTP(_ pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)]) -> CGImage? {
        var targets: [IslandLoopbackTarget] = []
        for page in pages {
            targets += page.probe.iconLinks.prefix(4)
            targets.append(IslandLoopbackTarget(host: page.host, port: page.port, path: "/favicon.ico"))
        }
        var seen: Set<IslandLoopbackTarget> = []
        for target in targets where seen.insert(target).inserted {
            guard let response = IslandHTTP.get(target, maxBody: IslandHTTP.iconLimit), response.status == 200,
                  response.body.count < IslandHTTP.iconLimit, let image = thumbnail(response.body) else { continue }
            return image
        }
        return nil
    }

    /// (b) an image file of the project's own: `projectNames` in each folder and its `projectFolders`. Opened without
    /// following a link — the subfolder (`O_NOFOLLOW | O_DIRECTORY`) and the file (`O_NOFOLLOW`, non-blocking: a fifo
    /// never hangs) —, checked on the OPEN file (`fstat`: a regular file of at most `maxFileSize`) and read from it, at
    /// most `maxFileSize + 1` bytes (one more: too big), so nothing is swapped in between.
    static func fromProject(_ folders: [String]) -> CGImage? {
        var seen: Set<String> = []
        for folder in folders where folder != "/" && !folder.isEmpty && seen.insert(folder).inserted {
            let top = open(folder, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard top >= 0 else { continue }
            defer { close(top) }
            for sub in projectFolders {
                let dir = sub.isEmpty ? dup(top) : openat(top, sub, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard dir >= 0 else { continue }
                defer { close(dir) }
                for name in projectNames {
                    if let data = readSmallFile(dir, name), let image = thumbnail(data) { return image }
                }
            }
        }
        return nil
    }

    /// `name` in the open folder `dir`: a regular file, never through a link, at most `maxFileSize` bytes.
    private static func readSmallFile(_ dir: Int32, _ name: String) -> Data? {
        let fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, Int(info.st_size) <= maxFileSize else { return nil }
        var data = Data(count: maxFileSize + 1)
        var total = 0
        let capacity = data.count
        while total < capacity {
            let read = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + total, capacity - total) }
            if read > 0 {
                total += read
            } else if read < 0, errno == EINTR {
                continue
            } else {
                break
            }
        }
        guard total > 0, total <= maxFileSize else { return nil }
        return data.prefix(total)
    }
}

/// What the Servers tab asks of the network and the disk — live: `IslandLiveServerProber`; a counting fake in the
/// tests. Both calls block: they run on `IslandServerProbes`' queue.
protocol IslandServerProber {
    /// `GET /` on `port`, following only to `ports` (the server's own).
    func probe(_ host: IslandLoopback, port: UInt16, ports: Set<UInt16>) -> IslandHTTPProbe
    /// The server's icon, as a small thumbnail decoded here (off the main thread).
    func icon(pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)], folders: [String]) -> CGImage?
}

struct IslandLiveServerProber: IslandServerProber {
    func probe(_ host: IslandLoopback, port: UInt16, ports: Set<UInt16>) -> IslandHTTPProbe {
        IslandHTTP.probe(host, port: port, ports: ports)
    }

    func icon(pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)], folders: [String]) -> CGImage? {
        IslandServerIcons.fromHTTP(pages) ?? IslandServerIcons.fromProject(folders)
    }
}

/// Blocking jobs off the main thread and off Swift's cooperative pool: a dispatch queue, at most `limit` at a time.
enum IslandServerProbes {
    static let limit = 8
    private static let queue = DispatchQueue(label: "winter.island.servers.probes", qos: .utility, attributes: .concurrent)

    /// Runs `jobs` (at most `limit` at once) and returns their results in order.
    static func run<T>(_ jobs: [() -> T], limit: Int = limit) async -> [T] {
        guard !jobs.isEmpty else { return [] }
        return await withCheckedContinuation { continuation in
            queue.async {
                let slots = DispatchSemaphore(value: max(1, limit))
                let group = DispatchGroup()
                let lock = NSLock()
                var results = [T?](repeating: nil, count: jobs.count)
                for (i, job) in jobs.enumerated() {
                    slots.wait()
                    group.enter()
                    queue.async {
                        let value = job()
                        lock.lock()
                        results[i] = value
                        lock.unlock()
                        slots.signal()
                        group.leave()
                    }
                }
                group.wait()
                continuation.resume(returning: results.map { $0! })
            }
        }
    }
}

extension IslandServers {
    /// A server's links: its HTTP ports (probed), the one serving a page first, then by port.
    static func links(_ row: IslandServerRow, http: [String: IslandHTTPProbe]) -> [IslandServerLink] {
        row.tcpPorts.compactMap { port -> IslandServerLink? in
            guard let host = row.loopback[port], let probe = http[probeKey(row, port)], probe.isHTTP else { return nil }
            return IslandServerLink(port: port, host: host, isHTML: probe.isHTML)
        }
        .sorted { $0.isHTML != $1.isHTML ? $0.isHTML : $0.port < $1.port }
    }

    /// The probe cache's key: the server (its top process's pid and start time) and the port — once per server lifetime.
    static func probeKey(_ row: IslandServerRow, _ port: UInt16) -> String { "\(row.id)#\(port)" }

    /// After the `attempt`-th late answer (1-based), when to ask again: 5 s, 15 s, 60 s, then every 5 min.
    static func retryAfter(attempt: Int) -> TimeInterval {
        let steps: [TimeInterval] = [5, 15, 60, 300]
        return steps[min(max(attempt, 1), steps.count) - 1]
    }
}
