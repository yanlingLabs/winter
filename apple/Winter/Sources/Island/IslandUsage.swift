import Combine
import SwiftUI
import WinterKit

// The Winter island's Usage and limits tab (`docs/claude/island.md`): what the daemon already knows, nothing estimated.
//
//   - PLAN LIMITS: the windows the runtime reported (`island.usage`'s `windows` — the agent SDK's `rate_limit_event`:
//     a five-hour or weekly window's status, how full it is and when it resets), and the subscription snapshot of
//     Winter's background jobs. A ring per window (when the runtime said how full), the reset as a relative time.
//   - THIS SESSION: the session in front (a Winter window's, else the Dispatch session): its context fill (the last
//     measured context against the model's catalog window — a ring only when both are known) and the tokens its turns
//     counted since the daemon started.
//   - BACKGROUND JOBS: Winter's own background calls (titles, reviewer, dreamer, cleaner, research) — backed off
//     until when, and their tokens since start (`quota.state`'s numbers).
//   - NOTES: each model role's reported problem (`settings.modelRoles`: rate limited, usage limit, out of credits, …),
//     worded as Settings → Roles words it.

struct IslandUsageGauge: Identifiable, Equatable {
    let id: String
    let title: String
    /// How full, 0…1; nil when the runtime did not say.
    let fraction: Double?
    let status: String
    let refused: Bool
    /// "resets in 2 h 14 min" (nil without a reset).
    let resets: String?
    /// "reported 3 min ago".
    let reported: String
}

struct IslandUsageContext: Equatable {
    let title: String
    /// Context fill, 0…1, when both the measured context and the model's window are known.
    let fraction: Double?
    /// "31k of 200k context" / "31k context" / nil.
    let contextLine: String?
    /// "1.2k in · 300 out · 4 turns since Winter started".
    let tokensLine: String
    let model: String?
}

struct IslandUsageBackground: Equatable {
    let limited: Bool
    let line: String
    let tokensLine: String
}

struct IslandUsageNote: Identifiable, Equatable {
    let id: String
    let role: String
    let model: String?
    let text: String
}

enum IslandUsagePresentation {
    /// PURE: a window kind as words.
    static func windowTitle(_ kind: String?) -> String {
        switch kind {
        case "five_hour": return "5-hour window"
        case "seven_day": return "Weekly window"
        case "seven_day_opus": return "Weekly window · Opus"
        case "seven_day_sonnet": return "Weekly window · Sonnet"
        case "seven_day_overage_included": return "Weekly window · with extra usage"
        case "overage": return "Extra usage"
        case let other?: return other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: return "Plan window"
        }
    }

    /// PURE: the runtime's utilization — a FRACTION 0…1 (`SDKRateLimitInfo.utilization`, typed after the upstream SDK
    /// whose unified-limit utilization is a fraction; the pinned provider runtime's own `quotaEvent` never sends one).
    /// Anything outside 0…1 is not that unit: no fill is shown rather than a guessed one.
    static func fraction(_ utilization: Double?) -> Double? {
        guard let u = utilization, u.isFinite, (0...1).contains(u) else { return nil }
        return u
    }

    /// PURE: a window's status as words.
    static func statusText(_ status: String?) -> String {
        switch status {
        case "allowed": return "Within limits"
        case "allowed_warning": return "Nearing the limit"
        case "rejected": return "Limit reached"
        case let other?: return other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: return "Reported"
        }
    }

    /// PURE: a runtime window's gauge id — its provider AND kind (two providers' five-hour windows are two gauges).
    static func windowId(_ w: IslandUsageWindow) -> String {
        "window-\(w.provider ?? "unknown")-\(w.rateLimitType ?? "plan")"
    }

