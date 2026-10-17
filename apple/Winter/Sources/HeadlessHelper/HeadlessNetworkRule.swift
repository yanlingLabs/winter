import Foundation

/// ComputerV2 Phase 4 — **the headless browser's local-network rule, inside the browser.** The daemon refuses the
/// model's URL and every committed top-frame navigation that is on the local network
/// (`packages/core/src/computer-use/browser/headless/private-network.ts`); this is the SAME rule, applied by
/// Winter Headless to every request before it is sent — a navigation, a redirect, a sub-resource, a fetch — so a public
/// page that redirects to `http://192.168.1.1/…` or loads from the LAN is cancelled before any socket opens. One
/// fixture (`packages/core/test/computer-use/fixtures/headless-private-network.json`) holds the two copies equal.
///
/// It reads the URL as Chromium canonicalised it (dotted-quad IPv4, compressed hex IPv6), so it needs no spelling
/// tricks of its own. LEXICAL: a public name that resolves to a private address is not caught here.
///
/// Pure and thread-safe: CEF calls it on its UI thread (navigations) and its IO thread (every other request).
enum HeadlessNetworkRule {
    /// The schemes judged; anything else (`about:`, `data:`, `blob:`) opens no connection of its own.
    static let networkSchemes: Set<String> = ["http", "https", "ws", "wss"]

    /// Name suffixes only a local network resolves (as `LOCAL_NAME_SUFFIXES`).
    static let localNameSuffixes = [".local", ".home.arpa", ".internal", ".lan", ".home", ".corp", ".intranet", ".private", ".localdomain"]

    /// **The resolver belt**: Chromium's own host resolver maps every name under those suffixes (with or without the
    /// root's trailing dot) to "not found", so nothing in the browser can resolve one — a WebSocket included, which the
    /// request guard never sees, and anything else that resolves a name (a preconnect, a DNS prefetch). It covers
    /// NAMES only: an IP literal is not resolved, and the resolver's patterns cannot say "a single label" (a `*` with
    /// no dot), so a single-label name is the request guard's alone.
    static var hostResolverRulesSwitch: String {
        let rules = localNameSuffixes.flatMap { ["MAP *\($0) ~NOTFOUND", "MAP *\($0). ~NOTFOUND"] }
        return "--host-resolver-rules=" + rules.joined(separator: ",")
    }

    /// Where the PAC belt sends a refused host: a proxy that is never there. A privileged port on this Mac, so no
    /// ordinary process can listen in its place, and not one Chromium refuses as unsafe — every connection to it
    /// fails at once (connection refused), and nothing reaches the network.
    static let deadProxy = "PROXY 127.0.0.1:4"

