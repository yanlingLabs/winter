import { z } from "zod";
import type { Question, Task } from "@norma/protocol";
import type { ToolSpec } from "../../providers/types";
import { isWithin } from "../paths";
import type { AskOutcome } from "../questions";
import type { ComputerUseService } from "../computer-use";

export interface ToolContext {
  cwd: string;
  roots: string[]; // allowed roots; roots[0] MUST be the primary cwd — relative tool paths resolve against it
  tmpDir?: string; // per-session scratch dir (sandbox writable root + child TMPDIR); bash uses it, other tools ignore
  // working-directories T4: the session's delivery-folder — `<normaHome>/outputs/<sessionId>`
  // (sessions/outdir.ts's `ensureOutdir`). Independent of `roots`/`rootsOverride` (mirrors `tmpDir`'s
  // own independence — see engine.ts's `executeCall`): a worktree-isolated child's FIXED roots
  // never include it either, yet the delivery channel must stay reachable regardless. bash.ts
  // splices it into $OUTDIR and unions it into the seatbelt's writable set explicitly (never assumed
  // to already be covered by `roots`); other tools ignore it (the write/edit fence gets the SAME
  // path through `SessionDirectories.roots`, the blessing mechanism — this field exists only for
  // bash, which builds its own writable set independently of that fence).
  outDir?: string;
  sessionId: string; // scopes ask/task/computer-use bridges below to this session; write/edit's out-of-root grant flow lives in engine.ts's dispatch loop (keyed per-session there), not here
  signal?: AbortSignal; // aborts when the turn is interrupted; long-running tools (bash) should honor it
  markSkillLoaded?: (name: string) => void; // set by the engine; the Skill tool calls it to pin a loaded skill for the session
  markToolLoaded?: (name: string) => void; // set by the engine; the ToolSearch tool calls it to pin a deferred tool's schema as loaded for the session
  loadedTools?: Set<string>; // mcp__/plugin__ tools AND deferred:true built-ins whose schema has been loaded via ToolSearch this session (or force-visible via an engine pin — see engine.ts's pinnedTools); consulted by execute's deferral reject
  deferThreshold?: number; // when set and cwd-visible mcp__/plugin__ tool count exceeds it (or, with deferExternals:"always", whenever any is visible at all), external deferral is active for this session
  deferExternals?: "count" | "always"; // "always": externals defer whenever ANY is visible, ignoring deferThreshold's count comparison; absent/"count" = today's threshold-count behavior
  builtinDeferral?: boolean; // true when built-in ToolSearch deferral is active for this session (mirrors the engine's toolSearchEnabled()) — any def registered `deferred: true` rides deferral whenever this is true, independent of the external count/threshold
  // This session's mode — resolves an ARRAY-valued `deferred` (deferred only in listed modes) via
  // execute()'s isDeferred check. Absent → execute() resolves an array-valued `deferred` as
  // deferred (fail-closed: a caller that doesn't know the mode must not be handed a tool some mode
  // needs to load first) — see isDeferred's own doc comment. `deferred: true`/absent are unaffected
  // by this either way. Mechanism only as of this task: no real engine.ts call site sets it yet.
  mode?: Mode;
  ask?: (questions: Question[]) => Promise<AskOutcome>; // engine bridge: emits question_asked/question_resolved events and blocks on the QuestionBroker; the ask_user tool calls it
  taskEvent?: (task: Task) => void; // engine bridge: emits task_updated; called by the task tools (task_create/task_update/task_list)
  // task-30: engine bridge for push_notification — emits notification_requested (hub.append) and,
  // when the session has zero attached clients (SessionHub.attachedCount), ALSO fires the headless
  // osascript fallback (notify-fallback.ts). Unlike ask/taskEvent this is never gated on an
  // optional subsystem (SessionHub is a mandatory EngineConfig field), so it's always set when a
  // tool runs through the real engine — absent only for a direct registry.execute() call in tests.
  notify?: (title: string, message: string) => void;
  // Computer use (Phase 5 CU): the lease-holding service the `computer` tool drives (screenshot/
  // ax-read/input-drive via the peripheral broker). Absent → the computer tool isn't wired for this
  // session (it's registered only when settings.computerUse.enabled, so normally both are set or
  // neither is).
  computerUse?: ComputerUseService;
  // Stages a vision image (a `data:` URL) for the model — the engine appends it to the turn's input
  // as an `{type:"image"}` item at round end (see engine.ts's pendingImages). Wired by the engine
  // whenever the thread's model is vision-capable, independent of computer-use (multimodal-read
  // T1 — originally CU-only). The `computer` tool's screenshot/zoom actions call this, as does the
  // `read` tool (image files, and .ipynb image/png cell outputs); any other tool may ignore it.
  attachImage?: (dataUrl: string) => void;
  // Whether the turn's resolved model accepts image input (ModelInfo.supportsVision). The computer
  // tool's screenshot action refuses when this is explicitly false (ax_snapshot still works); the
  // `read` tool refuses reading an image file the same way. Unset = unknown → not blocked.
  visionCapable?: boolean;
  // D1-T3: the CALLING THREAD's own excludeTools/allowTools — engine.ts's executeCall already
  // receives these (runThread's `toolAccess`, computed once in turn() from
  // registry.namesForMode/namesNotForMode) and uses them for its own pre-dispatch rejection; this
  // is the SAME pair, forwarded onto the ctx literal it builds for registry.execute so a tool
  // (ToolSearch, specifically) can consult what THIS thread was actually offered. Never recomputed
  // here or in toolsearch.ts — one source of truth, populated ONLY in engine.ts's executeCall.
  // Semantics mirror runThread's own `offered()` predicate exactly: `!excludeTools?.has(name) &&
  // (!allowTools || allowTools.has(name))`. Both absent (as for a direct registry.execute() call in
  // a test, or code's own excludeTools-shaped access which never CLEARS ctx.excludeTools either)
  // means "no restriction" — byte-identical to before this task for every caller that doesn't pass
  // them.
  excludeTools?: Set<string>;
  allowTools?: Set<string>;
}
export interface ToolOutcome { output: string; isError: boolean }

