import SwiftUI
import NormaProtocol

/// Cards for outstanding approvals/questions/plans (2d-iii task 2) — PURE UI: consumes
/// `[PendingInteraction]` (task 1's typed reducer list) and injected response closures. NOTHING
/// mounts `PendingCardsView` yet — task 3 decides which surfaces show it and how it transitions
/// in/out (hence no `repeatForever`/looping animation anywhere below, and no scoped
/// `.transition`/`.animation` on the band itself — task 3's concern). Colors are ADAPTIVE
/// (`.primary`/`.secondary`/`.tertiary`) since the window is opaque, same convention as
/// `TranscriptMessageViews.swift` — no forced white, no `GlassForegroundLegibility`.

/// The pinned band. `respond` callbacks are injected (Task 3 wires them per-surface).
struct PendingCardsView: View {
    let interactions: [PendingInteraction]
    let inFlight: Set<String>                       // callIds with an RPC awaiting
    let errorLines: [String: String]                // callId → inline error text
    let onApproval: (String, Bool, String?, String?) -> Void  // callId, approved, optionId, childSessionId
    let onQuestion: (String, [String: String], [String: String], String?) -> Void  // callId, answers, notes (both keyed by question text), childSessionId
    let onPlan: (String, Bool, Bool, String?) -> Void   // callId, approved, autoAccept, feedback

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(interactions, id: \.callId) { interaction in
                PendingCard(
                    interaction: interaction,
                    isInFlight: inFlight.contains(interaction.callId),
                    errorLine: errorLines[interaction.callId],
                    onApproval: onApproval,
                    onQuestion: onQuestion,
                    onPlan: onPlan
                )
            }
        }
    }
}

// MARK: - Pure helpers (unit-tested — PendingCardsTests)

/// Maps the card's local per-question UI state to the answers dict `onQuestion` sends — keyed by
/// each question's own `question` text (not `header`, since two questions in the same ask can
/// share a header but never share question text). `selections`/`otherTexts` are keyed by the
/// question's index into `questions`. A question with no answer (empty selection AND empty/no
/// Other text) is simply omitted from the result — matches the CLI's own
/// `packages/cli/src/questions.ts` convention: multiSelect selections join their labels with
/// ", ", in option order; a non-empty Other text always wins over any selection for that
/// question (the user typed something more specific than the menu offered).
func questionAnswers(
    for questions: [SessionEvent.Question],
    selections: [Int: Set<Int>],
    otherTexts: [Int: String]
) -> [String: String] {
    var answers: [String: String] = [:]
    for (index, question) in questions.enumerated() {
        if let other = otherTexts[index]?.trimmingCharacters(in: .whitespacesAndNewlines), !other.isEmpty {
            answers[question.question] = other
            continue
        }
        guard let selected = selections[index], !selected.isEmpty else { continue }
        let labels = selected.sorted().compactMap { question.options.indices.contains($0) ? question.options[$0].label : nil }
        guard !labels.isEmpty else { continue }
        answers[question.question] = labels.joined(separator: ", ")
    }
    return answers
}

/// Whether a question card's local state answers EVERY question — the gate for enabling the
/// whole-card Submit button. Mirrors `questionAnswers`'s own definition of "answered" (a non-empty
/// Other text, or a non-empty selection) rather than re-deriving it independently, so the gate and
/// the payload never disagree about what counts as answered.
func questionCardComplete(
    questions: [SessionEvent.Question],
    selections: [Int: Set<Int>],
    otherTexts: [Int: String]
) -> Bool {
    questionAnswers(for: questions, selections: selections, otherTexts: otherTexts).count == questions.count
}

/// Maps the card's local per-question notes state (`notes[index]` — one free-text
/// `TextField("Add a note (optional)", ...)` per question, see `QuestionBlock`) to the notes dict
/// `onQuestion` sends — keyed the SAME way `questionAnswers` keys `answers` (by each question's own
/// `question` text, per `NormaProtocol.SessionEvent.QuestionResolved.notes`/
/// `packages/protocol/src/methods.ts`'s `AskUserRespondParams.notes`). Notes are OPTIONAL and never
/// gate `questionCardComplete` — a question with no note (or a whitespace-only one) is simply
/// omitted, matching `packages/core/src/agent/questions.ts`'s "omitted entirely when no notes were
/// given" convention (so a fully-omitted dict, not a dict of empty strings, rides an all-notes-blank
/// submit).
func questionNotes(
    for questions: [SessionEvent.Question],
    notes: [Int: String]
) -> [String: String] {
    var result: [String: String] = [:]
    for (index, question) in questions.enumerated() {
        guard let note = notes[index]?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { continue }
        result[question.question] = note
    }
    return result
}

