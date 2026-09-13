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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";
import type { RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { createProjector, type Projector } from "../../src/projector";
import { FakeCheckpoints } from "../projector/harness";
import type { WinterRuntimeSdk } from "../../src/runtime-sdk/create";
import type { OfficialInputDeps, OfficialSessionInput } from "../../src/runtime-sdk/official-options";
import type { OfficialSessionAttachment } from "../../src/runtime-sdk/messaging";
import {
  CONSOLE_API_KEY_SOURCE,
  expectedApiKeySource,
  OfficialSessionEnded,
  startOfficialSession,
  type OfficialSession,
  type OfficialSessionDeps,
  type OfficialSessionRecords,
} from "../../src/runtime-sdk/official-session";

// ── hermetic per-harness home (fix round 1, review r0's Major) ─────────────────────────────────
//
// `open()` REALLY calls `ensureOfficialConfigDir(built.input.spool)` against `inputDeps.home`
// (Phase 9c/P9c-1) — this file's `harness()` is one of the two real callers of `open()` in the
// whole suite (`official-leg.e2e.test.ts` is the other), so a fixed, non-mkdtemp'd `home` here
// really does create `<home>/runtimes/claude-config` (0700) on disk, on a shared literal path,
// once per `bun test` run, never cleaned. Mirrors `hermeticOfficialHome`/`cleanupHermeticOfficialHomes`
// (`test/helpers/claude-runtime.ts`): one fresh `mkdtemp` root per `harness()` call, tracked here
// and removed in this file's own `afterAll` (kept local rather than importing that helper — this
// file drives the fake wire directly and has no other need of `claude-runtime.ts`).
const testHomes: string[] = [];
function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "winter-official-session-test-"));
  testHomes.push(home);
  return home;
}
afterAll(() => {
  for (const home of testHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

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
  } as unknown as WinterRuntimeSdk;

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
    home: testHome(),
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

  // P10a-h (measured live against the real official runtime): `end()` used to only close the input
  // stream and await the incarnation's own `done` — a child that does not exit merely because its
  // input closed left `end()` (and therefore a handoff's own `HandoffSourceOwner.close()`, which
  // calls this) hanging, or — against a real process — returning anyway once a DIFFERENT frame
  // ended the read loop, leaving the actual OS process alive and its resume-lock held (which is
  // what made a destination's own resume of the SAME backend uuid fail typed with the winter
  // runtime's own "in use by another live process"). `end()` now falls back to `abort()`, mirroring
  // `WinterSession.end()`'s exact race-then-abort-then-race shape.
  test("P10a-h: end() falls back to abort() when the child never exits on its own after the input closes", async () => {
    // A fake `OfficialQuery` that deliberately IGNORES its prompt stream closing (the bug's own
    // precondition) and only ever ends when its incarnation's `AbortController` fires — proving
    // `end()`'s fallback is what makes it finish, not merely that it eventually would have anyway.
    class StuckFakeOfficialQuery {
      interrupts = 0;
      private endedByAbort = false;
      private waiters: Array<(r: IteratorResult<Frame>) => void> = [];
      constructor(prompt: AsyncIterable<string>, abort: AbortController) {
        void (async () => { for await (const _t of prompt) { /* drained, deliberately never ends itself */ } })();
        abort.signal.addEventListener("abort", () => {
          this.endedByAbort = true;
          for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
        });
      }
      next(): Promise<IteratorResult<Frame>> {
        if (this.endedByAbort) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => { this.waiters.push(resolve); });
      }
      return(): Promise<IteratorResult<Frame>> { return Promise.resolve({ value: undefined as never, done: true }); }
      throw(e: unknown): Promise<IteratorResult<Frame>> { return Promise.reject(e); }
      [Symbol.asyncIterator](): this { return this; }
      async interrupt(): Promise<unknown> { this.interrupts++; return undefined; }
    }
    const stuckQueries: StuckFakeOfficialQuery[] = [];
    const stuckRuntime = {
      sdk: {
        query: ({ prompt, options }: { prompt: AsyncIterable<string>; options: { abortController: AbortController } }) => {
          const q = new StuckFakeOfficialQuery(prompt, options.abortController);
          stuckQueries.push(q);
          return q as unknown;
        },
      },
      trackQuery: () => {},
      untrack: () => {},
    } as unknown as WinterRuntimeSdk;
    // A short grace (never the 120 ms production default) so a REGRESSION back to "only await
    // inc.done" fails this test by timing out, rather than by hanging the whole suite.
    const h = harness({ runtime: stuckRuntime, endGraceMs: 20 });
    await h.session.open();
    expect(h.session.state).toBe("live");

    await Promise.race([
      h.session.end(),
      Bun.sleep(2_000).then(() => { throw new Error("end() did not resolve — the abort fallback regressed"); }),
    ]);
    expect(h.session.state).toBe("ended");
    expect(stuckQueries).toHaveLength(1);
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

// ── Phase 9c (P9c-1) ─────────────────────────────────────────────────────────────────────────────
//
// The api-key family's own assertion on the REAL SDK init message (`official-options.ts`'s own
// `OfficialAuthSourceRefused`) — scripted here with `init(BACKEND_ID, { apiKeySource })`, the SAME
// `harness()`/`FakeOfficialQuery` this file's M6/m7/m8 suites already use, rather than a second,
// duplicated harness in a new file. `harness({ selection })` overrides ONLY the outer
// `OfficialSessionDeps.selection` this assertion reads (`this.deps.selection.authFamily`) — the
// closure's own `inputDeps.selection` stays the harness default (`authFamily: "custom"`), which is
// harmless here because `inputDeps.explicitCredentials: []` short-circuits `officialCredentialPlan`
// before it ever branches on a family at all (`official-options.ts`'s own header).
describe("P9c-1 — the api-key family's own apiKeySource assertion", () => {
  const apiKeySelection: RuntimeSelection = {
    runtimeKind: "claude-agent",
    providerId: "anthropic",
    modelRef: "anthropic/claude-sonnet-5",
    family: "claude",
    authFamily: "api-key",
    sdkVersion: "0.0.3",
    reason: "unit test",
    decidedAt: new Date(0).toISOString(),
  };

  test("apiKeySource !== ANTHROPIC_API_KEY -> official_auth_source_refused, before any turn runs", async () => {
    const h = harness({ selection: apiKeySelection });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "none" }));
    await h.settled();

    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string; message?: string }) | undefined;
    expect(err?.code).toBe("official_auth_source_refused");
    expect(err?.message).toContain("apiKeySource=none");
    expect(h.session.state).toBe("ended");
    // No turn ever ran: the init frame refused before the projector saw an assistant/result frame.
    expect(h.types()).not.toContain("assistant_message");
    expect(h.types()).not.toContain("turn_completed");

    let caught: unknown;
    try {
      await h.session.send("too late");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OfficialSessionEnded);
  });

  test("apiKeySource === ANTHROPIC_API_KEY -> no refusal; the turn proceeds normally", async () => {
    const h = harness({ selection: apiKeySelection });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "ANTHROPIC_API_KEY" }));
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.events.some((e) => e.type === "agent_error")).toBe(false);
    expect(h.types()).toContain("turn_completed");
    expect(h.session.state).not.toBe("ended");
  });

  test("an unknown/missing apiKeySource (never invented as a pass) still refuses for the api-key family", async () => {
    const h = harness({ selection: apiKeySelection });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID)); // no apiKeySource field at all
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string }) | undefined;
    expect(err?.code).toBe("official_auth_source_refused");
  });

  // Winter Phase 10a (router 0.0.4, C1): `session-driver.ts`'s own `assembleOfficial` now widens a
  // console-arm session's `RuntimeSelection.authFamily` to `"console-profile"` DIRECTLY (the C1-interim
  // fix wave's parallel `officialAuthArm` field on `OfficialInputDeps` is gone) — this test builds
  // that widened selection and passes it as BOTH `OfficialSessionDeps.selection` (what the assertion
  // gate reads) and `OfficialInputDeps.selection` (what `officialInputFor` itself reads), exactly the
  // way production threads one selection object through both.
  const consoleSelection: RuntimeSelection = { ...apiKeySelection, authFamily: "console-profile" };

  test("selection.authFamily === \"console-profile\" -> the assertion expects CONSOLE_API_KEY_SOURCE, not ANTHROPIC_API_KEY", async () => {
    const consoleInputDeps: OfficialInputDeps = {
      home: testHome(),
      selection: consoleSelection,
      explicitCredentials: [],
      explicitConnectionEnv: {},
      officialPeer: undefined,
      claudeExecutableFor: () => ({ path: "/usr/bin/true" }),
      assembler: { assemble: () => "" },
      capabilities: {},
      canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
      policy: "auto",
      // Fix wave (F1): the router-version gate now compares the compile-time pin
      // (`REQUIRED_WINTER_RUNTIME_SDK`, "0.0.4") against `CONSOLE_AUTH_ROUTER_MIN` ("0.0.4"), never
      // a runtime probe of the installed package — so no override is needed to reach the
      // apiKeySource assertion under test here (that gate has its own coverage in
      // official-options.test.ts).
    };
    const h = harness({ selection: consoleSelection, inputDeps: () => consoleInputDeps });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "ANTHROPIC_API_KEY" })); // the api-key arm's own value — wrong for this arm
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string; message?: string }) | undefined;
    expect(err?.code).toBe("official_auth_source_refused");
    expect(err?.message).toContain("apiKeySource=ANTHROPIC_API_KEY");
    expect(err?.message).toContain(CONSOLE_API_KEY_SOURCE);
  });

  test("selection.authFamily === \"console-profile\" with a matching apiKeySource never refuses; the turn proceeds normally", async () => {
    const consoleInputDeps: OfficialInputDeps = {
      home: testHome(),
      selection: consoleSelection,
      explicitCredentials: [],
      explicitConnectionEnv: {},
      officialPeer: undefined,
      claudeExecutableFor: () => ({ path: "/usr/bin/true" }),
      assembler: { assemble: () => "" },
      capabilities: {},
      canUseToolDeps: { approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(), policy: "auto", emit: () => {} },
      policy: "auto",
      // Fix wave (F1): see the sibling test above — no override needed any more.
    };
    const h = harness({ selection: consoleSelection, inputDeps: () => consoleInputDeps });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: CONSOLE_API_KEY_SOURCE }));
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.events.some((e) => e.type === "agent_error")).toBe(false);
    expect(h.types()).toContain("turn_completed");
  });

  test("the console-oauth family is EXEMPT — apiKeySource \"none\" (its own expected bearer shape) never refuses", async () => {
    const consoleOauthSelection: RuntimeSelection = { ...apiKeySelection, authFamily: "console-oauth" };
    const h = harness({ selection: consoleOauthSelection });
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "none" }));
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.events.some((e) => e.type === "agent_error")).toBe(false);
    expect(h.types()).toContain("turn_completed");
  });

  test("a non-api-key, non-console-oauth family (custom, this harness's own default) is also never asserted on", async () => {
    const h = harness(); // default selection: authFamily "custom"
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "none" }));
    h.q().emit(assistant("ok"));
    h.q().emit(result());
    await h.settled();
    expect(h.events.some((e) => e.type === "agent_error")).toBe(false);
    expect(h.types()).toContain("turn_completed");
  });
});

