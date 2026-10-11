import XCTest
@testable import WinterCUCore

/// Diffs between snapshots and `changedRatio` (spine §4, spec §6.3–6.4).
final class StateDiffTests: XCTestCase {
    private func snap(_ id: String, _ children: [CUNode], focused: Int? = nil, title: String = "Groceries") -> CUSnapshot {
        CUSnapshot(id: id, scope: nil,
                   header: CUStateHeader(appName: "Notes", windowTitle: title, focusedRef: focused, settle: .settled(ms: 80)),
                   roots: [CUNode(ref: 1, role: "AXWindow", name: title, children: children)])
    }

    func testSpineExampleDiff() {
        let old = snap("s1", [
            CUNode(ref: 13, role: "AXRow", name: "Ideas"),
            CUNode(ref: 14, role: "AXTextArea", value: "milk, eggs", states: .focused),
            CUNode(ref: 15, role: "AXButton", name: "A"), CUNode(ref: 16, role: "AXButton", name: "B"),
            CUNode(ref: 17, role: "AXButton", name: "C"), CUNode(ref: 18, role: "AXButton", name: "D"),
        ], focused: 14)
        let new = snap("s2", [
            CUNode(ref: 14, role: "AXTextArea", value: "milk, eggs, bread", states: .focused),
            CUNode(ref: 15, role: "AXButton", name: "A"), CUNode(ref: 16, role: "AXButton", name: "B"),
            CUNode(ref: 17, role: "AXButton", name: "C"), CUNode(ref: 18, role: "AXButton", name: "D"),
            CUNode(ref: 27, role: "AXButton", name: "Delete Note"),
        ], focused: 14)
        let d = CUStateDiff.compute(old: old, new: new)
        XCTAssertEqual(d.added, [27])
        XCTAssertEqual(d.removed, [13])
        XCTAssertEqual(d.modified, [14])
        XCTAssertEqual(d.render(header: new.header, new: new, includeWindowTitle: false), """
        Notes — focused [14] · settled 80 ms
        + [27] button "Delete Note"
        ~ [14] value "milk, eggs" → "milk, eggs, bread"
        - [13]
        """)
        // 3 changed of 8 distinct elements (window + 13…18 + 27).
        XCTAssertEqual(d.changedRatio, 3.0 / 8.0, accuracy: 1e-9)
    }

    // MARK: what the model was shown (review of round 2, MEDIUM)

    /// A window 600 pt tall whose scroll area holds 120 rows of 20 pt, scrolled down by `offset`; row 7's value `v7`.
    private func page(offset: Double, v7: String = "a") -> [CUNode] {
        let rows = (0..<120).map { i in
            CUNode(ref: 100 + i, role: "AXTextField", name: "Row \(i)", value: i == 7 ? v7 : "x",
                   frame: CGRect(x: 10, y: 50 + Double(i) * 20 - offset, width: 300, height: 18))
        }
        return [CUNode(ref: 1, role: "AXWindow", name: "Doc", frame: CGRect(x: 0, y: 0, width: 400, height: 600), children: [
            CUNode(ref: 2, role: "AXScrollArea", frame: CGRect(x: 0, y: 40, width: 400, height: 560), children: [
                CUNode(ref: 3, role: "AXGroup", name: "List", frame: CGRect(x: 0, y: 50 - offset, width: 400, height: 2400), children: rows),
            ]),
        ])]
    }

    private func printedSnap(_ id: String, _ roots: [CUNode], _ f: CUStateFormatter) -> (CUSnapshot, Set<Int>) {
        let h = CUStateHeader(appName: "Doc", windowTitle: "Doc", focusedRef: nil, settle: nil)
        let p = f.printed(header: h, roots: roots, viewportFirst: true)
        return (CUSnapshot(id: id, scope: nil, header: h, roots: roots, formatter: f, shown: p.shown), p.shown)
    }

    func testContentScrolledIntoViewIsSurfacedNotNoChanges() {
        let f = CUStateFormatter(lineCap: 40)
        let (base, baseShown) = printedSnap("s1", page(offset: 0), f)
        XCTAssertTrue(baseShown.contains(100) && !baseShown.contains(150), "the base showed the top rows only")
        let (now, nowShown) = printedSnap("s2", page(offset: 1000), f)  // scrolled: rows 48… are in view now
        let d = CUStateDiff.compute(old: base, new: now, shownNow: nowShown)
        XCTAssertTrue(d.added.isEmpty && d.removed.isEmpty && d.modified.isEmpty, "nothing changed")
        XCTAssertFalse(d.isEmpty, "but rows came into view")
        XCTAssertTrue(d.surfaced.contains(150))
        let text = d.render(header: now.header, new: now, includeWindowTitle: false, formatter: f, seen: base.shown)
        XCTAssertFalse(text.contains("(no changes)"), text)
        XCTAssertTrue(text.contains("+ [150] text field \"Row 50\" value=\"x\" — now shown, in [3] group \"List\""), text)
        // Once printed, they count as seen: the same view again is "(no changes)".
        var seenNow = now
        seenNow.shown = d.rendered(header: now.header, new: now, includeWindowTitle: false, formatter: f, seen: base.shown).shown
        let (again, againShown) = printedSnap("s3", page(offset: 1000), f)
        let d2 = CUStateDiff.compute(old: seenNow, new: again, shownNow: againShown)
        XCTAssertTrue(d2.isEmpty)
    }

