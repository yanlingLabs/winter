import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// sidebar-brand: the brand palette's catalog wiring, the shared Recents row filter, and the
/// search palette's pure helpers. Same posture as `AppShellTests` — the PURE decision helpers are
/// exercised directly; SwiftUI bodies are deliberately NOT, per this codebase's convention (see
/// `DashboardTests`' own file doc).
@MainActor
final class SidebarBrandTests: XCTestCase {
    // MARK: - T1: the asset catalog is really wired

    /// The one failure mode here that is otherwise SILENT: a misspelled asset name, or a colorset
    /// missing from the catalog, renders a fallback color at runtime with no error anywhere.
    /// `NSColor(named:)` resolves against `Bundle.main`, which under this bundle's `TEST_HOST` is
    /// the real app bundle — so this pin proves the catalog compiled INTO the app, not merely
    /// that the JSON files exist on disk.
    func testEveryThemeColorResolvesInTheAssetCatalog() {
        for name in Theme.assetColorNames {
            XCTAssertNotNil(
                NSColor(named: name),
                "\(name) is missing from Assets.xcassets, or misspelled in Theme")
        }
    }

    /// The list is meant to be TOTAL — every color `Theme` names appears in it, or the pin above
    /// silently stops covering the ones it forgot. Bump deliberately when adding a token.
    func testThemeAssetColorNameListIsComplete() {
        XCTAssertEqual(Theme.assetColorNames.count, 14)
        XCTAssertEqual(Set(Theme.assetColorNames).count, 14, "no duplicates")
    }

    /// The plane mapping (`docs/brand.md`): the content card must be BRIGHTER than the sidebar
    /// base in BOTH appearances — that difference IS the sidebar/content separation. A future
    /// palette tune that inverted it would make the whole shell read inside-out, and nothing else
    /// in the suite would notice.
    func testCardSurfaceIsBrighterThanCanvasInBothAppearances() {
        for appearance in [NSAppearance(named: .aqua)!, NSAppearance(named: .darkAqua)!] {
            var canvasBrightness: CGFloat = 0
            var cardBrightness: CGFloat = 0
            appearance.performAsCurrentDrawingAppearance {
                canvasBrightness = Self.brightness(of: NSColor(named: "Canvas")!)
                cardBrightness = Self.brightness(of: NSColor(named: "CardSurface")!)
            }
            XCTAssertGreaterThan(
                cardBrightness, canvasBrightness,
                "CardSurface must be brighter than Canvas in \(appearance.name.rawValue)")
        }
    }

    private static func brightness(of color: NSColor) -> CGFloat {
        let rgb = color.usingColorSpace(.sRGB)!
        return 0.299 * rgb.redComponent + 0.587 * rgb.greenComponent + 0.114 * rgb.blueComponent
    }

    // MARK: - T2: the ONE shared Recents row filter (spec R6)

    private func summary(_ id: String, mode: String?, activity: String? = nil,
                         parent: String? = nil, createdAt: Int = 0) -> SessionSummary {
        SessionSummary(sessionId: id, title: id, createdAt: createdAt, scope: "global",
                       cwd: nil, mode: mode, parentSessionId: parent, activity: activity)
    }

    /// R6: the ONE permanent dispatch session is reached only through its own sidebar row, so it
    /// belongs in no list of recent things.
    func testExcludingDispatchDropsTheDispatchSingleton() {
        let rows = [summary("s_chat", mode: "chat"),
                    summary("s_dispatch", mode: "dispatch"),
                    summary("s_code", mode: "code")]
        XCTAssertEqual(excludingDispatch(rows).map(\.sessionId), ["s_chat", "s_code"])
    }

    /// Dispatch CHILDREN are created as `mode: "code"` with `origin: "dispatch-child"`
    /// (`packages/core/src/agent/dispatch-children.ts`) — real code sessions with real work. The
    /// filter must not swallow them: it targets the SINGLETON, not the feature.
    func testExcludingDispatchKeepsDispatchChildren() {
        let rows = [summary("s_child", mode: "code", parent: "s_dispatch"),
                    summary("s_dispatch", mode: "dispatch")]
        XCTAssertEqual(excludingDispatch(rows).map(\.sessionId), ["s_child"])
    }

