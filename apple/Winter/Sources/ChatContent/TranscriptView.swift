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
    /// Transcript file links — see `WindowContentView.fileMentionBaseDirectory`'s own doc.
    var fileMentionBaseDirectory: String? = nil
    /// How far the floating composer covers the transcript's bottom (the shell, where the
    /// transcript runs beneath it) — the "latest" pill sits above it. Zero elsewhere.
    var bottomOverlayInset: CGFloat = 0
    @State private var nearBottom = true
    @State private var showLatestPill = false
    /// Follows the bottom on the display's clock (`TranscriptAutoFollow`) — the smooth glide that
    /// replaced a `scrollTo` animation per streamed chunk.
    @State private var follower = TranscriptFollower()
    /// Which tool runs and pills are open, for the whole transcript (`TranscriptExpansion`) — here
    /// rather than per exchange row, so a row the lazy stack recycles comes back as it was.
    @State private var expansion = TranscriptExpansion()
    @Environment(\.transcriptSeededExpansion) private var seededExpansion
    /// Told when a history that arrived into this transcript has come to rest at its bottom.
    @Environment(\.transcriptOnLanded) private var onLanded

    var body: some View {
        // The reader lets the follower make its far moves through SwiftUI (`TranscriptFollower.farJump`).
        ScrollViewReader { proxy in
            transcriptScroll
                .onAppear {
                    follower.onLanded = onLanded
                    follower.farJump = { [adapter] in
                        let count = adapter.transcript.count
                        if count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) }
                    }
                }
        }
        // The pill-themed tool pills read this to show a call under safety review (`PillToolRunHeader`).
        .environment(\.reviewingCallIds, adapter.reviewingCallIds)
    }

    private var transcriptScroll: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(Array(adapter.transcript.enumerated()), id: \.offset) { index, exchange in
                    let isLast = index == adapter.transcript.count - 1
                    TranscriptExchangeRow(
                        exchange: exchange,
                        exchangeIndex: index,
                        expansion: $expansion,
                        liveThinkingText: { [adapter] in adapter.liveThinkingText($0) },
                        cardWiring: cardWiring,
                        onOpenDiff: onOpenDiff,
                        onOpenFile: onOpenFile,
                        sessionHasWorkingDirectory: sessionHasWorkingDirectory,
                        fileMentionBaseDirectory: fileMentionBaseDirectory,
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
            // ChatGPT's reading column (2026-09-17): the messages sit in a centred column the
            // composer's width, while the scroll view itself stays full width (scrolling and
            // the scroller work anywhere in the pane).
            .frame(maxWidth: newChatCardWidth)
            .frame(maxWidth: .infinity)
            .background(TranscriptAutoFollow(follower: follower))
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
            // A history arriving into an empty transcript (a window opening — its replay lands in one
            // fold, `SessionFeed.finishReplay`) lands at its bottom at once, never glides down it —
            // through SwiftUI's own scroll-to-row, once the rows exist (`TranscriptFollower.farJump`).
            if old == 0 && new > 0 {
                follower.restartAtBottom()
                DispatchQueue.main.async { follower.farJump?() }
            } else if new > old {
                follow()
            }
            // A reset (another session's history coming in) opens at the bottom again, all closed.
            if new == 0 && old > 0 {
                follower.restartAtBottom()
                expansion.removeAll()
            }
        }
        .onChange(of: adapter.liveStreamingText) { old, new in
            if (new?.count ?? 0) > (old?.count ?? 0) { follow() }
        }
        // mac-chat-parity Task 3: a card arriving is content growth the two signals above cannot
        // see — an ask lands in the LAST exchange's `activity`, which changes neither the
        // exchange count nor the streaming text. Before the cards moved inline this did not
        // matter (the band was pinned, always visible); now, without this, an approval could
        // appear below the fold and the agent would look hung. Growth-only, for the same reason
        // the count watcher is (`SessionModel.reset()` drops it to zero on refocus, and a reset
        // must neither follow nor raise the pill).
        .onChange(of: adapter.pendingInteractions.count) { old, new in
            if new > old { follow() }
        }
        .overlay(alignment: .bottomTrailing) {
            // Above the floating composer when the transcript runs beneath it.
            if showLatestPill { latestPill.padding(.bottom, bottomOverlayInset) }
        }
        .onAppear {
            follower.onFollowingChanged = { following in
                if following { showLatestPill = false }
            }
            if !seededExpansion.isEmpty { expansion.open(seededExpansion) }
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
    private var latestPill: some View {
        Button {
            showLatestPill = false
            follower.jumpToBottom()
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

    /// Content grew: the follower glides after it if the user is at the bottom; otherwise the
    /// "latest" pill offers the way back.
    private func follow() {
        if shouldAutoscroll(nearBottom: follower.isFollowing, contentGrew: true) {
            follower.nudge()
        } else {
            showLatestPill = true
        }
    }
}

/// One exchange's rows — prompt bubble, GROUPED activity (LIVE-GATE G3 / r1b: `groupActivity`
/// folds any UNBROKEN run of tool calls — even across different tool names — into one `.toolRun`
/// sentence row carrying its status and expanding to every call's arguments and output, skips
/// `.task` entirely), one row per assistant message plus the live streaming row, stopped flag.
///
/// Activity and replies ARE interleaved in arrival order (2026-10-02, `exchangeTimeline`): `Exchange`
/// still stores them in two lists, but records where each reply fell among the activity. Which tool
/// runs and pills are open is NOT this row's state: it reads and toggles the transcript's one
/// `TranscriptExpansion` (`TranscriptView.expansion`), keyed by item identity — a run's
/// `toolRunExpansionKey` (its first `callId`, NOT its position: the reducer's drop-oldest activity cap
/// shifts positions during a marathon turn, which would silently re-point an open row at a
/// neighbouring run's output), a reasoning block's `thinkingExpansionKey` — so a row the lazy stack
/// recycles comes back as it was (expansion is still a transient reading aid, never persisted).
private struct TranscriptExchangeRow: View {
    let exchange: Exchange
    /// The exchange's place in the transcript — scopes a positional expansion key
    /// (`transcriptExpansionKey`).
    let exchangeIndex: Int
    /// The transcript's open rows and pills (`TranscriptView.expansion`).
    @Binding var expansion: TranscriptExpansion
    /// A streaming reasoning block's text so far (`FieldStateAdapter.liveThinkingText`), read only for
    /// an OPEN thinking pill.
    let liveThinkingText: (String) -> String?
    /// mac-chat-parity Task 3 — see `TranscriptView.cardWiring`.
    let cardWiring: InteractionCardWiring
    /// diff-tabs Task 9 — see `TranscriptView.onOpenDiff`. Carried, never captured: this view is a
    /// pure function of its inputs and the closure is one of them.
    var onOpenDiff: ((FileDiffRef) -> Void)? = nil
    /// editor-product Task 6 — see `TranscriptView.onOpenFile`. Same carried-not-captured reasoning.
    var onOpenFile: ((String) -> Void)? = nil
    /// editor-product Task 6 — see `WindowContentView.sessionHasWorkingDirectory`'s own doc.
    var sessionHasWorkingDirectory: Bool = false
    /// Transcript file links — see `WindowContentView.fileMentionBaseDirectory`'s own doc.
    var fileMentionBaseDirectory: String? = nil
    /// Non-nil only for the LAST exchange while a reply is actively streaming (v1's synthetic
    /// trailing-stream mechanism) — `TranscriptView.body` computes this per-index so this view
    /// stays a pure function of its own inputs.
    let streamingText: String?
    /// True only for the LAST exchange while its turn is still running — the tool rows' gate for
    /// drawing a running glyph. Same per-index computation as `streamingText`, and for the same
    /// reason: this view stays a pure function of its inputs.
    let turnIsLive: Bool
    let tint: Color

    @Environment(\.transcriptToolRowStyle) private var toolRowStyle

    /// The replies' file door — only where the window layer wired `onOpenFile`, so the orb's morph
    /// window and detached windows keep plain replies.
    private var fileDoor: TranscriptFileDoor? {
        onOpenFile.map { open in
            TranscriptFileDoor(baseDirectory: fileMentionBaseDirectory,
                               sessionHasWorkingDirectory: sessionHasWorkingDirectory,
                               open: open)
        }
    }

    var body: some View {
        // Only the turn's final reply carries the copy button (`exchangeFinalReplyIndex`).
        let finalReply = exchangeFinalReplyIndex(exchange, isStreaming: streamingText != nil)
        VStack(alignment: .leading, spacing: 10) {
            if !exchange.prompt.isEmpty || exchange.promptEnvelope != nil {
                TranscriptUserBubble(text: exchange.prompt, tint: tint, envelope: exchange.promptEnvelope)
            }
            // Tools, cards and replies in the order they happened (`exchangeTimeline`, user
            // 2026-10-02): each reply after exactly the activity that preceded it, so a "search,
            // write, search, write" turn reads that way instead of every search first.
            ForEach(Array(timeline.enumerated()), id: \.offset) { _, entry in
                switch entry {
                case .group(let index, let group):
                    activityGroupRow(group, index: index)
                case .pillRow(let items):
                    pillRow(items)
                case .reply(let index):
                    // One row per assistant message (mac-chat-parity Task 1) — the engine emits one
                    // per ROUND. `.assistant`: the transcript reply IS `docs/brand.md` § 4's serif
                    // allowlist binding #4. A FINISHED reply gets the file door (2026-09-30); the
                    // streaming row below never does (`TranscriptAssistantMessage.fileDoor`'s doc).
                    TranscriptAssistantMessage(text: exchange.replies[index], isStreaming: false, role: .assistant,
                                               fileDoor: fileDoor, showsCopyButton: index == finalReply)
                        .equatable()
                }
            }
            // The streaming row is ADDITIVE: while round N streams, rounds 1…N-1 stay on screen.
            if let streamingText {
                TranscriptAssistantMessage(text: streamingText, isStreaming: true, role: .assistant)
            }
            if exchange.aborted { TranscriptStoppedRow() }
        }
    }

    /// One timeline entry: an activity group (numbered across the whole exchange, so a tool run's
    /// fallback expansion key stays unique) or a reply.
    private enum TimelineEntry {
        case group(index: Int, ActivityGroup)
        case reply(Int)
        /// Consecutive tools' pills — and thinking pills — side by side (pill-themed window only).
        case pillRow([PillRowItem])
    }

    /// One pill in a row: a tool's calls, or a reasoning block (the thinking pill, 2026-10-05).
    private enum PillRowItem {
        case tool(index: Int, entry: ToolRunEntry)
        case thinking(ThinkingItem)
    }

    private var timeline: [TimelineEntry] {
        var entries: [TimelineEntry] = []
        var groupIndex = 0
        var row: [PillRowItem] = []
        func closeRow() {
            if !row.isEmpty { entries.append(.pillRow(row)); row = [] }
        }
        for segment in exchangeTimeline(exchange) {
            switch segment {
            case .activity(let items):
                for group in groupActivity(items) {
                    // The pill-themed window gives each tool its own pill and lays consecutive ones
                    // side by side (user, 2026-10-02): a stretch that searched, read pages and ran
                    // commands is one row of three pills, each with its own words.
                    if toolRowStyle == .pill, case .toolRun(let runs) = group {
                        for run in runs {
                            row.append(.tool(index: groupIndex, entry: run))
                            groupIndex += 1
                        }
                    } else if toolRowStyle == .pill, case .single(let item) = group, let thinking = item.thinkingItem {
                        // The thinking pill joins the same flow as the tool pills where adjacent.
                        row.append(.thinking(thinking))
                        groupIndex += 1
                    } else {
                        closeRow()
                        entries.append(.group(index: groupIndex, group))
                        groupIndex += 1
                    }
                }
            case .reply(let index):
                closeRow()
                entries.append(.reply(index))
            }
        }
        closeRow()
        return entries
    }

    /// A row of tool pills, then — beneath it — each pill's body that has something to show: an
    /// opened pill's calls, a failure line, its diff chips.
    /// The open-state key of a tool pill, unique across the transcript.
    private func toolKey(_ entry: ToolRunEntry, index: Int) -> String {
        transcriptExpansionKey(toolRunExpansionKey([entry], fallbackIndex: index), exchangeIndex: exchangeIndex)
    }

    /// Whether a pill is open INTO itself right now — a thinking pill with text, a search pill — and so
    /// takes a line of its own (`PillFlowFullWidth`).
    private func isOpenInPlace(_ item: PillRowItem) -> Bool {
        switch item {
        case .tool(let index, let entry):
            return PillToolRunHeader.opensInPlace(entry) && expansion.contains(toolKey(entry, index: index))
        case .thinking(let thinking):
            return openThinkingText(thinking) != nil
        }
    }

    /// The text an OPEN thinking pill shows — nil while it is closed or has nothing readable yet (a
    /// live block whose increments so far are whitespace). The live buffer is read only for a pill
    /// that is open: its text is O(n).
    private func openThinkingText(_ thinking: ThinkingItem) -> String? {
        guard thinkingHasReadableText(thinking), expansion.contains(thinkingExpansionKey(thinking.blockId)) else { return nil }
        return thinkingDisplayText(thinking, liveText: thinking.isLive ? liveThinkingText(thinking.blockId) : nil)
    }

    @ViewBuilder
    private func pillRow(_ items: [PillRowItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            PillFlowLayout(spacing: 8, lineSpacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    pill(item)
                        .layoutValue(key: PillFlowFullWidth.self, value: isOpenInPlace(item))
                }
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if case .tool(let index, let entry) = item {
                    toolPillBody(entry, index: index)
                }
            }
        }
    }

    @ViewBuilder
    private func pill(_ item: PillRowItem) -> some View {
        switch item {
        case .tool(let index, let entry):
            let key = toolKey(entry, index: index)
            PillToolRunHeader(entries: [entry], turnIsLive: turnIsLive, isExpanded: expansion.contains(key),
                              toggle: { toggle(key, morph: PillToolRunHeader.opensInPlace(entry)) })
        case .thinking(let thinking):
            let key = thinkingExpansionKey(thinking.blockId)
            let text = openThinkingText(thinking)
            PillThinkingHeader(item: thinking, turnIsLive: turnIsLive, isExpanded: text != nil, text: text,
                               toggle: { toggle(key, morph: true) })
        }
    }

    /// Beneath a tool pill: its opened calls, a failure line, its diff chips — when it has any. A
    /// search pill opens into itself instead, so it shows nothing here while open.
    @ViewBuilder
    private func toolPillBody(_ entry: ToolRunEntry, index: Int) -> some View {
        let key = toolKey(entry, index: index)
        let opensInPlace = PillToolRunHeader.opensInPlace(entry)
        let expanded = expansion.contains(key) && !opensInPlace
        if opensInPlace && expansion.contains(key) {
            EmptyView()
        } else if expanded || toolRunFailureSummary([entry]) != nil
            || !toolRunCollapsedDiffChips([entry]).chips.isEmpty {
            TranscriptToolGroupRow(
                entries: [entry],
                turnIsLive: turnIsLive,
                isExpanded: expanded,
                toggle: { toggle(key, morph: false) },
                onOpenDiff: onOpenDiff,
                onOpenFile: onOpenFile,
                sessionHasWorkingDirectory: sessionHasWorkingDirectory,
                showsHeader: false
            )
        }
    }

    @ViewBuilder
    private func activityGroupRow(_ group: ActivityGroup, index: Int) -> some View {
        switch group {
        case .toolRun(let entries):
            let key = transcriptExpansionKey(toolRunExpansionKey(entries, fallbackIndex: index), exchangeIndex: exchangeIndex)
            TranscriptToolGroupRow(
                entries: entries,
                turnIsLive: turnIsLive,
                isExpanded: expansion.contains(key),
                toggle: { toggle(key, morph: false) },
                onOpenDiff: onOpenDiff,
                onOpenFile: onOpenFile,
                sessionHasWorkingDirectory: sessionHasWorkingDirectory
            )
        case .single(let item):
            // mac-chat-parity Task 3: an approval/question/plan draws its CARD here, where it was
            // asked — now in true order among the replies too — pending while the daemon waits,
            // frozen with its outcome forever after. Every other kind stays the one-line row.
            if let record = item.interactionRecord {
                // A PENDING question renders nowhere here — the composer has become it
                // (`composerMorphQuestion`, user call 2026-08-12). It reappears in this exact slot
                // the moment it is answered, frozen with what was chosen.
                if !questionMorphsTheComposer(record, closed: cardWiring.closedAsks) {
                    TranscriptInteractionCard(record: record, wiring: cardWiring)
                }
            } else if let thinking = item.thinkingItem {
                // The thinking pill (2026-10-05), in the quiet line style of every other activity row.
                TranscriptThinkingRow(item: thinking, turnIsLive: turnIsLive)
            } else {
                TranscriptActivityRow(item: item)
            }
        }
    }

    /// Opens or closes one row or pill. A pill that opens into itself morphs on a spring
    /// (`pillMorphAnimation`); every other row keeps its own short animation.
    private func toggle(_ key: String, morph: Bool) {
        if morph {
            withAnimation(pillMorphAnimation) { expansion.toggle(key) }
        } else {
            expansion.toggle(key)
        }
    }
}

private struct TranscriptOnLandedKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Told when a history arriving into an empty transcript has come to rest at its bottom
    /// (`TranscriptFollower.onLanded`) — the session window's loading screen waits for it.
    var transcriptOnLanded: (() -> Void)? {
        get { self[TranscriptOnLandedKey.self] }
        set { self[TranscriptOnLandedKey.self] = newValue }
    }
}
