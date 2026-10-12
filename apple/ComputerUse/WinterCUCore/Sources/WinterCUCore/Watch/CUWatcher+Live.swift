import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// The watches' LIVE seams: the engine's arm probe, its looks, its hit test and its drawing facts, read from `CUCore`'s
// own accessibility and window-server backends; an `AXObserver` per watched app; the listen-only mouse-down tap; and
// timers with leeway. A watch reads through its OWN window element and its own ref cache, never the target's: the
// model's ref numbering and the script's binding are untouched, and the watch outlives that binding.

extension CUWatcher {
    /// The live watcher over `core`. Draws nothing and installs no tap until the first watch is armed.
    public static func live(core: CUCore) -> CUWatcher {
        live(core: core, notifier: CUWatchAXObserver(), tap: CUWatchClickTap(), scheduler: CUWatchTimers(), workspace: true)
    }

    /// The live seams over `core`, on the given notifier, tap and timers (tests pass fakes and no workspace observers).
    static func live(core: CUCore, notifier: CUWatchNotifying, tap: CUWatchTapping, scheduler: CUWatchScheduling,
                     workspace: Bool, wallMs: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }) -> CUWatcher {
        let state = CUWatchLiveState()
        let watcher = CUWatcher(
            clock: core.clock, wallMs: wallMs,
            notifier: notifier, tap: tap, scheduler: scheduler,
            prepare: { [weak core] p, condition in
                guard let core else { throw CUError.unsupported("the automation engine is gone") }
                return try await core.prepareWatch(p, condition, state: state)
            },
            read: { [weak core] s in
                guard let core else { throw CUError.unsupported("the automation engine is gone") }
                return try await core.lookAtWatch(s, state: state)
            },
            windowAt: { [weak core] point in core?.windowUnder(point).map { ($0.pid, $0.id) } },
            hit: { [weak core] s, point in await core?.hitTestWatch(s, point, state: state) ?? .none },
            present: { [weak core] s in await core?.presentWatch(s, state: state) },
            pidOfTarget: { [weak core] id in try? core?.target(id).pid })
        watcher.liveState = state
        watcher.forget = { [state] id in state.drop(id) }
        guard workspace else { return watcher }
        let center = NSWorkspace.shared.notificationCenter
        state.observers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) {
            [weak watcher] _ in watcher?.appActivated()
        })
        state.observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) {
            [weak watcher] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            watcher?.appTerminated(app.processIdentifier)
        })
        return watcher
    }
}

/// Per-watch live state: the window element captured at arming and a ref cache of the watch's own (the tree reader
/// needs one). Touched only on the watched app's queue.
final class CUWatchLiveState: @unchecked Sendable {
    struct Reading {
        let window: AXUIElement
        let refs: CURefCache<AXIdentity>
    }
    private let lock = NSLock()
    private var readings: [String: Reading] = [:]
    var observers: [NSObjectProtocol] = []
    /// Replaces the live tree read (tests: nothing there may walk real accessibility).
    var treeRead: ((AXUIElement) -> [CUNode])?

    /// The window's tree, for a text or title condition.
    func read(_ window: AXUIElement, refs: CURefCache<AXIdentity>, clock: CUClock) -> [CUNode] {
        if let treeRead { return treeRead(window) }
        return CUCore.watchRead(window, refs: refs, clock: clock)
    }

    func set(_ id: String, _ r: Reading) { lock.withLock { readings[id] = r } }
    func get(_ id: String) -> Reading? { lock.withLock { readings[id] } }
    func drop(_ id: String) { lock.withLock { _ = readings.removeValue(forKey: id) } }

    deinit {
        for o in observers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    }
}

extension CUCore {
    /// The most nodes one look reads (`waitFor`'s own cap).
    static let watchReadMaxNodes = 1_500

