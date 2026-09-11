// P8b Task 16 (fix round 1) — the DRIVER TABLE over real 8a records, a real session store and
// hub, the real router (in-memory directory), and a FAKE `winter` peer (no child process).
//
// What only the table can prove:
//   n7  two RPCs racing a resume after a restart open ONE child (no `await` before `drivers.set`);
//   m5  a deleted session's driver is ended and evicted;
//   m6  a records store that will not answer costs the log line only — `legOf`/`ensure` take the
//       engine path, never throw;
//   R1  the store's own log is what a resume re-pushes (`unconsumed` over `store.read`).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryRuntimeDirectoryStore, createRuntimeSdk } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { FileSecretStore } from "../../src/auth/secret-store";
import { NORMA_BRAND } from "../../src/runtime-sdk/brand";
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { createWinterSessionDrivers, type WinterLegDeps } from "../../src/runtime-sdk/session-driver";
import { NORMA_PEER_VERSIONS } from "../../src/runtime-sdk/versions";
import { backfillNativeSessions, openRuntimeStateDb, ProjectionCheckpoints, RuntimeSessionRecords } from "../../src/runtime-state";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import type { Settings } from "../../src/settings";

type Frame = Record<string, unknown>;

/** The wire, minimal: frames a test emits, texts the driver pushed. Ends on stdin close. */
class FakeQuery {
  readonly pushed: string[] = [];
  results = 0;
  private readonly buffer: Frame[] = [];
  private waiter: ((r: IteratorResult<Frame>) => void) | undefined;
  private rejecter: ((e: unknown) => void) | undefined;
  private terminal: { done: true } | { error: unknown } | undefined;
  readonly messaging = {
    listReachable: async () => [], deliver: async () => { throw new Error("never"); },
    steerChild: async () => { throw new Error("never"); }, resumeChild: async () => { throw new Error("never"); },
    subscribeIdle: async () => { throw new Error("never"); }, senderClass: async () => "prompts" as const,
    readNotifications: async () => ({ notifications: [], remaining: 0 }), onIdleNotice: () => () => {},
  };
  constructor(prompt: AsyncIterable<string>, readonly options: Options) {
    options.abortController?.signal.addEventListener("abort", () => this.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    // Like the binary (measured): an IDLE child exits when its stdin closes; one mid-turn never
    // does — `end()` aborts it and the aborted terminal comes from `acceptError`.
    void (async () => { for await (const t of prompt) this.pushed.push(t); if (this.results >= this.pushed.length) this.end(); })();
    this.buffer.push({ type: "system", subtype: "init", session_id: options.resume ?? options.sessionId, model: "winter-test/echo", tools: [], cwd: options.cwd });
  }
  emit(frame: Frame): void { if (frame.type === "result") this.results++; if (this.waiter) { const w = this.waiter; this.waiter = undefined; this.rejecter = undefined; w({ value: frame, done: false }); } else this.buffer.push(frame); }
  end(): void { if (this.terminal) return; this.terminal = { done: true }; this.settle(); }
  fail(error: unknown): void { if (this.terminal) return; this.terminal = { error }; this.settle(); }
  private settle(): void {
    if (!this.waiter) return;
    const w = this.waiter, r = this.rejecter!; this.waiter = undefined; this.rejecter = undefined;
    if (this.terminal && "error" in this.terminal) r(this.terminal.error); else w({ value: undefined as never, done: true });
  }
  next(): Promise<IteratorResult<Frame>> {
    const b = this.buffer.shift();
    if (b !== undefined) return Promise.resolve({ value: b, done: false });
    if (this.terminal) return "error" in this.terminal ? Promise.reject(this.terminal.error) : Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => { this.waiter = resolve; this.rejecter = reject; });
  }
  return(): Promise<IteratorResult<Frame>> { this.end(); return Promise.resolve({ value: undefined as never, done: true }); }
  throw(e: unknown): Promise<IteratorResult<Frame>> { this.fail(e); return Promise.reject(e); }
  [Symbol.asyncIterator](): this { return this; }
  async interrupt(): Promise<void> { this.emit({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "", interrupted: true }); }
  async setModel(): Promise<void> {}
}

const result = (): Frame => ({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "" });

function table(overrides: Partial<WinterLegDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "norma-winter-table-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const rs = openRuntimeStateDb(home);
  const records = new RuntimeSessionRecords(rs);
  const checkpoints = new ProjectionCheckpoints(rs);
  const queries: FakeQuery[] = [];
  const sdk = createRuntimeSdk({
    peers: { winter: { ...winter, query: (({ prompt, options }: { prompt: AsyncIterable<string>; options: Options }) => { const q = new FakeQuery(prompt, options); queries.push(q); return q as unknown as Query; }) as unknown as typeof winter.query } },
    peerVersions: NORMA_PEER_VERSIONS,
    keychain: { read: async () => undefined },
    brand: NORMA_BRAND,
    directoryStore: createInMemoryRuntimeDirectoryStore(),
    handoff: { winterHome: home },
  });
  const tracked: string[] = [];
  const runtime = {
    sdk,
    spawnHookFor: () => ({ pathToClaudeCodeExecutable: join(home, "winter-fake") }),
    trackQuery: (sid: string) => { tracked.push(sid); },
    untrack: () => {},
  } as unknown as NormaRuntimeSdk;
  const settings = { runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } } as unknown as Settings;
  const logs: string[] = [];
  const drivers = createWinterSessionDrivers({
    home, settings: () => settings, runtime, records, checkpoints, store, hub,
    secrets: new FileSecretStore(join(home, "secrets.json")),
    buildSessionCapabilities: () => ({}),
    approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(),
    rootsOf: () => [], tmpDirOf: () => home, outDirOf: () => home, memoryKeyOf: () => "k",
    idleTimeoutMs: () => 60_000, endGraceMs: 20,
    log: (line) => { logs.push(line); },
    ...overrides,
  });
  const close = (): void => { try { store.close(); } catch { /* closed */ } try { rs.close(); } catch { /* closed */ } rmSync(home, { recursive: true, force: true }); };
  return { home, store, hub, records, drivers, queries, tracked, logs, close, q: () => queries[queries.length - 1]! };
}

