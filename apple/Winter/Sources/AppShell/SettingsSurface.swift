import SwiftUI

// MARK: - Settings as a DESTINATION with its own sidebar (2026-09-17)

/// One section of Settings. The user's own framing: "the sidebar will be rewritten as settings
/// sidebar in settings tab, the other side of the screen would show what each tab of the settings
/// has" — so this is NOT the Dashboard's nested pane list (a 180 pt column inside the detail card,
/// which reads as a second sidebar). Entering Settings REPLACES the shell's own sidebar content;
/// the card shows the section. One sidebar on screen, always.
///
/// What is deliberately ABSENT, and why:
/// - **A list of skills, plugins, hooks, MCP servers or agents** — they live in the library panel
///   (`ShellOverlay.library`). One home per thing (user call). The Plugins section is a page of
///   DOORS into that panel at each tab, not a second copy of it (`SettingsPluginsSection`).
/// - **Paired devices** — the phone panel (`ShellOverlay.devices`), per the user's "settings stuff
///   should be here except for connected devices".
/// - **Updates** — the updates panel (`ShellOverlay.updates`), which also checks on open and shows
///   download progress, so a read-only settings row would be a second, worse door.
///
/// **Most of these are COMING, not built** (`settingsSectionComingCopy`, 2026-09-18). Some are
/// real capabilities that simply have no settings surface yet (runtimes, sessions, permissions,
/// appearance, keyboard shortcuts, computer use, browser, archived chats), and their pages say what
/// belongs there and where it is configured today. The rest (profile, personalization,
/// notifications, voice, import, appshots) are things Winter does not do yet, and their pages say
/// only that and what the page will hold. None of them is an invented setting.
///
/// Two kinds are NOT placeholders: `.plugins` is a door into the library panel at a chosen tab
/// (`SettingsPluginsSection`), and the Winter group's four are links (`SettingsLinkSection`).
///
/// Gone on 2026-09-18 (user's restructure): the standalone MCP Servers and Hooks sections — both
/// are rows on the Plugins page now, which is one door per thing instead of two — and "Approvals",
/// renamed Permissions, because policy and permission rules are one subject.
enum SettingsSection: String, Hashable, CaseIterable, Sendable {
    // Personal
    case profile
    case personalization
    case notifications
    case voice
    case appearance
    case shortcuts
    case importChats
    case archivedChats
    // Models
    case roles
    case providers
    case runtimes
    case quota
    // Assistant
    case memory
    case workflows
    case sessions
    case permissions
    // Integrations
    case plugins
    case computerUse
    case browser
    case appshots
    // This Mac
    case trust
    case peripheral
    case commandLine
    case launchAtLogin
    case daemonStatus
    // Winter
    case support
    case feedback
    case discord
    case donate
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
///
/// The shape is ChatGPT's own settings sidebar (Personal first, Integrations as its own group), per
/// the user's 2026-09-18 restructure. Archived Chats is LAST in Personal by the user's word ("the
/// last one"); Appearance and Keyboard Shortcuts moved here from This Mac, because they are about
/// you, not about the machine.
let settingsSectionGroups: [SettingsSectionGroup] = [
    SettingsSectionGroup(id: "personal", title: "Personal",
                         sections: [.profile, .personalization, .notifications, .voice, .appearance,
                                    .shortcuts, .importChats, .archivedChats]),
    SettingsSectionGroup(id: "models", title: "Models",
                         sections: [.roles, .providers, .runtimes, .quota]),
    SettingsSectionGroup(id: "assistant", title: "Assistant",
                         sections: [.memory, .workflows, .sessions, .permissions]),
    SettingsSectionGroup(id: "integrations", title: "Integrations",
                         sections: [.plugins, .computerUse, .browser, .appshots]),
    SettingsSectionGroup(id: "mac", title: "This Mac",
                         sections: [.trust, .peripheral, .commandLine, .launchAtLogin, .daemonStatus]),
    SettingsSectionGroup(id: "winter", title: "Winter",
                         sections: [.support, .feedback, .discord, .donate]),
]

let settingsSectionOrder: [SettingsSection] = settingsSectionGroups.flatMap(\.sections)

/// Where Settings opens when the gear is clicked with no section named.
let defaultSettingsSection: SettingsSection = .providers

/// PURE: the section's row title.
func settingsSectionTitle(_ section: SettingsSection) -> String {
    switch section {
    case .profile: return "Profile"
    case .personalization: return "Personalization"
    case .notifications: return "Notifications"
    case .voice: return "Voice"
    case .appearance: return "Appearance"
    case .shortcuts: return "Keyboard Shortcuts"
    case .importChats: return "Import"
    case .archivedChats: return "Archived Chats"
    case .roles: return "Roles"
    case .providers: return "Providers"
    case .runtimes: return "Runtimes"
    case .quota: return "Quota"
    case .memory: return "Memory"
    case .workflows: return "Workflows"
    case .sessions: return "Sessions"
    case .permissions: return "Permissions"
    case .plugins: return "Plugins"
    case .computerUse: return "Computer Use"
    case .browser: return "Browser"
    case .appshots: return "Appshots"
    case .trust: return "Trust"
    case .peripheral: return "Peripheral"
    case .commandLine: return "Command Line"
    case .launchAtLogin: return "Launch at Login"
    case .daemonStatus: return "Daemon Status"
    case .support: return "Support"
    case .feedback: return "Feedback"
    case .discord: return "Discord"
    case .donate: return "Donate"
    }
}

/// PURE: the section's glyph. Where a Dashboard pane is being re-housed the glyph is carried over
/// deliberately — the surface moved, the thing did not.
func settingsSectionSystemImage(_ section: SettingsSection) -> String {
    switch section {
    case .profile: return "person.crop.circle"
    case .personalization: return "slider.horizontal.3"
    case .notifications: return "bell"
    case .voice: return "waveform"
    case .appearance: return "paintpalette"
    case .shortcuts: return "command"
    case .importChats: return "square.and.arrow.down"
    case .archivedChats: return "archivebox"
    case .roles: return "person.2.badge.gearshape"
    case .providers: return "key"
    case .runtimes: return "cpu"
    case .quota: return "gauge.with.needle"
    case .memory: return "brain"
    case .workflows: return "flowchart"
    case .sessions: return "bubble.left.and.bubble.right"
    case .permissions: return "hand.raised"
    // The library panel's own glyph for plugins: this page is a door into that panel, so the row
    // and the tab it opens are recognisably the same subject.
    case .plugins: return libraryTabSystemImage(.plugins)
    case .computerUse: return "cursorarrow.rays"
    case .browser: return "globe"
    case .appshots: return "camera.viewfinder"
    case .trust: return "checkmark.shield"
    case .peripheral: return "keyboard"
    case .commandLine: return "terminal"
    case .launchAtLogin: return "power"
    case .daemonStatus: return "server.rack"
    case .support: return "questionmark.circle"
    case .feedback: return "exclamationmark.bubble"
    case .discord: return "person.3"
    case .donate: return "heart"
    }
}

/// PURE: the one-line explanation under a section's heading. Sections that are re-housed panes
/// keep their own copy inside the pane; this is the sidebar-level "what is this".
func settingsSectionSubtitle(_ section: SettingsSection) -> String {
    switch section {
    case .profile: return "How Winter knows you."
    case .personalization: return "How Winter responds to you."
    case .notifications: return "What Winter tells you about, and when."
    case .voice: return "Talking to Winter instead of typing."
    case .appearance: return "Light, dark, and how Winter looks."
    case .shortcuts: return "The keys that summon Winter."
    case .importChats: return "Bringing conversations in from elsewhere."
    case .archivedChats: return "Sessions you have put away."
    case .roles: return "Which model does each job."
    case .providers: return "API keys, sign-ins, and where each provider is reached."
    case .runtimes: return "Which agent binaries sessions run on."
    case .quota: return "What the current provider has left."
    case .memory: return "What Winter remembers, and what it learned it from."
    case .workflows: return "Saved orchestrations, and the ones running now."
    case .sessions: return "Chat titles, and the purge that retires stale chats."
    case .permissions: return "What Winter may do without asking."
    case .plugins: return "Plugins, skills, hooks, MCP servers and agents."
    case .computerUse: return "Letting Winter use the screen, keyboard and pointer."
    case .browser: return "The browser Winter works in."
    case .appshots: return "Coming in a later release."
    case .trust: return "Folders Winter is allowed to work in."
    case .peripheral: return "What is holding the keyboard and pointer right now."
    case .commandLine: return "The winter command in your shell."
    case .launchAtLogin: return "Whether Winter starts with the Mac."
    case .daemonStatus: return "The daemon this app is talking to."
    case .support: return "Help with Winter."
    case .feedback: return "Tell us what works and what does not."
    case .discord: return "The Winter community."
    case .donate: return "Support Winter's development."
    }
}

// MARK: - Sections that are coming (2026-09-18)

/// PURE: the page a COMING section shows — what belongs there, and where it is configured TODAY —
/// or nil for a section that is built (or is a door or a link rather than a page).
///
/// The rule every sentence here was written to: **name only what exists.** Each key and each place
/// was checked against the daemon's settings schema (`packages/core/src/settings.ts`), its
/// capability servers, and this app's own sources before it was written down, and several things
/// the briefs for these pages assumed turned out not to be true, so the copy says what IS true:
///
/// - a Claude model's sign-in is NOT a setting (`runtimes.official.auth` was removed in WS-20);
///   it follows the model tag's own prefix, and `.runtimes` says so;
/// - the summon hotkey is NOT edited anywhere — it is a fixed Hyper-Space. What the library's
///   Plugins tab edits is the shortcuts PLUGINS declare, and `.shortcuts` separates the two;
/// - there is no default-approval-policy key: a session's policy is chosen in its composer;
/// - there is no switch for the browser, only for computer use (`computerUse.enabled`, opt-in —
///   `computerUseEnabledFrom` is `=== true`), so `.browser` names no on/off key;
/// - only Code sessions are archived (`sessions/activity.ts`'s `ACTIVITY_MODES` is code + cowork,
///   and Cowork has no landing yet), so `.archivedChats` points at the Code page's Archived tab.
///
/// The not-yet-real pages (profile, personalization, notifications, voice, import, appshots) say
/// one sentence of intent and claim nothing about today, except Voice's microphone, whose own
/// accessibility label (`WinterComposerCard`) already says it is not wired.
///
/// Plain text, no backticks: these reach `Text` as VARIABLES, and only a literal is parsed as
/// Markdown — a backtick would render as a backtick.
func settingsSectionComingCopy(_ section: SettingsSection) -> String? {
    switch section {
    case .profile:
        return "A profile — your name, and how Winter refers to you. Winter has no profile yet."
    case .personalization:
        return "Instructions and preferences that shape how Winter responds to you."
    case .notifications:
        return "Which things Winter tells you about when you are not looking, and how it tells you."
    case .voice:
        return "Speaking to Winter instead of typing. The microphone in the composer is not wired "
            + "up yet."
    case .importChats:
        return "Bringing conversations from other assistants into Winter."
    case .archivedChats:
        return "Every archived session in one list. Today they are on the Code page's Archived "
            + "tab, where opening one resumes it. Chats are never archived."
    case .computerUse:
        return "Whether Winter may see the screen and use the keyboard and pointer. Today that is "
            + "computerUse.enabled in settings.json, off unless it is set to true. When it is on, "
            + "Code and Dispatch sessions get the computer tool; Chat never does. A change applies "
            + "to the next session that starts; one already running keeps its tool list. "
            + "computerUse.screenshotMaxDim caps the size of the screenshots it takes."
    case .browser:
        return "The browser is the Chromium that runs in Winter's work panel, and the agent drives "
            + "it through its browser tool. Every mode has that tool: in Chat it can only open, "
            + "read and screenshot pages, while Code and Dispatch can also click, type, scroll and "
            + "submit. Dangerous domains are refused by default — a shipped list, plus any you add "
            + "under permissions.dangerousDomains.added in settings.json."
    case .appshots:
        return "Appshots are coming in a later release."
    case .runtimes:
        return "Which winter binary sessions run on, and which ant binary the Console login uses. "
            + "Today that is settings.json only: runtimes.winterExecutable and "
            + "runtimes.antExecutable. How a Claude model signs in is not a setting at all — it "
            + "follows the model you choose: anthropic/ uses the API key, console/ the Console login."
    case .sessions:
        return "Whether new chats are named from their first exchange, and whether the purge "
            + "retires stale chats nobody came back to. Today: titles.enabled and cleaner.enabled "
            + "in settings.json. The model each of those jobs uses is chosen in Roles."
    case .permissions:
        return "The policy a session runs under, the permission rules Winter remembers, and the "
            + "reviewer that reads a shell command before it runs. Today the policy is chosen per "
            + "session in the composer; remembered rules live in sdk/settings.json (permissions."
            + "allow, in claude's own format), and the reviewer is settings.json's reviewer.enabled "
            + "and reviewer.classes."
    case .appearance:
        return "Light, dark, and anything else visual. There is nothing to set today — Winter "
            + "follows the system appearance and has no control of its own."
    case .shortcuts:
        return "The keys that summon Winter, and the ones plugins declare. The summon hotkey, "
            + "Hyper-Space (⌃⌥⌘Space), is fixed today with no control to change it; plugin "
            + "shortcuts are bound in the library panel's Plugins tab, which is the wrong home "
            + "for them."
    case .roles, .providers, .quota, .memory, .workflows, .plugins, .trust, .peripheral,
         .commandLine, .launchAtLogin, .daemonStatus, .support, .feedback, .discord, .donate:
        return nil
    }
}

/// PURE: the sections whose page is `SettingsSectionComing`. Derived from the copy table, so a
/// section is a placeholder exactly when it has placeholder copy — the two cannot disagree.
func settingsSectionIsComing(_ section: SettingsSection) -> Bool {
    settingsSectionComingCopy(section) != nil
}

/// The page a coming section shows: the same `SettingsPage` title every built page wears, then one
/// card whose single row says "Not built yet" and, under it, what belongs here and where it is
/// configured today. No toggle, no disabled control — a placeholder that looked like a live
/// setting would read as a broken one.
struct SettingsSectionComing: View {
    let section: SettingsSection
    let copy: String

