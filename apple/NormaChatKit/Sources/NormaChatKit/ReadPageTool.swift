import Foundation

/// ReadPage — chat's batched page-reading tool, the Swift port of
/// `packages/core/src/agent/tools/read-page.ts`. A registered wrapper around Task 6's `PageFetcher`
/// (fetch → clean → line-number → cache).
///
/// CITE THE RESOLVED URL, EVERYWHERE: `PageCache` keys on the FINAL, post-redirect `CleanPage.url`,
/// so every header states the input once (as `requested: X → resolved: Y`, ONLY when they differ)
/// and cites `page.resolvedURL` everywhere else — that is what keeps a later `lineStart`/`lineEnd`
/// follow-up landing in the same cache entry.
///
/// An entry with a `query` (instead of a line range) delegates to the ephemeral research sub-agent
/// (`ResearchRunner`), which returns a finished, cited report as that entry's text. Absent a wired
/// research hook, a `query` entry resolves to `RESEARCH_UNAVAILABLE`.
public enum ReadPageTool {
    static let maxPages = 8
    /// read-page.ts READPAGE_PER_PAGE_CHAR_CAP — one page's rendered section incl. its Links tail.
    public static let perPageCharCap = 20_000
    /// read-page.ts READPAGE_TOTAL_OUTPUT_CHAR_CAP — the whole batch (chat has no `read` tool, so
    /// whatever this returns inline is all the model gets).
    public static let totalOutputCharCap = 60_000
    static let researchUnavailable = "research is not available in this session yet"

    /// What ReadPage calls for a `query` entry. Absent → `RESEARCH_UNAVAILABLE`. The wiring layer
    /// (Task 8) captures a `ResearchRunner` + provider + deadline behind this closure; the returned
    /// `ToolResult`'s `isError` decides whether the entry counts as a success in the batch.
    public typealias ResearchHook = @Sendable (_ query: String, _ url: String, _ maxPages: Int?, _ signal: ChatAbortSignal?) async -> ToolResult

    private struct EntryResult { let ok: Bool; let text: String }

    /// Decodes the batch args itself (unlike `Search`, whose one `query` the caller decodes) — the
    /// `pages` shape is a validated batch, so validation lives here and a malformed batch is one
    /// `isError` result. `dangerousAdded` is the user-added half of the effective list, used for
    /// ReadPage's own pre-fetch refusal (the shipped floor is applied by `PageFetcher` too).
    public static func run(argumentsJSON: String,
                           fetcher: PageFetcher,
                           research: ResearchHook? = nil,
                           dangerousAdded: [String] = [],
                           signal: ChatAbortSignal? = nil,
                           callId: String = "") async -> ToolResult {
        func fail(_ message: String) -> ToolResult { ToolResult(callId: callId, content: message, isError: true) }

        let pages: [PageRequest]
        do {
            pages = try decodePages(argumentsJSON)
        } catch let error as ArgError {
            return fail(error.message)
        } catch {
            return fail("invalid ReadPage arguments — could not parse JSON")
        }

        // Each entry is independent — one bad url can never take the others down. Order is preserved
        // for the "## Page N" labels.
        let results = await withTaskGroup(of: (Int, EntryResult).self) { group -> [EntryResult] in
            for (index, entry) in pages.enumerated() {
                group.addTask {
                    let result: EntryResult
                    if entry.query != nil {
                        result = await runResearch(entry, research: research, dangerousAdded: dangerousAdded, signal: signal)
                    } else {
                        result = await renderPage(entry, fetcher: fetcher, dangerousAdded: dangerousAdded, signal: signal)
                    }
                    return (index, result)
                }
            }
            var collected = [EntryResult?](repeating: nil, count: pages.count)
            for await (index, result) in group { collected[index] = result }
            return collected.compactMap { $0 }
        }

        let anyOk = results.contains { $0.ok }
        // A single entry returns its text bare; a batch labels each section so a mixed success/
        // failure batch stays legible.
        var combined = results.count == 1
            ? results[0].text
            : results.enumerated().map { "## Page \($0.offset + 1)\n\($0.element.text)" }.joined(separator: "\n\n---\n\n")
        combined = capText(combined, cap: totalOutputCharCap, marker: "\n\n[batch output truncated]")

        // Only a batch where EVERY entry failed is an isError result — one bad entry never fails the
        // whole batch.
        return ToolResult(callId: callId, content: combined, isError: !anyOk)
    }

    // MARK: - one plain (non-query) entry

