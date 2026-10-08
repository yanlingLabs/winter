import AppKit
import Foundation

// -----------------------------------------------------------------------------------------------
// The mirror's rules, PURE (user ruling 2026-10-08, spine §11b):
//
//   - the live mirror of the app being controlled shows INSIDE Winter's own window that is open on the
//     session using computer use: the main window, at its top-left, over the traffic lights;
//   - a detached session window shows it only when it is wide enough;
//   - nothing shows when the session is not open in a window;
//   - never in the Dispatch pill (or the orb's morph window, which is the pill's surface).
//
// What decides whether to subscribe to a session's views is here; the connection, the targets and the
// panel are in `MirrorCoordinator` and `MirrorWindowBinder`.
// -----------------------------------------------------------------------------------------------

/// What kind of surface a window is, for the mirror.
enum MirrorWindowKind: Equatable, Sendable {
    /// The main window (`AppWindowController`): shows the session it has attached.
    case shell
    /// A detached session window (`DetachedWindowController`).
    case detached
    /// The Dispatch pill and the orb's morph window. They register nothing — this case exists so a test
    /// can state the rule — and never get a mirror.
    case pill
}

/// One window, as the rules see it.
struct MirrorWindow: Equatable, Sendable {
    let id: String
    let kind: MirrorWindowKind
    /// The session the window is open on; nil when it shows no session.
    let sessionId: String?
    /// The window's width in points.
    let width: CGFloat
}

enum MirrorRules {
    /// A detached window is wide enough for the mirror from here.
    static let detachedMinWidth: CGFloat = 720
    /// …and stays eligible until it is narrower than `detachedMinWidth - detachedHysteresis`, so a live
    /// resize across the line does not subscribe and unsubscribe on every pixel.
    static let detachedHysteresis: CGFloat = 20

    /// Whether `window` shows the mirror. `wasEligible` is the window's answer last time (the
    /// hysteresis memory); a window seen for the first time passes `false`.
    static func isEligible(_ window: MirrorWindow, wasEligible: Bool) -> Bool {
        guard let sessionId = window.sessionId, !sessionId.isEmpty else { return false }
        switch window.kind {
        case .pill:
            return false
        case .shell:
            return true
        case .detached:
            let floor = wasEligible ? detachedMinWidth - detachedHysteresis : detachedMinWidth
            return window.width >= floor
        }
    }

    /// The sessions to hold a view subscription for: every session an eligible window is open on.
    static func subscriptions(eligible windows: [MirrorWindow]) -> Set<String> {
        Set(windows.compactMap(\.sessionId))
    }
}

// MARK: - The panel

/// The mirror panel's width: "about 300–360 pt".
let mirrorPanelWidth: CGFloat = 320
/// How far in from the window's top-left corner the panel sits. Small, so it covers the traffic lights.
let mirrorPanelInset: CGFloat = 8
/// The panel's height bounds. A tall portrait window keeps its aspect up to the cap and is letterboxed
/// beyond it.
let mirrorPanelMinHeight: CGFloat = 150
let mirrorPanelMaxHeight: CGFloat = 300
/// What the panel adds around the picture: its padding and the app-name line.
let mirrorPanelChrome: CGFloat = 40

/// PURE: the panel's size for a bound window of `windowSize` points — the fixed width, a height that
/// follows the window's aspect within the bounds.
func mirrorPanelSize(windowSize: CGSize) -> CGSize {
    guard windowSize.width > 0, windowSize.height > 0 else {
        return CGSize(width: mirrorPanelWidth, height: mirrorPanelMinHeight)
    }
    let picture = (mirrorPanelWidth - 16) * windowSize.height / windowSize.width
    let height = min(max(picture + mirrorPanelChrome, mirrorPanelMinHeight), mirrorPanelMaxHeight)
    return CGSize(width: mirrorPanelWidth, height: height.rounded())
}

/// PURE: the panel's frame in screen coordinates — its top-left `mirrorPanelInset` in from the parent
/// window's top-left corner (AppKit's origin is bottom-left, so y counts down from `maxY`).
func mirrorPanelFrame(parent: NSRect, size: CGSize) -> NSRect {
    NSRect(x: parent.minX + mirrorPanelInset, y: parent.maxY - mirrorPanelInset - size.height,
           width: size.width, height: size.height)
}
