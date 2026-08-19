#if DEBUG
import AppKit
import CryptoKit
import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// office-plumbing Task 9 — **Stage A's live exit gate: the first end-to-end run of everything
/// Tasks 1-8 built, against the REAL compiled `NormaOfficeHelper`, the REAL vendored LibreOffice, and
/// `ShellSessionHost`'s REAL production wiring — never a fixture, never a recorder-backed double.**
///
/// **Mirrors `EditorBridgeHarness.swift`'s architecture, not its mechanics.** That file exists
/// because a CEF bridge answers asynchronously through injected JavaScript with no way to `await` it
/// directly, so its harness arms an expectation before acting and judges whichever message arrives
/// against it. Nothing here needs that: `OfficeRuntime.open`, `OfficeHelperClient.open`, a raw
/// `OfficeWireConnection` are already `async`, so every step's own action can simply await its
/// outcome (polling with a bounded `waitUntil`, the same shape `OfficeRuntimeLiveTests`/
/// `OfficeHelperLiveSmokeTests` already use throughout this suite) and hand back a definite verdict.
/// What DOES carry over unchanged: a menu item that opens the SAME run an unattended env-gated launch
/// performs, a step list that fails-and-continues (never stops the run early — see `runAllSteps`'s own
/// doc), a JSON transcript, a run watchdog, and the fresh-binary proof (`BINARY`/`BUILT` logged before
/// anything else runs).
///
/// **Three constraints this file exists under, the same three `EditorBridgeHarness.swift` names**:
///
/// 1. **The second-copy dance, doubled.** Every path this harness touches — the six fixture copies,
///    the shared supervisor's state directory, both dedicated throwaway helpers' state directories —
///    lives under ONE scratch root this run owns and deletes nothing outside of. `NORMA_OFFICE_STATE_
///    PATH`/`NORMA_CEF_CACHE_PATH` are never read here: `ShellSessionHost.makeOfficeHelperSupervisor`
///    is overridden with an EXPLICIT `socketDirectory`, which cannot fall back to the real default the
///    way an unset env var could. `NORMA_CEF_CACHE_PATH` is still stamped defensively (this harness
///    never starts CEF, but the hard rule is cheap insurance against a future call path that would).
/// 2. **It never calls `boot()`.** Like `EditorBridgeHarness.start()`, this runs INSTEAD of `boot()` —
///    no daemon, no helper registration, no login item, no updater, no second orb. Drill 12's own
///    "daemonless" step is this constraint, stated as evidence rather than left implicit.
/// 3. **Every wait has a deadline, and a failed step records and continues.** See `runAllSteps`'s own
///    doc for why the run never stops on the first red — twelve independent claims, not one chain.
enum OfficeHarness {
    static var isRequested: Bool {
        ProcessInfo.processInfo.environment["NORMA_OFFICE_HARNESS"] == "1"
    }

    @MainActor
    static func start(delegate: AppDelegate) {
        run(delegate: delegate, quitWhenDone: true)
    }

    @MainActor
    static func open(delegate: AppDelegate) {
        if let existing = OfficeHarnessRun.shared {
            existing.raise()
            return
        }
        run(delegate: delegate, quitWhenDone: false)
    }

    @MainActor
    private static func run(delegate: AppDelegate, quitWhenDone: Bool) {
        let harness = OfficeHarnessRun(delegate: delegate, quitWhenDone: quitWhenDone)
        OfficeHarnessRun.shared = harness
        harness.begin()
    }
}

// MARK: - The run

@MainActor
final class OfficeHarnessRun: NSObject, NSWindowDelegate {
    static var shared: OfficeHarnessRun?

    private unowned let delegate: AppDelegate
    private let quitWhenDone: Bool
    private let startedAt = Date()
    private var finished = false
    private var runWatchdog: DispatchWorkItem?

    private let window: NSWindow
    private let readout = NSTextView()

    private var stepRecords: [[String: Any]] = []
    private var notes: [String] = []

    // MARK: Second-copy scratch roots — everything under ONE root this run owns

    private let scratchRoot: URL
    private let fixturesScratchDir: URL
    private let sharedSupervisorStateDir: URL
    private let throwawayHelper1StateDir: URL
    private let throwawayHelper10StateDir: URL
    /// A SIBLING of `fixturesScratchDir`, never nested inside it — drills 6/7's unzip/edit/rezip
    /// churn happens entirely here, off the directory the file-watcher actually observes. See
    /// `makeModifiedXlsxInPlace`/`makeModifiedOdtInPlace`'s own header for why this separation is
    /// load-bearing, not cosmetic.
    private let zipSurgeryScratchDir: URL

    // MARK: The shared, production-path host (drills 2-9)

    private var host: ShellSessionHost!
    private var runtime: OfficeRuntime!
    /// `"gate.xlsx"` -> its scratch copy's path, etc. — six entries after `0.setup`.
    private var fixturePaths: [String: String] = [:]
    /// Captured at `0.setup`, BEFORE anything this run does — the baseline `11.userCachesUntouched`
    /// diffs against.
    private var userOfficeDirListingBeforeRun: [String] = []
    /// Captured at `0.setup`, BEFORE anything this run does — the baseline `11.noDockPresence` diffs
    /// against. Cannot assert emptiness: any real machine already has Finder, Xcode, etc. running
    /// with `.regular` activation policy. By PID rather than bundle id, since two instances of the
    /// same app are two different Dock icons.
    private var regularAppPidsBeforeRun: Set<pid_t> = []

    // MARK: Drill 1 — a dedicated, throwaway helper (never the shared one)

    private var dedicatedProcess1: Process?
    private var dedicatedConnection1: OfficeWireConnection?
    private var lokVersionFromDrill1 = ""

    // MARK: Drill 3 — tile arrival + stability

    private var tile3DocId = ""
    private let tile3Key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
    private var tile3FirstHash = ""

    // MARK: Drill 5 — the templated multi-sheet fixture

    private var multiSheetPath = ""
    private var multiSheetDocId = ""
    private var multiPart0Pixels: Data?

    // MARK: Drill 6 — external change on gate.xlsx

    private var doc6OriginalDocId = ""
    private var doc6NewDocId = ""

    // MARK: Drill 7 — the mirror-case, on gate.odt

    private var doc7Path = ""

    // MARK: Drill 8 — SIGKILL + reopen, on the SHARED helper

    private var pid8Before: Int32 = 0

    // MARK: Drill 10 — a SECOND dedicated, throwaway helper (idle-exit needs a clean disconnect door
    // the shared supervisor's `stop()` does not have — it only SIGKILLs — so this drill cannot share
    // drill 1's own throwaway helper either: 1's is torn down by a kill, on purpose, before 2 boots)

    private var dedicatedProcess10: Process?
    private var dedicatedConnection10: OfficeWireConnection?
    private var dedicatedClient10: OfficeHelperClient?

    init(delegate: AppDelegate, quitWhenDone: Bool) {
        self.delegate = delegate
        self.quitWhenDone = quitWhenDone

        let root = ProcessInfo.processInfo.environment["NORMA_OFFICE_HARNESS_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true)
        } ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("norma-office-harness-\(UUID().uuidString.prefix(8))", isDirectory: true)
        scratchRoot = root
        fixturesScratchDir = root.appendingPathComponent("fixtures", isDirectory: true)
        sharedSupervisorStateDir = root.appendingPathComponent("shared-helper", isDirectory: true)
        throwawayHelper1StateDir = root.appendingPathComponent("drill1-helper", isDirectory: true)
        throwawayHelper10StateDir = root.appendingPathComponent("drill10-helper", isDirectory: true)
        zipSurgeryScratchDir = root.appendingPathComponent("zip-surgery", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        // Hard-rule insurance (this run never starts CEF, but the rule is cheap and unconditional —
        // see this type's own header, constraint 1).
        setenv("NORMA_CEF_CACHE_PATH", root.appendingPathComponent("cef-cache", isDirectory: true).path, 1)

        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 1000, height: 760),
                          styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma office harness"
        super.init()
        window.delegate = self
        buildWindow()
    }

