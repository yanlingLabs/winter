import XCTest
import WinterCUPresentation
@testable import Winter

/// The plan lines' hover language as shared primitives (`Sources/Usage/HoverLine.swift`, `IslandQuietRow`): its measures
/// are the plan lines' own, a row lifts within its band, and the cost split says each of its words only where it fits.
@MainActor
final class HoverLineTests: XCTestCase {
    func testTheMeasuresAreThePlanLinesOwn() {
        XCTAssertEqual(HoverLift.thickness(hovered: false), UsagePlanLine.thickness(compact: true, hovered: false))
        XCTAssertEqual(HoverLift.thickness(hovered: true), UsagePlanLine.thickness(compact: true, hovered: true))
        XCTAssertEqual(HoverLift.lengthGrowth(hovered: true), UsagePlanLine.lengthGrowth(hovered: true))
        XCTAssertEqual(HoverLift.lengthGrowth(hovered: false), 0)
        XCTAssertEqual(HoverLift.lengthGrowth(hovered: true), 2 * HoverGrowth.points, accuracy: 0.001)
        XCTAssertEqual(HoverLift.labelScale(hovered: true), UsagePlanLine.titleScale(hovered: true))
        XCTAssertEqual(HoverLift.labelScale(hovered: false), 1)
        XCTAssertEqual(HoverLift.wordsWidth(nil), 0)
        XCTAssertEqual(HoverLift.wordsWidth(""), 0)
        XCTAssertEqual(HoverLift.wordsWidth("ab"), 2 * 5.4 + 12, accuracy: 0.001)
    }

    func testARowLiftsItsTitleWithinItsBandAndEveryTabsTitlesStartAtOneX() {
        // The 12 pt title grown 12 % fits its band; a lifted row takes the grown title's room (the row grows on the
        // spring and what is below glides), a row at rest takes none.
        XCTAssertLessThanOrEqual(Typography.labelSize * HoverLift.labelScale(hovered: true) * 1.25, IslandQuietRow.titleHeight)
        XCTAssertEqual(IslandQuietRow.liftPadding(hovered: false), 0)
        XCTAssertGreaterThan(IslandQuietRow.liftPadding(hovered: true), 0)
        XCTAssertEqual(IslandQuietRow.titleTrailing(hovered: false), 0)
        // The usage block's left edge, the header's; every tab's words after one mark column.
        XCTAssertEqual(IslandQuietRow.inset, IslandLayout.headerInset)
        XCTAssertEqual(IslandQuietRow.textLeading, IslandQuietRow.markWidth + IslandQuietRow.markGap)
        XCTAssertEqual(IslandQuietRow.titleOpacity(hovered: true), 1)
        XCTAssertLessThan(IslandQuietRow.titleOpacity(hovered: false, quiet: true), IslandQuietRow.titleOpacity(hovered: false))
    }

    func testRowActionsShowUnderThePointerOrWhileBusy() {
        XCTAssertFalse(IslandQuietRow.showsActions(hovered: false, busy: false))
        XCTAssertTrue(IslandQuietRow.showsActions(hovered: true, busy: false))
        XCTAssertTrue(IslandQuietRow.showsActions(hovered: false, busy: true), "a confirm in flight never hides")
    }

    func testSegmentsTakeTheirShareOfTheTrackLessTheGapsAndSayOnlyWhatFitsWhole() {
        let widths = HoverSegmentLayout.widths([0.5, 0.25, 0.25], width: 304)
        XCTAssertEqual(widths.count, 3)
        // 304 less two 2 pt gaps = 300.
        XCTAssertEqual(widths[0], 150, accuracy: 0.001)
        XCTAssertEqual(widths[1], 75, accuracy: 0.001)
        XCTAssertEqual(widths.reduce(0, +) + 2 * HoverSegmentLayout.gap, 304, accuracy: 0.001)
        // A share of the whole: segments that sum under 1 leave the rest of the track grey.
        XCTAssertEqual(HoverSegmentLayout.widths([0.5], width: 200), [100])
        XCTAssertEqual(HoverSegmentLayout.widths([], width: 200), [])
        XCTAssertEqual(HoverSegmentLayout.widths([0, 0], width: 200), [0, 0])
        XCTAssertEqual(HoverSegmentLayout.widths([-1, 1], width: 102), [0, 100], "a negative share is none")
        // The figure when it fits whole; the name beside it only when both do; never cut.
        let figure = HoverLift.wordsWidth("$3.42"), name = HoverLift.wordsWidth("gpt-5")
        XCTAssertTrue(HoverSegmentLayout.words(name: nil, figure: "$3.42", width: figure) == (false, true))
        XCTAssertTrue(HoverSegmentLayout.words(name: nil, figure: "$3.42", width: figure - 1) == (false, false))
        XCTAssertTrue(HoverSegmentLayout.words(name: "gpt-5", figure: "$3.42", width: name + figure - 6) == (true, true))
        XCTAssertTrue(HoverSegmentLayout.words(name: "gpt-5", figure: "$3.42", width: name + figure - 7) == (false, true))
        XCTAssertTrue(HoverSegmentLayout.words(name: "gpt-5", figure: "", width: 200) == (false, false), "no figure: nothing")
    }
}
