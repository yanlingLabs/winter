import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSendMessageTool } from "../../src/agent/tools/send-message";
import { setup } from "./engine-spawn.test";

// Whole-branch review FIX 1 (Important — data loss): a send_message landing in the window between
// the TARGET's runThread completing its terminal branch (cleanupThreadSteer already ran, the
// turn_completed event already emitted) and runTurn's OWN `finally` deleting `runningTurns` sees
// `isRunning(target) === true` and takes the queue-only branch (sendToThread) — trusting the
// tool_result's "queued ... will see this at its next round" promise. Before this fix, nothing ever
// drained that queue: runTurn's `finally` cleared `steerQueue` but never inspected
// `threadSteerQueue`, and no follow-up turn started for the target — the message sat stranded
// forever despite the sender being told it was queued.
//
// Reproduced deterministically via a controllable `cfg.hooks` "turn-end" pause. engine.ts fires
// `fireTurnEnd` (if cfg.hooks is set) on every terminal branch of runThread, AFTER
// cleanupThreadSteer has already run and the turn_completed event has already been emitted, but
// BEFORE runThread's own `return` — which is strictly before `turn()` resolves and therefore
// strictly before `runTurn`'s `finally` runs `runningTurns.delete`. Pausing there is a
// deterministic stand-in for the reviewer's own two-independent-real-turns race (which depends on
// microtask-scheduling luck the hook makes into a controlled wait instead): `isRunning(T)` reads
// true throughout the pause, exactly matching the reviewer's reproduction.

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });

const lastUserOf = (input: readonly unknown[]): string | undefined => {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: string; role?: string; content?: unknown };
    if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
  }
  return undefined;
};

const hasSendMessageCall = (input: readonly unknown[]): boolean =>
  input.some((it) => (it as { type?: string; name?: string }).type === "function_call" && (it as { name?: string }).name === "send_message");

const toolResult = (events: readonly SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined =>
  events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;

const sendMessageCall = (callId: string, to: string, message: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "send_message", argsJson: JSON.stringify({ to, message }) });

const mkChildCwd = (label: string): string => mkdtempSync(join(tmpdir(), `norma-smrace-${label}-`));

/** A controllable pause on a specific session's "turn-end" hook event — fires (and pauses) exactly
 *  ONCE, on the FIRST "turn-end" seen for `pauseSessionIdRef.current` (read live, so it can be
 *  assigned AFTER the hooks object is constructed but before the paused turn actually runs — the
 *  child session's id isn't known until after `setup()`/`store.createSession` run). Every other
 *  call (a different session, or this SAME session's later turns once `fired`) is transparent. */
function pausableTurnEndHook(pauseSessionIdRef: { current: string | undefined }) {
  let releasePause!: () => void;
  const pausePromise = new Promise<void>((r) => { releasePause = r; });
  let markReached!: () => void;
  const reachedPromise = new Promise<void>((r) => { markReached = r; });
  let fired = false;
  return {
    hooks: {
      async runFor(event: string, _extra: Record<string, unknown>, sessionId: string) {
        if (!fired && event === "turn-end" && sessionId === pauseSessionIdRef.current) {
          fired = true;
          markReached();
          await pausePromise;
        }
        return [];
      },
    },
    reachedPromise,
    release: (): void => releasePause(),
  };
}

describe("send_message: the cleanupThreadSteer -> runningTurns.delete race (whole-branch review FIX 1)", () => {
  test("a message queued in the window is not stranded — it is delivered and persisted at the target's genuinely-next turn", async () => {
    const pauseSessionIdRef: { current: string | undefined } = { current: undefined };
    const { hooks, reachedPromise, release } = pausableTurnEndHook(pauseSessionIdRef);

    const registry = new ToolRegistry();
    registerSendMessageTool(registry);

    class RaceProvider implements Provider {
      readonly id = "fake";
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const input = req.input;
        const last = lastUserOf(input);
        if (last === "T-INIT" && !hasSendMessageCall(input)) {
          // T's FIRST round: ends immediately, no tool calls — reaches the paused turn-end hook.
          yield { type: "text_delta", delta: "T initial" };
          yield done("end_turn");
          return;
        }
        if (last === "HELLO-FROM-P") {
          // T's genuinely-NEXT turn sees the drained cross-session message.
          yield { type: "text_delta", delta: "T saw it" };
          yield done("end_turn");
          return;
        }
        if (last === "P-INIT" && !hasSendMessageCall(input)) {
          yield sendMessageCall("m1", pauseSessionIdRef.current!, "HELLO-FROM-P");
          yield done("tool_calls");
          return;
        }
        // P's follow-up round (after send_message's own tool_result) — just end the turn.
        yield { type: "text_delta", delta: "P done" };
        yield done("end_turn");
      }
    }
    const provider = new RaceProvider();

    const { engine, store, sessionId: P } = setup([], { provider, registry, hooks });
    const tCwd = mkChildCwd("target");
    const T = store.createSession("global", { cwd: tCwd, mode: "code", parentSessionId: P });
    pauseSessionIdRef.current = T;

    store.append(T, { type: "user_message", sessionId: T, threadId: "main", text: "T-INIT", clientName: "test" });
    const tTurn = engine.runTurn(T); // starts, finishes its ONE round normally, then pauses inside turn-end

    await reachedPromise;
    // THE window: T's turn_completed is already emitted (cleanupThreadSteer already ran), but
    // runTurn's `finally` hasn't executed yet — `runningTurns` still has T.
    expect(engine.isRunning(T)).toBe(true);

    store.append(P, { type: "user_message", sessionId: P, threadId: "main", text: "P-INIT", clientName: "test" });
    await engine.runTurn(P); // P's own turn: send_message sees isRunning(T) === true, queues

    const pResult = toolResult(store.read(P), "m1");
    expect(pResult?.isError).toBe(false);
    expect(pResult?.output).toBe(`message queued for session '${T}' — it is running and will see this at its next round`);

    release(); // let T's paused hook resolve -> runThread returns -> turn() resolves -> runTurn's finally runs
    await tTurn; // T's ORIGINAL turn settles

    // GREEN: the message must be delivered AND persisted — poll for the auto-restarted second turn.
    let events = store.read(T);
    for (let i = 0; i < 400 && events.filter((e) => e.type === "turn_completed").length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
      events = store.read(T);
    }
    expect(events.filter((e) => e.type === "turn_completed").length).toBe(2);
    expect(events.some((e) => e.type === "user_message" && (e as Extract<SessionEvent, { type: "user_message" }>).text === "HELLO-FROM-P")).toBe(true);
    expect(events.some((e) => e.type === "assistant_message" && (e as Extract<SessionEvent, { type: "assistant_message" }>).text === "T saw it")).toBe(true);
  });
});

