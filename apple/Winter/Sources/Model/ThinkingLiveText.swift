import Foundation
import WinterProtocol

/// The Mac's live reasoning text (2026-10-06): what a streaming thinking pill shows when it is opened.
///
/// The shared `ThinkingItem` (WinterSessionKit, also the phone's) deliberately keeps NO live text — its
/// fold is O(the delta), a running count only (`liveTextLength`). The Mac's opened pill streams the
/// text, so the Mac keeps it HERE, beside the reducer rather than in it: `SessionReducer.reduce` copies
/// `OrbSessionState` per event while the model still holds the previous state, so a `String` in that
/// state would be shared with it and every `append` would copy the whole block (O(n) per delta). This
/// buffer is owned by `SessionModel` alone, so each append is O(the delta), amortised.
///
/// Nothing compares the text: each block carries a `revision` bumped per append, and the views are
/// re-rendered by the item itself (`ThinkingItem.liveTextLength` grows with every delta that carries
/// text, which changes the exchange). A block's persisted `thinking_block` REPLACES its live text —
/// the entry is dropped and the item's own `text` is the truth from then on; a late delta for a
/// closed block is ignored, as the shared fold ignores it.
///
/// Main thread only, like the reducer's thinking fold. Bounded: at most `maxBlocks` live blocks (the
/// oldest dropped), each at most `ThinkingItem.maxTextLength` UTF-16 units (the daemon's own cap on a
/// persisted block) — the rest of a longer stream is not kept, and `truncated` says so.
@MainActor
final class ThinkingLiveText {
    struct Block: Equatable {
        var text: String = ""
        /// UTF-16 units in `text`, kept so the cap check never counts the string.
        var length = 0
        /// Bumped by every append that added text.
        var revision = 0
        var truncated = false
    }

    static let maxBlocks = 16
    static let maxClosed = 64
    private static let mainThread = "main"

    private var blocks: [String: Block] = [:]
    /// `blocks`' keys, oldest first.
    private var order: [String] = []
    /// Blocks whose persisted record has arrived — later deltas for them are ignored.
    private var closed: [String] = []
    private var closedSet: Set<String> = []

    /// The live text of `blockId`, or nil when none is kept (no text yet, a closed block, a hidden one).
    func text(for blockId: String) -> String? { blocks[blockId]?.text }

    func block(for blockId: String) -> Block? { blocks[blockId] }

    /// The number of live blocks held (tests).
    var countForTesting: Int { blocks.count }

    /// Folds one event: a main-thread `thinking_delta` appends its increment, a main-thread
    /// `thinking_block` drops the block's live text. Everything else is ignored.
    func fold(_ event: SessionEvent) {
        switch event {
        case .thinkingDelta(let v) where v.threadId == Self.mainThread:
            append(v.text, to: v.blockId)
        case .thinkingBlock(let v) where v.threadId == Self.mainThread:
            close(v.blockId)
        default:
            break
        }
    }

    func reset() {
        blocks = [:]
        order = []
        closed = []
        closedSet = []
    }

    private func append(_ increment: String?, to blockId: String) {
        guard !closedSet.contains(blockId), let increment, !increment.isEmpty else { return }
        if blocks[blockId] == nil {
            blocks[blockId] = Block()
            order.append(blockId)
            while order.count > Self.maxBlocks { blocks[order.removeFirst()] = nil }
        }
        let room = ThinkingItem.maxTextLength - (blocks[blockId]?.length ?? 0)
        guard room > 0 else {
            blocks[blockId]?.truncated = true
            return
        }
        let units = increment.utf16.count
        if units <= room {
            // In place through the dictionary's own accessor — no copy of what is already there.
            blocks[blockId]?.text.append(increment)
            blocks[blockId]?.length += units
        } else {
            let kept = String(increment.utf16.prefix(room)) ?? String(increment.prefix(room))
            blocks[blockId]?.text.append(kept)
            blocks[blockId]?.length += kept.utf16.count
            blocks[blockId]?.truncated = true
        }
        blocks[blockId]?.revision += 1
    }

    private func close(_ blockId: String) {
        if blocks.removeValue(forKey: blockId) != nil, let i = order.firstIndex(of: blockId) { order.remove(at: i) }
        guard closedSet.insert(blockId).inserted else { return }
        closed.append(blockId)
        while closed.count > Self.maxClosed { closedSet.remove(closed.removeFirst()) }
    }
}

/// PURE: whether a reasoning block has text a thinking pill can open onto — the persisted text, or
/// (while it streams) some text streamed so far, read off the item's own running count so a CLOSED
/// pill never touches the live buffer. Cheap: never walks more than the leading whitespace. A hidden
/// block has none, so its pill shows no chevron.
func thinkingHasReadableText(_ item: ThinkingItem) -> Bool {
    if item.kind == "hidden" { return false }
    if item.isLive { return item.liveTextLength > 0 }
    return item.text.contains { !$0.isWhitespace }
}

/// PURE: the text an opened thinking pill shows — the persisted block's once it has arrived (it
/// replaces the live text), else what has streamed so far; nil when there is nothing to read.
func thinkingDisplayText(_ item: ThinkingItem, liveText: String?) -> String? {
    guard thinkingHasReadableText(item) else { return nil }
    if item.isLive {
        guard let liveText, liveText.contains(where: { !$0.isWhitespace }) else { return nil }
        return liveText
    }
    return item.text
}
