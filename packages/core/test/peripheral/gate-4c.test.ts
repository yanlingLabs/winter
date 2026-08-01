import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import {
  buildSpawnablePlugins,
  createSupervisedInstance,
  installBatteryLimiter,
  waitFor,
  writeAndLoadSettings,
  type SupervisedInstance,
} from "../plugins/supervised-fixtures";

// =================================================================================================
// Phase 4c Task 6 — the phase gate (spec §5, plan Task 6): proves the hardware broker's
// routing/consent/timeout/identity paths against the REAL production wiring (createSupervisedInstance
// + startIpcServer, exactly what daemon.ts assembles), mirroring 2f's own gate precedent
// (peripheral/e2e.test.ts) — a standalone sign-off artifact, deliberately overlapping with the
// per-behavior unit/integration coverage that already exists (peripheral/hardware.test.ts's
// HardwareBroker-in-isolation tests; server.test.ts's "hardware.request / hardware.respond" suite,
// which drives the SAME ipc consent gate with a hand-rolled, test-private harness; and
// plugins/battery-limiter-e2e.test.ts, which proves the REAL child's ctx.hardware() round-trip).
// This file does NOT re-derive a new harness the way server.test.ts's bootHardwareServer does —
// it reuses `supervised-fixtures.ts`'s `createSupervisedInstance({hardware:true})` throughout (the
// "SAME harness style" T5 built and battery-limiter-e2e.test.ts already proved out), which is both
// the cheapest path (zero new plumbing) and the most production-faithful one (PluginStore reads the
// SAME settings.json a real daemon would, not a bootHardwareServer-local `consents` override).
//
// Round-trip choice (brief: "state your choice in the report"): the CONSENTED round-trip (path 1)
// reuses the REAL `battery-limiter` child process (`installBatteryLimiter` + `supervisor.startAll`,
// same machinery `battery-limiter-e2e.test.ts` already exercises) rather than a scripted "plugin"
// TestClient — that's the one leg where a real child is genuinely cheap (the fixture already exists
// and is proven) AND adds real coverage a scripted plugin connection can't: the full
// registry.execute -> supervisor.invoke -> real child's plugin_tool_invoke -> ctx.hardware() chain.
// The five negative/identity/timeout paths (2-5) don't need a real OS process at all — consent and
// routing are decided entirely by the ipc handler + PluginStore + HardwareBroker, so those use a
// scripted "plugin" TestClient (raw hello role:"plugin", token minted via `store.mintPluginToken`,
// never spawned) — cheaper and faster, same precedent server.test.ts's own connectPlugin uses.
// =================================================================================================

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated per this codebase's own
 *  precedent (e2e.test.ts, battery-limiter-e2e.test.ts, server.test.ts all keep their own copy
 *  rather than sharing one; each file's comment explains why: it's test-private glue, not product
 *  code). Supports both harness and plugin-role hellos. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async helloHarness(token: string, clientName: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  async helloPlugin(token: string, pluginId: string): Promise<any> {
    return this.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token, clientName: pluginId, pluginId,
    });
  }

  close(): void { try { this.socket.end(); } catch { /* already closed */ } }

  async waitForNotification(predicate: (n: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.notifications.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for notification");
  }
}

