import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// A press the app answers with -25200 (kAXErrorFailure) or -25204 (no answer in time) may have acted — the live
/// fixture opened its document window and still answered "AXPress failed". Judged by what changed, never
/// repeated: a new window / value / focus → success with a note; nothing → "may have acted — check state()".
final class PressErrorTests: XCTestCase {
    let pid: pid_t = 4949
    let window = fakeElement(97_701)
    let button = fakeElement(97_702)
    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    static let failure = CUError(code: "unsupported", message: "AXPress failed (AXError -25200)",
                                 data: ["axError": .int(Int(AXError.failure.rawValue))])

    private func world() {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Fixture", frame: CGRect(x: 0, y: 0, width: 600, height: 400),
               extra: [kAXChildrenAttribute: [button]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(button, role: kAXButtonRole, title: "New Document", frame: CGRect(x: 20, y: 40, width: 120, height: 24),
               extra: [kAXParentAttribute: window])
        ax.setActions(button, [kAXPressAction])
        sys = FakeSystem()
        sys.running = [pid]
        sys.bundles[pid] = "com.example.fixture"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 600, height: 400), owner: "Fixture")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.fixture", appName: "Fixture",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Fixture")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func ref(_ e: AXUIElement) -> Int { target.refs.ref(for: AXIdentity(element: e)) }

    @discardableResult
    private func act(_ a: CUAction) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: true))
    }

    /// The press opens the document window, then the app answers with `error`.
    private func opensAWindowThenErrs(_ error: CUError) {
        ax.performErrorAfterActing = error
        ax.onPerform = { [unowned self] _ in
            sys.windows[78] = FakeSystem.window(78, pid: pid, CGRect(x: 40, y: 40, width: 600, height: 400), owner: "Fixture")
        }
    }

    func testAPressThatActedDespiteAXErrorFailureReportsSuccessAndIsNotRepeated() async throws {
        world()
        opensAWindowThenErrs(Self.failure)
        let r = try await act(.action(CUAXAction(ref: ref(button), name: "press")))
        XCTAssertEqual(ax.performed.count, 1, "pressed once")
        XCTAssertTrue(poster.entries.isEmpty, "no click to try again")
        XCTAssertTrue(r.detail?.contains("answered") ?? false, r.detail ?? "")
        XCTAssertTrue(r.detail?.contains("but it took effect — a new window opened; don't repeat it") ?? false, r.detail ?? "")
    }

    func testAPressThatChangedNothingSaysItMayHaveActed() async throws {
        world()
        ax.performErrorAfterActing = Self.failure
        do {
            try await act(.action(CUAXAction(ref: ref(button), name: "press")))
            XCTFail("expected an error")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "busy", "the app did not answer as it should")
            XCTAssertEqual(e.data?["uncertain"], .bool(true), "marked uncertain: never retried, reported as Uncertain")
            XCTAssertEqual(e.data?["retryable"], .bool(false))
            XCTAssertTrue(e.message.contains("may have acted — check state() before retrying"), e.message)
        }
        XCTAssertEqual(ax.performed.count, 1)
        XCTAssertTrue(poster.entries.isEmpty)
    }

    func testAClickByRefWhosePressTimedOutButActedIsNotFollowedByAClick() async throws {
        world()
        opensAWindowThenErrs(CUError.busy("AXPress: the app did not answer in time — retry"))
        let r = try await act(.click(CUClickAction(ref: ref(button))))
        XCTAssertEqual(ax.performed.count, 1)
        XCTAssertTrue(poster.entries.isEmpty, "the press acted: no fallback click at its centre")
        XCTAssertTrue(r.detail?.contains("AXError -25204") ?? false, r.detail ?? "")
    }

    func testAClickByRefWhosePressFailedWithoutEffectIsNotFollowedByAClickEither() async throws {
        world()
        ax.performErrorAfterActing = Self.failure
        do {
            try await act(.click(CUClickAction(ref: ref(button))))
            XCTFail("expected an error")
        } catch let e as CUError {
            XCTAssertEqual(e.data?["uncertain"], .bool(true))
            XCTAssertTrue(e.message.contains("may have acted"), e.message)
        }
        XCTAssertTrue(poster.entries.isEmpty, "a press that may have acted is never repeated as a click")
    }
}
