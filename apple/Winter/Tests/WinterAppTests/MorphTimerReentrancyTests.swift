import XCTest
@testable import Winter

/// Gate-fix regression (Esc-interrupt live-gate finding): `OrbWindowController`'s 60Hz morph
/// timer schedules each tick via `Task { @MainActor in self?.morphTick() }` rather than running
/// synchronously. Reproduced live during this gate's repro session (rapid, overlapping
/// summon/collapse triggers backed up the main actor): once free, SEVEN queued `Task` closures
/// all ran in a burst, and — with no re-entry guard — each one independently re-satisfied
/// `morphTick()`'s settle condition and redundantly re-ran the entire teardown branch, calling
/// `finishCollapse()` seven times for a single collapse (confirmed via `OrbDebug` logging; see
/// the gate report).
///
/// This locks in the fix: a stale/duplicate tick that fires after the real settle (i.e. after
/// `cancelMorphTimer()` has already nilled `morphTimer` out) must be a no-op.
@MainActor
final class MorphTimerReentrancyTests: XCTestCase {
    func testStaleMorphTickAfterSettleDoesNotRerunFinishCollapse() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        // Timeout bumped 2.0s → 8.0s (hardening — chronic flake under real machine load,
        // reproduced without any artificial stress on this box: both polls below timed out
        // completely, landing finishCollapseCallCountForTesting at 0). Root cause: the 60Hz
        // timer hops each tick through `Task { @MainActor in self?.morphTick() }` (see
        // morphTick()'s re-entry-guard doc), and morphStep()/springStep() cap how much
        // SIMULATED time each tick advances (dt clamps to <=1/20s) regardless of how much real
        // wall-clock time actually elapsed since the last tick — so when the main-actor hop is
        // delayed under scheduler contention, wall-clock settle time can badly outpace
        // isolation-run timing even though nothing is actually stuck. Still condition-based, not
        // a fixed sleep: a healthy run returns the instant it settles, so this costs nothing
        // when unloaded, and a genuinely reintroduced hang (the regression this test pins) still
        // times out and fails.
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.9 }

        controller.collapseToOrb()
        try await pollUntil(timeout: 8.0) { controller.surface == .orb }
        // Deterministic setup before the exact-count assertions below mean anything: if the
        // collapse hasn't actually settled (a starved poll), finishCollapseCallCountForTesting
        // would legitimately still be 0 — that's starvation, not the regression this test pins —
        // so fail loudly and specifically HERE instead of letting a confusing "0 not 1" stand in
        // for "never settled".
        XCTAssertEqual(
            controller.surface, .orb,
            "collapse must fully settle (running finishCollapse() once) before counting stale-tick reruns"
        )
        XCTAssertEqual(controller.finishCollapseCallCountForTesting, 1, "the real settle must run finishCollapse() exactly once")

        // Simulate the backlogged-Task scenario directly: the real timer already invalidated
        // itself (morphTimer == nil) by the time these fire, exactly like the queued closures
        // that arrived after the burst in the live repro.
        controller.morphTick()
        controller.morphTick()
        controller.morphTick()

        XCTAssertEqual(
            controller.finishCollapseCallCountForTesting, 1,
            "a stale tick after settle must not re-run finishCollapse() — it silently repeats the collapse teardown otherwise"
        )

        controller.hide()
    }

    /// Finding-2 (gate 2): a re-summon must RE-ASSERT the panel's key focus — the fix for the
    /// makeKey-vs-late-external-`restore()` race that left the panel non-key and its local Esc
    /// monitor silent (see `makePanelKeyWinningLateActivation`'s doc). Drives expand → collapse →
    /// re-expand and asserts the key-assertion pass fired again on the re-expand. (Actually
    /// acquiring key-window status needs a live WindowServer session, which the headless test host
    /// may not grant — so this asserts the defensive re-assert HAPPENS, not that key was granted.)
    func testResummonReassertsKeyFocus() async throws {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        controller.expandToField()
        XCTAssertGreaterThanOrEqual(controller.keyAssertionCountForTesting, 1, "first summon must assert panel key")
        // Timeout bumped 2.0s → 8.0s — see testStaleMorphTickAfterSettleDoesNotRerunFinishCollapse's
        // doc for why the real wall-clock settle time isn't bounded by the spring's own per-tick
        // simulated-time clamp under scheduler contention.
        try await pollUntil(timeout: 8.0) { controller.morphProgressForTesting > 0.9 }

        controller.collapseToOrb()
        try await pollUntil(timeout: 8.0) { controller.surface == .orb }
        // Must actually be settled before re-summoning: `expandToField()` branches on `surface`
        // — `.orb` takes the cold path (a SYNCHRONOUS key re-assert, what this test pins), while
        // `.field` (an unsettled collapse) takes the mid-collapse RETARGET path, whose key
        // re-assert is deliberately deferred to `DispatchQueue.main.async` (see
        // `expandToField()`'s doc — an inline reassert there would perturb the morph spring).
        // Racing this poll's timeout would silently swap in the wrong code path and fail the
        // counter assertion below for an unrelated reason (a confusing "4 not > 4" — the
        // deferred async increment simply hadn't run yet — instead of a clear "collapse never
        // settled").
        XCTAssertEqual(
            controller.surface, .orb,
            "collapse must fully settle before re-summoning, so expandToField() takes the cold (synchronous key-reassert) path this test exercises"
        )

        // Captured synchronously immediately before the re-summon; the cold-path expand's own
        // synchronous key-assertion pass must push the counter past it (no await interleaves).
        let before = controller.keyAssertionCountForTesting
        controller.expandToField()
        XCTAssertGreaterThan(
            controller.keyAssertionCountForTesting, before,
            "a re-summon must re-assert key focus to win the late external-activation race"
        )

        controller.hide()
    }

    /// Same polling helper as `MorphRetargetTests` — the 60Hz morph timer's settle time isn't
    /// deterministic under test-host scheduling load, so poll instead of a fixed sleep.
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
