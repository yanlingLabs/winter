import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Office Stage A Task 3 — dlopen + lok_init_2, real documentLoad/close, callbacks pumped to the
// wire. Only `NormaOfficeHelper` compiles this file (excluded from `NormaOfficeHelperFixture` in
// project.yml, which stays LOK-free — see `OfficeDocumentBridge`'s header in
// `OfficeHelperServer.swift`) — it needs the `SWIFT_OBJC_BRIDGING_HEADER`
// (`Support/OfficeHelperBridge.h`) only that target's project.yml settings carry.

// MARK: - LOK enum integers, transcribed (never imported — see OfficeHelperBridge.h's own header
// for why LibreOfficeKitEnums.h is not safely importable into a plain-C/Swift bridging context).
// Each cites the exact vendored header line so a future reader can verify against the real file.

private enum LOKCallbackType {
    static let invalidateTiles: Int32 = 0   // LibreOfficeKitEnums.h:130 (LOK_CALLBACK_INVALIDATE_TILES)
    /// Task 5 — LibreOfficeKitEnums.h:141 (LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR).
    static let invalidateVisibleCursor: Int32 = 1
    /// Task 5 — LibreOfficeKitEnums.h:150 (LOK_CALLBACK_TEXT_SELECTION).
    static let textSelection: Int32 = 2
    /// Task 5 — LibreOfficeKitEnums.h:160 (LOK_CALLBACK_TEXT_SELECTION_START).
    static let textSelectionStart: Int32 = 3
    /// Task 5 — LibreOfficeKitEnums.h:170 (LOK_CALLBACK_TEXT_SELECTION_END).
    static let textSelectionEnd: Int32 = 4
    static let stateChanged: Int32 = 8      // LibreOfficeKitEnums.h:229 (LOK_CALLBACK_STATE_CHANGED)
    /// Task 5 — LibreOfficeKitEnums.h:335 (LOK_CALLBACK_CELL_CURSOR, Calc only).
    static let cellCursor: Int32 = 17
    /// Task 8 — LibreOfficeKitEnums.h:345-347 (LOK_CALLBACK_CELL_FORMULA, Calc only) — "the text
    /// content of the formula bar." Confirmed live via a raw-callback probe before this constant
    /// was added (`OfficeHelperLiveTests
    /// .testProbeInvestigatesWhetherCellFormulaCallbacksExistForTheFormulaBarsContent`).
    static let cellFormula: Int32 = 19
    /// office-agent-tools T6 — LibreOfficeKitEnums.h:216 (LOK_CALLBACK_GRAPHIC_SELECTION). Payload
    /// `"x, y, width, height, angle, { optional JSON properties }"` (twips, angle in 100ths of a
    /// degree) — this bridge only ever needs the first four fields. Confirmed by
    /// `slides-lok-research.md` §5.4 to fire, unconditionally, from `SdrMarkView
    /// ::SetMarkHandlesForLOKit` on ANY mark-list change, Tab-driven `MarkNextObj` included — never a
    /// mouse-only signal. **Live-verified NOT to be the one that actually fires** once a document has
    /// more than one view (this bridge always has one by the time this matters — see
    /// `.graphicViewSelection`'s own header immediately below) — kept for documentation completeness
    /// and as a defensive fallback, never observed live.
    static let graphicSelection: Int32 = 6
    /// office-agent-tools T6 — LibreOfficeKitEnums.h:448-462 (LOK_CALLBACK_GRAPHIC_VIEW_SELECTION) —
    /// **the ACTUAL callback a real live drill observed**, not `.graphicSelection` above: LOK's own
    /// doc comment says plainly "the size/position of a graphic selection in ONE OF THE OTHER VIEWS
    /// has changed" — a MULTI-VIEW-AWARE sibling this bridge's own two-view design (primary + agent)
    /// makes the operative one the instant an agent view exists, which is always, by the time any
    /// slides mechanism runs. Payload is a JSON envelope, `{"viewId": "<id>", "selection": "<the SAME
    /// x,y,width,height,angle,{...} string .graphicSelection would have carried bare>"}` — this
    /// bridge parses the envelope, checks `viewId` against the AGENT view specifically (never trusts
    /// a firing for some OTHER view, e.g. the primary, as if it were this bridge's own), and parses
    /// `selection` with the identical comma-split logic either raw type would need.
    static let graphicViewSelection: Int32 = 27
}

// LOKTileMode (LOK_TILEMODE_RGBA/BGRA, LibreOfficeKitEnums.h:40-41) lived here for
// `debugPaintTile`'s BGRA->RGBA canonicalization — deleted (T3 review F2: that function had zero
// callers despite its comment claiming to BE the carry-6 tripwire; the REAL tripwire is
// `testGateXlsxRawTileHashMatchesTheGateTablePin`, which runs the committed spike, not this
// bridge). Task 4 re-adds tile-mode handling for real, reviewed, as part of the actual tile
// pipeline — not resurrected from here unproven.

/// Office Stage B Task 2 — the document's OWN save format, captured from its path's extension at
/// OPEN time (never re-derived later: a document opened as `.xlsx` saves as `.xlsx` for its whole
/// open lifetime in Stage A — there is no "save as a different format" door yet). Six formats: the
/// same six `gate.*` fixtures every other live-LOK test in this repo already exercises
/// (`OfficeHelperLiveTests`' own six-format matrix). Task 2 brief, verbatim: "the six +, later,
/// legacy" — the pre-2007 binary formats (`.doc`/`.xls`/`.ppt`) are deliberately NOT in this table.
/// Nothing in Stage A's fixture set has ever round-tripped them through `saveAs`, and this repo's
/// own methodology throughout (every task-N-report.md) refuses to ship a filter name nobody has
/// proven against real LOK — `later` is this comment's own honest placeholder for that work, not a
/// promise this task keeps.
///
/// **Office Stage B Task 9, fix round 1 (review F4) — back-pointer.** The app target cannot import
/// this module (`OfficeDocumentBridge`'s own header in `OfficeHelperServer.swift` explains why), so
/// `PanelEditorTab.swift`'s `officeReadWriteExtensions` is a deliberate, hand-maintained SECOND
/// list — the boundary `officeDocumentIsReadOnlyFormat` draws. It is an **exact mirror of these six
/// cases again** as of the r4 vendor re-cut. It was not, between whole-branch review I2 and that
/// re-cut: I2 removed `docx` from it on the ground that having a case here is necessary but not
/// sufficient — the r3 vendor tree's Writer OOXML export failed at `impl_store` even though the
/// filter resolution below was correct. r4 adds the one missing library that export service lives
/// in (`libmswordlo.dylib`; that set's own header has the mechanism), so the two lists are equal
/// once more, and the relationship to hold going forward is: app-side read-write ⊆ cases here.
///
/// **Adding a case here does NOT automatically widen that list or lift its read-only gates** — no
/// compile-time tripwire can exist across this module boundary; the drift signal is empirical
/// instead: `OfficeHelperLiveTests.testWidenedFormatsXlsmAndOdgFailSaveWithUnsupportedFormatTheDrift
/// TripwireForOfficeReadWriteExtensions` goes RED the day `xlsm`/`odg` gain a case here, because the
/// `saveAs` it currently asserts fails would start succeeding. If you add a case for a DIFFERENT
/// extension, that test says nothing — update `officeReadWriteExtensions` by hand, in the same
/// change, and only after proving the save actually lands.
enum OfficeSaveFormat: Equatable {
    case odt, docx, ods, xlsx, odp, pptx

    /// The saved file's OWN extension — `saveAs`'s destination filename is built from this, AND
    /// (fix round 1, live-test-caught) it doubles as `saveAs`'s own `pFormat` argument verbatim.
    ///
    /// **Corrected, live-test-caught**: this table originally passed LOK's own verbose internal
    /// filter names (`"Calc MS Excel 2007 XML"`, `"writer8"`, ...) as `pFormat` — verified against
    /// the vendored registry's own `oor:name` NODES, which was the wrong artifact to check. The
    /// live round-trip test failed immediately with LOK's own real error, `"no output filter found
    /// for provided suffix"`: `doc_saveAs` (`desktop/source/lib/init.cxx`) does NOT take a raw
    /// filter name — it takes a BARE EXTENSION (`"xlsx"`, `"odt"`, `"docx"`, ...) and resolves the
    /// actual filter itself, via its OWN internal `aWriterExtensionMap`/`aCalcExtensionMap`/
    /// `aImpressExtensionMap` tables, keyed by the LOADED DOCUMENT'S OWN component type — which is
    /// also why this is MORE correct than hand-picking a filter name here ever could be: LOK
    /// already knows whether the open handle is Writer/Calc/Impress, and picks the matching OOXML
    /// or ODF filter for that type from the SAME extension token, with no risk of this table
    /// naming a filter that disagrees with the document's own real kind.
    var fileExtension: String {
        switch self {
        case .odt: return "odt"
        case .docx: return "docx"
        case .ods: return "ods"
        case .xlsx: return "xlsx"
        case .odp: return "odp"
        case .pptx: return "pptx"
        }
    }

    /// `nil` for any extension outside the six this table covers (case-insensitive — a `.XLSX`
    /// upload is still xlsx). Stage A's own `open` never consulted this at all — LOK's
    /// `documentLoad` auto-detects format from CONTENT and opens far more than these six kinds for
    /// VIEWING — so a `nil` here must never fail an `open`; it only ever fails a later `saveAs` of
    /// that document, honestly, rather than guessing a filter for a format this task never proved.
    init?(pathExtension: String) {
        switch pathExtension.lowercased() {
        case "odt": self = .odt
        case "docx": self = .docx
        case "ods": self = .ods
        case "xlsx": self = .xlsx
        case "odp": self = .odp
        case "pptx": self = .pptx
        default: return nil
        }
    }

    /// Office Stage B Task 7 — which format the AUTOSAVE SIDECAR is actually written in, and
    /// whether that is a fallback away from this document's own real format. `saveAsSidecar`
    /// (below) is this table's only caller.
    ///
    /// **Narrowed in two steps — Task 11 (the r3 re-cut) took two of the three OOXML formats off
    /// Task 7's original "all three fall back, uniformly" judgment call; the r4 re-cut takes the
    /// third.** Task 7's blanket fallback was a disclosed, evidence-light judgment call: only xlsx
    /// had a confirmed crash mechanism at the time; docx and pptx were folded in on the reasoning
    /// that an unattended, repeating autosave timer makes "one unnecessary ODF conversion" a far
    /// cheaper mistake than "the crash-protection feature itself crashes the helper, silently, while
    /// a document is dirty." Both re-cuts replaced judgment with direct evidence, live-tested
    /// through the real helper
    /// (`OfficeHelperLiveTests.testXlsxDocxPptxSaveRoundTripThroughTheRealHelperAfterTheR4VendorRecut`):
    ///
    /// - **`.xlsx`** — the confirmed crash is FIXED (proven: real save, real reopen, seed content
    ///   survives). No longer falls back; autosave writes native `.xlsx` sidecars.
    /// - **`.pptx`** — confirmed still working, unaffected by the missing-dylib mechanism (a
    ///   different internal export code path, `oox::ppt`, never reached it) or by this fix. No
    ///   longer folded into the OOXML-as-one-category treatment Task 7 applied out of caution for a
    ///   format that was never actually proven broken — that caution's own justification (the crash
    ///   risk) no longer applies now the crash mechanism is understood and gone for the one format
    ///   that DID exhibit it. Autosave writes native `.pptx` sidecars.
    /// - **`.docx`** — the last format still on the fallback after Task 11, and **narrowed to
    ///   native by the r4 vendor re-cut.** Task 11's reasoning for keeping it was sound on the
    ///   evidence it had: docx `saveAs` failed on every attempt with a clean, non-fatal
    ///   `SfxBaseModel::impl_store` exception, so a native-format sidecar attempt would have failed
    ///   every single autosave fire — no sidecar at all, ever, for a dirty docx document, strictly
    ///   worse for data protection than a working ODF fallback. r4 removes the premise rather than
    ///   the caution: the failure was the DOCX export service's own library missing from the
    ///   product-set (`libmswordlo.dylib`, holding `com.sun.star.comp.Writer.DocxExport`), not a
    ///   defect in the export code, and with it present docx `saveAs` lands for real. A native
    ///   `.docx` sidecar is now both writable AND the strictly better recovery artifact — recovery
    ///   hands the user back their own format instead of an ODF conversion.
    ///
    /// `.odt`/`.ods`/`.odp` are excluded on different, solid ground, not by exemption: they are
    /// already ODF, so a sidecar `saveAs` for them never reaches the OOXML export filter code path
    /// at all — there is no unproven mechanism here to guess about.
    ///
    /// **Nothing in this table falls back any more, so `isODFFallback` is `false` on every arm
    /// today — and the flag is deliberately KEPT rather than deleted.** It is threaded end to end
    /// (`OfficeRuntime`'s reducer, `OfficeWire`'s codec, `PanelDocumentTab`'s recovery banner) as a
    /// generic boolean, and the next format this table gains (`.rtf`, a legacy binary, anything
    /// Stage C adds) is exactly as likely to need it as the three OOXML formats were. Deleting the
    /// plumbing now would have to be re-derived then, and the banner copy it drives is the one thing
    /// standing between "recovered your work" and "recovered your work, in a different format."
    var autosaveFormat: (format: OfficeSaveFormat, isODFFallback: Bool) {
        switch self {
        case .odt, .ods, .odp: return (self, false)
        case .docx: return (self, false)
        case .xlsx: return (self, false)
        case .pptx: return (self, false)
        }
    }
}

/// "Request to have the part number as an 5th value in the LOK_CALLBACK_INVALIDATE_TILES payload."
/// — LibreOfficeKitEnums.h:85-89 (`LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK = 1ULL << 2`). Set at
/// boot via `setOptionalFeatures` so `OfficeDocumentEvent.invalidated`'s `part` field is real.
private let lokFeaturePartInInvalidationCallback: UInt64 = 1 << 2

// MARK: - The C callback trampoline

/// The function LOK invokes for every registered document callback. A top-level free function
/// (never a closure with captures — C function pointers cannot capture anything), matching
/// `LibreOfficeKitCallback`'s exact C signature (`LibreOfficeKitTypes.h:20`:
/// `void (*)(int nType, const char* pPayload, void* pData)`). `pData` recovers which bridge/docId
/// this firing belongs to via `Unmanaged` — see `LOKBridge.DocumentCallbackContext`.
///
/// **Runs synchronously, on whatever thread made the LOK call that triggered it.** Every LOK call
/// this bridge ever makes already runs on `LOKBridge`'s own dedicated thread (`LOKDedicatedThread`),
/// so in practice this always fires there too — never a fresh thread, never re-entrant into
/// `LOKDedicatedThread.sync` (see that type's own header for why a nested `sync` call from inside
/// an already-running job would deadlock; `handleCallback` below never does this).
private func lokBridgeDocumentCallback(nType: Int32, pPayload: UnsafePointer<CChar>?, pData: UnsafeMutableRawPointer?) {
    guard let pData else { return }
    let context = Unmanaged<LOKBridge.DocumentCallbackContext>.fromOpaque(pData).takeUnretainedValue()
    let payload = pPayload.map { String(cString: $0) } ?? ""
    context.bridge.handleCallback(docId: context.docId, type: nType, payload: payload)
}

/// Runs every submitted closure on ONE dedicated OS thread, in submission order, for as long as
/// this object lives. LibreOfficeKit's own documentation says "not thread-safe"; this repo's own
/// Task 3 carry goes further — ALL LOK calls on ONE dedicated thread the bridge owns, not merely
/// "never concurrent" — because LO's internal state (SolarMutex ownership, thread-local bootstrap
/// data set up during `lok_init_2`) is plausibly keyed to the CALLING thread's identity, not just
/// guarded against concurrent entry (the spike and every known LOK embedder run one-shot/single-
/// threaded for exactly this reason). A GCD serial `DispatchQueue` does not give this: its
/// worker-thread identity across separate `.sync` calls is an implementation detail, not a
/// documented guarantee. A real `Thread`, parked in a condition-variable work loop, does.
final class LOKDedicatedThread {
    private let condition = NSCondition()
    private var queue: [() -> Void] = []
    private var shouldStop = false
    private var thread: Thread!

    init(name: String) {
        thread = Thread { [weak self] in self?.runLoop() }
        thread.name = name
        thread.stackSize = 4 << 20
        thread.start()
    }

    private func runLoop() {
        while true {
            condition.lock()
            while queue.isEmpty && !shouldStop {
                condition.wait()
            }
            if queue.isEmpty && shouldStop {
                condition.unlock()
                return
            }
            let job = queue.removeFirst()
            condition.unlock()
            job()
        }
    }

    /// Runs `body` on the dedicated thread and blocks the CALLING thread until it completes,
    /// returning its result or rethrowing its error. Safe to call concurrently from multiple
    /// threads (e.g. several connection threads) — each call is one atomic unit of work from the
    /// dedicated thread's point of view, queued and run in arrival order.
    ///
    /// **Never call this from a closure already running ON the dedicated thread** — `runLoop()` is
    /// blocked inside the outer `job()` call and would never get back to dequeue the nested job,
    /// so the inner `semaphore.wait()` would hang forever. Nothing in `LOKBridge` does this: LOK's
    /// own synchronous callbacks (`lokBridgeDocumentCallback`) run as part of the SAME job that
    /// triggered them and only ever call back out to `OfficeHelperServer`'s push routing, never
    /// back into this bridge.
    @discardableResult
    func sync<T>(_ body: @escaping () throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<T, Error>!
        condition.lock()
        queue.append {
            outcome = Result(catching: body)
            semaphore.signal()
        }
        condition.signal()
        condition.unlock()
        semaphore.wait()
        return try outcome.get()
    }

    /// Non-throwing convenience for the (majority of) call sites that never fail.
    @discardableResult
    func sync<T>(_ body: @escaping () -> T) -> T {
        try! sync { () throws -> T in body() }
    }
}

/// Task 3 — the real `OfficeDocumentBridge`: dlopen (via `lok_init_2`'s own internal
/// `dlopen`/`dlsym`, `LibreOfficeKitInit.h`) + boot once, `documentLoad`/`destroy` per document,
/// callbacks pumped through to whoever owns that document's connection. See
/// `OfficeHelperServer.swift` for the `OfficeDocumentBridge` protocol this conforms to and why it
/// exists (keeps `OfficeHelperServer`/`NormaOfficeHelperFixture` LOK-agnostic).
///
/// **The kit is never destroyed.** `kit->pClass->destroy(kit)` exists in the C API (the spike, a
/// one-shot CLI, calls it) but this helper's whole lifetime model is "load once, serve documents,
/// `_exit(0)` — never a normal return" (the plan's own global constraint, earned by the Writer
/// exit-time `SwDLL::~SwDLL` SIGSEGV during LIFO C++ static teardown — observed as process **exit
/// 134** (128 + SIGABRT, 6: an uncaught C++ exception from inside that teardown, not a raw SIGSEGV
/// reported directly; `spikes/office-lok-gate/README.md` and the Stage-A gate reports name the same
/// number). Calling `destroy` would invite exactly that crash outside of process exit, for no
/// benefit (the process is going to `_exit` anyway). Only DOCUMENTS get destroyed, on `close`.
/// Carry #6's own disposition check: exit 134 never appeared in any of this task's live-test runs
/// (six-format matrix, SIGTERM-with-Writer-open, ~15 total boots) — every exit path past
/// `lok_init_2` uses `_exit`, which skips the static-destructor teardown this crash needs by
/// definition (see `OfficeHelperServer`'s own idle-exit `_exit(0)` call site for the other half of
/// that guarantee, at the process-supervision level rather than this bridge's own document layer).
final class LOKBridge: OfficeDocumentBridge {
    enum BootError: Error, CustomStringConvertible {
        case installPathMissing(String)
        case initFailed(String)
        case versionInfoUnavailable
        /// office-agent-tools T3 third re-review — the office-class ABI tripwires (`nSize` size
        /// check, tail-symbol identity check) throw this rather than `precondition`-crash. A
        /// PRECONDITION failure here would kill the whole helper process outright — every document
        /// it might already be serving (on a respawn after some UNRELATED crash) lost with it — for
        /// a check whose own failure mode includes at least one FALSE positive this bridge cannot
        /// rule out: `lo_registerFileSaveDialogCallback` is a non-external symbol in today's shipped
        /// dylib, and nothing strips it today, but if a future, otherwise-VALID engine rebuild
        /// strips local symbols, `dladdr` resolves the NEAREST PRECEDING EXPORTED symbol instead of
        /// failing outright — a legitimate configuration producing what looks like an ABI mismatch
        /// to this specific technique. Throwing here, in `init` (itself already a throwing
        /// initializer), lets the caller refuse to boot gracefully — the existing "helper
        /// unavailable" path this codebase already has for every OTHER boot failure — rather than a
        /// raw process death.
        case abiMismatch(String)

        var description: String {
            switch self {
            case .installPathMissing(let path): return "LibreOffice install root not found at \(path)"
            case .initFailed(let installPath): return "lok_init_2 returned NULL for installPath \(installPath)"
            case .versionInfoUnavailable: return "getVersionInfo() did not return a usable BuildId"
            case .abiMismatch(let reason): return reason
            }
        }
    }

    enum LoadError: Error, CustomStringConvertible {
        case documentLoadFailed(String)
        var description: String {
            switch self {
            case .documentLoadFailed(let reason): return reason
            }
        }
    }

    /// Task 4 — a tile operation named a `docId` this bridge has no open handle for (a benign race:
    /// `OfficeHelperServer` already checks `docOwner[docId]` before calling in, but another
    /// connection could close the doc between that check and this call reaching the dedicated
    /// thread). Never a crash — `OfficeHelperServer` translates this into a `tileFailed` push for
    /// the one key affected, the same "the helper always survives" posture `LoadError` already has.
    enum TileError: Error, CustomStringConvertible {
        case docNotOpen(String)
        /// Fix round 1, I1's trap #3: `key`'s coordinates/zoom fail `TileMath.tileBoundsTwips`'s
        /// own sane-bounds check (a hostile `tileRequest.keys` entry — extreme tileX/tileY/zoomPPT
        /// transcribed straight off the wire with no magnitude limit). Thrown by
        /// `TileRenderer.renderRaw`, never a crash — same "the helper always survives" posture
        /// `.docNotOpen` already has.
        case invalidGeometry(TileKey)
        var description: String {
            switch self {
            case .docNotOpen(let docId): return "tile requested for a docId that is not open: \(docId)"
            case .invalidGeometry(let key): return "tile key geometry is out of range and cannot be painted: \(key)"
            }
        }
    }

    /// Office Stage B Task 2 — a `saveAs` (Task 4: also `postKey`/`postMouse`) operation named a
    /// `docId` this bridge has no open handle for, asked to save a document whose format `OfficeSaveFormat`
    /// does not cover, or hit a real `saveAs` failure. Never a crash — `OfficeHelperServer`
    /// translates every case into a `saveFailed` reply, the same "the helper always survives"
    /// posture `LoadError`/`TileError` already have.
    enum SaveError: Error, CustomStringConvertible {
        case docNotOpen(String)
        case unsupportedFormat(String)
        case saveAsFailed(String)
        /// Office Stage B Task 6 — `paste()` returned `false`. The one clipboard door LOK gives a
        /// real synchronous success/failure answer for (`postKeyEvent`'s `void` return is why
        /// `keyEventOk` can never distinguish "posted" from "took effect" — `paste()` can).
        case pasteFailed(String)
        /// Office Stage B Task 6 — `createAgentView` called twice for the same docId. Deliberate
        /// refusal, not "return the existing id" — see `OfficeWireFrame.createView`'s own header.
        case agentViewAlreadyExists(String)
        /// Office Stage B Task 6 — `agentKeyEvent` requested for a docId `createAgentView` was
        /// never called for.
        case noAgentView(String)
        /// office-agent-tools T3 re-review (Minor #4) — `createView()` returned LOK's own "no view"
        /// sentinel (`-1`, or the optional closure itself never fired) inside
        /// `ensureAgentViewOnDedicatedThread`. Thrown, never cached: the ORIGINAL code stored `-1`
        /// into `OpenDocument.agentViewId` via `?? -1` and returned it as if it were a real view —
        /// `agentViewId` being non-nil short-circuits every FUTURE call into returning that same
        /// `-1` without ever retrying `createView`, and `SfxLokHelper::setView` (`sfx2/source/view/
        /// lokhelper.cxx`, its own `getViewOfId` lookup) returns SILENTLY for an unknown id rather
        /// than erroring — meaning every subsequent "agent view" read would have silently run on
        /// whatever view was ALREADY current (in practice, the primary one), defeating I1's entire
        /// isolation guarantee with no error anywhere in the chain.
        case agentViewCreationFailed(String)
        /// office-agent-tools T3 — `sheetsInfo`/`sheetsRead` requested for a document that is not a
        /// spreadsheet. Distinct from every OTHER refusal on this enum: it is composed ENTIRELY from
        /// this bridge's own words, never a LOK-thrown string, so it is already house-voice by
        /// construction — the "mapped, never raw LibreOffice text" requirement the brief's own proof
        /// obligations name is satisfied at the point of composition, not by a later translation
        /// layer (unlike `.saveAsFailed`, whose `reason` — see `saveAsOnDedicatedThread` — DOES carry
        /// LOK-adjacent text and relies on the app-side T9 mapping table).
        case notSpreadsheet(docId: String, kind: OfficeDocumentKind)
        /// office-agent-tools T3 — `sheetsRead`'s `sheet` named no part this document actually has.
        /// `available` is the real, current sheet-name list (in part order) — carried so the caller
        /// can build "no sheet named X — this workbook has: A, B, C" without a second round trip.
        case sheetNotFound(docId: String, sheet: String, available: [String])
        /// office-agent-tools T4 — `sheetsSet` wrote a non-empty value into a cell, and the
        /// post-write verification read of that SAME cell came back empty. `LOKBridge.writeOneCell
        /// OnDedicatedThread`'s own header explains the mechanism this catches (a GoToCell that never
        /// landed within budget, or a commit that never took) — a real, if rare, failure this bridge
        /// can actually detect rather than silently report success on.
        case writeVerificationFailed(docId: String, address: String)
        /// office-agent-tools T4 fix-round review (Important #2) — a formula's character REQUIRES a
        /// `postKeyEvent` this bridge does not know how to synthesize. Deliberately DISTINCT from
        /// `.writeVerificationFailed` (the reviewer's own finding: that case name was a mislabel for
        /// this failure — the OLD code threw it mid-keystroke-loop, AFTER already posting every
        /// character before the unmapped one, leaving a real, uncommitted, PARTIAL formula in Calc's
        /// own edit mode on a document a human may have open). `formulaKeyEvent(for:)` is now called
        /// entirely in a pre-validation PASS, before the first `postKeyEvent` of the real attempt —
        /// this case can only be thrown BEFORE anything is typed, never mid-edit.
        case unsupportedFormulaCharacter(docId: String, address: String, character: Character)
        /// office-agent-tools T4 fix-round review (Important #3) — after positioning (the SAME
        /// `.uno:GoToCell`-via-`selectionTextOnDedicatedThread` mechanism every write verb already
        /// uses, including its own disclosed straggler residual), the agent view's OWN cursor —
        /// queried fresh via `getCommandValues(".uno:CellCursor")`, confirmed live to report the
        /// CURRENT view's real position, not a stale or cross-view-contaminated one (this task's own
        /// fix-round report has the probe) — does not match `address`. Thrown BEFORE any keystroke is
        /// posted: the reviewer's own finding was that the OLD lenient content-only check could not
        /// tell "positioned on the WRONG cell that happens to already hold text" from "positioned
        /// correctly" — reading a bystander cell's OWN old content back as "non-empty, so this must
        /// have worked" and letting the broker save a clobber. This closes that gap by verifying
        /// WHERE the cursor is, not merely THAT the target has content, before typing anything.
        /// Second fix-round review (Important #1's own trap, caught reviewing the FIRST fix's own
        /// message) — WHICH operation this check was guarding, so the description does not claim
        /// "before typing"/"nothing was written" about a RESIZE that never typed anything at all.
        /// `set`'s own per-cell check and both resize checks (`sheetsResizeOnDedicatedThread`'s
        /// sentinel-park and its post-span re-check) throw this SAME case now, distinguished only by
        /// this field — never a second, near-duplicate case.
        enum PositionVerificationContext { case typing, resizePositioning, verifyingWrite, formatPositioning }
        case positionVerificationFailed(docId: String, address: String, landedAt: String?,
                                        context: PositionVerificationContext)
        /// Second fix-round review (Important #2 + Minor 3) — `sheetsSetOnDedicatedThread`'s own loop
        /// wraps ANY per-cell failure in this case once at least one EARLIER cell already landed in
        /// THIS call, so a per-cell description's own "nothing was written"/"outcome unchanged"
        /// (still true of THAT cell alone) cannot misread as the CALL's own truth when it is not one
        /// — the reviewer's own finding: `sheets.ts`'s tool description claimed earlier cells "have
        /// already been written and saved," but `OfficeAgentBroker.perform`'s `action` (the entire
        /// per-cell loop) throws BEFORE rule 4's save switch is ever reached, so nothing from ANY
        /// `set` call is ever saved once one cell in it fails — only the per-cell IN-MEMORY write is
        /// real. The message is composed entirely at the throw site
        /// (`sheetsSetOnDedicatedThread`), never reconstructed here: `SaveError` crosses the
        /// helper->app socket flattened to a plain reason string
        /// (`OfficeHelperClient.sheetsSet`'s own `.error(_, let reason)` arm), so a second, structured
        /// field on THIS case would not survive that trip — this case exists so a fully pre-composed
        /// sentence has somewhere honest to live, rather than being force-fit into a case whose own
        /// description only ever names a bare docId/address.
        case partialSetFailure(reason: String)
        /// office-agent-tools T4 — `delete_sheet` named the workbook's ONLY remaining sheet. Checked
        /// BEFORE dispatching `.uno:Remove` (`LOKBridge.sheetsManageSheetOnDedicatedThread`'s own
        /// header explains why: Calc's own slot handler has no documented, verified error signal for
        /// this case, so a pre-check is the only honest way to refuse it rather than risk a silent
        /// no-op or an unverified worse outcome).
        case lastSheet(docId: String)
        /// T5 fix-round re-review (Minor) — `officeWidthMm100`'s own refusal; see its header. Never
        /// reached from `sheets format`, whose app-side `optionalWidth` already bounds [1, 1000];
        /// this exists so the helper's own conversion is total rather than dependent on that.
        case widthOutOfRange(docId: String, points: Double)
        /// office-agent-tools T4 — `add_sheet`/`rename_sheet` named a sheet name that already exists
        /// in the workbook. Checked BEFORE dispatching, for the same reason as `.lastSheet` above:
        /// `ScDocFunc::RenameTable`/`CreateValidTabName`'s own behavior on a collision is a silent
        /// no-op or a silently ALTERED name, neither of which is an honest way to refuse.
        case duplicateSheetName(docId: String, name: String)
        /// office-agent-tools T6 — `slidesInfo`/`slidesRead`/`slidesSetText`/`slidesManagePage`
        /// requested for a document that is not a presentation. Mirrors `.notSpreadsheet` exactly —
        /// composed entirely from this bridge's own words, never LOK-thrown text.
        case notPresentation(docId: String, kind: OfficeDocumentKind)
        /// office-agent-tools T6 — `slidesRead`/`slidesSetText`/`slidesManagePage`'s `slide` named an
        /// index this presentation does not have. `slideCount` is the real, current count — carried
        /// so the caller can build "no slide N — this presentation has M slides" without a second
        /// round trip, mirroring `.sheetNotFound`'s identical purpose.
        case slideNotFound(docId: String, slide: Int, slideCount: Int)
        /// office-agent-tools T6 — `delete_slide` named the presentation's ONLY remaining slide.
        /// Mirrors `.lastSheet` exactly — checked BEFORE dispatching any UNO command.
        case lastSlide(docId: String)
        /// office-agent-tools T6 — `slidesRead`/`slidesSetText` positioned onto slide `slide`
        /// successfully (it exists — `.slideNotFound` above already ruled that out), but Tab-cycling
        /// (`selectSlidePlaceholderOnDedicatedThread`) never produced a NEW selection for the
        /// requested `field` ("title" or "body") — a real, structural fact about this slide (e.g. a
        /// Blank layout with fewer than 1-2 selectable shapes), never conflated with `.slideNotFound`
        /// (a different slide identity question entirely). Spec's own "refuses naming the reason,
        /// rather than inventing one" contract for `set_text`.
        case slidePlaceholderNotFound(docId: String, slide: Int, field: String)
        /// office-agent-tools T6 fix round 2 (re-review New-1) — a structural slides verb could not
        /// establish per-slide IDENTITY (`getPartInfo`'s `hash`) for every slide BEFORE dispatching.
        /// Deliberately NOT `.writeVerificationFailed`: that case's own text says "wrote to … but
        /// could not confirm", which would be a lie here — this refuses before `destroyAgentView`,
        /// before `setPart`, before any `.uno:` dispatch, so nothing was written and the outcome is
        /// KNOWN (unchanged), not unknown. The distinction is the same one T4's fix round drew when
        /// it split `.unsupportedFormulaCharacter` out of `.writeVerificationFailed` for exactly this
        /// reason (see that case's own header).
        case slideIdentityUnavailable(docId: String, verb: String)
        var description: String {
            switch self {
            case .docNotOpen(let docId): return "save requested for a docId that is not open: \(docId)"
            case .unsupportedFormat(let ext): return "saving is not supported for this document's format (\(ext))"
            case .saveAsFailed(let reason): return reason
            case .pasteFailed(let docId): return "paste() failed for docId: \(docId)"
            case .agentViewAlreadyExists(let docId): return "docId already has an agent view: \(docId)"
            case .noAgentView(let docId): return "docId has no agent view: \(docId)"
            case .agentViewCreationFailed(let docId): return "createView() failed to mint an agent view for docId: \(docId)"
            case .notSpreadsheet(let docId, let kind):
                let noun: String
                switch kind {
                case .text: noun = "a text document"
                case .spreadsheet: noun = "a spreadsheet" // unreachable — this case IS the accepted kind
                case .presentation: noun = "a presentation"
                case .drawing: noun = "a drawing"
                case .other: noun = "not a recognized office document"
                }
                return "the `sheets` tool only works on spreadsheets, but \(docId) is \(noun)"
            case .sheetNotFound(let docId, let sheet, let available):
                let list = available.isEmpty ? "(no sheets)" : available.joined(separator: ", ")
                return "no sheet named \"\(sheet)\" in \(docId) — this workbook has: \(list)"
            case .writeVerificationFailed(let docId, let address):
                return "wrote to \(address) in \(docId) but could not confirm the content landed — "
                    + "the outcome is unknown; re-read the cell before trusting or retrying this write"
            case .unsupportedFormulaCharacter(let docId, let address, let character):
                return "the formula for \(address) in \(docId) contains a character this tool cannot "
                    + "type (\"\(character)\") — nothing was written; re-read the cell before "
                    + "retrying, the outcome is known (unchanged), not unknown"
            case .positionVerificationFailed(let docId, let address, let landedAt, let context):
                let landedDescription = landedAt ?? "an unrecognized position"
                switch context {
                case .typing:
                    return "could not confirm the cursor reached \(address) in \(docId) before typing "
                        + "(landed at \(landedDescription) instead) — nothing was written; re-read the "
                        + "cell before retrying, the outcome is known (unchanged), not unknown"
                case .resizePositioning:
                    return "an internal positioning check before the resize could not confirm the "
                        + "cursor reached \(address) in \(docId) (landed at \(landedDescription) "
                        + "instead) — nothing was resized; re-read before retrying, the outcome is "
                        + "known (unchanged), not unknown"
                case .verifyingWrite:
                    return "wrote to \(address) in \(docId) but could not re-confirm the cursor was "
                        + "still there to verify the content afterward (landed at \(landedDescription) "
                        + "instead) — the write itself may have succeeded; re-read the cell directly "
                        + "before trusting or retrying it"
                case .formatPositioning:
                    return "an internal positioning check before formatting could not confirm the "
                        + "cursor reached \(address) in \(docId) (landed at \(landedDescription) "
                        + "instead) — nothing was formatted; re-read before retrying, the outcome is "
                        + "known (unchanged), not unknown"
                }
            case .partialSetFailure(let reason): return reason
            case .widthOutOfRange(let docId, let points):
                return "a column width of \(points) points is outside the supported range (1 to 1000) "
                    + "in \(docId) — nothing was resized"
            case .lastSheet(let docId):
                return "\(docId) has only one sheet left — a workbook needs at least one; refusing to delete it"
            case .duplicateSheetName(let docId, let name):
                return "a sheet named \"\(name)\" already exists in \(docId)"
            case .notPresentation(let docId, let kind):
                let noun: String
                switch kind {
                case .text: noun = "a text document"
                case .spreadsheet: noun = "a spreadsheet"
                case .presentation: noun = "a presentation" // unreachable — this case IS the accepted kind
                case .drawing: noun = "a drawing"
                case .other: noun = "not a recognized office document"
                }
                return "the `slides` tool only works on presentations, but \(docId) is \(noun)"
            case .slideNotFound(let docId, let slide, let slideCount):
                return "no slide \(slide + 1) in \(docId) — this presentation has \(slideCount) slide\(slideCount == 1 ? "" : "s")"
            case .lastSlide(let docId):
                return "\(docId) has only one slide left — a presentation needs at least one; refusing to delete it"
            case .slidePlaceholderNotFound(let docId, let slide, let field):
                // Trailing period deliberate, unlike this file's other descriptions (fix round 1,
                // review F-0): `handleSlidesSetText` concatenates this directly with a lifecycle
                // sentence starting " If an earlier attribute…" when more than one field was named —
                // without terminal punctuation here the composed string read "nothing was written If
                // an earlier attribute…", a run-on the reviewer's own live reproduction quoted
                // verbatim as evidence nobody had read the composed string end-to-end.
                return "slide \(slide + 1) in \(docId) has no \(field) placeholder — nothing was written."
            case .slideIdentityUnavailable(let docId, let verb):
                return "could not read per-slide identity from \(docId), so \(verb) could not be "
                    + "verified — nothing was changed. The outcome is known (unchanged), not unknown; "
                    + "retrying is safe."
            }
        }
    }

    /// Boxed alongside each open document's native handle, `Unmanaged.passRetained` at
    /// `registerCallback` time and `.release()`d at `close` — never before, never twice (both
    /// enforced by `documents` being the single source of truth: a docId's context is retained
    /// exactly once, when `documents[docId]` is set, and released exactly once, when it is
    /// removed). An unretained/unbalanced box here is a use-after-free the first time a callback
    /// fires after the context should logically be gone.
    final class DocumentCallbackContext {
        let bridge: LOKBridge
        let docId: String
        init(bridge: LOKBridge, docId: String) {
            self.bridge = bridge
            self.docId = docId
        }
    }

