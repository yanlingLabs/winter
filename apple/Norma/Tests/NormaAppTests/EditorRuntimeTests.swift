import AppKit
import SwiftUI
import XCTest
@testable import Norma

/// A clock and two schedulers under the test's thumb — the same shape `BrowserRuntimeTests` uses
/// (each suite keeps its own copy, this suite's convention for doubles). Nothing here waits.
@MainActor
final class EditorFakeScheduler {
    struct Armed {
        let id: Int
        let fireAt: Date
        let work: () -> Void
    }

    var current = Date(timeIntervalSince1970: 2_000_000)
    var autoRun = true
    private(set) var pendingWork: [() -> Void] = []
    private(set) var armed: [Armed] = []
    private(set) var cancelled: [Int] = []
    private(set) var fired: [Int] = []
    private var nextId = 0

    /// Timers that will still fire: armed, not cancelled, not already spent — **in the order a run
    /// loop would fire them**, which is by deadline and not by the order they were armed. The
    /// runtime arms a 25 ms id poll and a 30 s ready watchdog in that order, and a double that fired
    /// by insertion order would condemn a runtime that was merely still looking for its browser.
    var liveTimers: [Armed] {
        armed.filter { !cancelled.contains($0.id) && !fired.contains($0.id) }
            .sorted { $0.fireAt < $1.fireAt }
    }

    func runPendingWork() {
        let work = pendingWork
        pendingWork = []
        for item in work { item() }
    }

    /// Fire the soonest-due live timer, exactly as the run loop would.
    @discardableResult
    func fireNextTimer() -> Bool {
        guard let next = liveTimers.first else { return false }
        fired.append(next.id)
        next.work()
        return true
    }

    var scheduler: BrowserRuntime.Scheduler {
        BrowserRuntime.Scheduler(
            now: { [unowned self] in self.current },
            mainAsync: { [unowned self] work in
                if self.autoRun { work() } else { self.pendingWork.append(work) }
            },
            timer: { [unowned self] fireAt, work in
                self.nextId += 1
                let id = self.nextId
                self.armed.append(Armed(id: id, fireAt: fireAt, work: work))
                return BrowserRuntime.Scheduler.Cancellable { [unowned self] in self.cancelled.append(id) }
            })
    }
}

/// Every CEF call `EditorRuntime` makes, recorded. Same posture as `BrowserRuntimeTests.CEFRecorder`
/// and for the same reason: no CEF call is reachable under XCTest, ever.
@MainActor
final class EditorCEFRecorder {
    private(set) var log: [String] = []
    private(set) var createdURLs: [String] = []
    /// editor-product Task 4 — the `backgroundColorARGB` `NormaCEFCreateBrowser` was called with,
    /// one per `createBrowser` call, same indices as `createdURLs`.
    private(set) var createdBackgroundColors: [UInt32] = []
    private(set) var registeredRoots: [String] = []
    private(set) var cdp: [(method: String, params: String?, completion: (Bool, String) -> Void)] = []
    private(set) var closeCount = 0
    private(set) var boundsAtCreate: NSRect = .zero

    /// What `assetRoot()` answers — `nil` stands for a build with no embedded editor.
    var assetRoot: String? = "/fake/EditorAssets"
    var initialises = true
    var failure: String?
    /// The ids `NormaCEFBrowserIdentifierForParent` answers, consumed in order; the last one repeats.
    var browserIds: [Int32] = [0, 0, 41]

    private var idIndex = 0

    func nextBrowserId() -> Int32 {
        guard !browserIds.isEmpty else { return 0 }
        let value = browserIds[min(idIndex, browserIds.count - 1)]
        idIndex += 1
        return value
    }

    /// Answer the oldest outstanding CDP call, as CEF's door eventually does (its completion always
    /// fires — `NormaCEF.h`).
    @discardableResult
    func answerNextCDP(ok: Bool = true, payload: String = "{}") -> Bool {
        guard !cdp.isEmpty else { return false }
        let entry = cdp.removeFirst()
        entry.completion(ok, payload)
        return true
    }

    var driver: EditorRuntime.CEFDriver {
        EditorRuntime.CEFDriver(
            assetRoot: { [unowned self] in self.assetRoot },
            registerAssetRoot: { [unowned self] root in
                self.registeredRoots.append(root)
                self.log.append("assetRoot \(root)")
            },
            ensureInitialized: { [unowned self] in self.initialises },
            failureReason: { [unowned self] in self.failure },
            createBrowser: { [unowned self] container, url, backgroundColorARGB in
                self.boundsAtCreate = container.bounds
                self.createdURLs.append(url)
                self.createdBackgroundColors.append(backgroundColorARGB)
                self.log.append("create \(url)")
            },
            browserIdentifier: { [unowned self] _ in self.nextBrowserId() },
            closeBrowser: { [unowned self] _ in
                self.closeCount += 1
                self.log.append("close")
            },
            executeCDP: { [unowned self] _, method, params, completion in
                self.log.append("cdp \(method)")
                self.cdp.append((method, params, completion))
            })
    }
}

