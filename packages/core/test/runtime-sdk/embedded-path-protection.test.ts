import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddedWorkerProcess, SpawnEmbeddedWorkerOptions } from "@yanlinglabs/winter-agent-runtime/embedded-host";
import { createEmbeddedSessionHost, EmbeddedRuntimeUnavailable } from "../../src/runtime-sdk/embedded";
import { embeddedHostPathProtection, embeddedContextProtectionSupported, embeddedFileProtectionSupported, type EmbeddedProtectionCapability, type EmbeddedHostPathProtection } from "../../src/runtime-sdk/embedded-path-protection";
import { registerHostStorageFences, refreshHostStoragePolicies } from "../../src/runtime-sdk/host-storage-fence";

const partial: EmbeddedProtectionCapability = { contractVersion: 1, capability: "host-code-path-protection-v1", coverage: {
  fileTools: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"], ordinarySandboxPathChecks: true, approvedEscapesKeepMainBehavior: true, contextReadChecksVersion: 0,
} };
// Synthetic complete-contract branch only. No released SDK context-coverage claim is made.
const complete = { ...partial, coverage: { ...partial.coverage, contextReadChecksVersion: 1, sourceReaderFamilies: ["instructions-imports-memory", "rules", "output-styles", "settings-mcp", "skills", "agent-definitions", "plugin-components-manifests-installed", "commands", "workflow-source"] } };
let root: string, home: string, coordination: string, remove: (() => void) | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "winter-embedded-protection-")); home = join(root, "home"); coordination = join(root, "coordination");
  mkdirSync(join(home, "cowork/workspaces/w/shared"), { recursive: true });
});
afterEach(() => { remove?.(); remove = undefined; rmSync(root, { recursive: true, force: true }); });
const activate = () => { remove = registerHostStorageFences(home, { coordinationDir: coordination, coworkStorageActive: true }); };
const options = () => ({ command: "winter-embedded", args: [], cwd: root, env: {} });
function worker(update: (policy: EmbeddedHostPathProtection) => Promise<number>) {
  let close!: (exit: { code: number; signal: null }) => void, kills = 0, terminates = 0;
  const exited = new Promise<{ code: number; signal: null }>(resolve => { close = resolve; });
  const proc = { stdin: { write() {}, end() {} }, stdout: (async function* () {})(), exited, pid: null,
    state: "running", updateHostCodeProtection: update,
    kill() { kills++; close({ code: 0, signal: null }); }, terminate() { terminates++; close({ code: 0, signal: null }); },
  } as unknown as EmbeddedWorkerProcess;
  return { proc, close: () => close({ code: 0, signal: null }), kills: () => kills, terminates: () => terminates };
}

test("partial capability never enables protected context execution", () => {
  expect(embeddedFileProtectionSupported(partial)).toBe(true);
  expect(embeddedContextProtectionSupported(partial)).toBe(false);
  expect(embeddedContextProtectionSupported(undefined)).toBe(false);
  expect(embeddedContextProtectionSupported(complete)).toBe(true); // reviewed v1 contract
  expect(embeddedContextProtectionSupported(complete, 0)).toBe(false); // unaccepted contracts remain refused
  expect(embeddedContextProtectionSupported({ ...complete, coverage: { ...complete.coverage, sourceReaderFamilies: ["rules"] } })).toBe(false);
  expect(embeddedContextProtectionSupported(complete, 1)).toBe(true);
  activate(); const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: partial });
  expect(host.supportsProtectedPaths?.()).toBe(false);
  expect(() => host.spawn(options())).toThrow(EmbeddedRuntimeUnavailable);
  void host.shutdown();
});
test("snapshot derives protected paths from canonical fences and stays outside runtime config/env", () => {
  activate(); const policy = embeddedHostPathProtection(home, 7);
  expect(policy.revision).toBe(7); expect(Object.isFrozen(policy.denyReadPaths)).toBe(true);
  expect(policy.denyReadPaths).toContain(join(home, "cowork/workspaces/*/data.ext4"));
  expect(policy.denyReadPaths).toContain(join(home, "cowork/workspaces/*/manifest.json"));
  expect(policy.denyReadPaths).toContain(join(home, "runtimes")); expect(policy.denyReadPaths).toContain(join(home, "run"));
  expect(policy.denyReadPaths).toContain(coordination); expect(policy.denyWritePaths).toContain(join(home, "cowork"));
  expect(policy.denyReadPaths).not.toContain(join(home, "cowork/workspaces/w/shared"));
});
test("complete-contract live acknowledgments retain the Worker and do not kill a running turn", async () => {
  const updates: EmbeddedHostPathProtection[] = [], fake = worker(async policy => { updates.push(policy); return policy.revision; });
  const prepared: Array<SpawnEmbeddedWorkerOptions & { hostCodeProtection?: EmbeddedHostPathProtection }> = [];
  const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: complete, acceptedContextCoverageVersion: 1, spawnWorker: options => { prepared.push(options); return fake.proc; } });
  host.spawn(options()); activate();
  await refreshHostStoragePolicies();
  expect(host.live()).toHaveLength(1); expect(fake.kills()).toBe(0); expect(updates).toHaveLength(1);
  expect(updates[0]!.denyReadPaths).toContain(join(home, "cowork/workspaces/*/data.ext4"));
  expect(prepared[0]!.hostCodeProtection?.revision).toBeLessThan(updates[0]!.revision);
  expect(prepared[0]!.spawn.env).toEqual({}); expect(prepared[0]!.spawn.args).toEqual([]);
  fake.close(); await host.shutdown();
});
test("mismatched live acknowledgment rejects instead of claiming installation", async () => {
  const fake = worker(async policy => policy.revision + 1);
  const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: complete, acceptedContextCoverageVersion: 1, spawnWorker: () => fake.proc });
  host.spawn(options()); activate();
  await expect(refreshHostStoragePolicies()).rejects.toThrow("acknowledgment mismatched");
  fake.close(); await host.shutdown();
});
test("active complete-contract bootstrap is held until its own matching Worker acknowledgment", async () => {
  activate(); let acknowledge!: (revision: number) => void, revision = 0, started = false;
  const fake = worker(policy => { revision = policy.revision; return new Promise(resolve => { acknowledge = resolve; }); });
  const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: complete, acceptedContextCoverageVersion: 1, spawnWorker: prepared => {
    void prepared.startAfter!.then(() => { started = true; }); return fake.proc;
  } });
  host.spawn(options()); await Promise.resolve(); expect(started).toBe(false);
  acknowledge(revision); await Bun.sleep(0); expect(started).toBe(true);
  fake.close(); await host.shutdown();
});

test("bootstrap acknowledgment failure keeps engine start held and closes the Worker", async () => {
  activate(); let started = false; const lifecycle: string[] = [];
  const fake = worker(async () => { throw new Error("synthetic channel failure"); });
  const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: complete, acceptedContextCoverageVersion: 1, onLifecycle: event => lifecycle.push(event.event), spawnWorker: prepared => {
    void prepared.startAfter!.then(() => { started = true; }); return fake.proc;
  } });
  host.spawn(options()); await Bun.sleep(0);
  expect(started).toBe(false); expect(lifecycle).not.toContain("start");
  expect(fake.kills()).toBe(1); expect(fake.terminates()).toBe(1);
  await host.shutdown();
});
