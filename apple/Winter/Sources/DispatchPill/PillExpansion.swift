import AppKit
import SwiftUI

// Opening a pill INTO itself (user, 2026-10-06): in the pill-themed session window a thinking pill and
// a search pill carry a chevron; clicking it morphs the capsule into a rounded rectangle that holds the
// same row (disc, title, the chevron turned over) and, below it, what the pill was about — the
// reasoning text, or the queries and one flat pill per website found. Closing returns the capsule.
// While open the pill takes a line of its own at the column's width (`PillFlowFullWidth`).

// MARK: - Which pills are open (pure — `PillExpansionTests`)

/// The transcript's open rows and pills, keyed by item identity — a tool run's first `callId`
/// (`toolRunExpansionKey`), a reasoning block's `blockId` (`thinkingExpansionKey`). Held once per
/// transcript (`TranscriptView`), not per exchange row, so a row the lazy stack recycles comes back
/// open; never persisted (a reading aid, not session state).
struct TranscriptExpansion: Equatable {
    private(set) var keys: Set<String> = []

    func contains(_ key: String) -> Bool { keys.contains(key) }

    mutating func toggle(_ key: String) {
        if keys.remove(key) == nil { keys.insert(key) }
    }

    mutating func open(_ more: Set<String>) { keys.formUnion(more) }

    mutating func removeAll() { keys = [] }
}

/// The open-state key of a thinking pill — its block's id, unique in its session.
func thinkingExpansionKey(_ blockId: String) -> String { "thinking:\(blockId)" }

/// A row key made unique across the whole transcript: a `callId` key already is; the positional
/// fallback (`index:N`, a run built with no callId) is only unique inside its exchange, so it is
/// scoped by the exchange's index.
func transcriptExpansionKey(_ key: String, exchangeIndex: Int) -> String {
    key.hasPrefix("index:") ? "exchange\(exchangeIndex)/\(key)" : key
}

private struct TranscriptSeededExpansionKey: EnvironmentKey {
    static let defaultValue: Set<String> = []
}

extension EnvironmentValues {
    /// TEST SEAM (offscreen snapshots): keys a transcript opens with (`TranscriptExpansion`). Empty
    /// everywhere in the app.
    var transcriptSeededExpansion: Set<String> {
        get { self[TranscriptSeededExpansionKey.self] }
        set { self[TranscriptSeededExpansionKey.self] = newValue }
    }
}

// MARK: - The morphing shape

/// The pill's own material at any size: a capsule while closed (a rounded rectangle whose radius is
/// half its height), a rounded rectangle — the radius of the pill's own card (`PillToolRunCard`) —
/// while open. The radius animates with the size, so opening reads as the capsule growing into a card,
/// never as a scaled-up pill. Same fill and rim as the tool pill's capsule.
struct PillMorphChrome: ViewModifier {
    let expanded: Bool
    var fill: Color = PillMorphChrome.fill
    let rim: Color

    static let fill = Color.white.opacity(0.06)
    static let restRim = Color.white.opacity(0.08)
    static let liveRim = Color.white.opacity(0.55)
    static let expandedCornerRadius: CGFloat = 16

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: expanded ? Self.expandedCornerRadius : PillToolRunHeader.height / 2,
                                     style: expanded ? .continuous : .circular)
        content
            .background(shape.fill(fill))
            .overlay(shape.strokeBorder(rim, lineWidth: 1))
            .clipShape(shape)
            .contentShape(shape)
    }
}

/// The pill's chevron: down while closed, turned over while open. Its label is what clicking does.
struct PillChevron: View {
    let isExpanded: Bool
    let label: String

    var body: some View {
        Image(systemName: "chevron.down")
            .font(Typography.badge(.bold))
            .foregroundStyle(Color.white.opacity(0.45))
            .rotationEffect(.degrees(isExpanded ? 180 : 0))
            .accessibilityLabel(label)
    }
}

/// How a pill opens and closes: a soft spring, so the shape and the content below grow together.
let pillMorphAnimation = Animation.spring(response: 0.38, dampingFraction: 0.86)

// MARK: - A search's websites (pure — `PillExpansionTests`)

/// One website a search found, as its flat pill shows it: the host up front, the rest of the address
/// muted after it, the favicon the tool reported (else the host's own `/favicon.ico`, `FaviconCache`).
struct PillSearchSite: Equatable, Hashable {
    /// The page — always https.
    let url: URL
    /// The url's own host, lowercased — what the favicon is fetched for.
    let host: String
    /// The host without a leading `www.`.
    let displayHost: String
    /// The path (and query), decoded for reading; empty for a site's root.
    let path: String
    /// The icon the tool reported for it, when that is an allowed https url.
    let iconURL: String?
}

