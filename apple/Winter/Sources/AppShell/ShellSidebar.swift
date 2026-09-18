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
    /// 2026-09-17: the three floating panels the account row opens (library / devices / updates).
    /// The buttons are in the pane and the panels are overlays on this root, so the state has to
    /// live at least this high — and since 2026-09-18 it lives one level higher still, on
    /// `AppWindowController`, because the menu bar's "Check for Updates…" opens the updates panel
    /// from outside the view tree entirely.
    @ObservedObject var overlays: ShellOverlayPresentation
    /// Which library tab is showing. Shell state rather than part of `ShellOverlay.library`, so
    /// reopening the panel returns you to where you were.
    @State private var libraryTab: LibraryTab = defaultLibraryTab
    /// Where Settings' Back row returns to. Captured when Settings opens rather than hard-coded:
    /// sending someone to the new-chat page when they came from a live session loses their place.
    @State private var destinationBeforeSettings: ShellDestination = defaultShellDestination
    /// sidebar-brand: whether the sidebar pane is showing. `@State` on the root suffices — the
    /// window outlives every hide/re-summon (`AppWindowController` owns it forever), so the user's
    /// choice survives exactly as long as the window itself does.
    @State private var sidebarVisible = true
    /// The work panel's visibility (2026-09-17) — shared with `WindowContentView` through the same
    /// `@AppStorage` key, so the titlebar toggle and the panel column read one value.
    @AppStorage(workPanelVisibleKey) private var workPanelVisible = true
    /// panel-shell T10: mode and width together — replaces the two separate `@State` values Task 2
    /// added (`panelMode`/`panelWidth`, one comment below this one until this task). `.mode` is
    /// still the REQUESTED mode (`panelResolvedMode` may render `.hidden` on a narrow window while
    /// this stays `.side`/`.maximized`, so widening the window restores what the user asked for —
    /// unchanged from Task 2's own doc comment, now also true of `.maximized` for free, since
    /// `panelResolvedMode` already treats every non-`.hidden` request identically); `.maximized`
    /// ignores `.sideWidth` structurally rather than overwriting it (`PanelPresentation`'s own doc
    /// comment, `PanelMode.swift`), which is what makes leaving `.maximized` restore the dragged
    /// width with no second "previous width" to keep in step.
    ///
    /// Plain `@State`, not `@SceneStorage`: this window is AppKit-owned and hosted directly via
    /// `NSHostingView` (`AppWindowController.swift:215`) — `WinterApp`'s only `Scene` is an empty
    /// `Settings {}` (`WinterApp.swift`), so there is no SwiftUI window-restoration scene for
    /// `@SceneStorage` to key off. Apple's own documented fallback for that case is to behave
    /// exactly like `@State` — so the wrapper would be inert here, and `PanelPresentation` (a plain
    /// struct) has no existing `RawRepresentable` bridging to invent one for just to carry it.
    /// `@State` means exactly what it already means for `sidebarVisible` above: the value survives
    /// for as long as the window does, and `AppWindowController` keeps this window alive for the
    /// app's whole lifetime.
    @State private var presentation = PanelPresentation()
    /// panel-shell T9: Task 8's `@StateObject private var panelStore = PanelStore()` here is
    /// REJECTED, not ratified. `ShellSessionHost` is constructed in `AppDelegate.summonAppWindow`
    /// BEFORE this view exists at all, and it is `ShellSessionHost.attachFresh`/`hop` that know,
    /// synchronously and at the exact right moment, which session just became current — a
    /// `@StateObject` privately owned by this view has no way to be reached from a controller
    /// object that predates it; there is no channel back INTO a view's private state. `host` above
    /// (line 20) is also a plain, UNOBSERVED `var`, not `@ObservedObject` — this view could not
    /// have driven the feed reactively off it even if it tried, which is exactly why Task 8's own
    /// review deleted a gate in this file's sibling `ShellPanel.swift` that read `host`'s published
    /// state the same non-reactive way (progress.md, Task 8 Important 2). `PanelStore` now lives on
    /// `ShellSessionHost` itself (`let panelStore`, fed by its per-attachment `onEvent` hook) — this
    /// is a plain pass-through read of it.
    ///
    /// `fallbackPanelStore` exists only for a shell built WITHOUT a host (the pure window tests,
    /// same posture as `shellLandingPlaceholderText`'s host-less cases) — `ShellPanel.store` is
    /// non-optional, so something must always be handed to it.
    @StateObject private var fallbackPanelStore = PanelStore()
    private var panelStore: PanelStore { host?.panelStore ?? fallbackPanelStore }

    /// The work-panel toggle shows only where the panel can: an attached, non-chat session.
    private var showsWorkPanelToggle: Bool {
        guard case .session(let sessionId) = nav.destination else { return false }
        guard let row = directory.rows.first(where: { $0.sessionId == sessionId }) else { return false }
        return row.mode != "chat"
    }

    private var workPanelToggle: some View {
        ShellTitlebarButton(systemImage: workPanelToggleGlyph,
                            label: workPanelVisible ? "Hide work panel" : "Show work panel",
                            isOn: workPanelVisible) {
            withAnimation(shellPanelMotion) { workPanelVisible.toggle() }
        }
    }

    var body: some View {
        // panel-shell T2: the whole body moved inside a `GeometryReader` — `contentWidth` (the
        // window minus the sidebar, NOT the whole window: the panel's minimums are about the
        // content area, so a collapsed sidebar legitimately gives it more room) and the RESOLVED
        // `mode` are needed both by the HStack's third column below and by the trailing titlebar
        // cluster further down this same modifier chain, so both live here rather than being
        // recomputed in two places.
        GeometryReader { geo in
            let contentWidth = geo.size.width - (sidebarVisible ? shellSidebarWidth : 0)
            let mode = panelResolvedMode(requested: presentation.mode, contentWidth: contentWidth)

            shellBody(contentWidth: contentWidth, mode: mode)
                // review round 2, Important 1, belt-and-braces half: keep the STORED
                // `presentation.sideWidth` from drifting far from what is actually on screen (the
                // render path already clamps on read, but the divider's next drag anchors on the
                // stored value — see `PanelDivider.onChanged` — so stored and rendered should not
                // be allowed to diverge for long). Guarded on `panelFitsInContent` so this can
                // NEVER become a second caller of `panelClampWidth` outside the zone
                // `PanelModeTests.testClampBoundsAreNeverInvertedWhenThePanelFits` requires (Task
                // 1's carried finding) — below the threshold the render path already forces
                // `.hidden` and touches `sideWidth` not at all, and this must not either.
                .onChange(of: contentWidth) { _, newContentWidth in
                    guard panelFitsInContent(newContentWidth) else { return }
                    presentation.sideWidth = panelClampWidth(presentation.sideWidth, contentWidth: newContentWidth)
                }
                // diff-tabs Task 9: **the ONE channel from the host into this view's panel state.**
                //
                // A transcript diff chip opens a tab through `ShellSessionHost.openDiffTab`, and the
                // tab has to become visible — but the requested panel mode is `@State` HERE, and
                // `host` is a plain unobserved `var` (see its own doc, and `panelStore`'s), so
                // nothing published on the host could drive this view. Handing the host a closure
                // that owns this state is the only direction that works; `$presentation` is captured
                // rather than `presentation` so the write lands on this view's own storage however
                // many times SwiftUI reconstructs the struct around it.
                //
                // Re-registered on every appear, which is idempotent — it is the same closure over
                // the same state — and cheap. `.snappy` matches the sidebar/panel toggles beside it,
                // so a revealed panel slides in exactly like a toggled one.
                .onAppear {
                    let presentationBinding = $presentation
                    host?.onRevealPanel = {
                        withAnimation(shellPanelMotion) { presentationBinding.wrappedValue.revealIfHidden() }
                    }
                }
                #if DEBUG
                // panel-cef Task 6a — a DEBUG-ONLY door for driving the panel from outside the UI.
                //
                // The panel starts `.hidden` and is shown only by a titlebar button, and a web tab
                // exists only after someone presses "+". Both are mouse clicks, and synthesising a
                // click needs Accessibility TCC that this development environment does not have —
                // so without this there is no way to reach a rendered page for the CDP proof, or
                // for the forced-software-rendering run the plan requires.
                //
                // It drives the REAL path and adds no second one: the same `presentation.mode` the
                // button toggles, and the same `ShellSessionHost.openPanelTab` "+" calls, which
                // goes to the daemon and comes back as a `panel_tab_opened` event folded by
                // `PanelStore`. `#if DEBUG` keeps it out of every shipped build, and it is inert
                // unless the variable is set.
                .onAppear {
                    let env = ProcessInfo.processInfo.environment
                    guard env["WINTER_PANEL_SMOKE"] == "1" else { return }
                    presentation.mode = .side
                    host?.openPanelTab(kind: .web) { sessionId in
                        nav.navigate(to: .session(sessionId))
                    }
                    // Task 6a fix pass: reproduce the LIVE-GATE DEFECT without a click. Closing a
                    // tab (and switching destination with one open — the same dismantle) was making
                    // Winter's whole window disappear, because CEF's default `DoClose` sends
                    // `performClose:` to the browser's top-level parent window. `requestCloseTab` is
                    // the identical door the pill's × uses (editor-product Task 10 — a `.web` tab
                    // like this one is never dirty, so it passes straight through to the same
                    // `closePanelTab` this smoke test always exercised), so this reproduces the real
                    // path.
                    if let after = env["WINTER_PANEL_SMOKE_CLOSE_AFTER"].flatMap(Double.init) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                            guard let tabId = panelStore.tabs.first?.tabId else { return }
                            host?.requestCloseTab(tabId)
                        }
                    }
                    // The user's SECOND reported trigger: clicking Cowork in the sidebar with a tab
                    // open. It reaches the same dismantle by a different route — the panel's tab
                    // list is per-session, so leaving the session empties it and the content slot
                    // tears down — which is why one `DoClose` fix covers both.
                    if let after = env["WINTER_PANEL_SMOKE_NAV_AFTER"].flatMap(Double.init) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                            nav.navigate(to: .mode(.cowork))
                        }
                    }
                }
                // office-agent Task 8 — the SHELL half of the headless gate's door (the window half
                // lives in `AppDelegate.applicationDidFinishLaunching`, exactly as
                // `WINTER_PANEL_SMOKE`'s two halves are split, and for the same reason).
                //
                // Why both halves are needed, measured rather than assumed: the window half alone
                // DOES attach the host to the named session — enough for `officeReach`, so every
                // `sheets`/`slides`/`docs` verb starts working — but it fires one run-loop turn
                // after `boot()`, long before the shell has mounted, so the visible route was still
                // the `.newChat` landing (AX read back `AXStaticText "How can I help you today?"`
                // with a document tab already open in the daemon's own `panel.list`). Attachment and
                // rendering are separate facts, and the gate's UI assertions need the second one.
                //
                // `.onAppear` is the right moment for the same reason the door above it uses it:
                // the shell is mounted, so `nav.navigate` lands. `presentation.mode = .side` opens
                // the panel so a `.document` tab actually renders its canvas and part strip — the
                // surfaces the gate reads back through accessibility.
                //
                // ONE-SHOT, and that is load-bearing rather than tidiness. `.onAppear` fires again
                // on every SwiftUI re-mount of this view, and re-navigating to a destination while
                // a `.document` tab is open re-enters the same panel dismantle the door above
                // documents ("switching destination with one open — the same dismantle"). Measured:
                // without this guard the window renders the document correctly (AX read back
                // `nog-w/budget.xlsx` and the formula bar's `A1: WINTER GATE`) and then DISAPPEARS a
                // few seconds later, while the app itself stays alive and LibreOffice keeps
                // servicing the document — a live window that evaporates mid-gate, which would read
                // as a UI assertion failure with nothing wrong at the surface under test.
                .onAppear {
                    let env = ProcessInfo.processInfo.environment
                    guard let gateSession = env["WINTER_GATE_SESSION"], !gateSession.isEmpty else { return }
                    // IDEMPOTENT, not a one-shot latch — and the difference was measured, twice.
                    //
                    // A plain `fired` boolean deadlocks the door: the FIRST `.onAppear` can land
                    // before navigation can take, the flag is spent on that no-op, and no later
                    // re-mount ever retries — observed as a shell window that never appears at all
                    // (the app alive, the daemon and helper healthy, LibreOffice servicing the
                    // document, and AX reporting zero named elements).
                    //
                    // Testing the CURRENT destination instead gets both properties at once: it
                    // still cannot re-enter the panel dismantle that re-navigating with a
                    // `.document` tab open causes (already at `.session(gateSession)` -> no call),
                    // and it DOES retry on every re-mount until the navigation actually sticks.
                    // The panel is opened UNCONDITIONALLY, before the navigation guard — the two
                    // are independent facts and folding them into one `return` was a real bug: the
                    // window half above may already have navigated to this very session before the shell
                    // mounted, in which case the guard below returns and the panel would never open,
                    // so no `.document` tab could ever render for the UI leg.
                    if presentation.mode != .side { presentation.mode = .side }
                    if case .session(let current) = nav.destination, current == gateSession { return }
                    nav.navigate(to: .session(gateSession))
                }
                #endif
        }
    }

    /// The shell's actual content — split out of `body` only so the `GeometryReader` above has a
    /// single expression to return; no behaviour differs from having written it all inline.
    @ViewBuilder
    private func shellBody(contentWidth: CGFloat, mode: PanelMode) -> some View {
        HStack(spacing: 0) {
            // The sidebar carries the host (Move to CLI on Recents rows) and the injected New chat
            // door — both optional, same fallback posture as `detail` below. It owns its own fixed
            // width (`shellSidebarWidth`) — the split view's user-draggable 208–320 column died
            // with the container. sidebar-brand supersedes that rework's "no collapse toggle"
            // ruling: the pane now collapses, driven by the titlebar toggle below.
            if sidebarVisible {
                ShellSidebar(nav: nav, directory: directory, host: host, newChat: newChat,
                             presentation: searchPalette, overlays: overlays,
                             libraryTab: $libraryTab,
                             onOpenSettings: openSettings,
                             onLeaveSettings: leaveSettings)
                    // Slides out to the leading edge rather than fading — the pane is a physical
                    // surface, and a fade reads as dissolving rather than closing.
                    .transition(.move(edge: .leading))
            }
            // panel-shell T2: absent entirely in `.maximized` — the panel owns the whole content
            // area then, and `detail` would have nothing left to show beside it.
            //
            // panel-shell T10 (this branch is REACHABLE now — T2 wrote it before anything could
            // set `.maximized`; the rest of this note is what changes now that it can be taken):
            // entering/leaving `.maximized` fully tears down and rebuilds whatever `detail` is
            // currently showing, identically to navigating to a different destination. Judged
            // ACCEPTABLE rather than fixed here — investigated case by case (task-10-report.md):
            // `ShellSessionView`'s composer draft is safe (it lives on the externally-owned
            // `FieldStateAdapter`, not on this subtree), so no live conversation's typed-but-unsent
            // message is ever lost. What IS lost: the transcript's scroll position on an idle
            // session (an actively streaming one self-corrects within one token), any open menu
            // popover, and — the two real, non-cosmetic losses, NOT fixed here — the New Chat
            // page's own draft (`NewChatPage.swift`'s `draft`, already documented there as
            // dropping on navigate-away; maximizing the panel is a second trigger for the
            // identical drop) and an unsubmitted answer on a pending question/plan card
            // (`PendingCards.swift`'s `PendingQuestionBody`/`PendingPlanBody`). Both are shaped
            // like candidates for the SAME fix the composer draft already has — external, not
            // view-local, storage — but that is a scoped change of its own, not this task's; a
            // "hide rather than remove" alternative was considered and rejected (see the report)
            // because it would mount `detail` at a width that ANIMATES to/from zero on every
            // maximize toggle, fighting `WindowContentView`'s own `measuredWidth` remeasurement
            // rather than avoiding it.
            if mode != .maximized {
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background {
                        shellDetailCardShape
                            .fill(Theme.cardSurface)
                            .overlay(
                                shellDetailCardShape
                                    .strokeBorder(Theme.hairline,
                                                  lineWidth: shellSidebarHairlineWidth)
                            )
                            .shadow(color: .black.opacity(0.05), radius: 10, x: -2)
                            .ignoresSafeArea()
                    }
            }

            if mode == .side {
                PanelDivider(width: $presentation.sideWidth, contentWidth: contentWidth)
            }
            if mode != .hidden {
                ShellPanel(store: panelStore, presentation: $presentation, host: host, nav: nav)
                    .frame(width: mode == .maximized
                           ? nil
                           : panelRenderedWidth(mode: mode, sideWidth: presentation.sideWidth,
                                                 contentWidth: contentWidth))
                    .frame(maxWidth: mode == .maximized ? .infinity : nil,
                           maxHeight: .infinity)
                    // A physical surface sliding in from its own edge.
                    .transition(.move(edge: .trailing))
            }
        }
        // ONE brand tint for the whole shell (user call, 2026-08-07: every cursor in the app the
        // same colour). `.tint` drives a SwiftUI `TextField`'s caret and selection and cascades to
        // descendants, so every field in the search palette, the Dashboard panes and the cards gets
        // it without remembering to opt in.
        //
        // **It does NOT cover `Color.accentColor`, and this comment used to claim it did** — named
        // the pending cards specifically, which was the one example that was false (mac-chat-parity
        // Task 8 fix round 1). Probed: with a system accent of #FFC726, `Color.accentColor` renders
        // #FFC727 *inside* this modifier while `ShapeStyle.tint` renders #8CCBF0. `Color.accentColor`
        // reads the system preference directly and ignores ancestor tint entirely — which is why the
        // cards' selection chrome was drawing in the user's own accent until Task 8 named
        // `Theme.accent` at each site, and why this comment mattered: it is exactly the sentence
        // that would have talked a reviewer out of believing that bug was real.
        //
        // Deliberately NOT `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`: that would retint
        // every system control in the app process, including surfaces this pass does not own.
        .tint(Theme.accent)
        // ChatGPT's text ink (2026-09-17): every `.primary` in the shell resolves to this.
        .foregroundStyle(Theme.textPrimary)
        // The base plane behind everything, so the card's rounded corners reveal the sidebar's
        // plane rather than the window's own fill.
        //
        // 2026-09-17: that plane is the VIBRANCY (`ShellVibrancyBackground`) — ONE view for the
        // whole shell, not one per pane. The first cut put it on the sidebar pane alone, which
        // left every pixel the pane does not cover — the gutter between pane and card, and the
        // wedges the card's rounded corners cut out — on this opaque canvas: translucent column,
        // solid corners. Whatever the card does not cover IS the plane, so the plane is what has
        // to be translucent. `.ignoresSafeArea()` so it reaches under the titlebar band too.
        .background { ShellVibrancyBackground().ignoresSafeArea() }
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
            HStack(spacing: shellTitlebarClusterSpacing) {
                // SETTINGS (user call, 2026-09-17): the titlebar carries the traffic lights and ONE
                // back arrow, nothing else. The sidebar toggle would collapse the very column the
                // settings sections live in, and the placeholder nav arrows are noise beside a real
                // one. This arrow IS the way out, which is why the sidebar no longer carries a Back
                // row of its own.
                if isSettings {
                    ShellSettingsBackButton(action: leaveSettings)
                } else {
                ShellTitlebarButton(
                    systemImage: shellSidebarToggleSystemImage(isVisible: sidebarVisible),
                    label: shellSidebarToggleLabel(isVisible: sidebarVisible)
                ) {
                    withAnimation(.easeInOut(duration: 0.22)) { sidebarVisible.toggle() }
                }

                // The back/forward pair — placeholders until the shell has a navigation history
                // (see `shellTitlebarNavigationGlyphs`), but real buttons that hover like the rest.
                ForEach(shellTitlebarNavigationGlyphs, id: \.self) { glyph in
                    ShellTitlebarButton(systemImage: glyph,
                                        label: glyph == "arrow.left" ? "Back" : "Forward",
                                        isPlaceholder: true)
                }
                }
            }
            .padding(.leading, shellSidebarToggleLeadingInset)
            .padding(.top, shellSidebarToggleTopInset)
            // The whole point of the placement: sit in the TITLEBAR band beside the traffic
            // lights. Without this the overlay is laid out inside the safe area and drops level
            // with the wordmark instead — the same top-safe-area opt-out the pane itself takes.
            .ignoresSafeArea(.container, edges: .top)
        }
        // sidebar-chrome-2: the TRAILING cluster, mirroring the reference's top-right corner. Same
        // button, same metrics, same top inset as the leading cluster — so the two clusters share
        // one centre line across the window by construction, not by two numbers agreeing.
        //
        // panel-shell T10: this cluster shows all THREE glyphs only while the panel is `.hidden`.
        // The moment it opens, `dock.rectangle` and `sidebar.right` move INTO the panel's own
        // trailing cluster (`ShellPanel.swift`'s `PanelTabStrip.trailingButtonCluster`) — the
        // user's layout sketch settled this (`docs/superpowers/specs/2026-08-08-panel-shell-design.md`
        // §"The panel's chrome layout") — and only `circle.dashed` stays up here, relocated to just
        // outside the panel's leading edge so it keeps travelling with the chat column rather than
        // the panel that swallowed its neighbours.
        //
        // The relocated button renders ONLY for `mode == .side`, not `.maximized` (review
        // self-catch, T10): "just outside the panel's leading edge, staying with the chat column"
        // presumes a chat column to stay with, and `.maximized` has none (`detail` is absent — see
        // its own comment above). Naively reusing the same trailing-padding formula there would
        // place the button using `panelRenderedWidth == contentWidth`: with the sidebar hidden that
        // pushes it PAST the window's own leading edge (negative x), and with the sidebar showing
        // it lands inside the SIDEBAR's own pane instead of beside anything panel-adjacent — neither
        // is "outside the panel's leading edge" in any sense the spec line means. `.maximized`
        // simply shows nothing here; nothing in the spec asks for a `.maximized`-specific placement.
        .overlay(alignment: .topTrailing) {
            // Hidden entirely in Settings (user call): every glyph up here drives the chat surface
            // — the work panel, the browser panel — and none of them has anything to act on while
            // a settings section is showing.
            if mode == .hidden, !isSettings {
                HStack(spacing: shellTitlebarClusterSpacing) {
                    ForEach(shellTitlebarTrailingGlyphs, id: \.self) { glyph in
                        // The work-panel toggle sits just before the panel toggles, as ChatGPT's does.
                        if glyph == "dock.rectangle", showsWorkPanelToggle {
                            workPanelToggle
                        }
                        if glyph == "sidebar.right" {
                            // panel-shell T2: the placeholder named in `shellTitlebarTrailingLabel`
                            // becomes the real toggle. `shellTitlebarTrailingGlyphs` still lists this
                            // glyph (the cluster still shows three icons), but as of review round 2
                            // it is no longer in `shellTitlebarTrailingPlaceholderGlyphs` — and the
                            // `"sidebar.right"` case was REMOVED from `shellTitlebarTrailingLabel`'s
                            // switch (round 1 had left it in, unreferenced; the reviewer called that
                            // a pin one call away from asserting a falsehood, since nothing stopped a
                            // future caller from asking this genuinely-wired glyph for its stale
                            // "not wired yet" text and getting a lie back).
                            //
                            // The label tracks `presentation.mode` (the REQUESTED state, same value
                            // the action mutates below) rather than the resolved `mode` — mirrors
                            // `shellSidebarToggleLabel(isVisible:)`, the sibling toggle immediately
                            // above, which keys its own label off the state IT mutates too. Below the
                            // width threshold it EXPLAINS the disabled state instead (review round 2):
                            // a disabled control with no reason given reads as broken, not as a
                            // constraint. The window's own `minSize` (820, `AppWindowController`) is
                            // always wide enough on its own (>= `panelMinContentWidth`), so whenever
                            // this fires the sidebar is necessarily the reason — "hide the sidebar" is
                            // therefore always a valid suggestion here, never a wrong one.
                            //
                            // Disabled rather than hidden when the window is too narrow — a control
                            // that vanishes reads as a bug, one that greys out reads as a constraint.
                            //
                            // review round 1, Minor 3: this branch's own gate is the RESOLVED
                            // `mode == .hidden`, which is not the same as the REQUESTED
                            // `presentation.mode` being `.hidden` too — `panelResolvedMode` also
                            // forces `.hidden` when the window is too narrow, whatever was
                            // requested, which is exactly the "Widen the window…" case ten lines
                            // above. That forced case requires `!fits`; so `fits == true` here can
                            // only be the OTHER way resolved `.hidden` happens — the user actually
                            // requested `.hidden` — which is what makes `presentation.mode ==
                            // .hidden` hold whenever the inner ternary is reached at all. When
                            // `fits == false`, `presentation.mode` really could be `.side`/
                            // `.maximized` (the forced case) — but the OUTER ternary has already
                            // picked the "Widen the window…" arm by then, so the inner one is never
                            // evaluated either way, and the ternary is kept (rather than
                            // hand-simplified to the literal) so it stays correct by construction
                            // if that no-longer-coincidental relationship ever changes.
                            let fits = panelFitsInContent(contentWidth)
                            ShellTitlebarButton(
                                systemImage: glyph,
                                label: fits
                                    ? (presentation.mode == .hidden ? "Show panel" : "Hide panel")
                                    : "Widen the window or hide the sidebar to use the panel."
                            ) {
                                let wasHidden = presentation.mode == .hidden
                                withAnimation(shellPanelMotion) { presentation.toggleVisible() }
                                // 2026-08-09 live gate (user): "the sidebar should open with a tab
                                // already" — an empty panel has nothing to show and no reason to be
                                // open. Only on the HIDDEN -> visible transition, and only when the
                                // strip is genuinely empty, so re-opening a panel that already has
                                // tabs never mints a spurious one.
                                //
                                // Routed through the SAME two doors "+" uses (`ShellPanel`'s own
                                // `onOpenTab`), not a third path: the new-chat page BINDS so the
                                // page's draft survives, every other landing keeps Task 12's
                                // create-then-navigate. Both are re-entrancy-gated, so a rapid
                                // toggle cannot double-create.
                                if wasHidden, panelStore.tabs.isEmpty {
                                    if nav.destination == .newChat {
                                        host?.openPanelTabForNewChatPage(kind: .web)
                                    } else {
                                        host?.openPanelTab(kind: .web) { sessionId in
                                            nav.navigate(to: .session(sessionId))
                                        }
                                    }
                                }
                                // editor-product T3: the panel becoming visible is the editor's
                                // pre-warm trigger (`ShellSessionHost.panelDidReveal`, dirs-only and
                                // idempotent) — office live-gate Bug 2 joined the SAME call, so this
                                // one line now pre-warms both. It is told from HERE because the
                                // requested mode is this view's own `@State` — the host has no way to
                                // observe it (see `onRevealPanel`'s doc for the same one-directional
                                // wall). The host's own doors carry it themselves via `revealPanel`.
                                if wasHidden { host?.panelDidReveal() }
                            }
                            .disabled(!fits)
                        } else {
                            ShellTitlebarButton(systemImage: glyph,
                                                label: shellTitlebarTrailingLabel(glyph),
                                                isPlaceholder: true)
                        }
                    }
                }
                .padding(.trailing, shellTitlebarTrailingInset)
                .padding(.top, shellSidebarToggleTopInset)
                .ignoresSafeArea(.container, edges: .top)
            } else if mode == .side {
                HStack(spacing: shellTitlebarClusterSpacing) {
                    ShellTitlebarButton(systemImage: "circle.dashed",
                                        label: shellTitlebarTrailingLabel("circle.dashed"),
                                        isPlaceholder: true)
                    if showsWorkPanelToggle { workPanelToggle }
                }
                    // Clears the panel itself (`panelRenderedWidth`, reachable here because this
                    // branch already IS `mode == .side`) plus the divider hairline between panel
                    // and chat, plus the same clearance the titlebar cluster already uses
                    // everywhere else (`shellTitlebarTrailingInset`) — one consistent inset,
                    // rather than a bespoke number invented for this one button.
                    .padding(.trailing, panelRenderedWidth(mode: mode, sideWidth: presentation.sideWidth,
                                                            contentWidth: contentWidth)
                                         + panelDividerWidth
                                         + shellTitlebarTrailingInset)
                    .padding(.top, shellSidebarToggleTopInset)
                    .ignoresSafeArea(.container, edges: .top)
            }
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
            if let overlay = overlays.overlay {
                ShellFloatingPanel(overlay: overlay, onClose: { overlays.close() }) {
                    switch overlay {
                    case .library:
                        LibraryPanel(tab: $libraryTab, wiring: dashboardWiring)
                    case .devices:
                        DevicesPanel(wiring: dashboardWiring, onPair: { overlays.close() })
                    case .updates:
                        UpdatesPanel(wiring: dashboardWiring)
                    }
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.16), value: overlays.overlay)
        .overlay {
            if searchPalette.isPresented {
                SidebarSearchPalette(nav: nav, directory: directory, presentation: searchPalette)
                    // A plain FADE (user call, 2026-08-07 — the drop-in-from-above read as too
                    // much motion for something this quick). The palette is top-pinned, so it
                    // already appears where it belongs; arriving there is not information the
                    // animation needs to carry.
                    .transition(.opacity)
            }
        }
        // Ease, not a spring: a spring's overshoot is motion, and there is no motion left to
        // shape once the transition is a fade.
        .animation(.easeOut(duration: 0.16), value: searchPalette.isPresented)
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
        case .settings(let section):
            // The sidebar is already showing the settings sections (`ShellSidebar` swaps its own
            // content on this destination), so the card shows ONLY the section — no nested pane
            // list, which is the whole point of making Settings a destination instead of reusing
            // the Dashboard's two-column surface.
            SettingsSectionView(section: section ?? defaultSettingsSection, wiring: dashboardWiring)
        }
    }

    /// Whether a settings section is showing. Drives the chrome that stands down while it is.
    private var isSettings: Bool { shellDestinationIsSettings(nav.destination) }

    /// Enter Settings, remembering where the user was so Back can return them there.
    private func openSettings() {
        if case .settings = nav.destination {} else {
            destinationBeforeSettings = nav.destination
        }
        nav.navigate(to: .settings(section: defaultSettingsSection))
    }

    /// Leave Settings the way they came in.
    private func leaveSettings() {
        nav.navigate(to: destinationBeforeSettings)
    }
}

