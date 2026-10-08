import Combine
import CoreGraphics
import Foundation
import WinterCUPresentation
import WinterKit

// -----------------------------------------------------------------------------------------------
// The live mirror's brain: which sessions Winter.app watches through the helper, what each session's
// bound targets are, and what each session's mirror model shows.
//
//   windows (the main window, detached windows)  ──setWindow──▶  MirrorCoordinator
//   MirrorRules ──▶ which windows are eligible ──▶ the sessions to subscribe to
//   helper (ComputerUseHelperClient) ──events──▶ per-session MirrorSessionState ──▶ MirrorSink (CUMirrorModel)
//
// It owns the CONNECTION policy too: connect only while a subscription is wanted (the helper idle-quits
// when nothing is connected, and an app client that stayed connected forever would keep it alive),
// never launch the helper (a missing socket is an answer, retried quietly with backoff), and subscribe
// again after a reconnect. All of it runs against `ComputerUseHelperClient`, so the tests drive it with
// a fake and no socket.
// -----------------------------------------------------------------------------------------------

/// What a session's mirror is fed through — `CUMirrorModel`'s own methods, as a protocol so the tests
/// record what reached it.
@MainActor
protocol MirrorSink: AnyObject {
    func show(appName: String, windowSize: CGSize)
    func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize)
    func applyCursor(kind: String, point: CGPoint, dragTo: CGPoint?, frame: CGRect?, text: String?, count: Int?, button: String?)
    func clear()
}

extension CUMirrorModel: MirrorSink {}

// MARK: - Targets

/// A session's bound targets in the order they became bound; the one SHOWN is the most recent.
///
/// The spine does not pin the order of `view.subscribe`'s `targets`; it is read as oldest first, so the
/// last is the most recent — the same order `view.bound` notifications arrive in.
struct MirrorTargetTracker: Equatable {
    private(set) var targets: [HelperTarget] = []

    var shown: HelperTarget? { targets.last }

    mutating func seed(_ seeded: [HelperTarget]) { targets = seeded }

    /// A target bound (again): it becomes the most recent.
    mutating func bound(_ target: HelperTarget) {
        targets.removeAll { $0.targetId == target.targetId }
        targets.append(target)
    }

    /// Returns whether the target was one of ours.
    @discardableResult
    mutating func released(_ targetId: String) -> Bool {
        let before = targets.count
        targets.removeAll { $0.targetId == targetId }
        return targets.count != before
    }

    /// The shown target's window changed size (a frame said so).
    mutating func resizeShown(_ size: CGSize) {
        guard let last = targets.last, last.windowSize != size else { return }
        targets[targets.count - 1] = HelperTarget(targetId: last.targetId, pid: last.pid, windowId: last.windowId,
                                                  appName: last.appName, bundleId: last.bundleId, windowSize: size)
    }

    mutating func reset() { targets = [] }

    /// Frames and cursors for a target that is not the shown one are dropped.
    func accepts(targetId: String) -> Bool { shown?.targetId == targetId }
}

// MARK: - One session

/// One session's mirror: its targets, whether the mirror is up, and the sink it feeds.
///
/// The mirror is UP while a target is bound and the session's turn is running — it comes down on
/// `view.released` of the last target and at the turn's end. A frame or a cursor for anything but the
/// shown target, or arriving while the mirror is down, is dropped.
@MainActor
final class MirrorSessionState: ObservableObject {
    let sessionId: String
    let sink: any MirrorSink
    private(set) var tracker = MirrorTargetTracker()
    private(set) var turnRunning = false
    /// The target on show (the most recent bound), whether or not the turn is running.
    @Published private(set) var shownTarget: HelperTarget?
    /// Whether the mirror is up: a target is bound and the turn runs.
    @Published private(set) var isVisible = false
    private var shownOnSink: String?

    init(sessionId: String, sink: any MirrorSink) {
        self.sessionId = sessionId
        self.sink = sink
    }

    var panelSize: CGSize { mirrorPanelSize(windowSize: shownTarget?.windowSize ?? .zero) }

    func seed(_ targets: [HelperTarget]) { tracker.seed(targets); refresh() }
    func bound(_ target: HelperTarget) { tracker.bound(target); refresh() }
    func released(_ targetId: String) { if tracker.released(targetId) { refresh() } }
    func reset() { tracker.reset(); refresh() }

    func setTurnRunning(_ running: Bool) {
        guard running != turnRunning else { return }
        turnRunning = running
        refresh()
    }

    func frame(_ frame: HelperFrame) {
        guard isVisible, tracker.accepts(targetId: frame.targetId) else { return }
        if tracker.shown?.windowSize != frame.windowSize {
            tracker.resizeShown(frame.windowSize)
            shownTarget = tracker.shown
        }
        sink.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
    }

