import XCTest
@testable import Winter

/// 2e-iii Task 6: the PURE decisions behind the width-responsive sidebar integration — where the
/// tasks/subagents "work" content is placed (inline vs the right WorkSidebar, never both/neither)
/// and the chevron force-open semantics that defeat the T4 resize-drift double-tap.
final class SidebarRelocationTests: XCTestCase {

    // MARK: - Placement is exclusive (the never-duplicated invariant)

    /// `sidebarContentPlacement` depends ONLY on `rightVisible`, and is exclusive for every one of
    /// the four EffectiveSidebars right states (`rightVisible` × `rightOverlay`): work is EITHER
    /// inline OR in the sidebar — never both (would duplicate the sections), never neither (would
    /// drop them entirely).
    func testPlacementExclusiveForAllRightStates() {
        for rightVisible in [false, true] {
            for rightOverlay in [false, true] {
                let e = EffectiveSidebars(leftVisible: false, rightVisible: rightVisible,
                                          leftOverlay: false, rightOverlay: rightOverlay)
                let p = sidebarContentPlacement(e)
                XCTAssertNotEqual(p.inlineWork, p.sidebarWork,
                                  "placement must be exclusive for rightVisible=\(rightVisible) rightOverlay=\(rightOverlay)")
                XCTAssertEqual(p.inlineWork, !rightVisible)
                XCTAssertEqual(p.sidebarWork, rightVisible)
            }
        }
    }

