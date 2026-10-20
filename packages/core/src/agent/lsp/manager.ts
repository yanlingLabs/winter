import { LspClient } from "./client";

// ---------------------------------------------------------------------------------------------
// LspManager (phase 5f T2) — lazy per-(workspaceRoot, language) server lifecycle. Mirrors
// mcp/manager.ts's inFlight-dedupe + lazy-spawn shape (concurrent callers for the same key join
// ONE in-flight spawn; `clientFor` is deliberately not `async` for the same reason
// `ensureProject` isn't — see its docstring below). Adds idle reaping, which mcp/manager.ts has
// no equivalent of: an unref'd per-client timer, disarmed+rearmed on every touch, that stop()s
// and evicts the client after idleShutdownMs of inactivity.
//
// Resource hygiene is the whole risk here — every LspClient this manager ever constructs must
// end up either tracked-and-reapable, idle-reaped, or stopAll()-reaped; none escape untracked.
// In particular `spawn()`'s catch: `start()` can fork a REAL child before ultimately failing
// (e.g. a handshake timeout, not just ENOENT) — that client is never inserted into `clients`
// below, so nothing else would ever reap it. `stop()` in the catch is what prevents the orphan.
// ---------------------------------------------------------------------------------------------

export type LspLanguage = "typescript" | "swift";

// Built via fromCharCode rather than pasted as a literal control character into this source
// file (a raw NUL byte in a .ts file makes git/most editors treat it as binary). NUL can't
// appear in a POSIX path, so `${workspaceRoot}${KEY_SEP}${language}` can never collide.
const KEY_SEP = String.fromCharCode(0);

/** Injectable timer source — default is real (unref'd) setTimeout/clearTimeout; tests inject a
 *  manual one so idle-reap is deterministic with zero real waiting. Mirrors computer-use.ts's
 *  `CuScheduler`, but setTimeout-shaped rather than setInterval-shaped: each client's idle timer
 *  is disarmed+rearmed on every use rather than ticking on a steady cadence. */
export interface LspScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_SCHEDULER: LspScheduler = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.(); // idle-reap timers must never keep the daemon alive on their own
    return t;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface LspManagerCfg {
  /** Inactivity before an idle client is stop()'d and evicted. Default 300_000 (5 min). */
  idleShutdownMs?: number;
  /** Per-language command override — the ONLY way tests inject the fake server instead of a real
   *  typescript-language-server/sourcekit-lsp. `startTimeoutMs` is an additive test-only knob
   *  (threaded straight to LspClient's own constructor field, not one of T1's env-var fallback
   *  constants) letting a test force a fast, deterministic handshake-timeout spawn failure. */
  serverCommands?: Partial<Record<LspLanguage, { command: string; args?: string[]; startTimeoutMs?: number }>>;
  /** Test-only injection point (mirrors ComputerUseServiceDeps.scheduler) — omit in production. */
  scheduler?: LspScheduler;
}

const DEFAULT_SERVER_COMMANDS: Record<LspLanguage, { command: string; args?: string[] }> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  swift: { command: "sourcekit-lsp" },
};

// Per-language diagnostics tuning. Real servers PUBLISH MORE THAN ONCE per didOpen and the first
// publish is often an empty/interim result — `diagnostics()` returns the LATEST publish after a
// quiet `settleMs`, bounded by `timeoutMs`. The settle window MUST exceed a server's inter-publish
// gap or it fires mid-gap and returns the stale interim set. Measured on this platform:
//   - typescript-language-server: usually a single merged publish within ~100ms → a short settle.
//   - sourcekit-lsp (SwiftPM package file): an interim publish, then the real one ~2s later after
//     it builds/indexes → the settle must bridge that ~2s, and the deadline must clear a cold build.
// These are correctness floors, not latency budgets: a Swift diagnostics call inherently waits for
// sourcekit-lsp's build. Pull diagnostics (textDocument/diagnostic) would remove the guesswork —
// tracked as the proper follow-up.
export const DIAG_TUNING: Record<LspLanguage, { settleMs: number; timeoutMs: number }> = {
  typescript: { settleMs: 500, timeoutMs: 8000 },
  swift: { settleMs: 2500, timeoutMs: 30000 },
};

/** How a human fixes a missing-binary/spawn-failure LspSpawnError, per language — surfaced
 *  verbatim in the error message. */
const INSTALL_HINTS: Record<LspLanguage, string> = {
  typescript: "npm i -g typescript-language-server typescript",
  swift: "sourcekit-lsp ships with Xcode",
};

