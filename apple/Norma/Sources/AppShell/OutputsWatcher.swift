import Foundation
import CoreServices

/// app-shell T8 (spec §3, post-review YAGNI ruling): ONE recursive FSEvents watcher on
/// `<normaHome>/outputs/` for the app's WHOLE LIFETIME — no per-session watcher bookkeeping, no
/// activity-bounded scheme, and the "files missed between polls" limitation a poll-based design
/// would have simply disappears. Constructed once in `AppDelegate.boot()` and handed to every
/// consumer that needs it (`ShellSessionHost`, this task; the floating corner panel, T9) — never a
/// second instance.
///
/// **THE SEAM.** Everything below `handleRawPaths` is PURE and unit-tested with temp-dir fixtures —
/// no real FSEventStream involved (`sessionIdsTouched`/`listOutputFiles` in OutputsBox.swift).
/// `handleRawPaths` itself is the thin orchestration a test CAN still drive directly (simulate "one
/// FSEvents tick" by calling it with a raw path list) without ever registering a real OS-level
/// stream. Only `start()`'s `FSEventStreamCreate`/`FSEventStreamStart` call is genuinely
/// live-gated — the same "the pure decision is unit-tested, the OS plumbing is live-gated" split
/// `SessionFeed`'s own connect-loop and `AppWindowController`'s occlusion observer already use
/// elsewhere in this app. `AppDelegate.boot()` gates the real `start()` call behind
/// `!isRunningUnitTests`, the same posture as the daemon supervisor's real spawn / Sparkle's
/// updater construction — a bare `boot()` call from the dozens of existing tests must register no
/// real FSEventStream.
///
/// **VANISH-TOLERANT.** `store.deleteSession` `rmSync`s a session's whole outdir out from under
/// this watcher (SP2's own shape) — `listOutputFiles`'s `FileManager.enumerator` returning `nil` for
/// a missing directory (never throwing) is what keeps `handleRawPaths` from ever wedging or
/// crashing on a path that no longer exists by the time it re-lists; `OutputsWatcherTests` pins this
/// at the orchestration level (create, diff, delete, re-diff the SAME path — never a real stream).
@MainActor
final class OutputsWatcher {
    /// Fired once per session touched by a batch of raw FSEvents paths — the session's CURRENT file
    /// listing (full paths as strings), not an incremental patch: re-scanning the touched session's
    /// own outdir at callback time is simpler than tracking prior state across ticks, and gives
    /// every consumer an always-consistent answer even if it missed an earlier tick.
    ///
    /// **Two consumers, one callback — COMPOSE, never replace.** The box (this task) filters to the
    /// session it's showing; the floating corner panel (T9) filters to sessions NOT currently shown.
    /// A second wirer must capture whatever `onChange` already holds and call through it, the same
    /// "compose, don't replace" discipline `SessionFeed.onEvent`/`AppModel`'s own hook composition
    /// already keep in this app — see `ShellSessionHost.init`'s own composition for the pattern T9's
    /// wiring should copy.
    var onChange: ((_ sessionId: String, _ files: [String]) -> Void)?

    /// `AppProfile.normaHome` at construction — profile-resolved by the CALLER (`AppDelegate.boot()`
    /// passes `AppProfile.normaHome` explicitly), never re-read here; this class has no opinion
    /// about dev vs dist, only about a path it was handed.
    private let home: String
    private let fileManager: FileManager
    private var stream: FSEventStreamRef?

    init(home: String, fileManager: FileManager = .default) {
        self.home = home
        self.fileManager = fileManager
    }

    deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    /// Registers the real OS-level watch on `outputsRootPath(home:)`. LIVE-GATED per this file's own
    /// doc comment — idempotent (a second call is a no-op) so a careless double-call from a future
    /// caller can't leak a second stream.
    func start() {
        guard stream == nil else { return }
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, clientCallBackInfo, _, eventPaths, _, _ in
            guard let clientCallBackInfo else { return }
            let watcher = Unmanaged<OutputsWatcher>.fromOpaque(clientCallBackInfo).takeUnretainedValue()
            let cfArray = unsafeBitCast(eventPaths, to: CFArray.self)
            guard let paths = cfArray as? [String] else { return }
            Task { @MainActor in watcher.handleRawPaths(paths) }
        }
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        )
        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context,
            [outputsRootPath(home: home)] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.3, flags
        ) else {
            OrbDebug.log("OutputsWatcher: FSEventStreamCreate failed for \(outputsRootPath(home: home))")
            return
        }
        stream = created
        FSEventStreamSetDispatchQueue(created, DispatchQueue.main)
        FSEventStreamStart(created)
    }

    /// Torn down at `applicationWillTerminate` — not load-bearing (the process is exiting either
    /// way) but tidy, and it makes `start()` re-callable rather than permanently spent.
    func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }

    /// The orchestration step between a raw FSEvents callback (or a test simulating one) and
    /// `onChange`: extract every session touched by this batch, then re-list and report each. Not
    /// `private` — `OutputsWatcherTests` drives this directly as its "one FSEvents tick" seam.
    func handleRawPaths(_ paths: [String]) {
        let root = outputsRootPath(home: home)
        for sessionId in Self.sessionIdsTouched(outputsRoot: root, changedPaths: paths) {
            let files = listOutputFiles(home: home, sessionId: sessionId, fileManager: fileManager)
            onChange?(sessionId, files.map(\.path))
        }
    }

    // MARK: - PURE diffing (unit-tested; no FSEventStream, no live filesystem state required)

    /// `path → sessionId`: the first path component under `outputsRoot` is the sessionId
    /// (`outputsSessionPath`'s own shape — `<normaHome>/outputs/<sessionId>/…`). A raw path outside
    /// `outputsRoot`, or equal to `outputsRoot` itself (no session component at all), contributes
    /// nothing. Pure string manipulation only — no filesystem access, so this half needs no
    /// temp-dir fixture and no real path to even exist.
    ///
    /// DELIBERATELY plain string operations — no `URL(...).standardizedFileURL`. That call turns
    /// out to be existence-dependent in a way that breaks exactly the vanish-tolerant case this
    /// method exists for: verified empirically, `standardizedFileURL` canonicalizes an EXISTING
    /// `/private/var/…` directory back to its symlinked `/var/…` form but leaves a NON-existent leaf
    /// path (e.g. a just-deleted session's file) untouched — so a root and a path built from the
    /// exact same string can silently stop sharing a prefix the moment the directory in question is
    /// removed, which is precisely the scenario under test. `home`/`outputsRoot` are always built
    /// from ONE string (`AppProfile.normaHome`, threaded through unmodified), so there is nothing
    /// here for symlink resolution to usefully do in production either — real FSEvents paths are
    /// reported in canonical form already, and this app's real `home` is never itself a symlink.
    static func sessionIdsTouched(outputsRoot: String, changedPaths: [String]) -> Set<String> {
        let root = outputsRoot.hasSuffix("/") ? String(outputsRoot.dropLast()) : outputsRoot
        var ids = Set<String>()
        for raw in changedPaths {
            guard raw.hasPrefix(root + "/") else { continue }
            let relative = raw.dropFirst(root.count + 1)
            guard let first = relative.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first,
                  !first.isEmpty else { continue }
            ids.insert(String(first))
        }
        return ids
    }
}
