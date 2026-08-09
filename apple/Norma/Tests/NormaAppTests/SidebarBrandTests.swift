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

    /// Every titlebar glyph — both clusters, plus panel-shell T10's own expand button (a NEW glyph
    /// that no existing list covers — `shellTitlebarTrailingGlyphs` is unchanged, still the
    /// original three, per `testTrailingClusterIsThreeDistinctGlyphs` below — so it needs its own
    /// listing here) — must resolve, or it renders as a blank box with no error anywhere.
    func testEveryTitlebarGlyphResolvesAsARealSymbol() {
        let all = shellTitlebarNavigationGlyphs + shellTitlebarTrailingGlyphs
            + [shellSidebarToggleSystemImage(isVisible: true),
               shellSidebarToggleSystemImage(isVisible: false),
               panelExpandButtonSystemImage(mode: .side),
               panelExpandButtonSystemImage(mode: .maximized)]
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

    /// Every trailing PLACEHOLDER says it is not wired, so hovering one cannot promise a feature
    /// that does not exist — and the mapping is TOTAL, so an added glyph still gets a label.
    ///
    /// review round 2, Important 3: this used to iterate `shellTitlebarTrailingGlyphs` (the WHOLE
    /// cluster) and assert "not wired" of every one of them — true when written, but it became a
    /// pin on a falsehood the moment `sidebar.right` was wired (panel-shell T2) without this test
    /// noticing, since it stayed green for the wrong reason (the stale switch case it was calling
    /// still happened to say "not wired yet"). Iterating `shellTitlebarTrailingPlaceholderGlyphs`
    /// — the subset that is STILL a placeholder — makes the assertion true again and keeps it
    /// that way: a glyph leaving that list is the only thing that can silence this check for it.
    func testTrailingPlaceholderLabelsDiscloseTheyAreNotWired() {
        // The split itself: every placeholder is still a real trailing glyph, and the one glyph
        // that stopped being a placeholder must not sneak back into the placeholder list.
        XCTAssertTrue(shellTitlebarTrailingPlaceholderGlyphs.allSatisfy(shellTitlebarTrailingGlyphs.contains),
                      "every placeholder must still be one of the trailing cluster's own glyphs")
        XCTAssertFalse(shellTitlebarTrailingPlaceholderGlyphs.contains("sidebar.right"),
                       "sidebar.right is wired (panel-shell T2) — it must not be claimed as a placeholder")

        for glyph in shellTitlebarTrailingPlaceholderGlyphs {
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

    /// The greeting's brand mark. A missing or misnamed image asset renders as NOTHING — no error,
    /// no placeholder — so this is the same silent-failure class the colour pin guards.
    ///
    /// It must also be a VECTOR: the mark is drawn at 30 pt while the menu bar's `mb-idle` is an
    /// 18×18 PNG, and using that one upscaled ~1.7× and read visibly soft. `representations` on a
    /// vector-backed asset yields no fixed-size bitmap rep, which is what this checks.
    func testBrandMarkResolvesAndIsVector() {
        guard let mark = NSImage(named: "BrandMark") else {
            return XCTFail("BrandMark is missing from Assets.xcassets")
        }
        XCTAssertGreaterThan(mark.size.width, 0, "the mark must have a drawable size")
        XCTAssertTrue(mark.isTemplate || mark.representations.isEmpty == false,
                      "the mark must carry a usable representation")
    }

    // MARK: - The new-chat page's announcement strip

    /// A real announcement always wins over the resting line.
    func testAnnouncementBeatsTheRestingLine() {
        XCTAssertEqual(newChatAnnouncement("Norma 0.3 is out", fallback: "x"), "Norma 0.3 is out")
    }

    /// Absent, empty, and whitespace-only all mean "nothing to announce" — a strip showing a lone
    /// space would look like a rendering bug.
    func testBlankAnnouncementsFallBackToTheRestingLine() {
        for blank in [nil, "", "   ", "\n\t "] {
            XCTAssertEqual(newChatAnnouncement(blank, fallback: "resting"), "resting")
        }
    }

    /// The resting lines replaced a list of TIPS (keyboard shortcuts, Keychain facts) that read
    /// as documentation on an empty page. These are about the work, not the app — so the pin is
    /// that none of them is a feature claim, which is the failure mode being corrected.
    func testRestingLinesAreCopyNotDocumentation() {
        XCTAssertGreaterThan(newChatAnnouncementLines.count, 3, "a real rotation, not two lines")
        XCTAssertEqual(Set(newChatAnnouncementLines).count, newChatAnnouncementLines.count)
        for line in newChatAnnouncementLines {
            XCTAssertFalse(line.isEmpty)
            XCTAssertFalse(line.contains("⌘"), "\(line) is a shortcut reference, not copy")
            XCTAssertFalse(line.lowercased().contains("keychain"), "\(line) is documentation")
            XCTAssertFalse(line.lowercased().contains("click"), "\(line) is documentation")
        }
    }

    /// The mode picker shows Chat and Cowork, and Cowork remains honestly unavailable — it has no
    /// daemon mode at all.
    func testNewChatModePickerOffersChatAndAnHonestlyUnavailableCowork() {
        XCTAssertEqual(newChatModeOptions, [.chat, .cowork])
        XCTAssertTrue(SessionMode.chat.isAvailable)
        XCTAssertFalse(SessionMode.cowork.isAvailable)
    }

    /// The working-folder / approval / announcement row is COWORK ONLY (user ruling, 2026-08-07):
    /// a chat has no working folder and takes no approvals, so offering them would be offering
    /// settings that cannot apply to what the page is about to create.
    func testCoworkControlsShowOnCoworkOnly() {
        XCTAssertTrue(newChatShowsCoworkControls(mode: .cowork))
        XCTAssertFalse(newChatShowsCoworkControls(mode: .chat))
        XCTAssertFalse(newChatShowsCoworkControls(mode: .code))
        XCTAssertFalse(newChatShowsCoworkControls(mode: .dispatch))
    }

    /// Cowork can be SELECTED (so the design it unlocks is visible) but must never SEND — the
    /// create is always a chat, so a Cowork send would quietly mint the wrong thing. The refusal
    /// carries a reason; an empty draft is the ordinary resting state and carries none.
    func testSendIsRefusedOnAnUnbuiltModeWithAReason() {
        let reason = newChatSendBlockedReason(draft: "hello", mode: .cowork)
        XCTAssertEqual(reason, "Cowork isn't built yet")
    }

    func testSendIsBlockedButUnexplainedOnAnEmptyDraft() {
        XCTAssertEqual(newChatSendBlockedReason(draft: "", mode: .chat), "")
        XCTAssertEqual(newChatSendBlockedReason(draft: "   \n", mode: .chat), "")
    }

    func testSendIsAvailableOnlyWithTextAndABuiltMode() {
        XCTAssertNil(newChatSendBlockedReason(draft: "hello", mode: .chat))
    }

    /// The unbuilt-mode refusal outranks the empty draft — otherwise selecting Cowork and typing
    /// nothing would report the wrong reason, and the user would never learn Cowork is the block.
    func testUnbuiltModeOutranksTheEmptyDraft() {
        XCTAssertEqual(newChatSendBlockedReason(draft: "", mode: .cowork), "Cowork isn't built yet")
    }

    /// Cowork swaps the chat starter CHIPS for an idea LIST — a whole task does not fit on a chip,
    /// which is why the reference changes shape rather than just the words. Both prefill.
    func testCoworkIdeasAreDistinctFromChatStartersAndAllPrefill() {
        XCTAssertFalse(newChatCoworkIdeas.isEmpty)
        for idea in newChatCoworkIdeas {
            XCTAssertFalse(idea.title.isEmpty)
            XCTAssertFalse(idea.prefill.isEmpty, "\(idea.title) must prefill something")
            XCTAssertNotNil(
                NSImage(systemSymbolName: idea.systemImage, accessibilityDescription: nil),
                "\(idea.title)'s glyph \(idea.systemImage) is not a real SF Symbol")
        }
        XCTAssertEqual(Set(newChatCoworkIdeas.map(\.title)).count, newChatCoworkIdeas.count)
        // The two sets are for different modes and must not be the same content in two shapes.
        XCTAssertTrue(Set(newChatCoworkIdeas.map(\.title))
            .isDisjoint(with: Set(newChatStarters.map(\.title))))
    }

    /// The results list grows with its rows and then STOPS, after which it scrolls. Both halves
    /// matter: a fixed height leaves dead space under three results, and an uncapped one grows
    /// past the window on a long history.
    func testSearchResultsHeightGrowsWithRowsThenCaps() {
        XCTAssertEqual(searchPaletteResultsHeight(rowCount: 0), 0, "no rows, no list")
        let one = searchPaletteResultsHeight(rowCount: 1)
        let three = searchPaletteResultsHeight(rowCount: 3)
        XCTAssertGreaterThan(one, 0)
        XCTAssertGreaterThan(three, one, "it must actually follow the row count")
        XCTAssertEqual(searchPaletteResultsHeight(rowCount: 500),
                       searchPaletteMaxResultsHeight, "capped, then it scrolls")
        // Monotonic up to the cap — a height that dipped as rows were added would be a layout bug
        // nobody would think to look for.
        var previous: CGFloat = 0
        for count in 1...40 {
            let height = searchPaletteResultsHeight(rowCount: count)
            XCTAssertGreaterThanOrEqual(height, previous, "height dipped at \(count) rows")
            XCTAssertLessThanOrEqual(height, searchPaletteMaxResultsHeight)
            previous = height
        }
    }

    /// Every rim the shell draws is ONE device pixel on Retina, not two. Pinned because "borders
    /// are too thick" was a live finding, and a future edit that reaches for the obvious `1` would
    /// silently undo it.
    func testEveryRimIsASingleDevicePixel() {
        XCTAssertEqual(shellSidebarHairlineWidth, 0.5,
                       "0.5 pt = 1 physical pixel at 2×; 1 pt reads as a drawn line")
    }

    /// The starters are real behaviour, not placeholders: each prefills the composer. Every one
    /// needs a non-empty prefill and a glyph that actually resolves.
    func testEveryStarterPrefillsAndHasARealGlyph() {
        XCTAssertFalse(newChatStarters.isEmpty)
        for starter in newChatStarters {
            XCTAssertFalse(starter.title.isEmpty)
            XCTAssertFalse(starter.prefill.isEmpty, "\(starter.title) must prefill something")
            XCTAssertNotNil(
                NSImage(systemSymbolName: starter.systemImage, accessibilityDescription: nil),
                "\(starter.title)'s glyph \(starter.systemImage) is not a real SF Symbol")
        }
        XCTAssertEqual(Set(newChatStarters.map(\.title)).count, newChatStarters.count)
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
