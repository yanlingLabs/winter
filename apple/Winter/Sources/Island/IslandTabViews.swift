import SwiftUI
import WinterCUPresentation

// The Winter island's phase-2 tab plumbing (`docs/claude/island.md`): the models each tab reads (`IslandTabModels`,
// held by the controller and handed to the open island), the shared pieces every tab draws with — a row surface that
// grows 3 % and lightens under the pointer, an empty state, a ring and a bar — and the relative-time words.

/// The tabs' models, one per tab (kept out of `IslandStore`, which stays the cards' state).
@MainActor
final class IslandTabModels {
    let sessions: IslandSessionsModel
    let shelf: IslandShelfStore
    let thumbnails: IslandShelfThumbnails
    let usage: IslandUsageModel
    let devices: IslandDevicesModel

    init(sessions: IslandSessionsModel? = nil, shelf: IslandShelfStore? = nil, thumbnails: IslandShelfThumbnails? = nil,
         usage: IslandUsageModel? = nil, devices: IslandDevicesModel? = nil) {
        self.sessions = sessions ?? IslandSessionsModel()
        self.shelf = shelf ?? IslandShelfStore(persistence: .appDefault())
        self.thumbnails = thumbnails ?? IslandShelfThumbnails()
        self.usage = usage ?? IslandUsageModel()
        self.devices = devices ?? IslandDevicesModel()
    }

    /// Refreshes the data the tab with this id shows (on open, when the tab is shown, and while the island is open).
    func refresh(tab id: String?) async {
        switch id {
        case IslandTabRegistry.sessions.id?: await sessions.refresh()
        case IslandTabRegistry.shelf.id?: shelf.resolveAll()
        case IslandTabRegistry.usage.id?: await usage.refresh()
        case IslandTabRegistry.devices.id?: await devices.refresh()
        default: break
        }
    }
}

/// A row's surface: a soft fill that lightens, and a 3 % grow, while the island's pointer is over it (the pill's
/// pointer, `dispatchPillPointer`; no pointer — the offscreen gallery — draws it at rest).
struct IslandHoverSurface<Content: View>: View {
    var corner: CGFloat = 16
    @ViewBuilder let content: (Bool) -> Content
    @Environment(\.dispatchPillPointer) private var pointer

    var body: some View {
        if let pointer {
            IslandHoverTracking(pointer: pointer, corner: corner, content: content)
        } else {
            content(false).background(RoundedRectangle(cornerRadius: corner, style: .continuous).fill(Color.white.opacity(0.06)))
        }
    }
}

private struct IslandHoverTracking<Content: View>: View {
    @ObservedObject var pointer: DispatchPillPointer
    let corner: CGFloat
    let content: (Bool) -> Content
    @State private var frame: CGRect = .zero

    var body: some View {
        let hovered = pointer.location.map { frame.contains($0) } ?? false
        content(hovered)
            .background(RoundedRectangle(cornerRadius: corner, style: .continuous).fill(Color.white.opacity(hovered ? 0.11 : 0.06)))
            .contentShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(DispatchPillView.canvasSpace))
            } action: { frame = $0 }
            .scaleEffect(hovered ? 1.03 : 1)
            .animation(.easeOut(duration: 0.15), value: hovered)
    }
}

/// A tab with nothing to show.
struct IslandEmptyTab: View {
    let symbol: String
    let line: String
    var detail: String?

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(Typography.heading(.light))
                .foregroundStyle(Theme.textMuted)
            Text(line)
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
            if let detail {
                Text(detail)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
        .padding(.horizontal, 24)
    }
}

/// A ring filled to `fraction` (0…1), its colour by how full it is.
struct IslandRing: View {
    let fraction: Double
    var size: CGFloat = 44
    var line: CGFloat = 5
    var color: Color = Theme.accent

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: line)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(Int((min(1, max(0, fraction)) * 100).rounded()))%")
                .font(Typography.captionDigits(.semibold))
                .foregroundStyle(Color.white)
        }
        .frame(width: size, height: size)
    }
}

/// A slim bar filled to `fraction` (0…1).
struct IslandBar: View {
    let fraction: Double
    var color: Color = Theme.accent

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(color).frame(width: max(4, proxy.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 6)
    }
}

/// PURE: a fill's colour — calm, amber from 75 %, red-ish (the review amber's warmer twin is not a token; the pill's
/// amber marks "needs you", so "full" uses the system red) at 95 % or when the provider refuses.
func islandFillColor(_ fraction: Double, refused: Bool = false) -> Color {
    if refused || fraction >= 0.95 { return Color(nsColor: .systemRed) }
    if fraction >= 0.75 { return pillReviewAmber }
    return Theme.accent
}

/// PURE: "in 2 h 14 min", "in 45 min", "in 3 d 4 h", "now" — a time ahead, relative and short.
func islandRelativeFuture(_ date: Date, now: Date) -> String {
    let seconds = Int(date.timeIntervalSince(now))
    if seconds <= 30 { return "now" }
    let minutes = (seconds + 59) / 60
    if minutes < 60 { return "in \(minutes) min" }
    let hours = minutes / 60
    if hours < 24 {
        let rest = minutes % 60
        return rest == 0 ? "in \(hours) h" : "in \(hours) h \(rest) min"
    }
    let days = hours / 24
    let restHours = hours % 24
    return restHours == 0 ? "in \(days) d" : "in \(days) d \(restHours) h"
}

/// PURE: "just now", "5 min ago", "3 h ago", "2 d ago" — a time behind.
func islandRelativePast(_ date: Date, now: Date) -> String {
    let seconds = Int(now.timeIntervalSince(date))
    if seconds < 60 { return "just now" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes) min ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours) h ago" }
    return "\(hours / 24) d ago"
}

/// PURE: 1234 → "1.2k", 2_500_000 → "2.5M".
func islandCompactCount(_ n: Int) -> String {
    switch n {
    case ..<1_000: return "\(n)"
    case ..<1_000_000:
        let v = Double(n) / 1_000
        return v < 10 ? String(format: "%.1fk", v) : "\(Int(v.rounded()))k"
    default:
        let v = Double(n) / 1_000_000
        return v < 10 ? String(format: "%.1fM", v) : "\(Int(v.rounded()))M"
    }
}

/// A phase-2 tab's body, by id (scrolling live; flat for the gallery and for measuring its height).
struct IslandTabBody: View {
    let id: String
    let models: IslandTabModels
    var scrolls = true

    var body: some View {
        switch id {
        case IslandTabRegistry.sessions.id:
            IslandSessionsList(model: models.sessions, scrolls: scrolls) { models.sessions.open($0) }
        case IslandTabRegistry.shelf.id:
            IslandShelfTab(shelf: models.shelf, thumbnails: models.thumbnails, scrolls: scrolls)
        case IslandTabRegistry.usage.id:
            scrolling { IslandUsageTab(model: models.usage) }
        case IslandTabRegistry.devices.id:
            scrolling { IslandDevicesTab(model: models.devices) }
        default:
            Spacer()
        }
    }

    @ViewBuilder
    private func scrolling<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if scrolls {
            ScrollView(.vertical) { content() }.scrollIndicators(.never)
        } else {
            content()
            Spacer(minLength: 0)
        }
    }
}