/// CC AskUserQuestion parity: whether a question's side-by-side preview layout should render at
/// all — single-select only (a multiSelect question's "one focused option" concept doesn't exist,
/// since any number of options can be on at once) AND at least one option actually carries a
/// preview (an all-nil-preview question keeps the plain stacked list, same as before this
/// feature).
func questionShowsPreviewPane(_ question: SessionEvent.Question) -> Bool {
    !question.multiSelect && question.options.contains { $0.preview != nil }
}

/// The side-by-side layout's right-pane content for one question: the currently-selected option's
/// preview, or (nothing selected yet) the FIRST option's — so the pane is never blank before a
/// pick (brief: "the selected option's preview, or the first option's if none selected yet").
/// `nil` whenever `questionShowsPreviewPane` would be `false` for this question (a multiSelect
/// question, or one with no previews at all) — callers that already gate on that helper never hit
/// this fallback, but a caller that doesn't still gets the CC-parity "ignore previews" behavior for
/// multiSelect for free.
func questionFocusedPreview(_ question: SessionEvent.Question, selected: Set<Int>) -> String? {
    guard questionShowsPreviewPane(question) else { return nil }
    if let selectedIndex = selected.first, question.options.indices.contains(selectedIndex) {
        return question.options[selectedIndex].preview
    }
    return question.options.first?.preview
}

/// Per-kind card header text. Approval names the tool; a question card titles itself after its
/// FIRST question's `header` (a batch ask's later questions render their own `question` text
/// inline in the body — see `PendingQuestionBody`); a plan card's title is fixed (the plan text
/// itself, not a header field, is the body).
func cardTitle(_ interaction: PendingInteraction) -> String {
    switch interaction {
    case .approval(_, let toolName, _, _, _, _):
        return "Approval needed — \(toolName)"
    case .question(_, let questions, _):
        return questions.first?.header ?? ""
    case .plan:
        return "Plan for approval"
    }
}

/// Phase 5e T5: reviewer text is model-summarized input riding a NEW client-facing surface —
/// already newline-stripped + capped at 300 on the wire (engine.ts's `sanitizeReviewText`), but
/// treated as tainted for LAYOUT here too: a defensive second newline-strip plus a much tighter
/// single-line cap than the wire limit (a payload cap, not a card-width one). Mirrors the CLI's
/// `pending-cards.tsx` `capReviewerReason` (same 100-char threshold, trailing "…" on truncation)
/// so the two clients read the same rationale at roughly the same length.
private let reviewerReasonMaxChars = 100

func capReviewerReason(_ reason: String) -> String {
    let oneLine = reason.replacingOccurrences(of: "\r\n", with: " ").replacingOccurrences(of: "\n", with: " ")
    guard oneLine.count > reviewerReasonMaxChars else { return oneLine }
    return String(oneLine.prefix(reviewerReasonMaxChars)) + "…"
}

/// The kind glyph shown in every card's header — ⚠ approval, ? question, ☰ plan.
private func cardGlyph(_ interaction: PendingInteraction) -> String {
    switch interaction {
    case .approval: return "⚠"
    case .question: return "?"
    case .plan: return "☰"
    }
}

// MARK: - Card chrome

/// One card: kind glyph + title header, per-kind body, optional inline error line — rounded-12
/// `.thinMaterial` section, consistent with the transcript's own material chrome
/// (`TranscriptView`'s "latest" pill, `TranscriptCodeBlock`).
private struct PendingCard: View {
    let interaction: PendingInteraction
    let isInFlight: Bool
    let errorLine: String?
    let onApproval: (String, Bool, String?, String?) -> Void
    let onQuestion: (String, [String: String], [String: String], String?) -> Void
    let onPlan: (String, Bool, Bool, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(cardGlyph(interaction))
                    .foregroundStyle(.secondary)
                Text(cardTitle(interaction))
                    .foregroundStyle(.primary)
            }
            .font(.system(size: 13, weight: .semibold))

