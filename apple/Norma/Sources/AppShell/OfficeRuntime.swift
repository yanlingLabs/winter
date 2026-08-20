import Foundation
#if canImport(Darwin)
import Darwin
#endif

// MARK: - office-plumbing Task 8: what a change on disk MEANS

/// **PURE: a file's identity+content fingerprint, cheap enough to take on every debounced watcher
/// fire.** Stage A documents are binary (xlsx/docx/...) and view-only, so — unlike
/// `EditorFileWatcher.swift`'s `EditorDiskChange`, which reads and diffs the whole file as TEXT —
/// there is nothing to decode and nothing to lose by comparing metadata instead of bytes: a `stat(2)`
/// answers "did this move" exactly as well as a full read would, at a cost close to zero.
///
/// All three fields matter, not just mtime: `inode` catches a replace-via-rename (a new inode can
/// legitimately keep an identical mtime on a fast enough clock); `size` and the nanosecond-resolution
/// mtime together catch an in-place rewrite that happens to land in the same second POSIX time
/// reports (`st_mtimespec` is nanosecond already — Foundation's own `Date`-based attributes API
/// rounds this away, which is why this reads the raw `stat` struct instead).
struct OfficeFileStat: Equatable {
    var inode: UInt64
    var size: Int64
    var modifiedSeconds: Int64
    var modifiedNanoseconds: Int64
}

/// `nil` when the path cannot be stat'd — the ONLY signal `officeDiskChange` treats as "gone" (a
/// permissions flap that merely makes a file unreadable is a different, rarer case Stage A does not
/// try to distinguish from a deletion; `EditorRuntime.fileChangedOnDisk`'s own `.notFound`-only
/// carve-out is a refinement this simpler surface does not need yet — a stat failure is already the
/// narrowest signal available here, unlike a full read, which can fail for many additional reasons).
func officeFileStat(atPath path: String) -> OfficeFileStat? {
    var info = stat()
    guard stat(path, &info) == 0 else { return nil }
    return OfficeFileStat(inode: UInt64(info.st_ino), size: Int64(info.st_size),
                          modifiedSeconds: Int64(info.st_mtimespec.tv_sec),
                          modifiedNanoseconds: Int64(info.st_mtimespec.tv_nsec))
}

/// The classification itself — deliberately a two-way fork, not `EditorDiskChange`'s four-way one:
/// **no suppression bag, and so no `.ours` case** (the T8 brief, verbatim: "Stage A never writes
/// office files from the app," so unlike the editor there is no "was this our own save landing"
/// question to ask; every difference from the baseline is external by construction — see
/// `OfficeRuntime.fileChangedOnDisk`'s own header, the site Stage B's save work must revisit).
enum OfficeDiskChange: Equatable {
    /// The stat is exactly what this runtime already knew — the overwhelmingly common answer: a
    /// sibling file changing in the same watched directory, a LOK lock file churning beside the
    /// document (T3's own disclosed concern), a `touch` with no real content change.
    case unchanged
    /// Different from the baseline. The agent, another editor, `git checkout` — Stage A cannot tell
    /// which, and a view-only surface has no reason to.
    case external
    case deleted
}

func officeDiskChange(stat: OfficeFileStat?, baseline: OfficeFileStat?) -> OfficeDiskChange {
    guard let stat else { return .deleted }
    if let baseline, stat == baseline { return .unchanged }
    return .external
}

// MARK: - The state (PURE — `OfficeRuntimeReducerTests` drives every row of this without a helper)

/// Everything about a session's office documents that anything outside it may read: whether the
/// (shared, app-wide) helper is up, which paths are open, and what each one knows about itself.
///
/// **Deliberately a plain value with no references in it** — the same reason `EditorRuntimeState`
/// gives: the lifecycle has to be reasoned about, and tested, without a helper process, a socket or
/// a run loop, and a state that carried a connection or a client would drag all three back in
/// through the back door.
struct OfficeRuntimeState: Equatable {
    /// Where THIS runtime is in learning about the (possibly shared, possibly already-running)
    /// helper. Unlike `EditorRuntimeState.Phase` — where each runtime owns its own browser and a
    /// browser that failed to appear leaves nothing sane to retry against — `.failed` here is NOT
    /// terminal: the helper is an app-wide process the supervisor is willing to relaunch "on next
    /// demand" (`OfficeHelperSupervisor`'s own header), and a demand is exactly a fresh
    /// `.openRequested`. See `OfficeRuntimeReducer`'s own `.openRequested` case for the retry.
    enum Phase: String, Equatable {
        case idle
        case starting
        case ready
        case failed
    }

    /// One open document. `docId` is caller-minted (T3's own interface note: "the helper never
    /// invents ids") — minted by the imperative half at the moment `.helperOpen` is performed, never
    /// by this pure reducer.
    struct DocumentEntry: Equatable {
        var docId: String
        var type: OfficeDocumentKind
        var parts: Int
        /// Which part (sheet/slide/page) a viewport last asked to see — T6's part-navigation strip
        /// reads this; T5 only ever WRITES it, as a side effect of `.subscribeRequested` (the one
        /// event that carries a part number in Stage A). Defaults to 0 — the first part — since
        /// nothing has asked for anything else yet at open time.
        var activePart: Int = 0
        var sizeTwips: OfficeDocumentSize
    }

