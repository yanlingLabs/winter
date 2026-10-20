import { test, expect, afterEach, jest } from "bun:test";
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import { QUESTION_PLACEHOLDER_MAX, QuestionAskedEvent, QuestionResolvedEvent, type NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { PermissionGate } from "../../src/agent/gate";
import { canUseToolFor, NO_PARK_TIMEOUT_MS, type BridgeLogger } from "../../src/runtime-sdk/approval-bridge";
import { askUserQuestionBridge, ASK_USER_QUESTION_TOOL, AskUserQuestionInput, clampPlaceholder } from "../../src/runtime-sdk/question-bridge";

const SESSION = "parent-session";
const FIXED_NOW = 1_700_000_000_000;
const silent: BridgeLogger = { info: () => {}, error: () => {} };

afterEach(() => { jest.useRealTimers(); });

/** The §5.6 input shape, hard-coded (G-9): `questions` 1..4, each with 2..4 options. */
const INPUT = {
  questions: [{
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Relational", preview: "CREATE TABLE …" },
      { label: "SQLite", description: "Embedded" },
    ],
    multiSelect: false,
  }],
  metadata: { source: "planner" },
};

function bridge(over: Partial<Parameters<typeof askUserQuestionBridge>[0]> = {}) {
  const events: NewSessionEvent[] = [];
  const questions = over.questions ?? new QuestionBroker();
  const ask = askUserQuestionBridge({
    sessionId: SESSION, questions, emit: (e) => { events.push(e); },
    log: silent, now: () => FIXED_NOW, ...over,
  });
  return { events, questions, ask };
}

function signalOf(ac = new AbortController()) { return { ac, ctx: { signal: ac.signal } }; }

// -------------------------------------------------------------------------------------------
// FIELD PARITY — the emitted question is, name for name, what `engine.ts:6218` produces today
// (`{ type, sessionId, threadId, callId, questions }`), and the resolution what `:6226` produces
// (`{ type, sessionId, threadId, callId, answers, by, notes? }`). Both hand-built below.
// -------------------------------------------------------------------------------------------

test("question_asked carries exactly the fields the engine emits today", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-q1", INPUT, ctx);

  expect(h.events).toHaveLength(1);
  expect(h.events[0]).toEqual({
    type: "question_asked",
    sessionId: SESSION,
    threadId: "main",
    callId: "tu-q1",
    questions: [{
      question: "Which database?",
      header: "Database",
      options: [
        { label: "Postgres", description: "Relational", preview: "CREATE TABLE …" },
        { label: "SQLite", description: "Embedded" },
      ],
      multiSelect: false,
    }],
  });
  expect(QuestionAskedEvent.parse({ ...h.events[0], seq: 1, ts: FIXED_NOW })).toBeTruthy();

  h.questions.respond(SESSION, "tu-q1", { "Which database?": "Postgres" }, "phone");
  await pending;
});

test("ask_user.respond resolves the call as updatedInput.answers", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-q1", INPUT, ctx);
  const res = h.questions.respond(SESSION, "tu-q1", { "Which database?": "SQLite" }, "phone");
  expect(res).toEqual({ ok: true, alreadyResolved: false });

  await expect(pending).resolves.toEqual({
    behavior: "allow",
    updatedInput: { ...INPUT, answers: { "Which database?": "SQLite" } },
    decisionClassification: "user_temporary",
  });

  expect(h.events).toHaveLength(2);
  expect(h.events[1]).toEqual({
    type: "question_resolved", sessionId: SESSION, threadId: "main", callId: "tu-q1",
    answers: { "Which database?": "SQLite" }, by: "phone",
  });
  expect(QuestionResolvedEvent.parse({ ...h.events[1], seq: 2, ts: FIXED_NOW })).toBeTruthy();
});

