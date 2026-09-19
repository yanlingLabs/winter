import Foundation

/// THE LOCAL FETCH BEHIND `WebFetch` — the Swift port of the agent SDK's
/// `packages/runtime/src/tools/impl/_web-fetch-net.ts`: a MANUAL redirect walk, one HTTP request per
/// hop, each hop re-checked against the dangerous-domain floor AND the private-address policy
/// (closing the short-link bypass: a blocked or private host reached through an intermediate redirect
/// is refused exactly like one reached directly).
///
/// WHY THIS IS NOT `PageFetcher`. The two fetchers answer different questions and their outcomes are
/// not convertible. `PageFetcher` auto-follows every redirect it can guard and returns a line-numbered
/// `CleanPage` with a usable TRUNCATED body at the cap; `WebFetch` returns a cross-host redirect to
/// the MODEL as text so the model re-calls, REFUSES at the size cap, and its result texts need the
/// status code, the fixed reason phrase, `Retry-After`, the refused host, the redirect target and the
/// content type — none of which a `CleanPage`/`PageFetchError` carries. Nine behaviours fork, and
/// `PageFetcher`'s own tests pin the opposite of each one. So this is its own loop, over the SAME
/// hardened parts: `ssrfGuard`'s address parsers (through `PrivateAddress`), `DangerousDomains`,
/// `whatwgPreprocess`/`whatwgNormalize` for resolving a `Location`, `ChatAbortSignal`, and
/// `ChatHTTP.sendCapped`, which is contractually non-following — which is what makes this loop the
/// only redirect handling there is.
///
/// THREE DISCLOSED DIVERGENCES FROM THE SDK, all forced by the platform:
///   * **no DNS resolution and no address pinning** — see `PrivateAddress`'s header. The private check
///     is lexical; a public-looking name that resolves into private space is not caught, and the SDK's
///     `could not resolve any address for <host>` outcome is unreachable here.
///   * **no `decompress: false`** — `URLSession` inflates transparently and offers no way to opt out,
///     so the 10 MiB cap is enforced on DECOMPRESSED bytes (which is the cap that matters: it is the
///     peak this process holds). The SDK's *second*, lower cap on COMPRESSED input
///     (`WEB_FETCH_MAX_ENCODED_BYTES`, 2 MiB, which bounds a zip-bomb's transient RSS inside its own
///     zlib binding) has no analogue and no reachable seam here.
///   * **one candidate address** — the SDK tries every resolved address in order with a per-candidate
///     connect budget, because it connects by IP. `URLSession` does its own happy-eyeballs walk, so
///     there is nothing to reimplement.
public enum WebFetchNet {
    /// `WEB_FETCH_MAX_BYTES`.
    static let maxBytes = 10_485_760
    /// `WEB_FETCH_TIMEOUT_MS` — PER HOP in claude too, by design, not a shared total budget.
    static let timeout: TimeInterval = 60
    /// `WEB_FETCH_MAX_REDIRECTS`. Counts redirects FOLLOWED, not total requests.
    static let maxRedirects = 10
    /// The SDK sends `winter/<version>`; this kit carries no version constant of its own, so the
    /// product name alone is the default and a caller may state a fuller one.
    public static let defaultUserAgent = "winter"

    private static let redirectStatuses: Set<Int> = [301, 302, 303, 307, 308]

    struct Options: Sendable {
        var dangerousAdded: [String] = []
        var userAgent: String = WebFetchNet.defaultUserAgent
        var timeout: TimeInterval = WebFetchNet.timeout
        var maxBytes: Int = WebFetchNet.maxBytes
    }

    enum Outcome: Sendable {
        case invalidURL(message: String)
        case blockedDomain(host: String)
        /// The policy is always `deny` on this engine (chat never prompts), so it is not carried.
        case privateAddress(host: String)
        case redirectBlocked(message: String)
        case tooManyRedirects(message: String)
        case httpError(status: Int, statusText: String, retryAfter: String?)
        case sizeExceeded(message: String)
        case timeout(message: String)
        case aborted
        case networkError(message: String)
        case success(finalURL: String, status: Int, statusText: String, contentType: String, body: Data)
    }

