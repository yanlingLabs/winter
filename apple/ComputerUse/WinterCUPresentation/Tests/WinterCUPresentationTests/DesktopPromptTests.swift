import XCTest
@testable import WinterCUPresentation

/// The desktop-switch prompt (user ruling 2026-10-10): its words (the app, its bundle id, the model's reason made
/// one safe line, the promise to bring the user back, the countdown), one answer per prompt — a click, or
/// `expired` when the countdown runs out — and a close (the card was answered elsewhere) that answers nothing.
@MainActor final class DesktopPromptTests: XCTestCase {
    final class FakeClock: CUClock { var now: TimeInterval = 1000 }

    final class FakeTicker: CUTicker {
        var isRunning = false
        var tick: (@MainActor () -> Void)?
        func start(interval: TimeInterval, _ tick: @escaping @MainActor () -> Void) { isRunning = true; self.tick = tick }
        func stop() { isRunning = false; tick = nil }
    }

    final class FakeSurface: DesktopPromptSurface {
        var onSwitch: (() -> Void)?
        var onRefuse: (() -> Void)?
        var shown: [(countdown: String, slot: Int)] = []
        var closed = 0
        func show(countdown: String, slot: Int) { shown.append((countdown, slot)) }
        func close() { closed += 1 }
    }

    final class FakeFactory: DesktopPromptSurfaceFactory {
        var made: [String: FakeSurface] = [:]
        var models: [String: CUDesktopPromptModel] = [:]
        func make(_ model: CUDesktopPromptModel) -> DesktopPromptSurface {
            let s = FakeSurface()
            made[model.promptId] = s
            models[model.promptId] = model
            return s
        }
    }

    private let clock = FakeClock()
    private let ticker = FakeTicker()
    private let factory = FakeFactory()
    /// The wall clock (epoch ms) the card's `expiresAt` is read against.
    private var wall: Double = 1_760_000_000_000
    private lazy var prompts = CUDesktopPromptController(surfaces: factory, clock: clock, ticker: ticker, wallMs: { [unowned self] in wall })

    private func request(_ id: String = "cu_1", reason: String = "to read the chart that only draws on screen",
                         timeoutMs: Int = 60_000) -> CUDesktopPromptRequest {
        CUDesktopPromptRequest(promptId: id, sessionId: "s", app: "Safari", bundleId: "com.apple.Safari", reason: reason,
                               timeoutMs: timeoutMs)
    }

    // MARK: the words

    func testTheWordsNameTheAppTheBundleIdTheReasonAndTheWayBack() {
        let m = CUDesktopPromptModel(request(), now: 0)
        XCTAssertEqual(m.title, "Switch to Safari's desktop?")
        XCTAssertEqual(m.appLine, "Safari (com.apple.Safari)")
        XCTAssertEqual(m.reason, "to read the chart that only draws on screen")
        XCTAssertEqual(m.backLine, "Winter will bring you back right after.")
        XCTAssertEqual(m.countdown(now: 0), "Switching in 60 s")
        XCTAssertEqual(m.countdown(now: 17.2), "Switching in 43 s", "rounded up: never shows 0 while time is left")
        XCTAssertEqual(m.countdown(now: 60), "Switching…")
    }

    func testTheReasonIsOneSafeLine() {
        let evil = "line one\nline two\u{202E}reversed\u{0007}\u{200F}  spaced\t\ttabs"
        XCTAssertEqual(CUDesktopPromptModel.sanitize(evil, max: 200), "line one line two reversed spaced tabs")
        let long = String(repeating: "a", count: 500)
        let cut = CUDesktopPromptModel.sanitize(long, max: 200)
        XCTAssertEqual(cut.count, 200)
        XCTAssertTrue(cut.hasSuffix("…"))
        XCTAssertEqual(CUDesktopPromptModel(request(reason: long), now: 0).reason.count, 200)
        XCTAssertEqual(CUDesktopPromptModel(request(reason: " \n "), now: 0).reason, "")
    }

    func testTheCountdownIsClamped() {
        XCTAssertEqual(CUDesktopPromptModel(request(timeoutMs: 0), now: 0).deadline, 1)
        XCTAssertEqual(CUDesktopPromptModel(request(timeoutMs: 10_000_000), now: 0).deadline, 600)
    }