    /// PURE: every plan window, the most constrained first; the background jobs' subscription snapshot is added
    /// only when no runtime window of the same kind is there.
    static func gauges(_ snapshot: IslandUsageSnapshot, now: Date) -> [IslandUsageGauge] {
        var out: [IslandUsageGauge] = snapshot.windows.map { w in
            gauge(id: Self.windowId(w), kind: w.rateLimitType, status: w.status,
                  utilization: w.utilization, resetsAt: w.resetsAt, at: w.at, now: now)
        }
        if let s = snapshot.subscription, !snapshot.windows.contains(where: { $0.rateLimitType == s.rateLimitType }) {
            var g = gauge(id: "subscription", kind: s.rateLimitType, status: s.status ?? "allowed", utilization: s.utilization,
                          resetsAt: s.resetsAt, at: s.at, now: now)
            g = IslandUsageGauge(id: g.id, title: s.rateLimitType == nil ? "Background jobs' plan" : "\(g.title) · background jobs",
                                 fraction: g.fraction, status: g.status, refused: g.refused, resets: g.resets, reported: g.reported)
            out.append(g)
        }
        return out.sorted { a, b in
            if a.refused != b.refused { return a.refused }
            return (a.fraction ?? -1) > (b.fraction ?? -1)
        }
    }

    private static func gauge(id: String, kind: String?, status: String, utilization: Double?, resetsAt: Double?, at: Double,
                              now: Date) -> IslandUsageGauge {
        let resets = resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) }.flatMap { date -> String? in
            date > now ? "resets \(islandRelativeFuture(date, now: now))" : nil
        }
        return IslandUsageGauge(id: id, title: windowTitle(kind), fraction: fraction(utilization), status: statusText(status),
                                refused: status == "rejected", resets: resets,
                                reported: "reported \(islandRelativePast(Date(timeIntervalSince1970: at / 1000), now: now))")
    }

    /// PURE: the session block (nil without a session).
    static func context(_ session: IslandUsageSnapshot.Session?, title: String?) -> IslandUsageContext? {
        guard let session else { return nil }
        var fraction: Double?
        var line: String?
        if let used = session.contextTokens {
            if let window = session.contextWindow, window > 0 {
                fraction = min(1, Double(used) / Double(window))
                line = "\(islandCompactCount(used)) of \(islandCompactCount(window)) context"
            } else {
                line = "\(islandCompactCount(used)) context"
            }
        }
        let turns = session.turns == 1 ? "1 turn" : "\(session.turns) turns"
        let tokens = session.turns == 0
            ? "No turns since Winter started"
            : "\(islandCompactCount(session.inputTokens)) in · \(islandCompactCount(session.outputTokens)) out · \(turns) since Winter started"
        return IslandUsageContext(title: title ?? "This session", fraction: fraction, contextLine: line, tokensLine: tokens,
                                  model: session.model)
    }

    /// PURE: the background jobs' line.
    static func background(_ b: IslandUsageSnapshot.Background, now: Date) -> IslandUsageBackground {
        let line: String
        if b.limited, let resume = b.resumeAt.map({ Date(timeIntervalSince1970: $0 / 1000) }), resume > now {
            line = "Backed off — resumes \(islandRelativeFuture(resume, now: now))"
        } else if b.limited {
            line = "Backed off"
        } else {
            line = "Running normally"
        }
        return IslandUsageBackground(limited: b.limited, line: line,
                                     tokensLine: "\(islandCompactCount(b.inputTokens)) in · \(islandCompactCount(b.outputTokens)) out since Winter started")
    }

    /// PURE: each role's reported problem, in Settings → Roles' order and words.
    static func notes(_ roles: [String: ModelRoleValue], now: Date) -> [IslandUsageNote] {
        settingsModelRoleOrder.compactMap { role in
            guard let wire = roles[role.rawValue]?.problem else { return nil }
            let problem = roleProblem(wire)
            return IslandUsageNote(id: role.rawValue, role: settingsModelRoleTitle(role),
                                   model: problem.model.flatMap { $0.isEmpty ? nil : $0 }, text: roleProblemText(problem, now: now))
        }
    }
}

