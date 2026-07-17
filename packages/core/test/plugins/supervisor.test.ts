import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginSupervisor,
  backoffDelayMs,
  circuitAfterFailure,
  type EligiblePlugin,
  type InvokeResult,
  type PluginConn,
  type PluginSupervisorDeps,
  type SupervisedProcess,
  type SpawnFn,
} from "../../src/plugins/supervisor";

// -------------------------------------------------------------------------------------------
// Fixtures — everything here is fake (no real OS process, no real signals). `isAlivePid`/
// `signalPid` default to inert no-ops so a test that forgets to override them can never send a
// real signal anywhere (see supervisor.ts's doc comment on why these are injectable at all).
// -------------------------------------------------------------------------------------------

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "norma-supervisor-"));
}

function fakePlugin(overrides: Partial<EligiblePlugin> = {}): EligiblePlugin {
  return { id: "demo", dir: "/plugins/demo", entry: { command: "bun", args: ["index.ts"] }, ...overrides };
}

/** A deferred-promise fake process: `.exited` resolves only when the test calls `crash()` —
 *  nothing here is tied to `kill()`, exactly like a real OS process (the supervisor sends a
 *  signal; the process decides when, if ever, it actually exits). */
function fakeProc(pid: number) {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((res) => { resolveExited = res; });
  const kills: Array<number | NodeJS.Signals | undefined> = [];
  const proc: SupervisedProcess = { pid, exited, kill: (sig) => { kills.push(sig); } };
  return { proc, kills, crash: (code = 1) => resolveExited(code) };
}

function makeSpawnFn(pidStart = 1000) {
  const calls: Array<{ cmd: string[]; opts: { cwd: string; env: Record<string, string> } }> = [];
  const spawned: Array<ReturnType<typeof fakeProc>> = [];
  let pid = pidStart;
  const spawn: SpawnFn = (cmd, opts) => {
    calls.push({ cmd, opts });
    const rec = fakeProc(pid++);
    spawned.push(rec);
    return rec.proc;
  };
  return { spawn, calls, spawned };
}

/** Deterministic default for the `processStartedAt` injection seam (PID-reuse identity
 *  verification, see supervisor.ts's `reclaimOrphans` doc comment) — every test gets a fixed,
 *  fake "start time" for any pid so nothing ever shells out to a real `ps`. Tests that exercise
 *  mismatch/unavailable/legacy-format handling override this per-call. */
const FAKE_STARTED_AT = "Thu Jan  1 00:00:00 1970";

/** Writes an identity-bearing PID file in the current (post-fix) JSON shape directly, bypassing
 *  the supervisor entirely — mirrors what `writePidFile` itself would have written, for tests that
 *  need to fabricate an "orphan" PID file on disk before calling `reclaimOrphans`/`startAll`. */
function writeOrphanPidFile(dir: string, id: string, pid: number, startedAt: string | null = FAKE_STARTED_AT): void {
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", `${id}.pid`), JSON.stringify({ pid, pluginId: id, startedAt }));
}

function fakeConn(): PluginConn & { pushed: Array<Record<string, unknown>>; delivered: boolean } {
  return {
    pushed: [],
    delivered: true,
    push(event) {
      this.pushed.push(event as unknown as Record<string, unknown>);
      return this.delivered;
    },
  };
}

const DEFAULT_SETTINGS: NonNullable<PluginSupervisorDeps["settings"]> = {
  registrationTimeoutMs: 5000, backoffCapMs: 60_000, circuitFailures: 5, circuitWindowMs: 10 * 60_000,
  invokeTimeoutMs: 5000, killGraceMs: 2000,
};

