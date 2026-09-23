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
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { storeHomeFor, storeProjectsDir } from "../../src/agent/paths";
import { Database } from "bun:sqlite";
import { migrationCManifestPath, migrationCState, rollbackMigrationC } from "../../src/migration/migrate-c";
import { setRunHomeSupportForTests } from "../../src/runtime-sdk/run-home-support";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryRuntimeDirectoryStore, createRuntimeSdk } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { FakeProvider } from "../../src/agent/fake-provider";
import { SessionTitler, TITLE_INSTRUCTION } from "../../src/agent/titles";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { CORE_BRAND } from "../../src/runtime-sdk/brand";
import type { WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import { createWinterSessionDrivers, refusalMayBeCredentialShaped, type WinterLegDeps } from "../../src/runtime-sdk/session-driver";
import { updateSdkSettings } from "../../src/sdk-files";
import { evictSessionsForCredential } from "../../src/runtime-sdk/credentials";
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
  // Daemon settings surface (2026-09-17 plan, item 3): a canned answer — real enough to prove
  // `onSupportedAgents` actually reaches this exact value, never a shape check on a mock call.
  async supportedAgents() { return [{ name: "Explore", description: "read-only search" }]; }
}

const result = (): Frame => ({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "" });

function table(overrides: Partial<WinterLegDeps> = {}, runtimeExtra: Record<string, unknown> = {}, wrapSdk?: (sdk: ReturnType<typeof createRuntimeSdk>) => ReturnType<typeof createRuntimeSdk>) {
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
    sdk: wrapSdk === undefined ? sdk : wrapSdk(sdk),
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

  // Daemon settings surface (2026-09-17 plan, item 3): end-to-end through the REAL `optionsFor`
  // path (not just `buildWinterOptions` in isolation, mode-matrix.test.ts's job) — a real
  // `<home>/agents/*.md` file, written to the driver table's own `home` BEFORE the session is
  // created, reaches the child's `Options.agents` verbatim.
  test("item 3: a real <home>/agents/*.md file reaches the child's Options.agents", async () => {
    const t = table();
    try {
      mkdirSync(join(t.home, "agents"), { recursive: true });
      writeFileSync(
        join(t.home, "agents", "reviewer.md"),
        ["---", "name: code-reviewer", "description: Reviews code for bugs", "---", "", "You review code."].join("\n"),
      );
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      expect(t.q().options.agents).toEqual({ "code-reviewer": { description: "Reviews code for bugs", prompt: "You review code." } });
      await session.end();
    } finally { t.close(); }
  });

  test("item 3: no agents/ directory at all -> no Options.agents key, unchanged from before this fix", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      expect(t.q().options.agents).toBeUndefined();
      await session.end();
    } finally { t.close(); }
  });

  test("item 3: onSupportedAgents fires with the LIVE query's own answer, bound to this session's id", async () => {
    const observed: Array<{ sessionId: string; agents: unknown }> = [];
    const t = table({ onSupportedAgents: (sessionId, agents) => { observed.push({ sessionId, agents }); } });
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      // Fire-and-forget (winter-session.ts's own doc comment) — poll rather than assume it landed
      // synchronously with `create()`'s own return.
      const deadline = Date.now() + 1000;
      while (observed.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(observed).toEqual([{ sessionId: sid, agents: [{ name: "Explore", description: "read-only search" }] }]);
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

  test("fix wave (review row 4): the titler is fired after the main thread's turn_completed — once per completed turn, never before the result, and on an error terminal too", async () => {
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
      // an ERROR terminal fires it too (2026-09-19): a chat whose first turn fails would otherwise
      // stay untitled for good. The child dies mid-turn → turn_completed(error) + agent_error.
      await session.send("boom", "cli");
      t.q().fail(Object.assign(new Error("child crashed"), { name: "Error" }));
      await session.done;
      expect(t.store.read(sid).filter((e) => e.type === "turn_completed").map((e) => (e as { stopReason: string }).stopReason)).toEqual(["end_turn", "end_turn", "error"]);
      expect(titled).toEqual([sid, sid, sid]);
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

  test("C2 (lane C): a steer + interrupt while a card is pending — the card is withdrawn BEFORE the child's tool_result, approval.list is empty, and the turn boundaries land in order", async () => {
    // s_5d314c81045e seq 24-30, through the REAL table: the bridge the driver hands the child, the
    // projector's `onToolResults`, the store's own seqs. The agent SDK never cancels a pending
    // `canUseTool` on an interrupt, so the child's padded `[interrupted]` result is the only signal.
    const approvals = new ApprovalBroker();
    const t = table({ approvals });
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", cwd: t.home, approvalPolicy: "ask" });
      const session = await t.drivers.create(sid);
      await session.send("fetch it", "cli");
      const input = { command: "curl https://example.com", dangerouslyDisableSandbox: true };
      t.q().emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "call_1", name: "Bash", input }] } });
      await Bun.sleep(10);
      const canUseTool = t.q().options.canUseTool!;
      const pending = canUseTool("Bash", input, { signal: new AbortController().signal, toolUseID: "call_1", requestId: "r1" } as Parameters<typeof canUseTool>[2]);
      expect(approvals.list(sid).map((a) => a.callId)).toEqual(["call_1"]);
      await session.steer("sooo");
      // the child pads the abandoned call, then ends the turn as interrupted
      t.q().emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: "[interrupted]", interrupted: true }] } });
      await session.interrupt();
      await expect(pending).resolves.toMatchObject({ behavior: "deny" });
      t.q().emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
      t.q().emit(result());
      await Bun.sleep(20);

      expect(approvals.list(sid)).toEqual([]);
      const events = t.store.read(sid) as Array<{ type: string; seq: number; callId?: string; by?: string; stopReason?: string; clientName?: string }>;
      const seqOf = (pred: (e: (typeof events)[number]) => boolean): number => events.find(pred)!.seq;
      const resolvedSeq = seqOf((e) => e.type === "approval_resolved" && e.callId === "call_1");
      const toolResultSeq = seqOf((e) => e.type === "tool_result" && e.callId === "call_1");
      expect(resolvedSeq).toBeLessThan(toolResultSeq);
      expect(events.filter((e) => e.type === "approval_resolved")).toHaveLength(1);
      expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ callId: "call_1", by: "aborted" });
      expect(events.map((e) => (e.type === "turn_completed" ? `turn_completed:${e.stopReason}` : e.type))
        .filter((x) => x !== "session_created" && x !== "assistant_delta" && x !== "harness_attached" && x !== "harness_detached")).toEqual([
        "user_message", "turn_started", "tool_call", "approval_requested", "user_message",
        "approval_resolved", "tool_result", "turn_completed:aborted",
        "turn_started", "assistant_message", "turn_completed:end_turn",
      ]);
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
      const sid = t.store.createSession("t", { mode: "chat", model: "anthropic/claude-sonnet-5" });
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe("runtime_selection_refused");
      expect((caught as { reason?: string })?.reason).toBe("runtime-unavailable");
      // The machine-readable half survives; the prose does not.
      expect((caught as Error)?.message).toBe("Winter can't start a session on anthropic/claude-sonnet-5 right now.");
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
      // WS-20: a tag names its provider outright — `providerFor` always resolves "openai"
      // unambiguously now (no more bare-id narrowing to skip), so this refusal correctly
      // attributes to openai's own missing credential rather than falling through to the generic
      // neutral sentence. The router's raw enumeration must still never reach the wire.
      const sid = t.store.createSession("t", { mode: "chat", model: "openai/gpt-5.6-sol" });
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      const message = (caught as Error)?.message ?? "";
      expect(message).toContain("run `winter credentials set openai`");
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

  // WS-20 (review round 2, M1): a `session.create` with NO explicit `model` (the normal Mac case)
  // used to record `providerId: "unstated"` — the record's provider never agreed with the SETTINGS
  // provider the child actually runs on, so `credential.set`'s hot-swap
  // (`evictSessionsForCredential`, which reads `records.get(sessionId)?.providerId`) evicted
  // nothing for a default-model session: a rotated key never reached its live child until the next
  // restart/idle-reap. Fixed by computing the EFFECTIVE tag (the daemon's configured
  // `settings.provider.model` when no explicit model was given) once, and deriving providerId AND
  // modelRef from it.
  test("create with no model records the settings tag's REAL provider — a later credential change evicts it (M1)", async () => {
    const settings = { provider: { model: "openai/gpt-5.6-sol" }, runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } } as unknown as Settings;
    const t = table({ settings: () => settings });
    try {
      const sid = t.store.createSession("t", { mode: "chat" }); // no `model` at all
      const session = await t.drivers.create(sid);

      // The record names the REAL provider the child actually runs on — never "unstated".
      const record = t.records.get(sid);
      expect(record?.providerId).toBe("openai");
      expect(record?.modelRef).toBe("openai/gpt-5.6-sol");

      // The hot-swap path (production wiring: ipc/server.ts's evictSessionsForCredentialChange)
      // now finds this session when its provider's credential changes.
      const acted = await evictSessionsForCredential({
        list: () => t.drivers.list(),
        providerOf: (sessionId) => t.records.get(sessionId)?.providerId,
        evict: (sessionId) => t.drivers.evict(sessionId),
      }, "openai");
      expect(acted).toEqual([sid]);

      await session.end();
    } finally { t.close(); }
  });

  // 2026-09-18 (agent SDK 0.0.17): the three `Options.web` inputs are read LIVE at every incarnation
  // — the Exa key's presence, the project's dangerous-domain floor, and `pins.research` as the digest
  // model. This is the wiring test; `mode-matrix.test.ts` pins what the builder does with them.
  test("optionsFor reads the Exa key, the domain floor and pins.research LIVE, per incarnation", async () => {
    const settings = {
      provider: { model: "openai/gpt-5.6-sol" },
      pins: { research: "codex-oauth/gpt-5.6-luna" },
      runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 },
    } as unknown as Settings;
    const t = table({ settings: () => settings, dangerousDomainsAdded: () => ["corp.example"] });
    try {
      // No Exa key yet: no `search` block at all (the SDK's anonymous-only state).
      const first = await t.drivers.create(t.store.createSession("t", { mode: "chat" }));
      expect(t.q().options.web?.search).toBeUndefined();
      // The floor is the shipped list PLUS the project's own addition, in that order.
      const floor = t.q().options.web?.blockedDomains ?? [];
      expect(floor).toContain("pastebin.com");
      expect(floor[floor.length - 1]).toBe("corp.example");
      // `pins.research` names a provider with no stored credential, so it is DROPPED rather than
      // stated — a stated-but-unresolvable digest model would refuse every WebFetch call — and the
      // drop is logged once, naming the setting.
      expect(t.q().options.web?.fetch).not.toHaveProperty("digestModel");
      expect(t.logs.some((l) => l.includes("pins.research"))).toBe(true);
      await first.end();

      // Store the key, and the NEXT incarnation names it.
      await new FileSecretStore(join(t.home, "secrets.json")).set("exa-api-key", "x");
      const second = await t.drivers.create(t.store.createSession("t2", { mode: "chat" }));
      expect(t.q().options.web?.search?.authRef).toMatchObject({ kind: "keychain", account: "exa-api-key" });
      // …and the value never appears anywhere in the child's Options.
      expect(JSON.stringify(t.q().options)).not.toContain("\"x\"");
      await second.end();
    } finally { t.close(); }
  });

  // Whole-branch review M1: an OFF-CATALOG `pins.research` used to be stated whenever a credential for
  // its provider happened to be stored — and the child advertises `WebFetch` only while its digest
  // model resolves, so that one hand-edited settings line WITHDREW THE TOOL from every Winter session,
  // chat included, where the base prompt still names it. Nothing logged, because the drop branch was
  // never taken.
  test("an off-catalog pins.research is DROPPED, not stated — WebFetch must not vanish for it (M1)", async () => {
    const settings = {
      provider: { model: "openai/gpt-5.6-sol" },
      // Shape-valid (that is all `ModelTagSchemaCore` checks) and backed by no catalog row.
      pins: { research: "openai/gpt-5.6-does-not-exist" },
      runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 },
    } as unknown as Settings;
    const t = table({ settings: () => settings });
    try {
      // A credential for that provider IS stored, so the presence probe alone would have passed it.
      await new FileSecretStore(join(t.home, "secrets.json")).set("openai:default", JSON.stringify({ kind: "api-key", key: "k" }));
      const session = await t.drivers.create(t.store.createSession("t", { mode: "chat" }));
      expect(t.q().options.web?.fetch).not.toHaveProperty("digestModel");
      expect(t.logs.some((l) => l.includes("pins.research") && l.includes("no model in the pinned catalog carries"))).toBe(true);
      await session.end();
    } finally { t.close(); }
  });

  test("a catalog-backed cross-provider pin IS stated, and says whose credential pays for it", async () => {
    const settings = {
      provider: { model: "openai/gpt-5.6-sol" },
      pins: { research: "codex-oauth/gpt-5.6-luna" },
      runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 },
    } as unknown as Settings;
    const t = table({ settings: () => settings });
    try {
      await new FileSecretStore(join(t.home, "secrets.json")).set("codex-oauth:default", JSON.stringify({ kind: "api-key", key: "k" }));
      const session = await t.drivers.create(t.store.createSession("t", { mode: "chat" }));
      expect(t.q().options.web?.fetch?.digestModel).toBe("codex-oauth/gpt-5.6-luna");
      expect(t.q().options.web?.fetch?.authRef).toMatchObject({ kind: "keychain", account: "codex-oauth:default" });
      // Both providers named, neither credential — this is new spend on a key the session never named.
      expect(t.logs.some((l) => l.includes("runs on openai") && l.includes("digest runs on codex-oauth"))).toBe(true);
      expect(t.logs.join("\n")).not.toContain("\"k\"");
      await session.end();
    } finally { t.close(); }
  });

  // 2026-09-18 (agent SDK 0.0.17): the `exa` TOOL row is keyed by LEG, not by the record's provider.
  // It used to evict nothing, correctly — the daemon's own Search/ReadPage read that key per call. Now
  // `Options.web.search.authRef` names it AND its presence decides the tool surface itself, both fixed
  // at spawn, so a live child has to be replaced or a key added mid-session does nothing until the
  // idle reap.
  test("an `exa` key change evicts every WINTER-leg session, whatever provider its record names", async () => {
    const settings = { provider: { model: "openai/gpt-5.6-sol" }, runtimes: { winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } } as unknown as Settings;
    const t = table({ settings: () => settings });
    try {
      const sid = t.store.createSession("t", { mode: "chat" });
      const session = await t.drivers.create(sid);
      const deps = {
        list: () => t.drivers.list(),
        providerOf: (sessionId: string) => t.records.get(sessionId)?.providerId,
        legOf: (sessionId: string) => t.drivers.legOf(sessionId),
        evict: (sessionId: string) => t.drivers.evict(sessionId),
      };
      // `exa` matches no record's provider at all, and evicts this session anyway.
      expect(deps.providerOf(sid)).toBe("openai");
      expect(await evictSessionsForCredential(deps, "exa")).toEqual([sid]);
      // …and the legacy Brave row still evicts nothing: no child's `Options` names it.
      expect(await evictSessionsForCredential(deps, "web-search")).toEqual([]);
      await session.end();
    } finally { t.close(); }
  });

  // WS-21 (L4 request 2): the skills-only plugin-view handover (B1) is retired — the daemon hands a child
  // no `Options.plugins`/`skills` on any build (the run folder carries skills; plugins load natively).
  test("L4 request 2: an installed legacy plugin's skills are never handed to a child by the daemon", async () => {
    const t = table({});
    try {
      mkdirSync(join(t.home, "plugins", "superpowers", "skills", "brainstorming"), { recursive: true });
      writeFileSync(join(t.home, "plugins", "superpowers", "skills", "brainstorming", "SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask" });
      const session = await t.drivers.create(sid);
      expect("plugins" in t.q().options).toBe(false);
      expect("skills" in t.q().options).toBe(false);
      expect(existsSync(join(t.home, "cache", "skill-plugins"))).toBe(false);
      await session.end();
    } finally { t.close(); }
  });

  // D3 follow-up (2026-09-22): a cross-provider `runtimes.advisorModel` pin is honoured on its own
  // provider's credential — but, exactly like `pins.research`'s digest, a pin whose provider has NO
  // stored material is not stated: a present-but-unusable `Options.advisor` makes every `advisor` call
  // fail, while the family default keeps the tool working. Falls back to the D30 default, logged.
  test("D3: a cross-provider advisor pin rides the child when its provider holds material; a KEYLESS one falls back to the D30 default", async () => {
    const secrets = new FileSecretStore(join(mkdtempSync(join(tmpdir(), "winter-advisor-secrets-")), "secrets.json"));
    const settings = { runtimes: { advisorModel: "codex-oauth/gpt-5.6-sol", winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } } as unknown as Settings;
    const t = table({ settings: () => settings, secrets });
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "openai/gpt-5.6-sol", approvalPolicy: "ask" });
      const first = await t.drivers.create(sid);
      // No codex-oauth material: the D30 default for an openai session, on openai's own locator.
      expect(t.q().options.advisor).toEqual({ model: "openai/gpt-6-astra", authRef: expect.objectContaining({ account: "openai:default" }) });
      expect(t.logs.some((l) => l.includes("runtimes.advisorModel") && l.includes("codex-oauth"))).toBe(true);
      await first.end();

      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "api-key", key: "sk-test-not-real" });
      await t.drivers.evict(sid);
      await (await t.drivers.ensure(sid))!.open();
      expect(t.q().options.advisor).toEqual({ model: "codex-oauth/gpt-5.6-sol", authRef: expect.objectContaining({ account: "codex-oauth:default" }) });
      await t.drivers.evict(sid);
    } finally { t.close(); }
  });

  // Whole-branch review (minor d): a credential write for a cross-provider ADVISOR's provider reaches the
  // children that use it — both the one whose pin RUNS there (its advisor authRef names that slot) and
  // the one whose pin FELL BACK because that slot was empty (the new key is what it was waiting for).
  // A session whose advisor is not on that provider is left alone.
  test("minor d: a credential write for the advisor's provider evicts the children whose advisor pin names it", async () => {
    const secrets = new FileSecretStore(join(mkdtempSync(join(tmpdir(), "winter-advisor-evict-")), "secrets.json"));
    let pin = "codex-oauth/gpt-5.6-sol";
    const settings = () => ({ runtimes: { advisorModel: pin, winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } }) as unknown as Settings;
    const t = table({ settings, secrets });
    const evictFor = (providerId: string) => evictSessionsForCredential({
      list: () => t.drivers.list(),
      providerOf: (sessionId) => t.records.get(sessionId)?.providerId,
      advisorProviderOf: (sessionId) => t.drivers.advisorProviderOf?.(sessionId),
      evict: (sessionId) => t.drivers.evict(sessionId),
    }, providerId);
    try {
      const fellBack = t.store.createSession("t", { mode: "code", model: "openai/gpt-5.6-sol", approvalPolicy: "ask" });
      await t.drivers.create(fellBack);
      expect(t.q().options.advisor).toEqual({ model: "openai/gpt-6-astra", authRef: expect.objectContaining({ account: "openai:default" }) });
      expect(t.drivers.advisorProviderOf?.(fellBack)).toBe("codex-oauth");

      // The key arrives: the fell-back child is replaced, and its next incarnation states the pin.
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "api-key", key: "sk-test-not-real" });
      expect(await evictFor("codex-oauth")).toEqual([fellBack]);
      expect(t.drivers.get(fellBack)).toBeUndefined();
      await (await t.drivers.ensure(fellBack))!.open();
      expect(t.q().options.advisor).toEqual({ model: "codex-oauth/gpt-5.6-sol", authRef: expect.objectContaining({ account: "codex-oauth:default" }) });

      // Rotating it again reaches the child whose advisor now RUNS there.
      expect(await evictFor("codex-oauth")).toEqual([fellBack]);

      // A session whose advisor is not cross-provider is left alone.
      pin = "openai/gpt-6-astra";
      const plain = t.store.createSession("t", { mode: "code", model: "openai/gpt-5.6-sol", approvalPolicy: "ask" });
      await t.drivers.create(plain);
      expect(t.drivers.advisorProviderOf?.(plain)).toBeUndefined();
      expect(await evictFor("codex-oauth")).toEqual([]);
      await t.drivers.evict(plain);
    } finally { t.close(); }
  });

  // Lane B (2026-09-22): the user's SAVED allow rules reach the child — read through the dep at every
  // incarnation (so a rule saved mid-session lands at the next one), translated onto `permissions.allow`.
  test("saved allow rules ride a CODE child's Options.permissions.allow, read live per incarnation", async () => {
    let saved: string[] = ["Bash(gh repo:*)"];
    const seenCwds: string[] = [];
    const t = table({ persistedAllowRules: (cwd) => { seenCwds.push(cwd); return saved; } });
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask" });
      await t.drivers.create(sid);
      expect(t.q().options.permissions?.allow).toContain("Bash(gh repo:*)");
      saved = ["Bash(gh repo:*)", "BashUnsandboxed(curl:*)"];
      await t.drivers.evict(sid);
      await (await t.drivers.ensure(sid))!.open();
      expect(t.q().options.permissions?.allow).toEqual(expect.arrayContaining(["Bash(gh repo:*)", "Bash(curl:*)"]));
      expect(seenCwds.length).toBeGreaterThanOrEqual(2);
      await t.drivers.evict(sid);
    } finally { t.close(); }
  });

  // Review M2 (2026-09-23): the advisor pin follows the `pins.research` digest rule in full — an
  // off-catalog pin, and a cross-provider pin whose credential has no Keychain LOCATOR at all (a
  // `console/*` login lives in an `ant` profile), fall back to the family default too.
  test("M2: an off-catalog advisor pin, or a cross-provider pin with no credential locator, falls back to the D30 default", async () => {
    for (const pin of ["openai/no-such-model-anywhere", "console/claude-fable-5-1"]) {
      const settings = { runtimes: { advisorModel: pin, winterLeg: { chat: true, dispatch: false, code: false }, winterIdleTimeoutSec: 10 } } as unknown as Settings;
      const t = table({ settings: () => settings });
      try {
        const sid = t.store.createSession("t", { mode: "code", model: "openai/gpt-5.6-sol", approvalPolicy: "ask" });
        const s = await t.drivers.create(sid);
        expect({ pin, advisor: t.q().options.advisor }).toEqual({ pin, advisor: { model: "openai/gpt-6-astra", authRef: expect.objectContaining({ account: "openai:default" }) } });
        expect(t.logs.some((l) => l.includes("runtimes.advisorModel"))).toBe(true);
        await s.end();
      } finally { t.close(); }
    }
  });

  // B2 (2026-09-22): `session.setPolicy` across the bypass boundary replaces the child through THIS
  // table's `evict` (ipc/server.ts's `replaceChildForPolicy`). The table half of that claim: the next
  // incarnation re-reads the stored policy, so both spawn-time bypass facts follow it — in, and back out.
  test("B2: after an evict, the next incarnation spawns with the STORED policy's bypass clamp — both ways", async () => {
    const t = table();
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask" });
      const first = await t.drivers.create(sid);
      expect(t.q().options.permissionMode).toBe("default");
      expect(t.q().options.permissions?.disableBypassPermissionsMode).toBe(true);
      expect(t.q().options.allowDangerouslySkipPermissions).toBeUndefined();

      t.store.setApprovalPolicy(sid, "bypass");
      await t.drivers.evict(sid);
      const second = (await t.drivers.ensure(sid))!;
      expect(second).not.toBe(first);
      await second.open();
      expect(t.queries).toHaveLength(2);
      expect(t.q().options.permissionMode).toBe("bypassPermissions");
      expect(t.q().options.permissions?.disableBypassPermissionsMode).toBe(false);
      expect(t.q().options.allowDangerouslySkipPermissions).toBe(true);
      // Resumed, not restarted: the same backend transcript.
      expect(t.q().options.resume ?? t.q().options.sessionId).toBe(first.backendSessionId);

      t.store.setApprovalPolicy(sid, "accept-edits");
      await t.drivers.evict(sid);
      const third = (await t.drivers.ensure(sid))!;
      await third.open();
      expect(t.q().options.permissionMode).toBe("acceptEdits");
      expect(t.q().options.permissions?.disableBypassPermissionsMode).toBe(true);
      expect(t.q().options.allowDangerouslySkipPermissions).toBeUndefined();
      await third.end();
    } finally { t.close(); }
  });

  test("an `exa` change leaves an OFFICIAL-leg session alone — that leg is sent no `web` block at all", async () => {
    const t = table({});
    try {
      const acted = await evictSessionsForCredential({
        list: () => [{ sessionId: "s_official", turnRunning: false, idle: async () => {} }],
        providerOf: () => "anthropic",
        legOf: () => "official",
        evict: async () => { throw new Error("must not evict an official-leg child for an Exa key"); },
      }, "exa");
      expect(acted).toEqual([]);
    } finally { t.close(); }
  });

  // WS-20 (review round 2, M6): `pinsFor` dropped its old cross-provider "openai" fallback rung —
  // a provider that serves no gpt-family row of its own (an `anthropic/*` primary, here) now yields
  // UNSTATED_TAG for `pins.dispatch`, and dispatch must refuse typed rather than mint a record
  // naming the "unstated" pseudo-provider or hand a real child the literal model string "unstated".
  test("M6: dispatch refuses typed when its pin resolves to UNSTATED_TAG, naming pins.dispatch — no record is minted", async () => {
    const settings = {
      // 2026-09-17: a Claude primary now pins to ITSELF (pinsFor falls back to the user's own tag), so the
      // refusal is exercised through an EXPLICIT sentinel pin — the only way UNSTATED reaches this door.
      provider: { model: "anthropic/claude-sonnet-5" },
      pins: { dispatch: "unstated/unstated" },
      runtimes: { winterLeg: { chat: true, dispatch: true, code: false }, winterIdleTimeoutSec: 10 },
    } as unknown as Settings;
    const t = table({ settings: () => settings });
    try {
      const sid = t.store.createSession("t", { mode: "dispatch" }); // no explicit model — runs the dispatch pin
      let caught: unknown;
      try { await t.drivers.create(sid); } catch (err) { caught = err; }
      expect((caught as { code?: string })?.code).toBe("runtime_selection_refused");
      expect((caught as Error)?.message).toContain("pins.dispatch");
      // Refused BEFORE any runtime-state record was minted — never a record naming "unstated".
      expect(t.records.get(sid)).toBeUndefined();
    } finally { t.close(); }
  });
});

