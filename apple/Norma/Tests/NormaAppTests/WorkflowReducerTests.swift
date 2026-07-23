import XCTest
@testable import Norma
import NormaProtocol

/// CC-parity phase 3 (Workflows), Track D Task D3: the reducer's `state.workflowRuns:
/// [String: WorkflowRunState]` — folded from `workflow_started`/`workflow_progress`/
/// `workflow_completed`/`workflow_failed` (Task D1's 4 `SessionEvent` variants, mirrored into
/// NormaProtocol; Task D2 added the separate `workflow.list`/`run`/`stop`/`get` NormaKit RPCs this
/// fold is NOT about — this suite only covers the LIVE event stream). Sibling suite to
/// `ChildSessionReducerTests` (that one covers `child_update` folding into `state.children`), same
/// `ev`/`reduce` idiom — feed raw wire JSON through `SessionReducer.reduce` and assert on the
/// resulting `OrbSessionState`, no `SessionModel`/`NormaClient` involved.
final class WorkflowReducerTests: XCTestCase {
    private func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    private func reduce(_ s: OrbSessionState, _ jsons: [String]) -> OrbSessionState {
        jsons.reduce(s) { SessionReducer.reduce($0, ev($1)) }
    }
    private func started(runId: String, name: String? = nil, summary: String = "starting", seq: Int = 1) -> String {
        let nameField = name.map { "\"\($0)\"" } ?? "null"
        return #"{"type":"workflow_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","runId":"\#(runId)","name":\#(nameField),"summary":"\#(summary)"}"#
    }
    private func progress(runId: String, phase: String? = nil, log: String? = nil, running: Int, completed: Int, total: Int, seq: Int = 2) -> String {
        let phaseField = phase.map { "\"\($0)\"" } ?? "null"
        let logField = log.map { "\"\($0)\"" } ?? "null"
        return #"{"type":"workflow_progress","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","runId":"\#(runId)","phase":\#(phaseField),"log":\#(logField),"running":\#(running),"completed":\#(completed),"total":\#(total)}"#
    }
    private func completed(runId: String, resultSummary: String = "done", seq: Int = 3) -> String {
        #"{"type":"workflow_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","runId":"\#(runId)","resultSummary":"\#(resultSummary)"}"#
    }
    private func failed(runId: String, error: String = "boom", seq: Int = 3) -> String {
        #"{"type":"workflow_failed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","runId":"\#(runId)","error":"\#(error)"}"#
    }

    /// The brief's Step-1 test, verbatim: `workflow_started` → `workflow_progress(running:3,
    /// completed:17,total:20)` → `workflow_completed` yields a run whose FINAL state is completed
    /// with counts totaling 20.
    func testStartedProgressCompletedYieldsCompletedRunWithFinalCounts() {
        let s = reduce(OrbSessionState(), [
            started(runId: "r1", name: "nightly-sweep"),
            progress(runId: "r1", phase: "sweeping", running: 3, completed: 17, total: 20),
            completed(runId: "r1"),
        ])
        XCTAssertEqual(s.workflowRuns["r1"]?.status, "completed")
        XCTAssertEqual(s.workflowRuns["r1"]?.total, 20)
        XCTAssertEqual(s.workflowRuns["r1"]?.completed, 17)
        XCTAssertEqual(s.workflowRuns["r1"]?.running, 3)
    }

    func testWorkflowStartedSeedsARunningEntry() {
        let s = reduce(OrbSessionState(), [started(runId: "r1", name: "nightly-sweep")])
        XCTAssertEqual(s.workflowRuns["r1"]?.status, "running")
        XCTAssertEqual(s.workflowRuns["r1"]?.name, "nightly-sweep")
        XCTAssertEqual(s.workflowRuns["r1"]?.total, 0)
    }

    func testWorkflowFailedSetsErrorAndStatusButKeepsLastSeenCounts() {
        let s = reduce(OrbSessionState(), [
            started(runId: "r1"),
            progress(runId: "r1", running: 1, completed: 0, total: 2),
            failed(runId: "r1", error: "agent crashed"),
        ])
        XCTAssertEqual(s.workflowRuns["r1"]?.status, "failed")
        XCTAssertEqual(s.workflowRuns["r1"]?.error, "agent crashed")
        XCTAssertEqual(s.workflowRuns["r1"]?.total, 2, "failure must not erase the last progress counts")
    }

    func testMultipleRunsAreTrackedIndependently() {
        let s = reduce(OrbSessionState(), [
            started(runId: "r1", seq: 1),
            started(runId: "r2", seq: 2),
            progress(runId: "r1", running: 1, completed: 0, total: 5, seq: 3),
        ])
        XCTAssertEqual(s.workflowRuns.count, 2)
        XCTAssertEqual(s.workflowRuns["r1"]?.total, 5)
        XCTAssertEqual(s.workflowRuns["r2"]?.total, 0)
    }

    /// See `WorkflowProgress`'s own doc (SessionEvent.swift): "a progress tick may carry only
    /// updated counts" — a tick that omits `phase`/`log` (both null on the wire) must not blank out
    /// the last-seen values an EARLIER tick already set.
    func testProgressTickPreservesPhaseAndLogWhenALaterTickOmitsThem() {
        let s = reduce(OrbSessionState(), [
            started(runId: "r1"),
            progress(runId: "r1", phase: "phase one", log: "log line", running: 1, completed: 0, total: 3, seq: 2),
            progress(runId: "r1", running: 2, completed: 1, total: 3, seq: 3), // no phase/log this tick
        ])
        XCTAssertEqual(s.workflowRuns["r1"]?.phase, "phase one")
        XCTAssertEqual(s.workflowRuns["r1"]?.log, "log line")
        XCTAssertEqual(s.workflowRuns["r1"]?.completed, 1)
        XCTAssertEqual(s.workflowRuns["r1"]?.running, 2)
    }

    /// Defensive/replay-safety: a progress tick for a runId with no prior `_started` (e.g. the
    /// client attached mid-stream, after `_started` already scrolled off) still lands rather than
    /// being silently dropped — same "upsert, never require a prior insert" posture as
    /// `child_update`'s own reducer case.
    func testProgressWithNoPriorStartedSynthesizesAnEntry() {
        let s = reduce(OrbSessionState(), [progress(runId: "r1", running: 1, completed: 1, total: 4)])
        XCTAssertEqual(s.workflowRuns["r1"]?.total, 4)
    }
}