    /// Performs the whole fetch, including the manual redirect walk. `prompt` is needed only to render
    /// the `REDIRECT DETECTED` message's own `- prompt:` line, exactly as claude does.
    static func perform(inputURL: String,
                        prompt: String,
                        http: any ChatHTTP,
                        options: Options = Options(),
                        signal: ChatAbortSignal? = nil) async -> Outcome {
        guard var current = URL(string: inputURL) else {
            return .invalidURL(message: WebFetchURL.parseFailureMessage(inputURL))
        }
        current = WebFetchURL.upgradeToHTTPS(current)

        var redirectsFollowed = 0
        while true {
            if WebFetchURL.fetchTimeRefusal(current) != nil {
                return .invalidURL(message: WebFetchURL.fetchTimeInvalidURL)
            }

            let host = WebFetchURL.displayHost(current)
            if DangerousDomains.check(current, extra: options.dangerousAdded) != nil {
                return .blockedDomain(host: host)
            }
            if PrivateAddress.classifyLexically(WebFetchURL.bareHost(current))?.isPrivate == true {
                return .privateAddress(host: host)
            }

            let scope = PreapprovedHosts.scopeOf(current)

            var request = URLRequest(url: current)
            request.httpMethod = "GET"
            request.timeoutInterval = options.timeout
            request.setValue("text/markdown, text/html, */*", forHTTPHeaderField: "Accept")
            request.setValue(options.userAgent, forHTTPHeaderField: "User-Agent")

            let hop: CappedResponse
            do {
                // The cap is asked for as `maxBytes + 1` so that `truncated` means "MORE than the cap
                // arrived", which is the SDK's own `total > WEB_FETCH_MAX_BYTES` boundary exactly — a
                // body of precisely `maxBytes` is a success there and must be one here.
                hop = try await send(request, http: http, options: options, signal: signal)
            } catch {
                if signal?.isAborted == true { return .aborted }
                if PageFetcher.isAbortLike(error) { return .timeout(message: timeoutMessage(options.timeout)) }
                // NEVER the caught error's own message: a transport failure's text is whatever the
                // network stack wrote, and a proxy URL with embedded credentials has been measured
                // reaching exactly this path. `URLError.Code` is this platform's structural equivalent
                // of the SDK's `err.code`.
                return .networkError(message: errorLabel(error))
            }

            let status = hop.response.statusCode
            if redirectStatuses.contains(status) {
                let location = hop.response.value(forHTTPHeaderField: "Location") ?? ""
                let target: URL? = location.trimmingCharacters(in: .whitespaces).isEmpty
                    ? nil
                    : URL(string: whatwgPreprocess(location), relativeTo: current)?.absoluteURL
                // An unparseable OR blank Location is an http_error, never a redirect message.
                guard let target else {
                    return .httpError(status: status, statusText: WebFetchURL.reasonPhrase(status), retryAfter: nil)
                }
                let scheme = target.scheme?.lowercased()
                let notHTTP = scheme != "http" && scheme != "https"
                if !notHTTP, isEligibleAutoFollow(current: current, target: target, scope: scope) {
                    if redirectsFollowed >= maxRedirects {
                        return .tooManyRedirects(message: "Too many redirects (exceeded \(maxRedirects))")
                    }
                    redirectsFollowed += 1
                    current = target
                    continue
                }
                return .redirectBlocked(message: renderRedirectDetected(
                    currentURL: current.absoluteString,
                    target: notHTTP ? nil : target,
                    status: status,
                    prompt: prompt))
            }

            guard (200 ..< 300).contains(status) else {
                let raw = hop.response.value(forHTTPHeaderField: "Retry-After")
                let retryAfter = raw?.range(of: "^[0-9]{1,6}$", options: .regularExpression) != nil ? raw : nil
                return .httpError(status: status, statusText: WebFetchURL.reasonPhrase(status), retryAfter: retryAfter)
            }

            if hop.truncated {
                return .sizeExceeded(message: "The response body exceeded WebFetch's \(WebFetchURL.groupedEnUS(options.maxBytes))-byte limit and was not retrieved.")
            }
            return .success(finalURL: current.absoluteString,
                            status: status,
                            statusText: WebFetchURL.reasonPhrase(status),
                            contentType: hop.response.value(forHTTPHeaderField: "Content-Type") ?? "",
                            body: hop.body)
        }
    }

    // MARK: - one hop

    /// One request, bounded by the PER-HOP timeout even when the caller passes no signal at all, and
    /// torn down when the caller's signal aborts. A caller's signal can only NARROW the bound.
    private static func send(_ request: URLRequest,
                             http: any ChatHTTP,
                             options: Options,
                             signal: ChatAbortSignal?) async throws -> CappedResponse {
        if signal?.isAborted == true { throw ChatAbortError.aborted }
        let combined = ChatAbortSignal()
        let outerRegistration = signal?.onAbort { combined.abort() }
        let timeoutTask = Task { [timeout = options.timeout] in
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return } // cancelled: never fire
            combined.abort()
        }
        defer {
            timeoutTask.cancel()
            outerRegistration?.cancel()
        }

