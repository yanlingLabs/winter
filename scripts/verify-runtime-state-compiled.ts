/**
 * P8b-18 (C-15) — the compiled-binary proof that 8a's runtime spine is alive in the SHIPPED artifact.
 *
 * The sibling of `scripts/verify-workflow-compiled.ts`, and it exists for the same reason that one
 * does. `runtime-state.db` is created and migrated by `bun:sqlite` inside `runtime-state/db.ts`, and
 * every test of that runs under `bun test` — the DEV path. The daemon that ships is a
 * `bun build --compile` single-file binary whose module graph lives in `/$bunfs`, and this repo has
 * already shipped one subsystem (workflows, C1) that was green in dev and DEAD in the compiled
 * binary. Nothing but running the real artifact can close that gap.
 *
 * What it does:
 *   1. `bun run --filter '@norma/cli' compile:core` -> dist/norma-core (the real Release artifact;
 *      the same invocation verify-workflow-compiled.ts uses, and the same reason for the `--filter`:
 *      `compile:core` is defined only in packages/cli/package.json).
 *   2. `mkdtemp` a throwaway NORMA_HOME.
 *   3. Take a signature of the user's REAL homes (`~/.norma`, `~/.norma-dev`) BEFORE the run —
 *      WHAT EXISTS there, never when it was written (see `homeSignature`).
 *   4. `spawn(dist/norma-core, ["__runtime-state-probe"], { env: { NORMA_HOME: tmp, ... } })` —
 *      the static argv route in packages/cli/src/main.ts, beside `__workflow-worker`.
 *   5. Parse the one JSON line it prints; assert `ok`, `online`, `userVersion` ===
 *      RUNTIME_STATE_SCHEMA_VERSION, and that `dbPath` is inside the temp home.
 *   6. Re-take the real-home signature and assert it is UNCHANGED — a probe that quietly fell back
 *      to `resolveNormaHome()` would otherwise pass every other assertion here.
 *   7. `rm -rf` the temp home — in a `finally`, on the failure paths too (the tokens the probe
 *      minted live in there).
 *
 * Standalone — never part of the `bun test` sweep (it runs a full compile). Run it as:
 *
 *   bun run verify:runtime-state
 *   bun run scripts/verify-runtime-state-compiled.ts
 *
 * NEVER run the compiled binary against a real home. The temp `NORMA_HOME` is the whole safety
 * model of this script: the daemon it boots is a REAL daemon, with a real socket and a real lock.
 */

import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_STATE_SCHEMA_VERSION } from "../packages/core/src/runtime-state/db";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "norma-core");
const COMPILE_TIMEOUT_MS = 180_000;
/** The probe boots a whole daemon (lock, store, twelve recovery steps, retention sweep) and stops
 *  it again. Seconds in practice; this only guards against a genuine hang. */
const PROBE_TIMEOUT_MS = 90_000;
/** The homes this script must prove it did not touch. */
const REAL_HOMES = [join(homedir(), ".norma"), join(homedir(), ".norma-dev")];

function log(line: string): void { console.log(line); }

/** A refusal from one of this script's own checks, as opposed to a crash. Carrying it as an
 *  exception rather than a `process.exit` is what lets `main`'s `finally` run (review F-1): the
 *  temp home holds the daemon tokens the probe minted, and it must not survive a failed run. */
class ProofFailure extends Error {
  constructor(message: string) { super(message); this.name = "ProofFailure"; }
}

function fail(message: string): never {
  throw new ProofFailure(message);
}

/**
 * A signature of a real home: what EXISTS there, and nothing about when it was written.
 *
 * NO MTIMES, NO SIZES, DELIBERATELY (review F-2). The only thing this check exists to catch is a
 * probe that resolved a real home instead of reading `NORMA_HOME` — and such a probe would CREATE
 * the home, add entries, or create `runtimes/runtime-state.db`, all of which are visible in a name
 * list. Metadata is not: the user's live daemon churns `runtime-state.db-wal`/`-shm` and appends to
 * session logs on every write, so a size/mtime signature would fail for reasons that have nothing to
 * do with this script — and it would fail precisely during the pre-tag gate, when a dev daemon is up.
 * A false FAIL there is worse than useless; it trains people to ignore the check.
 *
 * `runtime-state.db`'s `user_version` is compared as well where the file exists, because a probe
 * that migrated a real home would move it without adding a single name.
 */
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
  return `${dir}: present\n${names.join("\n")}\nruntime-state.db user_version=${readUserVersion(join(dir, "runtimes", "runtime-state.db"))}`;
}

