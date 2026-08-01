import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import {
  createSupervisedInstance,
  installSampleEcho,
  isPidAlive,
  waitFor,
  type SupervisedInstance,
} from "./supervised-fixtures";

/**
 * Phase 4d-ii Task 4 — the 4d-ii consolidated gate: the FULL plugin lifecycle
 * (plugins.install -> plugin.enable needs_consent -> plugin.enable{consent:true} hot-spawn ->
 * plugin.disable hot-stop+fresh-consent-strip -> plugin.remove) driven entirely OVER THE WIRE
 * against a REAL running daemon, with a REAL spawned `sample-echo` child at the hot-spawn step —
 * no scripted/fake connection on the PLUGIN side anywhere in this file (same discipline as
 * `gate-4b.test.ts`/`gate-4d-i.test.ts`; the only scripted connection is the ADMIN/HARNESS side, a
 * raw `TestClient` socket, exactly the boundary those gates draw for their own scripted callers).
 *
 * Task 2 (server.ts) already has narrow unit coverage of these five RPCs in server.test.ts's
 * "plugin lifecycle RPCs (Task 2)" suite, but that suite injects a FAKE spawn (`spawn: () => ({pid:
 * 9001, ...})`, `isAlivePid: () => false`) — it proves the RPC *shapes* and settings.json
 * read/write plumbing, not that a real OS process actually comes up. This gate is the missing
 * proof: `plugin.enable{consent:true}` reaches the SAME `PluginSupervisor` instance the running
 * daemon uses and it genuinely spawns a real `bun index.ts` child (verified by a `ps -p` liveness
 * check on its real OS pid, same as gate-4d-i/gate-4b), and `plugin.disable` genuinely kills it —
 * all with NO daemon restart between any of these five calls (the entire point of "applied HOT").
 *
 * Five steps, chained against the SAME running daemon throughout (task-4-brief.md's Step 1):
 *  (a) `plugins.install {source, name}` copies a fixture plugin dir — installed via
 *      `installSampleEcho` into a THROWAWAY staging dir first (never under this daemon's own
 *      plugins root), so `plugins.install` itself is the only thing that puts it under `home`'s
 *      plugins root — and returns `requiredConsents:["exec"]`/`hasMcp:false`/a consent block,
 *      NEVER touching settings.json. `plugins.list` immediately reflects it as installed but not
 *      yet enabled/consented (`mcpEnabled:false`, `consented:[]`, `status:"na"` — not spawn-
 *      eligible yet).
 *  (b) `plugin.enable {name}` (no consent) -> `{code:"needs_consent"}` with the SAME consent
 *      block, and settings.json is BYTE-IDENTICAL to before the call (no mutation on the
 *      disclosure-only path).
 *  (c) `plugin.enable {name, consent:true}` -> `{ok:true, status}`; the real child process
 *      SPAWNS on the running daemon's own `PluginSupervisor` (no restart) — proven by polling that
 *      SAME supervisor instance to "running", then round-tripping the real child's `echo` tool
 *      through the shared `ToolRegistry` and `ps -p`-verifying the OS pid it reports back is
 *      alive. `plugins.list` now reports `status:"running"`, `mcpEnabled:true`,
 *      `consented:["exec"]`.
 *  (d) `plugin.disable {name}` -> `{ok:true}`; hot-STOPS the real child (the same pid genuinely
 *      goes dead, `ps -p`-verified) and strips the consent record (fresh-consent semantics) —
 *      `plugins.list` drops back to `status:"na"`/`mcpEnabled:false`/`consented:[]`, and a
 *      following `plugin.enable {name}` (no consent) returns `needs_consent` again, proving the
 *      consent record is genuinely gone, not just the enabled flag.
 *  (e) `plugin.remove {name}` -> `{ok:true}`; `plugins.list` no longer lists the plugin at all and
 *      its directory under `home/plugins/` is gone from disk.
 */

