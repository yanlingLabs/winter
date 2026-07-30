import Foundation

/// Chat's Exa-backed web search — the Swift port of `packages/core/src/agent/tools/search.ts`.
///
/// One `POST https://api.exa.ai/search` returns each result WITH its excerpt inline (`contents:
/// { text: { maxCharacters } }` rides the SAME request body), so chat gets results + excerpts in a
/// SINGLE call rather than code mode's two-step web_search + web_fetch. There is no `read` tool in
/// chat, so whatever this returns inline is ALL the model gets — the output is hard-capped.
///
/// TWO security properties are ported verbatim, and both are pinned by tests:
///   1. **The API key never appears in any error string.** The real transport can embed a bad
///      header VALUE in its own error text; this tool never interpolates a caught error into the
///      model-visible result — every failure message is static. (`search.ts`'s `replaceAll(key, …)`
///      redaction has nothing to redact here because nothing dynamic is built.)
///   2. **Dangerous-domain results are STRIPPED before the model sees them, and the withheld count
///      is STATED.** Advertising a link the page-read hard-block would refuse anyway is a
///      half-measure (the model tries it, fails, retries); a shorter list must read as a deliberate
///      filter, never an incomplete one.
public enum SearchTool {
    static let requestTimeout: TimeInterval = 15 // search.ts REQUEST_TIMEOUT_MS
    static let defaultResults = 5
    static let maxResults = 10
    static let excerptChars = 1200 // search.ts EXCERPT_CHARS — per result, also asked of Exa server-side
    static let totalOutputChars = 30_000 // search.ts TOTAL_OUTPUT_CHARS — whole-response cap
    static let searchURL = URL(string: "https://api.exa.ai/search")!
    /// A generous ceiling on the Exa JSON body — the excerpts are already server-capped, so this
    /// only ever bites a hostile response. Uses `sendCapped` (non-redirect-following, byte-capped)
    /// rather than `send` for the same reason `search.ts` sets `redirect: "manual"`: a 3xx must
    /// never carry `x-api-key` onward to a host outside Exa's control.
    static let maxResponseBytes = 5 * 1024 * 1024

    static let noKeyMessage = "Search needs an API key — store one with: norma login --exa-key (from exa.ai)"

