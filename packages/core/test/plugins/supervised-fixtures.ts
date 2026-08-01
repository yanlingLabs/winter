import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIpcServer, type IpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { loadSettings, type Settings } from "../../src/settings";
import { PluginStore, pluginSpawnEligible } from "../../src/agent/plugins";
import { ToolRegistry } from "../../src/agent/tools/registry";
import {
  PluginSupervisor,
  type EligiblePlugin,
  type PluginSupervisorSettings,
  type SpawnFn,
  type SupervisedProcess,
} from "../../src/plugins/supervisor";
import { PluginContribRegistry } from "../../src/plugins/contrib";
import { AuditLog } from "../../src/peripheral/audit";
import { PeripheralBroker } from "../../src/peripheral/broker";
import { ProviderLink } from "../../src/peripheral/provider-link";
import { HardwareBroker } from "../../src/peripheral/hardware";

/**
 * Shared boot machinery for Phase 4b's real-child plugin suites (Task 6's `supervised-e2e.test.ts`
 * and Task 7's `gate-4b.test.ts`) — everything here spawns/verifies REAL OS processes, never a
 * scripted/fake connection (that coverage lives in server.test.ts's "plugin tool bridge (Task 4)"
 * suite). Extracted so the gate doesn't re-duplicate ~100 lines of install/boot/settings
 * plumbing Task 6 already got right; see `supervised-e2e.test.ts`'s original file doc comment
 * (preserved there) for the full rationale on the SDK-import-path rewrite below.
 *
 * NOT a `*.test.ts` file — bun's test discovery only picks up `.test.`/`.spec.` filenames, so this
 * module is inert unless explicitly imported.
 */

const EXAMPLES_DIR = join(import.meta.dir, "../../../../examples/sample-echo");
const BATTERY_LIMITER_DIR = join(import.meta.dir, "../../../../examples/battery-limiter");
const PLUGIN_SDK_ENTRY = join(import.meta.dir, "../../../plugin-sdk/src/index.ts");

/** Copies an `examples/<name>` reference plugin into `<normaHome>/plugins/<pluginId>` and
 *  rewrites its `@norma/plugin-sdk` import to an absolute path (a bare copy has no `node_modules`
 *  of its own — see the module doc comment). Returns the installed directory. Shared by
 *  `installSampleEcho` and `installBatteryLimiter` below — identical rewrite, different source
 *  tree. */
function installExample(srcDir: string, normaHome: string, pluginId: string): string {
  const dest = join(normaHome, "plugins", pluginId);
  cpSync(srcDir, dest, { recursive: true });
  const indexPath = join(dest, "index.ts");
  const rewritten = readFileSync(indexPath, "utf8").replace(
    'from "@norma/plugin-sdk"',
    `from ${JSON.stringify(PLUGIN_SDK_ENTRY)}`,
  );
  writeFileSync(indexPath, rewritten);
  return dest;
}

/** Copies `examples/sample-echo` into `<normaHome>/plugins/<pluginId>` and rewrites its
 *  `@norma/plugin-sdk` import to an absolute path (a bare copy has no `node_modules` of its own —
 *  see the module doc comment). Returns the installed directory. */
export function installSampleEcho(normaHome: string, pluginId: string): string {
  return installExample(EXAMPLES_DIR, normaHome, pluginId);
}

/** Phase 4c Task 5: same install-and-rewrite as `installSampleEcho`, for
 *  `examples/battery-limiter` — the `ctx.hardware()` reference plugin. Used by
 *  `battery-limiter-e2e.test.ts`'s real-child-process hardware round-trip. */
export function installBatteryLimiter(normaHome: string, pluginId: string): string {
  return installExample(BATTERY_LIMITER_DIR, normaHome, pluginId);
}

/** `ps -p <pid>` liveness probe — a REAL process check (not `process.kill(pid, 0)`), matching the
 *  "verify with a ps check on the child pid" requirement for no-orphan-process assertions. */
export function isPidAlive(pid: number): boolean {
  const result = Bun.spawnSync(["ps", "-p", String(pid)]);
  return result.exitCode === 0;
}

