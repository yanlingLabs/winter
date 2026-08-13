import AppKit
import SwiftUI

/// v1 bubble/markdown/code-block port (donor: `ChatRootView.swift:1571-1953` — `ChatMessageBubble`,
/// `ChatFormattedMessageText`, `ChatMarkdownBlockView`, `ChatCodeBlock`, copy helpers), adapted for
/// the transcript: our inputs are plain `String`/`ActivityItem` (no `ChatMessage`/`AppState`, no
/// image placeholders, no reasoning content, no tool arrays — those are v1-only concerns that
/// don't apply here).
///
/// **Colour is `Theme`'s, not the donor's tint scheme and no longer the system's hierarchy**
/// (mac-chat-parity Task 8): surfaces are named asset-catalog tokens per `docs/brand.md` § 3.1's
/// anti-rule, quiet meta text is `Theme.textMuted`, and content text stays `.primary`. `.tertiary`
/// is gone from this surface for a measured reason, not a stylistic one — composited on
/// `CardSurface` it renders `#B9B9B7`, a **1.86:1** contrast ratio, which is below every legibility
/// floor there is; `TextMuted` measures 4.14:1 light / 5.99:1 dark.
///
/// No `.drawingGroup()` (v1 LAW) and no `repeatForever` animation anywhere below — this content
/// renders under the morph's scale/blur/opacity bands.

// MARK: - The prose register — MOVED to `App/Typography.swift` (2026-08-13 typography pass):
// `TranscriptProseRole`, `TranscriptProseMetrics`, `transcriptProseMetrics`,
// `transcriptProseFont` and the new `transcriptProseSwiftUIFont` all live with the rest of the
// type system now. Same symbols, same values; the views below are unchanged consumers.

/// The user's own message — right-aligned bubble, donor `ChatMessageBubble`'s `isUser` branch.
/// Surfaced on `Theme.bubbleUser` (mac-chat-parity Task 8), the brand's own token for exactly this
/// — it replaced a `.ultraThinMaterial`, which on an opaque window is a blur of whatever happens to
/// be behind it rather than a colour anyone chose. `tint` is kept in the signature (callers
/// unchanged) and still forwarded to `TranscriptFormattedMessageText` for the markdown accents that
/// actually read it — list markers and the quote rule — it just paints no surface. (Headings do
/// not: they go through `formattedText`, which never sees the tint.)
struct TranscriptUserBubble: View {
    let text: String
    let tint: Color

    /// **A wiring pin, not coverage** (same species as `ModelPickerTests.swift:767`): hoisted so
    /// "the user's own words are NOT set in Norma's voice" is assertable without rendering. The
    /// real weight is carried by `TranscriptBrandTests`' font-resolution pins, which prove what
    /// each role actually renders as.
    var proseRole: TranscriptProseRole { .sans }

