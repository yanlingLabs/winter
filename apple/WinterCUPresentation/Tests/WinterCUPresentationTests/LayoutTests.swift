import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// Placement maths: the anchor over the traffic lights, clamping, docking to the nearest corner, stacking.
final class LayoutTests: XCTestCase {
    let t = PresentationTuning.standard
    // A 1512×982 laptop screen: 25 pt menu bar on top, 60 pt Dock at the bottom (top-left global points).
    let laptop = ScreenInfo(frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                            visibleFrame: CGRect(x: 0, y: 25, width: 1512, height: 897))
    // A 2560×1440 display to the laptop's right, no Dock.
    let external = ScreenInfo(frame: CGRect(x: 1512, y: 0, width: 2560, height: 1440),
                              visibleFrame: CGRect(x: 1512, y: 25, width: 2560, height: 1415))

    // MARK: - Coordinate flip

    func testFlipIsItsOwnInverse() {
        let r = CGRect(x: 10, y: 20, width: 300, height: 200)
        let flipped = QuartzSpace.flip(r, primaryHeight: 982)
        XCTAssertEqual(flipped, CGRect(x: 10, y: 762, width: 300, height: 200))
        XCTAssertEqual(QuartzSpace.flip(flipped, primaryHeight: 982), r)
    }

    // MARK: - Sizes

