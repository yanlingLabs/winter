import XCTest
@testable import Norma

final class PanelModeTests: XCTestCase {
    func testMaxWidthAlwaysLeavesTheChatItsMinimum() {
        XCTAssertEqual(panelMaxWidth(contentWidth: 1200), 1200 - panelMinChatWidth)
    }

    func testClampHonoursBothBounds() {
        // below the panel's own minimum -> raised
        XCTAssertEqual(panelClampWidth(100, contentWidth: 1200), panelMinWidth)
        // above the max -> lowered, chat keeps 420
        XCTAssertEqual(panelClampWidth(1190, contentWidth: 1200), 1200 - panelMinChatWidth)
        // inside the range -> untouched
        XCTAssertEqual(panelClampWidth(600, contentWidth: 1200), 600)
    }

    func testDraggingNeverBecomesMaximized() {
        // the whole point: clamping stops short, it does not switch mode
        let clamped = panelClampWidth(99_999, contentWidth: 1200)
        XCTAssertLessThan(clamped, 1200)
    }

    func testNarrowWindowForcesHidden() {
        XCTAssertFalse(panelFitsInContent(panelMinContentWidth - 1))
        XCTAssertTrue(panelFitsInContent(panelMinContentWidth))
        XCTAssertEqual(panelResolvedMode(requested: .side, contentWidth: 700), .hidden)
        XCTAssertEqual(panelResolvedMode(requested: .maximized, contentWidth: 700), .hidden)
        XCTAssertEqual(panelResolvedMode(requested: .side, contentWidth: 1200), .side)
    }

    func testMinimumContentWidthIsTheSumOfBothMinimums() {
        XCTAssertEqual(panelMinContentWidth, panelMinWidth + panelMinChatWidth)
    }
}