    /// **The PAC belt**: the SAME rule as a proxy auto-config script, which Chromium's network service asks about every
    /// request it makes — the ones no CEF handler sees too (a WebSocket, WebTransport, a Reporting API upload, a fetch
    /// a certificate names) — before it opens a socket. A refused host goes to `deadProxy` and fails; everything else
    /// is `DIRECT`, as it would be with no proxy. Plain JavaScript over the host string: no DNS, ever — it calls none of
    /// the PAC helpers, since `isInNet` and `dnsResolve` resolve a name. Chromium hands the script an IPv6 host
    /// without its brackets; it accepts both.
    static var pacScript: String {
        let suffixes = "[" + localNameSuffixes.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        return """
        var SUFFIXES = \(suffixes);
        var DEAD = "\(deadProxy)";
        function v4(h) {
          var p = h.split(".");
          if (p.length !== 4) return null;
          var out = [];
          for (var i = 0; i < 4; i++) {
            if (!/^[0-9]{1,3}$/.test(p[i])) return null;
            var n = parseInt(p[i], 10);
            if (n > 255) return null;
            out.push(n);
          }
          return out;
        }
        function private4(v) {
          var a = v[0], b = v[1];
          if (a === 127) return false;
          return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
            || (a === 100 && b >= 64 && b <= 127) || a === 0 || a >= 224;
        }
        function v6(raw) {
          var text = raw.split("%")[0];
          if (text === "" || !/^[0-9a-f:.]+$/.test(text)) return null;
          var tail = null;
          if (text.indexOf(".") >= 0) {
            var c = text.lastIndexOf(":");
            if (c < 0) return null;
            tail = v4(text.slice(c + 1));
            if (tail === null) return null;
            text = text.slice(0, c + 1) + "0:0";
          }
          var halves = text.split("::");
          if (halves.length > 2) return null;
          function groups(part) {
            if (part === "") return [];
            var out = [], g = part.split(":");
            for (var i = 0; i < g.length; i++) {
              if (!/^[0-9a-f]{1,4}$/.test(g[i])) return null;
              out.push(parseInt(g[i], 16));
            }
            return out;
          }
          var head = groups(halves[0]);
          var rest = halves.length === 2 ? groups(halves[1]) : [];
          if (head === null || rest === null) return null;
          var missing = 8 - head.length - rest.length;
          if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
          var all = head.slice();
          for (var j = 0; j < (halves.length === 2 ? missing : 0); j++) all.push(0);
          all = all.concat(rest);
          var bytes = [];
          for (var k = 0; k < 8; k++) { bytes.push(all[k] >> 8); bytes.push(all[k] & 255); }
          if (tail !== null) { bytes[12] = tail[0]; bytes[13] = tail[1]; bytes[14] = tail[2]; bytes[15] = tail[3]; }
          return bytes;
        }
        function zero(b, from, to) { for (var i = from; i < to; i++) if (b[i] !== 0) return false; return true; }
        function private6(b) {
          var v = [b[12], b[13], b[14], b[15]];
          if (zero(b, 0, 15) && b[15] === 1) return false;
          if (zero(b, 0, 16)) return true;
          if (zero(b, 0, 10) && b[10] === 255 && b[11] === 255) return private4(v);
          if (zero(b, 0, 12)) return private4(v);
          if (zero(b, 0, 8) && b[8] === 255 && b[9] === 255 && zero(b, 10, 12)) return private4(v);
          if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(b, 4, 12)) return private4(v);
          var first = (b[0] << 8) | b[1];
          return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0
            || (first & 0xff00) === 0xff00;
        }
        function refused(host) {
          var h = String(host).toLowerCase();
          if (h.charAt(h.length - 1) === ".") h = h.slice(0, -1);
          if (h === "") return false;
          if (h.charAt(0) === "[") {
            if (h.charAt(h.length - 1) !== "]") return true;
            h = h.slice(1, -1);
          }
          if (h.indexOf(":") >= 0) { var b = v6(h); return b === null ? true : private6(b); }
          var v = v4(h);
          if (v !== null) return private4(v);
          if (h === "localhost" || h.slice(-10) === ".localhost") return false;
          for (var i = 0; i < SUFFIXES.length; i++) {
            var s = SUFFIXES[i];
            if (h.length >= s.length && h.slice(-s.length) === s) return true;
          }
          return h.indexOf(".") < 0;
        }
        function FindProxyForURL(url, host) { return refused(host) ? DEAD : "DIRECT"; }
        """
    }

    /// `--proxy-pac-url=data:…`: the PAC belt, inline (nothing fetched; base64, so no comma or space in the switch).
    static var proxyPacSwitch: String {
        "--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64," + Data(pacScript.utf8).base64EncodedString()
    }

    /// Must a request to `url` be refused? A network URL whose host cannot be read is refused (fail closed); a
    /// non-network scheme is not.
    static func refuses(_ url: String) -> Bool {
        guard let (scheme, host) = schemeAndHost(url) else { return true }
        guard networkSchemes.contains(scheme) else { return false }
        guard !host.isEmpty else { return true }
        return refusesHost(host)
    }

