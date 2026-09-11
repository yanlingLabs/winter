import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionEvent } from "@norma/protocol";
import { MAIN_THREAD, PROJECTED_EVENT_COVERAGE } from "../../src/projector";
import type { ProtocolSdkMessage } from "../../src/projector";
import { accept, beginTurn, makeProjector, run } from "./harness";

/**
 * ── THE CUTOVER PROOF (ruling P8b-14, Norma map §13.3) ──────────────────────────────────────────
 *
 * For each scenario: `fixtures/golden/<s>.events.jsonl` is the PRODUCT CONTRACT, recorded from the
 * real `AgentEngine` by `scripts/capture-projector-goldens.ts`. `fixtures/sdk/<s>.messages.jsonl` is
 * the wire stream a Winter child emits for the same scenario (shapes measured against `dist/winter`
 * — see the task report). Driving the projector with the second must reproduce the first.
 *
 * Task 11 widens this from "the variants part 1 owned" to **every variant in every golden**, and
 * the widening forces the question part 1 could defer: what does "match in full" mean for an event
 * the projector is not the producer of? Three mechanisms answer it, and between them NOTHING in any
 * golden is unaccounted for — which is the whole of P8b-14's "a green projector that drops fields
 * nobody compared".
 *
 *  1. `EXTERNAL_PRODUCERS` names the producer of every golden variant the projector does not make.
 *     `coversEveryGoldenVariant` asserts the two sets cover every type present in every golden, so
 *     a variant that quietly loses its producer when the engine retires fails HERE.
 *  2. The ordered comparison walks the golden and the projector output TOGETHER: an external event
 *     is taken from the golden (it is its producer's, not ours) and a projector event is compared
 *     field by field. Both lists must exhaust together — so a projector event in the wrong PLACE
 *     relative to the bridge's approval pair still fails, which is the ordering risk that matters.
 *  3. The comparison runs PER THREAD. The main thread is compared in full; a child's thread is
 *     compared in full against its own golden subsequence.
 *
 * ── TWO REAL DIVERGENCES THE COMPARISON MAKES VISIBLE RATHER THAN HIDING ────────────────────────
 *
 *  - **The engine emits the parent's `tool_call` for a spawn AFTER the child has finished** (its
 *    spawn bridge runs children concurrently before the per-call loop emits the call), while the
 *    Winter wire necessarily delivers the spawning `tool_use` BEFORE any child frame. The two
 *    orders cannot both hold, so a single flat comparison of `code-child-spawn` is impossible; the
 *    per-thread comparison is the strongest true statement, and this note is the honest record of
 *    the difference.
 *  - **A child's own text is absent from the default wire.** `Options.forwardSubagentText`
 *    (`winter-agent-sdk/dist/options.d.ts:99`) is off unless the host sets it, so only the child's
 *    tool_use/tool_result blocks are forwarded. Both shapes are fixtures:
 *    `code-child-spawn` (off — the child's `assistant_message` genuinely does not arrive) and
 *    `code-child-spawn-forwarded` (on — it does, and the golden's child subsequence matches in
 *    full). Turning the option on is a Task 16 decision, recorded in the task report.
 */

/** Variants the projector produces, derived from the coverage map so the two can never drift. */
const PROJECTOR_VARIANTS = new Set(
  (Object.entries(PROJECTED_EVENT_COVERAGE) as Array<[SessionEvent["type"], boolean]>)
    .filter(([, produced]) => produced)
    .map(([type]) => type),
);

/**
 * Every other variant a golden contains, with its producer named. `user_message` is the host's push
 * path even though the projector CAN produce one (an inbound delivery is a different fact from a
 * pushed turn — see dedupe.ts), so it is listed here: in these scenarios the host is its producer.
 */