    func testAChangeUnderAFoldPrintsWithItsContext() {
        let f = CUStateFormatter(lineCap: 40)
        let (base, _) = printedSnap("s1", page(offset: 1000), f)  // row 7 out of view: never shown
        XCTAssertFalse(base.shown?.contains(107) ?? true)
        let (now, nowShown) = printedSnap("s2", page(offset: 1000, v7: "b"), f)
        let d = CUStateDiff.compute(old: base, new: now, shownNow: nowShown)
        XCTAssertEqual(d.modified, [107])
        XCTAssertEqual(d.unseen, [107])
        let text = d.render(header: now.header, new: now, includeWindowTitle: false, formatter: f, seen: base.shown)
        XCTAssertTrue(text.contains("~ [107] value \"a\" → \"b\" — [107] text field \"Row 7\" value=\"b\", in [3] group \"List\""), text)
    }

    func testASnapshotWithNoPrintKeepsTheOldBehaviour() {
        let a = snap("a", [CUNode(ref: 5, role: "AXButton", name: "Send")])
        let b = snap("b", [CUNode(ref: 5, role: "AXButton", name: "Send")])
        XCTAssertNil(a.shown)
        let d = CUStateDiff.compute(old: a, new: b, shownNow: [1, 5])
        XCTAssertTrue(d.isEmpty, "no shown set on the base: everything counts as seen")
    }

    func testFacetChangesAreJoinedInOrder() {
        let old = snap("a", [CUNode(ref: 5, role: "AXButton", name: "Send", states: .disabled, actions: ["AXPress"])])
        let new = snap("b", [CUNode(ref: 5, role: "AXButton", name: "Send now", states: [], actions: ["AXPress", "AXShowMenu"])])
        let d = CUStateDiff.compute(old: old, new: new)
        XCTAssertEqual(d.changes[5], ["name \"Send\" → \"Send now\"", "states (disabled) → ()", "actions none → show menu"])
    }

    func testSecureValueChangesNeverLeak() {
        let old = snap("a", [CUNode(ref: 5, role: "AXTextField", subrole: "AXSecureTextField", value: "abc")])
        let new = snap("b", [CUNode(ref: 5, role: "AXTextField", subrole: "AXSecureTextField", value: "abcd")])
        let d = CUStateDiff.compute(old: old, new: new)
        XCTAssertTrue(d.isEmpty, "a secure field's printed value is always <redacted>, so it never differs")
    }

    func testNoChanges() {
        let a = snap("a", [CUNode(ref: 2, role: "AXButton", name: "OK")])
        let b = snap("b", [CUNode(ref: 2, role: "AXButton", name: "OK")])
        let d = CUStateDiff.compute(old: a, new: b)
        XCTAssertTrue(d.isEmpty)
        XCTAssertEqual(d.changedRatio, 0)
        XCTAssertEqual(d.render(header: b.header, new: b, includeWindowTitle: false), "Notes — settled 80 ms\n(no changes)")
    }

    func testChangedRatioAboveHalfWhenMostLinesChange() {
        let a = snap("a", (2...5).map { CUNode(ref: $0, role: "AXButton", name: "x\($0)") })
        let b = snap("b", (6...9).map { CUNode(ref: $0, role: "AXButton", name: "y\($0)") })
        let d = CUStateDiff.compute(old: a, new: b)
        // 4 added + 4 removed of 9 distinct (window shared).
        XCTAssertEqual(d.changedRatio, 8.0 / 9.0, accuracy: 1e-9)
        XCTAssertGreaterThan(d.changedRatio, 0.5)
    }

    func testWindowTitleChangeShowsInDiffHeader() {
        let a = snap("a", [CUNode(ref: 2, role: "AXButton", name: "OK")], title: "One")
        let b = snap("b", [CUNode(ref: 2, role: "AXButton", name: "OK")], title: "Two")
        let d = CUStateDiff.compute(old: a, new: b)
        XCTAssertTrue(d.render(header: b.header, new: b, includeWindowTitle: true).hasPrefix("Notes — window \"Two\" · settled 80 ms"))
    }

