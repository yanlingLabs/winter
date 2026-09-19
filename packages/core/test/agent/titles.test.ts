import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { internalRoleEffortFor } from "../../src/providers/manager";
import { RoleHealthRegistry } from "../../src/providers/role-health";
import { Settings } from "../../src/settings";

function setup(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const provider = new FakeProvider(script);
  const titler = new SessionTitler({ provider: { provider, model: "fake-1" }, store, hub });
  const sessionId = store.createSession("global", { cwd: "/tmp" });
  return { store, hub, provider, titler, sessionId };
}

/** Seeds a main-thread user_message + assistant_message so the titler has content to work with. */
function seedTurn(store: SessionStore, sessionId: string, userText = "how do I fix the login flow?", replyText = "I fixed it.") {
  store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: userText, clientName: "test" });
  store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: replyText });
}

const titleScript = (title: string): ProviderEvent[][] => [
  [{ type: "text_delta", delta: title }, { type: "done", stopReason: "end_turn" }],
];

class ThrowingProvider implements Provider {
  readonly id = "throwing";
  models(): ModelInfo[] { return [{ id: "throw-1", family: "fake", contextWindow: 100_000, supportsVision: false }]; }
  async *streamTurn(): AsyncIterable<ProviderEvent> {
    throw new Error("provider boom");
  }
}

/** A provider whose streamTurn never yields (await new Promise(()=>{}) inside the generator) —
 *  used to probe the timeout/abort path (carried-over review fix: on timeout the titler must
 *  abort this in-flight call via AbortSignal). Mirrors dreamer-gates.test.ts's HangingProvider. */
