import { query } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedSessionHost } from "../../../src/runtime-sdk/embedded";
import { registerHostStorageFences } from "../../../src/runtime-sdk/host-storage-fence";

const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-embedded-descendants-")));
const home = join(root, "home"), cwd = join(root, "project");
mkdirSync(join(home, "cowork"), { recursive: true }); mkdirSync(cwd);
// This fixture covers the floor of an SDK WITHOUT the host-code protection capability (the installed one has it since 0.0.54), so the capability is injected as absent.
// Real events, not time: `started` is the engine release (the `start` lifecycle event), `received` counts what the engine has streamed back.
let started = 0, received = 0;
const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: null, onLifecycle: event => { if (event.event === "start") started++; } });
const mode = process.argv[2];
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated" };
if (mode === "daemon-capable") {
  // The installed SDK HAS the capability: the real daemon's embedded host admits the chat and dispatch topologies under active protection.
  const { startDaemon } = await import("../../../src/daemon");
  const { FileSecretStore } = await import("../../../src/auth/secret-store");
  const { EmbeddedRuntimeUnavailable } = await import("../../../src/runtime-sdk/embedded");
  const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
  let unregister: (() => void) | undefined;
  try {
    unregister = await daemon.runtimeSdk!.codeExecution!.refreshForStorage(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
    if (daemon.embedded.supportsProtectedPaths?.() !== true) throw new Error("the daemon's embedded host does not report protected paths with the installed SDK");
    for (const topology of ["chat", "dispatch"] as const) {
      if (daemon.runtimeSdk!.spawnHookFor(topology) instanceof EmbeddedRuntimeUnavailable) throw new Error("the capable SDK's embedded topology was refused");
    }
  } finally { unregister?.(); await daemon.stop(); }
  process.stdout.write("embedded descendant gate verified\n");
  process.exit(0);
}
if (mode === "daemon") {
  const { startDaemon } = await import("../../../src/daemon");
  const { FileSecretStore } = await import("../../../src/auth/secret-store");
  const { EmbeddedRuntimeUnavailable } = await import("../../../src/runtime-sdk/embedded");
  const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null, embeddedHost: { hostPathProtectionCapability: null } });
  let unregister: (() => void) | undefined;
  try {
    const captured = daemon.runtimeSdk!.spawnHookFor("chat") as { spawnClaudeCodeProcess: (options: unknown) => unknown };
    unregister = await daemon.runtimeSdk!.codeExecution!.refreshForStorage(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
    for (const topology of ["chat", "dispatch"] as const) {
      if (!(daemon.runtimeSdk!.spawnHookFor(topology) instanceof EmbeddedRuntimeUnavailable)) throw new Error("real daemon embedded topology was admitted");
    }
    let refused = false;
    try { daemon.embedded.spawn({ command: "winter-embedded", args: [], cwd, env }); } catch (error) { refused = error instanceof EmbeddedRuntimeUnavailable; }
    if (!refused) throw new Error("real daemon failed to pass its trusted home to embedded host");
    refused = false;
    try { captured.spawnClaudeCodeProcess({ command: "winter-embedded", args: [], cwd, env }); } catch (error) { refused = (error as { reason?: string }).reason === "embedded-host-floor-unavailable"; }
    if (!refused || daemon.embedded.live().length) throw new Error("real daemon captured spawn was admitted");
  } finally { unregister?.(); await daemon.stop(); }
  process.stdout.write("embedded descendant gate verified\n");
  process.exit(0);
}
const q = query({ prompt: "go", options: { model: mode === "live" ? "winter-test/hang" : "winter-test/tooluse", cwd, env, spawnClaudeCodeProcess: options => host.spawn(options) } });
const draining = (async () => { for await (const _message of q) { received++; } })();
try {
  if (mode === "live") {
    // The storage transition kills the Worker and gives it 1000 ms to close, while the SDK's kill grace is 1500 ms: a Worker killed BEFORE its engine is running and answering closes only at
    // the grace, which is past that budget. So activation waits for the real events (engine released, and the engine has streamed its first message), never for the spawn alone and never
    // for a time. The deadline below is a failsafe for a Worker that never gets there, not a pacing delay.
    const deadline = Date.now() + 30_000;
    while ((!host.live().length || started < 1 || received < 1) && Date.now() < deadline) await Bun.sleep(5);
    if (!host.live().length || started < 1 || received < 1) throw new Error("real Worker did not start");
  } else {
    await draining;
    const deadline = Date.now() + 5000;
    while (host.live().length && Date.now() < deadline) await Bun.sleep(5);
    if (host.live().length) throw new Error("real Worker did not close");
  }
  const { HostCodeExecutionService } = await import("../../../src/runtime-sdk/host-code-broker");
  const remove = await new HostCodeExecutionService(home, null).refreshForStorage(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
  try { if (host.live().length) throw new Error("existing embedded context consumer remained live after activation"); }
  finally { remove(); }
} finally {
  await host.shutdown();
  await draining.catch(() => {});
}
process.stdout.write("embedded descendant gate verified\n");
