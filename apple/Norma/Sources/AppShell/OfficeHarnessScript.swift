import Foundation

/// office-plumbing Task 9 — **the Office Harness's drill plan: an ordered, pure list of what runs
/// and in what order.** Mirrors `EditorHarnessScript.swift`'s own split (effects live in the
/// `#if DEBUG` harness next door; the PLAN is ordinary `Foundation` data with no helper process, no
/// socket and no clock anywhere in it) — deliberately simpler than that file's own
/// `Expectation`/`Event`/`Verdict` state machine, because nothing here needs it. That machine exists
/// because a CEF bridge answers asynchronously through injected JavaScript with no way to `await` it
/// directly, so the editor's harness has to arm an expectation BEFORE acting and then judge whichever
/// message arrives against it. Every real call this harness makes — `OfficeRuntime.open`,
/// `OfficeHelperClient.open`, a raw `OfficeWireConnection` — is already `async`; a step's own action
/// can simply await its outcome (polling with its own bounded `waitUntil`, the same shape
/// `OfficeRuntimeLiveTests`/`OfficeHelperLiveSmokeTests` already use throughout this suite) and hand
/// back a definite verdict, so there is no separate "event arrived, judge it" layer to build.
///
/// **Not `#if DEBUG`, unlike the harness it serves** (`EditorHarnessScript.swift`'s own header gives
/// the identical reason): gating this would make the test bundle's ability to compile the PINS suite
/// depend on the build configuration, and this file is pure data with no instantiation of anything
/// helper-shaped.
///
/// What stays identical to the editor's own plan: a stable, unique id per step (the harness's action
/// switch matches on it), a drill number every step names (the transcript groups by it, and the pins
/// suite asserts the whole list is already in drill order), and a titled group per drill so the
/// transcript reads as twenty-six claims rather than eighty-eight lines (office-editable Task 10
/// appended Stage B's own drills 13-25 after Stage A's original thirteen, 0-12).
struct OfficeHarnessStep: Equatable {
    /// Stable, unique, and the key `OfficeHarness`'s action switch matches on (`"3.cold"`,
    /// `"8.reopen"`, ...).
    let id: String
    /// Which of the plan's drills this step belongs to.
    let drill: Int
    /// One line, for the harness window and the transcript.
    let title: String
    /// How long the step's own action may run before the harness records a timeout failure and moves
    /// on. Every action bounds its OWN internal waits within this budget — see `OfficeHarness.swift`'s
    /// own header for the "arm a deadline, then poll" pattern every step follows; nothing here is a
    /// separate wall-clock timer racing the action from outside.
    let timeout: TimeInterval
}

enum OfficeHarnessPlan {

