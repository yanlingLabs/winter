import SwiftUI
import AppKit

// MARK: - Discs (pure — `PillToolRunHeaderTests`)

/// PURE: the discs a run of tool calls shows in the pill-themed session window — the same white discs
/// the plume throws for it (`plumeThrows(inActivity:)`): a tool's symbol, or the favicon of a site a
/// search found or a fetch read. Each distinct disc once, in order; a run that has thrown nothing yet
/// (a search still out) shows its first tool's own symbol.
func toolRunDiscs(_ entries: [ToolRunEntry]) -> [PlumeThrow] {
    var seen: Set<PlumeThrow.Kind> = []
    let discs = plumeThrows(inActivity: pillActivityItems(entries)).filter { seen.insert($0.kind).inserted }
    if discs.isEmpty, let first = entries.first {
        return [PlumeThrow(id: "run", kind: .tool(symbol: workingToolSymbol(for: first.name)))]
    }
    return discs
}

private func pillActivityItems(_ entries: [ToolRunEntry]) -> [ActivityItem] {
    entries.flatMap { entry in
        entry.calls.map { call in
            ActivityItem(kind: .tool(name: entry.name, detail: call.detail, callId: call.callId, output: call.output,
                                     isError: call.isError, fileDiff: call.fileDiff, siteIcons: call.siteIcons))
        }
    }
}

// MARK: - What the pill says (pure — `PillToolRunHeaderTests`)

/// The kinds of tool the pill has words for. Anything else reads "Using <tool>" → "Used <tool>".
enum PillToolKind: Equatable {
    case search, fetch, shell, write, edit, read, grep, glob, list, other(String)

    init(toolName: String) {
        switch toolName.lowercased() {
        case "web_search", "websearch", "search": self = .search
        case "web_fetch", "webfetch", "readpage": self = .fetch
        case "bash": self = .shell
        case "write": self = .write
        case "edit", "notebook_edit", "multiedit": self = .edit
        case "read": self = .read
        case "grep": self = .grep
        case "glob": self = .glob
        case "ls": self = .list
        default: self = .other(toolName)
        }
    }
}

/// A noun the pill counts, singular and plural.
struct PillNoun: Equatable {
    let one: String
    let many: String
    func callAsFunction(_ n: Int) -> String { n == 1 ? one : many }

    static let website = PillNoun(one: "website", many: "websites")
    static let page = PillNoun(one: "page", many: "pages")
    static let shellCommand = PillNoun(one: "shell command", many: "shell commands")
    static let line = PillNoun(one: "line", many: "lines")
    static let file = PillNoun(one: "file", many: "files")
    static let search = PillNoun(one: "search", many: "searches")
    static let directory = PillNoun(one: "directory", many: "directories")
    static let time = PillNoun(one: "time", many: "times")
}

/// What one tool pill says: `lead`, then — when there is one — a COUNT that climbs one by one to its
/// value (`PillCountUp`) followed by its noun, then `tail`; or a ROTATING name (a page, a file) that
/// changes every half second with its favicon. Built per state: running, done, failed.
struct PillToolLabel: Equatable {
    var lead: String
    var count: Int? = nil
    var noun: PillNoun? = nil
    var tail: String = ""
    /// Names that take turns after `lead` (`rotation` wins over `count` when both are set).
    var rotation: [PillRotatingName] = []
}

/// One name the pill rotates through — a page's host or a file's name — with the disc it shows then.
struct PillRotatingName: Equatable {
    let text: String
    let disc: PlumeThrow?
}

private func fileName(_ path: String?) -> String? {
    guard let path, !path.isEmpty else { return nil }
    let name = (path as NSString).lastPathComponent
    return name.isEmpty ? path : name
}

