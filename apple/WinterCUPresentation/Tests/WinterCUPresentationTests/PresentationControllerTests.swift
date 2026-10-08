import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The controller against recording fakes: what it creates, where it places it, what it hides, when the timer runs.
@MainActor final class PresentationControllerTests: XCTestCase {
    final class FakeWindows: CUWindowSource {
        var windows: [CGWindowID: WindowSnapshot] = [:]
        /// What lies above each window; nil = not fetched yet.
        var above: [CGWindowID: [StackWindow]] = [:]
        var aboveReads = 0
        func windowsAbove(_ windowID: CGWindowID) -> [StackWindow]? {
            aboveReads += 1
            return above[windowID]
        }
        var screenList = [ScreenInfo(frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
                                     visibleFrame: CGRect(x: 0, y: 25, width: 1512, height: 897))]
        func snapshot(of windowID: CGWindowID) -> WindowSnapshot? { windows[windowID] }
        func screens() -> [ScreenInfo] { screenList }
    }

    final class FakeMirror: MirrorSurface {
        let target: CUWindowRef
        var frames: [CGRect] = []
        var shown = false
        var shownHistory: [Bool] = []
        var fronts = 0
        var cursors: [CursorFrame] = []
        var cursorWindowSize: CGSize?
        var closed = false
        var lastAspect: CGFloat?
        weak var log: Log?

        init(target: CUWindowRef, log: Log) {
            self.target = target
            self.log = log
        }

        func place(frame: CGRect, contentSize: CGSize, windowAspect: CGFloat?, stackIndex: Int) {
            frames.append(frame)
            lastAspect = windowAspect
        }
        func setShown(_ shown: Bool) {
            self.shown = shown
            shownHistory.append(shown)
        }
        func bringToFront() {
            fronts += 1
            log?.fronts.append(target.windowID)
        }
        func apply(cursor frame: CursorFrame, style: CursorStyle, windowSize: CGSize) {
            cursors.append(frame)
            cursorWindowSize = windowSize
        }
        func close() { closed = true }
    }

    final class FakeOverlay: CursorOverlaySurface {
        var placed: [CGRect] = []
        var reorders = 0
        var shown = false
        var frames: [CursorFrame] = []
        var lastStyle: CursorStyle?
        var occluded: [Bool] = []
        var closed = false

        func place(windowFrame: CGRect, aboveWindow windowID: CGWindowID, reorder: Bool) {
            placed.append(windowFrame)
            if reorder { reorders += 1 }
        }
        func setShown(_ shown: Bool) { self.shown = shown }
        func setOccluded(_ occluded: Bool) { self.occluded.append(occluded) }
        func apply(cursor frame: CursorFrame, style: CursorStyle) {
            frames.append(frame)
            lastStyle = style
        }
        func close() { closed = true }
    }

    final class Log { var fronts: [CGWindowID] = [] }

    final class FakeSurfaces: CUSurfaceFactory {
        let log = Log()
        var mirrors: [CGWindowID: [FakeMirror]] = [:]
        var overlays: [CGWindowID: [FakeOverlay]] = [:]

        func makeMirror(target: CUWindowRef) -> MirrorSurface {
            let m = FakeMirror(target: target, log: log)
            mirrors[target.windowID, default: []].append(m)
            return m
        }
        func makeOverlay(target: CUWindowRef) -> CursorOverlaySurface {
            let o = FakeOverlay()
            overlays[target.windowID, default: []].append(o)
            return o
        }
        func mirror(_ id: CGWindowID) -> FakeMirror? { mirrors[id]?.last }
        func overlay(_ id: CGWindowID) -> FakeOverlay? { overlays[id]?.last }
    }

    final class FakeClock: CUClock { var now: TimeInterval = 1000 }

    final class FakeDriver: CUFrameDriver {
        var tick: (@MainActor () -> Void)?
        var need: CursorAnimationNeed = .none
        var isRunning: Bool { tick != nil }
        func start(_ need: CursorAnimationNeed, _ tick: @escaping @MainActor () -> Void) {
            self.need = need
            self.tick = tick
        }
        func stop() {
            tick = nil
            need = .none
        }
        func fire() { tick?() }
    }

    final class FakeAccessibility: CUAccessibilitySource {
        var reduceMotion = false
        var increaseContrast = false
    }

    final class FakeTicker: CUTicker {
        var tick: (@MainActor () -> Void)?
        var isRunning: Bool { tick != nil }
        var starts = 0
        func start(interval: TimeInterval, _ tick: @escaping @MainActor () -> Void) {
            starts += 1
            self.tick = tick
        }
        func stop() { tick = nil }
        func fire() { tick?() }
    }

