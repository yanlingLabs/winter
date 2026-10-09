import XCTest
@testable import WinterCUCore

/// `find`, `waitFor` conditions, menu paths, `select` ranges and AX action names — all pure matching.
final class MatchingTests: XCTestCase {
    private let tree = CUNode(ref: 1, role: "AXWindow", name: "Mail", children: [
        CUNode(ref: 2, role: "AXButton", name: "Send", actions: ["AXPress"]),
        CUNode(ref: 3, role: "AXTextField", name: "Subject", value: "Café plans"),
        CUNode(ref: 4, role: "AXTextField", subrole: "AXSecureTextField", name: "Password", value: "secret"),
        CUNode(ref: 5, role: "AXStaticText", name: "Draft saved"),
        CUNode(ref: 6, role: "AXButton", name: "Send Later", identifier: "sendLater"),
    ])

    // MARK: find

    func testFindByText() {
        XCTAssertEqual(CUFinder.find(.text("send"), in: [tree]).map(\.ref), [2, 6])
        XCTAssertEqual(CUFinder.find(.text("cafe"), in: [tree]).map(\.ref), [3], "diacritic-insensitive")
        XCTAssertEqual(CUFinder.find(.text("sendlater"), in: [tree]).map(\.ref), [6], "identifiers match too")
        XCTAssertTrue(CUFinder.find(.text("secret"), in: [tree]).isEmpty, "secure values are never searched")
    }

    func testFindByFields() {
        XCTAssertEqual(CUFinder.find(.fields(role: "button", name: "later", text: nil), in: [tree]).map(\.ref), [6])
        XCTAssertEqual(CUFinder.find(.fields(role: "AXTextField", name: nil, text: nil), in: [tree]).map(\.ref), [3, 4],
                       "a raw AX role matches every element of that role, secure ones included")
        XCTAssertEqual(CUFinder.find(.fields(role: "text field", name: nil, text: nil), in: [tree]).map(\.ref), [3])
        XCTAssertEqual(CUFinder.find(.fields(role: "secure text field", name: nil, text: nil), in: [tree]).map(\.ref), [4])
        XCTAssertEqual(CUFinder.find(.fields(role: "text field", name: nil, text: "plans"), in: [tree]).map(\.ref), [3])
        XCTAssertTrue(CUFinder.find(.fields(role: nil, name: nil, text: nil), in: [tree]).isEmpty)
    }

    func testFindSummariesRedactAndCap() {
        let s = CUFinder.find(.fields(role: "secure text field", name: nil, text: nil), in: [tree])
        XCTAssertEqual(s.first, CUElementSummary(ref: 4, role: "secure text field", name: "Password", value: "<redacted>"))
        let many = CUNode(ref: 1, role: "AXWindow", children: (0..<80).map { CUNode(ref: 10 + $0, role: "AXButton", name: "b\($0)") })
        XCTAssertEqual(CUFinder.find(.text("b"), in: [many]).count, 50)
    }

    // MARK: waitFor

