import SwiftUI
import WinterCUPresentation
import WinterKit

// The Winter island's Watches tab in the island's visual language (`docs/claude/island.md`): each armed computer-use
// watch as a row — what the agent waits for, and beside it the one real amount here, the TIME LEFT: a short thin line
// that empties as the watch runs out, with its minutes. Under the pointer the condition lifts and the session, the
// target and when it was armed show under it, with Stop (`computerUse.wakes.cancel`, the store's own `disarmWatch`). A
// Stop in flight, or one that failed, stays on screen whatever the pointer does.

enum IslandWatchesPresentation {
    /// PURE: how much of a watch's time is LEFT, 0…1 (armed → expires; a watch with no span has none left).
    static func left(_ w: IslandWatchItem, nowMs: Int) -> Double {
        let span = w.expiresAt - w.armedAt
        guard span > 0 else { return 0 }
        return min(1, max(0, Double(w.expiresAt - nowMs) / Double(span)))
    }

    /// PURE: a span as the tab says it — "under a minute", "4 min", "2 h", "1 h 10 min".
    static func span(_ ms: Int) -> String {
        let minutes = max(0, ms) / 60_000
        if minutes < 1 { return "under a minute" }
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }

    /// PURE: the time left as words beside its line — "56 min left".
    static func leftWords(_ w: IslandWatchItem, nowMs: Int) -> String { "\(span(w.expiresAt - nowMs)) left" }

    /// PURE: when it was armed — "armed 4 min ago", "armed just now".
    static func armedWords(_ w: IslandWatchItem, nowMs: Int) -> String {
        nowMs - w.armedAt < 60_000 ? "armed just now" : "armed \(span(nowMs - w.armedAt)) ago"
    }

    /// PURE: what the pointer reveals under the condition — its session, its target and when it was armed ("List the
    /// extension · Chrome — Inbox · armed 4 min ago").
    static func details(_ w: IslandWatchItem, nowMs: Int) -> String {
        "\(islandWatchSessionLine(w)) · \(w.targetLabel) · \(armedWords(w, nowMs: nowMs))"
    }

    /// PURE: a watch row as VoiceOver says it, at rest — the condition, session and target, and its time line (or why its
    /// Stop failed).
    static func accessibilityLabel(_ w: IslandWatchItem, nowMs: Int, error: String?) -> String {
        "\(islandWatchConditionLine(w)), \(islandWatchSessionLine(w)) · \(w.targetLabel), \(error ?? islandWatchTimeLine(w, nowMs: nowMs))"
    }
}

/// Every armed computer-use watch, each a row with Stop under the pointer.
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
        return VStack(alignment: .leading, spacing: IslandQuietRow.rowGap) {
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

/// A watch as a row: its condition's glyph and words (two lines at most), and beside them its time left — a short thin
/// line emptying as it runs out, and its minutes. Under the pointer the condition lifts and its session, target and
/// arming time show under it with Stop.
struct IslandQuietWatchRow: View {
    let watch: IslandWatchItem
    let nowMs: Int
    let stopping: Bool
    let error: String?
    let onStop: () -> Void

    var body: some View {
        HoverLiftReader(id: "watch:\(watch.wakeId)") { hovered in
            let actions = IslandQuietRow.showsActions(hovered: hovered, busy: stopping || error != nil)
            IslandLiftRow(title: islandWatchConditionLine(watch), titleLines: 2, hovered: hovered) {
                Image(systemName: islandWatchSymbol(watch.condition))
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(IslandCUColors.accent)
            } trailing: {
                IslandWatchCountdown(left: IslandWatchesPresentation.left(watch, nowMs: nowMs),
                                     words: IslandWatchesPresentation.leftWords(watch, nowMs: nowMs))
            } below: {
                // A failed Stop says so, in amber, at rest too.
                if let error {
                    IslandRowWords(text: error, color: pillReviewAmber)
                }
                if actions {
                    IslandRowWords(text: IslandWatchesPresentation.details(watch, nowMs: nowMs)) {
                        IslandRowActionButton(title: stopping ? "Stopping…" : "Stop", tone: stopping ? .busy : .plain, enabled: !stopping, action: onStop)
                            .accessibilityLabel("Stop waiting")
                    }
                    .transition(.opacity)
                }
            }
        }
        // One element for VoiceOver, which never hovers: its words, and Stop as its action whatever is shown.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IslandWatchesPresentation.accessibilityLabel(watch, nowMs: nowMs, error: error))
        .accessibilityActions {
            if !stopping { Button("Stop waiting", action: onStop) }
        }
    }
}

/// A watch's time left: its minutes, then a short thin line (the plan lines' resting weight) filled with what is left —
/// it empties toward its start as the watch runs out. Redrawn whenever the tab is (the island opening on it, a tab change,
/// a watch armed or ended — `island.activityChanged`), never on a timer of its own (the idle rule).
struct IslandWatchCountdown: View {
    /// 0…1 of its time still to run.
    let left: Double
    let words: String

    static let width: CGFloat = 64

    var body: some View {
        let thickness = HoverLift.restThickness
        let fill = CGFloat(min(1, max(0, left)))
        HStack(spacing: 8) {
            Text(words)
                .font(Typography.tinyDigits())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule().fill(IslandCUColors.accent)
                    .frame(width: fill > 0 ? max(thickness, Self.width * fill) : 0)
            }
            .frame(width: Self.width, height: thickness)
        }
        .accessibilityHidden(true)
    }
}
