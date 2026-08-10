import AppKit
import XCTest
@testable import Norma

// Task 5 (pragmatic stabilization): `SurfaceWindowTests` drives the surface-window animation
// driver's real 60Hz timers across a MainActor hop. Under FULL-SUITE contention (626 tests) tight
// `accuracy:` windows and in-flight samples occasionally straddle a frame boundary and flake; in
// isolation the suite almost always passes. This pass widens the tightest windows, bumps
// `pollUntil` timeouts on the flake-observed (zoom / spring-settle) tests, and keeps in-flight
// assertions only where the in-flight value is the actual point of the test — no sleeps added, no
// assertions gutted. The real fix is a fake-clock seam in the animation driver so these tests can
// step deterministically instead of racing the wall clock; that refactor is explicitly deferred.
// See `docs/superpowers/plans/2026-07-09-phase-4d-cleanup.md` (Task 5) for the scoping.
final class SummonToggleTests: XCTestCase {
    func testTapWithWindowOpenClosesIt() {
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: true), .closeWindow)
    }
    func testTapWithoutWindowTogglesField() {
        XCTAssertEqual(summonToggleAction(surface: .orb, windowVisible: false), .toggleField)
        XCTAssertEqual(summonToggleAction(surface: .field, windowVisible: false), .toggleField)
    }
    func testStaleWindowSurfaceWithNoPanelFallsBackToField() {
        // Belt: if surface says .window but the panel is gone, never wedge the summon path.
        XCTAssertEqual(summonToggleAction(surface: .window, windowVisible: false), .toggleField)
    }
}

/// Gate r7 (moved from the deleted ChatWindowControllerTests): the window Esc routing — 53 (Esc)
/// interrupts a running turn (window stays), else collapses; every other key passes through.
final class WindowEscActionTests: XCTestCase {
    func testNonEscPassesThrough() {
        XCTAssertNil(windowEscAction(keyCode: 36) { true })   // Return
        XCTAssertNil(windowEscAction(keyCode: 0) { false })   // 'a'
    }
    func testEscInterruptsWhenTurnRunning() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { true }, .interrupt)
    }
    func testEscClosesWhenIdle() {
        XCTAssertEqual(windowEscAction(keyCode: 53) { false }, .close)
    }
}

/// Gate r7 (ARCHITECTURE PIVOT): the window is a THIRD morph target of the ORB PANEL ITSELF — no
/// separate panel. These drive the real field→window present + window→orb collapse on one panel.
@MainActor
final class SurfaceWindowTests: XCTestCase {
    func testEnterWindowModeOnlyFromField() {
        let controller = OrbWindowController(session: SessionModel())
        controller.enterWindowMode() // surface == .orb → illegal, no-op
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
        XCTAssertNil(controller.morphModel.windowFinalRect)
    }

