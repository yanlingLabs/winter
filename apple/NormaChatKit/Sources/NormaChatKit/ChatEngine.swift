import Foundation
import NormaProtocol

/// The phone's standalone chat turn-loop — the Swift counterpart of the daemon's chat turn
/// (`packages/core/src/agent/engine.ts`), radically reduced to exactly what a phone-local chat
/// session needs: stream from the provider, emit typed NormaProtocol `SessionEvent`s, dispatch chat's
/// three tools, and continue on the model's tool calls until it answers. Two engines, ONE event
/// dialect — the fixture round-trip test proves an engine-emitted event decodes through the same
/// NormaProtocol coders the daemon's events do, which is why Slice C's transcript UI works unchanged.
///
/// Opaque reasoning discipline (CLAUDE.md §events): a provider `reasoning_item` is appended to the
/// session log via `LocalSession.appendReasoning` — its ONLY sink — and fed back to the provider for
/// continuity, but NEVER surfaced through `emit` (NormaProtocol has no reasoning_item variant by
/// design: a reasoning item is not a renderable event).

// MARK: - session seam

/// What the engine needs from the phone-local event store (Task 9 conforms its store to this). Kept
/// deliberately small: an identity, the head seq to continue numbering from, the provider-input
/// reconstruction of the persisted log, and an opaque sink for reasoning items.
public protocol LocalSession: Sendable {
    var sessionId: String { get }
    /// Last seq persisted in this session's log. The engine stamps THIS turn's persisted events from
    /// `lastSeq + 1` upward; transient `assistant_delta`s ride the current head (non-advancing),
    /// exactly as the daemon's hub does (seq = store.lastSeq at broadcast time).
    var lastSeq: Int { get }
    /// Provider-input reconstruction of everything ALREADY in the log — prior turns' user/assistant
    /// messages, reasoning passthrough, and function calls + their results, in provider order. Empty
    /// for a brand-new session.
    ///
    /// TURN-START SNAPSHOT CONTRACT (load-bearing for the persist-on-emit sink): the engine reads
    /// this EXACTLY ONCE, at turn start, BEFORE it emits this turn's `user_message`/`turn_started`,
    /// and appends the current `userText` itself. A conforming store whose `emit` sink persists
    /// events into the same log this method folds (Task 11's faithful wiring) therefore must NOT let
    /// a return value from a call made after runTurn began reflect this turn's own just-emitted
    /// events — but because the engine only ever calls it before any emit, that ordering can never
    /// double the current user message. Do not call `priorInput()` mid-turn expecting to see this
    /// turn's events; it is a pre-turn reconstruction only.
    func priorInput() -> [ProviderInputItem]
    /// Append an opaque reasoning item to the log at `seq` (epoch-ms `ts`). This is its only sink; it
    /// is never rendered. A continued turn reads it back through `priorInput()`.
    func appendReasoning(itemJSON: String, seq: Int, ts: Int)
}

// MARK: - toolset

/// Everything the three chat tools need for a turn, bundled so `runTurn` stays a clean 5-parameter
/// call. The main-turn provider is the engine's own (`ChatEngine.init`); `researchProvider` is the
/// model the `ReadPage`-`query` research sub-agent drives (nil → the engine's own provider, which is
/// the production shape: one `ResponsesClient` serves both).
public struct ChatToolset: Sendable {
    public let http: any ChatHTTP
    public let exaKey: String?
    public let fetcher: PageFetcher
    public let dangerousAdded: [String]
    public let researchProvider: (any ChatProvider)?
    public let researchDeadline: Duration
    public let systemPrompt: String
    public let reasoningEffort: String?
    public let askTimeout: Duration

    public init(http: any ChatHTTP,
                fetcher: PageFetcher,
                exaKey: String? = nil,
                dangerousAdded: [String] = [],
                researchProvider: (any ChatProvider)? = nil,
                researchDeadline: Duration = .seconds(180),
                systemPrompt: String = ChatEngine.defaultSystemPrompt,
                reasoningEffort: String? = nil,
                askTimeout: Duration = .seconds(300)) {
        self.http = http
        self.exaKey = exaKey
        self.fetcher = fetcher
        self.dangerousAdded = dangerousAdded
        self.researchProvider = researchProvider
        self.researchDeadline = researchDeadline
        self.systemPrompt = systemPrompt
        self.reasoningEffort = reasoningEffort
        self.askTimeout = askTimeout
    }
}

// MARK: - the engine

