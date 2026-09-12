import XCTest
@testable import Winter

/// Wave-8 gate item 2 (bug report, screenshot-evidenced): a two-finger vertical drag over the
/// expanded field failed to scroll the inline reply's `ScrollView` — `OrbWindowController`'s
/// local `scrollWheel` monitor swallowed the WHOLE gesture (`event.window ===
/// panel` guard is fine; `TrackpadHorizontalSwipeRecognizer.handle` is the actual culprit).
///
/// ROOT CAUSE: `isTrackingHorizontal` was sticky for the rest of a physical gesture once ANY
/// single sample tipped past `horizontalDominanceRatio` (1.32) — real two-finger onset is noisy
/// enough that an ordinary vertical scroll's first sample or two can transiently satisfy that
/// ratio before the hand settles, latching horizontal tracking (and therefore `consumesScroll ==
/// true`, i.e. "swallow this event, don't hand it to the ScrollView") for every later sample of
/// that same gesture even once it's unambiguously vertical. `testNoisyOnsetSettlesVertical...`
/// below is RED against the pre-fix recognizer (proven by re-running it against a checkout of the
/// prior `TrackpadHorizontalSwipe.swift` before this wave's edit) and GREEN after — the fix lets a
/// clearly VERTICAL-dominant sample un-latch the lock, but only before the gesture has actually
/// committed to a horizontal swipe (`didTriggerForCurrentGesture`), so accepted horizontal
/// navigation swipes and their trailing momentum are unaffected (`testPureHorizontalDragStillSwipes`,
/// `testCommittedHorizontalIgnoresTrailingVerticalNoise`).
final class TrackpadVerticalPassthroughTests: XCTestCase {
    private func makeRecognizer() -> TrackpadHorizontalSwipeRecognizer {
        TrackpadHorizontalSwipeRecognizer()
    }

    /// A clean, single-direction vertical two-finger scroll must never be consumed — every
    /// sample should come back `.ignored` (`consumesScroll == false`) so the local monitor lets
    /// AppKit route it on to the field's `ScrollView` untouched.
    func testPureVerticalDragAlwaysIgnored() {
        let r = makeRecognizer()
        let samples: [(CGFloat, CGFloat, TrackpadScrollEventPhase)] = [
            (0, 0, .began),
            (0, -8, .changed),
            (1, -15, .changed),
            (0, -20, .changed),
            (-1, -18, .changed),
            (0, -10, .changed),
            (0, 0, .ended),
        ]
        for (i, sample) in samples.enumerated() {
            let result = r.handle(
                deltaX: sample.0, deltaY: sample.1,
                phase: sample.2, momentumPhase: .none,
                timestamp: Double(i) * 0.02
            )
            XCTAssertEqual(result, .ignored, "sample \(i) (\(sample.0), \(sample.1)) must PASS THROUGH, not be consumed")
        }
    }

    /// THE regression: gesture-onset jitter tips the very first real sample horizontal-dominant
    /// (absX(6) > absY(4) * 1.32 == 5.28) before the user's hand settles into an obviously
    /// vertical drag. Every sample from the second one on is unambiguously vertical-dominant and
    /// must PASS THROUGH once the recognizer sees it, not stay swallowed for the rest of the
    /// gesture.
    func testNoisyOnsetSettlesVerticalAndPassesThrough() {
        let r = makeRecognizer()
        // Onset noise: mildly horizontal-dominant by the ratio's own math.
        let onset = r.handle(deltaX: 6, deltaY: 4, phase: .began, momentumPhase: .none, timestamp: 0)
        XCTAssertEqual(onset, .tracking, "the noisy onset sample itself is expected to latch tracking")

        // The gesture immediately settles into a clean, clearly vertical drag.
        let settled: [(CGFloat, CGFloat)] = [(0, -12), (1, -20), (0, -25), (-1, -22), (0, -14)]
        for (i, sample) in settled.enumerated() {
            let result = r.handle(
                deltaX: sample.0, deltaY: sample.1,
                phase: .changed, momentumPhase: .none,
                timestamp: 0.02 + Double(i) * 0.02
            )
            XCTAssertEqual(
                result, .ignored,
                "settled vertical sample \(i) (\(sample.0), \(sample.1)) must un-latch and PASS THROUGH " +
                "to the reply's ScrollView, not stay consumed because of the onset's noise"
            )
        }
    }

    /// A clean, sustained horizontal drag must still resolve to `.swiped` (history nav must keep
    /// working) — the un-latch fix must not regress the feature it shares a recognizer with.
    func testPureHorizontalDragStillSwipes() {
        let r = makeRecognizer()
        let samples: [(CGFloat, CGFloat)] = [(0, 0), (-20, 1), (-30, 0), (-25, 0)]
        var sawSwipe = false
        for (i, sample) in samples.enumerated() {
            let result = r.handle(
                deltaX: sample.0, deltaY: sample.1,
                phase: i == 0 ? .began : .changed, momentumPhase: .none,
                timestamp: Double(i) * 0.02
            )
            if case .swiped(let direction) = result {
                sawSwipe = true
                XCTAssertEqual(direction, .left)
            }
        }
        XCTAssertTrue(sawSwipe, "sustained horizontal drag must still cross threshold and fire .swiped")
    }

    /// Once a horizontal swipe has actually COMMITTED (`.swiped` already fired for this gesture),
    /// a little trailing vertical noise (e.g. momentum settling) must not un-latch it — the same
    /// gesture keeps being consumed to the end, matching the pre-fix contract for the accepted
    /// case.
    func testCommittedHorizontalIgnoresTrailingVerticalNoise() {
        let r = makeRecognizer()
        _ = r.handle(deltaX: 0, deltaY: 0, phase: .began, momentumPhase: .none, timestamp: 0)
        _ = r.handle(deltaX: -40, deltaY: 0, phase: .changed, momentumPhase: .none, timestamp: 0.02)
        let triggered = r.handle(deltaX: -40, deltaY: 0, phase: .changed, momentumPhase: .none, timestamp: 0.04)
        guard case .swiped = triggered else {
            return XCTFail("setup must trigger .swiped before exercising the post-commit path")
        }

        // Trailing sample within the SAME gesture that happens to read vertical-dominant.
        let trailing = r.handle(deltaX: 0, deltaY: -5, phase: .changed, momentumPhase: .none, timestamp: 0.06)
        XCTAssertTrue(trailing.consumesScroll, "a committed horizontal swipe must keep consuming its own trailing samples")
    }
}
