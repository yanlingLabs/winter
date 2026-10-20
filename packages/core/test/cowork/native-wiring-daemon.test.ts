import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CoworkRepository } from "../../src/cowork/repository";
import { CoworkVolumes } from "../../src/cowork/volumes";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import type { CoworkNativeEnvironment } from "../../src/cowork/native-wiring";
import { CoworkNativeSimulatedCrash } from "../../src/cowork/native/host";
import { cleanupHarnesses, createHarness, IMAGE_DIGEST, type Harness } from "./native/harness";

// The daemon wiring over a temp WINTER_HOME and the throwaway test secret store; the launcher is the S1 fake (no process, no VM, no socket).
let daemon: RunningDaemon | undefined;
afterEach(async () => { try { await daemon?.stop(); } catch { /* already stopped */ } daemon = undefined; cleanupHarnesses(); });

const backup = { excludeItem: () => {}, verifyItemExcluded: () => true, verifyDescriptorExcluded: () => true };
const pinned = { get: () => ({ workspaceId: "x", baseImageDigest: "b".repeat(64), runtimeImageDigest: IMAGE_DIGEST, revision: 1, pendingUpdate: null, pinnedAt: "", updatedAt: "" }), assertPinned: () => {} };
function environment(h: Harness, asked: { count: number }): () => CoworkNativeEnvironment {
  return () => {
    asked.count += 1;
    const { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint } = h.deps;
    return { launcher: h.launcher, admission: h.ledger, backup, hostBoot: h.hostBoot, daemon: () => h.daemon, hostOptions: { timers, timeouts, unsafeTestTimeouts, now, conversations, mint, checkpoint } };
  };
}
/** Hand the seeded home to a daemon: the harness's own database handle must be closed first (the ledger is a separate file and stays open). */
const boot = async (h: Harness, native?: Parameters<typeof startDaemon>[0] extends infer O ? O extends { coworkNative?: infer N } ? N : never : never) => {
  h.db.close();
  daemon = await startDaemon({ home: h.home, secrets: new FileSecretStore(join(h.home, "secrets")), agentProvider: null, ...(native ? { coworkNative: native } : {}) });
  return daemon;
};
const reopen = (h: Harness) => {
  const db = openRuntimeStateDb(h.home), records = new CoworkRepository(db);
  const volumes = new CoworkVolumes(db, h.home, { authorize: () => false, verifyStopped: () => false }, backup as never).records(h.workspaceId);
  return { db, workspace: records.get(h.workspaceId), owners: volumes.map(v => v.owner) };
};

test("production default: the wiring exists, builds nothing, and stop is unchanged", async () => {
  const h = createHarness();
  const d = await boot(h);
  expect(d.coworkNative).toBeDefined();
  expect(d.coworkNative!.built).toBe(false);
  expect(d.coworkNative!.beginShutdown()).toBeUndefined();
  await d.stop(); daemon = undefined;
  const after = reopen(h); expect(after.workspace.power).toBe("stopped"); after.db.close();
});

test("an injected environment is not asked at boot nor at a stop with no guest", async () => {
  const h = createHarness(); const asked = { count: 0 };
  const d = await boot(h, { environment: environment(h, asked), imagePins: pinned as never });
  expect(asked.count).toBe(0);
  expect(d.coworkNative!.built).toBe(false);
  await d.stop(); daemon = undefined;
  expect(asked.count).toBe(0);
  expect(h.launcher.spawned).toEqual([]);
});

test("a live guest is drained by daemon.stop() BEFORE the stores close: its release is on disk when stop resolves", async () => {
  const h = createHarness(); const asked = { count: 0 };
  const d = await boot(h, { environment: environment(h, asked), imagePins: pinned as never });
  await d.coworkNative!.start(h.workspaceId);
  expect(asked.count).toBe(1);
  expect(d.coworkNative!.activeWorkspaces()).toEqual([h.workspaceId]);
  await d.stop(); daemon = undefined;
  const after = reopen(h);
  expect(after.workspace.power).toBe("stopped");
  expect(after.owners).toEqual([null, null]);
  after.db.close();
});

test("a guest whose stop rejects does not stop the daemon from closing its stores and releasing its lock", async () => {
  const { existsSync } = await import("node:fs");
  const h = createHarness(); const asked = { count: 0 };
  const d = await boot(h, { environment: environment(h, asked), imagePins: pinned as never });
  await d.coworkNative!.start(h.workspaceId);
  (d.coworkNative as unknown as { hostInstance: { stop: () => Promise<never> } }).hostInstance.stop = async () => { throw new Error("stop failed"); };
  await d.stop(); daemon = undefined;
  expect(existsSync(join(h.home, "run/core.sock"))).toBe(false); // the lock was released after the stores closed
  const after = reopen(h); // the runtime database was closed cleanly and can be reopened
  expect(after.owners.every(owner => owner !== null)).toBe(true); // nothing was released on the strength of a failed stop
  after.db.close();
});

test("a daemon restarted over a crashed start keeps the owner: without an environment it only reports", async () => {
  const h = createHarness({ crashAt: "volumes-opened" });
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.stopAll();
  const d = await boot(h);
  expect(d.coworkNative!.built).toBe(false);
  await d.stop(); daemon = undefined;
  const after = reopen(h);
  expect(after.owners.every(owner => owner !== null)).toBe(true);
  expect(after.workspace.power).not.toBe("stopped");
  after.db.close();
});

test("with an environment the boot runs the host's own recovery: same boot keeps the owner, marks it uncertain", async () => {
  const h = createHarness({ crashAt: "volumes-opened" }); const asked = { count: 0 };
  await expect(h.host.start(h.workspaceId)).rejects.toBeInstanceOf(CoworkNativeSimulatedCrash);
  h.stopAll();
  const d = await boot(h, { environment: environment(h, asked), imagePins: pinned as never });
  expect(asked.count).toBe(1); // boot reconcile is the one thing that builds the host without a start
  await d.stop(); daemon = undefined;
  const after = reopen(h);
  expect(after.workspace.power).toBe("uncertain");
  expect(after.owners.every(owner => owner !== null)).toBe(true);
  after.db.close();
});

test("source pin: the Cowork service receives the native port only when a caller injected an environment, and boot reconcile and the stop drain are wired in the daemon", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "daemon.ts"), "utf8");
  expect(source).toContain("const coworkNativePort = nativeEnvironment ? coworkNative : undefined;");
  expect(source).toContain("const nativeEnvironment = opts.coworkNative?.environment ?? (runtime ? coworkNativeProductionEnvironment(");
  expect(source).toContain("await coworkNative.reconcileAtBoot()");
  expect(source).toContain("const guestsDrained = coworkNative?.beginShutdown();");
  // the drain is awaited before the stores close: closeRest (store.close, runtime.close) runs only after it settles
  expect(source).toMatch(/settled\.then\(closeRest\)/);
  expect(source.indexOf("const guestsDrained")).toBeLessThan(source.indexOf("const closeRest"));
});