    static let drillTitles: [Int: String] = [
        0: "setup — scratch dirs, the second-copy dance, a session host wired at a scratch supervisor",
        1: "helper boot + version pin echo (BuildId from VERSION-PIN)",
        2: "open ×6 formats with type/parts/size assertions; a garbage path openFails, the helper survives",
        3: "tile arrival — a non-blank pixel hash, stable across an evict-and-resubscribe repaint",
        4: "the alpha-byte scan — premultiplied-vs-straight settled empirically, or flagged if not",
        5: "a two-sheet fixture, templated at drill time — part 1 tiles pixel-distinct from part 0",
        6: "external change — silent reload; deleted persists a banner; the file coming back clears it",
        7: "the mirror-case drill — overwrite then delete inside the reload round trip, documented not fixed",
        8: "helper SIGKILL — supervisor .helperDied, the tab's failure state, reopen recovers",
        9: "scroll/zoom viewport churn — rapid scroll during a cold fill, zoom-step re-request correctness",
        10: "idle-exit — close all docs on a DEDICATED helper, it exits within the production bound",
        11: "second-copy hygiene — every scratch path this run touched stays under its own root",
        12: "wire sanity — the document kind's wire shape, pinned; this harness runs daemonless",
        13: "Stage B: sandbox probes — write-inside/outside-fence, outbound-connect-denied, live against the embedded production helper",
        14: "Stage B: typing -> invalidation -> a genuinely fresh tile",
        15: "Stage B: caret/selection overlay presence, off OfficeCursorStore",
        16: "Stage B: IME composition (the ext-text-input door) -> a fresh tile",
        17: "Stage B: clipboard round-trip — copy returns exactly the selection, paste doubles it on disk",
        18: "Stage B: the undo ladder + redo, then the two-view pair's own pinned undo characterization",
        19: "Stage B: Cmd-S round-trip + the no-self-reload suppression proof",
        20: "Stage B: autosave crash-recovery — SIGKILL mid-dirty, reopen, Restore, save lands the recovered content",
        21: "Stage B: dirty-close/quit — the pure gate predicate (the sheet/alert themselves are the human live gate's own item)",
        22: "Stage B: formula-bar tracking — cell cursor + formula text follow a click and an arrow key",
        23: "Stage B: multi-slide nav — two-slide.fodp, part 1 pixel-distinct from part 0",
        24: "Stage B: legacy-format opens — the widened set (xlsm/odg) pass through; a CFB file under a modern extension refuses cleanly",
        25: "Stage B hygiene re-check — the new drills' own scratch/helper footprint stays inside this run's own root too",
        26: "Stage C: the agent's command channel — the real routing fork, an UNRECOGNIZED verb refused loudly, an out-of-fence verb refused without writing",
        27: "Stage C: sheets — a command arrives, the OPEN tab repaints, the file on disk changed (branch-aware, no unconditional causal claim)",
        28: "Stage C: docs — the same three-part chain in a second tool family, sealed against the SAVED BYTES",
        29: "Stage C hygiene re-check — the agent drills' own footprint stays inside this run's own root too"
    ]