    /// `watch.arm`'s checks and baseline: the target bound and alive, readable over accessibility, never Winter or a
    /// privacy pane, never a secure field (or anything inside one); the element's label, the target's label, and the
    /// condition's truth now (arming refuses a state condition that already holds).
    func prepareWatch(_ p: WatchArmParams, _ condition: CUWatchCondition, state: CUWatchLiveState) async throws -> CUWatcher.Prepared {
        try requireAccessibility()
        let t = try target(p.targetId)
        try await ensureAlive(t)
        if CUFloors.isWinterItself(bundleId: t.bundleId, pid: t.pid) {
            throw CUError.refused(.winterItself, "Winter never watches itself")
        }
        guard t.accessible else {
            throw CUError.unsupported("\(t.appName)'s window has no accessibility here, so Winter can't watch it — ask the user to show the window once on its desktop, then bind it again")
        }
        let ax = self.ax
        return try await queues.run(t.pid) { [self] in
            try floorCheckPrivacy(t)
            let window = try windowElement(t)
            let title = ax.string(window, kAXTitleAttribute) ?? t.windowTitle
            let refs = CURefCache<AXIdentity>()
            var ready = CUWatcher.Prepared(pid: t.pid, windowID: t.windowID, appName: t.appName, sessionId: t.sessionId,
                                           target: t, targetLabel: CUWatchText.targetLabel(app: t.appName, title: title))
            if let ref = condition.ref {
                let e = try element(ref, in: t)
                if Self.watchSecure(e, ax: ax) {
                    throw CUError.refused(.secureField, "that is a password or payment field — Winter never watches one; ask the user to tell you when they are done")
                }
                ready.element = e
                ready.elementInfo = Self.watchElementInfo(e, ax: ax)
                if case .changed = condition { ready.valueDigest = CUWatchText.digest(Self.watchValue(e, ax: ax)) }
                if case .goneRef = condition { ready.met = !ax.isAlive(e) }
            } else {
                ready.met = Self.watchStateMet(condition, roots: state.read(window, refs: refs, clock: clock), title: title)
            }
            state.set(p.watchId, CUWatchLiveState.Reading(window: window, refs: refs))
            return ready
        }
    }

    /// One look at a watch's window, on its app's queue.
    func lookAtWatch(_ s: CUWatcher.Subject, state: CUWatchLiveState) async throws -> CUWatchObservation {
        try requireAccessibility()
        guard sys.appRunning(s.pid) else { state.drop(s.watchId); return CUWatchObservation(appRunning: false) }
        guard let reading = state.get(s.watchId) else { return CUWatchObservation() }
        if !watchWindowAlive(s, reading) {
            // A window in a full-screen or Space transition reads as gone for a moment: look once more 1.5 s later.
            try await clock.sleep(ms: 1_500)
            if !sys.appRunning(s.pid) { state.drop(s.watchId); return CUWatchObservation(appRunning: false) }
            if !watchWindowAlive(s, reading) { state.drop(s.watchId); return CUWatchObservation(windowAlive: false) }
        }
        let ax = self.ax
        return try await queues.run(s.pid) { [self] in
            var o = CUWatchObservation()
            switch s.condition {
            case .clicked, .goneRef:
                o.elementAlive = s.element.map { ax.isAlive($0) } ?? false
            case .changed:
                let alive = s.element.map { ax.isAlive($0) } ?? false
                o.elementAlive = alive
                if alive, let e = s.element {
                    o.valueDigest = CUWatchText.digest(Self.watchValue(e, ax: ax))
                    o.userEvidence = sys.frontmostPid() == s.pid && Self.watchFocusInside(e, pid: s.pid, ax: ax)
                }
            case .appeared, .goneText, .titled:
                let title = ax.string(reading.window, kAXTitleAttribute) ?? ""
                o.met = Self.watchStateMet(s.condition, roots: state.read(reading.window, refs: reading.refs, clock: clock), title: title)
                o.title = title
            }
            return o
        }
    }

    /// The watch's window is still there: its element answers for its id, or the window server lists it on a Space.
    func watchWindowAlive(_ s: CUWatcher.Subject, _ r: CUWatchLiveState.Reading) -> Bool {
        if ax.isAlive(r.window), ax.windowID(r.window).map({ $0 == s.windowID }) ?? true { return true }
        guard let w = sys.window(id: s.windowID) ?? sys.windows(pid: s.pid).first(where: { $0.id == s.windowID }) else { return false }
        return w.onScreen || sys.windowOnAnySpace(w.id) != false
    }

