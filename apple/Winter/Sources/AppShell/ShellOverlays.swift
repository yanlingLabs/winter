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
    ///
    /// A caller that needs a SPECIFIC tab (Settings → Plugins' rows) says so through
    /// `ShellOverlayPresentation.openLibrary(at:)`, which carries the tab as a one-shot REQUEST
    /// beside this case rather than in it; the root applies it to its remembered tab and clears it.
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

/// PURE: the panel's name — its accessibility label, and (for the library, since 2026-09-18) the
/// heading at the top of its tab column. The library went nameless for a day (2026-09-17) by
/// dropping a whole header band; the name came back (user call: "add back the title") as a
/// sidebar-style heading above the tabs instead, so it is named where the eye starts without the
/// band.
func shellOverlayAccessibilityName(_ overlay: ShellOverlay) -> String {
    switch overlay {
    case .library: return "Library"
    case .devices: return "Devices"
    case .updates: return "Updates"
    }
}

// MARK: - Presentation

/// **THE SHELL'S MODAL LAYER — one object, one thing open.**
///
/// It began (2026-09-17) as "which of the three panels is showing", one optional rather than three
/// flags so that mutual exclusion was true by construction instead of by remembering to close the
/// other two. 2026-09-18 extends exactly that reasoning to the two surfaces that were living
/// alongside it: the ⌘K SEARCH PALETTE (whose own flag is still a `SearchPalettePresentation`,
/// because `SidebarSearchPalette` owns that type) and Settings → Roles' MODEL PICKER.
///
/// All five — search, library, devices, updates, picker — are the same kind of thing: a floating
/// consultation you make and dismiss. Two of them on screen at once has never been a state anybody
/// wants, and before this they could be: the palette's flag and the panel's optional knew nothing
/// about each other. Now every OPEN door on this object clears the other two kinds first, so
/// "exactly one" is a property of this class rather than a rule five call sites remember.
///
/// **Every open must therefore go through this object.** The five doors are the ⌕ and ⌘K
/// (`ShellRootView`/`ShellSidebar`), the account row's three icons, `AppDelegate`'s "Check for
/// Updates…" (`open(.updates)`, unchanged), and the Roles pane's value rows
/// (`openRolePicker(_:)`). Closing needs no coordination and stays plain.
///
/// An `ObservableObject` for the same reason `SearchPalettePresentation` is one — the buttons that
/// open these live in the sidebar's account row while the panels are overlays on the shell ROOT.
@MainActor
final class ShellOverlayPresentation: ObservableObject {
    @Published private(set) var overlay: ShellOverlay?
    /// The Roles picker's live request, or nil — the MODEL card or the EFFORT card
    /// (`SettingsRolePickerRequest.kind`). One slot for both, so they exclude each other too. A REQUEST rather than a case on
    /// `ShellOverlay`: the card needs the role, the pane's live `SettingsRolesModel` and the
    /// catalog store, none of which can live in a `Hashable` enum — and stuffing closures into one
    /// would put the picker's behaviour in the enum's callers instead of in the picker.
    @Published private(set) var picker: SettingsRolePickerRequest?
    /// A one-shot "show the library at THIS tab" (2026-09-18, Settings → Plugins), or nil.
    ///
    /// Which tab the library shows is the root's own remembered state (`ShellRootView.libraryTab`),
    /// so that a plain reopen returns to the tab you left. A request does not replace that memory —
    /// the root copies it INTO the memory and clears it (`clearLibraryTabRequest()`), after which
    /// the chosen tab simply IS the tab you left. Every open door clears it first, so it can only
    /// ever be set while the library itself is the surface showing.
    @Published private(set) var libraryTabRequest: LibraryTab?

    /// The search palette's own flag. OWNED here (rather than beside this object) so that opening
    /// a panel can close the palette without a back-reference somebody has to remember to wire;
    /// `ShellRootView` observes the same instance it is handed here.
    let search: SearchPalettePresentation

    /// `search` is an OPTIONAL rather than defaulting straight to a fresh instance: a default
    /// ARGUMENT VALUE expression is checked as a nonisolated context regardless of the enclosing
    /// initializer's own isolation, and `SearchPalettePresentation.init` is `@MainActor` — the same
    /// trap `AppWindowController.init`'s `navigation:` parameter documents. The fallback is built
    /// in this (`@MainActor`) body instead.
    init(search: SearchPalettePresentation? = nil) {
        self.search = search ?? SearchPalettePresentation()
    }

