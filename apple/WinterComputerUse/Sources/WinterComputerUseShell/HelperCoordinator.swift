import CoreGraphics
import Foundation
import WinterCUCore
import WinterCUPresentation

/// A helper → daemon notification.
public enum HelperNotification: Equatable, Sendable {
    /// The user pressed Esc while scripts ran; the daemon interrupts those sessions' turns.
    case escPressed(sessionIds: [String])
    case targetLost(targetId: String, reason: String)
    case permissionsChanged(HelperPermissions)

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
        case .permissionsChanged(let p):
            return .object(["permissions": .object(["accessibility": .bool(p.accessibility), "screenRecording": .bool(p.screenRecording)])])
        }
    }
}

/// The helper's main-actor state: which sessions are running scripts (the Esc tap's arming), which targets
/// are bound (idle accounting and the mirrors), how many daemon connections are open, and the last
/// permissions the daemon was told. It is the engine's `CUCoreEvents` receiver, and maps those events onto
/// the presentation layer and onto notifications.
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
    private let permissions: PermissionSystem
    private var idleTimer: IdleQuitTimer?
    /// Where notifications go (the server's broadcast). Called on the main actor.
    public var notify: (HelperNotification) -> Void = { _ in }

    public private(set) var openConnections: Set<Int> = []
    public private(set) var activeScripts: Set<String> = []
    private var armed = false
    private var bound: [BoundTarget: (appName: String, mirror: Bool)] = [:]
    private var lastPermissions: HelperPermissions?
    private var permissionPoll: Timer?
    private let permissionPollInterval: TimeInterval

    public init(presentation: CUPresentation, escapeTap: CUEscapeTap, permissions: PermissionSystem,
                permissionPollInterval: TimeInterval = 2) {
        self.presentation = presentation
        self.escapeTap = escapeTap
        self.permissions = permissions
        self.permissionPollInterval = permissionPollInterval
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
        if lastPermissions == nil { lastPermissions = permissions.current() }
        startPermissionPoll()
        refreshIdle()
    }

    public func connectionClosed(_ id: Int) {
        openConnections.remove(id)
        if openConnections.isEmpty { stopPermissionPoll() }
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

    // MARK: Permissions

    /// A permission reading (a poll, a `status`, or the engine's event): tells the daemon only on a change.
    public func observePermissions(_ now: HelperPermissions) {
        defer { lastPermissions = now }
        guard let last = lastPermissions, last != now else { return }
        notify(.permissionsChanged(now))
    }

    private func startPermissionPoll() {
        guard permissionPoll == nil, permissionPollInterval > 0 else { return }
        let timer = Timer(timeInterval: permissionPollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.observePermissions(self.permissions.current())
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        permissionPoll = timer
    }

    private func stopPermissionPoll() {
        permissionPoll?.invalidate()
        permissionPoll = nil
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

    public func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {
        let key = BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)
        let record = bound.removeValue(forKey: key)
        presentation.hideMirror(sessionId: sessionId, target: CUWindowRef(pid: pid, windowID: windowID, appName: record?.appName ?? ""))
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

    public func permissionsChanged(accessibility: Bool, screenRecording: Bool) {
        observePermissions(HelperPermissions(accessibility: accessibility, screenRecording: screenRecording))
    }

    public func willSendEscape() {
        escapeTap.expectSyntheticEscape(for: Self.syntheticEscapeWindow)
    }
}
