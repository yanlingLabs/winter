import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// The focus enforcer's pure core — the synthetic focus state, the activation event's fields, the CPS
/// theft-guard state machine, and the tap predicates — plus the wiring that calls it before keys. The live
/// taps and the SLSDisableUpdate bracket are exercised only by the gated live test.
final class FocusEnforcerTests: XCTestCase {
    // MARK: synthetic focus state

    func testActivationAndFocusAreSentOnlyForWhatTheAppDoesNotBelieve() {
        let neither = CUSyntheticFocusState(believesActive: false, believesFocus: false)
        XCTAssertTrue(neither.needsActivation); XCTAssertTrue(neither.needsFocus); XCTAssertTrue(neither.needsEnforcing)
        let activeOnly = CUSyntheticFocusState(believesActive: true, believesFocus: false)
        XCTAssertFalse(activeOnly.needsActivation); XCTAssertTrue(activeOnly.needsFocus)
        let focusOnly = CUSyntheticFocusState(believesActive: false, believesFocus: true)
        XCTAssertTrue(focusOnly.needsActivation); XCTAssertFalse(focusOnly.needsFocus)
        let both = CUSyntheticFocusState(believesActive: true, believesFocus: true)
        XCTAssertFalse(both.needsEnforcing)
        var s = CUSyntheticFocusState()
        s.markEnforced()
        XCTAssertFalse(s.needsEnforcing, "after enforcing, the app believes it is active and focused")
        XCTAssertFalse(s.isReallyActive, "its real front state is untouched")
    }

    // MARK: the activation event

    func testTheActivationEventCarriesTheWindowAndItsFlags() {
        let withWindow = CUFocusEvents.activationFields(windowID: 77)
        XCTAssertEqual(withWindow, .init(type: 13, subtype: 1, flags: 0xc0000, windowNumber: 77))
        let none = CUFocusEvents.activationFields(windowID: 0)
        XCTAssertEqual(none, .init(type: 13, subtype: 1, flags: 0, windowNumber: 0))
        // The real events build (AppKit is present under test).
        XCTAssertNotNil(CUFocusEvents.appActivated(windowID: 77))
        let focus = CUFocusEvents.keyFocusReturnedEvent()
        XCTAssertEqual(focus?.type.rawValue, 21)
        XCTAssertEqual(focus?.getIntegerValueField(CGEventField(rawValue: 64)!), CUCPSSubtype.keyFocusReturned)
    }

    // MARK: the theft guard

    private func taken(subject: pid_t, theft: Int32 = 99) -> CUFocusNotification {
        CUFocusNotification(recipientPID: subject, subtype: CUCPSSubtype.keyFocusTaken, subjectPID: subject, theftID: theft)
    }

    func testAKeyFocusTheftFromAProtectedTargetIsRecordedAndReleased() {
        var g = CUFocusGuard()
        g.protect(500)
        // 500 holds focus; 800 steals it.
        _ = g.handle(CUFocusNotification(recipientPID: 500, subtype: 0, subjectPID: 500, theftID: 0))  // focus change → current = 500
        let v = g.handle(taken(subject: 800, theft: 71))
        XCTAssertEqual(v, .release(theftID: 71), "the theft is released by its own token, not a pid")
        XCTAssertEqual(g.suppression?.thiefPID, 800)
        XCTAssertEqual(g.suppression?.victimPID, 500)
        // The user's keys addressed to the thief go back to the victim; the helper's synthetic keys pass.
        XCTAssertEqual(g.reroute(targetPID: 800), 500)
        XCTAssertNil(g.reroute(targetPID: 500))
        XCTAssertEqual(CUFocusTaps.keyVerdict(sourcePID: 42, targetPID: 800, helperPID: 42, guard: g), .pass, "helper keys pass")
        XCTAssertEqual(CUFocusTaps.keyVerdict(sourcePID: 9, targetPID: 800, helperPID: 42, guard: g), .reroute(to: 500))
    }

    func testTheReturnEventIsDroppedExactlyOnce() {
        var g = CUFocusGuard()
        g.protect(500)
        _ = g.handle(CUFocusNotification(recipientPID: 500, subtype: 0, subjectPID: 500, theftID: 0))
        _ = g.handle(taken(subject: 800))
        let first = g.handle(CUFocusNotification(recipientPID: 500, subtype: CUCPSSubtype.keyFocusReturned, subjectPID: 800, theftID: 0))
        XCTAssertEqual(first, .drop, "the one return we caused is swallowed")
        let second = g.handle(CUFocusNotification(recipientPID: 500, subtype: CUCPSSubtype.keyFocusReturned, subjectPID: 800, theftID: 0))
        XCTAssertEqual(second, .pass, "a later genuine return passes")
    }

