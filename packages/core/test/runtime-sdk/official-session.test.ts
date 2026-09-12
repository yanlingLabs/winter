// Fix round 2 (lane 1) — `OfficialSession` over a FAKE `OfficialQuery`, unit-scoped.
//
// No child process anywhere in this file (that proof stays `official-leg.e2e.test.ts`'s job). What
// is under test is `official-session.ts`'s own state machine: M6a's `mirror_error` → transcript
// health, M6b's messaging attach/detach wiring, and m7/m8's terminal-state and backend-id-mismatch
// fixes.
//
// ⚠️ WHY THIS FILE MOCKS `isOfficialQuery`. The router tags every `Query` it opens on the official
// leg into a private, in-module `WeakSet` (`door.ts`'s `OFFICIAL_HANDLES`) — `isOfficialQuery` reads
// it, nothing constructs membership from outside the package. A hand-built fake `Query` therefore
// fails `open()`'s own defence-in-depth check (`isOfficialQuery(routerQuery)`) by construction,
// which is exactly why every existing test that drives a real official session is an e2e test behind
// the real router (`official-leg.e2e.test.ts`) rather than a fake-query unit test. `mock.module`
// overwrites the export on the (possibly already-loaded) module's own namespace object in place —
// per `bun:test`'s own doc comment, "if the module is already loaded, exports are overwritten" — so
// this works regardless of import order and needs no dynamic `import()` gymnastics. It is undone in
// `afterAll` so no other test file sharing this process sees a fake treated as real.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { installMockModuleTripwire } from "../mock-module-tripwire";
import * as winterRuntimeSdk from "@yanlinglabs/winter-runtime-sdk";

// Minor 4 (whole-branch review, adopting m6): installed BEFORE the file's own top-level
// `mock.module` call just below — the tripwire's own header requires the wrap to be in place
// before the first call it must count, or that call is invisible to it and the restoring
// `afterAll` right after it would misread as an odd (leaked) count on its own. Its CHECKING
// `afterAll` still runs last regardless of this early call site: `installMockModuleTripwire`
// defers that registration to a microtask, so it only fires once this file's whole synchronous
// body — including the restoring `afterAll` two lines down and every `describe` below — has
// already registered its own hooks.
installMockModuleTripwire();
mock.module("@yanlinglabs/winter-runtime-sdk", () => ({ ...winterRuntimeSdk, isOfficialQuery: () => true }));
afterAll(() => {
  mock.module("@yanlinglabs/winter-runtime-sdk", () => winterRuntimeSdk);
});

