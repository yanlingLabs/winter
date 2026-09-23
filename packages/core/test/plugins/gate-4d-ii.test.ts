import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import {
  createSupervisedInstance,
  installSampleEcho,
  isPidAlive,
  waitFor,
  type SupervisedInstance,
} from "./supervised-fixtures";

/**
 * WS-21 rewrite of the 4d-ii consolidated gate: the FULL plugin lifecycle over Contract B
 * (`plugin.marketplace.add` -> `plugin.install` -> `plugin.setConsent` (the entry process's own
 * extra, spec §5.4) -> `plugin.enable` hot-spawn -> `plugin.disable` hot-stop -> `plugin.uninstall`)
 * driven entirely OVER THE WIRE against a REAL running daemon, with a REAL spawned `sample-echo`
 * child at the hot-spawn step — no scripted/fake connection on the PLUGIN side anywhere in this
 * file (same discipline as `gate-4b.test.ts`/`gate-4d-i.test.ts`).
 *
 * WS-21 changes from the pre-WS-21 shape this test used to pin (spec §5, §5.4):
 *  - install+enable is itself the consent for a plugin's claude-native content — there is no more
 *    `plugin.enable {consent:true}` two-step; `plugin.install` already leaves the plugin ENABLED
 *    (Contract B's own `installPlugin`, `manage.ts`'s header). Only the WINTER EXTRA (the Tier-2
 *    entry process, `permissions.exec`) still needs its own `plugin.setConsent` before
 *    `pluginSpawnEligible` — and so `hotApplyStart` — will ever fire.
 *  - `plugin.disable` no longer strips the consent record: consent is now orthogonal to the
 *    enabled/disabled toggle (a Winter-extra concern, spec §5.4), not fresh-consent-on-disable.
 *  - `plugin.uninstall` (Contract B's own name) removes the install record + `enabledPlugins` entry
 *    only — it never deletes the directory (a directory marketplace is read in place, F15/§5.2; this
 *    build has no network source to have cloned a copy of in the first place).
 *  - `plugin.list`'s result mirrors Contract B's `PluginListing` field-for-field (no `status`
 *    enrichment — that was a pre-WS-21, Winter-only addition with no room in the new schema); this
 *    gate checks hot-spawn/hot-stop directly against `inst.supervisor.status(pluginId)`, the SAME
 *    `PluginSupervisor` instance the RPC handlers reach through `hotApplyStart`/`hotApplyStop`.
 */

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