    /// The whole run, in order. Every step names the drill it belongs to so the transcript can be
    /// read as twenty-six claims rather than eighty-eight lines — the same reason
    /// `EditorHarnessFixtures.steps(_:)` gives for the identical shape.
    static let steps: [OfficeHarnessStep] = [
        step("0.setup", 0, "scratch dirs + a ShellSessionHost wired at a scratch OfficeHelperSupervisor", 30),

        step("1.boot", 1, "a dedicated throwaway helper boots and completes hello", 40),
        step("1.version", 1, "lokVersion matches VERSION-PIN's LIBREOFFICE_CORE_COMMIT", 5),
        step("1.teardown", 1, "the throwaway helper is torn down before the shared one ever boots", 10),

        step("2.xlsx", 2, "open gate.xlsx — type/parts/size", 40),
        step("2.ods", 2, "open gate.ods — type/parts/size", 15),
        step("2.pptx", 2, "open gate.pptx — type/parts/size", 15),
        step("2.odp", 2, "open gate.odp — type/parts/size", 15),
        step("2.docx", 2, "open gate.docx — type/parts/size", 15),
        step("2.odt", 2, "open gate.odt — type/parts/size", 15),
        step("2.garbage", 2, "a nonexistent path openFails and the helper survives the very next open", 15),

        step("3.cold", 3, "cold-fill gate.xlsx's viewport and hash a non-blank tile", 30),
        step("3.evict", 3, "evict the tile store for this docId — the next fill cannot be a cache hit", 5),
        step("3.resubscribe", 3, "a real repaint reproduces the identical hash", 30),

        step("4.scan", 4, "scan every alpha byte of every cold-filled tile", 10),

        step("5.build", 5, "a two-sheet flat-ODS fixture, templated at drill time (no soffice CLI exists to convert with)", 5),
        step("5.open", 5, "open it — parts == 2 against real LOK", 40),
        step("5.part0", 5, "fill part 0's tile (0,0)", 20),
        step("5.part1", 5, "subscribeTiles part 1 against real LOK, fill tile (0,0)", 20),
        step("5.distinct", 5, "part 1's tile is pixel-DISTINCT from part 0's at the same coordinates", 5),

        step("6.overwrite", 6, "overwrite gate.xlsx's scratch copy with different, valid content", 5),
        step("6.reload", 6, "a new docId, silently, evicting the old one's tiles", 30),
        step("6.freshTiles", 6, "fresh non-blank tiles arrive under the new docId", 30),
        step("6.delete", 6, "deleting the file raises a persistent banner", 15),
        step("6.restore", 6, "the file coming back clears the banner", 30),

        step("7.overwrite", 7, "overwrite gate.odt's scratch copy", 5),
        step("7.delayedDelete", 7, "delete ~120-200ms later — inside the reload round trip, on purpose", 5),
        step("7.observe", 7, "record the observed interleaving honestly — this documents it, does not fix it", 15),
        step("7.siblingTouch", 7, "touch a sibling file; the banner arrives if a document survived the interleaving", 15),

        step("8.capturePid", 8, "capture the shared helper's pid before the kill", 5),
        step("8.kill", 8, "SIGKILL the helper process directly — never supervisor.stop()", 5),
        step("8.diedObserved", 8, "the runtime observes .helperDied and fails every open document", 15),
        step("8.reopen", 8, "reopen via the retry affordance path (runtime.open re-issued) — bounded at 5s", 10),
        step("8.newPid", 8, "the respawned helper has a genuinely different pid", 5),

        step("9.rapidScroll", 9, "rapid scroll during a cold fill — bounded in-flight churn, no crash", 20),
        step("9.zoomStep", 9, "a zoom step re-requests exactly the correct tile set", 20),

        step("10.setup", 10, "a DEDICATED helper boots with the production 120s idle-exit default", 40),
        step("10.openClose", 10, "open then close a real document on it", 20),
        step("10.disconnect", 10, "close the connection cleanly — never a kill", 5),
        step("10.waitExit", 10, "idle-exit within the production bound, plus slack", 150),

        step("11.statePaths", 11, "every scratch socket/state path used this run lives under the harness's own root", 5),
        step("11.userCachesUntouched", 11, "the real Application Support Office directory is untouched by this run", 5),
        step("11.noDockPresence", 11, "no new Dock-visible app appeared as a side effect of this run", 5),

        step("12.kindWire", 12, "PanelTabKind.document's raw wire value is \"document\"", 5),
        step("12.router", 12, "panelTabKind(forFilePath:) classifies all six office extensions as .document", 5),
        step("12.daemonless", 12, "daemonless by construction — the wire shape is pinned via the codec, not a live panel.openTab", 5),

        // MARK: - office-editable Task 10: Stage B's own drills, appended after Stage A's 46

        step("13.writeInFence", 13, "a probe write UNDER --state-path succeeds (sanity control)", 15),
        step("13.writeOutFence", 13, "a probe write OUTSIDE --state-path is denied, errno EPERM, no file left behind", 15),
        step("13.networkDeny", 13, "a probe outbound connect() is denied, errno EPERM (anchored, never a bare rc!=0)", 15),

        step("14.open", 14, "open a fresh scratch copy of gate.odt for the typing drill", 35),
        step("14.coldTile", 14, "cold-fill its viewport, hash a non-blank tile", 25),
        step("14.type", 14, "click, then type a marker via postKeyEvent (the plain-commit door insertText uses)", 15),
        step("14.freshTile", 14, "the SAME tile key repaints with a DIFFERENT hash post-invalidation", 25),

        step("15.caretPresent", 15, "OfficeCursorStore reports a caret rect after typing", 10),
        step("15.select", 15, "Shift+Left selects the just-typed marker", 15),
        step("15.selectionPresent", 15, "OfficeCursorStore reports non-empty selection rects", 10),

        step("16.open", 16, "open a fresh scratch copy of gate.odt for the IME drill", 35),
        step("16.composeAndCommit", 16, "postExtTextInput .input (preedit) then .input+.end (composed commit)", 15),
        step("16.freshTile", 16, "the ext-text-input door's commit produces a real, fresh, non-blank tile", 25),

        step("17.open", 17, "open a fresh scratch copy of gate.odt for the clipboard drill", 35),
        step("17.typeSelectCopy", 17, "type a marker, select it, clipboardCopy returns exactly the marker", 15),
        step("17.pasteDoublesOnDisk", 17, "collapse the selection, paste, save — the real file carries the doubled text", 30),

        step("18.typeAndSave", 18, "type a marker, save, confirm it landed on the real path", 30),
        step("18.undoLadderThenRedo", 18, "undo (bounded by marker length) removes it; redo restores it — both confirmed on disk", 40),
        step("18.twoViewMintAndEditBoth", 18, "mint agent view B (a second mint is refused); edit via A then via B, both confirmed on disk", 30),
        step("18.twoViewUndoCharacterization", 18, "undo via A's primary door — PINNED: both edits survive (REFUSED/NO-OP, branch-aware)", 30),

        step("19.saveRoundTrip", 19, "type, saveAndAwaitOutcome succeeds, the real file carries the content", 30),
        step("19.noSelfReloadSuppression", 19, "Norma's own write does not trigger a spurious reload of itself", 10),

        step("20.setup", 20, "a DEDICATED helper with a 2s autosave interval boots; a fresh doc opens", 40),
        step("20.typeDirtyWaitSidecar", 20, "type a marker (dirty=true); the real autosave timer writes a sidecar; helper alive", 35),
        step("20.kill", 20, "an EXTERNAL SIGKILL (never stop()/forceKill) — the crash", 15),
        step("20.reopenAndRecoveryOffered", 20, "a fresh boot reopens the path; the recovery candidate names the CRASHED docId", 60),
        step("20.restoreAndSaveLands", 20, "restore forces dirty=true; Cmd-S lands the recovered marker on the real path; sidecar clears", 40),

        step("21.cleanNotGated", 21, "officeDirtyFilePaths is empty for a clean, freshly-opened document", 10),
        step("21.dirtyIsGated", 21, "officeDirtyFilePaths names a path after a real typed edit", 15),
        step("21.readOnlyFormatNeverGates", 21, "a forced modifiedChanged(true) on a read-only-format doc never appears in officeDirtyFilePaths (T9 F3)", 20),

        step("22.open", 22, "open a fresh scratch copy of gate.xlsx for the formula-bar drill", 35),
        step("22.clickCell", 22, "a click lands a cell cursor + formula text in OfficeCursorStore", 15),
        step("22.moveTracks", 22, "an arrow-key move changes the cell cursor/formula text — it TRACKS, not just appears once", 15),

        step("23.open", 23, "open the committed two-slide.fodp — parts == 2 against real LOK", 35),
        step("23.slide0Tile", 23, "fill slide 0's tile (0,0)", 25),
        step("23.slide1Distinct", 23, "subscribeTiles(part: 1) — the rail's own door — fills a tile pixel-DISTINCT from slide 0", 25),

        step("24.xlsmOpens", 24, "gate.xlsm (widened, read-only) opens with sane type/parts/size", 20),
        step("24.odgOpens", 24, "gate.odg (widened, read-only) opens as .drawing with sane type/parts/size", 20),
        step("24.cfbRefusal", 24, "legacy-doc.doc's own bytes renamed .docx refuse with the mapped house-voice sentence", 20),
        step("24.livenessAfterRefusal", 24, "a fresh good document opens normally on the SAME helper right after the refusal", 20),

        step("25.statePaths", 25, "every NEW scratch/helper path Stage B's drills touched still lives under this run's own root", 5),
        step("25.userCachesUntouched", 25, "the real Application Support Office directory is STILL untouched after Stage B's own drills", 5),

        // MARK: - office-agent-tools Task 9: Stage C's own drills, appended after Stage B's

        step("26.wire", 26, "a real PanelCommandConsumer over an INERT BrowserRuntime, wired at the host's REAL officeAgentBroker", 10),
        step("26.unrecognized", 26, "an office-namespaced verb nothing implements is REFUSED, loudly and within its deadline — never dropped", 20),
        step("26.outsideFence", 26, "a real verb aimed OUTSIDE the session's working directories is refused, and the target file is untouched", 30),

        step("27.open", 27, "open a fresh scratch gate.xlsx — the tab the agent is about to edit under", 40),
        step("27.baseline", 27, "cold-fill its viewport: a non-blank tile hash AND the file's own pre-command digest", 30),
        step("27.command", 27, "office.sheets.set arrives through the REAL consumer fork and answers within its deadline", 90),
        step("27.repaint", 27, "the OPEN tab's tile (0,0) was invalidated and repaints to a DIFFERENT hash", 40),
        step("27.disk", 27, "the file's bytes changed and the SAVED bytes carry the marker — verdict via the branch-aware classifier", 30),

        step("28.open", 28, "open a fresh scratch gate.odt for the docs half of the chain", 40),
        step("28.baseline", 28, "cold-fill its viewport: a non-blank tile hash AND the file's own pre-command digest", 30),
        step("28.command", 28, "office.docs.append arrives through the SAME fork and answers within its deadline", 90),
        step("28.repaint", 28, "the OPEN tab's tile (0,0) was invalidated and repaints to a DIFFERENT hash", 40),
        step("28.disk", 28, "the file's bytes changed and content.xml carries the appended marker — same classifier, second family", 30),

        step("29.statePaths", 29, "every NEW path Stage C's drills touched still lives under this run's own root", 5),
        step("29.userCachesUntouched", 29, "the real Application Support Office directory is STILL untouched after Stage C's own drills", 5)
    ]