// Winter Phase 10a (O3, P10a-3/P10a-7 M1): `expectedApiKeySource` as a standalone pure lookup — the
// console arm's own placeholder literal, and proof the api-key arm's assertion (tested end to end
// above) is now DERIVED from this function rather than a second hand-typed "ANTHROPIC_API_KEY"
// string. Wiring a real console-arm session through `run()`'s own assertion is `session-driver.ts`'s
// `RuntimeSelection.authFamily` plumbing (outside this lane's file cluster) — carried; see the lane
// report.
describe("O3 — expectedApiKeySource / CONSOLE_API_KEY_SOURCE", () => {
  test("api-key arm expects the pinned ANTHROPIC_API_KEY — unchanged from P9c-1", () => {
    expect(expectedApiKeySource("api-key")).toBe("ANTHROPIC_API_KEY");
  });

  test("console arm expects the M1 placeholder literal — a one-line edit once the controller measures the real value", () => {
    expect(expectedApiKeySource("console")).toBe(CONSOLE_API_KEY_SOURCE);
    expect(CONSOLE_API_KEY_SOURCE).toBe("<M1-unmeasured>");
  });

  test("the two arms never expect the same value — a mismatch against one can never coincidentally pass as the other", () => {
    expect(expectedApiKeySource("api-key")).not.toBe(expectedApiKeySource("console"));
  });
});

