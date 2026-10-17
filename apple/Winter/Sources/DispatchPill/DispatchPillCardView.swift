import SwiftUI
import WinterCUPresentation
import WinterProtocol

// The card the Dispatch pill morphs into (`DispatchPillCards.swift` decides which), drawn in the pill's OWN language —
// the family of the island's cards (`docs/claude/island.md`), not the transcript's: the pill's black shell (the
// shell is `DispatchPillShell`'s, so the rim, shadow, morph blur and 3 % hover grow are the pill's own), the pill's
// typed-text face for every line the user reads (`Typography.composerField()`), quiet caption meta, compact
// capsule rows for options, and the white ✕ / blue ✓ circles with the pills' hover glow.
//
// Every answer goes through the transcript's card wiring (`dispatchPillCardWiring`), so it is the same respond, the
// same in-flight and error state and the same per-card draft as the transcript's card — answering here, in the
// transcript, on the island or on the phone are one answer (first wins).
//
// No repeating animation and no timer: the countdowns are `TimelineView(.explicit(...))` schedules that end at their
// deadline.

/// One pending ask, as the pill's card.
struct DispatchPillCardView: View {
    let record: InteractionRecord
    let wiring: InteractionCardWiring
    /// Who is asking (`dispatchPillCardHeader`).
    let header: String
    /// How many asks wait behind this one.
    let waiting: Int

    private var isInFlight: Bool { wiring.inFlight.contains(record.callId) }
    private var errorLine: String? { wiring.errorLines[record.callId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch record.ask {
            case .approval(let toolName, let summary, let reviewerReason, let options, let defaultAllowAt):
                DispatchPillCardHeader(symbol: "hand.raised.fill", line: header,
                                       trailing: dispatchPillCardTrailing(questionIndex: 0, questionCount: 1, waiting: waiting))
                DispatchPillApprovalBody(record: record, toolName: toolName, summary: summary,
                                         reviewerReason: reviewerReason, options: options, defaultAllowAt: defaultAllowAt,
                                         isInFlight: isInFlight, errorLine: errorLine, wiring: wiring)
            case .question(let questions):
                DispatchPillQuestionBody(record: record, questions: questions, header: header, waiting: waiting,
                                         isInFlight: isInFlight, errorLine: errorLine, wiring: wiring)
            case .plan(let plan):
                DispatchPillCardHeader(symbol: "list.bullet.rectangle", line: header,
                                       trailing: dispatchPillCardTrailing(questionIndex: 0, questionCount: 1, waiting: waiting))
                DispatchPillPlanBody(record: record, plan: plan, isInFlight: isInFlight, errorLine: errorLine, wiring: wiring)
            case .urlElicitation(let serverName, let message, let host, let origin, let expiresAt):
                DispatchPillCardHeader(symbol: "link", line: header,
                                       trailing: dispatchPillCardTrailing(questionIndex: 0, questionCount: 1, waiting: waiting))
                DispatchPillElicitationBody(record: record, serverName: serverName, message: message, host: host,
                                            origin: origin, expiresAt: expiresAt, isInFlight: isInFlight,
                                            errorLine: errorLine, wiring: wiring)
            }
        }
        .padding(.horizontal, DispatchPillMetrics.cardHorizontalPadding)
        .padding(.vertical, DispatchPillMetrics.cardVerticalPadding)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

// MARK: - Pieces every card shares

/// The card's top line: the amber kind glyph, who is asking, and on the right which question / how many wait.
struct DispatchPillCardHeader: View {
    let symbol: String
    let line: String
    var trailing: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(Typography.caption(.semibold))
                .foregroundStyle(pillReviewAmber)
            Text(line)
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if let trailing {
                Text(trailing)
                    .font(Typography.captionDigits(.medium))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

/// The pill's answer circle: white ✕ (no / back), blue ✓ (yes / send / next), or a quiet grey one (a toggle) —
/// glowing softly in its own colour under the pointer, shrinking a touch when pressed. The island's circle, drawn
/// here so the two surfaces stay one family without one importing the other's views.
struct DispatchPillCircleButton: View {
    enum Role { case refuse, accept, quiet }

    let role: Role
    var symbol: String?
    var enabled = true
    let label: String
    let action: () -> Void

    static let blue = IslandCircleButtonStyle.blue
    static let size = IslandCircleButtonStyle.size

    private var fill: Color {
        switch role {
        case .accept: return Self.blue
        case .refuse: return Color.white
        case .quiet: return Color.white.opacity(0.12)
        }
    }

    private var glyph: Color { role == .refuse ? Color.black : Color.white }
    private var glow: Color { role == .accept ? Self.blue : Color.white }

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol ?? (role == .accept ? "checkmark" : "xmark"))
                .font(Typography.label(.bold))
                .foregroundStyle(glyph)
                .frame(width: Self.size, height: Self.size)
                .background(Circle().fill(fill))
                .contentShape(Circle())
                .pillHoverGlow(glow)
        }
        .buttonStyle(DispatchPillPressStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .help(label)
        .accessibilityLabel(label)
    }
}

/// A press shrinks a little and dims — the island's and the desktop-switch pill's press.
struct DispatchPillPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// The left end of a card's answer row: what went wrong, "Sending…", or a quiet hint — one line, never more.
private struct DispatchPillCardStatus: View {
    let isInFlight: Bool
    let errorLine: String?
    var hint: String?

    var body: some View {
        if isInFlight {
            Text("Sending…")
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textMuted)
        } else if let errorLine {
            Text(errorLine)
                .font(Typography.caption(.medium))
                .foregroundStyle(pillReviewAmber)
                .lineLimit(1)
        } else if let hint {
            Text(hint)
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
        }
    }
}

/// One compact row: an option to choose, or a quiet extra choice (an approval's "allow always"). A capsule at one
/// line; a rounded rect, with the pill's own corner, once a description makes it taller. Chosen = white with black
/// type — the island's row.
private struct DispatchPillChoiceRow: View {
    let label: String
    var detail: String?
    var selected = false
    /// A multiple-choice option shows a box (ticked when chosen), so the row says "pick any".
    var multiSelect = false
    var enabled = true
    let action: () -> Void