    func testTheFirstAnswerWins() {
        var m = CUDesktopPromptModel(request(), now: 0)
        XCTAssertTrue(m.answer(.refuse))
        XCTAssertFalse(m.answer(.switchNow))
        XCTAssertFalse(m.tick(now: 1_000))
        XCTAssertEqual(m.answer, .refuse)
        var n = CUDesktopPromptModel(request(), now: 0)
        XCTAssertFalse(n.tick(now: 59.9))
        XCTAssertTrue(n.tick(now: 60))
        XCTAssertEqual(n.answer, .expired)
        XCTAssertFalse(n.answer(.switchNow), "too late")
    }

    // MARK: the controller

    func testAClickAnswersOnceAndClosesThePanel() {
        var answers: [CUDesktopPromptAnswer] = []
        XCTAssertTrue(prompts.show(request()) { answers.append($0) })
        let s = factory.made["cu_1"]!
        XCTAssertEqual(s.shown.last?.countdown, "Switching in 60 s")
        XCTAssertEqual(s.shown.last?.slot, 0)
        XCTAssertTrue(ticker.isRunning)
        s.onSwitch?()
        s.onSwitch?()
        s.onRefuse?()
        XCTAssertEqual(answers, [.switchNow])
        XCTAssertEqual(s.closed, 1)
        XCTAssertTrue(prompts.openPromptIds.isEmpty)
        XCTAssertFalse(ticker.isRunning, "nothing left to count down")
    }

    func testRefuse() {
        var answers: [CUDesktopPromptAnswer] = []
        prompts.show(request()) { answers.append($0) }
        factory.made["cu_1"]!.onRefuse?()
        XCTAssertEqual(answers, [.refuse])
    }

    func testTheCountdownRedrawsAndExpires() {
        var answers: [CUDesktopPromptAnswer] = []
        prompts.show(request(timeoutMs: 3_000)) { answers.append($0) }
        let s = factory.made["cu_1"]!
        clock.now += 1.1
        ticker.tick?()
        XCTAssertEqual(s.shown.last?.countdown, "Switching in 2 s")
        XCTAssertTrue(answers.isEmpty)
        clock.now += 2
        ticker.tick?()
        XCTAssertEqual(answers, [.expired])
        XCTAssertEqual(s.closed, 1)
        s.onSwitch?()
        XCTAssertEqual(answers, [.expired], "a click after it closed answers nothing")
    }

    func testAClosedPromptAnswersNothing() {
        var answers: [CUDesktopPromptAnswer] = []
        prompts.show(request()) { answers.append($0) }
        prompts.close(promptId: "cu_1")
        prompts.close(promptId: "cu_1")
        let s = factory.made["cu_1"]!
        XCTAssertEqual(s.closed, 1)
        s.onSwitch?()
        clock.now += 120
        ticker.tick?()
        XCTAssertTrue(answers.isEmpty)
        XCTAssertFalse(ticker.isRunning)
    }

    func testTwoPromptsStackAndEachAnswersItsOwn() {
        var answers: [String: CUDesktopPromptAnswer] = [:]
        prompts.show(request("a")) { answers["a"] = $0 }
        prompts.show(request("b")) { answers["b"] = $0 }
        XCTAssertFalse(prompts.show(request("b")) { _ in XCTFail("a second show of an open id is ignored") })
        XCTAssertEqual(prompts.openPromptIds, ["a", "b"])
        XCTAssertEqual(factory.made["b"]!.shown.last?.slot, 1)
        factory.made["a"]!.onRefuse?()
        XCTAssertEqual(answers, ["a": .refuse])
        XCTAssertEqual(factory.made["b"]!.shown.last?.slot, 0, "moved up into the free slot")
        factory.made["b"]!.onSwitch?()
        XCTAssertEqual(answers, ["a": .refuse, "b": .switchNow])
    }

    // MARK: the card's own deadline

