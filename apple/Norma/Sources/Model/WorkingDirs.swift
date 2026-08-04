import Foundation
import NormaKit

/// working-directories T8: the PURE decisions behind the app's two working-directory surfaces — the
/// create-time picker sheet (`WorkingDirPickerSheet`) and the mid-session folders chip
/// (`WindowContentView.dirsMenuButton`). SwiftUI bodies and AppKit panels aren't unit-testable, so
/// every rule that could be wrong lives here where `WorkingDirsTests` drives it directly — the same
/// posture as `buildTaskSection`/`modelPickerOptions`/`effortPickerOptions`.
///
/// **The daemon remains the authority on every one of these rules.** `session.setDirs` owns the
/// refusal matrix (`packages/core/src/sessions/set-dirs.ts`), and each refusal comes back as its own
/// sentence which the surfaces show VERBATIM. What lives here is only which affordance to OFFER, so
/// the user isn't invited to click a button whose answer is already known — never a second
/// implementation of the matrix, and never a reason to swallow the daemon's answer.

// MARK: - Recents (the create sheet's "Recent" section)

/// How many recent projects the create sheet lists. Presentational only — the sheet scrolls, so this
/// is about a picker staying scannable, not about correctness.
let maxRecentWorkingDirs = 8

/// The create sheet's "Recent" list: DISTINCT LOCKED PRIMARIES across session history, newest first.
///
/// Three deliberate choices:
///   * **Primaries only** (`dirs.first`) — a secondary is a directory some session was additionally
///     granted, not the project it was working in. `dirs[0]` is the primary BY POSITION.
///   * **Locked only** — the first-write lock means Norma actually WROTE there. An unlocked primary
///     is a folder that was picked and then never worked in; offering it as a "recent project" would
///     let one mistaken pick propagate itself forward through every future sheet.
///   * **Client-side, off `session.list`** — no new RPC (design doc §2: "the picker's data all rides
///     session.list"). `SessionDirectory.rows` is already loaded for the sidebar.
///
/// Rows whose `dirs` is `nil` (chat/dispatch — no working-directory concept at all) contribute
/// nothing, which falls out of `first` being nil rather than needing a mode check of its own.
///
/// Sorted here rather than trusting the caller's order, with `sessionId` as an explicit tiebreak:
/// Swift's `sorted(by:)` is not stable, and two sessions can share a `createdAt` millisecond — an
/// order that flips between two renders of the same list would move the preselected default under
/// the user's cursor.
func recentWorkingDirs(_ rows: [SessionSummary], limit: Int = maxRecentWorkingDirs) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    let newestFirst = rows.sorted {
        $0.createdAt == $1.createdAt ? $0.sessionId > $1.sessionId : $0.createdAt > $1.createdAt
    }
    for row in newestFirst {
        guard let primary = row.dirs?.first, primary.locked else { continue }
        guard seen.insert(primary.path).inserted else { continue }
        out.append(primary.path)
        if out.count >= limit { break }
    }
    return out
}

// MARK: - The create sheet's choice

/// What a create-time picker resolves to. Two cases, not `String?`, because "no folder" is a
/// DELIBERATE, spec'd outcome (design doc §1: the session runs workdir-less, writable only in
/// `$OUTDIR`/`$TMPDIR`/`$MEMDIR`) rather than the absence of an answer — and because `nil` is what
/// this maps ONTO at the wire (`session.create`'s optional `cwd`), so keeping both as `String?`
/// through the UI is how "the user chose outputs-only" and "the picker hasn't decided yet" become
/// the same value.
enum WorkingDirChoice: Equatable {
    case folder(String)
    case noFolder

    /// `session.create`'s `cwd` param. `.noFolder` sends NO cwd at all — the daemon then writes
    /// `dirs = []` (T6), which is exactly the workdir-less state; it is never "cwd = home".
    var cwdParam: String? {
        switch self {
        case .folder(let path): return path
        case .noFolder: return nil
        }
    }
}

/// The sheet's PRESELECTED default — the most recent project, or "No folder (outputs only)" when
/// there are none (design doc §1: "no previous projects ⇒ the session runs workdir-less").
///
/// Load-bearing beyond a nicety: the spec's flow is "starting work without touching the picker keeps
/// the preselected default", so whatever this returns is what a user who just hits Return gets.
func initialWorkingDirChoice(recents: [String]) -> WorkingDirChoice {
    guard let newest = recents.first else { return .noFolder }
    return .folder(newest)
}

