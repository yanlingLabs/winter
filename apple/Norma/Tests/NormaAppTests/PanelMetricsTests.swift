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
        // the pill is vertically centred in the titlebar band: 9 + 28 + 8 = 45
        XCTAssertEqual(panelTabPillInset + panelTabPillSize.height + panelTabPillInset,
                       panelTitlebarBandHeight + 1)
    }
}
