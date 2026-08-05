import XCTest
@testable import Norma

/// 2e-iii Task 4 / Task 6: the pure width engine — thresholds (780 right / 740 left-alone / 1000
/// both), the user's mutual-exclusion rule below both-fit ("opening the left collapses the right"),
/// and TAP-ONLY overlays (fix: `expanded` is inline-only — an expanded-but-unfit side is a chevron,
/// NEVER an auto-overlay; overlays come solely from an explicit `overlayOpen` request).
final class SidebarLayoutTests: XCTestCase {
    func testBothFitIndependence() {
        let r = resolveSidebars(width: 1000, leftExpanded: true, rightExpanded: true)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: true, rightVisible: true, leftOverlay: false, rightOverlay: false))
        XCTAssertFalse(resolveSidebars(width: 1000, leftExpanded: false, rightExpanded: true).leftVisible)
    }

    func testBelowBothFitAtMostOneRightWins() {
        // 999: both expanded → only RIGHT shows (right-first default on resize-down)
        let r = resolveSidebars(width: 999, leftExpanded: true, rightExpanded: true)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: false, rightVisible: true, leftOverlay: false, rightOverlay: false))
    }

    func testLeftAloneInlineAt740OverlayBelow() {
        let inline = resolveSidebars(width: 740, leftExpanded: true, rightExpanded: false)
        XCTAssertEqual(inline, EffectiveSidebars(leftVisible: true, rightVisible: false, leftOverlay: false, rightOverlay: false))
        // 739: expanded-but-unfit alone → NO overlay (a chevron). Overlay only with an explicit tap-open.
        XCTAssertFalse(resolveSidebars(width: 739, leftExpanded: true, rightExpanded: false).leftVisible)
        XCTAssertTrue(resolveSidebars(width: 739, leftExpanded: true, rightExpanded: false, leftOverlayOpen: true).leftOverlay)
    }

    func testRightInlineBoundary() {
        // 780: fits inline (no overlay) even with an overlayOpen request — overlays are honored only
        // when the side does NOT fit inline.
        XCTAssertFalse(resolveSidebars(width: 780, leftExpanded: false, rightExpanded: true).rightOverlay)
        XCTAssertFalse(resolveSidebars(width: 780, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true).rightOverlay)
        // 779: expanded alone is a chevron; only an explicit tap-open makes it an overlay.
        XCTAssertFalse(resolveSidebars(width: 779, leftExpanded: false, rightExpanded: true).rightVisible)
        XCTAssertTrue(resolveSidebars(width: 779, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true).rightOverlay)
    }

    func testMorphWindowTapOnlyOverlays() {
        // 560: fits neither. Expanded alone shows NOTHING (chevrons) — never an auto-overlay.
        let expandedOnly = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(expandedOnly.leftVisible); XCTAssertFalse(expandedOnly.rightVisible)
        // A tap-open on the (unfitting) right → overlay, and it excludes the left entirely.
        let r = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertTrue(r.rightOverlay); XCTAssertFalse(r.leftVisible)
        // A tap-open on the left → overlay, right excluded.
        let l = resolveSidebars(width: 560, leftExpanded: true, rightExpanded: false, leftOverlayOpen: true)
        XCTAssertTrue(l.leftOverlay); XCTAssertFalse(l.rightVisible)
    }

    func testNeitherExpanded() {
        let r = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: false)
        XCTAssertEqual(r, EffectiveSidebars(leftVisible: false, rightVisible: false, leftOverlay: false, rightOverlay: false))
    }

    // MARK: - Fix (tap-only overlays): the new contract's edge cases

    /// (a) Resize-down 800→700 with the RIGHT expanded: 700 can't fit it inline, so it collapses to
    /// a CHEVRON — NOT an overlay. (An auto-overlay was the bug this fix removes.)
    func testResizeDownExpandedRightBecomesChevronNotOverlay() {
        let at800 = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: true)
        XCTAssertTrue(at800.rightVisible); XCTAssertFalse(at800.rightOverlay) // inline at 800
        let at700 = resolveSidebars(width: 700, leftExpanded: false, rightExpanded: true)
        XCTAssertFalse(at700.rightVisible, "expanded-but-unfit → chevron")
        XCTAssertFalse(at700.rightOverlay, "never an auto-overlay")
    }

    /// (b) `overlayOpen` is honored ONLY when the side does NOT fit inline. At 800 the right fits
    /// inline → a lingering `rightOverlayOpen` is ignored (renders inline); at 700 it's honored.
    func testOverlayOpenHonoredOnlyWhenNotFittingInline() {
        let fits = resolveSidebars(width: 800, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertFalse(fits.rightOverlay); XCTAssertTrue(fits.rightVisible) // inline, overlayOpen ignored
        let unfit = resolveSidebars(width: 700, leftExpanded: false, rightExpanded: true, rightOverlayOpen: true)
        XCTAssertTrue(unfit.rightOverlay)
    }

    /// (c) At most ONE overlay, RIGHT wins ties: below both left-alone and right-alone fit widths,
    /// both `overlayOpen` set → only the right overlays.
    func testAtMostOneOverlayRightWins() {
        let r = resolveSidebars(width: 700, leftExpanded: true, rightExpanded: true,
                                leftOverlayOpen: true, rightOverlayOpen: true)
        XCTAssertTrue(r.rightOverlay)
        XCTAssertFalse(r.leftOverlay)
        XCTAssertFalse(r.leftVisible)
    }

    /// (d) The one-tap force-open regression still holds: both expanded at 1200, resize to 900 (left
    /// drifts invisible with `leftExpanded` stale-true), a left chevron tap opens the left INLINE in
    /// ONE tap and collapses the right.
    func testLeftChevronOneTapForceOpenAfterResizeDrift() {
        let drifted = resolveSidebars(width: 900, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(drifted.leftVisible); XCTAssertTrue(drifted.rightVisible)
        let opened = openLeftViaChevron(SidebarState(leftExpanded: true, rightExpanded: true,
                                                     leftOverlayOpen: false, rightOverlayOpen: false), width: 900)
        XCTAssertTrue(opened.leftExpanded); XCTAssertFalse(opened.rightExpanded)
        let after = resolveSidebars(width: 900,
                                    leftExpanded: opened.leftExpanded, rightExpanded: opened.rightExpanded,
                                    leftOverlayOpen: opened.leftOverlayOpen, rightOverlayOpen: opened.rightOverlayOpen)
        XCTAssertTrue(after.leftVisible); XCTAssertFalse(after.leftOverlay); XCTAssertFalse(after.rightVisible)
    }

    func testToggleLeftCollapsesRightBelowBothFit() {
        // THE user rule: right open at 800, tap left chevron → left opens, right collapses
        let t = toggleLeftSidebar(leftExpanded: false, rightExpanded: true, width: 800)
        XCTAssertEqual(t.left, true); XCTAssertEqual(t.right, false)
        // and at bothFit width the right is untouched
        let wide = toggleLeftSidebar(leftExpanded: false, rightExpanded: true, width: 1200)
        XCTAssertEqual(wide.left, true); XCTAssertEqual(wide.right, true)
        // collapsing left (toggle off) never force-opens right
        let off = toggleLeftSidebar(leftExpanded: true, rightExpanded: false, width: 800)
        XCTAssertEqual(off.left, false); XCTAssertEqual(off.right, false)
    }

    func testToggleRightMirrors() {
        let t = toggleRightSidebar(leftExpanded: true, rightExpanded: false, width: 800)
        XCTAssertEqual(t.right, true); XCTAssertEqual(t.left, false)
    }

    // MARK: - gate-feedback-1 FIX B: `WindowContentView`'s `@State private var sidebar` now
    // defaults to `SidebarState(leftExpanded: true, rightExpanded: true, ...)` (both sides
    // expanded — previously only the right was). These pin the two width thresholds the brief
    // called out against THAT exact default combination, so a future default drift is caught here
    // rather than only visually.

    /// At (or above) the both-fit width (1000 = `sidebarContentMinWidth` 520 + `sidebarLeftWidth`
    /// 220 + `sidebarRightWidth` 260), the new default renders BOTH sidebars inline — no mutual
    /// exclusion applies above this threshold.
    func testDefaultStateAtBothFitWidthShowsBothSidebars() {
        let r = resolveSidebars(width: 1000, leftExpanded: true, rightExpanded: true)
        XCTAssertTrue(r.leftVisible)
        XCTAssertTrue(r.rightVisible)
        XCTAssertFalse(r.leftOverlay)
        XCTAssertFalse(r.rightOverlay)
    }

    /// Below the both-fit width (800 < 1000, but ≥ 780 so the right alone still fits), mutual
    /// exclusion kicks in and the RIGHT wins the tie — even though `leftExpanded` is ALSO true by
    /// default now, only the right renders (the left shows as a chevron, not an overlay).
    func testDefaultStateAt800ShowsRightOnly() {
        let r = resolveSidebars(width: 800, leftExpanded: true, rightExpanded: true)
        XCTAssertFalse(r.leftVisible, "below both-fit, right wins the tie even with left also expanded")
        XCTAssertTrue(r.rightVisible)
        XCTAssertFalse(r.leftOverlay, "unfit-but-expanded is a chevron, never an auto-overlay")
        XCTAssertFalse(r.rightOverlay)
    }

    // MARK: - gate-feedback-1 FIX C: the edge-chevron glyph moved from vertically-centered to
    // top-anchored (`WindowContentView.sidebarChevron`) — visual only, pinning the layout constant
    // it uses (`sidebarChevronTopOffset`) against the brief's "~12-16pt below the top inset".

    func testChevronTopOffsetWithinSpecRange() {
        XCTAssertGreaterThanOrEqual(sidebarChevronTopOffset, 12)
        XCTAssertLessThanOrEqual(sidebarChevronTopOffset, 16)
    }

    // MARK: - app-shell T3: the RIGHT-ONLY configuration (`SidebarWiring.showsSessionSwitcher`)

    /// THE COMPATIBILITY BAR, as an identity: the default configuration (`showsSessionSwitcher:
    /// true` — the orb's morph window and every detached window, neither of which passes the flag)
    /// hands `resolveSidebars` the state UNCHANGED. Byte-identical inputs ⇒ byte-identical layout;
    /// nothing about those two surfaces can move because the shell needed a third shape.
    func testDefaultConfigurationIsTheIdentity() {
        let states = [
            SidebarState(leftExpanded: true, rightExpanded: true, leftOverlayOpen: false, rightOverlayOpen: false),
            SidebarState(leftExpanded: false, rightExpanded: false, leftOverlayOpen: false, rightOverlayOpen: false),
            SidebarState(leftExpanded: true, rightExpanded: false, leftOverlayOpen: true, rightOverlayOpen: false),
            SidebarState(leftExpanded: false, rightExpanded: true, leftOverlayOpen: false, rightOverlayOpen: true),
        ]
        for state in states {
            XCTAssertEqual(sidebarStateForConfiguration(state, showsSessionSwitcher: true), state,
                           "the default configuration must be a no-op on \(state)")
        }
    }

    /// The shell's configuration: its own outer nav IS the session switcher, so the inner left
    /// column is masked off at EVERY width — never inline, never an overlay, at no threshold.
    func testRightOnlyConfigurationMasksTheLeftAtEveryWidth() {
        let both = SidebarState(leftExpanded: true, rightExpanded: true, leftOverlayOpen: true, rightOverlayOpen: false)
        let masked = sidebarStateForConfiguration(both, showsSessionSwitcher: false)
        XCTAssertFalse(masked.leftExpanded)
        XCTAssertFalse(masked.leftOverlayOpen)
        for width: CGFloat in [1400, 1000, 999, 900, 800, 780, 779, 700, 560, 300, 0] {
            let r = resolveSidebars(width: width,
                                    leftExpanded: masked.leftExpanded, rightExpanded: masked.rightExpanded,
                                    leftOverlayOpen: masked.leftOverlayOpen, rightOverlayOpen: masked.rightOverlayOpen)
            XCTAssertFalse(r.leftVisible, "the left column must never render at width \(width)")
            XCTAssertFalse(r.leftOverlay, "the left column must never overlay at width \(width)")
        }
    }

    /// …and the RIGHT work column keeps its OWN threshold (content 520 + right 260 = 780), rather
    /// than inheriting the both-fit width it would need if the left were still in the layout. The
    /// shell's window is 1100 wide by default, so this is the case that actually ships — but the
    /// 780 boundary is what makes a narrowed shell behave like every other surface.
    func testRightOnlyConfigurationKeepsTheRightAtItsOwnThreshold() {
        let masked = sidebarStateForConfiguration(
            SidebarState(leftExpanded: true, rightExpanded: true, leftOverlayOpen: false, rightOverlayOpen: false),
            showsSessionSwitcher: false)
        let atThreshold = resolveSidebars(width: 780,
                                          leftExpanded: masked.leftExpanded, rightExpanded: masked.rightExpanded,
                                          leftOverlayOpen: masked.leftOverlayOpen, rightOverlayOpen: masked.rightOverlayOpen)
        XCTAssertTrue(atThreshold.rightVisible, "the work column fits inline at content+right, with no left to share with")
        XCTAssertFalse(atThreshold.rightOverlay)
        // Below it the right is a chevron (never an auto-overlay) and a tap-open still overlays.
        let below = resolveSidebars(width: 779,
                                    leftExpanded: masked.leftExpanded, rightExpanded: masked.rightExpanded,
                                    leftOverlayOpen: masked.leftOverlayOpen, rightOverlayOpen: masked.rightOverlayOpen)
        XCTAssertFalse(below.rightVisible)
        XCTAssertTrue(resolveSidebars(width: 779,
                                      leftExpanded: masked.leftExpanded, rightExpanded: masked.rightExpanded,
                                      leftOverlayOpen: masked.leftOverlayOpen, rightOverlayOpen: true).rightOverlay)
    }
}