// MARK: - The mid-session chip

/// Whether the header's working-folders chip renders at all, decided by the DAEMON's own
/// participation gate rather than by a mode list mirrored over here: `session.list` populates `dirs`
/// only for rows that participate (code + cowork + absent-means-code, ipc/server.ts), so an absent
/// array IS the daemon saying "this session has no working-directory concept". A chat or dispatch
/// window therefore shows no chip, and it shows none because the daemon said so — not because this
/// file happens to hold the same allowlist today.
///
/// `[]` is the opposite answer and must show the chip: a workdir-less session is precisely the one
/// that needs the adopt door.
func dirsMenuIsVisible(_ dirs: [SessionDirEntry]?) -> Bool {
    dirs != nil
}

/// The chip's own label — the primary's leaf name, or the workdir-less wording. `nil` dirs never
/// reach here (`dirsMenuIsVisible` gates the whole chip), but the case is answered rather than
/// force-unwrapped.
func dirsChipLabel(_ dirs: [SessionDirEntry]?) -> String {
    guard let dirs, let primary = dirs.first else { return "No folder" }
    return workingDirDisplayName(primary.path)
}

/// A path's leaf name for a one-line row/chip ("Norma v2" for "/Users/x/Xcode progects/Norma v2"),
/// falling back to the full path when there is no leaf to take (`/`, or an empty string). The FULL
/// path is always still shown somewhere — the menu lists it under the leaf — so this only ever
/// shortens a label, never hides the identity of a directory being acted on.
func workingDirDisplayName(_ path: String) -> String {
    let leaf = (path as NSString).lastPathComponent
    return leaf.isEmpty || leaf == "/" ? path : leaf
}

/// Whether the menu offers "Remove" for the entry at `index`. Mirrors the two refusals `remove` has:
/// index 0 is the primary (a POSITION — the daemon points at `setPrimary` instead), and a locked
/// entry can never be removed for the session's lifetime.
func dirEntryIsRemovable(_ dirs: [SessionDirEntry], index: Int) -> Bool {
    guard dirs.indices.contains(index) else { return false }
    return index > 0 && !dirs[index].locked
}

/// Whether the menu offers "Change primary folder…". `setPrimary` refuses outright when `dirs[0]` is
/// locked; on an EMPTY set it is the door that ESTABLISHES the primary and exits workdir-less mode,
/// which is the one moment this affordance matters most.
func dirsPrimaryIsReplaceable(_ dirs: [SessionDirEntry]) -> Bool {
    guard let primary = dirs.first else { return true } // empty set: setPrimary establishes dirs[0]
    return !primary.locked
}

/// The confirm-alert text for a manual add/replace (the user's explicit ruling: a manual add is
/// SELECTION + CONFIRM, never a one-click widening). Names the op and the FULL path — the leaf name
/// alone would let two same-named folders in different trees read identically at the exact moment
/// the user is being asked to widen what Norma may write to.
///
/// (wd-m31): `.remove` is dead in practice — this function's only caller, `confirmWorkingDir`, is
/// only ever reached from `pickWorkingDir`, which the menu wires to `.setPrimary`/`.add` alone; the
/// per-row "Remove" action (`applyDirsOp`) calls `setDirs` directly, no panel, no confirm step. Given
/// its own correct wording anyway rather than reusing `.add`'s (which would misdescribe a remove),
/// so a future caller that DOES route `.remove` through this confirm path isn't handed a lie.
func workingDirConfirmMessage(op: SessionDirsOp, path: String) -> String {
    switch op {
    case .setPrimary:
        return "Make \(path) this session's primary working folder?"
    case .add:
        return "Add \(path) as a working folder for this session?"
    case .remove:
        return "Remove \(path) as a working folder for this session?"
    }
}

/// The confirm alert's own explanation line — what approving actually grants. Deliberately concrete
/// (Norma may WRITE there) rather than "allow access": the whole point of a working directory is the
/// write fence, and reads were never fenced at all.
let workingDirConfirmDetail = "Norma will be able to write inside it for the rest of this session."
