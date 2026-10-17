import XCTest
import WinterCUPresentation
@testable import Winter

/// The open island's morph out of the strip (no overshoot, contents after the shape, closing backwards), the strip's
/// wing clicks that replaced the badge's hover, and the one hover grow every island panel shares.
@MainActor
final class IslandOpenMorphTests: XCTestCase {
    private let notched = IslandScreenShape(housing: CGSize(width: 185, height: 32), menuBarHeight: 32)

    private func morph(waiting: Bool = true) -> IslandOpenMorph {
        let island = IslandLayout.island(notched, contentHeight: 400)
        let strip = IslandLayout.strip(notched, waiting: waiting)!
        return IslandOpenMorph(source: strip.offsetBy(dx: island.width / 2, dy: 0),
                               target: CGRect(origin: .zero, size: island.size),
                               sourceCorner: IslandLayout.stripCorner, targetCorner: IslandLayout.islandCorner)
    }

    // MARK: The morph

    func testItGrowsOutOfTheStripWithoutOvershoot() {
        let m = morph()
        let first = m.frame(at: 0)
        XCTAssertEqual(first.rect, m.source, "it starts as the strip itself")
        XCTAssertEqual(first.content, 0)
        var last = first
        for i in 1...200 {
            let f = m.frame(at: IslandOpenMorph.settle * Double(i) / 200)
            XCTAssertLessThanOrEqual(f.rect.width, m.target.width + 0.001, "no overshoot in width at step \(i)")
            XCTAssertLessThanOrEqual(f.rect.height, m.target.height + 0.001, "no overshoot in height at step \(i)")
            XCTAssertGreaterThanOrEqual(f.rect.width, last.rect.width - 0.001, "the width only grows (no bounce) at step \(i)")
            XCTAssertGreaterThanOrEqual(f.rect.height, last.rect.height - 0.001, "the height only grows (no bounce) at step \(i)")
            XCTAssertEqual(f.rect.minY, 0, accuracy: 0.001, "always hanging from the screen's top")
            XCTAssertEqual(f.rect.midX, m.target.midX, accuracy: 0.001, "always centred under the housing")
            XCTAssertLessThanOrEqual(f.corner, min(f.rect.width, f.rect.height) / 2 + 0.001)
            last = f
        }
        let rest = m.frame(at: IslandOpenMorph.settle)
        XCTAssertEqual(rest.rect, m.target, "at rest exactly the island")
        XCTAssertEqual(rest.corner, IslandLayout.islandCorner)
        XCTAssertEqual(rest.content, 1)
        XCTAssertEqual(rest.blur, 0)
    }

    func testTheContentsComeInOnlyAfterTheShapeHasGrown() {
        let m = morph()
        for i in 0...100 {
            let f = m.frame(at: IslandOpenMorph.settle * Double(i) / 100)
            let grown = (f.rect.height - m.source.height) / (m.target.height - m.source.height)
            if grown < 0.5 { XCTAssertEqual(f.content, 0, "no contents while the shape is less than half grown (step \(i))") }
            if f.content > 0, f.content < 1 { XCTAssertGreaterThan(f.blur, 0, "the contents un-blur as they come in") }
        }
    }

    func testItGrowsFromTheHousingAloneWhenNothingWaits() {
        let m = morph(waiting: false)
        XCTAssertEqual(m.frame(at: 0).rect.width, 185, accuracy: 0.001, "idle: the strip is the housing alone")
        XCTAssertEqual(m.frame(at: IslandOpenMorph.settle).rect, m.target)
    }

