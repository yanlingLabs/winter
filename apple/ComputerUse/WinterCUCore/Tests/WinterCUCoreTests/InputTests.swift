import AppKit
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The input ladder's decisions, the SkyLight resolution and its public fallback, and the event sequences —
/// all with recording posters, so nothing is ever posted.
final class InputTests: XCTestCase {
    // MARK: ladder

    private func ctx(bundle: String? = "com.apple.TextEdit", chromium: Bool = false, privatePath: Bool = true,
                     sky: Bool = true, fg: Bool = false, atPoint: Bool = false) -> CUInputLadder.Context {
        CUInputLadder.Context(appName: "App", bundleId: bundle, isChromium: chromium, privatePath: privatePath,
                              skyLightAvailable: sky, allowForeground: fg, pointerAtPoint: atPoint)
    }

    func testNativeAppsUsePublicPidEvents() throws {
        XCTAssertEqual(try CUInputLadder.decideEvents(ctx()).rung, .processEvents)
        XCTAssertNil(try CUInputLadder.decideEvents(ctx()).detail)
    }

    func testChromiumUsesSkyLightWhenAllowedAndResolved() throws {
        XCTAssertEqual(try CUInputLadder.decideEvents(ctx(chromium: true)).rung, .privatePath)
        let off = try CUInputLadder.decideEvents(ctx(chromium: true, privatePath: false))
        XCTAssertEqual(off.rung, .processEvents)
        XCTAssertTrue(off.detail?.contains("off in Settings") == true, "the fallback says so")
        let missing = try CUInputLadder.decideEvents(ctx(chromium: true, sky: false))
        XCTAssertEqual(missing.rung, .processEvents)
        XCTAssertTrue(missing.detail?.contains("unavailable") == true)
    }

    func testForegroundOnlyAppsNeedConsent() throws {
        XCTAssertThrowsError(try CUInputLadder.decideEvents(ctx(bundle: "org.blenderfoundation.blender", atPoint: true))) {
            XCTAssertEqual(($0 as? CUError)?.code, "needs_foreground")
        }
        XCTAssertEqual(try CUInputLadder.decideEvents(ctx(bundle: "org.blenderfoundation.blender", fg: true, atPoint: true)).rung,
                       .foreground)
        // A ref (an element) in the same app never needs the foreground.
        XCTAssertEqual(try CUInputLadder.decideEvents(ctx(bundle: "org.blenderfoundation.blender", atPoint: false)).rung,
                       .processEvents)
    }

    func testRoutes() {
        XCTAssertEqual(CUInputLadder.route(for: .processEvents), .publicPid)
        XCTAssertEqual(CUInputLadder.route(for: .privatePath), .skyLight)
        XCTAssertEqual(CUInputLadder.route(for: .foreground), .hid)
    }

    func testChromiumClassification() {
        XCTAssertTrue(CUChromium.isChromiumFamily(bundleId: "com.google.Chrome", frameworkNames: []))
        XCTAssertTrue(CUChromium.isChromiumFamily(bundleId: "com.tinyspeck.slackmacgap", frameworkNames: ["Electron Framework.framework"]))
        XCTAssertFalse(CUChromium.isChromiumFamily(bundleId: "com.apple.Notes", frameworkNames: ["Sparkle.framework"]))
    }

    // MARK: SkyLight

    func testSkyLightResolvesThroughDlsym() {
        // Resolution only (dlopen + dlsym); nothing is posted.
        let s = CUSkyLight.system
        if !s.isAvailable { print("note: SLEventPostToPid did not resolve on this macOS; rung 3 falls back to rung 2") }
        let looked = NSMutableArray()
        let fake = CUSkyLight.resolve { looked.add($0); return nil }
        XCTAssertFalse(fake.isAvailable)
        XCTAssertFalse(fake.canFocusWithoutRaise)
        XCTAssertTrue(looked.contains("SLEventPostToPid"))
        XCTAssertTrue(looked.contains("SLPSPostEventRecordTo"))
    }

