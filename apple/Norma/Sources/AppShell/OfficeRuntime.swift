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

/// **Office Stage B Task 2 — the suppression bag arrives, and this classifier grows the `.ours`
/// case Task 8's own header said it did not need yet.** Now a three-way fork mirroring
/// `EditorDiskChange` exactly (minus `.external`'s carried text — Stage A/B documents are binary,
/// so there is nothing to diff, only whether to reload): a save writes the file this runtime is
/// watching, so the watcher armed for `path` will see an event for a change it already knows
/// about, and a MATCHING RECORDED IDENTITY (Task 2b's own fix — see this function's own doc) is
/// how this classifier tells that apart from a genuine external change.
enum OfficeDiskChange: Equatable {
    /// The stat is exactly what this runtime already knew — the overwhelmingly common answer: a
    /// sibling file changing in the same watched directory, a LOK lock file churning beside the
    /// document (T3's own disclosed concern), a `touch` with no real content change.
    case unchanged
    /// Different from the baseline, and the observed bytes DEFINITIVELY match one of this
    /// runtime's own outstanding saves' own RECORDED identity — the echo of that save's own rename
    /// reaching the watcher before (or instead of) the save's own baseline re-seed ran. The caller
    /// consumes ONE note (`OfficeRuntime.consumeExpectedWrite`) and stays silent — mirrors
    /// `EditorDiskChange.ours`/`editorDiskChange`'s identical reasoning, verbatim.
    case ours
    /// Different, and NOT proven to be any of this runtime's own outstanding saves. The agent,
    /// another editor, `git checkout` — Stage A/B cannot tell which, and (Task 2b) a conflict is
    /// exactly the tool for not knowing which.
    case external
    case deleted
}

/// **Task 2b (N1 fix, round-2 re-review) — a note merely being PENDING is no longer sufficient to
/// call a fire `.ours`.** Ordered content-first, deliberately, mirroring `editorDiskChange`'s own
/// ordering and its own stated reason: the baseline is a fact about BYTES and identity is a fact
/// about a SPECIFIC save's own proven output, and bytes are the stronger evidence.
///
/// **The pre-Task-2b version of this function gated on `expectedWrites: Int > 0` alone — blind to
/// WHICH write, if any, actually explains the observed bytes.** N1 (the round-2 re-review, found
/// PRE-EXISTING, assigned to this task): "a genuinely external write that lands while any note is
/// pending is silently swallowed, not classified `.external`... there's no `else` fallback in the
/// `.ours` case to re-classify a non-matching fire" — a save in flight (its own note noted, its own
/// identity not yet recorded) made EVERY fire for `path` read `.ours`, including one that had
/// nothing to do with that save. The fix: `.ours` now requires `matchesPendingIdentity` — TRUE only
/// when the observed `stat` exactly equals some outstanding note's own RECORDED identity
/// (`OfficeRuntime.hasPendingIdentity(for:matching:)`, non-mutating). A note whose identity is
/// still `nil` (its own rename has not yet been confirmed by ITS OWN save's continuation) can never
/// satisfy this — so a fire arriving in that in-between window now reads `.external`, not `.ours`.
///
/// **This can produce a rare, SELF-HEALING false positive**, disclosed rather than chased away: if
/// the fire genuinely IS that same in-flight save's own rename, arriving on `@MainActor` just
/// ahead of that save's own continuation (a scheduling race, not a logic bug — the underlying
/// `rename(2)` already happened; only the BOOKKEEPING has not caught up), this reads `.external`
/// for one beat. On a clean document that means one redundant re-stage of content that was already
/// correct (wasteful, not wrong). On a dirty document it means a conflict banner flashes up — and
/// is then immediately resolved, because that same save's OWN `.saveSucceeded` (moments later)
/// unconditionally clears any standing conflict for `path` (`OfficeRuntimeReducer`'s own arm,
/// mirroring `EditorConflictReducer`'s identical "a successful save IS the mine-wins answer" rule).
/// **The alternative — favoring the old blind-count design — is not a smaller false-positive rate,
/// it is trading a self-healing flicker for N1's own silent, PERMANENT data loss**: a genuine
/// external write landing in that same window, misread as `.ours`, is never surfaced at all, and
/// the next save from Norma's own in-memory copy silently clobbers it. Given that trade, favoring
/// `.external` on anything less than a proven match is the only defensible default.
func officeDiskChange(stat: OfficeFileStat?, baseline: OfficeFileStat?, matchesPendingIdentity: Bool) -> OfficeDiskChange {
    guard let stat else { return .deleted }
    if let baseline, stat == baseline { return .unchanged }
    return matchesPendingIdentity ? .ours : .external
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
        /// Office Stage B Task 2b — the Collabora jail: where THIS docId is actually loaded from
        /// inside the helper's own write fence (`<state-path>/docs/<docId>.<ext>`), never the real
        /// path. Every app-facing surface keeps speaking `path` (the dictionary key, unchanged) —
        /// this field exists purely so `performSave` knows what to place FROM, and so the sweep
        /// (close/reload/teardown/death) knows what to delete. Recorded once, at `.opened` time,
        /// from the same staging copy `OfficeRuntime.openAndDispatch` made before ever sending the
        /// wire `open` — see `OfficeRuntime.stageDocument`'s own header.
        var stagedPath: String
        var type: OfficeDocumentKind
        var parts: Int
        /// Which part (sheet/slide/page) a viewport last asked to see — T6's part-navigation strip
        /// reads this; T5 only ever WRITES it, as a side effect of `.subscribeRequested` (the one
        /// event that carries a part number in Stage A). Defaults to 0 — the first part — since
        /// nothing has asked for anything else yet at open time.
        var activePart: Int = 0
        var sizeTwips: OfficeDocumentSize
        /// Office Stage B Task 2 — mirrors LOK's own `.uno:ModifiedStatus` truth, and nothing else:
        /// driven PURELY by the `.modifiedStatusChanged` event this reducer's own arm below applies
        /// (routed from the real `LOK_CALLBACK_STATE_CHANGED` firing, via `ShellSessionHost
        /// .wireOfficeTileCallbacks`'s `onDocumentEvent` wiring) — never set optimistically by a
        /// successful save, the same "nothing here clears a dirty dot" posture
        /// `EditorSaveCoordinator`'s own header states for the editor's identical dot. Defaults
        /// `false`: a document that just opened has nothing unsaved yet.
        var dirty: Bool = false
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
    /// **Office Stage B Task 2b — the conflict this task's own brief owns**: a DIRTY document whose
    /// real file changed or vanished out from under it. Deliberately a SEPARATE dictionary from
    /// `documentBanners` (not a richer value type unifying the two, the way `EditorTabBanner` does
    /// for the editor) — `OfficeRuntimeLiveTests`' own protected tripwire reads
    /// `documentBanners[docPath] ?? "nil"` as a `String?` inside an assertion message, so widening
    /// that dict's value type would force a code edit to a file this task may only comment-edit.
    /// The view is what decides precedence (a standing conflict wins over a plain sentence) — see
    /// `PanelDocumentTabModel.banner`/`.conflict`'s own doc; the reducer never needs to arbitrate
    /// between the two dicts itself. Cleared by whatever RESOLVES the conflict (`.conflictReload
    /// Requested`, `.conflictKeepMineRequested`, a successful save — mirrors `EditorConflictReducer`
    /// .reduce`'s `.reloadChosen`/`.keepChosen`/`.saveSucceeded` trio) and by the ordinary document-
    /// lifecycle exits every OTHER per-path dictionary here already clears on (`.opened`,
    /// `.closeRequested`, `.reloadFailed`, `.helperDied`/`.helperUnavailable`, `.teardownRequested`).
    var documentConflicts: [String: OfficeConflictKind] = [:]
}

/// Office Stage B Task 2b — mirrors `EditorConflictKind` exactly: two kinds because the ACTIONS
/// differ, which is the only reason a state ever splits. `.changed` offers Reload/Keep mine;
/// `.deleted` has nothing to reload TO, so it offers Keep mine/Close instead (the brief's own
/// wording) — never a Reload button.
enum OfficeConflictKind: Equatable {
    case changed
    case deleted
}

// MARK: - Office Stage B Task 2b: the conflict banner's copy, in one place