public final class ChatEngine: @unchecked Sendable {
    /// Chat's base prompt — the Swift port of `chat-prompt.ts`'s `CHAT_SYSTEM_PROMPT`. Task 11's view
    /// model composes the fuller instructions (date, user instructions, the replicated memory bucket)
    /// on top of this via `ChatToolset.systemPrompt`; this is the floor.
    public static let defaultSystemPrompt = [
        "You are Norma in Chat mode: a conversation, not an agent. You have no access to this machine — no files, no shell, no repository — and you never imply otherwise.",
        "",
        "# What you are here for",
        "Thinking things through with the user: questions, explanations, drafting, planning, remembering.",
        "You share the assistant memory that Norma builds across conversations — use what you know about the user, and do not re-ask what is already established.",
        "",
        "# Honesty about your reach",
        "If something needs the user's files, code, or terminal, say so plainly and point at the mode that can do it (Code for a project, Dispatch to coordinate work).",
        "Never guess at file contents or command output. You cannot see them.",
        "",
        "# Looking things up",
        "You can Search the web. Do it whenever a fact might have changed since you were trained, or the user asks about something current — do not guess and do not hedge about not knowing. Say where a fact came from.",
        "You can also open a result with ReadPage to read the actual page, and re-load a range you cited later with the same lineStart/lineEnd.",
        "",
        "# Asking",
        "When a choice is genuinely the user's to make, use AskQuestion rather than assuming.",
    ].joined(separator: "\n")

    /// Runaway guard — a well-behaved model ends in a handful of rounds; this only bounds a model that
    /// somehow keeps calling tools forever.
    static let maxRounds = 24

    private let provider: any ChatProvider
    private let now: @Sendable () -> Date
    /// The answer channel for `AskQuestion`. Task 11's card UI answers into it via `broker.answer`.
    public let broker: QuestionBroker

    private let lock = NSLock()
    private var currentSignal: ChatAbortSignal?

    public init(provider: any ChatProvider,
                broker: QuestionBroker = QuestionBroker(),
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider
        self.broker = broker
        self.now = now
    }

    /// Ends the in-flight turn (if any) with an interrupted `turn_completed(aborted)`. Idempotent and
    /// safe to call when no turn is running. External `Task` cancellation of `runTurn` does the same.
    public func interrupt() {
        let signal = lock.withLock { currentSignal }
        signal?.abort()
    }

    // MARK: - runTurn

    public func runTurn(session: any LocalSession,
                        userText: String,
                        model: String,
                        tools: ChatToolset,
                        emit: @escaping @Sendable (SessionEvent) -> Void) async {
        let signal = ChatAbortSignal()
        lock.withLock { currentSignal = signal }
        defer { lock.withLock { if currentSignal === signal { currentSignal = nil } } }

        await withTaskCancellationHandler {
            await runBody(session: session, userText: userText, model: model,
                          tools: tools, signal: signal, emit: emit)
        } onCancel: {
            signal.abort()
        }
    }

