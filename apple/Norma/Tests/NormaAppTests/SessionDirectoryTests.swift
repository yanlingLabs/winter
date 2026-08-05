import XCTest
import NormaProtocol
@testable import Norma

/// Stub `lister` — a mutable box test cases swap the returned rows on, mirroring the
/// scripted-transport doubles' mutable-state convention used elsewhere in this test target
/// (`AppScriptedTransport`/`FeedScriptedTransport`), just for `SessionDirectory`'s own
/// injected dependency instead of a socket.
final class StubSessionLister {
    var rows: [SessionSummary] = []
    var delayNanoseconds: UInt64 = 0
    private(set) var callCount = 0

    func list() async throws -> [SessionSummary] {
        callCount += 1
        if delayNanoseconds > 0 { try await Task.sleep(nanoseconds: delayNanoseconds) }
        return rows
    }
}

/// app-shell Task 2: a `sleepTick` the test fully controls — adapted from `PairingSheetModelTests`'
/// `ManualTickSource` (NormaKit; not reusable across modules, it's `private` there). `wait()`
/// genuinely suspends (no busy-spin, no real 5s sleep) until the test calls `tick()`;
/// `AsyncStream`'s default unbounded buffering makes this order-safe even if `tick()` lands before
/// the poll loop has reached its own `wait()`.
private actor ManualTickSource {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private var iterator: AsyncStream<Void>.AsyncIterator?

    init() {
        var cont: AsyncStream<Void>.Continuation!
        stream = AsyncStream { cont = $0 }
        continuation = cont
    }

    func tick() { continuation.yield(()) }

    func wait() async {
        var current = iterator ?? stream.makeAsyncIterator()
        _ = await current.next()
        iterator = current
    }
}

