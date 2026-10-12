// One isolated process per mode: retained descendant evidence belongs to the daemon lifetime.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mode = process.argv[2];
const applyFloor = process.argv[3] ? (await import(process.argv[3])).applyMandatoryFloorToSpawnOptions : undefined;
const { registerHostStorageFences } = await import("../../../src/runtime-sdk/host-storage-fence");
const { HookRunner } = await import("../../../src/plugins/hook-runner");
const { LspManager } = await import("../../../src/agent/lsp/manager");
const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-daemon-child-floor-")));
const home = join(root, "home"), project = join(root, "project"), coordination = join(root, "coordination");
for (const dir of [join(home, "cowork/workspaces/w"), project, coordination]) mkdirSync(dir, { recursive: true });
const options = { coordinationDir: coordination, coworkStorageActive: true };
const payload = { event: "test", sessionId: "fixture", pluginId: "fixture", ts: 1 };
const runner = new HookRunner({ home, applyFloor });
if (mode === "retired") {
  const out = await runner.run({ cwd: project, pluginId: "fixture", command: "true" }, payload);
  if (out.status !== "ok") throw new Error("ordinary hook failed");
  try { registerHostStorageFences(home, options); throw new Error("accepted unproved retired children"); }
  catch (error) { if ((error as { reason?: string }).reason !== "daemon-child-descendants-unconfirmed") throw error; }
} else {
  registerHostStorageFences(home, options);
  const volume = join(home, "cowork/workspaces/w/data.ext4"); writeFileSync(volume, "fixture-private");
  const out = await runner.run({ cwd: project, pluginId: "fixture", command: `cat '${volume}' 2>/dev/null || echo refused; echo ordinary > '${project}/ordinary'` }, payload);
  if (out.status !== "ok" || out.stdout.includes("fixture-private") || !out.stdout.includes("refused")) throw new Error(`hook floor failed: ${JSON.stringify(out)}`);
  if (readFileSync(join(project, "ordinary"), "utf8").trim() !== "ordinary") throw new Error("ordinary hook operation failed");
  const probe = join(project, "server.ts"), result = join(project, "result.json");
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs'; let refused=false; try { readFileSync(${JSON.stringify(volume)},'utf8'); } catch { refused=true; } writeFileSync(${JSON.stringify(result)}, JSON.stringify({refused})); await import(${JSON.stringify(join(import.meta.dir, "../../agent/lsp/fake-server.ts"))});`);
  const manager = new LspManager({ home, applyFloor, serverCommands: { typescript: { command: process.execPath, args: [probe] } } });
  await manager.clientFor(project, "typescript");
  if (JSON.parse(readFileSync(result, "utf8")).refused !== true) throw new Error("LSP floor failed");
  await manager.stopAll();
  // New workspace data under the already enrolled stable roots requires no new floor receipt.
  mkdirSync(join(home, "cowork/workspaces/new"));
  registerHostStorageFences(home, options);
}
process.stdout.write("daemon child floor verified\n");
