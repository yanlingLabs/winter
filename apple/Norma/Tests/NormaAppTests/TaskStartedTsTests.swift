import XCTest
import WinterProtocol
import WinterKit
@testable import Winter

/// Task 2 (2e-i): `TaskItem.activeForm`/`startedTs` — the reducer carries `activeForm` straight
/// off the wire and stamps `startedTs` with `event.ts` the moment a task FIRST enters
/// `in_progress`, never resetting it on a repeated in_progress update. Drives the pure reducer
/// directly, mirroring `SessionModelTests`'/`ActivityCaptureTests`' local `ev(_:)` idiom.
final class TaskStartedTsTests: XCTestCase {
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    /// `activeForm` is only embedded in the JSON when non-nil, so tests can exercise the
    /// "field absent" wire shape too (decodes to `nil`, same as any other optional).
    func taskUpdated(
        id: String, subject: String, status: String, ts: Int, activeForm: String? = nil, seq: Int = 1
    ) -> SessionEvent {
        let activeFormField = activeForm.map { #","activeForm":"\#($0)""# } ?? ""
        return ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":\#(ts),"threadId":"main","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"\#(activeFormField)}}"#)
    }

    func testActiveFormCarried() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", ts: 100, activeForm: "Running tests"))
        XCTAssertEqual(s.tasks.first?.activeForm, "Running tests")
    }

    func testStartedTsSetOnEnteringInProgress() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "pending", ts: 100))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", ts: 500))
        XCTAssertEqual(s.tasks.first?.startedTs, 500)
    }

    func testStartedTsNotResetOnRepeatInProgress() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", ts: 500))
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", ts: 900))
        XCTAssertEqual(s.tasks.first?.startedTs, 500)
    }

    func testStartedTsUnsetForPending() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "pending", ts: 100))
        XCTAssertNil(s.tasks.first?.startedTs)

        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "Do Y", status: "in_progress", ts: 200))
        s = SessionReducer.reduce(s, taskUpdated(id: "2", subject: "Do Y", status: "completed", ts: 300))
        // completed preserves the startedTs it earned while in_progress — but a task that NEVER
        // entered in_progress (id "1" above) must stay nil, which is what this test asserts.
        XCTAssertNil(s.tasks.first(where: { $0.id == "1" })?.startedTs)
    }
}
