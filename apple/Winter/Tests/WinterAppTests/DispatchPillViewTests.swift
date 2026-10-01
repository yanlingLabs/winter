import XCTest
import AppKit
import SwiftUI
import WinterProtocol
@testable import Winter

/// The pill's state machine and geometry as pure decisions (compact ↔ expanded ↔ full screen, the
/// composer's measured height, the shape), what floats above it, and a render smoke test of the view
/// tree in each presentation.
@MainActor
final class DispatchPillViewTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 70, width: 1440, height: 830)

    // MARK: - Sizes per presentation

    func testCompactIsTheFixedCapsule() {
        let size = dispatchPillMainSize(presentation: .compact, composerContentHeight: 200,
                                        showsPreview: true, visibleFrame: visible)
        XCTAssertEqual(size, CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight),
                       "the compact pill ignores the composer's height and any preview")
    }

    func testExpandedHeightFollowsTheMeasuredComposer() {
        func height(_ content: CGFloat, preview: Bool = false) -> CGFloat {
            dispatchPillMainSize(presentation: .expanded, composerContentHeight: content,
                                 showsPreview: preview, visibleFrame: visible).height
        }
        XCTAssertEqual(height(0), DispatchPillMetrics.pillHeight, "unmeasured: the resting capsule")
        XCTAssertEqual(height(26), DispatchPillMetrics.pillHeight, "one line: still the capsule")
        XCTAssertEqual(height(60), 60 + DispatchPillMetrics.composerVerticalPadding)
        XCTAssertEqual(height(2_000), DispatchPillMetrics.maxExpandedHeight, "capped; the text scrolls inside")
        XCTAssertEqual(height(26, preview: true), DispatchPillMetrics.pillHeight + DispatchPillMetrics.previewHeight)
        XCTAssertEqual(dispatchPillMainSize(presentation: .expanded, composerContentHeight: 0,
                                            showsPreview: false, visibleFrame: visible).width,
                       DispatchPillMetrics.expandedWidth)
    }

    func testFullScreenFillsTheVisibleFrameLessItsInsets() {
        let size = dispatchPillMainSize(presentation: .fullScreen, composerContentHeight: 0,
                                        showsPreview: false, visibleFrame: visible)
        XCTAssertEqual(size.width, visible.width - 2 * DispatchPillMetrics.fullScreenInset)
        XCTAssertEqual(size.height, visible.height - DispatchPillMetrics.fullScreenInset - DispatchPillMetrics.dockGap)
        let tiny = dispatchPillMainSize(presentation: .fullScreen, composerContentHeight: 0, showsPreview: false,
                                        visibleFrame: CGRect(x: 0, y: 0, width: 300, height: 200))
        XCTAssertGreaterThanOrEqual(tiny.width, DispatchPillMetrics.expandedWidth, "never smaller than the typing pill")
    }

    // MARK: - The shape: pill ↔ rounded rect

    func testTheCornerRadiusIsACapsuleAtRestAndARoundedRectWhenTall() {
        XCTAssertEqual(dispatchPillCornerRadius(height: DispatchPillMetrics.pillHeight), DispatchPillMetrics.pillHeight / 2)
        XCTAssertEqual(dispatchPillCornerRadius(height: 30), 15, "smaller than rest (mid-spring): still a capsule")
        XCTAssertEqual(dispatchPillCornerRadius(height: 140), DispatchPillMetrics.maxCornerRadius)
        XCTAssertEqual(dispatchPillCornerRadius(height: -4), 0)
    }

    // MARK: - Canvas and frame

    func testTheCanvasStacksTheFloatingLayersAboveThePill() {
        let main = CGSize(width: 360, height: 44)
        XCTAssertEqual(dispatchPillCanvasSize(mainSize: main, accessorySize: .zero),
                       CGSize(width: 360 + 48, height: 44 + 48))
        XCTAssertEqual(dispatchPillCanvasSize(mainSize: main, accessorySize: CGSize(width: 440, height: 100)),
                       CGSize(width: 440 + 48, height: 44 + 100 + DispatchPillMetrics.stackGap + 48))
        XCTAssertEqual(dispatchPillCanvasSize(mainSize: main, accessorySize: CGSize(width: 0, height: 100)),
                       CGSize(width: 360 + 48, height: 44 + 48), "a zero-width report is no accessory")
    }

    func testThePanelFrameIsCentredAndItsPillSits28PointsAboveTheDock() {
        let frame = dispatchPillPanelFrame(canvasSize: CGSize(width: 408, height: 92), visibleFrame: visible)
        XCTAssertEqual(frame.midX, visible.midX)
        XCTAssertEqual(frame.minY, visible.minY + 28 - DispatchPillMetrics.shadowPad)
        XCTAssertEqual(frame.size, CGSize(width: 408, height: 92))
    }

    func testTheMainRectIsBottomCentredInsideTheMargin() {
        let rect = dispatchPillMainRect(canvasSize: CGSize(width: 600, height: 300), mainSize: CGSize(width: 360, height: 44))
        XCTAssertEqual(rect, CGRect(x: 120, y: 300 - 24 - 44, width: 360, height: 44))
    }

    func testTheCanvasGrowsNowAndShrinksLater() {
        let small = CGSize(width: 408, height: 92)
        let wide = CGSize(width: 608, height: 92)
        XCTAssertEqual(dispatchPillCanvasStep(current: small, target: small), .none)
        XCTAssertEqual(dispatchPillCanvasStep(current: small, target: wide), .growNow(wide))
        XCTAssertEqual(dispatchPillCanvasStep(current: wide, target: small), .shrinkLater)
        // One axis grows while the other shrinks: grow to the union now, shrink the rest later.
        XCTAssertEqual(dispatchPillCanvasStep(current: CGSize(width: 608, height: 92), target: CGSize(width: 408, height: 300)),
                       .growNow(CGSize(width: 608, height: 300)))
    }

    // MARK: - Transitions (the state machine)

    func testTheTriggerTable() {
        XCTAssertEqual(dispatchPillTriggerAction(isVisible: false, presentation: .compact), .show)
        XCTAssertEqual(dispatchPillTriggerAction(isVisible: false, presentation: .fullScreen), .show)
        XCTAssertEqual(dispatchPillTriggerAction(isVisible: true, presentation: .compact), .hide)
        XCTAssertEqual(dispatchPillTriggerAction(isVisible: true, presentation: .expanded), .hide)
        XCTAssertEqual(dispatchPillTriggerAction(isVisible: true, presentation: .fullScreen), .collapseFullScreen)
    }

    func testTheEscTable() {
        XCTAssertEqual(dispatchPillEscAction(presentation: .fullScreen, previewing: false, escConsumed: { true }), .interrupt)
        XCTAssertEqual(dispatchPillEscAction(presentation: .compact, previewing: true, escConsumed: { true }), .interrupt)
        XCTAssertEqual(dispatchPillEscAction(presentation: .fullScreen, previewing: false, escConsumed: { false }), .exitFullScreen)
        XCTAssertEqual(dispatchPillEscAction(presentation: .expanded, previewing: true, escConsumed: { false }), .exitPreview)
        XCTAssertEqual(dispatchPillEscAction(presentation: .expanded, previewing: false, escConsumed: { false }), .compress)
        XCTAssertEqual(dispatchPillEscAction(presentation: .compact, previewing: false, escConsumed: { false }), .rest)
    }

    func testTypingExpandsOnlyOnAChangeWhileCompact() {
        XCTAssertEqual(dispatchPillPresentationAfterDraftChange(.compact, old: "", new: "h"), .expanded)
        XCTAssertEqual(dispatchPillPresentationAfterDraftChange(.compact, old: "h", new: "h"), .compact,
                       "no change, no expand — a restored draft never bounces the pill open")
        XCTAssertEqual(dispatchPillPresentationAfterDraftChange(.compact, old: "h", new: ""), .compact)
        XCTAssertEqual(dispatchPillPresentationAfterDraftChange(.expanded, old: "h", new: ""), .expanded,
                       "deleting everything does not snap the typing pill shut")
        XCTAssertEqual(dispatchPillPresentationAfterDraftChange(.fullScreen, old: "", new: "h"), .fullScreen)
    }

    func testLeavingFullScreenLandsWhereTheDraftIs() {
        XCTAssertEqual(dispatchPillPresentationLeavingFullScreen(draft: ""), .compact)
        XCTAssertEqual(dispatchPillPresentationLeavingFullScreen(draft: "  \n"), .compact)
        XCTAssertEqual(dispatchPillPresentationLeavingFullScreen(draft: "more"), .expanded)
    }

    // MARK: - ↗ and ⋯ give way to the text

    func testTheAccessoryButtonsBlurOutAsTheTextComesUpToThem() {
        let line = DispatchPillMetrics.fieldWidthBesideAccessories
        let margin = DispatchPillMetrics.accessoryApproachMargin
        XCTAssertTrue(dispatchPillAccessoryButtonsVisible(draft: "short", textWidth: 40))
        XCTAssertTrue(dispatchPillAccessoryButtonsVisible(draft: "x", textWidth: line - margin))
        XCTAssertFalse(dispatchPillAccessoryButtonsVisible(draft: "x", textWidth: line - margin + 1),
                       "gone BEFORE the text touches them")
        XCTAssertFalse(dispatchPillAccessoryButtonsVisible(draft: "two\nlines", textWidth: 10),
                       "a second line has passed them by definition")
        XCTAssertLessThan(line, DispatchPillMetrics.expandedFieldWidth)
    }

    /// The regression the user hit: ↗ and ⋯ used to sit BESIDE the field, so hiding them widened it,
    /// the text re-wrapped onto one line, the pill shrank, they came back, and round again. They
    /// float over it now — the field's width is the same whether they show or not.
    func testTheFieldWidthDoesNotDependOnTheAccessories() {
        XCTAssertEqual(DispatchPillMetrics.expandedFieldWidth,
                       DispatchPillMetrics.fieldWidth(pillWidth: DispatchPillMetrics.expandedWidth))
        XCTAssertEqual(DispatchPillMetrics.expandedFieldWidth,
                       DispatchPillMetrics.expandedWidth - DispatchPillMetrics.leadingPadding
                           - DispatchPillMetrics.trailingPadding - DispatchPillMetrics.sendCircleSize
                           - DispatchPillMetrics.rowSpacing,
                       "everything left of the send circle — no room set aside for ↗ and ⋯")
    }

    // MARK: - Blur while the shape changes

    func testTheContentBlursByHowFarTheShapeStillHasToGo() {
        let compact = CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)
        let expanded = CGSize(width: DispatchPillMetrics.expandedWidth, height: DispatchPillMetrics.pillHeight)
        XCTAssertEqual(dispatchPillMorphBlur(size: compact, target: compact), 0, "sharp at rest")
        XCTAssertEqual(dispatchPillMorphBlur(size: compact, target: expanded), DispatchPillMetrics.maxMorphBlur,
                       "the full blur at the start of a big change, capped")
        let halfway = CGSize(width: compact.width + 150, height: compact.height)
        let late = CGSize(width: expanded.width - 30, height: compact.height)
        XCTAssertLessThan(dispatchPillMorphBlur(size: late, target: expanded),
                          dispatchPillMorphBlur(size: halfway, target: expanded), "sharpens as it settles")
        XCTAssertEqual(dispatchPillMorphBlur(size: CGSize(width: expanded.width - 2, height: expanded.height),
                                             target: expanded), 0, "no lingering haze in the last points")
        XCTAssertGreaterThan(dispatchPillMorphBlur(size: compact,
                                                   target: CGSize(width: compact.width, height: compact.height + 40)), 0,
                             "growing taller blurs too")
    }

    func testThePillSitsClearOfTheDock() {
        let frame = dispatchPillPanelFrame(canvasSize: CGSize(width: 408, height: 92), visibleFrame: visible)
        XCTAssertEqual(frame.minY + DispatchPillMetrics.shadowPad, visible.minY + DispatchPillMetrics.dockGap,
                       "the pill's own bottom edge, above the shadow margin")
        XCTAssertGreaterThanOrEqual(DispatchPillMetrics.dockGap, 24)
    }

    // MARK: - A reply opens the pill

    func testAFinishedReplyOpensAnIdleVisiblePill() {
        let reply = Exchange(prompt: "check the build", reply: "All green.")
        XCTAssertTrue(dispatchPillRevealsReply(isVisible: true, presentation: .compact, previewing: false,
                                               draft: "", latest: reply))
        XCTAssertTrue(dispatchPillRevealsReply(isVisible: true, presentation: .expanded, previewing: false,
                                               draft: "  ", latest: reply), "an empty typing pill pins it too")
    }

    func testAReplyNeverPushesAsideWhatTheUserIsDoing() {
        let reply = Exchange(prompt: "p", reply: "done")
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: false, presentation: .compact, previewing: false,
                                                draft: "", latest: reply), "a put-away pill stays away")
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .expanded, previewing: false,
                                                draft: "half a thought", latest: reply), "never over a draft")
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .expanded, previewing: true,
                                                draft: "", latest: reply), "never over a swiped-to turn")
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .fullScreen, previewing: false,
                                                draft: "", latest: reply), "full screen already shows it")
    }

    func testAStoppedOrEmptyTurnOpensNothing() {
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .compact, previewing: false,
                                                draft: "", latest: Exchange(prompt: "p", reply: "partial", aborted: true)))
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .compact, previewing: false,
                                                draft: "", latest: Exchange(prompt: "p", reply: " \n")))
        XCTAssertFalse(dispatchPillRevealsReply(isVisible: true, presentation: .compact, previewing: false,
                                                draft: "", latest: nil))
    }

    // MARK: - The trailing circle

    func testTheTrailingCircleShowsVoiceInsteadOfAGreyedSend() {
        XCTAssertEqual(pillSendButtonSymbol(composerSendButtonRole(isRunning: false, sendBlockedReason: "")), "mic.fill")
        XCTAssertEqual(pillSendButtonSymbol(composerSendButtonRole(isRunning: false, sendBlockedReason: nil)), "arrow.up")
        XCTAssertEqual(pillSendButtonSymbol(composerSendButtonRole(isRunning: true, sendBlockedReason: "")), "stop.fill",
                       "running beats blocked")
    }

    func testTheMeasuredTextWidthGrowsWithTheDraft() {
        XCTAssertEqual(dispatchPillDraftTextWidth(""), 0)
        let short = dispatchPillDraftTextWidth("hello")
        let long = dispatchPillDraftTextWidth(String(repeating: "hello ", count: 40))
        XCTAssertGreaterThan(short, 0)
        XCTAssertGreaterThan(long, DispatchPillMetrics.fieldWidthBesideAccessories,
                             "forty words reach the buttons")
        XCTAssertFalse(dispatchPillAccessoryButtonsVisible(draft: "x", textWidth: long))
    }

    // MARK: - Turn previews

    func testTheTurnPreviewShortensThePromptAndTakesTheReplysFirstLine() {
        let exchanges = [
            Exchange(prompt: "first", reply: "ok"),
            Exchange(prompt: "Please  look\n at the\tlogs", reply: "\n## Found it\nThe second line"),
        ]
        let preview = dispatchPillTurnPreview(exchanges: exchanges, index: 1)
        XCTAssertEqual(preview?.prompt, "Please look at the logs")
        XCTAssertEqual(preview?.reply, "Found it")
        XCTAssertEqual(preview?.position, "2/2")
        XCTAssertNil(dispatchPillTurnPreview(exchanges: exchanges, index: 2))
        XCTAssertEqual(dispatchPillTurnPreview(exchanges: [Exchange(prompt: "p", reply: "")], index: 0)?.reply,
                       "no reply yet")
        XCTAssertEqual(dispatchPillTurnPreview(exchanges: [Exchange(prompt: "p", reply: "", aborted: true)], index: 0)?.reply,
                       "stopped")
    }

    func testShorteningCutsWithAnEllipsis() {
        let long = String(repeating: "a", count: 200)
        let cut = dispatchPillShortened(long, limit: 90)
        XCTAssertEqual(cut.count, 90)
        XCTAssertTrue(cut.hasSuffix("…"))
        XCTAssertEqual(dispatchPillShortened("fits", limit: 90), "fits")
        XCTAssertEqual(dispatchPillStrippingMarkdownLead("- **bold** item"), "bold item")
        XCTAssertEqual(dispatchPillStrippingMarkdownLead("> quoted"), "quoted")
    }

    // MARK: - Which asks float

    private func approval(_ callId: String, child: String? = nil, outcome: InteractionRecord.Outcome? = nil) -> ActivityItem {
        ActivityItem(kind: .interaction(InteractionRecord(callId: callId, ask: .approval(toolName: "bash", summary: "rm -rf build"),
                                                          childSessionId: child, outcome: outcome)))
    }

    func testOnlyAsksStillWaitingFloatOldestFirst() {
        let exchanges = [
            Exchange(prompt: "one", reply: "", activity: [approval("a1", outcome: .approval(approved: true, by: "orb")),
                                                          approval("a2")]),
            Exchange(prompt: "two", reply: "", activity: [approval("a3", outcome: .ended), approval("a4")]),
        ]
        XCTAssertEqual(pendingInteractionRecords(in: exchanges).map(\.callId), ["a2", "a4"])
    }

    /// The dispatch case the overlay is built around: Dispatch's own turn end empties
    /// `pendingInteractions`, but a CHILD's ask stays pending in the transcript until it is answered.
    func testAChildAskStillFloatsAfterDispatchsTurnHasEnded() {
        let exchanges = [Exchange(prompt: "spawn", reply: "on it", activity: [approval("c1", child: "child-session")])]
        let records = pendingInteractionRecords(in: exchanges, live: [])
        XCTAssertEqual(records.map(\.callId), ["c1"])
        XCTAssertEqual(records.first?.childSessionId, "child-session", "the answer must route to the child")
    }

    func testLiveAsksWithoutATranscriptRecordFloatTooAndNothingTwice() {
        let exchanges = [Exchange(prompt: "p", reply: "", activity: [approval("a1")])]
        let live: [PendingInteraction] = [
            .approval(callId: "a1", toolName: "bash", summary: "dup"),
            .plan(callId: "p1", plan: "do the thing"),
        ]
        let records = pendingInteractionRecords(in: exchanges, live: live)
        XCTAssertEqual(records.map(\.callId), ["a1", "p1"])
        XCTAssertEqual(records.last?.ask, .plan(plan: "do the thing"))
    }

    func testAnElicitationResolvedLocallyNoLongerFloats() {
        let ask = InteractionRecord.Ask.urlElicitation(serverName: "cf", message: "sign in", host: "x.com",
                                                       origin: "https://x.com", expiresAt: 0)
        let exchanges = [Exchange(prompt: "p", reply: "", activity: [ActivityItem(kind: .interaction(InteractionRecord(callId: "e1", ask: ask)))])]
        XCTAssertEqual(pendingInteractionRecords(in: exchanges).map(\.callId), ["e1"])
        XCTAssertTrue(pendingInteractionRecords(in: exchanges, inactive: ["e1"]).isEmpty)
    }

    func testTwoCardsFloatAndTheRestWait() {
        XCTAssertEqual(floatingCardSplit(0).shown, 0)
        XCTAssertEqual(floatingCardSplit(1).shown, 1)
        XCTAssertEqual(floatingCardSplit(2).waiting, 0)
        XCTAssertEqual(floatingCardSplit(5).shown, DispatchPillMetrics.maxFloatingCards)
        XCTAssertEqual(floatingCardSplit(5).waiting, 3)
    }

    func testAPendingInteractionConvertsToItsRecord() {
        let record = interactionRecord(for: .question(callId: "q1", questions: [], childSessionId: "kid"))
        XCTAssertEqual(record.callId, "q1")
        XCTAssertEqual(record.childSessionId, "kid")
        XCTAssertNil(record.outcome)
    }

    // MARK: - The view tree renders in every presentation

    func testTheViewTreeLaysOutInEveryPresentation() {
        let session = SessionModel()
        session.applyForTesting { s in
            s.exchanges = [Exchange(prompt: "hello", reply: "hi there")]
            s.children = [ChildItem(sessionId: "c1", title: "fix auth", status: "running")]
        }
        // A throwaway suite, never written (nothing here shows or hides the pill): the test host is
        // the app, and `.standard` is the dev app's real preferences.
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: "WinterTests.DispatchPill.views")!)
        let pill = DispatchPillController(session: session, settings: settings)
        pill.visibleFrameOverrideForTesting = CGRect(x: 0, y: 0, width: 1200, height: 800)
        let childRow = DispatchPillMetrics.childRowHeight + DispatchPillMetrics.stackGap
        for presentation in [DispatchPillPresentation.compact, .expanded, .fullScreen] {
            pill.setPresentationForTesting(presentation)
            let main = pill.morph.target
            let host = NSHostingView(rootView: DispatchPillView(controller: pill))
            host.frame = CGRect(origin: .zero, size: pill.canvas.size)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            host.layoutSubtreeIfNeeded()
            // Laying out reports the floating child row, which grows the canvas above the pill —
            // except in full screen, where the children sit in the header instead.
            let expectedHeight = main.height + 2 * DispatchPillMetrics.shadowPad
                + (presentation == .fullScreen ? 0 : childRow)
            XCTAssertEqual(pill.canvas.size.height, expectedHeight, accuracy: 0.5, "\(presentation)")
            XCTAssertEqual(pill.canvas.size.width, main.width + 2 * DispatchPillMetrics.shadowPad, accuracy: 0.5,
                           "\(presentation)")
        }
    }
}
