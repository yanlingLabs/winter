#if canImport(AppKit)
import XCTest
import AppKit
@testable import WinterKit

/// Headless: text views in an offscreen `NSWindow` (the window is what supplies a stock text view's
/// undo manager). No `NSApplication`, no app, no daemon.
@MainActor final class ModelDrivenTextTests: XCTestCase {
    private struct Rig {
        let window: NSWindow
        /// The guidance editor: private undo history.
        let editor: ScopedUndoTextView
        /// Any other text control in the same window: stock, so it uses the window's shared manager.
        let other: NSTextView
    }
    private func makeRig() -> Rig {
        let (editorScroll, editor) = ScopedUndoTextView.makeScrollable()
        editor.allowsUndo = true
        let otherScroll = NSTextView.scrollableTextView()
        let other = otherScroll.documentView as! NSTextView
        other.allowsUndo = true
        editorScroll.frame = NSRect(x: 0, y: 0, width: 300, height: 100)
        otherScroll.frame = NSRect(x: 0, y: 100, width: 300, height: 100)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        content.addSubview(editorScroll); content.addSubview(otherScroll)
        let window = NSWindow(contentRect: content.frame, styleMask: [.titled], backing: .buffered, defer: true)
        // A programmatically created window releases itself on close(); ARC must be the only owner.
        window.isReleasedWhenClosed = false
        window.contentView = content
        return Rig(window: window, editor: editor, other: other)
    }
    /// The person typing: through the text system, so the edit is registered for undo.
    private func type(_ text: String, at location: Int, in textView: NSTextView) {
        let range = NSRange(location: location, length: 0)
        guard textView.shouldChangeText(in: range, replacementString: text) else { return XCTFail("typing was refused") }
        textView.textStorage?.replaceCharacters(in: range, with: text)
        textView.didChangeText()
    }
    private let undo = Selector(("undo:")), redo = Selector(("redo:"))

    func testReplacingTheTextDropsUndoEntriesThatPointIntoTheTextThatIsGone() throws {
        let rig = makeRig(); defer { rig.window.close() }
        XCTAssertTrue(rig.editor.replaceTextFromModel("short"))
        type(" and then a long run the person typed", at: 5, in: rig.editor)
        let undoManager = try XCTUnwrap(rig.editor.undoManager)
        XCTAssertTrue(undoManager.canUndo, "typing must register undo, or this test proves nothing")
        XCTAssertTrue(rig.editor.replaceTextFromModel("x"))
        XCTAssertEqual(rig.editor.string, "x")
        // Calling undo with the stale entry still on the stack raises NSRangeException and ends the
        // process, so a regression must fail here first rather than inside undo().
        XCTAssertFalse(undoManager.canUndo)
        XCTAssertFalse(undoManager.canRedo)
        if !undoManager.canUndo { undoManager.undo() }
        XCTAssertEqual(rig.editor.string, "x")
    }

    func testTypingAfterAReplacementIsUndoableAgain() throws {
        let rig = makeRig(); defer { rig.window.close() }
        rig.editor.replaceTextFromModel("first version of the shared text")
        rig.editor.replaceTextFromModel("x")
        type("yz", at: 1, in: rig.editor)
        let undoManager = try XCTUnwrap(rig.editor.undoManager)
        XCTAssertTrue(undoManager.canUndo)
        undoManager.undo()
        XCTAssertEqual(rig.editor.string, "x")
    }

    func testTheModelEchoingTheUsersOwnTypingKeepsItsUndoHistory() throws {
        let rig = makeRig(); defer { rig.window.close() }
        rig.editor.replaceTextFromModel("short")
        type(" typed", at: 5, in: rig.editor)
        // The binding hands the typed text back to the model and the model hands it to the editor.
        XCTAssertFalse(rig.editor.replaceTextFromModel(rig.editor.string))
        let undoManager = try XCTUnwrap(rig.editor.undoManager)
        XCTAssertTrue(undoManager.canUndo)
        undoManager.undo()
        XCTAssertEqual(rig.editor.string, "short")
    }

    func testCanonicallyEquivalentSpellingsAreDifferentBytesAndAreReplaced() {
        let rig = makeRig(); defer { rig.window.close() }
        rig.editor.replaceTextFromModel("\u{e9}")
        XCTAssertTrue(rig.editor.replaceTextFromModel("e\u{301}"))
        XCTAssertTrue(rig.editor.string.utf8.elementsEqual("e\u{301}".utf8))
    }

    // MARK: - The undo history is the editor's own

    func testAGuidanceReplacementLeavesAnotherTextControlsUndoHistoryAlone() throws {
        let rig = makeRig(); defer { rig.window.close() }
        let windowManager = try XCTUnwrap(rig.window.undoManager)
        rig.other.string = "composer"
        type(" draft", at: 8, in: rig.other)
        XCTAssertTrue(windowManager.canUndo, "the other control must register on the window's manager, or this test proves nothing")
        // The editor has history of its own, then the model replaces its text (a background refresh).
        rig.editor.replaceTextFromModel("shared text")
        type(" typed", at: 11, in: rig.editor)
        XCTAssertTrue(rig.editor.replaceTextFromModel("new shared text"))
        XCTAssertTrue(windowManager.canUndo, "a guidance replacement wiped another control's undo history")
        // And it still works: undoing from the other control reverts ITS typing.
        XCTAssertTrue(rig.other.tryToPerform(undo, with: nil))
        XCTAssertEqual(rig.other.string, "composer")
        XCTAssertEqual(rig.editor.string, "new shared text")
    }

