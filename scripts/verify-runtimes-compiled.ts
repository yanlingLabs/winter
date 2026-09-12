/**
 * Winter Phase 8d — the compiled-binary proof that the P8d-1 bundle layout resolves inside the
 * REAL Release artifact (`dist/winter-core`, a `bun build --compile` single-file binary), the same
 * way `scripts/verify-runtime-state-compiled.ts` proves 8a's runtime spine.
 *
 * Why this can't be proven under plain `bun test`: `official-executable.ts`'s package door and
 * `executable.ts`'s bundle rung both resolve real filesystem paths relative to `process.execPath` —
 * under `bun test` that's the `bun` binary itself, not a daemon sitting in `Contents/Resources/`.
 * Only running the real compiled binary, laid out exactly as the Release app would, proves the
 * bundle rung (not the dev `node_modules` package door) is what actually resolves.
 *
 * Steps:
 *   1. `bun run --filter '@winter/cli' compile:core` -> dist/winter-core (the same invocation
 *      verify-workflow-compiled.ts and verify-runtime-state-compiled.ts use).
 *   2. mkdtemp a fake `Contents/Resources/` — copy the compiled binary in as `winter-core` (so
 *      `process.execPath` inside the spawned process really is `<tmp>/Resources/winter-core`, and
 *      `dirname(execPath)` really is `<tmp>/Resources`, exactly like a Release app).
 *   3. `stageRuntimes({ out: <tmp>/Resources/runtimes, winterPath: dist/winter if present })` —
 *      reuses an already-built `dist/winter` (CI's `winter-binary` artifact, or a prior
 *      `bun run build:winter`) rather than paying for a fresh SDK-checkout build here; the claude
 *      binary resolves through the same installed-platform-package door `stage-runtimes.ts`
 *      always uses.
 *   4. Take a signature of the REAL homes (`~/.winter`, `~/.winter-dev`) BEFORE the run.
 *   5. `spawn(<tmp>/Resources/winter-core, ["__runtimes-probe"], { env: { WINTER_HOME: <tmp>/home } })`.
 *   6. Parse the one JSON result line; assert both ladders resolved via "bundle", the staged
 *      `VERSIONS.json` parsed and matches this build's pins, and `claude --version` really ran.
 *   7. Re-take the real-home signature and assert it is UNCHANGED.
 *   8. `rm -rf` both temp dirs — in a `finally`, failure paths included.
 *
 * Standalone — never part of the `bun test` sweep (it runs a full compile and, on a cold machine,
 * a `buildWinter()`). Run it as:
 *
 *   bun run verify:runtimes
 *   bun run scripts/verify-runtimes-compiled.ts
 *
 * NEVER run the compiled binary against a real home — see step 4/7 above.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstalledWinterPackage, stageRuntimes, type StageRuntimesOpts } from "./stage-runtimes";
import { REQUIRED_CLAUDE_AGENT_SDK } from "../packages/core/src/runtime-sdk/versions";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "winter-core");
const DIST_WINTER = join(REPO_ROOT, "dist", "winter");
const COMPILE_TIMEOUT_MS = 180_000;
/** The probe resolves two ladders, best-effort `codesign`s them, and runs one real `claude
 *  --version` — seconds in practice; this only guards against a genuine hang. */
const PROBE_TIMEOUT_MS = 60_000;
const REAL_HOMES = [join(homedir(), ".winter"), join(homedir(), ".winter-dev")];
/** Controller measurement M1: the pinned platform package's own `claude --version`. */
const EXPECTED_CLAUDE_VERSION_PREFIX = "2.1.250";

function log(line: string): void { console.log(line); }

class ProofFailure extends Error {
  constructor(message: string) { super(message); this.name = "ProofFailure"; }
}

function fail(message: string): never {
  throw new ProofFailure(message);
}

/** A signature of a real home: what EXISTS there, nothing about when it was written (see
 *  `verify-runtime-state-compiled.ts`'s own `homeSignature` for the full rationale — no mtimes, no
 *  sizes, since a live daemon's own churn there must never make this check flap). */
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

