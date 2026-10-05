import Foundation
import WinterProtocol

/// ── THE THINKING PILL, PHONE ENGINE (2026-10-05) ───────────────────────────────────────────────
///
/// The faithful Swift port of the daemon's `packages/core/src/projector/thinking.ts`: the phone's own
/// chat engine is a SECOND producer of the pill's two events, so it must build them exactly as the
/// daemon does —
///
///   start → `thinking_delta` {phase: "start"}                         (TRANSIENT, local UI only)
///   delta → `thinking_delta` {phase: "delta", text?, title?}          (TRANSIENT, local UI only)
///   end   → `thinking_block` {text, title?, kind, durationMs, …}      (PERSISTED, `sync.push`ed)
///
/// and derive the TITLE with the same rule (`ThinkingTitle.derive`), tested against the same cases.
///
/// Reasoning text is for the HUMAN. It never reaches a provider request (`LocalEventStore`'s
/// `eventToInput` has no case for either event), a log line (nothing here logs) or `sync.push` as a
/// transient (`LocalChatSession.persist` drops every transient; the daemon refuses a pushed
/// `thinking_delta` anyway). Opaque material (encrypted content) is never on these events at all.

// MARK: - the title (pure)

public enum ThinkingTitle {
    /// The protocol's caps, in UTF-16 code units — what zod's `.max` measures (`THINKING_*_MAX_LENGTH`,
    /// packages/protocol). A Swift `Character` count would let a title past 200 units through, and the
    /// daemon refuses the WHOLE `sync.push` batch that carries it.
    public static let titleMaxLength = 200
    public static let textMaxLength = 20_000
    public static let idMaxLength = 256

    /// PURE: a reasoning block's pill title from its kind and the text of its parts so far (oldest
    /// first) — `deriveThinkingTitle`, verbatim in behaviour:
    ///
    ///  - `summary` → the LAST complete `**…**` heading that sits at the START OF A LINE anywhere in
    ///    the LATEST part. A heading still missing its closing `**` does not count (the one before it
    ///    still does); a bold word mid-line is not a heading.
    ///  - `update`  → the update's own text, whitespace-collapsed and trimmed.
    ///  - `exposed` / `hidden` (and any unknown kind) → none.
    ///
    /// Capped at `titleMaxLength` UTF-16 units with an ellipsis.
    public static func derive(kind: String, parts: [String]) -> String? {
        switch kind {
        case "summary":
            guard let latest = parts.last else { return nil }
            return lastLineHeading(latest)
        case "update":
            let text = collapse(parts.joined(separator: " "))
            return text.isEmpty ? nil : clip(text)
        default:
            return nil
        }
    }

    /// The first `n` UTF-16 units of `s`, never ending on half of a surrogate pair (`sliceUnits`).
    public static func sliceUnits(_ s: String, _ n: Int) -> String {
        let units = Array(s.utf16)
        guard units.count > n else { return s }
        var cut = Array(units.prefix(max(0, n)))
        if let last = cut.last, (0xD800...0xDBFF).contains(last) { cut.removeLast() }
        return String(decoding: cut, as: UTF16.self)
    }

