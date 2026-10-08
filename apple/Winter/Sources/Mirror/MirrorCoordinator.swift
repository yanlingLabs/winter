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
    /// How many other targets the session has bound beside the one on show — the caption's "+1".
    func setOtherTargets(_ count: Int)
    func clear()
}

extension CUMirrorModel: MirrorSink {}

// MARK: - Targets

/// A session's bound targets, least recently active first; the one SHOWN is the last.
///
/// A target becomes the most recent when it is bound and again whenever the agent acts in it (a
/// `view.cursor` event that is not a rest or a fade), so the mirror follows the app the agent is
/// working in and stays on it until another bound target gets an action. When the shown target is
/// released the one active before it takes over.
///
/// The spine does not pin the order of `view.subscribe`'s `targets`; it is read as oldest first, so the
/// last is the most recent — the same order `view.bound` notifications arrive in.
struct MirrorTargetTracker: Equatable {
    private(set) var targets: [HelperTarget] = []

    var shown: HelperTarget? { targets.last }

    /// The cursor kinds that mean the agent is NOT acting in the target: it rests, or the cursor fades.
    static func isActivity(kind: String) -> Bool { kind != "idle" && kind != "done" }

    func contains(_ targetId: String) -> Bool { targets.contains { $0.targetId == targetId } }

    mutating func seed(_ seeded: [HelperTarget]) { targets = seeded }

    /// A target bound (again): it becomes the most recent. A size that reads zero (the window is on
    /// another Space or display) keeps the last real one.
    mutating func bound(_ target: HelperTarget) {
        var target = target
        if let previous = targets.first(where: { $0.targetId == target.targetId }), !Self.isUsable(target.windowSize) {
            target = target.with(windowSize: previous.windowSize)
        }
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

    /// The agent acted in `targetId`: it becomes the shown one. Returns whether the shown target changed
    /// (false for a target that is not bound, or already on show).
    mutating func activity(in targetId: String) -> Bool {
        guard shown?.targetId != targetId, let index = targets.firstIndex(where: { $0.targetId == targetId }) else { return false }
        targets.append(targets.remove(at: index))
        return true
    }

    /// A target's window changed size (a frame said so). A size that reads zero changes nothing.
    mutating func resize(_ targetId: String, to size: CGSize) {
        guard Self.isUsable(size), let index = targets.firstIndex(where: { $0.targetId == targetId }),
              targets[index].windowSize != size else { return }
        targets[index] = targets[index].with(windowSize: size)
    }

    mutating func reset() { targets = [] }

    static func isUsable(_ size: CGSize) -> Bool { size.width > 0 && size.height > 0 }
}

extension HelperTarget {
    func with(windowSize: CGSize) -> HelperTarget {
        HelperTarget(targetId: targetId, pid: pid, windowId: windowId, appName: appName, bundleId: bundleId, windowSize: windowSize)
    }
}

// MARK: - One session

/// One session's mirror: its targets, whether the mirror is up, and the sink it feeds.
///
/// The mirror is UP while a target is bound — between turns too (user, 2026-10-08: "it should show at all
/// times"). It comes down on `view.released` of the last target, or when the helper connection is lost
/// and the subscription starts over — never because frames stop or a window reads size zero (the target
/// is on another Space or display): the last picture stays. With several targets bound it shows the one
/// the agent last acted in (`MirrorTargetTracker`), and the caption says how many others there are.
@MainActor
final class MirrorSessionState: ObservableObject {
    let sessionId: String
    let sink: any MirrorSink
    private(set) var tracker = MirrorTargetTracker()
    /// The target on show: the one the agent last acted in.
    @Published private(set) var shownTarget: HelperTarget?
    /// Whether the mirror is up: a target is bound.
    @Published private(set) var isVisible = false
    /// How many other targets are bound beside the one on show.
    @Published private(set) var otherTargets = 0
    /// When this session's mirror last came up, changed target or saw the agent act — the larger, the more
    /// recent. A window that shows several sessions' mirrors (a Dispatch session and its children) shows the
    /// largest.
    @Published private(set) var recency = 0
    private static var recencyCounter = 0
    /// The newest frame of every bound target, kept undecoded so a target that takes over can show its own
    /// picture at once instead of the previous app's.
    private var lastFrames: [String: HelperFrame] = [:]
    private var shownOnSink: String?
    private var sizeOnSink: CGSize = .zero
    private var othersOnSink = 0

    init(sessionId: String, sink: any MirrorSink) {
        self.sessionId = sessionId
        self.sink = sink
    }

    var panelSize: CGSize { mirrorPanelSize(windowSize: shownTarget?.windowSize ?? .zero) }

    func seed(_ targets: [HelperTarget]) { tracker.seed(targets); refresh() }
    func bound(_ target: HelperTarget) { tracker.bound(target); refresh() }
    func released(_ targetId: String) { if tracker.released(targetId) { lastFrames.removeValue(forKey: targetId); refresh() } }
    func reset() { tracker.reset(); refresh() }

