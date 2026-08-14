import XCTest
@testable import Norma

/// diff-tabs Task 11: the tab-strip kind-grouping accordion's pure math
/// (`Sources/AppShell/PanelStripLayout.swift`). No view is mounted anywhere in this file — the
/// strip's actual rendering is live-gate territory, same posture Task 10's `PanelDiffTab` suite
/// took; everything here is a value-in, value-out function.
///
/// **Derivation shared by every boundary test below (hand-computed, not code — the same discipline
/// `PanelMetricsTests.testTabPillWidthAtTwoTabsUsesTheSplitGapArithmetic` uses for the identical
/// reason: asserting a formula against its own definition would pass no matter what the formula
/// said).**
///
/// `panelTabStripOverhead(tabCount:)` = `panelTabPillInset`(9) + `(tabCount-1)` × `panelTabSpacing`(6)
/// + 2 × `panelNewTabButtonGap`(18) + `panelTabPillSize.height`(28) + `panelTrailingClusterWidth`(108)
/// = 6·tabCount + (9 − 6 + 36 + 28 + 108) = **6·tabCount + 175**.
///
/// `panelStripFitsFlat(tabCount, W)` ⟺ tabCount·`panelTabPillMinWidth`(64) + overhead(tabCount) ≤ W
/// ⟺ 64·tabCount + 6·tabCount + 175 ≤ W ⟺ **70·tabCount + 175 ≤ W**.
///
/// `panelStripLeavesGrouped(tabCount, W)` = `panelStripFitsFlat(tabCount + 1, W)` ⟺
/// **70·tabCount + 245 ≤ W**.
final class PanelStripLayoutTests: XCTestCase {

    // MARK: - fitsFlat: both sides of the enter boundary

    /// Boundary at 6 tabs: 70·6 + 175 = 595. `PanelMetricsTests.testTabPillWidthAtTwoTabsUses
    /// TheSplitGapArithmetic` already pins `overhead(2) == 187` independently (9+6+36+28+108) —
    /// `6·2+175 == 187` agrees with that pin, which is the cross-check that this derivation and the
    /// existing one are the SAME formula, not two that happen to agree today.
    func testFitsFlatEnterBoundaryAtSixTabs() {
        XCTAssertTrue(panelStripFitsFlat(tabCount: 6, availableWidth: 595),
                     "595 is exactly enough — 6 pills at the floor plus the reserved chrome fit")
        XCTAssertFalse(panelStripFitsFlat(tabCount: 6, availableWidth: 594),
                      "one point short must fail, not round down")
    }

    /// A second, independent tabCount proves the formula generalizes rather than being tuned to 6.
    /// Boundary at 3 tabs: 70·3 + 175 = 385.
    func testFitsFlatEnterBoundaryAtThreeTabs() {
        XCTAssertTrue(panelStripFitsFlat(tabCount: 3, availableWidth: 385))
        XCTAssertFalse(panelStripFitsFlat(tabCount: 3, availableWidth: 384))
    }

    /// Zero tabs never groups — there is nothing to lay out, mirroring `panelTabPillWidth`'s own
    /// `tabCount > 0` guard (`testTabPillWidthReturnsTheCapOnZeroTabsRatherThanDividingByZero`,
    /// `PanelMetricsTests.swift`) rather than asking the overhead formula to answer for a row with
    /// no pills in it (its `(tabCount - 1)` term would go negative).
    func testFitsFlatIsTrivialAtZeroTabs() {
        XCTAssertTrue(panelStripFitsFlat(tabCount: 0, availableWidth: 0))
    }

    // MARK: - leavesGrouped: the hysteresis boundary, and the band itself

    /// Boundary at 6 tabs: 70·6 + 245 = 665 — equivalently `panelStripFitsFlat(tabCount: 7, …)`'s
    /// own boundary (70·7 + 175 = 665), which is the `tabCount + 1` substitution made concrete.
    func testLeavesGroupedBoundaryAtSixTabs() {
        XCTAssertTrue(panelStripLeavesGrouped(tabCount: 6, availableWidth: 665))
        XCTAssertFalse(panelStripLeavesGrouped(tabCount: 6, availableWidth: 664))
    }

