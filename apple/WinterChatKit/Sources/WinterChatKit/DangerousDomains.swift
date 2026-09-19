import Foundation

/// Swift mirror of `packages/core/src/agent/dangerous-domains.ts` — the hard-block floor chat mode
/// keeps under every page fetch, on the phone exactly as on the Mac.
///
/// USER DECISION (whole-branch review, 2026-07-28): "chat mode shouldn't have a plan mode, it simply
/// wouldn't ever ask permissions. The dangerous urls… would just simply be blocked straight up
/// before the fetch." So this is a HARD refusal with no card and no in-chat override — the one
/// escape hatch is editing the user-added half of the list.
///
/// Every entry is a domain whose entire business model is "accept arbitrary bytes from anyone, no
/// auth, and make them reachable again" (paste hosts), "accept an arbitrary file upload, no auth"
/// (one-shot file hosts), "log every byte of every request sent to a URL you control" (request
/// collectors), or "expose a local port to the public internet" (tunnel providers). Per-entry
/// rationale lives in the TS file and is not duplicated here — this is a MIRROR, and
/// `DangerousDomainsTests.testShippedListEqualsTheGeneratedFixture` is the drift tripwire against
/// `packages/protocol/generated/fixtures/dangerous-domains.json` (generated FROM the TS constant).
public enum DangerousDomains {
    /// Order is the fixture's order (family-grouped, exactly as the TS declares it). `matches` does
    /// not care about ordering; the equality test does.
    public static let shipped: [String] = [
        // --- paste hosts ---
        "pastebin.com",
        "paste.ee",
        "hastebin.com",
        "dpaste.org",
        "dpaste.com",
        "ix.io",
        "sprunge.us",
        "termbin.com",
        "rentry.co",
        "cl1p.net",
        "pastes.dev",
        // --- one-shot file hosts ---
        "transfer.sh",
        "transfer.archivete.am",
        "0x0.st",
        "x0.at",
        "file.io",
        "temp.sh",
        "gofile.io",
        "catbox.moe",
        "bashupload.com",
        // --- request/interaction collectors ---
        "webhook.site",
        "requestbin.com",
        "pipedream.net",
        "interactsh.com",
        "oastify.com",
        "burpcollaborator.net",
        "requestcatcher.com",
        // --- tunnel providers ---
        "ngrok.io",
        "ngrok-free.app",
        "ngrok.app",
        "serveo.net",
        "localhost.run",
        "telebit.io",
        "loca.lt",
        "bore.pub",
        "zrok.io",
        "webhookrelay.com",
        "pagekite.net",
    ]

    /// TS `dangerousDomainMatch`. `host` matches `entry` when they are equal, or when `host` ends
    /// with `.<entry>` — never a bare substring: `pastebin.com.evil.com` (entry as a PREFIX) and
    /// `evilpastebin.com` (no label boundary) must both MISS. Returns the matched LIST ENTRY, not
    /// the host: for a subdomain hit that is the broader parent domain, which is what a refusal
    /// should name.
    ///
    /// HIGH-1 (SP-approvals T10 review): exactly one trailing dot is stripped from `host` first.
    /// `pastebin.com.` is the same address as `pastebin.com` to DNS, and leaving it unstripped is
    /// the textbook trailing-dot bypass. Only the HOST side is normalized, matching the TS.
    public static func match(host: String, entries: [String]) -> String? {
        var h = host.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        guard !h.isEmpty else { return nil }
        for entry in entries {
            let e = entry.lowercased()
            if h == e || h.hasSuffix(".\(e)") { return entry }
        }
        return nil
    }

