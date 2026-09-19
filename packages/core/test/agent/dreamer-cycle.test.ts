import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { Dreamer, DREAM_INSTRUCTION, DREAM_MIN_EVENTS, DREAM_MIN_SPACING_MS, DREAM_EFFORT, DREAM_WINDOW_MAX_CHARS } from "../../src/agent/dreamer";
import { pinsFor, ownProviderFor, Settings } from "../../src/settings";
import { splitTag } from "../../src/runtime-sdk/model-tag";
import { RoleHealthRegistry } from "../../src/providers/role-health";

// WS-20: `DREAM_MODEL` is deleted — the model is now `pinsFor(settings).dream`, live per tick
// (dreamer.ts). Every `new Dreamer(...)` fixture in this file passes `settings: () => null`, so
// this is the SAME value production falls back to on a daemon with no settings loaded at all
// (`pinsFor`'s own `DEFAULT_PROVIDER`-rooted default) — computed here rather than hand-copied so a
// future default-rule change can't silently desync this expectation from the real one.
const DREAM_MODEL_UNDER_TEST = splitTag(pinsFor(null).dream).modelId;

/** A real temp store with a dispatch session (the sole session `dispatchSessionId()` finds) —
 *  same fixture shape across all 8 cases; individual tests append whatever events/memory files
 *  they need on top. */
function setup(prefix: string): { home: string; store: SessionStore; dispatchId: string; dir: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const store = new SessionStore(home);
  const dispatchId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
  const dir = join(home, "memory");
  return { home, store, dispatchId, dir };
}

/** Pads the dispatch log with `n` generic substantive (user_message) events so the
 *  DREAM_MIN_EVENTS gate is satisfied without interfering with a test's own signal events. */
function fillSubstantive(store: SessionStore, sid: string, n: number): void {
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `filler message ${i}`, clientName: "test" });
  }
}

function okProvider(delta = '{"ops":[]}'): FakeProvider {
  return new FakeProvider([[{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }]]);
}

function firstInputContent(provider: FakeProvider): string {
  const input = provider.requests[0]!.input;
  expect(input).toHaveLength(1);
  return (input[0] as { content: string }).content;
}

