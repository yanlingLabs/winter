import AppKit
import SwiftUI

// MARK: - Metrics

/// panel-cef Task 6b — the URL row's metrics. **Every one of them is DERIVED**, so this row cannot
/// drift into a second visual vocabulary sitting one point below the tab row.
///
/// The row itself is `panelUrlRowHeight` (40pt), already defined by Plan A as
/// `panelChromeBandHeight - panelTitlebarBandHeight` (85 − 45). It renders INSIDE the single
/// continuous chrome band, with **no hairline between it and the tab row** — the spec's structural
/// finding, and one it says reads as visibly wrong if broken. Nothing here draws a divider; the only
/// hairline in the panel is `ShellPanel`'s, where content begins.

/// The chrome buttons wear the tab row's own 28pt rhythm (`panelExpandButtonSize`) rather than the
/// window titlebar's 26pt — the same call Plan A made for the panel's trailing cluster, and for the
/// same reason: these sit in the panel's band, not the window's.
let panelChromeButtonSize: CGFloat = panelExpandButtonSize

/// Between adjacent buttons INSIDE one cluster — the panel's existing "these belong together" gap
/// (`panelTabSpacing`), not the wider `panelNewTabButtonGap` that separates groups.
let panelChromeButtonSpacing: CGFloat = panelTabSpacing

/// Back / forward / reload, plus the leading inset that puts the first glyph on the same vertical
/// line as the first tab pill above it (`panelTabPillInset`).
let panelChromeLeadingClusterWidth: CGFloat = panelTabPillInset
    + 3 * panelChromeButtonSize
    + 2 * panelChromeButtonSpacing

/// The `⋮` overflow, plus the same trailing inset the tab row's cluster uses.
let panelChromeTrailingClusterWidth: CGFloat = panelChromeButtonSize + panelExpandButtonInset

/// PURE: the width BOTH flanks are laid out at, which is what makes the URL field literally centred
/// rather than merely centre-aligned.
///
/// The spec measures the URL row's placeholder as **centre-aligned, not leading** — but a field
/// flanked by a 3-button cluster on one side and a 1-button cluster on the other is not centred just
/// because its text is. Padding the narrower flank out to the wider one costs nothing, keeps the
/// field's midpoint on the panel's midpoint at every width, and — unlike overlaying a centred field
/// on top of the clusters — makes overlap structurally impossible instead of something a minimum
/// width has to keep preventing.
let panelChromeFlankWidth: CGFloat = max(panelChromeLeadingClusterWidth, panelChromeTrailingClusterWidth)

/// The gap between a flank and the URL field. The panel's group-separation gap, same as the one
/// between the last tab pill and "+".
let panelChromeFieldGap: CGFloat = panelNewTabButtonGap

/// The field is the tab pill's height, so the two rows share one control rhythm.
let panelChromeFieldHeight: CGFloat = panelTabPillSize.height

/// PURE: how wide the URL field renders. Not used for layout — SwiftUI's `HStack` derives it from
/// the flanks — but it is what the layout MEANS, and pinning it is what keeps this file's
/// arithmetic and the rendered row from becoming two different numbers (the same discipline
/// `panelTabPillWidth` and `PanelTabStrip`'s own frame already hold each other to).
func panelChromeFieldWidth(availableWidth: CGFloat) -> CGFloat {
    max(0, availableWidth - 2 * (panelChromeFlankWidth + panelChromeFieldGap))
}

// MARK: - The per-tab model

/// panel-cef Task 6b — one web tab's live browser state and its intents, shared by the two halves
/// of `PanelTabContent`.
///
/// It exists because Plan A's boundary hands `makeChrome()` and `makeContent()` out separately, with
/// no argument between them: the URL field lives in one subtree and the browser it describes lives
/// in another. This object is what makes them the same tab — the content half feeds it from CEF, the
/// chrome half reads it and calls its verbs.
///
/// **Live state, never persisted state.** `url` here follows same-page navigations (a `#fragment`
/// jump, `history.pushState`) because a URL field that did not would be visibly wrong. What gets
/// written to the session log is a different, deliberately narrower question, answered by
/// `onCommittedNavigation` below and bounded to committed top-level navigations only.
@MainActor
final class PanelWebTabModel: ObservableObject {
    let tabId: String

