import Foundation

/// The ephemeral research sub-agent — the Swift port of `packages/core/src/agent/research.ts`. A
/// plain, radically reduced turn-loop over `provider.streamTurn` (gather events → collect tool
/// calls → dispatch → feed results back → repeat until done), with everything session-shaped
/// stripped out: no store, no hub, no persisted events, no session identity at all. `run()` is
/// fire-and-return; the whole loop's state lives on one call's stack and is gone the instant the
/// returned value settles.
///
/// `FetchPage` is this runner's ONLY tool, and that is a STRUCTURAL fact, not a prompt instruction:
/// every `ProviderTurnRequest` it builds carries exactly `[fetchPageTool]`, and a scripted-provider
/// test asserts `request.tools.map(\.name) == ["FetchPage"]`. It never touches any shared registry.
///
/// GENUINE cancellation, unlike the TS's `raceDeadline` polyfill: the deadline drives a real
/// `ChatAbortSignal`, and every in-flight `PageFetcher.fetch` is handed that signal, so the deadline
/// TEARS DOWN a stuck fetch (the underlying URLSession task is cancelled) rather than merely
/// abandoning a promise. The provider stream is likewise cancelled by cancelling its consuming task.
public struct ResearchRunner: Sendable {
    public static let model = "gpt-5.4-mini"
    public static let fallbackModel = "gpt-5.6-luna"
    public static let effort = "low"
    public static let defaultMaxPages = 5
    public static let maxPagesCeiling = 15
    /// Runaway guard only — the deadline is the real wall-clock bound. This bounds provider
    /// round-trips in case a script somehow keeps calling FetchPage forever without exhausting the
    /// page budget (belt-and-suspenders; impossible for a well-behaved model).
    public static let maxRounds = 12
    /// A report is one page-sized unit of chat output — matches ReadPage's per-page cap, not the
    /// multi-page batch ceiling.
    public static let reportCharCap = 20_000
    public static let fetchPageToolName = "FetchPage"

    private let fetcher: PageFetcher
    private let dangerousAdded: [String]

    /// `fetcher` must be configured for research (`tool: "FetchPage"`); `dangerousAdded` is the
    /// user-added half of the effective dangerous-domain list, used for this runner's own pre-fetch
    /// hard-block (the shipped floor is applied by the fetcher too). Keep both consistent with the
    /// fetcher's own `dangerousAdded`.
    public init(fetcher: PageFetcher, dangerousAdded: [String] = []) {
        self.fetcher = fetcher
        self.dangerousAdded = dangerousAdded
    }

    // MARK: - the tool + prompt

    public static let fetchPageTool = ProviderToolSpec(
        name: fetchPageToolName,
        description:
            "Fetch one or more web pages (1-8 per call) as clean, line-numbered markdown with their outbound links. " +
            "Batch every url you want to read next into ONE call rather than calling this once per url. " +
            "You have a limited page budget for this whole research task, and every url in a batch counts against it — " +
            "when the budget runs out this returns an informational 'page budget exhausted' message instead of a page.",
        parametersJSON: #"{"type":"object","properties":{"urls":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"maxItems":8}},"required":["urls"],"additionalProperties":false}"#
    )

    /// The sub-agent's system prompt — DEMANDS per-sentence citations in the exact `url lines:N-M`
    /// form, a closing links list, and an explicit not-read list on truncation. A scripted-provider
    /// test cannot prove the MODEL obeys this; what a test asserts is that this text reaches the
    /// request, and that the budget/truncation machinery injects the not-read data so a real model
    /// CAN comply.
    public static let systemPrompt = [
        "You are an ephemeral research sub-agent with exactly one tool, FetchPage. You have been given a",
        "seed web page (already fetched, cleaned, and numbered) and a research query. Read the seed page",
        "and, using FetchPage, follow whatever links (on the seed page or on pages you fetch) you need to",
        "answer the query thoroughly. Batch every url you want next into ONE FetchPage call (1-8 urls).",
        "",
        "When you have enough to answer, stop calling tools and write your final report as plain text.",
        "",
        "CITATION RULE (MANDATORY): every sentence of fact in your report must end with a citation in the",
        "EXACT form \"<resolved-url> lines:N-M\" — the resolved url and the line numbers shown on the",
        "numbered page text you were given. Never cite a url you were not shown numbered lines for, and",
        "never the pre-redirect url if a page you read resolved somewhere else.",
        "",
        "Your report must end with two sections:",
        "1. \"Links found:\" — every link you saw on the pages you consulted (resolved url + link text),",
        "   one per line.",
        "2. \"Not read:\" — if you ran out of page budget or ran out of time before finishing, say exactly",
        "   what you did not get to read. Omit this section only if you read everything you needed.",
    ].joined(separator: "\n")

