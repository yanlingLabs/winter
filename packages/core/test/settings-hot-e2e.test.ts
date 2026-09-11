import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { FileSecretStore } from "../src/auth/secret-store";
import { FakeProvider } from "../src/agent/fake-provider";
import type { ProviderEvent } from "../src/providers/types";

// hot-settings T5b (final task of the track): the payoff e2e — flipping computerUse.enabled (and
// lsp.enabled) in settings.json changes the tools a SESSION is offered within ONE running daemon,
// no restart. The daemon here runs IN-PROCESS (same process.pid as this test file) — the no-restart
// proof is NOT a pid check, it's that `daemon` (captured from a SINGLE `startDaemon` call per test)
// is never re-created, yet its offered tool set changes live as settings.json is rewritten on disk.
//
// Mirrors server.test.ts's own TestClient/boot pattern — duplicated, not imported (same "each
// *.test.ts carries its own copy" convention every daemon-IPC test file in this directory follows;
// see daemon-memory-rpc.test.ts's doc comment for the precedent).

/** Minimal raw test client speaking NDJSON JSON-RPC. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
        drain(_s) {
          c.writer.onDrain();
        },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }

  /** Count of `turn_completed` events observed so far — the polling primitive below diffs against
   *  this rather than re-matching `waitForNotification`'s first hit (which would immediately
   *  resolve to an ALREADY-seen turn_completed on every subsequent poll of the SAME session). */
  completedTurns(): number {
    return this.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Overwrites home/settings.json wholesale (schemaVersion + a dummy provider block the harness
 *  needs to satisfy Settings' schema, since `loadSettings`/the watcher's reload both validate
 *  against it) merged with `overrides` — the SAME shape server.test.ts's `boot(settingsOverride)`
 *  writes once at boot; here it's called AGAIN mid-test to drive the live settings-watcher reload.
 *  `titles: {enabled:false}` is baked into the base (not an override): SessionTitler's
 *  `maybeTitle` fires fire-and-forget on a session's first message (engine.ts, depth 0) against
 *  the SAME shared `FakeProvider` instance the turn itself streams from — left on, its title-gen
 *  call races the turn's own call for the SAME script queue (FakeProvider serves script entries
 *  in whatever order streamTurn is invoked), making `fake.requests[n]` unpredictable. Same
 *  precedent as server.test.ts's own `settingsOverride` doc comment calls out for the reviewer.
 *  `toolSearch: {enabled:false}` is also baked into the base: ToolSearch deferral is default-ON
 *  (engine.ts's `toolSearchEnabled()` — `cfg.toolSearch` is always set by daemon.ts, so an absent
 *  `settings.toolSearch.enabled` resolves `!== false` to true) and the single `lsp` tool is
 *  registered `deferred: true` (agent/tools/lsp.ts) — left on, it'd never appear in `req.tools` at
 *  all (deferred out to the "# Deferred tools" instructions section instead), which is a confound
 *  unrelated to what this suite is testing (live enable/disable, not ToolSearch's own deferral). */
function writeSettingsFile(home: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      titles: { enabled: false },
      toolSearch: { enabled: false },
      ...overrides,
    }, null, 2) + "\n",
  );
}

/** Sends a message and waits for the NEXT `turn_completed` (by count, not by first-match — see
 *  `completedTurns` above), bounded by `timeoutMs`. Throws on timeout so a stuck daemon fails the
 *  test loudly instead of hanging past bun's own test timeout with a less specific message. */
async function driveTurn(c: TestClient, sessionId: string, text: string, timeoutMs = 5000): Promise<void> {
  const before = c.completedTurns();
  await c.request(METHODS.sessionSend, { sessionId, text });
  const deadline = Date.now() + timeoutMs;
  while (c.completedTurns() <= before) {
    if (Date.now() > deadline) throw new Error("timed out waiting for turn_completed");
    await sleep(10);
  }
}

function endTurnScript(): ProviderEvent[][] {
  return [[
    { type: "text_delta", delta: "ok" },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
    { type: "done", stopReason: "end_turn" },
  ]];
}