function makeSupervisor(overrides: Partial<PluginSupervisorDeps> = {}) {
  const dir = tmpRunDir();
  const mints: string[] = [];
  const logs: string[] = [];
  const { spawn, calls, spawned } = makeSpawnFn();
  const { settings, ...rest } = overrides;
  const supervisor = new PluginSupervisor({
    runDir: dir,
    socketPath: "/tmp/norma-test.sock",
    mintToken: (id) => { const t = `tok_${id}_${mints.length}`; mints.push(t); return t; },
    spawn,
    now: () => Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    onLog: (m) => logs.push(m),
    isAlivePid: () => false,
    signalPid: () => {},
    processStartedAt: () => FAKE_STARTED_AT,
    ...rest,
  });
  return { supervisor, dir, mints, logs, calls, spawned };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------------------------
// Pure functions — directly table-tested, no clock/timer involved.
// -------------------------------------------------------------------------------------------

describe("backoffDelayMs (pure)", () => {
  const cap = 60_000;
  const cases: Array<[number, number]> = [
    [0, 1000], [1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, 32000], [6, 60_000], [7, 60_000],
  ];
  for (const [attempt, want] of cases) {
    test(`attempt ${attempt} -> ${want}ms (1s·2^${attempt} capped at ${cap}ms)`, () => {
      expect(backoffDelayMs(attempt, cap)).toBe(want);
    });
  }
  test("a cap smaller than the base delay clamps immediately (attempt 0)", () => {
    expect(backoffDelayMs(0, 500)).toBe(500);
  });
});

describe("circuitAfterFailure (pure)", () => {
  test("first failure -> recorded, not open (threshold 5)", () => {
    expect(circuitAfterFailure([], 1000, 600_000, 5)).toEqual({ failures: [1000], open: false });
  });
  test("the 5th failure within the window opens the circuit", () => {
    const r = circuitAfterFailure([100, 200, 300, 400], 500, 600_000, 5);
    expect(r.failures).toEqual([100, 200, 300, 400, 500]);
    expect(r.open).toBe(true);
  });
  test("a 4th-in-a-row failure with threshold 5 does NOT open", () => {
    const r = circuitAfterFailure([100, 200, 300], 400, 600_000, 5);
    expect(r.open).toBe(false);
  });
  test("failures older than the window are pruned before counting -> resets", () => {
    // 4 old failures, all now outside the 10-minute window relative to the 5th's timestamp.
    const r = circuitAfterFailure([0, 0, 0, 0], 700_000, 600_000, 5);
    expect(r.failures).toEqual([700_000]);
    expect(r.open).toBe(false);
  });
  test("boundary: exactly windowMs old is pruned (exclusive)", () => {
    const r = circuitAfterFailure([0], 600_000, 600_000, 5);
    expect(r.failures).toEqual([600_000]);
  });
  test("boundary: one ms inside the window survives", () => {
    const r = circuitAfterFailure([0], 599_999, 600_000, 5);
    expect(r.failures).toEqual([0, 599_999]);
  });
});

// -------------------------------------------------------------------------------------------
// Spawn / registration / env.
// -------------------------------------------------------------------------------------------

describe("startAll / spawn", () => {
  test("spawns the manifest entry with NORMA_PLUGIN_TOKEN/SOCKET/ID; status starts 'starting'", () => {
    const { supervisor, calls, mints } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["bun", "index.ts"]);
    expect(calls[0]!.opts.cwd).toBe("/plugins/demo");
    expect(calls[0]!.opts.env.NORMA_PLUGIN_TOKEN).toBe(mints[0]);
    expect(calls[0]!.opts.env.NORMA_SOCKET).toBe("/tmp/norma-test.sock");
    expect(calls[0]!.opts.env.NORMA_PLUGIN_ID).toBe("demo");
  });

  test("entry.cwd, when set, resolves relative to the plugin's own dir", () => {
    const { supervisor, calls } = makeSupervisor();
    supervisor.startAll([fakePlugin({ dir: "/plugins/demo", entry: { command: "bun", args: ["i.ts"], cwd: "sub" } })]);
    expect(calls[0]!.opts.cwd).toBe(join("/plugins/demo", "sub"));
  });

  test("NORMA_PLUGIN_DIR is always set to the plugin's directory (entry.cwd-safe)", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin({ dir: "/plugins/demo", entry: { command: "bun", args: ["i.ts"], cwd: "sub" } });
    supervisor.startAll([p]);
    expect(calls[0]!.opts.env.NORMA_PLUGIN_DIR).toBe("/plugins/demo");
  });

  test("startAll is idempotent — a second call for an already-tracked id does not spawn again", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.startAll([p]);
    expect(calls).toHaveLength(1);
  });

  test("notifyRegistered flips starting -> running and clears the registration timer", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    expect(supervisor.notifyRegistered(p.id, conn)).toBe(true);
    expect(supervisor.status(p.id)).toBe("running");
  });

  test("notifyRegistered rejects an unknown plugin id (never throws)", () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.notifyRegistered("nope", fakeConn())).toBe(false);
  });

  test("notifyRegistered rejects a duplicate registration once already running", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    expect(supervisor.notifyRegistered(p.id, fakeConn())).toBe(false);
  });

  test("a throwing spawn() is treated as a failed attempt (backoff), never throws out of startAll", () => {
    const logs: string[] = [];
    const supervisor = new PluginSupervisor({
      runDir: tmpRunDir(), socketPath: "/tmp/x.sock", mintToken: () => "tok",
      spawn: () => { throw new Error("command not found"); },
      settings: DEFAULT_SETTINGS,
      onLog: (m) => logs.push(m),
    });
    const p = fakePlugin();
    expect(() => supervisor.startAll([p])).not.toThrow();
    expect(supervisor.status(p.id)).toBe("backoff");
    expect(logs.some((m) => m.includes("spawn failed"))).toBe(true);
  });

  test("mintToken is called fresh for every spawn attempt (rotates on restart)", async () => {
    const { supervisor, mints } = makeSupervisor({ settings: { registrationTimeoutMs: 10, backoffCapMs: 10 } });
    supervisor.startAll([fakePlugin()]);
    expect(mints).toHaveLength(1);
    await sleep(60);
    expect(mints.length).toBeGreaterThanOrEqual(2);
    // never the same raw token twice
    expect(new Set(mints).size).toBe(mints.length);
  });
});

