import XCTest
@testable import Norma

/// Office Stage A Task 5 — `OfficeRuntimeReducer`, PURE: no supervisor, no helper process, no
/// socket. Mirrors `EditorRuntimeReducerTests`' own shape (a `reduce(state, [events])` fold plus a
/// `ready()` convenience builder) — the same reason that file gives: every claim this task makes
/// about the runtime's lifecycle is a row here, drivable with nothing but the reducer itself.
@MainActor
final class OfficeRuntimeReducerTests: XCTestCase {

    private func reduce(_ state: OfficeRuntimeState,
                        _ events: [OfficeRuntimeEvent]) -> (OfficeRuntimeState, [OfficeRuntimeEffect]) {
        var current = state
        var effects: [OfficeRuntimeEffect] = []
        for event in events {
            let (next, produced) = OfficeRuntimeReducer.reduce(current, event)
            current = next
            effects.append(contentsOf: produced)
        }
        return (current, effects)
    }

    private let metadata = OfficeDocumentMetadata(
        type: .spreadsheet, parts: 3, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 200))

    /// A runtime that has the (shared) helper up and is holding nothing.
    private func ready() -> OfficeRuntimeState {
        reduce(OfficeRuntimeState(), [.openRequested(path: "/warm.xlsx"), .helperBecameReady,
                                       .opened(path: "/warm.xlsx", docId: "warm-doc", metadata: metadata),
                                       .closeRequested(path: "/warm.xlsx")]).0
    }

    // MARK: - openRequested: idle is its own "ask the helper to start"

    func testAnOpenFromIdleMovesToStartingQueuesThePathAndAsksForTheHelper() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .starting)
        XCTAssertEqual(state.pendingOpens, ["/a.xlsx"])
        XCTAssertEqual(effects, [.ensureHelperReady])
    }

    func testOpensRequestedWhileStartingAreQueuedInOrderDedupedAndFlushedOnReady() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (queued, queuedEffects) = reduce(starting, [
            .openRequested(path: "/b.xlsx"),
            .openRequested(path: "/a.xlsx")
        ])
        XCTAssertEqual(queuedEffects, [], "nothing may reach the helper before it is ready")
        XCTAssertEqual(queued.pendingOpens, ["/a.xlsx", "/b.xlsx"], "deduped, in the order asked")

        let (flushed, effects) = reduce(queued, [.helperBecameReady])
        XCTAssertEqual(flushed.phase, .ready)
        XCTAssertEqual(flushed.pendingOpens, [])
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx"), .helperOpen(path: "/b.xlsx")])
    }

    func testASecondHelperBecameReadyWhileAlreadyReadyChangesNothing() {
        let (state, effects) = reduce(ready(), [.helperBecameReady])
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(effects, [])
    }

    func testHelperBecameReadyWhileIdleIsANoOpNoOneAskedForAnything() {
        let (state, effects) = reduce(OfficeRuntimeState(), [.helperBecameReady])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    /// T5 review M5(a): distinct from `testOpenRequestedFromFailedRetriesExactlyLikeIdle` (which is
    /// about a FRESH ask from `.failed`) — this is a `.helperBecameReady` fanned out because some
    /// OTHER session's demand restarted the shared helper, and it must NOT resurrect this one. A dead
    /// runtime leaves `.failed` only via its OWN `.openRequested`, never for free on someone else's
    /// success. This is exactly the behavior T6's re-open story and T9's SIGKILL-recovery drill
    /// depend on — nothing else in this file fails today if the reducer's `.starting`-only guard were
    /// relaxed to also admit `.failed`, which is why it needs its own pin.
    func testHelperBecameReadyWhileFailedStaysFailedNoFreeRecoveryFromAnotherSessionsRestart() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        XCTAssertEqual(failed.phase, .failed)

        let (state, effects) = reduce(failed, [.helperBecameReady])
        XCTAssertEqual(state, failed, "a dead runtime does not self-recover just because some other "
                       + "session's demand brought the shared helper back")
        XCTAssertEqual(effects, [])
    }

    // MARK: - openRequested: ready opens directly, or no-ops on an already-open path

    func testAnOpenFromReadyAsksTheHelperDirectly() {
        let (state, effects) = reduce(ready(), [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(effects, [.helperOpen(path: "/a.xlsx")])
    }

    func testAnOpenOfAPathAlreadyOpenAtReadyIsANoOp() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (again, effects) = reduce(open, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [], "no per-runtime 'current'/'activate' concept — T6's tab layer "
                       + "owns dedupe/activate against its own already-open tab, mirroring "
                       + "openFileTab's contract; this runtime just keeps what it already has")
        XCTAssertEqual(again.documents, open.documents)
    }

    // MARK: - opened / openFailed

    func testOpenedRecordsTheDocumentWithPartsAndSizeAndClearsAnyPriorFailure() {
        var failed = ready()
        failed.openFailures["/a.xlsx"] = "stale failure from a previous attempt"

        let (state, effects) = reduce(failed, [
            .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)
        ])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(state.documents["/a.xlsx"], OfficeRuntimeState.DocumentEntry(
            docId: "doc-a", type: .spreadsheet, parts: 3, activePart: 0,
            sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 200)))
        XCTAssertNil(state.openFailures["/a.xlsx"], "a document that opened cannot still be a path "
                     + "that could not be opened")
    }

    func testOpenedIsIgnoredOutsideReadySoAStaleReplyCannotResurrectATornDownRuntime() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    /// T5 review M5(b): the asymmetric sibling of `testOpenedIsIgnoredOutsideReadySoAStaleReplyCannot
    /// ResurrectATornDownRuntime` — `opened`'s outside-`.ready` guard was tested, `openFailed`'s own
    /// identical guard was not. A stale failure reply must not resurrect a torn-down runtime any more
    /// than a stale success reply may.
    func testOpenFailedIsIgnoredOutsideReadyForTheSameReasonOpenedIs() {
        let (state, effects) = reduce(OfficeRuntimeState(), [
            .openFailed(path: "/a.xlsx", reason: "corrupt file")
        ])
        XCTAssertEqual(state, OfficeRuntimeState())
        XCTAssertEqual(effects, [])
    }

    func testOpenFailedRecordsTheReasonAndEmitsABanner() {
        let (state, effects) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        XCTAssertEqual(state.openFailures["/broken.xlsx"], "corrupt file")
        XCTAssertEqual(effects, [.emitBanner(reason: "Couldn't open broken.xlsx: corrupt file")])
    }

    func testANewOpenRequestSupersedesThePriorFailureForThatPathBeforeAnyPhaseDecidesAnything() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        XCTAssertEqual(failed.openFailures["/broken.xlsx"], "corrupt file")

        let (retried, _) = reduce(failed, [.openRequested(path: "/broken.xlsx")])
        XCTAssertNil(retried.openFailures["/broken.xlsx"], "a retry must not keep showing a stale "
                     + "failure while its own fresh attempt is in flight")
    }

    // MARK: - closeRequested

    func testClosingAnOpenDocumentRemovesItAndAsksTheHelperToClose() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (closed, effects) = reduce(open, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.helperClose(docId: "doc-a")])
        XCTAssertNil(closed.documents["/a.xlsx"])
    }

    func testClosingAPathThatWasNeverOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.closeRequested(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testClosingAQueuedOpenCancelsItRatherThanOpeningItLater() {
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx"),
                                                           .openRequested(path: "/b.xlsx")])
        let (afterClose, closeEffects) = reduce(starting, [.closeRequested(path: "/a.xlsx")])
        XCTAssertEqual(closeEffects, [])
        XCTAssertEqual(afterClose.pendingOpens, ["/b.xlsx"])

        let (flushed, effects) = reduce(afterClose, [.helperBecameReady])
        XCTAssertEqual(effects, [.helperOpen(path: "/b.xlsx")], "the cancelled path never reaches the helper")
    }

    func testClosingClearsAnyRecordedOpenFailureForThatPath() {
        let (failed, _) = reduce(ready(), [.openFailed(path: "/broken.xlsx", reason: "corrupt file")])
        let (closed, _) = reduce(failed, [.closeRequested(path: "/broken.xlsx")])
        XCTAssertNil(closed.openFailures["/broken.xlsx"])
    }

    // MARK: - subscribeRequested / unsubscribeRequested (T6's tile door, thin at T5)

    private let viewport = OfficeTwipsRect(x: 0, y: 0, width: 1000, height: 2000)

    func testSubscribingToAnOpenDocumentRecordsTheActivePartAndAsksTheHelper() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (subscribed, effects) = reduce(open, [
            .subscribeRequested(path: "/a.xlsx", part: 2, zoomPPT: 26214, viewportTwips: viewport)
        ])
        XCTAssertEqual(subscribed.documents["/a.xlsx"]?.activePart, 2)
        XCTAssertEqual(effects, [.subscribe(docId: "doc-a", part: 2, zoomPPT: 26214, viewportTwips: viewport)])
    }

    func testSubscribingToAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [
            .subscribeRequested(path: "/never.xlsx", part: 0, zoomPPT: 26214, viewportTwips: viewport)
        ])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    func testUnsubscribingFromAnOpenDocumentAsksTheHelperAndTouchesNoOtherState() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.xlsx"),
                                         .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (state, effects) = reduce(open, [.unsubscribeRequested(path: "/a.xlsx")])
        XCTAssertEqual(effects, [.unsubscribe(docId: "doc-a")])
        XCTAssertEqual(state, open)
    }

    func testUnsubscribingFromAPathThatIsNotOpenIsANoOp() {
        let (state, effects) = reduce(ready(), [.unsubscribeRequested(path: "/never.xlsx")])
        XCTAssertEqual(state, ready())
        XCTAssertEqual(effects, [])
    }

    // MARK: - helperDied / helperUnavailable — carry 4: EVERY phase, and it is never terminal

    func testHelperDiedFromEveryPhaseClearsEverythingFailsAndBanners() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let openReady = ready()
        let (openWithDoc, _) = reduce(openReady, [.openRequested(path: "/a.xlsx"),
                                                   .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata)])
        let (alreadyFailed, _) = reduce(idle, [.helperDied])

        for (label, phase) in [("idle", idle), ("starting", starting), ("ready-empty", openReady),
                                ("ready-with-doc", openWithDoc), ("failed", alreadyFailed)] {
            let (state, effects) = reduce(phase, [.helperDied])
            XCTAssertEqual(state.phase, .failed, label)
            XCTAssertEqual(state.documents, [:], label)
            XCTAssertEqual(state.pendingOpens, [], label)
            XCTAssertEqual(state.openFailures, [:], label)
            XCTAssertEqual(state.failureReason, "The office helper stopped unexpectedly.", label)
            XCTAssertEqual(effects, [.emitBanner(reason: "The office helper stopped unexpectedly.")], label)
        }
    }

    func testHelperUnavailableFromEveryPhaseAlsoFailsWithItsOwnReason() {
        for phase in [OfficeRuntimeState(), reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")]).0, ready()] {
            let (state, effects) = reduce(phase, [.helperUnavailable])
            XCTAssertEqual(state.phase, .failed)
            XCTAssertEqual(state.failureReason, "The office helper couldn't be started.")
            XCTAssertEqual(effects, [.emitBanner(reason: "The office helper couldn't be started.")])
        }
    }

    /// Carry 4's OTHER half: unlike `EditorRuntimeState.Phase.failed` (terminal — "recovery is a
    /// teardown and a fresh runtime, never a second prewarm"), Office's `.failed` is retryable — the
    /// shared helper's own contract is "relaunch on next demand only," and a demand is exactly a
    /// fresh `openRequested`. Documented deviation from the Editor precedent, deliberate: EditorRuntime
    /// owns a per-runtime CEF browser that failing once leaves nothing sane to retry against; Office's
    /// helper is an app-wide process the NEXT open is entitled to ask for again.
    func testOpenRequestedFromFailedRetriesExactlyLikeIdle() {
        let (failed, _) = reduce(OfficeRuntimeState(), [.helperUnavailable])
        XCTAssertEqual(failed.phase, .failed)

        let (state, effects) = reduce(failed, [.openRequested(path: "/a.xlsx")])
        XCTAssertEqual(state.phase, .starting)
        XCTAssertEqual(state.pendingOpens, ["/a.xlsx"])
        XCTAssertNil(state.failureReason, "a fresh attempt supersedes the last failure's reason too")
        XCTAssertEqual(effects, [.ensureHelperReady])
    }

    // MARK: - teardownRequested — legal from every phase, always returns to a fresh idle state

    func testTeardownIsLegalFromEveryPhaseAndAlwaysReturnsToAFreshIdleState() {
        let idle = OfficeRuntimeState()
        let (starting, _) = reduce(OfficeRuntimeState(), [.openRequested(path: "/a.xlsx")])
        let (withDocs, _) = reduce(ready(), [
            .openRequested(path: "/a.xlsx"), .opened(path: "/a.xlsx", docId: "doc-a", metadata: metadata),
            .openRequested(path: "/b.xlsx"), .opened(path: "/b.xlsx", docId: "doc-b", metadata: metadata)
        ])
        let (failed, _) = reduce(idle, [.helperUnavailable])

        let (idleState, idleEffects) = reduce(idle, [.teardownRequested])
        XCTAssertEqual(idleState, OfficeRuntimeState())
        XCTAssertEqual(idleEffects, [.teardown(docIds: [])])

        let (startingState, startingEffects) = reduce(starting, [.teardownRequested])
        XCTAssertEqual(startingState, OfficeRuntimeState())
        XCTAssertEqual(startingEffects, [.teardown(docIds: [])], "nothing ever reached the helper "
                       + "while queued — no docId exists yet to close")

        let (docsState, docsEffects) = reduce(withDocs, [.teardownRequested])
        XCTAssertEqual(docsState, OfficeRuntimeState())
        XCTAssertEqual(docsEffects.count, 1, "exactly one .teardown effect, carrying every open docId")
        if case .teardown(let docIds)? = docsEffects.first {
            XCTAssertEqual(Set(docIds), Set(["doc-a", "doc-b"]), "both open docIds are handed to the "
                           + "imperative half to close")
        } else {
            XCTFail("expected a .teardown effect, got \(docsEffects)")
        }

        let (failedState, failedEffects) = reduce(failed, [.teardownRequested])
        XCTAssertEqual(failedState, OfficeRuntimeState())
        XCTAssertEqual(failedEffects, [.teardown(docIds: [])])
    }

    func testASecondTeardownIsSafe() {
        let (once, _) = reduce(ready(), [.teardownRequested])
        let (twice, twiceEffects) = reduce(once, [.teardownRequested])
        XCTAssertEqual(twice, OfficeRuntimeState())
        XCTAssertEqual(twiceEffects, [.teardown(docIds: [])])
    }
}