// Extension → language routing. Null means "no LSP tool applies" — callers (T3's tools) turn
// that into a typed "unsupported extension" error rather than ever calling into this manager.
const EXTENSION_LANGUAGE: Record<string, LspLanguage> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript", mts: "typescript", cts: "typescript",
  swift: "swift",
};

export function languageForPath(p: string): LspLanguage | null {
  const ext = /\.([a-zA-Z0-9]+)$/.exec(p)?.[1]?.toLowerCase();
  if (!ext) return null;
  return EXTENSION_LANGUAGE[ext] ?? null;
}

/** A language server failed to spawn or complete its handshake — names the language, the exact
 *  command attempted, and how to install it (missing-binary is the common case, but this also
 *  covers e.g. a handshake timeout against a wedged process). */
export class LspSpawnError extends Error {
  constructor(message: string) { super(message); this.name = "LspSpawnError"; }
}

// encodeURI (not encodeURIComponent) leaves "/" untouched, so client.ts's uriToPath — which
// decodeURIComponent()s the whole remainder in one shot, not per path segment — round-trips it.
function pathToFileUri(p: string): string {
  return `file://${encodeURI(p)}`;
}

interface ClientEntry {
  client: LspClient;
  timer: unknown;
}

export class LspManager {
  private readonly idleShutdownMs: number;
  private readonly serverCommands: Record<LspLanguage, { command: string; args?: string[]; startTimeoutMs?: number }>;
  private readonly scheduler: LspScheduler;
  private readonly clients = new Map<string, ClientEntry>();
  // Concurrent clientFor() calls for the SAME key must share ONE spawn — mirrors mcp/manager.ts's
  // `inFlight` map, including finally-based cleanup: a failed spawn doesn't wedge the key, so the
  // next clientFor() after a rejection gets a fresh attempt rather than replaying the failure.
  private readonly inFlight = new Map<string, Promise<LspClient>>();

  constructor(private readonly cfg: LspManagerCfg = {}) {
    this.idleShutdownMs = cfg.idleShutdownMs ?? 300_000;
    this.serverCommands = { ...DEFAULT_SERVER_COMMANDS, ...cfg.serverCommands };
    this.scheduler = cfg.scheduler ?? DEFAULT_SCHEDULER;
  }

