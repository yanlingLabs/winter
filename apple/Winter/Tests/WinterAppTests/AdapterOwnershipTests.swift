import XCTest
@testable import Winter

@MainActor
final class AdapterOwnershipTests: XCTestCase {
    func testControllerOwnsOneStableAdapter() {
        let session = SessionModel()
        let controller = OrbWindowController(session: session)
        let a = controller.fieldAdapter
        let b = controller.fieldAdapter
        XCTAssertTrue(a === b, "adapter must be a single stable instance both surfaces share")
    }
}