    private static func step(_ id: String, _ drill: Int, _ title: String, _ timeout: TimeInterval) -> OfficeHarnessStep {
        OfficeHarnessStep(id: id, drill: drill, title: title, timeout: timeout)
    }
}

// MARK: - office-plumbing wave fix (T9 review I1) — the mirror-case's own classification, pure

/// Which of drill 7's (the mirror-case's) three legitimate outcomes `7.observe` recorded, or that
/// none of them fit. Not `#if DEBUG`, same reason `OfficeHarnessPlan` above isn't: this needs to be
/// callable from the pins suite with no live helper, no runtime, nothing helper-shaped at all.
enum OfficeHarnessMirrorCaseBranch: Equatable {
    /// The in-flight reopen's `.opened` landed AFTER the delete-fire's `.externalDeleted` — content
    /// shows for a file that is, at this instant, actually gone (the quiescent-directory window).
    case a
    /// The delete-fire's `.externalDeleted` landed AFTER the reopen's own `.opened` — the ordinary
    /// post-reload delete case.
    case b
    /// The delete landed before LOK's `open()` could read the file — the in-flight reopen failed.
    case c
    /// Neither branch A, B, nor C — a state `OfficeRuntimeReducer` should never produce (no document
    /// AND no openFailure). A poisoned state, not a fourth legitimate race outcome.
    case unrecognized
}