    var phase: Phase = .idle
    /// Absolute path -> what is known about its open document.
    var documents: [String: DocumentEntry] = [:]
    /// Opens that arrived before the (shared) helper was ready, in order, deduped. Flushed by
    /// `.helperBecameReady` and dropped by `.helperDied`/`.helperUnavailable` (they can never land) —
    /// same shape and same reasoning as `EditorRuntimeState.pendingOpens`.
    var pendingOpens: [String] = []
    /// **Task 5 (mirrors editor-product Task 5's `openFailures`): why a path has no document —
    /// the explicit signal.** `documents[path] == nil` alone is NOT "the file could not be opened":
    /// a queued open and an open still in flight are both "no document" too, and only a genuine
    /// failure belongs here. Cleared by a fresh `.openRequested` for the same path (a retry must not
    /// keep showing a stale sentence), by the document actually opening, by a close, or by teardown.
    var openFailures: [String: String] = [:]
    /// Why `phase == .failed` — set by `.helperDied`/`.helperUnavailable`, cleared by whatever
    /// supersedes it (a fresh `.openRequested`, which retries) or by teardown. Not part of the
    /// brief's literal field list for `documents[path]` — added at the top level, mirroring
    /// `EditorRuntimeState.failureReason`, because carry 4 ("helperDied -> runtime surfaces a
    /// banner/failed state") needs somewhere durable to say WHY, and a per-document field cannot: a
    /// helper death clears every document at once (see `.helperDied` below), so nothing document-
    /// scoped could ever hold this by the time anything reads it.
    var failureReason: String?
    /// **office-plumbing Task 8**: what an open document's tab is saying ABOVE the canvas — today
    /// exactly one reason ever lands here ("File was deleted on disk"), but this is a `[String:
    /// String]` rather than a `Set<String>` of "deleted" paths for the same reason `openFailures` is
    /// a dictionary of reasons rather than a set of paths: Stage B's first save-conflict banner
    /// reuses this field verbatim rather than inventing a second one. **Deliberately separate from
    /// `openFailures`**: a deleted-while-open document still HAS a `documents[path]` entry (nothing
    /// to lose — the last-rendered tiles stay on screen, per the brief), so it must never route
    /// through the failure sentence that REPLACES the canvas (`officeDocumentViewportPlan`'s
    /// `.openFailed` arm) — this banner sits ABOVE a canvas that keeps rendering, mirroring
    /// `EditorRuntimeState.banners`' identical split from `EditorRuntimeState.openFailures`.
    /// Cleared by a successful (re)open of the same path (`.opened`'s own doc: a document that just
    /// opened cannot still be saying it was deleted) and by close/teardown, and — Task 8 review — by
    /// a matching `.reloadFailed` (that arm's own comment: the banner goes with the document it was
    /// about). One interleaving is disclosed, not solved, same class as the runtime's own close-
    /// during-reload resurrection race: `.externalDeleted` sets this banner while `documents[path]`
    /// still holds the pre-delete entry; if an ALREADY-in-flight reload for that same path then
    /// succeeds (`.opened` lands after the delete), its arm clears this banner along with everything
    /// else `.opened` resets, leaving the tab showing freshly-reloaded content for a file that is, at
    /// that instant, actually gone — no banner. **Mechanism, corrected — T8 fix-round review M1**:
    /// this is NOT because the watch "re-arms" (`startWatching`'s own guard early-returns whenever a
    /// watcher for `path` already exists — a reload's own `.watchFile` re-emission touches nothing)
    /// and NOT because a baseline gets "replaced" (a `.deleted` verdict REMOVES the baseline,
    /// `diskBaselines.removeValue(forKey:)`, and `officeDiskChange` never consults the baseline for a
    /// `.deleted` verdict in the first place — it returns `.deleted` purely from `stat` coming back
    /// nil). What actually happens: the FILE itself generates no further events once it is gone, but
    /// the watcher's DIRECTORY source stays live (`DispatchSourceFileWatcher`'s own doc) — it fires on
    /// ANY entry change in the parent, and every fire re-stats `path` and re-evaluates from scratch,
    /// so the path's own recreation is still caught (a reload, clearing the banner) and so is a
    /// sibling merely churning while `path` stays gone (another `.deleted` verdict, the same banner
    /// reasserted — a harmless no-op re-write of the same string). Only on a genuinely QUIESCENT
    /// directory — nothing at all changes in it after this — does the missing banner simply persist,
    /// unresolved, until the tab closes (`.closeRequested` clears it) or teardown. Stage B inherits
    /// this comment verbatim; keep it true.
    var documentBanners: [String: String] = [:]
}

// MARK: - Events

