import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Holder, NewSessionEvent } from "@winter/protocol";
import { AuditLog } from "../../src/peripheral/audit";
import {
  PeripheralBroker,
  leaseDecision,
  expiredLeases,
  type LeaseDecision,
  type LeaseEntry,
  type LeaseResult,
  type LeaseTable,
  type PeripheralBrokerDeps,
  type PeripheralClass,
} from "../../src/peripheral/broker";

// -------------------------------------------------------------------------------------------
// Pure decision core — exhaustive table tests (no broker, no I/O, no clock).
// -------------------------------------------------------------------------------------------

function entry(overrides: Partial<LeaseEntry> = {}): LeaseEntry {
  return {
    leaseId: "lease_x",
    class: "noop",
    holder: { kind: "session", id: "s_x" },
    tokenHash: "hash",
    expiresAt: 1000,
    ...overrides,
  };
}

describe("leaseDecision (pure)", () => {
  const holderA: Holder = { kind: "session", id: "s_a" };
  const holderB: Holder = { kind: "session", id: "s_b" };

  const cases: Array<{ name: string; state: LeaseTable; req: { class: PeripheralClass; holder: Holder }; want: LeaseDecision }> = [
    {
      name: "no provider + empty table → no_provider",
      state: { hasProvider: false, entries: new Map<PeripheralClass, LeaseEntry>() },
      req: { class: "noop", holder: holderA },
      want: { kind: "no_provider" },
    },
    {
      name: "no_provider takes priority over a (stale) held entry",
      state: { hasProvider: false, entries: new Map<PeripheralClass, LeaseEntry>([["noop", entry({ class: "noop", holder: holderB })]]) },
      req: { class: "noop", holder: holderA },
      want: { kind: "no_provider" },
    },
    {
      name: "provider present, class free → grant",
      state: { hasProvider: true, entries: new Map<PeripheralClass, LeaseEntry>() },
      req: { class: "noop", holder: holderA },
      want: { kind: "grant" },
    },
    {
      name: "contention identity: class held by ANOTHER holder → held, carrying that holder",
      state: { hasProvider: true, entries: new Map<PeripheralClass, LeaseEntry>([["noop", entry({ class: "noop", holder: holderB })]]) },
      req: { class: "noop", holder: holderA },
      want: { kind: "held", holder: holderB },
    },
    {
      name: "self-collision: class already held by the SAME holder is still 'held' (re-acquire goes through renew(), not lease() again)",
      state: { hasProvider: true, entries: new Map<PeripheralClass, LeaseEntry>([["noop", entry({ class: "noop", holder: holderA })]]) },
      req: { class: "noop", holder: holderA },
      want: { kind: "held", holder: holderA },
    },
    {
      name: "per-class independence: class A held does not block a request for class B",
      state: { hasProvider: true, entries: new Map<PeripheralClass, LeaseEntry>([["screenshot", entry({ class: "screenshot", holder: holderB })]]) },
      req: { class: "noop", holder: holderA },
      want: { kind: "grant" },
    },
    {
      name: "per-class independence: class A held does not block a DIFFERENT holder's request for class A's sibling",
      state: {
        hasProvider: true,
        entries: new Map<PeripheralClass, LeaseEntry>([
          ["screenshot", entry({ class: "screenshot", holder: holderA })],
          ["ax-read", entry({ class: "ax-read", holder: holderB })],
        ]),
      },
      req: { class: "input-drive", holder: holderA },
      want: { kind: "grant" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => expect(leaseDecision(c.state, c.req)).toEqual(c.want));
  }
});

describe("expiredLeases (pure)", () => {
  test("empty table → []", () => {
    expect(expiredLeases({ hasProvider: true, entries: new Map<PeripheralClass, LeaseEntry>() }, 1000)).toEqual([]);
  });

  test("boundary: nowMs strictly before expiresAt → not expired", () => {
    const state: LeaseTable = { hasProvider: true, entries: new Map([["noop", entry({ leaseId: "L1", expiresAt: 1000 })]]) };
    expect(expiredLeases(state, 999)).toEqual([]);
  });

  test("boundary: nowMs === expiresAt → expired (inclusive)", () => {
    const state: LeaseTable = { hasProvider: true, entries: new Map([["noop", entry({ leaseId: "L1", expiresAt: 1000 })]]) };
    expect(expiredLeases(state, 1000)).toEqual(["L1"]);
  });

  test("boundary: nowMs after expiresAt → expired", () => {
    const state: LeaseTable = { hasProvider: true, entries: new Map([["noop", entry({ leaseId: "L1", expiresAt: 1000 })]]) };
    expect(expiredLeases(state, 1001)).toEqual(["L1"]);
  });

  test("per-class independence: only due entries are reported", () => {
    const state: LeaseTable = {
      hasProvider: true,
      entries: new Map<PeripheralClass, LeaseEntry>([
        ["noop", entry({ leaseId: "L1", class: "noop", expiresAt: 1000 })],
        ["screenshot", entry({ leaseId: "L2", class: "screenshot", expiresAt: 5000 })],
      ]),
    };
    expect(expiredLeases(state, 2000)).toEqual(["L1"]);
  });
});

// -------------------------------------------------------------------------------------------
// PeripheralBroker — behavior tests with fake deps. AuditLog is real (backed by a temp file):
// it's cheap, and reading the file back is the most direct way to verify the audit trail.
// -------------------------------------------------------------------------------------------

interface Fakes {
  emitted: Array<{ sessionId: string; event: NewSessionEvent }>;
  pushed: NewSessionEvent[];
  pushReturn: boolean;
  policyReturn: "granted" | "denied";
  policyCalls: Array<{ sessionId: string; class: PeripheralClass }>;
}

function setup(overrides: Partial<PeripheralBrokerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "winter-broker-"));
  const auditPath = join(dir, "audit.jsonl");
  const audit = new AuditLog(auditPath);
  const fakes: Fakes = { emitted: [], pushed: [], pushReturn: true, policyReturn: "granted", policyCalls: [] };

  const deps: PeripheralBrokerDeps = {
    audit,
    // Records BOTH sessionId and class — the broker now passes the class straight through as a
    // call argument (no more `peripheralClassHint` side-channel), so this fake's call log is the
    // most direct way to assert that argument actually carries the right class.
    policy: async (sessionId, cls) => { fakes.policyCalls.push({ sessionId, class: cls }); return fakes.policyReturn; },
    emitTransient: (sessionId, event) => { fakes.emitted.push({ sessionId, event }); },
    pushToProvider: (event) => { fakes.pushed.push(event); return fakes.pushReturn; },
    ...overrides,
  };
  const broker = new PeripheralBroker(deps);
  const auditRows = (): Array<Record<string, unknown>> =>
    readFileSync(auditPath, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));

  return { broker, fakes, auditRows };
}

