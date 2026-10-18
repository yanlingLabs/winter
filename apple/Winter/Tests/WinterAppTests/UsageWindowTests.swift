import XCTest
import SwiftUI
import WinterKit
@testable import Winter

/// Usage and cost tracking, the app half (`docs/claude/usage.md`): the shaping both surfaces draw from, the island's
/// compact tab model, the Usage window's model, and offscreen renders (`WINTER_USAGE_RENDER_DIR`, passed as
/// `TEST_RUNNER_WINTER_USAGE_RENDER_DIR` to `xcodebuild test`).
@MainActor
final class UsageWindowTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func ms(_ s: Double) -> Double { (now.timeIntervalSince1970 + s) * 1000 }

    // MARK: words

    func testCostAndTokenWords() {
        XCTAssertEqual(UsagePresentation.cost(0), "$0")
        XCTAssertEqual(UsagePresentation.cost(0.004), "<$0.01")
        XCTAssertEqual(UsagePresentation.cost(3.4199), "$3.42")
        XCTAssertEqual(UsagePresentation.cost(1284.4), "$1,284")
        XCTAssertEqual(UsagePresentation.tokens(1_234), "1.2k")
        XCTAssertEqual(UsagePresentation.modelName("anthropic/claude-sonnet-4.5"), "claude-sonnet-4.5")
        XCTAssertEqual(UsagePresentation.modelName("gpt-6-sol"), "gpt-6-sol")
        XCTAssertEqual(UsagePresentation.basisMark("list"), "")
        XCTAssertEqual(UsagePresentation.basisMark("estimate"), "est.")
        XCTAssertEqual(UsagePresentation.basisMark("unknown"), "unpriced")
        let fromStats = UsageModelRow(source: .claudeCode, provider: "anthropic", model: "m", costBasis: "estimate", totals: UsageTotals(records: 3, syntheticRecords: 2))
        XCTAssertEqual(UsagePresentation.basisMark(fromStats), "est.*")
        XCTAssertEqual(UsagePresentation.basisMark(UsageModelRow(source: .claudeCode, provider: "anthropic", model: "m", costBasis: "estimate", totals: UsageTotals(records: 3))), "est.")
        // Noon UTC of 2026-10-01.
        XCTAssertEqual(UsagePresentation.statsHistoryLine(before: 1_790_856_000_000)?.hasPrefix("History before "), true)
        XCTAssertEqual(UsagePresentation.statsHistoryLine(before: 1_790_856_000_000)?.contains("2026"), true)
        XCTAssertEqual(UsagePresentation.statsHistoryLine(before: 1_790_856_000_000)?.hasSuffix("from Claude Code’s /stats"), true)
        XCTAssertNil(UsagePresentation.statsHistoryLine(before: nil))
    }

    // MARK: plans

    func testACodexSlotHasRingsInOrderWithItsSourceAndAge() {
        let reading = UsagePlanReading(provider: "codex", source: "codex-rollout", at: ms(-3 * 3600), windows: [
            UsagePlanWindow(id: "secondary", kind: "weekly", windowMinutes: 10_080, usedPercent: 34, resetsAt: ms(86_400)),
            UsagePlanWindow(id: "primary", kind: "five_hour", windowMinutes: 300, usedPercent: 2, resetsAt: ms(-10), stale: true, staleReason: "reset_passed"),
        ], planType: "plus")
        let slot = UsagePresentation.slot(provider: "codex", reading: reading, now: now)
        XCTAssertEqual(slot.title, "Codex")
        XCTAssertEqual(slot.rings.map(\.title), ["5-hour", "Weekly"])
        // The lines show what is USED (user 2026-10-18: back to used).
        for (ring, used) in zip(slot.rings, [0.02, 0.34]) {
            XCTAssertEqual(ring.fraction, used, accuracy: 1e-9)
            XCTAssertEqual(ring.used, used, accuracy: 1e-9)
        }
        XCTAssertNil(slot.rings[0].resets, "a passed reset says nothing")
        // The weekly window says WHEN it resets (its day and time), not a countdown.
        XCTAssertEqual(slot.rings[1].resets.map { $0.hasPrefix("resets ") && !$0.hasPrefix("resets in") }, true)
        XCTAssertEqual(slot.rings[1].resets, slot.rings[1].resetsShort.map { "resets \($0)" })
        XCTAssertTrue(slot.rings[0].stale)
        XCTAssertEqual(slot.sourceLine, "From Codex’s last session · 3 h ago · stale")
        XCTAssertEqual(slot.planType, "Plus")
        XCTAssertNil(slot.emptyLine)
    }

    func testAPlanLineThickensUnderThePointer() {
        XCTAssertGreaterThan(UsagePlanLine.thickness(compact: true, hovered: true), UsagePlanLine.thickness(compact: true, hovered: false))
        XCTAssertGreaterThan(UsagePlanLine.thickness(compact: false, hovered: true), UsagePlanLine.thickness(compact: false, hovered: false))
    }

    func testResetWordsCountDownAShortWindowAndDateALongOne() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let en = Locale(identifier: "en_US")
        // now = Fri 2027-01-15 08:00 UTC.
        let tomorrow = UsagePresentation.resetWords(now.addingTimeInterval(86_400), windowMinutes: 10_080, now: now, calendar: utc, locale: en)
        XCTAssertTrue(tomorrow.hasPrefix("Sat") && tomorrow.contains("8:00"), tomorrow)
        let farOff = UsagePresentation.resetWords(now.addingTimeInterval(10 * 86_400), windowMinutes: 43_200, now: now, calendar: utc, locale: en)
        XCTAssertEqual(farOff, "Jan 25")
        let fiveHour = UsagePresentation.resetWords(now.addingTimeInterval(7_200), windowMinutes: 300, now: now, calendar: utc, locale: en)
        XCTAssertEqual(fiveHour, islandRelativeFuture(now.addingTimeInterval(7_200), now: now))
    }

    func testTheClaudeCodeSlotNamesThePerModelWindowAndTheFallbacksAreWorded() {
        let reading = UsagePlanReading(provider: "claude-code", source: "claude-cli", at: ms(-30), windows: [
            UsagePlanWindow(id: "weekly_scoped:opus:2", kind: "weekly_scoped", windowMinutes: 10_080, usedPercent: 80, scope: "opus"),
            UsagePlanWindow(id: "session:0", kind: "five_hour", windowMinutes: 300, usedPercent: 23),
            UsagePlanWindow(id: "weekly_all:1", kind: "weekly", windowMinutes: 10_080, usedPercent: 61),
        ])
        let slot = UsagePresentation.slot(provider: "claude-code", reading: reading, now: now)
        XCTAssertEqual(slot.rings.map(\.title), ["5-hour", "Weekly", "Opus"])
        XCTAssertEqual(UsagePresentation.scopeName("claude-fable-5-1"), "Fable")
        XCTAssertEqual(UsagePresentation.scopeName("fable"), "Fable")
        XCTAssertEqual(UsagePresentation.scopeName("custom"), "Custom")
        XCTAssertEqual(slot.sourceLine, "From Claude Code · just now")

        let status = UsagePlanReading(provider: "codex", source: "winter-codex-oauth", at: ms(-60),
                                      statusOnly: [UsagePlanStatusWindow(rateLimitType: "five_hour", status: "allowed", resetsAt: ms(7200), at: ms(-60))])
        let s = UsagePresentation.slot(provider: "codex", reading: status, now: now)
        XCTAssertTrue(s.rings.isEmpty)
        XCTAssertEqual(s.emptyLine, "Status only: within limits · resets in 2 h")
        XCTAssertTrue(s.sourceLine.hasPrefix("From Winter’s ChatGPT sign-in"), "the fallback is labelled as Winter's own, never as Codex's")
        XCTAssertEqual(UsagePresentation.slot(provider: "claude-code", reading: .init(provider: "claude-code", source: "disabled"), now: now).emptyLine,
                       "Tracking is off")
        XCTAssertEqual(UsagePresentation.slot(provider: "codex", reading: .init(provider: "codex", source: "none"), now: now).emptyLine,
                       "Codex not found on this Mac")
        XCTAssertEqual(UsagePresentation.slot(provider: "codex", reading: nil, now: now).emptyLine, "Reading…")
    }

    func testARingsLabelFitsItAndAGaugeIdNamesItsProvider() {
        XCTAssertEqual(IslandRing.label(1, size: 32), "100", "no percent sign in a compact ring")
        XCTAssertEqual(IslandRing.label(0.384, size: 52), "38%")
        let a = IslandUsageWindow(rateLimitType: "five_hour", status: "allowed", at: 0, sessionId: "s", provider: "codex-oauth")
        let b = IslandUsageWindow(rateLimitType: "five_hour", status: "allowed", at: 0, sessionId: "t", provider: "anthropic")
        XCTAssertNotEqual(IslandUsagePresentation.windowId(a), IslandUsagePresentation.windowId(b))
        let gauges = IslandUsagePresentation.gauges(IslandUsageSnapshot(windows: [a, b], background: .init(limited: false, inputTokens: 0, outputTokens: 0)), now: now)
        XCTAssertEqual(Set(gauges.map(\.id)).count, 2, "two providers' five-hour windows are two gauges")
    }

    // MARK: chart shaping

    func testChartPointsStackTheTopModelsAndFoldTheRestIntoOther() {
        let b = { (start: Double, models: [(UsageSource, String, Double)]) in
            UsageBucket(start: start, costUsd: models.reduce(0) { $0 + $1.2 }, tokens: 0,
                        models: models.map { .init(source: $0.0, model: $0.1, costUsd: $0.2, tokens: $0.2 * 1000) })
        }
        let series = UsageSeries(range: "24h", buckets: [
            b(0, [(.codex, "gpt-6-sol", 5), (.claudeCode, "claude-opus-5-5", 1), (.winter, "anthropic/x", 0.5)]),
            b(3_600_000, [(.claudeCode, "claude-opus-5-5", 2), (.winter, "anthropic/y", 0.25)]),
        ])
        let shaped = UsagePresentation.chartPoints(series, metric: .cost, top: 2)
        XCTAssertEqual(shaped.order, ["gpt-6-sol · Codex", "claude-opus-5-5 · Claude Code", "Other"])
        XCTAssertEqual(shaped.points.count, 6, "every series has a point in every bucket")
        XCTAssertEqual(shaped.points.filter { $0.series == "Other" }.map(\.value), [0.5, 0.25])
        XCTAssertEqual(shaped.points.filter { $0.series == "gpt-6-sol · Codex" }.map(\.value), [5, 0])
        XCTAssertEqual(UsagePresentation.seriesColors(shaped.order).count, 3)
        let tokens = UsagePresentation.chartPoints(series, metric: .tokens, top: 5)
        XCTAssertEqual(tokens.order.count, 4)
        XCTAssertFalse(tokens.order.contains("Other"))
        XCTAssertTrue(UsagePresentation.chartPoints(UsageSeries(range: "1h"), metric: .cost).order.isEmpty)
        XCTAssertEqual(shaped.points.map(\.slotKey).prefix(3), ["0000", "0000", "0000"], "one categorical slot per bucket")
        let day = UsageSeries(range: "30d", bucketMs: 86_400_000, buckets: (0..<30).map { UsageBucket(start: ms(Double($0) * 86_400), costUsd: 0, tokens: 0) })
        let labels = UsagePresentation.axisLabels(day)
        XCTAssertEqual(labels.map(\.key), ["0000", "0005", "0010", "0015", "0020", "0025"])
        XCTAssertTrue(UsagePresentation.axisLabels(UsageSeries(range: "1h")).isEmpty)
    }

    func testSparkPointsSpanTheWidthAndRestTheLowestOnTheBase() {
        let pts = UsagePresentation.sparkPoints([0, 2, 1], in: CGSize(width: 100, height: 20))
        XCTAssertEqual(pts, [CGPoint(x: 0, y: 20), CGPoint(x: 50, y: 0), CGPoint(x: 100, y: 10)])
        XCTAssertEqual(UsagePresentation.sparkPoints([0, 0], in: CGSize(width: 10, height: 5)).map(\.y), [5, 5])
        XCTAssertEqual(UsagePresentation.sparkPoints([], in: CGSize(width: 10, height: 5)), [])
    }

    // MARK: subscriptions

    func testSubscriptionLines() {
        let monthly = UsageSubscription(id: "a", name: "ChatGPT Pro", provider: "openai", price: 200, currency: "USD", cadence: "monthly",
                                        renewalDay: 3, covers: ["codex"], nextRenewal: ms(5 * 86400 + 60), monthlyCost: 200, usageThisCycleUsd: 412.5)
        XCTAssertEqual(UsagePresentation.priceLine(monthly), "$200/mo")
        XCTAssertEqual(UsagePresentation.valueLine(monthly), "Used $412.50 at list price this cycle · 2.1× the plan")
        XCTAssertTrue(UsagePresentation.renewalLine(monthly, now: now).hasPrefix("Renews in 5 d · "))
        let yearly = UsageSubscription(id: "b", name: "Claude Max", provider: "anthropic", price: 1200, currency: "EUR", cadence: "yearly",
                                       renewalDay: 1, renewalMonth: 3, covers: ["claude-code"], monthlyCost: 100, usageThisCycleUsd: 50)
        XCTAssertEqual(UsagePresentation.priceLine(yearly), "€1200/yr (€100/mo)")
        XCTAssertEqual(UsagePresentation.valueLine(yearly), "Used $50.00 at list price this cycle", "no ratio across currencies")
        var none = monthly
        none.covers = []
        XCTAssertEqual(UsagePresentation.valueLine(none), "Counts no usage — choose what it covers")
        XCTAssertEqual(UsagePresentation.defaultCovers(provider: "openai"), ["codex", "winter:codex-oauth"])
        XCTAssertEqual(UsagePresentation.defaultCovers(provider: "anthropic"), ["claude-code"])
    }

    // MARK: models

    func testTheIslandModelFetchesTheSummaryAndARangeChangeAsksAgain() async {
        let model = IslandUsageModel()
        var asked: [UsageRange] = []
        model.fetch = { _ in IslandUsageSnapshot(windows: [], background: .init(limited: false, inputTokens: 0, outputTokens: 0)) }
        model.fetchSummary = { r in asked.append(r); return UsageSummary(range: r.rawValue, totals: UsageTotals(costUsd: r == .day ? 1 : 2)) }
        await model.refresh()
        XCTAssertEqual(model.summary?.totals.costUsd, 1)
        model.range = .week
        for _ in 0..<50 where model.summary?.range != "7d" { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(model.summary?.totals.costUsd, 2)
        XCTAssertEqual(asked, [.day, .week])
        var opened = false
        model.openUsage = { opened = true }
        model.openUsage()
        XCTAssertTrue(opened)
    }

    func testTheWindowModelTogglesSourcesButNeverToNoneAndKeepsTheNewestChoice() async {
        let model = UsageWindowModel()
        var seen: [Set<UsageSource>] = []
        model.fetchSeries = { r, s in seen.append(s); return UsageSeries(range: r.rawValue, totals: UsageTotals(costUsd: Double(s.count))) }
        model.fetchSummary = { r, _ in UsageSummary(range: r.rawValue) }
        model.fetchSubscriptions = { [UsageSubscription(id: "x", name: "P", provider: "openai", price: 1)] }
        await model.refresh()
        XCTAssertEqual(model.series?.totals.costUsd, 3)
        XCTAssertEqual(model.subscriptions.map(\.id), ["x"])
        model.toggle(.codex)
        model.toggle(.claudeCode)
        model.toggle(.winter) // the last one stays
        XCTAssertEqual(model.sources, [.winter])
        await model.refresh()
        XCTAssertEqual(model.series?.totals.costUsd, 1)
        XCTAssertEqual(seen.last, [.winter])
    }

    func testTheWindowModelSavesAndRemovesPlansAndSaysWhenItCannot() async {
        let model = UsageWindowModel()
        model.saveSubscription = { s in [UsageSubscription(id: "new", name: s.name, provider: s.provider, price: s.price)] }
        model.deleteSubscription = { _ in [] }
        let ok = await model.save(UsageSubscription(name: "ChatGPT Pro", provider: "openai", price: 200))
        XCTAssertTrue(ok)
        XCTAssertEqual(model.subscriptions.map(\.name), ["ChatGPT Pro"])
        await model.remove(id: "new")
        XCTAssertTrue(model.subscriptions.isEmpty)
        struct Boom: Error {}
        model.saveSubscription = { _ in throw Boom() }
        let failed = await model.save(UsageSubscription(name: "x", provider: "openai", price: 1))
        XCTAssertFalse(failed)
        XCTAssertEqual(model.subscriptionError, "Couldn’t save the plan.")
    }

    // MARK: renders

    func testTheUsageSurfacesRenderOffscreen() throws {
        let named = ProcessInfo.processInfo.environment["WINTER_USAGE_RENDER_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let dir = named.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("winter-usage-renders-\(UUID().uuidString)")
        if named == nil { addTeardownBlock { try? FileManager.default.removeItem(at: dir) } }
        let urls = [try UsageGallery.renderWindow(to: dir), try UsageGallery.renderEmptyWindow(to: dir), try UsageGallery.renderCompact(to: dir)]
        for url in urls {
            let image = try XCTUnwrap(NSImage(contentsOf: url))
            XCTAssertGreaterThan(image.size.width, 100, url.lastPathComponent)
        }
    }
}
