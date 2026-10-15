#if canImport(AppKit)
import XCTest
import AppKit
@testable import WinterKit

/// Headless: an `NSTextView` in an offscreen `NSWindow` (the window is what supplies its undo
/// manager). No `NSApplication`, no app, no daemon.
@MainActor final class ModelDrivenTextTests: XCTestCase {
    private func makeEditor() -> (NSTextView, NSWindow) {
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 300, height: 200)
        let textView = scroll.documentView as! NSTextView
        textView.allowsUndo = true
        textView.isRichText = false
        let window = NSWindow(contentRect: scroll.frame, styleMask: [.titled], backing: .buffered, defer: true)
        // A programmatically created window releases itself on close(); ARC must be the only owner.
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        return (textView, window)
    }
    /// The person typing: through the text system, so the edit is registered for undo.
    private func type(_ text: String, at location: Int, in textView: NSTextView) {
        let range = NSRange(location: location, length: 0)
        guard textView.shouldChangeText(in: range, replacementString: text) else { return XCTFail("typing was refused") }
        textView.textStorage?.replaceCharacters(in: range, with: text)
        textView.didChangeText()
    }

    func testReplacingTheTextDropsUndoEntriesThatPointIntoTheTextThatIsGone() throws {
        let (textView, window) = makeEditor(); defer { window.close() }
        XCTAssertTrue(textView.replaceTextFromModel("short"))
        type(" and then a long run the person typed", at: 5, in: textView)
        let undo = try XCTUnwrap(textView.undoManager)
        XCTAssertTrue(undo.canUndo, "typing must register undo, or this test proves nothing")
        XCTAssertTrue(textView.replaceTextFromModel("x"))
        XCTAssertEqual(textView.string, "x")
        // Calling undo with the stale entry still on the stack raises NSRangeException and ends the
        // process, so a regression must fail here first rather than inside undo().
        XCTAssertFalse(undo.canUndo)
        XCTAssertFalse(undo.canRedo)
        if !undo.canUndo { undo.undo() }
        XCTAssertEqual(textView.string, "x")
    }

    func testTypingAfterAReplacementIsUndoableAgain() throws {
        let (textView, window) = makeEditor(); defer { window.close() }
        textView.replaceTextFromModel("first version of the shared text")
        textView.replaceTextFromModel("x")
        type("yz", at: 1, in: textView)
        let undo = try XCTUnwrap(textView.undoManager)
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertEqual(textView.string, "x")
    }

    func testTheModelEchoingTheUsersOwnTypingKeepsItsUndoHistory() throws {
        let (textView, window) = makeEditor(); defer { window.close() }
        textView.replaceTextFromModel("short")
        type(" typed", at: 5, in: textView)
        // The binding hands the typed text back to the model and the model hands it to the editor.
        XCTAssertFalse(textView.replaceTextFromModel(textView.string))
        let undo = try XCTUnwrap(textView.undoManager)
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertEqual(textView.string, "short")
    }

    func testCanonicallyEquivalentSpellingsAreDifferentBytesAndAreReplaced() {
        let (textView, window) = makeEditor(); defer { window.close() }
        textView.replaceTextFromModel("\u{e9}")
        XCTAssertTrue(textView.replaceTextFromModel("e\u{301}"))
        XCTAssertTrue(textView.string.utf8.elementsEqual("e\u{301}".utf8))
    }
}
#endif