// 2026-09-18: the two "any"-constraint roles' efforts, spent on a runtime child's `Options.effort`.
// Every assertion is on the OPTIONS THE CHILD IS ACTUALLY SPAWNED WITH (`t.q().options`), through the
// real `optionsFor` — the resolver's own rules are unit-tested in settings.test.ts.
describe("role efforts on the runtime leg (pins.dispatch, and provider.model's default effort)", () => {
  const legs = { runtimes: { winterLeg: { chat: true, dispatch: true, code: true }, winterIdleTimeoutSec: 10 } };
  const settingsOf = (over: Record<string, unknown>): Settings =>
    ({ provider: { model: "codex-oauth/gpt-5.6-sol" }, ...legs, ...over }) as unknown as Settings;

  /** Spawns one session under `settings` and answers the effort its child was handed. */
  async function spawnedEffort(settings: Settings, meta: Parameters<SessionStore["createSession"]>[1]): Promise<unknown> {
    const t = table({ settings: () => settings });
    try {
      const sid = t.store.createSession("t", meta);
      const session = await t.drivers.create(sid);
      const effort = t.q().options.effort;
      await session.end();
      return effort;
    } finally { t.close(); }
  }

  describe("pins.dispatch", () => {
    test("absent → DISPATCH_EFFORT mapped onto the pin's row, exactly as before", async () => {
      expect(await spawnedEffort(settingsOf({}), { mode: "dispatch" })).toBe("medium");
      // The pre-existing mapping of the DEFAULT is untouched: a pin whose row has no `medium` and no default sends nothing.
      expect(await spawnedEffort(settingsOf({ pins: { dispatch: "deepseek/deepseek-v4-flash" } }), { mode: "dispatch" })).toBeUndefined();
    });

    test("a stored effort the pin's model offers reaches Options.effort", async () => {
      expect(await spawnedEffort(settingsOf({ roleEfforts: { "pins.dispatch": "high" } }), { mode: "dispatch" })).toBe("high");
    });

    test("a stored effort the pin's model does NOT offer is mapped or omitted — the coordinator still spawns", async () => {
      // deepseek-v4-flash: none/low/high/max, no defaultEffort → a stored `xhigh` has nowhere to map.
      expect(await spawnedEffort(settingsOf({ pins: { dispatch: "deepseek/deepseek-v4-flash" }, roleEfforts: { "pins.dispatch": "xhigh" } }), { mode: "dispatch" })).toBeUndefined();
      // anthropic/claude-opus-5 is not this leg's to run; openai/o4-mini (low/medium/high, default medium) is.
      expect(await spawnedEffort(settingsOf({ pins: { dispatch: "openai/o4-mini" }, roleEfforts: { "pins.dispatch": "max" } }), { mode: "dispatch" })).toBe("medium");
    });

    test("a stored \"none\" is spent exactly as a SESSION's stored \"none\" is: the child is handed no effort", async () => {
      expect(await spawnedEffort(settingsOf({ roleEfforts: { "pins.dispatch": "none" } }), { mode: "dispatch" })).toBeUndefined();
      // The reference behaviour it mirrors — a session's own "none" (`session.setEffort`'s door).
      expect(await spawnedEffort(settingsOf({}), { mode: "chat", effort: "none" })).toBeUndefined();
    });

    test("it governs the dispatch COORDINATOR only — never a user's session, never a dispatch CHILD", async () => {
      const s = settingsOf({ roleEfforts: { "pins.dispatch": "max" } });
      expect(await spawnedEffort(s, { mode: "dispatch" })).toBe("max");
      expect(await spawnedEffort(s, { mode: "code" })).toBeUndefined();
      expect(await spawnedEffort(s, { mode: "chat" })).toBeUndefined();
      expect(await spawnedEffort(s, { mode: "code", origin: "dispatch-child" })).toBeUndefined();
    });

    test("a settings change lands on the coordinator's NEXT incarnation — same driver table, no restart", async () => {
      let live = settingsOf({});
      const t = table({ settings: () => live });
      try {
        const sid = t.store.createSession("t", { mode: "dispatch" });
        await t.drivers.create(sid);
        expect(t.q().options.effort).toBe("medium");
        // An idle reap (or any eviction): the driver leaves the table, so the next `ensure` re-opens
        // from the record and `optionsFor` runs again — the daemon itself is never restarted.
        await t.drivers.evict(sid);
        live = settingsOf({ roleEfforts: { "pins.dispatch": "xhigh" } });
        const second = await t.drivers.ensure(sid);
        expect(t.queries).toHaveLength(2);
        expect(t.q().options.effort).toBe("xhigh");
        await second?.end();
      } finally { t.close(); }
    });
  });

  describe("provider.model — the daemon's default effort (provider.reasoningEffort)", () => {
    const withDefault = (effort: string, over: Record<string, unknown> = {}): Settings =>
      settingsOf({ provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: effort }, ...over });

    test("absent → a session with no effort of its own sends none, exactly as before", async () => {
      expect(await spawnedEffort(settingsOf({}), { mode: "code" })).toBeUndefined();
      expect(await spawnedEffort(settingsOf({}), { mode: "chat" })).toBeUndefined();
    });

    test("a stored default reaches a session that never chose an effort", async () => {
      expect(await spawnedEffort(withDefault("high"), { mode: "code" })).toBe("high");
      expect(await spawnedEffort(withDefault("high"), { mode: "chat" })).toBe("high");
    });

    test("the session's OWN effort always wins, verbatim", async () => {
      expect(await spawnedEffort(withDefault("high"), { mode: "code", effort: "low" })).toBe("low");
    });

    test("a STALE own effort (left behind by a model switch) is not spent: the child is never handed a level its model refuses", async () => {
      // The field report: 'high' chosen on a reasoning model, then the session moved to a row with an
      // EMPTY vocabulary — the child refused the next turn typed. The level is treated as unset.
      expect(await spawnedEffort(settingsOf({}), { mode: "code", model: "deepseek-anthropic/deepseek-reasoner", effort: "high" })).toBeUndefined();
      // ...and the implicit default takes over where the row has one to map onto.
      expect(await spawnedEffort(withDefault("max"), { mode: "code", model: "openai/o4-mini", effort: "galactic" })).toBe("medium");
      // A level the row DOES list is still spent verbatim.
      expect(await spawnedEffort(settingsOf({}), { mode: "code", model: "anthropic/claude-opus-5", effort: "high" })).toBe("high");
    });

    test("it is IMPLICIT: mapped onto the session's own model's row, or omitted — never forced, never a refusal", async () => {
      expect(await spawnedEffort(withDefault("max"), { mode: "code", model: "openai/o4-mini" })).toBe("medium");
      expect(await spawnedEffort(withDefault("medium"), { mode: "code", model: "deepseek/deepseek-v4-flash" })).toBeUndefined();
      expect(await spawnedEffort(withDefault("high"), { mode: "code", model: "openai/gpt-5.4" })).toBeUndefined();
    });

    test("dispatch is not a consumer of it: the coordinator runs its own role's effort, else DISPATCH_EFFORT", async () => {
      expect(await spawnedEffort(withDefault("max"), { mode: "dispatch" })).toBe("medium");
    });

    test("a settings change lands on the session's NEXT incarnation — no restart", async () => {
      let live = settingsOf({});
      const t = table({ settings: () => live });
      try {
        const sid = t.store.createSession("t", { mode: "code" });
        await t.drivers.create(sid);
        expect(t.q().options.effort).toBeUndefined();
        await t.drivers.evict(sid); // the idle-reap shape — see the dispatch twin of this test above
        live = withDefault("xhigh");
        const second = await t.drivers.ensure(sid);
        expect(t.q().options.effort).toBe("xhigh");
        await second?.end();
      } finally { t.close(); }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WS-21 L3.3 (spec §3.1, Contract A): every incarnation awaits a run home — when the linked router
// applies them. The router here is the published 0.0.11 (no `buildRunHome`), so the builder is a stub
// injected through `WinterLegDeps.runHome`, and `sdk.query` is observed directly (0.0.11 strips
// `runtime` before the peer, as a run-home router applies it).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("WS-21: run homes on the Winter leg (stubbed router builder)", () => {
  function stubRunHomes() {
    const built: import("../../src/runtime-sdk/run-home-contract").RunHomeInput[] = [];
    const disposed: string[] = [];
    const facts: import("../../src/runtime-sdk/run-home-input").RunHomeSessionFacts[] = [];
    const runHome: NonNullable<WinterLegDeps["runHome"]> = {
      inputFor: (f) => {
        facts.push(f);
        return { home: "/h", mode: f.mode, dispatchChild: f.dispatchChild, leg: f.leg, cwd: f.cwd, trustedProjectRoot: null, gitRoot: null, mcpDisabled: [], reservedMcpServerNames: [], memoryDir: "/m" };
      },
      build: async (input) => {
        built.push(input);
        const runId = `run-${built.length}`;
        return {
          runId, dir: `/h/cache/runs/${runId}`, sdkHome: "/h/sdk", input, effectiveSettings: {},
          report: { skippedLinks: [], externalUserLinks: [], droppedMcpServers: [], unconditionalRules: [], droppedImports: [], skippedAgents: [] },
          dispose: async () => { disposed.push(runId); },
        };
      },
    };
    return { built, disposed, facts, runHome };
  }
  const querySpy = () => {
    const calls: Array<{ options: Options & { runtime?: { runHome?: { runId: string } } } }> = [];
    let failNext = false;
    const wrap = (sdk: ReturnType<typeof createRuntimeSdk>) => new Proxy(sdk, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (args: { prompt: AsyncIterable<string>; options: Options }) => {
          calls.push(args as never);
          if (failNext) { failNext = false; throw Object.assign(new Error("every generation must carry a run home (simulated)"), { name: "RunHomeError", code: "run_home_required" }); }
          return target.query(args as never);
        };
      },
    });
    return { calls, wrap, failOnce: () => { failNext = true; } };
  };
  const settle = async (disposed: string[], n: number): Promise<void> => {
    const until = Date.now() + 2000;
    while (disposed.length < n && Date.now() < until) await Bun.sleep(5);
  };

  // WS-21 (L2 O-1): the Winter child keys its transcript by realpath(cwd) while the router keys by the cwd
  // it is given — a symlinked cwd (`/var/…` → `/private/var/…`) made a handoff's step 5 look for a
  // transcript under a key the child never wrote. The daemon hands BOTH the canonical path: RunHomeInput.cwd,
  // Options.cwd and the recorded transcript key / backend root.
  test("L2 O-1: a symlinked cwd reaches the run home, Options.cwd and the record as its realpath", async () => {
    const rh = stubRunHomes();
    const spy = querySpy();
    const t = table({ runHome: rh.runHome }, {}, spy.wrap);
    try {
      const real = realpathSync(mkdtempSync(join(tmpdir(), "winter-o1-real-")));
      const link = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-o1-link-"))), "proj");
      symlinkSync(real, link);
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", cwd: link });
      await t.drivers.create(sid);
      expect(rh.built[0]!.cwd).toBe(real);
      expect(spy.calls[0]!.options.cwd).toBe(real);
      const record = t.records.get(sid)!;
      expect(record.transcriptProjectKey).toBe(transcriptProjectKey(real));
      expect(record.backendRoot.endsWith(transcriptProjectKey(real))).toBe(true);
    } finally { t.close(); }
  });

  test("optionsFor awaits buildRunHome and passes the result as options.runtime.runHome", async () => {
    const rh = stubRunHomes();
    const spy = querySpy();
    const t = table({ runHome: rh.runHome }, {}, spy.wrap);
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);
      expect(rh.built).toHaveLength(1);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.options.runtime?.runHome?.runId).toBe("run-1");
      expect(rh.built[0]!.leg).toBe("winter");
      expect(rh.built[0]!.cwd).toBe(spy.calls[0]!.options.cwd!); // the router refuses a run home for another cwd
      // L3.4: the router applies the run home, so it — not the daemon — pins the home and the sources.
      expect("WINTER_HOME" in (spy.calls[0]!.options.env ?? {})).toBe(false);
      expect(spy.calls[0]!.options.settingSources).toEqual(["user"]);
      await session.end();
    } finally { t.close(); }
  });

  test("a router without buildRunHome (no runHome dep) builds nothing and keeps WINTER_HOME and settingSources: []", async () => {
    const spy = querySpy();
    const t = table({}, {}, spy.wrap);
    try {
      const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask" });
      const session = await t.drivers.create(sid);
      expect("runtime" in spy.calls[0]!.options).toBe(false);
      expect(spy.calls[0]!.options.env?.WINTER_HOME).toBe(t.home);
      expect(spy.calls[0]!.options.settingSources).toEqual([]);
      await session.end();
    } finally { t.close(); }
  });

  test("the session facts: mode, dispatchChild (origin dispatch-child), workdir-less", async () => {
    const rh = stubRunHomes();
    const t = table({ runHome: rh.runHome });
    try {
      const chat = await t.drivers.create(t.store.createSession("t", { mode: "chat", model: "winter-test/echo" }));
      const child = await t.drivers.create(t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask", origin: "dispatch-child" }));
      expect(rh.facts.map((f) => [f.mode, f.dispatchChild, f.leg])).toEqual([["chat", false, "winter"], ["code", true, "winter"]]);
      expect(rh.facts[1]!.workdirLess).toBe(true); // no cwd, no dirs: the session tmp dir
      await chat.end();
      await child.end();
    } finally { t.close(); }
  });

  test("EVERY incarnation path builds a fresh run home: create, resume after an idle end, eviction and replacement", async () => {
    const rh = stubRunHomes();
    const spy = querySpy();
    const t = table({ runHome: rh.runHome }, {}, spy.wrap);
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      const session = await t.drivers.create(sid);                       // create
      expect(rh.built).toHaveLength(1);
      await session.end();                                               // the incarnation ends (resumable)…
      await (await t.drivers.ensure(sid))!.open();                        // …resume
      expect(rh.built).toHaveLength(2);
      await t.drivers.evict(sid);                                         // eviction (a credential write, a
      await (await t.drivers.ensure(sid))!.open();                        //  policy switch across bypass,
      expect(rh.built).toHaveLength(3);                                   //  a cross-family model switch)
      t.store.setModel(sid, "winter-test/tooluse");                       // a model change while parked…
      await t.drivers.evict(sid);
      await (await t.drivers.ensure(sid))!.open();                        // …reaches the next incarnation
      expect(rh.built).toHaveLength(4);
      expect(new Set(spy.calls.map((c) => c.options.runtime?.runHome?.runId)).size).toBe(4); // never reused
      await t.drivers.evict(sid);
    } finally { t.close(); }
  });

  test("an ended incarnation's run home is disposed once the router says safe (after the query drained or closed)", async () => {
    const rh = stubRunHomes();
    let ended = false;
    // L2 fix round 1 (M6): the router reports a Winter run home `pending` while the child runs and `safe`
    // once the query finished, was closed or failed — the stub answers the same way.
    const t = table({ runHome: rh.runHome }, { runHomeOutcome: () => (ended ? "safe" : "pending") });
    try {
      const session = await t.drivers.create(t.store.createSession("t", { mode: "chat", model: "winter-test/echo" }));
      expect(rh.disposed).toEqual([]);
      ended = true;
      await session.end();
      await settle(rh.disposed, 1);
      expect(rh.disposed).toEqual(["run-1"]);
    } finally { t.close(); }
  });

  test("pending, quarantined and no answer all KEEP the folder — dispose only on safe (L2 fix round 1)", async () => {
    for (const [outcome, expected] of [["pending", []], ["quarantined", []], [undefined, []]] as const) {
      const rh = stubRunHomes();
      const t = table({ runHome: rh.runHome }, { runHomeOutcome: () => outcome });
      try {
        const session = await t.drivers.create(t.store.createSession("t", { mode: "chat", model: "winter-test/echo" }));
        await session.end();
        await settle(rh.disposed, expected.length);
        await Bun.sleep(20);
        expect(rh.disposed).toEqual([...expected]);
      } finally { t.close(); }
    }
  });

  test("a run home built for an open that then FAILS is disposed immediately", async () => {
    const rh = stubRunHomes();
    const spy = querySpy();
    const t = table({ runHome: rh.runHome }, {}, spy.wrap);
    try {
      const sid = t.store.createSession("t", { mode: "chat", model: "winter-test/echo" });
      spy.failOnce();
      // The router's typed refusal is forwarded verbatim as the refusal's code (→ `data.code`).
      const err = await t.drivers.create(sid).then(() => undefined, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe("run_home_required");
      expect(rh.built).toHaveLength(1);
      expect(rh.disposed).toEqual(["run-1"]);
    } finally { t.close(); }
  });
});

