import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewSessionEvent } from "@winter/protocol";
import { AuditLog } from "../../src/peripheral/audit";
import { HardwareBroker, verbClass, type HardwareBrokerDeps, type HardwareRequester } from "../../src/peripheral/hardware";

describe("verbClass", () => {
  test("setChargeLimit and getChargeLimit both class as 'battery'", () => {
    expect(verbClass("setChargeLimit")).toBe("battery");
    expect(verbClass("getChargeLimit")).toBe("battery");
  });

  test("an unrecognized verb is null (unknown, typed-rejected)", () => {
    expect(verbClass("setFanSpeed")).toBeNull();
    expect(verbClass("")).toBeNull();
    expect(verbClass("SetChargeLimit")).toBeNull(); // case-sensitive — no fuzzy match
  });
});

// -------------------------------------------------------------------------------------------
// HardwareBroker — behavior tests with a fake pushToProvider. AuditLog is real (backed by a temp
// file), same precedent as broker.test.ts: it's cheap, and reading the file back is the most
// direct way to verify the audit trail.
// -------------------------------------------------------------------------------------------

interface Fakes {
  pushed: NewSessionEvent[];
  pushReturn: boolean;
}

function setup(overrides: Partial<HardwareBrokerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "winter-hardware-"));
  const auditPath = join(dir, "audit.jsonl");
  const audit = new AuditLog(auditPath);
  const fakes: Fakes = { pushed: [], pushReturn: true };

  const deps: HardwareBrokerDeps = {
    audit,
    pushToProvider: (event) => { fakes.pushed.push(event); return fakes.pushReturn; },
    ...overrides,
  };
  const broker = new HardwareBroker(deps);
  const auditRows = (): Array<Record<string, unknown>> =>
    existsSync(auditPath) ? readFileSync(auditPath, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l)) : [];

  return { broker, fakes, auditRows };
}

const pluginRequester: HardwareRequester = { kind: "plugin", id: "battery-limiter" };
const harnessRequester: HardwareRequester = { kind: "harness", id: "dev-cli" };

