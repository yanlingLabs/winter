import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";
import { SessionStore } from "../../src/sessions/store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { Dreamer, DREAM_MIN_EVENTS, DREAM_MIN_SPACING_MS } from "../../src/agent/dreamer";

/** A real temp store with a dispatch session — same fixture shape as dreamer-cycle.test.ts. */
function setup(prefix: string): { home: string; store: SessionStore; dispatchId: string; dir: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const store = new SessionStore(home);
  const dispatchId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
  const dir = join(home, "memory");
  return { home, store, dispatchId, dir };
}

/** Pads the dispatch log with `n` generic substantive (user_message) events. */
function fillSubstantive(store: SessionStore, sid: string, n: number): void {
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `filler message ${i}`, clientName: "test" });
  }
}

function okProvider(delta = '{"ops":[]}'): FakeProvider {
  return new FakeProvider([[{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }]]);
}

/** A provider whose streamTurn never yields (await new Promise(()=>{}) inside the generator) —
 *  used to probe re-entrancy (a tick() in flight) and the timeout/abort path (carried-over
 *  review fix: on timeout the Dreamer must abort this in-flight call via AbortSignal). */
class HangingProvider implements Provider {
  readonly id = "hanging";
  readonly requests: TurnRequest[] = [];
  models() { return [{ id: "hang-1", family: "hang", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    // Keep the signal by reference (mirrors FakeProvider) — a structuredClone would strip it.
    const { signal, ...cloneable } = req;
    this.requests.push({ ...structuredClone(cloneable), ...(signal ? { signal } : {}) });
    await new Promise<never>(() => {}); // never resolves — simulates a hung provider connection
  }
}

/** A provider that resolves successfully after a short real delay — used to prove a malformed
 *  NORMA_DREAM_TIMEOUT_MS env value falls back to the documented default instead of NaN-ing
 *  setTimeout into an instant timeout. */
class DelayedProvider implements Provider {
  readonly id = "delayed";
  readonly requests: TurnRequest[] = [];
  constructor(private readonly delayMs: number, private readonly text = '{"ops":[]}') {}
  models() { return [{ id: "delayed-1", family: "delayed", contextWindow: 1000, supportsVision: false }]; }
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    await new Promise((r) => setTimeout(r, this.delayMs));
    yield { type: "text_delta", delta: this.text };
    yield { type: "done", stopReason: "end_turn" };
  }
}

describe("Dreamer gates — each independently blocks (provider call count stays 0)", () => {
  test("1) enabled() => false", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-gate-enabled-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => false, activeTurnCount: () => 0,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(0);
  });

  test("2) activeTurnCount() > 0", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-gate-busy-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 1,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(0);
  });

  test("3) no dispatch session in store", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-dreamer-gate-nodispatch-")));
    const store = new SessionStore(home); // no session created at all -> dispatchSessionId() undefined
    const dir = join(home, "memory");
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(0);
  });

  test("4) 39 substantive events (40th noise event like harness_attached doesn't count)", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-gate-threshold-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS - 1);
    store.append(dispatchId, { type: "harness_attached", sessionId: dispatchId, clientName: "cli" });
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(0);
  });

  test("5) spacing: lastDreamAt = now - 1h (< 2h minimum) blocks even with threshold met", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-gate-spacing-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const fixedNow = 1_753_000_000_000;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dream-state.json"), JSON.stringify({ watermarkSeq: 0, lastDreamAt: fixedNow - DREAM_MIN_SPACING_MS / 2 }));
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(0);
  });
});

describe("Dreamer — fires when all gates pass", () => {
  test("6) 40 substantive + idle + spacing elapsed -> exactly ONE call; an immediate second tick() -> still one", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-fires-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(1);

    await dreamer.tick(); // watermark advanced past the window -> threshold gate blocks again
    expect(provider.requests).toHaveLength(1);
  });

  test("7) re-entrancy: tick() while a slow provider call is in flight -> second tick() returns without a second call", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-reentrant-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = new HangingProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, timeoutMs: 50, // short so the dangling first tick() resolves quickly
    });
    const p1 = dreamer.tick(); // starts runCycle synchronously up to the hung provider await
    const p2 = dreamer.tick(); // inFlight already true -> returns immediately, no second call
    await p2;
    expect(provider.requests).toHaveLength(1);
    await p1; // let the hung call time out so it doesn't leak a real timer past the test
  });

  test("8) backlog-after-restart falls out naturally: lastDreamAt = now - 3h on disk, fresh Dreamer instance dreams on first tick", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-backlog-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const fixedNow = 1_753_000_000_000;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dream-state.json"), JSON.stringify({ watermarkSeq: 0, lastDreamAt: fixedNow - DREAM_MIN_SPACING_MS * 1.5 }));
    const provider = okProvider();
    // Fresh Dreamer instance (simulates a daemon restart reading persisted state off disk).
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, now: () => fixedNow,
    });
    await dreamer.tick();
    expect(provider.requests).toHaveLength(1);
  });
});

describe("Dreamer — start()/stop()", () => {
  test("9) idempotent start, timer runs tick() on interval, stop() halts it (idempotent)", async () => {
    const { store, dir } = setup("norma-dreamer-startstop-");
    let calls = 0;
    // enabled() is the FIRST thing every tick() reads -> counting its calls isolates "is the
    // timer still firing tick()" from the gating logic exercised by the tests above.
    const dreamer = new Dreamer({
      provider: { provider: okProvider(), model: "x" },
      store,
      dir: () => dir,
      enabled: () => { calls++; return false; },
      activeTurnCount: () => 0,
    });

    dreamer.start(10);
    dreamer.start(10); // idempotent: must not spin up a second interval
    await Bun.sleep(35);
    dreamer.stop();
    const countAtStop = calls;
    expect(countAtStop).toBeGreaterThan(0);

    await Bun.sleep(35);
    expect(calls).toBe(countAtStop); // no further calls after stop()

    expect(() => dreamer.stop()).not.toThrow(); // idempotent stop
  });
});