    /// TS `normalizeDangerousDomain` (2026-09-18, the web-tools floor on both legs). `match` above
    /// deliberately normalizes only the HOST side and only the trailing dot, because the daemon's
    /// `permission-rules.ts` caller must keep answering exactly what it always has. The runtime
    /// child's own `blockedDomains` matcher, though, ignores a leading `*.`/`.` and a trailing `.` on
    /// ENTRIES, and it URL-PARSES every entry — so `*.evil.example`, `https://evil.example`,
    /// `evil.example:8080`, `evil.example/admin` and `user@evil.example` are all things a user does in
    /// fact write into `settings.permissions.dangerousDomains.added`, and a host-side check on the raw
    /// string honoured none of them. Normalizing BOTH sides here closes that divergence without
    /// touching the shared matcher.
    ///
    /// NEVER throws: every caller is a per-entry loop in a security floor, and one malformed entry
    /// must not take the rest of the list with it. An unparseable value keeps its bare normalization.
    ///
    /// IDN: the value is returned in its ASCII (punycode) form, which is what every url's own
    /// `host` is already in — so a user who writes `пример.рф` while the url says
    /// `xn--e1afmkfd.xn--p1ai` still matches. Computed only when the value actually carries a
    /// non-ASCII character, so the common path pays nothing.
    public static func normalizeEntry(_ value: String) -> String {
        var v = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // REPEATED, not one: `_domains.ts`'s own `normalizeDomain` strips `/^(\*\.)+/`, so the runtime
        // child honours `*.*.evil.example` and a single `if` here would have left that entry matching
        // nothing at all. (The daemon's `normalizeDangerousDomain` strips one — see the report.)
        while v.hasPrefix("*.") { v = String(v.dropFirst(2)) }
        while v.hasPrefix(".") { v = String(v.dropFirst()) }
        if let host = hostnameOfUrlShaped(v) { v = host }
        while v.hasSuffix(".") { v = String(v.dropLast()) }
        return asciiDomain(v)
    }

    /// The hostname of a URL-SHAPED entry, or `nil` when the value is a plain domain (the common case,
    /// which pays nothing) or is unparseable.
    ///
    /// `//` is accepted as a scheme-relative form; a value with no scheme but with a `/`, `:` or `@`
    /// after the host is given one, because `evil.example:8080` alone parses `evil.example:` as a
    /// SCHEME and answers no host. A bracketed IPv6 authority keeps whatever `URL.host` answers.
    private static func hostnameOfUrlShaped(_ value: String) -> String? {
        let hasScheme = value.range(of: "^[a-z][a-z0-9+\\-.]*://", options: .regularExpression) != nil
            || value.hasPrefix("//")
        if !hasScheme, value.range(of: "[/:@]", options: .regularExpression) == nil { return nil }
        let candidate = hasScheme
            ? (value.hasPrefix("//") ? "http:\(value)" : value)
            : "http://\(value)"
        guard let host = URL(string: candidate)?.host(percentEncoded: false), !host.isEmpty else { return nil }
        return host.lowercased()
    }

    /// A domain in its ASCII (punycode) form. An unconvertible value is returned unchanged rather
    /// than dropped.
    private static func asciiDomain(_ domain: String) -> String {
        guard domain.unicodeScalars.contains(where: { !$0.isASCII }) else { return domain }
        guard let host = URL(string: "https://\(domain)")?.host(percentEncoded: false), !host.isEmpty else {
            return domain
        }
        return host.lowercased()
    }