/** `PRAGMA user_version` of a database file, or a stable placeholder. READ-ONLY and wrapped: this is
 *  pointed at the USER'S live database, and a readonly open can legitimately fail (a WAL file whose
 *  `-shm` cannot be created). "unreadable" on both sides of the comparison is still a valid, equal
 *  signature — the name list above is what carries the assertion in that case. */
function readUserVersion(dbPath: string): string {
  if (!existsSync(dbPath)) return "absent";
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return String(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? "null");
    } finally {
      db.close();
    }
  } catch {
    return "unreadable";
  }
}

async function main(): Promise<void> {
  log("=== P8b-18: compiled-binary runtime-state proof ===");
  log(`repo root   : ${REPO_ROOT}`);
  log(`dist binary : ${DIST_BINARY}`);

  // ---- Step 1: compile the REAL Release artifact -----------------------------------------------
  log("\n--- Step 1: compiling dist/norma-core (bun run --filter '@norma/cli' compile:core) ---");
  const compileStart = Date.now();
  const compile = spawnSync(
    process.execPath, // the running bun binary itself — avoids any PATH/version ambiguity
    ["run", "--filter", "@norma/cli", "compile:core"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS },
  );
  log(`compile:core exit=${compile.status ?? "null"} signal=${compile.signal ?? "none"} (${Date.now() - compileStart}ms)`);
  if (compile.stdout?.trim()) log(compile.stdout.trim());
  if (compile.stderr?.trim()) log(`[stderr]\n${compile.stderr.trim()}`);
  if (compile.error) fail(`compile:core failed to spawn: ${compile.error.message}`);
  if (compile.status !== 0) fail(`compile:core exited ${compile.status ?? `signal ${compile.signal}`} — see output above`);
  if (!existsSync(DIST_BINARY)) fail(`compile:core reported success but ${DIST_BINARY} was not produced`);
  const st = statSync(DIST_BINARY);
  log(`binary produced: ${DIST_BINARY} (${st.size} bytes, mtime ${st.mtime.toISOString()})`);

  // Weak-but-free hint that the route literal survived bundling. NOT the proof — the run below is.
  const grep = spawnSync("grep", ["-ac", "__runtime-state-probe", DIST_BINARY], { encoding: "utf8" });
  log(`(info) literal "__runtime-state-probe" occurrences in binary: ${grep.stdout?.trim() || "0"}`);

  // ---- Steps 2-3: a throwaway home, and a before-picture of the real ones ----------------------
  const tmpHome = mkdtempSync(join(tmpdir(), "norma-runtime-state-probe-"));
  log(`\n--- Step 2: temp NORMA_HOME = ${tmpHome} ---`);
  const before = REAL_HOMES.map(homeSignature);
  log(`--- Step 3: signature taken for ${REAL_HOMES.join(", ")} ---`);

  try {
    // ---- Step 4: run the compiled binary's probe route ----------------------------------------
    log(`\n--- Step 4: spawn ${DIST_BINARY} __runtime-state-probe ---`);
    const child = spawn(DIST_BINARY, ["__runtime-state-probe"], {
      stdio: ["ignore", "pipe", "pipe"],
      // A DELIBERATELY NARROW env: PATH and HOME only, plus the temp home. Inheriting process.env
      // would drag this shell's NORMA_HOME/NORMA_PROFILE in and could point a real daemon boot at a
      // real home — the one thing this script must never do.
      // `NORMA_PROFILE: "dev"` is a REAL profile (review F-10): `resolveNormaProfile` maps everything
      // but "dev" to "dist", so a made-up literal like "test" silently runs as the distribution
      // profile and reads as an isolation it does not provide. The isolation here comes from the
      // injected `FileSecretStore` and the temp `NORMA_HOME`, not from the profile — the profile
      // only picks a Keychain service name (never reached) and the CLI's launchd label (not on this
      // path).
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir(), NORMA_HOME: tmpHome, NORMA_PROFILE: "dev" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms waiting for the probe to exit`));
        }, PROBE_TIMEOUT_MS);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("close", (code) => { clearTimeout(timer); resolve(code); });
      });
    } catch (err) {
      if (stdout.trim()) log(`[stdout]\n${stdout.trim()}`);
      if (stderr.trim()) log(`[stderr]\n${stderr.trim()}`);
      fail((err as Error).message);
    }

    if (stderr.trim()) log(`[stderr from probe]\n${stderr.trim()}`);
    log(`[stdout from probe]\n${stdout.trim()}`);
    log(`probe exited: ${exitCode}`);

    // The daemon narrates its boot on stdout too ("norma-core <v> listening on ..."), so the
    // result is the LAST line that parses as JSON carrying an `ok` field — not simply the last line.
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

    // ---- Steps 5-6: the assertions -------------------------------------------------------------
    const after = REAL_HOMES.map(homeSignature);
    const untouched = REAL_HOMES.map((dir, i) => [dir, before[i] === after[i]] as const);
    for (const [dir, ok] of untouched) if (!ok) log(`\n[real home CHANGED] ${dir}\n--- before ---\n${before[REAL_HOMES.indexOf(dir)]}\n--- after ---\n${after[REAL_HOMES.indexOf(dir)]}`);

    const checks: Array<[string, boolean]> = [
      ["the compiled binary produced a JSON result line", true],
      ['result.ok === true', result.ok === true],
      ['result.online === true', result.online === true],
      [`result.userVersion === ${RUNTIME_STATE_SCHEMA_VERSION} (the 8a schema)`, result.userVersion === RUNTIME_STATE_SCHEMA_VERSION],
      ["result.dbPath is inside the temp home", typeof result.dbPath === "string" && result.dbPath.startsWith(`${tmpHome}/`)],
      ["result.home is the temp home", result.home === tmpHome],
      ["runtime-state.db exists on disk in the temp home", existsSync(join(tmpHome, "runtimes", "runtime-state.db"))],
      ["the probe used a FileSecretStore, never the Keychain (tokens landed under the temp home)", existsSync(join(tmpHome, "probe-secrets"))],
      ["probe exited 0", exitCode === 0],
      ...untouched.map(([dir, ok]) => [`${dir}: same files, same runtime-state.db user_version`, ok] as [string, boolean]),
    ];

    log("\n--- Assertions ---");
    for (const [name, ok] of checks) log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);

    if (!checks.every(([, ok]) => ok)) {
      fail(
        "one or more assertions failed — the compiled binary did NOT create/migrate runtime-state.db " +
        "as the daemon does. Diagnose before touching the assertions: (a) no JSON line at all + a " +
        "stderr about a missing module -> the probe route or `@norma/core`'s barrel did not survive " +
        "`bun build --compile` (this is what C1 looked like for workflows); (b) ok:false with a " +
        "`runtime state reported offline` error -> `openRuntimeStateDb` refused inside $bunfs, which " +
        "is the 8a carry itself failing; (c) userVersion 0 -> the migrations did not run; (d) a real " +
        "home changed -> the probe resolved a home instead of reading NORMA_HOME, which is the one " +
        "failure this script must never let through."
      );
    }

    log(
      "\nRESULT: PASS — dist/norma-core (the real `bun build --compile` Release artifact) booted the " +
      `daemon against a temp NORMA_HOME with an injected FileSecretStore, created and migrated ` +
      `runtimes/runtime-state.db to user_version ${RUNTIME_STATE_SCHEMA_VERSION}, reported the runtime spine online, and left ` +
      "the user's real homes untouched. The 8a carry is discharged on the shipped artifact."
    );
  } finally {
    // Runs on EVERY path now, failures included (review F-1): the temp home holds
    // `probe-secrets/{harness,admin,remote}-token`, and a failed proof must not leave them on disk.
    rmSync(tmpHome, { recursive: true, force: true });
    log(`\n(cleanup) removed ${tmpHome}`);
  }
}

// The ONLY place this script exits non-zero. `fail()` throws instead of exiting so that `main`'s
// `finally` gets to run first — a `process.exit` inside the try would skip it and leak the temp home.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof ProofFailure) console.error(`\nRESULT: FAIL — ${err.message}`);
    else console.error(err);
    process.exit(1);
  },
);
