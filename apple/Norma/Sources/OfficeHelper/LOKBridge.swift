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

private enum LOKTileMode {
    static let rgba: Int32 = 0   // LibreOfficeKitEnums.h:40 (LOK_TILEMODE_RGBA)
    static let bgra: Int32 = 1   // LibreOfficeKitEnums.h:41 (LOK_TILEMODE_BGRA)
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
/// exit-time `SwDLL::~SwDLL` SIGSEGV during LIFO C++ static teardown). Calling `destroy` would
/// invite exactly that crash outside of process exit, for no benefit (the process is going to
/// `_exit` anyway). Only DOCUMENTS get destroyed, on `close`.
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
    }

    private let thread: LOKDedicatedThread
    private let kit: UnsafeMutablePointer<LibreOfficeKit>
    let lokVersionString: String
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

        documents[docId] = OpenDocument(handle: rawDoc, context: unmanagedContext)
        return OfficeDocumentMetadata(
            type: kind, parts: parts,
            sizeTwips: OfficeDocumentSize(widthTwips: Int64(width), heightTwips: Int64(height)))
    }

    private func closeOnDedicatedThread(docId: String) {
        guard let doc = documents.removeValue(forKey: docId) else { return }
        doc.handle.pointee.pClass.pointee.destroy?(doc.handle)
        doc.context.release()
    }

    /// The regression tripwire (carry #6) — NOT the real tile pipeline (Task 4 owns
    /// `TileRenderer`/IOSurfaces/caching/generations). A minimal, direct `paintTile` passthrough,
    /// exact spike parameters, so a live test can hash a fixed buffer against the gate's pinned
    /// table. Canonicalizes BGRA -> RGBA in place exactly like the spike (main.c:176-185) before
    /// returning, so the hash is comparable to the gate table regardless of what `getTileMode`
    /// reports.
    func debugPaintTile(docId: String, canvasWidth: Int32, canvasHeight: Int32,
                         tilePosX: Int32, tilePosY: Int32, tileWidth: Int32, tileHeight: Int32) -> Data? {
        thread.sync { () -> Data? in
            guard let doc = self.documents[docId] else { return nil }
            var buffer = [UInt8](repeating: 0, count: Int(canvasWidth) * Int(canvasHeight) * 4)
            buffer.withUnsafeMutableBufferPointer { ptr in
                doc.handle.pointee.pClass.pointee.paintTile?(
                    doc.handle, ptr.baseAddress, canvasWidth, canvasHeight, tilePosX, tilePosY, tileWidth, tileHeight)
            }
            let tileMode = doc.handle.pointee.pClass.pointee.getTileMode?(doc.handle) ?? LOKTileMode.rgba
            if tileMode == LOKTileMode.bgra {
                var index = 0
                while index + 2 < buffer.count {
                    buffer.swapAt(index, index + 2)
                    index += 4
                }
            }
            return Data(buffer)
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
    private static func prepareUserProfile(statePath: URL) throws -> String {
        let profileDir = statePath.appendingPathComponent("lok-profile-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
        return URL(fileURLWithPath: profileDir.path, isDirectory: true).absoluteString
    }

    /// Writes a generated `fonts.conf` under `--state-path` and points `FONTCONFIG_FILE` at it —
    /// carry #5. `<include>`s the vendored product-set's OWN `Resources/fontconfig/fonts.conf`
    /// (so LO's bundled fonts — Liberation etc, referenced by that file's own `<dir>` entries —
    /// stay discoverable) and then REASSERTS the three macOS system font directories explicitly,
    /// unconditionally.
    ///
    /// **Empirical note, worth recording**: the svp probe's own report claimed the bundled
    /// `fonts.conf` ships with ZERO macOS `<dir>` entries. The copy actually vendored in THIS
    /// worktree already lists all three (`/System/Library/Fonts`, `/Library/Fonts`,
    /// `~/Library/Fonts`) plus more (`/System/Library/Assets{,V2}`) — see the task-3 report for
    /// the full comparison and a hypothesis for the discrepancy. This override makes the guarantee
    /// true regardless of which fact is current or survives a future re-vendor: it does not rely
    /// on the bundled file's own content being any particular thing.
    ///
    /// `<cachedir>` is pinned under `--state-path` too — the bundled conf's own cachedirs point at
    /// `/usr/local/var/cache/fontconfig` and `~/.fontconfig`, outside this helper's scratch
    /// sandbox (the hard rule: never touch the user's real paths). fontconfig tolerates an
    /// unwritable/nonexistent cachedir by skipping it, so the bundled conf's own (unreachable in a
    /// sandboxed test run) entries riding along via `<include>` are harmless, not a hazard.
    private static func configureFontconfig(installRoot: URL, statePath: URL) throws {
        let fontconfigDir = statePath.appendingPathComponent("fontconfig", isDirectory: true)
        let cacheDir = fontconfigDir.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)

        let bundledConf = installRoot.appendingPathComponent("Resources/fontconfig/fonts.conf")
        let confPath = fontconfigDir.appendingPathComponent("fonts.conf")
        let homeFonts = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Fonts")

        let xml = """
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
        <fontconfig>
        \t<cachedir>\(cacheDir.path)</cachedir>
        \t<include ignore_missing="yes">\(bundledConf.path)</include>
        \t<dir>/System/Library/Fonts</dir>
        \t<dir>/Library/Fonts</dir>
        \t<dir>\(homeFonts)</dir>
        </fontconfig>
        """
        try xml.write(to: confPath, atomically: true, encoding: .utf8)
        setenv("FONTCONFIG_FILE", confPath.path, 1)
    }
}
