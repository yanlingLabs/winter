import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Windows the window server has but AX does not list — on another Space or in full screen — and apps with
/// no window at all: the resolver's order (remote token in place, SkyLight move, a new window, then
/// `window_elsewhere` / `no_window`), the bound window's element fallback, and pointer input that needs the
/// window on this desktop. Everything runs against fakes; nothing touches the real window server.
final class OffSpaceWindowTests: XCTestCase {
    let pid: pid_t = 4343
    let offWindow = fakeElement(60_001)
    let freshWindow = fakeElement(60_002)
    let button = fakeElement(60_003)
    let plain = fakeElement(60_004)
    let appEl = fakeElement(60_099)

    // MARK: the resolver (pure)

    private func serverWindow(_ id: UInt32, title: String = "", onScreen: Bool = false, layer: Int = 0) -> CUWindowServerWindow {
        CUWindowServerWindow(id: id, pid: pid, ownerName: "Safari", title: title,
                             frame: CGRect(x: 0, y: 0, width: 1440, height: 900), layer: layer, onScreen: onScreen, alpha: 1)
    }

    private func axWindow(_ e: AXUIElement, _ id: UInt32, title: String = "") -> CUAXWindow {
        CUAXWindow(element: e, id: id, title: title, frame: CGRect(x: 0, y: 0, width: 800, height: 600), focused: false, main: false)
    }

    /// Effects whose outcomes the test sets, recording what was tried.
    final class World {
        var remote: [UInt32: AXUIElement] = [:]
        var moveWorks = false
        var listed: [CUAXWindow] = []
        var server: [CUWindowServerWindow] = []
        var onMove: ((UInt32) -> Void)?
        private(set) var tried: [String] = []

        func effects() -> CUWindowResolver.Effects {
            CUWindowResolver.Effects(
                remote: { [self] ids in
                    tried.append("remote:" + ids.map(String.init).joined(separator: ","))
                    return remote.filter { ids.contains($0.key) }
                },
                describe: { element, s in
                    CUAXWindow(element: element, id: s.id, title: s.title, frame: s.frame, focused: false, main: false)
                },
                moveToActiveSpace: { [self] id in
                    tried.append("move:\(id)")
                    if moveWorks { onMove?(id) }
                    return moveWorks
                },
                axWindows: { [self] in listed },
                wait: { probe in probe() },
                appElement: fakeElement(60_099))
        }
    }

    private func resolve(_ w: World, ax: [CUAXWindow] = [], server: [CUWindowServerWindow], selector: CUWindowSelector? = nil,
                         privatePath: Bool = true) throws -> CUWindowResolver.Outcome {
        try CUWindowResolver.resolve(appName: "Safari", axWindows: ax, server: server, selector: selector,
                                     privatePath: privatePath, w.effects())
    }

    private func expectCode(_ code: String, file: StaticString = #filePath, line: UInt = #line, _ body: () throws -> Void) {
        do {
            try body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }

    func testAnOffSpaceWindowIsBoundWhereItIsByRemoteToken() throws {
        let w = World()
        w.remote[9] = offWindow
        let out = try resolve(w, server: [serverWindow(9, title: "Apple")])
        XCTAssertEqual(out.window.id, 9)
        XCTAssertTrue(CFEqual(out.window.element, offWindow))
        XCTAssertEqual(w.tried, ["remote:9"], "nothing is moved and no window is opened")
        XCTAssertTrue(out.detail?.hasPrefix("step 0 (where it is): ") == true, out.detail ?? "")
        XCTAssertEqual(out.step, .whereItIs)
    }

    func testWithoutTheRemoteElementTheWindowIsMovedHere() throws {
        let w = World()
        w.moveWorks = true
        w.onMove = { [unowned self] id in w.listed = [axWindow(offWindow, id)] }
        let out = try resolve(w, server: [serverWindow(9)])
        XCTAssertEqual(out.window.id, 9)
        XCTAssertEqual(w.tried, ["remote:9", "move:9"])
        XCTAssertEqual(out.detail, "step a (moved): moved Safari's window to this desktop from another Space")
        XCTAssertEqual(out.step, .moved)
    }

    func testWhenAccessibilityCannotReachItTheWindowIsBoundCaptureOnly() throws {
        let w = World()
        let out = try resolve(w, server: [serverWindow(9)])
        XCTAssertEqual(w.tried, ["remote:9", "move:9"], "never a new window: straight to capture-only")
        XCTAssertTrue(out.captureOnly)
        XCTAssertEqual(out.step, .captureOnly)
        XCTAssertEqual(out.window.id, 9)
        XCTAssertTrue(CFEqual(out.window.element, appEl), "the placeholder app element")
        XCTAssertTrue(out.detail?.contains("capture only") ?? false, out.detail ?? "")
    }

    func testAnOnScreenWindowAXListsAMomentLaterIsNotCaptureOnly() throws {
        let w = World()
        w.listed = [axWindow(freshWindow, 9)]  // what AX lists once the busy app answers (Finder)
        let out = try resolve(w, server: [serverWindow(9, onScreen: true)])
        XCTAssertFalse(out.captureOnly)
        XCTAssertEqual(out.window.id, 9)
        XCTAssertTrue(CFEqual(out.window.element, freshWindow))
    }

    func testAnExplicitWindowTheServerHasButAXCannotIsCaptureOnly() throws {
        let w = World()
        // A popup smaller than isRealWindow's floor, not in AX and not an off-Space real window.
        let out = try resolve(w, server: [serverWindow(92_123, title: "", onScreen: true)], selector: .id(92_123))
        XCTAssertTrue(out.captureOnly)
        XCTAssertEqual(out.window.id, 92_123)
    }

    func testPrivatePathOffDoesNotBindCaptureOnly() {
        let w = World()
        expectCode("window_elsewhere") { _ = try resolve(w, server: [serverWindow(9)], privatePath: false) }
    }

    func testThePrivatePathOffSkipsTheRemoteTokenAndTheMove() {
        let w = World()
        w.remote[9] = offWindow
        w.moveWorks = true
        expectCode("window_elsewhere") { _ = try resolve(w, server: [serverWindow(9)], privatePath: false) }
        XCTAssertEqual(w.tried, [], "no remote token, no move, no new window")
    }

    func testAnAppWithNoWindowIsNoWindowNamingAppsOpenNeverANewWindow() {
        let none = World()
        do {
            _ = try resolve(none, server: [])
            XCTFail("expected no_window")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "no_window")
            XCTAssertTrue(e.message.contains("apps.open("), e.message)
        } catch { XCTFail("\(error)") }
        XCTAssertEqual(none.tried, [], "nothing asked of the app")
    }

