import XCTest
@testable import WinterCUCore

/// The §4 state format: header, line grammar, indentation, redaction and the line cap.
final class StateFormatterTests: XCTestCase {
    private let f = CUStateFormatter()

    /// The spine's own example, rebuilt from nodes.
    private func notesTree() -> [CUNode] {
        let toolbar = CUNode(ref: 2, role: "AXToolbar", children: [
            CUNode(ref: 3, role: "AXButton", name: "New Note", actions: ["AXPress"]),
            CUNode(ref: 4, role: "AXButton", name: "Share", states: .disabled, actions: ["AXPress"]),
        ])
        let list = CUNode(ref: 11, role: "AXList", name: "Notes", itemCount: 12, children: [
            CUNode(ref: 12, role: "AXRow", name: "Groceries", states: .selected),
        ])
        let area = CUNode(ref: 14, role: "AXTextArea", value: "milk, eggs", states: .focused)
        let more = CUNode(ref: 20, role: "AXButton", name: "More", actions: ["AXPress", "AXShowMenu"])
        let group = CUNode(ref: 41, role: "AXGroup", unreadChildren: 120)
        return [CUNode(ref: 1, role: "AXWindow", name: "Groceries", children: [toolbar, list, area, more, group])]
    }

    func testSpineExample() {
        let header = CUStateHeader(appName: "Notes", windowTitle: "Groceries", focusedRef: 14, settle: .settled(ms: 120))
        let text = f.full(header: header, roots: notesTree())
        XCTAssertEqual(text, """
        Notes — window "Groceries" · focused [14] · settled 120 ms
        [1] window "Groceries"
          [2] toolbar
            [3] button "New Note"
            [4] button "Share" (disabled)
          [11] list "Notes" (12 items)
            [12] row "Groceries" (selected)
          [14] text area value="milk, eggs" (focused)
          [20] button "More" actions: show menu
          [41] group (120 more — state({within:41}))
        """)
    }