/// Everything that can happen to a runtime. The imperative half feeds these; the reducer is the
/// only thing that decides what they mean.
enum OfficeRuntimeEvent: Equatable {
    /// **office live-gate Bug 2 (REVIEWED-DECISION OVERRIDE) — "have the shared helper ready" without
    /// opening anything.** T7 ruled office needed no pre-warm door of its own ("an open is its own
    /// pre-warm" — see `openDocumentTab`'s own note, `ShellSessionHost.swift`, for the site this
    /// overrides): the human live gate overruled that, measuring the FIRST office click paying
    /// helper-spawn-plus-LOK-init cold, in full, on the click itself. Mirrors
    /// `EditorRuntimeEvent.prewarmRequested`'s shape (idempotent, acts from `.idle` only) rather than
    /// `.openRequested`'s own `.idle, .failed` retry pair below — a DELIBERATE, narrower divergence:
    /// every tab-opening door (`openFileTab`/`openDiffTab`/`openDocumentTab`) already funnels through
    /// `ShellSessionHost.revealPanel` -> `panelDidReveal` on EVERY click, so retrying from `.failed`
    /// here would turn every reveal of a session whose shared helper is currently down into a fresh
    /// supervisor 3-attempt boot cycle (up to 30s handshake budget each) — the exact "hot loop...
    /// competing with the user's machine" `OfficeHelperSupervisor`'s own header forbids for a crashy
    /// helper. A genuine ASK (a real document open) still retries from `.failed` exactly as it always
    /// has — `.openRequested`'s own arm, unchanged by this case.
    case prewarmRequested
    /// "Open this file." Queued while starting; self-starting from `.idle` AND from `.failed` (carry
    /// 4 — see `OfficeRuntimeState.Phase`'s own doc).
    case openRequested(path: String)
    /// The (shared) helper reported ready — either a fresh boot this runtime itself asked for, or
    /// the fan-out telling every runtime that SOME session's ask succeeded. No payload: nothing in
    /// this state shape remembers the helper's `lokVersion`.
    case helperBecameReady
    /// A `.helperOpen` reached the helper and it answered with the document's metadata.
    case opened(path: String, docId: String, metadata: OfficeDocumentMetadata)
    /// A `.helperOpen` reached the helper and it refused (garbage file, unreadable path, ...) — see
    /// `OfficeHelperClientError.openFailed`, the shape the imperative half classifies this from.
    case openFailed(path: String, reason: String)
    case closeRequested(path: String)
    /// T6's tile door: a viewport wants to see `part` of `path`. Thin at T5 — this event only
    /// updates `activePart` and asks the helper; T6 owns everything about what the viewport
    /// coordinates mean and what it does with the returned tile keys.
    case subscribeRequested(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    case unsubscribeRequested(path: String)

    // MARK: office-plumbing Task 8 — the world changing underneath an open document

    /// **The watcher's verdict for an open document's file: different from what Swift last saw.**
    /// Unlike `EditorRuntimeEvent.externalChanged`, this carries no text and no dirty/clean fork —
    /// Stage A documents are binary and view-only, so there is nothing to diff and nothing to lose:
    /// every arrival of this event is answered the SAME way, a silent reload (see this reducer's own
    /// `.externalChangeDetected` arm). `OfficeRuntime.fileChangedOnDisk`'s own header states why no
    /// suppression bag exists yet.
    case externalChangeDetected(path: String)
    /// The watched file is gone.
    case externalDeleted(path: String)
    /// **A `.reloadDocument` effect's reopen failed** — carries the docId it was trying to REPLACE,
    /// which is what lets this event tell a genuine failure apart from a stale one: a second,
    /// independent reload for the same path (two external writes close enough together to both mint
    /// their own reopen) may already have SUCCEEDED and replaced `oldDocId` with a newer entry by
    /// the time this failure lands, and a failure that blindly cleared `documents[path]` regardless
    /// would then discard a document that is genuinely fine. See this reducer's own arm.
    case reloadFailed(path: String, oldDocId: String, reason: String)
    /// The shared supervisor's own death/never-came-up signals, fanned out to every runtime in the
    /// table (`ShellSessionHost`'s own broadcast — see its header). Legal, and identically handled,
    /// from every phase — carry 4's own words, and `OfficeRuntimeReducerTests
    /// .testHelperDiedFromEveryPhaseClearsEverythingFailsAndBanners` is the pin.
    case helperDied
    case helperUnavailable
    /// Release everything. Legal from every phase, and the only route back to a fresh `.idle`.
    case teardownRequested
}

/// What the imperative half must DO about an event. Named after the effect, never after the wire
/// call, so the reducer's tests read as claims about the runtime rather than about the socket.
///
/// The brief names five: `.helperOpen`, `.helperClose`, `.subscribe`, `.unsubscribe`,
/// `.emitBanner`. Five more are added here. Two predate Task 8, mirroring `EditorRuntimeEffect`'s
/// own extra members beyond its headline `.createBrowser`/`.registerWithHub` pair:
/// `.ensureHelperReady` (the "ask the possibly-already-running shared helper to be ready" step
/// `.openRequested` needs from `.idle`/`.failed`) and `.teardown` (releasing everything this
/// runtime holds, on the same terms as `EditorRuntimeEffect.teardown(browserId:)`). Task 8 adds
/// three more for the file-watch/reload story: `.watchFile`, `.unwatchFile`, `.reloadDocument`
/// (each documented at its own case below).
enum OfficeRuntimeEffect: Equatable {
    case ensureHelperReady
    case helperOpen(path: String)
    case helperClose(docId: String)
    case subscribe(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    case unsubscribe(docId: String)
    /// office-plumbing Task 8: start/stop the file watch — emitted by `.opened` (fires the instant
    /// this runtime records the document, fresh open OR reload alike — `startWatching`'s own guard
    /// makes a reload's re-arm a no-op) and by `.closeRequested`/`.reloadFailed`. Mirrors
    /// `EditorRuntimeEffect.watchFile`/`.unwatchFile` exactly; teardown does NOT emit these per-path
    /// (mirrors `EditorRuntimeReducer.teardownRequested`'s identical choice) — the imperative half's
    /// `performTeardown` walks its OWN `watchers` table directly, since only it holds one.
    case watchFile(path: String)
    case unwatchFile(path: String)
    /// office-plumbing Task 8: **the reload itself** — helper close (`oldDocId`) + a fresh open of
    /// `path`, exactly as `.helperOpen` opens any other path, under a NEWLY MINTED docId (T6 review
    /// F4's own finding: reload IS a new docId — see `OfficeTileCanvasView.syncDocumentIdentity`'s
    /// header for the app-side consequence). Deliberately does NOT ask the reducer to clear
    /// `documents[path]` first: the OLD entry stays exactly where it is until the new one is ready,
    /// which is what keeps `officeDocumentViewportPlan` returning `.showCanvas` continuously through
    /// the round trip — the tab keeps showing its last-good frame (never a placeholder/booting flash)
    /// and, just as importantly, `PanelDocumentContent`'s `switch` never leaves the `.showCanvas`
    /// case, so SwiftUI never dismantles `OfficeTileCanvasView` and the view state living on it
    /// (`scrollOrigin`/`zoomPPT`) survives untouched.
    case reloadDocument(path: String, oldDocId: String)
    /// Task 5: whenever the reducer decides something is worth telling the user, this fires
    /// alongside the state it also writes (`failureReason` for a helper death, `openFailures[path]`
    /// for one document, `documentBanners[path]` since Task 8 for an external change/deletion) — the
    /// effect is the transient, "say it once" half; the state is the durable, "a later render can
    /// still read it" half. The UI reads the durable state directly rather than the effect: T6's
    /// `OfficeDocumentViewportStateView` renders `openFailures`/`failureReason`, and T8's
    /// `OfficeDocumentBannerView` renders `documentBanners`. So `OfficeRuntime`'s own performer for
    /// this case stays a documented no-op relay — the effect still fires and is asserted by the
    /// reducer tests, matching the brief's named effect list, but nothing subscribes to it.
    case emitBanner(reason: String)
    /// Release every open docId (closing each is the imperative half's job — see
    /// `OfficeRuntime.performTeardown`); never touches the shared helper PROCESS itself, which
    /// outlives any one session's runtime (`ShellSessionHost.teardownOfficeRuntime`'s own header).
    case teardown(docIds: [String])
}

/// **The whole lifecycle, as one pure function.** Every claim Task 5 makes about this runtime —
/// self-starting from idle AND from failed, ready-gates-opens, helperDied-in-every-phase,
/// teardown-from-every-phase — is a row of `OfficeRuntimeReducerTests` driving this directly, with
/// no helper process, no socket and no run loop.
enum OfficeRuntimeReducer {
    static func reduce(_ state: OfficeRuntimeState,
                       _ event: OfficeRuntimeEvent) -> (OfficeRuntimeState, [OfficeRuntimeEffect]) {
        var next = state

        switch event {

        case .prewarmRequested:
            // Prewarm-once, `.idle`-only — see the event's own doc for why `.failed` is deliberately
            // excluded here (unlike `.openRequested`'s `.idle, .failed` pair just below). `pendingOpens`
            // stays EMPTY: this asks the shared helper to be ready and nothing else.
            // `.ensureHelperReady` is the IDENTICAL effect `.openRequested` already emits from `.idle`
            // — Bug 2's own "via the existing ensure path" — simply never paired with an open this time.
            guard state.phase == .idle else { return (next, []) }
            next.phase = .starting
            return (next, [.ensureHelperReady])

        case .openRequested(let path):
            // A new ask supersedes the last failure for that path, before any phase decides
            // anything — the same discipline `EditorRuntimeReducer.openRequested` states at length:
            // a retry (the tree click on a file whose permissions just got fixed) must not keep
            // showing a stale sentence while its own fresh attempt is in flight.
            next.openFailures.removeValue(forKey: path)
            switch state.phase {
            case .idle, .failed:
                // **Carry 4: `.failed` retries exactly like `.idle`.** The shared helper's own
                // contract is "relaunch on next demand only" — this IS that demand. A fresh attempt
                // also supersedes whatever the last failure said (`failureReason`), same reasoning
                // as the `openFailures` clear above, one level up.
                next.phase = .starting
                next.pendingOpens = [path]
                next.failureReason = nil
                return (next, [.ensureHelperReady])
            case .starting:
                if !next.pendingOpens.contains(path) { next.pendingOpens.append(path) }
                return (next, [])
            case .ready:
                // No per-runtime "current"/"activate" concept (Office has no single shared page the
                // way Editor's one CEF browser is — T6 gives every open document its OWN tab and tile
                // canvas). An already-open path is simply left alone; T6's tab layer owns dedupe/
                // activate against ITS OWN already-open tab, mirroring `openFileTab`'s contract.
                guard state.documents[path] == nil else { return (next, []) }
                return (next, [.helperOpen(path: path)])
            }

        case .helperBecameReady:
            guard state.phase == .starting else { return (next, []) }
            next.phase = .ready
            let queued = next.pendingOpens
            next.pendingOpens = []
            return (next, queued.map { .helperOpen(path: $0) })

        case .opened(let path, let docId, let metadata):
            // Gated on `.ready`, like every other arm that records what the helper said: the async
            // reply can land after a teardown or a helper death moved this runtime past `.ready`
            // (the imperative half's own generation guard — `OfficeRuntime.perform`'s `.helperOpen`
            // case — is what stops the DISPATCH from even reaching here in the teardown case; this
            // guard is the belt, and the only line of defense for the helperDied case, which does
            // not bump that generation).
            guard state.phase == .ready else { return (next, []) }
            next.openFailures.removeValue(forKey: path)
            // office-plumbing Task 8: a document that just (re)opened cannot still be saying it was
            // deleted — the reload success path is what answers a deleted-then-restored file.
            next.documentBanners.removeValue(forKey: path)
            // **Task 8: this is ALSO how a reload preserves `activePart` without a second, reload-
            // only version of this event.** `.reloadDocument` never clears `documents[path]` before
            // its own reopen resolves (see that effect's own header), so a RELOAD's `.opened` finds
            // the OLD entry still sitting here — a FRESH open never does (`.openRequested`'s `.ready`
            // arm guards `state.documents[path] == nil` before ever emitting `.helperOpen`), so
            // `previousActivePart` is 0 there regardless and this line changes nothing about a fresh
            // open. Clamped because a modified file may now have FEWER parts than the one it
            // replaced (T8 interface obligation).
            let previousEntry = state.documents[path]
            let previousActivePart = min(previousEntry?.activePart ?? 0, max(metadata.parts - 1, 0))
            next.documents[path] = OfficeRuntimeState.DocumentEntry(
                docId: docId, type: metadata.type, parts: metadata.parts, activePart: previousActivePart,
                sizeTwips: metadata.sizeTwips)
            var effects: [OfficeRuntimeEffect] = [.watchFile(path: path)]
            // **Task 8, the overwrite-orphan guard**: two reloads for the same path close enough
            // together (the debounce's own window) each mint and open their own fresh docId
            // independently; if BOTH succeed, the second `.opened` to land here would otherwise
            // silently overwrite the first's entry, leaving ITS docId open on the shared helper with
            // no owner left to ever close it. Whichever docId this replaces — if it differs from the
            // one just arriving — gets a compensating close. In the ordinary single-reload case that
            // docId was ALREADY closed by `.reloadDocument`'s own effect performer, and close is
            // idempotent (T3), so the extra call here costs nothing when it is not needed and
            // prevents a real leak when it is.
            if let previousEntry, previousEntry.docId != docId {
                effects.append(.helperClose(docId: previousEntry.docId))
            }
            return (next, effects)

        case .openFailed(let path, let reason):
            guard state.phase == .ready else { return (next, []) }
            next.openFailures[path] = reason
            let basename = (path as NSString).lastPathComponent
            return (next, [.emitBanner(reason: "Couldn't open \(basename): \(reason)")])

        case .closeRequested(let path):
            next.pendingOpens.removeAll { $0 == path }
            next.openFailures.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path) // Task 8: no path to still be a document about
            guard let doc = state.documents[path] else { return (next, []) }
            next.documents.removeValue(forKey: path)
            // Task 8: the watch goes with the document — "a watcher exists exactly while a document
            // does" is an invariant of this reducer, mirroring `EditorRuntimeReducer.closeRequested`'s
            // identical one for models.
            return (next, [.helperClose(docId: doc.docId), .unwatchFile(path: path)])

        case .subscribeRequested(let path, let part, let zoomPPT, let viewportTwips):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            next.documents[path]?.activePart = part
            return (next, [.subscribe(docId: doc.docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)])

        case .unsubscribeRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            return (next, [.unsubscribe(docId: doc.docId)])

        // MARK: office-plumbing Task 8

        case .externalChangeDetected(let path):
            // Gated on the DOCUMENT, like every other arm describing what the helper's copy holds:
            // the watcher's read runs off this beat and can land after a close or a teardown moved
            // this path out of `documents` (mirrors `EditorRuntimeReducer.externalChanged`'s
            // identical guard and identical reasoning).
            guard let doc = state.documents[path] else { return (next, []) }
            // A file that just proved it still exists (and moved) cannot also be showing "File was
            // deleted on disk."
            next.documentBanners.removeValue(forKey: path)
            // **Stage A is view-only — there is no dirty buffer to protect, so unlike the editor's
            // clean/dirty fork this is ALWAYS a silent reload; nothing here ever shows a "keep mine"
            // choice, because Stage A never has a "mine" to keep** (the brief, verbatim). `next`
            // deliberately still shows the OLD docId — see `.reloadDocument`'s own header for why.
            return (next, [.reloadDocument(path: path, oldDocId: doc.docId)])

        case .externalDeleted(let path):
            // **Deleted → banner that PERSISTS, view-only so nothing to lose** (the brief, verbatim):
            // the document entry is left completely untouched — the tab keeps showing its last
            // rendered tiles, exactly as they were, with this sentence overlaid above them.
            guard state.documents[path] != nil else { return (next, []) }
            let reason = "File was deleted on disk"
            next.documentBanners[path] = reason
            return (next, [.emitBanner(reason: reason)])

        case .reloadFailed(let path, let oldDocId, let reason):
            guard state.phase == .ready else { return (next, []) }
            // **The stale-failure guard**: only act if this path still shows the very entry this
            // reload was trying to replace. A second, independent reload for the same path may
            // already have SUCCEEDED (a fresh `.opened` replaced `oldDocId` with a newer docId) by
            // the time this failure lands — see this event's own header. If so, there is nothing to
            // do: the newer document is genuinely fine, and its own watch is already running.
            guard state.documents[path]?.docId == oldDocId else { return (next, []) }
            next.documents.removeValue(forKey: path)
            next.openFailures[path] = reason
            // Task 8 review: the banner goes with the document, exactly as `.closeRequested` already
            // reasons above. Without this, a delete-during-reload interleaving (external change starts
            // a reload; the file is deleted before the round trip lands; `.externalDeleted` sets the
            // "File was deleted on disk" banner while the old entry is still present; the in-flight
            // reload then fails and lands here) would leave that banner standing over the full-screen
            // `.openFailed` state this arm produces instead — two failure surfaces for one path, and a
            // `documentBanners` entry with no document behind it, which is exactly the invariant this
            // field's own header rules out.
            next.documentBanners.removeValue(forKey: path)
            let basename = (path as NSString).lastPathComponent
            return (next, [.emitBanner(reason: "Couldn't reload \(basename): \(reason)"),
                           .unwatchFile(path: path)])

        case .helperDied, .helperUnavailable:
            // **Carry 4, both halves at once.** Every open document's docId lives only on the
            // now-gone helper, so NONE of them survive this — a per-document banner would have
            // nothing left to be attached to a beat later; the failure is recorded at the top level
            // instead (`failureReason`). Never auto-restarts: nothing here emits `.ensureHelperReady`
            // — see `OfficeRuntime`'s own doc on why relaunch is next-demand-only.
            let reason = (event == .helperDied)
                ? "The office helper stopped unexpectedly."
                : "The office helper couldn't be started."
            var fresh = OfficeRuntimeState()
            fresh.phase = .failed
            fresh.failureReason = reason
            // **Wave fix (T9 review M8)**: every watch this runtime armed for a now-cleared document
            // must stop HERE, not wait for a close that can never arrive — `.closeRequested`'s own
            // `.unwatchFile` is gated on `state.documents[path]` existing (see that arm above), and
            // this event just wiped `documents` entirely, so a close for any of these paths after
            // this point is a permanent no-op forever (not merely "leaks until teardown," which is
            // what the pre-fix behavior actually was — a session-long runtime may never tear down).
            // Left unstopped, the watch leaks its fd for the runtime's remaining lifetime AND, worse,
            // a later reopen of the SAME path finds `startWatching`'s own guard (`watchers[path] ==
            // nil`) still false, so the baseline never re-seeds: the first fire after reopen would be
            // judged against a baseline frozen from BEFORE the death, misreading an ordinary,
            // already-reflected change as a fresh external edit and spuriously reloading content that
            // is already current.
            //
            // Emitted as `.unwatchFile` per path — reusing the SAME effect (and the SAME imperative
            // performer, `OfficeRuntime.perform`'s `.unwatchFile` case) `.closeRequested`/
            // `.reloadFailed` already use — rather than `OfficeRuntime.handle(supervisorEvent:)`
            // walking its own `watchers` table directly the way `performTeardown` does. The two
            // existing precedents point opposite ways, and the difference is what makes this the
            // right one: `performTeardown`'s direct walk EXECUTES a decision the reducer ALREADY
            // made (`.teardownRequested` -> `.teardown(docIds:)`) — the walk is a mechanical detail
            // of running that one effect, not a second, independent decision. `handle(supervisorEvent:)`
            // runs BEFORE any dispatch (it is where `tileStore.evictEverything()` already lives, of
            // necessity — the tile store holds no reducer-visible state for an effect to name), so a
            // table-walk there would be the IMPERATIVE half deciding something on its own, which is
            // exactly what this file's own opening claim rules out ("the reducer is the only thing
            // that decides what they mean"). Naming every open path as its own effect keeps "what
            // happens" entirely inside the reducer. Sorted for deterministic test assertions — a
            // dictionary has no ordering of its own to preserve.
            let unwatchEffects = state.documents.keys.sorted().map { OfficeRuntimeEffect.unwatchFile(path: $0) }
            return (fresh, [.emitBanner(reason: reason)] + unwatchEffects)

        case .teardownRequested:
            // From every phase, including `.idle` — the effect is emitted unconditionally so the
            // imperative half has one path to run (idempotent), and so "teardown from anywhere
            // releases the slot" is a claim the tests can make about the reducer alone. Every open
            // docId is handed to the imperative half to close; NEVER the shared helper process
            // itself (see `.teardown`'s own doc).
            let docIds = state.documents.values.map(\.docId)
            return (OfficeRuntimeState(), [.teardown(docIds: docIds)])
        }
    }
}

// MARK: - The runtime

/// Office Stage A Task 5 — **one session's view of the app-wide office helper, and everything that
/// has to happen for it to open/close documents through it.**
///
/// Unlike `EditorRuntime` (one hidden CEF browser PER SESSION, created and torn down by this very
/// object), the office helper is ONE process shared by every session (`OfficeHelperSupervisor`'s own
/// design — one socket path per state directory). This object therefore does not own a supervisor —
/// it is handed a `Driver` that already knows how to reach the SHARED one, built by
/// `ShellSessionHost` (see that file's own header on the fan-out this implies).
///
/// The lifecycle itself is NOT here — it is `OfficeRuntimeReducer`, pure and tested without a
/// helper process. This half performs effects and relays what the shared helper (via its Driver)
/// says.
@MainActor
final class OfficeRuntime: ObservableObject {

