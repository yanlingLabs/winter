import SwiftUI
import AppKit

// MARK: - Discs (pure — `PillToolRunHeaderTests`)

/// PURE: the discs a run of tool calls shows in the pill-themed session window — the same white discs
/// the plume throws for it (`plumeThrows(inActivity:)`): a tool's symbol, or the favicon of a site a
/// search found or a fetch read. Each distinct disc once, in order; a run that has thrown nothing yet
/// (a search still out) shows its first tool's own symbol.
func toolRunDiscs(_ entries: [ToolRunEntry]) -> [PlumeThrow] {
    let items = entries.flatMap { entry in
        entry.calls.map { call in
            ActivityItem(kind: .tool(name: entry.name, detail: call.detail, callId: call.callId, output: call.output,
                                     isError: call.isError, fileDiff: call.fileDiff, siteIcons: call.siteIcons))
        }
    }
    var seen: Set<PlumeThrow.Kind> = []
    let discs = plumeThrows(inActivity: items).filter { seen.insert($0.kind).inserted }
    if discs.isEmpty, let first = entries.first {
        return [PlumeThrow(id: "run", kind: .tool(symbol: workingToolSymbol(for: first.name)))]
    }
    return discs
}

// MARK: - The row

/// A run of tool calls in the dispatch pill's own material (user, 2026-10-02: "style the tool calls
/// to match our theme" — the muted chevron line read as unfinished on the black window): a dark
/// capsule holding the run's discs, overlapped like a hand of cards, its sentence in white, three
/// dots in the session's colour while it runs, a mark if it failed, and a chevron to open it.
struct PillToolRunHeader: View {
    let entries: [ToolRunEntry]
    let status: ToolCallStatus
    let sentence: String
    let isExpanded: Bool
    let toggle: () -> Void

    @Environment(\.pillChromePalette) private var palette
    /// Bumped while a favicon is still loading, so the row looks again (the cache is not observable).
    @State private var faviconTick = 0

    static let discSize: CGFloat = 22
    static let maxDiscs = 5
    static let height: CGFloat = 34

    var body: some View {
        let discs = toolRunDiscs(entries)
        HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    discStack(discs)
                    Text(sentence)
                        .font(Typography.label(.medium))
                        .foregroundStyle(Color.white.opacity(0.88))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    statusMark
                    Image(systemName: "chevron.down")
                        .font(Typography.badge(.bold))
                        .foregroundStyle(Color.white.opacity(0.45))
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.leading, 6)
                .padding(.trailing, 14)
                .frame(height: Self.height)
                .background(Capsule().fill(Color.white.opacity(0.06)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
        .task(id: discs) { await waitForFavicons(discs) }
    }

    @ViewBuilder
    private func discStack(_ discs: [PlumeThrow]) -> some View {
        let shown = Array(discs.prefix(Self.maxDiscs))
        HStack(spacing: -7) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, disc in
                PillToolDisc(disc: disc, palette: palette, size: Self.discSize, tick: faviconTick)
                    .zIndex(Double(shown.count - index))
            }
            if discs.count > Self.maxDiscs {
                Text("+\(discs.count - Self.maxDiscs)")
                    .font(Typography.badge(.bold))
                    .foregroundStyle(Color.white.opacity(0.7))
                    .padding(.leading, 11)
            }
        }
    }

    @ViewBuilder
    private var statusMark: some View {
        switch status {
        case .running:
            PillRunningDots(color: palette.bodyColor)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .font(Typography.label(.semibold))
                .foregroundStyle(Color(red: 1.0, green: 0.45, blue: 0.40))
                .accessibilityLabel("Failed")
        case .succeeded, .unfinished:
            EmptyView()
        }
    }

    /// Looks again every half second while a site's favicon has not arrived, for a few seconds.
    private func waitForFavicons(_ discs: [PlumeThrow]) async {
        for _ in 0..<12 {
            let missing = discs.prefix(Self.maxDiscs).contains { disc in
                if case .site(let host, let iconURL) = disc.kind {
                    return FaviconCache.shared.image(host: host, iconURL: iconURL) == nil
                }
                return false
            }
            guard missing else { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            faviconTick += 1
        }
    }
}

/// One white disc: a tool's symbol in the session's deep colour, or a site's favicon (a grey globe
/// until it loads) — the plume's own tile, standing still. A thin black ring keeps overlapped discs
/// apart.
private struct PillToolDisc: View {
    let disc: PlumeThrow
    let palette: PlumePalette
    let size: CGFloat
    /// Read so a newly loaded favicon draws (`PillToolRunHeader.faviconTick`).
    let tick: Int

    var body: some View {
        ZStack {
            Circle().fill(Color.white)
            switch disc.kind {
            case .tool(let symbol):
                Image(systemName: symbol)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Color(red: palette.tail.red, green: palette.tail.green, blue: palette.tail.blue))
                    .frame(width: size * 0.5, height: size * 0.5)
            case .site(let host, let iconURL):
                if let image = FaviconCache.shared.image(host: host, iconURL: iconURL) {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: size * 0.64, height: size * 0.64)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "globe")
                        .resizable()
                        .scaledToFit()
                        .foregroundStyle(Color(white: 0.45))
                        .frame(width: size * 0.58, height: size * 0.58)
                }
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(Color.black, lineWidth: 1.5))
        .help(disc.helpText)
    }
}

private extension PlumeThrow {
    var helpText: String {
        switch kind {
        case .tool: return ""
        case .site(let host, _): return host
        }
    }
}

/// Three dots breathing in turn in the session's colour — the run is still going.
private struct PillRunningDots: View {
    let color: Color

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<3) { i in
                    let phase = (sin((t * 2 * .pi / 1.1) - Double(i) * 0.9) + 1) / 2
                    Circle()
                        .fill(color)
                        .frame(width: 5, height: 5)
                        .opacity(0.35 + 0.65 * phase)
                }
            }
        }
        .accessibilityLabel("Running")
    }
}

/// The opened run's calls, in the pill-themed window: on a soft dark card under the capsule, so the
/// calls read as the capsule's own contents. Elsewhere the calls draw as they always have.
struct PillToolRunCard: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content
                .padding(.vertical, 10)
                .padding(.trailing, 12)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(0.04)))
        } else {
            content
        }
    }
}
