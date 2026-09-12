import XCTest
@testable import Winter

/// GATE r1 FIX (F3) coverage for `chatButtonFinalRect(navFinal:interPillGap:)`
/// (`FieldKit/WinterFieldView.swift`) — the pure geometry for the top-row expand/chat button
/// restored per v1's `chatButtonFinalRect(navFinal:)` (GlassFieldView.swift:1058-1066): a square
/// glass button, sized to the nav pill's own height, sitting `interPillGap` immediately to its
/// left at the same y.
///
/// `navFinal` fixtures below are computed by hand using `WinterFieldView.navPillFinalRect`'s own
/// formula (private, so not callable directly from here) against a real `MorphModel()`'s default
/// constants, for BOTH `corner.isLeft` branches — `.topLeft`/`.topRight` are the only two the
/// composer path distinguishes (`composerOnTop` is true for both, only `isLeft` changes the nav
/// pill's x formula). `morph.corner` is pinned at `.topLeft` forever today (only that branch is
/// live), but this pins the dormant `!isLeft` branch's geometry too, matching v1's own
/// corner-agnostic `chatButtonFinalRect` formula (see that function's doc).
@MainActor
final class ChatButtonGeometryTests: XCTestCase {
    let morph = MorphModel()

    /// isLeft branch (`.topLeft`/`.bottomLeft`): `navPillFinalRect`'s x formula
    /// (`composerFinal.minX + navPillHeight + interPillGap`) already reserves exactly this
    /// button's `size + gap`, so the button should land flush with `composerFinal`'s own left
    /// edge.
    private var navFinalIsLeft: CGRect {
        let composerMinX = morph.haloPadding // corner.isLeft: composerFinal.x = haloPadding
        let width = min(morph.navPillMaxWidth, morph.composerWidth - 40)
        let x = composerMinX + morph.navPillHeight + morph.interPillGap
        return CGRect(x: x, y: 60, width: width, height: morph.navPillHeight)
    }

    /// !isLeft branch (`.topRight`/`.bottomRight`): `navPillFinalRect`'s nav pill hugs
    /// `composerFinal.maxX` directly (`composerFinal.maxX - width`), with no explicit reservation
    /// for the button — the button must still fit in the 40pt slack `navPillFinalRect` leaves
    /// between its capped width and the composer's own width.
    private var navFinalIsRight: CGRect {
        let composerMaxX = morph.windowSize.width - morph.haloPadding // corner.isLeft == false
        let width = min(morph.navPillMaxWidth, morph.composerWidth - 40)
        let x = composerMaxX - width
        return CGRect(x: x, y: 60, width: width, height: morph.navPillHeight)
    }

    func testAdjacentLeftOfNavPillWithInterPillGap() {
        let navFinal = navFinalIsLeft
        let rect = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)

        XCTAssertEqual(navFinal.minX - rect.maxX, morph.interPillGap, accuracy: 0.001,
                       "button's trailing edge must sit exactly interPillGap left of the nav pill")
    }

    func testSameHeightAsNavPill() {
        let navFinal = navFinalIsLeft
        let rect = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)

        XCTAssertEqual(rect.height, navFinal.height)
        XCTAssertEqual(rect.width, navFinal.height, "button is square: width == height == nav pill height")
    }

    func testVerticallyAlignedWithNavPill() {
        let navFinal = navFinalIsLeft
        let rect = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)

        XCTAssertEqual(rect.minY, navFinal.minY)
    }

    func testStaysWithinWindowBoundsForIsLeftCorner() {
        let navFinal = navFinalIsLeft
        let rect = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)

        XCTAssertGreaterThanOrEqual(rect.minX, 0)
        XCTAssertLessThanOrEqual(rect.maxX, morph.windowSize.width)
        XCTAssertGreaterThanOrEqual(rect.minY, 0)
        XCTAssertLessThanOrEqual(rect.maxY, morph.windowSize.height)
        // On this branch navPillFinalRect already reserves the gap, so the button lands flush
        // with the composer's own left edge (haloPadding).
        XCTAssertEqual(rect.minX, morph.haloPadding, accuracy: 0.001)
    }

    func testStaysWithinWindowBoundsForRightCorner() {
        let navFinal = navFinalIsRight
        let rect = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)

        XCTAssertGreaterThanOrEqual(rect.minX, 0)
        XCTAssertLessThanOrEqual(rect.maxX, morph.windowSize.width)
        XCTAssertGreaterThanOrEqual(rect.minY, 0)
        XCTAssertLessThanOrEqual(rect.maxY, morph.windowSize.height)
        // Still adjacent-left of the nav pill with the same gap, regardless of corner.
        XCTAssertEqual(navFinal.minX - rect.maxX, morph.interPillGap, accuracy: 0.001)
    }
}
