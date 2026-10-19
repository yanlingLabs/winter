import XCTest
import WinterCUPresentation
@testable import Winter

/// The plan lines' hover language as shared primitives (`Sources/Usage/HoverLine.swift`): its measures are the plan
/// lines' own, and a hovered line shows each of its words only where they fit whole.
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

    func testTheGluedWordsRideTheFillsEndAndTheEndWordsNeedTheGreyLeftOver() {
        let words = HoverLineWords(start: nil, atFill: "up 3 h", end: ":3000")
        let glued = HoverLift.wordsWidth("up 3 h")
        // A half fill on a 300 pt track: the glued words inside it, at its end; the end words in the grey after it.
        var l = HoverLineLayout.of(width: 300, fraction: 0.5, words: words)
        XCTAssertEqual(l.fill, 150)
        XCTAssertEqual(l.fillSlot, 150)
        XCTAssertTrue(l.atFill)
        XCTAssertTrue(l.atFillInside)
        XCTAssertTrue(l.end)
        // A sliver of fill: the glued words do not fit inside it, so they follow it in the grey — never straddling it.
        l = HoverLineLayout.of(width: 300, fraction: 0.01, words: words, minFill: 14)
        XCTAssertEqual(l.fill, 14, "a started line is at least a dot")
        XCTAssertTrue(l.atFill)
        XCTAssertFalse(l.atFillInside)
        XCTAssertEqual(l.fillSlot, 14 + glued, accuracy: 0.001)
        XCTAssertTrue(l.end)
        // A track too short for the words after the fill: they are dropped.
        XCTAssertFalse(HoverLineLayout.of(width: glued + 10, fraction: 0.5, words: words).atFill)
        // A full fill: no grey left over, the end words are dropped.
        l = HoverLineLayout.of(width: 300, fraction: 1, words: words)
        XCTAssertEqual(l.fillSlot, 300)
        XCTAssertFalse(l.end)
        // Nothing filled: no dot.
        XCTAssertEqual(HoverLineLayout.of(width: 300, fraction: 0, words: words, minFill: 14).fill, 0)
        // Start words sit in the fill before the glued ones, only when both fit there whole.
        let both = HoverLineWords(start: "Chrome — Inbox", atFill: "armed 4 min ago", end: nil)
        XCTAssertFalse(HoverLineLayout.of(width: 300, fraction: 0.2, words: both).start)
        XCTAssertTrue(HoverLineLayout.of(width: 300, fraction: 0.9, words: both).start)
    }

    func testWithoutGluedWordsTheStartComesFirstThenTheEndWhenBothFitWhole() {
        let words = HoverLineWords(start: "Working · claude-sonnet-4.5", end: "3 h ago · winter")
        let startW = HoverLift.wordsWidth(words.start), endW = HoverLift.wordsWidth(words.end)
        var l = HoverLineLayout.of(width: startW + endW + 1, fraction: 1, words: words)
        XCTAssertTrue(l.start)
        XCTAssertTrue(l.end)
        l = HoverLineLayout.of(width: startW + endW - 1, fraction: 1, words: words)
        XCTAssertTrue(l.start)
        XCTAssertFalse(l.end, "dropped, never cut")
        l = HoverLineLayout.of(width: startW - 1, fraction: 1, words: words)
        XCTAssertFalse(l.start)
        XCTAssertFalse(l.atFill)
        XCTAssertEqual(HoverLineLayout.of(width: 200, fraction: 0, words: HoverLineWords()),
                       HoverLineLayout(fill: 0, fillSlot: 0, start: false, atFill: false, atFillInside: false, end: false,
                                       startRegion: 200))
    }

    func testStartWordsOnAnEmptyLineHaveTheWholeTrackAndContentTruncatesInsteadOfVanishing() {
        // A line with no fill (a device that is off) still has the whole track for its words.
        let off = HoverLineLayout.of(width: 300, fraction: 0, words: HoverLineWords(start: "Not connected"))
        XCTAssertTrue(off.start)
        XCTAssertEqual(off.startRegion, 300)
        // Too long: dropped by default, cut at its tail when it is content (and the end words give up their room).
        let long = String(repeating: "Winter for Chrome is not connected ", count: 3)
        XCTAssertFalse(HoverLineLayout.of(width: 300, fraction: 1, words: HoverLineWords(start: long)).start)
        let cut = HoverLineLayout.of(width: 300, fraction: 1, words: HoverLineWords(start: long, end: "x", startTruncates: true))
        XCTAssertTrue(cut.start)
        XCTAssertFalse(cut.end)
        XCTAssertEqual(cut.startRegion, 300)
        // Beside end words that fit, the start's room stops where they begin.
        let both = HoverLineLayout.of(width: 300, fraction: 1, words: HoverLineWords(start: "Connected", end: "paired 9 d ago"))
        XCTAssertEqual(both.startRegion, 300 - HoverLift.wordsWidth("paired 9 d ago"), accuracy: 0.001)
    }

    func testSegmentsTakeTheirShareOfTheTrackLessTheGapsAndDropALabelThatDoesNotFit() {
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
        XCTAssertTrue(HoverSegmentLayout.showsLabel("$3.42", width: 60))
        XCTAssertFalse(HoverSegmentLayout.showsLabel("$3.42", width: 20))
        XCTAssertFalse(HoverSegmentLayout.showsLabel(nil, width: 200))
    }
}
