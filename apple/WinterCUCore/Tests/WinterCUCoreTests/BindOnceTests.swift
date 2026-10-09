import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The live bug where 64 `apps.open('Safari')` calls left Safari with twelve windows: a repeated bind returns
/// the bound target; no ⌘N / New Window, ever; the background reopen only for an app with ZERO windows on any
/// Space, once per bind; a window AX can't reach is bound capture-only; each bind names its step.
final class BindOnceTests: XCTestCase {
    let pid: pid_t = 4747
    let original = fakeElement(90_001)
    let opened = fakeElement(90_002)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var reopens = 0
    /// What a reopen does to the fake world (e.g. the app opens its default window).
    var onReopen: (() -> Void)?

    /// Safari, with its one window (77) on another Space: off screen for the window server, absent from AX,
    /// reachable by remote token unless `reachable` is false.
    private func safari(windowElsewhere: Bool = true, reachable: Bool = true) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])
        ax.add(original, role: kAXWindowRole, title: "Apple", frame: CGRect(x: 0, y: 0, width: 1200, height: 800))
        ax.windowIDs[AXIdentity(element: original)] = 77
        if reachable { ax.remoteWindows[77] = original }
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.apple.Safari"
        if windowElsewhere {
            var w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 1200, height: 800), owner: "Safari")
            w.onScreen = false
            sys.windows[77] = w
        }
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.windowWaitMs = 150
        reopens = 0
        onReopen = nil
        core.reopenApp = { [unowned self] _ in reopens += 1; onReopen?() }
        let pid = self.pid
        core.resolveBindApp = { _, _ in
            CUCore.BindApp(pid: pid, bundleIdentifier: "com.apple.Safari", name: "Safari", executableName: "Safari",
                           isChromium: false, launched: false, running: nil)
        }
    }

    private func bind(_ session: String = "s") async throws -> TargetBindResult {
        try await core.targetBind(TargetBindParams(sessionId: session, app: "Safari", mirror: false))
    }

    private func expectCode(_ code: String, file: StaticString = #filePath, line: UInt = #line,
                            _ body: () async throws -> Void) async {
        do {
            try await body()
            XCTFail("expected \(code)", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, code, e.message, file: file, line: line)
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }

    // MARK: through targetBind

    func testARepeatedBindReturnsTheBoundTargetAndTouchesNothing() async throws {
        safari()
        let first = try await bind()
        XCTAssertTrue(first.detail?.hasPrefix("step 0 (where it is): ") ?? false, first.detail ?? "")
        XCTAssertEqual(first.window.id, 77)
        for _ in 0..<5 {
            let again = try await bind()
            XCTAssertEqual(again.targetId, first.targetId)
            XCTAssertEqual(again.window.id, 77)
            XCTAssertNil(again.detail, "nothing was done to reach it")
        }
        XCTAssertEqual(ax.remoteWalks, 1, "resolved once")
        XCTAssertTrue(sys.moved.isEmpty)
        XCTAssertTrue(poster.entries.isEmpty, "no new window asked for")
        // Another session gets its own target; a released one is resolved again.
        let other = try await bind("s2")
        XCTAssertNotEqual(other.targetId, first.targetId)
        _ = try await core.targetRelease(TargetReleaseParams(targetId: first.targetId))
        let rebound = try await bind()
        XCTAssertNotEqual(rebound.targetId, first.targetId)
    }

    func testABindWhoseWindowIsGoneResolvesAgain() async throws {
        safari()
        let first = try await bind()
        sys.windows[77] = nil
        var w = FakeSystem.window(78, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 700), owner: "Safari")
        w.onScreen = false
        sys.windows[78] = w
        ax.remoteWindows[78] = opened
        ax.windowIDs[AXIdentity(element: opened)] = 78
        let again = try await bind()
        XCTAssertNotEqual(again.targetId, first.targetId)
        XCTAssertEqual(again.window.id, 78)
    }

    func testAWindowAXCannotReachIsBoundCaptureOnlyWithNoNewWindowEver() async throws {
        safari(reachable: false)  // the window is elsewhere, the remote token misses, the move fails
        let r = try await self.bind()
        XCTAssertEqual(r.window.id, 77)
        XCTAssertTrue(r.detail?.contains("capture only") ?? false, r.detail ?? "")
        for _ in 0..<4 { _ = try await self.bind() }
        _ = try await self.bind("s2")
        XCTAssertTrue(poster.entries.isEmpty, "no ⌘N, no key, nothing posted to reach a window")
        XCTAssertTrue(ax.performed.isEmpty, "no File › New Window pressed")
        XCTAssertEqual(reopens, 0, "it has a window (elsewhere): never a reopen")
    }

    func testAnAppWithZeroWindowsIsReopenedOnceInTheBackgroundAndItsDefaultWindowBound() async throws {
        safari(windowElsewhere: false)  // Safari runs with all its windows closed
        onReopen = { [unowned self] in
            // The reopen opens the app's default window on this desktop.
            ax.put(ax.application(pid), [kAXWindowsAttribute: [original]])
            sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 1200, height: 800), owner: "Safari")
        }
        let r = try await bind()
        XCTAssertEqual(reopens, 1)
        XCTAssertEqual(r.window.id, 77)
        XCTAssertTrue(r.detail?.hasPrefix("opened the app's default window") ?? false, r.detail ?? "")
        XCTAssertTrue(poster.entries.isEmpty, "a reopen, never ⌘N")
        XCTAssertTrue(ax.performed.isEmpty)
    }

    func testAReopenThatOpensNothingIsNoWindowAfterOneReopen() async throws {
        safari(windowElsewhere: false)
        await expectCode("no_window") { _ = try await self.bind() }
        XCTAssertEqual(reopens, 1, "once per bind")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testReusableTargetMatchesSessionAppAndWindow() async throws {
        safari()
        let first = try await bind()
        XCTAssertEqual(core.reusableTarget(sessionId: "s", pid: pid, selector: nil)?.id, first.targetId)
        XCTAssertEqual(core.reusableTarget(sessionId: "s", pid: pid, selector: .id(77))?.id, first.targetId)
        XCTAssertEqual(core.reusableTarget(sessionId: "s", pid: pid, selector: .title("app"))?.id, first.targetId)
        XCTAssertNil(core.reusableTarget(sessionId: "s", pid: pid, selector: .id(5)), "another window is another bind")
        XCTAssertNil(core.reusableTarget(sessionId: "other", pid: pid, selector: nil))
        sys.running = []
        XCTAssertNil(core.reusableTarget(sessionId: "s", pid: pid, selector: nil), "the app quit")
    }

    // MARK: the window wait (pure)

    private final class Wait {
        var ax: [CUAXWindow] = []
        var server: [CUWindowServerWindow] = []
        var reopens = 0
        var now: Double = 0
        func effects() -> CUBindWait.Effects {
            CUBindWait.Effects(read: { [self] in (ax, server) },
                               reopen: { [self] in reopens += 1 },
                               sleep: { [self] ms in now += ms },
                               now: { [self] in now })
        }
    }

    private func server(_ id: UInt32, onScreen: Bool, size: CGFloat = 800, layer: Int = 0) -> CUWindowServerWindow {
        CUWindowServerWindow(id: id, pid: pid, ownerName: "Safari", title: "", frame: CGRect(x: 0, y: 0, width: size, height: size),
                             layer: layer, onScreen: onScreen, alpha: 1)
    }

    func testWindowsOnAnotherSpaceAreNotWaitedFor() async throws {
        let w = Wait()
        w.server = (1...12).map { server($0, onScreen: false) }
        let found = try await CUBindWait.run(launched: false, deadlineMs: 3000, w.effects())
        XCTAssertEqual(w.reopens, 0, "windows elsewhere or minimized: never a reopen")
        XCTAssertFalse(found.reopened)
        XCTAssertEqual(w.now, 0, "no wait: the resolver reaches them")
        XCTAssertEqual(found.server.count, 12)
    }

    func testOnlyARunningAppWithZeroWindowsAnywhereIsReopenedOnce() async throws {
        let none = Wait()
        let found = try await CUBindWait.run(launched: false, deadlineMs: 1000, none.effects())
        XCTAssertEqual(none.reopens, 1, "one reopen for the whole wait")
        XCTAssertTrue(found.reopened)

        let stubs = Wait()
        stubs.server = [server(1, onScreen: false, size: 10), server(2, onScreen: true, layer: 25)]
        _ = try await CUBindWait.run(launched: false, deadlineMs: 1000, stubs.effects())
        XCTAssertEqual(stubs.reopens, 1, "a 10-pt stub and a menu-bar item are not windows")

        let oneElsewhere = Wait()
        oneElsewhere.server = [server(1, onScreen: false)]
        _ = try await CUBindWait.run(launched: false, deadlineMs: 1000, oneElsewhere.effects())
        XCTAssertEqual(oneElsewhere.reopens, 0, "one window on another Space or minimized: no reopen")

        let justLaunched = Wait()
        _ = try await CUBindWait.run(launched: true, deadlineMs: 1000, justLaunched.effects())
        XCTAssertEqual(justLaunched.reopens, 0, "an app this bind launched is never reopened")
    }

    func testAWindowOnScreenThatAXHasNotListedYetIsWaitedFor() async throws {
        let w = Wait()
        w.server = [server(1, onScreen: true)]
        let found = try await CUBindWait.run(launched: false, deadlineMs: 500, w.effects())
        XCTAssertEqual(w.reopens, 0)
        XCTAssertGreaterThanOrEqual(w.now, 500, "it waited for AX")
        XCTAssertTrue(found.ax.isEmpty)
    }

    // MARK: the resolver (pure)

    func testOneRemoteWalkCoversEveryOffSpaceWindow() throws {
        var walks: [[UInt32]] = []
        let fx = CUWindowResolver.Effects(
            remote: { ids in walks.append(ids); return ids.contains(11) ? [11: self.original] : [:] },
            describe: { e, s in CUAXWindow(element: e, id: s.id, title: s.title, frame: s.frame, focused: false, main: false) },
            moveToActiveSpace: { _ in XCTFail("no move"); return false },
            axWindows: { [] }, wait: { $0() }, appElement: fakeElement(60_098))
        let out = try CUWindowResolver.resolve(appName: "Safari", axWindows: [],
                                               server: [server(9, onScreen: false), server(10, onScreen: false), server(11, onScreen: false)],
                                               selector: nil, privatePath: true, fx)
        XCTAssertEqual(out.window.id, 11)
        XCTAssertEqual(out.step, .whereItIs)
        XCTAssertEqual(walks, [[9, 10, 11]])
    }
}