test("notes ride the resolution event and fold into §5.6's own annotations field", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-q1", INPUT, ctx);
  h.questions.respond(SESSION, "tu-q1", { "Which database?": "SQLite" }, "phone", { "Which database?": "keep it simple" });

  await expect(pending).resolves.toEqual({
    behavior: "allow",
    updatedInput: {
      ...INPUT,
      answers: { "Which database?": "SQLite" },
      annotations: { "Which database?": { notes: "keep it simple" } },
    },
    decisionClassification: "user_temporary",
  });
  expect(h.events[1]).toMatchObject({ notes: { "Which database?": "keep it simple" } });
});

test("the model's own annotations survive the notes merge", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const withAnnotations = { ...INPUT, annotations: { "Which database?": { preview: "schema.sql" }, "Other?": { notes: "kept" } } };
  const pending = h.ask("tu-q1", withAnnotations, ctx);
  h.questions.respond(SESSION, "tu-q1", { "Which database?": "SQLite" }, "phone", { "Which database?": "keep it simple" });

  await expect(pending).resolves.toMatchObject({
    updatedInput: {
      annotations: {
        "Which database?": { preview: "schema.sql", notes: "keep it simple" },  // merged, not replaced
        "Other?": { notes: "kept" },                                            // untouched
      },
    },
  });
});

test("a header-less question is refused UP FRONT (the runtime requires 1-12), before anyone is asked", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const res = await h.ask("tu-nohdr", { questions: [{ question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] }, ctx);
  expect(res.behavior).toBe("deny");
  expect((res as { message: string }).message).toContain("header");
  expect(h.events).toEqual([]);
});

test("multiSelect defaults to false", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-q1", {
    questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes" }, { label: "No" }] }],
  }, ctx);
  const q = (h.events[0] as { questions: Record<string, unknown>[] }).questions[0]!;
  expect(q.multiSelect).toBe(false);
  expect(q.header).toBe("Go");
  expect(q.options).toEqual([{ label: "Yes" }, { label: "No" }]);
  h.questions.respond(SESSION, "tu-q1", { "Go?": "Yes" }, "phone");
  await pending;
});

// -------------------------------------------------------------------------------------------
// FAIL-CLOSED — never a silent allow with no answer (P8b-19)
// -------------------------------------------------------------------------------------------

test("an abort denies and emits the withdraw resolution", async () => {
  const h = bridge();
  const { ac, ctx } = signalOf();
  const pending = h.ask("tu-q1", INPUT, ctx);
  ac.abort();

  const res = await pending;
  expect(res.behavior).toBe("deny");
  expect((res as { message: string }).message).toContain("the turn was aborted");
  expect(h.events).toHaveLength(2);
  expect(h.events[1]).toEqual({
    type: "question_resolved", sessionId: SESSION, threadId: "main", callId: "tu-q1", answers: {}, by: "aborted",
  });
});

test("an already-aborted signal denies with no event", async () => {
  const ac = new AbortController();
  ac.abort();
  const h = bridge();
  const res = await h.ask("tu-q1", INPUT, { signal: ac.signal });
  expect(res.behavior).toBe("deny");
  expect(h.events).toEqual([]);
});

test("an empty answer map is a deny, never an allow with an unanswered question", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-q1", INPUT, ctx);
  h.questions.respond(SESSION, "tu-q1", {}, "phone");
  await expect(pending).resolves.toMatchObject({ behavior: "deny" });
});

test("an invalid input is refused with an actionable message and no event", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  for (const bad of [
    {},
    { questions: [] },
    { questions: [{ question: "x", options: [{ label: "only-one" }] }] },
    { questions: [{ question: "", options: [{ label: "a" }, { label: "b" }] }] },
    { questions: [{ question: "x", header: "way-too-long-header", options: [{ label: "a" }, { label: "b" }] }] },
  ]) {
    const res = await h.ask("tu-bad", bad, ctx);
    expect(res.behavior).toBe("deny");
    expect((res as { message: string }).message).toContain(ASK_USER_QUESTION_TOOL);
  }
  expect(h.events).toEqual([]);
});

