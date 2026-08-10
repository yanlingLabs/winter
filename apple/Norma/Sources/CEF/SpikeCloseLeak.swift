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

    /// The production container, the class `PanelWebTab.makeNSView` builds — so the close under
    /// measurement is the production close, not a stand-in's.
    private var container: PanelCEFContainerView?
    /// Held only so the harness can see it go: the container SwiftUI would have released.
    private weak var containerAfterClose: PanelCEFContainerView?
    /// **The measurement.** CEF's own view, captured while the browser is live. Weak on purpose —
    /// a strong reference here would recreate the very leak being measured.
    private weak var cefHostView: NSView?

    /// Second phase: the drill for the crash `51a43124` was written against — a shutdown sweep
    /// landing on a browser whose close is already in flight.
    private var drillContainer: PanelCEFContainerView?

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

        // One run-loop turn before CEF comes up — `PanelWebTab.startBrowser`'s reason: CefInitialize
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
        cefHostView = container?.subviews.first
        log("PREQUIT cefHostViewAlive=\(cefHostView != nil) helpers=\(Self.helperCensus()) — quitting with the tab OPEN")
        quit()
    }

    // MARK: Phase 1 — the close under measurement

    /// **The production close, in the production order.** `PanelWebTab.dismantleNSView` clears the
    /// three observers and calls `NormaCEFCloseBrowser`; SwiftUI then releases the container. Both
    /// halves happen here, so a container still alive afterwards would be this harness's fault and
    /// is asserted against rather than assumed away.
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
    fileprivate static var mode: String {
        ProcessInfo.processInfo.environment["NORMA_SPIKE_CLOSE_MODE"] ?? "close"
    }

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
