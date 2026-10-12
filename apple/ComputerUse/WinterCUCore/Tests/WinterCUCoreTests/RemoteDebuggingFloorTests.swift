import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Floor F (the Phase 4 spine §2.4): in a Chromium browser, no act on an inspect page (by its web area's `AXURL`, any UI
/// language) or on the "Allow remote debugging?" dialog — under every policy, before anything is sent.
final class RemoteDebuggingFloorTests: XCTestCase {
    let pid: pid_t = 5252
    let window = fakeElement(99_001)
    let toolbarButton = fakeElement(99_002)
    let area = fakeElement(99_003)
    let checkbox = fakeElement(99_004)
    let dialog = fakeElement(99_005)
    let dialogText = fakeElement(99_006)
    let other = fakeElement(99_007)
    let otherArea = fakeElement(99_008)

    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!

    private func world(bundle: String = "com.google.Chrome", url: String = "chrome://inspect/#remote-debugging",
                       dialogUp: Bool = false, standardTitled: String? = nil, chromium: Bool? = nil, accessible: Bool = true,
                       serverTitle: String = "") {
        ax = FakeAX()
        var windows = [window]
        if dialogUp { windows.insert(dialog, at: 0) }
        if standardTitled != nil { windows.append(other) }
        ax.put(ax.application(pid), [kAXWindowsAttribute: windows])
        ax.add(window, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, title: "Inspect",
               frame: CGRect(x: 0, y: 0, width: 800, height: 600), extra: [kAXChildrenAttribute: [toolbarButton, area]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(toolbarButton, role: kAXButtonRole, title: "Back", frame: CGRect(x: 10, y: 10, width: 30, height: 30),
               extra: [kAXParentAttribute: window])
        ax.setActions(toolbarButton, [kAXPressAction])
        ax.add(area, role: "AXWebArea", frame: CGRect(x: 0, y: 60, width: 800, height: 540),
               extra: [kAXParentAttribute: window, kAXChildrenAttribute: [checkbox], "AXURL": url])
        ax.add(checkbox, role: kAXCheckBoxRole, title: "Allow remote debugging for this browser instance",
               frame: CGRect(x: 40, y: 100, width: 300, height: 20), extra: [kAXParentAttribute: area, kAXValueAttribute: 0])
        ax.setActions(checkbox, [kAXPressAction])
        ax.add(dialog, role: kAXWindowRole, subrole: kAXDialogSubrole, frame: CGRect(x: 200, y: 200, width: 400, height: 200),
               extra: [kAXChildrenAttribute: [dialogText]])
        ax.add(dialogText, role: kAXStaticTextRole, extra: [kAXParentAttribute: dialog, kAXValueAttribute: "Allow remote debugging?"])
        ax.add(other, role: kAXWindowRole, subrole: kAXStandardWindowSubrole, title: standardTitled ?? "",
               frame: CGRect(x: 900, y: 0, width: 400, height: 300), extra: [kAXChildrenAttribute: [otherArea]])
        ax.add(otherArea, role: "AXWebArea", frame: CGRect(x: 900, y: 40, width: 400, height: 260),
               extra: [kAXParentAttribute: other, "AXURL": "https://example.com/tutorial"])

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = bundle
        var w77 = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600))
        w77.title = serverTitle
        sys.windows[77] = w77
        sys.stack = [sys.windows[77]!]
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "Google Chrome",
                          isChromium: chromium ?? (bundle != "com.apple.Safari"), mirror: false, windowID: 77, windowTitle: "Inspect")
        target.accessible = accessible
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func params(_ a: CUAction) -> TargetActParams {
        TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full, allowForeground: false, privatePath: true)
    }
    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func isRemoteDebuggingRefusal(_ error: Error) -> Bool {
        guard let e = error as? CUError else { return false }
        return e.code == "refused" && e.data?["reason"] == .string("remote_debugging")
    }

    func testAnActOnAnInspectPageIsRefusedBeforeAnythingIsSent() async throws {
        world()
        do {
            _ = try await core.targetAct(params(.click(CUClickAction(ref: ref(checkbox)))))
            XCTFail("refused")
        } catch {
            XCTAssertTrue(isRemoteDebuggingRefusal(error), "\(error)")
            XCTAssertEqual((error as? CUError)?.message, CUCore.remoteDebuggingSentence)
        }
        XCTAssertTrue(ax.performed.isEmpty, "nothing pressed")
        // Keys, typing with no field named, a menu command: the window shows the page — refused too.
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.key(CUKeyAction(combo: "space"))), target)) {
            XCTAssertTrue(isRemoteDebuggingRefusal($0))
        }
        // Every inspect scheme of the family, any fragment.
        for u in ["edge://inspect", "brave://inspect/#devices", "CHROME://INSPECT/#remote-debugging", "arc://inspect"] {
            XCTAssertTrue(CUCore.isInspectPage(u), u)
        }
        XCTAssertFalse(CUCore.isInspectPage("chrome://settings"))
        XCTAssertFalse(CUCore.isInspectPage("https://inspect.example.com"))
    }

    func testTheBrowsersOwnUIStaysUsableToLeaveThePage() {
        world()
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(toolbarButton)))), target))
    }

    func testAnOrdinaryPageOrAnotherBrowserIsUntouched() {
        world(url: "https://example.com/inspect")
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(checkbox)))), target))
        world(bundle: "com.apple.Safari")
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(checkbox)))), target))
    }

    func testTheRemoteDebuggingDialogBlocksEveryAct() {
        world(url: "https://example.com", dialogUp: true)
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(toolbarButton)))), target)) {
            XCTAssertTrue(isRemoteDebuggingRefusal($0))
        }
    }

    func testAPageTitledSoIsNoDialog() {
        world(url: "https://example.com", standardTitled: "Allow remote debugging — a tutorial")
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(toolbarButton)))), target))
    }

    /// Review of round 11, MEDIUM #8: any Chromium-based app (Edge Canary is in no list), any non-web scheme's `inspect`.
    func testEveryChromiumAppAndAnyNonWebSchemeAreCovered() {
        world(bundle: "com.microsoft.edgemac.Canary", url: "edge://inspect/#devices", chromium: true)
        core.isWebBrowserOverride = { _ in true }  // it declares http/https: a browser
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(checkbox)))), target))
        XCTAssertTrue(CUCore.isInspectPage("comet://inspect/#remote-debugging"))
        XCTAssertFalse(CUCore.isInspectPage("https://inspect.example.com/"))
    }

    /// A capture-only bind still sends point clicks: judged by the window server's titles.
    func testACaptureOnlyBindIsJudgedByItsWindowTitle() {
        world(accessible: false, serverTitle: "Inspect with Chrome Developer Tools")
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.key(CUKeyAction(combo: "space"))), target)) {
            XCTAssertTrue(isRemoteDebuggingRefusal($0))
        }
        world(accessible: false, serverTitle: "Example Domain")
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.key(CUKeyAction(combo: "space"))), target))
    }

    /// A standard window with no web page that says "Allow remote debugging" is the dialog too.
    func testAStandardWindowWithNoPageThatSaysSoIsTheDialog() {
        world(url: "https://example.com", standardTitled: "")
        ax.put(other, [kAXChildrenAttribute: [dialogText]])
        XCTAssertThrowsError(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(toolbarButton)))), target)) {
            XCTAssertTrue(isRemoteDebuggingRefusal($0))
        }
    }

    /// Review of round 12, MEDIUM #5: an Electron or CEF app (no browser) is never covered — its own `<scheme>://inspect`
    /// route is its business.
    func testANonBrowserChromiumAppIsNotCovered() {
        world(bundle: "com.tinyspeck.slackmacgap", url: "slack://inspect/x", chromium: true)
        core.isWebBrowserOverride = { _ in false }
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(checkbox)))), target))
    }

    /// Review of round 12, MEDIUM #5: a standard window whose walk is cut short (a deep page) is no dialog candidate —
    /// a tab titled "how to allow remote debugging" never refuses every act.
    func testADeepPageWindowIsNoDialogCandidate() {
        world(url: "https://example.com", standardTitled: "how to allow remote debugging – Google Search")
        var parent = other
        var chain: [AXUIElement] = []
        for i in 0..<230 {
            let g = fakeElement(Int32(99_100 + i))
            ax.add(g, role: kAXGroupRole, extra: [kAXParentAttribute: parent])
            ax.put(parent, [kAXChildrenAttribute: [g]])
            chain.append(g)
            parent = g
        }
        XCTAssertNoThrow(try core.floorCheckRemoteDebugging(params(.click(CUClickAction(ref: ref(toolbarButton)))), target))
    }

    /// Review of round 13, MEDIUM #8: the walk tells a page (more nodes than a dialog has: no candidate) from a walk out
    /// of time (unknown: still a candidate, its text checked, the scan not cached).
    func testTheWalkTellsALargeWindowFromAnUnfinishedOne() {
        world(url: "https://example.com", standardTitled: "Settings")
        let small = fakeElement(99_400)
        ax.add(small, role: kAXWindowRole, extra: [kAXChildrenAttribute: [fakeElement(99_401)]])
        XCTAssertEqual(core.webAreaWalk(small), .absent)
        XCTAssertEqual(core.webAreaWalk(small, maxMs: 0), .unknown, "out of time: unknown, never a no")
        XCTAssertEqual(core.webAreaWalk(small, maxNodes: 0), .large)
        XCTAssertTrue(CUCore.isInspectPageTitle("Inspect with Chrome Developer Tools - Work"), "a profile's title tail")
        XCTAssertFalse(CUCore.isInspectPageTitle("How to Inspect with Chrome Developer Tools - Work"))
    }

    /// Review of round 12, LOW: the capture-only title rule is anchored.
    func testTheInspectTitleRuleIsAnchored() {
        XCTAssertTrue(CUCore.isInspectPageTitle("Inspect with Chrome Developer Tools"))
        XCTAssertFalse(CUCore.isInspectPageTitle("How to Inspect with Chrome Developer Tools"))
        XCTAssertTrue(CUCore.isInspectPageTitle("chrome://inspect/#devices"))
        XCTAssertFalse(CUCore.isInspectPageTitle("https://inspect.example.com"))
        XCTAssertFalse(CUCore.isInspectPageTitle("chrome://inspection-notes"))
    }
}