describe("createWinterSessionDrivers — the table", () => {
  test("create: the record (leg winter, backend uuid), one child, tracked; the driver is in the table", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      expect(t.drivers.get(sid)).toBe(session);
      expect(t.drivers.legOf(sid)).toBe("winter");
      expect(t.records.get(sid)?.backendSessionId).toBe(session.backendSessionId);
      expect(t.queries).toHaveLength(1);
      expect(t.q().options.sessionId).toBe(session.backendSessionId);
      expect(t.tracked).toEqual([sid]);
      await session.end();
    } finally { t.close(); }
  });

  test("n7: two RPCs racing a resume open ONE child — `ensure` is synchronous up to `drivers.set`", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const created = await t.drivers.create(sid);
      await created.end();
      expect(created.state).toBe("resumable");
      // A "restart": a second table over the SAME store and records knows no driver — its first
      // two `ensure`s race the resume.
      const spawnsBefore = t.queries.length;
      const again = table({ records: t.records, store: t.store, hub: t.hub, home: t.home });
      try {
        const [a, b] = await Promise.all([again.drivers.ensure(sid), again.drivers.ensure(sid)]);
        expect(a).toBeDefined();
        expect(a).toBe(b);
        expect(again.queries).toHaveLength(1);
        expect(t.queries).toHaveLength(spawnsBefore);
        expect(a!.state).toBe("live");
        expect(a!.resumed).toBe(false);   // no transcript was ever written by the fake: fresh under the same uuid
        expect(again.q().options.sessionId).toBe(created.backendSessionId);
        await a!.end();
      } finally { again.close(); }
    } finally { t.close(); }
  });

  test("m5: evict ends the session's child (bounded) and forgets the driver", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      const t0 = Date.now();
      await t.drivers.evict(sid);
      expect(Date.now() - t0).toBeLessThan(200);
      expect(session.state).toBe("resumable");
      expect(t.drivers.get(sid)).toBeUndefined();
      expect(t.drivers.list()).toEqual([]);
      await t.drivers.evict("s_never");   // unknown: a no-op, never throws
    } finally { t.close(); }
  });

  test("re-review N3: a live-created engine-leg record and 8a's boot backfill agree on transcriptProjectKey/backendRoot for a cwd-less session", () => {
    const t = table({ settings: () => ({ runtimes: { winterLeg: { chat: false, dispatch: false, code: false } } } as unknown as Settings) });
    try {
      const live = t.store.createSession("t", { mode: "chat" });
      t.drivers.recordEngineCreation(live);
      const backfilled = t.store.createSession("t", { mode: "chat" });
      const rs = openRuntimeStateDb(t.home);
      try { backfillNativeSessions({ rs, store: t.store, home: t.home, providerId: "unstated" }); } finally { rs.close(); }
      const a = t.records.get(live)!;
      const b = t.records.get(backfilled)!;
      expect(a.backendSessionId).toBeUndefined();
      expect(b.backendSessionId).toBeUndefined();
      expect(a.transcriptProjectKey).toBe(b.transcriptProjectKey);
      expect(a.backendRoot).toBe(b.backendRoot);
      expect(a.tempProjectKey).toBe(b.tempProjectKey);
    } finally { t.close(); }
  });

  test("m6: a records store that throws makes `legOf` undefined and `ensure` the engine's — logged, never thrown", async () => {
    const t = table({ records: { get: () => { throw new Error("db closed"); } } as unknown as RuntimeSessionRecords });
    try {
      expect(t.drivers.legOf("s_any")).toBeUndefined();
      expect(await t.drivers.ensure("s_any")).toBeUndefined();
      expect(t.logs.some((l) => l.includes("unreadable"))).toBe(true);
    } finally { t.close(); }
  });

  test("R1 (P8b-39): a resume re-pushes what the STORE's log still owes — a send held behind a turn at end() runs first, with exactly one turn_started", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      await session.send("A", "cli");
      const b = await session.send("B", "cli");
      expect(b.queued).toBe(true);
      await session.end();   // A's turn was hanging: aborted; B never pushed
      const before = t.store.read(sid).map((e) => e.type).filter((x) => x === "user_message" || x === "turn_started" || x === "turn_completed");
      expect(before).toEqual(["user_message", "turn_started", "user_message", "turn_completed"]);
      await session.send("C", "cli");
      expect(t.queries).toHaveLength(2);
      expect(t.q().pushed).toEqual(["B"]);
      expect(session.pendingSends).toEqual(["C"]);
      const after = t.store.read(sid).map((e) => e.type).filter((x) => x === "user_message" || x === "turn_started" || x === "turn_completed");
      expect(after).toEqual(["user_message", "turn_started", "user_message", "turn_completed", "turn_started", "user_message"]);
      t.q().emit(result());
      await Bun.sleep(10);
      expect(t.q().pushed).toEqual(["B", "C"]);
      await session.end();
    } finally { t.close(); }
  });
});
