import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../../src/agent/fake-provider";
import { setupEngine } from "./engine-steer.test";
import { setup as setupSpawn } from "./engine-spawn.test";
import type { ProviderEvent } from "../../src/providers/types";
import { CLIENT_EFFORTS, REASONING_EFFORTS } from "../../src/settings";

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
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10, contextTokens: 900 }); // 900 > 750

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

  // Renamed in the whole-branch fix round (T1 review M1): the old name claimed to cover the
  // `!meta.cwd` short-circuit path, but session B is created WITH a cwd two lines down and nothing
  // here touches that branch. The name now says what the body — and its own doc comment — do.
  test("an override is scoped to its own sessionId — a second session on the same engine is unaffected", async () => {
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

  // I1 review fix: session.setModel validates a NEW override at set time (ipc/server.ts), but
  // `store.setModel` itself (this test drives it directly, bypassing the RPC) does not — and even
  // a validly-set override can go stale later (a provider swap, or the provider's own models()
  // list losing an id). Without this fix, contextWindow(model) would return Infinity for an
  // unrecognized override, silently disabling auto-compact for the rest of the session. Mirrors
  // "a live() model change is reflected in the SAME turn's auto-compact contextWindow check" above,
  // but the override here is NOT one of provider.models() — proving the fallback to the live/boot
  // default's contextWindow, not Infinity.
  test("an override the CURRENT provider doesn't recognize never disables auto-compact (contextWindow falls back to the live/boot model's, not Infinity)", async () => {
    const SMALL_MODEL = { id: "live-small", family: "fake", contextWindow: 1000, supportsVision: false };
    const provider = new FakeProvider(
      [
        [{ type: "text_delta", delta: "SUMMARY_TOKEN" }, done("end_turn")], // the compaction's own streamTurn
        text("ok"), // the actual turn's streamTurn
      ],
      [SMALL_MODEL], // known models — does NOT include the stale override below
    );
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-small" }) });
    store.setModel(sessionId, "stale-override-not-in-known-models");
    for (let i = 0; i < 5; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10, contextTokens: 900 }); // 900 > 750

    await engine.runTurn(sessionId);

    const checkpoint = store.read(sessionId).find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeDefined(); // auto-compact fired — contextWindow fell back to live-small's 1000, not Infinity
    // sel.model itself is UNCHANGED by this fix — the turn still attempts the raw override (the
    // handler-side I1 validation is what should have prevented this at set time; this test proves
    // the defense-in-depth for a value that reached resolveSel anyway never breaks auto-compact).
    expect(provider.requests[1]!.model).toBe("stale-override-not-in-known-models");
  });

  // Control: when the provider CANNOT enumerate its models at all (empty models()), there is no
  // sane fallback to use either — contextWindow legitimately stays Infinity, exactly the
  // pre-existing documented behavior for an unenumerable provider (unchanged by this fix).
  test("an unrecognized override still yields Infinity (no auto-compact) when the provider can't enumerate ANY models — unchanged pre-existing behavior", async () => {
    const provider = new FakeProvider(
      [
        text("ok"), // no compaction streamTurn scripted — compaction must NOT fire
      ],
      [], // empty models() — provider can't enumerate anything, override or not
    );
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model" }) });
    store.setModel(sessionId, "some-override");
    for (let i = 0; i < 5; i++) {
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: `u${i}`, clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `a${i}` });
    }
    store.append(sessionId, { type: "turn_completed", sessionId, threadId: "main", stopReason: "end_turn", inputTokens: 900, outputTokens: 10, contextTokens: 900 });

    await engine.runTurn(sessionId);

    const checkpoint = store.read(sessionId).find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeUndefined(); // Infinity threshold — never compacts, same as before this fix
    expect(provider.requests[0]!.model).toBe("some-override"); // the turn itself still ran with the raw override
  });
});

