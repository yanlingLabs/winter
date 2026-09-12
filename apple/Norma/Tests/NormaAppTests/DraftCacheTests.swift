import XCTest
@testable import Winter

final class DraftCacheTests: XCTestCase {
    func testStashRestoreRoundTrip() {
        let c = DraftCache()
        c.stash("half-typed thought")
        XCTAssertEqual(c.restore(), "half-typed thought")
    }
    func testBlankIsNotStashed() {
        let c = DraftCache()
        c.stash("   \n")
        XCTAssertNil(c.restore())
    }
    func testExpiry() {
        let c = DraftCache(now: { Date(timeIntervalSince1970: 0) })
        c.stash("old")
        c.nowOverride = { Date(timeIntervalSince1970: 901) }
        XCTAssertNil(c.restore())
    }
    func testClear() {
        let c = DraftCache()
        c.stash("x")
        c.clear()
        XCTAssertNil(c.restore())
    }
}
