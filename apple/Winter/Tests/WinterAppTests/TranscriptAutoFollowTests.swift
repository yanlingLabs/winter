import XCTest
import SwiftUI
import AppKit
@testable import Winter

/// The transcript follows its bottom on the display's clock — one continuous glide, never a
/// line-by-line step — opens at its bottom, and lets go when the user scrolls up.
@MainActor
final class TranscriptAutoFollowTests: XCTestCase {
    // MARK: - The glide (pure)

    func testTheGlideClosesMostOfTheGapInAQuarterSecond() {
        var y: CGFloat = 0
        for _ in 0..<15 { y = transcriptFollowStep(current: y, target: 200, dt: 1.0 / 60.0, viewport: 600) }
        XCTAssertGreaterThan(y, 185, "~95% there after 0.25 s")
        XCTAssertLessThan(y, 200)
    }

    func testEachFrameMovesPartOfTheWayNotALineAtATime() {
        let first = transcriptFollowStep(current: 0, target: 60, dt: 1.0 / 60.0, viewport: 600)
        XCTAssertGreaterThan(first, 0)
        XCTAssertLessThan(first, 20, "a small step per frame — a glide, not a jump")
    }

    func testAGapOfPagesIsCrossedAtOnceAndATinyOneSettles() {
        XCTAssertEqual(transcriptFollowStep(current: 0, target: 5000, dt: 1.0 / 60.0, viewport: 600), 5000)
        XCTAssertEqual(transcriptFollowStep(current: 99.2, target: 100, dt: 1.0 / 60.0, viewport: 600), 100)
    }

    func testAStalledFrameDoesNotLurch() {
        let afterStall = transcriptFollowStep(current: 0, target: 100, dt: 2, viewport: 600)
        XCTAssertLessThan(afterStall, 50, "a long dt is clamped")
    }

    // MARK: - A real scroll view

    private final class Model: ObservableObject { @Published var rows = 40 }

    private struct Harness: View {
        @ObservedObject var model: Model
        let follower: TranscriptFollower
        var body: some View {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(0..<model.rows, id: \.self) { i in Text("row \(i)").frame(height: 30) }
                }
                .frame(maxWidth: .infinity)
                .background(TranscriptAutoFollow(follower: follower))
            }
        }
    }

    private var window: NSWindow?

    override func tearDown() async throws {
        window?.close()
        window = nil
        try await super.tearDown()
    }

    /// The follow runs on the display's own clock, which stops while the display sleeps (a test run
    /// left going with the Mac's screen off) — nothing to measure then.
    private func skipIfDisplayAsleep() throws {
        try XCTSkipIf(CGDisplayIsAsleep(CGMainDisplayID()) != 0, "the display is asleep: its display link does not tick")
    }

    private func host(_ model: Model, _ follower: TranscriptFollower) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300),
                         styleMask: [.titled], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: Harness(model: model, follower: follower))
        w.orderFront(nil)
        window = w
        pump(0.3)
        return w
    }

    private func pump(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func distanceFromBottom(_ sv: NSScrollView) -> CGFloat {
        let clip = sv.contentView
        var proposed = clip.bounds
        proposed.origin.y = 1e9
        return clip.constrainBoundsRect(proposed).origin.y - clip.bounds.origin.y
    }

    func testItOpensAtTheBottomAndFollowsGrowth() throws {
        try skipIfDisplayAsleep()
        let model = Model(), follower = TranscriptFollower()
        _ = host(model, follower)
        let sv = try XCTUnwrap(follower.scrollView, "found its scroll view")
        XCTAssertLessThan(distanceFromBottom(sv), 1, "opens at the bottom")
        model.rows += 3
        pump(0.6)
        XCTAssertLessThan(distanceFromBottom(sv), 1, "followed the new rows down")
        XCTAssertTrue(follower.isFollowing)
    }

    func testScrollingUpLetsGoAndComingBackResumes() throws {
        try skipIfDisplayAsleep()
        let model = Model(), follower = TranscriptFollower()
        _ = host(model, follower)
        let sv = try XCTUnwrap(follower.scrollView)
        // The user drags the view to the top (a live scroll).
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: sv)
        sv.contentView.scroll(to: .zero)
        sv.reflectScrolledClipView(sv.contentView)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: sv)
        XCTAssertFalse(follower.isFollowing, "scrolled away: no longer following")
        model.rows += 3
        pump(0.4)
        XCTAssertGreaterThan(distanceFromBottom(sv), 100, "growth does not pull the user back down")
        follower.jumpToBottom()
        pump(0.6)
        XCTAssertTrue(follower.isFollowing)
        XCTAssertLessThan(distanceFromBottom(sv), 1, "the latest pill brings it back")
    }

    /// A far move — a history landing into an emptied transcript — is handed to `farJump` (SwiftUI's
    /// own scroll-to-row in `TranscriptView`), never made on the clip view: jumped into directly, a
    /// lazy stack still on estimated row heights could sit drawing nothing until the user scrolled
    /// (user, 2026-10-04). Once it rests at the bottom, `onLanded` is told, once.
    func testAFarMoveIsHandedToFarJumpAndTheLandingIsAnnounced() throws {
        try skipIfDisplayAsleep()
        let model = Model(), follower = TranscriptFollower()
        _ = host(model, follower)
        let sv = try XCTUnwrap(follower.scrollView)
        var farJumps = 0, landings = 0
        follower.farJump = {
            farJumps += 1
            // What the reader does: put the clip at the bottom (here, by hand).
            var r = sv.contentView.bounds; r.origin.y = 1e9
            sv.contentView.scroll(to: sv.contentView.constrainBoundsRect(r).origin)
            sv.reflectScrolledClipView(sv.contentView)
        }
        follower.onLanded = { landings += 1 }
        sv.contentView.scroll(to: .zero)
        sv.reflectScrolledClipView(sv.contentView)
        model.rows += 200 // pages below
        follower.restartAtBottom()
        pump(0.8)
        XCTAssertGreaterThan(farJumps, 0, "the far move went through farJump")
        XCTAssertLessThan(distanceFromBottom(sv), 1)
        XCTAssertEqual(landings, 1, "the landing is announced once it rests")
        model.rows += 1
        pump(0.5)
        XCTAssertEqual(landings, 1, "ordinary growth afterwards is not another landing")
    }
}
