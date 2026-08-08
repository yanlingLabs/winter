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
    func testTabPillMatchesTheMeasuredReference() {
        XCTAssertEqual(panelTabPillSize, CGSize(width: 156, height: 28))
        XCTAssertEqual(panelTabPillInset, 9)
        XCTAssertEqual(panelTabPillRadius, panelTabPillSize.height / 2)  // capsule
        XCTAssertEqual(panelNewTabButtonGap, 18)
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
