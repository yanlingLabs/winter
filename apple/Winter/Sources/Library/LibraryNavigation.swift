import Foundation

// -----------------------------------------------------------------------------------------------
// Library → navigation (2026-09-18). PURE — every transition the panel makes is a function here,
// table-tested in `LibraryNavigationTests`.
//
// The panel used to be three columns wide on the Skills tab (tab column | list | "Select a skill
// to view it"), because it mounted the Dashboard's master/detail `SkillsPane`. It is now TWO
// STATES, the model picker's own pattern (`SettingsRoleModelPicker`, step one → step two):
//
//   - LIST:   the tab column + one list of the tab's items, filling the rest of the card.
//   - DETAIL: one item as the whole card's subject — tab column gone — under a header with a back
//             chevron and the item's name.
//
// Ownership is split the way the files are: WHICH TAB is `ShellSidebar`'s `@State` (it survives the
// panel closing, so reopening lands on the tab you left), WHICH ITEM is the panel's own `@State`
// (it dies with the panel, so reopening always lands on a LIST — a drill-in is a moment, not a
// place). `LibraryNavigationState` pairs the two so the transitions can be stated and tested as
// one value.
// -----------------------------------------------------------------------------------------------

/// The thing a DETAIL page is about. One case per kind of subject — and TWO for the MCP tab,
/// because an external server and one of Winter's own `winter__<key>` capability servers are
/// different namespaces whose names happen to share a shape (a user can name a server `browser`).
enum LibraryItemRef: Hashable, Sendable {
    case skill(name: String)
    case plugin(name: String)
    /// The hooks one plugin declares — the Hooks tab's subject is a PLUGIN, seen through its hooks.
    case hooks(pluginName: String)
    case mcpServer(name: String)
    case winterCapability(key: String)
    /// Keyed by PATH: a rejected definition file may have no name at all.
    case agent(path: String)

    /// The tab this item belongs to. A detail page is always inside exactly one tab, so "back"
    /// always has one answer.
    var tab: LibraryTab {
        switch self {
        case .skill: return .skills
        case .plugin: return .plugins
        case .hooks: return .hooks
        case .mcpServer, .winterCapability: return .mcp
        case .agent: return .agents
        }
    }
}

/// The panel's whole navigation position.
struct LibraryNavigationState: Equatable, Sendable {
    var tab: LibraryTab
    /// `nil` = the tab's LIST; set = that item's DETAIL page.
    var detail: LibraryItemRef?

    var isDetail: Bool { detail != nil }
}

/// PURE: a tab in the column was clicked. ALWAYS lands on that tab's list — including a click on
/// the tab you are already on (which is not reachable from a detail page, since the column is not
/// on screen there, but must still mean "the list" if it ever is).
func libraryNavigationSelectingTab(_ state: LibraryNavigationState,
                                   _ tab: LibraryTab) -> LibraryNavigationState {
    LibraryNavigationState(tab: tab, detail: nil)
}

/// PURE: an item was opened. The TAB follows the item, so a door from one tab into another tab's
/// subject (a hook group's "Open plugin") lands on a consistent state rather than a Plugins detail
/// sitting under a lit Hooks tab — and "back" from there is the Plugins list.
func libraryNavigationOpening(_ state: LibraryNavigationState,
                              _ item: LibraryItemRef) -> LibraryNavigationState {
    LibraryNavigationState(tab: item.tab, detail: item)
}

/// PURE: the back chevron. DETAIL → the same tab's LIST; LIST → unchanged (there is no level
/// above the list inside the panel — closing is the card's own close button).
func libraryNavigationBack(_ state: LibraryNavigationState) -> LibraryNavigationState {
    LibraryNavigationState(tab: state.tab, detail: nil)
}

/// What Esc does inside the library panel.
enum LibraryEscapeOutcome: Equatable, Sendable {
    /// Go back one level (DETAIL → LIST).
    case back
    /// The panel does not claim Esc in this state. Nothing in the shell closes the library on Esc
    /// today, so on a LIST Esc stays exactly as it was: unclaimed.
    case unclaimed
}

/// PURE: Esc steps back from a detail page and is left alone on a list.
func libraryEscapeOutcome(_ state: LibraryNavigationState) -> LibraryEscapeOutcome {
    state.isDetail ? .back : .unclaimed
}

/// PURE: the open item's subject has vanished (a skill deleted, a plugin removed, a server gone
/// from the last good read). Only pops when the vanished item IS the one showing — a late reply
/// about some other item must not yank the user out of the page they are reading.
func libraryNavigationSubjectVanished(_ state: LibraryNavigationState,
                                      _ item: LibraryItemRef) -> LibraryNavigationState {
    guard state.detail == item else { return state }
    return libraryNavigationBack(state)
}

/// PURE: the state after the TAB changed from outside the panel's own column (the binding is
/// `ShellSidebar`'s). A detail that does not belong to the new tab is dropped, so the invariant
/// `detail?.tab == tab` holds whoever moved the tab.
func libraryNavigationReconciled(_ state: LibraryNavigationState) -> LibraryNavigationState {
    guard let detail = state.detail, detail.tab != state.tab else { return state }
    return LibraryNavigationState(tab: state.tab, detail: nil)
}

/// PURE: should opening skill `name` re-read it from the daemon?
///
/// YES, except in one case: it is the skill already selected and it holds UNSAVED edits. Back is
/// not a discard — a user who steps back to glance at the list and returns to the same skill must
/// find their half-typed edit still there, and a fresh `skills.read` would overwrite it.
func libraryShouldReloadSkill(opening name: String, selectedName: String?, isDirty: Bool) -> Bool {
    !(selectedName == name && isDirty)
}