// provider-correctness T4: session.setEffort/store.setEffort's per-SESSION reasoning-effort
// override, resolved at the SAME single `resolveSel` point as the model above — precedence
// `meta.effort` → the global default (live()'s reasoningEffort, or nothing when no live() is
// wired). The two axes are INDEPENDENT: overriding one never disturbs the other, which is exactly
// why this is its own RPC rather than a second argument on session.setModel.
describe("per-session effort override (provider-correctness T4: meta.effort wins over live()/global)", () => {
  test("a session WITHOUT an effort uses the global default (control) — same engine, same live()", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "medium" }) });
    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("medium");
  });

  test("store.setEffort overrides live()'s reasoningEffort for THIS session, but leaves the model untouched", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "medium" }) });
    store.setEffort(sessionId, "xhigh");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("xhigh");
    expect(provider.requests[0]!.model).toBe("live-model"); // untouched — only `reasoningEffort` is overridden
  });

  test("store.setEffort supplies an effort even when the GLOBAL has none (no live() wired at all)", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider); // no `live` opt — boot snapshot carries model only
    store.setEffort(sessionId, "high");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("high");
    expect(provider.requests[0]!.model).toBe("gated-1"); // the boot-snapshot model, unchanged
  });

  test("store.setEffort(sessionId, null) clears the override — the NEXT turn falls back to the global again", async () => {
    const provider = new FakeProvider([text("first"), text("second")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "m", reasoningEffort: "low" }) });
    store.setEffort(sessionId, "max");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("max");

    store.setEffort(sessionId, null);
    await engine.runTurn(sessionId);
    expect(provider.requests[1]!.reasoningEffort).toBe("low");
  });

  test("clearing an effort when the global has NONE leaves the field absent (never an empty string)", async () => {
    const provider = new FakeProvider([text("first"), text("second")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "m" }) }); // global effort unset
    store.setEffort(sessionId, "max");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("max");

    store.setEffort(sessionId, null);
    await engine.runTurn(sessionId);
    expect(provider.requests[1]!.reasoningEffort).toBeUndefined();
  });

  test("an override is scoped to its own sessionId — a second session on the same engine is unaffected", async () => {
    const provider = new FakeProvider([text("a"), text("b")]);
    const { engine, store, sessionId: sessionA, cwd } = setupEngine(provider, { live: () => ({ model: "m", reasoningEffort: "low" }) });
    const sessionB = store.createSession("global", { cwd });
    store.setEffort(sessionA, "max");

    await engine.runTurn(sessionA);
    await engine.runTurn(sessionB);
    expect(provider.requests[0]!.reasoningEffort).toBe("max");
    expect(provider.requests[1]!.reasoningEffort).toBe("low"); // session B never had an override
  });

  // The two axes are orthogonal: a session can override BOTH, and each keeps its own precedence.
  test("model and effort override INDEPENDENTLY on the same session", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "low" }) });
    store.setModel(sessionId, "session-model");
    store.setEffort(sessionId, "max");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.model).toBe("session-model");
    expect(provider.requests[0]!.reasoningEffort).toBe("max");
  });

  test("subagents inherit the SESSION-resolved effort, not the global one", async () => {
    // Same shape as the live()-effort inheritance test above (run_in_background:false so
    // requests[1] is the CHILD's own synchronous round) — but the effort under test is the
    // per-session override, proving resolveSel's result is what the spawn bridge inherits.
    const spawnCall: ProviderEvent = { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task", run_in_background: false }) };
    const provider = new FakeProvider([
      [spawnCall, done("tool_calls")],
      text("child report"),
    ]);
    const { engine, store, sessionId } = setupSpawn(
      [],
      { provider, live: () => ({ model: "live-model", reasoningEffort: "low" }) },
    );
    store.setEffort(sessionId, "xhigh");
    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    expect(fp.requests[0]!.reasoningEffort).toBe("xhigh"); // parent round
    expect(fp.requests[1]!.reasoningEffort).toBe("xhigh"); // the child inherits the same resolved effort
  });
});