// -------------------------------------------------------------------------------------------
// Registration timeout.
// -------------------------------------------------------------------------------------------

describe("registration timeout", () => {
  test("kills the process (SIGTERM) and schedules backoff when nothing registers in time", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor } = makeSupervisor({
      settings: { registrationTimeoutMs: 20, killGraceMs: 500 },
      isAlivePid: () => true,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    await sleep(70);
    expect(supervisor.status(p.id)).toBe("backoff");
    expect(signals.some((s) => s.sig === "SIGTERM")).toBe(true);
  });

  test("PID file is removed once the registration timeout fires", async () => {
    const { supervisor, dir } = makeSupervisor({ settings: { registrationTimeoutMs: 20 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(existsSync(pidPath)).toBe(true);
    await sleep(70);
    expect(existsSync(pidPath)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Crash mid-invoke + notifyDisconnected.
// -------------------------------------------------------------------------------------------

describe("crash while an invoke is outstanding", () => {
  test("the outstanding invoke resolves typed 'crashed during <tool>'; status -> backoff", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);

    const invokePromise = supervisor.invoke(p.id, "echo", "{}");
    expect(conn.pushed).toHaveLength(1);
    expect(conn.pushed[0]!.type).toBe("plugin_tool_invoke");

    spawned[0]!.crash(137);
    const result = await invokePromise;
    expect(result).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during echo` });
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("multiple outstanding invokes each fail with THEIR OWN tool name", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());

    const a = supervisor.invoke(p.id, "toolA", "{}");
    const b = supervisor.invoke(p.id, "toolB", "{}");
    spawned[0]!.crash(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during toolA` });
    expect(rb).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during toolB` });
  });

  test("a stale exited() from a superseded attempt never clobbers a NEWER attempt (generation guard)", async () => {
    // registrationTimeoutMs deliberately long — this test forces the generation bump directly via
    // restart() so it never races a real registration/backoff timer (avoids timing flakiness).
    const { supervisor, spawned } = makeSupervisor({ settings: { registrationTimeoutMs: 5000 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    expect(spawned).toHaveLength(1);

    supervisor.restart(p); // forces a fresh spawn / new generation, independent of any timer
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(supervisor.status(p.id)).toBe("starting");

    // The FIRST (now-superseded) process's exited promise resolves late (e.g. its SIGKILL finally
    // landing) — this must be a no-op for the CURRENT (second) attempt.
    spawned[0]!.crash(137);
    await sleep(10);
    expect(supervisor.status(p.id)).toBe("starting");
  });
});

describe("notifyDisconnected", () => {
  test("while running: fails pending invokes typed and enters backoff, same as a process crash", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    const invokePromise = supervisor.invoke(p.id, "sleep", "{}");
    supervisor.notifyDisconnected(p.id);
    const result = await invokePromise;
    expect(result).toEqual({ code: "crashed", message: `plugin ${p.id} crashed during sleep` });
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("is a no-op while merely 'starting' (nothing registered yet)", () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyDisconnected(p.id);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("is a no-op for an unknown plugin id", () => {
    const { supervisor } = makeSupervisor();
    expect(() => supervisor.notifyDisconnected("nope")).not.toThrow();
  });
});

// -------------------------------------------------------------------------------------------
// invoke() edge cases.
// -------------------------------------------------------------------------------------------

describe("invoke()", () => {
  test("unknown/never-started plugin -> typed not_running, never throws", async () => {
    const { supervisor } = makeSupervisor();
    const res: InvokeResult = await supervisor.invoke("nope", "tool", "{}");
    expect(res).toEqual({ code: "not_running" });
  });

  test("status 'starting' (registered not yet) -> typed not_running", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "not_running" });
  });

  test("push failing to deliver -> typed no_connection, pending entry cleaned up", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    conn.delivered = false;
    supervisor.notifyRegistered(p.id, conn);
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "no_connection" });
  });

  test("no resolveToolResult within invokeTimeoutMs -> typed timeout", async () => {
    const { supervisor } = makeSupervisor({ settings: { invokeTimeoutMs: 20 } });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    const res = await supervisor.invoke(p.id, "tool", "{}");
    expect(res).toEqual({ code: "timeout" });
  });

  test("repeated invoke timeouts count as failures toward the circuit breaker, same as repeated crashes (final-review Fix B2)", async () => {
    const { supervisor } = makeSupervisor({
      settings: { registrationTimeoutMs: 5000, invokeTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 2, circuitWindowMs: 600_000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());

    const first = await supervisor.invoke(p.id, "tool", "{}");
    expect(first).toEqual({ code: "timeout" });
    expect(supervisor.status(p.id)).toBe("backoff"); // 1 failure < circuitFailures(2) — not open yet

    await sleep(30); // past backoffCapMs(10ms) — restartFromBackoff respawns automatically
    expect(supervisor.status(p.id)).toBe("starting");
    supervisor.notifyRegistered(p.id, fakeConn());
    expect(supervisor.status(p.id)).toBe("running");

    const second = await supervisor.invoke(p.id, "tool", "{}");
    expect(second).toEqual({ code: "timeout" });
    expect(supervisor.status(p.id)).toBe("circuit-open"); // 2nd failure within the window trips it

    // "no further invoke attempts": circuit-open fails fast, never pushes another plugin_tool_invoke.
    const third = await supervisor.invoke(p.id, "tool", "{}");
    expect(third).toEqual({ code: "not_running" });
  });

  test("a plugin.toolResult error -> typed plugin_error carrying the message", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "tool", "{}");
    const requestId = conn.pushed[0]!.requestId as string;
    supervisor.resolveToolResult({ requestId, error: "boom" }, p.id);
    expect(await invokePromise).toEqual({ code: "plugin_error", message: "boom" });
  });

  test("a successful plugin.toolResult resolves ok:true with resultJson", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "tool", "{}");
    const requestId = conn.pushed[0]!.requestId as string;
    supervisor.resolveToolResult({ requestId, resultJson: "\"hi\"" }, p.id);
    expect(await invokePromise).toEqual({ ok: true, resultJson: "\"hi\"" });
  });
});

// -------------------------------------------------------------------------------------------
// resolveToolResult() — double-settle-proof (mirrors PeripheralBroker.respond()).
// -------------------------------------------------------------------------------------------

describe("resolveToolResult() double-settle-proof", () => {
  test("a second resolveToolResult for the same requestId is a safe no-op — first result wins", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "echo", "{}");
    const requestId = conn.pushed[0]!.requestId as string;

    const first = supervisor.resolveToolResult({ requestId, resultJson: "\"first\"" }, p.id);
    expect(first).toEqual({ ok: true });
    const second = supervisor.resolveToolResult({ requestId, resultJson: "\"second\"" }, p.id);
    expect(second).toEqual({ ok: true }); // never throws, no alreadyResolved on the wire shape

    const result = await invokePromise;
    expect(result).toEqual({ ok: true, resultJson: "\"first\"" }); // second call never applied
  });

  test("resolveToolResult for an unknown requestId is a safe no-op", () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.resolveToolResult({ requestId: "never-existed" }, "anyone")).toEqual({ ok: true });
  });
});

// -------------------------------------------------------------------------------------------
// resolveToolResult() — caller-bound (final-review Fix 2): the responding CONNECTION's own
// authenticated pluginId must match the pending invoke's pluginId, or the settle is ignored.
// -------------------------------------------------------------------------------------------

describe("resolveToolResult() caller-bound (final-review Fix 2)", () => {
  test("plugin B answering plugin A's requestId is a no-op — A's invoke keeps waiting", async () => {
    const { supervisor } = makeSupervisor();
    const a = fakePlugin({ id: "plugin-a" });
    const b = fakePlugin({ id: "plugin-b" });
    supervisor.startAll([a, b]);
    const connA = fakeConn();
    const connB = fakeConn();
    supervisor.notifyRegistered(a.id, connA);
    supervisor.notifyRegistered(b.id, connB);

    const invokePromise = supervisor.invoke(a.id, "tool", "{}");
    const requestId = connA.pushed[0]!.requestId as string;

    // Plugin B (a different, correctly-authenticated connection) tries to settle A's requestId —
    // rejected: the pending entry is untouched, A's own invoke is still outstanding.
    const fromB = supervisor.resolveToolResult({ requestId, resultJson: "\"hijacked\"" }, b.id);
    expect(fromB).toEqual({ ok: true }); // never throws — same "safe no-op" wire contract

    // A's own answer still works — the mismatch above never consumed/settled the pending entry.
    const fromA = supervisor.resolveToolResult({ requestId, resultJson: "\"legit\"" }, a.id);
    expect(fromA).toEqual({ ok: true });

    expect(await invokePromise).toEqual({ ok: true, resultJson: "\"legit\"" });
  });

  test("a harness/admin connection (callerPluginId null) can never settle a plugin's pending invoke", async () => {
    const { supervisor } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const conn = fakeConn();
    supervisor.notifyRegistered(p.id, conn);
    const invokePromise = supervisor.invoke(p.id, "tool", "{}");
    const requestId = conn.pushed[0]!.requestId as string;

    expect(supervisor.resolveToolResult({ requestId, resultJson: "\"nope\"" }, null)).toEqual({ ok: true });
    expect(supervisor.resolveToolResult({ requestId, resultJson: "\"yes\"" }, p.id)).toEqual({ ok: true });
    expect(await invokePromise).toEqual({ ok: true, resultJson: "\"yes\"" });
  });
});

// -------------------------------------------------------------------------------------------
// Circuit breaker (class-level integration — exact 5-in-10min values are pinned by the pure
// circuitAfterFailure tests above; this exercises the WIRING with a lower threshold for speed).
// -------------------------------------------------------------------------------------------

describe("circuit breaker (integration)", () => {
  test("repeated fast failures trip the circuit; no further spawn attempts follow", async () => {
    const { supervisor, calls } = makeSupervisor({
      settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 3, circuitWindowMs: 600_000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(250);
    expect(supervisor.status(p.id)).toBe("circuit-open");
    const countAtOpen = calls.length;
    await sleep(100);
    expect(calls.length).toBe(countAtOpen); // circuit-open never schedules another attempt
  });

  // Phase 4b Task 4: ipc/server.ts has no way to learn "this plugin's circuit just opened" on its
  // own (it only reacts to socket close events) — `onCircuitOpen` is the seam the daemon wires to
  // unregister that plugin's `plugin__<id>__*` tools out of the ToolRegistry the instant the
  // breaker trips, independent of whatever the underlying socket connection happens to be doing.
  test("onCircuitOpen fires exactly once, with the pluginId, the moment the circuit opens — not on earlier (non-opening) failures", async () => {
    const opened: string[] = [];
    const { supervisor } = makeSupervisor({
      settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 3, circuitWindowMs: 600_000 },
      onCircuitOpen: (id) => opened.push(id),
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(250);
    expect(supervisor.status(p.id)).toBe("circuit-open");
    expect(opened).toEqual(["demo"]); // fired exactly once, not once per failure (3 failures preceded it)
  });

  test("a disconnect that does NOT trip the circuit never fires onCircuitOpen", () => {
    const opened: string[] = [];
    const { supervisor } = makeSupervisor({
      settings: { registrationTimeoutMs: 5000, backoffCapMs: 10, circuitFailures: 5, circuitWindowMs: 600_000 },
      onCircuitOpen: (id) => opened.push(id),
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    supervisor.notifyDisconnected(p.id); // 1 failure, threshold 5 — never opens
    expect(supervisor.status(p.id)).toBe("backoff");
    expect(opened).toEqual([]);
  });

  test("failures outside the circuit window don't accumulate (class-level, injected now())", async () => {
    // registrationTimeoutMs is deliberately long (never fires in this test) — failures are driven
    // directly via notifyDisconnected so this test races exactly ONE real timer (the short backoff
    // restart), not a registration timeout as well. Only backoffCapMs is short.
    let nowMs = 0;
    const { supervisor } = makeSupervisor({
      now: () => nowMs,
      settings: { registrationTimeoutMs: 5000, backoffCapMs: 15, circuitFailures: 2, circuitWindowMs: 1000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.notifyRegistered(p.id, fakeConn());
    supervisor.notifyDisconnected(p.id); // failure #1 recorded at nowMs=0
    expect(supervisor.status(p.id)).toBe("backoff"); // 1 failure, threshold 2 — not open yet

    await sleep(60); // let the short (15ms) backoff timer respawn automatically
    expect(supervisor.status(p.id)).toBe("starting"); // second attempt, failures untouched by respawn

    // Jump the injected clock far past the 1000ms window before recording the SECOND failure.
    nowMs = 10_000;
    supervisor.notifyRegistered(p.id, fakeConn());
    supervisor.notifyDisconnected(p.id); // failure #2 recorded at nowMs=10_000

    // Failure #1 (timestamp 0) is now 10_000ms stale — pruned before counting. Only failure #2
    // survives, so the circuit must NOT be open despite this being the second failure overall.
    expect(supervisor.status(p.id)).toBe("backoff");
  });
});

// -------------------------------------------------------------------------------------------
// Orphan reclaim (boot-time PID file handling).
// -------------------------------------------------------------------------------------------

describe("reclaimOrphans", () => {
  test("no PID file on disk -> no-op; the plugin is untouched (startAll spawns it fresh)", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin();
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped"); // never tracked
    supervisor.startAll([p]);
    expect(calls).toHaveLength(1);
  });

  test("dead PID -> file cleaned up, plugin left untracked (not adopted)", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: () => false });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeFileSync(pidPath, "999999");
    supervisor.reclaimOrphans([p]);
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.status(p.id)).toBe("stopped");
  });

  test("malformed PID file content -> treated as dead, cleaned up", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: () => true }); // would be "alive" if ever checked
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeFileSync(pidPath, "not-a-pid");
    supervisor.reclaimOrphans([p]);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("live PID with verified start time -> adopted into 'starting', given the re-registration window, no fresh spawn", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 424_242 });
    const p = fakePlugin();
    writeOrphanPidFile(dir, p.id, 424_242);
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("starting");
    expect(calls).toHaveLength(0);
  });

  test("live PID with verified start time that registers within the window -> running, exactly like a fresh spawn", () => {
    const { supervisor, dir } = makeSupervisor({ isAlivePid: (pid) => pid === 424_242 });
    const p = fakePlugin();
    writeOrphanPidFile(dir, p.id, 424_242);
    supervisor.reclaimOrphans([p]);
    const conn = fakeConn();
    expect(supervisor.notifyRegistered(p.id, conn)).toBe(true);
    expect(supervisor.status(p.id)).toBe("running");
  });

  test("live PID with verified start time that never re-registers is killed (SIGTERM) after the window and enters backoff", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 20, killGraceMs: 500 },
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    writeOrphanPidFile(dir, p.id, 424_242);
    supervisor.reclaimOrphans([p]);
    await sleep(70);
    expect(signals).toEqual([{ pid: 424_242, sig: "SIGTERM" }]);
    expect(supervisor.status(p.id)).toBe("backoff");
  });

  test("an unresponsive VERIFIED orphan is SIGKILLed after the kill grace elapses, if still alive", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 20 },
      isAlivePid: (pid) => pid === 424_242, // "still alive" forever — never actually dies
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    writeOrphanPidFile(dir, p.id, 424_242);
    supervisor.reclaimOrphans([p]);
    await sleep(90);
    expect(signals).toEqual([
      { pid: 424_242, sig: "SIGTERM" },
      { pid: 424_242, sig: "SIGKILL" },
    ]);
  });

  test("startAll folds reclaimOrphans in — a verified live-orphan plugin is adopted, never double-spawned", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 555 });
    const p = fakePlugin();
    writeOrphanPidFile(dir, p.id, 555);
    supervisor.startAll([p]);
    expect(calls).toHaveLength(0);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("startAll spawns OTHER eligible plugins normally alongside one reclaimed (verified) orphan", () => {
    const { supervisor, dir, calls } = makeSupervisor({ isAlivePid: (pid) => pid === 555 });
    const orphaned = fakePlugin({ id: "orphaned" });
    const fresh = fakePlugin({ id: "fresh" });
    writeOrphanPidFile(dir, "orphaned", 555);
    supervisor.startAll([orphaned, fresh]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.env.NORMA_PLUGIN_ID).toBe("fresh");
    expect(supervisor.status("orphaned")).toBe("starting");
    expect(supervisor.status("fresh")).toBe("starting");
  });

  // -----------------------------------------------------------------------------------------
  // PID-reuse identity verification (hardening fix): a live PID is NEVER enough on its own — see
  // supervisor.ts's `reclaimOrphans` doc comment. Every path below must NOT adopt (so the process
  // can never later be signalled) and must clean up the PID file, fail-safe.
  // -----------------------------------------------------------------------------------------

  test("live PID but MISMATCHED start time (PID reuse suspected) -> NOT adopted, NOT signalled, file cleaned", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 15 },
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => "the-actual-live-process-start-time",
    });
    const p = fakePlugin();
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    // Recorded start time (from a previous, now-dead incarnation) does NOT match the live
    // process's actual start time -> the OS almost certainly reused this pid.
    writeOrphanPidFile(dir, p.id, 424_242, "a-stale-recorded-start-time");
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped"); // never adopted
    expect(existsSync(pidPath)).toBe(false); // cleaned up
    await sleep(50); // long enough that a (bogus) re-registration-window timer would have fired
    expect(signals).toEqual([]); // never signalled — the innocent live process is left alone
  });

  test("processStartedAt unavailable (ps errors, returns null) -> NOT adopted, NOT signalled, file cleaned", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 15 },
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => null, // simulates ps being unavailable/erroring in this environment
    });
    const p = fakePlugin();
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeOrphanPidFile(dir, p.id, 424_242, FAKE_STARTED_AT);
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped");
    expect(existsSync(pidPath)).toBe(false);
    await sleep(50);
    expect(signals).toEqual([]);
  });

  test("live PID with a recorded startedAt of null (this core itself couldn't stamp it) -> unverifiable, NOT adopted/signalled", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 15 },
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => FAKE_STARTED_AT, // ps works fine NOW, but the recorded value is null
    });
    const p = fakePlugin();
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeOrphanPidFile(dir, p.id, 424_242, null);
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped");
    expect(existsSync(pidPath)).toBe(false);
    await sleep(50);
    expect(signals).toEqual([]);
  });

  test("legacy bare-PID file (pre-fix format) with a LIVE pid -> treated unverifiable, NOT adopted/signalled, file cleaned", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, killGraceMs: 15 },
      isAlivePid: (pid) => pid === 424_242, // genuinely alive — old code would have adopted+later-killed it
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    const p = fakePlugin();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    writeFileSync(pidPath, "424242"); // bare PID — the pre-fix on-disk format
    supervisor.reclaimOrphans([p]);
    expect(supervisor.status(p.id)).toBe("stopped"); // never adopted
    expect(existsSync(pidPath)).toBe(false); // cleaned up
    await sleep(50);
    expect(signals).toEqual([]); // never signalled — no innocent-PID kill from a legacy file
  });
});

// -------------------------------------------------------------------------------------------
// Boot-time orphan-PID sweep (Phase 4d-i Task 4). Unlike `reclaimOrphans` (handed the plugins it
// should look for), `sweepOrphans` scans the FULL <runDir>/plugins/*.pid directory listing and
// targets whatever ISN'T in the currently spawn-eligible set at all (disabled/removed since the
// PID file was written) — the exact case `reclaimOrphans` can never catch on its own.
// -------------------------------------------------------------------------------------------

describe("sweepOrphans", () => {
  test("no run dir on disk yet -> no-op, never throws", () => {
    const { supervisor } = makeSupervisor();
    expect(() => supervisor.sweepOrphans([])).not.toThrow();
  });

  test("run dir exists but is empty -> no-op", () => {
    const { supervisor, dir } = makeSupervisor();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    expect(() => supervisor.sweepOrphans([])).not.toThrow();
  });

  test("a PID file for a plugin still in eligibleIds is left untouched — startAll/reclaimOrphans owns it, not the sweep", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    writeOrphanPidFile(dir, "still-enabled", 424_242);
    supervisor.sweepOrphans(["still-enabled"]);
    expect(existsSync(join(dir, "plugins", "still-enabled.pid"))).toBe(true);
    expect(signals).toEqual([]);
  });

  test("dead PID for a now-disabled plugin -> file cleaned up, no signal sent", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: () => false,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    writeOrphanPidFile(dir, "now-disabled", 999_999);
    supervisor.sweepOrphans([]); // "now-disabled" is not in the eligible set
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false);
    expect(signals).toEqual([]);
  });

  test("malformed PID file content -> treated as dead, cleaned up, no signal", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: () => true, // would be "alive" if ever checked
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", "now-disabled.pid");
    writeFileSync(pidPath, "not-a-pid");
    supervisor.sweepOrphans([]);
    expect(existsSync(pidPath)).toBe(false);
    expect(signals).toEqual([]);
  });

  test("live PID with VERIFIED matching identity for a now-disabled plugin -> terminated (SIGTERM) and PID file removed", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    writeOrphanPidFile(dir, "now-disabled", 424_242); // recorded startedAt matches the default processStartedAt fixture
    supervisor.sweepOrphans([]); // "now-disabled" not in the eligible set
    expect(signals).toEqual([{ pid: 424_242, sig: "SIGTERM" }]);
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false);
  });

  test("live PID but MISMATCHED start time (PID reuse suspected) -> fail-safe NO-KILL, file still cleaned up", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => "the-actual-live-process-start-time",
    });
    // Recorded start time (from a previous, now-dead incarnation) does NOT match the live
    // process's actual start time -> the OS almost certainly reused this pid for something else.
    writeOrphanPidFile(dir, "now-disabled", 424_242, "a-stale-recorded-start-time");
    supervisor.sweepOrphans([]);
    expect(signals).toEqual([]); // the innocent live process is left alone — never signalled
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false);
  });

  test("processStartedAt unavailable (ps errors, returns null) -> fail-safe NO-KILL, file cleaned", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => null, // simulates ps being unavailable/erroring in this environment
    });
    writeOrphanPidFile(dir, "now-disabled", 424_242, FAKE_STARTED_AT);
    supervisor.sweepOrphans([]);
    expect(signals).toEqual([]);
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false);
  });

  test("recorded startedAt of null (this core itself never stamped it) -> unverifiable, fail-safe NO-KILL", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
      processStartedAt: () => FAKE_STARTED_AT, // ps works fine NOW, but the recorded value is null
    });
    writeOrphanPidFile(dir, "now-disabled", 424_242, null);
    supervisor.sweepOrphans([]);
    expect(signals).toEqual([]);
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false);
  });

  test("legacy bare-PID file (pre-fix format) with a LIVE pid -> unverifiable, fail-safe NO-KILL, file cleaned", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 424_242, // genuinely alive — old code would have killed it outright
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const pidPath = join(dir, "plugins", "now-disabled.pid");
    writeFileSync(pidPath, "424242"); // bare PID — the pre-fix on-disk format
    supervisor.sweepOrphans([]);
    expect(signals).toEqual([]); // never signalled — no innocent-PID kill from a legacy file
    expect(existsSync(pidPath)).toBe(false);
  });

  test("a mixed sweep: a still-eligible plugin's PID file is left alone, a disabled plugin's verified orphan is swept", () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor, dir } = makeSupervisor({
      isAlivePid: (pid) => pid === 111 || pid === 222,
      signalPid: (pid, sig) => signals.push({ pid, sig }),
    });
    writeOrphanPidFile(dir, "still-enabled", 111);
    writeOrphanPidFile(dir, "now-disabled", 222);
    supervisor.sweepOrphans(["still-enabled"]);
    expect(existsSync(join(dir, "plugins", "still-enabled.pid"))).toBe(true); // untouched
    expect(existsSync(join(dir, "plugins", "now-disabled.pid"))).toBe(false); // swept
    expect(signals).toEqual([{ pid: 222, sig: "SIGTERM" }]);
  });

  test("non-.pid files in the run dir are ignored", () => {
    const { supervisor, dir } = makeSupervisor();
    mkdirSync(join(dir, "plugins"), { recursive: true });
    const stray = join(dir, "plugins", "README.txt");
    writeFileSync(stray, "not a pid file");
    expect(() => supervisor.sweepOrphans([])).not.toThrow();
    expect(existsSync(stray)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// PID file lifecycle.
// -------------------------------------------------------------------------------------------

describe("PID file lifecycle", () => {
  test("written on spawn as identity-bearing JSON (pid/pluginId/startedAt), under <runDir>/plugins/<id>.pid", () => {
    const { supervisor, dir, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(JSON.parse(readFileSync(pidPath, "utf8"))).toEqual({
      pid: spawned[0]!.proc.pid, pluginId: p.id, startedAt: FAKE_STARTED_AT,
    });
  });

  test("removed by stopAll", () => {
    const { supervisor, dir } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    expect(existsSync(pidPath)).toBe(true);
    supervisor.stopAll();
    expect(existsSync(pidPath)).toBe(false);
    expect(supervisor.status(p.id)).toBe("stopped");
  });

  test("re-written (new pid) on every restart after a crash", async () => {
    const { supervisor, dir, spawned } = makeSupervisor({
      settings: { registrationTimeoutMs: 15, backoffCapMs: 15 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    const pidPath = join(dir, "plugins", `${p.id}.pid`);
    // The fake plugin crash-loops; the supervisor REMOVES the pid file on crash and re-writes it on
    // each restart, so the old fixed `sleep(70)` + immediate read could land in the removal→rewrite
    // gap (ENOENT) or mid-rewrite (torn read) under heavy concurrent-suite load. Poll until the pid
    // file holds a RESTART pid (a spawn AFTER the first) — proving "re-written with a new pid on
    // restart" — tolerating ENOENT/torn reads.
    const deadline = Date.now() + 5000;
    let sawRestartPid = false;
    while (Date.now() < deadline && !sawRestartPid) {
      if (existsSync(pidPath)) {
        try {
          const { pid } = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number };
          if (spawned.slice(1).some((s) => s.proc.pid === pid)) sawRestartPid = true;
        } catch { /* mid-rewrite torn read — retry */ }
      }
      if (!sawRestartPid) await sleep(10);
    }
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(sawRestartPid).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// stopAll / restart().
// -------------------------------------------------------------------------------------------

describe("stopAll", () => {
  test("kills every owned process, marks stopped, fails pending invokes, clears timers", async () => {
    const signals: Array<{ pid: number; sig: string }> = [];
    const { supervisor } = makeSupervisor({ signalPid: (pid, sig) => signals.push({ pid, sig }) });
    const running = fakePlugin({ id: "running" });
    const starting = fakePlugin({ id: "starting" });
    supervisor.startAll([running, starting]);
    const conn = fakeConn();
    supervisor.notifyRegistered(running.id, conn);
    const invokePromise = supervisor.invoke(running.id, "sleep", "{}");

    supervisor.stopAll();

    expect(supervisor.status(running.id)).toBe("stopped");
    expect(supervisor.status(starting.id)).toBe("stopped");
    expect(signals.some((s) => s.sig === "SIGTERM")).toBe(true);
    expect(await invokePromise).toEqual({ code: "crashed", message: `plugin ${running.id} crashed during sleep` });
  });

  test("a late exited() after stopAll never resurrects the plugin into backoff", async () => {
    const { supervisor, spawned } = makeSupervisor();
    const p = fakePlugin();
    supervisor.startAll([p]);
    supervisor.stopAll();
    spawned[0]!.crash(1);
    await sleep(10);
    expect(supervisor.status(p.id)).toBe("stopped");
  });
});

describe("restart() (manual restart rider)", () => {
  test("forces a fresh spawn cycle from circuit-open, clearing failure history", async () => {
    const { supervisor, calls } = makeSupervisor({
      settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 1, circuitWindowMs: 600_000 },
    });
    const p = fakePlugin();
    supervisor.startAll([p]);
    await sleep(50);
    expect(supervisor.status(p.id)).toBe("circuit-open");
    const before = calls.length;

    supervisor.restart(p);
    expect(calls.length).toBe(before + 1);
    expect(supervisor.status(p.id)).toBe("starting");
  });

  test("restarts a never-before-seen plugin id too (fresh spawn)", () => {
    const { supervisor, calls } = makeSupervisor();
    const p = fakePlugin({ id: "brand-new" });
    supervisor.restart(p);
    expect(calls).toHaveLength(1);
    expect(supervisor.status(p.id)).toBe("starting");
  });
});
