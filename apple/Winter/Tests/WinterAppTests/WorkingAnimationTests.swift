import XCTest
import AppKit
@testable import Winter

/// The working animation's model: the plume's flow, the icon cross-fade, the idle symbol rotation,
/// and the tool→symbol map.
final class WorkingAnimationTests: XCTestCase {
    /// Advance in frame-sized steps — a single tick is clamped to `maxStep`.
    private func advance(_ model: inout WorkingAnimationModel, by seconds: Double, toolSymbol: String?) {
        var left = seconds
        while left > 1e-12 {
            let step = min(left, 1.0 / 60.0)
            model.tick(dt: step, toolSymbol: toolSymbol)
            left -= step
        }
    }

    // MARK: - The plume

    private let rect = CGRect(x: 0, y: 0, width: 300, height: 44)
    private let emitterX: CGFloat = 278
    private let tailX: CGFloat = 50

    private func puff(_ progress: Double, lane: Double = 0, size: Double = 1, spark: Bool = false) -> PropulsionPlume.Puff {
        PropulsionPlume.Puff(age: progress, lifetime: 1, lane: lane, size: size, spark: spark)
    }

    func testAPuffIsBornAtTheNozzleBigHotAndOnTheMidLine() {
        let c = PropulsionPlume.circle(for: puff(0, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertEqual(c.center.x, emitterX, accuracy: 1e-9)
        XCTAssertEqual(c.center.y, rect.midY, accuracy: 1e-9, "no spread yet at the nozzle")
        XCTAssertEqual(c.diameter, rect.height * PropulsionPlume.nozzleDiameterShare, accuracy: 1e-9)
        XCTAssertEqual(c.heat, 1)
    }

    func testDownThePlumeAPuffTravelsLeftShrinksSpreadsAndCools() {
        var last = PropulsionPlume.circle(for: puff(0, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
        for p in stride(from: 0.1, through: 0.8, by: 0.1) {
            let c = PropulsionPlume.circle(for: puff(p, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
            XCTAssertLessThan(c.center.x, last.center.x, "streams toward the leading end")
            XCTAssertLessThan(c.diameter, last.diameter, "shrinks")
            XCTAssertLessThan(c.heat, last.heat, "cools")
            XCTAssertGreaterThanOrEqual(c.center.y, last.center.y, "drifts out to its lane")
            last = c
        }
    }

    func testPuffsBunchAtTheNozzleAndThinOutDownstream() {
        // Equal slices of life cover less ground near the nozzle than near the tail — the clumping
        // that reads as thrust.
        let x = { (p: Double) in PropulsionPlume.circle(for: self.puff(p), in: self.rect,
                                                        emitterX: self.emitterX, tailX: self.tailX).center.x }
        XCTAssertLessThan(x(0) - x(0.2), x(0.6) - x(0.8))
    }

    func testAPuffShrinksAwayToNothingAtTheTailNeverPops() {
        let end = PropulsionPlume.circle(for: puff(1), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertEqual(end.diameter, 0, accuracy: 1e-9)
        XCTAssertEqual(end.center.x, tailX, accuracy: 1e-9)
        let nearly = PropulsionPlume.circle(for: puff(0.97), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertLessThan(nearly.diameter, 4)
    }

    func testEveryCircleStaysInsideThePlumesHeight() {
        for p in stride(from: 0.0, through: 1.0, by: 0.05) {
            for lane in [-1.0, -0.4, 0, 0.7, 1] {
                for spark in [false, true] {
                    let c = PropulsionPlume.circle(for: puff(p, lane: lane, spark: spark), in: rect,
                                                   emitterX: emitterX, tailX: tailX)
                    XCTAssertGreaterThanOrEqual(c.center.y - c.diameter / 2, rect.minY - 1e-9)
                    XCTAssertLessThanOrEqual(c.center.y + c.diameter / 2, rect.maxY + 1e-9)
                }
            }
        }
    }

    func testSparksAreSmallHotAndQuickerThanPuffs() {
        let spark = PropulsionPlume.circle(for: puff(0.5, spark: true), in: rect, emitterX: emitterX, tailX: tailX)
        let puffCircle = PropulsionPlume.circle(for: puff(0.5), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertLessThan(spark.diameter, puffCircle.diameter / 2)
        XCTAssertEqual(spark.heat, 1)
        XCTAssertLessThan(spark.center.x, puffCircle.center.x, "further down the plume at the same progress")
    }

    func testTheWorkingPlumeStartsFullAndStaysFull() {
        var model = WorkingAnimationModel()
        let initial = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertGreaterThan(initial.count, 15, "pre-warmed: never visibly fills up")
        XCTAssertTrue(initial.contains { $0.center.x < (emitterX + tailX) / 2 }, "already reaching the tail")
        let cap = Int(PropulsionPlume.puffsPerSecond * PropulsionPlume.puffLifetime.upperBound
                      + PropulsionPlume.sparksPerSecond * PropulsionPlume.sparkLifetime.upperBound) + 2
        for _ in 0..<600 {
            model.tick(dt: 1.0 / 60.0, toolSymbol: nil)
            XCTAssertLessThanOrEqual(model.plume.puffs.count, cap)
            XCTAssertGreaterThan(model.plume.puffs.count, 15)
        }
    }

    func testThePlumeFlows() {
        var model = WorkingAnimationModel()
        let before = model.plume.puffs
        model.tick(dt: 1.0 / 60.0, toolSymbol: nil)
        let survivors = model.plume.puffs.prefix { p in before.contains { $0.lifetime == p.lifetime && $0.lane == p.lane } }
        XCTAssertFalse(survivors.isEmpty)
        for p in survivors {
            let old = before.first { $0.lifetime == p.lifetime && $0.lane == p.lane }!
            XCTAssertEqual(p.age, old.age + 1.0 / 60.0, accuracy: 1e-9, "every puff ages with the clock")
        }
    }

    func testAStallIsClampedAndReduceMotionHoldsThePlume() {
        var model = WorkingAnimationModel()
        let before = model.plume
        model.tick(dt: 30, toolSymbol: nil) // the app was suspended
        XCTAssertFalse(model.plume.puffs.isEmpty, "a long gap never empties the plume")
        var still = WorkingAnimationModel()
        still.tick(dt: 1.0 / 60.0, toolSymbol: nil, animatesPlume: false)
        XCTAssertEqual(still.plume, before, "Reduce Motion: the plume holds")
        var frozen = WorkingAnimationModel()
        frozen.tick(dt: -1, toolSymbol: nil)
        XCTAssertEqual(frozen.plume, before, "a negative dt is no time at all")
    }

    func testThePlumeIsReproducibleFromItsSeed() {
        var a = WorkingAnimationModel(seed: 42)
        var b = WorkingAnimationModel(seed: 42)
        for _ in 0..<90 { a.tick(dt: 1.0 / 60.0, toolSymbol: nil); b.tick(dt: 1.0 / 60.0, toolSymbol: nil) }
        XCTAssertEqual(a.plume, b.plume)
        XCTAssertNotEqual(WorkingAnimationModel(seed: 1).plume, WorkingAnimationModel(seed: 2).plume)
    }

    func testThePlumeIsWhiteHotAtTheNozzleAndDeepBlueAtTheTail() {
        let hot = plumeColorComponents(heat: 1)
        let cool = plumeColorComponents(heat: 0)
        XCTAssertGreaterThan(hot.red, 0.7)
        XCTAssertGreaterThan(hot.green, 0.85)
        XCTAssertLessThan(cool.red, 0.15)
        XCTAssertEqual(cool.blue, 1)
        let mid = plumeColorComponents(heat: 0.3)
        XCTAssertGreaterThan(mid.green, cool.green)
        XCTAssertLessThan(mid.green, hot.green)
        XCTAssertEqual(plumeColorComponents(heat: 5).red, hot.red, "clamped")
    }

    // MARK: - The icon

    func testANewToolCrossFadesItsIconIn() {
        var model = WorkingAnimationModel()
        let thinking = model.symbol
        model.tick(dt: 1.0 / 60.0, toolSymbol: "terminal")
        XCTAssertEqual(model.symbol, "terminal")
        XCTAssertEqual(model.previousSymbol, thinking)
        XCTAssertEqual(model.symbolOpacity, 0, "the change itself starts the fade at zero")
        XCTAssertEqual(model.previousSymbolOpacity, 1)
        advance(&model, by: WorkingAnimationModel.crossfadeSeconds / 2, toolSymbol: "terminal")
        XCTAssertEqual(model.symbolOpacity, 0.5, accuracy: 1e-9)
        XCTAssertEqual(model.previousSymbolOpacity, 0.5, accuracy: 1e-9)
        advance(&model, by: WorkingAnimationModel.crossfadeSeconds, toolSymbol: "terminal")
        XCTAssertEqual(model.symbolOpacity, 1)
        XCTAssertNil(model.previousSymbol, "the old icon is gone once the fade completes")
        XCTAssertEqual(model.previousSymbolOpacity, 0)
    }

    func testAChangeMidFadeRestartsFromTheArrivingIcon() {
        var model = WorkingAnimationModel()
        model.tick(dt: 0.01, toolSymbol: "terminal")
        model.tick(dt: 0.05, toolSymbol: "terminal")
        model.tick(dt: 0.01, toolSymbol: "pencil")
        XCTAssertEqual(model.previousSymbol, "terminal")
        XCTAssertEqual(model.symbol, "pencil")
        XCTAssertEqual(model.crossfade, 0)
    }

    func testWhileThinkingTheIdleSymbolsRotate() {
        var model = WorkingAnimationModel()
        XCTAssertEqual(model.symbol, WorkingAnimationModel.idleSymbols[0])
        let hold = WorkingAnimationModel.idleSymbolHoldSeconds
        var t = 0.0
        while t < hold - 0.05 { model.tick(dt: 0.05, toolSymbol: nil); t += 0.05 }
        XCTAssertEqual(model.symbol, WorkingAnimationModel.idleSymbols[0], "held for the hold time")
        model.tick(dt: 0.06, toolSymbol: nil)
        XCTAssertEqual(model.symbol, WorkingAnimationModel.idleSymbols[1])
        XCTAssertEqual(model.previousSymbol, WorkingAnimationModel.idleSymbols[0], "and cross-fades")
        for _ in 0..<WorkingAnimationModel.idleSymbols.count {
            for _ in 0..<Int((hold / 0.05).rounded(.up)) { model.tick(dt: 0.05, toolSymbol: nil) }
        }
        XCTAssertTrue(WorkingAnimationModel.idleSymbols.contains(model.symbol), "the rotation wraps")
    }

    func testARunningToolHoldsItsIconAndResetsTheIdleClock() {
        var model = WorkingAnimationModel()
        for _ in 0..<100 { model.tick(dt: 0.05, toolSymbol: "terminal") }
        XCTAssertEqual(model.symbol, "terminal")
        XCTAssertEqual(model.idleElapsed, 0)
    }

    // MARK: - Tool → symbol

    func testToolSymbols() {
        XCTAssertEqual(workingToolSymbol(for: "bash"), "terminal")
        XCTAssertEqual(workingToolSymbol(for: "read"), "doc.text")
        XCTAssertEqual(workingToolSymbol(for: "edit"), "pencil")
        XCTAssertEqual(workingToolSymbol(for: "write"), "pencil")
        XCTAssertEqual(workingToolSymbol(for: "grep"), "text.magnifyingglass")
        XCTAssertEqual(workingToolSymbol(for: "WebFetch"), "safari", "matched case-insensitively")
        XCTAssertEqual(workingToolSymbol(for: "WebSearch"), "globe")
        XCTAssertEqual(workingToolSymbol(for: "session_spawn"), "paperplane.fill")
        XCTAssertEqual(workingToolSymbol(for: "task_update"), "checklist")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__browser__navigate"), "globe")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__computer__click"), "cursorarrow.rays")
        XCTAssertEqual(workingToolSymbol(for: "mcp__github__create_issue"), "shippingbox", "a connector")
        XCTAssertEqual(workingToolSymbol(for: "something_new"), "hammer.fill", "never a blank centre")
    }

    func testEverySymbolTheAnimationCanDrawExists() {
        let names = ["bash", "read", "edit", "glob", "WebFetch", "WebSearch", "computer", "lsp", "task_create",
                     "spawn_agent", "session_spawn", "Workflow", "ask_user", "Skill", "mcp__winter__office__x",
                     "mcp__winter__sessions__x", "mcp__winter__research__x", "mcp__winter__lsp__x",
                     "mcp__winter__other__x", "mcp__x__y", "unknown"]
        for symbol in names.map(workingToolSymbol(for:)) + WorkingAnimationModel.idleSymbols {
            XCTAssertNotNil(NSImage(systemSymbolName: symbol, accessibilityDescription: nil), symbol)
        }
    }

    func testTheRunningToolNameComesOffTheStatus() {
        XCTAssertEqual(workingToolName(.toolRunning(name: "bash")), "bash")
        XCTAssertNil(workingToolName(.thinking))
        XCTAssertNil(workingToolName(.idle))
    }
}
