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
/// transcript reads as twelve claims rather than fifty lines.
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
        12: "wire sanity — the document kind's wire shape, pinned; this harness runs daemonless"
    ]

    /// The whole run, in order. Every step names the drill it belongs to so the transcript can be
    /// read as twelve claims rather than forty-odd lines — the same reason
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
        step("12.daemonless", 12, "daemonless by construction — the wire shape is pinned via the codec, not a live panel.openTab", 5)
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
