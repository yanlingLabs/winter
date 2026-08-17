import AppKit
import Foundation

// MARK: - What one save did

/// editor-product Task 8. Three answers, and the middle one carries a sentence a person can read:
/// every failure a save can have is either "the editor did not answer" or the file system's own
/// complaint, and both belong in front of the user rather than only in a log.
///
/// `.noModel` is deliberately NOT a failure. It is the answer for a path this editor does not hold
/// open at all — the ⌘S that arrives while the panel is showing a web tab, a save button pressed on
/// a tab whose runtime was released by a departure. Nothing went wrong; there was simply nothing to
/// save, and a red banner for that would be a lie.
enum SaveOutcome: Equatable {
    case saved
    case failed(String)
    case noModel
}

// MARK: - The save flow

/// **The ONE save path** — the pull, the timeout, the atomic write and the seq-anchored
/// acknowledgement — with all three triggers behind it (the app's ⌘S menu item, the code tab's save
/// button, and the page's own ⌘S arriving as `saveRequested`).
///
/// One per `EditorRuntime`, owned by it: the seq counter, the pull table and the coalescing table
/// are all per-editor facts, and a process-wide coordinator would have to key every one of them by
/// session for no gain.
///
/// ## The loop, and why each step is where it is
///
/// ```
///   hasModel?          → no  → .noModel                     (nothing to save; not a failure)
///   pullContent(seq)   → …   → contentResponse(seq) | 5 s   (silence IS a legal answer)
///   noteExpectedWrite  →                                    (T9's watcher consumes one per note)
///   write (tmp+rename) → throws → .failed(description)      (and the note is withdrawn)
///   markSaved(seq)     →                                    (the pull's OWN seq, never a fresh one)
/// ```
///
/// **The success signal is the `contentResponse` ARRIVING — never the CDP acknowledgement.** The
/// page catches its own JavaScript errors (`editor.js`'s `dispatch` wraps every arm in a
/// `try/catch`), so an `ok == true` from `Runtime.evaluate` says only that the expression ran, not
/// that the page did the thing. Which is also why the timeout is not belt-and-braces but the only
/// failure detector this flow has: a pull may legally go unanswered — an unknown path is deliberate
/// silence, `getValue()` throws on a model past Monaco's heap ceiling, and a reply over 8 MiB is
/// refused by the decoder on this side, all three indistinguishable from a page that simply never
/// spoke (`EditorBridgeOutbound.pullContent`'s own doc states this as the contract).
///
/// **Nothing here clears a dirty dot.** The dot follows the page's `modelDirtyChanged` and nothing
/// else; `markSaved` makes the page recompute and say so. An optimistic Swift-side clear would be
/// wrong precisely when it matters — a buffer the user typed into while Swift was writing is still
/// dirty, and only the page can know that (`EditorBridgeOutbound.markSaved`'s seq anchor).
@MainActor
final class EditorSaveCoordinator {

    /// **Everything this object does to the world**, injected — the same posture
    /// `EditorRuntime.CEFDriver` takes toward CEF and for a sharper reason: the whole save flow is
    /// unreachable under XCTest otherwise (it speaks to a Chromium page and writes to disk), and the
    /// ordering claims below are exactly the kind that are wrong silently.
    /// Every member is `@MainActor` because every one of them is called from this object, which is
    /// — the same reading `EditorRuntime.CEFDriver` applies to the two members of ITS seam that
    /// touch actor-isolated state.
    struct Editor {
        /// Does the page hold a model for this path? The `.noModel` gate.
        var hasModel: @MainActor (String) -> Bool
        /// Send `pullContent {path, seq}`.
        var pull: @MainActor (String, UInt64) -> Void
        /// Send `markSaved {path, seq}` — the pull's own seq.
        var markSaved: @MainActor (String, UInt64) -> Void
        /// Announce a write this runtime is about to make, BEFORE it makes it (T9's seam).
        var noteExpectedWrite: @MainActor (String) -> Void
        /// Take an announcement back — the write threw, so no file-system event will ever arrive to
        /// consume it, and a note nobody consumes would swallow the NEXT external change.
        var withdrawExpectedWrite: @MainActor (String) -> Void
        /// Put `text` at `path`, atomically. `async` because it runs off the main actor in
        /// production: a save must not stall the shell on a slow or network volume, exactly as
        /// `EditorRuntime.openAndSend`'s read does not.
        var write: @MainActor (String, String) async throws -> Void
    }

    /// How long a pull may go unanswered before the save is failed. The figure the Stage-A harness
    /// bounded a healthy round trip at (`1.bound`, measured at 234 ms for the whole page boot), and
    /// the one `EditorBridgeOutbound.pullContent` names as a reasonable starting point.
    static let pullTimeout: TimeInterval = 5

