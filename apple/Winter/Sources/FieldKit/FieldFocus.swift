import Foundation

/// The focus model (2d-i): the composer's `CommandTextView` stays firstResponder FOREVER while
/// the field is open — focus is virtual, rendered as a ring. All keys flow through
/// `doCommand(by:)`/`insertText`, so there is no firstResponder juggling (the 2c key-window saga
/// taught us never to fight AppKit for key status mid-flight). Chain for 2d-i: `composer ↑→
/// expandChevron`, `expandChevron ↓→ composer`. Enter on chevron expands. Typing while the
/// chevron is focused refocuses the composer and inserts normally. 2d-iii's cards will extend the
/// chain.

enum FieldFocusElement: Equatable { case composer, expandChevron }
enum FieldFocusKey: Equatable { case up, down, enter }

struct FieldFocusResolution: Equatable {
    let element: FieldFocusElement
    let consumed: Bool
    let activatesExpand: Bool
}

func resolveFieldFocusKey(
    current: FieldFocusElement,
    key: FieldFocusKey,
    caretAtFirstLine: Bool,
    caretAtLastLine: Bool
) -> FieldFocusResolution {
    switch (current, key) {
    case (.composer, .up) where caretAtFirstLine:
        return .init(element: .expandChevron, consumed: true, activatesExpand: false)
    case (.composer, _):
        return .init(element: .composer, consumed: false, activatesExpand: false)
    case (.expandChevron, .down):
        return .init(element: .composer, consumed: true, activatesExpand: false)
    case (.expandChevron, .enter):
        // Focus lands back on the composer so the field is in its home state when the
        // window later closes back to orb → field.
        return .init(element: .composer, consumed: true, activatesExpand: true)
    case (.expandChevron, _):
        return .init(element: .expandChevron, consumed: true, activatesExpand: false)
    }
}

/// Newline-delimited line boundaries (soft wraps deliberately don't count — the composer
/// is short; hard lines are the terminal-like contract).
func caretAtFirstLine(of text: String, caretLocation: Int) -> Bool {
    let ns = text as NSString
    let loc = min(max(caretLocation, 0), ns.length)
    return !ns.substring(to: loc).contains("\n")
}

func caretAtLastLine(of text: String, caretLocation: Int) -> Bool {
    let ns = text as NSString
    let loc = min(max(caretLocation, 0), ns.length)
    return !ns.substring(from: loc).contains("\n")
}