    static let height: CGFloat = 34

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.height / 2, style: .continuous)
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(Typography.composerField())
                        .foregroundStyle(selected ? Color.black : Color.white)
                        .lineLimit(2)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(Typography.caption())
                            .foregroundStyle(selected ? Color.black.opacity(0.6) : Theme.textMuted)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if multiSelect {
                    Image(systemName: selected ? "checkmark.square.fill" : "square")
                        .font(Typography.label(.semibold))
                        .foregroundStyle(selected ? Color.black : Color.white.opacity(0.5))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .frame(minHeight: Self.height)
            .background(shape.fill(selected ? Color.white : Color.white.opacity(0.1)))
            .contentShape(shape)
        }
        .buttonStyle(DispatchPillPressStyle())
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// A one-line text field in the card's capsule: an option's "Other…", a note, a plan's requested changes. Clicking it
/// gives the pill the keyboard (the panel engages on the click, `DispatchPillController.handleRestingMouseDown`);
/// Return does what the card's blue circle does.
private struct DispatchPillCardField: View {
    let placeholder: String
    @Binding var text: String
    var enabled = true
    let onSubmit: () -> Void

    var body: some View {
        let filled = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Typography.composerField())
            .foregroundStyle(Color.white)
            .disabled(!enabled)
            .onSubmit(onSubmit)
            .padding(.horizontal, 14)
            .frame(height: DispatchPillChoiceRow.height)
            // Filled = a shade brighter, never a stroke: a 1 pt stroke on a capsule end rasterises as a stray tick.
            .background(Capsule(style: .continuous).fill(Color.white.opacity(filled ? 0.16 : 0.08)))
    }
}

// MARK: - Approval

