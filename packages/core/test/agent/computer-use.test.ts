import { describe, expect, test } from "bun:test";
import { ComputerUseService, CU_UNAVAILABLE_MESSAGE, type PeripheralBrokerLike, type CuScheduler } from "../../src/agent/computer-use";

// A fully scriptable fake PeripheralBroker + a manual scheduler, so lease lifecycle / heartbeat /
// error mapping are exercised with zero real timers and zero Winter.app.
class FakeBroker implements PeripheralBrokerLike {
  leaseCalls: Array<{ sessionId: string; class: string }> = [];
  renewCalls: Array<{ leaseId: string }> = [];
  releaseCalls: Array<{ leaseId: string }> = [];
  callCalls: Array<{ leaseId: string; token: string; class: string; payloadJson: string }> = [];
  private leaseSeq = 0;
  // scripted overrides
  leaseResult: any = null; // when set, returned instead of a fresh grant
  renewResult: any = null;
  callResult: any = { ok: true, resultJson: "{}" };
  expiresAt = 100_000;
  /** When set, `call()` awaits this before resolving — lets a test hold an act() mid-flight to
   *  probe ComputerUseService.inFlight() deterministically (no real timers/races). */
  gate: Promise<void> | null = null;

  async lease(req: { sessionId: string; class: any }) {
    this.leaseCalls.push({ sessionId: req.sessionId, class: req.class });
    if (this.leaseResult) return this.leaseResult;
    return { leaseId: `lease_${this.leaseSeq++}`, token: `tok_${this.leaseSeq}`, expiresAt: this.expiresAt };
  }
  renew(req: { leaseId: string; token: string }) {
    this.renewCalls.push({ leaseId: req.leaseId });
    return this.renewResult ?? { ok: true as const, expiresAt: this.expiresAt + 15_000 };
  }
  release(req: { leaseId: string; token: string }) {
    this.releaseCalls.push({ leaseId: req.leaseId });
    return { ok: true as const };
  }
  async call(req: { leaseId: string; token: string; class: any; payloadJson: string }) {
    this.callCalls.push({ leaseId: req.leaseId, token: req.token, class: req.class, payloadJson: req.payloadJson });
    if (this.gate) await this.gate;
    return this.callResult;
  }
}

/** Manual scheduler: captures the heartbeat fn so a test can `tick()` it deterministically. */
function manualScheduler() {
  const fns: Array<() => void> = [];
  const scheduler: CuScheduler = {
    setInterval(fn) { fns.push(fn); return fns.length - 1; },
    clearInterval(handle) { fns[handle as number] = () => {}; },
  };
  return { scheduler, tick: () => fns.forEach((f) => f()) };
}

function makeService(broker: FakeBroker, nowMs = 0, maxIdleMs = 60_000) {
  const { scheduler, tick } = manualScheduler();
  let now = nowMs;
  const svc = new ComputerUseService({ broker, heartbeatMs: 5_000, maxIdleMs, now: () => now, scheduler });
  return { svc, tick, setNow: (n: number) => { now = n; } };
}

