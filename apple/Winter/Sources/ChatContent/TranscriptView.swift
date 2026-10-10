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
    /// The first exchange the transcript holds, once it is longer than `cellWindow`; nil until the window has been
    /// pinned (`firstExchange(of:)`).
    @State private var windowStartExchange: Int?
    /// Follows the bottom on the display's clock (`TranscriptAutoFollow`) — the smooth glide that
    /// replaced a `scrollTo` animation per streamed chunk.
    @State private var follower = TranscriptFollower()
    /// Which tool runs and pills are open, for the whole transcript (`TranscriptExpansion`) — here
    /// rather than per exchange row, so a row the lazy stack recycles comes back as it was.
    @State private var expansion = TranscriptExpansion()
    /// What each exchange's timeline was worked out to, by the exchange's content stamp (`TranscriptLayoutMemo`).
    @State private var layoutMemo = TranscriptLayoutMemo()
    @Environment(\.transcriptSeededExpansion) private var seededExpansion
    @Environment(\.transcriptToolRowStyle) private var toolRowStyle
    /// Told when a history that arrived into this transcript has come to rest at its bottom.
    @Environment(\.transcriptOnLanded) private var onLanded

    var body: some View {
        // The reader lets the follower make its far moves through SwiftUI (`TranscriptFollower.farJump`).
        ScrollViewReader { proxy in
            transcriptScroll(proxy: proxy)
                .onAppear {
                    follower.onLanded = onLanded
                    follower.farJump = { [layoutMemo] in
                        if let last = layoutMemo.lastCellID { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
        }
        // The pill-themed tool pills read this to show a call under safety review (`PillToolRunHeader`).
        .environment(\.reviewingCallIds, adapter.reviewingCallIds)
    }

    /// Every cell of the transcript, in order: for each exchange its prompt, one cell per timeline entry (a row of
    /// pills, a reply, a card…), its stopped line, and — for the newest while a reply streams — the reply itself.
    ///
    /// **One cell per entry, not one per exchange** (2026-10-09): a lazy stack realizes the cells that are on screen,
    /// and a publish from the session marks everything REALIZED dirty, a cost that grew with the number of items
    /// held (measured: 6 ms with nothing in the transcript, 19 ms with 96 items, for a publish that changed nothing).
    /// With the exchange as the cell, a turn of two hundred tool calls was one cell with all of them realized; as
    /// cells, only those near the viewport are, and each skips its body unless what it shows changed.
    ///
    /// Spacing is each cell's own top gap rather than the stack's: 14 pt separates exchanges, 10 pt separates the
    /// cells of one.
    ///
    /// Only the exchanges from `first` on are built: the transcript holds its newest few hundred cells, never all of a
    /// long session's (`firstExchange(of:)`), so what a publish costs does not grow with how long the session has run.
    private func cellSpecs(_ transcript: [Exchange], from first: Int, streaming: String?, cards: TranscriptCardState) -> [TranscriptCellSpec] {
        var specs: [TranscriptCellSpec] = []
        var known: Set<TranscriptLayoutMemo.Key> = []
        for (index, exchange) in transcript.enumerated() where index >= first {
            let isLast = index == transcript.count - 1
            // Live only for the newest exchange (mac-chat-parity Task 2). That is not quite the same as "every in-flight
            // call lives here": a main-thread steer's `user_message` is persisted at SEND time, so it can open a NEW
            // exchange while a call in the previous one is still out — the case `SessionReducer.foldToolResult` scans
            // backwards for, pinned by `testToolResultFoldsIntoAnEarlierExchangeWhenASteerOpenedANewOne`. Such a call
            // reads "no result" rather than "running" until its result lands, then corrects itself. Deliberate:
            // erring toward "no result" is recoverable, while a false "running" is the permanent lie this whole gate
            // exists to prevent.
            let turnIsLive = isLast && adapter.turnRunning
            let streamingText = isLast ? streaming : nil
            let layout = layoutMemo.layout(for: exchange, style: toolRowStyle)
            known.insert(layout.key)
            let base = index * TranscriptCellSpec.idStride
            var cells: [(id: Int, content: TranscriptCellContent)] = []
            if !exchange.prompt.isEmpty || exchange.promptEnvelope != nil {
                cells.append((base, .prompt(text: exchange.prompt, envelope: exchange.promptEnvelope)))
            }
            let finalReply = streamingText == nil ? layout.finalReply : nil
            for (offset, entry) in layout.entries.enumerated() {
                let id = base + TranscriptCellSpec.firstEntryOffset + offset
                switch entry {
                case .group(let groupIndex, let group):
                    if let content = groupContent(group, index: groupIndex, exchangeIndex: index, cards: cards) {
                        cells.append((id, content))
                    }
                case .pillRow(let items):
                    cells.append((id, .pillRow(items: items, open: items.map { pillIsOpen($0, exchangeIndex: index) })))
                case .reply(let replyIndex):
                    cells.append((id, .reply(text: exchange.replies[replyIndex], showsCopy: replyIndex == finalReply)))
                }
            }
            if exchange.aborted { cells.append((base + TranscriptCellSpec.stoppedOffset, .stopped)) }
            if let streamingText { cells.append((base + TranscriptCellSpec.streamingOffset, .streaming(streamingText))) }
            for (position, cell) in cells.enumerated() {
                specs.append(TranscriptCellSpec(id: cell.id, exchangeIndex: index, content: cell.content, turnIsLive: turnIsLive,
                                                topGap: specs.isEmpty ? 0 : (position == 0 ? 14 : 10)))
            }
        }
        layoutMemo.keep(known)
        layoutMemo.lastCellID = specs.last?.id
        return specs
    }

    /// A non-pill activity row's content, or nil when it draws nothing (a pending question the composer has become).
    private func groupContent(_ group: ActivityGroup, index: Int, exchangeIndex: Int, cards: TranscriptCardState) -> TranscriptCellContent? {
        switch group {
        case .toolRun(let entries):
            let key = transcriptExpansionKey(toolRunExpansionKey(entries, fallbackIndex: index), exchangeIndex: exchangeIndex)
            return .group(index: index, group: group, isExpanded: expansion.contains(key), cards: nil)
        case .single(let item):
            if let record = item.interactionRecord {
                if questionMorphsTheComposer(record, closed: cards.closedAsks) { return nil }
                return .group(index: index, group: group, isExpanded: false, cards: cards)
            }
            return .group(index: index, group: group, isExpanded: false, cards: nil)
        }
    }

    /// Whether a pill in an exchange's row is open (the tool pills' key, the thinking pill's block).
    private func pillIsOpen(_ item: PillRowItem, exchangeIndex: Int) -> Bool {
        switch item {
        case .tool(let index, let entry):
            return expansion.contains(transcriptExpansionKey(toolRunExpansionKey([entry], fallbackIndex: index), exchangeIndex: exchangeIndex))
        case .thinking(let thinking):
            return thinkingHasReadableText(thinking) && expansion.contains(thinkingExpansionKey(thinking.blockId))
        }
    }

    /// The newest cells the transcript holds, in whole exchanges (an exchange is never cut: a turn of two hundred calls
    /// is one), and about how many more "Show earlier" adds.
    static let cellWindow = 80

    /// The first exchange held: the pinned one, else far enough back from the end to hold `cellWindow` cells. Walking
    /// back touches only the tail's layouts (`TranscriptLayoutMemo` answers each from its stamp).
    private func firstExchange(of transcript: [Exchange]) -> Int {
        if let pinned = windowStartExchange, pinned < transcript.count { return pinned }
        return Self.exchangeIndex(holding: Self.cellWindow, endingBefore: transcript.count) { index in
            // The prompt, and one cell per timeline entry.
            1 + layoutMemo.layout(for: transcript[index], style: toolRowStyle).entries.count
        }
    }

    /// PURE: how far back from `end` to reach for `cells` cells, given each exchange's cell count.
    static func exchangeIndex(holding cells: Int, endingBefore end: Int, cellCount: (Int) -> Int) -> Int {
        var held = 0
        var index = end
        while index > 0, held < cells {
            index -= 1
            held += cellCount(index)
        }
        return index
    }

    /// Holds the window where it is, so exchanges arriving at the bottom do not push the oldest out from under a reader
    /// who has scrolled up to it. A reader at the bottom (following) is the one case it moves on: what it drops is far
    /// above them.
    private func pinWindow() {
        windowStartExchange = adapter.transcript.count > 0 ? firstExchange(of: adapter.transcript) : nil
    }

    /// "Show earlier": another `cellWindow` cells above the first exchange held, the reader left where they were.
    private func revealEarlier(first: Int, anchor: Int, proxy: ScrollViewProxy) {
        let transcript = adapter.transcript
        windowStartExchange = Self.exchangeIndex(holding: Self.cellWindow, endingBefore: first) { index in
            1 + layoutMemo.layout(for: transcript[index], style: toolRowStyle).entries.count
        }
        DispatchQueue.main.async { proxy.scrollTo(anchor, anchor: .top) }
    }

    private func earlierRow(first: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(first == 1 ? "Show 1 earlier turn" : "Show \(first) earlier turns")
                .font(Typography.caption(.medium))
                .foregroundStyle(tint.opacity(0.85))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Capsule().fill(Theme.controlSurface))
                .overlay(Capsule().strokeBorder(Theme.hairlineElevated, lineWidth: shellSidebarHairlineWidth))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .padding(.bottom, 14)
    }

    private func transcriptScroll(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                let cards = TranscriptCardState(wiring: cardWiring, drafts: adapter.pendingCardDrafts)
                let first = firstExchange(of: adapter.transcript)
                #if DEBUG
                let _ = { transcriptFirstExchangeHeld = first }()
                #endif
                let specs = cellSpecs(adapter.transcript, from: first, streaming: adapter.liveStreamingText, cards: cards)
                if first > 0, let anchor = specs.first?.id {
                    earlierRow(first: first) { revealEarlier(first: first, anchor: anchor, proxy: proxy) }
                }
                ForEach(specs) { spec in
                    TranscriptCell(
                        exchangeIndex: spec.exchangeIndex,
                        content: spec.content,
                        expansion: $expansion,
                        liveThinking: adapter.liveThinking,
                        cardWiring: cardWiring,
                        onOpenDiff: onOpenDiff,
                        onOpenFile: onOpenFile,
                        sessionHasWorkingDirectory: sessionHasWorkingDirectory,
                        fileMentionBaseDirectory: fileMentionBaseDirectory,
                        turnIsLive: spec.turnIsLive,
                        tint: tint
                    )
                    // Rebuilt only when something it shows changed.
                    .equatable()
                    .padding(.top, spec.topGap)
                    .id(spec.id)
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
                pinWindow()
                follower.restartAtBottom()
                DispatchQueue.main.async { follower.farJump?() }
            } else if new > old {
                if follower.isFollowing { windowStartExchange = nil }
                follow()
            }
            // A reset (another session's history coming in) opens at the bottom again, all closed.
            if new == 0 && old > 0 {
                windowStartExchange = nil
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
                if following {
                    showLatestPill = false
                    windowStartExchange = nil // back at the bottom: the window is the tail again
                } else {
                    pinWindow() // scrolled away: the exchange being read stays in the window whatever arrives
                }
            }
            if !seededExpansion.isEmpty { expansion.open(seededExpansion) }
            // A window opened onto a transcript that is already there (a shared feed that was attached first) has no
            // empty-to-full change to pin the window at.
            if windowStartExchange == nil, !adapter.transcript.isEmpty { pinWindow() }
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

// MARK: - The cells

/// One timeline entry of an exchange: an activity group (numbered across the whole exchange, so a tool run's fallback
/// expansion key stays unique), a reply (by its index in `Exchange.replies`), or a row of pills.
private enum TimelineEntry: Equatable {
    case group(index: Int, ActivityGroup)
    case reply(Int)
    /// Consecutive tools' pills — and thinking pills — side by side (pill-themed window only).
    case pillRow([PillRowItem])
}

/// One pill in a row: a tool's calls, or a reasoning block (the thinking pill, 2026-10-05).
private enum PillRowItem: Equatable {
    case tool(index: Int, entry: ToolRunEntry)
    case thinking(ThinkingItem)
}

/// PURE: an exchange's entries in the order they happened (`exchangeTimeline`, user 2026-10-02): each reply after
/// exactly the activity that preceded it, so a "search, write, search, write" turn reads that way instead of every
/// search first.
private func transcriptTimeline(_ exchange: Exchange, style: TranscriptToolRowStyle) -> [TimelineEntry] {
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
                if style == .pill, case .toolRun(let runs) = group {
                    for run in runs {
                        row.append(.tool(index: groupIndex, entry: run))
                        groupIndex += 1
                    }
                } else if style == .pill, case .single(let item) = group, let thinking = item.thinkingItem {
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

/// What an exchange's timeline was worked out to, kept by the exchange's content stamp (`Exchange.stamp` moves
/// whenever its content does): every cell of a long transcript is asked for on every publish, and grouping a turn's
/// activity is linear in it.
@MainActor
private final class TranscriptLayoutMemo {
    struct Key: Hashable {
        let stamp: UInt64
        let pill: Bool
    }

    struct Layout {
        let key: Key
        let entries: [TimelineEntry]
        /// Which reply carries the copy button once nothing is streaming (`exchangeFinalReplyIndex`).
        let finalReply: Int?
    }

    private var known: [Key: Layout] = [:]
    /// The last cell of the transcript as last laid out — where a far jump lands.
    var lastCellID: Int?

    func layout(for exchange: Exchange, style: TranscriptToolRowStyle) -> Layout {
        let key = Key(stamp: exchange.stamp, pill: style == .pill)
        if let layout = known[key] { return layout }
        let layout = Layout(key: key, entries: transcriptTimeline(exchange, style: style),
                            finalReply: exchangeFinalReplyIndex(exchange, isStreaming: false))
        known[key] = layout
        return layout
    }

    /// Forgets the exchanges that are gone (a reset, an edited-out turn): only those of the last layout stay.
    func keep(_ keys: Set<Key>) {
        guard known.count > keys.count else { return }
        known = known.filter { keys.contains($0.key) }
    }
}

/// What one cell draws — a value, so a cell can be told apart from what it was without running its body.
private enum TranscriptCellContent: Equatable {
    case prompt(text: String, envelope: AgentMessageEnvelope?)
    /// A non-pill activity row. `isExpanded` is the tool run's open state; `cards` is the card state an interaction
    /// card draws from (nil for every other row, so typing in a card does not rebuild them).
    case group(index: Int, group: ActivityGroup, isExpanded: Bool, cards: TranscriptCardState?)
    /// A row of pills with which of them are open.
    case pillRow(items: [PillRowItem], open: [Bool])
    case reply(text: String, showsCopy: Bool)
    case streaming(String)
    case stopped
}

private struct TranscriptCellSpec: Identifiable {
    /// Cells of exchange `n` have ids from `n * idStride`: its prompt first, its entries from `firstEntryOffset`, then
    /// the stopped line and the streaming reply at the top of the range. Entries are capped far below the stride (the
    /// reducer keeps 200 activity items).
    static let idStride = 100_000
    static let firstEntryOffset = 1
    static let stoppedOffset = 99_998
    static let streamingOffset = 99_999

    let id: Int
    let exchangeIndex: Int
    let content: TranscriptCellContent
    let turnIsLive: Bool
    let topGap: CGFloat
}

#if DEBUG
/// The first exchange the transcript held at its last layout (the scaling benchmark reads where the window is).
nonisolated(unsafe) var transcriptFirstExchangeHeld = 0

/// How many times any transcript cell's body has run in this process: the scaling benchmark counts the cells that exist
/// (a cell built once runs its body once; an unchanged one is skipped by `.equatable()`).
nonisolated(unsafe) var transcriptCellBodyEvaluations = 0
#endif

/// One cell of the transcript. Which tool runs and pills are open is NOT this cell's state: it reads and toggles the
/// transcript's one `TranscriptExpansion` (`TranscriptView.expansion`), keyed by item identity — a run's
/// `toolRunExpansionKey` (its first `callId`, NOT its position: the reducer's drop-oldest activity cap shifts positions
/// during a marathon turn, which would silently re-point an open row at a neighbouring run's output), a reasoning
/// block's `thinkingExpansionKey` — so a cell the lazy stack recycles comes back as it was (expansion is still a
/// transient reading aid, never persisted).
private struct TranscriptCell: View {
    /// The exchange's place in the transcript — scopes a positional expansion key
    /// (`transcriptExpansionKey`).
    let exchangeIndex: Int
    let content: TranscriptCellContent
    /// The transcript's open rows and pills (`TranscriptView.expansion`). Which of them THIS cell shows is part of
    /// `content`, so it is compared there.
    @Binding var expansion: TranscriptExpansion
    /// The streaming reasoning blocks' text (`FieldStateAdapter.liveThinking`), followed only by an OPEN thinking
    /// pill's own text view.
    let liveThinking: ThinkingLiveText
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
    /// True only for the LAST exchange while its turn is still running — the tool rows' gate for
    /// drawing a running glyph. Per exchange, for the reason the whole gate exists: a false "running" is permanent.
    let turnIsLive: Bool
    let tint: Color

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
        #if DEBUG
        let _ = { transcriptCellBodyEvaluations += 1 }()
        #endif
        switch content {
        case .prompt(let text, let envelope):
            TranscriptUserBubble(text: text, tint: tint, envelope: envelope)
        case .group(let index, let group, _, _):
            activityGroupRow(group, index: index)
        case .pillRow(let items, _):
            pillRow(items)
        case .reply(let text, let showsCopy):
            // One cell per assistant message (mac-chat-parity Task 1) — the engine emits one per ROUND. `.assistant`:
            // the transcript reply IS `docs/brand.md` § 4's serif allowlist binding #4. A FINISHED reply gets the
            // file door (2026-09-30); the streaming one never does (`TranscriptAssistantMessage.fileDoor`'s doc).
            TranscriptAssistantMessage(text: text, isStreaming: false, role: .assistant, fileDoor: fileDoor, showsCopyButton: showsCopy)
        case .streaming(let text):
            // ADDITIVE: while round N streams, rounds 1…N-1 stay on screen.
            TranscriptAssistantMessage(text: text, isStreaming: true, role: .assistant)
        case .stopped:
            TranscriptStoppedRow()
        }
    }

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
            return thinkingIsOpen(thinking)
        }
    }

    /// Whether a thinking pill is open: it was asked open and its block has something to show. A streaming block's
    /// words are not read here — the open pill's own text view follows the live buffer — so a fold that only
    /// lengthens them does not reach this cell at all.
    private func thinkingIsOpen(_ thinking: ThinkingItem) -> Bool {
        thinkingHasReadableText(thinking) && expansion.contains(thinkingExpansionKey(thinking.blockId))
    }

    /// A row of tool pills, then — beneath it — each pill's body that has something to show: an
    /// opened pill's calls, a failure line, its diff chips.
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
                              toggle: { toggle(key, morph: PillToolRunHeader.opensInPlace(entry)) }, identity: key)
                .equatable()
        case .thinking(let thinking):
            let key = thinkingExpansionKey(thinking.blockId)
            let open = thinkingIsOpen(thinking)
            PillThinkingHeader(item: thinking, turnIsLive: turnIsLive, isExpanded: open,
                               text: open && !thinking.isLive ? thinkingDisplayText(thinking, liveText: nil) : nil,
                               live: open && thinking.isLive ? liveThinking : nil,
                               toggle: { toggle(key, morph: true) })
                .equatable()
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
                // the moment it is answered, frozen with what was chosen. (`TranscriptView` leaves the cell out
                // while that holds.)
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

/// A cell is a function of its inputs, so it is rebuilt only when one changed. The closures it carries are rebuilt
/// every pass and are not compared; which of the transcript's open rows it shows is part of its `content`.
extension TranscriptCell: Equatable {
    static func == (a: TranscriptCell, b: TranscriptCell) -> Bool {
        a.exchangeIndex == b.exchangeIndex && a.turnIsLive == b.turnIsLive && a.tint == b.tint
            && a.sessionHasWorkingDirectory == b.sessionHasWorkingDirectory
            && a.fileMentionBaseDirectory == b.fileMentionBaseDirectory
            && (a.onOpenDiff == nil) == (b.onOpenDiff == nil) && (a.onOpenFile == nil) == (b.onOpenFile == nil)
            && a.content == b.content
    }
}

/// What the interaction cards draw from — the wiring's sets and the adapter's typed-but-unsent answers — as values, so
/// a cell can tell whether a card needs redrawing without running its body.
struct TranscriptCardState: Equatable {
    var inFlight: Set<String>
    var closedAsks: Set<String>
    var errorLines: [String: String]
    var inactiveElicitations: Set<String>
    var drafts: [String: PendingCardDraft]

    init(wiring: InteractionCardWiring, drafts: [String: PendingCardDraft]) {
        inFlight = wiring.inFlight
        closedAsks = wiring.closedAsks
        errorLines = wiring.errorLines
        inactiveElicitations = wiring.inactiveElicitations
        self.drafts = drafts
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
