import XCTest
@testable import Norma

final class PanelMetricsTests: XCTestCase {
    /// Measured from docs/research/reference/chatgpt-panel-2026-08-08.png at @2x.
    /// The structural finding: tab row and URL row share ONE band with no divider between them.
    func testChromeBandMatchesTheMeasuredReference() {
        XCTAssertEqual(panelChromeBandHeight, 85)
    }

    /// Mirrors the detail card's radius — same shape language, opposite corners.
    func testPanelRadiusMatchesTheDetailCard() {
        XCTAssertEqual(panelCornerRadius, shellDetailCardCornerRadius)
    }

    func testDividerIsAHairline() {
        XCTAssertEqual(panelDividerWidth, shellSidebarHairlineWidth)
    }

    /// panel-shell T8: measured from docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png.
    ///
    /// panel-shell T10: `panelTabPillSize.width` is a MAXIMUM now, not a fixed rendered width —
    /// `testTabPillWidthCompressesForATwoTabRowAtDefaultWidth` below proves the cap actually gets
    /// exercised. The 156pt figure itself is unchanged: it is still what ONE tab occupies in the
    /// reference, which is exactly why it stays the cap rather than being replaced.
    ///
    /// panel-shell T13: `panelTabPillRadius` moved OUT of this list — it is no longer measured, it
    /// is DERIVED from `shellSidebarRowCornerRadius` (`testTabPillRadiusMatchesTheSharedRowRadius`
    /// above owns that pin now), and asserting a derivation against its own definition here would
    /// be this branch's "compared a count against itself" shape. `panelTabSpacing` is pinned below
    /// INSTEAD, with the caveat its own doc comment carries: 6pt is a controller choice, not a
    /// measurement — the reference shows exactly one tab, so there is no tab-to-tab gap in it.
    func testTabPillMatchesTheMeasuredReference() {
        XCTAssertEqual(panelTabPillSize, CGSize(width: 156, height: 28))
        XCTAssertEqual(panelTabPillInset, 9)
        XCTAssertEqual(panelNewTabButtonGap, 18)
        XCTAssertEqual(panelTabPillMinWidth, 64)
        XCTAssertEqual(panelTabSpacing, 6, "controller's choice, not measured — see its own doc comment")
    }

    /// panel-shell T13 RED confirmed pre-implementation (14 != 6, the capsule vs. the shared row
    /// radius). The tab's fill/hit-target radius must match the app's ONE hover/selection
    /// vocabulary (`shellSidebarRowCornerRadius` — every sidebar row, every titlebar button)
    /// instead of living as its own capsule. Derived, so a future edit to one can never silently
    /// leave the pill's highlight and the rest of the app's rounded-rects disagreeing. (An
    /// `XCTAssertEqual` cannot itself distinguish a real derivation from a coincidentally-equal
    /// second literal — that half is a source read, not a test: `panelTabPillRadius`'s
    /// declaration is `= shellSidebarRowCornerRadius`, not `= 6`.)
    func testTabPillRadiusMatchesTheSharedRowRadius() {
        XCTAssertEqual(panelTabPillRadius, shellSidebarRowCornerRadius)
    }

    /// panel-shell T10: Task 8's own honest 102pt trailing-cluster reservation (borrowed from the
    /// MAIN titlebar's 26pt buttons, the best guess available before this task built the real
    /// ones) turned out to be the wrong number once real 28pt buttons (`panelExpandButtonSize`)
    /// landed — this pins the ACTUAL derivation so the tab-compression formula below and the
    /// cluster's own `.frame` (`ShellPanel.swift`) can never silently measure two different
    /// numbers for the same three buttons.
    func testTrailingClusterWidthIsDerivedFromItsOwnThreeButtons() {
        XCTAssertEqual(panelTrailingClusterWidth,
                       3 * panelExpandButtonSize + 2 * shellTitlebarClusterSpacing + panelExpandButtonInset)
    }