// WS-21 L3.4 (spec §6.1): with a run home applied, the driver hands the child none of the inputs the run
// folder carries — the same planted world, with and without a (stubbed) run-home router.
describe("WS-21: the driver stops building run-home inputs once a run home is applied", () => {
  const stubBuilder: NonNullable<WinterLegDeps["runHome"]> = {
    inputFor: (f) => ({ home: "/h", mode: f.mode, dispatchChild: f.dispatchChild, leg: f.leg, cwd: f.cwd, trustedProjectRoot: null, gitRoot: null, mcpDisabled: [], reservedMcpServerNames: [], memoryDir: "/m" }),
    build: async (input) => ({
      runId: "r", dir: "/h/cache/runs/r", sdkHome: "/h/sdk", input, effectiveSettings: {},
      report: { skippedLinks: [], externalUserLinks: [], droppedMcpServers: [], unconditionalRules: [], droppedImports: [], skippedAgents: [] },
      dispose: async () => {},
    }),
  };
  // The inputs a daemon wires, and the files it reads them from (the user agent, the sdk allow rule).
  const inputs: Partial<WinterLegDeps> = {
    extraMcpServers: () => ({ user_srv: { type: "stdio", command: "node" } }),
    persistedAllowRules: () => ["Bash(git status)"],
  };
  const plantFiles = (home: string): void => {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "reviewer.md"), ["---", "name: code-reviewer", "description: Reviews code", "---", "", "You review code."].join("\n"));
    updateSdkSettings(home, () => ({ permissions: { allow: ["Bash(npm test:*)"] } }));
  };

  for (const applied of [false, true]) {
    test(`run home ${applied ? "APPLIED: none of them" : "not applied: all of them, as today"}`, async () => {
      const t = table({ ...inputs, ...(applied ? { runHome: stubBuilder } : {}) });
      try {
        plantFiles(t.home);
        const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", approvalPolicy: "ask" });
        const session = await t.drivers.create(sid);
        const o = t.q().options;
        const allow = o.permissions?.allow ?? [];
        if (applied) {
          expect("agents" in o).toBe(false);
          expect("plugins" in o).toBe(false);
          expect("skills" in o).toBe(false);
          expect(Object.keys(o.mcpServers ?? {})).not.toContain("user_srv");
          expect(allow).not.toContain("Bash(git status)");
          expect(allow).not.toContain("Bash(npm test:*)");
          expect(allow).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
        } else {
          expect(o.agents).toBeDefined();
          // L4 request 2: no plugin views or skill names from the daemon on any build
          expect("plugins" in o).toBe(false);
          expect("skills" in o).toBe(false);
          expect(Object.keys(o.mcpServers ?? {})).toContain("user_srv");
          expect(allow).toEqual(expect.arrayContaining(["Bash(git status)", "Bash(npm test:*)"]));
        }
        await session.end();
      } finally { t.close(); }
    });
  }
});