    func testClosingPlaysTheOpeningBackwardsFasterAndAReopenNeverJumps() {
        let model = IslandOpenModel()
        let t0 = Date(timeIntervalSince1970: 1000)
        model.beginOpening(now: t0)
        XCTAssertFalse(model.still, "frames run while it moves")
        XCTAssertEqual(model.seconds(at: t0.addingTimeInterval(0.2)), 0.2, accuracy: 1e-5)
        XCTAssertEqual(model.seconds(at: t0.addingTimeInterval(5)), IslandOpenMorph.settle, accuracy: 1e-5)
        model.settled()
        XCTAssertTrue(model.still, "at rest: no frame driver")
        // Close from rest: back to the strip in settle / closeSpeed.
        let t1 = t0.addingTimeInterval(10)
        let back = model.beginClosing(now: t1)
        XCTAssertEqual(back, IslandOpenMorph.settle / IslandOpenMorph.closeSpeed, accuracy: 1e-5)
        XCTAssertFalse(model.still)
        XCTAssertEqual(model.seconds(at: t1.addingTimeInterval(back)), 0, accuracy: 1e-5)
        // Reopened halfway back: it continues from where the shape is.
        let t2 = t1.addingTimeInterval(back / 2)
        let midway = model.seconds(at: t2)
        model.beginOpening(now: t2)
        XCTAssertEqual(model.seconds(at: t2), midway, accuracy: 1e-5)
        model.reset()
        XCTAssertTrue(model.still)
        XCTAssertEqual(model.seconds(at: Date()), 0)
    }

    func testReduceMotionOpensAtRest() {
        let model = IslandOpenModel()
        model.beginOpening(instant: true)
        XCTAssertTrue(model.still)
        XCTAssertEqual(model.seconds(at: Date()), IslandOpenMorph.settle, accuracy: 0.01)
    }

    // MARK: The strip's wings (what replaced the badge's hover)

    func testAClickOnTheWaitingWingOpensNeedsYou() {
        let waiting = IslandStripModel(waitingCount: 2, workingCount: 1)
        let leftWing = CGPoint(x: -185 / 2 - IslandLayout.stripWing / 2, y: 16)
        let rightWing = CGPoint(x: 185 / 2 + IslandLayout.stripWing / 2, y: 16)
        XCTAssertEqual(IslandLayout.stripPart(at: leftWing, notched, model: waiting), .waitingWing)
        XCTAssertEqual(IslandLayout.stripPart(at: rightWing, notched, model: waiting), .workingWing)
        XCTAssertEqual(IslandLayout.stripPart(at: CGPoint(x: 0, y: 16), notched, model: waiting), .housing)
        XCTAssertNil(IslandLayout.stripPart(at: CGPoint(x: 0, y: 40), notched, model: waiting), "below the strip")
        // Closed: the waiting wing opens straight on Needs you, the working wing on Sessions, the housing where it was.
        XCTAssertEqual(IslandStripPart.waitingWing.action(isOpen: false, selectedTab: IslandTabRegistry.shelf.id),
                       .open(tab: IslandTabRegistry.needsYou.id))
        XCTAssertEqual(IslandStripPart.workingWing.action(isOpen: false, selectedTab: nil), .open(tab: IslandTabRegistry.sessions.id))
        XCTAssertEqual(IslandStripPart.housing.action(isOpen: false, selectedTab: IslandTabRegistry.shelf.id), .open(tab: nil))
        // Open on another tab: the wing switches to its tab; on its own tab (or the housing) it closes.
        XCTAssertEqual(IslandStripPart.waitingWing.action(isOpen: true, selectedTab: IslandTabRegistry.shelf.id),
                       .select(IslandTabRegistry.needsYou.id))
        XCTAssertEqual(IslandStripPart.waitingWing.action(isOpen: true, selectedTab: IslandTabRegistry.needsYou.id), .close)
        XCTAssertEqual(IslandStripPart.housing.action(isOpen: true, selectedTab: IslandTabRegistry.needsYou.id), .close)
    }

    func testAnEmptyWingIsTheHousingsAndIdleIsTheHousingAlone() {
        let workingOnly = IslandStripModel(waitingCount: 0, workingCount: 2)
        let leftWing = CGPoint(x: -185 / 2 - 10, y: 16)
        XCTAssertEqual(IslandLayout.stripPart(at: leftWing, notched, model: workingOnly), .housing,
                       "nothing waits: the left wing says nothing, so it opens nothing in particular")
        let idle = IslandStripModel(waitingCount: 0, workingCount: 0)
        XCTAssertNil(IslandLayout.stripPart(at: leftWing, notched, model: idle), "idle: no wings, nothing but the housing takes a click")
        XCTAssertEqual(IslandLayout.stripPart(at: CGPoint(x: 0, y: 10), notched, model: idle), .housing)
        // Without a housing: the tab's halves, or all of it for the one group it shows.
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        XCTAssertNil(IslandLayout.stripPart(at: CGPoint(x: 0, y: 10), plain, model: idle), "no housing, nothing waiting: no strip")
        XCTAssertEqual(IslandLayout.stripPart(at: CGPoint(x: 30, y: 10), plain, model: IslandStripModel(waitingCount: 1)), .waitingWing)
        let both = IslandStripModel(waitingCount: 1, workingCount: 1)
        XCTAssertEqual(IslandLayout.stripPart(at: CGPoint(x: -30, y: 10), plain, model: both), .waitingWing)
        XCTAssertEqual(IslandLayout.stripPart(at: CGPoint(x: 30, y: 10), plain, model: both), .workingWing)
    }