/** The three session modes a tool's `modes`/`deferred` fields (and every `isDeferred`-adjacent
 *  registry method below) resolve against. One alias so a fourth mode, were one ever added, is a
 *  one-site edit instead of an N-site find/replace across this file. */
export type Mode = "code" | "dispatch" | "chat";

/** Tool names ridden by ToolSearch deferral (registry.ts) and gated as external code by the
 *  permission gate (agent/gate.ts) — MCP server tools (`mcp__<server>__<tool>`) and Phase 4b
 *  platform-plugin tools (`plugin__<pluginId>__<tool>`) are treated IDENTICALLY everywhere this
 *  predicate is used: the visible-count threshold, the deferred index, specs() filtering,
 *  execute()'s runtime guard, and the gate's approval-per-policy branch. One predicate here means
 *  a new deferrable/gated namespace later is a one-line change instead of an N-site grep. */
export function isExternalToolName(name: string): boolean {
  return name.startsWith("mcp__") || name.startsWith("plugin__");
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  args: S;
  rawParameters?: Record<string, unknown>;
  /** If set, the tool is only visible/callable from sessions whose cwd is within this directory (or a descendant of it). */
  scope?: string;
  /** If true, this built-in tool rides ToolSearch deferral (hidden from specs / execute-rejected
   *  until loaded or pinned) whenever built-in deferral is active for the session — i.e. whenever
   *  ToolSearch itself is enabled (see engine.ts's toolSearchEnabled/pinnedTools), independent of
   *  the external mcp__/plugin__ count-trigger. Ignored for mcp__/plugin__ names — those defer
   *  purely off the external count (isExternalToolName), never off this flag.
   *
   *  `true` = deferred in EVERY mode that can see this tool (the original meaning — unchanged). An
   *  array = deferred ONLY in those modes, immediate in the rest — lets e.g. `bash` stay immediate
   *  for code while dispatch has to load it, or `AskQuestion` stay immediate in chat while dispatch
   *  defers it. Resolution always goes through the single `isDeferred` predicate below, which takes
   *  a `mode` alongside this value — never re-implement the true/array/absent switch at a call site. */
  deferred?: boolean | Mode[];
  /** Which session modes may see this tool. ABSENT MEANS `["code"]` — deliberately restrictive:
   *  a newly registered tool can never silently appear in a hands-off mode (chat) or a
   *  narrow one (dispatch). This is the single declaration site that replaces the old
   *  CHAT_ONLY_TOOLS exclusion lists; dynamically registered mcp__/plugin__ tools take the
   *  default and so stay code-only, matching their reachability today. */
  modes?: Mode[];
  /** May throw — the registry converts throws into isError outcomes. */
  run(args: z.infer<S>, ctx: ToolContext): Promise<string> | string;
}

