import SwiftUI
import WinterCUPresentation
import WinterProtocol

// The Winter island's views (`docs/claude/island.md`). Always dark (the panels are `darkAqua`): black shells over
// arbitrary desktop content, the Dispatch pill's type (`Typography.body(.light)` — its composer's 14 pt), the white ✕ and
// the blue ✓ with the pills' hover glow. Fonts come from `Typography` only (`TypographyTests` sweeps this folder).

/// The coordinate space the island's panels draw in (the pointer monitors report into it).
enum IslandSpace {
    static let name = "winter-island"
}

// MARK: - The slim strip

/// The permanent strip extending the housing: the "waiting for you" icon on its left wing, the count on its right.
/// Static: no animation, no timeline — it redraws only when the count changes.
struct IslandStripView: View {
    let model: IslandStripModel
    let size: CGSize
    /// The housing's width, nil without one (the icon and the count then sit side by side).
    let housingWidth: CGFloat?

    var body: some View {
        let shape = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: IslandLayout.stripCorner,
                                                              bottomTrailing: IslandLayout.stripCorner),
                                           style: .continuous)
        ZStack {
            shape.fill(Color.black)
            if model.waitingCount == 0 {
                // Idle: exactly the housing, black on black — nothing drawn beside it.
                EmptyView()
            } else if let housingWidth {
                HStack(spacing: 0) {
                    icon.frame(width: IslandLayout.stripWing)
                    Spacer(minLength: housingWidth)
                    count.frame(width: IslandLayout.stripWing)
                }
            } else {
                HStack(spacing: 6) {
                    icon
                    count
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .contentShape(shape)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    private var icon: some View {
        Image(systemName: IslandTabRegistry.needsYou.symbol)
            .font(Typography.label(.semibold))
            .foregroundStyle(model.waitingCount > 0 ? pillReviewAmber : Theme.textMuted)
    }

    @ViewBuilder private var count: some View {
        if let label = model.countLabel {
            Text(label)
                .font(Typography.label(.semibold))
                .foregroundStyle(Color.white)
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }
}

// MARK: - Buttons

/// The pills' answer circle: white ✕ (no) or blue ✓ (yes), glowing softly in its own colour under the pointer.
struct IslandAnswerButton: View {
    enum Role { case refuse, accept }

    let role: Role
    var symbol: String?
    var enabled = true
    let action: () -> Void

    private var fill: Color { role == .accept ? IslandCircleButtonStyle.blue : Color.white }
    private var glyph: Color { role == .accept ? Color.white : Color.black }

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol ?? (role == .accept ? "checkmark" : "xmark"))
                .font(Typography.label(.bold))
                .foregroundStyle(glyph)
                .frame(width: IslandCircleButtonStyle.size, height: IslandCircleButtonStyle.size)
                .background(Circle().fill(fill))
                .contentShape(Circle())
                .pillHoverGlow(fill)
        }
        .buttonStyle(IslandPressStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// A press shrinks a little and dims, like the desktop-switch pill's buttons.
struct IslandPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

// MARK: - A card's words

/// What a rectangle's header says and shows.
struct IslandCardHeader: View {
    let card: IslandCard
    var trailing: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: islandKindSymbol(card.kind))
                .font(Typography.caption(.semibold))
                .foregroundStyle(pillReviewAmber)
            Text(islandHeaderLine(card))
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

func islandKindSymbol(_ kind: IslandCard.Kind) -> String {
    switch kind {
    case .approval: return "hand.raised.fill"
    case .question: return "questionmark.bubble.fill"
    case .elicitation: return "link"
    case .viewRequest: return "eye.fill"
    }
}

/// PURE: the header line — the session, then what is asking.
func islandHeaderLine(_ card: IslandCard) -> String {
    switch card.payload {
    case .approval(let tool, _, _, _): return "\(card.sessionLabel) · \(tool)"
    case .question: return "\(card.sessionLabel) asks"
    case .elicitation(let server, _, let host, _): return "\(server) · \(host)"
    case .viewRequest(let app, _, _): return "\(card.sessionLabel) · \(app)"
    }
}

/// PURE: the card's main line(s).
func islandBodyText(_ card: IslandCard) -> String {
    switch card.payload {
    case .approval(_, let summary, let reviewerReason, _):
        if let reviewerReason, !reviewerReason.isEmpty { return "\(summary)\n\(reviewerReason)" }
        return summary
    case .question(let questions): return questions.first?.question ?? ""
    case .elicitation(let server, let message, let host, _):
        return message.isEmpty ? "\(server) asks you to open \(host)" : message
    case .viewRequest(let app, _, _): return "Winter needs your view for a sec on \(app)"
    }
}

/// PURE: the waiting pill's one short line.
func islandWaitingLine(_ card: IslandCard) -> String {
    switch card.payload {
    case .approval(let tool, _, _, _): return "\(tool) · \(card.sessionLabel)"
    case .question: return "Question · \(card.sessionLabel)"
    case .elicitation(let server, _, _, _): return "Link · \(server)"
    case .viewRequest(let app, _, _): return "View · \(app)"
    }
}

// MARK: - The rectangle on top (approvals, questions, link requests)

/// A card's content inside its liquid shell. Approvals and links: the line(s), ✕ and ✓. Questions: one question at a
/// time, its options as rows (a single-choice question answers on the click), an "Other" field (clicking it lets the
/// panel take the keyboard), ✓ to send once every question has an answer.
struct IslandRectContent: View {
    let card: IslandCard
    @ObservedObject var store: IslandStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch card.payload {
            case .question(let questions):
                IslandQuestionBody(card: card, questions: questions, store: store)
            default:
                IslandCardHeader(card: card)
                Text(islandBodyText(card))
                    .font(Typography.body(.light))
                    .foregroundStyle(Color.white)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                answerRow
            }
        }
        .padding(IslandLayout.cardPadding)
        .frame(width: IslandLayout.cardWidth, alignment: .topLeading)
    }

    private var answerRow: some View {
        HStack(spacing: 8) {
            if let error = store.errors[card.id] {
                Text(error).font(Typography.caption()).foregroundStyle(pillReviewAmber).lineLimit(1)
            }
            Spacer(minLength: 0)
            let enabled = !store.inFlight.contains(card.id)
            IslandAnswerButton(role: .refuse, enabled: enabled) {
                if card.kind == .elicitation { store.answerElicitation(card, accept: false) } else { store.answerApproval(card, approved: false) }
            }
            .accessibilityLabel(card.kind == .elicitation ? "Decline" : "Deny")
            IslandAnswerButton(role: .accept, symbol: card.kind == .elicitation ? "arrow.up.right" : nil, enabled: enabled) {
                if card.kind == .elicitation { store.answerElicitation(card, accept: true) } else { store.answerApproval(card, approved: true) }
            }
            .accessibilityLabel(card.kind == .elicitation ? "Open link" : "Allow once")
        }
    }
}

struct IslandQuestionBody: View {
    let card: IslandCard
    let questions: [SessionEvent.Question]
    @ObservedObject var store: IslandStore

    var body: some View {
        let draft = store.draftBinding(for: card.id)
        let index = min(draft.wrappedValue.visibleQuestion, max(questions.count - 1, 0))
        let question = questions.indices.contains(index) ? questions[index] : nil
        VStack(alignment: .leading, spacing: 10) {
            IslandCardHeader(card: card, trailing: questions.count > 1 ? "\(index + 1) of \(questions.count)" : nil)
            if let question {
                Text(question.question)
                    .font(Typography.body(.light))
                    .foregroundStyle(Color.white)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 6) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { i, option in
                        optionRow(option.label, selected: draft.wrappedValue.selections[index]?.contains(i) == true) {
                            choose(i, in: question, at: index, draft: draft)
                        }
                    }
                    TextField("Other…", text: Binding(
                        get: { draft.wrappedValue.otherTexts[index] ?? "" },
                        set: { draft.wrappedValue.otherTexts[index] = $0 }))
                        .textFieldStyle(.plain)
                        .font(Typography.body(.light))
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                        .onSubmit { advance(at: index, draft: draft) }
                }
                HStack(spacing: 8) {
                    if let error = store.errors[card.id] {
                        Text(error).font(Typography.caption()).foregroundStyle(pillReviewAmber).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if questions.count > 1, index > 0 {
                        IslandAnswerButton(role: .refuse, symbol: "chevron.left") { draft.wrappedValue.visibleQuestion = index - 1 }
                            .accessibilityLabel("Previous question")
                    }
                    IslandAnswerButton(role: .accept, symbol: index < questions.count - 1 ? "chevron.right" : nil,
                                       enabled: answered(index, draft: draft.wrappedValue) && !store.inFlight.contains(card.id)) {
                        advance(at: index, draft: draft)
                    }
                    .accessibilityLabel(index < questions.count - 1 ? "Next question" : "Send")
                }
            }
        }
    }

    private func optionRow(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label)
                    .font(Typography.body(.light))
                    .foregroundStyle(selected ? Color.black : Color.white)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(Capsule().fill(selected ? Color.white : Color.white.opacity(0.12)))
            .contentShape(Capsule())
        }
        .buttonStyle(IslandPressStyle())
    }

    private func answered(_ index: Int, draft: PendingCardDraft) -> Bool {
        let other = draft.otherTexts[index]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !other.isEmpty || !(draft.selections[index] ?? []).isEmpty
    }

    /// A click on an option: a single-choice question takes it and moves on (and a single-question card sends at
    /// once); a multiple-choice one toggles it.
    private func choose(_ option: Int, in question: SessionEvent.Question, at index: Int, draft: Binding<PendingCardDraft>) {
        var d = draft.wrappedValue
        if question.multiSelect {
            var set = d.selections[index] ?? []
            if set.contains(option) { set.remove(option) } else { set.insert(option) }
            d.selections[index] = set
            draft.wrappedValue = d
            return
        }
        d.selections[index] = [option]
        d.otherTexts[index] = nil
        draft.wrappedValue = d
        advance(at: index, draft: draft)
    }

    /// The next question, or — after the last — the answers.
    private func advance(at index: Int, draft: Binding<PendingCardDraft>) {
        guard answered(index, draft: draft.wrappedValue) else { return }
        if index < questions.count - 1 {
            draft.wrappedValue.visibleQuestion = index + 1
            return
        }
        let d = draft.wrappedValue
        guard questionCardComplete(questions: questions, selections: d.selections, otherTexts: d.otherTexts) else { return }
        store.answerQuestion(card, answers: questionAnswers(for: questions, selections: d.selections, otherTexts: d.otherTexts))
    }
}