        let cap = options.maxBytes + 1
        let task = Task { try await http.sendCapped(request, maxBytes: cap) }
        let registration = combined.onAbort { task.cancel() }
        defer { registration.cancel() }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            combined.abort()
            task.cancel()
        }
    }

    // MARK: - messages

    /// Item 3's ONE spelling of a hop timeout, shared so the pre-send and post-send paths cannot
    /// drift. A sub-second timeout reports milliseconds rather than rounding down to "0s".
    static func timeoutMessage(_ timeout: TimeInterval) -> String {
        timeout < 1
            ? "WebFetch timed out after \(Int((timeout * 1000).rounded()))ms."
            : "WebFetch timed out after \(Int(timeout.rounded()))s."
    }

    /// A transport failure's safe label — this platform's structural code, never `.localizedDescription`
    /// (which is prose, is localised, and can carry a URL the stack was given).
    static func errorLabel(_ error: Error) -> String {
        if let urlError = error as? URLError { return "URLError.Code(\(urlError.code.rawValue))" }
        return "\(type(of: error))"
    }

    /// The auto-follow eligibility gate, claude's own: same scheme, same port, no embedded
    /// credentials, the same host modulo a leading `www.`, and — for a path-scoped preapproved entry —
    /// still inside that scope.
    ///
    /// The SDK's own comment claims an explicit `:443` is NOT normalised and so is returned as a
    /// redirect rather than followed. That reading looks wrong: WHATWG's parser elides a scheme's
    /// default port at parse time, so `target.port` is the empty string there too and the hop IS
    /// eligible. `whatwgNormalize` does the same elision here, so this function matches the measured
    /// behaviour rather than that comment.
    static func isEligibleAutoFollow(current: URL, target: URL, scope: PreapprovedHosts.Match?) -> Bool {
        guard current.scheme?.lowercased() == target.scheme?.lowercased() else { return false }
        guard effectivePort(current) == effectivePort(target) else { return false }
        guard (target.user(percentEncoded: false) ?? "").isEmpty,
              (target.password(percentEncoded: false) ?? "").isEmpty else { return false }
        guard stripWww(WebFetchURL.bareHost(current)) == stripWww(WebFetchURL.bareHost(target)) else { return false }
        if let scope, scope.pathPrefix != nil, !PreapprovedHosts.staysWithinScope(scope, target) { return false }
        return true
    }

    /// The port as WHATWG reports it: the empty string when it is the scheme's default or absent.
    private static func effectivePort(_ url: URL) -> String {
        guard let port = url.port else { return "" }
        let scheme = url.scheme?.lowercased()
        if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) { return "" }
        return String(port)
    }

    private static func stripWww(_ host: String) -> String {
        host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// claude's exact `REDIRECT DETECTED` message. `target` is `nil` for a Location that is not
    /// http(s): rebuilding its display line would mean interpolating an un-percent-encoded opaque path
    /// (and, for `data:`/`javascript:`, the literal string "null" as an origin) into text the MAIN
    /// model reads — an injection vector of its own — so the URL line is WITHHELD instead.
    static func renderRedirectDetected(currentURL: String, target: URL?, status: Int, prompt: String) -> String {
        let statusText = WebFetchURL.reasonPhrase(status)
        var redirectURLLine: String
        var relayableURL: String?
        if let target {
            let full = displayTarget(target)
            let capped = full.utf16.count > 1000
            let value = capped ? truncateUTF16(full, to: 1000) : full
            var line = "Redirect URL (from the server's Location header — server-supplied, not verified): \(value)"
            if capped { line += " […\(full.utf16.count - 1000) more characters withheld: too long to relay]" }
            let hostTooLong = WebFetchURL.bareHost(target).utf16.count > 255
            if hostTooLong { line += " [hostname longer than any DNS name (255 characters): not a fetchable address]" }
            redirectURLLine = line
            if !capped, !hostTooLong { relayableURL = full }
        } else {
            redirectURLLine = "Redirect URL: (withheld — the server sent a redirect target that is not a valid http(s) URL)"
        }
        let header = "REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.\n\nOriginal URL: \(currentURL)\n\(redirectURLLine)\nStatus: \(status) \(statusText)\n\n"
        guard let relayableURL else {
            return header + "The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead."
        }
        return header + "To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:\n- url: \"\(relayableURL)\"\n- prompt: \"\(prompt)\""
    }

    /// `${target.origin}${target.pathname}${target.search}${target.hash}` — deliberately WITHOUT any
    /// userinfo, which `origin` drops in WHATWG and which must never be echoed back to the model.
    private static func displayTarget(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
            return url.absoluteString
        }
        components.user = nil
        components.password = nil
        if let scheme = components.scheme?.lowercased() { components.scheme = scheme }
        if let host = components.host { components.host = host.lowercased() }
        if let port = components.port,
           (components.scheme == "http" && port == 80) || (components.scheme == "https" && port == 443) {
            components.port = nil
        }
        if components.path.isEmpty { components.path = "/" }
        return components.string ?? url.absoluteString
    }
}