const EXTERNAL_PRODUCERS: Partial<Record<SessionEvent["type"], string>> = {
  session_created: "sessions/store.ts's createSession",
  harness_attached: "sessions/hub.ts's attach",
  user_message: "the host's push path (P8b-5) — ipc/server.ts's session.send / the Winter prompt queue",
  approval_requested: "runtime-sdk/approval-bridge.ts (Task 8) — emitted from inside canUseTool",
  approval_resolved: "runtime-sdk/approval-bridge.ts (Task 8)",
  question_asked: "runtime-sdk/question-bridge.ts (Task 8)",
  question_resolved: "runtime-sdk/question-bridge.ts (Task 8)",
};

/**
 * Whose event is this, for the ordered walk?
 *
 * `user_message` is the subtle one: the coverage map marks it `true` because the projector CAN
 * produce one (an inbound agent-message delivery), but in these scenarios the HOST produced it, so
 * for the walk it is external. Reading ownership off the coverage map alone would consume a
 * projector slot for it and shift every later comparison by one.
 */
const isExternalOnMain = (type: string): boolean =>
  EXTERNAL_PRODUCERS[type as SessionEvent["type"]] !== undefined || !PROJECTOR_VARIANTS.has(type as SessionEvent["type"]);

/** On a CHILD thread the turn boundaries are the driver's too — they are not on the wire, and no
 *  per-child usage exists to put in a `turn_completed` (children.ts's own note). */
const isExternalOnChild = (type: string): boolean =>
  type === "turn_started" || type === "turn_completed" || isExternalOnMain(type);

type Any = Record<string, unknown>;

/**
 * The compared field projection, per variant. Two things are deliberately NOT compared, each with
 * its own dedicated assertion elsewhere:
 *   - token counts — the engine reports per-round figures, Winter a cumulative ledger delta;
 *     `terminal.test.ts` pins that mapping exactly.
 *   - `tool_call.argsJson` / `tool_result.output` BODIES — the Winter tool's argument schema is its
 *     own (`{file_path}` vs Norma's `{path}`), so byte-equality would assert a rename that is not
 *     happening. Shape and `callId` linkage are asserted instead.
 * `tool_call.name` and `agent_error.code` ARE compared literally: the first is ruling P8b-25 (the
 * Mac and iOS tool rows key on Norma's names), the second is digest item 20's one-distinct-code-
 * per-class, which `routines/runner.ts:81` consumes.
 */
function compare(e: Any): Any {
  const type = e.type as string;
  const threadId = e.threadId as string;
  switch (type) {
    case "user_message": return { type, threadId, text: e.text };
    case "assistant_message": return { type, threadId, text: e.text };
    case "assistant_delta": return { type, threadId, delta: e.delta };
    case "tool_call": return { type, threadId, name: e.name, argsAreAnObject: isJsonObject(e.argsJson) };
    case "tool_result": return { type, threadId, isError: e.isError === true };
    case "turn_completed": return { type, threadId, stopReason: e.stopReason };
    case "agent_error": return { type, threadId, code: e.code, hasMessage: typeof e.message === "string" && (e.message as string).length > 0 };
    case "thread_started": return { type, threadId, parentThreadId: e.parentThreadId, agentType: e.agentType, prompt: e.prompt, description: e.description };
    case "thread_completed": return { type, threadId, stopReason: e.stopReason };
    default: return { type, threadId };
  }
}

function isJsonObject(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try { const v = JSON.parse(raw); return typeof v === "object" && v !== null && !Array.isArray(v); }
  catch { return false; }
}