    /// `SessionMode(wire:)` reads nil and any unknown value as `.code` — so absence is never
    /// mistaken for dispatch, and no row is ever hidden by accident.
    func testExcludingDispatchKeepsModelessAndUnknownRows() {
        let rows = [summary("s_nil", mode: nil), summary("s_future", mode: "teleporting")]
        XCTAssertEqual(excludingDispatch(rows).map(\.sessionId), ["s_nil", "s_future"])
    }

    /// The composed entry point is what BOTH surfaces call — it must apply both exclusions.
    func testRecentsCandidatesDropsArchivedAndDispatchAndPreservesOrder() {
        let rows = [summary("s_a", mode: "code"),
                    summary("s_archived", mode: "code", activity: "archived"),
                    summary("s_dispatch", mode: "dispatch"),
                    summary("s_b", mode: "chat")]
        XCTAssertEqual(recentsCandidates(rows).map(\.sessionId), ["s_a", "s_b"],
                       "order is the caller's, never re-sorted")
    }

    func testRecentsCandidatesIsTotalOnEmptyAndAllExcluded() {
        XCTAssertEqual(recentsCandidates([]).count, 0)
        XCTAssertEqual(recentsCandidates([summary("s_dispatch", mode: "dispatch")]).count, 0)
    }

    // MARK: - T3: the search palette's pure helpers

    /// `SessionSummary.createdAt` is epoch MILLISECONDS (every existing call site divides by
    /// 1000) — reading it as seconds would bucket every session as "Older", silently and
    /// uniformly. `now` is injected so this pin is not clock-dependent.
    func testRelativeTimeBucketReadsMillisecondsAndBucketsCoarsely() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func bucket(daysAgo: Double) -> String {
            let ms = Int((now.timeIntervalSince1970 - daysAgo * 86_400) * 1000)
            return relativeTimeBucket(createdAt: ms, now: now)
        }
        XCTAssertEqual(bucket(daysAgo: 0), "Today")
        XCTAssertEqual(bucket(daysAgo: 0.9), "Today")
        XCTAssertEqual(bucket(daysAgo: 3), "Past week")
        XCTAssertEqual(bucket(daysAgo: 20), "Past month")
        XCTAssertEqual(bucket(daysAgo: 200), "Past year")
        XCTAssertEqual(bucket(daysAgo: 900), "Older")
    }

    /// A row stamped in the FUTURE (clock skew between the daemon's host and this Mac is
    /// ordinary) must not fall off the bottom into "Older" — it is the newest thing we know of.
    func testRelativeTimeBucketTreatsFutureStampsAsToday() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let future = Int((now.timeIntervalSince1970 + 3600) * 1000)
        XCTAssertEqual(relativeTimeBucket(createdAt: future, now: now), "Today")
    }

    /// Clamped, never wrapping: ↓ on the last row stays put rather than jumping to the top.
    func testSearchPaletteMoveSelectionClampsAtBothEnds() {
        XCTAssertEqual(searchPaletteMoveSelection(current: 0, count: 5, delta: 1), 1)
        XCTAssertEqual(searchPaletteMoveSelection(current: 4, count: 5, delta: 1), 4)
        XCTAssertEqual(searchPaletteMoveSelection(current: 0, count: 5, delta: -1), 0)
        XCTAssertEqual(searchPaletteMoveSelection(current: 3, count: 5, delta: -1), 2)
    }

    /// Total on an empty result set — the palette shows "No matches", and the arrow keys must not
    /// produce an index that would crash the row lookup.
    func testSearchPaletteMoveSelectionIsSafeOnEmptyResults() {
        XCTAssertEqual(searchPaletteMoveSelection(current: 0, count: 0, delta: 1), 0)
        XCTAssertEqual(searchPaletteMoveSelection(current: 3, count: 0, delta: -1), 0)
    }

    /// A STALE selection index — the query narrowed the list out from under it — must be clamped
    /// back into range, not left pointing past the end. `delta: 0` is the re-clamp call.
    func testSearchPaletteMoveSelectionClampsAStaleIndex() {
        XCTAssertEqual(searchPaletteMoveSelection(current: 9, count: 3, delta: 0), 2)
    }
}