/// The Usage tab's state.
@MainActor
final class IslandUsageModel: ObservableObject {
    @Published private(set) var snapshot: IslandUsageSnapshot?
    @Published private(set) var roles: [String: ModelRoleValue] = [:]
    @Published private(set) var sessionTitle: String?
    @Published private(set) var failed = false
    /// Usage and cost tracking (`docs/claude/usage.md`): the plans and the selected range's cost.
    @Published private(set) var summary: UsageSummary?
    @Published var range: UsageRange = .day { didSet { if range != oldValue { Task { await refreshSummary() } } } }

    var fetchSummary: (UsageRange) async throws -> UsageSummary? = { _ in nil }
    /// "Open usage": the Usage window.
    var openUsage: () -> Void = {}

    var fetch: (_ sessionId: String?) async throws -> IslandUsageSnapshot = { _ in
        IslandUsageSnapshot(windows: [], background: .init(limited: false, inputTokens: 0, outputTokens: 0))
    }
    var fetchRoles: () async throws -> [String: ModelRoleValue] = { [:] }
    /// The session in front: a Winter window's, else the Dispatch session — its id and title.
    var currentSession: () -> (id: String, title: String?)? = { nil }
    var now: () -> Date = { Date() }

    func refresh() async {
        let current = currentSession()
        do {
            snapshot = try await fetch(current?.id)
            failed = false
        } catch {
            failed = snapshot == nil
        }
        sessionTitle = current?.title
        if let r = try? await fetchRoles() { roles = r }
        await refreshSummary()
    }

    func refreshSummary() async {
        let asked = range
        guard let s = try? await fetchSummary(asked), asked == range else { return }
        summary = s
    }

    /// Test seam: set what a refresh would.
    func setForTesting(_ snapshot: IslandUsageSnapshot?, roles: [String: ModelRoleValue] = [:], sessionTitle: String? = nil,
                       summary: UsageSummary? = nil) {
        self.snapshot = snapshot
        self.summary = summary
        self.roles = roles
        self.sessionTitle = sessionTitle
    }
}

// MARK: - The view

struct IslandUsageTab: View {
    @ObservedObject var model: IslandUsageModel
    var now = Date()

    var body: some View {
        if let snapshot = model.snapshot {
            content(snapshot)
        } else {
            IslandEmptyTab(symbol: "gauge.with.dots.needle.50percent", line: model.failed ? "Couldn't read usage" : "Reading usage…")
        }
    }

    @ViewBuilder
    private func content(_ snapshot: IslandUsageSnapshot) -> some View {
        let gauges = IslandUsagePresentation.gauges(snapshot, now: now)
        let context = IslandUsagePresentation.context(snapshot.session, title: model.sessionTitle)
        let background = IslandUsagePresentation.background(snapshot.background, now: now)
        let notes = IslandUsagePresentation.notes(model.roles, now: now)
        VStack(alignment: .leading, spacing: 12) {
            // Usage and cost (`docs/claude/usage.md`), compact: the plans, the range's cost, the top models, the window.
            IslandUsageCompact(model: model, now: now)
            // Other providers' runtime-reported windows (the Codex ones are in the Codex slot above).
            let codexIds = Set(snapshot.windows.filter { $0.provider == "codex-oauth" }.map(IslandUsagePresentation.windowId))
            let others = gauges.filter { !codexIds.contains($0.id) }
            if !others.isEmpty {
                section("Other plan windows")
                VStack(spacing: 8) {
                    ForEach(Array(stride(from: 0, to: others.count, by: 2)), id: \.self) { i in
                        HStack(spacing: 8) {
                            IslandUsageGaugeTile(gauge: others[i])
                            if i + 1 < others.count { IslandUsageGaugeTile(gauge: others[i + 1]) } else { Color.clear.frame(maxWidth: .infinity) }
                        }
                    }
                }
            }
            if let context {
                section("This session")
                IslandUsageContextRow(context: context)
            }
            section("Background jobs")
            IslandHoverSurface { _ in
                HStack(spacing: 10) {
                    Image(systemName: background.limited ? "hourglass" : "checkmark.circle")
                        .font(Typography.label(.semibold))
                        .foregroundStyle(background.limited ? pillReviewAmber : Theme.textMuted)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(background.line).font(Typography.label(.medium)).foregroundStyle(Color.white)
                        Text(background.tokensLine).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(height: 46)
            }
            if !notes.isEmpty {
                section("Notes")
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(notes) { note in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(note.role).font(Typography.label(.medium)).foregroundStyle(Color.white)
                                Spacer(minLength: 6)
                                if let m = note.model {
                                    Text(m).font(Typography.captionMono()).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.middle)
                                }
                            }
                            Text(note.text).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: IslandLayout.rowCorner, style: .continuous).fill(Color.white.opacity(0.06)))
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }

