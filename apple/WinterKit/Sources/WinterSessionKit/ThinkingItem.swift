import Foundation
import WinterProtocol

/// One reasoning block as a transcript shows it — the "thinking pill" (2026-10-05).
///
/// The daemon projects the runtime's reasoning frames into two events: a TRANSIENT `thinking_delta`
/// (`phase: "start"` opens the pill, each `"delta"` appends text and, when it changed, carries the
/// block's title) and a PERSISTED `thinking_block` appended when the block closes. A client keeps ONE
/// item per `blockId`: deltas build it live, the persisted block REPLACES it, and a replay (history,
/// a reattach) sees only persisted blocks. The daemon derives the title (the provider's own
/// `**heading**`, or a progress update's sentence); a client never parses reasoning text.
///
/// SHARED by the Mac app (`SessionReducer` folds it into an exchange's activity) and the phone (its
/// transcript builder), so both fold the two events the same way and both say "Thinking" / title /
/// "Thought" alike. Typed entry points for a decoded `SessionEvent`, JSON ones for the phone's opaque
/// `SessionEnvelope.json`. `text` is kept whole on the item so an expand view can show it later; the
/// pill itself never renders it.
public struct ThinkingItem: Equatable, Sendable {
    /// What a pill with no title says while its block is still streaming.
    public static let liveLabel = "Thinking"
    /// What a pill with no title says once its block is done (past tense, like the tool pills).
    public static let doneLabel = "Thought"
    /// The daemon's own cap on a block's text (`THINKING_TEXT_MAX_LENGTH`, packages/protocol) — a
    /// client holds no more than this of the live text either.
    public static let maxTextLength = 20_000
    /// The wire's two type names.
    public static let blockType = "thinking_block"
    public static let deltaType = "thinking_delta"

    public let blockId: String
    public let threadId: String
    /// `summary | update | exposed | hidden` — the last kind the block reported (an open set).
    public var kind: String
    /// The daemon-derived title, if the block has one so far.
    public var title: String?
    /// The readable reasoning so far (live: every delta's increment, concatenated; done: the persisted
    /// text). Empty for a hidden block.
    public var text: String
    public var truncated: Bool
    /// True while only `thinking_delta`s have built the item — its `thinking_block` has not arrived.
    public var isLive: Bool
    public var durationMs: Int?
    public var provider: String?
    public var model: String?

    public init(blockId: String, threadId: String, kind: String, title: String? = nil, text: String = "",
                truncated: Bool = false, isLive: Bool, durationMs: Int? = nil, provider: String? = nil,
                model: String? = nil) {
        self.blockId = blockId
        self.threadId = threadId
        self.kind = kind
        self.title = title
        self.text = text
        self.truncated = truncated
        self.isLive = isLive
        self.durationMs = durationMs
        self.provider = provider
        self.model = model
    }

    /// The persisted block, as the item it replaces any live one with.
    public init(block: SessionEvent.ThinkingBlock) {
        self.init(blockId: block.blockId, threadId: block.threadId, kind: block.kind,
                  title: Self.nonEmpty(block.title), text: block.text, truncated: block.truncated ?? false,
                  isLive: false, durationMs: block.durationMs, provider: block.provider, model: block.model)
    }

    /// Whether the pill is still thinking: the block is live AND its turn is. A block whose turn ended
    /// without a `thinking_block` (a crashed child) reads as done, never as a shimmer forever.
    public func isRunning(turnIsLive: Bool) -> Bool { isLive && turnIsLive }

    /// What the pill says: the title when there is one, else "Thinking" while running, else "Thought".
    public func label(turnIsLive: Bool) -> String {
        if let title = Self.nonEmpty(title) { return title }
        return isRunning(turnIsLive: turnIsLive) ? Self.liveLabel : Self.doneLabel
    }

    /// The ONE fold of a `thinking_delta` onto what a client holds for its block (`nil` = nothing yet).
    /// A delta for a block already replaced by its persisted record is ignored (the record is the
    /// truth); otherwise the kind follows the delta, the text grows by the increment (capped at
    /// `maxTextLength`), and the title changes only when the delta carries one — an absent title
    /// means "unchanged".
    public static func folding(_ existing: ThinkingItem?, delta: SessionEvent.ThinkingDelta) -> ThinkingItem {
        if let existing, !existing.isLive { return existing }
        var item = existing ?? ThinkingItem(blockId: delta.blockId, threadId: delta.threadId, kind: delta.kind, isLive: true)
        item.kind = delta.kind
        if let increment = delta.text, !increment.isEmpty {
            let room = maxTextLength - item.text.count
            if room <= 0 {
                item.truncated = true
            } else if increment.count <= room {
                item.text += increment
            } else {
                item.text += String(increment.prefix(room))
                item.truncated = true
            }
        }
        if let title = nonEmpty(delta.title) { item.title = title }
        return item
    }

    // MARK: Opaque JSON (the phone's `SessionEnvelope.json`)

    /// The fold for an opaque event: a `thinking_delta` folds onto `existing`, a `thinking_block`
    /// replaces it; `nil` when `json` is neither (or does not decode) — the caller keeps what it had.
    /// The caller keys `existing` by the event's `blockId` (`blockId(of:)`).
    public static func folding(_ existing: ThinkingItem?, json: SessionEvent.JSONValue) -> ThinkingItem? {
        switch json["type"]?.stringValue {
        case deltaType:
            guard let delta = decode(SessionEvent.ThinkingDelta.self, json) else { return nil }
            return folding(existing, delta: delta)
        case blockType:
            guard let block = decode(SessionEvent.ThinkingBlock.self, json) else { return nil }
            return ThinkingItem(block: block)
        default:
            return nil
        }
    }

    /// The `blockId` of a `thinking_delta`/`thinking_block`, `nil` for any other event.
    public static func blockId(of json: SessionEvent.JSONValue) -> String? {
        guard let type = json["type"]?.stringValue, type == deltaType || type == blockType else { return nil }
        return nonEmpty(json["blockId"]?.stringValue)
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: SessionEvent.JSONValue) -> T? {
        guard let data = try? JSONEncoder().encode(json) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }
}
