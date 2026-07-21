import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_CODEX_MODEL } from "./providers/codex-config";
import { ensureGlobalGitignore, NORMA_PERSONAL_IGNORES } from "./global-gitignore";

/** Reasoning-effort slugs — the live /models payload (2026-07-10) lists exactly these across
 *  the gpt-5.6 family (luna lacks "ultra", but validating per-model effort support is NOT done
 *  here — the backend rejects unsupported combos itself; this enum is the full universe). */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const ProviderSettings = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex-oauth"), model: z.string().min(1), reasoningEffort: z.enum(REASONING_EFFORTS).optional() }),
  z.object({ type: z.literal("openai-compatible"), model: z.string().min(1), baseUrl: z.string().url(), reasoningEffort: z.enum(REASONING_EFFORTS).optional() }),
]);

export const PermissionsSettings = z.object({
  additionalDirectories: z.array(z.string()).optional(),
  /** CC-grammar allow-rules (SP-approvals T1, `agent/permission-rules.ts`'s `PermissionRules`
   *  class) — global-scope rule strings like `"Bash(git push:*)"`/`"Edit"`/`"Computer"`. Additive
   *  optional key: schemaVersion stays 2, no migration needed. Absent means "no global rules
   *  configured here"; the CC-parity `["Computer"]` default is NOT this field's default — it is
   *  applied by the daemon's OWN getter fallback (Task 3), so an explicit `"allow": []` can
   *  disable that default outright. */
  allow: z.array(z.string()).optional(),
  /** SP-approvals T10 (spec §7 "Web tools"): user-added dangerous-domain entries — the effective
   *  set web_fetch's pre-exec floor checks against is `agent/dangerous-domains.ts`'s
   *  SHIPPED_DANGEROUS_DOMAINS ∪ this array. Additive optional key: schemaVersion stays 2, no
   *  migration needed. Absent (or `added` absent) means "no user additions" — the shipped list
   *  alone is still enforced. Removing an entry HERE is how a user-added domain is removed; the
   *  shipped list itself is immutable by construction (there is no equivalent of `allow: []`'s
   *  "opt out of a default" for it — a shipped entry can never be deleted this way). */
  dangerousDomains: z.object({
    added: z.array(z.string()).optional(),
  }).optional(),
});