    // MARK: - run

    /// Runs the sub-agent to completion and returns its report. `urls` are the seed page(s) (the real
    /// caller passes exactly one — ReadPage's own `entry.url`); `provider` is the model; `deadline`
    /// is the wall-clock budget with GENUINE cancellation. `callId` defaults empty — ChatEngine
    /// rebinds it. Never throws: a hard failure is `isError: true`; a partial/timeout/round-limit
    /// report is `isError: false` — the exact reject-vs-resolve split the TS uses.
    public func run(query: String,
                    urls: [String],
                    provider: any ChatProvider,
                    deadline: Duration = .seconds(180),
                    maxPages: Int? = nil,
                    signal: ChatAbortSignal? = nil,
                    callId: String = "") async -> ToolResult {
        func result(_ content: String, isError: Bool) -> ToolResult {
            ToolResult(callId: callId, content: content, isError: isError)
        }

        let deadlineSignal = ChatAbortSignal()
        let externalReg = signal?.onAbort { deadlineSignal.abort() }
        let deadlineDate = Date().addingTimeInterval(Self.seconds(deadline))
        let timeoutTask = Task {
            do { try await Task.sleep(for: deadline) } catch { return }
            deadlineSignal.abort()
        }
        defer { timeoutTask.cancel(); externalReg?.cancel() }

        var state = RunState(maxPages: Self.clampMaxPages(maxPages))

        // --- seeds ---
        let seedOutcomes = await fetchSeeds(urls, deadlineSignal: deadlineSignal)
        var seeds: [CleanPage] = []
        var seedFailures: [String] = []
        var seedTimedOut = false
        for outcome in seedOutcomes {
            switch outcome {
            case .page(let page): seeds.append(page)
            case .refused(_, let message): seedFailures.append(message)
            case .failed(let url, let message): seedFailures.append("could not read the seed page \(url): \(message)")
            case .timeout: seedTimedOut = true
            }
        }
        if seeds.isEmpty {
            if seedTimedOut {
                return result(notReadReport("", state, "Research timed out before finishing (could not read the seed page in time)"), isError: false)
            }
            return result(capReport(seedFailures.joined(separator: "\n")), isError: true)
        }
        state.pagesRead = seeds.count
        for seed in seeds { state.recordLinks(seed) }

        var input: [ProviderInputItem] = [.message(role: .user, content: buildSeedMessage(query: query, seeds: seeds))]
        var model = Self.model
        var usedFallback = false
        var lastText = ""

        for _ in 0 ..< Self.maxRounds {
            if deadlineSignal.isAborted || Date() >= deadlineDate {
                return result(notReadReport(lastText, state, "Research timed out before finishing"), isError: false)
            }

            let request = ProviderTurnRequest(model: model, instructions: Self.systemPrompt, input: input,
                                              tools: [Self.fetchPageTool], reasoningEffort: Self.effort)
            let stream = provider.streamTurn(request)
            let remaining = Duration.seconds(max(0, deadlineDate.timeIntervalSinceNow))
            let outcome = await Self.consumeRound(stream, remaining: remaining)

            guard case .completed(let round) = outcome else {
                return result(notReadReport(lastText, state, "Research timed out before finishing"), isError: false)
            }
            if deadlineSignal.isAborted {
                return result(notReadReport(lastText, state, "Research timed out before finishing"), isError: false)
            }
            // Captured BEFORE the error/stop checks — a LATER round's failure must not discard an
            // EARLIER round's assistant text (a partial answer beats none).
            if !round.textBuf.isEmpty { lastText = round.textBuf }

            if let error = round.error {
                if !usedFallback, Self.looksLikeBadModelError(error, model: model) {
                    usedFallback = true
                    model = Self.fallbackModel
                    continue // retry the SAME round (input unchanged) on the fallback model
                }
                return result(capReport(failureMessage(lastText, "provider error (\(error.code.rawValue)): \(error.message). Pages read: \(state.pagesRead).\(linksSummary(state))")), isError: true)
            }

            if round.stop != .toolCalls || round.calls.isEmpty {
                if round.stop == .aborted {
                    return result(notReadReport(lastText, state, "Research timed out before finishing"), isError: false)
                }
                if round.stop == nil {
                    let unresolved = round.calls.isEmpty ? "" : " with \(round.calls.count) tool call(s) left unresolved"
                    return result(capReport(failureMessage(lastText, "the provider stream ended unexpectedly\(unresolved) (pages read: \(state.pagesRead)).")), isError: true)
                }
                if lastText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return result(capReport("no report was produced — the model finished with no text (pages read: \(state.pagesRead))."), isError: true)
                }
                return result(capReport(lastText), isError: false) // the model's own text IS the report
            }

            if !round.textBuf.isEmpty { input.append(.message(role: .assistant, content: round.textBuf)) }
            for call in round.calls { input.append(.functionCall(callId: call.callId, name: call.name, argumentsJSON: call.argumentsJSON)) }

            for call in round.calls {
                if call.name != Self.fetchPageToolName {
                    input.append(.toolResult(callId: call.callId, output: "unknown tool: \(call.name) — only FetchPage is available in this run", isError: true))
                    continue
                }
                switch Self.parseFetchPageURLs(call.argumentsJSON) {
                case .invalid(let message):
                    input.append(.toolResult(callId: call.callId, output: message, isError: true))
                case .urls(let fetchURLs):
                    let output = await handleFetchPage(urls: fetchURLs, state: &state, deadlineSignal: deadlineSignal)
                    input.append(.toolResult(callId: call.callId, output: output, isError: false))
                }
            }
        }

