import Foundation

/// PRIVATE / LOOPBACK / LINK-LOCAL CLASSIFICATION for `WebFetch` — the Swift port of the agent SDK's
/// `packages/runtime/src/web/private-address.ts`, built on the address PARSERS `SSRFGuard.swift`
/// already carries (`ipv4Interpretations`, `ipv6Bytes`) rather than a second copy of them.
///
/// WHY IT IS NOT `ssrfGuard` ITSELF. `ssrfGuard` is a byte-for-byte mirror of the daemon's own
/// `web.ts` guard, refusal strings included, and two things about the SDK's classification differ
/// from it: `100.64.0.0/10` (RFC 6598 CGNAT) is private HERE and deliberately absent THERE, and the
/// reserved-name rule is `localhost`/`*.localhost`/`local`/`*.local` here against
/// `localhost`/`*.local` there. Folding either into `ipv4TableRefusal`/`ssrfGuard` would change what
/// the daemon-mirroring guard answers, which is the one thing that file exists not to do. So the
/// ranges are re-asserted here, over the same parsers, and `ssrfGuard` stays untouched.
///
/// LEXICAL ONLY — NO DNS, and this is a DISCLOSED divergence from the SDK. The SDK resolves the
/// hostname once per hop and PINS the connection to the address it classified (`Host` + TLS SNI
/// carry the logical name), which closes the DNS-rebinding TOCTOU. `URLSession` offers no way to
/// connect to an address while presenting another name, so the phone cannot pin, and resolving
/// without pinning would buy a second, unpinned query an attacker's rebinding answer can win — a
/// false sense of a guarantee rather than the guarantee. The posture is therefore the same one the
/// daemon's own `ssrfGuard` states for itself (`web.ts`: rebinding is explicitly out of scope for
/// v1): a host that is private BY HOW IT IS WRITTEN is refused, a public-looking name that resolves
/// into private space is not caught. Two consequences for the ported texts, both noted at their use
/// sites: the SDK's "late case" refusal (private by RESOLUTION only) and its
/// `could not resolve any address for <host>` sentence are unreachable here.
enum PrivateAddress {
    /// One classified fact about a target. `reason` is the class name, safe to show the model.
    struct Finding: Equatable, Sendable {
        enum Class: String, Sendable { case publicAddress, privateAddress }
        let addressClass: Class
        let reason: String

        var isPrivate: Bool { addressClass == .privateAddress }
    }

    /// The LEXICAL verdict for `host` as written in the URL: an IP literal classified by range, or a
    /// reserved name. `nil` means "not lexically decidable" — an ordinary DNS name, which on this
    /// engine is simply treated as public (see the type header).
    ///
    /// `host` is the bare hostname (no brackets, no trailing root dot) — `WebFetchURL.bareHost`
    /// produces exactly that from a `URL`.
    static func classifyLexically(_ host: String) -> Finding? {
        if let ipv6 = ipv6Bytes(host), let finding = classifyIPv6(ipv6) { return finding }
        // ANY reading that lands in private space refuses — the same fail-closed union `ssrfGuard`
        // applies, for the same measured reason (`inet_aton` and `getaddrinfo` disagree and neither
        // is a superset of the other).
        for bits in ipv4Interpretations(host) {
            if let finding = classifyIPv4(bits) { return finding }
        }
        if let reserved = classifyReservedName(host) { return reserved }
        // An IP literal that is not private is decidable and public; anything else is a DNS name.
        if ipv6Bytes(host) != nil || !ipv4Interpretations(host).isEmpty {
            return Finding(addressClass: .publicAddress, reason: "public")
        }
        return nil
    }

    /// True when the host is private BY HOW IT IS WRITTEN — the question the SDK's own
    /// `classifyHostnameLexically(...)?.class === "private"` asks at three separate decision points.
    static func isLexicallyPrivate(_ host: String) -> Bool {
        classifyLexically(host)?.isPrivate == true
    }

    /// Reserved names RFC 6761 (`localhost`) and mDNS (`.local`) carve out — private by NAME, whatever
    /// they resolve to. A single trailing dot (the DNS root) is stripped first so it cannot defeat the
    /// check. Widened over `ssrfGuard`'s pair to the SDK's four forms: `*.localhost` and a bare
    /// `local` are private too (`app.localhost` is the phone-relevant one — a real, reachable name).
    static func classifyReservedName(_ host: String) -> Finding? {
        var h = host.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        if h == "localhost" || h.hasSuffix(".localhost") {
            return Finding(addressClass: .privateAddress, reason: "the localhost TLD (RFC 6761)")
        }
        if h == "local" || h.hasSuffix(".local") {
            return Finding(addressClass: .privateAddress, reason: "the .local mDNS TLD")
        }
        return nil
    }

    // MARK: - ranges

    /// The classes the SDK treats as private: loopback (127/8), private (10/8, 172.16/12, 192.168/16),
    /// link-local (169.254/16), unspecified (0/8) — all four already in `ipv4TableRefusal` — plus
    /// **cgnat** (100.64.0.0/10), which that table deliberately does not carry.
    private static func classifyIPv4(_ bits: UInt32) -> Finding? {
        let a = Int(bits >> 24)
        let b = Int((bits >> 16) & 0xFF)
        if ipv4TableRefusal(a, b) != nil {
            return Finding(addressClass: .privateAddress, reason: ipv4ClassName(a, b))
        }
        if a == 100, b >= 64, b <= 127 {
            return Finding(addressClass: .privateAddress, reason: "cgnat")
        }
        return nil
    }

    private static func ipv4ClassName(_ a: Int, _ b: Int) -> String {
        if a == 127 { return "loopback" }
        if a == 0 { return "unspecified" }
        if a == 169, b == 254 { return "link-local" }
        return "private"
    }

    private static func classifyIPv6(_ bytes: [UInt8]) -> Finding? {
        if bytes.allSatisfy({ $0 == 0 }) { return Finding(addressClass: .privateAddress, reason: "unspecified") }
        if bytes[0 ..< 15].allSatisfy({ $0 == 0 }), bytes[15] == 1 {
            return Finding(addressClass: .privateAddress, reason: "loopback")
        }
        // IPv4-MAPPED (`::ffff:a.b.c.d`) IS the IPv4 address it carries — a socket opened to it reaches
        // the same host, so it goes through the same table. The textbook v4-blocklist bypass.
        if bytes[0 ..< 10].allSatisfy({ $0 == 0 }), bytes[10] == 0xFF, bytes[11] == 0xFF {
            let mapped = UInt32(bytes[12]) << 24 | UInt32(bytes[13]) << 16
                | UInt32(bytes[14]) << 8 | UInt32(bytes[15])
            if let finding = classifyIPv4(mapped) { return finding }
        }
        if bytes[0] & 0xFE == 0xFC { return Finding(addressClass: .privateAddress, reason: "unique-local") }
        if bytes[0] == 0xFE, bytes[1] & 0xC0 == 0x80 { return Finding(addressClass: .privateAddress, reason: "link-local") }
        return nil
    }
}
