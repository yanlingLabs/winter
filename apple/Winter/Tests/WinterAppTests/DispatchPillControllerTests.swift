import XCTest
import AppKit
import SwiftUI
@testable import Winter

/// `DispatchPillController` against a real (harness-dimmed) panel: visibility, the bottom-centred
/// frame, the grow-now/shrink-after-settle rule, key acceptance, the draft round trip, routing, the
/// swipe, the mouse gate, and the `boot()` wiring.
@MainActor
final class DispatchPillControllerTests: XCTestCase {
    private let visible = CGRect(x: 100, y: 80, width: 1440, height: 820)
    private var controllers: [DispatchPillController] = []
    /// Every pill gets its OWN `UserDefaults` suite: the test host is the app, so `.standard` is
    /// the dev app's real preferences — a dev app left on "Clear draft on close" would otherwise
    /// break every draft round trip here, and a test's write would leak into the app.
    private var defaultsSuites: [String] = []

    override func tearDown() async throws {
        controllers.forEach { $0.hide() }
        controllers.removeAll()
        defaultsSuites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        defaultsSuites.removeAll()
        try await super.tearDown()
    }

    private func makeSettings(_ expiry: DispatchPillDraftExpiry? = nil) -> DispatchPillSettings {
        let suite = "WinterTests.DispatchPill.\(UUID().uuidString)"
        defaultsSuites.append(suite)
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: suite)!)
        if let expiry { settings.setDraftExpiry(expiry) }
        return settings
    }

    private func makePill(_ session: SessionModel? = nil,
                          settings: DispatchPillSettings? = nil) -> DispatchPillController {
        let pill = DispatchPillController(session: session ?? SessionModel(), settings: settings ?? makeSettings())
        pill.visibleFrameOverrideForTesting = visible
        controllers.append(pill)
        return pill
    }

    /// A clock a test moves by hand.
    private final class Clock {
        var now: Date
        init(_ now: Date) { self.now = now }
        func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    private let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)

    /// A pill on `expiry`, reading `clock`, shown with `draft` typed into it.
    private func pillWithDraft(_ draft: String, expiry: DispatchPillDraftExpiry,
                               clock: Clock? = nil) -> DispatchPillController {
        let pill = makePill(settings: makeSettings(expiry))
        if let clock { pill.nowOverrideForTesting = { clock.now } }
        pill.show()
        pill.adapter.composerDraft = draft
        return pill
    }

    private func waitForSpring(_ pill: DispatchPillController, timeout: TimeInterval = 4) {
        let deadline = Date().addingTimeInterval(timeout)
        while !pill.isSpringIdleForTesting, Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
    }

    private func canvas(for main: CGSize) -> CGSize {
        dispatchPillCanvasSize(mainSize: main, accessorySize: .zero)
    }

    private let compactMain = CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)

    // MARK: - Construction

    func testConstructionHasNoSideEffects() {
        let pill = makePill()
        XCTAssertFalse(pill.isVisible)
        XCTAssertFalse(pill.panelIsVisibleForTesting, "constructing the pill must not order a window in")
        XCTAssertEqual(pill.monitorCountForTesting, 0, "no event monitors until the pill is shown")
        XCTAssertFalse(pill.panelAcceptsKeyForTesting)
        XCTAssertFalse(pill.panelCanBecomeKeyForTesting)
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testPanelLevelAndSpacesBehaviourMirrorTheOrb() {
        let pill = makePill()
        XCTAssertEqual(pill.panelLevelForTesting, .screenSaver)
        let behaviour = pill.panelCollectionBehaviorForTesting
        XCTAssertTrue(behaviour.contains(.canJoinAllSpaces))
        XCTAssertTrue(behaviour.contains(.fullScreenAuxiliary))
        XCTAssertTrue(behaviour.contains(.stationary))
        XCTAssertTrue(behaviour.contains(.ignoresCycle))
    }

    // MARK: - Show / hide

    func testShowAnchorsTheCompactPillBottomCentredAboveTheDock() {
        let pill = makePill()
        pill.show()
        XCTAssertTrue(pill.isVisible)
        XCTAssertTrue(pill.panelIsVisibleForTesting)
        let frame = pill.panelFrameForTesting
        XCTAssertEqual(frame.size, canvas(for: compactMain))
        XCTAssertEqual(frame.midX, visible.midX, accuracy: 0.5)
        // The PILL's bottom edge sits 12pt above the visible frame; the shadow margin hangs below.
        XCTAssertEqual(frame.minY + DispatchPillMetrics.shadowPad, visible.minY + DispatchPillMetrics.dockGap)
        XCTAssertTrue(pill.panelAcceptsKeyForTesting, "a summon takes the keyboard — it is for typing")
        XCTAssertGreaterThan(pill.keyAssertionCountForTesting, 0)
        XCTAssertEqual(pill.monitorCountForTesting, 6, "Esc, swipe, click-outside ×2, mouse gate ×2")
    }

    func testHideRemovesTheMonitorsAndOrdersOut() {
        let pill = makePill()
        pill.show()
        pill.hide()
        XCTAssertFalse(pill.isVisible)
        XCTAssertFalse(pill.panelIsVisibleForTesting)
        XCTAssertEqual(pill.monitorCountForTesting, 0)
        XCTAssertFalse(pill.panelAcceptsKeyForTesting)
    }

    func testHideStashesTheDraftAndTheNextShowRestoresItExpanded() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "half a thought"
        waitUntil { pill.presentation == .expanded }
        XCTAssertEqual(pill.presentation, .expanded)
        pill.hide()
        XCTAssertEqual(pill.adapter.composerDraft, "", "hidden, the draft lives in the DraftCache")
        pill.show()
        XCTAssertEqual(pill.adapter.composerDraft, "half a thought")
        XCTAssertEqual(pill.presentation, .expanded)
    }

    // MARK: - The trigger (4-finger tap)

    func testTriggerShowsHidesAndCollapsesFullScreen() {
        let pill = makePill()
        pill.handleTrigger()
        XCTAssertTrue(pill.isVisible)
        pill.handleTrigger()
        XCTAssertFalse(pill.isVisible)
        pill.handleTrigger()
        pill.requestFullScreen()
        XCTAssertEqual(pill.presentation, .fullScreen)
        pill.handleTrigger()
        XCTAssertTrue(pill.isVisible, "a tap in full screen collapses — it does not hide")
        XCTAssertEqual(pill.presentation, .compact)
    }

    // MARK: - Typing, and the two-instant resize rule

    func testTypingInTheCompactPillExpandsItAndGrowsTheCanvasBeforeTheSpringRuns() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "h"
        waitUntil { pill.presentation == .expanded }
        XCTAssertEqual(pill.presentation, .expanded)
        // GROW-FIRST: the frame is already the expanded canvas…
        XCTAssertEqual(pill.panelFrameForTesting.width, pill.canvas.size.width)
        XCTAssertEqual(pill.canvas.size.width,
                       DispatchPillMetrics.expandedWidth + 2 * DispatchPillMetrics.shadowPad)
        // …while the shape has not moved yet: the spring animates INTO room that already exists.
        XCTAssertEqual(pill.morph.size.width, DispatchPillMetrics.compactWidth)
        XCTAssertFalse(pill.isSpringIdleForTesting)
        XCTAssertEqual(pill.panelFrameForTesting.midX, visible.midX, accuracy: 0.5, "grows about its midX")
        waitForSpring(pill)
        XCTAssertEqual(pill.morph.size.width, DispatchPillMetrics.expandedWidth)
    }

    func testCompressingShrinksTheFrameOnlyOnceTheSpringHasSettled() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "draft"
        waitUntil { pill.presentation == .expanded }
        waitForSpring(pill)
        let expandedCanvas = pill.canvas.size
        XCTAssertTrue(pill.handleEscape(), "Esc in the typing pill compresses it")
        XCTAssertEqual(pill.presentation, .compact)
        // SHRINK-LATER: mid-spring, the frame still has the expanded room.
        XCTAssertEqual(pill.panelFrameForTesting.size, expandedCanvas)
        waitForSpring(pill)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(pill.panelFrameForTesting.size, canvas(for: compactMain))
        XCTAssertEqual(pill.panelFrameForTesting.midX, visible.midX, accuracy: 0.5)
        XCTAssertEqual(pill.panelFrameForTesting.minY + DispatchPillMetrics.shadowPad,
                       visible.minY + DispatchPillMetrics.dockGap, "the bottom edge never moves")
    }

    // MARK: - Click outside

    func testClickOutsideCompressesKeepsTheDraftAndStopsTakingTheKeyboard() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "keep me"
        pill.handleClickOutside()
        XCTAssertTrue(pill.isVisible, "click outside never hides")
        XCTAssertEqual(pill.presentation, .compact)
        XCTAssertEqual(pill.adapter.composerDraft, "", "the compact pill shows its placeholder…")
        XCTAssertFalse(pill.panelAcceptsKeyForTesting, "…and stops taking the keyboard")
        XCTAssertNil(pill.draftExpiryDeadlineForTesting, "a click outside never starts the draft countdown")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
        pill.hide()
        pill.show()
        XCTAssertEqual(pill.adapter.composerDraft, "keep me", "…and the draft survived in the DraftCache")
    }

    /// The restore takes the draft OUT of the cache: text deleted after it came back must not be
    /// resurrected by the next summon.
    func testADraftDeletedAfterItsRestoreStaysDeleted() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "temporary"
        pill.handleClickOutside()
        pill.hide()
        pill.show()
        XCTAssertEqual(pill.adapter.composerDraft, "temporary")
        pill.adapter.composerDraft = ""
        pill.hide()
        pill.show()
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testClickOutsideFullScreenCompressesToThePill() {
        let pill = makePill()
        pill.show()
        pill.requestFullScreen()
        pill.handleClickOutside()
        XCTAssertEqual(pill.presentation, .compact)
        XCTAssertTrue(pill.isVisible)
    }

    /// A click-outside stash, with the pill still on screen, never ages out: the pill's cache has no
    /// expiry of its own, and the countdown only runs while the pill is put away.
    func testAClickOutsideStashSurvivesAnyTimeOnScreen() {
        let clock = Clock(t0)
        let pill = pillWithDraft("still here", expiry: .fiveMinutes, clock: clock)
        pill.handleClickOutside()
        clock.advance(86_400)
        XCTAssertEqual(pill.stashedDraftForTesting, "still here")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
    }

    // MARK: - Draft expiry (the put-away pill's countdown)

    /// The 4-finger tap puts the pill away and starts the countdown; reopening before it runs out
    /// cancels it and keeps the draft; the next close starts a FRESH, full countdown.
    func testTheTapStartsTheCountdownAReopenCancelsItAndTheNextCloseStartsAfresh() {
        let clock = Clock(t0)
        let pill = pillWithDraft("half a thought", expiry: .tenMinutes, clock: clock)
        XCTAssertNil(pill.draftExpiryDeadlineForTesting, "no countdown while the pill is on screen")

        pill.handleTrigger()
        XCTAssertFalse(pill.isVisible)
        XCTAssertEqual(pill.draftExpiryDeadlineForTesting, t0.addingTimeInterval(600))
        XCTAssertTrue(pill.draftExpiryTimerArmedForTesting)
        XCTAssertEqual(pill.stashedDraftForTesting, "half a thought")

        clock.advance(300)
        pill.handleTrigger()
        XCTAssertTrue(pill.isVisible)
        XCTAssertEqual(pill.adapter.composerDraft, "half a thought", "reopened in time: the draft is back")
        XCTAssertNil(pill.draftExpiryDeadlineForTesting, "…and the countdown is cancelled")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)

        clock.advance(100)
        pill.handleTrigger()
        XCTAssertEqual(pill.draftExpiryDeadlineForTesting, t0.addingTimeInterval(400 + 600),
                       "the next close starts a full countdown from ITS moment, not the first close's")
    }

    /// A real timer, on the real run loop: it fires while the pill is away and the draft is gone.
    func testTheCountdownRunningOutClearsThePutAwayDraft() {
        let pill = pillWithDraft("gone soon", expiry: .fiveMinutes)
        pill.draftExpiryIntervalOverrideForTesting = 0.05
        pill.handleTrigger()
        XCTAssertEqual(pill.stashedDraftForTesting, "gone soon")
        waitUntil { pill.stashedDraftForTesting == nil }
        XCTAssertNil(pill.stashedDraftForTesting, "the countdown ran out: the draft is cleared")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.presentation, .compact)
    }

    /// A timer set by an earlier close must not fire into a later one: reopen and close again
    /// inside the first countdown, wait past where it would have run out, and the draft is still
    /// there — then the SECOND countdown clears it.
    func testACancelledCountdownNeverFiresIntoTheNextClose() {
        // Wide margins, so a loaded run loop cannot make the test fail for the wrong reason: the
        // first countdown would end at ~1.0 s, the second at ~1.4 s, and the check lands at ~1.2 s.
        let pill = pillWithDraft("second chance", expiry: .fiveMinutes)
        pill.draftExpiryIntervalOverrideForTesting = 1.0
        pill.handleTrigger()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "second chance")
        pill.handleTrigger()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        XCTAssertEqual(pill.stashedDraftForTesting, "second chance",
                       "past the FIRST countdown's end, the draft is still kept")
        waitUntil(timeout: 3) { pill.stashedDraftForTesting == nil }
        XCTAssertNil(pill.stashedDraftForTesting, "the second countdown clears it")
    }

    func testClearDraftOnCloseClearsItTheMomentThePillIsPutAway() {
        let pill = pillWithDraft("not kept", expiry: .onClose)
        pill.handleTrigger()
        XCTAssertNil(pill.stashedDraftForTesting)
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting, "nothing left to count down")
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testNeverKeepsThePutAwayDraftWithNoCountdown() {
        let clock = Clock(t0)
        let pill = pillWithDraft("forever", expiry: .never, clock: clock)
        pill.handleTrigger()
        XCTAssertNil(pill.draftExpiryDeadlineForTesting)
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
        clock.advance(86_400 * 7)
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "forever")
        XCTAssertEqual(pill.presentation, .expanded)
    }

    /// A `Timer` is not promised to fire on time across a sleep: a deadline that passed while the
    /// timer was held back still clears the draft on the reopen, before it could be restored.
    func testADeadlinePassedWhileAwayClearsTheDraftOnTheReopen() {
        let clock = Clock(t0)
        let pill = pillWithDraft("slept through", expiry: .fiveMinutes, clock: clock)
        pill.handleTrigger()
        clock.advance(301)
        XCTAssertTrue(pill.draftExpiryTimerArmedForTesting, "the real timer has not run")
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.presentation, .compact)
        XCTAssertNil(pill.stashedDraftForTesting)
    }

    /// A setting changed while the pill is away applies to the countdown already running,
    /// measured from the close: shorter-than-elapsed clears now, longer re-arms, `never` stops it.
    func testASettingChangedWhileThePillIsAwayAppliesToTheRunningCountdown() {
        let clock = Clock(t0)
        let pill = pillWithDraft("moving target", expiry: .fifteenMinutes, clock: clock)
        pill.handleTrigger()
        XCTAssertEqual(pill.draftExpiryDeadlineForTesting, t0.addingTimeInterval(900))

        clock.advance(6 * 60)
        pill.settings.setDraftExpiry(.tenMinutes)
        XCTAssertEqual(pill.draftExpiryDeadlineForTesting, t0.addingTimeInterval(600),
                       "measured from the close, not from the change")
        XCTAssertTrue(pill.draftExpiryTimerArmedForTesting)

        pill.settings.setDraftExpiry(.never)
        XCTAssertNil(pill.draftExpiryDeadlineForTesting)
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
        XCTAssertEqual(pill.stashedDraftForTesting, "moving target")

        pill.settings.setDraftExpiry(.fifteenMinutes)
        XCTAssertEqual(pill.draftExpiryDeadlineForTesting, t0.addingTimeInterval(900),
                       "back from never: still measured from the original close")

        pill.settings.setDraftExpiry(.fiveMinutes)
        XCTAssertNil(pill.stashedDraftForTesting, "six minutes away already: five minutes has run out")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
    }

    func testChangingToClearOnCloseWhileAwayClearsAtOnce() {
        let pill = pillWithDraft("now", expiry: .never)
        pill.handleTrigger()
        pill.settings.setDraftExpiry(.onClose)
        XCTAssertNil(pill.stashedDraftForTesting)
    }

    /// While the pill is on screen a setting change starts nothing; the next close uses it.
    func testASettingChangedWhileVisibleTakesEffectAtTheNextClose() {
        let pill = pillWithDraft("typed", expiry: .fifteenMinutes)
        pill.settings.setDraftExpiry(.onClose)
        XCTAssertEqual(pill.adapter.composerDraft, "typed", "nothing happens to a draft on screen")
        XCTAssertFalse(pill.draftExpiryTimerArmedForTesting)
        pill.handleTrigger()
        XCTAssertNil(pill.stashedDraftForTesting)
    }

    /// A sent draft leaves nothing to expire: the countdown after a send has nothing to clear and
    /// never resurrects anything.
    func testAfterASendTheCloseHasNoDraftToKeep() async {
        let pill = pillWithDraft("sent", expiry: .never)
        pill.onSubmit = { _ in true }
        pill.submit("sent")
        for _ in 0..<50 where !pill.adapter.composerDraft.isEmpty {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        pill.handleTrigger()
        XCTAssertNil(pill.stashedDraftForTesting)
        pill.handleTrigger()
        XCTAssertEqual(pill.adapter.composerDraft, "")
    }

    // MARK: - The draft-expiry setting

    func testTheDraftExpiryOptionsAreStoredUnderTheirFixedSpellings() {
        XCTAssertEqual(DispatchPillDraftExpiry.allCases.map(\.rawValue),
                       ["onClose", "5min", "10min", "15min", "never"])
        XCTAssertEqual(DispatchPillDraftExpiry.allCases.map(\.label),
                       ["Clear draft on close", "5 min", "10 min", "15 min", "Never"])
        XCTAssertEqual(DispatchPillDraftExpiry.allCases.map(\.interval), [0, 300, 600, 900, nil])
        XCTAssertEqual(DispatchPillDraftExpiry.default, .fifteenMinutes)
        XCTAssertEqual(DispatchPillDraftExpiry(storedValue: nil), .fifteenMinutes)
        XCTAssertEqual(DispatchPillDraftExpiry(storedValue: "1h"), .fifteenMinutes, "unrecognised → default")
        XCTAssertEqual(DispatchPillDraftExpiry(storedValue: "never"), .never)
        XCTAssertEqual(dispatchPillDraftExpiryDeadline(closedAt: t0, interval: 300), t0.addingTimeInterval(300))
        XCTAssertEqual(dispatchPillDraftExpiryDeadline(closedAt: t0, interval: 0), t0)
        XCTAssertNil(dispatchPillDraftExpiryDeadline(closedAt: t0, interval: nil))
    }

    func testTheSettingsStoreReadsWithoutWritingAndPersistsAChange() {
        let suite = "WinterTests.DispatchPill.\(UUID().uuidString)"
        defaultsSuites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        let store = DispatchPillSettings(defaults: defaults)
        XCTAssertEqual(store.draftExpiry, .fifteenMinutes)
        XCTAssertNil(defaults.object(forKey: DispatchPillSettings.draftExpiryKey),
                     "constructing the store writes nothing")
        store.setDraftExpiry(.tenMinutes)
        XCTAssertEqual(defaults.string(forKey: "dispatchPillDraftExpiry"), "10min")
        XCTAssertEqual(DispatchPillSettings(defaults: defaults).draftExpiry, .tenMinutes,
                       "a later launch reads it back")
        defaults.set("garbage", forKey: DispatchPillSettings.draftExpiryKey)
        XCTAssertEqual(DispatchPillSettings(defaults: defaults).draftExpiry, .fifteenMinutes)
    }

    // MARK: - Esc

    func testEscWhileATurnRunsInterruptsAndLeavesTheShapeAlone() {
        let pill = makePill()
        var interrupted = 0
        pill.onEsc = { interrupted += 1; return true }
        pill.show()
        pill.requestFullScreen()
        XCTAssertTrue(pill.handleEscape())
        XCTAssertEqual(interrupted, 1)
        XCTAssertEqual(pill.presentation, .fullScreen, "an interrupt does not also leave full screen")
    }

    func testEscLeavesFullScreenToTheTypingPillWhenThereIsADraft() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "keep typing"
        pill.requestFullScreen()
        pill.handleEscape()
        XCTAssertEqual(pill.presentation, .expanded)
        pill.requestFullScreen()
        pill.adapter.composerDraft = ""
        pill.handleEscape()
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testEscInTheIdleCompactPillHandsTheKeyboardBack() {
        let pill = makePill()
        pill.show()
        XCTAssertTrue(pill.panelAcceptsKeyForTesting)
        pill.handleEscape()
        XCTAssertTrue(pill.isVisible)
        XCTAssertFalse(pill.panelAcceptsKeyForTesting)
    }

    // MARK: - Full screen

    func testFullScreenGrowsTheFrameToTheVisibleFrameAtOnce() {
        let pill = makePill()
        pill.show()
        pill.requestFullScreen()
        let main = dispatchPillMainSize(presentation: .fullScreen, composerContentHeight: 0,
                                        visibleFrame: visible)
        XCTAssertEqual(pill.panelFrameForTesting.size, canvas(for: main))
        XCTAssertEqual(pill.morph.target, main)
        XCTAssertEqual(pill.panelFrameForTesting.midX, visible.midX, accuracy: 0.5)
        pill.closeFullScreen()
        XCTAssertEqual(pill.presentation, .compact)
    }

    // MARK: - Submit

    func testASuccessfulSendClearsTheDraftAndReturnsToTheCompactPill() async {
        let pill = makePill()
        var sent: [String] = []
        pill.onSubmit = { text in sent.append(text); return true }
        pill.show()
        pill.adapter.composerDraft = "ship it"
        pill.submit("ship it")
        for _ in 0..<50 where !pill.adapter.composerDraft.isEmpty {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(sent, ["ship it"])
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testAFailedSendKeepsTheDraft() async {
        let pill = makePill()
        var attempts = 0
        pill.onSubmit = { _ in attempts += 1; return false }
        pill.show()
        pill.adapter.composerDraft = "not lost"
        pill.submit("not lost")
        for _ in 0..<50 where attempts == 0 {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(pill.adapter.composerDraft, "not lost")
        XCTAssertEqual(pill.presentation, .expanded)
    }

    func testABlankSubmitSendsNothing() {
        let pill = makePill()
        var sent = 0
        pill.onSubmit = { _ in sent += 1; return true }
        pill.submit("   \n ")
        XCTAssertEqual(sent, 0)
    }

    // MARK: - Commands typed into the pill (2026-10-07)

    func testLocalCommandsAreTheWholeMessageOnly() {
        XCTAssertEqual(dispatchPillLocalCommand("/permissions"), .permissions)
        XCTAssertEqual(dispatchPillLocalCommand("  /Permissions \n"), .permissions)
        XCTAssertEqual(dispatchPillLocalCommand("/spawn"), .spawn)
        XCTAssertNil(dispatchPillLocalCommand("/compact"), "the session's own built-in — sent as typed")
        XCTAssertEqual(dispatchPillLocalCommand("/permissions please"), .unknownPermissions("please"),
                       "an argument that names no mode is answered, not sent")
        XCTAssertNil(dispatchPillLocalCommand("what are my /permissions"))
    }

    func testSlashMenuMatchesAndPicksTheClosest() {
        XCTAssertEqual(dispatchPillMenu(draft: "/")?.matches, ["compact", "permissions", "spawn"])
        XCTAssertEqual(dispatchPillMenu(draft: "/")?.best, "compact")
        // The prefix match leads; commands that merely contain the letter follow.
        XCTAssertEqual(dispatchPillMenu(draft: "/p")?.matches, ["permissions", "compact", "spawn"])
        XCTAssertEqual(dispatchPillMenu(draft: "/p")?.best, "permissions")
        XCTAssertEqual(dispatchPillMenu(draft: "/pe")?.matches, ["permissions"])
        XCTAssertEqual(dispatchPillMenu(draft: "/SP")?.best, "spawn", "case-insensitive")
        // Prefix matches first, then the ones that merely contain what is typed.
        XCTAssertEqual(dispatchPillMenu(draft: "/a")?.matches, ["compact", "spawn"])
        XCTAssertNil(dispatchPillMenu(draft: "/zzz"), "nothing matches: no menu")
        XCTAssertNil(dispatchPillMenu(draft: "/compact keep the API"), "past the space it is the command's arguments")
        XCTAssertNil(dispatchPillMenu(draft: "hello"))
    }

    func testEnterCompletesThenSubmits() {
        XCTAssertEqual(dispatchPillEnterAction(draft: "/per"), .complete("/permissions"))
        XCTAssertEqual(dispatchPillEnterAction(draft: "/"), .complete("/compact"))
        XCTAssertEqual(dispatchPillEnterAction(draft: "/permissions"), .submit)
        XCTAssertEqual(dispatchPillEnterAction(draft: "/zzz"), .submit)
        XCTAssertEqual(dispatchPillEnterAction(draft: "hello"), .submit)
    }

    func testAFullyTypedCommandIsHighlighted() {
        XCTAssertEqual(dispatchPillCommandHighlightRange("/permissions"), NSRange(location: 0, length: 12))
        XCTAssertEqual(dispatchPillCommandHighlightRange("/compact keep the API"), NSRange(location: 0, length: 8))
        XCTAssertNil(dispatchPillCommandHighlightRange("/perm"))
        XCTAssertNil(dispatchPillCommandHighlightRange("hello /compact"))
        XCTAssertNil(dispatchPillCommandHighlightRange("/compaction"))
    }

    func testTheFirstEnterCompletesTheSecondRuns() {
        let pill = makePill()
        var sent = 0
        pill.onSubmit = { _ in sent += 1; return true }
        pill.currentPolicy = { "auto" }
        pill.show()
        pill.adapter.composerDraft = "/per"
        pill.submit("/per")
        XCTAssertEqual(pill.adapter.composerDraft, "/permissions", "completed to the closest match")
        XCTAssertFalse(pill.permissionsPickerOpen)
        pill.submit(pill.adapter.composerDraft)
        XCTAssertTrue(pill.permissionsPickerOpen)
        XCTAssertEqual(sent, 0)
    }

    func testAMenuClickRunsTheCommand() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "/"
        pill.runMenuCommand("spawn")
        XCTAssertEqual(pill.commandNotice, dispatchPillSpawnComingSoon)
        XCTAssertEqual(pill.adapter.composerDraft, "")
    }

    func testThePickerIsTheMainPillAndEscGoesBack() {
        let pill = makePill()
        pill.currentPolicy = { "auto" }
        pill.show()
        pill.submit("/permissions")
        XCTAssertTrue(pill.permissionsPickerOpen)
        XCTAssertEqual(pill.morph.target, CGSize(width: DispatchPillMetrics.permissionsPickerWidth, height: DispatchPillMetrics.pillHeight),
                       "the main pill morphs into the picker")
        XCTAssertTrue(pill.handleEscape())
        XCTAssertFalse(pill.permissionsPickerOpen)
        XCTAssertEqual(pill.morph.target.width, DispatchPillMetrics.compactWidth, "and back into the composer")
    }

    func testPermissionModesMenuAfterTheSpace() {
        let all = dispatchPillMenu(draft: "/permissions ", currentPolicy: "auto")
        XCTAssertEqual(all?.kind, .permissionModes)
        XCTAssertEqual(all?.matches, ["dont-ask", "ask", "accept-edits", "auto", "bypass"])
        XCTAssertEqual(all?.current, "auto")
        XCTAssertEqual(dispatchPillMenu(draft: "/permissions acc")?.best, "accept-edits")
        XCTAssertEqual(dispatchPillMenu(draft: "/permissions accept e")?.matches, ["accept-edits"])
        XCTAssertEqual(dispatchPillMenu(draft: "/permissions dont")?.best, "dont-ask")
        XCTAssertEqual(dispatchPillMenu(draft: "/Permissions AU")?.best, "auto")
        XCTAssertNil(dispatchPillMenu(draft: "/permissions xyz"), "nothing matches: no menu")
        XCTAssertEqual(dispatchPillMenu(draft: "/permissions accept edits")?.item("accept-edits")?.completion, "/permissions accept edits")
        XCTAssertEqual(dispatchPillMenu(draft: "/permissions")?.kind, .commands, "no space yet: still the command list")
    }

    func testModeNamesMatchHoweverTheyAreSpelled() {
        XCTAssertEqual(dispatchPillPermissionMode("auto"), "auto")
        XCTAssertEqual(dispatchPillPermissionMode("Accept Edits"), "accept-edits")
        XCTAssertEqual(dispatchPillPermissionMode("accept-edits"), "accept-edits")
        XCTAssertEqual(dispatchPillPermissionMode("accept   edits "), "accept-edits")
        XCTAssertEqual(dispatchPillPermissionMode("don't ask"), "dont-ask")
        XCTAssertEqual(dispatchPillPermissionMode("dont ask"), "dont-ask")
        XCTAssertNil(dispatchPillPermissionMode("plan"), "Dispatch cannot hold plan")
        XCTAssertNil(dispatchPillPermissionMode("acc"))
    }

    func testPermissionsWithAModeIsItsOwnCommand() {
        XCTAssertEqual(dispatchPillLocalCommand("/permissions"), .permissions)
        XCTAssertEqual(dispatchPillLocalCommand("/permissions auto"), .setPermissions("auto"))
        XCTAssertEqual(dispatchPillLocalCommand("/permissions accept edits"), .setPermissions("accept-edits"))
        XCTAssertEqual(dispatchPillLocalCommand("/permissions  Bypass "), .setPermissions("bypass"))
        XCTAssertEqual(dispatchPillLocalCommand("/permissions nope"), .unknownPermissions("nope"))
        // Enter completes a partly typed mode first; a mode typed in full submits at once.
        XCTAssertEqual(dispatchPillEnterAction(draft: "/permissions acc"), .complete("/permissions accept edits"))
        XCTAssertEqual(dispatchPillEnterAction(draft: "/permissions accept edits"), .submit)
        XCTAssertEqual(dispatchPillEnterAction(draft: "/permissions accept-edits"), .submit)
        // …and reads in blue as a whole once it names a mode.
        XCTAssertEqual(dispatchPillCommandHighlightRange("/permissions accept edits"), NSRange(location: 0, length: 25))
        XCTAssertEqual(dispatchPillCommandHighlightRange("/permissions acc"), NSRange(location: 0, length: 12))
    }

    func testArrowsWalkTheMatchingRowsAndWrap() {
        let menu = dispatchPillMenu(draft: "/")!
        XCTAssertEqual(menu.moved(from: nil, down: true), "permissions", "from the closest match")
        XCTAssertEqual(menu.moved(from: "spawn", down: true), "compact", "wraps")
        XCTAssertEqual(menu.moved(from: "compact", down: false), "spawn")
        let narrowed = dispatchPillMenu(draft: "/a")!   // compact, spawn match; permissions does not
        XCTAssertEqual(narrowed.moved(from: "compact", down: true), "spawn", "skips rows that do not match")
    }

    func testArrowsThenEnterRunsTheRowAtOnce() {
        let pill = makePill()
        var sent = 0
        pill.onSubmit = { _ in sent += 1; return true }
        pill.currentPolicy = { "auto" }
        pill.show()
        pill.adapter.composerDraft = "/"
        XCTAssertTrue(pill.handleMenuKey(.down))
        XCTAssertEqual(pill.menuSelection, "permissions")
        XCTAssertTrue(pill.handleMenuKey(.enter), "Enter on a row the arrows chose runs it")
        XCTAssertTrue(pill.permissionsPickerOpen)
        XCTAssertEqual(sent, 0)
        XCTAssertFalse(makePill().handleMenuKey(.up), "no menu: the arrow is the caret's")
    }

    func testPermissionsWithAModeSetsItAndSaysSo() async {
        let pill = makePill()
        var set: [String] = []
        pill.currentPolicy = { "auto" }
        pill.onSetPolicy = { set.append($0); return true }
        pill.show()
        pill.adapter.composerDraft = "/permissions accept edits"
        pill.submit("/permissions accept edits")
        for _ in 0..<100 where pill.commandNotice == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(set, ["accept-edits"])
        XCTAssertEqual(pill.adapter.sessionPolicy, "accept-edits")
        XCTAssertEqual(pill.commandNotice, "Permissions set to Accept Edits")
        XCTAssertFalse(pill.permissionsPickerOpen, "a mode named in the command opens no picker")
        XCTAssertEqual(pill.adapter.composerDraft, "")
    }

    func testPickerChipsFollowTheArrowKeys() async {
        let pill = makePill()
        var set: [String] = []
        pill.currentPolicy = { "auto" }
        pill.onSetPolicy = { set.append($0); return true }
        pill.show()
        pill.openPermissionsPicker()
        XCTAssertEqual(pill.pickerFocus, "auto", "the keyboard starts on the current mode")
        XCTAssertTrue(pill.handleHorizontalKey(left: false))
        XCTAssertEqual(pill.pickerFocus, "bypass")
        XCTAssertTrue(pill.handleMenuKey(.down))
        XCTAssertEqual(pill.pickerFocus, "dont-ask", "wraps")
        XCTAssertTrue(pill.handleMenuKey(.up))
        XCTAssertEqual(pill.pickerFocus, "bypass")
        XCTAssertTrue(pill.handleMenuKey(.enter))
        for _ in 0..<100 where pill.permissionsPickerOpen { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(set, ["bypass"])
        XCTAssertFalse(makePill().handleHorizontalKey(left: true), "no picker: the arrow is the caret's")
    }

    func testElapsedText() {
        XCTAssertEqual(dispatchPillElapsedText(seconds: 0), "0:00")
        XCTAssertEqual(dispatchPillElapsedText(seconds: 7), "0:07")
        XCTAssertEqual(dispatchPillElapsedText(seconds: 161), "2:41")
        XCTAssertEqual(dispatchPillElapsedText(seconds: 3725), "1:02:05")
        XCTAssertEqual(dispatchPillElapsedText(seconds: -3), "0:00")
    }

    func testPermissionsOpensThePickerAndSendsNothing() {
        let pill = makePill()
        var sent = 0
        pill.onSubmit = { _ in sent += 1; return true }
        pill.currentPolicy = { "auto" }
        pill.show()
        pill.adapter.composerDraft = "/permissions"
        pill.submit("/permissions")
        XCTAssertEqual(sent, 0, "a local command never reaches the session")
        XCTAssertTrue(pill.permissionsPickerOpen)
        XCTAssertEqual(pill.adapter.composerDraft, "", "the command line is spent")
        XCTAssertEqual(pill.adapter.sessionPolicy, "auto")
        XCTAssertTrue(pill.adapter.sessionPolicyKnown)
        pill.closePermissionsPicker()
        XCTAssertFalse(pill.permissionsPickerOpen)
    }

    func testPickingAModeSetsItAndThePickerCloses() async {
        let pill = makePill()
        var set: [String] = []
        pill.currentPolicy = { "auto" }
        pill.onSetPolicy = { set.append($0); return true }
        pill.show()
        pill.openPermissionsPicker()
        pill.choosePolicy("bypass")
        for _ in 0..<100 where pill.permissionsPickerOpen { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(set, ["bypass"])
        XCTAssertEqual(pill.adapter.sessionPolicy, "bypass")
        XCTAssertFalse(pill.permissionsPickerOpen)
        XCTAssertNil(pill.policyPending)
    }

    func testARefusedModeSaysSoAndKeepsThePickerOpen() async {
        let pill = makePill()
        pill.currentPolicy = { "auto" }
        pill.onSetPolicy = { _ in false }
        pill.show()
        pill.openPermissionsPicker()
        pill.choosePolicy("bypass")
        for _ in 0..<100 where pill.adapter.policyRefusal == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(pill.adapter.policyRefusal, policyRefusalText("bypass"))
        XCTAssertEqual(pill.adapter.sessionPolicy, "auto", "a refused change leaves the true mode")
        XCTAssertTrue(pill.permissionsPickerOpen)
    }

    func testSpawnSaysItIsNotAvailableYetAndSendsNothing() {
        let pill = makePill()
        var sent = 0
        pill.onSubmit = { _ in sent += 1; return true }
        pill.show()
        pill.adapter.composerDraft = "/spawn"
        pill.submit("/spawn")
        XCTAssertEqual(sent, 0)
        XCTAssertEqual(pill.adapter.composerDraft, "")
        XCTAssertEqual(pill.commandNotice, dispatchPillSpawnComingSoon)

        // Once Cowork windows exist, the same command runs the hook instead.
        let wired = makePill()
        var spawned = 0
        wired.onSpawnCowork = { spawned += 1 }
        wired.show()
        wired.submit("/spawn")
        XCTAssertEqual(spawned, 1)
        XCTAssertNil(wired.commandNotice)
    }

    func testPickingTheCurrentModeJustCloses() {
        let pill = makePill()
        var set = 0
        pill.currentPolicy = { "ask" }
        pill.onSetPolicy = { _ in set += 1; return true }
        pill.show()
        pill.openPermissionsPicker()
        pill.choosePolicy("ask")
        XCTAssertEqual(set, 0)
        XCTAssertFalse(pill.permissionsPickerOpen)
    }

    // MARK: - The 2-finger swipe

    func testSwipingOlderPinsTheNewestTurnAndExpandsTheCompactPill() {
        let session = SessionModel()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "one", reply: "a"), Exchange(prompt: "two", reply: "b"),
                           Exchange(prompt: "three", reply: "c")]
        }
        let pill = makePill(session)
        pill.show()
        XCTAssertTrue(pill.handleSwipe(.right), "right = older")
        XCTAssertEqual(pill.historyIndex, 2)
        XCTAssertEqual(pill.presentation, .expanded)
        XCTAssertEqual(pill.turnPreview?.prompt, "three")
        XCTAssertEqual(pill.morph.target.height, dispatchPillPreviewHeight(reply: "c"),
                       "the pinned turn shows alone, at its own height")
        pill.handleSwipe(.right)
        XCTAssertEqual(pill.historyIndex, 1)
        pill.handleSwipe(.left)
        pill.handleSwipe(.left)
        XCTAssertNil(pill.historyIndex, "newer past the newest turn: back to the composer")
        XCTAssertEqual(pill.presentation, .expanded, "and the pill stays expanded")
        XCTAssertFalse(pill.handleSwipe(.left), "nothing newer than the composer")
    }

    func testTypingLeavesASwipedToTurn() {
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "one", reply: "a")] }
        let pill = makePill(session)
        pill.show()
        pill.handleSwipe(.right)
        XCTAssertEqual(pill.historyIndex, 0)
        pill.adapter.composerDraft = "n"
        waitUntil { pill.historyIndex == nil }
        XCTAssertNil(pill.historyIndex)
    }

    func testEscLeavesASwipedToTurnBeforeItCompresses() {
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "one", reply: "a")] }
        let pill = makePill(session)
        pill.show()
        pill.handleSwipe(.right)
        pill.handleEscape()
        XCTAssertNil(pill.historyIndex)
        XCTAssertEqual(pill.presentation, .expanded)
    }

    func testSwipeIsInertInFullScreen() {
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "one", reply: "a")] }
        let pill = makePill(session)
        pill.show()
        pill.requestFullScreen()
        XCTAssertFalse(pill.handleSwipe(.right))
        XCTAssertNil(pill.historyIndex)
    }

    // MARK: - A reply opens the pill

    func testAReplyArrivingOpensTheCompactPillOnIt() {
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "old", reply: "old reply")] }
        let pill = makePill(session)
        pill.show()
        session.applyForTesting { s in
            s.turnRunning = true
            s.exchanges.append(Exchange(prompt: "check the build", reply: ""))
        }
        XCTAssertEqual(pill.presentation, .compact, "working: the plume, not the typing pill")
        session.applyForTesting { s in
            s.exchanges[1] = Exchange(prompt: "check the build", reply: "All green.")
            s.turnRunning = false
        }
        waitUntil { pill.presentation == .expanded }
        XCTAssertEqual(pill.historyIndex, 1, "the newest turn is pinned")
        XCTAssertEqual(pill.turnPreview?.reply, "All green.")
        XCTAssertEqual(pill.morph.target.height, dispatchPillPreviewHeight(reply: "All green."))
    }

    func testAReplyLeavesADraftAlone() {
        let session = SessionModel()
        let pill = makePill(session)
        pill.show()
        session.applyForTesting { s in
            s.turnRunning = true
            s.exchanges = [Exchange(prompt: "p", reply: "")]
        }
        pill.adapter.composerDraft = "next thing"
        session.applyForTesting { s in
            s.exchanges[0] = Exchange(prompt: "p", reply: "done")
            s.turnRunning = false
        }
        let drained = expectation(description: "the deferred reveal ran")
        DispatchQueue.main.async { DispatchQueue.main.async { drained.fulfill() } }
        wait(for: [drained], timeout: 1)
        XCTAssertNil(pill.historyIndex)
        XCTAssertEqual(pill.adapter.composerDraft, "next thing")
    }

    func testClickingAPinnedTurnReturnsToTheComposer() {
        let session = SessionModel()
        session.applyForTesting { s in s.exchanges = [Exchange(prompt: "one", reply: "a")] }
        let pill = makePill(session)
        pill.show()
        pill.handleSwipe(.right)
        XCTAssertNotNil(pill.historyIndex)
        pill.exitPreview()
        XCTAssertNil(pill.historyIndex)
        XCTAssertEqual(pill.presentation, .expanded)
        XCTAssertEqual(pill.morph.target.height, DispatchPillMetrics.pillHeight, "back to the composer's own height")
    }

    func testClickingTheWorkingPlumeOpensTheComposer() {
        let pill = makePill()
        pill.show()
        XCTAssertEqual(pill.presentation, .compact)
        pill.openComposer()
        XCTAssertEqual(pill.presentation, .expanded)
        XCTAssertTrue(pill.panelAcceptsKeyForTesting)
    }

    func testTheFieldWidthFollowsTheTargetNotTheSpring() {
        let pill = makePill()
        pill.show()
        XCTAssertEqual(pill.composerFieldWidth, DispatchPillMetrics.fieldWidth(pillWidth: DispatchPillMetrics.compactWidth))
        pill.adapter.composerDraft = "h"
        waitUntil { pill.presentation == .expanded }
        XCTAssertEqual(pill.composerFieldWidth, DispatchPillMetrics.expandedFieldWidth,
                       "the full typing width from the first keystroke — the text never re-wraps mid-spring")
    }

    // MARK: - Typing into the compact pill

    /// The user's report: typing into the compact pill lost the first key. Types into the REAL text
    /// view, the way AppKit does, and lets the expansion it triggers run.
    func testTheFirstKeyTypedIntoTheCompactPillIsKept() {
        let pill = makePill()
        pill.show()
        waitUntil { pill.composerTextViewForTesting != nil }
        guard let textView = pill.composerTextViewForTesting else { return XCTFail("no composer mounted") }
        textView.window?.makeFirstResponder(textView)
        textView.insertText("h", replacementRange: textView.selectedRange())
        textView.insertText("i", replacementRange: textView.selectedRange())
        let settled = expectation(description: "layout settles")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertEqual(pill.presentation, .expanded)
        XCTAssertEqual(pill.adapter.composerDraft, "hi")
        XCTAssertEqual(textView.string, "hi", "the first key survives the pill growing")
    }

    // MARK: - Blur while the shape changes

    func testTheAppKitComposerBlursWithTheShapeAndSharpensAtRest() {
        let pill = makePill()
        pill.show()
        let composer = NSScrollView()
        pill.registerComposerView(composer)
        XCTAssertTrue(composer.layerUsesCoreImageFilters)
        XCTAssertTrue(composer.contentFilters.isEmpty, "sharp at rest")
        pill.adapter.composerDraft = "h" // compact → expanded: the spring starts
        waitUntil { pill.presentation == .expanded }
        pill.setAnimatedSizeForTesting(CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight))
        XCTAssertEqual(composer.contentFilters.count, 1, "mid-change: blurred")
        XCTAssertEqual(pill.composerBlurRadiusForTesting,
                       dispatchPillMorphBlur(size: pill.morph.size, target: pill.morph.target))
        waitUntil { pill.isSpringIdleForTesting }
        XCTAssertTrue(composer.contentFilters.isEmpty, "settled: sharp again")
    }

    // MARK: - Child plumes

    /// Each working child pill's plume throws what THAT child uses: the controller watches exactly the
    /// children still at work while the pill is on screen, and lets every other go.
    func testWorkingChildrenAreWatchedAndLetGoWhenTheyFinishOrThePillGoesAway() {
        let session = SessionModel()
        let pill = makePill(session)
        var started: [String] = []
        var stopped: [String] = []
        pill.makeChildFeed = { id in
            DispatchPillChildFeed(session: SessionModel(), start: { started.append(id) }, stop: { stopped.append(id) })
        }
        session.applyForTesting { s in
            s.children = [ChildItem(sessionId: "c1", title: "a", status: "running"),
                          ChildItem(sessionId: "c2", title: "b", status: "completed"),
                          ChildItem(sessionId: "c3", title: "c", status: "awaiting_approval")]
        }
        waitUntil { true }
        XCTAssertTrue(pill.watchedChildIdsForTesting.isEmpty, "nothing is watched while the pill is put away")
        pill.show()
        XCTAssertEqual(pill.watchedChildIdsForTesting, ["c1", "c3"], "the working and the waiting, not the finished")
        XCTAssertNotNil(pill.childSession("c1"))
        XCTAssertNil(pill.childSession("c2"))
        waitUntil { started.count == 2 }
        session.applyForTesting { s in s.children[0] = ChildItem(sessionId: "c1", title: "a", status: "completed") }
        waitUntil { pill.watchedChildIdsForTesting == ["c3"] }
        XCTAssertEqual(stopped, ["c1"], "a finished child's harness is closed")
        pill.hide()
        XCTAssertTrue(pill.watchedChildIdsForTesting.isEmpty, "putting the pill away lets every child go")
        XCTAssertEqual(Set(stopped), ["c1", "c3"])
    }

    /// The user's report: the child row snapped to the pill's new width while the pill itself was
    /// still animating. It follows the ANIMATED width now — rendered mid-spring, the row is exactly as
    /// wide as the main pill is at that instant.
    func testTheChildRowFollowsTheMainPillsAnimatedWidth() {
        let session = SessionModel()
        session.applyForTesting { s in
            s.children = [ChildItem(sessionId: "c1", title: "a", status: "running"),
                          ChildItem(sessionId: "c2", title: "b", status: "running")]
        }
        let pill = makePill(session)
        pill.setPresentationForTesting(.expanded)
        let midway = CGSize(width: (DispatchPillMetrics.compactWidth + DispatchPillMetrics.expandedWidth) / 2,
                            height: DispatchPillMetrics.pillHeight)
        pill.setAnimatedSizeForTesting(midway)
        let host = NSHostingView(rootView: DispatchPillView(controller: pill))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: pill.canvas.size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView = host
        for _ in 0..<3 {
            host.frame = CGRect(origin: .zero, size: pill.canvas.size)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertEqual(pill.accessoryFrameForTesting.width, midway.width, accuracy: 0.5,
                       "the row is the width the main pill IS, not the width it is heading to")
        XCTAssertNotEqual(pill.accessoryFrameForTesting.width, pill.morph.target.width)
    }

    // MARK: - The mouse gate

    func testTheMouseGateTakesClicksOnThePillAndPassesTheMarginThrough() {
        let pill = makePill()
        pill.show()
        let frame = pill.panelFrameForTesting
        pill.mouseLocationOverrideForTesting = CGPoint(x: frame.midX, y: frame.minY + DispatchPillMetrics.shadowPad + 20)
        pill.updateMouseGate()
        XCTAssertFalse(pill.panelIgnoresMouseEventsForTesting, "over the pill: clicks land")
        pill.mouseLocationOverrideForTesting = CGPoint(x: frame.minX + 4, y: frame.minY + 4)
        pill.updateMouseGate()
        XCTAssertTrue(pill.panelIgnoresMouseEventsForTesting, "over the shadow margin: clicks pass through")
    }

    /// The user's report: with a detached session window under the pill, no mouse-moved event ever
    /// reached the gate (a local monitor only sees moves a window of ours asked for), so the gate
    /// stayed shut and a click on a child pill fell through — only one window could ever be opened.
    /// The gate now also re-checks on a clock while the pill is up.
    func testTheMouseGateReopensWithNoMouseMovedEventAtAll() {
        let pill = makePill()
        pill.show()
        XCTAssertTrue(pill.gateTimerActiveForTesting)
        let frame = pill.panelFrameForTesting
        pill.mouseLocationOverrideForTesting = CGPoint(x: frame.minX + 4, y: frame.minY + 4)
        pill.updateMouseGate()
        XCTAssertTrue(pill.panelIgnoresMouseEventsForTesting, "over the margin: clicks pass through")
        // The pointer moves onto the pill — and nothing tells the controller.
        pill.mouseLocationOverrideForTesting = CGPoint(x: frame.midX, y: frame.minY + DispatchPillMetrics.shadowPad + 20)
        waitUntil { !pill.panelIgnoresMouseEventsForTesting }
        XCTAssertFalse(pill.panelIgnoresMouseEventsForTesting, "the clock reopened the gate")
        pill.hide()
        XCTAssertFalse(pill.gateTimerActiveForTesting, "no clock while the pill is away")
    }

    /// The user's report: with a session window holding the keyboard, the first click on a child pill
    /// only made the (non-key) pill panel key and the tap was lost — a second click was needed. The
    /// pill's content acts on the first click.
    func testThePillActsOnTheFirstClickEvenWhenNotKey() {
        let pill = makePill()
        pill.show()
        let content = pill.panelContentViewForTesting
        XCTAssertNotNil(content)
        XCTAssertTrue(content?.acceptsFirstMouse(for: nil) ?? false)
    }

    func testHitTestCountsTheFloatingLayers() {
        let canvasSize = CGSize(width: 500, height: 300)
        let accessory = CGRect(x: 30, y: 24, width: 440, height: 120)
        XCTAssertTrue(dispatchPillHitTest(point: CGPoint(x: 250, y: 60), canvasSize: canvasSize,
                                          mainSize: compactMain, accessoryFrame: accessory))
        XCTAssertFalse(dispatchPillHitTest(point: CGPoint(x: 250, y: 60), canvasSize: canvasSize,
                                           mainSize: compactMain, accessoryFrame: .zero))
        XCTAssertTrue(dispatchPillHitTest(point: CGPoint(x: 250, y: 300 - 24 - 10), canvasSize: canvasSize,
                                          mainSize: compactMain, accessoryFrame: .zero))
    }

    // MARK: - Child sessions and asks grow the canvas

    func testAccessoryLayoutGrowsTheCanvasImmediatelyAndShrinksItAfterwards() {
        let pill = makePill()
        pill.show()
        let compactCanvas = pill.canvas.size
        pill.accessoryLayoutChanged(frame: CGRect(x: 0, y: 0, width: 440, height: 120))
        XCTAssertEqual(pill.canvas.size.height, compactCanvas.height + 120 + DispatchPillMetrics.stackGap)
        XCTAssertEqual(pill.canvas.size.width, 440 + 2 * DispatchPillMetrics.shadowPad)
        XCTAssertEqual(pill.panelFrameForTesting.size, pill.canvas.size)
        pill.accessoryLayoutChanged(frame: .zero)
        XCTAssertEqual(pill.canvas.size.height, compactCanvas.height + 120 + DispatchPillMetrics.stackGap,
                       "a shrink waits for the removal to finish")
        waitUntil { pill.canvas.size == compactCanvas }
        XCTAssertEqual(pill.canvas.size, compactCanvas)
        XCTAssertEqual(pill.panelFrameForTesting.size, compactCanvas)
    }

    // MARK: - Composer height

    func testTheTypingPillGrowsWithTheComposerAndCapsAtItsMaximum() {
        let pill = makePill()
        pill.show()
        pill.adapter.composerDraft = "line"
        waitUntil { pill.presentation == .expanded }
        pill.composerContentHeightChanged(80)
        XCTAssertEqual(pill.morph.target.height, 80 + DispatchPillMetrics.composerVerticalPadding)
        XCTAssertEqual(pill.composerFieldHeight, 80)
        pill.composerContentHeightChanged(900)
        XCTAssertEqual(pill.morph.target.height, DispatchPillMetrics.maxExpandedHeight)
    }

    // MARK: - Respond wiring

    func testTheCardsRespondThroughThePillsCallbackWithTheChildSessionId() async {
        let pill = makePill()
        var received: (String, Bool, String?)?
        pill.onApprovalRespond = { callId, approved, _, child in received = (callId, approved, child); return true }
        pill.adapter.onApprovalRespond("call-1", true, nil, "child-9")
        XCTAssertTrue(pill.adapter.interactionInFlight.contains("call-1"), "in flight synchronously")
        for _ in 0..<50 where received == nil { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(received?.0, "call-1")
        XCTAssertEqual(received?.1, true)
        XCTAssertEqual(received?.2, "child-9")
        for _ in 0..<50 where pill.adapter.interactionInFlight.contains("call-1") {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNil(pill.adapter.interactionErrors["call-1"])
    }

    func testAFailedRespondLeavesAnErrorLine() async {
        let pill = makePill()
        pill.onApprovalRespond = { _, _, _, _ in false }
        pill.adapter.onApprovalRespond("call-2", false, nil, nil)
        for _ in 0..<50 where pill.adapter.interactionErrors["call-2"] == nil {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(pill.adapter.interactionErrors["call-2"], "couldn't send — try again")
    }

    // MARK: - boot()

    func testBootBuildsTheHiddenPillAndNoLongerShowsTheOrb() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        defer { delegate.pillController?.hide() }
        guard let pill = delegate.pillController else { return XCTFail("boot() must build the pill") }
        XCTAssertFalse(pill.isVisible, "the pill appears on a summon, not at launch")
        XCTAssertEqual(pill.monitorCountForTesting, 0)
        XCTAssertFalse(delegate.orbController?.isVisible ?? true,
                       "the orb is no longer shown at launch — the pill is the summon surface")
        XCTAssertNotNil(pill.onSubmit)
        XCTAssertNotNil(pill.onEsc)
        XCTAssertNotNil(pill.onInterrupt)
        XCTAssertNotNil(pill.onApprovalRespond)
        XCTAssertNotNil(pill.onOpenChild)
        XCTAssertNotNil(pill.onStopChild)
        XCTAssertNotNil(pill.onOpenInApp)
        XCTAssertEqual(pill.onEsc?(), false, "no turn running in the degraded test boot: Esc is not an interrupt")
        XCTAssertTrue(pill.settings === delegate.dispatchPillSettings,
                      "the pill reads the ONE store the settings page writes")
    }
}
