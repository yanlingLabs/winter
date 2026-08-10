#if DEBUG
import AppKit
import Foundation

/// **The audio-leak repro** — the measured half of the diagnosis in
/// `docs/research/2026-08-10-cef-close-completion.md`.
///
/// The user's ledger showed a panel tab whose close STARTED and never finished: `DoClose` for
/// `id=1`, no `OnBeforeClose` ever, and the next create counting `live browsers=2`. The renderer
/// survived — with its audio — until the app quit. This harness reproduces that in an unattended
/// run, with the ONE observation that separates the two candidate mechanisms:
///
///   **is CEF's own host `NSView` still alive after the close?**
///
/// Because `CefBrowserHostView.dealloc` is what calls `AlloyBrowserHostImpl::WindowDestroyed()`
/// (CEF branch 7922, `libcef/browser/native/browser_platform_delegate_native_mac.mm`), and
/// `WindowDestroyed()` is the only remaining route to `DestroyBrowser()` once `DoClose` has
/// answered `true`. A host view that outlives the close IS the stalled close, and the harness
/// watches it through a `weak` reference so the answer is a fact about object lifetime rather than
/// an inference from a log.
///
/// Two more observations ride along, because a mechanism claim wants a consequence:
/// the container's own lifetime (SwiftUI releases it; the harness releases it the same way), and a
/// census of `Norma Helper` child processes — the renderer whose audio the user could hear.
///
/// **Entirely `#if DEBUG` and entirely env-gated** (`NORMA_SPIKE_CLOSE_LEAK=1`), the same shape
/// Task 1's reparent spike used: with the variable unset nothing here is reachable, and
/// `applicationDidFinishLaunching` hands the launch over *instead of* `boot()` rather than after
/// it — this bundle runs from a scratch `derivedDataPath` and must not perform any of `boot()`'s
/// account-global side effects (helper registration, login item, updater, hotkey, a second orb).
///
/// Ledger goes to **stderr**, one `LEAK` line per event, ms-stamped from launch.
enum SpikeCloseLeak {
    /// The whole gate. Read once per launch, before anything else happens.
    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["NORMA_SPIKE_CLOSE_LEAK"] == "1"
    }

    @MainActor
    static func start(delegate: AppDelegate) {
        let harness = SpikeCloseLeakHarness(delegate: delegate)
        SpikeCloseLeakHarness.shared = harness
        harness.begin()
    }
}

// MARK: - The harness

@MainActor
final class SpikeCloseLeakHarness {
    static var shared: SpikeCloseLeakHarness?

    private unowned let delegate: AppDelegate
    private let started = Date()
    private let window: NSWindow

    /// The production container, the class the production create builds (`BrowserRuntime.create`
    /// since browser-runtime T3; `PanelWebTab.makeNSView` when this harness was written) — so the
    /// close under measurement is the production close, not a stand-in's.
    private var container: PanelCEFContainerView?
    /// Held only so the harness can see it go: the container SwiftUI would have released.
    private weak var containerAfterClose: PanelCEFContainerView?
    /// **The measurement.** CEF's own view, captured while the browser is live. Weak on purpose —
    /// a strong reference here would recreate the very leak being measured.
    private weak var cefHostView: NSView?

    /// Second phase: the drill for the crash `51a43124` was written against — a shutdown sweep
    /// landing on a browser whose close is already in flight.
    private var drillContainer: PanelCEFContainerView?

    /// browser-runtime T7: the tabIds handed to `BrowserRuntime.shared` for the quit-with-N run.
    /// The containers themselves are the RUNTIME's — held by its `containers` map, which is the
    /// whole point of the measurement (see `parkTheRest`).
    private var parkedTabIds: [String] = []
    /// The loopback page server for the parked browsers, if one came up. Killed before the quit —
    /// the pages are already loaded and their audio is a `data:` WAV built in the renderer, so
    /// nothing about the measurement needs it alive, and a `Process` child outlives its parent.
    private var pageServer: Process?
    /// Containers created for the racing-create measurement (`NORMA_SPIKE_CLOSE_RACE`). Parked in
    /// the runtime's own parking window, so they are alive at quit like every other container.
    private var raceContainers: [PanelCEFContainerView] = []
    /// The loopback page URL once a server is up — the same page the racing creates use, since they
    /// run before `stopPageServer()`.
    private var pageURL: String?

