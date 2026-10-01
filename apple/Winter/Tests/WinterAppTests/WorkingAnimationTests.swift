import XCTest
import AppKit
@testable import Winter

/// The working animation's model: the particle ring's rotation, the icon cross-fade, the idle
/// symbol rotation, and the tool→symbol map.
final class WorkingAnimationTests: XCTestCase {
    private let period = WorkingAnimationModel.revolutionSeconds

    /// Advance in frame-sized steps — a single tick is clamped to `maxStep`.
    private func advance(_ model: inout WorkingAnimationModel, by seconds: Double, toolSymbol: String?) {
        var left = seconds
        while left > 1e-12 {
            let step = min(left, 1.0 / 60.0)
            model.tick(dt: step, toolSymbol: toolSymbol)
            left -= step
        }
    }

    func testTheRingTurnsAtItsRevolutionRate() {
        var model = WorkingAnimationModel()
        advance(&model, by: period / 4, toolSymbol: nil)
        XCTAssertEqual(model.angle, .pi / 2, accuracy: 1e-9)
        advance(&model, by: period / 4, toolSymbol: nil)
        XCTAssertEqual(model.angle, .pi, accuracy: 1e-9)
    }

    func testTheAngleWrapsAndNeverJumpsOnAStall() {
        var model = WorkingAnimationModel()
        for _ in 0..<200 { model.tick(dt: 1.0 / 60.0, toolSymbol: nil) }
        XCTAssertGreaterThanOrEqual(model.angle, 0)
        XCTAssertLessThan(model.angle, 2 * .pi)
        let before = model.angle
        model.tick(dt: 30, toolSymbol: nil) // the app was suspended
        let advanced = (model.angle - before + 2 * .pi).truncatingRemainder(dividingBy: 2 * .pi)
        XCTAssertEqual(advanced, WorkingAnimationModel.maxStep * 2 * .pi / period, accuracy: 1e-9,
                       "a long gap is clamped to one max step")
        var frozen = WorkingAnimationModel()
        frozen.tick(dt: -1, toolSymbol: nil)
        XCTAssertEqual(frozen.angle, 0, "a negative dt is no time at all")
    }

    func testEightParticlesHeadBrightestAndLargestTrailingDimmer() {
        let model = WorkingAnimationModel()
        let particles = model.particles(center: CGPoint(x: 10, y: 10), radius: 8, headDiameter: 4)
        XCTAssertEqual(particles.count, 8)
        for p in particles {
            XCTAssertEqual(hypot(p.position.x - 10, p.position.y - 10), 8, accuracy: 1e-9, "all on the ring")
        }
        for (a, b) in zip(particles, particles.dropFirst()) {
            XCTAssertGreaterThan(a.opacity, b.opacity)
            XCTAssertGreaterThan(a.diameter, b.diameter)
        }
        XCTAssertEqual(particles[0].opacity, 1, accuracy: 1e-9)
        XCTAssertEqual(particles[0].diameter, 4)
        XCTAssertEqual(particles[0].position.x, 18, accuracy: 1e-9, "head at angle 0")
    }

    func testTheParticlesRotateWithTheTicks() {
        var model = WorkingAnimationModel()
        let before = model.particles(center: .zero, radius: 10, headDiameter: 2)[0].position
        advance(&model, by: period / 4, toolSymbol: nil)
        let after = model.particles(center: .zero, radius: 10, headDiameter: 2)[0].position
        XCTAssertEqual(before.x, 10, accuracy: 1e-9)
        XCTAssertEqual(after.x, 0, accuracy: 1e-9)
        XCTAssertEqual(after.y, 10, accuracy: 1e-9)
    }

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
