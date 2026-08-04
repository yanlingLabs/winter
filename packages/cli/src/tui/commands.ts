// Phase 3d Task 1 — the pure in-chat slash-command registry + runners that back the 3d
// autocomplete menu (later tasks). Pure module apart from each runner's own I/O (a NormaClient RPC,
// or — for /model only — direct settings.json read/write, exactly like its main.ts route): no
// React/Ink imports here, no Date.now/Math.random.
//
// Every runner mirrors ONE main.ts subcommand route's client calls + console output wording,
// folded into a single note string (appendNote). The route line numbers cited below are from the
// 3d-task-1-brief.md reading list (packages/cli/src/main.ts).
import { join } from "node:path";
import {
  CODEX_MODELS, OutputStyleStore, TrustStore, loadSettings, resolveNormaHome, saveSettings,
  setOutputStyle, setProviderModel, setReasoningEffort,
} from "@norma/core";
import type { Settings } from "@norma/core";
import { parseModelArgs, validateEffort, validateModelSlug } from "../model-cli";
import { parseOutputStyleArgs } from "../output-style-cli";
import { formatElapsed, formatTokens } from "../task-display";
import { formatRoutineLine } from "../routines-cli";
import { formatMemoryList } from "../memory-cli";
import { filterCodeSessions } from "../session-mode";
import type { NormaClient } from "../client";

export interface CommandCtx {
  client: NormaClient;
  sessionId: string;
  cwd: string;
  appendNote(text: string): void;
  /** T2 review item 3: `/cd` calls this with the DAEMON-CONFIRMED new cwd (the resolved path
   *  `client.setCwd` returns, not the raw arg), so a ctx builder that tracks the session's live
   *  cwd (app.tsx holds it in a ref and constructs a fresh ctx per run) can feed the updated value
   *  to LATER commands in the same session (`/skills`, `/mcp`). Optional: callers that don't track
   *  a live cwd (tests, one-shot contexts) simply don't wire it. */
  onCwdChanged?(newCwd: string): void;
}

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  run(ctx: CommandCtx, argText: string): Promise<void>;
}

// ---- individual runners --------------------------------------------------------------------

/** No route to mirror — /help just renders the registry + keybindings (helpText, below). */
async function runHelp(ctx: CommandCtx): Promise<void> {
  ctx.appendNote(helpText());
}

/** Mirrors main.ts `case "compact"` (~:1039): `client.compact(sessionId)`, then the same
 *  compacted/"nothing to compact yet" branch and wording (minus the `norma compact` exit-code
 *  path, which has no meaning inside a running chat). */
async function runCompact(ctx: CommandCtx): Promise<void> {
  const r = await ctx.client.compact(ctx.sessionId);
  ctx.appendNote(r.compacted ? `compacted (through seq ${r.uptoSeq}, ${r.summaryChars} char summary)` : "nothing to compact yet");
}

/** Mirrors main.ts `case "model"` (~:1318-1365): NO client/daemon RPC at all — that route reads
 *  and writes `settings.json` directly (spec: model switches must not require a daemon restart;
 *  the daemon's live model resolver in providers/manager.ts picks the new value up on its next
 *  turn). Reuses model-cli.ts's parseModelArgs/validateModelSlug/validateEffort — the exact same
 *  pure parse/validate functions main.ts's route calls — and @norma/core's
 *  loadSettings/saveSettings/setProviderModel/setReasoningEffort/CODEX_MODELS, the same helpers.
 *  No arg -> "show" (lists CODEX_MODELS marking the active one, mirroring the route's `*` marker);
 *  an arg -> switches (mirrors the route's write path + "takes effect next turn" note). */
