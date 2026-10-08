import CoreGraphics
import Foundation

// The presentation protocol between the helper shell (the caller) and this package. These shapes
// are pinned by the ComputerV2 phase-1 spine (§3): change them only together with the shell.

/// One window the helper works on. `windowID` is the window server's id (`CGWindowID`).
public struct CUWindowRef: Sendable, Hashable {
    public let pid: pid_t
    public let windowID: CGWindowID
    public let appName: String

    public init(pid: pid_t, windowID: CGWindowID, appName: String) {
        self.pid = pid
        self.windowID = windowID
        self.appName = appName
    }
}

@MainActor public protocol CUPresentation: AnyObject {
    /// A target was bound with mirror:true → show (or re-show) its mirror at the window's top-left corner, over the traffic
    /// lights; follow the window as it moves; dock to the nearest screen corner when it is minimized/off-Space/off-screen.
    /// At most 2 mirrors on screen (most recent on top); live window stream 10–15 fps ~360 px wide (ScreenCaptureKit,
    /// desktop-independent window filter).
    func showMirror(sessionId: String, target: CUWindowRef)
    func hideMirror(sessionId: String, target: CUWindowRef)
    /// Agent cursor: animate to `point` (screen points) over the target window and show the action; `press` adds a click
    /// pulse. Drawn in a click-through overlay above the target window (only when the window is visible on screen) AND
    /// inside that target's mirror. Kinds that are not about a place (`wait`, `refused`, `foreground`, `idle`, `done`,
    /// `caption`) use `point` only when the cursor has not appeared yet.
    func cursor(sessionId: String, target: CUWindowRef, point: CGPoint, kind: CUCursorKind)
    /// The session's turn ended → fade its mirrors (also auto-fade 30 s after the last cursor/action on a target).
    func turnEnded(sessionId: String)
    func sessionEnded(sessionId: String)
    /// Global enable flag (settings computerUse.mirror). false → no mirrors (cursor overlay still shown).
    var mirrorsEnabled: Bool { get set }
}

/// What the agent cursor shows at `point`. The first five cases are the pinned originals; the rest were added for the
/// cursor's full set of states (see DESIGN-cursor.md for the look of each, and `init?(core:…)` for the wire mapping).
/// Every positional payload (`drag(to:)`, `target(frame:)`) is in screen points, top-left origin, like `point`.
public enum CUCursorKind: Sendable {
    // Pinned.
    case move, press, type, scroll, drag(to: CGPoint)

    // Added.
    /// A reticle settles on the element's frame just before the action on it (the next event at `point`).
    case target(frame: CGRect)
    case doubleClick
    case rightClick
    /// A key combo ("cmd+s", "return"): a key badge beside the tip. `type` keeps the caret badge for text.
    case key(combo: String)
    /// A scroll with a known direction (the plain `scroll` draws an up/down badge).
    case scrollToward(CUScrollDirection)
    /// A wait (`waitFor`, `waitIdle`, settle) begins or ends. A labelled wait that lasts gets a caption.
    case wait(CUWaitPhase)
    /// An action was refused (a floor, not allowed, an error): a brief, gentle "no".
    case refused
    /// Rung 4 begins (true) or ends (false): the REAL mouse is in use. The arrow gives way to a warm ring around the
    /// real pointer and the caption "Using your mouse".
    case foreground(Bool)
    /// Resting between actions (the cursor also settles here by itself shortly after any action).
    case idle
    /// A graceful fade. Turn end, session end and a 30 s idle do this on their own.
    case done
    /// A short caption beside the cursor ("Clicking “Save”"), or nil to clear it. Shown at least 1.2 s.
    case caption(String?)
}

public enum CUScrollDirection: String, Sendable, CaseIterable { case up, down, left, right }

public enum CUWaitPhase: Sendable, Equatable {
    /// `label` names what is awaited ("Saved", "the window to settle"); nil for a plain wait.
    case begin(label: String?)
    case end
}

// Additive: lets callers and tests compare kinds. Not part of the pinned shape.
extension CUCursorKind: Equatable {}

extension CUCursorKind {
    /// Maps the core's action event (`CUCoreEvents.actionAt`'s `kind` string plus its payload) onto a cursor kind. The
    /// table lives in DESIGN-cursor.md; unknown strings return nil so the shell can ignore them.
    ///
    /// - Parameters:
    ///   - kind: the action string.
    ///   - dragTo: the drag end, for "drag".
    ///   - frame: the element's frame in screen points, for "target".
    ///   - text: the per-kind detail: the combo for "key", the direction for "scroll", the label for "waitBegin", the
    ///     caption for "caption", "on"/"off" for "foreground".
    ///   - count: the click count for "press" (2 → `doubleClick`).
    ///   - button: "left" (default), "right" (→ `rightClick`) or "middle" for "press".
    public init?(core kind: String, dragTo: CGPoint? = nil, frame: CGRect? = nil, text: String? = nil,
                 count: Int? = nil, button: String? = nil) {
        switch kind {
        case "move": self = .move
        case "target":
            guard let frame else { return nil }
            self = .target(frame: frame)
        case "press", "click":
            if button == "right" { self = .rightClick }
            else if (count ?? 1) >= 2 { self = .doubleClick }
            else { self = .press }
        case "doubleClick": self = .doubleClick
        case "rightClick": self = .rightClick
        case "type", "paste", "setValue": self = .type
        case "key":
            guard let text, !text.isEmpty else { return nil }
            self = .key(combo: text)
        case "scroll":
            if let text, let direction = CUScrollDirection(rawValue: text) { self = .scrollToward(direction) }
            else { self = .scroll }
        case "drag":
            guard let dragTo else { return nil }
            self = .drag(to: dragTo)
        case "waitBegin": self = .wait(.begin(label: text?.isEmpty == false ? text : nil))
        case "waitEnd": self = .wait(.end)
        case "refused": self = .refused
        case "foreground": self = .foreground(text != "off")
        case "idle": self = .idle
        case "done": self = .done
        case "caption": self = .caption(text?.isEmpty == false ? text : nil)
        default: return nil
        }
    }
}

@MainActor public protocol CUEscapeTap: AnyObject {
    /// Armed while any session has an active script. When armed, a user-pressed Escape is swallowed and `onEscape` fires.
    func setArmed(_ armed: Bool)
    /// The helper is about to SEND Escape itself (a key action) → let synthetic Escapes through for `window` seconds.
    func expectSyntheticEscape(for window: TimeInterval)
    var onEscape: (() -> Void)? { get set }
}

public enum WinterCUPresentationFactory {
    /// The live presentation (AppKit panels, ScreenCaptureKit mirrors) and the Esc tap. Creating them draws nothing and
    /// installs nothing: panels appear on the first `showMirror`/`cursor`, and the tap is created on the first
    /// `setArmed(true)`.
    @MainActor public static func make() -> (CUPresentation, CUEscapeTap) {
        let presentation = PresentationController(
            windows: SystemWindowSource(),
            surfaces: AppKitSurfaceFactory(),
            clock: SystemClock(),
            ticker: RunLoopTicker(),
            frames: DisplayLinkDriver(),
            accessibility: SystemAccessibility()
        )
        let tap = EscapeTap(installer: CGEventTapInstaller(), clock: SystemClock())
        return (presentation, tap)
    }
}
