import CoreGraphics
import Foundation
import WinterCUCore
import WinterCUPresentation

/// A helper → daemon notification.
public enum HelperNotification: Equatable, Sendable {
    /// The user pressed Esc while scripts ran; the daemon interrupts those sessions' turns.
    case escPressed(sessionIds: [String])
    case targetLost(targetId: String, reason: String)
    case permissionsChanged(accessibility: Bool, screenRecording: Bool)

    public var method: String {
        switch self {
        case .escPressed: return "escPressed"
        case .targetLost: return "targetLost"
        case .permissionsChanged: return "permissionsChanged"
        }
    }

    public var params: JSONValue {
        switch self {
        case .escPressed(let ids):
            return .object(["sessionIds": .array(ids.map(JSONValue.string))])
        case .targetLost(let targetId, let reason):
            return .object(["targetId": .string(targetId), "reason": .string(reason)])
        case .permissionsChanged(let accessibility, let screenRecording):
            return .object(["permissions": .object(["accessibility": .bool(accessibility), "screenRecording": .bool(screenRecording)])])
        }
    }
}

/// The helper's main-actor state: which sessions are running scripts (the Esc tap's arming), which targets
/// are bound (idle accounting and the mirrors) and how many daemon connections are open. It is the engine's
/// `CUCoreEvents` receiver, and maps those events onto the presentation layer and onto notifications.
@MainActor public final class HelperCoordinator: CUCoreEvents {
    /// How long a synthetic Escape from the helper's own key action may pass the armed tap.
    public static let syntheticEscapeWindow: TimeInterval = 0.5

    private struct BoundTarget: Hashable {
        let sessionId: String
        let pid: pid_t
        let windowID: CGWindowID
    }

    private let presentation: CUPresentation
    private let escapeTap: CUEscapeTap
    private var idleTimer: IdleQuitTimer?
    /// Where notifications go (the server's broadcast). Called on the main actor.
    public var notify: (HelperNotification) -> Void = { _ in }

    public private(set) var openConnections: Set<Int> = []
    public private(set) var activeScripts: Set<String> = []
    private var armed = false
    private var bound: [BoundTarget: (appName: String, mirror: Bool)] = [:]
    private var lastPermissions: (accessibility: Bool, screenRecording: Bool)?

    public init(presentation: CUPresentation, escapeTap: CUEscapeTap) {
        self.presentation = presentation
        self.escapeTap = escapeTap
        // Mirrors are asked for per bind (`target.bind`'s `mirror`, which the daemon derives from
        // `computerUse.mirror`), so the global switch stays on.
        presentation.mirrorsEnabled = true
        escapeTap.onEscape = { [weak self] in
            MainActor.assumeIsolated { self?.escapePressed() }
        }
    }

    /// Wires the idle timer and evaluates once, so a helper nobody connects to still quits.
    public func attach(idleTimer: IdleQuitTimer) {
        self.idleTimer = idleTimer
        refreshIdle()
    }

    public var boundTargetCount: Int { bound.count }
    public var isBusy: Bool { !openConnections.isEmpty || !bound.isEmpty }

    // MARK: Connections

    public func connectionOpened(_ id: Int) {
        openConnections.insert(id)
        refreshIdle()
    }

    public func connectionClosed(_ id: Int) {
        openConnections.remove(id)
        refreshIdle()
    }

    // MARK: Lifecycle methods

    public func setScriptActive(sessionId: String, active: Bool) {
        if active { activeScripts.insert(sessionId) } else { activeScripts.remove(sessionId) }
        refreshArming()
    }

    public func turnEnded(sessionId: String) {
        presentation.turnEnded(sessionId: sessionId)
    }

    /// `session.ended`, or the last daemon connection that used the session went away.
    public func sessionEnded(sessionId: String) {
        activeScripts.remove(sessionId)
        refreshArming()
        bound = bound.filter { $0.key.sessionId != sessionId }
        presentation.sessionEnded(sessionId: sessionId)
        refreshIdle()
    }

    // MARK: Esc

    public func escapePressed() {
        guard !activeScripts.isEmpty else { return }
        notify(.escPressed(sessionIds: activeScripts.sorted()))
    }

    private func refreshArming() {
        let shouldArm = !activeScripts.isEmpty
        guard shouldArm != armed else { return }
        armed = shouldArm
        escapeTap.setArmed(shouldArm)
    }

    // MARK: Idle

    private func refreshIdle() {
        idleTimer?.update(busy: isBusy)
    }

    // MARK: CUCoreEvents

    public func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {
        bound[BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)] = (appName, mirror)
        if mirror {
            presentation.showMirror(sessionId: sessionId, target: CUWindowRef(pid: pid, windowID: windowID, appName: appName))
        }
        refreshIdle()
    }

    /// A release, a lost target (the engine reports both `targetReleased` and `targetLost`) or the engine's half
    /// of `session.ended`: the mirror is hidden once, for a target still known to have one — never again for a
    /// repeat, and not for a session whose mirrors `sessionEnded` already closed.
    public func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {
        let key = BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)
        guard let record = bound.removeValue(forKey: key) else { return }
        if record.mirror {
            presentation.hideMirror(sessionId: sessionId, target: CUWindowRef(pid: pid, windowID: windowID, appName: record.appName))
        }
        refreshIdle()
    }

    public func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?) {
        let appName = bound[BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)]?.appName ?? ""
        let cursorKind: CUCursorKind
        switch kind {
        case "press": cursorKind = .press
        case "type": cursorKind = .type
        case "scroll": cursorKind = .scroll
        case "drag": cursorKind = .drag(to: dragTo ?? point)
        default: cursorKind = .move
        }
        presentation.cursor(sessionId: sessionId, target: CUWindowRef(pid: pid, windowID: windowID, appName: appName), point: point, kind: cursorKind)
    }

    public func targetLost(targetId: String, reason: String) {
        notify(.targetLost(targetId: targetId, reason: reason))
    }

    /// The engine watches the grants; the daemon hears each change once.
    public func permissionsChanged(accessibility: Bool, screenRecording: Bool) {
        if let last = lastPermissions, last.accessibility == accessibility, last.screenRecording == screenRecording { return }
        lastPermissions = (accessibility, screenRecording)
        notify(.permissionsChanged(accessibility: accessibility, screenRecording: screenRecording))
    }

    public func willSendEscape() {
        escapeTap.expectSyntheticEscape(for: Self.syntheticEscapeWindow)
    }
}
