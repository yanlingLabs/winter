import Darwin
import Foundation
import XCTest
@testable import NormaChatKit

/// THE UTS-46 QUESTION, AND ITS ANSWER (chat-d T6c, `task-6b-review.md` §8 item 1).
///
/// The dispatch expected a LIVE hole here — the inverse of the daemon's latent one. The reasoning was:
/// `Foundation.URL` canonicalizes nothing, so a fullwidth-digit host (`０１０.0.0.1`) would reach
/// `parsePart`'s `isASCII` guard, fail every numeric reading and be ALLOWED, while CFNetwork applies
/// UTS-46, maps it to `010.0.0.1` and dials 10.0.0.1 — a private address.
///
/// MEASURED, BOTH HALVES, AND THE HOLE IS NOT THERE. The two premises are each true only where the other
/// is false:
///
///  1. `URL.host(percentEncoded: false)` does NOT preserve fullwidth digits — it MAPS them.
///     `http://０１０.0.0.1/` → host `010.0.0.1`; `http://０１２７｡０｡０｡１/` → `0127.0.0.1`;
///     `010。0.0.1` / `010．0.0.1` / `010｡0.0.1` (U+3002 / U+FF0E / U+FF61) → `010.0.0.1`;
///     `¹⁰.0.0.1` → `10.0.0.1`. So the guard already judges the mapped form — the same string the
///     transport dials — and refuses it through the ordinary `decimalOnly` reading.
///  2. The ONE spelling that does survive unmapped is the PERCENT-ENCODED UTF-8 of those characters
///     (`http://%EF%BC%90%EF%BC%91%EF%BC%90.0.0.1/` → host `０１０.0.0.1`, fullwidth preserved). For that
///     spelling the transport does NOT map: `URLSession` fails it with NSURLErrorCannotFindHost (-1003,
///     measured), because a percent-encoded host is not re-decoded into the IDNA mapping step. There is
///     nothing to dial, so an allowed verdict cannot become a fetch.
///
/// So the guard is NOT changed by this task. What is added is this file: the two premises are pinned as
/// executable assertions, because the safety of the current code DEPENDS on them. If a future Foundation
/// stops mapping (premise 1 flips) while CFNetwork keeps mapping, the hole the dispatch expected becomes
/// real — and `testUrlHostAppliesTheUts46MappingStep` goes red the day it happens instead of nobody
/// noticing. `SSRFResolverSweepTests` carries the same class mechanically, over derived spellings.
final class SSRFHostMappingTests: XCTestCase {
    private let priv = "refusing to fetch a private address"

    /// PREMISE 1. Every one of these is a spelling whose UTS-46 mapping is a private IPv4 literal, written
    /// with characters that are NOT ASCII. `URL.host(percentEncoded: false)` returns the mapped ASCII form
    /// for all of them, which is why `ssrfGuard` — which parses exactly that string — refuses them.
    func testUrlHostAppliesTheUts46MappingStep() {
        let cases: [(String, String)] = [
            ("http://\u{FF10}\u{FF11}\u{FF10}.0.0.1/", "010.0.0.1"), // ０１０ fullwidth digits
            ("http://\u{FF10}\u{FF11}\u{FF12}\u{FF17}.0.0.1/", "0127.0.0.1"), // ０１２７
            ("http://010\u{3002}0.0.1/", "010.0.0.1"), // U+3002 IDEOGRAPHIC FULL STOP
            ("http://010\u{FF0E}0.0.1/", "010.0.0.1"), // U+FF0E FULLWIDTH FULL STOP
            ("http://010\u{FF61}0.0.1/", "010.0.0.1"), // U+FF61 HALFWIDTH IDEOGRAPHIC FULL STOP
            ("http://\u{FF10}\u{FF11}\u{FF10}\u{FF61}\u{FF10}\u{FF61}\u{FF10}\u{FF61}\u{FF11}/", "010.0.0.1"),
            ("http://\u{FF10}\u{FF11}\u{FF12}\u{FF17}\u{FF61}\u{FF10}\u{FF61}\u{FF10}\u{FF61}\u{FF11}/", "0127.0.0.1"),
            ("http://\u{00B9}\u{2070}.0.0.1/", "10.0.0.1"), // ¹⁰ superscripts
            ("http://\u{FF11}\u{FF12}\u{FF17}.0.0.1/", "127.0.0.1"), // １２７
        ]
        for (raw, expectedHost) in cases {
            guard let url = URL(string: raw) else { return XCTFail("URL(string:) rejected \(raw)") }
            XCTAssertEqual(url.host(percentEncoded: false), expectedHost,
                           "Foundation stopped applying the UTS-46 mapping step for \(raw) — see this file's "
                               + "header: with premise 1 flipped, ssrfGuard needs the mapping itself")
            // …and therefore the guard already refuses it, with no mapping code of its own.
            XCTAssertEqual(ssrfGuard(raw), priv, "guard allowed \(raw) (host \(expectedHost))")
        }
    }