    private func buildWindow() {
        guard let content = window.contentView else { return }
        let scroll = NSScrollView(frame: content.bounds)
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        readout.isEditable = false
        readout.isRichText = false
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

    func windowWillClose(_ notification: Notification) {
        guard (notification.object as? NSWindow) === window else { return }
        teardownEverything()
        OfficeHarnessRun.shared = nil
    }

    // MARK: Ledger

    private func log(_ line: String) {
        let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
        fputs("OFFICEHARNESS \(ms) \(line)\n", stderr)
        fflush(stderr)
        readout.string += "\(String(format: "%6d", ms))  \(line)\n"
        readout.scrollToEndOfDocument(nil)
    }

    // MARK: Boot

    func begin() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Fresh-binary proof — the same stale-derivedDataPath trap the editor harness's own header
        // names as a prior real failure in this repo (a five-day-old binary re-tested for a whole
        // live gate). "Process start" is this run's own start timestamp: the binary that answers
        // every call below was necessarily built before THIS process could have launched with it, so
        // BEGIN > BUILT is exactly "process start > binary mtime."
        let exe = Bundle.main.executableURL?.path ?? "?"
        let built = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)
            .flatMap { $0 }
        log("BEGIN pid=\(ProcessInfo.processInfo.processIdentifier) "
            + "bundle=\(Bundle.main.bundleIdentifier ?? "?")")
        log("BINARY \(exe)")
        log("BUILT  \(built.map { ISO8601DateFormatter().string(from: $0) } ?? "?")")
        log("STARTED \(ISO8601DateFormatter().string(from: startedAt))")
        if let built {
            log("FRESH-BINARY PROOF: process start (\(startedAt)) > binary mtime (\(built)) = "
                + "\(startedAt > built)")
        }
        log("SCRATCH \(scratchRoot.path)")

