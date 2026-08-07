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

    // MARK: - The sidebar toggle + window chrome

    /// The toggle STATES the sidebar's condition rather than naming the action, so the two glyphs
    /// must actually differ — one symbol in two tints would leave the button ambiguous exactly
    /// when it matters most: once the pane it refers to is off-screen.
    func testSidebarToggleGlyphDiffersBetweenStates() {
        let shown = shellSidebarToggleSystemImage(isVisible: true)
        let hidden = shellSidebarToggleSystemImage(isVisible: false)
        XCTAssertNotEqual(shown, hidden, "the two states must be visually distinguishable")
    }

    /// Both glyphs must exist on this OS — a missing SF Symbol renders as a blank box with no
    /// error anywhere, which is precisely the kind of silent failure a name typo produces.
    func testSidebarToggleGlyphsResolveAsRealSymbols() {
        for name in [shellSidebarToggleSystemImage(isVisible: true),
                     shellSidebarToggleSystemImage(isVisible: false)] {
            XCTAssertNotNil(NSImage(systemSymbolName: name, accessibilityDescription: nil),
                            "\(name) is not a real SF Symbol on this OS")
        }
    }

    /// The help/accessibility text names the ACTION (complementing the glyph's state), so it must
    /// invert relative to the glyph — "Hide sidebar" while it is showing.
    func testSidebarToggleLabelNamesTheAction() {
        XCTAssertEqual(shellSidebarToggleLabel(isVisible: true), "Hide sidebar")
        XCTAssertEqual(shellSidebarToggleLabel(isVisible: false), "Show sidebar")
    }

    /// The toggle must clear the traffic lights, or it sits under them and is unclickable. The
    /// three buttons plus their inset occupy roughly 80 pt; this pins the ordering relationship
    /// rather than the exact figures, both of which stay tune-at-gate.
    func testSidebarToggleClearsTheTrafficLights() {
        XCTAssertGreaterThan(shellSidebarToggleLeadingInset, 80,
                             "the toggle must start beyond the three window buttons")
        XCTAssertGreaterThan(shellTrafficLightInset.x, 0, "inset moves the lights inward, not out")
        XCTAssertGreaterThan(shellTrafficLightInset.y, 0, "…and downward")
    }

    /// The showing state is ChatGPT's own glyph (user call: "use the same drawer icon ChatGPT is
    /// using"). Pinned by NAME, because "which symbol" is the whole instruction here — a future
    /// tidy-up that swapped it for a lookalike would quietly undo the ask.
    func testSidebarToggleUsesTheReferenceGlyphWhileShowing() {
        XCTAssertEqual(shellSidebarToggleSystemImage(isVisible: true), "sidebar.left")
    }

    /// TRUE ARROWS, not chevrons (user correction, 2026-08-07, confirmed by cropping the
    /// reference's titlebar). Pinned by name because "which symbol" was the instruction.
    func testTitlebarNavigationUsesRealArrowsNotChevrons() {
        XCTAssertEqual(shellTitlebarNavigationGlyphs, ["arrow.left", "arrow.right"])
    }

    /// Every titlebar glyph — both clusters — must resolve, or it renders as a blank box with no
    /// error anywhere.
    func testEveryTitlebarGlyphResolvesAsARealSymbol() {
        let all = shellTitlebarNavigationGlyphs + shellTitlebarTrailingGlyphs
            + [shellSidebarToggleSystemImage(isVisible: true),
               shellSidebarToggleSystemImage(isVisible: false)]
        for name in all {
            XCTAssertNotNil(NSImage(systemSymbolName: name, accessibilityDescription: nil),
                            "\(name) is not a real SF Symbol on this OS")
        }
    }

    /// The trailing cluster mirrors the reference's top-right corner: three icons, no duplicates.
    func testTrailingClusterIsThreeDistinctGlyphs() {
        XCTAssertEqual(shellTitlebarTrailingGlyphs.count, 3)
        XCTAssertEqual(Set(shellTitlebarTrailingGlyphs).count, 3)
    }

    /// Every trailing placeholder says it is not wired, so hovering one cannot promise a feature
    /// that does not exist — and the mapping is TOTAL, so an added glyph still gets a label.
    func testTrailingPlaceholderLabelsDiscloseTheyAreNotWired() {
        for glyph in shellTitlebarTrailingGlyphs {
            let label = shellTitlebarTrailingLabel(glyph)
            XCTAssertTrue(label.contains("not wired"), "\(glyph)'s label must disclose: \(label)")
        }
        XCTAssertFalse(shellTitlebarTrailingLabel("some.future.glyph").isEmpty,
                       "the mapping is total — an unknown glyph still gets a label")
    }

    /// Both clusters share ONE top inset, so they sit on one centre line across the window. Pinned
    /// because the two overlays are written separately and could drift apart silently.
    func testBothTitlebarClustersShareOneCentreLine() {
        // The leading cluster's inset is the trailing cluster's too — this reads as a tautology
        // only because the constant is shared, which is exactly the property being pinned.
        XCTAssertGreaterThan(shellSidebarToggleTopInset, 0)
        XCTAssertGreaterThan(shellTitlebarButtonSize, 0)
        // Reference-measured 34 pt centre-to-centre pitch.
        XCTAssertEqual(shellTitlebarButtonSize + shellTitlebarClusterSpacing, 34,
                       "the reference's cluster pitch — button size and spacing must sum to it")
    }

    // MARK: - The new-chat page's announcement strip

    /// A real announcement always wins over the tip.
    func testAnnouncementBeatsTheTip() {
        XCTAssertEqual(newChatAnnouncement("Norma 0.3 is out", day: 1), "Norma 0.3 is out")
    }

    /// Absent, empty, and whitespace-only all mean "nothing to announce" — a strip showing a lone
    /// space would look like a rendering bug.
    func testBlankAnnouncementsFallBackToATip() {
        for blank in [nil, "", "   ", "\n\t "] {
            let shown = newChatAnnouncement(blank, day: 1)
            XCTAssertTrue(newChatTips.contains(shown), "\(String(describing: blank)) → \(shown)")
        }
    }

    /// The tip is picked by DAY, so it is stable for a whole session (a strip that reshuffled on
    /// every redraw would be noise) and still changes over time.
    func testTipIsStablePerDayAndVariesAcrossDays() {
        XCTAssertEqual(newChatAnnouncement(nil, day: 7), newChatAnnouncement(nil, day: 7))
        let distinct = Set((0..<newChatTips.count).map { newChatAnnouncement(nil, day: $0) })
        XCTAssertEqual(distinct.count, newChatTips.count, "every tip is reachable")
    }

    /// Total for any day index — a negative or absurd value must still land inside the list rather
    /// than trapping on a negative modulo.
    func testTipIndexIsTotalForAnyDay() {
        for day in [-366, -1, 0, 365, 100_000] {
            XCTAssertFalse(newChatAnnouncement(nil, day: day).isEmpty, "day \(day)")
        }
    }

    /// `newChatTipDay` is injected a date so nothing here depends on the clock.
    func testTipDayIsDerivedFromTheGivenDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let jan1 = DateComponents(calendar: calendar, year: 2026, month: 1, day: 1).date!
        XCTAssertEqual(newChatTipDay(jan1, calendar: calendar), 1)
    }

    /// The mode picker shows Chat and Cowork, and Cowork is honestly unavailable — it has no
    /// daemon mode at all. Pinned so a future "tidy-up" cannot quietly mark it selectable.
    func testNewChatModePickerOffersChatAndAnHonestlyUnavailableCowork() {
        XCTAssertEqual(newChatModeOptions, [.chat, .cowork])
        XCTAssertTrue(SessionMode.chat.isAvailable)
        XCTAssertFalse(SessionMode.cowork.isAvailable, "Cowork renders, but must not select")
    }

    // MARK: - The account menu (the Dashboard split)

    /// The menu's groups are its DIVIDERS, so an empty group would render a stray separator.
    func testAccountMenuGroupsAreNonEmpty() {
        XCTAssertFalse(shellAccountMenuGroups.isEmpty)
        for group in shellAccountMenuGroups {
            XCTAssertFalse(group.isEmpty, "an empty group renders a divider with nothing under it")
        }
    }

    /// No pane may appear twice — two entries navigating to the same place is a menu bug the eye
    /// misses easily once the list grows.
    func testAccountMenuNamesNoPaneTwice() {
        XCTAssertEqual(Set(shellAccountMenuPanes).count, shellAccountMenuPanes.count)
    }

    /// The menu derives its titles and glyphs from the Dashboard's OWN two functions, so this pin
    /// is really about that wiring holding: every pane it names must produce a real title and a
    /// real SF Symbol, or the menu renders blanks.
    func testAccountMenuEntriesResolveThroughTheDashboardsOwnTables() {
        for pane in shellAccountMenuPanes {
            XCTAssertFalse(dashboardPaneTitle(pane).isEmpty, "\(pane) has no title")
            let glyph = dashboardPaneSystemImage(pane)
            XCTAssertNotNil(NSImage(systemSymbolName: glyph, accessibilityDescription: nil),
                            "\(pane)'s glyph \(glyph) is not a real SF Symbol")
        }
    }

    /// Every pane the menu names must still BE a pane the Dashboard knows — the menu is a shortcut
    /// set over `dashboardPaneGroups`, not an independent catalogue.
    func testAccountMenuOnlyNamesPanesTheDashboardActuallyHas() {
        let known = Set(dashboardPaneGroups.flatMap(\.panes))
        for pane in shellAccountMenuPanes {
            XCTAssertTrue(known.contains(pane), "\(pane) is not in any Dashboard group")
        }
    }

    /// The menu is deliberately a SUBSET, not the whole catalogue — the panes it leaves out stay
    /// reachable through the Dashboard's own sidebar. If a future change made it exhaustive, that
    /// would be a decision worth making on purpose rather than by accident.
    func testAccountMenuIsASubsetNotTheWholeCatalogue() {
        let known = Set(dashboardPaneGroups.flatMap(\.panes))
        XCTAssertLessThan(Set(shellAccountMenuPanes).count, known.count,
                          "the menu is a shortcut set; the Dashboard still holds the full list")
    }
}