    /// What the user is told when the pull times out. **Not the mechanism** ("no contentResponse for
    /// seq 3"): the three causes are indistinguishable from here, and the one true thing that can be
    /// said is that the editor did not answer.
    static let pullTimeoutMessage = "Couldn't save — the editor didn't answer"

    private let sessionId: String
    private let editor: Editor
    private let scheduler: BrowserRuntime.Scheduler

    /// The seq counter — monotonic, per runtime, never reused. The page compares it with `===`
    /// against the pull it remembered, so what matters is only that a later pull never carries an
    /// earlier number.
    private var lastSeq: UInt64 = 0

    /// Pulls awaiting an answer, keyed by seq. Ordinarily holds at most one entry: a save waits for
    /// its own pull, and a second save for the same path coalesces onto the first. A SECOND path's
    /// save may legitimately run beside it, which is why this is a table and not one slot.
    private var waiters: [UInt64: Waiter] = [:]

    /// Saves in flight, keyed by path — the coalescing table. See `save(path:)`.
    private var inFlight: [String: Task<SaveOutcome, Never>] = [:]

    private struct Waiter {
        let path: String
        let continuation: CheckedContinuation<String?, Never>
        var timer: BrowserRuntime.Scheduler.Cancellable?
    }

    init(sessionId: String,
         editor: Editor,
         scheduler: BrowserRuntime.Scheduler = .production) {
        self.sessionId = sessionId
        self.editor = editor
        self.scheduler = scheduler
    }

    // MARK: The door

    /// Save one file.
    ///
    /// **A second trigger for the same path while one save is in flight AWAITS THAT SAVE** rather
    /// than starting a second one, and gets its outcome. Chosen over "no-op with a reason" because
    /// every caller here is a user gesture: ⌘S pressed twice, or ⌘S while the button is being
    /// clicked, must not mint a second pull whose only effect is to SUPERSEDE the first — the page
    /// remembers one pull per model (`editor.js`'s `lastPull`), so the second pull would make the
    /// first save's `markSaved` fail closed and the dot would stay dirty after a save that
    /// genuinely wrote. Coalescing makes the double-press a no-op *and* still answers both callers
    /// honestly.
    ///
    /// Two DIFFERENT paths save concurrently, deliberately: they share nothing but the seq counter.
    func save(path: String) async -> SaveOutcome {
        if let existing = inFlight[path] { return await existing.value }
        let task = Task { @MainActor [weak self] () -> SaveOutcome in
            guard let self else { return .failed("the editor closed before the save could run") }
            // **Cleared inside the task body, as its last act** — not after the `await` below. A
            // finished save is not in flight, and an entry left standing until the awaiting caller
            // resumed would swallow a legitimate re-save that arrived in between.
            defer { self.inFlight[path] = nil }
            return await self.performSave(path: path)
        }
        inFlight[path] = task
        return await task.value
    }

    /// The page answered a pull. Called by `EditorRuntime.receive` for every `contentResponse`,
    /// whether this object asked for one or not.
    ///
    /// **Correlated by seq, and the path is checked rather than trusted.** An answer whose seq is
    /// not outstanding is a late reply to a superseded pull (or a reply to a pull that already timed
    /// out) — it is dropped, with a line, because acting on it would write bytes whose save has
    /// already been reported one way or the other.
    func deliverContentResponse(path: String, seq: UInt64, text: String) {
        guard let waiter = waiters[seq] else {
            NSLog("[EditorSave] \(sessionId): a contentResponse arrived for seq \(seq), which no "
                  + "save is waiting on — dropped (a superseded or timed-out pull)")
            return
        }
        guard waiter.path == path else {
            // The page echoes the pull's own path, so this cannot happen without the two sides
            // having drifted. Fail closed: writing another model's bytes to this file is the one
            // mistake this flow must never make.
            NSLog("[EditorSave] \(sessionId): a contentResponse for seq \(seq) named \(path); the "
                  + "pull was for \(waiter.path) — dropped")
            return
        }
        finish(seq: seq, text: text)
    }

    // MARK: The flow

    private func performSave(path: String) async -> SaveOutcome {
        guard editor.hasModel(path) else { return .noModel }

        let seq = nextSeq()
        guard let text = await pull(path: path, seq: seq) else {
            NSLog("[EditorSave] \(sessionId): pull \(seq) for \(path) went unanswered for "
                  + "\(Self.pullTimeout)s — the save was NOT made")
            return .failed(Self.pullTimeoutMessage)
        }

        // **Before the write, always.** T9's watcher sees the rename this save is about to make and
        // must not mistake it for somebody else's edit; a note filed afterwards would race the
        // file-system event it exists to explain.
        editor.noteExpectedWrite(path)
        do {
            try await editor.write(path, text)
        } catch {
            // No event will arrive to consume the note now — the rename never happened.
            editor.withdrawExpectedWrite(path)
            NSLog("[EditorSave] \(sessionId): writing \(path) failed: \(error)")
            return .failed((error as NSError).localizedDescription)
        }

        // **The pull's OWN seq.** A fresh number would fail closed at the page (it warns and clears
        // nothing), and a path-only acknowledgement would clear the dot against a buffer the user
        // may have typed into while the write was happening.
        editor.markSaved(path, seq)
        return .saved
    }

