import XCTest
import AppKit
@testable import Winter

/// `DispatchPillController` against a real (harness-dimmed) panel: visibility, the bottom-centred
/// frame, the grow-now/shrink-after-settle rule, key acceptance, the draft round trip, routing, the
/// swipe, the mouse gate, and the `boot()` wiring.
@MainActor
final class DispatchPillControllerTests: XCTestCase {
    private let visible = CGRect(x: 100, y: 80, width: 1440, height: 820)
    private var controllers: [DispatchPillController] = []

    override func tearDown() async throws {
        controllers.forEach { $0.hide() }
        controllers.removeAll()
        try await super.tearDown()
    }

    private func makePill(_ session: SessionModel? = nil) -> DispatchPillController {
        let pill = DispatchPillController(session: session ?? SessionModel())
        pill.visibleFrameOverrideForTesting = visible
        controllers.append(pill)
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
                                        showsPreview: false, visibleFrame: visible)
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
        XCTAssertEqual(pill.morph.target.height,
                       dispatchPillMainSize(presentation: .expanded,
                                            composerContentHeight: pill.composerContentHeight,
                                            showsPreview: true, visibleFrame: visible).height,
                       "the preview band rides above the composer")
        XCTAssertGreaterThanOrEqual(pill.morph.target.height,
                                    DispatchPillMetrics.pillHeight + DispatchPillMetrics.previewHeight)
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
    }
}