describe("hot-settings T5b e2e: SettingsWatcher wired into a running daemon", () => {
  let daemon: RunningDaemon | undefined;

  afterEach(() => daemon?.stop());

  test("flipping computerUse.enabled registers the computer tool live, no restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-hot-e2e-cu-"));
    writeSettingsFile(home, { computerUse: { enabled: false } });
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider(endTurnScript());

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const daemonRef = daemon; // captured ONCE — never reassigned, never a second startDaemon() call

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "e2e-cu");
    const cwd = mkdtempSync(join(tmpdir(), "norma-hot-e2e-cu-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "hello");
    expect(fake.requests.length).toBeGreaterThanOrEqual(1);
    expect(fake.requests[0]!.tools?.map((t) => t.name)).not.toContain("computer");

    // Rewrite settings.json — the SAME daemon (same fs.watch handle, same registry/engine) must
    // pick this up with no restart.
    writeSettingsFile(home, { computerUse: { enabled: true } });

    // Condition-based poll (never a bare fixed sleep): drive a turn, check the LATEST captured
    // request's tools, retry until the debounce+apply has landed or ~5s elapses.
    let sawComputer = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await driveTurn(c, created.sessionId, "poll");
      const latest = fake.requests[fake.requests.length - 1];
      if (latest?.tools?.some((t) => t.name === "computer")) { sawComputer = true; break; }
      await sleep(100);
    }
    expect(sawComputer).toBe(true);

    // No-restart proof: still the exact same RunningDaemon object/socket this test started with.
    expect(daemon).toBe(daemonRef);
    expect(daemon.socketPath).toBe(daemonRef.socketPath);

    c.close();
  });

  test("a torn settings.json write does not crash the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-hot-e2e-torn-"));
    writeSettingsFile(home); // computerUse absent → disabled
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider(endTurnScript());

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "e2e-torn");
    const cwd = mkdtempSync(join(tmpdir(), "norma-hot-e2e-torn-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "hello");
    const before = fake.requests[fake.requests.length - 1]!.tools?.map((t) => t.name).sort();

    // Torn write: invalid JSON. The watcher's reload must log-and-keep-last-good, never crash the
    // process or the fs.watch handle.
    writeFileSync(join(home, "settings.json"), "{ not valid json ][");

    // Wait past the debounce (default 150ms) before proving the daemon is still alive.
    await sleep(400);

    // The daemon must still be responsive: a turn started AFTER the torn write completes normally.
    await driveTurn(c, created.sessionId, "still alive?");
    const after = fake.requests[fake.requests.length - 1]!.tools?.map((t) => t.name).sort();
    expect(after).toEqual(before); // tool set unchanged by the torn write

    c.close();
  });

  test("LSP disable: writing lsp.enabled:false unregisters the lsp tool live", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-hot-e2e-lsp-"));
    writeSettingsFile(home); // lsp absent → default ON
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider(endTurnScript());

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "e2e-lsp");
    const cwd = mkdtempSync(join(tmpdir(), "norma-hot-e2e-lsp-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    await driveTurn(c, created.sessionId, "hello");
    expect(fake.requests[0]!.tools?.map((t) => t.name)).toContain("lsp");

    writeSettingsFile(home, { lsp: { enabled: false } });

    let lspGone = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await driveTurn(c, created.sessionId, "poll");
      const names = fake.requests[fake.requests.length - 1]!.tools?.map((t) => t.name) ?? [];
      if (!names.includes("lsp")) {
        lspGone = true;
        break;
      }
      await sleep(100);
    }
    expect(lspGone).toBe(true);

    c.close();
  });
});

