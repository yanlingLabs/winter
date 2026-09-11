// P8b Task 16 — the per-session driver over a FAKE `Query`.
//
// No child process anywhere in this file. The fake below is the wire the driver iterates: a test
// pushes frames into it (`emit`), ends it (`end`), or makes it throw (`fail`), and records what the
// driver pushed into its own prompt queue (`pushed`). The projector is the REAL one over the
// projector suite's `FakeCheckpoints`; the store is an array. What is under test is the state
// machine and the push/hold/resume discipline (P8b-5/24/32/38), not the fold.
import { describe, expect, test } from "bun:test";
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent, SessionEvent } from "@norma/protocol";
import { SHUTDOWN_QUERY_GRACE_MS, type NormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { createProjector, type Projector } from "../../src/projector";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import {
  WINTER_SESSION_END_GRACE_MS, startWinterSession, type WinterIncarnation, type WinterSession, type WinterSessionDeps,
} from "../../src/runtime-sdk/winter-session";
import type { WinterSessionAttachment } from "../../src/runtime-sdk/messaging";
import { FakeCheckpoints } from "../projector/harness";

// ── the fake wire ────────────────────────────────────────────────────────────────────────────────

type Frame = Record<string, unknown>;
const init = (o: Options, tools: string[] = ["AskUserQuestion", "SendMessage"]): Frame =>
  ({ type: "system", subtype: "init", session_id: o.resume ?? o.sessionId, model: o.model ?? "winter-test/echo", tools, cwd: o.cwd });
const assistant = (text: string): Frame => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (extra: Frame = {}): Frame => ({ type: "result", subtype: "success", is_error: false, permission_denials: [], result: "", ...extra });
const named = (name: string, message = name): Error => { const e = new Error(message); e.name = name; return e; };

class FakeQuery {
  readonly pushed: string[] = [];
  readonly models: Array<string | undefined> = [];
  interrupts = 0;
  promptClosed = false;
  /** What `interrupt()` does: emit the interrupted terminal (the 0.0.4 behaviour) and, when asked,
   *  ALSO end the iteration with an AbortError (the older behaviour the brief assumed). */
  interruptEndsChild = false;
  /** A child that ignores its closing stdin (mid-turn) — `end()` must abort it. */
  ignoreClose = false;
  private readonly buffer: Array<{ value: Frame } | { done: true } | { error: unknown }> = [];
  private readonly waiters: Array<(r: IteratorResult<Frame>) => void> = [];
  private readonly rejecters: Array<(e: unknown) => void> = [];
  private terminal: { done: true } | { error: unknown } | undefined;
  readonly messaging = {
    listReachable: async () => [], deliver: async () => { throw new Error("never"); },
    steerChild: async () => { throw new Error("never"); }, resumeChild: async () => { throw new Error("never"); },
    subscribeIdle: async () => { throw new Error("never"); }, senderClass: async () => "prompts" as const,
    readNotifications: async () => ({ notifications: [], remaining: 0 }), onIdleNotice: () => () => {},
  };

  constructor(prompt: AsyncIterable<string>, readonly options: Options) {
    options.abortController?.signal.addEventListener("abort", () => this.fail(named("AbortError", "query aborted: runtime process killed")));
    void (async () => {
      for await (const t of prompt) this.pushed.push(t);
      this.promptClosed = true;
      if (!this.ignoreClose) this.end();
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
  async interrupt(): Promise<void> {
    this.interrupts++;
    this.emit(result({ interrupted: true }));
    if (this.interruptEndsChild) this.fail(named("AbortError", "query aborted: runtime process killed"));
  }
  async setModel(model?: string): Promise<void> { this.models.push(model); }
}

// ── the harness ──────────────────────────────────────────────────────────────────────────────────

interface Harness {
  session: WinterSession;
  queries: FakeQuery[];
  incarnations: WinterIncarnation[];
  events: SessionEvent[];
  broadcasts: SessionEvent[];
  attachments: Array<{ session: WinterSessionAttachment; detached: number; refreshed: number }>;
  tracked: Array<{ abort: AbortController }>;
  untracked: number;
  records: { generation: number; state: string; transitions: string[]; ended: Array<{ generation: number; reason: string }> };
  checkpoints: FakeCheckpoints;
  transcriptExists: boolean;
  /** The current fake (the last query opened). */
  q(): FakeQuery;
  /** Wait for the driver to reach its init handling. */
  settled(): Promise<void>;
  types(): string[];
}

function harness(overrides: Partial<Omit<WinterSessionDeps, "idleTimeoutMs">> & { idleTimeoutMs?: number; transcript?: boolean } = {}): Harness {
  // The two harness knobs are NOT driver deps — they must not be spread over the thunks below.
  const { idleTimeoutMs: idleMs, transcript, ...over } = overrides;
  const queries: FakeQuery[] = [];
  const incarnations: WinterIncarnation[] = [];
  const events: SessionEvent[] = [];
  const broadcasts: SessionEvent[] = [];
  const attachments: Harness["attachments"] = [];
  const tracked: Harness["tracked"] = [];
  const checkpoints = new FakeCheckpoints();
  let seq = 0;
  const h: Harness = {
    session: undefined as unknown as WinterSession,
    queries, incarnations, events, broadcasts, attachments, tracked, untracked: 0,
    records: { generation: 0, state: "ready", transitions: [], ended: [] },
    checkpoints,
    transcriptExists: transcript ?? false,
    q: () => queries[queries.length - 1]!,
    settled: () => Bun.sleep(5),
    types: () => events.map((e) => e.type),
  };
  const runtime = {
    sdk: { query: ({ prompt, options }: { prompt: AsyncIterable<string>; options: Options }) => { const q = new FakeQuery(prompt, options); queries.push(q); return q as unknown as Query; } },
    trackQuery: (_sid: string, abort: AbortController) => { tracked.push({ abort }); },
    untrack: () => { h.untracked++; },
  } as unknown as NormaRuntimeSdk;
  const idle = idleMs ?? 60_000;
  h.session = startWinterSession({
    sessionId: "s_x", backendSessionId: "be-x", mode: "chat", runtime,
    options: (inc) => { incarnations.push(inc); return { abortController: inc.abort, cwd: "/repo", model: "winter-test/echo", ...(inc.resume ? { resume: "be-x" } : { sessionId: "be-x" }) }; },
    projector: (inc): Projector => createProjector({ sessionId: "s_x", mode: "chat", generation: inc.generation, winterSessionId: "s_x", nextSeq: () => seq + 1, checkpoint: checkpoints, now: () => new Date().toISOString(), log: {} }),
    queue: createHostPromptQueue,
    append: (e: NewSessionEvent) => { const stamped = { ...e, seq: ++seq, ts: Date.now() } as SessionEvent; events.push(stamped); return stamped; },
    broadcast: (e) => { broadcasts.push({ ...e, seq, ts: Date.now() } as SessionEvent); },
    messaging: {
      attach: ((_runtime: unknown, session: WinterSessionAttachment) => {
        const rec = { session, detached: 0, refreshed: 0 };
        attachments.push(rec);
        return { address: `winter-agent:session:${session.backendSessionId}`, ready: Promise.resolve(), refresh: () => { rec.refreshed++; }, detach: () => { rec.detached++; } };
      }) as unknown as WinterSessionDeps["messaging"]["attach"],
    },
    records: {
      bumpGeneration: () => ({ generation: ++h.records.generation }),
      endGeneration: (_id, generation, reason) => { h.records.ended.push({ generation, reason }); },
      transition: (_id, to) => { h.records.transitions.push(to); h.records.state = to; },
      get: () => ({ state: h.records.state as never, generation: h.records.generation }),
    },
    hasTranscript: () => h.transcriptExists,
    idleTimeoutMs: () => idle,
    endGraceMs: 25,
    ...over,
  });
  return h;
}

const seen = (h: Harness, type: string): SessionEvent[] => h.events.filter((e) => e.type === type);

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe("startWinterSession — one incarnation", () => {
  test("open() spawns through runtime.sdk.query with the host queue as the prompt, a FRESH sessionId, and is tracked", async () => {
    const h = harness();
    expect(h.session.state).toBe("resumable");
    await h.session.open();
    expect(h.session.state).toBe("live");
    expect(h.queries).toHaveLength(1);
    expect(h.q().options.sessionId).toBe("be-x");
    expect(h.q().options.resume).toBeUndefined();
    expect(h.incarnations[0]).toMatchObject({ generation: 1, resume: false });
    expect(h.tracked).toHaveLength(1);
    expect(h.tracked[0]!.abort).toBe(h.incarnations[0]!.abort);
    expect(h.session.generation).toBe(1);
    // the first incarnation with no push is IDLE, not running
    expect(h.records.transitions).toEqual(["idle"]);
  });

  test("system/init records the facts and attaches messaging with the backend id and generation", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options, ["AskUserQuestion", "SendMessage", "mcp__norma__browser__browser"]));
    await h.settled();
    expect(h.session.init).toEqual({ sessionId: "be-x", model: "winter-test/echo", tools: ["AskUserQuestion", "SendMessage", "mcp__norma__browser__browser"] });
    expect(h.attachments).toHaveLength(1);
    expect(h.attachments[0]!.session).toMatchObject({ sessionId: "s_x", backendSessionId: "be-x", mode: "chat", generation: 1 });
    expect(h.attachments[0]!.session.query).toBe(h.q() as unknown as Query);
    expect(h.attachments[0]!.session.status?.()).toBe("idle");
  });

  test("send: user_message (the client's name), then beginTurn's turn_started, then the push; the result closes the turn", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    const sent = await h.session.send("hello", "cli");
    expect(sent).toEqual({ seq: 1, queued: false });
    await h.settled();
    expect(h.q().pushed).toEqual(["hello"]);
    expect(h.session.turnRunning).toBe(true);
    expect(h.attachments[0]!.session.status?.()).toBe("running");
    expect(h.records.transitions).toEqual(["idle", "running"]);
    expect(h.types()).toEqual(["user_message", "turn_started"]);
    expect(h.events[0]).toMatchObject({ type: "user_message", clientName: "cli", text: "hello", threadId: "main" });
    h.q().emit(assistant("echo: hello"));
    h.q().emit(result());
    await h.settled();
    expect(h.types()).toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
    expect(h.session.turnRunning).toBe(false);
    expect(h.records.transitions).toEqual(["idle", "running", "idle"]);
    expect(h.session.state).toBe("live");
    expect(h.broadcasts).toEqual([]);
  });

  test("P8b-5: a send while a turn runs is HELD host-side and pushed when the current result arrives", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("A", "cli");
    const b = await h.session.send("B", "cli");
    expect(b.queued).toBe(true);
    await h.settled();
    expect(h.q().pushed).toEqual(["A"]);
    expect(h.session.pendingSends).toEqual(["B"]);
    // B's user_message AND turn_started are already in the log — only its push waits.
    expect(h.types()).toEqual(["user_message", "turn_started", "user_message", "turn_started"]);
    h.q().emit(assistant("a")); h.q().emit(result());
    await h.settled();
    expect(h.q().pushed).toEqual(["A", "B"]);
    expect(h.session.pendingSends).toEqual([]);
    expect(h.session.turnRunning).toBe(true);
    h.q().emit(assistant("b")); h.q().emit(result());
    await h.settled();
    expect(seen(h, "turn_completed")).toHaveLength(2);
    expect(seen(h, "turn_started")).toHaveLength(2);
    expect(h.session.turnRunning).toBe(false);
  });

  test("P8b-38: a steer begins its OWN turn and pushes immediately; injected reports whether a turn was running", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("A", "cli");
    const s = await h.session.steer("S");
    expect(s.injected).toBe(true);
    await h.settled();
    expect(h.q().pushed).toEqual(["A", "S"]);
    expect(h.events.filter((e) => e.type === "user_message").map((e) => (e as { clientName: string }).clientName)).toEqual(["cli", "steer"]);
    expect(seen(h, "turn_started")).toHaveLength(2);
    h.q().emit(result()); h.q().emit(result());
    await h.settled();
    expect(seen(h, "turn_completed")).toHaveLength(2);
    // a steer with nothing running is not "injected" — it started the turn
    const s2 = await h.session.steer("T");
    expect(s2.injected).toBe(false);
  });

  test("a delivery (the messaging push sink) is a steer under clientName `messaging`", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.settled();
    h.attachments[0]!.session.push("<agent-message>hi</agent-message>");
    await h.settled();
    expect(h.q().pushed).toEqual(["<agent-message>hi</agent-message>"]);
    expect(h.events[0]).toMatchObject({ type: "user_message", clientName: "messaging" });
    expect(h.types()).toEqual(["user_message", "turn_started"]);
  });

  test("interrupt with no turn running is a no-op; with a turn running it ends THAT turn with the aborted terminal and the child stays live (the 0.0.4 measurement)", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    expect(await h.session.interrupt()).toEqual({ wasRunning: false });
    expect(h.q().interrupts).toBe(0);
    await h.session.send("hang", "cli");
    expect(await h.session.interrupt()).toEqual({ wasRunning: true });
    await h.settled();
    expect(h.q().interrupts).toBe(1);
    expect(seen(h, "turn_completed")).toHaveLength(1);
    expect(seen(h, "turn_completed")[0]).toMatchObject({ stopReason: "aborted" });
    expect(seen(h, "agent_error")).toEqual([]);
    expect(h.session.state).toBe("live");
    expect(h.session.turnRunning).toBe(false);
    // and the same child takes the next send
    await h.session.send("again", "cli");
    expect(h.q().pushed).toEqual(["hang", "again"]);
    expect(h.queries).toHaveLength(1);
  });

  test("an interrupt-class END of the iteration (the child exits with AbortError) is a turn boundary: the interrupted terminal, NO agent_error, and `resumable`", async () => {
    const h = harness();
    await h.session.open();
    h.q().interruptEndsChild = true;
    h.q().emit(init(h.q().options));
    await h.session.send("hang", "cli");
    await h.session.interrupt();
    await h.session.done;
    expect(seen(h, "turn_completed")).toHaveLength(1);
    expect(seen(h, "turn_completed")[0]).toMatchObject({ stopReason: "aborted" });
    expect(seen(h, "agent_error")).toEqual([]);
    expect(h.session.state).toBe("resumable");
    expect(h.session.query).toBeUndefined();
    expect(h.attachments[0]!.detached).toBe(1);
    expect(h.untracked).toBe(1);
    expect(h.records.ended).toEqual([{ generation: 1, reason: "exited" }]);
    expect(h.records.state).toBe("exited");
  });

  test("another error class mid-turn → ONE agent_error (Task 11's code) + turn_completed(error), then `resumable`", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("x", "cli");
    h.q().fail(named("ProcessError", "unexpected process death"));
    await h.session.done;
    expect(h.types().slice(2)).toEqual(["agent_error", "turn_completed"]);
    expect(seen(h, "agent_error")[0]).toMatchObject({ code: "process_death" });
    expect(seen(h, "turn_completed")[0]).toMatchObject({ stopReason: "error" });
    expect(h.session.state).toBe("resumable");
  });

  test("a store-corruption class ends the session for good: `ended`, and a later send is a typed refusal", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("x", "cli");
    h.q().fail(named("WinterStoreError", "the transcript store is corrupt"));
    await h.session.done;
    expect(h.session.state).toBe("ended");
    expect(h.records.state).toBe("failed");
    await expect(h.session.send("y", "cli")).rejects.toMatchObject({ code: "winter_session_ended" });
  });

  test("a ProjectorRefusedError out of accept is caught: a typed agent_error, the incarnation ends, `resumable` — never a crash", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("x", "cli");
    // the source the first text-only assistant frame will claim, marked pending by "somebody else"
    h.checkpoints.marks.set("s_x/1/as:0:1", "pending");
    h.q().emit(assistant("boom"));
    await h.session.done;
    expect(seen(h, "agent_error")).toHaveLength(1);
    expect(seen(h, "agent_error")[0]).toMatchObject({ code: "projector_refused" });
    expect(h.session.state).toBe("resumable");
  });

  test("compact is a typed refusal; setModel reaches a live child and is a no-op while resumable", async () => {
    const h = harness();
    await expect(h.session.compact()).rejects.toMatchObject({ code: "not_supported_on_winter_leg" });
    await h.session.setModel("gpt-5.6-terra");   // resumable: nothing to tell
    await h.session.open();
    await h.session.setModel("gpt-5.6-luna");
    expect(h.q().models).toEqual(["gpt-5.6-luna"]);
  });
});

