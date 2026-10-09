import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The cursor's state machine: transitions, timing against an explicit clock, Reduce Motion, and the core mapping.
final class CursorTimelineTests: XCTestCase {
    typealias T = CursorTimeline.Timing
    let a = CGPoint(x: 100, y: 100)
    let b = CGPoint(x: 400, y: 100)

    func shown(at p: CGPoint, reduceMotion: Bool = false) -> CursorTimeline {
        var t = CursorTimeline(options: .init(reduceMotion: reduceMotion))
        t.receive(.idle, at: p, now: 0)
        return t
    }

    // MARK: - Appear, idle, done

    func testHiddenUntilTheFirstEventThenAppearsInPlace() {
        var t = CursorTimeline()
        XCTAssertFalse(t.frame(at: 0).visible)
        XCTAssertEqual(t.animationNeed(at: 0), .none)
        t.receive(.move, at: a, now: 1)
        let first = t.frame(at: 1)
        XCTAssertTrue(first.visible)
        XCTAssertEqual(first.tip, a, "the first appearance never glides in from somewhere")
        XCTAssertEqual(first.opacity, 0, accuracy: 1e-9)
        XCTAssertEqual(t.frame(at: 1 + T.appear).opacity, 1, accuracy: 1e-9)
    }

    func testIdleBreathesGentlyAndSlowly() {
        let t = shown(at: a)
        let low = t.frame(at: 1).glow
        let high = t.frame(at: T.breathPeriod / 2).glow
        XCTAssertGreaterThan(high, low)
        XCTAssertLessThanOrEqual(high, 0.5)
        XCTAssertGreaterThanOrEqual(low, 0.22)
        XCTAssertEqual(t.animationNeed(at: 1), .low, "breathing only needs a low frame rate")
    }

    func testDoneFadesOutThenANewEventBringsItBack() {
        var t = shown(at: a)
        t.receive(.done, at: a, now: 1)
        let mid = t.frame(at: 1 + T.fade / 2)
        XCTAssertTrue(mid.visible)
        XCTAssertLessThan(mid.opacity, 1)
        XCTAssertLessThan(mid.scale, 1)
        XCTAssertFalse(t.frame(at: 1 + T.fade).visible)
        XCTAssertTrue(t.isHidden(at: 1 + T.fade))
        XCTAssertEqual(t.animationNeed(at: 2), .none)
        t.receive(.press, at: b, now: 3)
        XCTAssertEqual(t.frame(at: 3).tip, b, "it reappears where it acts, without travelling from the old spot")
        XCTAssertFalse(t.isHidden(at: 3))
    }

    // MARK: - Moving

    func testAGlideIsCurvedEasedAndLeansIntoMotion() {
        var t = shown(at: a)
        let start = t.receive(.move, at: b, now: 1)
        let duration = CursorTimeline.glideDuration(distance: 300)
        XCTAssertEqual(start, 1)
        XCTAssertEqual(duration, 0.10 + 0.075 * log2(1 + 300.0 / 20), accuracy: 1e-9)
        let mid = t.frame(at: 1 + duration / 2)
        XCTAssertNotEqual(mid.tip.y, 100, accuracy: 0.5, "the path bows: it is not a straight line")
        XCTAssertGreaterThan(mid.tip.x, 100 + 150, "a quick start: past halfway at half time")
        XCTAssertGreaterThan(mid.tilt, 0.02, "leaning right while moving right")
        XCTAssertLessThanOrEqual(mid.tilt, CursorTimeline.Motion.maxTilt)
        let end = t.frame(at: 1 + duration)
        XCTAssertEqual(end.tip, b)
        XCTAssertEqual(end.tilt, 0)
        XCTAssertEqual(t.animationNeed(at: 1 + duration / 2), .full)
    }