// ================================================================================================
// provider-correctness T5 — `ultra`, a NORMA-LEVEL tier that must never reach the wire.
//
// Every assertion here is made at the REQUEST LAYER (`FakeProvider.requests[n]`), never at the
// mapping function. That is the point: the claim is not "resolveSel translates correctly", it is
// "no hop between a stored selection and the HTTP body can reintroduce the tier" — and only the
// request the provider actually receives can prove that. `ultra` is refused by a GLOBAL enum on the
// backend, so a single leaking hop is an opaque 400 on every turn of that session.
//
// The store is written DIRECTLY here (`store.setEffort`), deliberately bypassing `session.setEffort`
// and its mode gate: the non-code cases below are reachable in production only by a fork or a
// hand-edited index, and this layer must hold for them anyway (defense in depth #2 — refused at the
// door, inert at the slot).
// ================================================================================================
describe("ultra is translated before the wire (provider-correctness T5)", () => {
  const POSTURE = "## Ultra effort";

  test("a CODE session at `ultra` puts `max` on the wire — the tier itself never leaves the daemon", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "low" }) });
    store.setEffort(sessionId, "ultra");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("max");
    expect(provider.requests[0]!.reasoningEffort).not.toBe("ultra");
    // The STORED value is untouched: a tier is the user's selection, not a wire value, and silently
    // rewriting it to `max` would make the picker unable to show what they actually chose.
    expect(store.meta(sessionId).effort).toBe("ultra");
  });

  test("...and the delegation posture rides in THIS turn's instructions", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model" }) });
    store.setEffort(sessionId, "ultra");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.instructions).toContain(POSTURE);
  });

  test("plain `max` gets NO posture — the injection keys off the TIER, not the wire value it maps to", async () => {
    // The distinction the whole design rests on. Both selections put `max` on the wire; only one of
    // them is a request for the tier's behaviour. If this ever went green for `max`, `resolveSel`
    // would be reading the translated value back instead of remembering what was chosen.
    const provider = new FakeProvider([text("ok")]);
    const { engine, store, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model" }) });
    store.setEffort(sessionId, "max");

    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.reasoningEffort).toBe("max");
    expect(provider.requests[0]!.instructions).not.toContain(POSTURE);
  });

  test("a session with NO effort gets no posture (control)", async () => {
    const provider = new FakeProvider([text("ok")]);
    const { engine, sessionId } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "high" }) });
    await engine.runTurn(sessionId);
    expect(provider.requests[0]!.instructions).not.toContain(POSTURE);
  });

  for (const mode of ["chat", "dispatch"] as const) {
    test(`a ${mode.toUpperCase()} session carrying ultra still sends max and injects NOTHING`, async () => {
      // Unreachable through `session.setEffort` (it refuses the tier for these modes) — reachable by
      // a fork or a hand-edited store, which is exactly why the engine cannot rely on the door.
      const provider = new FakeProvider([text("ok")]);
      const { engine, store, cwd } = setupEngine(provider, { live: () => ({ model: "live-model", reasoningEffort: "low" }) });
      const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto", mode });
      store.setEffort(sessionId, "ultra");

      await engine.runTurn(sessionId);
      expect(provider.requests[0]!.reasoningEffort).toBe("max");   // still translated — never on the wire
      expect(provider.requests[0]!.instructions).not.toContain(POSTURE); // but inert
    });
  }

  test("a subagent inherits the TRANSLATED effort — the child's own request never carries the tier either", async () => {
    // Same shape as the T4 inheritance test above (run_in_background:false so requests[1] is the
    // CHILD's own synchronous round). The child is a second, independent hop to the provider.
    const spawnCall: ProviderEvent = { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task", run_in_background: false }) };
    const provider = new FakeProvider([
      [spawnCall, done("tool_calls")],
      text("child report"),
    ]);
    const { engine, store, sessionId } = setupSpawn([], { provider, live: () => ({ model: "live-model", reasoningEffort: "low" }) });
    store.setEffort(sessionId, "ultra");

    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    expect(fp.requests[0]!.reasoningEffort).toBe("max"); // parent round
    expect(fp.requests[1]!.reasoningEffort).toBe("max"); // the child, one more hop away
  });

  test("NO request the provider ever sees carries a Norma-level tier — swept across every recorded hop", async () => {
    // The catch-all — scoped honestly (T5 review, Minor): it sweeps every request RECORDED BY THE
    // FLOWS THIS TEST DRIVES (one turn + one synchronous spawn child). A call path it never drives
    // (e.g. runWorkflowAgent) contributes no request here and is NOT covered by this sweep. The
    // real guarantee that no path can leak a tier is structural, pinned elsewhere: wireEffort's
    // totality (settings.test.ts) + resolveSel being the sole meta.effort -> reasoningEffort path.
    const spawnCall: ProviderEvent = { type: "tool_call", callId: "s1", name: "spawn_agent", argsJson: JSON.stringify({ prompt: "do X", description: "test task", run_in_background: false }) };
    const provider = new FakeProvider([[spawnCall, done("tool_calls")], text("child report")]);
    const { engine, store, sessionId } = setupSpawn([], { provider, live: () => ({ model: "live-model" }) });
    store.setEffort(sessionId, "ultra");

    await engine.runTurn(sessionId);
    const fp = provider as FakeProvider;
    expect(fp.requests.length).toBeGreaterThan(1);
    for (const req of fp.requests) {
      expect(CLIENT_EFFORTS as readonly string[]).not.toContain(req.reasoningEffort ?? "");
      expect(REASONING_EFFORTS as readonly string[]).toContain(req.reasoningEffort!);
    }
  });
});
