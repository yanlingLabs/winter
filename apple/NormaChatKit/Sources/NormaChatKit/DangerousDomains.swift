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

    /// TS `checkDangerousDomain`, URL-typed. `extra` is the caller-resolved user-added half
    /// (`settings.permissions.dangerousDomains.added`) — this type never reads settings itself.
    ///
    /// A URL with no resolvable hostname returns `nil`: nothing dangerous can be said about a url
    /// with no host, and any fetch attempt fails on its own terms without reaching the network.
    public static func check(_ url: URL, extra: [String] = []) -> DangerousDomainHit? {
        guard let rawHost = url.host(percentEncoded: false), !rawHost.isEmpty else { return nil }
        let host = rawHost.lowercased()
        guard let entry = match(host: host, entries: shipped + extra) else { return nil }
        return DangerousDomainHit(host: host, matchedEntry: entry)
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
