import XCTest
@testable import Winter

/// Regression coverage for review finding I1: `expandToField()` used to guard on
/// `surface == .orb` only, so a re-summon that arrived mid-collapse (`surface` is still
/// `.field` until the morph settles at 0) was silently dropped — a ~200-400ms dead window
/// where tapping the summon shortcut did nothing. v1 handled this as a "retarget": the
/// collapse's implicit completion (gated on `morphTarget == 0` read fresh at settle time,
/// see `OrbWindowController.morphTick()`) is defused simply by flipping `morphTarget` to 1
/// before the spring settles — no teardown ever runs, and the field reopens continuously
/// from wherever the collapse had gotten to.
@MainActor
final class MorphRetargetTests: XCTestCase {
    func testReExpandDuringCollapseRetargetsWithoutTeardown() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        XCTAssertEqual(controller.surface, .field)

        // Let the expand morph make real progress before reversing it. Timeout bumped
        // 2.0s → 8.0s (hardening — chronic flake under real machine load, reproduced without
        // any artificial stress on this box): the 60Hz timer hops each tick through
        // `Task { @MainActor in self?.morphTick() }`, and morphStep()'s dt clamp caps how much
        // SIMULATED time each tick advances (<=1/20s) regardless of how much real wall-clock
        // time actually elapsed since the last tick — so when that hop is delayed under
        // scheduler contention, wall-clock settle time can badly outpace isolation-run timing
        // even though nothing is actually stuck. Still condition-based, not a fixed sleep: a
        // healthy run returns the instant the condition holds, so this costs nothing when
        // unloaded, and a genuinely reintroduced hang still times out and fails.
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.3 }

        controller.collapseToOrb()
        // IMMEDIATELY re-summon mid-collapse (the dead-window bug: v1 parity requires this
        // to retarget rather than be dropped). Deliberately NOT gated on a settle poll — the
        // whole point of this regression is that the re-summon lands WHILE the collapse is
        // still in flight, so waiting here would defeat the test.
        controller.toggleField()

        // Poll for settle instead of a fixed sleep — the 60Hz morph timer's exact settle
        // time depends on the test host's scheduling, and a fixed sleep either flakes under
        // load or wastes wall-clock time padding for the worst case.
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.9 }

        XCTAssertEqual(controller.surface, .field, "re-expand during collapse was dropped or torn down")
        // `>` (not `>=`) is deliberate, not a boundary to loosen: this spring is tuned to
        // OVERSHOOT progress above 1 on an expand (see `morphStep`'s doc — "deliberately
        // underdamped so an expand overshoots progress slightly above 1"), so once it's
        // actually ticking (not starved) it blows straight past 0.9 within a handful of 16ms
        // ticks — there is no legitimate steady state that lands AT exactly 0.9. The generous
        // poll timeout above is what buys robustness against scheduler jitter here; a value
        // observed stuck at e.g. 0.879 means the poll starved, not that 0.9 is the wrong bar.
        XCTAssertGreaterThan(controller.morphProgressForTesting, 0.9, "morph did not return to expanded")

        controller.hide()
    }

    /// Polls `condition` on the main actor until it's true or `timeout` elapses, sleeping
    /// briefly between checks. Used instead of a fixed `Task.sleep` for timing-sensitive
    /// assertions against the 60Hz `Timer`-driven morph spring, which is not deterministic
    /// under test-host scheduling load.
    private func pollUntil(
        timeout: TimeInterval,
        interval: TimeInterval = 0.02,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    }
}