    var windows: FakeWindows!
    var surfaces: FakeSurfaces!
    var clock: FakeClock!
    var ticker: FakeTicker!
    var driver: FakeDriver!
    var accessibility: FakeAccessibility!
    var controller: PresentationController!

    override func setUp() async throws {
        await MainActor.run {
            windows = FakeWindows()
            surfaces = FakeSurfaces()
            clock = FakeClock()
            ticker = FakeTicker()
            driver = FakeDriver()
            accessibility = FakeAccessibility()
            controller = PresentationController(windows: windows, surfaces: surfaces, clock: clock, ticker: ticker,
                                                frames: driver, accessibility: accessibility, ownPID: 4242)
        }
    }

    func ref(_ id: CGWindowID) -> CUWindowRef { CUWindowRef(pid: 500, windowID: id, appName: "App\(id)") }

    func addWindow(_ id: CGWindowID, _ frame: CGRect, onScreen: Bool = true) {
        windows.windows[id] = WindowSnapshot(frame: frame, isOnScreen: onScreen)
    }

    // MARK: - Mirrors

    func testShowMirrorAppearsOverTheTrafficLightsAndStartsTracking() {
        addWindow(1, CGRect(x: 200, y: 150, width: 1440, height: 900))
        controller.showMirror(sessionId: "s", target: ref(1))
        let m = try! XCTUnwrap(surfaces.mirror(1))
        XCTAssertTrue(m.shown)
        XCTAssertEqual(m.frames.last, CGRect(x: 204, y: 154, width: 366, height: 251))
        XCTAssertEqual(m.lastAspect, 1.6)
        XCTAssertTrue(ticker.isRunning)
    }

    func testTheMirrorFollowsItsWindowAndDocksWhenTheWindowIsMinimized() {
        addWindow(1, CGRect(x: 200, y: 150, width: 1440, height: 900))
        controller.showMirror(sessionId: "s", target: ref(1))
        addWindow(1, CGRect(x: 40, y: 300, width: 1440, height: 900))
        ticker.fire()
        let m = try! XCTUnwrap(surfaces.mirror(1))
        XCTAssertEqual(m.frames.last?.origin, CGPoint(x: 44, y: 304))

        // Minimized (not on screen): dock in the corner nearest the last frame. Its centre (620, 750) is bottom-left.
        addWindow(1, CGRect(x: -100, y: 300, width: 1440, height: 900), onScreen: false)
        ticker.fire()
        XCTAssertEqual(m.frames.last?.origin, CGPoint(x: 10, y: 25 + 897 - 10 - 251))
        XCTAssertTrue(m.shown, "a docked mirror stays up")
    }

    func testAtMostTwoMirrorsAndTheNewestEndsOnTop() {
        for id: CGWindowID in 1...3 { addWindow(id, CGRect(x: 100 * CGFloat(id), y: 100, width: 800, height: 500)) }
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.showMirror(sessionId: "s", target: ref(2))
        XCTAssertEqual(surfaces.log.fronts.last, 2)
        controller.showMirror(sessionId: "s", target: ref(3))
        XCTAssertEqual(surfaces.mirror(1)?.shown, false, "the oldest fades out")
        XCTAssertEqual(surfaces.mirror(2)?.shown, true)
        XCTAssertEqual(surfaces.mirror(3)?.shown, true)
        XCTAssertEqual(surfaces.log.fronts.suffix(2), [2, 3], "ordered oldest first so the newest is on top")
        XCTAssertEqual(controller.debugShownMirrors.map(\.target.windowID), [3, 2])
        XCTAssertEqual(surfaces.mirror(1)?.closed, false, "still wanted: hidden, not closed")
    }

