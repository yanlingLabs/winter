import CoreGraphics
import Foundation
import WinterKit
import WinterSessionKit

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 1b — the phone mirror's source inside Winter.app.
//
//   MirrorSessionState ──MirrorSink calls──▶ RemoteTeeSink ──▶ CUMirrorModel (the Mac's own panel)
//                                                       └──▶ RemoteMirrorHub ──▶ Gateway ──▶ the phone
//
// The phone sees EXACTLY what Winter.app's mirror shows for a session — the same target on show (chosen by the
// same `MirrorSessionState`), the same pictures, the same cursor — because it is fed by the very calls that draw
// the Mac's panel.
//
// A PHONE WATCH IS A VIEWER IN ITS OWN RIGHT (controller ruling 2026-10-10): while a phone watches, the hub registers
// it with the coordinator (`addRemoteViewer`), which subscribes the session with frames over its one helper
// connection exactly as a visible window would — so pictures flow whether the Mac's window on the session is visible,
// hidden, on another Space or not open at all — and ref-counts it beside the windows. The hub never launches the
// helper and asks for nothing but the helper's view of the bound window, which moves, activates or raises nothing:
// the never-move-the-view rule holds. The capture's cost exists only while a phone (or a visible window) watches.
//
// The same exclusions hold by construction: the mirror only ever shows a target the helper bound, and binding
// Winter itself, a denied app or an auth surface is refused before anything is bound; with `computerUse.mirror` off
// the helper captures nothing and the daemon refuses the phone's watch.
// -----------------------------------------------------------------------------------------------

/// What one session's mirror shows right now, kept so a phone that starts watching gets it at once.
private struct RemoteMirrorSnapshot {
    var app: String?
    var windowSize: CGSize = .zero
    var others = 0
    var live = false
    var frame: MirrorFrame?
    var seq = 0
}

@MainActor
final class RemoteMirrorHub {
    private var snapshots: [String: RemoteMirrorSnapshot] = [:]
    private var watchers: [String: [UUID: @Sendable (MirrorUpdate) -> Void]] = [:]
    /// The coordinator a phone watch is a viewer of — set by the coordinator itself when it is made with this hub.
    weak var coordinator: MirrorCoordinator?
    /// Makes the coordinator when a phone watches before any Winter window ever needed one (the app's lazy
    /// `mirrorCoordinator`). `nil` in tests, which make their own.
    var makeCoordinator: (@MainActor () -> MirrorCoordinator?)?

    init() {}

    private var viewerHost: MirrorCoordinator? { coordinator ?? makeCoordinator?() }

    /// How many phones watch `sessionId` (tests).
    func watcherCount(sessionId: String) -> Int { watchers[sessionId]?.count ?? 0 }

    // MARK: - From the Mac's mirror (the tee sink)

    func show(_ sessionId: String, appName: String, windowSize: CGSize) {
        var snap = snapshots[sessionId] ?? RemoteMirrorSnapshot()
        snap.app = appName
        if windowSize.width > 0, windowSize.height > 0 { snap.windowSize = windowSize }
        snapshots[sessionId] = snap
        deliverShow(sessionId)
    }

    func apply(_ sessionId: String, frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        var snap = snapshots[sessionId] ?? RemoteMirrorSnapshot()
        snap.seq += 1
        let frame = MirrorFrame(seq: snap.seq, jpeg: jpeg, width: width, height: height, windowSize: windowSize)
        snap.frame = frame
        if windowSize.width > 0, windowSize.height > 0 { snap.windowSize = windowSize }
        snapshots[sessionId] = snap
        deliver(sessionId, .frame(frame))
    }

    func cursor(_ sessionId: String, _ cursor: MirrorCursor) {
        deliver(sessionId, .cursor(cursor))
    }

    func setOtherTargets(_ sessionId: String, _ count: Int) {
        guard var snap = snapshots[sessionId], snap.others != count else { return }
        snap.others = count
        snapshots[sessionId] = snap
        deliverShow(sessionId)
    }

    func resetPicture(_ sessionId: String) {
        snapshots[sessionId]?.frame = nil
        deliver(sessionId, .reset)
    }

    func clear(_ sessionId: String) {
        if var snap = snapshots[sessionId] {
            snap.app = nil
            snap.frame = nil
            snap.others = 0
            snap.windowSize = .zero
            snapshots[sessionId] = snap
            dropIfUnused(sessionId)
        }
        deliver(sessionId, .clear)
    }

    /// Whether the Mac receives pictures for `sessionId` right now (a visible Winter window shows it) — the
    /// coordinator says so whenever its subscription's frames flag changes.
    func framesChanged(_ sessionId: String, live: Bool) {
        var snap = snapshots[sessionId] ?? RemoteMirrorSnapshot()
        guard snap.live != live else { return }
        snap.live = live
        snapshots[sessionId] = snap
        if snap.app != nil { deliverShow(sessionId) }
        dropIfUnused(sessionId)
    }

    /// A session nothing is shown for, that gets no pictures and that no phone watches needs no entry — a long-lived
    /// app does not keep one per session it ever mirrored.
    private func dropIfUnused(_ sessionId: String) {
        guard let snap = snapshots[sessionId], snap.app == nil, !snap.live, watchers[sessionId] == nil else { return }
        snapshots.removeValue(forKey: sessionId)
    }