describe("startWinterSession — end(), the idle timer, the shutdown budget", () => {
  test("end() closes the queue; an idle child exits; `done` resolves; the session is `resumable` and untracked", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.settled();
    await h.session.end();
    expect(h.q().promptClosed).toBe(true);
    expect(h.session.state).toBe("resumable");
    expect(h.tracked[0]!.abort.signal.aborted).toBe(false);   // it left politely — no abort needed
    expect(h.untracked).toBe(1);
    expect(h.attachments[0]!.detached).toBe(1);
    expect(h.records.ended).toEqual([{ generation: 1, reason: "ended" }]);
    await h.session.end();   // idempotent
  });

  test("end() on a child mid-turn that ignores its closing stdin ABORTS it inside the budget; the open turn gets its aborted terminal", async () => {
    const h = harness();
    await h.session.open();
    h.q().ignoreClose = true;
    h.q().emit(init(h.q().options));
    await h.session.send("hang", "cli");
    const t0 = Date.now();
    await h.session.end();
    const took = Date.now() - t0;
    expect(h.tracked[0]!.abort.signal.aborted).toBe(true);
    expect(took).toBeLessThan(SHUTDOWN_QUERY_GRACE_MS);
    expect(seen(h, "turn_completed")[0]).toMatchObject({ stopReason: "aborted" });
    expect(seen(h, "agent_error")).toEqual([]);
    expect(h.session.state).toBe("resumable");
  });

  test("the pre-abort budget fits twice inside dispose()'s grace (P8b-32)", () => {
    expect(WINTER_SESSION_END_GRACE_MS * 2).toBeLessThan(SHUTDOWN_QUERY_GRACE_MS);
  });

  test("the idle timer ends an idle live session — and does NOT fire while a turn runs", async () => {
    const h = harness({ idleTimeoutMs: 50 });
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("slow", "cli");
    await Bun.sleep(120);
    expect(h.session.state).toBe("live");          // a turn is running: no reaping
    h.q().emit(result());
    await Bun.sleep(120);
    expect(h.session.state).toBe("resumable");     // idle for > 50 ms: ended
    expect(h.records.ended).toEqual([{ generation: 1, reason: "ended" }]);
  });
});