    /// Runs one search. `key` is the Exa API key (nil/empty → the no-key error); `http` is the kit's
    /// one egress seam. `dangerousAdded` is the user-added half of the effective dangerous-domain
    /// list (the shipped floor always applies). `callId` defaults empty — ChatEngine rebinds it.
    public static func run(query: String,
                           key: String?,
                           http: any ChatHTTP,
                           maxResults requestedMax: Int? = nil,
                           dangerousAdded: [String] = [],
                           signal: ChatAbortSignal? = nil,
                           callId: String = "") async -> ToolResult {
        func fail(_ message: String) -> ToolResult { ToolResult(callId: callId, content: message, isError: true) }

        guard let key, !key.isEmpty else { return fail(noKeyMessage) }

        let count = min(max(requestedMax ?? defaultResults, 1), maxResults)

        var request = URLRequest(url: searchURL)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = requestTimeout
        request.httpBody = encodeBody(query: query, numResults: count)

        let capped: CappedResponse
        do {
            capped = try await sendCancellable(request, http: http, signal: signal)
        } catch {
            // NEVER interpolate the caught error: the transport can embed a bad header value in its
            // message, and that value must not reach the model or any agent-readable log. A caller
            // abort or a timeout is reported as such; anything else is a static reach-failure.
            if signal?.isAborted == true || PageFetcher.isAbortLike(error) {
                return fail("search timed out for \(query)")
            }
            return fail("search failed: could not reach the search service")
        }

        guard capped.response.statusCode == 200 else {
            return fail("search failed: HTTP \(capped.response.statusCode)")
        }

        // Lenient shape-checking, mirroring `search.ts`'s `isValidExaResults`: a non-object body or
        // an absent `results` → no results (ok); a `results` that is not an array, or an array with
        // any non-object element → parse_error.
        let json = try? JSONSerialization.jsonObject(with: capped.body)
        let rawResults: [[String: Any]]
        if let object = json as? [String: Any] {
            if let resultsValue = object["results"] {
                guard let array = resultsValue as? [Any] else {
                    return fail("search failed: malformed response from search service")
                }
                var parsed: [[String: Any]] = []
                for item in array {
                    guard let dict = item as? [String: Any] else {
                        return fail("search failed: malformed response from search service")
                    }
                    parsed.append(dict)
                }
                rawResults = parsed
            } else {
                rawResults = []
            }
        } else if json == nil {
            return fail("search failed: could not parse response")
        } else {
            rawResults = [] // a non-object body (e.g. a bare array) → `.results` undefined → no results
        }

        let sliced = Array(rawResults.prefix(count))

        // Strip dangerous results BEFORE they reach the model; state the withheld count so a shorter
        // list reads as a deliberate filter, never a silent drop.
        var withheld = 0
        let results = sliced.filter { result in
            guard let url = result["url"] as? String, DangerousDomains.matches(url, extra: dangerousAdded) else { return true }
            withheld += 1
            return false
        }
        let withheldNote = withheld > 0
            ? "\n\n[\(withheld) result\(withheld == 1 ? "" : "s") withheld — matched the dangerous-domain list]"
            : ""

        if results.isEmpty {
            return ToolResult(callId: callId, content: "no results for \(query)\(withheldNote)", isError: false)
        }

        let rendered = results.enumerated().map { index, result -> String in
            let title = (result["title"] as? String) ?? "-"
            let url = (result["url"] as? String) ?? "-"
            let excerptRaw = (result["text"] as? String) ?? ""
            let excerpt = truncateUTF16(excerptRaw, to: excerptChars).trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(index + 1). \(title)\n   \(url)\n   \(excerpt.isEmpty ? "(no excerpt)" : excerpt)"
        }.joined(separator: "\n\n")

        // Hard cap: chat has no save-to-file escape hatch, so this is a correctness bound, not just
        // safety. `search.ts`'s marker rides a few bytes past its own cap (slice-then-append) — kept
        // identical here rather than reserving the marker length as ReadPage/Research do.
        let capped2 = truncateUTF16Count(rendered) > totalOutputChars
            ? truncateUTF16(rendered, to: totalOutputChars) + "\n\n[results truncated]"
            : rendered
        return ToolResult(callId: callId, content: capped2 + withheldNote, isError: false)
    }

    // MARK: - request body

    private struct ExaBody: Encodable {
        let query: String
        let numResults: Int
        let contents: Contents
        struct Contents: Encodable {
            let text: Text
            struct Text: Encodable { let maxCharacters: Int }
        }
    }

    private static func encodeBody(query: String, numResults: Int) -> Data {
        let body = ExaBody(query: query, numResults: numResults,
                           contents: .init(text: .init(maxCharacters: excerptChars)))
        return (try? JSONEncoder().encode(body)) ?? Data()
    }

    /// One hop, non-redirect-following (`sendCapped`), with the external signal wired to tear the
    /// request down — the same task-cancellation bridge `PageFetcher.send` uses.
    private static func sendCancellable(_ request: URLRequest, http: any ChatHTTP,
                                        signal: ChatAbortSignal?) async throws -> CappedResponse {
        if signal?.isAborted == true { throw ChatAbortError.aborted }
        let task = Task { try await http.sendCapped(request, maxBytes: maxResponseBytes) }
        let registration = signal?.onAbort { task.cancel() }
        defer { registration?.cancel() }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            signal?.abort()
            task.cancel()
        }
    }
}

// MARK: - UTF-16 length helpers (JS `.length`/`.slice` semantics)

/// JS `String.prototype.length` is UTF-16 code units; the char caps here are stated in those units,
/// so measuring and slicing on `.utf16` keeps the boundaries identical to the TS.
func truncateUTF16Count(_ text: String) -> Int { text.utf16.count }

/// `text.slice(0, n)` in UTF-16 units. A slice that would split a surrogate pair yields U+FFFD for
/// the lone half (String(decoding:as:) substitutes) — harmless for a display/safety cap.
func truncateUTF16(_ text: String, to n: Int) -> String {
    let units = Array(text.utf16)
    guard units.count > n else { return text }
    return String(decoding: units[0 ..< max(0, n)], as: UTF16.self)
}