    /// Second independent tabCount, matching `testFitsFlatEnterBoundaryAtThreeTabs` above: at 3
    /// tabs the leaves-boundary is 70·3 + 245 = 455.
    func testLeavesGroupedBoundaryAtThreeTabs() {
        XCTAssertTrue(panelStripLeavesGrouped(tabCount: 3, availableWidth: 455))
        XCTAssertFalse(panelStripLeavesGrouped(tabCount: 3, availableWidth: 454))
    }

    /// **The hysteresis band itself, at 6 tabs: width 595...664 inclusive.** `fitsFlat(6, ·)` turns
    /// true at 595; `leavesGrouped(6, ·)` does not turn true until 665. Inside that gap the mode
    /// depends on which side you were already on — the entire reason `panelStripNextMode` takes a
    /// `current` mode instead of computing a fresh boolean every frame. 630 sits in the middle of
    /// the gap: both statements below are true of the SAME (tabCount, width) pair simultaneously.
    func testHysteresisBandAtSixTabsKeepsWhicheverModeItWasAlreadyIn() {
        XCTAssertTrue(panelStripFitsFlat(tabCount: 6, availableWidth: 630),
                     "a FLAT strip at 630 must stay flat — it already fits")
        XCTAssertFalse(panelStripLeavesGrouped(tabCount: 6, availableWidth: 630),
                      "yet a GROUPED strip at that same 630 must NOT leave — the band hasn't closed")
    }

    /// A grounded anchor at the app's REAL default width (`panelDefaultWidth`, 600) — not a
    /// synthetic number, matching this test file's habit of tying at least one pin to the actual
    /// shipped default (`PanelMetricsTests.testTwoTabsDoNotNeedToCompressAtTheDefaultWidth`'s own
    /// precedent). 70·6+175=595 ≤ 600 < 665=70·6+245, so 6 tabs fit flat at the default width and a
    /// 7th (70·7+175=665 > 600) is what actually engages grouping.
    func testGroupingEngagesAtTheDefaultWidthOnceASeventhTabOpens() {
        XCTAssertTrue(panelStripFitsFlat(tabCount: 6, availableWidth: panelDefaultWidth))
        XCTAssertFalse(panelStripFitsFlat(tabCount: 7, availableWidth: panelDefaultWidth))
    }

    /// **Why `panelStripFitsFlat` has to reimplement the boundary instead of reading
    /// `panelTabPillWidth`'s return value.** At 6 tabs, 594 and 595 are on OPPOSITE sides of the
    /// fits-flat boundary, yet `panelTabPillWidth` returns the IDENTICAL floored 64pt for both:
    /// share(594) = (594 − 211) / 6 = 63.8333… → clamped UP to the 64 floor; share(595) =
    /// (595 − 211) / 6 = 64.0 exactly → already AT the floor, clamped to the same 64. Both landing
    /// on 64 is not a bug in `panelTabPillWidth` (its job is "what width, floored" — it answers
    /// that correctly both times) but it does mean its output alone cannot distinguish "fits,
    /// exactly at the floor" from "doesn't fit, floored anyway" — which is exactly the distinction
    /// `panelStripFitsFlat` exists to make.
    func testPillWidthAloneCannotDistinguishFitsFlatFromFlooredNotFitting() {
        XCTAssertEqual(panelTabPillWidth(tabCount: 6, availableWidth: 594), panelTabPillMinWidth)
        XCTAssertEqual(panelTabPillWidth(tabCount: 6, availableWidth: 595), panelTabPillMinWidth,
                       "identical floored output to the 594 case above")
        XCTAssertFalse(panelStripFitsFlat(tabCount: 6, availableWidth: 594))
        XCTAssertTrue(panelStripFitsFlat(tabCount: 6, availableWidth: 595),
                     "yet only 595 actually fits without scrolling — panelTabPillWidth's return value alone cannot tell these apart")
    }

    // MARK: - panelStripNextMode: the transition, including the flat-mode-unchanged pin

