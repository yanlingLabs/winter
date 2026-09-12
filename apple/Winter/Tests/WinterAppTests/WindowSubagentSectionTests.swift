import XCTest
@testable import Winter

/// 2e-ii Task 4: the pure decision behind WindowContentView's subagent section (SwiftUI body
/// isn't unit-tested — same convention as WindowTaskSectionTests). The D9 twin: the 1s tick
/// mounts ONLY while some row is working.
final class WindowSubagentSectionTests: XCTestCase {
    private func item(_ id: String, _ status: String, activeMs: Int = 0, activeSince: Int? = nil) -> SubagentItem {
        SubagentItem(threadId: id, agentType: "general-purpose", label: id, status: status, stopReason: nil, activeMs: activeMs, activeSince: activeSince)
    }

    func testRowsPreserveOrderAndAnyWorking() {
        let r = buildSubagentSection([item("a", "done"), item("b", "working", activeSince: 100), item("c", "queued")])
        XCTAssertEqual(r.rows.map(\.threadId), ["a", "b", "c"])
        XCTAssertTrue(r.anyWorking)
    }

    func testNoWorkingRowMeansNoTick() {
        let r = buildSubagentSection([item("a", "queued"), item("b", "done")])
        XCTAssertFalse(r.anyWorking)
    }

    /// Adapter contract: liveSubagents is EMPTY (section hidden) once every child is done —
    /// mirrors pinnedTasks' "hide when nothing left" rule via anySubagentAlive.
    func testAllDoneHidesBlock() {
        XCTAssertFalse(anySubagentAlive(["done", "done"]))
    }
}
