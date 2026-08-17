#if DEBUG
import AppKit
import Foundation

/// editor-plumbing Task 5 — **the first execution of anything Tasks 1-4 built, and Stage A's exit
/// gate.**
///
/// Four tasks landed a vendored Monaco, a `norma-editor://` scheme registered in six processes, a
/// `cefQuery` message router, a typed codec and a whole host page — and not one line of the page had
/// ever run. Nothing in this repo can run it: the unit-test host IS `Norma.app` and
/// `NormaCEFRuntime` refuses to start Chromium under XCTest, deliberately. So the proof is a real
/// browser in a real window driving a scripted run, and this file is that run's effects.
///
/// **The sequencing and judging are NOT here** — they are `EditorHarnessScript`, pure and unit
/// tested, next door. What is here is everything that needs Chromium: the browser, the outbound
/// sends, the CDP door, the files, the screenshots, and the bridge handler.
///
/// ## Three constraints this file exists under
///
/// **1. It is harness-owned, never `BrowserRuntime`'s.** The creation sequence is the same one
/// `BrowserRuntime.create` performs — `ensureInitialized`, a `PanelCEFContainerView` with a non-zero
/// frame, `NormaCEFCreateBrowser` — but the browser is never registered with the runtime, never
/// given a tabId, and never seen by `BrowserSignals`. A harness browser folded into the lifecycle
/// engine would be planned over, parked, closed and re-created underneath the drill.
///
/// **2. It MUST discriminate by `browserId`, and refuse rather than ignore.** `NormaCEF.h:335-349`
/// states the exposure: the renderer-side router installs `window.cefQuery` into EVERY V8 context in
/// every Norma browser, so an arbitrary site in a panel web tab reaches this handler. A query from
/// any other browser is answered `success = false`; ignoring it would strand a CEF `Callback` for
/// the life of that browser, which the router's own contract calls a runtime error. Drill 11
/// executes exactly that, against a second browser this harness creates for the purpose.
///
/// **3. A pull can legitimately go unanswered, so every wait has a deadline.** `editor.js`'s
/// `pullContent` answers NOTHING for a path it does not hold (a fabricated empty `contentResponse`
/// would make Swift truncate a real file), and `model.getValue()` throws on a model past Monaco's
/// heap ceiling — the same silence from a different cause. Every step here is armed with a timeout
/// before its action runs, and a timeout is an ordinary event the script judges.
/// What one asynchronous harness step came back with. Deliberately not `Result`: every failure on
/// this path is a SENTENCE for the transcript rather than a type anyone dispatches on — a CDP
/// refusal, a JavaScript exception and a shape that did not parse are all "here is what went wrong,
/// in words", and `Result` would require inventing an `Error` type whose only member is that string.
enum HarnessAnswer<Value> {
    case ok(Value)
    case bad(String)

    var value: Value? {
        if case .ok(let value) = self { return value }
        return nil
    }
}

enum EditorBridgeHarness {
    /// The launch gate. Read once, before anything else happens — the same shape `SpikeReparent` and
    /// `SpikeCloseLeak` use, and for the same reason: the harness takes the launch over INSTEAD of
    /// `boot()`, because `boot()` performs account-global side effects (helper registration, the
    /// login item, the updater, the hotkey, a second orb) that a throwaway bundle in a scratch
    /// `derivedDataPath` must never point at the user's account.
    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["NORMA_EDITOR_HARNESS"] == "1"
    }

    /// Take the launch over and run the drill unattended, terminating when the transcript is
    /// written. This is the gate path.
    @MainActor
    static func start(delegate: AppDelegate) {
        run(delegate: delegate, quitWhenDone: true)
    }

    /// Open the harness from the menu inside an ordinary app run: same drill, same transcript, but
    /// the app keeps running afterwards and the window stays up to read. Idempotent — a second
    /// invocation raises the window a run already owns rather than creating a second browser.
    @MainActor
    static func open(delegate: AppDelegate) {
        if let existing = EditorBridgeHarnessRun.shared {
            existing.raise()
            return
        }
        run(delegate: delegate, quitWhenDone: false)
    }

    @MainActor
    private static func run(delegate: AppDelegate, quitWhenDone: Bool) {
        let harness = EditorBridgeHarnessRun(delegate: delegate, quitWhenDone: quitWhenDone)
        EditorBridgeHarnessRun.shared = harness
        harness.begin()
    }
}

// MARK: - The run

@MainActor
final class EditorBridgeHarnessRun: NSObject, NSWindowDelegate {
    static var shared: EditorBridgeHarnessRun?

    /// `norma-editor://app/editor.html` — the shell host, with Monaco on the sibling `assets` host.
    ///
    /// **editor-product T3: written once in `EditorRuntime`, and read here.** It used to live here
    /// because the harness was the only thing that ever created an editor browser; the product now
    /// creates one per session, and two places writing this string is two places for the scheme's URL
    /// shape to drift from the one the asset root serves.
    static let pageURL = EditorRuntime.pageURL

    private unowned let delegate: AppDelegate
    private let quitWhenDone: Bool
    private let startedAt = Date()

    private let window: NSWindow
    private let readout = NSTextView()
    private let editorContainer = PanelCEFContainerView()

    /// Drill 11's foreign page — an ordinary browser that is NOT the editor, in its own window, whose
    /// `window.cefQuery` this harness must refuse. **Deliberately never registered with the hub**:
    /// the refusal drill 11 judges is now the hub's own unknown-browser path, exercised for real.
    private var foreignWindow: NSWindow?
    private let foreignContainer = PanelCEFContainerView()

    /// editor-product T3: the editor browser's id, learned after creation and the key this run's hub
    /// registration lives under. 0 until CEF has a browser — which is why registration cannot happen
    /// at setup time (`registerWithHub`).
    private var editorBrowserId: Int32 = 0

    // MARK: Run state

    private var script: EditorHarnessScript
    private var stepStartedAt = Date()
    private var timeoutWork: DispatchWorkItem?
    private var runWatchdog: DispatchWorkItem?
    private var finished = false

    private let scratch: URL
    private let fixtures: EditorHarnessFixtures

    /// Every step's outcome, in order, for the transcript.
    private var stepRecords: [[String: Any]] = []
    /// Every bridge message that arrived, decoded or not.
    private var bridgeLog: [[String: Any]] = []
    /// Every query this handler refused, with the browser it came from.
    private var refusals: [[String: Any]] = []
    private var artifacts: [String: String] = [:]
    private var notes: [String] = []
    /// How many console entries have already been reported, so each check reads only what is new.
    private var consoleCursor = 0
    /// Filled by drill 1 — how long the page took from `NormaCEFCreateBrowser` to `ready`.
    private var readyElapsedMs: Int?
    private var browserCreatedAt: Date?
    /// The text `contentResponse` last handed over, kept as the bytes drill 5 writes to disk.
    private var lastPulledText: String?

    init(delegate: AppDelegate, quitWhenDone: Bool) {
        self.delegate = delegate
        self.quitWhenDone = quitWhenDone
        let root = ProcessInfo.processInfo.environment["NORMA_EDITOR_HARNESS_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true)
        } ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("norma-editor-harness", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        scratch = root
        fixtures = EditorHarnessFixtures(scratch: root)
        script = EditorHarnessScript(steps: EditorHarnessFixtures.steps(fixtures))

        window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 1240, height: 900),
                          styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma editor bridge harness"
        super.init()
        window.delegate = self
        buildWindow()
    }

    // MARK: Window