/// What the tool wants to do, in the pill's type; the safety reviewer's reason in amber when it escalated; a
/// default-allow card's countdown; each extra option the daemon offered (allow always, add the folder…) as a quiet
/// row; then ✕ deny and ✓ allow once. ✓ and ✕ send exactly what the transcript's Approve and Deny send (a plain
/// approve / deny, no option id); a row sends its option's id.
private struct DispatchPillApprovalBody: View {
    let record: InteractionRecord
    let toolName: String
    let summary: String
    let reviewerReason: String?
    let options: [SessionEvent.ApprovalOption]?
    let defaultAllowAt: Int?
    let isInFlight: Bool
    let errorLine: String?
    let wiring: InteractionCardWiring

    private var mightOverflow: Bool { summary.count > 160 || summary.filter { $0 == "\n" }.count >= 4 }

    var body: some View {
        let draft = wiring.draftBinding(record.callId)
        let primary = approvalPrimaryChoice(options)
        let extras = approvalAdditionalOptions(options)
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(summary)
                    .font(Typography.composerField())
                    .foregroundStyle(Color.white)
                    .lineLimit(draft.wrappedValue.isSummaryExpanded ? 14 : 4)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if mightOverflow {
                    Button(draft.wrappedValue.isSummaryExpanded ? "Show less" : "Show more") {
                        draft.wrappedValue.isSummaryExpanded.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Theme.textMuted)
                }
            }
            if let reviewerReason, !reviewerReason.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text("Reviewer: \(capReviewerReason(reviewerReason))")
                        .lineLimit(2)
                }
                .font(Typography.caption(.medium))
                .foregroundStyle(pillReviewAmber)
            }
            if let defaultAllowAt, !isInFlight {
                TimelineView(.explicit(defaultAllowRedraws(defaultAllowAt))) { context in
                    Text(defaultAllowCountdownText(defaultAllowAt: defaultAllowAt, now: context.date))
                        .font(Typography.captionDigits(.medium))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            if !extras.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(extras, id: \.id) { option in
                        DispatchPillChoiceRow(label: option.label, enabled: !isInFlight) {
                            wiring.onApproval(record.callId, true, option.id, record.childSessionId)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                DispatchPillCardStatus(isInFlight: isInFlight, errorLine: errorLine,
                                       hint: primary.approveLabel == "Approve" ? nil : primary.approveLabel)
                Spacer(minLength: 8)
                DispatchPillCircleButton(role: .refuse, enabled: !isInFlight, label: primary.denyLabel) {
                    wiring.onApproval(record.callId, false, nil, record.childSessionId)
                }
                DispatchPillCircleButton(role: .accept, enabled: !isInFlight,
                                         label: primary.approveLabel == "Approve" ? "Allow once" : primary.approveLabel) {
                    wiring.onApproval(record.callId, true, nil, record.childSessionId)
                }
            }
        }
    }
}

// MARK: - Question

/// One question at a time: the question in the pill's type, its options as compact rows (multiple choice shows its
/// boxes and "Choose any"), an Other field, a note when the ask allows one; then ‹ back, and the blue ✓ — Next before
/// the last question, Send on it, enabled by `dispatchPillQuestionAdvance`. Choosing never sends by itself.
private struct DispatchPillQuestionBody: View {
    let record: InteractionRecord
    let questions: [SessionEvent.Question]
    let header: String
    let waiting: Int
    let isInFlight: Bool
    let errorLine: String?
    let wiring: InteractionCardWiring