// MARK: - The sidebar's pure shape (chatgpt-ui T1 — driven directly by AppShellTests)

/// A top-of-sidebar row: the New chat ACTION row, or one of the four mode rows. Exactly the
/// spec §1 structure; the search field, Recents and the account row sit below and have their own
/// pure helpers (`filteredRecents`, `recentsActivityDotStyle`, `shellAccountMenuGroups`).
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

/// PURE: the row's glyph — every mode row keeps its own `systemImage` (the reskin restyles rows,
/// it does not rebrand the modes).
///
/// New chat is a PLUS (user call, 2026-08-07), not the pencil-square the 2026-08-06 spec asked
/// for: the pencil is ChatGPT's, and "+ New" is Claude's, which is the register this pane is
/// converging on. `ShellNavigation`'s `shellDestinationSystemImage(.newChat)` deliberately keeps
/// the pencil — that one titles the DESTINATION (the new-chat page), where "compose" is the right
/// idea; this one labels the ACTION of adding one.
func shellSidebarRowSystemImage(_ row: ShellSidebarRow) -> String {
    switch row {
    case .newChat: return "plus"
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

// MARK: - The account menu (sidebar-chrome-2)

/// The account row's menu, as DATA — the user's 2026-08-07 call that "the dashboard should be
/// split into settings and other things rather than everything being in dashboard".
///
/// Each entry names a `DashboardPane` and nothing else: titles and glyphs are read from
/// `dashboardPaneTitle`/`dashboardPaneSystemImage`, the SAME two functions the Dashboard's own
/// sidebar uses, so a renamed pane cannot end up with one name in the menu and another one row
/// later. The outer array is the menu's DIVIDER groups.
///
/// The split: settings-and-this-Mac first, then the things you *keep* (memory, skills) and the
/// things that *run* (workflows, plugins). Deliberately NOT every pane — `peripheral`, `trust`,
/// `cliInstaller`, `updater`, `loginItem` and `quota` stay reachable inside the Dashboard itself
/// rather than flattening its whole catalogue into a menu, which would just move the problem.
///
/// **This grouping is a first proposal, not a settled information architecture** — the real
/// restructure (what "Settings" should contain as a surface of its own) is its own piece of work.
let shellAccountMenuGroups: [[DashboardPane]] = [
    [.provider, .pairedDevices, .daemonStatus],
    [.memory, .skills, .workflows, .pluginManager],
]

/// PURE: the account row's label. A placeholder for the profile that does not exist yet — the row
/// is shaped like Claude's account control (avatar + name + chevron) precisely so that profile can
/// drop into it later without the pane changing shape again.
let shellAccountRowTitle = "Winter"

/// The monogram avatar's diameter, and the account row's overall height. The row is given an
/// EXPLICIT height because it is a `Menu` label: AppKit's menu machinery does not reliably honour
/// intrinsic sizing there, so the row states its own height rather than inferring one.
let shellAccountAvatarSize: CGFloat = 24
let shellAccountRowHeight: CGFloat = 34

/// One icon in the account row's expanded cluster (2026-09-17).
struct ShellAccountAction: Equatable {
    let systemImage: String
    let label: String
}

/// What the account row reveals when it expands, in order. NOT WIRED YET (user call: "don't wire
/// them yet, lets do this first") — every one renders as a placeholder, which in this app means it
/// reads one step quieter and still hovers, rather than pretending to be disabled.
///
/// This REPLACED the popover menu that used to open here. The Dashboard's own doors (`Settings`,
/// the rest of `shellAccountMenuGroups`) are where the gear will land when these are wired; until
/// then the sidebar has no Dashboard door at all, which is the deliberate cost of doing the shape
/// first.
let shellAccountActions: [ShellAccountAction] = [
    ShellAccountAction(systemImage: "gearshape", label: "Settings"),
    // The SAME glyph the Skills pane has always used — the panel it opens is where skills
    // live now, and two different books for one idea is two ideas (user call).
    ShellAccountAction(systemImage: "book.closed", label: "Library"),
    ShellAccountAction(systemImage: "iphone", label: "Phone"),
    ShellAccountAction(systemImage: "arrow.triangle.2.circlepath", label: "Check for updates"),
]

/// The gap between those icons — tighter than the titlebar cluster's, because four of them plus the
/// account pill have to share one 272 pt row.
let shellAccountActionSpacing: CGFloat = 2

/// The disclosure's curve. Quicker than the side panels' — this is a row opening, not a surface
/// arriving — and with no bounce, like everything else in the shell.
let shellAccountExpandMotion: Animation = .easeInOut(duration: 0.2)

/// The account popover's width — wide enough for the longest pane title without wrapping.
let shellAccountMenuWidth: CGFloat = 240

/// PURE: every pane the menu offers, flattened — the pin reads this to check the groups are
/// non-empty and name no pane twice.
var shellAccountMenuPanes: [DashboardPane] { shellAccountMenuGroups.flatMap { $0 } }

// sidebar-chrome-2 DELETED `shellSidebarAccountRowDestination` (was `.dashboard(pane: nil)` — the
// gear affordance's inherited navigation). The account row no longer has a single plain "open the
// Dashboard" action: every entry in `shellAccountMenuGroups` targets a NAMED pane instead, which
// is the whole point of the split. Nothing is stranded by that — the Dashboard's own sidebar still
// lists every group, so landing on any pane reaches all of them; and the menu-bar "Dashboard…"
// item keeps the untargeted `.dashboard(pane: nil)` door, which is where that behaviour belongs.

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

/// Winter Phase 8d (Task 4.2, WS-14 §14): the runtime badge's label. `nil` for BOTH an absent
/// `runtimeKind` (a daemon that hasn't decided/does not know the leg — never a guessed default) AND
/// an unrecognised future value (fail-quiet, same posture as `recentsActivityDotStyle` just above —
/// an unknown string is not a licence to invent a label). The branding ruling this exists to serve:
/// NEVER "Claude Code" — `"claude-agent"` reads "Claude Agent", full stop.
func runtimeBadgeLabel(_ runtimeKind: String?) -> String? {
    switch runtimeKind {
    case "winter-agent": return "Winter Agent"
    case "claude-agent": return "Claude Agent"
    default: return nil
    }
}

/// THE hairline width for every rim and border the shell draws — the detail card, the composer,
/// the starter chips, the Cowork strip.
///
/// 0.5 pt, i.e. ONE device pixel on a Retina display (user call, 2026-08-07: the borders "are all
/// too thick"). A 1 pt border is two physical pixels and reads as a drawn line; half a point reads
/// as an edge, which is what a rim is meant to be. The phone does the same thing by dividing by
/// `displayScale`; on the Mac every supported display is 2× so the constant is simpler.
///
/// Since sidebar-chrome-2 this is also the detail CARD's rim rather than a standalone divider —
/// the rim replaced the divider, because a straight full-height line cannot follow a rounded
/// corner.
let shellSidebarHairlineWidth: CGFloat = 0.5

/// The detail card's leading corner radius. Only the leading corners round: the trailing two meet
/// the window's own edge, which already carries the system's rounding, and doubling it would read
/// as a card inside a card.
///
/// Generous on purpose — the phone's card uses 54 to sit with the display's own corner, and a
/// timid Mac radius (this shipped at 12 first) reads as a rendering artefact rather than as a
/// deliberate card edge. Tune-at-gate.
/// DERIVED from the composer's radius (2026-09-17) — the sidebar/chat edge and the composer round
/// the same way, with the same continuous curve.
let shellDetailCardCornerRadius: CGFloat = newChatCardCornerRadius

/// The detail card's shape — declared ONCE so the clip and the rim trace the same geometry. Two
/// separate constructions is how a rim ends up a hair off its own clip edge.
let shellDetailCardShape = UnevenRoundedRectangle(
    topLeadingRadius: shellDetailCardCornerRadius,
    bottomLeadingRadius: shellDetailCardCornerRadius,
    bottomTrailingRadius: 0,
    topTrailingRadius: 0,
    style: .continuous)

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

/// The gap between the nav block and the Recents section label. Reference-measured at ~44 pt, then
/// pulled back to 32 on the user's eye — 44 separated the two blocks correctly but left the pane
/// reading loose in Winter's shorter nav list, where there are five rows rather than the
/// reference's seven. Still far above the original 14, which was the real problem.
let shellSidebarSectionGap: CGFloat = 32

/// The floating account strip's height, and how far the fade reaches ABOVE it. The scroll content
/// reserves both as bottom padding, so the last recents row can be scrolled fully clear of the
/// strip instead of resting under it forever.
///
/// The fade is generous because it is the only thing separating the strip from the list — a short
/// ramp reads as an edge, which is precisely what the removed divider was.
/// The alpha a row still has at the KNEE — the moment it reaches the floating row's edge and
/// starts passing behind it. Everything above this point is the gentle half of the ramp; below it
/// the decay goes exponential.
let shellFadeKneeAlpha: Double = 0.45

/// How hard the curve bites once a row is behind the floating row. Higher = more of the drop
/// happens in the first few points past the knee.
let shellFadeBehindDecay: Double = 4.5

/// One end of the mask's ramp — eased, and DELIBERATELY NOT one curve end to end (2026-09-17).
///
/// A plain two-stop gradient changes alpha at a constant rate, so it starts and stops abruptly and
/// the eye reads those kinks as a soft line; a single smoothstep fixed that but spent the fade
/// evenly over open pane and occupied row alike, which makes a row still clearly legible as it
/// slides under "Winter".
///
/// So the ramp has a KNEE at the floating row's edge (`openHeight` is the pane before it,
/// `behindHeight` the row itself):
///
/// - **before it** — a smoothstep from solid down to `shellFadeKneeAlpha`, flat where it meets the
///   solid so there is nothing to catch on;
/// - **behind it** — exponential decay to zero (`shellFadeBehindDecay`), so most of what is left
///   disappears in the first few points past the edge and the tail reaches zero right at the
///   pane's edge rather than stopping short of it.
///
/// `fadingIn` is the top end: the same curve read from the far side, since up there it is the
/// wordmark's row that the content passes behind.
func shellFadeRamp(fadingIn: Bool, openHeight: CGFloat, behindHeight: CGFloat) -> LinearGradient {
    let total = max(openHeight + behindHeight, 1)
    let knee = Double(openHeight / total)
    // `t` runs 0 (fully solid) → 1 (fully clear), regardless of which end this ramp is.
    let stops: [Gradient.Stop] = (0...18).map { step in
        let t = Double(step) / 18
        let alpha: Double
        if t <= knee {
            let u = knee > 0 ? t / knee : 1
            alpha = 1 - (1 - shellFadeKneeAlpha) * (u * u * (3 - 2 * u)) // smoothstep 1 → knee
        } else {
            let u = (t - knee) / max(1 - knee, 0.0001)
            let k = shellFadeBehindDecay
            alpha = shellFadeKneeAlpha * (exp(-k * u) - exp(-k)) / (1 - exp(-k))
        }
        return Gradient.Stop(color: .black.opacity(alpha), location: fadingIn ? 1 - t : t)
    }
    return LinearGradient(stops: fadingIn ? stops.reversed() : stops,
                          startPoint: .top, endPoint: .bottom)
}

/// The band the floating wordmark occupies at the top of the pane: its traffic-light clearance
/// plus the row itself. Rows scroll UNDER it and are masked out across exactly this height.
let shellSidebarWordmarkBandHeight: CGFloat = shellSidebarTopInset + shellSidebarWordmarkRowHeight

/// The ramp a row dissolves over on its way under the wordmark. Shorter than the bottom's: the
/// distance to travel is smaller, and this gap is also the resting air under "Winter" (it replaced
/// that row's own 6 pt bottom padding).
let shellSidebarTopFadeHeight: CGFloat = 26

let shellAccountStripHeight: CGFloat = 46
let shellAccountFadeHeight: CGFloat = 56

/// The rounded-rect hover/selection fill's corner radius — shared by every row, one vocabulary.
let shellSidebarRowCornerRadius: CGFloat = 10

/// Where the pane's CONTENT column starts, measured from the pane's own leading edge. Rows reach
/// it as 8 pt of scroll-content padding plus 10 pt inside the row (the 10 is inside the row so the
/// hover/selection fill extends past the text, as the reference's does); anything OUTSIDE the
/// scroll view — the wordmark, the account row — must apply the whole figure itself so every
/// glyph and label in the pane lines up on one column.
let shellSidebarContentInset: CGFloat = 18

// MARK: - sidebar-brand: window chrome + the sidebar toggle

/// How far in from the window's top-left corner the traffic lights are nudged, applied by
/// `AppWindowController.positionTrafficLights` (see its doc for WHY it is done by hand rather
/// than by the unified toolbar that normally provides this).
///
/// Arrived at in two passes against the ChatGPT reference: a first estimate of (6, 6) still read
/// visibly shy in a side-by-side, and (10, 8) is the corrected measurement. Tune-at-gate, like
/// every other constant in this block — and note it interacts with
/// `shellSidebarToggleLeadingInset` below, which has to keep clearing the buttons as they move.
/// 2026-09-17: with the (experimental) empty unified toolbar, AppKit itself now places the buttons
/// 10 pt right and 9 pt lower than the toolbar-less baseline this was measured against — measured
/// off a screenshot — so the extra offset shrinks to (0, −1) to land them where (10, 8) did.
let shellTrafficLightInset = CGPoint(x: 0, y: -1)

/// Where the titlebar control cluster sits: to the RIGHT of the traffic lights, in the titlebar
/// band, at the same place whether the sidebar is showing or hidden (the reference keeps it fixed
/// there — a toggle that moved with the pane would be unfindable once the pane is gone).
///
/// `shellSidebarToggleTopInset` is measured from the very top of the WINDOW, not from the safe
/// area: the overlay carrying these buttons ignores the top safe area, exactly as the sidebar pane
/// does. Without that they land ~34 pt lower, level with the wordmark instead of the traffic
/// lights, which is what the first live build did.
///
/// The figures below are MEASURED off the reference by cropping its titlebar corner (2026-08-07),
/// not estimated: its cluster runs on a **34 pt centre-to-centre pitch** and every icon shares the
/// traffic lights' centre line. Button 26 + spacing 8 reproduces that pitch exactly; the leading
/// inset puts the first button's centre ~35 pt right of the last traffic light, as the reference
/// does.
let shellSidebarToggleLeadingInset: CGFloat = 88
let shellSidebarToggleTopInset: CGFloat = 11

/// Every titlebar cluster button's hit box — square, and the size the hover fill wears.
let shellTitlebarButtonSize: CGFloat = 26

/// Gap between cluster buttons. With `shellTitlebarButtonSize` this is the reference's 34 pt pitch.
let shellTitlebarClusterSpacing: CGFloat = 8

/// How far the trailing cluster sits from the window's right edge (reference-measured: its last
/// icon's centre is ~21 pt in, i.e. 8 pt of padding past a 26 pt button).
let shellTitlebarTrailingInset: CGFloat = 8

/// The TRAILING cluster's glyphs, read off the reference's top-right corner (2026-08-07):
/// a dashed circle, a docked-window rectangle, and a right-hand panel. The CLUSTER — still three
/// icons, still this order — not "what is still a placeholder": see
/// `shellTitlebarTrailingPlaceholderGlyphs` below for that, now that `sidebar.right` is wired
/// (panel-shell T2).
let shellTitlebarTrailingGlyphs: [String] = ["circle.dashed", "dock.rectangle", "sidebar.right"]

/// The work-panel toggle's glyph (2026-09-17) — ChatGPT's list-in-a-panel icon. Not part of
/// `shellTitlebarTrailingGlyphs`: it renders only for an attached non-chat session.
let workPanelToggleGlyph = "list.bullet.rectangle"

/// The `@AppStorage` key the work panel's visibility lives under — read by the titlebar toggle
/// (`ShellRootView`) and the panel column (`WindowContentView`).
let workPanelVisibleKey = "winter.workPanelVisible"

/// The subset of `shellTitlebarTrailingGlyphs` that is STILL a placeholder. Split out (review
/// round 2, Important 3) because the two questions — "what's in the cluster" and "what's still
/// unwired" — used to be answered by the same list, and the moment `sidebar.right` was wired
/// that conflation made `SidebarBrandTests.testTrailingPlaceholderLabelsDiscloseTheyAreNotWired`
/// assert something false of it. This list is what that pin now iterates.
let shellTitlebarTrailingPlaceholderGlyphs: [String] = ["circle.dashed", "dock.rectangle"]

/// PURE: a trailing placeholder's help text. Names what the affordance will BE, not what the glyph
/// looks like — and says it is not wired, so hovering one does not promise a feature that is not
/// there. Total by construction: an unknown glyph gets the generic label rather than crashing or
/// silently rendering an empty tooltip.
///
/// No `"sidebar.right"` case (review round 2): that glyph is wired now (panel-shell T2), and its
/// real label lives inline at its `ShellTitlebarButton` call site, keyed off live state this pure
/// function has no access to. Leaving a stale case here — reachable only if some future caller
/// asked this function about a glyph it has no business asking about — was exactly the "pin that
/// can assert a lie" risk the reviewer flagged, one level down from the test itself.
func shellTitlebarTrailingLabel(_ glyph: String) -> String {
    switch glyph {
    case "circle.dashed": return "Temporary chat (not wired yet)"
    case "dock.rectangle": return "Compact window (not wired yet)"
    default: return "Not wired yet"
    }
}

/// PURE: the toggle's glyph, which STATES the sidebar's condition rather than naming the action.
///
/// The showing state is ChatGPT's own glyph (user call, 2026-08-07: "use the same drawer icon
/// ChatGPT is using") — an outlined panel with a leading column. The hidden state fills that
/// leading column, because two distinct symbols beat one symbol in two tints: a single glyph
/// leaves the button ambiguous exactly when the pane it refers to is off-screen and cannot be
/// compared against.
func shellSidebarToggleSystemImage(isVisible: Bool) -> String {
    isVisible ? "sidebar.left" : "rectangle.leadinghalf.inset.filled"
}

/// The two navigation arrows that sit right of the toggle, matching the reference's cluster.
/// TRUE ARROWS, not chevrons (user correction, 2026-08-07) — cropping the reference's titlebar
/// confirms a full shaft with a head, which is what `arrow.left`/`arrow.right` draw.
///
/// **PLACEHOLDERS** (user call: "we shall wire them in another session"). They are nonetheless
/// REAL BUTTONS that hover like every other control here — the user's explicit call, overriding
/// this pass's first take, which rendered them `.disabled` on the argument that an inert-but-live
/// affordance misleads. Wiring them means giving the shell a navigation history;
/// `ShellNavigationModel` has no back-stack today, which is the actual missing piece.
let shellTitlebarNavigationGlyphs: [String] = ["arrow.left", "arrow.right"]

/// PURE: the toggle's help/accessibility text — the ACTION, complementing the glyph's state.
func shellSidebarToggleLabel(isVisible: Bool) -> String {
    isVisible ? "Hide sidebar" : "Show sidebar"
}

/// One titlebar cluster button. EVERY icon up there is one of these — the toggle, the navigation
/// arrows, and the trailing trio — so they share a hit box, a metric, and a hover treatment by
/// construction rather than by three views agreeing to look alike.
///
/// The hover fill is `ShellSidebarRowStyle`, the same treatment every sidebar row wears (user
/// call, 2026-08-07: "a button like highlight when hovered — not icon color but background color
/// just like the sidebar items"). One row vocabulary across the whole shell, now including the
/// titlebar.
/// PURE: a titlebar icon's ink — primary while on (ChatGPT's white/near-black selected icon),
/// muted at rest, the system's faint level while dimmed.
func shellTitlebarIconStyle(isOn: Bool, isDimmed: Bool) -> AnyShapeStyle {
    if isDimmed { return AnyShapeStyle(.tertiary) }
    return isOn ? AnyShapeStyle(Theme.textPrimary) : AnyShapeStyle(Theme.textMuted)
}

/// Settings' one way out: the arrow beside the traffic lights, now carrying its own words (user
/// call, 2026-09-18).
///
/// Not a `ShellTitlebarButton`, which is a fixed-size icon box — this one is a label, so it sizes to
/// its text. It reads in `textPrimary` rather than the titlebar's usual muted ink: every other glyph
/// up there is a control you may or may not want, while this is the only exit from a surface that
/// has replaced the whole sidebar, and it should not look optional.
struct ShellSettingsBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.left")
                    .font(Typography.control(.medium))
                Text("Back to app")
                    .font(Typography.body())
            }
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 8)
            .frame(height: shellTitlebarButtonSize)
            .contentShape(Rectangle())
        }
        .buttonStyle(ShellChromeButtonStyle())
        .help("Back to app")
        .accessibilityLabel("Back to app")
    }
}