    func testHeaderVariants() {
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: "A", focusedRef: nil, settle: .notSettled(ms: 1500))),
                       "Notes — window \"A\" · not settled after 1500 ms")
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: 3, settle: nil)),
                       "Notes — focused [3]")
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: nil, settle: nil)), "Notes")
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: "A", focusedRef: 3, settle: .settled(ms: 80)),
                                includeWindow: false), "Notes — focused [3] · settled 80 ms")
    }

    func testTheHeaderNumbersThePageAndTheStateAndSaysAReadCutShort() {
        XCTAssertEqual(f.header(CUStateHeader(appName: "Safari", windowTitle: "Doc", focusedRef: 4, settle: .settled(ms: 80),
                                              page: 3, stateNumber: 12, unread: 1240)),
                       "Safari — window \"Doc\" · focused [4] · settled 80 ms · page 3 · state 12 · read cut short: at least 1,240 elements not read (the \"more\" markers show where)")
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: nil, settle: nil, stateNumber: 2)), "Notes — state 2")
    }

    func testTheHeaderSaysWhereTypedTextGoes() {
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: 14, settle: .settled(ms: 80), caret: "caret 12/40")),
                       "Notes — focused [14] · caret 12/40 · settled 80 ms")
        // No focus reported: the header says nothing (a keyboard act that needs one says so).
        XCTAssertEqual(f.header(CUStateHeader(appName: "Docs", windowTitle: nil, focusedRef: nil, settle: nil)), "Docs")
        XCTAssertEqual(f.header(CUStateHeader(appName: "Safari", windowTitle: nil, focusedRef: nil, settle: nil,
                                              focusText: "focused: the page's hidden text input (it types into the document)")),
                       "Safari — focused: the page's hidden text input (it types into the document)")
        // A focus elsewhere (not in this window's tree) is not "unknown": nothing is said.
        XCTAssertEqual(f.header(CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: nil, settle: nil)), "Notes")
        // The diff header carries it too.
        let snap = CUSnapshot(id: "s", scope: nil, header: CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: 14, settle: nil), roots: [], formatter: f)
        let d = CUStateDiff.compute(old: snap, new: snap)
        XCTAssertTrue(d.render(header: CUStateHeader(appName: "Notes", windowTitle: nil, focusedRef: 14, settle: nil, caret: "caret 3/5"),
                               new: snap, includeWindowTitle: false, formatter: f).hasPrefix("Notes — focused [14] · caret 3/5"))
    }

    func testTheCaretNote() {
        XCTAssertEqual(f.caretNote(value: "hello world", selection: NSRange(location: 5, length: 0), secure: false), "caret 5/11")
        XCTAssertEqual(f.caretNote(value: "say \"hi\" now", selection: NSRange(location: 4, length: 4), secure: false),
                       #"selected 4–8 ("\"hi\"")"#)
        let long = String(repeating: "abcdefghij", count: 6)
        XCTAssertEqual(f.caretNote(value: long, selection: NSRange(location: 0, length: 60), secure: false),
                       "selected 0–60 (\"" + String(long.prefix(40)) + "…\")", "the text cut to 40 characters")
        XCTAssertNil(f.caretNote(value: "hunter2", selection: NSRange(location: 3, length: 2), secure: true), "never a secure field's text")
        XCTAssertNil(f.caretNote(value: "hunter2", selection: NSRange(location: 7, length: 0), secure: true), "nor its length")
        XCTAssertNil(f.caretNote(value: "\u{200B}\u{200B}", selection: NSRange(location: 1, length: 0), secure: false), "filler means nothing")
        XCTAssertNil(f.caretNote(value: "abc", selection: NSRange(location: 2, length: 5), secure: false), "a range past the text")
        XCTAssertNil(f.caretNote(value: "abc", selection: nil, secure: false))
        XCTAssertEqual(f.caretNote(value: "", selection: NSRange(location: 0, length: 0), secure: false), "caret 0/0")
    }

    func testRoleWords() {
        XCTAssertEqual(CURoleWords.split("AXPopUpButton"), "pop up button")
        XCTAssertEqual(CURoleWords.split("AXTextArea"), "text area")
        XCTAssertEqual(CURoleWords.split("AXURLField"), "url field")
        XCTAssertEqual(CURoleWords.split("AXShowMenu"), "show menu")
        XCTAssertEqual(CURoleWords.words(role: "AXTextField", subrole: "AXSecureTextField"), "secure text field")
        XCTAssertEqual(CURoleWords.words(role: "AXButton", subrole: "AXCloseButton"), "close button")
        XCTAssertEqual(CURoleWords.words(role: "AXRow", subrole: "AXOutlineRow"), "outline row")
        XCTAssertEqual(CURoleWords.words(role: "AXGroup", subrole: "AXSomethingElse"), "group")
        XCTAssertEqual(CURoleWords.actionWords("Name:Reply\nTarget:0x1\nSelector:reply:"), "Reply")
    }

    func testValuesAreQuotedCutAndRedacted() {
        let long = String(repeating: "a", count: 250)
        XCTAssertEqual(f.line(CUNode(ref: 5, role: "AXTextField", value: long)),
                       "[5] text field value=\"\(String(repeating: "a", count: 200))…\"")
        XCTAssertEqual(f.line(CUNode(ref: 6, role: "AXTextField", name: "Say \"hi\"", value: "line1\nline2")),
                       "[6] text field \"Say \\\"hi\\\"\" value=\"line1\\nline2\"")
        // Secure fields always read <redacted>, even with no value and even if one slipped through.
        XCTAssertEqual(f.line(CUNode(ref: 7, role: "AXTextField", subrole: "AXSecureTextField", name: "Password")),
                       "[7] secure text field \"Password\" value=<redacted>")
        XCTAssertEqual(f.line(CUNode(ref: 8, role: "AXTextField", subrole: "AXSecureTextField", value: "hunter2")),
                       "[8] secure text field value=<redacted>")
        // A value equal to the name is not repeated.
        XCTAssertEqual(f.line(CUNode(ref: 9, role: "AXCell", name: "Total", value: "Total")), "[9] cell \"Total\"")
    }

    func testStatesItemsAndActions() {
        let n = CUNode(ref: 3, role: "AXOutline", name: "Files", states: [.focused, .disabled], itemCount: 1,
                       actions: ["AXPress", "AXIncrement", "Name:Open\nTarget:0"])
        XCTAssertEqual(f.line(n), "[3] outline \"Files\" (1 item, disabled, focused) actions: increment, Open")
        let c = CUNode(ref: 4, role: "AXCheckBox", name: "Bold", states: .checked)
        XCTAssertEqual(f.line(c), "[4] check box \"Bold\" (checked)")
    }

    func testLineCapCollapsesLargestSubtreeFirst() {
        // window → [big group (20 leaves), small group (5 leaves), field]
        let big = CUNode(ref: 2, role: "AXGroup", name: "Big",
                         children: (0..<20).map { CUNode(ref: 100 + $0, role: "AXButton", name: "b\($0)") })
        let small = CUNode(ref: 3, role: "AXGroup", name: "Small",
                           children: (0..<5).map { CUNode(ref: 200 + $0, role: "AXButton", name: "s\($0)") })
        let field = CUNode(ref: 4, role: "AXTextField", name: "Field")
        let root = CUNode(ref: 1, role: "AXWindow", name: "W", children: [big, small, field])
        let capped = CUStateFormatter(lineCap: 12)
        let lines = capped.body(roots: [root], focusedRef: nil)
        XCTAssertLessThanOrEqual(lines.count, 12)
        XCTAssertTrue(lines.contains("  [2] group \"Big\" (20 more — state({within:2}))"))
        XCTAssertTrue(lines.contains("    [200] button \"s0\""), "the smaller subtree stays open")
    }

    func testLineCapSparesTheFocusPath() {
        let big = CUNode(ref: 2, role: "AXGroup", name: "Big",
                         children: (0..<20).map { CUNode(ref: 100 + $0, role: "AXButton", name: "b\($0)") }
                             + [CUNode(ref: 150, role: "AXTextField", name: "Here", states: .focused)])
        let other = CUNode(ref: 3, role: "AXGroup", name: "Other",
                           children: (0..<8).map { CUNode(ref: 200 + $0, role: "AXButton", name: "o\($0)") })
        let root = CUNode(ref: 1, role: "AXWindow", name: "W", children: [big, other])
        let lines = CUStateFormatter(lineCap: 25).body(roots: [root], focusedRef: 150)
        XCTAssertTrue(lines.contains("  [3] group \"Other\" (8 more — state({within:3}))"))
        XCTAssertTrue(lines.contains { $0.contains("[150] text field \"Here\" (focused)") })
    }

    func testLineCapFallsBackToFocusPathWhenNothingElseFolds() {
        let big = CUNode(ref: 2, role: "AXGroup", name: "Big",
                         children: (0..<30).map { CUNode(ref: 100 + $0, role: "AXButton", name: "b\($0)") }
                             + [CUNode(ref: 150, role: "AXTextField", states: .focused)])
        let root = CUNode(ref: 1, role: "AXWindow", children: [big])
        let lines = CUStateFormatter(lineCap: 5).body(roots: [root], focusedRef: 150)
        XCTAssertLessThanOrEqual(lines.count, 5)
        XCTAssertEqual(lines[1], "  [2] group \"Big\" (31 more — state({within:2}))")
    }

    func testACollapsedElementKeepsWhatItHoldsFolded() {
        let rows = (0..<3).map { CUNode(ref: 300 + $0, role: "AXRow", name: "child \($0)") }
        let closed = CUNode(ref: 2, role: "AXRow", name: "Section", states: .collapsed, children: rows)
        let open = CUNode(ref: 3, role: "AXRow", name: "Open", states: .expanded, children: [CUNode(ref: 400, role: "AXRow", name: "shown")])
        let root = CUNode(ref: 1, role: "AXOutline", children: [closed, open])
        let lines = f.body(roots: [root], focusedRef: nil)
        XCTAssertTrue(lines.contains("  [2] row \"Section\" (collapsed) (3 more — state({within:2}))"), lines.joined(separator: "\n"))
        XCTAssertFalse(lines.contains { $0.contains("child 0") })
        XCTAssertTrue(lines.contains { $0.contains("[400] row \"shown\"") })
        // Read with `within`, it is the root: shown open.
        XCTAssertTrue(f.body(roots: [closed], focusedRef: nil).contains { $0.contains("child 0") })
        // The focus inside it: open.
        XCTAssertTrue(f.body(roots: [root], focusedRef: 301).contains { $0.contains("child 1") })
    }

    func testIndentationIsTwoSpacesPerLevel() {
        let tree = CUNode(ref: 1, role: "AXWindow", children: [
            CUNode(ref: 2, role: "AXGroup", name: "a", children: [CUNode(ref: 3, role: "AXButton", name: "b")]),
        ])
        XCTAssertEqual(f.body(roots: [tree], focusedRef: nil), ["[1] window", "  [2] group \"a\"", "    [3] button \"b\""])
    }
}