    /// Sessions the hub keeps a snapshot for (tests).
    var snapshotCount: Int { snapshots.count }

    // MARK: - Phones

    func addWatcher(_ watch: RemoteMirrorWatch, deliver: @escaping @Sendable (MirrorUpdate) -> Void) {
        watchers[watch.sessionId, default: [:]][watch.id] = deliver
        // The phone is a viewer: its session is subscribed with pictures while it watches (see the file header).
        viewerHost?.addRemoteViewer(watch.sessionId)
        // The state on show now: the panel and its newest picture, or nothing.
        if let snap = snapshots[watch.sessionId], let app = snap.app {
            deliver(.show(app: app, windowSize: snap.windowSize, others: snap.others, live: snap.live))
            if let frame = snap.frame { deliver(.frame(frame)) }
        } else {
            deliver(.clear)
        }
    }

    func removeWatcher(_ watch: RemoteMirrorWatch) {
        guard watchers[watch.sessionId]?[watch.id] != nil else { return }
        viewerHost?.removeRemoteViewer(watch.sessionId)
        watchers[watch.sessionId]?.removeValue(forKey: watch.id)
        if watchers[watch.sessionId]?.isEmpty == true { watchers.removeValue(forKey: watch.sessionId) }
        dropIfUnused(watch.sessionId)
    }

    private func deliverShow(_ sessionId: String) {
        guard let snap = snapshots[sessionId], let app = snap.app else { return }
        deliver(sessionId, .show(app: app, windowSize: snap.windowSize, others: snap.others, live: snap.live))
    }

    private func deliver(_ sessionId: String, _ update: MirrorUpdate) {
        guard let targets = watchers[sessionId] else { return }
        for deliver in targets.values { deliver(update) }
    }
}

extension RemoteMirrorHub: RemoteMirrorSource {
    nonisolated func watch(sessionId: String, deliver: @escaping @Sendable (MirrorUpdate) -> Void) async -> RemoteMirrorWatch {
        let watch = RemoteMirrorWatch(sessionId: sessionId)
        await MainActor.run { self.addWatcher(watch, deliver: deliver) }
        return watch
    }

    nonisolated func unwatch(_ watch: RemoteMirrorWatch) async {
        await MainActor.run { self.removeWatcher(watch) }
    }
}

/// The Mac's own mirror sink, with every call also told to the hub — so the phone is fed by the very calls that draw
/// the Mac's panel.
///
/// Pictures reach the Mac's panel model only while it can be seen (`setPrimaryPictures`, from the coordinator: a
/// visible eligible window shows the session): a session subscribed only for a phone, or whose window is hidden, does
/// not have every picture decoded for a panel nobody sees. The newest picture held back is handed over the moment the
/// panel can be seen again, so it never comes up grey. Everything else (the panel, the cursor, a clear) always passes.
@MainActor
final class RemoteTeeSink: MirrorSink {
    let primary: any MirrorSink
    let sessionId: String
    let hub: RemoteMirrorHub
    private(set) var primaryPictures = true
    private var withheld: (jpeg: Data, width: Int, height: Int, windowSize: CGSize)?

    /// Whether pictures reach the Mac's panel model now. Turning it on hands over the newest picture held back.
    func setPrimaryPictures(_ on: Bool) {
        guard on != primaryPictures else { return }
        primaryPictures = on
        if on, let frame = withheld {
            withheld = nil
            primary.apply(frame: frame.jpeg, width: frame.width, height: frame.height, windowSize: frame.windowSize)
        }
    }

    init(primary: any MirrorSink, sessionId: String, hub: RemoteMirrorHub) {
        self.primary = primary
        self.sessionId = sessionId
        self.hub = hub
    }

    func show(appName: String, windowSize: CGSize) {
        primary.show(appName: appName, windowSize: windowSize)
        hub.show(sessionId, appName: appName, windowSize: windowSize)
    }

    func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        if primaryPictures {
            primary.apply(frame: jpeg, width: width, height: height, windowSize: windowSize)
        } else {
            withheld = (jpeg, width, height, windowSize)
        }
        hub.apply(sessionId, frame: jpeg, width: width, height: height, windowSize: windowSize)
    }

    func applyCursor(kind: String, point: CGPoint, dragTo: CGPoint?, frame: CGRect?, text: String?, count: Int?, button: String?) {
        primary.applyCursor(kind: kind, point: point, dragTo: dragTo, frame: frame, text: text, count: count, button: button)
        hub.cursor(sessionId, MirrorCursor(kind: kind, point: point, dragTo: dragTo, frame: frame, text: text, count: count, button: button))
    }

    func setOtherTargets(_ count: Int) {
        primary.setOtherTargets(count)
        hub.setOtherTargets(sessionId, count)
    }

    func resetPicture() {
        withheld = nil
        primary.resetPicture()
        hub.resetPicture(sessionId)
    }

    func clear() {
        withheld = nil
        primary.clear()
        hub.clear(sessionId)
    }
}