    func testWaitConditions() {
        let o = CUWaitEvaluator.Observation(roots: [tree], windowTitle: "New Message", focusedRef: 3)
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(text: "draft saved"), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "sent"), o))
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(ref: 5), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(ref: 99), o))
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(gone: .ref(99)), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(gone: .text("Draft")), o))
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(gone: .text("Loading")), o))
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(title: "new message"), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "secret"), o), "secure values never match")
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "draft saved", title: "Inbox"), o), "every part must hold")
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(), o), "an empty condition is never met")
        XCTAssertEqual(CUWaitEvaluator.seen(o), "window \"New Message\" · 6 elements · focused [3]")
    }

    // MARK: menus

    struct FakeMenu: CUMenuNode {
        var menuTitle: String
        var menuEnabled = true
        var menuChildren: [FakeMenu] = []
    }

    private let bar = [
        FakeMenu(menuTitle: "Apple"),
        FakeMenu(menuTitle: "File", menuChildren: [
            FakeMenu(menuTitle: "New Note"),
            FakeMenu(menuTitle: "Export as PDF…"),
            FakeMenu(menuTitle: "Share", menuChildren: [FakeMenu(menuTitle: "Mail"), FakeMenu(menuTitle: "Messages", menuEnabled: false)]),
        ]),
        FakeMenu(menuTitle: "Edit", menuChildren: [FakeMenu(menuTitle: "Undo")]),
    ]

    func testMenuPaths() throws {
        XCTAssertEqual(try CUMenuWalker.resolve(["File", "New Note"], in: bar).menuTitle, "New Note")
        XCTAssertEqual(try CUMenuWalker.resolve(["file", "export as pdf..."], in: bar).menuTitle, "Export as PDF…",
                       "case and ... vs … don't matter")
        XCTAssertEqual(try CUMenuWalker.resolve(["File", "Export as PDF"], in: bar).menuTitle, "Export as PDF…")
        XCTAssertEqual(try CUMenuWalker.resolve(["File", "Share", "Mail"], in: bar).menuTitle, "Mail")
        XCTAssertEqual(try CUMenuWalker.resolve(["Edit", "Und"], in: bar).menuTitle, "Undo", "prefix fallback")
    }

    func testMenuErrors() {
        XCTAssertThrowsError(try CUMenuWalker.resolve([], in: bar))
        XCTAssertThrowsError(try CUMenuWalker.resolve(["View"], in: bar)) { e in
            XCTAssertTrue((e as? CUError)?.message.contains("File") == true, "lists what exists")
        }
        XCTAssertThrowsError(try CUMenuWalker.resolve(["File", "Share", "Messages"], in: bar)) { e in
            XCTAssertEqual((e as? CUError)?.code, "unsupported")
        }
        XCTAssertThrowsError(try CUMenuWalker.resolve(["File", "New Note", "More"], in: bar))
    }

    // MARK: select

    func testSelectionRanges() {
        let v = "milk, eggs, bread, eggs"
        XCTAssertEqual(CUCore.selectionRange(in: v, text: "eggs", before: nil, after: nil, caret: nil), NSRange(location: 6, length: 4))
        XCTAssertEqual(CUCore.selectionRange(in: v, text: "eggs", before: "bread, ", after: nil, caret: nil),
                       NSRange(location: 19, length: 4))
        XCTAssertEqual(CUCore.selectionRange(in: v, text: "eggs", before: nil, after: ", bread", caret: .end),
                       NSRange(location: 10, length: 0))
        XCTAssertEqual(CUCore.selectionRange(in: v, text: "milk", before: nil, after: nil, caret: .start),
                       NSRange(location: 0, length: 0))
        XCTAssertNil(CUCore.selectionRange(in: v, text: "jam", before: nil, after: nil, caret: nil))
        XCTAssertNil(CUCore.selectionRange(in: v, text: "eggs", before: "jam ", after: nil, caret: nil))
        // UTF-16 offsets, as AX ranges are.
        XCTAssertEqual(CUCore.selectionRange(in: "😀 hi", text: "hi", before: nil, after: nil, caret: nil),
                       NSRange(location: 3, length: 2))
    }

    // MARK: AX action names

    func testActionNameResolution() {
        let raw = ["AXPress", "AXShowMenu", "Name:Reply\nTarget:0x0\nSelector:reply:"]
        XCTAssertEqual(CURoleWords.resolveAction("show menu", among: raw), "AXShowMenu")
        XCTAssertEqual(CURoleWords.resolveAction("AXShowMenu", among: raw), "AXShowMenu")
        XCTAssertEqual(CURoleWords.resolveAction("showmenu", among: raw), "AXShowMenu")
        XCTAssertEqual(CURoleWords.resolveAction("reply", among: raw), raw[2])
        XCTAssertNil(CURoleWords.resolveAction("increment", among: raw))
        XCTAssertEqual(CURoleWords.extraActions(raw), ["show menu", "Reply"])
    }
}
