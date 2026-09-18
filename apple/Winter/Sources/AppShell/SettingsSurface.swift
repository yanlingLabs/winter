import SwiftUI

// MARK: - Settings as a DESTINATION with its own sidebar (2026-09-17)

/// One section of Settings. The user's own framing: "the sidebar will be rewritten as settings
/// sidebar in settings tab, the other side of the screen would show what each tab of the settings
/// has" — so this is NOT the Dashboard's nested pane list (a 180 pt column inside the detail card,
/// which reads as a second sidebar). Entering Settings REPLACES the shell's own sidebar content;
/// the card shows the section. One sidebar on screen, always.
///
/// What is deliberately ABSENT, and why:
/// - **Skills and Plugins** — they moved to the library panel (`ShellOverlay.library`), which is
///   where hooks, MCP tools and agents live too. One home per thing (user call).
/// - **Paired devices** — the phone panel (`ShellOverlay.devices`), per the user's "settings stuff
///   should be here except for connected devices".
/// - **Updates** — the updates panel (`ShellOverlay.updates`), which also checks on open and shows
///   download progress, so a read-only settings row would be a second, worse door.
enum SettingsSection: String, Hashable, CaseIterable, Sendable {
    case roles
    case providers
    case quota
    case memory
    case workflows
    case trust
    case peripheral
    case commandLine
    case launchAtLogin
    case daemonStatus
}

/// A named run of sections in the settings sidebar. Groups are how the list stays readable without
/// a scroll — the same device `dashboardPaneGroups` uses, kept because it worked.
struct SettingsSectionGroup: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let sections: [SettingsSection]
}

/// THE settings information architecture. `settingsSectionOrder` is derived from this, so the list
/// and the order can never disagree.
let settingsSectionGroups: [SettingsSectionGroup] = [
    SettingsSectionGroup(id: "models", title: "Models", sections: [.roles, .providers, .quota]),
    SettingsSectionGroup(id: "assistant", title: "Assistant", sections: [.memory, .workflows]),
    SettingsSectionGroup(id: "mac", title: "This Mac",
                         sections: [.trust, .peripheral, .commandLine, .launchAtLogin, .daemonStatus]),
]

let settingsSectionOrder: [SettingsSection] = settingsSectionGroups.flatMap(\.sections)

/// Where Settings opens when the gear is clicked with no section named.
let defaultSettingsSection: SettingsSection = .providers

/// PURE: the section's row title.
func settingsSectionTitle(_ section: SettingsSection) -> String {
    switch section {
    case .roles: return "Roles"
    case .providers: return "Providers"
    case .quota: return "Quota"
    case .memory: return "Memory"
    case .workflows: return "Workflows"
    case .trust: return "Trust"
    case .peripheral: return "Peripheral"
    case .commandLine: return "Command Line"
    case .launchAtLogin: return "Launch at Login"
    case .daemonStatus: return "Daemon Status"
    }
}

/// PURE: the section's glyph. Where a Dashboard pane is being re-housed the glyph is carried over
/// deliberately — the surface moved, the thing did not.
func settingsSectionSystemImage(_ section: SettingsSection) -> String {
    switch section {
    case .roles: return "person.2.badge.gearshape"
    case .providers: return "key"
    case .quota: return "gauge.with.needle"
    case .memory: return "brain"
    case .workflows: return "flowchart"
    case .trust: return "checkmark.shield"
    case .peripheral: return "keyboard"
    case .commandLine: return "terminal"
    case .launchAtLogin: return "power"
    case .daemonStatus: return "server.rack"
    }
}

/// PURE: the one-line explanation under a section's heading. Sections that are re-housed panes
/// keep their own copy inside the pane; this is the sidebar-level "what is this".
func settingsSectionSubtitle(_ section: SettingsSection) -> String {
    switch section {
    case .roles: return "Which model does each job."
    case .providers: return "API keys, sign-ins, and where each provider is reached."
    case .quota: return "What the current provider has left."
    case .memory: return "What Winter remembers, and what it learned it from."
    case .workflows: return "Saved orchestrations, and the ones running now."
    case .trust: return "Folders Winter is allowed to work in."
    case .peripheral: return "What is holding the keyboard and pointer right now."
    case .commandLine: return "The winter command in your shell."
    case .launchAtLogin: return "Whether Winter starts with the Mac."
    case .daemonStatus: return "The daemon this app is talking to."
    }
}