    func testEnterWindowModeFromWindowIsNoOp() {
        let controller = OrbWindowController(session: SessionModel())
        controller.setSurfaceForTesting(.window)
        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .window)
    }

    /// Full round-trip on ONE panel (consolidated to keep the suite's 60Hz-timer load down): the
    /// field reverse-morphs toward the orb (must NOT flip to `.window` synchronously), the window
    /// presents on the SAME panel (`isVisible` stays true — never ordered out), then collapses back
    /// to the ORB (v1 parity — never to the field) with the window layout cleared.
    func testFieldToWindowRoundTripOnSamePanel() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        // Present leg.
        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .field, "must not flip to .window synchronously — the field morphs back to the orb first")
        XCTAssertEqual(controller.morphModel.renderSurface, .field)

        try await pollUntil(timeout: 5.0) { controller.surface == .window }
        XCTAssertEqual(controller.morphModel.renderSurface, .window, "the window branch must render")
        XCTAssertNotNil(controller.morphModel.windowFinalRect, "layout must be computed at present")
        XCTAssertNotNil(controller.morphModel.windowOrbPoint)
        XCTAssertTrue(controller.isVisible, "the SAME panel stays visible — never ordered out (no separate window)")

        // Collapse leg.
        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 5.0) { controller.surface == .orb }
        XCTAssertEqual(controller.morphModel.renderSurface, .field, "back to the field render branch")
        XCTAssertNil(controller.morphModel.windowFinalRect, "window layout cleared")
        XCTAssertNil(controller.morphModel.windowOrbPoint)
        XCTAssertTrue(controller.isVisible, "the orb panel is still visible after collapse")
        XCTAssertEqual(controller.morphModel.activeWindowSize, controller.morphModel.collapsedWindowSize)

        controller.hide()
    }

    /// A re-summon (`expandToField()`) mid-handoff, before the reverse-morph reaches ≤0.08, cancels
    /// the pending window present — the surface must never reach `.window`.
    func testRetargetDuringHandoffCancelsWindowPresent() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        controller.enterWindowMode()
        XCTAssertEqual(controller.surface, .field)
        // Re-summon immediately — progress is still >0.9, nowhere near 0.08, so the retarget's
        // `pendingWindowExpand = false` always beats the present.
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        XCTAssertEqual(controller.surface, .field, "retarget wins — never presents the window")
        XCTAssertNil(controller.morphModel.windowFinalRect, "present would have set this")

        controller.hide()
    }

    /// `hide()` while the field is mid-handoff cancels the pending window present outright.
    func testHideDuringHandoffCancelsWindowPresent() {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        controller.enterWindowMode() // arms the latch, starts the reverse-morph

        controller.hide()

        XCTAssertEqual(controller.surface, .orb, "hide()'s force-finish always lands on .orb")
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
        XCTAssertNil(controller.morphModel.windowFinalRect)
    }

    /// `hide()` while the WINDOW is open snap-collapses it to the orb, then hides — no orphaned
    /// monitors/mouse-gate behind a hidden panel.
    func testHideWhileWindowOpenCollapsesThenHides() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window }

        controller.hide()
        XCTAssertEqual(controller.surface, .orb)
        XCTAssertFalse(controller.isVisible)
        XCTAssertEqual(controller.morphModel.renderSurface, .field)
    }

    /// Task 5: green zoom toggle is now a spring-animated grow (`zoomTimer`, `morphStep` 140/22 —
    /// same integrator/tuning `morphTick()` uses, own scalar), not the old instant re-present.
    /// Presses the toggle, samples RIGHT AFTER the press to prove the content size hasn't jumped
    /// yet (the first tick hasn't fired — proving this is genuinely animated, not instant), samples
    /// again mid-flight to prove it's actually moving, then polls to settle and checks
    /// `windowFinalRect` landed exactly at the computed zoom target (lockstep with the mouse gate's
    /// own read of that field). Finally restores and checks it settles back at the default content
    /// size — the "grows then restores" contract the old instant test covered, preserved here.
    func testZoomToggleAnimatesToTargetAndSettles() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 10.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 10.0) { controller.surface == .window }
        // Let the window's own 0→1 morph fully settle (`morphTimer == nil`) — zoom no-ops mid-morph.
        try await pollUntil(timeout: 10.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        XCTAssertEqual(controller.morphModel.windowFinalRect?.size, chatWindowDefaultSize, "resting at the default content size before any zoom")

        controller.zoomToggleWindow()
        XCTAssertTrue(controller.windowZoomed, "first press flips the target immediately")
        XCTAssertFalse(controller.isZoomIdleForTesting, "a zoom spring is now driving the content size")
        let widthRightAfterPress = try XCTUnwrap(controller.morphModel.windowFinalRect).size.width
        // Task 5 (pragmatic stabilization): in-flight sample — this IS the point of the test (proving
        // the grow is genuinely animated, not an instant re-present), so it's kept rather than swapped
        // to a settled-state assertion. Widened 0.5→2 per the scoping: still off-by-orders-of-magnitude
        // regression-catching for a broken spring, but tolerant of a full-suite-contention frame straddle.
        XCTAssertEqual(
            widthRightAfterPress, chatWindowDefaultSize.width, accuracy: 2.0,
            "must NOT have jumped to the target instantly — the very first 60Hz tick hasn't fired yet"
        )

        // Sample an intermediate frame — proves this is a genuine animation, not an instant re-present.
        try await pollUntil(timeout: 10.0) { controller.zoomProgressForTesting > 0.15 }
        let midWidth = try XCTUnwrap(controller.morphModel.windowFinalRect).size.width
        XCTAssertGreaterThan(midWidth, chatWindowDefaultSize.width + 5, "already growing past the default content size mid-flight")

        // Settle at the zoom target — windowFinalRect stays in lockstep the whole way (the mouse
        // gate reads it every tick).
        try await pollUntil(timeout: 10.0) { controller.isZoomIdleForTesting }
        XCTAssertTrue(controller.windowZoomed)
        let screen = try XCTUnwrap(NSScreen.main).visibleFrame
        let inset = controller.morphModel.haloPadding + chatWindowZoomInset
        let expected = CGSize(
            width: max(chatWindowDefaultSize.width, screen.width - 2 * inset),
            height: max(chatWindowDefaultSize.height, screen.height - 2 * inset)
        )
        let finalRect = try XCTUnwrap(controller.morphModel.windowFinalRect, "windowFinalRect must stay live at settle")
        // Task 5 (pragmatic stabilization): widened 1→3 per the scoping — a broken zoom target would be
        // off by orders of magnitude, so this stays regression-catching while tolerating a straddled frame.
        XCTAssertEqual(finalRect.size.width, expected.width, accuracy: 3.0, "settled exactly at the zoom target")
        XCTAssertEqual(finalRect.size.height, expected.height, accuracy: 3.0)

        // Restore leg — second press retargets back down and settles at the default size again.
        controller.zoomToggleWindow()
        XCTAssertFalse(controller.windowZoomed, "second press restores")
        try await pollUntil(timeout: 10.0) { controller.isZoomIdleForTesting }
        XCTAssertEqual(controller.morphModel.windowFinalRect?.size, chatWindowDefaultSize, "settles back at the default content size")

        controller.hide()
    }

    /// Task 5: a re-press WHILE the zoom is still animating RETARGETS — flips `zoomTarget` back
    /// and keeps whatever velocity the spring already has (the same morph retarget idiom
    /// `expandToField()`'s mid-collapse re-summon uses on `morphTarget`) — rather than snapping,
    /// queuing, or crashing. Must settle cleanly back at the default content size.
    func testZoomRetargetsMidFlight() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 10.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 10.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        controller.zoomToggleWindow()
        XCTAssertTrue(controller.windowZoomed, "first press zooms")
        try await pollUntil(timeout: 10.0) { controller.zoomProgressForTesting > 0.2 }
        XCTAssertFalse(controller.isZoomIdleForTesting, "still animating toward the zoom target")

        // Retarget mid-flight — same zoom timer keeps running, just heading the other way now.
        controller.zoomToggleWindow()
        XCTAssertFalse(controller.windowZoomed, "second press retargets back toward the default size")

        try await pollUntil(timeout: 10.0) { controller.isZoomIdleForTesting }
        XCTAssertFalse(controller.windowZoomed)
        XCTAssertEqual(
            controller.morphModel.windowFinalRect?.size, chatWindowDefaultSize,
            "settles cleanly back at the default content size, not stuck at some in-between state"
        )

        controller.hide()
    }

    /// Task 5 interplay: `collapseWindowToOrb()` mid-zoom must cancel the zoom timer SYNCHRONOUSLY
    /// (not merely once the collapse itself later settles) — no stray 60Hz zoom timer left ticking
    /// behind a collapsing/collapsed window.
    func testCollapseDuringZoomCancelsZoomTimer() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 10.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 10.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        controller.zoomToggleWindow()
        XCTAssertFalse(controller.isZoomIdleForTesting, "zoom spring is running")

        controller.collapseWindowToOrb()
        XCTAssertTrue(controller.isZoomIdleForTesting, "collapse cancels the zoom timer immediately, synchronously")

        try await pollUntil(timeout: 10.0) { controller.surface == .orb }
        XCTAssertTrue(controller.isMorphIdleForTesting, "settles at the orb")
        XCTAssertTrue(controller.isZoomIdleForTesting, "no stray zoom timer survives the collapse")
        XCTAssertFalse(controller.windowZoomed, "reset on collapse")

        controller.hide()
    }

    /// Gate r8 (v1 follow-collapse parity): DURING a window collapse, the panel already rides
    /// toward the live cursor each tick — it must NOT stay frozen at the locked open anchor until
    /// settle (that was the r7 "stationary collapse" conscious simplification this fixes). Drives
    /// the collapse with `glassAnchorOverrideForTesting` set (the real cursor tracker reads the live
    /// OS mouse position, which this suite can't deterministically move) and samples the panel
    /// MID-collapse (surface still `.window`, progress not yet settled) to assert it has already
    /// converged toward the overridden anchor.
    func testWindowCollapseRidesTowardChangedCursorMidCollapse() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 8.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        let screen = try XCTUnwrap(NSScreen.main).visibleFrame
        let openFrame = controller.panelFrameForTesting
        let openOrbPoint = try XCTUnwrap(controller.morphModel.windowOrbPoint)
        let openAnchor = CGPoint(x: openFrame.minX + openOrbPoint.x, y: openFrame.maxY - openOrbPoint.y)
        // Derived from the OPEN ANCHOR, never from a fixed screen point. The open anchor tracks the
        // live OS mouse position (this suite cannot move it), so a fixed target lands arbitrarily
        // close to it depending on where the user's cursor happens to rest, which would make the
        // mid-collapse convergence this test asserts indistinguishable from never having moved at
        // all. Offset toward whichever half of the screen has room, same derivation as the settle
        // test below.
        let dx: CGFloat = openAnchor.x < screen.midX ? 240 : -240
        let dy: CGFloat = openAnchor.y < screen.midY ? 160 : -160
        let target = CGPoint(x: openAnchor.x + dx, y: openAnchor.y + dy)
        controller.glassAnchorOverrideForTesting = target

        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting < 0.9 }
        XCTAssertEqual(controller.surface, .window, "still mid-collapse, not settled yet")
        // FINAL-REVIEW FIX: deliberately NO panel-frame-origin assertion here. For an anchor
        // INTERIOR to the padded content frame, `windowFrame = paddedContentFrame.union(orbFrame)`
        // is the content frame both before and after the ride — the panel origin legitimately
        // never moves. The ride's real contract is that the SHELL's orb anchor (`windowOrbPoint`
        // resolved against the frame) converges on the fenced cursor mid-collapse, asserted below
        // against the deterministic override. (The removed assertion was also machine-dependent:
        // the open anchor derives from the live mouse position at present time.)

        let orbPoint = try XCTUnwrap(controller.morphModel.windowOrbPoint, "must stay live mid-collapse")
        let frame = controller.panelFrameForTesting
        let midAnchor = CGPoint(x: frame.minX + orbPoint.x, y: frame.maxY - orbPoint.y)
        let expected = fenceAnchorForWindowCollapse(
            target, orbBubbleSize: controller.morphModel.orbBubbleSize,
            haloPadding: controller.morphModel.haloPadding, visibleFrame: screen
        )
        // Task 5 (pragmatic stabilization): in-flight sample — this IS the point of the test (the
        // whole contract under test is the ride's convergence MID-collapse), so it's kept rather than
        // swapped to a settled-state assertion. Widened 1→3 per the scoping.
        XCTAssertEqual(midAnchor.x, expected.x, accuracy: 3.0, "the shell's orb end must already be converging on the cursor mid-collapse")
        XCTAssertEqual(midAnchor.y, expected.y, accuracy: 3.0)

        try await pollUntil(timeout: 8.0) { controller.surface == .orb }
        controller.hide()
    }

    /// Gate r8 regression: once the collapse SETTLES, the orb lands at (near) wherever the ride
    /// converged to — NOT the stale locked-open anchor the r7 "stationary collapse" simplification
    /// used to melt to before the follower sprang it the rest of the way. `currentGlassAnchorForTesting`
    /// reads the settled orb's own composer-corner anchor (mapped through `collapsedWindowSize`).
    func testWindowCollapseSettlesAtRiddenAnchorNotStaleOpenAnchor() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 8.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        let screen = try XCTUnwrap(NSScreen.main).visibleFrame
        let openFrame = controller.panelFrameForTesting
        let openOrbPoint = try XCTUnwrap(controller.morphModel.windowOrbPoint)
        let openAnchor = CGPoint(x: openFrame.minX + openOrbPoint.x, y: openFrame.maxY - openOrbPoint.y)

        // Derived from the OPEN ANCHOR, never from a fixed screen point. The open anchor tracks the
        // live OS mouse position (this suite cannot move it), so a fixed target lands arbitrarily
        // close to it depending on where the user's cursor happens to rest — and BOTH ">50pt" guards
        // below then fail for a reason that has nothing to do with the regression under test. This
        // branch paid for that three times. Offset toward whichever half of the screen has room, far
        // enough that `fenceAnchorForWindowCollapse` cannot pull it back inside 50pt.
        let dx: CGFloat = openAnchor.x < screen.midX ? 240 : -240
        let dy: CGFloat = openAnchor.y < screen.midY ? 160 : -160
        let target = CGPoint(x: openAnchor.x + dx, y: openAnchor.y + dy)
        XCTAssertGreaterThan(
            hypot(target.x - openAnchor.x, target.y - openAnchor.y), 50,
            "the test target must actually differ from the open anchor for this regression to mean anything"
        )
        controller.glassAnchorOverrideForTesting = target

        controller.collapseWindowToOrb()
        try await pollUntil(timeout: 8.0) { controller.surface == .orb }

        let settledAnchor = controller.currentGlassAnchorForTesting
        let expected = fenceAnchorForWindowCollapse(
            target, orbBubbleSize: controller.morphModel.orbBubbleSize,
            haloPadding: controller.morphModel.haloPadding, visibleFrame: screen
        )
        // Task 5 (pragmatic stabilization, strengthened after an observed full-suite failure): the
        // settle path derives this anchor through a DIFFERENT formula (`currentGlassAnchor()`'s
        // corner-mapped panel frame) than the live mid-collapse ride does, and the window's own morph
        // progress isn't guaranteed to land at EXACTLY 1.0 before `isMorphIdleForTesting` flips (an
        // underdamped spring settling within a velocity/distance epsilon, not a bug) — the residual is
        // `(1 − settled_progress) × travel_distance`, which swings with scheduling load: one observed
        // full-suite run stayed under the original 2.0 window, another hit ~7.0. A first widen to 10.0
        // only banked a ~3px margin over the worst OBSERVED case, not the worst plausible one, so this
        // goes to 20.0 — still 2.5x tighter than the "must have actually moved" 50pt check below, so a
        // genuinely broken anchor calculation still fails loudly, while comfortably covering a heavier
        // contention spike than the one this session happened to see.
        XCTAssertEqual(settledAnchor.x, expected.x, accuracy: 20.0, "the settled orb must land where the ride converged, not the stale open anchor")
        XCTAssertEqual(settledAnchor.y, expected.y, accuracy: 20.0)
        XCTAssertGreaterThan(
            hypot(settledAnchor.x - openAnchor.x, settledAnchor.y - openAnchor.y), 50,
            "must have actually moved away from the stale open anchor, not melted in place"
        )

        controller.hide()
    }

    /// Task 4: the yellow traffic light — `requestWindowDetach()` fires `onWindowDetach` exactly
    /// once, then runs the no-animation exit back to the orb (surface flips to `.orb`, the panel
    /// stays visible/on-screen at `collapsedWindowSize` — never ordered out). A second call, now
    /// that `surface` is `.orb`, is a no-op.
    ///
    /// LIVE-GATE W1a: the fired frame is the visible glass CONTENT rect (`windowFinalRect` mapped
    /// to screen coords, `windowSurfaceContentScreenRect`), NOT the raw panel frame — the panel
    /// frame spans content + the invisible halo padding + the orb-anchor union
    /// (`windowSurfaceLayout`'s doc), so firing with it verbatim used to spawn the detached window
    /// visibly bigger than the morph window it replaced. The fired frame must therefore be
    /// STRICTLY SMALLER than (and fully contained within) the panel's own frame at the moment of
    /// detach.
    func testRequestWindowDetachFiresOnceWithContentFrameAndExitsToOrb() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }
        controller.enterWindowMode()
        try await pollUntil(timeout: 5.0) { controller.surface == .window && controller.isMorphIdleForTesting }

        var firedFrames: [NSRect] = []
        controller.onWindowDetach = { frame in
            firedFrames.append(frame)
            return true // spawn "succeeded" — the exit must run
        }

        let panelFrame = controller.panelFrameForTesting
        let finalRect = try XCTUnwrap(controller.morphModel.windowFinalRect, "layout must be live while .window")
        let expectedContentFrame = windowSurfaceContentScreenRect(panelFrame: panelFrame, finalRect: finalRect)
        controller.requestWindowDetach()

        XCTAssertEqual(firedFrames.count, 1, "onWindowDetach must fire exactly once")
        XCTAssertEqual(firedFrames.first, expectedContentFrame, "must fire with the visible CONTENT rect, not the panel frame")
        XCTAssertTrue(panelFrame.contains(firedFrames.first!), "the content rect must be fully inside the panel frame")
        XCTAssertLessThan(firedFrames.first!.width, panelFrame.width, "content is smaller than the halo-padded panel — the W1a fix")
        XCTAssertLessThan(firedFrames.first!.height, panelFrame.height, "content is smaller than the halo-padded panel — the W1a fix")
        XCTAssertEqual(controller.surface, .orb, "exitWindowModeForDetach() collapses the panel's surface back to .orb")
        XCTAssertTrue(controller.isVisible, "the orb panel stays on screen — never ordered out on detach")
        XCTAssertEqual(controller.panelFrameForTesting.size, controller.morphModel.collapsedWindowSize)

        controller.requestWindowDetach() // second call — surface is now .orb, must no-op
        XCTAssertEqual(firedFrames.count, 1, "no second fire")

        controller.hide()
    }

    /// I1 fix (review): a spawn failure (`onWindowDetach` returns `false` — e.g. AppDelegate had no
    /// focused session, or a missing daemon token) must NOT run the exit-to-orb — the window
    /// surface's content would otherwise vanish into the orb with nothing spawned to replace it.
    /// Also proves the re-entrancy latch (`detachInFlight`) clears on the failure path: a second,
    /// true-returning request right after still succeeds instead of silently no-oping forever.
    ///
    /// Deliberately uses `setSurfaceForTesting(.window)` (like `testEnterWindowModeFromWindowIsNoOp`
    /// above) instead of driving a real `expandToField()`/`enterWindowMode()` morph — this test is
    /// only exercising `requestWindowDetach()`'s boolean-gated exit branch, which needs no spring
    /// running at all (`morphTimer == nil` is the guard's resting state), so it stays instant and
    /// immune to the wall-clock jitter a real morph round-trip would add to the suite for no benefit
    /// here — the round-trip itself is already covered by
    /// `testRequestWindowDetachFiresOnceWithCurrentFrameAndExitsToOrb` above.
    func testDetachSpawnFailureKeepsWindowSurface() {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.setSurfaceForTesting(.window)

        controller.onWindowDetach = { _ in false } // spawn failed — nothing to hand the surface off to
        let windowFrame = controller.panelFrameForTesting
        controller.requestWindowDetach()

        XCTAssertEqual(controller.surface, .window, "a failed spawn must leave the window surface untouched")
        XCTAssertTrue(controller.isVisible, "the panel stays exactly as it was")
        XCTAssertEqual(controller.panelFrameForTesting, windowFrame, "no teardown/resize ran on a failed spawn")

        // The latch must have cleared despite the false return — a later successful spawn works.
        controller.onWindowDetach = { _ in true }
        controller.requestWindowDetach()

        XCTAssertEqual(controller.surface, .orb, "a subsequent successful spawn now exits normally")
        XCTAssertEqual(controller.panelFrameForTesting.size, controller.morphModel.collapsedWindowSize)

        controller.hide()
    }

    /// Task 4/5: `requestWindowDetach()` must never fire mid-handoff (field→window collapse still
    /// in flight, `pendingWindowExpand` armed, surface still `.field`), mid-morph (a spring is
    /// still actively driving the panel — the window's own opening 0→1 present, asserted right
    /// after the surface flip), or mid-zoom (Task 5's `zoomTimer`, its own separate guard term,
    /// asserted once the window has settled and a zoom is pressed).
    func testDetachGuardedDuringMorphAndZoom() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        try await pollUntil(timeout: 5.0) { controller.morphProgressForTesting > 0.9 }

        var fireCount = 0
        controller.onWindowDetach = { _ in
            fireCount += 1
            return true
        }

        // Mid-handoff: pendingWindowExpand armed, reverse-morph running, surface still .field.
        controller.enterWindowMode()
        controller.requestWindowDetach()
        XCTAssertEqual(fireCount, 0, "mid-handoff must no-op")
        XCTAssertEqual(controller.surface, .field, "must not have presented the window yet")

        try await pollUntil(timeout: 5.0) { controller.surface == .window }
        // The window's own present spring (0→1) is still running the instant surface flips.
        XCTAssertFalse(controller.isMorphIdleForTesting, "the present morph must still be running right after the flip")
        controller.requestWindowDetach()
        XCTAssertEqual(fireCount, 0, "mid-morph must no-op")
        XCTAssertEqual(controller.surface, .window, "must still be .window — the guard, not a completed detach, blocked it")

        try await pollUntil(timeout: 10.0) { controller.isMorphIdleForTesting }

        // Task 5: mid-ZOOM (a separate guard term, `zoomTimer == nil`) must also no-op — a detach
        // must never fire while the green zoom spring is still animating the content size.
        controller.zoomToggleWindow()
        XCTAssertFalse(controller.isZoomIdleForTesting, "zoom spring must be running")
        controller.requestWindowDetach()
        XCTAssertEqual(fireCount, 0, "mid-zoom must no-op")
        XCTAssertEqual(controller.surface, .window, "must still be .window — the guard blocked it, not a completed detach")

        try await pollUntil(timeout: 10.0) { controller.isZoomIdleForTesting }
        controller.hide()
    }

    /// Same polling helper as `MorphTimerReentrancyTests`/`MorphRetargetTests` — the 60Hz morph
    /// timer's settle time isn't deterministic under test-host scheduling load.
    /// FAILS LOUDLY on timeout, deliberately. It used to return quietly, which is why an
    /// intermittent flake in this class has three times presented as a *cascade* of five downstream
    /// state mismatches (`("orb") is not equal to ("window")`) rather than the one fact that
    /// actually happened: the morph never settled inside the deadline. Three separate reviewers
    /// spent effort re-deriving that from the cascade, and once it was nearly misattributed to an
    /// unrelated app-entry-point change. Same red either way — this one is diagnosable.
    private func pollUntil(
        timeout: TimeInterval,
        interval: TimeInterval = 0.02,
        _ message: @autoclosure () -> String = "condition never became true",
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        if !condition() {
            XCTFail("pollUntil timed out after \(timeout)s — \(message())", file: file, line: line)
        }
    }
}
