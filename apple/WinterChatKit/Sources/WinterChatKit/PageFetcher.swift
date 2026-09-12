import Foundation

/// Swift port of `packages/core/src/agent/tools/page-core.ts`'s `fetchCleanPage` and its supporting
/// machinery: fetch → clean → extract links → deterministic line numbering → in-memory TTL cache.
///
/// DETERMINISM CONTRACT (the reason the cache stores CLEANED pages, not raw bytes): a citation
/// `url lines:N-M` must re-resolve to the same text later, which only holds if the SAME cleaned
/// `lines` array is served every time inside the cache window — never a fresh re-clean of
/// possibly-changed live bytes.
///
/// CACHE-KEY NUANCE, ported as-is: `get`/`put` key on the FINAL resolved address. For a url that
/// doesn't redirect that's identical to what was passed in, so repeat calls hit. For a url that DOES
/// redirect, a repeat call with the ORIGINAL address still refetches; a repeat call with the
/// previously RETURNED address — exactly what a citation cites — hits. That is the one property
/// that matters here.

// MARK: - cooperative cancellation

/// The Swift stand-in for the TS `AbortSignal`. Deliberately NOT Swift task cancellation: the
/// dedupe semantics this file ports require a JOINER to detach from a shared fetch WITHOUT killing
/// it for everybody else, which structured cancellation cannot express.
public final class ChatAbortSignal: @unchecked Sendable {
    /// Undoes one `onAbort` registration. Cancelling is idempotent and safe after the signal fired.
    public final class Registration: Sendable {
        private let disposer: @Sendable () -> Void
        init(_ disposer: @escaping @Sendable () -> Void) { self.disposer = disposer }
        public func cancel() { disposer() }
    }

    private let lock = NSLock()
    private var aborted = false
    private var handlers: [UUID: @Sendable () -> Void] = [:]

    public init() {}

    public var isAborted: Bool { lock.withLock { aborted } }

    /// Idempotent — the second call is a no-op, and handlers fire at most once.
    public func abort() {
        var fire: [@Sendable () -> Void] = []
        lock.lock()
        if !aborted {
            aborted = true
            fire = Array(handlers.values)
            handlers.removeAll()
        }
        lock.unlock()
        for handler in fire { handler() }
    }

    /// Fires `handler` immediately if the signal has ALREADY aborted — a late registration can never
    /// silently miss the event.
    public func onAbort(_ handler: @escaping @Sendable () -> Void) -> Registration {
        let id = UUID()
        lock.lock()
        if aborted {
            lock.unlock()
            handler()
            return Registration {}
        }
        handlers[id] = handler
        lock.unlock()
        return Registration { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.handlers.removeValue(forKey: id)
            self.lock.unlock()
        }
    }
}

/// Thrown to a caller that detached from a shared in-flight fetch via its own signal. NOT a fetch
/// failure — the underlying fetch is very likely still running for somebody else.
public enum ChatAbortError: Error, Equatable {
    case aborted
}

/// A result that many callers can await independently, each able to give up on its own without
/// disturbing the others — the piece of TS promise semantics Swift has no direct equivalent for.
/// A waiter is registered under an id and is resumed by EXACTLY ONE of `resolve` or its own abort;
/// `removeValue(forKey:)` under the lock is the arbiter.
final class SharedFuture<Value: Sendable>: @unchecked Sendable {
    private final class RegistrationBox: @unchecked Sendable {
        var registration: ChatAbortSignal.Registration?
    }

    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var waiters: [UUID: CheckedContinuation<Value, Error>] = [:]

    /// Joiners currently suspended on this future (the initiator is not one of them).
    var waiterCount: Int { lock.withLock { waiters.count } }

    /// First call wins; later calls are no-ops.
    func resolve(_ value: Result<Value, Error>) {
        var pending: [CheckedContinuation<Value, Error>] = []
        lock.lock()
        if result == nil {
            result = value
            pending = Array(waiters.values)
            waiters.removeAll()
        }
        lock.unlock()
        for continuation in pending { continuation.resume(with: value) }
    }