describe("Dreamer.tick", () => {
  test("1) event filtering: window carries only user_message/assistant_message/child_update text, never tool/reasoning/harness noise", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-filter-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS - 3);
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "my name is Alex", clientName: "test" });
    store.append(dispatchId, { type: "assistant_message", sessionId: dispatchId, threadId: "main", text: "noted" });
    store.append(dispatchId, {
      type: "child_update", sessionId: dispatchId, threadId: "main", childSessionId: "s_child",
      status: "completed", title: "build the site", resultSummary: "built the site",
    });
    // Noise: none of this may leak into the window text.
    store.append(dispatchId, { type: "tool_call", sessionId: dispatchId, threadId: "main", callId: "c1", name: "bash", argsJson: "{}" });
    store.append(dispatchId, { type: "tool_result", sessionId: dispatchId, threadId: "main", callId: "c1", output: "SECRET_TOOL_OUTPUT", isError: false });
    store.append(dispatchId, { type: "reasoning_item", sessionId: dispatchId, threadId: "main", itemJson: '{"reasoning":"hidden chain of thought"}' });
    store.append(dispatchId, { type: "harness_attached", sessionId: dispatchId, clientName: "cli" });

    const provider = okProvider();
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "ignored" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(1);
    const content = firstInputContent(provider);
    expect(content).toContain("my name is Alex");
    expect(content).toContain("noted");
    expect(content).toContain("built the site");
    expect(content).not.toContain("SECRET_TOOL_OUTPUT");
    expect(content).not.toContain("reasoning");
    expect(content).not.toContain("harness_attached");
  });

  test("2) request shape: hardcoded model/effort, no tools, exact instruction text", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-shape-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider();
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "some-other-model" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.model).toBe(DREAM_MODEL_UNDER_TEST);
    expect(req.reasoningEffort).toBe(DREAM_EFFORT);
    expect(req.tools).toEqual([]);
    expect(req.instructions).toBe(DREAM_INSTRUCTION);
  });

  test("3) prompt carries state: memory file content, tombstones, and today's date (from injected now()) all appear", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-state-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alex.md"), "Alex builds Winter.\n");
    writeFileSync(join(dir, "MEMORY.md"), "# Assistant memory index\n\n- [alex](alex.md) — Alex builds Winter.\n");
    writeFileSync(join(dir, "tombstones.md"), "- never remember the user's address\n");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const fixedNow = new Date("2026-07-18T12:00:00Z").getTime();
    const provider = okProvider();
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();

    const content = firstInputContent(provider);
    expect(content).toContain("Alex builds Winter.");
    expect(content).toContain("never remember the user's address");
    expect(content).toContain("2026-07-18");
  });

  test("4) ops applied + watermark: write op lands on disk, MEMORY.md lists it, watermarkSeq === lastSeq, lastDreamAt === now()", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-apply-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const opsJson = JSON.stringify({
      ops: [{ op: "write", file: "alex.md", content: "---\nrevised: 2026-07-18\n---\nAlex builds Winter." }],
    });
    const fixedNow = 1_753_000_000_000;
    const provider = okProvider(opsJson);
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();

    expect(readFileSync(join(dir, "alex.md"), "utf8")).toBe("---\nrevised: 2026-07-18\n---\nAlex builds Winter.");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("alex.md");
    const state = JSON.parse(readFileSync(join(dir, "dream-state.json"), "utf8")) as { watermarkSeq: number; lastDreamAt: number };
    expect(state.watermarkSeq).toBe(store.lastSeq(dispatchId));
    expect(state.lastDreamAt).toBe(fixedNow);
  });

  test("5) empty ops is a valid dream: no memory content file written, watermark still advances", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-empty-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider('{"ops":[]}');
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    const filesAfter = existsSync(dir) ? readdirSync(dir) : [];
    expect(filesAfter.filter((f) => f.endsWith(".md") && f !== "MEMORY.md")).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(dir, "dream-state.json"), "utf8")) as { watermarkSeq: number; lastDreamAt: number };
    expect(state.watermarkSeq).toBe(store.lastSeq(dispatchId));
  });

  test("6) malformed (no JSON) response: watermark not advanced, no files written, tick does not throw", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-malformed-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const provider = okProvider("I have nothing worth keeping today.");
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await expect(dreamer.tick()).resolves.toBeUndefined();
    expect(existsSync(join(dir, "dream-state.json"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("7) invalid ops (13 ops, over MAX_OPS): watermark not advanced", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-invalidops-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);

    const tooMany = { ops: Array.from({ length: 13 }, (_, i) => ({ op: "tombstone", text: `t${i}` })) };
    const provider = okProvider(JSON.stringify(tooMany));
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    expect(existsSync(join(dir, "dream-state.json"))).toBe(false);
  });

  test("8) window cap: transcript is trimmed to DREAM_WINDOW_MAX_CHARS, marked, and drops the OLDEST content first", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-cap-");
    const big = "x".repeat(5000);
    for (let i = 0; i < 50; i++) {
      store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: `${big}-${i}`, clientName: "test" });
    }

    const provider = okProvider();
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();

    const content = firstInputContent(provider);
    expect(content).toContain("[earlier events trimmed]");
    // Well under the raw ~250,000 chars of seeded messages -> the cap actually took effect.
    expect(content.length).toBeLessThan(DREAM_WINDOW_MAX_CHARS + 1000);
    // Oldest trimmed away, newest survives -> trims OLDEST, not newest.
    expect(content).not.toContain(`${big}-0`);
    expect(content).toContain(`${big}-49`);
  });
});

