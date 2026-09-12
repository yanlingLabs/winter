import XCTest
@testable import Winter

final class ExchangeNavigationTests: XCTestCase {
    func testNilPlusOlderGoesToLastIndex() {
        XCTAssertEqual(navigateExchange(nil, direction: .older, count: 5), 4)
    }

    func testZeroPlusOlderClampsAtZero() {
        XCTAssertEqual(navigateExchange(0, direction: .older, count: 5), 0)
    }

    func testMidIndexPlusNewerAdvancesByOne() {
        XCTAssertEqual(navigateExchange(2, direction: .newer, count: 5), 3)
    }

    func testLastIndexPlusNewerReturnsToLive() {
        XCTAssertEqual(navigateExchange(4, direction: .newer, count: 5), nil)
    }

    func testNilPlusNewerStaysLive() {
        XCTAssertEqual(navigateExchange(nil, direction: .newer, count: 5), nil)
    }

    func testEmptyHistoryReturnsNilBothDirections() {
        XCTAssertEqual(navigateExchange(nil, direction: .older, count: 0), nil)
        XCTAssertEqual(navigateExchange(nil, direction: .newer, count: 0), nil)
    }

    // MARK: exchangeNavDirection (wave-5 gate item 4 addendum: page-flip convention replaces
    // the v1 music-player one — physical RIGHT = older/back, physical LEFT = newer/forward)

    func testPhysicalRightMapsToOlder() {
        XCTAssertEqual(exchangeNavDirection(for: .right), .older)
    }

    func testPhysicalLeftMapsToNewer() {
        XCTAssertEqual(exchangeNavDirection(for: .left), .newer)
    }

    // MARK: navigateFieldSwipe (wave-5 gate item 4: the composer hop beyond live/newest)

    func testInHistoryNavigationUnaffectedByComposerHop() {
        // showingDraft == false, ordinary history navigation — behaves exactly like
        // navigateExchange, composer never enters the picture.
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: 2, showingDraft: false, hasReply: true, direction: .newer, count: 5),
            .exchange(3)
        )
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: 0, showingDraft: false, hasReply: true, direction: .older, count: 5),
            nil // already oldest — no movement, no composer hop (only .newer-from-nil hops)
        )
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: 4, showingDraft: false, hasReply: true, direction: .newer, count: 5),
            .exchange(nil) // steps off the newest exchange back to the live view, not the composer
        )
    }

    func testNewerFromLiveHopsToComposer() {
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: nil, showingDraft: false, hasReply: true, direction: .newer, count: 5),
            .composer
        )
        // Even with no history at all — an empty session swiped "newer" still reaches the composer.
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: nil, showingDraft: false, hasReply: false, direction: .newer, count: 0),
            .composer
        )
    }

    func testOlderFromComposerReturnsToResponseWhenReplyExists() {
        XCTAssertEqual(
            navigateFieldSwipe(exchangeIndex: nil, showingDraft: true, hasReply: true, direction: .older, count: 5),
            .exchange(nil)
        )
    }

    func testOlderFromComposerIsNoOpWithoutAReply() {
        XCTAssertNil(
            navigateFieldSwipe(exchangeIndex: nil, showingDraft: true, hasReply: false, direction: .older, count: 5)
        )
    }

    func testNewerFromComposerIsNoOp() {
        // The composer is the far end — there's nothing further "newer" than it.
        XCTAssertNil(
            navigateFieldSwipe(exchangeIndex: nil, showingDraft: true, hasReply: true, direction: .newer, count: 5)
        )
    }
}