    func get(signal: ChatAbortSignal?) async throws -> Value {
        if let signal, signal.isAborted { throw ChatAbortError.aborted }
        let id = UUID()
        let box = RegistrationBox()
        defer { box.registration?.cancel() }

        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let settled = result {
                lock.unlock()
                continuation.resume(with: settled)
                return
            }
            waiters[id] = continuation
            lock.unlock()

            box.registration = signal?.onAbort { [weak self] in
                guard let self else { return }
                self.lock.lock()
                let waiter = self.waiters.removeValue(forKey: id)
                self.lock.unlock()
                waiter?.resume(throwing: ChatAbortError.aborted)
            }
        }
    }
}

// MARK: - errors + audit

/// web.ts's exact outcome vocabulary, carried as a real field rather than left for callers to
/// re-derive from message text.
public enum PageFetchOutcome: String, Sendable, Equatable {
    case ok
    case timeout
    case httpError = "http_error"
    case networkError = "network_error"
    case parseError = "parse_error"
    /// Every `ssrfGuard` refusal, including "invalid url" and "only http(s) urls are allowed" —
    /// `followRedirects` in the TS maps the whole guard to one `kind: "ssrf"`, so an unparseable or
    /// `file://` url audits identically on both engines. (An earlier revision of this port invented
    /// an `invalid_url` outcome for those two; review Minor 1.)
    case ssrfRefused = "ssrf_refused"
    case tooManyRedirects = "too_many_redirects"
    /// The one outcome with no TS counterpart — chat mode's stricter-than-the-daemon pre-fetch block
    /// on the REQUESTED url. A redirect INTO a dangerous host still reports
    /// `dangerous_domain_redirect`, exactly as the TS does.
    case dangerousDomain = "dangerous_domain"
    case dangerousDomainRedirect = "dangerous_domain_redirect"
}

public struct PageFetchError: Error, Equatable, CustomStringConvertible {
    public let outcome: PageFetchOutcome
    public let message: String

    public init(outcome: PageFetchOutcome, message: String) {
        self.outcome = outcome
        self.message = message
    }

    public var description: String { message }
}

/// One audit line per fetch, EVERY outcome — the same shape the TS emits (`kind: "network"`).
public struct PageAuditLine: Sendable, Equatable {
    public let tool: String
    public let url: String
    public let outcome: String
    public let fromCache: Bool?
}

public typealias PageAuditSink = @Sendable (PageAuditLine) -> Void

// MARK: - fetcher

public struct PageFetcher: Sendable {
    /// Mirrors web.ts's `REQUEST_TIMEOUT_MS`. Every fetch is bounded by this even when the caller
    /// passes no signal at all: a caller's signal can only NARROW the bound, never widen it.
    public static let defaultTimeout: TimeInterval = 15
    /// web.ts's `MAX_FETCH_BYTES`.
    public static let defaultMaxBytes = 5 * 1024 * 1024

    /// The shared tail of every dangerous-domain refusal chat mode produces — there is no approval
    /// flow to ask through, by user design.
    static let noApprovalFlowReason =
        "no approval flow exists to ask for one, so a known exfiltration/tunnel-provider host is blocked outright"
    static let noApprovalFlowRedirectReason =
        "no approval flow exists to ask for one, so a redirect into a known exfiltration/tunnel-provider host is blocked outright"

    private let http: any ChatHTTP
    private let cache: PageCache
    /// The user-added half of the effective dangerous list, already resolved by the caller
    /// (`settings.permissions.dangerousDomains.added`). The shipped half always applies.
    private let dangerousAdded: [String]
    private let timeout: TimeInterval
    private let maxBytes: Int
    /// Audit-line label — "ReadPage" for direct page reads, "FetchPage" for the research sub-agent,
    /// so an audit trail can tell the two callers apart.
    private let tool: String
    private let audit: PageAuditSink?
    private let now: @Sendable () -> Date

    public init(http: any ChatHTTP,
                cache: PageCache,
                dangerousAdded: [String] = [],
                timeout: TimeInterval = PageFetcher.defaultTimeout,
                maxBytes: Int = PageFetcher.defaultMaxBytes,
                tool: String = "ReadPage",
                audit: PageAuditSink? = nil,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.http = http
        self.cache = cache
        self.dangerousAdded = dangerousAdded
        self.timeout = timeout
        self.maxBytes = maxBytes
        self.tool = tool
        self.audit = audit
        self.now = now
    }

