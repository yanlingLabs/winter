import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// ⌘A ⌘C ⌘X ⌘V into a web field of a background app are carried out over accessibility: live, neither the key
/// equivalents nor the app's (unvalidated) Edit items did anything in a background WebKit view.
final class EditEmulationTests: XCTestCase {
    let pid: pid_t = 5151
    let window = fakeElement(98_801)
    let web = fakeElement(98_802)
    let field = fakeElement(98_803)
    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var pb: PasteAndQueueTests.FakePasteboard!
    var core: CUCore!
    var target: CUTarget!

    private func world(value: String = "copy me", selected: CFRange? = nil, clipboard: String? = nil) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        ax.add(window, role: kAXWindowRole, title: "Page", frame: CGRect(x: 0, y: 0, width: 800, height: 600),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", frame: CGRect(x: 0, y: 40, width: 800, height: 560), extra: [kAXChildrenAttribute: [field]])
        ax.add(field, role: kAXTextFieldRole, title: "First", frame: CGRect(x: 20, y: 60, width: 300, height: 24),
               extra: [kAXValueAttribute: value, kAXParentAttribute: web])
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        if let selected { ax.put(field, [kAXSelectedTextRangeAttribute: AX.makeRange(location: selected.location, length: selected.length)!]) }
        ax.focus(pid: pid, on: field)
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.web"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 600), owner: "Web")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1  // the app is in the background
        poster = RecordingPoster()
        pb = PasteAndQueueTests.FakePasteboard(clipboard.map { [[NSPasteboard.PasteboardType.string.rawValue: Data($0.utf8)]] } ?? [])
        let shared = pb!
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { shared }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.web", appName: "Web",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Page")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func token(_ e: AXUIElement) -> String { var p: pid_t = 0; AXUIElementGetPid(e, &p); return "\(p)" }

    @discardableResult
    private func key(_ combo: String) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .key(CUKeyAction(combo: combo, into: target.refs.ref(for: AXIdentity(element: field)))),
            access: .full, allowForeground: false, privatePath: false))
    }

    private func selection() -> CFRange? {
        guard let v = ax.attribute(field, kAXSelectedTextRangeAttribute) else { return nil }
        var r = CFRange(); return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
    }

    func testSelectAllSetsTheWholeRange() async throws {
        world(value: "copy me ✓")
        let r = try await key("cmd+a")
        XCTAssertEqual(selection()?.location, 0)
        XCTAssertEqual(selection()?.length, "copy me ✓".utf16.count)
        XCTAssertTrue(poster.keyDowns.isEmpty, "no key equivalent posted")
        XCTAssertTrue(r.detail?.contains("selected over accessibility") ?? false, r.detail ?? "")
    }

    func testCopyPutsTheSelectedTextOnTheClipboard() async throws {
        world(value: "copy me ✓", selected: CFRange(location: 0, length: "copy me ✓".utf16.count))
        try await key("cmd+c")
        XCTAssertEqual(pb.readString(), "copy me ✓")
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }

    func testCutCopiesAndDeletesTheSelection() async throws {
        world(value: "abc", selected: CFRange(location: 0, length: 3))
        try await key("cmd+x")
        XCTAssertEqual(pb.readString(), "abc")
        XCTAssertEqual(poster.keyDowns.map(\.keycode), [Int64(kVK_Delete)], "then one Delete")
    }

    func testPasteTypesTheClipboardsText() async throws {
        world(value: "old", selected: CFRange(location: 0, length: 3), clipboard: "hi")
        try await key("cmd+v")
        XCTAssertEqual(poster.keyDowns.map(\.unicode), ["h", "i"], "the clipboard's text, typed")
        XCTAssertFalse(poster.keyDowns.contains { $0.flags.contains(.maskCommand) }, "no ⌘V posted")
    }

    func testAnAppInFrontGetsTheRealShortcut() async throws {
        world(value: "x", selected: CFRange(location: 0, length: 1), clipboard: "hi")
        sys.front = pid
        try await key("cmd+v")
        XCTAssertTrue(poster.keyDowns.first?.flags.contains(.maskCommand) ?? false, "the real ⌘V")
    }

    // MARK: ⌘Z / ⇧⌘Z: no accessibility equivalent

    private let undoItem = fakeElement(98_810)
    private let redoItem = fakeElement(98_811)

    /// An Edit menu with Undo/Redo — validated only when the menu opens, so they read disabled.
    private func editMenu() {
        let bar = fakeElement(98_812), apple = fakeElement(98_813), edit = fakeElement(98_814), menu = fakeElement(98_815)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.add(apple, role: "AXMenuBarItem", title: "Apple")
        ax.put(bar, [kAXChildrenAttribute: [apple, edit]])
        ax.add(edit, role: "AXMenuBarItem", title: "Edit", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [undoItem, redoItem]])
        ax.add(undoItem, role: kAXMenuItemRole, title: "Undo",
               extra: [kAXMenuItemCmdCharAttribute: "Z", kAXMenuItemCmdModifiersAttribute: 0, kAXEnabledAttribute: false])
        ax.add(redoItem, role: kAXMenuItemRole, title: "Redo",
               extra: [kAXMenuItemCmdCharAttribute: "Z", kAXMenuItemCmdModifiersAttribute: 1, kAXEnabledAttribute: false])
        ax.setActions(undoItem, [kAXPressAction])
        ax.setActions(redoItem, [kAXPressAction])
    }

    func testUndoThroughTheEditItemIsVerifiedByTheValue() async throws {
        world(value: "copy me")
        editMenu()
        ax.onPerform = { [unowned self] what in
            if what == "\(token(undoItem)):\(kAXPressAction)" { ax.put(field, [kAXValueAttribute: "old"]) }
        }
        let r = try await key("cmd+z")
        XCTAssertTrue(r.detail?.contains("Edit › Undo and the field changed") ?? false, r.detail ?? "")
        XCTAssertTrue(poster.keyDowns.isEmpty)
    }

    func testAnUndoThatChangesNothingAsksForTheForegroundNeverASilentNoOp() async throws {
        world(value: "copy me")
        editMenu()  // pressing the unvalidated item does nothing
        for combo in ["cmd+z", "shift+cmd+z"] {
            do {
                try await key(combo)
                XCTFail("expected needs_foreground for \(combo)")
            } catch let e as CUError {
                XCTAssertEqual(e.code, "needs_foreground")
                XCTAssertTrue(e.message.contains("needs Web in front"), e.message)
            }
        }
        XCTAssertTrue(poster.keyDowns.isEmpty, "no key equivalent posted into the void")
    }

    func testWithTheForegroundAgreedUndoIsTheRealShortcut() async throws {
        world(value: "copy me")
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c",
            action: .key(CUKeyAction(combo: "cmd+z", into: target.refs.ref(for: AXIdentity(element: field)))),
            access: .full, allowForeground: true, privatePath: false))
        XCTAssertTrue(sys.activated.contains(pid), "brought forward for it (with consent)")
        XCTAssertTrue(poster.keyDowns.first?.flags.contains(.maskCommand) ?? false)
    }
}
