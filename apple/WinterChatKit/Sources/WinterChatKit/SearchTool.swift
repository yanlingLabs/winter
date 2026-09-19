import Foundation

/// Chat's Exa-backed web search — the Swift port of `packages/core/src/agent/tools/search.ts`.
///
/// **ANSWER MODE** (the 2026-09-18 ruling, which retired the `/search` shape this file used to
/// carry): one `POST https://api.exa.ai/answer` runs a search AND writes a grounded answer over the
/// results, so the model gets a finished, cited answer in a single call rather than rows to chase.
/// That is the whole reason this tool exists beside the runtime's own `WebSearch`: chat's model is
/// small and `WebSearch` hands it links.
///
/// ONE FIELD, AND THAT IS THE SCHEMA. The `/search` era's `max_results` is gone with the endpoint:
/// `/answer` returns an answer, not a page of rows, and how many sources it consulted is the
/// provider's judgement, not a caller's dial. Every other Exa request field (`model`, `systemPrompt`,
/// `text`, …) is deliberately unexposed, exactly as the daemon's copy leaves them.
///
/// `/answer` REQUIRES a key, so this tool's PRESENCE is gated on one being stored — `ChatEngine`
/// advertises `Search` only when `ChatToolset.exaKey` is non-empty, mirroring the daemon's two doors
/// (`capabilities/research.ts` and `disallowedToolsFor`). The `noKey` branch below is therefore
/// unreachable through a real session and is kept anyway: a typed, actionable failure is the right
/// answer for a direct caller and for the window between a key being removed and the next turn.
///
/// TWO security properties are ported verbatim, and both are pinned by tests:
///   1. **The API key never appears in any error string.** The real transport can embed a bad header
///      VALUE in its own error text; this tool never interpolates a caught error into the
///      model-visible result — every failure message is static or derived from the status code alone.
///      A provider's own error BODY never crosses into the result either: it can echo request
///      headers (and therefore the key) and is attacker-influenced text besides.
///   2. **Dangerous-domain citations are STRIPPED before the model sees them, and the withheld count
///      is STATED.** Citing a floor-listed page while blocking every read of it is a half-measure —
///      the model would just try the link, fail, and retry — and a shorter source list must read as
///      a deliberate filter, never an incomplete one.
public enum SearchTool {
    /// `search.ts` REQUEST_TIMEOUT_MS. `/answer` SYNTHESIZES — it searches and then writes — so it is
    /// materially slower than the old `/search` round trip; the 15 s that endpoint was tuned for
    /// would time out answers that were going to arrive.
    static let requestTimeout: TimeInterval = 45
    /// `search.ts` ANSWER_CHARS — the synthesized answer itself.
    static let answerChars = 24_000
    /// `search.ts` MAX_CITATIONS — rendered as a sources list; the provider decides how many it used.
    static let maxCitations = 20
    /// `search.ts` TOTAL_OUTPUT_CHARS — whole-response cap. Chat has no page-reading escape hatch on
    /// the answer, so this is a correctness bound, not just a safety one.
    static let totalOutputChars = 30_000
    static let answerURL = URL(string: "https://api.exa.ai/answer")!
    /// A generous ceiling on the Exa JSON body — the answer is already server-bounded, so this only
    /// ever bites a hostile response. Uses `sendCapped` (non-redirect-following, byte-capped) rather
    /// than `send` for the same reason `search.ts` sets `redirect: "manual"`: a 3xx must never carry
    /// `x-api-key` onward to a host outside Exa's control.
    static let maxResponseBytes = 5 * 1024 * 1024

    // T7-review M1: `public` so the phone's own reword can reach it (chat has no CLI `winter login`).
    public static let noKeyMessage = "Search needs an API key — store one with: winter login --exa-key (from exa.ai)"

    /// Runs one search. `key` is the Exa API key (nil/empty → the no-key error); `http` is the kit's
    /// one egress seam. `dangerousAdded` is the user-added half of the effective dangerous-domain
    /// list (the shipped floor always applies). `callId` defaults empty — ChatEngine rebinds it.
    public static func run(query: String,
                           key: String?,
                           http: any ChatHTTP,
                           dangerousAdded: [String] = [],
                           signal: ChatAbortSignal? = nil,
                           callId: String = "") async -> ToolResult {
        func fail(_ message: String) -> ToolResult { ToolResult(callId: callId, content: message, isError: true) }

        guard let key, !key.isEmpty else { return fail(noKeyMessage) }

        var request = URLRequest(url: answerURL)
        request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = requestTimeout
        request.httpBody = encodeBody(query: query)

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
            // ACTIONABLE, and never the provider's own body — only the status code crosses over,
            // mapped to the one sentence that says what to DO.
            return fail(statusMessage(capped.response.statusCode))
        }

