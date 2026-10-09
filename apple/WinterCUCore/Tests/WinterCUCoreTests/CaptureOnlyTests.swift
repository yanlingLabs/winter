import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A window the window server has but accessibility cannot reach (a Unity window, a popup with an empty tree)
/// is bound capture-plus-coordinates: state() says "no accessibility", find() is empty, screenshots and point
/// clicks still work.
final class CaptureOnlyTests: XCTestCase {
    let pid: pid_t = 7373
    let window = fakeElement(96_601)
    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!
    var poster: RecordingPoster!
    /// A field in ANOTHER window of the app that the app reports as focused.
    let otherWindowField = fakeElement(96_602)

    private func bind(onScreen: Bool = true) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement]()])
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "jp.vroid.studio"
        var w = FakeSystem.window(92_123, pid: pid, CGRect(x: 100, y: 100, width: 900, height: 600), owner: "VRoid Studio")
        w.title = ""
        w.onScreen = onScreen
        sys.windows[92_123] = w
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "jp.vroid.studio", appName: "VRoid Studio",
                          isChromium: false, mirror: false, windowID: 92_123, windowTitle: "", accessible: false)
        core.registerForTesting(target, windowElement: AX.app(pid))
    }

    func testStateSaysNoAccessibility() async throws {
        bind()
        let snap = try await core.targetSnapshot(TargetSnapshotParams(targetId: "t1"))
        XCTAssertFalse(snap.isDiff)
        XCTAssertTrue(snap.text.contains("VRoid Studio — window (untitled) — no accessibility"), snap.text)
        XCTAssertTrue(snap.text.contains("screenshot()"), snap.text)
        XCTAssertTrue(snap.text.contains("click at point coordinates"), snap.text)
    }

    func testFindReturnsNothing() async throws {
        bind()
        let r = try await core.targetFind(TargetFindParams(targetId: "t1", query: .fields(role: "button", name: nil, text: nil)))
        XCTAssertTrue(r.elements.isEmpty)
    }

    private func reportFocus(secure: Bool = false) {
        ax.add(otherWindowField, role: kAXTextFieldRole, subrole: secure ? kAXSecureTextFieldSubrole : nil,
               frame: CGRect(x: 0, y: 0, width: 200, height: 24))
        ax.makeSettable(otherWindowField, kAXSelectedTextAttribute)
        ax.makeSettable(otherWindowField, kAXFocusedAttribute)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [AXUIElement](), kAXFocusedUIElementAttribute: otherWindowField])
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    func testTypingIntoACaptureOnlyWindowWritesNoAccessibilityAttributeAndSendsKeys() async throws {
        bind()
        reportFocus()
        try await act(.type(CUTypeAction(text: "hi")))
        XCTAssertEqual(ax.written, [], "no AXFocused, AXMain or AXSelectedText write — not on the app element, not into another window's field")
        XCTAssertEqual(poster.keyDowns.count, 2, "the text went as key events to the app")
        XCTAssertTrue(poster.keyDowns.allSatisfy { $0.pid == pid })
    }

    func testAKeyIntoACaptureOnlyWindowIsAKeyEventNeverAWrite() async throws {
        bind()
        reportFocus()
        try await act(.key(CUKeyAction(combo: "enter")))
        XCTAssertEqual(ax.written, [])
        XCTAssertEqual(poster.keyDowns.count, 1)
    }

    func testAPasswordFieldTheAppReportsStillRefusesTyping() async throws {
        bind()
        reportFocus(secure: true)
        do {
            try await act(.type(CUTypeAction(text: "hi")))
            XCTFail("expected the secure-field floor")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
        }
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }
}