    private func buildWindow() {
        guard let content = window.contentView else { return }
        let readoutHeight: CGFloat = 300

        editorContainer.frame = NSRect(x: 0, y: readoutHeight, width: content.bounds.width,
                                       height: content.bounds.height - readoutHeight)
        editorContainer.autoresizingMask = [.width, .height]
        content.addSubview(editorContainer)

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: content.bounds.width,
                                                height: readoutHeight))
        scroll.autoresizingMask = [.width]
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        readout.isEditable = false
        readout.isRichText = false
        // A NAMED ROLE, not a constructed font — `TypographyTests.testNoFontIsConstructedOutsideThe
        // TokenFiles` sweeps every app source including this one, and it caught the first draft's
        // `NSFont.monospacedSystemFont(ofSize: 11)`. `syntaxCodeNS` is the app's mono code face,
        // which is what a ✓/✗ ledger of protocol frames is.
        readout.font = Typography.syntaxCodeNS
        readout.autoresizingMask = [.width]
        readout.minSize = NSSize(width: 0, height: 0)
        readout.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        readout.isVerticallyResizable = true
        readout.textContainer?.widthTracksTextView = true
        scroll.documentView = readout
        content.addSubview(scroll)
    }

    func raise() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing the harness window tears its browsers down and gives the bridge registration back —
    /// leaving a client registered against a deallocated run would answer nothing and strand every
    /// query it was handed.
    func windowWillClose(_ notification: Notification) {
        guard (notification.object as? NSWindow) === window else { return }
        teardownCEF()
        EditorBridgeHarnessRun.shared = nil
    }

    private func teardownCEF() {
        // editor-product T3: the hub owns the process slot now, so this gives back a REGISTRATION
        // rather than clearing the slot itself — which is what lets a runtime coexist with this run.
        EditorBridgeHub.shared.unregister(browserId: editorBrowserId)
        EditorBridgeHub.shared.onRefusal = nil
        NormaCEFCloseBrowser(editorContainer)
        NormaCEFCloseBrowser(foreignContainer)
    }

    // MARK: Ledger

    private func log(_ line: String) {
        let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
        fputs("EDITORHARNESS \(ms) \(line)\n", stderr)
        fflush(stderr)
        readout.string += "\(String(format: "%6d", ms))  \(line)\n"
        readout.scrollToEndOfDocument(nil)
    }

    // MARK: Boot

    func begin() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Which binary is running and when it was built. The stale-`derivedDataPath` trap is a named
        // prior failure in this repo (a five-day-old binary re-tested for a whole live gate), and one
        // line makes freshness a fact in the transcript rather than an assumption about the shell.
        let exe = Bundle.main.executableURL?.path ?? "?"
        let built = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)
            .flatMap { $0 }
        log("BEGIN pid=\(ProcessInfo.processInfo.processIdentifier) "
            + "bundle=\(Bundle.main.bundleIdentifier ?? "?")")
        log("BINARY \(exe)")
        log("BUILT  \(built.map { ISO8601DateFormatter().string(from: $0) } ?? "?")")
        log("SCRATCH \(scratch.path)")

        // The whole run has a ceiling. Anything that wedges past it still produces a transcript —
        // a harness whose failure mode is "no output at all" would waste the build cycle it cost.
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.notes.append("the run watchdog fired — the transcript below is what had been "
                              + "measured when it did")
            self.log("WATCHDOG — forcing the transcript out")
            self.finish()
        }
        runWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 420, execute: watchdog)

        runNextStep()
    }

    // MARK: The engine

    /// **Arm first, then act** — and that order is the whole of why the engine has no event queue.
    /// Every bridge delivery and every CDP completion lands on the main queue, so a step whose
    /// expectation is registered before its action is dispatched cannot miss the message its own
    /// action provokes.
    private func runNextStep() {
        guard let step = script.current else { finish(); return }
        log("→ [\(step.id)] \(step.title)")
        stepStartedAt = Date()
        let work = DispatchWorkItem { [weak self] in self?.feed(.timeout) }
        timeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + step.timeout, execute: work)
        perform(step)
    }

    private func feed(_ event: EditorHarnessEvent) {
        guard !finished, let step = script.current else { return }
        let verdict = script.advance(event: event)
        guard verdict.isConclusive else { return }
        timeoutWork?.cancel()
        timeoutWork = nil
        record(step: step, verdict: verdict)
        runNextStep()
    }

    /// A `.local` answer carries the id of the step it was computed for. A CDP completion that
    /// arrives after its step already timed out would otherwise be judged against the NEXT step and
    /// fail it for something it did not do.
    private func local(_ stepId: String, _ ok: Bool, _ detail: String) {
        guard script.current?.id == stepId else {
            notes.append("a late local answer for \(stepId) arrived after that step had closed: \(detail)")
            return
        }
        feed(.local(ok: ok, detail: detail))
    }

    private func record(step: EditorHarnessStep, verdict: EditorHarnessVerdict) {
        let elapsed = Int(Date().timeIntervalSince(stepStartedAt) * 1000)
        let passed: Bool
        let evidence: String
        switch verdict {
        case .passed(let detail):
            passed = true
            evidence = detail
        case .failed(let reason):
            passed = false
            evidence = reason
        case .pending:
            passed = false
            evidence = "pending"
        }
        log("\(passed ? "✓" : "✗") [\(step.id)] \(evidence)  (\(elapsed) ms)")
        stepRecords.append([
            "id": step.id,
            "drill": step.drill,
            "title": step.title,
            "expected": step.expectation.describedForTranscript,
            "verdict": passed ? "pass" : "fail",
            "evidence": evidence,
            "elapsedMs": elapsed
        ])
    }

    // MARK: Finish

    private func finish() {
        guard !finished else { return }
        finished = true
        timeoutWork?.cancel()
        runWatchdog?.cancel()

        let transcriptURL = scratch.appendingPathComponent("transcript.json")
        let transcript = buildTranscript()
        if let data = try? JSONSerialization.data(withJSONObject: transcript,
                                                  options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? data.write(to: transcriptURL, options: .atomic)
            log("TRANSCRIPT \(transcriptURL.path) (\(data.count) bytes)")
        } else {
            log("TRANSCRIPT could not be serialised — see stderr above for every step")
        }
        log("RESULT \(script.passedCount) passed, \(script.failedCount) failed, "
            + "\(stepRecords.count) step(s)")

        guard quitWhenDone else {
            log("the harness window stays up — close it to release the browsers")
            return
        }
        teardownCEF()
        // The one true-quit gate, armed from outside the menu bar — the same deliberate bypass the
        // two CEF spikes document. Every other `NSApp.terminate` is answered `.terminateCancel`,
        // which for an unattended run means never ending and never shutting CEF down. Safe because
        // this file is `#if DEBUG` and unreachable without the env gate: the harness owns the whole
        // process (it ran INSTEAD of `boot()` — no daemon, no orb, no user window).
        delegate.reallyQuitting = true
        let timer = Timer(fire: Date().addingTimeInterval(1.0), interval: 0, repeats: false) { _ in
            NSApp.terminate(nil)
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    private func buildTranscript() -> [String: Any] {
        var byDrill: [Int: [[String: Any]]] = [:]
        for record in stepRecords {
            let drill = record["drill"] as? Int ?? 0
            byDrill[drill, default: []].append(record)
        }
        let drills: [[String: Any]] = byDrill.keys.sorted().map { drill in
            let steps = byDrill[drill] ?? []
            let green = steps.allSatisfy { ($0["verdict"] as? String) == "pass" }
            return [
                "drill": drill,
                "title": EditorHarnessFixtures.drillTitles[drill] ?? "",
                "verdict": green ? "pass" : "fail",
                "steps": steps.map { $0["id"] as? String ?? "" }
            ]
        }
        let exe = Bundle.main.executableURL?.path ?? "?"
        let built = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)
            .flatMap { $0 }
        return [
            "harness": "editor-bridge (editor-plumbing Task 5)",
            "startedAt": ISO8601DateFormatter().string(from: startedAt),
            "finishedAt": ISO8601DateFormatter().string(from: Date()),
            "binary": [
                "path": exe,
                "builtAt": built.map { ISO8601DateFormatter().string(from: $0) } ?? "?",
                "bundleId": Bundle.main.bundleIdentifier ?? "?",
                "pid": ProcessInfo.processInfo.processIdentifier
            ],
            "pageURL": Self.pageURL,
            "scratchDir": scratch.path,
            "summary": [
                "steps": stepRecords.count,
                "passed": script.passedCount,
                "failed": script.failedCount,
                "drills": drills.count,
                "drillsGreen": drills.filter { ($0["verdict"] as? String) == "pass" }.count,
                "readyElapsedMs": readyElapsedMs ?? -1
            ],
            "drills": drills,
            "steps": stepRecords,
            "bridgeMessages": bridgeLog,
            "refusedQueries": refusals,
            "strays": script.strays,
            "notes": notes,
            "artifacts": artifacts
        ]
    }

    // MARK: - The bridge, through the hub

    /// **editor-product T3: this run is a hub CLIENT now, not the slot's owner.**
    ///
    /// Stage A registered `NormaCEFSetBridgeHandler` directly — legal while the harness was the only
    /// thing in the process that ever wanted editor messages, and untenable the moment
    /// `EditorRuntime` exists: the slot is single and register-replaces-outright, so two direct
    /// registrants means last-writer-wins and the loser's page is answered `success = false` for the
    /// life of its browser. `EditorBridgeHub` owns the slot; everything else registers with it by
    /// `browserId` and it demuxes.
    ///
    /// **The registration therefore cannot happen in `0.setup` any more, and that is not a
    /// rearrangement — it is the ordering the hub's key forces.** A `browserId` does not exist until
    /// CEF's `OnAfterCreated` has run (`CreateBrowser` does not block, `NormaCEF.mm`), so this polls
    /// from the moment the browser is asked for. The window it leaves is measured, not hoped at: the
    /// page's `ready` cannot arrive before the page has been navigated to, which is after
    /// `OnAfterCreated`, and `ready` took 234 ms in the Stage-A run against a 25 ms poll.
    private func registerWithHub(attempt: Int) {
        let id = NormaCEFBrowserIdentifierForParent(editorContainer)
        guard id != 0 else {
            guard attempt < 400 else {
                notes.append("the editor browser never reported an id — every query it sends was "
                             + "refused by the hub, because nothing could be registered for it")
                log("the editor browser never reported an id — the bridge is UNREGISTERED")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) { [weak self] in
                self?.registerWithHub(attempt: attempt + 1)
            }
            return
        }
        editorBrowserId = id
        EditorBridgeHub.shared.register(browserId: id) { [weak self] message, respond in
            // Answer BEFORE acting on it. The page's promise settles either way, and feeding the
            // script can re-enter this file (a step's action sends the next message) — an entry
            // still awaiting an answer across that re-entry is one a later failure could strand.
            respond(true, "{}")
            self?.handleMessage(message, browserId: id)
        }
        log("registered browser \(id) with the bridge hub after \(attempt + 1) look(s)")
    }

    /// **Drill 11's evidence, now produced by the hub.** The refusal itself is the hub's — the
    /// harness never registers the foreign browser, so a query from it finds no client — and this
    /// records what was refused, which is what the drill judges.
    private func installRefusalObserver() {
        EditorBridgeHub.shared.onRefusal = { [weak self] refusal in
            guard let self else { return }
            self.refusals.append([
                "browserId": Int(refusal.browserId),
                "editorBrowserId": Int(self.editorBrowserId),
                "reason": refusal.reason.rawValue,
                "request": refusal.request,
                "answer": "success=false (refused by the hub — \(refusal.reason.rawValue))"
            ])
            self.log("REFUSED a cefQuery from browser \(refusal.browserId) "
                     + "(\(refusal.reason.rawValue); the editor is \(self.editorBrowserId))")
        }
    }

    private func handleMessage(_ message: EditorBridgeInbound, browserId: Int32) {
        var entry: [String: Any] = ["browserId": Int(browserId), "type": message.wireType,
                                    "decoded": true]
        switch message {
        case .ready:
            if let created = browserCreatedAt {
                readyElapsedMs = Int(Date().timeIntervalSince(created) * 1000)
                entry["readyElapsedMs"] = readyElapsedMs ?? -1
            }
        case .modelDirtyChanged(let path, let dirty):
            entry["path"] = path
            entry["dirty"] = dirty
        case .saveRequested(let path):
            entry["path"] = path
        case .contentResponse(let path, let seq, let text):
            entry["path"] = path
            entry["seq"] = Int(seq)
            entry["bytes"] = text.utf8.count
            lastPulledText = text
        }
        bridgeLog.append(entry)
        feed(.bridge(message))
    }

    // MARK: - CDP

    private func cdp(_ container: NSView, _ method: String, _ params: [String: Any] = [:],
                     _ done: @escaping (Bool, [String: Any]) -> Void) {
        NormaCEFExecuteCDP(container, method, Self.jsonString(params)) { ok, payload in
            done(ok, Self.jsonObject(payload) ?? [:])
        }
    }

    /// `Runtime.evaluate`, with the two failure modes CEF's door does not distinguish folded into
    /// one: a protocol-level refusal and a JavaScript exception both arrive as `.failure(reason)`.
    private func evaluate(_ container: NSView, _ expression: String, awaitPromise: Bool = false,
                          _ done: @escaping (HarnessAnswer<Any?>) -> Void) {
        cdp(container, "Runtime.evaluate", [
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": awaitPromise,
            "userGesture": true
        ]) { ok, payload in
            guard ok else {
                done(.bad((payload["message"] as? String) ?? "the CDP call failed"))
                return
            }
            if let exception = payload["exceptionDetails"] as? [String: Any] {
                let text = (exception["exception"] as? [String: Any])?["description"] as? String
                    ?? exception["text"] as? String ?? "a JavaScript exception"
                done(.bad(text))
                return
            }
            done(.ok((payload["result"] as? [String: Any])?["value"]))
        }
    }

    /// One outbound message, rendered by the codec and injected as the one call the page exposes.
    /// This is also the ONLY way Swift can speak to the page: the bridge is inbound-only by design.
    private func send(_ message: EditorBridgeOutbound, _ done: @escaping (String?) -> Void) {
        evaluate(editorContainer, message.javascript) { result in
            switch result {
            case .ok:
                done(nil)
            case .bad(let reason):
                done("\(message.wireType) could not be delivered: \(reason)")
            }
        }
    }

    /// Send, and let the SCRIPT judge what the page does next. A delivery failure fails the step at
    /// once rather than letting it sit until its timeout with nothing to say.
    private func sendAwaitingPage(_ stepId: String, _ message: EditorBridgeOutbound) {
        send(message) { [weak self] error in
            guard let self, let error else { return }
            self.local(stepId, false, error)
        }
    }

    private func readDebugState(_ done: @escaping (HarnessAnswer<[String: Any]>) -> Void) {
        evaluate(editorContainer, "window.normaEditorDebugState()") { result in
            switch result {
            case .bad(let reason):
                done(.bad("normaEditorDebugState() failed: \(reason)"))
            case .ok(let value):
                guard let object = value as? [String: Any] else {
                    done(.bad("normaEditorDebugState() did not answer an object"))
                    return
                }
                done(.ok(object))
            }
        }
    }

    /// Everything `console.error`/`console.warn`/a CSP violation has said since the last read.
    private func readConsole(_ done: @escaping ([String]) -> Void) {
        evaluate(editorContainer,
                 "window.__normaHarness ? window.__normaHarness.log.slice(\(consoleCursor)) : []") { result in
            guard case .ok(let value) = result, let lines = value as? [Any] else {
                done([])
                return
            }
            self.consoleCursor += lines.count
            done(lines.map { "\($0)" })
        }
    }

    private func describe(_ state: [String: Any]) -> String {
        let paths = (state["paths"] as? [Any])?.map { "\($0)" } ?? []
        let current = state["current"].map { "\($0)" } ?? "null"
        let dirty = (state["dirtyMap"] as? [String: Any])?
            .map { "\(($0.key as NSString).lastPathComponent)=\($0.value)" }.sorted()
            .joined(separator: ",") ?? ""
        return "paths=[\(paths.map { ($0 as NSString).lastPathComponent }.joined(separator: ","))] "
            + "current=\((current as NSString).lastPathComponent) dirty{\(dirty)}"
    }

    // MARK: - JSON plumbing

    private static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object,
                                                     options: [.withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private static func jsonObject(_ text: String?) -> [String: Any]? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - The actions

    // swiftlint:disable:next cyclomatic_complexity
    private func perform(_ step: EditorHarnessStep) {
        switch step.id {

        // ---- setup ---------------------------------------------------------------------------
        case "0.setup":
            performSetup(step.id)

        // ---- drill 1: offline boot ------------------------------------------------------------
        case "1.boot":
            browserCreatedAt = Date()
            // editor-product T4: DEBUG-harness passes the same background the product runtime does
            // — the scheme active AT CREATION, so this drill exercises the exact call shape a real
            // session's `EditorRuntime` makes rather than a hardcoded "no override" placeholder.
            NormaCEFCreateBrowser(editorContainer, Self.pageURL,
                                 EditorTheme.cardSurfaceBackgroundARGB(for: EditorRuntime.currentColorScheme()))
            // editor-product T3: the hub's key is the browser's id, which does not exist until CEF
            // says so — armed here, immediately after the create, so the registration is in place
            // long before the page can send its `ready` (see `registerWithHub`).
            registerWithHub(attempt: 0)

        // editor-product T4: the SAME theme a real `EditorRuntime` sends the instant `ready`
        // arrives — see `EditorRuntimeReducer`'s `.pageReady` case. Sent here too so drill 10's
        // `10.before` screenshot reflects a session that is actually branded by the time it runs,
        // not Monaco's own unbranded "vs" default (which `editor.create()` applies eagerly, well
        // before this step, independent of anything the browser's OWN background paints).
        case "1.brand":
            performBrandTheme(step.id)

        case "1.bound":
            guard let elapsed = readyElapsedMs else {
                local(step.id, false, "no ready timing was recorded")
                return
            }
            local(step.id, elapsed <= 5000,
                  "the page booted in \(elapsed) ms (the drill's bound is 5000 ms)")

        case "1.origin":
            evaluate(editorContainer, "location.protocol + \" \" + location.href") { [weak self] result in
                guard let self else { return }
                switch result {
                case .bad(let reason):
                    self.local(step.id, false, reason)
                case .ok(let value):
                    let text = "\(value ?? "")"
                    let ok = text.hasPrefix("norma-editor: ") && text.hasSuffix(Self.pageURL)
                    self.local(step.id, ok, "location = \(text)")
                }
            }

        case "1.offline":
            performOfflineProof(step.id)

        case "1.hook":
            performInstallHook(step.id)

        // ---- drill 2: openModel A (.ts) -------------------------------------------------------
        case "2.open":
            send(.openModel(path: fixtures.pathA, language: "typescript", text: fixtures.fixtureA)) {
                [weak self] error in
                guard let self else { return }
                if let error { self.local(step.id, false, error); return }
                self.readDebugState { result in
                    switch result {
                    case .bad(let reason):
                        self.local(step.id, false, reason)
                    case .ok(let state):
                        let paths = (state["paths"] as? [Any])?.map { "\($0)" } ?? []
                        let dirty = (state["dirtyMap"] as? [String: Any])?[self.fixtures.pathA] as? Bool
                        let ok = paths == [self.fixtures.pathA]
                            && "\(state["current"] ?? "")" == self.fixtures.pathA && dirty == false
                        self.local(step.id, ok, self.describe(state))
                    }
                }
            }

        case "2.worker":
            performTypeScriptWorkerProof(step.id)

        case "2.console":
            readConsole { [weak self] lines in
                guard let self else { return }
                self.local(step.id, lines.isEmpty,
                           lines.isEmpty
                           ? "the page logged nothing after boot and open"
                           : "the page logged: \(lines.joined(separator: " | "))")
            }

        // ---- drill 3: a keystroke turns the model dirty ----------------------------------------
        case "3.focus":
            performFocus(step.id)

        case "3.type":
            insertText("x") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        // ---- drill 4: the byte-identical round trip --------------------------------------------
        case "4.pull":
            sendAwaitingPage(step.id, .pullContent(path: fixtures.pathA, seq: 1))

        // ---- drill 5: the save loop --------------------------------------------------------------
        case "5.write":
            performWritePulledText(step.id)

        case "5.ack":
            sendAwaitingPage(step.id, .markSaved(path: fixtures.pathA, seq: 1))

        case "5.undo":
            trigger("undo") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        case "5.undone":
            // The proof `markSaved` touched no undo history: the pre-save edit really came back out.
            // (editor-product Task 9 note: this step's claim is about `markSaved` alone. It used to
            // read as a contrast with `applyExternalContent`, whose `setValue` cleared the command
            // manager — that is no longer true of it, since T9 made it a full-range
            // `pushEditOperations` edit precisely so an agent's reload stays undoable. What still
            // makes `applyExternalContent` wrong as an acknowledgement is that it replaces the
            // buffer at all.)
            currentValue { [weak self] result in
                guard let self else { return }
                switch result {
                case .bad(let reason):
                    self.local(step.id, false, reason)
                case .ok(let text):
                    let expected = MonacoTextBuffer.savedText(forFileOpenedWith: self.fixtures.fixtureA)
                    if let difference = EditorHarnessScript.firstByteDifference(expected: expected,
                                                                               actual: text) {
                        self.local(step.id, false, "the undo did not restore the pre-edit text: \(difference)")
                    } else {
                        self.local(step.id, true,
                                   "the pre-save edit undid cleanly — \(text.utf8.count) byte(s), "
                                   + "identical to the fixture")
                    }
                }
            }

        case "5.redo":
            trigger("redo") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        // ---- drill 6: the race the anchor closes -------------------------------------------------
        case "6.typeY":
            insertText("y") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        case "6.pull2":
            sendAwaitingPage(step.id, .pullContent(path: fixtures.pathA, seq: 2))

        case "6.typeZ":
            insertText("z") { _ in }

        case "6.ackRace":
            send(.markSaved(path: fixtures.pathA, seq: 2)) { _ in }

        case "6.stillDirty":
            // **The buffer is read as well as the flag, and that is not belt-and-braces.** A
            // `.silence` step cannot tell "silent because the model was already dirty" from "silent
            // because the keystroke never landed" — and if "z" never arrived, `markSaved` would find
            // the buffer exactly AT the pulled version and clear it legitimately, which looks
            // identical to the race bug from the outside. Asserting the prefix turns that ambiguity
            // into evidence in whichever direction it falls.
            readDebugState { [weak self] result in
                guard let self else { return }
                switch result {
                case .bad(let reason):
                    self.local(step.id, false, reason)
                case .ok(let state):
                    let dirty = (state["dirtyMap"] as? [String: Any])?[self.fixtures.pathA] as? Bool
                    self.currentValue { value in
                        let text = value.value ?? ""
                        let typed = text.hasPrefix("zyx")
                        let reading = typed
                            ? "both keystrokes landed"
                            : "THE KEYSTROKE NEVER LANDED — the silence above proves nothing"
                        self.local(step.id, dirty == true && typed,
                                   "after the acknowledgement the page still reports dirty = "
                                   + "\(dirty.map(String.init) ?? "?"); the buffer begins "
                                   + String(text.prefix(4)) + " (" + reading + ") — "
                                   + self.describe(state))
                    }
                }
            }

        case "6.undoZ":
            trigger("undo") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        case "6.undoneZ":
            // **The anchor's claim, read off the buffer rather than inferred from the flag.** "Clean"
            // arriving is only the right answer if the buffer is back at the version pull 2 handed
            // over — an undo that overshot would ALSO change the flag, in the other direction, and
            // that is exactly how run 1 failed. Recording the bytes makes the two distinguishable in
            // the transcript whichever way the step falls.
            currentValue { [weak self] result in
                guard let self else { return }
                switch result {
                case .bad(let reason):
                    self.local(step.id, false, reason)
                case .ok(let text):
                    let expected = "yx" + MonacoTextBuffer.savedText(forFileOpenedWith: self.fixtures.fixtureA)
                    if let difference = EditorHarnessScript.firstByteDifference(expected: expected,
                                                                               actual: text) {
                        self.local(step.id, false,
                                   "the undo did not land on the version pull 2 answered with: "
                                   + difference)
                    } else {
                        self.local(step.id, true,
                                   "the buffer is back at pull 2's exact text — \(text.utf8.count) "
                                   + "byte(s), so the saved point really was that pull's version")
                    }
                }
            }

        case "6.stale":
            performNegativeAck(step.id, seq: 1)

        // ---- drill 7: an external write ----------------------------------------------------------
        case "7.typeW":
            insertText("w") { [weak self] error in
                guard let self, let error else { return }
                self.local(step.id, false, error)
            }

        case "7.apply":
            sendAwaitingPage(step.id, .applyExternalContent(path: fixtures.pathA,
                                                            text: fixtures.fixtureB))

        case "7.ackAfterExternal":
            performNegativeAck(step.id, seq: 2)

        case "7.pull3":
            sendAwaitingPage(step.id, .pullContent(path: fixtures.pathA, seq: 3))

        // ---- drill 8: ⌘S ---------------------------------------------------------------------
        case "8.save":
            performCommandS(step.id)

        // ---- drill 9: a second model, and the close/activate obligation --------------------------
        case "9.setView":
            performSetView(step.id)

        case "9.openC":
            send(.openModel(path: fixtures.pathC, language: "", text: fixtures.fixtureC)) {
                [weak self] error in
                guard let self else { return }
                if let error { self.local(step.id, false, error); return }
                self.readDebugState { result in
                    switch result {
                    case .bad(let reason):
                        self.local(step.id, false, reason)
                    case .ok(let state):
                        let paths = (state["paths"] as? [Any])?.map { "\($0)" } ?? []
                        let ok = paths == [self.fixtures.pathA, self.fixtures.pathC]
                            && "\(state["current"] ?? "")" == self.fixtures.pathC
                        self.local(step.id, ok, self.describe(state))
                    }
                }
            }

        case "9.jsonWorker":
            performJSONWorkerProof(step.id, attempt: 0)

        case "9.activateA":
            performActivate(step.id, path: fixtures.pathA)

        case "9.viewState":
            performViewStateCheck(step.id)

        case "9.closeActive":
            // Closing the ACTIVE model leaves the editor holding nothing — the page detaches before
            // it disposes, deliberately, and it is SWIFT's obligation to activate something next.
            // That obligation is exercised by the step after this one.
            send(.closeModel(path: fixtures.pathA)) { [weak self] error in
                guard let self else { return }
                if let error { self.local(step.id, false, error); return }
                self.readDebugState { result in
                    switch result {
                    case .bad(let reason):
                        self.local(step.id, false, reason)
                    case .ok(let state):
                        let paths = (state["paths"] as? [Any])?.map { "\($0)" } ?? []
                        let current = state["current"]
                        let isNull = current == nil || current is NSNull
                        self.local(step.id, paths == [self.fixtures.pathC] && isNull,
                                   "closing the active model left \(self.describe(state)) — the "
                                   + "editor now shows nothing until Swift activates something")
                    }
                }
            }

        case "9.activateC":
            performActivate(step.id, path: fixtures.pathC)

        // ---- drill 10: the theme ---------------------------------------------------------------
        case "10.before":
            performScreenshot(step.id, name: "theme-before.png")

        case "10.theme":
            performTheme(step.id)

        case "10.after":
            performScreenshot(step.id, name: "theme-after.png")

        // ---- drill 11: a foreign page's query is refused ------------------------------------------
        case "11.foreign":
            performCreateForeign(step.id, attempt: 0)

        case "11.refused":
            performForeignQuery(step.id)

        case "11.unaffected":
            sendAwaitingPage(step.id, .pullContent(path: fixtures.pathC, seq: 4))

        default:
            local(step.id, false, "the harness has no action for this step")
        }
    }

    // MARK: - The longer actions

    private func performSetup(_ stepId: String) {
        var lines: [String] = []
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("EditorAssets",
                                                                             isDirectory: true),
              FileManager.default.fileExists(atPath: resources.appendingPathComponent("app/editor.html").path),
              FileManager.default.fileExists(atPath: resources.appendingPathComponent("vs/loader.js").path) else {
            local(stepId, false, "the bundle has no EditorAssets/app/editor.html + vs/loader.js — "
                  + "this build never ran the embed phase")
            return
        }
        // FIRST, and before any browser exists: until this runs the scheme handler answers 404 to
        // everything, which is the fail-closed default rather than "the working directory".
        NormaCEFRegisterEditorAssetRoot(resources.path)
        lines.append("asset root = \(resources.path)")

        // editor-product T3: the hub owns the slot, and a registration is keyed on a browser id
        // that does not exist yet — so what happens HERE is only the refusal observer; the
        // registration itself is armed by `1.boot`, right after the create (`registerWithHub`).
        installRefusalObserver()
        lines.append("the bridge hub's refusal observer is installed; this run registers with the "
                     + "hub the moment its browser has an id")

        do {
            try fixtures.writeToDisk()
            lines.append("fixtures written to \(scratch.path)")
        } catch {
            local(stepId, false, "the fixtures could not be written: \(error)")
            return
        }

        guard NormaCEFRuntime.ensureInitialized() else {
            local(stepId, false, "CEF did not start: \(NormaCEFRuntime.state)")
            return
        }
        lines.append("CEF is up")
        local(stepId, true, lines.joined(separator: "; "))
    }

    /// **The offline claim, made positively.**
    ///
    /// The first shape of this step asked `performance.getEntriesByType("resource")` and got an
    /// EMPTY array from a page that had just loaded four megabytes of Monaco — measured, run 1. That
    /// is a real property of the embed rather than a bug: Chromium does not populate Resource Timing
    /// for a scheme registered through CEF's custom-scheme door, so the API that names every fetch
    /// names none of them here. An absent timeline is not evidence of an offline page; it is the
    /// absence of evidence, and the step said so and failed rather than passing on it.
    ///
    /// What is observable instead is stronger than a list of URLs, because it is a CONSEQUENCE:
    ///
    ///   * every subresource the document declares, resolved to its absolute URL, is on the scheme;
    ///   * **Monaco is up** — and under `default-src 'none'` with `script-src norma-editor:` there
    ///     is no other origin its loader could have taken a single module from. A page that had
    ///     reached out to a CDN would not be running; it would be a CSP violation and a dead editor.
    private func performOfflineProof(_ stepId: String) {
        let script = """
        (function () {
          var declared = [];
          Array.prototype.forEach.call(document.querySelectorAll("script[src], link[href]"),
            function (element) { declared.push(element.src || element.href); });
          var timed = performance.getEntriesByType("resource").map(function (e) { return e.name; });
          var onScheme = function (url) {
            return url.indexOf("norma-editor:") === 0 || url.indexOf("blob:") === 0
              || url.indexOf("data:") === 0;
          };
          return JSON.stringify({
            declared: declared,
            timed: timed,
            monacoUp: typeof window.monaco === "object"
              && typeof window.monaco.editor.create === "function",
            offScheme: declared.concat(timed).filter(function (u) { return !onScheme(u); })
          });
        })()
        """
        evaluate(editorContainer, script) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, reason)
            case .ok(let value):
                guard let text = value as? String,
                      let report = Self.jsonObject(text) else {
                    self.local(stepId, false, "the offline probe did not answer")
                    return
                }
                let declared = (report["declared"] as? [Any])?.map { "\($0)" } ?? []
                let timed = (report["timed"] as? [Any])?.map { "\($0)" } ?? []
                let offScheme = (report["offScheme"] as? [Any])?.map { "\($0)" } ?? []
                let monacoUp = report["monacoUp"] as? Bool ?? false
                self.notes.append("declared subresources: " + declared.joined(separator: ", "))
                if timed.isEmpty {
                    self.notes.append("Resource Timing is EMPTY for norma-editor: — Chromium does "
                                      + "not populate it for a CEF custom scheme, so the offline "
                                      + "claim rests on the declared URLs and on Monaco being up "
                                      + "under a CSP that allows no other origin")
                }
                self.local(stepId, monacoUp && offScheme.isEmpty && declared.count >= 2,
                           "\(declared.count) declared subresource(s), \(timed.count) timed; Monaco "
                           + "is \(monacoUp ? "up" : "NOT up"); off-scheme: "
                           + (offScheme.isEmpty ? "none" : offScheme.joined(separator: ", ")))
            }
        }
    }

    private func performInstallHook(_ stepId: String) {
        // Installed as early as the harness can reach the page — which is after `ready`, because the
        // CDP door is request/response and has no event channel to subscribe `Runtime.consoleAPICalled`
        // on. What it therefore CANNOT see is anything logged during Monaco's own boot; drill 1's
        // resource list and drill 2's worker round trip are the positive proofs that cover that
        // window instead. `console.warn` is wrapped as well as `console.error` because the two
        // fail-closed acknowledgements in drills 6 and 7 have no other observable at all: the page
        // warns and changes nothing, and "changed nothing" is trivially satisfied by a page that
        // never received the message.
        let script = """
        (function () {
          if (window.__normaHarness) { return "already installed"; }
          var log = [];
          window.__normaHarness = { log: log };
          ["error", "warn"].forEach(function (level) {
            var original = console[level].bind(console);
            console[level] = function () {
              try {
                log.push(level + ": " + Array.prototype.map.call(arguments, function (a) {
                  try {
                    if (typeof a === "string") { return a; }
                    if (a && a.message) { return String(a.message); }
                    return JSON.stringify(a);
                  } catch (e) { return String(a); }
                }).join(" "));
              } catch (e) {}
              original.apply(console, arguments);
            };
          });
          window.addEventListener("securitypolicyviolation", function (e) {
            log.push("csp: " + e.violatedDirective + " blocked " + e.blockedURI);
          });
          return "installed; normaEditorDebugState is "
            + (typeof window.normaEditorDebugState === "function" ? "a function" : "MISSING");
        })()
        """
        evaluate(editorContainer, script) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, reason)
            case .ok(let value):
                let text = "\(value ?? "")"
                // Best-effort: it keeps Blink treating the page as focused, so a keyboard drill does
                // not depend on which window the machine running the harness happens to have key.
                self.cdp(self.editorContainer, "Emulation.setFocusEmulationEnabled",
                         ["enabled": true]) { ok, _ in
                    self.local(stepId, !text.contains("MISSING"),
                               "\(text); focus emulation \(ok ? "on" : "unavailable")")
                }
            }
        }
    }

    /// **The riskiest path in the whole page, executed on purpose.** Monaco's language workers are
    /// created from a `blob:` bootstrap whose nested `vs/` modules are FETCHED, cross-origin, from
    /// the `assets` host — so this one round trip exercises the scheme's `CORS_ENABLED |
    /// FETCH_ENABLED` flags, the handler's `Access-Control-Allow-Origin`, the CSP's `connect-src`
    /// and `worker-src`, and the loader's `baseUrl` rule, none of which had ever run. A `.txt`
    /// fixture would have left all of it unexecuted while every other drill went green.
    private func performTypeScriptWorkerProof(_ stepId: String) {
        let script = """
        monaco.languages.typescript.getTypeScriptWorker()
          .then(function (factory) {
            var model = monaco.editor.getModels()[0];
            return factory(model.uri).then(function (worker) {
              return worker.getSemanticDiagnostics(model.uri.toString());
            });
          })
          .then(function (diagnostics) { return "worker answered with " + diagnostics.length + " diagnostic(s)"; })
          .catch(function (error) { return "WORKER FAILED: " + (error && error.message ? error.message : error); })
        """
        evaluate(editorContainer, script, awaitPromise: true) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, "the TypeScript worker never answered: \(reason) — this is "
                           + "the recorded open question resolving NO; the fallback is to serve the "
                           + "shell from norma-editor://assets/app/editor.html (single origin)")
            case .ok(let value):
                let text = "\(value ?? "")"
                self.local(stepId, !text.hasPrefix("WORKER FAILED"), text)
            }
        }
    }

    private func performJSONWorkerProof(_ stepId: String, attempt: Int) {
        // The JSON worker is the second language worker, and it reports through markers rather than
        // a callable API. Fixture C is deliberately malformed, so a marker arriving at all is the
        // worker having booted, fetched its own nested modules and answered.
        let script = """
        (function () {
          var model = monaco.editor.getModels().filter(function (m) {
            return m.uri.path.slice(-5) === ".json";
          })[0];
          if (!model) { return "no json model"; }
          var markers = monaco.editor.getModelMarkers({ resource: model.uri });
          return markers.length + " marker(s): "
            + markers.map(function (m) { return m.owner + " " + m.message; }).join(" | ");
        })()
        """
        evaluate(editorContainer, script) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, reason)
            case .ok(let value):
                let text = "\(value ?? "")"
                if text.hasPrefix("0 marker") || text == "no json model" {
                    guard attempt < 20 else {
                        self.local(stepId, false, "the JSON worker never produced a marker for a "
                                   + "deliberately malformed file: \(text)")
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.performJSONWorkerProof(stepId, attempt: attempt + 1)
                    }
                    return
                }
                self.local(stepId, true, text)
            }
        }
    }

    private func performFocus(_ stepId: String) {
        // `DOM.focus` over the protocol rather than a JavaScript `el.focus()` — the same discipline
        // `PanelCommandConsumer` follows, and the same reason: focusing over the protocol cannot be
        // redirected by page script. The editor's own `focus()` follows it because Monaco tracks
        // focus itself, and the caret is put at 1,1 so every insertion in this run lands at a known
        // offset and the expected bytes are a concatenation rather than a guess.
        cdp(editorContainer, "DOM.getDocument", ["depth": 0]) { [weak self] ok, payload in
            guard let self else { return }
            guard ok, let nodeId = (payload["root"] as? [String: Any])?["nodeId"] as? Int else {
                self.local(stepId, false, "DOM.getDocument did not answer a root node")
                return
            }
            self.cdp(self.editorContainer, "DOM.querySelector",
                     ["nodeId": nodeId, "selector": "textarea.inputarea"]) { ok, payload in
                guard ok, let textarea = payload["nodeId"] as? Int, textarea != 0 else {
                    self.local(stepId, false, "Monaco's hidden input (textarea.inputarea) was not in "
                               + "the document — the editor did not render")
                    return
                }
                self.cdp(self.editorContainer, "DOM.focus", ["nodeId": textarea]) { _, _ in
                    self.evaluate(self.editorContainer, """
                    (function () {
                      var editor = monaco.editor.getEditors()[0];
                      editor.focus();
                      editor.setPosition({ lineNumber: 1, column: 1 });
                      return (document.activeElement ? document.activeElement.className : "<none>")
                        + " / hasFocus=" + document.hasFocus();
                    })()
                    """) { result in
                        switch result {
                        case .bad(let reason):
                            self.local(stepId, false, reason)
                        case .ok(let value):
                            let text = "\(value ?? "")"
                            self.local(stepId, text.contains("inputarea"),
                                       "activeElement = \(text)")
                        }
                    }
                }
            }
        }
    }

    /// Put the caret back at 1,1, seal the previous edit as its own undo unit, and commit one
    /// character the way an IME does.
    ///
    /// The caret reset is what makes each expected value a plain concatenation: undo and redo move
    /// the cursor to the edit they replay, so an insertion that trusted "wherever it is" would be
    /// unpredictable.
    ///
    /// **`pushUndoStop` is not decoration — run 1 failed without it.** Monaco coalesces consecutive
    /// typing into one undo element, and a programmatic `setPosition` does not break the run. Two
    /// `Input.insertText` calls milliseconds apart therefore undid TOGETHER, so drill 6's "undo the
    /// extra keystroke" overshot the version the pull had answered with and the model stayed dirty —
    /// which is the CORRECT answer to the question the buffer was actually asking, and the wrong
    /// question. The two keystrokes the race models are separated by a save: a user types, Swift
    /// pulls and writes, the user types again. This is that separation, made explicit, because a
    /// synthesised burst has none of the timing the heuristic keys on.
    private func insertText(_ text: String, _ done: @escaping (String?) -> Void) {
        evaluate(editorContainer, """
        (function () {
          var editor = monaco.editor.getEditors()[0];
          editor.focus();
          editor.pushUndoStop();
          editor.setPosition({ lineNumber: 1, column: 1 });
          return "ready";
        })()
        """) { [weak self] result in
            guard let self else { return }
            if case .bad(let reason) = result { done("the caret could not be placed: \(reason)"); return }
            self.cdp(self.editorContainer, "Input.insertText", ["text": text]) { ok, payload in
                done(ok ? nil : "Input.insertText failed: \((payload["message"] as? String) ?? "?")")
            }
        }
    }

    private func trigger(_ command: String, _ done: @escaping (String?) -> Void) {
        // `trigger` rather than a synthesised ⌘Z: what this drill proves is that the undo HISTORY
        // survived `markSaved`, and the mechanism that reaches the command is beside the point.
        // Drill 8 is where the keyboard path itself is on trial.
        evaluate(editorContainer,
                 "monaco.editor.getEditors()[0].trigger('harness', '\(command)', null) || 'ok'") { result in
            switch result {
            case .ok:
                done(nil)
            case .bad(let reason):
                done("\(command) failed: \(reason)")
            }
        }
    }

    private func currentValue(_ done: @escaping (HarnessAnswer<String>) -> Void) {
        evaluate(editorContainer, "monaco.editor.getEditors()[0].getModel().getValue()") { result in
            switch result {
            case .bad(let reason):
                done(.bad(reason))
            case .ok(let value):
                guard let text = value as? String else {
                    done(.bad("getValue() did not answer a string"))
                    return
                }
                done(.ok(text))
            }
        }
    }

    private func performActivate(_ stepId: String, path: String) {
        send(.activateModel(path: path)) { [weak self] error in
            guard let self else { return }
            if let error { self.local(stepId, false, error); return }
            self.readDebugState { result in
                switch result {
                case .bad(let reason):
                    self.local(stepId, false, reason)
                case .ok(let state):
                    // The page's own bookkeeping AND what the editor is really showing — two
                    // witnesses, because `currentPath` could be right while `setModel` never ran.
                    self.evaluate(self.editorContainer, """
                    (function () {
                      var model = monaco.editor.getEditors()[0].getModel();
                      return model ? model.uri.path : "<none>";
                    })()
                    """) { shown in
                        let showing = shown.value.map { "\($0 ?? "")" } ?? "<error>"
                        let ok = "\(state["current"] ?? "")" == path && showing == path
                        self.local(stepId, ok,
                                   "\(self.describe(state)); the editor is showing "
                                   + "\((showing as NSString).lastPathComponent)")
                    }
                }
            }
        }
    }

    /// **Sets the view state `9.viewState` later reads back**, on the CURRENT model — pathA, holding
    /// fixture B by this point (drill 7's `applyExternalContent`) — the step immediately before
    /// `9.openC` switches the editor away from it. That adjacency is load-bearing: it is the switch
    /// AWAY that captures this as pathA's `viewState` (`activateModel`'s `saveViewState()`), and set
    /// any earlier in the script, a later step's own `setPosition`/`insertText` call would have
    /// overwritten it long before that capture ever happens.
    ///
    /// **Self-verifying**: the same evaluate reads `getScrollTop()`/`getPosition()` straight back
    /// and fails the step if the SET itself did not take, so a later red at `9.viewState` can only
    /// mean the round trip (save/restore) broke — not that this step's own set silently no-opped.
    ///
    /// Reached through `monaco.editor.getEditors()[0]` — the same door `insertText`/`trigger`/
    /// `currentValue` already use elsewhere in this file — rather than a new bridge message or a new
    /// debug setter on `editor.js`: `page` is module-scoped and unreachable from `window`, but
    /// `window.monaco` is already global (`boot()` binds it from the AMD loader) and reaches the
    /// same live editor a purpose-built setter would, so a setter would just be a second door to the
    /// one room this door already opens.
    private func performSetView(_ stepId: String) {
        let line = EditorHarnessFixtures.viewStateLine
        let column = EditorHarnessFixtures.viewStateColumn
        let top = EditorHarnessFixtures.viewStateScrollTop
        evaluate(editorContainer, """
        (function () {
          var editor = monaco.editor.getEditors()[0];
          editor.setScrollTop(\(top));
          editor.setPosition({ lineNumber: \(line), column: \(column) });
          var position = editor.getPosition();
          return JSON.stringify({
            viewTop: editor.getScrollTop(),
            line: position ? position.lineNumber : null,
            column: position ? position.column : null
          });
        })()
        """) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, reason)
            case .ok(let value):
                guard let text = value as? String, let report = Self.jsonObject(text) else {
                    self.local(stepId, false, "the set-view probe did not answer")
                    return
                }
                let gotTop = (report["viewTop"] as? NSNumber)?.doubleValue
                let gotLine = (report["line"] as? NSNumber)?.intValue
                let gotColumn = (report["column"] as? NSNumber)?.intValue
                let tolerance = Double(EditorHarnessFixtures.viewStateScrollTolerance)
                let scrollOK = gotTop.map { abs($0 - Double(top)) <= tolerance } ?? false
                let positionOK = gotLine == line && gotColumn == column
                self.local(stepId, scrollOK && positionOK,
                           "set scrollTop → \(top), position → {\(line), \(column)} on the current "
                           + "model before 9.openC switches away from it; read back immediately: "
                           + "viewTop=\(gotTop.map { String(format: "%.1f", $0) } ?? "nil"), "
                           + "position={\(gotLine.map(String.init) ?? "nil"),"
                           + "\(gotColumn.map(String.init) ?? "nil")}")
            }
        }
    }

    /// **The round trip `9.setView` set up, judged.** `9.openC`'s `openModel` → `activateModel
    /// (pathC)` switch captured pathA's view state on the way out (`saveViewState()`, inside
    /// `activateModel`); `9.activateA`, immediately before this step, switched back and restored it
    /// (`restoreViewState()`). This reads the LIVE editor state — `normaEditorDebugState()`'s
    /// `viewTop`/`position`, not a cache of what `9.setView` set — because a restore that silently
    /// no-opped would still leave `page.currentPath` reporting the right model.
    ///
    /// `viewTop` gets the same tolerance `9.setView` self-checks with: `restoreViewState` is not
    /// contracted to land on the exact pixel `setScrollTop` was given. `position` gets none: cursor
    /// state restores as the exact `{lineNumber, column}` it was saved with, because pathA's content
    /// never changes between the save (at `9.openC`) and the restore (at `9.activateA`).
    private func performViewStateCheck(_ stepId: String) {
        readDebugState { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, reason)
            case .ok(let state):
                let viewTop = (state["viewTop"] as? NSNumber)?.doubleValue
                let position = state["position"] as? [String: Any]
                let line = (position?["lineNumber"] as? NSNumber)?.intValue
                let column = (position?["column"] as? NSNumber)?.intValue
                let wantLine = EditorHarnessFixtures.viewStateLine
                let wantColumn = EditorHarnessFixtures.viewStateColumn
                let wantTop = EditorHarnessFixtures.viewStateScrollTop
                let tolerance = Double(EditorHarnessFixtures.viewStateScrollTolerance)
                let scrollOK = viewTop.map { abs($0 - Double(wantTop)) <= tolerance } ?? false
                let positionOK = line == wantLine && column == wantColumn
                self.local(stepId, scrollOK && positionOK,
                           "viewTop = \(viewTop.map { String(format: "%.1f", $0) } ?? "nil") "
                           + "(want \(wantTop) ±\(Int(tolerance))); position = "
                           + "{\(line.map(String.init) ?? "nil"), \(column.map(String.init) ?? "nil")} "
                           + "(want {\(wantLine), \(wantColumn)})")
            }
        }
    }

    private func performWritePulledText(_ stepId: String) {
        guard let text = lastPulledText else {
            local(stepId, false, "no contentResponse text was captured to write")
            return
        }
        let url = URL(fileURLWithPath: fixtures.pathA)
        do {
            try Data(text.utf8).write(to: url, options: .atomic)
            let readBack = try Data(contentsOf: url)
            guard readBack == Data(text.utf8) else {
                local(stepId, false, "the file on disk does not match what was pulled")
                return
            }
            artifacts["savedFile"] = url.path
            local(stepId, true, "wrote \(readBack.count) byte(s) atomically to \(url.lastPathComponent) "
                  + "and read them back identical")
        } catch {
            local(stepId, false, "the write failed: \(error)")
        }
    }

    /// A `markSaved` the page must refuse. The observable is the WARNING, not the absence of a dirty
    /// transition: an acknowledgement that wrongly cleared a model that is already clean would emit
    /// nothing either, because the page reports transitions only — the same silence that hid the
    /// path-only race in the first place.
    private func performNegativeAck(_ stepId: String, seq: UInt64) {
        send(.markSaved(path: fixtures.pathA, seq: seq)) { [weak self] error in
            guard let self else { return }
            if let error { self.local(stepId, false, error); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.readConsole { lines in
                    let warned = lines.contains { $0.contains("unknown or superseded pull") }
                    self.readDebugState { result in
                        let dirty = result.value
                            .flatMap { ($0["dirtyMap"] as? [String: Any])?[self.fixtures.pathA] as? Bool }
                        self.local(stepId, warned,
                                   "the page \(warned ? "warned and cleared nothing" : "did NOT warn") "
                                   + "for seq \(seq); dirty is now \(dirty.map(String.init) ?? "?") "
                                   + "— page said: \(lines.joined(separator: " | "))")
                    }
                }
            }
        }
    }

    private func performCommandS(_ stepId: String) {
        // The one drill that puts the keyboard path itself on trial: `editor.addCommand(CtrlCmd|KeyS)`
        // has to be reached through CEF's key handling, with the CEF view focused. `rawKeyDown` is the
        // shape a shortcut takes — a plain `keyDown` would also generate a character event, and a
        // command chord produces none.
        let modifiers = 4  // Meta / Command
        let key: [String: Any] = [
            "modifiers": modifiers, "key": "s", "code": "KeyS",
            "windowsVirtualKeyCode": 83, "nativeVirtualKeyCode": 83
        ]
        raise()
        window.makeFirstResponder(editorContainer)
        performFocusThen { [weak self] in
            guard let self else { return }
            var down = key
            down["type"] = "rawKeyDown"
            self.cdp(self.editorContainer, "Input.dispatchKeyEvent", down) { ok, payload in
                guard ok else {
                    self.local(stepId, false,
                               "Input.dispatchKeyEvent was refused: \((payload["message"] as? String) ?? "?")")
                    return
                }
                var up = key
                up["type"] = "keyUp"
                self.cdp(self.editorContainer, "Input.dispatchKeyEvent", up) { _, _ in }
            }
        }
    }

    private func performFocusThen(_ next: @escaping () -> Void) {
        evaluate(editorContainer, """
        (function () { monaco.editor.getEditors()[0].focus(); return "ok"; })()
        """) { _ in next() }
    }

    /// `getComputedStyle` of both Monaco's own editor root and its background div, joined — what
    /// `performTheme` (drill 10) probes to prove a `setTheme` actually repainted something rather
    /// than merely failing to throw. `performBrandTheme` (drill 1, below) does NOT use this: proving
    /// a repaint is drill 10's claim, not this step's — see its own doc for why.
    private static let backgroundProbeScript = """
    (function () {
      var editor = document.querySelector(".monaco-editor");
      var background = document.querySelector(".monaco-editor-background");
      return (editor ? getComputedStyle(editor).backgroundColor : "?")
        + " / " + (background ? getComputedStyle(background).backgroundColor : "?");
    })()
    """

    /// editor-product Task 4 — the SAME send an `EditorRuntime` makes the instant `ready` arrives
    /// (`EditorRuntimeReducer`'s `.pageReady` case), performed here because this harness drives its
    /// own bridge client rather than a product runtime. Its purpose is NOT drill 10's job (proving
    /// `setTheme` can repaint at all, which needs the page settled enough to answer a DOM query
    /// meaningfully) — it is making every LATER step in this run, including drill 10's own
    /// `10.before` screenshot, reflect an editor that is already branded, the way a real session's is
    /// by the time a user ever sees it. So the claim here is deliberately narrower and does not
    /// depend on `.monaco-editor`'s DOM query timing at all: the call delivered with no exception,
    /// and the page logged nothing while handling it.
    ///
    /// **Measured, not assumed**: probing `.monaco-editor`/`.monaco-editor-background` THIS early —
    /// one step after `ready`, on a renderer that has done nothing yet but boot — answered `"?"` for
    /// both, before AND 300ms after the send, on a run where drill 10's IDENTICAL probe (after nine
    /// more drills' worth of activity) answered normally. Monaco's `create()` returns before its own
    /// first layout/paint pass has necessarily run; a claim that depends on querying its DOM this
    /// early would be measuring the harness's own timing, not the bridge.
    private func performBrandTheme(_ stepId: String) {
        let tokens = EditorTheme.tokensJSON(for: EditorRuntime.currentColorScheme())
        send(.setTheme(tokensJSON: tokens)) { [weak self] error in
            guard let self else { return }
            if let error { self.local(stepId, false, error); return }
            self.readConsole { lines in
                let errors = lines.filter { $0.hasPrefix("error:") || $0.hasPrefix("csp:") }
                self.local(stepId, errors.isEmpty,
                           "sent the branded theme (\(tokens.utf8.count) bytes), no exception"
                           + (errors.isEmpty ? ", the page logged nothing"
                              : "; the page logged \(errors.joined(separator: " | "))"))
            }
        }
    }

    private func performTheme(_ stepId: String) {
        evaluate(editorContainer, Self.backgroundProbeScript) { [weak self] before in
            guard let self else { return }
            let beforeText = before.value.map { "\($0 ?? "")" } ?? "?"
            let tokens = """
            {"base":"vs-dark","inherit":true,"rules":[],\
            "colors":{"editor.background":"#0B1020","editor.foreground":"#E6E8F2"}}
            """
            self.send(.setTheme(tokensJSON: tokens)) { error in
                if let error { self.local(stepId, false, error); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.evaluate(self.editorContainer, Self.backgroundProbeScript) { after in
                        let afterText = after.value.map { "\($0 ?? "")" } ?? "?"
                        self.readConsole { lines in
                            let errors = lines.filter { $0.hasPrefix("error:") || $0.hasPrefix("csp:") }
                            self.local(stepId, afterText != beforeText && errors.isEmpty,
                                       "background \(beforeText) → \(afterText)"
                                       + (errors.isEmpty ? "" : "; the page logged \(errors.joined(separator: " | "))"))
                        }
                    }
                }
            }
        }
    }

    private func performScreenshot(_ stepId: String, name: String) {
        cdp(editorContainer, "Page.captureScreenshot", ["format": "png"]) { [weak self] ok, payload in
            guard let self else { return }
            guard ok, let base64 = payload["data"] as? String,
                  let data = Data(base64Encoded: base64) else {
                self.local(stepId, false,
                           "Page.captureScreenshot did not answer an image: \((payload["message"] as? String) ?? "?")")
                return
            }
            let url = self.scratch.appendingPathComponent(name)
            do {
                try data.write(to: url, options: .atomic)
                self.artifacts[name] = url.path
                self.local(stepId, true, "\(url.path) (\(data.count) bytes)")
            } catch {
                self.local(stepId, false, "the screenshot could not be written: \(error)")
            }
        }
    }

    /// Drill 11's other browser. **Deliberately not a `data:` URL** (Chromium refuses top-level
    /// `data:` navigations, so the page would never exist): `about:blank` plus a CDP-evaluated
    /// `window.cefQuery` is the same thing where it matters — an arbitrary page in a Norma browser
    /// that is NOT the editor, calling the function the renderer-side router installs into every V8
    /// context.
    private func performCreateForeign(_ stepId: String, attempt: Int) {
        if attempt == 0 {
            let sidecar = NSWindow(contentRect: NSRect(x: 1360, y: 80, width: 420, height: 320),
                                   styleMask: [.titled, .closable], backing: .buffered, defer: false)
            sidecar.isReleasedWhenClosed = false
            sidecar.title = "harness — a page that is NOT the editor"
            foreignContainer.frame = sidecar.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 420, height: 320)
            foreignContainer.autoresizingMask = [.width, .height]
            sidecar.contentView?.addSubview(foreignContainer)
            sidecar.orderFront(nil)
            foreignWindow = sidecar
            NormaCEFCreateBrowser(foreignContainer, "about:blank", 0) // no override — not the editor
        }
        let id = NormaCEFBrowserIdentifierForParent(foreignContainer)
        let editorId = NormaCEFBrowserIdentifierForParent(editorContainer)
        guard id != 0, id != editorId else {
            guard attempt < 40 else {
                local(stepId, false, "the second browser never came up (id=\(id), editor=\(editorId))")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.performCreateForeign(stepId, attempt: attempt + 1)
            }
            return
        }
        local(stepId, true, "a second browser exists — id \(id), and the editor is id \(editorId)")
    }

    private func performForeignQuery(_ stepId: String) {
        let refusalsBefore = refusals.count
        // The request is a WELL-FORMED editor message on purpose. If the handler discriminated by
        // shape rather than by browser, this would sail through — the refusal has to come from the
        // browser it arrived on and nothing else.
        let script = """
        new Promise(function (resolve) {
          if (typeof window.cefQuery !== "function") { resolve("NO CEFQUERY ON THIS PAGE"); return; }
          window.cefQuery({
            request: JSON.stringify({ type: "saveRequested", path: "/tmp/not-the-editors-file" }),
            persistent: false,
            onSuccess: function (response) { resolve("ACCEPTED: " + response); },
            onFailure: function (code, message) { resolve("refused: code=" + code + " " + message); }
          });
        })
        """
        evaluate(foreignContainer, script, awaitPromise: true) { [weak self] result in
            guard let self else { return }
            switch result {
            case .bad(let reason):
                self.local(stepId, false, "the foreign page could not be driven: \(reason)")
            case .ok(let value):
                let text = "\(value ?? "")"
                let recorded = self.refusals.count > refusalsBefore
                self.local(stepId, text.hasPrefix("refused:") && recorded,
                           "\(text); the handler recorded \(self.refusals.count - refusalsBefore) "
                           + "refusal(s) for it")
            }
        }
    }
}

