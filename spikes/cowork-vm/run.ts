import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, realpathSync, statfsSync, readFileSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pins from "./pins.json";
import { acquireOrchestrator } from "./claims";
import { build, checked, out, root, sha256 } from "./build";

if (process.argv.slice(2).some(arg => !["--run-vm", "--confinement-only"].includes(arg))) throw new Error("Only --run-vm and --confinement-only are supported; old fixtures are retained for inspection, never restaged.");
if (!process.argv.includes("--run-vm")) throw new Error("Explicit opt-in required: bun run spikes/cowork-vm/run.ts --run-vm");
const probePhases = process.argv.includes("--confinement-only") ? ["prepare", "smoke", "resume", "direct"] : ["prepare", "smoke", "resume", "direct", "memory", "memory-compact"];
const artifacts = await build();
const space = statfsSync(tmpdir());
if (space.bavail * space.bsize < 8 * 1024 ** 3) throw new Error("less than 8 GiB available for disposable probe");
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "winter-cowork-vm-")));
const orchestration = acquireOrchestrator(fixture);
let launched = false;
try {
  for (const name of ["source", "payload", "home", "shared-ro", "shared-rw"]) {
    const dir = join(fixture, name);
    if (!existsSync(dir)) mkdirSync(dir);
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("fixture directories cannot be aliases");
  }
  writeFileSync(join(fixture, ".winter-cowork-vm-fixture"), "winter-cowork-vm-disposable-v1\n", { mode: 0o600 });
  writeFileSync(join(fixture, "source/.cowork-gate1-disposable"), "cowork-gate1-disposable-v1\n");
  copyFileSync(join(out, "assets/vmlinux"), join(fixture, "vmlinux"));
  // Fixture DAC only: never modify real selected-folder ownership/permissions.
  chmodSync(join(fixture, "source"), 0o2777);
  const seed = join(fixture, "source/seed.txt");
  if (existsSync(seed) && (!lstatSync(seed).isFile() || lstatSync(seed).isSymbolicLink())) throw new Error("fixture seed must be regular");
  writeFileSync(seed, "source-seed"); chmodSync(seed, 0o666);
  if (!existsSync(join(fixture, "source/seed-alias"))) symlinkSync("seed.txt", join(fixture, "source/seed-alias"));
  const strict = join(fixture, "source/strict-source");
  if (!existsSync(strict)) mkdirSync(strict);
  if (!lstatSync(strict).isDirectory() || lstatSync(strict).isSymbolicLink()) throw new Error("strict fixture must be a real directory");
  chmodSync(strict, 0o755);
  const strictSeed = join(strict, "seed.txt");
  if (existsSync(strictSeed) && (!lstatSync(strictSeed).isFile() || lstatSync(strictSeed).isSymbolicLink())) throw new Error("strict seed must be regular");
  writeFileSync(strictSeed, "source-seed"); chmodSync(strictSeed, 0o644);
  if (!existsSync(join(strict, "seed-alias"))) symlinkSync("seed.txt", join(strict, "seed-alias"));
  for (const share of ["shared-ro", "shared-rw"]) {
    chmodSync(join(fixture, share), 0o755);
    for (const directory of ["instructions", "memory"]) {
      mkdirSync(join(fixture, share, directory), { mode: 0o755 });
      chmodSync(join(fixture, share, directory), 0o755);
    }
    for (const [name, content] of [["instructions/WINTER.md", "host-shared-instruction\n"], ["memory/seed.txt", "host-shared-memory\n"]]) {
      const file = join(fixture, share, name!);
      writeFileSync(file, content!); chmodSync(file, 0o644);
    }
  }
  mkdirSync(join(fixture, "shared-rw/writable-memory"), { mode: 0o755 });
  writeFileSync(join(fixture, "shared-rw/writable-memory/seed.txt"), "host-writable-memory\n", { mode: 0o644 });
  const payloadDigests: Record<string, string> = {};
  for (const name of ["run.sh", "tool-smoke.sh", "run-direct.sh", "tool-direct.sh", "denials.sh", "confine", "memprobe"]) {
    const from = name.endsWith(".sh") ? join(root, "guest", name) : artifacts.helpers[name]!;
    copyFileSync(from, join(fixture, "payload", name)); chmodSync(join(fixture, "payload", name), 0o555);
    payloadDigests[name] = await sha256(join(fixture, "payload", name));
  }
  writeFileSync(join(fixture, "config.json"), JSON.stringify({ ...pins, probePhases, payloadDigests, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  writeFileSync(join(out, "latest-fixture.txt"), fixture + "\n");
  console.log(`Disposable fixture: ${fixture}`);
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(),
    WINTER_COWORK_PROBE_CLAIM: orchestration.token, WINTER_HOME: join(fixture, "home"), WINTER_COWORK_VM_TESTS: "1", WINTER_LOGIN_SHELL_PATH: "off",
  };
  // Deliberately separate processes: smoke->resume proves more than an in-memory restart.
  for (const phase of probePhases) {
    launched = true;
    await checked(artifacts.binary, ["--library", artifacts.library, "--fixture", fixture, "--phase", phase], { env });
  }
  console.log(`Selected offline checks finished. Reports retained at ${fixture}; gate 1 is NOT complete.`);

} finally {
  const stopped = !launched || (existsSync(join(fixture, "owner.json")) && JSON.parse(readFileSync(join(fixture, "owner.json"), "utf8")).stopped === true && !existsSync(join(fixture, ".probe-claim")));
  orchestration.release(stopped);
}
