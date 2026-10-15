#if canImport(AppKit)
import AppKit

extension NSTextView {
    /// Shows `text` because the MODEL changed it (a refresh, a review, a navigation), not because the
    /// person typed. Returns whether anything was replaced.
    ///
    /// Assigning `string` replaces the whole text storage but leaves every earlier edit on the undo
    /// stack, and those entries hold ranges into the text that is gone: Cmd-Z then raises
    /// `NSRangeException` out of `NSTextStorage`'s undo path (an uncaught Objective-C exception that
    /// ends the app). The stale history is cleared right after the assignment. It is cleared ONLY when
    /// the text really changed: the person's own typing reaches the model and comes straight back
    /// byte-equal, so that round trip must keep its undo history.
    ///
    /// Compared as UTF-8 bytes, not Swift `==`: that treats canonically equivalent spellings as equal
    /// and would leave the view showing a different spelling from the one the model will save.
    ///
    /// `undoManager` is the window's, which every text control in that window shares, so the clear
    /// also drops their history. AppKit offers no per-view removal: `removeAllActions(withTarget:)`
    /// does not match the text system's private targets (checked), and a delegate-supplied manager
    /// would change how Edit > Undo finds the stack.
    @MainActor @discardableResult
    public func replaceTextFromModel(_ text: String) -> Bool {
        guard !string.utf8.elementsEqual(text.utf8) else { return false }
        string = text
        undoManager?.removeAllActions()
        return true
    }
}
#endif