    var body: some View {
        SettingsPage(title: settingsSectionTitle(section)) {
            SettingsGroup {
                SettingsRow("Not built yet", description: copy) { EmptyView() }
                    .textSelection(.enabled)
            }
        }
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

/// PURE: whether a section's page is answered before `SettingsSectionView` looks for daemon
/// wiring at all — the ones that read nothing from the daemon: Roles (which reads it if there),
/// every coming page, the Plugins door and the four links. Every other section needs wiring and
/// shows `SettingsSectionPlaceholder` without it.
func settingsSectionRendersWithoutWiring(_ section: SettingsSection) -> Bool {
    switch section {
    case .roles, .plugins, .support, .feedback, .discord, .donate: return true
    default: return settingsSectionIsComing(section)
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
    /// The shell's floating-panel layer, for the one section that shows a card in it (Roles).
    /// Optional and defaulted for the same reason `wiring` is optional: a surface built without a
    /// shell renders honestly rather than offering a door that opens nothing.
    var picker: (any SettingsRolePickerPresenting)? = nil
    /// The same layer again, as the narrower "open the library at this tab" door the Plugins page
    /// needs (`SettingsLibraryPresenting`). Nil renders the page's rows honestly inert.
    var library: (any SettingsLibraryPresenting)? = nil

    /// EVERY arm is a `SettingsPage` since the 2026-09-18 ChatGPT pass — built pages, coming
    /// pages and the no-wiring placeholder alike — so the page, not this view, draws the title, the
    /// scroll and the centred column. There is no second header path left to disagree with it.
    var body: some View {
        body(for: section)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
            // The THREE-argument door (`roleWriter:`), not the two-argument one: the picker sends
            // an explicit effort clear with every model change, so a role cannot keep an effort its
            // new model does not offer.
            SettingsRolesSection(loader: wiring?.modelRoles ?? nil,
                                 roleWriter: wiring?.setModelRole ?? nil,
                                 picker: picker)
        case .plugins:
            // Answered before the wiring unwrap: the page reads nothing from the daemon, it only
            // opens the library — which renders its own "no daemon wiring" state if there is none.
            SettingsPluginsSection(library: library)
        case .support, .feedback, .discord, .donate:
            // Links, not settings — nothing to read from the daemon.
            SettingsLinkSection(section: section)
        case _ where settingsSectionIsComing(section):
            // Answered BEFORE the wiring unwrap too: a coming section's page reads nothing from
            // the daemon, so an app without wiring must not be told "no daemon wiring" about a
            // section wiring would not help.
            SettingsSectionComing(section: section, copy: settingsSectionComingCopy(section) ?? "")
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
            // Carded since the ChatGPT pass (2026-09-18): the key field opens under one row
            // at a time instead of every row carrying a live SecureField.
            SettingsProvidersSection(model: wiring.providerModel)
        case .quota:
            SettingsQuotaSection(fetch: wiring.quotaState)
        case .memory:
            // The pane's list/detail split, re-set as a drill-in on the same model.
            SettingsMemorySection(model: wiring.memoryModel)
        case .workflows:
            // The pane's Saved and Runs lists, re-set as two cards on the same model.
            SettingsWorkflowsSection(model: wiring.workflowsModel)
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
        case .profile, .personalization, .notifications, .voice, .appearance, .shortcuts,
             .importChats, .archivedChats, .runtimes, .sessions, .permissions, .computerUse,
             .browser, .appshots:
            // Unreachable, for the same reason as `.roles` below: `body(for:)` answers them first.
            SettingsSectionComing(section: section, copy: settingsSectionComingCopy(section) ?? "")
        case .plugins:
            // Unreachable: answered in `body(for:)`.
            SettingsPluginsSection(library: library)
        case .support, .feedback, .discord, .donate:
            // Unreachable: answered in `body(for:)`.
            SettingsLinkSection(section: section)
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
        SettingsPage(title: settingsSectionTitle(section)) {
            SettingsGroup {
                SettingsRow(hasWiring ? "Not moved here yet" : "This app is running without daemon wiring",
                            description: settingsSectionSubtitle(section)) { EmptyView() }
            }
        }
    }
}
