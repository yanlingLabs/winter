import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import {
  buildSpawnablePlugins,
  createSupervisedInstance,
  installBatteryLimiter,
  waitFor,
  writeAndLoadSettings,
  type SupervisedInstance,
} from "./supervised-fixtures";

/**
 * Phase 4c Task 5 — the `ctx.hardware()` round-trip, proven end to end against a REAL `bun
 * index.ts` battery-limiter child process (installed via `installBatteryLimiter`, same
 * install-and-rewrite machinery `supervised-e2e.test.ts` uses for sample-echo — see
 * `supervised-fixtures.ts`'s doc comment). Only ONE thing here is scripted: the "provider"
 * connection (Norma.app's XPC helper stand-in) — a raw `TestClient` socket that hellos as a
 * harness, advertises itself via `peripheral.advertise`, and answers the `hardware_requested` push
 * with `hardware.respond`. That is deliberate, not a shortcut: this suite has no way to drive a
 * real XPC connection to a real NormaHelper daemon (there's no helper process in the test
 * environment at all — Task 3's NormaHelper is a separate, un-spawnable-here macOS system
 * daemon), so the provider boundary is exactly where core's OWN spec draws the seam between
 * "core's job" and "Norma.app's job" (design spec §5) — the same boundary
 * `server.test.ts`'s "hardware.request / hardware.respond" suite already stubs, just reused here
 * one layer further out, with a REAL plugin process (not a scripted "plugin" TestClient) on the
 * other end.
 *
 * Everything between the real child process and the scripted provider is production code, wired
 * exactly like `daemon.ts` does it: `registry.execute` -> `PluginSupervisor.invoke` -> the real
 * child's `plugin_tool_invoke` -> the REAL `examples/battery-limiter/index.ts` tool handler ->
 * `ctx.hardware()` (this task's new SDK surface) -> `hardware.request` over the plugin's own
 * socket -> `HardwareBroker.request` -> `pushToProvider` -> the scripted provider's
 * `hardware_requested` notification -> `hardware.respond` -> back through the same chain to the
 * tool handler's return value -> `plugin.toolResult` -> `registry.execute`'s resolved outcome.
 */

/** Minimal raw test client speaking NDJSON JSON-RPC — same shape as server.test.ts's own
 *  `TestClient` (duplicated per-file there too; see that file's doc comment), trimmed to only
 *  what this suite's scripted PROVIDER connection needs: hello, one request/response, and
 *  waiting for a pushed notification. */
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

  async hello(token: string, clientName = "hw-provider"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  close(): void { this.socket.end(); }

  async waitForNotification(predicate: (n: any) => boolean, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.notifications.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for notification");
  }
}

/** Connects a harness connection and advertises it as THE provider (same
 *  `peripheral.advertise` + `providerLink.setWriter` precedent `server.test.ts`'s
 *  `bootHardwareServer`/`connectProvider` uses) — the SAME connection `ProviderLink` then routes
 *  `hardware_requested` pushes to. */
async function connectProvider(socketPath: string, harnessToken: string): Promise<TestClient> {
  const p = await TestClient.connect(socketPath);
  await p.hello(harnessToken);
  await p.request(METHODS.peripheralAdvertise, { classes: [] });
  return p;
}

