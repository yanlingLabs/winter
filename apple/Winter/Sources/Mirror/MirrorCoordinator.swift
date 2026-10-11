import Combine
import CoreGraphics
import Foundation
import WinterCUPresentation
import WinterKit
import WinterSessionKit

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
    /// Another target takes over on the same panel: drop the previous picture and cursor, keep the panel up.
    func resetPicture()
    func clear()
}

extension CUMirrorModel: MirrorSink {}

// MARK: - Targets

/// A session's bound targets, least recently active first; the one SHOWN is the last.
///
/// A target becomes the most recent when it is bound (the first time) and when the agent ACTS in it — a
/// `view.cursor` of an action kind, see `actionKinds` — so the mirror follows the app the agent is working in
/// and stays on it until another bound target gets an action. A wait, a caption, a rest or a fade is not an
/// action (the helper may emit those for several targets at once), and a `view.bound` for a target already
/// known (the helper re-announces on every `target.bind`/`useWindow`) refreshes it without moving it. When the
/// shown target is released the one active before it takes over.
struct MirrorTargetTracker: Equatable {
    private(set) var targets: [HelperTarget] = []

    var shown: HelperTarget? { targets.last }

    /// The cursor kinds that mean the agent acts in a target (the core's strings, as `CUCursorKind(core:)` reads them).
    static let actionKinds: Set<String> = [
        "target", "press", "click", "doubleClick", "rightClick", "type", "paste", "setValue", "key", "scroll", "drag",
    ]

    static func isActivity(kind: String) -> Bool { actionKinds.contains(kind) }

    func contains(_ targetId: String) -> Bool { targets.contains { $0.targetId == targetId } }

    /// The helper's answer to `view.subscribe`: its bound targets, sorted by id — not by recency, so the order
    /// already known is kept (a target that was shown stays shown) and only targets not known yet are added.
    mutating func seed(_ seeded: [HelperTarget]) {
        var result: [HelperTarget] = []
        for known in targets {
            if let fresh = seeded.first(where: { $0.targetId == known.targetId }) { result.append(Self.merged(fresh, over: known)) }
        }
        for target in seeded where !result.contains(where: { $0.targetId == target.targetId }) { result.append(target) }
        targets = result
    }

    /// A target bound. New: it becomes the most recent. Known: its facts are refreshed where it stands. A size that
    /// reads zero (the window is on another Space or display) keeps the last real one.
    mutating func bound(_ target: HelperTarget) {
        if let index = targets.firstIndex(where: { $0.targetId == target.targetId }) {
            targets[index] = Self.merged(target, over: targets[index])
        } else {
            targets.append(target)
        }
    }

    private static func merged(_ fresh: HelperTarget, over known: HelperTarget) -> HelperTarget {
        isUsable(fresh.windowSize) ? fresh : fresh.with(windowSize: known.windowSize)
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
    @discardableResult
    mutating func activity(in targetId: String) -> Bool {
        guard shown?.targetId != targetId, let index = targets.firstIndex(where: { $0.targetId == targetId }) else { return false }
        targets.append(targets.remove(at: index))
        return true
    }

    /// A target's window changed size (a frame said so). A size that reads zero changes nothing. Returns whether
    /// anything changed.
    @discardableResult
    mutating func resize(_ targetId: String, to size: CGSize) -> Bool {
        guard Self.isUsable(size), let index = targets.firstIndex(where: { $0.targetId == targetId }),
              targets[index].windowSize != size else { return false }
        targets[index] = targets[index].with(windowSize: size)
        return true
    }

    mutating func reset() { targets = [] }

    static func isUsable(_ size: CGSize) -> Bool { size.width > 0 && size.height > 0 }
}

extension HelperTarget {
    func with(windowSize: CGSize) -> HelperTarget {
        HelperTarget(targetId: targetId, pid: pid, windowId: windowId, appName: appName, bundleId: bundleId, windowSize: windowSize)
    }
}

// MARK: - Not flapping

/// A switch from the thing on show to another needs the other to keep acting: two action events in a row,
/// with nothing from the thing on show between them. A single event from somewhere else — a helper that
/// narrates several targets while it waits, a hover — never moves the mirror.
struct MirrorDebounce {
    /// An action event older than this no longer counts toward the second one.
    static let staleAfter: TimeInterval = 2
    private var candidate: (key: String, last: TimeInterval, count: Int)?