    /// Fetch + clean + link-extract a page, serving a cached CLEANED copy inside the TTL instead of
    /// re-fetching or re-cleaning.
    ///
    /// `signal` is combined with (never replaces) the 15 s default timeout for the INITIATOR's own
    /// fetch, and detaches a JOINER from a shared in-flight fetch without disturbing it.
    ///
    /// DISCLOSED DIVERGENCE FROM THE TS (a strict hardening, never a loosening): `fetchCleanPage`
    /// checks the dangerous-domain floor only on the RESOLVED, post-redirect host, trusting each
    /// caller to have pre-checked the requested url. This checks BOTH — the requested url before any
    /// network egress, and the resolved url before any content reaches the model or the cache. A
    /// caller that also pre-checks (as Task 7's tools do, for their own per-entry refusal text) just
    /// reaches the same verdict first; a caller that forgets cannot open a hole.
    public func fetch(url: String,
                      origin: PageOrigin = .user,
                      signal: ChatAbortSignal? = nil) async throws -> CleanPage {
        let timestamp = now()

        if let hit = DangerousDomains.check(url, extra: dangerousAdded) {
            emit(url: url, outcome: .dangerousDomain)
            throw PageFetchError(
                outcome: .dangerousDomain,
                message: DangerousDomains.refusal(url: url, hit: hit, cannotAskReason: Self.noApprovalFlowReason)
            )
        }

        if let cached = await cache.get(url, now: timestamp) {
            emit(url: url, outcome: .ok, fromCache: true)
            return cached
        }

        // Everything past the cache-miss check rides `dedupe` — a single caller with no concurrent
        // duplicate is unaffected (the producer just runs once).
        return try await cache.dedupe(url: url, origin: origin, signal: signal) { effectiveOrigin in
            try await produce(url: url, at: timestamp, signal: signal, effectiveOrigin: effectiveOrigin)
        }
    }

    // MARK: the producer

    /// web.ts's `MAX_REDIRECT_HOPS`.
    static let maxRedirectHops = 3

    /// One successfully-fetched hop's payload — the port of web.ts's `FetchSuccess`.
    private struct FetchedBody {
        let url: String
        let contentType: String
        let body: String
    }

    private func produce(url: String,
                         at timestamp: Date,
                         signal: ChatAbortSignal?,
                         effectiveOrigin: @Sendable @escaping () async -> PageOrigin) async throws -> CleanPage {
        // Always bounded, even with no caller signal. The caller's signal and the timeout are
        // COMBINED: either can fire, and the timeout is a ceiling the caller cannot raise. One
        // signal governs the WHOLE redirect chain, exactly as the TS passes one `signal` to every hop.
        let combined = ChatAbortSignal()
        var registrations: [ChatAbortSignal.Registration] = []
        if let signal { registrations.append(signal.onAbort { combined.abort() }) }
        let timeoutTask = Task { [timeout] in
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return } // cancelled: never fire
            combined.abort()
        }
        defer {
            timeoutTask.cancel()
            for registration in registrations { registration.cancel() }
        }

        let fetched: FetchedBody
        do {
            fetched = try await followRedirects(from: url, signal: combined)
        } catch let error as PageFetchError {
            emit(url: url, outcome: error.outcome)
            throw error
        }

        let isHTML = fetched.contentType.lowercased().contains("text/html")
        let page: CleanPage
        if isHTML {
            page = CleanPage(resolvedURL: fetched.url,
                             title: extractTitle(fetched.body),
                             lines: htmlToTextLines(fetched.body),
                             links: extractLinks(fetched.body, baseURL: fetched.url),
                             fetchedAt: timestamp,
                             fromCache: false)
        } else {
            // The HTML path trims each line, which incidentally drops a trailing "\r"; the raw-text
            // path has no such step, so a CRLF body would otherwise leak "\r" onto every line.
            page = CleanPage(resolvedURL: fetched.url,
                             title: "-",
                             lines: fetched.body.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n"),
                             links: [],
                             fetchedAt: timestamp,
                             fromCache: false)
        }