    private func section(_ title: String) -> some View {
        Text(title.uppercased())
            .font(Typography.tiny(.semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 6)
            .padding(.top, 2)
    }
}

struct IslandUsageGaugeTile: View {
    let gauge: IslandUsageGauge

    var body: some View {
        IslandHoverSurface { _ in
            HStack(spacing: 10) {
                if let f = gauge.fraction {
                    IslandRing(fraction: f, color: islandFillColor(f, refused: gauge.refused))
                } else {
                    Image(systemName: gauge.refused ? "xmark.octagon.fill" : "checkmark.seal.fill")
                        .font(Typography.heading(.regular))
                        .foregroundStyle(gauge.refused ? Color(nsColor: .systemRed) : Theme.accent)
                        .frame(width: 44, height: 44)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(gauge.title).font(Typography.label(.medium)).foregroundStyle(Color.white).lineLimit(1)
                    Text(gauge.status).font(Typography.caption())
                        .foregroundStyle(gauge.refused ? Color(nsColor: .systemRed) : Theme.textMuted).lineLimit(1)
                    Text(gauge.resets ?? gauge.reported).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
        }
    }
}

struct IslandUsageContextRow: View {
    let context: IslandUsageContext

    var body: some View {
        IslandHoverSurface { _ in
            HStack(spacing: 12) {
                if let f = context.fraction {
                    IslandRing(fraction: f, color: islandFillColor(f))
                } else {
                    Image(systemName: "text.bubble")
                        .font(Typography.heading(.regular))
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: 44, height: 44)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(context.title).font(Typography.label(.medium)).foregroundStyle(Color.white).lineLimit(1)
                    if let line = context.contextLine {
                        Text(line).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                    }
                    Text(context.tokensLine).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(1)
                    if let f = context.fraction {
                        IslandBar(fraction: f, color: islandFillColor(f)).padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                if let model = context.model {
                    Text(model).font(Typography.captionMono()).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 140, alignment: .trailing)
                }
            }
            .padding(10)
        }
    }
}

/// The Usage tab's compact top (`docs/claude/usage.md`): Codex's, Claude Code's and Antigravity's plan lines, the
/// selected range's cost with a tiny sparkline, the top models, and "Open usage" for the full window.
struct IslandUsageCompact: View {
    @ObservedObject var model: IslandUsageModel
    let now: Date

    var body: some View {
        let summary = model.summary
        VStack(alignment: .leading, spacing: 12) {
            // Codex and its lines, then Claude Code's, then Antigravity's (user 2026-10-18) — only the apps on this Mac,
            // one title column for every line (wider than 52 pt only when a title needs it) — the cost block's lines
            // included, so every track starts at one x.
            let slots = UsagePresentation.plans(summary).filter { UsagePresentation.showsSlot($0.reading) }
                .map { UsagePresentation.slot(provider: $0.provider, reading: $0.reading, now: now) }
            let titleWidth = UsagePresentation.titleColumnWidth(slots.flatMap { $0.rings.map(\.title) } + IslandCostBlock.lineTitles,
                                                                compact: true)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(slots) { slot in
                    UsagePlanSlotCard(slot: slot, compact: true, titleWidth: titleWidth)
                }
            }
            IslandCostBlock(model: model, titleWidth: titleWidth)
        }
        .padding(.horizontal, 6)
    }
}

// MARK: - The cost block (the island's visual language)

/// One model's segment of the cost line.
struct IslandCostSegment: Identifiable, Equatable {
    let id: String
    /// The model as named ("claude-sonnet-4.5"); "Other" for the rest.
    let name: String
    let source: UsageSource?
    /// Its share of the range's whole, 0…1.
    let fraction: Double
    /// What it says inside itself under the pointer: "$3.42", or "1.2k tok" for an unpriced model.
    let label: String
    /// Its rank within its source (0 the largest): a source's later segments are its colour, lighter.
    let rank: Int
}

enum IslandCostPresentation {
    /// The most models drawn as their own segments; the rest is one grey "Other".
    static let segmentLimit = 4

