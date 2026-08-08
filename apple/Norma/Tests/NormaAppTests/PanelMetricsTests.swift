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
}