    func testTheEditorsTypingNeverLandsOnTheWindowsSharedStack() throws {
        let rig = makeRig(); defer { rig.window.close() }
        let windowManager = try XCTUnwrap(rig.window.undoManager)
        XCTAssertFalse(rig.editor.undoManager === windowManager)
        rig.editor.replaceTextFromModel("shared text")
        type(" typed", at: 11, in: rig.editor)
        XCTAssertTrue(rig.editor.undoManager?.canUndo ?? false)
        XCTAssertFalse(windowManager.canUndo, "the editor's edits must not share the window's stack")
    }

    // MARK: - Cmd-Z and Shift-Cmd-Z still work in the editor

    func testUndoAndRedoActionsReachTheEditorsOwnStackWhileItIsFirstResponder() throws {
        let rig = makeRig(); defer { rig.window.close() }
        rig.editor.replaceTextFromModel("abc")
        type("XYZ", at: 3, in: rig.editor)
        XCTAssertTrue(rig.window.makeFirstResponder(rig.editor))
        // What the Edit menu's target-less Undo and Redo items do: send the action to the responder chain.
        XCTAssertTrue(rig.editor.responds(to: undo)); XCTAssertTrue(rig.editor.responds(to: redo))
        XCTAssertTrue(rig.window.firstResponder?.tryToPerform(undo, with: nil) ?? false)
        XCTAssertEqual(rig.editor.string, "abc")
        XCTAssertTrue(rig.window.firstResponder?.tryToPerform(redo, with: nil) ?? false)
        XCTAssertEqual(rig.editor.string, "abcXYZ")
        // Not a window-level undo of someone else's typing: the other control's stack is untouched.
        XCTAssertFalse(try XCTUnwrap(rig.window.undoManager).canUndo)
    }

    func testUndoAndRedoAfterAReplacementUndoOnlyTheTypingThatFollowedIt() throws {
        let rig = makeRig(); defer { rig.window.close() }
        rig.editor.replaceTextFromModel("a long first version")
        type(" typed before", at: 20, in: rig.editor)
        rig.editor.replaceTextFromModel("x")
        type("yz", at: 1, in: rig.editor)
        XCTAssertTrue(rig.window.makeFirstResponder(rig.editor))
        XCTAssertTrue(rig.editor.tryToPerform(undo, with: nil)); XCTAssertEqual(rig.editor.string, "x")
        // Nothing older is left to undo, and asking is harmless (the stale entries are gone).
        XCTAssertFalse(rig.editor.undoManager?.canUndo ?? true)
        XCTAssertTrue(rig.editor.tryToPerform(undo, with: nil)); XCTAssertEqual(rig.editor.string, "x")
        XCTAssertTrue(rig.editor.tryToPerform(redo, with: nil)); XCTAssertEqual(rig.editor.string, "xyz")
    }

    func testTheEditMenuItemsAreEnabledFromTheEditorsOwnStack() {
        let rig = makeRig(); defer { rig.window.close() }
        let undoItem = NSMenuItem(title: "Undo", action: undo, keyEquivalent: "z")
        let redoItem = NSMenuItem(title: "Redo", action: redo, keyEquivalent: "Z")
        rig.editor.replaceTextFromModel("abc")
        XCTAssertFalse(rig.editor.validateUserInterfaceItem(undoItem)); XCTAssertFalse(rig.editor.validateUserInterfaceItem(redoItem))
        type("XYZ", at: 3, in: rig.editor)
        XCTAssertTrue(rig.editor.validateUserInterfaceItem(undoItem)); XCTAssertFalse(rig.editor.validateUserInterfaceItem(redoItem))
        rig.editor.undoManager?.undo()
        XCTAssertFalse(rig.editor.validateUserInterfaceItem(undoItem)); XCTAssertTrue(rig.editor.validateUserInterfaceItem(redoItem))
        // A model replacement clears both directions.
        rig.editor.undoManager?.redo(); rig.editor.replaceTextFromModel("other")
        XCTAssertFalse(rig.editor.validateUserInterfaceItem(undoItem)); XCTAssertFalse(rig.editor.validateUserInterfaceItem(redoItem))
        // Items it does not own still go to AppKit.
        XCTAssertTrue(rig.editor.validateUserInterfaceItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")))
    }

    func testTheScrollableFactoryBuildsAWorkingScrollableTextView() throws {
        let (scrollView, textView) = ScopedUndoTextView.makeScrollable()
        XCTAssertTrue(scrollView.documentView === textView)
        XCTAssertTrue(scrollView.hasVerticalScroller); XCTAssertFalse(scrollView.hasHorizontalScroller)
        XCTAssertTrue(textView.isVerticallyResizable); XCTAssertFalse(textView.isHorizontallyResizable)
        XCTAssertTrue(textView.textContainer?.widthTracksTextView ?? false)
        XCTAssertFalse(textView.isRichText)
        XCTAssertNotNil(textView.textLayoutManager, "same text system as a stock scrollableTextView()")
    }
}
#endif