private func pageHost(_ url: String?) -> String? {
    guard let url, let host = URL(string: url)?.host?.lowercased(), !host.isEmpty else { return url }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

/// How many sites one search call found: the sites its result reported (`siteIcons`), else the hosts
/// its output names.
func pillSearchSiteCount(_ call: ToolCallRecord) -> Int {
    guard call.output != nil, !call.isError else { return 0 }
    let reported = plumeSites(call.siteIcons).count
    return reported > 0 ? reported : plumeHosts(in: call.output ?? "").count
}

/// PURE: what a tool pill says, given its ONE tool's calls and whether the turn is still live
/// (user, 2026-10-02: a running and a finished sentence per tool; counts that grow; names that
/// rotate; a failed state).
func pillToolLabel(_ entry: ToolRunEntry, turnIsLive: Bool) -> PillToolLabel {
    let calls = entry.calls
    let statuses = calls.map { toolCallStatus(output: $0.output, isError: $0.isError, turnIsLive: turnIsLive) }
    let running = statuses.contains(.running)
    let failed = statuses.filter { $0 == .failed }.count
    let allFailed = !calls.isEmpty && failed == calls.count
    let n = calls.count
    let liveCalls = zip(calls, statuses).filter { $0.1 == .running }.map(\.0)
    let failedTail = failed > 0 && !allFailed && !running ? " · \(failed) failed" : ""

    switch PillToolKind(toolName: entry.name) {
    case .search:
        let sites = calls.map(pillSearchSiteCount).reduce(0, +)
        if running {
            return sites > 0
                ? PillToolLabel(lead: "Searching the web · ", count: sites, noun: .website)
                : PillToolLabel(lead: "Searching the web")
        }
        if allFailed { return PillToolLabel(lead: n == 1 ? "Search failed" : "\(n) searches failed") }
        return sites > 0
            ? PillToolLabel(lead: "Searched ", count: sites, noun: .website, tail: failedTail)
            : PillToolLabel(lead: "Searched the web", tail: failedTail)

    case .fetch:
        if running {
            let names = (liveCalls.isEmpty ? calls : liveCalls).compactMap { call -> PillRotatingName? in
                guard let host = pageHost(call.detail) else { return nil }
                return PillRotatingName(text: host, disc: PlumeThrow(id: "page-" + host, kind: .site(host: host, iconURL: nil)))
            }
            return names.isEmpty ? PillToolLabel(lead: "Reading a page") : PillToolLabel(lead: "Reading ", rotation: names)
        }
        if allFailed {
            return n == 1 ? PillToolLabel(lead: "Couldn't read \(pageHost(calls[0].detail) ?? "the page")")
                          : PillToolLabel(lead: "Couldn't read \(n) pages")
        }
        let read = zip(calls, statuses).filter { $0.1 != .failed }.map(\.0)
        if read.count == 1, let host = pageHost(read[0].detail) { return PillToolLabel(lead: "Read \(host)", tail: failedTail) }
        return PillToolLabel(lead: "Read ", count: read.count, noun: .page, tail: failedTail)

    case .shell:
        if running { return PillToolLabel(lead: "Running ", count: n, noun: .shellCommand) }
        if allFailed { return n == 1 ? PillToolLabel(lead: "Shell command failed") : PillToolLabel(lead: "\(n) shell commands failed") }
        return PillToolLabel(lead: "Ran ", count: n, noun: .shellCommand, tail: failedTail)

    case .write:
        let names = calls.compactMap { fileName($0.detail) }
        let lines = calls.compactMap(\.writtenLines).reduce(0, +)
        if running {
            let target = Set(names).count == 1 ? names[0] : "\(Set(names).count) files"
            return lines > 0
                ? PillToolLabel(lead: "Writing ", count: lines, noun: .line, tail: " to \(target)")
                : PillToolLabel(lead: "Writing \(target)")
        }
        if allFailed { return PillToolLabel(lead: "Couldn't write \(Set(names).count == 1 ? names[0] : "\(n) files")") }
        let wrote = Set(zip(calls, statuses).filter { $0.1 != .failed }.compactMap { fileName($0.0.detail) })
        return wrote.count == 1
            ? PillToolLabel(lead: "Wrote \(wrote.first!)", tail: failedTail)
            : PillToolLabel(lead: "Wrote ", count: wrote.count, noun: .file, tail: failedTail)

    case .edit, .read:
        let isEdit = PillToolKind(toolName: entry.name) == .edit
        if running {
            let names = (liveCalls.isEmpty ? calls : liveCalls).compactMap { fileName($0.detail) }
                .map { PillRotatingName(text: $0, disc: nil) }
            let verb = isEdit ? "Editing " : "Reading "
            return names.isEmpty ? PillToolLabel(lead: isEdit ? "Editing a file" : "Reading a file")
                                 : PillToolLabel(lead: verb, rotation: names)
        }
        let done = Set(zip(calls, statuses).filter { $0.1 != .failed }.compactMap { fileName($0.0.detail) })
        if allFailed { return PillToolLabel(lead: isEdit ? "Couldn't edit \(n == 1 ? (fileName(calls[0].detail) ?? "the file") : "\(n) files")"
                                                         : "Couldn't read \(n == 1 ? (fileName(calls[0].detail) ?? "the file") : "\(n) files")") }
        let past = isEdit ? "Edited" : "Read"
        return done.count == 1
            ? PillToolLabel(lead: "\(past) \(done.first!)", tail: failedTail)
            : PillToolLabel(lead: "\(past) ", count: max(done.count, n - failed), noun: .file, tail: failedTail)

    case .grep, .glob:
        if running {
            let names = (liveCalls.isEmpty ? calls : liveCalls).compactMap(\.detail).map { PillRotatingName(text: "“\($0)”", disc: nil) }
            return names.isEmpty ? PillToolLabel(lead: "Searching the files") : PillToolLabel(lead: "Searching for ", rotation: names)
        }
        if allFailed { return PillToolLabel(lead: n == 1 ? "File search failed" : "\(n) file searches failed") }
        return n == 1 && calls[0].detail != nil
            ? PillToolLabel(lead: "Searched for “\(calls[0].detail!)”", tail: failedTail)
            : PillToolLabel(lead: "Ran ", count: n, noun: .search, tail: failedTail)

    case .list:
        if running { return PillToolLabel(lead: "Listing ", count: n, noun: .directory) }
        if allFailed { return PillToolLabel(lead: "Couldn't list \(n == 1 ? "the directory" : "\(n) directories")") }
        return PillToolLabel(lead: "Listed ", count: n, noun: .directory, tail: failedTail)

    case .other:
        let fragment = toolGroupFragment(name: entry.name, count: n)
        let sentence = fragment.prefix(1).uppercased() + fragment.dropFirst()
        if running { return PillToolLabel(lead: "Working · \(sentence)") }
        if allFailed { return PillToolLabel(lead: "\(sentence) — failed") }
        return PillToolLabel(lead: sentence, tail: failedTail)
    }
}

// MARK: - The pill

/// One tool's calls in the dispatch pill's own material (user, 2026-10-02): a dark capsule holding
/// the plume's discs and a sentence that says what is happening — "Searching the web · 12 websites",
/// "Reading nytimes.com" — and then what happened — "Searched 20 websites", "Ran 3 shell commands".
/// Counts climb one by one as they arrive; names rotate every half second with their favicons; a
/// running pill's text shimmers (`PillTextShimmer`); a failed one turns red. One pill per tool: a
/// turn that searched and then ran commands shows two.
struct PillToolRunHeader: View {
    let entries: [ToolRunEntry]
    let turnIsLive: Bool
    let isExpanded: Bool
    let toggle: () -> Void

    /// Bumped while a favicon is still loading, so the row looks again (the cache is not observable).
    @State private var faviconTick = 0

    static let discSize: CGFloat = 22
    static let maxDiscs = 5
    static let height: CGFloat = 34
    static let rotationPeriod: TimeInterval = 0.5

    private var entry: ToolRunEntry { entries.first ?? ToolRunEntry(name: "", calls: []) }
    private var status: ToolCallStatus { toolRunStatus(entries, turnIsLive: turnIsLive) }
    private static let failureRed = Color(red: 1.0, green: 0.45, blue: 0.40)

    var body: some View {
        let label = pillToolLabel(entry, turnIsLive: turnIsLive)
        let discs = toolRunDiscs(entries)
        let running = status == .running
        let failed = status == .failed && !running
        Button(action: toggle) {
                TimelineView(.periodic(from: .now, by: Self.rotationPeriod)) { timeline in
                    let tick = Int(timeline.date.timeIntervalSinceReferenceDate / Self.rotationPeriod)
                    HStack(spacing: 10) {
                        discStack(discs, label: label, running: running, tick: tick)
                        labelText(label, tick: tick)
                            .modifier(PillTextShimmer(active: running))
                        if failed {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(Typography.label(.semibold))
                                .foregroundStyle(Self.failureRed)
                                .accessibilityLabel("Failed")
                        }
                        Image(systemName: "chevron.down")
                            .font(Typography.badge(.bold))
                            .foregroundStyle(Color.white.opacity(0.45))
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    }
                }
                .padding(.leading, 6)
                .padding(.trailing, 14)
                .frame(height: Self.height)
                .background(Capsule().fill(failed ? Self.failureRed.opacity(0.10) : Color.white.opacity(0.06)))
                .overlay(Capsule().strokeBorder(failed ? Self.failureRed.opacity(0.45)
                                                : running ? Color.white.opacity(0.55) : Color.white.opacity(0.08),
                                                lineWidth: 1))
                .clipShape(Capsule())
                .contentShape(Capsule())
                .animation(.easeInOut(duration: 0.3), value: status)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .task(id: discs) { await waitForFavicons(discs) }
    }

    @ViewBuilder
    private func labelText(_ label: PillToolLabel, tick: Int) -> some View {
        HStack(spacing: 0) {
            Text(label.lead)
            if !label.rotation.isEmpty {
                Text(label.rotation[tick % label.rotation.count].text)
                    .id(tick % label.rotation.count)
                    .transition(.opacity)
            } else if let count = label.count, let noun = label.noun {
                PillCountUp(target: count, animates: turnIsLive) { shown in Text("\(shown) \(noun(shown))") }
            }
            Text(label.tail)
        }
        .font(Typography.label(.medium))
        .lineLimit(1)
        .truncationMode(.middle)
        .animation(.easeInOut(duration: 0.18), value: tick)
    }

    /// The discs: while a search or a page read is running, the front disc takes turns through the
    /// sites seen so far (with the rotating name, its own favicon); otherwise the run's discs, overlapped.
    @ViewBuilder
    private func discStack(_ discs: [PlumeThrow], label: PillToolLabel, running: Bool, tick: Int) -> some View {
        let rotatingDisc = label.rotation.isEmpty ? nil : label.rotation[tick % label.rotation.count].disc
        let siteDiscs = discs.filter { if case .site = $0.kind { return true } else { return false } }
        if running, let rotatingDisc {
            PillToolDisc(disc: rotatingDisc, size: Self.discSize, tick: faviconTick)
                .id(rotatingDisc.kind)
                .transition(.opacity)
        } else if running, PillToolKind(toolName: entry.name) == .search, !siteDiscs.isEmpty {
            let disc = siteDiscs[tick % siteDiscs.count]
            PillToolDisc(disc: disc, size: Self.discSize, tick: faviconTick)
                .id(disc.kind)
                .transition(.opacity)
        } else {
            let shown = Array(discs.prefix(Self.maxDiscs))
            HStack(spacing: -7) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, disc in
                    PillToolDisc(disc: disc, size: Self.discSize, tick: faviconTick)
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

/// A number that climbs to its target one step at a time — "1 … 10", then "11 … 20" when another
/// search reports in — never jumping. A pill that is not live (history) shows its number as is.
struct PillCountUp<Content: View>: View {
    let target: Int
    let animates: Bool
    @ViewBuilder let content: (Int) -> Content
    @State private var shown: Int?

    /// The whole climb takes at most this long, however far it has to go.
    static var maxClimb: TimeInterval { 0.9 }

    var body: some View {
        content(shown ?? target)
            .contentTransition(.numericText())
            .task(id: target) {
                guard animates else { shown = target; return }
                var current = shown ?? (target > 1 ? 1 : target)
                shown = current
                let steps = max(1, target - current)
                let interval = min(0.06, Self.maxClimb / Double(steps))
                while current < target {
                    try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                    if Task.isCancelled { return }
                    current += 1
                    withAnimation(.easeOut(duration: 0.12)) { shown = current }
                }
                if current > target { shown = target }
            }
    }
}

/// The running pill's text shimmer (user, 2026-10-04 — in place of a band across the whole capsule):
/// the label dims, and a bright band passes through its letters, left to right, then rests a beat.
/// The label is drawn ONCE and masked (never duplicated, so the climbing count and the rotating names
/// stay single). Off under Reduce Motion, where the label simply stays lit.
private struct PillTextShimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let period: TimeInterval = 2.0
    /// The share of a period the band takes to cross; the rest is the pause before the next pass.
    static let sweepShare: Double = 0.7

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            // White text whose opacity is the mask's: half everywhere, full under the moving band.
            content
                .foregroundStyle(Color.white)
                .mask {
                    TimelineView(.animation) { timeline in
                        let t = timeline.date.timeIntervalSinceReferenceDate
                        let phase = min(1, t.truncatingRemainder(dividingBy: Self.period) / (Self.period * Self.sweepShare))
                        GeometryReader { geo in
                            let band = max(60, geo.size.width * 0.6)
                            ZStack(alignment: .leading) {
                                Color.black.opacity(0.5)
                                LinearGradient(colors: [.black.opacity(0), .black, .black.opacity(0)],
                                               startPoint: .leading, endPoint: .trailing)
                                    .frame(width: band)
                                    .offset(x: -band + (geo.size.width + band) * phase)
                            }
                        }
                    }
                }
        } else {
            content.foregroundStyle(Color.white.opacity(0.9))
        }
    }
}

/// One white disc: a tool's symbol in black, or a site's favicon (a grey globe
/// until it loads) — the plume's own tile, standing still. A thin black ring keeps overlapped discs
/// apart.
private struct PillToolDisc: View {
    let disc: PlumeThrow
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
                    .foregroundStyle(Color.black)
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

/// Tool pills side by side (user, 2026-10-02: "the pills should be in front of each other"): left to
/// right in their arrival order, wrapping onto the next line when the column runs out of width.
struct PillFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    private func rows(_ sizes: [CGSize], width: CGFloat) -> [[Int]] {
        var rows: [[Int]] = [[]]
        var x: CGFloat = 0
        for (i, size) in sizes.enumerated() {
            if !rows[rows.count - 1].isEmpty, x + spacing + size.width > width {
                rows.append([])
                x = 0
            }
            x += (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
            rows[rows.count - 1].append(i)
        }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let width = proposal.width ?? .infinity
        var height: CGFloat = 0
        var widest: CGFloat = 0
        for row in rows(sizes, width: width) where !row.isEmpty {
            let rowWidth = row.map { sizes[$0].width }.reduce(0, +) + spacing * CGFloat(row.count - 1)
            widest = max(widest, rowWidth)
            height += (height == 0 ? 0 : lineSpacing) + (row.map { sizes[$0].height }.max() ?? 0)
        }
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        var y = bounds.minY
        for row in rows(sizes, width: bounds.width) where !row.isEmpty {
            var x = bounds.minX
            let rowHeight = row.map { sizes[$0].height }.max() ?? 0
            for i in row {
                subviews[i].place(at: CGPoint(x: x, y: y + (rowHeight - sizes[i].height) / 2),
                                  proposal: ProposedViewSize(sizes[i]))
                x += sizes[i].width + spacing
            }
            y += rowHeight + lineSpacing
        }
    }
}
