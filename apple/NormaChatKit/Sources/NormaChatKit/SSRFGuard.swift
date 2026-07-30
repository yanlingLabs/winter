import Darwin
import Foundation

/// Swift port of `packages/core/src/agent/tools/web.ts`'s `ssrfGuard` (`web.ts:23-91`) — the
/// literal-address refusal that stands between a model-chosen URL and the machine's own network
/// neighbourhood.
///
/// This matters MORE on the phone than on the Mac, which is why it is here at all: a phone sits on
/// the user's LAN, so `http://192.168.1.1/admin`, `http://169.254.169.254/` (the cloud metadata
/// address) and `http://printer.local/` are all one prompt-injected instruction away. Chat mode has
/// no approval flow to catch that, by user design, so the floor has to be structural.
///
/// LITERAL-ONLY, NO DNS — deliberately, matching the TS. `web.ts:34-36` records DNS-rebinding as an
/// explicit v1 out-of-scope posture; resolving names here would be a behaviour divergence from the
/// Mac, not an improvement to parity, and would put a network round-trip inside a pure function.
///
/// Every refusal string below is byte-identical to the TS. They surface in audit lines and in the
/// model's transcript, and a phone that phrases a refusal differently from the Mac is a difference
/// we did not choose to have.
///
/// ## Why this PARSES addresses instead of string-matching them (fix round 2, CRITICAL)
///
/// The TS's checks are STRING comparisons (`h === "127.0.0.1"`, a dotted-quad regex), and they are
/// correct there only because WHATWG's `new URL()` runs a **host canonicalizer** first: it rewrites
/// `2130706433`, `0x7f000001`, `127.1` and `192.168.257` into dotted-quad form, and compresses
/// `0:0:0:0:0:ffff:7f00:1` into `::ffff:7f00:1`, before `ssrfGuard` ever sees the host.
/// `Foundation.URL` canonicalizes NOTHING. The first version of this port transcribed the string
/// checks without the parser underneath them — it ported the spelling, not the behaviour — and
/// `http://3232235777/` (192.168.1.1, the router) and `http://2852039166/` (169.254.169.254, the
/// cloud metadata address) sailed straight through.
///
/// So: parse the host to BITS and range-check numerically. The guard's job is to refuse what the
/// device will actually dial; TS parity is the means, not the end.
///
/// ### The two IPv4 interpretations, and why BOTH are consulted
///
/// `inet_aton` and `getaddrinfo` — the resolver URLSession actually dials — disagree, and neither is
/// a superset of the other. Measured on this machine:
///
///     host             inet_aton      getaddrinfo    private?
///     0300.0250.0.1    192.168.0.1    192.168.0.1    yes  (octal; both agree)
///     0xc0a80101       192.168.1.1    192.168.1.1    yes  (hex; both agree)
///     010.0.0.1        8.0.0.1        10.0.0.1       yes — ONLY under getaddrinfo
///     0177.0.0.1       127.0.0.1      177.0.0.1      yes — ONLY under inet_aton
///
/// `getaddrinfo` prefers a DECIMAL reading whenever it is in range (`010` → 10) and falls back to
/// octal only when decimal would overflow an octet (`0300` → 192); `inet_aton` always takes the C
/// convention (`010` → 8). A guard consulting either one alone fails OPEN on one of those two rows,
/// so `ipv4Interpretations` returns both and ANY private reading refuses. That is fail-closed by
/// construction and costs nothing: a genuinely public address is public under both readings.
///
/// The `010.0.0.1` row also makes this guard deliberately STRICTER than the Mac, which follows
/// WHATWG's octal reading and allows it. Darwin resolves that host to 10.0.0.1, so the Mac is the
/// one that is wrong — worth back-porting rather than relaxing here.

// MARK: - refusal tables

private let localRefusal = "refusing to fetch a local address"
private let privateRefusal = "refusing to fetch a private address"

