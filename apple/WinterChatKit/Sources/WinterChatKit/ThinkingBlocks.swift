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
    /// first) — `deriveThinkingTitle`, verbatim in behaviour (user ruling 2026-10-05):
    ///
    ///  - `summary` / `exposed` → from the LATEST part: the provider's own heading (the LAST valid
    ///    `**…**` heading standing alone at the START OF A LINE — never a label or file name like
    ///    `**src/calc.js:**`), else the ACTIVITY rule over the prose (`ThinkingTitleRule.swift`).
    ///    `final` (the block has ended) lets the trailing sentence count whatever it ends with.
    ///  - `update`  → the update's own text, whitespace-collapsed and trimmed.
    ///  - `hidden` (and any unknown kind) → none.
    ///
    /// Capped at `titleMaxLength` UTF-16 units with an ellipsis.
    public static func derive(kind: String, parts: [String], final: Bool = true) -> String? {
        switch kind {
        case "summary", "exposed":
            guard let latest = parts.last else { return nil }
            let rule = ActivityTitleTracker()
            rule.push(latest)
            return decideTitle(kind: kind, ThinkingHeading.scan(latest, final: final), rule.placed(final: final))
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

    /// The daemon's `cleanText` (its `collapse`): whitespace runs → one space, trimmed; control,
    /// zero-width and bidi units dropped (`ThinkingTitleRule.swift`).
    static func collapse(_ s: String) -> String { cleanText(s) }

    /// At most `titleMaxLength` units, an ellipsis marking a cut.
    static func clip(_ s: String) -> String {
        guard s.utf16.count > titleMaxLength else { return s }
        var head = sliceUnits(s, titleMaxLength - 1)
        while let last = head.last, last.isWhitespace { head.removeLast() }
        return head + "…"
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
        /// Units pushed to this part so far.
        var total = 0
        /// The last valid heading on a closed line, with its offset — kept once it scrolls out of the
        /// window.
        var heading: Placed?
        /// Where the part's opening heading's body ends (the next heading-shaped line), once seen.
        var protectEnd: Int?
        /// The activity rule over the part's whole text, incremental.
        let rule = ActivityTitleTracker()

        /// The tail window and its offset in the part, its partial first line dropped once the window
        /// has lost its start (a `**` there could be mid-line in the real text).
        var scanWindow: (text: String, start: Int) {
            let start = total - tail.count
            guard tailCut else { return (String(decoding: tail, as: UTF16.self), start) }
            guard let nl = tail.firstIndex(of: 0x0A) else { return ("", total) }
            return (String(decoding: tail[(nl + 1)...], as: UTF16.self), start + nl + 1)
        }
    }

    private struct OpenBlock {
        let blockId: String
        var kind: String
        var body = ""
        var bodyUnits = 0
        var truncated = false
        var parts: [Part] = []
        /// The last NON-EMPTY COMMITTED title — sticky, and what the block persists.
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
            return ids.compactMap { id -> SessionEvent? in
                guard var b = open[id] else { return nil }
                retitle(&b, .cut)   // no end frame: commit the live title, never a cut-off sentence
                return close(b)
            }
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
            current.total += rawUnits.count
            current.rule.push(raw)
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

        let before = b.title
        retitle(&b, .delta)
        let titleChanged = b.title != nil && b.title != before
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
        // The block's own end counts its trailing sentence (it may end with no punctuation).
        retitle(&b, .end)
        return [close(b)]
    }

    /// The block's title (`retitle` in the daemon), kept incrementally — no provisional titles
    /// (review r2). `.delta`/`.cut` (closed without its end): CLOSED text only — headings on closed lines
    /// (the latest kept once it scrolls out of the window), complete sentences — so a cut block stores
    /// the last title it showed. `.end`: the whole text counts, so the stored title is exactly the
    /// whole-text derivation. Sticky: no answer keeps the last title.
    private enum RetitleMode { case delta, end, cut }

    private func retitle(_ b: inout OpenBlock, _ mode: RetitleMode) {
        if b.kind == "update" {
            if let derived = ThinkingTitle.derive(kind: "update", parts: b.parts.map { String(decoding: $0.head, as: UTF16.self) }) {
                b.title = derived
            }
            return
        }
        guard b.kind == "summary" || b.kind == "exposed", !b.parts.isEmpty else { return }
        let final = mode == .end
        var p = b.parts[b.parts.count - 1]
        let win = p.scanWindow
        let scanned = ThinkingHeading.scan(win.text, final: final, base: win.start)
        let closed = final ? ThinkingHeading.scan(win.text, final: false, base: win.start) : scanned
        if closed.latest != nil || !p.tailCut { p.heading = closed.latest }
        let latest = final ? (scanned.latest ?? p.heading) : p.heading
        // The opening heading sits in the part's first line, always inside `head`.
        let opening = ThinkingHeading.scan(String(decoding: p.head, as: UTF16.self), final: final && p.total == p.head.count).opening
        var protectEnd = p.protectEnd
        if let opening, protectEnd == nil {
            if let firstClosed = closed.lines.first(where: { $0 > opening.pos }) { p.protectEnd = firstClosed; protectEnd = firstClosed }
            else if final { protectEnd = scanned.lines.first(where: { $0 > opening.pos }) }
        }
        b.parts[b.parts.count - 1] = p
        var facts = HeadingFacts()
        facts.latest = latest
        facts.opening = opening
        facts.protectEnd = protectEnd
        if let derived = decideTitle(kind: b.kind, facts, p.rule.placed(final: final)) { b.title = derived }
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