    /// PURE: the range's cost as one line of model segments — the top models (by cost, or by tokens when nothing in the
    /// range is priced), each its share of the whole, largest first; what the top ones leave is "Other". Models with
    /// nothing to show are dropped.
    static func segments(_ summary: UsageSummary?) -> [IslandCostSegment] {
        guard let summary else { return [] }
        let byCost = summary.totals.costUsd > 0
        func value(_ r: UsageModelRow) -> Double { byCost ? r.totals.costUsd : r.totals.tokens }
        let rows = summary.topModels.filter { value($0) > 0 }.sorted { value($0) > value($1) }
        let kept = Array(rows.prefix(segmentLimit))
        let keptSum = kept.reduce(0) { $0 + value($1) }
        let whole = max(byCost ? summary.totals.costUsd : summary.totals.tokens, keptSum)
        guard whole > 0 else { return [] }
        var ranks: [UsageSource: Int] = [:]
        var out = kept.map { r -> IslandCostSegment in
            let rank = ranks[r.source, default: 0]
            ranks[r.source] = rank + 1
            let label = byCost && r.costBasis != "unknown" ? UsagePresentation.cost(r.totals.costUsd)
                : UsagePresentation.tokens(r.totals.tokens) + " tok"
            return IslandCostSegment(id: r.id, name: UsagePresentation.modelName(r.model), source: r.source,
                                     fraction: value(r) / whole, label: label, rank: rank)
        }
        let rest = whole - keptSum
        // "Other" only when it is a visible share (rounding never adds a sliver).
        if rest / whole >= 0.005 {
            out.append(IslandCostSegment(id: "other", name: "Other", source: nil, fraction: rest / whole,
                                         label: byCost ? UsagePresentation.cost(rest) : UsagePresentation.tokens(rest) + " tok",
                                         rank: 0))
        }
        return out
    }

    /// PURE: a segment's colour — its source's (`UsagePlanColor`: Codex green, Claude Code clay; Winter's own accent; a
    /// quiet grey for OpenCode, which has no colour of its own), each later model of one source lighter; "Other" grey.
    static func color(_ segment: IslandCostSegment) -> Color {
        let base: Color
        switch segment.source {
        case .codex?: base = UsagePlanColor.codex
        case .claudeCode?: base = UsagePlanColor.claudeCode
        case .winter?: base = Theme.accent
        case .opencode?: base = Color.white.opacity(0.55)
        case nil: return Color.white.opacity(0.22)
        }
        return base.opacity(rankOpacity(segment.rank))
    }

    /// PURE: a source's n-th model's strength: 1, 0.7, 0.5, then 0.4.
    static func rankOpacity(_ rank: Int) -> Double { [1, 0.7, 0.5][safe: rank] ?? 0.4 }