    /// Whitespace runs collapsed to single spaces, trimmed (`s.replace(/\s+/g, " ").trim()`).
    static func collapse(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// At most `titleMaxLength` units, an ellipsis marking a cut.
    static func clip(_ s: String) -> String {
        guard s.utf16.count > titleMaxLength else { return s }
        var head = sliceUnits(s, titleMaxLength - 1)
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + "…"
    }

    /// The JS line terminators (`^`/`.` under the `m` flag): a heading never spans one.
    private static let lineBreaks: Set<UInt16> = [0x0A, 0x0D, 0x2028, 0x2029]
    private static let star: UInt16 = 0x2A

    /// `/^[ \t]*\*\*(.+?)\*\*/gm`: per line, optional spaces/tabs, `**`, at least one unit, the
    /// FIRST closing `**` after it. The last such heading with non-blank content wins.
    static func lastLineHeading(_ text: String) -> String? {
        var found: String?
        let units = Array(text.utf16)
        var lineStart = 0
        var i = 0
        while i <= units.count {
            if i == units.count || lineBreaks.contains(units[i]) {
                if let inner = headingInner(units[lineStart..<i]) {
                    let collapsed = collapse(String(decoding: inner, as: UTF16.self))
                    if !collapsed.isEmpty { found = collapsed }
                }
                lineStart = i + 1
            }
            i += 1
        }
        return found.map(clip)
    }

    private static func headingInner(_ line: ArraySlice<UInt16>) -> ArraySlice<UInt16>? {
        var p = line.startIndex
        while p < line.endIndex, line[p] == 0x20 || line[p] == 0x09 { p += 1 }
        guard p + 1 < line.endIndex, line[p] == star, line[p + 1] == star else { return nil }
        let innerStart = p + 2
        // Lazy `.+?`: the closing `**` may start no earlier than one unit past the opening.
        var q = innerStart + 1
        while q + 1 < line.endIndex {
            if line[q] == star, line[q + 1] == star { return line[innerStart..<q] }
            q += 1
        }
        return nil
    }
}

// MARK: - the open blocks

/// The phone engine's reasoning-block state for ONE turn — the port of the daemon's `ThinkingBlocks`
/// class. Every method returns the events to emit, already stamped through `Stamp` (a transient rides
/// the head seq, a persisted block advances it), so the engine only forwards them.
///
/// A `delta` or `end` for a block never `start`ed opens it implicitly (a frame lost or reordered must
/// not lose the pill); a second `end` for a block already closed is dropped quietly, so a stream that
/// repeats itself never appends a block twice.
final class ThinkingBlocks: @unchecked Sendable {
    /// How the engine stamps an event: the head seq for a transient, a fresh seq for a persisted one,
    /// and the clock (epoch ms).
    struct Stamp: Sendable {
        let transientSeq: @Sendable () -> Int
        let nextSeq: @Sendable () -> Int
        let nowMs: @Sendable () -> Int
    }

    /// How much of each part's START is kept for an update's title, and how much of its END is scanned
    /// for a summary's heading (`TITLE_HEAD_CHARS` / `TITLE_TAIL_CHARS`) — UTF-16 units.
    static let titleHeadUnits = 600
    static let titleTailUnits = 4096

    private struct Part {
        var number: Int?
        var head: [UInt16] = []
        var tail: [UInt16] = []
        var tailCut = false

        /// The tail window, its partial first line dropped once the window has lost its start (a `**`
        /// there could be mid-line in the real text).
        var scanWindow: String {
            guard tailCut else { return String(decoding: tail, as: UTF16.self) }
            guard let nl = tail.firstIndex(of: 0x0A) else { return "" }
            return String(decoding: tail[(nl + 1)...], as: UTF16.self)
        }
    }

    private struct OpenBlock {
        let blockId: String
        var kind: String
        var body = ""
        var bodyUnits = 0
        var truncated = false
        var parts: [Part] = []
        /// The last NON-EMPTY title derived — sticky.
        var title: String?
        var startedAt: Int?
    }

    private let lock = NSLock()
    private var open: [String: OpenBlock] = [:]
    private var order: [String] = []
    private var ended: Set<String> = []

    private let sessionId: String
    private let threadId: String
    private let provider: String?
    private let model: String?
    private let stamp: Stamp

    init(sessionId: String, threadId: String, provider: String?, model: String?, stamp: Stamp) {
        self.sessionId = sessionId
        self.threadId = threadId
        self.provider = provider.flatMap(Self.boundedName)
        self.model = model.flatMap(Self.boundedName)
        self.stamp = stamp
    }

    /// Whether a block is still open — the engine's tests read it.
    var openCount: Int { lock.withLock { open.count } }

    /// One provider progress step → the events it projects to.
    func accept(_ progress: ProviderReasoningProgress) -> [SessionEvent] {
        lock.withLock {
            switch progress.phase {
            case .start: return start(progress)
            case .delta: return delta(progress)
            case .end: return end(progress)
            }
        }
    }

    /// Closes every block still open (oldest first) — the round's end, an error or an interrupt with
    /// a block mid-stream. Every started block gets its persisted record.
    func closeAll() -> [SessionEvent] {
        lock.withLock {
            let ids = order.filter { open[$0] != nil }
            return ids.compactMap { id in open[id].map { close($0) } }
        }
    }

    // MARK: phases (called under the lock)

    private func openBlock(_ p: ProviderReasoningProgress) -> OpenBlock {
        if let existing = open[p.blockId] { return existing }
        let block = OpenBlock(blockId: p.blockId, kind: p.kind ?? "hidden",
                              startedAt: p.phase == .start ? stamp.nowMs() : nil)
        open[p.blockId] = block
        order.append(p.blockId)
        return block
    }