    private var displayText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        HStack(alignment: .bottom) {
            Spacer(minLength: 90)

            content
                .frame(maxWidth: 560, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            TranscriptFormattedMessageText(text: displayText, tint: tint, role: proseRole,
                                           fillsAvailableWidth: false)
                .foregroundStyle(.primary)
        }
        .padding(14)
        .background(Theme.bubbleUser, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// Norma's reply — left-aligned, full width, formatted blocks + a per-message copy affordance
/// that hides while the reply is still streaming (donor `ChatMessageBubble`'s non-user branch).
///
/// `role` is REQUIRED, and the reason is this view's second consumer: both plan-card bodies
/// (`PendingCards.swift`) compose it to render a plan's markdown. A hardcoded serif here would put
/// every plan card into Norma's speaking voice, which `docs/brand.md` § 4 does not allowlist — so
/// the transcript's two call sites pass `.assistant` and the two card bodies pass `.sans`.
struct TranscriptAssistantMessage: View {
    let text: String
    let isStreaming: Bool
    let role: TranscriptProseRole

    @State private var isMessageCopyHovering = false
    @State private var didCopyMessage = false

    private var displayText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                // `Theme.accent` rather than `.accentColor`: SwiftUI's `.accentColor` resolves to
                // the USER's System Settings accent, because `docs/brand.md` § 3.2 deliberately
                // leaves `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` unset — so every bullet
                // and quote rule in the transcript was drawing in whatever colour the Mac's owner
                // had picked in General, not in Norma's teal.
                TranscriptFormattedMessageText(text: displayText, tint: Theme.accent,
                                               role: role, fillsAvailableWidth: true)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if !isStreaming {
                Button {
                    copyMessageToPasteboard()
                } label: {
                    transcriptCopyLabel(didCopy: didCopyMessage, iconOnlyWhenIdle: true)
                        .frame(width: 68, height: 22, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(transcriptCopyForeground(isHovering: isMessageCopyHovering, didCopy: didCopyMessage))
                .onHover { isMessageCopyHovering = $0 }
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func copyMessageToPasteboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(displayText, forType: .string)
        showMessageCopiedFeedback()
    }

    private func showMessageCopiedFeedback() {
        didCopyMessage = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            didCopyMessage = false
        }
    }
}

/// Donor `ChatFormattedMessageText` — splits fenced code out via `FormattedMessageBlock.parse`,
/// renders remaining text as markdown blocks and code as `TranscriptCodeBlock`.
private struct TranscriptFormattedMessageText: View {
    let text: String
    let tint: Color
    /// Which face the PROSE blocks take. Fenced code is unaffected — a code block is monospaced in
    /// both roles, which is the whole point of a code block.
    let role: TranscriptProseRole
    let fillsAvailableWidth: Bool

    private var blocks: [FormattedMessageBlock] {
        FormattedMessageBlock.parse(text)
    }

    var body: some View {
        content
            .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block.kind {
                case .text(let content):
                    ForEach(MessageTextFormatter.chatMarkdownBlocks(content)) { markdownBlock in
                        TranscriptMarkdownBlockView(block: markdownBlock, tint: tint, role: role)
                    }
                case .code(let language, let code):
                    TranscriptCodeBlock(
                        language: language,
                        code: code,
                        tint: tint,
                        fillsAvailableWidth: fillsAvailableWidth
                    )
                }
            }
        }
    }
}

/// Donor `ChatMarkdownBlockView`, structure unchanged — its two hardcoded ladders (a 14 pt body,
/// a 20/17/15.5/14.5 heading run, `lineSpacing(3)`) moved into `TranscriptProseMetrics` so the
/// serif register can carry its own, and the `.system` font became `transcriptProseFont`.
///
/// Colour: paragraph/heading/bullet/numbered text use `.primary` via `formattedText`'s
/// `.labelColor` base (unchanged from the donor), quote text is one step down, and the maths
/// background is `Theme.elevatedSurface` (mac-chat-parity Task 8) rather than a
/// `separatorColor`-times-an-alpha, which had no way to be tuned per appearance.
private struct TranscriptMarkdownBlockView: View {
    let block: FormattedMarkdownBlock
    let tint: Color
    let role: TranscriptProseRole

    @Environment(\.colorScheme) private var colorScheme

    private var metrics: TranscriptProseMetrics { transcriptProseMetrics(role) }

    var body: some View {
        switch block.kind {
        case .paragraph(let text):
            formattedText(text, size: metrics.bodySize, weight: .regular)
                .lineSpacing(metrics.lineSpacing)
        case .heading(let level, let text):
            formattedText(text, size: metrics.headingSize(level), weight: headingWeight(level))
                .padding(.top, level <= 2 ? 4 : 2)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                markerText("•")
                formattedText(text, size: metrics.bodySize, weight: .regular)
                    .lineSpacing(metrics.lineSpacing)
            }
        case .numbered(let marker, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                markerText(marker)
                    .frame(minWidth: 18, alignment: .trailing)
                formattedText(text, size: metrics.bodySize, weight: .regular)
                    .lineSpacing(metrics.lineSpacing)
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(tint.opacity(0.42))
                    .frame(width: 3)
                formattedText(text, size: metrics.quoteSize, weight: .regular)
                    .foregroundStyle(Theme.textMuted)
                    .lineSpacing(metrics.lineSpacing)
            }
            .padding(.vertical, 2)
        case .math(let text):
            Text(MessageTextFormatter.chatMathAttributedString(text))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.elevatedSurface))
        }
    }

    /// A list marker rides the role's own face, so a serif paragraph's bullets are not SF dots
    /// beside New York text — iOS's rule (`AssistantMarkdown.listRows` sets its markers serif too).
    private func markerText(_ marker: String) -> Text {
        Text(marker)
            .font(Font(transcriptProseFont(role, size: metrics.bodySize, weight: .semibold)))
            .foregroundStyle(tint)
    }

    private func formattedText(_ text: String, size: CGFloat, weight: NSFont.Weight) -> Text {
        Text(MessageTextFormatter.chatInlineAttributedString(
            text,
            colorScheme: colorScheme,
            baseFont: transcriptProseFont(role, size: size, weight: weight),
            codeFont: .monospacedSystemFont(ofSize: metrics.codeSize(for: size), weight: .regular),
            lineSpacing: metrics.lineSpacing
        ))
    }

    private func headingWeight(_ level: Int) -> NSFont.Weight {
        level <= 2 ? .semibold : .medium
    }
}

/// Donor `ChatCodeBlock`, ported as-is (horizontal scroll + syntax highlight + per-block copy).
/// mac-chat-parity Task 8 replaced its two derived surfaces — a `colorScheme`-branched
/// `black.opacity(0.32)`/`textBackgroundColor.opacity(0.72)` fill and a `separatorColor` × 0.38
/// border — with `Theme.elevatedSurface` and a hairline token, which is the same appearance branch
/// expressed once, in the asset catalog, where it can be tuned.
///
/// The rim is `Theme.hairlineElevated`, not the shell's `hairline` (fix round 1). A code block is
/// `elevatedSurface`, and inside a plan card so is its CONTAINER — identical fills, with only this
/// rim between them. `hairline` measures 1.040:1 on that ground in dark, i.e. it would have been
/// drawing nothing; `hairlineElevated` measures 1.312:1. The old `separatorColor` × 0.38 managed
/// 1.116:1 there, so this is a genuine improvement over the donor rather than a repair to parity.
private struct TranscriptCodeBlock: View {
    let language: String?
    let code: String
    let tint: Color
    let fillsAvailableWidth: Bool

    @Environment(\.colorScheme) private var colorScheme
    @State private var isCopyHovering = false
    @State private var didCopyCode = false
    @State private var isCodeBlockHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                HStack {
                    Text(language)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 12)

                    codeCopyButton
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 5)
            } else {
                HStack {
                    Spacer()
                    codeCopyButton
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 2)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(SyntaxHighlighter.highlighted(code, language: language, colorScheme: colorScheme))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, language == nil ? 10 : 8)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
        }
        .frame(maxWidth: fillsAvailableWidth ? .infinity : nil, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(codeBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(codeBorderColor, lineWidth: isCodeBlockHovering ? 1 : 0.5)
        )
        .shadow(
            color: tint.opacity(isCodeBlockHovering ? 0.28 : 0),
            radius: isCodeBlockHovering ? 7 : 0,
            x: 0,
            y: 2
        )
        .scaleEffect(isCodeBlockHovering ? 1.006 : 1)
        .animation(.easeOut(duration: 0.14), value: isCodeBlockHovering)
        .onHover { isCodeBlockHovering = $0 }
    }

    private var codeCopyButton: some View {
        Button {
            copyCodeToPasteboard()
        } label: {
            transcriptCopyLabel(didCopy: didCopyCode, iconOnlyWhenIdle: false)
                .frame(width: 68, height: 22, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(transcriptCopyForeground(isHovering: isCopyHovering, didCopy: didCopyCode))
        .onHover { isCopyHovering = $0 }
    }

    private var codeBackground: Color { Theme.elevatedSurface }

    private var codeBorderColor: Color {
        isCodeBlockHovering ? tint.opacity(0.55) : Theme.hairlineElevated
    }

    private func copyCodeToPasteboard() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        showCodeCopiedFeedback()
    }

    private func showCodeCopiedFeedback() {
        didCopyCode = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            didCopyCode = false
        }
    }
}