    /// Ask, and wait for the answer or for the clock, whichever comes first.
    private func pull(path: String, seq: UInt64) async -> String? {
        return await withCheckedContinuation { continuation in
            // Registered BEFORE the ask: a test double (and, in principle, any synchronous
            // transport) may answer inside `pull`, and an answer that found no waiter would be
            // dropped as "superseded" and the save would then wait out its whole timeout.
            waiters[seq] = Waiter(path: path, continuation: continuation)
            editor.pull(path, seq)
            // Already answered synchronously — nothing left to time out.
            guard waiters[seq] != nil else { return }
            let timer = scheduler.timer(scheduler.now().addingTimeInterval(Self.pullTimeout)) {
                [weak self] in
                self?.finish(seq: seq, text: nil)
            }
            waiters[seq]?.timer = timer
        }
    }

    /// Resume a waiter exactly once: removed from the table FIRST, so a timer that fires beside a
    /// late answer finds nothing and does nothing.
    private func finish(seq: UInt64, text: String?) {
        guard let waiter = waiters.removeValue(forKey: seq) else { return }
        waiter.timer?.cancel()
        waiter.continuation.resume(returning: text)
    }

    private func nextSeq() -> UInt64 {
        lastSeq += 1
        return lastSeq
    }

    // MARK: Test seams

    /// The last seq minted. Read by the tests that pin monotonicity and by nothing else.
    var lastMintedSeq: UInt64 { lastSeq }
    /// Pulls still waiting for an answer.
    var pendingPullSeqs: [UInt64] { waiters.keys.sorted() }
    /// Paths with a save in flight.
    var savesInFlight: [String] { inFlight.keys.sorted() }

    // MARK: The write

    /// **tmp + rename, in the SAME directory** — the spec's "atomic writes", performed rather than
    /// delegated to `Data.write(options: .atomic)` so that what happens is readable here and
    /// testable from outside: the destination either holds the whole new file or the whole old one,
    /// and no temporary file is left behind on ANY path, including the failing ones.
    ///
    /// Same directory because `rename(2)` is only atomic within one file system, and a temporary
    /// file elsewhere (`$TMPDIR`) can land on another volume — where the rename fails outright with
    /// `EXDEV`, or where a fallback copy would stop being atomic.
    ///
    /// The original's POSIX permissions are carried over when there is an original: a save must not
    /// silently turn an executable script into a plain file, and a fresh temporary file is born with
    /// the process's umask rather than the file's own mode.
    ///
    /// **`withBOM` puts back the three bytes the READ swallowed** (fix round 1). Foundation's UTF-8
    /// decoder strips a leading `EF BB BF` and says nothing, so the page never receives one and
    /// `getValue()` can never return one — without this, a plain ⌘S on an untouched, Visual-Studio-
    /// authored file would rewrite it three bytes shorter, silently. Which files have one is
    /// `EditorRuntime.pathsWithBOM`'s memory, recorded at the only place the bytes ever exist.
    ///
    /// **What tmp+rename costs, stated rather than left silent:** `rename(2)` REPLACES the
    /// destination name. A path that is a symlink is replaced by a regular file (the link is consumed,
    /// not followed), and any hard link to the old inode keeps the OLD contents. That is the standard
    /// atomic-save trade — every editor that writes this way makes it — and it is the price of a
    /// destination that can never be caught holding half a file.
    ///
    /// `nonisolated` because it is the one thing here that must NOT run on the main actor: the
    /// production seam calls it from a detached task so a save never stalls the shell.
    nonisolated static func writeAtomically(_ text: String, to path: String,
                                            withBOM: Bool = false) throws {
        let url = URL(fileURLWithPath: path)
        let directory = url.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(
            ".\(url.lastPathComponent).norma-save-\(UUID().uuidString)")
        var data = Data()
        // Never a SECOND BOM: a buffer that already begins with U+FEFF — a file that carried two, or
        // a user who typed one — keeps exactly the one it has.
        if withBOM && text.unicodeScalars.first != "\u{FEFF}" {
            data.append(contentsOf: EditorFileContents.utf8BOM)
        }
        data.append(contentsOf: text.utf8)
        do {
            try data.write(to: temporary)
            // **Flushed before the rename.** Without it the rename can reach the disk before the
            // bytes do, and a power loss leaves the destination NAME pointing at a file whose
            // contents were never written — the one outcome tmp+rename exists to prevent. Best
            // effort (`try?`): a file system that cannot fsync must not fail a save that otherwise
            // succeeded.
            if let handle = try? FileHandle(forWritingTo: temporary) {
                try? handle.synchronize()
                try? handle.close()
            }
            if let mode = (try? FileManager.default.attributesOfItem(atPath: path))?[.posixPermissions] {
                try? FileManager.default.setAttributes([.posixPermissions: mode],
                                                       ofItemAtPath: temporary.path)
            }
            guard rename(temporary.path, path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [
                    NSLocalizedDescriptionKey:
                        "The file couldn't be replaced: \(String(cString: strerror(errno)))."
                ])
            }
        } catch {
            // Never leave a `.norma-save-…` beside the user's file, whatever went wrong.
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}

// MARK: - The app's ⌘S

/// **The third trigger** (editor-product Task 8): a real main-menu item, because the other two doors
/// are unreachable from where the user often is. The page's own ⌘S needs focus inside Monaco, and
/// the tab's save button needs the panel open with the chrome row on screen; a ⌘S pressed while the
/// composer has focus must still save the file the panel is showing.
///
/// **It resolves through closures rather than holding the shell.** Both are asked afresh at the
/// moment the menu is used — at validation time (may this item be enabled?) and again at fire time
/// (what is the active code tab NOW?) — so nothing here can hold a stale tab, a departed session's
/// runtime, or a retired tab model. That is the same "re-ask, never remember" rule
/// `PanelEditorTabModel` follows toward its own host, and it is what makes this object testable with
/// no shell at all.
@MainActor
final class EditorSaveMenuCommand: NSObject, NSMenuItemValidation {

