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
