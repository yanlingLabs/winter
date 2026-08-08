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
    func testTabPillMatchesTheMeasuredReference() {
        XCTAssertEqual(panelTabPillSize, CGSize(width: 156, height: 28))
        XCTAssertEqual(panelTabPillInset, 9)
        XCTAssertEqual(panelTabPillRadius, panelTabPillSize.height / 2)  // capsule
        XCTAssertEqual(panelNewTabButtonGap, 18)
        XCTAssertEqual(panelTabPillMinWidth, 64)
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
    func testTabPillWidthCompressesForATwoTabRowAtDefaultWidth() {
        let width = panelTabPillWidth(tabCount: 2, availableWidth: panelDefaultWidth)
        XCTAssertLessThan(width, panelTabPillSize.width,
                          "two tabs at the default width must actually compress, not sit at the cap")
        XCTAssertGreaterThan(width, panelTabPillMinWidth,
                             "and still fit without hitting the floor (which is where scrolling starts)")
    }

    /// The other end of the same function: enough tabs that even the floor doesn't fit. The pill
    /// width must clamp there rather than go negative or keep shrinking — `PanelTabStrip`'s own
    /// `ScrollView` is what absorbs the rest (not unit-testable here; this pins the pure half).
    func testTabPillWidthNeverGoesBelowTheFloorNoMatterHowManyTabs() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 50, availableWidth: panelDefaultWidth),
                       panelTabPillMinWidth)
    }

    /// Zero tabs is reachable (a fresh panel before `panel.list` resolves) and must not divide by
    /// zero — the strip has nothing to lay out, so the cap is as good an answer as any.
    func testTabPillWidthIsTotalOnZeroTabs() {
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
