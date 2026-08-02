import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSendMessageTool } from "../../src/agent/tools/send-message";
import { setup } from "./engine-spawn.test";

// D1-T4 (dispatch-toolset): send_message gains a THIRD target kind — a session id (a
// session_spawn'd first-class child), alongside the existing agentId/name (subagent) targeting.
// Authorization is `store.meta(target).parentSessionId === senderSessionId` — a direct parent
// EDGE, not ancestry — which is what makes inter-session loops structurally impossible (spawn
// edges form a tree). Mid-turn delivery reuses `sendToThread`'s existing queue-then-persist-at-
// drain machinery (keyed by the TARGET's session id, which never collides with a subagent
// thread's th_ id); idle delivery mirrors `session.send`'s own handling (persist + start a turn).

const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];
const sendMessage = (callId: string, to: string, message: string): ProviderEvent =>
  ({ type: "tool_call", callId, name: "send_message", argsJson: JSON.stringify({ to, message }) });

function setupSend(script: ProviderEvent[][], opts: Parameters<typeof setup>[1] = {}) {
  const registry = new ToolRegistry();
  registerSendMessageTool(registry);
  return setup(script, { ...opts, registry });
}

const toolResult = (events: readonly SessionEvent[], callId: string): Extract<SessionEvent, { type: "tool_result" }> | undefined =>
  events.find((e) => e.type === "tool_result" && e.callId === callId) as Extract<SessionEvent, { type: "tool_result" }> | undefined;

const lastUserOf = (input: readonly unknown[]): string | undefined => {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i] as { type?: string; role?: string; content?: unknown };
    if (it?.type === "message" && it.role === "user") return typeof it.content === "string" ? it.content : undefined;
  }
  return undefined;
};

const mkChildCwd = (label: string): string => mkdtempSync(join(tmpdir(), `norma-sms-${label}-`));

