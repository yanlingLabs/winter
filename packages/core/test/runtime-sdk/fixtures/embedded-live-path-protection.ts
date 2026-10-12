// Explicit local SDK binding, disposable homes and fixture bytes. Uses the independently accepted context contract.
import { query, type SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedSessionHost } from "../../../src/runtime-sdk/embedded";
import { registerHostStorageFences, refreshHostStoragePolicies } from "../../../src/runtime-sdk/host-storage-fence";
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
let proc: SpawnedRuntimeProcess | undefined, remove: (() => void) | undefined, acknowledged = false, kills = 0, starts = 0;
const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: capability,
  workerEntry: join(checkout, "packages/runtime/src/embedded-worker.ts"),
  onLifecycle: event => { if (event.event === "start") starts++; },
  spawnWorker: options => { const worker = candidate.spawnEmbeddedWorker(options); const kill = worker.kill.bind(worker); worker.kill = () => { kills++; kill(); }; return worker; },
});
try {
  const messages: unknown[] = [];
  for await (const message of query({ prompt: target, options: { model: "winter-test/p5checkpoint", cwd: source, persistSession: false,
    env: { HOME: userHome, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated", WINTER_HOST_CODE_PROTECTION: "disabled" },
    canUseTool: async (name, input) => {
      if (name === "Write") {
        remove = registerHostStorageFences(home, { coordinationDir: join(root, "coordination"), coworkStorageActive: true });
        await refreshHostStoragePolicies();
        if (host.supportsProtectedPaths!() !== true) throw new Error("reviewed SDK live protection unavailable");
        acknowledged = true;
      }
      return { behavior: "allow", updatedInput: input };
    },
    spawnClaudeCodeProcess: options => { proc = host.spawn(options); return proc; },
  } })) messages.push(message);
  await proc!.exited;
  if (!acknowledged || kills !== 0 || starts !== 1 || host.supportsProtectedPaths!() !== true) throw new Error("live partial-policy integration failed");
  if (readFileSync(target, "utf8") !== "synthetic-control-marker") throw new Error("protected fixture write escaped path policy");
  if (!JSON.stringify(messages.filter(message => (message as { type?: string }).type === "user")).includes("protected host path access refused")) throw new Error("actual Worker did not report its guarded Write refusal");
  // Cold protected bootstrap uses real context discovery, including hostile source aliases.
  const control = join(home, "cowork/control"), rules = join(source, ".winter/rules"), skills = join(source, ".winter/skills");
  for (const path of [control, rules, join(skills, "p5probe"), join(skills, "allowed")]) mkdirSync(path, { recursive: true });
  const initialized = Bun.spawnSync(["/usr/bin/git", "init", "-q", source]);
  if (initialized.exitCode !== 0) throw new Error("fixture repository init failed");
  const markers = ["HOSTILE_IMPORT_BYTES_293", "HOSTILE_RULE_BYTES_293", "HOSTILE_SKILL_BYTES_293"];
  const files = [join(control, "import.md"), join(control, "rule.md"), join(control, "skill.md")];
  writeFileSync(files[0]!, markers[0]!); writeFileSync(files[1]!, markers[1]!);
  writeFileSync(files[2]!, `---\nname: p5probe\ndescription: ${markers[2]}\n---\n${markers[2]}`);
  writeFileSync(join(source, "WINTER.md"), `ALLOWED_PROJECT_GUIDANCE_293\n@${files[0]}\n`);
  symlinkSync(files[1]!, join(rules, "hostile.md"));
  symlinkSync(files[2]!, join(skills, "p5probe/SKILL.md"));
  writeFileSync(join(rules, "allowed.md"), "ALLOWED_RULE_GUIDANCE_293");
  writeFileSync(join(skills, "allowed/SKILL.md"), "---\nname: allowed\ndescription: ALLOWED_SKILL_GUIDANCE_293\n---\nAllowed body");
  for (const model of ["winter-test/echo", "winter-test/p5skill"]) {
    const observed: unknown[] = [];
    for await (const message of query({ prompt: "fixture", options: { model, cwd: source, persistSession: false,
      env: { HOME: userHome, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated" },
      canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
      spawnClaudeCodeProcess: options => { proc = host.spawn(options); return proc; },
    } })) observed.push(message);
    await proc!.exited;
    const text = JSON.stringify(observed);
    if (markers.some(marker => text.includes(marker))) throw new Error("hostile source bytes reached embedded context");
    if (model.endsWith("/echo") && !["ALLOWED_PROJECT_GUIDANCE_293", "ALLOWED_RULE_GUIDANCE_293", "ALLOWED_SKILL_GUIDANCE_293"].every(marker => text.includes(marker))) throw new Error("ordinary embedded source discovery lost guidance");
    if (model.endsWith("/p5skill") && !text.includes("unknown skill")) throw new Error("protected symlink skill was not excluded");
  }
  if (kills !== 0 || Number(starts) !== 3) throw new Error("reviewed protected sessions restarted or failed bootstrap");
  process.stdout.write("actual local SDK live file policy and hostile embedded context verified; reviewed context enabled\n");
} finally { remove?.(); await host.shutdown(); rmSync(root, { recursive: true, force: true }); }
