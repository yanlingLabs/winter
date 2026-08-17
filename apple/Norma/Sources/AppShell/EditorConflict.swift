import Foundation

// MARK: - editor-product Task 9: what a code tab says ABOVE the editor, and why

/// Why a file's banner is up and will not go away on its own.
///
/// Two kinds rather than one because the ACTIONS differ, which is the only reason a state ever
/// splits: a file whose bytes moved can be reloaded, and a file that is gone cannot be reloaded to
/// anything at all — offering "Reload" for it would be a button whose only possible outcome is a
/// second error.
enum EditorConflictKind: Equatable {
    /// The bytes on disk moved while this model held unsaved edits. Reload (discard mine) / Keep
    /// mine (dismiss; the next ⌘S overwrites).
    case changed
    /// The file is no longer there. The buffer is NOT hidden and NOT closed — see
    /// `editorConflictDeletedMessage` for the ruling.
    case deleted
}

/// **The banner state of ONE open file** — the whole of what T9 puts on screen, as a value.
///
/// Two sources feed it and they are deliberately different in kind:
///
///   * a **conflict** is a fact about the world that the user must answer (the file changed or
///     vanished under their unsaved edits); it persists until they answer it;
///   * a **transient error** is the outcome of something the user just did (a save that failed —
///     `SaveOutcome.failed`'s own sentence, produced by T8 and surfaced nowhere until now); it says
///     its piece and leaves after `editorTransientErrorDuration`.
///
/// **The precedence rule, stated once: a conflict WINS and a save failure yields.** A conflict is
/// actionable — there are two buttons and one of them is the fix — while a failed save is a report
/// about something that already happened, and the user can press ⌘S again. So `.saveFailed` over a
/// standing conflict changes nothing on screen (the outcome is still returned to its caller and
/// still logged by the save flow), and a conflict raised over a transient error replaces it
/// immediately rather than queueing behind a 5-second timer.
enum EditorTabBanner: Equatable {
    case none
    case conflict(EditorConflictKind)
    /// The sentence a failed save produced (`SaveOutcome.failed`), shown verbatim.
    case transientError(String)
}

/// Everything that can move a banner. Named after what HAPPENED, never after what is drawn — the
/// same discipline `EditorRuntimeEvent` keeps — so the reducer's tests read as claims about the
/// editor rather than about a row of pixels.
enum EditorBannerEvent: Equatable {
    /// The file's bytes changed outside the editor, and `dirty` is what the PAGE says about the
    /// model right now. Clean → the caller reloads silently and there is nothing to say; dirty →
    /// the user has to choose.
    case externalChange(dirty: Bool)
    /// The file is gone.
    case externalDeleted
    /// The banner's Reload.
    case reloadChosen
    /// The banner's Keep mine.
    case keepChosen
    /// A save failed, with its own sentence.
    case saveFailed(String)
    /// A save succeeded — which RESOLVES a conflict as surely as either button does: the file now
    /// holds this buffer, so "changed on disk" has stopped being true.
    case saveSucceeded
    /// The transient error's own timer expired. A separate event from `.dismissed` so it can only
    /// ever clear a transient error: a timer that fired beside a conflict raised in the meantime
    /// must not take the conflict down with it.
    case transientErrorExpired
    /// The user closed the banner (the × on a transient error).
    case dismissed
}

/// **The banner, as one pure function.** Every claim T9 makes about precedence — conflict wins, a
/// save failure yields, a successful save resolves a conflict, a timer clears only what armed it —
/// is a row of `EditorConflictTests` driving this directly, with no runtime, no watcher and no view.
enum EditorConflictReducer {

    static func reduce(_ state: EditorTabBanner, _ event: EditorBannerEvent) -> EditorTabBanner {
        switch event {

        case .externalChange(let dirty):
            // A dirty model has to be asked; a clean one is reloaded silently by the caller, and a
            // silent reload RESOLVES whatever this file's banner was saying (including a conflict
            // the user has not answered — the model went clean underneath it, so the choice the
            // banner offered no longer exists).
            guard dirty else { return clearingConflict(state) }
            return .conflict(.changed)

        case .externalDeleted:
            return .conflict(.deleted)

        case .reloadChosen, .keepChosen, .dismissed, .saveSucceeded:
            // All four are resolutions. `saveSucceeded` is in this list deliberately: pressing ⌘S
            // with a "changed on disk" banner up IS the "mine wins" answer, and the file now holds
            // exactly this buffer.
            return .none

        case .saveFailed(let message):
            // **The precedence rule.** A conflict is the more actionable truth and stays put; the
            // outcome still reaches the caller and the log either way.
            if case .conflict = state { return state }
            return .transientError(message)

        case .transientErrorExpired:
            guard case .transientError = state else { return state }
            return .none
        }
    }

    /// A conflict yields to a silent reload; anything else is left exactly as it is. Split out so
    /// the one place that has to make this distinction says why (above) rather than hiding a `case`
    /// inside a guard.
    private static func clearingConflict(_ state: EditorTabBanner) -> EditorTabBanner {
        if case .conflict = state { return .none }
        return state
    }
}

// MARK: - The copy, in one place

/// The spec's own wording — "Changed on disk — Reload / Keep mine" — with the em dash and the
/// buttons drawn as buttons rather than spelled into the sentence.
let editorConflictChangedMessage = "Changed on disk"

/// **The ruling for a file deleted underneath an open model, in one sentence the user can read.**
///
/// The buffer is neither hidden nor closed. T5's `openFailures` path exists for a file that could
/// never be opened, and reusing it here would replace the editor with "File not found" — hiding
/// unsaved work behind a sentence about a file, when that buffer is the only copy of it left.
/// (`EditorViewportState.openFailed` is still exactly right for its own case: nothing was ever
/// shown, so there is nothing to hide.) So a deletion says so in the banner, the text stays on
/// screen, and the next ⌘S writes the file back.
let editorConflictDeletedMessage = "Deleted on disk"

/// What the deletion banner adds under its sentence — the fact that makes it calm rather than
/// alarming.
let editorConflictDeletedDetail = "Saving will write it back."

let editorConflictReloadTitle = "Reload"
let editorConflictKeepTitle = "Keep mine"
let editorBannerDismissLabel = "Dismiss"

/// How long a save failure stays on screen. Long enough to read a sentence twice, short enough that
/// a stale complaint is never what the user is looking at — and it is a value here rather than a
/// literal at the timer because the reducer's tests and the runtime's timer must name the same one.
let editorTransientErrorDuration: TimeInterval = 5