/// The private/loopback/link-local IPv4 table, keyed on the first two octets — the direct port of
/// the TS's `ipv4Refusal`. Shared by literal IPv4 hosts AND by IPv4-mapped IPv6 addresses, which
/// resolve to the exact same 32 bits and must not evade the check by being spelled as IPv6.
private func ipv4TableRefusal(_ a: Int, _ b: Int) -> String? {
    if a == 127 || a == 10 || a == 0
        || (a == 172 && b >= 16 && b <= 31)
        || (a == 192 && b == 168)
        || (a == 169 && b == 254) {
        return privateRefusal
    }
    return nil
}

/// A bare IPv4 HOST. `0.0.0.0` is reported as *local* rather than *private* because the TS checks
/// `h === "0.0.0.0"` in its local-names branch, ahead of the numeric table — and WHATWG canonicalizes
/// `http://0/` to exactly that host, so the distinction is reachable from a non-canonical spelling
/// too.
private func ipv4HostRefusal(_ bits: UInt32) -> String? {
    if bits == 0 { return localRefusal }
    return ipv4TableRefusal(Int(bits >> 24), Int((bits >> 16) & 0xFF))
}

/// An IPv4 address arriving as the tail of an IPv4-mapped IPv6 address. Deliberately NOT
/// `ipv4HostRefusal`: the TS reaches these through its `::ffff:` branches, which call the numeric
/// table directly, so `::ffff:0.0.0.0` is *private* (first octet 0) and not *local*.
private func ipv4MappedRefusal(_ bits: UInt32) -> String? {
    ipv4TableRefusal(Int(bits >> 24), Int((bits >> 16) & 0xFF))
}

// MARK: - address parsing

/// Every 32-bit address this host string could denote to something that will dial it. Empty when the
/// host is not an IPv4 literal under any reading. See the header for why there are two readings.
func ipv4Interpretations(_ host: String) -> [UInt32] {
    var found: [UInt32] = []
    for policy in [RadixPolicy.cConvention, .decimalOnly] {
        if let bits = dottedIPv4(host, policy), !found.contains(bits) { found.append(bits) }
    }
    return found
}

private enum RadixPolicy {
    /// `inet_aton`/WHATWG: `0x…` hex, a leading `0` octal, otherwise decimal.
    case cConvention
    /// Every part decimal regardless of a leading zero — what `getaddrinfo` prefers in range.
    case decimalOnly
}

/// `inet_aton`'s grammar, parsed exactly: 1-4 parts with the classic widening (`a` / `a.b` /
/// `a.b.c` / `a.b.c.d`), every part but the last capped at a byte and the last filling the rest.
///
/// Hand-written rather than delegating to the real `inet_aton` — which was the first version here —
/// because **Darwin's `inet_aton` silently WRAPS on overflow instead of failing.** Measured:
/// `4294967296` → 0.0.0.0, `18446744073709551616` → 0.0.0.0, `12345678901234567890` →
/// 235.31.10.210, `0x1c0a80101` (2³² + 0xc0a80101) → 192.168.1.1. A wrapped value is
/// indistinguishable from a real parse, which both defeats `looksNumericButIsNotAnAddress` (an
/// overflowing host looks like a valid address) and invents addresses the string never denoted. All
/// of those wraps happen to land fail-CLOSED today, but that is luck, not a property — so the
/// arithmetic is done in `UInt64` with explicit width checks and overflow simply fails the parse.
private func dottedIPv4(_ host: String, _ policy: RadixPolicy) -> UInt32? {
    let parts = host.components(separatedBy: ".")
    guard (1 ... 4).contains(parts.count) else { return nil }

    var values: [UInt64] = []
    for part in parts {
        guard let value = parsePart(part, policy) else { return nil }
        values.append(value)
    }

    let tailBits = (5 - values.count) * 8 // 1 part → 32, 2 → 24, 3 → 16, 4 → 8
    guard let tail = values.last, tail < (UInt64(1) << tailBits) else { return nil }
    var bits: UInt64 = tail
    for (index, value) in values.dropLast().enumerated() {
        guard value <= 255 else { return nil }
        bits |= value << (32 - 8 * (index + 1))
    }
    return UInt32(bits) // width checks above already bound this to 32 bits
}