describe("4d-ii gate: over-the-wire plugin lifecycle (marketplace.add -> install -> setConsent -> enable hot-spawn -> disable -> uninstall)", () => {
  test(
    "plugin.marketplace.add -> plugin.install (enabled, not yet spawn-eligible) -> plugin.setConsent -> plugin.enable hot-spawns a real child -> plugin.disable hot-stops -> plugin.uninstall clears the record",
    async () => {
      const pluginId = "sample-echo";
      const home = mkdtempSync(join(tmpdir(), "winter-gate-4d-ii-"));
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" },
      }));
      const socketPath = join(home, "core.sock");

      // A fixture plugin dir NOT yet anywhere under `home`'s own installed set: `installSampleEcho`
      // copies examples/sample-echo into a THROWAWAY staging winterHome (its own registration there
      // is unused) and rewrites its `@yanlinglabs/winter-plugin-sdk` import to an absolute path — reused here
      // purely for that copy-and-rewrite. The returned dir IS the one-plugin directory marketplace's
      // own root (`source: "."`, see supervised-fixtures.ts's own header) — `plugin.marketplace.add`
      // below is the ONLY thing that registers it against this test's real `home`.
      const srcHome = mkdtempSync(join(tmpdir(), "winter-gate-4d-ii-src-"));
      const marketplaceDir = installSampleEcho(srcHome, pluginId);

      const inst: SupervisedInstance = await createSupervisedInstance({ home, socketPath, plugins: true, wireWinterHome: true });

      const tokens = await inst.authority.ensureTokens();
      const harness = await TestClient.connect(socketPath);
      await harness.hello(tokens.harness, "dashboard");

      // --- plugin.marketplace.add ---
      const mktRes = await harness.request(METHODS.pluginMarketplaceAdd, { source: marketplaceDir });
      expect(mktRes.result.ok).toBe(true);
      const marketplaceName: string = mktRes.result.marketplace.name;
      const spec = `${pluginId}@${marketplaceName}`;

      // --- plugin.install: enabled by default (Contract B), NOT yet spawn-eligible (no exec consent) ---
      const installRes = await harness.request(METHODS.pluginInstall, { spec, scope: "user" });
      expect(installRes.result.ok).toBe(true);
      expect(installRes.result.plugin).toMatchObject({ id: pluginId, scope: "user" });

      const listAfterInstall = await harness.request(METHODS.pluginList, {});
      const afterInstallEntry = listAfterInstall.result.plugins.find((p: any) => p.id === pluginId);
      expect(afterInstallEntry).toMatchObject({ enabled: true, marketplace: marketplaceName });
      expect(inst.supervisor.status(pluginId)).toBe("stopped"); // never hot-spawned — enable hasn't run yet

      // --- plugin.enable BEFORE the entry's own exec consent: settings-only, never spawns ---
      const enableUnconsented = await harness.request(METHODS.pluginEnable, { spec, scope: "user" });
      expect(enableUnconsented.result).toEqual({ ok: true, spec, scope: "user", enabled: true });
      expect(inst.supervisor.status(pluginId)).toBe("stopped"); // still not spawn-eligible

      // --- plugin.setConsent grants the Tier-2 entry process's own extra (spec §5.4) ---
      const setConsentRes = await harness.request(METHODS.pluginSetConsent, { name: pluginId, classes: ["exec"] });
      expect(setConsentRes.result).toEqual({ ok: true });

      // --- plugin.enable (again) is now spawn-eligible -> hot-SPAWNS the real child ---
      const enableRes = await harness.request(METHODS.pluginEnable, { spec, scope: "user" });
      expect(enableRes.result).toEqual({ ok: true, spec, scope: "user", enabled: true });
      expect(["starting", "running"]).toContain(inst.supervisor.status(pluginId)); // SAME supervisor instance — proves the RPC actually reached it

      await waitFor(() => inst.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" for ${pluginId} (real child registered)`);

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

      // --- plugin.disable -> hot-STOPS the real child (consent is untouched, WS-21: no more
      //     fresh-consent-on-disable — consent is orthogonal to enabled state now, spec §5.4) ---
      const disableRes = await harness.request(METHODS.pluginDisable, { spec, scope: "user" });
      expect(disableRes.result).toEqual({ ok: true, spec, scope: "user", enabled: false });

      await waitFor(() => inst.supervisor.status(pluginId) !== "running", 30_000, `supervisor status leaves "running" for ${pluginId}`);
      await waitFor(() => !isPidAlive(pluginPid), 5_000, `hot-stopped real child pid ${pluginPid} to actually die (no orphan)`);

      const listAfterDisable = await harness.request(METHODS.pluginList, {});
      expect(listAfterDisable.result.plugins.find((p: any) => p.id === pluginId)).toMatchObject({ enabled: false });

      // Re-enabling needs no fresh consent — the entry's own exec record is still on file.
      const enableAgain = await harness.request(METHODS.pluginEnable, { spec, scope: "user" });
      expect(enableAgain.result).toEqual({ ok: true, spec, scope: "user", enabled: true });
      await waitFor(() => inst.supervisor.status(pluginId) === "running", 30_000, `supervisor status "running" again for ${pluginId}`);
      inst.supervisor.stop(pluginId);
      await waitFor(() => inst.supervisor.status(pluginId) !== "running", 30_000, `supervisor status leaves "running" for ${pluginId} (teardown)`);
      const disableAgain = await harness.request(METHODS.pluginDisable, { spec, scope: "user" });
      expect(disableAgain.result.ok).toBe(true);

      // --- plugin.uninstall -> clears the install record + enabledPlugins entry (never the dir —
      //     a directory marketplace is read in place, F15/§5.2) ---
      const uninstallRes = await harness.request(METHODS.pluginUninstall, { spec, scope: "user" });
      expect(uninstallRes.result).toEqual({ ok: true, spec, scope: "user" });

      const listAfterUninstall = await harness.request(METHODS.pluginList, {});
      expect(listAfterUninstall.result.plugins.find((p: any) => p.id === pluginId)).toBeUndefined();

      harness.close();
      inst.supervisor.stopAll(); // safety net
      inst.server.stop();
      inst.store.close();
    },
    90_000, // 60s registration budget + margin (real child spawn under load)
  );
});
