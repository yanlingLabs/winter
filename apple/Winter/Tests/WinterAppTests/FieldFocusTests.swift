import XCTest
@testable import Winter

final class FieldFocusTests: XCTestCase {
    func testUpAtFirstLineMovesToChevron() {
        let r = resolveFieldFocusKey(current: .composer, key: .up, caretAtFirstLine: true, caretAtLastLine: true)
        XCTAssertEqual(r, FieldFocusResolution(element: .expandChevron, consumed: true, activatesExpand: false))
    }
    func testUpMidTextStaysInComposerUnconsumed() {
        let r = resolveFieldFocusKey(current: .composer, key: .up, caretAtFirstLine: false, caretAtLastLine: false)
        XCTAssertEqual(r, FieldFocusResolution(element: .composer, consumed: false, activatesExpand: false))
    }
    func testDownFromChevronReturnsToComposer() {
        let r = resolveFieldFocusKey(current: .expandChevron, key: .down, caretAtFirstLine: true, caretAtLastLine: true)
        XCTAssertEqual(r, FieldFocusResolution(element: .composer, consumed: true, activatesExpand: false))
    }
    func testUpFromChevronStaysConsumed() {
        let r = resolveFieldFocusKey(current: .expandChevron, key: .up, caretAtFirstLine: true, caretAtLastLine: true)
        XCTAssertEqual(r, FieldFocusResolution(element: .expandChevron, consumed: true, activatesExpand: false))
    }
    func testEnterOnChevronActivatesExpand() {
        let r = resolveFieldFocusKey(current: .expandChevron, key: .enter, caretAtFirstLine: true, caretAtLastLine: true)
        XCTAssertTrue(r.activatesExpand)
        XCTAssertTrue(r.consumed)
        XCTAssertEqual(r.element, .composer) // focus lands home for the window round-trip
    }
    func testEnterOnComposerUnconsumed() { // composer Enter = submit path, not focus path
        let r = resolveFieldFocusKey(current: .composer, key: .enter, caretAtFirstLine: true, caretAtLastLine: true)
        XCTAssertFalse(r.consumed)
    }
    func testDownAtLastLineStaysInComposer() { // nothing below the composer in the 2d-i chain
        let r = resolveFieldFocusKey(current: .composer, key: .down, caretAtFirstLine: false, caretAtLastLine: true)
        XCTAssertEqual(r, FieldFocusResolution(element: .composer, consumed: false, activatesExpand: false))
    }
}

final class CaretLineTests: XCTestCase {
    func testCaretBoundaries() {
        XCTAssertTrue(caretAtFirstLine(of: "hello\nworld", caretLocation: 3))
        XCTAssertFalse(caretAtFirstLine(of: "hello\nworld", caretLocation: 8))
        XCTAssertTrue(caretAtLastLine(of: "hello\nworld", caretLocation: 8))
        XCTAssertFalse(caretAtLastLine(of: "hello\nworld", caretLocation: 3))
        XCTAssertTrue(caretAtFirstLine(of: "", caretLocation: 0))
        XCTAssertTrue(caretAtLastLine(of: "", caretLocation: 0))
    }
}