// MARK: - The sidebar, while Settings is open

/// PURE: the sections of `group` whose title matches `query`. An empty/blank query matches
/// everything, so the unfiltered list is the same code path as the filtered one.
///
/// Matching is on the TITLE only, deliberately: the subtitles are sentences, and letting them match
/// makes a search for "model" return five sections whose rows say nothing about models. The user
/// types the name of the page they want.
func settingsSectionsMatching(_ query: String, in sections: [SettingsSection]) -> [SettingsSection] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return sections }
    return sections.filter { settingsSectionTitle($0).localizedCaseInsensitiveContains(trimmed) }
}

/// The settings sidebar: a search field over the grouped sections. It occupies the SAME column the
/// recents list normally does (`ShellSidebar` swaps its content on the destination), so there is
/// never a second sidebar on screen.
///
/// NO Back row (user call, 2026-09-17), even though the reference window has one: the way out is
/// the one arrow in the titlebar, beside the traffic lights. A second door at the top of this list
/// was the same verb twice.
struct SettingsSidebarContent: View {
    @ObservedObject var nav: ShellNavigationModel
    let selected: SettingsSection

    /// Not persisted and not lifted into `ShellNavigationModel`: a filter is a gesture, not a
    /// preference, and coming back to Settings with yesterday's query still narrowing the list
    /// would look like sections had gone missing.
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            // NO horizontal padding of its own (2026-09-18): the rows' pills span this column's
            // full width, and the extra 10 a side made the field visibly narrower than everything
            // under it. Its text inset matches a row's internally instead.
            SettingsSearchField(query: $query)
                .padding(.bottom, 4)
            ForEach(settingsSectionGroups) { group in
                let matches = settingsSectionsMatching(query, in: group.sections)
                // A group with nothing left in it disappears entirely — a lone heading over empty
                // space reads as a section that failed to load.
                if !matches.isEmpty {
                    Text(group.title)
                        .font(Typography.body())
                        .foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.top, shellSidebarSectionGap)
                        .padding(.bottom, 4)
                    ForEach(matches, id: \.self) { section in
                        row(section)
                    }
                }
            }
            if noSectionMatches {
                Text("No settings match “\(query.trimmingCharacters(in: .whitespacesAndNewlines))”.")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.top, 14)
            }
        }
    }

    /// True only when the user has actually typed something AND nothing survived it — an empty
    /// query can never reach this, because it matches every section.
    private var noSectionMatches: Bool {
        settingsSectionGroups.allSatisfy { settingsSectionsMatching(query, in: $0.sections).isEmpty }
    }

    private func row(_ section: SettingsSection) -> some View {
        Button {
            nav.navigate(to: .settings(section: section))
        } label: {
            HStack(spacing: 10) {
                Image(systemName: settingsSectionSystemImage(section))
                    .font(Typography.control())
                    .frame(width: 22)
                Text(settingsSectionTitle(section))
                    .font(Typography.body())
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: shellSidebarRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: section == selected))
    }
}

/// PURE: whether this section's body prints its own title, so `SettingsSectionView` must not print
/// one above it.
///
/// Two ways a body ends up owning its heading, and after the 2026-09-18 restyle they are both the
/// common case:
///
/// - a **settings-native section** built on `SettingsPage` (`SettingsChrome.swift`), which draws
///   the large left-aligned title, the subtitle, the scroll and the margins itself — `.roles`,
///   `.quota`, `.trust`, `.peripheral`, `.commandLine`, `.launchAtLogin`, `.daemonStatus`;
/// - a **re-housed Dashboard pane**, which draws its own `Typography.paneTitle` and padding inside
///   its own `ScrollView` — `.memory` and `.workflows`, the two left as they are.
///
/// `.providers` is the only arm that still relies on the header above it.
///
/// A placeholder is NOT a body of either kind — with no wiring the body is
/// `SettingsSectionPlaceholder`, which draws no title and would leave you looking at an unnamed
/// panel. So the caller ANDs this with "there is wiring", except for `.roles`, which renders
/// wiring or not.
func settingsSectionBodyDrawsItsOwnHeader(_ section: SettingsSection) -> Bool {
    switch section {
    case .providers: return false
    case .roles, .quota, .memory, .workflows, .trust, .peripheral,
         .commandLine, .launchAtLogin, .daemonStatus: return true
    }
}

