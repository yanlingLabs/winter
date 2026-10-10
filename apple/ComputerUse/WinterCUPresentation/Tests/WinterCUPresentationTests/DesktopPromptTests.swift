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