async function main(): Promise<void> {
  log("=== Winter Phase 8d: compiled-binary runtimes-bundle proof ===");
  log(`repo root   : ${REPO_ROOT}`);
  log(`dist binary : ${DIST_BINARY}`);

  // ---- Step 1: compile the REAL Release artifact -----------------------------------------------
  log("\n--- Step 1: compiling dist/winter-core (bun run --filter '@winter/cli' compile:core) ---");
  const compileStart = Date.now();
  const compile = spawnSync(
    process.execPath,
    ["run", "--filter", "@winter/cli", "compile:core"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
  );
  log(`compile:core exit=${compile.status ?? "null"} signal=${compile.signal ?? "none"} (${Date.now() - compileStart}ms)`);
  if (compile.stdout?.trim()) log(compile.stdout.trim());
  if (compile.stderr?.trim()) log(`[stderr]\n${compile.stderr.trim()}`);
  if (compile.error) fail(`compile:core failed to spawn: ${compile.error.message}`);
  if (compile.status !== 0) fail(`compile:core exited ${compile.status ?? `signal ${compile.signal}`} — see output above`);
  if (!existsSync(DIST_BINARY)) fail(`compile:core reported success but ${DIST_BINARY} was not produced`);

  // ---- Step 2: a fake Contents/Resources/ with the compiled binary copied in -------------------
  const tmpRoot = mkdtempSync(join(tmpdir(), "winter-runtimes-probe-"));
  const resources = join(tmpRoot, "Resources");
  mkdirSync(resources, { recursive: true });
  const stagedBinary = join(resources, "winter-core");
  copyFileSync(DIST_BINARY, stagedBinary);
  chmodSync(stagedBinary, 0o755);
  log(`\n--- Step 2: staged binary at ${stagedBinary} (dirname(execPath) is what the bundle rung resolves against) ---`);

  // ---- Step 3: stage the runtime payload beside it ----------------------------------------------
  // P9a-8: winter's source is now a ladder — the installed platform package first (the strong
  // row-16 path), an already-built dist/winter next (checkout-build, e.g. CI's fallback step or a
  // prior `bun run build:winter`), and only as a last resort a real from-source build. This proof
  // is about the BUNDLE RUNG resolving inside the compiled binary (step 6 below), never about
  // which winter-source ladder rung staged it — so it takes whichever is cheapest and available,
  // loudly, rather than paying for a two-minute SDK-checkout build when something staged already
  // exists.
  log("\n--- Step 3: staging runtimes/ (stageRuntimes) ---");
  const platformPackage = resolveInstalledWinterPackage();
  let stageOpts: StageRuntimesOpts = { out: join(resources, "runtimes") };
  if (platformPackage !== undefined) {
    log(`using the installed platform package: ${platformPackage.binPath} (version ${platformPackage.version}) — winterSource will be platform-package`);
  } else if (existsSync(DIST_WINTER)) {
    log(`WARNING: no @yanlinglabs/winter-agent-sdk-darwin-arm64 platform package installed — falling back to the already-built ${DIST_WINTER} (winterSource=checkout-build, the weaker row-16 path)`);
    stageOpts = { ...stageOpts, winterPath: DIST_WINTER, winterSource: "checkout-build" };
  } else {
    log(`WARNING: no platform package installed and no ${DIST_WINTER} found — stageRuntimes will call buildWinter() (a real SDK-checkout build, winterSource=checkout-build)`);
  }
  let staged: Awaited<ReturnType<typeof stageRuntimes>>;
  try {
    staged = await stageRuntimes(stageOpts);
  } catch (err) {
    fail(`stageRuntimes failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`staged: winter=${staged.winterPath} claude=${staged.claudePath} versions=${staged.versionsPath}`);
  log(`VERSIONS.json: ${JSON.stringify(staged.versions)}`);

  const tmpHome = mkdtempSync(join(tmpdir(), "winter-runtimes-probe-home-"));
  log(`\n--- Step 4: temp WINTER_HOME = ${tmpHome} ---`);
  const before = REAL_HOMES.map(homeSignature);

  try {
    // ---- Step 5: run the compiled binary's probe route ------------------------------------------
    log(`\n--- Step 5: spawn ${stagedBinary} __runtimes-probe ---`);
    const child = spawn(stagedBinary, ["__runtimes-probe"], {
      stdio: ["ignore", "pipe", "pipe"],
      // Narrow env, same reasoning as verify-runtime-state-compiled.ts: inheriting process.env
      // could drag this shell's own WINTER_HOME/WINTER_RUNTIME_EXECUTABLE/WINTER_CLAUDE_EXECUTABLE in,
      // which would defeat the entire point of proving the BUNDLE rung resolves.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), WINTER_HOME: tmpHome },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms waiting for the probe to exit`));
        }, PROBE_TIMEOUT_MS);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => { clearTimeout(timer); resolvePromise(code); });
      });
    } catch (err) {
      if (stdout.trim()) log(`[stdout]\n${stdout.trim()}`);
      if (stderr.trim()) log(`[stderr]\n${stderr.trim()}`);
      fail((err as Error).message);
    }

    if (stderr.trim()) log(`[stderr from probe]\n${stderr.trim()}`);
    log(`[stdout from probe]\n${stdout.trim()}`);
    log(`probe exited: ${exitCode}`);

    let result: Record<string, unknown> | undefined;
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        if (parsed && typeof parsed === "object" && "ok" in parsed) result = parsed as Record<string, unknown>;
      } catch { /* narration, not the result line */ }
    }
    if (!result) fail("the probe printed no JSON result line — see its stdout/stderr above (a bundling gap looks exactly like this)");
    log(`\nprobe result line: ${JSON.stringify(result)}`);

    // ---- Steps 6-7: the assertions ---------------------------------------------------------------
    const after = REAL_HOMES.map(homeSignature);
    const untouched = REAL_HOMES.map((dir, i) => [dir, before[i] === after[i]] as const);
    for (const [dir, ok] of untouched) if (!ok) log(`\n[real home CHANGED] ${dir}`);

    const winter = result.winter as Record<string, unknown> | undefined;
    const claude = result.claude as Record<string, unknown> | undefined;
    const versions = result.versions as Record<string, unknown> | undefined;
    const claudeVersion = typeof claude?.version === "string" ? claude.version : undefined;

    const checks: Array<[string, boolean]> = [
      ["the compiled binary produced a JSON result line", true],
      ["result.ok === true", result.ok === true],
      ["result.winter.source === 'bundle'", winter?.source === "bundle"],
      ["result.winter.executable === true", winter?.executable === true],
      ["result.claude.source === 'bundle'", claude?.source === "bundle"],
      ["result.claude.executable === true", claude?.executable === true],
      [`result.claude.version starts with '${EXPECTED_CLAUDE_VERSION_PREFIX}' (M1)`, !!claudeVersion?.startsWith(EXPECTED_CLAUDE_VERSION_PREFIX)],
      [`result.versions.officialSdk === ${REQUIRED_CLAUDE_AGENT_SDK} (this build's pin)`, versions?.officialSdk === REQUIRED_CLAUDE_AGENT_SDK],
      [`result.versions.winterSource === '${staged.versions.winterSource}' (P9a-8: matches what Step 3 actually staged)`, versions?.winterSource === staged.versions.winterSource],
      ["probe exited 0", exitCode === 0],
      ...untouched.map(([dir, ok]) => [`${dir}: unchanged`, ok] as [string, boolean]),
    ];

    log("\n--- Assertions ---");
    for (const [name, ok] of checks) log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);

    if (!checks.every(([, ok]) => ok)) {
      fail(
        "one or more assertions failed — the compiled binary did NOT resolve the P8d-1 bundle " +
          "layout the way the Release app will. Diagnose before touching the assertions: (a) no " +
          "JSON line at all -> the __runtimes-probe route or the runtime-sdk barrel did not survive " +
          "`bun build --compile`; (b) source !== 'bundle' -> bundleRuntimePath's execPath math is " +
          "wrong for this layout, or stageRuntimes wrote somewhere else; (c) a real home changed -> " +
          "the probe resolved a home instead of reading WINTER_HOME, the one failure this script must " +
          "never let through.",
      );
    }

    log(
      "\nRESULT: PASS — dist/winter-core (the real `bun build --compile` Release artifact), laid out " +
        "exactly as the app bundle will be, resolved BOTH runtime executables through the P8d-1 " +
        "'bundle' rung, parsed a matching VERSIONS.json, and ran a real `claude --version` — the " +
        "user's real homes were left untouched throughout.",
    );
  } finally {
    // Runs on every path, failures included — the temp home and staged binary hold nothing
    // sensitive, but leaving multi-hundred-MB copies of `claude` behind on every failed run would
    // be its own kind of mess.
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    log(`\n(cleanup) removed ${tmpHome} and ${tmpRoot}`);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof ProofFailure) console.error(`\nRESULT: FAIL — ${err.message}`);
    else console.error(err);
    process.exit(1);
  },
);