test("an emit failure settles the waiter and denies", async () => {
  const questions = new QuestionBroker();
  const ask = askUserQuestionBridge({
    sessionId: SESSION, questions,
    emit: () => { throw new Error("disk full"); },
    log: silent, now: () => FIXED_NOW,
  });
  const res = await ask("tu-q1", INPUT, { signal: new AbortController().signal });
  expect(res.behavior).toBe("deny");
  // The broker entry is gone — nothing is parked.
  expect(questions.respond(SESSION, "tu-q1", { a: "b" }, "late")).toEqual({ ok: true, alreadyResolved: true });
});

test("a pending question survives 10s of fake time and is armed at ~24.8 days", async () => {
  const questions = new QuestionBroker();
  const seen: number[] = [];
  const realWait = questions.wait.bind(questions);
  questions.wait = ((sid: string, cid: string, ms: number) => { seen.push(ms); return realWait(sid, cid, ms); }) as typeof questions.wait;

  jest.useFakeTimers();
  const h = bridge({ questions });
  const { ctx } = signalOf();
  let settled = false;
  const pending = h.ask("tu-q1", INPUT, ctx).then((r) => { settled = true; return r; });

  expect(seen).toEqual([NO_PARK_TIMEOUT_MS]);
  jest.advanceTimersByTime(10_000);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(h.events).toHaveLength(1);

  h.questions.respond(SESSION, "tu-q1", { "Which database?": "SQLite" }, "phone");
  await expect(pending).resolves.toMatchObject({ behavior: "allow" });
});

// -------------------------------------------------------------------------------------------
// ROUTING — a sub-agent's question surfaces on the OWNING (parent) session.
// -------------------------------------------------------------------------------------------

test("with agentID set, the question still surfaces on the parent session's stream", async () => {
  const events: NewSessionEvent[] = [];
  const approvals = new ApprovalBroker();
  const questions = new QuestionBroker();
  const canUse: CanUseTool = canUseToolFor({
    sessionId: SESSION, mode: "dispatch", policy: "auto",
    approvals, questions, gate: new PermissionGate(),
    emit: (e) => { events.push(e); }, log: silent, now: () => FIXED_NOW,
  });

  const pending = canUse(ASK_USER_QUESTION_TOOL, INPUT, {
    signal: new AbortController().signal,
    toolUseID: "tu-child", requestId: "req-child",
    agentID: "winter-subagent-7",
  } as Parameters<CanUseTool>[2]);

  expect(events).toHaveLength(1);
  const ev = events[0] as Record<string, unknown>;
  expect(ev.type).toBe("question_asked");
  // The parent's id — never the agentID, which names no session and no event stream.
  expect(ev.sessionId).toBe(SESSION);
  expect(ev.callId).toBe("tu-child");
  expect(Object.values(ev)).not.toContain("winter-subagent-7");

  // …and it is answerable at the parent's sessionId, which is what `ask_user.respond` addresses.
  questions.respond(SESSION, "tu-child", { "Which database?": "Postgres" }, "phone");
  await expect(pending).resolves.toMatchObject({ behavior: "allow" });
});

test("a re-asked question supersedes the stale wait, and the withdrawal lands BEFORE the replacement", async () => {
  // Review m2 + M1's ordering rule. `QuestionBroker.wait` overwrites its Map entry, so without the
  // guard the first promise never settles and its ~24.8-day timer leaks; and a withdrawal emitted
  // from the stale invocation's continuation would arrive AFTER the replacement question and
  // dismiss the live card (clients resolve pending cards by `callId` alone).
  const h = bridge();
  const { ctx } = signalOf();
  const first = h.ask("tu-q1", INPUT, ctx);
  const second = h.ask("tu-q1", INPUT, ctx);

  expect(h.events.map((e) => [(e as { type: string }).type, (e as { by?: string }).by ?? null])).toEqual([
    ["question_asked", null],
    ["question_resolved", "superseded"],
    ["question_asked", null],
  ]);
  expect(new Set(h.events.map((e) => (e as { callId: string }).callId))).toEqual(new Set(["tu-q1"]));

  // The first promise SETTLES — denied, because nobody answered it — and emits nothing more.
  await expect(first).resolves.toMatchObject({ behavior: "deny" });
  expect(h.events).toHaveLength(3);

  h.questions.respond(SESSION, "tu-q1", { "Which database?": "SQLite" }, "phone");
  await expect(second).resolves.toMatchObject({ behavior: "allow" });
  expect(h.events).toHaveLength(4);
});

