#if DEBUG
import AppKit
import Foundation

/// browser-runtime Task 1 — **the measured spike the whole Browser Runtime design rests on.**
///
/// The spec's §3 asserts one load-bearing AppKit/CEF fact: a **live windowed CEF browser survives
/// having its container `NSView` reparented between a hidden parking window and a visible one**,
/// repeatedly, in both directions, with audio still playing, input still arriving and the page
/// still correctly sized. Everything the runtime inversion buys — tab switches that keep video
/// playing, headless browsers an agent drives while the user looks elsewhere — is that one fact.
/// B1's two spikes each voided several "established" facts, so this one is measured, not reasoned.
///
/// **Entirely `#if DEBUG` and entirely env-gated** (`NORMA_SPIKE_REPARENT=1`). With the variable
/// unset nothing in this file is reachable: `AppDelegate.applicationDidFinishLaunching` asks
/// `SpikeReparent.isRequested` and, only if it says yes, hands the launch over — *instead of*
/// `boot()`, never after it (see `start`). The Release app does not contain this file at all.
///
/// The measurements are written to **stderr**, one line per event, prefixed `SPIKE`, and the run is
/// unattended: it starts CEF, loads its own instrumented page, waits for the page's audio clock to
/// prove audio is genuinely playing, runs the cycles, and quits itself. The page reports its own
/// state back through `document.title` → `CefDisplayHandler::OnTitleChange` → the container's state
/// observer, because that is the one channel out of a page this bridge already has (there is no JS
/// evaluation entry point on `NormaCEF.h`, and `javascript:` never enters a load path).
enum SpikeReparent {
    /// The whole gate. Read once per launch, before anything else happens.
    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["NORMA_SPIKE_REPARENT"] == "1"
    }

    /// Take the launch over. Called **instead of** `AppProfile.bootstrapEnvironment()` + `boot()`,
    /// which is a deliberate placement rather than a convenience: `boot()` performs account-global
    /// side effects from whatever bundle happens to be executing — `SMAppService` helper
    /// registration, login-item registration, launchd migration, the updater, the global hotkey,
    /// a second menu-bar orb — and this spike runs from a throwaway bundle in a scratch
    /// `derivedDataPath` that gets deleted. None of that may point at it. The spike needs
    /// `NSWindow`s and CEF, nothing else.
    @MainActor
    static func start(delegate: AppDelegate) {
        let harness = SpikeReparentHarness(delegate: delegate)
        SpikeReparentHarness.shared = harness
        harness.begin()
    }
}

// MARK: - The harness

/// One run. Owns both windows, the container, the step machine and the ledger.
@MainActor
final class SpikeReparentHarness {
    static var shared: SpikeReparentHarness?

    private unowned let delegate: AppDelegate
    private let started = Date()

    /// The **hidden parking window** of spec §3 — borderless, never ordered in. Deliberately a
    /// DIFFERENT size from the visible window, so every reparent is also a resize and
    /// `PanelCEFContainerView.resizeSubviews(withOldSize:)` is forced to run on every single move.
    /// A container that happened to match sizes would prove nothing about resize correctness.
    private let parkingWindow: NSWindow
    /// Stands in for the panel: an ordinary titled window whose `contentView` is the viewport.
    private let visibleWindow: NSWindow
    /// The real thing — the same class `PanelWebTab.makeNSView` builds, so the spike measures the
    /// production container's autoresize path rather than a stand-in's.
    private let container = PanelCEFContainerView()

    private var steps: [(delay: TimeInterval, label: String, body: () -> Void)] = []
    private var stepIndex = 0