    /// PREMISE 2, the half that fails. A percent-encoded host survives to `URL.host` unmapped — so the guard
    /// really does see fullwidth digits here, and really does not parse them — but the same spelling is not
    /// resolvable, so nothing can be dialled. Checked at the RESOLVER, with `AI_NUMERICHOST`, so this test
    /// emits no traffic of any kind: if the host is not a numeric literal, no dialler can reach an address
    /// without DNS, and no DNS name maps to a private address by accident of spelling.
    func testPercentEncodedFullwidthSurvivesUnmappedButIsNotDialable() {
        let raw = "http://%EF%BC%90%EF%BC%91%EF%BC%90.0.0.1/" // ０１０.0.0.1
        guard let url = URL(string: raw), let host = url.host(percentEncoded: false) else {
            return XCTFail("URL(string:) rejected \(raw)")
        }
        XCTAssertEqual(host, "\u{FF10}\u{FF11}\u{FF10}.0.0.1", "the percent-encoded form is no longer preserved")
        // The guard cannot parse it (no ASCII reading) …
        XCTAssertTrue(ipv4Interpretations(host).isEmpty)
        // … and nothing else can either: not a numeric literal under any spelling the dialler accepts.
        XCTAssertTrue(Self.numericResolve(host).isEmpty,
                      "the unmapped fullwidth host became numerically resolvable — premise 2 has flipped and "
                          + "ssrfGuard now needs the UTS-46 mapping step")
        // Measured for the record: URLSession fails this URL with NSURLErrorCannotFindHost (-1003).
        // Not asserted here, because asserting it would mean letting the transport attempt a DNS lookup.
    }

    /// PREMISE 2, the half that holds — and the one that makes premise 1 load-bearing: the transport really
    /// does dial the MAPPED form, so `URL.host` and the connect target are the same string.
    ///
    /// HERMETIC BY CONSTRUCTION. The listener binds 127.0.0.1 ONLY, on an ephemeral port, and every
    /// candidate is asserted to resolve — via `getaddrinfo(AI_NUMERICHOST)`, i.e. without DNS — to 127.0.0.1
    /// BEFORE it is dialled. So no packet can leave the machine and no name lookup can occur. (This is the
    /// phone-side twin of the reviewer's own loopback probe on the daemon, which is what established that
    /// Bun's `fetch` dials the canonical authority.)
    func testUrlSessionDialsTheMappedFormAndTheGuardRefusesIt() throws {
        let probe = LoopbackListener()
        try probe.start()
        defer { probe.stop() }

        let candidates = [
            "http://127.0.0.1:\(probe.port)/", // sanity
            "http://0127.0.0.1:\(probe.port)/", // Darwin's decimal quad reading — 127.0.0.1
            "http://\u{FF11}\u{FF12}\u{FF17}.0.0.1:\(probe.port)/", // １２７ → 127.0.0.1
            "http://\u{FF10}\u{FF11}\u{FF12}\u{FF17}\u{FF61}\u{FF10}\u{FF61}\u{FF10}\u{FF61}\u{FF11}:\(probe.port)/",
            "http://0127\u{3002}0\u{3002}0\u{3002}1:\(probe.port)/",
        ]

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config)