    /// The session this tab belongs to, **captured when the model is wired, not read when a
    /// navigation fires.** A user who hops sessions mid-page-load would otherwise have the report
    /// filed against whatever session was current at the instant the load finished — cross-posting
    /// one session's browsing into another's permanent log. The daemon's permissive append (an
    /// unknown tabId is an accepted no-op) makes that harmless rather than corrupting, but harmless
    /// misfiling is still misfiling, and capturing at wiring time costs one stored property.
    private(set) var sessionId: String?

    private weak var host: ShellSessionHost?

    @Published private(set) var url: String = ""
    @Published private(set) var title: String = ""
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false

    /// **The page's own icon, for the tab pill** — live presentation only: never persisted, never
    /// sent to the daemon, and dropped the moment the tab leaves the site it belongs to
    /// (`panelFaviconKey`). `nil` means the pill shows the kind's glyph.
    @Published private(set) var favicon: NSImage?
    /// Which site `favicon` belongs to — `panelFaviconKey` of the page it was downloaded for.
    private(set) var faviconKey: String?

    /// The container CEF's view is parented into — the handle every verb needs. Weak: the strong
    /// owner is `BrowserRuntime.containers` now, not SwiftUI, and a tab switched away from is
    /// DELIBERATELY kept alive by that registry — this reference must not become a second, competing
    /// owner that outlives what the runtime decides. It goes nil exactly when the runtime actually
    /// releases the container (`stop`), never merely on a tab switch.
    weak var container: PanelCEFContainerView?

    init(tabId: String) {
        self.tabId = tabId
    }

    /// Re-point the model at its host/session. Called on every render pass, so it must be
    /// idempotent and must not disturb published state.
    func bind(host: ShellSessionHost?, sessionId: String?) {
        self.host = host
        if let sessionId { self.sessionId = sessionId }
    }

    /// **What the URL FIELD shows.** A PRESENTATION filter and nothing more: `url` above stays
    /// exactly what CEF reported, what may be persisted is still `persistableNavigation`'s
    /// question, and what may be loaded is still `normalizeTypedInput`/`restorableURL`'s.
    ///
    /// It exists because the ADDRESS BAR'S DEFAULT STATE was a ~900-character percent-encoded
    /// inline document. A fresh tab loads `panelWebTabStartPageURL` — a `data:` URL — and Chromium
    /// commits it exactly like a real page, so `OnAddressChange`/`OnLoadEnd` publish it into `url`
    /// and the field displayed it. The browser's create path already seeds the DISPLAYED address as
    /// `""` when the policy refuses the URL being loaded (`BrowserRuntime.create`, which absorbed
    /// that seed from the view in browser-runtime T3); that intent was right and the live
    /// channel overwrote it one turn later. This is the same intent, held on the channel that was
    /// undoing it — and the same shape the `⋮` menu already uses, so there is ONE answer to "may
    /// this address be shown to the user", asked everywhere it is shown.
    var displayURL: String { PanelURLPolicy.isAllowed(url) ? url : "" }

    func apply(_ state: WinterCEFBrowserState) {
        apply(url: state.url, title: state.title, isLoading: state.isLoading,
              canGoBack: state.canGoBack, canGoForward: state.canGoForward)
    }

    /// The live channel, named in primitives — `apply(_:)` above is a one-line adapter onto it, so
    /// this IS the path CEF drives, not a parallel one.
    ///
    /// Split out because `WinterCEFBrowserState`'s properties are `readonly` in `WinterCEF.h` and
    /// readwrite only inside `WinterCEF.mm`: a test cannot construct a snapshot, so without this the
    /// display filter above could only be pinned in isolation from the channel that feeds it —
    /// which is precisely the "green whether or not the production path calls it" shape this branch
    /// has already produced seven times. (`CEFRuntimeTests` reaches CEF's C surface through
    /// `WinterCEFRuntime` for the same class of reason.)
    func apply(url: String, title: String, isLoading: Bool, canGoBack: Bool, canGoForward: Bool) {
        if favicon != nil, panelFaviconKey(url) != faviconKey {
            favicon = nil
            faviconKey = nil
        }
        self.url = url
        self.title = title
        self.isLoading = isLoading
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
    }

