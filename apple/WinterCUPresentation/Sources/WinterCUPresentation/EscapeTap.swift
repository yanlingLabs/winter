import CoreGraphics
import Foundation

/// The facts about one key event that the stop decision needs. Built from a `CGEvent` by the tap; built by hand in tests.
struct EscapeKeyEvent: Equatable {
    static let escapeKeyCode: Int64 = 53 // kVK_Escape

    var isKeyDown: Bool
    var keyCode: Int64
    var isAutorepeat = false
    /// Command, Control, Option or Shift held. A chord with Escape (cmd+esc, ctrl+esc, …) is never the stop key.
    var hasModifiers = false
    /// The posting process (`kCGEventSourceUnixProcessID`): 0 for the keyboard, the poster's pid for synthetic events.
    var sourcePID: pid_t = 0
}

enum EscapeDecision: Equatable {
    case pass
    /// Drop the event; nothing else happens (an autorepeat, or the key-up of a press already taken).
    case swallow
    /// Drop the event and report the stop.
    case swallowAndFire
}

/// The stop-key state machine. Pure: the tap feeds it events and the clock.
///
/// - Disarmed: everything passes.
/// - Armed: a bare Escape key-down from the user is swallowed and fires once; its autorepeats and its key-up are
///   swallowed too, so the app under the user never sees half a press.
/// - During an `expectSynthetic` window, and for events this very process posted, Escape passes: the helper's own
///   Escape key actions must reach their target.
struct EscapeTapLogic {
    let ownPID: pid_t
    let maxSyntheticWindow: TimeInterval
    private(set) var armed = false
    private(set) var syntheticUntil: TimeInterval = -.infinity
    /// A swallowed key-down is waiting for its key-up.
    private(set) var holdingSwallowedPress = false

    init(ownPID: pid_t, maxSyntheticWindow: TimeInterval) {
        self.ownPID = ownPID
        self.maxSyntheticWindow = maxSyntheticWindow
    }

    mutating func setArmed(_ on: Bool) {
        armed = on
        if !on { holdingSwallowedPress = false }
    }

    /// Lets synthetic Escapes through until `now + window` (clamped to `maxSyntheticWindow`). Overlapping calls extend,
    /// never shorten, the window.
    mutating func expectSynthetic(for window: TimeInterval, now: TimeInterval) {
        guard window.isFinite, window > 0 else { return }
        let end = now + min(window, maxSyntheticWindow)
        syntheticUntil = max(syntheticUntil, end)
    }

    func isInSyntheticWindow(now: TimeInterval) -> Bool { now < syntheticUntil }

    mutating func decide(_ event: EscapeKeyEvent, now: TimeInterval) -> EscapeDecision {
        guard event.keyCode == EscapeKeyEvent.escapeKeyCode else { return .pass }
        if !event.isKeyDown {
            // The key-up of a press we took is ours too, armed or not by now.
            if holdingSwallowedPress {
                holdingSwallowedPress = false
                return .swallow
            }
            return .pass
        }
        guard armed else { return .pass }
        if event.sourcePID != 0 && event.sourcePID == ownPID { return .pass }
        if isInSyntheticWindow(now: now) { return .pass }
        if event.hasModifiers { return .pass }
        if event.isAutorepeat || holdingSwallowedPress {
            holdingSwallowedPress = true
            return .swallow
        }
        holdingSwallowedPress = true
        return .swallowAndFire
    }
}

/// A created event tap that can be switched on and off.
@MainActor protocol EscapeTapHandle: AnyObject {
    func setEnabled(_ on: Bool)
}

/// Creates the tap. `handler` runs on the main thread for every key-down/key-up and returns true to swallow the event.
/// Returns nil when the tap can't be created (no Accessibility grant).
@MainActor protocol EscapeTapInstaller {
    func install(handler: @escaping @MainActor (EscapeKeyEvent) -> Bool) -> EscapeTapHandle?
}

/// The `CUEscapeTap` the helper uses. The CGEventTap is created on the first `setArmed(true)` and enabled only while
/// armed. If it can't be created, arming is a no-op: it logs once and tries again at the next arm (Accessibility may
/// have been granted since).
@MainActor final class EscapeTap: CUEscapeTap {
    var onEscape: (() -> Void)?

    private var logic: EscapeTapLogic
    private let installer: EscapeTapInstaller
    private let clock: CUClock
    private let log: (String) -> Void
    private var handle: EscapeTapHandle?
    private var loggedUnavailable = false

    init(installer: EscapeTapInstaller,
         clock: CUClock,
         ownPID: pid_t = getpid(),
         tuning: PresentationTuning = .standard,
         log: @escaping (String) -> Void = PresentationLog.notice) {
        self.installer = installer
        self.clock = clock
        self.log = log
        self.logic = EscapeTapLogic(ownPID: ownPID, maxSyntheticWindow: tuning.maxSyntheticEscapeWindow)
    }

    /// True while the tap exists and is armed (for status and tests).
    var isActive: Bool { handle != nil && logic.armed }

    func setArmed(_ armed: Bool) {
        if armed, handle == nil {
            handle = installer.install { [weak self] event in
                self?.handle(event) ?? false
            }
            if handle == nil {
                if !loggedUnavailable {
                    loggedUnavailable = true
                    log("Esc stop unavailable: the event tap could not be created (Accessibility not granted?)")
                }
                return
            }
        }
        guard let handle else { return }
        logic.setArmed(armed)
        handle.setEnabled(armed)
    }

    func expectSyntheticEscape(for window: TimeInterval) {
        logic.expectSynthetic(for: window, now: clock.now)
    }

    /// One event from the tap. Returns true to swallow it.
    func handle(_ event: EscapeKeyEvent) -> Bool {
        switch logic.decide(event, now: clock.now) {
        case .pass:
            return false
        case .swallow:
            return true
        case .swallowAndFire:
            // Report after the tap callback returns, so a slow handler can never stall the event stream.
            DispatchQueue.main.async { [weak self] in self?.onEscape?() }
            return true
        }
    }
}