    func testNewFrontClearsTheSuppressionAndAnUnprotectedTargetIsLeftAlone() {
        var g = CUFocusGuard()
        g.protect(500)
        _ = g.handle(CUFocusNotification(recipientPID: 500, subtype: 0, subjectPID: 500, theftID: 0))
        _ = g.handle(taken(subject: 800))
        XCTAssertNotNil(g.suppression)
        XCTAssertEqual(g.handle(CUFocusNotification(recipientPID: 800, subtype: CUCPSSubtype.newFront, subjectPID: 800, theftID: 0)), .pass)
        XCTAssertNil(g.suppression)
        g.unprotect(500)
        XCTAssertTrue(g.isEmpty)
        XCTAssertEqual(g.handle(taken(subject: 800)), .pass, "no protected target: nothing to guard")
    }

    // MARK: tap predicates

    func testTheTapMasksMatchChatGPTsArrays() {
        XCTAssertEqual(CUFocusTaps.activationTypes, [13, 20, 19])
        XCTAssertEqual(CUFocusTaps.keyboardTypes, [10, 11, 12])
        XCTAssertEqual(CUFocusTaps.mouseTypes, [1, 2, 6, 3, 4, 7, 25, 26, 27])
        XCTAssertEqual(CUFocusTaps.processNotificationType, 21)
        XCTAssertEqual(CUFocusTaps.mask([13, 20, 19]), 0x182000, "the recovered activation mask")
        XCTAssertEqual(CUFocusTaps.mask([10, 11, 12]), 0x1c00)
        XCTAssertEqual(CUFocusTaps.mask([21]), 0x200000)
    }

    func testMenuDismissalDropsClicksOnAnotherProcessWindowOnly() {
        XCTAssertTrue(CUFocusTaps.dismissesMenu(windowOwnerPID: 9, targetPID: 500, menuPID: 600))
        XCTAssertFalse(CUFocusTaps.dismissesMenu(windowOwnerPID: 500, targetPID: 500, menuPID: 600), "the target's own window")
        XCTAssertFalse(CUFocusTaps.dismissesMenu(windowOwnerPID: 600, targetPID: 500, menuPID: 600), "the menu's window")
        XCTAssertFalse(CUFocusTaps.dismissesMenu(windowOwnerPID: nil, targetPID: 500, menuPID: 600), "unknown owner: never a guessed drop")
    }

    func testTheSuppressionPredicateDropsResignAndDeactivateNotReactivate() {
        XCTAssertTrue(CUFocusTaps.suppressesActivation(type: 19, appKitSubtype: 0), "app deactivated")
        XCTAssertTrue(CUFocusTaps.suppressesActivation(type: 13, appKitSubtype: 2), "app resigned active")
        XCTAssertTrue(CUFocusTaps.suppressesActivation(type: 13, appKitSubtype: 22), "window resigned key")
        XCTAssertTrue(CUFocusTaps.suppressesActivation(type: 13, appKitSubtype: 23), "window resigned main")
        XCTAssertFalse(CUFocusTaps.suppressesActivation(type: 13, appKitSubtype: 1), "app activated passes through")
        XCTAssertFalse(CUFocusTaps.suppressesActivation(type: 20, appKitSubtype: 0))
    }

    // MARK: the wiring

    let pid: pid_t = 6262
    let window = fakeElement(94_501)
    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!
    var enforcer: FakeFocusEnforcer!
    var field: AXUIElement!

    private func world() {
        ax = FakeAX()
        field = fakeElement(94_502)
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Docs", frame: CGRect(x: 0, y: 0, width: 800, height: 500),
               extra: [kAXChildrenAttribute: [field]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(field, role: kAXTextFieldRole, title: "Name", frame: CGRect(x: 20, y: 40, width: 200, height: 24),
               extra: [kAXValueAttribute: ""])
        ax.makeSettable(field, kAXFocusedAttribute)
        ax.focus(pid: pid, on: field)
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.apple.Notes"
        sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 500), owner: "Notes")
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { [unowned self] _ in enforcer }
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.apple.Notes", appName: "Notes",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Docs")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func act(_ a: CUAction, privatePath: Bool = true) async throws {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: a, access: .full,
                                                 allowForeground: false, privatePath: privatePath))
    }

    func testTheEnforcerRunsBeforeKeysAndIsReusedThenTornDown() async throws {
        world()
        try await act(.type(CUTypeAction(text: "ab", into: target.refs.ref(for: AXIdentity(element: field)))))
        try await act(.key(CUKeyAction(combo: "cmd+b")))
        XCTAssertEqual(enforcer.enforced, [77, 77], "one enforcer, reused across actions, run before each")
        XCTAssertEqual(enforcer.tornDown, 0)
        _ = try await core.targetRelease(TargetReleaseParams(targetId: "t1"))
        XCTAssertEqual(enforcer.tornDown, 1, "torn down when the target is released")
    }

    func testWithThePrivatePathOffThereIsNoEnforcer() async throws {
        world()
        try await act(.key(CUKeyAction(combo: "cmd+b")), privatePath: false)
        XCTAssertTrue(enforcer.enforced.isEmpty)
    }
}