// ── Phase 9c (P9c-1), Step 5 — the documented forceLoginOrgUUID / managed-policy failure mode ──
//
// CARRY (the brief's own wording): a managed `forceLoginOrgUUID` deployment cannot be reproduced
// without a managed Mac, so this is the unit-level proof on a SCRIPTED child exit — the real
// binary's own text is never something this suite can generate.
describe("P9c-1 (Step 5) — a pre-init exit naming a managed auth-policy block", () => {
  test("forceLoginOrgUUID in the raw process error -> official_auth_blocked_by_policy, not the generic pre-init crash", async () => {
    const h = harness();
    await h.session.send("hi");
    const crash = new Error("Claude Code is configured with forceLoginOrgUUID and refuses environment credentials at startup");
    crash.name = "ProcessError";
    h.q().fail(crash);
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string; message?: string }) | undefined;
    expect(err?.code).toBe("official_auth_blocked_by_policy");
    expect(err?.message).toContain("forceLoginOrgUUID");
  });

  test("\"environment credential\" (the digest's second phrase) also matches", async () => {
    const h = harness();
    await h.session.send("hi");
    const crash = new Error("this deployment blocks environment credential injection at startup");
    crash.name = "ProcessError";
    h.q().fail(crash);
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string }) | undefined;
    expect(err?.code).toBe("official_auth_blocked_by_policy");
  });

  test("an ordinary pre-init crash unrelated to a managed policy is left to the existing generic handling", async () => {
    const h = harness();
    await h.session.send("hi");
    const crash = new Error("connection reset by peer");
    crash.name = "ProcessError";
    h.q().fail(crash);
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string }) | undefined;
    expect(err).toBeDefined();
    expect(err?.code).not.toBe("official_auth_blocked_by_policy");
  });

  test("a match AFTER init (a turn already started) never retroactively refuses — the phrase only matters pre-init", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID));
    await h.settled();
    const crash = new Error("forceLoginOrgUUID mentioned mid-turn, unrelated to startup");
    crash.name = "ProcessError";
    h.q().fail(crash);
    await h.settled();
    const err = h.events.find((e) => e.type === "agent_error") as (SessionEvent & { code?: string }) | undefined;
    expect(err?.code).not.toBe("official_auth_blocked_by_policy");
  });
});

// ── Phase 9c (P9c-1) — apiKeySource observability on OfficialInitFacts ─────────────────────────
describe("P9c-1 — apiKeySource observability on OfficialInitFacts", () => {
  test("session.init?.apiKeySource mirrors the init frame's own field, regardless of family", async () => {
    const h = harness(); // default selection: authFamily "custom" (never asserted on)
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID, { apiKeySource: "ANTHROPIC_API_KEY" }));
    await h.settled();
    expect(h.session.init?.apiKeySource).toBe("ANTHROPIC_API_KEY");
  });

  test("absent from the frame -> undefined, never invented", async () => {
    const h = harness();
    await h.session.send("hi");
    h.q().emit(init(BACKEND_ID)); // no apiKeySource field at all
    await h.settled();
    expect(h.session.init?.apiKeySource).toBeUndefined();
  });
});