describe("HardwareBroker", () => {
  test("unknown verb → {code:'unknown_verb'} immediately, no push attempted", async () => {
    const { broker, fakes } = setup();
    const res = await broker.request({ requester: pluginRequester, verb: "setFanSpeed", argsJson: "{}" });
    expect(res).toEqual({ code: "unknown_verb" });
    expect(fakes.pushed).toEqual([]);
  });

  test("no provider (pushToProvider returns false) → typed no_provider immediately", async () => {
    const { broker } = setup({ pushToProvider: () => false });
    const res = await broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
    expect(res).toEqual({ code: "no_provider", message: "hardware features require Winter.app" });
  });

  test("a known verb pushes a hardware_requested event carrying requestId/verb/argsJson", async () => {
    const { broker, fakes } = setup();
    const callPromise = broker.request({ requester: pluginRequester, verb: "setChargeLimit", argsJson: '{"percent":80}' });
    expect(fakes.pushed).toHaveLength(1);
    // Capture requestId BEFORE any expect.any()-bearing matcher touches this object — bun:test's
    // toMatchObject replaces matched keys' values with the asymmetric matcher itself on the
    // ACTUAL object when an expect.any()/expect.stringContaining()-style matcher is used, so a
    // later read of `.requestId` off the SAME object would come back as the matcher, not the real
    // hex string, and respond() below would silently mismatch the pending map (no error — just an
    // unresolved promise that only settles via the timeout).
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
    expect(fakes.pushed[0]).toMatchObject({ type: "hardware_requested", verb: "setChargeLimit", argsJson: '{"percent":80}' });
    broker.respond({ requestId, resultJson: '{"percent":80}' });
    expect(await callPromise).toEqual({ resultJson: '{"percent":80}' });
  });

  test("argsJson defaults to '' when omitted", async () => {
    const { broker, fakes } = setup();
    const callPromise = broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
    expect(fakes.pushed[0]).toMatchObject({ argsJson: "" });
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;
    broker.respond({ requestId, resultJson: "{}" });
    await callPromise;
  });

  test("timeout: typed {code:'timeout'} when the provider never responds (short override, no real 10s wait)", async () => {
    const { broker, fakes } = setup({ timeoutMs: 20 });
    const res = await broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
    expect(res).toEqual({ code: "timeout" });
    expect(fakes.pushed).toHaveLength(1);
  });

  test("respond-correlation: respond() resolves the matching pending call by requestId, first response wins", async () => {
    const { broker, fakes } = setup();
    const callPromise = broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;

    expect(broker.respond({ requestId, resultJson: '{"percent":80}' })).toEqual({ ok: true });
    expect(await callPromise).toEqual({ resultJson: '{"percent":80}' });

    // Late/duplicate respond is a silent no-op, never an error.
    expect(broker.respond({ requestId, resultJson: "ignored" })).toEqual({ ok: true });
  });

  test("respond() with an error resolves request() as a typed provider_error", async () => {
    const { broker, fakes } = setup();
    const callPromise = broker.request({ requester: pluginRequester, verb: "setChargeLimit", argsJson: '{"percent":90}' });
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;

    broker.respond({ requestId, error: "unsupported_value" });
    expect(await callPromise).toEqual({ code: "provider_error", message: "unsupported_value" });
  });

  test("respond() for an unknown requestId is a silent no-op, never throws", () => {
    const { broker } = setup();
    expect(broker.respond({ requestId: "hwreq_nope" })).toEqual({ ok: true });
  });

  // -----------------------------------------------------------------------------------------
  // Audit trail shape: {ts, kind:"hardware", verb, requester, outcome} — one combined line per
  // request(), written once the outcome is known (immediate for unknown_verb/no_provider/timeout,
  // or at respond()-time for success/provider_error). Never two lines for one request.
  // -----------------------------------------------------------------------------------------

  test("audit trail: unknown_verb is a single {kind:'hardware'} line with the outcome embedded", async () => {
    const { broker, auditRows } = setup();
    const before = Date.now();
    await broker.request({ requester: pluginRequester, verb: "bogus" });
    const after = Date.now();

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: "hardware", verb: "bogus", requester: pluginRequester, outcome: { code: "unknown_verb" },
    });
    expect(typeof row.ts).toBe("number");
    expect(row.ts as number).toBeGreaterThanOrEqual(before);
    expect(row.ts as number).toBeLessThanOrEqual(after);
  });

  test("audit trail: no_provider is a single line", async () => {
    const { broker, auditRows } = setup({ pushToProvider: () => false });
    await broker.request({ requester: harnessRequester, verb: "getChargeLimit" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "hardware", verb: "getChargeLimit", requester: harnessRequester,
      outcome: { code: "no_provider", message: "hardware features require Winter.app" },
    });
  });

  test("audit trail: timeout is a single line", async () => {
    const { broker, auditRows } = setup({ timeoutMs: 20 });
    await broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "hardware", verb: "getChargeLimit", outcome: { code: "timeout" } });
  });

  test("audit trail: a successful round-trip is a single line, logged at respond()-time, carrying the harness requester", async () => {
    const { broker, fakes, auditRows } = setup();
    const callPromise = broker.request({ requester: harnessRequester, verb: "setChargeLimit", argsJson: '{"percent":80}' });
    expect(auditRows()).toHaveLength(0); // nothing logged yet — the request is still in flight
    const requestId = (fakes.pushed[0] as { requestId: string }).requestId;
    broker.respond({ requestId, resultJson: '{"percent":80}' });
    await callPromise;

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "hardware", verb: "setChargeLimit", requester: { kind: "harness", id: "dev-cli" },
      outcome: { resultJson: '{"percent":80}' },
    });
  });

  test("WINTER_HARDWARE_TIMEOUT_MS env var overrides the default when no explicit timeoutMs is given", async () => {
    const orig = process.env.WINTER_HARDWARE_TIMEOUT_MS;
    process.env.WINTER_HARDWARE_TIMEOUT_MS = "15";
    try {
      const { broker } = setup();
      const res = await broker.request({ requester: pluginRequester, verb: "getChargeLimit" });
      expect(res).toEqual({ code: "timeout" });
    } finally {
      if (orig === undefined) delete process.env.WINTER_HARDWARE_TIMEOUT_MS;
      else process.env.WINTER_HARDWARE_TIMEOUT_MS = orig;
    }
  });

  test("auditDenied: consent_denied writes the same shape as broker-audited outcomes", async () => {
    const { broker, auditRows } = setup();
    const before = Date.now();
    broker.auditDenied({ requester: pluginRequester, verb: "getChargeLimit", code: "consent_denied", missing: "hardware" });
    const after = Date.now();

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      kind: "hardware", verb: "getChargeLimit", requester: pluginRequester,
      outcome: { code: "consent_denied", missing: "hardware" },
    });
    expect(typeof row.ts).toBe("number");
    expect(row.ts as number).toBeGreaterThanOrEqual(before);
    expect(row.ts as number).toBeLessThanOrEqual(after);
  });

  test("auditDenied: unknown_verb writes the same shape as broker-audited outcomes", async () => {
    const { broker, auditRows } = setup();
    broker.auditDenied({ requester: harnessRequester, verb: "setFanSpeed", code: "unknown_verb" });

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "hardware", verb: "setFanSpeed", requester: harnessRequester,
      outcome: { code: "unknown_verb" },
    });
  });

});