/// Stands in for T5's code-tab viewport: it adopts the runtime's one view into a container of its
/// own, exactly as a mounted tab does.
@MainActor
final class EditorViewportHostSpy: EditorViewportHost {
    private(set) var adopted: [NSView] = []
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))

    func adoptEditorView(_ view: NSView) {
        adopted.append(view)
        container.addSubview(view)
    }
}

// MARK: - The lifecycle, as a pure function

@MainActor
final class EditorRuntimeReducerTests: XCTestCase {

    private func reduce(_ state: EditorRuntimeState,
                        _ events: [EditorRuntimeEvent]) -> (EditorRuntimeState, [EditorRuntimeEffect]) {
        var current = state
        var effects: [EditorRuntimeEffect] = []
        for event in events {
            let (next, produced) = EditorRuntimeReducer.reduce(current, event)
            current = next
            effects.append(contentsOf: produced)
        }
        return (current, effects)
    }

    /// A runtime that has booted and is holding nothing.
    private func ready(browserId: Int32 = 41) -> EditorRuntimeState {
        reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(browserId), .pageReady]).0
    }

    // MARK: Prewarm

    func testPrewarmMovesIdleToBootingAndAsksForExactlyOneBrowser() {
        let (state, effects) = reduce(EditorRuntimeState(), [.prewarmRequested])
        XCTAssertEqual(state.phase, .booting)
        XCTAssertEqual(effects, [.createBrowser])
    }

    func testASecondPrewarmCreatesNothing() {
        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested])
        let (again, effects) = reduce(booting, [.prewarmRequested])
        XCTAssertEqual(again.phase, .booting)
        XCTAssertEqual(effects, [], "a second browser in the same container is one nothing closes")

        let (afterReady, readyEffects) = reduce(ready(), [.prewarmRequested])
        XCTAssertEqual(afterReady.phase, .ready)
        XCTAssertEqual(readyEffects, [])
    }

    // MARK: The browser id

    func testTheBrowserIdRegistersWithTheHubWhileTheRuntimeIsStillBooting() {
        let (state, effects) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(41)])
        XCTAssertEqual(state.browserId, 41)
        XCTAssertEqual(state.phase, .booting, "registration precedes ready — ready ARRIVES through "
                       + "the hub, so a runtime that waited for it would eat its own boot signal")
        XCTAssertEqual(effects, [.createBrowser, .registerWithHub(browserId: 41)])
    }

    func testABrowserIdOfZeroFailsTheRuntimeAndRegistersNothing() {
        let (state, effects) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(0)])
        XCTAssertEqual(state.phase, .failed)
        XCTAssertEqual(state.browserId, 0)
        XCTAssertEqual(effects, [.createBrowser])
        XCTAssertNotNil(state.failureReason)
    }

    func testALateBrowserIdAfterReadyChangesNothing() {
        let (state, effects) = reduce(ready(), [.browserIdentified(99)])
        XCTAssertEqual(state.browserId, 41)
        XCTAssertEqual(effects, [])
    }

    // MARK: Ready gates opens

    func testOpensRequestedWhileBootingAreQueuedInOrderAndFlushedOnReady() {
        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(41)])
        let (queued, queuedEffects) = reduce(booting, [
            .openRequested(path: "/a.ts"),
            .openRequested(path: "/b.ts"),
            .openRequested(path: "/a.ts")
        ])
        XCTAssertEqual(queuedEffects, [], "nothing may be sent to the page before ready")
        XCTAssertEqual(queued.pendingOpens, ["/a.ts", "/b.ts"], "deduped, in the order asked")

        let (flushed, effects) = reduce(queued, [.pageReady])
        XCTAssertEqual(flushed.phase, .ready)
        XCTAssertEqual(flushed.pendingOpens, [])
        XCTAssertEqual(effects, [.sendTheme, .openModel(path: "/a.ts"), .openModel(path: "/b.ts")],
                       "editor-product Task 4: the theme goes out FIRST, ahead of every flushed open")
    }

    func testAnOpenFromIdleIsItsOwnPrewarm() {
        let (state, effects) = reduce(EditorRuntimeState(), [.openRequested(path: "/a.ts")])
        XCTAssertEqual(state.phase, .booting)
        XCTAssertEqual(state.pendingOpens, ["/a.ts"])
        XCTAssertEqual(effects, [.createBrowser])
    }

    func testAnOpenOfAnAlreadyOpenPathActivatesInsteadOfReopening() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts"),
                                         .openRequested(path: "/b.ts"), .modelOpened(path: "/b.ts")])
        XCTAssertEqual(open.current, "/b.ts")

        let (again, effects) = reduce(open, [.openRequested(path: "/a.ts")])
        XCTAssertEqual(effects, [.activateModel(path: "/a.ts")],
                       "the page refuses a second openModel for a path it holds — it would discard "
                       + "unsaved edits — so Swift asks for the activate directly")
        XCTAssertEqual(again.current, "/a.ts")
        XCTAssertEqual(Set(again.models.keys), ["/a.ts", "/b.ts"])
    }

    func testModelOpenedRecordsACleanModelAndMakesItCurrent() {
        let (state, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts")])
        XCTAssertEqual(state.models["/a.ts"], EditorRuntimeState.ModelEntry(dirty: false))
        XCTAssertEqual(state.current, "/a.ts")
    }

    // MARK: Activate / close / dirty

    func testActivatingAPathTheRuntimeDoesNotHoldDoesNothing() {
        let (state, effects) = reduce(ready(), [.activateRequested(path: "/never-opened.ts")])
        XCTAssertEqual(effects, [])
        XCTAssertNil(state.current)
    }

    func testClosingTheActiveModelLeavesTheEditorShowingNothing() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts")])
        let (closed, effects) = reduce(open, [.closeRequested(path: "/a.ts")])
        XCTAssertEqual(effects, [.closeModel(path: "/a.ts")])
        XCTAssertEqual(closed.models, [:])
        XCTAssertNil(closed.current, "activating a survivor is the caller's obligation (drill 9)")
    }

    func testClosingAQueuedOpenCancelsItRatherThanOpeningItLater() {
        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested,
                                                         .openRequested(path: "/a.ts"),
                                                         .openRequested(path: "/b.ts")])
        let (cancelled, effects) = reduce(booting, [.closeRequested(path: "/a.ts")])
        XCTAssertEqual(effects, [], "there is no model to tell the page about")
        XCTAssertEqual(cancelled.pendingOpens, ["/b.ts"])

        let (flushed, flushEffects) = reduce(cancelled, [.pageReady])
        XCTAssertEqual(flushEffects, [.sendTheme, .openModel(path: "/b.ts")])
        XCTAssertEqual(flushed.pendingOpens, [])
    }

    func testDirtyTracksThePagesTransitionsAndOnlyForModelsTheRuntimeHolds() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts")])
        XCTAssertEqual(open.dirtyCount, 0)

        let (dirty, effects) = reduce(open, [.dirtyChanged(path: "/a.ts", dirty: true),
                                             .dirtyChanged(path: "/ghost.ts", dirty: true)])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(dirty.dirtyCount, 1)
        XCTAssertNil(dirty.models["/ghost.ts"])

        let (clean, _) = reduce(dirty, [.dirtyChanged(path: "/a.ts", dirty: false)])
        XCTAssertEqual(clean.dirtyCount, 0)
    }

    // MARK: Failure

    func testAFailedRuntimeAbsorbsEverythingButTeardown() {
        let (failed, _) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(0)])
        let (after, effects) = reduce(failed, [
            .prewarmRequested,
            .openRequested(path: "/a.ts"),
            .activateRequested(path: "/a.ts"),
            .closeRequested(path: "/a.ts"),
            .pageReady,
            .modelOpened(path: "/a.ts"),
            .dirtyChanged(path: "/a.ts", dirty: true)
        ])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(after.phase, .failed)
        XCTAssertEqual(after.models, [:])
        XCTAssertEqual(after.pendingOpens, [])

        let (torndown, teardownEffects) = reduce(after, [.teardownRequested])
        XCTAssertEqual(teardownEffects, [.teardown(browserId: 0)])
        XCTAssertEqual(torndown, EditorRuntimeState())
    }

    func testABootFailureDropsTheQueuedOpensBecauseTheyCanNeverLand() {
        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested, .openRequested(path: "/a.ts")])
        let (failed, effects) = reduce(booting, [.bootFailed(reason: "CEF did not start")])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertEqual(failed.failureReason, "CEF did not start")
        XCTAssertEqual(failed.pendingOpens, [])
    }

    /// The ready watchdog is armed before `ready` can arrive; a late firing must never condemn a
    /// page that came up.
    func testABootFailureAfterReadyIsIgnored() {
        let (state, effects) = reduce(ready(), [.bootFailed(reason: "the page never reported ready")])
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(effects, [])
    }

    func testASecondReadyChangesNothing() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts")])
        let (again, effects) = reduce(open, [.pageReady])
        XCTAssertEqual(effects, [])
        XCTAssertEqual(again.models.count, 1)
    }

    // MARK: Theme (editor-product Task 4)

    /// `.appearanceChanged` only acts once the page is actually up to repaint — a runtime still
    /// booting sends the CURRENT scheme's tokens the moment `.pageReady` fires anyway (resolved
    /// fresh, not cached), so re-sending here would be redundant at best; `idle`/`failed` hold no
    /// page at all.
    func testAppearanceChangeOnlyRepaintsARuntimeThatIsActuallyReady() {
        XCTAssertEqual(reduce(EditorRuntimeState(), [.appearanceChanged]).1, [],
                       "idle holds no page to repaint")

        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested])
        XCTAssertEqual(reduce(booting, [.appearanceChanged]).1, [],
                       "booting — ready's own send will pick up the current scheme")

        let (failed, _) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(0)])
        XCTAssertEqual(reduce(failed, [.appearanceChanged]).1, [], "failed holds no page either")

        let (state, effects) = reduce(ready(), [.appearanceChanged])
        XCTAssertEqual(effects, [.sendTheme], "ready is the one phase that actually repaints")
        XCTAssertEqual(state.phase, .ready, "appearance changing is not itself a phase transition")
    }

    /// The models table, `current` and every other field are untouched by a repaint — `.sendTheme`
    /// is a side effect on the imperative half, never a state mutation the reducer records.
    func testAppearanceChangeTouchesNoStateOtherThanEmittingTheEffect() {
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts"),
                                         .dirtyChanged(path: "/a.ts", dirty: true)])
        let (after, effects) = reduce(open, [.appearanceChanged])
        XCTAssertEqual(effects, [.sendTheme])
        XCTAssertEqual(after, open, "nothing about the runtime's own state moves")
    }

    // MARK: Teardown from every phase

    func testTeardownIsLegalFromEveryPhaseAndAlwaysReturnsToIdle() {
        let (booting, _) = reduce(EditorRuntimeState(), [.prewarmRequested])
        let (identified, _) = reduce(booting, [.browserIdentified(41)])
        let (open, _) = reduce(ready(), [.openRequested(path: "/a.ts"), .modelOpened(path: "/a.ts"),
                                         .dirtyChanged(path: "/a.ts", dirty: true)])
        let (failed, _) = reduce(EditorRuntimeState(), [.prewarmRequested, .browserIdentified(0)])

        let cases: [(name: String, state: EditorRuntimeState, browserId: Int32)] = [
            ("idle", EditorRuntimeState(), 0),
            ("booting (no id yet)", booting, 0),
            ("booting (id known)", identified, 41),
            ("ready with a dirty model", open, 41),
            ("failed", failed, 0)
        ]
        for row in cases {
            let (after, effects) = reduce(row.state, [.teardownRequested])
            XCTAssertEqual(effects, [.teardown(browserId: row.browserId)], "teardown from \(row.name)")
            XCTAssertEqual(after, EditorRuntimeState(), "teardown from \(row.name) returns to idle")
        }
    }
}

