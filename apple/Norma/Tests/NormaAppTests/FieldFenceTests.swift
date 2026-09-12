import XCTest
@testable import Winter

/// Coverage for `fenceAnchorForTopLeftCorner` (FieldKit/FieldCorner.swift) — the pure geometry
/// seam that replaces `FieldPlacementTests`' old `fieldFrame` coverage (deleted: `fieldFrame`/
/// `FieldMetrics` are gone with the pre-transplant approximation). Where the old test asserted
/// a single fixed-size frame clamped inside the visible frame, this asserts the EDGE FENCE that
/// replaces v1's per-corner switching (user directive: `morphModel.corner` stays `.topLeft`
/// forever) — the anchor is clamped so the EXPANDED frame always fits from `.topLeft`, not the
/// anchor's own frame.
@MainActor
final class FieldFenceTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 950) // typical visibleFrame
    let expandedSize = CGSize(width: 480, height: 440)
    let haloPadding: CGFloat = 60
    let navOffset: CGFloat = 42 // navPillHeight(34) + interPillGap(8)

    func testAnchorWellInsideBoundsPassesThrough() {
        let anchor = CGPoint(x: 700, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        XCTAssertEqual(fenced, anchor)
    }

    /// Near the right edge: the expanded frame's right edge (`origin.x + expandedSize.width`)
    /// must stay inside the margin-inset visible frame.
    func testClampsAwayFromRightEdge() {
        let anchor = CGPoint(x: 1500, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertLessThanOrEqual(origin.x + expandedSize.width, screen.maxX - 16)
        XCTAssertLessThan(fenced.x, anchor.x, "anchor should have been pulled back from the raw edge-hugging value")
    }

    /// Near the bottom edge: the expanded frame's bottom edge (`origin.y`) must stay inside the
    /// margin-inset visible frame — this is the dominant constraint (needs ~`expandedSize.height`
    /// of clearance below the anchor).
    func testClampsAwayFromBottomEdge() {
        let anchor = CGPoint(x: 700, y: 20)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertGreaterThanOrEqual(origin.y, screen.minY + 16)
        XCTAssertGreaterThan(fenced.y, anchor.y, "anchor should have been pushed up from the raw edge-hugging value")
    }

    /// Near the top edge: the expanded frame's top edge must stay inside the visible frame too
    /// (haloPadding + navOffset clearance above the anchor for the nav pill).
    func testClampsAwayFromTopEdge() {
        let anchor = CGPoint(x: 700, y: 949)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertLessThanOrEqual(origin.y + expandedSize.height, screen.maxY - 16)
    }

    /// Near the left edge: a negative/near-zero anchor.x must still leave the expanded frame's
    /// left edge on-screen.
    func testClampsAwayFromLeftEdge() {
        let anchor = CGPoint(x: -50, y: 500)
        let fenced = fenceAnchorForTopLeftCorner(
            anchor, expandedSize: expandedSize, haloPadding: haloPadding, navOffset: navOffset,
            visibleFrame: screen
        )
        let origin = FieldCorner.topLeft.windowOrigin(
            glassAnchor: fenced,
            morph: MorphModel(),
            windowSize: expandedSize,
            surface: .composer
        )
        XCTAssertGreaterThanOrEqual(origin.x, screen.minX + 16)
    }

    /// A screen too small to ever fit the expanded frame must still produce a finite point
    /// (collapsed range, not an inverted min > max crash).
    func testDegenerateTinyScreenDoesNotProduceInvertedRange() {
        let tinyScreen = CGRect(x: 0, y: 0, width: 300, height: 300)
        let fenced = fenceAnchorForTopLeftCorner(
            CGPoint(x: 150, y: 150), expandedSize: expandedSize, haloPadding: haloPadding,
            navOffset: navOffset, visibleFrame: tinyScreen
        )
        XCTAssertTrue(fenced.x.isFinite)
        XCTAssertTrue(fenced.y.isFinite)
    }
}

/// GATE-3 FIX (F1) coverage for `followerTargetOrigin` (`Orb/OrbFollower.swift`) — the pure
/// extraction of `OrbFollower.targetOrigin()`'s math. Pre-fix, this fenced the anchor against
/// the EXPANDED frame size (`morphModel.windowSize`, 440pt tall) UNCONDITIONALLY, even while
/// collapsed — because `.topLeft`'s anchor sits near the window's TOP with the frame growing
/// ~338pt downward from it, that forced `anchor.y >= bounds.minY + 338` at all times, clamping
/// the COLLAPSED orb out of roughly the bottom third of every screen no matter where the cursor
/// went (measured live: it rode too high and never descended). Fencing against whichever size
/// is actually ACTIVE (`collapsedWindowSize` while `.orb`, `windowSize` while `.field`) fixes
/// this while still fully protecting the expanded field once it's the active size.
@MainActor
final class FollowerTargetOriginTests: XCTestCase {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 950) // typical visibleFrame
    let baseOffset = CGPoint(x: 24, y: -24) // v1's OrbFollower/PointerFollower baseOffset
    let morphModel = MorphModel()

    /// Bottom-third cursor: with the pre-fix code this would have floored around
    /// `screen.height / 3` (or higher) regardless of how low the cursor went; the corrected
    /// fence — sized to the small `collapsedWindowSize` while collapsed — lets the orb actually
    /// reach down there.
    func testCollapsedOrbReachesBottomThirdOfScreen() {
        let bottomThirdCursor = CGPoint(x: 700, y: 100)
        let origin = followerTargetOrigin(
            cursorLocation: bottomThirdCursor,
            magneticTarget: nil,
            baseOffset: baseOffset,
            activeSize: morphModel.collapsedWindowSize,
            morphModel: morphModel,
            visibleFrame: screen
        )
        XCTAssertLessThan(
            origin.y, screen.height / 3,
            "collapsed orb must be able to track the cursor into the bottom third of the screen"
        )
    }

    /// Center cursor: sanity check that the collapsed orb's origin sits in the middle band, not
    /// pinned to any one edge.
    func testCollapsedOrbTracksCenterCursor() {
        let centerCursor = CGPoint(x: 700, y: 475)
        let origin = followerTargetOrigin(
            cursorLocation: centerCursor,
            magneticTarget: nil,
            baseOffset: baseOffset,
            activeSize: morphModel.collapsedWindowSize,
            morphModel: morphModel,
            visibleFrame: screen
        )
        XCTAssertGreaterThan(origin.y, screen.height / 3)
        XCTAssertLessThan(origin.y, screen.height * 2 / 3)
    }

    /// Top-third cursor, plus a monotonicity check across all three bands together: the window
    /// origin must rise as the cursor rises, with no dead/flattened band (the collapsed-orb
    /// symptom was exactly such a flattened band pinned near the top).
    func testCollapsedOrbTracksTopThirdCursorMonotonically() {
        func origin(forCursorY y: CGFloat) -> CGPoint {
            followerTargetOrigin(
                cursorLocation: CGPoint(x: 700, y: y),
                magneticTarget: nil,
                baseOffset: baseOffset,
                activeSize: morphModel.collapsedWindowSize,
                morphModel: morphModel,
                visibleFrame: screen
            )
        }
        let bottom = origin(forCursorY: 100)
        let center = origin(forCursorY: 475)
        let top = origin(forCursorY: 850)

        XCTAssertLessThan(top.y, screen.height, "top-third cursor must still resolve on-screen")
        XCTAssertLessThan(bottom.y, center.y, "window origin should rise as the cursor rises")
        XCTAssertLessThan(center.y, top.y, "window origin should rise as the cursor rises")
    }

    /// The expanded field must still be fully fenced against the visible frame — this fix must
    /// not weaken protection for the surface it was originally written to protect.
    func testExpandedFieldStillFencedAgainstFullFrame() {
        let bottomHuggingCursor = CGPoint(x: 700, y: 20)
        let origin = followerTargetOrigin(
            cursorLocation: bottomHuggingCursor,
            magneticTarget: nil,
            baseOffset: baseOffset,
            activeSize: morphModel.windowSize,
            morphModel: morphModel,
            visibleFrame: screen
        )
        XCTAssertGreaterThanOrEqual(origin.y, screen.minY + 16)
        XCTAssertLessThanOrEqual(origin.y + morphModel.windowSize.height, screen.maxY - 16)
    }
}
