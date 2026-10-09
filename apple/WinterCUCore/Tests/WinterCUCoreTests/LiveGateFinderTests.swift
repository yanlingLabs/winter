import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The live run's Finder and Safari struggles (session s_1ac4717445c5), on fakes: phantom strip windows,
/// disabled controls pressed "successfully", menu commands aimed at another window, new windows nobody was
/// told about, a target lost while its window was changing Space, and find re-reading the whole page.
final class LiveGateFinderTests: XCTestCase {
    let pid: pid_t = 5151
    let window = fakeElement(99_001)
    let trash = fakeElement(99_002)
    let group = fakeElement(99_003)
    let icon = fakeElement(99_004)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    private func finder() {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Downloads", frame: CGRect(x: 100, y: 100, width: 900, height: 500),
               extra: [kAXChildrenAttribute: [group, trash]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.makeSettable(window, kAXMainAttribute)
        ax.add(trash, role: kAXMenuItemRole, title: "Move to Trash", frame: CGRect(x: 120, y: 130, width: 160, height: 20),
               extra: [kAXEnabledAttribute: false])
        ax.setActions(trash, [kAXPressAction, kAXCancelAction])
        ax.add(group, role: kAXGroupRole, frame: CGRect(x: 300, y: 300, width: 80, height: 80),
               extra: [kAXEnabledAttribute: false, kAXChildrenAttribute: [icon]])
        ax.add(icon, role: kAXImageRole, title: "report.pdf", frame: CGRect(x: 310, y: 310, width: 64, height: 64),
               extra: [kAXParentAttribute: group])
        ax.setActions(icon, ["AXOpen", kAXShowMenuAction])

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.apple.finder"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 900, height: 500), owner: "Finder")
        sys.windows[77] = w
        // Finder's phantoms: four menu-bar strips and a 64×64 stub, layer 0, never in AX.
        for id in UInt32(70328)...70331 { sys.windows[id] = FakeSystem.window(id, pid: pid, CGRect(x: 0, y: 0, width: 1512, height: 33)) }
        sys.windows[28] = FakeSystem.window(28, pid: pid, CGRect(x: 0, y: 482, width: 64, height: 64))
        sys.stack = [w]
        sys.front = 1

        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.finder", appName: "Finder",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Downloads")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    // MARK: phantom windows

    func testPhantomStripsAndStubsAreNotWindows() async throws {
        finder()
        XCTAssertTrue(CUWindowServer.isRealWindow(sys.windows[77]!))
        XCTAssertFalse(CUWindowServer.isRealWindow(sys.windows[70328]!), "a 1512×33 strip")
        XCTAssertFalse(CUWindowServer.isRealWindow(sys.windows[28]!), "a 64×64 stub")
        let listed = try await core.targetWindows(TargetWindowsParams(targetId: "t1"))
        XCTAssertEqual(listed.windows.map(\.id), [77], "no untitled phantoms in windows()")
        // The resolver never probes them by remote token, so a bind does not walk to the deadline for them.
        var walked: [[UInt32]] = []
        let fx = CUWindowResolver.Effects(
            remote: { ids in walked.append(ids); return [:] }, describe: { e, s in
                CUAXWindow(element: e, id: s.id, title: s.title, frame: s.frame, focused: false, main: false) },
            moveToActiveSpace: { _ in false }, axWindows: { [] },
            wait: { $0() }, appElement: fakeElement(60_097))
        var off = sys.windows[77]!
        off.onScreen = false
        let server = [off] + (UInt32(70328)...70331).map { sys.windows[$0]! } + [sys.windows[28]!]
        _ = try? CUWindowResolver.resolve(appName: "Finder", axWindows: [], server: server, selector: nil, privatePath: true, fx)
        XCTAssertEqual(walked, [[77]])
    }

    func testAPhantomOnScreenDoesNotHoldABindWaitingForAX() async throws {
        var reads = 0
        var real = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 900, height: 500))
        real.onScreen = false
        let stub = FakeSystem.window(28, pid: pid, CGRect(x: 0, y: 482, width: 64, height: 64))  // on screen
        var now: Double = 0
        let found = try await CUBindWait.run(launched: false, deadlineMs: 3000, CUBindWait.Effects(
            read: { reads += 1; return ([], [real, stub]) }, reopen: { XCTFail("no reopen") },
            sleep: { now += $0 }, now: { now }))
        XCTAssertEqual(reads, 1, "straight to the resolver")
        XCTAssertEqual(now, 0)
        XCTAssertFalse(found.reopened)
    }

    // MARK: disabled controls and menu commands

    func testADisabledMenuItemIsRefusedNotPressed() async throws {
        finder()
        do {
            try await act(.click(CUClickAction(ref: ref(trash))))
            XCTFail("expected unsupported")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("“Move to Trash” is disabled right now"), e.message)
            XCTAssertTrue(e.message.contains("active window"), e.message)
        }
        do {
            try await act(.action(CUAXAction(ref: ref(trash), name: "press")))
            XCTFail("expected unsupported")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
        }
        XCTAssertTrue(ax.performed.isEmpty, "never pressed")
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testADisabledContainerDoesNotBlockTheLiveItemInIt() async throws {
        finder()
        ax.refuses = ["\(token(icon)):AXOpen"]
        // The icon's group is marked disabled (as Finder marks them); the icon itself is not.
        try await act(.click(CUClickAction(ref: ref(icon), count: 2)))
        XCTAssertFalse(poster.entries.isEmpty, "the double click went out")
    }

    func testAMenuCommandFirstMakesTheBoundWindowTheAppsMainWindow() async throws {
        finder()
        let bar = fakeElement(99_010), apple = fakeElement(99_011), go = fakeElement(99_012), goMenu = fakeElement(99_013)
        let downloads = fakeElement(99_014)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [apple, go]])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.add(go, role: "AXMenuBarItem", title: "Go", extra: [kAXChildrenAttribute: [goMenu]])
        ax.add(goMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [downloads]])
        ax.add(downloads, role: kAXMenuItemRole, title: "Downloads")
        ax.setActions(downloads, [kAXPressAction])
        try await act(.menu(CUMenuAction(path: ["Go", "Downloads"])))
        XCTAssertEqual(ax.written, ["\(token(window)):AXMain"], "the bound window was made main first")
        XCTAssertEqual(ax.performed, ["\(token(downloads)):AXPress"])
    }

    // MARK: new windows, lost targets, find

    func testANewWindowOfTheAppIsNamedOnce() throws {
        finder()
        target.knownWindows = [77]
        XCTAssertTrue(core.newWindows(target).isEmpty, "phantoms never count")
        var w = FakeSystem.window(84771, pid: pid, CGRect(x: 300, y: 150, width: 920, height: 464), owner: "Finder")
        w.title = "Downloads"
        sys.windows[84771] = w
        let notes = core.newWindows(target)
        XCTAssertEqual(notes, ["new Finder window “Downloads” (84771) — this state is still the bound window; useWindow(84771) to work in it"])
        XCTAssertTrue(core.newWindows(target).isEmpty, "said once")
    }

    func testAWindowTheServerMissesOnceIsNotLost() async throws {
        finder()
        sys.missOnce = [77]
        XCTAssertFalse(core.windowGone(target), "a single miss while the window changes Space")
        sys.windows[77] = nil
        XCTAssertTrue(core.windowGone(target))
    }

    func testFindReusesAFreshFullReadUntilSomethingHappens() async throws {
        finder()
        let roots = [CUNode(ref: 1, role: kAXWindowRole, name: "Downloads", children: [
            CUNode(ref: 2, role: kAXMenuItemRole, name: "Move to Trash", states: [.disabled]),
        ])]
        target.lastFullRead = (roots, CUSystemClock().nowMs())
        let r = try await core.targetFind(TargetFindParams(targetId: "t1", query: .text("trash")))
        XCTAssertEqual(r.elements.map(\.ref), [2], "answered from the read just taken")
        XCTAssertEqual(r.elements.first?.states, ["disabled"], "find says it is disabled")
        target.lastActionMs = CUSystemClock().nowMs() + 1
        XCTAssertNil(core.freshRead(target), "an act since: read again")
        target.lastActionMs = nil
        target.lastFullRead = (roots, CUSystemClock().nowMs() - 2000)
        XCTAssertNil(core.freshRead(target), "too old")
    }
}