struct OfficeHarnessMirrorCaseObservation: Equatable {
    let branch: OfficeHarnessMirrorCaseBranch
    let verdict: String
    /// `false` exactly for `.unrecognized` — the one outcome this classification must fail closed
    /// on rather than pass silently (T9 review I1's own finding: the pre-fix code returned `true`
    /// for every branch, this one included).
    var recognized: Bool { branch != .unrecognized }
}

/// Extracted from `OfficeHarness.performObserve7` (T9 review I1) so the poisoned/UNRECOGNIZED
/// branch can be pinned by a plain unit test instead of only by reading the live-run transcript.
/// `hasDocument`/`banner`/`openFailure` are exactly `OfficeRuntimeState`'s own
/// `documents[path] != nil` / `documentBanners[path]` / `openFailures[path]`, read at the mirror-
/// case drill's own settle point.
func classifyOfficeHarnessMirrorCaseObservation(hasDocument: Bool, banner: String?, openFailure: String?)
    -> OfficeHarnessMirrorCaseObservation {
    if hasDocument, banner == nil {
        return OfficeHarnessMirrorCaseObservation(branch: .a, verdict:
            "BRANCH A (reload won, no banner) — the in-flight reopen's .opened landed AFTER "
          + "the delete-fire's .externalDeleted, clearing the banner along with everything "
          + "else .opened resets. Content shows for a file that is, at this instant, actually "
          + "gone — the quiescent-directory window the brief names.")
    } else if hasDocument, banner != nil {
        return OfficeHarnessMirrorCaseObservation(branch: .b, verdict:
            "BRANCH B (banner persisted) — the delete-fire's .externalDeleted landed AFTER "
          + "the reopen's own .opened; the ordinary post-reload delete case applied.")
    } else if !hasDocument, openFailure != nil {
        return OfficeHarnessMirrorCaseObservation(branch: .c, verdict:
            "BRANCH C (reopen failed) — the delete landed before LOK's open() could read the "
          + "file; the in-flight reopen failed via .reloadFailed (openFailures set, the "
          + "banner cleared by that arm's own post-review fix, c277793a).")
    } else {
        return OfficeHarnessMirrorCaseObservation(branch: .unrecognized, verdict:
            "UNRECOGNIZED state — hasDocument=\(hasDocument) banner=\(banner ?? "nil") "
          + "openFailure=\(openFailure ?? "nil") — a state the reducer should never produce, "
          + "not a legitimate race branch; failing rather than passing silently")
    }
}

