import XCTest
@testable import Winter

/// Dispatch (Phase 7), Task 8: `FieldStateAdapter.dispatchChildren`/`onOpenChild` — the field's
/// top-row child-status circles' data source + click action. Same idiom as `PinnedTasksTests`:
/// drive `SessionModel.applyForTesting` directly, no event decoding needed (the reducer's own
/// upsert/prune behavior is already covered by `ChildSessionReducerTests`).
@MainActor
final class DispatchChildrenAdapterTests: XCTestCase {
    func testEmptyWhenNoChildren() {
        let a = FieldStateAdapter(session: SessionModel())
        XCTAssertEqual(a.dispatchChildren, [])
    }

    func testDispatchChildrenIsAStraightPassthrough() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        let children = [
            ChildItem(sessionId: "c1", title: "explore auth", status: "working"),
            ChildItem(sessionId: "c2", title: "fix bug", status: "awaiting_approval"),
        ]
        session.applyForTesting { s in s.children = children }
        XCTAssertEqual(a.dispatchChildren, children)
    }

    /// UNLIKE `liveSubagents` (which filters an all-done batch to empty), a child session's own
    /// lifecycle is independent of any single turn — the reducer prunes finished children only on
    /// the NEXT main `turn_started` (see `OrbSessionState.children`'s doc), so a completed child
    /// still visible in `session.state.children` must still surface here, not get a second filter.
    func testCompletedChildStillSurfacesUntilReducerPrunesIt() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        let child = ChildItem(sessionId: "c1", title: "done child", status: "completed")
        session.applyForTesting { s in s.children = [child] }
        XCTAssertEqual(a.dispatchChildren, [child])
    }

    /// Task 9 review carry-over: the visible-cap WinterFieldView's ForEach consumes (hoisted out of
    /// an inline `.prefix(5)` into this testable seam — see FieldStateAdapter.visibleDispatchChildren).
    /// 7 tracked children → only the first 5 are visible, in `dispatchChildren`'s own order.
    func testVisibleDispatchChildrenCapsAtFiveInOrder() {
        let session = SessionModel()
        let a = FieldStateAdapter(session: session)
        let children = (1...7).map { ChildItem(sessionId: "c\($0)", title: "child \($0)", status: "running") }
        session.applyForTesting { s in s.children = children }
        XCTAssertEqual(FieldStateAdapter.maxVisibleDispatchChildren, 5)
        XCTAssertEqual(a.visibleDispatchChildren, Array(children.prefix(5)))
        XCTAssertEqual(a.visibleDispatchChildren.map(\.sessionId), ["c1", "c2", "c3", "c4", "c5"])
    }

    func testOnOpenChildDefaultsToNoOpWithoutCrashing() {
        let a = FieldStateAdapter(session: SessionModel())
        a.onOpenChild("c1") // must not crash — default no-op (previews/unwired adapters)
    }

    func testOnOpenChildFiresWithTheTappedSessionId() {
        let a = FieldStateAdapter(session: SessionModel())
        var opened: String?
        a.onOpenChild = { sessionId in opened = sessionId }
        a.onOpenChild("s_child_1")
        XCTAssertEqual(opened, "s_child_1")
    }
}
