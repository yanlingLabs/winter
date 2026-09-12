import XCTest
@testable import Winter

/// LIVE-GATE G4: `FieldStateAdapter.pinnedTasks` derivation — the CC-parity pinned-todo widget
/// `WindowSurfaceView` renders below the transcript. Same idiom as `FluidStateTests`: drive
/// `SessionModel.applyForTesting` directly, no event decoding needed.
@MainActor
final class PinnedTasksTests: XCTestCase {
    func testEmptyWhenNoTasks() {
        let a = FieldStateAdapter(session: SessionModel())
        XCTAssertEqual(a.pinnedTasks, [])
    }

    func testEmptyWhenAllTasksCompleted() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        session.applyForTesting { s in
            s.tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                       TaskItem(id: "2", subject: "b", status: "completed")]
        }
        XCTAssertEqual(a.pinnedTasks, [], "an all-completed batch must not stay pinned")
    }

    func testFullListWhenAnyTaskIncomplete() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        let tasks = [TaskItem(id: "1", subject: "a", status: "completed"),
                     TaskItem(id: "2", subject: "b", status: "in_progress"),
                     TaskItem(id: "3", subject: "c", status: "pending")]
        session.applyForTesting { s in s.tasks = tasks }
        XCTAssertEqual(a.pinnedTasks, tasks, "the WHOLE list pins, not just the incomplete ones")
    }

    func testPinnedEvenWithSingleInProgressTask() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        let tasks = [TaskItem(id: "1", subject: "a", status: "in_progress")]
        session.applyForTesting { s in s.tasks = tasks }
        XCTAssertEqual(a.pinnedTasks, tasks)
    }
}