    func testTheCountdownRunsToTheCardsExpiresAt() {
        var answers: [CUDesktopPromptAnswer] = []
        // The card was raised 18 s ago with a 60 s deadline: 42 s left, whatever `timeoutMs` says.
        let r = CUDesktopPromptRequest(promptId: "cu_1", sessionId: "s", app: "Safari", bundleId: "com.apple.Safari", reason: "x",
                                       timeoutMs: 60_000, expiresAt: Int(wall) + 42_000)
        prompts.show(r) { answers.append($0) }
        let s = factory.made["cu_1"]!
        XCTAssertEqual(s.shown.last?.countdown, "Switching in 42 s")
        clock.now += 41.5
        ticker.tick?()
        XCTAssertEqual(s.shown.last?.countdown, "Switching in 1 s")
        XCTAssertTrue(answers.isEmpty)
        clock.now += 0.5
        ticker.tick?()
        XCTAssertEqual(s.shown.last?.countdown, "Switching…", "at the deadline it says so")
        XCTAssertEqual(answers, [.expired])
        XCTAssertEqual(s.closed, 1)
    }

    func testAnExpiresAtAlreadyPastExpiresAtTheFirstTick() {
        var answers: [CUDesktopPromptAnswer] = []
        prompts.show(CUDesktopPromptRequest(promptId: "late", sessionId: "s", app: "A", bundleId: "b", reason: "", timeoutMs: 60_000,
                                            expiresAt: Int(wall) - 5_000)) { answers.append($0) }
        XCTAssertEqual(factory.made["late"]!.shown.last?.countdown, "Switching…")
        ticker.tick?()
        XCTAssertEqual(answers, [.expired])
    }
}

/// The island (user ruling 2026-10-14): its one line, the app's name and bundle id apart, the ring's share of time
/// left, and where it hangs — out of the camera housing, under the top edge without one, floating for a second prompt.
@MainActor final class DesktopIslandTests: XCTestCase {
    private func model(app: String = "Google Chrome", bundle: String = "com.google.Chrome",
                       timeoutMs: Int = 60_000) -> CUDesktopPromptModel {
        CUDesktopPromptModel(CUDesktopPromptRequest(promptId: "p", sessionId: "s", app: app, bundleId: bundle,
                                                    reason: "", timeoutMs: timeoutMs), now: 100)
    }

    func testTheIslandSaysOneShortLineAndNamesTheAppAndItsBundleIdApart() {
        let m = model()
        XCTAssertEqual(m.headline, "Winter needs your view for a sec on Google Chrome")
        XCTAssertEqual(m.appName, "Google Chrome")
        XCTAssertEqual(m.bundleId, "com.google.Chrome")
        XCTAssertEqual(model(app: "", bundle: "").appName, "the app")
        XCTAssertEqual(model(bundle: "com.evil\u{202E}emorhC").bundleId, "com.evil emorhC", "sanitized like the app line")
    }

    func testTheRingEmptiesWithTheCountdown() {
        let m = model(timeoutMs: 40_000)
        XCTAssertEqual(m.duration, 40)
        XCTAssertEqual(m.fractionLeft(now: 100), 1)
        XCTAssertEqual(m.fractionLeft(now: 110), 0.75, accuracy: 1e-9)
        XCTAssertEqual(m.fractionLeft(now: 140), 0)
        XCTAssertEqual(m.fractionLeft(now: 500), 0, "never below empty")
    }

    func testThePillRestsJustBelowTheHousingAndFitsItsLine() {
        let width = DesktopIslandGeometry.pillWidth(for: model().headline)
        XCTAssertTrue(DesktopIslandGeometry.widthRange.contains(width))
        XCTAssertGreaterThan(DesktopIslandGeometry.pillWidth(for: model(app: "Safari").headline + " and much more text"),
                             DesktopIslandGeometry.pillWidth(for: model(app: "Safari").headline))
        XCTAssertEqual(DesktopIslandGeometry.pillWidth(for: String(repeating: "W", count: 400)),
                       DesktopIslandGeometry.widthRange.upperBound, "a long name is capped; the line truncates")
        let g = DesktopIslandGeometry.make(housing: CGSize(width: 185, height: 32), menuBarHeight: 32, pillWidth: 340, slot: 0)
        XCTAssertTrue(g.sourceIsHousing)
        XCTAssertFalse(g.floating)
        XCTAssertEqual(g.source.size, CGSize(width: 185, height: 32))
        XCTAssertEqual(g.source.minY, 0)
        XCTAssertEqual(g.pill.minY, 42, "10 pt below the housing")
        XCTAssertEqual(g.pill.midX, g.source.midX, "centred under the housing")
        XCTAssertEqual(g.panelSize.height, g.pill.maxY + DesktopIslandGeometry.margin)
    }

