import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// What the agent cursor is told, per act kind (WinterCUPresentation's DESIGN-cursor.md, "What the core
/// emits"), against fakes: the reticle before an act on a ref, the act's own event, captions before
/// consequential presses and menu commands, refusals at the attempted point, rung-4 foreground on/off around
/// the input, waits, and done on release.
final class CursorEventsTests: XCTestCase {
    struct Ev: Equatable, CustomStringConvertible {
        var kind: String
        var point: CGPoint
        var dragTo: CGPoint? = nil
        var frame: CGRect? = nil
        var text: String? = nil
        var count: Int? = nil
        var button: String? = nil
        var description: String {
            var s = "\(kind)@(\(Int(point.x)),\(Int(point.y)))"
            if let frame { s += " frame=\(frame)" }
            if let text { s += " text=\(text)" }
            if let count { s += " count=\(count)" }
            if let button { s += " button=\(button)" }
            if let dragTo { s += " to=(\(Int(dragTo.x)),\(Int(dragTo.y)))" }
            return s
        }
    }

    @MainActor final class Recorder: CUCoreEvents {
        var events: [Ev] = []
        var released = 0
        func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {}
        func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) { released += 1; events.append(Ev(kind: "<released>", point: .zero)) }
        func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                      frame: CGRect?, text: String?, count: Int?, button: String?) {
            events.append(Ev(kind: kind, point: point, dragTo: dragTo, frame: frame, text: text, count: count, button: button))
        }
        func targetLost(targetId: String, reason: String) {}
        func permissionsChanged(accessibility: Bool, screenRecording: Bool) {}
        func willSendEscape() {}
    }

    let pid: pid_t = 4646
    let window = fakeElement(80_001)
    let send = fakeElement(80_002)
    let ok = fakeElement(80_003)
    let field = fakeElement(80_004)
    let secure = fakeElement(80_005)
    let label = fakeElement(80_006)
    let menuOwner = fakeElement(80_007)

    let sendFrame = CGRect(x: 150, y: 250, width: 80, height: 24)     // centre (190, 262)
    let okFrame = CGRect(x: 300, y: 250, width: 60, height: 24)       // centre (330, 262)
    let fieldFrame = CGRect(x: 150, y: 150, width: 200, height: 24)   // centre (250, 162)
    let secureFrame = CGRect(x: 150, y: 200, width: 200, height: 24)  // centre (250, 212)
    let labelFrame = CGRect(x: 400, y: 400, width: 100, height: 20)   // centre (450, 410)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!
    var recorder: Recorder!

    @MainActor private func world(bundle: String = "com.example.app") {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 100, y: 100, width: 800, height: 600))
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.put(app, [kAXWindowsAttribute: [window]])
        ax.put(window, [kAXChildrenAttribute: [field, secure, send, ok, label]])
        ax.add(send, role: kAXButtonRole, title: "Send", frame: sendFrame)
        ax.setActions(send, [kAXPressAction])
        ax.add(ok, role: kAXButtonRole, title: "OK", frame: okFrame)
        ax.setActions(ok, [kAXPressAction, kAXShowMenuAction])
        ax.add(field, role: kAXTextFieldRole, frame: fieldFrame, extra: [kAXValueAttribute: "hello world"])
        ax.makeSettable(field, kAXValueAttribute)
        ax.makeSettable(field, kAXSelectedTextAttribute)
        ax.makeSettable(field, kAXSelectedTextRangeAttribute)
        ax.add(secure, role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole, frame: secureFrame)
        ax.add(label, role: kAXStaticTextRole, title: "Readme", frame: labelFrame)
        ax.focus(pid: pid, on: field)

        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = bundle
        let win = FakeSystem.window(77, pid: pid, CGRect(x: 100, y: 100, width: 800, height: 600))
        sys.windows[77] = win
        sys.stack = [win]
        sys.front = 1

        poster = RecordingPoster()
        recorder = Recorder()
        core = CUCore(events: recorder, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundle, appName: "App", isChromium: false,
                          mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }
    private func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }

    /// Events reach the recorder on the main queue; one more main-queue turn delivers everything emitted so far.
    @MainActor private func drained() async -> [Ev] {
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
        defer { recorder.events.removeAll() }
        return recorder.events
    }

    @discardableResult
    private func act(_ a: CUAction, access: CUAccess = .full, foreground: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: access,
                                                 allowForeground: foreground, privatePath: true))
    }

    private func attempt(_ a: CUAction, access: CUAccess = .full) async {
        do { try await act(a, access: access) } catch {}
    }

    // MARK: presses

    @MainActor func testAConsequentialPressGetsACaptionThenTheReticleThenThePress() async throws {
        world()
        try await act(.click(CUClickAction(ref: ref(send))))
        let c = center(sendFrame)
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "caption", point: c, text: "Clicking “Send”"),
            Ev(kind: "target", point: c, frame: sendFrame),
            Ev(kind: "press", point: c, count: 1, button: "left"),
        ], "\(events)")
    }

    @MainActor func testARoutinePressHasNoCaption() async throws {
        world()
        try await act(.click(CUClickAction(ref: ref(ok))))
        let c = center(okFrame)
        let events = await drained()
        XCTAssertEqual(events, [Ev(kind: "target", point: c, frame: okFrame), Ev(kind: "press", point: c, count: 1, button: "left")])
    }

    @MainActor func testRightAndDoubleClicksCarryTheirButtonAndCount() async throws {
        world()
        try await act(.click(CUClickAction(ref: ref(ok), button: .right)))
        try await act(.click(CUClickAction(ref: ref(label), count: 2)))
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "target", point: center(okFrame), frame: okFrame),
            Ev(kind: "press", point: center(okFrame), count: 1, button: "right"),
            Ev(kind: "target", point: center(labelFrame), frame: labelFrame),
            Ev(kind: "press", point: center(labelFrame), count: 2, button: "left"),
        ], "\(events)")
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseDown }.count, 2, "the double click went out as events")
    }

    @MainActor func testAnAXActionIsAPressAndShowMenuIsARightClick() async throws {
        world()
        try await act(.action(CUAXAction(ref: ref(ok), name: "show menu")))
        try await act(.action(CUAXAction(ref: ref(send), name: "press")))
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "target", point: center(okFrame), frame: okFrame),
            Ev(kind: "press", point: center(okFrame), count: 1, button: "right"),
            Ev(kind: "caption", point: center(sendFrame), text: "Clicking “Send”"),
            Ev(kind: "target", point: center(sendFrame), frame: sendFrame),
            Ev(kind: "press", point: center(sendFrame), count: 1, button: "left"),
        ], "\(events)")
    }

    @MainActor func testAPressThatFallsBackToEventsIsShownOnce() async throws {
        world()
        ax.performError = CUError.unsupported("no")
        try await act(.click(CUClickAction(ref: ref(ok))))
        let events = await drained()
        XCTAssertEqual(events.map(\.kind), ["target", "press"])
        XCTAssertEqual(poster.entries.map(\.type), [.leftMouseDown, .leftMouseUp])
    }

    // MARK: text and keys

    @MainActor func testTextActsAreTypeAfterTheReticle() async throws {
        world()
        let c = center(fieldFrame)
        try await act(.setValue(CUSetValueAction(ref: ref(field), value: "x")))
        try await act(.type(CUTypeAction(text: "abc", into: ref(field))))
        try await act(.type(CUTypeAction(text: "abc")))
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "target", point: c, frame: fieldFrame), Ev(kind: "type", point: c),
            Ev(kind: "target", point: c, frame: fieldFrame), Ev(kind: "type", point: c),
            Ev(kind: "type", point: c),
        ], "\(events)")
    }

    @MainActor func testPasteIsTypeAndAKeyCarriesItsCombo() async throws {
        world()
        poster.onPost = { [unowned self] e in
            if e.type == .keyDown, e.keycode == 9 { ax.put(field, [kAXValueAttribute: "hello world pasted"]) }
        }
        try await act(.paste(CUPasteAction(text: " pasted")))
        try await act(.key(CUKeyAction(combo: "cmd+s")))
        let c = center(fieldFrame)
        let events = await drained()
        XCTAssertEqual(events, [Ev(kind: "type", point: c), Ev(kind: "key", point: c, text: "cmd+s")], "\(events)")
    }

    // MARK: scroll, drag, select, menu

    @MainActor func testScrollAndDragCarryTheirDirectionAndEnd() async throws {
        world()
        try await act(.scroll(CUScrollAction(ref: ref(label), direction: .down)))
        try await act(.drag(CUDragAction(from: CUDragEnd(ref: ref(label)), to: CUDragEnd(ref: ref(ok)))))
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "target", point: center(labelFrame), frame: labelFrame),
            Ev(kind: "scroll", point: center(labelFrame), text: "down"),
            Ev(kind: "target", point: center(labelFrame), frame: labelFrame),
            Ev(kind: "drag", point: center(labelFrame), dragTo: center(okFrame)),
        ], "\(events)")
    }

    @MainActor func testSelectIsAPress() async throws {
        world()
        try await act(.select(CUSelectAction(ref: ref(field), text: "world")))
        let c = center(fieldFrame)
        let events = await drained()
        XCTAssertEqual(events, [Ev(kind: "target", point: c, frame: fieldFrame), Ev(kind: "press", point: c, count: 1, button: "left")])
    }

    @MainActor func testAMenuCommandIsACaptionOnly() async throws {
        world()
        let bar = fakeElement(80_020), fileItem = fakeElement(80_021), fileMenu = fakeElement(80_022), export = fakeElement(80_023)
        let appleItem = fakeElement(80_024)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [appleItem, fileItem]])
        ax.add(appleItem, role: "AXMenuBarItem", title: "Apple")
        ax.add(fileItem, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [fileMenu]])
        ax.add(fileMenu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [export]])
        ax.add(export, role: kAXMenuItemRole, title: "Export…")
        ax.setActions(export, [kAXPressAction])
        try await act(.menu(CUMenuAction(path: ["File", "Export…"])))
        let events = await drained()
        XCTAssertEqual(events, [Ev(kind: "caption", point: CGPoint(x: 500, y: 400), text: "Choosing File › Export…")],
                       "no press, and the window's centre while the cursor has no place yet: \(events)")
    }

    // MARK: refusals

    @MainActor func testARefusedActIsShownWhereItWasAimed() async throws {
        world()
        await attempt(.type(CUTypeAction(text: "x", into: ref(secure))))
        await attempt(.click(CUClickAction(ref: ref(ok))), access: .click)  // fine under click-only
        await attempt(.type(CUTypeAction(text: "x")), access: .click)        // not allowed: the last place
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "refused", point: center(secureFrame)),
            Ev(kind: "target", point: center(okFrame), frame: okFrame),
            Ev(kind: "press", point: center(okFrame), count: 1, button: "left"),
            Ev(kind: "refused", point: center(okFrame)),
        ], "\(events)")
    }

    @MainActor func testACancelIsNotARefusal() async throws {
        world()
        core.cancels.cancel("c")
        await attempt(.click(CUClickAction(ref: ref(ok))))
        let events = await drained()
        XCTAssertTrue(events.isEmpty, "\(events)")
    }

    // MARK: foreground

    @MainActor func testRung4InputIsWrappedInForegroundAtTheRealPointer() async throws {
        world(bundle: "org.blenderfoundation.blender")
        try await act(.click(CUClickAction(ref: ref(label))), foreground: true)
        let real = CGPoint(x: 5, y: 5)  // FakeSystem's pointer, put back after the act
        let events = await drained()
        XCTAssertEqual(events, [
            Ev(kind: "target", point: center(labelFrame), frame: labelFrame),
            Ev(kind: "foreground", point: real, text: "on"),
            Ev(kind: "press", point: center(labelFrame), count: 1, button: "left"),
            Ev(kind: "foreground", point: real, text: "off"),
        ], "\(events)")
        // The resting place stays the agent's own, not the real pointer's.
        XCTAssertEqual(target.cursorPoint, center(labelFrame))
    }

    // MARK: waits and release

    @MainActor func testWaitsBeginAndEndAndReleaseIsDone() async throws {
        world()
        try await act(.click(CUClickAction(ref: ref(ok))))
        _ = try await core.targetWaitIdle(TargetWaitIdleParams(targetId: "t1", quietMs: 0, timeoutMs: 30))
        _ = try await core.targetRelease(TargetReleaseParams(targetId: "t1"))
        let c = center(okFrame)
        let events = await drained()
        XCTAssertEqual(Array(events.dropFirst(2)), [
            Ev(kind: "waitBegin", point: c), Ev(kind: "waitEnd", point: c),
            Ev(kind: "done", point: c), Ev(kind: "<released>", point: .zero),
        ], "\(events)")
    }

    func testWaitLabels() {
        XCTAssertEqual(CUCore.waitLabel(CUWaitCondition(text: "Saved")), "Saved")
        XCTAssertEqual(CUCore.waitLabel(CUWaitCondition(title: "Export")), "Export")
        XCTAssertNil(CUCore.waitLabel(CUWaitCondition(ref: 4)))
        XCTAssertNil(CUCore.waitLabel(CUWaitCondition(gone: .text("Loading"))), "waiting for something to leave is unlabelled")
        XCTAssertEqual(CUCore.waitLabel(CUWaitCondition(text: String(repeating: "a", count: 50)))?.count, 32)
    }

    func testCaptionsAreShortAndOnlyForConsequentialWords() {
        XCTAssertEqual(CUCore.caption("Clicking", "“Save”"), "Clicking “Save”")
        let long = CUCore.caption("Clicking", "“Send this very long message to everyone in the team”")
        XCTAssertLessThanOrEqual(long.count, 40)
        XCTAssertTrue(long.hasPrefix("Clicking “Send this") && long.hasSuffix("…”"), long)
        func info(_ title: String?, _ description: String? = nil) -> ElementInfo {
            let e = fakeElement(80_100)
            let ax = FakeAX()
            ax.add(e, role: kAXButtonRole, title: title, extra: description.map { [kAXDescriptionAttribute: $0] } ?? [:])
            return ElementInfo(e, ax)
        }
        for t in ["Send", "Delete", "Save As…", "Submit order", "Buy now", "Pay", "Publish", "Post", "Don't Save"] {
            XCTAssertEqual(CUCore.consequentialLabel(info(t)), t, t)
        }
        for t in ["OK", "Posts", "Sending options", "Cancel", "Saved items"] {
            XCTAssertNil(CUCore.consequentialLabel(info(t)), t)
        }
        XCTAssertEqual(CUCore.consequentialLabel(info(nil, "Delete")), "Delete", "the description when there is no title")
    }
}