// MARK: - Fixtures and the step list

/// The files the drill opens, the bytes it expects back, and the ordered script.
///
/// **The expectations are COMPUTED, not transcribed.** Monaco normalises line endings when it builds
/// a buffer (`MonacoTextBuffer`), so a fixture with a CRLF section does not come back as it went in.
/// Writing the expected bytes by hand would either avoid mixed endings — leaving the normalisation
/// unmeasured — or fail for a reason that has nothing to do with the bridge.
struct EditorHarnessFixtures {
    let pathA: String
    let pathB: String
    let pathC: String
    let fixtureA: String
    let fixtureB: String
    let fixtureC: String

    /// **Task 1's view-state drill target — one place, four consumers.** `performSetView` sets
    /// exactly this; `performViewStateCheck` asserts exactly this back; `buildFixtureB` builds its
    /// line 30 AT this line/column so the fixture and the assertion cannot drift apart; the pinning
    /// test in `EditorPlumbingTests` reads it too rather than re-typing the numbers a fifth time.
    static let viewStateScrollTop = 400
    /// `restoreViewState` is not contracted to land on the exact pixel `setScrollTop` was given
    /// (line-height rounding, view-zone bookkeeping) — the claim under test is "the scroll survived
    /// the round trip", not "the scroll is an exact pixel".
    static let viewStateScrollTolerance = 50
    static let viewStateLine = 30
    static let viewStateColumn = 5