async function runModel(ctx: CommandCtx, argText: string): Promise<void> {
  const args = argText.trim().length > 0 ? argText.trim().split(/\s+/) : [];
  const action = parseModelArgs(args);
  if (action.kind === "usageError") {
    ctx.appendNote(action.message);
    return;
  }

  const settingsPath = join(resolveNormaHome(), "settings.json");
  const settings = loadSettings(settingsPath);

  if (action.kind === "show") {
    const effortSuffix = settings.provider.reasoningEffort ? `  effort: ${settings.provider.reasoningEffort}` : "";
    const lines = [`${settings.provider.model}${effortSuffix}`];
    if (settings.provider.type === "codex-oauth") {
      lines.push("available (codex-oauth):");
      for (const m of CODEX_MODELS) lines.push(`  ${m.id === settings.provider.model ? "*" : " "} ${m.id}`);
    }
    ctx.appendNote(lines.join("\n"));
    return;
  }

  let next = settings;
  if (action.kind === "setModel" || action.kind === "setModelAndEffort") {
    const err = validateModelSlug(settings.provider.type, action.slug);
    if (err) { ctx.appendNote(err); return; }
    next = setProviderModel(next, action.slug);
  }
  if (action.kind === "setEffort" || action.kind === "setModelAndEffort") {
    const err = validateEffort(action.effort);
    if (err) { ctx.appendNote(err); return; }
    next = setReasoningEffort(next, action.effort as NonNullable<Settings["provider"]["reasoningEffort"]>);
  }
  saveSettings(settingsPath, next);
  const changed = [
    action.kind === "setModel" || action.kind === "setModelAndEffort" ? `model ${next.provider.model}` : null,
    action.kind === "setEffort" || action.kind === "setModelAndEffort" ? `effort ${next.provider.reasoningEffort}` : null,
  ].filter(Boolean).join(", ");
  ctx.appendNote(`updated (${changed}) — takes effect next turn, no daemon restart needed`);
}

/** Mirrors main.ts `case "output-style"` (~:1546): NO client/daemon RPC at all — same
 *  no-daemon-restart precedent as /model above (the daemon's live style resolver re-resolves
 *  settings.outputStyle on the session's next turn). Reuses output-style-cli.ts's
 *  parseOutputStyleArgs — the exact same pure parser main.ts's route calls — and @norma/core's
 *  loadSettings/saveSettings/setOutputStyle/OutputStyleStore, the same helpers. Uses `ctx.cwd`
 *  (not `process.cwd()`) for the store's trust-gated project lookup — same substitution as
 *  /skills and /mcp above, since a project's `.norma/output-styles/` is resolved relative to the
 *  session's tracked cwd, not the CLI process's own. No arg -> list (marks the active style);
 *  `--help`/`-h` -> usage note; a name -> sets it (validated via store.resolve, same
 *  unknown-name rejection as the route). */
async function runOutputStyle(ctx: CommandCtx, argText: string): Promise<void> {
  const args = argText.trim().length > 0 ? argText.trim().split(/\s+/) : [];
  const action = parseOutputStyleArgs(args);

  if (action.action === "help") {
    ctx.appendNote("usage: /output-style [name]");
    return;
  }

  const home = resolveNormaHome();
  const settingsPath = join(home, "settings.json");
  const settings = loadSettings(settingsPath);
  const store = new OutputStyleStore({ normaHome: home, trust: new TrustStore(join(home, "trust.json")) });
  const current = settings.outputStyle ?? "default";

  if (action.action === "list") {
    ctx.appendNote(store.list(ctx.cwd).map((s) => `${s.name === current ? "*" : " "} ${s.name.padEnd(14)} ${s.description}`).join("\n"));
    return;
  }

  // set
  if (!store.resolve(action.name, ctx.cwd)) {
    ctx.appendNote(`Unknown output style: ${action.name}\nAvailable: ${store.list(ctx.cwd).map((s) => s.name).join(", ")}`);
    return;
  }
  saveSettings(settingsPath, setOutputStyle(settings, action.name));
  ctx.appendNote(`Output style set to: ${action.name}`);
}

/** Mirrors main.ts `case "status"` (~:929): `client.daemonStatus()`, same provider/"(none
 *  configured)" branch and the two summary lines (folded into one note, newline-joined). */
async function runStatus(ctx: CommandCtx): Promise<void> {
  const s = await ctx.client.daemonStatus();
  const provider = s.provider ? `${s.provider.id} (${s.provider.model})` : "(none configured)";
  ctx.appendNote([
    `norma-core v${s.version} up ${formatElapsed(s.uptimeMs)} · ${s.socketPath}`,
    `provider: ${provider} · sessions: ${s.sessionsCount} · plugins: ${s.pluginsCount}`,
  ].join("\n"));
}