    var body: some View {
        let draft = wiring.draftBinding(record.callId)
        let index = min(max(draft.wrappedValue.visibleQuestion, 0), max(questions.count - 1, 0))
        let advance = dispatchPillQuestionAdvance(questions: questions, draft: draft.wrappedValue, index: index,
                                                  inFlight: isInFlight)
        VStack(alignment: .leading, spacing: 10) {
            DispatchPillCardHeader(symbol: "questionmark.bubble.fill", line: header,
                                   trailing: dispatchPillCardTrailing(questionIndex: index, questionCount: questions.count,
                                                                      waiting: waiting))
            if questions.indices.contains(index) {
                let question = questions[index]
                VStack(alignment: .leading, spacing: 3) {
                    Text(question.question)
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white)
                        .lineLimit(6)
                        .fixedSize(horizontal: false, vertical: true)
                    if question.multiSelect {
                        Text("Choose any")
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                VStack(spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { i, option in
                        DispatchPillChoiceRow(label: option.label, detail: option.description,
                                              selected: draft.wrappedValue.selections[index]?.contains(i) == true,
                                              multiSelect: question.multiSelect, enabled: !isInFlight) {
                            if question.multiSelect {
                                draft.wrappedValue.toggleMulti(i, forQuestion: index)
                            } else {
                                draft.wrappedValue.selectSingle(i, forQuestion: index)
                            }
                        }
                    }
                    DispatchPillCardField(
                        placeholder: "Other…",
                        text: Binding(get: { draft.wrappedValue.otherTexts[index] ?? "" },
                                      set: { draft.wrappedValue.setOtherText($0, forQuestion: index) }),
                        enabled: !isInFlight,
                        onSubmit: { go(advance, index: index, draft: draft) }
                    )
                    if questionAllowsNotes(question), draft.wrappedValue.notesOpen.contains(index) {
                        DispatchPillCardField(
                            placeholder: "Add a note (optional)",
                            text: Binding(get: { draft.wrappedValue.notes[index] ?? "" },
                                          set: { draft.wrappedValue.setNote($0, forQuestion: index) }),
                            enabled: !isInFlight,
                            onSubmit: { go(advance, index: index, draft: draft) }
                        )
                    }
                }
                .id(index) // each question is its own page: a field never inherits the last one's text
                HStack(spacing: 8) {
                    DispatchPillCardStatus(isInFlight: isInFlight, errorLine: errorLine)
                    Spacer(minLength: 8)
                    if questionAllowsNotes(question) {
                        let open = draft.wrappedValue.notesOpen.contains(index)
                        DispatchPillCircleButton(role: .quiet, symbol: open ? "note.text" : "note.text.badge.plus",
                                                 enabled: !isInFlight, label: open ? "Hide note" : "Add a note") {
                            draft.wrappedValue.toggleNote(forQuestion: index)
                        }
                    }
                    if index > 0 {
                        DispatchPillCircleButton(role: .refuse, symbol: "chevron.left", enabled: !isInFlight,
                                                 label: "Previous question") {
                            draft.wrappedValue.visibleQuestion = index - 1
                        }
                    }
                    DispatchPillCircleButton(role: .accept,
                                             symbol: advance.action == .next ? "chevron.right" : "checkmark",
                                             enabled: advance.enabled,
                                             label: advance.action == .next ? "Next question" : "Send answer") {
                        go(advance, index: index, draft: draft)
                    }
                }
            }
        }
    }

    /// ✓ (or Return in a field): the next question, or — on the last — the answers, once.
    private func go(_ advance: (action: DispatchPillQuestionAdvance, enabled: Bool), index: Int,
                    draft: Binding<PendingCardDraft>) {
        guard advance.enabled else { return }
        switch advance.action {
        case .next:
            draft.wrappedValue.visibleQuestion = index + 1
        case .send:
            let d = draft.wrappedValue
            wiring.onQuestion(record.callId,
                              questionAnswers(for: questions, selections: d.selections, otherTexts: d.otherTexts),
                              questionNotes(for: questions, notes: d.notes),
                              record.childSessionId)
        }
    }
}

// MARK: - Link request (URL-mode elicitation)

/// An MCP server asking the user to open a link: its message, then where the link goes — the HOST, locked, the one
/// thing to read before clicking — and its origin; ✕ declines, the blue ↗ fetches, checks and opens it (the
/// surface's `onElicitation`). Past `expiresAt` ↗ is disabled and the card says so (one scheduled redraw at the
/// deadline, no timer).
private struct DispatchPillElicitationBody: View {
    let record: InteractionRecord
    let serverName: String
    let message: String
    let host: String
    let origin: String
    let expiresAt: Int
    let isInFlight: Bool
    let errorLine: String?
    let wiring: InteractionCardWiring

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(message.isEmpty ? "\(serverName) asks you to open a link" : message)
                .font(Typography.composerField())
                .foregroundStyle(Color.white)
                .lineLimit(6)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(Typography.caption(.semibold))
                    Text(host)
                        .font(Typography.labelMono(.semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(Color.white)
                Text(origin)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            TimelineView(.explicit([Date(timeIntervalSince1970: Double(expiresAt) / 1000)])) { _ in
                // The schedule only REDRAWS at the deadline; the clock is read here — an explicit timeline's first
                // context date is its (future) entry, which would read as expired from the start.
                let expired = elicitationIsExpired(expiresAt: expiresAt, now: Date())
                HStack(spacing: 8) {
                    DispatchPillCardStatus(isInFlight: isInFlight, errorLine: errorLine,
                                           hint: expired ? "This request has expired" : nil)
                    Spacer(minLength: 8)
                    DispatchPillCircleButton(role: .refuse, enabled: !isInFlight, label: "Decline") {
                        wiring.onElicitation(record.callId, false, host, expiresAt)
                    }
                    DispatchPillCircleButton(role: .accept, symbol: "arrow.up.right", enabled: !isInFlight && !expired,
                                             label: "Open \(host)") {
                        wiring.onElicitation(record.callId, true, host, expiresAt)
                    }
                }
            }
        }
    }
}

// MARK: - Plan

/// A plan for approval (a code-mode ask; Dispatch itself never plans, so this shows only if one ever reaches the
/// pill): its text, a quiet "approve and auto-accept edits" row, ✕ to ask for changes (a field for what to change,
/// sent with the blue ↑) and ✓ to approve.
private struct DispatchPillPlanBody: View {
    let record: InteractionRecord
    let plan: String
    let isInFlight: Bool
    let errorLine: String?
    let wiring: InteractionCardWiring