describe("Dreamer — carried-over review fix: timeout aborts the in-flight provider call", () => {
  test("timeoutMs elapses -> tick() resolves without throwing, watermark NOT advanced, provider's request.signal is aborted", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-timeout-abort-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = new HangingProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, timeoutMs: 1,
    });

    await expect(dreamer.tick()).resolves.toBeUndefined();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.signal).toBeDefined();
    expect(provider.requests[0]!.signal?.aborted).toBe(true);
    expect(existsSync(join(dir, "dream-state.json"))).toBe(false); // watermark not advanced
  });

  test("malformed NORMA_DREAM_TIMEOUT_MS env value falls back to the default instead of NaN-ing an instant timeout", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-timeout-env-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const original = process.env.NORMA_DREAM_TIMEOUT_MS;
    try {
      process.env.NORMA_DREAM_TIMEOUT_MS = "not-a-number";
      const provider = new DelayedProvider(30); // resolves in 30ms — fine under the real default, fatal under NaN
      const dreamer = new Dreamer({
        provider: { provider, model: "x" }, store, dir: () => dir,
        enabled: () => true, activeTurnCount: () => 0, // no explicit timeoutMs -> falls back to the env-derived default
      });
      await dreamer.tick();
      expect(provider.requests).toHaveLength(1);
      expect(existsSync(join(dir, "dream-state.json"))).toBe(true); // succeeded -> watermark advanced
    } finally {
      if (original === undefined) delete process.env.NORMA_DREAM_TIMEOUT_MS;
      else process.env.NORMA_DREAM_TIMEOUT_MS = original;
    }
  });
});

// session-activity-hygiene T7 (spec §3): the cleaner "rides the existing Dreaming cycle (its
// scheduler, its model configuration, low effort)". These pin the SEAM — that the cleaner runs on
// the dreamer's scheduler slot, AFTER the dream pass, and that neither can break the other. The
// cleaner's own behavior lives in test/sessions/cleaner.test.ts.
describe("Dreamer — the T7 cleaner rides the same scheduler slot", () => {
  /** A cleaner double: records when it ran, relative to the dream. */
  function recordingCleaner(order: string[], opts: { throws?: boolean } = {}) {
    return {
      runs: 0,
      async runPass(): Promise<void> {
        this.runs++;
        order.push("cleaner");
        if (opts.throws) throw new Error("simulated cleaner explosion");
      },
    };
  }

  test("the cleaner pass runs on EVERY tick, including ticks where no dream happens", async () => {
    const { store, dir } = setup("norma-dreamer-cleaner-notick-");
    const order: string[] = [];
    const cleaner = recordingCleaner(order);
    // No dispatch session and no substantive events: every dream gate blocks.
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, cleaner,
    });

    await dreamer.tick();
    await dreamer.tick();

    expect(provider.requests).toHaveLength(0); // no dream...
    expect(cleaner.runs).toBe(2); // ...but the cleaner still rode both slots
  });

  test("on a tick where a dream DOES happen, the cleaner runs AFTER it", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-cleaner-after-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const order: string[] = [];
    const cleaner = recordingCleaner(order);
    class OrderingProvider implements Provider {
      readonly id = "ordering";
      readonly requests: TurnRequest[] = [];
      models() { return [{ id: "o-1", family: "o", contextWindow: 1000, supportsVision: false }]; }
      async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
        this.requests.push(req);
        order.push("dream");
        yield { type: "text_delta", delta: '{"ops":[]}' };
        yield { type: "done", stopReason: "end_turn" };
      }
    }
    const provider = new OrderingProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, cleaner,
    });

    await dreamer.tick();

    expect(order).toEqual(["dream", "cleaner"]);
  });

  test("`memory.enabled: false` stops DREAMS but not the cleaner — they are separate settings", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-cleaner-memoff-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const cleaner = recordingCleaner([]);
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => false, activeTurnCount: () => 0, cleaner,
    });

    await dreamer.tick();

    expect(provider.requests).toHaveLength(0);
    expect(cleaner.runs).toBe(1); // cleaner.enabled is the cleaner's OWN gate, checked inside runPass
  });

  test("a dream that throws does not skip the cleaner, and a cleaner that throws never escapes tick()", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-cleaner-throws-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const cleaner = recordingCleaner([], { throws: true });
    const provider = okProvider("not json at all"); // makes runCycle throw
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0, cleaner,
    });

    await expect(dreamer.tick()).resolves.toBeUndefined();
    expect(cleaner.runs).toBe(1);

    // ...and the re-entrancy guard was released despite both failures, so the next tick still works.
    await dreamer.tick();
    expect(cleaner.runs).toBe(2);
  });

  test("no cleaner wired: tick() behaves exactly as before", async () => {
    const { store, dispatchId, dir } = setup("norma-dreamer-cleaner-absent-");
    fillSubstantive(store, dispatchId, DREAM_MIN_EVENTS);
    const provider = okProvider();
    const dreamer = new Dreamer({
      provider: { provider, model: "x" }, store, dir: () => dir,
      enabled: () => true, activeTurnCount: () => 0,
    });
    await expect(dreamer.tick()).resolves.toBeUndefined();
    expect(provider.requests).toHaveLength(1);
  });
});