// MARK: - The detail side

/// What the card shows for a section.
///
/// Three kinds of arm after the 2026-09-18 restyle, and the difference is the whole design:
///
/// - **Settings-native** (`.roles`, `.quota`, `.trust`, `.peripheral`, `.commandLine`,
///   `.launchAtLogin`, `.daemonStatus`) — written for THIS surface in the card/row vocabulary
///   (`Sources/Settings/SettingsChrome.swift`), each drawing its own `SettingsPage` title, subtitle,
///   scroll and margins. The seven that were pane moves kept every closure, every pure formatter
///   and every failure string from the pane they replaced; only the presentation changed, and the
///   Dashboard panes themselves are untouched and still rendered by the Dashboard.
/// - **Left as the Dashboard pane** (`.memory`, `.workflows`) — list/editor-shaped surfaces that a
///   card would make worse, not better. Each arm in `wired()` says why, in place.
/// - **Authored here, uncarded** (`.providers`) — `SettingsProvidersSection` consolidates
///   `ProviderPane`'s three peer blocks into one catalog-driven surface. It is a page of editors,
///   not a page of rows, and it is the one arm that still takes the section header below.
///
/// `.roles` is answered BEFORE the wiring check on purpose: it reads nothing from the daemon today,
/// so it is the one section that still has something true to say in an app running without wiring.
/// Every other section falls through to `SettingsSectionPlaceholder`, which distinguishes "not
/// moved here yet" from "this app has no daemon wiring at all" — a structural absence should never
/// look like an unbuilt feature.
struct SettingsSectionView: View {
    let section: SettingsSection
    let wiring: DashboardWiring?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A re-housed pane draws its own title, padding and scroll, so adding OUR header above
            // it prints the section's name twice with two different paddings. The header is for the
            // sections authored here; the panes speak for themselves.
            if !bodyDrawsItsOwnHeader {
                header
                Divider()
                    .padding(.top, 14)
            }
            body(for: section)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(bodyDrawsItsOwnHeader ? 0 : 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// A body only speaks for itself when it is actually rendering — with no wiring the body is the
    /// placeholder, which needs our header to name it. `.roles` is the exception: it renders
    /// (through `SettingsPage`, with its own title) whether or not there is wiring at all.
    private var bodyDrawsItsOwnHeader: Bool {
        if section == .roles { return true }
        return settingsSectionBodyDrawsItsOwnHeader(section) && wiring != nil
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(settingsSectionTitle(section))
                .font(Typography.emptyStateTitle)
            Text(settingsSectionSubtitle(section))
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(Theme.textMuted)
        }
    }

    @ViewBuilder
    private func body(for section: SettingsSection) -> some View {
        switch section {
        case .roles:
            // STILL answered before the wiring unwrap, and still for the original reason: the job
            // list is worth showing even in an app with no daemon wiring at all. What changed
            // (2026-09-18) is that there IS a read now (`settings.modelRoles`), so the loader is
            // passed when it exists. `wiring?.modelRoles ?? nil` flattens the double optional —
            // "no wiring" and "wiring without that method" are the same thing to this pane, and it
            // distinguishes never-asked from asked-and-not-told on its own.
            //
            // 2026-09-18: `writer:` joins it — `settings.setModelRole`, the door the row's model
            // picker commits through. Same double-optional flattening and the same reason: a pane
            // with no writer is simply read-only, which is exactly what it was yesterday.
            // `catalog:` is deliberately NOT passed, though the parameter exists for it. The
            // implementer left `ModelCatalogFactsModel.shared` as owed debt, assuming this call
            // site would retire it; the judgement here is that it should stay. The catalog is one
            // 134 KB read describing the whole process's world, not per-section state, and this
            // section is an `@ObservedObject` consumer — handing it a fresh instance per render
            // would thrash the very cache the store exists to be. `AppDelegate` configures the one
            // instance when it builds the wiring, which is the same lifetime a threaded dependency
            // would have had, with fewer moving parts. The parameter stays for previews and tests.
            SettingsRolesSection(loader: wiring?.modelRoles ?? nil,
                                 writer: wiring?.setModelRole ?? nil)
        default:
            if let wiring {
                wired(section, wiring)
            } else {
                SettingsSectionPlaceholder(section: section, hasWiring: false)
            }
        }
    }