        await cache.put(page, now: timestamp, origin: await effectiveOrigin())
        emit(url: url, outcome: .ok, fromCache: false)
        return page
    }

    /// Port of web.ts's `followRedirects` (`web.ts:317-349`): a MANUAL redirect loop that guards
    /// every hop, including the first.
    ///
    /// Manual, rather than letting the transport chase redirects, for one reason: a compliant first
    /// URL must not be able to 302 into a private address, a dangerous host, or a `file://` scheme.
    /// A transport that follows redirects silently makes every hop after the first unguarded — the
    /// hole this whole fix round exists to close. `ChatHTTP.sendCapped` is contractually
    /// non-following, which is what makes the loop below the only redirect handling there is.
    ///
    /// Per-hop order matters and mirrors the TS exactly: guard `current` FIRST (hop 0 included),
    /// then send; on a 3xx, a MISSING `Location` is reported before the hop bound is consulted, so a
    /// malformed redirect reads as the malformed redirect it is rather than as "too many hops".
    private func followRedirects(from startURL: String, signal: ChatAbortSignal) async throws -> FetchedBody {
        var current = startURL
        var hop = 0

        while true {
            if let refusal = ssrfGuard(current) {
                throw PageFetchError(outcome: .ssrfRefused, message: refusal)
            }
            // Chat mode's addition over the TS, consistent with the pre-fetch check in `fetch`: the
            // dangerous-domain floor applies to EVERY hop, not just the first and the last.
            if let hit = DangerousDomains.check(current, extra: dangerousAdded) {
                let viaRedirect = hop > 0
                throw PageFetchError(
                    outcome: viaRedirect ? .dangerousDomainRedirect : .dangerousDomain,
                    message: DangerousDomains.refusal(
                        url: current, hit: hit,
                        cannotAskReason: viaRedirect ? Self.noApprovalFlowRedirectReason : Self.noApprovalFlowReason
                    )
                )
            }
            guard let requestURL = URL(string: current) else {
                throw PageFetchError(outcome: .ssrfRefused, message: "invalid url: \(current)")
            }

            var request = URLRequest(url: requestURL)
            request.httpMethod = "GET"
            request.timeoutInterval = timeout

            let hopResult: CappedResponse
            do {
                hopResult = try await send(request, signal: signal)
            } catch {
                let timedOut = Self.isAbortLike(error)
                throw PageFetchError(
                    outcome: timedOut ? .timeout : .networkError,
                    message: timedOut
                        ? "request timed out fetching \(current)"
                        : "fetch failed: \(error.localizedDescription)"
                )
            }

            let status = hopResult.response.statusCode
            if (300 ..< 400).contains(status) {
                let location = hopResult.response.value(forHTTPHeaderField: "Location") ?? ""
                guard !location.isEmpty else {
                    throw PageFetchError(outcome: .httpError,
                                         message: "redirect (\(status)) with no Location header")
                }
                guard hop < Self.maxRedirectHops else {
                    throw PageFetchError(outcome: .tooManyRedirects,
                                         message: "too many redirects (>\(Self.maxRedirectHops) hops)")
                }
                guard let next = URL(string: whatwgPreprocess(location), relativeTo: requestURL)?.absoluteURL else {
                    throw PageFetchError(outcome: .ssrfRefused, message: "invalid url: \(location)")
                }
                current = whatwgNormalize(next) // == the TS's `new URL(loc, current).toString()`
                hop += 1
                continue
            }

            guard (200 ..< 300).contains(status) else {
                throw PageFetchError(outcome: .httpError, message: "fetch failed: \(status)")
            }

            return FetchedBody(url: current,
                               contentType: hopResult.response.value(forHTTPHeaderField: "Content-Type") ?? "",
                               body: String(decoding: hopResult.body, as: UTF8.self))
        }
    }

    /// One hop, with the abort signal wired to the underlying task.
    private func send(_ request: URLRequest, signal: ChatAbortSignal) async throws -> CappedResponse {
        // Review Minor 2: short-circuit BEFORE creating the task. Previously the task was built and
        // only THEN had `onAbort` attached, so an already-aborted caller still put one request on the
        // wire — real egress the TS's `AbortSignal.any` never performs, and exactly the thing the
        // LAN threat model above cares about.
        if signal.isAborted { throw ChatAbortError.aborted }

        let task = Task { [http, maxBytes] in try await http.sendCapped(request, maxBytes: maxBytes) }
        let registration = signal.onAbort { task.cancel() }
        defer { registration.cancel() }

        // Swift task cancellation is bridged in too, so a caller that cancels its Task (rather than
        // aborting the signal) also tears the fetch down instead of leaking it.
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            signal.abort()
        }
    }

    private func emit(url: String, outcome: PageFetchOutcome, fromCache: Bool? = nil) {
        audit?(PageAuditLine(tool: tool, url: url, outcome: outcome.rawValue, fromCache: fromCache))
    }

    /// Both a caller abort and the timeout land here, and both classify as `timeout` — exactly the
    /// TS's `AbortError`/`TimeoutError` → `"timeout"` mapping.
    static func isAbortLike(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if error is ChatAbortError { return true }
        if let urlError = error as? URLError {
            return urlError.code == .cancelled || urlError.code == .timedOut
        }
        return false
    }
}