  /**
   * Spawns (or reuses) the server for (workspaceRoot, language). Deliberately NOT `async`
   * (mirrors mcp/manager.ts's `ensureProject`) — an `async` method always wraps its return value
   * in a brand-new promise, which would defeat the `inFlight` guard: concurrent callers must get
   * back the LITERAL same promise object for 5 simultaneous calls to collapse to one spawn.
   *
   * CALLER CONTRACT: the idle-reap timer rearms on THIS call, not on each query issued against the
   * returned client. Reacquire via `clientFor` immediately before each operation rather than
   * caching a client across long gaps — a client held idle past `idleShutdownMs` will be reaped
   * (its `alive` flips false) out from under a stale reference.
   */
  clientFor(workspaceRoot: string, language: LspLanguage): Promise<LspClient> {
    // NUL-separated (KEY_SEP, not a literal control char pasted into this source file):
    // workspaceRoot is an arbitrary filesystem path (could itself contain "::" or similar) and
    // NUL can't appear in a POSIX path, so this key can never collide across roots.
    const key = `${workspaceRoot}${KEY_SEP}${language}`;
    const warm = this.clients.get(key);
    if (warm) { this.touch(key, warm); return Promise.resolve(warm.client); }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const p = this.spawn(key, workspaceRoot, language).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** Daemon shutdown: reap every client — SETTLED (in `clients`) AND IN-FLIGHT (in `inFlight`) —
   *  and clear every idle timer, so no dangling timer and no live child survives this call.
   *
   *  Draining `inFlight` too is the whole point (5f T2 review): a spawn that is mid-flight when
   *  shutdown begins is in `inFlight`, NOT yet in `clients`. If stopAll only swept `clients`, that
   *  spawn would complete AFTER stopAll resolved, land in `clients` with an armed idle timer, and
   *  then the host process would exit — leaking the real language-server child. So we await each
   *  in-flight promise and stop whatever it produces (a spawn that FAILS is swallowed — its own
   *  catch already stopped any partial child).
   *
   *  The loop makes this robust to interleaving: awaiting an in-flight promise lets its `spawn()`
   *  insert a fresh `clients` entry (with a newly armed timer) between our snapshot and drain — the
   *  NEXT iteration finds and disarms that entry (client.stop() is idempotent, so the double stop
   *  is a no-op). It terminates because no `clientFor` runs during shutdown, so no NEW spawns
   *  start: `inFlight` strictly drains and `clients` grows by at most one entry per drained
   *  in-flight promise. Idempotent + safe under two concurrent stopAll calls (every delete/clear/
   *  stop is a no-op the second time). A wedged in-flight spawn is bounded by its own
   *  `startTimeoutMs` (LspClient.start rejects), so this can't hang shutdown indefinitely. */
  async stopAll(): Promise<void> {
    for (;;) {
      const pending = [...this.inFlight.values()];
      const entries = [...this.clients.entries()];
      if (pending.length === 0 && entries.length === 0) return;
      for (const [key, e] of entries) {
        this.scheduler.clearTimeout(e.timer);
        this.clients.delete(key);
      }
      await Promise.all([
        ...entries.map((e) => e[1].client.stop()),
        ...pending.map((p) => p.then((c) => c.stop(), () => { /* failed spawn: its own catch already stopped any partial child */ })),
      ]);
    }
  }

  /** SYNCHRONOUS daemon-shutdown backstop (5f whole-branch review). `stopAll()` is the graceful,
   *  awaitable in-process path — but `daemon.stop()` runs `void lspManager?.stopAll()`
   *  fire-and-forget and then `process.exit(0)` synchronously, and LspClient.stop()'s graceful
   *  shutdown + SIGKILL fallback are BOTH async, so `process.exit` drops them and a warm
   *  typescript-language-server/sourcekit-lsp child is orphaned on `kill <daemon-pid>`. This
   *  delivers a REAL synchronous `child.kill("SIGTERM")` to every warm child before `process.exit`,
   *  exactly as `mcp.stopAll()` + `pluginSupervisor.stopAll()` already do on that same line.
   *
   *  Only tracked `clients` are killable synchronously: an `inFlight` spawn hasn't yet produced a
   *  child reference we can reach without awaiting its promise, so a STILL-SPAWNING child on SIGTERM
   *  relies on its own LSP `processId` self-exit (LspClient.start hands the server our `process.pid`
   *  in `initialize`; a well-behaved server exits when that pid dies). Idempotent + safe with zero
   *  clients (every kill/clear is a no-op the second time). */
  killAllNow(): void {
    for (const e of this.clients.values()) {
      this.scheduler.clearTimeout(e.timer);
      e.client.killNow();
    }
    this.clients.clear();
  }

  private async spawn(key: string, workspaceRoot: string, language: LspLanguage): Promise<LspClient> {
    const cmd = this.serverCommands[language];
    const tuning = DIAG_TUNING[language];
    const client = new LspClient({
      command: cmd.command,
      args: cmd.args,
      rootUri: pathToFileUri(workspaceRoot),
      startTimeoutMs: cmd.startTimeoutMs,
      diagSettleMs: tuning.settleMs,
      diagTimeoutMs: tuning.timeoutMs,
    });
    try {
      await client.start();
    } catch (e) {
      // start() can fork a real child before failing (handshake timeout, not just ENOENT) — this
      // client is never inserted into `clients` below, so nothing else would ever reap it.
      await client.stop();
      throw new LspSpawnError(
        `${language} language server failed to start (command: "${cmd.command}${cmd.args ? " " + cmd.args.join(" ") : ""}"). ` +
        `Install: ${INSTALL_HINTS[language]}. Cause: ${(e as Error).message}`,
      );
    }
    const entry: ClientEntry = { client, timer: null };
    this.clients.set(key, entry);
    this.touch(key, entry);
    return client;
  }

  /** Disarms the previous idle timer (if any) and arms a fresh one — called on every spawn AND
   *  every warm reuse, so activity keeps pushing the reap out. The old handle is ALWAYS cleared
   *  first: an uncleared stale timer would reap a since-retouched (still warm) client early. */
  private touch(key: string, entry: ClientEntry): void {
    if (entry.timer !== null) this.scheduler.clearTimeout(entry.timer);
    entry.timer = this.scheduler.setTimeout(() => this.reap(key), this.idleShutdownMs);
  }

  /** Evicts + stops the client for `key` once its idle timer fires. Never throws — safe for a
   *  real setTimeout to fire-and-forget in production; the manual test scheduler awaits this
   *  method's return value to make reaping deterministic. */
  private async reap(key: string): Promise<void> {
    const entry = this.clients.get(key);
    if (!entry) return;
    this.clients.delete(key);
    await entry.client.stop();
  }
}