struct ShellTitlebarButton: View {
    let systemImage: String
    let label: String
    /// Placeholders read one step quieter than live controls, but still hover and still click —
    /// they are honestly not wired, not pretending to be disabled.
    var isPlaceholder: Bool = false
    /// panel-shell T10: every EXISTING call site leaves this at its default — the main titlebar's
    /// own 26pt hit box (`shellTitlebarButtonSize`) — so nothing already on screen changes. The
    /// panel's own trailing cluster (`ShellPanel.swift`'s `trailingButtonCluster`) is the one
    /// caller that passes `panelExpandButtonSize` (28pt): it sits in the tab row, where the pill
    /// height and the "+" button are both 28pt, and this component's PREVIOUS hard-coded
    /// `shellTitlebarButtonSize` frame would have rendered a visibly mismatched button there.
    var size: CGFloat = shellTitlebarButtonSize
    /// panel-shell T10: a persistent highlight (`ShellSidebarRowStyle`'s `.selected` fill) for a
    /// control that reflects a MODE rather than only firing an action — the expand-to-fullscreen
    /// button, filled while the panel actually IS maximized, mirroring how a selected nav row
    /// stays filled without being hovered. Every existing call site leaves this at its default
    /// `false` (hover remains the only fill), so nothing already on screen changes.
    var isOn: Bool = false
    var action: () -> Void = {}
    /// panel-shell T2: read explicitly rather than trusted to dim on its own. `.disabled(...)`
    /// (first real caller: the panel toggle, greyed rather than hidden on a too-narrow window)
    /// only guarantees non-interactivity — `ShellSidebarRowStyle` is a fully custom `ButtonStyle`
    /// that renders `configuration.label` verbatim, and this label's `foregroundStyle` below is an
    /// explicit concrete colour, so nothing dims it automatically. Reuses the SAME quiet tone
    /// `isPlaceholder` already wears rather than inventing a second one — a disabled control and a
    /// placeholder now share a look (both honestly read as "not clickable right now"), though only
    /// the placeholder still hovers and clicks.
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(Typography.control(.medium))
                .foregroundStyle(shellTitlebarIconStyle(isOn: isOn,
                                                        isDimmed: isPlaceholder || !isEnabled))
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        // ChatGPT's chrome states (2026-09-17): hover `chromeHover`, on `chromeSelected`.
        .buttonStyle(ShellChromeButtonStyle(isSelected: isOn))
        .help(label)
        .accessibilityLabel(label)
    }
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
/// (spec §1's exact order, pinned pure as `shellSidebarTopRows` + `shellAccountMenuGroups`):
///
/// - **New chat** — a compact icon+label ACTION row (pencil-square), topmost. Fires the injected
///   door, never a selection.
/// - **Chats / Code / Dispatch / Cowork** — compact icon+label nav rows onto the existing
///   `.mode(...)` landings; unavailable ones dimmed with a deglassed "Soon" tag but never dead.
/// - **Search** — a thin field filtering Recents by title, live, local-only (`filteredRecents`).
/// - **Recents** — flat, mode-agnostic, compact single-line rows; activity as a subtle dot
///   (`recentsActivityDotStyle` — the chips lost the glass); Move to CLI on the context menu,
///   the SAME `moveToCliOffered` gate + `ShellSessionHost.moveToCli` verb as the landings.
/// - **Account row** — app glyph + "Winter" + chevron → the Dashboard (replaces the gear).
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
    /// 2026-09-17: the three floating panels, owned by `ShellRootView` for the same sibling reason
    /// the palette is — the account row's icons open them, the panels render over the root.
    @ObservedObject var overlays: ShellOverlayPresentation
    /// Which library tab the panel returns to, held by the root so it survives a close.
    @Binding var libraryTab: LibraryTab
    /// The gear's door. The root owns it because entering Settings has to remember where the user
    /// was first, which this pane has no business knowing.
    var onOpenSettings: () -> Void = {}
    /// The settings sidebar's Back row.
    var onLeaveSettings: () -> Void = {}

    /// The account popover's presentation flag — local to this pane, since both the button that
    /// opens it and the popover itself live here (unlike the search palette, whose door and body
    /// are siblings and therefore need state at their common parent).
    /// PARKED, not dead (2026-09-17): the popover this drove was replaced by the row's sideways
    /// disclosure, but `accountMenuContent` is where the Dashboard's doors are already assembled
    /// from the Dashboard's own tables — it is what the gear icon opens once the cluster is wired.
    @State private var accountMenuShown = false
    /// Whether the account row is expanded into its icon cluster (2026-09-17). Local to the pane,
    /// and deliberately NOT persisted: it is a disclosure, not a preference.
    @State private var accountExpanded = false

    /// While Settings is showing, this pane is the settings sidebar and NOTHING else (user call,
    /// 2026-09-17): no wordmark, no search, no account row. Those three belong to the app's own
    /// navigation, and leaving them up made Settings look like a page inside the sidebar rather
    /// than the surface that replaced it. The way out is the titlebar's one back arrow.
    private var isSettings: Bool { shellDestinationIsSettings(nav.destination) }

    // sidebar-chrome-2 DELETED `isDashboardDestination` (Task 7's "lit for ANY .dashboard
    // destination"). The account row is a MENU now, not a navigation row, so it has no selected
    // state to compute — a menu button that highlights because of where you happen to be would be
    // claiming a selection it does not represent.

    var body: some View {
        // 2026-09-17: the wordmark is an OVERLAY, not a sibling above the scroll. As a sibling it
        // clipped the scroll at its own bottom edge, so a row scrolling up vanished at a hard
        // line — the thing the bottom strip had already been fixed for. Now the scroll runs the
        // FULL height of the pane, under both the wordmark and the account row, and
        // `recentsFadeMask` dissolves the rows at each end. Both ends, one mechanism.
        Group {
            ScrollView {
                // 2026-09-17: in Settings this column IS the settings sidebar (user call: "the
                // sidebar will be rewritten as settings sidebar in settings tab"). Swapping the
                // content rather than nesting a second list is what keeps one sidebar on screen.
                if case .settings(let section) = nav.destination {
                    SettingsSidebarContent(nav: nav,
                                           selected: section ?? defaultSettingsSection)
                        .padding(.horizontal, 8)
                        // Only the traffic-light band to clear now — there is no wordmark above and
                        // no account row below, so the sections start higher and run lower.
                        .padding(.top, shellSidebarTopInset + shellSidebarTopFadeHeight)
                        .padding(.bottom, shellAccountFadeHeight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(shellSidebarTopRows, id: \.self) { row in
                        topRow(row)
                    }
                    // The Recents section label — dim, sentence case (uppercase-free, the ChatGPT
                    // register; deliberately NOT `DashboardSurface`'s `.uppercased()` treatment).
                    // sidebar-brand: the warm brand grey at the reference's larger, quieter
                    // register (was 11 pt semibold `.secondary`), under a generous section gap.
                    Text("Recents")
                        .font(Typography.body())
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
                            .font(Typography.body())
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
                // Clearance for the FLOATING wordmark above and account strip below, so the first
                // and last rows can still be scrolled fully clear of them instead of resting
                // permanently underneath. The fade bands are part of that clearance: without
                // them the row at rest would sit half-dissolved inside the ramp.
                .padding(.top, shellSidebarWordmarkBandHeight + shellSidebarTopFadeHeight)
                .padding(.bottom, shellAccountStripHeight + shellAccountFadeHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            // The rows carry their own disappearance at BOTH ends (2026-09-17) — see `accountStrip`.
            .mask { recentsFadeMask }
            .overlay(alignment: .top) {
                if !isSettings { wordmarkRow }
            }
        }
        // The account strip FLOATS over the scroll rather than sitting below it (user call,
        // 2026-08-07), so recents pass UNDERNEATH it: a soft fade first, then the blurred strip.
        // That is what replaced the divider — the rows softening as they go under says "there is
        // more here" far better than a hard rule ever did.
        .overlay(alignment: .bottom) {
            if !isSettings { accountStrip }
        }
        .frame(width: shellSidebarWidth)
        // Flat opaque fill, edge-to-edge and top-to-bottom — the pane's ONE background, reaching
        // the very top of the window (nothing native reserves the titlebar band any more: the
        // window's toolbar died with this rework, `AppWindowController`).
        // sidebar-brand: that fill is now the brand BASE PLANE (`docs/brand.md` § the plane
        // mapping) — warm cream in light, warm charcoal in dark. The content side wears
        // `cardSurface`, one step brighter; that difference IS the separation, and the hairline
        // is only secondary.
        //
        // 2026-09-17 EXPERIMENT: the pane paints NO fill of its own any more — the shell's base
        // plane behind it is the behind-window vibrancy (`ShellVibrancyBackground`, which says why
        // a SwiftUI material cannot blur the desktop), and a fill here would just cover it. The
        // content side stays opaque `cardSurface`, so it is everything AROUND the card — this
        // column, the gutter, the corner wedges — that is translucent, as one continuous plane.
        // ChatGPT's sidebar ink — the sidebar's `.primary` resolves one step softer.
        .foregroundStyle(Theme.textSecondary)
        // Every row INSIDE this pane is on the vibrant plane, so its hover/selected steps are the
        // washes rather than the opaque greys (`ShellSidebarRowStyle.RowBody.fill`).
        .environment(\.shellRowFillIsVibrant, true)
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
                .font(Typography.body())
                .frame(width: 18)
            Text(shellSidebarRowTitle(row))
                .font(Typography.body())
            Spacer(minLength: 4)
            if case .mode(let mode) = row, !mode.isAvailable {
                // Deglassed (the capsule fill died with the reskin): a quiet tag, now in the
                // brand's warm muted grey rather than the cooler system `.tertiary`.
                Text("Soon")
                    .font(Typography.chipLabel.weight(.medium))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: shellSidebarRowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// sidebar-brand T4 (spec R1): the wordmark header row — Winter's ONE serif accent on the Mac
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
            Text("Winter")
                .font(Theme.wordmark)
                .foregroundStyle(.primary)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button {
                presentation.open()
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(Typography.control(.medium))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Search sessions")
            .accessibilityLabel("Search sessions")
        }
        // The wordmark row lives OUTSIDE the ScrollView, so it does not inherit the scroll
        // content's own 8 pt horizontal padding — its inset has to add up to the same figure the
        // rows land on (8 + 10), or "Winter" sits ~8 pt further left than every glyph below it and
        // reads as crowding the window edge (user call, 2026-08-07).
        .padding(.horizontal, shellSidebarContentInset)
        .frame(height: shellSidebarWordmarkRowHeight)
        .padding(.top, shellSidebarTopInset)
    }

    /// One compact Recents row: single-line middle-truncated title + the subtle activity dot
    /// (`recentsActivityDotStyle` — deglassed; the landings keep the full labeled chip). A Button
    /// in the same ONE row treatment, selected while its session is the shown destination. The
    /// context menu carries the existing Move to CLI verb behind the existing gate, unchanged.
    private func recentsRow(_ row: SessionSummary) -> some View {
        Button {
            nav.navigate(to: .session(row.sessionId))
        } label: {
            HStack(spacing: 10) {
                // The session's OWN mode glyph (user call, 2026-08-07 — this pass first left it
                // off as ChatGPT-faithful). `SessionMode(wire:)` is the shell's one mode table, so
                // this is the same glyph set the mode rows above and the search palette already
                // wear; there is no second table here to drift.
                Image(systemName: SessionMode(wire: row.mode).systemImage)
                    .font(Typography.label())
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 16)
                // A long title fades out at its end (ChatGPT), never "…"-cut in the middle.
                // No Spacer after it: the title box itself takes the free width (a Spacer would
                // split it and start the fade half a row early).
                FadingTitleText(text: sessionDisplayTitle(row.title), font: Typography.body())
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

    /// The bottom account row — Claude's shape (user call, 2026-08-07): a circular avatar, the
    /// name, and a chevron that opens a MENU, with a quiet placeholder affordance at the trailing
    /// edge. Claude's "· Max" plan tag is deliberately absent — the user's ruling that it "has no
    /// reason to exist" here, and Winter has no plans to name.
    ///
    /// The shape is the point: there is no profile yet (`shellAccountRowTitle` is a placeholder),
    /// and building the row as an account control now means the real profile can drop straight in
    /// without the pane changing shape a third time.
    ///
    /// This REPLACES the plain navigate-to-Dashboard button. The Dashboard is still reachable —
    /// every menu entry lands in it — but by NAME rather than as one undifferentiated door, which
    /// is the user's "split into settings and other things".
    /// The floating bottom strip: the account row, and nothing behind it.
    ///
    /// The DIVIDER that used to sit here is gone (user call, 2026-08-07). Two attempts at replacing
    /// it both failed the same way — `.ultraThinMaterial` first, then a gradient ramp into the
    /// pane's canvas: each PAINTED something across the strip, and a painted strip with a top edge
    /// is the divider again, drawn as a tone change instead of a line.
    ///
    /// 2026-09-17 — THE RAMP IS GONE. Over the vibrant pane it had nowhere to hide: an opaque end
    /// punched a flat rectangle through the blur, and a translucent one (tried at 0.9) was a grey
    /// band with rows ghosting through it, which is the very thing the ramp existed to prevent.
    ///
    /// Nothing is painted behind the row now. The rows themselves fade instead — the scroll is
    /// MASKED (`recentsBottomFadeMask`), so a title approaching the strip loses its own alpha and
    /// is gone before it reaches the account row. The pane's plane is continuous top to bottom,
    /// and the disappearance is carried by the thing that is actually disappearing.
    private var accountStrip: some View {
        accountRow
            .frame(height: shellAccountStripHeight)
    }

    /// The mask that does it, symmetric: fully clear across the wordmark's band, a ramp in, solid
    /// for the middle, a ramp out, fully clear across the account row's band. Nothing renders
    /// behind either floating row at all — rendering at 10% there is what reads as dirt.
    private var recentsFadeMask: some View {
        VStack(spacing: 0) {
            if isSettings {
                // Nothing floats over this column in Settings, so there is nothing to disappear
                // BEHIND — just a soft top under the traffic lights and a soft bottom at the
                // window's edge, with no clear bands at either end.
                Color.clear
                    .frame(height: shellSidebarTopInset)
                shellFadeRamp(fadingIn: true,
                              openHeight: shellSidebarTopFadeHeight, behindHeight: 0)
                    .frame(height: shellSidebarTopFadeHeight)
                Rectangle()
                shellFadeRamp(fadingIn: false,
                              openHeight: shellAccountFadeHeight, behindHeight: 0)
                    .frame(height: shellAccountFadeHeight)
            } else {
            // Only the traffic-light band is fully clear. The ramp runs THROUGH the wordmark's
            // own row and the account row rather than stopping at their edges (user call,
            // 2026-09-17): ending it at the floating row's edge put the last step of the fade on
            // a straight line exactly where that row begins, which is the edge again — read as a
            // faint band under "Winter" instead of a rule. Running the ramp past the row means
            // the only place alpha reaches zero is the pane's own edge, where nothing can show.
            Color.clear
                .frame(height: shellSidebarTopInset)
            shellFadeRamp(fadingIn: true,
                          openHeight: shellSidebarTopFadeHeight,
                          behindHeight: shellSidebarWordmarkRowHeight)
                .frame(height: shellSidebarWordmarkRowHeight + shellSidebarTopFadeHeight)
            Rectangle()
            shellFadeRamp(fadingIn: false,
                          openHeight: shellAccountFadeHeight,
                          behindHeight: shellAccountStripHeight)
                .frame(height: shellAccountFadeHeight + shellAccountStripHeight)
            }
        }
    }

    private var accountRow: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                // A Button + popover, NOT a SwiftUI `Menu` (caught live, 2026-08-07): `Menu`'s
                // label is rendered by AppKit's menu machinery, which ignored the custom HStack —
                // first blowing the avatar up to its natural ~100 pt, then collapsing the whole
                // label to a bare indicator and one letter. A popover is drawn by SwiftUI, so the
                // row looks exactly like what is written here, and it keeps the pane fully
                // custom-drawn ([[custom-chrome-not-native]]) instead of borrowing menu chrome.
                // 2026-09-17: this opens the row SIDEWAYS instead of opening a popover menu (user
                // call). The chevron points right because that is now the direction the disclosure
                // travels, and it turns to point back the way it came while open.
                Button {
                    withAnimation(shellAccountExpandMotion) { accountExpanded.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        avatar
                        Text(shellAccountRowTitle)
                            .font(Typography.body())
                            .foregroundStyle(.primary)
                        Image(systemName: "chevron.right")
                            .font(Typography.badge(.semibold))
                            .foregroundStyle(Theme.textMuted)
                            .rotationEffect(.degrees(accountExpanded ? 180 : 0))
                    }
                    .padding(.horizontal, 8)
                    .frame(height: shellAccountRowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ShellSidebarRowStyle(isSelected: accountExpanded))
                .accessibilityLabel("Account and settings")

                Spacer(minLength: 0)

                if accountExpanded {
                    HStack(spacing: shellAccountActionSpacing) {
                        ForEach(shellAccountActions, id: \.systemImage) { action in
                            // NOT `isPlaceholder` (user call, 2026-09-17): these read at full
                            // strength even while unwired. Each one is about to own a real
                            // surface, and the quiet tone is for things that may never be wired.
                            ShellTitlebarButton(systemImage: action.systemImage,
                                                label: action.label,
                                                isOn: accountActionIsOn(action),
                                                action: { perform(action) })
                        }
                    }
                    // They come out FROM BEHIND the account pill (user call) — the row opening
                    // rightward pushes them into view, rather than them flying in from the window
                    // edge to meet it.
                    .transition(.move(edge: .leading).combined(with: .opacity))
                } else {
                    // PLACEHOLDER (user call: "the downloads icon on the corner we shall deal with
                    // it later"). Stands down while the cluster is out — the cluster carries an
                    // update icon of its own, and two of them would be one too many.
                    Image(systemName: "arrow.down.to.line.compact")
                        .font(Typography.body())
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, shellSidebarContentInset - 8)
            .padding(.vertical, 8)
        }
    }

    /// What each revealed icon does. The gear is a DESTINATION (the root remembers where you were
    /// and swaps this very column for the settings sections); the other three are floating panels,
    /// because each is a thing you consult and dismiss rather than navigate to.
    private func perform(_ action: ShellAccountAction) {
        switch action.systemImage {
        case "gearshape": onOpenSettings()
        case "book.closed": openOverlay(.library)
        case "iphone": openOverlay(.devices)
        default: openOverlay(.updates)
        }
    }

    /// A door stays LIT while what it opened is showing — the same "reflects a mode, not just an
    /// action" treatment the panel's maximize button already wears.
    private func accountActionIsOn(_ action: ShellAccountAction) -> Bool {
        switch action.systemImage {
        case "gearshape": if case .settings = nav.destination { return true } else { return false }
        case "book.closed": return overlays.overlay == .library
        case "iphone": return overlays.overlay == .devices
        default: return overlays.overlay == .updates
        }
    }

    private func openOverlay(_ overlay: ShellOverlay) {
        withAnimation(shellAccountExpandMotion) { overlays.toggle(overlay) }
    }

    /// The circular avatar — a drawn monogram, exactly the reference's (a tinted circle with an
    /// initial), standing in for a profile picture that does not exist yet.
    ///
    /// DRAWN rather than `NSApp.applicationIconImage`: inside a `Menu`'s label, AppKit's menu
    /// machinery ignored the image's `.frame`/`.clipShape` entirely and rendered the icon at its
    /// natural ~100 pt, which swallowed the row (caught live, 2026-08-07). A shape and a `Text`
    /// have no intrinsic size to fall back to, so they cannot reproduce that failure — and this is
    /// closer to the reference besides.
    private var avatar: some View {
        Circle()
            .fill(Theme.controlSurface)
            .frame(width: shellAccountAvatarSize, height: shellAccountAvatarSize)
            .overlay(
                Text(String(shellAccountRowTitle.prefix(1)))
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(Theme.textMuted)
            )
    }

    /// The menu's content, built from `shellAccountMenuGroups` — titles and glyphs come from the
    /// Dashboard's OWN two functions, so nothing here can drift from what the Dashboard calls the
    /// same pane. Each entry navigates straight to its pane, which is the whole point: things are
    /// reached by name rather than through one undifferentiated "Dashboard" door.
    ///
    /// Hand-drawn rows in the pane's own vocabulary (`ShellSidebarRowStyle`), so the popover reads
    /// as part of this sidebar rather than as a system menu that wandered in.
    private var accountMenuContent: some View {
        VStack(alignment: .leading, spacing: 1) {
            // The header carries the identity the row is a placeholder for — the reference puts
            // the account's email here. Non-interactive: it names, it does not navigate.
            Text(shellAccountRowTitle)
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, 10)
                .padding(.top, 4)
                .padding(.bottom, 6)

            ForEach(Array(shellAccountMenuGroups.enumerated()), id: \.offset) { index, group in
                if index > 0 {
                    Rectangle()
                        .fill(Theme.hairline)
                        .frame(height: 1)
                        .padding(.vertical, 5)
                }
                ForEach(group, id: \.self) { pane in
                    Button {
                        accountMenuShown = false
                        nav.navigate(to: .dashboard(pane: pane))
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: dashboardPaneSystemImage(pane))
                                .font(Typography.control())
                                .foregroundStyle(Theme.textMuted)
                                .frame(width: 18)
                            Text(dashboardPaneTitle(pane))
                                .font(Typography.control())
                                .foregroundStyle(.primary)
                            Spacer(minLength: 12)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: shellSidebarRowHeight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellSidebarRowStyle(isSelected: false))
                }
            }
        }
        .padding(6)
        .frame(width: shellAccountMenuWidth)
    }
}

// MARK: - Which plane a row is drawn on (2026-09-17)

/// True for rows sitting on the sidebar's TRANSLUCENT plane, false everywhere the same row style is
/// worn over an opaque surface (the search palette, the account popover, the panel's Files tab, the
/// New Chat page). Set ONCE on the pane rather than passed at every call site — the rows that need
/// the vibrant washes are exactly the rows inside that pane, and a parameter would have to be
/// remembered at each of the eight call sites instead.
private struct ShellRowFillIsVibrantKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var shellRowFillIsVibrant: Bool {
        get { self[ShellRowFillIsVibrantKey.self] }
        set { self[ShellRowFillIsVibrantKey.self] = newValue }
    }
}

// MARK: - The ONE row treatment (custom-sidebar)

/// Every sidebar row's rendering: the label over a `shellSidebarRowCornerRadius` rounded-rect
/// whose fill is decided by the ONE pure function (`shellSidebarRowFill` — selection beats hover,
/// rest is bare). A `ButtonStyle` so every row is a real `Button` (keyboard/accessibility for
/// free) while the hover tracking lives in exactly one place. A press reads as hover-strength
/// feedback on an unselected row — quiet, custom, nothing native.
///
/// panel-shell T13: also worn by the panel's tab pills (`PanelTabPill`, `ShellPanel.swift`) — same
/// mechanism, not a second one, via `selectedUsesHoverTone` below.
struct ShellSidebarRowStyle: ButtonStyle {
    var isSelected: Bool
    /// panel-shell T13: the ONE deviation a caller can ask for. Every existing call site (sidebar
    /// rows, `ShellTitlebarButton`) leaves this at its default `false` and is byte-identical to
    /// before T13. Only `PanelTabPill` passes `true`: the plan's Global Constraints assign panel
    /// tabs the `RowHover` token specifically, not `SelectionPill` like a selected sidebar row, so
    /// wearing this style unmodified would have silently recolored the active tab on adoption.
    /// Named for the EFFECT, not the mechanism — this does not add a second fill source, it swaps
    /// which one token `.selected` resolves to, below.
    var selectedUsesHoverTone: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, isSelected: isSelected,
                selectedUsesHoverTone: selectedUsesHoverTone)
    }

    /// The `@State` hover flag needs a `View` to live on — `ButtonStyle` itself is not one.
    private struct RowBody: View {
        let configuration: Configuration
        let isSelected: Bool
        let selectedUsesHoverTone: Bool
        @State private var isHovered = false
        @Environment(\.shellRowFillIsVibrant) private var isVibrant

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
        /// `selectionPill` is a neutral grey: darker than the pane in both appearances.
        /// Both follow the system appearance by construction. Tune-at-gate values.
        ///
        /// 2026-09-17: on the TRANSLUCENT pane those opaque greys read as chips stuck on the
        /// window — they cover the blur exactly where the eye is. Inside the pane
        /// (`shellRowFillIsVibrant`) the same two steps resolve to the luminance washes instead
        /// (`Theme.rowHoverVibrant`/`selectionPillVibrant`), which brighten or darken the backdrop
        /// without hiding it. Same ramp, same decision function — only the paint differs, and the
        /// eight call sites on opaque surfaces are untouched by construction.
        private var fill: AnyShapeStyle {
            let hover = isVibrant ? Theme.rowHoverVibrant : Theme.rowHover
            let selected = isVibrant ? Theme.selectionPillVibrant : Theme.selectionPill
            switch shellSidebarRowFill(isSelected: isSelected,
                                       isHovered: isHovered || configuration.isPressed) {
            case .selected:
                return selectedUsesHoverTone ? AnyShapeStyle(hover) : AnyShapeStyle(selected)
            case .hover: return AnyShapeStyle(hover)
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
                .font(Typography.emptyStateGlyph)
                .foregroundStyle(.tertiary)
            Text(shellDestinationTitle(destination))
                .font(Typography.emptyStateTitle)
            Text(shellLandingPlaceholderText(destination))
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
