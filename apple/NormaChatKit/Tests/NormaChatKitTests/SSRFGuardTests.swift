import Foundation
import XCTest
@testable import NormaChatKit

/// `ssrfGuard` parity with `packages/core/src/agent/tools/web.ts:37-91`. The phone is ON the user's
/// LAN, so this matters *more* here than on the Mac: without it a prompt-injected page can talk the
/// model into reading a router/printer/NAS admin page.
///
/// Error strings are asserted verbatim, not just "non-nil" — they are the audit/transcript surface
/// and must read identically on both engines.
final class SSRFGuardTests: XCTestCase {
    private let local = "refusing to fetch a local address"
    private let priv = "refusing to fetch a private address"

    private func assertRefused(_ url: String, _ expected: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(ssrfGuard(url), expected, "expected refusal for \(url)", file: file, line: line)
    }

    private func assertAllowed(_ url: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(ssrfGuard(url), "expected \(url) to be allowed", file: file, line: line)
    }

    // MARK: scheme + parseability

    func testUnparseableAndNonHttpSchemes() {
        XCTAssertEqual(ssrfGuard("not a url"), "invalid url: not a url")
        XCTAssertEqual(ssrfGuard("file:///etc/passwd"), "only http(s) urls are allowed")
        XCTAssertEqual(ssrfGuard("ftp://example.com/x"), "only http(s) urls are allowed")
        XCTAssertEqual(ssrfGuard("javascript:alert(1)"), "only http(s) urls are allowed")
        XCTAssertEqual(ssrfGuard("data:text/plain,hi"), "only http(s) urls are allowed")
    }

    /// Disclosed micro-divergence: `new URL("http://")` THROWS in JS, while `Foundation.URL` parses
    /// it with no host. An http(s) url with no host is unfetchable either way, so it is folded into
    /// the same `invalid url` refusal JS produces — fail-closed, and the same outcome for the caller.
    func testHttpWithNoHostIsInvalid() {
        XCTAssertEqual(ssrfGuard("http://"), "invalid url: http://")
    }

    // MARK: local names

    func testLocalNames() {
        assertRefused("http://localhost/x", local)
        assertRefused("http://LOCALHOST/x", local)
        assertRefused("http://localhost./x", local)
        assertRefused("http://printer.local/x", local)
        assertRefused("http://0.0.0.0/x", local)
        assertAllowed("https://notlocalhost.com/x")
        assertAllowed("https://mylocal.com/x")
        assertAllowed("https://local.example.com/x")
    }

    // MARK: IPv4 private table

    func testIpv4PrivateTable() {
        for host in ["127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "0.1.2.3",
                     "172.16.0.1", "172.31.255.255", "172.20.10.1",
                     "192.168.1.1", "169.254.169.254"] {
            assertRefused("http://\(host)/x", priv)
        }
    }

    func testIpv4PublicNeighboursOfTheTable() {
        for host in ["172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1",
                     "169.253.0.1", "169.255.0.1", "11.0.0.1", "126.0.0.1", "128.0.0.1"] {
            assertAllowed("http://\(host)/x")
        }
    }

    /// The trailing dot is the DNS root label — the same address, and the textbook bypass.
    func testTrailingDotIsStrippedBeforeTheIpv4Check() {
        assertRefused("http://10.0.0.1./x", priv)
        assertRefused("http://192.168.1.1./x", priv)
    }

    // MARK: IPv6 loopback / unspecified

    func testIpv6LoopbackAndUnspecified() {
        assertRefused("http://[::1]/x", local)
        assertRefused("http://[::]/x", local)
        assertRefused("http://[0:0:0:0:0:0:0:0]/x", local)
        assertRefused("http://[0000:0000:0000:0000:0000:0000:0000:0000]/x", local)
    }

    /// The textbook v4-blocklist bypass: the SAME 32-bit address spelled as IPv6, in both the dotted
    /// and the canonical hex form `URL` normalisation actually produces.
    func testIpv4MappedIpv6GoesThroughTheSameTable() {
        assertRefused("http://[::ffff:10.0.0.1]/x", priv)
        assertRefused("http://[::ffff:127.0.0.1]/x", priv)
        assertRefused("http://[::ffff:192.168.1.1]/x", priv)
        assertRefused("http://[::ffff:169.254.169.254]/x", priv)
        assertRefused("http://[::ffff:a00:1]/x", priv)   // 10.0.0.1 in hex
        assertRefused("http://[::ffff:7f00:1]/x", priv)  // 127.0.0.1 in hex
        assertRefused("http://[::ffff:c0a8:101]/x", priv) // 192.168.1.1 in hex
        assertAllowed("http://[::ffff:8.8.8.8]/x")
        assertAllowed("http://[::ffff:808:808]/x")
    }

    // MARK: IPv6 ULA + link-local, gated on being a real literal

    func testIpv6UniqueLocalAndLinkLocalLiterals() {
        for host in ["fc00::1", "fd00::1", "fdab:cdef::1", "fe80::1", "fe90::1", "fea0::1",
                     "feb0::1", "febf::1"] {
            assertRefused("http://[\(host)]/x", priv)
        }
    }

    func testIpv6PublicNeighbours() {
        for host in ["fe7f::1", "fec0::1", "2001:db8::1", "fb00::1"] {
            assertAllowed("http://[\(host)]/x")
        }
    }

    /// The `wasIpv6Literal` gate: a DOMAIN merely starting with `fc`/`fd`/`fe` must stay public. A
    /// bare string-prefix check would wrongly refuse all of these.
    func testDomainsThatMerelyStartLikeIpv6PrefixesStayPublic() {
        for host in ["fcc.gov", "fdic.gov", "fc-barcelona.com", "fear.com", "fe80.example.com"] {
            assertAllowed("https://\(host)/x")
        }
    }