    /// The scheme (lowercased) and the host as the URL spells it — an IPv6 address in its brackets, no userinfo, no
    /// port. Read by hand, not by `URLComponents`, which refuses characters a canonical URL may still carry.
    static func schemeAndHost(_ url: String) -> (String, String)? {
        guard let colon = url.firstIndex(of: ":") else { return nil }
        let scheme = url[..<colon].lowercased()
        var rest = url[url.index(after: colon)...]
        guard rest.hasPrefix("//") else { return (scheme, "") }
        rest = rest.dropFirst(2)
        let end = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" || $0 == "\\" }) ?? rest.endIndex
        var authority = rest[..<end]
        if let at = authority.lastIndex(of: "@") { authority = authority[authority.index(after: at)...] }
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            return (scheme, String(authority[...close]))
        }
        if let port = authority.lastIndex(of: ":") { authority = authority[..<port] }
        return (scheme, String(authority))
    }

    /// The rule on a host as a URL spells it (an IPv6 address in brackets).
    static func refusesHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return false }
        if host.hasPrefix("["), host.hasSuffix("]") {
            guard let bytes = ipv6Bytes(String(host.dropFirst().dropLast())) else { return true }
            return privateIPv6(bytes)
        }
        if let v4 = ipv4(host) { return privateIPv4(v4) }
        if host == "localhost" || host.hasSuffix(".localhost") { return false }
        if localNameSuffixes.contains(where: { host.hasSuffix($0) }) { return true }
        // A single label resolves only through the LAN's own search domains.
        return !host.contains(".")
    }

    static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for part in parts {
            guard (1...3).contains(part.count), part.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(part), n <= 255 else { return nil }
            out.append(n)
        }
        return out
    }

    static func privateIPv4(_ v: [Int]) -> Bool {
        guard v.count == 4 else { return true }
        let (a, b) = (v[0], v[1])
        if a == 127 { return false } // this Mac (loopback)
        return a == 10 // RFC 1918
            || (a == 172 && (16...31).contains(b)) // RFC 1918
            || (a == 192 && b == 168) // RFC 1918
            || (a == 169 && b == 254) // link-local
            || (a == 100 && (64...127).contains(b)) // CGNAT (RFC 6598)
            || a == 0 // "this network"
            || a >= 224 // multicast, reserved, broadcast
    }

    /// An IPv6 address (no brackets, an optional zone) as its 16 bytes; nil when it is not one.
    static func ipv6Bytes(_ raw: String) -> [Int]? {
        let text = String(raw.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false).first ?? "").lowercased()
        guard !text.isEmpty, text.allSatisfy({ $0.isHexDigit || $0 == ":" || $0 == "." }) else { return nil }
        var groupsText = text
        var tail: [Int] = []
        if text.contains("."), let colon = text.lastIndex(of: ":") {
            guard let v4 = ipv4(String(text[text.index(after: colon)...])) else { return nil }
            groupsText = String(text[...colon]) + "0:0"
            tail = v4
        } else if text.contains(".") {
            return nil
        }
        let halves = groupsText.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func parse(_ part: String) -> [Int]? {
            if part.isEmpty { return [] }
            var out: [Int] = []
            for group in part.split(separator: ":", omittingEmptySubsequences: false) {
                guard (1...4).contains(group.count), let n = Int(group, radix: 16) else { return nil }
                out.append(n)
            }
            return out
        }
        guard let head = parse(halves[0]), let rest = halves.count == 2 ? parse(halves[1]) : [] else { return nil }
        let missing = 8 - head.count - rest.count
        if halves.count == 2 ? missing < 1 : missing != 0 { return nil }
        let groups = head + Array(repeating: 0, count: halves.count == 2 ? missing : 0) + rest
        var bytes = groups.flatMap { [$0 >> 8, $0 & 0xff] }
        if tail.count == 4 { bytes.replaceSubrange(12..<16, with: tail) }
        return bytes
    }

    static func privateIPv6(_ b: [Int]) -> Bool {
        guard b.count == 16 else { return true }
        func zero(_ range: Range<Int>) -> Bool { b[range].allSatisfy { $0 == 0 } }
        let v4 = Array(b[12..<16])
        if zero(0..<15) && b[15] == 1 { return false } // ::1, this Mac (loopback)
        if zero(0..<16) { return true } // :: (unspecified)
        if zero(0..<10) && b[10] == 0xff && b[11] == 0xff { return privateIPv4(v4) } // ::ffff:a.b.c.d (mapped)
        if zero(0..<12) { return privateIPv4(v4) } // ::a.b.c.d (IPv4-compatible)
        if zero(0..<8) && b[8] == 0xff && b[9] == 0xff && zero(10..<12) { return privateIPv4(v4) } // ::ffff:0:a.b.c.d
        if b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && zero(4..<12) { return privateIPv4(v4) } // 64:ff9b::/96
        let first = (b[0] << 8) | b[1]
        return (first & 0xfe00) == 0xfc00 // unique local (fc00::/7)
            || (first & 0xffc0) == 0xfe80 // link-local (fe80::/10)
            || (first & 0xffc0) == 0xfec0 // site-local, deprecated (fec0::/10)
            || (first & 0xff00) == 0xff00 // multicast
    }
}

/// The rule as the C function `WinterCEFHeadlessSetRequestRule` takes (installed by `main.swift` before CEF starts).
let headlessRequestRefused: @convention(c) (UnsafePointer<CChar>?) -> Bool = { url in
    guard let url else { return true }
    return HeadlessNetworkRule.refuses(String(cString: url))
}