// MARK: - The runtime itself, with every CEF call recorded

@MainActor
final class EditorRuntimeTests: XCTestCase {

    private struct Harness {
        let runtime: EditorRuntime
        let cef: EditorCEFRecorder
        let scheduler: EditorFakeScheduler
        let slot: EditorSlotRecorder
        let hub: EditorBridgeHub
    }

    /// `colorScheme` defaults to a FIXED `.light` rather than `EditorRuntime.currentColorScheme()`
    /// (the production default) — editor-product Task 4: every `boot(_:)` now sends a real
    /// `EditorTheme.tokensJSON` payload, and a test host's own appearance is not this suite's to
    /// depend on. Tests that care about the OTHER scheme override it explicitly.

    private func makeRuntime(files: [String: String] = [:],
                             colorScheme: @escaping @MainActor () -> ColorScheme = { .light }) -> Harness {
        let cef = EditorCEFRecorder()
        let scheduler = EditorFakeScheduler()
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let runtime = EditorRuntime(sessionId: "S1", hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: colorScheme,
                                    readFile: { path in
                                        guard let text = files[path] else {
                                            throw NSError(domain: NSCocoaErrorDomain,
                                                          code: NSFileNoSuchFileError)
                                        }
                                        return EditorFileContents(text: text)
                                    })
        return Harness(runtime: runtime, cef: cef, scheduler: scheduler, slot: slot, hub: hub)
    }