/// The liquid shell around a rectangle's content: born from the housing (display-rate frames only while it moves),
/// at rest a plain view.
struct IslandRectShell: View {
    let card: IslandCard
    let geometry: DesktopIslandGeometry
    @ObservedObject var state: DesktopIslandState
    @ObservedObject var store: IslandStore
    var reduceMotion = false

    var body: some View {
        Group {
            if state.still || state.bornAt == nil {
                frameView(at: Date())
            } else {
                TimelineView(.animation) { context in frameView(at: context.date) }
            }
        }
        .frame(width: geometry.panelSize.width, height: geometry.panelSize.height, alignment: .topLeading)
    }

    private func frameView(at date: Date) -> some View {
        let frame = reduceMotion ? restFrame(date) : DesktopIslandFluid(geometry: geometry).frame(at: state.seconds(at: date))
        let hovered = state.pointer.map { geometry.pill.contains($0) } ?? false
        return CUIslandLiquidFrame(frame: frame, geometry: geometry, hovered: hovered && frame.content > 0.9 && state.returningAt == nil,
                                   interactive: frame.content > 0.9 && state.returningAt == nil) {
            IslandRectContent(card: card, store: store)
        }
    }

    private func restFrame(_ now: Date) -> DesktopIslandFluid.Frame {
        var f = DesktopIslandFluid(geometry: geometry).frame(at: DesktopIslandFluid.settle)
        let shown = state.seconds(at: now) > 0 ? 1.0 : 0.0
        f.blobs = []
        f.crisp = shown
        f.content = shown
        return f
    }
}