    private let deadline = TimeInterval(SpikeCloseLeakHarness.envInt("NORMA_SPIKE_CLOSE_DEADLINE", 12))
    private var pollCount = 0
    private var closedAt: Date?
    private var verdictReported = false
    private var loaded = false
    private var phase = "boot"

    init(delegate: AppDelegate) {
        self.delegate = delegate
        window = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 900, height: 640),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma close-leak repro"
    }

    // MARK: Ledger

    private func log(_ line: String) {
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        fputs("LEAK \(ms) \(line)\n", stderr)
        fflush(stderr)
    }

    // MARK: Boot

    func begin() {
        log("BEGIN pid=\(ProcessInfo.processInfo.processIdentifier) deadline=\(Int(deadline))s")
        // Which binary is actually running, and when it was built. The stale-DerivedData trap is a
        // named prior failure in this repo (a stale `-derivedDataPath` re-tested a five-day-old
        // binary for a whole live gate), and one line makes freshness a fact in the ledger rather
        // than an assumption about the shell that launched it.
        let exe = Bundle.main.executableURL?.path ?? "?"
        let built = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)
            .flatMap { $0 } .map { ISO8601DateFormatter().string(from: $0) } ?? "?"
        log("BINARY \(exe) built=\(built)")
        let page = writePage()
        log("PAGE url=\(page)")

        let view = PanelCEFContainerView()
        view.frame = NSRect(origin: .zero, size: NSSize(width: 900, height: 640))
        view.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(view)
        container = view

        NormaCEFSetStateObserver(view) { [weak self] state in
            guard let self, !self.loaded else { return }
            _ = state
        }
        NormaCEFSetNavigationObserver(view) { [weak self] url, title in
            self?.onNavigation(url: url, title: title)
        }
        NormaCEFSetPopupObserver(view) { _ in }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // One run-loop turn before CEF comes up — `BrowserRuntime.startBrowser`'s reason: CefInitialize
        // stands up a process tree and runs `OnContextInitialized` re-entrantly.
        DispatchQueue.main.async { [weak self] in self?.startCEF(page: page) }
    }

    private func startCEF(page: String) {
        guard let helper = Self.helperExecutablePath() else {
            fatal("no CEF helper bundle in this build")
            return
        }
        let cache = Self.cachePath()
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: cache), withIntermediateDirectories: true)
        log("CEFINIT cache=\(cache)")

        // **Not `NormaCEFRuntime.ensureInitialized()`** — that derives `root_cache_path` from the
        // BUNDLE ID, which this Debug build shares with the user's live dev app, and Chromium takes
        // an EXCLUSIVE lock on it. Sharing it breaks whichever process loses the race, including
        // theirs. Same constraint, same answer, as Task 1's reparent spike. Everything downstream —
        // creation, observers, the close path — is the production API verbatim.
        guard NormaCEFInitialize(CommandLine.argc, CommandLine.unsafeArgv, cache, helper) else {
            fatal("CefInitialize failed: \(String(cString: NormaCEFLastError()))")
            return
        }
        log("CEFREADY")
        guard let container else { return }
        NormaCEFCreateBrowser(container, page)
    }

    private func onNavigation(url: String?, title: String?) {
        guard !loaded, phase == "boot" else { return }
        loaded = true
        log("LOADED url=\(url ?? "") title=\(title ?? "") mode=\(Self.mode)")
        // Let the renderer settle (and the page's audio element actually start) before the close.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self else { return }
            Self.mode == "quit" ? self.quitWithTheTabSTILLOPEN() : self.closeTheTab()
        }
    }

    /// **`NORMA_SPIKE_CLOSE_MODE=quit`: the path the per-tab measurement never exercised.**
    ///
    /// Fix round 1. The first AFTER run closed both tabs before quitting, so
    /// `NormaCEFCloseAllBrowsers` swept an EMPTY `g_browsers` and the `0 browser(s) still open` it
    /// printed said nothing at all about the drain. This mode quits with the tab open, which is what
    /// a user does, and is the only way to find out whether `NormaCEFShutdown`'s bounded
    /// `CefDoMessageLoopWork` loop can finish a close whose real gate is an **ObjC autorelease pool
    /// drain** — `removeFromSuperview` autoreleases CEF's view into whatever pool is active, and the
    /// pool active during `applicationWillTerminate:` never drains, because the process exits first.
    /// CEF turns cannot pop an AppKit pool.
    ///
    /// Everything measurable is in the `NormaCEF:` ledger the shutdown path prints itself: whether
    /// `browser closed (id=…)` arrives BEFORE `shutting down (N browser(s) still open, M DoWork
    /// calls)`, and what N is.
    private func quitWithTheTabSTILLOPEN() {
        phase = "quitting"
        let extra = max(Self.envInt("NORMA_SPIKE_CLOSE_BROWSERS", 1) - 1, 0)
        if extra == 0 && Self.raceCount == 0 {
            // T6's run, byte for byte — the default, so those archived ledgers stay reproducible.
            cefHostView = container?.subviews.first
            log("PREQUIT cefHostViewAlive=\(cefHostView != nil) helpers=\(Self.helperCensus()) — quitting with the tab OPEN")
            quit()
            return
        }
        parkTheRest(count: extra)
    }

    // MARK: - browser-runtime T7: the runtime's world at quit, not one tab

    /// **Quit with N browsers, most of them PARKED — the shape T6's one-tab run could not reach.**
    ///
    /// T6 measured the quit path against a single browser in a visible window and fixed it there.
    /// The runtime's world is up to 8 (`BrowserLifecycleEngine.maxLive`), and all but the shown
    /// one live in `BrowserRuntime`'s hidden parking window with their containers held **strongly**
    /// by its `containers` map — a map nothing clears at quit (no quit path calls `stop`;
    /// `applicationWillTerminate` → `closeMainWindows()` reaches only `PanelViewport.dismantleNSView`,
    /// which detaches). Every container therefore outlives the sweep, still retaining CEF's host
    /// view as a subview. That is the T6 deadlock's shape one layer up, and whether it bites is a
    /// question about `CompleteCloseByReleasingHostView`'s `-removeFromSuperview` — which severs
    /// that retain before the record drops its own — so it is a question to MEASURE, not to argue.
    ///
    /// The creates go through `BrowserRuntime.shared.apply` rather than `NormaCEFCreateBrowser`
    /// directly: the parking window, the container registry, the model wiring and the URL policy are
    /// all part of what is being measured, and `.shared` specifically because a `static let` is what
    /// makes "still holding every container at `applicationWillTerminate`" structural.
    ///
    /// **That does not undo this harness's cache-path discipline.** The production driver's
    /// `ensureInitialized` calls `NormaCEFRuntime.ensureInitialized()`, which passes the BUNDLE-ID
    /// cache path the user's live dev app holds a Chromium lock on — but `NormaCEFInitialize`
    /// returns `YES` on its `g_initialized` short-circuit before reading it, so `CefInitialize` is
    /// never called a second time and no second profile lock is ever taken. CEF stays on the scratch
    /// profile `startCEF` brought it up on.
    private func parkTheRest(count: Int) {
        phase = "parking"
        let url = startPageServer().map { "http://127.0.0.1:\($0)/leak.html" }
        if url == nil {
            // Not fatal. `PanelURLPolicy.restorableURL` refuses `file:`, so a nil url is the built-in
            // `data:` New Tab page: real browsers and real renderers, without the media element.
            log("PARK-NOSERVER — parked browsers will load the built-in New Tab page (no audio)")
        }
        parkedTabIds = (1...count).map { "spike-park-\($0)" }
        let tabs = ["spike": parkedTabIds.map {
            BrowserTabState(tabId: $0, url: url, isShown: false, title: "parked")
        }]
        log("PARK-CREATE n=\(count) url=\(url ?? "(new tab page)")")
        BrowserRuntime.shared.apply(parkedTabIds.map { .create(tabId: $0, url: url) },
                                    tabs: tabs, sessionOf: { _ in "spike" })
        pollParked(attempt: 0)
    }

    /// Wait for CEF to have parented its own view into every parked container — an observation, not
    /// a sleep. `BrowserRuntime.create` defers the CEF call by one main-queue turn and the creation
    /// itself is asynchronous, so "apply returned" means only that containers exist.
    ///
    /// Matched on Chromium's class name rather than "has a subview": the other thing that can appear
    /// in a container is `showUnavailable`'s `NSTextField`, and a run that silently measured seven
    /// placeholder labels would report a clean quit for browsers that never existed.
    private func pollParked(attempt: Int) {
        let ready = parkedTabIds.filter { tabId in
            guard let c = BrowserRuntime.shared.container(forTabId: tabId) else { return false }
            return c.subviews.contains { String(describing: type(of: $0)) == "CefBrowserHostView" }
        }
        let placeholders = parkedTabIds.filter { tabId in
            guard let c = BrowserRuntime.shared.container(forTabId: tabId) else { return false }
            return c.subviews.contains { $0 is NSTextField }
        }
        if !placeholders.isEmpty {
            fatal("parked containers showing the unavailable placeholder: \(placeholders)")
            return
        }
        if ready.count == parkedTabIds.count {
            log("PARK-READY n=\(ready.count) attempts=\(attempt) helpers=\(Self.helperCensus())")
            // Let the pages load and their media elements actually start before the quit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in self?.raceThenQuit() }
            return
        }
        guard attempt < 200 else {   // 200 × 50 ms = 10 s
            fatal("only \(ready.count)/\(parkedTabIds.count) parked browsers ever reached CEF")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.pollParked(attempt: attempt + 1)
        }
    }

    /// **`NORMA_SPIKE_CLOSE_RACE=K`: quit while K creations are still inside CEF's own queue.**
    ///
    /// The tripwire's remaining unknown (T7 Q3): `shutting down (N…)` is claimed as a genuine
    /// tripwire, and that claim is only useful if the racing-create case has a stated expected N.
    ///
    /// The create is made DIRECTLY here, in the same run-loop turn as the quit, and that is the
    /// point rather than a shortcut: `BrowserRuntime.create` defers its `NormaCEFCreateBrowser` by
    /// one main-queue turn (`startBrowser`), and at quit that turn never comes — the run loop is
    /// stopping, and `CefDoMessageLoopWork` drives CEF's loop, not GCD's. Going through `apply`
    /// would therefore measure nothing at all: the creation would die on the queue instead of being
    /// handed to CEF. This calls the identical entry point that hop would have called.
    ///
    /// The containers are parked in the runtime's own parking window, so they are alive at quit like
    /// every other one.
    private func raceThenQuit() {
        let k = Self.raceCount
        if k > 0, let parkingHost = BrowserRuntime.shared.parkingWindow.contentView {
            let page = pageURL ?? panelWebTabStartPageURL
            for _ in 1...k {
                let view = PanelCEFContainerView()
                view.frame = parkingHost.bounds
                parkingHost.addSubview(view)
                raceContainers.append(view)
                NormaCEFCreateBrowser(view, page)
            }
            log("RACE-CREATE k=\(k) — quitting in this same turn, with the creations inside CEF's queue")
        }
        stopPageServer()
        cefHostView = container?.subviews.first
        let liveTabs = BrowserRuntime.shared.liveTabIds.count
        log("PREQUIT cefHostViewAlive=\(cefHostView != nil) runtimeContainers=\(liveTabs) "
            + "racing=\(raceContainers.count) helpers=\(Self.helperCensus()) — quitting with them ALL OPEN")
        quit()
    }

    // MARK: The loopback page server

    /// `python3 -m http.server` over the spike's own page directory, so the PARKED browsers load the
    /// same media page the visible one does. They cannot load it as `file:` — those creates go
    /// through `BrowserRuntime.create`, whose `PanelURLPolicy.restorableURL` allows `http`/`https`
    /// and nothing else — and a parked browser rendering a static page would be a weaker instrument
    /// than one with a live media element, which is the state the whole audio-leak class is about.
    ///
    /// Best-effort by construction: a failure logs and the run continues on the New Tab page.
    private func startPageServer() -> Int? {
        let dir = URL(fileURLWithPath: writePage()).deletingLastPathComponent().path
        let port = Int.random(in: 49_200...58_000)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["python3", "-m", "http.server", "\(port)",
                          "--bind", "127.0.0.1", "--directory", dir]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else {
            log("PAGESERVER-FAILED could not launch python3")
            return nil
        }
        pageServer = task
        // Probe rather than sleep: the server is up when it answers a connection.
        for _ in 0..<60 {
            if Self.canConnect(port: port) {
                pageURL = "http://127.0.0.1:\(port)/leak.html"
                log("PAGESERVER port=\(port) dir=\(dir)")
                return port
            }
            usleep(50_000)
        }
        log("PAGESERVER-TIMEOUT port=\(port)")
        stopPageServer()
        return nil
    }

    private func stopPageServer() {
        guard let server = pageServer else { return }
        server.terminate()
        pageServer = nil
        log("PAGESERVER-STOPPED")
    }

    private static func canConnect(port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        return ok
    }

    // MARK: Phase 1 — the close under measurement

    /// **The production close, in the production order.** `BrowserRuntime.stop` clears the three
    /// observers and calls `NormaCEFCloseBrowser`, then unparents and releases the container — the
    /// same two halves, in the same order, that `PanelWebTab.dismantleNSView` + SwiftUI's release
    /// performed when this harness was written (browser-runtime T4 moved them). Both halves happen
    /// here, so a container still alive afterwards would be this harness's fault and is asserted
    /// against rather than assumed away.
    private func closeTheTab() {
        guard let container else { return }
        phase = "closing"

        // CEF's own view is the container's only subview at this point (the placeholder is only
        // built on the unavailable path, which a loaded page never took).
        cefHostView = container.subviews.first
        log("PRECLOSE cefHostView=\(cefHostView.map { String(describing: type(of: $0)) } ?? "nil") helpers=\(Self.helperCensus())")

        NormaCEFSetStateObserver(container, nil)
        NormaCEFSetNavigationObserver(container, nil)
        NormaCEFSetPopupObserver(container, nil)
        NormaCEFCloseBrowser(container)
        log("CLOSE-CALLED")

        // SwiftUI's half: the representable's `NSView` goes away with the view tree.
        containerAfterClose = container
        container.removeFromSuperview()
        self.container = nil
        closedAt = Date()

        poll()
    }

    private func poll() {
        pollCount += 1
        let elapsed = Date().timeIntervalSince(closedAt ?? Date())
        let hostAlive = cefHostView != nil
        let containerAlive = containerAfterClose != nil
        let helpers = Self.helperCensus()
        log("POLL n=\(pollCount) afterMs=\(Int(elapsed * 1000)) cefHostViewAlive=\(hostAlive) containerAlive=\(containerAlive) helpers=\(helpers)")

        if !hostAlive {
            report(verdict: "PASS", elapsed: elapsed, helpers: helpers,
                   detail: "CEF's host view deallocated — dealloc runs WindowDestroyed(), which is "
                       + "the only route to DestroyBrowser()/OnBeforeClose once DoClose answered true")
            return
        }
        if elapsed >= deadline {
            report(verdict: "FAIL", elapsed: elapsed, helpers: helpers,
                   detail: "CEF's host view is STILL ALIVE after the close — something retains it, "
                       + "so its dealloc never ran, so WindowDestroyed() never ran, so OnBeforeClose "
                       + "can never fire. This is the leaked renderer (and its audio).")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.poll() }
    }

    private func report(verdict: String, elapsed: TimeInterval, helpers: String, detail: String) {
        guard !verdictReported else { return }
        verdictReported = true
        log("VERDICT \(verdict) afterMs=\(Int(elapsed * 1000)) containerAlive=\(containerAfterClose != nil) helpers=\(helpers)")
        log("VERDICT-DETAIL \(detail)")
        // Give any in-flight OnBeforeClose + renderer exit a moment to show up in the census.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            guard let self else { return }
            self.log("SETTLED cefHostViewAlive=\(self.cefHostView != nil) containerAlive=\(self.containerAfterClose != nil) helpers=\(Self.helperCensus())")
            self.startDrill()
        }
    }

    // MARK: Phase 2 — the zombie drill

    /// **The exact case `51a43124` made the record's `hostView` strong for**: a shutdown sweep
    /// (`NormaCEFCloseAllBrowsers`) landing on a browser a per-tab close already started but whose
    /// `OnBeforeClose` has not arrived. Before that fix the sweep read `GetWindowHandle()` and
    /// messaged a freed view — `CrZombie`, deliberate crash. Anything that weakens the close side
    /// has to survive this, so the harness runs it rather than reasoning about it: a second tab, the
    /// production close, then the sweep in the SAME run-loop turn and again after a pool drain.
    private func startDrill() {
        phase = "drill"
        let view = PanelCEFContainerView()
        view.frame = NSRect(origin: .zero, size: NSSize(width: 900, height: 640))
        view.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(view)
        drillContainer = view
        log("DRILL-CREATE")
        NormaCEFCreateBrowser(view, writePage())
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in self?.runDrill() }
    }

    private func runDrill() {
        guard let view = drillContainer else { return }
        log("DRILL-CLOSE helpers=\(Self.helperCensus())")
        NormaCEFSetStateObserver(view, nil)
        NormaCEFSetNavigationObserver(view, nil)
        NormaCEFSetPopupObserver(view, nil)
        NormaCEFCloseBrowser(view)
        view.removeFromSuperview()
        drillContainer = nil
        // Same turn: the record still exists (no OnBeforeClose yet) and the sweep will read it.
        NormaCEFCloseAllBrowsers()
        log("DRILL-SWEEP-SAME-TURN survived")
        // And after a pool drain, when a released view has actually been freed — the harder half.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            NormaCEFCloseAllBrowsers()
            self.log("DRILL-SWEEP-AFTER-DRAIN survived helpers=\(Self.helperCensus())")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                guard let self else { return }
                self.log("END helpers=\(Self.helperCensus())")
                self.quit()
            }
        }
    }

    // MARK: Plumbing

    /// `Norma Helper` children of this process — the renderer whose audio the user could hear, plus
    /// GPU/network/utility. Measured with `ps` rather than inferred, and reported as
    /// `total(renderers)`.
    nonisolated static func helperCensus() -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-o", "ppid=,command="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return "?" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let me = String(ProcessInfo.processInfo.processIdentifier)
        var total = 0
        var renderers = 0
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let space = trimmed.firstIndex(of: " ") else { continue }
            guard String(trimmed[trimmed.startIndex..<space]) == me else { continue }
            let command = String(trimmed[space...])
            guard command.contains("Norma Helper") else { continue }
            total += 1
            if command.contains("--type=renderer") { renderers += 1 }
        }
        return "\(total)(\(renderers)r)"
    }

    private func fatal(_ reason: String) {
        log("FATAL \(reason)")
        // Before the quit, always: a `Process` child outlives its parent, and a stranded page server
        // would sit on a loopback port for the rest of the login session.
        stopPageServer()
        quit()
    }

    private func quit() {
        // Lifecycle T4's one true-quit gate, armed from outside the menu bar — the same deliberate
        // bypass Task 1's spike documents. Every other `NSApp.terminate` is answered
        // `.terminateCancel`, which for an unattended run means never ending and never shutting CEF
        // down. Safe because this file is `#if DEBUG` and unreachable without the env gate: the
        // spike owns the whole process (it ran INSTEAD of `boot()` — no daemon, no orb, no user
        // window to take down with it).
        delegate.reallyQuitting = true
        NSApp.terminate(nil)
    }

    fileprivate static func envInt(_ key: String, _ fallback: Int) -> Int {
        guard let v = ProcessInfo.processInfo.environment[key], let n = Int(v) else { return fallback }
        return n
    }

    /// `close` (default) — the per-tab close of §1. `quit` — quit with the tab still open, which is
    /// the ONLY way to exercise `NormaCEFShutdown`'s drain; see `quitWithTheTabSTILLOPEN`.
    ///
    /// Two knobs ride on `quit`, both defaulting to T6's exact one-browser run so its archived
    /// ledgers stay reproducible: `NORMA_SPIKE_CLOSE_BROWSERS=N` (total live browsers at quit — one
    /// visible, the rest parked through `BrowserRuntime.shared`) and `NORMA_SPIKE_CLOSE_RACE=K`
    /// (creations still inside CEF's own queue when the quit lands).
    fileprivate static var mode: String {
        ProcessInfo.processInfo.environment["NORMA_SPIKE_CLOSE_MODE"] ?? "close"
    }

    fileprivate static var raceCount: Int { max(envInt("NORMA_SPIKE_CLOSE_RACE", 0), 0) }

    /// Scratch Chromium profile — never `~/.norma*`, never the bundle-id path the user's live dev
    /// app holds an exclusive lock on. See `startCEF`.
    private static func cachePath() -> String {
        if let explicit = ProcessInfo.processInfo.environment["NORMA_SPIKE_CEF_CACHE"], !explicit.isEmpty {
            return explicit
        }
        return NSTemporaryDirectory() + "norma-closeleak-cef"
    }

    /// A three-line copy of `NormaCEFRuntime.helperExecutablePath()` — private there, and copying it
    /// is right for spike code that must not widen a production surface.
    private static func helperExecutablePath() -> String? {
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Frameworks/Norma Helper.app/Contents/MacOS", isDirectory: true)
            .appendingPathComponent("Norma Helper", isDirectory: false)
        return FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
    }

    /// A `file://` page with a looping audio element, so the run reproduces the user's *symptom*
    /// (sound from a closed tab) and not only its mechanism. Autoplay may be refused without a
    /// gesture — nothing is gated on it, and the census below is the measurement either way.
    private func writePage() -> String {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("norma-closeleak-page", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("leak.html")
        try? Self.pageHTML.write(to: file, atomically: true, encoding: .utf8)
        return file.absoluteString
    }

    private static let pageHTML = #"""
    <!doctype html><meta charset="utf-8"><title>close-leak repro</title>
    <style>html,body{height:100%;margin:0;background:#101014;color:#e6e6ea;
      font:15px -apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}</style>
    <body>
      <div>close-leak repro — a live renderer with a media element</div>
      <script>
        // 1s of a 440 Hz sine as a data: WAV, looped. A media element keeps the renderer busy in
        // the same way the user's YouTube tab did.
        const rate = 8000, n = rate, head = 44, buf = new Uint8Array(head + n * 2);
        const dv = new DataView(buf.buffer);
        const ascii = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
        ascii(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ascii(8, "WAVEfmt ");
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        ascii(36, "data"); dv.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) dv.setInt16(head + i * 2, Math.sin(i / rate * 440 * 2 * Math.PI) * 12000, true);
        let bin = ""; for (const b of buf) bin += String.fromCharCode(b);
        const a = new Audio("data:audio/wav;base64," + btoa(bin));
        a.loop = true; a.volume = 0.25;
        a.play().then(() => { document.title = "audio playing"; })
                .catch(e => { document.title = "audio refused: " + e.name; });
      </script>
    </body>
    """#
}
#endif