    func testContentSizeKeepsTheWindowAspectAt360Wide() {
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: CGSize(width: 1440, height: 900), tuning: t),
                       CGSize(width: 360, height: 225))
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: CGSize(width: 1200, height: 900), tuning: t),
                       CGSize(width: 360, height: 270))
    }

    func testTallWindowsGetANarrowerImageCappedInHeight() {
        // 0.5 aspect → 300 tall would be 150 wide, below the 160 minimum.
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: CGSize(width: 800, height: 1600), tuning: t),
                       CGSize(width: 160, height: 300))
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: CGSize(width: 900, height: 1000), tuning: t),
                       CGSize(width: 270, height: 300))
    }

    func testVeryWideWindowsAreLetterboxedAtTheMinimumHeight() {
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: CGSize(width: 3000, height: 500), tuning: t),
                       CGSize(width: 360, height: 90))
    }

    func testUnknownOrEmptyWindowUsesTheDefault() {
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: nil, tuning: t), CGSize(width: 360, height: 225))
        XCTAssertEqual(MirrorLayout.contentSize(forWindow: .zero, tuning: t), CGSize(width: 360, height: 225))
    }

    func testPanelAddsTheRimAndTheCaption() {
        XCTAssertEqual(MirrorLayout.panelSize(content: CGSize(width: 360, height: 225), tuning: t),
                       CGSize(width: 366, height: 251))
    }

    // MARK: - Anchor

    func testAnchorSitsOnTheWindowsTopLeftCorner() {
        let window = CGRect(x: 200, y: 150, width: 1000, height: 700)
        let frame = MirrorLayout.anchoredFrame(windowFrame: window, panelSize: CGSize(width: 366, height: 251),
                                               screens: [laptop], tuning: t)
        XCTAssertEqual(frame, CGRect(x: 204, y: 154, width: 366, height: 251))
        // The traffic lights (about 8…70 pt in, 6…22 pt down) are under the panel.
        XCTAssertTrue(frame.contains(CGPoint(x: window.minX + 10, y: window.minY + 12)))
        XCTAssertTrue(frame.contains(CGPoint(x: window.minX + 66, y: window.minY + 20)))
    }

    func testAnchorStaysInsideTheVisibleScreen() {
        // Window flush against the menu bar and the left edge: kept off the edge by the margin.
        let atCorner = MirrorLayout.anchoredFrame(windowFrame: CGRect(x: 0, y: 25, width: 800, height: 600),
                                                  panelSize: CGSize(width: 366, height: 251), screens: [laptop], tuning: t)
        XCTAssertEqual(atCorner.origin, CGPoint(x: 10, y: 35))
        // Window hanging off the bottom-right: the panel is pulled back on screen.
        let offEdge = MirrorLayout.anchoredFrame(windowFrame: CGRect(x: 1400, y: 800, width: 800, height: 600),
                                                 panelSize: CGSize(width: 366, height: 251), screens: [laptop], tuning: t)
        XCTAssertEqual(offEdge.origin, CGPoint(x: 1512 - 10 - 366, y: 25 + 897 - 10 - 251))
    }

    func testAnchorUsesTheScreenTheWindowIsOn() {
        let window = CGRect(x: 1600, y: 100, width: 900, height: 700)
        let frame = MirrorLayout.anchoredFrame(windowFrame: window, panelSize: CGSize(width: 366, height: 251),
                                               screens: [laptop, external], tuning: t)
        XCTAssertEqual(frame.origin, CGPoint(x: 1604, y: 104))
    }

    // MARK: - Visibility

    func testClassify() {
        let frame = CGRect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertEqual(WindowVisibility.classify(WindowSnapshot(frame: frame, isOnScreen: true), screens: [laptop],
                                                 minVisibleArea: t.minVisibleArea), .visible(frame))
        // Minimized or on another Space: the window server says not on screen.
        XCTAssertEqual(WindowVisibility.classify(WindowSnapshot(frame: frame, isOnScreen: false), screens: [laptop],
                                                 minVisibleArea: t.minVisibleArea), .hidden(lastFrame: frame))
        // On screen by the flag but outside every display.
        let away = CGRect(x: 5000, y: 5000, width: 800, height: 600)
        XCTAssertEqual(WindowVisibility.classify(WindowSnapshot(frame: away, isOnScreen: true), screens: [laptop],
                                                 minVisibleArea: t.minVisibleArea), .hidden(lastFrame: away))
        // A sliver (10×10) left on screen is not enough.
        let sliver = CGRect(x: 1502, y: 972, width: 800, height: 600)
        XCTAssertFalse(WindowVisibility.classify(WindowSnapshot(frame: sliver, isOnScreen: true), screens: [laptop],
                                                 minVisibleArea: t.minVisibleArea).isVisible)
        // Gone, or empty.
        XCTAssertEqual(WindowVisibility.classify(nil, screens: [laptop], minVisibleArea: t.minVisibleArea),
                       .hidden(lastFrame: nil))
        XCTAssertFalse(WindowVisibility.classify(WindowSnapshot(frame: CGRect(x: 10, y: 10, width: 0, height: 50),
                                                                isOnScreen: true),
                                                 screens: [laptop], minVisibleArea: t.minVisibleArea).isVisible)
    }

    // MARK: - Docking

    func testNearestCorner() {
        let area = laptop.visibleFrame
        XCTAssertEqual(MirrorLayout.nearestCorner(to: CGPoint(x: 100, y: 100), in: area), .topLeft)
        XCTAssertEqual(MirrorLayout.nearestCorner(to: CGPoint(x: 1400, y: 100), in: area), .topRight)
        XCTAssertEqual(MirrorLayout.nearestCorner(to: CGPoint(x: 100, y: 900), in: area), .bottomLeft)
        XCTAssertEqual(MirrorLayout.nearestCorner(to: CGPoint(x: 1400, y: 900), in: area), .bottomRight)
    }

    func testAMinimizedWindowDocksInTheCornerNearestItsLastFrame() {
        let size = CGSize(width: 366, height: 251)
        let last = CGRect(x: 900, y: 500, width: 500, height: 400) // centre (1150, 700): bottom-right quadrant
        let frames = MirrorLayout.frames(for: [.init(presence: .hidden(lastFrame: last), panelSize: size)],
                                         screens: [laptop], tuning: t)
        XCTAssertEqual(frames, [CGRect(x: 1512 - 10 - 366, y: 25 + 897 - 10 - 251, width: 366, height: 251)])
    }

    func testAnUnknownWindowDocksTopRightOnTheMainScreen() {
        let size = CGSize(width: 366, height: 251)
        let frames = MirrorLayout.frames(for: [.init(presence: .hidden(lastFrame: nil), panelSize: size)],
                                         screens: [laptop, external], tuning: t)
        XCTAssertEqual(frames, [CGRect(x: 1512 - 10 - 366, y: 35, width: 366, height: 251)])
    }

    func testTwoMirrorsDockedInOneCornerStackNewestInTheCorner() {
        let a = CGSize(width: 366, height: 251), b = CGSize(width: 366, height: 200)
        let top = MirrorLayout.dockedFrames(panelSizes: [a, b], corner: .topRight, visibleFrame: laptop.visibleFrame, tuning: t)
        XCTAssertEqual(top[0], CGRect(x: 1136, y: 35, width: 366, height: 251))
        XCTAssertEqual(top[1], CGRect(x: 1136, y: 35 + 251 + 8, width: 366, height: 200))
        let bottom = MirrorLayout.dockedFrames(panelSizes: [a, b], corner: .bottomLeft, visibleFrame: laptop.visibleFrame, tuning: t)
        XCTAssertEqual(bottom[0], CGRect(x: 10, y: 912 - 251, width: 366, height: 251))
        XCTAssertEqual(bottom[1], CGRect(x: 10, y: 912 - 251 - 8 - 200, width: 366, height: 200))
        XCTAssertFalse(bottom[0].intersects(bottom[1]))
    }

    func testFramesMixAnchoredAndDockedAndStackOnlyWithinACorner() {
        let size = CGSize(width: 366, height: 251)
        let visible = CGRect(x: 300, y: 200, width: 800, height: 600)
        let hiddenTopLeft = CGRect(x: 50, y: 60, width: 400, height: 300)
        let hiddenOnExternal = CGRect(x: 3500, y: 1000, width: 400, height: 300)
        let frames = MirrorLayout.frames(for: [
            .init(presence: .hidden(lastFrame: hiddenTopLeft), panelSize: size),     // newest
            .init(presence: .visible(visible), panelSize: size),
            .init(presence: .hidden(lastFrame: hiddenOnExternal), panelSize: size),
        ], screens: [laptop, external], tuning: t)
        XCTAssertEqual(frames[0].origin, CGPoint(x: 10, y: 35))
        XCTAssertEqual(frames[1].origin, CGPoint(x: 304, y: 204))
        XCTAssertEqual(frames[2].origin, CGPoint(x: 1512 + 2560 - 10 - 366, y: 25 + 1415 - 10 - 251))

        let both = MirrorLayout.frames(for: [
            .init(presence: .hidden(lastFrame: hiddenTopLeft), panelSize: size),
            .init(presence: .hidden(lastFrame: CGRect(x: 0, y: 30, width: 300, height: 200)), panelSize: size),
        ], screens: [laptop], tuning: t)
        XCTAssertEqual(both[0].origin, CGPoint(x: 10, y: 35))
        XCTAssertEqual(both[1].origin, CGPoint(x: 10, y: 35 + 251 + 8))
    }

    // MARK: - Cursor mapping

    func testFractionAndPointRoundTrip() {
        let window = CGRect(x: 100, y: 200, width: 800, height: 400)
        let f = MirrorLayout.fraction(of: CGPoint(x: 300, y: 300), in: window)
        XCTAssertEqual(f, CGPoint(x: 0.25, y: 0.25))
        XCTAssertEqual(MirrorLayout.point(atFraction: f, in: window), CGPoint(x: 300, y: 300))
        // Points outside the window clamp to its edge.
        XCTAssertEqual(MirrorLayout.fraction(of: CGPoint(x: 0, y: 900), in: window), CGPoint(x: 0, y: 1))
        XCTAssertEqual(MirrorLayout.fraction(of: CGPoint(x: 5, y: 5), in: .zero), CGPoint(x: 0.5, y: 0.5))
    }

    func testAspectFitLetterboxes() {
        let bounds = CGRect(x: 0, y: 0, width: 360, height: 90)
        XCTAssertEqual(MirrorLayout.aspectFit(aspect: 2, in: bounds), CGRect(x: 90, y: 0, width: 180, height: 90))
        let tall = CGRect(x: 0, y: 0, width: 160, height: 300)
        XCTAssertEqual(MirrorLayout.aspectFit(aspect: 1, in: tall), CGRect(x: 0, y: 70, width: 160, height: 160))
    }
}
