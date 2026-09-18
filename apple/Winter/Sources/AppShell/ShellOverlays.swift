import SwiftUI

// MARK: - The floating panels the account row opens (2026-09-17)

/// The three surfaces that are NOT settings: the library, the phone, and updates.
///
/// They are floating panels rather than destinations because each one is a thing you consult and
/// dismiss — you do not navigate to your update state and stay there. Settings is the opposite,
/// which is why it is a real destination with its own sidebar (`SettingsSection`).
enum ShellOverlay: Hashable, Sendable {
    /// Skills, plugins, hooks, MCP tools and agents — everything that extends what Winter can do.
    /// Which TAB is showing is the shell's own state, not part of the case: the panel is one
    /// surface that remembers where you were, and putting the tab in the identity would make
    /// "already open" depend on which tab you asked for.
    case library
    /// Paired phones: what is connected, and the door to pair or revoke.
    case devices
    /// Version state, release notes, and the update itself — including its download progress,
    /// which is why this exists at all rather than deferring to Sparkle's own window.
    case updates
}

/// The library panel's tabs, in order. The user's own list.
enum LibraryTab: String, Hashable, CaseIterable, Sendable {
    case skills
    case plugins
    case hooks
    case mcp
    case agents
}

let defaultLibraryTab: LibraryTab = .skills

/// PURE: the tab's row title.
func libraryTabTitle(_ tab: LibraryTab) -> String {
    switch tab {
    case .skills: return "Skills"
    case .plugins: return "Plugins"
    case .hooks: return "Hooks"
    case .mcp: return "MCP tools"
    case .agents: return "Agents"
    }
}

/// PURE: the tab's glyph.
func libraryTabSystemImage(_ tab: LibraryTab) -> String {
    switch tab {
    case .skills: return "book.closed"
    case .plugins: return "puzzlepiece.extension"
    case .hooks: return "point.3.connected.trianglepath.dotted"
    case .mcp: return "wrench.and.screwdriver"
    case .agents: return "person.2"
    }
}

/// PURE: the panel's name. NOT rendered as a title any more (user call, 2026-09-17: the library
/// "shouldnt have a name") — the tab column already says what you are looking at, and a heading
/// above it was the panel naming itself twice. Kept as the accessibility label, which still needs
/// words, and as the window-level name for anything that lists these surfaces.
func shellOverlayAccessibilityName(_ overlay: ShellOverlay) -> String {
    switch overlay {
    case .library: return "Library"
    case .devices: return "Devices"
    case .updates: return "Updates"
    }
}

// MARK: - Presentation

/// Which panel is open, if any.
///
/// One model for all three rather than a flag each: they are mutually exclusive by nature (each is
/// a modal consultation), and a single optional makes that true by construction instead of by
/// remembering to close the other two.
///
/// An `ObservableObject` for the same reason `SearchPalettePresentation` is one — the buttons that
/// open these live in the sidebar's account row while the panels are overlays on the shell ROOT.
@MainActor
final class ShellOverlayPresentation: ObservableObject {
    @Published var overlay: ShellOverlay?

    var isPresented: Bool { overlay != nil }

    func open(_ overlay: ShellOverlay) { self.overlay = overlay }
    func close() { overlay = nil }

    /// Same door, twice = closed. Matches ⌘K's behaviour on the search palette.
    func toggle(_ overlay: ShellOverlay) {
        self.overlay = self.overlay == overlay ? nil : overlay
    }
}

// MARK: - Metrics

/// Each panel is sized for its own content rather than sharing one box: the library holds a
/// sidebar and a list, devices holds a handful of rows, updates holds a version table and a
/// progress bar. A shared size would be wrong for two of the three.
/// ONE footprint for all three, taken from the search palette (user call: "standarize the shapes of
/// these pannels based on the search pannel").
///
/// Three different heights was the earlier cut, on the reasoning that the content genuinely differs
/// — but that is the content's problem, not the window's: each panel then opened at its own size
/// AND, being centred, at its own vertical position, so moving between them made the surface jump
/// around. Fixed and identical, they read as one surface showing different things, which is what
/// they are. Anything taller than the box scrolls inside it.
///
/// The height is the palette's own maximum — its results cap plus its field row — so a full ⌘K and
/// any of these panels occupy exactly the same rectangle.
let shellOverlayHeight: CGFloat = searchPaletteMaxResultsHeight + 52