    func testGlideDurationsStayCalm() {
        XCTAssertEqual(CursorTimeline.glideDuration(distance: 0), 0)
        XCTAssertEqual(CursorTimeline.glideDuration(distance: 4), 0.14)
        XCTAssertEqual(CursorTimeline.glideDuration(distance: 5000), 0.55)
        XCTAssertLessThan(CursorTimeline.glideDuration(distance: 100), CursorTimeline.glideDuration(distance: 400))
    }

    func testEventsQueueOneAfterAnother() {
        var t = shown(at: a)
        let first = t.receive(.move, at: b, now: 1)
        let second = t.receive(.move, at: a, now: 1)
        XCTAssertEqual(first, 1)
        XCTAssertEqual(second, 1 + CursorTimeline.glideDuration(distance: 300), accuracy: 1e-9)
    }

    func testABurstOfEventsNeverLetsTheCursorTrailFarBehind() {
        var t = shown(at: a)
        for i in 0..<60 {
            t.receive(.press, at: CGPoint(x: 100 + Double(i % 2) * 600, y: 100 + Double(i) * 3), now: 1)
        }
        XCTAssertLessThanOrEqual(t.busyUntil - 1, T.flushLag + 0.8, "catch-up speeds up, then flushes")
        XCTAssertEqual(t.restPosition, CGPoint(x: 700, y: 277))
    }

    // MARK: - Targeting and pressing

    func testTheReticleSettlesOnTheFrameAndGoesAfterTheAction() {
        var t = shown(at: a)
        let button = CGRect(x: 380, y: 80, width: 60, height: 40)
        t.receive(.target(frame: button), at: CGPoint(x: 410, y: 100), now: 1)
        let arrive = 1 + CursorTimeline.glideDuration(distance: 310)
        let settling = t.frame(at: arrive - T.reticleLead + 0.02).reticle
        XCTAssertNotNil(settling)
        XCTAssertGreaterThan(settling!.outset, 1, "it starts outside the frame and closes in")
        let settled = t.frame(at: arrive + 0.3).reticle
        XCTAssertEqual(settled?.rect, button)
        XCTAssertEqual(settled?.outset ?? 1, 0, accuracy: 1e-6)
        XCTAssertEqual(settled?.opacity ?? 0, 1, accuracy: 1e-6)

        let press = t.receive(.press, at: CGPoint(x: 410, y: 100), now: arrive + 0.3)
        XCTAssertNotNil(t.frame(at: press + 0.1).reticle, "still there for the press")
        XCTAssertNil(t.frame(at: press + 0.12 + T.reticleFadeOut + 0.01).reticle, "claimed by the press, then gone")
    }

    func testAnUnclaimedReticleLeavesOnItsOwn() {
        var t = shown(at: a)
        t.receive(.target(frame: CGRect(x: 90, y: 90, width: 20, height: 20)), at: a, now: 1)
        XCTAssertNotNil(t.frame(at: 1.5).reticle)
        XCTAssertNil(t.frame(at: 1 + T.reticleUnclaimed + T.reticleFadeOut + 0.01).reticle)
    }

    func testPressSquashesAndRings() {
        var t = shown(at: a)
        let s = t.receive(.press, at: a, now: 1)
        let down = t.frame(at: s + 0.06)
        XCTAssertLessThan(down.scale, 0.92, "a tiny squash")
        XCTAssertGreaterThan(down.scale, 0.8)
        XCTAssertEqual(down.rings.count, 1)
        XCTAssertEqual(down.rings.first?.style, .click)
        XCTAssertEqual(t.frame(at: s + T.squash + 0.01).scale, 1, accuracy: 1e-9)
        XCTAssertTrue(t.frame(at: s + T.ring + 0.01).rings.isEmpty)
    }

    func testDoubleAndRightClicksLookDifferent() {
        var t = shown(at: a)
        let s = t.receive(.doubleClick, at: a, now: 1)
        let both = t.frame(at: s + T.doubleGap + 0.05)
        XCTAssertEqual(both.rings.map(\.style), [.click, .double])

        var r = shown(at: a)
        let s2 = r.receive(.rightClick, at: a, now: 1)
        let f = r.frame(at: s2 + 0.1)
        XCTAssertEqual(f.rings.map(\.style), [.context])
        XCTAssertEqual(f.badge?.kind, .menu)
    }