    init(scratch: URL) {
        pathA = scratch.appendingPathComponent("fixture-a.ts").path
        pathB = scratch.appendingPathComponent("fixture-b.ts").path
        pathC = scratch.appendingPathComponent("fixture-c.json").path
        fixtureA = Self.buildFixtureA()
        fixtureB = Self.buildFixtureB()
        fixtureC = Self.buildFixtureC()
    }

    func writeToDisk() throws {
        try Data(fixtureA.utf8).write(to: URL(fileURLWithPath: pathA), options: .atomic)
        try Data(fixtureB.utf8).write(to: URL(fileURLWithPath: pathB), options: .atomic)
        try Data(fixtureC.utf8).write(to: URL(fileURLWithPath: pathC), options: .atomic)
    }

    /// **A real `.ts` file, and the extension is load-bearing.** The TypeScript language worker is
    /// the only thing in the page that exercises the loader's cross-origin FETCH path (nested worker
    /// modules fetch; they do not `importScripts`), so a `.txt` fixture would leave the riskiest
    /// path in Stage A unexecuted while every drill went green.
    ///
    /// It carries what a round-trip proof needs and nothing decorative: non-ASCII across several
    /// widths, a combining sequence beside its precomposed twin (which Swift's `String ==` would
    /// call equal and a byte comparison would not), backslashes and quotes for the JSON escaping,
    /// a CRLF section for the normalisation rule, and NO trailing newline.
    ///
    /// U+2028/U+2029 are deliberately absent even though the codec escapes them: Monaco's standalone
    /// editor has its own `unusualLineTerminators` behaviour that can REMOVE them from the buffer,
    /// which would break the byte comparison for a reason that is not the bridge's. The codec's
    /// escaping is pinned by a unit test instead.
    private static func buildFixtureA() -> String {
        let lfLines = [
            "// Norma editor harness fixture A — TypeScript, on purpose.",
            "// The language worker is what proves the cross-origin fetch path.",
            "",
            "export interface Café {",
            "    /** precomposed é: caf\u{00E9}; decomposed e + U+0301: cafe\u{0301} */",
            "    readonly naïve: boolean;",
            "    readonly 日本語: string;",
            "    readonly 🚀: number;",
            "}",
            "",
            "type Verdict = \"pass\" | \"fail\" | \"pending\";",
            "",
            "const ESCAPES = /\\\\\"|\\\\n|\\\\t/g;",
            "const QUOTED = \"a \\\"quoted\\\" string with a backslash: \\\\\";",
            "const TEMPLATE = `a ${\"template\"} literal`;",
            "",
            "export function judge(seq: number, expected: number): Verdict {",
            "    if (seq === expected) {",
            "        return \"pass\";",
            "    }",
            "    if (seq < expected) {",
            "        return \"pending\";",
            "    }",
            "    return \"fail\";",
            "}",
            "",
            "export class Ledger<T> {",
            "    private readonly rows: T[] = [];",
            "",
            "    public append(row: T): this {",
            "        this.rows.push(row);",
            "        return this;",
            "    }",
            "",
            "    public get size(): number {",
            "        return this.rows.length;",
            "    }",
            "}",
            "",
            "export const DEFAULTS = {",
            "    tabSize: 4,",
            "    insertSpaces: true,",
            "    trimAutoWhitespace: true",
            "};",
            ""
        ]
        // A minority CRLF block: `_getEOL` counts terminators and the majority wins, so this comes
        // back as LF — which is exactly the property the round-trip expectation is computed through.
        let crlfLines = [
            "// ---- this block is CRLF-terminated ----",
            "export const CRLF_SECTION = true;",
            "export const NORMALISED_ON_THE_WAY_IN = \"expect LF back\";"
        ]
        // No trailing newline on the last line, deliberately.
        return lfLines.joined(separator: "\n") + "\n"
            + crlfLines.joined(separator: "\r\n") + "\r\n"
            + "export const LAST_LINE_HAS_NO_NEWLINE = true;"
    }