    /// **The flat-mode-unchanged pin.** Flat stays flat when the row still fits — no compression
    /// math changed, no rendering path changed; `fallbackKind` is irrelevant here (nil proves it's
    /// never even consulted on this branch) since nothing is entering grouped mode. Render-path
    /// identity for `mode == .flat` is additionally pinned by `PanelMetricsTests` staying green
    /// UNEDITED by this task (see the task report) — this is the mode-transition half of that
    /// guarantee, not a restatement of `panelTabPillWidth`'s own numbers.
    func testFlatModeBelowTheThresholdIsUntouched() {
        let next = panelStripNextMode(current: .flat, tabCount: 6, availableWidth: 595, fallbackKind: nil)
        XCTAssertEqual(next, .flat)
    }

    /// Crossing the enter boundary from `.flat` picks up `fallbackKind` — the kind the brief's
    /// "initialized to the active tab's kind" rule supplies.
    func testFlatEntersGroupedAtTheFallbackKindWhenItNoLongerFits() {
        let next = panelStripNextMode(current: .flat, tabCount: 6, availableWidth: 594, fallbackKind: .diff)
        XCTAssertEqual(next, .grouped(expandedKind: .diff))
    }

    /// Defensive, not reachable in production (grouping only engages once `tabCount > 0`, and a
    /// non-empty `store.tabs` always resolves SOME fallback kind via `panelShownTab`) — but the
    /// function stays TOTAL rather than force-unwrapping: no kind to expand means staying flat
    /// rather than inventing one.
    func testFlatWithNoFallbackKindStaysFlatEvenIfItWouldOtherwiseGroup() {
        let next = panelStripNextMode(current: .flat, tabCount: 6, availableWidth: 594, fallbackKind: nil)
        XCTAssertEqual(next, .flat)
    }

    /// Inside the hysteresis band, an already-grouped mode keeps its OWN `expandedKind` — never
    /// resets to `fallbackKind` (passed here as a deliberately DIFFERENT kind, `.note`, to prove
    /// it's ignored on this branch: only a fresh flat→grouped entry ever consults it).
    func testGroupedStaysGroupedWithTheSameExpandedKindInsideTheBand() {
        let next = panelStripNextMode(current: .grouped(expandedKind: .web), tabCount: 6,
                                      availableWidth: 630, fallbackKind: .note)
        XCTAssertEqual(next, .grouped(expandedKind: .web))
    }

    /// Crossing the LEAVE boundary returns to flat outright — `fallbackKind` plays no role leaving.
    func testGroupedLeavesToFlatOnceThereIsRoomForOneMorePill() {
        let next = panelStripNextMode(current: .grouped(expandedKind: .web), tabCount: 6,
                                      availableWidth: 665, fallbackKind: nil)
        XCTAssertEqual(next, .flat)
    }

    /// **The width-0 trap, named in `panelStripNextMode`'s own doc.** A non-positive width is "no
    /// information" — the guard returns `current` unchanged, in BOTH directions: it must not
    /// spuriously ENTER grouped mode from flat (the case that traps the strip once a real width
    /// lands inside the hysteresis band), and, symmetrically, a transient 0 must not FLATTEN an
    /// already-grouped strip either.
    func testNonPositiveWidthNeverTransitionsEitherDirection() {
        XCTAssertEqual(panelStripNextMode(current: .flat, tabCount: 6, availableWidth: 0, fallbackKind: .web),
                       .flat, "must not spuriously enter grouped from a zero-width first pass")
        XCTAssertEqual(panelStripNextMode(current: .flat, tabCount: 6, availableWidth: -1, fallbackKind: .web),
                       .flat, "negative is equally nonsense")
        XCTAssertEqual(panelStripNextMode(current: .grouped(expandedKind: .web), tabCount: 6,
                                          availableWidth: 0, fallbackKind: nil),
                       .grouped(expandedKind: .web), "must not spuriously flatten an already-grouped strip either")
    }