    var isPresented: Bool { overlay != nil }

    func open(_ overlay: ShellOverlay) {
        closePicker()
        search.close()
        libraryTabRequest = nil
        self.overlay = overlay
    }

    /// Open the library AT `tab`. Goes through `open(.library)`, so the one-surface rule holds by
    /// the same construction as every other door; the tab rides along as `libraryTabRequest`.
    /// Already open on another tab: stays open, and moves to `tab`.
    func openLibrary(at tab: LibraryTab) {
        open(.library)
        libraryTabRequest = tab
    }

    /// The root has applied the request to its remembered tab.
    func clearLibraryTabRequest() {
        libraryTabRequest = nil
    }

    func close() {
        overlay = nil
        libraryTabRequest = nil
    }

    /// Same door, twice = closed. Matches ⌘K's behaviour on the search palette.
    func toggle(_ overlay: ShellOverlay) {
        if self.overlay == overlay { close() } else { open(overlay) }
    }

    // MARK: The search palette

    func openSearch() {
        overlay = nil
        libraryTabRequest = nil
        closePicker()
        search.open()
    }

    /// ⌘K and the ⌕ both toggle, so the same door closes what it opened.
    func toggleSearch() {
        if search.isPresented { search.close() } else { openSearch() }
    }

    // MARK: The Roles model picker

    func openRolePicker(_ request: SettingsRolePickerRequest) {
        overlay = nil
        libraryTabRequest = nil
        search.close()
        closePicker()
        picker = request
        request.roles.pickerDidOpen(request.role)
    }

    /// The ONE way the picker goes away — the close button, the scrim, Esc, and every exclusion
    /// path above. It tells the pane's model, which is what lets a write still in flight report its
    /// failure to the pane instead of into a card nobody can see (`SettingsRolesModel.commit`).
    func closeRolePicker() {
        closePicker()
    }

    /// **Close THIS picker, if it is still the one showing.**
    ///
    /// A commit outlives its card: close the picker for role A mid-write, open one for role B, and
    /// A's reply then lands with a close in its hand. An unconditional close would take B down with
    /// it. Identity is the role AND the model object, because two panes could in principle be
    /// showing the same role.
    func closeRolePicker(ifShowing request: SettingsRolePickerRequest) {
        guard picker == request else { return }
        closePicker()
    }

    private func closePicker() {
        guard let open = picker else { return }
        picker = nil
        open.roles.pickerDidClose()
    }
}

/// The narrow door the Roles pane needs from the shell: "show this picker". Declared by the picker
/// (`SettingsRoleModelPicker.swift`) and conformed to here, so Settings depends on the capability
/// rather than on the shell's whole modal layer — and a test can stand in for it.
extension ShellOverlayPresentation: SettingsRolePickerPresenting {}

/// The Plugins page's door: "show the library at this tab" (`SettingsPluginsSection.swift`).
extension ShellOverlayPresentation: SettingsLibraryPresenting {}