    func cursor(_ cursor: HelperCursor) {
        guard isVisible, tracker.accepts(targetId: cursor.targetId) else { return }
        sink.applyCursor(kind: cursor.kind, point: cursor.point, dragTo: cursor.dragTo, frame: cursor.frame,
                         text: cursor.text, count: cursor.count, button: cursor.button)
    }

    /// Recomputes what is shown and tells the sink on every change: `show` when the mirror comes up or
    /// another target takes over, `clear` when it goes down.
    private func refresh() {
        let target = tracker.shown
        if shownTarget != target { shownTarget = target }
        let visible = target != nil && turnRunning
        if visible, let target {
            if shownOnSink != target.targetId {
                sink.show(appName: target.appName, windowSize: target.windowSize)
                shownOnSink = target.targetId
            }
        } else if shownOnSink != nil {
            sink.clear()
            shownOnSink = nil
        }
        if isVisible != visible { isVisible = visible }
    }
}

// MARK: - The coordinator

@MainActor
final class MirrorCoordinator: ObservableObject {
    private let client: any ComputerUseHelperClient
    private let makeSink: @MainActor (String) -> any MirrorSink
    private let sleep: @Sendable (Duration) async -> Void
    private let log: (String) -> Void

    private(set) var windows: [String: MirrorWindow] = [:]
    /// The windows that show the mirror right now — what the panels watch.
    @Published private(set) var eligibleWindowIds: Set<String> = []
    private var states: [String: MirrorSessionState] = [:]

    /// The sessions subscribed on the helper right now, and whether each asked for frames.
    private var appliedFrames: [String: Bool] = [:]
    var applied: Set<String> { Set(appliedFrames.keys) }
    /// Whether the session is subscribed WITH frames right now (tests).
    func isReceivingFrames(sessionId: String) -> Bool { appliedFrames[sessionId] == true }
    private var visibilityWatches: [String: AnyCancellable] = [:]
    private(set) var isConnected = false
    /// A protocol or home mismatch: retrying cannot fix it, so nothing retries until the wanted set empties.
    private(set) var isBlocked = false

    private var syncing = false
    private var dirty = false
    private var eventsTask: Task<Void, Never>?
    private var failureLogged = false

    /// - Parameters:
    ///   - sleep: how backoff waits — real time in the app, instant in tests.
    ///   - log: one line per change of connection state (never per attempt).
    init(client: any ComputerUseHelperClient,
         makeSink: @escaping @MainActor (String) -> any MirrorSink = { _ in CUMirrorModel() },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
         log: @escaping (String) -> Void = { _ in }) {
        self.client = client
        self.makeSink = makeSink
        self.sleep = sleep
        self.log = log
        eventsTask = Task { [weak self] in
            guard let events = self?.client.events else { return }
            for await event in events {
                guard let self else { return }
                self.route(event)
            }
        }
    }

    /// Stops listening to the helper (tests; the app's coordinator lives as long as the app).
    func shutdown() { eventsTask?.cancel(); eventsTask = nil }

    // MARK: Windows

    /// A window opened, or its session or width changed.
    func setWindow(_ window: MirrorWindow) {
        let was = eligibleWindowIds.contains(window.id)
        windows[window.id] = window
        let now = MirrorRules.isEligible(window, wasEligible: was)
        if now != was {
            if now { eligibleWindowIds.insert(window.id) } else { eligibleWindowIds.remove(window.id) }
        }
        scheduleSync()
    }

    func removeWindow(id: String) {
        windows.removeValue(forKey: id)
        if eligibleWindowIds.contains(id) { eligibleWindowIds.remove(id) }
        scheduleSync()
    }

    func isEligible(windowId: String) -> Bool { eligibleWindowIds.contains(windowId) }

    /// The sessions an eligible window is open on.
    var desiredSessions: Set<String> {
        MirrorRules.subscriptions(eligible: windows.values.filter { eligibleWindowIds.contains($0.id) })
    }

    /// Whether the session's turn runs, as the window showing it knows. The mirror comes down when it stops.
    func setTurnRunning(sessionId: String, running: Bool) {
        state(for: sessionId).setTurnRunning(running)
    }

    /// A session's mirror state, made on first ask so a panel can watch it before anything is subscribed.
    func state(for sessionId: String) -> MirrorSessionState {
        if let existing = states[sessionId] { return existing }
        let created = MirrorSessionState(sessionId: sessionId, sink: makeSink(sessionId))
        states[sessionId] = created
        // The mirror coming up or down is what turns frames on and off (`wantsFrames`).
        visibilityWatches[sessionId] = created.$isVisible.dropFirst().removeDuplicates().sink { [weak self] _ in
            self?.scheduleSync()
        }
        return created
    }

