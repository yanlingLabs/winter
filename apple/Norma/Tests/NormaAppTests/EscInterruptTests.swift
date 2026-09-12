import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// Wave-5 gate item 1 (bug report): the original design (`AppDelegate` wires
/// `OrbWindowController.onEsc: () -> Bool` — `true` = consumed as an interrupt while a turn is
/// running, `false` = let the key fall through to collapse) was alleged to have been severed in
/// the v1 field transplant, with the key monitor calling `collapseToOrb()` directly and never
/// consulting `onEsc`. On inspection `OrbWindowController.expandToField()`'s key monitor already
/// reads exactly right: `if event.keyCode == 53 { if onEsc?() == true { return nil };
/// collapseToOrb(); return nil }`, and `AppDelegate.boot()` already wires `onEsc` to gate on
/// `session.state.turnRunning` and call `interruptTurn()`. No source change was needed — this
/// locks the already-correct contract in with regression coverage, since it previously had none
/// (a future refactor silently reverting either half would otherwise go unnoticed until a live
/// Esc-during-a-turn manual test).
@MainActor
final class EscInterruptTests: XCTestCase {
    func testOnEscReturnsFalseWhenIdle() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        let onEsc = delegate.orbController?.onEsc
        XCTAssertNotNil(onEsc, "AppDelegate must wire onEsc — without it Esc can never interrupt a running turn")
        XCTAssertEqual(onEsc?(), false, "idle session: Esc must fall through to collapse, not claim an interrupt")
    }

    func testOnEscReturnsTrueAndConsumesWhenTurnRunning() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        guard let model = delegate.appModel else {
            return XCTFail("boot() must produce an AppModel even in the degraded (no-token) test path")
        }

        let turnStarted = try! JSONDecoder().decode(
            SessionEvent.self,
            from: Data(#"{"type":"turn_started","seq":1,"sessionId":"s","ts":0,"threadId":"main"}"#.utf8)
        )
        model.session.apply(turnStarted)
        XCTAssertTrue(model.session.state.turnRunning)

        // Consumed as an interrupt (true) — the monitor's `collapseToOrb()` branch must NOT run,
        // so a running turn's Esc keeps the field open (the aborted turn's own turn_completed
        // flips turnRunning, not this key handler).
        XCTAssertEqual(delegate.orbController?.onEsc?(), true)
    }

    // MARK: - Finding-2 (gate 2): field key monitor routes Esc on the SURFACE, not window identity
    // (`escMonitorAction`) — so a re-summon key race that misbinds/unbinds the event's window can't
    // silently drop a valid Esc (wave-9-style window-agnostic acceptance, but for keyDowns).

    func testEscMonitorInterruptsWhenFieldOpenAndTurnRunning() {
        XCTAssertEqual(escMonitorAction(keyCode: 53, surface: .field, escConsumed: { true }), .interrupt)
    }
    func testEscMonitorCollapsesWhenFieldOpenAndIdle() {
        XCTAssertEqual(escMonitorAction(keyCode: 53, surface: .field, escConsumed: { false }), .collapse)
    }
    func testEscMonitorIgnoresEscWhileCollapsed() {
        // A key while the collapsed orb is showing isn't ours — and `onEsc` must not be probed.
        var probed = false
        let action = escMonitorAction(keyCode: 53, surface: .orb, escConsumed: { probed = true; return true })
        XCTAssertEqual(action, .passThrough)
        XCTAssertFalse(probed, "collapsed orb: the interrupt side effect must not fire")
    }
    func testEscMonitorPassesNonEscKeysWithoutProbingOnEsc() {
        var probed = false
        let action = escMonitorAction(keyCode: 36 /* Return */, surface: .field, escConsumed: { probed = true; return true })
        XCTAssertEqual(action, .passThrough)
        XCTAssertFalse(probed, "onEsc()'s interrupt side effect must fire ONLY for Esc, never for other keys")
    }
}
