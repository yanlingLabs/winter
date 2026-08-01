import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import {
  buildSpawnablePlugins,
  createSupervisedInstance,
  installSampleEcho,
  isPidAlive,
  kill9,
  waitFor,
  writeAndLoadSettings,
  type SupervisedInstance,
} from "./supervised-fixtures";

/**
 * Phase 4d-i Task 5 — the 4d-i consolidated gate: everything Tasks 1-4 built (live tile broadcast,
 * shortcut/tile-action harness->plugin push, the SDK's `ctx.updateTile`/`onShortcut`/
 * `onTileAction`, `plugins.list` supervisor-status enrichment), proven end to end against a REAL
 * spawned `sample-echo` child process — no scripted/fake connection on the PLUGIN side anywhere in
 * this file (same discipline as `gate-4b.test.ts`/`battery-limiter-e2e.test.ts`; the only scripted
 * connection here is the ADMIN/HARNESS side, a raw `TestClient` socket standing in for a future
 * dashboard — exactly the boundary `battery-limiter-e2e.test.ts` draws for its scripted PROVIDER).
 *
 * Six assertions, chained against the SAME real child throughout (task-5-brief.md's Step 2):
 *  (a) initial `tile.update` (the SDK's once-at-connect paint) lands: the harness receives a
 *      `plugin_tile_updated` and `plugins.contrib` reflects it.
 *  (b) invoking the `echo` tool (the SAME `registry.execute` bridge `gate-4b.test.ts` drives tools
 *      through) makes the REAL child call `ctx.updateTile` mid-session — the harness receives a
 *      SECOND, independent `plugin_tile_updated` with the INCREMENTED value. This is the key proof
 *      Task 3 exists for: a live push during an open connection, not just the once-at-connect one.
 *  (c) `shortcut.invoke {pluginId, shortcutId}` (Task 2's harness->plugin push) reaches the real
 *      child's dispatch loop, which calls `onShortcut` (examples/sample-echo/index.ts) — the
 *      harness sees the tile bump again, proving the callback genuinely ran in the real process.
 *  (d) `tile.action {pluginId, actionId}` likewise reaches `onTileAction`, which resets the
 *      counter — the harness sees the tile drop back to its initial value.
 *  (e) `plugins.list` (Task 4) reports the live child's `status: "running"`.
 *  (f) `kill -9`ing the real child's OS pid drops its connection — the harness receives a THIRD
 *      `plugin_tile_updated` with `tile: null` (Task 1's disconnect-clear) and `plugins.contrib` no
 *      longer lists the plugin at all.
 *
 * `examples/sample-echo/index.ts`'s own module doc comment explains how `onShortcut`/
 * `onTileAction` push a live tile: the SDK hands both callbacks a `ctx` argument directly (fix
 * wave 1, plugin-sdk's `PluginDefinition`), so neither depends on a prior tool call having run
 * first. (b) still runs before (c)/(d) below, but only so each step builds on the previous one's
 * counter value (0 -> 1 -> 2 -> 0) for an unambiguous per-step assertion, not because `ctx`
 * availability requires it.
 */

