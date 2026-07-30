import Darwin
import Foundation
import XCTest
@testable import NormaChatKit

/// The generator-INDEPENDENT safety net for `ssrfGuard`, and the direct answer to having been bitten
/// twice by the same failure mode: a differential is only ever as good as its generator's imagination
/// (round 1 could not express bare authorities; round 2 could not express non-canonical address
/// spellings, and that gap was a fail-open Critical — a URL that resolved to the router). Both of
/// those checks ask "does the port agree with the reference?"; neither asks the question that actually
/// matters, which is "does the port refuse what the OS will actually dial?"
///
/// This test asks the OS. It builds a corpus MECHANICALLY — by transform, never a curated list, since
/// a curated list inherits exactly the imagination gap this exists to escape — and asserts one thing:
/// for every host `ssrfGuard` ALLOWS, `getaddrinfo` must not resolve it into private/loopback/
/// link-local/ULA space. A spelling nobody thought to enumerate cannot slip through, because the
/// invariant is checked against the resolver's answer rather than against a list of known-bad inputs.
///
/// HERMETIC. `AI_NUMERICHOST` makes `getaddrinfo` a pure parser: it resolves numeric literals in every
/// spelling the dialer accepts (`3232235777`, `0xc0a80101`, `0300.0250.0.1`, `::ffff:7f00:1`) and
/// returns EAI_NONAME for anything that would need DNS, so this emits zero network traffic. Runs in
/// well under a second.
final class SSRFResolverSweepTests: XCTestCase {
    /// The invariant. Restated to be exactly what it says: nothing the guard lets through may target
    /// the machine's own network neighbourhood.
    func testNothingTheGuardAllowsResolvesIntoPrivateSpace() {
        let corpus = Self.mechanicalCorpus()
        // The corpus must be large and must exercise BOTH branches, or the invariant is vacuous.
        XCTAssertGreaterThan(corpus.count, 400, "corpus too small to be a meaningful sweep")

        var allowed = 0
        var refused = 0
        var holes: [String] = []

        for host in corpus {
            if ssrfGuard("http://\(host)/x") != nil {
                refused += 1
                continue
            }
            allowed += 1
            for addr in Self.numericResolve(Self.forResolution(host)) where Self.isPrivateAddress(addr) {
                holes.append("http://\(host)/  ALLOWED but resolves to \(addr)")
            }
        }

        // Liveness: a guard that refused (or allowed) the entire corpus would satisfy the invariant
        // trivially. The public spellings populate the allow-set; the private spellings populate the
        // refuse-set. Both must be non-empty for the assertion below to mean anything.
        XCTAssertGreaterThan(allowed, 0, "guard refused the ENTIRE corpus — invariant would be vacuous")
        XCTAssertGreaterThan(refused, 0, "guard allowed the ENTIRE corpus — invariant would be vacuous")

        XCTAssertTrue(holes.isEmpty,
                      "ssrfGuard ALLOWS \(holes.count) host(s) the resolver targets into private space:\n"
                          + holes.sorted().joined(separator: "\n"))
    }

    // MARK: - mechanical corpus

    /// Every spelling produced by a TRANSFORM over a set of target addresses — private ones (which a
    /// correct guard refuses) and public ones (which it allows, giving the liveness check something to
    /// see). No spelling is written out by hand; each is derived, so the corpus covers combinations no
    /// one enumerated.
    static func mechanicalCorpus() -> [String] {
        var hosts: [String] = []

        // Private / loopback / link-local IPv4 — a representative of each range plus boundaries.
        let privateV4: [(UInt32, UInt32, UInt32, UInt32)] = [
            (127, 0, 0, 1), (127, 1, 2, 3), (127, 255, 255, 254),
            (10, 0, 0, 1), (10, 255, 255, 255),
            (172, 16, 0, 1), (172, 20, 10, 1), (172, 31, 255, 255),
            (192, 168, 0, 1), (192, 168, 1, 1),
            (169, 254, 0, 1), (169, 254, 169, 254),
            (0, 0, 0, 0), (0, 1, 2, 3),
        ]
        // Public IPv4 — every one is public under BOTH readings, so a correct guard allows them and
        // they resolve to themselves. This is the allow-set the invariant is actually exercised on.
        let publicV4: [(UInt32, UInt32, UInt32, UInt32)] = [
            (8, 8, 8, 8), (1, 1, 1, 1), (9, 9, 9, 9), (223, 255, 255, 255),
            (11, 0, 0, 1), (126, 0, 0, 1), (128, 0, 0, 1),
            (172, 15, 0, 1), (172, 32, 0, 1), (192, 167, 1, 1), (192, 169, 1, 1),
            (169, 253, 0, 1), (169, 255, 0, 1),
        ]
        for octets in privateV4 + publicV4 { hosts += ipv4Spellings(octets) }

        // IPv6 — private literals (refused) and public ones (allowed), each expanded mechanically.
        let privateV6 = ["::1", "::", "fe80::1", "fe90::1", "febf::1", "fc00::1", "fdff:ffff::1"]
        let publicV6 = ["2001:db8::1", "2606:4700:4700::1111"]
        for literal in privateV6 + publicV6 { hosts += ipv6Spellings(literal) }
        // Link-local with a zone id must not be disguised by the scope suffix.
        hosts.append("[fe80::1%25en0]")

        return hosts
    }