    func frame(_ frame: HelperFrame) {
        guard tracker.contains(frame.targetId) else { return }
        // Kept for every bound target; only the shown one reaches the sink.
        lastFrames[frame.targetId] = frame
        tracker.resize(frame.targetId, to: frame.windowSize)
        if tracker.shown?.targetId == frame.targetId {
            if shownTarget != tracker.shown { shownTarget = tracker.shown }
            if let size = tracker.shown?.windowSize { sizeOnSink = size }
            sink.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
        }
    }

    func cursor(_ cursor: HelperCursor) {
        guard tracker.contains(cursor.targetId) else { return }
        if MirrorTargetTracker.isActivity(kind: cursor.kind) {
            // The agent is working in this app: it is the one to watch, and this session the one a window
            // that shows several should watch.
            if tracker.activity(in: cursor.targetId) { refresh() }
            if recency != Self.recencyCounter { markRecent() }
        }
        guard tracker.shown?.targetId == cursor.targetId else { return }
        sink.applyCursor(kind: cursor.kind, point: cursor.point, dragTo: cursor.dragTo, frame: cursor.frame,
                         text: cursor.text, count: cursor.count, button: cursor.button)
    }

    private func markRecent() {
        Self.recencyCounter += 1
        recency = Self.recencyCounter
    }

    /// Recomputes what is shown and tells the sink on every change: `show` when the mirror comes up or
    /// another target takes over (after a `clear`, so the previous app's picture and cursor do not linger,
    /// then the new target's newest frame if one is known), `clear` when it goes down.
    private func refresh() {
        let target = tracker.shown
        if shownTarget != target { shownTarget = target }
        let others = max(tracker.targets.count - 1, 0)
        if otherTargets != others { otherTargets = others }
        let known = Set(tracker.targets.map(\.targetId))
        lastFrames = lastFrames.filter { known.contains($0.key) }
        if let target {
            if shownOnSink != target.targetId {
                if shownOnSink != nil { sink.clear(); othersOnSink = 0 }
                sink.show(appName: target.appName, windowSize: target.windowSize)
                shownOnSink = target.targetId
                sizeOnSink = target.windowSize
                markRecent()
                if let frame = lastFrames[target.targetId] {
                    sink.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
                }
            } else if MirrorTargetTracker.isUsable(target.windowSize), target.windowSize != sizeOnSink {
                sink.show(appName: target.appName, windowSize: target.windowSize)
                sizeOnSink = target.windowSize
            }
            if othersOnSink != others {
                sink.setOtherTargets(others)
                othersOnSink = others
            }
        } else if shownOnSink != nil {
            sink.clear()
            shownOnSink = nil
            sizeOnSink = .zero
            othersOnSink = 0
        }
        let visible = target != nil
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

    /// A session's mirror state, made on first ask so a panel can watch it before anything is subscribed.
    func state(for sessionId: String) -> MirrorSessionState {
        if let existing = states[sessionId] { return existing }
        let created = MirrorSessionState(sessionId: sessionId, sink: makeSink(sessionId))
        states[sessionId] = created
        // The mirror coming up, going down, changing target or seeing the agent act is what moves frames
        // (`wantsFrames`) — and what a window must re-read to know which session's mirror to show.
        visibilityWatches[sessionId] = Publishers.CombineLatest(created.$shownTarget.map { $0?.targetId }, created.$recency)
            .dropFirst()
            .removeDuplicates { $0 == $1 }
            .sink { [weak self] _ in
                self?.objectWillChange.send()
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

    /// Whether `sessionId` should be sent frames: some eligible window that is on screen shows its mirror,
    /// or — when none of that window's sessions has a target yet — would show it the moment one binds.
    /// A target bound and a window up is all it takes: between turns too, since the helper slows an
    /// unchanging picture down on its own, and asking in advance means the first frame of a newly bound
    /// target does not wait on a re-subscribe round trip.
    func wantsFrames(_ sessionId: String) -> Bool {
        windows.values.contains { window in
            guard eligibleWindowIds.contains(window.id), window.isVisible else { return false }
            if let shown = shownSession(forWindow: window.id) { return shown == sessionId }
            return window.sessionId == sessionId
        }
    }

    /// The session whose mirror a window shows: among its own session and the ones it shows the work of,
    /// the one with a bound target that came up most recently. Nil when none has a target.
    func shownSession(forWindow windowId: String) -> String? {
        guard let window = windows[windowId], eligibleWindowIds.contains(windowId) else { return nil }
        var best: (id: String, recency: Int)?
        for id in window.allSessionIds {
            guard let state = states[id], state.isVisible else { continue }
            if best == nil || state.recency > best!.recency { best = (id, state.recency) }
        }
        return best?.id
    }

    /// Drops the state of a session no window shows any more, so a long-lived app does not keep one per
    /// session it ever opened.
    private func purgeUnusedStates() {
        let shown = Set(windows.values.flatMap(\.allSessionIds))
        for sessionId in states.keys where !shown.contains(sessionId) && !applied.contains(sessionId) {
            states[sessionId]?.reset()
            states.removeValue(forKey: sessionId)
            visibilityWatches.removeValue(forKey: sessionId)
        }
    }
}