    // MARK: One hover grow

    func testEveryIslandPanelGrowsByTheDispatchPillsOwnHover() {
        XCTAssertEqual(IslandHover.scale, DispatchPillMetrics.hoverScale)
        XCTAssertEqual(DesktopIslandGeometry.hoverScale, DispatchPillMetrics.hoverScale,
                       "the cards' liquid frame (WinterCUPresentation) grows by the same amount")
    }

    /// No island view writes its own grow: every `scaleEffect` under the pointer goes through `IslandHover` (a press's
    /// shrink is not a hover), and no literal hover factor appears in the island's sources.
    func testNoIslandSourceHardCodesAHoverScale() throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Island")
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 10)
        for file in files {
            let code = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            for (i, line) in code.enumerated() {
                XCTAssertFalse(line.contains("1.03"), "\(file.lastPathComponent):\(i + 1) hard-codes a hover grow: use IslandHover")
                if line.contains("scaleEffect(") {
                    XCTAssertTrue(line.contains("isPressed") || line.contains("IslandHover.scale"),
                                  "\(file.lastPathComponent):\(i + 1) scales outside IslandHover: \(line)")
                }
            }
        }
    }

    /// The hit area is the drawn shape: the resting one, and the grown one while hovered (so no flicker at the edge);
    /// the pointer is mapped into the panel's own unscaled space, where its rows and buttons sit.
    func testTheHitAreaAndThePointerFollowTheGrownShape() {
        let rect = CGRect(x: 100, y: 40, width: 400, height: 200)
        let grown = IslandHover.grown(rect)
        XCTAssertEqual(grown.minY, rect.minY, "it grows from its top edge")
        XCTAssertEqual(grown.midX, rect.midX, accuracy: 0.001)
        XCTAssertEqual(grown.width, 400 * IslandHover.scale, accuracy: 0.001)
        XCTAssertEqual(grown.height, 200 * IslandHover.scale, accuracy: 0.001)
        let band = CGPoint(x: rect.maxX + 3, y: rect.midY) // outside the resting shape, inside the grown one
        XCTAssertFalse(IslandHover.isOver(band, rect, wasHovered: false), "not hovered yet: the resting shape")
        XCTAssertTrue(IslandHover.isOver(band, rect, wasHovered: true), "hovered: the grown shape still holds it")
        XCTAssertFalse(IslandHover.isOver(CGPoint(x: grown.maxX + 1, y: rect.midY), rect, wasHovered: true))
        XCTAssertFalse(IslandHover.isOver(nil, rect, wasHovered: true))
        // The grown shape's corners map onto the resting panel's own corners.
        let topRight = IslandHover.unscaled(CGPoint(x: grown.maxX, y: grown.minY), in: rect, grown: true)
        XCTAssertEqual(topRight.x, rect.width, accuracy: 0.001)
        XCTAssertEqual(topRight.y, 0, accuracy: 0.001)
        let bottomLeft = IslandHover.unscaled(CGPoint(x: grown.minX, y: grown.maxY), in: rect, grown: true)
        XCTAssertEqual(bottomLeft.x, 0, accuracy: 0.001)
        XCTAssertEqual(bottomLeft.y, rect.height, accuracy: 0.001)
        // At rest the mapping is just the panel's origin.
        XCTAssertEqual(IslandHover.unscaled(CGPoint(x: 150, y: 60), in: rect, grown: false), CGPoint(x: 50, y: 20))
    }
}