/// PURE: a site from one reported url — https to a public name only (`plumeFaviconHostAllowed`, the
/// favicon rules); nil for anything else.
func pillSearchSite(_ raw: String, iconURL: String? = nil) -> PillSearchSite? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased(), plumeFaviconHostAllowed(host) else { return nil }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    var path = components?.percentEncodedPath ?? url.path
    path = path.removingPercentEncoding ?? path
    if let query = components?.percentEncodedQuery, !query.isEmpty {
        path += "?" + (query.removingPercentEncoding ?? query)
    }
    if path == "/" { path = "" }
    let display = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    let icon = iconURL.flatMap { plumeIconURLAllowed($0) ? $0 : nil }
    return PillSearchSite(url: url, host: host, displayHost: display, path: path, iconURL: icon)
}

/// PURE: the key two reports of one page share — host and path (a trailing `/` ignored) and query,
/// never the fragment or the scheme's case.
func pillSearchSiteKey(_ site: PillSearchSite) -> String {
    let components = URLComponents(url: site.url, resolvingAgainstBaseURL: false)
    var path = components?.percentEncodedPath ?? ""
    while path.hasSuffix("/") { path.removeLast() }
    let query = components?.percentEncodedQuery.map { "?" + $0 } ?? ""
    return site.host + path + query
}

/// PURE: the https urls written in a tool's output text, in order — the fallback when a result
/// reported no `siteIcons`. A url ends at whitespace, a quote, an angle bracket or a closing bracket;
/// trailing sentence punctuation is not part of it.
func pillHTTPSURLs(in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #"https://[^\s<>"'`()\[\]{}|\\^]+"#,
                                               options: [.caseInsensitive]) else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    return regex.matches(in: text, range: range).compactMap { match in
        guard let r = Range(match.range, in: text) else { return nil }
        var url = String(text[r])
        while let last = url.last, ".,;:!?*_~".contains(last) { url.removeLast() }
        return url.count > "https://".count ? url : nil
    }
}

/// PURE: every website a search run found, in the order its calls reported them, each page once —
/// per call the sites its result reported (`tool_result.siteIcons`, with their icons), else the https
/// urls its output names (never a failed call's output).
func pillSearchSites(_ calls: [ToolCallRecord]) -> [PillSearchSite] {
    var seen: Set<String> = []
    var sites: [PillSearchSite] = []
    for call in calls {
        let reported: [(url: String, icon: String?)] = !call.siteIcons.isEmpty
            ? call.siteIcons.map { ($0.url, $0.iconUrl) }
            : (call.isError ? [] : pillHTTPSURLs(in: call.output ?? "").map { ($0, nil) })
        for (raw, icon) in reported {
            guard let site = pillSearchSite(raw, iconURL: icon), seen.insert(pillSearchSiteKey(site)).inserted else { continue }
            sites.append(site)
        }
    }
    return sites
}

/// PURE: what a search run asked, each query once, in order.
func pillSearchQueries(_ calls: [ToolCallRecord]) -> [String] {
    var seen: Set<String> = []
    return calls.compactMap { call in
        guard let query = call.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty,
              seen.insert(query).inserted else { return nil }
        return query
    }
}

/// Opens a website the user clicked in their default browser — https only.
@MainActor
func pillOpenWebsite(_ url: URL) {
    guard url.scheme?.lowercased() == "https" else { return }
    NSWorkspace.shared.open(url)
}

// MARK: - The opened search pill

/// Inside an opened search pill: a caption with what was searched for, then one flat pill per website.
struct PillSearchSources: View {
    let entry: ToolRunEntry
    let turnIsLive: Bool

    /// Bumped while a favicon is still loading, so the pills look again (the cache is not observable).
    @State private var faviconTick = 0

    var body: some View {
        let sites = pillSearchSites(entry.calls)
        let queries = pillSearchQueries(entry.calls)
        let running = toolRunStatus([entry], turnIsLive: turnIsLive) == .running
        VStack(alignment: .leading, spacing: 10) {
            if !queries.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(Typography.badge(.bold))
                        .accessibilityHidden(true)
                    Text(queries.map { "“\($0)”" }.joined(separator: "  ·  "))
                        .lineLimit(3)
                        .truncationMode(.tail)
                        .textSelection(.enabled)
                }
                .font(Typography.caption())
                .foregroundStyle(Color.white.opacity(0.55))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Searched for \(queries.joined(separator: ", "))")
            }
            if sites.isEmpty {
                Text(running ? "Waiting for results…" : "No websites reported")
                    .font(Typography.caption())
                    .foregroundStyle(Color.white.opacity(0.45))
            } else {
                PillFlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(sites, id: \.self) { site in
                        PillWebsiteChip(site: site, tick: faviconTick)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: sites.map(\.host)) { await waitForFavicons(sites) }
    }

    private func waitForFavicons(_ sites: [PillSearchSite]) async {
        for _ in 0..<12 {
            let missing = sites.contains { FaviconCache.shared.image(host: $0.host, iconURL: $0.iconURL) == nil }
            guard missing else { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            faviconTick += 1
        }
    }
}

/// One website, flat: a grey capsule with no rim, no border and no shadow — the favicon, the host,
/// then the rest of the address muted and cut in the middle. Clicking opens it in the browser.
struct PillWebsiteChip: View {
    let site: PillSearchSite
    /// Read so a newly loaded favicon draws (`PillSearchSources.faviconTick`).
    let tick: Int