    private static func renderPage(_ entry: PageRequest, fetcher: PageFetcher,
                                   dangerousAdded: [String], signal: ChatAbortSignal?) async -> EntryResult {
        // Pre-fetch dangerous-domain refusal, with ReadPage-specific wording — NO network reached,
        // no card (chat has no approval flow). A redirect INTO a dangerous host is caught by the
        // fetcher's own post-redirect re-check.
        if let hit = DangerousDomains.check(entry.url, extra: dangerousAdded) {
            return EntryResult(ok: false, text: DangerousDomains.refusal(
                url: entry.url, hit: hit,
                cannotAskReason: "ReadPage has no approval flow to ask for one, so fetches to known exfiltration/tunnel-provider hosts are blocked outright"))
        }
        do {
            let page = try await fetcher.fetch(url: entry.url, origin: .user, signal: signal)
            let rendered = renderLines(page, lineStart: entry.lineStart, lineEnd: entry.lineEnd)
            let newlineIdx = rendered.firstIndex(of: "\n")
            let headerLine = newlineIdx.map { String(rendered[..<$0]) } ?? rendered
            let body = newlineIdx.map { String(rendered[rendered.index(after: $0)...]) } ?? ""

            // Reuse renderLines' own "lines X-Y of Z" rather than re-deriving the clamp, reformatted
            // with this tool's `lines:N-M` citation colon.
            let (start, end, total) = parseRange(headerLine, fallbackTotal: page.lines.count)

            // State the input once, only when it actually differed; cite `resolvedURL` everywhere
            // else — the address the shared cache is keyed on.
            let urlLine = entry.url == page.resolvedURL ? page.resolvedURL : "requested: \(entry.url) → resolved: \(page.resolvedURL)"

            // Strip dangerous-domain links from the Links tail before the model sees them (same
            // rationale as Search's stripped results); state the withheld count.
            var linksWithheld = 0
            let safeLinks = page.links.filter { link in
                if !DangerousDomains.matches(link.href, extra: dangerousAdded) { return true }
                linksWithheld += 1
                return false
            }
            let withheldNote = linksWithheld > 0
                ? "(\(linksWithheld) link\(linksWithheld == 1 ? "" : "s") withheld — matched the dangerous-domain list)"
                : nil
            let linksList: String
            if !safeLinks.isEmpty {
                let list = safeLinks.enumerated().map { "\($0.offset + 1). \($0.element.text.isEmpty ? "(no text)" : $0.element.text) (\($0.element.href))" }.joined(separator: "\n")
                linksList = list + (withheldNote.map { "\n\($0)" } ?? "")
            } else {
                linksList = withheldNote ?? "(none)"
            }

            // `(cached)` vs `(fresh fetch)` — the model has no other way to tell a cached read from a
            // fresh refetch, since the two renders are otherwise byte-identical.
            let freshness = page.fromCache ? "cached" : "fresh fetch"
            let text = capText(
                [urlLine, "\(page.title) — lines:\(start)-\(end) of \(total) (\(freshness))", body, "", "Links:", linksList].joined(separator: "\n"),
                cap: perPageCharCap,
                marker: "\n[page output truncated at \(perPageCharCap) chars — request a narrower lineStart/lineEnd]")
            return EntryResult(ok: true, text: text)
        } catch let error as PageFetchError {
            // Cite the INPUT url (there is no resolved one — the fetch never succeeded).
            return EntryResult(ok: false, text: "\(entry.url): \(error.message)")
        } catch {
            return EntryResult(ok: false, text: "\(entry.url): \(error.localizedDescription)")
        }
    }

    // MARK: - one query (research) entry

    private static func runResearch(_ entry: PageRequest, research: ResearchHook?,
                                    dangerousAdded: [String], signal: ChatAbortSignal?) async -> EntryResult {
        guard let research else { return EntryResult(ok: false, text: researchUnavailable) }
        // The SEED url is dangerous-checked before the sub-agent is ever started — a query entry
        // pointed at a blocked host must not even begin research.
        if let hit = DangerousDomains.check(entry.url, extra: dangerousAdded) {
            return EntryResult(ok: false, text: DangerousDomains.refusal(
                url: entry.url, hit: hit,
                cannotAskReason: "research has no approval flow to ask for one, so a blocked seed page is refused outright"))
        }
        let result = await research(entry.query!, entry.url, entry.maxPages, signal)
        return EntryResult(ok: !result.isError, text: result.content)
    }

    // MARK: - arg decoding + validation

    struct PageRequest {
        let url: String
        let query: String?
        let lineStart: Int?
        let lineEnd: Int?
        let maxPages: Int?
    }

    struct ArgError: Error { let message: String }

