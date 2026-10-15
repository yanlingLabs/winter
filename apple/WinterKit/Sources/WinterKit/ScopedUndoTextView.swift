#if canImport(AppKit)
import AppKit

/// A plain-text view whose undo history is its own, not the window's.
///
/// An `NSTextView` normally registers its edits on its WINDOW's undo manager, which every text control
/// in that window shares: the chat composer, settings fields and this view would all push onto, and
/// undo from, one stack. That has two costs for a view whose text the MODEL can replace (a refresh, a
/// review, a navigation). Replacing the text leaves the old edits on the stack with ranges into text
/// that is gone, and Cmd-Z then raises `NSRangeException` out of `NSTextStorage`; clearing the window's
/// stack to avoid that would wipe the history of every unrelated field in the window. So this view
/// keeps a private `UndoManager`, and a model-driven replacement clears only that.
///
/// Handing the manager over through `NSTextViewDelegate.undoManager(for:)` is not enough on its own, and
/// that was measured: the Edit menu's Undo and Redo items send `undo:`/`redo:` down the responder chain
/// with no target, an `NSTextView` does not answer them, and `NSWindow` does, against the window's own
/// manager. A text view with a private manager would type fine and then ignore Cmd-Z. This view answers
/// both actions itself, ahead of the window, and enables the menu items from its own stack.
@MainActor
public final class ScopedUndoTextView: NSTextView {
    private let ownUndoManager = UndoManager()

    public override var undoManager: UndoManager? { ownUndoManager }

    @objc public func undo(_ sender: Any?) { ownUndoManager.undo() }
    @objc public func redo(_ sender: Any?) { ownUndoManager.redo() }

    public override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
        switch item.action {
        case #selector(undo(_:)): return ownUndoManager.canUndo
        case #selector(redo(_:)): return ownUndoManager.canRedo
        default: return super.validateUserInterfaceItem(item)
        }
    }

    /// A scroll view around a `ScopedUndoTextView`, set up the way `NSTextView.scrollableTextView()`
    /// sets up a stock one (the text view's sizing, container and rich-text defaults are copied from a
    /// stock instance rather than restated, so they cannot drift from AppKit's).
    public static func makeScrollable() -> (scrollView: NSScrollView, textView: ScopedUndoTextView) {
        let scrollView = NSTextView.scrollableTextView()
        guard let stock = scrollView.documentView as? NSTextView else { fatalError("scrollableTextView() lost its text view") }
        let textView = ScopedUndoTextView(frame: stock.frame)
        textView.minSize = stock.minSize
        textView.maxSize = stock.maxSize
        textView.isVerticallyResizable = stock.isVerticallyResizable
        textView.isHorizontallyResizable = stock.isHorizontallyResizable
        textView.autoresizingMask = stock.autoresizingMask
        textView.textContainer?.containerSize = stock.textContainer?.containerSize ?? textView.textContainer?.containerSize ?? .zero
        textView.textContainer?.widthTracksTextView = stock.textContainer?.widthTracksTextView ?? true
        textView.textContainer?.heightTracksTextView = stock.textContainer?.heightTracksTextView ?? false
        textView.isRichText = stock.isRichText
        textView.usesFontPanel = stock.usesFontPanel
        textView.usesRuler = stock.usesRuler
        textView.importsGraphics = stock.importsGraphics
        textView.allowsImageEditing = stock.allowsImageEditing
        textView.usesFindBar = stock.usesFindBar
        textView.isIncrementalSearchingEnabled = stock.isIncrementalSearchingEnabled
        scrollView.documentView = textView
        return (scrollView, textView)
    }

    /// Shows `text` because the MODEL changed it, not because the person typed. Returns whether anything
    /// was replaced.
    ///
    /// Assigning `string` replaces the whole text storage but leaves every earlier edit on the undo
    /// stack, and those entries hold ranges into the text that is gone: Cmd-Z then raises
    /// `NSRangeException` (an uncaught Objective-C exception that ends the app). The stale history is
    /// cleared right after the assignment, and it is THIS view's history only. It is cleared only when the
    /// text really changed: the person's own typing reaches the model and comes straight back
    /// byte-equal, so that round trip keeps its undo history.
    ///
    /// Compared as UTF-8 bytes, not Swift `==`: that treats canonically equivalent spellings as equal
    /// and would leave the view showing a different spelling from the one the model will save.
    @discardableResult
    public func replaceTextFromModel(_ text: String) -> Bool {
        guard !string.utf8.elementsEqual(text.utf8) else { return false }
        string = text
        ownUndoManager.removeAllActions()
        return true
    }
}
#endif