    /// **The concrete trap this guard closes, played out as the two real `.onChange` firings would
    /// see it.** `GeometryReader`'s first layout pass reports 0; `.onChange(…, initial: true)` fires
    /// on exactly that pass. Without the guard: `panelStripNextMode(.flat, 6, 0, …)` would read
    /// `!panelStripFitsFlat(6, 0)` as true and enter `.grouped`; the real 600pt width then arrives,
    /// but 600 sits INSIDE the 6-tab hysteresis band (595...664) — `panelStripLeavesGrouped(6, 600)`
    /// is false, so the strip would stay grouped FOREVER at the app's own default width, where flat
    /// plainly fits (`testGroupingEngagesAtTheDefaultWidthOnceASeventhTabOpens` above). With the
    /// guard, the first (0-width) call is a no-op — `current` (`.flat`, the `@State` default) passes
    /// through unchanged — and the second call evaluates cleanly against the real width.
    func testWidthZeroFirstPassThenTheRealDefaultWidthNeverGetsStuckGrouped() {
        let afterSpuriousZero = panelStripNextMode(current: .flat, tabCount: 6, availableWidth: 0,
                                                    fallbackKind: .web)
        let afterRealWidth = panelStripNextMode(current: afterSpuriousZero, tabCount: 6,
                                                availableWidth: panelDefaultWidth, fallbackKind: .web)
        XCTAssertEqual(afterRealWidth, .flat,
                       "6 tabs at the real 600pt default must end up flat, not stuck grouped")
    }

    // MARK: - panelStripKindGroups: first-open order, stability, one-tab kinds

    /// Kinds cluster in FIRST-OPEN order (web before code before note — the order each kind first
    /// appears while scanning), each kind's own tabs kept in their original relative order.
    func testKindGroupsPreserveFirstOpenOrderAndPerKindTabOrder() {
        let tabs = [
            PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
            PanelTab(tabId: "t2", kind: .code, url: nil, title: nil),
            PanelTab(tabId: "t3", kind: .web, url: nil, title: nil),
            PanelTab(tabId: "t4", kind: .note, url: nil, title: nil),
            PanelTab(tabId: "t5", kind: .code, url: nil, title: nil),
        ]
        let groups = panelStripKindGroups(tabs: tabs)
        XCTAssertEqual(groups.map(\.kind), [.web, .code, .note])
        XCTAssertEqual(groups.map { $0.tabs.map(\.tabId) }, [["t1", "t3"], ["t2", "t5"], ["t4"]])
    }

    /// The brief's own uniformity requirement, pinned directly: a kind seen exactly once groups
    /// like any other — no branch in `panelStripKindGroups` treats a 1-tab bucket specially, and
    /// this asserts the shape rather than trusting the implementation reads that way by eye.
    func testOneTabKindsGroupLikeAnyOther() {
        let tabs = [
            PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
            PanelTab(tabId: "t2", kind: .diff, url: nil, title: "engine.ts", diffId: "diff_1"),
        ]
        let groups = panelStripKindGroups(tabs: tabs)
        XCTAssertEqual(groups.map(\.kind), [.web, .diff])
        XCTAssertEqual(groups.first { $0.kind == .diff }?.tabs.count, 1)
    }

    /// Stability across a re-fold: appending another tab of an ALREADY-SEEN kind does not move that
    /// kind's position in the order (web stays first), while appending a tab of a BRAND NEW kind
    /// appends a new group at the end — never re-sorted, never re-inserted earlier.
    func testKindGroupOrderIsStableAsMoreTabsAreFolded() {
        let base = [
            PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
            PanelTab(tabId: "t2", kind: .code, url: nil, title: nil),
        ]
        let anotherWebTab = base + [PanelTab(tabId: "t3", kind: .web, url: nil, title: nil)]
        XCTAssertEqual(panelStripKindGroups(tabs: anotherWebTab).map(\.kind), [.web, .code])

        let aNewKind = base + [PanelTab(tabId: "t3", kind: .diff, url: nil, title: nil)]
        XCTAssertEqual(panelStripKindGroups(tabs: aNewKind).map(\.kind), [.web, .code, .diff])
    }

    // MARK: - panelStripEffectiveExpandedKind / panelStripIsExpanded

    private let webDiffFixture = [
        PanelTab(tabId: "t1", kind: .web, url: nil, title: nil),
        PanelTab(tabId: "t2", kind: .web, url: nil, title: nil),
        PanelTab(tabId: "t3", kind: .diff, url: nil, title: "a.ts", diffId: "d1"),
    ]

    func testEffectiveExpandedKindResolvesAPresentKindDirectly() {
        let groups = panelStripKindGroups(tabs: webDiffFixture)
        XCTAssertEqual(panelStripEffectiveExpandedKind(mode: .grouped(expandedKind: .web), groups: groups), .web)
        XCTAssertTrue(panelStripIsExpanded(.web, mode: .grouped(expandedKind: .web), groups: groups))
        XCTAssertFalse(panelStripIsExpanded(.diff, mode: .grouped(expandedKind: .web), groups: groups))
    }