    func testMissingSkyLightFallsBackToThePublicRoute() throws {
        let published = Recorder()
        let poster = CULiveEventPoster(skyLight: .none, postToPid: { e, pid in published.add(e, pid) }, postHID: { _ in
            XCTFail("never the HID stream")
        })
        let e = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true))
        XCTAssertEqual(poster.post(e, pid: 42, route: .skyLight, authenticate: true), .publicPid)
        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(published.pids, [42])
        XCTAssertEqual(poster.post(e, pid: 7, route: .publicPid, authenticate: false), .publicPid)
        XCTAssertEqual(published.pids, [42, 7])
    }

    func testFocusRecordLayout() {
        let r = CUSkyLight.focusRecord(windowID: 0x1122_3344, focus: true)
        XCTAssertEqual(r.count, 0xF8)
        XCTAssertEqual(r[0x04], 0xF8)
        XCTAssertEqual(r[0x08], 0x0D)
        XCTAssertEqual(Array(r[0x3C...0x3F]), [0x44, 0x33, 0x22, 0x11], "window id little-endian")
        XCTAssertEqual(r[0x8A], 0x01)
        XCTAssertEqual(CUSkyLight.focusRecord(windowID: 1, focus: false)[0x8A], 0x02)
    }

    // MARK: event sequences

    final class Recorder: CUEventPoster, @unchecked Sendable {
        struct Entry { var type: CGEventType; var location: CGPoint; var clickState: Int64; var pid: pid_t; var route: CURoute
            var targetPid: Int64; var window: Int64; var unicode: String }
        private let lock = NSLock()
        private(set) var entries: [Entry] = []
        var degradeSkyLight = false
        var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }
        var pids: [pid_t] { lock.lock(); defer { lock.unlock() }; return entries.map(\.pid) }

        func add(_ e: CGEvent, _ pid: pid_t, route: CURoute = .publicPid) {
            var length = 0
            var chars = [UniChar](repeating: 0, count: 8)
            e.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &chars)
            let entry = Entry(type: e.type, location: e.location,
                              clickState: e.getIntegerValueField(.mouseEventClickState), pid: pid, route: route,
                              targetPid: e.getIntegerValueField(.eventTargetUnixProcessID),
                              window: e.getIntegerValueField(.mouseEventWindowUnderMousePointer),
                              unicode: String(utf16CodeUnits: chars, count: length))
            lock.lock(); entries.append(entry); lock.unlock()
        }

        func post(_ event: CGEvent, pid: pid_t, route: CURoute, authenticate: Bool) -> CURoute {
            let used: CURoute = route == .skyLight && degradeSkyLight ? .publicPid : route
            add(event, pid, route: used)
            return used
        }
    }

    private func synth(_ r: Recorder) -> CUEventSynth {
        var s = CUEventSynth(poster: r, skyLight: .none)
        s.sleep = { _ in }
        return s
    }

    func testPublicClickIsDownUpPairsWithClickStates() throws {
        let r = Recorder()
        let used = try synth(r).click(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 100, y: 200), button: .left, count: 2, flags: [],
                                  route: .publicPid)
        XCTAssertEqual(used, .publicPid)
        XCTAssertEqual(r.entries.map(\.type), [.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        XCTAssertEqual(r.entries.map(\.clickState), [1, 1, 2, 2])
        XCTAssertTrue(r.entries.allSatisfy { $0.location == CGPoint(x: 100, y: 200) && $0.targetPid == 9 && $0.window == 77 })
    }

    func testSkyLightClickPrimesChromium() throws {
        let r = Recorder()
        let used = try synth(r).click(pid: 9, windowFor: { _ in 77 }, at: CGPoint(x: 100, y: 200), button: .left, count: 1, flags: [],
                                  route: .skyLight)
        XCTAssertEqual(used, .skyLight)
        XCTAssertEqual(r.entries.map(\.type), [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        XCTAssertEqual(r.entries[1].location, CGPoint(x: -1, y: -1), "the primer click is off screen")
        XCTAssertEqual(r.entries[3].location, CGPoint(x: 100, y: 200))
    }

    func testSkyLightDegradesWithoutThePrimer() throws {
        let r = Recorder()
        r.degradeSkyLight = true
        let used = try synth(r).click(pid: 9, windowFor: { _ in 77 }, at: .zero, button: .left, count: 1, flags: [], route: .skyLight)
        XCTAssertEqual(used, .publicPid)
        XCTAssertFalse(r.entries.contains { $0.location == CGPoint(x: -1, y: -1) }, "no primer on the public route")
    }

    func testRightAndMiddleButtons() throws {
        let r = Recorder()
        try synth(r).click(pid: 1, windowFor: { _ in 0 }, at: .zero, button: .right, count: 1, flags: [.maskCommand], route: .publicPid)
        try synth(r).click(pid: 1, windowFor: { _ in 0 }, at: .zero, button: .middle, count: 1, flags: [], route: .publicPid)
        XCTAssertEqual(r.entries.map(\.type), [.rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp])
    }

    func testDragAndScrollSequences() throws {
        let r = Recorder()
        try synth(r).drag(pid: 1, windowFor: { _ in 3 }, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 100, y: 0), route: .publicPid, steps: 4)
        XCTAssertEqual(r.entries.first?.type, .mouseMoved)
        XCTAssertEqual(r.entries[1].type, .leftMouseDown)
        XCTAssertEqual(r.entries.filter { $0.type == .leftMouseDragged }.map(\.location.x), [25, 50, 75, 100])
        XCTAssertEqual(r.entries.last?.type, .leftMouseUp)
        let s = Recorder()
        try synth(s).scroll(pid: 1, windowFor: { _ in 3 }, at: CGPoint(x: 5, y: 5), deltaX: 0, deltaY: -600, route: .publicPid)
        XCTAssertEqual(s.entries.count, 5, "600 px in wheel-sized chunks")
        XCTAssertTrue(s.entries.allSatisfy { $0.type == .scrollWheel && $0.location == CGPoint(x: 5, y: 5) })
    }

    func testTypingSendsUnicodeAndChecksBetweenKeys() throws {
        let r = Recorder()
        var checks = 0
        try synth(r).type(pid: 4, text: "hé\n", route: .publicPid) { checks += 1 }
        XCTAssertEqual(checks, 3)
        let downs = r.entries.filter { $0.type == .keyDown }
        XCTAssertEqual(downs.prefix(2).map(\.unicode), ["h", "é"])
        XCTAssertEqual(downs.count, 3, "the newline is a Return key press")
        // A failing check stops typing at once.
        let r2 = Recorder()
        var n = 0
        XCTAssertThrowsError(try synth(r2).type(pid: 4, text: "abcdef", route: .publicPid) {
            n += 1
            if n == 3 { throw CUError.cancelled }
        })
        XCTAssertEqual(r2.entries.filter { $0.type == .keyDown }.count, 2)
    }

    func testKeyCarriesFlags() {
        let r = Recorder()
        synth(r).key(pid: 2, code: 1, flags: [.maskCommand], route: .publicPid)
        XCTAssertEqual(r.entries.map(\.type), [.keyDown, .keyUp])
        XCTAssertEqual(r.entries.first?.targetPid, 2)
    }
}