/** Mirrors main.ts `case "quota"` (~:938): `client.quotaState()`, same ok/limited(resumeAt)
 *  wording and formatTokens usage. */
async function runQuota(ctx: CommandCtx): Promise<void> {
  const q = await ctx.client.quotaState();
  const state = q.kind === "ok" ? "ok" : `limited (resumes ${new Date(q.resumeAt ?? 0).toLocaleString()})`;
  ctx.appendNote(`quota: ${state} ${formatTokens(q.inputTokens)} in / ${formatTokens(q.outputTokens)} out`);
}

/** Mirrors main.ts `case "sessions"` (~:922): `client.listSessions()`, one line per session
 *  (`sessionId scope · N events`). Scoped down from the route: the route's optional
 *  ` — ${title}` TTY suffix is dropped — `SessionListResult` (protocol/methods.ts) carries no
 *  `title` field, so main.ts's `s.title` read is only reachable via its `as any` cast on the RPC
 *  result; the typed client here has no such field to mirror. Also adds a "(no sessions)"
 *  fallback for the empty list, which the route (an unconditional for-loop) leaves silently blank
 *  — a bare empty note would be a poor one-note summary.
 *
 *  Plan-immunity Task 2 (mode×surface matrix): the TUI is CODE-ONLY, and /sessions is the
 *  interactive resume PICKER — it feeds directly into resuming INTO this same TUI, which can only
 *  ever attach to a code session — so this HIDES chat/dispatch/cowork rows entirely
 *  (`filterCodeSessions`, session-mode.ts). Contrast `norma sessions` (main.ts), a plain inventory
 *  listing that MARKS non-code rows instead of hiding them — see that module's file doc for the
 *  full picker-vs-inventory distinction. */
async function runSessions(ctx: CommandCtx): Promise<void> {
  // listSessions()'s return type is untyped (client.ts's private `validated()` helper returns
  // `any`, same reason main.ts's own `sessions` route casts `as any`) — annotate the destructure
  // explicitly so the .map below isn't an implicit-any under this package's strict tsconfig.
  // Widened to carry `mode` (SessionListResult always has it) — a narrower type here would silently
  // drop the field the code-only filter below depends on.
  const { sessions } = (await ctx.client.listSessions()) as { sessions: Array<{ sessionId: string; scope: string; lastSeq: number; mode?: string }> };
  const codeSessions = filterCodeSessions(sessions);
  if (codeSessions.length === 0) { ctx.appendNote("(no sessions)"); return; }
  ctx.appendNote(codeSessions.map((s) => `${s.sessionId} ${s.scope} · ${s.lastSeq} events`).join("\n"));
}

/** Mirrors main.ts `case "add-dir"` (~:960): `client.addDir(sessionId, path, persist)` — sessionId
 *  comes from ctx (the route reads it from argv since the CLI is session-less), the `path` and
 *  `--persist` flag come from argText. Missing path -> usage note, no RPC (mirrors the route's
 *  argv-missing usage+exit, without exiting the shell). */
async function runAddDir(ctx: CommandCtx, argText: string): Promise<void> {
  const persist = /(^|\s)--persist(\s|$)/.test(argText);
  const path = argText.replace(/--persist\b/g, "").trim();
  if (!path) { ctx.appendNote("usage: /add-dir <path> [--persist]"); return; }
  const roots = await ctx.client.addDir(ctx.sessionId, path, persist);
  ctx.appendNote(`+ dir ${path} → ${roots.length} roots`);
}

/** Mirrors main.ts `case "cd"` (~:1010): `client.setCwd(sessionId, path)`, reports the resolved
 *  cwd exactly as the route does. Missing path -> usage note, no RPC. On success, also announces
 *  the daemon-confirmed cwd via `ctx.onCwdChanged` (see its doc on `CommandCtx`) so later commands
 *  in the same session see the new value. */
async function runCd(ctx: CommandCtx, argText: string): Promise<void> {
  const path = argText.trim();
  if (!path) { ctx.appendNote("usage: /cd <path>"); return; }
  const newCwd = await ctx.client.setCwd(ctx.sessionId, path);
  ctx.onCwdChanged?.(newCwd);
  ctx.appendNote(`cwd → ${newCwd}`);
}