    private struct OpenDocument {
        let handle: UnsafeMutablePointer<LibreOfficeKitDocument>
        let context: Unmanaged<DocumentCallbackContext>
        /// Task 4 — one tile pool per open document, constructed alongside the handle in
        /// `openOnDedicatedThread` (never lazily on first tile request — `getTileMode()` is cheap
        /// and reading it once up front keeps `TileRenderer.init` free of its own failure mode to
        /// handle later).
        let tileRenderer: TileRenderer
        /// Office Stage B Task 2 — this document's own save format, captured from its `path`'s
        /// extension the ONE time `openOnDedicatedThread` ever looks at it. `nil` for anything
        /// outside `OfficeSaveFormat`'s six — see that type's own doc for why a `nil` here fails a
        /// later `saveAs`, never the `open` that produced it.
        let saveFormat: OfficeSaveFormat?
        /// **Fix round 2 (CRITICAL)** — this document's OWN view id, captured via `getView(rawDoc)`
        /// immediately after `initializeForRendering` in `openOnDedicatedThread`.
        ///
        /// **Fix round 3 correction — the capture's own reliability was mis-attributed.** An earlier
        /// version of this comment justified the capture with "the view that `documentLoad` creates
        /// is current at load time" — true (see `openOnDedicatedThread`'s own comment, right below
        /// the `getView` call, for where THAT fact is actually load-bearing), but not why THIS read
        /// is safe. `doc_getView` (`desktop/source/lib/init.cxx:7003-7012`, this codebase's pinned
        /// LO commit `11482c8f`) and `doc_registerCallback` (same file, `:4663-4675`) both resolve via
        /// `SfxLokHelper::getViewId(pDocument->mnDocumentId)` — a DocId-FILTERED scan of the global
        /// view-shell list (confirmed by reading `sfx2/source/view/lokhelper.cxx` directly) — genuinely
        /// document-scoped REGARDLESS of what is globally "current," not `SfxViewShell::Current()`.
        /// This capture would be exactly as reliable if `rawDoc`'s view were never current at all.
        ///
        /// Exists because a DIFFERENT category of LOK call — `ScModelObj::setPart`/`::getPart`
        /// (`sc/source/ui/unoobj/docuno.cxx`) — resolves via the STATIC `ScDocShell::GetViewData()`
        /// (ultimately `SfxViewShell::Current()`), ignoring `this->pDocShell` entirely — unlike
        /// `paintTile`/`postMouseEvent`/`getDocWindow`, which all correctly use the INSTANCE-scoped
        /// `pDocShell->GetBestViewShell(false)`. `doc_paintPartTile`
        /// (`desktop/source/lib/init.cxx`) inherits the SAME hazard through its own internal
        /// `doc_setPartImpl` call — confirmed empirically, not just by source reading, by the two-
        /// document live drills in `OfficeRuntimeLiveTests.swift` failing at the paint-detector
        /// assertion (byte-identical part-0/part-1 tiles) before this fix. **Fix round 3 found a
        /// SECOND paint hazard in the same function, not closed by `setView` alone**:
        /// `getAlternativeViewForPaint` (`init.cxx:4387-4414`) searches every open view for one
        /// already sitting at the requested part/mode/render-state with NO `DocId` filter — a
        /// bystander document (any type) can match, and when it does, `doc_paintPartTile` skips
        /// `setPart` entirely and paints via the REQUESTING document's own (unmoved) view — see
        /// `paintTileOnDedicatedThread`'s own header for the fix (an explicit `setPart` in the paint
        /// prefix, which prevents the mismatch that triggers this search from ever arising).
        ///
        /// `-1` (LOK's own "no view" sentinel, per `getViewId`'s documented return) is stored as-is,
        /// never substituted — every call site's own `setView` prefix degrades harmlessly to today's
        /// pre-fix behavior in that case (`SfxLokHelper::setView`'s `getViewOfId` lookup returns null
        /// for `-1` and no-ops), rather than this bridge inventing a fallback LOK itself does not
        /// provide.
        let viewId: Int32
        /// **Fix round 4 (NEW-1, CRITICAL) — this document's own LOK document type**, captured at
        /// `open` from `getDocumentType()` (the same read that already fed `opened`'s wire metadata;
        /// this field just keeps it instead of throwing it away). Exists for ONE purpose: to
        /// type-gate every `setPart` call this bridge makes, exactly the way LOK's OWN
        /// `doc_paintPartTile` does.
        ///
        /// LOK deliberately does not change the part for a TEXT document — `desktop/source/lib/
        /// init.cxx:4458-4461` (this codebase's pinned LO commit `11482c8f`), verbatim:
        /// `// Text documents have a single coordinate system; don't change part.` … `const bool
        /// isText = (aType == LOK_DOCTYPE_TEXT);` — and then guards BOTH its own `doc_setPartImpl`
        /// call (`:4485-4490`) and the matching restore (`:4514-4519`) on `!isText`. The reason
        /// that guard exists is not cosmetic: for Writer, `setPart` is NOT a viewport switch at all.
        /// `SwXTextDocument::setPart` (`sw/source/uibase/uno/unotxdoc.cxx:3410-3419`) is
        /// `pWrtShell->GotoPage(nPart + 1, true)` — a real CARET MOVE, with no same-page early-out
        /// anywhere below it (`SwWrtShell::GotoPage` → `SwCursorShell::GotoPage` →
        /// `GetLayout()->SetCurrPage(m_pCurrentCursor, nPage)`, all read at the pin). Norma pins
        /// every `.odt`/`.docx` at part 0, so an ungated `setPart(handle, 0)` on a Writer document
        /// is `GotoPage(1)` — "yank the caret to the top of page 1" — on EVERY call.
        ///
        /// See `paintTileOnDedicatedThread` and `postKeyOnDedicatedThread` for the two places that
        /// mattered and why. `.text` is the ONLY kind gated out, mirroring LOK's own `isText` test
        /// exactly rather than inventing a broader rule of this bridge's own (`.drawing` shares
        /// `SdXImpressDocument::setPart` with `.presentation`, and LOK does not exempt it).
        let kind: OfficeDocumentKind
        /// Office Stage B Task 6 — the two-writer groundwork's second LOK view, minted on demand by
        /// `createAgentViewOnDedicatedThread` (`nil` until then, `var` so that ONE call site can set
        /// it after `OpenDocument` is already stored in `documents`). Holds `createView()`'s OWN
        /// return value verbatim — never re-derived via `getView()`, which becomes ambiguous the
        /// instant a second view exists (confirmed by reading `doc_getView`'s
        /// `SfxLokHelper::getViewId(mnDocumentId)` at the vendored pin: a DocId-filtered SCAN, whose
        /// answer is order-dependent once more than one view shares that docId — safe today only
        /// because `openOnDedicatedThread`'s own `getView()` read happens before any second view
        /// can exist). Torn down explicitly in `closeOnDedicatedThread` — see that method's own
        /// header for why `doc_destroy` alone is not enough.
        var agentViewId: Int32? = nil
        /// Office Stage B Task 7 — the best available answer to "what part is the user actually
        /// looking at right now," for `saveAsSidecarOnDedicatedThread`'s own `setPart` prefix (the
        /// brief's own words: "setPart type-gated w/ the user's active part"). Autosave fires on an
        /// AUTONOMOUS timer, never in response to a wire request — unlike every other part-scoped
        /// call in this bridge (`postKey`/`postMouse`/`saveAs`/...), which all receive `part` as an
        /// explicit argument the APP supplied — so there is no request to read it from here.
        ///
        /// Updated ONLY by `paintTileOnDedicatedThread`, deliberately not by every part-scoped
        /// method — a full sweep (postKey/postMouse/clipboard/...) would work too, but paint is the
        /// SAME signal the app's own `DocumentEntry.activePart` traces back to in the first place
        /// (`.subscribeRequested`'s own reducer arm sets it, which is what triggers the paint that
        /// would update this): a viewport switch always repaints before or alongside any input
        /// reaching that part, so tracking here is a faithful mirror of "the part currently on
        /// screen," not a guess. Defaults `0` — the part LOK itself opens a document parked at.
        ///
        /// **Deliberately loose, not exact-consistent with LOK's own live `getPart()`** — a
        /// residency-prefetch chunk landing for a part the user has since left (`.save`'s own
        /// NEW-2 fix header has the identical caveat for the real save path) can leave this
        /// momentarily stale. Acceptable here for a reason the real save path does not have: an
        /// autosave sidecar's CONTENT is never scoped by part at all (`saveAs` serializes the whole
        /// document, every sheet/page, regardless of which one is "current") — `setPart` only
        /// affects which view/cursor position the recovered file remembers as "current," a cosmetic
        /// detail next to the actual data-loss autosave exists to prevent.
        var lastKnownPart: Int = 0
        /// office-agent-tools T6 — the most recent `LOK_CALLBACK_GRAPHIC_SELECTION` rect observed for
        /// THIS docId, parsed by `handleCallback`. Consumed and CLEARED by
        /// `selectSlidePlaceholderOnDedicatedThread`'s own Tab-cycling mechanism immediately before
        /// every `KEY_TAB` it posts — so a non-nil value read back afterward can only be a fresh
        /// firing from THAT specific keypress, never a stale rect left over from an earlier,
        /// unrelated job on this same docId. `nil` means "no selection-changed callback observed
        /// since this was last cleared."
        var lastGraphicSelectionRectTwips: OfficeTwipsRect? = nil
    }

    private let thread: LOKDedicatedThread
    private let kit: UnsafeMutablePointer<LibreOfficeKit>
    let lokVersionString: String
    /// Office Stage B Task 2 — `<state-path>/saves/`, created once at boot (this bridge's own
    /// `init`, alongside the fontconfig/user-profile directories it already makes there) — the ONE
    /// place `saveAs` ever renders to. Always a subpath of `--state-path`, so it is inside the
    /// seatbelt's write fence BY CONSTRUCTION (`office-helper.sb`'s `(subpath (param "STATE_PATH"))`
    /// rule) — Task 1's invariant, untouched: this task does not add a line to that profile, and
    /// does not need to.
    private let savesDirectory: URL
    /// Office Stage B Task 7 — `<state-path>/autosave/`, the ONE place `saveAsSidecar` ever renders
    /// to. **Deliberately NOT swept by `sweepStaleDocumentDirectories` below, unlike `docs/`/
    /// `saves/` immediately above it** — see that method's own header for the full reasoning; the
    /// one-sentence version is that a sidecar surviving a helper crash+respawn is the ENTIRE point
    /// of this task, and a wholesale wipe at every boot (correct for `docs/`/`saves/`, which hold
    /// nothing a fresh stage/render cannot instantly recreate) would delete the evidence before the
    /// app ever gets to ask "is there something to recover" — silently disabling crash recovery on
    /// the exact boot (a respawn after `.helperDied`) it exists to serve.
    private let autosaveDirectory: URL
    /// Set once by `OfficeHelperServer` before any document opens. Fires on `LOKDedicatedThread`
    /// — see that type's header for the re-entrancy rule this must never violate.
    var onEvent: ((String, OfficeDocumentEvent) -> Void)?

    /// Touched ONLY from jobs running on `thread` — no separate lock needed; the dedicated thread
    /// is itself the serialization mechanism, for this exactly as much as for the LOK calls
    /// themselves.
    private var documents: [String: OpenDocument] = [:]

    /// `installRoot` is the directory containing `Frameworks/` and `Resources/` as real (non-
    /// symlinked) siblings — either `<app>/Contents/Resources/LibreOffice` (production, resolved
    /// by `main.swift` relative to the helper's own embedded bundle position) or the vendor tree's
    /// `product-set/` (`--lok-root` DEBUG override, for iteration without a full app build) — both
    /// share this exact shape, so `LOKBridge` itself never needs to know which one it was handed.
    /// `statePath` is the helper's own `--state-path` scratch directory (fontconfig conf + cache,
    /// the per-instance user profile — never the user's real `~/.norma*` or system paths).
    init(installRoot: URL, statePath: URL) throws {
        var isDirectory: ObjCBool = false
        let frameworksPath = installRoot.appendingPathComponent("Frameworks").path
        guard FileManager.default.fileExists(atPath: frameworksPath, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw BootError.installPathMissing(frameworksPath)
        }

        // Office Stage B Task 2b (I3) — crash-orphan hygiene for BOTH document-bearing directories
        // under `--state-path`, on the SAME one-live-helper-at-a-time safety argument
        // `sweepStaleProfileDirectories`'s own header already makes for `lok-profile-*` (the socket
        // bind is exclusive, so anything already present the moment a NEW boot reaches this call can
        // only belong to a now-dead PRIOR instance): `docs/` is the app's own staged-copy directory
        // (`OfficeRuntime.stageDocument` — this helper never creates it, only ever receives an
        // already-staged path pointing into it) and `saves/` is this bridge's own rendered-save
        // directory, immediately below. Every ordinary close/teardown/helper-death already sweeps
        // its OWN docId's staged copy via `OfficeRuntime.deleteStagedCopy` on the app side — this is
        // the backstop for the case nothing on the app side ever ran at all (the whole app crashed
        // or was force-quit, not just the helper), the identical justification carried for
        // `lok-profile-*` orphans.
        //
        // Office Stage B Task 7 — `autosave/` is deliberately NOT swept here, unlike its two
        // siblings above. `docs/`/`saves/` hold nothing that survives being deleted: a staged copy
        // re-stages from the real file on the very next open, and a rendered save is a one-shot
        // temp already relocated by `placeAtomically` before this helper could ever see it again.
        // `autosave/` is the opposite — a sidecar surviving PAST a crash+respawn is this task's
        // entire reason to exist ("a SIGKILL costs at most a minute," not "a SIGKILL erases the
        // last minute AND the boot that follows it"). A wholesale wipe here would fire on EXACTLY
        // the boot recovery needs to survive (a respawn after `.helperDied`), deleting the evidence
        // before `OfficeRuntime`'s own recovery-candidate check at the next open ever runs. Orphan
        // hygiene for `autosave/` still exists — it is app-side and MANIFEST-aware instead (only a
        // sidecar with no matching manifest entry, or vice versa, is orphaned; a valid pair is never
        // touched), because only the app knows which sidecar still maps to a real path someone might
        // reopen — the helper never learns real paths at all (`OfficeRuntime.stageDocument`'s own
        // "Collabora jail" header) and could not tell a live candidate from a genuine orphan even if
        // it tried. See `OfficeRuntime.sweepAutosaveOrphans`.
        Self.sweepStaleDocumentDirectories(statePath: statePath)

        // Office Stage B Task 2 — `<state-path>/saves/`, ahead of anything that could render into
        // it. `withIntermediateDirectories: true` also tolerates a `--state-path` this bridge is
        // booting into for the first time (mirrors `OfficeHelperServer.start()`'s own
        // `createDirectory` call for `statePath` itself, one level up).
        let savesDirectory = statePath.appendingPathComponent("saves", isDirectory: true)
        try FileManager.default.createDirectory(at: savesDirectory, withIntermediateDirectories: true)
        self.savesDirectory = savesDirectory

        // Office Stage B Task 7 — `<state-path>/autosave/`, created (never swept — see above)
        // ahead of anything that could render into it.
        let autosaveDirectory = statePath.appendingPathComponent("autosave", isDirectory: true)
        try FileManager.default.createDirectory(at: autosaveDirectory, withIntermediateDirectories: true)
        self.autosaveDirectory = autosaveDirectory

        // Carry #5 (task-3-brief): FONTCONFIG_FILE must be set BEFORE lok_init_2 — fontconfig
        // resolves its config lazily but the first font lookup happens deep inside LO's own init/
        // load path, not under this bridge's control, so "before lok_init_2" is the only safe
        // point to guarantee ordering.
        try Self.configureFontconfig(installRoot: installRoot, statePath: statePath)
        let profileURLString = try Self.prepareUserProfile(statePath: statePath)

        let thread = LOKDedicatedThread(name: "office-helper.lok")
        self.thread = thread

        let installPath = frameworksPath
        let (rawKit, buildId): (UnsafeMutablePointer<LibreOfficeKit>, String) = try thread.sync {
            // Carry (T2 review, EARNED): bootstraprc's UserInstallation defaults to $ORIGIN/.. —
            // INSIDE the signed, read-only bundle. `profileURLString` (a `file://` URL under
            // --state-path, prepared above) is what makes this call safe — see the spike's
            // main.c:137-138 for the same shape against a scratch profile dir.
            guard let rawKit = lok_init_2(installPath, profileURLString) else {
                throw BootError.initFailed(installPath)
            }
            rawKit.pointee.pClass.pointee.setOptionalFeatures?(rawKit, lokFeaturePartInInvalidationCallback)
            guard let versionCStr = rawKit.pointee.pClass.pointee.getVersionInfo?(rawKit) else {
                throw BootError.versionInfoUnavailable
            }
            // Deliberately not freed — getVersionInfo's ownership/free contract is not specified
            // the way getError's is (freeError exists for that one); same judgment call the spike
            // makes for the same call, for the same reason (a long-lived process here, not a
            // one-shot CLI, but this string is read once at boot and never again — not worth
            // guessing at a free() that could double-free against an unspecified contract).
            let versionJSON = String(cString: versionCStr)
            guard let buildId = Self.extractBuildId(fromVersionJSON: versionJSON) else {
                throw BootError.versionInfoUnavailable
            }
            return (rawKit, buildId)
        }
        self.kit = rawKit
        self.lokVersionString = buildId

        // office-agent-tools T3 review (C1-split) — the permanent office-class ABI guard.
        //
        // **A size check alone cannot guard `LibreOfficeKitClass` the way it guards
        // `LibreOfficeKitDocumentClass` above.** This class's own real drift (found by this same
        // review, live-verified before fixing — see `LibreOfficeKit.h`'s `sendDialogEvent`-removal
        // and `registerFileSaveDialogCallback`-addition comments in this same struct) was a NET-ZERO
        // swap: one phantom member the header declared but the engine never had, exactly cancelling
        // one real tail member the header never declared but the engine did have. Declared-member
        // COUNT stayed the same on both sides throughout (26), so `nSize == MemoryLayout.size` held
        // true (216 == 216) on the UNFIXED header, even while every member from the phantom's
        // position onward silently called the wrong function. Confirmed empirically: the boot-time
        // size probe below passed before this fix, not just after.
        guard rawKit.pointee.pClass.pointee.nSize == MemoryLayout<LibreOfficeKitClass>.size else {
            throw BootError.abiMismatch(
                "LibreOfficeKit office-class ABI mismatch: engine reports nSize=\(rawKit.pointee.pClass.pointee.nSize) "
                    + "but this build's LibreOfficeKit.h describes a \(MemoryLayout<LibreOfficeKitClass>.size)-byte "
                    + "struct.")
        }

        // The guard the size check cannot provide: resolve this struct's own LAST declared member
        // and assert its REAL symbol name still contains what the header calls it.
        //
        // **Says what this actually covers, corrected after an overclaim in an earlier draft of
        // this comment (second re-review) — this is TAIL-IDENTITY drift, not every net-zero
        // drift.** It catches: this exact tail member being silently renamed or removed upstream
        // with nothing replacing it, and (redundantly with the size check, but for free) anything
        // that shifts the tail's own declared offset at all. It does NOT catch an INTERIOR
        // add-one/remove-one pair entirely ABOVE this tail member: if a phantom is added and a real
        // member removed somewhere between the struct's start and this tail, the NET shift to
        // everything AT OR AFTER this position is zero — this member still lands on its own correct
        // offset and resolves correctly, while every interior member between the swap silently
        // misaligns, undetected by either guard. Closing that would need the same exhaustive
        // per-member `dladdr` sweep this task's own investigation already did by hand for both
        // structs, run as a permanent check — not attempted here, disclosed instead.
        let lastOfficeMemberSymbol = Self.resolvedSymbolName(
            unsafeBitCast(rawKit.pointee.pClass.pointee.registerFileSaveDialogCallback, to: UnsafeRawPointer?.self))
        guard lastOfficeMemberSymbol.contains("registerFileSaveDialogCallback") else {
            throw BootError.abiMismatch(
                "LibreOfficeKit office-class ABI mismatch: this struct's own last declared member "
                    + "(registerFileSaveDialogCallback) resolved to \"\(lastOfficeMemberSymbol)\" instead — the header "
                    + "no longer matches the compiled engine's real member order.")
        }
    }

    /// office-agent-tools T3 review (C1-split) — `dladdr`-resolves a raw function pointer back to
    /// its real, compiled symbol name. The one general-purpose version of the ad hoc `symbolName`
    /// helper this task's own investigation used repeatedly (document-class sweep, office-class
    /// sweep) — kept as a real method, not deleted with the diagnostics that used it, because
    /// `init`'s own permanent office-class tripwire (above) needs the identical resolution.
    private static func resolvedSymbolName(_ raw: UnsafeRawPointer?) -> String {
        guard let raw else { return "<nil>" }
        var info = Dl_info()
        guard dladdr(raw, &info) != 0, let sname = info.dli_sname else {
            return "<unresolved @ \(raw)>"
        }
        return String(cString: sname)
    }

    // MARK: - OfficeDocumentBridge

    func open(docId: String, path: String) throws -> OfficeDocumentMetadata {
        try thread.sync { try self.openOnDedicatedThread(docId: docId, path: path) }
    }

    func close(docId: String) {
        thread.sync { self.closeOnDedicatedThread(docId: docId) }
    }

    /// Task 4 — called from a CONNECTION thread (`OfficeHelperServer`'s `.tileRequest` handler),
    /// never from inside a LOK callback — marshals onto `thread` exactly like `open`/`close` above.
    func paintTile(docId: String, key: TileKey) throws -> TilePaintResult {
        try thread.sync { try self.paintTileOnDedicatedThread(docId: docId, key: key) }
    }

    /// Task 4 — the OPPOSITE threading contract from every other method on this bridge: called
    /// ONLY from `OfficeHelperServer.routeDocumentEvent`, itself reached synchronously from inside
    /// `handleCallback` below — which, per `lokBridgeDocumentCallback`'s own guarantee, is ALREADY
    /// running on `thread` by the time this executes. Calling `thread.sync` here would be the exact
    /// reentrant-deadlock hazard `LOKDedicatedThread`'s own header warns against (a job already
    /// running on `thread` trying to enqueue and wait for another job on the same thread) — this
    /// method touches `documents` DIRECTLY instead, relying on already being on the right thread.
    func applyTileInvalidation(docId: String, rectsTwips: [OfficeTwipsRect], part: Int) -> [TileKey] {
        guard let doc = documents[docId] else { return [] }
        return doc.tileRenderer.applyInvalidation(rectsTwips: rectsTwips, part: part)
    }

    /// Office Stage B Task 2 — called from a CONNECTION thread (`OfficeHelperServer`'s `.save`
    /// handler), never from inside a LOK callback — marshals onto `thread` exactly like
    /// `open`/`close`/`paintTile` above. `seq` is the wire request's own seq (never re-minted here):
    /// reusing it as the destination filename's disambiguator is what keeps two saves of the same
    /// `docId` from colliding on disk without this bridge needing a save-local counter of its own.
    func saveAs(docId: String, seq: UInt64, part: Int) throws -> String {
        try thread.sync { try self.saveAsOnDedicatedThread(docId: docId, seq: seq, part: part) }
    }

    /// Office Stage B Task 7 — called from the timer queue `OfficeAutosaveScheduler` fires on
    /// (never a connection thread, never from inside a LOK callback) — marshals onto `thread`
    /// exactly like `saveAs`/`open`/`close`/`paintTile` above. **No `part` parameter** — unlike
    /// every other part-scoped call on this bridge, an autosave fire has no wire request to have
    /// carried one; `saveAsSidecarOnDedicatedThread` reads `OpenDocument.lastKnownPart` instead
    /// (see that field's own header for why, and why that is a deliberately looser guarantee).
    ///
    /// **Fix round 1 (review I-1) — `isStillArmed` threaded straight through to the dedicated-
    /// thread job unevaluated.** This wrapper does not call it — see
    /// `saveAsSidecarOnDedicatedThread`'s own header for exactly where and why it gets called.
    func saveAsSidecar(docId: String, isStillArmed: @escaping () -> Bool) throws -> (ext: String, isODFFallback: Bool)? {
        try thread.sync { try self.saveAsSidecarOnDedicatedThread(docId: docId, isStillArmed: isStillArmed) }
    }

    /// Office Stage B Task 4 — called from a CONNECTION thread (`OfficeHelperServer`'s `.keyEvent`
    /// handler), never from inside a LOK callback — marshals onto `thread` exactly like every other
    /// document-scoped call on this bridge.
    ///
    /// **Fix round 1, F2 (CRITICAL) — `part` added; see `postKeyOnDedicatedThread`'s own header for
    /// what happens with it and why.**
    func postKey(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        try thread.sync { try self.postKeyOnDedicatedThread(docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode) }
    }

    /// Office Stage B Task 4 — same threading contract as `postKey` above.
    func postMouse(docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                   count: Int, buttons: Int, modifiers: Int) throws {
        try thread.sync {
            try self.postMouseOnDedicatedThread(docId: docId, part: part, type: type, xTwips: xTwips, yTwips: yTwips,
                                                count: count, buttons: buttons, modifiers: modifiers)
        }
    }

    /// Office Stage B Task 5 — same threading contract as `postKey`/`postMouse` above: called from a
    /// CONNECTION thread (`OfficeHelperServer`'s `.extTextInputEvent` handler), never from inside a
    /// LOK callback.
    func postExtTextInput(docId: String, part: Int, type: OfficeExtTextInputType, text: String) throws {
        try thread.sync {
            try self.postExtTextInputOnDedicatedThread(docId: docId, part: part, type: type, text: text)
        }
    }

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the second ("agent") view

    func clipboardCopy(docId: String, part: Int) throws -> String {
        try thread.sync { try self.clipboardCopyOnDedicatedThread(docId: docId, part: part) }
    }
    func clipboardCut(docId: String, part: Int) throws -> String {
        try thread.sync { try self.clipboardCutOnDedicatedThread(docId: docId, part: part) }
    }
    func clipboardPaste(docId: String, part: Int, text: String) throws {
        try thread.sync { try self.clipboardPasteOnDedicatedThread(docId: docId, part: part, text: text) }
    }
    func undo(docId: String) throws {
        try thread.sync { try self.undoOnDedicatedThread(docId: docId) }
    }
    func redo(docId: String) throws {
        try thread.sync { try self.redoOnDedicatedThread(docId: docId) }
    }
    func createAgentView(docId: String) throws -> Int32 {
        try thread.sync { try self.createAgentViewOnDedicatedThread(docId: docId) }
    }
    func agentKeyEvent(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        try thread.sync {
            try self.agentKeyEventOnDedicatedThread(docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode)
        }
    }

    // MARK: - office-agent-tools T3: sheets info/read

    func sheetsInfo(docId: String) throws -> (sheets: [OfficeSheetInfo], activeSheet: String) {
        try thread.sync { try self.sheetsInfoOnDedicatedThread(docId: docId) }
    }
    func sheetsRead(docId: String, sheet: String, range: String, formulas: Bool) throws -> [[String]] {
        try thread.sync { try self.sheetsReadOnDedicatedThread(docId: docId, sheet: sheet, range: range, formulas: formulas) }
    }

    // MARK: - office-agent-tools T4: sheets write verbs

    func sheetsSet(docId: String, sheet: String, range: String, cellAddresses: [String], cellValues: [String]) throws -> Int {
        try thread.sync { try self.sheetsSetOnDedicatedThread(docId: docId, sheet: sheet, range: range,
                                                               cellAddresses: cellAddresses, cellValues: cellValues) }
    }
    func sheetsResize(docId: String, sheet: String, dimension: OfficeSheetsResizeDimension,
                      op: OfficeSheetsResizeOp, selectionRange: String) throws -> (usedEndColumn: Int, usedEndRow: Int) {
        try thread.sync { try self.sheetsResizeOnDedicatedThread(docId: docId, sheet: sheet, dimension: dimension,
                                                                  op: op, selectionRange: selectionRange) }
    }
    func sheetsManageSheet(docId: String, op: OfficeSheetsManageSheetOp, name: String, newName: String?) throws -> [String] {
        try thread.sync { try self.sheetsManageSheetOnDedicatedThread(docId: docId, op: op, name: name, newName: newName) }
    }

    // MARK: - office-agent-tools T5: sheets format

    func sheetsFormat(docId: String, sheet: String, range: String, columnSpan: String?,
                      bold: Bool?, italic: Bool?, numberFormat: OfficeSheetsNumberFormatPreset?,
                      align: OfficeSheetsAlign?, width: Double?) throws -> [String] {
        try thread.sync {
            try self.sheetsFormatOnDedicatedThread(docId: docId, sheet: sheet, range: range, columnSpan: columnSpan,
                                                    bold: bold, italic: italic, numberFormat: numberFormat,
                                                    align: align, width: width)
        }
    }

    // MARK: - office-agent-tools T6: slides
    //
    // CHECKPOINT STUB, not the real mechanism — mirrors Task 1's own precedent for this exact
    // situation ("T1 builds only the wire and a routing shell that refuses every verb... T3 gives
    // sheets' two READ verbs real behaviour"). The wire/protocol/dispatch/consumer plumbing above
    // this file is real and complete; ONLY the LOK mechanism itself is pending live-research-informed
    // implementation (the two hazard classes this bridge has already been burned by once each:
    // a missing/malformed UNO arg opening a headless modal, and a guessed-wrong command name silently
    // no-op'ing — neither is worth risking on an UN-researched command name). Every call below throws
    // honestly rather than guessing.
    func slidesInfo(docId: String) throws -> [OfficeSlideInfo] {
        try thread.sync { try self.slidesInfoOnDedicatedThread(docId: docId) }
    }
    func slidesRead(docId: String, slide: Int) throws -> (title: String?, body: String?) {
        try thread.sync { try self.slidesReadOnDedicatedThread(docId: docId, slide: slide) }
    }
    func slidesSetText(docId: String, slide: Int, title: String?, body: String?) throws -> [String] {
        try thread.sync { try self.slidesSetTextOnDedicatedThread(docId: docId, slide: slide, title: title, body: body) }
    }
    func slidesManagePage(docId: String, op: OfficeSlidesManagePageOp, slide: Int?, at: Int?, to: Int?,
                          layout: OfficeSlidesLayoutPreset?) throws -> Int {
        try thread.sync { try self.slidesManagePageOnDedicatedThread(docId: docId, op: op, slide: slide, at: at,
                                                                      to: to, layout: layout) }
    }

    // MARK: - Office Stage B Task 10 — the CFB release blocker

    /// The on-disk signature of every OLE2/Compound File Binary document — the container format
    /// underneath every legacy MS Office binary format (`.doc`/`.xls`/`.ppt`). Content-sniffed, not
    /// path-sniffed, because the crash this closes is ITSELF content-sniffed: LOK's own importer
    /// dispatches off the BYTES, never the extension
    /// (`OfficeHelperLiveTests.testRealLegacyBinaryFixturesOpenAsTextAfterR3RecutXlsStillFailsCleanly`'s
    /// own `legacy-doc.doc`/`legacy-ppt.ppt` — PRE-Task-11, a direct libc `exit()` deep inside LO's
    /// C++ import path that bypassed Swift's `try`/`catch` entirely, taking every OTHER open
    /// document's unsaved edits down with the one shared helper; Task 11's vendor re-cut fixed the
    /// underlying missing-dylib mechanism for these two fixtures specifically — see that
    /// test's own header for what is, and is not, proven by that fix). A user's genuine `.doc`
    /// renamed `.docx` (or any CFB file placed under a modern extension, accidentally or not) is
    /// exactly the scenario this gate exists to intercept regardless of whether the LOK-side import
    /// crashes or not — untrusted, mislabeled CFB content reaching `documentLoad` unguarded is the
    /// hazard, not merely "does it crash today."
    private static let cfbMagicBytes: [UInt8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]

    /// Fix-round-2 N2 (security re-review) — **this used to be a positive allowlist of extensions
    /// TO GUARD (`["xlsm", "odg"]`), and its own comment defended only the OVER-inclusion question**
    /// ("no legitimate CFB file has ever carried either extension"). That defended the wrong
    /// direction: I2's actual bug (the finding this constant was added to fix, immediately below —
    /// still the historical record of what happened) was UNDER-inclusion — T9 widened
    /// `officeFileExtensions` (`PanelEditorTab.swift`) and this hand-mirrored copy silently did not
    /// follow, leaving CFB bytes under the two new extensions unguarded until caught. The old
    /// comment's own "by construction, not by an enforced tripwire" line conceded exactly this gap
    /// without closing it — a THIRD widening would have reproduced I2 verbatim, with nothing (no
    /// compiler, no test) positioned to catch it before a live run did.
    ///
    /// Inverted instead of patched: this is now a NEGATIVE allowlist — extensions where genuine CFB
    /// content is EXPECTED and must reach `documentLoad`, not refused — so every extension not
    /// named here, including every future one, defaults to PROTECTED. `doc`/`ppt`/`xls` are the
    /// pre-2007 binary formats that are natively OLE2/CFB containers by definition.
    /// `officeFileExtensions` (`PanelEditorTab.swift`) still contains none of them — this app's own
    /// document-tab ROUTING never sends this helper a `.doc`/`.ppt`/`.xls` path in production today.
    ///
    /// Fix-round-3 (convergence re-review) F2 — **the sentence that WAS here next, "a repo-wide grep
    /// turns up zero fixtures or tests for any of the four … so today this allowlist is inert," was
    /// FALSE, not merely unverified.** `git ls-files` returns three committed fixtures —
    /// `Tests/NormaAppTests/Fixtures/office/legacy-doc.doc`, `legacy-ppt.ppt`, `legacy-xls.xls`, each
    /// beginning with the real CFB magic bytes (`d0cf11e0a1b11ae1`, verified via `xxd`) — and
    /// `OfficeHelperLiveTests.testRealLegacyBinaryFixturesOpenAsTextAfterR3RecutXlsStillFailsCleanly`
    /// opens all three through THIS exact helper. Application routing being closed is a fact about
    /// `PanelEditorTab.swift`, not about this test file, which calls `spawnLiveHelper()` directly and
    /// bypasses that routing entirely — the allowlist is LOAD-BEARING TODAY, precisely, not inert:
    ///   - Drop `xls` → CFB bytes under `.xls` would hit THIS gate's own refusal instead of reaching
    ///     `documentLoad` → the test's pinned failure reason ("loadComponentFromURL returned an empty
    ///     reference") would no longer match → RED.
    ///   - Drop `doc`/`ppt` → **updated at Task 11**: a clean gate refusal means `open()` throws
    ///     `OfficeHelperClientError.openFailed` with the CFB-refusal reason string INSTEAD of
    ///     returning the clean `OfficeDocumentMetadata` (`type: .text`, specific `parts`/`sizeTwips`)
    ///     that test now asserts for these two fixtures (Task 11's vendor re-cut fixed the crash
    ///     that used to make this bullet's OLD point — "surviving instead of dying" — the
    ///     discriminator; the allowlist itself never changed, only what happens once content passes
    ///     through it) → a thrown error where the test expects a typed, successful open → RED either
    ///     way.
    ///
    /// `xlsb` was removed from this allowlist here (it was present through fix round 2): F5, same
    /// re-review. `.xlsb` (Excel Binary Workbook) is a POST-2007 OPC/ZIP package — BIFF12 binary
    /// records inside the same ZIP container shape as `.xlsx`/`.xlsm`, never an OLE2/CFB file, so it
    /// never belonged in a "genuine CFB is expected here" allowlist. A REAL `.xlsb` file is ZIP and
    /// never trips `pathBeginsWithCFBMagic` regardless of this list, so removing it changes nothing
    /// for genuine files — but leaving it in this allowlist would have silently DISABLED the CFB
    /// guard for `.xlsb` the day T9's own concern #6 ships real support for it: a malicious or
    /// mislabeled CFB payload under a `.xlsb` extension would have reached `documentLoad` unguarded,
    /// the exact helper-killing path this whole gate exists to close. `PanelEditorTab.swift`'s own
    /// header still has the fuller "why xlsb was left out of Stage B's scope" context (LOK's own
    /// `saveAs` could not source genuine `xlsb` bytes within that task's scope — a different, orthogonal
    /// reason from this one, which is purely about container format).
    ///
    /// **None of these three is reachable through the app's own document-tab routing today** — that
    /// half of the original claim was correct and is unchanged. It names its own escape hatch in
    /// advance anyway, for the day the app widens `officeFileExtensions` to include one of them (at
    /// which point a real `.doc` file IS a real CFB file and must open, not be refused) — the
    /// alternative, an unconditional gate with no allowlist at all, would need editing again at that
    /// point instead of already being correct.
    private static let cfbNativeLegacyExtensions: Set<String> = ["doc", "ppt", "xls"]

    /// **The needle `OfficeRuntime.knownLOKErrorShapes` (app target) matches on.** Hand-mirrored,
    /// never imported — the SAME cross-module boundary `OfficeSaveFormat`'s own header already
    /// documents (`OfficeDocumentBridge`'s header in `OfficeHelperServer.swift`): the app target
    /// cannot import this module, so its mapping table carries this exact string as a second,
    /// intentional copy. Distinct from every existing shape in that table by construction — contains
    /// neither "documentLoad failed" nor "Unspecified Application Error" nor "loadComponentFromURL
    /// returned an empty reference" as a substring — so first-hit needle matching there can never
    /// mis-route this reason to a different sentence, in either direction.
    private static let cfbUnderModernExtensionReason =
        "refused before documentLoad: legacy OLE2/CFB binary content under a modern Office extension"

    /// Reads only the first 8 bytes (`FileHandle`, never a full-file load) — cheap regardless of the
    /// real document's size. `false` for a nonexistent/unreadable/shorter-than-8-bytes path,
    /// deliberately: this gate must never be the reason a garbage/missing path (the pre-existing
    /// `2.garbage`-shaped tests) sees a DIFFERENT failure than `documentLoad`'s own not-found
    /// handling already produces — it only ever intercepts a path that is both readable AND
    /// genuinely CFB-shaped.
    private func pathBeginsWithCFBMagic(_ path: String) -> Bool {
        guard let handle = FileHandle(forReadingAtPath: path) else { return false }
        defer { handle.closeFile() }
        let prefix = handle.readData(ofLength: Self.cfbMagicBytes.count)
        return Array(prefix) == Self.cfbMagicBytes
    }

    // MARK: - Dedicated-thread-only implementation

