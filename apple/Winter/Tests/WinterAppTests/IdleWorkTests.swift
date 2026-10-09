import XCTest
import SwiftUI
import AppKit
import Combine
import WinterKit
import WinterCUPresentation
@testable import Winter

/// A Winter that has nothing to do must do nothing: no frame drawn for an animation that no longer changes, no timer
/// firing faster than a second. Measured on a live idle Winter Dev (Debug build) before these fixes: ~21,000 thread
/// wake-ups a second, 25% CPU, a main thread spending a fifth of its samples in the display cycle — and the only view
/// animating was the orb's liquid, ticking at the display's rate for an unread reply, beside a 30 Hz mouse-gate clock,
/// a 2 s menu refresh that asked `SMAppService` over XPC, a 2 s TCC preflight and a 4 Hz watchdog.
/// (Debug builds inflate SwiftUI's CPU; the wake-up count is behavioural, and is what these pin.)
@MainActor
final class IdleWorkTests: XCTestCase {
    // MARK: - The orb's liquid

    func testAnUnreadRepliesLiquidTicksAtTwentyFramesASecondNotTheDisplaysRate() {
        XCTAssertEqual(fluidTickInterval(state: .unread(level: 0.5), actionNeeded: false), 1.0 / 20.0)
        XCTAssertNil(fluidTickInterval(state: .working(level: 0.5), actionNeeded: false), "a working turn follows the display")
        XCTAssertNil(fluidTickInterval(state: .unread(level: 0.5), actionNeeded: true), "and so does a card waiting on the human")
        XCTAssertNil(fluidTickInterval(state: .idle, actionNeeded: false))
    }

    func testAnUnreadRepliesLiquidRestsAfterItHasBreathed() {
        let unread = FluidState.unread(level: 0.5)
        XCTAssertFalse(shouldRestUnreadBreath(state: unread, breathedFor: 0, actionNeeded: false))
        XCTAssertFalse(shouldRestUnreadBreath(state: unread, breathedFor: fluidUnreadBreathSeconds - 0.1, actionNeeded: false))
        XCTAssertTrue(shouldRestUnreadBreath(state: unread, breathedFor: fluidUnreadBreathSeconds, actionNeeded: false))
        XCTAssertFalse(shouldRestUnreadBreath(state: unread, breathedFor: 3_600, actionNeeded: true), "never while the human is wanted")
        XCTAssertFalse(shouldRestUnreadBreath(state: .working(level: 0.5), breathedFor: 3_600, actionNeeded: false), "a working turn never rests")
        XCTAssertFalse(shouldRestUnreadBreath(state: .idle, breathedFor: 3_600, actionNeeded: false))
        XCTAssertLessThanOrEqual(fluidUnreadBreathSeconds, 15, "a few breaths, not minutes")
    }

    // MARK: - The clocks

    func testNoClockTheAppOwnsTicksFasterThanASecondWhenNothingIsHappening() {
        XCTAssertGreaterThanOrEqual(HangWatchdog.pingInterval, 1, "the hang watchdog")
        XCTAssertGreaterThanOrEqual(PeripheralProvider.tccPollInterval, 5, "the TCC preflight")
        XCTAssertGreaterThanOrEqual(DispatchPillController.gateIdleInterval, 1, "the mouse gate, once the pointer is still")
        XCTAssertEqual(DispatchPillController.gatePace(stillFor: 0), DispatchPillController.gateTickInterval, "…and fast only while the pointer moves")
        XCTAssertEqual(DispatchPillController.gatePace(stillFor: DispatchPillController.gateStillAfter), DispatchPillController.gateIdleInterval)
        XCTAssertEqual(DispatchPillController.gatePace(stillFor: 60), DispatchPillController.gateIdleInterval)
    }

    // MARK: - The orb in a hosting view

    /// Counts how often an unread orb's sim steps over `seconds`, then over `more` further seconds.
    private func orbSteps(breathSeconds: TimeInterval, seconds: Double, more: Double) async throws -> (first: Int, further: Int) {
        let fluid = FluidModel()
        var steps = 0
        let watch = fluid.$sim.dropFirst().sink { _ in steps += 1 }
        let host = NSHostingView(rootView: FluidOrbSlot(fluid: fluid, state: .unread(level: 0.5), isStoppedFlash: false,
                                                        isHeld: false, actionNeeded: false, breathSeconds: breathSeconds)
            .frame(width: 60, height: 60))
        host.frame = NSRect(x: 0, y: 0, width: 60, height: 60)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        let first = steps
        try await Task.sleep(nanoseconds: UInt64(more * 1_000_000_000))
        withExtendedLifetime((watch, window)) {}
        return (first, steps - first)
    }

