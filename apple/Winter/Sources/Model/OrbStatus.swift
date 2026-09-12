import Foundation

/// The orb's presentation states (spec §5 2b). `fieldOpen` arrives in 2c.
enum OrbStatus: Equatable {
    case idle
    case thinking
    case toolRunning(name: String)
    case approvalNeeded(count: Int)
    case disconnected

    /// Text for the orb's trailing pill when the orb is NOT mid-turn-working; nil = no pill.
    /// `.thinking`/`.toolRunning` deliberately return nil here (wave 6 gate item 1): while a turn
    /// is running, the pill shows the CC-style whimsical `workingVerb` instead — tool names are no
    /// longer surfaced in the collapsed status at all — and that composition needs
    /// `OrbSessionState`'s `workingVerb`/`hasActiveTask`/`taskCounts`, which this case-only enum
    /// doesn't carry. See `workingPillText(verb:hasActiveTask:done:total:)` below and
    /// `FieldStateAdapter.statusText`, which is the one place that combines the two. `.toolRunning`
    /// itself is UNCHANGED as a case — approval-gating logic (`SessionReducer`'s
    /// `pendingInteractions.isEmpty` checks) still needs it — only its pill TEXT moved.
    var pillText: String? {
        switch self {
        case .idle, .thinking, .toolRunning: return nil
        case .approvalNeeded(let n): return n == 1 ? "needs approval" : "needs approval (\(n))"
        case .disconnected: return "disconnected"
        }
    }
}

/// PURE composition for the collapsed-orb "working" verb text (wave 6 gate: CC-style whimsical verb,
/// randomly re-rolled once per turn by the store — see `SessionModel.apply` / `WorkingVerbs`,
/// NOT a static "thinking…"/tool name). Returns just the verb with ellipsis.
func workingVerbText(verb: String) -> String {
    return "\(verb)…"
}

/// PURE composition for the collapsed-orb task-count chip (gate polish: moves left of the orb).
/// Returns "☑ n/m" ONLY while `hasActiveTask` is true (wave-6 item 2) — n = index of the task
/// being worked (completed + 1, clamped to total), m = total; otherwise returns empty string.
func workingCountText(hasActiveTask: Bool, done: Int, total: Int) -> String {
    guard hasActiveTask else { return "" }
    return "☑ \(min(done + 1, total))/\(total)"
}

/// PURE composition for the collapsed-orb "working" pill (wave 6 gate: CC-style whimsical verb,
/// randomly re-rolled once per turn by the store — see `SessionModel.apply` / `WorkingVerbs`,
/// NOT a static "thinking…"/tool name). The "☑ n/m" task-count suffix appends ONLY while
/// `hasActiveTask` is true (wave-6 item 2) — n = index of the task being worked (completed + 1,
/// clamped to total), m = total; an idle-but-nonempty or fully-completed task list shows the bare
/// verb with no suffix at all.
/// NOTE: Kept for backwards compatibility with tests; new code should use `workingVerbText` +
/// `workingCountText` separately for split layout (gate polish).
func workingPillText(verb: String, hasActiveTask: Bool, done: Int, total: Int) -> String {
    let verbPart = workingVerbText(verb: verb)
    let countPart = workingCountText(hasActiveTask: hasActiveTask, done: done, total: total)
    return countPart.isEmpty ? verbPart : "\(verbPart) \(countPart)"
}