    /// What a click at `point` landed on, by the app's own hit test; the point is dropped after.
    func hitTestWatch(_ s: CUWatcher.Subject, _ point: CGPoint, state: CUWatchLiveState) async -> CUWatchHit {
        let window = state.get(s.watchId)?.window
        let element = s.element
        return (try? await queues.run(s.pid) { () -> CUWatchHit in
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AX.app(s.pid), Float(point.x), Float(point.y), &hit) == .success,
                  var cur = hit else { return .none }
            for _ in 0..<64 {
                if let element, CFEqual(cur, element) { return .element }
                if let window, CFEqual(cur, window) { return .window }
                guard let parent = AX.element(cur, kAXParentAttribute) else { break }
                cur = parent
            }
            return .none
        }) ?? .none
    }

    /// The ring and the pill for one watch: only while its app is frontmost and its window is that app's front window on
    /// screen (the active Space); the element's frame for the ring.
    func presentWatch(_ s: CUWatcher.Subject, state: CUWatchLiveState) async -> CUWatchShown? {
        guard sys.frontmostPid() == s.pid,
              let top = sys.windowStack().first(where: { $0.pid == s.pid && $0.layer == 0 }), top.id == s.windowID
        else { return nil }
        let ax = self.ax
        let frame: CGRect? = s.element == nil ? nil : (try? await queues.run(s.pid) { () -> CGRect? in
            guard let e = s.element, ax.isAlive(e) else { return nil }
            return ax.frame(e)
        }) ?? nil
        return CUWatchShown(watchId: s.watchId, kind: s.condition.kind, label: s.label, elementFrame: frame, windowFrame: top.frame)
    }

    // MARK: pure-ish helpers

    /// A read of the window's tree, bounded like `waitFor`'s; the watch's own cache ages its refs.
    static func watchRead(_ window: AXUIElement, refs: CURefCache<AXIdentity>, clock: CUClock) -> [CUNode] {
        var reader = AXTreeReader()
        reader.maxNodes = watchReadMaxNodes
        refs.beginGeneration()
        let r = reader.read(roots: [window], cache: refs, now: clock.nowMs)
        if !r.truncated { refs.prune() }
        return r.roots
    }

    /// A state condition over one read (secure values are never searched — `CUWaitEvaluator`'s rule).
    static func watchStateMet(_ c: CUWatchCondition, roots: [CUNode], title: String) -> Bool? {
        let o = CUWaitEvaluator.Observation(roots: roots, windowTitle: title, focusedRef: nil)
        switch c {
        case .appeared(let text): return CUWaitEvaluator.met(CUWaitCondition(text: text), o)
        case .goneText(let text): return CUWaitEvaluator.met(CUWaitCondition(gone: .text(text)), o)
        case .titled(let title): return CUWaitEvaluator.met(CUWaitCondition(title: title), o)
        case .clicked, .goneRef, .changed: return nil
        }
    }

    /// The element as the user sees it, named the way `state()` names it: its title, else its description, else its
    /// placeholder (never for a secure field — none is watched anyway); its role words.
    static func watchElementInfo(_ e: AXUIElement, ax: CUAXBackend) -> CUWatchElement {
        let a = ax.copyMultiple(e, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                    kAXPlaceholderValueAttribute]) ?? [:]
        let text = { (k: String) -> String? in a[k].flatMap(AX.stringValue).flatMap { $0.isEmpty ? nil : $0 } }
        let role = text(kAXRoleAttribute) ?? "AXUnknown"
        let name = text(kAXTitleAttribute) ?? text(kAXDescriptionAttribute) ?? text(kAXPlaceholderValueAttribute) ?? ""
        return CUWatchElement(role: CURoleWords.words(role: role, subrole: text(kAXSubroleAttribute)),
                              name: CUWatchText.oneLine(name, max: 120))
    }

    /// The element's value as text (a check box's 0/1, a pop-up's title): digested, never sent.
    static func watchValue(_ e: AXUIElement, ax: CUAXBackend) -> String? {
        ax.attribute(e, kAXValueAttribute).flatMap(AX.stringValue)
    }

    /// A password or payment field, or an element inside one (never watched).
    static func watchSecure(_ e: AXUIElement, ax: CUAXBackend) -> Bool {
        var cur: AXUIElement? = e
        for _ in 0..<40 {
            guard let c = cur else { return false }
            if ElementInfo(c, ax).secure { return true }
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXWindowRole || role == kAXApplicationRole { return false }
            cur = ax.element(c, kAXParentAttribute)
        }
        return false
    }

    /// The app's keyboard focus is the element or inside it.
    static func watchFocusInside(_ e: AXUIElement, pid: pid_t, ax: CUAXBackend) -> Bool {
        var cur = ax.focusedElement(pid: pid)
        for _ in 0..<40 {
            guard let c = cur else { return false }
            if CFEqual(c, e) { return true }
            cur = ax.element(c, kAXParentAttribute)
        }
        return false
    }
}