const MAX_OUTPUT = 64 * 1024; // tool outputs are model input — cap them

export class ToolRegistry {
  private defs = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.defs.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.defs.set(def.name, def);
  }

  /** Every tool eligible for `mode`, plus ToolSearch when any eligible tool is deferred.
   *  Derived live from `defs` on every call — dynamically registered tools are included
   *  immediately, and there is no cached set to invalidate. */
  namesForMode(mode: Mode, opts?: { builtinDeferral?: boolean }): Set<string> {
    // ToolSearch is excluded from the ordinary mode-membership pass and decided purely by
    // anyDeferred below — mirroring specs()'s `if (d.name === "ToolSearch") return
    // toolSearchVisible` override (:153), which likewise replaces rather than ORs with the
    // ordinary visibility check for that one name. Without this exclusion, a ToolSearch def
    // registered with no explicit `modes` (the expected shape — nothing declares `modes` yet)
    // would default to `["code"]` and become a trivial base member of "code" regardless of
    // whether anything is actually deferred there, making builtinDeferral:false unable to hide it.
    const eligible = [...this.defs.values()].filter((d) => d.name !== "ToolSearch" && (d.modes ?? ["code"]).includes(mode));
    const names = new Set(eligible.map((d) => d.name));
    // Bug #7, structurally: a deferred tool is uncallable without ToolSearch, so a mode that has
    // one ALWAYS gets ToolSearch. Previously each mode's hand-written allowlist had to remember
    // this, and dispatch's did not — advertising web_fetch/web_search/push_notification it could
    // never load. `mode` is passed to isDeferred here (deferred-modes task) so an array-valued
    // `deferred` only counts as "deferred" for THIS check when it names THIS mode — a tool deferred
    // only in code must not drag ToolSearch into dispatch, where it's immediate.
    const anyDeferred = opts?.builtinDeferral === true
      && eligible.some((d) => this.isDeferred(d, false, true, mode));
    if (anyDeferred && this.defs.has("ToolSearch")) names.add("ToolSearch");
    return names;
  }

  /** The complement of namesForMode — for code's exclude-shaped toolAccess, which must keep
   *  admitting dynamically registered tools by default rather than enumerating them. Mirrors
   *  namesForMode's own `d.name !== "ToolSearch"` exclusion (:100): ToolSearch's eligibility is
   *  ALWAYS decided by namesForMode's anyDeferred check, never by whatever `modes` field ToolSearch
   *  itself might carry (today it declares none). Without this exclusion here too, a future edit
   *  that gave ToolSearch an explicit `modes` not including "code" would make ToolSearch satisfy
   *  THIS function's ordinary complement check and land in code's `excludeTools` (engine.ts's
   *  runThread toolAccess for a plain, non-dispatch/non-chat session) — silently stripping
   *  ToolSearch out of code mode entirely and making every deferred tool in the daemon's primary
   *  mode permanently unloadable, with namesForMode("code") still (correctly, per its own
   *  anyDeferred logic) reporting ToolSearch as eligible the whole time. */
  namesNotForMode(mode: Mode): Set<string> {
    return new Set([...this.defs.values()]
      .filter((d) => d.name !== "ToolSearch" && !(d.modes ?? ["code"]).includes(mode))
      .map((d) => d.name));
  }

  /** External (mcp__/plugin__ — isExternalToolName) deferral trigger for a (cwd, threshold) pair:
   *  active when the caller provided a threshold AND more than that many external tools are
   *  visible ("count" mode, the default/absent case) — OR, with deferExternals "always", whenever
   *  ANY external tool is visible at all (the count comparison is skipped). No threshold provided
   *  → never active, same as before deferExternals existed. */
  private externalCountActive(cwd: string | null | undefined, deferThreshold?: number, deferExternals?: "count" | "always"): boolean {
    if (deferThreshold === undefined) return false;
    let n = 0;
    for (const d of this.defs.values()) {
      if (isExternalToolName(d.name) && (!d.scope || (!!cwd && isWithin(cwd, d.scope)))) n++;
    }
    return deferExternals === "always" ? n > 0 : n > deferThreshold;
  }

  /** True when `d` rides deferral in the current mode: externals under the count trigger (or
   *  deferExternals:"always"), and any def registered `deferred: true`/array whenever built-in
   *  deferral (= ToolSearch enabled) is on. ONE predicate — specs/deferredIndex/execute/
   *  isDeferredBuiltin/namesForMode's anyDeferred ALL use it, so they can never disagree about
   *  what's currently deferred.
   *
   *  `d.deferred === true` still means deferred in every mode (unchanged meaning). An array means
   *  deferred ONLY when `mode` is one of its entries — so `bash` can be `deferred: ["dispatch"]`
   *  and stay immediate in code while dispatch has to load it. `mode` is OPTIONAL on this predicate
   *  (every current caller either doesn't know its mode yet or is resolving the boolean `true`
   *  case, where it's irrelevant) but every caller that DOES know its mode must pass it — a silent
   *  default here is exactly how these predicates drift apart (this codebase has been bitten by
   *  that class of bug twice already). Fail-closed when `mode` is absent and `deferred` is an
   *  array: resolves to DEFERRED, never immediate — a caller that doesn't know the mode must not be
   *  handed a tool some mode requires loading first. */
  private isDeferred(d: ToolDefinition, countActive: boolean, builtinActive: boolean, mode?: Mode): boolean {
    if (isExternalToolName(d.name)) return countActive;
    if (!builtinActive) return false;
    if (d.deferred === true) return true;
    if (Array.isArray(d.deferred)) return mode === undefined || d.deferred.includes(mode);
    return false;
  }

  private toSpec(d: ToolDefinition): ToolSpec {
    return { name: d.name, description: d.description, parameters: d.rawParameters ?? z.toJSONSchema(d.args) };
  }

  specs(cwd?: string | null, opts?: { loaded?: Set<string>; deferThreshold?: number; deferExternals?: "count" | "always"; builtinDeferral?: boolean; mode?: Mode }): ToolSpec[] {
    const countActive = this.externalCountActive(cwd, opts?.deferThreshold, opts?.deferExternals);
    const builtinActive = opts?.builtinDeferral === true;
    const mode = opts?.mode;
    // ToolSearch is only useful while SOMETHING is deferred — an external tripped the count
    // trigger, or built-in deferral is on AND at least one registered def carries deferred:true
    // (builtin deferral on with nothing deferred has nothing for ToolSearch to load, so it stays
    // hidden exactly like the external-only case). Reuses isDeferred with countActive forced
    // false so externals never contribute here — only registered `deferred: true`/array built-ins
    // do, resolved against THIS `mode` (an array-valued def deferred only in another mode must not
    // make ToolSearch visible here).
    const anyBuiltinDeferred = builtinActive && [...this.defs.values()].some((d) => this.isDeferred(d, false, builtinActive, mode));
    const toolSearchVisible = countActive || anyBuiltinDeferred;
    return [...this.defs.values()]
      .filter((d) => !d.scope || (!!cwd && isWithin(cwd, d.scope)))
      .filter((d) => {
        if (d.name === "ToolSearch") return toolSearchVisible;
        if (!this.isDeferred(d, countActive, builtinActive, mode)) return true; // not deferred → always visible
        return opts?.loaded?.has(d.name) ?? false; // deferred → only loaded (or pinned-then-loaded) tools ride along
      })
      .map((d) => this.toSpec(d));
  }

  deferredIndex(
    cwd?: string | null,
    loaded?: Set<string>,
    deferThreshold?: number,
    builtinDeferral?: boolean,
    deferExternals?: "count" | "always",
    mode?: Mode,
  ): Array<{ name: string; description: string }> {
    const countActive = this.externalCountActive(cwd, deferThreshold, deferExternals);
    const builtinActive = builtinDeferral === true;
    if (!countActive && !builtinActive) return [];
    return [...this.defs.values()]
      .filter((d) => !d.scope || (!!cwd && isWithin(cwd, d.scope)))
      .filter((d) => this.isDeferred(d, countActive, builtinActive, mode))
      .filter((d) => !(loaded?.has(d.name) ?? false))
      .map((d) => ({ name: d.name, description: d.description.slice(0, 150) }));
  }

  /** Read-only: is `name` a registered built-in whose `deferred: true`/array is CURRENTLY active
   *  (builtinActive mirrors the engine's toolSearchEnabled() — the same flag threaded through
   *  specs()/execute() as ctx.builtinDeferral)? Delegates to the single isDeferred predicate with
   *  countActive forced false — externals (mcp__/plugin__) never ride this path, only registered
   *  `deferred: true`/array built-ins do — so this can never disagree with specs()/execute() about
   *  what is deferred right now. `mode` resolves an array-valued `deferred` exactly like every
   *  other isDeferred caller (absent → fail-closed deferred, per isDeferred's own doc comment).
   *  Exists for callers OUTSIDE execute(): the engine's dispatch loop needs to know, BEFORE running
   *  a bridge that intercepts a call ahead of execute() (the worktree/exit_plan_mode bridges),
   *  whether that call should be deferred-rejected instead — those bridges never reach execute()'s
   *  own check. Returns false for an unknown name (nothing to defer) — mirrors execute()'s own
   *  "unknown tool" handling, which is a separate error path. */
  isDeferredBuiltin(name: string, builtinActive: boolean, mode?: Mode): boolean {
    const def = this.defs.get(name);
    if (!def) return false;
    return this.isDeferred(def, false, builtinActive, mode);
  }

  specFor(name: string, cwd?: string | null): ToolSpec | undefined {
    const d = this.defs.get(name);
    if (!d || (d.scope && !(cwd && isWithin(cwd, d.scope)))) return undefined;
    return this.toSpec(d);
  }

  has(name: string): boolean { return this.defs.has(name); }

  /** Idempotent, never throws: true iff `name` was present and is now removed. No memoized/
   *  derived state to invalidate — specs()/isDeferred/deferredIndex all read `defs` live on every
   *  call (see externalCountActive, specs, deferredIndex above), so a def added or removed here is
   *  immediately reflected with no separate cache-busting step. */
  unregister(name: string): boolean { return this.defs.delete(name); }

  /** Removes every tool whose name starts with `prefix` — used by ipc/server.ts to unregister an
   *  entire plugin's `plugin__<id>__` tool set at once (on connection disconnect or the
   *  supervisor's circuit breaker opening) without the caller having to track individual tool
   *  names itself. A no-op (never throws) when nothing matches. */
  unregisterByPrefix(prefix: string): void {
    for (const name of this.defs.keys()) {
      if (name.startsWith(prefix)) this.defs.delete(name);
    }
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const def = this.defs.get(name);
    if (!def) return { output: `unknown tool: ${name}`, isError: true };
    const parsed = def.args.safeParse(rawArgs);
    if (!parsed.success) {
      return { output: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`, isError: true };
    }
    if (def.scope && !(ctx.cwd && isWithin(ctx.cwd, def.scope))) {
      return { output: `tool ${name} is not available in this directory`, isError: true };
    }
    const countActive = this.externalCountActive(ctx.cwd, ctx.deferThreshold, ctx.deferExternals);
    const builtinActive = ctx.builtinDeferral === true;
    if (this.isDeferred(def, countActive, builtinActive, ctx.mode) && !(ctx.loadedTools?.has(def.name) ?? false)) {
      return { output: `tool ${name} is deferred — load its schema via ToolSearch first`, isError: true };
    }
    try {
      let out = String(await def.run(parsed.data, ctx));
      if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n[truncated at ${MAX_OUTPUT} bytes]`;
      return { output: out, isError: false };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}