    /// The real view in a hosting view: an unread orb ticks for its breath — at the unread cadence, never the display's
    /// — and then stops. The control beside it, an orb that is never allowed to rest, keeps ticking, which is what
    /// shows the harness can see a tick at all.
    func testAnUnreadOrbTicksForItsBreathAndThenStopsTicking() async throws {
        let control = try await orbSteps(breathSeconds: 1e9, seconds: 1.0, more: 1.0)
        print("IDLE orb that never rests: \(control.first) steps in the first second, \(control.further) in the next")
        try XCTSkipIf(control.first == 0, "a hosting view in an unshown window does not run its animation schedule here")
        XCTAssertGreaterThan(control.further, 5, "an orb that never rests keeps ticking")

        let resting = try await orbSteps(breathSeconds: 0.6, seconds: 1.5, more: 1.5)
        print("IDLE orb that rests after 0.6 s: \(resting.first) steps in 1.5 s, \(resting.further) in the next 1.5 s")
        XCTAssertGreaterThan(resting.first, 0, "it breathed")
        XCTAssertLessThanOrEqual(resting.first, 25, "at 20 fps for well under a second, not at the display's rate")
        XCTAssertEqual(resting.further, 0, "and nothing at all once it has rested")
    }

    // MARK: - The whole idle scene

    /// Counts the main run loop's trips to sleep: a thread with nothing to draw and nothing to fire makes almost none.
    private final class RunLoopTrips {
        private(set) var count = 0
        private var observer: CFRunLoopObserver?
        init() {
            observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { [unowned self] _, _ in self.count += 1 }
            CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        }
        deinit { if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) } }
    }

    /// The scene the live measurement was taken in: a mirror up with a bound target, an unread reply's orb, a turn that
    /// ended. Once the orb has rested, hosted in real views, nothing animates: the sim stops stepping and the main run
    /// loop makes next to no trips — where it made a trip per display frame (and the orb alone stepped 120 times a
    /// second) before. The trip count is compared with this process's own baseline, since the test host is never silent.
    func testWithAMirrorUpAndATurnEndedNothingAnimatesOnceTheOrbHasRested() async throws {
        let baselineTrips = RunLoopTrips()
        try await Task.sleep(nanoseconds: 1_000_000_000)
        let baseline = baselineTrips.count

        // A mirror with a bound target and a frame on show, and no cursor event (a cursor that has rested is the
        // presentation package's own test: its timeline pauses five seconds after its last event).
        let mirror = CUMirrorModel()
        let state = MirrorSessionState(sessionId: "s_idle", sink: mirror)
        state.seed([HelperTarget(targetId: "t1", pid: 1, windowId: 2, appName: "Notes", bundleId: "com.apple.Notes", windowSize: CGSize(width: 800, height: 600))])
        let mirrorHost = NSHostingView(rootView: CUMirrorView(model: mirror).frame(width: 320, height: 240))
        mirrorHost.frame = NSRect(x: 0, y: 0, width: 320, height: 240)

        // The unread reply's orb, in the pill's field.
        let fluid = FluidModel()
        var steps = 0
        let watch = fluid.$sim.dropFirst().sink { _ in steps += 1 }
        let orbHost = NSHostingView(rootView: FluidOrbSlot(fluid: fluid, state: .unread(level: 0.5), isStoppedFlash: false, isHeld: false,
                                                           actionNeeded: false, breathSeconds: 0.4).frame(width: 60, height: 60))
        orbHost.frame = NSRect(x: 0, y: 0, width: 60, height: 60)

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: true)
        let container = NSView(frame: window.contentRect(forFrameRect: window.frame))
        container.addSubview(mirrorHost)
        orbHost.setFrameOrigin(NSPoint(x: 330, y: 0))
        container.addSubview(orbHost)
        window.contentView = container
        container.layoutSubtreeIfNeeded()

        try await Task.sleep(nanoseconds: 1_500_000_000) // the orb breathes for 0.4 s and rests; the mirror's first frame lands
        XCTAssertTrue(state.isVisible, "the mirror is up with its bound target")
        let restedAt = steps
        let trips = RunLoopTrips()
        try await Task.sleep(nanoseconds: 2_000_000_000)
        print("IDLE scene: \(trips.count) run loop trips in 2 s (baseline \(baseline) in 1 s), orb steps while idle: \(steps - restedAt)")
        XCTAssertEqual(steps, restedAt, "the orb does not step once it has rested")
        XCTAssertLessThanOrEqual(trips.count, baseline * 2 + 20, "no per-frame work: \(trips.count) trips in two seconds against a baseline of \(baseline) in one")
        withExtendedLifetime((watch, window, mirror, state)) {}
    }
}