extension CUWatcher {
    /// The live state (window elements per watch), kept with the watcher.
    var liveState: CUWatchLiveState? {
        get { liveStateLock.withLock { _liveState } }
        set { liveStateLock.withLock { _liveState = newValue } }
    }
}

// MARK: - The AX observer

/// An `AXObserver` per watched app, on one run-loop thread of its own (never the main thread, never the activity
/// monitor's): every notification of the app's — creations, destructions, values, titles, layout, focus, windows —
/// becomes one `onNotification(pid)`. The thread starts with the first watch.
final class CUWatchAXObserver: CUWatchNotifying, @unchecked Sendable {
    static let notifications: [String] = [
        kAXCreatedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification, kAXTitleChangedNotification,
        kAXLayoutChangedNotification, kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification,
        kAXWindowCreatedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
        kAXWindowMiniaturizedNotification, kAXSheetCreatedNotification, kAXSelectedChildrenChangedNotification,
        kAXRowCountChangedNotification, kAXMovedNotification, kAXResizedNotification,
    ]

    private final class Box: @unchecked Sendable {
        let lock = NSLock()
        var runLoop: CFRunLoop?
        let ready = DispatchSemaphore(value: 0)
        var started = false
    }

    var onNotification: (@Sendable (pid_t) -> Void)?
    private let lock = NSLock()
    private var observers: [pid_t: AXObserver] = [:]
    private let box = Box()

    @discardableResult
    func watch(pid: pid_t) -> Bool {
        if lock.withLock({ observers[pid] != nil }) { return true }
        guard let rl = ensureThread() else { return false }
        var observer: AXObserver?
        guard AXObserverCreate(pid, cuWatchObserverCallback, &observer) == .success, let observer else { return false }
        let app = AX.app(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var added = 0
        for n in Self.notifications where AXObserverAddNotification(observer, app, n as CFString, refcon) == .success { added += 1 }
        guard added > 0 else { return false }
        let won: Bool = lock.withLock {
            if observers[pid] != nil { return false }
            observers[pid] = observer
            return true
        }
        guard won else { return true }
        CFRunLoopAddSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
        CFRunLoopWakeUp(rl)
        return true
    }

    func unwatch(pid: pid_t) {
        guard let observer = lock.withLock({ observers.removeValue(forKey: pid) }),
              let rl = box.lock.withLock({ box.runLoop }) else { return }
        CFRunLoopRemoveSource(rl, AXObserverGetRunLoopSource(observer), .defaultMode)
    }

    fileprivate func fire(_ pid: pid_t) { onNotification?(pid) }

    private func ensureThread() -> CFRunLoop? {
        let box = self.box
        let start: Bool = box.lock.withLock {
            if box.started { return false }
            box.started = true
            return true
        }
        if start {
            let t = Thread {
                let rl = CFRunLoopGetCurrent()!
                RunLoop.current.add(Port(), forMode: .default)
                box.lock.withLock { box.runLoop = rl }
                box.ready.signal()
                while true { CFRunLoopRunInMode(.defaultMode, 3600, false) }
            }
            t.name = "WinterCUCore.watch-observers"
            t.qualityOfService = .utility
            t.start()
        }
        if let rl = box.lock.withLock({ box.runLoop }) { return rl }
        _ = box.ready.wait(timeout: .now() + 2)
        box.ready.signal()
        return box.lock.withLock { box.runLoop }
    }
}

private func cuWatchObserverCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString,
                                     _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return }
    Unmanaged<CUWatchAXObserver>.fromOpaque(refcon).takeUnretainedValue().fire(pid)
}

