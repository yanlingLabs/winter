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

    /// The Chrome Web Store dashboard (live, 2026-10-14), as Chrome's tree read it: the item's header with its status in
    /// five static texts, and the same web area while the "Success" dialog is up (only the dialog is in the tree).
    private static func storeHeader(status: String = "Published") -> CUNode {
        CUNode(ref: 983, role: "AXGroup", name: "Winter for Chrome", children: [
            CUNode(ref: 984, role: "AXHeading", name: "Winter for Chrome", value: "1", children: [
                CUNode(ref: 985, role: "AXLink", name: "Winter for Chrome", children: [
                    CUNode(ref: 986, role: "AXStaticText", name: "Winter for Chrome"),
                ]),
            ]),
            CUNode(ref: 987, role: "AXStaticText", name: "Status:"),
            CUNode(ref: 988, role: "AXStaticText", value: " "),
            CUNode(ref: 989, role: "AXStaticText", name: status),
            CUNode(ref: 990, role: "AXStaticText", name: "-", value: " - "),
            CUNode(ref: 991, role: "AXStaticText", name: "public"),
            CUNode(ref: 992, role: "AXStaticText", name: "ID:", value: "ID: "),
            CUNode(ref: 993, role: "AXStaticText", name: "flfkppajaamjgfmdljlklfdffkdcmicc"),
            CUNode(ref: 995, role: "AXButton", name: "Save draft", states: .disabled),
            CUNode(ref: 997, role: "AXButton", name: "Publish", states: .disabled),
        ])
    }

    private static func storeWindow(_ page: [CUNode]) -> CUNode {
        CUNode(ref: 1, role: "AXWindow", name: "Store Listing - Google Chrome", children: [
            CUNode(ref: 7, role: "AXToolbar", children: [CUNode(ref: 10, role: "AXButton", name: "Reload")]),
            CUNode(ref: 230, role: "AXWebArea", name: "Store Listing", children: page),
        ])
    }

    private static let successDialog = CUNode(ref: 953, role: "AXGroup", name: "Success", children: [
        CUNode(ref: 954, role: "AXHeading", name: "Success", value: "2", children: [
            CUNode(ref: 955, role: "AXGroup"),
            CUNode(ref: 956, role: "AXStaticText", name: "Success"),
        ]),
        CUNode(ref: 958, role: "AXStaticText", name: "Your publish request was submitted"),
        CUNode(ref: 960, role: "AXButton", name: "OK", states: .focused, actions: ["AXPress"]),
    ])

    func testWaitTextMatchesAcrossAStatusSplitIntoStaticTexts() {
        let o = CUWaitEvaluator.Observation(roots: [Self.storeWindow([Self.storeHeader()])], windowTitle: "Store Listing", focusedRef: 230)
        for t in ["Status: Published", "status: published - public", "Status:  Published", "Published - public ID: flfk", "public"] {
            XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(text: t), o), t)
        }
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Status: Pending review"), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(gone: .text("Status: Published")), o), "gone reads the same runs")
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Save draft Publish"), o), "buttons never join a run")
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Winter for Chrome Status"), o),
                       "a run never spans a heading or a link")
        let pending = CUWaitEvaluator.Observation(roots: [Self.storeWindow([Self.storeHeader(status: "Pending review")])],
                                                  windowTitle: "Store Listing", focusedRef: nil)
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Status: Published"), pending))
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(gone: .text("Status: Published")), pending))
    }

    /// find() reads the same runs: it answers the run's element where the matched text begins.
    func testFindMatchesAcrossAStatusSplitIntoStaticTexts() {
        let page = [Self.storeWindow([Self.storeHeader()])]
        func refs(_ q: CUFindQuery) -> [Int] { CUFinder.find(q, in: page).map(\.ref) }
        XCTAssertEqual(refs(.text("Status: Published")), [987], "the run's first element: where the phrase begins")
        XCTAssertEqual(refs(.text("status:   published - public")), [987])
        XCTAssertEqual(refs(.text("Published - public")), [989], "a phrase starting mid-run answers the piece it starts in")
        XCTAssertEqual(refs(.text("public ID: flfk")), [991])
        XCTAssertEqual(refs(.text("public")), [991], "a phrase inside one piece is that element's own match, once")
        XCTAssertEqual(refs(.fields(role: nil, name: nil, text: "Status: Published")), [987])
        XCTAssertEqual(refs(.fields(role: "static text", name: nil, text: "Status: Published")), [987])
        XCTAssertEqual(refs(.fields(role: "button", name: nil, text: "Status: Published")), [], "the role must hold too")
        XCTAssertEqual(refs(.fields(role: nil, name: "Status: Published", text: nil)), [], "a run has no name")
        XCTAssertEqual(refs(.text("Save draft Publish")), [], "buttons never join a run")
        XCTAssertEqual(refs(.text("Winter for Chrome Status")), [], "a run never spans a heading or a link")
        XCTAssertEqual(refs(.text("Status: Pending review")), [])
        let summary = CUFinder.find(.text("Status: Published"), in: page).first
        XCTAssertEqual(summary, CUElementSummary(ref: 987, role: "static text", name: "Status:"))
    }

    func testARunNeverReadsASecureField() {
        let row = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Code:"),
            CUNode(ref: 3, role: "AXStaticText", subrole: "AXSecureTextField", value: "4242"),
            CUNode(ref: 4, role: "AXStaticText", name: "ok"),
        ])
        let o = CUWaitEvaluator.Observation(roots: [row], windowTitle: "w", focusedRef: nil)
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "4242"), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Code: 4242"), o))
        XCTAssertTrue(CUFinder.find(.text("Code: 4242"), in: [row]).isEmpty)
        XCTAssertTrue(CUFinder.find(.text("4242 ok"), in: [row]).isEmpty, "a secure element ends a run, never joins it")
    }

    /// The live timeout: with the dialog up the wait for the status behind it can't be met, and `seen` now says why.
    func testAWaitTimeoutNamesTheDialogThatHidesThePage() {
        let o = CUWaitEvaluator.Observation(roots: [Self.storeWindow([Self.successDialog])], windowTitle: "Store Listing", focusedRef: 960)
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Status: Published"), o), "the page is not in the tree")
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(text: "publish request was submitted"), o), "the dialog's own text is")
        XCTAssertEqual(CUWaitEvaluator.seen(o),
                       "window \"Store Listing\" · 10 elements · focused [960] — the page shows only group \"Success\" [953] (\"Your publish request was submitted\"; button \"OK\") — it looks like a dialog: while a page's dialog is open the browser leaves the page behind it out of the accessibility tree, so what you wait for may be behind it; answer or close it, then wait again")
        // The same dialog with the subrole Chromium and WebKit give role="dialog": named a dialog outright.
        var d = Self.successDialog
        d.subrole = "AXApplicationDialog"
        let byKind = CUWaitEvaluator.Observation(roots: [Self.storeWindow([d, CUNode(ref: 999, role: "AXGroup")])], windowTitle: "Store Listing", focusedRef: 960)
        XCTAssertEqual(CUWaitEvaluator.dialogNote(byKind.roots, focusedRef: 960),
                       "a dialog \"Success\" [953] is open (\"Your publish request was submitted\"; button \"OK\") — the page behind it is not in the accessibility tree while it is open, so what you wait for may be behind it: answer or close the dialog, then wait again")
        // A dialog over a page that is still in the tree: it may hide it.
        let over = CUWaitEvaluator.Observation(roots: [Self.storeWindow([Self.storeHeader(), d])], windowTitle: "Store Listing", focusedRef: 960)
        XCTAssertTrue(CUWaitEvaluator.dialogNote(over.roots, focusedRef: 960)?.contains("what is behind it may be hidden from accessibility while it is open") ?? false)
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(text: "Status: Published"), over))
        // No dialog: the old digest, unchanged.
        let page = CUWaitEvaluator.Observation(roots: [Self.storeWindow([Self.storeHeader()])], windowTitle: "Store Listing", focusedRef: nil)
        XCTAssertNil(CUWaitEvaluator.dialogNote(page.roots, focusedRef: nil),
                     "a page whose only content is a named group with buttons is no dialog unless the focus is in it")
        XCTAssertNil(CUWaitEvaluator.dialogNote(page.roots, focusedRef: 230))
        XCTAssertEqual(CUWaitEvaluator.seen(page), "window \"Store Listing\" · 17 elements")
    }

    func testAPageWhoseOnlyContentIsALandmarkIsNoDialog() {
        let main = CUNode(ref: 5, role: "AXGroup", subrole: "AXLandmarkMain", name: "Main", children: [
            CUNode(ref: 6, role: "AXButton", name: "Go"),
        ])
        XCTAssertNil(CUWaitEvaluator.dialogNote([Self.storeWindow([main])], focusedRef: 6))
        let sheet = CUNode(ref: 1, role: "AXWindow", name: "Doc", children: [
            CUNode(ref: 2, role: "AXSheet", children: [CUNode(ref: 3, role: "AXStaticText", value: "Save changes?"), CUNode(ref: 4, role: "AXButton", name: "Don't Save")]),
        ])
        XCTAssertEqual(CUWaitEvaluator.dialogNote([sheet], focusedRef: nil),
                       "a dialog [2] is open (\"Save changes?\"; button \"Don't Save\") — what is behind it may be hidden from accessibility while it is open, so what you wait for may be behind it: answer or close the dialog, then wait again")
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