    private func openOnDedicatedThread(docId: String, path: String) throws -> OfficeDocumentMetadata {
        // Office Stage B Task 10 — the release blocker's refusal, ahead of `documentLoad` on
        // purpose: the whole point is that LOK never sees these bytes at all. `path` here is already
        // the STAGED copy (`OfficeRuntime.stagedPath` preserves the real document's own extension —
        // verified before writing this), so the production open path is gated exactly like every
        // direct/live-test open below is.
        //
        // Fix-round-2 N2 (security re-review) — **this used to be a positive check** ("is `ext` one
        // of the six modern read-write formats, OR one of T9's two widened viewer-only formats") —
        // inverted to a negative one: refuse CFB for every extension EXCEPT
        // `cfbNativeLegacyExtensions` (that constant's own doc comment has the full history: the
        // positive version is exactly what let I2 happen — T9 widened `officeFileExtensions`
        // app-side and this gate's own hand-mirrored copy of "which extensions to guard" silently
        // did not follow). The shared helper dies identically regardless of which open request
        // triggered the underlying LOK `exit()`, taking every OTHER open document's unsaved edits
        // down too — so "refuse by default, name only the exceptions" is the correct default for a
        // gate whose failure mode is that severe, and it means a FOURTH extension added to
        // `officeFileExtensions` tomorrow needs no matching edit here to stay safe, unlike the
        // THIRD one (`xlsm`/`odg`, T9) did.
        // `.lowercased()` matters more now than it did for the old positive check: this is a
        // DENY-BY-DEFAULT gate, so a case mismatch here fails CLOSED in the over-cautious direction
        // — an uppercase `.DOC`/`.PPT`/`.XLS` that missed `cfbNativeLegacyExtensions`'s membership
        // test (all lowercase literals) would be wrongly REFUSED (a legitimate legacy file blocked),
        // not wrongly admitted (fix-round-3, F6: the previous wording here said "fails OPEN, not
        // closed" immediately before describing a wrongly-REFUSED outcome — refusing IS failing
        // closed; the two halves of that sentence contradicted each other). Safer than the reverse
        // mistake would be, but still a real, avoidable false refusal — which is what `.lowercased()`
        // avoids. Still matches `OfficeSaveFormat.init?(pathExtension:)`'s own internal lowercasing
        // (its switch is on `pathExtension.lowercased()`) for the unrelated reason that call still
        // sits below.
        let ext = (path as NSString).pathExtension.lowercased()
        if !Self.cfbNativeLegacyExtensions.contains(ext), pathBeginsWithCFBMagic(path) {
            throw LoadError.documentLoadFailed(Self.cfbUnderModernExtensionReason)
        }

        // URL(fileURLWithPath:).absoluteString percent-encodes correctly (spaces included — this
        // repo's own checkout path has one: ".../Xcode progects/..."); the spike's naive
        // "file://" + path concatenation is fine for its own spaceless fixture names but not
        // something to repeat here.
        let fileURLString = URL(fileURLWithPath: path).absoluteString
        guard let rawDoc = kit.pointee.pClass.pointee.documentLoad?(kit, fileURLString) else {
            let reason: String
            if let errCStr = kit.pointee.pClass.pointee.getError?(kit) {
                reason = String(cString: errCStr)
                kit.pointee.pClass.pointee.freeError?(errCStr)
            } else {
                reason = "documentLoad failed (no error string available)"
            }
            throw LoadError.documentLoadFailed(reason)
        }

        // office-agent-tools T3 review (C1) — the permanent ABI tripwire. `nSize` is the ENGINE's
        // own report of how many bytes of `LibreOfficeKitDocumentClass` it actually populated
        // (`LIBREOFFICEKIT_DOCUMENT_HAS`'s own `offsetof(...) < nSize` feature-detection macro
        // relies on this same field for the identical purpose). Comparing it against what THIS
        // BUILD's Swift compilation believes the struct's size to be, from the vendored header
        // alone, is a single cheap integer check that would have caught the real bug this task's
        // own investigation found: three phantom members (`sendDialogEvent`,
        // `setAllowChangeComments`, `setAllowManageRedlines`) the vendored header declared that
        // this compiled engine's struct does not actually have, silently shifting every
        // subsequent field's computed offset — proven root cause of `getDataArea` (before this
        // fix) actually invoking `doc_getEditMode`, discovered by dladdr-resolving the raw
        // function pointer at that field's position on a real open document, not by inference.
        //
        // Verified empirically, exhaustively, not just at this boot-time size check: after
        // removing all three phantoms, EVERY ONE of the struct's 78 remaining members — read
        // individually via `pClass->pointee.<name>` on a real open document and resolved through
        // `dladdr` back to a symbol — names exactly the function the engine actually put there,
        // with zero exceptions (the investigation's own full sweep; not repeated here as
        // production code, since this one size check already re-derives the same fact on every
        // boot going forward).
        //
        // **NOW mirrored for `LibreOfficeKitClass` too (the office-level boot struct, `self.kit`,
        // guarded in `init`)** — correcting an earlier version of this comment that called the
        // absence deliberate: a THIRD re-review found the office class genuinely drifted the same
        // way (a phantom `sendDialogEvent` cancelling a missing real tail member in COUNT, so a
        // size check alone passed even while misaligned) and added both a size check and a
        // tail-identity check there. See `init`'s own tripwire for the full account.
        //
        // Third re-review, also — **throws rather than `precondition`-crashes, corrected from an
        // earlier version of this check.** A precondition failure kills the WHOLE HELPER PROCESS
        // outright, taking every other document it might be serving down with it (a respawn after
        // some unrelated crash could hold several); this function is already `throws`, called from
        // a connection thread that already handles a failed `open` as an ordinary per-document
        // error. Reuses `LoadError`, the identical throw type this same function already uses a few
        // lines up for `documentLoad` itself failing — the SAME "this bridge always survives, one
        // failed open is not a crash" posture that error already has.
        guard rawDoc.pointee.pClass.pointee.nSize == MemoryLayout<LibreOfficeKitDocumentClass>.size else {
            throw LoadError.documentLoadFailed(
                "LibreOfficeKit ABI mismatch: engine reports nSize=\(rawDoc.pointee.pClass.pointee.nSize) but "
                    + "this build's LibreOfficeKit.h describes a \(MemoryLayout<LibreOfficeKitDocumentClass>.size)-byte "
                    + "struct — the vendored header no longer matches the compiled engine and every LOK call in this "
                    + "file needs re-verifying against the real ABI before this assertion is loosened.")
        }

        // The tail-identity check the size check alone cannot provide (same reasoning as `init`'s
        // own office-class pair, and the SAME disclosed limitation: this catches the struct's own
        // LAST declared member being renamed/removed/shifted, not an interior add-one/remove-one
        // pair that cancels in count above this position — see `init`'s own tripwire for the full
        // account of what tail-identity drift does and does not cover). `setColorPreviewState` is
        // this struct's own current last declared member (confirmed by this task's own exhaustive
        // 78-member sweep, `task-3-report.md`'s own account).
        let lastDocumentMemberSymbol = Self.resolvedSymbolName(
            unsafeBitCast(rawDoc.pointee.pClass.pointee.setColorPreviewState, to: UnsafeRawPointer?.self))
        guard lastDocumentMemberSymbol.contains("setColorPreviewState") else {
            throw LoadError.documentLoadFailed(
                "LibreOfficeKit ABI mismatch: this struct's own last declared member (setColorPreviewState) "
                    + "resolved to \"\(lastDocumentMemberSymbol)\" instead — the header no longer matches the "
                    + "compiled engine's real member order.")
        }

        // Register BEFORE initializeForRendering so any invalidation LOK fires synchronously
        // during that call is captured, not missed.
        let context = DocumentCallbackContext(bridge: self, docId: docId)
        let unmanagedContext = Unmanaged.passRetained(context)
        rawDoc.pointee.pClass.pointee.registerCallback?(rawDoc, lokBridgeDocumentCallback, unmanagedContext.toOpaque())

        rawDoc.pointee.pClass.pointee.initializeForRendering?(rawDoc, nil)

        // Fix round 2 (CRITICAL) — captured HERE. Reliable via `getView`'s own DocId-filtered
        // resolution (see `OpenDocument.viewId`'s own header — this read does NOT depend on
        // `rawDoc`'s view actually being "current"). `?? -1` mirrors `getView`'s own documented
        // "no view" sentinel — never invented by this bridge.
        let viewId = rawDoc.pointee.pClass.pointee.getView?(rawDoc) ?? -1

        let typeInt = rawDoc.pointee.pClass.pointee.getDocumentType?(rawDoc) ?? -1
        let kind = OfficeDocumentKind(lokDocumentType: typeInt)
        let parts = Int(rawDoc.pointee.pClass.pointee.getParts?(rawDoc) ?? 0)
        var width: Int = 0
        var height: Int = 0
        // Fix round 3 (MINOR, safety argument for a future reader adding calls here) —
        // `getDocumentSize` (`ScModelObj::getDocumentSize`, `sc/source/ui/unoobj/docuno.cxx`) IS
        // current-view-dependent for Calc, via the same static `ScDocShell::GetViewData()` pattern
        // as the confirmed-broken `setPart`/`getPart` (not instance-scoped like `paintTile`). Safe
        // HERE, specifically, only because `lo_documentLoadWithOptions`'s own source carries its own
        // confirming comment — `desktop/source/lib/init.cxx:2984`, this codebase's pinned LO commit
        // `11482c8f`: `// After loading the document, its initial view is the "current" view.` —
        // `rawDoc`'s freshly-created view is genuinely process-global-current at this exact point,
        // and nothing else can run on `thread` between `documentLoad` and this call within the same
        // synchronous `openOnDedicatedThread` job to disturb that. This does NOT generalize: a call
        // added later in this same function, or in any OTHER dedicated-thread job, has no such
        // guarantee and needs its own `setView(rawDoc, viewId)` prefix — this call is safe only by
        // virtue of being the FIRST current-view-dependent read after the view that makes it current.
        rawDoc.pointee.pClass.pointee.getDocumentSize?(rawDoc, &width, &height)

        // Office Stage B Task 2 — captured once, here, from the path this document was opened
        // with. `NSString.pathExtension` strips the leading dot ("xlsx", not ".xlsx") — exactly
        // what `OfficeSaveFormat.init?(pathExtension:)` expects.
        let saveFormat = OfficeSaveFormat(pathExtension: (path as NSString).pathExtension)
        documents[docId] = OpenDocument(handle: rawDoc, context: unmanagedContext,
                                          tileRenderer: TileRenderer(handle: rawDoc), saveFormat: saveFormat,
                                          viewId: viewId, kind: kind)
        return OfficeDocumentMetadata(
            type: kind, parts: parts,
            sizeTwips: OfficeDocumentSize(widthTwips: Int64(width), heightTwips: Int64(height)))
    }

    private func closeOnDedicatedThread(docId: String) {
        guard let doc = documents.removeValue(forKey: docId) else { return }
        // Office Stage B Task 6 — explicit destroyView for the agent view BEFORE `destroy`. Cited
        // at the vendored pin: `doc_destroyView` calls `LOKClipboardFactory::
        // releaseClipboardForView(nId)` (a SPECIFIC view id), while `doc_destroy` only ever calls
        // `releaseClipboardForView(-1)` — the factory is a static, view-id-keyed registry that
        // outlives any one document in this long-lived helper, so skipping this leaks one
        // clipboard object per agent view per open/close cycle, forever. The PRIMARY view needs no
        // matching call: T4's own report already established `doc_destroy` disposes every view the
        // document itself owns via its `mxComponent` teardown cascade — this is ONLY about the
        // clipboard factory's OWN separate, view-id-keyed bookkeeping for a view minted OUTSIDE
        // `documentLoad`'s own view.
        // `>= 0` (re-review MISS 1's own "every consumer" instruction) — both writers of
        // `agentViewId` now throw rather than cache a failed mint, so this should never actually
        // observe a negative id, but `destroyView`'s own behavior on an unresolved id was never
        // verified by this bridge, and guarding here costs nothing.
        if let agentViewId = doc.agentViewId, agentViewId >= 0 {
            doc.handle.pointee.pClass.pointee.destroyView?(doc.handle, agentViewId)
        }
        doc.handle.pointee.pClass.pointee.destroy?(doc.handle)
        doc.context.release()
    }

