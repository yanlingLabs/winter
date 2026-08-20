import Foundation

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
    static let stateChanged: Int32 = 8      // LibreOfficeKitEnums.h:229 (LOK_CALLBACK_STATE_CHANGED)
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

    /// Office Stage B Task 2 — a `saveAs` (or, DEBUG-only, a `debugEdit`) operation named a `docId`
    /// this bridge has no open handle for, asked to save a document whose format `OfficeSaveFormat`
    /// does not cover, or hit a real `saveAs` failure. Never a crash — `OfficeHelperServer`
    /// translates every case into a `saveFailed` reply, the same "the helper always survives"
    /// posture `LoadError`/`TileError` already have.
    enum SaveError: Error, CustomStringConvertible {
        case docNotOpen(String)
        case unsupportedFormat(String)
        case saveAsFailed(String)
        var description: String {
            switch self {
            case .docNotOpen(let docId): return "save requested for a docId that is not open: \(docId)"
            case .unsupportedFormat(let ext): return "saving is not supported for this document's format (\(ext))"
            case .saveAsFailed(let reason): return reason
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
        /// **Office Stage B Task 2b** — the exact path this document was `documentLoad`ed from.
        /// Per this task's own contract, that is now ALWAYS a staged, inside-fence path (the app's
        /// `OfficeRuntime.openAndDispatch` copies the real document in and sends the wire `open`
        /// this staged path) — this bridge never learns, and never needs to learn, the real one.
        /// `saveOnDedicatedThread`'s own `.uno:Save` branch saves IN PLACE to exactly this path.
        let path: String
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
        Self.sweepStaleDocumentDirectories(statePath: statePath)

        // Office Stage B Task 2 — `<state-path>/saves/`, ahead of anything that could render into
        // it. `withIntermediateDirectories: true` also tolerates a `--state-path` this bridge is
        // booting into for the first time (mirrors `OfficeHelperServer.start()`'s own
        // `createDirectory` call for `statePath` itself, one level up).
        let savesDirectory = statePath.appendingPathComponent("saves", isDirectory: true)
        try FileManager.default.createDirectory(at: savesDirectory, withIntermediateDirectories: true)
        self.savesDirectory = savesDirectory

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
    func saveAs(docId: String, seq: UInt64) throws -> String {
        try thread.sync { try self.saveAsOnDedicatedThread(docId: docId, seq: seq) }
    }

    #if DEBUG
    /// Office Stage B Task 2 — **DEBUG-only, and REMOVED BY TASK 4.** Selects a cell then pastes
    /// `text` into it (`debugEditOnDedicatedThread`'s own header has the corrected mechanism and
    /// the live-test trace that forced the correction away from `.uno:EnterString`) — see
    /// `OfficeWireFrame.debugEdit`'s own header for why this exists and what it stands in for.
    /// Throws on a docId this bridge has no handle for, OR on `paste()` itself reporting failure
    /// (unlike `postUnoCommand`, `paste` DOES return a synchronous success/failure `bool`).
    func debugEdit(docId: String, text: String) throws {
        try thread.sync { try self.debugEditOnDedicatedThread(docId: docId, text: text) }
    }
    #endif

    // MARK: - Dedicated-thread-only implementation

    private func openOnDedicatedThread(docId: String, path: String) throws -> OfficeDocumentMetadata {
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

        let typeInt = rawDoc.pointee.pClass.pointee.getDocumentType?(rawDoc) ?? -1
        let kind = OfficeDocumentKind(lokDocumentType: typeInt)
        let parts = Int(rawDoc.pointee.pClass.pointee.getParts?(rawDoc) ?? 0)
        var width: Int = 0
        var height: Int = 0
        rawDoc.pointee.pClass.pointee.getDocumentSize?(rawDoc, &width, &height)

        // Office Stage B Task 2 — captured once, here, from the path this document was opened
        // with. `NSString.pathExtension` strips the leading dot ("xlsx", not ".xlsx") — exactly
        // what `OfficeSaveFormat.init?(pathExtension:)` expects.
        let saveFormat = OfficeSaveFormat(pathExtension: (path as NSString).pathExtension)
        documents[docId] = OpenDocument(handle: rawDoc, context: unmanagedContext,
                                          tileRenderer: TileRenderer(handle: rawDoc), saveFormat: saveFormat,
                                          path: path)
        return OfficeDocumentMetadata(
            type: kind, parts: parts,
            sizeTwips: OfficeDocumentSize(widthTwips: Int64(width), heightTwips: Int64(height)))
    }

    private func closeOnDedicatedThread(docId: String) {
        guard let doc = documents.removeValue(forKey: docId) else { return }
        doc.handle.pointee.pClass.pointee.destroy?(doc.handle)
        doc.context.release()
    }

    private func paintTileOnDedicatedThread(docId: String, key: TileKey) throws -> TilePaintResult {
        guard let doc = documents[docId] else { throw TileError.docNotOpen(docId) }
        let (generation, pixels) = try doc.tileRenderer.paint(key: key)
        return TilePaintResult(generation: generation, pixels: pixels,
                                width: TileMath.tilePixelSize, height: TileMath.tilePixelSize)
    }

    /// Office Stage B Task 2b — a LOCAL stat fingerprint, mirroring `AppShell`'s `OfficeFileStat`
    /// in spirit (size + full-nanosecond mtime — `st_mtimespec` is nanosecond already; a
    /// `Date`/`FileAttributeKey`-based comparison rounds that away, same reasoning as the AppShell
    /// original) but redeclared HERE rather than shared: this target (`NormaOfficeHelper`) is a
    /// separate, sandboxed executable from `AppShell` and does not — and must not — link against
    /// it. No `inode` field: unlike `AppShell`'s copy, nothing here ever compares across a
    /// `rename(2)` (this is a same-path before/after check on one dedicated thread), so identity
    /// across a rename was never this type's problem to solve.
    private struct LocalFileFingerprint: Equatable {
        let size: Int64
        let modifiedSeconds: Int64
        let modifiedNanoseconds: Int64
    }

    private func localFileFingerprint(atPath path: String) -> LocalFileFingerprint? {
        var info = stat()
        guard stat(path, &info) == 0 else { return nil }
        return LocalFileFingerprint(size: Int64(info.st_size),
                                    modifiedSeconds: Int64(info.st_mtimespec.tv_sec),
                                    modifiedNanoseconds: Int64(info.st_mtimespec.tv_nsec))
    }

    /// Office Stage B Task 2b — **EMPIRICAL PROBE, temporary**: dispatches `.uno:Save` against the
    /// staged (writable) document and reports whether the staged file's own bytes visibly changed
    /// WITHIN this synchronous call, on this dedicated thread, with no hop of any kind between the
    /// `postUnoCommand` call and the re-stat — the exact ordering guarantee `task-2b-report.md`'s
    /// save-mechanism decision needs evidence for (does `.uno:Save` complete synchronously in this
    /// headless embedding, or could `.saved` reply before the write actually lands). Returns `true`
    /// on a detected change, `false` when the file did not visibly change (`.uno:Save` was a no-op,
    /// dispatched async, or failed silently) — never throws for a "did not change" outcome, only
    /// for a docId this bridge has no handle for.
    private func attemptUnoSaveOnDedicatedThread(docId: String) throws -> Bool {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        let before = localFileFingerprint(atPath: doc.path)
        ".uno:Save".withCString { commandPtr in
            doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, nil, false)
        }
        let after = localFileFingerprint(atPath: doc.path)
        return after != before
    }

    /// Office Stage B Task 2 — renders `docId`'s current in-memory state to
    /// `<state-path>/saves/<docId>-<seq>.<ext>`, in the document's OWN format (`OpenDocument
    /// .saveFormat`, captured at open). Returns the temp file's path on success; the APP — not this
    /// bridge, and not `OfficeHelperServer` — is what places it onto the real document path (see
    /// `OfficeWireFrame.saved`'s own header). Throws, never traps: a bad `docId`, an unsupported
    /// format, or a genuine `saveAs` failure are all reported, and this bridge (and the document
    /// it was asked to save) survive every one of them exactly like a failed `paintTile`/`open`.
    private func saveAsOnDedicatedThread(docId: String, seq: UInt64) throws -> String {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        // Office Stage B Task 2b — try `.uno:Save` first: LOK saves the currently-loaded STAGED
        // document IN PLACE, exactly the operation a real user's own ⌘S performs, and the door
        // Collabora Online's own interactive-save path uses. `task-2b-report.md` has the live
        // evidence this decision rests on. Falls back to the ORIGINAL `saveAs`-to-`saves/`
        // mechanism below, unchanged, whenever `.uno:Save` does not visibly change the staged file
        // — never assumed to have worked, always checked (`attemptUnoSaveOnDedicatedThread`'s own
        // before/after stat comparison).
        if try attemptUnoSaveOnDedicatedThread(docId: docId) {
            return doc.path
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
        return destination.path
    }

    #if DEBUG
    /// Office Stage B Task 2 — **DEBUG-only, and REMOVED BY TASK 4.**
    ///
    /// **Corrected, live-test-caught, twice (task-2-report.md has the full transcript both
    /// times).** The brief named `.uno:EnterString`; dispatching it (via `postUnoCommand`) against
    /// this task's own live fixtures popped a real LOK window callback — an "Information" dialog
    /// this headless door has no way to answer — and the WHOLE HELPER PROCESS then exited with
    /// "Unspecified Application Error." A first theory (the fixture's own stray
    /// `<workbookProtection/>` XML) was tested and DISPROVEN empirically: stripping that element
    /// from a scratch copy and verifying the rebuilt archive genuinely lacked it changed nothing —
    /// the SAME dialog, the SAME crash. Whatever `.uno:EnterString`'s own dispatch path does in
    /// this headless LOK embedding (no real window system behind it), it is not safe to call.
    /// **Plausible (not confirmed) reinterpretation, found later while root-causing the dirty-
    /// tracking bug this same task hit (`disableDocumentLockFile`'s header)**: every fixture this
    /// door was ever exercised against was opened sandboxed and outside `--state-path`, exactly the
    /// condition now shown to make LOK load a document read-only. An "Information" dialog popping
    /// the instant an edit command dispatches is consistent with a read-only-document refusal
    /// prompt, not necessarily an `EnterString`-specific defect — not re-tested against a
    /// known-writable (inside-fence) document to confirm, so this stays a note for the next reader
    /// rather than a claim; `paste()` remains the right choice regardless, since it never surfaces
    /// UI either way.
    ///
    /// Uses `LibreOfficeKitDocumentClass.paste` instead — a direct C-API data-insertion call, not a
    /// UNO-dispatch through the SfxDispatcher/UI layer `.uno:EnterString` goes through, and the
    /// SAME mechanism a real clipboard paste uses. `.uno:GoToCell` still selects the target cell
    /// first (moves the cursor away from whatever a fixture's own default cursor, e.g. A1, happens
    /// to hold) — `paste` inserts at the CURRENT selection, exactly like `.uno:EnterString` would
    /// have.
    private func debugEditOnDedicatedThread(docId: String, text: String) throws {
        guard let doc = documents[docId] else { throw SaveError.docNotOpen(docId) }
        // Ruled out as a red herring while root-causing the dirty-tracking bug (task-2-report.md):
        // disabling GoToCell entirely reproduced the SAME missing-modified-callback failure, which
        // is what pointed the search away from this dispatch and at the sandboxed document-outside-
        // fence condition instead (see `disableDocumentLockFile`'s header for the read-only-medium
        // finding that condition actually root-caused to). GoToCell itself was never the problem —
        // restored unconditionally.
        let gotoPayload: [String: Any] = ["ToPoint": ["type": "string", "value": "D10"]]
        if let gotoData = try? JSONSerialization.data(withJSONObject: gotoPayload),
           let gotoString = String(data: gotoData, encoding: .utf8) {
            ".uno:GoToCell".withCString { commandPtr in
                gotoString.withCString { argsPtr in
                    doc.handle.pointee.pClass.pointee.postUnoCommand?(doc.handle, commandPtr, argsPtr, false)
                }
            }
        }
        let textBytes = Array(text.utf8)
        let pasted = "text/plain;charset=utf-8".withCString { mimePtr -> Bool in
            textBytes.withUnsafeBufferPointer { buffer -> Bool in
                guard let base = buffer.baseAddress else { return false }
                return base.withMemoryRebound(to: CChar.self, capacity: buffer.count) { charPtr in
                    doc.handle.pointee.pClass.pointee.paste?(doc.handle, mimePtr, charPtr, buffer.count) ?? false
                }
            }
        }
        guard pasted else {
            throw SaveError.saveAsFailed("debugEdit: paste() reported failure")
        }
    }
    #endif

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
        case LOKCallbackType.stateChanged:
            event = OfficeDocumentEvent.parseModifiedStatus(payload)
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