// MARK: - office-agent-tools Task 9: the agent-write evidence chain, classified — pure

/// What drills 27/28 actually observed after an agent command, as ONE branch rather than four
/// independent booleans read by prose.
///
/// **Why a classifier and not three `guard`s.** The arc's own defect taxonomy has two entries this
/// shape exists to defeat. (1) *The vacuous drill*: three separate `guard`s let a step pass on the
/// two cheap conditions while the expensive one is quietly never reached. Folding all four
/// observations into one total function means every combination lands SOMEWHERE, and the ones that
/// are not a proof land on a branch that FAILS. (2) *No unconditional causal claims*: this function
/// is handed four FACTS — the consumer answered ok, the tile was evicted and repainted to a
/// different hash, the file's bytes differ, the saved bytes carry the marker — and it never says the
/// command CAUSED any of them. `.proven`'s own verdict says "after", not "because", deliberately;
/// the harness mounts no view and drives no other writer during these drills, which is the honest
/// basis for reading the sequence as one, and is stated rather than assumed.
///
/// Not `#if DEBUG`, the same reason `OfficeHarnessPlan` and
/// `classifyOfficeHarnessMirrorCaseObservation` above are not: the pins suite must be able to drive
/// every branch — including the ones a healthy live run never produces — with no helper, no runtime
/// and no LibreOffice anywhere.
enum OfficeAgentWriteEvidenceBranch: Equatable {
    /// All four facts hold. The only branch that passes.
    case proven
    /// The consumer answered `ok: false`. A legitimate product outcome (the fence, a dirty tab, a
    /// read-only format) but NOT what these drills were asked to prove, so the step is red and names
    /// the refusal instead of hiding it.
    case commandRefused
    /// **The arc's own worst class, made a first-class branch**: the consumer reported success and
    /// the file's bytes did not change. A silent no-op reported as a write.
    case silentNoOp
    /// The bytes changed and the saved bytes carry the marker, but the OPEN tab's tile never
    /// invalidated or never repainted to a different hash. A real, nameable partial: the write
    /// landed, the user's open view did not follow it.
    case savedWithoutRepaint
    /// The bytes changed but the saved bytes do NOT carry the marker — something was written, and it
    /// is not what was asked for. Distinguished from `.silentNoOp` because "wrote the wrong thing"
    /// and "wrote nothing" are different diagnoses.
    case changedWithoutTheMarker
    /// Any combination the four facts can take that none of the branches above describe — e.g. a
    /// repaint with no byte change at all. Fails, and says so, rather than being absorbed into a
    /// neighbouring branch that happens to be close.
    case unrecognized
}