    private func start(_ p: ProviderReasoningProgress) -> [SessionEvent] {
        guard !ended.contains(p.blockId), open[p.blockId] == nil else { return [] }
        let b = openBlock(p)
        return [deltaEvent(b, phase: "start", text: nil, title: nil)]
    }

    private func delta(_ p: ProviderReasoningProgress) -> [SessionEvent] {
        guard !ended.contains(p.blockId) else { return [] }
        var b = openBlock(p)
        let newKind = p.kind ?? b.kind
        let kindChanged = b.kind != newKind
        b.kind = newKind

        let raw = p.text ?? ""
        var increment = ""
        if !raw.isEmpty {
            let rawUnits = Array(raw.utf16)
            let isNewPart = b.parts.last.map { last in p.part != nil && p.part != last.number } ?? true
            if isNewPart { b.parts.append(Part(number: p.part)) }
            var current = b.parts[b.parts.count - 1]
            if current.head.count < Self.titleHeadUnits {
                current.head += Array(ThinkingTitle.sliceUnits(raw, Self.titleHeadUnits - current.head.count).utf16)
            }
            current.tail += rawUnits
            if current.tail.count > Self.titleTailUnits {
                current.tail = Array(current.tail.suffix(Self.titleTailUnits))
                current.tailCut = true
            }
            b.parts[b.parts.count - 1] = current

            let piece = (isNewPart && b.bodyUnits > 0 ? "\n\n" : "") + raw
            let room = ThinkingTitle.textMaxLength - b.bodyUnits
            if room <= 0 || b.truncated {
                // Once cut, the text stays the HEAD it was: nothing later is appended after a gap.
                b.truncated = true
            } else {
                increment = ThinkingTitle.sliceUnits(piece, room)
                let incrementUnits = increment.utf16.count
                if incrementUnits < piece.utf16.count { b.truncated = true }
                b.body += increment
                b.bodyUnits += incrementUnits
            }
        }

        let partTexts = b.parts.map { part in
            b.kind == "update" ? String(decoding: part.head, as: UTF16.self) : part.scanWindow
        }
        let derived = ThinkingTitle.derive(kind: b.kind, parts: partTexts)
        let titleChanged = derived != nil && derived != b.title
        if titleChanged { b.title = derived }
        open[b.blockId] = b
        if increment.isEmpty && !titleChanged && !kindChanged { return [] }
        // The CURRENT title rides every delta that carries text, not only a change (review r1).
        let title = (titleChanged || !increment.isEmpty) ? b.title : nil
        return [deltaEvent(b, phase: "delta", text: increment.isEmpty ? nil : increment, title: title)]
    }

    private func end(_ p: ProviderReasoningProgress) -> [SessionEvent] {
        guard !ended.contains(p.blockId) else { return [] }
        var b = openBlock(p)
        // The block takes the LAST kind it reported; a close that names one (a scripted provider)
        // is a report like any other.
        if let kind = p.kind { b.kind = kind }
        return [close(b)]
    }

    private func close(_ b: OpenBlock) -> SessionEvent {
        open[b.blockId] = nil
        ended.insert(b.blockId)
        let durationMs = b.startedAt.map { max(0, stamp.nowMs() - $0) }
        return .thinkingBlock(.init(
            seq: stamp.nextSeq(), sessionId: sessionId, ts: stamp.nowMs(), threadId: threadId,
            blockId: b.blockId, kind: b.kind, title: b.title, text: b.body,
            truncated: b.truncated ? true : nil, provider: provider, model: model, durationMs: durationMs))
    }

    private func deltaEvent(_ b: OpenBlock, phase: String, text: String?, title: String?) -> SessionEvent {
        .thinkingDelta(.init(seq: stamp.transientSeq(), sessionId: sessionId, ts: stamp.nowMs(),
                             threadId: threadId, blockId: b.blockId, kind: b.kind, phase: phase,
                             text: text, title: title))
    }

    private static func boundedName(_ v: String) -> String? {
        guard !v.isEmpty else { return nil }
        let bounded = ThinkingTitle.sliceUnits(v, ThinkingTitle.idMaxLength)
        return bounded.isEmpty ? nil : bounded
    }
}