    /// Drives a runtime to `ready`: prewarm, let the id poll find one, then deliver the page's own
    /// `ready` through the hub — the REAL path, since `ready` is a bridge query like any other.
    ///
    /// **editor-product Task 4: `ready` now also sends `setTheme`, synchronously, before this
    /// returns** (`.pageReady`'s `.sendTheme` effect runs on the same call stack as `deliver`, unlike
    /// a queued `.openModel`, which is Task-scheduled). Answered here, once, so every caller written
    /// before Task 4 — whose own `answerNextCDP()`/`cdp[0]` assumptions predate the theme send — keeps
    /// meaning exactly what it said: no test using this helper ever queues an open before booting, so
    /// `.pageReady` never produces more than this one call, and draining it here is airtight rather
    /// than merely convenient. A test that wants to inspect the theme send itself does not use this
    /// helper — see `testPageReadyAlsoSendsTheBrandedThemeBeforeAnyQueuedOpen`.
    @discardableResult
    private func boot(_ harness: Harness, browserId: Int32 = 41) -> Int32 {
        harness.cef.browserIds = [browserId]
        harness.runtime.prewarm()
        harness.slot.deliver(browserId: browserId, queryId: 1, request: #"{"type":"ready"}"#)
        harness.cef.answerNextCDP()
        return browserId
    }

    private func waitForCDP(_ harness: Harness, count: Int,
                            file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while harness.cef.cdp.count < count && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(harness.cef.cdp.count, count, "timed out waiting for \(count) CDP call(s)",
                       file: file, line: line)
    }

    // MARK: Boot

    func testPrewarmRegistersTheAssetRootFirstAndCreatesTheEditorPageExactlyOnce() {
        let harness = makeRuntime()
        XCTAssertFalse(harness.runtime.hasHiddenWindow, "a session that never wanted an editor "
                       + "must not build a window for one")

        harness.runtime.prewarm()
        harness.runtime.prewarm()

        XCTAssertEqual(Array(harness.cef.log.prefix(2)),
                       ["assetRoot /fake/EditorAssets", "create \(EditorRuntime.pageURL)"],
                       "until the root is registered the scheme handler answers 404 to everything")
        XCTAssertEqual(harness.cef.createdURLs, [EditorRuntime.pageURL])
        XCTAssertTrue(harness.runtime.hasHiddenWindow)
        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .booting)
    }