    // MARK: - Typing, keys, scrolling, dragging

    func testTypingShowsABlinkingCaret() {
        var t = shown(at: a)
        let s = t.receive(.type, at: a, now: 1)
        let on = t.frame(at: s + 0.2)
        XCTAssertEqual(on.badge?.kind, .caret)
        XCTAssertEqual(on.badge?.animated, true)
        let later = t.frame(at: s + 0.2 + T.caretBlink / 2)
        XCTAssertNotEqual(on.badge?.phase ?? 0 < 0.5, later.badge?.phase ?? 0 < 0.5, "it blinks")
        XCTAssertNil(t.frame(at: s + T.caretBadge + T.badgeFadeOut + 0.01).badge)
    }

    func testKeyCombosAreSpelledLikeMacMenus() {
        var t = shown(at: a)
        let s = t.receive(.key(combo: "cmd+shift+s"), at: a, now: 1)
        XCTAssertEqual(t.frame(at: s + 0.2).badge?.kind, .key("⇧⌘S"))
        XCTAssertEqual(KeyComboLabel.format("return"), "↩")
        XCTAssertEqual(KeyComboLabel.format("ctrl+alt+tab"), "⌃⌥⇥")
        XCTAssertEqual(KeyComboLabel.format("cmd+a"), "⌘A")
    }

    func testScrollingShowsItsDirection() {
        var t = shown(at: a)
        let s = t.receive(.scrollToward(.down), at: a, now: 1)
        XCTAssertEqual(t.frame(at: s + 0.1).badge?.kind, .scroll(.down))
        var u = shown(at: a)
        let s2 = u.receive(.scroll, at: a, now: 1)
        XCTAssertEqual(u.frame(at: s2 + 0.1).badge?.kind, .scroll(nil))
    }

    func testDraggingGripsTravelsTheFaintPathAndDrops() {
        var t = shown(at: a)
        let s = t.receive(.drag(to: b), at: a, now: 1)
        let gripping = t.frame(at: s + 0.05)
        XCTAssertEqual(gripping.badge?.kind, .grip)
        XCTAssertEqual(gripping.path?.from, a)
        XCTAssertEqual(gripping.path?.to, b)
        XCTAssertLessThan(gripping.scale, 1, "held down")
        let duration = max(CursorTimeline.glideDuration(distance: 300) * 1.25, T.dragMin)
        let landed = s + T.dragPress + duration
        XCTAssertEqual(t.frame(at: landed).tip, b)
        XCTAssertEqual(t.frame(at: landed + 0.05).rings.first?.style, .release)
        XCTAssertNil(t.frame(at: landed + T.pathFadeOut + 0.01).path)
    }

    // MARK: - Waiting, refusal, foreground, captions

    func testWaitingSpinsAndALongLabelledWaitEarnsACaption() {
        var t = shown(at: a)
        t.receive(.wait(.begin(label: "Saved")), at: a, now: 1)
        let early = t.frame(at: 1.3)
        XCTAssertEqual(early.badge?.kind, .spinner)
        XCTAssertNil(early.caption, "short waits stay quiet")
        let long = t.frame(at: 1 + T.waitCaptionDelay + 0.3)
        XCTAssertEqual(long.caption?.text, "Waiting for “Saved”")
        XCTAssertNotEqual(t.frame(at: 1.3).badge?.phase, t.frame(at: 1.5).badge?.phase, "it turns")
        t.receive(.wait(.end), at: a, now: 3)
        let closing = t.frame(at: 3 + T.converge / 2)
        XCTAssertGreaterThan(closing.badge?.converge ?? 0, 0)
        XCTAssertNil(t.frame(at: 3 + T.converge + 0.01).badge)
        XCTAssertNil(t.frame(at: 3 + T.captionFade + 0.01).caption)
    }

