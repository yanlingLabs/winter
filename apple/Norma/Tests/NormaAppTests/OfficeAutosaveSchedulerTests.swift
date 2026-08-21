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
        XCTAssertTrue(scheduler.isArmed(docId: "doc-a"))
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
        XCTAssertFalse(scheduler.isArmed(docId: "doc-a"))
        XCTAssertEqual(fake.liveCount, 0, "the underlying timer must actually be cancelled, not "
                       + "merely forgotten by this scheduler's own bookkeeping")
        XCTAssertEqual(firedDocIds, ["doc-a"], "exactly the one fire before markClean — nothing "
                       + "after it, proving cancellation actually stops future fires")
    }

    func testMarkCleanForADocWithNoArmedTimerIsANoOp() {
        scheduler.markClean(docId: "never-armed")
        XCTAssertFalse(scheduler.isArmed(docId: "never-armed"))
    }

    // MARK: - remove (the close path) — same cancellation contract as markClean

    func testRemoveCancelsFutureFires() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.remove(docId: "doc-a")
        XCTAssertFalse(scheduler.isArmed(docId: "doc-a"))
        XCTAssertEqual(fake.liveCount, 0)
    }

    // MARK: - Re-arming after a clean cycle

    func testMarkDirtyAfterMarkCleanArmsAFreshTimer() {
        scheduler.markDirty(docId: "doc-a")
        scheduler.markClean(docId: "doc-a")
        scheduler.markDirty(docId: "doc-a")
        XCTAssertTrue(scheduler.isArmed(docId: "doc-a"))
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

    // MARK: - Fix round 1 (review I-1) — isArmed is a LIVE query, not a snapshot

    /// **The core mechanism `OfficeHelperServer.performAutosaveFire`'s own fix relies on, isolated
    /// from everything helper/LOK-adjacent** (`FakeOfficeDocumentBridge`/`OfficeHelperServer` are
    /// reachable only through a spawned subprocess — see `project.yml`'s own `NormaAppTests`
    /// `excludes:` comment — so THIS file, already compiled in-process, is where the closure-capture
    /// contract itself gets pinned). The review's own words: "an autosave fire racing ⌘S... the
    /// timer stays armed past placeAtomically/.clearAutosave because ModifiedStatus=false is a later
    /// round trip... re-check armed-ness inside the dedicated-thread job." The fix is only correct
    /// if the closure `performAutosaveFire` builds (`{ scheduler.isArmed(docId: docId) }`) captures
    /// `scheduler` BY REFERENCE and re-reads `armed` at CALL time — a closure that captured a
    /// pre-computed `Bool` at construction time (i.e., built BEFORE marshaling onto the dedicated
    /// thread) would still observe the STALE "armed" answer and write the spurious sidecar the
    /// review describes. This test constructs the exact shape of closure `performAutosaveFire`
    /// builds, disarms AFTER building it (standing in for "the real save's `.modifiedChanged(false)`
    /// round-trip lands while the fire's own job is still queued on the dedicated thread"), and
    /// proves the closure's answer changes — i.e., invoking it at JOB-EXECUTION time, not at
    /// fire-enqueue time, is what closes the race.
    func testIsArmedReflectsADisarmThatHappensAfterAClosureCapturingItWasBuiltButBeforeThatClosureIsCalled() {
        scheduler.markDirty(docId: "doc-a")
        XCTAssertTrue(scheduler.isArmed(docId: "doc-a"), "sanity")

        // The exact shape `OfficeHelperServer.performAutosaveFire` builds and hands to
        // `OfficeDocumentBridge.saveAsSidecar(docId:isStillArmed:)` — captures `scheduler`, not a
        // `Bool`.
        let isStillArmed: () -> Bool = { [scheduler] in scheduler!.isArmed(docId: "doc-a") }

        // Something else disarms it — standing in for the real save's own `.modifiedChanged(false)`
        // landing — AFTER the closure above was built but BEFORE anything calls it. This ordering
        // (disarm between construction and invocation) is precisely "disarms between fire-enqueue
        // and job-execution": `performAutosaveFire` builds this closure and hands it to
        // `documentBridge.saveAsSidecar` BEFORE that call marshals onto (and possibly queues behind
        // other work on) the dedicated thread — this line simulates whatever lands during that
        // queueing delay.
        scheduler.markClean(docId: "doc-a")

        XCTAssertFalse(isStillArmed(), "a closure built before the disarm must still observe it once "
                       + "actually INVOKED — proving `isArmed` is a live, re-checkable query rather "
                       + "than something safe to snapshot once and reuse. This is what makes checking "
                       + "armed-ness INSIDE the dedicated-thread job (at call time) correct where "
                       + "checking it once before marshaling onto that thread would not be.")
    }

    func testIsArmedItselfIsAPlainLiveReadWithNoCachingOfItsOwn() {
        XCTAssertFalse(scheduler.isArmed(docId: "doc-a"), "never armed")
        scheduler.markDirty(docId: "doc-a")
        XCTAssertTrue(scheduler.isArmed(docId: "doc-a"))
        scheduler.markClean(docId: "doc-a")
        XCTAssertFalse(scheduler.isArmed(docId: "doc-a"), "must flip back the instant markClean runs "
                       + "— no lingering `true` from the read a moment before")
    }
}