    /// The last payload the page published through its title, already split.
    private var lastSample: [String] = []
    private var lastTitle = ""
    /// Every title the state observer has seen, sample or not — the discriminator in `onState`.
    private var lastObservedTitle: String?
    /// State-observer callbacks whose title is unchanged did NOT come from `OnTitleChange`; they
    /// came from `OnAddressChange` / `OnLoadingStateChange` / `OnLoadEnd`. That distinction is
    /// requirement 5 — "does a reparent fire any CEF callback at all" — and it is the only way to
    /// see it, since the state observer is one channel for four producers.
    private var stateCallbacks = 0
    private var phase = "init"
    private var cycle = 0
    private var msSinceLastMove: Int { Int(Date().timeIntervalSince(lastMove) * 1000) }
    private var lastMove = Date()

    private let cycles = 20
    private let visibleDwell: TimeInterval = 3.5
    private let parkedDwell: TimeInterval = 3.5
    /// The long tail: one 40 s park and one 40 s show, so the CPU sampler has clean, uncontended
    /// windows to average over instead of 3.5 s slivers.
    private let longDwell: TimeInterval = 40

    private let parkedSize = NSSize(width: 700, height: 500)
    private let visibleSizes = [NSSize(width: 1000, height: 700), NSSize(width: 820, height: 560)]