    /// Every call this file makes into the shared helper. Closures, not a direct
    /// `OfficeHelperSupervisor`/`OfficeHelperClient` reference — the same reasoning
    /// `EditorRuntime.CEFDriver` gives: nothing helper-shaped is safely constructible under XCTest
    /// (a real driver spawns a subprocess), so this runtime's logic has to be reachable without it.
    ///
    /// **No `.production` default** (unlike `CEFDriver`, which closes over CEF's global C
    /// functions): the shared helper is owned per-`ShellSessionHost` instance, not a process-wide
    /// singleton (many hosts exist across the test suite alone), so there is nothing static to
    /// default to. `ShellSessionHost.officeRuntime(for:)` builds one per runtime from its own
    /// `officeHelperSupervisor`/`officeRequestQueue` at mint time.
    struct Driver {
        /// Synchronous — `OfficeHelperSupervisor.state` is a plain stored property. This is the
        /// late-joiner check `.ensureHelperReady` needs: a runtime minted AFTER the shared helper is
        /// already `.ready` would otherwise wait forever for a fan-out event that already happened
        /// in the past, to a supervisor `events` stream nobody yet subscribed on its behalf.
        var helperState: () -> OfficeHelperSupervisor.State
        /// Asks the shared supervisor to be ready. Safe to call when a start is already in flight,
        /// or when one already succeeded (`OfficeHelperSupervisor.start()`'s own documented no-ops)
        /// — this runtime never needs to know which case it is; either way, ONE eventual fan-out
        /// event (or the synchronous `helperState()` check above) is what actually advances it.
        var startHelper: () async -> Void
        /// Routed through `ShellSessionHost`'s ONE `OfficeHelperRequestQueue` in production — see
        /// that type's own header for why a raw, un-serialized `client.open` is not safe to call
        /// from more than one place at a time on the shared connection.
        var open: (_ docId: String, _ path: String) async throws -> OfficeDocumentMetadata
        /// Never throws to the caller: a close is fire-and-forget everywhere this file uses it
        /// (optimistic removal in the reducer, teardown, the carry-6 compensating close) — there is
        /// nothing left to roll back to on failure, only something worth logging, which the
        /// production implementation does on its own terms.
        var close: (_ docId: String) async -> Void
        var subscribeTiles: (_ docId: String, _ part: Int, _ zoomPPT: Int,
                             _ viewportTwips: OfficeTwipsRect) async throws -> [TileKey]
        var unsubscribeTiles: (_ docId: String) async -> Void
        /// Task 6 — the pixel-fetch half `subscribeTiles` deliberately leaves undone (that call
        /// only REGISTERS the subscription and reports which keys the current viewport needs; this
        /// is what actually asks for their bytes). Routed through
        /// `ShellSessionHost.officeRequestQueue` in production, on the SAME terms as every other
        /// Driver call — see `OfficeHelperRequestQueue`'s own header. Never throws to a caller that
        /// cannot do anything about it: `perform(_:)`'s `.subscribe` case treats a failure here as
        /// fire-and-forget, matching `close`/`unsubscribeTiles`.
        var requestTiles: (_ docId: String, _ keys: [TileKey]) async throws -> Void
    }

