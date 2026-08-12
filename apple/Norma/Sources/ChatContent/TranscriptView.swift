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
            .overlay(alignment: .bottomTrailing) {
                if showLatestPill { latestPill(proxy) }
            }
        }
    }

    /// Extracted from `body` (Task-4 review, minor): the chained ScrollViewReader expression sat
    /// at SourceKit's type-check complexity cliff — keep `body` shallow so future edits don't
    /// tip it over.
    private func latestPill(_ proxy: ScrollViewProxy) -> some View {
        Button {
            scrollToBottom(proxy)
        } label: {
            Label("latest", systemImage: "arrow.down")
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(.thinMaterial))
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
/// `.task` entirely), one row per assistant message plus the live streaming row, stopped flag. Activity and replies are NOT interleaved chronologically — every tool row
/// precedes every reply row, because `Exchange` stores them in two separate lists; making the
/// transcript event-shaped is a separate, larger change (spec §5 item 6). A
/// dedicated `View` (not a `@ViewBuilder` func on `TranscriptView`) because it owns its own
/// expansion `@State` — which tool runs are expanded, keyed by `toolRunExpansionKey` (the run's
/// first `callId`, NOT its position: the reducer's drop-oldest activity cap shifts positions during
/// a marathon turn, which would silently re-point an open row at a neighbouring run's output) —
/// scoped per-exchange-row and reset on view recycle (fine: expansion is a transient reading aid,
/// not persisted state).
private struct TranscriptExchangeRow: View {
    let exchange: Exchange
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
                        toggle: { toggle(key) }
                    )
                case .single(let item):
                    TranscriptActivityRow(item: item)
                }
            }
            // One row per assistant message, in arrival order (mac-chat-parity Task 1) — the
            // engine emits one per ROUND, and this used to render a single string that each round
            // overwrote. The streaming row is ADDITIVE, not an `else` branch: while round N streams,
            // rounds 1…N-1 stay on screen instead of being hidden until the turn ends.
            ForEach(Array(exchange.replies.enumerated()), id: \.offset) { _, reply in
                TranscriptAssistantMessage(text: reply, isStreaming: false)
            }
            if let streamingText {
                TranscriptAssistantMessage(text: streamingText, isStreaming: true)
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