/** A real, external `kill -9 <pid>` — deliberately shelling out (not `process.kill(pid,
 *  "SIGKILL")`) so the gate literally exercises "kill -9 the child pid", same signal (9), same
 *  effect, but via the actual command a human/ops action would run. */
export function kill9(pid: number): void {
  Bun.spawnSync(["kill", "-9", String(pid)]);
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** The exact behavior of supervisor.ts's private `defaultSpawn` (real `Bun.spawn`, stdio
 *  ignored) — exported so a test can wrap it (e.g. to record each attempt's pid) while still
 *  spawning genuine OS processes, never a fake/scripted one. */
export function realSpawn(cmd: string[], opts: { cwd: string; env: Record<string, string> }): SupervisedProcess {
  return Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

/** Writes a real settings.json (installed + ENABLED + exec-CONSENTED — the exact state
 *  `pluginSpawnEligible` (agent/plugins.ts) requires before the real daemon would ever spawn a
 *  Tier-2 plugin) and loads it back through the real `loadSettings` pipeline. `opts.hardwareConsent`
 *  (Phase 4c Task 5, off by default — purely additive) also grants the "hardware" consent class,
 *  needed for `battery-limiter-e2e.test.ts`'s `pluginSpawnEligible`/`consentComplete` check to pass
 *  a manifest that declares `permissions.hardware: ["battery"]` (plugin-manifest.ts's
 *  `requiredConsentClasses` adds "hardware" to what a manifest like that requires). */
export function writeAndLoadSettings(home: string, pluginId: string, opts?: { hardwareConsent?: boolean }): Settings {
  const consent: { exec: number; hardware?: number } = { exec: Date.now() };
  if (opts?.hardwareConsent) consent.hardware = Date.now();
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    provider: { type: "codex-oauth", model: "gpt-5.4" }, // unused (nothing here constructs a real provider) but required by the settings schema
    plugins: { enabled: [pluginId], consents: { [pluginId]: consent } },
  }));
  return loadSettings(join(home, "settings.json"));
}

/** The daemon's real Tier-2 spawn-eligibility pipeline (PluginStore#list -> pluginSpawnEligible),
 *  reduced to the `EligiblePlugin[]` shape `PluginSupervisor.startAll`/`reclaimOrphans` consume. */