    let sessionId: String

    /// The published state. `stateSnapshot` is the same value under the name the plan's interface
    /// names it by — mirrors `EditorRuntime.state`/`.stateSnapshot` exactly.
    @Published private(set) var state = OfficeRuntimeState()
    var stateSnapshot: OfficeRuntimeState { state }

    /// Task 6 — **this runtime's own pixel pool, never `@Published`.** See `OfficeTileStore`'s own
    /// header for why: `state` above is the reducer's small, diffable truth (which documents, which
    /// phase); this is the heavy, high-frequency half (tile bytes, dozens of pushes a second during
    /// a scroll) that must never ride the same invalidation channel. One per runtime — a session can
    /// hold several open `.document` tabs, and they share this one pool (`OfficeTileStore.Key`
    /// scopes every entry by `docId`).
    let tileStore = OfficeTileStore()

    private let driver: Driver
    private let makeDocId: () -> String
    /// office-plumbing Task 8: how a watch is made — the SAME seam `EditorRuntime` was already built
    /// with (`EditorFileWatcherFactory`), reused verbatim rather than forked: its only requirement is
    /// "a live watch somebody can stop" (`FileTreeWatching`), which has nothing editor-specific in
    /// it. Defaults to the real `DispatchSourceFileWatcher`, exactly as `EditorRuntime`'s own default
    /// does; test seam otherwise.
    private let makeWatcher: EditorFileWatcherFactory
    /// One watch per open document's path — mirrors `EditorRuntime.watchers` exactly, including the
    /// invariant this reducer states at its own two sites (`.opened`/`.closeRequested`): a watcher
    /// exists exactly while `documents[path]` does.
    private var watchers: [String: FileTreeWatching] = [:]
    /// office-plumbing Task 8: what Swift last saw on disk for a watched path — `nil` means nothing
    /// is known yet (armed but never fired). See `officeDiskChange`'s own header for why this is a
    /// cheap `stat()` snapshot rather than the editor's own read-the-whole-file text baseline: office
    /// documents are binary, so there is nothing to decode, and the only question a view-only surface
    /// needs answered is "did the file move," which a stat already answers.
    private var diskBaselines: [String: OfficeFileStat] = [:]