    /// An icon CEF downloaded for `pageURL` (`WinterCEFSetFaviconObserver`). Accepted only while the
    /// tab is still on that page's site — a download that lands after a navigation elsewhere would
    /// otherwise put one site's icon on another's tab. A `nil` icon changes nothing.
    func receiveFavicon(_ icon: NSImage?, forPageURL pageURL: String) {
        guard let icon, panelFaviconAccepts(pageURL: pageURL, currentURL: url) else { return }
        favicon = icon
        faviconKey = panelFaviconKey(pageURL)
    }

    /// **The producer `panel.reportNavigation` never had.** CEF has just committed a top-level
    /// navigation; this decides whether it may be written down, and files it against the session
    /// captured at wiring time.
    ///
    /// `PanelURLPolicy.persistableNavigation` is the gate: it refuses every scheme outside the
    /// `http`/`https` allowlist (which is what keeps the built-in `data:` New Tab page out of every
    /// session's history), truncates an over-long title, and DROPS an over-long URL rather than
    /// truncating it into a different, wrong address.
    func reportCommittedNavigation(url: String, title: String) {
        guard let sessionId,
              let allowed = PanelURLPolicy.persistableNavigation(url: url, title: title) else { return }
        host?.reportPanelNavigation(sessionId: sessionId, tabId: tabId,
                                    url: allowed.url, title: allowed.title)
    }

    /// **A URL the browser wants opened in a new panel tab.** Three producers reach here through
    /// the one C channel (`WinterCEFSetPopupObserver`): a popup the page asked for, a ⌘-click /
    /// middle-click / shift-click (`OnOpenURLFromTab`), and the context menu's "Open Link in New
    /// Tab". Only gestured ones reach this far. For the popup case CEF has already cancelled the
    /// popup itself (it always does — `WinterCEF.h`); for the click case it has cancelled the
    /// in-place navigation, so in both the tab is not an addition to something else happening.
    ///
    /// The name is the first producer's and is kept because the C symbol is
    /// (`WinterCEFSetPopupObserver`), not because it is the whole story.
    ///
    /// It goes through `ShellSessionHost.openPanelTab`, the app's existing tab door, rather than
    /// anywhere new: that is what runs `PanelURLPolicy.mayOpenTab` on a URL the PAGE chose — the
    /// untrusted input the policy exists for — and what makes the resulting tab daemon-minted, so a
    /// popup tab is indistinguishable downstream from one the user or the agent opened, and
    /// persists like one. A url the policy refuses opens nothing, silently; the popup was cancelled
    /// either way, so there is nothing left to undo.
    ///
    /// **Filed against the session captured at wiring time**, exactly like
    /// `reportCommittedNavigation` above and for a sharper version of the same reason: a tab is
    /// created, not merely recorded, so a session hop between the click and this call would put a
    /// real, visible tab in a session the user never browsed in. With no session captured (a model
    /// that was never bound) there is nothing to open into and this does nothing.
    func openPopupAsTab(url: String) {
        guard let sessionId, let host else { return }
        host.openPanelTab(kind: .web, url: url, sessionId: sessionId)
    }

    // MARK: Intents

    func goBack() { container.map { WinterCEFGoBack($0) } }
    func goForward() { container.map { WinterCEFGoForward($0) } }
    /// One button, two verbs — stop while loading, reload otherwise, exactly as every browser does.
    func reloadOrStop() {
        guard let container else { return }
        if isLoading { WinterCEFStopLoad(container) } else { WinterCEFReload(container) }
    }

    /// The URL field's Return key. Returns whether the input was accepted, so the field can leave
    /// refused text in place for the user to fix rather than silently swallowing it.
    @discardableResult
    func navigate(typed raw: String) -> Bool {
        // Policy first, container second — deliberately, so "refused" is attributable to the policy
        // and not to a missing browser. The two failures look identical to the caller but they are
        // not the same thing, and only the first one is a decision.
        guard let target = PanelURLPolicy.normalizeTypedInput(raw) else { return false }
        guard let container else { return false }
        WinterCEFLoadURL(container, target)
        return true
    }
}

