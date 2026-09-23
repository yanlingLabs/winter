import XCTest
import WinterKit
@testable import Winter

/// The Library panel's drill-in navigation (2026-09-18) — every transition is a pure function in
/// `Sources/Library/LibraryNavigation.swift`, pinned here as tables. Plus the small pure display
/// helpers each tab's list/detail reads.
final class LibraryNavigationTests: XCTestCase {
    private let everyItem: [LibraryItemRef] = [
        .skill(name: "review"),
        .plugin(name: "battery-limiter"),
        .hooks(pluginName: "battery-limiter"),
        .mcpServer(name: "browser"),
        .winterCapability(key: "browser"),
        .agent(path: "/tmp/agents/reviewer.md"),
    ]

    private func list(_ tab: LibraryTab) -> LibraryNavigationState {
        LibraryNavigationState(tab: tab, detail: nil)
    }

    private func detail(_ item: LibraryItemRef) -> LibraryNavigationState {
        LibraryNavigationState(tab: item.tab, detail: item)
    }

    // MARK: - Which tab an item belongs to

    func testEveryItemBelongsToItsOwnTab() {
        let table: [(LibraryItemRef, LibraryTab)] = [
            (.skill(name: "review"), .skills),
            (.plugin(name: "p"), .plugins),
            (.hooks(pluginName: "p"), .hooks),
            (.mcpServer(name: "s"), .mcp),
            (.winterCapability(key: "web"), .mcp),
            (.agent(path: "/a.md"), .agents),
        ]
        for (item, tab) in table {
            XCTAssertEqual(item.tab, tab, "\(item)")
        }
    }

    /// An external server and a Winter capability can share a name; they are different subjects.
    func testAnExternalServerAndACapabilityWithTheSameNameAreDifferentItems() {
        XCTAssertNotEqual(LibraryItemRef.mcpServer(name: "browser"),
                          LibraryItemRef.winterCapability(key: "browser"))
    }

    // MARK: - Tab switch always lands on a LIST

    func testSwitchingTabsAlwaysLandsOnThatTabsList() {
        let starts = LibraryTab.allCases.map(list) + everyItem.map(detail)
        for start in starts {
            for target in LibraryTab.allCases {
                let next = libraryNavigationSelectingTab(start, target)
                XCTAssertEqual(next, list(target), "from \(start) to \(target)")
                XCTAssertFalse(next.isDetail)
            }
        }
    }

    // MARK: - Opening an item

    func testOpeningAnItemShowsItsDetailUnderItsOwnTab() {
        for item in everyItem {
            for tab in LibraryTab.allCases {
                let next = libraryNavigationOpening(list(tab), item)
                XCTAssertEqual(next, LibraryNavigationState(tab: item.tab, detail: item))
                XCTAssertTrue(next.isDetail)
            }
        }
    }

    /// The Hooks detail's "Open plugin" door: the tab follows the item, so back from there is the
    /// PLUGINS list, never a plugin detail under a lit Hooks tab.
    func testTheHookDoorIntoAPluginMovesTheTab() {
        let fromHooks = detail(.hooks(pluginName: "p"))
        let next = libraryNavigationOpening(fromHooks, .plugin(name: "p"))
        XCTAssertEqual(next, LibraryNavigationState(tab: .plugins, detail: .plugin(name: "p")))
        XCTAssertEqual(libraryNavigationBack(next), list(.plugins))
    }

    // MARK: - Back

    func testBackFromEveryDetailReturnsToTheSameTabsList() {
        for item in everyItem {
            XCTAssertEqual(libraryNavigationBack(detail(item)), list(item.tab), "\(item)")
        }
    }

    func testBackFromAListIsANoOp() {
        for tab in LibraryTab.allCases {
            XCTAssertEqual(libraryNavigationBack(list(tab)), list(tab))
        }
    }

    // MARK: - Esc

    func testEscStepsBackFromADetailAndIsUnclaimedOnAList() {
        for item in everyItem {
            XCTAssertEqual(libraryEscapeOutcome(detail(item)), .back)
        }
        for tab in LibraryTab.allCases {
            XCTAssertEqual(libraryEscapeOutcome(list(tab)), .unclaimed)
        }
    }

    // MARK: - A subject that vanishes

    func testAVanishedSubjectPopsOnlyWhenItIsTheOneShowing() {
        let showing = detail(.plugin(name: "a"))
        XCTAssertEqual(libraryNavigationSubjectVanished(showing, .plugin(name: "a")), list(.plugins))
        XCTAssertEqual(libraryNavigationSubjectVanished(showing, .plugin(name: "b")), showing,
                       "a late reply about another item must not yank the user out")
        XCTAssertEqual(libraryNavigationSubjectVanished(list(.plugins), .plugin(name: "a")),
                       list(.plugins))
    }

    // MARK: - The tab moved from outside