class HangingProvider implements Provider {
  readonly id = "hanging";
  readonly requests: TurnRequest[] = [];
  models(): ModelInfo[] { return [{ id: "hang-1", family: "hang", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    // Keep the signal by reference (mirrors FakeProvider) — a structuredClone would strip it.
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    await new Promise<never>(() => {}); // never resolves — simulates a hung provider connection
  }
}

/** A provider that resolves successfully after a short real delay — used to prove a malformed
 *  WINTER_TITLE_TIMEOUT_MS env value falls back to the documented default instead of NaN-ing
 *  setTimeout into an instant timeout. Mirrors dreamer-gates.test.ts's DelayedProvider. */
class DelayedProvider implements Provider {
  readonly id = "delayed";
  readonly requests: TurnRequest[] = [];
  constructor(private readonly delayMs: number, private readonly text = "Fixing the login flow") {}
  models(): ModelInfo[] { return [{ id: "delayed-1", family: "delayed", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    await new Promise((r) => setTimeout(r, this.delayMs));
    yield { type: "text_delta", delta: this.text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

describe("SessionTitler", () => {
  test("titles once after content exists; second call is a no-op", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Fixing the login flow"));
    seedTurn(store, sessionId);

    await titler.maybeTitle(sessionId);
    const events = store.read(sessionId).filter((e) => e.type === "session_titled");
    expect(events.length).toBe(1);
    expect((events[0] as any).title).toBe("Fixing the login flow");
    expect(provider.requests.length).toBe(1);

    await titler.maybeTitle(sessionId);
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(1);
    // No second model call — store.getTitle guard short-circuits before any oneShot.
    expect(provider.requests.length).toBe(1);
  });

  // Daemon settings surface (2026-09-17 plan, item 4a): `model` is now a LIVE getter, re-invoked on
  // every `maybeTitle()` call — proves the daemon.ts boot-snapshot bug is actually fixed, not just
  // that the constructor accepts a function. Two DIFFERENT sessions (a session titles at most once)
  // so two real provider calls happen against the SAME titler instance, no reconstruction between
  // them — exactly what a `titles.model` write hitting a running daemon needs.
  test("model is read LIVE — a getter mutated between calls changes the NEXT call, no restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const provider = new FakeProvider([...titleScript("first"), ...titleScript("second")]);
    let liveModel = "openai/gpt-5.4";
    const titler = new SessionTitler({ provider: { provider, model: "fake-1" }, store, hub, model: () => liveModel });

    const sessionA = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionA);
    await titler.maybeTitle(sessionA);
    expect(provider.requests[0]?.model).toBe("openai/gpt-5.4");

    // Mutate the setting the getter reads — no titler reconstruction, exactly what a settings.json
    // hot-swap on a live daemon does.
    liveModel = "anthropic/claude-opus-5";
    const sessionB = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionB);
    await titler.maybeTitle(sessionB);
    expect(provider.requests[1]?.model).toBe("anthropic/claude-opus-5");
  });

  // The getter returning `undefined` (daemon.ts's own shape when `internalModelFor` refuses a
  // mismatched provider) falls back to `deps.provider.model` — identical to no override at all,
  // same fallback `deps.model ?? deps.provider.model` always had.
  test("a getter returning undefined falls back to the provider's own model", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const provider = new FakeProvider(titleScript("t"));
    const titler = new SessionTitler({ provider: { provider, model: "fake-1" }, store, hub, model: () => undefined });
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionId);
    await titler.maybeTitle(sessionId);
    expect(provider.requests[0]?.model).toBe("fake-1");
  });

  // Minor 5c (fix wave, pre-merge review): the fallback (no `titles.model` override at all) used
  // to read the STATIC `deps.provider.model` snapshot, which `RebindableProvider.refresh` only ever
  // moves on a rebind that CROSSES catalog providers — a same-provider model change (the common
  // case) left titles stuck on whatever was bound at daemon boot, forever, with no daemon restart
  // in sight to fix it. `deps.provider.live` (when present — `RebindableProvider.live`) is now
  // consulted FIRST, mirroring `agentProvider.live?.().model`'s hot re-read every real daemon uses.
  test("no override -> falls back to the LIVE bound model (deps.provider.live), not the static snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const provider = new FakeProvider([...titleScript("first"), ...titleScript("second")]);
    let bound = "codex-oauth/gpt-5.6-sol";
    const titler = new SessionTitler({ provider: { provider, model: "fake-1", live: () => ({ model: bound }) }, store, hub });

    const sessionA = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionA);
    await titler.maybeTitle(sessionA);
    expect(provider.requests[0]?.model).toBe("codex-oauth/gpt-5.6-sol"); // NOT "fake-1", the static snapshot

    // A same-provider model change moves `live()` immediately, with no titler reconstruction —
    // the exact case `RebindableProvider.refresh`'s own early return never touches `.model` for.
    bound = "codex-oauth/gpt-5.6-luna";
    const sessionB = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionB);
    await titler.maybeTitle(sessionB);
    expect(provider.requests[1]?.model).toBe("codex-oauth/gpt-5.6-luna");
  });

  test("no user message → no event, no model call", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Should never be used"));
    // No seedTurn: session has no main-thread user_message yet.
    await titler.maybeTitle(sessionId);
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
    expect(provider.requests.length).toBe(0);
  });

  test("provider error → resolves without throwing, no event", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const titler = new SessionTitler({ provider: { provider: new ThrowingProvider(), model: "fake-1" }, store, hub });
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionId);

    await expect(titler.maybeTitle(sessionId)).resolves.toBeUndefined();
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
  });

  test("multi-line/overlong model output → first line, capped 60", async () => {
    const { store, titler, sessionId } = setup(titleScript("A Title\nextra prose that should be discarded entirely"));
    seedTurn(store, sessionId);

    await titler.maybeTitle(sessionId);
    const events = store.read(sessionId).filter((e) => e.type === "session_titled");
    expect(events.length).toBe(1);
    expect((events[0] as any).title).toBe("A Title");
  });

  test("hub.onGlobalEvent fires for session_titled", async () => {
    const { store, hub, titler, sessionId } = setup(titleScript("Fixing the login flow"));
    seedTurn(store, sessionId);

    const seen: string[] = [];
    hub.onGlobalEvent = (e) => { seen.push(e.type); };

    await titler.maybeTitle(sessionId);
    expect(seen).toContain("session_titled");
  });

  describe("carried-over review fix: timeout aborts the in-flight provider call", () => {
    test("timeoutMs elapses -> maybeTitle resolves without throwing, no event, provider's request.signal is aborted", async () => {
      const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const provider = new HangingProvider();
      const titler = new SessionTitler({ provider: { provider, model: "hang-1" }, store, hub, timeoutMs: 1 });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      seedTurn(store, sessionId);

      await expect(titler.maybeTitle(sessionId)).resolves.toBeUndefined();

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.signal).toBeDefined();
      expect(provider.requests[0]!.signal?.aborted).toBe(true);
      expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
    });

    test("malformed WINTER_TITLE_TIMEOUT_MS env value falls back to the default instead of NaN-ing an instant timeout", async () => {
      const original = process.env.WINTER_TITLE_TIMEOUT_MS;
      try {
        process.env.WINTER_TITLE_TIMEOUT_MS = "not-a-number";
        const home = mkdtempSync(join(tmpdir(), "winter-titles-home-"));
        const store = new SessionStore(home);
        const hub = new SessionHub(store);
        const provider = new DelayedProvider(30); // resolves in 30ms — fine under the real default, fatal under NaN
        // No explicit timeoutMs -> falls back to the env-derived default.
        const titler = new SessionTitler({ provider: { provider, model: "delayed-1" }, store, hub });
        const sessionId = store.createSession("global", { cwd: "/tmp" });
        seedTurn(store, sessionId);

        await titler.maybeTitle(sessionId);
        expect(provider.requests).toHaveLength(1);
        const events = store.read(sessionId).filter((e) => e.type === "session_titled");
        expect(events.length).toBe(1);
        expect((events[0] as any).title).toBe("Fixing the login flow");
      } finally {
        if (original === undefined) delete process.env.WINTER_TITLE_TIMEOUT_MS;
        else process.env.WINTER_TITLE_TIMEOUT_MS = original;
      }
    });
  });
});

