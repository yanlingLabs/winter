/**
 * The compiled-binary proof that the Cowork native channel's receiver thread starts in the SHIPPED `winter-core`.
 *
 * `fd-channel.ts` serves every launcher channel from ONE Bun Worker. In dev it builds the Worker from an absolute source URL; in a compiled binary it must use the plain relative
 * string `./fd-receiver-worker.ts` (a `new URL(...).href` hangs silently, WS-23 spike #1), which resolves only if `packages/cli/src/fd-receiver-worker.ts` was passed to
 * `compile:core` as a third entrypoint. `bun test` only runs the dev path, so nothing but the real artifact notices that missing.
 *
 *   1. `compile:core` -> dist/winter-core (all three entrypoints).
 *   2. A copy in a throwaway directory, ad-hoc signed the way the Release app signs winter-core (hardened runtime + scripts/winter-core.entitlements).
 *   3. `<copy> __fd-receiver-probe` from that directory, with a narrow environment and a temp WINTER_HOME: socketpair, one line through the receiver hub, expect the line back.
 *   4. The negative control: the same probe against a copy of the binary whose Worker entry cannot be found must NOT print ok. (Checked without rebuilding: the probe is run with the
 *      entry string patched in the copy to a name that does not exist.)
 *
 *   bun run verify:fd-receiver
 *
 * Standalone, never part of `bun test`. The probe touches no home, no Keychain, no daemon and no launcher, and the script never runs anything but the temp copy.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "winter-core");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "winter-core.entitlements");
const COMPILE_TIMEOUT_MS = 180_000, PROBE_TIMEOUT_MS = 30_000;
export const ENTRY_NAME = "./fd-receiver-worker.ts";

/** The probe's one JSON line, or undefined. */
export function parseProbe(stdout: string): { ok: boolean; line?: string; error?: string } | undefined {
  for (const raw of stdout.split("\n")) {
    const text = raw.trim();
    if (!text.startsWith("{")) continue;
    try { const value = JSON.parse(text); if (typeof value?.ok === "boolean") return value; } catch { /* not the line */ }
  }
  return undefined;
}

/** A copy of the binary whose receiver entry string names a file that is not embedded (same length, so the executable layout is untouched). Null when the entry string is absent. */
export function withBrokenEntry(binary: Uint8Array): Buffer | null {
  const needle = Buffer.from(ENTRY_NAME), replacement = Buffer.from("./fd-receiver-wxrker.ts");
  const bytes = Buffer.from(binary);
  let at = bytes.indexOf(needle), count = 0;
  while (at >= 0) { replacement.copy(bytes, at); count += 1; at = bytes.indexOf(needle, at + needle.length); }
  return count > 0 ? bytes : null;
}

function runChild(binary: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve({ code: null, stdout, stderr: `${stderr}\n(timed out after ${PROBE_TIMEOUT_MS} ms)` }); }, PROBE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function sign(path: string): void {
  const result = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", ENTITLEMENTS, path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`codesign of ${path} failed: ${(result.stderr ?? "").trim()}`);
}

async function main(): Promise<void> {
  console.log("=== compiled-binary proof: the Cowork channel's receiver thread ===");
  const compile = spawnSync(process.execPath, ["run", "--filter", "@yanlinglabs/winter-cli", "compile:core"], { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (compile.status !== 0) throw new Error(`compile:core failed:\n${compile.stdout ?? ""}\n${compile.stderr ?? ""}`);
  if (!existsSync(DIST_BINARY)) throw new Error(`compile:core reported success but ${DIST_BINARY} was not produced`);
  const scratch = mkdtempSync(join(tmpdir(), "winter-fd-receiver-proof-"));
  try {
    const home = join(scratch, "home"); mkdirSync(home);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), WINTER_HOME: home, WINTER_PROFILE: "dev", WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated", WINTER_LOGIN_SHELL_PATH: "off" };
    const good = join(scratch, "winter-core");
    copyFileSync(DIST_BINARY, good); chmodSync(good, 0o755); sign(good);
    const run = await runChild(good, ["__fd-receiver-probe"], env, scratch);
    const result = parseProbe(run.stdout);
    if (run.code !== 0 || result?.ok !== true) throw new Error(`the compiled daemon's receiver thread did not start (exit ${run.code}): ${JSON.stringify(result)}\n${run.stderr.trim()}`);
    console.log(`ok: the probe line came back through the receiver hub (${JSON.stringify(result)})`);

    const broken = withBrokenEntry(readFileSync(DIST_BINARY));
    if (broken === null) throw new Error(`the binary does not contain the entry string ${ENTRY_NAME}: fd-channel.ts does not use the compiled entry`);
    const bad = join(scratch, "winter-core-broken");
    writeFileSync(bad, broken); chmodSync(bad, 0o755); sign(bad);
    const negative = await runChild(bad, ["__fd-receiver-probe"], env, scratch);
    if (parseProbe(negative.stdout)?.ok === true) throw new Error("negative control failed: a binary without the worker entry still passed the probe, so the probe proves nothing");
    console.log("ok: the negative control (entry renamed in a copy) is refused by the same probe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) main().catch((error) => { console.error(`verify:fd-receiver: ${(error as Error).message}`); process.exit(1); });
