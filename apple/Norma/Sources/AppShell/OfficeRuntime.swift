import Foundation
import AppKit
import CryptoKit
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
        /// **Office Stage B Task 7 — the ONE deliberate exception to `dirty`'s own "mirrors LOK and
        /// nothing else" doctrine, stated two lines up.** Set `true` in the SAME beat `.recoveryRestored`
        /// forces `dirty = true` (a restore loads the sidecar's content into a FRESH LOK document
        /// that, from LOK's own point of view, was never edited — nothing will ever make it fire a
        /// genuine `.uno:ModifiedStatus` callback on its own). Without this, a user who restores and
        /// then immediately presses ⌘S with no further typing gets a real save (the bytes DO land —
        /// `saveAsOnDedicatedThread`'s own `.uno:Save` follow-up runs unconditionally, it does not
        /// gate on the modified flag) but a dirty dot that never clears, because LOK never has a
        /// true->false transition to report for a document it always considered clean. `.saveSucceeded`
        /// checks this flag and, ONLY when it is set, clears `dirty` directly alongside it — the one
        /// place in this file a save's own success is allowed to touch `dirty` at all.
        var restoredPendingSave: Bool = false
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
    /// **Office Stage B Task 7** — a FRESHLY opened document for which a newer-than-the-real-file
    /// autosave sidecar exists: "Recovered unsaved changes from ~Ns ago [Restore] [Discard]"
    /// (`PanelDocumentTabModel.recoveryCandidate`/`OfficeRecoveryBannerView`). A SEPARATE dictionary
    /// from `documentConflicts` — a conflict is "the file moved out from under a dirty buffer,"
    /// this is "there might be OLDER, better content than what just opened," and the two can never
    /// be confused for one another the way folding them into one type would risk. Populated by
    /// `.recoveryCandidateFound` (imperative check, `OfficeRuntime.checkRecoveryCandidate`, run only
    /// for a genuinely FRESH open — never a reload/restore, see `openAndDispatch`'s own doc) and
    /// cleared by whatever makes the offer stale or acted-on: `.opened` (unconditionally — a reload
    /// has moved past whatever baseline the offer was computed against), `.modifiedStatusChanged`
    /// going true (restoring over LIVE new edits would clobber them — the exact class of "one click
    /// from data loss" T3's own review flagged for a different banner), `.recoveryRestoreRequested`/
    /// `.recoveryDiscardRequested` (optimistic clear, mirrors `documentConflicts`' identical
    /// pattern), and `.closeRequested` (no path, no offer to make about it).
    var documentRecoveryCandidates: [String: OfficeRecoveryCandidate] = [:]
    /// **Office Stage B Task 9 — the resurrection race's designed fix: per-path in-flight-open
    /// cancellation.** Stage A/T8's own wave note named the shape: "close-during-reload can
    /// resurrect a closed document — a `.opened` landing for a superseded open re-creates the entry
    /// and re-arms the watcher... `.opened` is gated only on `state.phase == .ready`, not on whether
    /// `documents[path]` still exists." A per-path counter fixes it where the existing per-docId
    /// checks (`.saveSucceeded`/`.reloadFailed`'s own `documents[path]?.docId == docId` guards)
    /// cannot: THOSE compare an arriving reply against an EXISTING entry, but a resurrection is
    /// exactly the case where there is no existing entry (a close removed it) or a DIFFERENT,
    /// already-superseded one is sitting there — nothing to compare a bare docId against. This dict
    /// is that missing fact, keyed by path (never by docId — docIds are always fresh UUIDs, per
    /// `openAndDispatch`'s own `makeDocId`, so a per-docId generation could never collide in the
    /// first place; the race is about WHICH attempt for a given PATH is still authoritative).
    ///
    /// **Bumped by close and by every attempt that REPLACES an already-open document** — reload
    /// (`.externalChangeDetected`'s clean-reload arm, `.conflictReloadRequested`) and restore
    /// (`.recoveryRestoreRequested`) alike, since both are reload-shaped ("close old, open new" via
    /// the same `openAndDispatch` bottleneck). **A fresh `.openRequested` (`.helperOpen`) does NOT
    /// bump** — it CAPTURES whatever the current value already is as its own ticket. This is
    /// deliberate, not an oversight: bumping on close/reload alone is already sufficient to
    /// distinguish every interleaving that matters (a close moves the counter forward, so a fresh
    /// re-open minted AFTER that close reads a strictly newer ticket than whatever open was in
    /// flight before it — see `OfficeRuntimeReducerTests`' own two-rapid-open-close-open row), and
    /// NOT bumping keeps two ordinary concurrent opens of the same never-yet-opened path (a double
    /// click, both racing the identical `documents[path] == nil` guard) sharing one ticket, so
    /// neither is spuriously cancelled — whichever `.opened` lands second still resolves through the
    /// PRE-EXISTING `previousEntry.docId != docId` compensating-close logic one arm below, unchanged.
    ///
    /// **Fix round 1 (review F2) — a fresh open's CAPTURE is also RECORDED, not only read.** Both
    /// sites that mint a `.helperOpen` ticket for a path with no bump of its own (the `.ready`-phase
    /// immediate open below, and `.helperBecameReady`'s queue flush) now also write
    /// `next.pathGenerations[path] = ticket` — previously they only *read* `[path, default: 0]`
    /// without ever inserting an entry for a path that had never been closed/reloaded before. This
    /// does not change what "capture, don't bump" means (still true, previous paragraph unchanged);
    /// it only makes sure a FIRST-EVER open of a never-touched path leaves a real dictionary entry
    /// behind, which the death/teardown bump immediately below depends on existing.
    ///
    /// **`.opened`/`.openFailed`/`.reloadFailed` all carry the ticket the imperative half captured
    /// at the moment their OWN attempt was launched** (`OfficeRuntime.openAndDispatch`'s
    /// `myPathGeneration` parameter — read once, synchronously, before the async round trip starts,
    /// mirroring exactly how the EXISTING runtime-wide `generation` is captured for teardown). A
    /// landing whose ticket no longer matches this dict's CURRENT value for that path is stale —
    /// something newer (a close, or a newer replace) has happened since — and is dropped. Gating all
    /// three landings, not only `.opened` (the brief's own explicit example), is the same mechanism
    /// closing the same class of bug for its two siblings: an unguarded `.openFailed` could
    /// overwrite a FRESH success's clean slate with a phantom failure banner, and an unguarded
    /// `.reloadFailed` — even with ITS OWN existing `oldDocId` guard, kept alongside this one, not
    /// replaced by it — can still act on a stale failure while a second, faster reload is in the
    /// window where `documents[path]` still shows the SAME `oldDocId` neither reload has replaced
    /// yet (`.reloadDocument`'s own effect never clears `documents[path]` before its reopen lands);
    /// the ticket is what tells the two apart there, where docId identity alone cannot.
    ///
    /// **A drop is mutation-free except for its own compensating cleanup**: `.opened`'s drop arm
    /// returns `state` completely untouched (no `documents`/`documentBanners`/`documentConflicts`/
    /// `documentRecoveryCandidates` writes — those all belong to whichever attempt IS current, not
    /// the one being cancelled) plus exactly two effects, `.helperClose`/`.deleteStagedCopy` for the
    /// docId that just landed — the helper-side document this attempt opened, and its staged copy,
    /// both now orphaned with no owner left to close them otherwise. No `.unwatchFile`: a dropped
    /// open's `.watchFile` was never emitted (that only happens from INSIDE the non-dropped branch),
    /// so there is no watch to stop. `.openFailed`/`.reloadFailed`'s own drops need no compensating
    /// effects at all — nothing was ever opened on the helper for a failed attempt.
    ///
    /// **Fix round 1 (review F2) — the ORIGINAL carry-forward-unchanged here was backwards, not
    /// merely simpler.** The claim used to be "resetting to empty would let a stale pre-death ticket
    /// collide with a post-recovery retry's own (both reading zero)." That premise is inverted: an
    /// in-flight attempt captures its ticket BEFORE the boundary, so under a bare reset it holds some
    /// `T` while the retry reads `0` — they collide only in the special case `T == 0`. Under the
    /// ORIGINAL carry-forward-unchanged they collided ALWAYS, because a fresh retry's own capture
    /// (previous paragraph) reads the exact same value the in-flight zombie already holds — there is
    /// nothing to tell them apart. The "existing phase guard makes a collision unreachable in
    /// practice" claim was ALSO false: the review's own concrete counter-example (path at ticket 3,
    /// open in flight, `.helperDied`, retry succeeds and returns phase to `.ready`, THEN the
    /// pre-death `.opened(path, 3)` lands with `3 == 3`) shows phase is back to `.ready`, not blocked,
    /// by the time the zombie arrives — the window is real, not merely theoretical.
    ///
    /// **The actual fix: `.helperDied`/`.helperUnavailable`/`.teardownRequested` BUMP every existing
    /// entry by one, rather than either resetting to empty or carrying forward unchanged.** Combined
    /// with the capture-is-also-recorded fix in the paragraph above (so a path mid-open-for-the-first-
    /// time has an entry there to bump), this closes the window completely rather than merely
    /// narrowing it to `T == 0`: ANY ticket captured before the death/teardown boundary is now
    /// strictly less than the value a retry reads after it, for every path, unconditionally — not
    /// "usually self-heals when the retry's own `.opened` lands," but never reachable at all. Neither
    /// a bare reset (collides when `T == 0`) nor bare carry-forward (collides always) has this
    /// property; incrementing does, because it is the one operation guaranteed to differ from
    /// whatever value was already there, for every path, without needing to know which paths had an
    /// attempt in flight (bumping an idle path's ticket is inert — the next fresh open for it simply
    /// captures the bumped value, with nothing pending to invalidate). `OfficeRuntimeState()`'s own
    /// construction (a session's very first runtime) is the only place this dict is legitimately
    /// empty; every other boundary now strictly advances it.
    var pathGenerations: [String: Int] = [:]
}

/// Office Stage B Task 7 — one path's own recovery offer: a sidecar this runtime found newer than
/// the real file at open time. `docId` is the CRASHED session's own docId (the sidecar's own
/// filename, `<docId>.<ext>` under `autosave/`) — deliberately NOT the freshly opened document's
/// docId, which is a different one (`openAndDispatch` mints a fresh docId on every open, crash
/// recovery included). `sidecarPath` is carried directly (not re-derived from `docId`+`ext` at
/// every use) so `.restoreFromSidecar`'s effect performer and `.discardRecoveryCandidate`'s both
/// read the exact same path this candidate was actually found at.
struct OfficeRecoveryCandidate: Equatable {
    var docId: String
    var sidecarPath: String
    /// The sidecar's own mtime at discovery — what "~Ns ago" is computed FROM (captured once, not
    /// live-updated while the banner sits on screen; a stale-by-a-few-seconds relative time on a
    /// banner nobody has dismissed yet is cosmetic, not a correctness concern this task's brief
    /// asks for more than).
    var capturedAt: Date
    /// Office Stage B Task 7 — whether `sidecarPath` is in the document's OWN format or its ODF
    /// fallback (`OfficeSaveFormat.autosaveFormat`) — the banner discloses this ("recovered in ODF
    /// format" or similar) rather than silently restoring a document whose extension no longer
    /// matches what the user will see after Restore.
    var isODFFallback: Bool
}

// MARK: - Office Stage B Task 7: the recovery banner's copy, alongside the conflict banner's own

