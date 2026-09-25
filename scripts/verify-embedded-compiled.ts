/**
 * WS-23 — the compiled-binary proof that chat runs EMBEDDED in the shipped `winter-core`.
 *
 * The sibling of `verify-runtime-state-compiled.ts` and `verify-workflow-compiled.ts`, for the same
 * reason: an embedded chat/dispatch session runs in a Bun Worker constructed from a plain relative
 * path to a SECOND `compile:core` entrypoint (`packages/cli/src/embedded-worker.ts`), and `bun test`
 * only ever runs the dev path, where the same code builds the Worker from an absolute source path.
 * A `new URL(…, import.meta.url).href` spelling hangs silently in a compiled binary (WS-23 spike #1),
 * and a worker file missing from `$bunfs` fails only at the first session — so nothing but the real
 * artifact closes the gap.
 *
 * What it does:
 *   1. `bun run --filter '@yanlinglabs/winter-cli' compile:core` -> dist/winter-core (both entrypoints).
 *   2. `mkdtemp` a throwaway WINTER_HOME; take a NAME signature of the real homes (`~/.winter`,
 *      `~/.winter-dev`) before the run.
 *   3. Copy the binary and sign the copy the way the Release app signs winter-core (ad-hoc, hardened
 *      runtime, `scripts/bun-jit.entitlements`) — the Workers must run under the shipped posture.
 *   4. `<copy> __embedded-probe`: a REAL daemon on the temp home with a FileSecretStore (never the
 *      Keychain), settings naming a `winter` executable that does NOT exist, one chat turn on the
 *      scripted `winter-test/echo` double over the daemon's own socket (`runtime-sdk/embedded-probe.ts`).
 *   5. `<copy> __runtime-workflow-worker` with no `--bridge`: the route must reach the RUNTIME's
 *      workflow worker (exit 78, "invoked without --bridge"), not the daemon's own `__workflow-worker`.
 *   6. Re-take the real-home signatures and assert them unchanged; `rm -rf` every temp dir in a
 *      `finally`.
 *
 * Standalone — never part of the `bun test` sweep (a full compile). Run it as:
 *
 *   bun run verify:embedded
 *
 * NEVER run the compiled binary against a real home: the temp WINTER_HOME and the FileSecretStore are
 * this script's whole safety model. The env handed to the probe is deliberately narrow, and names a
 * Keychain service with no items (`WINTER_KEYCHAIN_SERVICE`, honoured for a non-default home only), so
 * even a stray credential read in the embedded session could not reach a real item.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "winter-core");
const BUN_JIT_ENTITLEMENTS = join(REPO_ROOT, "scripts", "bun-jit.entitlements");
const COMPILE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 90_000;
const REAL_HOMES = [join(homedir(), ".winter"), join(homedir(), ".winter-dev")];

class ProofFailure extends Error {
  constructor(message: string) { super(message); this.name = "ProofFailure"; }
}
function fail(message: string): never { throw new ProofFailure(message); }
function log(line: string): void { console.log(line); }

/** What EXISTS in a real home, by name only — see `verify-runtime-state-compiled.ts`'s own note on why never mtimes. */
function homeSignature(dir: string): string {
  if (!existsSync(dir)) return `${dir}: absent`;
  const names: string[] = [];
  const walk = (p: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(p).sort(); } catch { names.push(`${rel}/ <unreadable>`); return; }
    for (const name of entries) {
      const child = join(p, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try { isDir = statSync(child).isDirectory(); } catch { names.push(`${childRel} <unreadable>`); continue; }
      names.push(isDir ? `${childRel}/` : childRel);
      if (isDir) walk(child, childRel);
    }
  };
  walk(dir, "");
  return `${dir}: present\n${names.join("\n")}`;
}

async function runChild(binary: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)); }, PROBE_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (c) => { clearTimeout(timer); resolve(c); });
  });
  return { code, stdout, stderr };
}