    static let height: CGFloat = 26
    static let maxWidth: CGFloat = 300
    static let iconSize: CGFloat = 14
    static let fill = Color.white.opacity(0.09)

    var body: some View {
        Button { pillOpenWebsite(site.url) } label: {
            HStack(spacing: 6) {
                favicon
                Text(site.displayHost)
                    .font(Typography.caption(.medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .lineLimit(1)
                    .layoutPriority(1)
                if !site.path.isEmpty {
                    Text(site.path)
                        .font(Typography.caption())
                        .foregroundStyle(Color.white.opacity(0.45))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 10)
            .frame(height: Self.height)
            .frame(maxWidth: Self.maxWidth, alignment: .leading)
            .background(Capsule().fill(Self.fill))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(site.url.absoluteString)
        .accessibilityLabel(site.displayHost)
        .accessibilityHint("Opens in your browser")
    }

    @ViewBuilder private var favicon: some View {
        let _ = tick
        if let image = FaviconCache.shared.image(host: site.host, iconURL: site.iconURL) {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: Self.iconSize, height: Self.iconSize)
                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
        } else {
            Image(systemName: "globe")
                .resizable()
                .scaledToFit()
                .foregroundStyle(Color.white.opacity(0.5))
                .frame(width: Self.iconSize, height: Self.iconSize)
        }
    }
}

// MARK: - The opened thinking pill's text

/// PURE: whether a text is long enough that an opened thinking pill puts it straight into its bounded
/// scroll box — a fast guess for an obviously long block, so it never first draws at full height.
/// Anything shorter is measured (`PillThinkingText`).
func pillThinkingTextIsLong(_ text: String) -> Bool {
    if text.utf16.count > 2_400 { return true }
    var lines = 0
    for unit in text.utf16 where unit == 10 {
        lines += 1
        if lines >= 24 { return true }
    }
    return false
}

/// PURE: the body an opened thinking pill shows under its title — the text without a leading
/// `**heading**` line that only repeats the title (an OpenAI summary opens with the heading the title
/// was taken from). Looks at the first line only.
func thinkingBodyText(_ text: String, title: String?) -> String {
    guard let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else { return text }
    let start = text.firstIndex { !$0.isWhitespace } ?? text.endIndex
    let lineEnd = text[start...].firstIndex(of: "\n") ?? text.endIndex
    guard text[start..<lineEnd].trimmingCharacters(in: .whitespaces) == "**\(title)**" else { return text }
    let rest = text[lineEnd...].drop { $0.isWhitespace }
    return rest.isEmpty ? text : String(rest)
}

struct PillScrollEdges: Equatable {
    var above: Bool
    var below: Bool
}

/// The reasoning inside an opened thinking pill, read like the agent's own prose but quieter — the
/// transcript's own markdown renderer (finished paragraphs are not redrawn as more streams in, as for
/// a streaming reply), white at reduced opacity, selectable. A text taller than `maxHeight` scrolls in
/// a box of that height, which, while the block streams, follows its newest line.
struct PillThinkingText: View {
    let text: String
    let isLive: Bool
    let truncated: Bool

    static let maxHeight: CGFloat = 300
    static let opacity: Double = 0.72
    static let edgeFade: CGFloat = 28

    /// The text's own height at the pill's width, measured as it draws.
    @State private var measuredHeight: CGFloat = 0
    /// Whether text is scrolled out of sight above / below the box.
    @State private var edges = PillScrollEdges(above: false, below: false)

    private var scrolls: Bool { measuredHeight > Self.maxHeight || pillThinkingTextIsLong(text) }

    var body: some View {
        if scrolls {
            ScrollView(.vertical) {
                measuredContent.padding(.trailing, 10)
            }
            .frame(height: Self.maxHeight)
            .scrollIndicators(.automatic)
            .defaultScrollAnchor(isLive ? .bottom : .top, for: .initialOffset)
            .defaultScrollAnchor(isLive ? .bottom : .top, for: .sizeChanges)
            .onScrollGeometryChange(for: PillScrollEdges.self) { geo in
                PillScrollEdges(above: geo.contentOffset.y > 1,
                                below: geo.contentOffset.y + geo.containerSize.height < geo.contentSize.height - 1)
            } action: { _, new in edges = new }
            // A line scrolled past an edge fades out there rather than being cut.
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [edges.above ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.edgeFade)
                    Color.black
                    LinearGradient(colors: [.black, edges.below ? .clear : .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.edgeFade)
                }
            }
        } else {
            measuredContent
        }
    }

    private var measuredContent: some View {
        content.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { measuredHeight = $0 }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            TranscriptFormattedMessageText(text: text, tint: .white, role: .sans, fillsAvailableWidth: true)
            if truncated {
                Text("Reasoning shortened")
                    .font(Typography.tiny())
            }
        }
        .foregroundStyle(Color.white)
        .opacity(Self.opacity)
        .textSelection(.enabled)
    }
}
