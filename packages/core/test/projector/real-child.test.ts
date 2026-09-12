import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@yanlinglabs/winter-agent-sdk";
import { SessionEvent } from "@winter/protocol";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { MAIN_THREAD, createProjector } from "../../src/projector";
import type { ProjectedBatch, ProtocolSdkMessage } from "../../src/projector";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { FakeCheckpoints } from "./harness";

/**
 * ── THE REAL-CHILD PROOF (deferred from Task 10/11, landed at the integration resume) ───────────
 *
 * Everything else about the projector is proved against RECORDED streams. This file is the one that
 * proves the recordings themselves: it spawns the actual `winter` binary, drives it exactly as the
 * Task 16 driver will (a `HostPromptQueue` prompt, `beginTurn` per push, `includePartialMessages`),
 * and asserts that the committed fixtures still describe what a live child emits.
 *
 * Four claims, each of which the unit tests take on trust:
 *   (a) the committed fixture equals the live stream, shape-normalized;
 *   (b) the projector's output over the LIVE stream still replays to the golden's shape;
 *   (c) the P8b-5 no-echo measurement still holds (the child does not echo host-pushed `user` frames);
 *   (d) **the steer measurement** — does a turn pushed while another is running get its own
 *       `result`? That answer decides whether Task 16 calls `beginTurn` for a `steer`, and it is
 *       the one question the original measurement deliberately could not answer (it gated its
 *       second envelope on the first terminal "so the turns stay separable").
 *
 * SKIPS cleanly when `WINTER_RUNTIME_EXECUTABLE` is unset; `WINTER_RUNTIME_REQUIRE_BINARY=1` makes a
 * missing binary a FAILURE, so CI can never go green by skipping the proof (P8b-2).
 *
 * **The child never sees a real home.** `HOME`, `TMPDIR`, `WINTER_HOME` and `WINTER_HOME` are all
 * built onto a fresh `mkdtemp`, and the env is CONSTRUCTED rather than spread from `process.env` —
 * inheriting would leak the developer's `~/.winter`, `~/.winter` and any provider credentials in the
 * environment into a spawned process. `winter-test/*` models select an in-process double, so
 * nothing reaches the network.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "sdk");
const readFixture = (file: string): ProtocolSdkMessage[] =>
  readFileSync(join(FIXTURES, file), "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as ProtocolSdkMessage);

/** The comparable shape of a wire message: its kind, and the *structure* of what it carries.
 *  Session ids, uuids, cwds and model names are per-run; block kinds and tool names are the
 *  contract. This is what "equals it (shape-normalized)" means, stated rather than implied. */
function shapeOf(m: ProtocolSdkMessage): unknown {
  const r = m as Record<string, unknown>;
  const kind = typeof r.subtype === "string" ? `${r.type as string}/${r.subtype}` : (r.type as string);
  const blocks = (msg: unknown): unknown => {
    const content = (msg as { content?: unknown })?.content;
    if (!Array.isArray(content)) return undefined;
    return content.map((b) => {
      const bb = b as Record<string, unknown>;
      return bb.type === "tool_use" ? { type: "tool_use", name: bb.name }
        : bb.type === "tool_result" ? { type: "tool_result", denied: bb.denied === true, isError: bb.is_error === true }
          : { type: bb.type };
    });
  };
  switch (r.type) {
    case "assistant": case "user":
      return { kind, blocks: blocks(r.message), child: typeof r.parent_tool_use_id === "string" };
    case "result":
      return { kind, is_error: r.is_error === true, interrupted: r.interrupted === true, denials: (r.permission_denials as unknown[] | undefined)?.length ?? 0 };
    case "stream_event":
      return { kind, event: (r.event as { type?: string })?.type };
    default:
      return { kind };
  }
}

interface RunResult { messages: ProtocolSdkMessage[]; events: SessionEvent[]; results: number; threw?: string }