    /// The external write. **Uniformly CRLF**, which takes the OTHER branch of Monaco's rule: with
    /// no lone CR and no lone LF there is nothing to rewrite, so this one must come back byte for
    /// byte as it went in. Fixture A proves the normalisation happens; this proves it does not
    /// happen to a file that never needed it.
    ///
    /// **Extended for Task 1's view-state drill** (a Stage B input the Stage-A exit gate never
    /// asserted): by drill 9, THIS is what pathA's model holds — drill 7's `7.apply` replaced
    /// fixture A's text with it, and nothing replaces it again before `9.setView`/`9.viewState` set
    /// and read back the live editor's scroll position and cursor. The original 5-line fixture could
    /// not carry that drill: 5 lines give the editor nothing to scroll (`setScrollTop` would clamp
    /// to a few dozen px at most, nowhere near `viewStateScrollTop`) and no line 30 to put a cursor
    /// on. The padding below is still uniformly CRLF — generated onto the SAME array the original
    /// five lines start, joined by the SAME `"\r\n"` separator — so drill 7's byte-identical round
    /// trip stays exactly as strict; only the length changed.
    private static func buildFixtureB() -> String {
        var lines: [String] = [
            "// Norma editor harness fixture B — written from OUTSIDE the editor.",
            "// Uniformly CRLF: Monaco keeps it, and the round trip must be byte-identical.",
            "export const source = \"an agent edit, or a reload from disk\";",
            "export const naïve = \"caf\u{00E9} / cafe\u{0301}\";",
            "export const answer = 42;"
        ]
        // Padding, so there is real scrollable height to give — every line is content (a unique,
        // syntactically plausible top-level declaration), not a wall of one repeated filler string.
        while lines.count < viewStateLine - 1 {
            lines.append("export const PADDING_\(lines.count) = \(lines.count);")
        }
        // Line `viewStateLine` (1-indexed — this append makes it the array's `viewStateLine`th
        // element): real, indented content. `setPosition({ lineNumber: viewStateLine, column:
        // viewStateColumn })` lands right after the indent, before a real word, on a line long
        // enough that the column is never past its end.
        let indent = String(repeating: " ", count: viewStateColumn - 1)
        lines.append("\(indent)export const HARNESS_VIEW_STATE_TARGET = "
                     + "\"line \(viewStateLine), column \(viewStateColumn)\";")
        while lines.count < 90 {
            lines.append("export const PADDING_\(lines.count) = \(lines.count);")
        }
        return lines.joined(separator: "\r\n")
    }

