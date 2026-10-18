import SwiftUI
import WinterCUPresentation
import WinterProtocol

// The Winter island's views (`docs/claude/island.md`). Always dark (the panels are `darkAqua`): black shells over
// arbitrary desktop content, the Dispatch pill's typed text (`Typography.composerField()` — its composer's 14 pt, light on
// the dark shells), the white ✕ and the blue ✓ with the pills' hover glow. Fonts come from `Typography` only
// (`TypographyTests` sweeps this folder).

/// The coordinate space the island's panels draw in (the pointer monitors report into it).
enum IslandSpace {
    static let name = "winter-island"
}

// MARK: - The slim strip

/// The permanent strip extending the housing: "waiting for you" (the amber icon and its count) on its left wing, the
/// working sessions (a bolt and their count) on its right. Static: no animation, no timeline — it redraws only when a
/// count changes. Idle (nothing waits, nothing works) it is the housing alone.
struct IslandStripView: View {
    let model: IslandStripModel
    let size: CGSize
    /// The housing's width, nil without one (the icon and the count then sit side by side).
    let housingWidth: CGFloat?
    /// The pointer is over it: it glows dark, softly — the Dispatch pill buttons' glow, in black (user 2026-10-17).
    var hovered = false

    var body: some View {
        let shape = UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: IslandLayout.stripCorner,
                                                              bottomTrailing: IslandLayout.stripCorner),
                                           style: .continuous)
        ZStack {
            shape.fill(Color.black)
                .shadow(color: Color.black.opacity(hovered ? PillHoverGlowMetrics.near : 0), radius: PillHoverGlowMetrics.nearRadius)
                .shadow(color: Color.black.opacity(hovered ? PillHoverGlowMetrics.far : 0), radius: PillHoverGlowMetrics.farRadius)
                .animation(.easeOut(duration: 0.15), value: hovered)
            if !model.showsWings {
                // Idle: exactly the housing, black on black — nothing drawn beside it.
                EmptyView()
            } else if let housingWidth {
                HStack(spacing: 0) {
                    waitingGroup.frame(width: IslandLayout.stripWing)
                    Spacer(minLength: housingWidth)
                    workingGroup.frame(width: IslandLayout.stripWing)
                }
            } else {
                HStack(spacing: 8) {
                    waitingGroup
                    workingGroup
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .contentShape(shape)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    /// Both wings' symbols and counts share one size, centred on the housing's height (the menu bar's own centre line).
    static let glyph = Typography.label(.semibold)
    static let count = Typography.label(.semibold)

    /// The amber "waiting for you" icon and its count (nothing while nothing waits).
    @ViewBuilder private var waitingGroup: some View {
        if let label = model.countLabel {
            HStack(spacing: 4) {
                Image(systemName: IslandTabRegistry.needsYou.symbol)
                    .font(Self.glyph)
                    .foregroundStyle(pillReviewAmber)
                Text(label)
                    .font(Self.count)
                    .foregroundStyle(Color.white)
            }
            .frame(height: size.height)
        } else {
            Color.clear.frame(width: 1, height: 1)
        }
    }

    /// The working sessions: a bolt and their count (nothing while nothing works).
    @ViewBuilder private var workingGroup: some View {
        if let label = model.workingLabel {
            HStack(spacing: 4) {
                Image(systemName: "bolt.fill")
                    .font(Self.glyph)
                    .foregroundStyle(Theme.accent)
                Text(label)
                    .font(Self.count)
                    .foregroundStyle(Color.white)
            }
            .frame(height: size.height)
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
    case .elicitation(let server, _, _, _): return "\(card.sessionLabel) · \(server)"
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
                IslandAnswerLine(card: card, store: store, lineLimit: 4)
            }
        }
        .padding(IslandLayout.cardPadding)
        .frame(width: IslandLayout.cardWidth, alignment: .topLeading)
    }
}

/// An approval's, a link request's or a view request's words with their ✕ and ✓ (↗ for a link) at the trailing end,
/// bottom-aligned with the last line — the one answer layout of every island card (the desktop-switch pill's row, the
/// turn result's), on top and in Needs you. A failed answer's line goes under the words.
struct IslandAnswerLine: View {
    let card: IslandCard
    @ObservedObject var store: IslandStore
    var lineLimit = 4

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(islandBodyText(card))
                    .font(Typography.composerField())
                    .foregroundStyle(Color.white)
                    .lineLimit(lineLimit)
                    .fixedSize(horizontal: false, vertical: true)
                if case .elicitation(_, _, let host, _) = card.payload {
                    // Where ↗ goes, said once, beside the button that opens it.
                    HStack(spacing: 5) {
                        Image(systemName: "lock.fill").font(Typography.caption(.semibold))
                        Text(host).font(Typography.labelMono()).lineLimit(1).truncationMode(.middle)
                    }
                    .foregroundStyle(Theme.textMuted)
                }
                if let error = store.errors[card.id] {
                    Text(error).font(Typography.caption()).foregroundStyle(pillReviewAmber).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: IslandCircleButtonStyle.size, alignment: .leading)
            let enabled = !store.inFlight.contains(card.id)
            IslandAnswerButton(role: .refuse, enabled: enabled) { answer(false) }
                .accessibilityLabel(islandAnswerLabels(card).refuse)
            IslandAnswerButton(role: .accept, symbol: card.kind == .elicitation ? "arrow.up.right" : nil, enabled: enabled) {
                answer(true)
            }
            .accessibilityLabel(islandAnswerLabels(card).accept)
        }
    }

    private func answer(_ yes: Bool) {
        if card.kind == .elicitation { store.answerElicitation(card, accept: yes) } else { store.answerApproval(card, approved: yes) }
    }
}