// MARK: - OfficeHelperRequestQueue: the shared client's request funnel

/// Office Stage A Task 5 — this queue is the addition beyond the brief's literal effect list,
/// justified by `OfficeHelperClient.expectReply`'s documented "single-outstanding-request"
/// contract (`OfficeHelperSupervisor`'s own header): two overlapping calls on the ONE shared
/// connection have no way to tell each other's replies apart. Every `ShellSessionHostTests` office
/// test bypasses this queue on purpose (its recorder-backed driver is used directly, never
/// `officeDriver(for:)`), so the queue's own correctness has no other test coverage — this is it.
@MainActor
final class OfficeHelperRequestQueueTests: XCTestCase {

    /// The whole point: a second operation enqueued WHILE the first is still running must not start
    /// until the first has fully finished. `async let` requests both "concurrently" from the
    /// caller's perspective — proving the queue itself, not merely the test's own sequencing, is
    /// what keeps them apart.
    func testTwoOverlappingOperationsRunStrictlySequentially() async throws {
        let queue = OfficeHelperRequestQueue()
        final class OrderBox { var events: [String] = [] }
        let box = OrderBox()

        async let first: Int = queue.run {
            box.events.append("first-start")
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms — comfortably longer than "second" needs
            box.events.append("first-end")
            return 1
        }
        async let second: Int = queue.run {
            box.events.append("second-start")
            return 2
        }

        let results = try await (first, second)

        XCTAssertEqual(results.0, 1)
        XCTAssertEqual(results.1, 2)
        XCTAssertEqual(box.events, ["first-start", "first-end", "second-start"],
                       "the second operation must never start while the first is still outstanding")
    }