import type { NewSessionEvent, SessionEvent } from "@norma/protocol";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { createProjector, type Projector } from "../../src/projector";
import { FakeCheckpoints } from "../projector/harness";
import type { NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import type { OfficialInputDeps, OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import type { OfficialSessionAttachment } from "../../src/runtime-sdk/messaging";
import {
  OfficialSessionEnded,
  startOfficialSession,
  type OfficialSession,
  type OfficialSessionDeps,
  type OfficialSessionRecords,
} from "../../src/runtime-sdk/official-session";

// ── the fake wire ────────────────────────────────────────────────────────────────────────────────

type Frame = Record<string, unknown>;
const init = (sessionId: string, extra: Frame = {}): Frame => ({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test/echo", tools: ["AskUserQuestion"], ...extra });
const assistant = (text: string): Frame => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (extra: Frame = {}): Frame => ({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "", ...extra });
/** M6a: the router's `OfficialSessionStoreError` frame shape (`official/errors.d.ts` §13.11). */
const mirrorError = (): Frame => ({ code: "official_session_store_failure", transcriptHealth: "repair-required" });

class FakeOfficialQuery {
  readonly pushed: string[] = [];
  interrupts = 0;
  private readonly buffer: Array<{ value: Frame } | { done: true } | { error: unknown }> = [];
  private readonly waiters: Array<(r: IteratorResult<Frame>) => void> = [];
  private readonly rejecters: Array<(e: unknown) => void> = [];
  private terminal: { done: true } | { error: unknown } | undefined;

  constructor(prompt: AsyncIterable<string>) {
    void (async () => {
      for await (const t of prompt) this.pushed.push(t);
      this.end();
    })();
  }

  emit(frame: Frame): void {
    const w = this.waiters.shift();
    if (w !== undefined) { this.rejecters.shift(); w({ value: frame, done: false }); return; }
    this.buffer.push({ value: frame });
  }
  end(): void { if (this.terminal !== undefined) return; this.terminal = { done: true }; this.settle(); }
  fail(error: unknown): void { if (this.terminal !== undefined) return; this.terminal = { error }; this.settle(); }
  private settle(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!; const r = this.rejecters.shift()!;
      if (this.terminal !== undefined && "error" in this.terminal) r(this.terminal.error); else w({ value: undefined as never, done: true });
    }
  }
  next(): Promise<IteratorResult<Frame>> {
    const b = this.buffer.shift();
    if (b !== undefined && "value" in b) return Promise.resolve({ value: b.value, done: false });
    if (this.terminal !== undefined) return "error" in this.terminal ? Promise.reject(this.terminal.error) : Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => { this.waiters.push(resolve); this.rejecters.push(reject); });
  }
  return(): Promise<IteratorResult<Frame>> { this.end(); return Promise.resolve({ value: undefined as never, done: true }); }
  throw(e: unknown): Promise<IteratorResult<Frame>> { this.fail(e); return Promise.reject(e); }
  [Symbol.asyncIterator](): this { return this; }
  async interrupt(): Promise<unknown> { this.interrupts++; return undefined; }
}

// ── the harness ──────────────────────────────────────────────────────────────────────────────────

const SESSION_ID = "s_official_x";
const BACKEND_ID = "be-official-x";

interface Harness {
  session: OfficialSession;
  queries: FakeOfficialQuery[];
  events: SessionEvent[];
  broadcasts: SessionEvent[];
  healthCalls: Array<{ sessionId: string; health: string }>;
  attachments: Array<{ session: OfficialSessionAttachment; detached: number }>;
  tracked: Array<{ abort: AbortController; end: () => Promise<void> }>;
  untracked: number;
  q(): FakeOfficialQuery;
  settled(): Promise<void>;
  types(): string[];
}

function harness(overrides: Partial<OfficialSessionDeps> = {}): Harness {
  const queries: FakeOfficialQuery[] = [];
  const events: SessionEvent[] = [];
  const broadcasts: SessionEvent[] = [];
  const attachments: Harness["attachments"] = [];
  const tracked: Harness["tracked"] = [];
  const healthCalls: Harness["healthCalls"] = [];
  const checkpoints = new FakeCheckpoints();
  let seq = 0;

  const h: Harness = {
    session: undefined as unknown as OfficialSession,
    queries, events, broadcasts, healthCalls, attachments, tracked, untracked: 0,
    q: () => queries[queries.length - 1]!,
    settled: () => Bun.sleep(5),
    types: () => events.map((e) => e.type),
  };

  const runtime = {
    sdk: { query: ({ prompt }: { prompt: AsyncIterable<string> }) => { const q = new FakeOfficialQuery(prompt); queries.push(q); return q as unknown; } },
    trackQuery: (_sid: string, abort: AbortController, end: () => Promise<void>) => { tracked.push({ abort, end }); },
    untrack: () => { h.untracked++; },
  } as unknown as NormaRuntimeSdk;

  const selection: RuntimeSelection = {
    runtimeKind: "claude-agent",
    providerId: "test",
    modelRef: "claude-test/echo",
    family: "claude",
    authFamily: "custom",
    sdkVersion: "0.0.3",
    reason: "unit test",
    decidedAt: new Date(0).toISOString(),
  };

  const inputDeps: OfficialInputDeps = {
    home: "/tmp/official-session-test-home",
    selection,
    // Empty (not absent) so `officialCredentialPlan` returns immediately rather than trying to
    // derive a family's variables this test does not care about (`official-options.ts`'s own
    // header: the `custom`-family escape hatch).
    explicitCredentials: [],
    explicitConnectionEnv: {},
    officialPeer: undefined,
    claudeExecutableFor: () => ({ path: "/usr/bin/true" }),
    assembler: { assemble: () => "" },
    capabilities: {},
    canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
    policy: "auto",
  };

  const sessionInput: OfficialSessionInput = { sessionId: SESSION_ID, mode: "code", cwd: "/repo" };

  const records: OfficialSessionRecords = {
    setTranscriptHealth: (winterSessionId, health) => { healthCalls.push({ sessionId: winterSessionId, health }); },
  };

  type Attach = NonNullable<OfficialSessionDeps["messaging"]>["attach"];
  const attach: Attach = ((_runtime: unknown, session: OfficialSessionAttachment) => {
    const rec = { session, detached: 0 };
    attachments.push(rec);
    return { address: `session:${session.backendSessionId}`, ready: Promise.resolve(), refresh: () => {}, detach: () => { rec.detached++; } };
  }) as Attach;

  h.session = startOfficialSession({
    sessionId: SESSION_ID,
    backendSessionId: BACKEND_ID,
    mode: "code",
    runtime,
    selection,
    sessionInput: () => sessionInput,
    inputDeps: () => inputDeps,
    projector: (generation) => createProjector({
      sessionId: SESSION_ID, mode: "code", generation, runtimeKind: "claude-agent",
      nextSeq: () => ++seq,
      checkpoint: checkpoints,
      now: () => new Date().toISOString(),
      log: { warn: () => {} },
    }) as Projector,
    append: (e: NewSessionEvent) => { const stamped = { ...e, seq: ++seq, ts: Date.now() } as SessionEvent; events.push(stamped); return stamped; },
    broadcast: (e) => { broadcasts.push({ ...e, seq, ts: Date.now() } as SessionEvent); },
    messaging: { attach },
    records,
    log: () => {},
    ...overrides,
  });

  return h;
}

// ── M6a ──────────────────────────────────────────────────────────────────────────────────────────

describe("M6a — mirror_error → transcript health", () => {
  test("a mirror_error frame sets transcript health exactly once and emits nothing else", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID));
    await h.settled();
    const before = h.types();

    h.q().emit(mirrorError());
    await h.settled();
    expect(h.healthCalls).toEqual([{ sessionId: SESSION_ID, health: "repair-required" }]);
    // Nothing else was produced from that frame — no new event, no projector involvement.
    expect(h.types()).toEqual(before);

    // A second mirror_error frame (same session) does not re-fire the setter.
    h.q().emit(mirrorError());
    await h.settled();
    expect(h.healthCalls).toHaveLength(1);

    // The turn the frame interrupted still completes normally.
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.session.turnRunning).toBe(false);
    expect(h.types()).toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
  });

  test("an unrelated frame (fail-closed) is left to ordinary handling, never treated as mirror_error", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID));
    h.q().emit({ code: "official_session_store_failure" }); // missing transcriptHealth — not a match
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.healthCalls).toHaveLength(0);
    expect(h.session.turnRunning).toBe(false);
  });
});