describe("send_message: an abort during the window must not silently delete a queued cross-session message (whole-branch review FIX 1, ledger Minor 4's escalated half)", () => {
  test("the message survives cleanupThreadSteer on a MAIN-thread abort, and drains honestly at the target's genuinely-next turn", async () => {
    const HELLO = "HELLO-FROM-P-2";

    class AbortRaceProvider implements Provider {
      readonly id = "fake";
      T!: string;
      private releaseTGate!: () => void;
      private tGate = new Promise<void>((r) => { this.releaseTGate = r; });
      release(): void { this.releaseTGate(); }
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const input = req.input;
        const last = lastUserOf(input);
        if (last === "T-INIT" && !hasSendMessageCall(input)) {
          // T's first round: gate open until the test releases it, then reports ABORTED (mirrors
          // how a real provider reacts to interrupt() firing its AbortController).
          await this.tGate;
          yield done("aborted");
          return;
        }
        if (last === HELLO) {
          // T's genuinely-next (explicit) turn — sees the drained message.
          yield { type: "text_delta", delta: "T saw it after abort" };
          yield done("end_turn");
          return;
        }
        if (last === "P-INIT" && !hasSendMessageCall(input)) {
          yield sendMessageCall("m2", this.T, HELLO);
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "P done" };
        yield done("end_turn");
      }
    }

    const registry = new ToolRegistry();
    registerSendMessageTool(registry);
    const provider = new AbortRaceProvider();
    const { engine, store, sessionId: P } = setup([], { provider, registry });
    const tCwd = mkChildCwd("abort-target");
    const T = store.createSession("global", { cwd: tCwd, mode: "code", parentSessionId: P });
    provider.T = T;

    store.append(T, { type: "user_message", sessionId: T, threadId: "main", text: "T-INIT", clientName: "test" });
    const tTurn = engine.runTurn(T); // starts, gates inside round 0

    // Give T's round a moment to actually start and gate (mirrors engine-interrupt.test.ts's own
    // "interrupt aborts a running turn" precedent).
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.isRunning(T)).toBe(true);

    store.append(P, { type: "user_message", sessionId: P, threadId: "main", text: "P-INIT", clientName: "test" });
    await engine.runTurn(P); // P's turn: send_message sees isRunning(T) === true, queues

    const pResult = toolResult(store.read(P), "m2");
    expect(pResult?.isError).toBe(false);
    expect(pResult?.output).toBe(`message queued for session '${T}' — it is running and will see this at its next round`);

    // Sanity: the message really is sitting in T's queue right now, BEFORE the abort.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.get(T)).toEqual([HELLO]);

    const interruptRes = engine.interrupt(T); // the abort itself — fires T's AbortController
    expect(interruptRes.wasRunning).toBe(true);
    provider.release(); // let T's gated round finish, yielding done("aborted")
    await tTurn;

    // T ended aborted — exactly one turn_completed so far, and it says "aborted".
    const afterAbort = store.read(T);
    const completions = afterAbort.filter((e) => e.type === "turn_completed");
    expect(completions.length).toBe(1);
    expect(completions[0]).toMatchObject({ stopReason: "aborted" });

    // THE assertion: the message must NOT have been silently deleted by cleanupThreadSteer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).threadSteerQueue.get(T)).toEqual([HELLO]);

    // An ESC-abort must not fight the interrupt by immediately relaunching the session — same
    // "don't fight the interrupt" contract runTurn's finally already has for a dropped
    // bg-notification drain. No auto-restart happened:
    expect(engine.isRunning(T)).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(store.read(T).filter((e) => e.type === "turn_completed").length).toBe(1);

    // The message is HONEST toward the sender, not immediately delivered: it drains at whatever
    // turn for T genuinely runs next — driven here explicitly.
    await engine.runTurn(T);
    const afterResume = store.read(T);
    expect(afterResume.some((e) => e.type === "user_message" && (e as Extract<SessionEvent, { type: "user_message" }>).text === HELLO)).toBe(true);
    expect(afterResume.some((e) => e.type === "assistant_message" && (e as Extract<SessionEvent, { type: "assistant_message" }>).text === "T saw it after abort")).toBe(true);
  });
});
