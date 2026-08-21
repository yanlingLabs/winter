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
///    doc for why the run never stops on the first red — twenty-six independent claims (drills 0-25,
///    Stage A's 0-12 plus office-editable Task 10's own Stage B 13-25), not one chain.
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
    /// Wave fix (T9 review M4) — every cold-filled tile's hash across the SAME 512x512@100% viewport
    /// `6.freshTiles` re-fills after the overwrite+reload, as a SET (not just tile (0,0)'s single
    /// hash): read by `performFreshTiles6` for the "the hash CHANGES" compare.
    private var tile3AllHashes: Set<String> = []

    // MARK: Drill 5 — the templated multi-sheet fixture

    private var multiSheetPath = ""
    private var multiSheetDocId = ""
    private var multiPart0Pixels: Data?

    // MARK: Drill 6 — external change on gate.xlsx

    private var doc6OriginalDocId = ""
    private var doc6NewDocId = ""

    // MARK: Drill 7 — the mirror-case, on gate.odt

    private var doc7Path = ""
    /// Wave fix (T9 review I1/I2) — the classification `7.observe` computed, read back by
    /// `7.siblingTouch` instead of re-deriving branch membership from fresh state a second time:
    /// one source of truth for "which branch are we in" removes any chance of the two steps
    /// silently disagreeing about it. See `classifyOfficeHarnessMirrorCaseObservation`'s own header.
    private var doc7Observation: OfficeHarnessMirrorCaseObservation?

    // MARK: Drill 8 — SIGKILL + reopen, on the SHARED helper

    private var pid8Before: Int32 = 0

    // MARK: Drill 10 — a SECOND dedicated, throwaway helper (idle-exit needs a clean disconnect door
    // the shared supervisor's `stop()` does not have — it only SIGKILLs — so this drill cannot share
    // drill 1's own throwaway helper either: 1's is torn down by a kill, on purpose, before 2 boots)

    private var dedicatedProcess10: Process?
    private var dedicatedConnection10: OfficeWireConnection?
    private var dedicatedClient10: OfficeHelperClient?

    // MARK: - office-editable Task 10: Stage B drill state

    // Drills 14/15 — typing -> invalidation -> fresh tile, then caret/selection on the SAME doc.
    private var t14DocId = ""
    private var t14BaselineHash = ""
    private let t14Marker = "T10TYPE"

    // Drill 16 — IME composition.
    private var t16DocId = ""

    // Drill 17 — clipboard round-trip.
    private var t17DocId = ""
    private let t17Marker = "COPYME"

    // Drill 18 — undo ladder + redo, then the two-view pair's own pinned undo characterization.
    private var t18DocId = ""
    private let t18Marker = "UNDOME"

    // Drill 19 — Cmd-S round-trip + no-self-reload suppression.
    private var t19DocId = ""
    private var t19PathForSuppression = ""

    // Drill 20 — autosave crash-recovery on a DEDICATED, short-autosave-interval helper (never the
    // shared one — the shared supervisor's config is fixed at 0.setup and every other Stage A/B
    // drill depends on its default cadence).
    private var t20Host: ShellSessionHost?
    private var t20Runtime: OfficeRuntime?
    private var t20Path = ""
    private var t20OriginalDocId = ""
    private var t20HelperPID: Int32 = 0
    private var t20SidecarPath = ""
    private let t20Marker = "SIGKILLPROOF"

    // Drill 22 — formula-bar tracking.
    private var t22DocId = ""
    private var t22FirstCellCursor: OfficeCellCursor?
    private var t22FirstFormulaText: String?

    // Drill 23 — multi-slide nav (two-slide.fodp).
    private var t23DocId = ""
    private var t23Path = ""
    private var t23Slide0Pixels: Data?

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
        // sum of every step's own declared timeout — Stage A's own 46 steps summed ~855s (dominated
        // by drill 10's 150s idle-exit wait); office-editable Task 10 appends 42 more Stage B steps
        // summing ~980s more (now dominated by drill 20's own ~190s crash-recovery cycle, alongside
        // drill 10's pre-existing 150s) — a combined worst-case sum of ~1835s. 2400s (40 minutes) is
        // real headroom over that combined sum, the same "same order of headroom as the addition, not
        // trimmed to fit it" posture the editor harness's own Stage-B bump used, and the posture this
        // file's own prior watchdog bump already established. This is a CEILING, not an expectation —
        // every step's own timeout is itself a worst-case bound a real run rarely approaches.
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.notes.append("the run watchdog fired — the transcript below is what had been "
                              + "measured when it did")
            self.log("WATCHDOG — forcing the transcript out")
            self.finish()
        }
        runWatchdog = watchdog
        DispatchQueue.main.asyncAfter(deadline: .now() + 2400, execute: watchdog)

        Task { await runAllSteps() }
    }

    // MARK: The engine

    /// **Walks `OfficeHarnessPlan.steps` in order, and a failed step records and continues.**
    /// Stopping on the first red would leave every later drill unmeasured — the question this run
    /// exists to answer is which of twenty-six independent claims hold, not whether the first one does.
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

        // office-editable Task 10 — drill 20's own dedicated, short-autosave-interval helper. A
        // failed step anywhere in drill 20 must not leak a live NormaOfficeHelper process behind,
        // same bar as every other dedicated spawn above.
        _ = t20Host?.teardownAllOfficeRuntimesAndStopHelper()
        t20Runtime = nil
        t20Host = nil
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

        case "13.writeInFence": return await performWriteInFence13()
        case "13.writeOutFence": return await performWriteOutFence13()
        case "13.networkDeny": return await performNetworkDeny13()

        case "14.open": return await performOpen14()
        case "14.coldTile": return await performColdTile14()
        case "14.type": return await performType14()
        case "14.freshTile": return await performFreshTile14()

        case "15.caretPresent": return await performCaretPresent15()
        case "15.select": return await performSelect15()
        case "15.selectionPresent": return await performSelectionPresent15()

        case "16.open": return await performOpen16()
        case "16.composeAndCommit": return await performComposeAndCommit16()
        case "16.freshTile": return await performFreshTile16()

        case "17.open": return await performOpen17()
        case "17.typeSelectCopy": return await performTypeSelectCopy17()
        case "17.pasteDoublesOnDisk": return await performPasteDoublesOnDisk17()

        case "18.typeAndSave": return await performTypeAndSave18()
        case "18.undoLadderThenRedo": return await performUndoLadderThenRedo18()
        case "18.twoViewMintAndEditBoth": return await performTwoViewMintAndEditBoth18()
        case "18.twoViewUndoCharacterization": return await performTwoViewUndoCharacterization18()

        case "19.saveRoundTrip": return await performSaveRoundTrip19()
        case "19.noSelfReloadSuppression": return await performNoSelfReloadSuppression19()

        case "20.setup": return await performSetup20()
        case "20.typeDirtyWaitSidecar": return await performTypeDirtyWaitSidecar20()
        case "20.kill": return await performKill20()
        case "20.reopenAndRecoveryOffered": return await performReopenAndRecoveryOffered20()
        case "20.restoreAndSaveLands": return await performRestoreAndSaveLands20()

        case "21.cleanNotGated": return await performCleanNotGated21()
        case "21.dirtyIsGated": return await performDirtyIsGated21()
        case "21.readOnlyFormatNeverGates": return await performReadOnlyFormatNeverGates21()

        case "22.open": return await performOpen22()
        case "22.clickCell": return await performClickCell22()
        case "22.moveTracks": return await performMoveTracks22()

        case "23.open": return await performOpen23()
        case "23.slide0Tile": return await performSlide0Tile23()
        case "23.slide1Distinct": return await performSlide1Distinct23()

        case "24.xlsmOpens": return await performXlsmOpens24()
        case "24.odgOpens": return await performOdgOpens24()
        case "24.cfbRefusal": return await performCFBRefusal24()
        case "24.livenessAfterRefusal": return await performLivenessAfterRefusal24()

        case "25.statePaths": return await performStatePaths25()
        case "25.userCachesUntouched": return await performUserCachesUntouched25()

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
        // Wave fix (T9 review M4) — the full SET of hashes across every tile this viewport covers,
        // not just (0,0): `6.freshTiles`' own compare needs the whole set (see that step's own doc).
        tile3AllHashes = Set(keys.compactMap { runtime.tileStore.tile(docId: self.tile3DocId, key: $0)?.pixels }
            .map { Self.sha256Hex($0) })
        let msPerTile = fillElapsedMs / Double(keys.count)
        return (true, "cold-filled \(keys.count) tile(s) in \(Int(fillElapsedMs))ms "
                     + "(\(String(format: "%.1f", msPerTile))ms/tile — PERF NOTE, not a gate); "
                     + "tile (0,0) non-blank, sha256=\(tile3FirstHash); \(tile3AllHashes.count) distinct "
                     + "hash(es) across \(keys.count) tile(s)")
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

    /// **Wave fix (T9 review M4)**: this used to only check non-blank, never that the paint actually
    /// CHANGED after the overwrite+reload — a stale-cache bug could pass this step for free. The fix
    /// is a SET compare against `3.cold`'s own `tile3AllHashes` (the identical 512x512@100% viewport,
    /// same `keys`), not a single-tile compare: `makeModifiedXlsxInPlace`'s edit lands in
    /// `sharedStrings.xml`, and comparing only tile (0,0) could false-red if that particular string
    /// happens to render outside tile (0,0)'s own bounds — the whole-set compare still changes
    /// because SOME tile in the viewport changed, wherever the edit actually rendered.
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
        let newHashes = Set(keys.compactMap { runtime.tileStore.tile(docId: self.doc6NewDocId, key: $0)?.pixels }
            .map { Self.sha256Hex($0) })
        guard newHashes != tile3AllHashes else {
            return (false, "the fresh tile-hash SET is IDENTICAL to 3.cold's own set (\(tile3AllHashes.count) "
                          + "hash(es)) — the overwrite+reload produced pixel-identical output, which should "
                          + "not happen for genuinely different content")
        }
        return (true, "\(keys.count) fresh non-blank tile(s) under the new docId \(doc6NewDocId); hash SET "
                     + "changed vs 3.cold's own set (\(tile3AllHashes.count) -> \(newHashes.count) distinct "
                     + "hash(es))")
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
        // Wave fix (T9 review M6) — shortened from the original ~0.7s, which gave the reopen's own
        // round trip enough time to always complete first, making BRANCH B (banner persisted) near-
        // deterministic and defeating the point of an honestly-documented race. 120-200ms keeps the
        // delete genuinely contested against the in-flight reopen (randomized within the band so
        // repeated runs are not pinned to one edge of it).
        let delayMs = Int.random(in: 120...200)
        try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
        do { try FileManager.default.removeItem(atPath: doc7Path) } catch { return (false, "delete failed: \(error)") }
        return (true, "deleted ~\(delayMs)ms after the overwrite, while the reopen may still be in flight")
    }

    /// **Documents the interleaving; does not fix it.** Three outcomes are all legitimate, per this
    /// task's own brief and `OfficeRuntime.swift`'s `documentBanners` header (the T8 ruling this
    /// drill exercises): the reopen's `.opened` can land after the delete (clearing the banner over
    /// content that is, at that instant, actually gone), the delete's `.externalDeleted` can land
    /// after the reopen (the ordinary post-reload delete case), or the delete can land BEFORE LOK's
    /// `open()` ever reads the file (the reopen fails outright). This step records whichever happened
    /// as a definite observation rather than asserting one is "the" right answer.
    ///
    /// **Wave fix (T9 review I1)**: the classification itself is `classifyOfficeHarnessMirrorCase
    /// Observation` (`OfficeHarnessScript.swift`, pure, pins-suite tested) — a fourth, UNRECOGNIZED
    /// outcome (no document AND no openFailure) is a state `OfficeRuntimeReducer` should never
    /// produce, not a fourth legitimate race branch, and now fails this step (`recognized == false`)
    /// instead of passing silently. The result is stashed in `doc7Observation` for `7.siblingTouch`
    /// to read back rather than re-derive.
    private func performObserve7() async -> (Bool, String) {
        guard !doc7Path.isEmpty else { return (false, "7.delayedDelete must run first") }
        try? await Task.sleep(nanoseconds: 3_000_000_000) // a bounded settle window, not a wait for one outcome
        let hasDocument = runtime.stateSnapshot.documents[doc7Path] != nil
        let banner = runtime.stateSnapshot.documentBanners[doc7Path]
        let openFailure = runtime.stateSnapshot.openFailures[doc7Path]
        let observation = classifyOfficeHarnessMirrorCaseObservation(
            hasDocument: hasDocument, banner: banner, openFailure: openFailure)
        doc7Observation = observation
        notes.append("7.observe (the mirror-case drill): \(observation.verdict)")
        return (observation.recognized, observation.verdict)
    }

    /// **Wave fix (T9 review I1/I2)**: reads `doc7Observation` (set by `7.observe`, which must have
    /// run first) instead of re-reading `documents`/`documentBanners` fresh — one classification, not
    /// two independent ones that could disagree. Branch C's SKIP keeps its own honest text; the
    /// UNRECOGNIZED/poisoned state gets its OWN SKIP text rather than being mislabeled "branch C"
    /// (I1's own finding); branch B — the banner is ALREADY standing when this step begins — records
    /// the same honest "not applicable" shape branch C's SKIP already gets, instead of a 0ms pass
    /// with an unearned causal claim (I2); branch A alone keeps the real assertion.
    private func performSiblingTouch7() async -> (Bool, String) {
        guard let observation = doc7Observation else { return (false, "7.observe must run first") }
        switch observation.branch {
        case .c:
            return (true, "SKIPPED — branch C (reopen failed) left no document behind to banner over; "
                         + "this leg only applies when a document survived the interleaving")
        case .unrecognized:
            return (true, "SKIPPED — 7.observe recorded its own UNRECOGNIZED/poisoned state (already "
                         + "failed there); this is NOT branch C's honest reopen-failed case and must "
                         + "not be mislabeled as one")
        case .b:
            return (true, "branch B: not applicable — banner pre-existing; watcher-fire not observed "
                         + "(the delete-fire's .externalDeleted already landed before this step began, "
                         + "so writing a sibling file and immediately observing the banner would be a "
                         + "0ms pass that never actually waited for the watcher to fire — not a real "
                         + "causal proof that a sibling touch re-fires anything)")
        case .a:
            let siblingPath = fixturesScratchDir.appendingPathComponent("t9-mirror-sibling-\(UUID().uuidString.prefix(6)).txt").path
            do { try "sibling touch".write(toFile: siblingPath, atomically: true, encoding: .utf8) }
            catch { return (false, "could not write the sibling file: \(error)") }
            let bannered = await waitUntil(timeout: 12) { self.runtime.stateSnapshot.documentBanners[self.doc7Path] != nil }
            guard bannered else { return (false, "branch A: the sibling touch never re-fired the deleted-file banner") }
            return (true, "branch A: a sibling-file touch re-fired the directory watcher; banner: "
                         + "\"\(runtime.stateSnapshot.documentBanners[doc7Path] ?? "?")\"")
        }
    }

    // MARK: Drill 8 — helper SIGKILL, .helperDied, tab failure state, reopen recovers

    /// **Wave fix (T9 review I1)**: `host.officeHelperSupervisor?.process?.processIdentifier` reads a
    /// `Process` object's LAST-KNOWN pid — it does not, on its own, prove that process is still
    /// alive. Without a liveness check, a pre-existing corpse (the shared helper already dead for
    /// some unrelated reason before this drill ever runs) would still hand back a plausible-looking
    /// pid, and `8.kill`'s SIGKILL against it would fail silently (see that step's own fix) — the
    /// drill would then wait for a `.helperDied` that either never arrives or already arrived for a
    /// different reason, misreporting what it actually exercised. `kill(pid, 0)` sends no signal —
    /// it only asks "does this pid exist and am I allowed to signal it" — the standard POSIX
    /// liveness probe.
    private func performCapturePid8() async -> (Bool, String) {
        guard let pid = host.officeHelperSupervisor?.process?.processIdentifier else {
            return (false, "no live supervisor process to capture a pid from")
        }
        guard kill(pid, 0) == 0 else {
            return (false, "pid \(pid) is already dead (kill(pid, 0) != 0, errno \(errno)) — a "
                          + "pre-existing corpse, not a live helper for this drill to kill")
        }
        pid8Before = pid
        return (true, "captured shared-helper pid \(pid) (liveness-checked via kill(pid, 0) == 0)")
    }

    /// **Wave fix (T9 review I1)**: `kill(2)`'s return value was previously discarded — a
    /// pre-existing corpse (one `8.capturePid`'s own new liveness check did not already catch —
    /// e.g. a race between capture and this step) would make `kill()` fail with `ESRCH` and this
    /// step would still report PASS, because nothing ever looked at the result. Checking `== 0`
    /// closes that: this drill cannot go green for a helper that was already gone before the kill.
    private func performKill8() async -> (Bool, String) {
        guard pid8Before != 0 else { return (false, "8.capturePid must run first") }
        let result = kill(pid8Before, SIGKILL)
        guard result == 0 else {
            return (false, "kill(\(pid8Before), SIGKILL) returned \(result) (errno \(errno)) — the "
                          + "process was already gone before this drill could kill it")
        }
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
        // Wave fix (T9 review M8): this used to disclose that `.helperDied` left the imperative-half
        // file watchers running (leaking until `teardown()`). That is no longer true — the reducer's
        // `.helperDied`/`.helperUnavailable` arm now emits `.unwatchFile` for every document that was
        // open at kill time (`OfficeRuntimeReducer.swift`), so this drill's own kill exercises watcher
        // teardown too, not just document/phase clearing. Recorded as a positive assertion instead of
        // a disclosed gap.
        notes.append("8.diedObserved: file watchers for the documents open at kill time ARE stopped by "
                    + ".helperDied (wave fix, T9 review M8) — no watcher leak survives this kill")
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

    /// **Wave fix (T9 review M5)**: "peak in-flight" used to be a SINGLE sample taken once, after the
    /// whole 8-step loop finished — not a peak at all, just wherever the count happened to sit at that
    /// one instant. Now a running max, sampled once per iteration. Still not a continuously-tracked
    /// true peak (`.subscribe`'s own effect marks tiles in-flight from inside an async `Task`, past an
    /// `await` on the helper round trip — `OfficeRuntime.perform`'s `.subscribe` case — so a sample
    /// taken synchronously right after `subscribeTiles()` returns mostly reads what the PREVIOUS
    /// iteration left behind, not this one's own ask): sampled after each 40ms sleep instead, giving
    /// that async work more of a chance to land, and every individual sample is disclosed in the
    /// evidence string rather than presenting the max as an exact measurement.
    private func performRapidScroll9() async -> (Bool, String) {
        guard let path = fixturePaths["gate.xlsx"], let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsx is not open — drill 8 must have reopened it")
        }
        let docId = doc.docId
        let zoomPPT = 1000
        var lastKeys: [TileKey] = []
        var peakInFlight = 0
        var samples: [Int] = []
        for step in 0..<8 {
            let origin = CGPoint(x: 0, y: Double(step) * 300)
            let viewport = officeViewportTwips(scrollOrigin: origin, visibleSize: CGSize(width: 400, height: 400), zoomPPT: zoomPPT)
            lastKeys = TileMath.viewportTileKeys(part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            runtime.subscribeTiles(path: path, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
            try? await Task.sleep(nanoseconds: 40_000_000) // faster than a cold fill settles — during-reload scroll (N2)
            let sample = runtime.tileStore.inFlightCountForTesting
            samples.append(sample)
            peakInFlight = max(peakInFlight, sample)
        }
        guard peakInFlight <= 256 else { return (false, "peak in-flight tile count \(peakInFlight) — unbounded churn") }
        let settled = await waitUntil(timeout: 15) {
            lastKeys.allSatisfy { self.runtime.tileStore.tile(docId: docId, key: $0) != nil }
        }
        guard settled else { return (false, "the final viewport in the scroll storm never settled") }
        return (true, "8 rapid viewport asks during a cold fill; peak in-flight \(peakInFlight) (max of 8 "
                     + "samples taken ~40ms after each ask, not a continuously-tracked true peak — "
                     + "samples: \(samples)); the final viewport settled cleanly — no crash, bounded churn")
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

    /// **Wave fix (T9 review M3)**: the loop below checked every root against a prefix built FROM
    /// `scratchRoot` itself (`root.path.hasPrefix(scratchRoot.path)`) — for every root this file's
    /// own `init` constructs by appending a path component to `scratchRoot`, that is a tautology, true
    /// by string construction with no live process or socket involved at all. What actually proves
    /// this run's own supervisor lives where it claims is a real, existing `office.sock` under
    /// `sharedSupervisorStateDir` — the shared helper's socket, live for the whole run since `0.setup`.
    private func performStatePaths11() async -> (Bool, String) {
        let roots = [scratchRoot, fixturesScratchDir, sharedSupervisorStateDir, throwawayHelper1StateDir,
                     throwawayHelper10StateDir, zipSurgeryScratchDir]
        for root in roots {
            guard root.path.hasPrefix(scratchRoot.path) else {
                return (false, "\(root.path) is not under the harness's own scratch root \(scratchRoot.path)")
            }
            guard !root.path.contains(".norma") else { return (false, "\(root.path) touches a .norma path — collision risk") }
        }
        let sharedSocketPath = sharedSupervisorStateDir.appendingPathComponent("office.sock").path
        guard FileManager.default.fileExists(atPath: sharedSocketPath) else {
            return (false, "the shared supervisor's own office.sock does not exist at \(sharedSocketPath) "
                          + "— the path-prefix checks above are true of any string, live or not; this is "
                          + "the one check that proves a REAL socket lives under this run's own root")
        }
        return (true, "every scratch socket/state path used this run lives under \(scratchRoot.path); "
                     + "none touch ~/.norma or ~/.norma-dev; office.sock genuinely exists at \(sharedSocketPath)")
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

    // MARK: - office-editable Task 10: Stage B drills 13-25

    // MARK: Drill 13 — sandbox probes (write-fence + network-deny), live against the embedded helper

    private func performWriteInFence13() async -> (Bool, String) {
        guard let (output, _) = await runSandboxProbe(kind: "write-inside-fence") else {
            return (false, "the write-inside-fence probe never exited, or NormaOfficeHelper is not embedded")
        }
        guard output.contains("PROBE_RESULT: write-inside-fence ok") else {
            return (false, "expected ok (sanity control: deny default must not deny EVERYTHING) — got: \(output)")
        }
        return (true, "a write under --state-path succeeds: \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
    }

    private func performWriteOutFence13() async -> (Bool, String) {
        let outsideDir = scratchRoot.appendingPathComponent("t13-outside-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: outsideDir, withIntermediateDirectories: true)
        guard let (output, _) = await runSandboxProbe(kind: "write-outside-fence", outsideDir: outsideDir) else {
            return (false, "the write-outside-fence probe never exited, or NormaOfficeHelper is not embedded")
        }
        guard output.contains("PROBE_RESULT: write-outside-fence denied") else {
            return (false, "expected denied — got: \(output)")
        }
        // Anchored errno check (T1 review's own fix round 1 lesson, task-1-report.md's fix-round
        // section: an UNANCHORED "errno=1" substring also matches errno=10..19 — EACCES=13 the
        // realistic collider on a real filesystem). Parsed and compared BY VALUE, never by substring.
        guard let errnoValue = Self.trailingErrno(output), errnoValue == EPERM else {
            return (false, "expected the sandbox's own EPERM (\(EPERM)), parsed errno was "
                          + "\(Self.trailingErrno(output).map(String.init) ?? "unparseable") — got: \(output)")
        }
        let siblings = (try? FileManager.default.contentsOfDirectory(atPath: outsideDir.path)) ?? []
        guard siblings.isEmpty else { return (false, "the denied write left a file behind: \(siblings)") }
        return (true, "write outside --state-path denied, errno=\(errnoValue) (EPERM, anchored-by-value, "
                     + "never a bare substring match), no file left behind")
    }

    private func performNetworkDeny13() async -> (Bool, String) {
        guard let (output, _) = await runSandboxProbe(kind: "connect-outbound") else {
            return (false, "the connect-outbound probe never exited, or NormaOfficeHelper is not embedded")
        }
        guard output.contains("PROBE_RESULT: connect-outbound denied") else {
            return (false, "expected denied — got: \(output)")
        }
        guard let errnoValue = Self.trailingErrno(output), errnoValue == EPERM else {
            return (false, "expected the sandbox's own EPERM (\(EPERM)) — a bare rc!=0 would also read "
                          + "\"denied\" for ENETDOWN/EHOSTUNREACH on an offline machine (this repo runs "
                          + "Wi-Fi-off drills routinely, T1 review's own Important finding), a false "
                          + "green on a completely broken fence; parsed errno was "
                          + "\(Self.trailingErrno(output).map(String.init) ?? "unparseable") — got: \(output)")
        }
        return (true, "outbound connect() denied, errno=\(errnoValue) (EPERM, anchored-by-value)")
    }

    // MARK: Drill 14 — typing -> invalidation -> a genuinely fresh tile

    private func performOpen14() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-typing-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "typing-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t14DocId = doc.docId
        return (true, "opened a fresh gate.odt copy for the typing drill, docId=\(t14DocId)")
    }

    private func performColdTile14() async -> (Bool, String) {
        guard !t14DocId.isEmpty else { return (false, "14.open must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-typing-drill.odt").path
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) { self.runtime.tileStore.tile(docId: self.t14DocId, key: key) != nil }
        guard filled, let entry = runtime.tileStore.tile(docId: t14DocId, key: key) else {
            return (false, "the cold tile never arrived")
        }
        guard entry.pixels.contains(where: { $0 != 0 }) else { return (false, "tile (0,0) is entirely blank") }
        t14BaselineHash = Self.sha256Hex(entry.pixels)
        return (true, "cold-filled tile (0,0), non-blank, sha256=\(t14BaselineHash)")
    }

    private func performType14() async -> (Bool, String) {
        guard !t14DocId.isEmpty else { return (false, "14.open must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-typing-drill.odt").path
        runtime.postMouseEvent(path: path, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        runtime.postMouseEvent(path: path, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        for charCode in OfficeInputCodes.charCodes(for: t14Marker) {
            runtime.postKeyEvent(path: path, type: .keyInput, charCode: charCode, keyCode: 0)
        }
        return (true, "clicked at (100,100), then typed \"\(t14Marker)\" via postKeyEvent — the same "
                     + "plain-commit door insertText itself uses (keyCode 0: no physical key behind "
                     + "synthetic text, per OfficeTileCanvasView.insertText's own doc)")
    }

    /// **The invalidation proof, not assumed**: `onInvalidated`'s own wiring
    /// (`ShellSessionHost.wireOfficeTileCallbacks`) only EVICTS the cached tile — a mounted
    /// `OfficeTileCanvasView` is what normally calls `refetchInvalidatedTiles`/re-subscribes next;
    /// this harness mounts no view, so it drives the same re-subscribe door drill 3 already proved
    /// refills an evicted key (`subscribeTiles` never re-requests an already-cached key —
    /// `OfficeTileStore.keysNeedingRequest`'s own filter — so asking again after a real eviction is a
    /// genuine repaint request, not a cache-hit tautology).
    private func performFreshTile14() async -> (Bool, String) {
        guard !t14DocId.isEmpty, !t14BaselineHash.isEmpty else { return (false, "14.open/14.coldTile must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-typing-drill.odt").path
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 512, height: 512), zoomPPT: 1000)
        let evicted = await waitUntil(timeout: 15) { self.runtime.tileStore.tile(docId: self.t14DocId, key: key) == nil }
        guard evicted else { return (false, "the typed edit never invalidated (evicted) tile (0,0) — no repaint to prove") }
        runtime.subscribeTiles(path: path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) { self.runtime.tileStore.tile(docId: self.t14DocId, key: key) != nil }
        guard filled, let entry = runtime.tileStore.tile(docId: t14DocId, key: key) else {
            return (false, "the re-subscribe after eviction never produced a fresh tile (0,0)")
        }
        let freshHash = Self.sha256Hex(entry.pixels)
        guard freshHash != t14BaselineHash else {
            return (false, "the refreshed tile is BYTE-IDENTICAL to the pre-type baseline — not a real repaint")
        }
        return (true, "typed edit evicted tile (0,0) (invalidation proven, not assumed); re-subscribing "
                     + "produced a fresh, DIFFERENT hash: \(t14BaselineHash) -> \(freshHash)")
    }

    // MARK: Drill 15 — caret/selection overlay presence (continues drill 14's own doc)

    private func performCaretPresent15() async -> (Bool, String) {
        guard !t14DocId.isEmpty else { return (false, "drill 14 must run first") }
        let present = await waitUntil(timeout: 10) { self.runtime.cursorStore.state(docId: self.t14DocId).caretRectTwips != nil }
        guard present else { return (false, "OfficeCursorStore reports no caret rect after drill 14's own typing") }
        return (true, "caret rect present: \(String(describing: runtime.cursorStore.state(docId: t14DocId).caretRectTwips))")
    }

    private func performSelect15() async -> (Bool, String) {
        guard !t14DocId.isEmpty else { return (false, "drill 14 must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-typing-drill.odt").path
        let shiftLeftKeyCode = 1026 | 0x1000 // OfficeInputCodes.Key.left | .keyShift (T6 live-test precedent)
        for _ in 0..<t14Marker.count {
            runtime.postKeyEvent(path: path, type: .keyInput, charCode: 0, keyCode: shiftLeftKeyCode)
            runtime.postKeyEvent(path: path, type: .keyUp, charCode: 0, keyCode: shiftLeftKeyCode)
        }
        return (true, "posted \(t14Marker.count) Shift+Left key event(s) to select the just-typed marker")
    }

    private func performSelectionPresent15() async -> (Bool, String) {
        guard !t14DocId.isEmpty else { return (false, "15.select must run first") }
        let present = await waitUntil(timeout: 10) { !self.runtime.cursorStore.state(docId: self.t14DocId).selectionRectsTwips.isEmpty }
        guard present else { return (false, "OfficeCursorStore reports no selection rects after Shift+Left") }
        return (true, "\(runtime.cursorStore.state(docId: t14DocId).selectionRectsTwips.count) selection rect(s) present")
    }

    // MARK: Drill 16 — IME composition (the ext-text-input door)

    private func performOpen16() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-ime-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "ime-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t16DocId = doc.docId
        return (true, "opened a fresh gate.odt copy for the IME drill, docId=\(t16DocId)")
    }

    private func performComposeAndCommit16() async -> (Bool, String) {
        guard !t16DocId.isEmpty else { return (false, "16.open must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-ime-drill.odt").path
        runtime.postMouseEvent(path: path, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        runtime.postMouseEvent(path: path, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        // The exact two-frame sequence `OfficeTileCanvasView.setMarkedText`/`insertText`'s own
        // composed-commit arm uses (T5's own proven shape): a preedit `.input`, then the FINAL marked
        // run posted again immediately followed by `.end` (whose `text` is always empty — LOK commits
        // whatever is CURRENTLY marked).
        runtime.postExtTextInput(path: path, type: .input, text: "e")
        runtime.postExtTextInput(path: path, type: .input, text: "é")
        runtime.postExtTextInput(path: path, type: .end, text: "")
        return (true, "posted a preedit (\"e\") then a composed commit (\"é\") via postExtTextInput — "
                     + "the same two-frame sequence OfficeTileCanvasView's own setMarkedText/insertText use")
    }

    /// **The T4 standard, not a tile-hash proxy.** A hash-changed check cannot distinguish "é landed
    /// once" from "éé landed twice" — exactly the vacuity T5 review M-2 named for the unit-level é
    /// drill's own `contains`-only check. This counts occurrences in the real, saved, off-disk body
    /// instead of trusting a rendered pixel diff, closing the same class here.
    private func performFreshTile16() async -> (Bool, String) {
        guard !t16DocId.isEmpty else { return (false, "16.open must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-ime-drill.odt").path
        let beforeStat = officeFileStat(atPath: path)
        runtime.save(path)
        let saveLanded = await waitUntil(timeout: 25) { officeFileStat(atPath: path) != beforeStat }
        guard saveLanded else { return (false, "the post-composition save never landed on disk") }
        guard let body = Self.readODFBodyText(atPath: path) else { return (false, "could not read content.xml back") }
        let occurrences = body.components(separatedBy: "é").count - 1
        guard occurrences == 1 else {
            return (false, "expected EXACTLY ONE é in the saved body, found \(occurrences) — got: \"\(body)\"")
        }
        return (true, "the ext-text-input door's composed commit landed EXACTLY ONE é on the real "
                     + "saved file, off disk — not a tile-pixel proxy")
    }

    // MARK: Drill 17 — clipboard round-trip

    private func performOpen17() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-clipboard-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "clipboard-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t17DocId = doc.docId
        return (true, "opened a fresh gate.odt copy for the clipboard drill, docId=\(t17DocId)")
    }

    private func performTypeSelectCopy17() async -> (Bool, String) {
        guard !t17DocId.isEmpty, let client = host.officeHelperSupervisor?.client else {
            return (false, "17.open must run first, and a live client must exist")
        }
        do {
            try await client.postMouse(docId: t17DocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await client.postMouse(docId: t17DocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await typeUppercaseMarkerViaClient(client, docId: t17DocId, marker: t17Marker)
            let shiftLeftKeyCode = 1026 | 0x1000
            for _ in 0..<t17Marker.count {
                try await client.postKey(docId: t17DocId, part: 0, type: .keyInput, charCode: 0, keyCode: shiftLeftKeyCode)
                try await client.postKey(docId: t17DocId, part: 0, type: .keyUp, charCode: 0, keyCode: shiftLeftKeyCode)
            }
            let copied = try await client.clipboardCopy(docId: t17DocId, part: 0)
            guard copied == t17Marker else { return (false, "clipboardCopy returned \"\(copied)\", expected exactly \"\(t17Marker)\"") }
            return (true, "typed, selected, and clipboardCopy returned exactly \"\(copied)\"")
        } catch {
            return (false, "type/select/copy failed: \(error)")
        }
    }

    private func performPasteDoublesOnDisk17() async -> (Bool, String) {
        guard !t17DocId.isEmpty, let client = host.officeHelperSupervisor?.client else {
            return (false, "17.open must run first, and a live client must exist")
        }
        let path = fixturesScratchDir.appendingPathComponent("t10-clipboard-drill.odt").path
        do {
            // Collapse the selection back to its own right edge BEFORE pasting — pasting while still
            // selected would REPLACE it instead, leaving the text unchanged (T6's own live-test-caught
            // false positive; NOT a bare Right press — see that test's own header for why Shift+Right
            // the identical count is what actually collapses to the right edge on this LOK build).
            let shiftRightKeyCode = 1027 | 0x1000
            for _ in 0..<t17Marker.count {
                try await client.postKey(docId: t17DocId, part: 0, type: .keyInput, charCode: 0, keyCode: shiftRightKeyCode)
                try await client.postKey(docId: t17DocId, part: 0, type: .keyUp, charCode: 0, keyCode: shiftRightKeyCode)
            }
            try await client.clipboardPaste(docId: t17DocId, part: 0, text: t17Marker)
        } catch {
            return (false, "collapse/paste failed: \(error)")
        }
        let beforeStat = officeFileStat(atPath: path)
        runtime.save(path)
        let saveLanded = await waitUntil(timeout: 25) { officeFileStat(atPath: path) != beforeStat }
        guard saveLanded else { return (false, "the post-paste save never landed on disk") }
        guard let body = Self.readODFBodyText(atPath: path) else { return (false, "could not read content.xml back") }
        let doubled = t17Marker + t17Marker
        guard body.contains(doubled) else { return (false, "expected \"\(doubled)\" in the saved body — got: \"\(body)\"") }
        return (true, "the saved real file's own body contains \"\(doubled)\" — the paste doubled the text, proven off disk")
    }

    // MARK: Drill 18 — the undo ladder + redo, then the two-view pair's own pinned undo characterization

    private func performTypeAndSave18() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-undo-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "undo-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        guard let client = host.officeHelperSupervisor?.client else { return (false, "no live client") }
        t18DocId = doc.docId
        do {
            try await client.postMouse(docId: t18DocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await client.postMouse(docId: t18DocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await typeUppercaseMarkerViaClient(client, docId: t18DocId, marker: t18Marker)
        } catch { return (false, "typing failed: \(error)") }
        let beforeStat = officeFileStat(atPath: path)
        runtime.save(path)
        let saveLanded = await waitUntil(timeout: 25) { officeFileStat(atPath: path) != beforeStat }
        guard saveLanded else { return (false, "the setup save never landed on disk") }
        guard let body = Self.readODFBodyText(atPath: path), body.contains(t18Marker) else {
            return (false, "\"\(t18Marker)\" is missing from the saved body")
        }
        return (true, "typed \"\(t18Marker)\" and saved — confirmed on disk, docId=\(t18DocId)")
    }

    private func performUndoLadderThenRedo18() async -> (Bool, String) {
        guard !t18DocId.isEmpty, let client = host.officeHelperSupervisor?.client else {
            return (false, "18.typeAndSave must run first")
        }
        let path = fixturesScratchDir.appendingPathComponent("t10-undo-drill.odt").path
        guard var bodyAfterUndo = Self.readODFBodyText(atPath: path) else { return (false, "could not read content.xml back") }
        guard bodyAfterUndo.contains(t18Marker) else { return (false, "18.typeAndSave's own marker is already missing") }
        var undosTaken = 0
        while bodyAfterUndo.contains(t18Marker), undosTaken < t18Marker.count {
            do { try await client.undo(docId: t18DocId) } catch { return (false, "undo #\(undosTaken + 1) failed: \(error)") }
            let beforeStat = officeFileStat(atPath: path)
            runtime.save(path)
            let saveLanded = await waitUntil(timeout: 20) { officeFileStat(atPath: path) != beforeStat }
            guard saveLanded else { return (false, "undo #\(undosTaken + 1)'s own save never landed on disk") }
            guard let body = Self.readODFBodyText(atPath: path) else { return (false, "could not read content.xml back") }
            bodyAfterUndo = body
            undosTaken += 1
        }
        guard !bodyAfterUndo.contains(t18Marker) else {
            return (false, "the marker is STILL present after \(undosTaken) undo(s), the bound this "
                          + "drill allows — got: \"\(bodyAfterUndo)\"")
        }
        do { try await client.redo(docId: t18DocId) } catch { return (false, "redo failed: \(error)") }
        let beforeRedoStat = officeFileStat(atPath: path)
        runtime.save(path)
        let redoSaveLanded = await waitUntil(timeout: 20) { officeFileStat(atPath: path) != beforeRedoStat }
        guard redoSaveLanded else { return (false, "the post-redo save never landed on disk") }
        guard let bodyAfterRedo = Self.readODFBodyText(atPath: path), bodyAfterRedo.contains(t18Marker) else {
            return (false, "redo did not restore \"\(t18Marker)\"")
        }
        return (true, "\(undosTaken) undo(s) removed the \(t18Marker.count)-character marker; redo "
                     + "restored it — both confirmed on disk")
    }

    private func performTwoViewMintAndEditBoth18() async -> (Bool, String) {
        guard !t18DocId.isEmpty, let client = host.officeHelperSupervisor?.client else {
            return (false, "18.typeAndSave must run first")
        }
        let path = fixturesScratchDir.appendingPathComponent("t10-undo-drill.odt").path
        let viewIdB: Int32
        do { viewIdB = try await client.createAgentView(docId: t18DocId) } catch {
            return (false, "createAgentView failed: \(error)")
        }
        guard viewIdB >= 0 else { return (false, "createAgentView returned \(viewIdB), expected a real LOK view id (>= 0)") }
        do {
            _ = try await client.createAgentView(docId: t18DocId)
            return (false, "a SECOND createAgentView for the same docId must be refused, not silently tolerated")
        } catch {
            // Expected — a second mint for the same docId is refused.
        }
        do {
            try await client.postMouse(docId: t18DocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await client.postMouse(docId: t18DocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await typeUppercaseMarkerViaClient(client, docId: t18DocId, marker: "AAAA")
        } catch { return (false, "edit via A failed: \(error)") }
        let beforeAStat = officeFileStat(atPath: path)
        runtime.save(path)
        let aSaveLanded = await waitUntil(timeout: 20) { officeFileStat(atPath: path) != beforeAStat }
        guard aSaveLanded else { return (false, "the post-A save never landed on disk") }
        guard let bodyAfterA = Self.readODFBodyText(atPath: path), bodyAfterA.contains("AAAA") else {
            return (false, "view A's own edit must land before this drill types via B")
        }
        do {
            for character in "BBBB" {
                let keyCode = 512 + Int(character.asciiValue! - Character("A").asciiValue!)
                let charCode = Int(character.asciiValue!)
                try await client.agentKeyEvent(docId: t18DocId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
                try await client.agentKeyEvent(docId: t18DocId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
            }
        } catch { return (false, "edit via B (agentKeyEvent) failed: \(error)") }
        let beforeBStat = officeFileStat(atPath: path)
        runtime.save(path)
        let bSaveLanded = await waitUntil(timeout: 20) { officeFileStat(atPath: path) != beforeBStat }
        guard bSaveLanded else { return (false, "the post-B save never landed on disk") }
        guard let bodyAfterB = Self.readODFBodyText(atPath: path), bodyAfterB.contains("AAAA"), bodyAfterB.contains("BBBB") else {
            return (false, "both edits must be present before undo runs")
        }
        return (true, "view B minted (id \(viewIdB)); a second mint was refused; view A's \"AAAA\" and "
                     + "view B's \"BBBB\" both landed, proven off disk")
    }

    /// **PINNED at Stage B Task 6** (task-6-report.md, fix round 1's own discriminator
    /// `testUndoViaAWorksNormallyWhenViewBExistsButWasNeverEdited`): cross-view undo is REFUSED/NO-OP
    /// — both markers survive undo-via-A once a second view has edited. Both booleans are asserted
    /// EXPLICITLY, branch-aware, not just a passing composite — the honesty rule this whole plan
    /// carries (no unconditional causal claims): a future LO/vendor upgrade that changes this
    /// characterization must fail HERE, loudly, not drift silently.
    private func performTwoViewUndoCharacterization18() async -> (Bool, String) {
        guard !t18DocId.isEmpty, let client = host.officeHelperSupervisor?.client else {
            return (false, "18.twoViewMintAndEditBoth must run first")
        }
        let path = fixturesScratchDir.appendingPathComponent("t10-undo-drill.odt").path
        do { try await client.undo(docId: t18DocId) } catch { return (false, "undo via A failed: \(error)") }
        let beforeStat = officeFileStat(atPath: path)
        runtime.save(path)
        // Load-bearing (T6 review I-4's own lesson, carried verbatim): a discarded wait here would make
        // a TIMED-OUT save indistinguishable from the REFUSED/NO-OP finding itself — both leave stale
        // bytes reading the SAME pre-undo body. This must fail loud on the wait, not just on content.
        let saveLanded = await waitUntil(timeout: 25) { officeFileStat(atPath: path) != beforeStat }
        guard saveLanded else {
            return (false, "the post-undo save never landed on disk — a silent timeout here would be "
                          + "indistinguishable from the REFUSED/NO-OP finding this step characterizes")
        }
        guard let bodyAfterUndo = Self.readODFBodyText(atPath: path) else { return (false, "could not read content.xml back") }
        let aSurvived = bodyAfterUndo.contains("AAAA")
        let bSurvived = bodyAfterUndo.contains("BBBB")
        let characterization: String
        switch (aSurvived, bSurvived) {
        case (false, true): characterization = "ISOLATED — undo via A removed only A's own edit"
        case (true, false): characterization = "SHARED/LIFO — undo via A removed B's edit instead"
        case (true, true): characterization = "REFUSED/NO-OP — undo via A changed neither edit"
        case (false, false): characterization = "REPAIR/OTHER — undo via A removed BOTH edits"
        }
        guard aSurvived, bSurvived else {
            return (false, "characterization changed from the T6-pinned REFUSED/NO-OP finding: now "
                          + "\(characterization) — got body: \"\(bodyAfterUndo)\"")
        }
        return (true, "PINNED: \(characterization) (aSurvived=\(aSurvived), bSurvived=\(bSurvived)) — "
                     + "consistent with T6's own two-view characterization, cross-checked live, not re-derived")
    }

    // MARK: Drill 19 — Cmd-S round-trip + the no-self-reload suppression proof

    private func performSaveRoundTrip19() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-cmds-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        t19PathForSuppression = path
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "cmds-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t19DocId = doc.docId
        runtime.postMouseEvent(path: path, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        runtime.postMouseEvent(path: path, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        for charCode in OfficeInputCodes.charCodes(for: "CMDS") {
            runtime.postKeyEvent(path: path, type: .keyInput, charCode: charCode, keyCode: 0)
        }
        let dirty = await waitUntil(timeout: 15) { self.runtime.stateSnapshot.documents[path]?.dirty == true }
        guard dirty else { return (false, "typing never marked the document dirty") }
        let outcome = await runtime.saveAndAwaitOutcome(path)
        guard outcome == .saved else { return (false, "saveAndAwaitOutcome returned \(outcome), expected .saved") }
        guard let body = Self.readODFBodyText(atPath: path), body.contains("CMDS") else {
            return (false, "the real file does not carry the typed \"CMDS\" after saveAndAwaitOutcome(.saved)")
        }
        return (true, "typed, Cmd-S-equivalent saveAndAwaitOutcome returned .saved, the real file carries the content")
    }

    private func performNoSelfReloadSuppression19() async -> (Bool, String) {
        guard !t19DocId.isEmpty, !t19PathForSuppression.isEmpty else { return (false, "19.saveRoundTrip must run first") }
        let path = t19PathForSuppression
        guard runtime.stateSnapshot.documents[path]?.docId == t19DocId else {
            return (false, "sanity: docId already changed before the settle window even started")
        }
        // A settle window, not a bounded-until-true poll: this is a NEGATIVE proof (nothing changes),
        // so `waitUntil` (which returns the instant its condition goes true) is the wrong tool — a
        // straight sleep is what "prove absence over a window" needs.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        let docIdAfterSettle = runtime.stateSnapshot.documents[path]?.docId
        guard docIdAfterSettle == t19DocId else {
            return (false, "the document's own docId CHANGED after the save settled (\(t19DocId) -> "
                          + "\(docIdAfterSettle ?? "nil")) — Norma's own write triggered a spurious "
                          + "self-reload, exactly what the .ours suppression machinery exists to prevent")
        }
        guard runtime.stateSnapshot.documentBanners[path] == nil else {
            return (false, "a banner appeared after the app's own save: \"\(runtime.stateSnapshot.documentBanners[path] ?? "")\"")
        }
        return (true, "1.5s after the save settled, docId is still \(t19DocId) (no self-reload) and no banner appeared")
    }

    // MARK: Drill 20 — autosave crash-recovery, SIGKILL mid-dirty, on a DEDICATED short-interval helper
    // (never the shared one — its config is fixed at 0.setup and every other drill depends on the
    // default 60s cadence)

    private func performSetup20() async -> (Bool, String) {
        let helperURL = OfficeHelperSupervisor.Configuration.production().helperExecutableURL
        guard FileManager.default.fileExists(atPath: helperURL.path) else {
            return (false, "NormaOfficeHelper not embedded at \(helperURL.path)")
        }
        let stateDir = scratchRoot.appendingPathComponent("drill20-helper", isDirectory: true)
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let directory = SessionDirectory(lister: { [] })
        let dedicatedHost = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        dedicatedHost.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL, socketDirectory: stateDir, autosaveIntervalSeconds: 2.0))
        }
        t20Host = dedicatedHost
        let dedicatedRuntime = dedicatedHost.officeRuntime(for: "office-harness-t20")
        t20Runtime = dedicatedRuntime

        let path = scratchRoot.appendingPathComponent("t20-crash-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        t20Path = path

        dedicatedRuntime.open(path)
        let settled = await waitUntil(timeout: 40) {
            dedicatedRuntime.stateSnapshot.documents[path] != nil || dedicatedRuntime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = dedicatedRuntime.stateSnapshot.documents[path] else {
            return (false, "the dedicated helper never opened the crash-drill doc: "
                          + "\(dedicatedRuntime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t20OriginalDocId = doc.docId
        guard let pid = t20Host?.officeHelperSupervisor?.process?.processIdentifier else {
            return (false, "no live process on the dedicated helper right after boot")
        }
        t20HelperPID = pid
        return (true, "dedicated helper (pid \(pid)) booted with a 2s autosave interval; opened a "
                     + "fresh gate.odt copy, docId=\(t20OriginalDocId)")
    }

    private func performTypeDirtyWaitSidecar20() async -> (Bool, String) {
        guard let dedicatedRuntime = t20Runtime, let dedicatedHost = t20Host, !t20OriginalDocId.isEmpty else {
            return (false, "20.setup must run first")
        }
        guard let client = dedicatedHost.officeHelperSupervisor?.client else { return (false, "no live client on the dedicated helper") }
        do {
            try await client.postMouse(docId: t20OriginalDocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await client.postMouse(docId: t20OriginalDocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
            try await typeUppercaseMarkerViaClient(client, docId: t20OriginalDocId, marker: t20Marker)
        } catch { return (false, "typing failed: \(error)") }
        let becameDirty = await waitUntil(timeout: 15) { dedicatedRuntime.stateSnapshot.documents[self.t20Path]?.dirty == true }
        guard becameDirty else { return (false, "the typed edit's own ModifiedStatus=true never reached documents[path].dirty") }

        let sidecarPath = scratchRoot.appendingPathComponent("drill20-helper", isDirectory: true)
            .appendingPathComponent("autosave", isDirectory: true).appendingPathComponent("\(t20OriginalDocId).odt").path
        let sidecarAppeared = await waitUntil(timeout: 30) { FileManager.default.fileExists(atPath: sidecarPath) }
        guard sidecarAppeared else { return (false, "the 2s autosave timer never wrote a sidecar at \(sidecarPath)") }
        t20SidecarPath = sidecarPath
        guard kill(t20HelperPID, 0) == 0 else { return (false, "the dedicated helper is not alive right after writing its own sidecar") }
        return (true, "typed \"\(t20Marker)\", dirty=true, a real 2s-timer sidecar appeared at "
                     + "\(sidecarPath); helper alive")
    }

    private func performKill20() async -> (Bool, String) {
        guard let dedicatedRuntime = t20Runtime, t20HelperPID != 0 else { return (false, "20.typeDirtyWaitSidecar must run first") }
        // An EXTERNAL, unprompted SIGKILL — never stop()/forceKill, which suppress `.helperDied` for a
        // kill this process itself initiated (drill 8's own header carries the identical reasoning).
        let result = kill(t20HelperPID, SIGKILL)
        guard result == 0 else { return (false, "kill(\(t20HelperPID), SIGKILL) returned \(result) (errno \(errno))") }
        let diedExternally = await waitUntil(timeout: 10) { kill(self.t20HelperPID, 0) != 0 }
        guard diedExternally else { return (false, "SIGKILL did not actually end the dedicated helper process") }
        let phaseFailed = await waitUntil(timeout: 10) { dedicatedRuntime.stateSnapshot.phase == .failed }
        guard phaseFailed else { return (false, "the dedicated supervisor's own death detection never reached .helperDied") }
        guard dedicatedRuntime.stateSnapshot.documents[t20Path] == nil else { return (false, ".helperDied did not wipe the open document") }
        return (true, "SIGKILL to pid \(t20HelperPID) — .helperDied observed, the open document cleared")
    }

    private func performReopenAndRecoveryOffered20() async -> (Bool, String) {
        guard let dedicatedRuntime = t20Runtime, !t20Path.isEmpty else { return (false, "20.kill must run first") }
        dedicatedRuntime.open(t20Path)
        let reopened = await waitUntil(timeout: 60) {
            dedicatedRuntime.stateSnapshot.documents[self.t20Path] != nil || dedicatedRuntime.stateSnapshot.phase == .failed
        }
        guard reopened, let reopenedDoc = dedicatedRuntime.stateSnapshot.documents[t20Path] else {
            return (false, "never reopened after the crash: \(dedicatedRuntime.stateSnapshot.openFailures[t20Path] ?? "?")")
        }
        guard reopenedDoc.dirty == false else { return (false, "the reopened document is dirty before any Restore") }
        let candidateFound = await waitUntil(timeout: 15) { dedicatedRuntime.stateSnapshot.documentRecoveryCandidates[self.t20Path] != nil }
        guard candidateFound, let candidate = dedicatedRuntime.stateSnapshot.documentRecoveryCandidates[t20Path] else {
            return (false, "the post-open recovery check never found the sidecar the crash left behind")
        }
        guard candidate.docId == t20OriginalDocId else {
            return (false, "the offer points at docId \(candidate.docId), expected the CRASHED session's own \(t20OriginalDocId)")
        }
        return (true, "reopened cleanly (docId \(reopenedDoc.docId)); recovery offer found, pointing at "
                     + "the crashed session's own docId")
    }

    private func performRestoreAndSaveLands20() async -> (Bool, String) {
        guard let dedicatedRuntime = t20Runtime, !t20Path.isEmpty else { return (false, "20.reopenAndRecoveryOffered must run first") }
        let reopenedDocId = dedicatedRuntime.stateSnapshot.documents[t20Path]?.docId
        dedicatedRuntime.restoreFromRecovery(t20Path)
        let restored = await waitUntil(timeout: 30) {
            dedicatedRuntime.stateSnapshot.documents[self.t20Path]?.docId != reopenedDocId
                && dedicatedRuntime.stateSnapshot.documents[self.t20Path]?.dirty == true
        }
        guard restored else { return (false, "the restore-flavored reopen never landed with dirty forced true") }
        guard dedicatedRuntime.stateSnapshot.documentRecoveryCandidates[t20Path] == nil else {
            return (false, "the recovery offer was not consumed once acted on")
        }
        let beforeSaveStat = officeFileStat(atPath: t20Path)
        dedicatedRuntime.save(t20Path)
        let fileChanged = await waitUntil(timeout: 30) { officeFileStat(atPath: self.t20Path) != beforeSaveStat }
        guard fileChanged else {
            return (false, "the post-restore save never landed on the real path — banner="
                          + "\(dedicatedRuntime.stateSnapshot.documentBanners[t20Path] ?? "nil")")
        }
        guard let body = Self.readODFBodyText(atPath: t20Path), body.contains(t20Marker) else {
            return (false, "the typed marker \"\(t20Marker)\" is missing from the SAVED real file's own body")
        }
        let sidecarCleared = await waitUntil(timeout: 15) { !FileManager.default.fileExists(atPath: self.t20SidecarPath) }
        guard sidecarCleared else { return (false, "a successful save must clear the now-redundant sidecar") }
        return (true, "restored (dirty forced true, offer consumed); Cmd-S landed the recovered "
                     + "\"\(t20Marker)\" on the real path; sidecar cleared")
    }

    // MARK: Drill 21 — dirty-close/quit: the pure gate predicate (the sheet/alert are the human live
    // gate's own item — see the verification tail: "close-dirty sheet · quit-dirty alert" are listed
    // there, separately from "the Office Harness expects the grown count green")

    private func performCleanNotGated21() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-dirtygate-drill.odt").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odt"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odt copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, runtime.stateSnapshot.documents[path] != nil else {
            return (false, "dirtygate-drill.odt never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        let dirtyPaths = officeDirtyFilePaths(runtimeStates: [runtime.stateSnapshot])
        guard !dirtyPaths.contains(path) else { return (false, "a freshly opened, unedited document is already gated: \(dirtyPaths)") }
        guard officeDocumentIsDirty(state: runtime.stateSnapshot, path: path) == false else {
            return (false, "officeDocumentIsDirty says true for an unedited document")
        }
        return (true, "a clean, freshly-opened document names in neither officeDirtyFilePaths nor "
                     + "officeDocumentIsDirty — the close/quit sheet itself is the human live gate's "
                     + "own item, not this drill's")
    }

    private func performDirtyIsGated21() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-dirtygate-drill.odt").path
        guard runtime.stateSnapshot.documents[path] != nil else { return (false, "21.cleanNotGated must run first") }
        runtime.postMouseEvent(path: path, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        runtime.postMouseEvent(path: path, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        for charCode in OfficeInputCodes.charCodes(for: "GATE") {
            runtime.postKeyEvent(path: path, type: .keyInput, charCode: charCode, keyCode: 0)
        }
        let dirty = await waitUntil(timeout: 15) { self.runtime.stateSnapshot.documents[path]?.dirty == true }
        guard dirty else { return (false, "typing never marked the document dirty") }
        let dirtyPaths = officeDirtyFilePaths(runtimeStates: [runtime.stateSnapshot])
        guard dirtyPaths.contains(path) else { return (false, "officeDirtyFilePaths does not name a genuinely dirty document: \(dirtyPaths)") }
        guard officeDocumentIsDirty(state: runtime.stateSnapshot, path: path) else {
            return (false, "officeDocumentIsDirty says false for a genuinely dirty document")
        }
        return (true, "a real typed edit names the path in officeDirtyFilePaths and officeDocumentIsDirty "
                     + "— this is the decision the close/quit gate itself reads; the sheet/alert are the "
                     + "human live gate's own item")
    }

    private func performReadOnlyFormatNeverGates21() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-dirtygate-readonly.xlsm").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.xlsm"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.xlsm copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 25) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "the read-only-format doc never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        // T9's F3 fix (task-9-report.md): the mask lives at the SINGLE WRITER
        // (`.modifiedStatusChanged`'s own reducer arm), not at input gating alone — so this drives the
        // SAME door the T9 fix itself targeted, and the T9 unit test already pins
        // (`AppLifecycleTests.testOfficeDirtyFilePathsNeverNamesAReadOnlyFormatDocumentEvenAfterA
        // GenuineModifiedChangedTrue`): a real FORCED modifiedChanged(true), unreachable through
        // ordinary input for a read-only format (input is gated to a no-op there) — a defense-in-depth
        // proof, not a redundant one.
        runtime.handle(documentEvent: .modifiedChanged(true), docId: doc.docId)
        try? await Task.sleep(nanoseconds: 50_000_000)
        let dirtyPaths = officeDirtyFilePaths(runtimeStates: [runtime.stateSnapshot])
        guard !dirtyPaths.contains(path) else {
            return (false, "T9 F3 REGRESSION: a forced modifiedChanged(true) on a read-only-format "
                          + "document reached officeDirtyFilePaths: \(dirtyPaths)")
        }
        return (true, "a forced modifiedChanged(true) on gate.xlsm (read-only format) never reaches "
                     + "officeDirtyFilePaths — T9's F3 mask holds live, through the harness's own real runtime")
    }

    // MARK: Drill 22 — formula-bar tracking (a fresh doc — drill 8's own SIGKILL wipes every document
    // this harness had open before this point, so nothing from drill 2 survives to reuse)

    private func performOpen22() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-formulabar-drill.xlsx").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.xlsx"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.xlsx copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "formulabar-drill.xlsx never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t22DocId = doc.docId
        return (true, "opened a fresh gate.xlsx copy for the formula-bar drill, docId=\(t22DocId)")
    }

    /// **Drives `postMouseEvent` + `OfficeCursorStore` directly — not the formula-bar VIEW.** T8's
    /// own live tests already prove `OfficeFormulaBarModel`'s rendering off this same source data;
    /// this harness mounts no SwiftUI view, so its own claim is narrower and stated as such.
    private func performClickCell22() async -> (Bool, String) {
        guard !t22DocId.isEmpty else { return (false, "22.open must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-formulabar-drill.xlsx").path
        runtime.postMouseEvent(path: path, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        runtime.postMouseEvent(path: path, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        let landed = await waitUntil(timeout: 15) { self.runtime.cursorStore.state(docId: self.t22DocId).cellCursor != nil }
        guard landed else { return (false, "no cellCursor reached OfficeCursorStore after the click") }
        let state = runtime.cursorStore.state(docId: t22DocId)
        t22FirstCellCursor = state.cellCursor
        t22FirstFormulaText = state.cellFormulaText
        guard state.cellFormulaText != nil else { return (false, "cellFormulaText is nil after the click — the formula bar's own content source") }
        return (true, "a click landed cellCursor=\(String(describing: state.cellCursor)) "
                     + "cellFormulaText=\"\(state.cellFormulaText ?? "nil")\"")
    }

    private func performMoveTracks22() async -> (Bool, String) {
        guard !t22DocId.isEmpty else { return (false, "22.clickCell must run first") }
        let path = fixturesScratchDir.appendingPathComponent("t10-formulabar-drill.xlsx").path
        let rightArrowKeyCode = 1027 // OfficeInputCodes.Key.right, no shift — a plain cell-cursor move
        runtime.postKeyEvent(path: path, type: .keyInput, charCode: 0, keyCode: rightArrowKeyCode)
        runtime.postKeyEvent(path: path, type: .keyUp, charCode: 0, keyCode: rightArrowKeyCode)
        let changed = await waitUntil(timeout: 15) { self.runtime.cursorStore.state(docId: self.t22DocId).cellCursor != self.t22FirstCellCursor }
        guard changed else { return (false, "the cell cursor never changed after an arrow-key move — the bar would appear frozen") }
        let state = runtime.cursorStore.state(docId: t22DocId)
        return (true, "arrow-key move changed cellCursor (\(String(describing: t22FirstCellCursor)) -> "
                     + "\(String(describing: state.cellCursor))) and cellFormulaText (\"\(t22FirstFormulaText ?? "nil")\" "
                     + "-> \"\(state.cellFormulaText ?? "nil")\") — it TRACKS, not just appears once")
    }

    // MARK: Drill 23 — multi-slide nav (the committed two-slide.fodp)

    private func performOpen23() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-two-slide.fodp").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("two-slide.fodp"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh two-slide.fodp copy: \(error)") }
        t23Path = path
        runtime.open(path)
        let settled = await waitUntil(timeout: 35) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "two-slide.fodp never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        t23DocId = doc.docId
        guard doc.parts == 2 else { return (false, "parts == \(doc.parts), expected 2") }
        return (true, "opened two-slide.fodp — parts == 2, docId=\(t23DocId)")
    }

    private func performSlide0Tile23() async -> (Bool, String) {
        guard !t23DocId.isEmpty else { return (false, "23.open must run first") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: t23Path, part: 0, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) { self.runtime.tileStore.tile(docId: self.t23DocId, key: key) != nil }
        guard filled else { return (false, "slide 0's tile (0,0) never arrived") }
        t23Slide0Pixels = runtime.tileStore.tile(docId: t23DocId, key: key)?.pixels
        return (true, "slide 0's tile (0,0) filled")
    }

    /// **Drives `subscribeTiles(part: 1, ...)` — the door the slide rail's own click-switch lands on
    /// (`OfficeTileCanvasView.setActivePart`'s own resubscribe, proven live at T8)** — not the rail
    /// click itself; this harness mounts no rail view.
    private func performSlide1Distinct23() async -> (Bool, String) {
        guard !t23DocId.isEmpty, let slide0 = t23Slide0Pixels else { return (false, "23.slide0Tile must run first") }
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256), zoomPPT: 1000)
        let key = TileKey(part: 1, zoomPPT: 1000, tileX: 0, tileY: 0)
        runtime.subscribeTiles(path: t23Path, part: 1, zoomPPT: 1000, viewportTwips: viewport)
        let filled = await waitUntil(timeout: 25) { self.runtime.tileStore.tile(docId: self.t23DocId, key: key) != nil }
        guard filled else { return (false, "slide 1's tile (0,0) never arrived") }
        guard runtime.stateSnapshot.documents[t23Path]?.activePart == 1 else {
            return (false, "activePart did not update to 1 after subscribeRequested(part: 1, ...)")
        }
        guard let slide1 = runtime.tileStore.tile(docId: t23DocId, key: key)?.pixels else { return (false, "slide 1's pixels vanished from the store") }
        guard slide0 != slide1 else { return (false, "slide 1's tile is BYTE-IDENTICAL to slide 0's at the same coordinates") }
        return (true, "slide 1 pixel-DISTINCT from slide 0 at tile (0,0); activePart == 1")
    }

    // MARK: Drill 24 — legacy-format opens: the widened set, then the CFB refusal

    private func performXlsmOpens24() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-gate.xlsm").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.xlsm"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.xlsm copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 25) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.xlsm never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        guard doc.type == .spreadsheet, doc.parts == 1 else { return (false, "unexpected metadata: type=\(doc.type) parts=\(doc.parts)") }
        return (true, "gate.xlsm (widened, Task 9) opens: type=\(doc.type) parts=\(doc.parts) "
                     + "size=\(doc.sizeTwips.widthTwips)x\(doc.sizeTwips.heightTwips)")
    }

    private func performOdgOpens24() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-gate.odg").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.odg"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.odg copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 25) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "gate.odg never opened: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        guard doc.type == .drawing, doc.parts == 1 else { return (false, "unexpected metadata: type=\(doc.type) parts=\(doc.parts)") }
        return (true, "gate.odg (widened, Task 9) opens: type=\(doc.type) parts=\(doc.parts) "
                     + "size=\(doc.sizeTwips.widthTwips)x\(doc.sizeTwips.heightTwips)")
    }

    /// **The adopted release blocker's own live drill.** `legacy-doc.doc`'s own committed bytes —
    /// genuine OLE2/CFB (T9's own live-observed helper-death fixture) — renamed to `.docx`: "a user's
    /// genuine .doc renamed .docx," the exact scenario the blocker names.
    private func performCFBRefusal24() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-renamed-legacy.docx").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("legacy-doc.doc"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage the renamed CFB fixture: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 20) {
            self.runtime.stateSnapshot.openFailures[path] != nil || self.runtime.stateSnapshot.documents[path] != nil
        }
        guard settled else { return (false, "the CFB-under-.docx open never settled — phase \(runtime.stateSnapshot.phase)") }
        guard runtime.stateSnapshot.documents[path] == nil else {
            return (false, "legacy-doc.doc's own bytes under a .docx extension OPENED — the CFB sniff regressed")
        }
        let expectedSentence = "This file's contents don't match its extension — it looks like an older "
                              + "binary Office format and can't be opened here."
        guard runtime.stateSnapshot.openFailures[path] == expectedSentence else {
            return (false, "banner reason was \"\(runtime.stateSnapshot.openFailures[path] ?? "nil")\", "
                          + "expected the mapped house-voice sentence \"\(expectedSentence)\"")
        }
        return (true, "CFB bytes under .docx refused with the mapped house-voice sentence, not the raw wire marker")
    }

    /// **The liveness proof, not just `process.isRunning`**: a fresh, GOOD document actually opens on
    /// the SAME shared helper right after the refusal.
    private func performLivenessAfterRefusal24() async -> (Bool, String) {
        let path = fixturesScratchDir.appendingPathComponent("t10-post-refusal-liveness.docx").path
        do {
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.copyItem(at: Self.committedFixturesRoot.appendingPathComponent("gate.docx"),
                                             to: URL(fileURLWithPath: path))
        } catch { return (false, "could not stage a fresh gate.docx copy: \(error)") }
        runtime.open(path)
        let settled = await waitUntil(timeout: 20) {
            self.runtime.stateSnapshot.documents[path] != nil || self.runtime.stateSnapshot.phase == .failed
        }
        guard settled, let doc = runtime.stateSnapshot.documents[path] else {
            return (false, "a fresh good document did not open on the SAME helper right after the CFB "
                          + "refusal: \(runtime.stateSnapshot.openFailures[path] ?? "?")")
        }
        return (true, "a fresh gate.docx copy opened normally (type=\(doc.type)) on the SAME shared "
                     + "helper right after the CFB refusal — the actual liveness proof, not just a "
                     + "process-alive flag")
    }

    // MARK: Drill 25 — Stage B hygiene re-check (the new drills' own scratch/helper footprint)

    private func performStatePaths25() async -> (Bool, String) {
        let drill20StateDir = scratchRoot.appendingPathComponent("drill20-helper", isDirectory: true)
        guard drill20StateDir.path.hasPrefix(scratchRoot.path) else {
            return (false, "\(drill20StateDir.path) is not under the harness's own scratch root \(scratchRoot.path)")
        }
        guard !drill20StateDir.path.contains(".norma") else { return (false, "\(drill20StateDir.path) touches a .norma path") }
        guard FileManager.default.fileExists(atPath: drill20StateDir.path) else {
            return (false, "drill 20's own dedicated-helper state directory does not exist under this run's own root")
        }
        return (true, "drill 20's own dedicated-helper state directory lives under \(scratchRoot.path); "
                     + "no Stage B path touches ~/.norma or ~/.norma-dev")
    }

    private func performUserCachesUntouched25() async -> (Bool, String) {
        let realOfficeDir = OfficeHelperSupervisor.Configuration.defaultStateDirectory()
        let after = (try? FileManager.default.contentsOfDirectory(atPath: realOfficeDir.path).sorted()) ?? []
        guard after == userOfficeDirListingBeforeRun else {
            return (false, "the real Application Support Office directory's listing CHANGED during "
                          + "Stage B's own drills — before=\(userOfficeDirListingBeforeRun) after=\(after)")
        }
        return (true, "the real Application Support Office directory is STILL untouched after all of "
                     + "Stage B's own new steps (\(after.count) entrie(s), unchanged since 0.setup's own baseline)")
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

    // MARK: - office-editable Task 10: Stage B shared helpers

    /// Office Stage B Task 10 — spawns the REAL, embedded production helper in `--sandbox-probe`
    /// mode: applies the sandbox, attempts ONE operation, prints one `PROBE_RESULT:` line, `_exit(0)`s
    /// — never touches LOK or the socket (T1's own mechanism, `main.swift`'s DEBUG-only probe block).
    /// **No `--sandbox-profile` override**: this harness IS the real embedded app, so the DEFAULT
    /// resolution (`resolveSandboxProfilePath()`'s no-override branch — `Contents/Resources/office-
    /// helper.sb`, sibling of `Contents/Resources/LibreOffice`) is exercised for real, the identical
    /// "more end-to-end than the XCTest-only live tests' --lok-root shortcut" posture `0.setup`'s own
    /// header already states for the shared supervisor.
    private func runSandboxProbe(kind: String, outsideDir: URL? = nil, timeout: TimeInterval = 12.0) async -> (stdout: String, exitCode: Int32)? {
        let helperURL = OfficeHelperSupervisor.Configuration.production().helperExecutableURL
        guard FileManager.default.fileExists(atPath: helperURL.path) else { return nil }
        let stateDir = scratchRoot.appendingPathComponent("t13-probe-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        var arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                          "--token", "office-harness-t13-\(UUID().uuidString.prefix(8))",
                          "--sandbox-probe", kind]
        if let outsideDir { arguments += ["--probe-outside-dir", outsideDir.path] }
        let process = Process()
        process.executableURL = helperURL
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe() // discard — keeps the log focused on PROBE_RESULT lines
        do { try process.run() } catch { return nil }
        let exited = await waitUntil(timeout: timeout) { !process.isRunning }
        guard exited else { process.terminate(); return nil }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (output, process.terminationStatus)
    }

    /// Parses the trailing `errno=<N>` integer BY VALUE — never an unanchored substring match, which
    /// would let e.g. `errno=13` (EACCES) satisfy a check written against `errno=1` (EPERM). T1
    /// review's own fix round 1 lesson (task-1-report.md), applied here rather than repeated.
    private static func trailingErrno(_ output: String) -> Int32? {
        guard let range = output.range(of: "errno=") else { return nil }
        let digits = output[range.upperBound...].prefix { $0.isNumber }
        return Int32(String(digits))
    }

    /// `com.sun.star.awt.Key`'s `KEY_A`..`KEY_Z` run 512..537, alphabetically — the same closed-form
    /// `OfficeRuntimeLiveTests.rawUppercaseLetterKeyCode` already established (that file's own header:
    /// confirmed against ITS OWN local `postRealEdit` table). Types `marker` (uppercase ASCII only)
    /// via raw `client.postKey` — one keyInput+keyUp pair per character, part 0 (every Stage B drill
    /// that calls this opens its own fresh, single-part-in-practice document).
    private func typeUppercaseMarkerViaClient(_ client: OfficeHelperClient, docId: String, marker: String) async throws {
        for character in marker {
            let keyCode = 512 + Int(character.asciiValue! - Character("A").asciiValue!)
            let charCode = Int(character.asciiValue!)
            try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
            try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        }
    }

    /// Ported from `OfficeRuntimeLiveTests.readODFContentXML`/`.strippedODFBodyText` (test-target-
    /// only, unreachable from this app-target harness — same cross-target boundary `OfficeSaveFormat`'s
    /// own header names). Same recipe: `unzip -p <path> content.xml`, then everything between
    /// `<office:text` (the bare prefix — a real LO save carries attributes on the open tag the moment
    /// a document lays out on more than one page, a T6-era live-test-caught correction carried over
    /// verbatim) and `</office:text>` with every XML tag stripped.
    private static func readODFBodyText(atPath path: String) -> String? {
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        unzip.arguments = ["-p", path, "content.xml"]
        let pipe = Pipe()
        unzip.standardOutput = pipe
        unzip.standardError = Pipe()
        do { try unzip.run() } catch { return nil }
        unzip.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let content = String(data: data, encoding: .utf8) else { return nil }
        guard let start = content.range(of: "<office:text"),
              let openEnd = content.range(of: ">", range: start.upperBound..<content.endIndex),
              let end = content.range(of: "</office:text>", range: openEnd.upperBound..<content.endIndex) else {
            return nil
        }
        let body = content[openEnd.upperBound..<end.lowerBound]
        var out = ""
        var inTag = false
        for character in body {
            if character == "<" { inTag = true; continue }
            if character == ">" { inTag = false; continue }
            if !inTag { out.append(character) }
        }
        return out
    }
}
#endif