let officeRecoveryRestoreTitle = "Restore"
let officeRecoveryDiscardTitle = "Discard"

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
    /// **Office Stage B Task 9** — `pathGeneration`: the per-path ticket THIS attempt captured at
    /// launch (`OfficeRuntime.openAndDispatch`'s `myPathGeneration`). See
    /// `OfficeRuntimeState.pathGenerations`'s own header for the full mechanism — a value that no
    /// longer matches `state.pathGenerations[path]` when this lands means the attempt was
    /// superseded (a close, or a newer reload/restore) and this event is dropped.
    case opened(path: String, docId: String, stagedPath: String, metadata: OfficeDocumentMetadata, pathGeneration: Int)
    /// A `.helperOpen` reached the helper and it refused (garbage file, unreadable path, ...) — see
    /// `OfficeHelperClientError.openFailed`, the shape the imperative half classifies this from.
    /// `pathGeneration` — same ticket/staleness mechanism as `.opened`'s own (Task 9): a stale
    /// failure must not overwrite `openFailures[path]` with a phantom reason for a path a close or a
    /// newer attempt has already moved past.
    case openFailed(path: String, reason: String, pathGeneration: Int)
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
    ///
    /// **Office Stage B Task 9 — `pathGeneration` joins `oldDocId` as a SECOND, independent stale
    /// guard, deliberately not a replacement for it.** The two catch different windows: `oldDocId`
    /// catches the case where a NEWER attempt has already LANDED and replaced `documents[path]`;
    /// `pathGeneration` also catches the case where a newer attempt has been INITIATED but has NOT
    /// yet landed — `.reloadDocument`'s own effect never clears `documents[path]` before its reopen
    /// resolves (its own header: "the OLD entry stays exactly where it is until the new one is
    /// ready"), so two reloads fired close together both read the SAME `oldDocId` from the SAME
    /// still-standing entry. If the FIRST of the two fails while the second is still in flight, the
    /// `oldDocId` guard alone would still match (nothing has replaced the entry yet) and would
    /// destroy it — a real flash `OfficeRuntimeReducerTests`' own row proves — where `pathGeneration`
    /// (bumped again by the second reload's own initiation) already reads stale and drops the first
    /// reload's failure outright.
    case reloadFailed(path: String, oldDocId: String, reason: String, pathGeneration: Int)
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

    // MARK: Office Stage B Task 7 — autosave sidecars + crash recovery

    /// The helper's own `OfficeAutosaveScheduler` fired and wrote (or refreshed) `docId`'s sidecar.
    /// Routed by docId, same reasoning as `modifiedStatusChanged` — the push itself carries only
    /// `docId`; this reducer already knows the docId->path mapping.
    case autosaved(docId: String, ext: String, isODFFallback: Bool)
    /// The imperative half's own post-open check (`OfficeRuntime.checkRecoveryCandidate`, run only
    /// for a genuinely fresh open) found a sidecar newer than the real file. `docId` is the FRESH
    /// open's own docId — the stale-open guard this event's own reducer arm uses, identical
    /// shape to `.opened`'s: a reload/close racing the check must not attach a candidate to a
    /// document this path has already moved past.
    case recoveryCandidateFound(path: String, docId: String, candidate: OfficeRecoveryCandidate)
    /// The recovery banner's "Restore" — replace the buffer with the sidecar's own content, under a
    /// fresh docId, exactly like `.conflictReloadRequested` re-stages except FROM the sidecar
    /// instead of from the real path (`OfficeRuntime.openAndDispatch`'s `stageFrom:` parameter).
    case recoveryRestoreRequested(path: String)
    /// The recovery banner's "Discard" — the offer is declined; delete the sidecar and its manifest
    /// entry, no other document state changes (the tab is already showing the real file's own
    /// content, opened normally — Task 7's own design note: recovery never blocks the ordinary open).
    case recoveryDiscardRequested(path: String)
    /// **A restore-flavored open landed.** Separate from `.opened` (which this ALWAYS fires
    /// immediately after, never instead of) rather than a new field on it — widening `.opened`'s
    /// own arity would touch every existing call site and reducer test that constructs it, for a
    /// fact ( "force dirty=true, this once" ) that is true for exactly one caller. See
    /// `DocumentEntry.restoredPendingSave`'s own header for why `dirty` needs forcing at all.
    case recoveryRestored(path: String, docId: String)
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
    /// Office Stage B Task 9 — `pathGeneration`: the ticket `state.pathGenerations[path]` held at
    /// the instant the reducer decided to emit this (read, never bumped, by a fresh open — see
    /// `OfficeRuntimeState.pathGenerations`'s own header). `OfficeRuntime.openAndDispatch` carries it
    /// through to whichever of `.opened`/`.openFailed` this attempt eventually dispatches.
    case helperOpen(path: String, pathGeneration: Int)
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
    ///
    /// Office Stage B Task 9 — `pathGeneration`: the FRESHLY BUMPED ticket for this reload attempt
    /// (`OfficeRuntimeState.pathGenerations[path]` immediately after the reducer incremented it —
    /// see that field's own header for why reload bumps and a fresh open does not). Carried through
    /// to whichever of `.opened`/`.reloadFailed` this attempt eventually dispatches.
    case reloadDocument(path: String, oldDocId: String, pathGeneration: Int)
    /// Office Stage B Task 2 — render+place `docId` (the path's docId at the moment `.saveRequested`
    /// was dispatched) onto `path`. The imperative performer is the WHOLE round trip: ask the
    /// helper (`driver.save`), then atomically place its answer — see `OfficeRuntime.performSave`'s
    /// own header for the two stale guards and the suppression-bag wiring this one effect stands
    /// for.
    ///
    /// **Fix round 4 (NEW-2) — `part` added**: `path`'s own `activePart` AT DISPATCH TIME, resolved
    /// from the same `DocumentEntry` read that already resolves `docId` here, and for the same
    /// reason — a save describes the document as the user had it when they asked, not as whatever
    /// has happened since. See `OfficeWireFrame.save`'s own header for what the helper does with it.
    case save(path: String, docId: String, part: Int)
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

    // MARK: Office Stage B Task 7 — autosave sidecars + crash recovery

    /// Write/refresh the state-path manifest entry mapping `path`'s own hash to `docId`'s sidecar
    /// — the ONLY place this ever happens app-side, since only the app knows `docId`'s real path
    /// (the helper never learns it — the Collabora jail). Emitted by `.autosaved`'s own arm.
    case recordAutosave(path: String, docId: String, ext: String, isODFFallback: Bool)
    /// The recovery banner's "Restore" — the SAME close-old/open-new machinery `.reloadDocument`
    /// already runs (`openAndDispatch`'s own `stageFrom:` parameter), except staging FROM
    /// `sidecarPath` instead of from `path` itself, and forcing `dirty=true` once the fresh open
    /// lands (`OfficeRuntime.openAndDispatch`'s `markDirtyOnOpen:` — see
    /// `DocumentEntry.restoredPendingSave`'s own header for why that forcing is needed at all).
    /// Deliberately a DIFFERENT case name from the EVENT that produces it
    /// (`OfficeRuntimeEvent.recoveryRestoreRequested`) even though both exist for the same user
    /// action — this file's own established convention names every effect after WHAT THE IMPERATIVE
    /// HALF DOES (`.reloadDocument`, not `.conflictReloadRequested`), and a shared name between an
    /// event and its effect would make every future grep for one also return the other.
    ///
    /// Office Stage B Task 9 — `pathGeneration`: same freshly-bumped-ticket contract as
    /// `.reloadDocument`'s own (restore IS reload-shaped — "close old, open new" — so it bumps on
    /// the identical terms; see `OfficeRuntimeState.pathGenerations`'s own header).
    case restoreFromSidecar(path: String, oldDocId: String, sidecarPath: String, pathGeneration: Int)
    /// The recovery banner's "Discard" — delete `docId`'s own sidecar and `path`'s own manifest
    /// entry, exactly like `.clearAutosave` (indeed the SAME imperative performer), kept as its own
    /// case rather than reusing `.clearAutosave` directly so `OfficeRuntimeReducerTests` can assert
    /// on "which door produced this" without the two call sites becoming indistinguishable in a
    /// test's own effects list.
    case discardRecoveryCandidate(path: String, docId: String)
    /// **Delete `docId`'s own sidecar (glob by prefix, mirrors `.deleteStagedCopy`) AND `path`'s own
    /// manifest entry.** The ownership rule this task's whole design rests on: the HELPER only ever
    /// WRITES a sidecar (`OfficeAutosaveScheduler`'s own header); this is the app's own half,
    /// emitted from exactly three places:
    ///   * `.saveSucceeded` — the real path itself now PROVABLY carries the content
    ///     (`placeAtomically` already ran); the sidecar this SAME docId may have been growing is
    ///     now redundant. An explicit resolution — `alsoClearManifestOwner: true`.
    ///   * `.closeRequested` — cleans up any sidecar THIS session's own (literal) docId may have
    ///     grown. `alsoClearManifestOwner: false` — see that flag's own header just below for why
    ///     this site specifically must NOT claim it.
    ///   * `.recoveryDiscardRequested` — the user explicitly declined the offer, via
    ///     `.discardRecoveryCandidate` (a separate effect case; `perform`'s own handling of it calls
    ///     the SAME imperative function with `alsoClearManifestOwner: true` hardcoded, since Discard
    ///     is unconditionally an explicit resolution of whatever the manifest currently names).
    ///
    /// **`alsoClearManifestOwner` — fix round 1 (review I-2, at the Critical boundary).** The
    /// ORIGINAL version of this case (and of `OfficeRuntime.clearAutosave`, its imperative
    /// performer) had no such flag: EVERY site unconditionally read the manifest, unioned in
    /// whatever docId it recorded, and deleted the manifest file outright — correct for
    /// `.saveSucceeded`/Discard, but WRONG for `.closeRequested`. The bug: open a path that has a
    /// STANDING, never-Restored/never-Discarded recovery candidate (a crashed session's own sidecar,
    /// recorded under ITS OWN docId — completely different from the fresh, clean docId this new open
    /// just minted). T3's own dirty-close sheet gates a close ONLY on `dirty == true` for the
    /// CURRENT session — a fresh, un-restored open is clean by construction (nothing has been typed
    /// in THIS session yet), so a plain ⌘W proceeds with NO PROMPT AT ALL. The old, unconditional
    /// version reached into the manifest anyway, deleted the crashed session's own sidecar and the
    /// manifest naming it, and silently discarded the one thing recovery exists to preserve — one
    /// click, no confirmation, and the banner could not even be seen again to undo it (a `false`ish
    /// "no data loss" only relative to the last SAVED state of the real file; relative to what the
    /// user actually typed before crashing, it is exactly the loss autosave exists to prevent).
    /// `alsoClearManifestOwner: false` at `.closeRequested` fixes this at BOTH layers this function
    /// touches — the union-sidecar-sweep AND the manifest-file deletion itself are gated by the SAME
    /// flag (a manifest recorded under the literal `docId` and pointing at a sidecar this call DID
    /// delete is harmless to leave standing: `checkRecoveryCandidate`'s own `officeFileStat` guard
    /// silently refuses a manifest whose sidecar is gone, and the next boot's `sweepAutosaveOrphans`
    /// clears the dangling manifest file within, at most, one launch — the same bounded-residual
    /// tolerance this task's own "at most a minute" framing already accepts elsewhere).
    ///
    /// **Deliberately NEVER emitted by `.helperDied`/`.helperUnavailable`/`.teardownRequested`** —
    /// those three ARE the abnormal-ending case ("a SIGKILL costs at most a minute" covers an app
    /// quit exactly as much as a literal crash: the helper's own teardown is unconditionally
    /// `_Exit`/SIGKILL, never a flush). `OfficeRuntimeReducerTests
    /// .testHelperDiedTeardownAndUnavailableNeverEmitAnAutosaveClear` pins this the way a positive
    /// test alone cannot — a future site-mirroring sweep (the same instinct that correctly adds
    /// `.deleteStagedCopy` to every document-abandoning site) must trip a RED test here, not
    /// silently delete the evidence recovery depends on.
    case clearAutosave(path: String, docId: String, alsoClearManifestOwner: Bool)
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
                // Office Stage B Task 9 — CAPTURES the current per-path ticket, never bumps it (see
                // `OfficeRuntimeState.pathGenerations`'s own header for why a fresh open is the one
                // attempt kind that reads rather than advances this counter). Fix round 1 (review
                // F2): also RECORDS the capture — a never-before-touched path had no entry here to
                // record into, which is exactly the gap the death/teardown bump fix depends on not
                // existing (see the field header's own account).
                let ticket = state.pathGenerations[path, default: 0]
                next.pathGenerations[path] = ticket
                return (next, [.helperOpen(path: path, pathGeneration: ticket)])
            }

        case .helperBecameReady:
            guard state.phase == .starting else { return (next, []) }
            next.phase = .ready
            let queued = next.pendingOpens
            next.pendingOpens = []
            // Task 9: each queued path's own current ticket — none of these could have been bumped
            // while still `.starting` (a bump requires either `.closeRequested`, unconditional and
            // reachable from any phase, or a reload/restore, both of which require `documents[path]`
            // to already exist, impossible before the first `.opened` this runtime will ever record).
            // `.closeRequested` IS reachable here, and its own `pendingOpens.removeAll` means a path
            // closed while queued never reaches this loop at all — so the read below is always the
            // untouched, original ticket for every path that actually gets flushed. Fix round 1
            // (review F2) — also RECORDS each capture, same reasoning as the `.ready`-phase immediate
            // open's own identical fix just above: a path queued here for its FIRST-EVER open has no
            // prior entry, and the death/teardown bump needs one to reach.
            var effects: [OfficeRuntimeEffect] = []
            for path in queued {
                let ticket = next.pathGenerations[path, default: 0]
                next.pathGenerations[path] = ticket
                effects.append(.helperOpen(path: path, pathGeneration: ticket))
            }
            return (next, effects)

        case .opened(let path, let docId, let stagedPath, let metadata, let pathGeneration):
            // Gated on `.ready`, like every other arm that records what the helper said: the async
            // reply can land after a teardown or a helper death moved this runtime past `.ready`
            // (the imperative half's own generation guard — `OfficeRuntime.perform`'s `.helperOpen`
            // case — is what stops the DISPATCH from even reaching here in the teardown case; this
            // guard is the belt, and the only line of defense for the helperDied case, which does
            // not bump that generation).
            //
            // **Two staleness checks, two layers, on purpose (Task 9).** The RUNTIME-WIDE `generation`
            // above lives in the imperative half because it answers a question the pure reducer
            // cannot: "has this whole runtime been torn down," which requires comparing against a
            // fresh `OfficeRuntimeState()` that is byte-identical to a runtime that was never started
            // — nothing in `state` itself could ever distinguish those two cases, so the check has to
            // happen BEFORE dispatch, imperatively, or not at all. The PER-PATH `pathGeneration` check
            // immediately below is the opposite: dispatching is always safe (the runtime still
            // exists), and "was THIS path superseded" is exactly the kind of fact the reducer is
            // supposed to own, per this file's own opening claim — so it lives here, not in
            // `OfficeRuntime.perform`.
            guard state.phase == .ready else { return (next, []) }
            // **Office Stage B Task 9 — the resurrection race's designed fix.** A ticket that no
            // longer matches this path's CURRENT generation means something newer happened since
            // this attempt launched (a close, or a newer reload/restore) — this landing is stale and
            // must not touch `documents[path]`/`documentBanners`/`documentConflicts`/
            // `documentRecoveryCandidates` at all (returning `next` completely untouched, identical
            // to `state`, at this point — nothing above this guard has mutated it). The only thing
            // left to do is compensate: `docId` genuinely IS open on the shared helper right now (the
            // wire round trip succeeded), with its own staged copy on disk, and no owner but this
            // dropped attempt left to close either — mirrors the existing `previousEntry.docId !=
            // docId` compensating-close a few lines below, for the identical reason, just triggered
            // by a per-path ticket mismatch instead of a docId mismatch. No `.unwatchFile`: a dropped
            // attempt never reached the `.watchFile` emission below, so there is nothing watching to
            // stop.
            guard pathGeneration == state.pathGenerations[path, default: 0] else {
                return (next, [.helperClose(docId: docId), .deleteStagedCopy(docId: docId)])
            }
            next.openFailures.removeValue(forKey: path)
            // office-plumbing Task 8: a document that just (re)opened cannot still be saying it was
            // deleted — the reload success path is what answers a deleted-then-restored file.
            next.documentBanners.removeValue(forKey: path)
            // Task 2b: nor still showing a conflict — a fresh (re)open IS the resolution.
            next.documentConflicts.removeValue(forKey: path)
            // Task 7: nor still offering a NOW-stale recovery banner — unconditional, exactly like
            // the two clears immediately above. Correct for BOTH the case this doesn't yet cover
            // (a fresh open has nothing to clear here — the candidate, if any, is found by a LATER,
            // separate `.recoveryCandidateFound` dispatch this same open triggers) and the case it
            // exists for (a reload/restore lands here with an OLDER offer still standing, computed
            // against a baseline this new content has already moved past).
            next.documentRecoveryCandidates.removeValue(forKey: path)
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

        case .openFailed(let path, let reason, let pathGeneration):
            guard state.phase == .ready else { return (next, []) }
            // Office Stage B Task 9 — same ticket mechanism as `.opened`'s own (that arm's own header
            // has the full account). A stale failure has nothing left to compensate (nothing was ever
            // opened on the helper for a FAILED attempt) — dropping it is a plain no-op, `next`
            // untouched, unlike `.opened`'s own drop.
            guard pathGeneration == state.pathGenerations[path, default: 0] else { return (next, []) }
            next.openFailures[path] = reason
            let basename = (path as NSString).lastPathComponent
            return (next, [.emitBanner(reason: "Couldn't open \(basename): \(reason)")])

        case .closeRequested(let path):
            // Office Stage B Task 9 — bumped FIRST, unconditionally, even when there is no open
            // document below to actually close: a close can race an open that has not landed yet, and
            // that in-flight `.opened` has no `documents[path]` entry to compare against (the gap
            // `OfficeRuntimeState.pathGenerations`'s own header names as exactly why a docId-keyed
            // guard alone could never catch this case). Every other line in this arm is unchanged.
            next.pathGenerations[path, default: 0] += 1
            next.pendingOpens.removeAll { $0 == path }
            next.openFailures.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path) // Task 8: no path to still be a document about
            next.documentConflicts.removeValue(forKey: path) // Task 2b: same — no path, no conflict about it
            next.documentRecoveryCandidates.removeValue(forKey: path) // Task 7: same — no path, no offer about it
            guard let doc = state.documents[path] else { return (next, []) }
            next.documents.removeValue(forKey: path)
            // Task 8: the watch goes with the document — "a watcher exists exactly while a document
            // does" is an invariant of this reducer, mirroring `EditorRuntimeReducer.closeRequested`'s
            // identical one for models. Task 2b: and so does its own staged copy. Task 7: and so does
            // any autosave sidecar THIS docId (only) may have been growing.
            //
            // **Fix round 1 (review I-2) — `alsoClearManifestOwner: false`, NOT `true` the way
            // `.saveSucceeded`/Discard use it.** The comment this replaced claimed "T3's own
            // dirty-close sheet has already made the user choose... either way there is a deliberate
            // resolution behind it" — true of the CURRENT session's own edits, but T3's gate keys
            // off `dirty`, and a fresh, un-restored open with a STANDING recovery candidate is
            // clean by construction (nothing has been typed in THIS session). A plain close of THAT
            // tab reaches here with no prompt at all and no resolution of the candidate whatsoever —
            // reaching into the manifest here (as the pre-fix code unconditionally did) would delete
            // a crashed session's own sidecar the user never chose to discard. See
            // `.clearAutosave`'s own header for the full account and the bounded, accepted cost of
            // leaving a same-docId manifest standing an extra boot cycle in the ordinary case.
            return (next, [.helperClose(docId: doc.docId), .unwatchFile(path: path),
                           .deleteStagedCopy(docId: doc.docId),
                           .clearAutosave(path: path, docId: doc.docId, alsoClearManifestOwner: false)])

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
            return (next, [.save(path: path, docId: doc.docId, part: doc.activePart)])

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
            // Task 7: same "a save IS the resolution" reasoning, for a standing recovery offer —
            // pressing ⌘S (whether the user ever looked at the banner or not) makes the real path
            // hold exactly this buffer, which is precisely as strong a "resolved" as the conflict
            // clear immediately above.
            next.documentRecoveryCandidates.removeValue(forKey: path)
            // **`restoredPendingSave`'s own header has the full account** — the ONE place this
            // reducer lets a save's own success touch `dirty` directly, because a document loaded
            // from a recovery sidecar was never actually "modified" from LOK's own point of view and
            // will never fire the real `.uno:ModifiedStatus=false` this dot ordinarily waits for.
            if next.documents[path]?.restoredPendingSave == true {
                next.documents[path]?.dirty = false
            }
            next.documents[path]?.restoredPendingSave = false
            // Task 7 — the ownership rule (`.clearAutosave`'s own header): the real path now
            // PROVABLY carries this docId's content (`placeAtomically` already ran, or this dispatch
            // would not exist), so any sidecar it may have been growing is redundant. Unconditional,
            // like `deleteStagedCopy` at every OTHER document-abandoning site — cheap and harmless
            // when nothing was ever autosaved. `alsoClearManifestOwner: true` — a successful save IS
            // the explicit, affirmative resolution `.clearAutosave`'s own header requires for that
            // (unlike `.closeRequested`'s own `false` — fix round 1, review I-2): whatever the
            // manifest for this path currently names, this save just made it moot.
            return (next, [.clearAutosave(path: path, docId: docId, alsoClearManifestOwner: true)])

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
            // Fix round 1 (review F3) — gated at the SOURCE, not only at each downstream consumer.
            // `officeDocumentIsDirty` (`PanelDocumentTab.swift`) already masked its OWN read of this
            // field, but the quit gate's `officeDirtyFilePaths` (`AppDelegate.swift`) read `dirty`
            // RAW and disagreed with it — a read-only `.xlsm` could be named unsaved at quit with no
            // dirty dot and a disabled ⌘S to act on, a dead end. Gating THIS single writer instead
            // means every consumer, present and future, inherits the guarantee for free; the two
            // existing masked predicates become belt rather than the only guard. Only the assignment
            // is gated, not an early return — the recovery-offer clear below stays unconditional on
            // `modified` (harmless for a read-only path: no candidate can exist there in the first
            // place, per the autosave chain's own two-layer fail-closed walk — `saveAsSidecar` throws
            // `unsupportedFormat` before any manifest is ever written).
            next.documents[path]?.dirty = modified && !officeDocumentIsReadOnlyFormat(path: path)
            // **Task 7 (advisor review) — a standing recovery offer must not survive the FIRST real
            // edit after it was raised.** The banner's "Restore" replaces the whole buffer with the
            // sidecar's own (older) content — leaving it standing over a document the user has since
            // made genuinely dirty again is one click from clobbering LIVE new edits with stale ones,
            // the exact "one click from data loss" shape T3's own review flagged for a different
            // banner. `modified == false` intentionally leaves a standing candidate untouched (an
            // undo-back-to-clean does not retroactively make the earlier offer wrong).
            if modified {
                next.documentRecoveryCandidates.removeValue(forKey: path)
            }
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
                // Office Stage B Task 9 — bump BEFORE reading: this reload's own ticket is the
                // POST-bump value, mirroring `.conflictReloadRequested`'s identical pattern below.
                next.pathGenerations[path, default: 0] += 1
                return (next, [.reloadDocument(path: path, oldDocId: doc.docId,
                                               pathGeneration: next.pathGenerations[path]!)])
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

        case .reloadFailed(let path, let oldDocId, let reason, let pathGeneration):
            guard state.phase == .ready else { return (next, []) }
            // **The stale-failure guard**: only act if this path still shows the very entry this
            // reload was trying to replace. A second, independent reload for the same path may
            // already have SUCCEEDED (a fresh `.opened` replaced `oldDocId` with a newer docId) by
            // the time this failure lands — see this event's own header. If so, there is nothing to
            // do: the newer document is genuinely fine, and its own watch is already running.
            guard state.documents[path]?.docId == oldDocId else { return (next, []) }
            // Office Stage B Task 9 — the SECOND, independent stale guard (`.reloadFailed`'s own
            // header has the full account of why `oldDocId` alone is not enough): a second reload for
            // the same path can be INITIATED — bumping this path's ticket — before either one's
            // outcome has landed, and `oldDocId` alone cannot see that yet, because `.reloadDocument`
            // never touches `documents[path]` until its OWN reopen succeeds. Without this, the first
            // of two racing reloads to FAIL would destroy the still-standing entry the second one is
            // about to legitimately replace, flashing a full-screen failure over content that is
            // about to be fine.
            guard pathGeneration == state.pathGenerations[path, default: 0] else { return (next, []) }
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
            // Office Stage B Task 9, fix round 1 (review F2) — every existing ticket BUMPED by one,
            // not carried forward unchanged and not reset to empty: see `pathGenerations`' own header
            // for the full account (the original carry-forward-unchanged rationale here was inverted,
            // not merely simpler). Any ticket an in-flight attempt captured before this boundary is
            // now strictly less than what a post-recovery retry for the same path will read, so a
            // stale reply from before the death can never again match the current value and land.
            fresh.pathGenerations = state.pathGenerations.mapValues { $0 + 1 }
            // **Task 7 — deliberately NO `.clearAutosave` here, for either case.** This IS the
            // abnormal-ending shape autosave exists to survive: `.helperDied` is a literal crash,
            // and `.helperUnavailable` is "never came up" (nothing to protect either way). `fresh`
            // resets `documentRecoveryCandidates` to empty along with every other per-path dict —
            // correct, since whatever candidate a NOW-abandoned open once found is moot the instant
            // its own `documents[path]` entry is gone — but that is `OfficeRuntimeState()`'s own
            // default-empty-dict behavior, not a line this arm writes; nothing here ever reaches for
            // `.clearAutosave(path:docId:)`, on any docId, for any reason. Pinned by
            // `OfficeRuntimeReducerTests.testHelperDiedTeardownAndUnavailableNeverEmitAnAutosaveClear`.
            //
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
            //
            // Task 7 — deliberately NO `.clearAutosave` here either, same reasoning as
            // `.helperDied`/`.helperUnavailable`'s own note: an app quit (this event's real-world
            // trigger, `ShellSessionHost.teardownAllOfficeRuntimesAndStopHelper`) reaches the helper
            // as `_Exit`/SIGKILL exactly like a crash does — "a SIGKILL costs at most a minute" is
            // this task's OWN framing for why that must be true of quit too, not only of a literal
            // abnormal death. Any dirty document's sidecar must survive to the NEXT launch.
            let docIds = state.documents.values.map(\.docId)
            // Task 2b (I3): and every one of THOSE docIds' own staged copies — teardown is exactly
            // as much "release everything this runtime holds" for `docs/` as it already is for the
            // helper's own open handles. Sorted for the same determinism reason as `docIds` itself
            // would want if it were ever asserted order-sensitively.
            let staleCopyEffects = docIds.sorted().map { OfficeRuntimeEffect.deleteStagedCopy(docId: $0) }
            // Task 9, fix round 1 (review F2): same bump-by-one as `.helperDied`/`.helperUnavailable`'s
            // own `fresh.pathGenerations` line — see that arm's comment for the full reasoning,
            // identical here (an app quit reaches the helper as `_Exit`/SIGKILL exactly like a crash
            // does, per this arm's own note above, so the same zombie-reply window applies).
            var fresh = OfficeRuntimeState()
            fresh.pathGenerations = state.pathGenerations.mapValues { $0 + 1 }
            return (fresh, [.teardown(docIds: docIds)] + staleCopyEffects)

        // MARK: Office Stage B Task 2b — resolving a standing conflict

        case .conflictReloadRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            next.documentConflicts.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path)
            // The SAME reload machinery a clean document's silent external-change path already
            // uses — discard my edits, re-stage the current on-disk bytes under a fresh docId.
            // Office Stage B Task 9 — bumps this path's ticket, identical pattern to
            // `.externalChangeDetected`'s own clean-reload arm.
            next.pathGenerations[path, default: 0] += 1
            return (next, [.reloadDocument(path: path, oldDocId: doc.docId,
                                           pathGeneration: next.pathGenerations[path]!)])

        case .conflictKeepMineRequested(let path):
            guard state.phase == .ready, state.documents[path] != nil else { return (next, []) }
            // Dismiss — nothing else moves. The document stays exactly as it is (still dirty, still
            // showing its in-memory edits); the next ⌘S is what actually overwrites/recreates the
            // real path, exactly as `.saveSucceeded`'s own arm already resolves a conflict.
            next.documentConflicts.removeValue(forKey: path)
            next.documentBanners.removeValue(forKey: path)
            return (next, [])

        // MARK: Office Stage B Task 7 — autosave sidecars + crash recovery

        case .autosaved(let docId, let ext, let isODFFallback):
            // Same docId->path resolution `.modifiedStatusChanged` already uses one arm up — the
            // push itself carries only `docId`.
            guard state.phase == .ready,
                  let path = state.documents.first(where: { $0.value.docId == docId })?.key else {
                return (next, [])
            }
            return (next, [.recordAutosave(path: path, docId: docId, ext: ext, isODFFallback: isODFFallback)])

        case .recoveryCandidateFound(let path, let docId, let candidate):
            // The stale-open guard: the async check that produced this can land after a close or a
            // second, faster reload already moved this path past the docId it was checking FOR —
            // same shape as `.saveSucceeded`'s own guard, same reason.
            guard state.phase == .ready, state.documents[path]?.docId == docId else { return (next, []) }
            next.documentRecoveryCandidates[path] = candidate
            return (next, [])

        case .recoveryRestoreRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path],
                  let candidate = state.documentRecoveryCandidates[path] else { return (next, []) }
            // Optimistic clear — mirrors `.conflictReloadRequested`'s identical posture: the offer
            // is acted on now, and a failure surfaces as an ordinary reload-failure banner rather
            // than resurrecting the same candidate for a retry (the sidecar itself is untouched
            // either way, so nothing is actually lost by not offering a second chance here).
            next.documentRecoveryCandidates.removeValue(forKey: path)
            // Office Stage B Task 9 — restore is reload-shaped (close old, open new), so it bumps
            // this path's ticket on the identical terms as `.reloadDocument`'s own emission sites.
            next.pathGenerations[path, default: 0] += 1
            return (next, [.restoreFromSidecar(path: path, oldDocId: doc.docId, sidecarPath: candidate.sidecarPath,
                                               pathGeneration: next.pathGenerations[path]!)])

        case .recoveryDiscardRequested(let path):
            guard state.phase == .ready, let candidate = state.documentRecoveryCandidates[path] else { return (next, []) }
            next.documentRecoveryCandidates.removeValue(forKey: path)
            return (next, [.discardRecoveryCandidate(path: path, docId: candidate.docId)])

        case .recoveryRestored(let path, let docId):
            // Stale-open guard, same shape as `.recoveryCandidateFound`'s own — a close or a second
            // reload racing the restore's own round trip must not force `dirty=true` onto whatever
            // ELSE this path now shows.
            guard state.phase == .ready, state.documents[path]?.docId == docId else { return (next, []) }
            next.documents[path]?.dirty = true
            next.documents[path]?.restoredPendingSave = true
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
        /// Fix round 4 (NEW-2) — `part` added: the USER's own active part, which the helper asserts
        /// onto LOK immediately before writing so that ordinary paint traffic cannot decide which
        /// part the saved view state records. Resolved by the reducer (`.saveRequested`), from the
        /// same `DocumentEntry.activePart` the input verbs read.
        var save: (_ docId: String, _ part: Int) async throws -> String
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
        /// Office Stage B Task 5 — the IME door, same fire-and-forget posture and same
        /// `officeRequestQueue` routing as `postKey`/`postMouse` above. See
        /// `OfficeRuntime.postExtTextInput`'s own header for why it joins `postKey`/`postMouse`'s
        /// SAME `inputChainTail` ordering chain rather than a chain of its own.
        var postExtTextInput: (_ docId: String, _ part: Int, _ type: OfficeExtTextInputType, _ text: String) async -> Void
        /// Office Stage B Task 6 — reads the current text selection. `nil` on any failure
        /// (`docNotOpen`, a protocol error) — same fire-and-forget-but-not-silent posture
        /// `close`/`unsubscribeTiles` already have (the production implementation logs a thrown
        /// error; there is no caller-side recovery action either way). `""` — LOK's own "no
        /// selection" answer — is a LEGAL, non-`nil` result: only a genuine failure answers `nil`.
        var clipboardCopy: (_ docId: String, _ part: Int) async -> String?
        /// Same shape as `clipboardCopy`, but also deletes the selection on the far side.
        var clipboardCut: (_ docId: String, _ part: Int) async -> String?
        /// Fire-and-forget, same posture as `postKey`/`postMouse` — a paste that fails has nothing
        /// for `OfficeRuntime` to roll back, only something worth logging.
        var clipboardPaste: (_ docId: String, _ part: Int, _ text: String) async -> Void
        /// `.uno:Undo` against the document's own primary view. Fire-and-forget — see
        /// `OfficeWireFrame.undoOk`'s own header for why this never claims to have changed
        /// anything, only that the command was dispatched.
        var undo: (_ docId: String) async -> Void
        /// `.uno:Redo`, same posture as `undo` above.
        var redo: (_ docId: String) async -> Void
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

    /// Office Stage B Task 5 — the caret/selection/cell-cursor sibling to `tileStore` above, on the
    /// identical "heavy/high-frequency, must never ride `@Published state`" reasoning — see
    /// `OfficeCursorStore`'s own header. Evicted at every site `tileStore` itself is (close, reload,
    /// teardown, helper death/unavailability) — grep `tileStore.evict` for the exact call sites this
    /// mirrors, one line below each.
    let cursorStore = OfficeCursorStore()

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

    /// Office Stage B Task 7 — where the helper's own `OfficeAutosaveScheduler` writes sidecars,
    /// and where this runtime's own manifest entries live alongside them (one JSON file per
    /// document, `<pathHash>.manifest.json` — see `OfficeAutosaveManifestEntry`'s own header for
    /// why per-document, not one shared file). Sibling to `docsDirectory` above, same reasoning.
    private var autosaveDirectory: URL { driver.stateDirectory.appendingPathComponent("autosave", isDirectory: true) }

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

    /// Office Stage B Task 6 — where `postClipboardCopy`/`postClipboardCut` write their result.
    /// Injected, like `makeWatcher` above, rather than touching `NSPasteboard.general` directly in
    /// this file: the actual write happens INSIDE the `inputChainTail` chain (see
    /// `postClipboardCopy`'s own header for why — the advisor's own review point for this task),
    /// so a test proving chain-ordering must be able to observe/replace it without touching the
    /// REAL system pasteboard (shared, global, and a source of cross-test flake if several test
    /// runs ever wrote to it concurrently).
    private let writeSystemPasteboard: (String) -> Void

    init(sessionId: String, driver: Driver, makeDocId: @escaping () -> String = { UUID().uuidString },
         makeWatcher: @escaping EditorFileWatcherFactory = { path, onChange in
             DispatchSourceFileWatcher(path: path, onChange: onChange)
         },
         writeSystemPasteboard: @escaping (String) -> Void = { text in
             let pasteboard = NSPasteboard.general
             pasteboard.clearContents()
             pasteboard.setString(text, forType: .string)
         }) {
        self.sessionId = sessionId
        self.driver = driver
        self.makeDocId = makeDocId
        self.makeWatcher = makeWatcher
        self.writeSystemPasteboard = writeSystemPasteboard
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
    ///
    /// **Task 9 — a no-op for a read-only-format path too, defense-in-depth.** `officeSaveMenuTarget`
    /// (`PanelDocumentTab.swift`) is the one reachable door today and already refuses this case, but
    /// gating the runtime door itself means a future SECOND caller can never bypass it by construction
    /// — the same posture every input verb below (`postKeyEvent` and its siblings) already takes.
    func save(_ path: String) {
        guard !officeDocumentIsReadOnlyFormat(path: path) else { return }
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
    /// Task 9 — a read-only-format path answers `.noModel` immediately, never registering a waiter:
    /// same reasoning as `save(_:)`'s own gate, in the identical shape this function's own doc
    /// already uses for "no `.save` effect exists" (there never was a model here to save).
    func saveAndAwaitOutcome(_ path: String) async -> SaveOutcome {
        guard !officeDocumentIsReadOnlyFormat(path: path) else { return .noModel }
        return await withCheckedContinuation { continuation in
            let effects = dispatch(.saveRequested(path: path))
            guard case .save(_, let docId, _)? = effects.first else {
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

    /// Office Stage B Task 7 — the recovery banner's "Restore": replace the buffer with the
    /// sidecar's own content. Thin, mirroring `reloadFromDisk`/`keepMyVersion`'s own one-line shape
    /// exactly — everything about WHAT that means (re-stage from the sidecar, force dirty) lives in
    /// the reducer/`openAndDispatch`, not here.
    func restoreFromRecovery(_ path: String) {
        perform(dispatch(.recoveryRestoreRequested(path: path)))
    }

    /// The recovery banner's "Discard" — decline the offer; delete the sidecar and its manifest
    /// entry, no other document state changes (the tab is already showing the real file's own
    /// content, opened normally).
    func discardRecovery(_ path: String) {
        perform(dispatch(.recoveryDiscardRequested(path: path)))
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
    /// **Office Stage B Task 9 — the read-only-viewer gate, applied here (and at every OTHER
    /// mutation verb below) rather than only in the UI.** `officeDocumentIsDirty`'s own header has
    /// the full argument for why this is required, not merely a defensive extra: without it, a
    /// read-only-format document would still accept keystrokes at the LOK layer (visibly, on the
    /// canvas) while the UI silently refuses to ever show a dirty dot or offer ⌘S — a user could
    /// type, watch it render, and lose it without warning the instant the tab closes. Gating HERE
    /// means the buffer never actually diverges from disk in the first place, which is what makes
    /// "no dirty tracking" an honest description rather than a UI-only illusion. `postClipboardCopy`
    /// is the one sibling that does NOT gate — copying out is a pure read, not a mutation.
    func postKeyEvent(path: String, type: OfficeKeyEventType, charCode: Int, keyCode: Int) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
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
    /// **Task 9 — deliberately NOT gated on `officeDocumentIsReadOnlyFormat`, unlike `postKeyEvent`
    /// and the other mutation verbs below.** Mouse events only ever move the caret or extend a
    /// selection in LOK's own model — no click/drag alone mutates document content (that requires a
    /// subsequent key/IME/paste event, all of which ARE gated) — so leaving this door open is what
    /// lets a read-only viewer still support click-to-position and click-drag-to-select, the
    /// mechanism `postClipboardCopy`'s own un-gated door depends on to have anything to copy.
    /// Blocking mouse input here would make the canvas inert (no visible caret, no selection ever
    /// possible) for no corresponding safety gain.
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

    /// Office Stage B Task 5 — same door, same `inputChainTail` ordering chain, for the IME
    /// marked-text/commit verb. See `postKeyEvent`'s own header for the full ordering reasoning —
    /// not independently re-explained here.
    ///
    /// **Joins the SAME chain as `postKeyEvent`/`postMouseEvent`, not a chain of its own.** A
    /// composition keystroke and an ordinary key/mouse event can legitimately interleave around each
    /// other (an arrow key committing a composition, a click repositioning the caret mid-compose) —
    /// two independent chains would let LOK see them in an order that does not match how the user
    /// actually produced them, the identical corruption `postKeyEvent`'s own header names as the
    /// reason a hand-rolled chain exists at all rather than one `Task` per call.
    /// Task 9: same read-only-format gate as `postKeyEvent`'s own — an IME commit mutates content
    /// exactly like an ordinary keystroke does, so it is gated on the identical terms.
    func postExtTextInput(path: String, type: OfficeExtTextInputType, text: String) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.postExtTextInput(docId, part, type, text)
        }
    }

    /// Office Stage B Task 6 — same door, same `inputChainTail` ordering chain, for Copy. Joins
    /// the chain for the SAME reason `postKeyEvent`'s own header gives: a paste racing ahead of a
    /// queued caret-click would paste at the wrong position, and a copy racing ahead of the
    /// keystrokes that produced the selection it reads would read the WRONG selection — advisor
    /// review, this task.
    ///
    /// **The pasteboard WRITE happens INSIDE the chained task, after the reply arrives** — not
    /// returned to the caller for it to write later. A caller-side write (e.g. from
    /// `OfficeTileCanvasView.copy(_:)`, `Task { await runtime.something(); writeToPasteboard() }`)
    /// would run OUTSIDE this chain's own ordering guarantee: a rapid ⌘C-then-⌘V could read the
    /// system pasteboard before this call's own asynchronous round trip had actually written to
    /// it. Writing here, as the chain's own last act for this call, closes that window the same
    /// way every other ordering guarantee in this file is closed — by construction, not by timing.
    func postClipboardCopy(path: String) {
        guard let doc = state.documents[path] else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver, writeSystemPasteboard] in
            _ = await previous.value
            guard let text = await driver.clipboardCopy(docId, part), !text.isEmpty else { return }
            writeSystemPasteboard(text)
        }
    }

    /// Same door, same chain, same "write inside the chained task" reasoning as `postClipboardCopy`
    /// above — for Cut.
    /// Task 9: gated, unlike `postClipboardCopy` immediately above — Cut MUTATES (it is a copy
    /// followed by a delete), the same reason it is not grouped with Copy's own un-gated posture.
    func postClipboardCut(path: String) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver, writeSystemPasteboard] in
            _ = await previous.value
            guard let text = await driver.clipboardCut(docId, part), !text.isEmpty else { return }
            writeSystemPasteboard(text)
        }
    }

    /// Office Stage B Task 6 — Paste. `text` is captured by the CALLER at gesture time (e.g.
    /// `OfficeTileCanvasView.paste(_:)` reads `NSPasteboard.general` synchronously, before ever
    /// calling this door) and passed in here, NEVER re-read from the system pasteboard from inside
    /// the chained task below — advisor review, this task: another app (or another paste on this
    /// SAME wire, still ahead in the chain) could change the system pasteboard between when the
    /// user pressed ⌘V and when this call's own turn in the chain arrives; reading at gesture time
    /// is what makes "what gets pasted" match what the user actually saw on the pasteboard when
    /// they asked.
    /// Task 9: same read-only-format gate as `postKeyEvent`'s own — Paste mutates exactly like
    /// typing does.
    func postClipboardPaste(path: String, text: String) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
        let docId = doc.docId
        let part = doc.activePart
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.clipboardPaste(docId, part, text)
        }
    }

    /// Office Stage B Task 6 — `.uno:Undo`, same door, same chain: an undo racing ahead of a
    /// queued keystroke would undo the wrong (not-yet-landed) edit.
    /// Task 9: same read-only-format gate as `postKeyEvent`'s own. Largely redundant in practice —
    /// with typing/paste/cut all gated too, a read-only-format document's own LOK-side undo stack
    /// never has anything mutating pushed onto it in the first place — but kept for the same
    /// consistency and defense-in-depth every OTHER mutation verb here gets.
    func postUndo(path: String) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
        let docId = doc.docId
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.undo(docId)
        }
    }

    /// `.uno:Redo`, same posture as `postUndo` above.
    func postRedo(path: String) {
        guard let doc = state.documents[path], !officeDocumentIsReadOnlyFormat(path: path) else { return }
        let docId = doc.docId
        let previous = inputChainTail
        inputChainTail = Task { [driver] in
            _ = await previous.value
            await driver.redo(docId)
        }
    }

    /// Test-only: awaits the current tail of the input-ordering chain, so a test can know a
    /// `postKeyEvent`/`postMouseEvent`/`postExtTextInput`/`postClipboardCopy`/`postClipboardCut`/
    /// `postClipboardPaste`/`postUndo`/`postRedo` call has actually reached the driver before
    /// asserting on its effect, without a `waitUntil` poll racing the chain's own scheduling.
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
            // Office Stage B Task 7 — the manifest-aware autosave sweep, once per FRESH helper
            // boot (`.ready` fires exactly there — a relaunch after `.helperDied` is exactly the
            // boot this sweep exists to clean up after, mirroring `lok-profile-*`'s own "one live
            // helper at a time" safety argument one layer up). Every session's own runtime reaches
            // this on the SAME shared helper's readiness (`OfficeHelperSupervisor.events` is fanned
            // out to all of them — this file's own header), so a multi-session app runs this
            // redundantly, not exactly-once — harmless: the sweep only ever removes PROVABLY
            // orphaned files (`sweepAutosaveOrphans`'s own header), so a second pass a beat later
            // simply finds nothing left to do. Off `@MainActor`, best-effort, never blocks readiness.
            let autosaveDirectory = autosaveDirectory
            Task.detached(priority: .utility) { Self.sweepAutosaveOrphans(autosaveDirectory: autosaveDirectory) }
        case .helperDied:
            // Task 6: every docId this runtime's store still holds dies with the helper, in the
            // SAME beat the reducer wipes `state.documents` below — see `OfficeTileStore
            // .evictEverything`'s own header for why this is the sweep that keeps a dead-connection
            // in-flight marker from wedging a placeholder forever.
            tileStore.evictEverything()
            cursorStore.evictEverything()
            perform(dispatch(.helperDied))
        case .helperUnavailable:
            tileStore.evictEverything()
            cursorStore.evictEverything()
            perform(dispatch(.helperUnavailable))
        }
    }

    /// Office Stage B Task 2 — **the dirty-tracking door**: fed by `ShellSessionHost
    /// .wireOfficeTileCallbacks`'s `onDocumentEvent` routing (that method's own doc explains why it,
    /// not a second wiring site, is where a fresh client's callbacks are re-pointed on every helper
    /// relaunch), by docId, the same way `officeRuntime(owning:)` routes tile pushes one level up.
    ///
    /// **Office Stage B Task 5** — gained a SECOND arm, deliberately NOT routed through
    /// `dispatch`/`perform` the way `.modifiedChanged` is: caret/selection/cell-cursor events fire at
    /// keystroke/drag frequency, and `dispatch` reassigns the WHOLE `@Published state` value on every
    /// call — exactly the SwiftUI-invalidation churn `OfficeTileStore`'s own header already forbids
    /// for tile bytes, now extended to this store too (advisor review, this task). `cursorStore.apply`
    /// is the direct, `@Published`-free equivalent of `tileStore.invalidate` one door up
    /// (`onInvalidated`'s own wiring) — same reasoning, same bypass, same MainActor-hop-already-done
    /// threading contract (`wireOfficeTileCallbacks`'s own `Task { @MainActor ... }`).
    ///
    /// `activePart` is resolved here, not carried on the wire — none of these callback types
    /// (`INVALIDATE_VISIBLE_CURSOR`/`TEXT_SELECTION`(`_START`/`_END`)/`CELL_CURSOR`, and Task 8's
    /// own `CELL_FORMULA`) carry a part number in their own LOK payload (unlike `INVALIDATE_TILES`),
    /// so "which part was this rect/text computed against" has to come from the SAME
    /// `DocumentEntry.activePart` the input verbs themselves read — the identical docId->path
    /// resolution `.modifiedStatusChanged`'s own reducer arm already uses one door down.
    ///
    /// `.opened`/`.openFailed`/`.closed` are never sent this way at all in Stage A/B (their own
    /// direct, seq-correlated reply frames cover `open`/`close`) — the two remaining cases
    /// (`.invalidated`, routed through `onInvalidated`/`OfficeTileStore.invalidate` one door up) fall
    /// through the `default` arm here, matching `LOKBridge.handleCallback`'s own "not every callback
    /// has Stage A/B meaning" posture toward LOK's raw callback types one layer down.
    func handle(documentEvent event: OfficeDocumentEvent, docId: String) {
        switch event {
        case .modifiedChanged(let modified):
            perform(dispatch(.modifiedStatusChanged(docId: docId, modified: modified)))
        case .caretRect, .textSelection, .textSelectionStart, .textSelectionEnd, .cellCursor, .cellFormula:
            let activePart = state.documents.first(where: { $0.value.docId == docId })?.value.activePart ?? 0
            cursorStore.apply(docId: docId, event: event, activePart: activePart)
        case .autosaved(let ext, let isODFFallback):
            perform(dispatch(.autosaved(docId: docId, ext: ext, isODFFallback: isODFFallback)))
        case .opened, .openFailed, .invalidated, .closed:
            return
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

            case .helperOpen(let path, let pathGeneration):
                openAndDispatch(path: path, myGeneration: generation, myPathGeneration: pathGeneration,
                                reloadingDocId: nil)

            case .reloadDocument(let path, let oldDocId, let pathGeneration):
                // Task 8: same store hygiene as an ordinary close (`.helperClose`'s own doc) — the
                // old docId's tiles are gone THE INSTANT this fires, synchronously, before the new
                // open even starts, so a stray push arriving for it lands nowhere (the store has no
                // record of it left to overwrite, and nothing downstream ever asks for that docId
                // again — see `OfficeTileStore`'s own header on why a late arrival here is bounded).
                tileStore.evictAll(docId: oldDocId)
                cursorStore.evict(docId: oldDocId)
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
                openAndDispatch(path: path, myGeneration: generation, myPathGeneration: pathGeneration,
                                reloadingDocId: oldDocId)

            case .save(let path, let docId, let part):
                performSave(path: path, docId: docId, part: part, myGeneration: generation)

            case .watchFile(let path):
                startWatching(path)

            case .unwatchFile(let path):
                stopWatching(path)

            case .helperClose(let docId):
                // Task 6: the store's own docId-scoped entries die with the document — see
                // `OfficeTileStore.evictAll`'s own header.
                tileStore.evictAll(docId: docId)
                cursorStore.evict(docId: docId)
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

            // MARK: Office Stage B Task 7 — autosave sidecars + crash recovery

            case .restoreFromSidecar(let path, let oldDocId, let sidecarPath, let pathGeneration):
                // Identical store hygiene to `.reloadDocument`'s own performer immediately above —
                // this IS that machinery, called with a different `stageFrom:`/`markDirtyOnOpen:`.
                tileStore.evictAll(docId: oldDocId)
                cursorStore.evict(docId: oldDocId)
                Task { [driver] in await driver.close(oldDocId) }
                let docsDirectory = docsDirectory
                Task.detached(priority: .utility) {
                    Self.deleteStagedCopy(docId: oldDocId, docsDirectory: docsDirectory)
                }
                openAndDispatch(path: path, myGeneration: generation, myPathGeneration: pathGeneration,
                                reloadingDocId: oldDocId, stageFrom: sidecarPath, markDirtyOnOpen: true)

            case .recordAutosave(let path, let docId, let ext, let isODFFallback):
                let autosaveDirectory = autosaveDirectory
                Task.detached(priority: .utility) {
                    Self.recordAutosaveManifest(realPath: path, docId: docId, ext: ext,
                                                isODFFallback: isODFFallback, autosaveDirectory: autosaveDirectory)
                }

            case .clearAutosave(let path, let docId, let alsoClearManifestOwner):
                let autosaveDirectory = autosaveDirectory
                Task.detached(priority: .utility) {
                    Self.clearAutosave(realPath: path, docId: docId, autosaveDirectory: autosaveDirectory,
                                       alsoClearManifestOwner: alsoClearManifestOwner)
                }

            case .discardRecoveryCandidate(let path, let docId):
                // Same imperative call as `.clearAutosave` immediately above — see that effect's own
                // header for why this stays a separate CASE regardless (test-side distinguishability).
                // `alsoClearManifestOwner: true` hardcoded, never threaded through this case's own
                // associated values — Discard is UNCONDITIONALLY an explicit resolution (the user
                // just said so), the same reasoning `.saveSucceeded`'s own `true` rests on.
                let autosaveDirectory = autosaveDirectory
                Task.detached(priority: .utility) {
                    Self.clearAutosave(realPath: path, docId: docId, autosaveDirectory: autosaveDirectory,
                                       alsoClearManifestOwner: true)
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
    ///
    /// **Office Stage B Task 7 — two additive parameters, both `nil`/`false` for every call site
    /// that predates this task, so `.helperOpen`/plain `.reloadDocument` are byte-identical to
    /// before.**
    ///
    /// `stageFrom`, when set, is copied INTO the staged path instead of `path` itself — the
    /// recovery banner's "Restore" (`.restoreFromSidecar`'s own performer, below) is the one caller
    /// that sets it, to the sidecar's own path, so the fresh LOK document loads the RECOVERED
    /// content while every app-facing surface keeps speaking `path` unchanged (the tab, the
    /// watcher, `documents[path]`'s own dictionary key) — "reuse the T2b staging machinery" from
    /// this task's own dispatch note, made literal.
    ///
    /// `markDirtyOnOpen`, when true, dispatches ONE more event right after `.opened` lands
    /// successfully: `.recoveryRestored(path:docId:)`, which forces `dirty=true` on the fresh entry
    /// (see `DocumentEntry.restoredPendingSave`'s own header for why LOK's own signal can never do
    /// this on its own for a document loaded from a sidecar). Never set without `stageFrom` also
    /// being set in practice — the two arrive together from `.restoreFromSidecar`'s one call site —
    /// but kept as two independent parameters rather than one, since "where the bytes come from"
    /// and "whether to force dirty" are two genuinely separate facts a future caller could want
    /// independently (a hypothetical "restore but the recovered content is identical, don't force a
    /// dirty dot" would set the first without the second).
    ///
    /// **Office Stage B Task 9 — `myPathGeneration`.** Threaded straight through from whichever
    /// effect (`.helperOpen`/`.reloadDocument`/`.restoreFromSidecar`) triggered this call — never
    /// read from `self` again inside this function, unlike `myGeneration`: the reducer already
    /// computed the correct ticket for THIS attempt at the moment it decided to emit that effect
    /// (`OfficeRuntimeState.pathGenerations`'s own header), so there is nothing left for the
    /// imperative half to compare it against until the attempt actually lands — see the `.opened`/
    /// `.openFailed`/`.reloadFailed` dispatch sites below, and that state field's own header for why
    /// the comparison itself belongs in the reducer, not here.
    private func openAndDispatch(path: String, myGeneration: Int, myPathGeneration: Int, reloadingDocId: String?,
                                  stageFrom: String? = nil, markDirtyOnOpen: Bool = false) {
        let docId = makeDocId()
        let stagedPath = Self.stagedPath(forDocId: docId, realPath: path, docsDirectory: docsDirectory)
        let docsDirectory = docsDirectory
        let autosaveDirectory = autosaveDirectory
        let copySource = stageFrom ?? path
        Task { [weak self, driver] in
            guard let self else { return }
            do {
                // **Office Stage B Task 2b — stage BEFORE the wire open.** The Collabora jail: this
                // app (unsandboxed, the trust boundary) copies `copySource` INTO the helper's own
                // `--state-path` first; the wire `open` below carries the STAGED path, never the
                // real one — the helper never touches, and never even learns, `path` (or, for a
                // restore, the sidecar's own path) itself from here on. Off `@MainActor` — a real
                // copy, mirrors `performSave`'s own `Task.detached` around `placeAtomically`
                // exactly, for the identical reason (a large document must not stall the shell).
                try await Task.detached(priority: .userInitiated) {
                    try Self.stageDocument(realPath: copySource, stagedPath: stagedPath)
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
                self.perform(self.dispatch(.opened(path: path, docId: docId, stagedPath: stagedPath, metadata: metadata,
                                                    pathGeneration: myPathGeneration)))
                if markDirtyOnOpen {
                    self.perform(self.dispatch(.recoveryRestored(path: path, docId: docId)))
                }
                // Office Stage B Task 7 — the recovery-candidate check, ONLY for a genuinely FRESH
                // open. `reloadingDocId == nil` excludes both an ordinary reload AND a restore
                // (`.restoreFromSidecar`'s own performer always passes the docId it is replacing) —
                // a document already open in this runtime never needs a second chance to offer
                // whatever candidate existed at its ORIGINAL open, and re-running this for a restore
                // would immediately re-discover the very sidecar Restore just consumed. Off
                // `@MainActor`, best-effort, never blocks the open the way staging/the wire open
                // above do — a missing/corrupt manifest or a stat failure simply means no banner,
                // never a failed open.
                if reloadingDocId == nil {
                    let realPath = path
                    let candidate = await Task.detached(priority: .utility) {
                        Self.checkRecoveryCandidate(realPath: realPath, autosaveDirectory: autosaveDirectory)
                    }.value
                    if let candidate {
                        self.perform(self.dispatch(.recoveryCandidateFound(path: path, docId: docId, candidate: candidate)))
                    }
                }
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
                    self.perform(self.dispatch(.reloadFailed(path: path, oldDocId: reloadingDocId, reason: reason,
                                                              pathGeneration: myPathGeneration)))
                } else {
                    self.perform(self.dispatch(.openFailed(path: path, reason: reason, pathGeneration: myPathGeneration)))
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
    private func performSave(path: String, docId: String, part: Int, myGeneration: Int) {
        Task { [weak self, driver] in
            guard let self else { return }
            do {
                let tempPath = try await driver.save(docId, part)
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

    // MARK: - Office Stage B Task 7: the autosave manifest (sidecar<->realPath, app-side only)

    /// `<autosaveDirectory>/<sha256(realPath)>.manifest.json` — ONE small JSON file PER DOCUMENT,
    /// not one shared table. Deliberate: two documents' sidecars can autosave concurrently (each on
    /// its OWN helper-side timer), and a shared file would need a read-modify-write on every
    /// update, racing across runtimes/documents for no reason a per-document file doesn't already
    /// avoid for free — each write here is a single, independent, ATOMIC full-file overwrite of a
    /// path no other document's own write ever touches. `SHA256`, not because this needs to be
    /// cryptographically secure (it does not — this is a filename, not a credential) but because a
    /// raw path cannot BE one (`/` alone rules that out) and this is the same "content -> stable hex
    /// filename" idiom `OfficeHarness.sha256Hex` already established elsewhere in this app.
    nonisolated private static func autosaveManifestPath(forRealPath path: String, autosaveDirectory: URL) -> URL {
        let hash = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        return autosaveDirectory.appendingPathComponent("\(hash).manifest.json")
    }

    /// Office Stage B Task 7 — one document's own sidecar<->realPath mapping, atomically written by
    /// `recordAutosaveManifest` and read by `checkRecoveryCandidate`/`sweepAutosaveOrphans`. `Codable`
    /// (not hand-rolled JSON like `OfficeDocumentEvent`'s wire encoding) — this never crosses the
    /// wire, it is a private-to-this-app disk format with no cross-language/cross-version contract
    /// to keep, so there is nothing the wire's own hand-rolled discipline buys here that `Codable`
    /// doesn't already give for free.
    struct OfficeAutosaveManifestEntry: Codable, Equatable {
        /// The REAL path this entry is about — re-checked on every read (`entry.realPath == path`)
        /// as a defensive belt against a SHA256 collision ever mapping two different real paths to
        /// the same manifest filename (astronomically unlikely, checked anyway: the cost of the
        /// comparison is one string equality, the cost of skipping it is a wrong-document recovery
        /// offer if it ever happened).
        var realPath: String
        /// The CRASHED session's own docId — `autosave/<docId>.<ext>` is where its sidecar lives.
        /// Deliberately NOT the docId of whatever is open now (a fresh open always mints a new one).
        var docId: String
        var ext: String
        var isODFFallback: Bool
        /// The sidecar's own mtime AT THE MOMENT this entry was written — epoch seconds, fractional.
        /// `checkRecoveryCandidate` does NOT trust this for the actual freshness decision (it re-stats
        /// the sidecar live — the file on disk is always the fresher truth); this is what a banner's
        /// "~Ns ago" is computed from without a second stat call, and what `sweepAutosaveOrphans`
        /// uses for its own "sidecar mtime <= real file mtime" pair-drop refinement.
        var sidecarModifiedAt: Double
    }

    /// Office Stage B Task 7 — `.recordAutosave`'s own performer: called every time the helper
    /// pushes `.autosaved(docId:ext:isODFFallback:)`, i.e. roughly once per interval for as long as
    /// a document stays dirty. Re-stats the sidecar the helper JUST wrote (never trusts a
    /// wire-carried timestamp — one fewer thing that could be stale by the time this runs) and
    /// overwrites the manifest entry wholesale. A sidecar that has ALREADY been cleared by the time
    /// this runs (a save landed in the same beat a stale autosave push was still in flight) simply
    /// fails the stat and writes nothing — never resurrects a manifest entry for a sidecar that no
    /// longer exists.
    nonisolated static func recordAutosaveManifest(realPath: String, docId: String, ext: String,
                                                    isODFFallback: Bool, autosaveDirectory: URL) {
        let sidecarPath = autosaveDirectory.appendingPathComponent("\(docId).\(ext)").path
        guard let stat = officeFileStat(atPath: sidecarPath) else { return }
        let entry = OfficeAutosaveManifestEntry(
            realPath: realPath, docId: docId, ext: ext, isODFFallback: isODFFallback,
            sidecarModifiedAt: Double(stat.modifiedSeconds) + Double(stat.modifiedNanoseconds) / 1_000_000_000)
        guard let data = try? JSONEncoder().encode(entry) else { return }
        try? FileManager.default.createDirectory(at: autosaveDirectory, withIntermediateDirectories: true)
        try? data.write(to: Self.autosaveManifestPath(forRealPath: realPath, autosaveDirectory: autosaveDirectory),
                        options: .atomic)
    }

    /// `true` when `newer`'s own stat is strictly later than `older`'s — nanosecond-resolution,
    /// mirroring `officeFileStat`'s own reason for carrying both fields (a same-second POSIX mtime
    /// with a genuinely different nanosecond component must still compare correctly).
    nonisolated private static func statIsNewer(_ newer: OfficeFileStat, than older: OfficeFileStat) -> Bool {
        (newer.modifiedSeconds, newer.modifiedNanoseconds) > (older.modifiedSeconds, older.modifiedNanoseconds)
    }

    /// **The recovery-candidate check — `openAndDispatch`'s own fresh-open-only call.** `nil` for
    /// every "nothing to offer" outcome (no manifest, unreadable/corrupt manifest, a hash-collision
    /// mismatch, a missing sidecar, a missing real file, or a sidecar that is NOT newer than the
    /// real file) — deliberately side-effect-free (never deletes a stale manifest/orphan sidecar it
    /// finds along the way; that is `sweepAutosaveOrphans`'s own job, kept separate so this stays a
    /// pure read no caller has to reason about beyond its own return value).
    nonisolated static func checkRecoveryCandidate(realPath: String, autosaveDirectory: URL) -> OfficeRecoveryCandidate? {
        let manifestPath = Self.autosaveManifestPath(forRealPath: realPath, autosaveDirectory: autosaveDirectory)
        guard let data = try? Data(contentsOf: manifestPath),
              let entry = try? JSONDecoder().decode(OfficeAutosaveManifestEntry.self, from: data),
              entry.realPath == realPath else {
            return nil
        }
        let sidecarPath = autosaveDirectory.appendingPathComponent("\(entry.docId).\(entry.ext)").path
        guard let sidecarStat = officeFileStat(atPath: sidecarPath),
              let realStat = officeFileStat(atPath: realPath),
              Self.statIsNewer(sidecarStat, than: realStat) else {
            return nil
        }
        let capturedAt = Date(timeIntervalSince1970:
            Double(sidecarStat.modifiedSeconds) + Double(sidecarStat.modifiedNanoseconds) / 1_000_000_000)
        return OfficeRecoveryCandidate(docId: entry.docId, sidecarPath: sidecarPath, capturedAt: capturedAt,
                                       isODFFallback: entry.isODFFallback)
    }

    /// Office Stage B Task 7 — **the ownership rule's app-side half**: deletes `docId`'s own
    /// sidecar (glob-by-prefix, identical mechanism to `deleteStagedCopy` immediately above — same
    /// "no second, driftable path table" reasoning) AND `path`'s own manifest entry. Called from
    /// exactly the three sites `.clearAutosave`'s own header enumerates — see that effect's doc for
    /// why `.helperDied`/`.helperUnavailable`/`.teardownRequested` never reach this. Best-effort,
    /// `nonisolated`, same posture as every other cleanup call in this file.
    ///
    /// **Live-drill-caught (not theoretical): when `alsoClearManifestOwner` is true, also clears the
    /// MANIFEST's own recorded docId, not only the literal `docId` passed in.** After a Restore,
    /// `path`'s currently-open docId is a FRESH one (`openAndDispatch` always mints a new docId,
    /// restore included) — completely different from the CRASHED session's own docId the sidecar on
    /// disk is actually named after (`OfficeRecoveryCandidate.docId`, threaded into the manifest at
    /// `recordAutosaveManifest` time and never re-derived from the currently-open document
    /// anywhere). A save landing right after a Restore-with-no-further-typing calls this with the
    /// RESTORED docId, which never had a sidecar of its own — clearing only that docId's prefix
    /// would silently leave the crashed session's real sidecar behind forever. Reading the manifest
    /// FIRST (before deleting it) and unioning its own `docId` into the sweep fixes this for every
    /// `alsoClearManifestOwner: true` caller uniformly, without threading a second "which docId did
    /// this content actually come from" fact through the reducer/effects layer — the manifest
    /// already IS that fact, sitting right here about to be read anyway.
    ///
    /// **`alsoClearManifestOwner` — fix round 1 (review I-2, at the Critical boundary).** Gates BOTH
    /// the union-read-and-sweep above AND the manifest-file deletion at the bottom — not just the
    /// former. `.clearAutosave`'s own header (`OfficeRuntimeEffect`) has the full account of the bug
    /// this closes (a plain close of a tab with a STANDING, un-acted-on recovery candidate must
    /// leave that candidate's sidecar AND its manifest entry alone, so a later reopen finds it
    /// again) and why gating the manifest deletion too — not just the union — is required: the
    /// manifest is the ONLY thing `checkRecoveryCandidate` reads to find a sidecar's path at all: if
    /// this function deleted the manifest unconditionally while only conditionally deleting the
    /// FILE it points to, `.closeRequested` would still have silently ended the offer even with the
    /// union-sweep itself correctly suppressed. `false` callers (`.closeRequested` only) still clear
    /// their OWN literal `docId`'s sidecar unconditionally — cleaning up whatever THIS session may
    /// have autosaved is always correct; only reaching past it into a DIFFERENT docId's evidence is
    /// what `false` refuses.
    nonisolated static func clearAutosave(realPath: String, docId: String, autosaveDirectory: URL,
                                          alsoClearManifestOwner: Bool) {
        let manifestPath = Self.autosaveManifestPath(forRealPath: realPath, autosaveDirectory: autosaveDirectory)
        var docIdsToClear: Set<String> = [docId]
        if alsoClearManifestOwner,
           let data = try? Data(contentsOf: manifestPath),
           let entry = try? JSONDecoder().decode(OfficeAutosaveManifestEntry.self, from: data) {
            docIdsToClear.insert(entry.docId)
        }
        if let entries = try? FileManager.default.contentsOfDirectory(
            at: autosaveDirectory, includingPropertiesForKeys: nil) {
            for candidateDocId in docIdsToClear {
                let prefix = "\(candidateDocId)."
                for entry in entries where entry.lastPathComponent.hasPrefix(prefix) {
                    try? FileManager.default.removeItem(at: entry)
                }
            }
        }
        if alsoClearManifestOwner {
            try? FileManager.default.removeItem(at: manifestPath)
        }
    }

    /// **The boot-hygiene sweep's autosave-specific half — MANIFEST-AWARE, never wholesale.**
    /// Unlike `LOKBridge.sweepStaleDocumentDirectories` (which wipes `docs/`/`saves/` unconditionally
    /// at every helper boot, correct for those two — see that method's own header for why `autosave/`
    /// is EXCLUDED from it), this only ever removes a provably orphaned HALF of a pair:
    ///   * a sidecar file with no manifest pointing at it (a manifest write that never landed, or
    ///     already lost its own race against a crash);
    ///   * a manifest with no matching sidecar file (the sidecar was already cleared, but this
    ///     manifest write raced ahead of — or lost — its own delete);
    ///   * a temp file (`.tmp-*`, `saveAsSidecarOnDedicatedThread`'s own rename-source name) left by
    ///     a SIGKILL landing mid-write, between the `saveAs` call and the `rename` that would have
    ///     made it real — dead by construction, nothing ever points at it;
    ///   * (the advisor's own refinement) a VALID pair whose sidecar is no newer than the real file
    ///     — the app crashed AFTER a clean save/close should have cleared this pair (or the real
    ///     file was independently touched/saved after the crash), so there is genuinely nothing left
    ///     to recover; `checkRecoveryCandidate` would refuse this pair anyway (not `isNewer`), so
    ///     leaving it on disk costs nothing but a few bytes forever — cheap enough to sweep, not
    ///     load-bearing enough to skip if this check is ever wrong.
    /// A live pair — matching manifest and sidecar, sidecar genuinely newer — is NEVER touched here.
    /// Called once per `.helperBecameReady` (`OfficeRuntime.handle(supervisorEvent:)`'s own `.ready`
    /// case), off `@MainActor`, best-effort, redundant-but-harmless across multiple sessions sharing
    /// one helper (the same tolerance this file already extends to `ensureHelperReady`'s own
    /// late-joiner fold).
    nonisolated static func sweepAutosaveOrphans(autosaveDirectory: URL) {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: autosaveDirectory, includingPropertiesForKeys: nil) else { return }

        var manifests: [(url: URL, entry: OfficeAutosaveManifestEntry)] = []
        var sidecarsByDocId: [String: URL] = [:]
        for entry in entries {
            let name = entry.lastPathComponent
            if name.hasPrefix(".tmp-") {
                try? FileManager.default.removeItem(at: entry) // dead by construction — see header
            } else if name.hasSuffix(".manifest.json") {
                if let data = try? Data(contentsOf: entry),
                   let decoded = try? JSONDecoder().decode(OfficeAutosaveManifestEntry.self, from: data) {
                    manifests.append((entry, decoded))
                } else {
                    try? FileManager.default.removeItem(at: entry) // unreadable/corrupt — orphan
                }
            } else if let dotIndex = name.firstIndex(of: ".") {
                sidecarsByDocId[String(name[name.startIndex..<dotIndex])] = entry
            }
        }

        let manifestDocIds = Set(manifests.map(\.entry.docId))
        for (docId, sidecar) in sidecarsByDocId where !manifestDocIds.contains(docId) {
            try? FileManager.default.removeItem(at: sidecar)
        }

        for (manifestURL, entry) in manifests {
            guard let sidecar = sidecarsByDocId[entry.docId], let sidecarStat = officeFileStat(atPath: sidecar.path) else {
                try? FileManager.default.removeItem(at: manifestURL) // no matching sidecar — orphan
                continue
            }
            if let realStat = officeFileStat(atPath: entry.realPath), Self.statIsNewer(sidecarStat, than: realStat) {
                continue // a live, recoverable pair — untouched
            }
            // Either the real path is gone entirely (nothing to compare against — conservatively
            // swept rather than kept forever) or the sidecar is no newer than it (a resolved pair
            // that was never cleared, or the real file moved on since) — see this method's own
            // header for why dropping the WHOLE pair here is safe either way.
            try? FileManager.default.removeItem(at: manifestURL)
            try? FileManager.default.removeItem(at: sidecar)
        }
    }

    private func performTeardown(docIds: [String]) {
        generation += 1
        for docId in docIds {
            // Task 6: same store hygiene as the single-document close path — see
            // `OfficeTileStore.evictAll`'s own header.
            tileStore.evictAll(docId: docId)
            cursorStore.evict(docId: docId)
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

    /// **Office Stage B Task 9 — LOK's raw `getError()`/exception text, mapped to a short,
    /// house-voice sentence: sentence case, no exclamation, actionable where possible.** Every
    /// entry here is a shape this task actually OBSERVED against the real vendored LOK
    /// (`OfficeHelperLiveTests.testSyntheticLegacyFixturesOpenAsTextAfterR3RecutXlsStillFailsCleanly`'s
    /// own legacy-format matrix — the `xls` leg specifically; the `doc`/`ppt` legs stopped erroring
    /// at Task 11, see that test's own header), never a guess at LOK's possible vocabulary — the Stage A concern
    /// this closes is specifically "LOK's raw getError strings surface verbatim in openFailures
    /// banners," not every error string this file can produce (see `describe(_:)`'s own header for
    /// where the line is drawn). Matched by case-insensitive substring, not exact equality: LOK's
    /// own strings often carry request-specific detail (a path, a docId) wrapped around a stable
    /// core phrase.
    private static let knownLOKErrorShapes: [(needle: String, sentence: String)] = [
        // Office Stage B Task 10 — the CFB release blocker's own refusal reason
        // (`LOKBridge.cfbUnderModernExtensionReason`, hand-mirrored across the module boundary the
        // same way every other needle in this table already is — see that constant's own header).
        // Placed FIRST: distinct from every other shape below by construction (contains none of
        // their needles as a substring), so ordering has no effect on which sentence a genuine CFB
        // refusal gets, but leading with the newest/most specific shape matches this table's own
        // house style of putting the legacy-format matrix's three entries in the order they were
        // discovered.
        ("refused before documentLoad: legacy OLE2/CFB binary content under a modern Office extension",
         "This file's contents don't match its extension — it looks like an older binary Office "
       + "format and can't be opened here."),
        // legacy-xls.xls's own observed failure — documentLoad returns NULL cleanly, no crash.
        ("loadComponentFromURL returned an empty reference",
         "This file couldn't be opened — it may be corrupted or in a format the office viewer doesn't support."),
        // legacy-doc.doc/legacy-ppt.ppt's own observed text — LOK's own generic UNO-framework
        // fallback string. In practice that specific pair kills the helper process outright before
        // a reply carrying this text can even arrive (a direct libc `exit()` deep in LO's own
        // import path — see that test's own header), but the string is LOK's documented fallback
        // for other internal failures too, so it is mapped defensively rather than assumed
        // unreachable from here.
        ("Unspecified Application Error", "The office viewer couldn't make sense of this file."),
        // LOKBridge.openOnDedicatedThread's own fallback when getError() itself returns nothing.
        ("documentLoad failed", "This file couldn't be opened by the office viewer."),
    ]

    /// The mapping itself — a known shape's sentence, or a generic, honest fallback that never
    /// repeats the raw text. `rawReason` is ALWAYS logged verbatim by this function's one caller
    /// (`describe(_:)`, immediately below) before this ever runs; this function's return value is
    /// the only thing that ever reaches an OPEN-failure banner.
    ///
    /// **Fix round 1 (review F1) — `.saveFailed` has its OWN sibling below
    /// (`houseErrorSentenceForSaveFailure`), sharing this table's KNOWN-shape half but not its
    /// UNKNOWN-shape fallback.** An unrecognized OPEN reason is a fact about a document nobody could
    /// open at all — there is no better fallback than the generic sentence. An unrecognized SAVE
    /// reason is different: a pinned, pre-existing test requires it to reach the caller verbatim
    /// (`describe(_:)`'s own header has the full account), so the miss behavior cannot be shared
    /// here even though the hit table can.
    private static func houseErrorSentence(forRawReason rawReason: String) -> String {
        for shape in knownLOKErrorShapes where rawReason.localizedCaseInsensitiveContains(shape.needle) {
            return shape.sentence
        }
        return "This document couldn't be processed. See the log for details."
    }

    /// **Fix round 1 (review F1) — `.saveFailed`'s own mapping: known shapes still map to house
    /// voice; an UNRECOGNIZED reason returns the raw text VERBATIM instead of `houseErrorSentence`'s
    /// generic fallback.** Required, not a style choice: a pinned, pre-existing test
    /// (`testSaveAndAwaitOutcomeReturnsFailedWhenTheDriversSaveThrows`, `describe(_:)`'s own header
    /// has the full account) asserts the driver's raw save reason (`"disk full"` in that test's own
    /// fixture) reaches BOTH `saveAndAwaitOutcome`'s outcome and the banner verbatim — `"disk full"`
    /// matches no known LOK shape, so it falls through unchanged here, satisfying that contract,
    /// while a GENUINE raw LOK `getError()` string still gets mapped. That genuine case is real, not
    /// hypothetical — `LOKBridge.saveAsOnDedicatedThread`'s own `guard succeeded else { ... throw
    /// SaveError.saveAsFailed(reason) }` reads `kit.getError()` directly and wraps it with zero
    /// transformation (`SaveError.saveAsFailed(let reason): return reason`, its own `.description`)
    /// — unlike every OTHER `SaveError` case (`.unsupportedFormat`/`.docNotOpen`/...), which are this
    /// app's own hand-authored wire/save-layer text, `.saveAsFailed` alone is a direct LOK passthrough.
    private static func houseErrorSentenceForSaveFailure(rawReason: String) -> String {
        for shape in knownLOKErrorShapes where rawReason.localizedCaseInsensitiveContains(shape.needle) {
            return shape.sentence
        }
        return rawReason
    }

    /// PURE: classifies an `OfficeHelperClient` failure into the short sentence
    /// `.openFailed`/`.emitBanner` show.
    ///
    /// **`.openFailed(reason:)` carries LOK's own raw `getError()` text** — mapped through
    /// `houseErrorSentence` rather than surfaced verbatim (`knownLOKErrorShapes`'s own header has
    /// the full account). The raw string is logged here, unconditionally, so nothing is lost for
    /// debugging — only the MAPPED sentence is ever RETURNED, and therefore the only thing that
    /// ever reaches `openFailures`/a banner for an open failure.
    ///
    /// **Fix round 1 (review F1) — `.saveFailed(reason:)` ALSO carries LOK's own raw `getError()`
    /// text, sometimes, and the ORIGINAL version of this comment claiming it "is not LOK's raw C-API
    /// string" was empirically false.** `LOKBridge.saveAsOnDedicatedThread`'s own failure path reads
    /// `kit.getError()` directly into `SaveError.saveAsFailed(reason)`, whose `.description` is that
    /// string with ZERO wrapping — traced end to end, wire reply through `OfficeHelperClientError
    /// .saveFailed(reason:)`, to a real banner. The ORIGINAL fix (narrowing the mapped switch arm to
    /// `.openFailed` alone) restored the pinned `"disk full"` contract but did so by making `.saveFailed`
    /// carry raw LOK text UNLOGGED into a banner — exactly backwards from "raw preserved in log only,
    /// never banner." The ACTUAL fix, below: `.saveFailed` is now ALSO logged and ALSO mapped, through
    /// its own sibling helper (`houseErrorSentenceForSaveFailure`'s own header has the full account)
    /// that maps known shapes but returns an unrecognized reason verbatim rather than falling to the
    /// generic sentence — satisfying the pinned contract (`"disk full"` matches no shape) AND the "raw
    /// only in logs" constraint (a genuine LOK string now gets mapped, and is logged either way).
    ///
    /// **Everything else (a timeout, a protocol-level refusal, an unexpected reply shape) is not
    /// LOK text at all** — `OfficeHelperClientError` already carries this app's own hand-authored
    /// wording for those cases, so `.description` passes through unchanged.
    ///
    /// **Office Stage B Task 9 — the NSError fix, found while building the mapping above.** Every
    /// OTHER error this file's own throw sites produce (`stageDocument`'s Cocoa file-system errors,
    /// `placeAtomically`'s `NSPOSIXErrorDomain` one) is a genuine `NSError`, and `NSError`
    /// unconditionally conforms to `CustomStringConvertible` (confirmed empirically — Swift bridges
    /// it whether or not the concrete type ever intended that) — but its `.description` is the
    /// full "Error Domain=... Code=... UserInfo={...}" DEBUG dump, never fit for a banner.
    /// `.localizedDescription` is the SAME Foundation machinery `NSAlert` and every other
    /// user-facing surface already trusts, and it is EXACTLY the hand-authored text these throw
    /// sites already craft (`placeAtomically`'s own `NSLocalizedDescriptionKey`, `FileManager`'s
    /// own Cocoa-domain messages, e.g. "The file "x.xlsx" couldn't be opened because there is no
    /// such file.") — the OLD blind `(error as? CustomStringConvertible)?.description` cast picked
    /// the WRONG one for every one of them, discarding that already-house-voice-adjacent text in
    /// favor of a technical dump nobody wrote for a user to read. `Error.localizedDescription` never
    /// throws and is defined for every `Error`, so this also replaces the old hardcoded
    /// `"the office helper request failed"` fallback — a truly unrecognized error type still gets a
    /// non-crashing, generic-but-real sentence from Foundation's own default bridging, not a
    /// hand-maintained string this function would otherwise need to keep guessing at.
    ///
    /// **Deliberately NOT extended to reword `OfficeHelperClientError`'s own `.description` wording
    /// for `.timedOut`/`.serverError`/`.unexpectedReply`** — considered, disclosed rather than done:
    /// that text is a SEPARATE, smaller polish (house-style casing/tone, not a "raw LOK text"
    /// problem this task's own brief names), and touching it risks an unreviewed side effect on
    /// whatever else in this codebase reads that same `.description` outside this one call site.
    private static func describe(_ error: Error) -> String {
        if let clientError = error as? OfficeHelperClientError {
            switch clientError {
            case .openFailed(let reason):
                NSLog("[OfficeRuntime] raw office error (mapped for the banner above): \(reason)")
                return houseErrorSentence(forRawReason: reason)
            case .saveFailed(let reason):
                // Fix round 1 (review F1) — logged unconditionally, exactly like `.openFailed`
                // above, regardless of whether the shape below is recognized: a genuine LOK
                // `getError()` string is mapped and therefore only visible here; an unrecognized
                // reason (e.g. the pinned test's own "disk full") is already visible in the banner
                // too, but logging it here as well costs nothing and keeps this branch symmetric
                // with `.openFailed`'s own unconditional log.
                NSLog("[OfficeRuntime] raw office save error (mapped below if a known LOK shape): \(reason)")
                return houseErrorSentenceForSaveFailure(rawReason: reason)
            default:
                return clientError.description
            }
        }
        return error.localizedDescription
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
