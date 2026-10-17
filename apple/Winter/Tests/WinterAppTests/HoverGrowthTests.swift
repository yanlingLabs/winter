import XCTest
import AppKit
import SwiftUI
import WinterCUPresentation
@testable import Winter

/// The hover grow every floating panel shares (`HoverGrowth`, user 2026-10-17): the compact Dispatch pill's own 3 %,
/// in POINTS — 316 × 0.03 = 9.48 pt wider, the height in proportion — for every panel whatever its size, so a large
/// card no longer grows far more than the pill it came from; and the Dispatch pill's stack, its hit area and its child
/// pills following it.
@MainActor
final class HoverGrowthTests: XCTestCase {
    private let compact = CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)

    func testTheReferenceIsTheCompactPillsOwnGrow() {
        XCTAssertEqual(HoverGrowth.referenceSize, compact, "the package's reference is the compact Dispatch pill")
        XCTAssertEqual(HoverGrowth.referenceScale, DispatchPillMetrics.hoverScale)
        XCTAssertEqual(HoverGrowth.points, 9.48, accuracy: 0.000_1, "316 × 3 %")
    }

    /// The compact pill looks exactly as it always did: 3 % on both axes (9.48 pt wider, 1.32 pt taller).
    func testTheCompactPillGrowsExactlyAsBefore() {
        let s = HoverGrowth.scale(for: compact)
        XCTAssertEqual(s.width, 1.03, accuracy: 0.000_001)
        XCTAssertEqual(s.height, 1.03, accuracy: 0.000_001)
        let grown = HoverGrowth.grown(CGRect(origin: .zero, size: compact), anchor: .bottom)
        XCTAssertEqual(grown.width - compact.width, 9.48, accuracy: 0.000_1)
        XCTAssertEqual(grown.height - compact.height, 1.32, accuracy: 0.000_1)
        XCTAssertEqual(grown.maxY, compact.height, accuracy: 0.000_1, "the pill's stack grows from its bottom edge")
    }

    /// Larger panels grow by the SAME absolute points (their width), so by a smaller factor — uniformly, no stretch.
    func testLargerPanelsGrowByTheSamePointsNotTheSamePercent() {
        let panels: [(String, CGSize, CGFloat)] = [
            ("the pill's card", CGSize(width: DispatchPillMetrics.cardWidth, height: 300), 1.021_545),
            ("the typing pill", CGSize(width: DispatchPillMetrics.expandedWidth, height: 120), 1.016_929),
            ("an island card", CGSize(width: IslandLayout.cardWidth, height: 160), 1.023_7),
            ("the in-island mirror", IslandActivityLayout.mirrorSize, 1.024_947),
        ]
        for (name, size, expected) in panels {
            let s = HoverGrowth.scale(for: size)
            XCTAssertEqual(s.width, expected, accuracy: 0.000_01, name)
            XCTAssertEqual(s.width, s.height, "\(name): uniform")
            let grown = HoverGrowth.grown(CGRect(origin: .zero, size: size), anchor: .top)
            XCTAssertEqual(grown.width - size.width, 9.48, accuracy: 0.000_1, "\(name): the compact pill's points, not 3 %")
            XCTAssertLessThan(grown.width - size.width, size.width * 0.03, "\(name): less than 3 % of itself")
        }
        XCTAssertEqual(HoverGrowth.scale(for: .zero), CGSize(width: 1, height: 1), "nothing to grow")
    }

    /// The Dispatch pill's stack grows by the factor for the main pill's TARGET width: 3 % compact, less as a card or
    /// typing — published on a retarget only.
    func testTheDispatchPillsGrowFollowsItsShape() {
        let pill = makePill()
        pill.setPresentationForTesting(.compact)
        XCTAssertEqual(pill.hoverScale, 1.03, accuracy: 0.000_001)
        pill.setPresentationForTesting(.expanded)
        XCTAssertEqual(pill.hoverScale, HoverGrowth.factor(forWidth: DispatchPillMetrics.expandedWidth), accuracy: 0.000_001)
        XCTAssertEqual(pill.drawnHoverScale, 1, "not hovered: no grow")
        pill.setPointerOverForTesting(true)
        XCTAssertEqual(pill.drawnHoverScale, pill.hoverScale)
        pill.setPresentationForTesting(.fullScreen)
        XCTAssertEqual(pill.drawnHoverScale, 1, "full screen never grows")
    }

    /// The hit area is the drawn stack: the grown one while hovered (both the pill and what floats above it, about the
    /// pill's bottom centre), the resting one otherwise.
    func testTheDispatchPillsHitAreaIsTheGrownStackWhileHovered() {
        let canvas = CGSize(width: 600, height: 400)
        let main = CGSize(width: DispatchPillMetrics.cardWidth, height: 200)
        let rest = dispatchPillMainRect(canvasSize: canvas, mainSize: main)
        let s = HoverGrowth.factor(forWidth: main.width)
        let besideTheTop = CGPoint(x: rest.maxX + 3, y: rest.minY + 4) // outside the resting card, inside the grown one
        XCTAssertFalse(dispatchPillHitTest(point: besideTheTop, canvasSize: canvas, mainSize: main, accessoryFrame: .zero))
        XCTAssertTrue(dispatchPillHitTest(point: besideTheTop, canvasSize: canvas, mainSize: main, accessoryFrame: .zero, scale: s))
        XCTAssertFalse(dispatchPillHitTest(point: CGPoint(x: rest.maxX + 6, y: rest.minY + 4), canvasSize: canvas, mainSize: main,
                                           accessoryFrame: .zero, scale: s), "the grown card is only 4.74 pt wider each side")
        XCTAssertFalse(dispatchPillHitTest(point: CGPoint(x: rest.midX, y: rest.maxY + 1), canvasSize: canvas, mainSize: main,
                                           accessoryFrame: .zero, scale: s), "it grows up from its bottom edge, not down")
        // A child pill above it moves up with the stack.
        let child = CGRect(x: rest.minX, y: rest.minY - 8 - 44, width: main.width, height: 44)
        let aboveChild = CGPoint(x: child.midX, y: child.minY - 3)
        XCTAssertFalse(dispatchPillHitTest(point: aboveChild, canvasSize: canvas, mainSize: main, accessoryFrame: child))
        XCTAssertTrue(dispatchPillHitTest(point: aboveChild, canvasSize: canvas, mainSize: main, accessoryFrame: child, scale: s))
    }

    /// Growing from the bottom LIFTS the child row: the bottom of the resting row lies in the grown stack's gap. Judged
    /// on the grown shape alone the pointer there would leave the hover, the stack would shrink back under it, hover
    /// again — a flicker. While hovered, the resting stack OR the grown one holds.
    func testTheChildRowsBandHoldsTheHoverWithoutFlicker() {
        let canvas = CGSize(width: 600, height: 400)
        let main = CGSize(width: DispatchPillMetrics.cardWidth, height: 200)
        let rest = dispatchPillMainRect(canvasSize: canvas, mainSize: main)
        let s = HoverGrowth.factor(forWidth: main.width)
        let child = CGRect(x: rest.minX, y: rest.minY - DispatchPillMetrics.stackGap - 44, width: main.width, height: 44)
        let pivot = CGPoint(x: canvas.width / 2, y: rest.maxY)
        let grownChild = HoverGrowth.grown(child, about: pivot, scale: CGSize(width: s, height: s))
        let grownMain = HoverGrowth.grown(rest, about: pivot, scale: CGSize(width: s, height: s))
        let band = CGPoint(x: child.midX, y: child.maxY - 0.5)
        XCTAssertGreaterThan(band.y, grownChild.maxY, "the band is below the lifted row…")
        XCTAssertLessThan(band.y, grownMain.minY, "…and above the grown card: in the grown gap")
        XCTAssertGreaterThan(child.maxY - grownChild.maxY, 4, "a band of several points on a card")
        XCTAssertTrue(dispatchPillHitTest(point: band, canvasSize: canvas, mainSize: main, accessoryFrame: child),
                      "at rest: on the row")
        XCTAssertTrue(dispatchPillHitTest(point: band, canvasSize: canvas, mainSize: main, accessoryFrame: child, scale: s),
                      "hovered: still held — no flicker")
        // The compact pill has the same band, smaller (1.56 pt).
        let compactRest = dispatchPillMainRect(canvasSize: canvas, mainSize: compact)
        let compactChild = CGRect(x: compactRest.minX, y: compactRest.minY - DispatchPillMetrics.stackGap - 44,
                                  width: compact.width, height: 44)
        XCTAssertTrue(dispatchPillHitTest(point: CGPoint(x: compactChild.midX, y: compactChild.maxY - 0.3), canvasSize: canvas,
                                          mainSize: compact, accessoryFrame: compactChild, scale: 1.03))
    }

    /// Hovered, the child pills still follow the main pill: their row is laid out as wide as the pill (the stack then
    /// grows as one), so the floating layers' measured frame is the RESTING one the gate grows itself.
    func testTheChildPillsFollowThePillWhileHovered() {
        let session = SessionModel()
        session.applyForTesting { s in
            s.children = [ChildItem(sessionId: "c1", title: "a", status: "running"),
                          ChildItem(sessionId: "c2", title: "b", status: "running")]
        }
        let pill = makePill(session)
        pill.setPresentationForTesting(.expanded)
        let host = NSHostingView(rootView: DispatchPillView(controller: pill))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: pill.canvas.size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView = host
        func settle() {
            for _ in 0..<3 {
                host.frame = CGRect(origin: .zero, size: pill.canvas.size)
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            }
        }
        settle()
        let resting = pill.accessoryFrameForTesting
        XCTAssertEqual(resting.width, DispatchPillMetrics.expandedWidth, accuracy: 0.5, "the row is the pill's width")
        pill.setPointerOverForTesting(true)
        settle()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6)) // the hover spring
        settle()
        XCTAssertEqual(pill.accessoryFrameForTesting.width, resting.width, accuracy: 0.5,
                       "hovered, the row is still laid out at the pill's width (the stack grows as one)")
    }

    private func makePill(_ session: SessionModel? = nil) -> DispatchPillController {
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: "WinterTests.HoverGrowth")!)
        let pill = DispatchPillController(session: session ?? SessionModel(), settings: settings)
        pill.visibleFrameOverrideForTesting = CGRect(x: 100, y: 80, width: 1440, height: 820)
        return pill
    }
}
