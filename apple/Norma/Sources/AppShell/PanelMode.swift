import SwiftUI

/// panel-shell T1: the panel's presentation. NOT a `Bool` — `.maximized` covers the detail column
/// entirely, which is a layout change rather than a visibility change.
enum PanelMode: String, Equatable, Codable {
    case hidden
    case side
    case maximized
}

/// Default `.side` width. Deliberately NOT the reference's 49% — a percentage rescales the panel on
/// every window resize, which is not what dragging a divider promises. Points, persisted.
let panelDefaultWidth: CGFloat = 480

/// Below this a browser is not usable.
let panelMinWidth: CGFloat = 360

/// The composer and transcript need this to read correctly.
///
/// panel-shell T2 review round 2: revised 420 → 300 (user-decided scope change) — 420 left too
/// little room for the panel on an ordinary window; `panelMinContentWidth` derives from this, so
/// the threshold moved with it (780 → 660) with no separate edit.
let panelMinChatWidth: CGFloat = 300

/// Narrower than this and both minimums cannot be satisfied at once.
let panelMinContentWidth: CGFloat = panelMinWidth + panelMinChatWidth

/// PURE: the widest the panel may be dragged. Derived from the chat's minimum, so the chat always
/// wins — there is no separate max constant to drift out of step.
func panelMaxWidth(contentWidth: CGFloat) -> CGFloat {
    contentWidth - panelMinChatWidth
}

/// PURE: clamp a dragged width. Clamping STOPS the drag; it never promotes to `.maximized` —
/// a mode change the user did not ask for is surprising.
func panelClampWidth(_ width: CGFloat, contentWidth: CGFloat) -> CGFloat {
    min(max(width, panelMinWidth), panelMaxWidth(contentWidth: contentWidth))
}

/// PURE: can the window show a panel at all?
func panelFitsInContent(_ contentWidth: CGFloat) -> Bool {
    contentWidth >= panelMinContentWidth
}

/// PURE: the mode actually rendered. A window too narrow for both minimums forces `.hidden`,
/// whatever was requested — and the caller keeps the request, so widening the window restores it.
func panelResolvedMode(requested: PanelMode, contentWidth: CGFloat) -> PanelMode {
    panelFitsInContent(contentWidth) ? requested : .hidden
}

/// PURE: the panel's actual on-screen width for a given mode. `.maximized` needs no clamp at all —
/// `contentWidth` outright, since `ShellSidebar.swift`'s `detail` isn't even rendered alongside it
/// then. `.side`/`.hidden` clamp the dragged width exactly as `panelClampWidth` always has.
///
/// panel-shell T10 (self-caught in review): this exists so `ShellSidebar.swift` never hoists the
/// `panelClampWidth` call into an unconditional `let` — doing that would evaluate it even while
/// `mode == .hidden` (harmless in isolation, since the result would go unused there, but it would
/// break the documented guarantee that this codebase never reaches `panelClampWidth` outside the
/// regime where its own bounds can invert — see `PanelModeTests
/// .testClampBoundsAreNeverInvertedWhenThePanelFits`'s own doc comment for that regime). Both of
/// `ShellSidebar.swift`'s call sites for "how wide is the panel really" are already lexically
/// nested inside a `mode != .hidden` branch, so calling this FUNCTION from there preserves that
/// exact reachability — the short-circuiting ternary below still only evaluates `panelClampWidth`
/// when `mode` is `.side`, which is the only case reaching this function where it is not already
/// known to be `.maximized`.
func panelRenderedWidth(mode: PanelMode, sideWidth: CGFloat, contentWidth: CGFloat) -> CGFloat {
    mode == .maximized ? contentWidth : panelClampWidth(sideWidth, contentWidth: contentWidth)
}

/// Measured from the reference at @2x (`docs/research/reference/chatgpt-panel-titlebar-band-2026-08-08.png`).
/// The panel's own trailing cluster (expand / bottom-bar placeholder / sidebar toggle) wears a
/// bigger hit box than the main titlebar's `shellTitlebarButtonSize` (26pt): it sits in the tab
/// row, where the pill height and the "+" button are both 28pt, and reusing the titlebar's own
/// size here would read as a mismatched button sitting in that row.
let panelExpandButtonSize: CGFloat = 28

/// How far the panel's trailing cluster sits from the panel's own trailing edge. Mirrors
/// `shellTitlebarTrailingInset`'s role for the window's cluster — independently measured against
/// this reference rather than derived from it; the two happen to share a value, but they are not
/// the same measurement, so a future reference update to either is free to move only one.
let panelExpandButtonInset: CGFloat = 8

/// PURE: the expand button's glyph — STATES whether the panel is maximized, mirroring
/// `shellSidebarToggleSystemImage`'s own "state, not action" convention (`ShellSidebar.swift`).
func panelExpandButtonSystemImage(mode: PanelMode) -> String {
    mode == .maximized ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"
}

/// PURE: the expand button's help/accessibility text — the ACTION, complementing the glyph's
/// state. Mirrors `shellSidebarToggleLabel`.
func panelExpandButtonLabel(mode: PanelMode) -> String {
    mode == .maximized ? "Restore panel" : "Expand panel"
}

/// panel-shell T10: mode and width together, so the width SURVIVES every mode change.
///
/// The restore is structural rather than a stored "previous width": `.maximized` simply ignores
/// `sideWidth` instead of overwriting it, so there is no second value to keep in step and no path
/// where leaving maximized finds the wrong number.
struct PanelPresentation: Equatable {
    var mode: PanelMode = .hidden
    var sideWidth: CGFloat = panelDefaultWidth

    mutating func toggleVisible() {
        mode = (mode == .hidden) ? .side : .hidden
    }

    mutating func toggleMaximized() {
        mode = (mode == .maximized) ? .side : .maximized
    }
}