    func testAShortWaitNeverShowsItsCaption() {
        var t = shown(at: a)
        t.receive(.wait(.begin(label: "Saved")), at: a, now: 1)
        t.receive(.wait(.end), at: a, now: 1.5)
        for k in stride(from: 1.0, to: 4.0, by: 0.1) { XCTAssertNil(t.frame(at: k).caption) }
    }

    func testRefusalIsABriefGentleNo() {
        var t = shown(at: a)
        t.receive(.refused, at: a, now: 1)
        let f = t.frame(at: 1.1)
        XCTAssertEqual(f.refusal, 1)
        XCTAssertNotEqual(f.tip.x, a.x, "a small shake")
        XCTAssertLessThanOrEqual(abs(f.tip.x - a.x), CursorTimeline.Motion.shakeAmplitude)
        XCTAssertEqual(f.badge?.kind, .no)
        XCTAssertEqual(t.frame(at: 1 + T.refusalHold + T.refusalFade + 0.01).refusal, 0)
    }

    func testForegroundSwapsTheArrowForAWarmRingAndSaysSo() {
        var t = shown(at: a)
        t.receive(.foreground(true), at: a, now: 1)
        let f = t.frame(at: 1 + T.foregroundCrossfade + 0.01)
        XCTAssertEqual(f.warmth, 1, accuracy: 1e-9)
        XCTAssertEqual(f.bodyOpacity, 0, accuracy: 1e-9)
        XCTAssertEqual(f.foreground?.center, a)
        XCTAssertEqual(f.caption?.text, "Using your mouse")
        // The real pointer jumps; the ring follows at once.
        let s = t.receive(.press, at: b, now: 2)
        XCTAssertEqual(t.frame(at: s).tip, b)
        t.receive(.foreground(false), at: b, now: 3)
        let back = t.frame(at: 3 + T.foregroundCrossfade + 0.01)
        XCTAssertEqual(back.warmth, 0, accuracy: 1e-9)
        XCTAssertEqual(back.bodyOpacity, 1, accuracy: 1e-9)
    }

    func testACaptionStaysLongEnoughToRead() {
        var t = shown(at: a)
        t.receive(.caption("Clicking “Save”"), at: a, now: 1)
        t.receive(.caption(nil), at: a, now: 1.1)
        XCTAssertEqual(t.frame(at: 2.1).caption?.text, "Clicking “Save”")
        XCTAssertNil(t.frame(at: 1 + T.captionMin + T.captionFade + 0.01).caption)
        XCTAssertEqual(CursorStyle.captionText(String(repeating: "x", count: 80)).count, CursorStyle.captionMaxCharacters)
    }

    func testACaptionNobodyClearsLeavesOnItsOwn() {
        var t = shown(at: a)
        t.receive(.caption("Clicking “Send”"), at: a, now: 1)
        XCTAssertNotNil(t.frame(at: 1 + T.captionAuto - 0.1).caption)
        XCTAssertNil(t.frame(at: 1 + T.captionAuto + T.captionFade + 0.01).caption)
        // A newer caption takes over at once (the old one never lingers underneath).
        t.receive(.caption("Clicking “Delete”"), at: a, now: 5)
        t.receive(.caption("Clicking “Undo”"), at: a, now: 5.2)
        XCTAssertEqual(t.frame(at: 5.5).caption?.text, "Clicking “Undo”")
    }

    // MARK: - Reduce Motion