    init(delegate: AppDelegate) {
        self.delegate = delegate
        parkingWindow = NSWindow(
            contentRect: NSRect(origin: .zero, size: parkedSize),
            styleMask: [.borderless], backing: .buffered, defer: false)
        parkingWindow.isReleasedWhenClosed = false
        parkingWindow.title = "Norma spike parking"

        visibleWindow = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 1000, height: 700),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        visibleWindow.isReleasedWhenClosed = false
        visibleWindow.title = "Norma reparent spike"
    }

    // MARK: Ledger

    /// Every measurable thing this run does goes through here, on stderr, monotonic-ms-stamped from
    /// launch. `fflush` because the run is read live from a terminal and a crash must not eat the
    /// last lines — which is exactly the shape of failure this spike exists to catch.
    private func log(_ line: String) {
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        fputs("SPIKE \(ms) \(line)\n", stderr)
        fflush(stderr)
    }

    // MARK: Boot

    func begin() {
        log("BEGIN parkMode=\(Self.parkMode) cycles=\(cycles) pid=\(ProcessInfo.processInfo.processIdentifier)")

        let pageURL = writePage()
        log("PAGE url=\(pageURL)")

        // The container is born in the PARKING window and the browser is created there — never in a
        // visible one. That order is deliberate: "a browser created while parked loads fine" is a
        // fact the runtime's headless path (spec §5) and B2 both need, and creating it visible
        // first would leave it unmeasured.
        container.frame = NSRect(origin: .zero, size: parkedSize)
        container.autoresizingMask = [.width, .height]
        parkingWindow.contentView?.addSubview(container)

        switch Self.parkMode {
        case "offscreen":
            parkingWindow.setFrameOrigin(NSPoint(x: -20000, y: -20000))
            parkingWindow.orderFront(nil)
        case "ordered-out":
            parkingWindow.orderFront(nil)
            parkingWindow.orderOut(nil)
        default:
            break  // "never": the spec's literal shape — the window is never ordered in at all.
        }
        log("PARKWINDOW visible=\(parkingWindow.isVisible) occlusion=\(parkingWindow.occlusionState.rawValue) num=\(parkingWindow.windowNumber)")

        NormaCEFSetStateObserver(container) { [weak self] state in
            self?.onState(state)
        }
        NormaCEFSetNavigationObserver(container) { [weak self] url, title in
            self?.log("NAV phase=\(self?.phase ?? "?") sinceMove=\(self?.msSinceLastMove ?? -1)ms url=\(url ?? "") title=\(Self.short(title ?? ""))")
        }
        NormaCEFSetPopupObserver(container) { [weak self] url in
            self?.log("POPUP url=\(url ?? "")")
        }

        visibleWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // One run-loop turn before CEF comes up, for the reason `PanelWebTab.startBrowser` states:
        // `CefInitialize` stands up a process tree and runs `OnContextInitialized` re-entrantly, and
        // the pump spike's un-root-caused first-load failure had startup starvation as its surviving
        // hypothesis. Deferring guarantees the run loop is genuinely spinning.
        DispatchQueue.main.async { [weak self] in self?.startCEF(pageURL: pageURL) }
    }

    private func startCEF(pageURL: String) {
        guard let helper = Self.helperExecutablePath() else {
            log("FATAL no CEF helper bundle in this build")
            return
        }
        let cache = Self.cachePath()
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: cache), withIntermediateDirectories: true)
        log("CEFINIT cache=\(cache)")

        // **Not `NormaCEFRuntime.ensureInitialized()`, and the reason is a hard environment
        // constraint rather than a preference.** That path derives `root_cache_path` from the
        // BUNDLE ID, and this Debug spike carries the same bundle id as the user's live dev app.
        // Chromium takes an exclusive lock on `root_cache_path`: sharing it means whichever process
        // initialises second fails with exit code 24 — and if the spike wins the race, the user's
        // browser panel is the thing that breaks. The hazard is bidirectional, so the spike takes a
        // scratch profile of its own. Everything downstream of this one call — creation, the three
        // observers, the chrome verbs, the close path — is the production API verbatim.
        let ok = NormaCEFInitialize(CommandLine.argc, CommandLine.unsafeArgv, cache, helper)
        guard ok else {
            log("FATAL CefInitialize failed: \(String(cString: NormaCEFLastError()))")
            return
        }
        log("CEFREADY")
        NormaCEFCreateBrowser(container, pageURL)
        waitForAudio(attempt: 0)
    }

    /// Gate the cycles on **measured audio**, never on a fixed delay: the page publishes its media
    /// clock and its `AudioContext` clock, and both have to be advancing before a single reparent
    /// happens. Otherwise a run where autoplay silently failed would produce twenty beautiful
    /// green cycles proving nothing at all.
    private func waitForAudio(attempt: Int) {
        let mediaMs = sampleInt(3)
        let ctxMs = sampleInt(4)
        if mediaMs > 700 && ctxMs > 700 {
            log("AUDIOSTARTED afterMs=\(attempt * 500) mediaMs=\(mediaMs) ctxMs=\(ctxMs)")
            buildSteps()
            pump()
            return
        }
        guard attempt < 120 else {
            log("FATAL audio never started (mediaMs=\(mediaMs) ctxMs=\(ctxMs)) — last title=\(lastTitle)")
            log("HINT relaunch with --autoplay-policy=no-user-gesture-required, or click Start in the window")
            return
        }
        if attempt % 10 == 0 {
            log("WAITAUDIO attempt=\(attempt) mediaMs=\(mediaMs) ctxMs=\(ctxMs) title=\(Self.short(lastTitle))")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.waitForAudio(attempt: attempt + 1)
        }
    }

    // MARK: The cycle programme

    private func buildSteps() {
        for i in 1...cycles {
            let size = visibleSizes[i % visibleSizes.count]
            enqueue(0.2, "attach\(i)") { [weak self] in self?.attach(cycle: i, size: size) }
            // Key #1 goes in WITHOUT touching the first responder — that is the whole first-responder
            // measurement: did the reparent leave the CEF view able to take a keystroke on its own?
            enqueue(0.5, "key1-\(i)") { [weak self] in self?.injectKey("a", keyCode: 0, forceFirstResponder: false) }
            // Key #2 goes in after an explicit `makeFirstResponder`. Comparing the page's key count
            // across the two says which of "it just works" and "the host must re-focus it" is true.
            enqueue(0.5, "key2-\(i)") { [weak self] in self?.injectKey("b", keyCode: 11, forceFirstResponder: true) }
            enqueue(0.6, "measure\(i)") { [weak self] in self?.measure(tag: "visible") }
            enqueue(visibleDwell - 1.8, "detach\(i)") { [weak self] in self?.detach(cycle: i) }
            enqueue(parkedDwell - 0.6, "measure-parked\(i)") { [weak self] in self?.measure(tag: "parked") }
            enqueue(0.6, "cycle-end\(i)") {}
        }
        // The long tail — clean CPU windows, and the only place the page sits parked long enough for
        // Chromium's own background-timer throttling to become visible in the tick rate.
        enqueue(0.2, "long-park-start") { [weak self] in self?.mark("LONGPARK begin") }
        enqueue(longDwell, "long-park-end") { [weak self] in self?.measure(tag: "long-parked") }
        enqueue(0.2, "long-show") { [weak self] in
            guard let self else { return }
            self.attach(cycle: self.cycles + 1, size: self.visibleSizes[0])
        }
        enqueue(longDwell, "long-show-end") { [weak self] in self?.measure(tag: "long-visible") }
        // Quit with a browser PARKED, which is live gate 7's shape — a free fact.
        enqueue(0.2, "final-park") { [weak self] in
            guard let self else { return }
            self.detach(cycle: self.cycles + 1)
        }
        enqueue(2.0, "quit") { [weak self] in self?.finish() }
    }

    private func enqueue(_ delay: TimeInterval, _ label: String, _ body: @escaping () -> Void) {
        steps.append((delay, label, body))
    }

    private func pump() {
        guard stepIndex < steps.count else { return }
        let step = steps[stepIndex]
        stepIndex += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + step.delay) { [weak self] in
            step.body()
            self?.pump()
        }
    }

    // MARK: The move itself

    /// **One `addSubview` call, and never a `removeFromSuperview` first.** The spec's invariant is
    /// that CEF's views are in a window at all times; a `removeFromSuperview` + `addSubview` pair
    /// would put the browser through a windowless intermediate state and measure a different, easier
    /// experiment. AppKit's `addSubview` performs the move itself.
    ///
    /// CEF's OWN view is never touched — only the container moves, which is exactly what
    /// `attachViewport`/`detachViewport` will do.
    private func attach(cycle: Int, size: NSSize) {
        self.cycle = cycle
        guard let host = visibleWindow.contentView else { return }
        let before = describeCEFSubview()
        let frBefore = Self.describe(visibleWindow.firstResponder)
        visibleWindow.setContentSize(size)
        host.addSubview(container)
        container.frame = NSRect(origin: .zero, size: size)
        phase = "visible"
        lastMove = Date()
        stateCallbacks = 0
        log("ATTACH cyc=\(cycle) size=\(Int(size.width))x\(Int(size.height)) cefBefore=\(before) cefAfter=\(describeCEFSubview()) frBefore=\(frBefore) frAfter=\(Self.describe(visibleWindow.firstResponder)) key=\(visibleWindow.isKeyWindow) inWindow=\(container.window === visibleWindow)")
    }

    private func detach(cycle: Int) {
        guard let host = parkingWindow.contentView else { return }
        host.addSubview(container)
        container.frame = NSRect(origin: .zero, size: parkedSize)
        phase = "parked"
        lastMove = Date()
        stateCallbacks = 0
        log("DETACH cyc=\(cycle) size=\(Int(parkedSize.width))x\(Int(parkedSize.height)) cef=\(describeCEFSubview()) inWindow=\(container.window === parkingWindow) parkVisible=\(parkingWindow.isVisible)")
    }

    /// The keystroke half. `NSWindow.sendEvent` rather than `CGEvent` posting: this is in-process
    /// delivery straight into our own responder chain, so it needs no Accessibility TCC — which the
    /// development environment does not have and cannot be given (`AppDelegate`'s panel-smoke door
    /// records the same constraint).
    private func injectKey(_ ch: String, keyCode: UInt16, forceFirstResponder: Bool) {
        guard let cefView = container.subviews.first else {
            log("KEY cyc=\(cycle) ch=\(ch) SKIPPED no CEF subview")
            return
        }
        var made = "n/a"
        if forceFirstResponder {
            made = visibleWindow.makeFirstResponder(cefView) ? "yes" : "REFUSED"
        }
        let fr = Self.describe(visibleWindow.firstResponder)
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let ev = NSEvent.keyEvent(
                with: type, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: visibleWindow.windowNumber, context: nil,
                characters: ch, charactersIgnoringModifiers: ch,
                isARepeat: false, keyCode: keyCode) else { continue }
            visibleWindow.sendEvent(ev)
        }
        log("KEY cyc=\(cycle) ch=\(ch) forcedFR=\(made) fr=\(fr) key=\(visibleWindow.isKeyWindow)")
    }

    // MARK: Measurement

    private func mark(_ what: String) {
        phase = "parked"
        lastMove = Date()
        log("MARK \(what) phase=\(phase)")
    }

    /// A snapshot line pairing what the HOST believes (container/CEF-view geometry) with what the
    /// PAGE believes (its own `innerWidth`/`innerHeight`, clocks and counters). Resize correctness is
    /// the agreement of the two; audio continuity is the page's clocks against wall time.
    private func measure(tag: String) {
        let cefFrame = container.subviews.first.map { NSStringFromRect($0.frame) } ?? "none"
        log("MEASURE tag=\(tag) cyc=\(cycle) container=\(NSStringFromRect(container.frame)) cef=\(cefFrame) window=\(container.window === visibleWindow ? "visible" : (container.window === parkingWindow ? "parking" : "NONE")) sample=\(lastTitle)")
    }

    /// **The one channel, four producers — and the whole of requirement 5 lives in telling them
    /// apart.** `NotifyState` is called from `OnTitleChange`, `OnAddressChange`,
    /// `OnLoadingStateChange` and `OnLoadEnd` alike, so the observer alone cannot say which fired.
    /// It can be inferred exactly, though: the page mutates its title 4×/s with a monotonic `seq`,
    /// so a callback carrying a title IDENTICAL to the previous one provably did not come from
    /// `OnTitleChange`. Those are the ones a reparent would produce, and they are logged
    /// individually; the sample stream itself is not (it would be thousands of lines).
    private func onState(_ state: NormaCEFBrowserState?) {
        guard let state else { return }
        stateCallbacks += 1
        let title = state.title ?? ""
        let isSample = title.hasPrefix("NS|")
        let titleChanged = (title != lastObservedTitle)
        lastObservedTitle = title
        if isSample {
            lastTitle = title
            lastSample = title.components(separatedBy: "|")
        }
        if !titleChanged {
            log("STATE-NOT-A-TITLE-CHANGE phase=\(phase) cyc=\(cycle) sinceMove=\(msSinceLastMove)ms loading=\(state.isLoading) back=\(state.canGoBack) fwd=\(state.canGoForward) url=\(state.url ?? "") title=\(Self.short(title))")
        } else if !isSample {
            log("STATE-TITLE phase=\(phase) cyc=\(cycle) sinceMove=\(msSinceLastMove)ms loading=\(state.isLoading) url=\(state.url ?? "") title=\(Self.short(title))")
        } else if msSinceLastMove < 1200 && stateCallbacks <= 2 {
            // The first couple of callbacks after each move, so a reparent-triggered reload would
            // show up as an `isLoading` flip instead of hiding inside the sample stream.
            log("STATE-POSTMOVE phase=\(phase) cyc=\(cycle) sinceMove=\(msSinceLastMove)ms loading=\(state.isLoading) url=\(state.url ?? "") title=\(Self.short(title))")
        }
    }

    private func sampleInt(_ index: Int) -> Int {
        guard lastSample.count > index else { return -1 }
        return Int(lastSample[index]) ?? -1
    }

    private func describeCEFSubview() -> String {
        guard let v = container.subviews.first else { return "none(subviews=\(container.subviews.count))" }
        return "\(type(of: v))\(NSStringFromRect(v.frame))"
    }

    private func finish() {
        log("END steps=\(stepIndex)/\(steps.count) lastSample=\(lastTitle)")
        log("QUIT terminating with the browser PARKED (live gate 7's shape)")
        delegate.reallyQuitting = true  // else `applicationShouldTerminate` answers `.terminateCancel`
        NSApp.terminate(nil)
    }

    // MARK: Harness plumbing

    private static var parkMode: String {
        ProcessInfo.processInfo.environment["NORMA_SPIKE_PARK_MODE"] ?? "never"
    }

    /// A scratch Chromium profile — never `~/.norma*`, never the bundle-id path the user's live dev
    /// app holds an exclusive lock on. See `startCEF` for why that lock is the whole reason.
    private static func cachePath() -> String {
        if let explicit = ProcessInfo.processInfo.environment["NORMA_SPIKE_CEF_CACHE"], !explicit.isEmpty {
            return explicit
        }
        return NSTemporaryDirectory() + "norma-spike-cef"
    }

    /// A three-line copy of `NormaCEFRuntime.helperExecutablePath()` — private there, and copying it
    /// is right for spike code that must not widen a production surface.
    private static func helperExecutablePath() -> String? {
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Frameworks/Norma Helper.app/Contents/MacOS", isDirectory: true)
            .appendingPathComponent("Norma Helper", isDirectory: false)
        return FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
    }

    private static func describe(_ responder: NSResponder?) -> String {
        guard let responder else { return "nil" }
        return String(describing: type(of: responder))
    }

    private static func short(_ s: String) -> String {
        s.count <= 90 ? s : String(s.prefix(90)) + "…"
    }

    // MARK: The instrumented page

    /// Written to a scratch directory and loaded over `file://`.
    ///
    /// **Why not the "real URL" the brief suggests, and why this is not the closed `data:` door.**
    /// The measurement needs a page that reports its own audio clock, rAF count, key count, DOM
    /// focus and viewport size — and this bridge's only channel out of a page is `document.title`
    /// (`NormaCEF.h` exposes no JS evaluation, and `javascript:` never enters a load path). No
    /// remote page can be instrumented that way. `file://` is a real scheme on the ordinary
    /// navigation path, needs no network, and is byte-reproducible for anyone re-running this
    /// harness. The `data:` restriction the brief cites is `PanelURLPolicy`'s, which is Swift-side
    /// panel policy and is not on this spike's path at all; the WAV below is a `data:` **subresource
    /// of** the page, never a top-frame navigation, which is a different thing again.
    private func writePage() -> String {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("norma-spike-page", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("spike.html")
        try? Self.pageHTML.write(to: file, atomically: true, encoding: .utf8)
        return file.absoluteString
    }

    private static let pageHTML = #"""
    <!doctype html><meta charset="utf-8"><title>SPIKE boot</title>
    <style>
      html,body{height:100%;margin:0;font:14px -apple-system,system-ui,sans-serif;background:#101014;color:#e6e6ea}
      body{display:flex;flex-direction:column;gap:10px;padding:16px;box-sizing:border-box}
      #start{font-size:20px;padding:14px 22px;background:#c33;color:#fff;border:0;border-radius:8px;cursor:pointer}
      input{font-size:18px;padding:8px;width:340px}
      canvas{background:#1c1c22;border-radius:6px}
      pre{margin:0;font:11px ui-monospace,Menlo,monospace;color:#8fd}
    </style>
    <body>
      <div><b>Norma reparent spike</b> — the page instruments itself and reports through document.title.</div>
      <button id="start" hidden>Click to start audio</button>
      <input id="field" placeholder="keystrokes land here" autofocus>
      <canvas id="c" width="360" height="70"></canvas>
      <pre id="out">booting…</pre>
    <script>
    (function(){
      var seq=0, raf=0, ticks=0, keys=0, lastKey='-', audioAccum=0, lastMediaTime=0, t0=performance.now();
      var field=document.getElementById('field'), out=document.getElementById('out');
      var cv=document.getElementById('c'), g=cv.getContext('2d');

      // A 1-second, 440 Hz, 8 kHz, 16-bit mono sine — exactly 440 whole cycles, so `loop` is
      // seamless and `currentTime` wrapping is the only discontinuity the sampler has to handle.
      function wav(){
        var rate=8000, n=rate, bytes=44+n*2, b=new ArrayBuffer(bytes), d=new DataView(b);
        function s(o,t){for(var i=0;i<t.length;i++)d.setUint8(o+i,t.charCodeAt(i));}
        s(0,'RIFF'); d.setUint32(4,bytes-8,true); s(8,'WAVE'); s(12,'fmt ');
        d.setUint32(16,16,true); d.setUint16(20,1,true); d.setUint16(22,1,true);
        d.setUint32(24,rate,true); d.setUint32(28,rate*2,true); d.setUint16(32,2,true); d.setUint16(34,16,true);
        s(36,'data'); d.setUint32(40,n*2,true);
        for(var i=0;i<n;i++){ d.setInt16(44+i*2, Math.round(Math.sin(2*Math.PI*440*i/rate)*0.30*32767), true); }
        var u=new Uint8Array(b), bin='';
        for(var j=0;j<u.length;j++) bin+=String.fromCharCode(u[j]);
        return 'data:audio/wav;base64,'+btoa(bin);
      }

      var audio=new Audio(); audio.loop=true; audio.volume=0.5; audio.src=wav();
      var ctx=null, osc=null;

      // TWO independent audio paths on purpose: a media element (what a real page uses, and the
      // thing "video keeps playing across a tab switch" actually means) and a Web Audio graph
      // (whose `currentTime` is the audio hardware clock, so it is the strictest continuity probe
      // there is). If the two ever disagree across a reparent, that disagreement is the finding.
      function startAudio(){
        var p = audio.play();
        try {
          ctx = new (window.AudioContext||window.webkitAudioContext)();
          osc = ctx.createOscillator(); var gain = ctx.createGain();
          osc.frequency.value = 660; gain.gain.value = 0.08;
          osc.connect(gain); gain.connect(ctx.destination); osc.start();
          ctx.resume();
        } catch(e) {}
        if (p && p.catch) p.catch(function(){ document.getElementById('start').hidden=false; });
      }
      document.getElementById('start').addEventListener('click', function(){
        this.hidden = true; startAudio();
      });

      function mediaDelta(){
        var t = audio.currentTime, d = t - lastMediaTime;
        if (d < 0) d += (audio.duration || 1);       // the loop wrapped
        lastMediaTime = t;
        return (d >= 0 && d < 5) ? d : 0;            // ignore a seek/garbage reading
      }

      function frame(){
        raf++;
        var x = (raf*3) % 360;
        g.fillStyle='#1c1c22'; g.fillRect(0,0,360,70);
        g.fillStyle='#4fd'; g.fillRect(x,10,40,50);
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);

      document.addEventListener('keydown', function(e){ keys++; lastKey=e.key; });

      function sample(){
        ticks++;
        audioAccum += mediaDelta();
        var wall = Math.round(performance.now()-t0);
        var ctxMs = ctx ? Math.round(ctx.currentTime*1000) : 0;
        var ae = (document.activeElement && document.activeElement.id) || '-';
        var payload = ['NS', ++seq, wall, Math.round(audioAccum*1000), ctxMs, raf, ticks, keys,
                       document.visibilityState.charAt(0), window.innerWidth, window.innerHeight,
                       audio.paused?1:0, ctx?ctx.state.charAt(0):'-', ae, field.value.length,
                       lastKey].join('|');
        document.title = payload;
        out.textContent = payload;
      }
      setInterval(sample, 250);
      startAudio();
      field.focus();
      sample();
    })();
    </script>
    """#
}
#endif
