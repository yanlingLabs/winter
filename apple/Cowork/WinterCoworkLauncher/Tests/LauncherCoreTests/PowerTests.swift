import XCTest
@testable import LauncherCore

final class PowerTests: XCTestCase {
    func testSleepIsReportedThenAcknowledgedAndWakeIsReportedWithoutAnAcknowledgement() {
        XCTAssertEqual(PowerMessages.action(for: PowerMessages.systemWillSleep), PowerMessageAction(acknowledge: true, report: .willSleep))
        XCTAssertEqual(PowerMessages.action(for: PowerMessages.systemHasPoweredOn), PowerMessageAction(acknowledge: false, report: .didWake))
    }
    func testTheQuestionCanTheSystemSleepIsAlwaysAnsweredYesAndNeverReported() {
        XCTAssertEqual(PowerMessages.action(for: PowerMessages.canSystemSleep), PowerMessageAction(acknowledge: true, report: nil), "the launcher vetoes nothing")
    }
    func testOtherMessagesAreIgnored() {
        for message in [PowerMessages.systemWillNotSleep, PowerMessages.systemWillPowerOn, 0, 0xE000_0001, UInt32.max] { XCTAssertNil(PowerMessages.action(for: message), "\(message)") }
    }
    func testTheObserverRegistersAndDeregistersWithoutSleepingAnything() throws {
        let queue = DispatchQueue(label: "power-test")
        let observer = PowerObserver(queue: queue) { _ in }
        try observer.start()
        try observer.start() // idempotent
        observer.stop()
        observer.stop()
    }
    func testTheLedgerIsBoundedAndKeepsTheNewestEvents() {
        let ledger = PowerLedger(capacity: 3, clock: { 7 })
        for event in [PowerEvent.willSleep, .didWake, .willSleep, .didWake, .willSleep] { ledger.report(event) }
        XCTAssertEqual(ledger.recorded.map(\.event), [.willSleep, .didWake, .willSleep])
        XCTAssertTrue(ledger.recorded.allSatisfy { $0.atMs == 7 })
    }
}