// MARK: - The waiting pill and the badge

/// The compact pill waiting under a hovered card: one short line; a click expands it (the current card tucks away).
struct IslandWaitingPill: View {
    let card: IslandCard
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: islandKindSymbol(card.kind))
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(pillReviewAmber)
                Text(islandWaitingLine(card))
                    .font(Typography.label(.medium))
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 14)
            .frame(width: IslandLayout.waitingWidth, height: IslandLayout.waitingHeight)
            .background(Capsule(style: .continuous).fill(Color.black))
            .overlay(Capsule(style: .continuous).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .shadow(color: .black.opacity(0.45), radius: 10, y: 3)
            .contentShape(Capsule())
        }
        .buttonStyle(IslandPressStyle())
        .accessibilityLabel("Waiting: \(islandWaitingLine(card)). Show it.")
    }
}

/// The badge hanging from the housing: "2 waiting". Hovering it brings the newest back.
struct IslandBadge: View {
    let count: Int
    let width: CGFloat

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: IslandTabRegistry.needsYou.symbol)
                .font(Typography.caption(.semibold))
                .foregroundStyle(pillReviewAmber)
            Text(islandBadgeLabel(count))
                .font(Typography.label(.medium))
                .foregroundStyle(Color.white)
        }
        .frame(width: width, height: IslandLayout.badgeHeight)
        .background(UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: IslandLayout.badgeHeight / 2,
                                                              bottomTrailing: IslandLayout.badgeHeight / 2),
                                           style: .continuous).fill(Color.black))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(islandBadgeLabel(count))
    }

    /// Wide enough for its words.
    static func width(for count: Int) -> CGFloat {
        let text = (islandBadgeLabel(count) as NSString).size(withAttributes: [.font: Typography.sansNS(ofSize: Typography.labelSize, .medium)]).width
        return ceil(text) + 50
    }
}

