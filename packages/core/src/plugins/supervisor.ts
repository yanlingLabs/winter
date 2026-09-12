import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewSessionEvent } from "@winter/protocol";

/**
 * PluginSupervisor — process lifecycle for Tier-2 (`platform`) plugins (design spec §3, plan
 * Phase 4b Task 3). Spawns the manifest `entry` for every eligible plugin, enforces a
 * registration timeout, restarts crashed processes with exponential backoff, opens a circuit
 * breaker after repeated failures, reclaims orphaned processes left behind by a previous core
 * process (PID files under `<runDir>/plugins/<id>.pid`), and brokers `tool.invoke` request/
 * response correlation over the plugin's own connection — mirroring `PeripheralBroker`
 * (`peripheral/broker.ts`) call/respond shape almost verbatim (pending map, timeout race,
 * delete-then-resolve, typed results that never throw).
 *
 * Every public method is synchronous-or-Promise, never throws, and never touches Date.now()/
 * setTimeout's real wall clock for anything a test needs to assert exactly — `now()` is
 * injectable (circuit-window math is a pure, directly-testable function, same discipline as
 * broker.ts's `expiredLeases`) and `spawn()` is injectable (tests never touch a real OS process).
 * Registration/backoff/orphan timers are real `setTimeout`s (unref'd) so a hung timer never keeps
 * the daemon process alive — their DURATIONS are settings-overridable so tests can use short
 * values instead of waiting out real seconds; the one thing that can't be waited out in a test
 * (a full 1s·2ⁿ…60s backoff schedule) is exposed as the pure `backoffDelayMs` for exact-value
 * assertions, same reasoning.
 */

// -------------------------------------------------------------------------------------------
// Pure decision helpers — no clock, no I/O, no timers. Directly table-tested (broker.ts's
// leaseDecision/expiredLeases precedent).
// -------------------------------------------------------------------------------------------

/** 1s·2ⁿ capped at `capMs` (spec: "restart with exponential backoff 1s·2ⁿ capped 60s"). `attempt`
 *  is 0-indexed (the first failure's restart delay is `backoffDelayMs(0, cap)` = 1000ms). The
 *  base (1000ms) is spec-fixed, not settings-overridable — only the cap is. */
export function backoffDelayMs(attempt: number, capMs: number): number {
  return Math.min(1000 * 2 ** attempt, capMs);
}

/** Appends a failure at `nowMs` to `failures`, drops entries older than `windowMs` (relative to
 *  `nowMs`), and reports whether the pruned count has reached `threshold` (spec: "circuit-open
 *  after 5 failures in 10 min"). Pruning-before-open means failures outside the rolling window
 *  never count toward it — a plugin that crashed 4 times an hour ago and once just now has 1
 *  failure in the window, not 5. Pure: never reads a clock itself, so tests drive it with
 *  fabricated timestamps exactly like broker.ts's `expiredLeases`. */
export function circuitAfterFailure(
  failures: number[],
  nowMs: number,
  windowMs: number,
  threshold: number,
): { failures: number[]; open: boolean } {
  const pruned = failures.filter((t) => nowMs - t < windowMs);
  pruned.push(nowMs);
  return { failures: pruned, open: pruned.length >= threshold };
}

// -------------------------------------------------------------------------------------------
// Injectable spawn / process-signal seams.
// -------------------------------------------------------------------------------------------

/** Structural subset of `Bun.Subprocess` the supervisor actually needs — real `Bun.spawn(...)`
 *  satisfies this directly (pid/kill/exited match exactly); tests inject a fake that never
 *  touches the OS. */
export interface SupervisedProcess {
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
  readonly exited: Promise<number>;
}

export type SpawnFn = (cmd: string[], opts: { cwd: string; env: Record<string, string> }) => SupervisedProcess;

function defaultSpawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): SupervisedProcess {
  return Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

/** `process.kill(pid, 0)` liveness probe / real `process.kill(pid, signal)` — the ONLY reason
 *  these are injectable (rather than called directly, as `agent/bg-registry.ts` does) is orphan
 *  reclaim: a "live PID" test needs a PID that's REALLY alive (so it writes its own `process.pid`
 *  to the fixture) without the supervisor ever being allowed to send it a real SIGTERM/SIGKILL —
 *  that would kill the test runner. Production always uses the real defaults below. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/** `ps -o lstart= -p <pid>` — the process's exact start timestamp string, or `null` if `ps`
 *  errors/is unavailable or reports nothing for that pid (process gone, or a sandboxed/odd
 *  environment without a working `ps`). This is the ONLY identity signal available without a
 *  platform-specific "process start time" syscall (macOS gives no cheap owner/identity check) —
 *  see `reclaimOrphans`'s doc comment for why every caller of this MUST fail safe (never signal) on
 *  a `null` result rather than assume liveness implies identity. */
function defaultProcessStartedAt(pid: number): string | null {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    if (result.exitCode !== 0) return null;
    const out = result.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Public types.
// -------------------------------------------------------------------------------------------

/** The daemon-computed spawn config for one consented, spawn-eligible platform plugin
 *  (agent/plugins.ts#pluginSpawnEligible). `dir` is the plugin's directory (default cwd);
 *  `entry.cwd`, when set, is resolved relative to `dir`. */
export interface EligiblePlugin {
  id: string;
  dir: string;
  entry: { command: string; args?: string[]; cwd?: string };
}

/** What a plugin connection needs to expose to the supervisor: push a transient event to it.
 *  Mirrors `PeripheralBrokerDeps.pushToProvider`'s per-connection push shape. Task 4 adapts a real
 *  ipc connection to this; this task's tests use a bare `{ push(event) { ...; return true } }`. */
export interface PluginConn {
  push(event: NewSessionEvent): boolean;
}

export type InvokeError =
  | { code: "not_running" }
  | { code: "no_connection" }
  | { code: "timeout" }
  | { code: "crashed"; message: string }
  | { code: "plugin_error"; message: string };
export type InvokeResult = { ok: true; resultJson: string } | InvokeError;

export type SupervisorStatus = "starting" | "running" | "backoff" | "circuit-open" | "stopped";

/** `plugins.supervisor.{registrationTimeoutMs,backoffCapMs,circuitFailures,circuitWindowMs}`
 *  (settings.ts) plus two constructor-only test-injection seams that are deliberately NOT part of
 *  settings.json: `invokeTimeoutMs` (spec: env-var only, `WINTER_PLUGIN_TOOL_TIMEOUT_MS`) and
 *  `killGraceMs` (spec-fixed 5s SIGTERM→SIGKILL grace, not settings-overridable at all). */
export interface PluginSupervisorSettings {
  registrationTimeoutMs?: number;
  backoffCapMs?: number;
  circuitFailures?: number;
  circuitWindowMs?: number;
  invokeTimeoutMs?: number;
  killGraceMs?: number;
}

export interface PluginSupervisorDeps {
  /** Injectable Bun.spawn — defaults to real `Bun.spawn`. */
  spawn?: SpawnFn;
  /** Injectable clock — defaults to `Date.now`. Every lifecycle decision (backoff delay math,
   *  circuit-window pruning) reads time through this, never `Date.now()` directly. */
  now?: () => number;
  /** `~/.winter/run` (winter-dir.ts's `dirs.runDir`) — PID files live at `<runDir>/plugins/<id>.pid`. */
  runDir: string;
  /** `WINTER_SOCKET` value handed to every spawned plugin process. */
  socketPath: string;
  /** Daemon-side lazy mint (`SessionStore#mintPluginToken`), called fresh right before every
   *  spawn (including restarts) — re-minting rotates the token each time, which is fine (the old
   *  token simply stops verifying once the new hash is written). Injected so tests don't need a
   *  real SessionStore. */
  mintToken: (pluginId: string) => string;
  settings?: PluginSupervisorSettings;
  onLog?: (m: string) => void;
  /** Called synchronously right after a plugin's circuit breaker opens (status transitions to
   *  "circuit-open" — 5 failures in the rolling window, spec §3). Task 4's ipc/server.ts owns the
   *  ToolRegistry, not this class, so it can't unregister that plugin's `plugin__<id>__*` tools
   *  itself — the daemon wires this callback (built alongside `deps.onLog` above, in the SAME
   *  deps object literal `new PluginSupervisor(...)` closes over) to do exactly that. Optional:
   *  tests that don't care about tool-registry cleanup never need to set it. A disconnect that
   *  does NOT trip the circuit is NOT covered by this hook — that path is ipc/server.ts's socket
   *  `close()` handler, which unregisters unconditionally on every plugin disconnect regardless of
   *  supervisor status. */
  onCircuitOpen?: (pluginId: string) => void;
  /** Testability seams — see `defaultIsAlive`/`defaultSignal` above. Real OS semantics by default;
   *  never need overriding outside tests. */
  isAlivePid?: (pid: number) => boolean;
  signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  /** Testability seam for PID-reuse identity verification — see `defaultProcessStartedAt` above.
   *  Real `ps` semantics by default; tests inject a fake so they never shell out. */
  processStartedAt?: (pid: number) => string | null;
}

/** On-disk shape of `<runDir>/plugins/<id>.pid` since the PID-reuse hardening fix: identity-
 *  bearing, not a bare PID. `startedAt` (from `processStartedAt`/`ps -o lstart=`) is what lets
 *  `reclaimOrphans` tell "this live PID is really our plugin" apart from "the OS recycled this PID
 *  to an unrelated process after a core crash" — see that method's doc comment. `null` means the
 *  supervisor itself couldn't read a start time at spawn time (e.g. `ps` raced the just-spawned
 *  process); such a file can never be verified later either, by design (see reclaim's fail-safe
 *  handling of a `null` recorded `startedAt`). */
interface PidFileContents {
  pid: number;
  pluginId: string;
  startedAt: string | null;
}

/** Parses `<id>.pid` file contents written either by this fix (JSON `PidFileContents`) or by a
 *  pre-fix core (a bare PID integer, e.g. `"12345"`) or anything unreadable. Bare-PID and
 *  unreadable content both come back with `startedAt: null` — the caller (`reclaimOrphans`)
 *  treats a `null` recorded `startedAt` as unverifiable and never adopts/signals it, which is
 *  exactly the fail-safe legacy-format handling this hardening fix requires. Returns `null` only
 *  when there isn't even a plausible PID to report (nothing to reclaim OR clean up as "ours"). */
function parsePidFile(raw: string): PidFileContents | null {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed) as Partial<PidFileContents>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        pluginId: typeof parsed.pluginId === "string" ? parsed.pluginId : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      };
    }
    return null; // valid JSON but not a plausible PID file — corrupt, nothing to trust
  } catch {
    // Not JSON — either a pre-fix bare-PID file or garbage. A bare positive integer is the
    // legacy format: tolerate it as an unverifiable PID (startedAt: null), never as anything more.
    const pid = Number(trimmed);
    if (Number.isInteger(pid) && pid > 0 && /^\d+$/.test(trimmed)) {
      return { pid, pluginId: "", startedAt: null };
    }
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Internal runtime bookkeeping.
// -------------------------------------------------------------------------------------------

interface PendingInvoke {
  pluginId: string;
  tool: string;
  resolve: (r: InvokeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PluginRuntime {
  config: EligiblePlugin;
  status: SupervisorStatus;
  proc?: SupervisedProcess;
  pid?: number;
  conn?: PluginConn;
  /** Whichever single timer is currently armed for this runtime — registration timeout, backoff
   *  restart, or orphan re-registration window (mutually exclusive: at most one is ever pending). */
  timer?: ReturnType<typeof setTimeout>;
  /** Failure timestamps within the circuit-breaker's rolling window (circuitAfterFailure prunes
   *  it on every new failure) — NOT reset by a successful registration; only `attempt` is. A
   *  flaky plugin that restarts successfully but keeps re-crashing still trips the circuit. */
  failures: number[];
  /** Backoff exponent — bumped on every failure, reset to 0 only by a successful registration
   *  (`notifyRegistered`) or a manual `restart()`. */
  attempt: number;
  /** Bumped once per spawn attempt (spawnFresh) or orphan-adopt (reclaimOrphans). Registration-
   *  timeout timers and `proc.exited` callbacks close over the generation they were armed for and
   *  no-op if it's no longer current — the guard against a stale callback from a superseded
   *  attempt firing after a NEWER attempt has already started (e.g. a killed process's `exited`
   *  promise resolving well after backoff already respawned it). */
  generation: number;
  /** The last generation `failAttempt` has already processed — combined with `generation` above,
   *  makes "this attempt has already been handled" idempotent regardless of which of (registration
   *  timeout, orphan-window timeout, spontaneous exit, notifyDisconnected) fires first. 0 is a
   *  sentinel that never matches a real generation (generations start at 1). */
  settledGeneration: number;
}

// -------------------------------------------------------------------------------------------
// PluginSupervisor.
// -------------------------------------------------------------------------------------------

export class PluginSupervisor {
  private runtimes = new Map<string, PluginRuntime>();
  private pending = new Map<string, PendingInvoke>();

  private readonly spawnFn: SpawnFn;
  private readonly nowFn: () => number;
  private readonly isAliveFn: (pid: number) => boolean;
  private readonly signalFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly processStartedAtFn: (pid: number) => string | null;

  private readonly registrationTimeoutMs: number;
  private readonly backoffCapMs: number;
  private readonly circuitFailures: number;
  private readonly circuitWindowMs: number;
  private readonly invokeTimeoutMs: number;
  private readonly killGraceMs: number;

  constructor(private readonly deps: PluginSupervisorDeps) {
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.nowFn = deps.now ?? Date.now;
    this.isAliveFn = deps.isAlivePid ?? defaultIsAlive;
    this.signalFn = deps.signalPid ?? defaultSignal;
    this.processStartedAtFn = deps.processStartedAt ?? defaultProcessStartedAt;

    this.registrationTimeoutMs = deps.settings?.registrationTimeoutMs ?? 10_000;
    this.backoffCapMs = deps.settings?.backoffCapMs ?? 60_000;
    this.circuitFailures = deps.settings?.circuitFailures ?? 5;
    this.circuitWindowMs = deps.settings?.circuitWindowMs ?? 10 * 60_000;
    this.invokeTimeoutMs = deps.settings?.invokeTimeoutMs ?? Number(process.env.WINTER_PLUGIN_TOOL_TIMEOUT_MS ?? 60_000);
    this.killGraceMs = deps.settings?.killGraceMs ?? 5_000;
  }

  // -----------------------------------------------------------------------------------------
  // Boot / shutdown.
  // -----------------------------------------------------------------------------------------

  /** Spawns every plugin not already tracked (idempotent against repeat calls). Orphan reclaim
   *  runs FIRST (`reclaimOrphans`), for the SAME list — a plugin whose PID file names a still-live
   *  process is adopted into the re-registration window instead of being spawned a second time. */
  startAll(plugins: EligiblePlugin[]): void {
    this.reclaimOrphans(plugins);
    for (const config of plugins) {
      if (this.runtimes.has(config.id)) continue;
      this.spawnFresh(config);
    }
  }

  /** Shared read-pidfile → parse → alive-check → lstart-identity-verify ladder — the common core
   *  of `reclaimOrphans` (adopts a verified orphan) and `sweepOrphans` (terminates one), extracted
   *  so the two verification ladders (previously ~45 near-identical lines each) can't drift apart.
   *  Every failure mode along the way is a fail-safe "clean up the stale/corrupt/unverifiable PID
   *  file, never signal a PID we can't positively identify as ours" — see `reclaimOrphans`'s
   *  PID-REUSE HARDENING note below for why. `logPrefix` is folded into the log line only, so each
   *  call site's existing log text stays byte-identical (`reclaimOrphans` passes `""`; `sweepOrphans`
   *  passes `"sweepOrphans — "`, matching what each already logged before this refactor) — this is
   *  a pure extraction, not a behavior change.
   *
   *  Returns:
   *   - `"skip"` — no PID file on disk at all; nothing to reclaim or sweep, nothing logged (matches
   *     both original bare `continue`s on a `readFileSync` failure).
   *   - `"cleaned"` — a PID file existed but failed verification (corrupt, dead, unverifiable, or a
   *     start-time mismatch); already removed via `removePidFile`, reason already logged.
   *   - `{ pid }` — genuinely verified: same pid, same recorded start time as the live process. The
   *     PID file is left ON DISK either way — the caller decides its fate (`reclaimOrphans` adopts
   *     the running process and keeps tracking it, never touching the file; `sweepOrphans`
   *     terminates the process and removes the file itself), exactly as each did before this
   *     extraction. */
  private verifyOrphan(id: string, logPrefix: string): { pid: number } | "cleaned" | "skip" {
    let raw: string;
    try {
      raw = readFileSync(this.pidFilePath(id), "utf8");
    } catch {
      return "skip"; // no PID file on disk — nothing to reclaim/sweep
    }

    const parsed = parsePidFile(raw);
    if (!parsed) {
      this.removePidFile(id);
      this.log(`plugin ${id}: ${logPrefix}unreadable/corrupt PID file removed (fail-safe, no signal sent)`);
      return "cleaned";
    }
    const { pid } = parsed;

    if (!this.isAliveFn(pid)) {
      this.removePidFile(id);
      this.log(`plugin ${id}: ${logPrefix}stale PID file removed (pid ${pid} not alive)`);
      return "cleaned";
    }

    // Live PID — but liveness alone never proves identity (PID reuse). Verify start time.
    const actualStartedAt = this.processStartedAtFn(pid);
    if (parsed.startedAt === null) {
      // Legacy bare-PID file (pre-fix) or a JSON file this core itself failed to stamp at spawn
      // time — unverifiable either way. Fail safe: never signal a PID we can't confirm is ours.
      this.removePidFile(id);
      this.log(`plugin ${id}: ${logPrefix}pid ${pid} is alive but unverifiable (no recorded start time — legacy/corrupt PID file) — removed without signalling (fail-safe)`);
      return "cleaned";
    }
    if (actualStartedAt === null) {
      // Can't read the live process's start time right now (ps unavailable/erroring) — no basis
      // for comparison, so don't guess. Fail safe: never signal.
      this.removePidFile(id);
      this.log(`plugin ${id}: ${logPrefix}cannot verify pid ${pid} identity (start-time check unavailable) — removed without signalling (fail-safe)`);
      return "cleaned";
    }
    if (actualStartedAt !== parsed.startedAt) {
      // Recorded vs. actual start time mismatch — the OS almost certainly recycled this PID to
      // an unrelated process since our plugin last ran. Never signal it.
      this.removePidFile(id);
      this.log(`plugin ${id}: ${logPrefix}pid ${pid} start time mismatch (recorded "${parsed.startedAt}", actual "${actualStartedAt}") — PID reuse suspected, removed without signalling`);
      return "cleaned";
    }

    // Verified: same pid, same recorded start time as the live process — this is genuinely our
    // orphaned plugin process.
    return { pid };
  }

  /** Boot-time orphan reclaim (design spec §3): for each plugin, if `<runDir>/plugins/<id>.pid`
   *  names a still-alive process that VERIFIES as the same process we spawned, adopt it into a
   *  "starting" runtime and give it the SAME re-registration window a fresh spawn gets
   *  (`registrationTimeoutMs`) before killing it (SIGTERM → `killGraceMs` → SIGKILL) and falling
   *  through to the normal failure/backoff path. A dead or unreadable PID file is just cleaned up
   *  — the plugin gets a fresh spawn via `startAll`'s own loop, which skips anything this method
   *  has already claimed.
   *
   *  PID-REUSE HARDENING: a bare "live PID" is NOT sufficient grounds to signal it. After a core
   *  crash, the recorded PID may since have been recycled by the OS to a completely unrelated
   *  process — signalling it on a failed re-registration would kill an innocent process. Identity
   *  is therefore verified before EVER adopting (and thus before this plugin can ever be signalled
   *  later): the on-disk file is per-plugin (`<id>.pid`, so `pluginId` is implicit) AND its
   *  `startedAt` (captured via `processStartedAt`/`ps -o lstart=` at spawn time) must match the
   *  live process's ACTUAL start time. macOS gives no cheaper owner/identity check than this. Any
   *  of the following makes the PID unverifiable, and the file is cleaned up WITHOUT adopting or
   *  signalling anything (fail-safe, never a false-positive kill):
   *    - the file predates this fix (bare-PID legacy format — `parsePidFile` reports `startedAt:
   *      null`) or is otherwise corrupt/unreadable;
   *    - `processStartedAt` can't read a start time for the live PID right now (`ps` unavailable/
   *      erroring in this environment) — we simply have no way to check, so we don't guess;
   *    - the recorded and actual start times don't match — the PID was almost certainly reused.
   *
   *  Public (not just an internal step of `startAll`) because "orphan reclaim paths" is its own
   *  TDD area per the plan — tests exercise it directly against a fabricated PID file without
   *  paying for a full `startAll` fresh-spawn pass over unrelated plugins. */
  reclaimOrphans(plugins: EligiblePlugin[]): void {
    for (const config of plugins) {
      if (this.runtimes.has(config.id)) continue;

      const verified = this.verifyOrphan(config.id, "");
      if (verified === "skip" || verified === "cleaned") continue;
      const { pid } = verified;

      // Verified: same pid, same recorded start time as the live process — this is genuinely our
      // orphaned plugin process. Adopt it exactly as before this hardening fix.
      const rt: PluginRuntime = {
        config, status: "starting", pid, failures: [], attempt: 0, generation: 1, settledGeneration: 0,
      };
      this.runtimes.set(config.id, rt);
      this.log(`plugin ${config.id}: reclaiming verified orphan pid ${pid} — ${this.registrationTimeoutMs}ms re-registration window`);

      const gen = rt.generation;
      const timer = setTimeout(
        () => this.failAttempt(config.id, gen, `orphan pid ${pid} did not re-register within ${this.registrationTimeoutMs}ms`),
        this.registrationTimeoutMs,
      );
      timer.unref?.();
      rt.timer = timer;
    }
  }

  /** Boot-time cleanup for plugins that are no longer spawn-eligible (disabled or removed since
   *  they last ran) but left a PID file behind from a previous core process — `reclaimOrphans`
   *  only ever looks at PID files for the plugins IN ITS OWN input list (the currently-eligible
   *  set about to be spawned this boot), so a plugin's leftover process from before it was
   *  disabled/removed would never be found by that path and would linger forever. Call once at
   *  daemon boot (daemon.ts), after the PluginStore is built, BEFORE `startAll`/`reclaimOrphans`
   *  run (this method never touches `this.runtimes`, so call order relative to those two doesn't
   *  matter for correctness, but "sweep stale ones away, then start the current set" is the
   *  natural order).
   *
   *  Unlike `reclaimOrphans` (which is handed the plugins it should look for), this scans the
   *  ENTIRE `<runDir>/plugins/*.pid` directory listing directly — that's the only way to find a
   *  PID file for a plugin that isn't in `eligibleIds` at all (disabled, or its directory removed
   *  outright). For every `<id>.pid` whose `id` is NOT in `eligibleIds`, identity is verified via
   *  the SAME `ps -o lstart=` check `reclaimOrphans` uses (`processStartedAtFn`), and ONLY on a
   *  verified match is the process terminated (`killProcess` — SIGTERM, then SIGKILL after
   *  `killGraceMs` if still alive) and the PID file unlinked. Every other case — PID file missing/
   *  unreadable, the recorded PID no longer alive, no recorded start time, `ps` unavailable, or a
   *  start-time mismatch (PID reuse) — is a fail-safe NO-KILL, matching `reclaimOrphans`'s exact
   *  posture: the stale file is cleaned up (nothing left to track) but a live process is never
   *  signalled unless its identity is positively confirmed as ours. */
  sweepOrphans(eligibleIds: readonly string[]): void {
    const eligible = new Set(eligibleIds);

    let entries: string[];
    try {
      entries = readdirSync(this.pluginsRunDir());
    } catch {
      return; // no run dir yet — nothing on disk to sweep
    }

    for (const entry of entries) {
      if (!entry.endsWith(".pid")) continue;
      const id = entry.slice(0, -".pid".length);
      if (eligible.has(id)) continue; // still spawn-eligible — startAll/reclaimOrphans owns this one
      if (this.runtimes.has(id)) continue; // already tracked (defensive — sweep runs before startAll)

      const verified = this.verifyOrphan(id, "sweepOrphans — ");
      if (verified === "skip" || verified === "cleaned") continue;
      const { pid } = verified;

      // Verified: genuinely our orphaned process, left over from before this plugin was disabled
      // or removed. Terminate it and clean up the file.
      this.killProcess(pid);
      this.removePidFile(id);
      this.log(`plugin ${id}: sweepOrphans — terminating orphaned pid ${pid} (plugin no longer spawn-eligible)`);
    }
  }

  /** Full shutdown: every tracked plugin is killed (if a process is owned) and marked "stopped",
   *  every pending timer is cleared, every outstanding invoke is failed typed. Deliberately marks
   *  the generation settled BEFORE killing so the process's own (later) `exited` resolution never
   *  reopens a backoff cycle for a supervisor that's going away. */
  stopAll(): void {
    for (const [id, rt] of this.runtimes) this.stopRuntime(id, rt);
  }

  /** Single-plugin stop (Phase 4d-ii Task 2: `plugin.disable`/`plugin.remove`'s hot-apply STOP) —
   *  the same per-runtime teardown `stopAll()` applies to every tracked plugin, applied to just
   *  `pluginId`, so disabling or removing one plugin over the wire kills its process NOW, on the
   *  running daemon, without tearing down every other plugin the supervisor is tracking. A no-op
   *  for an id the supervisor isn't currently tracking (never spawned this lifetime, or already
   *  stopped) — nothing to stop. */
  stop(pluginId: string): void {
    const rt = this.runtimes.get(pluginId);
    if (!rt) return;
    this.stopRuntime(pluginId, rt);
  }

  /** Shared teardown for one runtime — extracted so `stopAll()` and the single-plugin `stop()`
   *  above can never drift apart (same clear-timer / kill-process / remove-pidfile / fail-pending-
   *  invokes sequence either way). */
  private stopRuntime(id: string, rt: PluginRuntime): void {
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = undefined;
    }
    rt.settledGeneration = rt.generation;
    if (rt.pid !== undefined) this.killProcess(rt.pid);
    this.removePidFile(id);
    rt.status = "stopped";
    rt.conn = undefined;
    rt.pid = undefined;
    rt.proc = undefined;
    this.failPendingInvokes(id);
  }

  /** Manual restart — the small CLI/manager-UI rider (`winter plugin restart <id>`, spec: "restart
   *  via re-enable in 4d UI"): forces a fresh spawn cycle regardless of current status, including
   *  "circuit-open" (which nothing else ever recovers from) and "stopped". Clears backoff/circuit
   *  accounting and kills any process still owned first — restart means start over clean. The
   *  caller supplies `config` because the supervisor has no independent way to look up
   *  manifest/entry data for a plugin it isn't currently tracking (e.g. a fresh id). */
  restart(config: EligiblePlugin): void {
    const rt = this.runtimes.get(config.id);
    if (rt) {
      if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = undefined;
      }
      rt.settledGeneration = rt.generation;
      if (rt.pid !== undefined) this.killProcess(rt.pid);
      rt.failures = [];
      rt.attempt = 0;
    }
    this.spawnFresh(config);
  }

  /** The spawn config the supervisor currently has on record for a TRACKED plugin — set by
   *  `startAll`/`reclaimOrphans`/`restart` itself, held on `PluginRuntime.config`. Lets the
   *  `plugin.restart` IPC handler (final-review Fix 1: ipc/server.ts) restart a known plugin by id
   *  alone, without the ipc layer re-deriving `EligiblePlugin.dir/entry` itself (that derivation —
   *  reading `dir`/`entry.command` off a fresh `PluginStore.list()` — is exactly what `daemon.ts`
   *  already does once at boot to build the `startAll` list; duplicating it in the ipc layer would
   *  just be a second, driftable copy). `undefined` for a plugin the supervisor has never tracked —
   *  restarting a never-before-seen id still requires the caller to supply a fresh config directly
   *  to `restart()` (see its own doc comment above). */
  configFor(pluginId: string): EligiblePlugin | undefined {
    return this.runtimes.get(pluginId)?.config;
  }

  // -----------------------------------------------------------------------------------------
  // Registration / connection lifecycle (Task 4 calls these from ipc/server.ts).
  // -----------------------------------------------------------------------------------------

  /** `plugin.register` arrived on an authed plugin connection. Only valid while "starting"
   *  (fresh spawn OR orphan reclaim awaiting re-registration) — a late/duplicate/unexpected
   *  registration is rejected (`false`) without touching any state. Resets the backoff exponent
   *  (a successful registration is a successful attempt) but NOT the circuit-breaker failure
   *  history (see `PluginRuntime.failures`). */
  notifyRegistered(pluginId: string, conn: PluginConn): boolean {
    const rt = this.runtimes.get(pluginId);
    if (!rt || rt.status !== "starting") return false;
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = undefined;
    }
    rt.status = "running";
    rt.conn = conn;
    rt.attempt = 0;
    this.log(`plugin ${pluginId}: registered (pid ${rt.pid ?? "unknown"})`);
    return true;
  }

  /** The plugin's connection closed. Treated exactly like a crash while running — the process
   *  can no longer be invoked regardless of whether it happens to still be alive, so it's killed
   *  (best-effort) and the normal failure/backoff/circuit path runs. A no-op for any status other
   *  than "running" (nothing to lose a connection FROM in "starting"/"backoff"/"circuit-open"/
   *  "stopped" — a stray/duplicate close notification is safe to ignore). */
  notifyDisconnected(pluginId: string): void {
    const rt = this.runtimes.get(pluginId);
    if (!rt || rt.status !== "running") return;
    this.failAttempt(pluginId, rt.generation, `plugin ${pluginId} disconnected`);
  }

  status(pluginId: string): SupervisorStatus {
    return this.runtimes.get(pluginId)?.status ?? "stopped";
  }

  /** Phase 4d Task 2 (spec §6/§7 harness→plugin push): fire-and-forget delivery of a transient
   *  event (`shortcut_invoke`/`tile_action`) straight to a plugin's live connection — the SAME
   *  `runtimes` lookup `invoke()` below uses, but with no request/response correlation (the caller
   *  doesn't await an answer, unlike a tool invoke). `{code:"unknown_plugin"}` when this id was
   *  never tracked at all (never `startAll`'d/reclaimed — core has no record of it);
   *  `{code:"not_connected"}` when it IS tracked but isn't currently "running" with a live `conn`,
   *  or the live conn's own `push()` reports the socket already dead; `{ok:true}` once handed off. */
  pushToPlugin(pluginId: string, event: NewSessionEvent): { ok: true } | { code: "not_connected" } | { code: "unknown_plugin" } {
    const rt = this.runtimes.get(pluginId);
    if (!rt) return { code: "unknown_plugin" };
    if (rt.status !== "running" || !rt.conn) return { code: "not_connected" };
    return rt.conn.push(event) ? { ok: true } : { code: "not_connected" };
  }

  // -----------------------------------------------------------------------------------------
  // Tool invoke correlation — mirrors PeripheralBroker.call()/respond() almost verbatim.
  // -----------------------------------------------------------------------------------------

  /** Requires "running" + a live connection (set by `notifyRegistered`); pushes
   *  `plugin_tool_invoke` on that connection and awaits `resolveToolResult` (per-call timeout
   *  `invokeTimeoutMs`, default 60s / `WINTER_PLUGIN_TOOL_TIMEOUT_MS`). Never throws — every
   *  failure path is a typed `InvokeError`. `sessionId` on the pushed event is the plugin id
   *  itself (non-empty, satisfies the protocol's `Base.sessionId.min(1)`) — this push targets a
   *  specific plugin CONNECTION, not a session's attachments, so there is no real session to
   *  stamp; correlation downstream is entirely by `requestId`, exactly like
   *  `peripheral_call_requested`/`ProviderLink`. */
  async invoke(pluginId: string, tool: string, argsJson: string): Promise<InvokeResult> {
    const rt = this.runtimes.get(pluginId);
    if (!rt || rt.status !== "running" || !rt.conn) return { code: "not_running" };
    const conn = rt.conn;
    // Captured now (not read off `rt.generation` inside the timer below) so a timeout that fires
    // after a NEWER spawn attempt has already superseded this one (e.g. the process crashed and
    // was already respawned before this call's timer fired) can't misattribute a failure to the
    // wrong attempt — same discipline `failAttempt`'s own generation check already relies on.
    const generation = rt.generation;

    const requestId = `pinv_${randomBytes(6).toString("hex")}`;
    const event: NewSessionEvent = {
      type: "plugin_tool_invoke", sessionId: pluginId, threadId: "main", requestId, tool, argsJson,
    };

    const result = new Promise<InvokeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ code: "timeout" });
        // Final-review Fix B2 (spec §3): a timeout is a wedged-connection failure, not a tolerated
        // no-op — without this, a plugin that stays connected but stops answering tool calls would
        // time out every invoke forever and never trip the circuit breaker. Routes through the
        // SAME failure-accounting path a crash/disconnect uses (kills the process, backs off or
        // opens the circuit), so repeated timeouts count toward `circuitFailures` exactly like
        // repeated crashes do.
        this.failAttempt(pluginId, generation, `plugin ${pluginId} tool ${tool} invoke timed out`);
      }, this.invokeTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { pluginId, tool, resolve, timer });
    });

    const delivered = conn.push(event);
    if (!delivered) {
      const p = this.pending.get(requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(requestId);
      }
      return { code: "no_connection" };
    }
    return result;
  }

  /** `plugin.toolResult`'s handler (Task 4: `plugin.toolResult -> supervisor.resolveToolResult`).
   *  First response wins (mirrors ApprovalBroker/PlanBroker/PeripheralBroker.respond) — an unknown
   *  or already-resolved `requestId` is a silent, safe no-op (`{ok:true}`), never a throw. The
   *  wire result (`PluginToolResultResult`, protocol/methods.ts) is deliberately just `{ok:true}`
   *  (no `alreadyResolved`, unlike `peripheral.respond`) — the supervisor's pending map is the
   *  single source of truth for double-settle guarding, not the wire shape, so there is nothing
   *  more useful to return here.
   *
   *  `callerPluginId` (final-review Fix 2) is `socket.data.pluginId` off the CONNECTION that sent
   *  this `plugin.toolResult` — the identity that connection actually authenticated as via hello,
   *  never trusted off any wire param. It must match the pending invoke's OWN `pluginId` (recorded
   *  at `invoke()` time, PendingInvoke.pluginId) or the settle is REJECTED (ignored + logged, the
   *  pending entry left untouched for its real owner or its own timeout to resolve) — otherwise any
   *  authed connection that learns a live `requestId` (a plugin watching its own traffic, a stray
   *  log line, …) could settle a DIFFERENT plugin's in-flight tool call. `null` (a harness/admin
   *  connection, which never sets `socket.data.pluginId`) can never match a real pluginId, so it's
   *  rejected the same way. */
  resolveToolResult(req: { requestId: string; resultJson?: string; error?: string }, callerPluginId: string | null): { ok: true } {
    const p = this.pending.get(req.requestId);
    if (!p) return { ok: true };
    if (p.pluginId !== callerPluginId) {
      this.log(`plugin.toolResult: requestId ${req.requestId} belongs to plugin ${p.pluginId}, not ${callerPluginId ?? "(unauthenticated as a plugin)"} — ignored`);
      return { ok: true };
    }
    this.pending.delete(req.requestId);
    clearTimeout(p.timer);
    if (req.error !== undefined) p.resolve({ code: "plugin_error", message: req.error });
    else p.resolve({ ok: true, resultJson: req.resultJson ?? "" });
    return { ok: true };
  }

  // -----------------------------------------------------------------------------------------
  // Internal: spawn / failure / backoff / circuit.
  // -----------------------------------------------------------------------------------------

  private spawnFresh(config: EligiblePlugin): void {
    const existing = this.runtimes.get(config.id);
    const rt: PluginRuntime = existing ?? {
      config, status: "starting", failures: [], attempt: 0, generation: 0, settledGeneration: 0,
    };
    rt.config = config;
    rt.generation += 1;
    rt.settledGeneration = 0;
    rt.status = "starting";
    rt.conn = undefined;
    this.runtimes.set(config.id, rt);
    const gen = rt.generation;

    let proc: SupervisedProcess;
    try {
      const token = this.deps.mintToken(config.id);
      const cmd = [config.entry.command, ...(config.entry.args ?? [])];
      const cwd = config.entry.cwd ? join(config.dir, config.entry.cwd) : config.dir;
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        WINTER_PLUGIN_TOKEN: token,
        WINTER_SOCKET: this.deps.socketPath,
        WINTER_PLUGIN_ID: config.id,
        WINTER_PLUGIN_DIR: config.dir,
      };
      proc = this.spawnFn(cmd, { cwd, env });
    } catch (err) {
      rt.pid = undefined;
      rt.proc = undefined;
      this.failAttempt(config.id, gen, `spawn failed: ${(err as Error).message}`);
      return;
    }

    rt.proc = proc;
    rt.pid = proc.pid;
    this.writePidFile(config.id, proc.pid);
    this.log(`plugin ${config.id}: spawned pid ${proc.pid}, awaiting registration (${this.registrationTimeoutMs}ms)`);

    const timer = setTimeout(
      () => this.failAttempt(config.id, gen, `registration timeout after ${this.registrationTimeoutMs}ms`),
      this.registrationTimeoutMs,
    );
    timer.unref?.();
    rt.timer = timer;

    proc.exited
      .then((code) => this.failAttempt(config.id, gen, `process exited (code ${code})`))
      .catch(() => this.failAttempt(config.id, gen, "process exited (error)"));
  }

  private restartFromBackoff(pluginId: string): void {
    const rt = this.runtimes.get(pluginId);
    if (!rt || rt.status !== "backoff") return; // stopAll/restart/manual intervention ran meanwhile
    rt.timer = undefined;
    this.spawnFresh(rt.config);
  }

  /** The single place a spawn attempt is declared over — whether by registration timeout, orphan
   *  reclaim timeout, a spontaneous process exit, or a connection drop while running. Idempotent
   *  per `(pluginId, generation)` via `settledGeneration` (see the field's doc comment): whichever
   *  trigger fires first does the work; every later trigger for the SAME generation is a no-op. */
  private failAttempt(pluginId: string, generation: number, reasonLabel: string): void {
    const rt = this.runtimes.get(pluginId);
    if (!rt || rt.generation !== generation || rt.settledGeneration === generation) return;
    rt.settledGeneration = generation;

    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = undefined;
    }
    const pid = rt.pid;
    this.removePidFile(pluginId);
    if (pid !== undefined) this.killProcess(pid);
    rt.conn = undefined;
    rt.pid = undefined;
    rt.proc = undefined;

    this.failPendingInvokes(pluginId);
    this.log(`plugin ${pluginId}: ${reasonLabel}`);

    const { failures, open } = circuitAfterFailure(rt.failures, this.nowFn(), this.circuitWindowMs, this.circuitFailures);
    rt.failures = failures;

    if (open) {
      rt.status = "circuit-open";
      this.log(`plugin ${pluginId}: circuit open (${failures.length} failures within ${this.circuitWindowMs}ms) — manual restart required`);
      this.deps.onCircuitOpen?.(pluginId);
      return;
    }

    rt.status = "backoff";
    const delay = backoffDelayMs(rt.attempt, this.backoffCapMs);
    rt.attempt += 1;
    const timer = setTimeout(() => this.restartFromBackoff(pluginId), delay);
    timer.unref?.();
    rt.timer = timer;
  }

  private failPendingInvokes(pluginId: string): void {
    for (const [requestId, p] of this.pending) {
      if (p.pluginId !== pluginId) continue;
      this.pending.delete(requestId);
      clearTimeout(p.timer);
      p.resolve({ code: "crashed", message: `plugin ${pluginId} crashed during ${p.tool}` });
    }
  }

  private killProcess(pid: number): void {
    this.signalFn(pid, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.isAliveFn(pid)) this.signalFn(pid, "SIGKILL");
    }, this.killGraceMs);
    timer.unref?.();
  }

  // -----------------------------------------------------------------------------------------
  // PID file plumbing.
  // -----------------------------------------------------------------------------------------

  private pluginsRunDir(): string {
    return join(this.deps.runDir, "plugins");
  }
  private pidFilePath(id: string): string {
    return join(this.pluginsRunDir(), `${id}.pid`);
  }
  /** Writes the identity-bearing PID file (`PidFileContents`) `reclaimOrphans` later verifies
   *  against — see its doc comment for why a bare PID is no longer enough. `startedAt` is captured
   *  right now, immediately after spawn, via `processStartedAtFn`; a `null` here (e.g. `ps` racing
   *  the just-spawned process) is written as-is rather than retried — `reclaimOrphans` already
   *  treats a `null` recorded `startedAt` as permanently unverifiable, which is the correct
   *  fail-safe outcome for a start time we were never able to pin down in the first place. */
  private writePidFile(id: string, pid: number): void {
    mkdirSync(this.pluginsRunDir(), { recursive: true });
    const contents: PidFileContents = { pid, pluginId: id, startedAt: this.processStartedAtFn(pid) };
    writeFileSync(this.pidFilePath(id), JSON.stringify(contents));
  }
  private removePidFile(id: string): void {
    try {
      unlinkSync(this.pidFilePath(id));
    } catch {
      /* already gone */
    }
  }

  private log(m: string): void {
    this.deps.onLog?.(m);
  }
}
