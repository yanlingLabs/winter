import SwiftUI

/// Spec §3: autoscroll only follows when the user is already near the bottom — v1 yanked
/// unconditionally on every streaming chunk (donor ChatRootView.swift:514-522); this is the
/// one deliberate improvement over the transplant.
func shouldAutoscroll(nearBottom: Bool, contentGrew: Bool) -> Bool {
    nearBottom && contentGrew
}

struct TranscriptView: View {
    @ObservedObject var adapter: FieldStateAdapter
    let tint: Color
    /// mac-chat-parity Task 3: approval/question/plan cards render INSIDE the transcript now, so the
    /// transcript needs the respond closures the pinned band below it used to hold. Bundled as one
    /// value (see `InteractionCardWiring`) rather than six parameters threaded through every row.
    let cardWiring: InteractionCardWiring
    /// diff-tabs Task 9: the transcript's diff door — a plain closure, injected from the window
    /// layer, that a diff chip on an edit/write/notebook row calls with its own `FileDiffRef`
    /// (`TranscriptDiffChip`). Deliberately NOT folded into `InteractionCardWiring`: that value is
    /// the approval/question/plan cards' respond bundle, and a diff has nothing to do with an ask.
    ///
    /// `nil` — the default, which every existing call site takes — draws the chips as plain text on
    /// a surface with no panel to open a tab in (the orb's morph window, every detached window).
    var onOpenDiff: ((FileDiffRef) -> Void)? = nil
    /// editor-product Task 6: the SECOND transcript→panel door — see `WindowContentView.onOpenFile`'s
    /// own doc for the full story. Threaded through unchanged, same opt-in default as `onOpenDiff`.
    var onOpenFile: ((String) -> Void)? = nil
    /// editor-product Task 6 — see `WindowContentView.sessionHasWorkingDirectory`'s own doc.
    var sessionHasWorkingDirectory: Bool = false
    @State private var nearBottom = true
    @State private var showLatestPill = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(adapter.transcript.enumerated()), id: \.offset) { index, exchange in
                        let isLast = index == adapter.transcript.count - 1
                        TranscriptExchangeRow(
                            exchange: exchange,
                            cardWiring: cardWiring,
                            onOpenDiff: onOpenDiff,
                            onOpenFile: onOpenFile,
                            sessionHasWorkingDirectory: sessionHasWorkingDirectory,
                            streamingText: isLast ? adapter.liveStreamingText : nil,
                            // Live only for the newest exchange (mac-chat-parity Task 2). That is
                            // not quite the same as "every in-flight call lives here": a main-thread
                            // steer's `user_message` is persisted at SEND time, so it can open a NEW
                            // exchange while a call in the previous one is still out — the case
                            // `SessionReducer.foldToolResult` scans backwards for, pinned by
                            // `testToolResultFoldsIntoAnEarlierExchangeWhenASteerOpenedANewOne`.
                            // Such a call reads "no result" rather than "running" until its result
                            // lands, then corrects itself. Deliberate: erring toward "no result" is
                            // recoverable, while a false "running" is the permanent lie this whole
                            // gate exists to prevent.
                            turnIsLive: isLast && adapter.turnRunning,
                            tint: tint
                        )
                        .id(index)
                    }
                }
                .padding(.vertical, 4)
            }
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 40
            } action: { _, isNear in
                nearBottom = isNear
                if isNear { showLatestPill = false }
            }
            // Task-4 review fix: onChange fires on ANY change — including the count DROPPING to
            // zero on session refocus (SessionModel.reset() swaps exchanges wholesale). Only a
            // genuine growth may follow/raise the pill; a reset must do neither.
            .onChange(of: adapter.transcript.count) { old, new in
                if new > old { follow(proxy) }
            }
            .onChange(of: adapter.liveStreamingText) { old, new in
                if (new?.count ?? 0) > (old?.count ?? 0) { follow(proxy) }
            }
            // mac-chat-parity Task 3: a card arriving is content growth the two signals above cannot
            // see — an ask lands in the LAST exchange's `activity`, which changes neither the
            // exchange count nor the streaming text. Before the cards moved inline this did not
            // matter (the band was pinned, always visible); now, without this, an approval could
            // appear below the fold and the agent would look hung. Growth-only, for the same reason
            // the count watcher is (`SessionModel.reset()` drops it to zero on refocus, and a reset
            // must neither follow nor raise the pill).
            .onChange(of: adapter.pendingInteractions.count) { old, new in
                if new > old { follow(proxy) }
            }
            .overlay(alignment: .bottomTrailing) {
                if showLatestPill { latestPill(proxy) }
            }
        }
    }

    /// Extracted from `body` (Task-4 review, minor): the chained ScrollViewReader expression sat
    /// at SourceKit's type-check complexity cliff — keep `body` shallow so future edits don't
    /// tip it over.
    /// mac-chat-parity Task 8: `Theme.controlSurface` — the token `docs/brand.md` gives small
    /// controls — with a `Theme.hairlineElevated` rim, because this pill floats over scrolling prose
    /// and an opaque fill alone has nothing to separate it from the text passing underneath. (It was
    /// a `.thinMaterial`, which on an opaque window blurs whatever it happens to be over rather than
    /// naming a colour.)
    ///
    /// The ELEVATED hairline (fix round 1), because the ground this rim has to separate from is the
    /// content plane the pill floats over: 1.389:1 light / 1.431:1 dark on `cardSurface`, against the
    /// shell `hairline`'s 1.226 / 1.134. Whether a rim is wanted here AT ALL is still a gate call;
    /// which token it uses is now a measured one.
    private func latestPill(_ proxy: ScrollViewProxy) -> some View {
        Button {
            scrollToBottom(proxy)
        } label: {
            Label("latest", systemImage: "arrow.down")
                .font(Typography.caption(.medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(Theme.controlSurface))
                .overlay(Capsule().strokeBorder(Theme.hairlineElevated,
                                                lineWidth: shellSidebarHairlineWidth))
        }
        .buttonStyle(.plain)
        .padding(8)
    }

    private func follow(_ proxy: ScrollViewProxy) {
        if shouldAutoscroll(nearBottom: nearBottom, contentGrew: true) {
            scrollToBottom(proxy)
        } else {
            showLatestPill = true
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        let last = adapter.transcript.count - 1
        guard last >= 0 else { return }
        withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last, anchor: .bottom) }
    }
}

