import AppKit
import SwiftUI

/// panel-shell T2: MEASURED from the reference at @2x (halve pixels for points). The tab row and
/// the URL row share ONE continuous band — there is no hairline between them, and adding one reads
/// as visibly wrong. The only hairline is where content begins.
let panelChromeBandHeight: CGFloat = 85

/// panel-shell T8: MEASURED at @2x from the reference
/// (docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png).
let panelTabPillSize = CGSize(width: 156, height: 28)
let panelTabPillInset: CGFloat = 9

/// panel-shell T13: SQUARED, not a capsule — matches the app's ONE hover/selection vocabulary
/// (`shellSidebarRowCornerRadius`, `ShellSidebar.swift`), which already governs every sidebar row
/// and every titlebar button (`ShellTitlebarButton` wears `ShellSidebarRowStyle` at that radius).
/// Derived rather than a second `6` literal, so the pill's highlight and the rest of the app's
/// rounded-rects can never drift into two different radii for what reads as one visual language.
/// Was `panelTabPillSize.height / 2` (a capsule, 14) until the user's live gate asked for square.
let panelTabPillRadius: CGFloat = shellSidebarRowCornerRadius

/// The gap from the LAST pill to the "+" button — the only adjacency the reference has anything to
/// measure, since it shows exactly one tab. `panelTabSpacing` below is the other, unmeasured, gap.
let panelNewTabButtonGap: CGFloat = 18

/// panel-shell T13: between ADJACENT tabs. NOT the measured 18pt above — a controller choice (not
/// a measurement: the reference's one tab has no tab-to-tab gap to measure), tighter than the
/// pill->"+" distance so a run of tabs reads as one group sitting apart from "+". Easy to change if
/// a denser strip makes a different value obviously better.
let panelTabSpacing: CGFloat = 6

/// The close control's hit box, and how far its trailing edge sits from the pill's. Measured at the
/// 2026-08-09 live gate as visibly loose at 15pt — the user asked for it tighter.
let panelTabCloseBoxSize: CGFloat = 16
let panelTabCloseInset: CGFloat = 8

/// Where the label must stop so it never runs under the close control, which is an OVERLAY and so
/// does not reserve its own space. DERIVED from the two constants above plus one pill-inset of
/// breathing room, rather than a hand-tuned literal that has to be re-tuned whenever either moves.
let panelTabLabelTrailingInset: CGFloat = panelTabCloseInset + panelTabCloseBoxSize + panelTabPillInset

/// panel-shell T10: the pill's width above is a MAXIMUM, not a fixed rendered width — tabs
/// compress below it as more open, so the strip always fits inside the panel (`panelTabPillWidth`
/// below is the formula). Below THIS floor there is nothing left to shrink: the label truncates to
/// nothing and only the favicon and close control remain legible, and the strip scrolls instead.
let panelTabPillMinWidth: CGFloat = 64

/// panel-shell T10: the panel's own trailing cluster (expand / bottom-bar placeholder / sidebar
/// toggle) — three `panelExpandButtonSize` buttons, the two gaps between them, and its own
/// trailing inset. `trailingButtonCluster` below wears this SAME constant as an explicit
/// `.frame(width:)`, so this and the cluster's actual rendered content can never silently measure
/// two different numbers for the same three buttons.
///
/// This supersedes Task 8's `102pt` reservation (`shellTitlebarTrailingInset + 3 *
/// shellTitlebarButtonSize + 2 * shellTitlebarClusterSpacing`) — that borrowed the MAIN titlebar's
/// 26pt buttons as its best available guess before this task built the real ones, which turned out
/// to want the tab row's own 28pt rhythm (`panelExpandButtonSize`) instead.
let panelTrailingClusterWidth: CGFloat = 3 * panelExpandButtonSize
    + 2 * shellTitlebarClusterSpacing
    + panelExpandButtonInset