// MARK: - The open island

/// The open island: grows out of the housing, its tab dots, and the selected tab — Phase 1's one tab, Needs you.
struct IslandExpandedView: View {
    @ObservedObject var store: IslandStore
    let shape: IslandScreenShape
    let size: CGSize
    /// The list scrolls (always, live); the offscreen gallery lays it out flat (`ImageRenderer` cannot draw a scroll view).
    var scrolls = true

    var body: some View {
        let outline = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: IslandLayout.islandCorner,
                                                                bottomTrailing: IslandLayout.islandCorner),
                                             style: .continuous)
        VStack(spacing: 0) {
            Color.clear.frame(height: shape.topInset)
            HStack(spacing: 8) {
                Text(store.tabs.selected?.title ?? "")
                    .font(Typography.body(.semibold))
                    .foregroundStyle(Color.white)
                if store.tabs.selected?.id == IslandTabRegistry.needsYou.id, !store.cards.isEmpty {
                    Text("\(store.cards.count)")
                        .font(Typography.captionDigits(.semibold))
                        .foregroundStyle(Color.black)
                        .padding(.horizontal, 6)
                        .frame(height: 16)
                        .background(Capsule().fill(pillReviewAmber))
                }
                Spacer()
                if store.tabs.showsDots { IslandTabDots(state: store.tabs) { store.tabs.select($0) } }
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
            tabBody
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .background(outline.fill(Color.black))
        .overlay(outline.strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .clipShape(outline)
        .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
    }

    @ViewBuilder private var tabBody: some View {
        switch store.tabs.selected?.id {
        case IslandTabRegistry.needsYou.id?: IslandNeedsYouList(store: store, scrolls: scrolls)
        case IslandTabRegistry.watches.id?: IslandWatchesList(activity: store.activity, scrolls: scrolls)
        default: Spacer()
        }
    }
}

struct IslandTabDots: View {
    let state: IslandTabState
    let select: (String) -> Void

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(state.tabs.enumerated()), id: \.element.id) { i, tab in
                Circle()
                    .fill(i == state.selectedIndex ? Color.white : Color.white.opacity(0.3))
                    .frame(width: 6, height: 6)
                    .contentShape(Rectangle().inset(by: -4))
                    .onTapGesture { select(tab.id) }
                    .help(tab.title)
                    .accessibilityLabel(tab.title)
            }
        }
    }
}

/// Needs you: every pending card, newest first, each answerable here — approvals, questions and links with the
/// transcript's own card (rule options and notes included), view requests with ✕ / ✓.
struct IslandNeedsYouList: View {
    @ObservedObject var store: IslandStore
    var scrolls = true