// working-directories T7: `/dirs` family — the read (bare `/dirs`) + write (`add`/`primary`/
// `remove`) surface over T3's `session.setDirs`/`session.list.dirs`. No main.ts route to mirror
// (this is TUI-only, like /background above) — instead it mirrors T3's own wire contract: `dirs[0]`
// is the primary BY POSITION (never a flag), each entry also carries `locked`. Display convention
// (spec: "one line per entry, `*` marks the primary, `🔒` marks locked") is this task's own —
// bracket-parenthesized like the codebase's other "(no X)" empty-state notes (`(no sessions)`,
// `(no bg tasks)`), and names `$OUTDIR` per the plan's "workdir-less notice naming $OUTDIR" bullet,
// echoing context.ts's own workspace-block vocabulary for that env var.
const DIRS_WORKDIR_LESS_NOTICE = "(no working directories — this session's deliverables go to $OUTDIR)";
const DIRS_USAGE = "usage: /dirs [add <path> | primary <path> | remove <path>]";
const DIRS_OP_BY_TOKEN: Record<string, "add" | "setPrimary" | "remove"> = {
  add: "add",
  primary: "setPrimary",
  remove: "remove",
};

function formatDirs(dirs: { path: string; locked: boolean }[]): string {
  if (dirs.length === 0) return DIRS_WORKDIR_LESS_NOTICE;
  return dirs.map((d, i) => `${i === 0 ? "*" : " "} ${d.locked ? "🔒 " : "  "}${d.path}`).join("\n");
}

/** Bare `/dirs` reads the CURRENT session's row off `listSessions()` (the only surface
 *  `SessionListResult`'s per-row `dirs` rides — there is no single-session `session.get`) and
 *  displays it (or the workdir-less notice for an empty set). `/dirs add|primary|remove <path>`
 *  drives `sessionSetDirs` — the typed command IS the confirm, no extra prompt — and displays the
 *  RESULT's post-write `dirs`, not an echo of the request (same "report what the write actually
 *  produced" contract `sessionSetActivity`'s `activity` follows, client.ts's own doc comment on
 *  `sessionSetDirs`). A daemon refusal (unknown session, non-code/cowork mode, locked, denylisted,
 *  remove-primary) is a thrown RpcFailure — deliberately left UNCAUGHT here, exactly like
 *  `runSetActivity` above, so `runCommand`'s shared catch reports it verbatim (the manage_session
 *  precedent — no re-wording; see commands.test.ts's `/archive — a daemon refusal surfaces
 *  verbatim` for the shape this produces: `/dirs failed: <daemon message>`). */
async function runDirs(ctx: CommandCtx, argText: string): Promise<void> {
  const trimmed = argText.trim();
  if (trimmed === "") {
    const { sessions } = (await ctx.client.listSessions()) as {
      sessions: Array<{ sessionId: string; dirs?: { path: string; locked: boolean }[] }>;
    };
    const row = sessions.find((s) => s.sessionId === ctx.sessionId);
    ctx.appendNote(formatDirs(row?.dirs ?? []));
    return;
  }

  const spaceIdx = trimmed.search(/\s/);
  const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const path = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  const op = DIRS_OP_BY_TOKEN[token];
  if (!op || path === "") { ctx.appendNote(DIRS_USAGE); return; }

  const r = await ctx.client.sessionSetDirs({ sessionId: ctx.sessionId, op, path });
  ctx.appendNote(formatDirs(r.dirs));
}

/** Mirrors main.ts `case "skills"` (~:1048): `client.listSkills(cwd)` — the route passes
 *  `process.cwd()` (the CLI process's own cwd); here that's `ctx.cwd`, the session's tracked cwd
 *  (the closest in-chat equivalent). Same "no skills installed" / per-skill line wording. */
async function runSkills(ctx: CommandCtx): Promise<void> {
  const rows = await ctx.client.listSkills(ctx.cwd);
  if (rows.length === 0) { ctx.appendNote("no skills installed"); return; }
  ctx.appendNote(rows.map((s) => `${s.name} (${s.source}) — ${s.description}`).join("\n"));
}

