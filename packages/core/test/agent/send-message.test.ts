import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { FakeProvider } from "../../src/agent/fake-provider";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSendMessageTool } from "../../src/agent/tools/send-message";
import { setup } from "./engine-spawn.test";

// 4h-ii-b Task 4: send_message (CC's SendMessage) — message a RUNNING subagent (delivered at its
// next step, thread-scoped steer) or reach a FINISHED one (resumes it in the background). This is
// an ENGINE BRIDGE, mirroring the spawn_agent bridge; send-message.ts holds only the tool DEF.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
// A fresh spawn with a stable `name` so a later turn can address it (the model can't know the
// generated agentId; `name` is the stable handle).
// 5a: `run_in_background: false` defaulted (before `...extra`) — depth 0 now backgrounds by
// default, and test (b) below needs this spawn to finish synchronously so the child is actually
// FINISHED before it's messaged (send_message's own background-resume is the thing under test,
// not this setup spawn).
const spawnNamed = (callId: string, prompt: string, name: string, extra?: Record<string, unknown>): ProviderEvent =>
  ({ type: "tool_call", callId, name: "spawn_agent", argsJson: JSON.stringify({ prompt, description: "task", name, run_in_background: false, ...extra }) });
const sendMessage = (callId: string, to: string, message: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "send_message", argsJson: JSON.stringify({ to, message }) });

const M = (role: "user" | "assistant", content: string): { type: "message"; role: "user" | "assistant"; content: string } =>
  ({ type: "message", role, content });
const lastUserOf = (input: readonly unknown[]): string | undefined => {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: string; role?: string; content?: unknown };
    if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
  }
  return undefined;
};
const isChildRun = (input: readonly unknown[], opening: string): boolean => {
  const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
  return first?.type === "message" && first.role === "user" && first.content === opening;
};
const hasUserMsg = (input: readonly unknown[], content: string): boolean =>
  input.some((it) => {
    const m = it as { type?: string; role?: string; content?: unknown };
    return m.type === "message" && m.role === "user" && m.content === content;
  });