test("AskUserQuestion reaches a human under dont-ask — a deliberate descriptor divergence", async () => {
  // Winter's own descriptor says AskUserQuestion is "denied under `dontAsk`". Winter's `ask_user` is
  // READ_ONLY and therefore ALLOWED under `dont-ask` today, and the bridge routes the tool to the
  // question broker before any policy is consulted — so on this leg the human is still asked.
  // Recorded and pinned rather than silently inherited: `dont-ask` means "don't ask me to approve
  // actions", not "don't ask me questions".
  const events: NewSessionEvent[] = [];
  const questions = new QuestionBroker();
  const canUse: CanUseTool = canUseToolFor({
    sessionId: SESSION, mode: "code", policy: "dont-ask",
    approvals: new ApprovalBroker(), questions, gate: new PermissionGate(),
    emit: (e) => { events.push(e); }, log: silent, now: () => FIXED_NOW,
  });
  const p = canUse(ASK_USER_QUESTION_TOOL, INPUT, {
    signal: new AbortController().signal, toolUseID: "tu-da", requestId: "r",
  } as Parameters<CanUseTool>[2]);
  expect(events).toHaveLength(1);
  expect((events[0] as { type: string }).type).toBe("question_asked");
  questions.respond(SESSION, "tu-da", { "Which database?": "Postgres" }, "phone");
  await expect(p).resolves.toMatchObject({ behavior: "allow" });
});

test("the hard-coded §5.6 schema accepts the documented shape", () => {
  expect(AskUserQuestionInput.safeParse({
    questions: [
      { question: "a?", header: "A", options: [{ label: "1" }, { label: "2" }], multiSelect: true },
      { question: "b?", header: "B", options: [{ label: "1" }, { label: "2" }, { label: "3" }, { label: "4" }] },
    ],
    answers: {},
    annotations: {},
    metadata: { source: "x" },
  }).success).toBe(true);
  // 1..4 questions, 2..4 options — the descriptor's own bounds
  expect(AskUserQuestionInput.safeParse({ questions: new Array(5).fill({ question: "q", header: "H", options: [{ label: "a" }, { label: "b" }] }) }).success).toBe(false);
  expect(AskUserQuestionInput.safeParse({ questions: [{ question: "q", header: "H", options: new Array(5).fill({ label: "a" }) }] }).success).toBe(false);
});

// -------------------------------------------------------------------------------------------
// FREE-TEXT QUESTIONS (2026-10-20): no options = typed answer alone; `placeholder` = the box's hint.
// -------------------------------------------------------------------------------------------

test("a question with no options is asked with `options: []` on the wire, and its typed answer allows", async () => {
  for (const options of [undefined, []] as const) {
    const h = bridge();
    const { ctx } = signalOf();
    const input = { questions: [{ question: "Branch name?", header: "Branch", ...(options ? { options } : {}) }] };
    const pending = h.ask("tu-free", input, ctx);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toEqual({
      type: "question_asked", sessionId: SESSION, threadId: "main", callId: "tu-free",
      // The key is ALWAYS present: a shipped Swift client decodes `options` as a required array.
      questions: [{ question: "Branch name?", header: "Branch", options: [], multiSelect: false }],
    });
    expect(QuestionAskedEvent.parse({ ...h.events[0], seq: 1, ts: FIXED_NOW })).toBeTruthy();

    h.questions.respond(SESSION, "tu-free", { "Branch name?": "feature/login-retry" }, "app");
    await expect(pending).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Branch name?": "feature/login-retry" } },
      decisionClassification: "user_temporary",
    });
  }
});

