import XCTest
@testable import Norma

final class PanelModeTests: XCTestCase {
    func testMaxWidthAlwaysLeavesTheChatItsMinimum() {
        XCTAssertEqual(panelMaxWidth(contentWidth: 1200), 1200 - panelMinChatWidth)
    }

    func testClampHonoursBothBounds() {
        // below the panel's own minimum -> raised
        XCTAssertEqual(panelClampWidth(100, contentWidth: 1200), panelMinWidth)
        // above the max -> lowered, chat keeps panelMinChatWidth (300 as of review round 2;
        // written symbolically below rather than as a second literal so this line cannot drift
        // from the constant the way the comment alone already had)
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
        // review round 2: 700 moved to 600 — `panelMinChatWidth` (420 -> 300, user-decided scope
        // change) raised the fitting threshold to 660, so 700 now fits and no longer demonstrates
        // "too narrow"; 600 still sits below it.
        XCTAssertEqual(panelResolvedMode(requested: .side, contentWidth: 600), .hidden)
        XCTAssertEqual(panelResolvedMode(requested: .maximized, contentWidth: 600), .hidden)
        XCTAssertEqual(panelResolvedMode(requested: .side, contentWidth: 1200), .side)
    }

    func testMinimumContentWidthIsTheSumOfBothMinimums() {
        XCTAssertEqual(panelMinContentWidth, panelMinWidth + panelMinChatWidth)
    }

    /// Closes the finding carried from Task 1: `panelClampWidth` inverts its own bounds when
    /// `contentWidth < panelMinContentWidth` (at 600, `panelMaxWidth` is 300 while `panelMinWidth`
    /// is 360 — `min(max(w, 360), 300)` returns 300, below the documented minimum). Task 2 closes
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
    ///
    /// review round 2: the literal moved from 700 to 600 — `panelMinChatWidth` (420 -> 300,
    /// user-decided scope change) raised the fitting threshold to 660, so 700 now fits and no
    /// longer demonstrates an inversion; 600 still sits below it and still does.
    func testClampBoundsAreNeverInvertedWhenThePanelFits() {
        // Documents the known inversion below the threshold: it must stay UNREACHABLE from the
        // shell, not fixed here — fixing `panelClampWidth` itself is Task 2's other allowed route,
        // and this repo took the gating route instead.
        XCTAssertLessThan(panelMaxWidth(contentWidth: 600), panelMinWidth)

        // The guarantee: for every contentWidth that fits (panelResolvedMode would not force
        // .hidden), the clamp's own max never falls below its own min.
        for contentWidth in [panelMinContentWidth, panelMinContentWidth + 1,
                             panelMinContentWidth + 200, 2_400] {
            XCTAssertTrue(panelFitsInContent(contentWidth))
            XCTAssertGreaterThanOrEqual(panelMaxWidth(contentWidth: contentWidth), panelMinWidth,
                "contentWidth \(contentWidth) fits, so the clamp's max must not fall below its own min")
        }
    }

    // MARK: - panel-shell T10: PanelPresentation — mode and width survive every mode change

    func testLeavingMaximizedRestoresTheDraggedWidth() {
        var p = PanelPresentation(mode: .side, sideWidth: 640)
        p.toggleMaximized()
        XCTAssertEqual(p.mode, .maximized)
        p.toggleMaximized()
        XCTAssertEqual(p.mode, .side)
        // the whole point: 640, not panelDefaultWidth
        XCTAssertEqual(p.sideWidth, 640)
    }

    func testVisibilityToggleAlsoPreservesWidth() {
        var p = PanelPresentation(mode: .side, sideWidth: 640)
        p.toggleVisible()
        XCTAssertEqual(p.mode, .hidden)
        p.toggleVisible()
        XCTAssertEqual(p.mode, .side)
        XCTAssertEqual(p.sideWidth, 640)
    }

    func testExpandFromHiddenGoesStraightToMaximized() {
        var p = PanelPresentation(mode: .hidden, sideWidth: 640)
        p.toggleMaximized()
        XCTAssertEqual(p.mode, .maximized)
    }

    func testExpandButtonMatchesTheMeasuredReference() {
        XCTAssertEqual(panelExpandButtonSize, 28)
        XCTAssertEqual(panelExpandButtonInset, 8)
    }

    /// Mirrors `testSidebarToggleGlyphDiffersBetweenStates` (`SidebarBrandTests`) for the expand
    /// button's own pure glyph function — the two states must be visually distinguishable, not
    /// just internally different strings.
    func testExpandButtonGlyphDiffersBetweenStates() {
        XCTAssertNotEqual(panelExpandButtonSystemImage(mode: .side),
                           panelExpandButtonSystemImage(mode: .maximized))
    }

    /// The label names the ACTION, complementing the glyph's state — same convention as
    /// `shellSidebarToggleLabel`.
    func testExpandButtonLabelNamesTheAction() {
        XCTAssertEqual(panelExpandButtonLabel(mode: .side), "Expand panel")
        XCTAssertEqual(panelExpandButtonLabel(mode: .maximized), "Restore panel")
    }

    // MARK: - panel-shell T10: panelRenderedWidth — the one formula for "how wide is the panel"

    /// `.maximized` needs no clamp at all — `detail` isn't even rendered then, so the panel simply
    /// takes the whole content area. Extracted into its own pure function (review self-catch, T10):
    /// a hoisted `let` at the call site would evaluate `panelClampWidth` even while `.hidden`
    /// (harmless in isolation, but it would violate the documented guarantee that nothing in this
    /// file reaches `panelClampWidth` outside the regime where its own bounds cannot invert —
    /// `testClampBoundsAreNeverInvertedWhenThePanelFits` above). Calling this function only from
    /// inside an already-`mode != .hidden`-gated branch (`ShellSidebar.swift`) keeps that true.
    func testPanelRenderedWidthUsesFullContentWidthWhenMaximized() {
        XCTAssertEqual(panelRenderedWidth(mode: .maximized, sideWidth: 999, contentWidth: 1200), 1200)
    }

    func testPanelRenderedWidthClampsTheDraggedWidthWhenSide() {
        XCTAssertEqual(panelRenderedWidth(mode: .side, sideWidth: 600, contentWidth: 1200), 600)
        XCTAssertEqual(panelRenderedWidth(mode: .side, sideWidth: 50, contentWidth: 1200), panelMinWidth)
    }
}