// MARK: - link extraction

/// A fixed, small, NAMED seed list (USER DESIGN) — "no ads in the links list", not a full adblocker.
/// Matched against the RESOLVED link's hostname/pathname, never a raw substring of the two
/// concatenated (which let `example.com/doubleclick.net.html` get silently dropped as if it were the
/// ad host itself). Two entry shapes, both host-scoped:
///
/// - a bare host matches the hostname EXACTLY or as a dot-bounded SUBDOMAIN (`stats.doubleclick.net`
///   drops, `notdoubleclick.net` does not);
/// - `host/path` (`facebook.com/tr`, Meta's pixel endpoint) matches that host — exactly or as a
///   subdomain, because the REAL Meta Pixel is served from `www.facebook.com/tr` — with a
///   BOUNDARY-AWARE path: `/tr` itself or a `/`-bounded child of it, never a bare prefix (which
///   dropped `/trending` and `/travel` as false positives).
let adTrackerLinkEntries = [
    "doubleclick.net",
    "googletagmanager.com",
    "google-analytics.com",
    "facebook.com/tr",
]

/// The WHATWG basic-URL-parser preprocessing `new URL(...)` applies and `Foundation.URL` does not:
/// strip leading/trailing C0-control-or-space, then REMOVE every ASCII tab, LF and CR anywhere in
/// the input.
///
/// Without it a malformed `href` carrying a raw newline resolves to a `%0A`-bearing url in Swift and
/// a newline-free one in JS. It was the first divergence the adversarial differential fuzz against
/// the live TS surfaced (20 hits, every one this shape) — the cleaner itself was byte-identical on
/// all 28,000 cases.
func whatwgPreprocess(_ href: String) -> String {
    let scalars = Array(href.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end, scalars[start].value <= 0x20 { start += 1 }
    while end > start, scalars[end - 1].value <= 0x20 { end -= 1 }
    let stripped = scalars[start ..< end].filter { $0 != "\u{09}" && $0 != "\u{0A}" && $0 != "\u{0D}" }
    return String(String.UnicodeScalarView(stripped))
}

/// The output normalizations WHATWG `URL.toString()` performs and `Foundation.URL.absoluteString`
/// does not: a lowercase scheme + host, an elided default port (`:80` for http, `:443` for https),
/// and a NON-EMPTY path for every special-scheme URL. All of these matter beyond cosmetics — the
/// emitted href is the link dedupe key here and the cache key downstream, so `HTTP://Example.COM/A`
/// and `http://example.com/A`, or `https://example.com` and `https://example.com/`, must not read
/// as two different pages.
///
/// The first three classes came out of a 28,000-case adversarial differential against the live TS.
/// The FOURTH — the empty path — did not, and that is a documented gap in that harness: its
/// generator only emitted hrefs it had spelled out as literal tokens, and every one of those
/// carried a path (`/x`, `/nl`, `https://e.test/y`, …). A bare authority (`href="https://example.com"`)
/// was never generated, so the class could not appear no matter how many seeds were run. Adversarial
/// token-splicing finds malformed-input classes; it does not find classes that live in the ORDINARY
/// input the generator happens not to produce. Found instead by the reviewer's 24-case REALISTIC
/// differential — the two techniques are complementary, and the fuzz needs both shapes.
///
/// Deliberately narrow beyond these four: no dot-segment collapsing, no percent-encoding rewriting,
/// no IDN work. Both differentials proved Foundation already agrees with WHATWG on all of those for
/// the shapes that reach here, and a broader rewrite would risk inventing NEW divergences rather
/// than closing known ones.
func whatwgNormalize(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
        return url.absoluteString
    }
    let scheme = components.scheme?.lowercased()
    components.scheme = scheme
    if let host = components.host { components.host = host.lowercased() }
    if let port = components.port,
       (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
        components.port = nil
    }
    if scheme == "http" || scheme == "https", components.path.isEmpty { components.path = "/" }
    return components.string ?? url.absoluteString
}

