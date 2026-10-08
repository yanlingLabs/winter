import XCTest
@testable import Winter

/// The Computer Use page's desktop-switching hint: how the Dock's preference is read (absent, 0 and 1), that it is
/// only ever read, and that the page's model re-reads it on demand.
@MainActor
final class DockSpaceSwitchingTests: XCTestCase {
    func testAbsentAndOneAreOnAndZeroIsOff() {
        XCTAssertTrue(DockSpaceSwitching.isOn(nil), "absent is the system default: on")
        XCTAssertTrue(DockSpaceSwitching.isOn(NSNumber(value: 1)))
        XCTAssertTrue(DockSpaceSwitching.isOn(true as NSNumber))
        XCTAssertFalse(DockSpaceSwitching.isOn(NSNumber(value: 0)))
        XCTAssertFalse(DockSpaceSwitching.isOn(false as NSNumber))
        XCTAssertFalse(DockSpaceSwitching.isOn("0"))
        XCTAssertFalse(DockSpaceSwitching.isOn("false"))
        XCTAssertTrue(DockSpaceSwitching.isOn("1"))
        XCTAssertTrue(DockSpaceSwitching.isOn(["something": "else"]), "an unrecognisable value reads as the default")
    }

    func testItReadsTheDocksPreferenceByItsNameAndDomain() {
        var asked: [(String, String)] = []
        XCTAssertTrue(DockSpaceSwitching.read { key, domain in asked.append((key, domain)); return nil })
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(asked.first?.0, "workspaces-auto-swoosh")
        XCTAssertEqual(asked.first?.1, "com.apple.dock")
        XCTAssertFalse(DockSpaceSwitching.read { _, _ in NSNumber(value: 0) })
        XCTAssertTrue(DockSpaceSwitching.read { _, _ in NSNumber(value: 1) })
    }

    func testTheRealPreferenceReadsWithoutWritingAnything() {
        // Whatever this Mac has, it is a plain read of an existing key; nothing here writes.
        _ = DockSpaceSwitching.read()
        XCTAssertEqual(DockSpaceSwitching.settingsURL.absoluteString, "x-apple.systempreferences:com.apple.Desktop-Settings.extension")
    }

    func testTheHintIsTheAgreedTextAndPromisesOnlyWhatTheUserCanCheck() {
        XCTAssertEqual(DockSpaceSwitching.hint,
                       "Apps that bring themselves forward (for example Safari when the agent clicks its address bar) can switch your desktop. "
                       + "Turning this off in Desktop & Dock keeps you where you are.")
        XCTAssertEqual(DockSpaceSwitching.openButtonTitle, "Open Desktop & Dock")
    }

    func testThePagesModelReadsOnCreationAndRereadsOnDemand() {
        var value = true
        var reads = 0
        let model = ComputerUseSettingsModel(client: nil, dockSetting: { reads += 1; return value })
        XCTAssertTrue(model.dockSwitchesSpaces)
        XCTAssertEqual(reads, 1)
        value = false // the user turned it off in System Settings and came back
        model.refreshDockSetting()
        XCTAssertFalse(model.dockSwitchesSpaces)
        XCTAssertEqual(reads, 2)
        var publishes = 0
        let watch = model.objectWillChange.sink { publishes += 1 }
        model.refreshDockSetting()
        XCTAssertEqual(publishes, 0, "an unchanged setting publishes nothing")
        value = true
        model.refreshDockSetting()
        XCTAssertTrue(model.dockSwitchesSpaces)
        XCTAssertEqual(publishes, 1)
        withExtendedLifetime(watch) {}
    }
}