// 2026-09-18: `settings.roleEfforts["titles.model"]`. The titler only FORWARDS an effort its caller
// already resolved, so these tests wire the `effort` getter EXACTLY as daemon.ts does —
// `internalRoleEffortFor` over a live settings holder and the bound selection — and assert on the
// OUTGOING `TurnRequest`, which is the only place a "stored but never spent" effort can be caught.
describe("SessionTitler: the titles.model role effort", () => {
  const settingsOf = (over: Record<string, unknown>): Settings =>
    Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over });
  const BOUND = { providerId: "openai", model: "gpt-5.6-sol" };

  /** One titler over a mutable settings holder; each `title()` is a fresh session (a session titles once). */
  function liveTitler(initial: Settings) {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-effort-"));
    const store = new SessionStore(home);
    const provider = new FakeProvider(titleScript("A title"));
    const holder = { settings: initial };
    const titler = new SessionTitler({
      provider: { provider, model: BOUND.model, live: () => BOUND }, store, hub: new SessionHub(store),
      effort: () => internalRoleEffortFor(holder.settings, "titles.model", holder.settings.titles?.model, BOUND),
    });
    const title = async (): Promise<TurnRequest> => {
      const sid = store.createSession("global", { cwd: "/tmp" });
      seedTurn(store, sid);
      await titler.maybeTitle(sid);
      return provider.requests.at(-1)!;
    };
    return { holder, title, provider };
  }

  test("absent → the request carries NO reasoningEffort key at all, exactly as before", async () => {
    const req = await liveTitler(settingsOf({})).title();
    expect("reasoningEffort" in req).toBe(false);
    // …and a titler built with no `effort` dep at all (every pre-existing construction) is unchanged too.
    const { store, titler, sessionId, provider } = setup(titleScript("t"));
    seedTurn(store, sessionId);
    await titler.maybeTitle(sessionId);
    expect("reasoningEffort" in provider.requests[0]!).toBe(false);
  });

  test("a stored effort the model offers reaches the request", async () => {
    expect((await liveTitler(settingsOf({ roleEfforts: { "titles.model": "low" } })).title()).reasoningEffort).toBe("low");
  });

  test("a stored effort the model does NOT offer is mapped or omitted — the title is still written", async () => {
    // Pinned to o4-mini (low/medium/high, default medium): `max` maps onto the row's default.
    expect((await liveTitler(settingsOf({ titles: { model: "openai/o4-mini" }, roleEfforts: { "titles.model": "max" } })).title()).reasoningEffort).toBe("medium");
    // Pinned to a row with no vocabulary: omitted.
    const t = liveTitler(settingsOf({ titles: { model: "openai/gpt-5.4" }, roleEfforts: { "titles.model": "high" } }));
    expect("reasoningEffort" in (await t.title())).toBe(false);
    expect(t.provider.requests).toHaveLength(1);
  });

  test("a pin naming an UNBOUND provider falls back to the bound model — and the effort is mapped onto THAT row, not the refused pin's", async () => {
    // The refused pin (anthropic/claude-opus-5) LISTS xhigh; the row the titler will actually run on
    // (the bound openai/o4-mini) does not. Mapping against the pin would send o4-mini an effort it rejects.
    const bound = { providerId: "openai", model: "o4-mini" };
    const s = settingsOf({ titles: { model: "anthropic/claude-opus-5" }, roleEfforts: { "titles.model": "xhigh" } });
    expect(internalRoleEffortFor(s, "titles.model", s.titles?.model, bound)).toBe("medium"); // o4-mini's default, not opus's xhigh
    expect(internalRoleEffortFor(s, "titles.model", s.titles?.model, { providerId: "anthropic", model: "ignored" })).toBe("xhigh");
  });

  test("a settings change lands on the NEXT title from the SAME titler — no restart", async () => {
    const t = liveTitler(settingsOf({}));
    expect("reasoningEffort" in (await t.title())).toBe(false);
    t.holder.settings = settingsOf({ roleEfforts: { "titles.model": "high" } });
    expect((await t.title()).reasoningEffort).toBe("high");
    t.holder.settings = settingsOf({});
    expect("reasoningEffort" in (await t.title())).toBe(false);
  });
});

