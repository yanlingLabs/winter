import { z } from "zod";
import type { ToolRegistry } from "./registry";

const WorkflowArgs = z.object({
  script: z.string().min(1),
  args: z.unknown().optional(),
  name: z.string().min(1).max(64).optional(),
  run_in_background: z.boolean().optional(),
});

const AUTHORING_GUIDE = [
  "Orchestrate many subagents from a single JavaScript script executed in an isolated background runtime — only the script's `return` value re-enters this conversation, so one run can coordinate dozens-to-hundreds of agents without flooding context.",
  "",
  "Script shape: `export const meta = { name, description };` then a top-level-await body that `return`s the result. Available in scope (NOTHING else — no fs, Bun, process, require, import, network, Date.now, Math.random, or argless `new Date()`; pass timestamps via `args`):",
  "- `await agent(prompt, opts?)` — spawn ONE subagent, resolves with its final report. opts: { label?, model?, schema? }. Agents run at accept-edits.",
  "- `await parallel([() => agent(...), ...])` — run thunks concurrently under the per-run cap; a thunk that throws resolves to null (never rejects the batch).",
  "- `await pipeline(items, ...stages)` — each item flows through all stages independently; a stage that throws drops that item to null.",
  "- `phase(title)` / `log(message)` — progress signals surfaced to the UI.",
  "- `args` — the value you passed in the tool call. `budget` — best-effort token-budget helpers.",
  "",
  "Caps: 16 concurrent agents, 1000 total per run, nesting depth 1 (a workflow's agents cannot launch workflows). Exceeding the total cap fails the run.",
  "Args: script (required), args (optional value handed to the run), name (optional — saves the script to ~/.norma/workflows/<name>.js on completion), run_in_background (default true — returns {runId,status:'running'} and notifies you on completion; false awaits inline).",
  "",
  "Worked pattern — fan out then synthesize:",
  "```js",
  "export const meta = { name: 'triage', description: 'Triage N files in parallel' };",
  "phase('scan');",
  "const files = args.files;",
  "const findings = await parallel(files.map((f) => () => agent(`Review ${f} and report issues`)));",
  "phase('synthesize');",
  "return await agent(`Summarize these findings into a report:\\n${findings.filter(Boolean).join('\\n')}`);",
  "```",
].join("\n");

/** Deferred, code-session-only (gating in engine.ts — Task B3). Placeholder run(): the engine's
 *  workflow bridge intercepts Workflow calls when cfg.workflows is wired (daemon.ts); this only
 *  fires outside that flow. Mirrors spawn_agent/exit_plan_mode's placeholder-plus-bridge split. */
export function registerWorkflowTool(r: ToolRegistry, opts?: { deferred?: boolean }): void {
  r.register({
    name: "Workflow",
    description: AUTHORING_GUIDE,
    args: WorkflowArgs,
    deferred: opts?.deferred,
    async run(_args: z.infer<typeof WorkflowArgs>) {
      return "workflows are not available in this session";
    },
  });
}
