import Foundation

/// `WebFetch` — the phone's copy of the tool the daemon's runtime child brings, so the same tool name
/// means the same thing in one session log wherever the turn ran. The Swift port of the agent SDK's
/// `packages/runtime/src/tools/impl/web-fetch.ts` (v0.0.17): fetch the URL, convert it, and answer
/// `prompt` against it with a small fast model. **Only the model's answer comes back** — no
/// tool_result ever carries raw page text, with the ONE exception claude itself makes (a preapproved
/// host serving markdown under 100,000 characters, which is passed through verbatim).
///
/// It REPLACES `ReadPage` and the multi-page research sub-agent, both retired here as they were on the
/// daemon. The difference is not cosmetic: `ReadPage` handed the model a line-numbered page and a
/// links tail, i.e. the whole page as tool output; this hands it an answer.
///
/// ORDER OF OPERATIONS (pinned so a reviewer can check this file against it in one pass):
///   parse input → parse the URL → domain floor on the input host → cache lookup →
///   (HIT) private-address check on the input host, and again on the cached entry's FINAL url when it
///   names a different host → (MISS) `WebFetchNet.perform`, which re-applies the floor AND the
///   private-address check on EVERY hop including hop 0 → convert (html/text/binary) → the preapproved
///   verbatim passthrough, or the digest pass → the 50,000-character result cap.
///
/// FOUR SDK BRANCHES ARE UNREACHABLE HERE, each for a structural reason, and each is named at its site:
///   * the **`ask` private-address policy** and its two texts. Chat never prompts (the standing user
///     rule), so the policy is fixed `deny` — the ONE thing this file does differently from the SDK by
///     choice rather than by platform.
///   * the **"late case"** refusal (a public-looking name that RESOLVES private) and
///     `could not resolve any address for <host>`: both need DNS, which this engine deliberately does
///     not do (see `PrivateAddress`).
///   * the **session spend ceiling** (`maxBudgetUsd`) stop: a Winter-daemon product concept with no
///     counterpart on the phone.
///   * the **binary save**: there is no session temp directory to save into, so a binary body always
///     reports the SDK's own "no session temp directory" sentence and nothing is written.
public enum WebFetchTool {
    /// `DIGEST_CONTENT_CAP` — how much of the converted page the digest model is shown.
    static let digestContentCap = 100_000
    /// `RESULT_CAP` — the registry's own result ceiling, enforced here because no registry does it.
    static let resultCap = 50_000
    /// `_web-fetch-html.ts`'s `WEB_FETCH_HTML_TRUNCATION_NOTICE`.
    static let htmlTruncationNotice = "\n\n[Content truncated due to length...]"
    /// The product name in the domain-floor refusal — `ctx.brand?.productName ?? WINTER_BRAND.productName`.
    static let brandName = "Winter"

    /// claude's own two guideline blocks. The permissive one is for a preapproved host; the strict one
    /// is everything else. Verbatim (interface text, not a Winter-authored prompt).
    static let permissiveGuidelines = "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed."
    static let strictGuidelines = """
    Provide a concise response based only on the content above. In your response:
     - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
     - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
     - You are not a lawyer and never comment on the legality of your own prompts and responses.
     - Never produce or reproduce exact song lyrics.
    """

    /// Everything one `WebFetch` call needs. Bundled so `ChatEngine`'s dispatch stays a short call and
    /// so a test can drive the whole tool with two doubles and no network.
    public struct Deps: Sendable {
        public let http: any ChatHTTP
        public let cache: WebFetchCache
        /// The model that reads the page and answers `prompt`. In production this is the engine's own
        /// provider (one `ResponsesClient` serves both passes); a caller may state another.
        public let digestProvider: any ChatProvider
        /// The BARE wire model id (never a provider-qualified tag) — the caller splits its own tag.
        public let digestModel: String
        public let dangerousAdded: [String]
        public let userAgent: String
        /// The PER-HOP timeout and the body cap. Defaults are claude's own (60 s, 10 MiB); a test
        /// narrows them so a cap can be crossed without moving ten megabytes.
        public let timeout: TimeInterval
        public let maxBytes: Int
        public let now: @Sendable () -> Date

