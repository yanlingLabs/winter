import SwiftUI
import NormaProtocol

/// Cards for approvals/questions/plans — PURE UI: consumes one `InteractionRecord` (the reducer's
/// per-exchange record of an ask and, once it lands, its outcome) plus injected response closures.
///
/// Mounted INLINE IN THE TRANSCRIPT (`TranscriptExchangeRow`, `ChatContent/TranscriptView.swift`),
/// at the point the ask was made, and never removed — mac-chat-parity Task 3. It used to be a
/// pinned band between the transcript and the composer, deleted the instant the ask resolved, which
/// left the Mac with no record anywhere in scrollback of anything the user had approved or
/// answered. A resolved card now freezes in place carrying what was decided.
///
/// No `repeatForever`/looping animation anywhere below, and none may be added: the transcript is
/// rendered under the orb morph's `scaleEffect`/`blur`/`opacity`
/// (`WindowSurfaceView.swift` → `WindowContentView`), where a repeating animation compounds with the
/// morph.
///
/// **Colour is `Theme`'s since mac-chat-parity Task 8** — same convention as
/// `TranscriptMessageViews.swift`, no forced white, no `GlassForegroundLegibility`. Two notes on
/// what that did and did not change: the accent chrome was SwiftUI's own app accent, which resolves
/// to the *user's System Settings accent* because `docs/brand.md` § 3.2 leaves the global accent name
/// unset — so a selected option used to be drawn in whatever colour the Mac's owner had picked, and
/// is now Norma's teal. And a card is CHROME: its text stays sans, including a plan's markdown body,
/// which is why both plan bodies pass `TranscriptAssistantMessage` the `.sans` role explicitly.

/// Everything a transcript-mounted card needs from its surface, bundled so `TranscriptExchangeRow`
/// keeps taking values and closures rather than the adapter itself — the same "value/closure, not
/// the object" shape the composer's `draftBinding` already follows, and what keeps the transcript
/// rows pure functions of their inputs.
struct InteractionCardWiring {
    /// callIds with a respond RPC currently awaiting — the card's "Sending…" state.
    let inFlight: Set<String>
    /// callId → inline error text from a failed respond RPC.
    let errorLines: [String: String]
    /// panel-shell T10b: a live `Binding` onto callId's `PendingCardDraft`. Built by the caller off
    /// `FieldStateAdapter.pendingCardDraftBinding(for:)`, so the getter/setter always dereference
    /// the LIVE adapter (never a snapshot taken at a view's own construction time) — see that
    /// method's own doc. This matters more inline than it did in the band: transcript rows live in a
    /// `LazyVStack` and are recycled freely, and view-local `@State` would lose a typed answer every
    /// time a card scrolled out of view.
    let draftBinding: (String) -> Binding<PendingCardDraft>
    let onApproval: (String, Bool, String?, String?) -> Void  // callId, approved, optionId, childSessionId
    let onQuestion: (String, [String: String], [String: String], String?) -> Void  // callId, answers, notes (both keyed by question text), childSessionId
    let onPlan: (String, Bool, Bool, String?) -> Void   // callId, approved, autoAccept, feedback
}

// MARK: - panel-shell T10b: PendingCardDraft — the hoisted, externally-owned per-card answer

/// A pending question/plan card's typed-but-unsubmitted answer. Mirrors
/// `FieldStateAdapter.composerDraft`'s precedent exactly: `PendingQuestionBody`/`PendingPlanBody`
/// used to hold this as view-local `@State`, which `ShellRootView`'s `if mode != .maximized {
/// detail }` silently destroys every time the panel is maximized or un-maximized (`detail` — and
/// everything inside it — is torn down and rebuilt, and `@State`'s storage does not survive a
/// view's identity leaving the hierarchy). Stored externally instead
/// (`FieldStateAdapter.pendingCardDrafts`, keyed by the composite `sessionId|callId` key —
/// `pendingCardDraftKey(sessionId:callId:)` — since `pendingInteractions` is a list, so more
/// than one card can be open at once, and a bare callId has no cross-session uniqueness
/// guarantee), which is what makes it survive.
///
/// Mutation lives HERE as methods, not scattered across the view's closures, so the
/// mutual-exclusion rules — selecting an option clears that question's Other text; typing Other
/// text clears that question's selection — are independently unit-testable
/// (`PendingCardsTests`) without mounting any view, the same "PURE logic, tested directly"
/// convention this file's own `questionAnswers`/`questionCardComplete` already follow.
struct PendingCardDraft: Equatable {
    var selections: [Int: Set<Int>] = [:]
    var otherTexts: [Int: String] = [:]
    var otherExpanded: Set<Int> = []
    var notes: [Int: String] = [:]
    /// The plan card's own two fields — untouched by anything above, which only questions read.
    var isRequestingChanges: Bool = false
    var feedback: String = ""
    /// The APPROVAL card's "Show more" disclosure. Hoisted here for the same reason everything else
    /// in this struct was, and one the band never exposed: `PendingApprovalBody` held it as view-
    /// local `@State`, which was safe in a plain `VStack` band but is not in the transcript's
    /// `LazyVStack`. Rows there are recycled freely, so expanding a long summary, scrolling away and
    /// scrolling back silently collapsed it — and with `ForEach`'s index-keyed identity
    /// (`TranscriptView`), a recycled row could inherit a NEIGHBOUR's expansion state. Same hazard
    /// `InteractionCardWiring.draftBinding`'s doc names for typed answers; approvals simply had a
    /// second piece of state nobody had moved yet.
    var isSummaryExpanded: Bool = false

    /// Single-select an option — mirrors `PendingQuestionBody`'s old `onSelectSingle` closure.
    mutating func selectSingle(_ optionIndex: Int, forQuestion index: Int) {
        selections[index] = [optionIndex]
        otherTexts[index] = ""
    }

