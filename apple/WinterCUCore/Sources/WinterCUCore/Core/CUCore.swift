import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The automation engine behind the helper's RPC (spine §2.1, §3b): one `async throws` method per helper
/// method except `hello` and the lifecycle calls the shell answers itself. Params and results are the
/// `<Name>Params` / `<Name>Result` structs whose property names are the JSON keys; failures are `CUError`
/// with a §2.3 code.
///
/// Threading: no method blocks the caller's thread or the main thread. AX work runs on one serial queue per
/// target pid (`CUPidQueues`), capture on the capture actor, waits on the cooperative pool. Events go to
/// `CUCoreEvents` on the main actor.
public final class CUCore: @unchecked Sendable {
    public weak var events: (any CUCoreEvents)?

    let clock: CUClock
    let skyLight: CUSkyLight
    let poster: CUEventPoster
    /// AX calls of the action path and the floors; injectable so the gates are testable with fakes.
    let ax: CUAXBackend
    /// Process and window-server facts and rung 4's global effects; injectable likewise.
    let sys: CUSystemBackend
    /// The clipboard `paste` saves and restores.
    let pasteboard: () -> CUPasteboardIO
    let queues = CUPidQueues()
    let cancels = CUCancellation()
    let monitor: CUAXActivityMonitor
    let capturer = CUCapturer()
    let formatter = CUStateFormatter()
    var settler: CUSettler { CUSettler(clock: clock, source: CULiveActivity(monitor: monitor)) }
    var synth: CUEventSynth {
        var s = CUEventSynth(poster: poster, skyLight: skyLight)
        let sys = self.sys
        s.windowOrigin = { sys.window(id: $0)?.frame.origin }
        return s
    }

    /// The synth for one act: the window SPIs only while the private event path is on.
    func synth(_ p: TargetActParams) -> CUEventSynth {
        var s = synth
        s.windowSPI = p.privatePath
        return s
    }

    private let lock = NSLock()
    private var targets: [String: CUTarget] = [:]
    private var targetSeq = 0
    private var screenShots: [CUShotSpace] = []
    private var screenShotSeq = 0
    private var lastPermissions: CUPermissions?
    private var permissionTimer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var logged = Set<String>()
    private var lastDestroyCheck: [pid_t: Double] = [:]

    /// `events` is held weakly (the shell owns both).
    public convenience init(events: (any CUCoreEvents)?) {
        self.init(events: events, clock: CUSystemClock(), skyLight: .system, startMonitors: true)
    }

    init(events: (any CUCoreEvents)?, clock: CUClock, skyLight: CUSkyLight, poster: CUEventPoster? = nil,
         ax: CUAXBackend = CULiveAX(), sys: CUSystemBackend = CULiveSystem(),
         pasteboard: @escaping () -> CUPasteboardIO = { CUSystemPasteboard() }, startMonitors: Bool) {
        self.events = events
        self.clock = clock
        self.skyLight = skyLight
        self.poster = poster ?? CULiveEventPoster(skyLight: skyLight)
        self.ax = ax
        self.sys = sys
        self.pasteboard = pasteboard
        self.monitor = CUAXActivityMonitor(clock: clock)
        AX.configureProcessTimeout()
        monitor.onDestroyed = { [weak self] pid in self?.windowMaybeClosed(pid: pid) }
        if startMonitors { startMonitoring() }
    }

    deinit {
        permissionTimer?.cancel()
        for o in observers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        for o in observers { DistributedNotificationCenter.default().removeObserver(o) }
    }

    // MARK: - status & permissions

    public func status(_ p: StatusParams = StatusParams()) async throws -> StatusResult {
        StatusResult(helperVersion: CUPermissionsProbe.helperVersion, permissions: CUPermissionsProbe.current())
    }

    public func permissionsRequest(_ p: PermissionsRequestParams) async throws -> PermissionsRequestResult {
        await CUPermissionsProbe.request(p.kind)
        return PermissionsRequestResult(opened: true)
    }

    // MARK: - discovery

    public func appsList(_ p: AppsListParams = AppsListParams()) async throws -> AppsListResult {
        AppsListResult(apps: CUApps.list())
    }

    public func screenWindows(_ p: ScreenWindowsParams = ScreenWindowsParams()) async throws -> ScreenWindowsResult {
        let own = getpid()
        var bundle: [pid_t: (String, String)] = [:]
        let windows = CUWindowServer.windows().compactMap { w -> CUScreenWindow? in
            guard w.pid != own, w.frame.width > 1, w.frame.height > 1 else { return nil }
            if bundle[w.pid] == nil {
                let app = NSRunningApplication(processIdentifier: w.pid)
                bundle[w.pid] = (app?.localizedName ?? w.ownerName, app?.bundleIdentifier ?? "")
            }
            let (name, id) = bundle[w.pid]!
            return CUScreenWindow(app: name, bundleId: id, pid: w.pid, windowId: w.id, title: w.title,
                                  frame: cuFrame(w.frame), onScreen: w.onScreen)
        }
        return ScreenWindowsResult(windows: windows)
    }

    // MARK: - binding

    /// The app a bind is for: running (or just launched) — what the bind needs of it.
    struct BindApp {
        var pid: pid_t
        var bundleIdentifier: String?
        var name: String?
        var executableName: String?
        var isChromium: Bool
        var launched: Bool
        /// The live app (nil in tests): Chromium's accessibility switch and the reopen request need it.
        var running: NSRunningApplication?
    }

    /// Finds the app (launching it in the background when installed but not running); replaceable by tests.
    var resolveBindApp: (String, CUCore) async throws -> BindApp = { query, core in
        var launched = false
        let app: NSRunningApplication
        switch try CUApps.resolve(query) {
        case .running(let r): app = r
        case .installed(let url, let bundleId, let name):
            try core.refuseFloorApp(bundleId: bundleId, pid: 0, name: name)
            app = try await CUApps.launchInBackground(url)
            launched = true
        }
        return BindApp(pid: app.processIdentifier, bundleIdentifier: app.bundleIdentifier, name: app.localizedName,
                       executableName: app.executableURL?.lastPathComponent, isChromium: CUChromium.isChromiumFamily(app),
                       launched: launched, running: app)
    }

