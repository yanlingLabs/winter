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
        return URL(fileURLWithPath: profileDir.path, isDirectory: true).absoluteString
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