function readAuditLines(home: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

/** Connects a harness connection and advertises it as THE provider (peripheral.advertise — same
 *  connection ProviderLink then routes hardware_requested pushes to). Mirrors
 *  battery-limiter-e2e.test.ts's + server.test.ts's own connectProvider exactly. */
async function connectProvider(socketPath: string, harnessToken: string, clientName = "hw-provider"): Promise<TestClient> {
  const p = await TestClient.connect(socketPath);
  await p.helloHarness(harnessToken, clientName);
  await p.request(METHODS.peripheralAdvertise, { classes: [] });
  return p;
}

/** A scripted "plugin" connection: mints a real plugin token via the SAME SessionStore the ipc
 *  server checks (`store.verifyPluginToken`), then hellos as role:"plugin" — no OS process ever
 *  spawned. This is exactly what a real battery-limiter child's SDK connection does at hello time;
 *  only the tool-call machinery downstream of hello is scripted here. */
async function connectPlugin(inst: SupervisedInstance, socketPath: string, pluginId: string): Promise<TestClient> {
  const raw = inst.store.mintPluginToken(pluginId);
  const c = await TestClient.connect(socketPath);
  const hello = await c.helloPlugin(raw, pluginId);
  if (!hello.result?.ok) throw new Error(`test setup: plugin hello failed: ${JSON.stringify(hello.error)}`);
  return c;
}

const NO_PROVIDER_MESSAGE = "hardware features require Norma.app"; // pinned to hardware.ts's literal (verified against source, not re-derived)

describe("4c gate: hardware broker paths (spec §5, plan Task 6)", () => {
  // -----------------------------------------------------------------------------------------
  // Path 1 — CONSENTED round-trip via a REAL battery-limiter child (shared across this describe:
  // spawning a real process per-test would be wasteful for a single scenario).
  // -----------------------------------------------------------------------------------------
  describe("path 1: consented plugin round-trip (real child, scripted provider)", () => {
    let inst: SupervisedInstance | null = null;
    let home = "";

    afterAll(() => {
      if (inst) { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); inst = null; }
    });

    test(
      "set_charge_limit routes broker -> scripted-provider-conn -> hardware.respond -> the real child's tool receives the limit",
      async () => {
        const pluginId = "battery-limiter";
        home = mkdtempSync(join(tmpdir(), "norma-gate4c-roundtrip-"));
        installBatteryLimiter(home, pluginId);
        const settings = writeAndLoadSettings(home, pluginId, { hardwareConsent: true });
        const socketPath = join(home, "core.sock");

        const spawnable = buildSpawnablePlugins(home, settings);
        if (spawnable.map((p) => p.id).join(",") !== pluginId) {
          throw new Error(`sanity: pluginSpawnEligible did not pick up ${pluginId} (got ${JSON.stringify(spawnable.map((p) => p.id))})`);
        }

        inst = await createSupervisedInstance({ home, socketPath, hardware: true });
        inst.supervisor.startAll(spawnable);
        // 30s, not 10s: this waits on a real plugin subprocess reaching "running", and under
        // full-suite load the wall-clock lands within 0.4% of a 10s budget (measured twice,
        // independently: 10019.92ms and 10037.62ms) while passing 8/8 in isolation. That is a
        // budget too tight for the machine, not a defect — and a flake here costs every future
        // baseline check a paragraph of explanation about which failures are "expected".
        await waitFor(() => inst!.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" for ${pluginId}`);
        await waitFor(() => inst!.registry.has(`plugin__${pluginId}__set_charge_limit`), 5_000, `plugin__${pluginId}__set_charge_limit registered`);

        const tokens = await inst.authority.ensureTokens();
        const provider = await connectProvider(socketPath, tokens.harness);

        const setPromise = inst.registry.execute(
          `plugin__${pluginId}__set_charge_limit`, { percent: 80 }, { cwd: "/", roots: ["/"], sessionId: "gate-4c-roundtrip" },
        );
        const pushed = await provider.waitForNotification(
          (n) => n.method === METHODS.event && n.params?.type === "hardware_requested" && n.params?.verb === "setChargeLimit",
        );
        expect(JSON.parse(pushed.params.argsJson)).toEqual({ percent: 80 });
        const respond = await provider.request(METHODS.hardwareRespond, {
          requestId: pushed.params.requestId, resultJson: JSON.stringify({ percent: 55 }),
        });
        expect(respond.result).toEqual({ ok: true });

        const outcome = await setPromise;
        expect(outcome.isError).toBe(false);
        expect(JSON.parse(outcome.output)).toEqual({ percent: 55 });

        // Audit completeness (path 6, success leg): one {kind:"hardware"} line, requester names the
        // REAL plugin id, outcome carries the resultJson.
        const hwLine = readAuditLines(home).find((l) => l.kind === "hardware" && l.verb === "setChargeLimit");
        expect(hwLine).toMatchObject({
          kind: "hardware", verb: "setChargeLimit", requester: { kind: "plugin", id: pluginId },
          outcome: { resultJson: JSON.stringify({ percent: 55 }) },
        });
        expect(typeof (hwLine as Record<string, unknown>).ts).toBe("number");

        provider.close();
      },
      20_000,
    );
  });

  // -----------------------------------------------------------------------------------------
  // Paths 2-6 — scripted plugin connections against createSupervisedInstance({hardware:true})
  // instances; no OS process ever spawned. Each test builds and tears down its own instance (same
  // per-test self-containment server.test.ts's hardware suite uses), so no ordering dependency
  // exists between them.
  // -----------------------------------------------------------------------------------------
  describe("paths 2-6: consent denial / no-provider / timeout / non-provider respond / audit", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

    async function bootScripted(pluginId: string, opts?: { hardwareConsent?: boolean }): Promise<{ inst: SupervisedInstance; home: string; socketPath: string }> {
      const home = mkdtempSync(join(tmpdir(), "norma-gate4c-scripted-"));
      installBatteryLimiter(home, pluginId);
      writeAndLoadSettings(home, pluginId, opts);
      const socketPath = join(home, "core.sock");
      const inst = await createSupervisedInstance({ home, socketPath, hardware: true });
      cleanups.push(() => { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); });
      return { inst, home, socketPath };
    }

    // Non-vacuity note: this file is verification of ALREADY-SHIPPED T1-T5 production code, not
    // new production code — there is no red/green cycle to run here. What makes each assertion
    // below non-trivial is that the five outcomes are MUTUALLY DISTINGUISHABLE, so a wrong wiring
    // would fail loud, not silently pass: PATH 2's plugin has a REAL provider-less setup identical
    // to PATH 3's, so if the consent check were accidentally skipped it would surface `no_provider`
    // (proving consent runs BEFORE the provider lookup), not `consent_denied`; PATH 3 vs PATH 4
    // share the same consented setup and differ only in whether a provider is connected, so a
    // broken no-provider short-circuit would surface as a 10s hang (caught by the timeout, not a
    // silently-wrong assertion); PATH 5 vs PATH 5b assert two DIFFERENT rejection codes/paths
    // (UNAUTHORIZED-after-role-check vs UNAUTHORIZED-before-dispatch) for what could easily have
    // collapsed into one generic "rejected" — each was checked against `server.ts` line-by-line
    // (cited in each test's comment) rather than assumed.

    test("PATH 2: an UNCONSENTED plugin (manifest declares battery, no hardware consent record) -> typed consent_denied, AUDITED", async () => {
      const pluginId = "battery-limiter";
      const { inst, home, socketPath } = await bootScripted(pluginId); // opts omitted -> exec consent only, no hardware
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "hardware" });

      const hwLine = readAuditLines(home).find((l) => l.kind === "hardware" && l.verb === "getChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "getChargeLimit", requester: { kind: "plugin", id: pluginId },
        outcome: { code: "consent_denied", missing: "hardware" },
      });
      expect(typeof (hwLine as Record<string, unknown>).ts).toBe("number");

      plugin.close();
    });

    test("PATH 2b: a plugin manifest WITHOUT the hardware permission (even if hardware-consented) -> typed consent_denied naming the missing permission class", async () => {
      // Belt-and-suspenders on the brief's "manifest permissions.hardware includes battery" gate:
      // proves the OTHER half of the consent AND (permission class present AND consent record
      // present) — battery-limiter's own manifest always declares permissions.hardware:["battery"],
      // so this leg swaps in a hand-seeded manifest lacking it, same precedent as
      // server.test.ts's seedBatteryPlugin({}) variant.
      const pluginId = "no-hw-permission-plugin";
      const home = mkdtempSync(join(tmpdir(), "norma-gate4c-scripted-"));
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(home, "plugins", pluginId), { recursive: true });
      writeFileSync(join(home, "plugins", pluginId, "norma-plugin.json"), JSON.stringify({
        id: pluginId, tier: "capability", permissions: { exec: true }, // no permissions.hardware at all
      }));
      writeAndLoadSettings(home, pluginId, { hardwareConsent: true });
      const socketPath = join(home, "core.sock");
      const inst = await createSupervisedInstance({ home, socketPath, hardware: true });
      cleanups.push(() => { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); });
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "battery" });

      plugin.close();
    });

    test("PATH 3: NO-PROVIDER (no provider connection registered) -> typed no_provider whose message conveys \"requires Norma.app\"", async () => {
      const pluginId = "battery-limiter";
      const { inst, home, socketPath } = await bootScripted(pluginId, { hardwareConsent: true });
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "no_provider", message: NO_PROVIDER_MESSAGE });
      expect((res.result as { message: string }).message).toContain("Norma.app");

      const hwLine = readAuditLines(home).find((l) => l.kind === "hardware" && l.verb === "getChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "getChargeLimit", requester: { kind: "plugin", id: pluginId },
        outcome: { code: "no_provider", message: NO_PROVIDER_MESSAGE },
      });
      expect(typeof (hwLine as Record<string, unknown>).ts).toBe("number");

      plugin.close();
    });

    test("PATH 4: TIMEOUT (provider registered but never responds) -> typed timeout, using NORMA_HARDWARE_TIMEOUT_MS to stay fast", async () => {
      const pluginId = "battery-limiter";
      const home = mkdtempSync(join(tmpdir(), "norma-gate4c-scripted-timeout-"));
      installBatteryLimiter(home, pluginId);
      writeAndLoadSettings(home, pluginId, { hardwareConsent: true });
      const socketPath = join(home, "core.sock");

      // HardwareBroker reads NORMA_HARDWARE_TIMEOUT_MS synchronously at construction time (see
      // hardware.ts's constructor) — set it immediately before, and restore immediately after, the
      // ONE synchronous createSupervisedInstance call that constructs it, so no other concurrently-
      // running test in this process ever observes the override.
      const orig = process.env.NORMA_HARDWARE_TIMEOUT_MS;
      process.env.NORMA_HARDWARE_TIMEOUT_MS = "80";
      const inst = await createSupervisedInstance({ home, socketPath, hardware: true });
      if (orig === undefined) delete process.env.NORMA_HARDWARE_TIMEOUT_MS; else process.env.NORMA_HARDWARE_TIMEOUT_MS = orig;
      cleanups.push(() => { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); });

      const tokens = await inst.authority.ensureTokens();
      const provider = await connectProvider(socketPath, tokens.harness); // advertised, but scripted to never answer
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const start = Date.now();
      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(Date.now() - start).toBeLessThan(5000); // well under the real 10s default — proves the override actually took
      expect(res.result).toEqual({ code: "timeout" });

      const hwLine = readAuditLines(home).find((l) => l.kind === "hardware" && l.verb === "getChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "getChargeLimit", requester: { kind: "plugin", id: pluginId },
        outcome: { code: "timeout" },
      });
      expect(typeof (hwLine as Record<string, unknown>).ts).toBe("number");

      provider.close(); plugin.close();
    });

    test("PATH 5: hardware.respond from a NON-PROVIDER connection is rejected; the real provider connection can still respond", async () => {
      const pluginId = "battery-limiter";
      const { inst, socketPath } = await bootScripted(pluginId, { hardwareConsent: true });
      const tokens = await inst.authority.ensureTokens();
      const provider = await connectProvider(socketPath, tokens.harness, "real-provider");

      const impostor = await TestClient.connect(socketPath);
      await impostor.helloHarness(tokens.harness, "impostor"); // authed harness, but never advertised -> not THE provider

      const impostorRespond = await impostor.request(METHODS.hardwareRespond, { requestId: "req_whatever" });
      expect(impostorRespond.error?.code).toBe(ERR.UNAUTHORIZED);

      // Identity check proven both ways: the REAL provider (the one that actually advertised) can
      // still answer a genuine in-flight request.
      const plugin = await connectPlugin(inst, socketPath, pluginId);
      const reqPromise = plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params?.type === "hardware_requested");
      const ok = await provider.request(METHODS.hardwareRespond, { requestId: pushed.params.requestId, resultJson: "{}" });
      expect(ok.result).toEqual({ ok: true });
      expect((await reqPromise).result).toEqual({ resultJson: "{}" });

      provider.close(); impostor.close(); plugin.close();
    });

    test("PATH 5b: hardware.respond from a plugin connection is role-rejected before dispatch — never reaches the provider-identity check at all", async () => {
      // A plugin connection isn't just "not the provider" — it's not even ALLOWED to call
      // hardware.respond (PLUGIN_ALLOWED_METHODS in server.ts omits it deliberately). Distinct
      // failure mode from PATH 5's harness-but-not-provider case: this one never reaches
      // PeripheralBroker.isProvider() at all.
      const pluginId = "battery-limiter";
      const { inst, socketPath } = await bootScripted(pluginId, { hardwareConsent: true });
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const res = await plugin.request(METHODS.hardwareRespond, { requestId: "req_1", resultJson: "{}" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      expect(res.error?.message).toMatch(/plugin role may not call/);

      plugin.close();
    });

    test("PATH 6: audit completeness — unknown_verb from a consented plugin is typed + audited (bypasses consent entirely)", async () => {
      const pluginId = "battery-limiter";
      const { inst, home, socketPath } = await bootScripted(pluginId, { hardwareConsent: true });
      const plugin = await connectPlugin(inst, socketPath, pluginId);

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "setFanSpeed" });
      expect(res.result).toEqual({ code: "unknown_verb" });

      const hwLine = readAuditLines(home).find((l) => l.kind === "hardware" && l.verb === "setFanSpeed");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "setFanSpeed", requester: { kind: "plugin", id: pluginId },
        outcome: { code: "unknown_verb" },
      });
      expect(typeof (hwLine as Record<string, unknown>).ts).toBe("number");

      plugin.close();
    });
  });
});