// WS-21 round 3 (Important): both legs key a transcript by the canonical cwd now, but a 0.116 session
// made in a symlinked cwd has its files under the RAW cwd's key. `resume()` moves them — before the leg
// opens, synchronously (n7) — so the child finds its history; a collision moves nothing and is marked.
describe("WS-21 round 3: the lazy canonical-cwd re-key at resume (Winter leg)", () => {
  const ENTRY = '{"type":"user","uuid":"u-old","message":{"role":"user","content":"before the upgrade"}}\n';
  async function oldLayoutSession() {
    const t = table();
    const real = realpathSync(mkdtempSync(join(tmpdir(), "winter-rekey-real-")));
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-rekey-link-"))), "proj");
    symlinkSync(real, link);
    const sid = t.store.createSession("t", { mode: "code", model: "winter-test/echo", cwd: link });
    const created = await t.drivers.create(sid);
    await created.end();
    const id = created.backendSessionId;
    const projects = storeProjectsDir(t.home);
    const rawKey = transcriptProjectKey(link);
    const canonKey = transcriptProjectKey(real);
    expect(rawKey).not.toBe(canonKey);
    // the 0.116 state: the record and the files under the RAW key
    expect(t.records.rekeyTranscript(sid, canonKey, rawKey, join(projects, rawKey))).toBe(true);
    mkdirSync(join(projects, rawKey, id, "subagents"), { recursive: true });
    writeFileSync(join(projects, rawKey, `${id}.jsonl`), ENTRY);
    writeFileSync(join(projects, rawKey, `${id}.provider-state.jsonl`), "{}\n");
    writeFileSync(join(projects, rawKey, id, "subagents", "agent-a.jsonl"), "{}\n");
    return { t, sid, id, real, projects, rawKey, canonKey };
  }

  test("a symlinked-cwd session from the old layout resumes WITH its history: files moved, record re-pointed, the child looks where they are", async () => {
    const { t, sid, id, real, projects, rawKey, canonKey } = await oldLayoutSession();
    const again = table({ records: t.records, store: t.store, hub: t.hub, home: t.home });
    try {
      const resumed = (await again.drivers.ensure(sid))!;
      expect(existsSync(join(projects, rawKey, `${id}.jsonl`))).toBe(false);
      expect(existsSync(join(projects, canonKey, id, "subagents", "agent-a.jsonl"))).toBe(true);
      const record = t.records.get(sid)!;
      expect([record.transcriptProjectKey, record.backendRoot]).toEqual([canonKey, join(projects, canonKey)]);
      const opts = again.q().options;
      expect(opts.cwd).toBe(real);
      expect(opts.resume).toBe(id);   // hasTranscript found it: a RESUME, not a fresh start
      // the child's own lookup — the SDK store at the key of the cwd it is handed — returns the history
      const loaded = await new winter.WinterCompatibilitySessionStore({ winterHome: storeHomeFor(t.home) }).load({ projectKey: transcriptProjectKey(opts.cwd!), sessionId: id });
      expect(loaded?.map((e) => e.uuid)).toEqual(["u-old"]);
      expect(again.logs.some((l) => l.includes("re-keyed") && l.includes(sid))).toBe(true);
      await resumed.end();
    } finally { again.close(); t.close(); }
  });

  // Round 4, minor 1: a lazy re-key on a MIGRATED home joins Migration C's manifest (`rekeyed`), so a rollback
  // reverses it like the bulk step's moves — the older build finds the transcript under the raw key again.
  test("round 4: on a migrated home the lazy move is recorded in the Migration C manifest, and rollback reverses it", async () => {
    setRunHomeSupportForTests(true);   // the store at <home>/sdk/projects, as on every build that migrates
    try {
      const { t, sid, id, rawKey, canonKey } = await oldLayoutSession();
      const archiveDir = join(t.home, "migration", "c-test");
      mkdirSync(join(t.home, "migration", "c"), { recursive: true });
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(migrationCManifestPath(t.home), JSON.stringify({
        schemaVersion: 1, home: t.home, startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), status: "complete", archiveDir,
        steps: [{ step: "preflight", status: "done", at: new Date(0).toISOString() }],
        backups: { settings: null, runtimeState: null, sdkSettings: null, sdkGlobal: null, splitMarker: null },
        moved: [], links: [], copied: [], archived: [], reconciled: [],
      }));
      const again = table({ records: t.records, store: t.store, hub: t.hub, home: t.home });
      try {
        await (await again.drivers.ensure(sid))!.end();
        const state = migrationCState(t.home);
        if (state.kind !== "parsed") throw new Error("the manifest must still parse");
        expect(state.manifest.rekeyed).toEqual([expect.objectContaining({ sessionId: sid, backendId: id, from: rawKey, to: canonKey, outcome: "moved" })]);
        await rollbackMigrationC(t.home, { log: () => {} });
        const projects = join(t.home, "sdk", "projects");
        expect(existsSync(join(projects, rawKey, `${id}.jsonl`))).toBe(true);
        expect(existsSync(join(projects, rawKey, id, "subagents", "agent-a.jsonl"))).toBe(true);
        expect(existsSync(join(projects, canonKey, `${id}.jsonl`))).toBe(false);
        const db = new Database(join(t.home, "runtimes", "runtime-state.db"), { readonly: true });
        try { expect(db.query<{ k: string }, [string]>("SELECT transcript_project_key AS k FROM runtime_sessions WHERE winter_session_id = ?").get(sid)!.k).toBe(rawKey); } finally { db.close(); }
      } finally { again.close(); t.close(); }
    } finally { setRunHomeSupportForTests(undefined); }
  });

  test("a collision (the canonical key already holds the transcript) moves nothing and marks the session repair-required", async () => {
    const { t, sid, id, projects, rawKey, canonKey } = await oldLayoutSession();
    mkdirSync(join(projects, canonKey), { recursive: true });
    writeFileSync(join(projects, canonKey, `${id}.jsonl`), '{"type":"user","uuid":"u-new"}\n');
    const again = table({ records: t.records, store: t.store, hub: t.hub, home: t.home });
    try {
      const resumed = (await again.drivers.ensure(sid))!;
      expect(existsSync(join(projects, rawKey, `${id}.jsonl`))).toBe(true);
      expect(readFileSync(join(projects, canonKey, `${id}.jsonl`), "utf8")).toContain("u-new");
      expect(t.records.get(sid)!.transcriptHealth).toBe("repair-required");
      expect(t.records.get(sid)!.transcriptProjectKey).toBe(rawKey);
      expect(again.logs.some((l) => l.includes("collision") && l.includes(sid))).toBe(true);
      await resumed.end();
    } finally { again.close(); t.close(); }
  });
});