// ── M6b ──────────────────────────────────────────────────────────────────────────────────────────

describe("M6b — messaging attach/detach", () => {
  test("open() attaches; a pushed delivery reaches the session as a user turn", async () => {
    const h = harness();
    await h.session.open();
    expect(h.attachments).toHaveLength(1);
    expect(h.attachments[0]!.session).toMatchObject({ sessionId: SESSION_ID, backendSessionId: BACKEND_ID, mode: "code", generation: 1 });

    // The wiring under test: `deps.messaging.attach` is handed a `deliver` that reaches
    // `OfficialSession.deliver` — the router's own `AttachedOfficialSession.push` would call
    // exactly this in production (see `messaging.test.ts`'s own `attachOfficialSession` describe
    // block for that half of the wire, over a real router).
    h.attachments[0]!.session.deliver("delivered turn");
    await h.settled();
    expect(h.q().pushed).toEqual(["delivered turn"]);
    expect(h.events.find((e) => e.type === "user_message")).toMatchObject({ clientName: "messaging", text: "delivered turn" });
  });

  test("end() detaches (via the generation's own teardown)", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(BACKEND_ID));
    await h.settled();
    expect(h.attachments[0]!.detached).toBe(0);

    await h.session.end();
    expect(h.attachments[0]!.detached).toBe(1);
  });

  test("no messaging deps configured — open() never throws and attaches nothing", async () => {
    const h = harness({ messaging: undefined });
    await h.session.open();
    expect(h.attachments).toHaveLength(0);
  });
});

// ── m7 ───────────────────────────────────────────────────────────────────────────────────────────

describe("m7 — end() is terminal", () => {
  test("stateValue reaches \"ended\" after end(); a later send() throws and never spawns", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID));
    await h.settled();
    expect(h.session.state).toBe("live");

    await h.session.end();
    expect(h.session.state).toBe("ended");

    let caught: unknown;
    try {
      await h.session.send("too late");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OfficialSessionEnded);
    // No second incarnation was ever opened.
    expect(h.queries).toHaveLength(1);
  });

  test("an unexpected crash (never `end()`) leaves the session resumable — the next send() opens a fresh incarnation", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID));
    await h.settled();
    const crash = new Error("child died");
    crash.name = "ProcessError";
    h.q().fail(crash);
    await h.settled();
    expect(h.session.state).toBe("resumable");
    expect(h.session.resumed).toBe(false); // the FIRST incarnation was not itself a resume

    await h.session.send("again");
    expect(h.queries).toHaveLength(2);
    expect(h.session.resumed).toBe(true); // the SECOND incarnation is
  });
});

// ── m8 ───────────────────────────────────────────────────────────────────────────────────────────

describe("m8 — backend id mismatch", () => {
  test("a system/init whose uuid differs from the pre-allocated backendSessionId ends the session with a typed terminal", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init("some-other-uuid"));
    await h.settled();

    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string }) | undefined;
    expect(err?.code).toBe("official_backend_id_mismatch");

    // Ended, not left running: no further frame processing, and the session is terminal.
    await h.settled();
    expect(h.session.state).toBe("ended");
    let caught: unknown;
    try {
      await h.session.send("still too late");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OfficialSessionEnded);
  });
});
