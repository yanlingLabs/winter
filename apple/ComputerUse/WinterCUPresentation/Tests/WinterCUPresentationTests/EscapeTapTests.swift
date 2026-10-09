import CoreGraphics
import XCTest
@testable import WinterCUPresentation

/// The stop key: arming, swallowing a user Escape once per press, the synthetic-Escape window, and a tap that can't be
/// created. No real event tap is ever installed here.
final class EscapeTapLogicTests: XCTestCase {
    let me: pid_t = 4242

    func down(autorepeat: Bool = false, modifiers: Bool = false, pid: pid_t = 0, key: Int64 = EscapeKeyEvent.escapeKeyCode) -> EscapeKeyEvent {
        EscapeKeyEvent(isKeyDown: true, keyCode: key, isAutorepeat: autorepeat, hasModifiers: modifiers, sourcePID: pid)
    }

    func up(pid: pid_t = 0) -> EscapeKeyEvent {
        EscapeKeyEvent(isKeyDown: false, keyCode: EscapeKeyEvent.escapeKeyCode, sourcePID: pid)
    }

    func armed() -> EscapeTapLogic {
        var l = EscapeTapLogic(ownPID: me, maxSyntheticWindow: 2)
        l.setArmed(true)
        return l
    }

    func testDisarmedLetsEverythingThrough() {
        var l = EscapeTapLogic(ownPID: me, maxSyntheticWindow: 2)
        XCTAssertEqual(l.decide(down(), now: 0), .pass)
        XCTAssertEqual(l.decide(up(), now: 0), .pass)
    }

    func testArmedSwallowsAPressFiresOnceAndTakesItsKeyUp() {
        var l = armed()
        XCTAssertEqual(l.decide(down(), now: 0), .swallowAndFire)
        XCTAssertEqual(l.decide(down(autorepeat: true), now: 0.5), .swallow)
        XCTAssertEqual(l.decide(down(autorepeat: true), now: 0.6), .swallow)
        XCTAssertEqual(l.decide(up(), now: 0.7), .swallow)
        // A stray key-up with no press of ours passes.
        XCTAssertEqual(l.decide(up(), now: 0.8), .pass)
        // The next press fires again.
        XCTAssertEqual(l.decide(down(), now: 1), .swallowAndFire)
    }

    func testANewPressFiresEvenWhenTheLastKeyUpWasMissed() {
        var l = armed()
        XCTAssertEqual(l.decide(down(), now: 0), .swallowAndFire)
        // The key-up never reached the tap (a tap timeout in between). The next real press must still stop the script.
        XCTAssertEqual(l.decide(down(), now: 3), .swallowAndFire)
        XCTAssertEqual(l.decide(down(autorepeat: true), now: 3.5), .swallow, "only autorepeats are silent")
        XCTAssertEqual(l.decide(up(), now: 3.6), .swallow)
        XCTAssertEqual(l.decide(up(), now: 3.7), .pass)
    }

    func testOtherKeysAndChordsPass() {
        var l = armed()
        XCTAssertEqual(l.decide(down(key: 36), now: 0), .pass) // Return
        XCTAssertEqual(l.decide(down(modifiers: true), now: 0), .pass) // cmd+esc and friends
    }

    func testSyntheticWindowLetsEscapeThroughThenCloses() {
        var l = armed()
        l.expectSynthetic(for: 0.5, now: 10)
        XCTAssertEqual(l.decide(down(), now: 10.3), .pass)
        XCTAssertEqual(l.decide(up(), now: 10.35), .pass)
        XCTAssertEqual(l.decide(down(), now: 10.6), .swallowAndFire)
    }

    func testSyntheticWindowIsClampedAndOnlyEverExtended() {
        var l = armed()
        l.expectSynthetic(for: 60, now: 0)
        XCTAssertTrue(l.isInSyntheticWindow(now: 1.9))
        XCTAssertFalse(l.isInSyntheticWindow(now: 2.0), "clamped to the 2 s maximum")

        var m = armed()
        m.expectSynthetic(for: 1.5, now: 0)
        m.expectSynthetic(for: 0.2, now: 1) // ends at 1.2, earlier than 1.5: no change
        XCTAssertTrue(m.isInSyntheticWindow(now: 1.4))
        m.expectSynthetic(for: 1, now: 1) // ends at 2: extends
        XCTAssertTrue(m.isInSyntheticWindow(now: 1.9))
    }

    func testNonsenseWindowsAreIgnored() {
        var l = armed()
        l.expectSynthetic(for: 0, now: 0)
        l.expectSynthetic(for: -3, now: 0)
        l.expectSynthetic(for: .infinity, now: 0)
        l.expectSynthetic(for: .nan, now: 0)
        XCTAssertFalse(l.isInSyntheticWindow(now: 0))
    }