    var body: some View {
        let draft = wiring.draftBinding(record.callId)
        let requesting = draft.wrappedValue.isRequestingChanges
        VStack(alignment: .leading, spacing: 10) {
            Text(plan)
                .font(Typography.composerField())
                .foregroundStyle(Color.white)
                .lineLimit(10)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if requesting {
                DispatchPillCardField(placeholder: "What should change?", text: draft.feedback, enabled: !isInFlight) {
                    sendChanges(draft.wrappedValue.feedback)
                }
            } else {
                DispatchPillChoiceRow(label: "Approve and auto-accept edits", enabled: !isInFlight) {
                    wiring.onPlan(record.callId, true, true, nil)
                }
            }
            HStack(spacing: 8) {
                DispatchPillCardStatus(isInFlight: isInFlight, errorLine: errorLine)
                Spacer(minLength: 8)
                if requesting {
                    DispatchPillCircleButton(role: .refuse, enabled: !isInFlight, label: "Back to the plan") {
                        draft.wrappedValue.isRequestingChanges = false
                    }
                    DispatchPillCircleButton(role: .accept, symbol: "arrow.up", enabled: !isInFlight, label: "Send changes") {
                        sendChanges(draft.wrappedValue.feedback)
                    }
                } else {
                    DispatchPillCircleButton(role: .refuse, enabled: !isInFlight, label: "Request changes") {
                        draft.wrappedValue.isRequestingChanges = true
                    }
                    DispatchPillCircleButton(role: .accept, enabled: !isInFlight, label: "Approve") {
                        wiring.onPlan(record.callId, true, false, nil)
                    }
                }
            }
        }
    }

    private func sendChanges(_ feedback: String) {
        let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        wiring.onPlan(record.callId, false, false, trimmed.isEmpty ? nil : feedback)
    }
}

// MARK: - The set-aside cards' pill

/// Above the main pill while the user has set cards aside by typing: the amber hand and "2 waiting for you". A click
/// brings them back — the pill morphs into the oldest.
struct DispatchPillSetAsidePill: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(pillReviewAmber)
                Text(dispatchPillSetAsideLabel(count))
                    .font(Typography.label(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 16)
            .frame(height: DispatchPillMetrics.pillHeight)
            .background(Capsule(style: .continuous).fill(Color.black))
            .overlay(Capsule(style: .continuous).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(DispatchPillPressStyle())
        .fixedSize()
        .help("Show what's waiting")
        .accessibilityLabel("\(dispatchPillSetAsideLabel(count)). Show it.")
    }
}
