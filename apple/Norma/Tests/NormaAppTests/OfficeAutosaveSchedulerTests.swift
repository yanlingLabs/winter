import XCTest
@testable import Norma

/// Office Stage B Task 7 — `OfficeAutosaveScheduler`, PURE cadence: no LOK, no socket, no
/// subprocess, no wall-clock sleep. An injected `Scheduling` fake stands in for
/// `DispatchSourceTimer` entirely — every "elapsed interval" in this file is a direct method call,
/// never a real sleep, the house norm for a 60s-cadence timer. What this file does NOT prove: that
/// the sidecar `saveAs` a real fire triggers actually writes real bytes, in the right (possibly
/// ODF-fallback) format, without crashing the helper — that is `OfficeRuntimeLiveTests`' own live
/// drill's job (real LOK, a shortened `--autosave-interval-seconds`). The two are deliberately
/// split: this file pins WHEN a fire happens; the live drill pins WHAT a fire does.
final class OfficeAutosaveSchedulerTests: XCTestCase {

    /// Stands in for `OfficeAutosaveScheduler.Scheduling.real()` — records every
    /// `scheduleRepeating` call as an entry a test can fire or cancel directly, with no notion of
    /// elapsed wall-clock time at all: "one interval has elapsed" is simply "the test called
    /// `fire(at:)`."
    private final class FakeScheduling {
        private final class Entry {
            let interval: TimeInterval
            let fire: () -> Void
            var cancelled = false
            init(interval: TimeInterval, fire: @escaping () -> Void) {
                self.interval = interval
                self.fire = fire
            }
        }
        private var entries: [Entry] = []

        var scheduledIntervals: [TimeInterval] { entries.map(\.interval) }
        var liveCount: Int { entries.filter { !$0.cancelled }.count }

        func asScheduling() -> OfficeAutosaveScheduler.Scheduling {
            OfficeAutosaveScheduler.Scheduling(scheduleRepeating: { [weak self] interval, fire in
                let entry = Entry(interval: interval, fire: fire)
                self?.entries.append(entry)
                return { entry.cancelled = true }
            })
        }

        /// Fires the timer that was armed `index`-th (arm order, 0-based) — simulates "one
        /// interval elapsed for THIS document's own timer." A cancelled entry firing again is a
        /// test bug in THIS file, not something the scheduler under test should ever cause — see
        /// `testMarkCleanCancelsFutureFires` for what actually proves cancellation.
        func fire(at index: Int) {
            entries[index].fire()
        }
    }

    private var firedDocIds: [String] = []
    private var fake: FakeScheduling!
    private var scheduler: OfficeAutosaveScheduler!

    override func setUp() {
        super.setUp()
        firedDocIds = []
        fake = FakeScheduling()
        scheduler = OfficeAutosaveScheduler(interval: 60, scheduling: fake.asScheduling(),
                                             onFire: { [weak self] docId in self?.firedDocIds.append(docId) })
    }

    // MARK: - Arming does not fire immediately

    func testMarkDirtyArmsATimerButDoesNotFireBeforeTheIntervalElapses() {
        scheduler.markDirty(docId: "doc-a")
        XCTAssertTrue(scheduler.isArmedForTesting(docId: "doc-a"))
        XCTAssertEqual(firedDocIds, [], "arming must not itself count as the first fire — the "
                       + "brief's cadence is 60s WHILE dirty, not the instant a document goes dirty")
        XCTAssertEqual(fake.scheduledIntervals, [60], "the scheduler's own `interval` must reach "
                       + "the scheduling layer unchanged")
    }

    // MARK: - Firing while still dirty

    func testOneElapsedIntervalFiresExactlyOnceForThatDocId() {
        scheduler.markDirty(docId: "doc-a")
        fake.fire(at: 0)
        XCTAssertEqual(firedDocIds, ["doc-a"])
    }

    func testStayingDirtyKeepsFiringOnceEveryInterval() {
        scheduler.markDirty(docId: "doc-a")
        fake.fire(at: 0)
        fake.fire(at: 0)
        fake.fire(at: 0)
        XCTAssertEqual(firedDocIds, ["doc-a", "doc-a", "doc-a"], "a REPEATING timer, not a one-shot "
                       + "— the sidecar keeps refreshing for as long as the document stays dirty")
    }

    // MARK: - markClean cancels the timer, never the (nonexistent, in this file) sidecar

    func testMarkCleanCancelsFutureFires() {
        scheduler.markDirty(docId: "doc-a")
        fake.fire(at: 0) // one genuine fire while still dirty
        scheduler.markClean(docId: "doc-a")
        XCTAssertFalse(scheduler.isArmedForTesting(docId: "doc-a"))
        XCTAssertEqual(fake.liveCount, 0, "the underlying timer must actually be cancelled, not "
                       + "merely forgotten by this scheduler's own bookkeeping")
        XCTAssertEqual(firedDocIds, ["doc-a"], "exactly the one fire before markClean — nothing "
                       + "after it, proving cancellation actually stops future fires")
    }

    func testMarkCleanForADocWithNoArmedTimerIsANoOp() {
        scheduler.markClean(docId: "never-armed")
        XCTAssertFalse(scheduler.isArmedForTesting(docId: "never-armed"))
    }

    // MARK: - remove (the close path) — same cancellation contract as markClean

    func testRemoveCancelsFutureFires() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.remove(docId: "doc-a")
        XCTAssertFalse(scheduler.isArmedForTesting(docId: "doc-a"))
        XCTAssertEqual(fake.liveCount, 0)
    }

    // MARK: - Re-arming after a clean cycle

    func testMarkDirtyAfterMarkCleanArmsAFreshTimer() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.markClean(docId: "doc-a")
        scheduler.markDirty(docId: "doc-a")
        XCTAssertTrue(scheduler.isArmedForTesting(docId: "doc-a"))
        XCTAssertEqual(fake.scheduledIntervals.count, 2, "a genuinely NEW timer, not a resurrection "
                       + "of the cancelled one")
        fake.fire(at: 1) // the second (fresh) timer
        XCTAssertEqual(firedDocIds, ["doc-a"])
    }

    // MARK: - Idempotence: markDirty while already armed must not double-arm

    func testMarkDirtyIsIdempotentForAnAlreadyArmedDoc() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.markDirty(docId: "doc-a") // defensive — LOK does not refire true->true in practice
        XCTAssertEqual(fake.scheduledIntervals.count, 1, "a second markDirty for an already-armed "
                       + "docId must not mint a second, orphaned timer that would silently double "
                       + "this document's own fire rate")
        fake.fire(at: 0)
        XCTAssertEqual(firedDocIds, ["doc-a"], "one fire per interval, not two")
    }

    // MARK: - Two documents are independent

    func testTwoDocumentsFireIndependentlyOnTheirOwnTimers() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.markDirty(docId: "doc-b")
        fake.fire(at: 0) // doc-a's own timer
        XCTAssertEqual(firedDocIds, ["doc-a"])
        scheduler.markClean(docId: "doc-a")
        fake.fire(at: 1) // doc-b's own timer — must still be live; doc-a's cancel must not reach it
        XCTAssertEqual(firedDocIds, ["doc-a", "doc-b"])
    }
}
