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
/// `PanelEditorTab.swift`'s `officeReadWriteExtensions` is a deliberate, hand-mirrored SECOND copy of
/// these six cases — the boundary `officeDocumentIsReadOnlyFormat` draws. **Adding a case here does
/// NOT automatically widen that copy or lift its read-only gates** — no compile-time tripwire can
/// exist across this module boundary; the drift signal is empirical instead:
/// `OfficeHelperLiveTests.testWidenedFormatsXlsmAndOdgFailSaveWithUnsupportedFormatTheDriftTripwire
/// ForOfficeReadWriteExtensions` goes RED the day `xlsm`/`odg` gain a case here, because the `saveAs`
/// it currently asserts fails would start succeeding. If you add a case for a DIFFERENT extension,
/// that test says nothing — update `officeReadWriteExtensions` by hand, in the same change.
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
    /// **All three OOXML formats fall back to their ODF sibling — not only xlsx/docx, the two the
    /// vendor investigation actually reproduced a crash for** (`ooxml-export-investigation.md`'s
    /// own verdict: SIGABRT in sal's `FullTextEncodingData` — `libsal_textenclo.dylib` is lazily
    /// `dlopen`'d BY NAME for full charset tables, first touched by the xlsx export filter's font
    /// code, and is simply ABSENT from this trimmed 59-dylib product-set; docx "fails less
    /// reliably, mechanism unconfirmed"; pptx export worked in that investigation's one pass).
    /// That mechanism is CONTENT-DEPENDENT and PATH-DEPENDENT, not merely format-dependent — one
    /// clean pptx export proves the trace workload's own font code path was avoided ONCE, for ONE
    /// document, not that every real pptx a user ever autosaves will avoid it too. Autosave calls
    /// this on an UNATTENDED, REPEATING timer against whatever the user happens to be editing, for
    /// as long as a session stays dirty — the cost of guessing wrong here is not "one failed
    /// export," it is "the crash-protection feature crashes the helper," silently, exactly while a
    /// document is dirty (the one moment autosave exists to protect). Given that asymmetry, this
    /// table treats "OOXML" as one category, uniformly, rather than trusting a single investigation
    /// run as exhaustive proof for the one format it happened to come back clean on. Documented as
    /// a deliberate, disclosed judgment call for the task 7 review — see task-7-report.md; relaxing
    /// pptx back to native once it has its OWN dedicated crash-investigation (not a side note in
    /// xlsx's) is a reasonable, narrow follow-up, not a correction of this one.
    ///
    /// `.odt`/`.ods`/`.odp` are excluded on different, solid ground, not by exemption: they are
    /// already ODF, so a sidecar `saveAs` for them never reaches the OOXML export filter code path
    /// at all — there is no unproven mechanism here to guess about.
    var autosaveFormat: (format: OfficeSaveFormat, isODFFallback: Bool) {
        switch self {
        case .odt, .ods, .odp: return (self, false)
        case .docx: return (.odt, true)
        case .xlsx: return (.ods, true)
        case .pptx: return (.odp, true)
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

        var description: String {
            switch self {
            case .installPathMissing(let path): return "LibreOffice install root not found at \(path)"
            case .initFailed(let installPath): return "lok_init_2 returned NULL for installPath \(installPath)"
            case .versionInfoUnavailable: return "getVersionInfo() did not return a usable BuildId"
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
        var description: String {
            switch self {
            case .docNotOpen(let docId): return "save requested for a docId that is not open: \(docId)"
            case .unsupportedFormat(let ext): return "saving is not supported for this document's format (\(ext))"
            case .saveAsFailed(let reason): return reason
            case .pasteFailed(let docId): return "paste() failed for docId: \(docId)"
            case .agentViewAlreadyExists(let docId): return "docId already has an agent view: \(docId)"
            case .noAgentView(let docId): return "docId has no agent view: \(docId)"
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

    // MARK: - Office Stage B Task 10 — the CFB release blocker

    /// The on-disk signature of every OLE2/Compound File Binary document — the container format
    /// underneath every legacy MS Office binary format (`.doc`/`.xls`/`.ppt`). Content-sniffed, not
    /// path-sniffed, because the crash this closes is ITSELF content-sniffed: LOK's own importer
    /// dispatches off the BYTES, never the extension
    /// (`OfficeHelperLiveTests.testKnownLimitationLegacyBinaryImportDoesNotOpenInThisVendorBuild`'s
    /// own `legacy-doc.doc`/`legacy-ppt.ppt` — a direct libc `exit()` deep inside LO's C++ import
    /// path that bypasses Swift's `try`/`catch` entirely, taking every OTHER open document's
    /// unsaved edits down with the one shared helper). A user's genuine `.doc` renamed `.docx` (or
    /// any CFB file placed under a modern extension, accidentally or not) hits that identical path
    /// today, unless intercepted here, first.
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
    /// `OfficeHelperLiveTests.testKnownLimitationLegacyBinaryImportDoesNotOpenInThisVendorBuild` opens
    /// all three through THIS exact helper. Application routing being closed is a fact about
    /// `PanelEditorTab.swift`, not about this test file, which calls `spawnLiveHelper()` directly and
    /// bypasses that routing entirely — the allowlist is LOAD-BEARING TODAY, precisely, not inert:
    ///   - Drop `xls` → CFB bytes under `.xls` would hit THIS gate's own refusal instead of reaching
    ///     `documentLoad` → the test's pinned failure reason ("loadComponentFromURL returned an empty
    ///     reference") would no longer match → RED.
    ///   - Drop `doc`/`ppt` → a clean gate refusal means the helper SURVIVES the open — but that
    ///     test's own "helper-dies case" asserts the process DIES for exactly these two fixtures
    ///     (`XCTAssertTrue(died, …)`) → surviving instead of dying → RED.
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
        if let agentViewId = doc.agentViewId {
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
    /// `ext` from `OfficeSaveFormat.autosaveFormat` (native for already-ODF documents, the ODF
    /// sibling for every OOXML one — see that property's own header for why all three, not just
    /// the two the vendor investigation reproduced a crash for).
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
        let viewId = doc.handle.pointee.pClass.pointee.createView?(doc.handle) ?? -1
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
        guard let agentViewId = doc.agentViewId else { throw SaveError.noAgentView(docId) }
        doc.handle.pointee.pClass.pointee.setView?(doc.handle, agentViewId)
        if doc.kind != .text {
            doc.handle.pointee.pClass.pointee.setPart?(doc.handle, Int32(truncatingIfNeeded: part))
        }
        doc.handle.pointee.pClass.pointee.postKeyEvent?(
            doc.handle, Int32(type.rawValue), Int32(truncatingIfNeeded: charCode), Int32(truncatingIfNeeded: keyCode))
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
        // is the raw LOK integer, not a name — `LOKCallbackType`'s two named constants above are
        // the only ones this bridge currently interprets; an unrecognized type is still logged
        // here, just not turned into an OfficeDocumentEvent below.
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
        default:
            event = nil
        }
        guard let event else { return }
        onEvent?(docId, event)
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