    /// Review of round 3: refs whose lines the cap cut were recorded as shown, and read "(no changes)" until they
    /// changed. Only the lines the text keeps are seen; the next diff surfaces the rest.
    func testRefsTheCapCutAreNotCountedAsSeen() {
        let f = CUStateFormatter(lineCap: 10)
        var a = snap("a", [CUNode(ref: 1, role: "AXButton", name: "Keep")])
        a.shown = [1]
        let rows = (2...40).map { CUNode(ref: $0, role: "AXButton", name: "n\($0)") }
        var b = snap("b", [CUNode(ref: 1, role: "AXButton", name: "Keep")] + rows)
        let d = CUStateDiff.compute(old: a, new: b)
        let r = d.rendered(header: b.header, new: b, includeWindowTitle: false, formatter: f, seen: a.shown)
        XCTAssertTrue(r.text.hasSuffix("… (29 more changes — state({full:true}))"), r.text)
        XCTAssertEqual(r.shown, Set([1] + Array(2...11)), "the ten lines kept, and what the base showed")
        b.shown = r.shown
        let c = snap("c", [CUNode(ref: 1, role: "AXButton", name: "Keep")] + rows)
        let d2 = CUStateDiff.compute(old: b, new: c, shownNow: Set(1...40))
        XCTAssertEqual(d2.surfaced, Array(12...40), "never “(no changes)” for lines the model never saw")
    }

    /// Review of round 3: on a big folded page a scroll surfaced row after row while the union of every ref kept the
    /// ratio under 0.5 — the diff became a list longer than the print. Against a folded print, the new lines' share of
    /// what the print shows counts: a whole new screen of rows is the state again.
    func testABigScrollOnAFoldedPageIsThePrintNotAListOfRows() {
        let f = CUStateFormatter(lineCap: 40)
        let (base, _) = printedSnap("s1", page(offset: 0), f)
        let (now, nowShown) = printedSnap("s2", page(offset: 1000), f)
        let d = CUStateDiff.compute(old: base, new: now, shownNow: nowShown)
        let union = Double(d.surfaced.count) / Double(Set(base.order).union(now.order).count)
        XCTAssertLessThan(union, 0.5, "by the union alone it would have been a diff")
        XCTAssertGreaterThan(d.changedRatio, 0.5, "\(d.surfaced.count) rows surfaced of \(nowShown.count) shown: the print")
        // A small scroll stays a diff.
        let (near, nearShown) = printedSnap("s3", page(offset: 60), f)
        XCTAssertLessThanOrEqual(CUStateDiff.compute(old: base, new: near, shownNow: nearShown).changedRatio, 0.5)
    }

    /// Review of round 3 (LOW): when the state is printed instead of a diff, what the base had shown and is still there
    /// unchanged stays seen (it was "surfaced" again later) — a row changed meanwhile does not.
    func testWhatTheBaseShowedStaysSeenAfterAPrint() {
        let f = CUStateFormatter(lineCap: 40)
        let (base, baseShown) = printedSnap("s1", page(offset: 0), f)
        XCTAssertTrue(baseShown.contains(100) && baseShown.contains(107))
        var (now, nowShown) = printedSnap("s2", page(offset: 1000, v7: "b"), f)
        let d = CUStateDiff.compute(old: base, new: now, shownNow: nowShown)
        XCTAssertGreaterThan(d.changedRatio, 0.5, "printed")
        now.shown = d.shownAfterPrint(old: base, new: now, printed: nowShown)
        XCTAssertTrue(now.shown?.contains(100) ?? false, "seen at the top, folded now: still seen")
        XCTAssertFalse(now.shown?.contains(107) ?? true, "changed while folded: not seen as it is")
        let (back, backShown) = printedSnap("s3", page(offset: 0, v7: "b"), f)
        let d2 = CUStateDiff.compute(old: now, new: back, shownNow: backShown)
        XCTAssertFalse(d2.surfaced.contains(100), "never re-surfaced")
        XCTAssertTrue(d2.surfaced.contains(107), "the changed one is shown as it is now")
    }

    func testDiffLinesAreCapped() {
        let a = snap("a", [])
        let b = snap("b", (2...40).map { CUNode(ref: $0, role: "AXButton", name: "n\($0)") })
        let d = CUStateDiff.compute(old: a, new: b)
        let text = d.render(header: b.header, new: b, includeWindowTitle: false, formatter: CUStateFormatter(lineCap: 10))
        let lines = text.split(separator: "\n")
        XCTAssertEqual(lines.count, 1 + 10 + 1)
        XCTAssertEqual(lines.last, "… (29 more changes — state({full:true}))")
    }
}