function expectGranted(r: LeaseResult): { leaseId: string; token: string; expiresAt: number } {
  if (!("leaseId" in r)) throw new Error(`expected a grant, got ${JSON.stringify(r)}`);
  return r;
}

describe("PeripheralBroker", () => {
  test("lease() with no advertised provider → {code:'no_provider'}, policy never consulted", async () => {
    const { broker, fakes } = setup();
    const res = await broker.lease({ sessionId: "s1", class: "noop" });
    expect(res).toEqual({ code: "no_provider" });
    expect(fakes.policyCalls).toEqual([]);
  });

  test("grant: advertise + auto-granted policy → typed grant result + lease_granted event", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const res = await broker.lease({ sessionId: "s1", class: "noop" });
    const g = expectGranted(res);
    expect(g.leaseId).toBeTruthy();
    expect(g.token).toBeTruthy();
    expect(g.expiresAt).toBeGreaterThan(Date.now());
    expect(fakes.policyCalls).toEqual([{ sessionId: "s1", class: "noop" }]);

    const granted = fakes.emitted.find((e) => e.event.type === "lease_granted");
    expect(granted).toBeDefined();
    expect(granted!.sessionId).toBe("s1");
    expect(granted!.event).toMatchObject({
      type: "lease_granted", sessionId: "s1", threadId: "main",
      leaseId: g.leaseId, class: "noop", holder: { kind: "session", id: "s1" }, expiresAt: g.expiresAt,
    });
    // Spec §A1 ("no token, no service"): lease_granted carries the RAW token's sha256 hash (never
    // the raw token itself) so the provider can validate it on every call — assert the emitted
    // hash actually matches the token the requester got back, not just that SOME string is present.
    const emittedTokenHash = (granted!.event as { tokenHash?: string }).tokenHash;
    expect(emittedTokenHash).toBe(createHash("sha256").update(g.token).digest("hex"));
  });

  test("L2 fix: advertise() audits the advertiser's clientName, so provider displacement leaves a forensic trace", () => {
    const { broker, auditRows } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }], "harness-window-1");
    broker.advertise({}, [{ class: "noop", tccGranted: true }], "harness-window-2"); // displaces it

    const rows = auditRows().filter((r) => r.action === "advertise");
    expect(rows.map((r) => r.clientName)).toEqual(["harness-window-1", "harness-window-2"]);

    // Omitting clientName (existing call sites/tests that don't care about identity) still works
    // — defaults to "" rather than throwing or leaving the field undefined-and-absent-vs-missing.
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    expect(auditRows().filter((r) => r.action === "advertise").at(-1)?.clientName).toBe("");
  });

  test("policy denial → {code:'denied'}, no entry created", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    fakes.policyReturn = "denied";

    const res = await broker.lease({ sessionId: "s1", class: "noop" });
    expect(res).toEqual({ code: "denied" });

    // The class is still free — a subsequent grant succeeds.
    fakes.policyReturn = "granted";
    expect("leaseId" in (await broker.lease({ sessionId: "s1", class: "noop" }))).toBe(true);
  });

  test("held-with-identity: contention is rejected immediately, carrying the current holder", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g1 = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    const res = await broker.lease({ sessionId: "s2", class: "noop" });
    expect(res).toEqual({ code: "lease_held", holder: { kind: "session", id: "s1" } });
    expect(g1.leaseId).toBeTruthy(); // s1's lease is untouched by the contender
  });

  test("renew extends the SAME lease's expiresAt (leaseId/token unchanged)", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const origNow = Date.now;
    let g: { leaseId: string; token: string; expiresAt: number };
    try {
      Date.now = () => 1_000_000;
      g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
      expect(g.expiresAt).toBe(1_000_000 + 15_000);

      Date.now = () => 1_005_000;
      const renewed = broker.renew({ leaseId: g.leaseId, token: g.token });
      expect(renewed).toEqual({ ok: true, expiresAt: 1_005_000 + 15_000 });
    } finally {
      Date.now = origNow;
    }
  });

  test("renew() on an unknown leaseId → {code:'not_found'}", () => {
    const { broker } = setup();
    expect(broker.renew({ leaseId: "nope", token: "t" })).toEqual({ code: "not_found" });
  });

  test("L1 fix: renew() rejects a lease past expiresAt but not yet swept (the pre-sweep window) instead of resurrecting it", async () => {
    // The expiry sweep only runs on its own SWEEP_INTERVAL_MS cadence (~1s) — a renew can land
    // strictly AFTER expiresAt but strictly BEFORE the sweep has gotten around to dropping the
    // entry. Without the L1 fix, renew() only checked leaseId/token, so this window let an
    // already-dead lease be renewed back to life. `broker.sweep()` is deliberately never called
    // here — the entry must still be sitting in the table, unswept, when renew() rejects it.
    const { broker, auditRows } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const origNow = Date.now;
    let g: { leaseId: string; token: string; expiresAt: number };
    try {
      Date.now = () => 1_000_000;
      g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
      expect(g.expiresAt).toBe(1_000_000 + 15_000);

      Date.now = () => g.expiresAt + 1; // past expiry, pre-sweep — the exact window L1 closes
      expect(broker.renew({ leaseId: g.leaseId, token: g.token })).toEqual({ code: "expired" });
    } finally {
      Date.now = origNow;
    }

    const row = auditRows().find((r) => r.action === "renew_failed" && r.reason === "expired");
    expect(row).toBeDefined();
    expect(row).toMatchObject({ kind: "lease", action: "renew_failed", leaseId: g.leaseId, class: "noop", reason: "expired" });
  });

  test("L1 fix: renew() at exactly expiresAt (inclusive boundary, matching expiredLeases) is also rejected", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const origNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

      Date.now = () => g.expiresAt; // exactly at the boundary — expired (inclusive)
      expect(broker.renew({ leaseId: g.leaseId, token: g.token })).toEqual({ code: "expired" });

      Date.now = () => g.expiresAt - 1; // one ms before — still renewable
      expect(broker.renew({ leaseId: g.leaseId, token: g.token })).toMatchObject({ ok: true });
    } finally {
      Date.now = origNow;
    }
  });

  test("expiry fires lease_lost(reason:'expired') + audit at exactly expiresAt (sweep called directly, no real wait)", async () => {
    const { broker, fakes, auditRows } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const origNow = Date.now;
    let g: { leaseId: string; token: string; expiresAt: number };
    try {
      Date.now = () => 1_000_000;
      g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
    } finally {
      Date.now = origNow;
    }

    broker.sweep(g.expiresAt - 1); // one ms before — not yet expired
    expect(fakes.emitted.some((e) => e.event.type === "lease_lost")).toBe(false);

    broker.sweep(g.expiresAt); // exactly at the boundary — expired (inclusive)
    const lost = fakes.emitted.find((e) => e.event.type === "lease_lost");
    expect(lost).toBeDefined();
    expect(lost!.sessionId).toBe("s1");
    expect(lost!.event).toMatchObject({ type: "lease_lost", leaseId: g.leaseId, class: "noop", reason: "expired" });

    const auditRow = auditRows().find((r) => r.action === "lease_lost" && r.reason === "expired" && r.leaseId === g.leaseId);
    expect(auditRow).toBeDefined();
    expect(auditRow).toMatchObject({ kind: "lease", action: "lease_lost", class: "noop", leaseId: g.leaseId, reason: "expired", holder: { kind: "session", id: "s1" } });

    // Gone from the table: a fresh lease for the same class grants cleanly.
    expect("leaseId" in (await broker.lease({ sessionId: "s2", class: "noop" }))).toBe(true);
  });

  test("panic-revoke-all: revoke({all:true, reason:'panic'}) drops every active lease with reason 'panic'", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }, { class: "screenshot", tccGranted: true }]);
    const g1 = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
    const g2 = expectGranted(await broker.lease({ sessionId: "s2", class: "screenshot" }));

    const res = broker.revoke({ all: true, reason: "panic" });
    expect(res).toEqual({ ok: true, revoked: 2 });

    const lostIds = fakes.emitted.filter((e) => e.event.type === "lease_lost").map((e) => (e.event as { leaseId: string }).leaseId);
    expect(new Set(lostIds)).toEqual(new Set([g1.leaseId, g2.leaseId]));
    for (const e of fakes.emitted.filter((e) => e.event.type === "lease_lost")) expect(e.event).toMatchObject({ reason: "panic" });

    // Both classes free again.
    expect("leaseId" in (await broker.lease({ sessionId: "s3", class: "noop" }))).toBe(true);
    expect("leaseId" in (await broker.lease({ sessionId: "s3", class: "screenshot" }))).toBe(true);
  });

  test("revoke(leaseId) drops only that lease, others untouched", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }, { class: "screenshot", tccGranted: true }]);
    const g1 = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
    const g2 = expectGranted(await broker.lease({ sessionId: "s2", class: "screenshot" }));

    expect(broker.revoke({ leaseId: g1.leaseId, reason: "revoked" })).toEqual({ ok: true, revoked: 1 });
    expect(broker.renew({ leaseId: g1.leaseId, token: g1.token })).toEqual({ code: "not_found" });
    expect(broker.renew({ leaseId: g2.leaseId, token: g2.token })).toMatchObject({ ok: true });
  });

  test("revoke() on an unknown leaseId is tolerant (revoked:0), not an error", () => {
    const { broker } = setup();
    expect(broker.revoke({ leaseId: "nope", reason: "revoked" })).toEqual({ ok: true, revoked: 0 });
  });

  test("provider-gone-revokes: providerGone() revokes every active lease and flips future leases to no_provider", async () => {
    const { broker, fakes } = setup();
    const conn = {};
    broker.advertise(conn, [{ class: "noop", tccGranted: true }]);
    expect(broker.isProvider(conn)).toBe(true);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    broker.providerGone();

    expect(broker.isProvider(conn)).toBe(false);
    const lost = fakes.emitted.find((e) => e.event.type === "lease_lost");
    expect(lost!.event).toMatchObject({ leaseId: g.leaseId, reason: "provider-gone" });
    expect(await broker.lease({ sessionId: "s2", class: "noop" })).toEqual({ code: "no_provider" });
  });

  test("providerGone() with no provider connected is a harmless no-op", () => {
    const { broker } = setup();
    expect(() => broker.providerGone()).not.toThrow();
  });

  test("token-mismatch-rejected: renew/release/call all reject a wrong token without mutating state", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    expect(broker.renew({ leaseId: g.leaseId, token: "wrong" })).toEqual({ code: "token_mismatch" });
    expect(broker.release({ leaseId: g.leaseId, token: "wrong" })).toEqual({ code: "token_mismatch" });
    const callRes = await broker.call({ leaseId: g.leaseId, token: "wrong", class: "noop", payloadJson: "{}" });
    expect(callRes).toEqual({ code: "token_mismatch" });
    expect(fakes.pushed).toEqual([]); // never reached the provider

    // The lease is untouched — the right token still works.
    expect(broker.renew({ leaseId: g.leaseId, token: g.token })).toMatchObject({ ok: true });
  });

  test("call() with an unknown leaseId → {code:'not_found'}", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    expect(await broker.call({ leaseId: "nope", token: "t", class: "noop", payloadJson: "{}" })).toEqual({ code: "not_found" });
  });

  test("call() for the wrong class (right leaseId, indexed under a different class) → {code:'not_found'}", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }, { class: "screenshot", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
    expect(await broker.call({ leaseId: g.leaseId, token: g.token, class: "screenshot", payloadJson: "{}" })).toEqual({ code: "not_found" });
  });

  test("call() on an expired lease → {code:'expired'}", async () => {
    const { broker } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const origNow = Date.now;
    let g: { leaseId: string; token: string; expiresAt: number };
    try {
      Date.now = () => 1_000_000;
      g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
      Date.now = () => g.expiresAt; // at the boundary — expired
      const res = await broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
      expect(res).toEqual({ code: "expired" });
    } finally {
      Date.now = origNow;
    }
  });

  test("call-timeout-10s: typed {code:'timeout'} when the provider never responds (short override, no real 10s wait)", async () => {
    const { broker, fakes } = setup({ callTimeoutMs: 20 });
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    const res = await broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
    expect(res).toEqual({ code: "timeout" });
    expect(fakes.pushed).toHaveLength(1);
    expect(fakes.pushed[0]).toMatchObject({
      type: "peripheral_call_requested", sessionId: "s1", threadId: "main",
      leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}",
    });
  });

  test("L3 fix: every call_failed audit line — all four of call()'s own rejection paths, plus failPending()'s revoke/expiry race — uniformly carries kind:'lease'", async () => {
    // Previously call()'s four early-rejection paths (not_found/token_mismatch/expired/
    // no_provider-on-delivery) logged call_failed via the plain audit() helper (no `kind`), while
    // failPending()'s OWN call_failed line (an in-flight call losing its lease to a revoke/expiry)
    // used auditLease() (kind:"lease") — same action name, two shapes on disk. All five paths
    // below must now agree.
    const { broker, fakes, auditRows } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    // 1) not_found (wrong class for a real leaseId)
    await broker.call({ leaseId: g.leaseId, token: g.token, class: "screenshot", payloadJson: "{}" });
    // 2) token_mismatch
    await broker.call({ leaseId: g.leaseId, token: "wrong", class: "noop", payloadJson: "{}" });
    // 3) no_provider (pushToProvider delivery fails despite an entry existing)
    fakes.pushReturn = false;
    await broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
    fakes.pushReturn = true;
    // 4) failPending's call_failed: an in-flight call loses its lease to a revoke
    const inFlight = broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
    broker.revoke({ leaseId: g.leaseId, reason: "revoked" });
    expect(await inFlight).toEqual({ code: "lease_gone", reason: "revoked" });

    // 5) expired — a fresh lease, aged past its own expiresAt without ever being swept.
    const origNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const g2 = expectGranted(await broker.lease({ sessionId: "s2", class: "noop" }));
      Date.now = () => g2.expiresAt;
      await broker.call({ leaseId: g2.leaseId, token: g2.token, class: "noop", payloadJson: "{}" });
    } finally {
      Date.now = origNow;
    }

    const rows = auditRows().filter((r) => r.action === "call_failed");
    expect(rows.map((r) => r.reason)).toEqual(["not_found", "token_mismatch", "no_provider", "revoked", "expired"]);
    for (const row of rows) {
      expect(row.kind).toBe("lease");
      expect(typeof row.ts).toBe("number");
      expect(row.leaseId).toBeTruthy();
    }
  });

  test("respond-correlation: respond() resolves the matching pending call by requestId, first response wins", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    const callPromise = broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: '{"echo":1}' });
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;

    expect(broker.respond({ requestId, resultJson: '{"ok":true}' })).toEqual({ ok: true, alreadyResolved: false });
    expect(await callPromise).toEqual({ ok: true, resultJson: '{"ok":true}' });

    // Late/duplicate respond is acknowledged, doesn't re-resolve or throw.
    expect(broker.respond({ requestId, resultJson: "ignored" })).toEqual({ ok: true, alreadyResolved: true });
  });

  test("respond() with an error resolves call() as a typed provider_error", async () => {
    const { broker, fakes } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    const callPromise = broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;
    broker.respond({ requestId, error: "denied by TCC" });

    expect(await callPromise).toEqual({ code: "provider_error", message: "denied by TCC" });
  });

  test("respond() for an unknown requestId reports alreadyResolved without throwing", () => {
    const { broker } = setup();
    expect(broker.respond({ requestId: "nope" })).toEqual({ ok: true, alreadyResolved: true });
  });

  test("a revoke while a call() is in flight fails the pending call immediately (doesn't wait out the call timeout)", async () => {
    const { broker } = setup({ callTimeoutMs: 60_000 }); // would hang the test if the fast-fail path didn't fire
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));

    const callPromise = broker.call({ leaseId: g.leaseId, token: g.token, class: "noop", payloadJson: "{}" });
    broker.revoke({ leaseId: g.leaseId, reason: "revoked" });

    expect(await callPromise).toEqual({ code: "lease_gone", reason: "revoked" });
  });

  test("policy race: contention arising WHILE a slow (ask-mode) policy wait is in flight is re-checked on resolve, never double-granted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-broker-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    let releaseS1!: () => void;
    const gate = new Promise<void>((resolve) => { releaseS1 = resolve; });

    const broker = new PeripheralBroker({
      audit,
      policy: async (sessionId, _cls) => { if (sessionId === "s1") await gate; return "granted"; },
      emitTransient: () => {},
      pushToProvider: () => true,
    });
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);

    const p1 = broker.lease({ sessionId: "s1", class: "noop" }); // parked awaiting policy
    const r2 = expectGranted(await broker.lease({ sessionId: "s2", class: "noop" })); // completes first

    releaseS1();
    const r1 = await p1;
    expect(r1).toEqual({ code: "lease_held", holder: { kind: "session", id: "s2" } });
    expect(r2.leaseId).toBeTruthy();
  });

  test("audit-trail-complete: a full advertise→grant→renew→release sequence is fully recorded", async () => {
    const { broker, auditRows } = setup();
    broker.advertise({}, [{ class: "noop", tccGranted: true }]);
    const g = expectGranted(await broker.lease({ sessionId: "s1", class: "noop" }));
    broker.renew({ leaseId: g.leaseId, token: g.token });
    broker.release({ leaseId: g.leaseId, token: g.token });

    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual(["advertise", "lease_grant", "renew", "lease_lost"]);
    expect(rows[3]).toMatchObject({ kind: "lease", action: "lease_lost", reason: "released", leaseId: g.leaseId, class: "noop", holder: { kind: "session", id: "s1" } });
    // requester identity + class + lease id (spec §A1) on every lease-identifying line
    for (const row of rows.slice(1)) {
      expect(row.leaseId).toBe(g.leaseId);
      expect(row.class).toBe("noop");
      // Lease entries have kind: "lease"
      expect(row.kind).toBe("lease");
      // Holder is a {kind, id} object (not a bare sessionId)
      if (row.action !== "renew" && row.action !== "renew_failed" && row.action !== "lease_denied") {
        expect(row.holder).toMatchObject({ kind: expect.any(String), id: expect.any(String) });
      }
    }
    for (const row of rows) expect(typeof row.ts).toBe("number");
  });
});