    // MARK: Events

    private func route(_ event: HelperViewEvent) {
        switch event {
        case .bound(let sessionId, let target): states[sessionId]?.bound(target)
        case .released(let sessionId, let targetId): states[sessionId]?.released(targetId)
        case .frame(let frame): states[frame.sessionId]?.frame(frame)
        case .cursor(let cursor): states[cursor.sessionId]?.cursor(cursor)
        case .connectionLost:
            isConnected = false
            appliedFrames = [:]
            states.values.forEach { $0.reset() }
            if !desiredSessions.isEmpty { log("computer-use helper connection lost; will reconnect") }
            scheduleSync()
        }
    }

    // MARK: Connection and subscriptions

    private func scheduleSync() {
        if syncing { dirty = true; return }
        syncing = true
        Task { await self.runSync() }
    }

    private func runSync() async {
        repeat {
            dirty = false
            await syncOnce()
        } while dirty
        syncing = false
    }

    private func syncOnce() async {
        let desired = desiredSessions
        if desired.isEmpty {
            isBlocked = false
            failureLogged = false
            if isConnected || !appliedFrames.isEmpty {
                // Say so before leaving: the helper stops capturing at the unsubscribe, not at some later close.
                for sessionId in appliedFrames.keys { try? await client.unsubscribe(sessionId: sessionId) }
                await client.disconnect()
                isConnected = false
                appliedFrames = [:]
                states.values.forEach { $0.reset() }
            }
            purgeUnusedStates()
            return
        }
        if isBlocked { return }
        if !isConnected {
            guard await connectWithBackoff() else { return }
        }
        for sessionId in applied.subtracting(desired) {
            try? await client.unsubscribe(sessionId: sessionId)
            appliedFrames.removeValue(forKey: sessionId)
            states[sessionId]?.reset()
        }
        for sessionId in desiredSessions {
            // Frames only while the mirror is actually up and someone can see it: ten JPEGs a second
            // cost the helper a capture and this app a decode, and an idle session has nothing to show.
            // Without frames the subscription still brings bound, released and cursor.
            let frames = wantsFrames(sessionId)
            guard appliedFrames[sessionId] != frames else { continue }
            do {
                let targets = try await client.subscribe(sessionId: sessionId, frames: frames, maxFps: nil, maxWidth: nil)
                let first = appliedFrames[sessionId] == nil
                appliedFrames[sessionId] = frames
                // A change of the frames flag re-sends the same bound targets; only the first is news.
                if first { state(for: sessionId).seed(targets) }
            } catch {
                // The helper went away mid-call: start over from the connection.
                isConnected = false
                appliedFrames = [:]
                await client.disconnect()
                dirty = true
                return
            }
        }
        purgeUnusedStates()
    }

    /// Connects, retrying with backoff while a subscription is still wanted. A missing socket is the
    /// helper not running — the daemon launches it, never this — so it is retried quietly. Returns
    /// whether it connected.
    private func connectWithBackoff() async -> Bool {
        var delay = 0.5
        while !desiredSessions.isEmpty {
            do {
                try await client.connect()
                isConnected = true
                if failureLogged { log("computer-use helper connected"); failureLogged = false }
                return true
            } catch let error as HelperClientError where error.isTerminal {
                isBlocked = true
                log("computer-use helper refused this app (\(error)); the mirror stays off")
                return false
            } catch {
                if !failureLogged { failureLogged = true; log("computer-use helper not reachable; retrying quietly") }
            }
            await sleep(.seconds(delay))
            delay = min(delay * 2, 10)
        }
        return false
    }

    /// Whether `sessionId` should be sent frames: a target is bound, its turn is running (the mirror is up)
    /// and at least one window that shows the mirror for it is on screen.
    func wantsFrames(_ sessionId: String) -> Bool {
        guard let state = states[sessionId], state.isVisible else { return false }
        return windows.values.contains { eligibleWindowIds.contains($0.id) && $0.sessionId == sessionId && $0.isVisible }
    }

    /// Drops the state of a session no window shows any more, so a long-lived app does not keep one per
    /// session it ever opened.
    private func purgeUnusedStates() {
        let shown = Set(windows.values.compactMap(\.sessionId))
        for sessionId in states.keys where !shown.contains(sessionId) && !applied.contains(sessionId) {
            states[sessionId]?.reset()
            states.removeValue(forKey: sessionId)
            visibilityWatches.removeValue(forKey: sessionId)
        }
    }
}