    /// A throw must not wedge the queue: the operation AFTER a failing one still runs, and gets its
    /// own answer.
    func testAThrowingOperationDoesNotBlockTheNextOne() async {
        let queue = OfficeHelperRequestQueue()
        struct Boom: Error, Equatable {}

        async let first: Int = queue.run { throw Boom() }
        async let second: Int = queue.run { 42 }

        do {
            _ = try await first
            XCTFail("expected the first operation's own error to propagate to ITS caller")
        } catch is Boom {
            // expected
        } catch {
            XCTFail("expected Boom, got \(error)")
        }
        let secondResult = try? await second
        XCTAssertEqual(secondResult, 42, "a throw in one operation must not block the next")
    }

    /// Three, in order, none of them overlapping — the queue is a real FIFO, not merely "two work."
    ///
    /// **T5.5 review: this test's original `async let a/b/c` shape was ~25% flaky (`[1, 3, 2]` etc.),
    /// and the fault was the test, not the queue.** `run` is `@MainActor`-isolated; three `async let`
    /// children race INDEPENDENTLY to reach it, and their arrival order at the actor is not
    /// guaranteed to match their SOURCE order — so the old hardcoded `[1, 2, 3]` assertion conflated
    /// "declared first" with "enqueued first." The queue's own FIFO-by-enqueue-order property held on
    /// every single run; only the test's premise (source order == enqueue order) was unsound.
    ///
    /// Fix: remove the race instead of trying to observe around it. All three `run` calls are
    /// enqueued SYNCHRONOUSLY, back to back, from this already-`@MainActor` test body — with no
    /// `await` between the three `Task { @MainActor in ... }` creations below, the actor cannot
    /// service any of them until this synchronous prefix itself suspends, so all three land on the
    /// SAME serial executor in exactly this creation order before any of them runs. Enqueue order is
    /// pinned to source order by construction, not by chance — verified flake-free across 20
    /// iterations (`-test-iterations 20`, 0 failures) before landing.
    func testThreeOperationsRunInEnqueueOrder() async throws {
        let queue = OfficeHelperRequestQueue()
        final class OrderBox { var events: [Int] = [] }
        let box = OrderBox()

        let first = Task { @MainActor in
            try await queue.run { box.events.append(1); try? await Task.sleep(nanoseconds: 30_000_000); return 1 }
        }
        let second = Task { @MainActor in
            try await queue.run { box.events.append(2); return 2 }
        }
        let third = Task { @MainActor in
            try await queue.run { box.events.append(3); return 3 }
        }

        _ = try await (first.value, second.value, third.value)

        XCTAssertEqual(box.events, [1, 2, 3])
    }
}
