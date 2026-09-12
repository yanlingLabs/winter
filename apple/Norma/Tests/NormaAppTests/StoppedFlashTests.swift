import XCTest
@testable import Winter

/// Final-review IMPORTANT-1 fix: `FieldStateAdapter.showStoppedFlash` used to be cleared ONLY by
/// its own 2s `DispatchWorkItem` — if the user Esc'd (triggering the flash) then resubmitted
/// within that 2s window, the new turn's `turnRunning == true` state rendered "⏹ stopped" + the
/// slate fluid tint over what is actually a live, working orb (false status). The fix: the
/// `session.$state` sink's `turnRunning` branch now force-clears the flash (and cancels its
/// pending auto-clear timer) the instant a fresh turn starts.
@MainActor
final class StoppedFlashTests: XCTestCase {
    func testFlashClearsImmediatelyWhenTurnRunningBecomesTrueBeforeTimeout() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)

        session.applyForTesting { s in s.turnRunning = true }
        // Esc-interrupt: turn ends, lastTurnAborted flips false→true — triggers the flash.
        session.applyForTesting { s in
            s.turnRunning = false
            s.lastTurnAborted = true
        }
        XCTAssertTrue(adapter.showStoppedFlash, "an Esc-interrupt must trigger the transient stopped flash")

        // Resubmit within the 2s window: a fresh turn_started-driven turnRunning=true (mirroring
        // the reducer's own silent turnStarted clear of lastTurnAborted) must clear the flash
        // IMMEDIATELY — not leave it stuck for however much of the 2s auto-clear timer remains.
        session.applyForTesting { s in
            s.turnRunning = true
            s.lastTurnAborted = false
        }
        XCTAssertFalse(adapter.showStoppedFlash, "resubmitting mid-flash must clear it right away, not render 'stopped' + slate tint over a live working orb")
    }

    func testFlashSurvivesUnrelatedStateChangesWhileTurnStaysStopped() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)

        session.applyForTesting { s in s.turnRunning = true }
        session.applyForTesting { s in
            s.turnRunning = false
            s.lastTurnAborted = true
        }
        XCTAssertTrue(adapter.showStoppedFlash)

        // A state change that does NOT flip turnRunning true (still idle/stopped) must leave the
        // flash alone — only an actual new turn should force-clear it early.
        session.applyForTesting { s in s.streamingText = "unrelated" }
        XCTAssertTrue(adapter.showStoppedFlash, "unrelated state changes while still stopped must not clear the flash early")
    }

    func testFlashClearingOnTurnRunningIsIdempotentWhenNeverShown() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)

        // No prior abort/flash at all — a plain turn start must simply not crash/misbehave, and
        // showStoppedFlash must remain false.
        session.applyForTesting { s in s.turnRunning = true }
        XCTAssertFalse(adapter.showStoppedFlash)
    }
}