    func testTurnEndFadesAndTheNextActionBringsItBack() {
        addWindow(1, CGRect(x: 200, y: 150, width: 800, height: 500))
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.turnEnded(sessionId: "s")
        let m = try! XCTUnwrap(surfaces.mirror(1))
        XCTAssertFalse(m.shown)
        XCTAssertFalse(m.closed)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 600, y: 400), kind: .press)
        XCTAssertTrue(m.shown)
        XCTAssertEqual(surfaces.mirrors[1]?.count, 1, "the same surface comes back")
    }

    func testIdleFadeThirtySecondsAfterTheLastAction() {
        addWindow(1, CGRect(x: 200, y: 150, width: 800, height: 500))
        controller.showMirror(sessionId: "s", target: ref(1))
        clock.now += 20
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 300), kind: .move)
        clock.now += 29
        ticker.fire()
        XCTAssertEqual(surfaces.mirror(1)?.shown, true)
        XCTAssertEqual(surfaces.overlay(1)?.shown, true, "the cursor rests, breathing, until the 30 s are up")
        clock.now += 1
        ticker.fire()
        XCTAssertEqual(surfaces.mirror(1)?.shown, false)
        XCTAssertEqual(surfaces.overlay(1)?.shown, true, "the cursor's own fade is still playing")
        clock.now += 0.5
        driver.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, false)
        XCTAssertFalse(ticker.isRunning, "nothing left to watch")
        XCTAssertFalse(driver.isRunning)
    }

    func testHideMirrorClosesIt() {
        addWindow(1, CGRect(x: 200, y: 150, width: 800, height: 500))
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.hideMirror(sessionId: "s", target: ref(1))
        XCTAssertEqual(surfaces.mirror(1)?.closed, true)
        XCTAssertFalse(ticker.isRunning)
    }

    func testMirrorsDisabledHidesMirrorsButKeepsTheCursorOverlay() {
        addWindow(1, CGRect(x: 200, y: 150, width: 800, height: 500))
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.mirrorsEnabled = false
        XCTAssertEqual(surfaces.mirror(1)?.shown, false)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 250), kind: .press)
        XCTAssertEqual(surfaces.mirror(1)?.shown, false)
        XCTAssertEqual(surfaces.mirror(1)?.cursors.count, 0)
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertTrue(o.shown)
        XCTAssertEqual(o.frames.last?.tip, CGPoint(x: 100, y: 100), "window-local point")
        controller.mirrorsEnabled = true
        XCTAssertEqual(surfaces.mirror(1)?.shown, true)
    }

    func testWithMirrorsDisabledTheTickerRunsOnlyWhileACursorNeedsIt() {
        addWindow(1, CGRect(x: 200, y: 150, width: 800, height: 500))
        controller.showMirror(sessionId: "s", target: ref(1))
        XCTAssertTrue(ticker.isRunning)
        controller.mirrorsEnabled = false
        XCTAssertFalse(ticker.isRunning, "stops at once, not 30 s later")
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 250), kind: .press)
        XCTAssertTrue(ticker.isRunning, "the overlay cursor still follows its window")
        clock.now += 30
        ticker.fire()
        clock.now += 0.5
        driver.fire()
        XCTAssertFalse(ticker.isRunning)
        // Back on after the mirror's 30 s idle: it stays faded until the next action.
        clock.now += 30
        controller.mirrorsEnabled = true
        XCTAssertEqual(surfaces.mirror(1)?.shown, false)
        XCTAssertFalse(ticker.isRunning)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 250), kind: .move)
        XCTAssertEqual(surfaces.mirror(1)?.shown, true)
    }

    // MARK: - Cursor

    func testCursorDrawsInTheOverlayAndTheMirror() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200),
                          kind: .drag(to: CGPoint(x: 500, y: 400)))
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertTrue(o.shown)
        XCTAssertEqual(o.placed.last, CGRect(x: 100, y: 100, width: 800, height: 400))
        XCTAssertEqual(o.frames.last?.tip, CGPoint(x: 200, y: 100), "screen points become window-local")
        XCTAssertEqual(o.frames.last?.path?.to, CGPoint(x: 400, y: 300), "and so does the drag's end")
        let m = try! XCTUnwrap(surfaces.mirror(1))
        XCTAssertEqual(m.cursors.last, o.frames.last, "one cursor, drawn in both places")
        XCTAssertEqual(m.cursorWindowSize, CGSize(width: 800, height: 400))
        XCTAssertEqual(driver.need, .full)
    }

    func testTargetFramesAreMappedIntoTheWindow() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200),
                          kind: .target(frame: CGRect(x: 260, y: 180, width: 80, height: 40)))
        clock.now += 0.3
        driver.fire()
        XCTAssertEqual(surfaces.overlay(1)?.frames.last?.reticle?.rect, CGRect(x: 160, y: 80, width: 80, height: 40))
    }

    func testNoOverlayWhileTheWindowIsNotVisibleButTheMirrorStillShowsTheCursor() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400), onScreen: false)
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 500, y: 300), kind: .press)
        XCTAssertNil(surfaces.overlay(1))
        XCTAssertEqual(surfaces.mirror(1)?.cursors.last?.tip, CGPoint(x: 400, y: 200))

        // The window comes back on screen: the overlay appears at the next tick.
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        ticker.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, true)
        // And goes when the window leaves again.
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400), onScreen: false)
        ticker.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, false)
    }

    func testTheOverlayFollowsTheWindowAndFadesAfterThirtyIdleSeconds() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .move)
        XCTAssertNil(surfaces.mirror(1), "a cursor never opens a mirror by itself")
        addWindow(1, CGRect(x: 160, y: 120, width: 800, height: 400))
        clock.now += 1
        ticker.fire()
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertEqual(o.placed.last, CGRect(x: 160, y: 120, width: 800, height: 400))
        clock.now += 29
        ticker.fire()
        XCTAssertTrue(o.shown, "fading, not gone")
        clock.now += 0.2
        driver.fire()
        let fading = try! XCTUnwrap(o.frames.last)
        XCTAssertLessThan(fading.opacity, 1)
        XCTAssertGreaterThan(fading.opacity, 0)
        clock.now += 0.3
        driver.fire()
        XCTAssertFalse(o.shown)
        XCTAssertTrue(o.closed, "a cursor-only target is dropped once its cursor is gone")
        XCTAssertFalse(ticker.isRunning)
        XCTAssertFalse(driver.isRunning)
    }

    func testTurnEndFadesTheCursorGracefully() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .press)
        controller.turnEnded(sessionId: "s")
        XCTAssertEqual(surfaces.overlay(1)?.shown, true, "the fade plays after the press it follows")
        clock.now += 0.7
        driver.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, false)
    }

    func testReduceMotionAndIncreaseContrastReachTheCursor() {
        accessibility.reduceMotion = true
        accessibility.increaseContrast = true
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 150, y: 150), kind: .move)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 700, y: 400), kind: .move)
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertEqual(o.frames.last?.tip, CGPoint(x: 600, y: 300), "no travel: it is already there")
        XCTAssertEqual(o.lastStyle?.increaseContrast, true)
        clock.now += 1
        driver.fire()
        XCTAssertFalse(driver.isRunning, "a still cursor under Reduce Motion needs no frames (no breathing)")
    }

    func testTheDriverSlowsToBreathingAtRest() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 150, y: 150), kind: .move)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 700, y: 400), kind: .press)
        XCTAssertEqual(driver.need, .full)
        clock.now += 2
        driver.fire()
        XCTAssertEqual(driver.need, .low)
        XCTAssertTrue(driver.isRunning)
    }

    func testTheCursorFadesWhileAnotherWindowCoversItsPoint() {
        let target = CGRect(x: 100, y: 100, width: 800, height: 400)
        addWindow(1, target)
        let cover = StackWindow(id: 9, pid: 600, layer: 0, bounds: CGRect(x: 250, y: 150, width: 200, height: 150))
        windows.above[1] = [cover]
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .press)
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertEqual(o.occluded.last, true, "the point (300, 200) is under another app's window")
        // The other window moves away: the next look shows the cursor again.
        windows.above[1] = []
        clock.now += 0.15
        ticker.fire()
        XCTAssertEqual(o.occluded.last, false)
        // Looks are throttled between actions…
        let reads = windows.aboveReads
        clock.now += 0.02
        ticker.fire()
        XCTAssertEqual(windows.aboveReads, reads)
        // …but every action looks at once (at the cache).
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 700, y: 300), kind: .move)
        XCTAssertEqual(windows.aboveReads, reads + 1)
    }

    func testForegroundTakesOverTheLook() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .move)
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .foreground(true))
        clock.now += 0.3
        driver.fire()
        let f = try! XCTUnwrap(surfaces.overlay(1)?.frames.last)
        XCTAssertEqual(f.bodyOpacity, 0, "the real pointer is there: no second arrow")
        XCTAssertNotNil(f.foreground)
        XCTAssertEqual(f.caption?.text, "Using your mouse")
    }

    func testOverlayIsReorderedAboveItsWindowAtMostTwiceASecond() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .move)
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertEqual(o.reorders, 1)
        for _ in 0..<5 {
            clock.now += 0.05
            ticker.fire()
        }
        XCTAssertEqual(o.reorders, 1)
        clock.now += 0.3
        ticker.fire()
        XCTAssertEqual(o.reorders, 2)
    }

    // MARK: - Sessions

    func testSessionEndClosesEverythingOfThatSessionOnly() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        addWindow(2, CGRect(x: 300, y: 300, width: 800, height: 400))
        controller.showMirror(sessionId: "a", target: ref(1))
        controller.cursor(sessionId: "a", target: ref(1), point: CGPoint(x: 200, y: 200), kind: .press)
        controller.showMirror(sessionId: "b", target: ref(2))
        controller.sessionEnded(sessionId: "a")
        XCTAssertEqual(surfaces.mirror(1)?.closed, true)
        XCTAssertEqual(surfaces.overlay(1)?.closed, true)
        XCTAssertEqual(surfaces.mirror(2)?.closed, false)
        XCTAssertEqual(surfaces.mirror(2)?.shown, true)
        controller.sessionEnded(sessionId: "b")
        XCTAssertFalse(ticker.isRunning)
    }

    func testFactoryMakesBothHalvesWithoutDrawingOrInstalling() {
        // Construction alone creates no panel and no tap (they are lazy); nothing is shown or armed here.
        let (presentation, tap) = WinterCUPresentationFactory.make()
        XCTAssertTrue(presentation.mirrorsEnabled)
        XCTAssertNil(tap.onEscape)
    }
}
