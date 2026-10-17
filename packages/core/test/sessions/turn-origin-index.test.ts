import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { runningTurnOrigin } from "../../src/sessions/turn-origins";
import { TurnOriginIndex, turnOriginIndexFor } from "../../src/sessions/turn-origin-index";

function setup() {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-turn-origin-")));
  const hub = new SessionHub(store);
  const sid = store.createSession("global", { mode: "dispatch", approvalPolicy: "ask" });
  const msg = (clientName: string) => hub.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "x", clientName });
  const started = () => hub.append(sid, { type: "turn_started", sessionId: sid, threadId: "main" } as never);
  const done = () => hub.append(sid, { type: "turn_completed", sessionId: sid, threadId: "main", stopReason: "end_turn", inputTokens: 0, outputTokens: 0 } as never);
  return { store, hub, sid, msg, started, done };
}

describe("TurnOriginIndex — the running turn's origin from memory, never a whole-log read", () => {
  test("answers what runningTurnOrigin over the whole log answers, as turns come and go", () => {
    const { store, hub, sid, msg, started, done } = setup();
    const index = turnOriginIndexFor(hub, store);
    expect(index.origin(sid)).toBeUndefined();
    msg("winter-mac"); started();
    expect(index.origin(sid)).toBe("winter-mac");
    done();
    msg("dispatch-wake"); started();
    expect(index.origin(sid)).toBe("dispatch-wake");
    // a queued message lands while the turn runs; its turn starts after this one ends
    msg("messaging"); done(); started();
    expect(index.origin(sid)).toBe("messaging");
    expect(index.origin(sid)).toBe(runningTurnOrigin(store.read(sid)));
    // the same index for the same hub
    expect(turnOriginIndexFor(hub, store)).toBe(index);
  });

  test("after its first question it reads no log at all: the hub's observer feeds it", () => {
    const { store, hub, sid, msg, started } = setup();
    let tails = 0, reads = 0;
    const counting = {
      readTail: (s: string, n: number) => { tails++; return store.readTail(s, n); },
      lastSeq: (s: string) => store.lastSeq(s),
    };
    const realRead = store.read.bind(store);
    store.read = ((s: string, f?: number) => { reads++; return realRead(s, f); }) as typeof store.read;
    const index = new TurnOriginIndex(counting);
    hub.addObserver((e) => index.observe(e));
    msg("winter-mac"); started();
    expect(index.origin(sid)).toBe("winter-mac");
    expect(tails).toBe(1);
    for (let i = 0; i < 5; i++) { msg("messaging"); }
    expect(index.origin(sid)).toBe("winter-mac");
    expect(tails).toBe(1);
    expect(reads).toBe(0);
  });

  test("an event appended without the hub makes it re-seed from the bounded tail", () => {
    const { store, hub, sid, msg, started } = setup();
    const index = turnOriginIndexFor(hub, store);
    msg("winter-mac"); started();
    expect(index.origin(sid)).toBe("winter-mac");
    store.append(sid, { type: "turn_completed", sessionId: sid, threadId: "main", stopReason: "end_turn", inputTokens: 0, outputTokens: 0 } as never);
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "x", clientName: "dispatch-wake" });
    store.append(sid, { type: "turn_started", sessionId: sid, threadId: "main" } as never);
    expect(index.origin(sid)).toBe("dispatch-wake");
    msg("peer"); started();   // a gap-free hub event after the re-seed is fed again
    expect(index.origin(sid)).toBe(runningTurnOrigin(store.read(sid)));
  });

  test("readTail returns only the last events within the byte bound, oldest first", () => {
    const { store, sid, msg } = setup();
    for (let i = 0; i < 50; i++) msg(`c${i}`);
    const all = store.read(sid);
    const tail = store.readTail(sid, 600);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(all.length);
    expect(tail.map((e) => e.seq)).toEqual(all.slice(-tail.length).map((e) => e.seq));
    expect(store.readTail(sid, 10 * 1024 * 1024).map((e) => e.seq)).toEqual(all.map((e) => e.seq));
  });

  test("an unknown session answers undefined (unknown origin), never throws", () => {
    const { store, hub } = setup();
    expect(turnOriginIndexFor(hub, store).origin("s_nope")).toBeUndefined();
  });
});