// 2026-09-18: `settings.roleEfforts["pins.dream"]` — the role's stored effort, spent on the dream
// request. Asserted on the OUTGOING `TurnRequest` (what the provider is actually handed), never on
// the resolver: `effortToSpendForRole` has its own unit tests in settings.test.ts.
describe("Dreamer: the pins.dream role effort", () => {
  const settingsOf = (over: Record<string, unknown>): Settings =>
    Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over });

  async function dreamOnce(settings: Settings | null) {
    const { store, dispatchId, dir } = setup("winter-dreamer-effort-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = okProvider();
    await new Dreamer({ settings: () => settings, provider: { provider, model: "x" }, store, dir: () => dir, enabled: () => true, activeTurnCount: () => 0 }).tick();
    expect(provider.requests).toHaveLength(1);
    return provider.requests[0]!;
  }

  test("absent → DREAM_EFFORT, raw, exactly as before (a settings file with no roleEfforts is not a change)", async () => {
    expect((await dreamOnce(settingsOf({}))).reasoningEffort).toBe(DREAM_EFFORT);
    // Raw even on a pin whose row lists no efforts at all: the default was never mapped, and still is not.
    expect((await dreamOnce(settingsOf({ pins: { dream: "openai/gpt-5.4" } }))).reasoningEffort).toBe(DREAM_EFFORT);
  });

  test("a stored effort the pin's model offers reaches the request", async () => {
    const req = await dreamOnce(settingsOf({ roleEfforts: { "pins.dream": "high" } }));
    expect(req.reasoningEffort).toBe("high");
    expect(req.model).toBe(splitTag(pinsFor(settingsOf({})).dream).modelId);
  });

  test("a stored effort the pin's model does NOT offer is mapped or omitted — the dream still runs", async () => {
    // o4-mini: low/medium/high, defaultEffort medium → `max` maps onto the row's own default.
    const mapped = await dreamOnce(settingsOf({ pins: { dream: "openai/o4-mini" }, roleEfforts: { "pins.dream": "max" } }));
    expect(mapped.model).toBe("o4-mini");
    expect(mapped.reasoningEffort).toBe("medium");
    // gpt-5.4: no vocabulary → the request carries NO effort key at all (not DREAM_EFFORT: the user overrode it).
    const omitted = await dreamOnce(settingsOf({ pins: { dream: "openai/gpt-5.4" }, roleEfforts: { "pins.dream": "high" } }));
    expect(omitted.model).toBe("gpt-5.4");
    expect("reasoningEffort" in omitted).toBe(false);
  });

  test("a stored \"none\" is sent verbatim — the internal Provider's own meaning of it (RESEARCH_EFFORT's), never remapped to the row default", async () => {
    expect((await dreamOnce(settingsOf({ roleEfforts: { "pins.dream": "none" } }))).reasoningEffort).toBe("none");
  });

  test("a settings change lands on the NEXT cycle of the SAME Dreamer — no restart, no re-construction", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-effort-live-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = new FakeProvider([[{ type: "text_delta", delta: '{"ops":[]}' }, { type: "done", stopReason: "end_turn" }]]);
    let live: Settings = settingsOf({});
    let clock = 10 * DREAM_MIN_SPACING_MS;
    const dreamer = new Dreamer({ settings: () => live, provider: { provider, model: "x" }, store, dir: () => dir, enabled: () => true, activeTurnCount: () => 0, now: () => clock });
    await dreamer.tick();
    live = settingsOf({ roleEfforts: { "pins.dream": "xhigh" } });
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    clock += DREAM_MIN_SPACING_MS + 1;
    await dreamer.tick();
    live = settingsOf({});
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    clock += DREAM_MIN_SPACING_MS + 1;
    await dreamer.tick();
    expect(provider.requests.map((r) => r.reasoningEffort)).toEqual([DREAM_EFFORT, "xhigh", DREAM_EFFORT]);
  });
});