    /// Multi-select toggle — same Other-clearing rule as `selectSingle`.
    mutating func toggleMulti(_ optionIndex: Int, forQuestion index: Int) {
        var current = selections[index] ?? []
        if current.contains(optionIndex) { current.remove(optionIndex) } else { current.insert(optionIndex) }
        selections[index] = current
        otherTexts[index] = ""
    }

    mutating func expandOther(forQuestion index: Int) {
        otherExpanded.insert(index)
    }

    /// Typing Other text clears that question's selection — the reverse mutual exclusion.
    mutating func setOtherText(_ text: String, forQuestion index: Int) {
        otherTexts[index] = text
        selections[index] = []
    }

    mutating func setNote(_ text: String, forQuestion index: Int) {
        notes[index] = text
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

/// A header-less question is chat's SIMPLIFIED card (Slice B1): question + labels + Other, nothing
/// else. `header == nil` is the wire signal — chat's `AskQuestion` omits it, code's `ask_user`
/// always sends one (see `SessionEvent.Question.header`'s own doc in NormaProtocol).
func questionIsSimplified(_ q: SessionEvent.Question) -> Bool { q.header == nil }

/// The ≤12-char chip only ever made sense as a disambiguator between questions in a multi-question
/// card. Previously this was `questions.count > 1` alone at the call site — correct for code mode
/// by ARITHMETIC (`AskQuestion` always emits exactly one question, so the chip was already
/// suppressed), but it would show an empty/blank chip for a header-less question that somehow rode
/// in a multi-question card. Gate on BOTH, so the suppression is by INTENT, not coincidence.
func questionShowsHeaderChip(_ q: SessionEvent.Question, questionCount: Int) -> Bool {
    questionCount > 1 && q.header != nil
}

/// Notes ("Add a note (optional)") are a code-mode (`ask_user`) affordance; chat's simplified card
/// has none. Do NOT delete the notes code itself — code mode still relies on it; this only gates
/// whether it's shown.
func questionAllowsNotes(_ q: SessionEvent.Question) -> Bool { !questionIsSimplified(q) }

/// Per-kind card header text. Approval names the tool; a question card titles itself after its
/// FIRST question's `header` (a batch ask's later questions render their own `question` text
/// inline in the body — see `PendingQuestionBody`); a plan card's title is fixed (the plan text
/// itself, not a header field, is the body).
///
/// Branch review FIX 2: for a SIMPLIFIED (header-less) question card, `showsCardTitleRow` below
/// suppresses this function's only call site entirely — `QuestionBlock.body` already renders
/// `question.question` unconditionally, so also putting it in the title row duplicated it (and did
/// so with no `.lineLimit` and no length cap: `question` has none, unlike `header`'s ≤12 chars).
/// This function's header-less fallback is kept CORRECT regardless (it is simply unreached for
/// that card type today) — do not delete it or let it regress to an empty string.
func cardTitle(_ ask: InteractionRecord.Ask) -> String {
    switch ask {
    case .approval(let toolName, _, _, _):
        return "Approval needed — \(toolName)"
    case .question(let questions):
        // A header-less card (Slice B1's simplified `AskQuestion`) must not render an EMPTY title
        // bar — fall back to the question text itself, same signal `questionIsSimplified` reads.
        guard let first = questions.first else { return "" }
        return first.header ?? first.question
    case .plan:
        return "Plan for approval"
    }
}

/// Whether the card's OWN title row (glyph + `cardTitle`) renders at all. False ONLY for a
/// simplified (header-less) question card — approval/plan cards and code mode's headered question
/// cards are unaffected (title row shown, byte-identical to before this fix). Extracted as a pure,
/// exported predicate (mirrors `questionIsSimplified`/`questionShowsHeaderChip` above) so the fix
/// is unit-testable without mounting a view, and so `TranscriptInteractionCard.body`'s gate and any test asserting
/// it read the exact same decision.
func showsCardTitleRow(_ ask: InteractionRecord.Ask) -> Bool {
    guard case .question(let questions) = ask, let first = questions.first else { return true }
    return !questionIsSimplified(first)
}

/// The approval card's ADDITIONAL option rows — every option the daemon sent EXCEPT the two the
/// card's own primary Approve/Deny buttons already are (`allow_once`, `deny`). Rendered as the quiet
/// row below those buttons.
///
/// working-directories T7/T8: this used to filter on `rule != nil` ("rule-bearing options only"),
/// which was correct while every extra option WAS rule-bearing — the SP-approvals allow_project/
/// allow_global shapes. T6.5's `allow_add_dir` ("Allow and add as working directory", third option
/// on the with-dirs dirGrant card) carries NO rule: it adopts a directory into the session's
/// working-directory set, which is a session fact rather than a persisted permission rule. So the
/// old filter dropped it, and the one card option that widens a session's write fence deliberately
/// was UNREACHABLE from this app — the same hole T7 closed on the TUI side (`additionalOptions` in
/// `packages/cli/src/tui/pending-cards.tsx`), and closed here the same way, by EXCLUSION rather than
/// by enumerating which shapes count.
///
/// Excluding by id is what keeps this correct for options nobody has written yet: a new
/// rule-less option gets an affordance for free, while `allow_once`/`deny` stay exactly where they
/// are (the primary row, no `optionId` — byte-identical to before). Pure and exported so
/// `PendingCardsTests` can drive the rule directly, since `PendingApprovalBody` is a private view.
func approvalAdditionalOptions(_ options: [SessionEvent.ApprovalOption]?) -> [SessionEvent.ApprovalOption] {
    (options ?? []).filter { $0.id != "allow_once" && $0.id != "deny" }
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

/// The SF Symbol shown in every card's header. These were the literal characters `⚠`/`?`/`☰` until
/// mac-chat-parity Task 3 — the most obviously unfinished thing about the Mac's cards, since a
/// literal glyph takes the text font's metrics and weight instead of the symbol vocabulary every
/// other affordance in the window uses. `hand.raised.fill` is the symbol iOS's own `ApprovalRowView`
/// carries; the other two are its nearest equivalents for surfaces iOS has no twin for. Pure and
/// exported so the choice is unit-testable, the same convention as `activityGlyphAndLabel`.
func cardGlyphSymbol(_ ask: InteractionRecord.Ask) -> String {
    switch ask {
    case .approval: return "hand.raised.fill"
    case .question: return "questionmark.circle.fill"
    case .plan: return "list.bullet.rectangle"
    }
}

// MARK: - Selection chrome (mac-chat-parity Task 3 — defect 2)

/// The glyph for one option row, honest about the question's arity: a circle for single-select
/// (pick one) and a square for multi-select (pick any), filled with a checkmark when chosen. iOS's
/// rule (`QuestionCardView`'s option row) and, before Task 3, one the Mac only half-kept — a
/// multi-select option had `checkmark.square.fill`/`square`, and a single-select option had NO
/// GLYPH AT ALL.
func optionSelectionGlyph(multiSelect: Bool, isSelected: Bool) -> String {
    if multiSelect { return isSelected ? "checkmark.square.fill" : "square" }
    return isSelected ? "checkmark.circle.fill" : "circle"
}

/// The resting-vs-selected chrome of an option row. Before mac-chat-parity Task 3 a single-select
/// option had NO selected state whatsoever — no glyph, no fill, no border, no weight change — so
/// the only evidence a choice had registered was the Submit button enabling. That is closer to a
/// bug than a style gap: the user could not see what they had picked before submitting.
///
/// iOS's shape, adopted: an unselected row has NO resting chrome at all (no border, no fill —
/// a list of bordered boxes reads as five equally-shouting buttons), and selection alone paints it.
/// Expressed as a value rather than inline view modifiers so the decision is unit-testable without
/// mounting a view, and so removing the selected branch is a test failure rather than an invisible
/// regression.
struct OptionSelectionChrome: Equatable {
    /// Opacity of the accent fill behind the row. `0` means no fill is drawn at all.
    let fillOpacity: Double
    /// Width of the accent border. `0` means no border is drawn at all.
    let strokeWidth: Double
    /// Whether the option's own label is emboldened.
    let isBold: Bool

    static let resting = OptionSelectionChrome(fillOpacity: 0, strokeWidth: 0, isBold: false)
    static let selected = OptionSelectionChrome(fillOpacity: 0.15, strokeWidth: 1.5, isBold: true)
}

func optionSelectionChrome(isSelected: Bool) -> OptionSelectionChrome {
    isSelected ? .selected : .resting
}

// MARK: - Resolved outcomes (mac-chat-parity Task 3 — defect 1)

/// Which of a question's options a RECORDED answer names — the frozen card's way of marking what
/// was chosen, months later, from nothing but the persisted `question_resolved.answers` string.
///
/// It is the exact inverse of `questionAnswers`, and is written against that function's own three
/// productions rather than guessed at: a single-select answer is one option's `label` verbatim; a
/// multi-select answer is several labels `", "`-joined in option order; an "Other…" answer is
/// free text that matches no option. Whole-string match is tried FIRST so a label that itself
/// contains `", "` is recognised rather than shredded by the split.
///
/// An answer that matches nothing is `.freeText`, never dropped — the record must show what was
/// actually sent even when the options it was sent against have no matching entry.
enum ResolvedAnswer: Equatable {
    /// Indices into the question's own `options`, ascending.
    case options([Int])
    case freeText(String)
    /// No answer was recorded for this question. Reachable on a `.ended` card, and on a resolution
    /// whose `answers` dict simply has no entry for this question's text.
    case none
}

func resolvedAnswer(for question: SessionEvent.Question, answer: String?) -> ResolvedAnswer {
    guard let answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .none }
    if let exact = question.options.firstIndex(where: { $0.label == answer }) {
        return .options([exact])
    }
    let parts = answer.components(separatedBy: ", ")
    if parts.count > 1 {
        let matched = parts.compactMap { part in question.options.firstIndex(where: { $0.label == part }) }
        if matched.count == parts.count { return .options(matched.sorted()) }
    }
    return .freeText(answer)
}

/// The frozen approval/plan card's outcome line — symbol, wording, and whether it reads as an
/// affirmative. Pure so the exact vocabulary is pinned by tests rather than by reading the view.
///
/// A timeout is the case worth naming: the daemon's `ApprovalBroker` fails closed with
/// `{approved: false, by: "timeout"}` (`packages/core/src/agent/approvals.ts`), which IS a denial —
/// but one nobody made. It must not read as "you denied this".
struct InteractionOutcomeLabel: Equatable {
    let symbol: String
    let text: String
    /// True only for an outcome the user affirmatively granted — drives the one green in the card.
    let isAffirmative: Bool
}

func outcomeLabel(_ outcome: InteractionRecord.Outcome) -> InteractionOutcomeLabel {
    switch outcome {
    case .approval(let approved, let by):
        if approved { return .init(symbol: "checkmark.seal.fill", text: "Approved", isAffirmative: true) }
        if by == "timeout" { return .init(symbol: "clock.badge.xmark", text: "Denied — timed out", isAffirmative: false) }
        return .init(symbol: "nosign", text: "Denied", isAffirmative: false)
    case .plan(let approved, let autoAccept, _, _):
        if approved {
            return .init(symbol: "checkmark.seal.fill",
                         text: autoAccept ? "Approved — auto-accepting edits" : "Approved",
                         isAffirmative: true)
        }
        return .init(symbol: "arrow.uturn.backward", text: "Changes requested", isAffirmative: false)
    case .question(_, _, let by):
        if by == "timeout" { return .init(symbol: "clock.badge.xmark", text: "Timed out", isAffirmative: false) }
        return .init(symbol: "checkmark.circle.fill", text: "Answered", isAffirmative: true)
    case .ended:
        // The turn ended with this ask outstanding — see `InteractionRecord.Outcome.ended`. Says
        // that nothing was recorded rather than claiming a decision nobody made.
        return .init(symbol: "clock.badge.xmark", text: "Ended with no response", isAffirmative: false)
    }
}

/// Whether a card draws its inline respond-error line — only while it is still PENDING, and that
/// gate has to exist now that cards are permanent.
///
/// `FieldStateAdapter.interactionErrors[callId]` is set on a failed respond RPC and cleared only at
/// the START of the next attempt for that callId. Nothing clears it on resolve, because until
/// mac-chat-parity Task 3 nothing had to: the card was deleted and took the line with it. A card
/// that lives forever does not have that luxury — a respond that failed and was then resolved some
/// other way (the broker's fail-closed timeout, or the phone answering it) would print "couldn't
/// send — try again" into the permanent record, beside the outcome, as advice nobody can act on.
///
/// An error is a fact about an attempt in flight, and a frozen card makes no attempts.
func showsInteractionErrorLine(_ record: InteractionRecord, hasError: Bool) -> Bool {
    hasError && interactionIsPending(record)
}

/// The provenance line under a frozen card — iOS's "answered by …" footer. `nil` when there is
/// nobody to name (an ask that simply ended), so the card shows no dangling attribution.
///
/// `by` is whatever the responding client called itself (`"orb"`, `"iphone-gateway"`, `"cli-chat"`,
/// a routine) — or the daemon's own `"timeout"` sentinel, whose wording says what actually happened
/// instead of attributing the decision to a person.
func interactionProvenance(_ outcome: InteractionRecord.Outcome) -> String? {
    let by: String
    switch outcome {
    case .approval(_, let value), .question(_, _, let value), .plan(_, _, _, let value): by = value
    case .ended: return nil
    }
    if by == "timeout" { return "no answer before the deadline — resolved by timeout" }
    return "answered by \(by)"
}

// MARK: - Card chrome

/// One card in the transcript: SF-Symbol kind glyph + title header, per-kind body, optional inline
/// error line — a rounded-12 `Theme.elevatedSurface` section (mac-chat-parity Task 8), which is the
/// token `docs/brand.md` § 1 names for "tool output, approval cards — one step above the card".
/// The transcript's tool-output blocks sit on the same fill, one plane above the content side's
/// `Theme.cardSurface`.
///
/// **Pending and frozen are two different subtrees, not one subtree behind a flag.** The frozen
/// bodies below declare no `Button` and no `TextField` of their own, and — the part that actually
/// carries the guarantee — `resolvedBody` is handed NO wiring closures at all, so there is no
/// `onApproval`/`onQuestion`/`onPlan` in scope for a frozen card to call. A resolved card cannot
/// re-answer its ask even by mistake: the capability is absent, not disabled, and no `isResolved`
/// parameter exists for a future edit to forget to thread through a new affordance.
///
/// **What that does NOT say, precisely:** a frozen card is not free of every control. A frozen PLAN
/// composes `TranscriptAssistantMessage`, and any fenced code block inside it renders
/// `TranscriptCodeBlock`'s own copy button, which `isStreaming` does not gate (only the
/// message-level copy button is gated — `TranscriptMessageViews.swift`). So a frozen plan containing
/// a code fence carries live copy buttons TODAY. That is acceptable and stays: copying a plan is not
/// responding to it, and the requirement is that the ask cannot be re-answered. It is written down
/// because `testFrozenBodiesContainNoInteractiveAffordance` scans DECLARATIONS and cannot see
/// through composition — the claim it checks is narrower than the sentence above, and this is the
/// gap between them.
///
/// The branch is `interactionIsPending(record)` — i.e. `record.outcome == nil` — and nothing else.
/// The reducer guarantees that predicate goes false the moment the daemon stops waiting on the ask,
/// whether it was answered, timed out, or outlived its turn (`endOutstandingInteractions`).
struct TranscriptInteractionCard: View {
    let record: InteractionRecord
    let wiring: InteractionCardWiring

    private var isInFlight: Bool { wiring.inFlight.contains(record.callId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Branch review FIX 2: a simplified (header-less) question card suppresses this whole
            // row — the question already renders exactly once in the body (QuestionBlock's
            // unconditional Text(question.question)); showing it here too would duplicate it.
            if showsCardTitleRow(record.ask) {
                HStack(spacing: 6) {
                    Image(systemName: cardGlyphSymbol(record.ask))
                        .foregroundStyle(.secondary)
                    Text(cardTitle(record.ask))
                        .foregroundStyle(.primary)
                }
                .font(.system(size: 13, weight: .semibold))
            }

            if let outcome = record.outcome {
                resolvedBody(outcome)
            } else {
                pendingBody
            }

            if let errorLine = wiring.errorLines[record.callId],
               showsInteractionErrorLine(record, hasError: true) {
                Text(errorLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(InteractionCardChrome())
    }

    @ViewBuilder
    private var pendingBody: some View {
        switch record.ask {
        case .approval(_, let summary, let reviewerReason, let options):
            PendingApprovalBody(callId: record.callId, summary: summary, reviewerReason: reviewerReason, childSessionId: record.childSessionId, options: options, isInFlight: isInFlight, onApproval: wiring.onApproval, draft: wiring.draftBinding(record.callId))
        case .question(let questions):
            PendingQuestionBody(callId: record.callId, questions: questions, childSessionId: record.childSessionId, isInFlight: isInFlight, onQuestion: wiring.onQuestion, draft: wiring.draftBinding(record.callId))
        case .plan(let plan):
            PendingPlanBody(callId: record.callId, plan: plan, isInFlight: isInFlight, onPlan: wiring.onPlan, draft: wiring.draftBinding(record.callId))
        }
    }

    @ViewBuilder
    private func resolvedBody(_ outcome: InteractionRecord.Outcome) -> some View {
        switch record.ask {
        case .approval(_, let summary, let reviewerReason, _):
            ResolvedApprovalBody(summary: summary, reviewerReason: reviewerReason, outcome: outcome)
        case .question(let questions):
            ResolvedQuestionBody(questions: questions, outcome: outcome)
        case .plan(let plan):
            ResolvedPlanBody(plan: plan, outcome: outcome)
        }
    }
}

/// The outcome line every frozen card ends with — symbol + verdict, then the quiet provenance line.
/// One view rather than three copies, since the vocabulary is already decided by the pure
/// `outcomeLabel`/`interactionProvenance` pair.
private struct ResolvedOutcomeRow: View {
    let outcome: InteractionRecord.Outcome

    var body: some View {
        let label = outcomeLabel(outcome)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: label.symbol)
                Text(label.text)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(label.isAffirmative ? Color.green : Color.secondary)

            if let provenance = interactionProvenance(outcome) {
                Text(provenance)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

/// A hairline between two questions in one card — iOS's separator for a multi-question block, which
/// the Mac's separator-less stacked blocks left the reader to infer from spacing alone. A true
/// hairline (1 device pixel via `displayScale`), not a 1pt rule, so it reads as a division rather
/// than a border. `Theme.hairlineElevated` (mac-chat-parity Task 8 fix round 1) in place of a
/// `Color.primary` × 0.08, which had no way to be tuned per appearance.
///
/// **It is the ELEVATED token, not the shell's `hairline`, and that distinction is the whole point
/// of the fix round.** This rule is drawn on the card's `Theme.elevatedSurface` fill, one plane
/// above the ground `hairline` is defined against, where `hairline` measures **1.040:1 in dark** —
/// so a separator introduced precisely because "stacked blocks left the reader to infer from
/// spacing alone" was very nearly back to nothing. `hairlineElevated` measures 1.313 / 1.312 there.
/// Pinned by `TranscriptBrandTests.testTheElevatedHairlineActuallySeparatesOnItsOwnPlane`.
private struct QuestionSeparator: View {
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle()
            .fill(Theme.hairlineElevated)
            .frame(height: 1 / displayScale)
    }
}

// MARK: - Frozen (resolved) bodies — NO Button, NO TextField, by construction

/// What was asked, and what was decided. The audit record: a reader scrolling back months later
/// sees the command that needed approval and the verdict on it, in the place the agent asked.
///
/// The summary keeps the pending card's monospaced register (it is usually a shell command) but not
/// its "Show more" toggle — that is a `Button`, and a frozen card has none. Capped at 8 lines with
/// middle truncation instead: `approval_requested.summary` has no wire cap
/// (`packages/protocol/src/events.ts` caps it "at the writer, not the schema"), and an unbounded
/// record would let one pathological ask own the scrollback. 8 lines clears every summary the
/// daemon composes in practice; the whole text is readable while the card is still pending.
/// panel-shell T10b precedent: internal rather than `private` so `InteractionCardTests` can
/// construct it and prove — via `Mirror` — that it holds no respond closure, the same reason
/// `PendingQuestionBody`/`PendingPlanBody` were widened.
struct ResolvedApprovalBody: View {
    let summary: String
    let reviewerReason: String?
    let outcome: InteractionRecord.Outcome

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(8)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if let reviewerReason {
                Label("reviewer: \(capReviewerReason(reviewerReason))", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            ResolvedOutcomeRow(outcome: outcome)
        }
    }
}

/// Each question with the answer that was recorded for it, marked. Deliberately shows the CHOSEN
/// options only, not the whole menu with one mark somewhere in it — iOS's resolved shape, and the
/// more legible one for an audit trail: "Which port? · 8080" is read at a glance, where five rows
/// with a mark on the fourth has to be scanned. The unchosen options were a decision aid; the
/// decision is what the record is for.
///
/// The preview pane goes with them for the same reason (and takes a nested `ScrollView` out of the
/// transcript's own scroll view along the way).
/// panel-shell T10b precedent: internal rather than `private` so `InteractionCardTests` can
/// construct it and prove — via `Mirror` — that it holds no respond closure, the same reason
/// `PendingQuestionBody`/`PendingPlanBody` were widened.
struct ResolvedQuestionBody: View {
    let questions: [SessionEvent.Question]
    let outcome: InteractionRecord.Outcome

    /// The recorded `answers`/`notes`, or empty dicts for an `.ended` card (asked, never answered).
    private var recorded: (answers: [String: String], notes: [String: String]) {
        if case .question(let answers, let notes, _) = outcome { return (answers, notes) }
        return ([:], [:])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                if index > 0 { QuestionSeparator() }
                VStack(alignment: .leading, spacing: 6) {
                    if questionShowsHeaderChip(question, questionCount: questions.count) {
                        Text(question.header ?? "")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    // Norma's voice, so it wears Norma's voice — the assistant-prose serif register
                    // (`brand.md` § 4, binding #4), which iOS applies here for the same stated
                    // reason. Not a new serif binding: a question IS assistant prose, and Task 8
                    // shipped that register for exactly this. The ANSWER below stays sans — it is
                    // the user's word, and the two registers are what make the card read as a
                    // dialogue rather than a form.
                    Text(question.question)
                        .font(Font(Theme.assistantProse(size: 14, weight: .regular)))
                        .foregroundStyle(.primary)

                    answerRows(for: question)

                    if let note = recorded.notes[question.question], !note.isEmpty {
                        Text(note)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // iOS's resolved question card carries NO footer (`classicCard`: `if !isResolved
            // { footer }`), and for an ANSWERED question that is right — the answer rows above
            // already say what was decided, so "✓ Answered" restated it and "answered by orb"
            // named a door the user had just used. Both were noise on the one card whose content
            // IS the outcome.
            //
            // It stays for `.ended`, the case iOS's blanket rule loses: a question asked and never
            // answered has nothing in its answer rows but a "—", and this row is the only thing
            // that says whether it timed out, was cancelled, or died with its turn. Approvals and
            // plans keep theirs unconditionally — there the outcome IS the information, and
            // `ResolvedApprovalBody`/`ResolvedPlanBody` are untouched.
            if case .question = outcome {} else {
                ResolvedOutcomeRow(outcome: outcome)
            }
        }
    }

    @ViewBuilder
    private func answerRows(for question: SessionEvent.Question) -> some View {
        switch resolvedAnswer(for: question, answer: recorded.answers[question.question]) {
        case .options(let indices):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(indices, id: \.self) { optionIndex in
                    if question.options.indices.contains(optionIndex) {
                        // A PLAIN `checkmark`, not `optionSelectionGlyph`'s circle/square — iOS's
                        // frozen row drops the single/multi distinction deliberately, and it is
                        // right to: the shape of the control mattered while it was a control. On a
                        // record, every listed row means one thing, "this was chosen". The pending
                        // box still calls `optionSelectionGlyph`, which is where the distinction
                        // still does work.
                        chosenRow(glyph: "checkmark", text: question.options[optionIndex].label)
                    }
                }
            }
        case .freeText(let text):
            // The "Other…" path — the user typed something the menu did not offer. `pencil` is the
            // same glyph iOS puts on its Other field, so the record says HOW it was answered.
            chosenRow(glyph: "pencil", text: text)
        case .none:
            Text("—")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
        }
    }

    /// The frozen answer row in **iOS's grammar** (`norma-ios` `QuestionCardView.resolvedAnswerRow`):
    /// the answer LEADS in the card's own text register and the accent mark TRAILS in a reserved
    /// slot — no pill, no fill, no bold.
    ///
    /// The pending box keeps `OptionSelectionChrome`'s filled pill, and that asymmetry is the point:
    /// there, the fill means "tap target, currently chosen". A frozen row has nothing to tap, so the
    /// same fill read as an affordance for a decision already made. iOS draws exactly this line
    /// between its two costumes, and its own comment says the two are "expected to diverge".
    ///
    /// SIZES STAY THE MAC'S OWN — `brand.md` beats iOS on values (spec §7); only the shape is
    /// iOS's. The reserved trailing slot is 20pt here rather than iOS's 32 because this card's
    /// horizontal rhythm is 10/12pt, not the phone's 16.
    private func chosenRow(glyph: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Image(systemName: glyph)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.accent)
                .frame(width: 20, alignment: .center)
                .accessibilityHidden(true)   // decorative; the answer text carries the meaning
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
    }
}

/// The interaction card's surface — iOS's floating-card recipe (`norma-ios`
/// `QuestionCardView.QuestionCardChrome`), ported: a **`CardSurface`** fill, a hairline rim, and a
/// soft shadow, so the card FLOATS on the transcript instead of being a block cut into it.
///
/// It used to be `ElevatedSurface` at r=12 with no rim and no shadow, and that was the single
/// loudest difference from iOS — because of the FILL, not the geometry. `ElevatedSurface`'s light
/// value is `#F2F2F7`, which `brand.md` § 1 names for what it is: *"a retained cool system grey"*.
/// Every other Mac surface is warm (`Canvas #F5F4F0`, `CardSurface #F9F9F7`, `ControlSurface
/// #F0EFEC`); that one is not, and a cool grey block on a warm cream canvas reads **lavender**.
/// It was never chosen — "retained" is the palette's own word for inherited.
///
/// Why the rim and the shadow are not decoration: `CardSurface` on the transcript's own ground is
/// nearly the same value, so without them the card would have no edge at all. iOS needs the same
/// two for the same reason. The rim is `HairlineElevated` rather than `Color.primary.opacity(0.17)`
/// — iOS's literal — because Task 8 already solved that token for exactly this job: a floating
/// control's rim measured against `CardSurface` (1.389:1 light / 1.431:1 dark, `brand.md` § 1).
///
/// r=16, not iOS's 28: that radius is a phone-scale value on a full-bleed card. The Mac's card sits
/// in a wider column at a greater viewing distance, and `brand.md` § 1's own note about the sidebar
/// register covers the principle — same binding, two platform registers.
private struct InteractionCardChrome: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Theme.cardSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Theme.hairlineElevated, lineWidth: 1)
            )
            .compositingGroup()   // flatten first: the shadow outlines the CARD, not every glyph
            .shadow(color: .black.opacity(0.05), radius: 8, y: 1)
    }
}

/// The plan that was presented, and what was decided about it. Keeps the pending card's markdown
/// rendering and its ~260pt scroll cap — a plan is long by nature, and the record of one has to
/// still be the plan.
/// panel-shell T10b precedent: internal rather than `private` so `InteractionCardTests` can
/// construct it and prove — via `Mirror` — that it holds no respond closure, the same reason
/// `PendingQuestionBody`/`PendingPlanBody` were widened.
struct ResolvedPlanBody: View {
    let plan: String
    let outcome: InteractionRecord.Outcome

    private var feedback: String? {
        if case .plan(_, _, let feedback, _) = outcome, let feedback, !feedback.isEmpty { return feedback }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                // `isStreaming: true` on a plan that is emphatically NOT streaming is load-bearing,
                // not a copy-paste: it is how `TranscriptAssistantMessage` suppresses its trailing
                // MESSAGE-level copy button.
                //
                // It does not suppress everything. A fenced code block inside the plan routes to
                // `TranscriptCodeBlock`, whose own copy button is NOT gated on this flag
                // (`TranscriptMessageViews.swift`) — so a frozen plan containing a code fence
                // already carries live copy buttons and their 1.2s revert timers. Deliberately left
                // alone: copying a plan is not responding to it, and this card's requirement is that
                // the ask cannot be RE-ANSWERED, which holds because `resolvedBody` is handed no
                // respond closures at all.
                //
                // What this line is worth guarding is narrower than it looks, then: flipping the
                // flag would add the message-level copy button too, with no test going red, because
                // the declaration scan cannot see through composition. Named, not relied upon.
                TranscriptAssistantMessage(text: plan, isStreaming: true, role: .sans)
            }
            .frame(maxHeight: 260)

            if let feedback {
                Text(feedback)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            ResolvedOutcomeRow(outcome: outcome)
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
    /// mirroring `SessionEvent.ApprovalRequested.options` (Task 5's `approvalOptionsFor`). Every
    /// entry EXCEPT `allow_once`/`deny` feeds `additionalOptions` below (working-directories T8 —
    /// see `approvalAdditionalOptions` for why this became an exclusion): those two are already the
    /// primary Approve/Deny buttons and would just duplicate them. `nil`, or an array holding only
    /// those two, renders this card byte-identical to before this task.
    let options: [SessionEvent.ApprovalOption]?
    let isInFlight: Bool
    let onApproval: (String, Bool, String?, String?) -> Void  // callId, approved, optionId, childSessionId
    /// The "Show more" disclosure — externally owned, NOT view-local `@State`. See
    /// `PendingCardDraft.isSummaryExpanded` for why the transcript's `LazyVStack` makes that
    /// mandatory rather than tidy.
    @Binding var draft: PendingCardDraft

    private var mightOverflowThreeLines: Bool {
        summary.count > 150 || summary.filter { $0 == "\n" }.count >= 3
    }

    /// The quiet row's options — see `approvalAdditionalOptions` (the pure, tested rule).
    private var additionalOptions: [SessionEvent.ApprovalOption] {
        approvalAdditionalOptions(options)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(draft.isSummaryExpanded ? nil : 3)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if mightOverflowThreeLines {
                Button(draft.isSummaryExpanded ? "Show less" : "Show more") {
                    draft.isSummaryExpanded.toggle()
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

            if isInFlight {
                // mac-chat-parity Task 3: the buttons are REPLACED, not merely disabled. A disabled
                // row said nothing about why (the card's only in-flight signal used to be that the
                // buttons had gone grey), and replacing them also removes the double-tap surface
                // entirely rather than relying on the disable landing first. iOS's `.sending` state.
                Label("Sending…", systemImage: "hourglass")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            } else {
                // Primary row — Approve is still plain allow-once (spec §5: "default button = Allow
                // once"), Deny still bare deny; neither carries an optionId. Rule-writing choices
                // are deliberate clicks on the quiet row below, never folded into these two.
                //
                // Equal width (mac-chat-parity Task 3): natural-width AppKit buttons made "Approve"
                // and "Deny" different sizes, so the pair read as a primary action with an
                // afterthought beside it. A decision with two real answers gets two equal targets;
                // exactly one of them is prominent.
                HStack(spacing: 8) {
                    Button("Approve") { onApproval(callId, true, nil, childSessionId) }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                    Button("Deny") { onApproval(callId, false, nil, childSessionId) }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.small)

                // SP-approvals T6: one quiet button per additional option, below the primary row —
                // `.plain` + secondary/small text, same "quiet" convention as the "Show more" toggle
                // above, so a rule-writing (or fence-widening) choice never reads as visually equal
                // to Approve/Deny. Labels render verbatim (the daemon already composes the exact
                // rule string — or, for `allow_add_dir`, the exact adoption wording — into them).
                if !additionalOptions.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(additionalOptions, id: \.id) { option in
                            Button(option.label) { onApproval(callId, true, option.id, childSessionId) }
                                .buttonStyle(.plain)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
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
/// panel-shell T10b: widened from `private` to internal — the SAME reason
/// `WindowContentView.showingDirsMenu`/`showingActivityMenu` were widened (see those properties'
/// own doc): a cross-file consumer needs to reach this type directly. There it was
/// `WorkingDirsMenu.swift`'s extension; here it is `PendingCardsTests`, which constructs this view
/// directly to prove — via `Mirror` — that it holds no view-local `@State` for the answer any
/// more (`testPendingQuestionBodyHoldsNoViewLocalState`).
struct PendingQuestionBody: View {
    let callId: String
    let questions: [SessionEvent.Question]
    /// Dispatch relay (Phase 7): see `PendingApprovalBody.childSessionId`'s doc — same meaning,
    /// threaded into `onQuestion` on submit.
    let childSessionId: String?
    let isInFlight: Bool
    let onQuestion: (String, [String: String], [String: String], String?) -> Void
    /// panel-shell T10b: the answer lives HERE now, not in local `@State` — see `PendingCardDraft`'s
    /// own doc for why (it must survive `ShellRootView`'s `.maximized` teardown of `detail`).
    @Binding var draft: PendingCardDraft

    private var isComplete: Bool {
        questionCardComplete(questions: questions, selections: draft.selections, otherTexts: draft.otherTexts)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                // mac-chat-parity Task 3: a hairline between questions, iOS's rule for a
                // multi-question block. One ask can carry up to four questions and, without a
                // division, four blocks of "header / question / options / Other / note" read as one
                // long undifferentiated form.
                if index > 0 { QuestionSeparator() }
                QuestionBlock(
                    index: index,
                    question: question,
                    showsHeader: questionShowsHeaderChip(question, questionCount: questions.count),
                    selected: draft.selections[index] ?? [],
                    otherText: draft.otherTexts[index] ?? "",
                    isOtherExpanded: draft.otherExpanded.contains(index),
                    noteText: draft.notes[index] ?? "",
                    isInFlight: isInFlight,
                    onSelectSingle: { optionIndex in draft.selectSingle(optionIndex, forQuestion: index) },
                    onToggleMulti: { optionIndex in draft.toggleMulti(optionIndex, forQuestion: index) },
                    onExpandOther: { draft.expandOther(forQuestion: index) },
                    onOtherTextChange: { text in draft.setOtherText(text, forQuestion: index) },
                    onNoteTextChange: { text in draft.setNote(text, forQuestion: index) }
                )
            }

            // mac-chat-parity Task 3: full width and the card's ONE prominent action — a small
            // natural-width button floating under a form gave no sense of being the thing that
            // completes it. `Sending…` while the respond RPC is out (iOS's own in-flight label);
            // still disabled in that state, so the label is the signal and the disable is the guard.
            Button(action: submit) {
                if isInFlight {
                    Label("Sending…", systemImage: "hourglass").frame(maxWidth: .infinity)
                } else {
                    Text("Submit").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isInFlight || !isComplete)
        }
    }

    private func submit() {
        onQuestion(
            callId,
            questionAnswers(for: questions, selections: draft.selections, otherTexts: draft.otherTexts),
            questionNotes(for: questions, notes: draft.notes),
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
            // Same serif register as the frozen card's question (see `ResolvedQuestionBody`) — the
            // pending and answered forms of one question must not speak in two different voices.
            Text(question.question)
                .font(Font(Theme.assistantProse(size: 14, weight: .regular)))
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
            // Notes are a code-mode (`ask_user`) affordance; chat's simplified (header-less) card
            // has none (Slice B1). The note state/callback wiring itself is untouched — this only
            // gates whether the field is SHOWN, so code mode's notes keep working unchanged.
            if questionAllowsNotes(question) {
                noteRow
            }
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
            .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    /// mac-chat-parity Task 3 (defect 2): ONE row shape for both arities. Single-select used to be a
    /// bare `.plain` text button with no glyph and no selected state of any kind — nothing showed
    /// the user what they had picked before they submitted it; the only feedback was Submit
    /// enabling. Both arities now carry a glyph honest about which they are
    /// (`optionSelectionGlyph`) and the same selected chrome (`optionSelectionChrome`).
    private func optionRow(_ optionIndex: Int, _ option: SessionEvent.QuestionOption) -> some View {
        let isSelected = selected.contains(optionIndex)
        let chrome = optionSelectionChrome(isSelected: isSelected)
        return Button {
            if question.multiSelect { onToggleMulti(optionIndex) } else { onSelectSingle(optionIndex) }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: optionSelectionGlyph(multiSelect: question.multiSelect, isSelected: isSelected))
                    .foregroundStyle(isSelected ? Theme.accent : .secondary)
                optionLabel(option, isSelected: isSelected)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            // The whole row, fill and padding included, is the hit target — not just the glyph and
            // the words. iOS's rule, and the one that makes a bordered selected row honest about
            // where it can be clicked.
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.accent.opacity(chrome.fillOpacity))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.accent, lineWidth: chrome.strokeWidth)
            )
        }
        .buttonStyle(.plain)
        .disabled(isInFlight)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private func optionLabel(_ option: SessionEvent.QuestionOption, isSelected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(option.label)
                .font(.system(size: 13, weight: optionSelectionChrome(isSelected: isSelected).isBold ? .semibold : .regular))
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
/// panel-shell T10b: widened from `private` to internal — see `PendingQuestionBody`'s own doc for
/// why (the `showingDirsMenu` precedent; here `PendingCardsTests` constructs this view directly
/// via `Mirror` in `testPendingPlanBodyHoldsNoViewLocalState`).
struct PendingPlanBody: View {
    let callId: String
    let plan: String
    let isInFlight: Bool
    let onPlan: (String, Bool, Bool, String?) -> Void
    /// panel-shell T10b: the "Request changes" toggle and its typed feedback live HERE now, not in
    /// local `@State` — see `PendingCardDraft`'s own doc.
    @Binding var draft: PendingCardDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                TranscriptAssistantMessage(text: plan, isStreaming: true, role: .sans)
            }
            .frame(maxHeight: 260)

            HStack(spacing: 8) {
                Button("Approve") { onPlan(callId, true, false, nil) }
                    .buttonStyle(.borderedProminent)
                Button("Approve + auto-accept") { onPlan(callId, true, true, nil) }
                    .buttonStyle(.bordered)
                Button("Request changes") { draft.isRequestingChanges = true }
                    .buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(isInFlight)

            if draft.isRequestingChanges {
                HStack(spacing: 8) {
                    TextField("What should change?", text: $draft.feedback)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                    Button("Send") {
                        onPlan(callId, false, false, draft.feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft.feedback)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isInFlight)
                }
            }
        }
    }
}
