import { query } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedSessionHost } from "../../../src/runtime-sdk/embedded";
import { registerHostStorageFences } from "../../../src/runtime-sdk/host-storage-fence";

const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-embedded-descendants-")));
const home = join(root, "home"), cwd = join(root, "project");
mkdirSync(join(home, "cowork"), { recursive: true }); mkdirSync(cwd);
const host = createEmbeddedSessionHost({ home });
const mode = process.argv[2];
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated" };
if (mode === "daemon") {
  const { startDaemon } = await import("../../../src/daemon");
  const { FileSecretStore } = await import("../../../src/auth/secret-store");
  const { EmbeddedRuntimeUnavailable } = await import("../../../src/runtime-sdk/embedded");
  const daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
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
const draining = (async () => { for await (const _message of q) { /* fixture protocol only */ } })();
try {
  if (mode === "live") {
    const deadline = Date.now() + 5000;
    while (!host.live().length && Date.now() < deadline) await Bun.sleep(5);
    if (!host.live().length) throw new Error("real Worker did not start");
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