export function buildSpawnablePlugins(home: string, settings: Settings): EligiblePlugin[] {
  const pluginStore = new PluginStore({
    normaHome: home, plugins: settings.plugins, consents: settings.plugins?.consents,
    log: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[plugins] ${m}`); },
  });
  return pluginStore.list()
    .filter(pluginSpawnEligible)
    .map((p) => ({ id: p.name, dir: join(home, "plugins", p.name), entry: p.entry! }));
}

export interface SupervisedInstance {
  store: SessionStore;
  authority: TokenAuthority;
  registry: ToolRegistry;
  contrib: PluginContribRegistry;
  supervisor: PluginSupervisor;
  server: IpcServer;
  /** Only set when `params.hardware` was true (Phase 4c Task 5) — see that param's doc comment. */
  providerLink?: ProviderLink;
  hardware?: HardwareBroker;
  peripheral?: PeripheralBroker;
  plugins?: PluginStore;
}

/** One "core instance" worth of real, wired-together server-side plumbing — a real IPC server
 *  bound to `socketPath`, a real (sqlite-backed, on-disk) `SessionStore` at `home`, and a
 *  `PluginSupervisor` with PRODUCTION spawn/signal deps by default (`spawn` only overridden when a
 *  test needs to instrument, never fake, spawning). Does NOT call `startAll`/`reclaimOrphans` —
 *  the caller decides (this is exactly what Task 7's orphan-reclaim gate needs: two independent
 *  instances against the SAME `home`/`runDir`/`socketPath`, simulating a core restart, where only
 *  one of them actually spawns anything). */
export async function createSupervisedInstance(params: {
  home: string;
  socketPath: string;
  supervisorSettings?: PluginSupervisorSettings;
  spawn?: SpawnFn;
  /** Testability seam, off by default (production `process.kill`) — the orphan-reclaim gate
   *  neuters this for its FIRST ("about to be abandoned") instance so its own deliberate
   *  `stopAll()` teardown (needed to make its later socket-close a no-op — see that test's
   *  comments) can never reach out and kill the child it's supposed to be leaving behind alive. */
  signalPid?: (pid: number, signal: NodeJS.Signals) => void;
  /** Phase 4c Task 5, opt-in and purely additive (every other caller omits it — sample-echo never
   *  touches hardware.request, so standing up this extra plumbing for them would be pure noise).
   *  When true, wires a `ProviderLink` + `PeripheralBroker` (needed only so `hardware.respond`'s
   *  `isProvider()` gate has something to check a scripted provider connection's identity against
   *  — no lease machinery is exercised) + `HardwareBroker` + a real `PluginStore` (reads `home`'s
   *  ALREADY-WRITTEN settings.json — every current caller calls `writeAndLoadSettings` before this,
   *  so it's always there by the time this runs) into the IPC server, mirroring daemon.ts's real
   *  wiring AND `server.test.ts`'s `bootHardwareServer` exactly. Lets `battery-limiter-e2e.test.ts`
   *  drive a REAL spawned battery-limiter child's `ctx.hardware()` calls end-to-end against a
   *  scripted provider connection, instead of the raw-RPC/no-real-plugin-process coverage
   *  `server.test.ts`'s "hardware.request / hardware.respond" suite already has. */
  hardware?: boolean;
  /** Phase 4d-i Task 5, opt-in and purely additive (independent of `hardware` above — a no-op
   *  when `hardware` is already true, since that path already builds one). Wires a real
   *  `PluginStore` alone (reads `home`'s already-written settings.json, same construction as the
   *  `hardware: true` path) WITHOUT the provider-link/hardware-broker/peripheral-broker machinery
   *  — needed only so `plugins.list` (Task 4's supervisor-status enrichment) has a store to
   *  enrich. `gate-4d-i.test.ts` uses this instead of `hardware: true` since it never touches
   *  `ctx.hardware()` at all — standing up that extra plumbing for it would be pure noise, same
   *  precedent as `hardware`'s own doc comment below. */
  plugins?: boolean;
  /** Phase 4d-ii Task 4, opt-in and purely additive (independent of `plugins`/`hardware` above,
   *  though every current caller that wants this also wants `plugins: true` for `plugins.list`
   *  enrichment). Forwards `normaHome: home` into `startIpcServer` so the plugin-lifecycle RPCs
   *  (plugins.install/plugin.enable/disable/remove/setConsent, ipc/server.ts) have a normaHome to
   *  read+write settings.json/the plugins dir against — server.test.ts's own `bootLifecycleServer`
   *  wires the SAME option directly; this lets `gate-4d-ii.test.ts` get it through the shared
   *  supervised-fixtures boot path instead of hand-rolling its own IpcServer wiring a second time. */
  wireNormaHome?: boolean;
}): Promise<SupervisedInstance> {
  const { home, socketPath, supervisorSettings, spawn, signalPid } = params;
  const store = new SessionStore(home);
  const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
  await authority.ensureTokens();

  const registry = new ToolRegistry();
  const contrib = new PluginContribRegistry();
  const supervisor = new PluginSupervisor({
    runDir: join(home, "run"),
    socketPath,
    mintToken: (id) => store.mintPluginToken(id),
    spawn,
    signalPid,
    settings: { registrationTimeoutMs: 60_000, killGraceMs: 1_500, ...supervisorSettings },
    onLog: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[supervisor] ${m}`); },
    onCircuitOpen: (id) => registry.unregisterByPrefix(`plugin__${id}__`),
  });

  let providerLink: ProviderLink | undefined;
  let hardwareBroker: HardwareBroker | undefined;
  let peripheral: PeripheralBroker | undefined;
  let plugins: PluginStore | undefined;
  if (params.hardware) {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    providerLink = new ProviderLink();
    peripheral = new PeripheralBroker({
      audit, policy: async () => "granted", emitTransient: () => {},
      pushToProvider: (e) => providerLink!.push(e),
    });
    hardwareBroker = new HardwareBroker({ audit, pushToProvider: (e) => providerLink!.push(e) });
    const settings = loadSettings(join(home, "settings.json"));
    plugins = new PluginStore({
      normaHome: home, plugins: settings.plugins, consents: settings.plugins?.consents,
      log: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[plugins] ${m}`); },
    });
  } else if (params.plugins) {
    const settings = loadSettings(join(home, "settings.json"));
    plugins = new PluginStore({
      normaHome: home, plugins: settings.plugins, consents: settings.plugins?.consents,
      log: (m) => { if (process.env.NORMA_TEST_DEBUG) console.error(`[plugins] ${m}`); },
    });
  }

  // The socket must already be listening before startAll() spawns a child — the child connects to
  // NORMA_SOCKET immediately on startup.
  const server = startIpcServer({
    socketPath, serverVersion: "test", tokens: authority, store, registry, supervisor, contrib,
    providerLink, hardware: hardwareBroker, peripheral, plugins,
    normaHome: params.wireNormaHome ? home : undefined,
  });

  return { store, authority, registry, contrib, supervisor, server, providerLink, hardware: hardwareBroker, peripheral, plugins };
}

/** The Task 6 convenience wrapper: installs sample-echo into a fresh tmp `normaHome`, writes/loads
 *  real consent-complete settings, boots one `SupervisedInstance`, and immediately `startAll`s the
 *  single eligible plugin. Matches `supervised-e2e.test.ts`'s original `bootSupervisedServer`
 *  shape exactly (same fields, same behavior with default options) plus two additive knobs the
 *  gate needs: `supervisorSettings` (short backoff/circuit overrides) and `spawn` (pid-capturing
 *  instrumentation around the real spawn, for the circuit-breaker gate's "spawn count stops"
 *  assertion). */
export async function bootSupervisedServer(pluginId: string, opts?: {
  supervisorSettings?: PluginSupervisorSettings;
  spawn?: SpawnFn;
}): Promise<{
  home: string;
  socketPath: string;
  store: SessionStore;
  authority: TokenAuthority;
  registry: ToolRegistry;
  supervisor: PluginSupervisor;
  contrib: PluginContribRegistry;
  server: IpcServer;
  spawnable: EligiblePlugin[];
  stop: () => void;
}> {
  const home = mkdtempSync(join(tmpdir(), "norma-plugin-supervised-"));
  installSampleEcho(home, pluginId);
  const settings = writeAndLoadSettings(home, pluginId);
  const socketPath = join(home, "core.sock");

  const inst = await createSupervisedInstance({
    home, socketPath, supervisorSettings: opts?.supervisorSettings, spawn: opts?.spawn,
  });

  const spawnable = buildSpawnablePlugins(home, settings);
  if (spawnable.map((p) => p.id).join(",") !== pluginId) {
    throw new Error(`sanity: pluginSpawnEligible did not pick up ${pluginId} (got ${JSON.stringify(spawnable.map((p) => p.id))})`);
  }
  inst.supervisor.startAll(spawnable);

  return {
    home, socketPath, spawnable, ...inst,
    stop: () => { inst.supervisor.stopAll(); inst.server.stop(); inst.store.close(); },
  };
}

/** Best-effort removal of a stale unix socket path — mirrors `lock.ts#acquireLock`'s own
 *  pre-listen cleanup (a `Bun.listen({unix: ...})` does not auto-unlink a leftover socket file).
 *  Used by the orphan-reclaim gate when standing up a second `SupervisedInstance` on the SAME
 *  `socketPath` a prior instance already bound (simulating a core restart that reuses the same
 *  well-known socket path). */
export function unlinkStaleSocket(socketPath: string): void {
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* best-effort */ }
  }
}

export function pluginRunDir(home: string): string {
  return join(home, "run");
}

/** Fabricates a JSON pid file exactly matching the on-disk shape `PluginSupervisor#writePidFile`
 *  produces (`{pid, pluginId, startedAt}`), for tests that need to hand-place one without going
 *  through a live supervisor (e.g. "an abandoned pid file from a core that never got the chance to
 *  clean up after itself" — the exact scenario orphan reclaim exists for). */
export function writePidFile(home: string, pluginId: string, pid: number, startedAt: string | null): void {
  const dir = join(pluginRunDir(home), "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pluginId}.pid`), JSON.stringify({ pid, pluginId, startedAt }));
}

export function pidFilePath(home: string, pluginId: string): string {
  return join(pluginRunDir(home), "plugins", `${pluginId}.pid`);
}