    private static func ipv4Spellings(_ octets: (UInt32, UInt32, UInt32, UInt32)) -> [String] {
        let (a, b, c, d) = octets
        let n = (a << 24) | (b << 16) | (c << 8) | d
        func hx(_ v: UInt32) -> String { String(v, radix: 16) }
        func oc(_ v: UInt32) -> String { String(v, radix: 8) }
        let hi = (a << 8) | b
        let lo = (c << 8) | d
        return [
            "\(a).\(b).\(c).\(d)",                                             // dotted decimal
            "\(a).\(b).\(c).\(d).",                                            // trailing dot
            "\(n)",                                                            // 32-bit integer
            "0x\(hx(n))",                                                      // hex integer
            "0X\(hx(n).uppercased())",                                         // upper-hex integer
            "0\(oc(n))",                                                       // octal integer
            "\(a).\(b).\((c << 8) | d)",                                       // 3-part (last is 16-bit)
            "\(a).\((b << 16) | (c << 8) | d)",                                // 2-part (last is 24-bit)
            "0\(oc(a)).0\(oc(b)).0\(oc(c)).0\(oc(d))",                         // per-octet octal
            "0x\(hx(a)).0x\(hx(b)).0x\(hx(c)).0x\(hx(d))",                     // per-octet hex
            "0x\(hx(a)).\(b).\(c).\(d)",                                       // mixed radix
            "0\(a).\(b).\(c).\(d)",                                            // leading-zero decimal (ambiguous)
            "00\(a).\(b).\(c).\(d)",                                           // double leading zero
            "[::ffff:\(a).\(b).\(c).\(d)]",                                    // IPv4-mapped, dotted
            "[::ffff:\(hx(hi)):\(hx(lo))]",                                    // IPv4-mapped, hex
            "[0:0:0:0:0:ffff:\(hx(hi)):\(hx(lo))]",                            // IPv4-mapped, uncompressed
        ]
    }

    private static func ipv6Spellings(_ literal: String) -> [String] {
        var out = [literal, "[\(literal)]", "[\(literal.uppercased())]"]
        var bytes = [UInt8](repeating: 0, count: 16)
        if inet_pton(AF_INET6, literal, &bytes) == 1 {
            let groups = stride(from: 0, to: 16, by: 2).map { (UInt16(bytes[$0]) << 8) | UInt16(bytes[$0 + 1]) }
            out.append("[" + groups.map { String(format: "%04x", $0) }.joined(separator: ":") + "]") // fully expanded
            out.append("[" + groups.map { String($0, radix: 16) }.joined(separator: ":") + "]")       // expanded, no leading zeros
        }
        return out
    }

    // MARK: - the resolver oracle

    /// Strip the brackets/zone the corpus carries for the guard so `getaddrinfo` sees a bare host.
    private static func forResolution(_ host: String) -> String {
        var h = host
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        if h.hasSuffix(".") { h.removeLast() }
        return h
    }

    /// `getaddrinfo` in pure-parser mode. `AI_NUMERICHOST` guarantees no DNS lookup: a numeric literal
    /// in any accepted spelling resolves, anything else returns EAI_NONAME. This is the OS's own
    /// answer to "what address does this host string denote?", which is the whole point — it does not
    /// depend on this test having imagined the spelling.
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

    /// Classifies a CANONICAL numeric address (the form `getnameinfo` emits) as private. Deliberately
    /// an independent second implementation of the range table — if it merely called into the code
    /// under test the sweep would prove nothing.
    private static func isPrivateAddress(_ addr: String) -> Bool {
        let bare = addr.split(separator: "%", maxSplits: 1).first.map(String.init) ?? addr

        let v4Parts = bare.split(separator: ".", omittingEmptySubsequences: false)
        if v4Parts.count == 4, let octets = try? v4Parts.map({ part -> Int in
            guard let v = Int(part), (0 ... 255).contains(v) else { throw Oops.no }
            return v
        }) {
            return isPrivateV4(octets[0], octets[1])
        }

        var bytes = [UInt8](repeating: 0, count: 16)
        guard inet_pton(AF_INET6, bare, &bytes) == 1 else { return false }
        if bytes.allSatisfy({ $0 == 0 }) { return true }                                   // ::
        if bytes[0 ..< 15].allSatisfy({ $0 == 0 }), bytes[15] == 1 { return true }         // ::1
        if bytes[0 ..< 10].allSatisfy({ $0 == 0 }), bytes[10] == 0xFF, bytes[11] == 0xFF { // ::ffff:v4
            return isPrivateV4(Int(bytes[12]), Int(bytes[13]))
        }
        if bytes[0] & 0xFE == 0xFC { return true }                                         // fc00::/7
        if bytes[0] == 0xFE, bytes[1] & 0xC0 == 0x80 { return true }                       // fe80::/10
        return false
    }

    private static func isPrivateV4(_ a: Int, _ b: Int) -> Bool {
        a == 127 || a == 10 || a == 0
            || (a == 172 && b >= 16 && b <= 31)
            || (a == 192 && b == 168)
            || (a == 169 && b == 254)
    }

    private enum Oops: Error { case no }
}