export const Settings = z.object({
  schemaVersion: z.literal(2),
  provider: ProviderSettings,
  permissions: PermissionsSettings.optional(),
  mcpServers: z.record(z.string(), z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    allow: z.array(z.string()).optional(),
    // Phase 5e T4: per-class on/off, subordinate to `enabled` — an `enabled:false` reviewer
    // never runs regardless of what's set here (engine.ts ANDs reviewerEnabled with
    // reviewClassEnabled at every call site). Absent block OR an absent per-class key means
    // enabled — same optional-means-default-true shape as engine.ts's own reviewClassEnabled.
    classes: z.object({
      bash: z.boolean().optional(),
      fs: z.boolean().optional(),
      external: z.boolean().optional(),
    }).optional(),
  }).optional(),
  titles: z.object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
  }).optional(),
  plugins: z.object({
    enabled: z.array(z.string()).optional(),
    disabled: z.array(z.string()).optional(),
    /** Per-plugin per-permission-class consent records (design spec §1): { [pluginId]: { exec?:
     *  ts, tcc?: ts, hardware?: ts } }, timestamp = Date.now() at grant time. A class's presence
     *  (not its value) is what counts as consented — see plugins.ts#consentComplete. `disable`
     *  deletes a plugin's whole record (fresh-consent semantics, generalized from today's
     *  enabled-strip). */
    consents: z.record(z.string(), z.object({
      exec: z.number().optional(),
      tcc: z.number().optional(),
      hardware: z.number().optional(),
    })).optional(),
    /** PluginSupervisor lifecycle overrides (Phase 4b Task 3, spec §3 — all four values are
     *  spec-defaulted when omitted: registration timeout 10s, backoff cap 60s, circuit 5
     *  failures/10min). The invoke timeout (default 60s) and the SIGTERM→SIGKILL kill grace (5s)
     *  are deliberately NOT here — spec pins the former to the `NORMA_PLUGIN_TOOL_TIMEOUT_MS` env
     *  var and the latter isn't settings-overridable at all. */
    supervisor: z.object({
      registrationTimeoutMs: z.number().int().positive().optional(),
      backoffCapMs: z.number().int().positive().optional(),
      circuitFailures: z.number().int().positive().optional(),
      circuitWindowMs: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
  toolSearch: z.object({
    enabled: z.boolean().optional(),
    deferThreshold: z.number().int().positive().optional(),
    // "always": externals (mcp__/plugin__) defer whenever ANY is visible, ignoring deferThreshold's
    // count comparison entirely. Absent/"count" = today's threshold-count behavior, unchanged.
    deferExternals: z.enum(["count", "always"]).optional(),
  }).optional(),
  worktree: z.object({
    baseRef: z.enum(["fresh", "head"]).optional(),
  }).optional(),
  subagents: z.object({
    maxConcurrent: z.number().int().positive().optional(),
    // 4h-i Task 3 (CC parity: nesting depth up to 5): how many levels of spawn_agent nesting are
    // allowed — a thread at depth < maxDepth may spawn a child; a thread AT maxDepth cannot.
    // Default 5 when unset (engine.ts's `subagentMaxDepth ?? 5`) — matches Claude Code's fixed
    // max nesting depth of 5 (user decision 2026-07-11: "whatever Claude Code does"). Lower it
    // (e.g. `maxDepth: 1`, the pre-4h-i behavior where a depth-1 child could never spawn further)
    // to restrict nesting. Concurrency (maxConcurrent, default 4) and total fan-out are separate:
    // total spawns per session are UNLIMITED by design (user decision), bounded only by the
    // concurrency semaphore at any instant.
    // CC itself allows depth 5, hence the upper bound here.
    maxDepth: z.number().int().min(1).max(5).optional(),
    /** No-timeout task (user rule 2026-07-12): an EXPLICIT wall-clock cap per subagent run, in
     *  ms. ABSENT (the default) means NO wall clock at all — subagents are never killed just for
     *  running long (a legitimate laptop-wide scan died at the old always-on 300s cap; CC has no
     *  wall-clock subagent timeout either). Hot: read via a live getter (daemon.ts) — an edit
     *  applies to the very next subagent run, no daemon restart. */
    timeoutMs: z.number().int().positive().optional(),
    /** No-timeout task: the progress-STALL watchdog window, in ms — a subagent whose provider
     *  stream produces NO events for this long is aborted as stalled (its partial output is
     *  surfaced to the parent). ABSENT means the default 600000 (10 min — deliberately ≥ bash's
     *  own max per-call timeout, so a tool-bounded silent bash never falsely trips it; env
     *  override: NORMA_SUBAGENT_STALL_TIMEOUT_MS). Hot, same live-getter semantics as timeoutMs
     *  above. */
    stallTimeoutMs: z.number().int().positive().optional(),
  }).optional(),
  /** Peripheral lease v1 (Phase 2f, spec §A1): "Heartbeat 5s / expiry 15s (user-confirmed;
   *  settings-overridable peripheral.heartbeatMs/expiryMs)". Both optional — PeripheralBroker
   *  falls back to the spec defaults (5000/15000) when omitted. */
  peripheral: z.object({
    heartbeatMs: z.number().int().positive().optional(),
    expiryMs: z.number().int().positive().optional(),
  }).optional(),
  /** Computer use (Phase 5 CU). `enabled` is the capability opt-in: the `computer` tool is
   *  registered ONLY when true (the strongest reading of "full-auto CU requires explicit opt-in" —
   *  absent/false means CU does not exist for the session). `screenshotMaxDim` caps the longest
   *  side of a captured screenshot (default 1280, Norma.app-side) to bound the base64 payload well
   *  under the NDJSON line limit and the model's image budget. The lease heartbeat/expiry reuse the
   *  `peripheral` block above. */
  computerUse: z.object({
    enabled: z.boolean().optional(),
    screenshotMaxDim: z.number().int().positive().optional(),
  }).optional(),
  /** web_search backend (4g Task 6). `provider` defaults to "brave" when the block/field is
   *  absent — the literal union is forward-room for other search backends later; today "brave"
   *  is the only accepted value. */
  webSearch: z.object({
    provider: z.literal("brave").optional(),
  }).optional(),
  /** Plugin hooks runtime (Phase 4f, plan Global Constraints: "default true, read like other hot
   *  settings"). `enabled: undefined` (block absent OR field absent) means ENABLED — see
   *  `hooksEnabledFrom` below, the single place that decision is made. */
  hooks: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  /** Scheduled routines (Phase 5, design doc header — USER-DECIDED pin: "routines run in
   *  PARALLEL ... routines.maxConcurrent? settings knob, default unlimited"). Undefined (block or
   *  field absent) means unlimited — mirrors subagents.maxConcurrent's own optional-means-default
   *  shape above, read once at daemon boot (same boot-snapshot precedent as subagents.maxConcurrent,
   *  not hot-reloaded — routines/scheduler.ts's makeRoutineScheduler takes it as a `() => number |
   *  undefined` thunk purely to match its own injectable-dependency shape, not because this needs
   *  to change without a daemon restart). */
  routines: z.object({
    maxConcurrent: z.number().int().positive().optional(),
  }).optional(),
  /** LSP integration (Phase 5f; consolidated into the single `lsp` tool by lsp-consolidation T2,
   *  design doc `2026-07-15-lsp-consolidation-design.md`) over a lazily-spawned
   *  typescript-language-server/sourcekit-lsp. `enabled` is default-ON, the SAME boot-snapshot
   *  shape as `reviewer.enabled`/`titles.enabled` above (an explicit `false` is the only way to
   *  turn it off; block absent, field absent, or `true` all mean the `lsp` tool gets registered —
   *  daemon.ts's registerLspTools gate reads `settings?.lsp?.enabled !== false`).
   *  When off, the tool is never registered, so a model's query for it is the registry's
   *  ordinary "unknown tool" error — no special-cased denial path. `idleShutdownMs` threads
   *  straight into `new LspManager({idleShutdownMs})`; absent means the manager's own default
   *  (300_000 — 5 min, agent/lsp/manager.ts's DEFAULT_SCHEDULER-adjacent constant).
   *  `autoDiagnostics` (lsp-consolidation T3, design doc §2 — CC parity: "after each file edit, it
   *  automatically reports type errors and warnings so Claude can fix issues without a separate
   *  build step") is ALSO default-ON, same `!== false` shape — see `lspAutoDiagnosticsEnabledFrom`
   *  below, the one place that decision is made. Read LIVE (hot, per
   *  [[no-daemon-restart-for-settings]]) by engine.ts's post-write/edit/notebook_edit hook — a
   *  toggle applies to the session's NEXT edit, no restart. Independent of `enabled`: turning THIS
   *  off still leaves the on-demand `lsp` tool (action: diagnostics) usable; only the automatic
   *  post-edit append is skipped. */
  lsp: z.object({
    enabled: z.boolean().optional(),
    idleShutdownMs: z.number().int().positive().optional(),
    autoDiagnostics: z.boolean().optional(),
  }).optional(),
  /** Auto-update channel. "beta" additionally receives beta-tagged appcast items;
   *  absent/stable = stable only. Read live by the app at each update check (hot — no restart). */
  updates: z
    .object({
      channel: z.enum(["stable", "beta"]).optional(),
    })
    .optional(),
  /** File-based memory (MEMDIR, T1 — design doc `2026-07-15-file-based-memory-design.md`).
   *  `enabled` default-ON, the SAME `!== false` boot-snapshot-shaped default as `lsp.enabled`/
   *  `hooks.enabled` above, but read LIVE (hot, per [[no-daemon-restart-for-settings]]) by both
   *  daemon.ts's write-root join and context.ts's injection — a toggle takes effect on the
   *  session's NEXT tool call / turn, no restart. `directory` (absolute or `~/`-relative) replaces
   *  the computed `~/.norma/projects/<key>/memory` path entirely (CC's own relocatable-directory
   *  setting) — see memory-dir.ts's `memoryDirFor`. */
  memory: z
    .object({
      enabled: z.boolean().optional(),
      directory: z.string().optional(),
    })
    .optional(),
});
export type Settings = z.infer<typeof Settings>;

/** The one place `hooks.enabled`'s default-ON semantics live (4f Task 2): absent block, absent
 *  field, or `enabled: true` all mean hooks run; only an explicit `false` turns them off. Kept as
 *  a pure `Settings -> boolean` helper (not inlined at each call site) so both the daemon's hot
 *  settings-reader (daemon.ts, re-reads settings.json per call, mtime-cached — same pattern as
 *  providers/manager.ts's `liveModel`) and this file's own tests exercise the SAME decision. */
export const hooksEnabledFrom = (s: Settings): boolean => s.hooks?.enabled !== false;

/** Same default-ON shape as `hooksEnabledFrom` above: absent block, absent field, or `true` all
 *  mean file-based memory is on; only an explicit `false` turns it off. The single place this
 *  decision is made — daemon.ts's write-root join and context.ts's injection gate both call this
 *  (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const memoryEnabledFrom = (s: Settings): boolean => s.memory?.enabled !== false;

/** Same default-ON shape as `memoryEnabledFrom`/`hooksEnabledFrom` above: absent block, absent
 *  field, or `true` all mean auto-diagnostics-after-edit is on; only an explicit `false` turns it
 *  off. The single place THIS decision is made — engine.ts's post-write/edit/notebook_edit hook
 *  calls this (via a live getter over the `settings` holder) rather than re-deriving it inline. */
export const lspAutoDiagnosticsEnabledFrom = (s: Settings): boolean => s.lsp?.autoDiagnostics !== false;

// gpt-5.4 was the pre-deprecation default; fully deprecated per the 2026-07-10 user decision
// (packages/core/src/providers/codex-config.ts) — a fresh v1→v2 migration must not persist a
// dead slug to disk, so this points at the current default instead.
const DEFAULT_PROVIDER = { type: "codex-oauth", model: DEFAULT_CODEX_MODEL } as const;

export function loadSettings(path: string): Settings {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`settings file not found at ${path} — run \`norma daemon run\` once to initialize`);
    }
    throw err;
  }
  if (raw.schemaVersion !== 2) {
    // v1-or-legacy file (Phase 0 wrote {schemaVersion:1}; the retired v1 app wrote files with
    // no schemaVersion at all — same directory on case-insensitive APFS). Migrate to v2,
    // preserving unknown fields so nothing is silently lost.
    const { schemaVersion: _legacy, ...preserved } = raw;
    const migrated = { ...preserved, schemaVersion: 2 as const, provider: DEFAULT_PROVIDER };
    writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n");
    // zod v4 z.object() strips unknown keys by default (does NOT throw) — safe to parse migrated
    return Settings.parse(migrated);
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`settings.json is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")} — fix or delete ${path}`);
  }
  return parsed.data;
}