/// Donor copy helpers (`copyLabel`/`copyForeground`, `ChatRootView.swift:1906-1922`) — adaptive
/// variant of the foreground: the donor forced `.white`/`.black` by color scheme; here the
/// idle/hover/copied states use `.secondary`/`.primary` so the control never fights the
/// surrounding adaptive text.
private func transcriptCopyLabel(didCopy: Bool, iconOnlyWhenIdle: Bool) -> some View {
    HStack(spacing: 5) {
        Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
            .font(.system(size: 11, weight: .semibold))
        if didCopy || !iconOnlyWhenIdle {
            Text(didCopy ? "Copied" : "Copy")
                .font(.system(size: 11, weight: .medium))
        }
    }
}

private func transcriptCopyForeground(isHovering: Bool, didCopy: Bool) -> Color {
    (didCopy || isHovering) ? .primary : .secondary
}

// MARK: - Activity rows

/// Pure glyph/label mapper for one `ActivityItem` — no view/environment dependency so it's
/// directly unit-testable (`ActivityRowTests`). Kept exhaustive over `ActivityItem.Kind` so a
/// future case is a compile error here, not a silent blank row.
///
/// TWO of its branches are now unreachable in practice, and both stay only for
/// exhaustiveness/defensiveness and direct unit testing:
///   - `.tool` (LIVE-GATE G3): `groupActivity` always folds tool items into `.toolRun` groups
///     rendered by `TranscriptToolGroupRow`, never `.single`. It therefore shows no status and no
///     output — everything mac-chat-parity Task 2 added lives on the group row.
///   - `.interaction` (mac-chat-parity Task 3): `TranscriptExchangeRow` diverts every interaction
///     item to `TranscriptInteractionCard` before reaching `TranscriptActivityRow`. Its literal `⚠`
///     and one-line summary are what an interaction USED to render as, kept correct (and pinned by
///     `ActivityRowTests`) rather than deleted.
func activityGlyphAndLabel(_ item: ActivityItem) -> (glyph: String, label: String) {
    switch item.kind {
    case .tool(let name, let detail, _, _, _):
        return ("⚙", detail.map { "\(name): \($0)" } ?? name)
    case .task(let subject, let status):
        return (taskGlyph(for: status), subject)
    case .subagent(let agentType):
        return ("⌥", agentType)
    case .subagentDone:
        return ("✓", "subagent done")
    case .worktree(let entered, let detail):
        return (entered ? "⛿" : "⟲", detail)
    case .interaction(let record):
        return ("⚠", record.summary)
    }
}

private func taskGlyph(for status: String) -> String {
    switch status {
    case "in_progress": return "◐"
    case "completed": return "☑"
    default: return "☐" // pending, or any unrecognized status
    }
}

/// One line of "what happened" — donor has no equivalent (v1 never rendered per-turn activity);
/// this is new for the transcript, so it takes only the task-3 brief's explicit metrics: 11 pt
/// quiet meta, single line, middle truncation (long tool args/paths keep both ends visible).
/// mac-chat-parity Task 8 moved that "quiet" from `.tertiary` to `Theme.textMuted` — the brief's
/// figure was the system hierarchy's third level, which measures 1.86:1 on `CardSurface` and was
/// not legible at 11 pt.
struct TranscriptActivityRow: View {
    let item: ActivityItem

