import Foundation

/// The tool-dispatch shapes ChatEngine (Task 8) dispatches on, plus the provider seam the research
/// runner depends on. Deliberately small and self-contained: these are the ONLY types the three
/// chat tools (Search, ReadPage, the research sub-agent) share with the rest of the kit.

// MARK: - tool call / result

/// A model-emitted tool call. `argumentsJSON` is the raw JSON string the model produced for the
/// tool's arguments — each tool decodes what it needs (Search reads `query`, ReadPage reads
/// `pages`, …). Task 8's ChatEngine builds these from the provider's `tool_call` events.
public struct ToolCall: Sendable, Equatable {
    public let id: String
    public let name: String
    public let argumentsJSON: String

    public init(id: String, name: String, argumentsJSON: String) {
        self.id = id
        self.name = name
        self.argumentsJSON = argumentsJSON
    }
}

/// A tool's answer, fed back to the model. `callId` ties the result to its `ToolCall`; the tools
/// here return results with an empty `callId` (they do not know the call they answer — ChatEngine
/// owns dispatch), so ChatEngine re-associates via `attaching(callId:)`.
public struct ToolResult: Sendable, Equatable {
    public let callId: String
    public let content: String
    public let isError: Bool

    public init(callId: String, content: String, isError: Bool) {
        self.callId = callId
        self.content = content
        self.isError = isError
    }

    /// Returns a copy bound to `callId` — the seam ChatEngine uses to stamp a tool's answer with the
    /// call it is answering, since the tools themselves produce results with an empty `callId`.
    public func attaching(callId: String) -> ToolResult {
        ToolResult(callId: callId, content: content, isError: isError)
    }
}

// MARK: - provider seam

/// One event a provider streams for a turn — the Swift mirror of `providers/types.ts`'s
/// `ProviderEvent` discriminated union. Errors are EVENTS, never thrown (faithful to the TS: an
/// `openai-compatible` provider maps a network failure to `.error(code: .network, …)` rather than
/// rejecting the iterator), which is why `ChatProvider.streamTurn` returns a non-throwing
/// `AsyncStream`. The research runner consumes `textDelta`/`toolCall`/`done`/`error` and ignores
/// `reasoningItem`/`usage` (it has no session to persist them to).
public enum ProviderEvent: Sendable {
    case textDelta(String)
    case toolCall(callId: String, name: String, argumentsJSON: String)
    case reasoningItem(itemJSON: String)
    case usage(inputTokens: Int, outputTokens: Int)
    case done(ProviderStopReason)
    case error(ProviderError)
}

public enum ProviderStopReason: String, Sendable, Equatable {
    case endTurn = "end_turn"
    case toolCalls = "tool_calls"
    case aborted
}

/// Mirrors `ProviderEvent`'s `error` variant. `code` is the discriminant the research runner's
/// model-fallback rule keys on (only a `badRequest` that also names the current model retries —
/// see `ResearchRunner.looksLikeBadModelError`).
public struct ProviderError: Sendable, Equatable {
    public enum Code: String, Sendable, Equatable {
        case auth
        case rateLimit = "rate_limit"
        case server
        case network
        case badRequest = "bad_request"
    }

    public let code: Code
    public let message: String
    public let retryAfterMs: Int?

    public init(code: Code, message: String, retryAfterMs: Int? = nil) {
        self.code = code
        self.message = message
        self.retryAfterMs = retryAfterMs
    }
}

public enum ProviderRole: String, Sendable, Equatable {
    case user
    case assistant
    case system
}

/// One item in a turn's input — the Swift mirror of the `TurnInputItem` cases the research loop
/// actually builds (a user/assistant message, a function call it is echoing back, and a tool
/// result). Task 8's ResponsesClient may extend this for its own richer input; the research runner
/// needs only these three.
public enum ProviderInputItem: Sendable {
    case message(role: ProviderRole, content: String)
    case functionCall(callId: String, name: String, argumentsJSON: String)
    case toolResult(callId: String, output: String, isError: Bool)
}

/// A tool advertised to the model. `parametersJSON` is a JSON Schema string (the TS carries
/// `z.toJSONSchema(...)`; here the schema is a literal, since the research runner's one tool has a
/// fixed shape).
public struct ProviderToolSpec: Sendable, Equatable {
    public let name: String
    public let description: String
    public let parametersJSON: String

    public init(name: String, description: String, parametersJSON: String) {
        self.name = name
        self.description = description
        self.parametersJSON = parametersJSON
    }
}

/// One turn's request — the Swift mirror of `providers/types.ts`'s `TurnRequest`, minus `signal`
/// (cancellation is delivered out-of-band: the research runner tears fetches down through a
/// `ChatAbortSignal` and cancels the provider stream by cancelling its consuming task).
public struct ProviderTurnRequest: Sendable {
    public let model: String
    public let instructions: String?
    public let input: [ProviderInputItem]
    public let tools: [ProviderToolSpec]
    /// Reasoning-effort slug (`low` for research). Omitted → no reasoning field on the wire.
    public let reasoningEffort: String?

    public init(model: String, instructions: String?, input: [ProviderInputItem],
                tools: [ProviderToolSpec], reasoningEffort: String?) {
        self.model = model
        self.instructions = instructions
        self.input = input
        self.tools = tools
        self.reasoningEffort = reasoningEffort
    }
}

/// The model seam. Task 8 owns `ResponsesClient` and conforms it to this protocol; the research
/// runner depends only on this, so every research test drives a SCRIPTED provider double and never
/// touches the network or a real model.
public protocol ChatProvider: Sendable {
    /// A fresh event stream per call (each `streamTurn` is one turn, exactly as the TS returns a new
    /// `AsyncIterable` per call). Errors arrive as `.error` events; the stream never throws.
    func streamTurn(_ request: ProviderTurnRequest) -> AsyncStream<ProviderEvent>
}
