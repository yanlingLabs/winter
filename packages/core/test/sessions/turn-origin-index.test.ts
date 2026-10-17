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

describe("a re-seed from a CUT tail never guesses a person (review: fail-safe)", () => {
  const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) =>
    ({ seq, ts: 0, sessionId: "s1", threadId: "main", type, ...extra }) as never;
  const storeOf = (tail: unknown[]) => ({ readTail: () => tail as never[], lastSeq: () => (tail.at(-1) as { seq: number }).seq });

  test("a window that opens inside a running turn: a folded continuation reads unknown, not the oldest unanswered message", () => {
    // Before the window: Dispatch's turn started on a wake. In it: the user's queued message, a peer's message
    // folded into the running turn, and the runtime's continuation `turn_started`.
    const tail = [
      ev(500, "tool_call", { callId: "c1", name: "Bash", argsJson: "{}" }),   // main-thread, before any turn start: cut inside a turn
      ev(501, "user_message", { text: "later please", clientName: "winter-mac" }),
      ev(502, "user_message", { text: "status?", clientName: "messaging" }),
      ev(503, "tool_result", { callId: "c1", output: "", isError: false }),
      ev(504, "turn_started"),
    ];
    // What a fresh, uncut pairing would have guessed — a person — is exactly what must not be answered.
    expect(runningTurnOrigin(tail as never)).toBe("winter-mac");
    expect(new TurnOriginIndex(storeOf(tail)).origin("s1")).toBeUndefined();
  });

  test("a window whose only start is a continuation, right after the seed, reads unknown too", () => {
    const tail = [ev(900, "user_message", { text: "x", clientName: "winter-mac" }), ev(901, "turn_started")];
    expect(new TurnOriginIndex(storeOf(tail)).origin("s1")).toBeUndefined();
  });

  test("once a turn it saw whole has ended, the next turn reads exactly again", () => {
    const tail = [
      ev(500, "assistant_message", { text: "…" }),
      ev(501, "turn_completed", { stopReason: "end_turn", inputTokens: 0, outputTokens: 0 }),
      ev(502, "user_message", { text: "go", clientName: "winter-mac" }),
      ev(503, "turn_started"),
    ];
    expect(new TurnOriginIndex(storeOf(tail)).origin("s1")).toBe("winter-mac");
  });

  test("an UNCUT log (it starts at seq 1) is read exactly, as before", () => {
    const tail = [ev(1, "user_message", { text: "go", clientName: "winter-mac" }), ev(2, "turn_started")];
    expect(new TurnOriginIndex(storeOf(tail)).origin("s1")).toBe("winter-mac");
  });
});
