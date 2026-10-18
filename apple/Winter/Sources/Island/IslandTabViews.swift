import AppKit
import SwiftUI
import WinterCUPresentation

// The Winter island's phase-2 tab plumbing (`docs/claude/island.md`): the models each tab reads (`IslandTabModels`,
// held by the controller and handed to the open island), the shared pieces every tab draws with — a row surface that
// lightens and glows under the pointer, an empty state, a ring and a bar — and the relative-time words.

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

    /// Refreshes the data the tab with this id shows (on open and when the tab is shown; `periodic` — the open island's
    /// light refresh — skips the Shelf, which resolves on open, on a tab change and on a drop).
    func refresh(tab id: String?, periodic: Bool = false) async {
        switch id {
        case IslandTabRegistry.sessions.id?: await sessions.refresh()
        case IslandTabRegistry.shelf.id?: if !periodic { await shelf.resolveAll() }
        case IslandTabRegistry.usage.id?: await usage.refresh()
        case IslandTabRegistry.devices.id?: await devices.refresh()
        default: break
        }
    }
}

/// A row's surface: a soft fill that lightens and glows softly (the pills' `pillHoverGlow`, white and gentler) while the
/// island's pointer is over it — never a grow (nothing in the open island grows, the island included). No pointer (the
/// offscreen gallery): at rest.
struct IslandHoverSurface<Content: View>: View {
    var corner: CGFloat = IslandLayout.rowCorner
    @ViewBuilder let content: (Bool) -> Content

    var body: some View {
        IslandPointerReader { hovered in
            content(hovered)
                .background(RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(Color.white.opacity(hovered ? 0.11 : 0.06)))
                .contentShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                .shadow(color: Color.white.opacity(hovered ? IslandHover.rowGlowNear : 0), radius: PillHoverGlowMetrics.nearRadius)
                .shadow(color: Color.white.opacity(hovered ? IslandHover.rowGlowFar : 0), radius: PillHoverGlowMetrics.farRadius)
                .animation(.easeOut(duration: 0.15), value: hovered)
        }
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
        // Centred in the island's fixed body.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A ring filled to `fraction` (0…1), its colour by how full it is.
struct IslandRing: View {
    let fraction: Double
    var size: CGFloat = 44
    var line: CGFloat = 5
    var color: Color = Theme.accent

    /// PURE: the label — the percent sign is dropped in a small ring (under 40 pt), where "100%" would not fit.
    static func label(_ fraction: Double, size: CGFloat) -> String {
        let pct = Int((min(1, max(0, fraction)) * 100).rounded())
        return size < 40 ? "\(pct)" : "\(pct)%"
    }

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: line)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            // Fitted INSIDE the ring: one line, scaled down rather than spilling over the stroke.
            Text(Self.label(fraction, size: size))
                .font(Typography.captionDigits(.semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .frame(width: max(8, size - 2 * line - 4))
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
            IslandTabScroll(scrolls: scrolls) { IslandUsageTab(model: models.usage) }
        case IslandTabRegistry.devices.id:
            IslandTabScroll(scrolls: scrolls) { IslandDevicesTab(model: models.devices) }
        default:
            Spacer()
        }
    }
}

// MARK: - Scrolling inside the fixed island

/// PURE: which edges of a tab's list have more beyond them — each such edge fades (`IslandTabScroll`).
struct IslandScrollEdges: Equatable {
    var top = false
    var bottom = false

    /// From the visible part of the content and the content's height.
    static func of(visible: CGRect, contentHeight: CGFloat) -> IslandScrollEdges {
        IslandScrollEdges(top: visible.minY > 0.5, bottom: visible.maxY < contentHeight - 0.5)
    }
}

/// A tab's body inside the open island's FIXED size: a vertical scroll view whose top and bottom edges fade softly where
/// more of the list lies beyond them (judged on scroll, never on a timer), with overlay scrollers that show only while
/// scrolling. The header above stays pinned. Flat (`scrolls` false — the offscreen gallery, which cannot draw a scroll
/// view): top-aligned, cut at the island's edge with the bottom fade a longer list shows.
struct IslandTabScroll<Content: View>: View {
    var scrolls = true
    @ViewBuilder let content: Content
    @State private var edges = IslandScrollEdges()

    /// How far the fade reaches into the list at an edge with more beyond it.
    static var fade: CGFloat { 18 }

    var body: some View {
        if scrolls {
            ScrollView(.vertical) {
                content.background(IslandOverlayScrollers())
            }
            .scrollIndicators(.automatic)
            .onScrollGeometryChange(for: IslandScrollEdges.self) { geometry in
                .of(visible: geometry.visibleRect, contentHeight: geometry.contentSize.height)
            } action: { _, new in
                edges = new
            }
            .mask { IslandScrollFade(edges: edges, fade: Self.fade) }
        } else {
            content
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
                .frame(maxWidth: .infinity)
                .clipped()
                .mask { IslandScrollFade(edges: IslandScrollEdges(top: false, bottom: true), fade: Self.fade) }
        }
    }
}

/// The fade mask of `IslandTabScroll`: opaque, softening to nothing over `fade` at each edge that has more beyond it.
struct IslandScrollFade: View {
    let edges: IslandScrollEdges
    let fade: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [edges.top ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
                .frame(height: fade)
            Color.black
            LinearGradient(colors: [.black, edges.bottom ? .clear : .black], startPoint: .top, endPoint: .bottom)
                .frame(height: fade)
        }
        .animation(.easeOut(duration: 0.15), value: edges)
    }
}

/// Asks the scroll view around it for OVERLAY scrollers (shown only while scrolling, over the content) whatever the
/// system's preference, so no scroll bar sits in the island at rest. Nothing else is touched.
private struct IslandOverlayScrollers: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { OverlayScrollerProbe() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class OverlayScrollerProbe: NSView {
        private var styleObserver: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                stopObserving()
                return
            }
            apply()
            // The scroll view follows the system's preferred style when it changes (a mouse plugged in, the setting
            // changed): put overlay back after it has — event-driven, nothing runs otherwise.
            if styleObserver == nil {
                styleObserver = NotificationCenter.default.addObserver(
                    forName: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil, queue: .main
                ) { [weak self] _ in
                    DispatchQueue.main.async { MainActor.assumeIsolated { self?.apply() } }
                }
            }
        }

        private func apply() {
            guard let scroll = enclosingScrollView else { return }
            if scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
            scroll.autohidesScrollers = true
            scroll.hasHorizontalScroller = false
        }

        private func stopObserving() {
            if let styleObserver { NotificationCenter.default.removeObserver(styleObserver) }
            styleObserver = nil
        }


        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