export function saveSettings(path: string, s: Settings): void {
  Settings.parse(s); // validate before writing — never persist an invalid settings file
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
}

/** Parse a settings file to a raw object for OVERLAY merging (no zod, no migration) — absent/torn → null. */
export function readRawSettings(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** Pure `Settings -> Settings` provider-model transform (mirrors plugins/lifecycle.ts's
 *  `setPluginEnabled` pattern) — used by `norma model <slug>`. Preserves every other field,
 *  including `provider.reasoningEffort` if set. Validation (codex-oauth slug membership,
 *  non-empty for openai-compatible) is the CALLER's job — this never throws on the slug itself,
 *  only on whatever Settings.parse would already reject (e.g. an empty string, caught by the
 *  schema's `z.string().min(1)`). */
export function setProviderModel(settings: Settings, model: string): Settings {
  return { ...settings, provider: { ...settings.provider, model } };
}

/** Pure `Settings -> Settings` reasoning-effort transform — used by `norma model --effort
 *  <level>` (effort-only or combined with a model change). `effort: undefined` clears it. */
export function setReasoningEffort(settings: Settings, effort: (typeof REASONING_EFFORTS)[number] | undefined): Settings {
  return { ...settings, provider: { ...settings.provider, reasoningEffort: effort } };
}

function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

function readDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const dirs = raw?.permissions?.additionalDirectories;
    return Array.isArray(dirs) ? dirs.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Merge additionalDirectories across scopes (Claude-Code-style). The COMMITTED
 * <projectDir>/.norma/settings.json is honored ONLY when `projectTrusted` — a repo
 * can't silently widen the fence until the user trusts the folder. The user's
 * ~/.norma/settings.json and the gitignored settings.local.json are always honored.
 */
export function loadPermissionDirs(homeDir: string, projectDir?: string, projectTrusted = false): string[] {
  const sources = [join(homeDir, "settings.json")]; // user global — always
  if (projectDir) {
    if (projectTrusted) sources.push(join(projectDir, ".norma", "settings.json")); // committed — trust-gated
    sources.push(join(projectDir, ".norma", "settings.local.json")); // local, gitignored — always
  }
  const merged: string[] = [];
  for (const src of sources) {
    for (const d of readDirs(src)) {
      const e = expandTilde(d);
      if (!merged.includes(e)) merged.push(e);
    }
  }
  return merged;
}

/** Persist a runtime-granted directory to the project's local (gitignored) settings. */
export function addLocalDir(projectDir: string, dir: string): void {
  const dotNorma = join(projectDir, ".norma");
  mkdirSync(dotNorma, { recursive: true });
  const path = join(dotNorma, "settings.local.json");
  let obj: any = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj.permissions ??= {};
  obj.permissions.additionalDirectories ??= [];
  if (!obj.permissions.additionalDirectories.includes(dir)) obj.permissions.additionalDirectories.push(dir);
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  ensureGlobalGitignore(NORMA_PERSONAL_IGNORES);
}
