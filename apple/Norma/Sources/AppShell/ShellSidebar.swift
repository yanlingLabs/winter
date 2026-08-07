import AppKit
import SwiftUI

/// The shell's root content: the nav sidebar and the selected destination's surface.
///
/// custom-sidebar rework (2026-08-07, the [[custom-chrome-not-native]] correction): a plain
/// `HStack(spacing: 0)` — the fully CUSTOM pane + a hairline + the detail — NOT a
/// `NavigationSplitView`. Pass 1's T1 reskinned WITHIN the native sidebar column (system material,
/// native `List` rows, the macOS-26 floating-column inset, native selection pills) and the user
/// corrected it: "like ChatGPT" means the LOOK, custom-drawn — nothing from AppKit's sidebar
/// vocabulary. The house precedent is `DashboardSurface`'s own hand-rolled `HStack`+`ScrollView`
/// pane; the styling authority stays the ChatGPT desktop app's sidebar (the 2026-08-06 spec's
/// reference screenshots) — flat and opaque, NOT the iOS 26 Liquid Glass gallery, which remains
/// the PHONE's authority only.
struct ShellRootView: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    /// app-shell T3: the session host. `nil` for a shell built without one (see
    /// `AppWindowController.host`), which simply renders the landing placeholders it always did.
    var host: ShellSessionHost?
    /// Task 7: the Dashboard's injected data/closures — `nil` for a shell built without one (see
    /// `AppWindowController.dashboardWiring`), same host-less-fallback posture as `host` above.
    var dashboardWiring: DashboardWiring?
    /// Bugfix pass B4: the chat landing's "New Chat" door — `AppDelegate.newChat()` injected
    /// through `AppWindowController.openNewChat`; `nil` for a shell built without one (same
    /// fallback posture as `host`/`dashboardWiring` above), which renders the landing with no
    /// button (`chatLandingShowsNewChatButton`'s gate).
    var newChat: (() -> Void)? = nil
    /// Task 7: the Dashboard's current-pane memory — UNCONDITIONAL (see
    /// `AppWindowController.dashboardSelection`'s own doc comment for why it's never optional).
    @ObservedObject var dashboardSelection: DashboardSelectionModel
    /// Task 7 (spec §1 windows disposition): the pairing sheet's presentation state, attached below
    /// as a SwiftUI `.sheet` — replaces `PairingSheetWindowController` (deleted this task).
    @ObservedObject var pairingPresentation: PairingSheetPresentationModel
    /// sidebar-brand T4: the search palette's presentation state, owned HERE rather than in the
    /// sidebar — the palette is an overlay on this ROOT (so it centres over the whole window and
    /// survives whatever destination is showing), while the ⌕ that opens it lives in the pane.
    /// The two are siblings, so the state has to live at their common parent.
    @StateObject private var searchPalette = SearchPalettePresentation()
    /// sidebar-brand: whether the sidebar pane is showing. `@State` on the root suffices — the
    /// window outlives every hide/re-summon (`AppWindowController` owns it forever), so the user's
    /// choice survives exactly as long as the window itself does.
    @State private var sidebarVisible = true

    var body: some View {
        HStack(spacing: 0) {
            // The sidebar carries the host (Move to CLI on Recents rows) and the injected New chat
            // door — both optional, same fallback posture as `detail` below. It owns its own fixed
            // width (`shellSidebarWidth`) — the split view's user-draggable 208–320 column died
            // with the container. sidebar-brand supersedes that rework's "no collapse toggle"
            // ruling: the pane now collapses, driven by the titlebar toggle below.
            if sidebarVisible {
                ShellSidebar(nav: nav, directory: directory, host: host, newChat: newChat,
                             presentation: searchPalette)
                    // Slides out to the leading edge rather than fading — the pane is a physical
                    // surface, and a fade reads as dissolving rather than closing.
                    .transition(.move(edge: .leading))
                // chatgpt-ui T3's boundary hairline, now a genuine layout sibling rather than an
                // overlay compensating for the split view's undrawn divider. `ignoresSafeArea` so
                // it spans the full height including the transparent-titlebar region — the ChatGPT
                // reference's full-height line. sidebar-brand: the warm brand `hairline` replaces
                // the system `separatorColor`, which reads cool against the cream planes either
                // side; and it leaves WITH the pane (a divider dividing nothing is just a stripe).
                Rectangle()
                    .fill(Theme.hairline)
                    .frame(width: shellSidebarHairlineWidth)
                    .ignoresSafeArea()
            }
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // sidebar-brand T5: the RAISED plane (`docs/brand.md` § the plane mapping).
                // REQUIRED, not cosmetic: the sidebar's cream only reads correctly against a
                // painted content plane — against the window's default system grey it looks
                // wrong rather than warm. Painted here, at the shell level, so every destination
                // inherits it and none has to remember; the transcript/composer/cards keep their
                // own treatment for the next pass.
                .background(Theme.cardSurface)
        }
        // app-shell T4: the hop-away "keep working?" banner (spec §1, T3 review as-m9) — an
        // OVERLAY on the whole split view, not inside `detail`, so it survives the very
        // navigation that triggered it (the user has already moved on to a different surface by
        // the time this appears).
        .overlay(alignment: .bottom) {
            if let host {
                HopAwayBannerHost(host: host, directory: directory)
            }
        }
        // Task 7: the pairing ceremony rides ON the shell now, not its own `NSPanel` window —
        // `isPresented` and `onDismiss` both go through `pairingPresentation.dismiss()` so the
        // system's own close gesture (and this view's explicit close button,
        // `PairingSheetContainerView`'s overlay) run the SAME teardown.
        .sheet(isPresented: Binding(
            get: { pairingPresentation.isPresented },
            set: { if !$0 { pairingPresentation.dismiss() } }
        )) {
            PairingSheetContainerView(presentation: pairingPresentation)
        }
        // sidebar-brand: the sidebar toggle, pinned in the titlebar band just right of the traffic
        // lights — the reference's placement, and FIXED there in both states so the affordance
        // does not vanish along with the pane it controls. An overlay on the root (not a child of
        // the pane) is what makes that possible.
        .overlay(alignment: .topLeading) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { sidebarVisible.toggle() }
            } label: {
                Image(systemName: shellSidebarToggleSystemImage(isVisible: sidebarVisible))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: shellSidebarToggleSize, height: shellSidebarToggleSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(shellSidebarToggleLabel(isVisible: sidebarVisible))
            .accessibilityLabel(shellSidebarToggleLabel(isVisible: sidebarVisible))
            .padding(.leading, shellSidebarToggleLeadingInset)
            .padding(.top, shellSidebarToggleTopInset)
            // The whole point of the placement: sit in the TITLEBAR band beside the traffic
            // lights. Without this the overlay is laid out inside the safe area and drops level
            // with the wordmark instead — the same top-safe-area opt-out the pane itself takes.
            .ignoresSafeArea(.container, edges: .top)
        }
        // sidebar-brand T4: the search palette (spec R2) — an overlay on the WHOLE shell so it
        // centres over the window rather than over the detail pane, and so it survives whatever
        // destination is showing beneath it. No dimming scrim; the reference has none.
        //
        // Declared AFTER the toggle overlay above, deliberately: the palette's backdrop then sits
        // ON TOP of the toggle, so while the palette is open a click there dismisses it rather
        // than collapsing the sidebar behind it. That is the modal behaviour we want — one click,
        // one effect — and it is a consequence of this ordering, so do not reorder these two
        // without meaning to. (The traffic lights are unaffected: they are `NSWindow` buttons
        // living above the content view, not SwiftUI siblings, so they stay clickable throughout.)
        .overlay {
            if searchPalette.isPresented {
                SidebarSearchPalette(nav: nav, directory: directory, presentation: searchPalette)
            }
        }
        // ⌘K, the palette's other door (the wordmark row's ⌕ is the first). A zero-size hidden
        // button is how a SwiftUI view registers a chord with no menu-bar item behind it; it
        // TOGGLES so the same chord closes what it opened.
        .background {
            Button("Search sessions") { searchPalette.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    /// The destination's surface. Six are real as of T7 — a hosted session, the chat landing, the
    /// code landing, the dispatch surface, the cowork Coming-soon, and the Dashboard surface —
    /// leaving no destination on T1's placeholder in production (it's reached only by a shell built
    /// without the relevant wiring, e.g. the pure geometry tests).
    @ViewBuilder
    private var detail: some View {
        switch nav.destination {
        case .newChat:
            // chatgpt-ui T2: the new-chat page (spec §2) — the launch surface, and every New-chat
            // door's target. Host-required: the first send creates through the host's management
            // client; a host-less shell (the pure window tests) renders the honest placeholder,
            // same posture as `.mode(.code)` below.
            if let host {
                NewChatPage(nav: nav, host: host)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .session:
            if let host {
                ShellSessionView(host: host, directory: directory)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.chat):
            ChatLandingView(nav: nav, directory: directory, newChat: newChat)
        case .mode(.code):
            if let host {
                ModeLandingView(mode: .code, nav: nav, directory: directory, host: host)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.dispatch):
            // T5: dispatch always shows the ONE singleton session (`ShellSessionHost.apply`'s
            // `.mode(.dispatch)` case), the same host-required shape `.mode(.code)` has above —
            // there is no session to attach to without one.
            if let host {
                DispatchSurface(nav: nav, directory: directory, host: host)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.cowork):
            // Needs no host — there is nothing here to attach, list, or create.
            CoworkPlaceholder()
        case .dashboard:
            // Task 7: needs no host either — `DashboardSurface` attaches to nothing, it only reads
            // `dashboardWiring`'s injected closures (mirrors `.mode(.cowork)`'s own "no host"
            // shape). The SPECIFIC pane shown is `dashboardSelection.selection`, not read from
            // `nav.destination`'s own payload here — see `AppWindowController.summon`'s doc comment
            // for how a non-nil payload reaches that model.
            if let dashboardWiring {
                DashboardSurface(wiring: dashboardWiring, selection: dashboardSelection)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        }
    }
}

// MARK: - The sidebar's pure shape (chatgpt-ui T1 — driven directly by AppShellTests)

/// A top-of-sidebar row: the New chat ACTION row, or one of the four mode rows. Exactly the
/// spec §1 structure; the search field, Recents and the account row sit below and have their own
/// pure helpers (`filteredRecents`, `recentsActivityDotStyle`, `shellSidebarAccountRowDestination`).
enum ShellSidebarRow: Hashable {
    case newChat
    case mode(SessionMode)
}

/// THE row order, spec §1: New chat topmost, then Chats, then Code/Dispatch/Cowork. Derived from
/// `SessionMode.sidebarOrder` so the two pins (`AppShellTests`) move in lockstep by construction.
let shellSidebarTopRows: [ShellSidebarRow] = [.newChat] + SessionMode.sidebarOrder.map { .mode($0) }

/// PURE: the row's label. "New chat" is sentence case (the ChatGPT reference's own register);
/// "Chats" is PLURAL because the row lists chat sessions — the MODE's own title stays "Chat"
/// everywhere else (`ChatLandingView`'s navigation title, `shellDestinationTitle`).
func shellSidebarRowTitle(_ row: ShellSidebarRow) -> String {
    switch row {
    case .newChat: return "New chat"
    case .mode(.chat): return "Chats"
    case .mode(let mode): return mode.title
    }
}

/// PURE: the row's glyph — the spec's pencil-square on New chat; every mode row keeps its own
/// `systemImage` (the reskin restyles rows, it does not rebrand the modes).
func shellSidebarRowSystemImage(_ row: ShellSidebarRow) -> String {
    switch row {
    case .newChat: return "square.and.pencil"
    case .mode(let mode): return mode.systemImage
    }
}

/// PURE: the row's selection destination — `nil` for New chat, which is an ACTION row (it fires
/// the injected door — since T2, `AppDelegate.newChat()`'s summon onto the `.newChat` page — and
/// never sets selection; the List's tags therefore never highlight it, the same quiet posture the
/// mode rows keep while a `.session`/`.dashboard` destination is showing).
/// Mode rows navigate to their `.mode(...)` landings unchanged.
func shellSidebarRowDestination(_ row: ShellSidebarRow) -> ShellDestination? {
    switch row {
    case .newChat: return nil
    case .mode(let mode): return .mode(mode)
    }
}

/// The bottom account-style row's destination — the gear affordance's exact navigation, inherited:
/// a PLAIN `.dashboard(pane: nil)` preserves whichever pane `DashboardSurface`'s own
/// `DashboardSelectionModel` is already showing (see `AppWindowController.summon`'s doc comment);
/// a fresh window still lands on `defaultDashboardPane`.
let shellSidebarAccountRowDestination: ShellDestination = .dashboard(pane: nil)

/// PURE: the search field's Recents filter — case-insensitive SUBSTRING match on the title the
/// user actually SEES (`sessionDisplayTitle`, so an untitled row matches "New session", never its
/// raw nil/whitespace title). Empty or whitespace-only query = the full list; surrounding
/// whitespace is trimmed before matching; order is the caller's (the directory's newest-first),
/// never re-sorted. Deliberately plain `lowercased().contains` — local, deterministic,
/// locale-independent (the same posture every other pure pin in this file's tests takes).
func filteredRecents(_ rows: [SessionSummary], query: String) -> [SessionSummary] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return rows }
    return rows.filter { sessionDisplayTitle($0.title).lowercased().contains(needle) }
}

/// PURE: which Recents rows get the subtle activity dot (spec §1: "activity as a subtle
/// dot/label" — the deglassed compact form of `ActivityChip`). Only the two states that mean
/// "something is happening": active and background. Idle is the resting state (a dot on every row
/// says nothing); `nil` is a non-participating mode (chat/dispatch — `ACTIVITY_MODES`); archived
/// never reaches Recents (`excludingArchived`); an unknown future value is NOT a licence to guess
/// (`moveToCliOffered`'s fail-quiet posture) — a bare dot cannot carry a verbatim label, and the
/// mode landings' full chip still shows the value verbatim, so nothing is silently lost.
func recentsActivityDotStyle(_ activity: String?) -> ActivityChipStyle? {
    switch activityChipStyle(activity) {
    case .active: return .active
    case .background: return .background
    case .idle, .archived, .other, .none: return nil
    }
}

/// chatgpt-ui T3: the sidebar/content boundary hairline's width — a tune-at-gate constant, same
/// posture as `ShellSessionView`'s `topInset: 8` (the live gate may prefer a true pixel hairline;
/// 1 pt reads correctly on Retina and matches the search field's own 1 pt stroke vocabulary).
let shellSidebarHairlineWidth: CGFloat = 1

// MARK: - custom-sidebar: the pane's own metrics + the row treatment (PURE decisions hoisted)

/// The pane's width when it is showing — the ChatGPT desktop sidebar measures ~277 pt
/// (sidebar-brand: was 260). FIXED, not user-draggable: the split view's 208–320 column died with
/// the native container and nothing replaced it.
///
/// It is no longer "always visible", which this comment used to say: sidebar-brand added the
/// collapse toggle the custom-sidebar rework had explicitly declined to build
/// (`shellSidebarToggleSystemImage` and `ShellRootView.sidebarVisible`).
let shellSidebarWidth: CGFloat = 272

/// Explicit top padding clearing the traffic-light region — the pane ignores the top safe area
/// (its flat fill reaches the very top and content scrolls under the transparent titlebar), so
/// NOTHING native reserves that band any more (`NavigationSplitView`'s toolbar-aware integration
/// used to; both are gone). The `DetachedWindowController` `topInset: 52` precedent was sized for
/// the TALLER unified-toolbar band — this window's toolbar died with the rework, so the standard
/// inline titlebar (~28 pt, traffic lights inline at its left) plus breathing room is the right
/// figure. Tune-at-gate constant.
let shellSidebarTopInset: CGFloat = 44

/// Compact row height (icon+label rows and Recents rows alike) — the ChatGPT reference's ~31 pt
/// (sidebar-brand: was 30).
let shellSidebarRowHeight: CGFloat = 32

/// sidebar-brand: the WORDMARK header row's height. Taller than a nav row because it is also
/// what clears the inline traffic lights (together with `shellSidebarTopInset` above it).
let shellSidebarWordmarkRowHeight: CGFloat = 38

/// sidebar-brand: the gap between the nav block and the Recents section label —
/// reference-measured at ~44 pt (was 14). This single value does more than any other to make the
/// pane read like the reference: at the old spacing the whole pane was one undifferentiated
/// column of rows, with nothing separating navigation from history.
let shellSidebarSectionGap: CGFloat = 44

/// The rounded-rect hover/selection fill's corner radius — shared by every row, one vocabulary.
let shellSidebarRowCornerRadius: CGFloat = 6

// MARK: - sidebar-brand: window chrome + the sidebar toggle

/// How far in from the window's top-left corner the traffic lights are nudged, applied by
/// `AppWindowController.positionTrafficLights` (see its doc for WHY it is done by hand rather
/// than by the unified toolbar that normally provides this).
///
/// Arrived at in two passes against the ChatGPT reference: a first estimate of (6, 6) still read
/// visibly shy in a side-by-side, and (10, 8) is the corrected measurement. Tune-at-gate, like
/// every other constant in this block — and note it interacts with
/// `shellSidebarToggleLeadingInset` below, which has to keep clearing the buttons as they move.
let shellTrafficLightInset = CGPoint(x: 10, y: 8)

/// The sidebar toggle's hit box, and where it sits: to the RIGHT of the traffic lights, in the
/// titlebar band, at the same place whether the sidebar is showing or hidden (the reference keeps
/// it fixed there — a toggle that moved with the pane would be unfindable once the pane is gone).
///
/// `shellSidebarToggleTopInset` is measured from the very top of the WINDOW, not from the safe
/// area: the overlay carrying this button ignores the top safe area, exactly as the sidebar pane
/// does. Without that it lands ~34 pt lower, level with the wordmark instead of the traffic
/// lights, which is what the first live build did.
let shellSidebarToggleLeadingInset: CGFloat = 88
let shellSidebarToggleTopInset: CGFloat = 8
let shellSidebarToggleSize: CGFloat = 24

/// PURE: the toggle's glyph, which STATES the sidebar's condition rather than naming the action.
///
/// Two distinct symbols, not one symbol in two tints: showing = a solid leading panel (the pane is
/// there), hidden = an outlined one (there is a pane to bring back). A single glyph would leave
/// the button ambiguous the moment the pane it refers to is off-screen.
func shellSidebarToggleSystemImage(isVisible: Bool) -> String {
    isVisible ? "rectangle.leadinghalf.inset.filled" : "sidebar.left"
}

/// PURE: the toggle's help/accessibility text — the ACTION, complementing the glyph's state.
func shellSidebarToggleLabel(isVisible: Bool) -> String {
    isVisible ? "Hide sidebar" : "Show sidebar"
}

/// The three fills a row can wear. `selected` is the slightly stronger of the two live fills;
/// `none` means the flat pane itself IS the background (a resting row draws nothing).
enum ShellSidebarRowFill: Equatable {
    case none, hover, selected
}

/// PURE: the ONE fill decision every row obeys (top rows, Recents rows, the account row —
/// `ShellSidebarRowStyle` is the single renderer). Selection beats hover: a hovered selected row
/// must keep its stronger fill, never flicker down to the hover tint.
func shellSidebarRowFill(isSelected: Bool, isHovered: Bool) -> ShellSidebarRowFill {
    if isSelected { return .selected }
    if isHovered { return .hover }
    return .none
}

/// PURE: whether a top row renders selected for the current destination — the custom pane's
/// replacement for `List(selection:)`'s tag matching. Derived from `shellSidebarRowDestination`
/// so the action row's quiet posture holds by construction: New chat maps to `nil` and therefore
/// NEVER selects — including while the `.newChat` page itself is showing — and every mode row
/// goes quiet on `.session`/`.dashboard`/`.newChat` destinations (nothing equals them).
func shellSidebarRowIsSelected(_ row: ShellSidebarRow, destination: ShellDestination) -> Bool {
    guard let rowDestination = shellSidebarRowDestination(row) else { return false }
    return rowDestination == destination
}

// MARK: - The sidebar

/// The nav sidebar — chatgpt-ui T1: the ChatGPT desktop app's sidebar anatomy, top to bottom
/// (spec §1's exact order, pinned pure as `shellSidebarTopRows` + `shellSidebarAccountRowDestination`):
///
/// - **New chat** — a compact icon+label ACTION row (pencil-square), topmost. Fires the injected
///   door, never a selection.
/// - **Chats / Code / Dispatch / Cowork** — compact icon+label nav rows onto the existing
///   `.mode(...)` landings; unavailable ones dimmed with a deglassed "Soon" tag but never dead.
/// - **Search** — a thin field filtering Recents by title, live, local-only (`filteredRecents`).
/// - **Recents** — flat, mode-agnostic, compact single-line rows; activity as a subtle dot
///   (`recentsActivityDotStyle` — the chips lost the glass); Move to CLI on the context menu,
///   the SAME `moveToCliOffered` gate + `ShellSessionHost.moveToCli` verb as the landings.
/// - **Account row** — app glyph + "Norma" + chevron → the Dashboard (replaces the gear).
///
/// custom-sidebar rework: the pane is FULLY CUSTOM-DRAWN — a `ScrollView`+`VStack` of hand-rolled
/// rows (the `DashboardSurface` precedent, plus hover), NOT a `List`. Flat OPAQUE
/// `windowBackgroundColor` fill edge-to-edge and top-to-bottom (`ignoresSafeArea` — content
/// scrolls under the transparent titlebar; `shellSidebarTopInset` clears the traffic lights),
/// custom rounded-rect hover/selection fills (`ShellSidebarRowStyle` — the ONE row treatment),
/// a custom section label, custom metrics. Nothing from AppKit's sidebar vocabulary renders here:
/// no system material, no native selection pills, no `.listStyle(.sidebar)`. The old serif
/// wordmark died with the pass-1 reskin — the account row carries the name, New chat sits topmost.
struct ShellSidebar: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    /// chatgpt-ui T1: Move to CLI on Recents rows rides the host's ONE verb (`moveToCli` — which
    /// itself handles the attached-session true move vs the detached launch-only split). `nil` (a
    /// shell built without a host — the pure window/geometry tests) renders no menu item at all,
    /// the same no-dead-affordance posture as `newChat` below.
    var host: ShellSessionHost? = nil
    /// chatgpt-ui T1: the New chat row's door — the SAME injected `AppDelegate.newChat()` the chat
    /// landing's button fires (T2: the door opens the `.newChat` page; the create waits for the
    /// page's first send — B4's one-door rule, retargeted). `nil` renders no row (the
    /// `chatLandingShowsNewChatButton` posture: an unwired door never renders a dead affordance).
    var newChat: (() -> Void)? = nil
    /// sidebar-brand T4: the search palette's presentation flag, OWNED by `ShellRootView` (the
    /// palette is an overlay on the ROOT — a sibling of this pane, not a child of it) and shared
    /// here so the wordmark row's ⌕ can open it. The old inline `searchQuery` state moved into
    /// `SidebarSearchPalette` with the field itself.
    @ObservedObject var presentation: SearchPalettePresentation

    /// Task 7 (carried to the account row): highlighted for ANY `.dashboard` destination
    /// regardless of pane payload, so drilling into a specific pane keeps the row lit.
    private var isDashboardDestination: Bool {
        if case .dashboard = nav.destination { return true }
        return false
    }

    var body: some View {
        VStack(spacing: 0) {
            // sidebar-brand T4: the wordmark is PINNED above the scroll area — it owns the
            // traffic-light clearance now, and rows scroll BENEATH it rather than past it.
            wordmarkRow
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(shellSidebarTopRows, id: \.self) { row in
                        topRow(row)
                    }
                    // The Recents section label — dim, sentence case (uppercase-free, the ChatGPT
                    // register; deliberately NOT `DashboardSurface`'s `.uppercased()` treatment).
                    // sidebar-brand: the warm brand grey at the reference's larger, quieter
                    // register (was 11 pt semibold `.secondary`), under a generous section gap.
                    Text("Recents")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.top, shellSidebarSectionGap)
                        .padding(.bottom, 4)
                    // app-shell T4: Recents FILTERS OUT archived rows (`excludingArchived` — the
                    // hidden-by-default ruling, T3 review as-m10). An ordinary Recents click just
                    // navigates to `.session(id)`, and the shell resumes-by-attaching whatever
                    // it's given (`ShellSessionHost`/`session.attach` clears the archive flag
                    // daemon-side) — so an archived row sitting in this flat, mode-agnostic list
                    // would make an idle click silently un-archive it. Archived sessions are
                    // reachable only through the Archived tab (`ModeLandingView`), where resume is
                    // the stated, deliberate action.
                    // sidebar-brand T2: the ONE shared filter (`recentsCandidates`) — archived
                    // rows stay hidden for the reason above, and the permanent dispatch singleton
                    // is now gone from Recents entirely (spec R6: it is reached only through its
                    // own sidebar row). The search palette calls the same function, so the two
                    // lists cannot drift apart.
                    // sidebar-brand T4: no local query any more — the search field moved into the
                    // palette (spec R2), so this list is simply every candidate row.
                    let recents = recentsCandidates(directory.rows)
                    if recents.isEmpty {
                        Text("No sessions yet")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                    } else {
                        ForEach(recents) { row in
                            recentsRow(row)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            accountRow
        }
        .frame(width: shellSidebarWidth)
        // Flat opaque fill, edge-to-edge and top-to-bottom — the pane's ONE background, reaching
        // the very top of the window (nothing native reserves the titlebar band any more: the
        // window's toolbar died with this rework, `AppWindowController`).
        // sidebar-brand: that fill is now the brand BASE PLANE (`docs/brand.md` § the plane
        // mapping) — warm cream in light, warm charcoal in dark. The content side wears
        // `cardSurface`, one step brighter; that difference IS the separation, and the hairline
        // is only secondary.
        .background(Theme.canvas)
        .ignoresSafeArea(.container, edges: .top)
        // Same "the view's own appearance is the belt" posture as `SessionSidebar.task` — the
        // wirer-level `startInitialLoad()` kick can lose its race against this directory's harness
        // connecting. Task 2 adds the owned 5 s poll on top (visible-only).
        .task { await directory.refresh() }
    }

    /// One top row (`shellSidebarTopRows` order) — every row a plain `Button` wearing the ONE
    /// custom row treatment (`ShellSidebarRowStyle`). New chat fires the injected door and is
    /// never selected; mode rows navigate through the pure destination table
    /// (`shellSidebarRowDestination`) and light up per `shellSidebarRowIsSelected`.
    @ViewBuilder
    private func topRow(_ row: ShellSidebarRow) -> some View {
        switch row {
        case .newChat:
            if let newChat {
                // chatgpt-ui T2: the door now OPENS THE PAGE (`AppDelegate.newChat()` →
                // `summonAppWindow(navigatingTo: .newChat)`) — no create until the page's first
                // send. Still the one injected door all three New-chat affordances share.
                Button(action: newChat) {
                    rowLabel(row)
                }
                .buttonStyle(ShellSidebarRowStyle(isSelected: false))
                .accessibilityLabel("New chat")
            }
        case .mode(let mode):
            Button {
                if let destination = shellSidebarRowDestination(row) {
                    nav.navigate(to: destination)
                }
            } label: {
                rowLabel(row)
                    // Unavailable modes read dimmed — but still select (never a dead row).
                    .foregroundStyle(mode.isAvailable ? .primary : .secondary)
            }
            .buttonStyle(ShellSidebarRowStyle(
                isSelected: shellSidebarRowIsSelected(row, destination: nav.destination)))
            .accessibilityLabel(shellSidebarRowTitle(row))
        }
    }

    /// The shared compact icon+label anatomy — one register for all five rows. Owns the row's
    /// metrics (`shellSidebarRowHeight`, the inner padding) and the full-width hit target, so
    /// every caller's Button is nothing but wiring.
    private func rowLabel(_ row: ShellSidebarRow) -> some View {
        HStack(spacing: 10) {
            Image(systemName: shellSidebarRowSystemImage(row))
                .font(.system(size: 13))
                .frame(width: 18)
            Text(shellSidebarRowTitle(row))
                .font(.system(size: 13))
            Spacer(minLength: 4)
            if case .mode(let mode) = row, !mode.isAvailable {
                // Deglassed (the capsule fill died with the reskin): a quiet tag, now in the
                // brand's warm muted grey rather than the cooler system `.tertiary`.
                Text("Soon")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: shellSidebarRowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// sidebar-brand T4 (spec R1): the wordmark header row — Norma's ONE serif accent on the Mac
    /// (`Theme.wordmark`: New York, the iOS serif allowlist's binding #1, restored here at a 20 pt
    /// Mac size register after the 2026-08-06 pass had dropped it).
    ///
    /// PINNED above the scroll area like the reference's, so it never scrolls away, and carrying
    /// `shellSidebarTopInset` so it — rather than the first nav row — is what clears the inline
    /// traffic lights.
    ///
    /// The ⌕ is the search palette's door (spec R2, `SidebarSearchPalette`); ⌘K is the other, wired
    /// in `ShellRootView`. The old always-visible inline search field died with this row.
    private var wordmarkRow: some View {
        HStack(spacing: 8) {
            Text("Norma")
                .font(Theme.wordmark)
                .foregroundStyle(.primary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button {
                presentation.open()
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Search sessions")
            .accessibilityLabel("Search sessions")
        }
        .padding(.horizontal, 10)
        .frame(height: shellSidebarWordmarkRowHeight)
        .padding(.top, shellSidebarTopInset)
        .padding(.bottom, 6)
    }

    /// One compact Recents row: single-line middle-truncated title + the subtle activity dot
    /// (`recentsActivityDotStyle` — deglassed; the landings keep the full labeled chip). A Button
    /// in the same ONE row treatment, selected while its session is the shown destination. The
    /// context menu carries the existing Move to CLI verb behind the existing gate, unchanged.
    private func recentsRow(_ row: SessionSummary) -> some View {
        Button {
            nav.navigate(to: .session(row.sessionId))
        } label: {
            HStack(spacing: 6) {
                Text(sessionDisplayTitle(row.title))
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if let style = recentsActivityDotStyle(row.activity) {
                    Circle()
                        .fill(activityChipColor(style))
                        .frame(width: 6, height: 6)
                        .accessibilityLabel(activityChipLabel(row.activity) ?? "")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: shellSidebarRowHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: nav.destination == .session(row.sessionId)))
        // cli-handoff T3's affordance, carried onto Recents (chatgpt-ui T1): the SAME one
        // eligibility gate as the open-session pill and the landing rows (`moveToCliOffered`), the
        // SAME host verb (`moveToCli` launches; for the attached session it also runs the true
        // move — its own pinned split). No host (pure window tests) renders no item.
        .contextMenu {
            if let host, moveToCliOffered(row: row) {
                Button {
                    host.moveToCli(sessionId: row.sessionId)
                } label: {
                    Label("Move to CLI", systemImage: "terminal")
                }
            }
        }
    }

    /// The bottom account-style row (spec §1 row 6): app glyph + "Norma" + chevron → the
    /// Dashboard, REPLACING the gear affordance (its `.help`/`.accessibilityLabel` carried over;
    /// destination unchanged). Pinned below the scroll area with a top hairline; wears the same
    /// ONE row treatment as everything above it (hover included — pass 1's bespoke fill didn't).
    private var accountRow: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Theme.hairline)
                .frame(height: 1)
            Button {
                nav.navigate(to: shellSidebarAccountRowDestination)
            } label: {
                HStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 20, height: 20)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    // sidebar-brand T4 (spec R1): "Dashboard", not "Norma". A CORRECTION rather
                    // than a change of meaning — this row's destination
                    // (`shellSidebarAccountRowDestination`), its `.help` and its
                    // `.accessibilityLabel` were ALREADY Dashboard; only the visible label said
                    // something else, and only because nothing else in the pane carried the
                    // product name. The wordmark row carries it now.
                    Text("Dashboard")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(ShellSidebarRowStyle(isSelected: isDashboardDestination))
            .help("Dashboard")
            .accessibilityLabel("Dashboard")
            .padding(6)
        }
    }
}

// MARK: - The ONE row treatment (custom-sidebar)

/// Every sidebar row's rendering: the label over a `shellSidebarRowCornerRadius` rounded-rect
/// whose fill is decided by the ONE pure function (`shellSidebarRowFill` — selection beats hover,
/// rest is bare). A `ButtonStyle` so every row is a real `Button` (keyboard/accessibility for
/// free) while the hover tracking lives in exactly one place. A press reads as hover-strength
/// feedback on an unselected row — quiet, custom, nothing native.
struct ShellSidebarRowStyle: ButtonStyle {
    var isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, isSelected: isSelected)
    }

    /// The `@State` hover flag needs a `View` to live on — `ButtonStyle` itself is not one.
    private struct RowBody: View {
        let configuration: Configuration
        let isSelected: Bool
        @State private var isHovered = false

        var body: some View {
            configuration.label
                .background(
                    RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                        .fill(fill)
                )
                .onHover { isHovered = $0 }
        }

        /// The decision is pure and pinned (`shellSidebarRowFill`); only the paint lives here.
        ///
        /// sidebar-brand: the generic `.quaternary` system vocabulary is replaced by the brand
        /// tokens (`docs/brand.md`). `rowHover` is authored as an interpolation between `canvas`
        /// and `selectionPill`, so hover → selected reads as ONE ramp rather than two unrelated
        /// tints — and it is a real asset rather than an `.opacity()` hack precisely because a
        /// runtime alpha has no dark-mode variant to tune (the guide's anti-rule).
        ///
        /// Note `selectionPill` is DARKER than the pane in dark mode: Claude's measured
        /// semantics, deliberate, and differing from ChatGPT (whose selected row is lighter).
        /// Both follow the system appearance by construction. Tune-at-gate values.
        private var fill: AnyShapeStyle {
            switch shellSidebarRowFill(isSelected: isSelected,
                                       isHovered: isHovered || configuration.isPressed) {
            case .selected: return AnyShapeStyle(Theme.selectionPill)
            case .hover: return AnyShapeStyle(Theme.rowHover)
            case .none: return AnyShapeStyle(.clear)
            }
        }
    }
}

/// Task 1 landing placeholder. The window, its summon paths, the sidebar and the selection model
/// are final architecture; THIS view is the one part that is deliberately temporary — Tasks 3–5 and
/// 7 replace it surface by surface (see `shellLandingPlaceholderText`).
struct ShellLandingView: View {
    let destination: ShellDestination

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: shellDestinationSystemImage(destination))
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text(shellDestinationTitle(destination))
                .font(.title2)
            Text(shellLandingPlaceholderText(destination))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
