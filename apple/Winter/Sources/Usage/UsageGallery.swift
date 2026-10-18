import AppKit
import SwiftUI
import WinterKit

/// Sample usage data and offscreen renders of the Usage window and the island's compact Usage tab
/// (`docs/claude/usage.md`; `UsageWindowTests` with `TEST_RUNNER_WINTER_USAGE_RENDER_DIR=<dir>`).
@MainActor
enum UsageGallery {
    static func samplePlans(now: Date) -> (codex: UsagePlanReading, claude: UsagePlanReading, antigravity: UsagePlanReading) {
        let ms = { (s: Double) in (now.timeIntervalSince1970 + s) * 1000 }
        let codex = UsagePlanReading(provider: "codex", source: "codex-app-server", at: ms(-40), windows: [
            UsagePlanWindow(id: "primary", kind: "five_hour", windowMinutes: 300, usedPercent: 38, resetsAt: ms(2 * 3600 + 14 * 60)),
            UsagePlanWindow(id: "secondary", kind: "weekly", windowMinutes: 10_080, usedPercent: 71, resetsAt: ms(3 * 86400)),
        ], planType: "pro")
        let claude = UsagePlanReading(provider: "claude-code", source: "claude-cli", at: ms(-120), windows: [
            UsagePlanWindow(id: "session:0", kind: "five_hour", windowMinutes: 300, usedPercent: 23, resetsAt: ms(3600 + 5 * 60)),
            UsagePlanWindow(id: "weekly_all:1", kind: "weekly", windowMinutes: 10_080, usedPercent: 61, resetsAt: ms(4 * 86400)),
            UsagePlanWindow(id: "weekly_scoped:opus:2", kind: "weekly_scoped", windowMinutes: 10_080, usedPercent: 92, resetsAt: ms(4 * 86400),
                            scope: "opus"),
        ])
        let antigravity = UsagePlanReading(provider: "antigravity", source: "agy-cli", at: ms(-60), windows: [
            UsagePlanWindow(id: "gemini-weekly", kind: "weekly", windowMinutes: 10_080, usedPercent: 27, resetsAt: ms(6 * 86400), scope: "Gemini"),
            UsagePlanWindow(id: "gemini-5h", kind: "five_hour", windowMinutes: 300, usedPercent: 8, resetsAt: ms(4 * 3600), scope: "Gemini"),
            UsagePlanWindow(id: "3p-weekly", kind: "weekly", windowMinutes: 10_080, usedPercent: 27, resetsAt: ms(6 * 86400), scope: "Claude & GPT"),
            UsagePlanWindow(id: "3p-5h", kind: "five_hour", windowMinutes: 300, usedPercent: 0, resetsAt: ms(4 * 3600), scope: "Claude & GPT"),
        ])
        return (codex, claude, antigravity)
    }

    static let sampleModels: [(UsageSource, String, String, Double, UsageTotals)] = [
        (.claudeCode, "anthropic", "claude-opus-5-5", 0, UsageTotals(costUsd: 41.20, input: 82_000, output: 610_000, cacheRead: 38_000_000, cacheWrite: 1_900_000, cacheSavingsUsd: 68.4, records: 900, syntheticRecords: 40)),
        (.codex, "openai", "gpt-6-sol", 0, UsageTotals(costUsd: 18.75, input: 2_400_000, output: 320_000, cacheRead: 9_100_000, reasoning: 120_000, cacheSavingsUsd: 16.4, records: 210)),
        (.winter, "codex-oauth", "codex-oauth/gpt-6-sol", 0, UsageTotals(costUsd: 6.10, input: 900_000, output: 80_000, cacheRead: 2_600_000, cacheSavingsUsd: 4.7, records: 64)),
        (.winter, "anthropic", "anthropic/claude-sonnet-5-5", 0, UsageTotals(costUsd: 3.42, input: 120_000, output: 40_000, cacheRead: 1_100_000, cacheWrite: 90_000, cacheSavingsUsd: 1.98, records: 31)),
        (.claudeCode, "anthropic", "claude-haiku-4-5-20251001", 0, UsageTotals(costUsd: 0.38, input: 210_000, output: 30_000, cacheRead: 400_000, cacheSavingsUsd: 0.36, records: 44)),
        (.opencode, "nvidia", "nvidia/deepseek-ai/deepseek-v4-pro", 0, UsageTotals(costUsd: 0.37, input: 2_000, output: 400, cacheRead: 10_000, records: 1)),
    ]