    /// `.flat` has nothing expanded — no group renders as pills, so every group's chip shows.
    func testFlatModeExpandsNothing() {
        let groups = panelStripKindGroups(tabs: webDiffFixture)
        XCTAssertNil(panelStripEffectiveExpandedKind(mode: .flat, groups: groups))
        XCTAssertFalse(panelStripIsExpanded(.web, mode: .flat, groups: groups))
        XCTAssertFalse(panelStripIsExpanded(.diff, mode: .flat, groups: groups))
    }

    /// **The stale-kind heal.** `mode` claims `.note` is expanded, but `groups` (freshly recomputed
    /// from the CURRENT `store.tabs`) has no `.note` group at all — the last note tab closed without
    /// `mode` itself being told. Without this fallback every group in `groups` would render
    /// collapsed simultaneously, violating "exactly ONE kind expanded" the moment it happens; with
    /// it, the first remaining group (`.web`, first-open order) takes over until the next real
    /// transition corrects `mode` for good.
    func testStaleExpandedKindFallsBackToTheFirstRemainingGroup() {
        let groups = panelStripKindGroups(tabs: webDiffFixture)  // [.web, .diff] — no .note group
        XCTAssertEqual(panelStripEffectiveExpandedKind(mode: .grouped(expandedKind: .note), groups: groups), .web)
        XCTAssertTrue(panelStripIsExpanded(.web, mode: .grouped(expandedKind: .note), groups: groups))
    }

    // MARK: - chip click: swaps which kind is expanded, exactly one at a time

    /// Clicking a DIFFERENT kind's chip both expands it AND collapses whatever was expanded before
    /// — not two effects to keep in sync, but one consequence of there being only one
    /// `expandedKind` slot in `PanelStripMode.grouped`.
    func testChipClickSwapsWhichKindIsExpanded() {
        let groups = panelStripKindGroups(tabs: webDiffFixture)
        let afterOpeningWeb = PanelStripMode.grouped(expandedKind: .web)
        XCTAssertTrue(panelStripIsExpanded(.web, mode: afterOpeningWeb, groups: groups))
        XCTAssertFalse(panelStripIsExpanded(.diff, mode: afterOpeningWeb, groups: groups))

        let afterClickingDiffChip = panelStripExpand(.diff)
        XCTAssertEqual(afterClickingDiffChip, .grouped(expandedKind: .diff))
        XCTAssertTrue(panelStripIsExpanded(.diff, mode: afterClickingDiffChip, groups: groups))
        XCTAssertFalse(panelStripIsExpanded(.web, mode: afterClickingDiffChip, groups: groups))
    }

    // MARK: - auto-expand: activeTabId moving to a collapsed kind

    /// The brief's own scenario: `activeTabId` moves to a tab of a kind that is currently collapsed
    /// — that kind takes over the expansion.
    func testAutoExpandSwapsToTheNewlyActiveTabsKindWhenItWasCollapsed() {
        let next = panelStripAutoExpand(mode: .grouped(expandedKind: .web), newActiveKind: .diff)
        XCTAssertEqual(next, .grouped(expandedKind: .diff))
    }

    /// Idempotent: the newly active tab is already of the EXPANDED kind (e.g. activating a second
    /// web tab while a web tab is already showing) — no change, so no spurious re-animation.
    func testAutoExpandIsANoOpWhenTheNewlyActiveKindIsAlreadyExpanded() {
        let next = panelStripAutoExpand(mode: .grouped(expandedKind: .web), newActiveKind: .web)
        XCTAssertEqual(next, .grouped(expandedKind: .web))
    }

    /// Flat has nothing collapsed to auto-expand — a no-op, not a spurious entry into grouped mode
    /// (only `panelStripNextMode`'s width/tabCount transition ever does that).
    func testAutoExpandIsANoOpWhileFlat() {
        let next = panelStripAutoExpand(mode: .flat, newActiveKind: .diff)
        XCTAssertEqual(next, .flat)
    }
}
