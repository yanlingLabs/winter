import AppKit
import SwiftUI
import WinterKit

// Usage and cost tracking, the app half (`docs/claude/usage.md`): the PURE shaping both surfaces draw from — the
// island's compact Usage tab and the Usage window. Money is USD from the daemon; a figure's basis (the runtime's own
// list price, Winter's list-price estimate, unknown) is always said, never implied.

/// One plan ring: a window of the user's own Codex or Claude Code plan.
struct UsagePlanRing: Identifiable, Equatable {
    let id: String
    /// "5-hour", "Weekly", "Fable" (a per-model weekly limit is named by its model alone).
    let title: String
    /// 0…1: what is USED of the window — the line's fill, and its number on hover (user 2026-10-18: back to used).
    let fraction: Double
    /// The same (kept for readers that name it).
    var used: Double { fraction }
    /// "resets in 2 h 14 min"; a window a day or longer says WHEN — "resets Thu 9:00" (user 2026-10-18: the weekly reset
    /// date). Nil without a reset, or once it passed.
    let resets: String?
    /// The same, short enough for the island's compact ring: "2 h 14 min", "Thu 9:00".
    var resetsShort: String? = nil
    let stale: Bool
    /// Inside the line under the pointer (user 2026-10-18): "Resets Oct 19 at 2pm", or "Resets 11:10pm" the same day.
    var resetsHover: String? = nil
    /// The window's stable key — what its alarms name (`UsagePresentation.windowKey`).
    var alarmKey: String = ""
}

/// A plan's slot: Codex now, Claude Code beside it — its rings, where the numbers came from and how old they are, or
/// why there are none.
struct UsagePlanSlot: Identifiable, Equatable {
    let id: String
    /// "Codex", "Claude Code".
    let title: String
    let rings: [UsagePlanRing]
    /// "From Codex · just now", "From Codex's last session · 3 h ago · stale".
    let sourceLine: String
    /// A line in place of rings: "Status only: within limits · resets in 2 h", "Not found on this Mac", "Off".
    let emptyLine: String?
    /// "Pro", when the source named the plan.
    let planType: String?
}

/// One stacked series point for the window's chart.
struct UsageChartPoint: Identifiable, Equatable {
    var id: String { "\(series)|\(slot)" }
    /// The bucket's index — the chart's x is CATEGORICAL (one bar per bucket, sized by the chart), keyed `slotKey`.
    let slot: Int
    var slotKey: String { String(format: "%04d", slot) }
    let start: Date
    let series: String
    let value: Double
}

enum UsageMetric: String, CaseIterable { case cost, tokens }

enum UsagePresentation {
    // MARK: words

    static func rangeTitle(_ r: UsageRange) -> String {
        switch r {
        case .hour: return "Last hour"
        case .day: return "Last 24 hours"
        case .week: return "Last 7 days"
        case .month: return "Last 30 days"
        case .all: return "All time"
        }
    }

    static func rangeShort(_ r: UsageRange) -> String {
        switch r {
        case .hour: return "1H"
        case .day: return "24H"
        case .week: return "7D"
        case .month: return "30D"
        case .all: return "All"
        }
    }

    static func sourceTitle(_ s: UsageSource) -> String {
        switch s {
        case .winter: return "Winter"
        case .codex: return "Codex"
        case .claudeCode: return "Claude Code"
        case .opencode: return "OpenCode"
        }
    }

    /// PURE: whether a source gets its toggle — OpenCode has no plan slot to say "not on this Mac", so its toggle shows
    /// only when the daemon says it is installed (its stored rows still count in the history either way).
    static func showsToggle(_ source: UsageSource, summary: UsageSummary?) -> Bool {
        source != .opencode || summary?.opencodeInstalled == true
    }

    /// PURE: the sources a request may name — `opencode` only once the daemon has said it knows that source (an older
    /// daemon refuses an unknown source, and with it the whole summary).
    static func requestSources(_ sources: Set<UsageSource>, summary: UsageSummary?) -> Set<UsageSource> {
        summary?.opencodeInstalled == nil ? sources.subtracting([.opencode]) : sources
    }

