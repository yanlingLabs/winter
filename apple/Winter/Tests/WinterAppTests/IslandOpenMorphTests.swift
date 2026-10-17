import XCTest
import WinterCUPresentation
@testable import Winter

/// The open island's morph out of the strip (no overshoot, contents after the shape, closing backwards, its top attached
/// to the screen's edge with its shoulders on every frame), its one fixed size, the strip's wing clicks that replaced
/// the badge's hover, and the hover grow: none on the open island, the compact pill's points on every floating panel.
@MainActor
final class IslandOpenMorphTests: XCTestCase {
    private let notched = IslandScreenShape(housing: CGSize(width: 185, height: 32), menuBarHeight: 32)

    private func morph(waiting: Bool = true) -> IslandOpenMorph {
        let island = IslandLayout.island(notched)
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
        XCTAssertEqual(rest.shoulder, IslandLayout.islandShoulder)
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

    // MARK: Attached to the screen's edge

    /// On EVERY frame of the morph the shape's top is the screen's edge: flat at y = 0 and flaring into it through two
    /// concave shoulders (filled just under the edge, just outside the body; NOT filled lower down, where the fillet
    /// curves away — concave, not a square ear). The first frame is the strip itself, which has none.
    func testTheTopStaysAttachedWithItsShouldersOnEveryFrame() {
        for (name, m) in [("from the strip", morph()), ("from the housing alone", morph(waiting: false)),
                          ("without a housing", morphWithoutHousing())] {
            let first = m.frame(at: 0)
            XCTAssertEqual(first.shoulder, 0, "\(name): the strip's own silhouette at the click")
            for i in 1...120 {
                let f = m.frame(at: IslandOpenMorph.settle * Double(i) / 120)
                XCTAssertEqual(f.rect.minY, 0, accuracy: 0.0001, "\(name) step \(i): flush with the screen's top")
                XCTAssertGreaterThan(f.shoulder, 0, "\(name) step \(i): the shoulders are there")
                let path = IslandEdgeShape(corner: f.corner, shoulder: f.shoulder).path(in: f.rect)
                XCTAssertEqual(path.boundingRect.minY, 0, accuracy: 0.0001, "\(name) step \(i): nothing above the edge")
                XCTAssertEqual(path.boundingRect.width, f.rect.width + 2 * f.shoulder, accuracy: 0.01,
                               "\(name) step \(i): the shoulders flare out past the body along the edge")
                let s = f.shoulder
                for (x, outward) in [(f.rect.minX, -1.0), (f.rect.maxX, 1.0)] {
                    let nearEdge = CGPoint(x: x + CGFloat(outward) * s * 0.5, y: s * 0.05)
                    XCTAssertTrue(path.contains(nearEdge), "\(name) step \(i): the shoulder fills the corner at the edge")
                    let lower = CGPoint(x: x + CGFloat(outward) * s * 0.5, y: s * 0.9)
                    XCTAssertFalse(path.contains(lower), "\(name) step \(i): concave — it curves away below the edge")
                }
                XCTAssertTrue(path.contains(CGPoint(x: f.rect.midX, y: 0.01)), "\(name) step \(i): flat top, solid to the edge")
            }
        }
        // At rest, and Reduce Motion's frame, are the island with its shoulders.
        XCTAssertEqual(IslandOpenMorph.Frame.resting(.zero).shoulder, IslandLayout.islandShoulder)
        XCTAssertEqual(IslandOpenMorph.Frame.resting(.zero).corner, IslandLayout.islandCorner)
    }

    func testAShoulderIsNeverDeeperThanTheSideItFlaresFrom() {
        XCTAssertEqual(IslandEdgeShape.clampedShoulder(14, height: 20, corner: 10), 10)
        XCTAssertEqual(IslandEdgeShape.clampedShoulder(14, height: 24, corner: 4), 12, "never more than half the height")
        XCTAssertEqual(IslandEdgeShape.clampedShoulder(14, height: 420, corner: 32), 14)
        XCTAssertEqual(IslandEdgeShape.clampedShoulder(-3, height: 420, corner: 32), 0)
    }

    private func morphWithoutHousing() -> IslandOpenMorph {
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        let island = IslandLayout.island(plain)
        let strip = IslandLayout.strip(plain)
        return IslandOpenMorph(source: strip.offsetBy(dx: island.width / 2, dy: 0),
                               target: CGRect(origin: .zero, size: island.size),
                               sourceCorner: IslandLayout.stripCorner, targetCorner: IslandLayout.islandCorner)
    }

    // MARK: One fixed size

    /// One size for every tab and whatever it lists — nothing measures the content any more (each tab scrolls inside).
    func testTheOpenIslandHasOneSizeForEveryTabAndAnyContent() throws {
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        for shape in [notched, plain] {
            let r = IslandLayout.island(shape)
            XCTAssertEqual(r.size, CGSize(width: IslandLayout.islandWidth, height: IslandLayout.islandHeight))
            XCTAssertEqual(r.size, CGSize(width: 560, height: 420))
            XCTAssertEqual(r.minY, 0)
            XCTAssertEqual(r.midX, 0, accuracy: 0.001)
            XCTAssertEqual(IslandLayout.island(shape, screenHeight: 956), r, "fits the smallest current Mac screen")
        }
        // A short screen clamps it — the same for every tab there.
        XCTAssertEqual(IslandLayout.island(notched, screenHeight: 600).height, 360)
        XCTAssertLessThanOrEqual(IslandLayout.island(notched, screenHeight: 600).height, 600)
        // The controller no longer measures a tab (it used to size the island to the selected tab's content).
        let code = try String(contentsOf: sourceFile("IslandController.swift"), encoding: .utf8)
        XCTAssertFalse(code.contains("islandContentHeight"), "the open island never measures its content")
        XCTAssertFalse(code.contains("IslandTabBody("), "nor a tab's body")
        XCTAssertFalse(code.contains("relayoutSoon"), "a tab change or new content never relayouts it")
    }

    // MARK: Hover

    /// The open island has no hover grow at all (its rows and tiles glow; the island stays put), and no rim.
    func testTheOpenIslandHasNoHoverGrowNorRim() throws {
        let code = try String(contentsOf: sourceFile("IslandOpenMorph.swift"), encoding: .utf8)
        let frame = try XCTUnwrap(code.range(of: "struct IslandOpenFrame").map { code[$0.lowerBound...] })
        let body = String(frame[..<(frame.range(of: "struct IslandEdgeShape")?.lowerBound ?? frame.endIndex)])
        for forbidden in ["islandHoverGrow", "hoverGrowth(", "scaleEffect", "strokeBorder", "hovered"] {
            XCTAssertFalse(body.contains(forbidden), "the open island's frame uses \(forbidden)")
        }
        let model = IslandOpenModel()
        XCTAssertFalse(Mirror(reflecting: model).children.contains { ($0.label ?? "").contains("hovered") },
                       "the open island's model has no hover state")
    }

    /// Every floating panel grows by the compact Dispatch pill's POINTS (`HoverGrowth`), not by 3 % of itself.
    func testEveryFloatingIslandPanelGrowsByTheCompactPillsPoints() {
        let points = DispatchPillMetrics.compactWidth * (DispatchPillMetrics.hoverScale - 1)
        for size in [CGSize(width: IslandLayout.cardWidth, height: 160),          // an island card
                     CGSize(width: IslandLayout.waitingWidth, height: IslandLayout.waitingHeight), // the waiting pill
                     CGSize(width: IslandActivityLayout.cuPillWidth, height: 44),  // the computer-use pill
                     IslandActivityLayout.mirrorSize] {                            // the in-island mirror
            let rect = CGRect(origin: CGPoint(x: 30, y: 42), size: size)
            let grown = IslandHover.grown(rect)
            XCTAssertEqual(grown.width - rect.width, points, accuracy: 0.0001, "\(size): the same points wider")
            XCTAssertEqual(grown.height / rect.height, grown.width / rect.width, accuracy: 0.0001, "\(size): uniform")
            XCTAssertEqual(grown.minY, rect.minY, "\(size): from its top edge")
            XCTAssertEqual(grown.midX, rect.midX, accuracy: 0.0001)
        }
    }

    /// No island view writes its own grow: a `scaleEffect` is only a press's shrink (the hover goes through
    /// `islandHoverGrow`/`HoverGrowth`), and no literal hover factor appears in the island's sources.
    func testNoIslandSourceHardCodesAHoverScale() throws {
        let folder = sourceFile("")
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 10)
        for file in files {
            let code = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            for (i, line) in code.enumerated() {
                XCTAssertFalse(line.contains("1.03"), "\(file.lastPathComponent):\(i + 1) hard-codes a hover grow: use HoverGrowth")
                if line.contains("scaleEffect(") {
                    XCTAssertTrue(line.contains("isPressed"), "\(file.lastPathComponent):\(i + 1) scales outside HoverGrowth: \(line)")
                }
            }
        }
    }

    /// The hit area is the drawn shape: the resting one, and the grown one while hovered (so no flicker at the edge);
    /// the pointer is mapped into the panel's own unscaled space, where its rows and buttons sit.
    func testTheHitAreaAndThePointerFollowTheGrownShape() {
        let rect = CGRect(x: 100, y: 40, width: 400, height: 200)
        let grown = IslandHover.grown(rect)
        let s = HoverGrowth.factor(forWidth: 400)
        XCTAssertEqual(grown.minY, rect.minY, "it grows from its top edge")
        XCTAssertEqual(grown.midX, rect.midX, accuracy: 0.001)
        XCTAssertEqual(grown.width, 400 + HoverGrowth.points, accuracy: 0.001)
        XCTAssertEqual(grown.height, 200 * s, accuracy: 0.001)
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

    private func sourceFile(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/Island").appendingPathComponent(name)
    }
}