// MARK: - The click tap

/// The watches' own LISTEN-ONLY session tap for the three mouse-down buttons — nothing else: no keys, no moves (so an
/// idle Mac sends it nothing). The same public API as the work watcher's (`CGEvent.tapCreate`, listen-only), which the
/// helper's Accessibility grant covers: no new permission, no prompt. It runs only while a `clicked` or `changed` watch is
/// armed, never alters an event, and hands each one's point to the watcher, which judges and drops it.
final class CUWatchClickTap: CUWatchTapping, @unchecked Sendable {
    private final class Context {
        let onMouseDown: @Sendable (CGPoint, Int64, Int64) -> Void
        weak var tap: CUWatchClickTap?
        init(_ f: @escaping @Sendable (CGPoint, Int64, Int64) -> Void) { onMouseDown = f }
    }
    private let lock = NSLock()
    private var port: CFMachPort?
    private var thread: Thread?

    var running: Bool { lock.withLock { port != nil } }

    @discardableResult
    func start(onMouseDown: @escaping @Sendable (CGPoint, Int64, Int64) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if port != nil { return true }
        let context = Context(onMouseDown)
        context.tap = self
        let box = Unmanaged.passRetained(context).toOpaque()
        guard let p = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                        eventsOfInterest: CUWatchInput.tapMask, callback: cuWatchTapCallback, userInfo: box) else {
            Unmanaged<Context>.fromOpaque(box).release()
            return false
        }
        port = p
        let t = Thread {
            let source = CFMachPortCreateRunLoopSource(nil, p, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: p, enable: true)
            // A long wait: only the tap's events wake this loop; a cancel is seen within 5 s.
            while !Thread.current.isCancelled {
                let r = CFRunLoopRunInMode(.defaultMode, 5, false)
                if r == .stopped || r == .finished { break }
            }
            CGEvent.tapEnable(tap: p, enable: false)
            CFMachPortInvalidate(p)
            Unmanaged<Context>.fromOpaque(box).release()
        }
        t.name = "Winter watch click tap"
        thread = t
        t.start()
        return true
    }

    func stop() {
        lock.lock()
        let p = port
        let t = thread
        port = nil
        thread = nil
        lock.unlock()
        if let p { CGEvent.tapEnable(tap: p, enable: false) }
        t?.cancel()
    }

    fileprivate func reenable() {
        lock.withLock { if let port { CGEvent.tapEnable(tap: port, enable: true) } }
    }

    fileprivate static func handle(_ refcon: UnsafeMutableRawPointer, type: CGEventType, event: CGEvent) {
        let context = Unmanaged<Context>.fromOpaque(refcon).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            context.tap?.reenable()
            return
        }
        guard type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown else { return }
        context.onMouseDown(event.location, event.getIntegerValueField(.eventSourceUnixProcessID),
                            event.getIntegerValueField(.eventSourceUserData))
    }
}

private let cuWatchTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    if let refcon { CUWatchClickTap.handle(refcon, type: type, event: event) }
    return Unmanaged.passUnretained(event)
}

// MARK: - Timers

/// One-shot timers on a utility queue, WITH leeway (a fifth of the delay, at most 1 s), so the watches' fallback and
/// debounce ride other wake-ups.
final class CUWatchTimers: CUWatchScheduling, @unchecked Sendable {
    private final class Item: CUWatchCancellable {
        let source: DispatchSourceTimer
        init(_ source: DispatchSourceTimer) { self.source = source }
        func cancel() { source.cancel() }
    }
    private let queue = DispatchQueue(label: "WinterCUCore.watch-timers", qos: .utility)

    func after(ms: Double, _ work: @escaping @Sendable () -> Void) -> CUWatchCancellable {
        let source = DispatchSource.makeTimerSource(queue: queue)
        let leeway = Int(min(1_000, max(10, ms * 0.2)))
        source.schedule(deadline: .now() + .milliseconds(Int(max(0, ms))), leeway: .milliseconds(leeway))
        source.setEventHandler { [source] in
            source.cancel()
            work()
        }
        source.resume()
        return Item(source)
    }
}