    static func sampleSeries(now: Date, range: UsageRange = .week) -> UsageSeries {
        let bucket: Double = range == .week ? 6 * 3600 : 3600
        let count = range == .week ? 28 : 24
        let from = now.timeIntervalSince1970 * 1000 - Double(count) * bucket * 1000
        let rows = sampleModels.map {
            UsageModelRow(source: $0.0, provider: $0.1, model: $0.2,
                          costBasis: $0.0 == .opencode ? "reported" : $0.0 == .winter && $0.1 == "anthropic" ? "list" : "estimate", totals: $0.4)
        }
        let buckets: [UsageBucket] = (0..<count).map { i in
            // A day/night rhythm, deterministic.
            let wave = max(0, sin(Double(i) / Double(count) * .pi * 8 - 1)) + 0.15
            let models = rows.enumerated().map { j, r in
                UsageBucket.Model(source: r.source, model: r.model, costUsd: r.totals.costUsd / Double(count) * wave * (1.2 - Double(j) * 0.1),
                                  tokens: r.totals.tokens / Double(count) * wave)
            }
            return UsageBucket(start: from + Double(i) * bucket * 1000, costUsd: models.reduce(0) { $0 + $1.costUsd },
                               tokens: models.reduce(0) { $0 + $1.tokens }, models: models)
        }
        let totals = rows.reduce(UsageTotals()) { a, r in
            UsageTotals(costUsd: a.costUsd + r.totals.costUsd, input: a.input + r.totals.input, output: a.output + r.totals.output,
                        cacheRead: a.cacheRead + r.totals.cacheRead, cacheWrite: a.cacheWrite + r.totals.cacheWrite,
                        reasoning: a.reasoning + r.totals.reasoning, unpricedTokens: 0, cacheSavingsUsd: a.cacheSavingsUsd + r.totals.cacheSavingsUsd,
                        records: a.records + r.totals.records)
        }
        var bySource: [UsageSource: UsageTotals] = [:]
        for r in rows { bySource[r.source] = UsageTotals(costUsd: (bySource[r.source]?.costUsd ?? 0) + r.totals.costUsd) }
        return UsageSeries(range: range.rawValue, from: from, to: now.timeIntervalSince1970 * 1000, bucketMs: bucket * 1000, buckets: buckets,
                           models: rows, totals: totals, bySource: bySource)
    }

    static func sampleSummary(now: Date, range: UsageRange = .day) -> UsageSummary {
        let series = sampleSeries(now: now, range: range)
        let plans = samplePlans(now: now)
        return UsageSummary(range: range.rawValue, from: series.from, to: series.to, bucketMs: series.bucketMs, totals: series.totals,
                            bySource: series.bySource, topModels: Array(series.models.prefix(5)), spark: series.buckets.map(\.costUsd),
                            sparkTokens: series.buckets.map(\.tokens), codexPlan: plans.codex, claudeCodePlan: plans.claude, antigravityPlan: plans.antigravity,
                            claudeCodeStatsBefore: (now.timeIntervalSince1970 - 30 * 86400) * 1000)
    }

    static func sampleSubscriptions(now: Date) -> [UsageSubscription] {
        let ms = { (d: Double) in (now.timeIntervalSince1970 + d * 86400) * 1000 }
        return [
            UsageSubscription(id: "a", name: "ChatGPT Pro", provider: "openai", price: 200, currency: "USD", cadence: "monthly", renewalDay: 3,
                              covers: ["codex", "winter:codex-oauth"], nextRenewal: ms(16), cycleStart: ms(-15), monthlyCost: 200, usageThisCycleUsd: 412.5),
            UsageSubscription(id: "b", name: "Claude Max", provider: "anthropic", price: 1200, currency: "EUR", cadence: "yearly", renewalDay: 1,
                              renewalMonth: 3, covers: ["claude-code"], nextRenewal: ms(134), cycleStart: ms(-231), monthlyCost: 100, usageThisCycleUsd: 2_310),
        ]
    }

    /// The Usage window, flat (no scroll view), with sample data.
    static func renderWindow(to directory: URL, now: Date = Date()) throws -> URL {
        let model = UsageWindowModel()
        model.now = { now }
        model.setForTesting(series: sampleSeries(now: now), summary: sampleSummary(now: now, range: .week), subscriptions: sampleSubscriptions(now: now))
        let view = UsageWindowRootView(model: model, onClose: {}, onMinimize: {}, onZoom: {}, scrolls: false)
            .frame(width: 920, height: 1740)
        return try write(view, directory, "usage-window@2x.png")
    }

    /// The window with nothing tracked yet (empty states, Claude Code tracking off).
    static func renderEmptyWindow(to directory: URL, now: Date = Date()) throws -> URL {
        let model = UsageWindowModel()
        model.now = { now }
        model.setForTesting(series: UsageSeries(range: "7d"), summary: UsageSummary(
            range: "7d", codexPlan: UsagePlanReading(provider: "codex", source: "winter-codex-oauth", at: (now.timeIntervalSince1970 - 600) * 1000,
                                                     statusOnly: [UsagePlanStatusWindow(rateLimitType: "five_hour", status: "allowed", resetsAt: (now.timeIntervalSince1970 + 3600) * 1000, at: 0)]),
            claudeCodePlan: UsagePlanReading(provider: "claude-code", source: "disabled"), trackClaudeCode: false))
        let view = UsageWindowRootView(model: model, onClose: {}, onMinimize: {}, onZoom: {}, scrolls: false)
            .frame(width: 920, height: 1000)
        return try write(view, directory, "usage-window-empty@2x.png")
    }

    /// The island's compact Usage block alone, at the island's width, laid out flat.
    static func renderCompact(to directory: URL, now: Date = Date()) throws -> URL {
        let model = IslandUsageModel()
        model.setForTesting(nil, summary: sampleSummary(now: now))
        let view = IslandUsageCompact(model: model, now: now)
            .padding(14)
            .frame(width: IslandLayout.islandWidth)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        return try write(view, directory, "island-usage-compact@2x.png")
    }

    private static func write<V: View>(_ view: V, _ directory: URL, _ name: String) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "UsageGallery", code: 1, userInfo: [NSLocalizedDescriptionKey: "render failed: \(name)"])
        }
        let url = directory.appendingPathComponent(name)
        try png.write(to: url)
        return url
    }
}