    /// The arms that need the daemon. Split from `body(for:)` so the `if let wiring` unwrap happens
    /// exactly once instead of inside every case.
    @ViewBuilder
    private func wired(_ section: SettingsSection, _ wiring: DashboardWiring) -> some View {
        switch section {
        case .providers:
            // ONE consolidated Providers surface (user's call), sharing the Dashboard pane's
            // view-models rather than minting new ones — see `SettingsProvidersSection`.
            //
            // LEFT UN-CARDED in the 2026-09-18 restyle, deliberately: this section is three
            // EDITORS (an Anthropic auth block with its own sheet, a ~100-row catalog of live
            // `SecureField`s, and a disclosure-group endpoint form), not a list of statements with
            // one affordance each. A `SettingsCard` row has room for one control; a credential row
            // is a text field, a state line and two buttons. Forcing it in would shrink the fields
            // and hide the states. It keeps `SettingsSectionView`'s header — the only arm that
            // still does.
            SettingsProvidersSection(model: wiring.providerModel)
        case .quota:
            SettingsQuotaSection(fetch: wiring.quotaState)
        case .memory:
            // LEFT AS THE DASHBOARD PANE in the 2026-09-18 restyle, deliberately: Memory is a
            // browser — a searchable list of memory documents with a selected-item detail view and
            // its own editing affordances. That is a master/detail shape, not a column of rows with
            // trailing controls, and a card would only add a rim around a list that already scrolls
            // inside one. It draws its own `Typography.paneTitle` header, which is why
            // `settingsSectionBodyDrawsItsOwnHeader` answers true for it.
            MemoryPane(model: wiring.memoryModel)
        case .workflows:
            // LEFT AS THE DASHBOARD PANE, for the same reason as `.memory`: Workflows is a list of
            // saved orchestrations plus the runs currently in flight, each with progress and its
            // own per-run detail. A settings row cannot carry a running thing.
            WorkflowsPane(model: wiring.workflowsModel)
        case .trust:
            SettingsTrustSection(list: wiring.trustList, remove: wiring.trustRemove)
        case .peripheral:
            SettingsPeripheralSection(provider: wiring.peripheral, helperClient: wiring.helperClient)
        case .commandLine:
            SettingsCommandLineSection(isDev: wiring.isDevProfile,
                                       cliInstallState: wiring.cliInstallState,
                                       installCli: wiring.installCli,
                                       openDevCli: wiring.openDevCli)
        case .launchAtLogin:
            SettingsLaunchAtLoginSection(isEnabled: wiring.loginItemEnabled,
                                         setEnabled: wiring.setLoginItemEnabled)
        case .daemonStatus:
            SettingsDaemonStatusSection(fetch: wiring.daemonStatus)
        case .roles:
            // Unreachable: `body(for:)` answers `.roles` before it ever gets here. Spelled out
            // rather than left to a `default:` so that a NEW section added to the enum breaks this
            // switch at compile time instead of silently rendering nothing.
            SettingsRolesSection()
        }
    }
}

/// The honest empty state. Says which surface is coming and, when the app is running without
/// `DashboardWiring` at all, says THAT instead — a section that cannot work for a structural
/// reason should not look like one that is merely unbuilt.
struct SettingsSectionPlaceholder: View {
    let section: SettingsSection
    let hasWiring: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(hasWiring ? "Not moved here yet." : "This app is running without daemon wiring.")
                .font(Typography.body())
                .foregroundStyle(Theme.textSecondary)
            Text(settingsSectionSubtitle(section))
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.top, 18)
    }
}
