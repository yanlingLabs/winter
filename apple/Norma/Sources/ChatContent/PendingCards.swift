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
    /// The asks the composer has handed back (`WindowContentView.closedAsks`). The transcript draws
    /// exactly the pending questions the composer is NOT holding — one set, read on both sides.
    var closedAsks: Set<String> = []
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
    /// Which question of a multi-question block is on screen (2026-08-13).
    ///
    /// Here rather than in the view's `@State` for the reason everything else in this struct is —
    /// and `PendingQuestionBodyHoldsNoViewLocalState` enforces it. It earns the place on its own
    /// merits too: losing your PLACE in a four-question ask on a `.maximized` teardown is the same
    /// class of annoyance as losing the answers, and the fix was already built.
    var visibleQuestion: Int = 0
    /// Which questions have their NOTE field open. Its own set: the note icon used to drive
    /// `otherExpanded`, so clicking it opened the *Other* text field instead — two different
    /// affordances sharing one flag, which is why the note field appeared to be permanently on.
    var notesOpen: Set<Int> = []

    /// Wipe every answer in the block — what the × does (user call, 2026-08-13; iOS's style8).
    ///
    /// The QUESTION fields only. `isRequestingChanges`/`feedback`/`isSummaryExpanded` belong to the
    /// plan and approval cards, which have no × and never share a draft with a question — clearing
    /// them here would be a mutation nobody asked for, reachable only by a future card that reuses
    /// this type. `otherExpanded` goes too: a note field left standing open over a cleared answer
    /// is the one piece of the old state that would still look like content.
    mutating func clearAll() {
        selections = [:]
        otherTexts = [:]
        otherExpanded = []
        notes = [:]
        notesOpen = []
    }

    /// Toggle a question's note field.
    mutating func toggleNote(forQuestion index: Int) {
        notesOpen.formSymmetricDifference([index])
    }

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
        if let deckQuestions = questionDeckCards(record), let outcome = record.outcome {
            // Each card carries its OWN chrome here, so the outer `.modifier` below must not run —
            // a deck inside one card would be a stack of faces on a face.
            ResolvedQuestionDeck(questions: deckQuestions, outcome: outcome)
                .frame(maxWidth: interactionCardMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            singleCard
        }
    }

    private var singleCard: some View {
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
        // CAPPED, not full-bleed (user call, 2026-08-12: "on the mac the screen is way too big").
        // 560 is not a new number — it is the width the user's own bubble already caps at
        // (`TranscriptMessageViews.swift:133`), so a card and a message share one column edge
        // instead of disagreeing about how wide the conversation is. Left-aligned: the card is
        // Norma's side of the dialogue, and everything of hers on this surface leads from the left.
        .frame(maxWidth: interactionCardMaxWidth, alignment: .leading)
        .modifier(InteractionCardChrome())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var pendingBody: some View {
        switch record.ask {
        case .approval(_, let summary, let reviewerReason, let options):
            PendingApprovalBody(callId: record.callId, summary: summary, reviewerReason: reviewerReason, childSessionId: record.childSessionId, options: options, isInFlight: isInFlight, onApproval: wiring.onApproval, draft: wiring.draftBinding(record.callId))
        case .question(let questions):
            PendingQuestionBody(callId: record.callId, questions: questions, childSessionId: record.childSessionId, isInFlight: isInFlight, onQuestion: wiring.onQuestion, onClose: nil, draft: wiring.draftBinding(record.callId))
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
/// PURE: the answered questions a DECK is drawn for, or `nil` for an ordinary single card — iOS's
/// SP-ask-stack rule: resolved, and more than one.
///
/// The three exclusions each have a reason worth keeping:
///   - **one question** is an ordinary card; a deck of one is a card wearing a control nobody needs;
///   - **still pending** never reaches here at all now — the composer is holding it
///     (`questionMorphsTheComposer`), so a pending deck is unreachable rather than merely unwanted;
///   - **`.ended`** (asked, never answered) stays a single card: every card in a deck would read
///     "—", and fanning three of those out says nothing three times.
func questionDeckCards(_ record: InteractionRecord) -> [SessionEvent.Question]? {
    guard case .question(let questions) = record.ask, questions.count > 1,
          let outcome = record.outcome, case .question = outcome else { return nil }
    return questions
}

/// PURE: how far behind the front a card sits, looping — iOS's `resolvedStack` arithmetic verbatim.
/// Modular so every card is always 0…n−1 steps back and the deck has no ends; cycling past the last
/// card returns to the first rather than stopping.
func deckDepth(index: Int, front: Int, count: Int) -> Int {
    guard count > 0 else { return 0 }
    return ((index - front) % count + count) % count
}

/// PURE: the lean on a card `depth` steps back — alternating sides so the stack fans rather than
/// leaning as one block. iOS's ±2.2° per step.
func deckLeanDegrees(depth: Int) -> Double {
    depth == 0 ? 0 : Double(depth) * (depth.isMultiple(of: 2) ? -2.2 : 2.2)
}

/// A resolved MULTI-question block, as a Photos-style deck — one card per question (iOS's
/// SP-ask-stack). The geometry is iOS's: modular depth, 2% scale per step back, a 6pt offset,
/// alternating ±2.2° lean, and at most three peeking behind the front.
///
/// **Click the stack to UNSTACK it** (user call, 2026-08-13). iOS cycles a card at a time with a
/// swipe; that gesture does not exist here — a two-finger trackpad swipe arrives as a scroll event,
/// so the phone's `DragGesture` would only answer to click-drag. Rather than invent a pager (tried,
/// and it read as chrome bolted onto a card), the deck simply opens: one click fans the stack out
/// into a plain vertical list, aligned, pushing the rest of the transcript down; another closes it.
///
/// It is the honest Mac trade. The phone cycles because it has one screen-width to spend; a Mac has
/// the column to just show them, and "see all three at once" beats "turn to card two" when the room
/// exists. Expanded, the cards are ordinary aligned cards with no fan, no lean, and no gesture to
/// discover — nothing to learn, which is the point.
struct ResolvedQuestionDeck: View {
    let questions: [SessionEvent.Question]
    let outcome: InteractionRecord.Outcome

    @State private var expanded = false

    private var count: Int { questions.count }

    var body: some View {
        Group {
            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(questions.indices, id: \.self) { card($0) }
                }
            } else {
                stack
            }
        }
        // The whole thing is the target in both states — collapsed there is a fanned deck to click,
        // expanded there is a column whose cards should close it again. `.contentShape` so the gaps
        // between cards are live too, and `.plain` so neither state grows a button's face.
        .contentShape(Rectangle())
        .onTapGesture { expanded.toggle() }
        .animation(.smooth(duration: 0.3), value: expanded)
        .accessibilityElement(children: .contain)
        .accessibilityHint(expanded
            ? "Showing all \(count) answered questions. Click to stack them."
            : "\(count) answered questions, stacked. Click to show them all.")
    }

    /// The collapsed fan — iOS's geometry, front card upright, at most three peeking behind.
    private var stack: some View {
        ZStack(alignment: .top) {
            ForEach(questions.indices, id: \.self) { index in
                let depth = deckDepth(index: index, front: 0, count: count)
                card(index)
                    .zIndex(Double(count - depth))
                    .scaleEffect(depth == 0 ? 1 : 1 - CGFloat(depth) * 0.02)
                    .offset(x: CGFloat(depth) * 6)
                    .rotationEffect(.degrees(deckLeanDegrees(depth: depth)))
                    .opacity(depth > 3 ? 0 : 1)
                    .accessibilityHidden(depth != 0)   // VoiceOver reads the front card only
            }
        }
    }

    private func card(_ index: Int) -> some View {
        ResolvedQuestionBody(questions: [questions[index]], outcome: outcome)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(InteractionCardChrome())
    }
}

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
                            .font(.system(size: QuestionCardType.pill, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    // Norma's voice, so it wears Norma's voice — the assistant-prose serif register
                    // (`brand.md` § 4, binding #4), which iOS applies here for the same stated
                    // reason. Not a new serif binding: a question IS assistant prose, and Task 8
                    // shipped that register for exactly this. The ANSWER below stays sans — it is
                    // the user's word, and the two registers are what make the card read as a
                    // dialogue rather than a form.
                    Text(question.question)
                        .font(Font(Theme.assistantProse(size: QuestionCardType.question, weight: .regular)))
                        .foregroundStyle(.primary)

                    answerRows(for: question)

                    if let note = recorded.notes[question.question], !note.isEmpty {
                        Text(note)
                            .font(.system(size: QuestionCardType.secondary))
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
                .font(.system(size: QuestionCardType.option))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Image(systemName: glyph)
                .font(.system(size: QuestionCardType.option, weight: .medium))
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
/// **GEOMETRY IS iOS'S, EXACTLY** (r=28, 16pt padding, a true `1/displayScale` hairline): the two
/// travel together — 28 works precisely because the padding is 16, and an earlier r=16 here read
/// squarer than the phone at the same content inset. Radius tracks the card's HEIGHT and visual
/// weight, not its width, and both platforms' cards are about as tall; scaling 28 by the width
/// ratio would give ~44 and look like a pill.
///
/// **The rim's COLOUR is the one deliberate divergence.** iOS uses `Color.primary.opacity(0.17)`;
/// this uses `Theme.hairlineElevated`, because a `primary`-derived rim is a neutral grey rule on a
/// warm palette — the same class of thing as the `#F2F2F7` fill above, and `brand.md` § 3.1 forbids
/// deriving a colour by opacity off a system value. That token is not a substitution of convenience
/// either: `brand.md` § 1 measures it at **1.389:1 light / 1.431:1 dark on `CardSurface`**, and
/// names that ground as "the ground a floating control's rim has to read against" — this card.
private struct InteractionCardChrome: ViewModifier {
    @Environment(\.displayScale) private var displayScale

    func body(content: Content) -> some View {
        content
            .background(Theme.cardSurface, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(Theme.hairlineElevated, lineWidth: 1 / displayScale)
            )
            .compositingGroup()   // flatten first: the shadow outlines the CARD, not every glyph
            .shadow(color: .black.opacity(0.05), radius: 8, y: 1)
    }
}

/// The interaction card's width ceiling — the user bubble's own `560`
/// (`TranscriptMessageViews.swift:133`), shared deliberately so the two sides of the conversation
/// agree on one column edge. Named rather than inlined because the pending question box will have
/// to match the COMPOSER's width instead, and the difference between those two numbers is a design
/// decision someone will want to find.
let interactionCardMaxWidth: CGFloat = 560

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
// MARK: - The composer morph (user call, 2026-08-12 — iOS's SP-ask-morph)

/// PURE: the ask the composer becomes — the OLDEST pending question, so answering unblocks the
/// earliest waiting turn (iOS's `QuestionComposerView.firstPending` rule, same reason).
///
/// Approvals and plans are deliberately NOT included. Only the question has a form big enough to
/// need the composer's room, and only the question is a thing the user *writes* an answer to; an
/// approval is two buttons and belongs where it was asked, in the transcript.
///
/// Returns the payload rather than the `PendingInteraction` so the caller cannot accidentally hand
/// the box an approval — the type makes the wrong call site unwritable.
func composerMorphQuestion(
    _ pending: [PendingInteraction],
    excluding closed: Set<String> = []
) -> (callId: String, questions: [SessionEvent.Question], childSessionId: String?)? {
    for interaction in pending where !closed.contains(interaction.callId) {
        if case .question(let callId, let questions, let childSessionId) = interaction {
            // A question whose payload has not landed yet cannot render a form. Skipping it rather
            // than morphing into an empty box means the composer stays usable until it arrives.
            if !questions.isEmpty { return (callId, questions, childSessionId) }
        }
    }
    return nil
}

/// Whether the transcript should stay out of this record's way because the composer is showing it.
///
/// The other half of `composerMorphQuestion`, and the two must agree or the question renders twice.
/// Deliberately keyed on the SHAPE of the record (a pending question) rather than on identity with
/// whatever the composer picked: a second pending question — rarer, but reachable via a dispatch
/// child — must not appear inline just because the composer is busy with the first. It waits its
/// turn in the same slot, exactly as iOS's oldest-first rule intends.
func questionMorphsTheComposer(_ record: InteractionRecord, closed: Set<String> = []) -> Bool {
    guard case .question = record.ask else { return false }
    // A CLOSED ask is the composer's no-longer: the user handed the composer back, so the transcript
    // takes the question again — still pending, still answerable, just not in the way.
    guard !closed.contains(record.callId) else { return false }
    return interactionIsPending(record)
}

// MARK: - The question card's type ladder (ported from iOS by RATIO, 2026-08-13)

/// iOS sets a question at the transcript's own prose size and steps everything under it down from
/// there; the Mac had the whole card a register lower, with the question at 14 — which is the
/// USER's message size, not Norma's. So her question was set in the user's register while wearing
/// her serif face, the one place the two crossed.
///
/// Ported as RATIOS against `.body` (17 at the default Dynamic Type size), not as point values:
/// copying 17/16/13/12 onto a 15.5 pt Mac ladder would have made the card larger than the prose
/// around it. Rounded to the half points this file already uses.
enum QuestionCardType {
    /// **Derived, not written down**: the question IS the transcript's assistant prose size (iOS
    /// ratio 1.00). Reading it from `transcriptProseMetrics` is what makes that an invariant rather
    /// than two constants that happen to agree today — change the prose ladder and this follows.
    static var question: CGFloat { transcriptProseMetrics(.assistant).bodySize }
    /// iOS `.callout`, 16/17 = 0.94 → 14.5. The option label and a frozen card's answer row.
    static let option: CGFloat = 14.5
    /// iOS `.footnote`, 13/17 = 0.76 → 12. Option descriptions and notes.
    static let secondary: CGFloat = 12
    /// iOS `.caption`, 12/17 = 0.71 → 11. Header chips and pills — already this value.
    static let pill: CGFloat = 11
}

/// The action row's control height — "thicker" than a stock button (user call), and one number for
/// all three so the circles are round against the capsule rather than merely near it. iOS's is 50 on
/// a touch target; 44 is this shell's equivalent at pointer scale.
let pendingQuestionActionHeight: CGFloat = 44

/// PURE: what a question's pill says — its header, or a plain ordinal when the ask carries none.
/// Never the question text: a pill row of truncated sentences is unreadable, and the question
/// itself is on screen directly below the pills.
func pendingQuestionPillLabel(_ question: SessionEvent.Question, index: Int) -> String {
    if let header = question.header, !header.trimmingCharacters(in: .whitespaces).isEmpty {
        return header
    }
    return "\(index + 1)"
}

struct PendingQuestionBody: View {
    let callId: String
    let questions: [SessionEvent.Question]
    /// Dispatch relay (Phase 7): see `PendingApprovalBody.childSessionId`'s doc — same meaning,
    /// threaded into `onQuestion` on submit.
    let childSessionId: String?
    let isInFlight: Bool
    let onQuestion: (String, [String: String], [String: String], String?) -> Void
    /// What Close does, or **`nil` where there is nothing to close FROM** — the transcript's own
    /// copy of a closed-out ask passes nil, because that card IS the question's home and a Close
    /// button there would be a button with no destination.
    ///
    /// **iOS's own `closeQuestion()` is an empty stub** — its Close button does nothing at all — so
    /// this is not a port, it is the missing half. In the composer it hands the composer back and
    /// returns the ask to the transcript, where it stays pending and answerable: "not now" rather
    /// than "never", the only honest meaning available while the daemon is still waiting.
    let onClose: (() -> Void)?
    /// panel-shell T10b: the answer lives HERE now, not in local `@State` — see `PendingCardDraft`'s
    /// own doc for why (it must survive `ShellRootView`'s `.maximized` teardown of `detail`).
    @Binding var draft: PendingCardDraft

    private var isComplete: Bool {
        questionCardComplete(questions: questions, selections: draft.selections, otherTexts: draft.otherTexts)
    }

    /// Which question is on screen. ONE AT A TIME (user call, 2026-08-13): a four-question ask
    /// stacked into one column was a wall of form. The pills above and Next below are the two ways
    /// through it — Next walks forward, a pill jumps anywhere, including back.
    ///
    /// Clamped on READ rather than trusted: the draft outlives any particular question list (it is
    /// keyed by callId and survives teardown), so a stale index must never index out of bounds.
    private var index: Int { min(max(draft.visibleQuestion, 0), max(questions.count - 1, 0)) }
    private var isLast: Bool { index >= questions.count - 1 }

    /// Any answer-in-progress anywhere in the BLOCK — the Close/clear split point, and deliberately
    /// block-wide rather than per-question (iOS's `hasAnyContent`): the × clears everything, so it
    /// must appear whenever there is anything anywhere to clear, even on a page the user has not
    /// touched.
    private var hasAnyContent: Bool {
        questions.indices.contains { i in
            !(draft.selections[i] ?? []).isEmpty
                || !(draft.otherTexts[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !(draft.notes[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if questions.count > 1 { pillPicker }

            if questions.indices.contains(index) {
                QuestionBlock(
                    index: index,
                    question: questions[index],
                    showsHeader: false,   // the pills carry the headers now
                    selected: draft.selections[index] ?? [],
                    otherText: draft.otherTexts[index] ?? "",
                    isOtherExpanded: draft.otherExpanded.contains(index),
                    isNoteOpen: draft.notesOpen.contains(index),
                    noteText: draft.notes[index] ?? "",
                    isInFlight: isInFlight,
                    onSelectSingle: { optionIndex in draft.selectSingle(optionIndex, forQuestion: index) },
                    onToggleMulti: { optionIndex in draft.toggleMulti(optionIndex, forQuestion: index) },
                    onExpandOther: { draft.expandOther(forQuestion: index) },
                    onOtherTextChange: { text in draft.setOtherText(text, forQuestion: index) },
                    onNoteTextChange: { text in draft.setNote(text, forQuestion: index) }
                )
                .id(index)   // each page is its own view, so a field never inherits the last one's text
            }

            actionRow
        }
        .animation(.smooth(duration: 0.2), value: hasAnyContent)
        .animation(.smooth(duration: 0.2), value: index)
    }

    /// The other questions' headers, always visible — iOS's pill picker. A pill is the way BACK
    /// (Next is the way forward), and its checkmark is how a four-question ask says how far along
    /// it is without a counter.
    private var pillPicker: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(questions.indices, id: \.self) { i in
                    let isCurrent = i == index
                    let answered = !(draft.selections[i] ?? []).isEmpty
                        || !(draft.otherTexts[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    Button { draft.visibleQuestion = i } label: {
                        HStack(spacing: 4) {
                            Text(pendingQuestionPillLabel(questions[i], index: i))
                                .font(.system(size: QuestionCardType.pill, weight: .medium))
                                .lineLimit(1)
                            if answered {
                                Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold))
                            }
                        }
                        .foregroundStyle(isCurrent ? Theme.accent : Color.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(isCurrent ? Theme.accent.opacity(0.14) : Color.clear))
                        .overlay(Capsule().strokeBorder(
                            isCurrent ? Theme.accent.opacity(0.4) : Theme.hairlineElevated,
                            lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Question \(i + 1) of \(questions.count): \(pendingQuestionPillLabel(questions[i], index: i))")
                    .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
                }
            }
        }
        .scrollIndicators(.never)
    }

    /// `[×] [ Next | Submit ] [note]`, or `[ Close ] [note]` on an untouched block.
    ///
    /// The × CLEARS, it does not close (iOS's style8, and the user's own instruction): one click
    /// wipes every selection, Other text and note across the whole block, landing back on the empty
    /// state where Close is the actual close. Two honest clicks, no accidental discard of a
    /// half-built answer.
    private var actionRow: some View {
        HStack(spacing: 10) {
            if hasAnyContent {
                circleButton(system: "xmark", label: "Clear answers") {
                    draft.clearAll()
                }
                .transition(.blurReplace)
            }

            if hasAnyContent {
                primaryButton
            } else if let onClose {
                wideButton(title: "Close", disabled: false, action: onClose)
                    .transition(.blurReplace)
            } else if !isLast {
                // No Close to offer (the transcript's copy), but a multi-question block still needs
                // its way forward before anything is picked.
                primaryButton
            }

            if questions.indices.contains(index), questionAllowsNotes(questions[index]) {
                circleButton(
                    system: draft.notesOpen.contains(index) ? "note.text" : "note.text.badge.plus",
                    label: draft.notesOpen.contains(index) ? "Hide note" : "Add note"
                ) {
                    draft.toggleNote(forQuestion: index)
                }
            }
        }
    }

    @ViewBuilder
    private var primaryButton: some View {
        if isLast {
            wideButton(title: isInFlight ? "Sending…" : "Submit",
                       disabled: isInFlight || !isComplete,
                       action: submit)
        } else {
            // Next is NAVIGATION, never gated on an answer: a user may want to read question three
            // before deciding question one, and the pills already allow that — a disabled Next
            // would be the only thing on the box claiming the questions must be answered in order.
            wideButton(title: "Next", disabled: false) { draft.visibleQuestion = index + 1 }
        }
    }

    /// The wide action. `inverseCanvas`, NOT accent (user call): accent is the app's *selection*
    /// colour and it is already spoken by the chosen option's checkmark just above — a button in
    /// the same colour competed with the answer for the same meaning. Inverted canvas is what iOS
    /// gives Submit, and what "+ New chat" already wears on this platform.
    private func wideButton(title: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.canvas)
                .frame(maxWidth: .infinity)
                .frame(height: pendingQuestionActionHeight)
                .background(Capsule().fill(Theme.inverseCanvas.opacity(disabled ? 0.35 : 1)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func circleButton(system: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: pendingQuestionActionHeight, height: pendingQuestionActionHeight)
                .background(Circle().fill(Theme.controlSurface))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
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
    let isNoteOpen: Bool
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
                .font(Font(Theme.assistantProse(size: QuestionCardType.question, weight: .regular)))
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

            // Other is an OPTION, so it is divided from the listed ones exactly as they are
            // divided from each other (user call, 2026-08-13; iOS puts a rule here too). Without it
            // the last listed option and the free-text row ran together as one block.
            if !question.options.isEmpty { optionSeparator }
            otherRow
            // Notes are a code-mode (`ask_user`) affordance; chat's simplified (header-less) card
            // has none (Slice B1). The note state/callback wiring itself is untouched — this only
            // gates whether the field is SHOWN, so code mode's notes keep working unchanged.
            if questionAllowsNotes(question), isNoteOpen {
                noteRow
            }
        }
    }

    @ViewBuilder
    /// Options separated by hairlines, with **Other last** — iOS's (and Claude's) card structure,
    /// where the rule carries the division so no row needs a fill or a border to be distinct.
    private var optionsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                if optionIndex > 0 { optionSeparator }
                optionRow(optionIndex, option)
            }
        }
    }

    /// The hairline between option rows, and before Other. `hairlineElevated` because this box
    /// stands on a raised surface — the shell token measures 1.040:1 there in dark (`brand.md` § 1),
    /// which is the rule very nearly not drawn at all.
    private var optionSeparator: some View {
        Rectangle()
            .fill(Theme.hairlineElevated)
            .frame(height: 1)
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
        return Button {
            if question.multiSelect { onToggleMulti(optionIndex) } else { onSelectSingle(optionIndex) }
        } label: {
            // iOS's row grammar (user call, 2026-08-13): NO leading glyph, no fill, no border — the
            // hairlines carry the structure, and a chosen row earns ONE TRAILING accent checkmark.
            // The check lives in a RESERVED column so selecting never reflows the label, and it is
            // the same mark for single- and multi-select: the control's shape mattered when it was
            // being chosen among, but on the row itself "chosen" means one thing. The button's own
            // `.isSelected` trait still tells VoiceOver which arity this is.
            HStack(alignment: .center, spacing: 12) {
                optionLabel(option, isSelected: isSelected)
                Spacer(minLength: 8)
                Image(systemName: "checkmark")
                    .font(.system(size: QuestionCardType.option, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .opacity(isSelected ? 1 : 0)
                    .frame(width: 28, alignment: .center)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
            // The whole row is the hit target, gaps included — with no fill to click, the words
            // alone would be a smaller target than the row looks.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isInFlight)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private func optionLabel(_ option: SessionEvent.QuestionOption, isSelected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            // NEVER bold when chosen (user call, 2026-08-13): the trailing checkmark already says
            // "this one", and a second signal on the same row made the chosen option shout while
            // its siblings whispered. Weight is for hierarchy — label over description — not state.
            Text(option.label)
                .font(.system(size: QuestionCardType.option))
                .foregroundStyle(.primary)
            if let description = option.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: QuestionCardType.secondary))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var otherRow: some View {
        // A quiet pencil marks it writable — iOS's `otherField`, and the same glyph the FROZEN card
        // uses to record that an answer was typed rather than chosen. One mark, one meaning, in
        // both halves of a question's life.
        HStack(spacing: 8) {
            Image(systemName: "pencil")
                .font(.system(size: QuestionCardType.secondary))
                .foregroundStyle(.secondary)
            if isOtherExpanded {
                TextField("Other…", text: Binding(get: { otherText }, set: onOtherTextChange))
                    .textFieldStyle(.plain)
                    .font(.system(size: QuestionCardType.option))
                    .disabled(isInFlight)
            } else {
                Button("Other…", action: onExpandOther)
                    .buttonStyle(.plain)
                    .font(.system(size: QuestionCardType.option))
                    .foregroundStyle(.secondary)
                    .disabled(isInFlight)
                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, 10)
    }

    /// CC AskUserQuestion parity: a per-question free-text note. **Hidden until the note icon in
    /// the action row is clicked** (user call, 2026-08-13) — it was standing open on every question,
    /// which put an empty text field under every ask and made the box look like a form with a blank
    /// nobody had filled in. It never gates Submit, and rides into `questionNotes`'s dict only when
    /// non-empty (see that helper's doc).
    private var noteRow: some View {
        // No `.foregroundStyle` override, matching `otherRow`'s TextField above — SwiftUI's
        // `TextField` prompt (the "Add a note (optional)" placeholder) already renders dimmed on
        // its own; overriding the whole field to `.secondary` would ALSO dim actually-typed text,
        // which is a `.primary`-weight answer, not a hint.
        TextField("Add a note (optional)", text: Binding(get: { noteText }, set: onNoteTextChange))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: QuestionCardType.secondary))
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