/// PURE: the ✕ and ✓ words VoiceOver reads for a card.
func islandAnswerLabels(_ card: IslandCard) -> (refuse: String, accept: String) {
    switch card.payload {
    case .elicitation(let server, _, let host, _): return ("Decline \(server)'s link", "Open \(host)")
    case .viewRequest: return ("Don't switch", "Switch now")
    default: return ("Deny", "Allow once")
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
                    .font(Typography.composerField())
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
                        .font(Typography.composerField())
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
            IslandPointerReader { hovered in
                HStack {
                    Text(label)
                        .font(Typography.composerField())
                        .foregroundStyle(selected ? Color.black : Color.white)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 30)
                .background(Capsule().fill(selected ? Color.white : Color.white.opacity(hovered ? 0.18 : 0.12)))
                .animation(.easeOut(duration: 0.15), value: hovered)
                .contentShape(Capsule())
            }
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
    /// Hovered, as the controller judged it (the grown shape while hovered): its grow.
    var hovered = false
    /// The pointer in the card's own unscaled space, for its buttons' glow and options' highlight.
    var pointer: DispatchPillPointer?
    var reduceMotion = false

    var body: some View {
        // ONE timeline, paused at rest: the card's contents (a question's typed "Other") keep their identity when the
        // birth settles.
        let paused = state.still || state.bornAt == nil
        TimelineView(.animation(minimumInterval: nil, paused: paused)) { context in
            frameView(at: paused ? Date() : context.date)
        }
        .frame(width: geometry.panelSize.width, height: geometry.panelSize.height, alignment: .topLeading)
    }

    private func frameView(at date: Date) -> some View {
        let frame = reduceMotion ? restFrame(date) : DesktopIslandFluid(geometry: geometry).frame(at: state.seconds(at: date))
        return CUIslandLiquidFrame(frame: frame, geometry: geometry, hovered: hovered && frame.content > 0.9 && state.returningAt == nil,
                                   interactive: frame.content > 0.9 && state.returningAt == nil) {
            IslandRectContent(card: card, store: store)
                .islandPanelSpace()
                .environment(\.dispatchPillPointer, pointer)
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

// MARK: - The waiting pill

/// The compact pill waiting under a hovered card: one short line; a click expands it (the current card tucks away). It
/// grows under the pointer by the compact Dispatch pill's few points, like every floating island panel.
struct IslandWaitingPill: View {
    let card: IslandCard
    /// Hovered, as the controller judged it (the grown shape while hovered).
    var hovered = false
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
        .islandHoverGrow(hovered, size: CGSize(width: IslandLayout.waitingWidth, height: IslandLayout.waitingHeight))
        .accessibilityLabel("Waiting: \(islandWaitingLine(card)). Show it.")
    }
}

// MARK: - The open island

/// The open island at rest, with its own shell (the offscreen gallery's; live, `IslandOpenFrame` draws the shell as it
/// morphs out of the strip): the header, its tab dots, and the selected tab.
struct IslandExpandedView: View {
    @ObservedObject var store: IslandStore
    let shape: IslandScreenShape
    let size: CGSize
    /// The list scrolls (always, live); the offscreen gallery lays it out flat, cut at the island's edge (`ImageRenderer`
    /// cannot draw a scroll view).
    var scrolls = true
    /// The phase-2 tabs' models (nil: only Needs you has a body).
    var tabModels: IslandTabModels?

    var body: some View {
        let target = CGRect(origin: .zero, size: size)
        IslandOpenFrame(frame: .resting(target), target: target, shape: shape) {
            IslandExpandedContent(store: store, shape: shape, size: size, scrolls: scrolls, tabModels: tabModels)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}

/// The open island's contents (no shell): the housing's band, the header (pinned), the selected tab — which scrolls
/// inside the island's fixed size (`IslandTabScroll`).
struct IslandExpandedContent: View {
    @ObservedObject var store: IslandStore
    let shape: IslandScreenShape
    let size: CGSize
    var scrolls = true
    var tabModels: IslandTabModels?

    var body: some View {
        VStack(spacing: 0) {
            if shape.hasHousing {
                // The header sits IN the housing's band, inline with it: the title left of the housing, the dots right.
                IslandOpenHeader(store: store, height: shape.topInset, housingWidth: shape.housing?.width)
            } else {
                Color.clear.frame(height: shape.topInset)
                IslandOpenHeader(store: store)
            }
            tabBody
        }
        .frame(width: size.width, height: size.height, alignment: .top)
    }

    @ViewBuilder private var tabBody: some View {
        switch store.tabs.selected?.id {
        case IslandTabRegistry.needsYou.id?: IslandNeedsYouList(store: store, scrolls: scrolls)
        case IslandTabRegistry.watches.id?: IslandWatchesList(activity: store.activity, scrolls: scrolls)
        case let id?:
            if let tabModels { IslandTabBody(id: id, models: tabModels, scrolls: scrolls) } else { Spacer() }
        default: Spacer()
        }
    }
}

/// The open island's header: the selected tab's title (with Needs you's count), and the dots on the same centre line.
struct IslandOpenHeader: View {
    @ObservedObject var store: IslandStore
    /// The row's height: `Self.height` below the band without a housing, the housing's height beside it.
    var height: CGFloat = Self.height
    /// The housing's width when the header sits beside it: the title keeps left of it, the dots right of it.
    var housingWidth: CGFloat? = nil

    /// The header's height without a housing (the open island's content measure adds it).
    static let height: CGFloat = 46

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            HStack(spacing: 8) {
                // The Dispatch pill's typed text — its size and weight (user 2026-10-18).
                Text(store.tabs.selected?.title ?? "")
                    .font(Typography.composerField())
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if store.tabs.selected?.id == IslandTabRegistry.needsYou.id, !store.cards.isEmpty {
                    Text("\(store.cards.count)")
                        .font(Typography.captionDigits(.semibold))
                        .foregroundStyle(Color.black)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Capsule().fill(pillReviewAmber))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let housingWidth { Color.clear.frame(width: housingWidth) }
            HStack {
                if store.tabs.showsDots { IslandTabDots(state: store.tabs) { store.tabs.select($0) } }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, IslandLayout.headerInset)
        .frame(height: height)
    }
}

/// Where you are among the tabs: the selected one a short white bar, the others small dots (the page indicator's
/// shape), sliding on the same spring as a tab change. Each takes a click.
struct IslandTabDots: View {
    let state: IslandTabState
    let select: (String) -> Void

    static let dot: CGFloat = 6
    static let selectedWidth: CGFloat = 16

    var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(state.tabs.enumerated()), id: \.element.id) { i, tab in
                let selected = i == state.selectedIndex
                Capsule()
                    .fill(selected ? Color.white : Color.white.opacity(0.3))
                    .frame(width: selected ? Self.selectedWidth : Self.dot, height: Self.dot)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                    .onTapGesture { select(tab.id) }
                    .help(tab.title)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: state.selectedIndex)
    }
}

/// Needs you: every pending card, newest first, each answerable here — approvals and questions with the transcript's own
/// card (rule options and notes included), link and view requests with the island's answer line, all on the transcript
/// card's surface.
struct IslandNeedsYouList: View {
    @ObservedObject var store: IslandStore
    var scrolls = true

    /// Between two cards (each a header and its card).
    static let gap: CGFloat = 12

    var body: some View {
        if store.cards.isEmpty {
            IslandEmptyTab(symbol: "checkmark.circle", line: "Nothing needs you")
        } else {
            IslandTabScroll(scrolls: scrolls) { rows }
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(store.cards.reversed()) { card in
                IslandNeedsYouRow(card: card, store: store)
            }
        }
        .padding(.horizontal, IslandLayout.listInset)
        .padding(.bottom, IslandLayout.listInset)
    }
}

struct IslandNeedsYouRow: View {
    let card: IslandCard
    @ObservedObject var store: IslandStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            IslandCardHeader(card: card)
                .padding(.horizontal, IslandLayout.headerInset - IslandLayout.listInset)
            switch card.payload {
            case .elicitation, .viewRequest:
                // A link or a view request: the island's own answer line (✕ and ↗ / ✓ beside the words, as on top), on
                // the transcript card's surface.
                IslandAnswerLine(card: card, store: store, lineLimit: card.kind == .viewRequest ? 2 : 6)
                    .padding(IslandLayout.cardPadding)
                    .islandInnerCard()
            default:
                if let record = islandInteractionRecord(card) { TranscriptInteractionCard(record: record, wiring: wiring) }
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

// MARK: - Surfaces

extension View {
    /// The transcript interaction card's surface (`CardSurface`, a `HairlineElevated` rim, its 28 pt corner) — what a
    /// link or view request sits on in Needs you, beside the transcript's own cards.
    func islandInnerCard() -> some View {
        modifier(IslandInnerCardChrome())
    }
}

private struct IslandInnerCardChrome: ViewModifier {
    @Environment(\.displayScale) private var displayScale

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: IslandLayout.innerCardCorner, style: .continuous)
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.cardSurface, in: shape)
            .overlay(shape.strokeBorder(Theme.hairlineElevated, lineWidth: 1 / displayScale))
    }
}

/// Reads whether the island's pointer (`dispatchPillPointer`) is over this view — a row's or an option's hover state,
/// with no monitor of its own (no pointer, as in the offscreen gallery: never hovered).
struct IslandPointerReader<Content: View>: View {
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.dispatchPillPointer) private var pointer

    var body: some View {
        if let pointer {
            IslandPointerTracking(pointer: pointer, content: content)
        } else {
            content(false)
        }
    }
}

/// Reads WHERE the island's pointer is (`dispatchPillPointer`, in `DispatchPillView.canvasSpace`) — for a view that
/// follows it, like a plan line's marker; nil outside the island's panels (no pointer: the window, the gallery) or when
/// the pointer is off the panel.
struct IslandPointerLocationReader<Content: View>: View {
    @ViewBuilder let content: (CGPoint?) -> Content
    @Environment(\.dispatchPillPointer) private var pointer

    var body: some View {
        if let pointer {
            IslandPointerLocationTracking(pointer: pointer, content: content)
        } else {
            content(nil)
        }
    }
}

private struct IslandPointerLocationTracking<Content: View>: View {
    @ObservedObject var pointer: DispatchPillPointer
    let content: (CGPoint?) -> Content

    var body: some View { content(pointer.location) }
}

private struct IslandPointerTracking<Content: View>: View {
    @ObservedObject var pointer: DispatchPillPointer
    let content: (Bool) -> Content
    @State private var frame: CGRect = .zero

    var body: some View {
        content(pointer.location.map { frame.contains($0) } ?? false)
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(DispatchPillView.canvasSpace))
            } action: { frame = $0 }
    }
}