/// PURE: the width one pill renders at, given how many tabs are open and how much width the strip
/// has to lay them out in — capped at `panelTabPillSize.width`, floored at `panelTabPillMinWidth`.
/// Every pill shares whatever is left after the fixed overhead:
///   - the leading inset (`panelTabPillInset`)
///   - panel-shell T13: `(tabCount - 1)` gaps of `panelTabSpacing` BETWEEN pills — zero for a
///     single tab, which is why splitting this out changes nothing for `tabCount == 1`
///   - one `panelNewTabButtonGap`, the LAST pill to the "+" button
///   - the "+" button itself (`panelTabPillSize.height` square)
///   - one more `panelNewTabButtonGap` — `PanelTabStrip`'s OUTER `HStack` spacing, between the
///     scrollable group's own frame and the trailing cluster. Unrelated to tab-to-tab spacing (it
///     separates the scroll box from the cluster, not one pill from another), so T13's split does
///     NOT touch this term — it stays the measured pill->"+" figure, same as before T13.
///   - the trailing cluster (`panelTrailingClusterWidth`)
/// `PanelTabStrip`'s own layout below uses the IDENTICAL named constants for every one of these
/// terms, so this function's answer and what actually renders can never drift apart. In particular
/// the `ScrollView`'s own `.frame(width:)` subtracts exactly the LAST two terms (the outer gap and
/// the cluster) from `availableWidth` — the first three terms are spent INSIDE that frame, on the
/// pills themselves — which is what keeps the two subtractions equal by construction rather than by
/// two call sites agreeing to use the same numbers. (`testTabPillWidthAtTwoTabsUsesTheSplitGapArithmetic`
/// pins the arithmetic itself; this comment is the proof the two sides still agree.)
///
/// Always returns a value — even floored, this never "fails". Below the floor there is nothing
/// left for THIS function to do; `PanelTabStrip`'s own `ScrollView` is what takes over from there.
func panelTabPillWidth(tabCount: Int, availableWidth: CGFloat) -> CGFloat {
    guard tabCount > 0 else { return panelTabPillSize.width }
    let overhead = panelTabPillInset
        + CGFloat(tabCount - 1) * panelTabSpacing
        + 2 * panelNewTabButtonGap
        + panelTabPillSize.height
        + panelTrailingClusterWidth
    let share = (availableWidth - overhead) / CGFloat(tabCount)
    return min(panelTabPillSize.width, max(panelTabPillMinWidth, share))
}

/// panel-shell T8: the window's top band, SHARED by every column — the panel's slice of it holds
/// the tab strip, at the window top, level with the traffic lights (not below a titlebar). See
/// `ShellPanel`'s `.ignoresSafeArea` for what makes that literally true rather than aspirational.
let panelTitlebarBandHeight: CGFloat = 45

/// The rest of the chrome band, below the tab strip: the URL row. panel-cef Task 6b fills it with
/// `PanelWebChrome` for a `.web` tab (blank for every other kind, which has no browser chrome).
/// Still no hairline between the two rows; see `panelChromeBandHeight`'s own doc comment.
let panelUrlRowHeight: CGFloat = panelChromeBandHeight - panelTitlebarBandHeight

/// The panel mirrors the detail card: that card rounds its LEADING corners, this rounds its
/// TRAILING ones. Derived, so the two can never drift apart.
let panelCornerRadius: CGFloat = shellDetailCardCornerRadius

let panelDividerWidth: CGFloat = shellSidebarHairlineWidth

/// The panel's rounded shape — trailing corners only, for the reason above.
let panelShape = UnevenRoundedRectangle(
    topLeadingRadius: 0,
    bottomLeadingRadius: 0,
    bottomTrailingRadius: panelCornerRadius,
    topTrailingRadius: panelCornerRadius,
    style: .continuous
)