// ── P8b Task 15: the Winter-leg settings, hot on a RUNNING daemon ────────────────────────────────
//
// The hard rule is that no setting may ever require a daemon restart, and these four keys are the
// awkward case for it: their consumers land in LATER tasks (Task 5's `spawnHookFor`/`create.ts`,
// Task 9's `legForNewSession`, Task 16's idle timer), so there is no tool appearing or disappearing
// to observe the way the computerUse/lsp tests above do. What CAN be observed today is the thing all
// of those consumers read — the live settings holder the watcher swaps — so that is what these
// assert, through `daemon.settings()`, on one `startDaemon` that is never re-created.
describe("hot-settings P8b: the Winter-leg keys reach the live holder with no restart", () => {
  let daemon: RunningDaemon | undefined;

  // CLEARED, not just stopped: a later test that throws before its own `startDaemon` lands would
  // otherwise stop this already-stopped handle a second time.
  afterEach(async () => { const stopping = daemon?.stop(); daemon = undefined; await stopping; });

  /** Polls the live holder past the watcher's debounce (150ms) + fs.watch latency — never a bare
   *  fixed sleep. Fails loudly with what it was waiting for rather than timing out anonymously. */
  async function untilSettings(d: RunningDaemon, what: string, ok: (s: ReturnType<RunningDaemon["settings"]>) => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (ok(d.settings())) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; live settings.runtimes = ${JSON.stringify(d.settings()?.runtimes)}`);
      await sleep(25);
    }
  }

  test("winterLeg.chat, winterExecutable, winterIdleTimeoutSec and retention all flip live on ONE daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-hot-e2e-winter-"));
    writeSettingsFile(home); // no `runtimes` block at all — the shipped default
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider(endTurnScript());

    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    const daemonRef = daemon; // captured ONCE — never reassigned, never a second startDaemon() call

    // An absent block is the default state every consumer must answer for itself.
    expect(daemon.settings()?.runtimes).toBeUndefined();

    // The `winter` binary the setting points at: a real file, so Task 2's resolver would accept it.
    const winterBin = join(mkdtempSync(join(tmpdir(), "norma-hot-e2e-winter-bin-")), "winter");
    writeFileSync(winterBin, "#!/bin/sh\nexit 0\n");

    writeSettingsFile(home, {
      runtimes: {
        winterLeg: { chat: true },
        winterExecutable: winterBin,
        winterIdleTimeoutSec: 60,
        retention: { deliveriesDays: 90 },
      },
    });

    await untilSettings(daemon, "the runtimes block to reach the live holder", (s) => s?.runtimes?.winterLeg?.chat === true);
    const live = daemon.settings()!.runtimes!;
    // Task 9's `legForNewSession` reads exactly this; the helper itself is the policy lane's.
    expect(live.winterLeg).toEqual({ chat: true, dispatch: true, code: false });
    // Task 5's `spawnHookFor` resolves this; here the assertion stops at the parsed setting.
    expect(live.winterExecutable).toBe(winterBin);
    expect(live.winterIdleTimeoutSec).toBe(60);
    // Retention: the one key whose consumer IS live today (the hourly sweep reads it per pass).
    expect(live.retention).toEqual({ deliveriesDays: 90, nameLeasesDays: 7 });

    // Flipping a leg back OFF is just as hot — a rollback must not need a restart either.
    writeSettingsFile(home, { runtimes: { winterLeg: { chat: false }, winterIdleTimeoutSec: 60 } });
    await untilSettings(daemon, "the chat leg to flip back off", (s) => s?.runtimes?.winterLeg?.chat === false);

    // The session the daemon was serving all along still works — the reload re-wired nothing it owns.
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "e2e-winter");
    const cwd = mkdtempSync(join(tmpdir(), "norma-hot-e2e-winter-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await driveTurn(c, created.sessionId, "still alive?");

    // No-restart proof: the same RunningDaemon object and the same socket this test started with.
    expect(daemon).toBe(daemonRef);
    expect(daemon.socketPath).toBe(daemonRef.socketPath);
    c.close();
  });

  test("advisorModel reaches the live holder too — Task 5's create.ts reads it there", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-hot-e2e-advisor-"));
    writeSettingsFile(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: new FakeProvider(endTurnScript()), model: "fake-1" } });

    expect(daemon.settings()?.runtimes?.advisorModel).toBeUndefined();
    writeSettingsFile(home, { runtimes: { advisorModel: "some-advisor-model" } });
    await untilSettings(daemon, "advisorModel to reach the live holder", (s) => s?.runtimes?.advisorModel === "some-advisor-model");
  });
});
