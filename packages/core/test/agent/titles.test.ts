import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";

function setup(script: ProviderEvent[][]) {
  const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
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
 *  NORMA_TITLE_TIMEOUT_MS env value falls back to the documented default instead of NaN-ing
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

  test("no user message → no event, no model call", async () => {
    const { store, titler, sessionId, provider } = setup(titleScript("Should never be used"));
    // No seedTurn: session has no main-thread user_message yet.
    await titler.maybeTitle(sessionId);
    expect(store.read(sessionId).filter((e) => e.type === "session_titled").length).toBe(0);
    expect(provider.requests.length).toBe(0);
  });

  test("provider error → resolves without throwing, no event", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
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
      const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
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

    test("malformed NORMA_TITLE_TIMEOUT_MS env value falls back to the default instead of NaN-ing an instant timeout", async () => {
      const original = process.env.NORMA_TITLE_TIMEOUT_MS;
      try {
        process.env.NORMA_TITLE_TIMEOUT_MS = "not-a-number";
        const home = mkdtempSync(join(tmpdir(), "norma-titles-home-"));
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
        if (original === undefined) delete process.env.NORMA_TITLE_TIMEOUT_MS;
        else process.env.NORMA_TITLE_TIMEOUT_MS = original;
      }
    });
  });
});