    /// PURE: USD as words — "$0", "<$0.01", "$3.42", "$1,284".
    static func cost(_ usd: Double) -> String {
        if usd <= 0 { return "$0" }
        if usd < 0.01 { return "<$0.01" }
        if usd < 1_000 { return String(format: "$%.2f", usd) }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        f.locale = Locale(identifier: "en_US")
        return "$" + (f.string(from: NSNumber(value: usd.rounded())) ?? String(Int(usd.rounded())))
    }

    /// PURE: a token count — 1234 → "1.2k".
    static func tokens(_ n: Double) -> String { islandCompactCount(Int(max(0, n).rounded())) }

    /// PURE: a model's display name — the provider prefix dropped ("anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5").
    static func modelName(_ model: String) -> String {
        guard let slash = model.firstIndex(of: "/") else { return model }
        return String(model[model.index(after: slash)...])
    }

    /// PURE: how a cost was reached, as a short mark ("" for the runtime's own list price).
    static func basisMark(_ basis: String) -> String {
        switch basis {
        case "list": return ""
        case "estimate": return "est."
        case "reported": return "reported"
        case "mixed": return "part est."
        default: return "unpriced"
        }
    }

    /// PURE: a model row's cost mark — "est." with a "*" when some of its days are Claude Code `/stats` estimates.
    static func basisMark(_ row: UsageModelRow) -> String {
        let mark = basisMark(row.costBasis)
        return row.totals.syntheticRecords > 0 ? mark + "*" : mark
    }

    /// PURE: the Claude Code section's history line ("History before 1 Oct 2026 from Claude Code’s /stats"), or nil.
    /// `before` is noon UTC of the first transcript day: the same calendar date in every zone the app runs in.
    static func statsHistoryLine(before: Double?) -> String? {
        guard let before else { return nil }
        let utc = TimeZone(identifier: "UTC") ?? .current
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
        style.timeZone = utc
        return "History before \(Date(timeIntervalSince1970: before / 1000).formatted(style)) from Claude Code’s /stats"
    }

    /// PURE: a plan source as words.
    static func planSourceWords(_ source: String) -> String {
        switch source {
        case "codex-app-server": return "From Codex"
        case "codex-rollout": return "From Codex’s last session"
        case "winter-codex-oauth": return "From Winter’s ChatGPT sign-in"
        case "claude-cli": return "From Claude Code"
        case "claude-cache": return "From Claude Code’s cache"
        case "agy-cli": return "From Antigravity"
        case "disabled": return "Tracking off"
        default: return "Not found"
        }
    }

    // MARK: plans

    static func windowTitle(_ w: UsagePlanWindow) -> String {
        if let scope = w.scope, !scope.isEmpty {
            // A model GROUP's own windows (Antigravity's): its main group, Gemini, reads like every other plan ("5-hour",
            // "Weekly"); any other group is "Other" — short beside the rest (user 2026-10-18: "Other 5h", "Other W").
            if w.kind == "five_hour" || w.kind == "weekly" {
                if scope.caseInsensitiveCompare("Gemini") == .orderedSame { return w.kind == "five_hour" ? "5-hour" : "Weekly" }
                return w.kind == "five_hour" ? "Other 5h" : "Other W"
            }
            // A per-model weekly limit is named by its model alone ("Fable", not "Weekly · Fable" — user 2026-10-18).
            return scopeName(scope)
        }
        switch w.kind {
        case "five_hour": return "5-hour"
        case "weekly", "weekly_scoped": return "Weekly"
        default: return w.windowMinutes.map { $0 >= 1_440 ? "\(Int($0 / 1_440))-day" : "\(Int($0 / 60))-hour" } ?? "Window"
        }
    }

