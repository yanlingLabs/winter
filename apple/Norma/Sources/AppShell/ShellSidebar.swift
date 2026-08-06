import AppKit
import SwiftUI

/// The shell's root content: the nav sidebar and the selected destination's surface.
///
/// A `NavigationSplitView`, not the hand-rolled `HStack`+`ScrollView` sidebar `DashboardView` uses.
/// That convention exists because nothing in this target had ever needed a real sidebar column;
/// this window does. chatgpt-ui T1: the sidebar column's styling authority is now the ChatGPT
/// desktop app's sidebar (the 2026-08-06 spec's reference screenshots) — flat and opaque, NOT the
/// iOS 26 Liquid Glass gallery, which remains the PHONE's authority only (spec "Why" #3 supersedes
/// the shell spec's iOS-mirror ruling for the Mac).
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

    var body: some View {
        NavigationSplitView {
            // chatgpt-ui T1: the sidebar carries the host (Move to CLI on Recents rows) and the
            // injected New chat door — both optional, same fallback posture as `detail` below.
            ShellSidebar(nav: nav, directory: directory, host: host, newChat: newChat)
                .navigationSplitViewColumnWidth(min: 208, ideal: 240, max: 320)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
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
    }

    /// The destination's surface. Six are real as of T7 — a hosted session, the chat landing, the
    /// code landing, the dispatch surface, the cowork Coming-soon, and the Dashboard surface —
    /// leaving no destination on T1's placeholder in production (it's reached only by a shell built
    /// without the relevant wiring, e.g. the pure geometry tests).
    @ViewBuilder
    private var detail: some View {
        switch nav.destination {
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
/// the injected door, never sets selection; a page is not somewhere the sidebar can be "on").
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
/// Flat OPAQUE background (`windowBackgroundColor` — both appearances follow the system), the
/// split view's translucent sidebar material deliberately covered. The old serif wordmark died
/// with the reskin — the account row carries the name now, and New chat must sit topmost.
struct ShellSidebar: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    /// chatgpt-ui T1: Move to CLI on Recents rows rides the host's ONE verb (`moveToCli` — which
    /// itself handles the attached-session true move vs the detached launch-only split). `nil` (a
    /// shell built without a host — the pure window/geometry tests) renders no menu item at all,
    /// the same no-dead-affordance posture as `newChat` below.
    var host: ShellSessionHost? = nil
    /// chatgpt-ui T1: the New chat row's door — the SAME injected `AppDelegate.newChat()` the chat
    /// landing's button fires (B4's one-create-path rule). `nil` renders no row (the
    /// `chatLandingShowsNewChatButton` posture: an unwired door never renders a dead affordance).
    var newChat: (() -> Void)? = nil

    @State private var searchQuery = ""

    /// `List(selection:)` wants an optional binding; the shell's destination is never absent, so
    /// the setter simply ignores a `nil` (a click that deselects everything, which the system can
    /// produce on ⌘-click) and keeps the current surface up.
    private var selection: Binding<ShellDestination?> {
        Binding(
            get: { nav.destination },
            set: { if let destination = $0 { nav.navigate(to: destination) } }
        )
    }

    /// Task 7 (carried to the account row): highlighted for ANY `.dashboard` destination
    /// regardless of pane payload, so drilling into a specific pane keeps the row lit.
    private var isDashboardDestination: Bool {
        if case .dashboard = nav.destination { return true }
        return false
    }

    var body: some View {
        List(selection: selection) {
            Section {
                ForEach(shellSidebarTopRows, id: \.self) { row in
                    topRow(row)
                }
            }
            Section {
                searchField
            }
            // app-shell T4: Recents FILTERS OUT archived rows (`excludingArchived` — the
            // hidden-by-default ruling, T3 review as-m10). An ordinary Recents click just navigates
            // to `.session(id)`, and the shell resumes-by-attaching whatever it's given
            // (`ShellSessionHost`/`session.attach` clears the archive flag daemon-side) — so an
            // archived row sitting in this flat, mode-agnostic list would make an idle click
            // silently un-archive it. Archived sessions are reachable only through the Archived tab
            // (`ModeLandingView`), where resume is the stated, deliberate action.
            Section("Recents") {
                let unarchived = excludingArchived(directory.rows)
                let recents = filteredRecents(unarchived, query: searchQuery)
                if recents.isEmpty {
                    Text(unarchived.isEmpty ? "No sessions yet" : "No matches")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(recents) { row in
                        recentsRow(row)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        // The flat opaque reskin: hide the List's own scroll background so the fill below — not
        // the split view's translucent sidebar material — is what shows, in both appearances.
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) { accountRow }
        .background(Color(nsColor: .windowBackgroundColor).ignoresSafeArea())
        // Same "the view's own appearance is the belt" posture as `SessionSidebar.task` — the
        // wirer-level `startInitialLoad()` kick can lose its race against this directory's harness
        // connecting. Task 2 adds the owned 5 s poll on top (visible-only).
        .task { await directory.refresh() }
    }

    /// One top row (`shellSidebarTopRows` order). New chat is a Button — an action row, no
    /// selection tag; mode rows tag their `.mode(...)` destination for the system highlight.
    @ViewBuilder
    private func topRow(_ row: ShellSidebarRow) -> some View {
        switch row {
        case .newChat:
            if let newChat {
                Button(action: newChat) { // T2 retargets to the new-chat page
                    rowLabel(row)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New chat")
            }
        case .mode(let mode):
            rowLabel(row)
                // Unavailable modes read dimmed — but still select (never a dead row).
                .foregroundStyle(mode.isAvailable ? .primary : .secondary)
                .tag(ShellDestination.mode(mode))
        }
    }

    /// The shared compact icon+label anatomy — one register for all five rows.
    private func rowLabel(_ row: ShellSidebarRow) -> some View {
        HStack(spacing: 8) {
            Image(systemName: shellSidebarRowSystemImage(row))
                .font(.system(size: 13))
                .frame(width: 18)
            Text(shellSidebarRowTitle(row))
                .font(.system(size: 13))
            Spacer(minLength: 4)
            if case .mode(let mode) = row, !mode.isAvailable {
                // Deglassed (the capsule fill died with the reskin): a quiet tertiary tag.
                Text("Soon")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    /// The thin search field (spec §1 row 4) — live, local-only, no notifications bell. Sits in
    /// the List so it scrolls with the rows exactly like the reference; `selectionDisabled` keeps
    /// a click-to-focus from fighting the List's selection.
    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Search", text: $searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7).strokeBorder(.quaternary, lineWidth: 1))
        .selectionDisabled()
    }

    /// One compact Recents row: single-line middle-truncated title + the subtle activity dot
    /// (`recentsActivityDotStyle` — deglassed; the landings keep the full labeled chip). The
    /// context menu carries the existing Move to CLI verb behind the existing gate, unchanged.
    private func recentsRow(_ row: SessionSummary) -> some View {
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
        .tag(ShellDestination.session(row.sessionId))
        // cli-handoff T3's affordance, carried onto Recents (chatgpt-ui T1): the SAME one
        // eligibility gate as the toolbar action and the landing rows (`moveToCliOffered`), the
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
    /// menu items unchanged). Same hairline-topped `safeAreaInset` bar as before — macOS has no
    /// bottom toolbar placement for a sidebar column.
    private var accountRow: some View {
        VStack(spacing: 0) {
            Divider()
            Button {
                nav.navigate(to: shellSidebarAccountRowDestination)
            } label: {
                HStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 20, height: 20)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    Text("Norma")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(isDashboardDestination ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear))
                )
            }
            .buttonStyle(.plain)
            .help("Dashboard")
            .accessibilityLabel("Dashboard")
            .padding(6)
        }
        .background(Color(nsColor: .windowBackgroundColor))
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