/// One dotted part. ASCII digits only — `Character.isNumber` alone would accept e.g. Arabic-Indic
/// digits, the same JS-`\d`-vs-ICU-`\d` discipline the rest of this port uses. `UInt64` parsing
/// fails (rather than wraps) past its range, which is exactly the overflow signal this needs.
private func parsePart(_ part: String, _ policy: RadixPolicy) -> UInt64? {
    guard !part.isEmpty else { return nil }
    guard part.allSatisfy({ $0.isASCII }) else { return nil }

    if policy == .cConvention {
        if part.hasPrefix("0x") || part.hasPrefix("0X") {
            let digits = part.dropFirst(2)
            if digits.isEmpty { return 0 } // WHATWG reads a bare `0x` as zero
            guard digits.allSatisfy({ $0.isHexDigit }) else { return nil }
            return UInt64(digits, radix: 16)
        }
        if part.hasPrefix("0"), part.count > 1 {
            let digits = part.dropFirst()
            guard digits.allSatisfy({ ("0" ... "7").contains($0) }) else { return nil }
            return UInt64(digits, radix: 8)
        }
    }
    guard part.allSatisfy({ $0.isNumber }) else { return nil }
    return UInt64(part)
}

/// WHATWG's IPv4 parser reads a `0`-prefixed part as OCTAL and treats an out-of-radix digit as a
/// hard parse failure, so `new URL("http://08.8.8.8/")` throws and the TS reports `invalid url`.
/// Foundation parses the host happily, and both of this port's numeric readings decline it
/// (`inet_aton` stops at the bad digit; the decimal reader has no radix objection but 8.8.8.8 is
/// public), so without this the two engines disagree on 38 host spellings.
///
/// Deliberately NARROW — an all-digit dotted host with a `0`-prefixed part containing `8` or `9`,
/// and nothing else. This is not a reimplementation of WHATWG's host parser (that would be a much
/// larger surface to get wrong); it closes exactly the divergence class the differential found, in
/// the fail-CLOSED direction, and the differential is what proves it closes that class and no other.
/// `08.example.com` is untouched, because not every part is digits.
private func hasInvalidOctalOctet(_ host: String) -> Bool {
    let parts = host.components(separatedBy: ".")
    guard (1 ... 4).contains(parts.count) else { return false }
    guard parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }) else { return false }
    return parts.contains { $0.hasPrefix("0") && $0.count > 1 && ($0.contains("8") || $0.contains("9")) }
}

/// WHATWG's other host-parser rule that Foundation lacks: if a host's LAST label looks numeric, the
/// host must parse as IPv4 or the URL is invalid — it is never allowed to fall through to DNS.
/// That is what makes `new URL()` throw on `999.999.999.999`, `1.2.3.4.5`, `12345678901234567890`
/// and `1..2`, all of which Foundation parses as ordinary names.
///
/// Fail-closed and worth having independently of parity: a host that looks like an address but is
/// not one has no legitimate use, and refusing it keeps it out of the resolver entirely. Only the
/// LAST label is consulted, exactly as the spec has it, so `8.8.8.8.nip.io` and `2021.example.com`
/// are untouched.
private func looksNumericButIsNotAnAddress(_ host: String) -> Bool {
    guard let last = host.components(separatedBy: ".").last else { return false }
    let isDigits = !last.isEmpty && last.allSatisfy { $0.isASCII && $0.isNumber }
    let isHex = (last.hasPrefix("0x") || last.hasPrefix("0X"))
        && last.dropFirst(2).allSatisfy { $0.isHexDigit && $0.isASCII }
    guard isDigits || isHex else { return false }
    return ipv4Interpretations(host).isEmpty
}

/// The 16 bytes of an IPv6 literal, or `nil` when the host is not one. A zone id (`%en0`) is
/// stripped first: the resolver honours scoped link-local addresses, so the guard has to see through
/// the suffix rather than let it disguise `fe80::1`.
func ipv6Bytes(_ host: String) -> [UInt8]? {
    let bare = host.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false)
        .first.map(String.init) ?? host
    var buffer = [UInt8](repeating: 0, count: 16)
    guard inet_pton(AF_INET6, bare, &buffer) == 1 else { return nil }
    return buffer
}