async function main(): Promise<void> {
  log("=== WS-23: compiled-binary embedded chat proof ===");

  // ---- Step 1 -------------------------------------------------------------------------------
  log("\n--- Step 1: compiling dist/winter-core (compile:core: src/main.ts + src/embedded-worker.ts) ---");
  const t0 = Date.now();
  const compile = spawnSync(process.execPath, ["run", "--filter", "@yanlinglabs/winter-cli", "compile:core"], { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  log(`compile:core exit=${compile.status ?? "null"} (${Date.now() - t0}ms)`);
  if (compile.status !== 0) fail(`compile:core failed:\n${compile.stdout ?? ""}\n${compile.stderr ?? ""}`);
  if (!existsSync(DIST_BINARY)) fail(`compile:core reported success but ${DIST_BINARY} was not produced`);

  // ---- Steps 2-3 ----------------------------------------------------------------------------
  const scratch = mkdtempSync(join(tmpdir(), "winter-embedded-proof-"));
  const tmpHome = join(scratch, "home");
  mkdirSync(tmpHome);
  const before = REAL_HOMES.map(homeSignature);
  const probeBinary = join(scratch, "winter-core");
  copyFileSync(DIST_BINARY, probeBinary);
  chmodSync(probeBinary, 0o755);
  const sign = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", BUN_JIT_ENTITLEMENTS, probeBinary], { encoding: "utf8" });
  if (sign.status !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    fail(`codesign of the probe copy failed: ${(sign.stderr ?? "").trim()}`);
  }
  const gitConfig = join(scratch, "gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = winter-proof\n\temail = winter-proof@example.invalid\n");
  // Narrow on purpose: nothing from this shell's WINTER_* can reach the daemon the probe boots.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    WINTER_HOME: tmpHome,
    WINTER_PROFILE: "dev",
    WINTER_KEYCHAIN_SERVICE: "com.winter.core.test-isolated",
    WINTER_LOGIN_SHELL_PATH: "off",
    WINTER_CLAUDE_RESUME_SCAN_ROOT: join(scratch, "claude-resume-scan"),
    XDG_CONFIG_HOME: join(scratch, "xdg"),
    GIT_CONFIG_GLOBAL: gitConfig,
  };

  try {
    // ---- Step 4 -------------------------------------------------------------------------------
    log(`\n--- Step 4: ${probeBinary} __embedded-probe (WINTER_HOME=${tmpHome}) ---`);
    const probe = await runChild(probeBinary, ["__embedded-probe"], env);
    if (probe.stderr.trim()) log(`[stderr from probe]\n${probe.stderr.trim()}`);
    let result: Record<string, unknown> | undefined;
    for (const line of probe.stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        if (parsed && typeof parsed === "object" && "ok" in parsed) result = parsed as Record<string, unknown>;
      } catch { /* the daemon's own narration */ }
    }
    if (!result) fail(`the probe printed no JSON result line (a Worker entry missing from $bunfs looks like this):\n${probe.stdout}`);
    log(`probe result: ${JSON.stringify(result)}`);

    // ---- Step 5 -------------------------------------------------------------------------------
    log(`\n--- Step 5: ${probeBinary} __runtime-workflow-worker (no --bridge) ---`);
    const wf = await runChild(probeBinary, ["__runtime-workflow-worker"], env);
    log(`exit=${wf.code} stderr=${wf.stderr.trim()}`);

    // ---- Step 6 -------------------------------------------------------------------------------
    const after = REAL_HOMES.map(homeSignature);
    const checks: Array<[string, boolean]> = [
      ["result.ok === true", result.ok === true],
      ["result.compiled === true (the daemon ran from $bunfs)", result.compiled === true],
      ["the chat session's Worker was live during its turn", result.workerLive === true],
      ["the turn: user_message, turn_started, assistant_message, turn_completed", JSON.stringify(result.turn) === JSON.stringify(["user_message", "turn_started", "assistant_message", "turn_completed"])],
      ["stop() left no embedded Worker behind", result.workersAfterStop === 0],
      ["probe exited 0", probe.code === 0],
      ["the probe used a FileSecretStore under the temp home (never the Keychain)", existsSync(join(tmpHome, "probe-secrets"))],
      ["__runtime-workflow-worker reached the RUNTIME's worker (exit 78, undriven)", wf.code === 78 && wf.stderr.includes("without --bridge")],
      ...REAL_HOMES.map((dir, i) => [`${dir}: unchanged`, before[i] === after[i]] as [string, boolean]),
    ];
    log("\n--- checks ---");
    for (const [name, ok] of checks) log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (checks.some(([, ok]) => !ok)) fail("one or more checks failed");
    log("\nRESULT: PASS — the compiled winter-core ran one embedded chat turn in a Worker built from its second entrypoint");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nRESULT: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
