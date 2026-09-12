import XCTest
@testable import Winter

/// Wave-9 gate fix: regression coverage for the manual response-scroll mechanism ported from
/// v1's `ScrollRedirector` + `GlassFieldWindow.scrollComposer` (see the wave-9 report). AppKit's
/// normal hit-test dispatch never delivered a scroll-wheel event to the inline response's
/// SwiftUI `ScrollView` (`GlassForegroundLegibility`'s `.compositingGroup()` + `.blendMode
/// (.difference)` silently broke that path — confirmed via synthesized CGEvent probes), so
/// `OrbWindowController`'s existing scroll monitor now drives `MorphModel.responseScrollOffset`
/// directly instead. These tests cover the pure math (`clampedResponseScrollOffset` and
/// `MorphModel`'s viewport/clamp helpers) — the AppKit event-tap wiring itself
/// (`OrbWindowController.applyResponseScroll(deltaY:)`) is a thin, untestable-without-a-real-
/// window wrapper around it, same convention as `ExchangeNavigationTests` testing the pure
/// `navigateExchange` rather than `OrbWindowController.handleAcceptedSwipe` directly.
@MainActor
final class ResponseScrollTests: XCTestCase {

    // MARK: clampedResponseScrollOffset (pure delta + clamp math)

    func testPositiveMaxOffsetAppliesDeltaWithSignInverted() {
        // Sign convention (see MorphModel.responseScrollOffset's doc): a NEGATIVE deltaY (natural
        // scrolling's "scroll down" gesture) must INCREASE the offset (reveal content further down).
        let result = clampedResponseScrollOffset(current: 10, deltaY: -5, maxOffset: 100)
        XCTAssertEqual(result, 15)
    }

    func testPositiveDeltaYDecreasesOffset() {
        let result = clampedResponseScrollOffset(current: 10, deltaY: 5, maxOffset: 100)
        XCTAssertEqual(result, 5)
    }

    func testClampsAtZeroFloor() {
        let result = clampedResponseScrollOffset(current: 2, deltaY: 20, maxOffset: 100)
        XCTAssertEqual(result, 0, "offset must never go negative — the reply's top edge is the floor")
    }

    func testClampsAtMaxOffsetCeiling() {
        let result = clampedResponseScrollOffset(current: 90, deltaY: -50, maxOffset: 100)
        XCTAssertEqual(result, 100, "offset must never scroll past the reply's bottom edge")
    }

    func testNegativeMaxOffsetTreatedAsZero() {
        // A reply shorter than the viewport reports maxOffset <= 0 (nothing to scroll) —
        // `clampedResponseScrollOffset` must not let a stale positive `current` survive that.
        let result = clampedResponseScrollOffset(current: 40, deltaY: -10, maxOffset: -5)
        XCTAssertEqual(result, 0)
    }

    func testZeroDeltaIsANoOpWithinRange() {
        let result = clampedResponseScrollOffset(current: 33, deltaY: 0, maxOffset: 100)
        XCTAssertEqual(result, 33)
    }

    // MARK: MorphModel viewport / clamp helpers

    func testShortReplyHasZeroMaxScrollOffset() {
        let morph = MorphModel()
        morph.responseHeight = 50 // far shorter than responseViewportHeight
        XCTAssertEqual(morph.maxResponseScrollOffset, 0)
    }

    func testTallReplyMaxScrollOffsetMatchesOverflow() {
        let morph = MorphModel()
        let viewport = morph.responseViewportHeight
        morph.responseHeight = viewport + 240
        XCTAssertEqual(morph.maxResponseScrollOffset, 240, accuracy: 0.001)
    }

    func testClampResponseScrollOffsetPullsInOutOfRangeValue() {
        let morph = MorphModel()
        morph.responseHeight = morph.responseViewportHeight + 100
        morph.responseScrollOffset = 9_999 // simulate scrolled deep into a long reply
        morph.clampResponseScrollOffset()
        XCTAssertEqual(morph.responseScrollOffset, 100, accuracy: 0.001)
    }

    func testClampResponseScrollOffsetResetsToZeroWhenContentShrinksBelowViewport() {
        // A swiped-in shorter historical exchange (or a reply that shrinks) must not leave a
        // stale mid-document offset behind — this is the reactive half of the fix
        // (`WinterFieldView`'s `.onGeometryChange` calls this whenever `responseHeight` changes).
        let morph = MorphModel()
        morph.responseHeight = morph.responseViewportHeight + 400
        morph.responseScrollOffset = 300
        morph.clampResponseScrollOffset()
        XCTAssertEqual(morph.responseScrollOffset, 300, accuracy: 0.001)

        morph.responseHeight = 10 // shorter than the viewport now
        morph.clampResponseScrollOffset()
        XCTAssertEqual(morph.responseScrollOffset, 0)
    }

    func testClampResponseScrollOffsetNeverGoesNegative() {
        let morph = MorphModel()
        morph.responseHeight = morph.responseViewportHeight + 50
        morph.responseScrollOffset = -20
        morph.clampResponseScrollOffset()
        XCTAssertEqual(morph.responseScrollOffset, 0)
    }
}
