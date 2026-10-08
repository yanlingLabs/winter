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
    let queues = CUPidQueues()
    let cancels = CUCancellation()
    let monitor: CUAXActivityMonitor
    let capturer = CUCapturer()
    let formatter = CUStateFormatter()
    var settler: CUSettler { CUSettler(clock: clock, source: CULiveActivity(monitor: monitor)) }
    var synth: CUEventSynth { CUEventSynth(poster: poster, skyLight: skyLight) }

    private let lock = NSLock()
    private var targets: [String: CUTarget] = [:]
    private var targetSeq = 0
    private var screenShots: [CUShotSpace] = []
    private var screenShotSeq = 0
    private var lastPermissions: CUPermissions?
    private var permissionTimer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var logged = Set<String>()

    /// `events` is held weakly (the shell owns both).
    public convenience init(events: (any CUCoreEvents)?) {
        self.init(events: events, clock: CUSystemClock(), skyLight: .system, startMonitors: true)
    }

    init(events: (any CUCoreEvents)?, clock: CUClock, skyLight: CUSkyLight, poster: CUEventPoster? = nil,
         startMonitors: Bool) {
        self.events = events
        self.clock = clock
        self.skyLight = skyLight
        self.poster = poster ?? CULiveEventPoster(skyLight: skyLight)
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
        await MainActor.run { CUPermissionsProbe.request(p.kind) }
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

    public func targetBind(_ p: TargetBindParams) async throws -> TargetBindResult {
        try requireAccessibility()
        var app: NSRunningApplication
        var launched = false
        switch try CUApps.resolve(p.app) {
        case .running(let r): app = r
        case .installed(let url, let bundleId, let name):
            try refuseFloorApp(bundleId: bundleId, pid: 0, name: name)
            app = try await CUApps.launchInBackground(url)
            launched = true
        }
        let appName = app.localizedName ?? app.bundleIdentifier ?? p.app
        try refuseFloorApp(bundleId: app.bundleIdentifier, pid: app.processIdentifier, name: appName,
                           processName: app.executableURL?.lastPathComponent)
        let pid = app.processIdentifier
        let chromium = CUChromium.isChromiumFamily(app)
        monitor.watch(pid: pid)

        // Wait for a window: a just-launched app needs a moment; a running app with none is asked to reopen.
        var windows = try await queues.run(pid) {
            if chromium { CUChromium.enableAccessibilityOnce(app) }
            return CUAXWindows.list(pid: pid)
        }
        let deadline = clock.nowMs() + (launched ? 8000 : 3000)
        var reopened = launched
        while windows.isEmpty, clock.nowMs() < deadline {
            if !reopened, let url = app.bundleURL {
                reopened = true
                _ = try? await CUApps.launchInBackground(url, timeoutMs: 2000)
            }
            try await clock.sleep(ms: 100)
            windows = try await queues.run(pid) { CUAXWindows.list(pid: pid) }
        }
        let chosen = try CUAXWindows.choose(windows, selector: p.window)
        if let b = app.bundleIdentifier, CUFloors.systemSettingsBundleIds.contains(b) {
            let isPrivacy = try await queues.run(pid) { CUFloorScan.isPrivacyPane(bundleId: b, window: chosen.element) }
            if isPrivacy { throw CUError.refused(.privacyPane, "the Privacy & Security settings are off limits — ask the user") }
        }

        let target: CUTarget = {
            lock.lock(); defer { lock.unlock() }
            targetSeq += 1
            let t = CUTarget(id: "t\(targetSeq)", sessionId: p.sessionId, pid: pid, bundleId: app.bundleIdentifier,
                             appName: appName, isChromium: chromium, mirror: p.mirror, windowID: chosen.id,
                             windowTitle: chosen.title)
            targets[t.id] = t
            return t
        }()
        emit { $0.targetBound(sessionId: p.sessionId, pid: pid, windowID: chosen.id, appName: appName, mirror: p.mirror) }
        return TargetBindResult(targetId: target.id,
                                app: CUBoundApp(name: appName, bundleId: app.bundleIdentifier ?? "", pid: pid),
                                window: CUWindowInfo(id: chosen.id, title: chosen.title, frame: cuFrame(chosen.frame)))
    }

    public func targetUseWindow(_ p: TargetUseWindowParams) async throws -> TargetUseWindowResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        let windows = try await queues.run(t.pid) { CUAXWindows.list(pid: t.pid) }
        let chosen = try CUAXWindows.choose(windows, selector: p.window)
        let old = t.windowID
        t.setWindow(id: chosen.id, title: chosen.title)
        if old != chosen.id {
            emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: old) }
            emit { $0.targetBound(sessionId: t.sessionId, pid: t.pid, windowID: chosen.id, appName: t.appName, mirror: t.mirror) }
        }
        return TargetUseWindowResult(window: CUWindowInfo(id: chosen.id, title: chosen.title, frame: cuFrame(chosen.frame)))
    }

    public func targetWindows(_ p: TargetWindowsParams) async throws -> TargetWindowsResult {
        try requireAccessibility()
        let t = try target(p.targetId)
        let windows = try await queues.run(t.pid) { CUAXWindows.list(pid: t.pid) }
        return TargetWindowsResult(windows: windows.map { CUTargetWindow(id: $0.id, title: $0.title, focused: $0.focused) })
    }

    public func targetRelease(_ p: TargetReleaseParams) async throws -> TargetReleaseResult {
        if let t = remove(p.targetId) {
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
            var text = formatter.full(header: header, roots: obs.roots)
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
            let obs = try observe(t, within: nil)
            return TargetFindResult(elements: CUFinder.find(p.query, in: obs.roots, formatter: formatter))
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
            let o = try await settler.waitIdle(pid: t.pid, quietMs: 150, timeoutMs: Double(max(0, s.maxMs)),
                                               lastActionMs: t.lastActionMs, isCancelled: { token.isCancelled })
            settled = o.settled
            waited = o.waitedMs
        }
        try token.check()
        if let b = t.bundleId, CUFloors.systemSettingsBundleIds.contains(b) {
            try await queues.run(t.pid) { [self] in try floorCheckPrivacy(t) }
        }
        let img = try await capturer.captureWindow(windowID: t.windowID, region: region, budget: p.budget)
        let shot = try await queues.run(t.pid) {
            t.registerShot(anchor: .window(windowID: t.windowID, regionOrigin: img.pointsRect.origin),
                           imageWidth: img.width, imageHeight: img.height, points: img.pointsRect.size)
        }
        return TargetScreenshotResult(imageBase64: img.jpeg.base64EncodedString(), mime: "image/jpeg", width: img.width,
                                      height: img.height, shotId: shot.id, settled: settled, waitedMs: waited)
    }

    // MARK: - waits

    public func targetWaitIdle(_ p: TargetWaitIdleParams) async throws -> TargetWaitIdleResult {
        let t = try target(p.targetId)
        try ensureAlive(t)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        monitor.watch(pid: t.pid)
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
        let start = clock.nowMs()
        let timeout = Double(max(0, p.timeoutMs))
        var lastSeen = ""
        while true {
            try token.check()
            let (met, seen) = try await queues.run(t.pid) { [self] () -> (Bool, String) in
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

    // MARK: - whole screen

    public func screenScreenshot(_ p: ScreenScreenshotParams) async throws -> ScreenScreenshotResult {
        let img = try await capturer.captureScreen(display: p.display, excludeBundleIds: p.excludeBundleIds, budget: p.budget)
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
        guard let w = CUWindowServer.topWindow(at: point) else {
            throw CUError.invalidParams("no app window at that point")
        }
        let app = NSRunningApplication(processIdentifier: w.pid)
        return ScreenAppAtResult(app: app?.localizedName ?? w.ownerName, bundleId: app?.bundleIdentifier ?? "", windowId: w.id)
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
        TurnEndedResult()
    }

    public func sessionEnded(_ p: SessionEndedParams) async throws -> SessionEndedResult {
        let ids: [String] = {
            lock.lock(); defer { lock.unlock() }
            return targets.values.filter { $0.sessionId == p.sessionId }.map(\.id)
        }()
        for id in ids {
            guard let t = remove(id) else { continue }
            emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) }
        }
        return SessionEndedResult()
    }

    // MARK: - shared plumbing

    func emit(_ body: @escaping @MainActor (any CUCoreEvents) -> Void) {
        Task { @MainActor [weak self] in
            guard let e = self?.events else { return }
            body(e)
        }
    }

    func logOnce(_ key: String, _ message: String) {
        lock.lock()
        let first = logged.insert(key).inserted
        lock.unlock()
        if first { NSLog("WinterCUCore: %@", message) }
    }

    func requireAccessibility() throws {
        guard AXIsProcessTrusted() else { throw CUError.permissionMissing(.accessibility) }
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
        let app = NSRunningApplication(processIdentifier: t.pid)
        if app == nil || app?.isTerminated == true {
            lose(t, reason: "app_quit")
            throw CUError.targetLost("\(t.appName) quit — bind it again")
        }
        if CUWindowServer.window(id: t.windowID) == nil {
            lose(t, reason: "window_closed")
            throw CUError.targetLost("the \(t.appName) window was closed — bind again or pick another window")
        }
    }

    func lose(_ t: CUTarget, reason: String) {
        guard remove(t.id) != nil else { return }
        emit { $0.targetLost(targetId: t.id, reason: reason) }
        emit { $0.targetReleased(sessionId: t.sessionId, pid: t.pid, windowID: t.windowID) }
    }

    private func windowMaybeClosed(pid: pid_t) {
        lock.lock()
        let affected = targets.values.filter { $0.pid == pid }
        lock.unlock()
        for t in affected where CUWindowServer.window(id: t.windowID) == nil {
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
        if CUFloorScan.isPrivacyPane(bundleId: b, window: win) {
            throw CUError.refused(.privacyPane, "the Privacy & Security settings are off limits — ask the user")
        }
    }

    // MARK: AX observation (pid queue only)

    private var windowElements: [String: AXUIElement] = [:]
    private let windowElementsLock = NSLock()

    /// The bound window's AX element, re-resolved when the cached one died or the binding moved.
    func windowElement(_ t: CUTarget) throws -> AXUIElement {
        let wid = t.windowID
        windowElementsLock.lock()
        let cached = windowElements[t.id]
        windowElementsLock.unlock()
        if let c = cached, AX.isAlive(c), AX.windowID(c).map({ $0 == wid }) ?? true { return c }
        guard let w = CUAXWindows.list(pid: t.pid).first(where: { $0.id == wid }) else {
            lose(t, reason: "window_closed")
            throw CUError.targetLost("the \(t.appName) window was closed — bind again or pick another window")
        }
        if w.title != t.windowTitle { t.setWindow(id: wid, title: w.title) }
        windowElementsLock.lock()
        windowElements[t.id] = w.element
        windowElementsLock.unlock()
        return w.element
    }

    struct Observation {
        var roots: [CUNode]
        var focusedRef: Int?
        var title: String
    }

    /// Reads the bound window (plus open app menus), or the subtree at `within`.
    func observe(_ t: CUTarget, within: Int?, maxNodes: Int = 2500) throws -> Observation {
        CUUserInputGuard.waitForQuiet()
        let win = try windowElement(t)
        let app = AX.app(t.pid)
        var rootElements: [AXUIElement]
        if let within {
            rootElements = [try element(within, in: t)]
        } else {
            rootElements = [win]
            rootElements += AX.elements(app, kAXChildrenAttribute).filter { AX.string($0, kAXRoleAttribute) == kAXMenuRole }
        }
        t.refs.beginGeneration()
        var reader = AXTreeReader()
        reader.maxNodes = maxNodes
        let result = reader.read(roots: rootElements, cache: t.refs, now: clock.nowMs)
        t.refs.prune()
        guard !result.roots.isEmpty else {
            throw CUError.busy("\(t.appName) did not answer — it may be busy; retry")
        }
        var focusedRef: Int?
        if let f = AX.element(app, kAXFocusedUIElementAttribute), let r = t.refs.existingRef(for: AXIdentity(element: f)),
           result.roots.contains(where: { $0.find(ref: r) != nil }) {
            focusedRef = r
        }
        let title = AX.string(win, kAXTitleAttribute) ?? t.windowTitle
        return Observation(roots: result.roots, focusedRef: focusedRef, title: title)
    }

    /// The live element behind a ref, or `stale_ref`.
    func element(_ ref: Int, in t: CUTarget) throws -> AXUIElement {
        guard let key = t.refs.key(for: ref) else { throw CUError.staleRef(ref) }
        guard AX.isAlive(key.element) else {
            t.refs.forget(ref)
            throw CUError.staleRef(ref)
        }
        return key.element
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