    /// **Carry 6's belt: bumped by `teardown()`, checked by every in-flight `.helperOpen` before it
    /// dispatches its result.** Mirrors `OfficeHelperSupervisor.generation`'s own reasoning exactly:
    /// `teardown()` resets `state` to a value that is BYTE-IDENTICAL to a runtime that was simply
    /// never started, so a phase check alone cannot tell "this specific open was superseded" apart
    /// from "this runtime never asked for anything." A stale open that resumes after a teardown must
    /// neither resurrect the torn-down runtime NOR orphan the document it just opened on the shared
    /// helper — see `perform(_:)`'s `.helperOpen` case for both halves.
    private(set) var generation = 0

    init(sessionId: String, driver: Driver, makeDocId: @escaping () -> String = { UUID().uuidString },
         makeWatcher: @escaping EditorFileWatcherFactory = { path, onChange in
             DispatchSourceFileWatcher(path: path, onChange: onChange)
         }) {
        self.sessionId = sessionId
        self.driver = driver
        self.makeDocId = makeDocId
        self.makeWatcher = makeWatcher
    }

    // MARK: The doors

    /// **office live-gate Bug 2: the pre-warm door.** Idempotent (the reducer's own `.idle`-only
    /// guard) and safe to call on every panel reveal — mirrors `EditorRuntime.prewarm()`'s contract
    /// exactly, including "safe to call redundantly." See `OfficeRuntimeEvent.prewarmRequested`'s own
    /// doc for the one deliberate divergence from that mirror (`.failed` does not retry here).
    func prewarm() {
        perform(dispatch(.prewarmRequested))
    }

    /// Open a file. Synchronous — unlike `EditorRuntime.openFile` (which awaits a DISK READ this
    /// object does itself), nothing here needs to happen before the reducer can decide what to do;
    /// every actual round trip to the helper is fire-and-forget from this door's own perspective,
    /// exactly like `EditorRuntime.close`/`.teardown`. Never sequence off this call returning —
    /// observe `state`/`stateSnapshot` instead (the same rule `EditorRuntime.openFile`'s own header
    /// states, for the identical reason: this returns before the helper has answered anything).
    func open(_ path: String) {
        perform(dispatch(.openRequested(path: path)))
    }

    func close(_ path: String) {
        perform(dispatch(.closeRequested(path: path)))
    }

    /// T6's tile door. Thin here — see `OfficeRuntimeEvent.subscribeRequested`'s own doc.
    func subscribeTiles(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect) {
        perform(dispatch(.subscribeRequested(path: path, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)))
    }

    func unsubscribeTiles(path: String) {
        perform(dispatch(.unsubscribeRequested(path: path)))
    }

    /// Release everything this runtime holds. Legal from every phase and safe twice.
    /// **Synchronous by contract** — the quit path and the shell's departure policy both need the
    /// STATE reset to have happened when this returns (mirrors `EditorRuntime.teardown`'s own
    /// header). What is NOT synchronous, and cannot be: the actual `close` round trips to the
    /// shared helper for each document this runtime held — those are fire-and-forget, the same
    /// "obligation 5" `AppDelegate.editorQuitGate` already documents for saves in flight ("no
    /// attempt to wait out an in-flight [request]").
    func teardown() {
        perform(dispatch(.teardownRequested))
    }

    /// **The fan-out door** — called by `ShellSessionHost`'s ONE consumer of the shared supervisor's
    /// `events` stream, once per event, for EVERY runtime in its table (see that file's header for
    /// why this must be a fan-out rather than each runtime subscribing on its own:
    /// `OfficeHelperSupervisor.events` is documented single-consumer).
    func handle(supervisorEvent event: OfficeHelperEvent) {
        switch event {
        case .ready:
            perform(dispatch(.helperBecameReady))
        case .helperDied:
            // Task 6: every docId this runtime's store still holds dies with the helper, in the
            // SAME beat the reducer wipes `state.documents` below — see `OfficeTileStore
            // .evictEverything`'s own header for why this is the sweep that keeps a dead-connection
            // in-flight marker from wedging a placeholder forever.
            tileStore.evictEverything()
            perform(dispatch(.helperDied))
        case .helperUnavailable:
            tileStore.evictEverything()
            perform(dispatch(.helperUnavailable))
        }
    }

    // MARK: The reducer, driven

    private func dispatch(_ event: OfficeRuntimeEvent) -> [OfficeRuntimeEffect] {
        let (next, effects) = OfficeRuntimeReducer.reduce(state, event)
        state = next
        return effects
    }

