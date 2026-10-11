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

    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!

    private func world(bundle: String = "com.google.Chrome", url: String = "chrome://inspect/#remote-debugging",
                       dialogUp: Bool = false, standardTitled: String? = nil) {
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
               frame: CGRect(x: 900, y: 0, width: 400, height: 300))

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = bundle
        sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600))
        sys.stack = [sys.windows[77]!]
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: recordingSkyLight(), poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "Google Chrome", isChromium: true,
                          mirror: false, windowID: 77, windowTitle: "Inspect")
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
}