        public init(http: any ChatHTTP,
                    cache: WebFetchCache,
                    digestProvider: any ChatProvider,
                    digestModel: String,
                    dangerousAdded: [String] = [],
                    userAgent: String = WebFetchNet.defaultUserAgent,
                    timeout: TimeInterval = WebFetchNet.timeout,
                    maxBytes: Int = WebFetchNet.maxBytes,
                    now: @escaping @Sendable () -> Date = { Date() }) {
            self.http = http
            self.cache = cache
            self.digestProvider = digestProvider
            self.digestModel = digestModel
            self.dangerousAdded = dangerousAdded
            self.userAgent = userAgent
            self.timeout = timeout
            self.maxBytes = maxBytes
            self.now = now
        }
    }

    /// Runs one call. NEVER throws: an executor that throws ends the user's whole turn, so every
    /// outcome — including a shape this switch has not been taught about — is a `ToolResult`.
    ///
    /// The returned `usage` is the DIGEST pass's own token spend. It is a separate provider call, so
    /// the engine adds it to the turn's billing totals and deliberately NOT to `contextTokens` (see
    /// `ChatEngine.runBody`).
    public static func run(argumentsJSON: String,
                          deps: Deps,
                          signal: ChatAbortSignal? = nil,
                          callId: String = "") async -> ToolOutcome {
        func ok(_ text: String) -> ToolOutcome {
            ToolOutcome(result: ToolResult(callId: callId, content: text, isError: false), usage: .zero)
        }
        func fail(_ text: String) -> ToolOutcome {
            ToolOutcome(result: ToolResult(callId: callId, content: text, isError: true), usage: .zero)
        }

        // --- input -------------------------------------------------------------------------------
        guard let data = argumentsJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return fail("Error: input must be an object")
        }
        guard let inputURLString = object["url"] as? String, !inputURLString.isEmpty else {
            return fail("Error: url must be a non-empty string")
        }
        guard let prompt = object["prompt"] as? String else {
            return fail("Error: prompt must be a string")
        }

        // --- the URL -----------------------------------------------------------------------------
        //
        // `new URL(x)` THROWS for a relative string, for a host that looks numeric but is not an
        // address, and for an http(s) url with no host at all; `Foundation.URL` parses all three. The
        // three guards below put the parse failure back where claude has it, so the same input reaches
        // the same text rather than falling through to the (different) fetch-time reject.
        guard let originalURL = URL(string: inputURLString), originalURL.scheme != nil else {
            return fail(WebFetchURL.parseFailureMessage(inputURLString))
        }
        let scheme = originalURL.scheme?.lowercased()
        if (scheme == "http" || scheme == "https"), WebFetchURL.bareHost(originalURL).isEmpty {
            return fail(WebFetchURL.parseFailureMessage(inputURLString))
        }
        if WebFetchURL.whatwgWouldRefuseHost(originalURL) {
            return fail(WebFetchURL.parseFailureMessage(inputURLString))
        }

        let inputHost = WebFetchURL.displayHost(originalURL)

        // Fidelity #6: no trailing period — claude's own `… is unable to fetch from ${host}` has none.
        if DangerousDomains.check(originalURL, extra: deps.dangerousAdded) != nil {
            return fail("\(brandName) is unable to fetch from \(inputHost)")
        }

        let preapproved = PreapprovedHosts.isPreapproved(originalURL)

        let content: String
        let contentType: String