            cardBody

            if let errorLine {
                Text(errorLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var cardBody: some View {
        switch interaction {
        case .approval(let callId, _, let summary, let reviewerReason, let childSessionId, let options):
            PendingApprovalBody(callId: callId, summary: summary, reviewerReason: reviewerReason, childSessionId: childSessionId, options: options, isInFlight: isInFlight, onApproval: onApproval)
        case .question(let callId, let questions, let childSessionId):
            PendingQuestionBody(callId: callId, questions: questions, childSessionId: childSessionId, isInFlight: isInFlight, onQuestion: onQuestion)
        case .plan(let callId, let plan):
            PendingPlanBody(callId: callId, plan: plan, isInFlight: isInFlight, onPlan: onPlan)
        }
    }
}

// MARK: - Approval card

/// Approval summary — monospaced 12pt, capped at 3 lines with an "expand" toggle when the text is
/// long enough to plausibly overflow that cap (SwiftUI gives no measured-line-count API short of
/// a `GeometryReader` round-trip, which is overkill here — a character-count heuristic is a fine
/// approximation: a false positive just shows a toggle whose "Show more" reveals nothing new).
private struct PendingApprovalBody: View {
    let callId: String
    let summary: String
    /// Phase 5e T5: additive/optional — set only when this escalation came from the safety
    /// reviewer (`PendingInteraction.approval`'s 4th associated value).
    let reviewerReason: String?
    /// Dispatch relay (Phase 7): additive/optional — set only on the mirrored copy of a child
    /// session's approval (`PendingInteraction.approval`'s 5th associated value); threaded straight
    /// into `onApproval` so the respond routes to the child, not this card's own dispatch session.
    let childSessionId: String?
    /// SP-approvals T6: additive/optional — `PendingInteraction.approval`'s 6th associated value,
    /// mirroring `SessionEvent.ApprovalRequested.options` (Task 5's `approvalOptionsFor`). Only the
    /// RULE-BEARING entries feed `ruleOptions` below — a plain allow-once/deny entry is already
    /// covered by the Approve/Deny buttons and would just duplicate them. `nil`, or an array with no
    /// rule-bearing entries, renders this card byte-identical to before this task.
    let options: [SessionEvent.ApprovalOption]?
    let isInFlight: Bool
    let onApproval: (String, Bool, String?, String?) -> Void  // callId, approved, optionId, childSessionId

    @State private var isExpanded = false

    private var mightOverflowThreeLines: Bool {
        summary.count > 150 || summary.filter { $0 == "\n" }.count >= 3
    }

    /// `ApprovalOption.rule`/`scope` are present TOGETHER only on an option that persists a
    /// permission rule when chosen (see that struct's own doc in NormaProtocol) — a plain
    /// allow-once/deny option (`rule == nil`) is filtered out here since Approve/Deny already
    /// cover it.
    private var ruleOptions: [SessionEvent.ApprovalOption] {
        (options ?? []).filter { $0.rule != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(isExpanded ? nil : 3)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if mightOverflowThreeLines {
                Button(isExpanded ? "Show less" : "Show more") {
                    isExpanded.toggle()
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            }

            // Phase 5e T5: one distinct dim line ABOVE the approve/deny row, present only when
            // this escalation came from the safety reviewer — absent `reviewerReason` renders
            // nothing extra (byte-identical to the pre-5e-T5 body).
            if let reviewerReason {
                Text("⚠ reviewer: \(capReviewerReason(reviewerReason))")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            // Primary row — UNCHANGED from before this task: Approve is still plain allow-once
            // (spec §5: "default button = Allow once"), Deny still bare deny; neither carries an
            // optionId. Rule-writing choices are deliberate clicks on the quiet row below, never
            // folded into these two.
            HStack(spacing: 8) {
                Button("Approve") { onApproval(callId, true, nil, childSessionId) }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { onApproval(callId, false, nil, childSessionId) }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isInFlight)

            // SP-approvals T6: one quiet button per rule-bearing option, below the primary row —
            // `.plain` + secondary/small text, same "quiet" convention as the "Show more" toggle
            // above, so a rule-writing choice never reads as visually equal to Approve/Deny. Labels
            // render verbatim (the daemon already composes the exact rule string into them).
            if !ruleOptions.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ruleOptions, id: \.id) { option in
                        Button(option.label) { onApproval(callId, true, option.id, childSessionId) }
                            .buttonStyle(.plain)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(isInFlight)
            }
        }
    }
}

// MARK: - Question card

/// One ask can carry 1-4 questions (`packages/core/src/agent/tools/ask-user.ts`). The daemon's
/// `QuestionBroker.respond` is FIRST-RESPONSE-WINS: the first `onQuestion` RPC resolves the
/// ENTIRE `ask_user` call, and the reducer removes the whole card. So per-question affordances
/// (an option button, a multiSelect toggle, the Other text field) must NOT call `onQuestion` —
/// they only RECORD local selection/Other-text state. There is exactly one submit path: the
/// whole-card Submit button below, disabled until `questionCardComplete` says every question has
/// an answer, which calls `onQuestion` once with the full, current `questionAnswers` dict.
/// Single-question cards go through the same gate — no divergent single-vs-multi submit path.
private struct PendingQuestionBody: View {
    let callId: String
    let questions: [SessionEvent.Question]
    /// Dispatch relay (Phase 7): see `PendingApprovalBody.childSessionId`'s doc — same meaning,
    /// threaded into `onQuestion` on submit.
    let childSessionId: String?
    let isInFlight: Bool
    let onQuestion: (String, [String: String], [String: String], String?) -> Void

    @State private var selections: [Int: Set<Int>] = [:]
    @State private var otherTexts: [Int: String] = [:]
    @State private var otherExpanded: Set<Int> = []
    /// CC AskUserQuestion parity: per-question free-text note, index-keyed like `selections`/
    /// `otherTexts` above — independent of both (a note rides ALONGSIDE whatever answer the
    /// question already has; it never substitutes for one, so it plays no part in
    /// `questionCardComplete`'s gate).
    @State private var notes: [Int: String] = [:]

    private var isComplete: Bool {
        questionCardComplete(questions: questions, selections: selections, otherTexts: otherTexts)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                QuestionBlock(
                    index: index,
                    question: question,
                    showsHeader: questions.count > 1,
                    selected: selections[index] ?? [],
                    otherText: otherTexts[index] ?? "",
                    isOtherExpanded: otherExpanded.contains(index),
                    noteText: notes[index] ?? "",
                    isInFlight: isInFlight,
                    onSelectSingle: { optionIndex in
                        selections[index] = [optionIndex]
                        otherTexts[index] = ""
                    },
                    onToggleMulti: { optionIndex in
                        var current = selections[index] ?? []
                        if current.contains(optionIndex) { current.remove(optionIndex) } else { current.insert(optionIndex) }
                        selections[index] = current
                        otherTexts[index] = ""
                    },
                    onExpandOther: { otherExpanded.insert(index) },
                    onOtherTextChange: { text in
                        otherTexts[index] = text
                        selections[index] = []
                    },
                    onNoteTextChange: { text in notes[index] = text }
                )
            }

            Button("Submit", action: submit)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isInFlight || !isComplete)
        }
    }