/// PURE: the tab the library shows — a pending request wins over the remembered tab. The root's
/// binding reads through this so the panel's FIRST frame is already on the requested tab, instead
/// of flashing the remembered one until the request is applied.
func libraryTabShowing(remembered: LibraryTab, requested: LibraryTab?) -> LibraryTab {
    requested ?? remembered
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
        .shellFloatingSurface()
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

/// The library: TWO STATES, the model picker's own pattern (2026-09-18, user call — "we shouldn't
/// keep the 3 columns").
///
/// - **LIST** — the tab column (headed "Library") + ONE list of the tab's items filling the rest.
/// - **DETAIL** — one item as the whole card's subject: the tab column is gone, a header carries a
///   back chevron and the item's name, and its contents run full width and scroll
///   (`LibraryDetailPage`, drawn like `SettingsRoleModelPicker`'s step two).
///
/// Every transition is a pure function in `Sources/Library/LibraryNavigation.swift`
/// (`LibraryNavigationTests`): a tab click always lands on that tab's list, back returns to the
/// same tab's list, Esc steps back from a detail (and is left alone on a list, as before), and a
/// detail whose subject vanishes (a deleted skill, a removed plugin) returns to the list.
///
/// **The list stays MOUNTED under a detail**, hidden, disabled and out of the accessibility tree —
/// so back returns to exactly the scroll position you left, with the item you opened marked, and
/// no list re-reads the daemon just because you came back to it.
///
/// **The models live here, not in the tabs.** The detail page replaces the tab's list and must read
/// the same data, so the MCP tab's two models are `@StateObject`s of the PANEL (alive as long as
/// the panel is up); every other tab's model is a process-lifetime one on `DashboardWiring`.
///
/// `wiring == nil` (an app running without daemon wiring — `AppDelegate.makeDashboardWiring`
/// degrades to `nil` when the peripheral provider or the helper client is missing) still renders
/// `LibraryTabPlaceholder`: with no models to observe, every tab would otherwise be an empty list
/// that looks like a daemon with nothing in it.
struct LibraryPanel: View {
    @Binding var tab: LibraryTab
    let wiring: DashboardWiring?

    /// Which item's DETAIL is showing, or nil for the tab's LIST. The panel's own state, so it dies
    /// with the panel: reopening the library always lands on a list (of the tab you left — that
    /// half is `ShellSidebar`'s).
    @State private var detail: LibraryItemRef?
    /// The item last opened, kept after back so its row stays marked in the list.
    @State private var lastOpened: LibraryItemRef?

    /// Hoisted from the MCP tab (see the type's doc). Both built from the wiring's own doors; a
    /// `nil` door is each model's own first-class "no door" state. Neither is ever given a cwd.
    @StateObject private var mcpModel: McpToolsModel
    @StateObject private var capabilitiesModel: WinterCapabilitiesModel

    /// There is no `agents.list` yet, so the Agents tab is fed an empty list — the seam that changes
    /// when the daemon lands its half.
    private let agentEntries: [AgentDefinitionEntry] = []

    init(tab: Binding<LibraryTab>, wiring: DashboardWiring?) {
        _tab = tab
        self.wiring = wiring
        _mcpModel = StateObject(wrappedValue: McpToolsModel(lister: wiring?.mcpList))
        _capabilitiesModel = StateObject(wrappedValue: WinterCapabilitiesModel(lister: wiring?.capabilitiesList))
    }

    private var navigation: LibraryNavigationState {
        LibraryNavigationState(tab: tab, detail: detail)
    }

    private func apply(_ next: LibraryNavigationState) {
        if next.tab != tab { tab = next.tab }
        detail = next.detail
    }

    private func open(_ item: LibraryItemRef) {
        lastOpened = item
        apply(libraryNavigationOpening(navigation, item))
    }

    private func back() {
        apply(libraryNavigationBack(navigation))
    }

    private func vanished(_ item: LibraryItemRef) {
        apply(libraryNavigationSubjectVanished(navigation, item))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            listLayer
                .opacity(navigation.isDetail ? 0 : 1)
                .allowsHitTesting(!navigation.isDetail)
                .disabled(navigation.isDetail)
                .accessibilityHidden(navigation.isDetail)
            if let detail {
                detailPage(detail)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .background {
            if let wiring {
                // At the ROOT, outside the list layer: that layer is disabled while a detail shows,
                // and a sheet inheriting that would open with dead buttons.
                LibraryPluginConsentSheetHost(model: wiring.pluginManager)
            }
        }
        .background {
            // Esc steps back from a detail page — the picker host's device (a zero-size hidden
            // `.cancelAction` button, plus `.onExitCommand` for when something inside holds focus).
            // Rendered ONLY on a detail, so on a list Esc is exactly as unclaimed as it was.
            if libraryEscapeOutcome(navigation) == .back {
                Button("Back", action: back)
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .frame(width: 0, height: 0)
                    .accessibilityHidden(true)
            }
        }
        .onExitCommand {
            if libraryEscapeOutcome(navigation) == .back { back() }
        }
        // The tab binding is `ShellSidebar`'s; if anything else moves it, a detail from another tab
        // must not survive under it.
        .onChange(of: tab) { _, _ in
            apply(libraryNavigationReconciled(navigation))
        }
    }

    // MARK: LIST

    private var listLayer: some View {
        HStack(spacing: 0) {
            tabColumn
            Divider()
            list
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private var list: some View {
        if let wiring {
            switch tab {
            case .skills:
                LibrarySkillsList(model: wiring.skillsModel, selected: lastOpened, onOpen: open)
            case .plugins:
                LibraryPluginsList(model: wiring.pluginManager,
                                   shortcutsModel: wiring.shortcutsModel,
                                   selected: lastOpened, onOpen: open)
            case .hooks:
                LibraryHooksList(model: wiring.pluginManager, selected: lastOpened, onOpen: open)
            case .mcp:
                LibraryMcpList(model: mcpModel, capabilities: capabilitiesModel,
                               selected: lastOpened, onOpen: open)
            case .agents:
                LibraryAgentsList(entries: agentEntries, selected: lastOpened, onOpen: open)
            }
        } else {
            LibraryTabPlaceholder(tab: tab, hasWiring: false)
        }
    }

    /// The panel names itself where the eye starts — at the top of this column, in the register of
    /// a sidebar heading (Settings' own group headings), rather than in a full-width header band
    /// that was a band of nothing around one close button.
    private var tabColumn: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(shellOverlayAccessibilityName(.library))
                .font(Typography.body())
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.top, 6)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
            ForEach(LibraryTab.allCases, id: \.self) { candidate in
                Button {
                    apply(libraryNavigationSelectingTab(navigation, candidate))
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

    // MARK: DETAIL

    @ViewBuilder
    private func detailPage(_ item: LibraryItemRef) -> some View {
        if let wiring {
            switch item {
            case let .skill(name):
                LibrarySkillDetail(model: wiring.skillsModel, name: name,
                                   onBack: back, onVanished: { vanished(item) })
            case let .plugin(name):
                LibraryPluginDetail(model: wiring.pluginManager,
                                    tilesModel: wiring.tilesModel,
                                    shortcutsModel: wiring.shortcutsModel,
                                    name: name,
                                    onBack: back, onVanished: { vanished(item) })
            case let .hooks(pluginName):
                LibraryHooksDetail(model: wiring.pluginManager, pluginName: pluginName,
                                   onBack: back,
                                   onOpenPlugin: { open(.plugin(name: pluginName)) },
                                   onVanished: { vanished(item) })
            case let .mcpServer(name):
                LibraryMcpServerDetail(model: mcpModel, name: name,
                                       onBack: back, onVanished: { vanished(item) })
            case let .winterCapability(key):
                LibraryWinterCapabilityDetail(capabilities: capabilitiesModel, key: key,
                                              onBack: back, onVanished: { vanished(item) })
            case let .agent(path):
                LibraryAgentDetail(entries: agentEntries, path: path, onBack: back)
            }
        } else {
            // Unreachable — with no wiring there is no list to open anything from — but a detail
            // must still have a way back.
            LibraryDetailPage(title: libraryTabTitle(item.tab), backLabel: "Back", onBack: back) {
                LibraryStateLine(text: "This app is running without daemon wiring.")
            }
        }
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

// MARK: - The floating surface, shared

extension View {
    /// The material every floating surface wears — the three panels, the Roles pickers AND the ⌘K
    /// search palette (2026-09-18, user call: the palette was the one still painting an opaque
    /// fill). ONE modifier, so the four cannot drift into four slightly different glasses.
    ///
    /// - `.ultraThinMaterial`, not an `NSVisualEffectView`: a SwiftUI material already blends
    ///   WITHIN the window, which is what a surface floating over the transcript wants, and it is
    ///   the thinnest of the set. The sidebar's behind-window vibrancy is a different job and keeps
    ///   its own view (`ShellVibrancyBackground`).
    /// - A whisper of `paletteSurface` under it, so the glass sits in the app's colour family
    ///   rather than reading as raw system chrome.
    /// - The rim: over a translucent material the edge is only as defined as whatever is behind it,
    ///   so a dark transcript under a dark surface would leave the boundary to the shadow alone.
    func shellFloatingSurface() -> some View {
        background(.ultraThinMaterial, in: shellOverlayShape)
            .background(shellOverlayShape.fill(Theme.paletteSurface.opacity(shellOverlayTintOpacity)))
            .overlay(shellOverlayShape.strokeBorder(Theme.hairlineElevated,
                                                    lineWidth: shellSidebarHairlineWidth))
            .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
    }
}
