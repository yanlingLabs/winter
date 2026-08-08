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

    /// Closes the finding carried from Task 1: `panelClampWidth` inverts its own bounds when
    /// `contentWidth < panelMinContentWidth` (at 700, `panelMaxWidth` is 280 while `panelMinWidth`
    /// is 360 — `min(max(w, 360), 280)` returns 280, below the documented minimum). Task 2 closes
    /// it by construction rather than by changing `panelClampWidth` itself: in `ShellRootView`,
    /// the divider renders only `if mode == .side`, and `ShellPanel`'s own clamped width is only
    /// ever COMPUTED (not just gated) in that same branch — and `mode == .side` is reachable only
    /// when `panelResolvedMode` did NOT force `.hidden`, i.e. only when `panelFitsInContent`
    /// already held. `PanelModeTests.testNarrowWindowForcesHidden` already pins the forcing half
    /// of that (below the threshold, resolved mode is always `.hidden`); this test pins the other
    /// half — the algebra that makes the gating actually sufficient: AT and ABOVE the threshold,
    /// the bounds can never invert. Between the two, no caller in the shell can reach
    /// `panelClampWidth` in the regime where it misbehaves. (The view-level wiring itself is not
    /// unit-testable here — this codebase deliberately does not exercise SwiftUI bodies — so the
    /// comment at the call site in `ShellSidebar.swift` points back to this test by name.)
    func testClampBoundsAreNeverInvertedWhenThePanelFits() {
        // Documents the known inversion below the threshold: it must stay UNREACHABLE from the
        // shell, not fixed here — fixing `panelClampWidth` itself is Task 2's other allowed route,
        // and this repo took the gating route instead.
        XCTAssertLessThan(panelMaxWidth(contentWidth: 700), panelMinWidth)

        // The guarantee: for every contentWidth that fits (panelResolvedMode would not force
        // .hidden), the clamp's own max never falls below its own min.
        for contentWidth in [panelMinContentWidth, panelMinContentWidth + 1,
                             panelMinContentWidth + 200, 2_400] {
            XCTAssertTrue(panelFitsInContent(contentWidth))
            XCTAssertGreaterThanOrEqual(panelMaxWidth(contentWidth: contentWidth), panelMinWidth,
                "contentWidth \(contentWidth) fits, so the clamp's max must not fall below its own min")
        }
    }
}