        if let cached = await deps.cache.get(inputURLString, now: deps.now()) {
            // The address check runs HERE on a cache HIT only: `WebFetchNet.perform` already runs it
            // for every fresh fetch, hop 0 included. A HIT never touches the network at all, so it is
            // the one path that needs its own check — the user's added dangerous list or the address
            // the url names can change between when a page was cached and when it is served again, and
            // a cached response must not silently bypass a floor now in effect.
            if signal?.isAborted == true { return fail("WebFetch was interrupted.") }
            if PrivateAddress.isLexicallyPrivate(WebFetchURL.bareHost(originalURL)) {
                return fail(privateAddressRefusal(inputHost))
            }
            // ...AND AGAIN ON THE URL THAT WAS ACTUALLY FETCHED. The cache is keyed on the INPUT url and
            // what it stores may have come from a different host: the walk auto-follows a redirect to
            // the same host modulo a leading `www.`, so `www.` can appear or disappear between the key
            // and `finalURL`. Checking only the input host would serve content from a host the floor
            // would refuse NOW. Skipped when the two agree, which is the ordinary case.
            if let finalURL = URL(string: cached.finalURL) {
                let finalHost = WebFetchURL.displayHost(finalURL)
                if !finalHost.isEmpty, finalHost != inputHost {
                    if DangerousDomains.check(finalURL, extra: deps.dangerousAdded) != nil {
                        return fail("\(brandName) is unable to fetch from \(finalHost)")
                    }
                    if PrivateAddress.isLexicallyPrivate(WebFetchURL.bareHost(finalURL)) {
                        return fail(privateAddressRefusal(finalHost))
                    }
                }
            }
            content = cached.content
            contentType = cached.contentType
        } else {
            let outcome = await WebFetchNet.perform(
                inputURL: inputURLString,
                prompt: prompt,
                http: deps.http,
                options: WebFetchNet.Options(dangerousAdded: deps.dangerousAdded, userAgent: deps.userAgent,
                                             timeout: deps.timeout, maxBytes: deps.maxBytes),
                signal: signal)

            switch outcome {
            case .invalidURL(let message):
                return fail(message)
            case .blockedDomain(let host):
                return fail("\(brandName) is unable to fetch from \(host)")
            case .privateAddress(let host):
                return fail(privateAddressRefusal(host))
            case .redirectBlocked(let message):
                // NOT an error result, measured against the pinned binary: the fetch itself WORKED and
                // the redirect is information the model acts on (re-call with the new url), not a
                // failed tool call. `isError` would also route it to failure hooks.
                return ok(message)
            case .tooManyRedirects(let message):
                return fail(message)
            case .httpError(let status, let statusText, let retryAfter):
                let retryLine = retryAfter.map { "\nRetry-After: \($0)" } ?? ""
                // Also NOT an error result, for the same reason as a redirect: the server answered, and
                // its answer is something to act on (try an authenticated tool, wait out a Retry-After).
                return ok("The server returned HTTP \(status) \(statusText).\(retryLine)\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.")
            case .sizeExceeded(let message):
                return fail(message)
            case .timeout(let message):
                return fail(message)
            case .aborted:
                return fail("WebFetch was interrupted.")
            case .networkError(let message):
                return fail("WebFetch could not reach the URL: \(message)")
            case .success(let finalURL, let status, let statusText, let rawContentType, let body):
                switch classifyContentType(rawContentType) {
                case .html:
                    content = htmlToText(String(decoding: body, as: UTF8.self))
                case .text:
                    content = String(decoding: body, as: UTF8.self)
                case .binary:
                    // No session temp directory exists on the phone, so this is always the "not
                    // retrieved" arm of the SDK's three (never the "saved to <path>" one), and nothing
                    // is written. Not an error result — the fetch worked.
                    let label = "\(WebFetchURL.groupedEnUS(body.count)) bytes"
                    return ok("The fetched content is binary (content-type: \(rawContentType.isEmpty ? "unknown" : rawContentType), \(label)). Binary content was not retrieved: no session temp directory is available in this context.")
                }
                contentType = rawContentType
                // Binary responses are never cached (the SDK's own deliberate deviation): the note names
                // an ephemeral path, and re-serving it could point at a file that is already gone.
                await deps.cache.set(inputURLString,
                                     WebFetchCache.Entry(content: content,
                                                         contentType: contentType,
                                                         finalURL: finalURL,
                                                         status: status,
                                                         statusText: statusText),
                                     now: deps.now())
            }
        }

        // The preapproved verbatim passthrough: skip the digest model entirely. The ONLY path on which
        // raw page text reaches a tool_result, and claude's own.
        if preapproved, contentType.lowercased().contains("text/markdown"), truncateUTF16Count(content) < 100_000 {
            return ok(capResult(content))
        }