/// Numeric range checks over the parsed 16 bytes.
///
/// This is what structurally retires the old `wasIpv6Literal` gate: a host that merely LOOKS like an
/// IPv6 prefix (`fcc.gov`, `fdic.gov`, `fear.com`) simply fails `inet_pton` and never reaches these
/// lines, so the over-blocking class is impossible rather than conditionally avoided.
private func ipv6Refusal(_ bytes: [UInt8]) -> String? {
    if bytes.allSatisfy({ $0 == 0 }) { return localRefusal } // ::
    if bytes[0 ..< 15].allSatisfy({ $0 == 0 }), bytes[15] == 1 { return localRefusal } // ::1

    // IPv4-mapped (`::ffff:a.b.c.d`) — bytes 0-9 zero, 10-11 all ones — is a real IPv4 address and
    // must go through the same table. The textbook v4-blocklist bypass.
    if bytes[0 ..< 10].allSatisfy({ $0 == 0 }), bytes[10] == 0xFF, bytes[11] == 0xFF {
        let mapped = UInt32(bytes[12]) << 24 | UInt32(bytes[13]) << 16
            | UInt32(bytes[14]) << 8 | UInt32(bytes[15])
        if let refusal = ipv4MappedRefusal(mapped) { return refusal }
    }

    if bytes[0] & 0xFE == 0xFC { return privateRefusal } // fc00::/7
    if bytes[0] == 0xFE, bytes[1] & 0xC0 == 0x80 { return privateRefusal } // fe80::/10
    return nil
}

// MARK: - the guard

/// Returns a refusal message, or `nil` when the URL may be fetched.
func ssrfGuard(_ raw: String) -> String? {
    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else {
        return "invalid url: \(raw)"
    }
    guard scheme == "http" || scheme == "https" else { return "only http(s) urls are allowed" }

    // DISCLOSED MICRO-DIVERGENCE: `new URL("http://")` throws in JS (→ `invalid url`), while
    // `Foundation.URL` happily parses it with no host. An http(s) URL with no host is unfetchable
    // either way, so folding it into the same refusal is both fail-closed and the same outcome the
    // caller would have got. (JS does accept the exotic `http:///x`, which we refuse; its own fetch
    // fails immediately too.)
    guard var host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else {
        return "invalid url: \(raw)"
    }

    // A single trailing dot is just the DNS root label: `localhost.` and `10.0.0.1.` are the SAME
    // addresses as their dot-less forms but would defeat every check below. Strip exactly one.
    if host.hasSuffix(".") { host.removeLast() }

    // `Foundation.URL.host` strips the brackets an IPv6 literal arrives in (JS's `URL.hostname`
    // keeps them), so unwrap defensively rather than depending on either behaviour.
    if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }

    // Names, not addresses — the one branch that stays a string comparison, because there is
    // nothing to parse.
    if host == "localhost" || host.hasSuffix(".local") { return localRefusal }

    // IPv6 literals are resolved FIRST and completely: an IPv6 host is unambiguously an address, so
    // neither of the IPv4 spelling rules below may look at it. (They would: `::ffff:1.1.1.1` splits
    // on "." to a last label of `1`, which reads as "numeric-looking" and would be wrongly rejected.)
    if let bytes = ipv6Bytes(host) { return ipv6Refusal(bytes) }

    // ANY reading that lands in private space refuses.
    for bits in ipv4Interpretations(host) {
        if let refusal = ipv4HostRefusal(bits) { return refusal }
    }

    // Spelling rules WHATWG applies and Foundation does not — see each helper. Both are fail-closed
    // and both run only after the address readings above have had their say, so they can never mask
    // a private-address refusal with a weaker "invalid url".
    if hasInvalidOctalOctet(host) || looksNumericButIsNotAnAddress(host) {
        return "invalid url: \(raw)"
    }

    return nil
}
