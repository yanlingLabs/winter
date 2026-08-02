import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store";
import { SessionHub, type HubClient } from "../src/sessions/hub";
import type { SessionEvent } from "@norma/protocol";

function fakeClient(name: string): HubClient & { received: SessionEvent[] } {
  const received: SessionEvent[] = [];
  return { clientName: name, received, deliver(e: SessionEvent) { received.push(e); return true; } };
}

function setup() {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-hub-")));
  return { store, hub: new SessionHub(store) };
}

describe("SessionHub", () => {
  test("attach replays history from fromSeq and broadcasts harness_attached", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");

    hub.attach(a, id, 0);
    // a got the replayed session_created (seq 1) and its own harness_attached (seq 2)
    expect(a.received.map((e) => e.type)).toEqual(["session_created", "harness_attached"]);

    hub.attach(b, id, 0);
    // b replays seqs 1-2 then gets its own attached event; a sees b's attach live
    expect(b.received.map((e) => e.type)).toEqual(["session_created", "harness_attached", "harness_attached"]);
    expect(a.received).toHaveLength(3);
  });

  test("send appends user_message and delivers to ALL attached clients", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");
    hub.attach(a, id, 0);
    hub.attach(b, id, 0);

    const seq = hub.send(a, id, "hello from a");
    const lastA = a.received[a.received.length - 1]!;
    const lastB = b.received[b.received.length - 1]!;
    expect(lastA).toMatchObject({ type: "user_message", text: "hello from a", clientName: "a", seq });
    expect(lastB).toEqual(lastA);
  });

  test("detach broadcasts harness_detached to remaining clients and stops delivery", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    const b = fakeClient("b");
    hub.attach(a, id, 0);
    hub.attach(b, id, 0);

    hub.detach(a);
    const lastB = b.received[b.received.length - 1]!;
    expect(lastB).toMatchObject({ type: "harness_detached", clientName: "a" });

    const countA = a.received.length;
    hub.send(b, id, "a should not see this");
    expect(a.received).toHaveLength(countA);
  });

  test("send to a session the client is not attached to throws", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const stranger = fakeClient("stranger");
    expect(() => hub.send(stranger, id, "hi")).toThrow(/not attached/);
  });

  test("re-attach to a second session moves the client (no ghost deliveries)", () => {
    const { store, hub } = setup();
    const s1 = store.createSession("global");
    const s2 = store.createSession("global");
    const mover = fakeClient("mover");
    const watcher = fakeClient("watcher");
    hub.attach(watcher, s1, 0);
    hub.attach(mover, s1, 0);
    hub.attach(mover, s2, 0); // move
    const before = mover.received.length;
    hub.send(watcher, s1, "only for s1");
    expect(mover.received).toHaveLength(before); // no ghost delivery from s1
    // watcher saw mover detach from s1:
    expect(watcher.received.some((e) => e.type === "harness_detached" && e.clientName === "mover")).toBe(true);
  });

  test("a client whose deliver throws is evicted; others still receive events", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    let boom = false;
    const bad: HubClient = { clientName: "bad", deliver() { if (boom) throw new Error("socket dead"); return true; } };
    hub.attach(good, id, 0);
    hub.attach(bad, id, 0);
    boom = true;
    hub.send(good, id, "first");
    // good got its own message AND bad's eviction notice:
    expect(good.received.some((e) => e.type === "user_message" && e.text === "first")).toBe(true);
    expect(good.received.some((e) => e.type === "harness_detached" && e.clientName === "bad")).toBe(true);
    // bad is gone — further sends don't throw and don't deliver to it:
    expect(() => hub.send(good, id, "second")).not.toThrow();
  });

  test("detach of a never-attached client is a no-op", () => {
    const { store, hub } = setup();
    store.createSession("global");
    expect(() => hub.detach(fakeClient("nobody"))).not.toThrow();
  });

  test("a client whose deliver returns false is evicted synchronously", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    let alive = true;
    const flaky: HubClient = { clientName: "flaky", deliver() { return alive; } };
    hub.attach(good, id, 0);
    hub.attach(flaky, id, 0);
    alive = false; // next delivery reports the client is dead
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "x", clientName: "good" });
    // good sees its own message AND flaky's synchronous eviction notice:
    expect(good.received.some((e) => e.type === "user_message" && e.text === "x")).toBe(true);
    expect(good.received.some((e) => e.type === "harness_detached" && e.clientName === "flaky")).toBe(true);
    // flaky is gone — a further append does not deliver to it and does not re-evict:
    const before = good.received.length;
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "y", clientName: "good" });
    expect(good.received.length).toBe(before + 1); // only the user_message, no second detached
  });

  test("simultaneous multi-client death emits exactly one detached each, no duplicates", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    let alive = true;
    const flaky1: HubClient = { clientName: "flaky1", deliver() { return alive; } };
    const flaky2: HubClient = { clientName: "flaky2", deliver() { return alive; } };
    hub.attach(good, id, 0);
    hub.attach(flaky1, id, 0);
    hub.attach(flaky2, id, 0);
    alive = false; // both flaky clients die on the next delivery
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "boom", clientName: "good" });
    const detached = good.received.filter((e) => e.type === "harness_detached");
    const names = detached.map((e: any) => e.clientName).sort();
    expect(names).toEqual(["flaky1", "flaky2"]); // exactly one each, no dupes
  });

  test("attach evicts a client that dies mid-replay — never left half-attached", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const good = fakeClient("good");
    hub.attach(good, id, 0); // history: session_created(1), harness_attached(2)
    hub.send(good, id, "seed"); // seq 3 — gives the next attach's replay >1 event to die partway through

    let deliverCount = 0;
    const flaky: HubClient = {
      clientName: "flaky",
      deliver() { deliverCount++; return deliverCount < 2; }, // dies on the 2nd replayed event
    };
    hub.attach(flaky, id, 0);

    // No other client should ever observe flaky as attached — a client that died mid-replay
    // was never really attached, so there's no attach/detach churn to announce for it.
    const flakyChurn = good.received.filter((e) => "clientName" in e && (e as any).clientName === "flaky");
    expect(flakyChurn).toHaveLength(0);

    // flaky must not be in the live attachment set: a follow-up append doesn't deliver to it,
    // and doesn't emit a (second) detached for it either.
    const before = good.received.length;
    hub.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "after", clientName: "good" });
    expect(good.received.length).toBe(before + 1); // only the new message
    expect(good.received.some((e) => e.type === "harness_detached" && (e as any).clientName === "flaky")).toBe(false);
  });

  test("broadcastTransient delivers to attached clients but never persists or replays", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    hub.attach(a, id, 0); // replay: session_created, then live harness_attached
    const before = store.lastSeq(id);

    const e = hub.broadcastTransient(id, { type: "assistant_delta", sessionId: id, threadId: "main", delta: "tok" });
    expect(e).toMatchObject({ type: "assistant_delta", delta: "tok", seq: before }); // seq = lastSeq, unchanged
    expect(store.lastSeq(id)).toBe(before);                                          // nothing persisted
    expect(a.received[a.received.length - 1]).toMatchObject({ type: "assistant_delta", delta: "tok" });

    // replay for a NEW client contains no transient events
    const b = fakeClient("b");
    hub.attach(b, id, 0);
    expect(b.received.some((ev) => ev.type === "assistant_delta")).toBe(false);
  });

  test("attachedCount reflects attach/detach — 0 for an unknown or never-attached session", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    expect(hub.attachedCount(id)).toBe(0);
    expect(hub.attachedCount("s_nonexistent")).toBe(0);

    const a = fakeClient("a");
    const b = fakeClient("b");
    hub.attach(a, id, 0);
    expect(hub.attachedCount(id)).toBe(1);
    hub.attach(b, id, 0);
    expect(hub.attachedCount(id)).toBe(2);

    hub.detach(a);
    expect(hub.attachedCount(id)).toBe(1);
    hub.detach(b);
    expect(hub.attachedCount(id)).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // session-activity-hygiene T4: emitActivity — the lifecycle's LIVE signal.
  // -----------------------------------------------------------------------------------------

  test("emitActivity broadcasts a session_activity transient — borrowed seq, never persisted, never replayed", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    hub.attach(a, id, 0);
    const before = store.lastSeq(id);

    const e = hub.emitActivity(id, "background");
    expect(e).toMatchObject({ type: "session_activity", activity: "background", sessionId: id, seq: before });
    expect(store.lastSeq(id)).toBe(before);   // borrowed, not consumed
    expect(a.received.at(-1)).toMatchObject({ type: "session_activity", activity: "background" });

    // ...and it is absent from a fresh client's replay, like every transient.
    const b = fakeClient("b");
    hub.attach(b, id, 0);
    expect(b.received.some((ev) => ev.type === "session_activity")).toBe(false);
  });

  test("emitActivity emits ONLY on change — a repeat of the same state is suppressed", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const a = fakeClient("a");
    hub.attach(a, id, 0);
    const count = () => a.received.filter((e) => e.type === "session_activity").length;

    expect(hub.emitActivity(id, "background")).not.toBeNull();
    expect(count()).toBe(1);
    // The idempotent-set case: `session.setActivity background` twice must not put a second frame
    // on every attached socket.
    expect(hub.emitActivity(id, "background")).toBeNull();
    expect(hub.emitActivity(id, "background")).toBeNull();
    expect(count()).toBe(1);

    // A genuine change fires; returning to the previous value is a change too (the memo holds only
    // the LAST emitted value, not a history).
    expect(hub.emitActivity(id, "idle")).not.toBeNull();
    expect(hub.emitActivity(id, "background")).not.toBeNull();
    expect(a.received.filter((e) => e.type === "session_activity").map((e: any) => e.activity))
      .toEqual(["background", "idle", "background"]);
  });

  test("emitActivity tracks change PER SESSION — one session's state never suppresses another's", () => {
    const { store, hub } = setup();
    const one = store.createSession("global");
    const two = store.createSession("global");
    expect(hub.emitActivity(one, "background")).not.toBeNull();
    expect(hub.emitActivity(two, "background")).not.toBeNull(); // different session: not a repeat
    expect(hub.emitActivity(one, "background")).toBeNull();
  });

  test("emitActivity(undefined) emits nothing — absence is 'no lifecycle', not a state", () => {
    const { store, hub } = setup();
    const id = store.createSession("global", { mode: "chat" });
    const a = fakeClient("a");
    hub.attach(a, id, 0);
    // What `activityFor` returns for a chat/dispatch session. A caller must be able to pipe the
    // derivation straight through without re-testing participation.
    expect(hub.emitActivity(id, undefined)).toBeNull();
    expect(a.received.some((e) => e.type === "session_activity")).toBe(false);
  });

  test("emitActivity fires with NOTHING attached — the contract is 'the state changed', not 'someone heard it'", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    // Deliberate: conditioning the memo on attachedCount would bake "nobody is listening" into it,
    // and the next global fan-out path (T9's roster) would silently miss every change made while a
    // session sat unattached.
    expect(hub.emitActivity(id, "background")).not.toBeNull();
    expect(hub.emitActivity(id, "background")).toBeNull();
  });

  test("the change memo is BOUNDED — eviction costs one redundant re-statement, never a missed change", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-hub-")));
    const hub = new SessionHub(store, 2); // cap injected so the eviction path is testable in 3 sessions
    const ids = [store.createSession("global"), store.createSession("global"), store.createSession("global")];
    for (const id of ids) expect(hub.emitActivity(id, "background")).not.toBeNull();
    // ids[0] is now the least-recently-changed and has been evicted: re-emitting its CURRENT state
    // fires again (a harmless re-statement of what its clients already hold)...
    expect(hub.emitActivity(ids[0]!, "background")).not.toBeNull();
    // ...while the two still memoized stay suppressed. Eviction can never do the opposite — hide a
    // real change — because that would need a STALE entry, and eviction only removes entries.
    expect(hub.emitActivity(ids[2]!, "background")).toBeNull();
  });

  test("broadcastTransient evicts a dead client like a normal broadcast", () => {
    const { store, hub } = setup();
    const id = store.createSession("global");
    const alive = fakeClient("alive");
    let alive_dead = true;
    const dead: HubClient = { clientName: "dead", deliver() { return alive_dead; } };
    hub.attach(alive, id, 0);
    hub.attach(dead, id, 0);
    alive_dead = false; // mark dead client as dead
    hub.broadcastTransient(id, { type: "assistant_delta", sessionId: id, threadId: "main", delta: "x" });
    // the dead client's eviction appended+broadcast a harness_detached that alive saw
    expect(alive.received[alive.received.length - 1]).toMatchObject({ type: "harness_detached", clientName: "dead" });
  });
});