const FIXTURES = join(import.meta.dir, "fixtures");
const readJsonl = <T>(dir: string, file: string): T[] =>
  readFileSync(join(FIXTURES, dir, file), "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as T);

interface Scenario {
  name: string;
  golden: string;
  mode: "code" | "dispatch" | "chat";
  /** `Options.forwardSubagentText` — when false a child's own text never reaches the host. */
  forwardsSubagentText?: boolean;
  /**
   * The message indices a user turn is pushed BEFORE — the host's real push points, so a
   * multi-turn scenario's second `turn_started` lands where the driver would actually put it
   * instead of being bunched at the top. Default: one push before the first message.
   */
  pushAt?: readonly number[];
  /**
   * Is the wire fixture MEASURED against the real `dist/winter` child, or AUTHORED from the pinned
   * shapes? (m4, review r2.) Never assert an authored shape as fact: `code-child-spawn-forwarded`
   * and every `stream_event` line are authored, because no recording exists with
   * `forwardSubagentText: true` and no `winter-test/*` double streams. Both are targets of the
   * deferred `describeWithWinterBinary`-gated real-child test.
   */
  provenance: "measured" | "authored" | "measured-shapes";
  /** Why, when it is not fully measured — printed by the disclosure test. */
  provenanceNote?: string;
  /**
   * ── CROSS-LEG DIVERGENCES, DISCLOSED (M4, review r1) ────────────────────────────────────────
   *
   * Main-thread events the WINTER leg produces that the engine golden does not contain. A fixture
   * must equal its RECORDING, not its golden — shaping a fixture to the golden converts a real
   * behavioural difference between the two legs into a green test, which is the "green for the
   * wrong reason" class this whole proof exists to avoid. So the extra events stay, and each one is
   * declared here with the reason. The test removes exactly these (in order) before the ordered
   * walk and fails if any declared addition is missing or any undeclared one appears.
   */
  documentedAdditions?: Array<{
    type: string;
    note: string;
    /** Which occurrence is the addition. `last` matters where the golden already contains an event
     *  of the same type — a second turn's `turn_completed` is the trailing one, not the first. */
    occurrence?: "first" | "last";
  }>;
}

/** Every scenario replayed. A literal list so a golden that stops being replayed fails HERE rather
 *  than quietly dropping out of the proof. */
const SCENARIOS: readonly Scenario[] = [
  {
    name: "chat-text-only", golden: "chat-text-only", mode: "chat", provenance: "measured-shapes",
    provenanceNote: "every frame shape is measured; the `stream_event` lines are AUTHORED from frames.ts:361-369 — no `winter-test/*` double streams, even with includePartialMessages:true",
  },
  {
    name: "code-tool-call", golden: "code-tool-call", mode: "code", provenance: "measured-shapes",
    provenanceNote: "shapes measured; `stream_event` authored (see chat-text-only)",
  },
  {
    name: "code-tool-denied", golden: "code-tool-denied", mode: "code", pushAt: [0, 6],
    provenance: "measured",
    provenanceNote: "byte-for-byte the recorded winter-test/tooluse stream, retargeted to Write",
    documentedAdditions: [
      { type: "assistant_message", note: "THE WINTER CHILD KEEPS TALKING AFTER A DENIAL. Norma's engine ends the turn on a deny (its tool_result says \"Stop here and wait\"), so the golden's last events are tool_result(isError) -> turn_completed; the recorded child answered `tool round done` and only then terminated. A real cross-leg behavioural difference, surfaced here rather than fixture-shaped away. Whether it survives is Task 9's permission-message question." },
      { type: "agent_error", note: "the recording's SECOND pushed envelope terminated `error_during_execution` (the scripted double ran out of turns). Its class is `tool_failure`." },
      { type: "turn_started", occurrence: "last", note: "the SECOND push's own turn_started — `beginTurn` produces it (never the driver), and the one-turn golden has one." },
      { type: "turn_completed", occurrence: "last", note: "that second envelope's own terminal — two pushes, two terminals (the M1 contract), where the one-turn golden has one. The LAST one is the addition: turn 1's own `end_turn` terminal is the golden's." },
    ],
  },
  {
    name: "code-child-spawn", golden: "code-child-spawn", mode: "code", provenance: "measured-shapes",
    provenanceNote: "shapes measured; `stream_event` authored (see chat-text-only)",
  },
  {
    name: "code-child-spawn-forwarded", golden: "code-child-spawn", mode: "code", forwardsSubagentText: true,
    provenance: "authored",
    provenanceNote: "AUTHORED, NOT MEASURED (m4, review r2): the real-child measurement ran with default options, so NO recording exists with `forwardSubagentText: true`. The child's forwarded text here is authored from the §4.3 shape. Nothing in this lane may claim as fact that a child's own text does arrive with the option on — only that IF it arrives in this shape, the projector folds it onto the child's threadId. A target of the deferred describeWithWinterBinary-gated test.",
  },
  {
    name: "code-provider-error", golden: "code-provider-error", mode: "code", provenance: "measured-shapes",
    provenanceNote: "the terminal is §4.8's measured api-failure shape (success + is_error + terminal_reason + api_error_status)",
  },
  {
    name: "code-interrupted", golden: "code-interrupted", mode: "code", provenance: "measured-shapes",
    provenanceNote: "the interrupted result shape is read out of dist/winter itself, not guessed",
  },
  {
    name: "dispatch-tool-call", golden: "dispatch-tool-call", mode: "dispatch", provenance: "measured-shapes",
    provenanceNote: "shapes measured; `stream_event` authored (see chat-text-only)",
  },
];

/** Thread ids differ by construction (the engine's child id vs the spawning tool_use id), so both
 *  sides are canonicalized to `main` / `child-N` in first-appearance order before comparison. */
function canonicalThreads(events: Any[]): Any[] {
  const map = new Map<string, string>([[MAIN_THREAD, MAIN_THREAD]]);
  return events.map((e) => {
    const raw = e.threadId;
    // session_created / harness_attached are SESSION-scoped and carry no threadId at all; feeding
    // `undefined` into the map would number it as the first child and shift every real child by one.
    if (typeof raw !== "string") return e;
    if (!map.has(raw)) map.set(raw, `child-${map.size}`);
    return { ...e, threadId: map.get(raw)! };
  });
}

/**
 * Walk the golden and the projector output together for one thread. An external event is taken from
 * the golden (its producer is named in `EXTERNAL_PRODUCERS`); a projector event is compared. Both
 * lists must exhaust together.
 */
function merged(goldenThread: Any[], projectedThread: Any[], isExternal: (e: Any) => boolean): { expected: Any[]; actual: Any[] } {
  const expected: Any[] = [];
  const actual: Any[] = [];
  let i = 0;
  for (const g of goldenThread) {
    expected.push(compare(g));
    if (isExternal(g)) { actual.push(compare(g)); continue; }
    const p = projectedThread[i++];
    actual.push(p === undefined ? { type: `<missing: expected ${g.type}>`, threadId: g.threadId } : compare(p));
  }
  for (const extra of projectedThread.slice(i)) actual.push(compare(extra));
  return { expected, actual };
}

describe("projector: golden-stream replay, every variant (P8b-14)", () => {
  test("every variant in every golden is either produced by the projector or has a NAMED producer", () => {
    for (const s of SCENARIOS) {
      for (const e of readJsonl<Any>("golden", `${s.golden}.events.jsonl`)) {
        const type = e.type as SessionEvent["type"];
        const accounted = PROJECTOR_VARIANTS.has(type) || EXTERNAL_PRODUCERS[type] !== undefined;
        expect({ golden: s.golden, type, accounted }).toEqual({ golden: s.golden, type, accounted: true });
      }
    }
  });

  for (const s of SCENARIOS) {
    test(`${s.name}: the MAIN thread reproduces the engine's sequence in full`, () => {
      const golden = canonicalThreads(readJsonl<Any>("golden", `${s.golden}.events.jsonl`));
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const { projector } = makeProjector({ mode: s.mode, sessionId: "s_test" });
      const projected = canonicalThreads(run(projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[]);

      // The P8b-5 invariant, asserted directly: the projector re-appends NO user turn.
      expect(projected.filter((e) => e.type === "user_message")).toEqual([]);

      const goldenMain = golden.filter((e) => e.threadId === MAIN_THREAD || e.threadId === undefined);
      let projectedMain = projected.filter((e) => e.threadId === MAIN_THREAD);

      // Remove the DECLARED cross-leg additions (M4) before the ordered walk, and fail if one is
      // missing — an addition that quietly disappears is the same defect as an undeclared one.
      for (const addition of s.documentedAdditions ?? []) {
        const matches = projectedMain.map((e, i) => (e.type === addition.type ? i : -1)).filter((i) => i >= 0);
        const at = addition.occurrence === "last" ? matches[matches.length - 1] : matches[0];
        expect({ scenario: s.name, addition: addition.type, present: at !== undefined }).toEqual({ scenario: s.name, addition: addition.type, present: true });
        projectedMain = [...projectedMain.slice(0, at!), ...projectedMain.slice(at! + 1)];
      }

      const { expected, actual } = merged(goldenMain, projectedMain, (e) => isExternalOnMain(e.type as string));
      expect(actual).toEqual(expected);
    });

    test(`${s.name}: every CHILD thread reproduces its own golden subsequence in full`, () => {
      const golden = canonicalThreads(readJsonl<Any>("golden", `${s.golden}.events.jsonl`));
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const { projector } = makeProjector({ mode: s.mode, sessionId: "s_test" });
      const projected = canonicalThreads(run(projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[]);

      const childIds = [...new Set(golden.map((e) => e.threadId as string))].filter((t) => t !== MAIN_THREAD && t !== undefined);
      for (const child of childIds) {
        const goldenChild = golden.filter((e) => e.threadId === child)
          // A child's own text is on the wire only with forwardSubagentText on.
          .filter((e) => s.forwardsSubagentText === true || (e.type !== "assistant_message" && e.type !== "assistant_delta"));
        const projectedChild = projected.filter((e) => e.threadId === child);
        const { expected, actual } = merged(goldenChild, projectedChild, (e) => isExternalOnChild(e.type as string));
        expect({ child, events: actual }).toEqual({ child, events: expected });
      }
    });
  }

  test("tool rows keep NORMA names on the Winter leg (P8b-25)", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const names = (run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[]).filter((e) => e.type === "tool_call").map((e) => e.name);
      for (const n of names) expect({ scenario: s.name, name: n, looksWinter: /^[A-Z]/.test(n as string) }).toEqual({ scenario: s.name, name: n, looksWinter: false });
    }
  });

  test("every tool_result is linked to a tool_call the projector already produced", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const out = run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[];
      const calls = new Set(out.filter((e) => e.type === "tool_call").map((e) => e.callId as string));
      for (const r of out.filter((e) => e.type === "tool_result")) {
        expect({ scenario: s.name, callId: r.callId, linked: calls.has(r.callId as string) }).toEqual({ scenario: s.name, callId: r.callId, linked: true });
      }
    }
  });

  test("every thread_completed closes a thread_started the projector already produced", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const out = run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[];
      const started = new Set(out.filter((e) => e.type === "thread_started").map((e) => e.threadId as string));
      for (const c of out.filter((e) => e.type === "thread_completed")) {
        expect({ scenario: s.name, threadId: c.threadId, opened: started.has(c.threadId as string) }).toEqual({ scenario: s.name, threadId: c.threadId, opened: true });
      }
    }
  });

  test("no scenario produces a variant PROJECTED_EVENT_COVERAGE marks false", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      for (const e of run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] })) {
        expect({ scenario: s.name, type: e.type, covered: PROJECTED_EVENT_COVERAGE[e.type] }).toEqual({ scenario: s.name, type: e.type, covered: true });
      }
    }
  });

  test("AUTHORED fixtures are declared as such — an authored shape is never asserted as fact (m4)", () => {
    // The report applied this discipline to `stream_event` and skipped it for the forwarded-child
    // fixture, which is an inconsistency in disclosure rather than craft. Every scenario now carries
    // its provenance, and anything not fully measured says why.
    for (const s of SCENARIOS) {
      expect({ scenario: s.name, declared: s.provenance !== undefined }).toEqual({ scenario: s.name, declared: true });
      if (s.provenance !== "measured") {
        expect({ scenario: s.name, explained: (s.provenanceNote ?? "").length > 0 }).toEqual({ scenario: s.name, explained: true });
      }
    }
    const forwarded = SCENARIOS.find((s) => s.name === "code-child-spawn-forwarded")!;
    expect(forwarded.provenance).toBe("authored");
  });

  test("`already-committed` WARNS and names the cause — silence on the resume path was the defect (n5)", () => {
    // M2's whole point: a resume that forgot to bump `generation` replays into committed marks and
    // projects nothing. A future refactor must not be able to put this back to debug with every
    // test green.
    const messages = readJsonl<ProtocolSdkMessage>("sdk", "code-tool-call.messages.jsonl");
    const first = makeProjector();
    run(first.projector, messages, { pushAt: [0] });
    const second = makeProjector({ checkpoint: first.checkpoints });
    run(second.projector, messages, { pushAt: [0] });
    expect(second.warnings.join(" ")).toContain("did not bump");
  });

  test("task_updated parses against the protocol schema too — the one produced variant no golden covers (n6)", () => {
    const { projector } = makeProjector();
    const frames = [
      { type: "system", subtype: "task_started", task_id: "t1", description: "write the report", uuid: "u", session_id: "be-1" },
      { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "failed", error: "the tool exited 1" }, uuid: "u", session_id: "be-1" },
      { type: "system", subtype: "task_notification", task_id: "t1", status: "stopped", summary: "cancelled", output_file: "/tmp/x", uuid: "u", session_id: "be-1" },
    ];
    const produced = frames.flatMap((f) => accept(projector, f as never));
    expect(produced.map((e) => e.type)).toEqual(["task_updated", "task_updated"]);
    for (const e of produced) {
      const parsed = SessionEvent.safeParse(e);
      expect({ type: e.type, ok: parsed.success, issues: parsed.success ? [] : parsed.error.issues.map((i) => i.path.join(".")) })
        .toEqual({ type: e.type, ok: true, issues: [] });
    }
  });

  test("every event the projector produces PARSES against the protocol schema (n14)", () => {
    // The cheapest possible insurance against a field mapping that type-checks and then fails zod
    // on its way to the phone — which would kill the connection rather than drop one event.
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const { projector } = makeProjector({ mode: s.mode });
      const events = run(projector, messages, { pushAt: s.pushAt ?? [0] });
      for (const e of events) {
        const parsed = SessionEvent.safeParse(e);
        expect({ scenario: s.name, type: e.type, ok: parsed.success, issues: parsed.success ? [] : parsed.error.issues.map((i) => i.path.join(".")) })
          .toEqual({ scenario: s.name, type: e.type, ok: true, issues: [] });
      }
    }
  });

  test("no scenario ever produces a reasoning_item", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      expect(run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] }).some((e) => e.type === "reasoning_item")).toBe(false);
    }
  });

  test("exactly one terminal set per turn, and the turn's last main-thread event is its terminal", () => {
    for (const s of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${s.name}.messages.jsonl`);
      const out = run(makeProjector().projector, messages, { pushAt: s.pushAt ?? [0] }) as unknown as Any[];
      // One terminal per BEGUN turn (M1). The wire's `result` count and the push count agree on a
      // well-behaved stream, which is the invariant worth asserting.
      const terminals = out.filter((e) => e.type === "turn_completed");
      const results = messages.filter((m) => (m as Any).type === "result");
      expect({ scenario: s.name, terminals: terminals.length, pushes: (s.pushAt ?? [0]).length })
        .toEqual({ scenario: s.name, terminals: results.length, pushes: results.length });
      const main = out.filter((e) => e.threadId === MAIN_THREAD);
      expect({ scenario: s.name, last: main[main.length - 1]?.type }).toEqual({ scenario: s.name, last: "turn_completed" });
    }
  });
});
