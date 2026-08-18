import AppKit
import NormaKit
import XCTest
@testable import Norma

/// editor-product Task 5 — **the code tab: a viewport onto the session's one editor.**
///
/// What this file proves, and the shape it proves it in: every decision the tab makes is a pure
/// function driven directly (`editorViewportPlan`, `editorTabSessionRoots`, the chrome's two
/// readings, the open-failure classifier), and the two things that are NOT decisions — the explicit
/// `viewportHost = nil` on unmount, and the lazy read firing once — are driven through the real
/// objects with no SwiftUI anywhere. Mounting views is not this house's posture (`PanelViewportTests`
/// is the in-repo precedent for driving an `NSView` host directly); the editor's LOOK is the live
/// gate.
///
/// **The doubles are `EditorRuntimeTests`'/`EditorBridgeHubTests`', deliberately, not copies** — the
/// same reasoning `PanelViewportTests` records for borrowing `BrowserRuntimeTests`': a second
/// recorder would fork the transcript format from the assertions written against it.
@MainActor
final class EditorTabTests: XCTestCase {

    // MARK: - Fixtures

    /// Every double a live `EditorRuntime` reaches through an `[unowned self]` closure, held for the
    /// whole test — `ShellSessionHostTests` measured this as a real crash, not a hypothetical: the
    /// recorders hand out closure structs that capture themselves unowned, and one a test never
    /// mentions again is released at its local's last use.
    private var doubles: [AnyObject] = []
    private var runtimes: [EditorRuntime] = []

    override func tearDown() {
        // Every runtime this file builds may have parked a container in a hidden window; teardown is
        // what closes it. Runtimes are torn down BEFORE the doubles they call into are released.
        for runtime in runtimes { runtime.teardown() }
        runtimes.removeAll()
        doubles.removeAll()
        PanelEditorTabModels.removeAllForTesting()
        super.tearDown()
    }

    private struct EditorHarness {
        let runtime: EditorRuntime
        let cef: EditorCEFRecorder
        let slot: EditorSlotRecorder
        let hub: EditorBridgeHub
        let scheduler: EditorFakeScheduler
    }