    /// The second model — `.json`, so a SECOND language worker has to boot, and deliberately
    /// malformed so that worker has something to report. A marker arriving is the proof it ran.
    private static func buildFixtureC() -> String {
        return [
            "{",
            "  \"harness\": \"editor-plumbing task 5\",",
            "  \"model\": \"the second one\",",
            "  \"deliberatelyMalformed\": true,",
            "}"
        ].joined(separator: "\n")
    }

    static let drillTitles: [Int: String] = [
        0: "setup — asset root, bridge handler, fixtures, CEF",
        1: "the page boots offline from norma-editor:// and the branded theme lands on ready",
        2: "openModel with a real .ts file, and the language worker behind it",
        3: "a keystroke turns the model dirty",
        4: "pullContent answers byte-identically",
        5: "the save loop — write, markSaved, and an undo history that survived it",
        6: "the race a path-only acknowledgement cannot close",
        7: "an external write, and the acknowledgements it invalidates",
        8: "⌘S reaches Monaco and comes back as saveRequested",
        9: "a second model, the activate-after-close obligation, and a view state that survives it",
        10: "setTheme repaints the editor",
        11: "a query from another browser is refused, not ignored"
    ]

    /// The whole run, in order. Every step names the drill it belongs to so the transcript can be
    /// read as eleven claims rather than forty lines.
    static func steps(_ fixtures: EditorHarnessFixtures) -> [EditorHarnessStep] {
        let pathA = fixtures.pathA
        let pathC = fixtures.pathC
        // What Monaco will hand back for each fixture — see `MonacoTextBuffer`.
        let a = MonacoTextBuffer.savedText(forFileOpenedWith: fixtures.fixtureA)
        let b = MonacoTextBuffer.savedText(forFileOpenedWith: fixtures.fixtureB)
        let c = MonacoTextBuffer.savedText(forFileOpenedWith: fixtures.fixtureC)

        func step(_ id: String, _ drill: Int, _ title: String,
                  _ expectation: EditorHarnessExpectation, _ timeout: TimeInterval) -> EditorHarnessStep {
            return EditorHarnessStep(id: id, drill: drill, title: title,
                                     expectation: expectation, timeout: timeout)
        }

        return [
            step("0.setup", 0, "register the asset root and the bridge handler, write the fixtures, start CEF",
                 .local, 30),

            step("1.boot", 1, "create the browser at \(EditorBridgeHarnessRun.pageURL) and wait for ready",
                 .ready, 30),
            step("1.brand", 1, "send the SAME branded setTheme an EditorRuntime sends on ready, no "
                 + "exception, nothing logged — so every later step, including drill 10's "
                 + "before-screenshot, sees an editor that is already branded",
                 .local, 15),
            step("1.bound", 1, "the page booted inside the drill's 5 s bound", .local, 10),
            step("1.origin", 1, "the page really is on the norma-editor: scheme", .local, 15),
            step("1.offline", 1, "every resource the page fetched is norma-editor: or blob:", .local, 15),
            step("1.hook", 1, "install the console/CSP capture and confirm the debug seam", .local, 15),

            step("2.open", 2, "openModel fixture A (.ts) — the model is present and clean", .local, 20),
            step("2.worker", 2, "the TypeScript worker boots and answers (fetch + CORS + CSP)", .local, 45),
            step("2.console", 2, "the page logged nothing while opening it", .local, 15),

            step("3.focus", 3, "focus Monaco's hidden input and put the caret at 1,1", .local, 15),
            step("3.type", 3, "Input.insertText \"x\" — the model goes dirty",
                 .dirty(path: pathA, dirty: true), 15),

            step("4.pull", 4, "pullContent seq 1 answers with the fixture plus the keystroke, byte for byte",
                 .content(path: pathA, seq: 1, text: "x" + a), 20),

            step("5.write", 5, "write the pulled bytes to disk atomically and read them back", .local, 15),
            step("5.ack", 5, "markSaved seq 1 clears the dirty flag",
                 .dirty(path: pathA, dirty: false), 15),
            step("5.undo", 5, "undo the pre-save edit — the model goes dirty again",
                 .dirty(path: pathA, dirty: true), 15),
            step("5.undone", 5, "the undo really restored the pre-edit text — markSaved touched no history",
                 .local, 15),
            step("5.redo", 5, "redo returns to the saved point and the model reads clean",
                 .dirty(path: pathA, dirty: false), 15),

            step("6.typeY", 6, "type \"y\" — dirty again, and this is the pull the race is run against",
                 .dirty(path: pathA, dirty: true), 15),
            step("6.pull2", 6, "pullContent seq 2 answers with the current text",
                 .content(path: pathA, seq: 2, text: "yx" + a), 20),
            step("6.typeZ", 6, "type \"z\" BEFORE the acknowledgement — an already-dirty model says nothing",
                 .silence(types: ["modelDirtyChanged"]), 2.5),
            step("6.ackRace", 6, "markSaved seq 2 — the buffer moved past the pull, so NOTHING may clear",
                 .silence(types: ["modelDirtyChanged"]), 3),
            step("6.stillDirty", 6, "the page still reports the model dirty", .local, 15),
            step("6.undoZ", 6, "undo the extra keystroke — clean arrives through the ordinary transition",
                 .dirty(path: pathA, dirty: false), 15),
            step("6.undoneZ", 6, "the buffer is back at the exact text pull 2 answered with", .local, 15),
            step("6.stale", 6, "markSaved for the superseded seq 1 warns and clears nothing", .local, 20),

            step("7.typeW", 7, "type \"w\" so the external write has a transition to make",
                 .dirty(path: pathA, dirty: true), 15),
            step("7.apply", 7, "applyExternalContent fixture B — exactly one transition, to clean",
                 .dirty(path: pathA, dirty: false), 15),
            step("7.ackAfterExternal", 7, "an acknowledgement for the pull the external write invalidated "
                 + "warns and clears nothing", .local, 20),
            step("7.pull3", 7, "pullContent seq 3 answers with fixture B, byte for byte",
                 .content(path: pathA, seq: 3, text: b), 20),

            step("8.save", 8, "⌘S through CEF's key handling reaches Monaco's command",
                 .saveRequested(path: pathA), 15),

            step("9.setView", 9, "set scrollTop \(EditorHarnessFixtures.viewStateScrollTop) and cursor "
                 + "{\(EditorHarnessFixtures.viewStateLine), \(EditorHarnessFixtures.viewStateColumn)} "
                 + "on the current model, the step before it is switched away from", .local, 15),
            step("9.openC", 9, "open a second model (.json) — it becomes current, both are clean", .local, 20),
            step("9.jsonWorker", 9, "the JSON worker boots and reports on the malformed fixture", .local, 30),
            step("9.activateA", 9, "activate the first model again — the editor really shows it", .local, 15),
            step("9.viewState", 9, "reactivating it restored the scroll + cursor the step before "
                 + "9.openC set — the view-state round trip the Stage-A exit gate never asserted",
                 .local, 15),
            step("9.closeActive", 9, "close the ACTIVE model — the editor is left showing nothing", .local, 15),
            step("9.activateC", 9, "activate the survivor — Swift's obligation after a close, exercised",
                 .local, 15),

            step("10.before", 10, "screenshot before the theme", .local, 25),
            step("10.theme", 10, "setTheme with dark tokens repaints the editor", .local, 20),
            step("10.after", 10, "screenshot after the theme", .local, 25),

            step("11.foreign", 11, "create a second browser that is not the editor", .local, 25),
            step("11.refused", 11, "its window.cefQuery is REFUSED — answered false, never ignored",
                 .local, 25),
            step("11.unaffected", 11, "the editor's own bridge still answers",
                 .content(path: pathC, seq: 4, text: c), 20)
        ]
    }
}
#endif