        let json = try? JSONSerialization.jsonObject(with: capped.body)
        guard let object = json as? [String: Any] else {
            // A body that is valid JSON but not an object carries neither `answer` nor `citations`,
            // so it is the same "this renderer cannot speak for that shape" case as an unparseable
            // one. `search.ts` reaches the identical outcome by indexing `undefined` off a non-object
            // and then finding an empty answer with no citations — this states it once instead.
            return fail("search failed: could not parse response")
        }

        // Shape-checking, mirroring `search.ts`'s `isValidExaCitations`: absent is fine; anything that
        // is not an array of non-null objects is a parse error, so the render below can never throw.
        let rawCitationsValue = object["citations"]
        var citationDicts: [[String: Any]] = []
        if let rawCitationsValue, !(rawCitationsValue is NSNull) {
            guard let array = rawCitationsValue as? [Any] else {
                return fail("search failed: malformed response from search service")
            }
            for item in array {
                guard let dict = item as? [String: Any] else {
                    return fail("search failed: malformed response from search service")
                }
                citationDicts.append(dict)
            }
        }

        // `answer` is a string unless `outputSchema` was sent, which this tool never sends. Anything
        // else is a shape this renderer cannot speak for, so it is a parse error rather than a
        // `String(describing:)` that would hand the model `[object Object]` labelled as an answer.
        let rawAnswer = object["answer"]
        var fullAnswer = ""
        if let rawAnswer, !(rawAnswer is NSNull) {
            guard let text = rawAnswer as? String else {
                return fail("search failed: malformed response from search service")
            }
            fullAnswer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // NEVER a silent slice: an answer cut mid-sentence reads as a complete one, and a model that
        // cannot tell the difference will present half a conclusion as the whole of it.
        let answer = truncateUTF16Count(fullAnswer) > answerChars
            ? truncateUTF16(fullAnswer, to: answerChars) + "\n\n[answer truncated]"
            : fullAnswer

        // The dangerous-domain floor, applied to the CITED urls. Never a SILENT drop: the withheld
        // count is always stated, so the model (and anyone reading the transcript) knows the source
        // list was filtered, not merely short.
        var withheld = 0
        let citations = citationDicts.prefix(maxCitations).filter { citation in
            guard let url = citation["url"] as? String,
                  DangerousDomains.matches(url, extra: dangerousAdded) else { return true }
            withheld += 1
            return false
        }
        let withheldNote = withheld > 0
            ? "\n\n[\(withheld) source\(withheld == 1 ? "" : "s") withheld — matched the dangerous-domain list]"
            : ""

        if answer.isEmpty {
            return ToolResult(callId: callId, content: "no answer for \(query)\(withheldNote)", isError: false)
        }

        // An answer with NOTHING left to attribute is still the answer — the user asked a question
        // and a refusal here would be a worse outcome than an honest label. It is MARKED, because an
        // unsourced answer is exactly the one a model must not present as cited fact.
        let sources: String
        if citations.isEmpty {
            let why = withheld > 0
                ? "every source was withheld by the dangerous-domain list"
                : "the search service returned no sources"
            sources = "\n\n[unsourced — \(why); say so if you repeat this]"
        } else {
            sources = "\n\nSources:\n" + citations.enumerated().map { index, citation -> String in
                let rawTitle = (citation["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let title = rawTitle.isEmpty ? "-" : rawTitle
                let url = (citation["url"] as? String) ?? "-"
                return "\(index + 1). \(title)\n   \(url)"
            }.joined(separator: "\n")
        }

        let rendered = answer + sources
        let cappedOutput = truncateUTF16Count(rendered) > totalOutputChars
            ? truncateUTF16(rendered, to: totalOutputChars) + "\n\n[truncated]"
            : rendered
        return ToolResult(callId: callId, content: cappedOutput + withheldNote, isError: false)
    }

    // MARK: - request body

    private struct ExaAnswerBody: Encodable {
        let query: String
    }

    private static func encodeBody(query: String) -> Data {
        (try? JSONEncoder().encode(ExaAnswerBody(query: query))) ?? Data()
    }

    // MARK: - status → one actionable sentence

    /// `search.ts`'s `statusMessage`: one sentence per documented failure, each naming the action that
    /// clears it. Deliberately the ONLY thing derived from a failed response — never its body.
    static func statusMessage(_ status: Int) -> String {
        switch status {
        case 401, 403:
            return "search failed: the stored Exa API key was rejected — replace it with `winter credentials set exa` (or `winter login --exa-key`)"
        case 402:
            return "search failed: this Exa account is out of credits or over its budget — top it up at exa.ai, or answer from what you already know and say the search was unavailable"
        case 429:
            return "search failed: the search service is rate-limiting this key — wait a little before searching again, and do not retry in a loop"
        case 400:
            return "search failed: the search service rejected the request as malformed — try a plainer question"
        default:
            return "search failed: the search service is unavailable (HTTP \(status))"
        }
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