    func testReconcilingDropsADetailThatDoesNotBelongToTheTab() {
        let mismatched = LibraryNavigationState(tab: .skills, detail: .plugin(name: "p"))
        XCTAssertEqual(libraryNavigationReconciled(mismatched), list(.skills))
        for item in everyItem {
            XCTAssertEqual(libraryNavigationReconciled(detail(item)), detail(item))
        }
        XCTAssertEqual(libraryNavigationReconciled(list(.hooks)), list(.hooks))
    }

    // MARK: - Re-reading a skill

    func testReopeningTheSameDirtySkillKeepsTheEdit() {
        let table: [(opening: String, selected: String?, dirty: Bool, reload: Bool)] = [
            ("a", nil, false, true),
            ("a", "a", false, true),
            ("a", "a", true, false),
            ("a", "b", true, true),
            ("a", "b", false, true),
        ]
        for row in table {
            XCTAssertEqual(libraryShouldReloadSkill(opening: row.opening, selectedName: row.selected,
                                                    isDirty: row.dirty),
                           row.reload, "\(row)")
        }
    }
}

/// The small pure display helpers the five lists and details read.
final class LibraryDisplayHelperTests: XCTestCase {
    private func plugin(_ id: String, enabled: Bool = true, tier: String = "platform") -> PluginRowDisplay {
        let extras = PluginExtras(tier: tier, execPermission: true, tccPermissions: [], hardwarePermissions: [],
                                  requiredConsents: [], consented: [], entry: nil)
        let listing = PluginListing(id: id, installPath: "/p/\(id)", scope: .user, enabled: enabled,
                                    marketplace: "winter-examples", version: "1.0.0", extras: extras)
        return pluginRowDisplay(listing)
    }

    // MARK: Plugins

    func testPluginSubtitleLeadsWithEnabledState() {
        XCTAssertEqual(libraryPluginSubtitle(plugin("p")), "Enabled · Tier 2 · 1.0.0")
        XCTAssertEqual(libraryPluginSubtitle(plugin("p", enabled: false)), "Disabled · Tier 2 · 1.0.0")
    }

    func testShortcutsAndTilesAreFilteredToThePlugin() {
        typealias Row = ShortcutBindingEditorModel.Row
        let rows = [
            Row(pluginId: "a", shortcutId: "one", description: nil, defaultKeybinding: nil, binding: nil),
            Row(pluginId: "b", shortcutId: "two", description: nil, defaultKeybinding: nil, binding: nil),
            Row(pluginId: "a", shortcutId: "three", description: nil, defaultKeybinding: nil, binding: nil),
        ]
        XCTAssertEqual(libraryPluginShortcutRows(rows, plugin: "a").map(\.shortcutId), ["one", "three"])
        XCTAssertEqual(libraryPluginShortcutRows(rows, plugin: "c"), [])

        let tile = TileData(from: ["title": WinterKit.JSONValue.string("Battery")])!
        let tiles = [TilesStripModel.PluginTile(pluginId: "a", data: tile)]
        XCTAssertEqual(libraryPluginTile(tiles, plugin: "a")?.data.title, "Battery")
        XCTAssertNil(libraryPluginTile(tiles, plugin: "b"))
    }

    func testOnlyAnEnabledPluginGetsAStatusDot() {
        XCTAssertNil(libraryPluginStatusDot(enabled: false, needsConsent: false))
        XCTAssertNotNil(libraryPluginStatusDot(enabled: true, needsConsent: false))
    }

    /// Fix round 1 (M6): a pending consent class suppresses the dot even though `enabled` is true
    /// — a fresh install lands enabled regardless of consent.
    func testAPendingConsentSuppressesTheDotEvenWhenEnabled() {
        XCTAssertNil(libraryPluginStatusDot(enabled: true, needsConsent: true))
        XCTAssertNil(libraryPluginStatusDot(enabled: false, needsConsent: true))
    }

    // MARK: MCP

    func testMcpServerSubtitleCountsToolsAndNamesTheSource() {
        let one = McpServerRow(name: "fs", status: "running", toolNames: ["read"], source: "user")
        let many = McpServerRow(name: "gh", status: "running", toolNames: ["a", "b"], source: "plugin")
        XCTAssertEqual(libraryMcpServerSubtitle(one), "1 tool · User")
        XCTAssertEqual(libraryMcpServerSubtitle(many), "2 tools · Plugin")
    }

    // MARK: Agents

    func testARejectedAgentIsAddressedByPathAndExplainsItself() {
        let rejected = AgentDefinitionEntry.rejected(path: "/x/bad.md", reason: .missingName, detail: "")
        XCTAssertEqual(libraryAgentRef(rejected), .agent(path: "/x/bad.md"))
        XCTAssertEqual(agentRejectionExplanation(.missingName, detail: ""),
                       "Skipped: add a name: line to the frontmatter.")
        XCTAssertEqual(agentRejectionExplanation(.missingDescription, detail: "daemon's own words"),
                       "daemon's own words")
        let accepted = AgentDefinitionEntry.definition(name: "reviewer", description: "d",
                                                       path: "/x/reviewer.md", source: "user")
        XCTAssertEqual(libraryAgentRef(accepted), .agent(path: "/x/reviewer.md"))
    }
}