describe("ComputerUseService", () => {
  test("act acquires a lease then calls the broker with lease+token+class+payload", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "screenshot", '{"op":"screenshot"}');
    expect(r).toEqual({ ok: true, resultJson: "{}" });
    expect(broker.leaseCalls).toEqual([{ sessionId: "s1", class: "screenshot" }]);
    expect(broker.callCalls[0]).toMatchObject({ class: "screenshot", payloadJson: '{"op":"screenshot"}', leaseId: "lease_0" });
  });

  test("a held lease is reused across acts of the same class — leased ONCE", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "input-drive", "{}");
    await svc.act("s1", "input-drive", "{}");
    await svc.act("s1", "input-drive", "{}");
    expect(broker.leaseCalls.length).toBe(1);
    expect(broker.callCalls.length).toBe(3);
  });

  test("distinct classes lease independently", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "ax-read", "{}");
    expect(broker.leaseCalls.map((c) => c.class).sort()).toEqual(["ax-read", "screenshot"]);
  });

  test("no_provider on lease → the pinned 'unavailable' message", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "no_provider" };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE });
    expect(broker.callCalls.length).toBe(0); // never called the capability
  });

  test("denied on lease → denied kind", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "denied" };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("denied");
  });

  test("lease_held on lease → denied kind naming the holder", async () => {
    const broker = new FakeBroker();
    broker.leaseResult = { code: "lease_held", holder: { kind: "session", id: "other" } };
    const { svc } = makeService(broker);
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.kind).toBe("denied"); expect(r.message).toContain("other"); }
  });

  test("lease_gone on call → unavailable AND the cached lease is dropped (next act re-leases)", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}"); // lease #1
    broker.callResult = { code: "lease_gone", reason: "provider-gone" };
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "unavailable", message: CU_UNAVAILABLE_MESSAGE });
    // next act re-leases (cache dropped)
    broker.callResult = { ok: true, resultJson: "{}" };
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(2);
    expect(svc.holdsAny("s1")).toBe(true);
  });

  test("provider_error on call → passed through verbatim, lease KEPT (no re-lease next act)", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "screenshot", "{}"); // lease #1
    broker.callResult = { code: "provider_error", message: "screen recording permission not granted" };
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r).toEqual({ ok: false, kind: "provider_error", message: "screen recording permission not granted" });
    broker.callResult = { ok: true, resultJson: "{}" };
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(1); // still the original lease
  });

  test("timeout on call → timeout kind, lease kept", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    await svc.act("s1", "input-drive", "{}");
    broker.callResult = { code: "timeout" };
    const r = await svc.act("s1", "input-drive", "{}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
    expect(broker.leaseCalls.length).toBe(1);
  });

  test("heartbeat renews every held lease and updates expiry", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "ax-read", "{}");
    tick();
    expect(broker.renewCalls.length).toBe(2);
  });

  test("heartbeat drops a lease the broker refuses to renew", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    broker.renewResult = { code: "expired" };
    tick();
    expect(svc.holdsAny("s1")).toBe(false);
    // next act re-leases
    broker.renewResult = null;
    await svc.act("s1", "screenshot", "{}");
    expect(broker.leaseCalls.length).toBe(2);
  });

  test("a near-expiry cached lease is RENEWED on the next act — never lease()d again (self-deny trap)", async () => {
    // The broker's lease() is holder-blind: a second lease() while our own lease still holds the
    // class returns lease_held BY OUR OWN SESSION. The skew window must renew, not re-lease.
    const broker = new FakeBroker();
    broker.expiresAt = 10_000;
    const { svc, setNow } = makeService(broker, 0);
    await svc.act("s1", "screenshot", "{}");
    setNow(9_500); // within EXPIRY_SKEW_MS (1000) of expiresAt=10000
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r.ok).toBe(true);
    expect(broker.leaseCalls.length).toBe(1); // no second lease()
    expect(broker.renewCalls.length).toBe(1); // renewed instead
  });

  test("a near-expiry lease whose renew FAILS is dropped and freshly re-leased", async () => {
    const broker = new FakeBroker();
    broker.expiresAt = 10_000;
    const { svc, setNow } = makeService(broker, 0);
    await svc.act("s1", "screenshot", "{}");
    setNow(10_500); // past expiry — the broker refuses the renew
    broker.renewResult = { code: "expired" };
    broker.expiresAt = 100_000;
    const r = await svc.act("s1", "screenshot", "{}");
    expect(r.ok).toBe(true);
    expect(broker.leaseCalls.length).toBe(2); // fresh lease after the failed renew
  });

  test("concurrent first-acquisitions of the same class share ONE broker.lease() call", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    const [a, b] = await Promise.all([
      svc.act("s1", "input-drive", "{}"),
      svc.act("s1", "input-drive", "{}"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(broker.leaseCalls.length).toBe(1); // memoized in-flight acquisition
    expect(broker.callCalls.length).toBe(2);
  });

  test("idle backstop: a heartbeat tick past maxIdleMs releases everything (no eternal renewal)", async () => {
    const broker = new FakeBroker();
    const { svc, tick, setNow } = makeService(broker, 0, 60_000);
    await svc.act("s1", "screenshot", "{}");
    setNow(30_000);
    tick(); // idle 30s < 60s → renews
    expect(broker.renewCalls.length).toBe(1);
    expect(broker.releaseCalls.length).toBe(0);
    setNow(61_000);
    tick(); // idle 61s ≥ 60s → releases instead of renewing forever
    expect(broker.releaseCalls.length).toBe(1);
    expect(svc.holdsAny("s1")).toBe(false);
    // and the timer is stopped — further ticks do nothing
    tick();
    expect(broker.renewCalls.length).toBe(1);
  });

  test("an act() resets the idle clock", async () => {
    const broker = new FakeBroker();
    const { svc, tick, setNow } = makeService(broker, 0, 60_000);
    await svc.act("s1", "screenshot", "{}");
    setNow(50_000);
    await svc.act("s1", "screenshot", "{}"); // activity at t=50s
    setNow(100_000); // 50s since last act — under the 60s idle cap
    tick();
    expect(broker.releaseCalls.length).toBe(0); // renewed, not released
    expect(svc.holdsAny("s1")).toBe(true);
  });

  test("releaseSession releases every held lease and clears state", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s1", "input-drive", "{}");
    svc.releaseSession("s1");
    expect(broker.releaseCalls.length).toBe(2);
    expect(svc.holdsAny("s1")).toBe(false);
    // heartbeat is stopped: a tick renews nothing
    tick();
    expect(broker.renewCalls.length).toBe(0);
  });

  test("releaseSession on an unknown session is a no-op", () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    expect(() => svc.releaseSession("nope")).not.toThrow();
    expect(broker.releaseCalls.length).toBe(0);
  });

  test("inFlight() is false when idle, true while an act() is mid-flight, false again after it settles", async () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    expect(svc.inFlight()).toBe(false);

    let release!: () => void;
    broker.gate = new Promise((resolve) => { release = resolve; });
    const pending = svc.act("s1", "screenshot", "{}");
    // act() is now awaiting broker.call(), which is blocked on the gate — flush the microtask
    // queue (lease acquisition's own internal awaits) so execution actually reaches that point.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(svc.inFlight()).toBe(true);

    release();
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(svc.inFlight()).toBe(false);
  });

  test("releaseAll() releases every session's held leases and stops their timers", async () => {
    const broker = new FakeBroker();
    const { svc, tick } = makeService(broker);
    await svc.act("s1", "screenshot", "{}");
    await svc.act("s2", "input-drive", "{}");
    expect(svc.holdsAny("s1")).toBe(true);
    expect(svc.holdsAny("s2")).toBe(true);

    svc.releaseAll();
    expect(broker.releaseCalls.length).toBe(2);
    expect(svc.holdsAny("s1")).toBe(false);
    expect(svc.holdsAny("s2")).toBe(false);
    // timers stopped: a tick renews nothing
    tick();
    expect(broker.renewCalls.length).toBe(0);
  });

  test("releaseAll() is a no-op when there are no sessions", () => {
    const broker = new FakeBroker();
    const { svc } = makeService(broker);
    expect(() => svc.releaseAll()).not.toThrow();
    expect(broker.releaseCalls.length).toBe(0);
  });
});