    /// An action by `key` while `leader` is on show. Returns true when `key` should take over now.
    mutating func act(_ key: String, leader: String?, now: TimeInterval) -> Bool {
        if key == leader { candidate = nil; return false }
        if let current = candidate, current.key == key, now - current.last <= Self.staleAfter {
            candidate = nil
            return current.count + 1 >= 2
        }
        candidate = (key, now, 1)
        return false
    }

    mutating func reset() { candidate = nil }
}

/// What the sessions of one coordinator share: who is on show across them (a Dispatch window shows its
/// children's mirrors — the one that acted most recently), and the clock the debounce reads.
@MainActor
final class MirrorFocus {
    let clock: () -> TimeInterval
    private var counter = 0
    private var leader: String?
    private var debounce = MirrorDebounce()

    init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) { self.clock = clock }

    /// `sessionId`'s mirror took the window over (came up, or was acted in): the stamp that orders sessions.
    func claim(_ sessionId: String) -> Int {
        counter += 1
        leader = sessionId
        debounce.reset()
        return counter
    }

    /// An action event in `sessionId`. True when it should take the window over from the leader.
    func acted(in sessionId: String) -> Bool {
        debounce.act(sessionId, leader: leader, now: clock())
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
///
/// Frames and cursor events go straight to the sink (the CU model, which decodes off the main thread): none
/// of them writes anything `@Published` here unless the SHAPE of what is shown changes — the target on show,
/// its size, how many others there are — so nothing that observes this object (or the coordinator) is
/// invalidated per frame.
@MainActor
final class MirrorSessionState: ObservableObject {
    let sessionId: String
    let sink: any MirrorSink
    private let focus: MirrorFocus
    private(set) var tracker = MirrorTargetTracker()
    /// The target on show: the one the agent last acted in.
    @Published private(set) var shownTarget: HelperTarget?
    /// Whether the mirror is up: a target is bound.
    @Published private(set) var isVisible = false
    /// How many other targets are bound beside the one on show.
    @Published private(set) var otherTargets = 0
    /// When this session's mirror last came up or took the window over — the larger, the more recent. A window
    /// that shows several sessions' mirrors (a Dispatch session and its children) shows the largest.
    @Published private(set) var recency = 0
    /// The newest frame of every bound target, kept undecoded so a target that takes over can show its own
    /// picture at once instead of the previous app's.
    private var lastFrames: [String: HelperFrame] = [:]
    private var targetDebounce = MirrorDebounce()
    private var shownOnSink: (id: String, app: String)?
    private var sizeOnSink: CGSize = .zero
    private var othersOnSink = 0

    init(sessionId: String, sink: any MirrorSink, focus: MirrorFocus? = nil) {
        self.sessionId = sessionId
        self.sink = sink
        self.focus = focus ?? MirrorFocus()
    }

    var panelSize: CGSize { mirrorPanelSize(windowSize: shownTarget?.windowSize ?? .zero) }

    /// The helper's answer to `view.subscribe`. A mirror that comes up with it claims the window; one that
    /// was up before (a reconnect) keeps its place.
    func seed(_ targets: [HelperTarget]) {
        tracker.seed(targets)
        refresh(claim: recency == 0)
    }

    /// A target is bound. A new one takes the mirror; one already known only has its facts refreshed.
    func bound(_ target: HelperTarget) {
        let isNew = !tracker.contains(target.targetId)
        tracker.bound(target)
        refresh(claim: isNew)
    }

    func released(_ targetId: String) {
        guard tracker.released(targetId) else { return }
        lastFrames.removeValue(forKey: targetId)
        refresh(claim: false)
    }

    func reset() {
        tracker.reset()
        targetDebounce.reset()
        refresh(claim: false)
    }

    func frame(_ frame: HelperFrame) {
        guard tracker.contains(frame.targetId) else { return }
        // Kept for every bound target; only the shown one reaches the sink.
        lastFrames[frame.targetId] = frame
        let resized = tracker.resize(frame.targetId, to: frame.windowSize)
        guard tracker.shown?.targetId == frame.targetId else { return }
        if resized, let shown = tracker.shown {
            shownTarget = shown
            sizeOnSink = shown.windowSize
        }
        sink.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
    }

    func cursor(_ cursor: HelperCursor) {
        guard tracker.contains(cursor.targetId) else { return }
        if MirrorTargetTracker.isActivity(kind: cursor.kind) {
            // The agent is acting here. Within the session another target must keep acting to take the mirror
            // over; across sessions this one must keep acting to take the window over.
            if targetDebounce.act(cursor.targetId, leader: tracker.shown?.targetId, now: focus.clock()),
               tracker.activity(in: cursor.targetId) {
                refresh(claim: false)
            }
            if focus.acted(in: sessionId) { recency = focus.claim(sessionId) }
        }
        guard tracker.shown?.targetId == cursor.targetId else { return }
        sink.applyCursor(kind: cursor.kind, point: cursor.point, dragTo: cursor.dragTo, frame: cursor.frame,
                         text: cursor.text, count: cursor.count, button: cursor.button)
    }

    /// Recomputes what is shown and tells the sink on every change: `show` when the mirror comes up, another
    /// target takes over (the previous picture and cursor reset — never a `clear`, the panel stays — then the new
    /// target's newest frame if one is known, a grey placeholder if not), or the size changes; `clear` when it goes
    /// down. `claim` stamps this session as the one the window shows when the mirror comes up or a target is bound.
    private func refresh(claim: Bool) {
        let target = tracker.shown
        if shownTarget != target { shownTarget = target }
        let others = max(tracker.targets.count - 1, 0)
        if otherTargets != others { otherTargets = others }
        if lastFrames.keys.contains(where: { !tracker.contains($0) }) { lastFrames = lastFrames.filter { tracker.contains($0.key) } }
        if let target {
            if shownOnSink?.id != target.targetId {
                let wasUp = shownOnSink != nil
                sink.show(appName: target.appName, windowSize: target.windowSize)
                if wasUp { sink.resetPicture() } // a fresh panel has nothing of another app's to drop
                shownOnSink = (target.targetId, target.appName)
                sizeOnSink = target.windowSize
                if wasUp { targetDebounce.reset() }
                if let frame = lastFrames[target.targetId] {
                    sink.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
                }
            } else if shownOnSink?.app != target.appName
                        || (MirrorTargetTracker.isUsable(target.windowSize) && target.windowSize != sizeOnSink) {
                sink.show(appName: target.appName, windowSize: target.windowSize)
                shownOnSink = (target.targetId, target.appName)
                sizeOnSink = target.windowSize
            }
            if othersOnSink != others {
                sink.setOtherTargets(others)
                othersOnSink = others
            }
            if claim || recency == 0 { recency = focus.claim(sessionId) }
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
    private let focus: MirrorFocus
    /// ComputerV2 Phase 1b: the phone mirror's source. Every session's sink is teed to it, so a paired phone is shown
    /// exactly what this coordinator's mirror shows. `nil` in tests that do not exercise the phone, and under the
    /// unit-test host.
    private let remote: RemoteMirrorHub?
    /// ComputerV2 Phase 1b (controller ruling 2026-10-10): a PHONE WATCH IS A VIEWER IN ITS OWN RIGHT. While a paired
    /// phone watches a session (`addRemoteViewer`), the session is subscribed with frames exactly as a visible window
    /// would have it — whether or not any Winter window on the Mac shows it — through this same one helper connection.
    /// Ref-counted beside the windows: a window closing never stops the phone's pictures, and a phone leaving never
    /// stops a window's. Still never a launch of the helper, and still never anything that moves the user's view: the
    /// helper's view capture only ever reads the bound window.
    private var remoteViewers: [String: Int] = [:]
    /// When the last phone stops watching a session, its count rests at 0 for `remoteViewerGrace` before the session
    /// leaves `desiredSessions` — a phone that comes right back (a reconnect, a hop out of the screen and in) reuses
    /// the subscription instead of closing and reopening the helper's capture (review finding 10).
    private var remoteGraceTasks: [String: Task<Void, Never>] = [:]
    private let remoteViewerGrace: Duration

    private(set) var windows: [String: MirrorWindow] = [:]
    /// The windows that show the mirror right now — what the panels watch.
    @Published private(set) var eligibleWindowIds: Set<String> = []
    private var states: [String: MirrorSessionState] = [:]

    /// What a session's `view.subscribe` asks: frames or not, and — when only a phone wants the frames — the phone's
    /// own caps, so the helper captures no more than the phone takes (`nil` is the helper's default, the Mac's panel).
    struct Subscription: Equatable {
        let frames: Bool
        let maxFps: Int?
        let maxWidth: Int?

        static let none = Subscription(frames: false, maxFps: nil, maxWidth: nil)
        static let mac = Subscription(frames: true, maxFps: nil, maxWidth: nil)
        static let phone = Subscription(frames: true, maxFps: MirrorWire.activeFps, maxWidth: MirrorWire.maxLongEdge)
    }

    /// The sessions subscribed on the helper right now, and what each asked. Every change of a session's frames flag is
    /// told to the phone mirror's hub (`live`).
    private var appliedSubscriptions: [String: Subscription] = [:] {
        didSet {
            guard let remote else { return }
            for id in Set(oldValue.keys).union(appliedSubscriptions.keys)
                where (oldValue[id]?.frames == true) != (appliedSubscriptions[id]?.frames == true) {
                remote.framesChanged(id, live: appliedSubscriptions[id]?.frames == true)
            }
        }
    }
    var applied: Set<String> { Set(appliedSubscriptions.keys) }
    /// Whether the session is subscribed WITH frames right now (tests).
    func isReceivingFrames(sessionId: String) -> Bool { appliedSubscriptions[sessionId]?.frames == true }
    /// What the session is subscribed with right now (tests).
    func appliedSubscription(sessionId: String) -> Subscription? { appliedSubscriptions[sessionId] }
    private var visibilityWatches: [String: AnyCancellable] = [:]
    private(set) var isConnected = false
    /// A protocol or home mismatch: retrying cannot fix it, so nothing retries until the wanted set empties.
    private(set) var isBlocked = false

    private var syncing = false
    private var dirty = false
    private var eventsTask: Task<Void, Never>?
    private var failureLogged = false
    /// How long to wait before starting over after a failed `view.subscribe`.
    private var failureDelay = 0.5

    /// - Parameters:
    ///   - sleep: how backoff waits — real time in the app, instant in tests.
    ///   - log: one line per change of connection state (never per attempt).
    init(client: any ComputerUseHelperClient,
         makeSink: @escaping @MainActor (String) -> any MirrorSink = { _ in CUMirrorModel() },
         sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
         log: @escaping (String) -> Void = { _ in },
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         remote: RemoteMirrorHub? = nil,
         remoteViewerGrace: Duration = .seconds(5)) {
        self.client = client
        self.remote = remote
        self.remoteViewerGrace = remoteViewerGrace
        self.makeSink = makeSink
        self.sleep = sleep
        self.log = log
        self.focus = MirrorFocus(clock: now)
        remote?.coordinator = self
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

    /// What of a session's shown target a window must re-read: which target, and the size its panel is cut to.
    private struct ShownKey: Equatable {
        let id: String?
        let size: CGSize
        init(_ target: HelperTarget?) {
            id = target?.targetId
            size = target?.windowSize ?? .zero
        }
    }

    // MARK: Windows

    /// A window opened, or its session or width changed.
    func setWindow(_ window: MirrorWindow) {
        let was = eligibleWindowIds.contains(window.id)
        windows[window.id] = window
        let now = MirrorRules.isEligible(window, wasEligible: was)
        if now != was {
            if now { eligibleWindowIds.insert(window.id) } else { eligibleWindowIds.remove(window.id) }
        }
        refreshMacPictures()
        scheduleSync()
    }

    func removeWindow(id: String) {
        windows.removeValue(forKey: id)
        if eligibleWindowIds.contains(id) { eligibleWindowIds.remove(id) }
        refreshMacPictures()
        scheduleSync()
    }

    // MARK: Phone viewers (ComputerV2 Phase 1b)

    /// A paired phone started watching `sessionId` (`RemoteMirrorHub`). Each call is one viewer; pair it with
    /// `removeRemoteViewer`.
    func addRemoteViewer(_ sessionId: String) {
        remoteGraceTasks.removeValue(forKey: sessionId)?.cancel() // back within the grace: the subscription is reused
        remoteViewers[sessionId, default: 0] += 1
        scheduleSync()
    }

    /// A phone's watch of `sessionId` ended. The subscription it held closes once no window and no other phone wants
    /// it — after `remoteViewerGrace`, in case the phone comes right back.
    func removeRemoteViewer(_ sessionId: String) {
        guard let count = remoteViewers[sessionId], count > 0 else { return }
        if count > 1 {
            remoteViewers[sessionId] = count - 1
            return
        }
        remoteViewers[sessionId] = 0
        remoteGraceTasks[sessionId]?.cancel()
        let grace = remoteViewerGrace
        let sleep = self.sleep
        remoteGraceTasks[sessionId] = Task { [weak self] in
            await sleep(grace)
            guard !Task.isCancelled, let self, self.remoteViewers[sessionId] == 0 else { return }
            self.remoteViewers.removeValue(forKey: sessionId)
            self.remoteGraceTasks.removeValue(forKey: sessionId)
            self.scheduleSync()
        }
    }

    /// How many phones watch `sessionId` (tests).
    func remoteViewerCount(_ sessionId: String) -> Int { remoteViewers[sessionId] ?? 0 }
    /// Whether a phone-only subscription of `sessionId` is resting in its grace (tests).
    func isInRemoteGrace(_ sessionId: String) -> Bool { remoteViewers[sessionId] == 0 }

    /// Pictures reach a session's Mac panel model only while a visible eligible window shows the session: a session
    /// subscribed only for a phone (or whose window is hidden) does not have every picture decoded for a panel nobody
    /// sees. The panel gets the newest withheld picture the moment a window shows it again.
    private func refreshMacPictures() {
        for (id, state) in states {
            (state.sink as? RemoteTeeSink)?.setPrimaryPictures(macWantsFrames(id))
        }
    }

    func isEligible(windowId: String) -> Bool { eligibleWindowIds.contains(windowId) }

    /// The sessions an eligible window is open on, and those a paired phone watches.
    var desiredSessions: Set<String> {
        MirrorRules.subscriptions(eligible: windows.values.filter { eligibleWindowIds.contains($0.id) })
            .union(remoteViewers.keys)
    }

    /// A session's mirror state, made on first ask so a panel can watch it before anything is subscribed.
    func state(for sessionId: String) -> MirrorSessionState {
        if let existing = states[sessionId] { return existing }
        let own = makeSink(sessionId)
        let sink: any MirrorSink
        if let remote {
            let tee = RemoteTeeSink(primary: own, sessionId: sessionId, hub: remote)
            tee.setPrimaryPictures(macWantsFrames(sessionId))
            sink = tee
        } else {
            sink = own
        }
        let created = MirrorSessionState(sessionId: sessionId, sink: sink, focus: focus)
        states[sessionId] = created
        // The mirror coming up, going down or changing hands is what a window must re-read to know which session's
        // mirror to show. Nothing else (frames, cursors, a size) reaches here, and nothing needs a new subscription.
        visibilityWatches[sessionId] = Publishers.CombineLatest(created.$shownTarget.map(ShownKey.init), created.$recency)
            .dropFirst()
            .removeDuplicates { $0 == $1 }
            .sink { [weak self] _ in self?.objectWillChange.send() }
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
            appliedSubscriptions = [:]
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
            if isConnected || !appliedSubscriptions.isEmpty {
                // Say so before leaving: the helper stops capturing at the unsubscribe, not at some later close.
                for sessionId in appliedSubscriptions.keys { try? await client.unsubscribe(sessionId: sessionId) }
                await client.disconnect()
                isConnected = false
                appliedSubscriptions = [:]
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
            appliedSubscriptions.removeValue(forKey: sessionId)
            states[sessionId]?.reset()
        }
        for sessionId in desiredSessions {
            // Frames while a window that can be seen watches the session, or a paired phone does, from this very
            // first subscribe; without them (a minimized or covered window, no phone) the subscription still brings
            // bound, released and cursor. A change of options (a phone-only session gaining or losing its window)
            // is a repeat subscribe, which the helper applies in place.
            let wanted = subscription(for: sessionId)
            guard appliedSubscriptions[sessionId] != wanted else { continue }
            do {
                let targets = try await client.subscribe(sessionId: sessionId, frames: wanted.frames, maxFps: wanted.maxFps, maxWidth: wanted.maxWidth)
                let first = appliedSubscriptions[sessionId] == nil
                appliedSubscriptions[sessionId] = wanted
                // A change of the frames flag re-sends the same bound targets; only the first is news.
                if first { state(for: sessionId).seed(targets) }
            } catch {
                // The helper went away mid-call: start over from the connection — after a wait that doubles
                // while it keeps failing, so a helper that refuses the same call forever is not hammered with
                // connect → subscribe → disconnect cycles.
                isConnected = false
                appliedSubscriptions = [:]
                await client.disconnect()
                await sleep(.seconds(failureDelay))
                failureDelay = min(failureDelay * 2, 10)
                dirty = true
                return
            }
        }
        failureDelay = 0.5
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
                log("computer-use helper: \(error) — the mirror stays off")
                return false
            } catch {
                if !failureLogged { failureLogged = true; log("computer-use helper not reachable; retrying quietly") }
            }
            await sleep(.seconds(delay))
            delay = min(delay * 2, 10)
        }
        return false
    }

    /// Whether `sessionId` should be sent frames: some eligible window that is on screen shows it or the work
    /// of it. Asked from the very first subscribe (the helper answers a new frames subscriber with the newest
    /// frame it has at once, so a window that opens or a target that takes over is not grey while it waits) and
    /// kept for every session a window watches, so a change of which one is on show never restarts a capture on
    /// the helper. A window that is minimized, ordered out or covered gets none.
    func wantsFrames(_ sessionId: String) -> Bool {
        macWantsFrames(sessionId) || remoteViewers[sessionId] != nil
    }

    /// A visible eligible Winter window shows the session or the work of it.
    func macWantsFrames(_ sessionId: String) -> Bool {
        windows.values.contains { window in
            eligibleWindowIds.contains(window.id) && window.isVisible && window.allSessionIds.contains(sessionId)
        }
    }

    /// What `sessionId`'s subscription should ask right now: the Mac's own options when a visible window wants
    /// pictures (the phone's relay cuts them down for itself), the phone's caps when only a phone does, no frames when
    /// neither does.
    func subscription(for sessionId: String) -> Subscription {
        if macWantsFrames(sessionId) { return .mac }
        if remoteViewers[sessionId] != nil { return .phone }
        return .none
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
        let shown = Set(windows.values.flatMap(\.allSessionIds)).union(remoteViewers.keys)
        for sessionId in states.keys where !shown.contains(sessionId) && !applied.contains(sessionId) {
            states[sessionId]?.reset()
            states.removeValue(forKey: sessionId)
            visibilityWatches.removeValue(forKey: sessionId)
        }
    }
}
