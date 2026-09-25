// WS-23 (ruling R1): CHAT AND DISPATCH RUN THE WINTER RUNTIME EMBEDDED — one Bun Worker per session,
// inside `winter-core`. Code sessions keep the spawned `winter` binary (`executable.ts`'s ladder).
//
// WHY A WORKER AND NOT THE DAEMON'S MAIN THREAD. The runtime keeps its tool registry, MCP executors,
// advisor, child-engine factory and background-task table as module-level singletons — one per JS
// realm — and its Bash/Monitor tools spawn with `{...process.env}`. Two sessions in one realm would
// route each other's tool calls (session A's `mcp__winter__browser__browser` would travel B's wire).
// A Worker is still this process and this pid, but it is its own realm with its own `process.env`
// (the Worker's `env` option), and an uncaught throw in it reaches the daemon as an `error` event
// instead of killing it. What a Worker does NOT contain: an out-of-memory error or a native crash
// still takes the daemon down, and each live session costs ~70 MB of the daemon's memory.
//
// WHAT STAYS THE SAME. The Worker speaks the unchanged NDJSON frame stream through a
// `SpawnedRuntimeProcess` (`spawnEmbeddedWorker`, the SDK's host bridge), handed to `query()` as
// `Options.spawnClaudeCodeProcess` — the seam `create.ts`'s `spawnHookFor` was built around (P8b-1:
// "path (b) is a change to this one function's return value"). The projector, the approval bridge,
// `sdk_mcp_call` into the daemon's capability servers, hooks and messaging cannot tell the topologies
// apart. Every embedded session is still a `WinterSession` incarnation, so credential eviction,
// idle reaping and resume work unchanged.
//
// CREDENTIALS. An embedded session resolves its Keychain items IN-PROCESS, as `winter-core` — the
// binary that created them — so chat and dispatch never raise the per-binary consent prompt a spawned
// `winter` child gets. The wire still carries only a locator (`authRef`); the difference is which
// thread of which process reads it.
//
// PIDS. `pid` is `null` for an embedded session (WS-04 §1.1: hosts must not require one). Nothing on
// the daemon's Winter-leg path reads a child pid (audited for WS-23: the router's pid reads are all on
// the official leg's supervisor; the daemon's own are its plugin supervisor and its own workflow
// runtime). The transcript lease is stamped with the pid, and every Worker shares the daemon's — which
// is why `exited` settles only once a Worker has CLOSED (after its engine returned), never earlier:
// `WinterSession.open()` resumes only after the previous incarnation's iteration ends, and that
// ordering is the only thing keeping two engines off one transcript.
import { fileURLToPath } from "node:url";
import { SDK_VERSION, type SpawnedRuntimeProcess, type SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { EMBEDDED_KILL_GRACE_MS, spawnEmbeddedWorker, type EmbeddedWorkerProcess, type EmbeddedWorkflowWorkerCommand } from "@yanlinglabs/winter-agent-runtime/embedded-host";
import { RUNTIME_VERSION } from "@yanlinglabs/winter-agent-runtime/version";
import { WORKFLOW_WORKER_BRIDGE_FLAG } from "@yanlinglabs/winter-agent-runtime/workflow-worker";
import { REQUIRED_WINTER_AGENT_SDK } from "./versions";

/** The modes that run embedded. Dispatch's CHILD sessions are code sessions, so they stay subprocesses. */
export const EMBEDDED_MODES = ["chat", "dispatch"] as const;

export function runsEmbedded(mode: "code" | "dispatch" | "chat"): boolean {
  return (EMBEDDED_MODES as readonly string[]).includes(mode);
}

/**
 * The Worker entry INSIDE the compiled binary: `packages/cli/src/embedded-worker.ts`, passed to
 * `compile:core` as a second entrypoint beside `src/main.ts`. Bun names an extra entrypoint by its
 * path relative to the entrypoints' common root, WITH its `.ts` extension, and resolves it against
 * the binary's own `$bunfs` root rather than the process cwd (measured on 1.3.14). This must stay a
 * PLAIN string: `new URL("./embedded-worker.ts", import.meta.url).href` hangs silently in a compiled
 * binary (WS-23 spike #1). `cli/test/compile-core.test.ts` pins the pairing with the script.
 */
export const COMPILED_EMBEDDED_WORKER_ENTRY = "./embedded-worker.ts";

/**
 * The argv token that selects the RUNTIME's workflow worker (`workflowWorkerMain`) in `winter-core`.
 *
 * Distinct from `__workflow-worker` on purpose: `cli/src/main.ts` routes ANY argv containing that
 * token to the daemon's OWN workflow worker (a different program with a different bridge), so the
 * runtime's default command — `process.execPath __workflow-worker --bridge`, correct for a `winter`
 * binary — would launch the wrong worker from inside `winter-core`. The embedded session is told to
 * use this token instead (`runtimeWorkflowWorkerCommand`), and `main.ts` routes it positionally.
 */
export const RUNTIME_WORKFLOW_WORKER_ARG = "__runtime-workflow-worker";

/** True inside `bun build --compile`'s single-file binary — the SDK's own test, applied to this module. */
export function isCompiledDaemon(): boolean {
  if (import.meta.url.includes("$bunfs")) return true;
  return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.includes("$bunfs");
}

/** Where to construct an embedded session's Worker from: the compiled entry, or this package's own file in dev. */
export function embeddedWorkerEntry(compiled: boolean = isCompiledDaemon()): string {
  // In dev an ABSOLUTE path: `new Worker(specifier)` resolves a relative one against the cwd there.
  return compiled ? COMPILED_EMBEDDED_WORKER_ENTRY : fileURLToPath(new URL("./embedded-worker-entry.ts", import.meta.url));
}

/**
 * The workflow worker command an embedded session is handed (see `RUNTIME_WORKFLOW_WORKER_ARG`).
 * Compiled: this binary, routed by `main.ts`. Dev/test: `bun` on this package's own entry file,
 * which self-executes (the SDK's dev default names the runtime's `main.ts` by `import.meta.url`,
 * which does not exist in an installed, dist-only package).
 */
export function runtimeWorkflowWorkerCommand(compiled: boolean = isCompiledDaemon(), execPath: string = process.execPath): EmbeddedWorkflowWorkerCommand {
  if (compiled) return { file: execPath, args: [RUNTIME_WORKFLOW_WORKER_ARG, WORKFLOW_WORKER_BRIDGE_FLAG] };
  return { file: execPath, args: [fileURLToPath(new URL("./runtime-workflow-worker-entry.ts", import.meta.url)), RUNTIME_WORKFLOW_WORKER_ARG, WORKFLOW_WORKER_BRIDGE_FLAG] };
}

/**
 * The typed refusal for an embedded session. Carries its own `code` so `session-driver.ts` forwards it
 * as the JSON-RPC error's `data.code` rather than re-describing it as a missing binary — an embedded
 * session needs no binary, and "set WINTER_RUNTIME_EXECUTABLE" would be the wrong advice.
 */
export class EmbeddedRuntimeUnavailable extends Error {
  readonly code = "embedded_runtime_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedRuntimeUnavailable";
  }
}

