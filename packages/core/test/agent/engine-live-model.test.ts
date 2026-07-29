import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { setup as setupSpawn } from "./engine-spawn.test";
import type { ProviderEvent } from "../../src/providers/types";

const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

// Task 4e-fix2 key test (1): "engine turn N uses model A, settings edited on disk, turn N+1
// uses model B with NO reconstruction" — the daemon-restart-avoidance requirement. Modeled here
// with a directly-injected `live` closure (per the advisor's guidance: exercise the ENGINE
// contract — it calls live() once per turn and uses the result — with a trivial deterministic
// double; the real mtime-cached settings.json resolver is covered separately in manager.test.ts).
describe("engine live model resolution (no daemon restart)", () => {
  test("turn N uses model A; the live() result changes; turn N+1 uses model B — same engine instance", async () => {
    const provider = new FakeProvider([text("first"), text("second")]);
    let current = "model-A";
    const { engine, sessionId } = setupEngine(provider, { live: () => ({ model: current }) });

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("model-A");

    // Simulate a settings.json edit landing between turns — no engine reconstruction happens.
    current = "model-B";

    await engine.runTurn(sessionId);
    expect(provider.requests[1]!.model).toBe("model-B");
  });

  test("no live wired -> every turn keeps using the boot-snapshot model (unchanged behavior)", async () => {
    const provider = new FakeProvider([text("first"), text("second")]);
    const { engine, sessionId } = setupEngine(provider); // no `live` opt

    await engine.runTurn(sessionId);
    await engine.runTurn(sessionId);

    expect(provider.requests[0]!.model).toBe("gated-1");
    expect(provider.requests[1]!.model).toBe("gated-1");
  });

  test("reasoningEffort from live() is threaded into the TurnRequest; absent -> field is absent", async () => {
    const withEffort = new FakeProvider([text("ok")]);
    const { engine: e1, sessionId: s1 } = setupEngine(withEffort, { live: () => ({ model: "m", reasoningEffort: "xhigh" }) });
    await e1.runTurn(s1);
    expect(withEffort.requests[0]!.reasoningEffort).toBe("xhigh");

    const noEffort = new FakeProvider([text("ok")]);
    const { engine: e2, sessionId: s2 } = setupEngine(noEffort, { live: () => ({ model: "m" }) });
    await e2.runTurn(s2);
    expect(noEffort.requests[0]!.reasoningEffort).toBeUndefined();
  });

  test("a live() model change is reflected in the SAME turn's auto-compact contextWindow check, not the boot model's", async () => {
    // SMALL_MODEL mirrors engine-compaction.test.ts's pattern: contextWindow 1000, threshold =
    // 1000 * 0.75 (default NORMA_COMPACT_THRESHOLD_FRAC) = 750.
    const SMALL_MODEL = { id: "live-small", family: "fake", contextWindow: 1000, supportsVision: false };
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, done("end_turn")], // the compaction's own streamTurn
        text("ok"), // the actual turn's streamTurn
      ],
      [SMALL_MODEL],
    );
    // live() resolves to "live-small" — a model the boot snapshot ("gated-1") does NOT name, so
    // this only compacts if contextWindow() is keyed off the LIVE-resolved model, not the boot one.
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-small" }) });
    for (let i = 0; i < 5; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10 }); // 900 > 750

    await engine.runTurn(sessionId);

    const checkpoint = store.read(sessionId).find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeDefined();
  });

  test("subagents inherit the PARENT thread's live-resolved reasoningEffort (no per-agent-def override)", async () => {
    // 5a: run_in_background:false — this test relies on fp.requests[1] being the CHILD's own
    // (synchronous) round; depth 0 now backgrounds by default, which would make requests[1] the
    // parent's own continuation instead.
    const spawnCall: ProviderEvent = { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task", run_in_background: false }) };
    const provider = new FakeProvider([
      [spawnCall, done("tool_calls")],
      text("child report"),
    ]);
    const { engine, sessionId } = setupSpawn(
      [], // script unused — opts.provider overrides it
      { provider, live: () => ({ model: "live-model", reasoningEffort: "max" }) },
    );
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    // request 0: parent round (spawn call) — model/effort from live()
    expect(fp.requests[0]!.model).toBe("live-model");
    expect(fp.requests[0]!.reasoningEffort).toBe("max");
    // request 1: the child thread's own request — inherits the SAME effort, no def override
    expect(fp.requests[1]!.model).toBe("live-model");
    expect(fp.requests[1]!.reasoningEffort).toBe("max");
  });
});

// Chat Slice D task 1: session.setModel/store.setModel's per-SESSION model override, threaded
// through AgentEngine's resolveSel — the SAME "once per turn" resolution point the tests above pin
// for live()/the boot snapshot. meta.model, when set, wins over whichever of those two would
// otherwise be chosen; it never touches reasoningEffort (a completely separate axis).
describe("per-session model override (Chat Slice D task 1: meta.model wins over live()/boot)", () => {
  test("a session WITHOUT a model uses the live() default (control) — same engine, same live()", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "high" }) });
    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("live-model");
    expect(provider.requests[0]!.reasoningEffort).toBe("high");
  });

  test("store.setModel overrides live()'s model for THIS session, but leaves reasoningEffort untouched", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "high" }) });
    store.setModel(sessionId, "session-override-model");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("session-override-model");
    expect(provider.requests[0]!.reasoningEffort).toBe("high"); // untouched — only `model` is overridden
  });

  test("store.setModel overrides the BOOT-SNAPSHOT model when no live() is wired", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider); // no `live` opt — boot model is "gated-1"
    store.setModel(sessionId, "session-override-model");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("session-override-model");
  });

  test("store.setModel(sessionId, null) clears the override — the NEXT turn falls back to the default again", async () => {
    const provider = new FakeProvider([text("first"), text("second")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model" }) });
    store.setModel(sessionId, "session-override-model");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("session-override-model");

    store.setModel(sessionId, null);
    await engine.runTurn(sessionId);
    expect(provider.requests[1]!.model).toBe("live-model");
  });

  test("a session with NO cwd (turn short-circuits before resolveSel matters) still runs unaffected by an override on ANOTHER session", async () => {
    // Control proving the override is scoped to the exact sessionId it was set on, not global
    // state: a second session (different sessionId, same engine/provider) never sees session A's
    // override.
    const provider = new FakeProvider([text("a"), text("b")]);
    const { engine, store, sessionId: sessionA, cwd } = setupEngine(provider, { live: () => ({ model: "live-model" }) });
    const sessionB = store.createSession("global", { cwd });
    store.setModel(sessionA, "override-for-a-only");

    await engine.runTurn(sessionA);
    await engine.runTurn(sessionB);
    expect(provider.requests[0]!.model).toBe("override-for-a-only");
    expect(provider.requests[1]!.model).toBe("live-model"); // session B never had an override
  });
});