    func testOnlyNormalLayerWindowsCount() {
        // A menu-bar extra or a panel (layer ≠ 0) is not a window to bind.
        let w = World()
        w.remote[3] = offWindow
        expectCode("no_window") { _ = try resolve(w, server: [serverWindow(3, layer: 25)]) }
        XCTAssertEqual(w.tried, [])
    }

    func testAWindowOnThisDesktopWinsAndNeedsNothing() throws {
        let w = World()
        w.remote[9] = offWindow
        let here = axWindow(freshWindow, 12)
        let out = try resolve(w, ax: [here], server: [serverWindow(9), serverWindow(12, onScreen: true)])
        XCTAssertEqual(out.window.id, 12)
        XCTAssertNil(out.detail)
        XCTAssertTrue(w.tried.isEmpty)
    }

    func testASelectedOffSpaceWindowIsReachedButNeverReplaced() throws {
        let w = World()
        w.remote[9] = offWindow
        let byId = try resolve(w, server: [serverWindow(9, title: "Apple")], selector: .id(9))
        XCTAssertEqual(byId.window.id, 9)
        let byTitle = try resolve(w, server: [serverWindow(9, title: "Apple — Start")], selector: .title("apple"))
        XCTAssertEqual(byTitle.window.id, 9)

        // A specific window was asked for and AX can't reach it: bound capture-only, never a new window.
        let stuck = World()
        let cap = try resolve(stuck, server: [serverWindow(9)], selector: .id(9))
        XCTAssertTrue(cap.captureOnly)
        XCTAssertEqual(stuck.tried, ["remote:9", "move:9"])

        // An id nobody has is still a parameter error.
        expectCode("invalid_params") { _ = try resolve(World(), server: [serverWindow(9)], selector: .id(99)) }
    }

    func testChoosingFromNoWindowsIsNoWindow() {
        expectCode("no_window") { _ = try CUAXWindows.choose([], selector: nil, appName: "Safari") }
        do {
            _ = try CUAXWindows.choose([], selector: nil, appName: "Safari")
        } catch let e as CUError {
            XCTAssertEqual(e.message, "Safari has no open window — open a document in it with apps.open(path or URL, { app: \"Safari\" }); it opens in the background and binds that window")
        } catch {}
    }

    func testTheRemoteTokenLayout() {
        let token = AX.remoteToken(pid: 0x0102_0304, elementID: 0x0A0B_0C0D_0E0F_1011)
        XCTAssertEqual(Array(token), [0x04, 0x03, 0x02, 0x01, 0, 0, 0, 0, 0x6F, 0x63, 0x6F, 0x63,
                                      0x11, 0x10, 0x0F, 0x0E, 0x0D, 0x0C, 0x0B, 0x0A])
    }