    public func targetBind(_ p: TargetBindParams) async throws -> TargetBindResult {
        try requireAccessibility()
        let app = try await resolveBindApp(p.app, self)
        let launched = app.launched
        let appName = app.name ?? app.bundleIdentifier ?? p.app
        try refuseFloorApp(bundleId: app.bundleIdentifier, pid: app.pid, name: appName, processName: app.executableName)
        let pid = app.pid
        let chromium = app.isChromium
        // Idempotent: this session already has this app bound and the window is still there — the same target,
        // with no re-resolution, no new window and no move. Only a lost target is resolved again.
        if !launched, let existing = reusableTarget(sessionId: p.sessionId, pid: pid, selector: p.window) {
            CULog.bind.notice("bind \(appName, privacy: .public): reused \(existing.id, privacy: .public) (window \(existing.windowID, privacy: .public))")
            return TargetBindResult(targetId: existing.id,
                                    app: CUBoundApp(name: appName, bundleId: app.bundleIdentifier ?? "", pid: pid),
                                    window: CUWindowInfo(id: existing.windowID, title: existing.windowTitle,
                                                         frame: cuFrame(sys.window(id: existing.windowID)?.frame ?? .zero)))
        }
        monitor.watch(pid: pid)

        let privatePath = p.privatePath ?? true
        let ax = self.ax, sys = self.sys
        if chromium, let running = app.running { try await queues.run(pid) { CUChromium.enableAccessibilityOnce(running) } }
        let found = try await CUBindWait.run(launched: launched, deadlineMs: launched ? 8000 : 3000, CUBindWait.Effects(
            read: { [queues] in
                try await queues.run(pid) {
                    let server = sys.windows(pid: pid)
                    return (CUAXWindows.list(pid: pid, ax: ax, server: server), server)
                }
            },
            reopen: { [reopenApp] in
                CULog.bind.notice("bind \(appName, privacy: .public): no window on any Space — asking the app to reopen one")
                await reopenApp(app)
            },
            sleep: { [clock] in try await clock.sleep(ms: $0) },
            now: { [clock] in clock.nowMs() }))
        let (axNow, serverNow) = (found.ax, found.server)
        let appKey = app.bundleIdentifier ?? "pid:\(pid)"
        let outcome: CUWindowResolver.Outcome
        do {
            outcome = try await queues.run(pid) { [self] in
                try CUWindowResolver.resolve(appName: appName, axWindows: axNow, server: serverNow, selector: p.window,
                                             privatePath: privatePath,
                                             windowEffects(pid: pid, appName: appName, chromium: chromium, privatePath: privatePath,
                                                           sessionId: p.sessionId, appKey: appKey))
            }
        } catch let e as CUError {
            CULog.bind.notice("bind \(appName, privacy: .public) failed: \(e.code, privacy: .public) (\(axNow.count, privacy: .public) window(s) on this desktop, \(serverNow.filter { $0.layer == 0 }.count, privacy: .public) in the window server)")
            throw e
        }
        CULog.bind.notice("bind \(appName, privacy: .public): \(outcome.step.rawValue, privacy: .public) (window \(outcome.window.id, privacy: .public))")
        let chosen = outcome.window
        if let b = app.bundleIdentifier, CUFloors.systemSettingsBundleIds.contains(b) {
            let isPrivacy = try await queues.run(pid) { CUFloorScan.isPrivacyPane(bundleId: b, window: chosen.element, ax: ax) }
            if isPrivacy { throw CUError.refused(.privacyPane, "the Privacy & Security settings are off limits — ask the user") }
        }

        let target: CUTarget = {
            lock.lock(); defer { lock.unlock() }
            targetSeq += 1
            let t = CUTarget(id: "t\(targetSeq)", sessionId: p.sessionId, pid: pid, bundleId: app.bundleIdentifier,
                             appName: appName, isChromium: chromium, mirror: p.mirror, windowID: chosen.id,
                             windowTitle: chosen.title, privatePath: privatePath)
            targets[t.id] = t
            return t
        }()
        // The element is cached now: a window on another Space is not in the AX list to find it again.
        windowElementsLock.withLock { windowElements[target.id] = chosen.element }
        target.knownWindows = Set(CUBindWait.realWindows(serverNow).map(\.id)).union([chosen.id])
        emit { $0.targetBound(sessionId: p.sessionId, pid: pid, windowID: chosen.id, appName: appName, mirror: p.mirror) }
        return TargetBindResult(targetId: target.id,
                                app: CUBoundApp(name: appName, bundleId: app.bundleIdentifier ?? "", pid: pid),
                                window: CUWindowInfo(id: chosen.id, title: chosen.title, frame: cuFrame(chosen.frame)),
                                detail: outcome.detail)
    }

    /// The live effects behind `CUWindowResolver` (run on the pid queue).
    func windowEffects(pid: pid_t, appName: String, chromium: Bool, privatePath: Bool, sessionId: String,
                       appKey: String) -> CUWindowResolver.Effects {
        let ax = self.ax, sys = self.sys
        return CUWindowResolver.Effects(
            remote: { ax.remoteWindows(pid: pid, windowIDs: $0) },
            describe: { element, s in
                CUAXWindow(element: element, id: s.id, title: ax.string(element, kAXTitleAttribute) ?? s.title,
                           frame: ax.frame(element) ?? s.frame, focused: false, main: false)
            },
            moveToActiveSpace: { sys.moveWindowToActiveSpace($0) },
            openNewWindow: { [self] in
                // Once per session and app, whatever happens to the window: one that opens on the app's own
                // Space instead of this one must not be followed by another, and another, on every bind.
                guard claimNewWindow(sessionId: sessionId, appKey: appKey) else {
                    CULog.bind.notice("\(appName, privacy: .public): a new window was already asked for in this session — not again")
                    return false
                }
                CULog.bind.notice("\(appName, privacy: .public): asking for a new window (step b)")
                return openNewWindow(pid: pid, chromium: chromium, privatePath: privatePath)
            },
            axWindows: { CUAXWindows.list(pid: pid, ax: ax, server: sys.windows(pid: pid)) },
            serverWindows: { sys.windows(pid: pid) },
            wait: { [clock, windowWaitMs] probe in
                let deadline = clock.nowMs() + windowWaitMs
                while clock.nowMs() < deadline {
                    if let w = probe() { return w }
                    usleep(50_000)
                }
                return probe()
            })
    }

