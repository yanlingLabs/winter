import AppKit
import Darwin
import XCTest
@testable import Winter

/// The Servers tab's bundles (one project's servers as one row, its page with "Stop all"), links (which ports speak
/// HTTP, on loopback only) and logos (the page's icon, else the project's own image). The HTTP tests talk to tiny
/// servers this test starts on 127.0.0.1 — nothing else is ever reached, and no real process is signalled.
@MainActor
final class IslandServersLinksTests: XCTestCase {
    private let me: uid_t = 501
    private let epoch: UInt64 = 1_800_000_000
    private let node = "/opt/homebrew/bin/node"
    private let waifus = "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus/bin/waifus.mjs"

    /// A listener in a group of its own, each port on 127.0.0.1 unless `loopback` says otherwise.
    private func process(_ pid: Int32, _ args: [String]?, path: String? = nil, cwd: String? = "/Users/me/code",
                         tcp: [UInt16], loopback: [UInt16: IslandLoopback]? = nil, started: UInt64? = nil) -> ServerProcess {
        ServerProcess(identity: ServerProcessIdentity(pid: pid, uid: me, startSeconds: started ?? epoch, startMicros: 0),
                      ppid: 1, pgid: pid, path: path ?? node, cwd: cwd, tcpPorts: tcp,
                      loopback: loopback ?? Dictionary(uniqueKeysWithValues: tcp.map { ($0, IslandLoopback.v4) }),
                      arguments: args)
    }

    private func rows(_ list: [ServerProcess]) -> [IslandServerRow] {
        IslandServers.rows(list, user: me, ownPid: 9_999, home: "/Users/me")
    }

    // MARK: Bundles

    func testOneProjectsServersAreOneBundle() {
        let list = [
            // One npm package (one folder on disk): one bundle, named by the command they share.
            process(101, ["node", waifus, "remote", "--foreground"], cwd: "/Users/me/Discord Waifus", tcp: [3888], started: epoch + 9),
            process(102, ["node", waifus, "start", "--foreground"], cwd: "/Users/me/Discord Waifus", tcp: [61010], started: epoch + 8),
            // No package: the same folder and command — one bundle.
            process(103, ["node", "/Users/me/api/bin/api.js", "serve"], cwd: "/Users/me/api", tcp: [4000], started: epoch + 7),
            process(104, ["node", "/Users/me/api/bin/api.js", "worker"], cwd: "/Users/me/api", tcp: [4001], started: epoch + 6),
            // The same command in two projects: apart.
            process(105, ["node", "/Users/me/site-a/node_modules/.bin/vite"], cwd: "/Users/me/site-a", tcp: [5173], started: epoch + 5),
            process(106, ["node", "/Users/me/site-b/node_modules/.bin/vite"], cwd: "/Users/me/site-b", tcp: [5174], started: epoch + 4),
            // Two packages in one folder: apart.
            process(107, ["node", "/Users/me/mono/node_modules/@acme/a/bin/a.js"], cwd: "/Users/me/mono", tcp: [7001], started: epoch + 3),
            process(108, ["node", "/Users/me/mono/node_modules/@acme/b/bin/b.js"], cwd: "/Users/me/mono", tcp: [7002], started: epoch + 2),
            // The same package installed in two projects: apart (one project each).
            process(109, ["node", "/Users/me/x/node_modules/@acme/server/bin/serve.js"], cwd: "/Users/me/x", tcp: [8001], started: epoch + 1),
            process(110, ["node", "/Users/me/y/node_modules/@acme/server/bin/serve.js"], cwd: "/Users/me/y", tcp: [8002], started: epoch),
        ]
        let bundles = IslandServers.bundles(rows(list))
        XCTAssertEqual(bundles.map(\.name), ["waifus", "api", "vite", "vite", "a", "b", "serve", "serve"])
        XCTAssertEqual(bundles.map(\.rows.count), [2, 2, 1, 1, 1, 1, 1, 1])
        let waifusBundle = bundles[0]
        XCTAssertEqual(waifusBundle.key, "package:/opt/homebrew/lib/node_modules/@waifucave/discord-waifus")
        XCTAssertEqual(waifusBundle.rows.map(\.name), ["waifus remote", "waifus start"])
        XCTAssertEqual(waifusBundle.tcpPorts, [3888, 61010], "the bundle's ports are its servers' together")
        XCTAssertEqual(IslandServers.portsLine(waifusBundle.tcpPorts), ":3888 :61010")
        XCTAssertEqual(IslandServers.serversWord(2), "2 servers")
        XCTAssertEqual(IslandServers.packageRoot(list[0]), "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus")
        XCTAssertNil(IslandServers.packageRoot(list[4]), "a .bin link names no package folder")
    }