    func testTheBirthIsADripThatSnapsThenSpreadsIntoThePillAndSettles() {
        let g = DesktopIslandGeometry.make(housing: CGSize(width: 185, height: 32), menuBarHeight: 32, pillWidth: 340, slot: 0)
        let fluid = DesktopIslandFluid(geometry: g)
        XCTAssertEqual(fluid.frame(at: 0).blobs.count, 1, "at first only the housing itself")
        let drip = fluid.frame(at: 0.25)
        XCTAssertGreaterThan(drip.blobs.filter { $0.kind == .ellipse }.count, 1, "a tail of drops hangs from the housing")
        XCTAssertGreaterThan(drip.blur, 5, "the drops melt into one surface")
        let free = fluid.frame(at: 0.5)
        XCTAssertEqual(free.blobs.count, 2, "the tail is gone: the housing and the free drop")
        XCTAssertLessThan(free.blur, 1, "too little melt left to join the drop and the housing again")
        let widest = stride(from: 0.45, through: 1.0, by: 0.01).map { fluid.frame(at: $0).pill.width }.max()!
        XCTAssertGreaterThan(widest, g.pill.width + 4, "it spreads past its rest and wobbles back, like a liquid")
        let rest = fluid.frame(at: DesktopIslandFluid.settle)
        XCTAssertEqual(rest.pill.width, g.pill.width, accuracy: 1)
        XCTAssertEqual(rest.pill.height, g.pill.height, accuracy: 1)
        XCTAssertEqual(rest.pill.midY, g.pill.midY, accuracy: 0.5)
        XCTAssertEqual(rest.crisp, 1)
        XCTAssertEqual(rest.content, 1)
        XCTAssertEqual(rest.blur, 0)
        XCTAssertEqual(fluid.frame(at: 0.3).content, 0, "no words while it is still a drip")
    }

    func testTheWayBackPlaysTheBirthBackwardsFaster() {
        let state = DesktopIslandState(secondsLeft: 60)
        let born = Date(timeIntervalSince1970: 1000)
        state.bornAt = born
        XCTAssertEqual(state.seconds(at: born.addingTimeInterval(0.5)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(state.seconds(at: born.addingTimeInterval(9)), DesktopIslandFluid.settle, "held at rest")
        state.returningAt = born.addingTimeInterval(9)
        XCTAssertEqual(state.seconds(at: born.addingTimeInterval(9.25)),
                       DesktopIslandFluid.settle - 0.25 * DesktopIslandFluid.returnSpeed, accuracy: 1e-9)
        XCTAssertEqual(state.seconds(at: born.addingTimeInterval(20)), 0, "back inside the housing")
    }

    func testWithoutAHousingItIsBornFromTheTopEdgeAndASecondPromptFloats() {
        let g = DesktopIslandGeometry.make(housing: nil, menuBarHeight: 24, pillWidth: 340, slot: 0)
        XCTAssertFalse(g.sourceIsHousing)
        XCTAssertEqual(g.source.height, 0)
        XCTAssertEqual(g.pill.minY, 34, "below the menu bar")
        XCTAssertEqual(DesktopIslandFluid(geometry: g).frame(at: DesktopIslandFluid.settle).blobs.count, 1,
                       "only the pill remains: the bead at the top edge was drawn back")
        let second = DesktopIslandGeometry.make(housing: nil, menuBarHeight: 24, pillWidth: 340, slot: 1)
        XCTAssertTrue(second.floating)
        let floating = DesktopIslandFluid(geometry: second).frame(at: DesktopIslandFluid.settle)
        XCTAssertEqual(floating.blobs.count, 1)
        XCTAssertEqual(floating.pill.width, second.pill.width, accuracy: 1)
        XCTAssertEqual(DesktopIslandGeometry.panelTop(slot: 1, housing: nil, menuBarHeight: 24),
                       24 + 10 + 44 + 10 - DesktopIslandGeometry.margin, "its pill sits 10 pt under the first one's")
    }
}