    /// PURE: the words a hovered header adds after the total — the tokens and what was cached ("1.2M tokens · 300k
    /// cached"), else the range's name.
    static func detail(_ summary: UsageSummary?, range: UsageRange) -> String {
        guard let t = summary?.totals, t.tokens > 0 else { return UsagePresentation.rangeTitle(range).lowercased() }
        var parts = ["\(UsagePresentation.tokens(t.input + t.output)) tokens"]
        if t.cacheRead > 0 { parts.append("\(UsagePresentation.tokens(t.cacheRead)) cached") }
        return parts.joined(separator: " · ")
    }

    /// PURE: the names under the line (the top 3 models, "Other" left out) — a model's source added only when two of
    /// them share a name ("gpt-5 · Codex", "gpt-5 · Winter").
    static func legend(_ segments: [IslandCostSegment]) -> [(id: String, name: String, segment: IslandCostSegment)] {
        let shown = Array(segments.filter { $0.source != nil }.prefix(3))
        let names = shown.map(\.name)
        return shown.map { s in
            let twice = names.filter { $0 == s.name }.count > 1
            let name = twice ? "\(s.name) · \(UsagePresentation.sourceTitle(s.source ?? .winter))" : s.name
            return (s.id, name, s)
        }
    }

    /// PURE: the header as VoiceOver says it, at rest too — "Cost $70.22, 4.8M tokens · 51M cached".
    static func headerAccessibility(_ summary: UsageSummary?, range: UsageRange) -> String {
        "Cost \(UsagePresentation.cost(summary?.totals.costUsd ?? 0)), \(detail(summary, range: range))"
    }

    /// PURE: the line as VoiceOver says it — "Cost by model: gpt-5-codex $3.42, claude-sonnet-4.5 $1.10".
    static func accessibilityLine(_ segments: [IslandCostSegment]) -> String {
        segments.isEmpty ? "No usage in this range" : "Cost by model: " + segments.map { "\($0.name) \($0.label)" }.joined(separator: ", ")
    }
}

private extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// The range's cost, quiet (the island's visual language, `docs/claude/island.md`): "Cost" and its total, the range as
/// plain words (1H 24H 7D 30D All), then two lines in the plan lines' column — **Models**, the cost split into each
/// model's coloured share, and **Trend**, the range's sparkline as a thin stroke — and the top models' names, muted,
/// with "Open usage". The whole block hovers as one: the header lifts and adds the tokens, the model line thickens and
/// shows each model's cost inside its segment, the trend brightens and fills, the names brighten.
struct IslandCostBlock: View {
    @ObservedObject var model: IslandUsageModel
    let titleWidth: CGFloat

    /// The two lines' titles (they share the plan lines' title column).
    static let lineTitles = ["Models", "Trend"]