    var body: some View {
        if store.cards.isEmpty {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle")
                    .font(Typography.heading(.light))
                    .foregroundStyle(Theme.textMuted)
                Text("Nothing needs you")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textMuted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
        } else if scrolls {
            ScrollView(.vertical) { rows }
                .scrollIndicators(.never)
        } else {
            rows
            Spacer(minLength: 0)
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(store.cards.reversed()) { card in
                IslandNeedsYouRow(card: card, store: store)
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }
}

struct IslandNeedsYouRow: View {
    let card: IslandCard
    @ObservedObject var store: IslandStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            IslandCardHeader(card: card)
                .padding(.horizontal, 6)
            if case .elicitation(let server, _, let host, _) = card.payload {
                // A link request: its words, then ✕ (decline) and ↗ (open link) together at the trailing edge, like
                // every other island card.
                VStack(alignment: .leading, spacing: 10) {
                    Text(islandBodyText(card))
                        .font(Typography.body(.light))
                        .foregroundStyle(Color.white)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Image(systemName: "lock.fill")
                            .font(Typography.caption(.semibold))
                            .foregroundStyle(Theme.textMuted)
                        Text(host)
                            .font(Typography.labelMono())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                        if let error = store.errors[card.id] {
                            Text(error).font(Typography.caption()).foregroundStyle(pillReviewAmber).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        let enabled = !store.inFlight.contains(card.id)
                        IslandAnswerButton(role: .refuse, enabled: enabled) { store.answerElicitation(card, accept: false) }
                            .accessibilityLabel("Decline \(server)'s link")
                        IslandAnswerButton(role: .accept, symbol: "arrow.up.right", enabled: enabled) {
                            store.answerElicitation(card, accept: true)
                        }
                        .accessibilityLabel("Open \(host)")
                    }
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.white.opacity(0.08)))
            } else if let record = islandInteractionRecord(card) {
                TranscriptInteractionCard(record: record, wiring: wiring)
            } else {
                // A view request: the pill's own line and buttons.
                HStack(spacing: 8) {
                    Text(islandBodyText(card))
                        .font(Typography.body(.light))
                        .foregroundStyle(Color.white)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    let enabled = !store.inFlight.contains(card.id)
                    IslandAnswerButton(role: .refuse, enabled: enabled) { store.answerApproval(card, approved: false) }
                        .accessibilityLabel("Don't switch")
                    IslandAnswerButton(role: .accept, enabled: enabled) { store.answerApproval(card, approved: true) }
                        .accessibilityLabel("Switch now")
                }
                .padding(.horizontal, 14)
                .frame(height: DesktopIslandGeometry.pillHeight)
                .background(Capsule(style: .continuous).fill(Color.white.opacity(0.08)))
            }
        }
    }

    private var wiring: InteractionCardWiring {
        let store = store
        let card = card
        return InteractionCardWiring(
            inFlight: store.inFlight.contains(card.id) ? [card.callId] : [],
            closedAsks: [card.callId],
            errorLines: store.errors[card.id].map { [card.callId: $0] } ?? [:],
            draftBinding: { _ in store.draftBinding(for: card.id) },
            onApproval: { _, approved, optionId, _ in store.answerApproval(card, approved: approved, optionId: optionId) },
            onQuestion: { _, answers, notes, _ in store.answerQuestion(card, answers: answers, notes: notes) },
            onPlan: { _, _, _, _ in },
            onElicitation: { _, accept, _, _ in store.answerElicitation(card, accept: accept) }
        )
    }
}

/// PURE: the transcript's record for a card (nil for a view request, which the list draws itself).
func islandInteractionRecord(_ card: IslandCard) -> InteractionRecord? {
    switch card.payload {
    case .approval(let tool, let summary, let reviewer, let options):
        return InteractionRecord(callId: card.callId,
                                 ask: .approval(toolName: tool, summary: summary, reviewerReason: reviewer,
                                                options: options.isEmpty ? nil : options))
    case .question(let questions):
        return InteractionRecord(callId: card.callId, ask: .question(questions: questions))
    case .elicitation(let server, let message, let host, let origin):
        return InteractionRecord(callId: card.callId,
                                 ask: .urlElicitation(serverName: server, message: message, host: host, origin: origin,
                                                      expiresAt: card.expiresAt ?? islandUnknownExpiry()))
    case .viewRequest:
        return nil
    }
}

/// A link request with no deadline on record (never from a live daemon, which always sends one): an hour from now,
/// so the card's own expiry check never reads it as expired.
func islandUnknownExpiry(now: Date = Date()) -> Int { Int(now.timeIntervalSince1970 * 1000) + 3_600_000 }