struct OfficeAgentWriteEvidence: Equatable {
    let branch: OfficeAgentWriteEvidenceBranch
    let verdict: String
    /// `false` for `.unrecognized` — the one outcome that must fail closed rather than pass
    /// silently, exactly as `OfficeHarnessMirrorCaseObservation.recognized` does for drill 7.
    var recognized: Bool { branch != .unrecognized }
    /// **The step's own pass/fail, and deliberately NARROWER than `recognized`.** Four of the six
    /// branches are recognized diagnoses AND still red — a drill that exists to prove a write must
    /// not go green on "we correctly identified that nothing was written."
    var passes: Bool { branch == .proven }
}

/// `commandOk` is the consumer's own `ok` off `sendResult`. `tileRepainted` is "the open document's
/// tile (0,0) was evicted AND a re-subscribe produced a different hash" — both halves, since a
/// re-subscribe that was never preceded by an eviction is a cache-hit tautology (drill 3's own
/// lesson). `bytesChanged` compares a digest of the whole file taken before the command against one
/// taken after. `savedBytesCarryMarker` reads the marker out of the container's own XML — never out
/// of LOK's in-memory view, which would prove nothing about what reached disk.
func classifyOfficeAgentWriteEvidence(commandOk: Bool, tileRepainted: Bool,
                                     bytesChanged: Bool, savedBytesCarryMarker: Bool)
    -> OfficeAgentWriteEvidence {
    if !commandOk {
        return OfficeAgentWriteEvidence(branch: .commandRefused, verdict:
            "COMMAND REFUSED — the consumer answered ok:false, so this drill proved nothing about a "
          + "write. A refusal is a legitimate product outcome (fence / dirty tab / read-only "
          + "format); it is not this step's claim, so the step is RED and names it rather than "
          + "passing on a technicality.")
    }
    if !bytesChanged {
        return OfficeAgentWriteEvidence(branch: .silentNoOp, verdict:
            "SILENT NO-OP — the consumer reported SUCCESS and the file's bytes are unchanged. This "
          + "is the failure this arc's entire evidence standard exists to catch, and it is a branch "
          + "here rather than an unreached assertion.")
    }
    if !savedBytesCarryMarker {
        return OfficeAgentWriteEvidence(branch: .changedWithoutTheMarker, verdict:
            "CHANGED, BUT NOT AS ASKED — the file's bytes differ, yet the saved container does not "
          + "carry the marker this command wrote. Something was written and it is not what was "
          + "requested; a different diagnosis from writing nothing at all.")
    }
    if !tileRepainted {
        return OfficeAgentWriteEvidence(branch: .savedWithoutRepaint, verdict:
            "SAVED WITHOUT A REPAINT — the write reached disk (bytes differ, saved container carries "
          + "the marker) but the OPEN document's tile (0,0) never invalidated, or repainted to a "
          + "byte-identical hash. The file is right and the user's open view did not follow it.")
    }
    return OfficeAgentWriteEvidence(branch: .proven, verdict:
        "PROVEN — the consumer answered ok; AFTER that, the open document's tile (0,0) was evicted "
      + "and a re-subscribe produced a DIFFERENT hash; the file's bytes differ from the pre-command "
      + "digest; and the SAVED container carries the marker. Stated as a sequence, not a cause: "
      + "this harness mounts no view and runs no other writer against this path for the duration of "
      + "the drill, which is the basis for reading the three as one chain.")
}