    var body: some View {
        let summary = model.summary
        let segments = IslandCostPresentation.segments(summary)
        HoverLiftReader(id: "cost") { hovered in
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Cost").font(Typography.caption(.semibold)).foregroundStyle(Color.white)
                        Text(UsagePresentation.cost(summary?.totals.costUsd ?? 0))
                            .font(Typography.captionDigits(.medium))
                            .foregroundStyle(Color.white.opacity(hovered ? 1 : 0.8))
                    }
                    .hoverLiftLabel(hovered, anchor: .bottomLeading)
                    // The grown header's room (the block grows, its lines stay put under it).
                    .padding(.top, hovered ? 2 : 0)
                    .padding(.trailing, hovered ? 10 : 0)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(IslandCostPresentation.headerAccessibility(summary, range: model.range))
                    if hovered {
                        Text(IslandCostPresentation.detail(summary, range: model.range))
                            .font(Typography.tinyDigits())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .transition(.opacity)
                    }
                    Spacer(minLength: 8)
                    IslandRangeWords(range: $model.range)
                }
                line(Self.lineTitles[0], hovered: hovered) {
                    HoverSegmentLine(segments: segments.map {
                        HoverSegment(id: $0.id, fraction: $0.fraction, color: IslandCostPresentation.color($0), label: $0.label)
                    }, hovered: hovered)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(IslandCostPresentation.accessibilityLine(segments))
                }
                line(Self.lineTitles[1], hovered: hovered) {
                    IslandCostTrend(values: summary?.spark ?? [], hovered: hovered)
                }
                HStack(spacing: 12) {
                    ForEach(IslandCostPresentation.legend(segments), id: \.id) { item in
                        HStack(spacing: 5) {
                            Capsule().fill(IslandCostPresentation.color(item.segment)).frame(width: 8, height: 3)
                            Text(item.name)
                                .font(Typography.tiny())
                                .foregroundStyle(hovered ? Color.white.opacity(0.85) : Theme.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 8)
                    Button(action: model.openUsage) {
                        HStack(spacing: 3) {
                            Text("Open usage").font(Typography.tiny(.semibold))
                            Image(systemName: "arrow.up.right").font(Typography.micro(.bold))
                        }
                        .foregroundStyle(Color.white.opacity(hovered ? 0.95 : 0.7))
                        .frame(height: 18)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, titleWidth + UsagePlanLine.titleGap(compact: true))
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
    }

    /// A line of the block: its title in the plan lines' column, the shape after it.
    private func line<Shape: View>(_ title: String, hovered: Bool, @ViewBuilder shape: () -> Shape) -> some View {
        HStack(spacing: UsagePlanLine.titleGap(compact: true)) {
            Text(title)
                .font(Typography.tiny(.medium))
                .foregroundStyle(Color.white.opacity(hovered ? 1 : 0.85))
                .lineLimit(1)
                .hoverLiftLabel(hovered)
                .frame(width: titleWidth, alignment: .leading)
            shape()
        }
        .frame(height: HoverLift.hoverThickness)
    }
}

/// The range as plain words — "1H 24H 7D 30D All", the chosen one white with a short line under it, the others muted.
struct IslandRangeWords: View {
    @Binding var range: UsageRange

    var body: some View {
        HStack(spacing: 10) {
            ForEach(UsageRange.allCases, id: \.self) { r in
                Button { range = r } label: {
                    Text(UsagePresentation.rangeShort(r))
                        .font(Typography.tiny(range == r ? .semibold : .medium))
                        .foregroundStyle(range == r ? Color.white : Theme.textMuted)
                        .padding(.vertical, 3)
                        .overlay(alignment: .bottom) {
                            Capsule().fill(Color.white).frame(height: 1.5).opacity(range == r ? 1 : 0)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(UsagePresentation.rangeTitle(r))
                .accessibilityAddTraits(range == r ? .isSelected : [])
            }
        }
    }
}

/// The range's trend as a thin stroke in Winter's accent — under the pointer it thickens, lengthens with the lines and
/// fills beneath. A plain path (drawn by the offscreen renderer too).
struct IslandCostTrend: View {
    let values: [Double]
    var hovered = false

    var body: some View {
        GeometryReader { proxy in
            let pts = UsagePresentation.sparkPoints(values, in: proxy.size)
            ZStack {
                if hovered {
                    Path { p in
                        guard let first = pts.first, let last = pts.last else { return }
                        p.move(to: CGPoint(x: first.x, y: proxy.size.height))
                        for pt in pts { p.addLine(to: pt) }
                        p.addLine(to: CGPoint(x: last.x, y: proxy.size.height))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [Theme.accent.opacity(0.3), Theme.accent.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    .transition(.opacity)
                }
                Path { p in
                    guard let first = pts.first else { return }
                    p.move(to: first)
                    for pt in pts.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(Theme.accent.opacity(hovered ? 1 : 0.7),
                        style: StrokeStyle(lineWidth: hovered ? 1.6 : 1.2, lineCap: .round, lineJoin: .round))
            }
        }
        .padding(.horizontal, -HoverLift.lengthGrowth(hovered: hovered) / 2)
        .frame(height: HoverLift.hoverThickness)
        .accessibilityHidden(true)
    }
}