    // MARK: The page and Stop all

    private final class FakeSource: ServerProcessSource {
        var list: [ServerProcess] = []
        var alive: [Int32: ServerProcessIdentity] = [:]
        func processes() -> [ServerProcess] { list }
        func identity(of pid: Int32) -> ServerProcessIdentity? { alive[pid] }
        func path(of pid: Int32) -> String { "/opt/homebrew/bin/node" }
    }

    private final class FakeSignaller: ServerSignaller {
        var sent: [String] = []
        func send(_ signal: Int32, to pid: Int32) -> Bool {
            sent.append("\(signal == SIGTERM ? "TERM" : "KILL") \(pid)")
            return true
        }
    }

    /// Counts what it is asked; answers from `http` (by port) and `icon`.
    private final class FakeProber: IslandServerProber {
        var http: [UInt16: IslandHTTPProbe] = [:]
        var icon: Data?
        private let lock = NSLock()
        private var _probed: [UInt16] = []
        private var _iconLookups: [[String]] = []
        var probed: [UInt16] { lock.lock(); defer { lock.unlock() }; return _probed }
        var iconLookups: [[String]] { lock.lock(); defer { lock.unlock() }; return _iconLookups }

        func probe(_ host: IslandLoopback, port: UInt16) -> IslandHTTPProbe {
            lock.lock()
            _probed.append(port)
            lock.unlock()
            return http[port] ?? IslandHTTPProbe()
        }

