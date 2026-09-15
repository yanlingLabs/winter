// P8b Task 16 (fix round 1) — the DRIVER TABLE over real 8a records, a real session store and
// hub, the real router (in-memory directory), and a FAKE `winter` peer (no child process).
//
// What only the table can prove:
//   n7  two RPCs racing a resume after a restart open ONE child (no `await` before `drivers.set`);
//   m5  a deleted session's driver is ended and evicted;
//   m6  a records store that will not answer costs the log line only — `legOf` answers undefined
//       and `ensure` undefined, never a throw (the IPC layer then refuses typed, fix wave F2);
//   R1  the store's own log is what a resume re-pushes (`unconsumed` over `store.read`).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryRuntimeDirectoryStore, createRuntimeSdk } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionTitler, TITLE_INSTRUCTION } from "../../src/agent/titles";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import type { WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import { createWinterSessionDrivers, refusalMayBeCredentialShaped, type WinterLegDeps } from "../../src/runtime-sdk/session-driver";
import { unconsumedUserMessages } from "../../src/runtime-sdk/winter-session";
import { WINTER_PEER_VERSIONS } from "../../src/runtime-sdk/versions";
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

function table(overrides: Partial<WinterLegDeps> = {}, runtimeExtra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "winter-table-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const rs = openRuntimeStateDb(home);
  const records = new RuntimeSessionRecords(rs);
  const checkpoints = new ProjectionCheckpoints(rs);
  const queries: FakeQuery[] = [];
  const sdk = createRuntimeSdk({
    peers: { winter: { ...winter, query: (({ prompt, options }: { prompt: AsyncIterable<string>; options: Options }) => { const q = new FakeQuery(prompt, options); queries.push(q); return q as unknown as Query; }) as unknown as typeof winter.query } },
    peerVersions: WINTER_PEER_VERSIONS,
    keychain: { read: async () => undefined },
    brand: CORE_BRAND,
    directoryStore: createInMemoryRuntimeDirectoryStore(),
    handoff: { winterHome: home },
  });
  const tracked: string[] = [];
  const runtime = {
    sdk,
    spawnHookFor: () => ({ pathToClaudeCodeExecutable: join(home, "winter-fake") }),
    trackQuery: (sid: string) => { tracked.push(sid); },
    untrack: () => {},
    // WS-19 (review Minor 2): a test may inject `selectRuntimeFor` to drive `decideRuntime`'s
    // refusal path. Absent by default, which is `decideRuntime`'s own bail-out #1 (a partial
    // double) and what every other test in this file relies on.
    ...runtimeExtra,
  } as unknown as WinterRuntimeSdk;
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

  test("m6: a records store that throws makes `legOf` undefined and `ensure` undefined — logged, never thrown", async () => {
    const t = table({ records: { get: () => { throw new Error("db closed"); } } as unknown as RuntimeSessionRecords });
    try {
      expect(t.drivers.legOf("s_any")).toBeUndefined();
      expect(await t.drivers.ensure("s_any")).toBeUndefined();
      expect(t.logs.some((l) => l.includes("unreadable"))).toBe(true);
    } finally { t.close(); }
  });

  test("fix wave (review row 4): the titler is fired after the main thread's turn_completed — once per completed turn, never before the result, never on an error terminal", async () => {
    const titled: string[] = [];
    const t = table({ titler: { maybeTitle: async (sid) => { titled.push(sid); } } });
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      await session.send("hello", "cli");
      t.q().emit({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
      await Bun.sleep(10);
      expect(titled).toEqual([]);   // nothing until the turn has completed
      t.q().emit(result());
      await Bun.sleep(10);
      expect(titled).toEqual([sid]);
      expect(t.store.read(sid).filter((e) => e.type === "turn_completed")).toHaveLength(1);
      // the second turn fires it again — `maybeTitle` is what dedupes (store title guard), exactly
      // as the engine fired it at every depth-0 completion
      await session.send("again", "cli");
      t.q().emit(result());
      await Bun.sleep(10);
      expect(titled).toEqual([sid, sid]);
      // an ERROR terminal does not: the child dies mid-turn → turn_completed(error) + agent_error
      await session.send("boom", "cli");
      t.q().fail(Object.assign(new Error("child crashed"), { name: "Error" }));
      await session.done;
      expect(t.store.read(sid).filter((e) => e.type === "turn_completed").map((e) => (e as { stopReason: string }).stopReason)).toEqual(["end_turn", "end_turn", "error"]);
      expect(titled).toEqual([sid, sid]);
    } finally { t.close(); }
  });

  test("fix wave (review row 4): the REAL SessionTitler over the existing FakeProvider double titles a Winter-leg session once, on Winter's own provider layer (P8b-10)", async () => {
    const provider = new FakeProvider([[{ type: "text_delta", delta: "Greeting the daemon" }, { type: "done", stopReason: "end_turn" }]]);
    let titler!: SessionTitler;
    const t = table({ titler: { maybeTitle: (sid) => titler.maybeTitle(sid) } });
    titler = new SessionTitler({ provider: { provider, model: "fake-1" }, store: t.store, hub: t.hub });
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      await session.send("hello there", "cli");
      t.q().emit({ type: "assistant", message: { content: [{ type: "text", text: "hi from winter" }] } });
      t.q().emit(result());
      await Bun.sleep(30);
      // ONE provider call, on Winter's provider layer, with the title instruction and the turn's pair
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.instructions).toBe(TITLE_INSTRUCTION);
      const content = JSON.stringify(provider.requests[0]!.input[0]);
      expect(content).toContain("hello there");
      expect(content).toContain("hi from winter");
      expect(t.store.getTitle(sid)).toBe("Greeting the daemon");
      expect(t.store.read(sid).filter((e) => e.type === "session_titled")).toHaveLength(1);
      // a second completed turn never re-titles (the store's title guard)
      await session.send("more", "cli");
      t.q().emit(result());
      await Bun.sleep(30);
      expect(provider.requests).toHaveLength(1);
      await session.end();
    } finally { t.close(); }
  });

  test("fix wave (review row 7): configured MCP servers ride the session's Options.mcpServers beside the capability servers; a daemon-owned name collides → a TYPED refusal naming it, no child", async () => {
    const t = table({
      buildSessionCapabilities: () => ({ "winter__browser": { type: "sdk", name: "winter__browser", instance: {} } }),
      extraMcpServers: (session) => ({ fake: { type: "stdio", command: "bun", args: ["run", "fake.ts", session.cwd] } }),
    });
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", cwd: "/repo" });
      const session = await t.drivers.create(sid);
      const servers = t.q().options.mcpServers as Record<string, unknown>;
      expect(Object.keys(servers).sort()).toEqual(["fake", "winter__browser"]);
      expect(servers.fake).toEqual({ type: "stdio", command: "bun", args: ["run", "fake.ts", "/repo"] });
      await session.end();
    } finally { t.close(); }
    const spawnsBefore: number[] = [];
    const c = table({
      buildSessionCapabilities: () => ({ "winter__browser": { type: "sdk", name: "winter__browser", instance: {} } }),
      extraMcpServers: () => ({ "winter__browser": { type: "stdio", command: "evil" } }),
    });
    try {
      spawnsBefore.push(c.queries.length);
      const sid = c.store.createSession("t", { mode: "code", model: "winter-test/echo", cwd: "/repo" });
      let refused: unknown;
      try { await c.drivers.create(sid); } catch (err) { refused = err; }
      expect((refused as { code?: string })?.code).toBe("winter_leg_unavailable");
      expect(String((refused as Error).message)).toContain("winter__browser");
      expect(c.queries.length).toBe(spawnsBefore[0]!);   // no child was spawned for a refused session
      expect(c.drivers.get(sid)).toBeUndefined();
    } finally { c.close(); }
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WS-19 (W19-7, review Minor 2) — WHICH router refusals may be re-described as `no-credential`.
//
// `refusalForSelection` answers a credential-shaped refusal with Winter's own actionable sentence
// (the provider and the three doors) instead of the router's "every candidate row was blocked,
// deprecated, known-unservable, or …". Before Minor 2 it did that for ANY refusal whenever the
// credential probe happened to find an empty slot — so a session refused because a RUNTIME is not
// installed would have been told to add an API key that would not have helped.
//
// Every test here runs on a store with NO credentials at all, which is the state that made the old
// code relabel: the probe finds nothing either way, so only the REASON can tell the two apart.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("refusalForSelection — only credential-shaped reasons are re-described (Minor 2)", () => {
  const refusalOf = (reason: string, detail: string) => async () => ({ refused: true as const, reason, detail });

  test("refusalMayBeCredentialShaped is an ALLOWLIST of the two reasons a missing credential produces", () => {
    // MEASURED against the pinned router: a Claude-family model with no credential answers
    // `no-credential`; EVERY other family answers `slot-unservable` for the identical situation.
    expect(refusalMayBeCredentialShaped("no-credential")).toBe(true);
    expect(refusalMayBeCredentialShaped("slot-unservable")).toBe(true);
    for (const reason of ["runtime-unavailable", "mode-forbids-runtime", "claude-oauth-not-approved", "some-reason-a-later-router-adds"]) {
      expect(refusalMayBeCredentialShaped(reason)).toBe(false);
    }
  });

  // Whole-branch review MAJOR 2 FLIPPED THIS PIN. It used to assert `message === detail` — i.e. it
  // PINNED the leak: `session.create` handed the router's own words to the user, and
  // `session.create` is remote-allowed, so the measured shapes ("the official runtime", "persisted
  // on claude-agent (…) (WS-00 §2, D13)", and `slot-unservable`'s enumeration of the user's own
  // configured providers) were reaching the phone. The REASON still travels — a client branches on
  // `data.reason`, never on prose — but the words are Winter's.
  const ROUTER_PHRASING = /\bruntime\b|winter-agent|claude-agent|WS-\d|D\d\d\b|\(D28\)/i;

  test("a Claude model refused for a NON-credential reason keeps its REASON, and never the router's words", async () => {
    const detail = "this session is persisted on claude-agent (the official runtime) and the winter runtime cannot serve it (WS-00 §2, D13)";
    const t = table({}, { selectRuntimeFor: refusalOf("runtime-unavailable", detail) });
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "claude-sonnet-5" });
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe("runtime_selection_refused");
      expect((caught as { reason?: string })?.reason).toBe("runtime-unavailable");
      // The machine-readable half survives; the prose does not.
      expect((caught as Error)?.message).toBe("Winter can't start a session on claude-sonnet-5 right now.");
      expect((caught as Error)?.message).not.toMatch(ROUTER_PHRASING);
      expect((caught as Error)?.message).not.toContain(detail);
      // ...and it is not Winter's credential sentence either, which would send the user to a door
      // that would not have helped.
      expect((caught as Error)?.message).not.toContain("winter credentials set");
    } finally { t.close(); }
  });

  test("slot-unservable's enumeration of the user's OWN configured providers never reaches the wire", async () => {
    // The measured shape, verbatim from the pinned router: it names every provider the user has a
    // credential for. That is a fact about someone's setup, and `session.create` is remote-allowed.
    const detail = 'the model "gpt-5.6-sol" (openai/gpt-5.6-sol) is served by no row this session can use: every candidate row was blocked, deprecated, known-unservable, or belongs to a provider with no configured credential ref (configured: openai, openrouter, deepseek)';
    const t = table({}, { selectRuntimeFor: refusalOf("slot-unservable", detail) });
    try {
      // A BARE id six inventory providers serve: Minor 1's narrowing means no provider is named
      // either, because Winter decided nothing.
      const sid = t.store.createSession("t", { mode: "chat", model: "gpt-5.6-sol" });
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      const message = (caught as Error)?.message ?? "";
      expect(message).toBe("Winter can't start a session on gpt-5.6-sol right now.");
      for (const leaked of ["openrouter", "deepseek", "configured:", "candidate row"]) {
        expect(message).not.toContain(leaked);
      }
      expect(message).not.toMatch(ROUTER_PHRASING);
    } finally { t.close(); }
  });

  test("the SAME keyless home, refused `slot-unservable`, DOES get Winter's actionable sentence — W19-7's own case", async () => {
    const t = table({}, { selectRuntimeFor: refusalOf("slot-unservable", "every candidate row … (configured: none)") });
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "deepseek/deepseek-reasoner" });
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      expect((caught as { reason?: string })?.reason).toBe("no-credential");
      expect((caught as Error)?.message).toContain("winter credentials set deepseek");
    } finally { t.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WS-19 (review N2) — THE REPLAY PATH IS GATED TOO.
//
// `open()` re-pushes what the log still owes (an interrupted or held `user_message`) and any
// delivery held while the session was resumable. Those are real turns, and `send` gates itself
// BEFORE calling `open()` — but this path is reached with the driver table EMPTY (a daemon restart,
// an idle reap, or the eviction `credential.set`/`credential.remove` now performs), which is exactly
// the window in which a credential can have changed underneath. Before this, the owed text ran
// ungated against a provider whose key had been removed and only the NEXT text was refused.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("open()'s replay passes the pre-turn credential gate (N2)", () => {
  test("an owed user_message is NOT replayed against a provider with no credential — a typed refusal, and no child", async () => {
    const t = table();
    try {
      // A `winter-test/*` model is never gated (it is selected by env var, not by the catalog), so
      // the session is created and driven normally.
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      await session.send("A", "cli");        // pushed; its turn is begun
      const held = await session.send("B", "cli");
      expect(held.queued).toBe(true);        // in the log, with no turn of its own — the OWED text
      // The session's model now names a provider with an empty slot — the same state a
      // `credential.remove` leaves behind — and the driver is EVICTED, which is what
      // `credential.set`/`credential.remove` now do to every live child on the affected provider
      // (and what a daemon restart or an idle reap does anyway). `end()` alone leaves the driver in
      // the table, and `ensure` then hands it back without re-opening: the replay path needs an
      // EMPTY table, which is precisely the window N2 is about.
      t.store.setModel(sid, "deepseek/deepseek-reasoner");
      await t.drivers.evict(sid);
      const spawnsBefore = t.queries.length;

      // The next `ensure` re-opens from the record — and the replay is gated.
      let caught: unknown;
      try { await t.drivers.ensure(sid); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe("runtime_selection_refused");
      expect((caught as { reason?: string })?.reason).toBe("no-credential");
      // NO CHILD was spawned for the replay: the gate runs before the query is created.
      expect(t.queries.length).toBe(spawnsBefore);
      // ...and the owed text is still owed — nothing was consumed by the refusal.
      expect(unconsumedUserMessages(t.store.read(sid))).toEqual(["B"]);
    } finally { t.close(); }
  });

  test("a fresh create with nothing owed never consults the gate on the open path", async () => {
    // The cost of N2 on the hot path is zero: `create()` opens with an empty log.
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "deepseek/deepseek-reasoner" });
      const session = await t.drivers.create(sid);
      expect(t.queries.length).toBe(1);   // the child spawned; the gate had nothing to gate
      await session.end();
    } finally { t.close(); }
  });
});
