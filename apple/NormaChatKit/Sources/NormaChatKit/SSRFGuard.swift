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

/// The private/loopback/link-local IPv4 table, keyed on the first two octets — shared by literal
/// IPv4 hosts AND by IPv4-mapped IPv6 addresses, which resolve to the exact same 32 bits and must
/// not evade the check merely by being spelled as IPv6.
private func ipv4Refusal(_ a: Int, _ b: Int) -> String? {
    if a == 127 || a == 10 || a == 0
        || (a == 172 && b >= 16 && b <= 31)
        || (a == 192 && b == 168)
        || (a == 169 && b == 254) {
        return "refusing to fetch a private address"
    }
    return nil
}

/// JS `\d` is `[0-9]`; ICU's `\d` is `\p{Nd}` and would also match e.g. Arabic-Indic digits. Spelled
/// out for the same reason every other class in this port is (see `HtmlToText.swift`'s header).
private let ipv4Pattern = try! NSRegularExpression(pattern: "^([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.([0-9]+)$")
private let mappedDottedPattern = try! NSRegularExpression(pattern: "^::ffff:([0-9]+)\\.([0-9]+)\\.([0-9]+)\\.([0-9]+)$")
private let mappedHexPattern = try! NSRegularExpression(pattern: "^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$")

private func captures(_ re: NSRegularExpression, _ s: String) -> [String]? {
    let range = NSRange(location: 0, length: s.utf16.count)
    guard let m = re.firstMatch(in: s, options: [], range: range) else { return nil }
    let ns = s as NSString
    return (1 ..< m.numberOfRanges).map { i in
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : ns.substring(with: r)
    }
}

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

    // Remember whether this was an IPv6 LITERAL before unwrapping, so the ULA/link-local prefix
    // checks at the bottom apply only to real literals and never to a domain that merely starts with
    // "fc"/"fd"/"fe80" (fcc.gov, fdic.gov, fear.com …).
    //
    // The TS reads `URL.hostname`, which always brackets IPv6. `Foundation.URL.host` strips the
    // brackets (verified), so the bracket test alone would never fire — hence the `contains(":")`
    // arm, which is exact: a DNS name can never contain a colon.
    let wasBracketed = host.hasPrefix("[") && host.hasSuffix("]")
    if wasBracketed { host = String(host.dropFirst().dropLast()) }
    let wasIpv6Literal = wasBracketed || host.contains(":")

    if host == "localhost" || host.hasSuffix(".local") || host == "0.0.0.0" {
        return "refusing to fetch a local address"
    }

    if let g = captures(ipv4Pattern, host),
       let refusal = ipv4Refusal(Int(g[0]) ?? -1, Int(g[1]) ?? -1) {
        return refusal
    }

    // IPv6 loopback / unspecified, in any spelling (`::1`, `::`, `0:0:…:0`).
    if host == "::1" || host == "::" {
        return "refusing to fetch a local address"
    }
    if host.contains(":") {
        let groups = host.components(separatedBy: ":")
        if groups.allSatisfy({ $0.isEmpty || $0.allSatisfy { $0 == "0" } }) {
            return "refusing to fetch a local address"
        }
    }

    // IPv4-mapped IPv6 — the textbook v4-blocklist bypass — in both the dotted spelling and the
    // canonical hex form URL normalisation actually produces.
    if let g = captures(mappedDottedPattern, host),
       let refusal = ipv4Refusal(Int(g[0]) ?? -1, Int(g[1]) ?? -1) {
        return refusal
    }
    if let g = captures(mappedHexPattern, host), let g1 = Int(g[0], radix: 16),
       let refusal = ipv4Refusal((g1 >> 8) & 0xFF, g1 & 0xFF) {
        return refusal
    }

    if wasIpv6Literal {
        // fc00::/7 (top 7 bits fixed) is exactly the "fc"/"fd" hex-nibble prefixes. fe80::/10 is
        // NOT a whole-nibble prefix — the first hextet ranges over 0xfe80…0xfebf — so a bare
        // `hasPrefix("fe80")` misses fe90::/fea0::/feb0::. Range-check the hextet numerically.
        if host.hasPrefix("fc") || host.hasPrefix("fd") {
            return "refusing to fetch a private address"
        }
        if let firstHextet = Int(host.components(separatedBy: ":")[0], radix: 16),
           firstHextet >= 0xFE80, firstHextet <= 0xFEBF {
            return "refusing to fetch a private address"
        }
    }

    return nil
}