    private func perform(_ effects: [OfficeRuntimeEffect]) {
        for effect in effects {
            switch effect {
            case .ensureHelperReady:
                // The late-joiner check: if the shared helper is ALREADY ready (some other session
                // started it before this runtime existed, or before this runtime had anything to
                // open), fold that synchronously — no fan-out event is ever coming for a readiness
                // that already happened in the past. Otherwise ask, and let the shared fan-out (or
                // this runtime's own future read of it) advance every waiting runtime once the ask
                // resolves, whoever actually triggered it.
                if driver.helperState() == .ready {
                    perform(dispatch(.helperBecameReady))
                } else {
                    Task { [driver] in await driver.startHelper() }
                }

            case .helperOpen(let path):
                openAndDispatch(path: path, myGeneration: generation, reloadingDocId: nil)

            case .reloadDocument(let path, let oldDocId):
                // Task 8: same store hygiene as an ordinary close (`.helperClose`'s own doc) — the
                // old docId's tiles are gone THE INSTANT this fires, synchronously, before the new
                // open even starts, so a stray push arriving for it lands nowhere (the store has no
                // record of it left to overwrite, and nothing downstream ever asks for that docId
                // again — see `OfficeTileStore`'s own header on why a late arrival here is bounded).
                tileStore.evictAll(docId: oldDocId)
                Task { [driver] in await driver.close(oldDocId) }
                openAndDispatch(path: path, myGeneration: generation, reloadingDocId: oldDocId)

            case .watchFile(let path):
                startWatching(path)

            case .unwatchFile(let path):
                stopWatching(path)

            case .helperClose(let docId):
                // Task 6: the store's own docId-scoped entries die with the document — see
                // `OfficeTileStore.evictAll`'s own header.
                tileStore.evictAll(docId: docId)
                Task { [driver] in await driver.close(docId) }

            case .subscribe(let docId, let part, let zoomPPT, let viewportTwips):
                // Task 6: `subscribeTiles` only REGISTERS the subscription and reports which keys
                // the current viewport needs — this is what actually asks for their bytes. Filtered
                // through the store first (obligation 3: never re-request a tile already cached or
                // already in flight — see `OfficeTileStore.keysNeedingRequest`'s own header for the
                // "big batch pins the connection" amplifier this closes). The two driver calls are
                // deliberately SEQUENTIAL `await`s, never composed inside one `officeRequestQueue
                // .run` — obligation 2, permanent deadlock otherwise.
                Task { [weak self, driver] in
                    guard let keys = try? await driver.subscribeTiles(docId, part, zoomPPT, viewportTwips) else {
                        return
                    }
                    guard let self else { return }
                    let needed = self.tileStore.keysNeedingRequest(docId: docId, candidates: keys)
                    guard !needed.isEmpty else { return }
                    // T6 review F2, re-reviewed: mark in-flight SYNCHRONOUSLY, in the same
                    // uninterrupted stretch of MainActor code that decides to send — there is no
                    // `await` between `needed` being computed and this call, so nothing else on
                    // MainActor (an overlapping `subscribeTiles` from continuous scroll, most
                    // obviously) can interleave and see these keys as still unrequested. The first
                    // cut marked only after `driver.requestTiles` returned, which reopened exactly
                    // that window — the reviewer measured it empirically (a gated send + two
                    // overlapping subscribes produced two `requestTiles` calls for the same keys) and
                    // it collides with `keysNeedingRequest`'s own "big-batch amplifier" warning, one
                    // call and its retries compounding the shared queue's backlog. `catch` still frees
                    // the keys the moment a send actually fails — see `markRequested`'s own doc for
                    // why both halves are required.
                    self.tileStore.markRequested(docId: docId, keys: needed)
                    do {
                        try await driver.requestTiles(docId, needed)
                    } catch {
                        for key in needed { self.tileStore.markFailed(docId: docId, key: key) }
                    }
                }

            case .unsubscribe(let docId):
                Task { [driver] in await driver.unsubscribeTiles(docId) }

            case .emitBanner:
                // The UI reads durable state directly, not this effect: T6's
                // `OfficeDocumentViewportStateView` renders `state.failureReason`/`state.openFailures`,
                // T8's `OfficeDocumentBannerView` renders `state.documentBanners` (this effect's own
                // doc explains the split). Documented no-op relay.
                break

            case .teardown(let docIds):
                performTeardown(docIds: docIds)
            }
        }
    }

    /// **Shared by `.helperOpen` and `.reloadDocument`** (Task 8): mint a docId, ask the helper to
    /// open `path` under it, and dispatch the outcome — identical machinery either way, since a
    /// reload's reopen is, from the helper's own point of view, an ordinary open of a path it has
    /// never heard this fresh docId for. `reloadingDocId` is `nil` for a plain `.helperOpen` (routes
    /// a failure through `.openFailed`, unchanged from before this task) and the docId being replaced
    /// for a `.reloadDocument` (routes a failure through the docId-qualified `.reloadFailed` instead
    /// — see that event's own header for why a plain `.openFailed` would be the wrong shape here:
    /// unlike a fresh open, `documents[path]` may already hold something by the time this resolves,
    /// and an unqualified failure could not tell "genuinely my failure" from "superseded, ignore me").
    private func openAndDispatch(path: String, myGeneration: Int, reloadingDocId: String?) {
        let docId = makeDocId()
        Task { [weak self, driver] in
            guard let self else { return }
            do {
                let metadata = try await driver.open(docId, path)
                guard myGeneration == self.generation else {
                    // Carry 6: teardown superseded this open while it was in flight. The document is
                    // now open on the shared helper with no owner left to close it — compensate
                    // rather than orphan it. Never dispatch into the fresh state teardown just
                    // produced.
                    await driver.close(docId)
                    return
                }
                self.perform(self.dispatch(.opened(path: path, docId: docId, metadata: metadata)))
            } catch {
                guard myGeneration == self.generation else { return } // superseded AND failed: nothing to compensate, nothing to record
                let reason = Self.describe(error)
                if let reloadingDocId {
                    self.perform(self.dispatch(.reloadFailed(path: path, oldDocId: reloadingDocId, reason: reason)))
                } else {
                    self.perform(self.dispatch(.openFailed(path: path, reason: reason)))
                }
            }
        }
    }

    private func performTeardown(docIds: [String]) {
        generation += 1
        for docId in docIds {
            // Task 6: same store hygiene as the single-document close path — see
            // `OfficeTileStore.evictAll`'s own header.
            tileStore.evictAll(docId: docId)
            Task { [driver] in await driver.close(docId) }
        }
        // Task 8: every watch this runtime owns dies HERE, unconditionally — mirrors
        // `EditorRuntime.performTeardown`'s identical ordering (stated at that site: harmless only
        // because nothing is left to notice a watch firing after this). A fresh runtime re-arms
        // whatever it opens from scratch, so the first thing it knows about any path is today's stat.
        for (_, watcher) in watchers { watcher.stop() }
        watchers.removeAll()
        diskBaselines.removeAll()
    }

    // MARK: - office-plumbing Task 8: the world changing underneath an open document