/** Mirrors main.ts `case "mcp"` (~:1056): `client.listMcp(cwd)` (same ctx.cwd substitution as
 *  /skills above), same "no MCP servers configured" / per-server line + namespaced
 *  `mcp__<name>__<tool>` tool listing. */
async function runMcp(ctx: CommandCtx): Promise<void> {
  const servers = await ctx.client.listMcp(ctx.cwd);
  if (servers.length === 0) { ctx.appendNote("no MCP servers configured"); return; }
  ctx.appendNote(servers.map((s) => `${s.name} (${s.source}, ${s.status}) ${s.toolNames.map((t) => `mcp__${s.name}__${t}`).join(", ")}`).join("\n"));
}

/** Mirrors main.ts `case "bg"` (~:1206): `bg list|peek|kill <session> [taskId]` — sessionId comes
 *  from ctx; argText's first token selects the sub-route (defaulting to "list" when omitted,
 *  since a bare `/bg` reads naturally as "show me what's running"), the second is the taskId.
 *  list -> `client.bgList`, same "(no bg tasks)" / per-task line; peek -> `client.bgPeek`, same
 *  status/exit wording plus the output chunk when present; kill -> `client.bgKill`, same "killed
 *  <id>" wording. Missing taskId for peek/kill, or an unrecognized sub-route, is a usage note. */
async function runBg(ctx: CommandCtx, argText: string): Promise<void> {
  const tokens = argText.trim().length > 0 ? argText.trim().split(/\s+/) : [];
  const sub = tokens[0] ?? "list";
  const taskId = tokens[1];
  const usage = "usage: /bg list | /bg peek <taskId> | /bg kill <taskId>";

  if (sub === "list") {
    const tasks = await ctx.client.bgList(ctx.sessionId);
    ctx.appendNote(tasks.length === 0 ? "(no bg tasks)" : tasks.map((t) => `${t.taskId} ${t.status} · ${t.command.slice(0, 80)}`).join("\n"));
    return;
  }
  if (sub === "peek") {
    if (!taskId) { ctx.appendNote(usage); return; }
    const r = await ctx.client.bgPeek(ctx.sessionId, taskId);
    const head = `${r.status} exit=${r.exitCode ?? "-"}`;
    ctx.appendNote(r.chunk ? `${head}\n${r.chunk}` : head);
    return;
  }
  if (sub === "kill") {
    if (!taskId) { ctx.appendNote(usage); return; }
    await ctx.client.bgKill(ctx.sessionId, taskId);
    ctx.appendNote(`killed ${taskId}`);
    return;
  }
  ctx.appendNote(usage);
}

/** Phase 5 routines T4: list-only in v1 (design doc §5 — create/delete/enable/disable stay
 *  CLI/tool-only). Mirrors main.ts `case "routines"`'s default (no-subcommand → list) branch:
 *  `client.routinesList()`, one line per routine via `formatRoutineLine` (routines-cli.ts) — the
 *  exact plain content the CLI's colored list wraps AQUA/DIM around. */
async function runRoutines(ctx: CommandCtx): Promise<void> {
  const { routines } = await ctx.client.routinesList();
  if (routines.length === 0) { ctx.appendNote("(no routines)"); return; }
  ctx.appendNote(routines.map((r) => formatRoutineLine(r)).join("\n"));
}

/** Phase 5b Task 4: list-only, "user" scope (design doc §4 — write/delete stay CLI/tool-only,
 *  same precedent as /routines above). Mirrors main.ts `case "memory"`'s default (no --project →
 *  "user" scope) list branch: `client.memoryList("user")`, one line per fact via
 *  `formatMemoryList` (memory-cli.ts) — the exact plain content the CLI's colored list wraps
 *  AQUA/DIM around, same shared-formatter precedent as `formatRoutineLine` above. */
async function runMemory(ctx: CommandCtx): Promise<void> {
  const { facts } = await ctx.client.memoryList("user");
  ctx.appendNote(formatMemoryList(facts).join("\n"));
}

