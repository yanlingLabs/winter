import XCTest
@testable import Winter

@MainActor
final class ScaffoldTests: XCTestCase {
    func testBootInstallsMenuBar() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        XCTAssertNotNil(delegate.menuBar)
    }

    func testActivationPolicyIsAccessory() {
        // Info.plist declares LSUIElement; the delegate enforces .accessory at launch.
        // Under the test host the app has already launched:
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
    }
}