    /// How long an unconfirmed paste leaves Winter's text on the clipboard before the user's comes back.
    var pasteRestoreDelayMs: Double = 1500

    /// An unconfirmed paste's restore, still pending.
    struct PendingRestore {
        var saved: [[String: Data]]
        var ours: Int
        var work: DispatchWorkItem
        var pasteboard: CUPasteboardIO
    }
    private var pendingRestore: PendingRestore?
    private let pendingRestoreLock = NSLock()

    /// Takes (and cancels) a pending restore, for a new paste to carry on with.
    func takePendingRestore() -> PendingRestore? {
        pendingRestoreLock.withLock {
            let p = pendingRestore
            p?.work.cancel()
            pendingRestore = nil
            return p
        }
    }

    /// The user's clipboard comes back after `pasteRestoreDelayMs` — unless someone copied meanwhile (theirs
    /// wins) or another paste took the restore over.
    func scheduleRestore(_ pb: CUPasteboardIO, saved: [[String: Data]], ours: Int) {
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let mine: Bool = self.pendingRestoreLock.withLock {
                guard let p = self.pendingRestore, p.ours == ours else { return false }
                self.pendingRestore = nil
                return true
            }
            if mine, pb.changeCount == ours { _ = pb.write(saved) }
        }
        pendingRestoreLock.withLock { pendingRestore = PendingRestore(saved: saved, ours: ours, work: work, pasteboard: pb) }
        DispatchQueue.global().asyncAfter(deadline: .now() + pasteRestoreDelayMs / 1000, execute: work)
    }

    /// Restores a pending clipboard now (the turn or the session ended).
    func flushPendingRestore() {
        guard let p = takePendingRestore() else { return }
        if p.pasteboard.changeCount == p.ours { _ = p.pasteboard.write(p.saved) }
    }

    /// Whether `keepFrontmost` also checks once more after the act (off in tests, which check synchronously).
    var keepFrontmostLater = true

    /// The window's tree for the off-desktop hit test; replaceable by tests (the live reader walks real AX).
    var treeReadOverride: ((CUTarget) -> [CUNode])?

    /// How long a moved or newly opened window may take to appear in the AX list (shortened by tests).
    var windowWaitMs: Double = 3000

    /// The reopen request (an app with no window anywhere opens one); replaceable by tests.
    var reopenApp: (BindApp) async -> Void = { app in
        if let url = app.running?.bundleURL { _ = try? await CUApps.launchInBackground(url, timeoutMs: 2000) }
    }

    /// (session, app) pairs that have had their one new window (step b).
    private var newWindowClaims: Set<String> = []

    /// True the first time a session asks an app for a new window, false ever after.
    func claimNewWindow(sessionId: String, appKey: String) -> Bool {
        lock.withLock { newWindowClaims.insert("\(sessionId)\u{1F}\(appKey)").inserted }
    }

    /// The session's live target for `pid` that a repeated bind returns: its window still exists and, when
    /// the bind names a window, it is that one. The most recent wins.
    func reusableTarget(sessionId: String, pid: pid_t, selector: CUWindowSelector?) -> CUTarget? {
        guard sys.appRunning(pid) else { return nil }
        let mine: [CUTarget] = lock.withLock { targets.values.filter { $0.sessionId == sessionId && $0.pid == pid } }
        return mine.sorted { (Int($0.id.dropFirst()) ?? 0) > (Int($1.id.dropFirst()) ?? 0) }.first { t in
            guard sys.window(id: t.windowID) != nil else { return false }
            switch selector {
            case nil: return true
            case .id(let id)?: return t.windowID == id
            case .title(let title)?:
                let want = title.lowercased(), have = t.windowTitle.lowercased()
                return have == want || (!want.isEmpty && have.contains(want))
            }
        }
    }

    /// Asks the app for a new window without activating it: File → New Window (by title or by its ⌘N key
    /// equivalent; the menu bar is reachable with no window on this Space), else ⌘N posted to the pid.
    func openNewWindow(pid: pid_t, chromium: Bool, privatePath: Bool) -> Bool {
        if let roots = try? CUAXMenuNode.menuBar(pid: pid, ax: ax) {
            var queue = Array(roots.dropFirst())
            var seen = 0
            let deadline = CUFloorScan.Deadline(ms: 250)
            while !queue.isEmpty, seen < 600, !deadline.passed {
                let n = queue.removeFirst()
                seen += 1
                if CUMenuWalker.normalize(n.menuTitle) == "new window", n.menuEnabled,
                   (try? ax.perform(n.element, kAXPressAction)) != nil { return true }
                queue.append(contentsOf: n.menuChildren)
            }
        }
        if let item = menuItem(forKey: "n", modifiers: [.command], pid: pid),
           (try? ax.perform(item.element, kAXPressAction)) != nil { return true }
        guard let code = CUKeyCodes.code(for: "n") else { return false }
        let route: CURoute = chromium && privatePath && skyLight.isAvailable ? .skyLight : .publicPid
        synth.key(pid: pid, code: code, flags: .maskCommand, route: route)
        return true
    }

    public func targetUseWindow(_ p: TargetUseWindowParams) async throws -> TargetUseWindowResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        let outcome = try await queues.run(t.pid) { [self] in
            let server = sys.windows(pid: t.pid)
            return try CUWindowResolver.resolve(
                appName: t.appName, axWindows: CUAXWindows.list(pid: t.pid, ax: ax, server: server), server: server,
                selector: p.window, privatePath: t.privatePath,
                windowEffects(pid: t.pid, appName: t.appName, chromium: t.isChromium, privatePath: t.privatePath,
                              sessionId: t.sessionId, appKey: t.bundleId ?? "pid:\(t.pid)"))
        }
        let chosen = outcome.window
        let old = t.windowID
        if old != chosen.id {
            // Refs and the diff base belong to the old window: start over (numbers still never repeat).
            try await queues.run(t.pid) { [self] in
                t.setWindow(id: chosen.id, title: chosen.title)
                t.resetForNewWindow()
                windowElementsLock.withLock { windowElements[t.id] = chosen.element }
            }
        }
        if old != chosen.id {
            emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: old) }
            emit { $0.targetBound(sessionId: t.sessionId, pid: t.pid, windowID: chosen.id, appName: t.appName, mirror: t.mirror) }
        }
        return TargetUseWindowResult(window: CUWindowInfo(id: chosen.id, title: chosen.title, frame: cuFrame(chosen.frame)),
                                     detail: outcome.detail)
    }

    public func targetWindows(_ p: TargetWindowsParams) async throws -> TargetWindowsResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        let (listed, server) = try await queues.run(t.pid) { [self] () -> ([CUAXWindow], [CUWindowServerWindow]) in
            let server = sys.windows(pid: t.pid)
            return (CUAXWindows.list(pid: t.pid, ax: ax, server: server), server)
        }
        // Windows on other Spaces or in full screen are listed too (AX alone would leave them out).
        let ids = Set(listed.map(\.id))
        let elsewhere = server.filter { CUWindowServer.isRealWindow($0) && !ids.contains($0.id) }
        return TargetWindowsResult(windows: listed.map { CUTargetWindow(id: $0.id, title: $0.title, focused: $0.focused) }
            + elsewhere.map { CUTargetWindow(id: $0.id, title: $0.title, focused: false) })
    }

    public func targetRelease(_ p: TargetReleaseParams) async throws -> TargetReleaseResult {
        if let t = remove(p.targetId) {
            cursor(t, "done")
            emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) }
        }
        return TargetReleaseResult()
    }

    // MARK: - observation

    public func targetSnapshot(_ p: TargetSnapshotParams) async throws -> TargetSnapshotResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        try ensureAlive(t)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        var note: CUSettleNote?
        var settled = true
        var waited = 0
        if let s = p.settle {
            cursor(t, "waitBegin")
            defer { cursor(t, "waitEnd") }
            let o = try await settler.waitIdle(pid: t.pid, quietMs: 150, timeoutMs: Double(max(0, s.maxMs)),
                                               lastActionMs: t.lastActionMs, isCancelled: { token.isCancelled })
            settled = o.settled
            waited = o.waitedMs
            note = settled ? .settled(ms: waited) : .notSettled(ms: waited)
        }
        try token.check()
        let formatter = self.formatter
        return try await queues.run(t.pid) { [self] in
            try floorCheckPrivacy(t)
            let obs = try observe(t, within: p.within)
            let header = CUStateHeader(appName: t.appName, windowTitle: obs.title, focusedRef: obs.focusedRef, settle: note)
            let snap = CUSnapshot(id: t.nextSnapshotId(), scope: p.within, header: header, roots: obs.roots, formatter: formatter)
            // A whole-window, non-full state folds what is out of view first; `within` and `full` don't.
            var text = formatter.full(header: header, roots: obs.roots, viewportFirst: p.within == nil && p.full != true)
            var isDiff = false
            var ratio = 1.0
            if let since = p.since, p.full != true, let old = t.snapshot(since), old.scope == p.within {
                let d = CUStateDiff.compute(old: old, new: snap)
                ratio = d.changedRatio
                if ratio <= 0.5 {
                    isDiff = true
                    text = d.render(header: header, new: snap, includeWindowTitle: old.header.windowTitle != obs.title,
                                    formatter: formatter)
                }
            }
            // A menu command or a click may open a window the target is not bound to (Finder's Go › Downloads
            // opens one when its own window is not the active one): say so, or the model watches the wrong one.
            let opened = newWindows(t)
            if !opened.isEmpty { text += "\n" + opened.joined(separator: "\n") }
            t.store(snap)
            return TargetSnapshotResult(snapshotId: snap.id, text: text, isDiff: isDiff, changedRatio: ratio,
                                        settled: settled, waitedMs: waited)
        }
    }

    public func targetFind(_ p: TargetFindParams) async throws -> TargetFindResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        try ensureAlive(t)
        let formatter = self.formatter
        return try await queues.run(t.pid) { [self] in
            try floorCheckPrivacy(t)
            let roots = try freshRead(t) ?? observe(t, within: nil).roots
            return TargetFindResult(elements: CUFinder.find(p.query, in: roots, formatter: formatter))
        }
    }

    /// How long a full read may answer `find` again (a page's tree takes 0.5–2.5 s to walk; scripts run several
    /// finds in a row).
    static let findReuseMs: Double = 1500

    /// The last full read, while it still describes the window: young, and no act and no AX notification
    /// from the app since. Nil otherwise.
    func freshRead(_ t: CUTarget) -> [CUNode]? {
        guard let last = t.lastFullRead, clock.nowMs() - last.atMs <= Self.findReuseMs,
              (t.lastActionMs ?? 0) <= last.atMs, (monitor.lastNotificationMs(pid: t.pid) ?? 0) <= last.atMs
        else { return nil }
        return last.roots
    }

    /// Notes for the app's real windows that appeared since the target last looked; remembers the current set.
    func newWindows(_ t: CUTarget) -> [String] {
        let now = CUBindWait.realWindows(sys.windows(pid: t.pid))
        let known = t.knownWindows
        t.knownWindows = Set(now.map(\.id))
        guard !known.isEmpty else { return [] }
        return now.filter { !known.contains($0.id) && $0.id != t.windowID }.prefix(3).map { w in
            let title = w.title.isEmpty ? "" : " \u{201C}\(w.title.prefix(80))\u{201D}"
            return "new \(t.appName) window\(title) (\(w.id)) — this state is still the bound window; useWindow(\(w.id)) to work in it"
        }
    }

    public func targetScreenshot(_ p: TargetScreenshotParams) async throws -> TargetScreenshotResult {
        let t = try target(p.targetId)
        try ensureAlive(t)
        let region = try cuRect(p.region)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        var settled = true
        var waited = 0
        if let s = p.settle {
            cursor(t, "waitBegin")
            defer { cursor(t, "waitEnd") }
            let o = try await settler.waitIdle(pid: t.pid, quietMs: 150, timeoutMs: Double(max(0, s.maxMs)),
                                               lastActionMs: t.lastActionMs, isCancelled: { token.isCancelled })
            settled = o.settled
            waited = o.waitedMs
        }
        try token.check()
        if let b = t.bundleId, CUFloors.systemSettingsBundleIds.contains(b) {
            try await queues.run(t.pid) { [self] in try floorCheckPrivacy(t) }
        }
        var detail: String?
        let img: CUCapturedImage
        do {
            img = try await captureWindow(t.windowID, region, p.budget)
        } catch let e as CUError where !["permission_missing", "cancelled", "invalid_params"].contains(e.code) {
            // ScreenCaptureKit may refuse a window on another Space or in full screen ("Failed to start
            // stream"): bring it to this desktop the way pointer actions do, then capture again.
            let moved = try await queues.run(t.pid) { [self] () -> String?? in
                guard isOffThisDesktop(t) else { return .none }
                return .some(moveToThisDesktop(t))
            }
            guard let moved else { throw e }
            guard let note = moved else { throw CUError.screenshotElsewhere(t.appName) }
            try await clock.sleep(ms: 100)
            do {
                img = try await captureWindow(t.windowID, region, p.budget)
            } catch let again as CUError where !["permission_missing", "cancelled", "invalid_params"].contains(again.code) {
                throw CUError.screenshotElsewhere(t.appName)
            }
            detail = note
        }
        let shot = try await queues.run(t.pid) {
            t.registerShot(anchor: .window(windowID: t.windowID, regionOrigin: img.pointsRect.origin),
                           imageWidth: img.width, imageHeight: img.height, points: img.pointsRect.size)
        }
        return TargetScreenshotResult(imageBase64: img.jpeg.base64EncodedString(), mime: "image/jpeg", width: img.width,
                                      height: img.height, shotId: shot.id, settled: settled, waitedMs: waited,
                                      detail: detail)
    }

    /// Window capture; replaceable by tests (nothing there may touch ScreenCaptureKit).
    var windowCaptureOverride: ((UInt32, CGRect?, CUImageBudget) async throws -> CUCapturedImage)?

    func captureWindow(_ id: UInt32, _ region: CGRect?, _ budget: CUImageBudget) async throws -> CUCapturedImage {
        if let o = windowCaptureOverride { return try await o(id, region, budget) }
        return try await capturer.captureWindow(windowID: id, region: region, budget: budget)
    }

    // MARK: - waits

    public func targetWaitIdle(_ p: TargetWaitIdleParams) async throws -> TargetWaitIdleResult {
        let t = try target(p.targetId)
        try ensureAlive(t)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        monitor.watch(pid: t.pid)
        cursor(t, "waitBegin")
        defer { cursor(t, "waitEnd") }
        let o = try await settler.waitIdle(pid: t.pid, quietMs: Double(max(0, p.quietMs)), timeoutMs: Double(max(0, p.timeoutMs)),
                                           lastActionMs: t.lastActionMs, isCancelled: { token.isCancelled })
        return TargetWaitIdleResult(settled: o.settled, waitedMs: o.waitedMs)
    }

    public func targetWaitFor(_ p: TargetWaitForParams) async throws -> TargetWaitForResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        try ensureAlive(t)
        let c = p.cond
        guard c.text != nil || c.ref != nil || c.gone != nil || c.title != nil else {
            throw CUError.invalidParams("waitFor needs text, ref, gone or title")
        }
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        cursor(t, "waitBegin", text: Self.waitLabel(c))
        defer { cursor(t, "waitEnd") }
        let start = clock.nowMs()
        let timeout = Double(max(0, p.timeoutMs))
        var lastSeen = ""
        while true {
            try token.check()
            let (met, seen) = try await queues.run(t.pid) { [self] () -> (Bool, String) in
                try token.check()
                try floorCheckPrivacy(t)
                let obs = try observe(t, within: nil, maxNodes: 1500)
                let o = CUWaitEvaluator.Observation(roots: obs.roots, windowTitle: obs.title, focusedRef: obs.focusedRef)
                return (CUWaitEvaluator.met(c, o), CUWaitEvaluator.seen(o))
            }
            lastSeen = seen
            let elapsed = clock.nowMs() - start
            if met { return TargetWaitForResult(met: true, waitedMs: Int(elapsed.rounded())) }
            if elapsed >= timeout { throw CUError.waitTimeout(seen: lastSeen, waitedMs: Int(elapsed.rounded())) }
            // Notification-driven, with a 100 ms backstop.
            let mark = monitor.lastNotificationMs(pid: t.pid)
            let sig = CUWindowServer.signature(pid: t.pid)
            let until = min(clock.nowMs() + 100, start + timeout)
            while clock.nowMs() < until {
                try token.check()
                if monitor.lastNotificationMs(pid: t.pid) != mark || CUWindowServer.signature(pid: t.pid) != sig { break }
                try await clock.sleep(ms: 20)
            }
        }
    }

    /// What a `waitFor` waits for, as the cursor's caption names it ("Waiting for “Saved”"); nil for a ref.
    static func waitLabel(_ c: CUWaitCondition) -> String? {
        let raw: String? = {
            if let text = c.text { return text }
            if let title = c.title { return title }
            return nil  // `gone` waits for something to leave: "Waiting for “X”" would say the opposite
        }()
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s.count > 32 ? String(s.prefix(31)) + "…" : s
    }

    // MARK: - whole screen

    public func screenScreenshot(_ p: ScreenScreenshotParams) async throws -> ScreenScreenshotResult {
        let img = try await capturer.captureScreen(display: p.display, displayId: p.displayId,
                                                   excludeBundleIds: p.excludeBundleIds, budget: p.budget)
        let shot: CUShotSpace = {
            lock.lock(); defer { lock.unlock() }
            screenShotSeq += 1
            let s = CUShotSpace(id: "screen.i\(screenShotSeq)", anchor: .screen(origin: img.pointsRect.origin),
                                imageWidth: img.width, imageHeight: img.height,
                                pointsWidth: Double(img.pointsRect.width), pointsHeight: Double(img.pointsRect.height))
            screenShots.append(s)
            if screenShots.count > 16 { screenShots.removeFirst(screenShots.count - 16) }
            return s
        }()
        return ScreenScreenshotResult(imageBase64: img.jpeg.base64EncodedString(), mime: "image/jpeg",
                                      width: img.width, height: img.height, shotId: shot.id)
    }

    public func screenAppAt(_ p: ScreenAppAtParams) async throws -> ScreenAppAtResult {
        guard let pixel = try cuPoint(p.point) else { throw CUError.invalidParams("point is required") }
        let point = try screenPoint(shotId: p.shotId, pixel: pixel)
        let sys = self.sys
        let w = try Self.appAt(point: point, stack: sys.windowStack(), ownPid: getpid(), bundleId: { sys.bundleId(pid: $0) })
        let app = NSRunningApplication(processIdentifier: w.pid)
        return ScreenAppAtResult(app: app?.localizedName ?? w.ownerName, bundleId: app?.bundleIdentifier ?? "", windowId: w.id)
    }

    /// `screen.appAt`'s pick: the front-most normal window at `point`. Whole-screen images now show Winter's
    /// own windows, so a point on one — the window itself, or a Winter panel floating above another app — is
    /// refused like binding Winter. The helper's own windows are click-through and skipped. Pure.
    static func appAt(point: CGPoint, stack: [CUWindowServerWindow], ownPid: pid_t,
                      bundleId: (pid_t) -> String?) throws -> CUWindowServerWindow {
        let refusal = CUError.refused(.winterItself, "that point is on a Winter window — Winter can't control itself")
        if let top = CUHitTest.topWindow(at: point, stack: stack, ownPid: ownPid),
           CUFloors.isWinterItself(bundleId: bundleId(top.pid), pid: top.pid, ownPid: ownPid) { throw refusal }
        guard let w = stack.first(where: { $0.layer == 0 && $0.pid != ownPid && $0.alpha > 0 && $0.frame.contains(point) }) else {
            throw CUError.invalidParams("no app window at that point")
        }
        if CUFloors.isWinterItself(bundleId: bundleId(w.pid), pid: w.pid, ownPid: ownPid) { throw refusal }
        return w
    }

    /// A shot's pixel → global screen point. Screen shots map directly; a target's window shot adds the
    /// window's current origin.
    func screenPoint(shotId: String, pixel: CGPoint) throws -> CGPoint {
        lock.lock()
        let screenShot = screenShots.last { $0.id == shotId }
        let all = Array(targets.values)
        lock.unlock()
        if let s = screenShot { return try s.screenPoint(pixel: pixel) }
        for t in all {
            if let s = t.shots.last(where: { $0.id == shotId }), case .window(let wid, _) = s.anchor {
                guard let w = CUWindowServer.window(id: wid) else { throw CUError.targetLost("that window is gone") }
                return try s.screenPoint(pixel: pixel, windowOrigin: w.frame.origin)
            }
        }
        throw CUError.invalidParams("unknown screenshot \(shotId) — take a new one")
    }

    // MARK: - lifecycle

    public func cancel(_ p: CancelParams) async throws -> CancelResult {
        cancels.cancel(p.callId)
        return CancelResult()
    }

    public func turnEnded(_ p: TurnEndedParams) async throws -> TurnEndedResult {
        flushPendingRestore()
        return TurnEndedResult()
    }

    public func sessionEnded(_ p: SessionEndedParams) async throws -> SessionEndedResult {
        flushPendingRestore()
        let ids: [String] = {
            lock.lock(); defer { lock.unlock() }
            return targets.values.filter { $0.sessionId == p.sessionId }.map(\.id)
        }()
        for id in ids {
            guard let t = remove(id) else { continue }
            emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) }
        }
        lock.withLock { newWindowClaims = newWindowClaims.filter { !$0.hasPrefix("\(p.sessionId)\u{1F}") } }
        return SessionEndedResult()
    }

    // MARK: - shared plumbing

    /// Main-queue dispatch, not a `Task` per event: the main queue is FIFO, so `targetReleased` then
    /// `targetBound` (or a burst of `actionAt`) reach the presentation layer in the order they happened.
    func emit(_ body: @escaping @MainActor (any CUCoreEvents) -> Void) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let e = self?.events else { return }
                body(e)
            }
        }
    }

    /// One agent-cursor event (`CUCoreEvents.actionAt`). Without a `point` it goes to the last place the cursor
    /// was sent, else the window's centre; with neither it is dropped. `remember: false` keeps the resting
    /// point (the real pointer's position in the foreground is not where the agent's cursor rests).
    func cursor(_ t: CUTarget, _ kind: String, at point: CGPoint? = nil, dragTo: CGPoint? = nil, frame: CGRect? = nil,
                text: String? = nil, count: Int? = nil, button: String? = nil, remember: Bool = true) {
        guard let at = point ?? t.cursorPoint ?? sys.window(id: t.windowID).map({ CGPoint(x: $0.frame.midX, y: $0.frame.midY) })
        else { return }
        if point != nil, remember { t.cursorPoint = at }
        let (session, pid, wid) = (t.sessionId, t.pid, t.windowID)
        emit { $0.actionAt(sessionId: session, pid: pid, windowID: wid, point: at, kind: kind, dragTo: dragTo,
                           frame: frame, text: text, count: count, button: button) }
    }

    func logOnce(_ key: String, _ message: String) {
        lock.lock()
        let first = logged.insert(key).inserted
        lock.unlock()
        if first { NSLog("WinterCUCore: %@", message) }
    }

    func requireAccessibility() throws {
        guard ax.isTrusted() else { throw CUError.permissionMissing(.accessibility) }
    }

    func target(_ id: String) throws -> CUTarget {
        lock.lock(); defer { lock.unlock() }
        guard let t = targets[id] else { throw CUError.targetLost("unknown target \(id) — bind the app again") }
        return t
    }

    private func remove(_ id: String) -> CUTarget? {
        lock.lock()
        let t = targets.removeValue(forKey: id)
        lock.unlock()
        windowElementsLock.lock()
        windowElements[id] = nil
        windowElementsLock.unlock()
        if let t { unwatchIfUnused(t.pid) }
        return t
    }

    private func unwatchIfUnused(_ pid: pid_t) {
        lock.lock()
        let used = targets.values.contains { $0.pid == pid }
        lock.unlock()
        if !used {
            monitor.unwatch(pid: pid)
            queues.forget(pid)
        }
    }

    /// The target's app and window still exist; otherwise it is dropped, `targetLost` fires and this throws.
    func ensureAlive(_ t: CUTarget) throws {
        if !sys.appRunning(t.pid) {
            lose(t, reason: "app_quit")
            throw CUError.targetLost("\(t.appName) quit — bind it again")
        }
        if windowGone(t) {
            lose(t, reason: "window_closed")
            throw CUError.targetLost("the \(t.appName) window was closed — bind again or pick another window")
        }
    }

    /// The window is gone for good: not in the window server by id, nor in the app's list, twice 150 ms apart.
    /// One lookup can miss a window that is changing Space (a live run lost Safari's target while the user
    /// switched desktops, and the rebind found the very same window).
    func windowGone(_ t: CUTarget) -> Bool { liveServerWindow(t) == nil }

    /// The bound window's window-server record, looked up the same patient way.
    func liveServerWindow(_ t: CUTarget) -> CUWindowServerWindow? {
        let id = t.windowID
        for attempt in 0..<2 {
            if let w = sys.window(id: id) ?? sys.windows(pid: t.pid).first(where: { $0.id == id }) { return w }
            if attempt == 0 { usleep(150_000) }
        }
        return nil
    }

    func lose(_ t: CUTarget, reason: String) {
        guard remove(t.id) != nil else { return }
        emit { $0.targetLost(targetId: t.id, reason: reason) }
        emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) }
    }

    /// Called for every destroyed-element notification, so it is debounced to one window-list check per
    /// pid per 250 ms.
    private func windowMaybeClosed(pid: pid_t) {
        let now = clock.nowMs()
        lock.lock()
        if let last = lastDestroyCheck[pid], now - last < 250 { lock.unlock(); return }
        lastDestroyCheck[pid] = now
        let affected = targets.values.filter { $0.pid == pid }
        lock.unlock()
        for t in affected where windowGone(t) {
            lose(t, reason: "window_closed")
        }
    }

    /// Bind-time floors: Winter itself, and the auth/system dialogs.
    func refuseFloorApp(bundleId: String?, pid: pid_t, name: String, processName: String? = nil) throws {
        if CUFloors.isWinterItself(bundleId: bundleId, pid: pid == 0 ? -1 : pid) {
            throw CUError.refused(.winterItself, "Winter can't control itself")
        }
        if CUFloors.isAuthOrSystemDialog(bundleId: bundleId, processName: processName ?? name) {
            throw CUError.refused(.authDialog, "\(name) guards passwords or permissions — ask the user to handle it")
        }
    }

    /// System Settings on its Privacy & Security pane is refused. Pid-queue only.
    func floorCheckPrivacy(_ t: CUTarget) throws {
        guard let b = t.bundleId, CUFloors.systemSettingsBundleIds.contains(b) else { return }
        let win = try windowElement(t)
        if CUFloorScan.isPrivacyPane(bundleId: b, window: win, ax: ax) {
            throw CUError.refused(.privacyPane, "the Privacy & Security settings are off limits — ask the user")
        }
    }

    // MARK: AX observation (pid queue only)

    private var windowElements: [String: AXUIElement] = [:]
    private var remoteMisses: [String: Double] = [:]
    private let windowElementsLock = NSLock()

    /// The bound window's AX element, re-resolved when the cached one died or the binding moved.
    func windowElement(_ t: CUTarget) throws -> AXUIElement {
        let wid = t.windowID
        windowElementsLock.lock()
        let cached = windowElements[t.id]
        windowElementsLock.unlock()
        if let c = cached, ax.isAlive(c), ax.windowID(c).map({ $0 == wid }) ?? true { return c }
        // Without the grant AX lists nothing — that must never read as "the window closed".
        try requireAccessibility()
        guard let w = CUAXWindows.list(pid: t.pid, ax: ax, server: sys.windows(pid: t.pid)).first(where: { $0.id == wid }) else {
            guard let server = liveServerWindow(t) else {
                lose(t, reason: "window_closed")
                throw CUError.targetLost("the \(t.appName) window was closed — bind again or pick another window")
            }
            // Still there for the window server but not in the AX list: another Space or full screen (reached
            // where it is by remote token), or an app that is not answering.
            if t.privatePath, let remote = remoteWindow(pid: t.pid, windowID: wid) {
                windowElementsLock.withLock { windowElements[t.id] = remote }
                return remote
            }
            if !server.onScreen { throw CUError.windowElsewhere(t.appName) }
            throw CUError.busy("\(t.appName) did not list its window over accessibility — retry")
        }
        if w.title != t.windowTitle { t.setWindow(id: wid, title: w.title) }
        windowElementsLock.lock()
        windowElements[t.id] = w.element
        windowElementsLock.unlock()
        return w.element
    }

    /// One window by remote token, not re-probed for 15 s after a miss (a probe walks for up to 1.5 s).
    func remoteWindow(pid: pid_t, windowID: CGWindowID) -> AXUIElement? {
        let key = "\(pid):\(windowID)"
        let now = clock.nowMs()
        if let missed = windowElementsLock.withLock({ remoteMisses[key] }), now - missed < 15_000 { return nil }
        if let e = ax.remoteWindows(pid: pid, windowIDs: [windowID])[windowID] { return e }
        windowElementsLock.withLock { remoteMisses[key] = now }
        return nil
    }

    /// The bound window is on another Space or in full screen: the window server has it off screen and AX
    /// does not list it. (A minimized window or a hidden app's is listed, so it does not count.)
    func isOffThisDesktop(_ t: CUTarget) -> Bool {
        guard let w = sys.window(id: t.windowID), !w.onScreen else { return false }
        return !CUAXWindows.list(pid: t.pid, ax: ax, server: sys.windows(pid: t.pid)).contains { $0.id == t.windowID }
    }

    /// Moves the bound window to this desktop (SkyLight, the bind's private path) and waits up to 1 s for it
    /// to show. A note of what was done, or nil when it could not be moved.
    func moveToThisDesktop(_ t: CUTarget) -> String? {
        guard t.privatePath, sys.moveWindowToActiveSpace(t.windowID) else { return nil }
        let deadline = clock.nowMs() + 1000
        while sys.window(id: t.windowID)?.onScreen != true, clock.nowMs() < deadline { usleep(30_000) }
        return "moved \(t.appName)'s window to this desktop from another Space"
    }

    /// The app's open menus: menus that are children of the application element (where AppKit puts context
    /// and pop-up menus), and menus held by a separate small window of the app (some apps host one there).
    static func openMenus(app: AXUIElement, boundWindow: AXUIElement, ax: CUAXBackend) -> [AXUIElement] {
        var menus: [AXUIElement] = []
        for child in ax.elements(app, kAXChildrenAttribute) {
            switch ax.string(child, kAXRoleAttribute) {
            case kAXMenuRole?:
                menus.append(child)
            case kAXWindowRole? where !CFEqual(child, boundWindow):
                menus += ax.elements(child, kAXChildrenAttribute).filter { ax.string($0, kAXRoleAttribute) == kAXMenuRole }
            default:
                break
            }
        }
        return menus
    }

    struct Observation {
        var roots: [CUNode]
        var focusedRef: Int?
        var title: String
    }

    /// Reads the bound window (plus open app menus), or the subtree at `within`.
    func observe(_ t: CUTarget, within: Int?, maxNodes: Int = AXTreeReader.defaultMaxNodes) throws -> Observation {
        CUUserInputGuard.waitForQuiet()
        let win = try windowElement(t)
        let app = AX.app(t.pid)
        var rootElements: [AXUIElement]
        if let within {
            rootElements = [try element(within, in: t)]
        } else {
            // An open menu FIRST: a context menu (AXShowMenu, a right click) or an open pop-up lives under the
            // application, not in the window's tree, and it is what the next act is about.
            rootElements = Self.openMenus(app: app, boundWindow: win, ax: ax) + [win]
        }
        // Only a complete read of the whole window may age refs out: a `within` read, a capped `waitFor` read
        // or a walk cut short by its budget sees part of the tree, and must not make the rest look gone.
        let full = within == nil && maxNodes >= AXTreeReader.defaultMaxNodes
        if full { t.refs.beginGeneration() }
        var reader = AXTreeReader()
        reader.maxNodes = maxNodes
        let readAt = clock.nowMs()
        let result = reader.read(roots: rootElements, cache: t.refs, now: clock.nowMs)
        if full, !result.truncated { t.refs.prune() }
        guard !result.roots.isEmpty else {
            throw CUError.busy("\(t.appName) did not answer — it may be busy; retry")
        }
        let hidden = Self.hiddenActions(t.refusedActions)
        let roots = hidden.isEmpty ? result.roots : result.roots.map { Self.removing(hidden, from: $0) }
        if full { t.lastFullRead = (roots, readAt) }
        var focusedRef: Int?
        if let f = AX.element(app, kAXFocusedUIElementAttribute), let r = t.refs.existingRef(for: AXIdentity(element: f)),
           roots.contains(where: { $0.find(ref: r) != nil }) {
            focusedRef = r
        }
        let title = AX.string(win, kAXTitleAttribute) ?? t.windowTitle
        return Observation(roots: roots, focusedRef: focusedRef, title: title)
    }

    /// Actions the app listed but refused and `action()` has no pointer equivalent for: state stops listing
    /// them for that role, so every name state shows is one `action()` can perform.
    static func hiddenActions(_ refused: [String: Set<String>]) -> [String: Set<String>] {
        refused.compactMapValues { names in
            let left = names.filter { pointerEquivalent($0) == nil }
            return left.isEmpty ? nil : left
        }
    }

    static func removing(_ hidden: [String: Set<String>], from n: CUNode) -> CUNode {
        var out = n
        if let h = hidden[n.role] { out.actions.removeAll { h.contains($0) } }
        out.children = n.children.map { removing(hidden, from: $0) }
        return out
    }

    /// What `action(name)` does when the app lists the AX action but refuses to perform it.
    static func pointerEquivalent(_ action: String) -> (button: CUMouseButton, count: Int, verb: String)? {
        switch action {
        case kAXPressAction: return (.left, 1, "clicked")
        case "AXOpen": return (.left, 2, "double-clicked")
        case kAXShowMenuAction: return (.right, 1, "right-clicked")
        default: return nil
        }
    }

    /// The live element behind a ref, or `stale_ref`.
    func element(_ ref: Int, in t: CUTarget) throws -> AXUIElement {
        guard let key = t.refs.key(for: ref) else { throw CUError.staleRef(ref) }
        guard ax.isAlive(key.element) else {
            t.refs.forget(ref)
            throw CUError.staleRef(ref)
        }
        return key.element
    }

    /// Registers a target directly (tests drive `targetAct` against fakes with this).
    func registerForTesting(_ t: CUTarget, windowElement: AXUIElement?) {
        lock.withLock { targets[t.id] = t }
        if let w = windowElement { windowElementsLock.withLock { windowElements[t.id] = w } }
    }

    // MARK: monitors

    private func startMonitoring() {
        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) {
            [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.lock.lock()
            let affected = self.targets.values.filter { $0.pid == app.processIdentifier }
            self.lock.unlock()
            for t in affected { self.lose(t, reason: "app_quit") }
        })
        observers.append(DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.Carbon.TISNotifySelectedKeyboardInputSourceChanged"), object: nil,
            queue: .main) { _ in
            MainActor.assumeIsolated { CUKeyboardLayout.refresh() }
        })
        Task { @MainActor in CUKeyboardLayout.refresh() }

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.pollPermissions() }
        timer.resume()
        permissionTimer = timer
        lastPermissions = CUPermissionsProbe.current()
    }

    private func pollPermissions() {
        let now = CUPermissionsProbe.current()
        lock.lock()
        let changed = lastPermissions != now
        lastPermissions = now
        lock.unlock()
        if changed {
            emit { $0.permissionsChanged(accessibility: now.accessibility, screenRecording: now.screenRecording) }
        }
    }
}

/// The settle loop's live signals: AX notifications from the monitor, window lists from the window server.
struct CULiveActivity: CUActivitySource {
    let monitor: CUAXActivityMonitor
    func lastNotificationMs(pid: pid_t) -> Double? { monitor.lastNotificationMs(pid: pid) }
    func windowSignature(pid: pid_t) -> Int { CUWindowServer.signature(pid: pid) }
}