let officeConflictChangedMessage = "Changed on disk"
let officeConflictDeletedMessage = "Deleted on disk"
let officeConflictDeletedDetail = "Saving will write it back."
let officeConflictReloadTitle = "Reload from disk"
let officeConflictKeepTitle = "Keep my version"
let officeConflictCloseTitle = "Close"

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
    /// **Office Stage B Task 2b** — `stagedPath` is new: where this docId actually lives inside the
    /// helper's fence, minted and copied to by `OfficeRuntime.openAndDispatch` BEFORE the wire
    /// `open` this event answers was even sent. See `DocumentEntry.stagedPath`'s own doc.
    case opened(path: String, docId: String, stagedPath: String, metadata: OfficeDocumentMetadata)
    /// A `.helperOpen` reached the helper and it refused (garbage file, unreadable path, ...) — see
    /// `OfficeHelperClientError.openFailed`, the shape the imperative half classifies this from.
    case openFailed(path: String, reason: String)
    case closeRequested(path: String)
    /// T6's tile door: a viewport wants to see `part` of `path`. Thin at T5 — this event only
    /// updates `activePart` and asks the helper; T6 owns everything about what the viewport
    /// coordinates mean and what it does with the returned tile keys.
    case subscribeRequested(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    case unsubscribeRequested(path: String)

    // MARK: Office Stage B Task 2 — saving

    /// ⌘S (or any other trigger) asks to save `path`'s current document. A no-op outside `.ready`
    /// or for a path with no open document — mirrors `.subscribeRequested`'s own guard exactly:
    /// there is nothing to save if the helper does not currently hold this path open.
    case saveRequested(path: String)
    /// The app finished placing the helper's rendered temp file onto the real document path.
    /// Carries `docId`, not just `path` — the stale-save guard `.reloadFailed` already established:
    /// a reload or a close can replace or remove this path's docId while the round trip was in
    /// flight, and this event answers whichever docId's OWN save actually completed, checked
    /// against whatever `documents[path]` holds NOW (see this reducer's own arm).
    case saveSucceeded(path: String, docId: String)
    /// The save failed — either the helper's own `saveAs` failed, or the app's atomic place did.
    /// Same stale-docId guard as `saveSucceeded`.
    case saveFailed(path: String, docId: String, reason: String)
    /// LOK's `.uno:ModifiedStatus` callback fired for `docId` — routed here by docId, never path
    /// (the push itself carries only `docId`; this reducer already knows the docId->path mapping
    /// via `documents`, the identical lookup `ShellSessionHost.officeRuntime(owning:)` does one
    /// level up for tile pushes, moved down into the reducer here because `documents` IS the
    /// reducer's own state).
    case modifiedStatusChanged(docId: String, modified: Bool)

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

    // MARK: Office Stage B Task 2b — resolving a standing conflict

    /// The conflict banner's "Reload from disk" — discard my edits, re-stage the current bytes
    /// under a fresh docId. Legal for either `OfficeConflictKind`, though the UI only ever offers
    /// this button for `.changed` (there is nothing to reload TO for `.deleted`).
    case conflictReloadRequested(path: String)
    /// The conflict banner's "Keep my version" (both kinds) — dismiss; the next ⌘S overwrites
    /// whatever the real path now holds (or recreates it, for `.deleted`).
    case conflictKeepMineRequested(path: String)
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
    /// Office Stage B Task 2 — render+place `docId` (the path's docId at the moment `.saveRequested`
    /// was dispatched) onto `path`. The imperative performer is the WHOLE round trip: ask the
    /// helper (`driver.save`), then atomically place its answer — see `OfficeRuntime.performSave`'s
    /// own header for the two stale guards and the suppression-bag wiring this one effect stands
    /// for.
    case save(path: String, docId: String)
    /// Office Stage B Task 2b — remove `docId`'s own staged copy from `<state-path>/docs/`
    /// (whatever its extension — `OfficeRuntime.deleteStagedCopy`'s own glob-by-docId-prefix doc
    /// has why). Emitted by the reducer at every site a `DocumentEntry` is abandoned for good:
    /// `.closeRequested`, the two-reloads-race compensating close in `.opened`, a reload's own old
    /// docId (`.externalChangeDetected`/`.conflictReloadRequested`), and every open docId at
    /// `.helperDied`/`.helperUnavailable`/`.teardownRequested`. Never for the CURRENT docId of an
    /// still-open document — mirrors `.helperClose`'s own "only ever the docId being abandoned"
    /// discipline exactly, for the identical reason.
    case deleteStagedCopy(docId: String)
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

        case .opened(let path, let docId, let stagedPath, let metadata):
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
            // Task 2b: nor still showing a conflict — a fresh (re)open IS the resolution.
            next.documentConflicts.removeValue(forKey: path)
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
                docId: docId, stagedPath: stagedPath, type: metadata.type, parts: metadata.parts,
                activePart: previousActivePart, sizeTwips: metadata.sizeTwips)
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
                // Task 2b: and ITS OWN staged copy — the superseded entry's, never the fresh one's.
                effects.append(.deleteStagedCopy(docId: previousEntry.docId))
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
            next.documentConflicts.removeValue(forKey: path) // Task 2b: same — no path, no conflict about it
            guard let doc = state.documents[path] else { return (next, []) }
            next.documents.removeValue(forKey: path)
            // Task 8: the watch goes with the document — "a watcher exists exactly while a document
            // does" is an invariant of this reducer, mirroring `EditorRuntimeReducer.closeRequested`'s
            // identical one for models. Task 2b: and so does its own staged copy.
            return (next, [.helperClose(docId: doc.docId), .unwatchFile(path: path),
                           .deleteStagedCopy(docId: doc.docId)])

        case .subscribeRequested(let path, let part, let zoomPPT, let viewportTwips):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            next.documents[path]?.activePart = part
            return (next, [.subscribe(docId: doc.docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)])

        case .unsubscribeRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            return (next, [.unsubscribe(docId: doc.docId)])

        // MARK: Office Stage B Task 2 — saving

        case .saveRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            return (next, [.save(path: path, docId: doc.docId)])

        case .saveSucceeded(let path, let docId):
            // The stale-save guard: only act if `path` still shows the very docId this save was
            // FOR. A close (documents[path] == nil) or a reload (a different docId) both fail this
            // check identically — either way there is nothing left here for a successful save of an
            // old docId to say anything about.
            guard state.phase == .ready, state.documents[path]?.docId == docId else { return (next, []) }
            // A file that was just placed on disk cannot still be saying it was deleted — the exact
            // claim `.opened`'s own banner-clear makes, one line up in this same file: a save is not
            // a reopen, but "this path exists and holds what was just written" is exactly as strong.
            next.documentBanners.removeValue(forKey: path)
            // **Task 2b — mirrors `EditorConflictReducer`'s own `.saveSucceeded` rule verbatim**:
            // "pressing ⌘S with a 'changed on disk' banner up IS the 'mine wins' answer, and the
            // file now holds exactly this buffer." Unconditional — resolves EITHER conflict kind,
            // and is also what makes N1's own rare false-positive (this SAME save's fire winning
            // the `@MainActor` race and misclassifying as `.external` a beat early) self-heal: the
            // conflict it spuriously raised is cleared the instant this save's own success lands.
            next.documentConflicts.removeValue(forKey: path)
            return (next, [])

        case .saveFailed(let path, let docId, let reason):
            guard state.phase == .ready, state.documents[path]?.docId == docId else { return (next, []) }
            let basename = (path as NSString).lastPathComponent
            let message = "Couldn't save \(basename): \(reason)"
            // Reuses `documentBanners` verbatim — that field's own Task 8 doc comment foretold
            // exactly this: "Stage B's first save-conflict banner reuses this field verbatim rather
            // than inventing a second one." A save failure and a delete-while-open both put ONE
            // sentence above the canvas that the NEXT successful (re)open/save clears; nothing about
            // either reason needs its own UI.
            next.documentBanners[path] = message
            return (next, [.emitBanner(reason: message)])

        case .modifiedStatusChanged(let docId, let modified):
            guard state.phase == .ready,
                  let path = state.documents.first(where: { $0.value.docId == docId })?.key else {
                return (next, [])
            }
            next.documents[path]?.dirty = modified
            return (next, [])

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
            // **Task 2b — the policy this task owns, superseding Stage A's own "always silent"
            // claim now that editing is real.** Stage A/T8's original words, kept for the
            // historical record: "Stage A is view-only — there is no dirty buffer to protect, so
            // unlike the editor's clean/dirty fork this is ALWAYS a silent reload; nothing here
            // ever shows a 'keep mine' choice, because Stage A never has a 'mine' to keep." That
            // stopped being true the moment a document could genuinely hold unsaved edits — a
            // silent reload now would be exactly the silent data loss the brief calls out by name.
            // CLEAN → unchanged behavior: re-stage (a fresh copy, a fresh docId) exactly as a plain
            // reload always has. DIRTY → no silent re-stage: raise a conflict instead, mirroring
            // `EditorConflictReducer.reduce`'s `.externalChange(dirty:)` arm exactly.
            guard doc.dirty else {
                return (next, [.reloadDocument(path: path, oldDocId: doc.docId)])
            }
            next.documentConflicts[path] = .changed
            return (next, [.emitBanner(reason: officeConflictChangedMessage)])

        case .externalDeleted(let path):
            // Task 2b: the SAME dirty/clean fork as `.externalChangeDetected` above, for deletion.
            guard let doc = state.documents[path] else { return (next, []) }
            guard doc.dirty else {
                // **Deleted → banner that PERSISTS, view-only so nothing to lose** (Stage A/T8's own
                // words, still true for a CLEAN document): the document entry is left completely
                // untouched — the tab keeps showing its last rendered tiles, exactly as they were,
                // with this sentence overlaid above them.
                let reason = "File was deleted on disk"
                next.documentBanners[path] = reason
                return (next, [.emitBanner(reason: reason)])
            }
            // DIRTY: same "must not discard silently" rule as `.changed` — the brief's own words:
            // "for dirty docs it must ALSO not discard silently — same conflict pattern, actions
            // 'Keep my version' (⌘S will recreate) and 'Close'."
            next.documentConflicts[path] = .deleted
            return (next, [.emitBanner(reason: officeConflictDeletedMessage)])

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
            // Task 2b: a reload that failed to even land cannot still be showing a conflict about
            // whatever it was replacing — mirrors the `documentBanners` clear two lines below.
            next.documentConflicts.removeValue(forKey: path)
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
            // Task 2b (I3): every open document's own staged copy dies with it here too — the SAME
            // "every open path is its own effect, decided entirely inside the reducer" reasoning the
            // paragraph above already gives for `.unwatchFile`. Sorted by PATH (not docId — paths are
            // this reducer's own stable, orderable key) for the identical determinism reason.
            let staleCopyEffects = state.documents.keys.sorted()
                .map { OfficeRuntimeEffect.deleteStagedCopy(docId: state.documents[$0]!.docId) }
            return (fresh, [.emitBanner(reason: reason)] + unwatchEffects + staleCopyEffects)

        case .teardownRequested:
            // From every phase, including `.idle` — the effect is emitted unconditionally so the
            // imperative half has one path to run (idempotent), and so "teardown from anywhere
            // releases the slot" is a claim the tests can make about the reducer alone. Every open
            // docId is handed to the imperative half to close; NEVER the shared helper process
            // itself (see `.teardown`'s own doc).
            let docIds = state.documents.values.map(\.docId)
            // Task 2b (I3): and every one of THOSE docIds' own staged copies — teardown is exactly
            // as much "release everything this runtime holds" for `docs/` as it already is for the
            // helper's own open handles. Sorted for the same determinism reason as `docIds` itself
            // would want if it were ever asserted order-sensitively.
            let staleCopyEffects = docIds.sorted().map { OfficeRuntimeEffect.deleteStagedCopy(docId: $0) }
            return (OfficeRuntimeState(), [.teardown(docIds: docIds)] + staleCopyEffects)

        // MARK: Office Stage B Task 2b — resolving a standing conflict

        case .conflictReloadRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            next.documentConflicts.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path)
            // The SAME reload machinery a clean document's silent external-change path already
            // uses — discard my edits, re-stage the current on-disk bytes under a fresh docId.
            return (next, [.reloadDocument(path: path, oldDocId: doc.docId)])

        case .conflictKeepMineRequested(let path):
            guard state.phase == .ready, state.documents[path] != nil else { return (next, []) }
            // Dismiss — nothing else moves. The document stays exactly as it is (still dirty, still
            // showing its in-memory edits); the next ⌘S is what actually overwrites/recreates the
            // real path, exactly as `.saveSucceeded`'s own arm already resolves a conflict.
            next.documentConflicts.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path)
            return (next, [])
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
        /// Office Stage B Task 2 — asks the shared helper to render `docId` to a temp file under
        /// ITS OWN `--state-path`, returning that file's path. Throws exactly like `open` (a
        /// `saveFailed`/`serverError`/timeout all propagate) — `perform(_:)`'s `.save` case is what
        /// turns a throw here into `.saveFailed`, never a crash. Routed through
        /// `ShellSessionHost.officeRequestQueue` in production, on the SAME terms as every other
        /// Driver call.
        var save: (_ docId: String) async throws -> String
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
        /// Office Stage B Task 4 — the real edit verbs. Never throws to `OfficeRuntime` — same
        /// fire-and-forget posture `close`/`unsubscribeTiles` already have (a keystroke that fails
        /// to post has no recovery action a caller could usefully take; the production
        /// implementation logs it, matching `close`'s own "fire-and-forget is not the same as
        /// silent" discipline). Routed through `ShellSessionHost.officeRequestQueue` in production,
        /// on the SAME terms as every other Driver call — see `OfficeRuntime.postKeyEvent`'s own
        /// header for why ORDERING across this queue (not merely eventual delivery) is load-bearing
        /// here in a way none of the other Driver calls need.
        /// Fix round 1, F2 — `part` added. See `OfficeRuntime.postKeyEvent`'s own header for where
        /// it is resolved (`activePart`, at enqueue time, the same reducer-owned value
        /// `subscribeTiles` already scopes painting by).
        var postKey: (_ docId: String, _ part: Int, _ type: OfficeKeyEventType, _ charCode: Int, _ keyCode: Int) async -> Void
        var postMouse: (_ docId: String, _ part: Int, _ type: OfficeMouseEventType, _ xTwips: Int64, _ yTwips: Int64,
                        _ count: Int, _ buttons: Int, _ modifiers: Int) async -> Void
        /// **Office Stage B Task 2b — the shared helper's own `--state-path`.** A plain stored
        /// value, unlike every sibling above: it is a FACT about the shared supervisor's
        /// configuration (`OfficeHelperSupervisor.statePath`, exposing `Configuration
        /// .socketDirectory` — the same directory already handed to the helper as `--state-path`),
        /// fixed for that supervisor's whole lifetime, not a call that can fail or race a relaunch
        /// the way `client` does. `openAndDispatch` derives `docsDirectory` from this and stages
        /// every document INTO it, `<stateDirectory>/docs/<docId>.<ext>`, before ever sending the
        /// wire `open` — see `OfficeRuntime.stageDocument`'s own header. **Must be the LIVE
        /// supervisor's own configured directory, never `Configuration.defaultStateDirectory()`
        /// read fresh** — a live test that points `socketDirectory` at a scratch dir (every one of
        /// them does) would otherwise stage outside that scratch helper's own write fence, and the
        /// resulting `open` would fail for a reason that has nothing to do with whatever the test
        /// itself is trying to prove.
        var stateDirectory: URL
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

    /// **Office Stage B Task 2b — where every staged copy this runtime creates actually lives.**
    /// `docs`, sibling to `saves` (Task 2's) and `lok-profile-*` (LOKBridge's) under the same
    /// `--state-path` — computed once from `driver.stateDirectory`, never re-derived per open.
    private var docsDirectory: URL { driver.stateDirectory.appendingPathComponent("docs", isDirectory: true) }

    /// **Carry 6's belt: bumped by `teardown()`, checked by every in-flight `.helperOpen` before it
    /// dispatches its result.** Mirrors `OfficeHelperSupervisor.generation`'s own reasoning exactly:
    /// `teardown()` resets `state` to a value that is BYTE-IDENTICAL to a runtime that was simply
    /// never started, so a phase check alone cannot tell "this specific open was superseded" apart
    /// from "this runtime never asked for anything." A stale open that resumes after a teardown must
    /// neither resurrect the torn-down runtime NOR orphan the document it just opened on the shared
    /// helper — see `perform(_:)`'s `.helperOpen` case for both halves.
    private(set) var generation = 0

    /// Office Stage B Task 4 — the input-ordering chain `postKeyEvent`/`postMouseEvent` build on;
    /// see that method's own header for the full reasoning. `@MainActor`-isolated (this whole class
    /// is), matching `OfficeHelperRequestQueue.tail`'s identical shape and identical reasoning.
    private var inputChainTail: Task<Void, Never> = Task {}

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

    /// Office Stage B Task 2 — save `path`'s currently open document. Fire-and-forget, exactly like
    /// `open`/`close`/`subscribeTiles` — never sequence off this call returning; observe
    /// `state.documents[path].dirty` and `state.documentBanners[path]` instead. A no-op for a path
    /// with no open document (mirrors `.subscribeRequested`'s own reducer guard).
    func save(_ path: String) {
        perform(dispatch(.saveRequested(path: path)))
    }

    /// Office Stage B Task 3 — **the dirty-close sheet's own door.** `save(_:)` above is deliberately
    /// fire-and-forget (its own doc: "never sequence off this call returning"), which is right for
    /// ⌘S and the save button — but the close-sheet's Save choice needs the ACTUAL outcome to decide
    /// between closing the tab and leaving it open with the failure banner showing
    /// (`dirtyCloseActionAfterSave`'s own contract, `PanelEditorTab.swift`). Rather than reconstruct
    /// that outcome by diffing `$state` from the outside — which cannot be made correct (see below) —
    /// this is a second, awaitable door onto the exact same `.saveRequested`/`performSave` machinery,
    /// resolved by `performSave` itself at the moment it already knows the answer.
    ///
    /// **Why not infer the outcome from `dirty`/`documentBanners` externally, the way a first design
    /// of this door tried:** two holes, both real. (1) LOK's `ModifiedStatus=false` fires helper-side
    /// the instant the helper's OWN `saveAs` completes — *before* `performSave`'s own `placeAtomically`
    /// ever runs on this side. If the place then fails (disk full, permissions), an outside observer
    /// watching `dirty` would already have seen it flip false and would report `.saved` for a save
    /// that in fact never reached the real path — exactly the "saveFailed → close cancelled" case the
    /// brief names, inverted into a silent data-loss close. (2) A retried save that fails with the
    /// SAME reason writes the identical string into `documentBanners[path]` a second time — no
    /// observable transition for an outside `$state` diff to catch, so it would simply never resolve.
    /// This door has neither hole: it is resolved at the exact two `perform(dispatch(...))` call sites
    /// inside `performSave` that already know, authoritatively, which of the two happened.
    ///
    /// **Reuses `SaveOutcome`** (`EditorSaveCoordinator.swift`) rather than inventing an office-shaped
    /// twin — the shape (`.saved`/`.failed(String)`/`.noModel`) is generic to "did a save succeed",
    /// not editor-specific, and reusing it is what lets `dirtyCloseAction`/`dirtyCloseActionAfterSave`
    /// (`PanelEditorTab.swift`) drive BOTH tab kinds' close gates verbatim, with no second decision
    /// layer to write or keep in sync.
    ///
    /// `.noModel` mirrors `EditorSaveCoordinator.performSave`'s own gate: answered here, directly,
    /// without ever registering a waiter, whenever dispatching `.saveRequested` produces no `.save`
    /// effect (not `.ready`, or no open document for `path`) — read from the dispatch's own returned
    /// effects rather than a hand-duplicated copy of the reducer's guard, so the two can never drift.
    func saveAndAwaitOutcome(_ path: String) async -> SaveOutcome {
        await withCheckedContinuation { continuation in
            let effects = dispatch(.saveRequested(path: path))
            guard case .save(_, let docId)? = effects.first else {
                perform(effects) // always `[]` here, but keeps the dispatch/perform pairing uniform
                continuation.resume(returning: .noModel)
                return
            }
            saveWaiters[path, default: []].append(SaveWaiter(docId: docId, continuation: continuation))
            perform(effects)
        }
    }

    /// One `saveAndAwaitOutcome` caller, still waiting. Kept per PATH (a table, not a single slot) —
    /// two overlapping close-sheet saves for two DIFFERENT documents are legal and independent, the
    /// same reasoning `EditorSaveCoordinator.waiters`' own per-seq table gives; unlike that type this
    /// one does not also COALESCE two callers for the same path onto one save, since the only
    /// caller today (the close sheet) can never fire twice for the same tab.
    private struct SaveWaiter {
        /// The docId `.saveRequested` resolved AT DISPATCH TIME — never re-read later, so a reload or
        /// close that swaps or removes `documents[path]` after this waiter was registered cannot be
        /// mistaken for the save this waiter is actually about (mirrors the reducer's own `.saveSucceeded`
        /// /`.saveFailed` stale-docId guards, applied one layer up).
        let docId: String
        let continuation: CheckedContinuation<SaveOutcome, Never>
    }
    private var saveWaiters: [String: [SaveWaiter]] = [:]

    /// Resolve every waiter registered for this EXACT `(path, docId)` pair, and only those — a waiter
    /// for a DIFFERENT docId at the same path (a save superseded by a reload, still pending) is left
    /// untouched, since it is not this call's to answer. Idempotent by construction: called again for
    /// a pair nothing is waiting on (the ordinary case — most saves have no `saveAndAwaitOutcome`
    /// caller at all) it simply finds nothing and does nothing, which is what makes it safe to call
    /// from every one of `performSave`'s exits, including the ones that also run after
    /// `performTeardown`'s own flush (below) has already resolved everything.
    private func resumeSaveWaiters(path: String, docId: String, outcome: SaveOutcome) {
        guard let waiters = saveWaiters[path] else { return }
        let matching = waiters.filter { $0.docId == docId }
        let remaining = waiters.filter { $0.docId != docId }
        if remaining.isEmpty { saveWaiters.removeValue(forKey: path) } else { saveWaiters[path] = remaining }
        for waiter in matching { waiter.continuation.resume(returning: outcome) }
    }

    /// Office Stage B Task 2b — the conflict banner's "Reload from disk": discard my edits, re-stage
    /// the current on-disk bytes under a fresh docId. A no-op unless `path` currently has an open
    /// document (mirrors every other door's reducer-level guard).
    func reloadFromDisk(_ path: String) {
        perform(dispatch(.conflictReloadRequested(path: path)))
    }

    /// Office Stage B Task 2b — the conflict banner's "Keep my version" (both kinds: changed and
    /// deleted): dismiss the conflict; the next ⌘S overwrites or recreates the real path.
    func keepMyVersion(_ path: String) {
        perform(dispatch(.conflictKeepMineRequested(path: path)))
    }

    /// T6's tile door. Thin here — see `OfficeRuntimeEvent.subscribeRequested`'s own doc.
    func subscribeTiles(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect) {
        perform(dispatch(.subscribeRequested(path: path, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)))
    }

    func unsubscribeTiles(path: String) {
        perform(dispatch(.unsubscribeRequested(path: path)))
    }

    /// Office Stage B Task 4 — **the real edit door.** Synchronous, fire-and-forget, exactly like
    /// `open`/`close`/`subscribeTiles` above (never sequence off this call returning) — but with a
    /// STRICTER ordering guarantee none of those siblings need: keystrokes must reach LOK in the
    /// order the user typed them, or "hello" can arrive as "hlelo". Bypasses `dispatch`/`perform`
    /// entirely (`prefetchTilesChunk`'s own precedent: an input post touches no reducer state).
    ///
    /// **Why a hand-rolled chain here, not simply `Task { await driver.postKey(...) }` per call**:
    /// two independent unstructured `Task`s created back-to-back from `keyDown`/`keyUp` have NO
    /// language-level guarantee of running in creation order — Swift's concurrency model guarantees
    /// actor REENTRANCY safety, never submission-order execution for separately-created `Task`s,
    /// even from the same synchronous caller. `inputChainTail` closes this the same way
    /// `OfficeHelperRequestQueue.run` already does for the shared request queue: capture the
    /// PREVIOUS tail synchronously, build a new `Task` that awaits it before doing its own work,
    /// reassign the tail — all synchronous, no `await` in between. Since `keyDown` for keystroke
    /// N+1 cannot even be DISPATCHED by AppKit until keystroke N's own `keyDown` call has fully
    /// returned (single-threaded, serial event dispatch), and this method's own capture-and-
    /// reassign prefix is unconditionally synchronous, the chain is correctly ordered by
    /// CONSTRUCTION — a data dependency, not a scheduling assumption.
    ///
    /// One chain covers BOTH key and mouse posts (not two independent ones) — click-then-type
    /// ordering matters exactly as much as keystroke-to-keystroke ordering (positioning the cursor
    /// before typing into it is meaningless if the type can race ahead of the click).
    ///
    /// `docId` resolved HERE, at enqueue time — mirrors `SaveWaiter`'s own "resolved at dispatch
    /// time" precedent (`saveAndAwaitOutcome`'s own doc): a stale keystroke against a path whose
    /// document reloaded or closed between the keystroke and its turn in the chain still targets
    /// the ORIGINAL docId it was meant for, which the helper answers `docNotOpen` for — logged,
    /// harmless, never misdirected at whatever NEW docId happens to occupy `path` by the time this
    /// runs.
    ///
    /// **Fix round 1, F2 (CRITICAL) — `part` resolved the SAME way, at the SAME moment, from the
    /// SAME `state.documents[path]` read as `docId` above.** Before this fix, input carried no part
    /// at all — a keystroke posted while viewing sheet 2 could silently land on whatever part LOK's
    /// own internal state happened to have current (never communicated over this wire), persisted by
    /// save, with no visible repaint to notice by; painting was already part-scoped
    /// (`subscribeTiles`/`.subscribe`'s own `part` argument), input was the live gap. `activePart`
    /// is the SAME reducer-owned value `.subscribeRequested` already writes and `.subscribe` already
    /// reads — resolving it here, at enqueue time, extends the identical stale-keystroke reasoning
    /// `docId` already gets: a keystroke aimed at part 1 stays aimed at part 1 even if the user
    /// switches parts before this keystroke's own turn in the chain arrives — it was typed while
    /// part 1 was on screen, and that is where it belongs, not wherever the viewport has since moved
    /// to. (There is no analogous "part closed/reloaded out from under it" case the way a `docId`
    /// can go stale — a part number is just an index; the helper's own `docNotOpen` still covers the
    /// `docId`-level staleness this shares with `postKeyEvent`'s existing guard.)
    func postKeyEvent(path: String, type: OfficeKeyEventType, charCode: Int, keyCode: Int) {
        guard let doc = state.documents[path] else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.postKey(docId, part, type, charCode, keyCode)
        }
    }

    /// Office Stage B Task 4 — same door, same ordering chain, for `postMouseEvent`. See
    /// `postKeyEvent`'s own header for the full reasoning; this is not independently re-explained.
    func postMouseEvent(path: String, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                        count: Int, buttons: Int, modifiers: Int) {
        guard let doc = state.documents[path] else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.postMouse(docId, part, type, xTwips, yTwips, count, buttons, modifiers)
        }
    }

    /// Test-only: awaits the current tail of the input-ordering chain, so a test can know a
    /// `postKeyEvent`/`postMouseEvent` call has actually reached the driver before asserting on its
    /// effect, without a `waitUntil` poll racing the chain's own scheduling.
    func drainInputChainForTesting() async {
        await inputChainTail.value
    }

    /// office live-gate fix #3 — whole-document tile residency's own door. Unlike every other door
    /// on this object (deliberately fire-and-forget — see `open`/`close`/`subscribeTiles`'s own
    /// headers, and `OfficeRuntimeEffect`'s own "never sequence off this call returning" rule), THIS
    /// one is genuinely awaitable, and deliberately bypasses `dispatch`/`perform` entirely: unlike
    /// `.subscribe`, a prefetch carries no viewport and touches no reducer state (`activePart`,
    /// `documents`) — it is pure "go fetch these already-known keys," so there is nothing for the
    /// reducer to decide, and the value this call needs to provide (knowing when the SEND actually
    /// landed) has nothing to do with state transitions at all.
    ///
    /// **Why awaitable at all**: `OfficeTileCanvasView`'s chunked prefetch loop has to know when one
    /// chunk's own request has reached the helper (the `tileRequestAccepted` ack `requestNeeded`
    /// awaits internally) before deciding whether to move on to the next chunk — a synchronous,
    /// non-paced loop calling a fire-and-forget door N times in a row would enqueue every chunk on
    /// `officeRequestQueue` back-to-back, leaving no gap for a genuinely urgent viewport/close call
    /// to slot in ahead of the NEXT chunk (see that view's own `beginPrefetch` for the honest latency
    /// bound this actually buys, which is NOT preemption).
    ///
    /// `docId` is resolved FRESH from `path` on every call, never captured once by the caller, so a
    /// reload or close landing between two chunks is picked up automatically (a reload's new docId;
    /// a close's `state.documents[path] == nil` guard below, which simply no-ops). A stale
    /// PREFETCH SWEEP itself (superseded by a part switch, zoom change, or unmount) is not this
    /// method's problem to solve — the CALLER's own generation check (`OfficeTileCanvasView
    /// .prefetchGeneration`) is what stops issuing further chunks; a chunk already in flight when
    /// that happens is left to complete harmlessly, mirroring `OfficeHelperRequestQueue`'s own "no
    /// cancellation semantics, and none are needed."
    func prefetchTilesChunk(path: String, keys: [TileKey]) async {
        guard state.phase == .ready, let doc = state.documents[path] else { return }
        await requestNeeded(docId: doc.docId, candidates: keys)
    }

    /// Office Stage B Task 4 — **the other half of "a real edit reaches the screen," alongside
    /// `postKeyEvent`/`postMouseEvent` themselves.** `tileStore.invalidate` (wired from
    /// `ShellSessionHost.wireOfficeTileCallbacks`'s `onInvalidated`) only EVICTS — it has no wire
    /// access of its own to ask for a replacement, by design (the store's own header: it is a pure
    /// pixel pool, not a driver). Without this door, an edit on a STATIC viewport (the exact typing
    /// scenario — nothing else re-subscribes) leaves the canvas showing the placeholder tone
    /// forever: `performSubscribe` only fires from a scroll/zoom/part-switch/discrete action, never
    /// from a push arriving on a viewport that has not moved.
    ///
    /// Same shape as `prefetchTilesChunk` (bypasses `dispatch`/`perform` — an invalidation-driven
    /// re-fetch touches no reducer state, the identical reasoning that method's own header gives)
    /// and shares its exact dedup: `requestNeeded` is a no-op for a key already re-cached or already
    /// back in flight, so a caller does not need to pre-filter — the STORE decides what is actually
    /// worth asking for, including the one-shot `invalidatedWhileInFlight` window
    /// (`OfficeTileStore`'s own header) that can leave a just-invalidated key still blocked for a
    /// few more milliseconds after this call, harmlessly (this call's own `keysNeedingRequest` check
    /// simply excludes it; nothing here needs to know why).
    ///
    /// **Deliberately takes `keys` from the CALLER, never re-derives "which keys are visible"
    /// itself** — visibility is `OfficeTileCanvasView`'s own state (`tileLayers`), not this
    /// runtime's; see that view's `handleTilesArrived` for the one production call site, which
    /// narrows `invalidate`'s full key list down to the ones actually on screen before ever
    /// reaching here.
    func refetchInvalidatedTiles(path: String, keys: [TileKey]) async {
        guard state.phase == .ready, let doc = state.documents[path] else { return }
        await requestNeeded(docId: doc.docId, candidates: keys)
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

    /// Office Stage B Task 2 — **the dirty-tracking door**: fed by `ShellSessionHost
    /// .wireOfficeTileCallbacks`'s `onDocumentEvent` routing (that method's own doc explains why it,
    /// not a second wiring site, is where a fresh client's callbacks are re-pointed on every helper
    /// relaunch), by docId, the same way `officeRuntime(owning:)` routes tile pushes one level up.
    ///
    /// Only `.modifiedChanged` has anything for THIS door to do — `.invalidated` (the only other
    /// case Stage A/B's `LOKBridge` ever actually constructs, per `OfficeDocumentEvent`'s own
    /// header) is already routed separately, through `onInvalidated`/`OfficeTileStore.invalidate`;
    /// `.opened`/`.openFailed`/`.closed` are never sent this way at all in Stage A/B (their own
    /// direct, seq-correlated reply frames cover `open`/`close`). An unrecognized/irrelevant case
    /// here is silently ignored, the same "not every callback has Stage A/B meaning" posture
    /// `LOKBridge.handleCallback` already takes toward LOK's raw callback types one layer down.
    func handle(documentEvent event: OfficeDocumentEvent, docId: String) {
        guard case .modifiedChanged(let modified) = event else { return }
        perform(dispatch(.modifiedStatusChanged(docId: docId, modified: modified)))
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
                // Task 2b — and the old docId's own staged copy, the identical reasoning: grouped
                // here with the tile/close cleanup above rather than as a second reducer-emitted
                // effect, since both `.externalChangeDetected`'s silent-reload arm and
                // `.conflictReloadRequested`'s explicit one already funnel through this ONE
                // imperative site for the OLD docId's teardown.
                let docsDirectory = docsDirectory
                Task.detached(priority: .utility) {
                    Self.deleteStagedCopy(docId: oldDocId, docsDirectory: docsDirectory)
                }
                openAndDispatch(path: path, myGeneration: generation, reloadingDocId: oldDocId)

            case .save(let path, let docId):
                performSave(path: path, docId: docId, myGeneration: generation)

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
                // the current viewport needs — `requestNeeded` (below) is what actually asks for
                // their bytes, filtered through the store first (obligation 3). The two driver calls
                // are deliberately SEQUENTIAL `await`s, never composed inside one `officeRequestQueue
                // .run` — obligation 2, permanent deadlock otherwise.
                Task { [weak self, driver] in
                    guard let keys = try? await driver.subscribeTiles(docId, part, zoomPPT, viewportTwips) else {
                        return
                    }
                    guard let self else { return }
                    await self.requestNeeded(docId: docId, candidates: keys)
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

            case .deleteStagedCopy(let docId):
                // Office Stage B Task 2b — best-effort, off `@MainActor`: a directory listing plus
                // one removal is cheap, but this must never be what makes a close/reload/teardown
                // hitch the shell (mirrors `placeAtomically`'s own off-actor reasoning). Fire-and-
                // forget, like every other cleanup call this file makes elsewhere — nothing here can
                // fail in a way anything downstream needs to react to.
                let docsDirectory = docsDirectory
                Task.detached(priority: .utility) {
                    Self.deleteStagedCopy(docId: docId, docsDirectory: docsDirectory)
                }
            }
        }
    }

    /// Shared by `.subscribe`'s effect performer (server-reported viewport keys) and
    /// `prefetchTilesChunk` (canvas-computed whole-document prefetch keys, office live-gate fix #3):
    /// filter `candidates` to what the store doesn't already have or isn't already awaiting, mark
    /// in-flight SYNCHRONOUSLY, then ask the helper.
    ///
    /// **T6 review F2, re-reviewed**: the mark happens in the same uninterrupted stretch of
    /// MainActor code that decides to send — there is no `await` between `needed` being computed and
    /// `markRequested`, so nothing else on MainActor (an overlapping `subscribeTiles` from continuous
    /// scroll, most obviously — or, as of fix #3, an overlapping prefetch chunk) can interleave and
    /// see these keys as still unrequested. An earlier cut marked only after `driver.requestTiles`
    /// returned, which reopened exactly that window — the reviewer measured it empirically (a gated
    /// send + two overlapping subscribes produced two `requestTiles` calls for the same keys), and it
    /// collides with `keysNeedingRequest`'s own "big-batch amplifier" warning, one call and its
    /// retries compounding the shared queue's backlog. `catch` still frees the keys the moment a send
    /// actually fails — see `markRequested`'s own doc for why both halves are required.
    ///
    /// Fire-and-forget to its own caller, same as every other Driver call this file makes elsewhere —
    /// nothing here throws back out; `prefetchTilesChunk` and `.subscribe`'s Task both simply `await`
    /// this to know the send has been ATTEMPTED (queued and either accepted or failed), not that its
    /// tiles have arrived (those stream back independently via `onTile`/`tileStore.ingest`).
    private func requestNeeded(docId: String, candidates: [TileKey]) async {
        let needed = tileStore.keysNeedingRequest(docId: docId, candidates: candidates)
        guard !needed.isEmpty else { return }
        tileStore.markRequested(docId: docId, keys: needed)
        do {
            try await driver.requestTiles(docId, needed)
        } catch {
            for key in needed { tileStore.markFailed(docId: docId, key: key) }
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
        let stagedPath = Self.stagedPath(forDocId: docId, realPath: path, docsDirectory: docsDirectory)
        let docsDirectory = docsDirectory
        Task { [weak self, driver] in
            guard let self else { return }
            do {
                // **Office Stage B Task 2b — stage BEFORE the wire open.** The Collabora jail: this
                // app (unsandboxed, the trust boundary) copies `path` INTO the helper's own
                // `--state-path` first; the wire `open` below carries the STAGED path, never the
                // real one — the helper never touches, and never even learns, `path` itself from
                // here on. Off `@MainActor` — a real copy, mirrors `performSave`'s own
                // `Task.detached` around `placeAtomically` exactly, for the identical reason (a
                // large document must not stall the shell).
                try await Task.detached(priority: .userInitiated) {
                    try Self.stageDocument(realPath: path, stagedPath: stagedPath)
                }.value
                let metadata = try await driver.open(docId, stagedPath)
                guard myGeneration == self.generation else {
                    // Carry 6: teardown superseded this open while it was in flight. The document is
                    // now open on the shared helper with no owner left to close it — compensate
                    // rather than orphan it, INCLUDING the staged copy this attempt made. Never
                    // dispatch into the fresh state teardown just produced.
                    await driver.close(docId)
                    Task.detached(priority: .utility) { Self.deleteStagedCopy(docId: docId, docsDirectory: docsDirectory) }
                    return
                }
                self.perform(self.dispatch(.opened(path: path, docId: docId, stagedPath: stagedPath, metadata: metadata)))
            } catch {
                // Either the STAGE itself failed (the real path is unreadable, the disk is full —
                // nothing was ever staged, and `deleteStagedCopy` below is a harmless no-op against
                // a file that was never created) or the wire `open` did (a staged copy DOES exist
                // and is now an orphan nothing else will ever find — it was never recorded in
                // `documents`, so no later close/teardown/death sweep would ever reach it). One
                // best-effort cleanup call covers both (inert in the first case), off `@MainActor`
                // like every other staged-copy sweep in this file.
                Task.detached(priority: .utility) { Self.deleteStagedCopy(docId: docId, docsDirectory: docsDirectory) }
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

    /// Office Stage B Task 2 — **the whole save round trip**: ask the helper to render `docId`,
    /// then atomically place its answer onto `path`. `myGeneration` and `docId` together guard
    /// against everything that can move between the ask and the answer:
    ///
    ///   * **teardown** (`myGeneration != self.generation`) — carry 6's own guard, unchanged in
    ///     shape from `openAndDispatch`'s identical check;
    ///   * **a reload or a close mid-save** (`self.state.documents[path]?.docId != docId`) — this
    ///     flow's OWN guard, which `openAndDispatch` has no equivalent of: a reload mints a NEW
    ///     docId for `path` and a close removes it outright, either of which means the render this
    ///     save is holding describes a docId that is no longer `path`'s own — placing it would
    ///     silently regress a file a reload has already replaced with something newer, or resurrect
    ///     a file the user just closed the tab on.
    ///
    /// Neither guard treats a supersession as a FAILURE — nothing is logged, no `.saveFailed`
    /// dispatches, the same "moot, not wrong" posture carry 6's own compensating-close comment
    /// takes toward an open superseded by teardown. The helper's own temp render is deleted either
    /// way (best-effort — `saves/` would otherwise grow unboundedly across a long-lived helper's
    /// whole lifetime, the exact class of leak the `lok-profile-*` sweep in `LOKBridge` was written
    /// to close for a different directory).
    private func performSave(path: String, docId: String, myGeneration: Int) {
        Task { [weak self, driver] in
            guard let self else { return }
            do {
                let tempPath = try await driver.save(docId)
                guard myGeneration == self.generation, self.state.documents[path]?.docId == docId else {
                    // Task 2b: even if `tempPath` happens to be this (now-superseded) docId's own
                    // staged working copy, that exact file is independently swept by whatever
                    // superseded it (a reload's or a close's own `.deleteStagedCopy` effect, keyed
                    // by docId) — removing it again here is harmless, never a double-delete hazard
                    // (`try?`), and keeps this guard's shape identical to every other superseded-
                    // save path in this file.
                    try? FileManager.default.removeItem(atPath: tempPath)
                    // Office Stage B Task 3 — the helper's own save genuinely succeeded, but a reload
                    // or a close moved this path past THIS docId before the place could run: nothing
                    // was written here, so this is `.failed`, not `.saved` — a `saveAndAwaitOutcome`
                    // caller (the only kind that can even be waiting; `save(_:)`'s fire-and-forget
                    // callers register no waiter) must not be told a save landed when it did not.
                    self.resumeSaveWaiters(path: path, docId: docId,
                                          outcome: .failed("the document changed before this save could finish"))
                    return
                }
                // **Before the place, always** — mirrors `EditorSaveCoordinator.performSave`'s own
                // ordering and its own reason: the watcher T8 already installed for `path` must not
                // mistake this save's own rename for somebody else's edit, and a note filed
                // afterward would race the file-system event it exists to explain. The returned
                // token is THIS save's own — captured here so every later call below names exactly
                // what it is operating on, never a sibling save's note (fix rounds 1+2, IMPORTANT-2).
                let expectedWriteToken = self.noteExpectedWrite(path: path)
                do {
                    // Task 2b: `placeAtomically` now RETURNS the landed identity itself, statted
                    // from the sibling temp BEFORE the rename (see that method's own doc for why
                    // this is STRICTLY stronger than a live re-stat of `path` afterward — the other
                    // half of the N1 fix: a re-stat here could observe bytes a DIFFERENT, later
                    // write produced instead of this save's own, silently corrupting the very
                    // identity record `consumeExpectedWrite` depends on to prove attribution).
                    let landedStat = try await Task.detached(priority: .userInitiated) {
                        try Self.placeAtomically(tempPath: tempPath, at: path)
                    }.value
                    // Re-seed the baseline from what THIS save actually wrote — mirrors
                    // `EditorRuntime.noteWriteLanded`'s identical belt: the next watcher fire,
                    // whenever it arrives (including a debounce-coalesced one that never fires at
                    // all), is compared against bytes this save itself produced, not a stale
                    // pre-save snapshot.
                    self.diskBaselines[path] = landedStat
                    // Task review fix round 2 (IMPORTANT-2, re-review): records what THIS save's
                    // token produced on disk. **NOT called so a fire can attribute itself against
                    // it** (fix round 3 correction: this line and the withdraw immediately below run
                    // in the SAME `@MainActor` turn with no `await` between them, so no fire ever
                    // gets a chance to observe this identity before it is withdrawn again — see this
                    // bag's own header, `pendingExpectedWrites`, for the full account). Kept as a
                    // defensive record regardless — correct and harmless if a future refactor ever
                    // did put an `await` between this line and the next.
                    self.recordLandedIdentity(path: path, token: expectedWriteToken, stat: landedStat)
                    // Withdraw exactly the ONE token this save's own `noteExpectedWrite` minted
                    // above — unconditional BY TOKEN, which is the ACTUAL mechanism that makes this
                    // always correct: every note is retired by exactly the save that minted it,
                    // regardless of what any fire did (in practice, nothing — see above). The
                    // debounced-away case `testASaveWithNoWatcherFireAtAllStillLeavesNoLeakedNote`
                    // covers a fire never arriving at all. Never touches any OTHER save's still-
                    // pending token either way — see
                    // `testASecondSavesNoteSurvivesAFireLandingBetweenTwoOverlappingSaves` and
                    // `testASecondSavesNoteSurvivesEvenWhenTheSecondSaveLandsAndFiresFirst` (both
                    // primitive-in-isolation pins, not production-race proofs — their own headers
                    // say so) plus `testAGenuineOursRaceStaysSuppressedButUntouchedUntilTheOwning
                    // SaveCatchesUp` (the interleaving that IS reachable).
                    self.withdrawExpectedWrite(path: path, token: expectedWriteToken)
                    // `tempPath` is `LOKBridge`'s own ephemeral `saves/<docId>-<seq>.<ext>` render —
                    // a one-shot temp that exists for exactly this one placement (`saveAsOnDedicated
                    // Thread`'s own doc has the empirical save-mechanism decision this rests on: the
                    // only mechanism this vendor build's `.uno:Save` ever proved out was this one).
                    try? FileManager.default.removeItem(atPath: tempPath)
                    self.perform(self.dispatch(.saveSucceeded(path: path, docId: docId)))
                    // Office Stage B Task 3 — the ONE genuine success exit. Resolved here, not by an
                    // outside observer waiting for `dirty` to clear: LOK's own `ModifiedStatus=false`
                    // is a separate, later helper round trip (`OfficeRuntimeLiveTests`' own
                    // `becameCleanAfterSave` proves it eventually arrives) that this door must not
                    // block on — the write to the real path already landed, which is the fact a
                    // `saveAndAwaitOutcome` caller actually needs to decide whether it may close.
                    self.resumeSaveWaiters(path: path, docId: docId, outcome: .saved)
                } catch {
                    // No event will arrive to consume the note now — the rename never happened.
                    self.withdrawExpectedWrite(path: path, token: expectedWriteToken)
                    try? FileManager.default.removeItem(atPath: tempPath)
                    let reason = Self.describe(error)
                    self.perform(self.dispatch(.saveFailed(path: path, docId: docId, reason: reason)))
                    self.resumeSaveWaiters(path: path, docId: docId, outcome: .failed(reason))
                }
            } catch {
                guard myGeneration == self.generation else {
                    // Office Stage B Task 3 — superseded (a teardown) AND the driver's own save
                    // threw: `performTeardown`'s own flush (below) has already resolved every waiter
                    // this runtime was holding, including this docId's if one was registered, so this
                    // is a no-op call, kept only for the property `resumeSaveWaiters` itself already
                    // states in its own header — every exit calls it, uniformly, whether or not
                    // anything is actually left to resolve.
                    self.resumeSaveWaiters(path: path, docId: docId,
                                          outcome: .failed("the document was torn down before this save could finish"))
                    return // superseded AND failed: nothing to compensate, nothing to record
                }
                let reason = Self.describe(error)
                self.perform(self.dispatch(.saveFailed(path: path, docId: docId, reason: reason)))
                self.resumeSaveWaiters(path: path, docId: docId, outcome: .failed(reason))
            }
        }
    }

    // MARK: - Office Stage B Task 2: the watcher-suppression bag
    //
    // Mirrors `EditorRuntime`'s identical bag (`noteExpectedWrite`/`withdrawExpectedWrite`/
    // `consumeExpectedWrite`/`expectedWriteCount`) in SPIRIT — a save writes the file this runtime
    // is watching, so the watcher armed for `path` will see an event for a change it already knows
    // about — but NOT in shape: `EditorRuntime`'s bag is a bare per-path COUNT, safe there only
    // because `EditorSaveCoordinator` coalesces saves per path (at most one write in flight, by that
    // method's own precondition). `OfficeRuntime.save` has no equivalent coalescing — a second ⌘S
    // on the same path while the first is still saving is a second, independent `.save` effect, a
    // second note — so two notes for the SAME path can be genuinely outstanding at once.
    //
    // **Task review fix round 1 (IMPORTANT-2)** tried per-note tokens with FIFO consumption
    // (oldest-pending-token-first) — an improvement over the original bare count, but still a
    // POSITION GUESS, not a proof: `placeAtomically` runs in an independent `Task.detached` per
    // save, so a SECOND save's local copy+rename can finish, land, AND fire before the FIRST's
    // does. Round 2's re-review caught this precisely: with A noted first and B noted second, if
    // B's rename lands and fires FIRST, FIFO consumption retires tokenA (the OLDEST pending, not
    // actually B's landing) — leaving tokenB to be wrongly stolen by B's OWN later continuation
    // (which unconditionally withdrew whatever FIFO left, believing it was withdrawing its own).
    // A's real, later rename then found the bag looking empty, read `.external`, and dispatched a
    // spurious reload. The reviewer's bar: **no interleaving may misattribute** — a heuristic
    // keyed to the realistic case does not meet it, however narrow the adversarial window is.
    //
    // **Fix round 2 — identity-carrying consume, not position.** Each note now carries an
    // `identity: OfficeFileStat?`, `nil` until its OWN rename actually lands. `recordLandedIdentity`
    // is called by the OWNING save's own continuation the instant `placeAtomically` returns
    // (`performSave`'s own sequence, immediately before its own withdraw, with no `await` between
    // the two).
    //
    // **Fix round 3 (re-review) — the comment above claimed the WRONG mechanism for WHY this is
    // safe; corrected here.** It is not "a fire matches a recorded identity, which is a proof
    // whenever it fires" — in production, that branch never fires at all. `recordLandedIdentity` is
    // ALWAYS immediately followed, same `@MainActor` turn, no `await` between the two calls, by
    // `withdrawExpectedWrite`. `OfficeRuntime` being `@MainActor` — a serial executor — means NOTHING
    // can run between two `await`-free statements in the same turn; the only thing that can ever
    // interleave is another main-actor work item (a fire) queued to run at one of THIS task's own
    // suspension points (there is exactly one: the `Task.detached` place itself). A fire can
    // therefore NEVER observe a note whose identity has been recorded but not yet withdrawn — by the
    // time any fire's closure gets a turn on the main actor, that note is either still `nil` (the
    // owning save hasn't reached this point yet) or already gone (withdrawn, same turn as recorded).
    // The actual, simpler safety property is: **nil-never-matches** (`consumeExpectedWrite`'s
    // `$0.identity == observedStat` can never be true against a `nil` identity, so a fire's match
    // attempt is, in real usage, always an inert no-op) **plus unconditional by-token owner-
    // withdraw** (every note is retired by exactly the save that minted it, keyed to a token no
    // other save can produce, regardless of what any fire did or didn't do). Together these mean a
    // note is NEVER removed except by its own owner — total, not probabilistic, and for a plainer
    // reason than "matching proves attribution."
    //
    // The exact-match branch in `consumeExpectedWrite` is kept anyway, deliberately: it IS correct
    // whenever it fires (an exact `(inode, size, mtime-ns)` match can only ever correspond to the
    // ONE save whose rename actually produced those bytes — `rename(2)` carries the SOURCE temp
    // file's own inode onto the destination, and each save's temp file is a freshly, independently
    // created file; filesystem semantics guarantee a fresh file's inode is unique among all
    // currently-live files on that volume — that uniqueness comes from independent creation, NOT
    // from the temp files happening to have distinct names), so it is a safe backstop rather than
    // dead weight to delete. **But this is a backstop for a branch that cannot currently execute, not
    // the load-bearing guarantee** — `testConsumeExpectedWriteMatchesByIdentityNotPositionOrArrival
    // Order`, `testASecondSavesNoteSurvivesAFireLandingBetweenTwoOverlappingSaves`, and
    // `testASecondSavesNoteSurvivesEvenWhenTheSecondSaveLandsAndFiresFirst` all drive it directly by
    // manually sequencing `recordLandedIdentity` before a simulated fire — an interleaving
    // `performSave` structurally cannot produce today, since record and withdraw are atomic. They
    // prove the matching PRIMITIVE is correct in isolation (worth keeping: it is what a future
    // refactor would lean on if the atomicity below ever changed), not that this exact race happens
    // in production.
    //
    // **Task 2b (N1 fix) — what happens when NOTHING matches is no longer "stay suppressed."** A
    // fire arriving before ANY identity is recorded used to leave the bag untouched AND read
    // `.ours` regardless (the pre-2b `officeDiskChange`'s own blind `expectedWrites > 0` gate) —
    // the round-2 re-review's own PRE-EXISTING hole (N1): a genuinely external write racing in that
    // same window was silently swallowed, never classified `.external`, and the next save from
    // Norma's own in-memory copy would clobber it with no warning. `officeDiskChange` now requires
    // `matchesPendingIdentity` (`OfficeRuntime.hasPendingIdentity(for:matching:)`, a non-mutating
    // probe of this SAME bag) before it will ever answer `.ours` — a fire that cannot be matched to
    // ANY recorded identity now reads `.external` and is routed through the ordinary conflict/
    // reload machinery, exactly as a fire arriving with no note pending at all always has.
    // `testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdrawOnACleanDocumentReloads`/
    // `...OnADirtyDocumentRaisesAConflict` are what drive the interleaving `performSave` CAN
    // actually produce (a fire landing before this save's own identity is recorded), through the
    // CLASSIFIER — `officeDiskChange`'s own header has the full self-healing argument for the rare,
    // narrow false-positive this can produce when the fire genuinely was this same save's own,
    // merely early.
    //
    // **The atomicity above — no `await` between `recordLandedIdentity` and `withdrawExpectedWrite`
    // in `performSave` — is the single load-bearing invariant this entire guarantee rests on. Any
    // future refactor inserting an `await` between record and withdraw would silently break both
    // guarantees at once**: nil-never-matches (a fire could now observe a real recorded identity and
    // take the exact-match branch for the first time in production) and, with it, the comment above's
    // own claim that owner-withdraw alone accounts for every removal. The exact-match branch would
    // remain individually correct if this happened (see the paragraph above), so nothing would
    // actually misbehave — but the INVARIANT this comment and its tests currently document would have
    // silently shifted, unannounced by any test failure. Keep `recordLandedIdentity` and
    // `withdrawExpectedWrite` adjacent, synchronous, and `await`-free in `performSave` — if a future
    // change needs an `await` between them, this whole comment block needs re-reading first, not just
    // re-running the tests.
    struct ExpectedWriteToken: Hashable {
        private let id = UUID()
    }

    /// One outstanding save's own claim on a path — minted BEFORE its rename (closing the ORIGINAL,
    /// pre-bag race: a note filed only after the place would race the very event it exists to
    /// explain), and given an `identity` once that rename actually lands, so a fire can recognize it
    /// with certainty rather than by position in a list.
    private struct ExpectedWrite {
        let token: ExpectedWriteToken
        var identity: OfficeFileStat?
    }

    private var pendingExpectedWrites: [String: [ExpectedWrite]] = [:]

    @discardableResult
    func noteExpectedWrite(path: String) -> ExpectedWriteToken {
        let token = ExpectedWriteToken()
        pendingExpectedWrites[path, default: []].append(ExpectedWrite(token: token, identity: nil))
        return token
    }

    /// Called by a save's OWN continuation the instant its own `placeAtomically` returns — records
    /// what its token's write actually produced on disk, so `consumeExpectedWrite` can recognize it
    /// by fact instead of guessing by position. A no-op if `token` is not (or no longer) pending —
    /// safe to call even if a fire somehow already raced ahead and withdrew it via some other path.
    func recordLandedIdentity(path: String, token: ExpectedWriteToken, stat: OfficeFileStat?) {
        guard var writes = pendingExpectedWrites[path],
              let index = writes.firstIndex(where: { $0.token == token }) else { return }
        writes[index].identity = stat
        pendingExpectedWrites[path] = writes
    }

    /// A save's OWN door — removes ONLY `token`, never any other token for `path`, regardless of
    /// whether a fire already matched and removed it (a no-op in that case) or never got the chance
    /// to. This unconditional-by-identity removal is what makes a save's own cleanup ALWAYS correct
    /// independent of the fire side, and is why a still-genuinely-outstanding SIBLING save's own
    /// note is never at risk from it.
    func withdrawExpectedWrite(path: String, token: ExpectedWriteToken) {
        guard var writes = pendingExpectedWrites[path],
              let index = writes.firstIndex(where: { $0.token == token }) else { return }
        writes.remove(at: index)
        if writes.isEmpty {
            pendingExpectedWrites.removeValue(forKey: path)
        } else {
            pendingExpectedWrites[path] = writes
        }
    }

    /// The watcher's door: does `observedStat` DEFINITIVELY match one of `path`'s own outstanding
    /// writes? Exact identity, never position — a match, if one is ever found, is a proof rather
    /// than a heuristic (this bag's own header has the argument). **In today's actual production
    /// flow this method always returns `nil`** — see the header's fix-round-3 correction for why —
    /// so treat this as a defensive backstop, not the mechanism doing the day-to-day work; that is
    /// unconditional by-token owner-withdraw, elsewhere in this bag. Returns the consumed token on a
    /// match (the caller adopts `observedStat` as the new baseline); `nil` when no note's recorded
    /// identity matches — which the caller must still treat as "possibly ours, do not reload" as
    /// long as `expectedWriteCount(for:) > 0`, since a `nil` here can mean "no note explains this"
    /// OR "the note that will is still mid-flight and has not recorded itself yet" — this door
    /// cannot tell those apart, and does not try to; it touches nothing when it cannot be certain.
    @discardableResult
    func consumeExpectedWrite(path: String, matching observedStat: OfficeFileStat?) -> ExpectedWriteToken? {
        guard let observedStat, var writes = pendingExpectedWrites[path],
              let index = writes.firstIndex(where: { $0.identity == observedStat }) else { return nil }
        let token = writes[index].token
        writes.remove(at: index)
        if writes.isEmpty {
            pendingExpectedWrites.removeValue(forKey: path)
        } else {
            pendingExpectedWrites[path] = writes
        }
        return token
    }

    /// How many of this runtime's own writes at `path` are still unaccounted for. Test seam only as
    /// of Task 2b — `officeDiskChange`'s own `.ours`/`.external` fork used to read this count
    /// directly (N1's own hole: a note merely being PRESENT said nothing about whether it explains
    /// THIS fire); `fileChangedOnDisk` now feeds the classifier `hasPendingIdentity(for:matching:)`
    /// instead — see that method's own doc.
    func expectedWriteCount(for path: String) -> Int {
        pendingExpectedWrites[path]?.count ?? 0
    }

    /// **Office Stage B Task 2b (N1 fix) — the classifier's own non-mutating input.** Does ANY of
    /// `path`'s own outstanding notes have a RECORDED identity equal to `stat`, without consuming
    /// it? `fileChangedOnDisk` feeds this straight into `officeDiskChange`'s `matchesPendingIdentity`
    /// parameter — deliberately a read, not `consumeExpectedWrite` itself: the classifier's own
    /// verdict must be decidable BEFORE anything mutates the bag (`fileChangedOnDisk`'s `.ours` arm
    /// is what actually calls `consumeExpectedWrite`, once the classifier has already said `.ours`
    /// is the right answer). `nil` `stat` (a `.deleted` verdict never reaches this — see
    /// `officeDiskChange`'s own early return) trivially answers `false`.
    private func hasPendingIdentity(for path: String, matching stat: OfficeFileStat?) -> Bool {
        guard let stat else { return false }
        return pendingExpectedWrites[path]?.contains { $0.identity == stat } ?? false
    }

    // MARK: - Office Stage B Task 2: the atomic place

    /// **The APP's own half of the save split** (see `OfficeWireFrame.saved`'s own header): the
    /// helper's render always lands under ITS OWN `--state-path` — a directory that may not share a
    /// filesystem with `path`'s own directory (a state-path under `~/Library/Application Support`
    /// versus a document on an external volume, a network share, a different APFS container). A
    /// direct `rename(2)` from `tempPath` straight onto `path` would therefore be free to fail with
    /// `EXDEV` — the plan's own pre-flight finding. This is `EditorSaveCoordinator.writeAtomically`'s
    /// SAME tmp+rename discipline, adapted for a source that already exists as BYTES ON DISK rather
    /// than an in-memory `String`: `tempPath` is COPIED to a sibling temp file IN THE DOCUMENT'S OWN
    /// DIRECTORY first — `FileManager.copyItem` handles a cross-volume source natively, no EXDEV
    /// risk there — and the actual `rename(2)` that replaces `path` is then ALWAYS same-directory,
    /// same-filesystem, by construction, regardless of where `tempPath` started out.
    ///
    /// The sibling's name carries a LEADING DOT, matching `EditorSaveCoordinator.writeAtomically`'s
    /// own `.{name}.norma-save-{uuid}` convention exactly — not merely cosmetic parity: `FileTreeModel
    /// .listTreeEntries` reads with `.skipsHiddenFiles`, so this transient file can never flash into
    /// an open Files tab's tree even on an unlucky watcher fire mid-save (the "Files-tree sibling
    /// watcher" this task's own brief calls out — see this method's callers for the OTHER half,
    /// `noteExpectedWrite`, which is what keeps THIS runtime's own watcher silent about it).
    ///
    /// `nonisolated` for the identical reason `writeAtomically` is: it must run off the main actor so
    /// a save never stalls the shell on a slow or network volume — `performSave` calls it from inside
    /// a detached `Task`. Internal, not `private`, so a test can drive it directly with nothing but
    /// scratch files, the same testability posture every other pure/near-pure helper in this file
    /// keeps (`officeFileStat`/`officeDiskChange`/`fileChangedOnDisk`).
    ///
    /// **Office Stage B Task 2b (N1 fix, the other half) — returns the LANDED identity, statted from
    /// the SIBLING before the rename, never a fresh `officeFileStat(atPath:)` call on `path` after
    /// it.** `rename(2)` is specified to preserve the source inode onto the destination name, and
    /// touches neither the file's size nor its mtime — so the sibling's own stat, taken the instant
    /// before this function hands it to `rename`, is ALREADY exactly what a stat of `destination`
    /// would report the instant after. This is strictly stronger than a post-rename re-stat: there is
    /// no gap here at all — not even the vanishingly narrow one a re-stat would leave — in which a
    /// second, independent write to `path` (another save, a genuine external one) could land between
    /// "the rename happened" and "this function read back what it wrote," and have ITS bytes recorded
    /// under THIS save's own identity instead. `performSave` uses this return value directly for
    /// `recordLandedIdentity` — see that call site's own doc for why a corrupted identity record is
    /// exactly as dangerous as the classifier hole N1 itself named.
    @discardableResult
    nonisolated static func placeAtomically(tempPath: String, at path: String) throws -> OfficeFileStat? {
        let destination = URL(fileURLWithPath: path)
        let directory = destination.deletingLastPathComponent()
        let sibling = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).norma-save-\(UUID().uuidString)")
        do {
            try FileManager.default.copyItem(atPath: tempPath, toPath: sibling.path)
            // Flushed before the rename — same reasoning `writeAtomically` states at length: without
            // it the rename can reach the disk before the bytes do, and a power loss leaves the
            // destination NAME pointing at a file whose contents were never written. Best effort.
            if let handle = try? FileHandle(forWritingTo: sibling) {
                try? handle.synchronize()
                try? handle.close()
            }
            // The original's POSIX permissions are carried over when there is an original — a save
            // must not silently turn an executable-adjacent file's mode into whatever `copyItem`
            // happened to preserve from the helper's OWN scratch file (owned by the sandboxed helper
            // process, not this document's real owner/mode).
            if let mode = (try? FileManager.default.attributesOfItem(atPath: path))?[.posixPermissions] {
                try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: sibling.path)
            }
            // Statted HERE — see this function's own doc for why this is the landed identity, not a
            // guess at one.
            let landedStat = officeFileStat(atPath: sibling.path)
            guard rename(sibling.path, destination.path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [
                    NSLocalizedDescriptionKey:
                        "The file couldn't be replaced: \(String(cString: strerror(errno)))."
                ])
            }
            return landedStat
        } catch {
            // Never leave a `.norma-save-…` beside the user's file, whatever went wrong.
            try? FileManager.default.removeItem(at: sibling)
            throw error
        }
    }

    // MARK: - Office Stage B Task 2b: staging into the fence (the Collabora jail's open half)

    /// Where `docId` gets staged: `<docsDirectory>/<docId>.<ext>`, `ext` taken from `realPath`'s OWN
    /// extension — `LOKBridge`'s `OfficeSaveFormat` capture (at the helper's own `open`) depends on
    /// this matching exactly, the same reason `saveAsOnDedicatedThread`'s own destination naming
    /// already does. No extension on `realPath` (unreachable through any shipped door today) stages
    /// with none either — `OfficeSaveFormat` already treats that as "outside the six formats this
    /// table covers," same as it always has for `open`. Pure string arithmetic — deliberately not
    /// `nonisolated`/`static` alongside `stageDocument`/`deleteStagedCopy` below, since it touches no
    /// disk and `openAndDispatch` needs it synchronously, before the detached staging `Task` even
    /// starts (the staged path IS the docId's own identity from this point on — `.opened`'s payload,
    /// `DocumentEntry.stagedPath` — so it must exist before anything async could race it).
    private static func stagedPath(forDocId docId: String, realPath: String, docsDirectory: URL) -> String {
        let ext = (realPath as NSString).pathExtension
        let name = ext.isEmpty ? docId : "\(docId).\(ext)"
        return docsDirectory.appendingPathComponent(name).path
    }

    /// **The Collabora jail's OPEN half** — copies `realPath` (read here, unsandboxed: this app IS
    /// the trust boundary) INTO `stagedPath`, always somewhere under the helper's own `--state-path`,
    /// which is INSIDE its write fence by construction (`office-helper.sb`'s `(subpath (param
    /// "STATE_PATH"))` rule — T1's own invariant, untouched by this task). This is what makes the
    /// helper's own copy genuinely writable: LOK's `SfxMedium` write-classed open probe (the exact
    /// mechanism `LOKBridge`'s own long NEEDS_CONTEXT comment root-caused Task 2's dirty-tracking
    /// bug to) succeeds against a path the sandbox permits, for the first time — from this task
    /// onward, the helper never touches, and never even learns, `realPath` itself; only this staged
    /// copy's path ever crosses the wire (`documentLoad`'s own input, per the brief).
    ///
    /// `copyfile(3)` with `COPYFILE_CLONE` (`man 3 copyfile`, and Apple's own `copyfile.h` header
    /// comment, checked before choosing this flag over its sibling): "If this flag is set, the copy
    /// will attempt to use `clonefile(2)`... If the operation is not supported... the copy will
    /// proceed as if this flag was not set" — an instant, copy-on-write APFS clone when `realPath`
    /// and `--state-path` share a volume (the common case — no doubled disk usage for an unedited
    /// multi-hundred-MB document), transparently falling back to an ordinary full byte copy
    /// otherwise (a different volume, an external drive, a network share, a filesystem without clone
    /// support). **Deliberately `COPYFILE_CLONE`, never `COPYFILE_CLONE_FORCE`**: the FORCE variant
    /// fails outright when a clone cannot be made, which is exactly wrong here — staging must
    /// succeed via a plain copy whenever cloning cannot apply, not refuse to open the document at
    /// all.
    ///
    /// `nonisolated` for the identical reason `placeAtomically` is: real disk I/O must run off
    /// `@MainActor` so opening a large document never stalls the shell — `openAndDispatch` calls
    /// this from inside a detached `Task`, mirroring `performSave`'s own placement call exactly.
    /// Creates `docsDirectory` itself if this is the first stage this boot (mirrors `LOKBridge.init`'s
    /// own eager `savesDirectory` creation) — safe to call every time,
    /// `withIntermediateDirectories: true` no-ops when it already exists. Internal, not `private`, so
    /// `OfficePlaceAtomicallyTests`' own sibling tests can drive it directly with nothing but scratch
    /// files, the same testability posture `placeAtomically` already keeps.
    nonisolated static func stageDocument(realPath: String, stagedPath: String) throws {
        let destination = URL(fileURLWithPath: stagedPath)
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        // `copyfile` fails immediately (`EEXIST`) against a destination that already exists — never
        // reachable in practice (`stagedPath` is always named after a freshly minted docId, per
        // `stagedPath(forDocId:realPath:docsDirectory:)`'s own doc), but removing any leftover first
        // is one line of insurance against a future caller that ever reused a name, and costs
        // nothing when (as always today) there is nothing there to remove.
        try? FileManager.default.removeItem(atPath: stagedPath)
        guard copyfile(realPath, stagedPath, nil, copyfile_flags_t(COPYFILE_CLONE)) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [
                NSLocalizedDescriptionKey:
                    "The document couldn't be staged: \(String(cString: strerror(errno)))."
            ])
        }
        // **Task 2b fix round 1 (review IMPORTANT-1)** — `copyfile`'s single call above covers BOTH
        // its own internal paths (an APFS `clonefile`, or the plain-copy fallback when cloning
        // cannot apply): either way it faithfully preserves the SOURCE's mode, flags, and ACLs by
        // design, which is exactly wrong here. A real document opened `0444` (read-only permission
        // bits) or Finder-Locked (`UF_IMMUTABLE`) stages into an identically read-only/immutable
        // copy — silently reproducing the EXACT read-only-medium bug this task exists to fix (Task
        // 2's own in-repo `chmod 444` probe is what first proved that mechanism). Immutable is
        // worse than merely read-only: `UF_IMMUTABLE` also defeats `deleteStagedCopy` and the
        // `docs/` boot sweep, both `try?`-wrapped best-effort removals that fail silently against
        // it, leaking the copy forever. Order matters: flags MUST clear before the chmod below —
        // `UF_IMMUTABLE` blocks permission changes too, not just writes.
        guard chflags(stagedPath, 0) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [
                NSLocalizedDescriptionKey:
                    "The staged copy's flags couldn't be cleared: \(String(cString: strerror(errno)))."
            ])
        }
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagedPath)
        } catch {
            throw NSError(domain: NSPOSIXErrorDomain, code: (error as NSError).code, userInfo: [
                NSLocalizedDescriptionKey:
                    "The staged copy couldn't be made writable: \(error.localizedDescription)"
            ])
        }
    }

    /// **Office Stage B Task 2b (I3) — removes `docId`'s own staged copy, whatever its extension.**
    /// Glob-by-docId-PREFIX (`"<docId>."`) against `docsDirectory`'s own contents, not a remembered
    /// exact path — mirrors `LOKBridge.sweepStaleProfileDirectories`'s own precedent rather than
    /// tracking a SECOND, docId-keyed path table that could only ever drift from the one place this
    /// path is already recorded (`DocumentEntry.stagedPath`, reducer state — this method deliberately
    /// does not read it, so it works identically for a docId whose `DocumentEntry` is already gone,
    /// e.g. after `.helperDied` wiped `documents` in the same reducer turn that emitted this sweep).
    /// Safe as an exact prefix match: `docId` is a full UUID string by default (`makeDocId`'s own
    /// default), and no other valid UUID string can ever equal this one's own `"<uuid>."` prefix.
    /// Best-effort — a sweep failure (permissions, already gone, a concurrent second cleanup call
    /// racing this one) must never propagate; every caller of this is fire-and-forget cleanup, never
    /// a step anything downstream is waiting on. `nonisolated`, same reasoning as `stageDocument`.
    nonisolated static func deleteStagedCopy(docId: String, docsDirectory: URL) {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: docsDirectory, includingPropertiesForKeys: nil) else { return }
        let prefix = "\(docId)."
        for entry in entries where entry.lastPathComponent.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: entry)
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
        // Office Stage B Task 2 — the save-suppression bag goes with everything else this runtime
        // holds; mirrors `EditorRuntime`'s own teardown treatment of its identical bag.
        pendingExpectedWrites.removeAll()
        // Office Stage B Task 3 — **load-bearing, not tidiness.** `performSave`'s own Tasks capture
        // only `[weak self]`/`[driver]`, never a strong reference to this runtime, and the quit path
        // (`ShellSessionHost.teardownAllOfficeRuntimesAndStopHelper`) can be the LAST strong reference
        // this runtime has (`officeRuntimes.removeValue(forKey:)` drops the table's own hold the
        // instant before calling `.teardown()`). A `saveAndAwaitOutcome` waiter registered in
        // `saveWaiters` is a live `CheckedContinuation` — Swift's own runtime treats a continuation
        // that is dropped WITHOUT being resumed as a misuse (a logged failure, not a silent no-op) —
        // so if this object deallocates with one still pending, there is no `self` left for
        // `performSave`'s own exits to call `resumeSaveWaiters` on, ever. Flushing here, before that
        // can happen, guarantees every waiter is resolved exactly once: either by `performSave`'s own
        // exits (the ordinary case) or, whichever comes first, by this teardown. Safe against a
        // double-resolve — `resumeSaveWaiters`'s own header states why calling it again for a pair
        // this already resolved is a no-op — so a `performSave` exit that runs AFTER this flush
        // (the in-flight `driver.save`/`placeAtomically` this runtime no longer waits for) finds
        // nothing left and does nothing.
        for waiter in saveWaiters.values.flatMap({ $0 }) {
            waiter.continuation.resume(returning: .failed("the document was torn down before this save could finish"))
        }
        saveWaiters.removeAll()
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
    /// **Office Stage B Task 2 — the suppression bag Task 8's own comment (below) predicted arrives
    /// here now.** `officeDiskChange` is fed `hasPendingIdentity(for:matching:)` — Task 2b's own N1
    /// fix: a note merely being PENDING is no longer enough to call a fire `.ours` (see that
    /// function's own header for the full argument and its self-healing false-positive).
    ///
    /// Task 8's original words, kept for the historical record — true when written, superseded now:
    /// "No suppression bag: Stage A never writes an office file from the app, so there is no 'was
    /// this our own save landing' question to ask... Recorded at this exact seam so Stage B (once
    /// save exists) inherits that pattern KNOWINGLY rather than rediscovering it under a live bug
    /// report." This task is that inheritance.
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
        switch officeDiskChange(stat: stat, baseline: diskBaselines[path],
                                matchesPendingIdentity: hasPendingIdentity(for: path, matching: stat)) {
        case .unchanged:
            return
        case .ours:
            // `officeDiskChange` only ever answers `.ours` when `hasPendingIdentity` already found a
            // match — `consumeExpectedWrite` below is therefore guaranteed to find (and remove) the
            // SAME note; kept as an `if let` regardless (never force-unwrapped) so this stays correct
            // even if a future refactor ever let the two calls observe different bag states between
            // them. The responsible save's own `withdrawExpectedWrite`, unconditional and keyed to
            // ITS OWN token, retires the note correctly either way — this consume is what lets the
            // BASELINE adopt the confirmed bytes; it is not what actually frees the note in practice.
            if consumeExpectedWrite(path: path, matching: stat) != nil {
                diskBaselines[path] = stat ?? diskBaselines[path]
            }
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
        if let clientError = error as? OfficeHelperClientError {
            switch clientError {
            case .openFailed(let reason), .saveFailed(let reason): return reason
            default: break
            }
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