describe("startWinterSession — resume", () => {
  test("a send from `resumable` opens a NEW query with options.resume = backendSessionId, a bumped generation, and re-attaches", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.session.send("first", "cli");
    h.q().emit(result());
    await h.settled();
    await h.session.end();
    h.transcriptExists = true;   // the first turn wrote it
    const sent = await h.session.send("again", "cli");
    expect(h.queries).toHaveLength(2);
    expect(h.q().options.resume).toBe("be-x");
    expect(h.q().options.sessionId).toBeUndefined();
    expect(h.incarnations[1]).toMatchObject({ generation: 2, resume: true });
    expect(h.session.generation).toBe(2);
    expect(h.tracked).toHaveLength(2);
    expect(sent.queued).toBe(false);
    expect(h.q().pushed).toEqual(["again"]);
    h.q().emit(init(h.q().options));
    await h.settled();
    expect(h.attachments).toHaveLength(2);
    expect(h.attachments[1]!.session.generation).toBe(2);
    expect(h.records.transitions.at(-1)).toBe("running");
  });

  test("a resume with NO transcript on disk starts FRESH under the same uuid (the measured hang otherwise)", async () => {
    const h = harness();
    await h.session.open();
    await h.session.end();   // idled out before any turn: nothing was written
    await h.session.send("hello", "cli");
    expect(h.q().options.sessionId).toBe("be-x");
    expect(h.q().options.resume).toBeUndefined();
    expect(h.incarnations[1]).toMatchObject({ generation: 2, resume: false });
  });

  test("deliveries that reach the sink while resumable are HELD and pushed first on resume, before the new text", async () => {
    const h = harness();
    await h.session.open();
    h.q().emit(init(h.q().options));
    await h.settled();
    const sink = h.attachments[0]!.session.push;
    await h.session.end();
    sink("<agent-message>late</agent-message>");
    expect(h.session.heldDeliveries).toEqual(["<agent-message>late</agent-message>"]);
    expect(h.events).toEqual([]);   // nothing appended yet — no live projector to begin a turn on
    await h.session.send("now", "cli");
    // The delivery was pushed FIRST and is now the running turn, so the new text is held behind it
    // (P8b-5) and follows at its result — "held deliveries first, then the new text".
    expect(h.q().pushed).toEqual(["<agent-message>late</agent-message>"]);
    expect(h.session.pendingSends).toEqual(["now"]);
    expect(h.session.heldDeliveries).toEqual([]);
    expect(h.events.map((e) => (e as { clientName?: string }).clientName ?? e.type)).toEqual(["messaging", "turn_started", "cli", "turn_started"]);
    h.q().emit(result());
    await h.settled();
    expect(h.q().pushed).toEqual(["<agent-message>late</agent-message>", "now"]);
  });

  test("a send held behind a turn survives the incarnation's end: pushed first on resume with NO second turn_started", async () => {
    const h = harness();
    await h.session.open();
    h.q().ignoreClose = true;
    h.q().emit(init(h.q().options));
    await h.session.send("A", "cli");
    await h.session.send("B", "cli");   // held
    await h.session.end();              // aborts A's hanging turn
    expect(h.session.pendingSends).toEqual(["B"]);
    expect(seen(h, "turn_completed")).toHaveLength(1);   // A's aborted terminal only
    await h.session.send("C", "cli");
    // B was replayed first and is the running turn on the new child; C is held behind it (P8b-5).
    expect(h.q().pushed).toEqual(["B"]);
    expect(h.session.pendingSends).toEqual(["C"]);
    expect(seen(h, "turn_started")).toHaveLength(3);      // A, B, C — B's was not re-appended
    h.q().emit(result());                                 // B's result releases C
    await h.settled();
    expect(h.q().pushed).toEqual(["B", "C"]);
    expect(h.session.pendingSends).toEqual([]);
    h.q().emit(result());
    await h.settled();
    expect(seen(h, "turn_completed")).toHaveLength(3);
  });

  test("two concurrent sends from resumable open ONE child (never a second winter process on one transcript)", async () => {
    const h = harness();
    await h.session.open();
    await h.session.end();
    await Promise.all([h.session.send("one", "cli"), h.session.send("two", "cli")]);
    expect(h.queries).toHaveLength(2);
    expect(h.q().pushed).toEqual(["one"]);
    expect(h.session.pendingSends).toEqual(["two"]);
  });
});