    /// The title the item carries. "Save" rather than "Save File" — it sits in the File menu, and
    /// this is the name every Mac app gives it.
    static let title = "Save"
    /// The menu the item goes in, created if the app's menu has none.
    static let fileMenuTitle = "File"

    /// The active code tab's absolute path, or `nil` when the front tab is not a file. Called at
    /// validation AND at fire time.
    private let activePath: () -> String?
    /// Save that path. Fire-and-forget from the menu's point of view — the outcome is surfaced by
    /// the save flow itself, not by the menu item.
    private let performSave: (String) -> Void

    init(activePath: @escaping () -> String?, performSave: @escaping (String) -> Void) {
        self.activePath = activePath
        self.performSave = performSave
    }

    /// The item itself. `⌘S` with no extra modifiers — the system shortcut for exactly this.
    func makeMenuItem() -> NSMenuItem {
        let item = NSMenuItem(title: Self.title, action: #selector(save(_:)), keyEquivalent: "s")
        item.keyEquivalentModifierMask = [.command]
        item.target = self
        return item
    }

    /// **Enabled only when there is a file to save.** Gated on the panel's active tab being a `.code`
    /// tab with a path — not on the panel being visible or focused: the panel's presentation is
    /// view-local `@State` with no channel back into the shell (`ShellSessionHost.onRevealPanel`'s
    /// own doc records that trap), and saving the front code tab while the panel happens to be
    /// collapsed is harmless.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        return activePath() != nil
    }

    @objc private func save(_ sender: Any?) {
        guard let path = activePath() else { return }
        performSave(path)
    }

    /// Put the item in `menu`'s File submenu, creating that submenu if the app has none.
    ///
    /// **Idempotent**: called again (a second summon, a menu SwiftUI rebuilt underneath us) it
    /// replaces its own item rather than adding a second ⌘S — two items with one key equivalent is
    /// a menu where the wrong one wins.
    ///
    /// `nil` is a legal argument and does nothing: an app with no main menu has nowhere to put this,
    /// and the other two triggers still work.
    func install(in menu: NSMenu?) {
        guard let menu else { return }
        let file: NSMenu
        if let existing = menu.items.first(where: { $0.submenu?.title == Self.fileMenuTitle
                                                    || $0.title == Self.fileMenuTitle })?.submenu {
            file = existing
        } else {
            let item = NSMenuItem(title: Self.fileMenuTitle, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: Self.fileMenuTitle)
            item.submenu = submenu
            // After the app menu (index 0) when there is one, so File lands where a Mac user looks
            // for it rather than at the end of the bar.
            menu.insertItem(item, at: min(1, menu.items.count))
            file = submenu
        }
        file.items
            .filter { ($0.target as? EditorSaveMenuCommand) === self }
            .forEach { file.removeItem($0) }
        file.addItem(makeMenuItem())
    }
}