    private func submit() {
        onQuestion(
            callId,
            questionAnswers(for: questions, selections: selections, otherTexts: otherTexts),
            questionNotes(for: questions, notes: notes),
            childSessionId
        )
    }
}

/// One question's options + Other row + optional note field. Selecting a listed option (single or
/// multi) clears that question's Other text, and typing into Other clears that question's
/// selection — the two affordances are mutually exclusive per question so a stale Other string can
/// never silently outrank (or be outranked by) a fresh selection in `questionAnswers`. No
/// affordance here submits the card — see `PendingQuestionBody`'s single whole-card Submit button.
private struct QuestionBlock: View {
    let index: Int
    let question: SessionEvent.Question
    let showsHeader: Bool
    let selected: Set<Int>
    let otherText: String
    let isOtherExpanded: Bool
    let noteText: String
    let isInFlight: Bool
    let onSelectSingle: (Int) -> Void
    let onToggleMulti: (Int) -> Void
    let onExpandOther: () -> Void
    let onOtherTextChange: (String) -> Void
    let onNoteTextChange: (String) -> Void

    /// Thin view-local reads onto the pure, unit-tested helpers above (`PendingCardsTests`) — kept
    /// here only so the `body` below doesn't have to spell out `question`/`selected` at every call
    /// site.
    private var showsPreviewPane: Bool { questionShowsPreviewPane(question) }
    private var focusedPreview: String? { questionFocusedPreview(question, selected: selected) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsHeader {
                Text(question.header ?? "")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            Text(question.question)
                .font(.system(size: 13))
                .foregroundStyle(.primary)

            if showsPreviewPane {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        optionsList
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    previewPane
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                optionsList
            }

            otherRow
            noteRow
        }
    }