        func icon(pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)], folders: [String]) -> Data? {
            lock.lock()
            _iconLookups.append(folders)
            lock.unlock()
            return icon
        }
    }

    private var clock = Date(timeIntervalSince1970: 1_800_000_000)

    private func model(_ list: [ServerProcess], prober: FakeProber = FakeProber()) -> (IslandServersModel, FakeSource, FakeSignaller) {
        let source = FakeSource()
        source.list = list
        for p in list { source.alive[p.pid] = p.identity }
        let signaller = FakeSignaller()
        let model = IslandServersModel()
        model.source = source
        model.signaller = signaller
        model.prober = prober
        model.user = me
        model.ownPid = 9_999
        model.parentPid = 1
        model.home = "/Users/me"
        model.now = { [unowned self] in self.clock }
        model.schedule = { _, _ in }
        model.openURL = { _ in }
        return (model, source, signaller)
    }

    private var project: [ServerProcess] {
        [process(101, ["node", waifus, "remote"], cwd: "/Users/me/Discord Waifus", tcp: [3888], started: epoch + 2),
         process(102, ["node", waifus, "start"], cwd: "/Users/me/Discord Waifus", tcp: [61010], started: epoch + 1),
         process(103, ["python3", "-m", "http.server"], path: "/usr/bin/python3", tcp: [8000], started: epoch)]
    }

    func testABundleDrillsIntoItsPageAndStopAllStopsOnlyItsServers() async {
        let (model, source, signaller) = model(project)
        await model.refresh()
        let bundle = try! XCTUnwrap(model.bundles.first)
        let single = try! XCTUnwrap(model.bundles.last)
        XCTAssertTrue(model.drills(bundle))
        XCTAssertFalse(model.drills(single), "one server with one link stays a plain row")

        // In and back; the 5 s beat keeps the page, opening the island (or the tab) shows the list.
        model.open(bundle)
        XCTAssertEqual(model.openBundle, bundle.key)
        await model.refresh()
        XCTAssertEqual(model.openBundle, bundle.key)
        await model.refresh(resetPage: true)
        XCTAssertNil(model.openBundle)
        model.open(bundle)
        model.back()
        XCTAssertNil(model.openBundle)

        // Stop all: two clicks, then every server of the bundle — never the other row.
        model.open(bundle)
        model.tapAll(bundle)
        XCTAssertTrue(signaller.sent.isEmpty)
        XCTAssertEqual(model.stops[bundle.stopId], .confirming(at: clock))
        clock.addTimeInterval(1)
        model.tapAll(bundle)
        XCTAssertEqual(signaller.sent, ["TERM 101", "TERM 102"])
        XCTAssertEqual(model.stops[bundle.stopId], .stopping(sentAt: clock))

        // A server's own Stop on the page is its own.
        model.tap(single.rows[0])
        clock.addTimeInterval(1)
        model.tap(single.rows[0])
        XCTAssertEqual(signaller.sent.last, "TERM 103")

        // The bundle goes: its page goes back to the list, and so does its Stop.
        source.alive = [103: project[2].identity]
        clock.addTimeInterval(5)
        model.settle()
        XCTAssertNil(model.stops[bundle.stopId])
        XCTAssertNil(model.openBundle)
        XCTAssertEqual(model.rows.map(\.name), ["http.server"])
    }

    func testOneServerWithSeveralLinksDrillsAndItsPageLinkComesFirst() async {
        let prober = FakeProber()
        prober.http = [3000: IslandHTTPProbe(isHTTP: true), 3001: IslandHTTPProbe(isHTTP: true, isHTML: true)]
        let (model, _, _) = model([process(101, ["node", "server.js"], tcp: [3000, 3001, 9229])], prober: prober)
        var opened: [URL] = []
        model.openURL = { opened.append($0) }
        await model.refresh()
        let bundle = try! XCTUnwrap(model.bundles.first)
        XCTAssertEqual(model.links(bundle.rows[0]).map(\.port), [3001, 3000], "the page first; 9229 speaks no HTTP")
        XCTAssertTrue(model.drills(bundle), "the other link lives on its page")
        let link = try! XCTUnwrap(model.link(bundle))
        XCTAssertEqual(link.label, "localhost:3001")
        model.open(link)
        XCTAssertEqual(opened, [URL(string: "http://localhost:3001/")!])
        XCTAssertEqual(IslandServerLink(port: 9, host: .v6, isHTML: false).url.absoluteString, "http://[::1]:9/",
                       "a port only on ::1 links there")
    }

    // MARK: The cache

    func testEachServersPortIsProbedOnceAndEachProjectsIconLookedForOnce() async {
        let prober = FakeProber()
        prober.http = [3888: IslandHTTPProbe(isHTTP: true, isHTML: true)]
        prober.icon = Self.png()
        var list = project
        // A port bound only to another address is never probed.
        list.append(process(104, ["node", "lan.js"], cwd: "/Users/me/lan", tcp: [9100], loopback: [:], started: epoch - 1))
        let (model, source, _) = model(list, prober: prober)
        await model.refresh()
        XCTAssertEqual(Set(prober.probed), [3888, 61010, 8000])
        XCTAssertEqual(prober.probed.count, 3)
        XCTAssertEqual(prober.iconLookups.count, 3, "one per project")
        XCTAssertNotNil(model.icons["package:/opt/homebrew/lib/node_modules/@waifucave/discord-waifus"])
        XCTAssertTrue(prober.iconLookups.contains(["/Users/me/Discord Waifus", "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus"]),
                      "the project's folder, then its package's")

        await model.refresh()
        await model.refresh(resetPage: true)
        XCTAssertEqual(prober.probed.count, 3, "cached for the server's lifetime")
        XCTAssertEqual(prober.iconLookups.count, 3)

        // The python server restarts (a new start time): a new server — its port probed again.
        source.list[2] = process(103, ["python3", "-m", "http.server"], path: "/usr/bin/python3", tcp: [8000], started: epoch + 100)
        await model.refresh()
        XCTAssertEqual(prober.probed.count, 4)
        XCTAssertEqual(prober.probed.last, 8000)
    }

    func testTheProbeRunnerKeepsAtMostEightInFlight() async {
        let lock = NSLock()
        var running = 0
        var most = 0
        let jobs: [() -> Int] = (0..<24).map { i in
            {
                lock.lock()
                running += 1
                most = max(most, running)
                lock.unlock()
                usleep(20_000)
                lock.lock()
                running -= 1
                lock.unlock()
                return i
            }
        }
        let results = await IslandServerProbes.run(jobs)
        XCTAssertEqual(results, Array(0..<24))
        XCTAssertLessThanOrEqual(most, IslandServerProbes.limit)
        XCTAssertGreaterThan(most, 1)
    }

    // MARK: HTTP on loopback

    func testResponsesAndLoopbackFamiliesParse() {
        let page = IslandHTTP.parse(Data("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nX-A: b\r\n\r\n<html>".utf8))
        XCTAssertEqual(page?.status, 200)
        XCTAssertEqual(page?.isHTML, true)
        XCTAssertEqual(page?.headers["x-a"], "b")
        XCTAssertEqual(page?.body, Data("<html>".utf8))
        XCTAssertEqual(IslandHTTP.parse(Data("HTTP/1.0 302 Found\r\nLocation: /x\r\n\r\n".utf8))?.isRedirect, true)
        XCTAssertEqual(IslandHTTP.parse(Data("HTTP/1.1 200 OK\r\n\r\n0123456789".utf8), maxBody: 4)?.body, Data("0123".utf8))
        XCTAssertNil(IslandHTTP.parse(Data("garbage\n".utf8)))
        XCTAssertNil(IslandHTTP.parse(Data("SSH-2.0-OpenSSH_9.6\r\n".utf8)))
        XCTAssertNil(IslandHTTP.parse(Data()))

        XCTAssertEqual(IslandLoopback.of(v4: 0x7f00_0001), .v4)
        XCTAssertEqual(IslandLoopback.of(v4: 0), .v4, "0.0.0.0 answers on 127.0.0.1")
        XCTAssertNil(IslandLoopback.of(v4: 0xc0a8_0001), "192.168.0.1 only: never probed")
        XCTAssertEqual(IslandLoopback.of(v6: [UInt8](repeating: 0, count: 15) + [1]), .v6)
        XCTAssertEqual(IslandLoopback.of(v6: [UInt8](repeating: 0, count: 16)), .v6)
        XCTAssertEqual(IslandLoopback.of(v6: [UInt8](repeating: 0, count: 10) + [0xff, 0xff, 127, 0, 0, 1]), .v4)
        XCTAssertNil(IslandLoopback.of(v6: [0xfe, 0x80] + [UInt8](repeating: 0, count: 13) + [1]))
    }

    func testOnlyLoopbackIsEverFollowed() {
        let base = IslandLoopbackTarget(host: .v4, port: 3000, path: "/")
        XCTAssertNil(IslandHTTP.loopbackTarget("http://example.com/", base: base))
        XCTAssertNil(IslandHTTP.loopbackTarget("//example.com/x.png", base: base))
        XCTAssertNil(IslandHTTP.loopbackTarget("https://localhost/", base: base), "no TLS: never fetched")
        XCTAssertNil(IslandHTTP.loopbackTarget("data:image/png;base64,AAAA", base: base))
        XCTAssertNil(IslandHTTP.loopbackTarget("http://192.168.1.2:3000/", base: base))
        XCTAssertNil(IslandHTTP.loopbackTarget("http://localhost.example.com/", base: base))
        XCTAssertEqual(IslandHTTP.loopbackTarget("/a/b?x=1", base: base), IslandLoopbackTarget(host: .v4, port: 3000, path: "/a/b?x=1"))
        XCTAssertEqual(IslandHTTP.loopbackTarget("fav.png", base: IslandLoopbackTarget(host: .v4, port: 3000, path: "/app/")),
                       IslandLoopbackTarget(host: .v4, port: 3000, path: "/app/fav.png"))
        XCTAssertEqual(IslandHTTP.loopbackTarget("http://127.0.0.1:8080/x", base: base), IslandLoopbackTarget(host: .v4, port: 8080, path: "/x"))
        XCTAssertEqual(IslandHTTP.loopbackTarget("http://[::1]:9/", base: base), IslandLoopbackTarget(host: .v6, port: 9, path: "/"))
        XCTAssertEqual(IslandHTTP.loopbackTarget("http://localhost/", base: IslandLoopbackTarget(host: .v6, port: 1, path: "/")),
                       IslandLoopbackTarget(host: .v6, port: 80, path: "/"))
        XCTAssertEqual(IslandHTTP.iconLinks("""
            <head><link rel="apple-touch-icon" href="/touch.png"><LINK REL='shortcut icon' HREF='/fav.ico'>
            <link href=/b.png rel=icon><link rel="stylesheet" href="/s.css"></head>
            """), ["/fav.ico", "/b.png", "/touch.png"])
    }

    func testAPortIsHTTPOnlyWhenItAnswersHTTPAndARedirectAwayIsNeverFollowed() throws {
        let png = Self.png()
        let page = LoopbackTestServer { path in
            switch path {
            case "/": return LoopbackTestServer.http("200 OK", type: "text/html; charset=utf-8", body: Data("""
                <html><head><link rel="shortcut icon" href="/static/fav.png">
                <link rel="apple-touch-icon" href="http://example.com/touch.png"></head><body>hi</body></html>
                """.utf8))
            case "/static/fav.png": return LoopbackTestServer.http("200 OK", type: "image/png", body: png)
            default: return LoopbackTestServer.http("404 Not Found")
            }
        }
        let plain = LoopbackTestServer { _ in LoopbackTestServer.http("200 OK", type: "application/json", body: Data("{}".utf8)) }
        let garbage = LoopbackTestServer { _ in Data("garbage\n".utf8) }
        let away = LoopbackTestServer { _ in LoopbackTestServer.http("302 Found", headers: ["Location: http://example.com/"]) }
        let home = LoopbackTestServer { path in
            path == "/" ? LoopbackTestServer.http("302 Found", headers: ["Location: /home"])
                : LoopbackTestServer.http("200 OK", type: "text/html", body: Data("<html></html>".utf8))
        }
        defer { [page, plain, garbage, away, home].forEach { $0.stop() } }

        let pageProbe = IslandHTTP.probe(.v4, port: page.port)
        XCTAssertEqual(pageProbe, IslandHTTPProbe(isHTTP: true, isHTML: true,
                                                  iconLinks: [IslandLoopbackTarget(host: .v4, port: page.port, path: "/static/fav.png")]),
                       "the page's own icon; the one on example.com is dropped")
        XCTAssertEqual(IslandHTTP.probe(.v4, port: plain.port), IslandHTTPProbe(isHTTP: true))
        XCTAssertEqual(IslandHTTP.probe(.v4, port: garbage.port), IslandHTTPProbe(), "garbage is no HTTP: no link")
        XCTAssertEqual(IslandHTTP.probe(.v4, port: away.port), IslandHTTPProbe(isHTTP: true), "a link, no page, no icon")
        XCTAssertEqual(away.paths, ["/"], "the redirect to example.com is never followed")
        XCTAssertEqual(IslandHTTP.probe(.v4, port: home.port).isHTML, true, "a redirect on loopback is followed")
        XCTAssertEqual(home.paths, ["/", "/home"])

        // A closed port: no answer, within the deadline.
        let closed = LoopbackTestServer { _ in Data() }
        let closedPort = closed.port
        closed.stop()
        let started = Date()
        XCTAssertEqual(IslandHTTP.probe(.v4, port: closedPort), IslandHTTPProbe())
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)

        // Their links: the page first, at http://localhost:<port>/.
        var row = rows([process(101, ["node", "server.js"], tcp: [plain.port, page.port, garbage.port])])[0]
        row.loopback = [plain.port: .v4, page.port: .v4, garbage.port: .v4]
        let http = [IslandServers.probeKey(row, page.port): pageProbe,
                    IslandServers.probeKey(row, plain.port): IslandHTTPProbe(isHTTP: true),
                    IslandServers.probeKey(row, garbage.port): IslandHTTPProbe()]
        let links = IslandServers.links(row, http: http)
        XCTAssertEqual(links.map(\.port), [page.port, plain.port])
        XCTAssertEqual(links.first?.url, URL(string: "http://localhost:\(page.port)/"))
    }

    // MARK: Logos

    func testTheIconLadderFromThePageThenFaviconThenTheProject() throws {
        let png = Self.png(4)
        let other = Self.png(8)
        let page = LoopbackTestServer { path in
            switch path {
            case "/": return LoopbackTestServer.http("200 OK", type: "text/html", body: Data(#"<link rel="icon" href="/i.png">"#.utf8))
            case "/i.png": return LoopbackTestServer.http("200 OK", type: "image/png", body: png)
            default: return LoopbackTestServer.http("404 Not Found")
            }
        }
        let bare = LoopbackTestServer { path in
            path == "/favicon.ico" ? LoopbackTestServer.http("200 OK", type: "image/x-icon", body: other)
                : LoopbackTestServer.http("200 OK", type: "text/html", body: Data("<html></html>".utf8))
        }
        let broken = LoopbackTestServer { path in
            path == "/" ? LoopbackTestServer.http("200 OK", type: "text/html", body: Data(#"<link rel="icon" href="/x.png">"#.utf8))
                : LoopbackTestServer.http("200 OK", type: "image/png", body: Data("not an image".utf8))
        }
        defer { [page, bare, broken].forEach { $0.stop() } }

        // (a) the page's link, else /favicon.ico; nothing that does not draw.
        XCTAssertEqual(IslandServerIcons.fromHTTP([(IslandHTTP.probe(.v4, port: page.port), .v4, page.port)]), png)
        XCTAssertEqual(IslandServerIcons.fromHTTP([(IslandHTTP.probe(.v4, port: bare.port), .v4, bare.port)]), other)
        XCTAssertNil(IslandServerIcons.fromHTTP([(IslandHTTP.probe(.v4, port: broken.port), .v4, broken.port)]))

        // (b) the project's own: oversized, not an image, a link — all skipped; `public/favicon.png` found.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("servers-icons-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("public"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try (png + Data(count: IslandServerIcons.maxFileSize)).write(to: folder.appendingPathComponent("logo.png"))
        try Data("not an image".utf8).write(to: folder.appendingPathComponent("icon.png"))
        try other.write(to: folder.appendingPathComponent("elsewhere.png"))
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("favicon.png"),
                                                   withDestinationURL: folder.appendingPathComponent("elsewhere.png"))
        try png.write(to: folder.appendingPathComponent("public/favicon.png"))
        XCTAssertEqual(IslandServerIcons.fromProject([folder.path]), png)
        XCTAssertNil(IslandServerIcons.fromProject(["/", ""]))
        XCTAssertNil(IslandServerIcons.fromProject([folder.appendingPathComponent("none").path]))

        // The live prober's ladder: the page first, the project only without one.
        let prober = IslandLiveServerProber()
        XCTAssertEqual(prober.icon(pages: [(IslandHTTP.probe(.v4, port: bare.port), .v4, bare.port)], folders: [folder.path]), other)
        XCTAssertEqual(prober.icon(pages: [], folders: [folder.path]), png)
    }

    /// The live scan records where this process's own listener answers on loopback.
    func testTheLiveSourceRecordsALoopbackListener() throws {
        let server = LoopbackTestServer { _ in LoopbackTestServer.http("204 No Content") }
        defer { server.stop() }
        let mine = try XCTUnwrap(LibprocServerProcessSource().processes().first { $0.pid == getpid() })
        XCTAssertEqual(mine.loopback[server.port], .v4)
    }

    /// A tiny PNG of `size` × `size`.
    static func png(_ size: Int = 4) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return rep.representation(using: .png, properties: [:])!
    }
}

/// A tiny HTTP server on 127.0.0.1:0 for these tests: each request's path goes to `respond`, its bytes go back, the
/// connection closes. It records the paths asked for.
final class LoopbackTestServer {
    let port: UInt16
    private let fd: Int32
    private let lock = NSLock()
    private var asked: [String] = []

    var paths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return asked
    }

    init(_ respond: @escaping (String) -> Data) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        _ = Darwin.listen(fd, 16)
        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        self.fd = fd
        self.port = UInt16(bigEndian: bound.sin_port)
        Thread.detachNewThread { [weak self] in
            while true {
                let client = Darwin.accept(fd, nil, nil)
                guard client >= 0 else { return }
                var on: Int32 = 1
                setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                var buffer = [UInt8](repeating: 0, count: 8192)
                let read = recv(client, &buffer, buffer.count, 0)
                let request = String(decoding: buffer.prefix(max(0, read)), as: UTF8.self)
                let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                self?.record(path)
                let reply = respond(path)
                reply.withUnsafeBytes { _ = Darwin.send(client, $0.baseAddress, $0.count, 0) }
                Darwin.close(client)
            }
        }
    }

    private func record(_ path: String) {
        lock.lock()
        asked.append(path)
        lock.unlock()
    }

    func stop() {
        shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }

    static func http(_ status: String, type: String? = nil, headers: [String] = [], body: Data = Data()) -> Data {
        var head = "HTTP/1.1 \(status)\r\n"
        if let type { head += "Content-Type: \(type)\r\n" }
        for header in headers { head += "\(header)\r\n" }
        head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        return Data(head.utf8) + body
    }
}