/** CC-parity phase 3 (Workflows) Track C Task C4: mirrors `norma workflow`'s CLI shape
 *  (workflow-cli.ts / main.ts `case "workflow"`, C3) inside the TUI. No sub-token -> list: saved
 *  workflows (`client.workflowList`'s `.saved` — the same `WorkflowStore` scan the CLI's
 *  file-direct `list` reads, C1) then running runs (`.running`) under a "running:" header — same
 *  two-part shape as the CLI's own `list`, minus its best-effort existsSync(socketPath()) probe:
 *  the TUI is always already attached to a live daemon, so `workflowList` is unconditional here.
 *  Uses `ctx.cwd` (not `process.cwd()`) for the trust-gated project lookup — same substitution as
 *  /skills, /mcp, /output-style above. `run <name> [json-args]` / `stop <runId>` mirror /bg's
 *  sub-token dispatch (above): `run` forwards to `client.workflowRun` (the same call
 *  `tryRunSavedWorkflow` below and the CLI's own `run` route make) and reports the new runId;
 *  `stop` calls `client.workflowStop` and reports whether it actually stopped anything (mirrors
 *  `workflowStop`'s soft `{ok,stopped}` contract, C2 — an unknown/already-terminal runId is not an
 *  error, just a `stopped: false`). A missing sub-token defaults to "list" — same "a bare /bg reads
 *  naturally as show me what's running" rationale runBg's own doc comment gives (an explicit
 *  `/workflows list` is handled identically, not just the no-arg form). */
async function runWorkflows(ctx: CommandCtx, argText: string): Promise<void> {
  const tokens = argText.trim().length > 0 ? argText.trim().split(/\s+/) : [];
  const sub = tokens[0] ?? "list";
  const usage = "usage: /workflows [list | run <name> [json-args] | stop <runId>]";

  if (sub === "list") {
    const { saved, running } = await ctx.client.workflowList(ctx.sessionId, ctx.cwd);
    if (saved.length === 0 && running.length === 0) { ctx.appendNote("(no workflows)"); return; }
    const lines = saved.map((w) => `${w.name} (${w.source}) — ${w.description}`);
    if (running.length > 0) {
      lines.push("running:");
      for (const r of running) lines.push(`${r.runId} ${r.name ?? "(inline script)"} · ${r.status}`);
    }
    ctx.appendNote(lines.join("\n"));
    return;
  }

  if (sub === "run") {
    const name = tokens[1];
    if (!name) { ctx.appendNote(usage); return; }
    const argsText = tokens.slice(2).join(" ");
    let args: unknown;
    if (argsText.length > 0) {
      try {
        args = JSON.parse(argsText);
      } catch {
        ctx.appendNote(`invalid JSON args: ${argsText}`);
        return;
      }
    }
    const { runId } = await ctx.client.workflowRun({ sessionId: ctx.sessionId, name, args });
    ctx.appendNote(`${runId} running`);
    return;
  }

  if (sub === "stop") {
    const runId = tokens[1];
    if (!runId) { ctx.appendNote(usage); return; }
    const r = await ctx.client.workflowStop(runId);
    ctx.appendNote(r.stopped ? `stopped ${runId}` : `${runId} was not running`);
    return;
  }

  ctx.appendNote(usage);
}

/** session-activity-hygiene T3 (spec §1): `/background` and `/archive` — the two lifecycle verbs,
 *  one shared runner over the ONE `session.setActivity` RPC, always against the CURRENT session
 *  (`ctx.sessionId`), which in this shell is always a code session (the TUI is code-only,
 *  plan-immunity Task 2 — so the daemon's participation refusal is unreachable from here).
 *
 *  No main.ts route to mirror: these have no headless counterpart yet, deliberately. Every
 *  session-targeted headless verb in this codebase carries a client-side `checkCodeSession` gate
 *  extracted into its own route function plus a `cli-verb-gates.test.ts` case (main.ts's
 *  plan-immunity fix round), and that gate's vocabulary is NARROWER than activity participation —
 *  it hides cowork, which participates fully — so a headless `norma background <id>` would need a
 *  new gate predicate rather than the existing one. T8 (dispatch's management verbs) and T9
 *  (`norma agents`) are the plan's own homes for that surface.
 *
 *  `off` is how the RPC's clearing half is reachable from the shell at all; no sub-token means the
 *  verb's own value, the overwhelmingly common case (`/bg`'s "a bare verb reads naturally as the
 *  obvious thing" precedent). The note reports the DAEMON'S DERIVED answer, never the value that was
 *  sent: a clear on a session whose detached bash task is still writing comes back `"background"`,
 *  and echoing the request would quietly lie about it.
 *
 *  activity-verb-semantics ruling 6: EACH TOGGLE'S OFF CLEARS ITS OWN FLAG AND ONLY ITS OWN.
 *  `/background off` sends `"unbackground"`; `/archive off` sends `null`, which is RESUME and clears
 *  the archive bit alone. Both used to send `null` back when `null` cleared both flags — so
 *  `/background off` silently un-archived a hidden session and `/archive off` silently took a worker
 *  off background duty, each toggle answering a question the user had not asked. */