func shellOverlaySize(_ overlay: ShellOverlay) -> CGSize {
    CGSize(width: searchPaletteWidth, height: shellOverlayHeight)
}

let shellOverlayCornerRadius: CGFloat = searchPaletteCornerRadius

/// ONE shape for the card, its clip and its fill — three places that must agree, so they read the
/// same value rather than three literals that happen to match today.
let shellOverlayShape = RoundedRectangle(cornerRadius: searchPaletteCornerRadius, style: .continuous)

/// A whisper of the palette's own surface under the material, so the panels sit in the same colour
/// family as ⌘K instead of reading as raw system chrome.
let shellOverlayTintOpacity: Double = 0.18
let shellOverlayScrimOpacity: Double = searchPaletteScrimOpacity
/// Where the card sits. The palette's own top inset, not centred (2026-09-18): centring put each
/// panel at a different height — one per content size — while ⌘K dropped from a fixed point. Same
/// inset for all four means opening any of them puts the surface in the same place.
let shellOverlayTopInset: CGFloat = searchPaletteTopInset
/// The library's own internal tab column. Narrower than the shell sidebar — it lists five fixed
/// words, not session titles.
let libraryTabColumnWidth: CGFloat = 176

/// PURE: how a daemon-side failure is shown to a person (2026-09-18).
///
/// Our sentence first, the daemon's words second and clipped. The reason is concrete: a settings
/// write can fail with a raw zod dump inside an INTERNAL error, and a surface that renders the
/// error verbatim shows the user a wall of JSON as if it were a message written for them. The
/// daemon's text still appears — it is often the only thing that identifies WHICH field was wrong —
/// but it is evidence attached to our sentence, not the sentence itself.
func shellPanelErrorText(_ ownSentence: String, detail: String) -> String {
    let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return ownSentence }
    let oneLine = trimmed.replacingOccurrences(of: "\n", with: " ")
    let clipped = oneLine.count > shellPanelErrorDetailLimit
        ? String(oneLine.prefix(shellPanelErrorDetailLimit)) + "…"
        : oneLine
    return "\(ownSentence) — \(clipped)"
}

/// Long enough to carry a field name and a reason, short enough that a serialized schema cannot
/// take over the panel.
let shellPanelErrorDetailLimit = 200

// MARK: - The close button's gutter

/// How much room a panel's own content must leave at its top-trailing corner for the close button.
///
/// The button sat OUTSIDE the card for a while, which avoided the collision by leaving the card
/// entirely — but it also floated in space above the corner. It is back inside (user call,
/// 2026-09-18), so the collision is solved the other way: a hosted pane reads this value and pushes
/// its own trailing controls left by exactly that much. Zero everywhere else, so the same pane
/// rendered in the Dashboard is unchanged.
private struct ShellPanelCloseGutterKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var shellPanelCloseGutter: CGFloat {
        get { self[ShellPanelCloseGutterKey.self] }
        set { self[ShellPanelCloseGutterKey.self] = newValue }
    }
}

/// The button's own width plus a little air.
let shellOverlayCloseGutter: CGFloat = shellTitlebarButtonSize + 8

// MARK: - The container