/// One exchange's rows — prompt bubble, GROUPED activity (LIVE-GATE G3 / r1b: `groupActivity`
/// folds any UNBROKEN run of tool calls — even across different tool names — into one `.toolRun`
/// sentence row carrying its status and expanding to every call's arguments and output, skips
/// `.task` entirely), one row per assistant message plus the live streaming row, stopped flag.
///
/// Activity and replies are NOT interleaved chronologically — every tool row precedes every reply
/// row, because `Exchange` stores them in two separate lists; making the transcript event-shaped is
/// a separate, larger change. The citation here used to read "spec §5 item 6", which points at
/// nothing: the mac-chat-parity design doc's §5 is the model/effort wiring and has no item 6. The
/// change is item **6** of `docs/research/2026-08-12-ios-vs-mac-transcript.md` §5 ("Event-shaped
/// rows"), which that table marks **Large** and scope-judgment — and the design doc deliberately
/// carries no §9 gate for it. A
/// dedicated `View` (not a `@ViewBuilder` func on `TranscriptView`) because it owns its own
/// expansion `@State` — which tool runs are expanded, keyed by `toolRunExpansionKey` (the run's
/// first `callId`, NOT its position: the reducer's drop-oldest activity cap shifts positions during
/// a marathon turn, which would silently re-point an open row at a neighbouring run's output) —
/// scoped per-exchange-row and reset on view recycle (fine: expansion is a transient reading aid,
/// not persisted state).
private struct TranscriptExchangeRow: View {
    let exchange: Exchange
    /// mac-chat-parity Task 3 — see `TranscriptView.cardWiring`.
    let cardWiring: InteractionCardWiring
    /// diff-tabs Task 9 — see `TranscriptView.onOpenDiff`. Carried, never captured: this view is a
    /// pure function of its inputs and the closure is one of them.
    var onOpenDiff: ((FileDiffRef) -> Void)? = nil
    /// editor-product Task 6 — see `TranscriptView.onOpenFile`. Same carried-not-captured reasoning.
    var onOpenFile: ((String) -> Void)? = nil
    /// editor-product Task 6 — see `WindowContentView.sessionHasWorkingDirectory`'s own doc.
    var sessionHasWorkingDirectory: Bool = false
    /// Non-nil only for the LAST exchange while a reply is actively streaming (v1's synthetic
    /// trailing-stream mechanism) — `TranscriptView.body` computes this per-index so this view
    /// stays a pure function of its own inputs.
    let streamingText: String?
    /// True only for the LAST exchange while its turn is still running — the tool rows' gate for
    /// drawing a running glyph. Same per-index computation as `streamingText`, and for the same
    /// reason: this view stays a pure function of its inputs.
    let turnIsLive: Bool
    let tint: Color