        let digest = await runDigest(content: content, prompt: prompt, preapproved: preapproved,
                                    deps: deps, signal: signal)
        return ToolOutcome(
            result: ToolResult(callId: callId, content: capResult(digest.text), isError: digest.isError),
            usage: digest.usage)
    }

    // MARK: - refusals

    /// The `deny` arm of the SDK's `privateAddressRefusal`, which is the only arm this engine has.
    ///
    /// The `FETCHABLE_TARGET_SHAPE` tail is appended for a LEXICALLY private host, which TODAY is every
    /// private host there can be — lexical is the only classification this engine does, so the tail is
    /// in practice unconditional (the SDK's own `deny` branch is the same shape; the conditional is
    /// there because the SDK's LATE case, private by resolution only, omits it, and that case becomes
    /// reachable the day DNS classification does).
    static func privateAddressRefusal(_ host: String) -> String {
        var bare = host
        if bare.hasPrefix("["), bare.hasSuffix("]") { bare = String(bare.dropFirst().dropLast()) }
        let shape = PrivateAddress.isLexicallyPrivate(bare) ? " \(WebFetchURL.fetchableTargetShape)" : ""
        return "WebFetch will not reach \(host): it is a private/loopback address, and this session's policy denies WebFetch access to private addresses.\(shape)"
    }

    // MARK: - content

    enum ContentKind { case html, text, binary }

    /// Fidelity #10: claude converts ONLY when the content type includes `text/html` — NOT
    /// `application/xhtml+xml`, which falls through to the plain "text" branch as raw UTF-8.
    static func classifyContentType(_ contentType: String) -> ContentKind {
        let ct = contentType.lowercased()
        if ct.contains("text/html") { return .html }
        if ct.isEmpty || ct.hasPrefix("text/") || ct.contains("json") || ct.contains("xml")
            || ct.contains("javascript") || ct.contains("csv") { return .text }
        return .binary
    }

    static func capResult(_ text: String) -> String {
        guard truncateUTF16Count(text) > resultCap else { return text }
        return truncateUTF16(text, to: resultCap) + "\n\n[Result truncated at \(WebFetchURL.groupedEnUS(resultCap)) characters.]"
    }

    // MARK: - the digest pass

    /// claude's own digest template, verbatim — leading newline, `---` fences, the caller's prompt, then
    /// the guidelines, then a trailing newline.
    static func digestPrompt(content: String, prompt: String, guidelines: String) -> String {
        "\nWeb page content:\n---\n\(content)\n---\n\n\(prompt)\n\n\(guidelines)\n"
    }

    static func cappedForDigest(_ content: String) -> String {
        truncateUTF16Count(content) > digestContentCap
            ? truncateUTF16(content, to: digestContentCap) + htmlTruncationNotice
            : content
    }

    struct Digest { let text: String; let isError: Bool; let usage: ToolUsage }

    /// ONE generation, no tools, no thinking, no system prompt — an extraction pass, not a reasoning
    /// one, and the SDK sends no `system` for it either.
    private static func runDigest(content: String,
                                 prompt: String,
                                 preapproved: Bool,
                                 deps: Deps,
                                 signal: ChatAbortSignal?) async -> Digest {
        let built = digestPrompt(content: cappedForDigest(content),
                                 prompt: prompt,
                                 guidelines: preapproved ? permissiveGuidelines : strictGuidelines)
        let request = ProviderTurnRequest(model: deps.digestModel,
                                          instructions: nil,
                                          input: [.message(role: .user, content: built)],
                                          tools: [],
                                          reasoningEffort: nil)
        if signal?.isAborted == true {
            return Digest(text: "WebFetch was interrupted.", isError: true, usage: .zero)
        }

        let stream = deps.digestProvider.streamTurn(request)
        let task = Task { () -> (text: String, usage: ToolUsage, failed: Bool) in
            var text = ""
            var usage = ToolUsage.zero
            var failed = false
            for await event in stream {
                switch event {
                case .textDelta(let delta): text += delta
                case .usage(let input, let output):
                    usage = ToolUsage(inputTokens: usage.inputTokens + input,
                                      outputTokens: usage.outputTokens + output)
                case .error: failed = true
                case .reasoningItem, .toolCall, .done: break
                }
            }
            return (text, usage, failed)
        }
        let registration = signal?.onAbort { task.cancel() }
        defer { registration?.cancel() }
        let outcome = await task.value

        if signal?.isAborted == true {
            return Digest(text: "WebFetch was interrupted.", isError: true, usage: outcome.usage)
        }
        if outcome.failed {
            // A FIXED sentence, never the provider's own message: it is built from an underlying failure
            // and a probe found a proxy URL with embedded credentials reaching this exact path. Every
            // other string in this file is Winter-authored or claude's rather than server-supplied.
            return Digest(text: "The digest model failed.", isError: true, usage: outcome.usage)
        }
        // KNOWN, DISCLOSED DIFFERENCE, inherited from the SDK: claude tells an assistant message with NO
        // text block (`No response from model`) apart from one with an EMPTY text block. The provider
        // seam folds a turn's text out of deltas, so both arrive as `""` and both get this one text —
        // which is still better than returning "" and reaching the next request with an empty result.
        return outcome.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Digest(text: "No response from model", isError: false, usage: outcome.usage)
            : Digest(text: outcome.text, isError: false, usage: outcome.usage)
    }
}