        for raw in candidates {
            guard let url = URL(string: raw), let host = url.host(percentEncoded: false) else {
                return XCTFail("URL(string:) rejected \(raw)")
            }
            // The hermeticity precondition: this host is a numeric loopback literal, so the dial cannot
            // leave the box and cannot consult DNS.
            XCTAssertEqual(Self.numericResolve(host), ["127.0.0.1"], "refusing to dial non-loopback \(host)")

            let done = expectation(description: raw)
            var status: Int?
            session.dataTask(with: url) { _, response, _ in
                status = (response as? HTTPURLResponse)?.statusCode
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 15)
            XCTAssertEqual(status, 200, "\(raw) did not reach the loopback listener")
        }

        // Every request landed on the 127.0.0.1-bound listener, and each arrived with the MAPPED host in its
        // `Host` header — the direct evidence that the connect target is `URL.host`, not the raw spelling.
        let seen = probe.requests
        XCTAssertEqual(seen.count, candidates.count)
        XCTAssertEqual(seen.compactMap { Self.hostHeader($0) },
                       ["127.0.0.1:\(probe.port)", "0127.0.0.1:\(probe.port)", "127.0.0.1:\(probe.port)",
                        "0127.0.0.1:\(probe.port)", "0127.0.0.1:\(probe.port)"])

        // And the guard refuses each of them — the coupling is safe TODAY because premise 1 holds.
        for raw in candidates {
            XCTAssertEqual(ssrfGuard(raw), priv, "guard allowed a URL that dials loopback: \(raw)")
        }
    }

    // MARK: - helpers

    private static func hostHeader(_ request: String) -> String? {
        request.split(separator: "\r\n")
            .first { $0.lowercased().hasPrefix("host:") }
            .map { $0.dropFirst("host:".count).trimmingCharacters(in: .whitespaces) }
    }

    /// `getaddrinfo` in pure-parser mode — the same technique `SSRFResolverSweepTests` uses, and for the
    /// same reason: it answers "what address does this string denote to the dialler?" with zero traffic.
    private static func numericResolve(_ host: String) -> [String] {
        var hints = addrinfo(ai_flags: AI_NUMERICHOST, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &res) == 0, res != nil else { return [] }
        defer { freeaddrinfo(res) }
        var out: [String] = []
        var node = res
        while let cur = node {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(cur.pointee.ai_addr, cur.pointee.ai_addrlen, &buffer, socklen_t(buffer.count),
                           nil, 0, NI_NUMERICHOST) == 0 {
                out.append(String(cString: buffer))
            }
            node = cur.pointee.ai_next
        }
        return out
    }
}

/// A minimal HTTP listener bound to 127.0.0.1 on an ephemeral port. Deliberately BSD sockets rather than a
/// framework: the only thing this needs to prove is which authority the transport connected to.
private final class LoopbackListener: @unchecked Sendable {
    private var fd: Int32 = -1
    private let lock = NSLock()
    private var seen: [String] = []
    private(set) var port: UInt16 = 0

    var requests: [String] { lock.withLock { seen } }

    struct SocketFailure: Error { let what: String; let errnoValue: Int32 }

    func start() throws {
        fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketFailure(what: "socket", errnoValue: errno) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0 // ephemeral
        addr.sin_addr.s_addr = inet_addr("127.0.0.1") // LOOPBACK ONLY — nothing can reach this from outside
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw SocketFailure(what: "bind", errnoValue: errno) }

        var back = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &back) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        port = UInt16(bigEndian: back.sin_port)
        guard listen(fd, 8) == 0 else { throw SocketFailure(what: "listen", errnoValue: errno) }

        let listening = fd
        Thread.detachNewThread { [weak self] in
            while true {
                let client = accept(listening, nil, nil)
                if client < 0 { return } // the listener was closed
                var buffer = [UInt8](repeating: 0, count: 4096)
                let read = Darwin.read(client, &buffer, buffer.count)
                if read > 0, let self {
                    let request = String(decoding: buffer[0 ..< read], as: UTF8.self)
                    self.lock.withLock { self.seen.append(request) }
                }
                let body = "ok"
                let response = "HTTP/1.1 200 OK\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                _ = response.withCString { write(client, $0, strlen($0)) }
                close(client)
            }
        }
    }

    func stop() {
        if fd >= 0 {
            close(fd)
            fd = -1
        }
    }
}