@MainActor
func waitUntilDirectory(_ timeout: TimeInterval = 3, _ cond: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !cond() && Date() < deadline {
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}

@MainActor
final class SessionDirectoryTests: XCTestCase {
    // Event factory — same convention as SessionModelTests.ev: wire-shaped JSON decoded through
    // SessionEvent's real Codable conformance (its memberwise inits aren't public).
    func ev(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }
    func sessionCreated(sessionId: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"session_created","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"scope":"global"}"#)
    }
    func sessionTitled(sessionId: String, title: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"session_titled","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"threadId":"main","title":"\#(title)"}"#)
    }
    /// Dispatch (Phase 7): a mirrored child-lifecycle update landing in the dispatch session's
    /// own stream.
    func childUpdate(sessionId: String, childSessionId: String, status: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"child_update","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"threadId":"main","childSessionId":"\#(childSessionId)","status":"\#(status)","title":"child","resultSummary":null}"#)
    }
    /// app-shell Task 2: session-activity-hygiene's TRANSIENT lifecycle broadcast
    /// (`SessionActivityEvent`, protocol/src/events.ts). `seq` defaults to 1 like the other
    /// factories above, but every dedupe-trap test below passes it explicitly — the whole point of
    /// this event is that its `seq` is the store's CURRENT `lastSeq` at broadcast time, not a fresh
    /// one of its own, so it routinely arrives at or below whatever seq a client has already seen.
    func sessionActivity(sessionId: String, activity: String, seq: Int = 1) -> SessionEvent {
        ev(#"{"type":"session_activity","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"activity":"\#(activity)"}"#)
    }

    func testRefreshSortsRowsNewestFirst() async {
        let stub = StubSessionLister()
        stub.rows = [
            SessionSummary(sessionId: "old", title: nil, createdAt: 1, scope: "global", cwd: nil),
            SessionSummary(sessionId: "newest", title: nil, createdAt: 3, scope: "global", cwd: nil),
            SessionSummary(sessionId: "mid", title: nil, createdAt: 2, scope: "global", cwd: nil),
        ]
        let directory = SessionDirectory(lister: stub.list)
        XCTAssertTrue(directory.rows.isEmpty, "no rows before the first refresh")

        await directory.refresh()
        XCTAssertEqual(directory.rows.map(\.sessionId), ["newest", "mid", "old"])
    }

    func testRefreshKeepsOldRowsOnListerError() async {
        struct ListerFailure: Error {}
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertEqual(directory.rows.count, 1)

        let failingDirectory = SessionDirectory(lister: { throw ListerFailure() })
        // Seed via the working stub first is irrelevant here — this proves a THROWING lister simply
        // leaves whatever rows already existed (empty, in this fresh instance) rather than crashing
        // or clearing state unexpectedly.
        await failingDirectory.refresh()
        XCTAssertTrue(failingDirectory.rows.isEmpty)
    }

    func testHandleSessionCreatedKicksARefresh() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        directory.handle(sessionCreated(sessionId: "s1"))

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s1")
    }

    /// Dispatch (Phase 7), Task 7 step 3(a): `child_update` kicks a refresh exactly like
    /// `session_created` above — a new child (or a status change on an existing one) must show up
    /// in the directory without waiting on an unrelated broadcast.
    func testHandleChildUpdateKicksARefresh() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        stub.rows = [
            SessionSummary(sessionId: "dispatch1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "child1", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: nil, parentSessionId: "dispatch1"),
        ]
        directory.handle(childUpdate(sessionId: "dispatch1", childSessionId: "child1", status: "working"))

        await waitUntilDirectory { directory.rows.count == 2 }
        XCTAssertEqual(Set(directory.rows.map(\.sessionId)), ["dispatch1", "child1"])
    }

    func testHandleSessionTitledKicksARefresh() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertNil(directory.rows.first?.title)

        stub.rows = [SessionSummary(sessionId: "s1", title: "server title", createdAt: 1, scope: "global", cwd: nil)]
        directory.handle(sessionTitled(sessionId: "s1", title: "server title"))

        await waitUntilDirectory { directory.rows.first?.title == "server title" }
        XCTAssertEqual(directory.rows.first?.title, "server title")
    }

    /// The titled event must patch the KNOWN row's title in place, SYNCHRONOUSLY inside `handle` —
    /// not merely as a side effect of the refresh() round trip it also kicks off. Proven with a
    /// deliberately slow lister: the assertion runs immediately after `handle` returns, before the
    /// kicked-off `Task { await refresh() }` could possibly have completed.
    func testHandleSessionTitledPatchesInPlaceBeforeRefreshCompletes() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh() // fast seed
        XCTAssertNil(directory.rows.first?.title)

        stub.delayNanoseconds = 2_000_000_000 // any refresh kicked off below hangs well past this test
        directory.handle(sessionTitled(sessionId: "s1", title: "fresh title"))

        XCTAssertEqual(directory.rows.first?.title, "fresh title",
                        "title patch must be synchronous, not wait on the refresh round-trip")
    }

    /// FINAL-REVIEW FIX (M1): `startInitialLoad()` is the exact method `AppModel.init` and
    /// `DetachedWindowController.init` call right after constructing their own `directory` (see
    /// those files' "FINAL-REVIEW FIX (M1)" comments) instead of inlining a bare
    /// `Task { await refresh() }` at each call site — pinning ITS contract here (exactly one lister
    /// call, rows populated from empty) means this test goes red if `startInitialLoad()`'s body is
    /// ever gutted back to a no-op, the same regression the finding calls out ("SessionDirectory
    /// never does its INITIAL load").
    func testStartInitialLoadKicksExactlyOneRefresh() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: "hi", createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        XCTAssertTrue(directory.rows.isEmpty, "no rows before the initial load")

        directory.startInitialLoad()

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s1")
        try? await Task.sleep(nanoseconds: 150_000_000) // settle: prove it doesn't double-fire
        XCTAssertEqual(stub.callCount, 1, "startInitialLoad must kick exactly one lister call")
    }

    func testHandleSessionTitledForUnknownRowStillKicksRefresh() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        // A titled event for a row this directory hasn't seen yet (e.g. arrived before its own
        // session_created broadcast) must not crash — just fall through to the refresh kick.
        stub.rows = [SessionSummary(sessionId: "s9", title: "server title", createdAt: 5, scope: "global", cwd: nil)]
        directory.handle(sessionTitled(sessionId: "s9", title: "server title"))

        await waitUntilDirectory { directory.rows.count == 1 }
        XCTAssertEqual(directory.rows.first?.sessionId, "s9")
    }

    // MARK: - app-shell Task 2: `.sessionActivity` — derive, never seq-dedupe

    /// THE dedupe-trap fixture (task brief, verbatim requirement): `session_activity` is stamped
    /// with the store's CURRENT `lastSeq` at broadcast time — not a fresh seq of its own — so it
    /// routinely arrives AT the exact seq of an event this directory has already applied, or even
    /// BELOW it (`TRANSIENT_EVENT_TYPES`' own doc comment, protocol/src/events.ts). A fold that
    /// (wrongly) gated the patch on a seq comparison — `guard v.seq > someCursor else { return }` —
    /// would silently drop every one of these forever. `SessionDirectory` holds no seq cursor at
    /// all for exactly this reason: `handle`'s `.sessionActivity` case must apply unconditionally.
    func testSessionActivityUpdatesTheRowEvenWhenStampedAtTheHeadSeq() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: "hi", createdAt: 1, scope: "global", cwd: nil, mode: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertNil(directory.rows.first?.activity, "no activity until the daemon says otherwise")

        // A prior real (persisted) event this directory has already applied at seq 10 — the "head"
        // a naive seq-deduping fold would compare a later transient against.
        directory.handle(sessionTitled(sessionId: "s1", title: "still hi", seq: 10))

        // The transient arrives STAMPED AT THAT EXACT HEAD SEQ — the documented shape. A
        // seq-deduping fold would treat `10 <= 10` as "already seen" and drop this on the floor.
        directory.handle(sessionActivity(sessionId: "s1", activity: "background", seq: 10))
        XCTAssertEqual(directory.rows.first?.activity, "background",
                       "a transient stamped at the head seq must still update the row — DERIVE, never seq-dedupe")

        // Even a transient stamped BELOW the head must still apply — proves this is never a
        // comparison against anything, not merely a `>=` vs `>` off-by-one.
        directory.handle(sessionActivity(sessionId: "s1", activity: "idle", seq: 3))
        XCTAssertEqual(directory.rows.first?.activity, "idle",
                       "a transient stamped BELOW the head must still update the row")
    }

    /// `handle` patches the matching row SYNCHRONOUSLY and does NOT kick a `refresh()` — activity
    /// is the daemon's own derived read-time state, and `session.list` would answer the exact same
    /// string this event already carries, so a follow-up round trip buys nothing (same "no refresh
    /// needed" posture the titled-patch test proves via a synchronous assertion, just proven here
    /// via `callCount` staying put instead).
    func testSessionActivityPatchesWithoutKickingARefresh() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertEqual(stub.callCount, 1, "the seed refresh above")

        directory.handle(sessionActivity(sessionId: "s1", activity: "active", seq: 5))
        XCTAssertEqual(directory.rows.first?.activity, "active")
        try? await Task.sleep(nanoseconds: 150_000_000) // settle: prove no follow-up refresh fires
        XCTAssertEqual(stub.callCount, 1, "activity is derived straight off the payload, no round trip")
    }

    /// An id this directory doesn't know about (arrived before the initial `refresh()` populated
    /// `rows`, or for a session this window never listed) must be silently ignored — never a crash,
    /// and never a synthesized row from a payload that carries only `sessionId`/`activity`.
    func testSessionActivityForUnknownSessionIsIgnoredWithoutCrashing() async {
        let stub = StubSessionLister()
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertTrue(directory.rows.isEmpty)

        directory.handle(sessionActivity(sessionId: "ghost", activity: "active", seq: 1))

        XCTAssertTrue(directory.rows.isEmpty, "no crash, no synthesized row for an unknown session id")
    }

    // MARK: - app-shell Task 2: the visible-gated poll

    /// `setPolling(active: true)` starts a loop that waits one `sleepTick` then `refresh()`es,
    /// repeating for as long as it stays active — pinned via a fully test-controlled tick source so
    /// nothing here waits on a real 5s sleep.
    func testPollingActiveRefreshesOnEachTick() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let ticker = ManualTickSource()
        let directory = SessionDirectory(lister: stub.list, sleepTick: { await ticker.wait() })
        await directory.refresh()
        XCTAssertEqual(stub.callCount, 1, "the seed refresh above, not the poll")

        directory.setPolling(active: true)
        await ticker.tick()
        await waitUntilDirectory { stub.callCount == 2 }
        XCTAssertEqual(stub.callCount, 2, "one poll-triggered refresh per tick")

        await ticker.tick()
        await waitUntilDirectory { stub.callCount == 3 }
        XCTAssertEqual(stub.callCount, 3, "the loop keeps going — not a one-shot")
    }

    /// The other half of the pin: NO ticks fire — and therefore no `session.list` calls happen —
    /// while the window is hidden. `setPolling` is simply never called with `true` here, mirroring
    /// how `AppWindowController.onRenderingActiveChange` never fires `true` for a window that has
    /// never been shown.
    func testNoPollingWhileHidden() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let ticker = ManualTickSource()
        let directory = SessionDirectory(lister: stub.list, sleepTick: { await ticker.wait() })
        await directory.refresh()
        XCTAssertEqual(stub.callCount, 1, "the seed refresh above")

        // Ticking a source nothing is waiting on is harmless (buffered, never consumed) — the
        // assertion that matters is that callCount never moves past the seed refresh.
        await ticker.tick()
        await ticker.tick()
        try? await Task.sleep(nanoseconds: 150_000_000) // settle
        XCTAssertEqual(stub.callCount, 1, "no session.list call while hidden — the poll never started")
    }

    /// `setPolling(active: false)` — the window going FROM visible TO hidden — cancels the
    /// outstanding loop outright: a tick delivered after that must not trigger one more refresh
    /// (proves this is a genuine stop, not merely "stop scheduling the NEXT one after this tick
    /// finishes").
    func testPollingStopsWhenSetInactive() async {
        let stub = StubSessionLister()
        stub.rows = [SessionSummary(sessionId: "s1", title: nil, createdAt: 1, scope: "global", cwd: nil)]
        let ticker = ManualTickSource()
        let directory = SessionDirectory(lister: stub.list, sleepTick: { await ticker.wait() })
        await directory.refresh()

        directory.setPolling(active: true)
        await ticker.tick()
        await waitUntilDirectory { stub.callCount == 2 }
        XCTAssertEqual(stub.callCount, 2)

        directory.setPolling(active: false)
        await ticker.tick() // delivered into the buffer, but nothing should still be waiting on it
        try? await Task.sleep(nanoseconds: 150_000_000) // settle
        XCTAssertEqual(stub.callCount, 2, "a tick after stopping must not trigger a refresh")
    }

    /// The poll-by-design deletion pickup: a `session.list` response missing a previously-known row
    /// removes it. Not a NEW behavior — `refresh()` already fully REPLACES `rows` with whatever the
    /// lister answers (see that method's own doc comment) — but pinned explicitly here since it's
    /// exactly what makes the poll (rather than only event-triggered refreshes) necessary: nothing
    /// ever broadcasts a deletion, so only a re-list ever prunes one.
    func testRefreshPrunesARowMissingFromTheLatestList() async {
        let stub = StubSessionLister()
        stub.rows = [
            SessionSummary(sessionId: "keep", title: nil, createdAt: 2, scope: "global", cwd: nil),
            SessionSummary(sessionId: "vanishes", title: nil, createdAt: 1, scope: "global", cwd: nil),
        ]
        let directory = SessionDirectory(lister: stub.list)
        await directory.refresh()
        XCTAssertEqual(Set(directory.rows.map(\.sessionId)), ["keep", "vanishes"])

        // The daemon's next answer no longer lists "vanishes" (deleted/expired/never existed by the
        // time this poll tick landed).
        stub.rows = [SessionSummary(sessionId: "keep", title: nil, createdAt: 2, scope: "global", cwd: nil)]
        await directory.refresh()

        XCTAssertEqual(directory.rows.map(\.sessionId), ["keep"], "a vanished row is pruned on fold")
    }
}