/// The registry that makes one model per tab survive SwiftUI rebuilding its views.
///
/// `panelTabContent(for:host:)` is called afresh on every render pass and returns a value type, so a
/// model constructed there would be a NEW object each time — losing the chrome's state on every
/// keystroke elsewhere in the app, and handing the chrome and content halves two different objects.
/// Keyed by `tabId`, which is daemon-minted and stable for the tab's whole life.
@MainActor
enum PanelWebTabModels {
    private static var models: [String: PanelWebTabModel] = [:]

    static func model(for tab: PanelTab, host: ShellSessionHost?, sessionId: String?) -> PanelWebTabModel {
        let model = models[tab.tabId] ?? {
            let fresh = PanelWebTabModel(tabId: tab.tabId)
            models[tab.tabId] = fresh
            return fresh
        }()
        model.bind(host: host, sessionId: sessionId)
        return model
    }

    /// **A lookup that never MINTS one** — live-gate fix E, and the distinction is the whole reason
    /// this exists beside `model(for:host:sessionId:)` above.
    ///
    /// The tab strip renders a pill for every tab in the daemon's fold, including `.document` tabs
    /// and web tabs whose browser has never been created in this process. Asking for those through
    /// the creating accessor would put an entry in `models` for each of them — a registry of models
    /// for tabs no browser ever backed, keyed by ids nothing will ever `discard`. So the strip asks
    /// this instead: `nil` means "no browser has ever been wired for this tab here", which is
    /// exactly the condition under which the daemon's folded title is the only title there is.
    static func existing(tabId: String) -> PanelWebTabModel? { models[tabId] }

    /// Dropped when the user closes a tab (`ShellSessionHost.closePanelTab`). A tab closed by some
    /// OTHER producer — the agent, in B2 — leaves its entry behind; that is a handful of strings per
    /// tab for the life of the process, named here rather than papered over, and it is corrected the
    /// moment the app relaunches.
    static func discard(tabId: String) {
        models.removeValue(forKey: tabId)
    }

    /// Test seam only — `models` is process-global state and a test that leaves an entry behind
    /// would leak it into the next one.
    static func removeAllForTesting() {
        models.removeAll()
    }
}

// MARK: - The chrome

/// panel-cef Task 6b — the URL row: back, forward, reload/stop, the centre-aligned URL field, and
/// the `⋮` overflow. Plan A's layout sketch, rendered.
///
/// Every hover and every highlight goes through `ShellSidebarRowStyle` (via `ShellTitlebarButton`),
/// which is the app's ONE row treatment — not a second hover mechanism that happens to agree with
/// it today. No colour is written here: `Theme.rowHover` and `Theme.textMuted` are asset-catalog
/// tokens, per `docs/brand.md`'s standing rule that Swift never hardcodes a hex value for chrome.
struct PanelWebChrome: View {
    @ObservedObject var model: PanelWebTabModel

    /// The text the field is SHOWING. Separate from `model.displayURL` on purpose: while the user is
    /// typing, a page that finishes loading (or any same-page address change) must not reach in and
    /// rewrite what they are halfway through. `@FocusState` is what distinguishes the two cases, and
    /// it is why this is local `@State` rather than another `@Published` on the model.
    @State private var text: String = ""
    @FocusState private var fieldFocused: Bool
    @State private var fieldHovered = false
    /// Set when the field refuses what was typed (a `javascript:` URL, an empty box, an over-long
    /// address). It changes the field's own look rather than raising an alert — a URL bar that
    /// throws a modal at a typo would be worse than one that simply does not go anywhere.
    @State private var refused = false