    @ViewBuilder
    private var optionsList: some View {
        ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
            optionRow(optionIndex, option)
        }
    }

    @ViewBuilder
    private var previewPane: some View {
        if let text = focusedPreview {
            ScrollView {
                Text(text)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
            }
            .frame(maxHeight: 180)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    @ViewBuilder
    private func optionRow(_ optionIndex: Int, _ option: SessionEvent.QuestionOption) -> some View {
        if question.multiSelect {
            Button {
                onToggleMulti(optionIndex)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: selected.contains(optionIndex) ? "checkmark.square.fill" : "square")
                        .foregroundStyle(selected.contains(optionIndex) ? Color.accentColor : .secondary)
                    optionLabel(option)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isInFlight)
        } else {
            Button {
                onSelectSingle(optionIndex)
            } label: {
                optionLabel(option)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isInFlight)
        }
    }

    private func optionLabel(_ option: SessionEvent.QuestionOption) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(option.label)
                .font(.system(size: 13))
                .foregroundStyle(.primary)
            if let description = option.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var otherRow: some View {
        if isOtherExpanded {
            TextField("Other…", text: Binding(get: { otherText }, set: onOtherTextChange))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
                .disabled(isInFlight)
        } else {
            Button("Other…", action: onExpandOther)
                .buttonStyle(.plain)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .disabled(isInFlight)
        }
    }

    /// CC AskUserQuestion parity: a per-question free-text note — always visible (unlike Other,
    /// which is a discoverable toggle), never gates Submit, and rides into `questionNotes`'s dict
    /// only when non-empty (see that helper's doc). Always below the options/Other row, for both
    /// the plain-list and side-by-side-preview layouts.
    private var noteRow: some View {
        // No `.foregroundStyle` override, matching `otherRow`'s TextField above — SwiftUI's
        // `TextField` prompt (the "Add a note (optional)" placeholder) already renders dimmed on
        // its own; overriding the whole field to `.secondary` would ALSO dim actually-typed text,
        // which is a `.primary`-weight answer, not a hint.
        TextField("Add a note (optional)", text: Binding(get: { noteText }, set: onNoteTextChange))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12))
            .disabled(isInFlight)
    }
}

// MARK: - Plan card

/// Plan body reuses the ii-a markdown block-rendering path via `TranscriptAssistantMessage`
/// (`ChatContent/TranscriptMessageViews.swift`) rather than duplicating it — `isStreaming: true`
/// suppresses that view's trailing per-message copy affordance (not part of this card's spec),
/// capped at ~260pt in a `ScrollView` since a plan can run long.
private struct PendingPlanBody: View {
    let callId: String
    let plan: String
    let isInFlight: Bool
    let onPlan: (String, Bool, Bool, String?) -> Void

    @State private var isRequestingChanges = false
    @State private var feedback = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                TranscriptAssistantMessage(text: plan, isStreaming: true)
            }
            .frame(maxHeight: 260)

            HStack(spacing: 8) {
                Button("Approve") { onPlan(callId, true, false, nil) }
                    .buttonStyle(.borderedProminent)
                Button("Approve + auto-accept") { onPlan(callId, true, true, nil) }
                    .buttonStyle(.bordered)
                Button("Request changes") { isRequestingChanges = true }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isInFlight)

            if isRequestingChanges {
                HStack(spacing: 8) {
                    TextField("What should change?", text: $feedback)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                    Button("Send") {
                        onPlan(callId, false, false, feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : feedback)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isInFlight)
                }
            }
        }
    }
}