describe("SessionTitler role-health wiring (2026-09-18) — observation only", () => {
  test("a provider error (a class titles.ts never had a branch for before) records titles.model, never throws or changes maybeTitle's swallow-and-log behaviour", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-rh-home-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-titles-rh-registry-")));
    const failing = new FakeProvider([[{ type: "error", code: "rate_limit", providerCode: "insufficient_quota", message: "429" }]]);
    const titler = new SessionTitler({
      provider: { provider: failing, model: "fake-1" }, store, hub,
      boundProviderId: () => "openai", roleHealth,
    });
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionId);

    // maybeTitle's own contract: NEVER throws, and no title is written on a failed call.
    await expect(titler.maybeTitle(sessionId)).resolves.toBeUndefined();
    expect(store.getTitle(sessionId)).toBeNull();

    const problem = roleHealth.problemFor("titles.model", "openai/fake-1");
    expect(problem).not.toBeNull();
    expect(problem?.reason).toBe("out-of-credits");
  });

  test("a successful title clears a previously recorded note", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-titles-rh-home2-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-titles-rh-registry2-")));
    roleHealth.recordFailure("titles.model", "openai/fake-1", { reason: "other", detail: "stale" });
    const ok = new FakeProvider(titleScript("Fix the login flow"));
    const titler = new SessionTitler({
      provider: { provider: ok, model: "fake-1" }, store, hub,
      boundProviderId: () => "openai", roleHealth,
    });
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    seedTurn(store, sessionId);
    await titler.maybeTitle(sessionId);
    expect(store.getTitle(sessionId)).toBe("Fix the login flow");
    expect(roleHealth.problemFor("titles.model", "openai/fake-1")).toBeNull();
  });

  test("no boundProviderId/roleHealth wired (every pre-existing construction) -> unchanged: still no throw", async () => {
    const { store, titler, sessionId } = setup([[{ type: "error", code: "server", message: "boom" }]]);
    seedTurn(store, sessionId);
    await expect(titler.maybeTitle(sessionId)).resolves.toBeUndefined();
    expect(store.getTitle(sessionId)).toBeNull();
  });
});

// 2026-09-19: a chat whose FIRST turn fails (a usage limit, a refused model) has a user_message and
// no assistant_message. The drivers now fire the titler on an error terminal too, so this is the
// shape it must handle: title from the user's message alone rather than leave "New chat" forever.
describe("a first turn that failed still gets a title", () => {
  test("titles from the user's message alone when there is no assistant reply", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Fix the login flow"));
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how do I fix the login flow?", clientName: "test" });
    store.append(sessionId, { type: "agent_error", sessionId, threadId: "main", message: "usage limit reached", code: "rate_limited" } as never);
    await titler.maybeTitle(sessionId);
    expect(store.getTitle(sessionId)).toBe("Fix the login flow");
    const sent = JSON.stringify((provider as unknown as { requests: unknown[] }).requests[0]);
    expect(sent).toContain("how do I fix the login flow?");
    expect(sent).toContain("(none)");
  });
});