        // The whole run has a ceiling — see this file's own header, constraint 3. Sized against the
        // sum of every step's own declared timeout (~855s worst case, dominated by drill 10's 150s
        // idle-exit wait and the six sequential format opens) plus real headroom, the same "same
        // order of headroom as the addition, not trimmed to fit it" posture the editor harness's own
        // Stage-B bump used.
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.notes.append("the run watchdog fired — the transcript below is what had been "
                              + "measured when it did")
            self.log("WATCHDOG — forcing the transcript out")
            self.finish()
        }
        runWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 900, execute: watchdog)

        Task { await runAllSteps() }
    }

    // MARK: The engine

    /// **Walks `OfficeHarnessPlan.steps` in order, and a failed step records and continues.**
    /// Stopping on the first red would leave every later drill unmeasured — the question this run
    /// exists to answer is which of twelve independent claims hold, not whether the first one does.
    /// Consequences of an earlier failure land on whatever depends on it, and say so in their own
    /// evidence strings (every action checks its own preconditions and names what is missing).
    private func runAllSteps() async {
        for step in OfficeHarnessPlan.steps {
            guard !finished else { return } // the watchdog already forced the transcript out
            log("→ [\(step.id)] \(step.title)")
            let stepStart = Date()
            let (passed, evidence) = await runStepAction(timeout: step.timeout) { [weak self] in
                guard let self else { return (false, "the harness was deallocated mid-run") }
                return await self.perform(step)
            }
            let elapsedMs = Int(Date().timeIntervalSince(stepStart) * 1000)
            log("\(passed ? "✓" : "✗") [\(step.id)] \(evidence)  (\(elapsedMs) ms)")
            stepRecords.append([
                "id": step.id, "drill": step.drill, "title": step.title,
                "verdict": passed ? "pass" : "fail", "evidence": evidence, "elapsedMs": elapsedMs
            ])
        }
        finish()
    }

    /// **Arm a deadline, then poll** — races the step's real action against a plain `Task.sleep` for
    /// exactly `timeout`, taking whichever finishes first. A losing action keeps running in the
    /// background on its own time (Swift task cancellation is cooperative and none of this file's
    /// `waitUntil` loops check `Task.isCancelled` — the same accepted imprecision the editor
    /// harness's own strays mechanism lives with): its eventual, late mutation of this run's own
    /// instance state is harmless bookkeeping, never something a later step's own precondition checks
    /// would misread as success.
    private func runStepAction(timeout: TimeInterval,
                               _ action: @escaping () async -> (Bool, String)) async -> (Bool, String) {
        await withTaskGroup(of: (Bool, String).self) { group in
            group.addTask { await action() }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                return (false, "step exceeded its \(timeout)s budget")
            }
            let first = await group.next() ?? (false, "no result")
            group.cancelAll()
            return first
        }
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    // MARK: Finish

    private func finish() {
        guard !finished else { return }
        finished = true
        runWatchdog?.cancel()

        let transcriptURL = scratchRoot.appendingPathComponent("transcript.json")
        let transcript = buildTranscript()
        if let data = try? JSONSerialization.data(withJSONObject: transcript,
                                                  options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? data.write(to: transcriptURL, options: .atomic)
            log("TRANSCRIPT \(transcriptURL.path) (\(data.count) bytes)")
        } else {
            log("TRANSCRIPT could not be serialised — see stderr above for every step")
        }
        let passed = stepRecords.filter { ($0["verdict"] as? String) == "pass" }.count
        let failed = stepRecords.filter { ($0["verdict"] as? String) == "fail" }.count
        log("RESULT \(passed) passed, \(failed) failed, \(stepRecords.count) step(s)")

        teardownEverything()

        guard quitWhenDone else {
            log("the harness window stays up — close it to release scratch state")
            return
        }
        delegate.reallyQuitting = true
        let timer = Timer(fire: Date().addingTimeInterval(1.0), interval: 0, repeats: false) { _ in
            NSApp.terminate(nil)
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Safe from every state, including a run that never got past `0.setup`. Every helper process
    /// this run could possibly have spawned is force-killed here regardless of whether its own drill
    /// passed — a step's failure must never leave a live `NormaOfficeHelper` process behind for the
    /// second-copy hygiene drills (or anything after them) to trip over.
    private func teardownEverything() {
        _ = host?.teardownAllOfficeRuntimesAndStopHelper()

        dedicatedConnection1?.close()
        if let process = dedicatedProcess1, process.isRunning { kill(process.processIdentifier, SIGKILL) }
        dedicatedConnection1 = nil
        dedicatedProcess1 = nil

        dedicatedConnection10?.close()
        if let process = dedicatedProcess10, process.isRunning { kill(process.processIdentifier, SIGKILL) }
        dedicatedConnection10 = nil
        dedicatedClient10 = nil
        dedicatedProcess10 = nil
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
                "drill": drill, "title": OfficeHarnessPlan.drillTitles[drill] ?? "",
                "verdict": green ? "pass" : "fail", "steps": steps.map { $0["id"] as? String ?? "" }
            ]
        }
        let exe = Bundle.main.executableURL?.path ?? "?"
        let built = (try? FileManager.default.attributesOfItem(atPath: exe)[.modificationDate] as? Date)
            .flatMap { $0 }
        return [
            "harness": "office (office-plumbing Task 9)",
            "startedAt": ISO8601DateFormatter().string(from: startedAt),
            "finishedAt": ISO8601DateFormatter().string(from: Date()),
            "binary": [
                "path": exe, "builtAt": built.map { ISO8601DateFormatter().string(from: $0) } ?? "?",
                "bundleId": Bundle.main.bundleIdentifier ?? "?",
                "pid": ProcessInfo.processInfo.processIdentifier,
                "freshBinaryProof": built.map { startedAt > $0 } ?? false
            ],
            "scratchRoot": scratchRoot.path,
            "summary": [
                "steps": stepRecords.count,
                "passed": stepRecords.filter { ($0["verdict"] as? String) == "pass" }.count,
                "failed": stepRecords.filter { ($0["verdict"] as? String) == "fail" }.count,
                "drills": drills.count,
                "drillsGreen": drills.filter { ($0["verdict"] as? String) == "pass" }.count
            ],
            "drills": drills,
            "steps": stepRecords,
            "notes": notes
        ]
    }

    // MARK: - The actions

    // swiftlint:disable:next cyclomatic_complexity
    private func perform(_ step: OfficeHarnessStep) async -> (Bool, String) {
        switch step.id {
        case "0.setup": return await performSetup()

        case "1.boot": return await performBoot1()
        case "1.version": return await performVersion1()
        case "1.teardown": return await performTeardown1()

        case "2.xlsx": return await performOpenFormat("gate.xlsx")
        case "2.ods": return await performOpenFormat("gate.ods")
        case "2.pptx": return await performOpenFormat("gate.pptx")
        case "2.odp": return await performOpenFormat("gate.odp")
        case "2.docx": return await performOpenFormat("gate.docx")
        case "2.odt": return await performOpenFormat("gate.odt")
        case "2.garbage": return await performGarbage2()

        case "3.cold": return await performTileCold3()
        case "3.evict": return await performTileEvict3()
        case "3.resubscribe": return await performTileResubscribe3()

        case "4.scan": return await performAlphaScan4()

        case "5.build": return await performMultiBuild5()
        case "5.open": return await performMultiOpen5()
        case "5.part0": return await performMultiPart0Fifth()
        case "5.part1": return await performMultiPart1Fifth()
        case "5.distinct": return await performMultiDistinct5()

        case "6.overwrite": return await performOverwrite6()
        case "6.reload": return await performReload6()
        case "6.freshTiles": return await performFreshTiles6()
        case "6.delete": return await performDelete6()
        case "6.restore": return await performRestore6()

        case "7.overwrite": return await performOverwrite7()
        case "7.delayedDelete": return await performDelayedDelete7()
        case "7.observe": return await performObserve7()
        case "7.siblingTouch": return await performSiblingTouch7()

        case "8.capturePid": return await performCapturePid8()
        case "8.kill": return await performKill8()
        case "8.diedObserved": return await performDied8()
        case "8.reopen": return await performReopen8()
        case "8.newPid": return await performNewPid8()

        case "9.rapidScroll": return await performRapidScroll9()
        case "9.zoomStep": return await performZoomStep9()

        case "10.setup": return await performSetup10()
        case "10.openClose": return await performOpenClose10()
        case "10.disconnect": return await performDisconnect10()
        case "10.waitExit": return await performWaitExit10()

        case "11.statePaths": return await performStatePaths11()
        case "11.userCachesUntouched": return await performUserCachesUntouched11()
        case "11.noDockPresence": return await performNoDockPresence11()

        case "12.kindWire": return await performKindWire12()
        case "12.router": return await performRouter12()
        case "12.daemonless": return await performDaemonless12()

        default: return (false, "the harness has no action for this step")
        }
    }

    // MARK: Drill 0 — setup

    private func performSetup() async -> (Bool, String) {
        do {
            try FileManager.default.createDirectory(at: fixturesScratchDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: sharedSupervisorStateDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: throwawayHelper1StateDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: throwawayHelper10StateDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: zipSurgeryScratchDir, withIntermediateDirectories: true)

            // The second-copy dance: scratch COPIES of the six committed fixtures, never the tracked
            // bytes themselves — mirrors task 8's own "second-copy dance, doubled."
            for name in Self.sixFixtureNames {
                let source = Self.committedFixturesRoot.appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: source.path) else {
                    return (false, "\(name) missing from the committed fixtures at \(source.path)")
                }
                let dest = fixturesScratchDir.appendingPathComponent(name)
                try FileManager.default.copyItem(at: source, to: dest)
                fixturePaths[name] = dest.path
            }
        } catch {
            return (false, "setup failed: \(error)")
        }

        // Baselines for 11.userCachesUntouched and 11.noDockPresence, taken BEFORE anything else this
        // run does.
        let realOfficeDir = OfficeHelperSupervisor.Configuration.defaultStateDirectory()
        userOfficeDirListingBeforeRun = (try? FileManager.default.contentsOfDirectory(atPath: realOfficeDir.path).sorted()) ?? []
        regularAppPidsBeforeRun = Set(NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map(\.processIdentifier))

        let directory = SessionDirectory(lister: { [] })
        let sessionHost = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        let stateDir = sharedSupervisorStateDir
        // The REAL embedded path: THIS process is a genuinely built Norma.app (the harness runs
        // inside it, never a bare xctest host), so `.production()`'s own `helperExecutableURL`
        // already resolves to `Contents/MacOS/NormaOfficeHelper` with `Contents/Resources/
        // LibreOffice` as its real sibling — no `--lok-root` override needed or wanted; this is a
        // MORE end-to-end proof than the `--lok-root` shortcut the XCTest-only live tests use (their
        // host is the xctest bundle, which has no embedded LibreOffice of its own). Only
        // `socketDirectory` is overridden, for the second-copy dance.
        sessionHost.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: OfficeHelperSupervisor.Configuration.production().helperExecutableURL,
                socketDirectory: stateDir))
        }
        host = sessionHost
        runtime = sessionHost.officeRuntime(for: "office-harness-session")
        return (true, "scratch root \(scratchRoot.path); host wired at \(stateDir.path); "
                     + "6 fixture(s) copied; real embedded helper path")
    }

    // MARK: Drill 1 — helper boot + version pin echo (a dedicated, throwaway helper)

    private func performBoot1() async -> (Bool, String) {
        let helperURL = OfficeHelperSupervisor.Configuration.production().helperExecutableURL
        guard FileManager.default.fileExists(atPath: helperURL.path) else {
            return (false, "NormaOfficeHelper not embedded at \(helperURL.path) — this build never ran the embed phase")
        }
        let stateDir = throwawayHelper1StateDir
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        try? FileManager.default.removeItem(atPath: socketPath)
        let token = "office-harness-t1-\(UUID().uuidString.prefix(8))"

        let process = Process()
        process.executableURL = helperURL
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path, "--token", token]
        do { try process.run() } catch { return (false, "spawn failed: \(error)") }
        dedicatedProcess1 = process

        let socketAppeared = await waitUntil(timeout: 35) { FileManager.default.fileExists(atPath: socketPath) }
        guard socketAppeared else { return (false, "socket never appeared — a cold dlopen exceeded budget") }

        let connection = OfficeWireConnection(socketPath: socketPath)
        do { try await connection.open() } catch { return (false, "connect failed: \(error)") }
        dedicatedConnection1 = connection

        do {
            try await connection.send(.hello(seq: 1, role: .app, token: token))
        } catch {
            return (false, "hello send failed: \(error)")
        }
        guard let reply = await connection.nextFrame(timeout: 5.0) else { return (false, "no reply to hello") }
        guard case .helloOk(let seq, let lokVersion) = reply, seq == 1 else {
            return (false, "unexpected reply to hello: \(reply)")
        }
        lokVersionFromDrill1 = lokVersion
        return (true, "helper boot + hello handshake OK, lokVersion=\(lokVersion)")
    }

    private func performVersion1() async -> (Bool, String) {
        guard !lokVersionFromDrill1.isEmpty else { return (false, "no lokVersion captured — 1.boot must run first") }
        guard lokVersionFromDrill1 != officeWireStageALOKVersionPlaceholder else {
            return (false, "lokVersion is still the Stage-A placeholder — LOK never really booted")
        }
        guard let pinned = Self.versionPinBuildId, !pinned.isEmpty else {
            return (false, "VERSION-PIN's LIBREOFFICE_CORE_COMMIT could not be read from \(Self.versionPinURL.path)")
        }
        guard lokVersionFromDrill1 == pinned else {
            return (false, "lokVersion \(lokVersionFromDrill1) != VERSION-PIN's \(pinned)")
        }
        return (true, "lokVersion \(lokVersionFromDrill1) matches VERSION-PIN's LIBREOFFICE_CORE_COMMIT exactly")
    }

    private func performTeardown1() async -> (Bool, String) {
        dedicatedConnection1?.close()
        dedicatedConnection1 = nil
        guard let process = dedicatedProcess1 else { return (true, "no throwaway helper was ever spawned") }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        let died = await waitUntil(timeout: 10) { !process.isRunning }
        dedicatedProcess1 = nil
        return (died, died ? "throwaway helper (drill 1) terminated before the shared one ever boots"
                          : "throwaway helper did not die within 10s")
    }

    // MARK: Drill 2 — open ×6 formats + garbage survival (the SHARED, production-path runtime)

    private struct FormatExpectation {
        let fixture: String
        let type: OfficeDocumentKind
        let parts: Int
        let widthTwips: Int64
        let heightTwips: Int64
        var widthToleranceTwips: Int64 = 0
    }

    /// The SAME table `OfficeHelperLiveTests.testSixFormatsOpenWithSaneTypePartsAndSize` pins,
    /// including gate.ods's own machine-relative width tolerance (that test's own F6, T3 review).
    private static let formatExpectations: [FormatExpectation] = [
        FormatExpectation(fixture: "gate.xlsx", type: .spreadsheet, parts: 1, widthTwips: 26593, heightTwips: 13005),
        FormatExpectation(fixture: "gate.ods", type: .spreadsheet, parts: 1, widthTwips: 26775, heightTwips: 13005, widthToleranceTwips: 300),
        FormatExpectation(fixture: "gate.pptx", type: .presentation, parts: 1, widthTwips: 15876, heightTwips: 8931),
        FormatExpectation(fixture: "gate.odp", type: .presentation, parts: 1, widthTwips: 15875, heightTwips: 8930),
        FormatExpectation(fixture: "gate.docx", type: .text, parts: 1, widthTwips: 12474, heightTwips: 17406),
        FormatExpectation(fixture: "gate.odt", type: .text, parts: 1, widthTwips: 12474, heightTwips: 17406)
    ]

    private func performOpenFormat(_ fixtureName: String) async -> (Bool, String) {
        guard let expectation = Self.formatExpectations.first(where: { $0.fixture == fixtureName }) else {
            return (false, "no expectation entry for \(fixtureName)")
        }
        guard let path = fixturePaths[fixtureName] else { return (false, "0.setup never copied \(fixtureName)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled else { return (false, "\(fixtureName) never settled — phase \(runtime.stateSnapshot.phase)") }
        guard let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "\(fixtureName) did not open: \(runtime.stateSnapshot.openFailures[path] ?? "no reason recorded")")
        }
        guard doc.type == expectation.type else { return (false, "\(fixtureName): type \(doc.type) != \(expectation.type)") }
        guard doc.parts == expectation.parts else { return (false, "\(fixtureName): parts \(doc.parts) != \(expectation.parts)") }
        let widthDelta = abs(doc.sizeTwips.widthTwips - expectation.widthTwips)
        guard widthDelta <= expectation.widthToleranceTwips else {
            return (false, "\(fixtureName): widthTwips \(doc.sizeTwips.widthTwips) is \(widthDelta) away from "
                          + "\(expectation.widthTwips) (tolerance \(expectation.widthToleranceTwips))")
        }
        guard doc.sizeTwips.heightTwips == expectation.heightTwips else {
            return (false, "\(fixtureName): heightTwips \(doc.sizeTwips.heightTwips) != \(expectation.heightTwips)")
        }
        return (true, "\(fixtureName): type=\(doc.type) parts=\(doc.parts) "
                     + "size=\(doc.sizeTwips.widthTwips)x\(doc.sizeTwips.heightTwips) docId=\(doc.docId)")
    }

    /// **"Garbage" = a path that does not exist on disk** — Task 3's own empirical finding, disclosed
    /// in its report and re-confirmed by `OfficeHelperLiveTests.testGarbageFileOpenFailsAndHelperSurvives`'s
    /// own header: malformed CONTENT (plain text, random bytes) under a real path does NOT reliably
    /// fail — LOK's own repair/recovery posture is lenient enough to produce some document rather than
    /// erroring. A nonexistent path is the one shape this repo has already proven `documentLoad`
    /// genuinely refuses, so this drill uses it rather than re-exploring a dead end.
    private func performGarbage2() async -> (Bool, String) {
        let garbagePath = fixturesScratchDir.appendingPathComponent("does-not-exist-\(UUID().uuidString.prefix(8)).docx").path
        guard !FileManager.default.fileExists(atPath: garbagePath) else { return (false, "sanity: garbage path must not exist") }
        runtime.open(garbagePath)
        let failed = await waitUntil(timeout: 10) { self.runtime.stateSnapshot.openFailures[garbagePath] != nil }
        guard failed else { return (false, "the nonexistent path never surfaced an openFailure") }
        let reason = runtime.stateSnapshot.openFailures[garbagePath] ?? "?"

        // Survival, proven by a GENUINE fresh round trip (close then re-open), not merely "phase
        // still reads .ready" — a tautology every one of the six already-open documents would pass
        // for free without the helper having done anything since the garbage open.
        guard let odtPath = fixturePaths["gate.odt"], runtime.stateSnapshot.documents[odtPath] != nil else {
            return (false, "gate.odt is not open — drill 2's own earlier steps must run first")
        }
        runtime.close(odtPath)
        let closed = await waitUntil(timeout: 10) { self.runtime.stateSnapshot.documents[odtPath] == nil }
        guard closed else { return (false, "gate.odt never closed") }
        runtime.open(odtPath)
        let reopened = await waitUntil(timeout: 15) { self.runtime.stateSnapshot.documents[odtPath] != nil }
        guard reopened else { return (false, "the helper did NOT survive — gate.odt could not be re-opened after the garbage openFailed") }
        return (true, "garbage path openFailed(\(reason)); helper proven alive by a fresh close+reopen of gate.odt")
    }

    // MARK: Drill 3 — tile arrival: non-blank hash, stable across evict-and-resubscribe

    private func performTileCold3() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsx is not open — drill 2 must run first")
        }
        tile3DocId = doc.docId
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        guard !keys.isEmpty else { return (false, "gate.xlsx covers zero tiles at 100%") }
        // PERF NOTE (recorded, not gated): the dispatch asks for cold-fill feel vs. the ~26-28ms/tile
        // paint reality named in earlier tasks' own measurements — this is that number, computed from
        // this exact run rather than assumed.
        let fillStart = Date()
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) {
            keys.allSatisfy { self.runtime.tileStore.tile(docId: self.tile3DocId, key: $0) != nil }
        }
        let fillElapsedMs = Date().timeIntervalSince(fillStart) * 1000
        guard filled else { return (false, "cold fill never completed for \(keys.count) tile(s)") }
        guard let entry = runtime.tileStore.tile(docId: tile3DocId, key: tile3Key) else { return (false, "tile (0,0) missing after fill") }
        guard entry.pixels.count == TileMath.bytesPerTile else { return (false, "wrong byte count: \(entry.pixels.count)") }
        guard entry.pixels.contains(where: { $0 != 0 }) else { return (false, "tile (0,0) is entirely zero — a blank paint") }
        tile3FirstHash = Self.sha256Hex(entry.pixels)
        let msPerTile = fillElapsedMs / Double(keys.count)
        return (true, "cold-filled \(keys.count) tile(s) in \(Int(fillElapsedMs))ms "
                     + "(\(String(format: "%.1f", msPerTile))ms/tile — PERF NOTE, not a gate); "
                     + "tile (0,0) non-blank, sha256=\(tile3FirstHash)")
    }

    private func performTileEvict3() async -> (Bool, String) {
        guard !tile3DocId.isEmpty else { return (false, "3.cold must run first") }
        runtime.tileStore.evictAll(docId: tile3DocId)
        guard runtime.tileStore.tile(docId: tile3DocId, key: tile3Key) == nil else {
            return (false, "tile still cached after evictAll — the next fill would be a cache hit, not a real repaint")
        }
        return (true, "tile store evicted for docId \(tile3DocId)")
    }

    /// **A real repaint pin, not a cache-hit tautology.** Through the product path a resubscribe
    /// never re-requests an already-cached key (`OfficeTileStore.keysNeedingRequest`'s own filter),
    /// so asking again without first evicting would only prove the store returns its own bytes.
    /// `3.evict` exists precisely so this step has to ask LOK to paint tile (0,0) again for real.
    private func performTileResubscribe3() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"] else { return (false, "no gate.xlsx path") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) { self.runtime.tileStore.tile(docId: self.tile3DocId, key: self.tile3Key) != nil }
        guard filled else { return (false, "the re-fill after eviction never completed") }
        guard let entry = runtime.tileStore.tile(docId: tile3DocId, key: tile3Key) else { return (false, "tile vanished again") }
        let hash = Self.sha256Hex(entry.pixels)
        guard hash == tile3FirstHash else {
            return (false, "repaint sha256 \(hash) != the cold-fill hash \(tile3FirstHash) — NOT stable across a genuine repaint")
        }
        return (true, "repaint sha256 \(hash) is byte-identical to the cold-fill hash — a real re-paint, stable")
    }

    // MARK: Drill 4 — the alpha-byte scan

    /// **premultipliedLast means alpha is byte offset 3 of every 4-byte RGBA pixel** (`OfficeTile
    /// CanvasView.makeCGImage`'s own `CGImageAlphaInfo.premultipliedLast` — the T6 review's own
    /// "alpha semantics UNANSWERABLE in-repo" question this drill answers empirically). Scans every
    /// currently-cached tile for gate.xlsx's docId, not merely tile (0,0), for a broader sample.
    private func performAlphaScan4() async -> (Bool, String) {
        guard !tile3DocId.isEmpty else { return (false, "3.cold must run first to have real tiles cached") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        var scannedTiles = 0
        var totalAlphaBytes = 0
        var nonOpaqueCount = 0
        for key in keys {
            guard let entry = runtime.tileStore.tile(docId: tile3DocId, key: key) else { continue }
            scannedTiles += 1
            let bytes = entry.pixels
            var offset = bytes.startIndex + 3
            while offset < bytes.endIndex {
                totalAlphaBytes += 1
                if bytes[offset] != 255 { nonOpaqueCount += 1 }
                offset += 4
            }
        }
        guard scannedTiles > 0 else { return (false, "no cached tiles to scan — drill 3 must have populated some") }
        if nonOpaqueCount == 0 {
            return (true, "ALPHA VERDICT: \(totalAlphaBytes) alpha byte(s) across \(scannedTiles) tile(s), ALL "
                         + "255 — premultiplied-vs-straight is EMPIRICALLY MOOT for this content (every "
                         + "sampled tile is fully opaque)")
        }
        return (true, "ALPHA VERDICT: \(nonOpaqueCount)/\(totalAlphaBytes) alpha byte(s) across \(scannedTiles) "
                     + "tile(s) are NOT 255 — CGImage's .premultipliedLast alphaInfo and the DeviceRGB "
                     + "colorspace are now LOAD-BEARING, not incidental (flagged, not just noted)")
    }

    // MARK: Drill 5 — the multi-sheet fixture, templated at drill time

    private func performMultiBuild5() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t9-multisheet.fods").path
        do {
            try officeHarnessMultiSheetFodsContent().write(toFile: path, atomically: true, encoding: .utf8)
        } catch {
            return (false, "could not write the templated fixture: \(error)")
        }
        multiSheetPath = path
        return (true, "templated two-sheet fods at \(path) (no soffice CLI exists in the vendor tree to convert with)")
    }

    private func performMultiOpen5() async -> (Bool, String) {
        guard !multiSheetPath.isEmpty else { return (false, "5.build must run first") }
        runtime.open(multiSheetPath)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[self.multiSheetPath] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled else { return (false, "the templated fixture never settled — phase \(runtime.stateSnapshot.phase)") }
        guard let doc = runtime.stateSnapshot.documents[multiSheetPath] else {
            return (false, "the templated fixture did not open: \(runtime.stateSnapshot.openFailures[multiSheetPath] ?? "?")")
        }
        multiSheetDocId = doc.docId
        guard doc.parts == 2 else { return (false, "parts == \(doc.parts), expected 2 — the template did not carry through") }
        return (true, "opened; docId=\(doc.docId); parts=2; type=\(doc.type)")
    }

    private func performMultiPart0Fifth() async -> (Bool, String) {
        guard !multiSheetDocId.isEmpty else { return (false, "5.open must run first") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: multiSheetPath, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 15) { self.runtime.tileStore.tile(docId: self.multiSheetDocId, key: key) != nil }
        guard filled else { return (false, "part 0's tile (0,0) never arrived") }
        multiPart0Pixels = runtime.tileStore.tile(docId: multiSheetDocId, key: key)?.pixels
        return (true, "part 0 filled")
    }

    private func performMultiPart1Fifth() async -> (Bool, String) {
        guard !multiSheetDocId.isEmpty else { return (false, "5.open must run first") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let key = TileKey(part: 1, zoomPPT: 1000, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: multiSheetPath, part: 1, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 15) { self.runtime.tileStore.tile(docId: self.multiSheetDocId, key: key) != nil }
        guard filled else { return (false, "part 1's tile (0,0) never arrived") }
        guard runtime.stateSnapshot.documents[multiSheetPath]?.activePart == 1 else {
            return (false, "activePart did not update to 1 after subscribeRequested(part: 1, ...)")
        }
        return (true, "part 1 filled against real LOK; activePart == 1")
    }

    private func performMultiDistinct5() async -> (Bool, String) {
        guard let part0 = multiPart0Pixels else { return (false, "5.part0 never captured pixels") }
        let key1 = TileKey(part: 1, zoomPPT: 1000, tileX: 0, tileY: 0)
        guard let part1 = runtime.tileStore.tile(docId: multiSheetDocId, key: key1)?.pixels else {
            return (false, "part 1's pixels are gone from the store")
        }
        guard part0 != part1 else {
            return (false, "part 1's tile is BYTE-IDENTICAL to part 0's at the same coordinates — not a real cross-part switch")
        }
        let doc = runtime.stateSnapshot.documents[multiSheetPath]
        let sizeNote = doc.map { "\($0.sizeTwips.widthTwips)x\($0.sizeTwips.heightTwips)" } ?? "unknown"
        return (true, "part 1 pixel-DISTINCT from part 0 at tile (0,0). DISCLOSED: Stage A's wire reports "
                     + "sizeTwips ONCE at open time (LOKBridge's getDocumentSize, before any part switch) — "
                     + "there is no per-part size query on this protocol (TileRenderer passes `nPart` "
                     + "directly to paintPartTile, never through a re-query of document size); the whole-"
                     + "document value is \(sizeNote), not per-part. activePart is client-side viewport "
                     + "bookkeeping only, fed by subscribeRequested, never by a per-part LOK size query.")
    }

    // MARK: Drill 6 — external change on gate.xlsx: silent reload, delete banner, restore clears it

    private func performOverwrite6() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsx is not open")
        }
        doc6OriginalDocId = doc.docId
        do {
            try Self.makeModifiedXlsxInPlace(at: URL(fileURLWithPath: path), workDir: zipSurgeryScratchDir)
        } catch {
            return (false, "could not overwrite gate.xlsx: \(error)")
        }
        return (true, "gate.xlsx scratch copy overwritten with different, valid content (docId before: \(doc6OriginalDocId))")
    }

    private func performReload6() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], !doc6OriginalDocId.isEmpty else { return (false, "6.overwrite must run first") }
        let reloaded = await waitUntil(timeout: 25) {
            guard let doc = self.runtime.stateSnapshot.documents[path] else { return false }
            return doc.docId != self.doc6OriginalDocId
        }
        guard reloaded else { return (false, "no new docId within budget") }
        doc6NewDocId = runtime.stateSnapshot.documents[path]?.docId ?? ""
        return (true, "reloaded silently: \(doc6OriginalDocId) -> \(doc6NewDocId)")
    }

    private func performFreshTiles6() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], !doc6NewDocId.isEmpty else { return (false, "6.reload must run first") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport)
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) {
            keys.allSatisfy { self.runtime.tileStore.tile(docId: self.doc6NewDocId, key: $0) != nil }
        }
        guard filled else { return (false, "fresh tiles never arrived under the new docId") }
        let nonBlank = keys.allSatisfy { key in
            guard let entry = self.runtime.tileStore.tile(docId: self.doc6NewDocId, key: key) else { return false }
            return entry.pixels.contains { $0 != 0 }
        }
        guard nonBlank else { return (false, "some fresh tiles under the new docId are blank") }
        return (true, "\(keys.count) fresh non-blank tile(s) under the new docId \(doc6NewDocId)")
    }

    private func performDelete6() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"] else { return (false, "no gate.xlsx path") }
        do { try FileManager.default.removeItem(atPath: path) } catch { return (false, "delete failed: \(error)") }
        let bannered = await waitUntil(timeout: 10) { self.runtime.stateSnapshot.documentBanners[path] != nil }
        guard bannered else { return (false, "no banner appeared after delete") }
        let banner = runtime.stateSnapshot.documentBanners[path] ?? ""
        guard banner == "File was deleted on disk" else { return (false, "unexpected banner text: \(banner)") }
        return (true, "banner: \"\(banner)\"")
    }

    private func performRestore6() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"] else { return (false, "no gate.xlsx path") }
        do {
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.xlsx"),
                                             to: URL(fileURLWithPath: path))
        } catch {
            return (false, "restore copy failed: \(error)")
        }
        let cleared = await waitUntil(timeout: 25) { self.runtime.stateSnapshot.documentBanners[path] == nil }
        guard cleared else { return (false, "banner never cleared after the file came back") }
        guard let doc = runtime.stateSnapshot.documents[path] else { return (false, "document entry gone after restore") }
        return (true, "banner cleared; docId now \(doc.docId)")
    }

    // MARK: Drill 7 — the mirror-case, on gate.odt: overwrite then delete inside the reload round trip

    private func performOverwrite7() async -> (Bool, String) {
        guard let path = fixturePaths["gate.odt"], runtime.stateSnapshot.documents[path] != nil else {
            return (false, "gate.odt is not open")
        }
        doc7Path = path
        do {
            try Self.makeModifiedOdtInPlace(at: URL(fileURLWithPath: path), workDir: zipSurgeryScratchDir)
        } catch {
            return (false, "could not overwrite gate.odt: \(error)")
        }
        return (true, "gate.odt scratch copy overwritten")
    }

    private func performDelayedDelete7() async -> (Bool, String) {
        guard !doc7Path.isEmpty else { return (false, "7.overwrite must run first") }
        try? await Task.sleep(nanoseconds: 700_000_000) // ~0.7s — inside the reload round trip, on purpose
        do { try FileManager.default.removeItem(atPath: doc7Path) } catch { return (false, "delete failed: \(error)") }
        return (true, "deleted ~0.7s after the overwrite, while the reopen may still be in flight")
    }

    /// **Documents the interleaving; does not fix it.** Three outcomes are all legitimate, per this
    /// task's own brief and `OfficeRuntime.swift`'s `documentBanners` header (the T8 ruling this
    /// drill exercises): the reopen's `.opened` can land after the delete (clearing the banner over
    /// content that is, at that instant, actually gone), the delete's `.externalDeleted` can land
    /// after the reopen (the ordinary post-reload delete case), or the delete can land BEFORE LOK's
    /// `open()` ever reads the file (the reopen fails outright). This step records whichever happened
    /// as a definite observation rather than asserting one is "the" right answer.
    private func performObserve7() async -> (Bool, String) {
        guard !doc7Path.isEmpty else { return (false, "7.delayedDelete must run first") }
        try? await Task.sleep(nanoseconds: 3_000_000_000) // a bounded settle window, not a wait for one outcome
        let hasDocument = runtime.stateSnapshot.documents[doc7Path] != nil
        let banner = runtime.stateSnapshot.documentBanners[doc7Path]
        let openFailure = runtime.stateSnapshot.openFailures[doc7Path]
        let verdict: String
        if hasDocument, banner == nil {
            verdict = "BRANCH A (reload won, no banner) — the in-flight reopen's .opened landed AFTER "
                    + "the delete-fire's .externalDeleted, clearing the banner along with everything "
                    + "else .opened resets. Content shows for a file that is, at this instant, actually "
                    + "gone — the quiescent-directory window the brief names."
        } else if hasDocument, banner != nil {
            verdict = "BRANCH B (banner persisted) — the delete-fire's .externalDeleted landed AFTER "
                    + "the reopen's own .opened; the ordinary post-reload delete case applied."
        } else if !hasDocument, openFailure != nil {
            verdict = "BRANCH C (reopen failed) — the delete landed before LOK's open() could read the "
                    + "file; the in-flight reopen failed via .reloadFailed (openFailures set, the "
                    + "banner cleared by that arm's own post-review fix, c277793a)."
        } else {
            verdict = "UNRECOGNIZED state — hasDocument=\(hasDocument) banner=\(banner ?? "nil") "
                    + "openFailure=\(openFailure ?? "nil")"
        }
        notes.append("7.observe (the mirror-case drill): \(verdict)")
        return (true, verdict)
    }

    private func performSiblingTouch7() async -> (Bool, String) {
        guard !doc7Path.isEmpty else { return (false, "7.observe must run first") }
        guard runtime.stateSnapshot.documents[doc7Path] != nil else {
            return (true, "SKIPPED — branch C (reopen failed) left no document behind to banner over; "
                         + "this leg only applies when a document survived the interleaving")
        }
        let siblingPath = fixturesScratchDir.appendingPathComponent("t9-mirror-sibling-\(UUID().uuidString.prefix(6)).txt").path
        do { try "sibling touch".write(toFile: siblingPath, atomically: true, encoding: .utf8) }
        catch { return (false, "could not write the sibling file: \(error)") }
        let bannered = await waitUntil(timeout: 12) { self.runtime.stateSnapshot.documentBanners[self.doc7Path] != nil }
        guard bannered else { return (false, "the sibling touch never re-fired the deleted-file banner") }
        return (true, "a sibling-file touch re-fired the directory watcher; banner: "
                     + "\"\(runtime.stateSnapshot.documentBanners[doc7Path] ?? "?")\"")
    }

    // MARK: Drill 8 — helper SIGKILL, .helperDied, tab failure state, reopen recovers

    private func performCapturePid8() async -> (Bool, String) {
        guard let pid = host.officeHelperSupervisor?.process?.processIdentifier else {
            return (false, "no live supervisor process to capture a pid from")
        }
        pid8Before = pid
        return (true, "captured shared-helper pid \(pid)")
    }

    private func performKill8() async -> (Bool, String) {
        guard pid8Before != 0 else { return (false, "8.capturePid must run first") }
        kill(pid8Before, SIGKILL)
        return (true, "SIGKILL sent to pid \(pid8Before) directly — never supervisor.stop() (which bumps "
                     + "generation FIRST and would suppress the .helperDied signal this drill needs to observe)")
    }

    private func performDied8() async -> (Bool, String) {
        let died = await waitUntil(timeout: 12) { self.runtime.stateSnapshot.phase == .failed }
        guard died else { return (false, "the runtime never observed .helperDied — phase stayed \(runtime.stateSnapshot.phase)") }
        guard runtime.stateSnapshot.documents.isEmpty else {
            return (false, "documents dict was not cleared: \(runtime.stateSnapshot.documents.keys.sorted())")
        }
        guard let reason = runtime.stateSnapshot.failureReason else { return (false, "no failureReason recorded") }
        // DISCLOSED, not a T9 defect: `.helperDied`'s handler clears `documents` but never stops the
        // imperative-half file watchers those documents had open (`OfficeRuntime.swift`'s own
        // `watchers` dict) — they leak until `teardown()`, harmlessly no-op'ing against a docId the
        // reducer no longer knows about in the meantime. This drill exercises exactly that state.
        notes.append("8.diedObserved: file watchers for the documents open at kill time are not stopped "
                    + "by .helperDied (only teardown() stops them) — they leak harmlessly until this run's "
                    + "own teardown; not a regression this task introduces, recorded for visibility")
        return (true, "phase == .failed; every open document cleared; failureReason: \"\(reason)\"")
    }

    /// **The retry affordance path, driven the way it is really driven**: `PanelDocumentTabModel
    /// .retryOpen()` (`PanelDocumentTab.swift:300`) is exactly `runtime.open(path)` — `.failed` never
    /// self-recovers on its own (T5's own carry), the re-open is the tab's job, and this is that job.
    private func performReopen8() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"] else { return (false, "no gate.xlsx path") }
        let start = Date()
        runtime.open(path)
        let recovered = await waitUntil(timeout: 5.0) { self.runtime.stateSnapshot.documents[path] != nil }
        let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
        guard recovered else {
            return (false, "reopen did not recover documents[path] within the 5.0s bound (measured \(elapsedMs) ms)")
        }
        return (true, "recovered in \(elapsedMs) ms (bound: 5000 ms)")
    }

    private func performNewPid8() async -> (Bool, String) {
        guard let newPid = host.officeHelperSupervisor?.process?.processIdentifier else {
            return (false, "no live supervisor process after reopen")
        }
        guard newPid != pid8Before else {
            return (false, "the pid is UNCHANGED (\(newPid)) — the kill did not actually respawn a new process")
        }
        return (true, "old pid \(pid8Before) -> new pid \(newPid) — a genuine respawn, not a survivor")
    }

    // MARK: Drill 9 — scroll/zoom viewport churn (reuses gate.xlsx, freshly reopened by drill 8)

    private func performRapidScroll9() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsx is not open — drill 8 must have reopened it")
        }
        let docId = doc.docId
        let zoomPPT = 1000
        var lastKeys: [TileKey] = []
        for step in 0..<8 {
            let origin = CGPoint(x: 0, y: Double(step) * 300)
            let viewport = officeViewportTwips(scrollOrigin: origin, visibleSize: CGSize(width: 400, height: 400), zoomPPT: zoomPPT)
            lastKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            runtime.subscribeTiles(path: path, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            try? await Task.sleep(nanoseconds: 40_000_000) // faster than a cold fill settles — during-reload scroll (N2)
        }
        let inFlightNow = runtime.tileStore.inFlightCountForTesting
        guard inFlightNow <= 256 else { return (false, "in-flight tile count \(inFlightNow) — unbounded churn") }
        let settled = await waitUntil(timeout: 15) {
            lastKeys.allSatisfy { self.runtime.tileStore.tile(docId: docId, key: $0) != nil }
        }
        guard settled else { return (false, "the final viewport in the scroll storm never settled") }
        return (true, "8 rapid viewport asks during a cold fill; peak in-flight \(inFlightNow); the final "
                     + "viewport settled cleanly — no crash, bounded churn")
    }

    private func performZoomStep9() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsx is not open")
        }
        let docId = doc.docId
        var evidence: [String] = []
        for zoomPPT in [1000, 1500, 2000] {
            let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 300, height: 300), zoomPPT: zoomPPT)
            let keys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            guard !keys.isEmpty else { return (false, "zoom \(zoomPPT): computed zero tile keys") }
            let start = Date()
            runtime.subscribeTiles(path: path, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            let filled = await waitUntil(timeout: 15) { keys.allSatisfy { self.runtime.tileStore.tile(docId: docId, key: $0) != nil } }
            guard filled else { return (false, "zoom \(zoomPPT): \(keys.count) tile(s) never arrived") }
            evidence.append("\(zoomPPT / 10)%=\(Int(Date().timeIntervalSince(start) * 1000))ms")
        }
        return (true, "zoom ladder re-requested and settled correctly: \(evidence.joined(separator: ", "))")
    }

    // MARK: Drill 10 — idle-exit on a DEDICATED helper, production 120s default

    private func performSetup10() async -> (Bool, String) {
        let helperURL = OfficeHelperSupervisor.Configuration.production().helperExecutableURL
        guard FileManager.default.fileExists(atPath: helperURL.path) else {
            return (false, "NormaOfficeHelper not embedded at \(helperURL.path)")
        }
        let stateDir = throwawayHelper10StateDir
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        try? FileManager.default.removeItem(atPath: socketPath)
        let token = "office-harness-t10-\(UUID().uuidString.prefix(8))"

        let process = Process()
        process.executableURL = helperURL
        // Deliberately NO --idle-exit-seconds override — the production 120s default is exactly the
        // T2 semantics this drill exists to prove.
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path, "--token", token]
        do { try process.run() } catch { return (false, "spawn failed: \(error)") }
        dedicatedProcess10 = process

        let appeared = await waitUntil(timeout: 35) { FileManager.default.fileExists(atPath: socketPath) }
        guard appeared else { return (false, "socket never appeared") }

        let connection = OfficeWireConnection(socketPath: socketPath)
        do { try await connection.open() } catch { return (false, "connect failed: \(error)") }
        do { try await connection.send(.hello(seq: 1, role: .app, token: token)) } catch { return (false, "hello failed: \(error)") }
        guard let reply = await connection.nextFrame(timeout: 5.0), case .helloOk = reply else {
            return (false, "no helloOk from the dedicated idle-exit helper")
        }
        dedicatedConnection10 = connection
        dedicatedClient10 = OfficeHelperClient(connection: connection, seqAllocator: OfficeWireSeqAllocator(), requestTimeout: 30.0)
        return (true, "dedicated helper booted — production 120s idle-exit default in effect")
    }

    private func performOpenClose10() async -> (Bool, String) {
        guard let client = dedicatedClient10 else { return (false, "10.setup must run first") }
        guard let path = fixturePaths["gate.docx"] else { return (false, "no gate.docx scratch copy") }
        let docId = UUID().uuidString
        do {
            let metadata = try await client.open(docId: docId, path: path)
            guard metadata.type == .text else { return (false, "unexpected type \(metadata.type)") }
            try await client.close(docId: docId)
        } catch {
            return (false, "open/close on the dedicated helper failed: \(error)")
        }
        return (true, "opened then closed a real document on the dedicated helper")
    }

    private func performDisconnect10() async -> (Bool, String) {
        guard let connection = dedicatedConnection10 else { return (false, "10.setup must run first") }
        connection.close()
        dedicatedConnection10 = nil
        dedicatedClient10 = nil
        return (true, "connection closed cleanly — never a kill; idle-exit needs zero documents AND zero connections")
    }

    private func performWaitExit10() async -> (Bool, String) {
        guard let process = dedicatedProcess10 else { return (false, "10.setup must run first") }
        let start = Date()
        let exited = await waitUntil(timeout: 150) { !process.isRunning }
        let elapsedSeconds = Int(Date().timeIntervalSince(start))
        dedicatedProcess10 = nil
        guard exited else { return (false, "did not idle-exit within 150s (120s production default + 30s slack)") }
        return (true, "idle-exited after \(elapsedSeconds)s (bound: 120s + slack)")
    }

    // MARK: Drill 11 — second-copy hygiene

    private func performStatePaths11() async -> (Bool, String) {
        let roots = [scratchRoot, fixturesScratchDir, sharedSupervisorStateDir, throwawayHelper1StateDir,
                     throwawayHelper10StateDir, zipSurgeryScratchDir]
        for root in roots {
            guard root.path.hasPrefix(scratchRoot.path) else {
                return (false, "\(root.path) is not under the harness's own scratch root \(scratchRoot.path)")
            }
            guard !root.path.contains(".norma") else { return (false, "\(root.path) touches a .norma path — collision risk") }
        }
        return (true, "every scratch socket/state path used this run lives under \(scratchRoot.path); "
                     + "none touch ~/.norma or ~/.norma-dev")
    }

    private func performUserCachesUntouched11() async -> (Bool, String) {
        let realOfficeDir = OfficeHelperSupervisor.Configuration.defaultStateDirectory()
        let after = (try? FileManager.default.contentsOfDirectory(atPath: realOfficeDir.path).sorted()) ?? []
        guard after == userOfficeDirListingBeforeRun else {
            return (false, "the real Application Support Office directory's listing CHANGED during this run — "
                          + "before=\(userOfficeDirListingBeforeRun) after=\(after)")
        }
        return (true, "the real Application Support Office directory (\(realOfficeDir.path)) is untouched — "
                     + "listing unchanged (\(after.count) entrie(s), before and after)")
    }

    /// Cannot assert the regular-app set is EMPTY — any real machine already has Finder, Xcode, a
    /// browser, etc. running with `.regular` activation policy, and this harness's own host app may
    /// itself be `.regular` depending on when `DockPolicy.apply` ran. The drill's actual claim is
    /// narrower: this run's own activity (opening six documents, spawning three NormaOfficeHelper
    /// processes, killing one) creates no NEW Dock-visible entry — diff against the `0.setup`
    /// baseline, don't assert emptiness against it.
    private func performNoDockPresence11() async -> (Bool, String) {
        let regularAppsNow = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let newOnes = regularAppsNow.filter { !regularAppPidsBeforeRun.contains($0.processIdentifier) }
        guard newOnes.isEmpty else {
            return (false, "new Dock-visible app(s) appeared during this run: "
                          + "\(newOnes.map { "\($0.bundleIdentifier ?? "?") (pid \($0.processIdentifier))" })")
        }
        return (true, "no NEW Dock-visible app appeared during this run — every NormaOfficeHelper this run "
                     + "spawned is a bare `type: tool` product, never a nested .app bundle, and gets no Dock "
                     + "icon of its own (\(regularAppsNow.count) regular-activation-policy app(s) total, "
                     + "\(regularAppPidsBeforeRun.count) of them already present at 0.setup's own baseline)")
    }

    // MARK: Drill 12 — wire sanity

    private func performKindWire12() async -> (Bool, String) {
        guard PanelTabKind.document.rawValue == "document" else {
            return (false, "PanelTabKind.document.rawValue == \"\(PanelTabKind.document.rawValue)\", expected \"document\"")
        }
        return (true, "PanelTabKind.document.rawValue == \"document\"")
    }

    private func performRouter12() async -> (Bool, String) {
        for ext in Self.sixFixtureNames.map({ ($0 as NSString).pathExtension }) {
            let kind = panelTabKind(forFilePath: "/tmp/office-harness-probe.\(ext)")
            guard kind == .document else { return (false, "\(ext) classified as \(kind), not .document") }
        }
        return (true, "all six office extensions (xlsx/ods/pptx/odp/docx/odt) classify as .document "
                     + "via panelTabKind(forFilePath:)")
    }

    /// **This harness is daemonless BY CONSTRUCTION** — it runs INSTEAD of `boot()` (this file's own
    /// header, constraint 2), the same posture `EditorBridgeHarness.start()` already established for
    /// the editor's own drill. `ShellSessionHost.openPanelTab` requires `managementClient`
    /// (`guard let client = managementClient else { return }`) — a live daemon connection this run
    /// never establishes, so a genuine `panel.openTab` round trip cannot execute from here. The wire
    /// shape is pinned via the codec instead: `12.kindWire` (the Swift-side literal) and `12.router`
    /// (the classifier every real door already routes through) together, plus the cross-language
    /// literal-parity pin in `OfficeHarnessScriptTests` that reads `packages/protocol/src/events.ts`'s
    /// `PanelTabKind` enum directly — the brief's own named escape hatch for this exact situation.
    private func performDaemonless12() async -> (Bool, String) {
        return (true, "daemonless by construction (never calls boot(), never wires managementClient) — "
                     + "the wire shape is pinned via the codec (12.kindWire + 12.router here, the "
                     + "cross-language parity pin in OfficeHarnessScriptTests), not a live panel.openTab")
    }

    // MARK: - Shared helpers

    private static let sixFixtureNames = ["gate.xlsx", "gate.ods", "gate.pptx", "gate.odp", "gate.docx", "gate.odt"]

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Sources/AppShell/OfficeHarness.swift` —
    /// five `deletingLastPathComponent()` hops (the filename, AppShell, Sources, Norma, apple) reach
    /// `<repoRoot>`, the same climbing depth `OfficeHelperLiveTests`/`OfficeRuntimeLiveTests` already
    /// use from their own, differently-named-but-equally-deep location.
    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var committedFixturesRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/Tests/NormaAppTests/Fixtures/office", isDirectory: true)
    }
    private static var versionPinURL: URL {
        repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/VERSION-PIN")
    }
    private static var versionPinBuildId: String? {
        guard let content = try? String(contentsOf: versionPinURL, encoding: .utf8) else { return nil }
        for line in content.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("LIBREOFFICE_CORE_COMMIT=") {
                return String(line.dropFirst("LIBREOFFICE_CORE_COMMIT=".count))
            }
        }
        return nil
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The T8-proven recipe (`OfficeRuntimeLiveTests.makeModifiedXlsx`), reused verbatim — INCLUDING
    /// the part T8 was careful about and this file's first draft was not: `workDir` MUST be a
    /// directory the file-watcher does not observe, and the rebuilt archive is written to a SEPARATE
    /// temp path there, never directly at `fileURL`. `zip -r` running for real (not instantaneous) AT
    /// the watched path would let the debounced watcher's directory listing catch it mid-write — stat
    /// succeeds on a half-written archive, so `.external` fires, LOK is handed a corrupt zip to
    /// reload, `.reloadFailed` removes `documents[path]` and unwatches it, and the eventually-finished
    /// file is never looked at again. `removeItem` + `copyItem` on an already-complete file is the
    /// only part that touches the watched path, and both are fast, single-syscall-class operations —
    /// the identical two-step swap T8's own `makeModifiedXlsx` already proved safe.
    private static func makeModifiedXlsxInPlace(at fileURL: URL, workDir: URL) throws {
        let extractDir = workDir.appendingPathComponent("xlsx-extract-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runTool("/usr/bin/unzip", ["-o", "-q", fileURL.path, "-d", extractDir.path])

        let sharedStrings = extractDir.appendingPathComponent("xl/sharedStrings.xml")
        let original = try String(contentsOf: sharedStrings, encoding: .utf8)
        let modified = original.replacingOccurrences(of: "NORMA GATE", with: "NORMA GATE T9 RELOADED")
        guard modified != original else {
            throw NSError(domain: "OfficeHarness", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "gate.xlsx's sharedStrings.xml no longer contains \"NORMA GATE\""])
        }
        try modified.write(to: sharedStrings, atomically: true, encoding: .utf8)

        let builtZip = workDir.appendingPathComponent("xlsx-built-\(UUID().uuidString.prefix(8)).xlsx")
        try runTool("/usr/bin/zip", ["-X", "-D", "-r", "-q", builtZip.path, "."], currentDirectory: extractDir)

        try FileManager.default.removeItem(at: fileURL)
        try FileManager.default.copyItem(at: builtZip, to: fileURL)
        try? FileManager.default.removeItem(at: extractDir)
        try? FileManager.default.removeItem(at: builtZip)
    }

    /// The same recipe, generalised to ODT (and carrying the identical off-path-build discipline
    /// `makeModifiedXlsxInPlace`'s own header explains): `content.xml`'s `</office:text>` is a
    /// structural closing tag every non-empty ODF text document carries, so this needs no
    /// foreknowledge of `gate.odt`'s own prose — a fresh paragraph is inserted right before it rather
    /// than depending on a specific marker string being present.
    private static func makeModifiedOdtInPlace(at fileURL: URL, workDir: URL) throws {
        let extractDir = workDir.appendingPathComponent("odt-extract-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runTool("/usr/bin/unzip", ["-o", "-q", fileURL.path, "-d", extractDir.path])

        let contentXML = extractDir.appendingPathComponent("content.xml")
        let original = try String(contentsOf: contentXML, encoding: .utf8)
        guard original.contains("</office:text>") else {
            throw NSError(domain: "OfficeHarness", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "content.xml has no </office:text> to anchor the edit on"])
        }
        let marker = "<text:p>NORMA OFFICE HARNESS MIRROR-CASE MARKER</text:p>"
        let modified = original.replacingOccurrences(of: "</office:text>", with: marker + "</office:text>")
        precondition(modified != original)
        try modified.write(to: contentXML, atomically: true, encoding: .utf8)

        let builtZip = workDir.appendingPathComponent("odt-built-\(UUID().uuidString.prefix(8)).odt")
        try runTool("/usr/bin/zip", ["-X", "-D", "-r", "-q", builtZip.path, "."], currentDirectory: extractDir)

        try FileManager.default.removeItem(at: fileURL)
        try FileManager.default.copyItem(at: builtZip, to: fileURL)
        try? FileManager.default.removeItem(at: extractDir)
        try? FileManager.default.removeItem(at: builtZip)
    }

    private static func runTool(_ launchPath: String, _ arguments: [String], currentDirectory: URL? = nil) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "OfficeHarness", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "\(launchPath) \(arguments) exited \(process.terminationStatus)"])
        }
    }
}
#endif
