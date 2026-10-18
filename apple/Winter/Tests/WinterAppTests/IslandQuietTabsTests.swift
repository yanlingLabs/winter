import SwiftUI
import XCTest
import WinterKit
@testable import Winter

/// The island's tabs in their quiet language (`docs/claude/island.md`, "Island visual language"): what each row's
/// line measures, what it says inside itself only under the pointer, and the colours it may wear.
@MainActor
final class IslandQuietTabsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: The cost block

    private func modelRow(_ model: String, _ source: UsageSource, cost: Double, tokens: Double = 1_000, basis: String = "list") -> UsageModelRow {
        UsageModelRow(source: source, provider: "p", model: model, costBasis: basis,
                      totals: UsageTotals(costUsd: cost, input: tokens))
    }

    func testTheCostLineIsEachTopModelsShareLargestFirstWithTheRestAsOther() {
        let summary = UsageSummary(range: "day", totals: UsageTotals(costUsd: 10, input: 9_000),
                                   topModels: [modelRow("anthropic/claude-sonnet-4.5", .claudeCode, cost: 2),
                                               modelRow("gpt-5-codex", .codex, cost: 5),
                                               modelRow("anthropic/claude-opus-4.1", .claudeCode, cost: 1),
                                               modelRow("zero", .winter, cost: 0)])
        let segments = IslandCostPresentation.segments(summary)
        XCTAssertEqual(segments.map(\.name), ["gpt-5-codex", "claude-sonnet-4.5", "claude-opus-4.1", "Other"])
        XCTAssertEqual(segments.map(\.fraction), [0.5, 0.2, 0.1, 0.2])
        XCTAssertEqual(segments.map(\.label), ["$5.00", "$2.00", "$1.00", "$2.00"])
        XCTAssertEqual(segments.map(\.rank), [0, 0, 1, 0], "a source's second model is its colour, lighter")
        XCTAssertEqual(segments.reduce(0) { $0 + $1.fraction }, 1, accuracy: 0.0001)
        XCTAssertEqual(IslandCostPresentation.accessibilityLine(segments),
                       "Cost by model: gpt-5-codex $5.00, claude-sonnet-4.5 $2.00, claude-opus-4.1 $1.00, Other $2.00")
        XCTAssertEqual(IslandCostPresentation.accessibilityLine([]), "No usage in this range")
    }

    func testAtMostFourModelsGetASegmentAndNoSliverOfOtherIsDrawn() {
        let rows = (1...6).map { modelRow("m\($0)", .winter, cost: Double(7 - $0)) }
        let total = rows.reduce(0) { $0 + $1.totals.costUsd }
        let segments = IslandCostPresentation.segments(UsageSummary(range: "day", totals: UsageTotals(costUsd: total), topModels: rows))
        XCTAssertEqual(segments.count, IslandCostPresentation.segmentLimit + 1)
        XCTAssertEqual(segments.last?.name, "Other")
        let exact = IslandCostPresentation.segments(UsageSummary(range: "day", totals: UsageTotals(costUsd: 3.001),
                                                                 topModels: [modelRow("a", .codex, cost: 3)]))
        XCTAssertEqual(exact.map(\.name), ["a"], "a rounding rest is no segment")
        XCTAssertEqual(IslandCostPresentation.segments(nil), [])
        XCTAssertEqual(IslandCostPresentation.segments(UsageSummary(range: "day")), [])
    }

    func testTheLegendNamesTheTopThreeAndASourceOnlyWhenANameRepeats() {
        let summary = UsageSummary(range: "day", totals: UsageTotals(costUsd: 10),
                                   topModels: [modelRow("gpt-5", .codex, cost: 4), modelRow("gpt-5", .winter, cost: 3),
                                               modelRow("anthropic/claude-sonnet-4.5", .claudeCode, cost: 2),
                                               modelRow("m4", .winter, cost: 0.5)])
        let legend = IslandCostPresentation.legend(IslandCostPresentation.segments(summary))
        XCTAssertEqual(legend.map(\.name), ["gpt-5 · Codex", "gpt-5 · Winter", "claude-sonnet-4.5"])
    }

    func testAnUnpricedRangeIsSplitByTokens() {
        let summary = UsageSummary(range: "day", totals: UsageTotals(costUsd: 0, input: 4_000),
                                   topModels: [modelRow("a", .opencode, cost: 0, tokens: 3_000, basis: "unknown"),
                                               modelRow("b", .opencode, cost: 0, tokens: 1_000, basis: "unknown")])
        let segments = IslandCostPresentation.segments(summary)
        XCTAssertEqual(segments.map(\.fraction), [0.75, 0.25])
        XCTAssertEqual(segments.map(\.label), [UsagePresentation.tokens(3_000) + " tok", UsagePresentation.tokens(1_000) + " tok"])
    }

    func testTheCostLinesColoursAreTheSourcesOwn() {
        func seg(_ s: UsageSource?, rank: Int = 0) -> IslandCostSegment {
            IslandCostSegment(id: "x", name: "x", source: s, fraction: 1, label: "", rank: rank)
        }
        XCTAssertEqual(IslandCostPresentation.color(seg(.codex)), UsagePlanColor.codex.opacity(1))
        XCTAssertEqual(IslandCostPresentation.color(seg(.claudeCode, rank: 1)), UsagePlanColor.claudeCode.opacity(0.7))
        XCTAssertEqual(IslandCostPresentation.color(seg(.winter)), Theme.accent.opacity(1))
        XCTAssertEqual(IslandCostPresentation.color(seg(nil)), Color.white.opacity(0.22))
        XCTAssertEqual(IslandCostPresentation.rankOpacity(0), 1)
        XCTAssertEqual(IslandCostPresentation.rankOpacity(2), 0.5)
        XCTAssertEqual(IslandCostPresentation.rankOpacity(9), 0.4)
    }

    func testTheHoveredHeaderAddsTheTokensElseTheRangesName() {
        XCTAssertEqual(IslandCostPresentation.detail(UsageSummary(range: "day", totals: UsageTotals(input: 1_000, output: 200, cacheRead: 5_000)),
                                                     range: .day), "1.2k tokens · \(UsagePresentation.tokens(5_000)) cached")
        XCTAssertEqual(IslandCostPresentation.detail(nil, range: .week), "last 7 days")
    }

    func testTheCostBlocksLinesShareThePlanLinesTitleColumn() {
        // "Models" and "Trend" fit the compact floor: they never widen the plans' column.
        XCTAssertEqual(UsagePresentation.titleColumnWidth(["5-hour", "Weekly"] + IslandCostBlock.lineTitles, compact: true),
                       UsagePresentation.titleColumnWidth(["5-hour", "Weekly"], compact: true))
    }
}