    var body: some View {
        let mapped = activityGlyphAndLabel(item)
        HStack(spacing: 6) {
            Text(mapped.glyph)
            Text(mapped.label)
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

/// The "⏹ stopped" line shown when an exchange's turn ended via Esc-interrupt
/// (`Exchange.aborted`) — v1 parity companion to the activity rows, same quiet-meta token.
struct TranscriptStoppedRow: View {
    var body: some View {
        HStack(spacing: 6) {
            Text("⏹")
            Text("stopped")
        }
        .font(.system(size: 11))
        .foregroundStyle(Theme.textMuted)
        .lineLimit(1)
        .truncationMode(.middle)
    }
}

// MARK: - Grouped tool lines (LIVE-GATE G3 / r1b)

/// ONE tool call inside a `ToolRunEntry` — everything the transcript knows about that call once
/// the reducer has folded its `tool_result` in (mac-chat-parity Task 2).
///
/// Before Task 2 a run kept only `count` plus a flat `[String]` of the calls' non-nil details, so
/// (a) there was nowhere to put the result the reducer had just started keeping, and (b) a call
/// with no extractable detail left NO trace at all — a run of five `browser` calls expanded to a
/// literally empty area. Keeping a record PER CALL fixes both, and makes `count` a derived fact
/// rather than a second number that could disagree with the details array.
///
/// The tool's NAME is deliberately not stored here: every call in an entry shares the entry's
/// `name` by construction (that is exactly what the same-name merge in `groupActivity` means), so
/// a per-call copy would be a second source of truth that could drift.
struct ToolCallRecord: Equatable {
    /// The wire's `tool_call.callId` — the reducer's join key for the matching `tool_result`,
    /// carried here as the call's stable identity. `nil` only for `.tool` items constructed
    /// without one (the pre-Task-1 shape, still reachable from tests).
    let callId: String?
    /// `SessionReducer.extractToolDetail`'s short hint (a command's first line, a path, a url, a
    /// `"<verb> <operand>"` pair — see that method's doc); `nil` when the tool has no useful
    /// one-line summary or its `argsJson` did not parse. Always ≤ ~100 characters, so the
    /// `lineLimit(1)` row below truncates only genuinely long values.
    let detail: String?
    /// The tool's result text, already capped by `SessionReducer.maxToolOutputCharacters`. `nil`
    /// means no result was ever seen for this call — which is NOT the same as "still running";
    /// see `toolCallStatus`.
    let output: String?
    /// The wire's `tool_result.isError`.
    let isError: Bool
}

/// Stable identity for one `.toolRun` group's EXPANSION state.
///
/// Expansion used to be keyed by the group's position in `groupActivity`'s output, which is not
/// stable: `SessionReducer.appendActivity` caps an exchange's activity at 200 items and drops the
/// OLDEST, so during a marathon turn every surviving group shifts down and an open expansion lands
/// on a neighbouring run. That was cosmetic when expanding revealed only argument lines; it is not
/// cosmetic now that it reveals tool output.
///
/// The run's first `callId` is the key, because the reducer takes it straight off the wire and it is
/// unique per call. `nil` only for `.tool` items built without one (the pre-Task-1 shape, still
/// reachable from tests), which falls back to the old positional key — no worse than before, and
/// never mixed up with a real callId thanks to the prefix.
///
/// This is not immune to eviction, and does not claim to be: if the run's own first call is the item
/// dropped, its key changes and an open expansion CLOSES. That is the better failure — a closed row
/// is visibly closed, where a positional key silently re-pointed the open row at a different run's
/// output.
func toolRunExpansionKey(_ entries: [ToolRunEntry], fallbackIndex: Int) -> String {
    for entry in entries {
        for call in entry.calls {
            if let callId = call.callId { return "call:\(callId)" }
        }
    }
    return "index:\(fallbackIndex)"
}

/// One same-name stretch of tool calls inside a `.toolRun` — a run can mix DIFFERENT tool names
/// back-to-back (r1b, CC parity: "Read 4 files, listed 1 directory, ran 8 shell commands") so a
/// run is an ordered array of these, one per same-name stretch.
struct ToolRunEntry: Equatable {
    let name: String
    /// Every call in this same-name stretch, in call order — INCLUDING calls that carry neither a
    /// detail nor a result.
    let calls: [ToolCallRecord]
    /// How many times this tool ran in this stretch — what `toolGroupFragment` counts. Derived, so
    /// it cannot drift from the calls it counts (the pre-Task-2 shape stored it separately from a
    /// `details` array that skipped detail-less calls, so `count` and `details.count` routinely
    /// disagreed and nothing could be zipped to anything positionally).
    var count: Int { calls.count }
}

/// One row's worth of rendered activity, AFTER grouping — the transcript renders `[ActivityGroup]`
/// (via `groupActivity` below), never the raw `[ActivityItem]` directly. r1b: an UNBROKEN run of
/// tool calls collapses into ONE `.toolRun` group regardless of how many different tool names
/// appear in it, so e.g. "read, read, glob, bash×8" reads as one comma-joined sentence row instead
/// of three separate lines.
enum ActivityGroup: Equatable {
    case toolRun([ToolRunEntry])
    case single(ActivityItem)
}

/// Pure grouping logic — no view/environment dependency, directly unit-testable. Every `.tool`
/// item, regardless of name, extends the CURRENT run (starting a new `.toolRun` group only if the
/// previous item wasn't a tool at all); within that run, consecutive `.tool` items with the SAME
/// name still merge into one `ToolRunEntry` — which since mac-chat-parity Task 2 keeps a
/// `ToolCallRecord` per call (detail AND result AND callId), so a call whose arguments produced no
/// detail is still an entry rather than vanishing, and `count` is simply how many records there
/// are — but a name change starts a new entry inside the same run rather than a
/// new group. `.task` items are SKIPPED ENTIRELY here, deliberately: live task state now lives in
/// the pinned incomplete-tasks section (LIVE-GATE G4, `FieldStateAdapter.pinnedTasks`), and the
/// task_create/task_update TOOL CALLS themselves already read as "Created N tasks"/"Updated N
/// tasks" via their own `.tool` activity — showing the same transition a third time (raw
/// task-status line) would be redundant clutter. Every other kind (subagent/subagentDone/worktree/
/// interaction) passes through unchanged as `.single` AND breaks any tool run in progress — a bash
/// call after an interaction starts a fresh run rather than merging across it, so the grouping
/// reflects the actual chronological interleaving.
func groupActivity(_ items: [ActivityItem]) -> [ActivityGroup] {
    var groups: [ActivityGroup] = []
    for item in items {
        switch item.kind {
        case .task:
            continue // deliberate — see doc comment above
        case .tool(let name, let detail, let callId, let output, let isError):
            let record = ToolCallRecord(callId: callId, detail: detail, output: output, isError: isError)
            if case .toolRun(var entries) = groups.last {
                if let last = entries.last, last.name == name {
                    entries[entries.count - 1] = ToolRunEntry(name: name, calls: last.calls + [record])
                } else {
                    entries.append(ToolRunEntry(name: name, calls: [record]))
                }
                groups[groups.count - 1] = .toolRun(entries)
            } else {
                groups.append(.toolRun([ToolRunEntry(name: name, calls: [record])]))
            }
        default:
            groups.append(.single(item))
        }
    }
    return groups
}

/// Pure lowercase fragment for one `ToolRunEntry` — the sentence-building unit consumed by
/// `toolRunSentence`. Natural verbs, singular/plural, matching the brief's exact vocabulary.
/// `ls` (the native directory-listing tool, added after r1b) gets "listed a directory"/"listed N
/// directories" — the label r1b had temporarily borrowed for `glob` as a stand-in while Norma had
/// no dedicated lister. Now that `ls` exists, `glob` REVERTS to its pre-r1b "searched"/"searched N
/// times" (same fragment as `grep` — both are pattern searches, not directory listings). Any tool
/// name not explicitly listed (future tools, `mcp__*` server tools, etc.) falls back to "used a
/// tool"/"used N tools" rather than a blank or raw tool name. None of these fragments are
/// proper-noun-ish — keep it that way, since `toolRunSentence` only capitalizes the FIRST fragment
/// of a sentence and lowercases the rest verbatim.
func toolGroupFragment(name: String, count: Int) -> String {
    switch name {
    case "bash":
        return count == 1 ? "ran a shell command" : "ran \(count) shell commands"
    case "task_create":
        return count == 1 ? "created a task" : "created \(count) tasks"
    case "task_update":
        return count == 1 ? "updated a task" : "updated \(count) tasks"
    case "task_list":
        return "checked tasks"
    case "read":
        return count == 1 ? "read a file" : "read \(count) files"
    case "write":
        return count == 1 ? "wrote a file" : "wrote \(count) files"
    case "edit":
        return count == 1 ? "made an edit" : "made \(count) edits"
    case "ls":
        return count == 1 ? "listed a directory" : "listed \(count) directories"
    case "glob":
        return count == 1 ? "searched" : "searched \(count) times"
    case "grep":
        return count == 1 ? "searched" : "searched \(count) times"
    case "ToolSearch":
        return count == 1 ? "loaded a tool" : "loaded \(count) tools"
    case "Skill":
        return count == 1 ? "loaded a skill" : "loaded \(count) skills"
    case "ask_user":
        return count == 1 ? "asked a question" : "asked \(count) questions"
    case "exit_plan_mode":
        return count == 1 ? "presented a plan" : "presented \(count) plans"
    case "request_directory":
        return count == 1 ? "requested a directory" : "requested \(count) directories"
    // mac-chat-parity Task 2 — research §2.3 enumerates exactly these thirteen names as the ones
    // that fell through to "used a tool", and §2.5 item 4 asks for them. Every name is a real
    // registered daemon tool (`name: "…"` across `packages/core/src/agent/tools/`). This EXTENDS
    // the Mac's own vocabulary; it is not iOS's `ToolPhrase` being ported (spec §7 forbids that —
    // iOS matches capitalized Claude-Code names the daemon never emits, so nearly every iOS tool
    // row reads "Used bash"). Chat mode's `Search`/`ReadPage`/`AskQuestion` share the phrasing of
    // their code-mode equivalents: the user is being told what happened, not which registration
    // it came from.
    case "browser":
        return count == 1 ? "used the browser" : "used the browser \(count) times"
    case "web_fetch", "ReadPage":
        return count == 1 ? "fetched a page" : "fetched \(count) pages"
    case "web_search", "Search":
        return count == 1 ? "searched the web" : "searched the web \(count) times"
    case "computer":
        return count == 1 ? "used the computer" : "used the computer \(count) times"
    case "lsp":
        return count == 1 ? "checked the code" : "checked the code \(count) times"
    case "notebook_edit":
        return count == 1 ? "made a notebook edit" : "made \(count) notebook edits"
    case "AskQuestion":
        return count == 1 ? "asked a question" : "asked \(count) questions"
    case "Workflow":
        return count == 1 ? "ran a workflow" : "ran \(count) workflows"
    case "spawn_agent":
        return count == 1 ? "started a subagent" : "started \(count) subagents"
    case "session_spawn":
        return count == 1 ? "dispatched a session" : "dispatched \(count) sessions"
    case "enter_worktree":
        return count == 1 ? "entered a worktree" : "entered \(count) worktrees"
    default:
        return count == 1 ? "used a tool" : "used \(count) tools"
    }
}

/// Capitalized single-fragment label — delegates to `toolGroupFragment`, capitalizing the first
/// letter. Kept for direct callers wanting one tool's label standalone; `toolRunSentence` also
/// collapses to exactly this output when a run has only one entry (r1 parity: a single-tool run
/// still reads as the plain "Ran 3 shell commands" it always did).
func toolGroupLabel(name: String, count: Int) -> String {
    capitalizingFirstLetter(toolGroupFragment(name: name, count: count))
}

private func capitalizingFirstLetter(_ s: String) -> String {
    guard let first = s.first else { return s }
    return first.uppercased() + s.dropFirst()
}

/// Builds the ONE comma-joined sentence for an unbroken tool run (LIVE-GATE G3 / r1b, CC parity:
/// "Read 4 files, listed 1 directory, ran 8 shell commands") — per-entry fragments in run order,
/// first fragment capitalized, every subsequent fragment lowercase. A single-entry run collapses
/// to exactly `toolGroupLabel`'s output.
func toolRunSentence(_ entries: [ToolRunEntry]) -> String {
    let fragments = entries.map { toolGroupFragment(name: $0.name, count: $0.count) }
    guard let first = fragments.first else { return "" }
    return ([capitalizingFirstLetter(first)] + fragments.dropFirst()).joined(separator: ", ")
}

// MARK: - Tool status, output preview, expansion (mac-chat-parity Task 2)

/// What one tool call — or a whole run of them — has to say about how it went.
enum ToolCallStatus: Equatable {
    case running
    case succeeded
    case failed
    /// No result ever arrived AND the turn is over. Separate from `.running` because it is
    /// PERMANENT, and separate from `.failed` because nothing reported an error — the call simply
    /// never came back. See `toolCallStatus` for why this case has to exist.
    case unfinished
}

/// The status of ONE call, from the two things the reducer stores plus whether its turn is still
/// going.
///
/// `output == nil` is NOT "still running", which is the whole reason `turnIsLive` is a parameter
/// rather than something derived here: the engine's tool loop has no abort branch that emits a
/// synthetic `tool_result`, so a call the user ESC'd never receives one and stays `nil` for as
/// long as the session exists. Reading "running" off `nil` alone would draw a replayed aborted
/// turn as perpetually running, forever (`ActivityItem.Kind.tool`'s own doc states the same
/// obligation from the reducer's side).
///
/// `isError` is checked first and does not require an output: the daemon always sends the two
/// together, so the ordering only matters against a second producer sending a partial shape.
func toolCallStatus(output: String?, isError: Bool, turnIsLive: Bool) -> ToolCallStatus {
    if isError { return .failed }
    if output != nil { return .succeeded }
    return turnIsLive ? .running : .unfinished
}

/// The ONE status the collapsed row's glyph shows for a whole run.
///
/// Precedence is iOS's (research §2.2 — "pulsing gear while any call is running; xmark if any
/// failed; checkmark otherwise"): a live call outranks an already-failed one because the run is not
/// finished saying what happened yet; the glyph flips to the failure the moment the turn ends. A
/// run with no calls at all cannot be produced by `groupActivity`, and reads as `.succeeded` —
/// nothing is outstanding.
func toolRunStatus(_ entries: [ToolRunEntry], turnIsLive: Bool) -> ToolCallStatus {
    let statuses = entries.flatMap(\.calls).map {
        toolCallStatus(output: $0.output, isError: $0.isError, turnIsLive: turnIsLive)
    }
    if statuses.contains(.running) { return .running }
    if statuses.contains(.failed) { return .failed }
    if statuses.contains(.unfinished) { return .unfinished }
    return .succeeded
}

/// SF Symbol for a status. Bare marks — no circles, no green, no red: iOS reached the same place
/// through a device gate (research §2.2), and on this side `docs/brand.md` forbids inventing
/// colours in chrome, so the glyph carries the meaning and the palette stays out of it. `ellipsis`
/// rather than a spinner or `.symbolEffect(.pulse, options: .repeating)` because this file's own
/// law (top of file) bans repeating animation in transcript content.
func toolStatusSymbol(_ status: ToolCallStatus) -> String {
    switch status {
    case .running: return "ellipsis"
    case .succeeded: return "checkmark"
    case .failed: return "xmark"
    case .unfinished: return "minus"
    }
}

/// What VoiceOver says for a status glyph — the mark itself is shape-only, so the outcome has to
/// reach the accessibility tree some other way (iOS carries it as an `accessibilityValue`).
func toolStatusAccessibilityLabel(_ status: ToolCallStatus) -> String {
    switch status {
    case .running: return "Running"
    case .succeeded: return "Completed"
    case .failed: return "Failed"
    case .unfinished: return "No result"
    }
}

/// Vertical bound on ONE call's output block: roughly a window's worth of 11pt monospaced text.
/// Chosen so an ordinary result — a test summary, a `git status`, a page of grep hits — survives
/// whole, while a call that prints thousands of lines costs a bounded amount of scrolling instead
/// of an unbounded amount. A guess at where "readable" ends, not a measurement; the live gate is
/// what settles it.
let maxRenderedOutputLines = 40

/// Horizontal/blob bound on ONE call's output block. The line bound cannot see a single enormous
/// line — minified JSON, a base64 dump, `jq -c` — which wraps into hundreds of drawn lines while
/// counting as one. This is the bound that catches those.
///
/// Neither of these is a memory bound: the string is already resident, capped by
/// `SessionReducer.maxToolOutputCharacters` when it was stored. They bound DRAWING, which is the
/// only thing a renderer can bound.
let maxRenderedOutputCharacters = 4_000

/// How many output blocks ONE expanded run may draw. The reducer keeps up to 200 activity items per
/// exchange, so a marathon turn's run can be that long; without this, one click could ask SwiftUI
/// for 200 monospaced blocks at once. Every call still gets its one-line entry — those are cheap and
/// they are the record of what ran — and the row states how many blocks it withheld.
let maxRenderedOutputBlocksPerRun = 25

/// Bound on the failure line the COLLAPSED row shows. One line of chrome, not a stack trace.
let maxFailureSummaryCharacters = 140

/// What one call's monospaced output block draws: the (bounded) text, plus a note naming exactly
/// what is not being shown. `text` is empty exactly when the tool produced an empty result.
struct ToolOutputPreview: Equatable {
    let text: String
    let elision: String?
}

/// Bounds one call's stored output for drawing, and surfaces what was left out.
///
/// `nil` in → `nil` out: no result was ever seen, so there is no block to draw and the status glyph
/// is what speaks. An EMPTY result is different — the tool ran and printed nothing — so it yields a
/// preview with empty text, which the row draws as "No output".
///
/// The reducer's own truncation marker is stored INSIDE the string, at the end (Task 1), so a
/// renderer-side clip would cut it off and the user would see neither the rest of the output nor
/// any hint that more of it existed. It is lifted out of the body into the note instead. The marker
/// is rebuilt from `SessionReducer.maxToolOutputCharacters`, so the two can never drift apart, and
/// a marker-shaped line the TOOL itself printed (a different number) is left alone as output.
///
/// Trailing whitespace is trimmed — nearly every tool ends its output with a newline and a blank
/// last line in the block is pure noise. Leading whitespace is kept: indentation is meaning.
func toolOutputPreview(_ output: String?,
                       maxLines: Int = maxRenderedOutputLines,
                       maxCharacters: Int = maxRenderedOutputCharacters) -> ToolOutputPreview? {
    guard let output else { return nil }

    let marker = "\n[… truncated at \(SessionReducer.maxToolOutputCharacters) characters]"
    let wasTruncatedWhenStored = output.hasSuffix(marker)
    var full = wasTruncatedWhenStored ? String(output.dropLast(marker.count)) : output
    while let last = full.last, last.isWhitespace { full.removeLast() }

    var shown = full.count > maxCharacters ? String(full.prefix(maxCharacters)) : full
    let lines = shown.split(separator: "\n", omittingEmptySubsequences: false)
    if lines.count > maxLines { shown = lines.prefix(maxLines).joined(separator: "\n") }

    // `shown` is always a prefix of `full` (a character clip, then the first N of its own lines),
    // so this difference is exactly what is being withheld.
    let withheld = full.count - shown.count
    var parts: [String] = []
    if withheld > 0 { parts.append("\(withheld) more characters") }
    if wasTruncatedWhenStored {
        parts.append("the result was truncated at \(SessionReducer.maxToolOutputCharacters) characters")
    }
    return ToolOutputPreview(text: shown, elision: parts.isEmpty ? nil : "… " + parts.joined(separator: "; "))
}

/// The one line a COLLAPSED run shows when something in it failed: the first non-blank line of the
/// first failed call's output, which is where every tool puts its error.
///
/// This exists because of the decision NOT to auto-expand failures (see `TranscriptToolGroupRow`).
/// A failure the user has to expand before they can read it would be a smaller version of the
/// complaint this whole task fixes; a failure with nothing to say (blank or absent output) draws
/// nothing at all rather than an empty line.
func toolRunFailureSummary(_ entries: [ToolRunEntry]) -> String? {
    guard let failed = entries.flatMap(\.calls).first(where: \.isError), let output = failed.output,
          let line = output.split(separator: "\n")
              .map({ $0.trimmingCharacters(in: .whitespaces) })
              .first(where: { !$0.isEmpty })
    else { return nil }
    return line.count > maxFailureSummaryCharacters
        ? String(line.prefix(maxFailureSummaryCharacters)) + "…"
        : line
}

/// The words an expanded call draws in place of an output block when it has none.
///
/// Only a RUNNING call has something worth saying — "Running…", iOS's own word (research §2.2) —
/// because it is the one state where the absence of output is temporary and the user is waiting on
/// it. Without this the expanded line for an in-flight call drew a bare tool name and nothing else,
/// which reads as "this tool did nothing" rather than "this tool has not finished". It is TEXT, not
/// an animated indicator: this file's law bans repeating animation because its content renders under
/// the orb morph's scale/blur/opacity bands (`FieldKit/WindowSurfaceView.swift` mounts
/// `WindowContentView` — and so the transcript — inside them), and that is still true.
///
/// `.unfinished` deliberately says nothing: on a replayed aborted turn every interrupted call would
/// repeat the same line, and its glyph — plus VoiceOver's "No result" — already carries it.
func toolCallOutputPlaceholder(_ status: ToolCallStatus) -> String? {
    status == .running ? "Running…" : nil
}

/// One call's row inside an expanded run. `output == nil` means no block is drawn — either nothing
/// came back, or the run's block budget was already spent.
struct ToolRunCallLine: Equatable {
    let name: String
    let detail: String?
    let status: ToolCallStatus
    let output: ToolOutputPreview?
}

/// Everything an expanded run draws: one line per call, plus a note when the block budget bit.
struct ToolRunExpansion: Equatable {
    let lines: [ToolRunCallLine]
    let note: String?
}

/// Flattens a run into the rows an expanded `TranscriptToolGroupRow` draws — in call order, across
/// entries, INCLUDING calls that carry neither a detail nor a result (those used to contribute
/// nothing at all, which is why five `browser` calls expanded to an empty area).
///
/// Calls with no result do not spend the block budget: an in-flight run would otherwise burn it on
/// blocks that draw nothing, leaving the finished calls' output withheld.
func toolRunExpansion(_ entries: [ToolRunEntry],
                      turnIsLive: Bool,
                      maxOutputBlocks: Int = maxRenderedOutputBlocksPerRun) -> ToolRunExpansion {
    var lines: [ToolRunCallLine] = []
    var blocksDrawn = 0
    var blocksWithheld = 0
    for entry in entries {
        for call in entry.calls {
            // The budget is tested BEFORE the preview is computed, not after: `toolOutputPreview`
            // returns non-nil exactly when `output != nil`, so this is the same decision made
            // without paying two O(n) `String.count` walks plus a `prefix`/`split` for a preview
            // that would then be discarded. That is the difference between the constant bounding
            // DRAWING and bounding the work as well, which is what its doc claims.
            var preview: ToolOutputPreview?
            if call.output != nil {
                if blocksDrawn < maxOutputBlocks {
                    preview = toolOutputPreview(call.output)
                    blocksDrawn += 1
                } else {
                    blocksWithheld += 1
                }
            }
            lines.append(ToolRunCallLine(
                name: entry.name,
                detail: call.detail,
                status: toolCallStatus(output: call.output, isError: call.isError, turnIsLive: turnIsLive),
                output: preview
            ))
        }
    }
    let note = blocksWithheld == 0
        ? nil
        : "… output for \(blocksWithheld) more call\(blocksWithheld == 1 ? "" : "s") is not shown"
    return ToolRunExpansion(lines: lines, note: note)
}

/// A grouped, UNBROKEN run of tool calls — ONE comma-joined sentence (`toolRunSentence`) at the
/// same 11pt `.tertiary` style as `TranscriptActivityRow`, preceded by a single `chevron.right`
/// that rotates 90° when expanded and by the run's status glyph. Expanded, it lists EVERY call in
/// order — tool name + detail, its own status mark, and its output in a monospaced block.
/// Expansion is driven entirely by the parent (per-exchange local `@State`, keyed by run index —
/// see `TranscriptView`'s exchange row); this view is stateless itself.
///
/// **Grouping is kept, and expands into per-call entries** (mac-chat-parity Task 2 — the decision
/// the brief called the highest-judgment one). Now that a call carries its own result, the
/// alternative was one transcript row per call. Three reasons it stays grouped: (1) the collapsed
/// row is the *scannable* layer — a turn with forty calls would otherwise be forty rows of chrome
/// between two sentences of prose, which is worse reading than what exists today, not better;
/// (2) this is what iOS does (research §2.2: consecutive same-name calls fold into one row that
/// expands to every call's output), and iOS is the reference the user pointed at; (3) the Mac's
/// vocabulary is *built* on counts — `toolGroupFragment(name:count:)` says "Read 4 files" — and
/// spec §7 explicitly protects that vocabulary, so dropping grouping would discard the one part of
/// this surface the research judged better than iOS's.
///
/// **Collapsed is the default, including for a run that failed**, and the failure is legible
/// anyway: the status glyph is `xmark` whenever any call failed, and the collapsed row carries the
/// first line of that failure (`toolRunFailureSummary`) directly beneath the sentence. Defaulting a
/// failed run to *open* was the obvious alternative and was rejected on one ground that carries it
/// alone: a non-zero exit is routine in agent work (a test run, a `git diff --exit-code`), so
/// auto-expanding every one turns an ordinary debugging session's scrollback into a wall of stderr.
/// (A second argument — that this row's expansion `@State` resets on `LazyVStack` recycle, so a
/// content-derived default would keep re-opening — is true of the CURRENT structure only: hoisting
/// that state to `TranscriptView` would survive recycling. Do not read it as a reason the decision
/// itself is right.)
struct TranscriptToolGroupRow: View {
    let entries: [ToolRunEntry]
    /// Whether this run's turn is STILL RUNNING. Only a live turn may draw a running glyph:
    /// `output == nil` alone is "no result was ever seen", which is permanent for an ESC'd call —
    /// see `toolCallStatus`. `TranscriptView` passes `true` only for the last exchange while
    /// `turnRunning`. Within such an exchange an earlier, already-closed run could in principle
    /// hold a resultless call (its result evicted by the reducer's 200-item cap); that call reads
    /// as running, which is the honest reading of "no result seen and the turn is still going".
    let turnIsLive: Bool
    let isExpanded: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: toggle) {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 10)
                    statusGlyph(toolRunStatus(entries, turnIsLive: turnIsLive))
                    Text(toolRunSentence(entries))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    // The whole width is the hit target — the chevron alone is a 10pt mouse target,
                    // and the affordance has to be usable, not just visible.
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)

            // Only while collapsed: expanded, the failing call's whole output is already on screen.
            // `.primary` against the row's `Theme.textMuted` is the emphasis — the line carries no
            // hue, for the same reason the glyphs don't (see `toolStatusSymbol`), and `brand.md`
            // still has no light-tuned danger tone to reach for (§ 3.4). Task 8 revisited this: it
            // read `.secondary`, which measured #7D7D7C against textMuted's #7A7974 — the same grey,
            // so the "emphasis" the old comment claimed was not being drawn at all.
            if !isExpanded, let summary = toolRunFailureSummary(entries) {
                Text(summary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.leading, 32)
            }

            if isExpanded { expandedCalls }
        }
        .animation(.easeOut(duration: 0.15), value: isExpanded)
    }

    /// Every call in the run, in order — including the ones with no detail and no result, which
    /// contributed no line at all before Task 2 (five `browser` calls expanded to an empty area).
    @ViewBuilder private var expandedCalls: some View {
        let expansion = toolRunExpansion(entries, turnIsLive: turnIsLive)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(expansion.lines.enumerated()), id: \.offset) { _, line in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        statusGlyph(line.status)
                        Text(line.detail.map { "\(line.name) \($0)" } ?? line.name)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textMuted)

                    if let output = line.output {
                        outputBlock(output)
                    } else if let placeholder = toolCallOutputPlaceholder(line.status) {
                        placeholderBlock(placeholder)
                    }
                }
            }
            if let note = expansion.note {
                Text(note)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.leading, 16)
    }

    private func statusGlyph(_ status: ToolCallStatus) -> some View {
        Image(systemName: toolStatusSymbol(status))
            .font(.system(size: 9, weight: .semibold))
            // Fixed slot so the sentence does not shift sideways when the glyph flips on completion.
            .frame(width: 10)
            .accessibilityLabel(toolStatusAccessibilityLabel(status))
    }

    /// The tool's actual output — the thing this whole task exists to put on screen. Wrapped rather
    /// than horizontally scrolled (iOS scrolls; a nested scroll view inside the transcript's own
    /// scroll view steals the wheel on macOS) and selectable, so what is shown can be copied.
    ///
    /// Styling is brand tokens as of Task 8, on a radius-8 block (the Mac's own ladder; research §4
    /// asks for 8–10 for tool-output blocks): `Theme.elevatedSurface` for the fill — the token
    /// `docs/brand.md` names for exactly this — and the payload **promoted to `.primary`**.
    ///
    /// That promotion is not a whim. The block used to run `.secondary` payload against `.tertiary`
    /// chrome; with the chrome now on `Theme.textMuted` (#7A7974 light), `.secondary` (#7D7D7C) is
    /// the same grey, so the two-level hierarchy inside the block would have collapsed to one. The
    /// payload takes the other register because it IS the content — the thing this whole task was
    /// asked to put on screen.
    private func outputBlock(_ preview: ToolOutputPreview) -> some View {
        blockChrome {
            Text(preview.text.isEmpty ? "No output" : preview.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(preview.text.isEmpty
                                 ? AnyShapeStyle(Theme.textMuted) : AnyShapeStyle(.primary))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let elision = preview.elision {
                Text(elision)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    /// The same block, holding words instead of output — "Running…" for a call that has not come
    /// back yet (`toolCallOutputPlaceholder`). Deliberately the same chrome as "No output": both
    /// say "there is nothing to read here yet", and giving them different shapes would imply a
    /// difference the user has to decode.
    private func placeholderBlock(_ text: String) -> some View {
        blockChrome {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func blockChrome<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) { content() }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Theme.elevatedSurface))
            .padding(.leading, 16)
    }
}