    private func runBody(session: any LocalSession,
                         userText: String,
                         model: String,
                         tools: ChatToolset,
                         signal: ChatAbortSignal,
                         emit: @escaping @Sendable (SessionEvent) -> Void) async {
        let sid = session.sessionId
        let seq = SeqAllocator(lastSeq: session.lastSeq)

        // Turn-START snapshot of the provider input, taken BEFORE emitting this turn's own events —
        // see LocalSession.priorInput()'s contract. A daemon-faithful sink persists on emit (Task
        // 11's `emit` is the only sink for user/assistant/tool events), so reading priorInput() AFTER
        // emitting user_message would let it observe this turn's own message and the manual append
        // below would then DOUBLE the user message in the provider input every turn. Reading it here
        // (SeqAllocator is already seeded from lastSeq first, so this is behavior-neutral) makes the
        // input a genuine turn-start snapshot regardless of when/whether emit persists.
        var input = session.priorInput()
        input.append(.message(role: .user, content: userText))

        emit(.userMessage(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                text: userText, clientName: Self.clientName)))
        emit(.turnStarted(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread)))

        var inputTokens = 0
        var outputTokens = 0
        // followups T3: `inputTokens` above keeps its BILLING meaning (summed across rounds) — do
        // not fold this into it. `contextTokens` tracks the largest SINGLE round's input, i.e. how
        // full the context actually got, mirroring the daemon's own `usage.contextTokens` (Math.max
        // across rounds, `engine.ts`). It is what makes a phone-authored turn usable by the Mac's
        // auto-compaction trigger instead of silently skipped for lacking the field entirely.
        var contextTokens = 0
        var stopReason = "end_turn"

        var round = 0
        loop: while round < Self.maxRounds {
            round += 1
            if signal.isAborted { stopReason = "aborted"; break }

            let request = ProviderTurnRequest(model: model, instructions: tools.systemPrompt,
                                              input: input, tools: Self.toolSpecs,
                                              reasoningEffort: tools.reasoningEffort)
            let stream = provider.streamTurn(request)
            // Transient assistant_delta seq = the current head (non-advancing) — captured as a
            // constant so the concurrently-consuming task never touches the allocator.
            let deltaSeq = seq.current
            let outcome = await consumeRound(stream, signal: signal) { delta in
                emit(.assistantDelta(.init(seq: deltaSeq, sessionId: sid, ts: self.nowMs(),
                                           threadId: MainThread, delta: delta)))
            }

            if signal.isAborted { stopReason = "aborted"; break }
            inputTokens += outcome.inputTokens
            outputTokens += outcome.outputTokens
            contextTokens = max(contextTokens, outcome.inputTokens)

            // Emission-order replay (spec §B4): reasoning items precede the round's message/calls.
            // Opaque — appended to the log and fed back to the provider, NEVER emitted.
            for itemJSON in outcome.reasoning {
                let s = seq.next()
                session.appendReasoning(itemJSON: itemJSON, seq: s, ts: nowMs())
                input.append(.reasoning(itemJSON: itemJSON))
            }

            if !outcome.text.isEmpty {
                emit(.assistantMessage(.init(seq: seq.next(), sessionId: sid, ts: nowMs(),
                                             threadId: MainThread, text: outcome.text)))
                input.append(.message(role: .assistant, content: outcome.text))
            }

            if let error = outcome.error {
                emit(.agentError(.init(seq: seq.next(), sessionId: sid, ts: nowMs(),
                                       threadId: MainThread, message: error.message)))
                stopReason = "error"
                break
            }

            if outcome.stop != .toolCalls || outcome.calls.isEmpty {
                if outcome.stop == nil {
                    // Bare finish, no done/error and not aborted — "stream ended unexpectedly"
                    // (T7 concern-2, fail-closed): a provider that finishes without a terminal event
                    // never counts as a silent success.
                    emit(.agentError(.init(seq: seq.next(), sessionId: sid, ts: nowMs(),
                                           threadId: MainThread, message: "the model stream ended unexpectedly")))
                    stopReason = "error"
                } else {
                    stopReason = outcome.stop == .aborted ? "aborted" : "end_turn"
                }
                break
            }

            // Dispatch: all function_call items first, then their results (Responses API order).
            for call in outcome.calls {
                emit(.toolCall(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                     callId: call.id, name: call.name, argsJson: call.argumentsJSON)))
                input.append(.functionCall(callId: call.id, name: call.name, argumentsJSON: call.argumentsJSON))
            }
            for call in outcome.calls {
                let result = await dispatch(call: call, tools: tools, session: session,
                                            signal: signal, seq: seq, emit: emit)
                emit(.toolResult(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                       callId: call.id, output: result.content, isError: result.isError)))
                input.append(.toolResult(callId: call.id, output: result.content, isError: result.isError))
            }

            if round == Self.maxRounds {
                emit(.agentError(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                       message: "the model reached the tool-call limit for one turn")))
                stopReason = "error"
                break loop
            }
        }

        // The turn ALWAYS ends on a complete turn_completed line (atomic append — never a torn log),
        // whether it finished, errored, or was interrupted. The next runTurn continues the session.
        emit(.turnCompleted(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                  stopReason: stopReason, inputTokens: inputTokens, outputTokens: outputTokens,
                                  contextTokens: contextTokens)))
    }

    // MARK: - round consumption

    struct RoundCall: Sendable { let id: String; let name: String; let argumentsJSON: String }

    struct Round: Sendable {
        var text = ""
        var reasoning: [String] = []
        var calls: [RoundCall] = []
        var inputTokens = 0
        var outputTokens = 0
        var stop: ProviderStopReason?
        var error: ProviderError?
    }

    /// Consumes one provider round, emitting `assistant_delta` live, until the stream finishes.
    /// Cancellable: when `signal` aborts, the consuming task is cancelled — which ends the
    /// `ResponsesClient` stream on a bare finish (its `onTermination` tears the transfer down). The
    /// caller re-checks `signal.isAborted` to decide the turn is aborted.
    private func consumeRound(_ stream: AsyncStream<ProviderEvent>,
                              signal: ChatAbortSignal,
                              onDelta: @escaping @Sendable (String) -> Void) async -> Round {
        let task = Task { () -> Round in
            var round = Round()
            for await event in stream {
                switch event {
                case .textDelta(let delta):
                    if !delta.isEmpty { round.text += delta; onDelta(delta) }
                case .reasoningItem(let itemJSON):
                    round.reasoning.append(itemJSON)
                case .toolCall(let id, let name, let args):
                    round.calls.append(RoundCall(id: id, name: name, argumentsJSON: args))
                case .usage(let inTok, let outTok):
                    round.inputTokens += inTok; round.outputTokens += outTok
                case .done(let reason):
                    round.stop = reason
                case .error(let providerError):
                    round.error = providerError
                }
            }
            return round
        }
        let registration = signal.onAbort { task.cancel() }
        defer { registration.cancel() }
        return await task.value
    }

    // MARK: - tool dispatch

    private func dispatch(call: RoundCall, tools: ChatToolset, session: any LocalSession,
                          signal: ChatAbortSignal, seq: SeqAllocator,
                          emit: @escaping @Sendable (SessionEvent) -> Void) async -> ToolResult {
        switch call.name {
        case "Search":
            guard let args = decodeSearchArgs(call.argumentsJSON) else {
                return ToolResult(callId: call.id, content: "invalid Search arguments — expected { query }", isError: true)
            }
            // T7 contract: the tool returns an empty-callId result; the engine rebinds via .attaching.
            let result = await SearchTool.run(query: args.query, key: tools.exaKey, http: tools.http,
                                              maxResults: args.maxResults, dangerousAdded: tools.dangerousAdded,
                                              signal: signal)
            return result.attaching(callId: call.id)

        case "ReadPage":
            let researchProvider = tools.researchProvider ?? provider
            let dangerousAdded = tools.dangerousAdded
            let fetcher = tools.fetcher
            let deadline = tools.researchDeadline
            let research: ReadPageTool.ResearchHook = { query, url, maxPages, sig in
                let runner = ResearchRunner(fetcher: fetcher, dangerousAdded: dangerousAdded)
                return await runner.run(query: query, urls: [url], provider: researchProvider,
                                        deadline: deadline, maxPages: maxPages, signal: sig)
            }
            let result = await ReadPageTool.run(argumentsJSON: call.argumentsJSON, fetcher: tools.fetcher,
                                                research: research, dangerousAdded: tools.dangerousAdded,
                                                signal: signal)
            return result.attaching(callId: call.id)

        case "AskQuestion":
            return await handleAskQuestion(call: call, tools: tools, session: session,
                                           signal: signal, seq: seq, emit: emit)

        default:
            return ToolResult(callId: call.id, content: "unknown tool: \(call.name)", isError: true)
        }
    }

    private func handleAskQuestion(call: RoundCall, tools: ChatToolset, session: any LocalSession,
                                   signal: ChatAbortSignal, seq: SeqAllocator,
                                   emit: @escaping @Sendable (SessionEvent) -> Void) async -> ToolResult {
        guard let ask = decodeAskQuestionArgs(call.argumentsJSON) else {
            return ToolResult(callId: call.id,
                              content: "invalid AskQuestion arguments — expected { question, options: [{ label }] }",
                              isError: true)
        }
        let sid = session.sessionId
        // Simplified chat card: header nil (no chip), no per-option description/preview, single-select.
        let question = SessionEvent.Question(
            question: ask.question, header: nil,
            options: ask.options.map { SessionEvent.QuestionOption(label: $0, description: nil, preview: nil) },
            multiSelect: false)
        emit(.questionAsked(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                  callId: call.id, questions: [question], childSessionId: nil)))

        // Race the answer against the ask window and against an interrupt. Early-store in the broker
        // means a UI that answers the instant it sees question_asked is never dropped.
        let broker = self.broker
        let callId = call.id
        let timeoutTask = Task { [askTimeout = tools.askTimeout] in
            try? await Task.sleep(for: askTimeout)
            await broker.timeOut(id: callId)
        }
        let abortReg = signal.onAbort { Task { await broker.abort(id: callId) } }
        defer { timeoutTask.cancel(); abortReg.cancel() }

        let answer = await broker.wait(id: call.id)
        let answers: [String: String]
        let by: String
        let modelText: String
        switch answer {
        case .answered(let text):
            answers = [ask.question: text]
            by = "user"
            modelText = "User answered: \(text.isEmpty ? "(no answer)" : text)"
        case .timedOut:
            answers = [:]
            by = "timeout"
            modelText = noAnswerMessage(tools.askTimeout)
        case .aborted:
            answers = [:]
            by = "interrupt"
            modelText = "(the turn was interrupted before the user answered)"
        }
        emit(.questionResolved(.init(seq: seq.next(), sessionId: sid, ts: nowMs(), threadId: MainThread,
                                     callId: call.id, answers: answers, by: by, notes: nil, childSessionId: nil)))
        return ToolResult(callId: call.id, content: modelText, isError: false)
    }

    // MARK: - tool specs (advertised every turn)

    static let toolSpecs: [ProviderToolSpec] = [
        ProviderToolSpec(
            name: "Search",
            description: "Search the web and get back results WITH an excerpt of each page, in a single fast call. Use it freely whenever a fact might be newer than you are, or when the user asks about something current. Cite the URL when you use what it returns. Requires a stored Exa API key (norma login --exa-key).",
            parametersJSON: #"{"type":"object","properties":{"query":{"type":"string","minLength":1},"max_results":{"type":"integer","minimum":1}},"required":["query"],"additionalProperties":false}"#),
        ProviderToolSpec(
            name: "ReadPage",
            description: "Read one or more web pages as clean, line-numbered markdown, each followed by a 'Links:' tail listing that page's outbound links. Batch up to 8 pages in a single call — each entry is independent. With no lineStart/lineEnd the whole page loads (subject to a per-page size cap); give lineStart/lineEnd to load just that inclusive line range instead. Cite what you used as '<url> lines:N-M', using the RESOLVED url shown in the output (after any redirect) — never the url you originally requested. Give an entry 'query' instead of a line range to run background research over that page and its links — you get back a cited report instead of the raw page. 'query' and a line range cannot both be set on the same entry.",
            parametersJSON: #"{"type":"object","properties":{"pages":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"url":{"type":"string","minLength":1},"query":{"type":"string","minLength":1},"lineStart":{"type":"integer","minimum":1},"lineEnd":{"type":"integer","minimum":1},"max_pages":{"type":"integer","minimum":1}},"required":["url"],"additionalProperties":false}}},"required":["pages"],"additionalProperties":false}"#),
        ProviderToolSpec(
            name: "AskQuestion",
            description: "Ask the user one question when a choice is genuinely theirs to make and you cannot resolve it from the conversation. Give 2-4 short, distinct option labels. Do NOT add an 'Other' option: the interface always offers a free-text 'Other' itself. Options are labels only — no descriptions. If you recommend one, put it first and append ' (Recommended)' to its label. The user's answer is returned to you; if nobody answers in time you'll be told to proceed.",
            parametersJSON: #"{"type":"object","properties":{"question":{"type":"string","minLength":1},"options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"object","properties":{"label":{"type":"string","minLength":1}},"required":["label"],"additionalProperties":false}}},"required":["question","options"],"additionalProperties":false}"#),
    ]

    // MARK: - helpers

    static let clientName = "phone"

    private func nowMs() -> Int { Int((now().timeIntervalSince1970 * 1000).rounded()) }

    private func noAnswerMessage(_ timeout: Duration) -> String {
        let seconds = Int((Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18).rounded())
        return "No answer within \(seconds)s — the user is not available right now. Answer as best you can and say what you assumed."
    }

    private struct SearchArgs { let query: String; let maxResults: Int? }
    private func decodeSearchArgs(_ json: String) -> SearchArgs? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let query = object["query"] as? String, !query.isEmpty else { return nil }
        let max = (object["max_results"] as? NSNumber)?.intValue
        return SearchArgs(query: query, maxResults: max)
    }

    private struct AskArgs { let question: String; let options: [String] }
    private func decodeAskQuestionArgs(_ json: String) -> AskArgs? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let question = object["question"] as? String, !question.isEmpty,
              let rawOptions = object["options"] as? [Any] else { return nil }
        var labels: [String] = []
        for item in rawOptions {
            guard let dict = item as? [String: Any], let label = dict["label"] as? String, !label.isEmpty else { return nil }
            labels.append(label)
        }
        guard !labels.isEmpty else { return nil }
        return AskArgs(question: question, options: labels)
    }
}

/// `engine.ts`'s `MAIN_THREAD` — chat is single-threaded, so every event rides the `"main"` thread.
let MainThread = "main"

/// Allocates monotonic seq for a turn, seeded from the session head. `next()` advances (a persisted
/// event); `current` reads the head without advancing (a transient `assistant_delta`, whose seq is
/// the head at broadcast time). Turns are serialized, so a plain counter is sufficient — the engine
/// never allocates from two tasks at once (the concurrent delta task reads a captured constant).
final class SeqAllocator {
    private var head: Int
    init(lastSeq: Int) { self.head = lastSeq }
    var current: Int { head }
    func next() -> Int { head += 1; return head }
}