    private struct RawArgs: Decodable { let pages: [RawPage] }
    private struct RawPage: Decodable {
        let url: String
        let query: String?
        let lineStart: Int?
        let lineEnd: Int?
        let max_pages: Int?
    }

    private static func decodePages(_ argumentsJSON: String) throws -> [PageRequest] {
        guard let data = argumentsJSON.data(using: .utf8) else { throw ArgError(message: "invalid ReadPage arguments — could not parse JSON") }
        let raw: RawArgs
        do {
            raw = try JSONDecoder().decode(RawArgs.self, from: data)
        } catch {
            throw ArgError(message: "invalid ReadPage arguments — expected { pages: [{ url }] }")
        }
        guard !raw.pages.isEmpty else { throw ArgError(message: "invalid ReadPage arguments — pages must have 1 to \(maxPages) entries") }
        guard raw.pages.count <= maxPages else { throw ArgError(message: "invalid ReadPage arguments — pages must have 1 to \(maxPages) entries") }
        return try raw.pages.map { page in
            guard !page.url.isEmpty else { throw ArgError(message: "invalid ReadPage arguments — every page needs a non-empty url") }
            if page.query != nil, (page.lineStart != nil || page.lineEnd != nil) {
                throw ArgError(message: "query and line ranges are mutually exclusive per entry")
            }
            if let start = page.lineStart, start <= 0 { throw ArgError(message: "invalid ReadPage arguments — lineStart must be positive") }
            if let end = page.lineEnd, end <= 0 { throw ArgError(message: "invalid ReadPage arguments — lineEnd must be positive") }
            if let query = page.query, query.isEmpty { throw ArgError(message: "invalid ReadPage arguments — query must be non-empty") }
            return PageRequest(url: page.url, query: page.query, lineStart: page.lineStart, lineEnd: page.lineEnd, maxPages: page.max_pages)
        }
    }

    /// Pulls "lines X-Y of Z" out of `renderLines`' header. Falls back to `1`/`fallbackTotal` when
    /// the header lacks it (the 0-line `title (0 lines)` shape) — mirrors `read-page.ts`'s fallbacks.
    private static func parseRange(_ header: String, fallbackTotal: Int) -> (String, String, String) {
        guard let match = rangeRegex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
              match.numberOfRanges == 4,
              let r1 = Range(match.range(at: 1), in: header),
              let r2 = Range(match.range(at: 2), in: header),
              let r3 = Range(match.range(at: 3), in: header) else {
            return ("1", String(fallbackTotal), String(fallbackTotal))
        }
        return (String(header[r1]), String(header[r2]), String(header[r3]))
    }

    private static let rangeRegex = try! NSRegularExpression(pattern: "lines ([0-9]+)-([0-9]+) of ([0-9]+)")
}

// MARK: - renderLines (shared with ResearchRunner's pageSection)

/// Numbered `N→text` rendering (1-based), the whole page when no range is given — the Swift port of
/// `page-core.ts`'s `renderLines`. Out-of-bounds/inverted ranges clamp to `[1, lines.count]` and the
/// header says so, rather than throwing or returning empty on a caller's stale/miscounted range.
func renderLines(_ page: CleanPage, lineStart: Int? = nil, lineEnd: Int? = nil) -> String {
    let total = page.lines.count
    if total == 0 { return "\(page.title) (0 lines)" }

    let reqStart = lineStart ?? 1
    let reqEnd = lineEnd ?? total
    let start = min(max(reqStart, 1), total)
    let end = min(max(reqEnd, start), total)
    let clamped = start != reqStart || end != reqEnd

    var body: [String] = []
    body.reserveCapacity(end - start + 1)
    for i in start ... end { body.append("\(i)→\(page.lines[i - 1])") }

    let header = clamped
        ? "\(page.title) (lines \(start)-\(end) of \(total) — requested \(reqStart)-\(reqEnd), clamped)"
        : "\(page.title) (lines \(start)-\(end) of \(total))"

    return ([header] + body).joined(separator: "\n")
}

// MARK: - shared truncation (JS `.length`/`.slice` semantics, marker reserved)

/// Truncates `text` to at most `cap` UTF-16 units TOTAL (including `marker`) — never drops the
/// marker over the limit (its length is reserved up front). The Swift port of read-page.ts's
/// `capText` / research.ts's `capWithMarker`.
func capText(_ text: String, cap: Int, marker: String) -> String {
    let units = Array(text.utf16)
    guard units.count > cap else { return text }
    let keep = max(0, cap - marker.utf16.count)
    return String(decoding: units[0 ..< keep], as: UTF16.self) + marker
}