    @State private var expandedRuns: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !exchange.prompt.isEmpty {
                TranscriptUserBubble(text: exchange.prompt, tint: tint)
            }
            ForEach(Array(groupActivity(exchange.activity).enumerated()), id: \.offset) { index, group in
                switch group {
                case .toolRun(let entries):
                    let key = toolRunExpansionKey(entries, fallbackIndex: index)
                    TranscriptToolGroupRow(
                        entries: entries,
                        turnIsLive: turnIsLive,
                        isExpanded: expandedRuns.contains(key),
                        toggle: { toggle(key) },
                        onOpenDiff: onOpenDiff,
                        onOpenFile: onOpenFile,
                        sessionHasWorkingDirectory: sessionHasWorkingDirectory
                    )
                case .single(let item):
                    // mac-chat-parity Task 3: an approval/question/plan draws its CARD here, in the
                    // ACTIVITY order it was asked in — pending while the daemon waits, frozen with
                    // its outcome forever after. Every other kind stays the one-line activity row.
                    //
                    // "In activity order" is the whole claim, and it is narrower than it reads:
                    // this loop runs BEFORE the replies loop below, so every card sits above EVERY
                    // reply in the exchange — a card asked in round 3 draws above round 1's prose.
                    // That is the same deliberate not-interleaved layout the replies loop's own
                    // comment records (research §5 item 6, Large, out of scope for this branch); the
                    // card simply inherits it. Named because a live gate reads a round-3 card above
                    // round-1 prose as misplacement otherwise.
                    if let record = item.interactionRecord {
                        // A PENDING question renders nowhere here — the composer has become it
                        // (`composerMorphQuestion`, user call 2026-08-12, iOS's SP-ask-morph). It
                        // reappears in this exact slot the moment it is answered, frozen with what
                        // was chosen, so the scrollback record Task 3 exists to keep is unaffected:
                        // the only thing that changed is where an UNANSWERED question is shown.
                        //
                        // Approvals and plans are untouched and still draw here while pending.
                        if !questionMorphsTheComposer(record, closed: cardWiring.closedAsks) {
                            TranscriptInteractionCard(record: record, wiring: cardWiring)
                        }
                    } else {
                        TranscriptActivityRow(item: item)
                    }
                }
            }
            // One row per assistant message, in arrival order (mac-chat-parity Task 1) — the
            // engine emits one per ROUND, and this used to render a single string that each round
            // overwrote. The streaming row is ADDITIVE, not an `else` branch: while round N streams,
            // rounds 1…N-1 stay on screen instead of being hidden until the turn ends.
            // mac-chat-parity Task 8: `.assistant` — the transcript reply IS `docs/brand.md` § 4's
            // serif allowlist binding #4, and these two are the only call sites that pass it. Both
            // plan-card bodies compose this same view with `.sans`.
            ForEach(Array(exchange.replies.enumerated()), id: \.offset) { _, reply in
                TranscriptAssistantMessage(text: reply, isStreaming: false, role: .assistant)
            }
            if let streamingText {
                TranscriptAssistantMessage(text: streamingText, isStreaming: true, role: .assistant)
            }
            if exchange.aborted { TranscriptStoppedRow() }
        }
    }

    private func toggle(_ key: String) {
        if expandedRuns.contains(key) {
            expandedRuns.remove(key)
        } else {
            expandedRuns.insert(key)
        }
    }
}