    func testReduceMotionKeepsEveryStateButDropsTheMovement() {
        var t = shown(at: a, reduceMotion: true)
        let s = t.receive(.move, at: b, now: 1)
        XCTAssertEqual(t.frame(at: s).tip, b, "no travel")
        XCTAssertEqual(t.frame(at: s).tilt, 0)
        let p = t.receive(.press, at: b, now: 2)
        let pressed = t.frame(at: p + 0.06)
        XCTAssertEqual(pressed.scale, 1, "no squash")
        XCTAssertEqual(pressed.rings.first?.radius, 18 * 0.7, "a ring that fades in place")
        t.receive(.refused, at: b, now: 3)
        XCTAssertEqual(t.frame(at: 3.1).tip, b, "no shake")
        XCTAssertEqual(t.frame(at: 3.1).refusal, 1, "the tint still says no")
        t.receive(.wait(.begin(label: nil)), at: b, now: 4)
        XCTAssertEqual(t.frame(at: 4.3).badge?.animated, false)
        XCTAssertEqual(t.frame(at: 4.3).badge?.phase, t.frame(at: 4.6).badge?.phase, "a still spinner")
        t.receive(.wait(.end), at: b, now: 5)
        XCTAssertEqual(t.frame(at: 7).glow, t.frame(at: 8.6).glow, "no breathing")
        XCTAssertEqual(t.animationNeed(at: 8), .none)
    }

    // MARK: - Timing curve and the core mapping

    func testCubicTimingIsMonotonicAndPinned() {
        let c = CursorTimeline.glideEasing
        XCTAssertEqual(c.value(0), 0)
        XCTAssertEqual(c.value(1), 1)
        var last = -1.0
        for i in 0...50 {
            let v = c.value(Double(i) / 50)
            XCTAssertGreaterThanOrEqual(v, last - 1e-9)
            last = v
        }
    }

    func testCoreKindsMapOntoCursorKinds() {
        let r = CGRect(x: 1, y: 2, width: 3, height: 4)
        XCTAssertEqual(CUCursorKind(core: "move"), .move)
        XCTAssertEqual(CUCursorKind(core: "target", frame: r), .target(frame: r))
        XCTAssertNil(CUCursorKind(core: "target"), "a target needs its frame")
        XCTAssertEqual(CUCursorKind(core: "press"), .press)
        XCTAssertEqual(CUCursorKind(core: "press", count: 2), .doubleClick)
        XCTAssertEqual(CUCursorKind(core: "press", button: "right"), .rightClick)
        XCTAssertEqual(CUCursorKind(core: "type"), .type)
        XCTAssertEqual(CUCursorKind(core: "paste"), .type)
        XCTAssertEqual(CUCursorKind(core: "setValue"), .type)
        XCTAssertEqual(CUCursorKind(core: "key", text: "cmd+s"), .key(combo: "cmd+s"))
        XCTAssertEqual(CUCursorKind(core: "scroll"), .scroll)
        XCTAssertEqual(CUCursorKind(core: "scroll", text: "left"), .scrollToward(.left))
        XCTAssertEqual(CUCursorKind(core: "drag", dragTo: CGPoint(x: 5, y: 6)), .drag(to: CGPoint(x: 5, y: 6)))
        XCTAssertEqual(CUCursorKind(core: "waitBegin", text: "Saved"), .wait(.begin(label: "Saved")))
        XCTAssertEqual(CUCursorKind(core: "waitBegin"), .wait(.begin(label: nil)))
        XCTAssertEqual(CUCursorKind(core: "waitEnd"), .wait(.end))
        XCTAssertEqual(CUCursorKind(core: "refused"), .refused)
        XCTAssertEqual(CUCursorKind(core: "foreground", text: "on"), .foreground(true))
        XCTAssertEqual(CUCursorKind(core: "foreground", text: "off"), .foreground(false))
        XCTAssertEqual(CUCursorKind(core: "idle"), .idle)
        XCTAssertEqual(CUCursorKind(core: "done"), .done)
        XCTAssertEqual(CUCursorKind(core: "caption", text: "Clicking “Save”"), .caption("Clicking “Save”"))
        XCTAssertEqual(CUCursorKind(core: "caption"), .caption(nil))
        XCTAssertNil(CUCursorKind(core: "teleport"))
    }
}