async function runSetActivity(ctx: CommandCtx, verb: "background" | "archive", argText: string): Promise<void> {
  const on = verb === "background" ? "background" as const : "archived" as const;
  const off = verb === "background" ? "unbackground" as const : null;
  const token = argText.trim().toLowerCase();
  if (token !== "" && token !== "on" && token !== "off") {
    ctx.appendNote(`usage: /${verb} [on|off]`);
    return;
  }
  const r = await ctx.client.sessionSetActivity({ sessionId: ctx.sessionId, activity: token === "off" ? off : on });
  // `activity` is optional on the wire for the same reason `SessionSummary.activity` is (absent =
  // "does not participate"). A code session can never produce that — but a client must render
  // absence as "no state" rather than inventing `idle`, so it is spelled out rather than defaulted.
  ctx.appendNote(`activity → ${r.activity ?? "(none)"}`);
}

// ---- registry -------------------------------------------------------------------------------

export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "List commands and keybindings", run: (ctx) => runHelp(ctx) },
  { name: "compact", description: "Compact conversation history to a summary", run: (ctx) => runCompact(ctx) },
  { name: "model", args: "[slug] [--effort <level>]", description: "Show or switch the active model/effort", run: (ctx, argText) => runModel(ctx, argText) },
  { name: "output-style", args: "[name]", description: "Show or switch the output style", run: (ctx, argText) => runOutputStyle(ctx, argText) },
  { name: "status", description: "Show daemon status and provider info", run: (ctx) => runStatus(ctx) },
  { name: "quota", description: "Show token usage and quota state", run: (ctx) => runQuota(ctx) },
  { name: "sessions", description: "List resumable sessions", run: (ctx) => runSessions(ctx) },
  { name: "add-dir", args: "<path> [--persist]", description: "Add a directory to the session's roots", run: (ctx, argText) => runAddDir(ctx, argText) },
  { name: "cd", args: "<path>", description: "Change the session's working directory", run: (ctx, argText) => runCd(ctx, argText) },
  { name: "dirs", args: "[add|primary|remove <path>]", description: "Show or change this session's working directories", run: (ctx, argText) => runDirs(ctx, argText) },
  { name: "skills", description: "List installed skills", run: (ctx) => runSkills(ctx) },
  { name: "mcp", description: "List configured MCP servers", run: (ctx) => runMcp(ctx) },
  { name: "bg", args: "[list|peek|kill] [taskId]", description: "List/peek/kill background tasks", run: (ctx, argText) => runBg(ctx, argText) },
  { name: "routines", description: "List scheduled routines", run: (ctx) => runRoutines(ctx) },
  { name: "memory", description: "List saved memory facts (user scope)", run: (ctx) => runMemory(ctx) },
  { name: "workflows", args: "[run <name> [json]|stop <runId>]", description: "List saved + running workflows", run: (ctx, argText) => runWorkflows(ctx, argText) },
  { name: "background", args: "[on|off]", description: "Keep this session running unattended", run: (ctx, argText) => runSetActivity(ctx, "background", argText) },
  { name: "archive", args: "[on|off]", description: "Archive this session (hidden until resumed)", run: (ctx, argText) => runSetActivity(ctx, "archive", argText) },
];

// ---- parse / filter / dispatch ---------------------------------------------------------------

/** "/compact" -> {cmd:"compact", argText:""}; "/model gpt-5.6-luna" -> {cmd:"model",
 *  argText:"gpt-5.6-luna"}; leading/trailing whitespace around the whole input is tolerated; a
 *  non-slash string returns null. */