    /// Start watching `path` — armed by the `.watchFile` effect, which `.opened` emits the INSTANT
    /// this runtime records the document (`perform(_:)` runs effects synchronously, in order, right
    /// after `dispatch` returns), so there is no window between "this document exists" and "its
    /// watch is live" for an external change to fall into. Idempotent: a reload's own `.opened` fires
    /// `.watchFile` again for a path already being watched, and this simply does nothing the second
    /// time.
    ///
    /// The baseline is seeded HERE, from the file as it is right now — not from whatever the open
    /// just reported, because Stage A never reads the file's bytes at all (LOK does that, over in the
    /// helper); a `stat()` is the cheapest fact this side can independently confirm.
    private func startWatching(_ path: String) {
        guard watchers[path] == nil else { return }
        diskBaselines[path] = officeFileStat(atPath: path)
        guard let watcher = makeWatcher(path, { [weak self] in
            Task { @MainActor [weak self] in self?.fileChangedOnDisk(path) }
        }) else {
            NSLog("[OfficeRuntime] \(sessionId): could not watch \(path) — external changes to it "
                  + "will not be noticed")
            return
        }
        watchers[path] = watcher
    }

    private func stopWatching(_ path: String) {
        watchers.removeValue(forKey: path)?.stop()
        diskBaselines.removeValue(forKey: path)
    }

    /// **The watcher's handler — one debounced fire, one stat, one decision.** Internal, not private,
    /// and deliberately synchronous (unlike `EditorRuntime.fileChangedOnDisk`, which is `async`
    /// because it reads a whole file off-actor): `officeFileStat` is a single `stat(2)` call, cheap
    /// enough to make right here, which also means there is no cross-actor gap in which the world
    /// could move again before this finishes — no generation counter is needed the way the editor's
    /// `watchGenerations` is.
    ///
    /// **No suppression bag** (T8 brief, verbatim): Stage A never writes an office file from the app,
    /// so there is no "was this our own save landing" question to ask — the editor's
    /// `noteExpectedWrite`/`consumeExpectedWrite`/`editorDiskChange`-with-`expectedWrites` machinery
    /// has nothing to filter here yet. Recorded at this exact seam so Stage B (once save exists)
    /// inherits that pattern KNOWINGLY rather than rediscovering it under a live bug report.
    ///
    /// **Still filters NOISE, though — this is not "any fire reloads."** The directory source this
    /// watcher includes (`DispatchSourceFileWatcher`'s own doc) fires for ANY entry changing in the
    /// same directory, not just `path` itself — a sibling file the agent also touched, or (T3's own
    /// disclosed, now independently confirmed concern) a LOK lock file (`.~lock.<name>#`) churning
    /// beside the document on every open/close. `officeDiskChange` compares `path`'s OWN stat against
    /// what this runtime last saw for it — a sibling's or a lock file's churn touches neither, so it
    /// reads `.unchanged` and this returns having done nothing, exactly as it must.
    func fileChangedOnDisk(_ path: String) {
        guard state.documents[path] != nil else { return }
        let stat = officeFileStat(atPath: path)
        switch officeDiskChange(stat: stat, baseline: diskBaselines[path]) {
        case .unchanged:
            return
        case .external:
            // Recorded BEFORE the dispatch, exactly like `EditorRuntime.fileChangedOnDisk`'s own
            // ordering and for the identical reason: whatever the reducer (and, downstream, the
            // reload) does with this, THIS is what the file now holds, and the NEXT fire — including
            // one that arrives while this reload is still in flight — must be measured against it,
            // not against a baseline this reload has already superseded.
            diskBaselines[path] = stat
            perform(dispatch(.externalChangeDetected(path: path)))
        case .deleted:
            // Cleared, not left stale: Swift knows nothing about the contents of a file that is not
            // there, and clearing this is what makes the file COMING BACK a change again even if it
            // comes back byte-for-byte identical to what this runtime last saw (mirrors
            // `EditorRuntime.fileChangedOnDisk`'s identical `diskBaseline.removeValue`).
            diskBaselines.removeValue(forKey: path)
            perform(dispatch(.externalDeleted(path: path)))
        }
    }

    /// PURE: classifies an `OfficeHelperClient` failure into the short sentence
    /// `.openFailed`/`.emitBanner` show. `.openFailed(reason:)` already carries the helper's own
    /// text; everything else (a timeout, a protocol-level refusal, an unexpected reply shape) is
    /// this runtime's own connection trouble, not a fact about the document.
    private static func describe(_ error: Error) -> String {
        if let clientError = error as? OfficeHelperClientError, case .openFailed(let reason) = clientError {
            return reason
        }
        return (error as? CustomStringConvertible)?.description ?? "the office helper request failed"
    }
}

// MARK: - The shared client's request funnel

/// Office Stage A Task 5 — serializes every call this app makes into the ONE shared
/// `OfficeHelperClient`. `OfficeHelperClient.expectReply(seq:)` is a single-outstanding-request
/// waiter (`OfficeHelperSupervisor`'s own header: "single-outstanding-request contract, seq
/// allocator NOT thread-safe") — two overlapping calls on the same connection have no way to tell
/// each other's replies apart, so the SECOND call's `expectReply` can consume the FIRST call's
/// answer (or vice versa), silently misattributing one and leaving the other awaiting a reply that
/// already arrived and was thrown away.
///
/// This is reachable the ORDINARY way, not just across sessions: two quick clicks on two different
/// files in the SAME session's Files tree are two concurrent `OfficeRuntime.open()` calls the
/// moment T6 wires a door to call it — the first `driver.open` has not resumed before the second
/// fires. Every `OfficeRuntime` sharing the app-wide client routes its Driver calls through ONE
/// queue instance (`ShellSessionHost.officeRequestQueue`) rather than calling the client directly.
///
/// **No cancellation semantics, and none are needed**: a torn-down runtime's own in-flight call
/// still runs to completion through this queue (nothing here knows or cares that its caller went
/// away) — `OfficeRuntime`'s own generation guard (`perform(_:)`'s `.helperOpen` case) is what
/// absorbs a stale resume, not this queue.
///
/// **Never call `run` from inside an operation** (T5 review M3): the inner call awaits the outer's
/// own tail, which is the outer call itself still in flight — a nested call deadlocks all office I/O
/// permanently, not just the nested pair, since every later `run` also enqueues behind the same
/// stuck `tail`.
@MainActor
final class OfficeHelperRequestQueue {
    private var tail: Task<Void, Never> = Task {}

    /// Runs `operation` only after every previously-enqueued operation has finished — success or
    /// throw, in the order they were enqueued.
    func run<T>(_ operation: @escaping () async throws -> T) async throws -> T {
        let previous = tail
        var outcome: Result<T, Error>!
        let current = Task {
            _ = await previous.value
            do {
                outcome = .success(try await operation())
            } catch {
                outcome = .failure(error)
            }
        }
        tail = current
        await current.value
        return try outcome.get()
    }
}