    /// The whole point of Step 3b: two tabs at the default 480pt width must not need the floor or
    /// the scroll fallback. Both bounds are STRICT — `<=`/`>=` alone would also pass a stub that
    /// ignores `availableWidth` and always returns the cap, which is exactly the bug this test
    /// exists to catch (mutation-verified by hand: a fixed-`panelTabPillSize.width` stub fails the
    /// first assertion; restored, both pass).
    ///
    /// panel-shell T13 re-verified under the split-gap arithmetic (still mutation-verified by hand,
    /// same stub, same failure on the first assertion — 156 is not less than 156). What T13 does
    /// NOT re-verify is covered by `testTabPillWidthAtTwoTabsUsesTheSplitGapArithmetic` below: this
    /// inequality alone cannot tell 140.5 (pre-T13) from 146.5 (post-T13) apart, so it is silent on
    /// whether `panelTabSpacing` is actually wired in — margin shrank from 15.5pt to 9.5pt below
    /// the cap, still a real gap either way.
    /// 2026-08-09 live gate: `panelDefaultWidth` went 480 -> 600 (user: the panel should start
    /// wider). This test and the arithmetic one below were both pinned to `panelDefaultWidth`, and
    /// both went red — correctly: at 600pt two tabs no longer NEED to compress (share 206.5, capped
    /// to 156), so "the default width forces compression" simply stopped being a true statement.
    ///
    /// Neither test was ever ABOUT the default, though — one proves compression happens at all, the
    /// other proves `panelTabSpacing` is wired into the overhead. So both now take an explicit
    /// `compressingWidth` chosen to sit strictly inside the (floor, cap) window, and the new
    /// `…AtTheDefaultWidth` test below covers what the default actually does now. Retargeting the
    /// vehicle, not weakening the assertion: both bounds here are still STRICT, so a stub that
    /// ignores `availableWidth` and returns the cap still fails the first one.
    ///
    /// 480 is deliberately the old default — the arithmetic it exercises is unchanged, so the
    /// hand-derived 146.5 below stays valid and stays checkable against this file's own history.
    static let compressingWidth: CGFloat = 480

    func testTabPillWidthCompressesForATwoTabRowWhenWidthIsTight() {
        let width = panelTabPillWidth(tabCount: 2, availableWidth: Self.compressingWidth)
        XCTAssertLessThan(width, panelTabPillSize.width,
                          "two tabs at a tight width must actually compress, not sit at the cap")
        XCTAssertGreaterThan(width, panelTabPillMinWidth,
                             "and still fit without hitting the floor (which is where scrolling starts)")
    }