/// The panel column. Owns the chrome band and the content area. panel-shell T8 fills the chrome
/// band's top 45pt (`panelTitlebarBandHeight`) with the tab strip; panel-cef Task 6b fills the rest
/// of the band (`panelUrlRowHeight`) with the shown tab's own chrome, and Task 6a filled the
/// per-kind content slot below the hairline — for `.web`, a real Chromium browser.
struct ShellPanel: View {
    @ObservedObject var store: PanelStore
    /// panel-shell T10: the shared mode/width state. This view both READS it (the expand button's
    /// glyph/label, which side of `.maximized` it currently is) and MUTATES it (the expand and
    /// sidebar-toggle buttons in its own trailing cluster, `PanelTabStrip.trailingButtonCluster`),
    /// so it needs a binding, not a value. `ShellSidebar.swift` owns the source of truth
    /// (`@State private var presentation`) and passes `$presentation` down at its one call site.
    @Binding var presentation: PanelPresentation
    /// `nil` for a shell built without one (`ShellSidebar`'s own `host` property takes the
    /// identical fallback posture) — the strip's controls then fire nothing (each host method's
    /// own `attachedSessionId`/`managementClient` guard).
    var host: ShellSessionHost? = nil
    /// panel-shell T12: the navigate door for `openPanelTab`'s auto-create path — `+` with no
    /// attached session creates a session and needs to land the shell ON it (`ShellRootView`'s own
    /// `nav`, threaded down here the SAME way `NewChatPage(nav: nav, host: host)` already gets it
    /// for the identical create-then-navigate shape). Plain, not `@ObservedObject`: this view never
    /// needs to re-render off `nav`'s state — it reads `nav.destination` once, imperatively, at the
    /// moment "+" is tapped (panel-shell T15: to choose bind vs. navigate), and otherwise only calls
    /// `navigate(to:)`. `nil` for a shell built without one (same fallback posture as `host`) — the
    /// auto-created session still exists on the daemon; only the UI's navigation onto it is skipped.
    ///
    /// panel-shell T15: on `.newChat` specifically, "+" no longer reads this navigate door at all —
    /// it calls `host.openPanelTabForNewChatPage` instead, which binds without navigating so the
    /// page's draft survives (`onOpenTab` below). Every OTHER destination's auto-create still
    /// navigates through here, unchanged.
    var nav: ShellNavigationModel? = nil

    /// panel-cef Task 6a: which tab the panel actually SHOWS — `nil` only when there are no tabs at
    /// all. One lookup, read by both slots below, so the chrome row and the content area can never
    /// disagree about which tab they are rendering. The rule (and why it is not simply
    /// `activeTabId`) lives with the pure function it delegates to, `panelShownTab`.
    private var shownTab: PanelTab? {
        panelShownTab(tabs: store.tabs, activeTabId: store.activeTabId)
    }

    private var activeTabContent: PanelTabContent? {
        shownTab.map { panelTabContent(for: $0, host: host, sessionId: host?.panelSessionId) }
    }