/** Minimal raw test client speaking NDJSON JSON-RPC — same shape as server.test.ts's own
 *  `TestClient` and gate-4d-i.test.ts's copy (duplicated per-file, see those files' own doc
 *  comments), trimmed to only what this suite's scripted ADMIN/HARNESS connection needs: hello and
 *  request/response (no notification-waiting — this gate polls `plugins.list`/the real supervisor
 *  instance directly rather than waiting on a broadcast). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
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
}

describe("4d-ii gate: over-the-wire plugin lifecycle (install -> enable/consent -> hot-spawn -> disable -> remove)", () => {
  test(
    "plugins.install -> plugin.enable needs_consent (no mutation) -> plugin.enable{consent:true} hot-spawns a real child -> plugin.disable hot-stops + strips consent -> plugin.remove clears settings+dir",
    async () => {
      const pluginId = "sample-echo";
      const home = mkdtempSync(join(tmpdir(), "norma-gate-4d-ii-"));
      const settingsPath = join(home, "settings.json");
      // Plain, plugin-free settings — deliberately NOT `writeAndLoadSettings` (that helper writes
      // the plugin as already enabled+consented, exactly the end state this gate's own RPC calls
      // are supposed to produce, not the starting point).
      writeFileSync(settingsPath, JSON.stringify({
        schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" },
      }));
      const socketPath = join(home, "core.sock");

      // A fixture plugin dir NOT yet anywhere under `home`'s plugins root: `installSampleEcho`
      // copies examples/sample-echo into a THROWAWAY staging normaHome and rewrites its
      // `@norma/plugin-sdk` import to an absolute path (a bare copy has no node_modules of its
      // own) — reused here purely for that copy-and-rewrite, so `plugins.install` below is the
      // ONLY thing that ever puts the plugin under this test's real `home`.
      const srcHome = mkdtempSync(join(tmpdir(), "norma-gate-4d-ii-src-"));
      const srcDir = installSampleEcho(srcHome, pluginId);

      // `plugins: true` + `wireNormaHome: true` wires a live PluginStore AND forwards `normaHome`
      // into the IPC server (supervised-fixtures.ts) — the second is what the five lifecycle RPCs
      // need to read/write settings.json and the plugins dir directly; the first is what
      // `plugins.list` needs to enrich with fresh supervisor status. Deliberately NOT calling
      // `startAll()` — nothing is spawn-eligible yet (nothing is even installed yet), and the whole
      // point of this gate is that `plugin.enable{consent:true}` alone is what makes the real child
      // come up.
      const inst: SupervisedInstance = await createSupervisedInstance({ home, socketPath, plugins: true, wireNormaHome: true });

      const tokens = await inst.authority.ensureTokens();
      const harness = await TestClient.connect(socketPath);
      await harness.hello(tokens.harness, "dashboard");

      // --- (a) plugins.install ---
      const installRes = await harness.request(METHODS.pluginsInstall, { source: srcDir, name: pluginId });
      expect(installRes.result.ok).toBe(true);
      expect(installRes.result.name).toBe(pluginId);
      expect(installRes.result.requiredConsents).toEqual(["exec"]); // manifest declares permissions.exec + an entry
      expect(installRes.result.hasMcp).toBe(false);
      expect(installRes.result.consentBlock[0]).toBe(`plugin ${pluginId} requests:`);
      expect(installRes.result.consentBlock).toContain("entry: bun index.ts");
      expect(existsSync(join(home, "plugins", pluginId, "norma-plugin.json"))).toBe(true);

      const settingsAfterInstall = readFileSync(settingsPath, "utf8");

      const listAfterInstall = await harness.request(METHODS.pluginsList, {});
      const afterInstallEntry = listAfterInstall.result.plugins.find((p: any) => p.name === pluginId);
      expect(afterInstallEntry).toBeDefined();
      expect(afterInstallEntry.mcpEnabled).toBe(false); // not yet enabled
      expect(afterInstallEntry.consented ?? []).toEqual([]); // not yet consented
      expect(afterInstallEntry.status).toBe("na"); // not spawn-eligible (disabled/unconsented)

      // --- (b) plugin.enable with no consent -> needs_consent, NO settings mutation ---
      const enableNoConsent = await harness.request(METHODS.pluginEnable, { name: pluginId });
      expect(enableNoConsent.result.code).toBe("needs_consent");
      expect(enableNoConsent.result.requiredConsents).toEqual(["exec"]);
      expect(enableNoConsent.result.consentBlock[0]).toBe(`plugin ${pluginId} requests:`);
      expect(readFileSync(settingsPath, "utf8")).toBe(settingsAfterInstall); // byte-identical — no mutation

      const listAfterNeedsConsent = await harness.request(METHODS.pluginsList, {});
      const stillEntry = listAfterNeedsConsent.result.plugins.find((p: any) => p.name === pluginId);
      expect(stillEntry.mcpEnabled).toBe(false);
      expect(stillEntry.status).toBe("na"); // still not running — no hot-apply happened on this branch

      // --- (c) plugin.enable {consent:true} -> grants consent, enables, hot-SPAWNS the real child ---
      const enableRes = await harness.request(METHODS.pluginEnable, { name: pluginId, consent: true });
      expect(enableRes.result.ok).toBe(true);
      expect(["starting", "running"]).toContain(enableRes.result.status); // hot-spawned NOW, possibly still awaiting registration
      expect(["starting", "running"]).toContain(inst.supervisor.status(pluginId)); // SAME supervisor instance — proves the RPC actually reached it

      await waitFor(() => inst.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" for ${pluginId} (real child registered)`);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.plugins.enabled).toEqual([pluginId]);
      expect(settings.plugins.consents[pluginId].exec).toBeGreaterThan(0);

      const listRunning = await harness.request(METHODS.pluginsList, {});
      const runningEntry = listRunning.result.plugins.find((p: any) => p.name === pluginId);
      expect(runningEntry).toMatchObject({ disabled: false, mcpEnabled: true, status: "running" });
      expect(runningEntry.consented).toEqual(["exec"]);

      // Prove it's a REAL OS process, not a stub: round-trip the real child's `echo` tool through
      // the SAME ToolRegistry the running daemon shares, and `ps -p`-verify the pid it reports.
      await waitFor(() => inst.registry.has(`plugin__${pluginId}__echo`), 5_000, `plugin__${pluginId}__echo registered`);
      const echoOutcome = await inst.registry.execute(
        `plugin__${pluginId}__echo`,
        { text: "hi" },
        { cwd: "/", roots: ["/"], sessionId: "gate-4d-ii" },
      );
      expect(echoOutcome.isError).toBe(false);
      const { echo, pluginPid } = JSON.parse(echoOutcome.output) as { echo: string; pluginPid: number };
      expect(echo).toBe("hi");
      expect(isPidAlive(pluginPid)).toBe(true);

      // --- (d) plugin.disable -> hot-STOPS the real child + strips consent (fresh-consent) ---
      const disableRes = await harness.request(METHODS.pluginDisable, { name: pluginId });
      expect(disableRes.result).toEqual({ ok: true });

      await waitFor(() => inst.supervisor.status(pluginId) !== "running", 30_000, `supervisor status leaves "running" for ${pluginId}`);
      await waitFor(() => !isPidAlive(pluginPid), 5_000, `hot-stopped real child pid ${pluginPid} to actually die (no orphan)`);

      const settingsAfterDisable = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settingsAfterDisable.plugins.enabled).toEqual([]);
      expect(settingsAfterDisable.plugins.disabled).toEqual([pluginId]);
      expect(settingsAfterDisable.plugins.consents?.[pluginId]).toBeUndefined(); // fresh-consent: whole record gone, not just the enabled flag

      const listAfterDisable = await harness.request(METHODS.pluginsList, {});
      const disabledEntry = listAfterDisable.result.plugins.find((p: any) => p.name === pluginId);
      expect(disabledEntry.status).toBe("na"); // no longer spawn-eligible
      expect(disabledEntry.mcpEnabled).toBe(false);
      expect(disabledEntry.consented ?? []).toEqual([]);

      // The consent record is genuinely gone (not just the enabled flag) — a follow-up enable
      // with no `consent` flag needs the disclosure again, exactly like a never-before-consented
      // plugin.
      const enableAfterDisable = await harness.request(METHODS.pluginEnable, { name: pluginId });
      expect(enableAfterDisable.result.code).toBe("needs_consent");

      // --- (e) plugin.remove -> clears the plugins.list entry + deletes the directory ---
      const removeRes = await harness.request(METHODS.pluginRemove, { name: pluginId });
      expect(removeRes.result).toEqual({ ok: true });

      const listAfterRemove = await harness.request(METHODS.pluginsList, {});
      expect(listAfterRemove.result.plugins.find((p: any) => p.name === pluginId)).toBeUndefined();
      expect(existsSync(join(home, "plugins", pluginId))).toBe(false);

      const settingsAfterRemove = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settingsAfterRemove.plugins.enabled).toEqual([]);
      expect(settingsAfterRemove.plugins.disabled).toEqual([]);
      expect(settingsAfterRemove.plugins.consents ?? {}).toEqual({});

      harness.close();
      inst.supervisor.stopAll(); // safety net — the child should already be dead from step (d)
      inst.server.stop();
      inst.store.close();
      await waitFor(() => !isPidAlive(pluginPid), 5_000, "child pid to stay dead through teardown (no stray respawn)");
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});