    // MARK: NON-CANONICAL spellings (fix round 2, CRITICAL)

    /// Every one of these is a spelling of a private address that the first version of this guard
    /// ALLOWED, because it string-matched a host `Foundation.URL` never canonicalizes. WHATWG's
    /// `new URL()` rewrites them all to dotted-quad before the TS's checks run; Foundation does not.
    /// The reviewer confirmed each against Darwin's own resolver — these are addresses the phone
    /// would really have dialled.
    func testIntegerHexOctalAndPartialDotSpellingsAreRefused() {
        let cases: [(String, String)] = [
            ("3232235777", priv),      // 192.168.1.1 — the router
            ("2852039166", priv),      // 169.254.169.254 — cloud metadata
            ("0xc0a80101", priv),      // 192.168.1.1
            ("192.168.257", priv),     // 192.168.1.1
            ("0300.0250.0.1", priv),   // 192.168.0.1 (octal)
            ("2130706433", priv),      // 127.0.0.1
            ("0x7f000001", priv),      // 127.0.0.1
            ("0x7f.0.0.1", priv),      // 127.0.0.1
            ("127.1", priv),           // 127.0.0.1
            ("127.0.1", priv),         // 127.0.0.1
            ("0", local),              // 0.0.0.0 — WHATWG canonicalizes to the local-names branch
        ]
        for (host, expected) in cases {
            assertRefused("http://\(host)/", expected)
        }
    }

    /// Uncompressed / partially-compressed spellings WHATWG would have compressed first.
    func testNonCanonicalIpv6SpellingsAreRefused() {
        let cases: [(String, String)] = [
            ("0::1", local),                    // ::1
            ("::0:0:1", local),                 // ::1
            ("0:0:0:0:0:0:0:1", local),         // ::1
            ("0:0:0:0:0:ffff:7f00:1", priv),    // ::ffff:127.0.0.1 — mapped, so the IPv4 table applies
            ("::ffff:c0a8:101", priv),          // ::ffff:192.168.1.1
        ]
        for (host, expected) in cases {
            assertRefused("http://[\(host)]/x", expected)
        }
    }

    /// A zone id must not be able to disguise a link-local address — the resolver honours scopes.
    func testZoneIdDoesNotDisguiseLinkLocal() {
        assertRefused("http://[fe80::1%25en0]/x", priv)
    }

    /// The two IPv4 readings disagree here, and each row is private under exactly ONE of them.
    /// Consulting both is what makes the guard fail closed; consulting either alone fails open on
    /// one of these.
    func testBothIpv4ReadingsAreConsulted() {
        assertRefused("http://010.0.0.1/", priv)  // decimal 10.0.0.1 (what getaddrinfo dials); inet_aton says 8.0.0.1
        assertRefused("http://0177.0.0.1/", priv) // inet_aton 127.0.0.1; decimal says 177.0.0.1
    }

    /// The parse must not over-block: these are public under BOTH readings.
    func testNonCanonicalPublicSpellingsStayAllowed() {
        for host in ["16843009", "0x08080808", "8.8.8.8", "134744072", "1.1", "223.255.255.255"] {
            assertAllowed("http://\(host)/x")
        }
    }

    /// Ordinary names are not addresses and fall through to DNS, untouched by any of the numeric
    /// machinery.
    func testNameHostsFallThroughToTheNameChecks() {
        for host in ["example.com", "notanaddress", "8.8.8.8.nip.io", "2021.example.com",
                     "08.example.com"] {
            assertAllowed("http://\(host)/x")
        }
    }

    /// WHATWG refuses a host whose LAST label looks numeric but does not parse as IPv4 — it never
    /// lets one fall through to DNS. Foundation happily treats every one of these as a name, so the
    /// rule has to be ported explicitly or the two engines disagree.
    func testNumericLookingHostsThatAreNotAddressesAreInvalid() {
        for host in ["999.999.999.999", "1.2.3.4.5", "1..2",
                     "12345678901234567890",  // overflows 32 bits — `inet_aton` would WRAP to 235.31.10.210
                     "4294967296",            // 2^32 exactly — `inet_aton` would WRAP to 0.0.0.0
                     "0x1c0a80101"] {         // 2^32 + 192.168.1.1 — `inet_aton` would WRAP to the router
            XCTAssertEqual(ssrfGuard("http://\(host)/x"), "invalid url: http://\(host)/x",
                           "expected an invalid-url refusal for \(host)")
        }
    }

    /// WHATWG reads a bare `0x` as zero, so the host is `0.0.0.0`.
    func testBareHexPrefixIsZero() {
        assertRefused("http://0x/x", local)
    }

    /// Digits outside the radix a leading `0` implies make the whole URL invalid in WHATWG, even
    /// though the decimal reading would be a perfectly ordinary public address.
    func testLeadingZeroWithNonOctalDigitsIsInvalid() {
        for host in ["08.8.8.8", "0128.0.0.1", "0192.167.1.1"] {
            XCTAssertEqual(ssrfGuard("http://\(host)/x"), "invalid url: http://\(host)/x")
        }
    }

    // MARK: ordinary public hosts

    func testOrdinaryPublicHostsAreAllowed() {
        for url in ["https://example.com/x", "http://docs.rs/", "https://8.8.8.8/",
                    "https://example.com:8443/x", "https://sub.domain.example.co.uk/a/b?c=d#e"] {
            assertAllowed(url)
        }
    }
}