/// THE card chrome, extracted (2026-09-18) so a surface that is not a `ShellOverlay` can wear it
/// without copy-pasting eleven modifiers that must agree.
///
/// `ShellFloatingPanel` is now a one-line forwarder onto this, and Settings → Roles' model picker
/// is the second caller. Everything that made a panel a panel lives here and nowhere else: the
/// scrim and its click-away, the top inset, the fixed footprint, the clip, the material, the tint,
/// the rim, the shadow, the close button in the corner, and the two environment values a hosted
/// pane reads (`shellPanelCloseGutter`, `shellRowFillIsVibrant`).
///
/// The only thing the caller supplies beyond its content is the NAME — used for the accessibility
/// label and the close button's own label. A `ShellOverlay` has one
/// (`shellOverlayAccessibilityName`); the picker supplies its own sentence.
///
/// **Not parameterised by size.** The footprint is the search palette's, exactly, for the same
/// reason the three panels share it: opening any of these surfaces must put the same rectangle in
/// the same place rather than making the window jump. A caller wanting a different size does not
/// want this card.
struct ShellPanelCard<Content: View>: View {
    /// What this surface is called, for VoiceOver and for the close button's label.
    let accessibilityName: String
    let onClose: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(shellOverlayScrimOpacity)
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
            card
                .padding(.top, shellOverlayTopInset)
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .environment(\.shellPanelCloseGutter, shellOverlayCloseGutter)
        }
        // The palette's footprint, read from the same two constants `shellOverlaySize` returns —
        // that function ignores its argument and always answers this pair, so nothing changed when
        // the card stopped taking an overlay.
        .frame(width: searchPaletteWidth, height: shellOverlayHeight)
        // CLIPPED, not merely backed by a rounded shape (2026-09-18): a re-housed pane paints its
        // own background right to its own edges, so without this the card's bottom corners are
        // square wherever the content reaches them — visible on the devices panel.
        .clipShape(shellOverlayShape)
        // `.ultraThinMaterial` (user call), not an `NSVisualEffectView`: a SwiftUI material already
        // blends WITHIN the window, which is exactly what a panel floating over the transcript
        // wants, and it is the thinnest of the set. The sidebar's behind-window vibrancy is a
        // different job and keeps its own view (`ShellVibrancyBackground`).
        .background(.ultraThinMaterial, in: shellOverlayShape)
        .background(shellOverlayShape.fill(Theme.paletteSurface.opacity(shellOverlayTintOpacity)))
        // The rim (user call, 2026-09-18). It earns its place more here than on an opaque card:
        // over `.ultraThinMaterial` the edge is only as defined as whatever happens to be behind
        // it, so a dark transcript under a dark panel leaves the boundary to the shadow alone.
        // `hairlineElevated` is the brand's own line for a surface sitting ABOVE the plane.
        .overlay(shellOverlayShape.strokeBorder(Theme.hairlineElevated,
                                                lineWidth: shellSidebarHairlineWidth))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
        // Back INSIDE the card, in its own corner (user call). What stops it landing on the panes'
        // own Refresh buttons is `shellPanelCloseGutter`, which those panes read and inset by.
        .overlay(alignment: .topTrailing) {
            ShellTitlebarButton(systemImage: "xmark",
                                label: "Close \(accessibilityName)",
                                action: onClose)
                .padding(.top, 10)
                .padding(.trailing, 10)
        }
        .accessibilityLabel(accessibilityName)
        // The panel is its own OPAQUE surface, so rows inside it keep the opaque greys rather than
        // the washes the translucent sidebar wears (see `ShellSidebarRowStyle`'s fill).
        .environment(\.shellRowFillIsVibrant, false)
    }
}

/// The shared chrome every panel wears: a dimmed, click-away backdrop and one centred card with a
/// titled header and a close button.
///
/// Centred, unlike the search palette (which is top-pinned because its list grows and shrinks as
/// you type). These three are fixed-size consultations, so centring is right for them and the
/// palette's reasoning does not carry over.
///
/// Since 2026-09-18 this is a NAME over `ShellPanelCard` and nothing else — the chrome moved there
/// so Settings' model picker could wear the identical card. Behaviour is unchanged: the name it
/// passes is the one this type always used.
struct ShellFloatingPanel<Content: View>: View {
    let overlay: ShellOverlay
    let onClose: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        ShellPanelCard(accessibilityName: shellOverlayAccessibilityName(overlay),
                       onClose: onClose,
                       content: content)
    }
}

// MARK: - The library panel