export interface EmbeddedVersions {
  /** `@yanlinglabs/winter-agent-runtime`'s own `RUNTIME_VERSION` — what the Worker will run. */
  runtime: string;
  /** The wrapper's `SDK_VERSION` — what speaks to it on the daemon's side of the frame stream. */
  sdk: string;
  /** This build's pin (`REQUIRED_WINTER_AGENT_SDK`). */
  required: string;
}

export const LINKED_EMBEDDED_VERSIONS: EmbeddedVersions = { runtime: RUNTIME_VERSION, sdk: SDK_VERSION, required: REQUIRED_WINTER_AGENT_SDK };

/**
 * THE VERSION LOCK. The runtime, the wrapper and the pin must be one version: a spawned child is a
 * separate artifact the ladder already refuses when mismatched (`resolvePlatformPackageWinter`), but an
 * embedded runtime is linked straight into this binary, so a mismatched pair would run silently on a
 * frame protocol nobody tested together. A mismatch refuses EVERY embedded session typed (and is
 * logged once at boot) — never a fall back to the spawned binary (no silent fallback, the hard rule).
 */
export function embeddedVersionCheck(versions: EmbeddedVersions = LINKED_EMBEDDED_VERSIONS): EmbeddedRuntimeUnavailable | undefined {
  if (versions.runtime === versions.sdk && versions.sdk === versions.required) return undefined;
  return new EmbeddedRuntimeUnavailable(
    `the embedded Winter runtime is ${versions.runtime}, the agent SDK wrapper is ${versions.sdk} and this build is pinned to ${versions.required} — ` +
      "chat and dispatch run the runtime in-process and refuse a mixed set; reinstall so all three agree",
  );
}

/**
 * How long `stop()` gives the embedded Workers, AFTER `runtimeSdk.dispose()` has ended every tracked
 * session, before it `terminate()`s the stragglers and closes the stores. Arithmetic, as
 * `SHUTDOWN_QUERY_GRACE_MS` is: the three sequential budgets must fit `DaemonSupervisor.gracefulExitTimeout`
 * (5.0 s) — 300 (query grace) + 600 (this) + 3500 (the runtime-state drain) = 4400 < 5000, asserted
 * in `embedded.test.ts`. An ordinary embedded session has already finished by the time this starts
 * (the abort is milliseconds); the budget exists for one that cannot answer.
 */
export const EMBEDDED_SHUTDOWN_BUDGET_MS = 600;