func isAdTrackerLink(_ resolved: URL) -> Bool {
    let host = (resolved.host(percentEncoded: false) ?? "").lowercased()
    let path = resolved.path(percentEncoded: true)
    return adTrackerLinkEntries.contains { entry in
        guard let slash = entry.firstIndex(of: "/") else {
            return host == entry || host.hasSuffix(".\(entry)")
        }
        let entryHost = String(entry[entry.startIndex ..< slash])
        let entryPath = String(entry[slash...]) // keeps the leading "/", e.g. "/tr"
        let hostMatches = host == entryHost || host.hasSuffix(".\(entryHost)")
        let pathMatches = path == entryPath || path.hasPrefix("\(entryPath)/")
        return hostMatches && pathMatches
    }
}

/// Extracts links from RAW html — BEFORE the cleaner, which rewrites every `<a>` into `text (href)`
/// prose and so destroys the tag structure a link list needs. Same `<a href>`/`</a>` pairing the
/// cleaner uses (one shared implementation, `anchorSpans`), scanned in two linear passes.
///
/// Every href is absolute-resolved against `baseURL` (the FINAL, post-redirect url). Fragment-only
/// in-page anchors, non-http(s) schemes, and known ad/tracker hosts are dropped; results are deduped
/// by resolved href, keeping the first occurrence's anchor text.
///
/// Nested-anchor semantics are behaviour-preserving: an `<a>` that opens before the previously
/// matched anchor's closing tag is skipped, exactly as the original combined regex's `lastIndex`
/// jump skipped it (it rode along as literal text inside the OUTER anchor's content instead).
func extractLinks(_ html: String, baseURL: String) -> [PageLink] {
    guard let base = URL(string: baseURL) else { return [] }
    let text = Utf16Text(html)
    let (opens, closes) = anchorSpans(text)
    guard !opens.isEmpty, !closes.isEmpty else { return [] }

    var seen = Set<String>()
    var links: [PageLink] = []
    var closePtr = 0 // monotonic — advances forward only across the WHOLE scan, never rewinds
    var consumedUntil = 0

    for open in opens {
        if open.start < consumedUntil { continue }
        while closePtr < closes.count, closes[closePtr].start < open.end { closePtr += 1 }
        if closePtr >= closes.count { break } // no close anywhere after this open (or any later one)

        let close = closes[closePtr]
        closePtr += 1
        consumedUntil = close.end

        // The `#` test runs on the RAW capture, exactly as the TS does — only the value handed to
        // the URL parser is preprocessed.
        let rawHref = open.capture
        if rawHref.isEmpty || rawHref.hasPrefix("#") { continue }
        guard let resolved = URL(string: whatwgPreprocess(rawHref), relativeTo: base)?.absoluteURL else { continue }
        guard let scheme = resolved.scheme?.lowercased(), scheme == "http" || scheme == "https" else { continue }
        if isAdTrackerLink(resolved) { continue }

        let href = whatwgNormalize(resolved)
        if seen.contains(href) { continue }
        seen.insert(href)
        links.append(PageLink(href: href, text: collapseToOneLine(htmlToText(text.slice(open.end, close.start)))))
    }
    return links
}