/** Drive a real child the way Task 16's driver will, and record both sides of the projector. */
async function driveChild(bin: string, opts: {
  provider: string;
  /** Called with the queue and a "turn N pushed" signal so a test can choose WHEN to push. */
  pushes: (q: ReturnType<typeof createHostPromptQueue>, sawResult: () => Promise<void>, beginTurn: () => void) => Promise<void>;
}): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "winter-e2e-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-e2e-cwd-"));
  const queue = createHostPromptQueue();
  const projector = createProjector({
    sessionId: "s_e2e", mode: "code", generation: 1,
    nextSeq: (() => { let n = 0; return () => ++n; })(),
    checkpoint: new FakeCheckpoints(),
    now: () => new Date().toISOString(),
    log: {},
  });

  const messages: ProtocolSdkMessage[] = [];
  const events: SessionEvent[] = [];
  const keep = (b: ProjectedBatch): void => { events.push(...b.persist, ...b.broadcast); };

  let results = 0;
  let resolveResult: (() => void) | undefined;
  const sawResult = (): Promise<void> => new Promise<void>((r) => { resolveResult = r; });

  const q = query({
    prompt: queue,
    options: {
      pathToClaudeCodeExecutable: bin,
      model: `winter-test/${opts.provider}`,
      cwd,
      includePartialMessages: true,
      // CONSTRUCTED, never spread from process.env — see the header.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home, TMPDIR: home, WINTER_HOME: home, WINTER_HOME: home,
        WINTER_PROFILE: "test",
        WINTER_TEST_PROVIDER: opts.provider,
      },
    },
  });

  const driving = opts.pushes(queue, sawResult, () => keep(projector.beginTurn({ text: "pushed" })))
    .finally(() => { if (!queue.closed) queue.close(); });

  let threw: string | undefined;
  try {
    for await (const m of q) {
      messages.push(m);
      keep(projector.accept(m));
      if ((m as { type?: string }).type === "result") { results++; resolveResult?.(); resolveResult = undefined; }
    }
  } catch (err) {
    threw = err instanceof Error ? err.name : String(err);
    keep(projector.acceptError(err));
  }
  projector.flush();
  await driving;
  for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  return { messages, events, results, ...(threw === undefined ? {} : { threw }) };
}