    var body: some View {
        HStack(spacing: panelChromeFieldGap) {
            leadingCluster
                .frame(width: panelChromeFlankWidth, alignment: .leading)

            urlField
                .frame(maxWidth: .infinity)

            // Padded out to the leading cluster's width — see `panelChromeFlankWidth`. This is the
            // whole mechanism by which the field is centred, so the frame is load-bearing, not
            // cosmetic.
            trailingCluster
                .frame(width: panelChromeFlankWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // `displayURL`, never `url` — see its own doc. A fresh tab's committed address is the
        // built-in `data:` start page, and showing it here made the placeholder unreachable on
        // every new tab.
        .onAppear { text = model.displayURL }
        .onChange(of: model.displayURL) { _, live in
            // Never while the user is editing. Also clears a refusal: the address moved on, so the
            // rejected text is gone anyway.
            if !fieldFocused {
                text = live
                refused = false
            }
        }
    }

    private var leadingCluster: some View {
        HStack(spacing: panelChromeButtonSpacing) {
            // The app header's own arrows, not chevrons (2026-09-17).
            ShellTitlebarButton(systemImage: "arrow.left", label: "Back",
                                size: panelChromeButtonSize) { model.goBack() }
                .disabled(!model.canGoBack)

            ShellTitlebarButton(systemImage: "arrow.right", label: "Forward",
                                size: panelChromeButtonSize) { model.goForward() }
                .disabled(!model.canGoForward)

            // One control, two verbs — the glyph states which one it currently is.
            ShellTitlebarButton(systemImage: model.isLoading ? "xmark" : "arrow.clockwise",
                                label: model.isLoading ? "Stop" : "Reload",
                                size: panelChromeButtonSize) { model.reloadOrStop() }
        }
        .padding(.leading, panelTabPillInset)
    }

    private var urlField: some View {
        // **Not "Search or enter address".** This field does not search: free text with no scheme
        // becomes `https://<text>` and fails to resolve (`PanelURLPolicy.normalizeTypedInput`'s own
        // doc — which search engine a user's typing goes to, and what it learns about them, is a
        // product decision this task deliberately declined to make on their behalf). A placeholder
        // advertising a feature that was not built is worse than a narrower true one.
        let state = panelAddressFieldState(focused: fieldFocused, hovered: fieldHovered, text: text)
        let host = state == .editing ? nil : panelAddressDisplayHost(text)
        return TextField("Enter a web address", text: $text,
                         prompt: Text("Enter a web address").foregroundStyle(Theme.textMuted))
            .textFieldStyle(.plain)
            .font(Typography.control())
            // ChatGPT's field (2026-09-17), three states: at REST just the site, centred, on no
            // fill; on HOVER the filled field with its page-menu and ↗ icons; while EDITING the
            // full address, leading-aligned, with a hairline rim. The resting/hovered host is an
            // overlay that lets clicks through to the field underneath, which keeps its text but
            // draws it clear so the two never overlap.
            .foregroundStyle(refused ? AnyShapeStyle(.red) : AnyShapeStyle(Theme.textPrimary))
            // Faded rather than recoloured so the swap can animate; never fully 0, which would
            // stop the field underneath taking the click.
            .opacity(host != nil ? 0.001 : 1)
            .overlay {
                if let host {
                    Text(host)
                        .font(Typography.control())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                        .transition(.blurReplace)
                }
            }
            .focused($fieldFocused)
            .onSubmit {
                refused = !model.navigate(typed: text)
                if !refused { fieldFocused = false }
            }
            .onChange(of: text) { _, _ in refused = false }
            .padding(.leading, state == .hovered ? panelChromeButtonSize + 4 : panelTabPillInset)
            .padding(.trailing, panelChromeButtonSize + 4)
            .frame(height: panelChromeFieldHeight)
            .background(
                RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                    .fill(state == .rest ? Color.clear : Theme.chromeHover)
            )
            .overlay(
                RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                    .strokeBorder(state == .editing ? Theme.hairlineElevated : Color.clear, lineWidth: 1)
            )
            // Hover only: the page menu at the leading edge (ChatGPT's sliders glyph).
            .overlay(alignment: .leading) {
                if state == .hovered {
                    Menu {
                        pageMenuItems
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(Typography.label())
                            .foregroundStyle(Theme.textMuted)
                            .frame(width: panelChromeButtonSize, height: panelChromeButtonSize)
                            .contentShape(Rectangle())
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .padding(.leading, 4)
                    .transition(.opacity.combined(with: .scale(scale: 0.85)))
                    .help("Page")
                    .accessibilityLabel("Page")
                }
            }
            // REMOVED 2026-09-18 — the ↗ "Open in Default Browser" button that used to sit here.
            //
            // It was a 28×28 hit area overlaid on the trailing end of the address field, appearing
            // on hover and staying through editing. The field's own `TextField` still owned that
            // region, and the overlay came later in the modifier chain, so the overlay won
            // hit-testing: a click in the last 28 pt of the field — the natural place to click to
            // focus a long URL, or to put the caret after the text you are already editing — launched
            // Safari on the COMMITTED url. That is the "sometimes it spawns detached browser
            // windows" the user reported: not CEF opening a window, our own button opening another
            // application, from under the caret.
            //
            // The capability is not lost: "Open in Default Browser" is in the leading page menu and
            // in the trailing ⋮ menu, which is where it lived before it was promoted here. A control
            // that launches another app must not sit inside a text field's frame.
            .onHover { fieldHovered = $0 }
            // The three looks cross-fade instead of snapping (2026-09-17).
            .animation(.smooth(duration: 0.22), value: state)
            .accessibilityLabel("Address")
    }

    /// The page actions both menus offer (the field's sliders menu and the trailing ⋮).
    @ViewBuilder
    private var pageMenuItems: some View {
        Button("Copy Link") {
            guard PanelURLPolicy.isAllowed(model.url) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(model.url, forType: .string)
        }
        .disabled(!PanelURLPolicy.isAllowed(model.url))
        Button("Open in Default Browser", action: openInDefaultBrowser)
            .disabled(!PanelURLPolicy.isAllowed(model.url))
    }

    private func openInDefaultBrowser() {
        guard PanelURLPolicy.isAllowed(model.url), let url = URL(string: model.url) else { return }
        NSWorkspace.shared.open(url)
    }

    private var trailingCluster: some View {
        Menu {
            pageMenuItems
        } label: {
            // ChatGPT's vertical ⋮ (SF Symbols has no vertical ellipsis — the horizontal one, turned).
            Image(systemName: "ellipsis")
                .rotationEffect(.degrees(90))
                .font(Typography.control(.medium))
                .foregroundStyle(Theme.textMuted)
                .frame(width: panelChromeButtonSize, height: panelChromeButtonSize)
                .contentShape(Rectangle())
        }
        // `.button` + a SwiftUI button style renders the label as a SwiftUI view — the borderless
        // menu style draws its own NSButton image and ignored the rotation.
        .menuStyle(.button)
        .buttonStyle(ShellChromeButtonStyle())
        .menuIndicator(.hidden)
        .frame(width: panelChromeButtonSize, height: panelChromeButtonSize)
        .help("More")
        .accessibilityLabel("More")
        .padding(.trailing, panelExpandButtonInset)
    }
}

/// PURE: the site a page icon belongs to — the displayed host (`panelAddressDisplayHost`, so
/// `www.` and the bare domain are one site), for `http`/`https` pages only. `nil` for everything
/// else, the built-in `data:` start page included, which is how that page never wears an icon.
func panelFaviconKey(_ url: String) -> String? {
    guard let scheme = URL(string: url.trimmingCharacters(in: .whitespaces))?.scheme?.lowercased(),
          scheme == "http" || scheme == "https" else { return nil }
    return panelAddressDisplayHost(url)?.lowercased()
}

/// PURE: may an icon downloaded for `pageURL` be shown on a tab now at `currentURL`? Only when both
/// are the same (web) site.
func panelFaviconAccepts(pageURL: String, currentURL: String) -> Bool {
    guard let key = panelFaviconKey(pageURL) else { return false }
    return key == panelFaviconKey(currentURL)
}

/// PURE: what the address field shows at rest — the page's host without a leading `www.`, or `nil`
/// (no host: an empty field, a refused scheme, free text) so the field shows its own text instead.
func panelAddressDisplayHost(_ address: String) -> String? {
    guard let host = URL(string: address.trimmingCharacters(in: .whitespaces))?.host(),
          !host.isEmpty else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
}

/// The address field's three looks (ChatGPT, 2026-09-17).
enum PanelAddressFieldState: Equatable {
    /// Just the site, centred, no fill.
    case rest
    /// The filled field with its page-menu and ↗ icons.
    case hovered
    /// The full address, leading-aligned, filled and rimmed.
    case editing
}

/// PURE: which look the field wears — the pointer and focus decide, never the contents: an empty
/// field at rest is bare too, showing only its placeholder (ChatGPT's fresh tab).
func panelAddressFieldState(focused: Bool, hovered: Bool, text _: String) -> PanelAddressFieldState {
    if focused { return .editing }
    if hovered { return .hovered }
    return .rest
}