    // MARK: through CUCore, with fakes

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// Safari's one window (77) is on another Space: the window server has it off screen, AX does not list it,
    /// and only the remote token reaches it.
    private func world(privatePath: Bool = true, cached: Bool = false) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [AXUIElement]()])
        ax.add(offWindow, role: kAXWindowRole, title: "Apple", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: offWindow)] = 77
        ax.put(offWindow, [kAXChildrenAttribute: [button, plain]])
        ax.add(button, role: kAXButtonRole, title: "Go", frame: CGRect(x: 150, y: 150, width: 80, height: 24))
        ax.setActions(button, [kAXPressAction])
        ax.add(plain, role: kAXStaticTextRole, title: "label", frame: CGRect(x: 150, y: 200, width: 80, height: 24))
        ax.remoteWindows[77] = offWindow
        ax.add(freshWindow, role: kAXWindowRole, title: "New", frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: freshWindow)] = 88

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.apple.Safari"
        var w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600), owner: "Safari")
        w.onScreen = false
        sys.windows[77] = w
        sys.stack = []
        sys.front = 1

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.windowWaitMs = 200
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.Safari", appName: "Safari",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Apple", privatePath: privatePath)
        // Not cached: the first use goes through the fallback (as after a rebind or a dead element).
        core.registerForTesting(target, windowElement: cached ? offWindow : nil)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction, privatePath: Bool = true) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: privatePath))
    }

    private func expect(_ code: String, file: StaticString = #filePath, line: UInt = #line,
                        _ body: () async throws -> Void) async -> CUError? {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
            return e
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
        return nil
    }

    func testTheBoundWindowIsFoundByRemoteTokenAndAnAXPressNeedsNoMove() async throws {
        world()
        XCTAssertTrue(CFEqual(try core.windowElement(target), offWindow))
        XCTAssertEqual(ax.remoteAsked, [77])
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["60003:AXPress"])
        XCTAssertTrue(sys.moved.isEmpty, "an AX action works where the window is")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testWithThePrivatePathOffTheBoundWindowIsElsewhere() async throws {
        world(privatePath: false)
        XCTAssertThrowsError(try core.windowElement(target)) { e in
            XCTAssertEqual((e as? CUError)?.code, "window_elsewhere")
        }
        XCTAssertTrue(ax.remoteAsked.isEmpty)
    }

    func testAClosedWindowIsStillTargetLost() async throws {
        world()
        sys.windows[77] = nil
        XCTAssertThrowsError(try core.windowElement(target)) { e in
            XCTAssertEqual((e as? CUError)?.code, "target_lost")
            XCTAssertEqual((e as? CUError)?.data?["reason"], .string("window_closed"))
        }
    }

    func testAClickOnAnElementElsewhereIsAnAXPressNeverAMove() async throws {
        world(cached: true)
        sys.moveSucceeds = true
        let r = try await act(.click(CUClickAction(ref: ref(plain))))
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(ax.performed, ["60004:AXPress"], "pressed though it lists no press (web content often doesn't)")
        XCTAssertTrue(sys.moved.isEmpty, "never moved")
        XCTAssertTrue(poster.entries.isEmpty, "no pointer events, no new window")
        XCTAssertEqual(target.windowID, 77)
    }

    func testWithNoWindowSetterGeometricInputElsewhereIsRefused() async throws {
        world(cached: true)
        sys.moveSucceeds = true
        let drag = await expect("needs_desktop_visit") {
            try await self.act(.drag(CUDragAction(from: CUDragEnd(ref: self.ref(self.button)), to: CUDragEnd(ref: self.ref(self.plain)))))
        }
        XCTAssertTrue(drag?.message.contains("the drag can't be sent there with the private event path off") == true, drag?.message ?? "")
        let modified = await expect("needs_desktop_visit") {
            try await self.act(.click(CUClickAction(ref: self.ref(self.plain), modifiers: ["cmd"])))
        }
        XCTAssertTrue(modified?.message.contains("the click can't be sent there") == true, modified?.message ?? "")
        XCTAssertTrue(sys.moved.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty, "no events and no ⌘N: windows are never opened for these")
        XCTAssertEqual(target.windowID, 77)
    }

    func testTheWindowListIncludesWindowsOnOtherSpaces() async throws {
        world()
        let r = try await core.targetWindows(TargetWindowsParams(targetId: "t1"))
        XCTAssertEqual(r.windows.map(\.id), [77])
    }

    func testUseWindowReachesAnOffSpaceWindowWhereItIs() async throws {
        world()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [freshWindow]])
        sys.windows[88] = FakeSystem.window(88, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600), owner: "Safari")
        target.setWindow(id: 88, title: "New")
        core.registerForTesting(target, windowElement: freshWindow)
        let r = try await core.targetUseWindow(TargetUseWindowParams(targetId: "t1", window: .id(77)))
        XCTAssertEqual(r.window.id, 77)
        XCTAssertTrue(r.detail?.contains("where it is") == true, r.detail ?? "")
        XCTAssertEqual(target.windowID, 77)
        XCTAssertTrue(sys.moved.isEmpty)
    }
}