describeWithWinterBinary("projector: a REAL winter child", (bin) => {
  test("winter-test/echo: two pushed turns, two terminals, and no echoed user frame", async () => {
    const run = await driveChild(bin, {
      provider: "echo",
      pushes: async (queue, sawResult, beginTurn) => {
        beginTurn(); queue.push("first user turn");
        await Promise.race([sawResult(), Bun.sleep(30_000)]);
        beginTurn(); queue.push("second user turn");
        await Promise.race([sawResult(), Bun.sleep(30_000)]);
      },
    });

    // (a) the live stream, kind by kind — the sequence Task 10's recording reported
    expect(run.messages.map((m) => (shapeOf(m) as { kind: string }).kind))
      .toEqual(["system/init", "assistant", "result/success", "assistant", "result/success"]);

    // THE `stream_event` GAP, RE-CONFIRMED LIVE: `includePartialMessages` is on and the scripted
    // double still emits none, which is why every `stream_event` line in the fixtures is AUTHORED.
    // Asserted rather than assumed, so the day a double starts streaming this test says so.
    expect(run.messages.filter((m) => (m as { type?: string }).type === "stream_event")).toEqual([]);

    // (c) THE NO-ECHO MEASUREMENT, re-run live: two pushed turns, zero `user` frames.
    expect(run.messages.filter((m) => (m as { type?: string }).type === "user")).toEqual([]);
    expect(run.events.filter((e) => e.type === "user_message")).toEqual([]);

    // (b) one terminal per begun turn, and the projector's own shape
    expect(run.results).toBe(2);
    expect(run.events.filter((e) => e.type === "turn_completed")).toHaveLength(2);
    expect(run.events.filter((e) => e.type === "turn_started")).toHaveLength(2);
    for (const e of run.events) expect({ type: e.type, ok: SessionEvent.safeParse(e).success }).toEqual({ type: e.type, ok: true });
  }, 60_000);

  test("winter-test/tooluse: the denial fixture's live shape, and the projector's transcript", async () => {
    const run = await driveChild(bin, {
      provider: "tooluse",
      pushes: async (queue, sawResult, beginTurn) => {
        beginTurn(); queue.push("first user turn");
        await Promise.race([sawResult(), Bun.sleep(30_000)]);
        beginTurn(); queue.push("second user turn");
        await Promise.race([sawResult(), Bun.sleep(30_000)]);
      },
    });

    // (a) the committed `code-tool-denied` fixture is this recording, retargeted Write→test_tool.
    // Comparing KINDS (not tool names) is the honest comparison: the fixture deliberately renames
    // the denied tool so the scenario is a Write, while the shapes must stay identical.
    const live = run.messages.map((m) => (shapeOf(m) as { kind: string }).kind);
    expect(live).toEqual([
      "system/init", "assistant", "system/permission_denied", "user", "assistant",
      "result/success", "result/error_during_execution",
    ]);
    const fixture = readFixture("code-tool-denied.messages.jsonl").map((m) => (shapeOf(m) as { kind: string }).kind);
    expect(live).toEqual(fixture);

    // the denial's two wire witnesses are both still there
    const denial = run.messages.find((m) => (m as { subtype?: string }).subtype === "permission_denied");
    expect(denial).toBeDefined();
    const userFrame = run.messages.find((m) => (m as { type?: string }).type === "user") as { message: { content: Array<Record<string, unknown>> } };
    expect(userFrame.message.content[0]).toMatchObject({ type: "tool_result", denied: true });

    // (b) the projector folds the live stream into the golden's shape: a tool_call (WINTER-named),
    // its error result, the post-denial text, and one terminal per begun turn.
    const kinds = run.events.filter((e) => (e as { threadId?: string }).threadId === MAIN_THREAD).map((e) => e.type);
    expect(kinds).toEqual([
      "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed",
      "turn_started", "agent_error", "turn_completed",
    ]);
    // `test_tool` has no Winter name, so it falls through unchanged — the documented fail-open.
    expect(run.events.find((e) => e.type === "tool_call")).toMatchObject({ name: "test_tool" });
    expect(run.events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    // the error-result-then-throw pair (§4.8 item 3) surfaces as a throw the driver must catch
    expect(run.threw).toBe("ResultError");
    // and `acceptError` did NOT project it twice — one agent_error for the one error result
    expect(run.events.filter((e) => e.type === "agent_error")).toHaveLength(1);
  }, 60_000);

  test("THE STEER MEASUREMENT: a mid-turn push DOES yield its own result — so a steer needs its own beginTurn", async () => {
    // The Task 16 measurement obligation, and the question Task 10's recording deliberately could
    // not answer (it gated its second envelope on the first terminal "so the turns stay
    // separable"). Here the second push lands WITHOUT waiting — while the first turn is still
    // running — which is what `session.steer` does.
    //
    // MEASURED, live: two pushes → **two `result`s**. A steered-in message terminates on its own.
    //
    // The consequence is the whole point, and it is demonstrated below rather than argued: with
    // only ONE `beginTurn`, the second terminal is DROPPED (it arrives with `openTurns === 0`, and
    // the `sawFrame` fallback cannot save it because the scripted double's second turn produces no
    // frames). So **Task 16 MUST call `beginTurn` for a steer as well as for a send** — the same
    // defect M1 fixed on the send path, alive on the steer path until the driver does.
    const oneBegin = await driveChild(bin, {
      provider: "tooluse",
      pushes: async (queue, _sawResult, beginTurn) => {
        beginTurn();
        queue.push("first user turn");
        await Bun.sleep(5);              // no await on the terminal: this is a STEER
        queue.push("steered mid-turn");
        await Bun.sleep(3_000);
      },
    });
    expect(oneBegin.results).toBe(2);                                                   // the measurement
    expect(oneBegin.events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(oneBegin.events.filter((e) => e.type === "turn_completed")).toHaveLength(1);  // one DROPPED

    // The same stream with a `beginTurn` per push — what the driver must do — keeps both terminals.
    const twoBegins = await driveChild(bin, {
      provider: "tooluse",
      pushes: async (queue, _sawResult, beginTurn) => {
        beginTurn();
        queue.push("first user turn");
        await Bun.sleep(5);
        beginTurn();
        queue.push("steered mid-turn");
        await Bun.sleep(3_000);
      },
    });
    expect(twoBegins.results).toBe(2);
    expect(twoBegins.events.filter((e) => e.type === "turn_started")).toHaveLength(2);
    expect(twoBegins.events.filter((e) => e.type === "turn_completed")).toHaveLength(2);
  }, 60_000);
});