    func testOwnSyntheticEscapesAlwaysPass() {
        var l = armed()
        XCTAssertEqual(l.decide(down(pid: me), now: 0), .pass)
        XCTAssertEqual(l.decide(up(pid: me), now: 0), .pass)
        // Another process's synthetic Escape is treated like the user's.
        XCTAssertEqual(l.decide(down(pid: 999), now: 0), .swallowAndFire)
    }

    func testDisarmingForgetsAHeldPress() {
        var l = armed()
        XCTAssertEqual(l.decide(down(), now: 0), .swallowAndFire)
        l.setArmed(false)
        XCTAssertEqual(l.decide(up(), now: 0.1), .pass)
    }
}

@MainActor final class EscapeTapTests: XCTestCase {
    final class FakeHandle: EscapeTapHandle {
        var enabled: [Bool] = []
        func setEnabled(_ on: Bool) { enabled.append(on) }
    }

    final class FakeInstaller: EscapeTapInstaller {
        var succeed = false
        var attempts = 0
        var handle = FakeHandle()
        var handler: (@MainActor (EscapeKeyEvent) -> Bool)?

        func install(handler: @escaping @MainActor (EscapeKeyEvent) -> Bool) -> EscapeTapHandle? {
            attempts += 1
            guard succeed else { return nil }
            self.handler = handler
            return handle
        }
    }

    final class FakeClock: CUClock { var now: TimeInterval = 0 }

    func testATapThatCannotBeCreatedIsANoOpThatLogsOnceAndRetriesLater() {
        let installer = FakeInstaller()
        var logs: [String] = []
        let tap = EscapeTap(installer: installer, clock: FakeClock(), ownPID: 1, log: { logs.append($0) })
        tap.setArmed(true)
        tap.setArmed(true)
        tap.setArmed(false)
        tap.setArmed(true)
        XCTAssertEqual(logs.count, 1)
        XCTAssertFalse(tap.isActive)
        XCTAssertEqual(installer.attempts, 3, "every arm retries: Accessibility may have been granted since")

        installer.succeed = true
        tap.setArmed(true)
        XCTAssertTrue(tap.isActive)
        XCTAssertEqual(installer.handle.enabled, [true])
        XCTAssertEqual(logs.count, 1)
    }

    func testArmedTapSwallowsAndReportsDisarmedTapIsSwitchedOff() {
        let installer = FakeInstaller()
        installer.succeed = true
        let tap = EscapeTap(installer: installer, clock: FakeClock(), ownPID: 1, log: { _ in })
        let fired = expectation(description: "onEscape")
        tap.onEscape = { fired.fulfill() }
        tap.setArmed(true)
        let press = EscapeKeyEvent(isKeyDown: true, keyCode: EscapeKeyEvent.escapeKeyCode)
        XCTAssertEqual(installer.handler?(press), true)
        wait(for: [fired], timeout: 1)

        tap.setArmed(false)
        XCTAssertEqual(installer.handle.enabled, [true, false])
        XCTAssertEqual(installer.handler?(press), false)
        XCTAssertEqual(installer.attempts, 1, "the tap is created once and reused")
    }

    func testSecureEventInputIsReadableThroughTheProtocol() {
        var secure = false
        let tap: CUEscapeTap = EscapeTap(installer: FakeInstaller(), clock: FakeClock(), ownPID: 1,
                                         secureInputProbe: { secure }, log: { _ in })
        XCTAssertFalse(tap.isSecureEventInputEnabled)
        secure = true
        XCTAssertTrue(tap.isSecureEventInputEnabled, "read fresh on every access")
    }

    func testExpectSyntheticEscapeUsesTheClock() {
        let installer = FakeInstaller()
        installer.succeed = true
        let clock = FakeClock()
        clock.now = 50
        let tap = EscapeTap(installer: installer, clock: clock, ownPID: 1, log: { _ in })
        var fires = 0
        tap.onEscape = { fires += 1 }
        tap.setArmed(true)
        tap.expectSyntheticEscape(for: 0.3)
        let press = EscapeKeyEvent(isKeyDown: true, keyCode: EscapeKeyEvent.escapeKeyCode)
        let release = EscapeKeyEvent(isKeyDown: false, keyCode: EscapeKeyEvent.escapeKeyCode)
        clock.now = 50.2
        XCTAssertEqual(installer.handler?(press), false, "inside the window: the helper's own Escape goes through")
        XCTAssertEqual(installer.handler?(release), false)
        clock.now = 50.4
        XCTAssertEqual(installer.handler?(press), true)
        let drained = expectation(description: "main queue drained")
        DispatchQueue.main.async { drained.fulfill() }
        wait(for: [drained], timeout: 1)
        XCTAssertEqual(fires, 1)
    }
}