    /// What the NEW default buys, and the reason the user asked for it: at 600pt a two-tab row has
    /// room to spare, so both pills render at full measured width instead of compressed.
    /// `panelDefaultWidth` appears here deliberately — this is the one test that SHOULD track it,
    /// so a future width change surfaces here rather than in the arithmetic pins.
    func testTwoTabsDoNotNeedToCompressAtTheDefaultWidth() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 2, availableWidth: panelDefaultWidth),
                       panelTabPillSize.width,
                       "the widened default should leave a two-tab row uncompressed")
    }

    /// panel-shell T13 RED confirmed pre-implementation (today's arithmetic returns 140.5, this
    /// asserts 146.5).
    ///
    /// The inequality test above CANNOT see the split-gap change: both the pre-T13 share (140.5)
    /// and the post-T13 share (146.5) sit strictly inside the (64, 156) window it checks, so it
    /// stays green whichever overhead arithmetic is live — confirmed by hand: reverting
    /// `panelTabPillWidth`'s overhead to the old `(tabCount + 1) * panelNewTabButtonGap` leaves
    /// EVERY other test in this file green, including that one; only this test catches it (140.5
    /// != 146.5). Restored, all pass. The expected value is a LITERAL, not a recomputed expression
    /// of the same constants — asserting a formula against its own definition is this branch's
    /// "compared a count against itself" defect, and would pass no matter what the formula said.
    ///
    /// Derivation (hand-computed, not code): overhead = panelTabPillInset(9)
    /// + (tabCount-1)*panelTabSpacing = 1*6 + 2*panelNewTabButtonGap(18, pill->"+" AND the
    /// ScrollView-frame->trailing-cluster gap, both unchanged by T13) + panelTabPillSize.height(28,
    /// the "+" button) + panelTrailingClusterWidth(108) = 9+6+36+28+108 = 187.
    /// share = (compressingWidth(480) - 187) / 2 = 146.5.
    ///
    /// 2026-08-09: the input was `panelDefaultWidth` until it moved 480 -> 600, at which point the
    /// share caps and this pin can no longer see the overhead arithmetic at all. Now takes the
    /// explicit `compressingWidth` (still 480), so the hand-derivation above and the mutation
    /// evidence in this comment remain exactly as verified.
    func testTabPillWidthAtTwoTabsUsesTheSplitGapArithmetic() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 2, availableWidth: Self.compressingWidth), 146.5)
    }

    /// The other end of the same function: enough tabs that even the floor doesn't fit. The pill
    /// width must clamp there rather than go negative or keep shrinking — `PanelTabStrip`'s own
    /// `ScrollView` is what absorbs the rest (not unit-testable here; this pins the pure half).
    ///
    /// panel-shell T13 re-verified under the split-gap arithmetic (mutation-verified by hand:
    /// dropping the `max(panelTabPillMinWidth, …)` floor returns the raw share — 0.1 here, since 50
    /// tabs' tighter `panelTabSpacing` gaps leave 5pt of nominal room over 50 tabs — instead of 64;
    /// restored, both pass). Still deep in floor territory either way: 0.1 and 64 are worlds apart.
    func testTabPillWidthNeverGoesBelowTheFloorNoMatterHowManyTabs() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 50, availableWidth: panelDefaultWidth),
                       panelTabPillMinWidth)
    }

    /// review round 1, Important 1: the OTHER bound Step 3b actually asks for — "panelTabPillSize
    /// .width is a MAXIMUM" — had zero coverage. `testTabPillWidthCompressesForATwoTabRowAt
    /// DefaultWidth` above proves compression engages under crowding; this proves the cap still
    /// holds with room to spare, which `min(panelTabPillSize.width, …)` inside `panelTabPillWidth`
    /// is the only thing enforcing. Deleting that `min(...)` left the WHOLE suite green before this
    /// test existed (mutation-verified by hand: one tab in a huge available width returns the raw,
    /// uncapped `share` — 1819 here — instead of 156 without it; restored, both pass).
    ///
    /// panel-shell T13 re-verified under the split-gap arithmetic (still mutation-verified by hand,
    /// same 1819 — `tabCount == 1` has zero tab-to-tab gaps, so the split changes nothing here,
    /// which is also why this number needed no edit for T13).
    func testTabPillWidthCapsAtTheMeasuredSizeWhenThereIsRoomToSpare() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 1, availableWidth: 2000), panelTabPillSize.width)
    }

    /// Zero tabs is reachable (a fresh panel before `panel.list` resolves) and must not divide by
    /// zero — the strip has nothing to lay out, so the cap is as good an answer as any. Renamed
    /// (review round 1, Minor 10) from `testTabPillWidthIsTotalOnZeroTabs`, which named the
    /// input-domain property ("total", the codebase's usual word for "doesn't crash on this edge
    /// case") rather than the actual asserted VALUE.
    func testTabPillWidthReturnsTheCapOnZeroTabsRatherThanDividingByZero() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 0, availableWidth: panelDefaultWidth),
                       panelTabPillSize.width)
    }

    /// The shared titlebar band, measured from the reference. The tab strip lives HERE, at the
    /// window top — not below the titlebar.
    func testChromeBandDecomposesIntoTitlebarAndUrlRow() {
        XCTAssertEqual(panelTitlebarBandHeight, 45)
        XCTAssertEqual(panelUrlRowHeight, panelChromeBandHeight - panelTitlebarBandHeight)  // 40
        // The pill is NOT centred — it sits 9pt below the band's top, leaving 8pt beneath.
        // Assert that asymmetry directly; an earlier version of this test hid it behind a
        // `+ 1` fudge, which made the numbers agree while describing a layout that is not built.
        XCTAssertEqual(panelTabPillInset + panelTabPillSize.height, 37)
        XCTAssertEqual(panelTitlebarBandHeight - (panelTabPillInset + panelTabPillSize.height), 8)
    }
}
