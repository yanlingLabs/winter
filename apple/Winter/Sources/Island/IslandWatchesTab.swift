import SwiftUI
import WinterCUPresentation
import WinterKit

// The Winter island's Watches tab in the island's visual language (`docs/claude/island.md`): each armed computer-use
// watch as a quiet row — what the agent waits for, the session it is in (muted) — over a thin line that fills as its
// time runs out (armed → expires). Under the pointer the condition lifts, the line says how long ago it was armed and
// how long is left inside itself, the target shows, and Stop appears (`computerUse.wakes.cancel`, the store's own
// `disarmWatch`). A Stop in flight, or one that failed, stays on screen whatever the pointer does.

enum IslandWatchesPresentation {
    /// PURE: how much of a watch's time has run, 0…1 (armed → expires; a watch with no span is full).
    static func elapsed(_ w: IslandWatchItem, nowMs: Int) -> Double {
        let span = w.expiresAt - w.armedAt
        guard span > 0 else { return 1 }
        return min(1, max(0, Double(nowMs - w.armedAt) / Double(span)))
    }

    /// PURE: a span as the tab says it — "under a minute", "4 min", "2 h", "1 h 10 min".
    static func span(_ ms: Int) -> String {
        let minutes = max(0, ms) / 60_000
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }

    /// PURE: what a hovered watch line says inside itself — when it was armed, glued to the fill's end ("armed 4 min
    /// ago"), and what is left at the track's end ("56 min left"): the time line's own two halves.
    static func lineWords(_ w: IslandWatchItem, nowMs: Int) -> HoverLineWords {
        let armed = nowMs - w.armedAt < 60_000 ? "armed just now" : "armed \(span(nowMs - w.armedAt)) ago"
        return HoverLineWords(atFill: armed, end: "\(span(w.expiresAt - nowMs)) left")
    }

    /// PURE: a watch row as VoiceOver says it — the condition, session and target, and its time line (or why its Stop
    /// failed): what the row showed as text at rest before, now partly only inside its line under the pointer.
    static func accessibilityLabel(_ w: IslandWatchItem, nowMs: Int, error: String?) -> String {
        "\(islandWatchConditionLine(w)), \(islandWatchSessionLine(w)) · \(w.targetLabel), \(error ?? islandWatchTimeLine(w, nowMs: nowMs))"
    }

    /// PURE: the muted words beside the condition — its session at rest; its session and target under the pointer.
    static func sideWords(_ w: IslandWatchItem, hovered: Bool) -> String {
        hovered ? "\(islandWatchSessionLine(w)) · \(w.targetLabel)" : islandWatchSessionLine(w)
    }
}

/// Every armed computer-use watch, each a quiet row with Stop under the pointer.
struct IslandWatchesTab: View {
    @ObservedObject var activity: IslandActivityStore
    var scrolls = true
    /// Epoch ms (the gallery passes a fixed one).
    var nowMs: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }

    var body: some View {
        if activity.watches.isEmpty {
            IslandEmptyTab(symbol: "eye", line: "Nothing is being watched")
        } else {
            IslandTabScroll(scrolls: scrolls) { rows }
        }
    }

    private var rows: some View {
        let now = nowMs()
        return VStack(alignment: .leading, spacing: IslandQuietWatchRow.gap) {
            ForEach(activity.watches, id: \.wakeId) { watch in
                IslandQuietWatchRow(watch: watch, nowMs: now, stopping: activity.disarming.contains(watch.wakeId),
                                    error: activity.disarmErrors[watch.wakeId]) { activity.disarmWatch(watch) }
            }
        }
        .padding(.horizontal, IslandQuietRow.inset)
        .padding(.top, 2)
        .padding(.bottom, IslandLayout.listInset)
    }
}

struct IslandQuietWatchRow: View {
    let watch: IslandWatchItem
    let nowMs: Int
    let stopping: Bool
    let error: String?
    let onStop: () -> Void

    static let gap: CGFloat = 10

    var body: some View {
        HoverLiftReader(id: "watch:\(watch.wakeId)") { hovered in
            let actions = IslandQuietRow.showsActions(hovered: hovered, busy: stopping || error != nil)
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: IslandQuietRow.lineGap) {
                    HStack(spacing: 8) {
                        Image(systemName: islandWatchSymbol(watch.condition))
                            .font(Typography.caption(.semibold))
                            .foregroundStyle(IslandCUColors.accent)
                            .frame(width: IslandQuietRow.markWidth)
                        Text(islandWatchConditionLine(watch))
                            .font(Typography.composerField())
                            .foregroundStyle(Color.white.opacity(hovered ? 1 : 0.9))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .hoverLiftLabel(hovered)
                            .padding(.trailing, hovered ? 18 : 0)
                            .layoutPriority(1)
                        Spacer(minLength: 8)
                        // A failed Stop says so, in amber, at rest too.
                        Text(error ?? IslandWatchesPresentation.sideWords(watch, hovered: hovered))
                            .font(Typography.tiny())
                            .foregroundStyle(error == nil ? Theme.textMuted : pillReviewAmber)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .frame(height: IslandQuietRow.titleHeight)
                    HoverLine(fraction: IslandWatchesPresentation.elapsed(watch, nowMs: nowMs), color: IslandCUColors.accent,
                              hovered: hovered, words: IslandWatchesPresentation.lineWords(watch, nowMs: nowMs))
                        .padding(.leading, IslandQuietRow.markWidth + 8)
                }
                // Stop's column is kept at rest: nothing moves when it appears.
                IslandAnswerButton(role: .refuse, symbol: "stop.fill", enabled: !stopping, action: onStop)
                    .accessibilityLabel("Stop waiting")
                    .opacity(actions ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(IslandWatchesPresentation.accessibilityLabel(watch, nowMs: nowMs, error: error))
    }
}
