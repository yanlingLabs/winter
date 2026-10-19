import SwiftUI
import XCTest
import WinterKit
@testable import Winter

/// The island's tabs in their quiet language (`docs/claude/island.md`, "Island visual language"): what each row's
/// line measures, what it says inside itself only under the pointer, and the colours it may wear.
@MainActor
final class IslandQuietTabsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: Servers

    func testAServersLineFillsOverItsFirstDayAndSaysItsUptimeAndPortsInside() {
        XCTAssertEqual(IslandServers.uptimeFraction(since: now, now: now), 0)
        XCTAssertEqual(IslandServers.uptimeFraction(since: now.addingTimeInterval(-6 * 3600), now: now), 0.25, accuracy: 0.0001)
        XCTAssertEqual(IslandServers.uptimeFraction(since: now.addingTimeInterval(-3 * 86400), now: now), 1, "full from a day on")
        XCTAssertEqual(IslandServers.uptimeFraction(since: now.addingTimeInterval(60), now: now), 0, "a clock skew is never negative")
        XCTAssertEqual(IslandServers.lineWords(status: "up 3 h", ports: ":3000 :3001"),
                       HoverLineWords(start: nil, atFill: "up 3 h", end: ":3000 :3001"))
        XCTAssertNil(IslandServers.lineWords(status: "up 3 h", ports: "").end)
    }

    func testAServersLineWearsStopsPhaseAndItsWordsReadOnAmber() {
        let t = now
        XCTAssertEqual(IslandServers.lineColor(nil), islandToneColor(.ok))
        XCTAssertEqual(IslandServers.lineColor(.confirming(at: t)), pillReviewAmber)
        XCTAssertEqual(IslandServers.lineColor(.stopping(sentAt: t)), Color.white.opacity(0.3))
        XCTAssertEqual(IslandServers.lineColor(.killing(sentAt: t)), Color.white.opacity(0.3))
        XCTAssertEqual(IslandServers.lineColor(.forceOffered), Color(nsColor: .systemRed))
        XCTAssertEqual(IslandServers.lineColor(.confirmingForce(at: t)), Color(nsColor: .systemRed))
        XCTAssertEqual(IslandServers.inkOnFill(.confirming(at: t)), .black)
        XCTAssertEqual(IslandServers.inkOnFill(nil), .white)
    }

    func testStopShowsUnderThePointerAndNeverHidesMidPhase() {
        let t = now
        for phase: IslandServerStopPhase in [.confirming(at: t), .stopping(sentAt: t), .forceOffered, .confirmingForce(at: t),
                                             .killing(sentAt: t)] {
            XCTAssertTrue(IslandQuietRow.showsActions(hovered: false, busy: true), "\(phase) stays on screen")
        }
        XCTAssertFalse(IslandQuietRow.showsActions(hovered: false, busy: false), "at rest: hidden")
    }

    func testABundleRowSaysItsCountAndFolderAtRestAndTheWholeFolderUnderThePointer() throws {
        let model = IslandGallery.sampleServers(now: now)
        let bundle = try XCTUnwrap(model.bundles.first { $0.isBundle })
        XCTAssertEqual(IslandServers.bundleWords(bundle, hovered: false), "2 servers · Discord Waifus · @waifucave/discord-waifus")
        XCTAssertEqual(IslandServers.bundleWords(bundle, hovered: true),
                       "2 servers · ~/Code/Discord Waifus · @waifucave/discord-waifus")
        let single = try XCTUnwrap(model.bundles.first { !$0.isBundle && $0.rows.first?.name == "http.server" })
        XCTAssertEqual(IslandServers.bundleWords(single, hovered: false), "portfolio")
    }

    func testVoiceOverHearsAServersPortsStateAndFolderAtRest() throws {
        let model = IslandGallery.sampleServers(now: now)
        let row = try XCTUnwrap(model.rows.first { $0.name == "http.server" })
        XCTAssertEqual(IslandServers.accessibilityLabel(row, phase: nil, now: now), "http.server, :8000 · up 25 min, ~/Sites/portfolio")
        XCTAssertEqual(IslandServers.accessibilityLabel(row, phase: .stopping(sentAt: now), now: now),
                       "http.server, :8000 · Stopping…, ~/Sites/portfolio")
        XCTAssertEqual(IslandServers.statusWords(row, phase: .forceOffered, now: now), "Still running")
    }

    func testVoiceOverStopsAServerWithTheSameTwoClicks() {
        let t = now
        XCTAssertEqual(IslandServers.stopActionName(nil, name: "waifus"), "Stop waifus")
        XCTAssertEqual(IslandServers.stopActionName(.confirming(at: t), name: "waifus"), "Click again to stop waifus")
        XCTAssertNil(IslandServers.stopActionName(.stopping(sentAt: t), name: "waifus"), "nothing to do while it stops")
        XCTAssertNil(IslandServers.stopActionName(.killing(sentAt: t), name: "waifus"))
        XCTAssertEqual(IslandServers.stopActionName(.forceOffered, name: "waifus"), "Force quit waifus")
        XCTAssertEqual(IslandServers.stopActionName(.confirmingForce(at: t), name: "waifus"), "Click again to force quit waifus")
    }

    func testTheGallerysForceQuitServerHasALinkBesideItsStop() throws {
        // The picture `island-tab-servers-forcequit` shows: a plain row with its link and Stop's widest capsule, set
        // through the seam (nothing clicked, nothing signalled).
        let model = IslandGallery.sampleServers(now: now, withLink: true)
        let bundle = try XCTUnwrap(model.bundles.first { !model.drills($0) })
        let row = try XCTUnwrap(bundle.rows.first)
        XCTAssertEqual(model.links(row).map(\.port), [8000])
        model.setStopsForTesting([row.id: .confirmingForce(at: now)])
        XCTAssertEqual(model.stops[row.id], .confirmingForce(at: now))
    }

    // MARK: Watches

    private func watch(armedAt: Int, expiresAt: Int, title: String? = "List the extension") -> IslandWatchItem {
        IslandWatchItem(sessionId: "s1", wakeId: "w", condition: "clicked", targetLabel: "Chrome — Inbox", elementLabel: "“Send”",
                        armedAt: armedAt, expiresAt: expiresAt, session: IslandSessionFacts(mode: "code", title: title))
    }

    func testAWatchsLineIsTheTimeLeftEmptyingAsItRunsOut() {
        let w = watch(armedAt: 0, expiresAt: 60 * 60_000)
        XCTAssertEqual(IslandWatchesPresentation.left(w, nowMs: 0), 1, "just armed: all of it left")
        XCTAssertEqual(IslandWatchesPresentation.left(w, nowMs: 15 * 60_000), 0.75, accuracy: 0.0001)
        XCTAssertEqual(IslandWatchesPresentation.left(w, nowMs: 2 * 60 * 60_000), 0, "expired: none left, never negative")
        XCTAssertEqual(IslandWatchesPresentation.left(w, nowMs: -60_000), 1, "a clock skew never overfills it")
        XCTAssertEqual(IslandWatchesPresentation.left(watch(armedAt: 5, expiresAt: 5), nowMs: 9), 0, "no span: none left")
        XCTAssertEqual(IslandWatchesPresentation.leftWords(w, nowMs: 4 * 60_000), "56 min left")
        XCTAssertEqual(IslandWatchesPresentation.armedWords(w, nowMs: 4 * 60_000), "armed 4 min ago")
        XCTAssertEqual(IslandWatchesPresentation.armedWords(w, nowMs: 30_000), "armed just now")
        // Between them, the same words as the time line the row has always said.
        XCTAssertEqual("\(IslandWatchesPresentation.armedWords(w, nowMs: 4 * 60_000)) · \(IslandWatchesPresentation.leftWords(w, nowMs: 4 * 60_000))",
                       islandWatchTimeLine(w, nowMs: 4 * 60_000))
        let long = watch(armedAt: 0, expiresAt: 3 * 60 * 60_000)
        XCTAssertEqual("\(IslandWatchesPresentation.armedWords(long, nowMs: 30_000)) · \(IslandWatchesPresentation.leftWords(long, nowMs: 30_000))",
                       islandWatchTimeLine(long, nowMs: 30_000))
    }

    func testThePointerRevealsAWatchsSessionTargetAndArmingAndVoiceOverHearsItAtRest() {
        let timed = watch(armedAt: 0, expiresAt: 60 * 60_000)
        XCTAssertEqual(IslandWatchesPresentation.details(timed, nowMs: 4 * 60_000), "List the extension · Chrome — Inbox · armed 4 min ago")
        XCTAssertEqual(IslandWatchesPresentation.accessibilityLabel(timed, nowMs: 4 * 60_000, error: nil),
                       "You click “Send”, List the extension · Chrome — Inbox, armed 4 min ago · 56 min left",
                       "VoiceOver hears the time line at rest")
        XCTAssertEqual(IslandWatchesPresentation.accessibilityLabel(timed, nowMs: 0, error: "Couldn't stop it"),
                       "You click “Send”, List the extension · Chrome — Inbox, Couldn't stop it")
    }

    // MARK: Devices

    func testADevicesStatusIsADotAndAWordAndTheHelpersPermissionsAreMarks() {
        // No line: nothing a phone or a helper reports is an amount.
        XCTAssertEqual(IslandDevicesPresentation.mark(.ok), .dot(Color(nsColor: .systemGreen)))
        XCTAssertEqual(IslandDevicesPresentation.mark(.warning), .dot(pillReviewAmber))
        XCTAssertEqual(IslandDevicesPresentation.mark(.off), .ring(Color.white.opacity(0.35)), "off: a hollow dot")
        let granted = IslandDevicesPresentation.chip("Accessibility", true)
        let denied = IslandDevicesPresentation.chip("Screen Recording", false)
        let unknown = IslandDevicesPresentation.chip("Accessibility", nil)
        XCTAssertEqual(IslandDevicesPresentation.permissionMark(granted).symbol, "checkmark")
        XCTAssertEqual(IslandDevicesPresentation.permissionMark(granted).color, Theme.textMuted, "granted is quiet")
        XCTAssertEqual(IslandDevicesPresentation.permissionMark(denied).symbol, "xmark")
        XCTAssertEqual(IslandDevicesPresentation.permissionMark(denied).color, pillReviewAmber, "missing needs you: amber")
        XCTAssertEqual(IslandDevicesPresentation.permissionMark(unknown).symbol, "questionmark")
        let row = IslandDeviceRow(id: "cu", symbol: "cursorarrow.rays", title: "Computer Use helper", status: "Running · 1.4.0",
                                  tone: .warning, chips: [granted, denied])
        XCTAssertEqual(IslandDevicesPresentation.accessibilityLabel(row),
                       "Computer Use helper, Running · 1.4.0, Accessibility: granted, Screen Recording: not granted",
                       "VoiceOver hears everything at rest")
        XCTAssertFalse(IslandDevicesPresentation.showsDetail(row, hovered: true), "no detail: no line under it")
        let chrome = IslandDeviceRow(id: "b", symbol: "puzzlepiece.extension", title: "Winter for Chrome · Chrome",
                                     status: "Not connected", detail: "Not installed in Chrome", tone: .off)
        XCTAssertFalse(IslandDevicesPresentation.showsDetail(chrome, hovered: false), "quiet at rest")
        XCTAssertTrue(IslandDevicesPresentation.showsDetail(chrome, hovered: true), "revealed under the pointer")
        XCTAssertEqual(IslandDevicesPresentation.accessibilityLabel(chrome), "Winter for Chrome · Chrome, Not connected, Not installed in Chrome")
    }

    // MARK: Shelf

    func testTheSelectedFileIsMarkedByALineUnlessItIsMissing() {
        XCTAssertTrue(IslandShelfTab.showsSelectionLine(selected: true, missing: false))
        XCTAssertFalse(IslandShelfTab.showsSelectionLine(selected: true, missing: true), "a missing file says Missing there")
        XCTAssertFalse(IslandShelfTab.showsSelectionLine(selected: false, missing: false))
    }

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

    func testTheLegendNamesTheTopThreeAndASourceOnlyWhenANameRepeats() throws {
        let summary = UsageSummary(range: "day", totals: UsageTotals(costUsd: 10),
                                   topModels: [modelRow("gpt-5", .codex, cost: 4), modelRow("gpt-5", .winter, cost: 3),
                                               modelRow("anthropic/claude-sonnet-4.5", .claudeCode, cost: 2),
                                               modelRow("m4", .winter, cost: 0.5)])
        let legend = IslandCostPresentation.legend(summary)
        XCTAssertEqual(legend.map(\.name), ["gpt-5 · Codex", "gpt-5 · Winter", "claude-sonnet-4.5"])
        XCTAssertEqual(legend.map(\.note), [nil, nil, nil])
        // Under the pointer a segment says which model it is when that fits — its source when its name is shared.
        let codex = try XCTUnwrap(IslandCostPresentation.segments(summary).first)
        XCTAssertEqual(codex.hoverLabels, ["gpt-5 · Codex $4.00", "$4.00"])
        XCTAssertEqual(HoverSegmentLayout.label(codex.hoverLabels, width: 200), "gpt-5 · Codex $4.00")
        XCTAssertEqual(HoverSegmentLayout.label(codex.hoverLabels, width: 50), "$4.00", "too narrow for the name: the figure")
        XCTAssertNil(HoverSegmentLayout.label(codex.hoverLabels, width: 10))
        let sonnet = try XCTUnwrap(IslandCostPresentation.segments(summary).first { $0.name == "claude-sonnet-4.5" })
        XCTAssertEqual(sonnet.hoverLabels, ["claude-sonnet-4.5 $2.00", "$2.00"], "a name no other model shares: no source")
    }

    func testAnUnpricedModelInAPricedRangeStaysInTheLegendWithItsTokens() throws {
        let summary = UsageSummary(range: "day", totals: UsageTotals(costUsd: 5, input: 9_000),
                                   topModels: [modelRow("gpt-5", .codex, cost: 5, tokens: 4_000),
                                               modelRow("local-model", .opencode, cost: 0, tokens: 5_000, basis: "unknown")])
        XCTAssertEqual(IslandCostPresentation.segments(summary).map(\.name), ["gpt-5"], "no cost: no share of the cost line")
        let legend = IslandCostPresentation.legend(summary)
        XCTAssertEqual(legend.map(\.name), ["gpt-5", "local-model"])
        XCTAssertEqual(legend.map(\.note), [nil, UsagePresentation.tokens(5_000) + " tok"], "it never vanishes")
        XCTAssertNil(legend[1].segmentId)
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
        XCTAssertEqual(IslandCostPresentation.headerAccessibility(UsageSummary(range: "day", totals: UsageTotals(costUsd: 3.5, input: 1_000, output: 200)),
                                                                  range: .day), "Cost $3.50, 1.2k tokens",
                       "VoiceOver hears the tokens at rest")
    }

    func testTheCostBlocksLinesShareThePlanLinesTitleColumn() {
        // "Models" and "Trend" fit the compact floor: they never widen the plans' column.
        XCTAssertEqual(UsagePresentation.titleColumnWidth(["5-hour", "Weekly"] + IslandCostBlock.lineTitles, compact: true),
                       UsagePresentation.titleColumnWidth(["5-hour", "Weekly"], compact: true))
    }
}