    /// `match` for a HOST-OR-DOMAIN string, with BOTH sides normalized (`normalizeEntry`) — and with the
    /// runtime child's own TWO EXACT-ONLY rules, which the plain suffix grammar does not have
    /// (`_domains.ts`'s `hostMatchesDomain`, the matcher a Winter child actually applies to
    /// `blockedDomains`):
    ///
    ///   * **an IP literal never matches by suffix**, on either side. A suffix of an address is not a
    ///     parent of it: a typo'd `0.1` must not block `127.0.0.1`, and `127.0.0.1` must not be read as
    ///     a subdomain of `example.com`. (A value carrying a `:` counts as an IP literal here — that
    ///     covers both the bracketed and the bare IPv6 spellings, since `URL` hands back the bare one.)
    ///   * **a SINGLE-LABEL entry never matches by suffix.** As a suffix, one truncated or mistyped
    ///     `com` would silently block every `.com` there is; exactly, `localhost` still blocks
    ///     `localhost`.
    ///
    /// The shipped list is unaffected — all 38 entries are multi-label names and none is a dotted quad —
    /// so suffix matching still covers every subdomain of every one of them.
    ///
    /// Returns the matched list entry VERBATIM (not its normalized form), so a refusal names what the
    /// user or the shipped list actually wrote. Empty/unreadable input never matches.
    public static func hostMatch(host: String, entries: [String]) -> String? {
        let h = normalizeEntry(host)
        guard !h.isEmpty else { return nil }
        let hostIsLiteral = isIPLiteral(h)
        for entry in entries {
            let e = normalizeEntry(entry)
            guard !e.isEmpty else { continue }
            if hostIsLiteral || isIPLiteral(e) || !e.contains(".") {
                if h == e { return entry }
                continue
            }
            if match(host: h, entries: [e]) != nil { return entry }
        }
        return nil
    }

    /// `_domains.ts`'s `isIpLiteral`, widened by one case: a bracketed authority, a dotted quad, or
    /// anything carrying a `:` (a bare IPv6 address, which is the form `URL.host` answers and the form
    /// `normalizeEntry` leaves alone when the URL parser cannot read it).
    private static func isIPLiteral(_ value: String) -> Bool {
        if value.hasPrefix("[") || value.contains(":") { return true }
        return value.range(of: "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", options: .regularExpression) != nil
    }

    /// TS `checkDangerousDomain`, URL-typed. `extra` is the caller-resolved user-added half
    /// (`settings.permissions.dangerousDomains.added`) — this type never reads settings itself.
    ///
    /// A URL with no resolvable hostname returns `nil`: nothing dangerous can be said about a url
    /// with no host, and any fetch attempt fails on its own terms without reaching the network.
    public static func check(_ url: URL, extra: [String] = []) -> DangerousDomainHit? {
        guard let rawHost = url.host(percentEncoded: false), !rawHost.isEmpty else { return nil }
        let host = rawHost.lowercased()
        // `hostMatch`, not the bare `match`: a user-written `*.evil.example` or
        // `https://evil.example/admin` is honoured by the runtime child's own matcher, so it must be
        // honoured here too or the floor is weaker on the side that is the only enforcer.
        guard let entry = hostMatch(host: host, entries: shipped + extra) else { return nil }
        return DangerousDomainHit(host: normalizeEntry(host), matchedEntry: entry)
    }

    /// String-typed overload for a model-supplied url. An unparseable url returns `nil`, same as the
    /// TS (`new URL(...)` throwing).
    public static func check(_ rawURL: String, extra: [String] = []) -> DangerousDomainHit? {
        guard let url = URL(string: rawURL) else { return nil }
        return check(url, extra: extra)
    }

    public static func matches(_ url: URL, extra: [String] = []) -> Bool {
        check(url, extra: extra) != nil
    }

    public static func matches(_ rawURL: String, extra: [String] = []) -> Bool {
        check(rawURL, extra: extra) != nil
    }

    /// TS `dangerousDomainRefusal` — the shared refusal text for every hit, wherever it fires.
    /// Names the entry's url AND the matched list entry, so a transcript reads as a deliberate
    /// policy block rather than a network failure.
    public static func refusal(url: String, hit: DangerousDomainHit, cannotAskReason: String) -> String {
        "\(url): refused — \(hit.host) matches the dangerous-domain list (\(hit.matchedEntry)); \(cannotAskReason)"
    }
}

public struct DangerousDomainHit: Sendable, Equatable {
    /// The url's own (lowercased) hostname.
    public let host: String
    /// The list entry it matched — the broader parent domain for a subdomain hit.
    public let matchedEntry: String

    public init(host: String, matchedEntry: String) {
        self.host = host
        self.matchedEntry = matchedEntry
    }
}