const toolResult = (events: readonly SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined =>
  events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;
// C1 regression detector: is there a `function_call` NOT immediately followed by its `tool_result`
// (a trailing call, or one followed by any other item)? On a real openai-compatible provider
// (`mapInput` is a blind 1:1 map, no coalescing) that is an orphaned function_call → a hard reject.
const orphanFunctionCall = (input: readonly unknown[]): boolean => {
  for (let i = 0; i < input.length; i++) {
    if ((input[i] as { type?: string })?.type !== "function_call") continue;
    const next = input[i + 1] as { type?: string } | undefined;
    if (!next || next.type !== "tool_result") return true;
  }
  return false;
};
const indexOfType = (input: readonly unknown[], type: string): number =>
  input.findIndex((it) => (it as { type?: string })?.type === type);

// A registry pre-loaded with send_message; setup() adds the standard tool set (read/write/spawn/…)
// on top. send_message must be registered for test (d)'s child-exclusion assertion (the child's
// tool set = specs() minus excludeTools — send_message has to be IN specs() to prove it's filtered).
function setupSend(script: ProviderEvent[][], opts: Parameters<typeof setup>[1] = {}) {
  const registry = new ToolRegistry();
  registerSendMessageTool(registry);
  return setup(script, { ...opts, registry });
}

describe("AgentEngine: send_message (4h-ii-b Task 4 — CC SendMessage parity)", () => {
  // (a) SM2/SM3: a RUNNING child receives the message at its NEXT round. The child is spawned
  // run_in_background so the parent isn't blocked; between the child's rounds, the MAIN thread
  // calls send_message. Content-dispatched provider (timing between a detached child and the
  // parent is non-deterministic under index-scripting): the child parks after round 0 until the
  // test releases it, and the parent only sends AFTER the child's round-0 (empty) top-drain has
  // run — so the message deterministically lands in the child's round-1 drain.
  test("(a) a RUNNING child receives a send_message at its next round (thread-scoped steer)", async () => {
    class RunningChildProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      private resolveChildStarted!: () => void;
      readonly childStarted = new Promise<void>((r) => { this.resolveChildStarted = r; });
      private resolveMsgDelivered!: () => void;
      readonly msgDelivered = new Promise<void>((r) => { this.resolveMsgDelivered = r; });
      releaseChild() { this.resolveMsgDelivered(); }
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          if (hasUserMsg(input, "INJECT-MSG")) {
            // round 1: the injected message was drained in — finish so the child becomes terminal
            yield { type: "text_delta", delta: "child saw the message" };
            yield done("end_turn");
            return;
          }
          // round 0: its top-drain already ran (empty). Signal we've started, emit a loop-trigger
          // tool_call so there IS a round 1, then PARK until the test releases us.
          this.resolveChildStarted();
          yield { type: "tool_call", callId: "child-read", name: "read", argsJson: JSON.stringify({ path: "nope.txt" }) };
          yield done("tool_calls");
          await this.msgDelivered;
          return;
        }
        // MAIN thread
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // wait until the child's round 0 has begun (its empty top-drain ran) so the message
          // deterministically lands in the child's NEXT round's drain, not round 0
          await this.childStarted;
          yield sendMessage("m1", "worker", "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" };
        yield done("end_turn");
      }
    }
    const provider = new RunningChildProvider();
    const { engine, store, sessionId, bgAgents } = setupSend([], { provider });
    await engine.runTurn(sessionId); // parent turn: spawn bg child → send_message → finish

    // the send_message tool_result is emitted synchronously in-turn: delivered, not an error
    const smResult = toolResult(store.read(sessionId), "m1");
    expect(smResult).toMatchObject({ isError: false });
    expect(smResult!.output).toBe("message delivered to 'worker'");

    // release the parked child; poll for its next round + terminal completion to settle
    provider.releaseChild();
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // the child's next-round provider request carried the injected user message
    const injected = provider.requests.find((r) => isChildRun(r.input, "child-task") && hasUserMsg(r.input, "INJECT-MSG"));
    expect(injected).toBeDefined();

    // SM3 cleanup: the child's steer queue entry is DELETED at its terminal exit — a drained queue
    // leaves an empty array under the key; cleanup removes the key entirely, so a later resume of
    // this SAME threadId can't drain a stale message. `has() === false` distinguishes the two.
    const worker = bgAgents.get("worker", sessionId)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.has(worker.threadId)).toBe(false);
  });

  // (b) SM4: a FINISHED (terminal) child is RESUMED in the BACKGROUND when messaged — the resume
  // path (T3) reused verbatim. The tool_result is {agentId,status:"running"} immediately (never
  // blocks the parent) and the thread re-runs with [prior history + the message].
  test("(b) a FINISHED child is resumed in the background, re-running with history + the message", async () => {
    const { engine, store, sessionId, provider, bgAgents } = setupSend([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn → completes clean
      text("child-out-1"),                                             // child run 1 (ends on assistant → resumable)
      text("parent turn1"),
      [sendMessage("m1", "worker", "now do Y"), done("tool_calls")],    // turn 2: message the finished child
      text("child-out-2"),                                             // resumed (detached) child run
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1: spawn worker (sync) → completes + registers
    await engine.runTurn(sessionId); // turn 2: send_message → background resume

    const worker = bgAgents.get("worker", sessionId)!;
    // the tool_result is set SYNCHRONOUSLY in-turn (the bg resume returns immediately)
    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: false });
    expect(result!.output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    // POLL for the detached resumed run to settle (no fixed sleep)
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // bg-retrigger T1 (concern fix): the detached RESUME's settle handler now persists the
    // completion notice itself (notifyBgCompletion), exactly like a fresh detached spawn —
    // reopen() reset `notified` at resume time, so the claim fires again for the resumed run's
    // OWN completion (CC parity: a resumed agent that finishes again notifies again). The
    // original SYNC spawn completed {notified:true}, so this is the session's ONLY notification.
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed", notified: true });
    const notes = store.read(sessionId).filter((e) => e.type === "task_notification");
    expect(notes).toHaveLength(1);
    expect((notes[0] as Extract<SessionEvent, { type: "task_notification" }>).content)
      .toContain("<result>child-out-2</result>");

    // the resume re-ran the SAME thread with [opening + prior reply + the message]
    const fp = provider as FakeProvider;
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "now do Y");
    expect(resumed).toBeDefined();
    expect(resumed!.input).toEqual([
      M("user", "do the task"),      // opening prompt, prepended
      M("assistant", "child-out-1"), // the child's OWN prior reply, reconstructed from the store
      M("user", "now do Y"),         // the message, persisted then picked up last
    ]);
  });

  // task-15 (CC parity — THE headline user-visible fix): send_message to a STALL-FAILED agent (not
  // just a cleanly-finished one like (b) above) now auto-resumes it — status flips back to
  // "running" — instead of returning "didn't finish cleanly and can't be resumed". send_message's
  // terminal-target branch funnels through the SAME resumeThread guard as spawn_agent{resume}, so
  // the failed child's orphaned function_call (its tool stalled mid-flight, tool_call persisted but
  // no tool_result ever came) is repaired with a synthetic cancellation tool_result exactly the
  // same way — this test just proves send_message hits the identical fixed path.
  test("(task-15) send_message to a stall-FAILED agent auto-resumes it (status returns to 'running')", async () => {
    const registry = new ToolRegistry();
    registerSendMessageTool(registry);
    registry.register({
      name: "hang",
      description: "test-only: a tool call whose run() never resolves — simulates a tool still in flight when the stall watchdog gives up",
      args: z.object({}),
      run: () => new Promise<string>(() => { /* never resolves */ }),
    });
    const { engine, store, sessionId, provider, bgAgents } = setup(
      [
        [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn
        [{ type: "tool_call", callId: "hang1", name: "hang", argsJson: "{}" }, done("tool_calls")], // child's only round: stalls mid-tool
        text("parent turn1"),
        [sendMessage("m1", "worker", "keep going"), done("tool_calls")], // turn 2: message the FAILED child
        text("child-out-2"),                                            // the resumed (detached) child's own run
        text("parent turn2"),
      ],
      { registry, subagentsOpts: { stallTimeoutMs: 40 } },
    );
    await engine.runTurn(sessionId); // turn 1: spawn "worker" — stalls mid-tool → status "failed"
    expect(bgAgents.get("worker", sessionId)?.status).toBe("failed");

    await engine.runTurn(sessionId); // turn 2: send_message to the FAILED agent → auto-resumes

    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: false }); // no longer "didn't finish cleanly"
    const worker = bgAgents.get("worker", sessionId)!;
    expect(result!.output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    // the repaired resumed run's own request pairs the orphan with a synthetic cancellation —
    // never a bare, unresolved function_call (which orphanFunctionCall would catch as a hard
    // provider reject waiting to happen).
    const fp = provider as FakeProvider;
    const resumed = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "keep going");
    expect(resumed).toBeDefined();
    expect(orphanFunctionCall(resumed!.input)).toBe(false);
    expect(resumed!.input).toContainEqual({
      type: "tool_result", callId: "hang1",
      output: "[cancelled: the agent ended before this tool call completed]",
      isError: true,
    });

    // let the detached resumed run settle before the test ends (no dangling chain)
    for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get("worker", sessionId)?.status).toBe("completed");
  });

  // task-15 REVIEW (buried orphan through the send_message funnel): the repair is in-memory-only,
  // so after the first repaired resume the store STILL contains the unpaired tool_call — a SECOND
  // send_message (after the first resume completed CLEANLY, so the child's tail is now a clean
  // assistant message) reconstructs the full history with that orphan BURIED mid-history. The
  // always-run full-array repair must pair it again on every later resume — this file's own
  // orphanFunctionCall helper (the documented hard-reject detector) is the invariant check.
  test("(task-15 review) SECOND send_message after a repaired resume completed cleanly — the buried orphan is still paired, resume succeeds", async () => {
    const registry = new ToolRegistry();
    registerSendMessageTool(registry);
    registry.register({
      name: "hang",
      description: "test-only: a tool call whose run() never resolves — simulates a tool still in flight when the stall watchdog gives up",
      args: z.object({}),
      run: () => new Promise<string>(() => { /* never resolves */ }),
    });
    const { engine, store, sessionId, provider, bgAgents } = setup(
      [
        [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn
        [{ type: "tool_call", callId: "hang1", name: "hang", argsJson: "{}" }, done("tool_calls")], // child run 1: stalls mid-tool
        text("parent turn1"),
        [sendMessage("m1", "worker", "keep going"), done("tool_calls")], // turn 2: message the FAILED child → resume #1 (repaired)
        text("child-out-2"),                                            // resumed run completes CLEANLY (detached)
        text("parent turn2"),
        [sendMessage("m2", "worker", "go again"), done("tool_calls")],   // turn 3: message the now-COMPLETED child → resume #2
        text("child-out-3"),                                            // second resumed run (detached)
        text("parent turn3"),
      ],
      { registry, subagentsOpts: { stallTimeoutMs: 40 } },
    );
    await engine.runTurn(sessionId); // turn 1: spawn — stalls mid-tool
    expect(bgAgents.get("worker", sessionId)?.status).toBe("failed");

    await engine.runTurn(sessionId); // turn 2: send_message → repaired resume #1
    for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get("worker", sessionId)?.status).toBe("completed"); // clean tail now masks the buried orphan

    await engine.runTurn(sessionId); // turn 3: send_message again → resume #2 must re-pair the buried orphan

    const result2 = toolResult(store.read(sessionId), "m2");
    expect(result2).toMatchObject({ isError: false });
    const worker = bgAgents.get("worker", sessionId)!;
    expect(result2!.output).toBe(JSON.stringify({ agentId: worker.threadId, status: "running" }));

    const fp = provider as FakeProvider;
    const secondResume = fp.requests.find((r) => isChildRun(r.input, "do the task") && lastUserOf(r.input) === "go again");
    expect(secondResume).toBeDefined();
    // the documented hard-reject invariant holds: NO function_call anywhere in the input lacks an
    // immediately-following tool_result — the buried orphan included.
    expect(orphanFunctionCall(secondResume!.input)).toBe(false);
    // and the pairing is the synthetic cancellation, sitting MID-HISTORY (right after the orphan,
    // which is input[1] just behind the opening prompt), NOT at the tail.
    const inputItems = secondResume!.input as Array<{ type?: string; callId?: string }>;
    expect(inputItems[1]).toMatchObject({ type: "function_call", callId: "hang1" });
    expect(secondResume!.input[2]).toEqual({
      type: "tool_result", callId: "hang1",
      output: "[cancelled: the agent ended before this tool call completed]",
      isError: true,
    });
    expect(secondResume!.input.length).toBeGreaterThan(4); // history continues past the pair (resume #1's prompt, its reply, the new message)

    // let the detached second resume settle before the test ends (no dangling chain)
    for (let i = 0; i < 200 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get("worker", sessionId)?.status).toBe("completed");
  });

  // (c) SM4: an unknown `to` → typed isError, no side effect (no thread started, child never ran).
  test("(c) send_message to an unknown agent → typed isError, no side effect", async () => {
    const { engine, store, sessionId, provider } = setupSend([
      [sendMessage("m1", "ghost", "hello?"), done("tool_calls")],
      text("parent saw the error"),
    ]);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    const result = toolResult(events, "m1");
    expect(result).toMatchObject({ isError: true });
    // D1-T4: `to` now also falls back to session resolution when it isn't a known agent, so the
    // wording widened to reflect BOTH attempts (store.meta("ghost") throws too — truly unknown).
    expect(result!.output).toBe("no agent or session 'ghost' to message");
    expect(events.some((e) => e.type === "thread_started")).toBe(false);
    expect((provider as FakeProvider).requests.length).toBe(2); // only the parent's two rounds
  });

  // 4h-ii-b Task 5 (stale-name guard, CC v2.1.199 parity): a name that PREVIOUSLY, successfully
  // reached one agentId refuses a send_message that resolves it to a DIFFERENT agentId — never
  // delivers. Today's registry can't organically reuse a name (register() permanently reserves
  // it), so this seeds the tracking map directly, exactly like the task_stop-level tests — the
  // state a future name-reuse/eviction feature would leave behind.
  test("(h) send_message refuses a by-name resolution that now reaches a different agentId than one it previously reached — no delivery", async () => {
    const { engine, store, sessionId, bgAgents } = setupSend([
      [spawnNamed("s1", "do the task", "worker"), done("tool_calls")], // turn 1: sync spawn → completes clean, registers "worker"
      text("child-out-1"),
      text("parent turn1"),
      [sendMessage("m1", "worker", "hi again"), done("tool_calls")], // turn 2: message by name
      text("parent turn2"),
    ]);
    await engine.runTurn(sessionId); // turn 1
    const worker = bgAgents.get("worker", sessionId)!;

    // Seed a STALE record for "worker" pointing at a DIFFERENT (fake) agentId — simulating a prior
    // reach that no longer matches what "worker" resolves to now.
    bgAgents.recordReached(sessionId, "worker", "th_stale_fake_id");

    await engine.runTurn(sessionId); // turn 2: send_message by name → must be refused
    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: true });
    expect(result!.output).toBe(
      `name 'worker' now reaches a different agent (${worker.threadId}); it previously reached th_stale_fake_id. Address the agent by ID instead.`,
    );
    // no delivery: the (already-completed) worker's status is untouched, still notified from turn 1
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed" });
  });

  // (i) a by-ID send_message bypasses the guard entirely, even with a stale record for some name.
  test("(i) send_message by agentId bypasses the stale-name guard — delivery proceeds regardless of any stale name record", async () => {
    class ByIdProvider implements Provider {
      readonly id = "fake";
      private round = 0;
      targetId: string | undefined;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const input = req.input;
        if (isChildRun(input, "do the task")) {
          if (lastUserOf(input) === "resume by id") { yield { type: "text_delta", delta: "resumed by id" }; yield done("end_turn"); return; }
          yield { type: "text_delta", delta: "child-out-1" }; yield done("end_turn"); return;
        }
        const n = this.round++;
        if (n === 0) { yield spawnNamed("s1", "do the task", "worker"); yield done("tool_calls"); return; }
        // n===1 ends TURN 1 with plain text (the sync spawn+child already completed within turn 1's
        // own round loop) — targetId isn't known until AFTER runTurn(...) returns below, so the
        // send_message call itself must wait for a SEPARATE turn 2.
        if (n === 1) { yield { type: "text_delta", delta: "parent turn1" }; yield done("end_turn"); return; }
        if (n === 2) { yield sendMessage("m1", this.targetId!, "resume by id"); yield done("tool_calls"); return; }
        yield { type: "text_delta", delta: "parent turn2" }; yield done("end_turn");
      }
    }
    const provider = new ByIdProvider();
    const { engine, store, sessionId, bgAgents } = setupSend([], { provider });
    await engine.runTurn(sessionId); // turn 1: sync spawn named "worker" completes, parent wraps up
    const worker = bgAgents.get("worker", sessionId)!;
    bgAgents.recordReached(sessionId, "worker", "th_stale_fake_id"); // stale record for the NAME only
    provider.targetId = worker.agentId;

    await engine.runTurn(sessionId); // turn 2: send_message BY ID (not by name)
    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result!.output)).toMatchObject({ agentId: worker.agentId, status: "running" });
    // the stale record for the NAME is untouched — a by-ID send never writes to it
    expect(bgAgents.firstReached(sessionId, "worker")).toBe("th_stale_fake_id");
  });

  // (d) SM6: send_message is DEPTH-0 only — excluded from every child thread's tool set (v1 has no
  // agent-to-agent messaging). A depth-1 child's specs()-derived tool set (after excludeTools
  // filtering) does NOT contain send_message, while the MAIN thread's DOES.
  test("(d) send_message is excluded from a child thread's tool set (depth-0 only)", async () => {
    // 5a: run_in_background:false — this test's subject is tool-set filtering, not the bg
    // default; the child must run synchronously so its own provider request is deterministically
    // recorded before the assertions below run.
    const { engine, sessionId, provider } = setupSend([
      [{ type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", run_in_background: false }) }, done("tool_calls")],
      text("child done"),
      text("parent done"),
    ]);
    await engine.runTurn(sessionId);

    const fp = provider as FakeProvider;
    const childReq = fp.requests.find((r) => isChildRun(r.input, "child-task"));
    expect(childReq).toBeDefined();
    const childTools = (childReq!.tools ?? []).map((t) => t.name);
    expect(childTools).not.toContain("send_message");
    // sanity: the filter is real, not an empty tool set — read is present, spawn_agent too (depth < cap)
    expect(childTools).toContain("read");
    expect(childTools).toContain("spawn_agent");

    // and send_message IS available to the MAIN thread (registered + main-only)
    const mainReq = fp.requests.find((r) => !isChildRun(r.input, "child-task"));
    expect((mainReq!.tools ?? []).map((t) => t.name)).toContain("send_message");
  });

  // Invalid arguments (defensive hand-parse, same shape as the spawn bridge): a missing/non-string
  // `to` or `message` → typed isError, never a throw.
  test("(e) missing `to` / `message` → typed isError with the field name", async () => {
    const { engine, store, sessionId } = setupSend([
      [{ type: "tool_call", callId: "m1", name: "send_message", argsJson: JSON.stringify({ message: "hi" }) }, done("tool_calls")],
      text("parent turn1"),
    ]);
    await engine.runTurn(sessionId);
    const r1 = toolResult(store.read(sessionId), "m1");
    expect(r1).toMatchObject({ isError: true });
    expect(r1!.output).toBe("invalid arguments for send_message: to");

    const { engine: e2, store: s2, sessionId: sid2 } = setupSend([
      [{ type: "tool_call", callId: "m2", name: "send_message", argsJson: JSON.stringify({ to: "worker" }) }, done("tool_calls")],
      text("parent turn1"),
    ]);
    await e2.runTurn(sid2);
    const r2 = toolResult(s2.read(sid2), "m2");
    expect(r2).toMatchObject({ isError: true });
    expect(r2!.output).toBe("invalid arguments for send_message: message");
  });

  // (f) SM3 continue-on-pending: a message that lands as the child finishes its FINAL round must
  // NOT be silently dropped. Distinct from (a): the child's round 0 ends on `end_turn` with NO
  // tool_call, so it takes the round-END branch (not the SM2 round-top drain (a) exercises). The
  // generalized continue-on-pending then sees the pending message → continues → round 1 drains it.
  test("(f) a message landing as the child finishes its final round → it continues and drains it (not dropped)", async () => {
    class FinalRoundProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      private resolveChildStarted!: () => void;
      readonly childStarted = new Promise<void>((r) => { this.resolveChildStarted = r; });
      private resolveMsgDelivered!: () => void;
      readonly msgDelivered = new Promise<void>((r) => { this.resolveMsgDelivered = r; });
      releaseChild() { this.resolveMsgDelivered(); }
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          if (hasUserMsg(input, "INJECT-MSG")) {
            // round 1: the pending message was drained after the continue — finish
            yield { type: "text_delta", delta: "child drained the final-round message" };
            yield done("end_turn");
            return;
          }
          // round 0: end on end_turn with NO tool_call → takes the round-END branch. Park until the
          // message is delivered so the end-of-round pending check sees it and CONTINUES (rather
          // than terminating and dropping it).
          this.resolveChildStarted();
          yield done("end_turn");
          await this.msgDelivered;
          return;
        }
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          await this.childStarted;
          yield sendMessage("m1", "worker", "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" };
        yield done("end_turn");
      }
    }
    const provider = new FinalRoundProvider();
    const { engine, store, sessionId, bgAgents } = setupSend([], { provider });
    await engine.runTurn(sessionId);

    expect(toolResult(store.read(sessionId), "m1")!.output).toBe("message delivered to 'worker'");

    provider.releaseChild();
    for (let i = 0; i < 400 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // the child ran a SECOND round that drained the final-round message (continue-on-pending fired)
    const drained = provider.requests.find((r) => isChildRun(r.input, "child-task") && hasUserMsg(r.input, "INJECT-MSG"));
    expect(drained).toBeDefined();
    // and it settled cleanly (the message wasn't left orphaned in the queue)
    const worker = bgAgents.get("worker", sessionId)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.has(worker.threadId)).toBe(false);
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed" });
  });

  // (g) C1/I1 REGRESSION (whole-branch review): a message delivered to a running child WHILE it is
  // MID-TOOL — parked INSIDE executeCall between the child's tool_call and its tool_result — must NOT
  // be persisted between that pair. Tests (a)/(f) park in the PROVIDER GENERATOR (before/after a
  // round), so they never expose the interior window; this test parks in a real TOOL's run(). If the
  // message is persisted at SEND time (the pre-fix bug), the child's stored log becomes
  // [tool_call, user_message, tool_result, assistant] and, on RESUME, childHistoryInput reconstructs
  // [function_call, user, tool_result, ...] — an orphan function_call immediately followed by a user
  // turn → a hard provider reject. The fix persists at the child's round-top DRAIN, so the message
  // lands AFTER the tool_result: [tool_call, tool_result, user_message, assistant] → clean on resume.
  test("(g) a send_message delivered MID-TOOL is persisted at the drain, not between the tool_call/tool_result pair — no orphan on resume", async () => {
    // The park tool lets the child stop INSIDE executeCall (a real multi-second tool window). run()
    // signals it has entered the tool (childInTool), then blocks until the test releases it.
    let resolveChildInTool!: () => void;
    const childInTool = new Promise<void>((r) => { resolveChildInTool = r; });
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((r) => { releaseTool = r; });

    const registry = new ToolRegistry();
    registerSendMessageTool(registry);
    // An mcp__-prefixed (external) name so the gate auto-allows it under "auto" policy and it runs
    // directly via executeCall — an unclassified name would fall to the gate's fail-closed "ask"
    // branch and stall on the 500ms approval timeout instead of parking. No toolSearch is wired, so
    // it is never deferred.
    registry.register({
      name: "mcp__test__park",
      description: "test-only: parks inside executeCall until released",
      args: z.object({}),
      async run() { resolveChildInTool(); await toolReleased; return "parked-done"; },
    });

    class MidToolProvider implements Provider {
      readonly id = "fake";
      readonly requests: TurnRequest[] = [];
      private mainRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const { signal, ...cloneable } = req;
        this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
        const input = req.input;
        if (isChildRun(input, "child-task")) {
          // Dispatch the child branch on the LAST user turn alone — round0 "child-task",
          // round1 "INJECT-MSG", resume "go on" are all distinct (the resumed input ALSO contains
          // INJECT-MSG, so a hasUserMsg check would be ambiguous).
          const last = lastUserOf(input);
          if (last === "go on") { yield { type: "text_delta", delta: "child resumed cleanly" }; yield done("end_turn"); return; }
          if (last === "INJECT-MSG") { yield { type: "text_delta", delta: "child saw the mid-tool message" }; yield done("end_turn"); return; }
          // round 0: emit a tool_call for the park tool → the engine emits tool_call, then enters
          // executeCall, where the park tool's run() PARKS. The message is delivered during that park.
          yield { type: "tool_call", callId: "child-park", name: "mcp__test__park", argsJson: "{}" };
          yield done("tool_calls");
          return;
        }
        const n = this.mainRound++;
        if (n === 0) {
          yield { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "child-task", description: "task", name: "worker", run_in_background: true }) };
          yield done("tool_calls");
          return;
        }
        if (n === 1) {
          // wait until the child is INSIDE the park tool (mid-tool_call/tool_result window) so the
          // delivery deterministically lands there, not at a round boundary
          await childInTool;
          yield sendMessage("m1", "worker", "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        if (n === 2) { yield { type: "text_delta", delta: "parent turn1 done" }; yield done("end_turn"); return; }
        if (n === 3) {
          // turn 2: RESUME the now-finished child. Its reconstructed input must be clean.
          yield { type: "tool_call", callId: "r1", name: "spawn_agent", argsJson: JSON.stringify({ resume: "worker", prompt: "go on" }) };
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent turn2 done" };
        yield done("end_turn");
      }
    }

    const provider = new MidToolProvider();
    const { engine, store, sessionId, bgAgents } = setup([], { provider, registry });

    // turn 1: spawn bg child → child parks mid-tool → send_message lands mid-tool → parent finishes
    await engine.runTurn(sessionId);
    expect(toolResult(store.read(sessionId), "m1")!.output).toBe("message delivered to 'worker'");

    // release the parked tool; poll until the child drains the message and completes cleanly
    releaseTool();
    for (let i = 0; i < 800 && bgAgents.get("worker", sessionId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bgAgents.get("worker", sessionId)).toMatchObject({ status: "completed" });

    // turn 2: resume the finished child (sync spawn_agent resume) — this reconstructs its history
    await engine.runTurn(sessionId);

    // Discriminate the RESUMED provider request by its last user turn ("go on") — NOT by
    // hasUserMsg("INJECT-MSG"), which is true for the resumed input too (the message survives in the
    // reconstruction, just after the tool_result). The live round-1 request is clean pre-fix anyway
    // (its input is built in dispatch order); the orphan only appears in the RESUME reconstruction.
    const resumed = provider.requests.find((r) => isChildRun(r.input, "child-task") && lastUserOf(r.input) === "go on");
    expect(resumed).toBeDefined();

    // THE C1 ASSERTION: the resumed input has no orphan function_call, and the injected message sits
    // AFTER the tool_result (never between the function_call and its tool_result).
    expect(orphanFunctionCall(resumed!.input)).toBe(false);
    const fcIdx = indexOfType(resumed!.input, "function_call");
    const trIdx = indexOfType(resumed!.input, "tool_result");
    const injIdx = resumed!.input.findIndex((it) => {
      const m = it as { type?: string; role?: string; content?: unknown };
      return m.type === "message" && m.role === "user" && m.content === "INJECT-MSG";
    });
    expect(fcIdx).toBeGreaterThanOrEqual(0);
    expect(trIdx).toBe(fcIdx + 1);          // tool_result immediately follows its function_call
    expect(injIdx).toBeGreaterThan(trIdx);  // the injected message lands AFTER the tool_result
  }, 15_000); // headroom above the release-poll budget; the happy path settles in well under a second
});