/** The daemon's registry of live embedded sessions — one per daemon, owned by `daemon.ts`. */
export interface EmbeddedSessionHost {
  /**
   * `workerProcess()`: one session in one new Worker, as a `SpawnedRuntimeProcess` for `query()`.
   * `kill()` aborts (process groups first, then the turn, then the engine unwinds) and ends stdin;
   * `terminate()` follows after a grace; `exited` settles when the Worker closes; `pid` is `null`.
   */
  spawn(options: SpawnRuntimeOptions): SpawnedRuntimeProcess;
  /** The backend session ids (the runtime config's `sessionId`) that have a live Worker, oldest first. */
  live(): string[];
  /**
   * End every live Worker: `kill()` all, wait up to `budgetMs`, `terminate()` whatever is left, wait
   * for those to close. After it starts, `spawn` refuses. Idempotent; never rejects.
   */
  shutdown(budgetMs?: number): Promise<void>;
}

export interface EmbeddedSessionHostDeps {
  log?: (line: string) => void;
  /** Test seams; production derives both from `isCompiledDaemon()`. */
  workerEntry?: string;
  workflowWorkerCommand?: () => EmbeddedWorkflowWorkerCommand;
  killGraceMs?: number;
}

/**
 * The backend session a spawn argv's config runs, for the registry and the log — never anything else
 * from it. A RESUMED incarnation names it as `resume` (the daemon sets `Options.resume` and no
 * `sessionId`, so the wrapper mints a throwaway `sessionId` beside it — `mode-options.ts`); a fresh
 * one as `sessionId`.
 */
function sessionIdOf(args: readonly string[]): string {
  const idx = args.indexOf("--config-json");
  try {
    const config = JSON.parse(args[idx + 1] ?? "") as { sessionId?: unknown; resume?: unknown };
    if (typeof config.resume === "string") return config.resume;
    return typeof config.sessionId === "string" ? config.sessionId : "unknown";
  } catch {
    return "unknown";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createEmbeddedSessionHost(deps: EmbeddedSessionHostDeps = {}): EmbeddedSessionHost {
  const log = deps.log ?? ((): void => {});
  const live = new Map<EmbeddedWorkerProcess, string>();
  let shuttingDown: Promise<void> | undefined;

  const workerProcess = (options: SpawnRuntimeOptions): EmbeddedWorkerProcess => {
    const sessionId = sessionIdOf(options.args);
    const proc = spawnEmbeddedWorker({
      workerEntry: deps.workerEntry ?? embeddedWorkerEntry(),
      spawn: options,
      workflowWorkerCommand: (deps.workflowWorkerCommand ?? runtimeWorkflowWorkerCommand)(),
      killGraceMs: deps.killGraceMs ?? EMBEDDED_KILL_GRACE_MS,
    });
    live.set(proc, sessionId);
    void proc.exited.then((exit) => {
      live.delete(proc);
      // One line for an abnormal end only — an ordinary session ends 0 on every idle reap. The code
      // and signal are all this says: the Worker's stderr reaches the wrapper's `stderr` option, never
      // this log (it can carry a provider's error text).
      if (exit.code !== 0) log(`embedded session ${sessionId} ended (code ${exit.code ?? "none"}${exit.signal !== null ? `, ${exit.signal}` : ""})`);
    });
    return proc;
  };

  return {
    spawn(options: SpawnRuntimeOptions): SpawnedRuntimeProcess {
      if (shuttingDown !== undefined) {
        // `create.ts`'s `trackQuery` already aborts a session started during shutdown; this is the
        // belt for the spawn itself, which would otherwise start a Worker nobody will ever end.
        throw new EmbeddedRuntimeUnavailable("the daemon is shutting down; no embedded session can start");
      }
      return workerProcess(options);
    },
    live(): string[] {
      return [...live.values()];
    },
    shutdown(budgetMs: number = EMBEDDED_SHUTDOWN_BUDGET_MS): Promise<void> {
      if (shuttingDown !== undefined) return shuttingDown;
      shuttingDown = (async () => {
        const procs = [...live.keys()];
        if (procs.length === 0) return;
        for (const p of procs) p.kill();
        const all = Promise.all(procs.map((p) => p.exited));
        const finished = await Promise.race([all.then(() => true), sleep(budgetMs).then(() => false)]);
        if (finished) return;
        const stragglers = procs.filter((p) => p.state !== "closed");
        log(`${stragglers.length} embedded session(s) did not end within ${budgetMs} ms of shutdown — terminating`);
        for (const p of stragglers) p.terminate();
        // `terminate()` closes a Worker in milliseconds (measured ~50 ms even mid-spin); bounded anyway.
        await Promise.race([all, sleep(250)]);
      })().catch(() => {});
      return shuttingDown;
    },
  };
}