describe("AgentEngine: send_message can target a session (D1-T4)", () => {
  test("a parent can message a session it spawned; it lands as a user turn", async () => {
    class P implements Provider {
      readonly id = "fake";
      targetChildId!: string;
      private round = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const input = req.input;
        const first = input[0] as { type?: string; role?: string; content?: unknown } | undefined;
        if (first?.type === "message" && first.role === "user" && first.content === "hello child") {
          yield { type: "text_delta", delta: "child replied" };
          yield done("end_turn");
          return;
        }
        const n = this.round++;
        if (n === 0) { yield sendMessage("m1", this.targetChildId, "hello child"); yield done("tool_calls"); return; }
        yield { type: "text_delta", delta: "parent done" }; yield done("end_turn");
      }
    }
    const provider = new P();
    const { engine, store, sessionId } = setupSend([], { provider });
    const childCwd = mkChildCwd("happy");
    const childId = store.createSession("global", { cwd: childCwd, mode: "code", parentSessionId: sessionId });
    provider.targetChildId = childId;

    await engine.runTurn(sessionId);
    const result = toolResult(store.read(sessionId), "m1");
    expect(result).toMatchObject({ isError: false });

    // idle child → the bridge starts a fresh turn (fire-and-forget, session.send-style). Poll.
    for (let i = 0; i < 400 && !store.read(childId).some((e) => e.type === "turn_completed"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const childEvents = store.read(childId);
    expect(childEvents.some((e) => e.type === "user_message" && (e as Extract<SessionEvent, { type: "user_message" }>).text === "hello child")).toBe(true);
    expect(childEvents.some((e) => e.type === "assistant_message" && (e as Extract<SessionEvent, { type: "assistant_message" }>).text === "child replied")).toBe(true);
  });

  test("a NON-child session is refused", async () => {
    class P implements Provider {
      readonly id = "fake";
      targetOther!: string;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        yield sendMessage("m1", this.targetOther, "hi"); yield done("tool_calls");
      }
    }
    const provider = new P();
    const { engine, store, sessionId } = setupSend([], { provider });
    const otherCwd = mkChildCwd("nonchild");
    // NOT a child of sessionId — no parentSessionId set.
    const otherId = store.createSession("global", { cwd: otherCwd, mode: "code" });
    provider.targetOther = otherId;

    await engine.runTurn(sessionId);
    const result = toolResult(store.read(sessionId), "m1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatch(/not a session you spawned/i);
  });

  test("B cannot message A after A spawned B — loops are structurally impossible", async () => {
    class P implements Provider {
      readonly id = "fake";
      targetA!: string;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        yield sendMessage("mB", this.targetA, "hi parent"); yield done("tool_calls");
      }
    }
    const provider = new P();
    const { engine, store, sessionId: A } = setupSend([], { provider });
    const bCwd = mkChildCwd("loop-b");
    const B = store.createSession("global", { cwd: bCwd, mode: "code", parentSessionId: A });
    provider.targetA = A;

    // Drive B's OWN turn (B is a first-class session — its own main thread, depth 0, exactly like A).
    await engine.runTurn(B);
    const result = toolResult(store.read(B), "mB");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatch(/not a session you spawned/i);
  });

  test("self-targeting is refused", async () => {
    class P implements Provider {
      readonly id = "fake";
      targetSelf!: string;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        yield sendMessage("m1", this.targetSelf, "hi me"); yield done("tool_calls");
      }
    }
    const provider = new P();
    const { engine, store, sessionId } = setupSend([], { provider });
    provider.targetSelf = sessionId;

    await engine.runTurn(sessionId);
    const result = toolResult(store.read(sessionId), "m1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatch(/own session|yourself/i);
  });

  test("a mid-turn target queues as a steer and preserves tool_call/tool_result adjacency", async () => {
    let resolveChildInTool!: () => void;
    const childInTool = new Promise<void>((r) => { resolveChildInTool = r; });
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((r) => { releaseTool = r; });

    const registry = new ToolRegistry();
    registerSendMessageTool(registry);
    registry.register({
      name: "mcp__test__park",
      description: "test-only: parks inside executeCall until released",
      args: z.object({}),
      async run() { resolveChildInTool(); await toolReleased; return "parked-done"; },
    });

    class CombinedProvider implements Provider {
      readonly id = "fake";
      childId!: string;
      private parentRound = 0;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        const input = req.input;
        const isChild = input.some((it) => {
          const m = it as { type?: string; role?: string; content?: unknown };
          return m.type === "message" && m.role === "user" && m.content === "child-work";
        });
        if (isChild) {
          const last = lastUserOf(input);
          if (last === "INJECT-MSG") {
            yield { type: "text_delta", delta: "child saw the message" };
            yield done("end_turn");
            return;
          }
          yield { type: "tool_call", callId: "child-park", name: "mcp__test__park", argsJson: "{}" };
          yield done("tool_calls");
          return;
        }
        const n = this.parentRound++;
        if (n === 0) {
          await childInTool;
          yield sendMessage("m1", this.childId, "INJECT-MSG");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "parent done" }; yield done("end_turn");
      }
    }

    const provider = new CombinedProvider();
    // NOTE: setup() directly, not setupSend() — setupSend builds its OWN fresh registry (with only
    // send_message on it) and would discard our custom `registry` (which also carries the park tool).
    const { engine, store, sessionId: A } = setup([], { provider, registry });
    const bCwd = mkChildCwd("midturn");
    // approvalPolicy "auto" (store.createSession's own default is "ask") — needed so the mcp__
    // park tool runs directly via executeCall instead of stalling on an approval card (the gate
    // only blanket-allows an external/mcp__ name under "auto"; see gate.ts's `evaluate`).
    const B = store.createSession("global", { cwd: bCwd, mode: "code", approvalPolicy: "auto", parentSessionId: A });
    provider.childId = B;

    store.append(B, { type: "user_message", sessionId: B, threadId: "main", text: "child-work", clientName: "test" });
    const bTurn = engine.runTurn(B); // not awaited — parks mid-tool

    await childInTool;
    await engine.runTurn(A); // A's own turn: sends the message once B is confirmed mid-tool

    const aResult = toolResult(store.read(A), "m1");
    expect(aResult).toMatchObject({ isError: false });

    releaseTool();
    await bTurn;

    const bEvents = store.read(B);
    const callIdx = bEvents.findIndex((e) => e.type === "tool_call" && e.callId === "child-park");
    const resultIdx = bEvents.findIndex((e) => e.type === "tool_result" && e.callId === "child-park");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    // THE ASSERTION: tool_result immediately follows its tool_call in the PERSISTED log — the
    // injected message is never spliced between them (the exact corruption sendToThread's
    // persist-at-drain design was built to prevent for subagent threads, reused here for sessions).
    expect(resultIdx).toBe(callIdx + 1);
    const injectedIdx = bEvents.findIndex((e) => e.type === "user_message" && (e as Extract<SessionEvent, { type: "user_message" }>).text === "INJECT-MSG");
    expect(injectedIdx).toBeGreaterThan(resultIdx);
  });

  // session-activity-hygiene T8 (HARD pin, T3-review Important): the bridge's session-target branch
  // used to run a turn with ZERO knowledge of `archived` — a session could display "archived"
  // (hidden under its own tab) while actually burning tokens: the invisible-runner bug inverted.
  // The ruling is REFUSE: archived is a USER-visible hidden state, and silent resurrection by an
  // agent is worse than the original bug. These drive the ENGINE path (runTurn → the send_message
  // bridge), which is the ONLY seam that can see it — the attach-gated `session.send` RPC never
  // reaches an archived session at all (session.attach clears the flag first, T3).
  test("an ARCHIVED session-target is refused — no user_message is appended and no turn is started", async () => {
    class P implements Provider {
      readonly id = "fake";
      targetChild!: string;
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        yield sendMessage("m1", this.targetChild, "wake up"); yield done("tool_calls");
      }
    }
    const provider = new P();
    const { engine, store, sessionId } = setupSend([], { provider });
    const childCwd = mkChildCwd("archived");
    const childId = store.createSession("global", { cwd: childCwd, mode: "code", parentSessionId: sessionId });
    store.setArchived(childId, true);
    provider.targetChild = childId;

    await engine.runTurn(sessionId);
    const result = toolResult(store.read(sessionId), "m1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatch(/archived/i);
    // The remedy is named, and it is the DELIBERATE two-step (resume/background), never a silent
    // un-archive by the sender.
    expect(result?.output).toMatch(/manage_session|session\.setActivity/);

    // Settle any turn the pre-guard code would have started, then prove nothing happened at all.
    for (let i = 0; i < 40 && !store.read(childId).some((e) => e.type === "turn_completed"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const childEvents = store.read(childId);
    expect(childEvents.some((e) => e.type === "user_message")).toBe(false);
    expect(childEvents.some((e) => e.type === "turn_completed")).toBe(false);
    // And the flag is untouched — refusal never resurrects.
    expect(store.meta(childId).archived).toBe(true);
  });

  // session-activity-hygiene T8: the dispatch WIDENING. A dispatch-mode caller may message ANY
  // cowork/code session (the user ruling: dispatch manages the whole fleet, not just what it
  // started). Every OTHER caller keeps the direct-parent-edge rule verbatim — which is what keeps
  // inter-session loops structurally impossible outside the one coordinator that is a singleton and
  // is nobody's child.
  describe("dispatch widening (T8)", () => {
    /** A provider that sends ONE send_message on the next turn it is asked for, then behaves like a
     *  plain "say ok and stop" provider for every subsequent turn (including the TARGET's own). */
    class SendOnce implements Provider {
      readonly id = "fake";
      armed = false;
      to = "";
      callId = "m1";
      models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        if (this.armed) {
          this.armed = false;
          yield sendMessage(this.callId, this.to, "fleet message");
          yield done("tool_calls");
          return;
        }
        yield { type: "text_delta", delta: "ok" };
        yield done("end_turn");
      }
    }

    test("BOTH directions on one fixture: a dispatch caller reaches a session it never spawned; a code caller still cannot", async () => {
      const provider = new SendOnce();
      const { engine, store, cwd, sessionId: codeCaller } = setupSend([], { provider });
      // Nobody's child — no parentSessionId anywhere.
      const foreign = store.createSession("global", { cwd: mkChildCwd("foreign"), mode: "code", approvalPolicy: "auto" });
      const dispatchCaller = store.createSession("global", { cwd, mode: "dispatch", approvalPolicy: "auto" });

      // (1) CODE caller → refused, with today's exact wording (the untouched half).
      provider.armed = true; provider.to = foreign; provider.callId = "code-call";
      await engine.runTurn(codeCaller);
      const codeResult = toolResult(store.read(codeCaller), "code-call");
      expect(codeResult?.isError).toBe(true);
      expect(codeResult?.output).toBe(`session '${foreign}' is not a session you spawned`);
      expect(store.read(foreign).some((e) => e.type === "user_message")).toBe(false);

      // (2) DISPATCH caller → delivered, on the SAME session the code caller was just refused.
      provider.armed = true; provider.to = foreign; provider.callId = "disp-call";
      await engine.runTurn(dispatchCaller);
      const dispResult = toolResult(store.read(dispatchCaller), "disp-call");
      expect(dispResult).toMatchObject({ isError: false });
      for (let i = 0; i < 400 && !store.read(foreign).some((e) => e.type === "turn_completed"); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const foreignEvents = store.read(foreign);
      expect(foreignEvents.some((e) => e.type === "user_message" && (e as Extract<SessionEvent, { type: "user_message" }>).text === "fleet message")).toBe(true);
    });

    test("a chat session-target is refused even for dispatch — chat and dispatch have no lifecycle to manage", async () => {
      const provider = new SendOnce();
      const { engine, store, cwd } = setupSend([], { provider });
      const chat = store.createSession("global", { cwd: mkChildCwd("chat"), mode: "chat", approvalPolicy: "auto" });
      const dispatchCaller = store.createSession("global", { cwd, mode: "dispatch", approvalPolicy: "auto" });

      provider.armed = true; provider.to = chat; provider.callId = "c1";
      await engine.runTurn(dispatchCaller);
      const result = toolResult(store.read(dispatchCaller), "c1");
      expect(result?.isError).toBe(true);
      expect(result?.output).toMatch(/code and cowork sessions/i);
      expect(store.read(chat).some((e) => e.type === "user_message")).toBe(false);
    });

    test("the ARCHIVED refusal binds the widened path too — a dispatch caller cannot resurrect a foreign archived session", async () => {
      const provider = new SendOnce();
      const { engine, store, cwd } = setupSend([], { provider });
      const foreign = store.createSession("global", { cwd: mkChildCwd("arch-foreign"), mode: "code", approvalPolicy: "auto" });
      store.setArchived(foreign, true);
      const dispatchCaller = store.createSession("global", { cwd, mode: "dispatch", approvalPolicy: "auto" });

      provider.armed = true; provider.to = foreign; provider.callId = "a1";
      await engine.runTurn(dispatchCaller);
      const result = toolResult(store.read(dispatchCaller), "a1");
      expect(result?.isError).toBe(true);
      expect(result?.output).toMatch(/archived/i);
      expect(store.read(foreign).some((e) => e.type === "user_message")).toBe(false);
      expect(store.meta(foreign).archived).toBe(true);
    });

    test("the AGENT half is untouched: a dispatch caller cannot address another session's subagent", async () => {
      const provider = new SendOnce();
      const { engine, store, cwd } = setupSend([], { provider });
      const dispatchCaller = store.createSession("global", { cwd, mode: "dispatch", approvalPolicy: "auto" });

      // A thread id shaped like a real agent's, belonging to nobody this caller started — agent
      // resolution is still per-session (bgAgents.get(to, sessionId)), so it falls through to
      // SESSION resolution and dies there rather than becoming reachable via the widening.
      provider.armed = true; provider.to = "th_someone_elses_agent"; provider.callId = "g1";
      await engine.runTurn(dispatchCaller);
      const result = toolResult(store.read(dispatchCaller), "g1");
      expect(result?.isError).toBe(true);
      expect(result?.output).toBe("no agent or session 'th_someone_elses_agent' to message");
    });
  });

  test("unknown session id and an already-ended child each get a distinct, actionable message", async () => {
    // (a) unknown id: never a real agent, name, or session.
    {
      const { engine, store, sessionId } = setupSend([
        [sendMessage("m1", "s_doesnotexist", "hi"), done("tool_calls")],
        text("parent noted the error"),
      ]);
      await engine.runTurn(sessionId);
      const result = toolResult(store.read(sessionId), "m1");
      expect(result?.isError).toBe(true);
      expect(result?.output).toBe("no agent or session 's_doesnotexist' to message");
    }

    // (b) an authorized child whose working directory does not exist on disk. Fix round 1
    // (Important): this does NOT assert the session "already ended" — `existsSync` only measures
    // "workspace present right now", which cannot distinguish "finished and cleaned up" (sessions
    // are never worktree-isolated and Norma never removes a session's cwd) from "the model gave
    // session_spawn a typo'd/never-existent path" (session_spawn validates only `startsWith("/")`,
    // never existence). The refusal is about the missing directory only, not about the session's
    // history.
    {
      class P implements Provider {
        readonly id = "fake";
        targetChild!: string;
        models(): ModelInfo[] { return [{ id: "fake-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
        async *streamTurn(): AsyncIterable<ProviderEvent> {
          yield sendMessage("m2", this.targetChild, "hi"); yield done("tool_calls");
        }
      }
      const provider = new P();
      const { engine, store, sessionId } = setupSend([], { provider });
      const childCwd = mkChildCwd("missing-cwd");
      const childId = store.createSession("global", { cwd: childCwd, mode: "code", parentSessionId: sessionId });
      rmSync(childCwd, { recursive: true, force: true }); // the directory no longer exists on disk
      provider.targetChild = childId;

      await engine.runTurn(sessionId);
      const result = toolResult(store.read(sessionId), "m2");
      expect(result?.isError).toBe(true);
      expect(result?.output).toBe(`session '${childId}' cannot be messaged — its working directory (${childCwd}) does not exist`);
      expect(result?.output).not.toBe("no agent or session 's_doesnotexist' to message");
    }
  });
});