describe("battery-limiter ctx.hardware round-trip (real Bun child process, scripted provider)", () => {
  let inst: SupervisedInstance | null = null;
  let provider: TestClient | null = null;

  afterEach(() => {
    provider?.close();
    provider = null;
    if (inst) { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); inst = null; }
  });

  test(
    "set_charge_limit round-trips through a real child's ctx.hardware() to a scripted provider and back; get_charge_limit too; tile starts \"unknown\"",
    async () => {
      const pluginId = "battery-limiter";
      const home = mkdtempSync(join(tmpdir(), "norma-battery-limiter-e2e-"));
      installBatteryLimiter(home, pluginId);
      const settings = writeAndLoadSettings(home, pluginId, { hardwareConsent: true });
      const socketPath = join(home, "core.sock");

      const spawnable = buildSpawnablePlugins(home, settings);
      if (spawnable.map((p) => p.id).join(",") !== pluginId) {
        throw new Error(`sanity: pluginSpawnEligible did not pick up ${pluginId} (got ${JSON.stringify(spawnable.map((p) => p.id))})`);
      }

      inst = await createSupervisedInstance({ home, socketPath, hardware: true });
      inst.supervisor.startAll(spawnable);

      await waitFor(() => inst?.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" for ${pluginId}`);
      await waitFor(
        () => !!(inst?.registry.has(`plugin__${pluginId}__set_charge_limit`) && inst?.registry.has(`plugin__${pluginId}__get_charge_limit`)),
        5_000,
        `plugin__${pluginId}__{set_charge_limit,get_charge_limit} registered`,
      );

      // Tile pushed once at registration, before any hardware call has ever resolved — the
      // example's own `lastKnownLimit` module state starts undefined.
      await waitFor(() => inst?.contrib.get(pluginId)?.tile !== undefined, 2_000, `tile.update landed for ${pluginId}`);
      expect(inst.contrib.get(pluginId)?.tile).toEqual({ title: "Battery Limiter", value: "unknown" });

      const tokens = await inst.authority.ensureTokens();
      provider = await connectProvider(socketPath, tokens.harness);

      // --- set_charge_limit {percent: 80} ---
      const setPromise = inst.registry.execute(
        `plugin__${pluginId}__set_charge_limit`,
        { percent: 80 },
        { cwd: "/", roots: ["/"], sessionId: "battery-e2e" },
      );
      const setPushed = await provider.waitForNotification(
        (n) => n.method === METHODS.event && n.params?.type === "hardware_requested" && n.params?.verb === "setChargeLimit",
      );
      expect(JSON.parse(setPushed.params.argsJson)).toEqual({ percent: 80 });
      const setRespond = await provider.request(METHODS.hardwareRespond, {
        requestId: setPushed.params.requestId, resultJson: JSON.stringify({ percent: 80 }),
      });
      expect(setRespond.result).toEqual({ ok: true });

      const setOutcome = await setPromise;
      expect(setOutcome.isError).toBe(false);
      expect(JSON.parse(setOutcome.output)).toEqual({ percent: 80 });

      // Phase 4d-i Task 5 (closes the 4b "battery-limiter tile shows unknown" bug): set_charge_limit's
      // `run` now AWAITS `ctx.updateTile(...)` before returning (examples/battery-limiter/index.ts),
      // so by the time `setPromise` above has resolved (its `plugin.toolResult` is sent strictly
      // AFTER the tile.update ack is received — same ordered connection, no race), the live push has
      // already landed in the contrib registry. No longer "registration-time snapshot only".
      expect(inst.contrib.get(pluginId)?.tile).toEqual({ title: "Battery Limiter", value: "80%" });

      // --- get_charge_limit {} — a second, independent round-trip through the SAME real child ---
      const getPromise = inst.registry.execute(
        `plugin__${pluginId}__get_charge_limit`,
        {},
        { cwd: "/", roots: ["/"], sessionId: "battery-e2e" },
      );
      const getPushed = await provider.waitForNotification(
        (n) => n.method === METHODS.event && n.params?.type === "hardware_requested" && n.params?.verb === "getChargeLimit",
      );
      expect(getPushed.params.argsJson).toBe("{}");
      await provider.request(METHODS.hardwareRespond, {
        requestId: getPushed.params.requestId, resultJson: JSON.stringify({ percent: 65 }),
      });

      const getOutcome = await getPromise;
      expect(getOutcome.isError).toBe(false);
      expect(JSON.parse(getOutcome.output)).toEqual({ percent: 65 });

      // get_charge_limit's own live push (same await-before-return ordering as set above) — the
      // SECOND independent tile.update this connection has sent, proving the live push isn't a
      // one-off tied to set_charge_limit specifically.
      expect(inst.contrib.get(pluginId)?.tile).toEqual({ title: "Battery Limiter", value: "65%" });
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});
