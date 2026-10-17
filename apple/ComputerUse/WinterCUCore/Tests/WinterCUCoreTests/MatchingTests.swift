import CoreGraphics
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
    /// A piece of the header's status line (y 370…390), from x `a` to x `b`.
    private static func on(_ a: CGFloat, _ b: CGFloat, y: CGFloat = 370, h: CGFloat = 20) -> CGRect {
        CGRect(x: a, y: y, width: b - a, height: h)
    }

    private static func storeHeader(status: String = "Published") -> CUNode {
        CUNode(ref: 983, role: "AXGroup", name: "Winter for Chrome", children: [
            CUNode(ref: 984, role: "AXHeading", name: "Winter for Chrome", value: "1", children: [
                CUNode(ref: 985, role: "AXLink", name: "Winter for Chrome", children: [
                    CUNode(ref: 986, role: "AXStaticText", name: "Winter for Chrome"),
                ]),
            ]),
            CUNode(ref: 987, role: "AXStaticText", name: "Status:", frame: Self.on(115, 162)),
            CUNode(ref: 988, role: "AXStaticText", value: " ", frame: Self.on(162, 166)),
            CUNode(ref: 989, role: "AXStaticText", name: status, frame: Self.on(166, 232)),
            CUNode(ref: 990, role: "AXStaticText", name: "-", value: " - ", frame: Self.on(232, 246)),
            CUNode(ref: 991, role: "AXStaticText", name: "public", frame: Self.on(246, 290)),
            CUNode(ref: 992, role: "AXStaticText", name: "ID:", value: "ID: ", frame: Self.on(300, 325)),
            CUNode(ref: 993, role: "AXStaticText", name: "flfkppajaamjgfmdljlklfdffkdcmicc", frame: Self.on(325, 560)),
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

    /// Block elements the reader made siblings (paragraphs, log lines) never read as one line; a wrapped line does.
    func testARunJoinsOnlyPiecesOnOneVisualLine() {
        let paragraphs = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Payment", frame: Self.on(20, 90, y: 100)),
            CUNode(ref: 3, role: "AXStaticText", name: "Complete the form below", frame: Self.on(20, 220, y: 140)),
            CUNode(ref: 4, role: "AXStaticText", name: "Log line one", frame: Self.on(20, 120, y: 180)),
            CUNode(ref: 5, role: "AXStaticText", name: "complete", frame: Self.on(20, 90, y: 200)),
        ])
        let o = CUWaitEvaluator.Observation(roots: [paragraphs], windowTitle: "w", focusedRef: nil)
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Payment complete"), o))
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "Log line one complete"), o), "touching lines are two lines")
        XCTAssertTrue(CUFinder.find(.text("Payment complete"), in: [paragraphs]).isEmpty)
        XCTAssertTrue(CUFinder.textRuns(paragraphs.flattened()).isEmpty)
        // Unknown frames never join.
        let unframed = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Status:"), CUNode(ref: 3, role: "AXStaticText", name: "Published"),
        ])
        XCTAssertTrue(CUFinder.find(.text("Status: Published"), in: [unframed]).isEmpty)
        // A wrapped piece (two lines tall) and the text continuing its bottom line join; so do two pieces side by side
        // with no space of their own — a space between, never glued.
        let wrapped = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Your publish request was", frame: CGRect(x: 20, y: 100, width: 400, height: 40)),
            CUNode(ref: 3, role: "AXStaticText", name: "submitted", frame: Self.on(20, 90, y: 120)),
            CUNode(ref: 4, role: "AXStaticText", name: "today", frame: Self.on(95, 135, y: 120)),
        ])
        XCTAssertEqual(CUFinder.find(.text("request was submitted today"), in: [wrapped]).map(\.ref), [2])
        XCTAssertEqual(CUFinder.find(.text("submitted today"), in: [wrapped]).map(\.ref), [3])
        XCTAssertTrue(CUFinder.find(.text("submittedtoday"), in: [wrapped]).isEmpty, "words never glue")
        XCTAssertEqual(CUFinder.textRuns(wrapped.flattened()).first?.line, "your publish request was submitted today")
        XCTAssertEqual(CUFinder.textRuns(Self.storeHeader().flattened()).first?.line, "status: published - public id: flfkppajaamjgfmdljlklfdffkdcmicc")
    }

    /// The re-review: pieces that TOUCH on one line are one word ("$" + "12.99", a highlighted "Pub" + "lished");
    /// pieces with a visible gap are two words.
    func testTouchingPiecesAreOneWordAndAGapIsASpace() {
        func line(_ parts: [(String, CGFloat, CGFloat)]) -> String? {
            let row = CUNode(ref: 1, role: "AXGroup", children: parts.enumerated().map { i, p in
                CUNode(ref: 2 + i, role: "AXStaticText", name: p.0, frame: Self.on(p.1, p.2))
            })
            return CUFinder.textRuns(row.flattened()).first?.line
        }
        XCTAssertEqual(line([("Total:", 0, 40), ("$", 44, 52), ("12.99", 52, 90)]), "total: $12.99")
        XCTAssertEqual(line([("Pub", 100, 125), ("lished", 125.5, 160)]), "published")
        XCTAssertEqual(line([("Hello", 0, 40), ("world", 45, 80)]), "hello world")
        let price = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "$", frame: Self.on(44, 52)),
            CUNode(ref: 3, role: "AXStaticText", name: "12.99", frame: Self.on(52, 90)),
        ])
        XCTAssertEqual(CUFinder.find(.text("$12.99"), in: [price]).map(\.ref), [2])
        XCTAssertTrue(CUWaitEvaluator.met(CUWaitCondition(text: "$12.99"), CUWaitEvaluator.Observation(roots: [price], windowTitle: "w", focusedRef: nil)))
    }

    /// The re-review: a NEXT piece that wraps joins ("Note:" + a long value flowing onto the next line), and so does a
    /// line broken between two pieces (the next at the container's left edge under a previous that ended near its
    /// right edge); paragraphs in a framed container still never do.
    func testAWrappingNextPieceAndABrokenLineJoin() {
        let note = CUNode(ref: 1, role: "AXGroup", frame: CGRect(x: 20, y: 100, width: 400, height: 40), children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Note:", frame: Self.on(20, 60, y: 100)),
            CUNode(ref: 3, role: "AXStaticText", name: "the package must be smaller than 2 GB to upload",
                   frame: CGRect(x: 20, y: 100, width: 400, height: 40)),
        ])
        XCTAssertEqual(CUFinder.find(.text("Note: the package"), in: [note]).map(\.ref), [2])
        let broken = CUNode(ref: 1, role: "AXGroup", frame: CGRect(x: 20, y: 100, width: 400, height: 40), children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Your item is now", frame: Self.on(300, 410, y: 100)),
            CUNode(ref: 3, role: "AXStaticText", name: "published", frame: Self.on(20, 80, y: 120)),
        ])
        XCTAssertEqual(CUFinder.find(.text("now published"), in: [broken]).map(\.ref), [2])
        let paragraphs = CUNode(ref: 1, role: "AXGroup", frame: CGRect(x: 20, y: 100, width: 400, height: 80), children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Payment", frame: Self.on(20, 90, y: 100)),
            CUNode(ref: 3, role: "AXStaticText", name: "Complete the form below", frame: Self.on(20, 220, y: 120)),
            CUNode(ref: 4, role: "AXStaticText", name: "Saved", frame: Self.on(20, 70, y: 150)),
        ])
        XCTAssertTrue(CUFinder.textRuns(paragraphs.flattened()).isEmpty, "a short line above is a paragraph, not a wrap")
    }

    /// The review: matchStart re-joined the prefix per piece (a 1,000-piece run took 8 s on the pid queue). One pass now.
    func testALongRunIsMatchedInLinearTime() {
        let n = 2_000
        let line = CUNode(ref: 1, role: "AXGroup", children: (0..<n).map { i in
            CUNode(ref: 10 + i, role: "AXStaticText", name: "w\(i)", frame: Self.on(CGFloat(i) * 10, CGFloat(i) * 10 + 8))
        })
        let nodes = line.flattened()
        // Only the run's own work is timed (building the run, three matches); the quadratic version took seconds here.
        let t0 = Date()
        let runs = CUFinder.textRuns(nodes)
        let a = runs.first?.matchStart("w1998 w1999"), b = runs.first?.matchStart("w1999"), c = runs.first?.matchStart("w1999 w0")
        let ms = Date().timeIntervalSince(t0) * 1000
        XCTAssertLessThan(ms, 250, "a 2,000-piece run: \(ms) ms")
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(a, 1998)
        XCTAssertNil(b, "inside one piece: that element's own match")
        XCTAssertNil(c)
        XCTAssertEqual(CUFinder.find(.text("w1500 w1501 w1502"), in: [line]).map(\.ref), [1510])
        XCTAssertFalse(CUWaitEvaluator.met(CUWaitCondition(text: "w1 w3"), CUWaitEvaluator.Observation(roots: [line], windowTitle: "w", focusedRef: nil)))
    }

    func testARunNeverReadsASecureField() {
        let row = CUNode(ref: 1, role: "AXGroup", children: [
            CUNode(ref: 2, role: "AXStaticText", name: "Code:", frame: Self.on(0, 40)),
            CUNode(ref: 3, role: "AXStaticText", subrole: "AXSecureTextField", value: "4242", frame: Self.on(44, 80)),
            CUNode(ref: 4, role: "AXStaticText", name: "ok", frame: Self.on(84, 100)),
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

    /// The review: the bound window itself a dialog is what is being read, never "a dialog is open".
    func testTheBoundWindowIsNeverTheDialogInTheWay() {
        for sub in ["AXDialog", "AXSystemDialog"] {
            let w = CUNode(ref: 1, role: "AXWindow", subrole: sub, name: "Open", children: [
                CUNode(ref: 2, role: "AXStaticText", name: "Choose a file"), CUNode(ref: 3, role: "AXButton", name: "Cancel"),
            ])
            XCTAssertNil(CUWaitEvaluator.dialogNote([w], focusedRef: 3), sub)
            XCTAssertEqual(CUWaitEvaluator.seen(CUWaitEvaluator.Observation(roots: [w], windowTitle: "Open", focusedRef: 3)),
                           "window \"Open\" · 3 elements · focused [3]")
        }
    }

    /// The review: a login form wrapped in a named group (the page's only content, the focus in it) is no dialog; the
    /// shape rule needs a small group with a button, the focus and nothing to type into — or a dialog-like name.
    func testALoginFormInANamedGroupIsNoDialog() {
        func form(_ name: String) -> CUNode {
            CUNode(ref: 40, role: "AXGroup", name: name, children: [
                CUNode(ref: 41, role: "AXTextField", name: "Email"),
                CUNode(ref: 42, role: "AXTextField", subrole: "AXSecureTextField", name: "Password"),
                CUNode(ref: 43, role: "AXButton", name: "Sign in"),
            ])
        }
        XCTAssertNil(CUWaitEvaluator.dialogNote([Self.storeWindow([form("Sign in")])], focusedRef: 41))
        XCTAssertTrue(CUWaitEvaluator.dialogNote([Self.storeWindow([form("Confirm sign-in dialog")])], focusedRef: nil)?
            .hasPrefix("the page shows only group \"Confirm sign-in dialog\" [40]") ?? false, "a dialog-like name with a button")
        let bare = CUNode(ref: 60, role: "AXGroup", name: "Alert settings", children: [CUNode(ref: 61, role: "AXStaticText", name: "None set")])
        XCTAssertNil(CUWaitEvaluator.dialogNote([Self.storeWindow([bare])], focusedRef: nil), "the name alone: no button, no focus")
        let big = CUNode(ref: 50, role: "AXGroup", name: "Results", children: (0..<12).map {
            CUNode(ref: 51 + $0, role: "AXButton", name: "r\($0)")
        })
        XCTAssertNil(CUWaitEvaluator.dialogNote([Self.storeWindow([big])], focusedRef: 51), "12 elements or more: a page, not a dialog")
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