    /// A runtime whose CEF calls are recorded and whose disk is a dictionary. `files == nil` means
    /// "use the REAL reader", which is how the missing-file path is exercised honestly.
    private func makeRuntime(sessionId: String = "S1",
                             files: [String: String]? = [:],
                             browserId: Int32 = 41) -> EditorHarness {
        let cef = EditorCEFRecorder()
        cef.browserIds = [browserId]
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let scheduler = EditorFakeScheduler()
        doubles.append(contentsOf: [cef, slot, hub, scheduler] as [AnyObject])
        let runtime: EditorRuntime
        if let files {
            runtime = EditorRuntime(sessionId: sessionId, hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark },
                                    readFile: { path in
                                        guard let text = files[path] else {
                                            throw NSError(domain: NSCocoaErrorDomain,
                                                          code: NSFileReadNoSuchFileError)
                                        }
                                        return EditorFileContents(text: text)
                                    })
        } else {
            runtime = EditorRuntime(sessionId: sessionId, hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark })
        }
        runtimes.append(runtime)
        return EditorHarness(runtime: runtime, cef: cef, slot: slot, hub: hub, scheduler: scheduler)
    }

    /// Drive a runtime to `.ready` and **drain the `setTheme` the page-ready flush sends**.
    ///
    /// That drain is not bookkeeping: editor-product Task 4 put `.sendTheme` ahead of every flushed
    /// open, which shifted every positional CDP ack in this suite by one. A helper that swallowed it
    /// silently is what stops the next author debugging a "wrong model" failure the way Task 4 did —
    /// and it is why every assertion below reads the CDP log by CONTENT (`cdpTypes`) rather than by
    /// index.
    private func boot(_ harness: EditorHarness, browserId: Int32 = 41) {
        harness.runtime.prewarm()
        harness.slot.deliver(browserId: browserId, queryId: 1, request: #"{"type":"ready"}"#)
        XCTAssertEqual(cdpTypes(harness.cef), ["setTheme"],
                       "page-ready sends the brand before anything else — Task 4")
        harness.cef.answerNextCDP()
    }

    /// The bridge messages the runtime has sent and **not yet been answered for**, by wire type,
    /// read out of the recorded CDP payloads rather than counted. `EditorBridgeOutbound.javascript`
    /// is `window.normaEditor.dispatch({"type":…})`, and the params are JSON, so the type appears
    /// with its quotes escaped.
    ///
    /// Outstanding, not historical: `EditorCEFRecorder.answerNextCDP` REMOVES the entry it answers
    /// (CEF's door fires each completion once). Every assertion below therefore reads this before
    /// draining — which is also what keeps them honest about Task 4's `setTheme`: it is asserted by
    /// name at `boot` and drained there, rather than silently shifting an index later.
    private func cdpTypes(_ cef: EditorCEFRecorder) -> [String] {
        let known = ["setTheme", "openModel", "activateModel", "closeModel", "pullContent",
                     "applyExternalContent", "markSaved"]
        return cef.cdp.compactMap { entry in
            guard let params = entry.params else { return nil }
            return known.first { params.contains(#"\"type\":\""# + $0 + #"\""#) }
        }
    }

    private func cdpPayloads(_ cef: EditorCEFRecorder) -> [String] {
        cef.cdp.compactMap(\.params)
    }

    /// Answer every outstanding CDP call (as CEF's door eventually does) and hand back what they
    /// WERE. Used instead of a bare `answerNextCDP()` wherever more than one is in flight: the
    /// recorder answers the OLDEST, so acking blind is how a test ends up completing an
    /// `activateModel` while believing it completed the `openModel` behind it.
    @discardableResult
    private func drain(_ cef: EditorCEFRecorder) -> [String] {
        let types = cdpTypes(cef)
        while cef.answerNextCDP() {}
        return types
    }

    private func dirRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    /// A mutable row source, so a test can make a session's row ARRIVE — the create-then-navigate
    /// race is the whole reason the tab distinguishes "not yet" from "none".
    private final class RowsBox: @unchecked Sendable {
        var rows: [SessionSummary] = []
    }

    private func makeHost(_ box: RowsBox) async -> ShellSessionHost {
        let directory = SessionDirectory(lister: { box.rows })
        // `makeFeed: { _ in nil }` — nothing in this file attaches a session (`AppShellTests` and
        // `BrowserSignalsTests` take the same shortcut).
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        await directory.refresh()
        return host
    }

    private func waitUntil(_ label: String, _ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(label)", file: file, line: line)
    }

    private static let file = "/repo/src/engine.ts"
    private static let otherFile = "/repo/src/panel.ts"

    // MARK: - What a code tab can know about its session (PURE)

    /// **Three answers, and the third is the one that stops a lie.** An absent row is not a session
    /// without directories: it is the create-then-navigate race, and rendering "This session has no
    /// working directory" for it would be a calm, confident falsehood the user cannot tell from the
    /// truth — and one that STICKS, since nothing would re-ask.
    func testTheRootsReadingSeparatesNotYetFromNone() {
        let rows = [
            dirRow("S_dirs", dirs: [SessionDirEntry(path: "/repo", locked: false)]),
            dirRow("S_dirless", dirs: []),
            SessionSummary(sessionId: "S_chat", title: nil, createdAt: 2, scope: "global",
                           cwd: nil, mode: "chat")
        ]
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_dirs", rows: rows), .present)
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_dirless", rows: rows), .none,
                       "[] is a real workdir-less session")
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_chat", rows: rows), .none,
                       "nil dirs = no working-directory concept at all — same sentence, same fact")
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_unlisted", rows: rows), .unknown,
                       "a row that has not landed yet is NOT a dirless session")
        XCTAssertEqual(editorTabSessionRoots(sessionId: nil, rows: rows), .unknown)
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_dirs", rows: []), .unknown)
    }

    /// **The predicate reconciliation (editor-product Task 7, Task 6 review's Minor).** Before this
    /// fix, a degenerate `dirs: [{path: ""}]` row — a non-empty ARRAY whose one entry carries no real
    /// path — answered `.present` here while `resolvedFilePath` (`ShellSessionHost.swift`) already
    /// required a genuinely non-empty primary path to resolve anything against. That gap let the
    /// transcript's row-level gate render a clickable file-door button for such a row, whose click
    /// then minted a tab at a RELATIVE url instead of resolving one. One predicate now: `dirs.first?
    /// .path` must be non-empty, not merely `dirs` being a non-empty array.
    func testADegenerateEmptyPathEntryReadsAsDirlessNotPresent() {
        let rows = [dirRow("S_empty_path", dirs: [SessionDirEntry(path: "", locked: false)])]
        XCTAssertEqual(editorTabSessionRoots(sessionId: "S_empty_path", rows: rows), .none,
                       "a non-empty dirs ARRAY whose only entry has no real path is not a root")
    }

    // MARK: - editor-product wave-8 item 1: the Files-tab strip door's gate (PURE)

    /// `panelFilesDoorShown` is a thin wrapper over `editorTabSessionRoots`, but it is the gate the
    /// panel strip's control lives or dies by — this pins it against every shape that function's own
    /// tests already carry, on the SAME `rows` fixture, so the two can never quietly drift apart.
    func testPanelFilesDoorShownMirrorsTheRootsPredicateExactly() {
        let rows = [
            dirRow("S_dirs", dirs: [SessionDirEntry(path: "/repo", locked: false)]),
            dirRow("S_dirless", dirs: []),
            dirRow("S_empty_path", dirs: [SessionDirEntry(path: "", locked: false)]),
            SessionSummary(sessionId: "S_chat", title: nil, createdAt: 2, scope: "global",
                           cwd: nil, mode: "chat")
        ]
        XCTAssertTrue(panelFilesDoorShown(sessionId: "S_dirs", rows: rows),
                      "a real primary directory is the one case the door shows for")
        XCTAssertFalse(panelFilesDoorShown(sessionId: "S_dirless", rows: rows),
                       "[] is a genuine workdir-less session — no door")
        XCTAssertFalse(panelFilesDoorShown(sessionId: "S_empty_path", rows: rows),
                       "a degenerate dirs:[{path:\"\"}] row is not a root, same as editorTabSessionRoots")
        XCTAssertFalse(panelFilesDoorShown(sessionId: "S_chat", rows: rows),
                       "chat has no working-directory concept at all")
        XCTAssertFalse(panelFilesDoorShown(sessionId: "S_unlisted", rows: rows),
                       "not-yet-arrived (.unknown) must render as ABSENT — never a guessed door")
        XCTAssertFalse(panelFilesDoorShown(sessionId: nil, rows: rows))
        XCTAssertFalse(panelFilesDoorShown(sessionId: "S_dirs", rows: []))
    }

    /// **Wire safety, at the one call site that can actually fire it.** Nothing in `ShellPanel.swift`
    /// is reachable from XCTest (this suite's own established posture — see its header doc), so this
    /// is a source pin: the door must be an absent `if`, never a `.disabled(...)` control a stray
    /// click could still fire, and it must call through to the host's real door rather than a hand
    /// re-derivation of the RPC.
    func testShellPanelGatesTheFilesDoorAndWiresItToTheHostsRealDoor() throws {
        let code = try shellPanelCodeOnly()
        XCTAssertTrue(code.contains("if filesTabAvailable {"),
                      "the control must be genuinely ABSENT when ineligible, not merely disabled")
        XCTAssertTrue(code.contains("host?.openFilesTab(sessionId: sessionId)"),
                      "firing the door must call through to ShellSessionHost.openFilesTab(sessionId:)")
        XCTAssertTrue(code.contains("panelFilesDoorShown(sessionId: host?.panelSessionId"),
                      "the gate must be the one shared predicate, not a second hand-copy of it")
    }

    /// Loads `ShellPanel.swift` and strips comment-only lines — the same discipline
    /// `PanelKindTintTests.codeOnly` keeps, for the identical reason: a prose comment mentioning one
    /// of these fragments (this task's own doc comments come close) must never be able to satisfy a
    /// pin that is supposed to be reading the real call site.
    private func shellPanelCodeOnly() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // NormaAppTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // Norma
            .appendingPathComponent("Sources/AppShell/ShellPanel.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        return source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
            .joined(separator: "\n")
    }

    // MARK: - The plan (PURE)

    private func ready(models: [String: Bool] = [:], current: String? = nil,
                       failures: [String: EditorOpenFailure] = [:]) -> EditorRuntimeState {
        var state = EditorRuntimeState()
        state.phase = .ready
        for (path, dirty) in models {
            state.models[path] = EditorRuntimeState.ModelEntry(dirty: dirty)
        }
        state.current = current
        state.openFailures = failures
        return state
    }

    func testAPathlessTabAndASessionWithNoEditorEachRenderTheirOwnSentence() {
        XCTAssertEqual(editorViewportPlan(targetPath: nil, roots: .present, state: ready()),
                       .renderState(.noFile))
        XCTAssertEqual(editorViewportPlan(targetPath: "", roots: .present, state: ready()),
                       .renderState(.noFile))
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .none, state: nil),
                       .renderState(.noWorkingDirectory))
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .unknown, state: nil),
                       .renderState(.resolvingSession),
                       "not yet is a spinner, never the dirless claim")
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: nil),
                       .renderState(.resolvingSession),
                       "roots but no runtime is the beat before one is resolved, not 'none'")
    }

    /// `.failed` is TERMINAL (`EditorRuntimeState.Phase`) — the tab renders the sentence and offers
    /// nothing, because recovery is a teardown and a fresh runtime, which is the host's decision.
    func testAFailedRuntimeRendersItsOwnReasonAndAsksForNothing() {
        var failed = EditorRuntimeState()
        failed.phase = .failed
        failed.failureReason = "this build embeds no editor assets"
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: failed),
                       .renderState(.failed(reason: "this build embeds no editor assets")))

        failed.failureReason = nil
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: failed),
                       .renderState(.failed(reason: editorViewportUnknownFailureReason)),
                       "a reason-less failure still says something true rather than an empty line")
    }

    /// The restore path: an idle runtime is ASKED rather than waited on (an open is its own
    /// pre-warm), and a booting one is asked only if nothing has queued this file already.
    func testAColdOrBootingRuntimeIsAskedExactlyOnceForTheFileItDoesNotHaveQueued() {
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present,
                                          state: EditorRuntimeState()),
                       .openThenActivate(path: Self.file),
                       "an open is its own pre-warm — a cold runtime is asked, not waited on")

        var booting = EditorRuntimeState()
        booting.phase = .booting
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: booting),
                       .openThenActivate(path: Self.file),
                       "the panel's reveal pre-warm knows nothing about which files any tab wants")

        booting.pendingOpens = [Self.file]
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: booting),
                       .renderState(.booting),
                       "already queued: wait, and show the same spinner a boot shows")
    }

    /// **The mount/activate/quiet triangle — and `.activateOnly` is the drift re-assert.**
    ///
    /// `openModel` ends in the page's own `activateModel` and queued opens flush UNORDERED (T3's
    /// carried note), so a sibling tab's slower read can steal the editor out from under a mounted
    /// viewport. `.activateOnly` is what takes it back; `.upToDate` is what stops the applier firing
    /// one CDP call per keystroke, since every `modelDirtyChanged` publishes new state.
    func testAReadyRuntimeMountsActivatesOrSaysNothingAccordingToWhatIsAlreadyTrue() {
        let state = ready(models: [Self.file: false, Self.otherFile: false], current: Self.file)

        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: state,
                                          isViewportHost: false),
                       .adoptAndActivate(path: Self.file),
                       "a viewport that does not hold the view adopts it")
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: state,
                                          isViewportHost: true),
                       .upToDate(path: Self.file),
                       "mounted and already showing this file: send NOTHING")
        XCTAssertEqual(editorViewportPlan(targetPath: Self.otherFile, roots: .present, state: state,
                                          isViewportHost: true),
                       .activateOnly(path: Self.otherFile),
                       "the page drifted onto another file — take it back without moving a view")

        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present,
                                          state: ready(models: [Self.file: false], current: nil),
                                          isViewportHost: true),
                       .activateOnly(path: Self.file),
                       "a page showing NOTHING (drill 9's closeActive) is drift too")
    }

    /// The SwiftUI slot cannot know whether the shared view is already in its rectangle — only an
    /// `NSView` can — so it leaves `isViewportHost` at its default. That default must be SAFE: the
    /// only thing it can cost is a `.upToDate`/`.activateOnly` answering as `.adoptAndActivate`, and
    /// all three mount the same view.
    func testTheDefaultViewportHostAnswerOnlyEverCostsAnAdoptNeverAWrongState() {
        let state = ready(models: [Self.file: false], current: Self.file)
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: state),
                       .adoptAndActivate(path: Self.file))
        for isHost in [true, false] {
            let plan = editorViewportPlan(targetPath: Self.file, roots: .present, state: state,
                                          isViewportHost: isHost)
            switch plan {
            case .adoptAndActivate, .activateOnly, .upToDate: break
            default: XCTFail("isViewportHost: \(isHost) must still mount the editor, got \(plan)")
            }
        }
    }

    /// **Obligation: `models[path] == nil` is not "file missing".** The failure has to be an
    /// explicit signal, and a model that opened beats a stale failure entry either way.
    func testAMissingModelIsAWaitAndOnlyAnExplicitFailureIsAMissingFile() {
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: ready()),
                       .openThenActivate(path: Self.file),
                       "no model and no failure means READ IT, not 'File not found'")

        let failed = ready(failures: [Self.file: .notFound])
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: failed),
                       .renderState(.openFailed(path: Self.file, failure: .notFound)))

        let bothWays = ready(models: [Self.file: false], current: Self.file,
                             failures: [Self.file: .notFound])
        XCTAssertEqual(editorViewportPlan(targetPath: Self.file, roots: .present, state: bothWays),
                       .adoptAndActivate(path: Self.file),
                       "a file that opened is not a file that could not be opened")
    }

    // MARK: - The chrome's two readings (PURE)

    func testTheChromeNamesTheFileByItsLastTwoComponentsAndNeverDrawsABlankRow() {
        XCTAssertEqual(editorTabDisplayPath(path: "/Users/k/repo/src/engine.ts",
                                            fallbackTitle: "Code"), "src/engine.ts")
        XCTAssertEqual(editorTabDisplayPath(path: "/engine.ts", fallbackTitle: "Code"), "engine.ts")
        XCTAssertEqual(editorTabDisplayPath(path: nil, fallbackTitle: "Code"), "Code",
                       "a code tab with no file still names itself")
        XCTAssertEqual(editorTabDisplayPath(path: "", fallbackTitle: "engine.ts"), "engine.ts")
    }

    func testTheDirtyDotIsThePagesOwnAnswerAndNothingElse() {
        XCTAssertFalse(editorTabIsDirty(state: nil, path: Self.file), "no editor, no dot")
        XCTAssertFalse(editorTabIsDirty(state: ready(), path: Self.file), "no model, no dot")
        XCTAssertFalse(editorTabIsDirty(state: ready(models: [Self.file: false]), path: Self.file))
        XCTAssertTrue(editorTabIsDirty(state: ready(models: [Self.file: true]), path: Self.file))
        XCTAssertFalse(editorTabIsDirty(state: ready(models: [Self.otherFile: true]),
                                        path: Self.file),
                       "another file's unsaved work is not this tab's dot")
        XCTAssertFalse(editorTabIsDirty(state: ready(models: [Self.file: true]), path: nil))
    }

    // MARK: - Why a file could not be opened (PURE)

    /// "File not found" for a file that is right where the user left it — a directory, a permission
    /// refusal, a binary — would send them looking for something that never moved.
    func testAReadFailureIsClassifiedByWhatActuallyWentWrong() {
        XCTAssertEqual(editorOpenFailure(for: NSError(domain: NSCocoaErrorDomain,
                                                      code: NSFileReadNoSuchFileError)), .notFound)
        XCTAssertEqual(editorOpenFailure(for: NSError(domain: NSCocoaErrorDomain,
                                                      code: NSFileNoSuchFileError)), .notFound,
                       "the older file-manager code is the same fact")
        XCTAssertEqual(editorOpenFailure(for: EditorFileReadError.notUTF8(path: Self.file)),
                       .unreadable(reason: "This file isn't UTF-8 text."))

        let denied = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)
        XCTAssertEqual(editorOpenFailure(for: denied),
                       .unreadable(reason: denied.localizedDescription),
                       "the system's own sentence is carried through rather than invented")

        XCTAssertEqual(editorOpenFailureTitle(.notFound), "File not found")
        XCTAssertEqual(editorOpenFailureTitle(.unreadable(reason: "…")), "This file can't be opened")
    }

    // MARK: - The runtime's side of the explicit signal

    /// Gated on `.ready`, refused for a path that has a model, and cleared by everything that
    /// supersedes it. The retry clear is the one that matters visibly: T6's tree click on a file the
    /// agent has just created must show a spinner, not the stale sentence it showed a second ago.
    func testTheOpenFailureIsRecordedOnlyWhereItCanBeTrueAndClearedByEverythingThatSupersedesIt() {
        var booting = EditorRuntimeState()
        booting.phase = .booting
        let (stillBooting, _) = EditorRuntimeReducer.reduce(booting,
                                                            .openFailed(path: Self.file,
                                                                        failure: .notFound))
        XCTAssertTrue(stillBooting.openFailures.isEmpty,
                      "a read landing after a teardown must not condemn a fresh state")

        let live = ready(models: [Self.file: false])
        let (unchanged, _) = EditorRuntimeReducer.reduce(live, .openFailed(path: Self.file,
                                                                          failure: .notFound))
        XCTAssertTrue(unchanged.openFailures.isEmpty, "a live model is the newer truth")

        let (recorded, _) = EditorRuntimeReducer.reduce(ready(),
                                                        .openFailed(path: Self.file,
                                                                    failure: .notFound))
        XCTAssertEqual(recorded.openFailures[Self.file], .notFound)

        let (retried, retryEffects) = EditorRuntimeReducer.reduce(recorded,
                                                                  .openRequested(path: Self.file))
        XCTAssertTrue(retried.openFailures.isEmpty, "a retry supersedes the sentence it replaces")
        XCTAssertEqual(retryEffects, [.openModel(path: Self.file)])

        let (opened, _) = EditorRuntimeReducer.reduce(recorded, .modelOpened(path: Self.file))
        XCTAssertTrue(opened.openFailures.isEmpty)

        let (closed, _) = EditorRuntimeReducer.reduce(recorded, .closeRequested(path: Self.file))
        XCTAssertTrue(closed.openFailures.isEmpty, "a closed tab's failure is nobody's to render")

        let (tornDown, _) = EditorRuntimeReducer.reduce(recorded, .teardownRequested)
        XCTAssertEqual(tornDown, EditorRuntimeState())
    }

    /// A `.failed` runtime absorbs an open — and must not even clear a failure entry on the way,
    /// because nothing is going to act on the ask.
    func testAFailedRuntimeAbsorbsAnOpenWithoutTouchingAnything() {
        var failed = ready(failures: [Self.file: .notFound])
        failed.phase = .failed
        let (after, effects) = EditorRuntimeReducer.reduce(failed, .openRequested(path: Self.file))
        XCTAssertEqual(after, failed)
        XCTAssertTrue(effects.isEmpty)
    }

    /// **End to end, on the REAL reader:** a path that is not there records `.notFound` and opens no
    /// model, and the tab's plan turns that into the one sentence the spec names.
    func testARealMissingFileBecomesFileNotFoundAndNeverAModel() async {
        let harness = makeRuntime(files: nil)
        boot(harness)
        let missing = NSTemporaryDirectory() + "norma-editor-tab-tests-\(UUID().uuidString)/gone.ts"

        await harness.runtime.openFile(missing)

        XCTAssertEqual(harness.runtime.stateSnapshot.openFailures[missing], .notFound)
        XCTAssertTrue(harness.runtime.stateSnapshot.models.isEmpty,
                      "a failed read records NO model — the page and Swift must not disagree")
        XCTAssertEqual(cdpTypes(harness.cef), [],
                       "nothing was sent to the page (boot's own setTheme is asserted and drained "
                       + "there)")

        XCTAssertEqual(editorViewportPlan(targetPath: missing, roots: .present,
                                          state: harness.runtime.stateSnapshot),
                       .renderState(.openFailed(path: missing, failure: .notFound)))
    }

    // MARK: - The viewport: adopt, and give it back EXPLICITLY

    /// **The carried obligation, driven rather than argued.**
    ///
    /// `EditorRuntime.viewportHost` is `weak`, and weak zeroing does NOT run `didSet` — so a
    /// viewport that merely deallocated would leave the runtime believing its view is mounted in a
    /// rectangle that no longer exists. The proof that the `nil` was **SET** rather than dropped is
    /// the park it triggers: `didSet` → `mountEditorView` → `parkEditorView`, which BUILDS the hidden
    /// window (`hasHiddenWindow` is false until something parks) and takes the container back out of
    /// the host view. Both are asserted, because either alone could be an accident.
    func testUnmountingAViewportPutsTheEditorBackInItsHiddenWindowExplicitly() {
        let harness = makeRuntime()
        let hostView = EditorViewportHostView(runtime: harness.runtime, path: Self.file)
        hostView.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        XCTAssertFalse(harness.runtime.hasHiddenWindow,
                       "nothing has parked yet — this is the discriminator the assertion below uses")

        harness.runtime.viewportHost = hostView

        XCTAssertTrue(harness.runtime.viewportHost === hostView)
        XCTAssertEqual(hostView.subviews.count, 1, "the runtime's container is on screen here")
        XCTAssertEqual(hostView.subviews.first?.frame, hostView.bounds,
                       "sized to the viewport — a container created unsized lays Monaco out at zero")
        XCTAssertEqual(hostView.subviews.first?.autoresizingMask, [.width, .height])
        XCTAssertFalse(harness.runtime.hasHiddenWindow)

        EditorViewportView.dismantleNSView(hostView, coordinator: ())

        XCTAssertNil(harness.runtime.viewportHost)
        XCTAssertTrue(harness.runtime.hasHiddenWindow,
                      "the nil was SET: `didSet` ran and parked the container, which is exactly what "
                      + "weak zeroing would NOT have done")
        XCTAssertTrue(hostView.subviews.isEmpty, "…and the container really left the viewport")
    }

    /// SwiftUI does not promise to dismantle the outgoing view before building the incoming one, so
    /// the explicit `nil` must be conditional: nilling after the next tab's viewport has adopted the
    /// editor would park a container the user is looking at.
    func testADismantledViewportNeverTakesTheEditorFromTheOneThatSucceededIt() {
        let harness = makeRuntime()
        let outgoing = EditorViewportHostView(runtime: harness.runtime, path: Self.file)
        let incoming = EditorViewportHostView(runtime: harness.runtime, path: Self.otherFile)
        harness.runtime.viewportHost = outgoing
        harness.runtime.viewportHost = incoming

        EditorViewportView.dismantleNSView(outgoing, coordinator: ())

        XCTAssertTrue(harness.runtime.viewportHost === incoming,
                      "the survivor keeps the editor")
        XCTAssertEqual(incoming.subviews.count, 1)
        XCTAssertFalse(harness.runtime.hasHiddenWindow, "nothing parked — nothing should have")
    }

    /// A dismantled viewport is finished: a late window join (AppKit's own ordering, not ours) must
    /// not take the editor back — including through the deferred door, whose whole nature is to land
    /// after the moment that asked for it.
    func testADismantledViewportRefusesToAdoptAnythingLater() async {
        let harness = makeRuntime()
        let hostView = EditorViewportHostView(runtime: harness.runtime, path: Self.file)
        EditorViewportView.dismantleNSView(hostView, coordinator: ())

        hostView.adoptEditorView(NSView())
        hostView.apply()
        hostView.applyAfterUpdate()
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertTrue(hostView.subviews.isEmpty)
        XCTAssertNil(harness.runtime.viewportHost)
    }

    /// **The mount happens a turn late, on purpose.** `makeNSView`/`updateNSView` run inside
    /// SwiftUI's update pass, and adopting there would publish the runtime's state change from
    /// inside a view update — the same trap `bind` avoids on the model's side. Two asks coalesce
    /// into one apply, which is what a mount actually looks like (make + window join + first
    /// update, all in the same breath).
    func testTheViewportMountsOnTheNextTurnAndCoalescesTheAsksThatArriveTogether() async {
        let harness = makeRuntime(files: [Self.file: "let a = 1\n"])
        boot(harness)
        await harness.runtime.openFile(Self.file)
        XCTAssertEqual(drain(harness.cef), ["openModel"])

        let hostView = EditorViewportHostView(runtime: harness.runtime, path: Self.file)
        hostView.applyAfterUpdate()
        hostView.applyAfterUpdate()
        XCTAssertNil(harness.runtime.viewportHost,
                     "nothing happens inside the pass that asked for it")

        await waitUntil("the deferred mount") { harness.runtime.viewportHost === hostView }
        XCTAssertEqual(cdpTypes(harness.cef), ["activateModel"],
                       "coalesced — one apply, not one per ask")
    }

    /// **The drift re-assert, through the real objects.** A sibling's open steals the page (that is
    /// what `openModel` does — it ends in the page's own `activateModel`); the mounted viewport's
    /// next update takes it back, and the one after that says nothing at all.
    func testAMountedViewportTakesThePageBackWhenAnotherOpenStealsItAndThenGoesQuiet() async {
        let harness = makeRuntime(files: [Self.file: "let a = 1\n", Self.otherFile: "let b = 2\n"])
        boot(harness)

        await harness.runtime.openFile(Self.file)
        XCTAssertEqual(drain(harness.cef), ["openModel"])
        XCTAssertEqual(harness.runtime.stateSnapshot.current, Self.file)

        let hostView = EditorViewportHostView(runtime: harness.runtime, path: Self.file)
        hostView.apply()
        XCTAssertTrue(harness.runtime.viewportHost === hostView, "the mount adopts")
        XCTAssertEqual(drain(harness.cef), ["activateModel"], "…and shows this tab's file")

        // The steal: another tab's queued read lands late and the page switches under this viewport.
        await harness.runtime.openFile(Self.otherFile)
        XCTAssertEqual(drain(harness.cef), ["openModel"])
        XCTAssertEqual(harness.runtime.stateSnapshot.current, Self.otherFile)

        hostView.apply()

        XCTAssertEqual(cdpTypes(harness.cef), ["activateModel"])
        XCTAssertTrue(cdpPayloads(harness.cef).last?.contains(Self.file) == true,
                      "…for THIS tab's file, not the one that stole the page")
        XCTAssertEqual(harness.runtime.stateSnapshot.current, Self.file)
        drain(harness.cef)

        hostView.apply()
        hostView.apply()
        XCTAssertEqual(cdpTypes(harness.cef), [],
                       "an up-to-date viewport sends NOTHING — every keystroke publishes new state, "
                       + "and an unguarded applier would fire one CDP call per one of them")
    }

    // MARK: - The tab model: the lazy read, and the runtimes it must not confuse

    /// A restored code tab reads its file — **once**, however many times anything asks. The guard has
    /// to survive re-entry: the read is asynchronous, so the plan still says `openThenActivate` for
    /// the whole time it is in flight.
    func testARestoredCodeTabReadsItsFileOnceHoweverOftenItIsAsked() async {
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let host = await makeHost(box)
        let harness = makeRuntime(files: [Self.file: "let a = 1\n"])
        host.makeEditorRuntime = { _ in harness.runtime }
        boot(harness)

        let model = PanelEditorTabModel(tabId: "t1", path: Self.file)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        // Every one of these lands while the read is still in flight — no `await` has run yet, so
        // the state cannot have moved. Only the guard can stop them.
        model.requestOpenIfNeeded()
        model.requestOpenIfNeeded()
        model.refreshForTesting()

        await waitUntil("the file to reach the page") { self.cdpTypes(harness.cef).contains("openModel") }
        XCTAssertEqual(cdpTypes(harness.cef), ["openModel"],
                       "ONE read, however many times it was asked for (boot's `setTheme` is asserted "
                       + "and drained there — Task 4's shift, accounted for by name)")
        XCTAssertEqual(model.roots, .present)
    }

    /// **A FRESH runtime is a fresh ask.** A clean departure releases a session's editor and the
    /// return mints a new one holding no models at all (the spec's reattach rule); a tab that
    /// remembered "I already asked" would sit on a spinner forever. Keyed on the runtime by weak
    /// reference rather than by identifier, so a reused allocation address cannot falsely match.
    func testAFreshRuntimeAfterATeardownGetsTheOpenAgain() async {
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let host = await makeHost(box)
        let first = makeRuntime(files: [Self.file: "let a = 1\n"])
        var harnesses = [first]
        host.makeEditorRuntime = { _ in
            harnesses.count == 1 ? first.runtime : harnesses[1].runtime
        }
        boot(first)

        let model = PanelEditorTabModel(tabId: "t1", path: Self.file)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        await waitUntil("the first read") { self.cdpTypes(first.cef).contains("openModel") }

        // The departure, and the return: a genuinely different object, minted by the host.
        host.teardownEditorRuntime(for: "S1")
        let second = makeRuntime(sessionId: "S1", files: [Self.file: "let a = 1\n"], browserId: 42)
        harnesses.append(second)
        boot(second, browserId: 42)

        model.refreshForTesting()

        await waitUntil("the second read") { self.cdpTypes(second.cef).contains("openModel") }
        XCTAssertEqual(cdpTypes(second.cef), ["openModel"],
                       "the new runtime holds no models — the tab must ask it again")
        XCTAssertFalse(first.runtime === second.runtime)
    }

    /// **fix round 1 — the resurrection pin.** Adapted from the review's own probe, which measured
    /// this: after a departure, ONE `session.list` poll tick was enough to mint a second runtime,
    /// create a hidden Chromium and re-read the file for a session the user had left — and nothing
    /// would ever release it, because a departure releases exactly once and it had already happened.
    /// The quieter half is worse: that re-read lands ~5 s after departure, so a return an hour later
    /// shows a buffer stale against everything the agent wrote since.
    ///
    /// Departure is driven through the REAL door the product uses — the panel leaving the session
    /// (`PanelStore.switchSession`, which every hop/attach goes through) plus the release the shell
    /// performs — rather than the probe's shortcut, and the model is taken from the REGISTRY, since
    /// the registry outliving the tab is the mechanism under test.
    func testTheSessionListPollAloneNeverResurrectsADepartedSessionsEditor() async {
        let box = RowsBox()
        let dirs = [SessionDirEntry(path: "/repo", locked: false)]
        box.rows = [dirRow("S1", dirs: dirs), dirRow("S2", dirs: dirs)]
        let host = await makeHost(box)
        let first = makeRuntime(files: [Self.file: "let a = 1\n"])
        let second = makeRuntime(sessionId: "S1", files: [Self.file: "let a = 1\n"], browserId: 42)
        var mints = 0
        host.makeEditorRuntime = { _ in
            mints += 1
            return mints == 1 ? first.runtime : second.runtime
        }
        boot(first)

        // The panel is showing S1's code tab: the model comes from the registry, subscribes, reads.
        host.panelStore.switchSession(to: "S1")
        let tab = PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")
        let model = PanelEditorTabModels.model(for: tab, host: host, sessionId: "S1")
        model.activate()
        await waitUntil("the first read") { self.cdpTypes(first.cef).contains("openModel") }
        XCTAssertEqual(host.editorRuntimes.count, 1)

        // The hop: the panel leaves S1, and the shell releases its clean editor.
        host.panelStore.switchSession(to: "S2")
        host.teardownEditorRuntime(for: "S1")
        XCTAssertEqual(host.editorRuntimes.count, 0, "released on departure")

        // Five seconds later the poll ticks. That is ALL that happens — and then some: even a view
        // being torn down calling `activate`/`refresh` on the retired model must change nothing.
        await host.directory.refresh()
        model.activate()
        model.refreshForTesting()
        try? await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertEqual(host.editorRuntimes.count, 0, "a departed session's editor stays released")
        XCTAssertEqual(second.cef.createdURLs, [],
                       "no hidden Chromium for a session the user has left")
        XCTAssertEqual(mints, 1, "the poll mints nothing")
        XCTAssertEqual(second.runtime.stateSnapshot.pendingOpens, [],
                       "…and re-reads nothing: a silently stale buffer is the half that survives to "
                       + "T8's save")

        // **The genuine return still mints and still re-reads** (the spec's reattach rule): a fresh
        // model, because the retired one left the registry with the session it belonged to.
        host.panelStore.switchSession(to: "S1")
        let returned = PanelEditorTabModels.model(for: tab, host: host, sessionId: "S1")
        XCTAssertFalse(returned === model, "the registry mints a fresh model for the return")
        returned.activate()

        await waitUntil("the return's own read") {
            second.runtime.stateSnapshot.pendingOpens.contains(Self.file)
        }
        XCTAssertEqual(mints, 2)
        XCTAssertEqual(second.cef.createdURLs, [EditorRuntime.pageURL],
                       "an open is its own pre-warm — the return boots the fresh runtime")
    }

    /// **A dirless session never stands a hidden Chromium up** — and says so calmly.
    func testADirlessSessionMintsNoEditorAndSaysSo() async {
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [])]
        let host = await makeHost(box)
        let harness = makeRuntime()
        host.makeEditorRuntime = { _ in harness.runtime }

        let model = PanelEditorTabModel(tabId: "t1", path: Self.file)
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertNil(host.editorRuntimeForCodeTab(sessionId: "S1"))
        XCTAssertEqual(host.editorRuntimes.count, 0)
        XCTAssertEqual(harness.cef.createdURLs, [])
        XCTAssertEqual(model.roots, .none)
        XCTAssertEqual(model.plan, .renderState(.noWorkingDirectory))
        XCTAssertFalse(model.isDirty)
    }

    /// **The row arrives late, and the tab recovers on its own.** The panel can be showing a code tab
    /// before the session's row lands (the create-then-navigate race), and the tab observes
    /// `SessionDirectory.rows` precisely so the "not yet" spinner cannot stick.
    func testALateArrivingRowTurnsTheSpinnerIntoAnEditorWithoutAnybodyAsking() async {
        let box = RowsBox()
        let host = await makeHost(box)
        let harness = makeRuntime(files: [Self.file: "let a = 1\n"])
        host.makeEditorRuntime = { _ in harness.runtime }
        boot(harness)

        let model = PanelEditorTabModel(tabId: "t1", path: Self.file)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        XCTAssertEqual(model.roots, .unknown)
        XCTAssertEqual(model.plan, .renderState(.resolvingSession),
                       "an absent row is a wait, never 'this session has no working directory'")
        XCTAssertEqual(host.editorRuntimes.count, 0, "and nothing is minted on a guess")

        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        await host.directory.refresh()

        await waitUntil("the file to reach the page") { self.cdpTypes(harness.cef).contains("openModel") }
        XCTAssertEqual(model.roots, .present)
        XCTAssertEqual(host.editorRuntimes.count, 1)
    }

    // MARK: - The tab itself

    /// The factory pin lives in `CEFRuntimeTests` beside `.web`/`.diff`'s (the one place every kind's
    /// routing is stated together). This states what the tab IS once built — and that its save glyph
    /// is a real symbol, since a name that resolves to nothing draws an empty button and nothing else
    /// in the suite would notice.
    func testACodeTabIsAnEditorViewportWithTheFilesOwnIdentity() {
        let tab = PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")
        let content = panelTabContent(for: tab)
        guard let editor = content as? PanelEditorTab else {
            return XCTFail("a code tab must render the editor viewport, got \(type(of: content))")
        }
        XCTAssertEqual(editor.kind, .code)
        XCTAssertEqual(editor.title, "engine.ts")
        XCTAssertEqual(editor.model.path, Self.file, "a code tab's url IS its absolute path")
        XCTAssertNotNil(NSImage(systemSymbolName: "arrow.down.doc", accessibilityDescription: nil),
                        "the save button's glyph is not a real SF Symbol")

        // The registry hands the SAME model to both slots — the chrome's dirty dot and the content's
        // viewport must never describe two different editors.
        let again = panelTabContent(for: tab) as? PanelEditorTab
        XCTAssertTrue(again?.model === editor.model)

        // A tab whose file changed identity is REPLACED, never re-bound onto another file's buffer.
        let moved = PanelTab(tabId: "t1", kind: .code, url: Self.otherFile, title: "panel.ts")
        let replaced = panelTabContent(for: moved) as? PanelEditorTab
        XCTAssertFalse(replaced?.model === editor.model)
        XCTAssertEqual(replaced?.model.path, Self.otherFile)

        PanelEditorTabModels.discard(tabId: "t1")
        let afterClose = panelTabContent(for: tab) as? PanelEditorTab
        XCTAssertFalse(afterClose?.model === replaced?.model, "closing a tab drops its model")
    }

    // MARK: - editor-product Task 10: the tab-close gate (PURE)

    /// **The dirty×choice matrix, exhaustively** (design notes' own words). `dirty: false` answers
    /// `.close` for every choice — proving "a clean tab never asks" as a fact about the function,
    /// not merely about the one call site (`ShellSessionHost.requestCloseTab`) that only ever
    /// reaches this with `dirty: true` in practice.
    func testDirtyCloseActionIsTheExhaustiveDirtyByChoiceMatrix() {
        for choice: DirtyCloseChoice in [.save, .discard, .cancel] {
            XCTAssertEqual(dirtyCloseAction(dirty: false, choice: choice), .close,
                           "a clean tab closes silently whatever the (hypothetical) choice — \(choice)")
        }
        XCTAssertEqual(dirtyCloseAction(dirty: true, choice: .save), .awaitSave)
        XCTAssertEqual(dirtyCloseAction(dirty: true, choice: .discard), .close)
        XCTAssertEqual(dirtyCloseAction(dirty: true, choice: .cancel), .keepOpen)
    }

    /// The second, smaller decision — what a `.save` becomes once the coordinator actually answers.
    /// `.failed` is the ONE outcome that does not close: T9's banner already carries the sentence,
    /// and closing here would take the tab (and the explanation) away together.
    func testDirtyCloseActionAfterSaveClosesOnSavedAndNoModelButKeepsOpenOnFailed() {
        XCTAssertEqual(dirtyCloseActionAfterSave(.saved), .close)
        XCTAssertEqual(dirtyCloseActionAfterSave(.noModel), .close,
                       "nothing to save is discard-able, not a reason to keep the tab open")
        XCTAssertEqual(dirtyCloseActionAfterSave(.failed("disk full")), .keepOpen)
    }
}