/** Minimal raw test client speaking NDJSON JSON-RPC — same shape as server.test.ts's own
 *  `TestClient` and battery-limiter-e2e.test.ts's copy (duplicated per-file, see those files' own
 *  doc comments), trimmed to only what this suite's scripted ADMIN/HARNESS connection needs: hello,
 *  request/response, and waiting for a pushed notification. */
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

  async hello(token: string, clientName = "dashboard"): Promise<any> {
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

function isPluginTileUpdated(n: any, pluginId: string): boolean {
  return n.method === METHODS.event && n.params?.type === "plugin_tile_updated" && n.params?.pluginId === pluginId;
}

describe("4d-i gate: live tiles + shortcut/tile-action round-trip (real sample-echo child)", () => {
  test(
    "initial tile paint -> live tile push on tool call -> shortcut.invoke bump -> tile.action reset -> plugins.list running -> kill clears tile + contrib",
    async () => {
      const pluginId = "sample-echo";
      const home = mkdtempSync(join(tmpdir(), "norma-gate-4d-i-"));
      installSampleEcho(home, pluginId);
      const settings = writeAndLoadSettings(home, pluginId);
      const socketPath = join(home, "core.sock");

      const spawnable = buildSpawnablePlugins(home, settings);
      if (spawnable.map((p) => p.id).join(",") !== pluginId) {
        throw new Error(`sanity: pluginSpawnEligible did not pick up ${pluginId} (got ${JSON.stringify(spawnable.map((p) => p.id))})`);
      }

      // `plugins: true` (not `hardware: true` — this gate never touches ctx.hardware()) wires just
      // enough PluginStore machinery for (e)'s `plugins.list` status assertion below.
      const inst: SupervisedInstance = await createSupervisedInstance({ home, socketPath, plugins: true });

      // The harness connects and hellos BEFORE startAll() spawns the child — `plugin_tile_updated`
      // (like `session_created`) is a one-shot broadcast to whoever is in `harnessConns` at the
      // instant it fires (ipc/server.ts), not a queued/replayed event; a harness connecting AFTER
      // the child's once-at-connect tile push would simply miss it forever. Getting (a)'s initial
      // broadcast at all REQUIRES this ordering — `plugins.contrib` below is a live read, so it
      // works regardless, but the broadcast itself does not.
      const tokens = await inst.authority.ensureTokens();
      const harness = await TestClient.connect(socketPath);
      await harness.hello(tokens.harness, "dashboard");

      inst.supervisor.startAll(spawnable);
      await waitFor(() => inst.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" for ${pluginId}`);
      await waitFor(() => inst.registry.has(`plugin__${pluginId}__echo`), 5_000, `plugin__${pluginId}__echo registered`);

      // --- (a) initial tile.update (once-at-connect paint) ---
      const initial = await harness.waitForNotification((n) => isPluginTileUpdated(n, pluginId));
      expect(initial.params.sessionId).toBe("$system"); // SYSTEM_SESSION_ID sentinel — session-less event
      expect(initial.params.tile).toEqual({ title: "echo", value: "0", actions: [{ id: "reset", label: "Reset" }] });

      const contribInitial = await harness.request(METHODS.pluginsContrib, {});
      expect(contribInitial.result.entries).toEqual([{ pluginId, shortcuts: [{ id: "bump", description: "Bump the echo counter" }], tile: { title: "echo", value: "0", actions: [{ id: "reset", label: "Reset" }] } }]);

      // --- (b) invoking `echo` -> the REAL child's `run` calls ctx.updateTile mid-session ---
      harness.notifications.length = 0; // isolate this step's broadcast from the initial paint above
      const echoOutcome = await inst.registry.execute(
        `plugin__${pluginId}__echo`,
        { text: "hi" },
        { cwd: "/", roots: ["/"], sessionId: "gate-4d-i" },
      );
      expect(echoOutcome.isError).toBe(false);
      const echoResult = JSON.parse(echoOutcome.output) as { echo: string; pluginPid: number };
      expect(echoResult.echo).toBe("hi");
      expect(isPidAlive(echoResult.pluginPid)).toBe(true);
      const childPid = echoResult.pluginPid;

      const afterEcho = await harness.waitForNotification((n) => isPluginTileUpdated(n, pluginId));
      expect(afterEcho.params.tile).toEqual({ title: "echo", value: "1", actions: [{ id: "reset", label: "Reset" }] }); // INCREMENTED — proves the live push, not a replay of the initial paint

      // --- (c) shortcut.invoke -> the real child's onShortcut ran (tile bumps again) ---
      harness.notifications.length = 0;
      const shortcutRes = await harness.request(METHODS.shortcutInvoke, { pluginId, shortcutId: "bump" });
      expect(shortcutRes.result).toEqual({ ok: true });

      const afterShortcut = await harness.waitForNotification((n) => isPluginTileUpdated(n, pluginId));
      expect(afterShortcut.params.tile).toEqual({ title: "echo", value: "2", actions: [{ id: "reset", label: "Reset" }] });

      // --- (d) tile.action -> the real child's onTileAction ran (tile resets) ---
      // Notifications cleared FIRST: at this point the array holds step (c)'s stale entry (value
      // "2", the shortcut-bump broadcast) — without clearing, waitForNotification would match that
      // stale entry immediately, and the assertion below would fail loudly on a value mismatch
      // ("2" vs the expected "0"), not silently prove nothing.
      harness.notifications.length = 0;
      const tileActionRes = await harness.request(METHODS.tileAction, { pluginId, actionId: "reset" });
      expect(tileActionRes.result).toEqual({ ok: true });

      const afterReset = await harness.waitForNotification((n) => isPluginTileUpdated(n, pluginId));
      expect(afterReset.params.tile).toEqual({ title: "echo", value: "0", actions: [{ id: "reset", label: "Reset" }] });

      // --- (e) plugins.list reports the live child's real supervisor status ---
      const listed = await harness.request(METHODS.pluginsList, {});
      expect(listed.result.ok).toBe(true);
      const entry = listed.result.plugins.find((p: any) => p.name === pluginId);
      expect(entry?.status).toBe("running");

      // --- (f) kill -9 the real child -> disconnect clears the tile + contrib entry ---
      harness.notifications.length = 0;
      kill9(childPid);
      // Immediately stopAll() (rather than relying on timing margin): the ipc server's own
      // socket-close handler (ipc/server.ts) — which does contrib.clear + broadcastTileUpdated —
      // is a separate mechanism from PluginSupervisor's backoff/respawn bookkeeping and still
      // fires regardless of this call, but this permanently rules out PluginSupervisor's own
      // ~1000ms-later automatic respawn (backoffDelayMs(0)) ever racing the assertions below and
      // repopulating the contrib entry on a slow/contended CI box.
      inst.supervisor.stopAll();

      const cleared = await harness.waitForNotification((n) => isPluginTileUpdated(n, pluginId));
      expect(cleared.params.tile).toBeNull();

      const contribAfter = await harness.request(METHODS.pluginsContrib, {});
      expect(contribAfter.result.entries).toEqual([]);

      harness.close();
      inst.server.stop();
      inst.store.close();
      await waitFor(() => !isPidAlive(childPid), 5_000, `killed child pid ${childPid} to stay dead (no stray respawn interfering with teardown)`);
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});