/// The library: one tab column, one detail side.
///
/// Each tab's body lives in `Sources/Library/`, one file per tab, with the reasoning for its own
/// half of the world. Where each stands (the daemon work is owned by other sessions):
/// - **Skills** — BUILT. `skills.list`/`read`/`write`/`delete` all exist; `LibrarySkillsTab`
///   re-houses the Dashboard's own `SkillsPane` over `DashboardWiring.skillsModel`. No per-skill
///   on/off switch: that is arriving as a `Skill(<name>)` permission deny rule, not as a field.
/// - **Plugins** — BUILT. `LibraryPluginsTab` re-houses `PluginManagerView` and the whole
///   lifecycle it already drives (install/enable/disable/remove/restart/consent).
/// - **Hooks** — SHAPE BUILT, data pending. Grouped by the plugin that declares them, with the
///   live plugin list underneath; the declarations themselves need `manifestHooks` on
///   `PluginInfoSchema` (the daemon parses and runs them already, the wire schema drops the field).
/// - **MCP tools** — SHAPE BUILT, both halves pending for DIFFERENT reasons. External servers are
///   served by `mcp.list` but this panel has no door to a client (`DashboardWiring` carries no
///   `mcpList` closure); Winter's own `winter__<key>` capability servers are not in that response
///   at all and need the new `capabilities.list`.
/// - **Agents** — SHAPE BUILT, nothing daemon-side. Needs the agent-definition store and
///   `agents.list`. A file missing `name:`/`description:` frontmatter is skipped by the runtime, so
///   `AgentDefinitionEntry` models a rejected file as a first-class row, never an omission.
///
/// `wiring == nil` (an app running without daemon wiring — `AppDelegate.makeDashboardWiring`
/// degrades to `nil` when the peripheral provider or the helper client is missing) still renders
/// `LibraryTabPlaceholder`: with no models to observe, every tab would otherwise be an empty list
/// that looks like a daemon with nothing in it.
struct LibraryPanel: View {
    @Binding var tab: LibraryTab
    let wiring: DashboardWiring?

    var body: some View {
        HStack(spacing: 0) {
            tabColumn
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let wiring {
            switch tab {
            case .skills:
                LibrarySkillsTab(model: wiring.skillsModel)
            case .plugins:
                LibraryPluginsTab(
                    model: wiring.pluginManager,
                    tilesModel: wiring.tilesModel,
                    shortcutsModel: wiring.shortcutsModel,
                    helperClient: wiring.helperClient
                )
            case .hooks:
                // The Hooks tab has no toggle of its own — the declaring plugin's enable/disable is
                // the only control — so its one action is a door to the Plugins tab. It is the
                // panel that owns which tab is showing, so the door is handed down as a closure
                // rather than the binding.
                LibraryHooksTab(model: wiring.pluginManager, onOpenPlugins: { tab = .plugins })
            case .mcp:
                // `lister: nil` is the honest state, not an oversight: `DashboardWiring` carries no
                // `mcp.list` door yet (see `LibraryMcpTab`'s header). Wiring it is
                // Two halves, two doors: `mcp.list` for external servers, `capabilities.list`
                // for Winter's own `winter__<key>` servers. Either being absent renders that
                // half's own pending state rather than failing the tab.
                LibraryMcpTab(lister: wiring.mcpList, capabilities: wiring.capabilitiesList)
            case .agents:
                // Empty because there is no `agents.list` to fill it — the tab says so itself.
                LibraryAgentsTab()
            }
        } else {
            LibraryTabPlaceholder(tab: tab, hasWiring: false)
        }
    }

    private var tabColumn: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(LibraryTab.allCases, id: \.self) { candidate in
                Button {
                    tab = candidate
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: libraryTabSystemImage(candidate))
                            .font(Typography.control())
                            .frame(width: 22)
                        Text(libraryTabTitle(candidate))
                            .font(Typography.body())
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: shellSidebarRowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ShellSidebarRowStyle(isSelected: candidate == tab))
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(width: libraryTabColumnWidth, alignment: .leading)
    }
}

/// The honest empty state for a tab with nothing behind it — same posture as
/// `SettingsSectionPlaceholder`.
///
/// Every tab now has a real body, so the only live caller passes `hasWiring: false` (the
/// no-daemon-wiring app). The `true` branch is kept rather than deleted: it is the right answer
/// for any tab a future cycle adds before its body exists, and it costs one line.
struct LibraryTabPlaceholder: View {
    let tab: LibraryTab
    let hasWiring: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(libraryTabTitle(tab))
                .font(Typography.emptyStateTitle)
            Text(hasWiring ? "Not built yet." : "This app is running without daemon wiring.")
                .font(Typography.body())
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(24)
    }
}

/// The shared placeholder body for the two single-pane panels.
struct LibraryPanelPlaceholderBody: View {
    let title: String
    let detail: String
    let hasWiring: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(Typography.emptyStateTitle)
            Text(hasWiring ? detail : "This app is running without daemon wiring.")
                .font(Typography.body())
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
