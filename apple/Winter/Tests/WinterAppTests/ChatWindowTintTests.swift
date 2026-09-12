import XCTest
@testable import Winter

final class ChatWindowTintTests: XCTestCase {
    func testLightModeIsNearWhiteAtSpecOpacity() {
        let t = chatWindowTint(darkMode: false)
        XCTAssertGreaterThanOrEqual(t.white, 0.95)
        XCTAssertGreaterThanOrEqual(t.opacity, 0.92) // spec §1: ≥0.92, reads as solid
    }
    func testDarkModeIsGreyAtSpecOpacity() {
        let t = chatWindowTint(darkMode: true)
        XCTAssertLessThanOrEqual(t.white, 0.25)
        XCTAssertGreaterThanOrEqual(t.opacity, 0.92)
    }
}
