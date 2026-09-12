import Foundation

/// Shared pure task-display logic (Phase 2e-i) — the Claude-Code-tree rendering rules, written
/// ONCE here and mirrored byte-for-byte in `packages/cli/src/task-display.ts`. Task 3 (window)
/// and Task 4 (CLI) each consume this; nothing renders here. Every function is pure — no I/O, no
/// SwiftUI — so both sides can be unit-tested against the SAME fixtures (see
/// `TaskDisplayTests.swift` / `test/task-display.test.ts`) and stay in lockstep.

struct TaskRow: Equatable {
    let id: String
    let subject: String
    let status: String
    let activeForm: String?
    let startedTs: Int?
}

struct TaskDisplayResult: Equatable {
    let rows: [TaskRow]
    let collapsedCompletedCount: Int
}

/// Sort rank per status: in_progress first, pending (and any unrecognized status) next,
/// completed last.
private func rank(for status: String) -> Int {
    if status == "in_progress" { return 0 }
    if status == "completed" { return 2 }
    return 1
}

/// Swift's `sort`/`sorted` is NOT guaranteed stable, so ties (equal rank) sort by original index —
/// stable by construction, matching the TS twin's `(rank, originalIndex)` comparator.
func sortTasksForDisplay(_ tasks: [TaskRow]) -> [TaskRow] {
    tasks.enumerated()
        .sorted { a, b in
            let rankDiff = rank(for: a.element.status) - rank(for: b.element.status)
            if rankDiff != 0 { return rankDiff < 0 }
            return a.offset < b.offset
        }
        .map(\.element)
}

/// `sorted` is assumed already in `sortTasksForDisplay` order. Keeps every non-completed row plus
/// the first `showCompleted` completed rows (in that sorted order); the rest are collapsed into a
/// count.
func collapseCompleted(_ sorted: [TaskRow], showCompleted: Int = 3) -> TaskDisplayResult {
    var rows: [TaskRow] = []
    var totalCompleted = 0
    var keptCompleted = 0
    for task in sorted {
        if task.status != "completed" {
            rows.append(task)
            continue
        }
        totalCompleted += 1
        if keptCompleted < showCompleted {
            rows.append(task)
            keptCompleted += 1
        }
    }
    return TaskDisplayResult(rows: rows, collapsedCompletedCount: max(0, totalCompleted - showCompleted))
}

/// "7 tasks (5 done, 1 in progress, 1 open)" — the CC count header. "open" = pending + any
/// unrecognized status. Lockstep with `task-display.ts`'s `taskCountsLine`.
func taskCountsLine(_ tasks: [TaskRow]) -> String {
    let done = tasks.filter { $0.status == "completed" }.count
    let inProgress = tasks.filter { $0.status == "in_progress" }.count
    let open = tasks.count - done - inProgress
    return "\(tasks.count) tasks (\(done) done, \(inProgress) in progress, \(open) open)"
}

func taskGlyph(_ status: String) -> String {
    if status == "in_progress" { return "■" }
    if status == "completed" { return "✓" }
    return "☐"
}

/// ms → "14s" / "2m 3s" / "1h 4m". Matches `task-display.ts`'s `formatElapsed` exactly on the
/// shared fixtures (14000→"14s", 123000→"2m 3s", 3840000→"1h 4m").
func formatElapsed(_ ms: Int) -> String {
    let totalSeconds = ms / 1000
    if totalSeconds < 60 { return "\(totalSeconds)s" }
    if totalSeconds < 3600 {
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return "\(minutes)m \(seconds)s"
    }
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    return "\(hours)h \(minutes)m"
}

/// n<1000 → integer string ("842"); else one decimal + k/M ("10.6k", "1.2M"). Matches
/// `task-display.ts`'s `(n / 1000).toFixed(1)` — both always keep exactly one decimal digit above
/// the 1000 threshold (never strip a trailing ".0").
func formatTokens(_ n: Int) -> String {
    // Task-1 review fix: one-decimal via INTEGER round-half-up, NOT %.1f/toFixed — those diverge
    // at exact binary ties (n mod 1000 == 250 → %.1f round-half-to-even gives 1.2k, toFixed gives
    // 1.3k), breaking Swift↔TS lockstep on ordinary token counts. `(x + half) / step` (integer
    // division) is identical in both languages. `oneDecimal` renders tenths as "<int>.<dec>".
    func oneDecimal(_ tenths: Int) -> String { "\(tenths / 10).\(tenths % 10)" }
    if n < 1000 { return String(n) }
    if n < 1_000_000 { return "\(oneDecimal((n + 50) / 100))k" }   // tenths of thousands, half-up
    return "\(oneDecimal((n + 50_000) / 100_000))M"                 // tenths of millions, half-up
}
