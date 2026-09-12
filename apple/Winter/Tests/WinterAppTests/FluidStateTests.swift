import XCTest
@testable import Winter

@MainActor
final class FluidStateTests: XCTestCase {
    func testIdleWhenNothingHappens() {
        let a = FieldStateAdapter(session: SessionModel())
        XCTAssertEqual(a.fluidState, .idle)
    }
    func testWorkingHalfFullWithoutTasks() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in s.turnRunning = true }
        XCTAssertEqual(a.fluidState, .working(level: 0.5))
    }
    func testWorkingLevelTracksTasks() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress"),
                       TaskItem(id: "3", subject: "c", status: "pending"),
                       TaskItem(id: "4", subject: "d", status: "pending")]
        }
        XCTAssertEqual(a.fluidState, .working(level: 0.25))
    }
    func testUnreadHoldsLastWorkingLevel() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        _ = a.fluidState // observe working(1.0)
        session.applyForTesting { s in s.turnRunning = false }
        a.hasUnread = true
        XCTAssertEqual(a.fluidState, .unread(level: 1.0))
    }
    // Finding-3 (gate 2): the fluid represents the WORK, not just the turn.
    func testHoldsWorkingWhenTurnEndedButTasksIncomplete() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress"),
                       TaskItem(id: "3", subject: "c", status: "pending"),
                       TaskItem(id: "4", subject: "d", status: "pending")]
        }
        _ = a.fluidState // observe working(0.25)
        // Turn ends but work remains (only 1 of 4 completed): HOLD, don't drain.
        session.applyForTesting { s in s.turnRunning = false }
        XCTAssertEqual(a.fluidState, .working(level: 0.25))
    }
    func testDrainsWhenTurnEndedAndAllTasksComplete() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        _ = a.fluidState // observe working(1.0)
        // Turn ends with every task complete: drain to idle.
        session.applyForTesting { s in s.turnRunning = false }
        XCTAssertEqual(a.fluidState, .idle)
    }
    func testUnreadHoldsFinalLevelEvenWithoutInterveningReads() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress")]
        }
        // NO fluidState read here — then the burst: all-complete + turn end in quick succession
        session.applyForTesting { s in
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        session.applyForTesting { s in s.turnRunning = false }
        a.hasUnread = true
        XCTAssertEqual(a.fluidState, .unread(level: 1.0))
    }

    // MARK: - Final-review Important-2 (D9 settled-tick freeze): `isHoldingWork`

    func testIsHoldingWorkTrueOnlyWhenTurnEndedWithIncompleteTasks() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "in_progress")]
        }
        XCTAssertFalse(a.isHoldingWork, "must be false while the turn is actively running")
        session.applyForTesting { s in s.turnRunning = false }
        XCTAssertTrue(a.isHoldingWork, "must be true once the turn ends with work remaining")
    }

    func testIsHoldingWorkFalseWhenUnread() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.turnRunning = true
            s.tasks = [TaskItem(id: "1", subject: "a", status: "in_progress")]
        }
        session.applyForTesting { s in s.turnRunning = false }
        XCTAssertTrue(a.isHoldingWork)
        a.hasUnread = true
        XCTAssertFalse(a.isHoldingWork, "unread must win outright — its own synthetic breathing must never freeze")
    }

    func testIsHoldingWorkFalseWhenTrulyIdle() {
        let a = FieldStateAdapter(session: SessionModel())
        XCTAssertFalse(a.isHoldingWork)
    }
}
