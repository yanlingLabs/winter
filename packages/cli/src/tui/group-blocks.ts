/** `groupBlocks` (Phase 3b Task 4) — PURE render-side transform that collapses consecutive
 *  read/search-shaped tool blocks into one CC-style summary line (binding reference:
 *  `.superpowers/sdd/cc-ui-study-transcript.md` §7, ADAPTED not copied — no minimum-count
 *  threshold, so a lone `read` still collapses; the run breaks on ANY non-collapsible block).
 *
 *  The reducer's flat `TuiState.committed: Block[]` (`state.ts`) is NEVER touched by this file —
 *  `groupBlocks` only maps that array to a `DisplayItem[]` for `transcript.tsx` to render. No
 *  React import, no state, no side effects: a plain fold over an array.
 *
 *  Committed tool blocks are always fully resolved (state.ts's `tool_result` case commits a tool
 *  call+result pair atomically) — so every summary here is worded in the PAST tense, unlike the
 *  live "N pattern(s)…" present-tense variant the study describes for an in-flight (unresolved)
 *  group; Winter has no such in-flight collapsed state today.
 *
 *  An ERRORED collapsible tool (`isError: true`) is deliberately excluded from `COLLAPSIBLE`
 *  membership (see `isCollapsible` below): folding it into a group would silently swallow the one
 *  piece of information (which call failed, with what output) a user most needs to see, so it
 *  breaks the run exactly like a non-collapsible tool or an assistant/user/note block would. */

import type { Block } from "./state";

export const COLLAPSIBLE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "task_list",
  "task_get",
]);

export type DisplayItem =
  | { kind: "block"; block: Block }
  | { kind: "collapsed"; blocks: Block[]; summary: string };

/** The four summary categories a collapsible tool name folds into (study §7's "<Verb> N ...,
 *  <verb> M ..." comma-joined format, adapted to Winter's own tool names/set). */
type Category = "read" | "search" | "list" | "tasks";

const CATEGORY_BY_TOOL: Readonly<Record<string, Category>> = {
  read: "read",
  grep: "search",
  glob: "search",
  ls: "list",
  task_list: "tasks",
  task_get: "tasks",
};

function isCollapsible(block: Block): boolean {
  return block.kind === "tool" && COLLAPSIBLE_TOOLS.has(block.name) && block.isError !== true;
}

/** One category's past-tense phrase at count `n` — exact singular/plural per the brief's (g). */
function phrase(category: Category, n: number): string {
  switch (category) {
    case "read":
      return `Read ${n} file${n === 1 ? "" : "s"}`;
    case "search":
      return `Searched ${n} pattern${n === 1 ? "" : "s"}`;
    case "list":
      return `Listed ${n} path${n === 1 ? "" : "s"}`;
    case "tasks":
      return "Checked tasks"; // no count — brief specifies this wording verbatim, unconditionally
  }
}

/** Comma-joins each category present in `run`, ordered by FIRST appearance; only the first
 *  category keeps its as-written capital, every later one gets its leading letter lowercased
 *  (e.g. "Read 2 files, searched 1 pattern"). */
function summarize(run: Block[]): string {
  const order: Category[] = [];
  const counts = new Map<Category, number>();
  for (const block of run) {
    if (block.kind !== "tool") continue;
    const category = CATEGORY_BY_TOOL[block.name];
    if (!category) continue;
    if (!counts.has(category)) order.push(category);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return order
    .map((category, i) => {
      const text = phrase(category, counts.get(category) ?? 0);
      return i === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
    })
    .join(", ");
}

export function groupBlocks(blocks: Block[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let run: Block[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    result.push({ kind: "collapsed", blocks: run, summary: summarize(run) });
    run = [];
  };

  for (const block of blocks) {
    if (isCollapsible(block)) {
      run.push(block);
    } else {
      flushRun();
      result.push({ kind: "block", block });
    }
  }
  flushRun();

  return result;
}