// MARK: - office-plumbing Task 9: the multi-sheet fixture, templated (never shelled out to soffice)

/// **Why this is Swift string templating and not `soffice --convert-to`, the brief's own literal
/// wording**: the PRODUCTIZED vendor tree (`apple/Norma/vendor/libreoffice/product-set`) ships
/// `libmergedlo.dylib` and its sibling dylibs only — T1v2's own trim removed everything the LOK
/// embed path does not `dlopen`, and a `soffice` CLI binary was never among the set carried forward
/// from the NO-GO exploration's harvested official build (confirmed directly: zero matches for a
/// `soffice` executable anywhere under `vendor/libreoffice/product-set`). There is nothing this
/// harness could shell out to.
///
/// **What it uses instead is an already-proven technique in this exact codebase**:
/// `spikes/office-lok-gate/seeds/gate.fods` is a flat-XML ODF spreadsheet (`.fods` — plain text, no
/// zip container) that `OfficeHelperLiveTests
/// .testReloadOfAModifiedFixtureCopyProducesADifferentTileHashAtTheSameCoordinates` already edits
/// with a bare `String.replacingOccurrences` and opens directly against real LOK — LibreOffice's own
/// filter-selection picks the flat-XML spreadsheet importer from the `.fods` extension alone, no
/// `FilterName` override needed. This function is that same idea, extended from "edit one color" to
/// "template a genuinely second `<table:table>`": two sheets, two different fill colors, two
/// different text runs — a real multi-part document LOK has never seen before this run, generated
/// fresh every time the harness runs, never committed to the repo (nothing here touches git).
///
/// Kept here rather than inside `OfficeHarness.swift`'s own `#if DEBUG` block so both the harness AND
/// `OfficeRuntimeLiveTests`' own "a real second-part ask" (the parts==1 tripwire this task flips) can
/// share ONE definition — two independent hand-typed copies of a hundred-odd bytes of XML is exactly
/// the kind of drift a fixture is supposed to prevent.
func officeHarnessMultiSheetFodsContent() -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
        xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
        xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
        office:version="1.3"
        office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
      <office:automatic-styles>
        <style:style style:name="T9Sheet1Fill" style:family="table-cell">
          <style:table-cell-properties fo:background-color="#ff6600"/>
          <style:text-properties fo:color="#ffffff" fo:font-weight="bold"/>
        </style:style>
        <style:style style:name="T9Sheet2Fill" style:family="table-cell">
          <style:table-cell-properties fo:background-color="#0033cc"/>
          <style:text-properties fo:color="#ffffff" fo:font-weight="bold"/>
        </style:style>
      </office:automatic-styles>
      <office:body>
        <office:spreadsheet>
          <table:table table:name="T9SheetOne">
            <table:table-column table:number-columns-repeated="4"/>
            <table:table-row>
              <table:table-cell table:style-name="T9Sheet1Fill" office:value-type="string">
                <text:p>NORMA T9 PART ZERO</text:p>
              </table:table-cell>
              <table:table-cell office:value-type="float" office:value="0">
                <text:p>0</text:p>
              </table:table-cell>
            </table:table-row>
          </table:table>
          <table:table table:name="T9SheetTwo">
            <table:table-column table:number-columns-repeated="4"/>
            <table:table-row>
              <table:table-cell table:style-name="T9Sheet2Fill" office:value-type="string">
                <text:p>NORMA T9 PART ONE</text:p>
              </table:table-cell>
              <table:table-cell office:value-type="float" office:value="1">
                <text:p>1</text:p>
              </table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet>
      </office:body>
    </office:document>
    """
}
