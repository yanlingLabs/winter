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
