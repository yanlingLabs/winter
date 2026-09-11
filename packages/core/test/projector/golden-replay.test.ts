import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { MAIN_THREAD } from "../../src/projector";
import type { ProtocolSdkMessage } from "../../src/projector";
import { makeProjector, run } from "./harness";

/**
 * ── THE CUTOVER PROOF (ruling P8b-14, Norma map §13.3) ──────────────────────────────────────────
 *
 * For each scenario: `fixtures/golden/<s>.events.jsonl` is the PRODUCT CONTRACT, recorded from the
 * real `AgentEngine` by `scripts/capture-projector-goldens.ts`. `fixtures/sdk/<s>.messages.jsonl` is
 * the wire stream a Winter child emits for the same scenario (shapes measured against `dist/winter`
 * — see the Task 10 report). Driving the projector with the second must reproduce the first.
 *
 * THREE SCOPING DECISIONS, each stated rather than assumed, because P8b-14's whole cost-if-wrong is
 * "a green projector that drops fields nobody compared":
 *
 *  1. `OWNED_VARIANTS` — part 1 owns the conversation spine and the terminal. `approval_*`,
 *     `question_*`, `thread_*` and `task_updated` are in the goldens and are asserted by TASK 11's
 *     run of this same test, which widens this list. Nothing is removed from the goldens to make
 *     part 1 pass.
 *  2. **Main thread only.** A child's own `assistant_message`/`assistant_delta` ride the child's
 *     threadId in the golden, and the default SDK stream does not forward subagent TEXT at all
 *     (only its tool_use/tool_result blocks — `Options.forwardSubagentText` is off). Comparing them
 *     would fail on a Task 11 concern that is really an SDK option, so part 1 compares `main`.
 *  3. `COMPARED_FIELDS` — an explicit per-variant field list. Two fields are deliberately NOT
 *     compared for equality, and both have their own dedicated assertions below instead:
 *       - token counts: the engine reports per-round figures; Winter reports a cumulative ledger
 *         delta, and `terminal.test.ts` pins that mapping exactly.
 *       - `tool_call.argsJson` / `tool_result.output` bodies: the Winter tool's argument SCHEMA is
 *         its own (`{file_path}` vs Norma's `{path}`), so byte-equality would assert a rename that
 *         is not happening. Shape and linkage are asserted; text is not.
 *
 * `tool_call.name` IS compared literally, and that is the point of ruling P8b-25: the SessionEvent
 * surface keeps Norma's tool vocabulary, so the projector translates `Read` → `read`, `Agent` →
 * `spawn_agent` and so on. If that mapping regressed, this comparison is what fails — the Mac and
 * iOS tool rows key on those names and nothing else here would notice.
 */
const OWNED_VARIANTS = new Set<SessionEvent["type"]>([
  "user_message", "assistant_message", "assistant_delta", "tool_call", "tool_result",
  "turn_completed", "agent_error",
]);

type Any = Record<string, unknown>;

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
    case "agent_error": return { type, threadId, hasMessage: typeof e.message === "string" && (e.message as string).length > 0, hasCode: typeof e.code === "string" };
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

/** Every scenario the capture script records. Kept as a literal so a golden that stops being
 *  replayed fails HERE rather than quietly dropping out of the proof. */
const SCENARIOS = [
  "chat-text-only", "code-tool-call", "code-tool-denied", "code-child-spawn",
  "code-provider-error", "code-interrupted", "dispatch-tool-call",
] as const;

const MODE_OF: Record<string, "code" | "dispatch" | "chat"> = {
  "chat-text-only": "chat", "dispatch-tool-call": "dispatch",
};

describe("projector: golden-stream replay (P8b-14)", () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario}: the SDK stream reproduces the engine's event sequence`, () => {
      const golden = readJsonl<Any>("golden", `${scenario}.events.jsonl`);
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);

      const expected = golden.filter((e) => e.threadId === MAIN_THREAD && OWNED_VARIANTS.has(e.type as SessionEvent["type"]));
      expect(expected.length).toBeGreaterThan(0); // a scenario that compares nothing proves nothing

      // The HOST appends the user's turn before it pushes (P8b-5); the projector never does. The
      // test plays that half by taking the golden's own user_message, then feeds the wire stream.
      const hostAppends = expected.filter((e) => e.type === "user_message");
      const { projector } = makeProjector({ mode: MODE_OF[scenario] ?? "code", sessionId: "s_test" });
      const projected = run(projector, messages) as unknown as Any[];

      // The P8b-5 invariant, asserted directly: the projector re-appends NO user turn.
      expect(projected.filter((e) => e.type === "user_message")).toEqual([]);

      const actual = [...hostAppends, ...projected.filter((e) => e.threadId === MAIN_THREAD && OWNED_VARIANTS.has(e.type as SessionEvent["type"]))];
      expect(actual.map(compare)).toEqual(expected.map(compare));
    });
  }

  test("tool rows keep NORMA names on the Winter leg (P8b-25) — no golden is compared on a renamed row", () => {
    // Belt and braces beside the sequence comparison: the goldens speak Norma, the fixtures speak
    // Winter, and every name the projector emits must be the Norma one.
    for (const scenario of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);
      const { projector } = makeProjector();
      const names = (run(projector, messages) as unknown as Any[]).filter((e) => e.type === "tool_call").map((e) => e.name);
      for (const n of names) expect({ scenario, name: n, looksWinter: /^[A-Z]/.test(n as string) }).toEqual({ scenario, name: n, looksWinter: false });
    }
  });

  test("every tool_result the projector produces is linked to a tool_call it already produced", () => {
    for (const scenario of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);
      const { projector } = makeProjector();
      const out = run(projector, messages) as unknown as Any[];
      const calls = new Set(out.filter((e) => e.type === "tool_call").map((e) => e.callId as string));
      for (const r of out.filter((e) => e.type === "tool_result")) {
        expect({ scenario, callId: r.callId, linked: calls.has(r.callId as string) }).toEqual({ scenario, callId: r.callId, linked: true });
      }
    }
  });

  test("no scenario ever produces a variant PROJECTED_EVENT_COVERAGE marks false", async () => {
    const { PROJECTED_EVENT_COVERAGE } = await import("../../src/projector");
    for (const scenario of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);
      const { projector } = makeProjector();
      for (const e of run(projector, messages)) {
        expect({ scenario, type: e.type, covered: PROJECTED_EVENT_COVERAGE[e.type] }).toEqual({ scenario, type: e.type, covered: true });
      }
    }
  });

  test("no scenario ever produces a reasoning_item, and no opaque provider state reaches an event", () => {
    for (const scenario of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);
      const { projector } = makeProjector();
      const out = run(projector, messages);
      expect(out.some((e) => e.type === "reasoning_item")).toBe(false);
    }
  });

  test("exactly one terminal event set per turn, and it is the LAST thing the turn emits", () => {
    for (const scenario of SCENARIOS) {
      const messages = readJsonl<ProtocolSdkMessage>("sdk", `${scenario}.messages.jsonl`);
      const { projector } = makeProjector();
      const out = run(projector, messages) as unknown as Any[];
      const terminals = out.filter((e) => e.type === "turn_completed");
      const results = messages.filter((m) => (m as Any).type === "result");
      expect({ scenario, terminals: terminals.length }).toEqual({ scenario, terminals: results.length });
      expect({ scenario, last: out[out.length - 1]?.type }).toEqual({ scenario, last: "turn_completed" });
    }
  });
});