test("a placeholder rides the question trimmed; a blank one is dropped; a long one is clamped, never refused", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const long = "e.g. ".concat("x".repeat(200));
  const emoji = "😀".repeat(60); // 120 UTF-16 units: the clamp must count what the wire schema counts
  const pending = h.ask("tu-hint", {
    questions: [
      { question: "Name?", header: "Name", placeholder: "  e.g. Winter  " },
      { question: "Which?", header: "Which", placeholder: "   ", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
      { question: "Long?", header: "Long", placeholder: long },
      { question: "Emoji?", header: "Emoji", placeholder: emoji },
    ],
  }, ctx);

  expect(h.events).toHaveLength(1);
  const asked = QuestionAskedEvent.parse({ ...h.events[0], seq: 1, ts: FIXED_NOW });
  expect(asked.questions[0]!.placeholder).toBe("e.g. Winter");
  expect("placeholder" in asked.questions[1]!).toBe(false);
  expect(asked.questions[1]!.options.map((o) => o.label)).toEqual(["A", "B"]);
  const clamped = asked.questions[2]!.placeholder!;
  expect(clamped.length).toBeLessThanOrEqual(QUESTION_PLACEHOLDER_MAX);
  expect(clamped.endsWith("…")).toBe(true);
  expect(clamped.startsWith("e.g. xxx")).toBe(true);
  const clampedEmoji = asked.questions[3]!.placeholder!;
  expect(clampedEmoji.length).toBeLessThanOrEqual(QUESTION_PLACEHOLDER_MAX);
  expect(clampedEmoji).toBe(`${"😀".repeat(39)}…`); // never half a surrogate pair

  h.questions.respond(SESSION, "tu-hint", { "Name?": "x", "Which?": "A", "Long?": "y", "Emoji?": "z" }, "app");
  await pending;
});

test("clampPlaceholder: short stays, blank drops, exactly-max stays whole", () => {
  expect(clampPlaceholder(undefined)).toBeUndefined();
  expect(clampPlaceholder("  ")).toBeUndefined();
  expect(clampPlaceholder(" hint ")).toBe("hint");
  expect(clampPlaceholder("x".repeat(QUESTION_PLACEHOLDER_MAX))).toBe("x".repeat(QUESTION_PLACEHOLDER_MAX));
  expect(clampPlaceholder("x".repeat(QUESTION_PLACEHOLDER_MAX + 1))).toBe(`${"x".repeat(QUESTION_PLACEHOLDER_MAX - 1)}…`);
});

test("the schema takes 0 or 2-4 options and still refuses exactly one", () => {
  const q = (extra: Record<string, unknown>) => AskUserQuestionInput.safeParse({ questions: [{ question: "q", header: "H", ...extra }] }).success;
  expect(q({})).toBe(true);
  expect(q({ options: null })).toBe(true); // null is a free-text question too (SDK #47)
  expect(AskUserQuestionInput.safeParse({ questions: [{ question: "q" }] }).success).toBe(false); // header required
  expect(q({ header: "x".repeat(13) })).toBe(false);
  expect(q({ options: [] })).toBe(true);
  expect(q({ options: [{ label: "a" }] })).toBe(false);
  expect(q({ options: [{ label: "a" }, { label: "b" }] })).toBe(true);
  expect(q({ options: new Array(5).fill({ label: "a" }) })).toBe(false);
  expect(q({ placeholder: "hint" })).toBe(true);
});

test("a free-text question is never multiple-choice, and `options: null` asks as `[]` (SDK #47)", async () => {
  const h = bridge();
  const { ctx } = signalOf();
  const pending = h.ask("tu-null", { questions: [{ question: "Name?", header: "Name", options: null, multiSelect: true }] }, ctx);
  const asked = QuestionAskedEvent.parse({ ...h.events[0], seq: 1, ts: FIXED_NOW });
  expect(asked.questions[0]!.options).toEqual([]);
  expect(asked.questions[0]!.multiSelect).toBe(false);
  h.questions.respond(SESSION, "tu-null", { "Name?": "Winter" }, "app");
  await pending;
});
