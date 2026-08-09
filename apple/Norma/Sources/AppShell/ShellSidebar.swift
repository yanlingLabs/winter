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
    /// `NSHostingView` (`AppWindowController.swift:215`) — `NormaApp`'s only `Scene` is an empty
    /// `Settings {}` (`NormaApp.swift`), so there is no SwiftUI window-restoration scene for
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
                    guard env["NORMA_PANEL_SMOKE"] == "1" else { return }
                    presentation.mode = .side
                    host?.openPanelTab(kind: .web) { sessionId in
                        nav.navigate(to: .session(sessionId))
                    }
                    // Task 6a fix pass: reproduce the LIVE-GATE DEFECT without a click. Closing a
                    // tab (and switching destination with one open — the same dismantle) was making
                    // Norma's whole window disappear, because CEF's default `DoClose` sends
                    // `performClose:` to the browser's top-level parent window. `closePanelTab` is
                    // the identical door the pill's × uses, so this exercises the real path.
                    if let after = env["NORMA_PANEL_SMOKE_CLOSE_AFTER"].flatMap(Double.init) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                            guard let tabId = panelStore.tabs.first?.tabId else { return }
                            host?.closePanelTab(tabId)
                        }
                    }
                    // The user's SECOND reported trigger: clicking Cowork in the sidebar with a tab
                    // open. It reaches the same dismantle by a different route — the panel's tab
                    // list is per-session, so leaving the session empties it and the content slot
                    // tears down — which is why one `DoClose` fix covers both.
                    if let after = env["NORMA_PANEL_SMOKE_NAV_AFTER"].flatMap(Double.init) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                            nav.navigate(to: .mode(.cowork))
                        }
                    }
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
                             presentation: searchPalette)
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
                    // sidebar-brand T5: the RAISED plane (`docs/brand.md` § the plane mapping).
                    // REQUIRED, not cosmetic: the sidebar's cream only reads correctly against a
                    // painted content plane — against the window's default system grey it looks
                    // wrong rather than warm. Painted here, at the shell level, so every destination
                    // inherits it and none has to remember.
                    // The CARD — the phone's own treatment brought over (user call, 2026-08-07): iOS
                    // masks its reveal card with a continuous rounded rect, traces that exact shape
                    // with a hairline rim, and floats it on the warm base. Only the LEADING corners
                    // round — the other two meet the window's own edge, which already has the
                    // system's rounding, and doubling it would read as a card inside a card.
                    //
                    // Drawn as a BACKGROUND LAYER that ignores the safe area, not as a clip on the
                    // content. `detail`'s content is inset by the titlebar's safe area (only the
                    // sidebar opts out), so clipping the content produced a ~23 pt gap above the card
                    // — invisible before only because the window's own `CardSurface` fill was quietly
                    // covering that band, and revealed the moment `canvas` went behind it. A
                    // background layer reaches the window's top edge without moving any content.
                    //
                    // This REPLACED the full-height boundary hairline between pane and detail: a
                    // straight line cannot follow a rounded corner, so it would have run past the
                    // card's edge. The rim is the separator now, which is also how the phone does it.
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

            // panel-shell T2: the third column. The divider renders ONLY in `.side` — there is
            // nothing to divide when the panel owns the whole content area (`.maximized`), and
            // neither it nor the panel renders at all in `.hidden`.
            //
            // Every `panelClampWidth` call below is reachable ONLY when `mode == .side`, which
            // `panelResolvedMode` guarantees means `panelFitsInContent(contentWidth)` already
            // holds — that is what keeps the clamp's own bounds from inverting (Task 1's carried
            // finding; the guarantee is pinned by
            // `PanelModeTests.testClampBoundsAreNeverInvertedWhenThePanelFits`). Nothing here ever
            // calls it below the threshold where it could — panel-shell T10: that includes
            // `panelRenderedWidth` below, which only calls `panelClampWidth` for `.side` and is
            // itself only ever called from inside this SAME `mode != .hidden` branch.
            if mode != .hidden {
                if mode == .side {
                    PanelDivider(width: $presentation.sideWidth, contentWidth: contentWidth)
                }
                ShellPanel(store: panelStore, presentation: $presentation, host: host, nav: nav)
                    .frame(width: mode == .maximized
                           ? nil
                           : panelRenderedWidth(mode: mode, sideWidth: presentation.sideWidth,
                                                 contentWidth: contentWidth))
                    .frame(maxWidth: mode == .maximized ? .infinity : nil,
                           maxHeight: .infinity)
                    // Mirrors the sidebar's own leading-edge slide (`sidebarVisible` above) —
                    // a physical surface sliding in from its own edge, not fading.
                    .transition(.move(edge: .trailing))
            }
        }
        // ONE brand tint for the whole shell (user call, 2026-08-07: every cursor in the app the
        // same colour). `.tint` is what drives a SwiftUI `TextField`'s caret and selection, and it
        // cascades — so setting it here covers the search palette, the Dashboard panes, the
        // pending cards and anything added later, rather than each field remembering to opt in.
        //
        // Deliberately NOT `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`: that would retint
        // every system control in the app process, including surfaces this pass does not own.
        .tint(Theme.accent)
        // The base plane behind everything, so the card's rounded corners reveal warm canvas
        // rather than the window's own fill. The sidebar paints its own `canvas` too; this is what
        // covers the sliver the corners cut out of the detail side.
        .background(Theme.canvas)
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
            if mode == .hidden {
                HStack(spacing: shellTitlebarClusterSpacing) {
                    ForEach(shellTitlebarTrailingGlyphs, id: \.self) { glyph in
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
                                withAnimation(.snappy) { presentation.toggleVisible() }
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
                ShellTitlebarButton(systemImage: "circle.dashed",
                                    label: shellTitlebarTrailingLabel("circle.dashed"),
                                    isPlaceholder: true)
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
        }
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
let shellAccountRowTitle = "Norma"

/// The monogram avatar's diameter, and the account row's overall height. The row is given an
/// EXPLICIT height because it is a `Menu` label: AppKit's menu machinery does not reliably honour
/// intrinsic sizing there, so the row states its own height rather than inferring one.
let shellAccountAvatarSize: CGFloat = 24
let shellAccountRowHeight: CGFloat = 34

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
let shellDetailCardCornerRadius: CGFloat = 28

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
/// reading loose in Norma's shorter nav list, where there are five rows rather than the
/// reference's seven. Still far above the original 14, which was the real problem.
let shellSidebarSectionGap: CGFloat = 32

/// The floating account strip's height, and how far the fade reaches ABOVE it. The scroll content
/// reserves both as bottom padding, so the last recents row can be scrolled fully clear of the
/// strip instead of resting under it forever.
///
/// The fade is generous because it is the only thing separating the strip from the list — a short
/// ramp reads as an edge, which is precisely what the removed divider was.
let shellAccountStripHeight: CGFloat = 46
let shellAccountFadeHeight: CGFloat = 32

/// The rounded-rect hover/selection fill's corner radius — shared by every row, one vocabulary.
let shellSidebarRowCornerRadius: CGFloat = 6

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
let shellTrafficLightInset = CGPoint(x: 10, y: 8)

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
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle((isPlaceholder || !isEnabled) ? AnyShapeStyle(.tertiary)
                                                                : AnyShapeStyle(Theme.textMuted))
                .frame(width: size, height: size)
                .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: isOn))
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

    /// The account popover's presentation flag — local to this pane, since both the button that
    /// opens it and the popover itself live here (unlike the search palette, whose door and body
    /// are siblings and therefore need state at their common parent).
    @State private var accountMenuShown = false

    // sidebar-chrome-2 DELETED `isDashboardDestination` (Task 7's "lit for ANY .dashboard
    // destination"). The account row is a MENU now, not a navigation row, so it has no selected
    // state to compute — a menu button that highlights because of where you happen to be would be
    // claiming a selection it does not represent.

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
                // Clearance for the FLOATING account strip below, so the last recents row can
                // still be scrolled fully clear of it instead of resting permanently underneath.
                .padding(.bottom, shellAccountStripHeight + shellAccountFadeHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // The account strip FLOATS over the scroll rather than sitting below it (user call,
        // 2026-08-07), so recents pass UNDERNEATH it: a soft fade first, then the blurred strip.
        // That is what replaced the divider — the rows softening as they go under says "there is
        // more here" far better than a hard rule ever did.
        .overlay(alignment: .bottom) { accountStrip }
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
        // The wordmark row lives OUTSIDE the ScrollView, so it does not inherit the scroll
        // content's own 8 pt horizontal padding — its inset has to add up to the same figure the
        // rows land on (8 + 10), or "Norma" sits ~8 pt further left than every glyph below it and
        // reads as crowding the window edge (user call, 2026-08-07).
        .padding(.horizontal, shellSidebarContentInset)
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
            HStack(spacing: 10) {
                // The session's OWN mode glyph (user call, 2026-08-07 — this pass first left it
                // off as ChatGPT-faithful). `SessionMode(wire:)` is the shell's one mode table, so
                // this is the same glyph set the mode rows above and the search palette already
                // wear; there is no second table here to drift.
                Image(systemName: SessionMode(wire: row.mode).systemImage)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: 16)
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

    /// The bottom account row — Claude's shape (user call, 2026-08-07): a circular avatar, the
    /// name, and a chevron that opens a MENU, with a quiet placeholder affordance at the trailing
    /// edge. Claude's "· Max" plan tag is deliberately absent — the user's ruling that it "has no
    /// reason to exist" here, and Norma has no plans to name.
    ///
    /// The shape is the point: there is no profile yet (`shellAccountRowTitle` is a placeholder),
    /// and building the row as an account control now means the real profile can drop straight in
    /// without the pane changing shape a third time.
    ///
    /// This REPLACES the plain navigate-to-Dashboard button. The Dashboard is still reachable —
    /// every menu entry lands in it — but by NAME rather than as one undifferentiated door, which
    /// is the user's "split into settings and other things".
    /// The floating bottom strip: the account row over ONE continuous ramp into the pane's canvas.
    ///
    /// The DIVIDER that used to sit here is gone (user call, 2026-08-07), and the first attempt at
    /// replacing it put `.ultraThinMaterial` behind the row. That was wrong for a specific reason:
    /// a material TINTS regardless of what is behind it, and this pane is opaque canvas — so
    /// instead of blurring rows it painted a grey band with a hard top edge. That is the divider
    /// again, just drawn as a tone change instead of a line.
    ///
    /// So: no material. One gradient spanning the WHOLE strip — transparent at the top, fully
    /// canvas by just over halfway, canvas the rest of the way — so rows dissolve into the pane's
    /// own colour as they pass under and there is no boundary anywhere to catch the eye. The ramp
    /// has to cover the row's own height too; ending it above the row is what reintroduces an edge.
    private var accountStrip: some View {
        accountRow
            .frame(height: shellAccountStripHeight)
            .background(alignment: .bottom) {
                LinearGradient(
                    stops: [
                        .init(color: Theme.canvas.opacity(0), location: 0),
                        .init(color: Theme.canvas, location: 0.55),
                        .init(color: Theme.canvas, location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom
                )
                .frame(height: shellAccountStripHeight + shellAccountFadeHeight)
                .allowsHitTesting(false)
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
                Button {
                    accountMenuShown.toggle()
                } label: {
                    HStack(spacing: 8) {
                        avatar
                        Text(shellAccountRowTitle)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.primary)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textMuted)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: shellAccountRowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(ShellSidebarRowStyle(isSelected: false))
                .accessibilityLabel("Account and settings")
                .popover(isPresented: $accountMenuShown, arrowEdge: .top) {
                    accountMenuContent
                }

                Spacer(minLength: 0)

                // PLACEHOLDER (user call: "the downloads icon on the corner we shall deal with it
                // later"). Disabled for the same reason the navigation arrows are — an affordance
                // that looks live and does nothing is worse than one that admits it isn't ready.
                Image(systemName: "arrow.down.to.line.compact")
                    .font(.system(size: 14))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, shellSidebarContentInset - 8)
            .padding(.vertical, 8)
        }
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
                    .font(.system(size: 11, weight: .semibold))
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
                .font(.system(size: 12))
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
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.textMuted)
                                .frame(width: 18)
                            Text(dashboardPaneTitle(pane))
                                .font(.system(size: 13))
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
            case .selected:
                return selectedUsesHoverTone ? AnyShapeStyle(Theme.rowHover)
                                              : AnyShapeStyle(Theme.selectionPill)
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
