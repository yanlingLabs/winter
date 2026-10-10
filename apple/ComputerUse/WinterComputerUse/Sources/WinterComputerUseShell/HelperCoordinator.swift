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

/// The helper's main-actor state: which sessions are running scripts (the Esc tap's arming, and idle
/// accounting), which targets are bound (idle accounting, the cursor overlay) and which daemon connections are
/// open. It is the engine's `CUCoreEvents` receiver, and maps those events onto the on-screen cursor overlay,
/// onto Winter.app's view stream (`ViewHub`) and onto the daemon's notifications. The helper shows no floating
/// mirror: the live mirror is drawn inside Winter.app's session window, from the view stream.
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
    public let viewHub: ViewHub
    private var idleTimer: IdleQuitTimer?
    /// Where notifications go (the server's broadcast). Called on the main actor.
    public var notify: (HelperNotification) -> Void = { _ in }

    public private(set) var openConnections: Set<Int> = []
    public private(set) var activeScripts: Set<String> = []
    private var armed = false
    private var bound: [BoundTarget: (appName: String, mirror: Bool)] = [:]
    private var lastPermissions: (accessibility: Bool, screenRecording: Bool)?
    /// The desktop-switch prompts on screen (`prompt.desktopVisit`), and the requests waiting on each.
    private let prompts: CUDesktopPrompting
    private var promptWaiters: [String: CheckedContinuation<CUDesktopPromptAnswer, Error>] = [:]

    public init(presentation: CUPresentation, escapeTap: CUEscapeTap, viewHub: ViewHub, prompts: CUDesktopPrompting? = nil) {
        self.presentation = presentation
        self.escapeTap = escapeTap
        self.viewHub = viewHub
        self.prompts = prompts ?? CUDesktopPromptController.live()
        // No floating mirror in the helper any more (the mirror lives in Winter.app's window). Off as well as
        // never asked for: the presentation layer re-shows a mirror on a cursor event for a target whose mirror
        // was once requested, and this switch is what guarantees it never does.
        presentation.mirrorsEnabled = false
        escapeTap.onEscape = { [weak self] in
            MainActor.assumeIsolated { self?.escapePressed() }
        }
    }

    /// Wires the idle timer and evaluates once, so a helper nobody uses still quits.
    public func attach(idleTimer: IdleQuitTimer) {
        self.idleTimer = idleTimer
        refreshIdle()
    }

    public var boundTargetCount: Int { bound.count }
    /// What keeps the helper running: a bound target (a mirror exists only for one) or a running script. A
    /// connected daemon alone does not — it keeps one persistent connection, reads the close as "helper gone"
    /// and relaunches the helper on its next call.
    public var isBusy: Bool { !bound.isEmpty || !activeScripts.isEmpty }

    /// Starts the idle countdown over (the quit found work still in flight).
    public func restartIdleCountdown() {
        idleTimer?.update(busy: true)
        refreshIdle()
    }

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
        refreshIdle()
    }

    public func turnEnded(sessionId: String) {
        presentation.turnEnded(sessionId: sessionId)
        viewHub.turnEnded(sessionId: sessionId)
    }

    /// `session.ended`, or the last daemon connection that used the session went away.
    public func sessionEnded(sessionId: String) {
        activeScripts.remove(sessionId)
        refreshArming()
        bound = bound.filter { $0.key.sessionId != sessionId }
        presentation.sessionEnded(sessionId: sessionId)
        viewHub.sessionEnded(sessionId: sessionId)
        refreshIdle()
    }

    // MARK: The desktop-switch prompt

    /// `prompt.desktopVisit`: shows the prompt on the user's current desktop and answers when they click, or
    /// `expired` when its countdown runs out. Cancelling the request (the daemon's `cancel {callId}` — its card
    /// was answered first —, or the connection closing) closes the panel at once.
    public func askDesktopVisit(_ p: PromptDesktopVisitParams) async throws -> CUDesktopPromptAnswer {
        let id = p.promptId
        let request = CUDesktopPromptRequest(promptId: id, sessionId: p.sessionId, app: p.app, bundleId: p.bundleId,
                                             reason: p.reason, timeoutMs: p.timeoutMs)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<CUDesktopPromptAnswer, Error>) in
                guard promptWaiters[id] == nil else {
                    c.resume(throwing: RPCError.invalidParams("a desktop prompt \(id) is already open"))
                    return
                }
                if Task.isCancelled {
                    c.resume(throwing: CancellationError())
                    return
                }
                promptWaiters[id] = c
                prompts.show(request) { [weak self] answer in self?.finishPrompt(id, .success(answer)) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelPrompt(id) }
        }
    }

    /// The prompts waiting for an answer now (tests).
    public var openPromptIds: [String] { promptWaiters.keys.sorted() }

    private func cancelPrompt(_ id: String) {
        guard promptWaiters[id] != nil else { return }
        prompts.close(promptId: id)
        finishPrompt(id, .failure(CancellationError()))
    }

    private func finishPrompt(_ id: String, _ result: Result<CUDesktopPromptAnswer, Error>) {
        guard let c = promptWaiters.removeValue(forKey: id) else { return }
        c.resume(with: result)
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

    /// Recorded for the cursor overlay's app name and idle accounting. Winter.app hears of the bind from the
    /// `target.bind` result (`ViewHub.bound`), which names the target id, bundle id and window size this event
    /// does not carry.
    public func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool) {
        bound[BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)] = (appName, mirror)
        refreshIdle()
    }

    /// A release, a lost target (the engine reports both `targetReleased` and `targetLost`) or the engine's half
    /// of `session.ended`. Winter.app is told once (`ViewHub.released` ignores a target already gone).
    public func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID) {
        let key = BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)
        viewHub.released(sessionId: sessionId, pid: pid, windowId: windowID)
        guard bound.removeValue(forKey: key) != nil else { return }
        refreshIdle()
    }

    /// The engine's cursor events, mapped by the presentation layer's own table (`CUCursorKind(core:…)`, see
    /// WinterCUPresentation's DESIGN-cursor.md). A kind it does not know, or one missing its payload (a "target"
    /// with no frame, a "key" with no combo, a "drag" with no end), is dropped rather than guessed.
    public func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?,
                         frame: CGRect?, text: String?, count: Int?, button: String?) {
        viewHub.cursor(sessionId: sessionId, pid: pid, windowId: windowID, point: point, kind: kind, dragTo: dragTo,
                       frame: frame, text: text, count: count, button: button)
        guard let cursorKind = CUCursorKind(core: kind, dragTo: dragTo, frame: frame, text: text, count: count, button: button)
        else { return }
        let appName = bound[BoundTarget(sessionId: sessionId, pid: pid, windowID: windowID)]?.appName ?? ""
        presentation.cursor(sessionId: sessionId, target: CUWindowRef(pid: pid, windowID: windowID, appName: appName), point: point, kind: cursorKind)
    }

    /// The daemon hears the engine's observed reason — `app_quit`, `window_closed`, `helper_restart` or `unknown`
    /// (PROTOCOL.md §7.1); anything else goes out as `unknown`, so the wire carries only documented values.
    public func targetLost(targetId: String, reason: String) {
        let reason = (CUTargetLostReason(rawValue: reason) ?? .unknown).rawValue
        viewHub.release(targetId: targetId, reason: "lost (\(reason))")
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