    var body: some View {
        VStack(spacing: 0) {
            // The chrome band: one continuous surface, no internal divider. Two vertical slices —
            // the tab strip (top `panelTitlebarBandHeight`) and Plan B's blank URL row below it —
            // but still ONE surface: nothing here draws a line between them.
            VStack(spacing: 0) {
                PanelTabStrip(
                    store: store,
                    // panel-cef Task 6b: the strip highlights the tab the panel is actually
                    // SHOWING, not `store.activeTabId` directly. The two are the same in the
                    // ordinary case now that `panel.openTab` activates what it opens — but they
                    // diverge for a session written before that (an open tab that was never
                    // activated) and for the instant after the ACTIVE tab is closed, where
                    // `foldPanelTabs` clears `activeTabId` by design. Deriving both from one lookup
                    // is what retires Task 6a's named cost: "the shown tab is not the highlighted
                    // one" cannot happen, because there is only one answer to which tab that is.
                    shownTabId: shownTab?.tabId,
                    presentation: $presentation,
                    onOpenTab: {
                        // panel-shell T15: the new-chat page's own "+" BINDS rather than navigating
                        // (user ruling — the page's draft must survive). Every OTHER "+", including
                        // auto-create from any other landing with nothing attached, keeps Task 12's
                        // create-then-navigate behavior verbatim (`ShellSessionHost.openPanelTab`'s
                        // own doc: `onSessionCreated` fires ONLY on that auto-create path).
                        if nav?.destination == .newChat {
                            host?.openPanelTabForNewChatPage(kind: .web)
                        } else {
                            host?.openPanelTab(kind: .web) { sessionId in
                                nav?.navigate(to: .session(sessionId))
                            }
                        }
                    },
                    onActivateTab: { tabId in host?.activatePanelTab(tabId) },
                    onCloseTab: { tabId in host?.closePanelTab(tabId) }
                )
                .frame(height: panelTitlebarBandHeight)

                // panel-cef Task 6a wired the shown tab's own chrome slot; Task 6b FILLED it. A
                // `.web` tab renders `PanelWebChrome` here — back / forward / reload-or-stop, the
                // centred URL field, the `⋮` overflow — inside the same 85pt band as the tab strip
                // above, with no hairline between them (`PanelWebChrome`'s own metrics doc). Every
                // other kind still renders `Color.clear` (`PanelPlaceholderTab.makeChrome`), which
                // is the blank row Plan A drew.
                Group {
                    if let content = activeTabContent {
                        content.makeChrome()
                    } else {
                        Color.clear
                    }
                }
                .frame(height: panelUrlRowHeight)
            }
            .frame(height: panelChromeBandHeight)

            Divider()
                .frame(height: panelDividerWidth)
                .overlay(Theme.hairline)

            // panel-cef Task 6a: the content slot Plan A left as `Color.clear`. `.id(tabId)` is
            // load-bearing rather than tidy — it is what makes SwiftUI dismantle one tab's
            // `PanelCEFView` and build the next tab's, instead of reusing a single representable
            // and silently leaving the first tab's browser parented in the visible container.
            Group {
                if let tab = shownTab, let content = activeTabContent {
                    content.makeContent().id(tab.tabId)
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        // review round 2, Important 2 (Task 2, plan-mandated fix, adjudicated by the user): a
        // BACKGROUND LAYER that ignores the safe area, not a clip on the content — `ShellSidebar
        // .swift` documents the trap this avoided on `detail`'s own card. That fix was correct for
        // the SHAPE (the corners reach the true window edge) but, carried into Task 8
        // (`.superpowers/sdd/2026-08-08-panel-shell-a-frame-and-tab-state/progress.md`, "Task 2:
        // CARRY TO TASK 8"), incomplete for the CONTENT: the background ignored the top safe area
        // while this VStack did not, so the chrome band still rendered ~28pt below the true window
        // top and every metric above measured from the wrong origin.
        //
        // Task 8 supersedes that treatment with the one `ShellSidebar` itself uses for its own
        // pane (`ShellSidebar.swift`, its `.background(...).ignoresSafeArea(.container, edges:
        // .top)` chained directly on the pane's content, not nested inside the background
        // closure): the background loses its OWN internal `.ignoresSafeArea()` and instead
        // `.ignoresSafeArea(.container, edges: .top)` is chained AFTER `.background` below, so it
        // applies to the composite (this VStack plus the shape attached to it), not the shape
        // alone. That is required now, not merely tidy — the user's reference decision for this
        // task (docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png) puts the tab
        // strip's pill AT the window top, level with the traffic lights, and every measured offset
        // in `PanelTabStrip` below is taken from that same top edge.
        //
        // `Theme.cardSurface` IS `Color("CardSurface")` (see `Theme.swift`) — going through the
        // named layer rather than a raw asset lookup, matching every other consumer of it in
        // `ShellSidebar.swift`.
        .background {
            panelShape
                .fill(Theme.cardSurface)
        }
        .ignoresSafeArea(.container, edges: .top)
    }
}

// MARK: - panel-shell T8: the tab strip

/// The chrome band's top 45pt (`panelTitlebarBandHeight`) — every open tab as a pill, then `+`,
/// then panel-shell T10's own trailing cluster (expand / bottom-bar placeholder / sidebar toggle).
/// Tabs come from `PanelStore` (Task 7): this view only ever READS `store.tabs`/`store
/// .activeTabId` and reports taps outward through its three closures — see the type's own doc
/// below for why it never mutates the store itself.
///
/// panel-shell T10: the tabs+`+` group is WIDTH-LIMITED to whatever is left after the trailing
/// cluster (`panelTrailingClusterWidth`) and its own leading gap — a plain `HStack` has no notion
/// of "shrink these children but not those", so this reads its own width via `GeometryReader` and
/// computes the shared pill width itself (`panelTabPillWidth`) rather than leaving it to SwiftUI's
/// layout to guess. Wrapping that group in a `ScrollView` is what absorbs the case compression
/// alone cannot solve — enough tabs that even the floor (`panelTabPillMinWidth`) does not fit:
/// `panelTabPillWidth` still returns a (floored) value, the content built from it overflows the
/// fixed frame below, and the `ScrollView` simply scrolls rather than clipping or overlapping the
/// cluster. When content is narrower than the frame (the common case) nothing scrolls — the
/// content just sits left-aligned with blank space before the cluster, exactly like a browser tab
/// bar with room to spare.
struct PanelTabStrip: View {
    @ObservedObject var store: PanelStore
    /// panel-cef Task 6b: which tab is HIGHLIGHTED — the one the panel renders, passed in rather
    /// than re-derived here, so the strip and the content slot can never disagree.
    ///
    /// **Required, deliberately.** It carried a `= nil` default, justified as "for the direct-
    /// construction call sites in tests" — there are none: `PanelTabStrip` is constructed in
    /// exactly one place, which already passes this. A defaulted `nil` bought nothing and cost the
    /// compiler's help, since a future call site that forgot it would silently highlight NOTHING,
    /// which reads as a broken tab strip rather than as a missing argument.
    ///
    /// **`let`, not `var`, and that is the whole mechanism** (measured, not assumed): Swift's
    /// memberwise initializer gives a `var` of OPTIONAL type an implicit `nil` default, so simply
    /// deleting `= nil` would have changed nothing at all — the omission would still compile. Only
    /// a `let` optional is a required parameter. Turning this back into a `var` silently re-opens
    /// the hole. The closures below keep their defaults on purpose: omitting a callback is a real
    /// choice (a strip that reports no taps); omitting the shown tab is not.
    let shownTabId: String?
    @Binding var presentation: PanelPresentation
    var onOpenTab: () -> Void = {}
    var onActivateTab: (String) -> Void = { _ in }
    var onCloseTab: (String) -> Void = { _ in }

    var body: some View {
        GeometryReader { geo in
            let pillWidth = panelTabPillWidth(tabCount: store.tabs.count, availableWidth: geo.size.width)

            HStack(spacing: panelNewTabButtonGap) {
                ScrollView(.horizontal, showsIndicators: false) {
                    // panel-shell T13: `spacing:` here is the TAB-TO-TAB gap (`panelTabSpacing`,
                    // tighter than the pill->"+" distance). SwiftUI's `HStack` has no per-pair
                    // spacing, so the one gap that must stay at `panelNewTabButtonGap` — the LAST
                    // pill to "+" — is made up on `newTabButton`'s own leading edge below instead
                    // of by a second `spacing:`.
                    HStack(spacing: panelTabSpacing) {
                        ForEach(store.tabs) { tab in
                            PanelTabPill(
                                tab: tab,
                                width: pillWidth,
                                isActive: tab.tabId == shownTabId,
                                onActivate: { onActivateTab(tab.tabId) },
                                onClose: { onCloseTab(tab.tabId) }
                            )
                        }
                        newTabButton
                            // Zero tabs: "+" sits right after the leading inset, exactly as before
                            // T13 — there is no preceding pill for `panelNewTabButtonGap` to be
                            // measured FROM, so applying this unconditionally would shift "+" on a
                            // fresh, empty panel for no reason.
                            .padding(.leading, store.tabs.isEmpty ? 0 : panelNewTabButtonGap - panelTabSpacing)
                    }
                    .padding(.leading, panelTabPillInset)
                }
                // The scrollable group's own fixed frame — everything else on this line
                // (`panelNewTabButtonGap` before the cluster, then the cluster itself) is fixed
                // width, so this is geometry's whole width minus theirs. `panelTabPillWidth` above
                // is computed against this SAME subtraction (its own `overhead`), which is what
                // keeps "how much room the pills get" and "how much room this frame grants them"
                // from ever being two different numbers.
                //
                // review round 1, Minor 6: `max(0, …)` — steady state never goes negative (the
                // panel's own minimum width is well above `panelTrailingClusterWidth`), but a
                // `GeometryReader`'s FIRST layout pass can report `size.width == 0` before its real
                // size is known, and an un-guarded `.frame(width: -126)` is SwiftUI console noise
                // for one frame rather than a real bug — cheap to close off regardless.
                //
                // review round 1, Minor 7: explicit `height:` alongside `width:` — this is the
                // outer `HStack`'s only child without a fixed cross-axis size (`trailingButtonCluster`
                // is already exactly `panelTabPillSize.height` tall via its own three
                // `panelExpandButtonSize` buttons), so leaving it to size itself risked the two
                // trailing elements centring a few points apart rather than sharing one line.
                .frame(width: max(0, geo.size.width - panelNewTabButtonGap - panelTrailingClusterWidth),
                       height: panelTabPillSize.height, alignment: .leading)

                trailingButtonCluster
            }
            .padding(.top, panelTabPillInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var newTabButton: some View {
        Button(action: onOpenTab) {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .frame(width: panelTabPillSize.height, height: panelTabPillSize.height)
                .contentShape(Rectangle())
        }
        // panel-shell T13 follow-up: the same hover treatment every tab and every titlebar button
        // wears. `ShellSidebarRowStyle` renders a BACKGROUND behind the label, not padding around
        // it, so the 28pt footprint `panelTabPillWidth`'s overhead arithmetic assumes is unchanged.
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .help("New tab")
        .accessibilityLabel("New tab")
    }

    /// panel-shell T10: the panel's own trailing cluster — moved out of the window's titlebar the
    /// moment the panel opens (`ShellSidebar.swift`'s own trailing overlay renders only
    /// `circle.dashed`, and only while `.side`, once a panel is showing — see its doc comment for
    /// the other half of this move and why `.maximized` renders neither). Same order the user's
    /// layout sketch settled on: expand, the still-cut bottom bar, the sidebar toggle. Every button
    /// wears `panelExpandButtonSize` — the tab row's own 28pt rhythm, not the main titlebar's
    /// 26pt — via `ShellTitlebarButton`'s `size` parameter, which every OTHER call site in the app
    /// leaves at its default, so nothing already on screen changes.
    ///
    /// The explicit trailing `.frame(width:)` matches `panelTrailingClusterWidth`'s own derivation
    /// exactly (three `panelExpandButtonSize` buttons, two `shellTitlebarClusterSpacing` gaps, one
    /// `panelExpandButtonInset`) — an intentional no-op today, and what makes that constant's own
    /// doc comment ("can never measure two different numbers") an enforced property rather than a
    /// hopeful one: a future change to this HStack that forgets to update the constant would clip
    /// or misalign visibly, not drift silently.
    private var trailingButtonCluster: some View {
        HStack(spacing: shellTitlebarClusterSpacing) {
            ShellTitlebarButton(
                systemImage: panelExpandButtonSystemImage(mode: presentation.mode),
                label: panelExpandButtonLabel(mode: presentation.mode),
                size: panelExpandButtonSize,
                isOn: presentation.mode == .maximized
            ) {
                withAnimation(.snappy) { presentation.toggleMaximized() }
            }

            ShellTitlebarButton(
                systemImage: "dock.rectangle",
                label: shellTitlebarTrailingLabel("dock.rectangle"),
                isPlaceholder: true,
                size: panelExpandButtonSize
            )

            ShellTitlebarButton(
                systemImage: "sidebar.right",
                // Always "Hide panel" — this instance only ever renders while the panel IS
                // showing (`presentation.mode != .hidden`), unlike the titlebar's own copy of
                // this glyph, which still needs both labels and the too-narrow-window caveat.
                label: "Hide panel",
                size: panelExpandButtonSize
            ) {
                withAnimation(.snappy) { presentation.toggleVisible() }
            }
        }
        .padding(.trailing, panelExpandButtonInset)
        .frame(width: panelTrailingClusterWidth, alignment: .trailing)
    }
}

/// One tab pill. The ACTIVE tab stays filled and, since panel-shell T13, an INACTIVE tab also
/// fills on hover — both through `ShellSidebarRowStyle` (see the `.buttonStyle` below), both
/// landing on `Theme.rowHover` (the brief's "RowHover register"; that style's
/// `selectedUsesHoverTone` is what makes selection use the same token as hover here instead of
/// `SelectionPill`). "Filled" therefore always means the same fill regardless of which of the two
/// reasons caused it. Every offset below is measured from the PILL's own leading or trailing edge
/// (the brief's "+9.5pt from the pill's leading edge" etc.), not from a neighbouring element, which
/// is why each piece is positioned by its own absolute padding inside a leading-aligned `ZStack`
/// (favicon, label) or a trailing `.overlay` (the close button) rather than by `HStack` spacing.
///
/// panel-shell T10: `width` is `PanelTabStrip`'s computed `panelTabPillWidth`, not always
/// `panelTabPillSize.width` — the favicon/label/close offsets above are still absolute from the
/// pill's own edges, unchanged, so as `width` shrinks toward `panelTabPillMinWidth` the label's own
/// available room (`width - 33 - 30`) shrinks with it and truncates first; the favicon and close
/// control, both anchored to an edge rather than sized from the middle, stay legible longest —
/// exactly the degradation `panelTabPillMinWidth`'s own doc comment describes.
///
/// **Fires two RPCs, applies neither locally.** Both closures only report the tap outward
/// (`onActivate`/`onClose`); see `ShellSessionHost`'s panel-tab-strip section for why they end at
/// the wire and never touch `PanelStore` themselves.
private struct PanelTabPill: View {
    let tab: PanelTab
    let width: CGFloat
    let isActive: Bool
    let onActivate: () -> Void
    let onClose: () -> Void

    var body: some View {
        Button(action: onActivate) {
            ZStack(alignment: .leading) {
                Image(systemName: panelTabFaviconSystemImage(tab.kind))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.leading, 9.5)
                Text(panelTabDisplayTitle(tab))
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 33)
                    // DERIVED from the close button's own inset and box below, so tightening one
                    // can never leave the label running under the other.
                    .padding(.trailing, panelTabLabelTrailingInset)
            }
            .frame(width: width, height: panelTabPillSize.height, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: panelTabPillRadius, style: .continuous))
        }
        // panel-shell T13: the app's ONE row treatment, not a second hover mechanism beside it —
        // same pure fill decision (`shellSidebarRowFill`), same `@State isHovered` + `.onHover`,
        // same `shellSidebarRowCornerRadius` background every sidebar row and titlebar button
        // renders through. `selectedUsesHoverTone: true` is the sole, named deviation: it swaps
        // WHICH token `.selected` resolves to (`RowHover` here, not `SelectionPill`), because the
        // plan's Global Constraints assign panel tabs the `RowHover` token specifically. Passing
        // `isSelected: isActive` into the style UNCHANGED would have silently repainted the active
        // tab `SelectionPill` — a recolor this task never asked for — which is why this is a
        // one-flag generalization of the shared style rather than either that silent recolor or a
        // hand-rolled fill block living beside it that happens to agree only because both target
        // the same color today.
        .buttonStyle(ShellSidebarRowStyle(isSelected: isActive, selectedUsesHoverTone: true))
        .overlay(alignment: .trailing) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
                    .frame(width: panelTabCloseBoxSize, height: panelTabCloseBoxSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, panelTabCloseInset)
            .accessibilityLabel("Close \(panelTabDisplayTitle(tab))")
        }
        .help(panelTabDisplayTitle(tab))
        .accessibilityLabel(panelTabDisplayTitle(tab))
    }
}

/// A placeholder favicon keyed off the tab's kind, not a fetched site icon — Plan A never loads
/// real content (a page's own favicon is Plan B/CEF's), so the kind is the only signal there is.
/// Exhaustive on purpose, no `default:` — `PanelTabKind`'s own doc comment (`PanelTab.swift`)
/// explains why a future case must fail this to compile rather than fall back silently.
func panelTabFaviconSystemImage(_ kind: PanelTabKind) -> String {
    switch kind {
    case .web: return "globe"
    case .document: return "doc.text"
    case .code: return "chevron.left.forwardslash.chevron.right"
    case .note: return "note.text"
    }
}

/// A tab's display title before the daemon has reported one (`panel_tab_navigated` hasn't landed
/// yet, or never will for a non-web kind) — never a blank pill. Same exhaustiveness discipline as
/// `panelTabFaviconSystemImage` above.
func panelTabDisplayTitle(_ tab: PanelTab) -> String {
    if let title = tab.title, !title.isEmpty { return title }
    switch tab.kind {
    case .web: return "New Tab"
    case .document: return "Document"
    case .code: return "Code"
    case .note: return "Note"
    }
}

/// The draggable divider. Dragging CLAMPS — it never promotes to `.maximized`.
struct PanelDivider: View {
    @Binding var width: CGFloat
    let contentWidth: CGFloat

    /// `DragGesture.Value.translation` is the CUMULATIVE offset since the gesture began, not a
    /// per-event delta — SwiftUI's own contract for it. Recomputing against the live `width`
    /// binding on every event (as opposed to the width the drag STARTED from) would re-subtract
    /// that same growing cumulative translation on top of an already-shifted base each time,
    /// compounding into a runaway drag (a 10 pt mouse move would not move the divider 10 pt, and
    /// the error would grow with every event the gesture fires). Anchoring on the first event of
    /// each gesture and clearing on release keeps every computation relative to ONE fixed base.
    @State private var dragStartWidth: CGFloat?

    var body: some View {
        Rectangle()
            .fill(Theme.hairline)
            .frame(width: panelDividerWidth)
            .contentShape(Rectangle().inset(by: -4))   // a 1pt line is not a grabbable target
            .onHover { $0 ? NSCursor.resizeLeftRight.push() : NSCursor.pop() }
            .gesture(
                DragGesture(coordinateSpace: .global)
                    .onChanged { value in
                        // review round 2, Important 1: anchor on the CLAMPED (on-screen) width,
                        // not the raw stored `width`. `width` can be stale relative to the
                        // current `contentWidth` — e.g. after the window narrows without a drag
                        // happening — and `ShellPanel`'s own render already clamps on read
                        // (`ShellSidebar.swift`), so anchoring on the unclamped value would start
                        // the drag from a point that is not where the divider is actually drawn,
                        // making it dead until a compensating drag closes the gap.
                        let base = dragStartWidth ?? panelClampWidth(width, contentWidth: contentWidth)
                        dragStartWidth = base
                        width = panelClampWidth(base - value.translation.width,
                                                contentWidth: contentWidth)
                    }
                    .onEnded { _ in
                        dragStartWidth = nil
                    }
            )
    }
}
