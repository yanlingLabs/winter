/** Shared pure task-display logic (Phase 2e-i) — the Claude-Code-tree rendering rules, written
 *  ONCE here and mirrored byte-for-byte in `apple/Winter/Sources/ChatContent/TaskDisplay.swift`.
 *  Task 3 (window) and Task 4 (CLI) each consume this; nothing renders here. Every function is
 *  pure — no I/O, no ANSI, no SwiftUI — so both sides can be unit-tested against the SAME
 *  fixtures (see `test/task-display.test.ts` / `TaskDisplayTests.swift`) and stay in lockstep. */

export interface TaskRow {
  id: string;
  subject: string;
  status: string;
  activeForm?: string;
  startedTs?: number;
}

export interface TaskDisplayResult {
  rows: TaskRow[];
  collapsedCompletedCount: number;
}

/** Sort rank per status: in_progress first, pending (and any unrecognized status) next,
 *  completed last. A plain `Array.prototype.sort` by rank alone is NOT guaranteed stable across
 *  engines by spec pre-ES2019, but more importantly the Swift twin can't rely on it either — so
 *  both sides sort by `(rank, originalIndex)`, which is stable by construction. */
function rankFor(status: string): number {
  if (status === "in_progress") return 0;
  if (status === "completed") return 2;
  return 1;
}

export function sortTasksForDisplay(tasks: TaskRow[]): TaskRow[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const rankDiff = rankFor(a.task.status) - rankFor(b.task.status);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map(({ task }) => task);
}

/** `sorted` is assumed already in `sortTasksForDisplay` order. Keeps every non-completed row plus
 *  the first `showCompleted` completed rows (in that sorted order); the rest are collapsed into a
 *  count. */
export function collapseCompleted(sorted: TaskRow[], showCompleted: number = 3): TaskDisplayResult {
  const rows: TaskRow[] = [];
  let totalCompleted = 0;
  let keptCompleted = 0;
  for (const task of sorted) {
    if (task.status !== "completed") {
      rows.push(task);
      continue;
    }
    totalCompleted += 1;
    if (keptCompleted < showCompleted) {
      rows.push(task);
      keptCompleted += 1;
    }
  }
  return { rows, collapsedCompletedCount: Math.max(0, totalCompleted - showCompleted) };
}

/** "7 tasks (5 done, 1 in progress, 1 open)" — the CC count header. "open" = pending + any
 *  unrecognized status. Lockstep with TaskDisplay.swift's taskCountsLine. */
export function taskCountsLine(tasks: { status: string }[]): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const open = tasks.length - done - inProgress;
  return `${tasks.length} tasks (${done} done, ${inProgress} in progress, ${open} open)`;
}

export function taskGlyph(status: string): string {
  if (status === "in_progress") return "■";
  if (status === "completed") return "✓";
  return "☐";
}

/** ms → "14s" / "2m 3s" / "1h 4m". Matches `TaskDisplay.swift`'s `formatElapsed` exactly on the
 *  shared fixtures (14000→"14s", 123000→"2m 3s", 3840000→"1h 4m"). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/** n<1000 → integer string ("842"); else one decimal + k/M ("10.6k", "1.2M"). Matches
 *  `TaskDisplay.swift`'s `String(format: "%.1f", Double(n)/1000)` — both always keep exactly one
 *  decimal digit above the 1000 threshold (never strip a trailing ".0"). */
export function formatTokens(n: number): string {
  // Task-1 review fix: one-decimal via INTEGER round-half-up, NOT toFixed/%.1f — those diverge at
  // exact binary ties (n mod 1000 == 250 → toFixed gives 1.3k, Swift %.1f round-half-to-even gives
  // 1.2k), breaking TS↔Swift lockstep on ordinary token counts. `Math.floor((x + half) / step)` is
  // identical to Swift's integer `(x + half) / step`.
  const oneDecimal = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${oneDecimal(Math.floor((n + 50) / 100))}k`;
  return `${oneDecimal(Math.floor((n + 50_000) / 100_000))}M`;
}