export function parseSlashInput(text: string): { cmd: string; argText: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) return { cmd: rest, argText: "" };
  return { cmd: rest.slice(0, spaceIdx), argText: rest.slice(spaceIdx + 1).trim() };
}

function isFuzzySubsequence(name: string, query: string): boolean {
  let qi = 0;
  for (const ch of name) {
    if (qi < query.length && ch === query[qi]) qi++;
  }
  return qi === query.length;
}

/** Prefix matches first (registry order), then fuzzy subsequence matches (registry order, minus
 *  anything already returned as a prefix match) — stable, no duplicates. Empty query returns the
 *  whole registry in order. */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...COMMANDS];
  const prefixMatches = COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  const prefixNames = new Set(prefixMatches.map((c) => c.name));
  const fuzzyMatches = COMMANDS.filter((c) => !prefixNames.has(c.name) && isFuzzySubsequence(c.name.toLowerCase(), q));
  return [...prefixMatches, ...fuzzyMatches];
}

/** One note block: every command's `/name args — description` line, then the shell's keybinding
 *  list (spec §4 content — see app.tsx/composer.tsx/footer.tsx, cited per-key in the 3d task-1
 *  brief). */
export function helpText(): string {
  const cmdLines = COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""} — ${c.description}`);
  const keys = [
    "enter send",
    "esc interrupt (running) / Esc-Esc clear",
    "shift+tab cycle modes",
    "↑↓ history",
    "PgUp/PgDn scroll",
    "ctrl+u half-page up",
    "Home/End top/bottom (empty input)",
    "ctrl+o expand outputs",
    "ctrl+t tasks",
    "ctrl+a agents (↑↓ select · enter open · x stop/dismiss · esc back)",
    "ctrl+c/ctrl+d (empty) exit",
    "/ commands",
    "@ files",
  ];
  return [...cmdLines, "", `Keys: ${keys.join(" · ")}`].join("\n");
}

/** CC-parity phase 3 (Workflows) Track C Task C4: after a REGISTRY miss, `cmd` might name a SAVED
 *  workflow rather than an unknown built-in — e.g. `/triage`, after a `norma workflow save
 *  triage ...` (C3) or a Workflow-tool save (agent/tools/workflow.ts). `client.workflowRun`
 *  resolves `name` server-side via `WorkflowStore` IN THE SESSION'S OWN cwd (protocol/methods.ts's
 *  `WorkflowRunParams` doc comment) — same resolution chain `/workflows run <name>` above and the
 *  CLI's own `run` route use, so this never duplicates that lookup locally. Returns false (and
 *  appends NO note of its own) on ANY failure, INCLUDING the client not exposing `workflowRun` at
 *  all: `runCommand` below only calls this once a registry miss has already happened, so a genuine
 *  typo (`/nope`) must still fall through to the ordinary "Unknown command" note, never a raw
 *  exception. */
async function tryRunSavedWorkflow(ctx: CommandCtx, name: string): Promise<boolean> {
  try {
    const { runId } = await ctx.client.workflowRun({ sessionId: ctx.sessionId, name });
    ctx.appendNote(`${runId} running`);
    return true;
  } catch {
    return false;
  }
}

/** parse -> lookup -> run. Non-slash input: untouched, returns false. A REGISTRY miss falls back to
 *  `tryRunSavedWorkflow` (a saved workflow named `cmd` — Task C4, above) before giving up; still no
 *  match -> a note ("Unknown command: /x — /help lists commands") and true (handled). A runner that
 *  throws is caught here — `/${cmd} failed: ${message}` — a failing command must never crash the
 *  shell. */
export async function runCommand(ctx: CommandCtx, text: string): Promise<boolean> {
  const parsed = parseSlashInput(text);
  if (!parsed) return false;
  const { cmd, argText } = parsed;
  const command = COMMANDS.find((c) => c.name === cmd);
  if (!command) {
    if (await tryRunSavedWorkflow(ctx, cmd)) return true;
    ctx.appendNote(`Unknown command: /${cmd} — /help lists commands`);
    return true;
  }
  try {
    await command.run(ctx, argText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.appendNote(`/${cmd} failed: ${message}`);
  }
  return true;
}
