// Explicit local SDK binding, disposable homes and fixture bytes. Does not lift Core acceptance-version 0.
import { query, type SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedSessionHost } from "../../../src/runtime-sdk/embedded";
import { registerHostStorageFences } from "../../../src/runtime-sdk/host-storage-fence";
import type { EmbeddedProtectionCapability } from "../../../src/runtime-sdk/embedded-path-protection";

const checkout = process.argv[2];
if (!checkout) throw new Error("explicit candidate SDK checkout required");
const candidate = await import(join(checkout, "packages/runtime/src/embedded-host.ts"));
const capability: EmbeddedProtectionCapability = {
  contractVersion: candidate.HOST_CODE_PROTECTION_CONTRACT_VERSION,
  capability: candidate.HOST_CODE_PROTECTION_CAPABILITY,
  coverage: candidate.HOST_CODE_PROTECTION_COVERAGE,
};
const root = mkdtempSync(join(tmpdir(), "winter-core-live-policy-")), home = join(root, "home"), source = join(root, "source"), userHome = join(root, "user");
for (const path of [source, userHome, join(home, "cowork/workspaces/w")]) mkdirSync(path, { recursive: true });
const target = join(home, "cowork/workspaces/w/manifest.json"); writeFileSync(target, "synthetic-control-marker");
let proc: SpawnedRuntimeProcess | undefined, remove: (() => void) | undefined, acknowledged = false;
const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: capability,
  workerEntry: join(checkout, "packages/runtime/src/embedded-worker.ts"),
  spawnWorker: candidate.spawnEmbeddedWorker,
});
try {
  const messages: unknown[] = [];
  for await (const message of query({ prompt: target, options: { model: "winter-test/p5checkpoint", cwd: source, persistSession: false,
    env: { HOME: userHome, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated", WINTER_HOST_CODE_PROTECTION: "disabled" },
    canUseTool: async (name, input) => {
      if (name === "Write") {
        remove = registerHostStorageFences(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
        if (await host.refreshProtectedPaths!() !== false) throw new Error("unreviewed SDK falsely enabled protected context");
        acknowledged = true;
      }
      return { behavior: "allow", updatedInput: input };
    },
    spawnClaudeCodeProcess: options => { proc = host.spawn(options); return proc; },
  } })) messages.push(message);
  await proc!.exited;
  if (!acknowledged || host.supportsProtectedPaths!() !== false) throw new Error("live partial-policy integration failed");
  if (readFileSync(target, "utf8") !== "synthetic-control-marker") throw new Error("protected fixture write escaped path policy");
  if (!JSON.stringify(messages.filter(message => (message as { type?: string }).type === "user")).includes("protected host path access refused")) throw new Error("actual Worker did not report its guarded Write refusal");
  process.stdout.write("actual local SDK live file policy verified; context gate retained\n");
} finally { remove?.(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); }