    /// Tap-only overlays (SPEC): at the 560-wide morph window with the DEFAULT state (gate-feedback-1
    /// FIX B: BOTH sides now default expanded), neither sidebar is wide enough to sit inline, so
    /// BOTH collapse to a CHEVRON — NO auto-overlay. Work therefore renders INLINE below the
    /// composer and BOTH edge chevrons show. The work relocates into the (overlay) work sidebar
    /// ONLY after an explicit chevron tap.
    func testMorphWidthPlacesWorkInlineUntilRightOverlayOpens() {
        let defaultState = SidebarState(leftExpanded: true, rightExpanded: true,
                                        leftOverlayOpen: false, rightOverlayOpen: false)
        let resolved = resolveSidebars(width: 560,
                                       leftExpanded: defaultState.leftExpanded, rightExpanded: defaultState.rightExpanded,
                                       leftOverlayOpen: defaultState.leftOverlayOpen, rightOverlayOpen: defaultState.rightOverlayOpen)
        XCTAssertFalse(resolved.rightVisible, "expanded-but-unfit right is a chevron, never an auto-overlay")
        XCTAssertFalse(resolved.rightOverlay)
        XCTAssertFalse(resolved.leftVisible, "left expanded-but-unfit → a chevron on the left edge too")
        let placed = sidebarContentPlacement(resolved)
        XCTAssertTrue(placed.inlineWork, "work renders inline below the composer")
        XCTAssertFalse(placed.sidebarWork)

        // Explicit chevron tap on the unfitting right → an overlay, and work relocates into it.
        let opened = openRightViaChevron(defaultState, width: 560)
        XCTAssertTrue(opened.rightOverlayOpen)
        let afterOpen = resolveSidebars(width: 560,
                                        leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                        leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(afterOpen.rightOverlay, "560 too narrow to sit inline — the tap opens it as an overlay")
        XCTAssertTrue(afterOpen.rightVisible)
        let placedAfter = sidebarContentPlacement(afterOpen)
        XCTAssertFalse(placedAfter.inlineWork)
        XCTAssertTrue(placedAfter.sidebarWork, "work relocates into the (overlay) work sidebar")
    }

    /// Tap-open an overlay, then DISMISS (scrim): clears BOTH the overlay AND the `expanded` flag so
    /// the side collapses back to a chevron rather than snapping inline (stays hidden until re-tapped).
    func testDismissOverlayCollapsesToChevron() {
        let opened = openRightViaChevron(SidebarState(leftExpanded: false, rightExpanded: true,
                                                      leftOverlayOpen: false, rightOverlayOpen: false), width: 560)
        XCTAssertTrue(opened.rightOverlayOpen)
        let dismissed = dismissRightOverlay(opened)
        XCTAssertFalse(dismissed.rightOverlayOpen)
        XCTAssertFalse(dismissed.rightExpanded)
        let r = resolveSidebars(width: 560,
                                leftExpanded: dismissed.leftExpanded, rightExpanded: dismissed.rightExpanded,
                                leftOverlayOpen: dismissed.leftOverlayOpen, rightOverlayOpen: dismissed.rightOverlayOpen)
        XCTAssertFalse(r.rightVisible, "dismissed overlay → chevron, not visible")
    }

    /// Width growth while an overlay is tap-open: once the side FITS INLINE it renders inline (the
    /// chevron tap set `expanded` true), regardless of the lingering `overlayOpen` flag.
    func testOverlayRendersInlineOnceWidthFits() {
        let opened = openRightViaChevron(SidebarState(leftExpanded: false, rightExpanded: true,
                                                      leftOverlayOpen: false, rightOverlayOpen: false), width: 560)
        XCTAssertTrue(opened.rightExpanded)
        // Grow to 800 (≥780): right now fits inline → inline, not overlay.
        let r = resolveSidebars(width: 800,
                                leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(r.rightVisible)
        XCTAssertFalse(r.rightOverlay, "fits inline now — the overlayOpen flag is irrelevant")
    }

    // MARK: - CARRIED ITEM 1: chevron force-open defeats the T4 resize-drift double-tap

    /// THE regression: both sidebars expanded at 1200 (both fit, both visible) → resize down to 900
    /// (below both-fit). The right wins the tie so the LEFT goes invisible while `leftExpanded` is
    /// STILL true (resolveSidebars is pure — it never mutates the raw flags). The left chevron is
    /// now shown; tapping it must OPEN the left in ONE tap (and collapse the right), NOT blind-toggle
    /// the stale-true flag back to false.
    func testLeftChevronForcesOpenInOneTapAfterResizeDrift() {
        // Precondition: both expanded, resized to 900 → left is not visible, right is.
        let drifted = resolveSidebars(width: 900, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(drifted.leftVisible)
        XCTAssertTrue(drifted.rightVisible)

        // A NAIVE blind toggle of the stale-true flag would leave the left closed (the two-tap bug).
        let naive = toggleLeftSidebar(leftExpanded: true, rightExpanded: true, width: 900)
        XCTAssertFalse(naive.left, "documents the bug the chevron handler must avoid")

        // The chevron handler force-opens instead: ONE tap → left opens INLINE (900≥740 fits),
        // right collapses.
        let state = SidebarState(leftExpanded: true, rightExpanded: true,
                                 leftOverlayOpen: false, rightOverlayOpen: false)
        let opened = openLeftViaChevron(state, width: 900)
        XCTAssertTrue(opened.leftExpanded)
        XCTAssertFalse(opened.rightExpanded)
        XCTAssertFalse(opened.leftOverlayOpen, "fits inline → inline, not an overlay")
        // …and the resolved state after that one tap actually shows the left inline.
        let after = resolveSidebars(width: 900,
                                    leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                    leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(after.leftVisible)
        XCTAssertFalse(after.leftOverlay)
        XCTAssertFalse(after.rightVisible)
    }

    /// Mirror: at 900 with the LEFT inline (leftExpanded, rightExpanded=false), the right chevron
    /// force-opens the right in one tap and collapses the left.
    func testRightChevronForcesOpenInOneTap() {
        let state = SidebarState(leftExpanded: true, rightExpanded: false,
                                 leftOverlayOpen: false, rightOverlayOpen: false)
        let opened = openRightViaChevron(state, width: 900)
        XCTAssertTrue(opened.rightExpanded)
        XCTAssertFalse(opened.leftExpanded)
        XCTAssertFalse(opened.rightOverlayOpen)
        let after = resolveSidebars(width: 900,
                                    leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                    leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(after.rightVisible)
        XCTAssertFalse(after.leftVisible)
    }

    /// At a both-fit width the force-open applies NO mutual exclusion — opening the left leaves the
    /// right untouched (the sides are independent above the both-fit threshold).
    func testChevronForceOpenIndependentAtBothFit() {
        let state = SidebarState(leftExpanded: false, rightExpanded: true,
                                 leftOverlayOpen: false, rightOverlayOpen: false)
        let opened = openLeftViaChevron(state, width: 1200)
        XCTAssertTrue(opened.leftExpanded)
        XCTAssertTrue(opened.rightExpanded)
    }
}