    func testTheBrowserIsBornAtAPlausibleViewportRatherThanZero() {
        let harness = makeRuntime()
        harness.runtime.prewarm()
        // `CreateBrowserNow` reads `[parent bounds]` exactly once, at creation — a browser created
        // into an unsized container lays out at zero for as long as nothing attaches it.
        XCTAssertGreaterThan(harness.cef.boundsAtCreate.width, 0)
        XCTAssertGreaterThan(harness.cef.boundsAtCreate.height, 0)
    }

    func testABuildWithNoEmbeddedEditorFailsBeforeAskingCEFForAnything() {
        let harness = makeRuntime()
        harness.cef.assetRoot = nil

        harness.runtime.prewarm()

        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .failed)
        XCTAssertEqual(harness.cef.createdURLs, [])
        XCTAssertNotNil(harness.runtime.stateSnapshot.failureReason)
    }

    func testCEFRefusingToStartFailsTheRuntimeWithTheReasonItGave() {
        let harness = makeRuntime()
        harness.cef.initialises = false
        harness.cef.failure = "another copy holds the profile lock"

        harness.runtime.prewarm()

        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .failed)
        XCTAssertEqual(harness.runtime.stateSnapshot.failureReason,
                       "another copy holds the profile lock")
    }

    func testTheBrowserIdIsPolledUntilItExistsAndOnlyThenRegisteredWithTheHub() {
        let harness = makeRuntime()
        harness.cef.browserIds = [0, 0, 57]

        harness.runtime.prewarm()
        XCTAssertEqual(harness.hub.registeredBrowserIds, [],
                       "0 is \"no browser yet\" — registering it would claim the whole process")

        XCTAssertTrue(harness.scheduler.fireNextTimer())   // second look: still 0
        XCTAssertEqual(harness.hub.registeredBrowserIds, [])
        XCTAssertTrue(harness.scheduler.fireNextTimer())   // third look: 57

        XCTAssertEqual(harness.hub.registeredBrowserIds, [57])
        XCTAssertEqual(harness.runtime.stateSnapshot.browserId, 57)
        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .booting,
                       "registered, but not ready until the PAGE says so")
    }

    func testThePagesReadyArrivesThroughTheHubAndMakesTheRuntimeReady() {
        let harness = makeRuntime()
        boot(harness)

        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .ready)
        XCTAssertEqual(harness.slot.answers.map(\.success), [true],
                       "the client answers before it acts, and exactly once")
    }

    func testAPageThatNeverSaysReadyFailsWhenTheWatchdogFires() {
        let harness = makeRuntime()
        harness.cef.browserIds = [41]
        harness.runtime.prewarm()
        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .booting)

        // The id poll stopped (it found one); the only live timer is the ready watchdog.
        XCTAssertEqual(harness.scheduler.liveTimers.count, 1)
        XCTAssertTrue(harness.scheduler.fireNextTimer())

        XCTAssertEqual(harness.runtime.stateSnapshot.phase, .failed)
        XCTAssertEqual(harness.runtime.stateSnapshot.failureReason,
                       "the editor page never reported ready")
    }

    // MARK: Theme (editor-product Task 4)

    /// The browser's OWN background (`NormaCEF.h`'s `backgroundColorARGB`) is set at the moment
    /// `prewarm()` creates it, from the INJECTED `colorScheme` — proving the seam that lets a test
    /// pin this without touching the real system appearance, and that light and dark really do
    /// resolve to different values (not a hardcoded constant that happens to compile).
    func testPrewarmCreatesTheBrowserWithTheCurrentSchemesCardSurfaceAsAnOpaqueBackground() {
        let light = makeRuntime(colorScheme: { .light })
        light.runtime.prewarm()
        XCTAssertEqual(light.cef.createdBackgroundColors,
                       [EditorTheme.cardSurfaceBackgroundARGB(for: .light)])

        let dark = makeRuntime(colorScheme: { .dark })
        dark.runtime.prewarm()
        XCTAssertEqual(dark.cef.createdBackgroundColors,
                       [EditorTheme.cardSurfaceBackgroundARGB(for: .dark)])

        XCTAssertNotEqual(light.cef.createdBackgroundColors, dark.cef.createdBackgroundColors,
                          "the two schemes must not resolve to the same background")
        // The alpha byte is CEF's own contract for "this IS an override" (background_color's own
        // doc: opaque or fully transparent, nothing between) — `0xFF______`.
        XCTAssertEqual(light.cef.createdBackgroundColors[0] >> 24, 0xFF)
    }

    /// **`ready` sends the branded theme before this test's `boot()` helper would have drained it** —
    /// driven manually (not through `boot(_:)`) so the send is still sitting in `cdp` to inspect.
    /// Pins the wire shape AND that the injected scheme actually reaches the payload: `.dark`'s
    /// `base` and its `CardSurface` hex both have to show up, not just "some setTheme call".
    func testReadyAlsoSendsTheBrandedThemeBeforeAnyFlushedOpen() {
        let harness = makeRuntime(colorScheme: { .dark })
        harness.cef.browserIds = [41]
        harness.runtime.prewarm()

        harness.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)

        XCTAssertEqual(harness.cef.cdp.count, 1, "ready with nothing queued sends exactly the theme")
        let expression = expressionOf(harness.cef.cdp[0].params)
        XCTAssertTrue(expression.hasPrefix("window.normaEditor.dispatch({"),
                      "one call, one literal entry point, payload as data: \(expression)")
        XCTAssertTrue(expression.contains(#""type":"setTheme""#), expression)
        XCTAssertTrue(expression.contains(#""base":"vs-dark""#),
                      "the INJECTED .dark scheme must reach the payload: \(expression)")
        // A double-`#` raw string: the value itself contains a `#` (the hex's own leading hash),
        // which would otherwise read as the single-`#` terminator right after the opening quote.
        XCTAssertTrue(expression.contains(##""editor.background":"#20201F""##),
                      "CardSurface's dark hex (docs/brand.md § 1): \(expression)")
    }

    /// The other half of "on ready and on appearance change": a call before anything exists is a
    /// no-op (nothing to repaint), and a call once ready sends exactly one more `setTheme` —
    /// `systemAppearanceChanged()` is the testable seam for what `NSApp`'s own KVO wires in `init`.
    func testSystemAppearanceChangedSendsAFreshThemeOnlyWhenReady() {
        let harness = makeRuntime()
        harness.runtime.systemAppearanceChanged()
        XCTAssertEqual(harness.cef.cdp.count, 0, "nothing exists yet to repaint")

        boot(harness)
        XCTAssertEqual(harness.cef.cdp.count, 0, "boot() already drained the ready-triggered send")

        harness.runtime.systemAppearanceChanged()
        XCTAssertEqual(harness.cef.cdp.count, 1)
        XCTAssertTrue(expressionOf(harness.cef.cdp[0].params).contains(#""type":"setTheme""#))

        harness.runtime.systemAppearanceChanged()
        XCTAssertEqual(harness.cef.cdp.count, 2, "every later change repaints again, not just the first")
    }

    // MARK: Opening

    func testAnOpenBeforeReadyIsQueuedAndSendsTheFilesCURRENTBytesWhenItFlushes() async {
        let harness = makeRuntime(files: ["/tmp/a.ts": "const a = 1;\n"])
        harness.cef.browserIds = [41]
        harness.runtime.prewarm()

        await harness.runtime.openFile("/tmp/a.ts")
        XCTAssertEqual(harness.cef.cdp.count, 0, "nothing may be sent to the page before ready")
        XCTAssertEqual(harness.runtime.stateSnapshot.pendingOpens, ["/tmp/a.ts"])

        harness.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        // editor-product Task 4: `ready` now ALSO sends `setTheme` — synchronously, ahead of the
        // flushed `openModel` (`.pageReady`'s effect order), so two calls land rather than one.
        await waitForCDP(harness, count: 2)

        XCTAssertTrue(expressionOf(harness.cef.cdp[0].params).contains(#""type":"setTheme""#),
                      "the ready-triggered theme send lands FIRST, ahead of any flushed open")

        let call = harness.cef.cdp[1]
        XCTAssertEqual(call.method, "Runtime.evaluate",
                       "the bridge is inbound-only — CDP is the ONLY way Swift speaks to the page")
        let expression = expressionOf(call.params)
        XCTAssertTrue(expression.hasPrefix("window.normaEditor.dispatch({"),
                      "one call, one literal entry point, payload as data: \(expression)")
        XCTAssertTrue(expression.contains(#""type":"openModel""#), expression)
        XCTAssertTrue(expression.contains(#""text":"const a = 1;\n""#), expression)

        // The model is recorded only once the page has actually been told.
        XCTAssertEqual(harness.runtime.stateSnapshot.models, [:])
        harness.cef.answerNextCDP() // setTheme — no state effect
        harness.cef.answerNextCDP() // openModel — records the model
        XCTAssertEqual(harness.runtime.stateSnapshot.models["/tmp/a.ts"],
                       EditorRuntimeState.ModelEntry(dirty: false))
        XCTAssertEqual(harness.runtime.stateSnapshot.current, "/tmp/a.ts")
    }

    func testAFileThatCannotBeReadOpensNoModelAndSendsNothing() async {
        let harness = makeRuntime(files: [:])
        boot(harness)

        await harness.runtime.openFile("/tmp/missing.ts")

        XCTAssertEqual(harness.cef.cdp.count, 0)
        XCTAssertEqual(harness.runtime.stateSnapshot.models, [:],
                       "a phantom model would make Swift and the page disagree about what is open")
    }

    func testTheLanguageIsLeftToThePagesOwnMonacoRegistry() {
        XCTAssertEqual(editorLanguageHint(forPath: "/tmp/a.ts"), "")
        XCTAssertEqual(editorLanguageHint(forPath: "/tmp/Dockerfile"), "")
    }

    func testActivateAndCloseSpeakOneDispatchCallEach() async {
        let harness = makeRuntime(files: ["/tmp/a.ts": "a", "/tmp/b.ts": "b"])
        boot(harness)
        await harness.runtime.openFile("/tmp/a.ts")
        harness.cef.answerNextCDP()
        await harness.runtime.openFile("/tmp/b.ts")
        harness.cef.answerNextCDP()

        harness.runtime.activate("/tmp/a.ts")
        XCTAssertTrue(expressionOf(harness.cef.cdp.last?.params).contains(#""type":"activateModel""#))
        XCTAssertEqual(harness.runtime.stateSnapshot.current, "/tmp/a.ts")

        harness.runtime.close("/tmp/a.ts")
        XCTAssertTrue(expressionOf(harness.cef.cdp.last?.params).contains(#""type":"closeModel""#))
        XCTAssertNil(harness.runtime.stateSnapshot.current)
        XCTAssertEqual(Set(harness.runtime.stateSnapshot.models.keys), ["/tmp/b.ts"])
    }

    // MARK: What the page says

    func testTheDirtyFlagFollowsThePageAndNothingElse() async {
        let harness = makeRuntime(files: ["/tmp/a.ts": "a"])
        boot(harness)
        await harness.runtime.openFile("/tmp/a.ts")
        harness.cef.answerNextCDP()

        harness.slot.deliver(browserId: 41, queryId: 2,
                             request: #"{"type":"modelDirtyChanged","path":"/tmp/a.ts","dirty":true}"#)
        XCTAssertEqual(harness.runtime.stateSnapshot.dirtyCount, 1)

        harness.slot.deliver(browserId: 41, queryId: 3,
                             request: #"{"type":"modelDirtyChanged","path":"/tmp/a.ts","dirty":false}"#)
        XCTAssertEqual(harness.runtime.stateSnapshot.dirtyCount, 0)
    }

    /// The two messages T8's save flow owns. Relayed rather than swallowed by a `switch` arm that
    /// does nothing — that is how a whole flow goes missing unnoticed.
    func testSaveRequestedAndContentResponseAreRelayedToTheirHooks() {
        let harness = makeRuntime()
        var saves: [String] = []
        var contents: [(String, UInt64, String)] = []
        harness.runtime.onSaveRequested = { saves.append($0) }
        harness.runtime.onContentResponse = { contents.append(($0, $1, $2)) }
        boot(harness)

        harness.slot.deliver(browserId: 41, queryId: 2,
                             request: #"{"type":"saveRequested","path":"/tmp/a.ts"}"#)
        harness.slot.deliver(browserId: 41, queryId: 3,
                             request: #"{"type":"contentResponse","path":"/tmp/a.ts","seq":7,"text":"hi"}"#)

        XCTAssertEqual(saves, ["/tmp/a.ts"])
        XCTAssertEqual(contents.count, 1)
        XCTAssertEqual(contents.first?.1, 7)
        XCTAssertEqual(contents.first?.2, "hi")
    }

    // MARK: Teardown

    func testTeardownReleasesTheHubRegistrationTheBrowserAndTheWindow() async {
        let harness = makeRuntime(files: ["/tmp/a.ts": "a"])
        boot(harness)
        await harness.runtime.openFile("/tmp/a.ts")
        harness.cef.answerNextCDP()

        harness.runtime.teardown()

        XCTAssertEqual(harness.hub.registeredBrowserIds, [])
        XCTAssertEqual(harness.slot.clearCount, 1, "the LAST unregister gives the slot back")
        XCTAssertEqual(harness.cef.closeCount, 1)
        XCTAssertFalse(harness.runtime.hasHiddenWindow)
        XCTAssertEqual(harness.runtime.stateSnapshot, EditorRuntimeState())
    }

    func testTeardownIsSafeFromEveryPhaseAndTwice() {
        for phase in ["idle", "booting", "ready"] {
            let harness = makeRuntime()
            if phase != "idle" { harness.cef.browserIds = [41]; harness.runtime.prewarm() }
            if phase == "ready" {
                harness.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
            }
            harness.runtime.teardown()
            harness.runtime.teardown()
            XCTAssertEqual(harness.runtime.stateSnapshot, EditorRuntimeState(), phase)
            XCTAssertEqual(harness.hub.registeredBrowserIds, [], phase)
        }
    }

    func testTeardownStopsTheIdPollSoADeadRuntimeAsksCEFForNothing() {
        let harness = makeRuntime()
        harness.cef.browserIds = [0]
        harness.runtime.prewarm()
        XCTAssertFalse(harness.scheduler.liveTimers.isEmpty)

        harness.runtime.teardown()

        XCTAssertTrue(harness.scheduler.liveTimers.isEmpty, "every timer is cancelled by teardown")
    }

    // MARK: The one page URL

    func testTheProductAndTheHarnessOpenTheSamePage() {
        XCTAssertEqual(EditorRuntime.pageURL, "norma-editor://app/editor.html")
        #if DEBUG
        XCTAssertEqual(EditorBridgeHarnessRun.pageURL, EditorRuntime.pageURL,
                       "two places writing this is two places for the scheme's URL shape to drift")
        #endif
    }

    // MARK: The viewport

    /// T5 mounts through this; T3 only owes the mechanism — the ONE view goes where the host says,
    /// and comes back to the hidden window when there is no host.
    func testTheEditorViewGoesToTheHostAndComesBackWhenItLeaves() {
        let harness = makeRuntime()
        harness.runtime.prewarm()
        let host = EditorViewportHostSpy()

        harness.runtime.viewportHost = host
        XCTAssertEqual(host.adopted.count, 1)
        XCTAssertTrue(host.adopted[0].isDescendant(of: host.container))

        harness.runtime.viewportHost = nil
        XCTAssertNotNil(host.adopted[0].window, "the view is parked, never orphaned — the browser "
                        + "(and every unsaved buffer in it) stays alive with nothing on screen")
        XCTAssertFalse(host.adopted[0].isDescendant(of: host.container))
    }

    // MARK: Plumbing

    /// The `expression` out of a recorded `Runtime.evaluate` params blob.
    private func expressionOf(_ paramsJSON: String?) -> String {
        guard let paramsJSON, let data = paramsJSON.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let expression = object["expression"] as? String else {
            return ""
        }
        return expression
    }
}