    /// PURE: a limit's model scope as a name — the model family when it is one ("claude-fable-5-1", "fable" → "Fable"),
    /// else the scope capitalised.
    static func scopeName(_ scope: String) -> String {
        let lower = scope.lowercased()
        for family in ["fable", "opus", "sonnet", "haiku"] where lower.contains(family) {
            return family.prefix(1).uppercased() + family.dropFirst()
        }
        return scope.prefix(1).uppercased() + scope.dropFirst()
    }

    /// PURE: a reading's rings, the 5-hour first, then weekly, then per-model weekly — a model group's windows
    /// (Antigravity's) together, the groups in the order the source gave them.
    static func rings(_ reading: UsagePlanReading?, now: Date) -> [UsagePlanRing] {
        guard let reading else { return [] }
        let order: [String: Int] = ["five_hour": 0, "weekly": 1, "weekly_scoped": 2]
        var groups: [String] = []
        for w in reading.windows where w.kind != "weekly_scoped" {
            if let scope = w.scope, !groups.contains(scope) { groups.append(scope) }
        }
        let group = { (w: UsagePlanWindow) -> Int in w.kind == "weekly_scoped" ? 0 : w.scope.flatMap { groups.firstIndex(of: $0) } ?? 0 }
        return reading.windows
            .sorted { (group($0), order[$0.kind] ?? 3, $0.id) < (group($1), order[$1.kind] ?? 3, $1.id) }
            .map { w in
                let reset = w.resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) }.flatMap { $0 > now ? $0 : nil }
                let short = reset.map { resetWords($0, windowMinutes: w.windowMinutes ?? (w.kind == "five_hour" ? 300 : 10_080), now: now) }
                return UsagePlanRing(id: w.id, title: windowTitle(w), fraction: min(1, max(0, w.usedPercent / 100)),
                                     resets: short.map { "resets \($0)" }, resetsShort: short, stale: w.stale,
                                     resetsHover: reset.map { hoverResetWords($0, now: now) }, alarmKey: windowKey(w))
            }
    }

    /// PURE: a window's stable key — the daemon's own (`planWindowKey`, carried as `windowKey`), else the same rule: its
    /// kind and its scope lower-cased ("weekly_scoped:fable"); a window of another length adds its minutes ("other@1440").
    static func windowKey(_ w: UsagePlanWindow) -> String {
        if let key = w.windowKey, !key.isEmpty { return key }
        let base = w.kind == "other" ? w.windowMinutes.map { "other@\(Int($0.rounded()))" } ?? "other" : w.kind
        let scope = w.scope.map(scopeKey) ?? ""
        return scope.isEmpty ? base : "\(base):\(scope)"
    }

    /// PURE: a scope's key — the daemon's `planScopeKey`: the model family it names ("Claude Opus 4.5" → "opus"), else
    /// the scope trimmed and lower-cased ("Gemini" → "gemini").
    static func scopeKey(_ scope: String) -> String {
        let lower = scope.trimmingCharacters(in: .whitespaces).lowercased()
        return ["fable", "opus", "sonnet", "haiku"].first { lower.contains($0) } ?? lower
    }

    // MARK: alarms

    /// PURE: a fired alarm's notification, its first line — the plan, its window as the plan's line names it, and the
    /// threshold: "Claude Code · Weekly at 80%", "Antigravity · Other W at 80%".
    static func alarmNoticeTitle(_ item: IslandUsageAlarmItem) -> String {
        let window = UsagePlanWindow(id: item.windowKey, kind: item.kind, windowMinutes: item.windowMinutes, usedPercent: item.usedPercent,
                                     scope: item.scope)
        return "\(planTitle(provider: item.provider)) · \(windowTitle(window)) at \(item.thresholdPercent)%"
    }

    /// PURE: its second line — when the window resets, in the hovered line's words ("Resets Oct 19 at 2pm"); nil without
    /// a reset still ahead.
    static func alarmNoticeDetail(_ item: IslandUsageAlarmItem, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard let ms = item.resetsAt else { return nil }
        let reset = Date(timeIntervalSince1970: ms / 1000)
        return reset > now ? hoverResetWords(reset, now: now, calendar: calendar, locale: locale) : nil
    }

    /// PURE: when a window resets — a short one as a countdown ("in 2 h 14 min"), a day-long or longer one as its day
    /// and time ("Thu 9:00", in the user's locale and time zone), or its date once more than a week away ("Oct 30").
    static func resetWords(_ reset: Date, windowMinutes: Double, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard windowMinutes >= 1_440 else { return islandRelativeFuture(reset, now: now) }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = locale
        f.setLocalizedDateFormatFromTemplate(reset.timeIntervalSince(now) < 6.5 * 86_400 ? "EEEjmm" : "MMMd")
        return f.string(from: reset)
    }

    /// PURE: the reset inside a hovered line (user 2026-10-18) — "Resets 11:10pm" when it falls today, else
    /// "Resets Oct 19 at 2pm"; the minutes only when they are not :00.
    static func hoverResetWords(_ reset: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: reset)
        let hour = parts.hour ?? 0, minute = parts.minute ?? 0
        let clock = "\(hour % 12 == 0 ? 12 : hour % 12)\(minute == 0 ? "" : String(format: ":%02d", minute))\(hour < 12 ? "am" : "pm")"
        if calendar.isDate(reset, inSameDayAs: now) { return "Resets \(clock)" }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = locale
        f.dateFormat = "MMM d"
        return "Resets \(f.string(from: reset)) at \(clock)"
    }

    /// PURE: a plan's badge (user 2026-10-18) — Codex's own names spelled out ("prolite" → "Pro Lite", "promax" → "Pro
    /// Max"), a plan with its size ("max_20x" → "Max 20x"), else its words capitalised ("plus" → "Plus").
    static func planBadge(_ raw: String) -> String {
        let spelled: [String: String] = ["prolite": "Pro Lite", "promax": "Pro Max"]
        if let name = spelled[raw.lowercased()] { return name }
        if let m = raw.range(of: #"_(\d{1,3})x$"#, options: .regularExpression) {
            let name = String(raw[..<m.lowerBound])
            return "\(planBadge(name)) \(raw[raw.index(after: m.lowerBound)...])"
        }
        return raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// PURE: whether a plan gets a slot at all — not when its app is not on this Mac (user 2026-10-18). Before the
    /// first answer it shows ("Reading…").
    static func showsSlot(_ reading: UsagePlanReading?) -> Bool { reading?.source != "not-installed" }

    /// The plans in the order both surfaces show them: Codex, Claude Code, Antigravity.
    static func plans(_ summary: UsageSummary?) -> [(provider: String, reading: UsagePlanReading?)] {
        [("codex", summary?.codexPlan), ("claude-code", summary?.claudeCodePlan), ("antigravity", summary?.antigravityPlan)]
    }

    static func planTitle(provider: String) -> String {
        switch provider {
        case "codex": return "Codex"
        case "antigravity": return "Antigravity"
        default: return "Claude Code"
        }
    }

    /// PURE: the plan lines' title column — the floor (52 pt in the island, 72 in the window), wider only when a title
    /// needs it ("Claude & GPT week"), so no title truncates and every line of a block starts at one x. Under the pointer
    /// the title grows (`UsagePlanLine.titleScale`) while the track reaches left by half its growth
    /// (`UsagePlanLine.lengthGrowth`): the column leaves room for both, so the widest title never touches the track.
    static func titleColumnWidth(_ titles: [String], compact: Bool) -> CGFloat {
        let font = Typography.sansNS(ofSize: Typography.tinySize, .medium)
        let widest = titles.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return max(compact ? 52 : 72, (max(widest, hoverTitleReach(titles, compact: compact)) + 1).rounded(.up))
    }

    /// PURE: how far right of the column's start the widest title reaches under the pointer, measured against the
    /// track's hovered start (the column's width + the gap − the leftward growth): the column is wide enough when this
    /// is at most its width.
    static func hoverTitleReach(_ titles: [String], compact: Bool) -> CGFloat {
        let font = Typography.sansNS(ofSize: Typography.tinySize, .medium)
        let widest = titles.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return widest * UsagePlanLine.titleScale(hovered: true) + UsagePlanLine.lengthGrowth(hovered: true) / 2
            - UsagePlanLine.titleGap(compact: compact)
    }

    /// PURE: a plan's slot. `provider` is "codex", "claude-code" or "antigravity" (its reading may be nil before the
    /// first answer).
    static func slot(provider: String, reading: UsagePlanReading?, now: Date) -> UsagePlanSlot {
        let title = planTitle(provider: provider)
        guard let reading else {
            return UsagePlanSlot(id: provider, title: title, rings: [], sourceLine: "", emptyLine: "Reading…", planType: nil)
        }
        let rings = rings(reading, now: now)
        var parts = [planSourceWords(reading.source)]
        if let at = reading.at { parts.append(islandRelativePast(Date(timeIntervalSince1970: at / 1000), now: now)) }
        if rings.contains(where: \.stale) { parts.append("stale") }
        let planType = reading.planType.map(planBadge)
        if !rings.isEmpty {
            return UsagePlanSlot(id: provider, title: title, rings: rings, sourceLine: parts.joined(separator: " · "), emptyLine: nil, planType: planType)
        }
        let empty: String
        switch reading.source {
        case "winter-codex-oauth":
            let w = reading.statusOnly.first
            let status = IslandUsagePresentation.statusText(w?.status)
            let reset = w?.resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) }.flatMap { $0 > now ? " · resets \(islandRelativeFuture($0, now: now))" : nil } ?? ""
            empty = "Status only: \(status.lowercased())\(reset)"
        case "disabled":
            empty = "Tracking is off"
        default:
            empty = provider == "codex" ? "Codex not found on this Mac" : "No plan report from \(title)"
        }
        return UsagePlanSlot(id: provider, title: title, rings: [], sourceLine: parts.joined(separator: " · "), emptyLine: empty, planType: planType)
    }

    // MARK: series

    /// PURE: a sparkline's points in `size`, the lowest value on the bottom edge (an all-zero series is a flat base).
    static func sparkPoints(_ values: [Double], in size: CGSize) -> [CGPoint] {
        guard values.count > 1 else { return values.isEmpty ? [] : [CGPoint(x: 0, y: size.height), CGPoint(x: size.width, y: size.height)] }
        let top = values.max() ?? 0
        let step = size.width / CGFloat(values.count - 1)
        return values.enumerated().map { i, v in
            let y = top > 0 ? size.height - CGFloat(v / top) * size.height : size.height
            return CGPoint(x: CGFloat(i) * step, y: y)
        }
    }

    /// PURE: the chart's stacked points — the `top` models by the metric's total, each its own series, the rest as
    /// "Other"; one point per bucket per series (zeros included, so stacks line up). Also returns the series order.
    static func chartPoints(_ series: UsageSeries, metric: UsageMetric, top: Int = 6) -> (points: [UsageChartPoint], order: [String]) {
        func label(_ source: UsageSource, _ model: String) -> String { "\(modelName(model)) · \(sourceTitle(source))" }
        var totals: [String: Double] = [:]
        for b in series.buckets {
            for m in b.models { totals[label(m.source, m.model), default: 0] += metric == .cost ? m.costUsd : m.tokens }
        }
        let ranked = totals.filter { $0.value > 0 }.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
        let kept = Array(ranked.prefix(top))
        let hasOther = ranked.count > top
        let order = kept + (hasOther ? ["Other"] : [])
        var points: [UsageChartPoint] = []
        for (slot, b) in series.buckets.enumerated() {
            var values: [String: Double] = [:]
            for m in b.models {
                let key = label(m.source, m.model)
                let v = metric == .cost ? m.costUsd : m.tokens
                values[kept.contains(key) ? key : "Other", default: 0] += v
            }
            let start = Date(timeIntervalSince1970: b.start / 1000)
            for s in order { points.append(UsageChartPoint(slot: slot, start: start, series: s, value: values[s] ?? 0)) }
        }
        return (points, order)
    }

    /// PURE: which buckets get an x-axis label (about `count`, evenly spaced, the first always) and the label for each —
    /// a time of day for buckets under a day, a date otherwise.
    static func axisLabels(_ series: UsageSeries, count: Int = 6) -> [(key: String, text: String)] {
        let n = series.buckets.count
        guard n > 0 else { return [] }
        let stride = max(1, Int((Double(n) / Double(count)).rounded(.up)))
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = series.bucketMs >= 86_400_000 ? "MMM d" : series.bucketMs >= 6 * 3_600_000 ? "EEE HH:mm" : "HH:mm"
        return Swift.stride(from: 0, to: n, by: stride).map { i in
            (String(format: "%04d", i), f.string(from: Date(timeIntervalSince1970: series.buckets[i].start / 1000)))
        }
    }

    /// The chart's series colours: system semantic colours (never a hex — `docs/brand.md` § 3.1), "Other" grey.
    static func seriesColors(_ order: [String]) -> [Color] {
        let palette: [Color] = [Theme.accent, Color(nsColor: .systemPurple), Color(nsColor: .systemOrange), Color(nsColor: .systemGreen),
                                Color(nsColor: .systemPink), Color(nsColor: .systemTeal), Color(nsColor: .systemYellow), Color(nsColor: .systemIndigo)]
        var i = 0
        return order.map { s in
            if s == "Other" { return Color(nsColor: .systemGray) }
            defer { i += 1 }
            return palette[i % palette.count]
        }
    }

    // MARK: subscriptions

    /// PURE: "Renews in 5 d · Nov 3".
    static func renewalLine(_ s: UsageSubscription, now: Date) -> String {
        guard let next = s.nextRenewal.map({ Date(timeIntervalSince1970: $0 / 1000) }) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMM d"
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: now), to: next).day ?? 0
        let when = days <= 0 ? "today" : days == 1 ? "tomorrow" : "in \(days) d"
        return "Renews \(when) · \(f.string(from: next))"
    }

    /// PURE: the plan's price as words — "$200/mo", "€240/yr (€20/mo)".
    static func priceLine(_ s: UsageSubscription) -> String {
        let sym = currencySymbol(s.currency)
        func money(_ v: Double) -> String { v.rounded() == v ? "\(sym)\(Int(v))" : String(format: "\(sym)%.2f", v) }
        if s.cadence == "yearly" { return "\(money(s.price))/yr (\(money(s.monthlyCost ?? s.price / 12))/mo)" }
        return "\(money(s.price))/mo"
    }

    /// PURE: the value-for-money line — "Used $412 at list price this cycle · 2.1× the plan" (the ratio only when the
    /// plan is priced in USD, the usage's currency).
    static func valueLine(_ s: UsageSubscription) -> String {
        guard let used = s.usageThisCycleUsd else { return "" }
        if s.covers.isEmpty { return "Counts no usage — choose what it covers" }
        var line = "Used \(cost(used)) at list price this cycle"
        // The cycle is the plan's own (a month, or a year), so its price is the cycle's price.
        if s.currency.uppercased() == "USD", s.price > 0 {
            line += String(format: " · %.1f× the plan", used / s.price)
        }
        return line
    }

    static func currencySymbol(_ code: String) -> String {
        switch code.uppercased() {
        case "USD": return "$"
        case "EUR": return "€"
        case "GBP": return "£"
        case "JPY": return "¥"
        default: return code.uppercased() + " "
        }
    }

    /// What a plan can cover, with words.
    static let coverOptions: [(id: String, title: String)] = [
        ("codex", "Codex"), ("claude-code", "Claude Code"), ("opencode", "OpenCode"), ("winter:codex-oauth", "Winter on ChatGPT"),
        ("winter", "All of Winter"),
    ]

    /// PURE: a provider's default covers ("openai" → Codex + Winter on ChatGPT).
    static func defaultCovers(provider: String) -> [String] {
        switch provider {
        case "openai": return ["codex", "winter:codex-oauth"]
        case "anthropic": return ["claude-code"]
        default: return []
        }
    }
}