describe("Dreamer role-health wiring (2026-09-18) — observation only", () => {
  test("a provider error records pins.dream under the tag that actually ran; a later success clears it; the throw/log shape is unchanged", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-rolehealth-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dreamer-rh-home-")));
    const failing = new FakeProvider([[{ type: "error", code: "rate_limit", providerCode: "usage_limit_reached", message: "429" }]]);
    const dreamer = new Dreamer({
      settings: () => null, provider: { provider: failing, model: "ignored" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, roleHealth,
    });
    // Unchanged existing behaviour: tick() itself never throws (the scheduler precedent) — the
    // thrown "provider error: 429" is caught and logged inside tick, not surfaced here.
    await expect(dreamer.tick()).resolves.toBeUndefined();

    const expectedTag = `${ownProviderFor(null)}/${DREAM_MODEL_UNDER_TEST}`;
    const problem = roleHealth.problemFor("pins.dream", expectedTag);
    expect(problem).not.toBeNull();
    expect(problem?.reason).toBe("usage-limit");
    expect(problem?.model).toBe(expectedTag);

    // A later successful cycle clears the note.
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const ok = new FakeProvider([[{ type: "text_delta", delta: '{"ops":[]}' }, { type: "done", stopReason: "end_turn" }]]);
    const dreamer2 = new Dreamer({
      settings: () => null, provider: { provider: ok, model: "ignored" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, roleHealth, now: () => Date.now() + DREAM_MIN_SPACING_MS + 1,
    });
    await dreamer2.tick();
    expect(roleHealth.problemFor("pins.dream", expectedTag)).toBeNull();
  });

  test("a rate_limit error with NO retryAfterMs still gets retryAt from the provider's own subscriptionQuota report", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-quota-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-dreamer-rh-quota-")));
    const failing = new FakeProvider([[{ type: "error", code: "rate_limit", providerCode: "usage_limit_reached", message: "429" }]]);
    const dreamer = new Dreamer({
      settings: () => null,
      provider: { provider: failing, model: "ignored", quota: { subscriptionQuota: () => ({ info: { status: "rejected", resetsAt: 2_000_000 }, at: 1 }) } },
      store, dir: () => dir, enabled: () => true, activeTurnCount: () => 0, roleHealth,
    });
    await dreamer.tick();
    const expectedTag = `${ownProviderFor(null)}/${DREAM_MODEL_UNDER_TEST}`;
    const problem = roleHealth.problemFor("pins.dream", expectedTag);
    expect(problem?.reason).toBe("usage-limit");
    expect(problem?.retryAt).toBe(new Date(2_000_000 * 1000).toISOString());
  });

  test("no roleHealth wired -> tick() behaves exactly as before (no crash, no note anywhere to check)", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-norolehealth-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const failing = new FakeProvider([[{ type: "error", code: "rate_limit", message: "429" }]]);
    const dreamer = new Dreamer({
      settings: () => null, provider: { provider: failing, model: "ignored" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await expect(dreamer.tick()).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B-1 (2026-09-19 review): the scheduler's slot reconciles the internal-jobs credential snapshot.
//
// `winter login` and bare `winter logout` write `codex-oauth:default` IN-PROCESS — no RPC, by design —
// so a long-running daemon that nobody poked has to notice on its own. The dreamer's tick is where it
// does, plus any `auth`-classified provider failure (the logout symptom: the snapshot still says the
// credential is there, the provider says it is not).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the dreamer reconciles the internal-jobs credential snapshot", () => {
  test("every tick asks for a re-probe, even when the dream pass itself is gated out", async () => {
    const { store, dir } = setup("winter-dreamer-refresh-");
    let asked = 0;
    const dreamer = new Dreamer({
      provider: { provider: okProvider(), model: "unused" },
      store, dir: () => dir, settings: () => null,
      // `enabled: false` gates the dream pass out entirely — the reconcile must still happen, because
      // it is about the DAEMON's credentials, not about whether this particular job is going to run.
      enabled: () => false, activeTurnCount: () => 0,
      refreshCredentials: () => { asked += 1; },
    });
    await dreamer.tick();
    await dreamer.tick();
    expect(asked).toBe(2);
  });

  test("an `auth`-class provider failure asks for a re-probe (the `winter logout` symptom)", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-refresh-auth-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    let asked = 0;
    const dreamer = new Dreamer({
      provider: {
        provider: new FakeProvider([[{ type: "error", code: "auth", message: "invalid credential" }]]),
        model: "unused",
      },
      store, dir: () => dir, settings: () => null,
      enabled: () => true, activeTurnCount: () => 0,
      refreshCredentials: () => { asked += 1; },
    });
    await dreamer.tick();
    // Once for the tick itself, once for the rejected credential — both are the same rate-limited,
    // non-blocking ask inside `InternalProviderView.refreshSoon`.
    expect(asked).toBe(2);
  });

  test("a NON-auth failure does not ask (a 429 says nothing about which credentials exist)", async () => {
    const { store, dispatchId, dir } = setup("winter-dreamer-refresh-429-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    let asked = 0;
    const dreamer = new Dreamer({
      provider: {
        provider: new FakeProvider([[{ type: "error", code: "rate_limit", message: "429" }]]),
        model: "unused",
      },
      store, dir: () => dir, settings: () => null,
      enabled: () => true, activeTurnCount: () => 0,
      refreshCredentials: () => { asked += 1; },
    });
    await dreamer.tick();
    expect(asked).toBe(1); // the tick's own ask, and nothing more
  });
});