    private func paintTileOnDedicatedThread(docId: String, key: TileKey) throws -> TilePaintResult {
        guard let doc = documents[docId] else { throw TileError.docNotOpen(docId) }
        // Office Stage B Task 7 — `OpenDocument.lastKnownPart`'s own tracking write; see that
        // field's own header for why paint (not every part-scoped call) is where this lives.
        // Written to the DICTIONARY directly (`doc` above is a local copy of the struct at entry,
        // never mutated itself) — every OTHER read in this function keeps using `doc`, unaffected.
        documents[docId]?.lastKnownPart = key.part
        // Fix round 2 (CRITICAL) — see `OpenDocument.viewId`'s own header. `paintPartTile`
        // (`TileRenderer.renderRaw`'s one real LOK call) inherits the SAME process-global-current-
        // view hazard `setPart` has, through its own internal `doc_setPartImpl` call when no
        // "alternative view" is found — confirmed empirically by the two-document live drills in
        // `OfficeRuntimeLiveTests.swift` failing at this exact assertion before this line existed.
        // Asserted UNCONDITIONALLY, first, every job — see `postKeyOnDedicatedThread`'s own header
        // for why this bridge never tries to track "did the current view already happen to match"
        // instead.
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        // Fix round 3 (IMPORTANT-A) — a SECOND, separate hazard in the same LOK function, not closed
        // by `setView` alone: `getAlternativeViewForPaint` (`desktop/source/lib/init.cxx:4387-4414`)
        // searches every open view-shell for one already sitting at the requested part/mode with a
        // matching render-state string — with NO `DocId` filter. A bystander document of ANY type
        // (confirmed live with a Writer document, whose `getPart()`/`getEditMode()` trivially read
        // 0/0) can match; when it does, `doc_paintPartTile` skips `setPart` ENTIRELY and paints via
        // THIS document's own view exactly as it already sits — stale, if it was last left at a
        // different part by real typing. `setPart` here — explicit, ahead of the paint, matching
        // `key.part` — closes this the same way the input path already does: `doc_paintPartTile`'s
        // own trigger for the search (`nPart != doc_getPart(pThis)`) is the FIRST thing it checks,
        // so by the time it runs, this document is already at the requested part and the mismatch
        // that summons the unfiltered scan never arises. Confirmed empirically, not just by source
        // reading: `testRequestingPartZeroAfterTypingOnSheetTwoRendersSheetOneNotAStaleBystanderMatch`
        // (`OfficeRuntimeLiveTests.swift`) fails at exactly this mismatch before this line existed.
        //
        // **Fix round 4 (NEW-1, CRITICAL) — type-gated, exactly the way LOK gates its own.** Round
        // 3 shipped this call UNCONDITIONALLY, on the argument that "every `TileKey` this codebase
        // ever constructs carries the requesting canvas's own currently active part, so a paint can
        // never steal the document's active-sheet state." That argument was too strong in TWO
        // independent directions, and the first one is a live caret bug for every Writer document:
        //
        //   1. **Type.** `doc_paintPartTile` guards its own `doc_setPartImpl` (and its restore) on
        //      `!isText` — `init.cxx:4458-4461`/`:4485-4490`/`:4514-4519`, pinned commit `11482c8f`,
        //      with its own reason in the source: "Text documents have a single coordinate system;
        //      don't change part." For Writer, `setPart` is a CARET MOVE, not a viewport switch
        //      (`SwXTextDocument::setPart` = `GotoPage(nPart + 1, true)`, no same-page early-out —
        //      see `OpenDocument.kind`'s own header for the full citation chain). Norma pins every
        //      text document at part 0, so an ungated prefix here fired `GotoPage(1)` before EVERY
        //      Writer tile paint — including helper-cache HITS, since this prefix runs before
        //      `TileRenderer.paint`'s own cache lookup — yanking the user's caret to the top of page
        //      1. `postKeyEvent` is `PostUserEvent`-async while this is synchronous, so a repaint
        //      interleaving between keystrokes could land the rest of a word at page-1 start.
        //      Proven live: `testTypingIntoAWriterDocumentSurvivesAnInterleavedTileRepaint`.
        //
        //      Checked, not assumed, that gating this out costs a text document NOTHING —
        //      specifically, that it does not re-open round 3's own IMPORTANT-A hazard for Writer.
        //      Two independent reasons, both read at the pin: (a) the unfiltered
        //      `getAlternativeViewForPaint` scan is not merely unlikely for a text document, it is
        //      UNREACHABLE — `doc_paintPartTile` only summons it when
        //      `nPart != doc_getPart(pThis) || nMode != pDoc->getEditMode()`, and for Writer BOTH
        //      sides are structurally zero (`SwXTextDocument::getPart` → `SwView::getPart`, which
        //      `sw/source/uibase/inc/view.hxx` never overrides, so it is `SfxViewShell::getPart`'s
        //      own `return 0` at `sfx2/source/view/viewsh.cxx:3563`; `getEditMode` likewise at
        //      `:3568`) while `TileRenderer.renderRaw` always passes `nPart = key.part` (0 for every
        //      text document here) and `nMode = 0`. (b) Even if it were reached, the paint itself is
        //      instance-scoped: `SwXTextDocument::paintTile` (`unotxdoc.cxx:3372-3394`) resolves
        //      entirely through `m_pDocShell`, never through anything global.
        //   2. **Part staleness.** "A paint's `key.part` always equals what the user is looking at"
        //      is true of the CONSTRUCTION of every key, but not of the moment one is PAINTED: an
        //      in-flight prefetch chunk cut by a part switch is still delivered, so a paint carrying
        //      the OLD part can genuinely arrive after `activePart` has moved on and re-park LOK
        //      there. That window is real and is deliberately left open here (a stale paint must
        //      still paint the part it was asked for, or it would return the wrong pixels under its
        //      own key); it is closed where it actually matters instead — `saveAsOnDedicatedThread`
        //      asserts the USER's active part before writing, so no paint ordering can decide what
        //      a save records. See fix round 4 (NEW-2) at that method's own header.
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: key.part))
        }
        let (generation, pixels) = try doc.tileRenderer.paint(key: key)
        return TilePaintResult(generation: generation, pixels: pixels,
                                width: TileMath.tilePixelSize, height: TileMath.tilePixelSize)
    }

    /// Office Stage B Task 2 — renders `docId`'s current in-memory state to
    /// `<state-path>/saves/<docId>-<seq>.<ext>`, in the document's OWN format (`OpenDocument
    /// .saveFormat`, captured at open). Returns the temp file's path on success; the APP — not this
    /// bridge, and not `OfficeHelperServer` — is what places it onto the real document path (see
    /// `OfficeWireFrame.saved`'s own header). Throws, never traps: a bad `docId`, an unsupported
    /// format, or a genuine `saveAs` failure are all reported, and this bridge (and the document
    /// it was asked to save) survive every one of them exactly like a failed `paintTile`/`open`.
    ///
    /// **Office Stage B Task 2b — the save-mechanism decision, made empirically, kept here for the
    /// record.** Two candidates were live-tested against the tripwire
    /// (`OfficeRuntimeLiveTests.testSaveThroughTheDebugEditDoorThenCloseThenReopenPersistsRealContent
    /// AcrossTwoFormats`, task-2b-report.md has the full transcript): `.uno:Save` against the staged
    /// (writable, post-staging) document in place, and this `saveAs`-to-`saves/` + atomic-place
    /// mechanism, unchanged from Task 2. A stderr discriminator on each branch (since a green
    /// tripwire alone cannot tell "`.uno:Save` worked" apart from "it silently no-op'd and the
    /// fallback carried the whole test," and the one filesystem tell — `saves/` staying empty — is
    /// destroyed by test teardown before anyone could look) recorded, for BOTH `.ods` and `.odt`:
    /// **`.uno:Save`, dispatched fire-and-forget (`postUnoCommand`'s own `bNotifyWhenFinished:
    /// false`) and re-stat'd immediately, on the same thread, showed no observable change to the
    /// staged file's stat under that measurement.**
    ///
    /// **Fix round 1 (review IMPORTANT-2) — the claim above is deliberately narrower than an
    /// earlier version of this comment stated.** A same-thread re-stat taken right after a fire-
    /// and-forget dispatch cannot distinguish "genuinely a no-op" from "the command simply had not
    /// completed yet by the time of the re-stat" — "true no-op … not merely slow or async" overclaimed
    /// exactly the distinction this measurement has no way to make. The measurement was ALSO taken
    /// with `.uno:Save` dispatched BEFORE `saveAs` (the dual-branch probe's own order); the shipped
    /// code below dispatches it AFTER `saveAs`, an ordering never independently measured for its own
    /// file-persistence effect. None of this changes the DECISION — `saveAs` is the only mechanism
    /// that ever visibly persisted real bytes, in every save this task's own live testing ran, and
    /// is what PERSISTS the document — only the RATIONALE recorded for it, which now claims no more
    /// than what was actually observed. The probe machinery built to reach this decision
    /// (`attemptUnoSaveOnDedicatedThread`, the local stat-fingerprint pair, the stderr discriminator)
    /// was removed once the decision was made, no dead machinery kept.
    ///
    /// **`.uno:Save` still has ONE job left, discovered by the very next thing this task tried**: a
    /// live run against the fully-stripped code (probe gone, `saveAs` the only call) found `saveAs`
    /// alone never clears `ModifiedStatus` — I1's own live post-save dirty-clears wait failed, on
    /// BOTH formats, the moment `.uno:Save` was removed. Re-added below, unconditionally, AFTER a
    /// successful `saveAs` (the SHIPPED ordering, not the ordering measured above) — not as a
    /// competing persistence mechanism (nothing here trusts its file-write effect either way), but
    /// because it is empirically required for `ModifiedStatus=false` to fire IN THAT SHIPPED
    /// ORDERING — proven live, by I1's own wait, not inferred from the Stage 1 measurement above.
    /// The mechanism by which it clears the flag was not root-caused (LO-internal, not this task's
    /// to chase) — see the call site's own comment for the full account.
    ///
    /// **Fix round 2 (CRITICAL) — `setView` first, same job, same reasoning as `postKeyOnDedicated
    /// Thread`/`paintTileOnDedicatedThread`.** The real, byte-writing `saveAs` C-API call below reads
    /// `pDocument->mxComponent` directly (`desktop/source/lib/init.cxx`'s `doc_saveAs`, confirmed by
    /// reading it) — instance-scoped, genuinely safe regardless of which view is globally current.
    /// The `.uno:Save` FOLLOW-UP below is not: `doc_postUnoCommand` dispatches it through
    /// `comphelper::dispatchCommand` called with just `(command, arguments)` — the 2-argument call
    /// site, relying on the 3rd parameter's own DEFAULTED listener (`= {}` in
    /// `include/comphelper/dispatchcommand.hxx`) — which resolves its target via
    /// `xDesktop->getActiveFrame()` — the SAME process-global "current frame" concept `setPart` was
    /// found to misuse (confirmed by reading `comphelper/source/misc/dispatchcommand.cxx`), not the
    /// document-scoped `SfxLokHelper::getViewId` lookup `doc_postUnoCommand` performs earlier in its
    /// own body for its PDF-save special case and its unmodified-skip gate — that lookup is never
    /// used to target the dispatch itself. With a second document current, A's save still WRITES
    /// A's own bytes correctly (`saveAs` is safe) but the `.uno:Save` clear-the-flag follow-up lands
    /// on the OTHER document's frame — `ModifiedStatus=false` never fires for A, and the other
    /// document receives a `.uno:Save` dispatch it never asked for. Placed at the TOP of this method,
    /// unconditionally, matching every other dedicated-thread job's own placement — not narrowly
    /// scoped to just the `.uno:Save` call — the SAME "assert on entry, every job" invariant, never
    /// "track what the previous job left current." Empirically confirmed necessary (not merely
    /// theoretical) by the two-document live drills in `OfficeRuntimeLiveTests.swift`: RED at this
    /// exact dirty-clear wait once each drill's own "save interleave" (a real tile request against
    /// the OTHER document, immediately before save) reasserted it as current — GREEN with this line.
    ///
    /// **Fix round 4 (NEW-2) — the save asserts the USER's own active part, first.** Until this
    /// round, this was the ONE current-view-dependent job in this bridge with no `setPart` prefix at
    /// all: it inherited whatever part the last tile paint happened to leave LOK parked at. That is
    /// not merely untidy, it is a stale-window bug with a real trigger — a residency-prefetch chunk
    /// cut mid-flight by a part switch is still delivered, so a paint carrying the OLD part can
    /// re-park LOK there AFTER the user has switched, and if the new part's tiles are already cached
    /// no corrective paint follows to move it back. A save landing in that window records the stale
    /// sheet as the document's active one. Asserting `part` here — the SAME
    /// `DocumentEntry.activePart` the input verbs read, carried on the wire's own `save` frame —
    /// makes the answer independent of paint ordering entirely: whatever the paint traffic did, the
    /// bytes this method writes record where the USER is. Placed with the `setView` prefix at the
    /// top, unconditionally, matching every other job's "assert the invariant on entry" shape, and
    /// covering BOTH the `saveAs` write and the `.uno:Save` follow-up below.
    ///
    /// Type-gated for the same reason every other `setPart` in this file now is (fix round 4,
    /// NEW-1): for a text document `setPart` is `GotoPage`, a caret move, and saving must not move
    /// the user's caret. Nothing is lost — a text document has exactly one part here, so there is no
    /// stale-part window for it to be in.
    private func saveAsOnDedicatedThread(docId: String, seq: UInt64, part: Int) throws -> String {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        guard let format = doc.saveFormat else {
            throw SaveError.unsupportedFormat("(format not captured at open)")
        }
        let destination = savesDirectory.appendingPathComponent("\(docId)-\(seq).\(format.fileExtension)")
        // `URL(fileURLWithPath:).absoluteString` percent-encodes correctly — the same reason
        // `openOnDedicatedThread` builds its own `fileURLString` this way rather than a naive
        // "file://" + path concatenation (this repo's own checkout path has a space in it).
        let destinationURLString = URL(fileURLWithPath: destination.path).absoluteString
        // `pFormat` is the bare extension, NOT a filter name — see `OfficeSaveFormat.fileExtension`'s
        // own doc comment for the live-test-caught correction.
        let succeeded = destinationURLString.withCString { urlPtr -> Bool in
            format.fileExtension.withCString { formatPtr in
                doc.handle.pointee.pClass.pointee.saveAs?(doc.handle, urlPtr, formatPtr, nil) != 0
            }
        }
        guard succeeded else {
            let reason: String
            if let errCStr = kit.pointee.pClass.pointee.getError?(kit) {
                reason = String(cString: errCStr)
                kit.pointee.pClass.pointee.freeError?(errCStr)
            } else {
                reason = "saveAs failed (no error string available)"
            }
            throw SaveError.saveAsFailed(reason)
        }
        // Office Stage B Task 2b (I1) — **empirically required, not theoretical**: `saveAs` alone
        // does not clear LOK's own internal modified flag (confirmed directly: the tripwire's live
        // post-save dirty-clears wait failed against `saveAs` alone, on both formats, the moment the
        // separate `.uno:Save` probe this decision's own live testing used was removed). Dispatching
        // `.uno:Save` here — never as the primary persistence mechanism (that empirical decision,
        // and why, is this method's own header above) — is what actually flips `ModifiedStatus` to
        // `false`, confirmed by the SAME raw callback trace `task-2b-report.md` captures: every
        // observed `.uno:ModifiedStatus=false` in this task's live testing followed a `.uno:Save`
        // dispatch, never a bare `saveAs` alone. The exact LO-internal reason (SfxObjectShell's own
        // "document saved" bookkeeping updating on ANY completed `.uno:Save` dispatch, independent
        // of whether the medium write itself did anything, is the plausible mechanism, not
        // independently confirmed) is not chased further — fire-and-forget, matching every other
        // `postUnoCommand` call in this bridge; the tripwire's own live wait is what proves it lands
        // in practice, not an assumption about ordering.
        ".uno:Save".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
        return destination.path
    }

    /// Office Stage B Task 7 — the autosave sidecar write: `<state-path>/autosave/<docId>.<ext>`,
    /// `ext` from `OfficeSaveFormat.autosaveFormat`. **Native for all six formats** as of the r4
    /// vendor re-cut. Task 7 originally fell back to ODF for all three OOXML formats uniformly;
    /// Task 11's r3 re-cut replaced that evidence-light caution with per-format measurement and
    /// narrowed it to `.docx` alone; r4 fixes the DOCX export service gap that kept it there — see
    /// that property's own header for the per-format results and for why `isODFFallback` is kept
    /// plumbed even though nothing sets it today.
    ///
    /// **Bare `saveAs`, deliberately no `.uno:Save` follow-up** — the ONE structural difference
    /// from `saveAsOnDedicatedThread` immediately above, and the reason this is its own method
    /// rather than that one with an extra parameter. That method's own header states, empirically
    /// (not theoretically): a bare `saveAs` never clears LOK's `ModifiedStatus`; only the
    /// `.uno:Save` dispatch after it does. If a sidecar write cleared the dirty flag, the very FIRST
    /// autosave would fire `.modifiedChanged(false)` back over the wire, and
    /// `OfficeHelperServer`'s own `.modifiedChanged(false)` handling (mirroring the app's identical
    /// "clean means nothing to protect" reasoning) would cancel this document's OWN timer after
    /// exactly one fire — silently defeating "every 60s for as long as the document stays dirty."
    /// The real document's dirty/clean truth must be driven ONLY by a REAL save or a real undo,
    /// never by this side-channel write.
    ///
    /// **`setView`/type-gated `setPart` prefix — the SAME discipline `saveAsOnDedicatedThread`
    /// established** (fix rounds 2 and 4 there, cited at length in that method's own header): the
    /// bytes this writes must record where the USER actually is, not wherever the last paint or a
    /// bystander document's own current-view left LOK parked, and a Writer document's `setPart`
    /// must stay gated out (`GotoPage`, a caret move, not a viewport switch — same citation).
    ///
    /// **Temp-then-rename, same directory** — a same-`autosave/`-directory `rename(2)` is atomic
    /// and same-volume by construction (no `EXDEV` concern the way `placeAtomically`'s cross-
    /// directory move has to guard against), and is the difference between "a SIGKILL mid-export
    /// leaves a torn, half-written sidecar recovery would silently trust" and "a SIGKILL mid-export
    /// leaves either the OLD complete sidecar or nothing — never a partial one." The temp name is
    /// UUID-suffixed, not seq-suffixed like `saveAsOnDedicatedThread`'s own `saves/` renders — this
    /// call carries no wire `seq` (it is never triggered by a wire request at all).
    ///
    /// **Fix round 1 (review I-1) — `isStillArmed()` is the VERY FIRST thing this method does, on
    /// purpose.** This IS "the dedicated-thread job" the review's own fix instruction names: by the
    /// time `thread.sync`'s closure actually starts running THIS body, any queueing delay against
    /// other work already on `thread` (a concurrent real save's own `.uno:Save`, most concretely)
    /// has already elapsed — checking here, rather than in `saveAsSidecar`'s own wrapper (which runs
    /// BEFORE that queueing delay, on the timer queue), is what makes the check see the state of
    /// the world AT THE MOMENT this method is about to write, not at the moment the timer fired
    /// minutes/moments earlier. A caller that captured its own boolean up front instead of a live
    /// closure would defeat this regardless of WHERE the check ran — see
    /// `OfficeAutosaveScheduler.isArmed`'s own header for the closure-capture half of this
    /// argument. Returning `nil` here (not throwing) is deliberate: skipping is the CORRECT outcome,
    /// not a failure — see the protocol requirement's own header.
    private func saveAsSidecarOnDedicatedThread(docId: String, isStillArmed: () -> Bool) throws -> (ext: String, isODFFallback: Bool)? {
        guard isStillArmed() else { return nil }
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: doc.lastKnownPart))
        }
        guard let realFormat = doc.saveFormat else {
            throw SaveError.unsupportedFormat("(format not captured at open)")
        }
        let (format, isODFFallback) = realFormat.autosaveFormat
        let finalDestination = autosaveDirectory.appendingPathComponent("\(docId).\(format.fileExtension)")
        let tempDestination = autosaveDirectory
            .appendingPathComponent(".tmp-\(docId)-\(UUID().uuidString).\(format.fileExtension)")
        let destinationURLString = URL(fileURLWithPath: tempDestination.path).absoluteString
        let succeeded = destinationURLString.withCString { urlPtr -> Bool in
            format.fileExtension.withCString { formatPtr in
                doc.handle.pointee.pClass.pointee.saveAs?(doc.handle, urlPtr, formatPtr, nil) != 0
            }
        }
        guard succeeded else {
            try? FileManager.default.removeItem(at: tempDestination)
            let reason: String
            if let errCStr = kit.pointee.pClass.pointee.getError?(kit) {
                reason = String(cString: errCStr)
                kit.pointee.pClass.pointee.freeError?(errCStr)
            } else {
                reason = "saveAs failed (no error string available)"
            }
            throw SaveError.saveAsFailed(reason)
        }
        guard rename(tempDestination.path, finalDestination.path) == 0 else {
            let reason = "sidecar rename failed: \(String(cString: strerror(errno)))"
            try? FileManager.default.removeItem(at: tempDestination)
            throw SaveError.saveAsFailed(reason)
        }
        return (ext: format.fileExtension, isODFFallback: isODFFallback)
    }

    // Office Stage B Task 4 — the DEBUG-only `debugEditOnDedicatedThread` (a `.uno:GoToCell` +
    // `LibreOfficeKitDocumentClass.paste` stand-in for a real edit verb) is REMOVED, replaced by
    // the real `postKeyOnDedicatedThread`/`postMouseOnDedicatedThread` below. Its own retired
    // history, for the next reader who reaches for `.uno:EnterString` again: the brief originally
    // named that UNO command, but dispatching it via `postUnoCommand` popped a real LOK "Information"
    // dialog this headless embedding cannot answer and crashed the whole helper — reproduced twice,
    // a stray-XML theory tested and disproven (task-2-report.md has the full transcript). Later,
    // while root-causing a SEPARATE dirty-tracking bug, a plausible (never confirmed) reinterpretation
    // surfaced: every fixture that door was ever exercised against was sandboxed and outside
    // `--state-path`, the exact condition since shown to load a document read-only — an "Information"
    // dialog on the first edit attempt is consistent with a read-only-refusal prompt, not necessarily
    // an `EnterString`-specific defect. Documents are staged and genuinely writable now (Task 2b), and
    // `postKeyEvent`/`postMouseEvent` proved this task's own live tests never need `.uno:EnterString`
    // at all — the mystery is moot, not re-litigated.

    /// Office Stage B Task 4 — `postKeyEvent(nType, nCharCode, nKeyCode)`, LOK's own C signature,
    /// unchanged. `SaveError.docNotOpen` reused rather than a fresh error case for this non-save
    /// purpose — a real, dedicated `InputError` was considered and set aside as over-structure for
    /// one shared case with no other divergent member.
    ///
    /// **Fix round 1, F2 (CRITICAL) — `setPart` immediately before the post, unconditionally, in
    /// this SAME dedicated-thread job.** `postKeyEvent` has NO part parameter in LOK's own C API
    /// (`LibreOfficeKit.h` — confirmed by reading the header directly, not assumed): it always
    /// targets whichever part `setPart`/`getPart` currently say is active, a genuinely STATEFUL
    /// notion on LOK's side. Called UNCONDITIONALLY (never gated on "did the part actually change,"
    /// which would need its own `getPart` read and buys nothing but a saved no-op call) — this call
    /// and the post below run inside the SAME `thread.sync` job as `postKey`'s own single call into
    /// this method, so no other queued LOK work can observe or interleave between them.
    ///
    /// **Fix round 2 (CRITICAL) — `setView` first, same job, same reasoning.** Round 1's own comment
    /// here claimed `paintPartTile` avoids needing this because it "passes `nPart` DIRECTLY" — TRUE
    /// of the WIRE call this bridge makes, but it understated what `paintPartTile` does internally:
    /// reading `desktop/source/lib/init.cxx` showed it falls back to the SAME `doc_setPartImpl` this
    /// method's own `setPart` call reaches, and `sc/source/ui/unoobj/docuno.cxx` showed THAT call
    /// resolves its target through `ScDocShell::GetViewData()` — a PROCESS-GLOBAL "current view,"
    /// not `doc.handle`'s own document. With more than one document open (Norma's ordinary case),
    /// `setPart` on a NON-current document silently mutates whichever OTHER document is current
    /// instead — the target's own part never moves, and the wrong document's active part does.
    /// `setView` first, unconditionally, in every job that (directly or, like `setPart`, internally)
    /// depends on the current view, is the fix: assert the invariant on entry, every time, rather
    /// than track whether the previous job on this thread happened to leave the right view current —
    /// which is also why there is no matching "restore" call afterward. See `OpenDocument.viewId`'s
    /// own header for how the id is captured, and `paintTileOnDedicatedThread` for the identical
    /// prefix on the paint side — both empirically confirmed necessary by the two-document live
    /// drills in `OfficeRuntimeLiveTests.swift` (RED without this line, GREEN with it).
    ///
    /// **Fix round 4 (NEW-1, CRITICAL) — the `setPart` is type-gated; `setView` is not.** For a TEXT
    /// document `setPart` is not a scoping call at all, it is `GotoPage(nPart + 1)` — a caret move
    /// (`OpenDocument.kind`'s own header has the citation chain). Norma pins every text document at
    /// part 0, so the round-1 prefix was firing `GotoPage(1)` immediately before every single
    /// keystroke in a Writer document: harmless-looking only because a keystroke's own
    /// `postKeyEventAsync` runs later, but a genuine caret yank the moment anything else on this
    /// thread (a tile paint, which had the identical ungated prefix) interleaved. Gated exactly the
    /// way LOK gates its own (`isText`, `init.cxx:4458-4461`), and nothing is lost: a text document
    /// has one part by construction here, so the call could only ever have been a no-op or a bug.
    /// `setView` stays UNCONDITIONAL — it is document-scoped, correct for every kind, and it is
    /// what the whole round-2/round-3 cross-document proof rests on.
    private func postKeyOnDedicatedThread(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        doc.handle.pointee.pClass.pointee.postKeyEvent?(
            doc.handle, Int32(type.rawValue), Int32(truncatingIfNeeded: charCode), Int32(truncatingIfNeeded: keyCode))
    }

    /// Office Stage B Task 4 — `postMouseEvent(nType, nX, nY, nCount, nButtons, nModifier)`, LOK's
    /// own C signature. `nX`/`nY` (twips) truncate to `Int32` defensively — the same posture
    /// `TileRenderer.renderRaw`'s own `nTilePosX/Y` truncation already takes for a twips value this
    /// bridge does not itself bound-check (a hostile/extreme wire value is `TileMath`'s job to
    /// refuse at the SUBSCRIBE/REQUEST layer where it drives allocation; a raw mouse coordinate here
    /// drives nothing but LOK's own hit-testing, which a truncated-but-still-huge value cannot crash
    /// — LOK's own coordinate clamping, not this bridge's, is what makes an out-of-document click
    /// harmless).
    ///
    /// **Fix round 1, F2 — same `setPart`-first reasoning as `postKeyOnDedicatedThread` above, with
    /// one addition**: `nX`/`nY` are document-space twips, meaningful only relative to whichever
    /// part is current — a mismatched part would not just misdirect the click, it would misinterpret
    /// the COORDINATES themselves against the wrong part's own layout.
    ///
    /// **Fix round 2 (CRITICAL) — same `setView`-first reasoning as `postKeyOnDedicatedThread`
    /// above**, for the identical reason: `setPart` below depends on the process-global current
    /// view, not `doc.handle`.
    ///
    /// **Fix round 4 (NEW-1, CRITICAL) — same type gate as `postKeyOnDedicatedThread` above**, for
    /// the same reason and with one extra consequence worth naming here: for a text document the
    /// ungated `setPart` moved the caret to page-1 start immediately BEFORE interpreting this
    /// event's own twips coordinates, so a click landing on page 3 was preceded by a caret jump it
    /// then silently corrected — invisible in the common case, and exactly the sort of "it looked
    /// fine" that hid the caret yank on the keyboard path. The coordinate argument above still
    /// stands for the kinds that keep the call (`nX`/`nY` ARE part-relative for Calc/Impress).
    private func postMouseOnDedicatedThread(docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                                            count: Int, buttons: Int, modifiers: Int) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        doc.handle.pointee.pClass.pointee.postMouseEvent?(
            doc.handle, Int32(type.rawValue), Int32(truncatingIfNeeded: xTwips), Int32(truncatingIfNeeded: yTwips),
            Int32(truncatingIfNeeded: count), Int32(truncatingIfNeeded: buttons), Int32(truncatingIfNeeded: modifiers))
    }

    /// Office Stage B Task 5 — `postWindowExtTextInputEvent(pThis, nWindowId, nType, pText)`, LOK's
    /// own C signature. `nWindowId` is always `0`: `desktop/source/lib/init.cxx`'s
    /// `doc_postWindowExtTextInputEvent` resolves `nWindowId == 0` via `pDoc->getDocWindow()` —
    /// confirmed by reading `ScModelObj::getDocWindow()`/`SwXTextDocument::getDocWindow()`/
    /// `SdXImpressDocument::getDocWindow()` (`sc/source/ui/unoobj/docuno.cxx`,
    /// `sw/source/uibase/uno/unotxdoc.cxx`, `sd/source/ui/unoidl/unomodel.cxx`) — all three resolve
    /// through `GetBestViewShell`/`GetView`/`GetViewShell`, i.e. INSTANCE-scoped off `pDoc` itself,
    /// the same door `postMouseEvent`'s own `getTiledRenderable(pThis)` already uses safely. This is
    /// NOT the process-global-current-view hazard `setPart` has (fix round 2's own header) — but the
    /// `setView`/`setPart` prefix below is kept anyway, for the SAME reason `postKeyOnDedicatedThread`
    /// keeps it: `SfxLokHelper::postExtTextEventAsync`'s own dispatch (`LOKPostAsyncEvent`,
    /// `sfx2/source/view/lokhelper.cxx`) re-asserts `SfxLokHelper::setView` if the current view has
    /// drifted and calls `GrabFocus()` — "any posted input event is an activation gesture," the same
    /// finding fix round 2/NEW-3 already established for `postKey`/`postMouse`. `setPart` stays
    /// type-gated exactly like `postKeyOnDedicatedThread`'s own (fix round 4, NEW-1): for a text
    /// document `setPart` is `GotoPage`, a caret move, not a scoping call.
    private func postExtTextInputOnDedicatedThread(docId: String, part: Int, type: OfficeExtTextInputType, text: String) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        doc.handle.pointee.pClass.pointee.postWindowExtTextInputEvent?(doc.handle, 0, Int32(type.rawValue), text)
    }

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the second ("agent") view

    /// `getTextSelection(pMimeType, pUsedMimeType)`. `pUsedMimeType` is passed `nil` — LOK's own
    /// `doc_getTextSelection` (`desktop/source/lib/init.cxx`, this repo's vendored pin) marks that
    /// out-parameter "legacy" and only touches it `if (pUsedMimeType)`; skipping it avoids an
    /// extra `strdup`+`free` pair for a value this bridge always already knows (it asks for
    /// `"text/plain;charset=utf-8"` and gets back exactly that format or nothing). The returned
    /// `char*`, when non-null, is `convertOString`'s own `malloc`+`memcpy` (confirmed by reading it
    /// at the pin) — this bridge owns it and must `free()` it, unlike `getVersionInfo`'s
    /// deliberately-unfreed one-time boot read (see that call site's own header for why THAT one
    /// stays unfreed; this call runs on every Copy/Cut, so a leak here would be real and growing).
    /// `nullptr` — LOK's own "no selection available" answer (`getFromTransferable` failing, or no
    /// `XTransferable` at all) — is NOT an error: this method returns `""`, the "empty means
    /// nothing to copy" convention `OfficeWireFrame.clipboardCopyOk`'s own header states.
    ///
    /// `setView` unconditional, `setPart` type-gated — the SAME prefix `save`/`postKey`/
    /// `postMouse` already carry, for the SAME reason: `getTextSelection`'s own
    /// `ITiledRenderable::getSelection()` is genuinely view-dependent — LOK's own `doc_createView`
    /// calls `forceSetClipboardForCurrentView` (confirmed at the pin) — so a stale current-view/
    /// part left over from unrelated paint traffic could answer with the WRONG selection.
    private func clipboardCopyOnDedicatedThread(docId: String, part: Int) throws -> String {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        guard let cString = "text/plain;charset=utf-8".withCString({ mimePtr in
            doc.handle.pointee.pClass.pointee.getTextSelection?(doc.handle, mimePtr, nil)
        }) else {
            return ""
        }
        defer { free(cString) }
        return String(cString: cString)
    }

    /// The read half is IDENTICAL to `clipboardCopyOnDedicatedThread` above — get the selection
    /// FIRST, before mutating anything; after `.uno:Cut` there is nothing left to read. The
    /// mutation half — `.uno:Cut` via `postUnoCommand`, fire-and-forget
    /// (`bNotifyWhenFinished: false`) — mirrors `.uno:Save`'s own follow-up in
    /// `saveAsOnDedicatedThread` exactly: `doc_postUnoCommand`'s dispatch resolves through the
    /// process-global "active frame," which the SAME `setView` prefix above (asserted once,
    /// covering BOTH the read and the cut) already makes correct.
    private func clipboardCutOnDedicatedThread(docId: String, part: Int) throws -> String {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        let text: String
        if let cString = "text/plain;charset=utf-8".withCString({ mimePtr in
            doc.handle.pointee.pClass.pointee.getTextSelection?(doc.handle, mimePtr, nil)
        }) {
            defer { free(cString) }
            text = String(cString: cString)
        } else {
            text = ""
        }
        ".uno:Cut".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
        return text
    }

    /// `paste(pMimeType, pData, nSize)`. `text.utf8` bytes, never `text`'s native UTF-16/Swift
    /// storage — LOK's own C API takes a raw byte buffer tagged by MIME type
    /// (`"text/plain;charset=utf-8"`), which is exactly what `withCString`'s null-terminated buffer
    /// already is for a UTF-8 Swift string. `nSize` is measured independently
    /// (`text.utf8.count`), never inferred from the C buffer's own `strlen` at the far end — a
    /// pasted string containing an embedded NUL would otherwise truncate silently.
    ///
    /// `setView`/`setPart` prefix for the identical reason `clipboardCopy` carries it — confirmed
    /// DOUBLY here: `doc_paste` (the vendored pin) internally dispatches `.uno:Paste` through the
    /// SAME `comphelper::dispatchCommand` mechanism `.uno:Save`'s own fix-round-2 citation already
    /// found, which is unambiguously process-global-current-frame, not merely "possibly view
    /// dependent" the way `getTextSelection`'s own `ITiledRenderable::getSelection()` is.
    ///
    /// `paste()` is the ONE clipboard door LOK gives a real synchronous success/failure answer for
    /// — `false` throws `SaveError.pasteFailed`, surfaced to the caller as a genuine failure rather
    /// than silently swallowed the way `postKeyEvent`'s `void` return forces `keyEventOk` to be.
    private func clipboardPasteOnDedicatedThread(docId: String, part: Int, text: String) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        let byteCount = text.utf8.count
        let succeeded = "text/plain;charset=utf-8".withCString { mimePtr in
            text.withCString { textPtr in
                doc.handle.pointee.pClass.pointee.paste?(doc.handle, mimePtr, textPtr, byteCount) ?? false
            }
        }
        guard succeeded else {
            throw SaveError.pasteFailed(docId)
        }
    }

    /// `.uno:Undo` via `postUnoCommand`, fire-and-forget (`bNotifyWhenFinished: false`), against
    /// the document's OWN primary view (`doc.viewId` — never the agent view). `setView`
    /// unconditional, matching `.uno:Save`'s own follow-up in `saveAsOnDedicatedThread` —
    /// `doc_postUnoCommand`'s dispatch resolves through the process-global "active frame"
    /// (confirmed at the pin, cited at length there). No `setPart`: the brief's own words for this
    /// door are "view-scoped (setView prefix)" — `postUnoCommand` is not a part-scoped call the way
    /// `postKeyEvent`/`paintPartTile` are, and adding one speculatively is exactly the kind of
    /// untested claim this file's own history (fix rounds 1-4) warns against.
    ///
    /// **Deliberately does not attempt to distinguish "changed something" from "no-op / refused."**
    /// LOK's own `.uno:Undo` dispatches cleanly whether the undo stack is empty, whether the top
    /// item belongs to a DIFFERENT view (collaborative undo-repair may refuse or repair per-view —
    /// the two-writer characterization drill in `OfficeRuntimeLiveTests` exists to DISCOVER which,
    /// not assume it going in), or whether it genuinely undoes an edit — `postUnoCommand`'s own
    /// fire-and-forget contract gives this bridge no synchronous signal to tell those apart. LOK's
    /// C API DOES offer one (`bNotifyWhenFinished: true` plus a `LOK_CALLBACK_UNO_COMMAND_RESULT`
    /// callback) — deliberately NOT used here: consuming a brand-new callback type/vocabulary is a
    /// bigger surface than "wire Undo/Redo" asks for, and the drill's own save+reopen PLACEMENT
    /// assertions already answer the characterization question without it (they can distinguish
    /// isolated / shared-LIFO / no-op / multi-revert outcomes directly from what landed on disk).
    private func undoOnDedicatedThread(docId: String) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        ".uno:Undo".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
    }

    /// `.uno:Redo`, same posture as `undoOnDedicatedThread` above.
    private func redoOnDedicatedThread(docId: String) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        ".uno:Redo".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
    }

    /// `createView()`, LOK's own C signature (`int (*)(LibreOfficeKitDocument*)`) — confirmed
    /// INSTANCE-scoped at the vendored pin: `SfxLokHelper::createView(pDocument->mnDocumentId)`,
    /// keyed by THIS document's own id, never a process-global call. No `setView` prefix — nothing
    /// about minting a NEW view depends on which view is currently active; `doc_createView` reads
    /// `pDocument` directly. (It DOES, as an observed side effect, make the new view "current" —
    /// see `forceSetClipboardForCurrentView(pThis)` at the tail of `doc_createViewWithOptions` at
    /// the pin — but every OTHER current-view-dependent call in this bridge already asserts
    /// `setView` on entry, so that side effect is harmless by construction, never something this
    /// method needs to guard against or undo.)
    ///
    /// Refuses a SECOND mint for the same docId (`SaveError.agentViewAlreadyExists`) rather than
    /// silently returning the existing id — deliberate, per `OfficeWireFrame.createView`'s own
    /// header. The returned id is `createView()`'s OWN return value, verbatim — never re-derived
    /// via `getView()`, which becomes ambiguous the instant a second view exists (`doc_getView`'s
    /// `SfxLokHelper::getViewId(mnDocumentId)` is a DocId-filtered SCAN over every open view,
    /// order-dependent once more than one view shares a docId).
    private func createAgentViewOnDedicatedThread(docId: String) throws -> Int32 {
        guard var doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.agentViewId == nil else { throw SaveError.agentViewAlreadyExists(docId) }
        // Re-review fix (MISS 1) — the IDENTICAL `?? -1` hazard `ensureAgentViewOnDedicatedThread`
        // already fixed survived HERE, writing into the SAME `doc.agentViewId` cache, reachable
        // from the WIRE (this is `OfficeWireFrame.createView`'s own handler, compiled into Release
        // — not a debug/test-only path). A cached `-1` here would have been returned by
        // `ensureAgentViewOnDedicatedThread`'s own `if let existing` branch WITHOUT ever reaching
        // that function's guard, and `agentKeyEventOnDedicatedThread`'s own `!= nil` check (below)
        // would have let it straight through too — `setView(doc.handle, -1)` silently no-ops
        // (engine-verified: `SfxLokHelper::setView`, `sfx2/source/view/lokhelper.cxx:201-203`,
        // returns for an unresolved view id with no error), leaving whatever view was ALREADY
        // current — meaning a keystroke meant for the agent view would land on the PRIMARY view
        // instead: a silent EDIT, not merely a silent read, the moment this door's own caller
        // (the two-writer characterization path) posted one after a failed mint.
        guard let viewId = doc.handle.pointee.pClass.pointee.createView?(doc.handle), viewId >= 0 else {
            throw SaveError.agentViewCreationFailed(docId)
        }
        doc.agentViewId = viewId
        documents[docId] = doc
        return viewId
    }

    /// office-agent-tools T3 review (I1) — get-or-mint variant of `createAgentViewOnDedicatedThread`
    /// above, for `sheetsRead`'s own need: a read must never fail merely because SOMETHING ELSE (the
    /// two-writer `createAgentView` wire door, or an earlier read in this same document's lifetime)
    /// already minted the agent view — reusing the SAME view is exactly what a read wants (no reason
    /// to mint a THIRD view per document). The wire-level `createAgentView`'s own strict
    /// refusal-on-second-call (`SaveError.agentViewAlreadyExists`) is untouched by this — this is a
    /// separate, internal-only entry point `sheetsReadOnDedicatedThread` alone calls, never reachable
    /// from the wire.
    ///
    /// **Why reads need a second view at all**: Calc's selection, cursor, and part are PER-VIEW
    /// state (confirmed by this whole mechanism's own precedent — `agentKeyEventOnDedicatedThread`,
    /// right below, exists for the identical reason on the write side). `sheetsRead`'s own
    /// `.uno:GoToCell` + `getTextSelection` mechanism moves and reads a SELECTION — on the PRIMARY
    /// view, that is the user's own live selection on an adopted tab. Reading on the agent view
    /// instead makes that side effect moot by construction: nothing this bridge does to the agent
    /// view's own selection/part is ever visible to the user, so there is no residual to disclose
    /// and no restore to get right, unlike the two-round `setPart` restore dance this task's own
    /// earlier fix round needed before this change (see `sheetsReadOnDedicatedThread`'s own git
    /// history for that superseded design).
    private func ensureAgentViewOnDedicatedThread(docId: String) throws -> Int32 {
        guard var doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        // `>= 0`, not merely non-nil (re-review MISS 1) — defense in depth alongside the fix at
        // `createAgentViewOnDedicatedThread`'s own mint, below: with BOTH writers of `agentViewId`
        // now throwing rather than caching `-1`, this branch should never actually observe a
        // negative `existing` — but a consumer here that only checked `!= nil` is exactly the shape
        // that let a cached `-1` reach `setView` silently in the first place, so this read site
        // guards the same way rather than trusting its two writers to be its only protection.
        if let existing = doc.agentViewId, existing >= 0 { return existing }
        // Re-review fix (Minor #4) — a failed/absent `createView()` throws here, on THIS call,
        // rather than caching `-1` into `agentViewId` (which would silently short-circuit every
        // future call into returning that same unusable id — see `SaveError.agentViewCreationFailed`'s
        // own header for the full failure chain this closes). `doc.agentViewId` is left `nil` on
        // this path, so a LATER call for the same docId gets a fresh chance to mint a real view.
        guard let viewId = doc.handle.pointee.pClass.pointee.createView?(doc.handle), viewId >= 0 else {
            throw SaveError.agentViewCreationFailed(docId)
        }
        doc.agentViewId = viewId
        documents[docId] = doc
        return viewId
    }

    /// `postKeyEvent`, IDENTICAL shape to `postKeyOnDedicatedThread`, except the `setView` prefix
    /// targets `doc.agentViewId` (the second view) instead of `doc.viewId` (the primary one) — the
    /// only way to actually PRODUCE an edit "as" the agent view, needed to drive the two-writer
    /// characterization drill. Throws `SaveError.noAgentView` if `createAgentView` was never
    /// called for this docId — never silently falls back to the primary view.
    private func agentKeyEventOnDedicatedThread(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        // `>= 0`, not merely non-nil (re-review MISS 1) — the SEVERE half of that finding: a cached
        // `-1` here used to pass this guard (non-nil), then `setView(doc.handle, -1)` would
        // silently no-op (stay on whatever view is ALREADY current), and the keystroke below would
        // land THERE — on the user's own primary view, an actual silent EDIT, not merely a silent
        // read the way the sibling read-path hazards were.
        guard let agentViewId = doc.agentViewId, agentViewId >= 0 else { throw SaveError.noAgentView(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        doc.handle.pointee.pClass.pointee.postKeyEvent?(
            doc.handle, Int32(type.rawValue), Int32(truncatingIfNeeded: charCode), Int32(truncatingIfNeeded: keyCode))
    }

    // MARK: - office-agent-tools T3: sheets info/read

    /// All sheet-name lookups this bridge does (`sheetsInfo`'s own list, `sheetsRead`'s name-to-part
    /// resolution) go through this one helper, `setView` already asserted by the caller — `getParts`/
    /// `getPartName` are cheap, and duplicating the loop at each call site risked the two drifting
    /// (a name found here but not there, or vice versa, on the exact same document). Returns names in
    /// PART ORDER (index i's name is sheet i), never re-sorted — order is itself information (spec
    /// §2: "sheet names" is a list, and `sheetsInfoOk.sheets` promises the same order `info` reports
    /// as `sheets[i]`'s own part-scoped facts).
    private func sheetNamesOnDedicatedThread(_ doc: OpenDocument) -> [String] {
        let partCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
        var names: [String] = []
        names.reserveCapacity(partCount)
        for part in 0..<partCount {
            if let cName = doc.handle.pointee.pClass.pointee.getPartName?(doc.handle, Int32(part)) {
                defer { free(cName) }
                names.append(String(cString: cName))
            } else {
                names.append("Sheet\(part + 1)") // defensive fallback — getPartName should not fail for a real part index
            }
        }
        return names
    }

    /// Selects `range` on `part` (`.uno:GoToCell`'s own `ToPoint` argument — proven, live-tested
    /// single-cell targeting since Office Stage B Task 4's now-retired `debugEdit` door; this task's
    /// own live drills are what confirm it also accepts a two-corner span) and reads the selection
    /// back via `getTextSelection`, the SAME mechanism `clipboardCopyOnDedicatedThread` already uses
    /// and this codebase's own live tests already trust. `setPart` is the CALLER's job (both
    /// `sheetsInfoOnDedicatedThread`'s used-range probe and `sheetsReadOnDedicatedThread` itself need
    /// a specific part asserted first, and asserting it here a second time would be redundant, not
    /// wrong, but this keeps the "one assertion per dedicated-thread job" shape the rest of this file
    /// already has).
    ///
    /// **`formulas` selects Calc's own View > Show Formulas mode around the SAME read, toggled on
    /// immediately before and off immediately after.** **The command is `.uno:ToggleFormula`, NOT the
    /// more guessable `.uno:ShowFormula`** — this task's own first live drill against real content
    /// (`two-sheet.ods`, known cells) proved `.uno:ShowFormula` a silent no-op: no
    /// `LOK_CALLBACK_STATE_CHANGED` ever fired for it (every OTHER real toggle command in this LOK
    /// build's own callback trace does), and a formula read came back as the COMPUTED value ("2"),
    /// never the formula text ("=1+1"). The real name was found in the vendored product's own
    /// `Resources/registry/calc.xcd` (`grep -o 'uno:[A-Za-z]*Formula[A-Za-z]*'`), whose
    /// `.uno:ToggleFormula` entry carries the label "Show Formulas" — confirmed correct by the SAME
    /// live drill afterward, which then read back the seeded `=1+1` verbatim.
    ///
    /// A display-mode toggle, not a document mutation (the same category as zoom or a split-pane
    /// position), so it is not expected to touch `ModifiedStatus`; this task's own live drills assert
    /// that directly rather than trusting the category alone. Toggled unconditionally both ways
    /// (never queried first): a UNO toggle command flips whatever the CURRENT state is, so
    /// flip-read-flip returns to the original state regardless of what it was, without this bridge
    /// needing to ask what it started as.
    ///
    /// **Fix round 2 (live-drill-caught, ~25% of isolated reruns) — `.uno:GoToCell` is verified,
    /// not trusted blind.** `postUnoCommand` is fire-and-forget: it returns before LOK's own
    /// internal dispatcher has necessarily processed the command, and this task's own live drill
    /// (`testLiveSheetsReadValuesMatchesTwoSheetOdsKnownContent`) measured `getTextSelection`,
    /// called immediately after, sometimes still answering with whatever was selected BEFORE this
    /// call (a fresh document's default cursor at A1) rather than `range`'s real content.
    ///
    /// **Fix round 2a, FALSIFIED by its own follow-up drill — re-dispatching `.uno:GoToCell` in a
    /// tight loop does not help, and made the failure rate WORSE (5/5 isolated reruns, not the
    /// original ~25%).** The first attempt at this fix re-issued `.uno:GoToCell` on every retry
    /// iteration, reasoning that "each iteration re-enters LOK on the dedicated thread, giving its
    /// internal dispatcher the turns it needs to drain the deferred slot." The very next live drill
    /// falsified that reasoning directly: the stderr instrumentation showed the retry loop
    /// exhausting its full budget, THEN — after `selectionTextOnDedicatedThread` had already
    /// returned its (stale) answer — a burst of callbacks including the real "selection is now
    /// A1:B2" firing, triggered by an entirely different LOK call later in the same request
    /// (`sheetsReadOnDedicatedThread`'s own `setPart` restore, below). Repeated `getTextSelection`
    /// reads do not pump whatever internal queue `.uno:GoToCell` sits in; only some OTHER LOK call
    /// does, and re-dispatching `GoToCell` itself on every iteration is, if anything,
    /// counterproductive — each repeat is one more queued selection-move that can still land later,
    /// on the user's own sheet, after this function has moved on.
    ///
    /// **Fix round 2b (current) — dispatch `.uno:GoToCell` exactly ONCE, then poll
    /// `getTextSelection` with a cheap, throwaway `paintPartTile` call as the pump between reads.**
    /// `paintPartTile` was chosen over a second candidate (a `setPart` round-trip) on this task's
    /// own repo precedent — Office Stage B's live drills already establish "paint before other
    /// operations" as what settles LOK's view state — and because a real part switch would flicker
    /// an adopted tab's own visible sheet, which a read-only probe must not do. See
    /// `pumpDedicatedThreadForPendingDispatch` for the call itself and why it is not
    /// `paintTileOnDedicatedThread`.
    private func selectionTextOnDedicatedThread(_ doc: OpenDocument, docId: String, viewId: Int32, part: Int, range: String, formulas: Bool) -> String {
        // **Order is load-bearing: the formula toggle MUST run BEFORE `.uno:GoToCell`, not after —
        // live-drill-caught, not reasoned in advance.** The first working version of this function
        // toggled AFTER selecting (select the range, then flip Show Formulas, then read) and got the
        // COMPUTED VALUE back every time ("2" for a seeded "=1+1"), even once `.uno:ToggleFormula`
        // was confirmed the right command name (below) — `getTextSelection`'s own per-cell display
        // string is evidently computed AT SELECTION TIME, from whatever display mode was active
        // then, not recomputed at copy/read time from the mode active at that later moment. Toggling
        // first, so the selection itself is built under formula mode, is what actually works — this
        // task's own live drill (`OfficeSheetsCommandTests.testLiveSheetsReadFormulasReturnsFormula
        // TextNotTheComputedValue`) is the regression tripwire for this exact ordering.
        //
        // **Fix round 4 (review I5) — the restore is now GUARANTEED (`defer`, not a second plain
        // statement at the tail), matching the SAME "fire-and-forget is not trustworthy" lesson fix
        // round 2 already learned for `.uno:GoToCell` — this command rides the identical
        // `postUnoCommand` contract, so the same distrust applies to whether it DISPATCHES at all on
        // every exit path. `defer` is registered unconditionally on entry (Swift's own rule: a
        // `defer` inside `if formulas` would only run if that branch executed, but this one must
        // ALWAYS pair with the ON-toggle above, so the condition is checked again inside the
        // deferred block, not by conditioning the registration itself).
        //
        // **NOT independently VERIFIED that the restore has landed before this function returns —
        // but it IS pumped, which is a different and real property, not conflated with the first
        // any more.** A first attempt at this fix tried to verify landing the same way
        // `.uno:GoToCell` is verified (poll a flag set from a `LOK_CALLBACK_STATE_CHANGED` handler)
        // on the claim this command fires one synchronously. Falsified by this task's own
        // follow-up drill: a complete, unconditional raw-callback trace for a full
        // seed-then-read-formulas cycle never mentions `ToggleFormula` in ANY callback of ANY type
        // — see `toggleFormulaOnDedicatedThread`'s own header for the full account. No signal
        // exists to poll, so none is polled — VERIFICATION is genuinely unavailable. But a
        // re-review caught that the OFF-toggle, as first shipped after that finding, had NO PUMP
        // at all — meaning `postUnoCommand`'s own queued restore could sit unprocessed for an
        // UNBOUNDED interval, not the "brief flash" this comment used to claim, until some
        // unrelated LOK call happened to pump it (a save landing in that window would persist the
        // formula-display state into `settings.xml` — the exact harm this whole mechanism exists
        // to avoid). The `defer` below now passes `pump:` to `toggleFormulaOnDedicatedThread` for
        // the OFF-toggle specifically, reusing the SAME proven pump `.uno:GoToCell`'s own poll
        // trusts — real help for LANDING, still no way to PROVE it landed, and this comment no
        // longer says otherwise in either direction.
        //
        // **Disclosed, not fixed: this toggle is `rDoc`-scoped (document-wide View > Show Formulas),
        // not per-view — the agent view does NOT isolate it.** Unlike the selection/part isolation
        // `sheetsReadOnDedicatedThread`'s own agent-view switch provides, an adopted tab's user CAN
        // see a brief, real flash to formula display and back for the duration of one `formulas:
        // true` read — genuinely unavoidable with this mechanism (confirmed: `getCommandValues`'s
        // full dispatch table, read directly from the pinned source, has no read-only formula-text
        // query this bridge could use instead).
        if formulas {
            toggleFormulaOnDedicatedThread(doc)
        }
        defer {
            if formulas {
                toggleFormulaOnDedicatedThread(doc, pump: (viewId: viewId, part: part))
            }
        }

        // Baseline: whatever `getTextSelection` answers BEFORE this call ever asks LOK to move the
        // selection. This is the exact value a not-yet-processed `.uno:GoToCell` reads back as —
        // see the poll loop below, which exists to tell "GoToCell hasn't landed yet" apart from
        // "GoToCell landed, and the requested range's content happens to equal what was already
        // selected" (read under `formulas`' own display mode, matching every read below, so a
        // stale-vs-fresh comparison is never comparing across two different display modes).
        let baseline = readSelectionTextOnDedicatedThread(doc)

        let gotoPayload: [String: Any] = ["ToPoint": ["type": "string", "value": range]]
        if let gotoData = try? JSONSerialization.data(withJSONObject: gotoPayload),
           let gotoString = String(data: gotoData, encoding: .utf8) {
            ".uno:GoToCell".withCString { commandPtr in
                gotoString.withCString { argsPtr in
                    doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, argsPtr, false)
                }
            }
        }

        // **Poll-with-pump, never a sleep** — house norm (`CLAUDE.md`: "no arbitrary sleeps...
        // condition-poll instead"). `.uno:GoToCell` is dispatched exactly ONCE, above; every
        // iteration below only READS plus, on a still-stale read, PUMPS
        // (`pumpDedicatedThreadForPendingDispatch`) — never re-dispatches GoToCell itself, per fix
        // round 2a's own falsification. Bounded by ITERATION COUNT, never a clock. A callback-based
        // wait (blocking this job until `LOK_CALLBACK_STATE_CHANGED`/similar fires) is not available
        // here without risking the exact same-thread reentrant deadlock `LOKDedicatedThread`'s own
        // header warns against — `lokBridgeDocumentCallback` fires ON this thread, as part of
        // whatever job is already running.
        //
        // **Exhaustion returns the last read rather than throwing.** When `range`'s real content
        // genuinely EQUALS `baseline` — a freshly-opened document's default A1 selection, probed
        // for a sheet whose only content IS at A1 (`sparse-sheets.ods`'s own Sheet1 fixture, added
        // for `sheetsInfo`'s `(0, 0)` disambiguation fallback, is exactly this case for `read` too;
        // so is every genuinely EMPTY sheet, which legitimately reads `""` both before and after) —
        // "stale" and "correct" are indistinguishable by this detector's own construction, and
        // throwing here would wrongly fail a read that in fact succeeded. The undetectable residual
        // (GoToCell never actually lands within the attempt budget AND the requested range's real
        // content differs from `baseline`) is a disclosed tail — task-3-report.md's concerns, not a
        // claimed-solved case.
        //
        // **Round 4 — one unconditional pump added AFTER the loop, on the exhaustion path only.**
        // Stale prose corrected: the paragraph this replaces used to justify the pump-before-retry
        // pattern by "flushing a genuinely-still-pending GoToCell before the caller's own `setPart`
        // restore runs" — that restore no longer exists (`sheetsReadOnDedicatedThread` reads on the
        // agent view now, fix round 3/I1, and never restores anything on the primary), so that
        // justification was already stale before this round, independent of what follows. The REAL
        // reason to pump once more here, confirmed live: a round-3 full-app-suite run observed the
        // PRIMARY view's own selection move to this read's target range after this loop, on
        // UNMUTATED code, hit its full 4-attempt ceiling. The diagnostic two lines below cannot by
        // itself distinguish "landed on the final read" from genuine exhaustion in that round-3 run
        // — but genuine exhaustion of this exact loop WAS directly observed since: a round-4 mutant
        // drill (deliberately reading on `doc.viewId` instead of the agent view, to re-prove this
        // test discriminates) caught this loop returning the pre-dispatch baseline unchanged after
        // all 4 attempts, in 3 of its 4 total runs, via the read's own now-added content assertion — see
        // `OfficeSheetsCommandTests.testLiveAgentReadNeverTouchesThePrimaryViewsOwnSelection`'s own
        // header for the full evidence chain. `postUnoCommand`'s `SynchronMode=false` (confirmed
        // active in this build — unipoll is never enabled anywhere in this file) means a
        // still-queued `GoToCell` can drain at ANY later point, against whatever view a SUBSEQUENT,
        // unrelated LOK call on this thread makes current next — giving the dispatcher one more turn
        // here, before this function returns control to whatever runs next, shrinks that window. It
        // does NOT close it: this is the same fix-round-2a lesson (repeated `getTextSelection` reads
        // do not themselves pump LOK's internal queue; only some OTHER LOK call does) applied once
        // more, not a new mechanism — and it stays bounded and cheap, one more throwaway 64x64 tile
        // paint, spent only on the path that already burned its full read budget.
        var text = readSelectionTextOnDedicatedThread(doc)
        var attempts = 1
        while text == baseline && attempts < Self.goToCellVerificationAttempts {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: viewId, part: part)
            text = readSelectionTextOnDedicatedThread(doc)
            attempts += 1
        }
        if attempts > 1 {
            // Evidence line for task-3-report.md's before/after — how often the race actually
            // fires in practice, and which attempt it resolved on, never silent.
            FileHandle.standardError.write(Data(
                "[LOKBridge sheets] GoToCell(\(range)) needed \(attempts) attempt(s) before the selection changed (or the budget was exhausted)\n".utf8))
        }
        if text == baseline {
            // Best-effort straggler flush (round 4) — see the comment above the loop. Only spent on
            // the exhaustion path itself; a read that already succeeded needs no further pumping.
            pumpDedicatedThreadForPendingDispatch(doc, viewId: viewId, part: part)
        }

        // The formula-toggle restore (fix round 4, review I5) is registered as a `defer` above,
        // right after the ON-toggle — it runs here, guaranteed, on every exit from this function,
        // not repeated as a plain statement at this tail.
        return text
    }

    /// office-agent-tools T3 review (I5) — dispatches `.uno:ToggleFormula`. The name deliberately
    /// does NOT say "AndVerify" — an earlier version of this fix attempted exactly that
    /// (`OpenDocument.formulaToggleStateChangedSeen`, set from a `LOK_CALLBACK_STATE_CHANGED`
    /// handler, polled the same way `.uno:GoToCell`'s own race is verified), on the reviewer's own
    /// claim that this command fires `STATE_CHANGED` synchronously. **Falsified by this task's own
    /// follow-up drill, not merely unconfirmed**: the COMPLETE, unconditional raw-callback trace for
    /// a full seed-then-read-formulas cycle (every callback of every type this bridge receives,
    /// already logged unconditionally by `handleCallback` — 64 lines for one real test run) never
    /// once mentions `ToggleFormula`, in a `STATE_CHANGED` payload or any other callback type. This
    /// build's engine gives NO observable signal for this command's own completion — full stop, not
    /// "sometimes fires, sometimes doesn't" the way `.uno:GoToCell` does.
    ///
    /// Given no signal exists to poll, this does not poll. What it DOES still fix, correctly and
    /// independently of any signal: the caller wraps this in `defer` (`selectionTextOnDedicatedThread`
    /// above), so the OFF-toggle is GUARANTEED to dispatch on every exit from that function — a real,
    /// structural improvement over the original plain-statement-at-the-tail shape, which a future
    /// throwing call added between the ON-toggle and the tail could have skipped. "Guaranteed to
    /// dispatch" and "guaranteed to have landed by the time this returns" are different properties;
    /// only the first is achievable here, and this comment does not claim the second.
    ///
    /// **Re-review fix — pumped, not left in the async queue unpumped.** "Guarantees dispatch, not
    /// landing" (this function's own header, above) was correct about VERIFICATION being
    /// unavailable but, as originally shipped, conflated that with LANDING: with no pump at all
    /// after the OFF-toggle, `postUnoCommand`'s own queued command could sit unprocessed for an
    /// UNBOUNDED interval — not the "brief flash" this file's own caller-side comment
    /// (`selectionTextOnDedicatedThread`) claimed — until some UNRELATED LOK call happened to pump
    /// it. A save landing inside that window would persist `SetViewOptions`' formula-display state
    /// into `settings.xml`, the exact harm this whole fix exists to prevent. `pump`, when true,
    /// calls the SAME throwaway `paintPartTile` `.uno:GoToCell`'s own poll already trusts to give
    /// LOK's internal dispatcher a turn — proven to help LANDING (this file's own measured
    /// evidence), even though (unchanged from above) nothing here can PROVE it landed before
    /// returning. The ON-toggle does not need its own explicit pump: the poll loop immediately
    /// following it in `selectionTextOnDedicatedThread` already pumps multiple times as part of
    /// verifying `.uno:GoToCell`, which pumps this command's own landing for free; only the
    /// OFF-toggle, in that function's `defer`, has nothing after it to pump on its behalf.
    private func toggleFormulaOnDedicatedThread(_ doc: OpenDocument, pump: (viewId: Int32, part: Int)? = nil) {
        ".uno:ToggleFormula".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
        if let pump {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: pump.viewId, part: pump.part)
        }
    }

    /// The one place this bridge calls `getTextSelection` — `selectionTextOnDedicatedThread`'s
    /// baseline read and every poll-loop read share this so the two can never disagree about the
    /// MIME type or the empty-string fallback.
    private func readSelectionTextOnDedicatedThread(_ doc: OpenDocument) -> String {
        guard let cString = "text/plain;charset=utf-8".withCString({ mimePtr in
            doc.handle.pointee.pClass.pointee.getTextSelection?(doc.handle, mimePtr, nil)
        }) else {
            return ""
        }
        defer { free(cString) }
        return String(cString: cString)
    }

    /// A cheap, throwaway `paintPartTile` call whose ONLY purpose is to give LOK's own internal
    /// idle/dispatch queue a chance to drain a still-pending `.uno:GoToCell` — see
    /// `selectionTextOnDedicatedThread`'s own fix-round-2 history for the live evidence this exists
    /// to answer. Pixels are discarded immediately; nothing here is cached or returned to any
    /// caller — only the SIDE EFFECT of making the call matters.
    ///
    /// **Deliberately NOT `paintTileOnDedicatedThread`** — that method updates
    /// `OpenDocument.lastKnownPart` (autosave's own "what part is the user looking at" signal, see
    /// that field's own header) and this is a read probe, which must never perturb it. `part` is
    /// always the SAME part the caller already asserted via `setPart` before calling into
    /// `selectionTextOnDedicatedThread` in the first place — passed straight through rather than
    /// re-derived, so this call's own `nPart` argument always matches `doc_getPart(pThis)` already.
    /// That equality is what keeps this call out of `paintTileOnDedicatedThread`'s own documented
    /// `getAlternativeViewForPaint` hazard (fix round 3 there): that unfiltered bystander-view
    /// search only triggers on a part/mode MISMATCH, which passing the already-current part
    /// structurally avoids without needing that method's own type-gated `setPart` prefix here.
    ///
    /// **`viewId` fix (review I1) — no longer hardcodes `doc.viewId` (the primary view).**
    /// `sheetsReadOnDedicatedThread` now polls on the AGENT view, not the primary one (see
    /// `ensureAgentViewOnDedicatedThread`'s own header for why); a pump that unconditionally
    /// asserted the primary view would silently switch the process-global current view AWAY from
    /// the agent view mid-poll, on every retry — clobbering the very isolation the agent-view
    /// switch exists to provide, and reading the USER's own selection instead of the agent's from
    /// that point on. The caller always passes the SAME view it already asserted before dispatching
    /// `.uno:GoToCell` in the first place, so this is never a new assertion, only a repeated one.
    private func pumpDedicatedThreadForPendingDispatch(_ doc: OpenDocument, viewId: Int32, part: Int) {
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, viewId)
        var buffer = [UInt8](repeating: 0, count: Self.pumpTileByteCount)
        buffer.withUnsafeMutableBufferPointer { rawBuffer in
            doc.handle.pointee.pClass.pointee.paintPartTile?(
                doc.handle, rawBuffer.baseAddress, Int32(part), 0 /* LOK_PARTMODE_SLIDES */,
                Int32(Self.pumpTilePixelSize), Int32(Self.pumpTilePixelSize),
                0, 0, 3000, 3000)
        }
    }
    private static let pumpTilePixelSize = 64
    private static let pumpTileByteCount = 64 * 64 * 4

    /// `selectionTextOnDedicatedThread`'s own `.uno:GoToCell` poll budget — the ONE
    /// `postUnoCommand` this file still verifies via a poll loop (`.uno:ToggleFormula`'s own attempt
    /// at the identical pattern was tried and abandoned — see `toggleFormulaOnDedicatedThread`'s own
    /// header for why no signal exists for it to poll). Small deliberately, not generous:
    /// `sheetsInfoOnDedicatedThread`'s `(0, 0)` disambiguation fallback pays this cost for a
    /// genuinely empty sheet (`""` read equals `""` baseline, so the loop never sees a difference to
    /// stop early on and burns the full budget every time) — a large budget would make that fallback
    /// slow for no correctness benefit on exactly the sheets most likely to trigger it. Each attempt
    /// is a real, if cheap, LOK call (a 64x64 tile paint), not a clock tick, so this is a real cost
    /// per attempt, unlike a bounded wall-clock retry would be.
    private static let goToCellVerificationAttempts = 4
    /// office-agent-tools T4 — `sheetsManageSheetOnDedicatedThread`'s own verification budget. See
    /// that function's own header for why this is separate from, and larger than,
    /// `goToCellVerificationAttempts`: a structural sheet insert/delete/rename is a heavier
    /// operation than a cell selection move, live-measured to need more than 4 attempts at least
    /// once across this task's own repeated runs.
    private static let sheetsManageVerificationAttempts = 20
    /// office-agent-tools T6 — `slidesReorderOnDedicatedThread`'s own verification budget. A
    /// dedicated constant, not a reuse of `sheetsManageVerificationAttempts`, per that constant's
    /// own header: each structural-mutation call site earns its own independently-sized budget so
    /// raising one can never silently loosen another. Started at the same value (20) as its closest
    /// analogue (a structural, non-per-cell document mutation) since this call site has not yet
    /// earned its own independently-measured number across repeated live runs.
    private static let slidesManageVerificationAttempts = 20
    /// office-agent-tools T6 fix round 1 (review F-6) — `selectSlidePlaceholderOnDedicatedThread`'s
    /// OWN budget, and the first number in this block that is MEASURED rather than borrowed or
    /// reasoned. F-6 recommended raising it (it borrowed `goToCellVerificationAttempts = 4`, sized
    /// for a different call site, and its own comment conceded as much). Half of that is right — the
    /// call site should own its budget, so raising one can never silently loosen another — but the
    /// *raise* is empirically wrong, and the measurement that says so is worth more than the
    /// reasoning that suggested it.
    ///
    /// **Method**: set to 40 temporarily, added the permanent evidence line in
    /// `selectSlidePlaceholderOnDedicatedThread`, ran the full 11-test live suite twice under
    /// saturating CPU load (one spin loop per core) to provoke the deferred-dispatch class on
    /// purpose. Result, and it is bimodal with nothing in between:
    ///
    ///     313  needed 2 attempt(s), landed=true      <- every logged success
    ///      15  needed 40 attempt(s), landed=false    <- every non-landing
    ///
    /// **Zero occurrences at attempts 3 through 39.** No success has ever needed more than 2 (and
    /// attempt-1 successes go unlogged, so the real consumption is lower still); no non-landing was
    /// ever rescued by attempts 5..40. All 15 non-landings trace, via the evidence line's own
    /// slide/tab fields, to the three genuinely placeholder-less slides the F-0 and F-4 drills exist
    /// to exercise — legitimate structural absences, correctly reported, on tests that passed.
    ///
    /// So 4 already carries 2x headroom over every success ever observed, and a larger number would
    /// only make every LEGITIMATE refusal ~10x slower. The residual flake this was hoped to cure is
    /// therefore NOT "the callback needed more time" — a discrete loss, not a slow arrival. What can
    /// help is re-posting the key events, never pumping harder: see `slidesSetTextOnDedicatedThread`'s
    /// pass-2 retry, which is the fix that measurement actually pointed at.
    private static let slidePlaceholderPositionAttempts = 4

    /// Splits `getTextSelection`'s own TSV shape (rows joined by `"\n"`, cells within a row joined by
    /// `"\t"`) into a grid — the ONE place both `sheetsInfo` and `sheetsRead` turn that raw string into
    /// `[[String]]`, so the two can never disagree about the shape. A wholly-empty selection answers
    /// `""`, which `.split` on an empty string with `omittingEmptySubsequences: false` would otherwise
    /// turn into ONE spurious empty row — guarded explicitly rather than trusted to fall out of the
    /// split, since a genuinely single BLANK cell ("\t"-free, content-free) must still come back as
    /// `[[""]]`, not `[]`. A trailing `"\n"` (there almost always is one — LOK's own convention for a
    /// Calc selection copy) would otherwise produce one spurious wholly-empty trailing row; every
    /// OTHER embedded newline is a real row boundary and must survive.
    ///
    /// **office-agent-tools T3 review (I3) — characterized live before touching this function, not
    /// assumed.** A purpose-built fixture (`embedded-delimiters.ods`, a cell with a real
    /// `<text:tab/>` and a second `<text:p>` paragraph — ODF's own in-cell tab and line-break
    /// shapes) dumped through the real `getTextSelection` mechanism read back as
    /// `"lineone\u{01}tabbed linetwo\tNEXTCELL"` for a two-cell selection. Two findings, neither
    /// the one the review's own framing assumed:
    ///
    /// 1. **The splitting above was never actually corrupted.** Calc's own plain-text clipboard
    ///    export substitutes an EMBEDDED tab with U+0001 (Start of Heading) — never the real
    ///    U+0009 this function splits on — specifically so an in-cell tab can never be confused
    ///    with the real cell-boundary delimiter. Splitting on literal `"\t"`/`"\n"` above is safe
    ///    exactly because Calc itself keeps those bytes reserved for real boundaries.
    /// 2. **An embedded line break (`<text:p>` count > 1) is LOSSY, not corrupting**: it copies
    ///    through as a plain SPACE, not U+000A and not any other distinguishable marker — genuinely
    ///    indistinguishable, after the fact, from a space the user actually typed. Nothing this
    ///    function does can recover that distinction; disclosed in `task-3-report.md`'s concerns,
    ///    not silently accepted as "handled."
    ///
    /// U+0001 is substituted back to a real tab HERE, in each cell's own value — not left as an
    /// opaque control character an agent would have no way to interpret. Safe to do AFTER
    /// splitting, never before: by finding (1) above, only a genuine cell boundary is ever a real
    /// U+0009 at the point this function's own `.components(separatedBy: "\t")` runs, so this later
    /// substitution can never retroactively misinterpret a real delimiter as this fix's own target.
    /// The wire-level RE-ambiguity this reintroduces (a cell's OWN value now containing a real tab,
    /// same as `formatSheetsRead`'s own join separator) is closed one layer up, at the point that
    /// join actually happens — see `OfficeCommandConsumer.formatSheetsRead`'s own quoting.
    ///
    /// **A separate, confirmed-live limitation this function inherits rather than causes: LEADING
    /// empty rows/columns trim away exactly like trailing ones do** (`offset-content.ods`'s own
    /// live drill — real content only at B2, `A1:C3` returns bare content with no leading blank row
    /// or column at all). Disclosed in the tool's own description (`sheets.ts`) rather than padded
    /// back to the requested rectangle's shape: correct padding would require knowing exactly how
    /// many leading rows/columns were trimmed, and `getDataArea` (`sheetsInfoOnDedicatedThread`'s
    /// own mechanism) only ever answers the LAST used row/column — `ScTable::GetCellArea` has no
    /// `nMinX`/`nMinY` counterpart (checked directly against the pinned source) — so there is no
    /// cheap way to recover the trimmed leading extent from information this bridge already has.
    private func parseTSVGrid(_ text: String) -> [[String]] {
        guard !text.isEmpty else { return [] }
        let trimmed = text.hasSuffix("\n") ? String(text.dropLast()) : text
        return trimmed.components(separatedBy: "\n").map { row in
            row.components(separatedBy: "\t").map { cell in
                cell.replacingOccurrences(of: "\u{01}", with: "\t")
            }
        }
    }

    /// office-agent-tools T3 — sheet names, each one's used range, and the active sheet's name.
    /// Genuinely read-only, not just read-only in intent: no view but the PRIMARY one is touched
    /// (`getDataArea` needs a current view resolved — see below — but never a selection move or a
    /// part switch), so there is nothing here to restore.
    ///
    /// **Fix round 3 (review C1/C2) — `getDataArea` IS the used-range probe after all, now that the
    /// header ABI bug is fixed.** This function's own PREVIOUS design replaced `getDataArea` with a
    /// large-bound-range `getTextSelection` probe, reasoning that live drills had "measured
    /// `getDataArea` wrong" (`(0,0)`/"A1:A1" for a sheet proven to have real content through B2).
    /// The true root cause, found by this review: `getDataArea`'s header slot was silently reading
    /// `getEditMode` instead (see `LOKBridge.swift`'s own `nSize` tripwire, and
    /// `LibreOfficeKit.h`'s three phantom-member removals) — the function was never actually called
    /// at all. With the ABI fixed, `getDataArea` is the CORRECT probe: it reads `ScTable::
    /// GetCellArea` off the document MODEL directly (`sc/source/ui/unoobj/docuno.cxx`'s
    /// `ScModelObj::getDataArea`, confirmed by reading the pinned source), taking `nPart` as a
    /// direct argument — no `setPart`, no selection, no `.uno:GoToCell`, no poll-and-pump, and (per
    /// this fix) no per-sheet part-restore dance either.
    ///
    /// **One view call IS still required, and this review's own first-pass guidance
    /// ("no view at all") undersold it** — checked against the pinned source, not assumed:
    /// `ScModelObj::getDataArea` resolves via `ScDocShell::GetViewData()`, the SAME static,
    /// process-global-current-view accessor `setPart`/`getPart` use (`OpenDocument.viewId`'s own
    /// header has the full citation chain) — this codebase already independently confirmed the
    /// identical hazard for `getDocumentSize` (`openOnDedicatedThread`'s own fix-round-3 comment).
    /// A wrong or absent current view does not throw here — `ScModelObj::getDataArea` silently
    /// returns its own default `Size(1, 1)` — so `setView(doc.viewId)` once at the top, before the
    /// per-sheet loop, is required for correctness, just not per-sheet the way `setPart` used to be.
    ///
    /// **The `(0, 0)` ambiguity is real, confirmed by reading `ScTable::GetCellArea`
    /// (`sc/source/core/data/table1.cxx`) directly — not resolved by the ABI fix, and not
    /// resolvable from the C API alone.** `GetCellArea` computes a real `bool bFound` (true content
    /// existed) alongside `rEndCol`/`rEndRow`, but `ScModelObj::getDataArea` calls it and DISCARDS
    /// the returned bool entirely — `(0, 0)` is what BOTH a genuinely empty sheet AND a sheet with
    /// content confined to cell A1 alone report, indistinguishably, at the LOK C API layer. Resolved
    /// here with a narrow, disclosed exception: ONLY when `getDataArea` answers `(0, 0)` does this
    /// function fall back to a single-cell content check on A1 (`sheetHasA1ContentOnDedicatedThread`,
    /// below) to decide between the empty-sheet sentinel (`-1, -1`) and "content confined to A1"
    /// (`0, 0`, i.e. `A1:A1`) — on the AGENT view, never the primary one, so even this narrow
    /// fallback never touches the user's own selection. Every OTHER sheet (the overwhelming common
    /// case) never pays this cost at all.
    private func sheetsInfoOnDedicatedThread(docId: String) throws -> (sheets: [OfficeSheetInfo], activeSheet: String) {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let names = sheetNamesOnDedicatedThread(doc)
        let activeIndex = Int(doc.handle.pointee.pClass.pointee.getPart?(doc.handle) ?? 0)
        let activeSheet = (activeIndex >= 0 && activeIndex < names.count) ? names[activeIndex] : (names.first ?? "")

        var sheets: [OfficeSheetInfo] = []
        sheets.reserveCapacity(names.count)
        for (part, name) in names.enumerated() {
            var lastCol: Int = 0
            var lastRow: Int = 0
            doc.handle.pointee.pClass.pointee.getDataArea?(doc.handle, part, &lastCol, &lastRow)
            if lastCol == 0 && lastRow == 0 {
                let hasA1Content = try sheetHasA1ContentOnDedicatedThread(docId: docId, part: part)
                sheets.append(OfficeSheetInfo(name: name,
                                               usedEndColumn: hasA1Content ? 0 : -1,
                                               usedEndRow: hasA1Content ? 0 : -1))
            } else {
                sheets.append(OfficeSheetInfo(name: name, usedEndColumn: lastCol, usedEndRow: lastRow))
            }
        }
        return (sheets, activeSheet)
    }

    /// The narrow `(0, 0)` disambiguation `sheetsInfoOnDedicatedThread` falls back to — see that
    /// function's own header for why it is needed and why it is rare. Reuses
    /// `selectionTextOnDedicatedThread` (the SAME proven, pump-and-poll-verified mechanism `read`
    /// uses) on the AGENT view, so this never touches the primary view's own selection even in this
    /// fallback path.
    private func sheetHasA1ContentOnDedicatedThread(docId: String, part: Int) throws -> Bool {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(part))
        let text = selectionTextOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part, range: "A1", formulas: false)
        return !text.isEmpty
    }

    /// office-agent-tools T3 — a value or formula grid over one already-validated, already-formatted
    /// A1 `range` on ONE named sheet. `sheet` is resolved to a part index HERE (never by the caller —
    /// see `OfficeWireFrame.sheetsRead`'s own header for why this MUST live helper-side), refusing
    /// with the workbook's real sheet list on no match.
    ///
    /// **Fix round 3 (review I1) — reads on the AGENT view, not the primary one.** The previous
    /// design read on `doc.viewId` (the user's own primary view) and restored `setPart` afterward
    /// to undo the sheet switch — necessary because Calc's part is per-view state, but leaving a
    /// residual this review named directly: `.uno:GoToCell`'s own SELECTION move on the primary
    /// view was never restorable (no mechanism existed to recall the prior selection), disclosed
    /// as an open concern in `task-3-report.md`. Reading on the agent view instead — minted or
    /// reused via `ensureAgentViewOnDedicatedThread` — removes the DELIBERATE version of this
    /// residual: this function itself never asserts the primary view or moves its selection.
    ///
    /// **NOT fully moot — narrowed, not eliminated (round 4, live-observed).** An earlier version of
    /// this comment claimed reading on the agent view made "the whole class of residual moot." A
    /// round-3 full-app-suite run falsified that directly:
    /// `OfficeSheetsCommandTests.testLiveAgentReadNeverTouchesThePrimaryViewsOwnSelection` observed
    /// the PRIMARY view's own selection move to this read's target range, following a read where
    /// the actual cell move (the `.uno:GoToCell` dispatch onward, inside
    /// `selectionTextOnDedicatedThread`) ran entirely through the agent view. This function's own
    /// sole `doc.viewId` reference is the `setView` at the top of this function's body, asserting
    /// the PRIMARY view before sheet-name resolution — legitimate, unrelated to the read itself,
    /// and overwritten by the agent-view `setView` just below it, before anything that could move a
    /// selection runs. See that test's own header for the full evidence chain,
    /// including a raw LOK callback trace, a round-4 mutant drill that directly observed this same
    /// loop exhaust on a DIFFERENT view (see `selectionTextOnDedicatedThread`'s own header), and a
    /// reading of the pinned engine
    /// source (`desktop/source/lib/init.cxx`'s `doc_postUnoCommand`): `SynchronMode=false` is
    /// confirmed active in this build (unipoll is never enabled anywhere in this file), so
    /// `.uno:GoToCell` genuinely executes asynchronously relative to `postUnoCommand`'s own return;
    /// the generic dispatch fallback that handles `GoToCell` (`comphelper::dispatchCommand`) does
    /// not thread the specific `pViewShell` that function resolves through an explicit parameter —
    /// its own view/frame targeting is resolved by separate machinery not directly verified here.
    /// `selectionTextOnDedicatedThread`'s own poll loop mitigates by giving LOK's internal
    /// dispatcher repeated turns before returning, and now pumps once more on exhaustion
    /// specifically (see that function's own header) — but this remains a best-effort mitigation of
    /// an async race, not a closed one: a genuinely still-queued `GoToCell` can still land later,
    /// against whatever view a SUBSEQUENT, unrelated LOK call on this thread makes current next.
    /// Disclosed, not solved — see task-3-report.md.
    private func sheetsReadOnDedicatedThread(docId: String, sheet: String, range: String, formulas: Bool) throws -> [[String]] {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let names = sheetNamesOnDedicatedThread(doc)
        guard let part = names.firstIndex(of: sheet) else {
            throw SaveError.sheetNotFound(docId: docId, sheet: sheet, available: names)
        }

        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(part))

        let text = selectionTextOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part, range: range, formulas: formulas)
        return parseTSVGrid(text)
    }

    // MARK: - office-agent-tools T4: sheets write verbs

    /// office-agent-tools T4 fix-round review (Important #3) — `getCommandValues(".uno:CellCursor")`,
    /// a synchronous QUERY against the document's own current model state, not a callback. Confirmed
    /// live (`OfficeHelperLiveTests.testProbeInvestigatesWhetherCellAddressCallbacksCanAttribute
    /// AgentViewPositioningSafely`) to report the CURRENT view's real `(column, row)` on demand —
    /// this is the mechanism that closes the reviewer's own "GoToCell straggler on writes" finding,
    /// after the SAME probe first ruled out the more obvious candidate: `LOK_CALLBACK_CELL_ADDRESS`
    /// (raw type 34) and `LOK_CALLBACK_CELL_CURSOR` (raw type 17) NEVER fire for a
    /// `.uno:GoToCell`-driven move at all, on the agent view or (by the same probe's own primary-view
    /// UNO-command evidence) plausibly any view — only REAL `postMouse`/`postKey` input events
    /// produce them. A callback-cache design was therefore never viable here regardless of its own
    /// staleness/attribution properties, which the probe also characterized for the record (see the
    /// probe's own header and task-4-fix-round-report.md).
    ///
    /// **Why a query is the STRONGER guarantee, not merely a working substitute**: called from
    /// WITHIN the same dedicated-thread closure that just dispatched the position (this file's own
    /// job model — one Swift closure runs to completion before the next one starts; nothing else can
    /// interleave mid-closure), this read is immune to the "a stale, still-draining async callback
    /// surfaces during a LATER, unrelated job's own pump calls" hazard class `.uno:GoToCell`'s own
    /// straggler documentation already covers at length — a cached PUSHED value could never make
    /// that same guarantee.
    ///
    /// Reuses `OfficeDocumentEvent.parseCellCursor` VERBATIM (`OfficeWire`, already imported by this
    /// file for the real `LOK_CALLBACK_CELL_CURSOR` callback path below) — `getCommandValues`'s own
    /// `commandValues` field is the IDENTICAL comma-separated six-field shape
    /// (`"x, y, width, height, col, row"`) the raw callback payload already has, one JSON envelope
    /// deeper (`{"commandName": ".uno:CellCursor", "commandValues": "…"}`, confirmed live).
    private func cellCursorOnDedicatedThread(_ doc: OpenDocument) -> OfficeCellCursor? {
        guard let cString = ".uno:CellCursor".withCString({ commandPtr in
            doc.handle.pointee.pClass.pointee.getCommandValues?(doc.handle, commandPtr)
        }) else { return nil }
        defer { free(cString) }
        guard let data = String(cString: cString).data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let commandValues = object["commandValues"] as? String,
              case .cellCursor(let cursor)? = OfficeDocumentEvent.parseCellCursor(commandValues) else {
            return nil
        }
        return cursor
    }

    /// Fix-round review item 1 (resize-verb positioning) — factored out of
    /// `writeOneCellOnDedicatedThread`'s own original inline block so both that function and
    /// `sheetsResizeOnDedicatedThread`'s anchor check below share ONE verification path rather than
    /// two independently-written copies of the same column/row comparison (a maintenance/drift risk
    /// a shared helper removes by construction). Positions via the proven single-cell
    /// `.uno:GoToCell` mechanism every write verb in this file already uses — `cellCursorOnDedicatedThread`'s
    /// own header has the full "why a synchronous query, not a callback" story and the live probe
    /// that ruled out the callback alternative — then confirms the agent view's cursor actually
    /// reached `address` BEFORE the caller does anything that depends on that position. Throws
    /// `positionVerificationFailed` on any mismatch, including an unparseable `address` itself
    /// (`landedAt: nil` — the cursor was never even queried, since there is nothing to compare
    /// against); never returns a partial or best-guess result.
    private func positionAndVerifyOnDedicatedThread(_ doc: OpenDocument, docId: String, viewId: Int32, part: Int,
                                                     address: String,
                                                     context: SaveError.PositionVerificationContext) throws {
        guard let target = Self.parseSingleCellReference(address) else {
            throw SaveError.positionVerificationFailed(docId: docId, address: address, landedAt: nil, context: context)
        }
        _ = selectionTextOnDedicatedThread(doc, docId: docId, viewId: viewId, part: part, range: address, formulas: false)
        try verifyCellCursorOnDedicatedThread(doc, docId: docId, expectedAddress: address, target: target, context: context)
    }

    /// The comparison half of `positionAndVerifyOnDedicatedThread`, split out so
    /// `sheetsResizeOnDedicatedThread` can re-check a position established by an EARLIER `GoToCell`
    /// (its own span selection) against an already-computed `target`, without issuing a second,
    /// redundant `GoToCell` to the same effective anchor. Throws `positionVerificationFailed` on any
    /// mismatch, `landedAt` carrying the best available description of where the cursor actually was
    /// (`nil` only when the query itself returned nothing usable).
    private func verifyCellCursorOnDedicatedThread(_ doc: OpenDocument, docId: String, expectedAddress: String,
                                                    target: (column: Int, row: Int),
                                                    context: SaveError.PositionVerificationContext) throws {
        let landed = cellCursorOnDedicatedThread(doc)
        let landedColumnRow: (column: Int, row: Int)?
        if case .at(_, let column, let row)? = landed { landedColumnRow = (column, row) } else { landedColumnRow = nil }
        guard let landedColumnRow, landedColumnRow.column == target.column, landedColumnRow.row == target.row else {
            let landedDescription = landedColumnRow.map { Self.formatCellReference(column: $0.column, row: $0.row) }
            throw SaveError.positionVerificationFailed(docId: docId, address: expectedAddress,
                                                        landedAt: landedDescription, context: context)
        }
    }

    /// office-agent-tools T4 — writes each `(cellAddresses[i], cellValues[i])` pair, in order, on the
    /// AGENT view (same isolation reasoning `sheetsReadOnDedicatedThread`'s own I1 fix established:
    /// nothing this does is ever visible to a human's own primary-view selection).
    ///
    /// **The mechanism is real synthetic TEXT ENTRY, not a paste — a deliberate choice, not the
    /// first one tried.** `clipboardPasteOnDedicatedThread`'s own `paste()` door was the obvious
    /// first candidate (`set`'s own name mirrors `read`'s single-range shape) but was set aside
    /// BEFORE being built, on evidence already on hand rather than a fresh live drill: this task's
    /// own advisor review named three concrete, unverified paste risks (does a TSV blob reliably
    /// FILL a multi-cell block on the agent view specifically; does a pasted `=1+1` reliably become
    /// a FORMULA rather than literal text, since clipboard import and cell-edit-mode text entry are
    /// documented as different Calc code paths; does pasting OVER a non-empty cell raise a headless
    /// overwrite-confirmation dialog — a modal on the dedicated thread is a HANG, not a failure, the
    /// one risk this bridge cannot afford to discover live). Character-by-character, per-cell
    /// GoToCell-then-type sidesteps all three by construction: (1) each cell is targeted
    /// individually, so there is no multi-cell fill behavior to depend on; (2) typing IS the
    /// mechanism `typeFormulaOnePlusOne`'s own live-tested precedent already proves produces a real
    /// formula from a leading `=` — no second, unverified code path; (3) typing into a cell and
    /// pressing Return never raises Calc's paste-specific overwrite dialog (confirmed by this
    /// mechanism's own live drills — see task-4-report.md). The cost is real (`sheetsSetMaxCells`,
    /// `sheets.ts`'s own cap, is far smaller than `read`'s 2,000-cell ceiling BECAUSE each cell here
    /// pays for a real per-cell LOK round trip, not a bulk probe) — accepted deliberately, in
    /// exchange for composing entirely out of ALREADY-PROVEN primitives rather than a fourth,
    /// untested LOK code path.
    private func sheetsSetOnDedicatedThread(docId: String, sheet: String, range: String,
                                            cellAddresses: [String], cellValues: [String]) throws -> Int {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let names = sheetNamesOnDedicatedThread(doc)
        guard let part = names.firstIndex(of: sheet) else {
            throw SaveError.sheetNotFound(docId: docId, sheet: sheet, available: names)
        }

        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(part))

        // Second fix-round review (Important #2 + Minor 3) — every per-cell failure
        // (`unsupportedFormulaCharacter`/`positionVerificationFailed`/`writeVerificationFailed`, not
        // only the formula one Minor 3 named specifically) is per-cell TRUE when it says "nothing was
        // written"/"outcome unchanged" — that is still about the ONE cell it names. It is CALL-level
        // FALSE the moment an earlier cell in this SAME `set` call already landed: something WAS
        // written, just not to this cell. Wrapped here, once `index > 0`, into `.partialSetFailure` —
        // a fully composed sentence naming the failing cell's position in the call, how many earlier
        // cells already applied, and an explicit note disambiguating what the wrapped per-cell
        // description's own "nothing"/"unchanged" wording actually scopes to. `index == 0` (the very
        // first cell) needs no wrapping — per-cell and call-level truth coincide when there is no
        // earlier cell to misdescribe.
        for (index, (address, value)) in zip(cellAddresses, cellValues).enumerated() {
            do {
                try writeOneCellOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part,
                                                  address: address, text: value)
            } catch let error as SaveError where index > 0 {
                throw SaveError.partialSetFailure(reason:
                    "cell \(address) (\(index + 1) of \(cellAddresses.count) in this set call) failed: "
                    + "\(error.description) Note: \(index) earlier cell\(index == 1 ? "" : "s") in "
                    + "this SAME call already applied before this failure — this call is not atomic, "
                    + "and \"nothing was written\"/\"unchanged\" above describes \(address) alone, not "
                    + "the whole call.")
            }
        }
        return cellAddresses.count
    }

    /// **Positions on `address`, VERIFIES the cursor actually landed there, types `text`, commits,
    /// then re-verifies content — all on the agent view, all within ONE call.** Positioning reuses
    /// `selectionTextOnDedicatedThread` VERBATIM (called twice: once to position before typing, once
    /// again after, to verify content) — this is "read Task 3's agent-view work and use the SAME
    /// mechanism" applied literally, including its own disclosed residual: a `.uno:GoToCell` that
    /// never lands within `goToCellVerificationAttempts` is not re-derived or newly solved here, it
    /// is INHERITED (see that function's own header, and task-3-report.md §6/§9/§10).
    ///
    /// **Fix-round review (Important #3) — positioning is now VERIFIED, not merely attempted, before
    /// any keystroke is posted.** The ORIGINAL version of this function trusted
    /// `selectionTextOnDedicatedThread`'s own best-effort GoToCell dance and moved straight to
    /// typing; the reviewer's own finding was that on a NON-EMPTY bystander cell, a GoToCell that
    /// never actually landed would leave the cursor on the WRONG cell, which already has content —
    /// this function would then type INTO that bystander cell, and the post-write content check
    /// below (still present, still lenient) reads NON-EMPTY and passes, because it only ever asks
    /// "does the target have content now," never "IS this actually the target." The broker then
    /// SAVES a real, silent clobber. Closed via `cellCursorOnDedicatedThread` (`getCommandValues
    /// (".uno:CellCursor")`, that function's own header has the full mechanism and the live probe
    /// that ruled out the callback-based alternative first): a `(column, row)` mismatch against
    /// `address` throws `SaveError.positionVerificationFailed` BEFORE typing, converting the
    /// straggler from a silent-clobber risk into an honest refusal.
    ///
    /// **Two typing mechanisms, not one — a real, live falsification, not a design preference.**
    /// The first version of this function used `postWindowExtTextInputEvent` (`.input` then `.end`)
    /// UNCONDITIONALLY, on the reasoning that it already delivers a whole string in one call and is
    /// already live-tested for committing arbitrary text
    /// (`OfficeRuntimeLiveTests.testExtTextInputMarksCommitsAndCancelsAgainstRealLOKThroughSave
    /// AndReopen`, a text-document test). Live-tested against Calc specifically, that reasoning
    /// FALSIFIED itself in one direction and CONFIRMED itself in another: a plain value (`"42"`,
    /// `"hello world"`) and an apostrophe-forced literal (`"'=NOT A REAL FORMULA"` — the apostrophe
    /// is honored, stripped, and the rest stored as text) both land correctly via ext-text-input; a
    /// genuine formula (`"=SUM(D1:D1)"`, no apostrophe) does NOT — it lands as the LITERAL STRING
    /// `"=SUM(D1:D1)"` in a text cell, never entering Calc's formula-edit mode at all (confirmed
    /// directly against the saved OOXML: `t="s"`, a shared-string reference, never a real `<f>`
    /// element). Evidently Calc's ext-text-input path honors a leading apostrophe's "force text"
    /// meaning but does not run the SAME leading-`=`-triggers-formula-mode transition a real KEY
    /// PRESS does — the two "first character is special" rules live in different code, and only one
    /// of them is wired to this input door.
    ///
    /// **The fix: a text starting with an UNESCAPED `=` is typed CHARACTER BY CHARACTER via real
    /// `postKeyEvent` calls instead** — the exact mechanism `typeFormulaOnePlusOne`
    /// (`OfficeSheetsCommandTests.swift`) and `OfficeRuntimeLiveTests.postRealEdit` already prove
    /// produces a genuine formula, extended from their own small, closed test-marker alphabets to
    /// `formulaKeyEvent(for:)`'s wider table (below) — every character a realistic formula needs:
    /// digits, letters (case-preserving), and the operator/reference punctuation Calc formulas use.
    /// Every OTHER cell — plain values, and the apostrophe-escaped case specifically — keeps using
    /// ext-text-input, proven correct for both by this same live drill.
    ///
    /// **Typed characters commit with a trailing Return either way** — `com.sun.star.awt.Key.RETURN`
    /// (1280), the SAME raw keyCode both proven precedents already use to commit a pending Calc cell
    /// edit. For the ext-text-input path this is kept EXPLICIT rather than trusted to `.end` alone —
    /// Calc's own cell-edit-mode commit semantics for ext-text-input specifically were unverified
    /// going in; a redundant Return after an already-committed edit is harmless (it only moves the
    /// cursor, which this function re-positions past anyway).
    ///
    /// **Post-write content verification is deliberately LENIENT — "landed something," not "landed
    /// byte-identical."** A written NUMBER can read back reformatted (`"3.0"` typed, `"3"` read), and
    /// a written FORMULA reads back as its COMPUTED value in values mode, never the formula text —
    /// neither is a bug, so an exact-match check would false-fail both. What this DOES catch,
    /// honestly: the dangerous silent-failure shape — a non-empty `text` whose target cell reads
    /// back EMPTY, meaning the commit never landed. (Positioning itself is no longer this check's
    /// job — see the position-verification fix above, which runs BEFORE typing and is strict, not
    /// lenient, on purpose: content-leniency and position-strictness answer different questions.) A
    /// genuinely empty `text` (the caller explicitly asked to write nothing there) is never content-
    /// verified — there is nothing to distinguish "the write of nothing worked" from "the write of
    /// nothing didn't happen," the identical baseline-ambiguity `selectionTextOnDedicatedThread`'s
    /// own header already names for reads.
    private func writeOneCellOnDedicatedThread(_ doc: OpenDocument, docId: String, viewId: Int32, part: Int,
                                               address: String, text: String) throws {
        // Fix-round review (Important #2) — pre-validate EVERY formula character in a pure pass,
        // BEFORE the first keystroke of the real attempt. The ORIGINAL code called
        // `formulaKeyEvent(for:)` INSIDE the typing loop itself, so an unmapped character partway
        // through a formula threw `.writeVerificationFailed` AFTER already posting every character
        // before it — a mislabel (nothing was "verified," something was left HALF-TYPED) for a real,
        // uncommitted, PARTIAL formula stranded in Calc's own edit mode on a document a human may
        // have open. Once this loop starts below, it cannot throw — every character is known before
        // ANY keystroke is posted, or none are (`.unsupportedFormulaCharacter`, thrown here, before
        // touching the document at all).
        var formulaKeyEvents: [(charCode: Int, keyCode: Int)] = []
        if text.hasPrefix("=") {
            formulaKeyEvents = try text.map { try Self.formulaKeyEvent(for: $0, docId: docId, address: address) }
        }

        // Fix-round review (Important #3) — position, then VERIFY the agent view's cursor actually
        // reached `address` before typing anything. See this function's own header above for the
        // full "why," and `cellCursorOnDedicatedThread`'s own header for the mechanism and the live
        // probe that ruled out the callback-based alternative first. `positionAndVerifyOnDedicatedThread`
        // is this exact check, factored out so `sheetsResizeOnDedicatedThread`'s own anchor
        // verification (fix-round review item 1) shares it rather than re-deriving it.
        try positionAndVerifyOnDedicatedThread(doc, docId: docId, viewId: viewId, part: part, address: address,
                                               context: .typing)

        if text.hasPrefix("=") {
            for (charCode, keyCode) in formulaKeyEvents {
                doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), Int32(charCode), Int32(keyCode))
                doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), Int32(charCode), Int32(keyCode))
            }
        } else {
            text.withCString { textPtr in
                doc.handle.pointee.pClass.pointee.postWindowExtTextInputEvent?(
                    doc.handle, 0, Int32(OfficeExtTextInputType.input.rawValue), textPtr)
            }
            "".withCString { emptyPtr in
                doc.handle.pointee.pClass.pointee.postWindowExtTextInputEvent?(
                    doc.handle, 0, Int32(OfficeExtTextInputType.end.rawValue), emptyPtr)
            }
        }
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, 1280)
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, 1280)

        guard !text.isEmpty else { return }
        // Second fix-round review, Minor 4 — this re-read used to call `selectionTextOnDedicatedThread`
        // directly, which does its OWN internal `GoToCell` back to `address` before reading — an
        // UNVERIFIED one. If typing/Return had moved the cursor away and THIS re-positioning GoToCell
        // itself straggled, the read could land on a bystander cell that happens to already hold SOME
        // content, and the lenient `!after.isEmpty` check below would false-PASS: reporting success
        // for a write this function never actually confirmed at its real target. Narrowed, not left
        // as a hedge: position-verify FIRST (the same proven mechanism every other check in this file
        // uses, `.verifyingWrite`'s own description makes clear this is a POST-write confirmation
        // failure, not a claim nothing was written), then take a RAW read (`readSelectionTextOnDedicatedThread`,
        // no GoToCell of its own) of whatever is now confirmed to be `address` — never a second,
        // independently-unverified re-position. One residual, stated rather than implied closed: both
        // calls run synchronously in this same dedicated-thread closure with nothing yielding between
        // them, so there is no window for an unrelated queued command to drain in between BY this
        // file's own established job model — but this is not independently proven the way the
        // position check itself is.
        try positionAndVerifyOnDedicatedThread(doc, docId: docId, viewId: viewId, part: part, address: address,
                                               context: .verifyingWrite)
        let after = readSelectionTextOnDedicatedThread(doc)
        guard !after.isEmpty else {
            throw SaveError.writeVerificationFailed(docId: docId, address: address)
        }
    }

    /// office-agent-tools T4 — `(charCode, keyCode)` for one formula character, real
    /// `com.sun.star.awt.Key` base codes (`offapi/com/sun/star/awt/Key.idl`) copied verbatim from
    /// this codebase's OWN authoritative, independently-cross-checked table
    /// (`apple/Norma/Sources/AppShell/OfficeInputCodes.swift`'s own header has the full source
    /// citation and cross-check story) — this is a re-ENCODING of already-established values, not a
    /// re-DERIVATION: `NormaOfficeHelper` cannot import `Sources/AppShell` (Task 3's own established
    /// compile-boundary constraint), and there is no AppKit `NSEvent` here to run that file's own
    /// `baseCode(appKitKeyCode:)` against in the first place — a synthetic formula character has no
    /// physical key position to look up, only the CHARACTER itself, so this table is keyed directly
    /// by `Character`, not by AppKit keyCode. Deliberately bounded to what a realistic formula
    /// needs (digits, letters, common operators/reference punctuation, quotes for string literals,
    /// space) rather than the full printable-ASCII range `OfficeInputCodes` covers for real keyboard
    /// input — an unmapped character THROWS rather than silently drops or guesses, since a dropped
    /// formula character is a corrupted formula, not a degraded-but-safe result.
    private static func formulaKeyEvent(for character: Character, docId: String, address: String) throws -> (charCode: Int, keyCode: Int) {
        guard let ascii = character.asciiValue else {
            throw SaveError.unsupportedFormulaCharacter(docId: docId, address: address, character: character)
        }
        let charCode = Int(ascii)
        let shift = 0x1000
        let base: Int
        switch character {
        case "0": base = 256
        case "1": base = 257
        case "2": base = 258
        case "3": base = 259
        case "4": base = 260
        case "5": base = 261
        case "6": base = 262
        case "7": base = 263
        case "8": base = 264
        case "9": base = 265
        case "a", "A": base = character == "A" ? 512 | shift : 512
        case "b", "B": base = character == "B" ? 513 | shift : 513
        case "c", "C": base = character == "C" ? 514 | shift : 514
        case "d", "D": base = character == "D" ? 515 | shift : 515
        case "e", "E": base = character == "E" ? 516 | shift : 516
        case "f", "F": base = character == "F" ? 517 | shift : 517
        case "g", "G": base = character == "G" ? 518 | shift : 518
        case "h", "H": base = character == "H" ? 519 | shift : 519
        case "i", "I": base = character == "I" ? 520 | shift : 520
        case "j", "J": base = character == "J" ? 521 | shift : 521
        case "k", "K": base = character == "K" ? 522 | shift : 522
        case "l", "L": base = character == "L" ? 523 | shift : 523
        case "m", "M": base = character == "M" ? 524 | shift : 524
        case "n", "N": base = character == "N" ? 525 | shift : 525
        case "o", "O": base = character == "O" ? 526 | shift : 526
        case "p", "P": base = character == "P" ? 527 | shift : 527
        case "q", "Q": base = character == "Q" ? 528 | shift : 528
        case "r", "R": base = character == "R" ? 529 | shift : 529
        case "s", "S": base = character == "S" ? 530 | shift : 530
        case "t", "T": base = character == "T" ? 531 | shift : 531
        case "u", "U": base = character == "U" ? 532 | shift : 532
        case "v", "V": base = character == "V" ? 533 | shift : 533
        case "w", "W": base = character == "W" ? 534 | shift : 534
        case "x", "X": base = character == "X" ? 535 | shift : 535
        case "y", "Y": base = character == "Y" ? 536 | shift : 536
        case "z", "Z": base = character == "Z" ? 537 | shift : 537
        case " ": base = 1284 // SPACE
        case "=": base = 1295 // EQUAL
        case "+": base = 1287 // ADD
        case "-": base = 1288 // SUBTRACT
        case "*": base = 1289 // MULTIPLY
        case "/": base = 1290 // DIVIDE
        case ".": base = 1291 // POINT
        case ",": base = 1292 // COMMA
        case "(": base = 265 | shift // shift+0 -> "("; NUM9(265) is the physical "9" key — shift+9 IS "(" on US layout
        case ")": base = 256 | shift // shift+NUM0 -> ")"
        case "$": base = 260 | shift // shift+NUM4 -> "$"
        case "%": base = 261 | shift // shift+NUM5 -> "%"
        case "\"": base = 1318 | shift // shift+QUOTERIGHT -> '"'
        case "'": base = 1318 // QUOTERIGHT, unshifted
        case ":": base = 1317 | shift // shift+SEMICOLON -> ":"
        case ";": base = 1317 // SEMICOLON
        case "_": base = 1288 | shift // shift+SUBTRACT -> "_"
        case "!": base = 257 | shift // shift+NUM1 -> "!"
        case "^": base = 262 | shift // shift+NUM6 -> "^"
        case "<": base = 1293 // LESS
        case ">": base = 1294 // GREATER
        case "&": base = 263 | shift // shift+NUM7 -> "&"
        default:
            throw SaveError.unsupportedFormulaCharacter(docId: docId, address: address, character: character)
        }
        return (charCode, base)
    }

    /// office-agent-tools T4 fix-round review (Important #3) — a LOCAL re-encoding of
    /// `officeParseCellReference`'s exact algorithm (`Sources/AppShell/PanelDocumentTab.swift`),
    /// unreachable from `NormaOfficeHelper` (Task 3's own established compile-boundary constraint,
    /// the SAME one `formulaKeyEvent(for:)`'s own header already cites for a value copied from that
    /// module) — re-ENCODED, not re-DERIVED. Every real caller's `address` is produced by
    /// `officeCellReference` on the app side (uppercase letters, 1-based row, no colon, no
    /// whitespace) — this parser is strict, not lenient, matching `officeParseCellReference`'s own
    /// "wire strictness applies here" posture: `nil` for anything else, never guessed or clamped.
    ///
    /// **T5 fix round, Critical-1 — the same two bounds the app-side original now carries** (letters
    /// <= 3, row digits <= 7; see `officeColumnMaxLetters`/`officeRowMaxDigits`' own headers for the
    /// measured app-abort those close). A re-ENCODING that drifted from its original on the one
    /// property that makes the original total would be worse than no re-encoding at all — and while
    /// every real caller's `address` is app-produced and already bounded, "the caller happens to
    /// bound it" is precisely the reasoning that left three doors open on the app side. An overflow
    /// here would abort `NormaOfficeHelper`, not the app: a smaller blast radius, still a crash.
    private static func parseSingleCellReference(_ address: String) -> (column: Int, row: Int)? {
        let letters = address.prefix(while: { $0.isASCII && $0.isLetter })
        let rest = address[letters.endIndex...]
        guard !letters.isEmpty, letters.count <= 3, !rest.isEmpty, rest.count <= 7,
              rest.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        var column = 0
        for scalar in letters.uppercased().unicodeScalars {
            guard scalar.value >= 65, scalar.value <= 90 else { return nil }
            column = column * 26 + Int(scalar.value - 65 + 1)
        }
        column -= 1
        guard let oneBasedRow = Int(rest), oneBasedRow >= 1 else { return nil }
        return (column: column, row: oneBasedRow - 1)
    }

    /// The inverse of `parseSingleCellReference` above, for an honest error message only (never fed
    /// back into LOK) — a local re-encoding of `officeCellReference`/`officeColumnLetters`'s combined
    /// algorithm, the same compile-boundary reason as its own counterpart just above.
    private static func formatCellReference(column: Int, row: Int) -> String {
        var remaining = column + 1
        var letters = ""
        while remaining > 0 {
            let digit = (remaining - 1) % 26
            letters = String(UnicodeScalar(UInt8(65 + digit))) + letters
            remaining = (remaining - 1) / 26
        }
        return "\(letters)\(row + 1)"
    }

    /// office-agent-tools T4 — insert/delete `count` whole rows/columns, selected via
    /// `selectionRange`'s own row-only ("3:5") or column-only ("C:E") span (this task's own report
    /// cites the pinned engine source — `sc/source/core/tool/address.cxx`'s range parser — confirming
    /// `.uno:GoToCell`'s `ToPoint` accepts this Name-Box addressing and expands the OTHER axis to the
    /// sheet's full width/height itself). None of the four commands
    /// (`InsertRowsBefore`/`DeleteRows`/`InsertColumnsBefore`/`DeleteColumns`) takes an argument —
    /// they act entirely on the CURRENT SELECTION, which is why positioning has to happen first, on
    /// the SAME proven GoToCell mechanism every other verb in this file uses. `getDataArea` needs no
    /// `setPart`/selection of its own (T3 review C2's own finding: it takes `nPart` directly) —
    /// reused here exactly as `sheetsInfoOnDedicatedThread` already does, including its `(0,0)`
    /// empty-vs-A1-only disambiguation.
    ///
    /// **Fix-round review item 1 — the GoToCell straggler's own residual, CLOSED here too, not left
    /// at "same as `set`."** This function originally carried the identical unverified-position risk
    /// `writeOneCellOnDedicatedThread` had before Important #3's fix — worse here, per the
    /// coordinator's own review: "clobbering one cell damages one value the user can see and undo;
    /// inserting or deleting rows at the wrong offset shifts every row below the mistake" (formulas
    /// keep computing, references keep resolving — silent, hard-to-notice, harder-to-undo
    /// misalignment of an entire sheet).
    ///
    /// **Second review — the FIRST version of this fix (anchor-check, then span-select, then
    /// re-verify against the SAME anchor) was itself falsified, not merely incomplete.** Verbatim,
    /// the finding: `selectionTextOnDedicatedThread`'s own straggler-exhaustion path (its header,
    /// above) does not throw — it silently returns the CURRENT selection unchanged. Parking the
    /// cursor AT the anchor first, then re-checking the span-select against that SAME anchor, meant a
    /// span-select that silently never moved at all left the cursor exactly where the FIRST check
    /// already put it — indistinguishable from a genuine success, since a real span-select's own
    /// `CellCursor` ALSO reports the anchor (the measured finding below, still true and still the
    /// reason a post-span check is possible at all). The old deletion-red "proof" never caught this:
    /// breaking the ONE shared comparison function broke the FIRST (anchor) check first, so the red
    /// message it produced named the anchor address, never the span — the second check's own
    /// discriminating power was never actually exercised.
    ///
    /// **The fix: park at a cell DELIBERATELY DIFFERENT from the anchor before the span-select, so
    /// the post-span check must observe a real move.** For a row resize anchored at `A<r>`, the
    /// sentinel is `B<r>` — same row, column B; for a column resize anchored at `<c>1`, the sentinel
    /// is `<c>2` — same column, row 2. Always distinct from the anchor by construction (column A vs
    /// B, or row 1 vs 2), and never exceeds sheet bounds for any legal anchor (unlike an arbitrary
    /// +1/+1 offset, which could overflow near the sheet's own max row/column). Two checks, not
    /// three — an anchor-only pre-check adds no safety a wrong `anchorTarget` would not ALSO catch at
    /// the post-span check (fail-closed either way), so it is not carried forward:
    /// 1. GoToCell to the sentinel, verified via `verifyCellCursorOnDedicatedThread`. If THIS
    ///    straggles, the mismatch is caught here, before the span is ever touched.
    /// 2. GoToCell to `selectionRange` (the real span), then re-verified against `anchorTarget` — now
    ///    genuinely discriminating: a real success moves the cursor from the sentinel to the anchor's
    ///    own position (measured below); a silent no-op leaves it at the sentinel, which the check
    ///    catches.
    ///
    /// **What `getCommandValues(".uno:CellCursor")` reports for a row/column-only span was measured
    /// live, not assumed** — 6 observations across 2 anchors, including 2 away from the sheet origin
    /// (row 3 / column C, not just row 1 / column A, which alone could not distinguish "reports the
    /// span's own anchor" from "always reports (0,0)") — task-4-report.md has the full captured
    /// values. Every observation, no outliers: `.uno:CellCursor` after a row/column-only span
    /// selection reports the EXACT SAME `(column, row)` as the span's own anchor cell (LOK treats the
    /// range's active cell as its top-left corner).
    ///
    /// **Deletion-red, this time proven against the SECOND check specifically**: the span-select
    /// `GoToCell` dispatch itself was temporarily deleted (simulating the exact silent-no-op failure
    /// this check exists to catch, not an artificial wrong-expectation), and the resize round-trip
    /// test rerun — the red message named the SPAN's own address (`1:2`/`A:A`), not the sentinel,
    /// confirming the second check is genuinely reached and genuinely discriminating. Reverted;
    /// task-4-report.md quotes the exact message.
    ///
    /// **Residual, stated precisely, not implied away**: `CellCursor` exposes only the active cell,
    /// so what is verified is the span's ANCHOR — twice, from two different starting points — never
    /// its far EXTENT independently. "Right anchor, wrong extent" (a resize that started at the
    /// correct row/column but somehow covered the wrong COUNT) remains formally unmeasured; `count`
    /// itself is never sent to the helper as a number LOK could misinterpret; it is consumed entirely
    /// on the app side to build `selectionRange`'s own two endpoints, and the documented GoToCell
    /// straggler stales the WHOLE selection, anchor included — which these checks do catch.
    private func sheetsResizeOnDedicatedThread(docId: String, sheet: String, dimension: OfficeSheetsResizeDimension,
                                               op: OfficeSheetsResizeOp, selectionRange: String) throws -> (usedEndColumn: Int, usedEndRow: Int) {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let names = sheetNamesOnDedicatedThread(doc)
        guard let part = names.firstIndex(of: sheet) else {
            throw SaveError.sheetNotFound(docId: docId, sheet: sheet, available: names)
        }

        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(part))

        // `selectionRange` is always `"<first>:<last>"` (`OfficeCommandConsumer.handleSheetsResize`'s
        // own construction: `"\(startRow):\(startRow + count - 1)"` for rows, digits; or
        // `"\(officeColumnLetters(startColumn)):..."` for columns, letters) — `<first>` is the exact
        // row/column the resize is anchored on.
        guard let firstToken = selectionRange.split(separator: ":", maxSplits: 1).first, !firstToken.isEmpty else {
            throw SaveError.positionVerificationFailed(docId: docId, address: selectionRange, landedAt: nil,
                                                        context: .resizePositioning)
        }
        let anchorAddress = dimension == .row ? "A\(firstToken)" : "\(firstToken)1"
        guard let anchorTarget = Self.parseSingleCellReference(anchorAddress) else {
            throw SaveError.positionVerificationFailed(docId: docId, address: anchorAddress, landedAt: nil,
                                                        context: .resizePositioning)
        }
        // The sentinel: deliberately NOT the anchor (same row/column, other axis offset by one letter
        // or one row — see this function's own header for why this specific offset, not +1/+1, and
        // why a sentinel exists at all). `positionAndVerifyOnDedicatedThread` both positions AND
        // verifies in one call, since — unlike the anchor — nothing else needs the sentinel's own
        // parsed target afterward.
        let sentinelAddress = dimension == .row ? "B\(firstToken)" : "\(firstToken)2"
        try positionAndVerifyOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part,
                                               address: sentinelAddress, context: .resizePositioning)

        _ = selectionTextOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part,
                                           range: selectionRange, formulas: false)
        try verifyCellCursorOnDedicatedThread(doc, docId: docId, expectedAddress: selectionRange,
                                              target: anchorTarget, context: .resizePositioning)

        let command: String
        switch (dimension, op) {
        case (.row, .insert): command = ".uno:InsertRowsBefore"
        case (.row, .delete): command = ".uno:DeleteRows"
        case (.col, .insert): command = ".uno:InsertColumnsBefore"
        case (.col, .delete): command = ".uno:DeleteColumns"
        }
        command.withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
        // Best-effort pump — the SAME throwaway `paintPartTile` primitive `.uno:GoToCell`'s own poll
        // already trusts, giving LOK's dispatcher one more turn before the used-range read below,
        // which would otherwise race the structural edit exactly the way an unpumped read could race
        // a still-queued GoToCell.
        pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)

        var lastCol: Int = 0
        var lastRow: Int = 0
        doc.handle.pointee.pClass.pointee.getDataArea?(doc.handle, part, &lastCol, &lastRow)
        if lastCol == 0 && lastRow == 0 {
            let hasA1Content = try sheetHasA1ContentOnDedicatedThread(docId: docId, part: part)
            return (usedEndColumn: hasA1Content ? 0 : -1, usedEndRow: hasA1Content ? 0 : -1)
        }
        return (usedEndColumn: lastCol, usedEndRow: lastRow)
    }

    /// office-agent-tools T4 — add/delete/rename a sheet, dispatched entirely through UNO commands
    /// this task's own research confirmed dispatchable WITHOUT a modal dialog, PROVIDED every
    /// required argument is present (a missing one opens a real, headless-undismissable dialog —
    /// `AbstractScInsertTableDlg`/a `xQueryBox` confirmation — a HANG this function must never risk):
    ///
    /// - `.add` → `.uno:Add {Name}` — always appends at the end (this tool's own v1 scope: no
    ///   position operand), never `.uno:Insert` (which additionally needs a numeric `Index` — see
    ///   below for why this bridge avoids a numeric UNO arg wherever a real alternative exists).
    /// - `.rename` → `.uno:Name {Name}`, `Index` OMITTED — the research's own finding: omitting
    ///   `Index` targets the CURRENT sheet, and the dialog only fires when the WHOLE args object is
    ///   null, not merely missing one optional key — so this function makes the TARGET sheet current
    ///   first (`setPart`, the identical mechanism every read/write verb already uses to target a
    ///   sheet) rather than compute a 1-based `Index` it would otherwise have to guess a JSON type
    ///   string for.
    /// - `.delete` → `.uno:Remove {Index}` — the ONE case with no name-based alternative; `Index` is
    ///   REQUIRED (1-based, no "0 means current" convention — passing 0 targets sheet 1). The JSON
    ///   "type" string for this NUMERIC arg (`SfxUInt16Item`) could not be confirmed from source
    ///   alone (this task's own research: "an honest gap, not a guess dressed up as fact") — resolved
    ///   live against the real engine, not assumed; see task-4-report.md for what actually worked.
    ///
    /// **Two refusals happen BEFORE any UNO command is dispatched, not after** —
    /// `SaveError.lastSheet`/`.duplicateSheetName`: this task's own research found Calc's real
    /// handlers give NO honest error signal for either case (`RenameTable` returns `false` with
    /// nothing surfacing through the UNO dispatch; `CreateValidTabName` silently ALTERS a colliding
    /// name rather than refusing it) — a pre-check against this bridge's own already-known sheet list
    /// is the only way to refuse cleanly rather than risk a silent no-op or a silently different name
    /// than the one the caller asked for.
    ///
    /// **The op's own success is confirmed by RE-READING the sheet list afterward, not trusted from
    /// dispatch alone** — the identical "a UNO command was posted, not a claim it took effect" caveat
    /// every fire-and-forget verb in this file already carries, made concrete here because this
    /// task's own research specifically flagged both `.add`/`.rename`'s silent-failure/silent-
    /// alteration risk. A count/membership mismatch after the pump throws honestly rather than report
    /// success on an operation this bridge cannot otherwise confirm landed.
    ///
    /// **Dispatched on the PRIMARY view, all three ops — NOT the agent-view isolation every other
    /// write verb in this file has, a deliberate, disclosed, LIVE-FORCED retreat, not the original
    /// design.** Two rounds of live evidence, in order, are why:
    ///
    /// 1. Moving `.delete` (`.uno:Remove`) to the agent view made this bridge's own live drill TIME
    ///    OUT — `OfficeHelperClient`'s bounded 30s `requestTimeout` rescuing it, not a crash, but a
    ///    genuine hang on the dedicated thread — reproduced whether `.delete` itself dispatched from
    ///    the agent view OR the primary, as long as an agent view EXISTED at all for that docId (left
    ///    over from an earlier `sheets set`/`read`/`resize`/`rename_sheet` call, or this function's
    ///    own prior `.add`/`.rename`). Destroying any pre-existing agent view immediately before
    ///    `.uno:Remove` (kept below) is what actually closed that hang.
    /// 2. Moving `.add`/`.rename` to the agent view (to stop `.rename`'s own `setPart` call from
    ///    moving an ADOPTED tab's visible sheet — a real problem, proven live in isolation once) then
    ///    made THEIR OWN post-dispatch verification stop converging AT ALL across repeated isolated
    ///    reruns — not "needs a few more pump attempts" the way `.uno:GoToCell`'s own race does, but
    ///    exhausting a 20-attempt budget outright, run after run. No root cause is claimed for either
    ///    finding (plausible: this LOK build's multi-view support is proven, heavily, for the
    ///    CELL-level primitives — GoToCell, paste, ext-text-input, postKeyEvent — every OTHER write
    ///    verb in this file rides, and far less exercised for WORKBOOK-STRUCTURAL edits dispatched
    ///    from a genuinely headless second view) — only that the boundary is real, found empirically,
    ///    across two independent live-evidence rounds, not reasoned about in advance.
    ///
    /// **The disclosed residual this leaves**: unlike `sheets set`/`insert_rows`/`insert_cols`/
    /// `delete_rows`/`delete_cols` (all genuinely isolated to the agent view, proven live), the THREE
    /// verbs this function serves can move an ADOPTED document's own primary-view state —
    /// `rename_sheet`'s `setPart` most concretely, `add_sheet`'s standard "new sheet becomes active"
    /// UX plausibly. Not closed in this task; see task-4-report.md's own concerns for the full
    /// accounting rather than a claim this is fixed.
    ///
    /// - `.add` → `.uno:Add {Name}` — always appends at the end (this tool's own v1 scope: no
    ///   position operand), never `.uno:Insert` (which additionally needs a numeric `Index` — see
    ///   `.delete`'s own case below for why this bridge avoids a numeric UNO arg wherever a real
    ///   alternative exists).
    /// - `.rename` → `.uno:Name {Name}`, `Index` OMITTED — the research's own finding: omitting
    ///   `Index` targets the CURRENT sheet, and the dialog only fires when the WHOLE args object is
    ///   null, not merely missing one optional key — so this function makes the TARGET sheet current
    ///   first (`setPart`) rather than compute a 1-based `Index` it would otherwise have to guess a
    ///   JSON type string for.
    /// - `.delete` → `.uno:Remove {Index}` — the ONE case with no name-based alternative; `Index` is
    ///   REQUIRED (1-based, no "0 means current" convention — passing 0 targets sheet 1). The JSON
    ///   "type" string for this NUMERIC arg (`SfxUInt16Item`) could not be confirmed from source
    ///   alone (this task's own research: "an honest gap, not a guess dressed up as fact") — resolved
    ///   live against the real engine: `"unsigned short"`, first attempt, no dialog hang.
    ///
    /// **Two refusals happen BEFORE any UNO command is dispatched, not after** —
    /// `SaveError.lastSheet`/`.duplicateSheetName`: this task's own research found Calc's real
    /// handlers give NO honest error signal for either case (`RenameTable` returns `false` with
    /// nothing surfacing through the UNO dispatch; `CreateValidTabName` silently ALTERS a colliding
    /// name rather than refusing it) — a pre-check against this bridge's own already-known sheet list
    /// is the only way to refuse cleanly rather than risk a silent no-op or a silently different name
    /// than the one the caller asked for.
    ///
    /// **The op's own success is confirmed by RE-READING the sheet list afterward, poll-with-pump —
    /// never a single read trusted from dispatch alone.** Same fix-round-2b lesson `.uno:GoToCell`'s
    /// own verification already learned, with its OWN, independently-sized budget
    /// (`sheetsManageVerificationAttempts`, larger than `goToCellVerificationAttempts` — a structural
    /// sheet mutation is a heavier operation than a cell selection move, live-measured to need more
    /// attempts even once it converges reliably again after the primary-view revert).
    /// office-agent-tools T4 fix-round review (item 5) — extracted so each of `sheetsManageSheet
    /// OnDedicatedThread`'s three cases can call it AFTER its own refusal guards, immediately before
    /// its own UNO dispatch, rather than unconditionally before the whole `switch`. See that
    /// function's own header for the full reasoning; unchanged in mechanism from the original
    /// inline form (get-or-mint on the next `sheets set`/`read`/`resize` call already handles
    /// re-creating whatever this destroys, so calling it zero times on a refused call loses nothing).
    private func destroyAgentViewIfAnyOnDedicatedThread(_ doc: OpenDocument, docId: String) {
        if var mutableDoc = documents[docId], let agentViewId = mutableDoc.agentViewId, agentViewId >= 0 {
            doc.handle.pointee.pClass.pointee.destroyView?(doc.handle, agentViewId)
            mutableDoc.agentViewId = nil
            documents[docId] = mutableDoc
        }
    }

    private func sheetsManageSheetOnDedicatedThread(docId: String, op: OfficeSheetsManageSheetOp,
                                                     name: String, newName: String?) throws -> [String] {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        let before = sheetNamesOnDedicatedThread(doc)

        // Fix-round review (item 5, "provably safe on the task's own evidence, since refusals never
        // dispatch") — moved from UNCONDITIONALLY before the switch to immediately before EACH case's
        // own UNO dispatch, AFTER that case's own guards. The ORIGINAL placement destroyed the agent
        // view even on a call that was about to REFUSE (name not found, last sheet, duplicate name) —
        // a real side effect on a path that mutates nothing else, contradicting this file's own
        // "refuse before mutating anything" posture every OTHER refusal (dirty, fence) already holds
        // to. Safe to move: every guard below THROWS before reaching its own case's dispatch line, so
        // a refusal can never reach `destroyAgentViewIfAnyOnDedicatedThread` at all now — the hang
        // this destroy exists to prevent (this function's own header, point 1) is a property of
        // DISPATCHING `.uno:Remove` with a stale agent view present, never of a call that refuses
        // and never dispatches anything.
        switch op {
        case .add:
            guard !before.contains(name) else { throw SaveError.duplicateSheetName(docId: docId, name: name) }
            destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
            postUnoCommandOnDedicatedThread(doc, ".uno:Add", ["Name": ["type": "string", "value": name]])
        case .delete:
            guard before.contains(name) else {
                throw SaveError.sheetNotFound(docId: docId, sheet: name, available: before)
            }
            guard before.count > 1 else { throw SaveError.lastSheet(docId: docId) }
            destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
            let oneBasedIndex = before.firstIndex(of: name)! + 1
            postUnoCommandOnDedicatedThread(doc, ".uno:Remove",
                                            ["Index": ["type": "unsigned short", "value": oneBasedIndex]])
        case .rename:
            guard let zeroBasedIndex = before.firstIndex(of: name) else {
                throw SaveError.sheetNotFound(docId: docId, sheet: name, available: before)
            }
            // `newName` is guaranteed non-nil for `.rename` by the wire's own decode
            // (`OfficeWireFrame`'s `sheetsManageSheet` case — `(op == .rename) == (newName != nil)`)
            // — a genuinely nil `newName` here would be a decode bug elsewhere, not a data error
            // this function should describe with a SaveError.
            guard let newName else {
                preconditionFailure("sheetsManageSheet(.rename) reached with no newName — the wire decode's own invariant was violated")
            }
            guard !before.contains(newName) else { throw SaveError.duplicateSheetName(docId: docId, name: newName) }
            destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(zeroBasedIndex))
            postUnoCommandOnDedicatedThread(doc, ".uno:Name", ["Name": ["type": "string", "value": newName]])
        }

        // **Poll-with-pump, not a single read — live-measured, the same fix-round-2b lesson
        // `.uno:GoToCell`'s own verification already learned (`selectionTextOnDedicatedThread`'s own
        // header).** The first version of this check read `sheetNamesOnDedicatedThread` exactly
        // once, immediately after the pump each op's own dispatch already does — and `add_sheet`
        // failed verification live, on the very first drill after the `.delete`-hang fix above: the
        // UNO dispatch itself needs more than one pump's worth of turns before the sheet COUNT
        // reflects it, the identical "fire-and-forget, not synchronous" property `postUnoCommand`
        // has everywhere else in this file. Bounded (4 attempts, mirroring `goToCellVerification
        // Attempts`), pumped on the PRIMARY view uniformly — always valid regardless of which op ran
        // (`.delete` may have just destroyed the agent view entirely; `.add`/`.rename`'s agent view
        // may or may not still exist depending on future changes to this function) — never re-
        // dispatching the op itself, only giving LOK's own dispatcher more turns to catch up.
        func verified(_ names: [String]) -> Bool {
            switch op {
            case .add: return names.count == before.count + 1
            case .delete: return names.count == before.count - 1 && !names.contains(name)
            case .rename: return names.contains(newName ?? "") && !names.contains(name)
            }
        }
        // **Round 2, live-measured again**: `goToCellVerificationAttempts` (4) — sized for a CELL
        // SELECTION move — was not enough here even once out of six total live runs at that budget.
        // Inserting/removing/renaming a SHEET is a heavier, structural document mutation than a
        // selection change, not merely the same race at the same speed; `sheetsManageVerification
        // Attempts` is this function's own, independently-sized budget, not a shared one, so raising
        // it cannot silently loosen `.uno:GoToCell`'s own proven-tight bound elsewhere in this file.
        var after = sheetNamesOnDedicatedThread(doc)
        var attempts = 1
        while !verified(after) && attempts < Self.sheetsManageVerificationAttempts {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: 0)
            after = sheetNamesOnDedicatedThread(doc)
            attempts += 1
        }
        if attempts > 1 {
            FileHandle.standardError.write(Data(
                "[LOKBridge sheets] manageSheet(\(op)) needed \(attempts) attempt(s) before verification succeeded (or the budget was exhausted)\n".utf8))
        }
        guard verified(after) else {
            let label = "(\(op)_sheet \"\(op == .rename ? (newName ?? "") : name)\")"
            throw SaveError.writeVerificationFailed(docId: docId, address: label)
        }
        return after
    }

    // MARK: - office-agent-tools T5: sheets format — the verb the human formatting toolbar will share

    /// office-agent-tools T5 — points (`sheets.ts`'s own operand unit, chosen for locale-independence
    /// — see that file's own doc) to the vendored engine's real native unit for `.uno:ColumnWidth`'s
    /// own argument: 1/100 mm, confirmed against the pinned engine's own source
    /// (`o3tl::toTwips(nWidth, o3tl::Length::mm100)`, `sc/source/ui/view/cellsh3.cxx`, this task's own
    /// research — see `sheetsFormatOnDedicatedThread`'s own header for the full citation). 1 point =
    /// 1/72 inch = 25.4/72 mm = 2540/72 hundredths-of-a-mm — an exact rational constant, not a
    /// measured approximation. Rounded to the nearest whole 1/100mm (the item's own type,
    /// `SfxUInt16Item`, is integral — a fractional value has nowhere to go anyway). `sheets.ts`'s own
    /// `width` schema (`.min(1).max(1000)` points) keeps this comfortably inside `UInt16`'s range at
    /// both ends: 1pt -> 35 (never rounds to the unrepresentable 0), 1000pt -> 35,278 (well under
    /// 65,535).
    ///
    /// **T5 fix-round RE-REVIEW (Minor) — bounded here too, against this round's own stated rule.**
    /// The round bounded `parseSingleCellReference` helper-side on the explicit principle that "the
    /// caller happens to bound it" is the reasoning that left three doors open, then did not apply
    /// that principle to the sibling conversion in this same file: `Int(Double)` traps outside
    /// `Int`'s range, and an unbounded `points` reaches it. Blast radius is `NormaOfficeHelper`, not
    /// the app — a smaller crash, still a crash, and still a rule this file was already following
    /// twelve hundred lines up. `nil` for anything outside the app's own documented [1, 1000]-point
    /// operand range (`OfficeCommandConsumer.officeWidthMinPoints`/`MaxPoints`, mirrored here for
    /// the same compile-boundary reason `parseSingleCellReference`'s own header cites); NaN and
    /// infinity fall out for free, since neither comparison holds.
    private static func officeWidthMm100(fromPoints points: Double) -> Int? {
        guard points >= 1.0, points <= 1000.0 else { return nil }
        return Int((points * 2540.0 / 72.0).rounded())
    }

    /// office-agent-tools T5 — the SAME sentinel-then-anchor two-check position-verification pattern
    /// `sheetsResizeOnDedicatedThread` established (task-5-brief.md's own mandate: "Position
    /// verification is mandatory... Do the same"), generalized to any pre-formatted `span` a caller
    /// wants to select — a full two-corner range ("A1:C10", `sheetsFormat`'s own cell-attribute
    /// phase) or a column-only Name-Box span ("A:C", its own width phase) — given that span's own
    /// ANCHOR as an already-resolved single-cell address (the caller's job, mirroring
    /// `sheetsResizeOnDedicatedThread`'s own `anchorAddress` construction, never re-derived here).
    ///
    /// Parks at a sentinel cell DIFFERENT from the anchor first — same row, a column guaranteed to
    /// differ from the anchor's own (column B unless the anchor's own column IS B, in which case
    /// column A; always exists, always distinct, never an arithmetic offset that could overflow near
    /// the sheet's own edge) — so a span-select that silently never happens is caught, not masked by
    /// a check that only re-confirms wherever the sentinel-park already put the cursor (the exact
    /// falsification task-4-report.md §8 documents against the FIRST version of this pattern, before
    /// the sentinel fix). Then selects the real `span` and re-verifies against the SAME anchor.
    private func positionAndVerifySpanOnDedicatedThread(_ doc: OpenDocument, docId: String, viewId: Int32, part: Int,
                                                        anchorAddress: String, span: String) throws {
        guard let anchorTarget = Self.parseSingleCellReference(anchorAddress) else {
            throw SaveError.positionVerificationFailed(docId: docId, address: anchorAddress, landedAt: nil,
                                                        context: .formatPositioning)
        }
        let sentinelColumn = anchorTarget.column == 1 ? 0 : 1
        let sentinelAddress = Self.formatCellReference(column: sentinelColumn, row: anchorTarget.row)
        try positionAndVerifyOnDedicatedThread(doc, docId: docId, viewId: viewId, part: part,
                                               address: sentinelAddress, context: .formatPositioning)

        _ = selectionTextOnDedicatedThread(doc, docId: docId, viewId: viewId, part: part, range: span, formulas: false)
        try verifyCellCursorOnDedicatedThread(doc, docId: docId, expectedAddress: span, target: anchorTarget,
                                              context: .formatPositioning)
    }

    /// office-agent-tools T5 — applies `bold`/`italic`/`numberFormat`/`align`/`width` over `range` on
    /// `sheet`, every one optional and independent (`nil` means "leave this attribute alone" — the
    /// whole contract `OfficeWireFrame.sheetsFormat`'s own header states in full). **The app-side
    /// `OfficeRuntime.sheetsFormat` that calls down to this bridge is the SAME function a future
    /// human-facing formatting UI will call — see that function's own header for the shared-code
    /// signature.**
    ///
    /// **Two independent phases, on the agent view — the same isolation every OTHER cell-level write
    /// verb in this file has (`set`, all four resize verbs), never the primary-view retreat
    /// `sheetsManageSheetOnDedicatedThread` was live-forced into (that retreat was about WORKBOOK-
    /// STRUCTURAL commands — Add/Remove/Name a whole sheet — not cell/column attribute commands,
    /// which this task's own live drills confirm behave like every other agent-view-isolated
    /// primitive; see task-5-report.md if that ever needs revisiting).**
    ///
    /// **Phase 1 — cell attributes (bold/italic/numberFormat/align), entered only when at least one
    /// is named**, over `range`'s own cell-range selection:
    ///
    /// - **`bold`/`italic` dispatch a REAL absolute-state argument, confirmed by reading the vendored
    ///   engine's own Execute handler (`ScFormatShell::ExecuteTextAttr`, `sc/source/ui/view/
    ///   formatsh.cxx`, this task's own research, primary-source-cited in task-5-report.md): the slot
    ///   TOGGLES only when its args are ABSENT — supplying `{"Bold":{"type":"boolean","value":
    ///   "true"}}` (the value as a STRING, `"true"`/`"false"`, the shape the research found actually
    ///   used — never a native JSON boolean, which this bridge has not verified the underlying parser
    ///   accepts) sets that exact state regardless of the range's own current state, including a
    ///   MIXED range. Verified live, not merely reasoned — see task-5-report.md's own idempotency and
    ///   mixed-range drills.
    /// - **`align` dispatches `.uno:HorizontalAlignment`** (`SID_H_ALIGNCELL`), value `1`/`2`/`3` for
    ///   left/center/right (`com.sun.star.table.CellHoriJustify`) — deterministic by construction, no
    ///   toggle risk at all (this task's own research: the Execute handler only ever fires when args
    ///   are present, so an absent-args no-op is the ONLY alternate behavior, never a flip).
    /// - **`numberFormat` is applied via a NORMALIZE-THEN-APPLY sequence, unconditionally, regardless
    ///   of whether the underlying preset commands turn out to toggle or set absolutely.**
    ///   `.uno:NumberFormatStandard` (General) dispatches FIRST, always; the target preset's own
    ///   command dispatches second, only when the target itself is not `.general` (nothing to
    ///   normalize INTO beyond the reset itself). This makes the whole operation deterministic BY
    ///   CONSTRUCTION: starting from a KNOWN state and taking exactly one forward step always lands
    ///   in the same place, whether that step happens to toggle or to set absolutely — a toggle's own
    ///   ambiguity on a MIXED-state range never gets a chance to matter, because every cell in the
    ///   selection is normalized to the identical starting state first. **Why this design exists at
    ///   all, not a free-form format-code string** (spec §2's own generic `numberFormat` operand,
    ///   deliberately narrowed — see `OfficeWireFrame.sheetsFormat`'s own header for the full,
    ///   source-grounded reasoning): this task's own research read the vendored engine's real Execute
    ///   handler and found `.uno:NumberFormat` is NOT a format code at all (a four-field comma tuple
    ///   silently comma-split into garbage by a real code string) and the command that DOES take a
    ///   format — `.uno:NumberFormatValue` — takes a pre-registered NUMERIC KEY whose registration
    ///   (`XNumberFormats.queryKey`/`.addNew`) is a UNO Property-API call with no `.uno:` slot,
    ///   confirmed UNREACHABLE by reading the vendored `LibreOfficeKit.h` this bridge actually links
    ///   against (`Sources/OfficeKit/include/LibreOfficeKit.h`): the only command-shaped surface on
    ///   `LibreOfficeKitDocumentClass` is `postUnoCommand`/`getCommandValues`/`setBlockedCommandList`.
    ///
    /// **Phase 2 — `width`, entered only when `width`/`columnSpan` are both non-nil**, over
    /// `columnSpan`'s OWN, SEPARATE column-span selection (never `range`'s cell selection — `width`
    /// is a COLUMN property, this function's own callers already establish that split):
    ///
    /// - **`.uno:ColumnWidth` dispatches with its OWN argument ALWAYS present** — omitting it opens a
    ///   real, headless-undismissable modal dialog (`ScMetricInputDlg`, this task's own research,
    ///   confirmed against `sc/source/ui/view/cellsh3.cxx`'s own `StartExecuteAsync` call) — the exact
    ///   hang class `sheetsManageSheetOnDedicatedThread`'s own header already paid to learn to avoid,
    ///   for a DIFFERENT command. `officeWidthMm100(fromPoints:)` (above) is the named, cited
    ///   points-to-1/100mm conversion — never an inline formula.
    ///
    /// A best-effort pump (`pumpDedicatedThreadForPendingDispatch`, the SAME throwaway primitive every
    /// other UNO-command verb in this file already trusts) follows each phase's own dispatches, before
    /// the NEXT phase's own position-verification (or, for the last phase run, before this function
    /// returns) — giving LOK's own dispatcher a turn to drain before anything downstream (a save, or
    /// phase 2's own position check) depends on the phase having taken effect.
    ///
    /// Returns which attribute NAMES were reached — `["bold","italic","numberFormat","align","width"]`
    /// filtered to what was actually named, in that fixed order — "posted," the same honest-not-a-
    /// claim-of-effect posture `keyEventOk`/`undoOk` already hold to (this bridge's real proof is the
    /// caller's own save-reopen-readback, per this task's own proof obligations, not a synchronous
    /// confirmation this function has no cheap way to make for a formatting attribute the way
    /// `sheetsResizeOnDedicatedThread`'s own `getDataArea` read can for a dimension change).
    private func sheetsFormatOnDedicatedThread(docId: String, sheet: String, range: String, columnSpan: String?,
                                               bold: Bool?, italic: Bool?, numberFormat: OfficeSheetsNumberFormatPreset?,
                                               align: OfficeSheetsAlign?, width: Double?) throws -> [String] {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .spreadsheet else { throw SaveError.notSpreadsheet(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let names = sheetNamesOnDedicatedThread(doc)
        guard let part = names.firstIndex(of: sheet) else {
            throw SaveError.sheetNotFound(docId: docId, sheet: sheet, available: names)
        }

        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(part))

        var applied: [String] = []

        // Phase 1 — cell attributes, over `range`'s own selection.
        if bold != nil || italic != nil || numberFormat != nil || align != nil {
            guard let rangeAnchorToken = range.split(separator: ":", maxSplits: 1).first, !rangeAnchorToken.isEmpty else {
                throw SaveError.positionVerificationFailed(docId: docId, address: range, landedAt: nil,
                                                            context: .formatPositioning)
            }
            try positionAndVerifySpanOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part,
                                                        anchorAddress: String(rangeAnchorToken), span: range)

            if let bold {
                postUnoCommandOnDedicatedThread(doc, ".uno:Bold",
                                                ["Bold": ["type": "boolean", "value": bold ? "true" : "false"]])
                applied.append("bold")
            }
            if let italic {
                postUnoCommandOnDedicatedThread(doc, ".uno:Italic",
                                                ["Italic": ["type": "boolean", "value": italic ? "true" : "false"]])
                applied.append("italic")
            }
            if let numberFormat {
                // Normalize first, unconditionally — see this function's own header for why this
                // makes the whole operation deterministic regardless of toggle-vs-absolute.
                ".uno:NumberFormatStandard".withCString { commandPtr in
                    doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
                }
                if numberFormat != .general {
                    let presetCommand: String
                    switch numberFormat {
                    case .general: presetCommand = ".uno:NumberFormatStandard" // unreachable — guarded above
                    case .number: presetCommand = ".uno:NumberFormatDecimal"
                    case .percent: presetCommand = ".uno:NumberFormatPercent"
                    case .currency: presetCommand = ".uno:NumberFormatCurrency"
                    case .date: presetCommand = ".uno:NumberFormatDate"
                    }
                    presetCommand.withCString { commandPtr in
                        doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
                    }
                }
                applied.append("numberFormat")
            }
            if let align {
                let value: Int
                switch align {
                case .left: value = 1
                case .center: value = 2
                case .right: value = 3
                }
                postUnoCommandOnDedicatedThread(doc, ".uno:HorizontalAlignment",
                                                ["HorizontalAlignment": ["type": "long", "value": String(value)]])
                applied.append("align")
            }
            pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        }

        // Phase 2 — `width`, over `columnSpan`'s OWN, separate selection.
        if let width, let columnSpan {
            guard let columnAnchorToken = columnSpan.split(separator: ":", maxSplits: 1).first, !columnAnchorToken.isEmpty else {
                throw SaveError.positionVerificationFailed(docId: docId, address: columnSpan, landedAt: nil,
                                                            context: .formatPositioning)
            }
            try positionAndVerifySpanOnDedicatedThread(doc, docId: docId, viewId: agentViewId, part: part,
                                                        anchorAddress: "\(columnAnchorToken)1", span: columnSpan)

            guard let mm100 = Self.officeWidthMm100(fromPoints: width) else {
                throw SaveError.widthOutOfRange(docId: docId, points: width)
            }
            postUnoCommandOnDedicatedThread(doc, ".uno:ColumnWidth",
                                            ["ColumnWidth": ["type": "unsigned short", "value": String(mm100)]])
            applied.append("width")
            pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        }

        return applied
    }

    // MARK: - office-agent-tools T6: slides
    //
    // `slidesInfoOnDedicatedThread`'s NAME half is REAL — `getParts`/`getPartName` are the identical,
    // already-proven primitives `sheetNamesOnDedicatedThread` rides (LOK's part model is shared
    // machinery across Calc/Impress; nothing here is Impress-specific or newly risky). `layout` was
    // removed from this bridge's own vocabulary entirely (see `OfficeSlideInfo`'s own header): LOK
    // gives no layout read-back at all, for any slide, ever.
    //
    // ## The placeholder-text mechanism — Tab-cycling, per `slides-lok-research.md` §5
    //
    // Went straight to the CONFIRMED path (§5.2), not the speculative one (§5.1, `.uno:OutlineMode`):
    // that research found `SdXImpressDocument` — the class implementing every LOK callback for
    // Impress — has ZERO references to `ST_OUTLINE`/`OutlineViewShell` anywhere, a strong signal it
    // does not integrate with LOK's own tiled-rendering/callback model at all, versus Tab-cycling's
    // fully-traced call chain (`FuDraw`'s raw key handler -> `SdrMarkView::MarkNextObj`) and its own
    // confirmed verification instrument (`LOK_CALLBACK_GRAPHIC_SELECTION`, §5.4). A live-tested,
    // real mechanism now beats a lower-confidence one nobody has spent a cycle probing.
    //
    // **Real key events only (`postKeyEvent`/`agentKeyEvent`), never `postUnoCommand`-driven
    // selection** — Tab is confirmed to reach `MarkNextObj` ONLY via the raw key path (research
    // §5.2). **Verified before typing, every time** (`selectSlidePlaceholderOnDedicatedThread`,
    // below) — the same "confirm the selection actually moved before acting on it" discipline this
    // bridge already applies for Calc's own `CellCursor` check, adapted to a push-only signal.
    //
    // **Disclosed, not closed — the residual `slides-lok-research.md` §5.2 itself names**: Tab order
    // is semantic (title, then body) ONLY on a slide whose shapes were never manually reordered by
    // the user — `SetAutoLayout`'s own placeholder-creation loop happens to create Title before
    // Outline for every content-bearing layout, which is what makes "first Tab = title" true for an
    // untouched, freshly-laid-out slide. There is no LOK-exposed way to ask "which `PresObjKind` is
    // this" directly (research §5.3) — this bridge verifies ONLY that a real, NEW selection landed,
    // never that it landed on the semantically-intended shape. Stated here, in the tool's own
    // description (`slides.ts`), and left as a named residual, not silently assumed away.

    /// office-agent-tools T6 — the raw `com.sun.star.awt.Key` base codes this mechanism needs,
    /// transcribed from the SAME `offapi/com/sun/star/awt/Key.idl` source `OfficeInputCodes.swift`'s
    /// own table cites (this bridge cannot import `Sources/AppShell` — see this file's own header,
    /// and `formulaKeyEvent(for:)`'s identical precedent for why a second, independently-transcribed
    /// copy lives here). No modifier bits — every use is a bare keypress, `charCode: 0`.
    private enum SlidesKeyCode {
        static let escape = 1281
        static let tab = 1282
        static let f2 = 769
    }

    /// Escapes any current selection/edit mode, then posts `KEY_TAB` `tabCount` times on the AGENT
    /// view, verifying EACH press against a fresh `LOK_CALLBACK_GRAPHIC_SELECTION` firing before
    /// posting the next one. Returns the FINAL press's own selection rect, or `nil` the instant any
    /// press produces no new firing — read as "this slide has fewer than `tabCount` selectable
    /// shapes" (a structural fact about the slide, e.g. a Blank layout), never a straggler worth
    /// retrying: unlike `.uno:GoToCell`'s own fire-and-forget dispatch, a REAL key event through the
    /// normal input path is what T4's own investigation found DOES fire callbacks reliably — no
    /// pump-and-poll is built here unless live evidence demands one.
    ///
    /// `tabCount: 1` reaches the title placeholder (on a freshly-laid-out, undisturbed slide);
    /// `tabCount: 2` reaches the body. Always starts from a fresh `Escape`, never continues from
    /// wherever a PRIOR call on this same long-lived agent view happened to leave the mark list —
    /// so `read`ing title then body (two independent calls) cannot accidentally land on the SAME
    /// shape twice because the second call forgot where the first one left off.
    private func selectSlidePlaceholderOnDedicatedThread(docId: String, slide: Int, tabCount: Int) throws -> OfficeTwipsRect? {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        let agentViewId = try ensureAgentViewOnDedicatedThread(docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(slide))

        func clearObservedRect() {
            guard var cleared = documents[docId] else { return }
            cleared.lastGraphicSelectionRectTwips = nil
            documents[docId] = cleared
        }
        func postAgentKey(_ keyCode: Int) {
            doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, Int32(keyCode))
            doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, Int32(keyCode))
        }

        clearObservedRect()
        postAgentKey(SlidesKeyCode.escape)

        var landedRect: OfficeTwipsRect?
        // **Deletion-red proof (office-agent-tools T6, 2026-08-24)**: hardcoded this loop to always
        // run exactly once regardless of `tabCount`, rebuilt, reran the live `read` drill (slide 2,
        // tabCount 1 for title / 2 for body) — `body` came back reading the SAME text as `title`
        // ("Norma T6 Slide Two" for both), the exact "wrong placeholder selected" signature, not
        // "nothing found" (that's proof A/C's own signature, in `handleCallback`/
        // `readSelectedShapeTextOnDedicatedThread`) — and `info` (title-only, tabCount always 1) was
        // correctly UNAFFECTED, confirming the break was scoped to this loop bound specifically, not
        // some broader breakage. Reverted, confirmed byte-identical, reran green.
        for _ in 0..<tabCount {
            clearObservedRect()
            postAgentKey(SlidesKeyCode.tab)
            // **Live-falsified without this**: a first attempt with NO pump reported every slide's
            // title as "no such placeholder," even though a raw-callback trace showed the correct
            // rect firing — just not synchronously within `postKeyEvent`'s own return. The IDENTICAL
            // deferred-internal-dispatch-queue shape T3's own `.uno:GoToCell` investigation found
            // (task-3-report.md §3), now confirmed for `postKeyEvent`-driven selection too — a REAL
            // input event GUARANTEES eventual firing (T4's own finding, vs. `postUnoCommand`, which
            // does not), but "eventual" is not "synchronous." Same fix: a throwaway
            // `pumpDedicatedThreadForPendingDispatch` call between polls gives LOK's own internal
            // queue a turn, `goToCellVerificationAttempts` sized identically (this mechanism has not
            // earned its own independently-derived budget yet).
            var rect = documents[docId]?.lastGraphicSelectionRectTwips
            var attempts = 1
            while rect == nil, attempts < Self.slidePlaceholderPositionAttempts {
                pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: slide)
                rect = documents[docId]?.lastGraphicSelectionRectTwips
                attempts += 1
            }
            if attempts > 1 {
                // Evidence line, permanent — the same shape (and the same purpose) as the
                // `[LOKBridge sheets] GoToCell` line this file already carries: how often the race
                // actually fires, and which attempt it resolved on, never silent. This is what makes
                // `slidePlaceholderPositionAttempts` a MEASURED budget rather than a guessed one, and
                // what will show the next reader whether it is still adequate.
                FileHandle.standardError.write(Data(
                    "[LOKBridge slides] placeholder positioning (slide \(slide), tab \(tabCount)) needed \(attempts) attempt(s), landed=\(rect != nil)\n".utf8))
            }
            guard let rect else {
                return nil
            }
            landedRect = rect
        }
        return landedRect
    }

    /// Enters text-edit mode on whatever shape is currently selected (`F2` — Impress's own standard
    /// "edit this object's text" key, the identical convention this bridge's own `set`/`format`
    /// mechanisms rely on being universal rather than re-deriving per app), selects all of that
    /// shape's own text (`.uno:SelectAll` — a common, well-known, argument-less UNO command, none of
    /// the hazard-class-1/2 risk this bridge's own `add_sheet`/`ColumnWidth` investigations found for
    /// LESS common commands), reads it back via `getTextSelection` (`readSelectionTextOnDedicatedThread`,
    /// this bridge's own established single read-path — see that function's own header), then exits
    /// edit mode (`Escape`) to leave the document in the SAME object-selected-but-not-editing state
    /// `selectSlidePlaceholderOnDedicatedThread` itself produces, never mid-edit.
    /// **`part` added, live-falsified without it**: the FIRST live drill of this mechanism reported
    /// slide 1's title correctly but slides 2/3 as "empty" — positioning (already pump-verified) was
    /// fine, but `getTextSelection` came back empty right after `.uno:SelectAll`. Same deferred-
    /// internal-dispatch shape as the positioning fix right above, one layer later in the same
    /// mechanism: `.uno:SelectAll` is `postUnoCommand`-driven (fire-and-forget, this bridge's own
    /// established "may not land synchronously" class), so a pump between it and the read is not
    /// optional ceremony, it is what makes the read see the selection SelectAll just made. One pump,
    /// not a poll-until-non-empty loop — an empty read here can be a GENUINELY empty placeholder,
    /// which this bridge has no way to distinguish from "SelectAll hasn't landed yet" by content
    /// alone, so this gives the queue one honest chance to drain rather than guessing from the result.
    /// **Deletion-red proof (office-agent-tools T6, 2026-08-24)**: skipped the `.uno:SelectAll`
    /// dispatch itself (not just its pump), rebuilt, reran the live `info`/`read` drill — every
    /// title/body came back "(empty title placeholder)"/"(empty)": the PLACEHOLDER WAS FOUND
    /// (position-verification, proof B's own mechanism, still intact) but its TEXT read empty — a
    /// signature specifically distinct from proof A's "(no title placeholder)" (nothing found at
    /// all). Confirms this dispatch is load-bearing on its own, not merely the pump around it.
    /// Reverted, confirmed byte-identical, reran green.
    private func readSelectedShapeTextOnDedicatedThread(_ doc: OpenDocument, agentViewId: Int32, part: Int) -> String {
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, Int32(SlidesKeyCode.f2))
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, Int32(SlidesKeyCode.f2))
        pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        postUnoCommandOnDedicatedThread(doc, ".uno:SelectAll", [:], notifyWhenFinished: true)
        pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        let text = readSelectionTextOnDedicatedThread(doc)
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, Int32(SlidesKeyCode.escape))
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, Int32(SlidesKeyCode.escape))
        return text
    }

    /// The write half of `readSelectedShapeTextOnDedicatedThread`'s own edit-mode dance: F2,
    /// select-all, then REPLACE the selection with `text` via ext-text-input — this bridge's own
    /// proven mechanism for general (non-formula) text insertion, already live-tested for Calc cells
    /// (`writeOneCellOnDedicatedThread`'s own header). `postWindowExtTextInputEvent`'s `nWindowId: 0`
    /// resolves relative to whichever view `setView` most recently asserted (confirmed by reading
    /// `postExtTextInputOnDedicatedThread`'s own existing, primary-view-only call site — the IDENTICAL
    /// LOK C call, the only difference is WHICH view this bridge asserted first) — so this internal
    /// method reaches the agent view by asserting it itself, never by adding a new wire frame: the
    /// wire's own `slidesSetText` request already carries the text end to end, and how THIS bridge
    /// fulfills it is an implementation detail, not a new door for `OfficeHelperClient` to open.
    /// `.input` then `.end` with EMPTY text — `OfficeWireFrame.extTextInputEvent`'s own header has the
    /// full "why `.end`'s own text argument is always sent empty" account (LOK ignores it either way).
    /// Exits edit mode via `Escape` afterward, same as the read path.
    /// `part` added — same pump-between-F2-and-SelectAll-and-the-real-action fix
    /// `readSelectedShapeTextOnDedicatedThread`'s own header explains; a write that types into a
    /// selection SelectAll has not actually made yet would insert alongside existing content instead
    /// of replacing it, silently.
    /// **Deletion-red proof (office-agent-tools T6, 2026-08-24)**: skipped both `postWindowExtTextInputEvent`
    /// dispatches (the actual write), rebuilt, reran
    /// `testLiveSetTextChangesOnlyTheTargetedSlideProvenBySaveAndIndependentReopen` live — slide 2's
    /// title/body read back as the ORIGINAL, untouched text ("Norma T6 Slide Two"/"second bullet"),
    /// not "CHANGED TITLE"/"CHANGED BODY", at BOTH verification layers: the independent-reopen LOK
    /// read AND the raw `unzip -p content.xml` filesystem seal (which correctly asserted "must
    /// contain the new title text" / "OLD title must be gone" and both correctly failed). Proves the
    /// write dispatch itself is load-bearing, and proves the filesystem seal genuinely detects an
    /// absence of change rather than passing by construction. Reverted, confirmed byte-identical,
    /// reran green.
    private func writeSelectedShapeTextOnDedicatedThread(_ doc: OpenDocument, agentViewId: Int32, part: Int, text: String) {
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, Int32(SlidesKeyCode.f2))
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, Int32(SlidesKeyCode.f2))
        pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        postUnoCommandOnDedicatedThread(doc, ".uno:SelectAll", [:], notifyWhenFinished: true)
        pumpDedicatedThreadForPendingDispatch(doc, viewId: agentViewId, part: part)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        doc.handle.pointee.pClass.pointee.postWindowExtTextInputEvent?(doc.handle, 0, Int32(OfficeExtTextInputType.input.rawValue), text)
        doc.handle.pointee.pClass.pointee.postWindowExtTextInputEvent?(doc.handle, 0, Int32(OfficeExtTextInputType.end.rawValue), "")
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyInput.rawValue), 0, Int32(SlidesKeyCode.escape))
        doc.handle.pointee.pClass.pointee.postKeyEvent?(doc.handle, Int32(OfficeKeyEventType.keyUp.rawValue), 0, Int32(SlidesKeyCode.escape))
    }

    private func slidesInfoOnDedicatedThread(docId: String) throws -> [OfficeSlideInfo] {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .presentation else { throw SaveError.notPresentation(docId: docId, kind: doc.kind) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)

        let partCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
        var slides: [OfficeSlideInfo] = []
        slides.reserveCapacity(partCount)
        for part in 0..<partCount {
            let name: String
            if let cName = doc.handle.pointee.pClass.pointee.getPartName?(doc.handle, Int32(part)) {
                defer { free(cName) }
                name = String(cString: cName)
            } else {
                name = "Slide \(part + 1)" // defensive fallback — getPartName should not fail for a real part index
            }
            let title: String?
            if let rect = try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: part, tabCount: 1) {
                _ = rect // positioning succeeded; the rect itself is not needed once past verification
                guard let agentViewId = documents[docId]?.agentViewId else { throw SaveError.noAgentView(docId) }
                title = readSelectedShapeTextOnDedicatedThread(doc, agentViewId: agentViewId, part: part)
            } else {
                title = nil
            }
            slides.append(OfficeSlideInfo(name: name, title: title))
        }
        // `selectSlidePlaceholderOnDedicatedThread` leaves the agent view parked mid-selection on the
        // LAST slide it touched — restore the primary view as current before returning, matching
        // `sheetsInfoOnDedicatedThread`'s own "a read-only probe must never leave things parked
        // somewhere a later call did not expect" discipline (that function's own header).
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        return slides
    }

    private func slidesReadOnDedicatedThread(docId: String, slide: Int) throws -> (title: String?, body: String?) {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .presentation else { throw SaveError.notPresentation(docId: docId, kind: doc.kind) }
        let partCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
        guard slide >= 0, slide < partCount else {
            throw SaveError.slideNotFound(docId: docId, slide: slide, slideCount: partCount)
        }

        func readField(tabCount: Int) throws -> String? {
            guard try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: slide, tabCount: tabCount) != nil else {
                return nil
            }
            guard let agentViewId = documents[docId]?.agentViewId else { throw SaveError.noAgentView(docId) }
            return readSelectedShapeTextOnDedicatedThread(doc, agentViewId: agentViewId, part: slide)
        }
        let title = try readField(tabCount: 1)
        let body = try readField(tabCount: 2)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        return (title: title, body: body)
    }

    /// office-agent-tools T6 fix round 1 (review F-0, **Critical**) — the reviewer reproduced live:
    /// `add_slide layout:"title_only"` then `set_text title:… body:…` wrote the title, refused on the
    /// missing body placeholder, and the refusal's own leading clause read "…nothing was written" —
    /// flatly false, since the title demonstrably WAS, `read` confirmed it, and the adopted tab was
    /// left dirty with an edit the caller never asked to keep, refusing every later write until the
    /// human intervened. Ruling 1 makes this reachable with no pre-check available to the agent: a
    /// slide's layout cannot be read back, so "the agent should have checked first" is not a defence.
    ///
    /// **Fix: two passes, not one.** Pass 1 verifies EVERY named field's placeholder exists —
    /// position, confirm, move on, write NOTHING — before pass 2 writes to any of them. All-or-
    /// nothing, decided before the first keystroke, mirroring T4's own `unsupportedFormulaCharacter`
    /// pure pre-validation (`sheetsSetOnDedicatedThread`'s sibling path) and this file's own
    /// `slidesManagePageOnDedicatedThread` guards (every refusal there also runs before any dispatch).
    /// This closes the reviewer's exact one-call reproduction: a `title_only` slide now refuses
    /// on pass 1 (no body placeholder) with `title` untouched, "nothing was written" true by
    /// construction because pass 1 never reaches `writeSelectedShapeTextOnDedicatedThread` at all.
    ///
    /// **The residual this does NOT close, and does not pretend to**: pass 2 still re-positions per
    /// field (a placeholder proved to exist a moment ago in pass 1 still needs a fresh Tab-cycle to
    /// reach it in pass 2 — selection is not carried between the two passes), and Tab-cycling is this
    /// file's own established flake class (`goToCellVerificationAttempts`, T3's own finding). So a
    /// transient positioning flake in pass 2 — AFTER pass 1 proved existence and AFTER an earlier
    /// field in this SAME call already wrote — remains structurally possible.
    /// **Narrowed, not closed, by the RED-full-suite follow-up**: that flake was caught in the act
    /// (the full suite's own `.partialSetFailure` on slide 2's body — task-6-report.md §9.1), the
    /// budget hypothesis for it was measured and FALSIFIED (§9.4), and `writeField` now re-posts the
    /// whole positioning once, which absorbs a single discrete loss (forced red/green, §9.5). Two
    /// consecutive losses still reach the caller — deliberately, since that is a different diagnosis.
    /// `applied` is still
    /// tracked through pass 2 for exactly this reason: the moment a pass-2 positioning failure lands
    /// with `applied` non-empty, it is wrapped in `.partialSetFailure`, mirroring
    /// `sheetsSetOnDedicatedThread`'s own identical `index > 0` wrapping for the SAME root cause (a
    /// per-field "nothing was written" description is field-scoped truth, not call-scoped truth, the
    /// instant an earlier field in this SAME call already applied) — never left to reach the caller
    /// as a bare `slidePlaceholderNotFound` whose own text would once again contradict reality.
    private func slidesSetTextOnDedicatedThread(docId: String, slide: Int, title: String?, body: String?) throws -> [String] {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .presentation else { throw SaveError.notPresentation(docId: docId, kind: doc.kind) }
        let partCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
        guard slide >= 0, slide < partCount else {
            throw SaveError.slideNotFound(docId: docId, slide: slide, slideCount: partCount)
        }

        // Pass 1 — existence only, nothing written. A slide missing EITHER named placeholder
        // refuses here, before pass 2 ever runs, so "nothing was written" stays true for every
        // refusal this pass can produce.
        if title != nil {
            guard try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: slide, tabCount: 1) != nil else {
                throw SaveError.slidePlaceholderNotFound(docId: docId, slide: slide, field: "title")
            }
        }
        if body != nil {
            guard try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: slide, tabCount: 2) != nil else {
                throw SaveError.slidePlaceholderNotFound(docId: docId, slide: slide, field: "body")
            }
        }

        // Pass 2 — both named placeholders are now KNOWN to exist; write to them.
        func writeField(tabCount: Int, text: String, fieldName: String) throws {
            // **Retry the WHOLE positioning here, and ONLY here** (office-agent-tools T6 fix round 1,
            // the RED-full-suite follow-up — see task-6-report.md §9.4/§9.5). Three things justify a
            // retry on this one call site and on no other:
            //
            // 1. **A `nil` here cannot be structural.** Pass 1 proved this exact placeholder exists,
            //    on this same dedicated thread, within this same call. **Precisely (fix round 2,
            //    re-review New-3)**: the deck is not unmutated in between — pass 2's own title write
            //    is a mutation, and saying otherwise overstated the premise. The claim that actually
            //    holds, and that is all the retry needs: a TEXT write into an existing shape neither
            //    ADDS NOR REMOVES shapes, so it cannot change whether the body placeholder exists or
            //    how many Tab presses reach it. So the retry can only ever absorb a transient loss;
            //    it is structurally incapable of masking a genuine absence, which is what makes it safe
            //    here and NOT safe in `read`/`info`/pass 1, where `nil` is genuinely ambiguous and a
            //    retry would tax every legitimate refusal for no information gain.
            // 2. **Re-posting is the only action the measurement leaves on the table.** The attempt
            //    distribution (`slidePlaceholderPositionAttempts`' own header) is bimodal: successes
            //    land at attempt 2, always; non-landings are never rescued by more pumping. The
            //    residual flake is a DISCRETE LOSS of an Escape/Tab key event or its selection
            //    callback, not a slow arrival — so a fresh Escape + fresh Tab posts is the fix shape,
            //    and a bigger pump budget provably is not.
            // 3. **It also cures the likeliest concrete mechanism.** A write leaves the shape in
            //    text-edit mode; one Escape exits edit mode but leaves the object SELECTED, and
            //    Tab-cycling from "an object is already selected" lands off-by-one and can run off
            //    the end of the slide's shape list into `nil`. The retry's own fresh Escape starts
            //    from the deselected state the mechanism assumes.
            //
            // Bounded deliberately small (2 whole positionings, not a loop) — a second consecutive
            // discrete loss is a different diagnosis (suspect the callback delivery path, not the
            // keys) and must surface as a failure rather than be absorbed silently. The evidence
            // line inside `selectSlidePlaceholderOnDedicatedThread` logs every retried attempt, so a
            // recurrence stays observable instead of becoming invisible the moment it stops failing.
            //
            // **FORCED RED/GREEN (office-agent-tools T6, 2026-08-24)** — the original flake could not
            // be reproduced on demand (2 full suite passes under saturating load never hit it), so it
            // was FORCED instead: a temporary probe made this line's first positioning return `nil`
            // for `body` only, plus a temporary flag to disable the retry below.
            //   RED  (force on, retry OFF): 6 failures, and the refusal text reproduced the ORIGINAL
            //        full-suite failure byte for byte — "body failed after title in this SAME
            //        set_text call already applied: slide 2 in <id> has no body placeholder —
            //        nothing was written." Same assertion count (6) as the real failure.
            //   GREEN (force on, retry ON):  `Executed 1 test, with 0 failures`, AND exactly ONE
            //        "re-posting Escape+Tab once" evidence line — which is what proves the force
            //        still fired and the RETRY is what absorbed it, rather than the probe having
            //        silently stopped working (a green that would otherwise prove nothing).
            // Probe reverted, tree confirmed byte-identical (`git diff` empty).
            // **Do not overclaim this**: it proves the retry absorbs a single discrete loss. That it
            // cures the ORIGINAL flake is argued from the measured attempt distribution
            // (`slidePlaceholderPositionAttempts`' header), not from a reproduced-and-cured instance.
            var positioned = try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: slide, tabCount: tabCount)
            if positioned == nil {
                FileHandle.standardError.write(Data(
                    "[LOKBridge slides] pass-2 positioning for \(fieldName) on slide \(slide) returned nil although pass 1 proved it exists — re-posting Escape+Tab once\n".utf8))
                positioned = try selectSlidePlaceholderOnDedicatedThread(docId: docId, slide: slide, tabCount: tabCount)
            }
            guard positioned != nil else {
                throw SaveError.slidePlaceholderNotFound(docId: docId, slide: slide, field: fieldName)
            }
            guard let agentViewId = documents[docId]?.agentViewId else { throw SaveError.noAgentView(docId) }
            writeSelectedShapeTextOnDedicatedThread(doc, agentViewId: agentViewId, part: slide, text: text)
        }
        var applied: [String] = []
        if let title {
            do {
                try writeField(tabCount: 1, text: title, fieldName: "title")
                applied.append("title")
            } catch let error as SaveError {
                guard applied.isEmpty else {
                    throw SaveError.partialSetFailure(reason:
                        "title failed after \(applied.joined(separator: ", ")) in this SAME set_text "
                        + "call already applied: \(error.description) Note: \"nothing was written\" "
                        + "above describes title alone, not the whole call — "
                        + "\(applied.joined(separator: ", ")) already landed.")
                }
                throw error
            }
        }
        if let body {
            do {
                try writeField(tabCount: 2, text: body, fieldName: "body")
                applied.append("body")
            } catch let error as SaveError {
                guard applied.isEmpty else {
                    throw SaveError.partialSetFailure(reason:
                        "body failed after \(applied.joined(separator: ", ")) in this SAME set_text "
                        + "call already applied: \(error.description) Note: \"nothing was written\" "
                        + "above describes body alone, not the whole call — "
                        + "\(applied.joined(separator: ", ")) already landed.")
                }
                throw error
            }
        }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        return applied
    }

    private func slidesManagePageOnDedicatedThread(docId: String, op: OfficeSlidesManagePageOp, slide: Int?, at: Int?,
                                                    to: Int?, layout: OfficeSlidesLayoutPreset?) throws -> Int {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        guard doc.kind == .presentation else { throw SaveError.notPresentation(docId: docId, kind: doc.kind) }
        let partCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
        if op == .add {
            // `at` is allowed to equal `partCount` itself (append past the last existing index) —
            // unlike `slide`/`to` elsewhere in this function, which must be a real EXISTING slide.
            // Only a genuinely out-of-range `at` (negative, impossible from the wire's own 1-based
            // `.positive()` validation; or greater than `partCount`) refuses. Reuses `.slideNotFound`
            // — its own message text is neutral enough to describe either "no such existing slide" or
            // "no such insertion point" honestly.
            if let at, at < 0 || at > partCount {
                throw SaveError.slideNotFound(docId: docId, slide: at, slideCount: partCount)
            }
            return try slidesAddOnDedicatedThread(docId: docId, doc: doc, at: at, layout: layout, partCount: partCount)
        }
        if op == .delete, let slide {
            guard slide >= 0, slide < partCount else {
                throw SaveError.slideNotFound(docId: docId, slide: slide, slideCount: partCount)
            }
            guard partCount > 1 else { throw SaveError.lastSlide(docId: docId) }
            return try slidesDeleteOnDedicatedThread(docId: docId, doc: doc, slide: slide, partCount: partCount)
        }
        if op == .reorder, let slide, let to {
            guard slide >= 0, slide < partCount else {
                throw SaveError.slideNotFound(docId: docId, slide: slide, slideCount: partCount)
            }
            // Reuses `.slideNotFound` for an out-of-range `to` too — its own message text ("no slide
            // N in docId — this presentation has M slides") is neutral about WHICH operand supplied
            // N, so it reads correctly for either.
            guard to >= 0, to < partCount else {
                throw SaveError.slideNotFound(docId: docId, slide: to, slideCount: partCount)
            }
            return try slidesReorderOnDedicatedThread(docId: docId, doc: doc, from: slide, to: to, partCount: partCount)
        }
        // Unreachable — every op (`.add`/`.delete`/`.reorder`) now has a real case above, and the
        // wire's own decode guard (`OfficeWireFrame.slidesManagePage`'s per-op paired-field contract,
        // `OfficeWireCodecTests.testSlidesManagePagePerOpFieldShapeIsRejectedAsMalformed`) guarantees
        // `.delete`'s `slide` and `.reorder`'s `slide`+`to` are never nil by the time a frame decodes
        // successfully — mirroring `sheetsManageSheetOnDedicatedThread`'s own `.rename`/`newName`
        // precondition for the identical class of already-guaranteed invariant.
        preconditionFailure("slidesManagePageOnDedicatedThread(\(op.rawValue)) reached with a nil required field — the wire decode's own invariant was violated")
    }

    /// office-agent-tools T6 fix round 1 (review F-5/F-6) — `getPartInfo`'s `hash` field
    /// (`SdrPage::GetUniqueID()`, research §7): a monotonic per-object counter, genuine OBJECT
    /// IDENTITY, unlike title/name content. Live-measured (a temporary probe, since reverted,
    /// this fix round's own commit) before this parser was written — the JSON shape is
    /// `{"masterPageCount":...,...,"name":"T6Slide1","hash":67}`: `hash` is a raw JSON NUMBER, NOT
    /// a string (unlike the type-27 callback envelope's own `viewId`, which IS a string — measured
    /// separately, never assumed to generalize from one LOK JSON payload to another). Page-level
    /// fields, `hash` included, are OMITTED entirely (not merely `null`) when the page lookup
    /// itself fails (research §3: "else `SAL_WARN`-logged and *omitted*"), so this returns `nil`
    /// rather than crashing.
    /// **Corrected, fix round 2 (re-review New-1)**: this comment used to claim a missing key
    /// "feeds this file's own verify-and-retry discipline." That was FALSE at every call site, and
    /// dangerously so — `nil` does not feed a retry, it makes the comparison VACUOUS: a permutation
    /// of `[nil, nil, nil]` equals `[nil, nil, nil]`, so `verified()` passes on attempt 1 with
    /// nothing having happened and the retry loop is never entered. The arc's own
    /// description-contradicting-code class, sitting in the doc comment of the mechanism introduced
    /// to fix a check that was blind to its own failure mode.
    /// What is true NOW: every structural call site REFUSES BEFORE DISPATCHING on any `nil` in its
    /// baseline (`SaveError.slideIdentityUnavailable`), so a decode failure can never be laundered
    /// into a false identity match — see `slidesReorderOnDedicatedThread`'s own guard for why
    /// `reorder` was the exposed one and its two siblings were not.
    private func partHashOnDedicatedThread(_ doc: OpenDocument, part: Int) -> Int? {
        guard let cInfo = doc.handle.pointee.pClass.pointee.getPartInfo?(doc.handle, Int32(part)) else {
            return nil
        }
        defer { free(cInfo) }
        guard let data = String(cString: cInfo).data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        return (object["hash"] as? NSNumber)?.intValue
    }

    /// **Verification redesign, fix round 1 (review F-5, F-6).** The original content-based check
    /// (`titleAt(to) == movingTitle`) shipped with two real defects, both closed here:
    /// - **F-5**: content is not identity. A slide `add_slide` itself creates has an EMPTY title
    ///   placeholder (live-confirmed by the reviewer), so two such slides compare `"" == ""` —
    ///   verification could pass on a deck it was specifically written to catch errors on, without
    ///   any move having happened correctly, or at all.
    /// - **F-6**: `titleAt` rides `selectSlidePlaceholderOnDedicatedThread`'s own Tab-cycling, this
    ///   file's established flake class. The baseline (`movingTitle`) was captured ONCE, before
    ///   dispatch, with no retry — a single flake there poisoned every one of the 20 post-dispatch
    ///   retry attempts (only the AFTER side ever re-read), reporting a completed mutation as a
    ///   failure and leaving an adopted document dirty.
    ///
    /// `getPartInfo`'s `hash` (`partHashOnDedicatedThread`, immediately above) resolves both:
    /// it is genuine per-object identity (never accidentally shared by two distinct pages, empty-
    /// titled or not), and it is a DIRECT positional query with no Tab-cycling involved at all — the
    /// baseline capture below cannot flake the way `titleAt`'s ever could, closing F-6 as a
    /// structural side effect of closing F-5, not a second mechanism bolted on. This does not
    /// reverse the earlier title-over-hash adjudication for the SAVE+REOPEN proof — research §7
    /// still means hash dies on reload, so that proof (this task's own non-negotiable obligation)
    /// stays content-based, in the live test suite, through `slidesRead`/`content.xml`. The two
    /// mechanisms now serve the two jobs they each actually fit: hash for in-session identity, this
    /// task's original content-based approach for reload-durable proof.
    ///
    /// Verifies the FULL expected permutation, not merely `hashAt(to) == movingHash` — closes a
    /// gap a single-position check cannot see: a wrong slide moving to a DIFFERENT position while,
    /// by coincidence, the right slide still lands at `to`. `expectedHashes` is computed directly
    /// (remove at `from`, insert at `to`) rather than simulated step-by-step through the actual
    /// `MovePage*` dispatch sequence — the same array operation regardless of how many single-step
    /// swaps produce it.
    ///
    /// office-agent-tools T6, Probe B — reachability was UNDETERMINED FROM SOURCE going in:
    /// `slides-lok-research.md` §2 "R1" found no arbitrary-index move UNO command at all — the only
    /// primitives are selection-based `MovePageUp`/`Down`/`First`/`Last`
    /// (`SlideSorterViewShell::ExecMovePage*`), and whether SELECTION (not LOK's own "current part")
    /// actually follows `setPart` in a genuinely headless session — one that never shows a Slide
    /// Sorter panel — was flagged as unknowable without a live run. **Confirmed live: it does, one
    /// step (index 1 -> index 2), verified two ways at once — see the probe test's own header
    /// (`OfficeSlidesCommandTests.testProbeInvestigatesWhetherReorderIsReachableHeadless`) for why
    /// index 1, never index 0.** Multi-step (`abs(to - from) > 1`) composes the SAME primitive
    /// repeatedly — research's own finding that `MovePageUp`/`Down` clamp safely at the document
    /// boundary rather than erroring — and IS independently live-verified
    /// (`testLiveReorderMultiStepMovesAcrossTwoPositionsProvenBySaveAndIndependentReopen`, distance
    /// 2 forwards; `testLiveReorderMultiStepMovesBackwardsProvenBySaveAndIndependentReopen`,
    /// distance 2 backwards, exercising `MovePageUp` specifically).
    ///
    /// **Dispatched on the PRIMARY view, `destroyAgentViewIfAnyOnDedicatedThread` first — NOT the
    /// agent-view isolation `selectSlidePlaceholderOnDedicatedThread`'s own READ path uses
    /// elsewhere in this file, and a deliberate decision, not an oversight.**
    /// `sheetsManageSheetOnDedicatedThread`'s own header carries the full two-round live history this
    /// borrows wholesale rather than re-earning empirically: dispatching a STRUCTURAL, page/sheet-
    /// list-level mutation (`.uno:Remove`) from the agent view produced a genuine 30s HANG whenever
    /// an agent view merely existed for that doc; dispatching `.uno:Add`/`.uno:Name` from the agent
    /// view made THEIR OWN post-dispatch verification never converge at all across repeated isolated
    /// reruns, full budget burned every time. `MovePage*` is implemented on `SlideSorterViewShell` —
    /// the SAME structural, view-shell-entangled class as those three commands, arguably more so —
    /// so this starts from the already-proven-safe shape rather than re-discovering the hang live.
    /// **Sheets' own disclosed residual carries over unchanged, not closed here either**: primary-
    /// view `setPart` can move an ADOPTED document's own visible primary-view slide selection —
    /// disclosed on all three structural verbs' own tool description as of fix round 1 (review F-8),
    /// not `reorder` alone. See that function's own header and task-4-report.md's own accounting.
    private func slidesReorderOnDedicatedThread(docId: String, doc: OpenDocument, from: Int, to: Int,
                                                 partCount: Int) throws -> Int {
        if from == to { return partCount } // no-op — nothing to move, nothing to verify

        var beforeHashes: [Int?] = []
        beforeHashes.reserveCapacity(partCount)
        for part in 0..<partCount {
            beforeHashes.append(partHashOnDedicatedThread(doc, part: part))
        }
        // **fix round 2, re-review New-1 (Important) — the `nil == nil` false-pass, closed.**
        // `verified()` below compares `hashesNow() == expectedHashes`. If `getPartInfo` yields `nil`
        // for every part, a PERMUTATION of `[nil, nil, nil]` is still `[nil, nil, nil]`, so
        // `verified()` returns true on attempt 1 with no move needing to have happened — `reorder`
        // reports success unconditionally and the retry loop is never entered. That is precisely the
        // silently-no-op-verb-reporting-success outcome spec ruling 3 called unacceptable, and unlike
        // its two siblings `reorder` has no independent guard to catch it: `delete_slide` is saved by
        // its `newPartCount == partCount - 1` count check and `add_slide` by `newSlideIsGenuinelyNew()`,
        // but `reorder` never changes the part count at all.
        // **Not a defect this fix round introduced** — the previous `titleAt(to) == movingTitle` had
        // the identical hole at HIGHER reachability (a Tab-cycle `nil` is the observed flake class; a
        // `getPartInfo` `nil` needs a page-lookup failure). It is closed here rather than inherited.
        // Refuses BEFORE `destroyAgentViewIfAnyOnDedicatedThread`/`setPart`/any dispatch, matching
        // this file's own refuse-before-mutating posture (`slidesManagePageOnDedicatedThread`'s
        // guards) — so the error can honestly say nothing was changed.
        //
        // **RED PROOF for the hash mechanism itself (fix round 2, folded into New-1)** — the
        // re-review's point was sharp: "the live suite passes, which shows `getPartInfo` works in
        // this build; it does not show the check can FAIL." Three temporary probes, run on
        // `testLiveReorderMultiStepMovesAcrossTwoPositionsProvenBySaveAndIndependentReopen`,
        // each reverted (tree confirmed byte-identical, `git diff` empty):
        //
        //   R1  hash forced nil, THIS GUARD REMOVED, move dispatch skipped
        //       -> 5 failures, and `XCTAssertTrue(reorderResult.ok)` PASSED — `reorder` reported
        //          SUCCESS on a document that never moved. New-1's false-pass, reproduced live.
        //   R2  hash forced nil, this guard PRESENT
        //       -> 6 failures, `ok: false`, "could not read per-slide identity … so reorder could
        //          not be verified — nothing was changed." The guard converts R1's silent success
        //          into an honest refusal.
        //   R3  REAL hash, this guard present, move dispatch skipped
        //       -> 6 failures, `ok: false`, "wrote to reorder(1 -> 3) … but could not confirm".
        //          The hash comparison genuinely DETECTS a no-op move — it is load-bearing, not
        //          vacuously passing.
        //
        // The failure COUNT is itself the discriminator, not incidental: R1 has one fewer failure
        // than R2/R3 precisely because the `reorderResult.ok` assertion passed in R1 and failed in
        // the other two. That is the difference between "silently reported success" and "correctly
        // refused", visible in the count alone.
        guard !beforeHashes.contains(where: { $0 == nil }) else {
            throw SaveError.slideIdentityUnavailable(docId: docId, verb: "reorder")
        }

        var expectedHashes = beforeHashes
        let movingHash = expectedHashes.remove(at: from)
        expectedHashes.insert(movingHash, at: to)

        destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(from))
        pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: from)

        let steps = to - from
        let command = steps > 0 ? ".uno:MovePageDown" : ".uno:MovePageUp"
        for _ in 0..<abs(steps) {
            postUnoCommandOnDedicatedThread(doc, command, [:], notifyWhenFinished: true)
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: from)
        }

        func hashesNow() -> [Int?] {
            let newPartCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
            guard newPartCount == partCount else { return [] }
            return (0..<newPartCount).map { partHashOnDedicatedThread(doc, part: $0) }
        }
        func verified() -> Bool { hashesNow() == expectedHashes }

        var ok = verified()
        var attempts = 1
        while !ok, attempts < Self.slidesManageVerificationAttempts {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: to)
            ok = verified()
            attempts += 1
        }
        if attempts > 1 {
            FileHandle.standardError.write(Data(
                "[LOKBridge slides] reorder needed \(attempts) attempt(s) before verification succeeded (or the budget was exhausted)\n".utf8))
        }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        guard ok else {
            throw SaveError.writeVerificationFailed(docId: docId, address: "reorder(\(from + 1) -> \(to + 1))")
        }
        return partCount
    }

    /// office-agent-tools T6 — `delete_slide`'s real mechanism. `.uno:DeletePage` (research's own
    /// slot table, `sd/sdi/sdraw.sdi:661`) takes NO args at all — selection-based, exactly like
    /// `MovePage*` — so this rides `slidesReorderOnDedicatedThread`'s own just-proven shape wholesale
    /// rather than re-deriving it: same primary-view dispatch (`destroyAgentViewIfAnyOnDedicatedThread`
    /// first, NOT the agent-view isolation the read path uses — see that function's own header for
    /// the full two-round sheets precedent this borrows), same `notifyWhenFinished: true` (controller
    /// instruction #1), same disclosed residual (primary-view `setPart` can move an adopted
    /// document's own visible slide selection — disclosed on all three structural verbs as of fix
    /// round 1, review F-8).
    ///
    /// **Verification is NOT just count-minus-one, and — fix round 1, review F-5/R10's own note —
    /// not content-based either anymore.** Research's own finding: `DeleteActualPage()`
    /// (`drviews4.cxx:99-142`) swallows its own failures — a dispatch that silently no-ops would still
    /// need to be caught, and a raw count check cannot distinguish "the RIGHT slide was deleted" from
    /// "some OTHER slide was deleted and the count still dropped by one." The original title-based
    /// survivor check shared reorder's own F-5 exposure: two surviving slides with equal (including
    /// empty) titles could false-match a wrong-slide deletion, and title-reading's own Tab-cycling
    /// carried reorder's own F-6 baseline-flake risk. Same fix, same reasoning as
    /// `slidesReorderOnDedicatedThread`'s own header — see that function's `partHashOnDedicatedThread`
    /// doc comment for the full account: this captures every SURVIVING slide's own HASH before
    /// dispatch (never the deleted slide's — that one is expected to disappear), then asserts the
    /// exact same survivor hash sequence, in the same order, comes back after.
    private func slidesDeleteOnDedicatedThread(docId: String, doc: OpenDocument, slide: Int, partCount: Int) throws -> Int {
        var survivorHashes: [Int?] = []
        survivorHashes.reserveCapacity(partCount - 1)
        for part in 0..<partCount where part != slide {
            survivorHashes.append(partHashOnDedicatedThread(doc, part: part))
        }

        // fix round 2, re-review New-1 — **for symmetry, not because this verb is exposed the way
        // `reorder` is.** `delete_slide` already has an independent guard `reorder` lacks: the
        // `newPartCount == partCount - 1` length check in `hashesNow()` below means an all-`nil`
        // survivor list still has to come back at the RIGHT LENGTH, so a total no-op cannot pass.
        // What an all-`nil` set WOULD still hide is a wrong-slide deletion (right count, wrong
        // victim) — the exact discrimination the hash switch was made to gain. Refusing before any
        // dispatch keeps the two structural verbs' contracts identical rather than leaving a reader
        // to work out which one is guarded and why.
        guard !survivorHashes.contains(where: { $0 == nil }) else {
            throw SaveError.slideIdentityUnavailable(docId: docId, verb: "delete_slide")
        }

        destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(slide))
        pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: slide)
        postUnoCommandOnDedicatedThread(doc, ".uno:DeletePage", [:], notifyWhenFinished: true)
        pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: max(0, slide - 1))

        func hashesNow() -> [Int?] {
            let newPartCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
            guard newPartCount == partCount - 1 else { return [] } // sentinel length mismatch — `verified()` below never mistakes this for a real survivor list
            return (0..<newPartCount).map { partHashOnDedicatedThread(doc, part: $0) }
        }
        func verified() -> Bool { hashesNow() == survivorHashes }

        var ok = verified()
        var attempts = 1
        while !ok, attempts < Self.slidesManageVerificationAttempts {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: max(0, slide - 1))
            ok = verified()
            attempts += 1
        }
        if attempts > 1 {
            FileHandle.standardError.write(Data(
                "[LOKBridge slides] delete needed \(attempts) attempt(s) before verification succeeded (or the budget was exhausted)\n".utf8))
        }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        guard ok else {
            throw SaveError.writeVerificationFailed(docId: docId, address: "delete_slide(\(slide + 1))")
        }
        return partCount - 1
    }

    /// office-agent-tools T6 — `add_slide`'s real mechanism. Coordinator instruction: `setPart`-then-
    /// relative `InsertPage`, NEVER `InsertPos` (`SfxUInt16Item`, research's own semantics — 0-based?
    /// 1-based? relative-to-current? — left explicitly UNRESOLVED, "flagged for live-testing rather
    /// than guessed" and then never guessed). This dispatches `.uno:InsertPage` completely BARE
    /// (`[:]`, no args at all — `PageName`/`WhatLayout`/`IsPageBack`/`IsPageObj`/`InsertPos` are ALL
    /// optional per the slot table) after `setPart`ing the PREDECESSOR position, relying on research's
    /// own citation that insert acts "relative to `DrawViewShell::GetActualPage()`" — **live-confirmed
    /// by this function's own test to land immediately AFTER the current part**, not before, not
    /// always-at-the-end (`OfficeSlidesCommandTests.testLiveAddSlideInsertsAtEveryRequestedPosition`).
    /// Position 0 (new slide becomes the very first) has no real predecessor to `setPart` onto, so
    /// this inserts after position 0 as usual and then dispatches `.uno:MovePageFirst` as a correction
    /// step — relying on a SECOND live-confirmed fact, that a freshly inserted page becomes the
    /// current/selected part automatically, so `MovePageFirst`'s own selection-based targeting needs
    /// no extra `setPart` to reach it.
    ///
    /// Same primary-view dispatch as `reorder`/`delete_slide` (`destroyAgentViewIfAnyOnDedicatedThread`
    /// first — see `slidesReorderOnDedicatedThread`'s own header for the full sheets precedent this
    /// still rides), same `notifyWhenFinished: true`, same disclosed residual (all three structural
    /// verbs as of fix round 1, review F-8).
    ///
    /// **Layout assignment: dispatched, live-drilled, correction on two claims — fix round 1, review
    /// F-4.** Ruling 1 (`slides-lok-research.md` §3) means LOK exposes NO layout read-back API — this
    /// IN-PROCESS function cannot self-verify `.uno:AssignLayout` the way it self-verifies position,
    /// and that much was always true. What was NOT true, and has been corrected: this function's own
    /// prior header claimed "no re-read even in principle," overstating ruling 1 into a place it does
    /// not reach — a SAVED-BYTES seal (this task's own established `content.xml` filesystem-seal
    /// technique, not a LOK API) DOES observe layout's effect, live-confirmed by
    /// `testLiveAddSlideWithLayoutBlankStripsPlaceholdersProvenBySavedBytes`: `layout:
    /// "blank"` on a fresh slide produces a `read`ing of `title: nil` ("no title placeholder" — the
    /// placeholder was never created, distinct from an EMPTY one) where every other layout's default
    /// new-slide shape produces `title: ""` (placeholder present, empty) — the nil/empty distinction
    /// this bridge documents elsewhere as load-bearing, now doing double duty as the layout
    /// discriminator. The prior header also claimed this "type":"long" tag had been observed live
    /// with "no failure mode... absence of an error/dialog/crash" — false; no dispatch had run at
    /// all before this fix round's own drill. It has now actually run, and the claim is true.
    /// `WhatPage`/`WhatLayout` (`SfxUInt32Item` per the slot table, `sd/sdi/sdraw.sdi:2137-2138`) use
    /// JSON type `"long"` — an educated guess (parallel to `sheets`' own `Index`, a `SfxUInt16Item`,
    /// resolved live to `"unsigned short"`) that the live drill now actually confirms rather than
    /// merely licenses: `blank` demonstrably strips the new slide's own placeholder frames, exactly
    /// `SdPage::SetAutoLayout`'s documented behavior for empty placeholders (research §4).
    ///
    /// **Position verification, fix round 1 (review F-5/F-6) — hash-based, not content-based, for the
    /// same reasons `slidesReorderOnDedicatedThread`'s own header explains in full** (that function's
    /// `partHashOnDedicatedThread` doc comment is the canonical account, not repeated here): captures
    /// every EXISTING slide's own hash before dispatch, then — skipping exactly the new slide's own
    /// expected resting index — asserts the same survivor hash sequence, in order, comes back after.
    /// The mirror image of `slidesDeleteOnDedicatedThread`'s own "skip the deleted index" check.
    /// **One check `add_slide` gets that `delete_slide`/`reorder` structurally cannot**: the NEW
    /// slide's own hash must be ABSENT from the before-set entirely — proving it is a genuinely new
    /// object LOK just created, not the same object duplicated or an existing one silently moved into
    /// place, a distinction content-based verification could never have drawn (a duplicated object
    /// could carry duplicated, matching content) but object identity draws for free.
    private func slidesAddOnDedicatedThread(docId: String, doc: OpenDocument, at: Int?,
                                             layout: OfficeSlidesLayoutPreset?, partCount: Int) throws -> Int {
        var beforeHashes: [Int?] = []
        beforeHashes.reserveCapacity(partCount)
        for part in 0..<partCount {
            beforeHashes.append(partHashOnDedicatedThread(doc, part: part))
        }

        // Omitted `at` -> append at the end (one past the last valid index, `partCount`). Clamped
        // defensively (`OfficeCommandConsumer`'s own `at` decode is the real range guard; this is
        // belt-and-braces against calling this function directly with something out of range).
        let targetIndex = max(0, min(at ?? partCount, partCount))
        let predecessorIndex = max(0, targetIndex == 0 ? 0 : targetIndex - 1)

        destroyAgentViewIfAnyOnDedicatedThread(doc, docId: docId)
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(predecessorIndex))
        pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: predecessorIndex)
        postUnoCommandOnDedicatedThread(doc, ".uno:InsertPage", [:], notifyWhenFinished: true)
        pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: targetIndex)

        if targetIndex == 0 {
            postUnoCommandOnDedicatedThread(doc, ".uno:MovePageFirst", [:], notifyWhenFinished: true)
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: 0)
        }

        if let layout {
            let args: [String: Any] = [
                "WhatPage": ["type": "long", "value": targetIndex],
                "WhatLayout": ["type": "long", "value": layout.autoLayoutValue],
            ]
            postUnoCommandOnDedicatedThread(doc, ".uno:AssignLayout", args, notifyWhenFinished: true)
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: targetIndex)
        }

        func survivorsNow() -> [Int?] {
            let newPartCount = Int(doc.handle.pointee.pClass.pointee.getParts?(doc.handle) ?? 0)
            guard newPartCount == partCount + 1 else { return [] }
            var hashes: [Int?] = []
            hashes.reserveCapacity(partCount)
            for part in 0..<newPartCount where part != targetIndex {
                hashes.append(partHashOnDedicatedThread(doc, part: part))
            }
            return hashes
        }
        func newSlideIsGenuinelyNew() -> Bool {
            guard let newHash = partHashOnDedicatedThread(doc, part: targetIndex) else { return false }
            return !beforeHashes.contains(where: { $0 == newHash })
        }
        func verified() -> Bool { survivorsNow() == beforeHashes && newSlideIsGenuinelyNew() }

        var ok = verified()
        var attempts = 1
        while !ok, attempts < Self.slidesManageVerificationAttempts {
            pumpDedicatedThreadForPendingDispatch(doc, viewId: doc.viewId, part: targetIndex)
            ok = verified()
            attempts += 1
        }
        if attempts > 1 {
            FileHandle.standardError.write(Data(
                "[LOKBridge slides] add needed \(attempts) attempt(s) before verification succeeded (or the budget was exhausted)\n".utf8))
        }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, doc.viewId)
        guard ok else {
            throw SaveError.writeVerificationFailed(docId: docId, address: "add_slide(at \(targetIndex + 1))")
        }
        return partCount + 1
    }

    /// office-agent-tools T4 — the shared JSON-args UNO dispatch this task's own three new sheet-
    /// management commands use. NOT applied retroactively to `.uno:GoToCell`'s own existing inline
    /// dispatch (`selectionTextOnDedicatedThread`) — that call is already proven and unrelated to
    /// this task's own scope; this helper exists only for the code THIS task adds.
    ///
    /// **`notifyWhenFinished` — controller finding, `docs-lok-research.md` L4 (2026-08-24), added for
    /// office-agent-tools T6's own NEW call sites only.** `doc_postUnoCommand` injects
    /// `SynchronMode=false` (`desktop/source/lib/init.cxx`), but `SfxDispatchController_Impl::dispatch`
    /// (`sfx2/source/control/unoctitm.cxx:655-657`) OVERRIDES it to `SfxCallMode::SYNCHRON` whenever a
    /// listener exists — and a listener exists exactly when `bNotifyWhenFinished` is `true`. Defaults
    /// `false` so this file's own TEN pre-existing call sites (all still passing the literal `false`
    /// this comment used to hardcode) are BYTE-IDENTICAL in behavior — retrofitting them is a separate,
    /// deliberately out-of-scope change the controller is queuing on its own terms, `.uno:Save`/
    /// `.uno:Undo` in particular having their own fire-and-forget reasoning that needs its own
    /// re-examination, not a blanket flip. **Caveat this file inherits, not resolves**: the DISPATCH
    /// (the Execute handler actually running) is provably synchronous under `true`; whether any
    /// RESULTING LOK CALLBACK is flushed before this call returns is NOT proven from source
    /// (`DispatchResultListener::dispatchFinished` still *enqueues* via `mpCallbackFlushHandlers`) — a
    /// state actually CHANGED by the command (e.g. what `.uno:SelectAll` selects) is safe to read
    /// synchronously afterward; a PUSH NOTIFICATION about that change is a separate question this flag
    /// does not settle. Verify by re-read regardless, exactly as this bridge already does everywhere
    /// else.
    private func postUnoCommandOnDedicatedThread(_ doc: OpenDocument, _ command: String, _ args: [String: Any],
                                                 notifyWhenFinished: Bool = false) {
        guard let data = try? JSONSerialization.data(withJSONObject: args),
              let argsString = String(data: data, encoding: .utf8) else {
            return // unreachable for this file's own String/Int-only payloads — never throws, matching GoToCell's own fire-and-forget posture on a build failure
        }
        command.withCString { commandPtr in
            argsString.withCString { argsPtr in
                doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, argsPtr, notifyWhenFinished)
            }
        }
    }

    // MARK: - Callback translation

    /// Runs on `thread` (see `lokBridgeDocumentCallback`'s own header). Translates the handful of
    /// LOK callback types Stage A's vocabulary covers into `OfficeDocumentEvent`; anything else is
    /// silently ignored — not every LOK callback type has Stage-A meaning (bold/italic-shaped
    /// `LOK_CALLBACK_STATE_CHANGED` payloads, cursor movement, etc.), and ignoring an
    /// unrecognized-but-harmless callback is correct here (contrast the WIRE protocol's own
    /// refuse-never-ignore rule, which is about never leaving a REQUEST unanswered — there is no
    /// request here to leave hanging).
    fileprivate func handleCallback(docId: String, type: Int32, payload: String) {
        // Task 4, debt #1 (T3 concern #8: the callback parsers had NEVER seen a real LOK firing
        // — this is the log line a live test reads back, via the helper's own captured stderr, to
        // prove they finally have). Unconditional, not test-only instrumentation: a cheap, one-line
        // stderr trace of every callback this helper's whole lifetime ever receives, useful for
        // production debugging too (LOK callback traffic is otherwise entirely invisible). `type`
        // is the raw LOK integer, not a name — `LOKCallbackType`'s eight named constants above are
        // the only ones this bridge currently interprets (the count has grown with every task since
        // this line was written for two; the `switch` immediately below is the live list); an
        // unrecognized type is still logged here, just not turned into an OfficeDocumentEvent.
        FileHandle.standardError.write(Data("[LOKBridge raw callback] docId=\(docId) type=\(type) payload=\(payload)\n".utf8))
        let event: OfficeDocumentEvent?
        switch type {
        case LOKCallbackType.invalidateTiles:
            event = OfficeDocumentEvent.parseInvalidateTiles(payload)
        case LOKCallbackType.invalidateVisibleCursor:
            event = OfficeDocumentEvent.parseCaretRect(payload)
        case LOKCallbackType.textSelection:
            event = OfficeDocumentEvent.parseTextSelection(payload)
        case LOKCallbackType.textSelectionStart:
            event = OfficeDocumentEvent.parseTextSelectionStart(payload)
        case LOKCallbackType.textSelectionEnd:
            event = OfficeDocumentEvent.parseTextSelectionEnd(payload)
        case LOKCallbackType.stateChanged:
            event = OfficeDocumentEvent.parseModifiedStatus(payload)
        case LOKCallbackType.cellCursor:
            event = OfficeDocumentEvent.parseCellCursor(payload)
        case LOKCallbackType.cellFormula:
            event = OfficeDocumentEvent.parseCellFormula(payload)
        case LOKCallbackType.graphicSelection:
            // office-agent-tools T6 — internal state only, never an `OfficeDocumentEvent` (nothing
            // outside this bridge needs it, and Stage A's wire vocabulary is not the right place to
            // grow a case for a signal that never crosses the app<->helper wire). Write-back, not an
            // in-place mutation — `OpenDocument` is a struct (see this type's own `documents`
            // dictionary), the same get/mutate/write-back idiom `createAgentViewOnDedicatedThread`
            // already uses for its own per-docId state. Defensive fallback only — a live drill found
            // this bridge's own two-view design always fires `.graphicViewSelection` instead (below)
            // by the time any slides mechanism runs; never observed live.
            if var doc = documents[docId] {
                doc.lastGraphicSelectionRectTwips = Self.parseGraphicSelectionRect(payload)
                documents[docId] = doc
            }
            event = nil
        case LOKCallbackType.graphicViewSelection:
            // office-agent-tools T6 — the ONE actually observed live (`.graphicSelection`'s own
            // header has the full account). `viewId` is checked against THIS docId's own agent view
            // before accepting the rect — a firing for the PRIMARY view (a human clicking around an
            // adopted tab while this mechanism runs) must never be mistaken for this bridge's own
            // agent-view selection landing; silently ignored, not merely unfiltered-and-hoped-safe.
            // **Deletion-red proof (office-agent-tools T6, 2026-08-24)**: inverted to `viewId !=
            // agentViewId` (accept only what this filter is supposed to reject), rebuilt, reran
            // `testLiveSlidesInfoReadsRealTitlesFromThreeSlideFixture` live — every title/body came
            // back "(no title placeholder)"/"(empty)", the exact "nothing was ever recorded"
            // signature, not some unrelated symptom. Reverted, confirmed byte-identical
            // (`git diff --stat`), reran green. This filter is load-bearing, not incidentally
            // passing.
            if var doc = documents[docId], let agentViewId = doc.agentViewId,
               let (viewId, selection) = Self.parseGraphicViewSelectionEnvelope(payload),
               viewId == agentViewId {
                doc.lastGraphicSelectionRectTwips = Self.parseGraphicSelectionRect(selection)
                documents[docId] = doc
            }
            event = nil
        default:
            event = nil
        }
        guard let event else { return }
        onEvent?(docId, event)
    }

    /// Parses `LOK_CALLBACK_GRAPHIC_SELECTION`'s raw payload: `"x, y, width, height, angle, {...}"`
    /// — mirrors `OfficeDocumentEvent.parseCellCursor`'s own comma-split shape exactly (this bridge's
    /// own established parsing idiom for a LOK rect-shaped callback), taking only the first four
    /// fields; `angle` and the optional trailing JSON properties are not needed for verification and
    /// are silently ignored, never validated. An empty selection's own payload shape was not
    /// characterized live before this was written — `nil` on anything that does not parse as at
    /// least four comma-separated integers, which a genuine empty-selection firing (if this callback
    /// ever produces one) would also hit, safely: `selectSlidePlaceholderOnDedicatedThread` treats
    /// "no rect observed" as "nothing new was selected" either way.
    private static func parseGraphicSelectionRect(_ payload: String) -> OfficeTwipsRect? {
        let fields = payload.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard fields.count >= 4,
              let x = Int64(fields[0]), let y = Int64(fields[1]),
              let width = Int64(fields[2]), let height = Int64(fields[3]) else {
            return nil
        }
        return OfficeTwipsRect(x: x, y: y, width: width, height: height)
    }

    /// Parses `LOK_CALLBACK_GRAPHIC_VIEW_SELECTION`'s own JSON envelope — confirmed live to be
    /// `{"viewId": "<id>", "part": "<n>", "mode": "<n>", "selection": "<the bare
    /// x,y,width,height,angle,{...} string>"}` (the header's own doc comment names only `viewId`/
    /// `selection`; `part`/`mode` are real fields this live drill also observed, silently ignored
    /// here — this bridge only needs the two the header promises). `viewId` decodes as a STRING
    /// ("1"), not a JSON number — `Int32(...)` on it, never a numeric cast.
    private static func parseGraphicViewSelectionEnvelope(_ payload: String) -> (viewId: Int32, selection: String)? {
        guard let data = payload.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let viewIdString = object["viewId"] as? String, let viewId = Int32(viewIdString),
              let selection = object["selection"] as? String else {
            return nil
        }
        return (viewId, selection)
    }

    // The two raw-payload parsers formerly lived here as `private static func`s. Moved to
    // `OfficeDocumentEvent.parseInvalidateTiles`/`.parseModifiedStatus` (`OfficeWire.swift`) —
    // this type (`type: tool`) is not importable by any test bundle, so a parser kept here would
    // have zero test coverage, permanently, no matter how the rest of the wire surface is
    // exercised. See that file for the full doc comments (carried over verbatim) and
    // `OfficeWireCodecTests` for the table test covering both.

    private static func extractBuildId(fromVersionJSON json: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let buildId = object["BuildId"] as? String, !buildId.isEmpty else {
            return nil
        }
        return buildId
    }

    /// A per-helper-instance-unique writable directory under `--state-path` — never inside the
    /// signed, read-only app bundle (the bootstraprc trap: `UserInstallation` defaults to
    /// `$ORIGIN/..`, resolving INSIDE the bundle). `file://` URL form, not a bare path — LOK's own
    /// `lok_init_2` rejects `user_profile_url[0] == '/'` (`LibreOfficeKitInit.h:306-313`).
    ///
    /// **T3 review F4 (Minor)**: sweeps every PRE-EXISTING `lok-profile-*` directory under
    /// `statePath` before minting this boot's own — measured, unbounded growth otherwise (3 boots
    /// against one stable `--state-path` left 3 separate directories; `_exit` means no `atexit`
    /// ever runs to clean one up on the way out, by design — carry #3). Safe because a
    /// `--state-path` is one-live-helper-at-a-time by construction (the socket bind is exclusive to
    /// it: `OfficeHelperServer.start()`'s unlink-before-bind, mirrored by
    /// `OfficeHelperSupervisor`'s own pre-spawn unlink), so ANY `lok-profile-*` directory already
    /// present the moment a NEW boot reaches this call can only belong to a now-dead PRIOR instance
    /// of this same helper, never a live one — safe to discard wholesale rather than trying to
    /// detect and reuse-if-clean. Keeps the per-boot UUID (not a fixed, reused name) — parallel
    /// test runs each mint their own scratch `--state-path` already
    /// (`OfficeHelperLiveTests.makeScratchDirectory()`), so this sweep never races a DIFFERENT
    /// helper's own profile directory; it only ever cleans up after itself.
    private static func prepareUserProfile(statePath: URL) throws -> String {
        Self.sweepStaleProfileDirectories(statePath: statePath)
        let profileDir = statePath.appendingPathComponent("lok-profile-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
        try Self.disableDocumentLockFile(profileDir: profileDir)
        return URL(fileURLWithPath: profileDir.path, isDirectory: true).absoluteString
    }

    /// Office Stage B Task 2 (live-gate finding, not a brief line item) — pre-seeds this boot's
    /// fresh profile with `UseDocumentOOoLockFile=false`, LO's own registry property (under
    /// `org.openoffice.Office.Common/Misc`) for the `.~lock.<name>#` sidecar marker.
    ///
    /// **This does NOT fix Task 2's live dirty-tracking bug — it is kept purely on its own merits**
    /// (below). The real bug, root-caused live and confirmed by THREE independent methods, is a
    /// SEPARATE, unresolved finding reported to the dispatcher as NEEDS_CONTEXT (task-2-report.md
    /// has the full writeup): a raw wire probe (`open` -> `tileRequest` -> `debugEdit`, direct
    /// against `NormaOfficeHelper`, one variable moved at a time) isolates the break to
    /// **sandboxed + document-path-outside-`--state-path`** — every combination of unsandboxed, or
    /// sandboxed-with-the-document-copied-inside-the-fence, fires `.uno:ModifiedStatus=true`
    /// correctly; sandboxed-and-outside (how every real document is ever opened — the fence is
    /// `--state-path` only, by T1's own invariant) never does. Two locking-knob theories were tried
    /// against that broken cell and BOTH disproven (`UseDocumentOOoLockFile=false` alone: no
    /// change; adding `UseDocumentSystemFileLocking=false` too: still no change — reverted, see
    /// below). The type=8 `STATE_CHANGED` cascade diffed clean between a working and the broken
    /// capture: `.uno:EditDoc` — LO's own "switch to edit mode" toggle — fires `true` in the
    /// working cell and never does in the broken one, alongside `.uno:Paste`/`.uno:Undo`/a large
    /// block of insert-verb commands present ONLY when working. An independent `chmod 444` probe
    /// (zero sandboxing, zero `--state-path` involved at all) reproduces the identical signature
    /// (`ModifiedStatus` only ever `false`, `EditDoc` only ever `false`) — proving the mechanism is
    /// general "LO opened this document read-only," not sandbox-specific: `paste()` still reports
    /// success (it mutates the in-memory model) but is a silent no-op against a read-only medium,
    /// so the modified flag can never flip. Likely mechanism: LO's `SfxMedium` decides writability
    /// by attempting a write-classed open on the document's OWN path at load time (separate from
    /// this helper's own `saveAs`, which always targets `<state-path>/saves/` and is unaffected);
    /// under the sandbox that open is denied for any path outside `--state-path`, so every real
    /// document loads read-only. Two decisions were named, not chosen, above this task's own
    /// authority: widen `office-helper.sb`'s fence, or redesign the open path to copy into
    /// `--state-path` and place back out (`saveAs` already did exactly this shape for the WRITE
    /// side).
    ///
    /// **Resolved by Office Stage B Task 2b: the redesign, never the fence.** `office-helper.sb`'s
    /// write fence is UNCHANGED (still `--state-path` only) — the app now stages every document
    /// into it BEFORE the wire `open` this method receives (`OfficeRuntime.stageDocument`, called
    /// from `openAndDispatch`, a real `copyfile(3)` off the caller's real path). This bridge's own
    /// `path` field on `OpenDocument` (see `openOnDedicatedThread`) is therefore always an
    /// already-staged, already-writable path from Task 2b onward — the READ side is now exactly as
    /// symmetric with the WRITE side (`saveAs`-to-`saves/`) as this paragraph once wished it were.
    ///
    /// **Why `UseDocumentOOoLockFile=false` stays despite not being the fix**: independently
    /// justified — no sidecar-file litter beside the user's real documents; T3's own
    /// `testOpeningADocumentInAWritableDirectoryLeavesNoLockFileBeside` now holds for a stronger
    /// reason (LO no longer attempts the file, rather than merely "hasn't yet"); and Norma's own
    /// architecture is single-writer per document (one helper, one dedicated LOK thread, no
    /// multi-process contention LO's own advisory lock is protecting against here). Its sibling
    /// `UseDocumentSystemFileLocking=false` was tried and reverted — no independent justification
    /// once it failed to explain the bug, and disabling OS-level advisory locking is a real behavior
    /// change not worth carrying without one.
    ///
    /// Property name and its enclosing `Misc` group path confirmed empirically against the vendored
    /// tree's own schema (`Resources/registry/main.xcd`, component `org.openoffice.Office.Common`)
    /// and against a live-booted helper's own `user/registrymodifications.xcu` (same path, same
    /// `oor:items`/`item`/`prop` shape reproduced below) — not guessed from generic LO docs.
    ///
    /// Written directly to `<profileDir>/user/registrymodifications.xcu` BEFORE `lok_init_2` reads
    /// this profile for the first time — LO treats this file as its own persisted overlay and folds
    /// it in on boot, the same file it would otherwise create itself on first run (verified: a
    /// normal boot's own `user/registrymodifications.xcu` already carries other `Misc`-group
    /// entries in this exact shape, e.g. `FirstRun`).
    private static func disableDocumentLockFile(profileDir: URL) throws {
        let userDir = profileDir.appendingPathComponent("user", isDirectory: true)
        try FileManager.default.createDirectory(at: userDir, withIntermediateDirectories: true)
        let xcu = """
        <?xml version="1.0" encoding="UTF-8"?>
        <oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseDocumentOOoLockFile" oor:op="fuse"><value>false</value></prop></item>
        </oor:items>
        """
        try xcu.write(
            to: userDir.appendingPathComponent("registrymodifications.xcu"), atomically: true, encoding: .utf8)
    }

    /// Best-effort — a sweep failure (permissions, a concurrent deletion, an unreadable entry, ...)
    /// must never fail this boot: `prepareUserProfile` mints its own fresh directory regardless of
    /// whether this succeeds, so the worst case is one more undeleted leftover, never a boot
    /// failure.
    private static func sweepStaleProfileDirectories(statePath: URL) {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: statePath, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent.hasPrefix("lok-profile-") {
            try? FileManager.default.removeItem(at: entry)
        }
    }

    /// Office Stage B Task 2b (I3) — same best-effort posture as `sweepStaleProfileDirectories`
    /// immediately above (a failure here must never fail this boot: `docs/`/`saves/` are both
    /// lazily recreated by whichever side next needs them — `OfficeRuntime.stageDocument` and this
    /// bridge's own `saveAsOnDedicatedThread` respectively — so the worst case is one more
    /// undeleted leftover, never a boot failure). Removes the DIRECTORIES themselves, not just their
    /// contents — simpler than enumerating and filtering entries the way the profile sweep does,
    /// since every child of either directory is transient by construction; nothing here needs a
    /// prefix check the way `lok-profile-*` does (that one shares `statePath` with unrelated
    /// siblings this sweep must not touch — `docs`/`saves` are exact, known names, not a family of
    /// UUID-suffixed ones).
    private static func sweepStaleDocumentDirectories(statePath: URL) {
        try? FileManager.default.removeItem(at: statePath.appendingPathComponent("docs", isDirectory: true))
        try? FileManager.default.removeItem(at: statePath.appendingPathComponent("saves", isDirectory: true))
    }

    /// Writes a generated `fonts.conf` under `--state-path` and points `FONTCONFIG_FILE` at it —
    /// carry #5.
    ///
    /// **T3 review F1 (Important) — rewritten from the original shape.** The original version
    /// `<include>`d the vendored product-set's WHOLE `Resources/fontconfig/fonts.conf` — LO's own
    /// stock config, whose own `<dir>` list scans `/System/Library/Assets` (measured: 0 bytes,
    /// empty on this OS version) AND `/System/Library/AssetsV2` (measured: **56GB** — Apple's
    /// Continuity/Handoff/on-demand font-asset cache; nothing an office document ever needs).
    /// Measured cost of that scan: a COLD boot (brand-new `--state-path`, no fontconfig cache yet)
    /// took **20.2-20.6s** and wrote a **~78MB / ~72,000-file** cache under `--state-path`; WARM
    /// (same machine/session, cache already primed) took ~7.3s. Under concurrent XCTest load,
    /// 24-56s cold against the (then-)30.0s handshake budget — enough to plausibly exhaust
    /// `OfficeHelperSupervisor`'s 3 attempts on a loaded machine's first-ever launch and report
    /// `.helperUnavailable` before the helper ever got to serve a document.
    ///
    /// Fixed at the root rather than only by raising the timeout: this method now writes its OWN
    /// explicit `<dir>` list — the three real macOS font directories below, PLUS the vendor's own
    /// bundled-font directory (`Resources/fonts/truetype` — where the Carlito/Liberation TTFs the
    /// aliases below resolve to actually live in this tree; listed explicitly here rather than
    /// assumed auto-registered by LO's own runtime, so this override does not depend on an
    /// unverified LO-internal mechanism) — and `<include>`s ONLY the vendored
    /// `Resources/fontconfig/conf.d` DIRECTORY, bypassing the top-level file (and its
    /// AssetsV2-scanning `<dir>` list) entirely while keeping 100% of its alias/hinting/
    /// antialiasing RULES — `conf.d/30-metric-aliases.conf`'s Calibri->Carlito, Cambria->Caladea,
    /// Arial->Liberation Sans, etc — unmodified, in their original load order (these are
    /// declarative XML `<alias>`/`<match>` rules; which directories get SCANNED for glyph data is
    /// an orthogonal concern from which alias RULES get loaded — verified, not just argued, below).
    /// The 4 small, static, non-path-dependent alias blocks the top-level file ALSO carried
    /// (deprecated "mono"/"sans serif"/"sans"/"system ui" spellings -> their canonical CSS names)
    /// are inlined directly in the template below rather than pulled in via a second `<include>` —
    /// free either way, costs nothing, one less moving part to reason about.
    ///
    /// **Verified, not just argued** (the review's own condition for either fix shape): re-measured
    /// cold boot against THIS config — real compiled `NormaOfficeHelper`, fresh `--state-path` per
    /// sample, `--lok-root` at the vendor tree, timed from process spawn to the socket file
    /// appearing (this file's boot-sequencing invariant: LOK finishes loading before the socket
    /// ever binds — see `main.swift`'s own header — so that window is exactly what
    /// `OfficeHelperSupervisor`'s handshake budget has to absorb). AC power, Low Power Mode off,
    /// display kept awake (`caffeinate -u`) for every sample, to rule out the display-asleep
    /// measurement-artifact class this repo has hit before (see memory: CEF 30fps cap). Three
    /// samples, this machine's first LOK boot in several hours (session-cold, not reboot-cold) then
    /// two back-to-back: **2.371s, 1.403s, 1.404s** — against the old config's measured
    /// **20.2-20.6s cold / ~7.3s warm**. Each sample's own `<state-path>/fontconfig/cache` landed at
    /// **6.4MB / 6 files**, not the old **~78MB / ~72,000 files** (fix-round-1 section of
    /// task-3-report.md has the full transcript). Also re-ran the six-format matrix: `gate.ods`
    /// prints `size=26775x13005` — the EXACT width the ALWAYS-ON fontconfig override produced
    /// before this rewrite (the one fixture that override was shown, in the original T3 pass, to
    /// perturb versus a no-override baseline — a real, disclosed font-substitution effect, not a
    /// bug), zero delta — and the pixel-hash tripwire's `with-env` hash
    /// (`0062d124af16cfd301fed9444b7b882e5eeb683e956e2154cf2903b0eddfd77c`) reproduced byte-for-byte
    /// against the same pre-fix value too. Both are stronger than "compatible": the metric-compatible
    /// alias chain didn't just survive this rewrite, it produced IDENTICAL output.
    ///
    /// `<cachedir>` stays pinned under `--state-path`, never the user's real `~/.fontconfig` or
    /// `/usr/local/var/cache/fontconfig` (the hard rule: never touch the user's real paths) — true
    /// before this fix and unchanged by it.
    private static func configureFontconfig(installRoot: URL, statePath: URL) throws {
        let fontconfigDir = statePath.appendingPathComponent("fontconfig", isDirectory: true)
        let cacheDir = fontconfigDir.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        let bundledConfD = installRoot.appendingPathComponent("Resources/fontconfig/conf.d")
        let bundledFontsDir = installRoot.appendingPathComponent("Resources/fonts/truetype")
        let confPath = fontconfigDir.appendingPathComponent("fonts.conf")
        let homeFonts = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Fonts")

        let xml = """
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
        <fontconfig>
        \t<cachedir>\(cacheDir.path)</cachedir>
        \t<dir>/System/Library/Fonts</dir>
        \t<dir>/Library/Fonts</dir>
        \t<dir>\(homeFonts)</dir>
        \t<dir>\(bundledFontsDir.path)</dir>
        \t<include ignore_missing="yes">\(bundledConfD.path)</include>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>mono</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>monospace</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>sans serif</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>sans</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>system ui</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>system-ui</string></edit>
        \t</match>
        </fontconfig>
        """
        try xml.write(to: confPath, atomically: true, encoding: .utf8)
        setenv("FONTCONFIG_FILE", confPath.path, 1)
    }
}
