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

/// The settings sidebar: just the grouped sections. It occupies the SAME column the recents list
/// normally does (`ShellSidebar` swaps its content on the destination), so there is never a second
/// sidebar on screen.
///
/// NO Back row (user call, 2026-09-17): the way out is the one arrow in the titlebar, beside the
/// traffic lights. A second door at the top of this list was the same verb twice.
struct SettingsSidebarContent: View {
    @ObservedObject var nav: ShellNavigationModel
    let selected: SettingsSection

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(settingsSectionGroups) { group in
                Text(group.title)
                    .font(Typography.body())
                    .foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, 10)
                    .padding(.top, shellSidebarSectionGap)
                    .padding(.bottom, 4)
                ForEach(group.sections, id: \.self) { section in
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
        }
    }
}

/// PURE: whether this section's body is a re-housed Dashboard pane, which already draws its own
/// heading and padding. `.roles` and `.providers` are authored for this surface and rely on the
/// section header above them; everything else is a pane move and must not get a second title.
///
/// A placeholder is NOT a pane — with no wiring the body is `SettingsSectionPlaceholder`, which
/// draws no title of its own and would leave you looking at an unnamed panel. So the caller ANDs
/// this with "there is wiring"; this function answers only "is this arm a pane move".
func settingsSectionPaneDrawsItsOwnHeader(_ section: SettingsSection) -> Bool {
    switch section {
    case .roles, .providers: return false
    case .quota, .memory, .workflows, .trust, .peripheral,
         .commandLine, .launchAtLogin, .daemonStatus: return true
    }
}

// MARK: - The detail side

/// What the card shows for a section.
///
/// Two kinds of arm, and the difference is the whole design:
///
/// - **Re-housed** (`.quota` … `.daemonStatus`) — the SAME pane the Dashboard renders, constructed
///   from the same `DashboardWiring` field. Not a rewrite and not a copy: one implementation, two
///   homes, so a fix to a pane fixes both. The cost, accepted deliberately rather than papered
///   over: each pane draws its own title and its own padding inside its own `ScrollView`, so the
///   section header above it is followed by the pane's own heading. Removing that would mean
///   editing pane files the Dashboard also renders.
/// - **Authored here** (`.providers`, `.roles`) — the two sections that are NOT a pane move.
///   `.providers` consolidates `ProviderPane`'s three peer blocks into one catalog-driven surface
///   (`SettingsProvidersSection`); `.roles` is genuinely new and read-only until the daemon grows a
///   pin door (`SettingsRolesSection`). Both live in `Sources/Settings/`.
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

    /// A pane move only speaks for itself when it is actually rendering — with no wiring the body
    /// is the placeholder, which needs our header to name it.
    private var bodyDrawsItsOwnHeader: Bool {
        settingsSectionPaneDrawsItsOwnHeader(section) && wiring != nil
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
            SettingsRolesSection(loader: wiring?.modelRoles ?? nil)
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
            SettingsProvidersSection(model: wiring.providerModel)
        case .quota:
            QuotaPane(fetch: wiring.quotaState)
        case .memory:
            MemoryPane(model: wiring.memoryModel)
        case .workflows:
            WorkflowsPane(model: wiring.workflowsModel)
        case .trust:
            TrustPane(list: wiring.trustList, remove: wiring.trustRemove)
        case .peripheral:
            PeripheralPane(provider: wiring.peripheral, helperClient: wiring.helperClient)
        case .commandLine:
            CliInstallerPane(isDev: wiring.isDevProfile,
                             cliInstallState: wiring.cliInstallState,
                             installCli: wiring.installCli,
                             openDevCli: wiring.openDevCli)
        case .launchAtLogin:
            LoginItemPane(isEnabled: wiring.loginItemEnabled, setEnabled: wiring.setLoginItemEnabled)
        case .daemonStatus:
            DaemonStatusPane(fetch: wiring.daemonStatus)
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
