import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The controller against recording fakes: what it creates, where it places it, what it hides, when the timer runs.
@MainActor final class PresentationControllerTests: XCTestCase {
    final class FakeWindows: CUWindowSource {
        var windows: [CGWindowID: WindowSnapshot] = [:]
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
        var cursors: [(CGPoint, CUCursorKind, CGPoint?)] = []
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
        func showCursor(atFraction fraction: CGPoint, kind: CUCursorKind, dragToFraction: CGPoint?) {
            cursors.append((fraction, kind, dragToFraction))
        }
        func close() { closed = true }
    }

    final class FakeOverlay: CursorOverlaySurface {
        var placed: [CGRect] = []
        var reorders = 0
        var shown = false
        var moves: [(CGPoint, CUCursorKind, CGPoint?)] = []
        var closed = false

        func place(windowFrame: CGRect, aboveWindow windowID: CGWindowID, reorder: Bool) {
            placed.append(windowFrame)
            if reorder { reorders += 1 }
        }
        func setShown(_ shown: Bool) { self.shown = shown }
        func moveCursor(to point: CGPoint, kind: CUCursorKind, dragTo: CGPoint?) { moves.append((point, kind, dragTo)) }
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
    var controller: PresentationController!

    override func setUp() async throws {
        await MainActor.run {
            windows = FakeWindows()
            surfaces = FakeSurfaces()
            clock = FakeClock()
            ticker = FakeTicker()
            controller = PresentationController(windows: windows, surfaces: surfaces, clock: clock, ticker: ticker)
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
        clock.now += 1
        ticker.fire()
        XCTAssertEqual(surfaces.mirror(1)?.shown, false)
        XCTAssertFalse(ticker.isRunning, "nothing left to watch")
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
        XCTAssertEqual(o.moves.last?.0, CGPoint(x: 100, y: 100), "window-local point")
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
        clock.now += 4
        ticker.fire()
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
        XCTAssertEqual(o.moves.last?.0, CGPoint(x: 200, y: 100))
        XCTAssertEqual(o.moves.last?.2, CGPoint(x: 400, y: 300))
        let m = try! XCTUnwrap(surfaces.mirror(1))
        XCTAssertEqual(m.cursors.last?.0, CGPoint(x: 0.25, y: 0.25))
        XCTAssertEqual(m.cursors.last?.1, .drag(to: CGPoint(x: 500, y: 400)))
        XCTAssertEqual(m.cursors.last?.2, CGPoint(x: 0.5, y: 0.75))
    }

    func testNoOverlayWhileTheWindowIsNotVisibleButTheMirrorStillShowsTheCursor() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400), onScreen: false)
        controller.showMirror(sessionId: "s", target: ref(1))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 500, y: 300), kind: .press)
        XCTAssertNil(surfaces.overlay(1))
        XCTAssertEqual(surfaces.mirror(1)?.cursors.last?.0, CGPoint(x: 0.5, y: 0.5))

        // The window comes back on screen: the overlay appears at the next tick.
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        ticker.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, true)
        // And goes when the window leaves again.
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400), onScreen: false)
        ticker.fire()
        XCTAssertEqual(surfaces.overlay(1)?.shown, false)
    }

    func testTheOverlayFollowsTheWindowAndHidesAfterFourIdleSeconds() {
        addWindow(1, CGRect(x: 100, y: 100, width: 800, height: 400))
        controller.cursor(sessionId: "s", target: ref(1), point: CGPoint(x: 300, y: 200), kind: .move)
        XCTAssertNil(surfaces.mirror(1), "a cursor never opens a mirror by itself")
        addWindow(1, CGRect(x: 160, y: 120, width: 800, height: 400))
        clock.now += 1
        ticker.fire()
        let o = try! XCTUnwrap(surfaces.overlay(1))
        XCTAssertEqual(o.placed.last, CGRect(x: 160, y: 120, width: 800, height: 400))
        clock.now += 3
        ticker.fire()
        XCTAssertFalse(o.shown)
        XCTAssertTrue(o.closed, "a cursor-only target is dropped once its cursor hides")
        XCTAssertFalse(ticker.isRunning)
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