        // MAX_ROUNDS exhausted without a natural end_turn — a resolved (non-error) truncated report.
        return result(notReadReport(lastText, state, "Research stopped after reaching its round limit"), isError: false)
    }

    // MARK: - seeds

    private enum FetchOutcome: Sendable {
        case page(CleanPage)
        case refused(String, String) // url, complete refusal message
        case failed(String, String)  // url, message
        case timeout
    }

    private func fetchSeeds(_ urls: [String], deadlineSignal: ChatAbortSignal) async -> [FetchOutcome] {
        await withTaskGroup(of: (Int, FetchOutcome).self) { group in
            for (index, url) in urls.enumerated() {
                group.addTask { (index, await self.fetchSeed(url, deadlineSignal: deadlineSignal)) }
            }
            var out = [FetchOutcome?](repeating: nil, count: urls.count)
            for await (index, outcome) in group { out[index] = outcome }
            return out.compactMap { $0 }
        }
    }

    private func fetchSeed(_ url: String, deadlineSignal: ChatAbortSignal) async -> FetchOutcome {
        if let hit = DangerousDomains.check(url, extra: dangerousAdded) {
            return .refused(url, DangerousDomains.refusal(
                url: url, hit: hit,
                cannotAskReason: "research has no approval flow to ask for one, so a blocked seed page is refused outright"))
        }
        do {
            return .page(try await fetcher.fetch(url: url, origin: .research, signal: deadlineSignal))
        } catch let error as PageFetchError {
            return error.outcome == .timeout ? .timeout : .failed(url, error.message)
        } catch {
            return .failed(url, error.localizedDescription)
        }
    }

    // MARK: - one FetchPage tool call (a batch of 1-8 urls)

    /// Fetches whatever the remaining budget allows, in the model's requested order, decrementing the
    /// budget by every url ATTEMPTED (a bad or blocked url still costs a slot). Never throws — a
    /// per-url failure is a labeled line in the same combined section, exactly like ReadPage's batch.
    /// Budget accounting is sequential (up front); only the fetches run concurrently, so `state` is
    /// never mutated from more than one task.
    private func handleFetchPage(urls: [String], state: inout RunState, deadlineSignal: ChatAbortSignal) async -> String {
        if state.pagesRead >= state.maxPages {
            return "page budget exhausted (\(state.pagesRead) pages read)"
        }
        let remaining = state.maxPages - state.pagesRead
        let toFetch = Array(urls.prefix(remaining))
        let skipped = Array(urls.dropFirst(remaining))
        state.pagesRead += toFetch.count

        let perURL = await withTaskGroup(of: (Int, FetchOutcome).self) { group -> [FetchOutcome] in
            for (index, url) in toFetch.enumerated() {
                group.addTask { (index, await self.fetchForResearch(url, deadlineSignal: deadlineSignal)) }
            }
            var out = [FetchOutcome?](repeating: nil, count: toFetch.count)
            for await (index, outcome) in group { out[index] = outcome }
            return out.compactMap { $0 }
        }

        var sections: [String] = []
        for outcome in perURL {
            switch outcome {
            case .page(let page):
                state.recordLinks(page)
                sections.append(pageSection(page))
            case .refused(let url, let message):
                state.notRead.append(url)
                sections.append(message)
            case .failed(let url, let message):
                state.notRead.append(url)
                sections.append("\(url): \(message)")
            case .timeout:
                break // seeds only — fetchForResearch maps a timeout to .failed(url, "timed out")
            }
        }
        if !skipped.isEmpty {
            state.notRead.append(contentsOf: skipped)
            sections.append("page budget exhausted (\(state.pagesRead) pages read) — not fetched: \(skipped.joined(separator: ", "))")
        }

        return capText(sections.joined(separator: "\n\n---\n\n"),
                       cap: ReadPageTool.totalOutputCharCap,
                       marker: "\n\n[batch output truncated at \(ReadPageTool.totalOutputCharCap) chars — remaining pages' content was cut]")
    }

    private func fetchForResearch(_ url: String, deadlineSignal: ChatAbortSignal) async -> FetchOutcome {
        if let hit = DangerousDomains.check(url, extra: dangerousAdded) {
            return .refused(url, DangerousDomains.refusal(
                url: url, hit: hit,
                cannotAskReason: "FetchPage has no approval flow to ask for one, so fetches to known exfiltration/tunnel-provider hosts are blocked outright"))
        }
        do {
            return .page(try await fetcher.fetch(url: url, origin: .research, signal: deadlineSignal))
        } catch let error as PageFetchError {
            return error.outcome == .timeout ? .failed(url, "timed out") : .failed(url, error.message)
        } catch {
            return .failed(url, error.localizedDescription)
        }
    }

    // MARK: - rendering

    /// One fetched page as the numbered section the model reads — same shape as ReadPage's per-page
    /// section (url header, numbered lines, a Links tail), capped at the same per-page ceiling so a
    /// single huge fetched page cannot balloon the next provider request.
    private func pageSection(_ page: CleanPage) -> String {
        let rendered = renderLines(page)
        let linksList = page.links.isEmpty
            ? "(none)"
            : page.links.enumerated().map { "\($0.offset + 1). \($0.element.text.isEmpty ? "(no text)" : $0.element.text) (\($0.element.href))" }.joined(separator: "\n")
        let freshness = page.fromCache ? "cached fetch" : "fresh fetch"
        let section = ["\(page.resolvedURL) (\(freshness))", rendered, "", "Links:", linksList].joined(separator: "\n")
        return capText(section, cap: ReadPageTool.perPageCharCap,
                       marker: "\n[page content truncated at \(ReadPageTool.perPageCharCap) chars — the rest of this page's content was cut]")
    }

    private func buildSeedMessage(query: String, seeds: [CleanPage]) -> String {
        let sections = seeds.map { pageSection($0) }.joined(separator: "\n\n---\n\n")
        return ["Research query: \(query)", "", seeds.count == 1 ? "Seed page:" : "Seed pages:", sections].joined(separator: "\n")
    }

    private func linksSummary(_ state: RunState) -> String {
        guard !state.linksFound.isEmpty else { return "" }
        let lines = state.linksFound.enumerated().map { "\($0.offset + 1). \($0.element.text.isEmpty ? "(no text)" : $0.element.text) (\($0.element.href))" }
        return "\n\nLinks found:\n" + lines.joined(separator: "\n")
    }

    private func failureMessage(_ lastText: String, _ message: String) -> String {
        lastText.isEmpty ? message : "\(lastText)\n\n\(message)"
    }

    private func capReport(_ text: String) -> String {
        capText(text, cap: Self.reportCharCap, marker: "\n[report truncated at \(Self.reportCharCap) chars]")
    }

    /// The (resolved, non-throwing) partial report for a budget/clock/round-limit truncation — these
    /// are NOT failures: the run may have gathered real content, and the deadline's contract demands
    /// `run()` still RESOLVE (never `isError`) so a hung fetch/provider can't wedge the calling turn.
    private func notReadReport(_ lastText: String, _ state: RunState, _ reason: String) -> String {
        let urls = orderedUnique(state.notRead)
        let list = urls.isEmpty ? "" : " Not read: \(urls.joined(separator: ", "))."
        let note = "\(reason) (pages read: \(state.pagesRead)).\(list)\(linksSummary(state))"
        return capReport(failureMessage(lastText, note))
    }

    // MARK: - provider round consumption (deadline-raced)

    struct Call: Sendable { let callId: String; let name: String; let argumentsJSON: String }

    private struct RoundResult: Sendable {
        var textBuf = ""
        var calls: [Call] = []
        var stop: ProviderStopReason?
        var error: ProviderError?
    }

    private enum RoundOutcome: Sendable {
        case completed(RoundResult)
        case timedOut
    }

    /// Consumes one round's events, raced against the remaining deadline. If the deadline wins, the
    /// consuming task is cancelled — which genuinely ends the provider stream (a stalled provider
    /// cannot hang past the deadline).
    private static func consumeRound(_ stream: AsyncStream<ProviderEvent>, remaining: Duration) async -> RoundOutcome {
        if remaining <= .zero { return .timedOut }
        return await withTaskGroup(of: RoundOutcome.self) { group in
            group.addTask {
                var round = RoundResult()
                for await event in stream {
                    switch event {
                    case .textDelta(let delta): round.textBuf += delta
                    case .toolCall(let id, let name, let args): round.calls.append(Call(callId: id, name: name, argumentsJSON: args))
                    case .done(let reason): round.stop = reason; return .completed(round)
                    case .error(let providerError): round.error = providerError; return .completed(round)
                    case .reasoningItem, .usage: break // ignored — nothing to persist them to
                    }
                }
                return .completed(round) // stream ended without done/error (stop stays nil)
            }
            group.addTask {
                try? await Task.sleep(for: remaining)
                return .timedOut
            }
            let first = await group.next() ?? .timedOut
            group.cancelAll()
            return first
        }
    }

    // MARK: - model-fallback rule

    /// A context-length complaint is a `bad_request` about the PAYLOAD, not the model — it must never
    /// burn the one fallback retry, so it is checked first.
    private static let contextLengthRegex = try! NSRegularExpression(pattern: "context.length|context_length_exceeded")
    /// Phrases that read as a genuine unknown/unsupported-model complaint, independent of the code.
    private static let unknownModelRegex = try! NSRegularExpression(pattern: "unknown model|model not found|unsupported model|invalid model|model.{0,20}(deprecated|unavailable|unsupported)")

    /// true when a provider error should trigger the ONE model-fallback retry: a context-length
    /// complaint NEVER retries; a message that plainly reads as an unknown/unsupported-model
    /// complaint always retries; otherwise ONLY a `bad_request` that also NAMES the current model
    /// retries. An error under some OTHER code (network, auth, …) that merely mentions the model does
    /// NOT retry — naming the model is meaningful only when the code says the request was bad.
    static func looksLikeBadModelError(_ error: ProviderError, model: String) -> Bool {
        let message = error.message.lowercased()
        if regexMatches(contextLengthRegex, message) { return false }
        if regexMatches(unknownModelRegex, message) { return true }
        return error.code == .badRequest && message.contains(model.lowercased())
    }

    private static func regexMatches(_ regex: NSRegularExpression, _ string: String) -> Bool {
        regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
    }

    // MARK: - small helpers

    static func clampMaxPages(_ requested: Int?) -> Int {
        let base = requested ?? defaultMaxPages
        return min(max(base <= 0 ? 1 : base, 1), maxPagesCeiling)
    }

    static func seconds(_ duration: Duration) -> TimeInterval {
        let components = duration.components
        return Double(components.seconds) + Double(components.attoseconds) / 1e18
    }

    /// `[...new Set(items)]` — first-seen order preserved.
    private func orderedUnique(_ items: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for item in items where !seen.contains(item) { seen.insert(item); out.append(item) }
        return out
    }

    enum FetchPageParse: Equatable {
        case urls([String])
        case invalid(String)
    }

    static func parseFetchPageURLs(_ argumentsJSON: String) -> FetchPageParse {
        let source = argumentsJSON.isEmpty ? "{}" : argumentsJSON
        guard let data = source.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return .invalid("invalid FetchPage arguments — could not parse JSON")
        }
        guard let dict = object as? [String: Any], let rawURLs = dict["urls"] as? [Any] else {
            return .invalid("invalid FetchPage arguments — urls must be 1-8 non-empty strings")
        }
        let urls = rawURLs.compactMap { $0 as? String }
        guard urls.count == rawURLs.count, !urls.isEmpty, urls.count <= 8, urls.allSatisfy({ !$0.isEmpty }) else {
            return .invalid("invalid FetchPage arguments — urls must be 1-8 non-empty strings")
        }
        return .urls(urls)
    }
}

// MARK: - run state

/// The loop's mutable bookkeeping — a plain struct mutated only from the (single) run task; the
/// concurrent fetches inside a batch merge their results into it sequentially afterward.
private struct RunState {
    var maxPages: Int
    var pagesRead = 0
    var notRead: [String] = []
    /// href → text, first-seen wins (matches page-core's own link dedup).
    private(set) var linksFound: [(href: String, text: String)] = []
    private var linksSeen = Set<String>()

    init(maxPages: Int) { self.maxPages = maxPages }

    mutating func recordLinks(_ page: CleanPage) {
        for link in page.links where !linksSeen.contains(link.href) {
            linksSeen.insert(link.href)
            linksFound.append((link.href, link.text))
        }
    }
}
