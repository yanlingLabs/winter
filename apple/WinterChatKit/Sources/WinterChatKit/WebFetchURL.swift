import Foundation

/// WHAT `WebFetch` CAN EVEN TRY TO FETCH, plus the two rendering helpers whose Foundation
/// equivalents are wrong for this job. The Swift port of the agent SDK's
/// `packages/runtime/src/web/fetchable-url.ts` and the parts of `_web-fetch-net.ts` that are pure
/// text.
///
/// THE RULES ARE CLAUDE'S, kept as they are (the project's parity rule): `http` is upgraded to
/// `https` UNCONDITIONALLY, and then any URL longer than 2000 characters, any URL with embedded
/// credentials, and any hostname with fewer than two dot-separated labels is refused. So `localhost`,
/// every IPv6 literal and a plain-http-only service are unfetchable in claude too.
enum WebFetchURL {
    /// The three FETCH-TIME rejects' text: a bare `Invalid URL`, never the fuller parse-failure
    /// sentence.
    static let fetchTimeInvalidURL = "Invalid URL"

    /// The one sentence every text about a private/loopback target ends with, so the executor's
    /// refusal says the SAME true thing about what an approval could ever achieve.
    static let fetchableTargetShape = "WebFetch upgrades http to https unconditionally, so only an https service at an IPv4 literal (127.0.0.1) or at a name with two or more dot-separated labels (printer.local) is reachable at all -- a plain-http port on localhost or an IPv6 literal cannot be fetched whatever the policy says."

    /// `validateInput`'s own parse-failure text — WITH the `Error: ` prefix.
    static func parseFailureMessage(_ raw: String) -> String {
        "Error: Invalid URL \"\(raw)\". The URL provided could not be parsed."
    }

    /// claude's fetch-time rejects, as a reason a caller may name in a test.
    enum Unfetchable: String, Equatable, Sendable {
        case tooLong = "too-long"
        case embeddedCredentials = "embedded-credentials"
        case singleLabelHostname = "single-label-hostname"
    }

    /// The `http:` → `https:` upgrade, unconditional and claude's own. Returns `url` itself for any
    /// other scheme, and for anything `URLComponents` declines to rebuild.
    static func upgradeToHTTPS(_ url: URL) -> URL {
        guard url.scheme?.lowercased() == "http" else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return url }
        components.scheme = "https"
        return components.url ?? url
    }

    /// claude's own fetch-time rejects for ONE already-parsed URL. `nil` means none applies.
    ///
    /// Run PER HOP by the net layer (claude runs it once on the raw input; running it again on every
    /// upgraded hop is strictly stricter and is the SDK's own disclosed, safe deviation).
    static func fetchTimeRefusal(_ url: URL) -> Unfetchable? {
        if url.absoluteString.utf16.count > 2000 { return .tooLong }
        if !(url.user(percentEncoded: false) ?? "").isEmpty || !(url.password(percentEncoded: false) ?? "").isEmpty {
            return .embeddedCredentials
        }
        if labelCount(of: url) < 2 { return .singleLabelHostname }
        return nil
    }

    /// The bare hostname a classification or a floor check should see: lowercased, IPv6 brackets
    /// stripped (Foundation's `URL.host` already strips them, but not every path here goes through
    /// `URL`), and a single trailing root dot removed.
    static func bareHost(_ url: URL) -> String {
        var host = (url.host(percentEncoded: false) ?? "").lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".") { host.removeLast() }
        return host
    }

    /// The hostname exactly as it should be NAMED in a refusal — the form the SDK's messages carry,
    /// which is WHATWG's `url.hostname`: lowercased, brackets KEPT for an IPv6 literal. Foundation
    /// strips them, so they are put back.
    static func displayHost(_ url: URL) -> String {
        let bare = bareHost(url)
        return ipv6Bytes(bare) != nil ? "[\(bare)]" : bare
    }

    /// WHATWG's own label count for the "fewer than two labels" rule, which is a count over
    /// `url.hostname` — and that differs from a naive count over Foundation's `URL.host` in two ways
    /// that both matter here:
    ///
    ///   * an IPv6 literal is ONE label in WHATWG (`hostname` keeps the brackets, so `[::1]` and
    ///     `[::ffff:7f00:1]` both hold no dot). Foundation hands back `::ffff:127.0.0.1`, which a naive
    ///     split reads as FOUR labels and would wave through. Any host that parses as IPv6 counts as
    ///     one label here, which refuses every IPv6 spelling exactly as claude does.
    ///   * a NUMERIC host is canonicalised to a dotted quad by WHATWG's host parser before the count,
    ///     so `http://2130706433/` is four labels there and passes this rule — and is then refused by
    ///     the private-address policy instead, with the policy's own (much more informative) text.
    ///     Foundation canonicalises nothing, so a host with ANY IPv4 interpretation
    ///     (`ipv4Interpretations`, the same fail-closed union `ssrfGuard` uses) counts as four.
    static func labelCount(of url: URL) -> Int {
        let host = bareHost(url)
        if host.isEmpty { return 1 } // no host at all: `file:///x`, `data:...`, `http://`
        if ipv6Bytes(host) != nil { return 1 }
        if !ipv4Interpretations(host).isEmpty { return 4 }
        return host.components(separatedBy: ".").count
    }

    /// The two WHATWG host-parser rules `Foundation.URL` lacks, reused verbatim from `SSRFGuard`:
    /// a `0`-prefixed all-digit part containing an out-of-radix digit (`08.8.8.8`) and a
    /// numeric-LOOKING last label that is not an address (`999.999.999.999`, `1.2.3.4.5`, `1..2`).
    /// `new URL()` THROWS on both, so on this engine they are the executor's parse failure rather
    /// than a fetch-time reject — same refusal claude reaches, one step earlier in the pipeline.
    static func whatwgWouldRefuseHost(_ url: URL) -> Bool {
        let host = bareHost(url)
        guard !host.isEmpty, ipv6Bytes(host) == nil else { return false }
        return hasInvalidOctalOctet(host) || looksNumericButIsNotAnAddress(host)
    }

    // MARK: - status reason phrases

    /// claude's own `I_e(code)`: a FIXED table lookup, never the wire's own (server-controlled) reason
    /// phrase — relaying that text is a prompt-injection vector aimed at the MAIN model.
    ///
    /// Hand-ported from node's `http.STATUS_CODES` rather than taken from
    /// `HTTPURLResponse.localizedString(forStatusCode:)`, which is LOWERCASED and LOCALISED
    /// (measured: `404` → "not found") and would make the result text both wrong and
    /// device-dependent.
    static func reasonPhrase(_ status: Int) -> String {
        statusCodes[status] ?? "Unknown Status"
    }

    private static let statusCodes: [Int: String] = [
        100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
        200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
        204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
        208: "Already Reported", 226: "IM Used",
        300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other",
        304: "Not Modified", 305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
        400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
        404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
        407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict",
        410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large",
        414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable",
        417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request",
        422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early",
        426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
        431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
        500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
        503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
        506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
        509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
    ]

    // MARK: - en_US number rendering

    /// `Number.prototype.toLocaleString("en-US")` — grouped with commas, ALWAYS, never the device's
    /// own locale (which would make a ported result text read `10.485.760` on a German phone).
    static func groupedEnUS(_ value: Int) -> String {
        Self.enUSFormatter.string(from: value as NSNumber) ?? String(value)
    }

    private static let enUSFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        formatter.groupingSeparator = ","
        formatter.usesGroupingSeparator = true
        return formatter
    }()
}
