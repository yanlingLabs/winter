/**
 * WS-27 — run the DEV daemon as a compiled `winter-core` signed by Winter's team.
 *
 * Why: Keychain items take their partition list from their CREATOR (`auth/app-token-acl.ts`'s header). A
 * dev daemon run as Homebrew `bun` creates its items as bun's team, so Winter Dev is asked once per pairing
 * token. A `winter-core` signed by Winter's team (`WINTER_TEAM_ID`) under the stable identifier
 * `com.winter.core.dev` creates them as Winter's team — Winter Dev (same team) reads them silently — and its
 * designated requirement (identifier + team certificate) survives every rebuild.
 *
 *   bun run dev:daemon                     build, sign, then `daemon run` on ~/.winter-dev (dev profile)
 *   bun run dev:daemon --no-build          reuse dist/dev/winter-core as it is
 *   bun run dev:daemon --transition        build, sign, then the ONE-TIME Keychain transition, then exit
 *   bun run dev:daemon <winter args>       run any other verb through the signed binary (e.g. `credentials list`)
 *
 * Build: `packages/cli`'s own `compile:core`, output redirected to a temp file (`dev-daemon-lib.ts`'s
 * `devCompileCommand`), then `codesign --identifier com.winter.core.dev --options runtime
 * --entitlements scripts/winter-core.entitlements` (the dist posture: the hardened runtime needs
 * allow-unsigned-executable-memory for bun:ffi), a check of the signature's team, the binary's own
 * `__keychain-ffi-probe`, and only then an atomic rename to `dist/dev/winter-core` — never over the running
 * dev daemon's file in place, and never at `dist/winter-core`, which the `verify:*` gates rebuild.
 *
 * Identity: `security find-identity -v -p codesigning`, the one whose certificate's OU is Winter's team
 * (Apple Development preferred over Developer ID Application), by hash. `WINTER_DEV_SIGN_IDENTITY` overrides.
 *
 * Environment handed to the binary: `WINTER_PROFILE=dev`, `WINTER_HOME` (default `~/.winter-dev`; the dist
 * home is refused), and — because a compiled binary can neither `require` its way to the npm platform
 * package nor search `$PATH` for `ant` — `WINTER_RUNTIME_EXECUTABLE` and `WINTER_ANT_EXECUTABLE` resolved
 * here under bun, unless already set.
 *
 * THE TRANSITION (`--transition`, once, with the dev daemon stopped): the existing dev items were created by
 * `bun`, and the compiled binary's first read of each would prompt. This script — running under `bun`, their
 * creator — reads each value and hands it over a pipe to `dist/dev/winter-core __dev-keychain-adopt`, which
 * re-creates the item as itself (shadow, delete, add, read back; `auth/dev-keychain-transition.ts`). It is
 * crash-safe and idempotent: if interrupted, run it again; until it has run, this script refuses to start the
 * signed binary on the default dev home. It is ONE-WAY: afterwards a `bun`-run dev CLI or
 * daemon is prompted for every item, so dev-profile commands go through the signed binary from then on.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { DEV_KEYCHAIN_SERVICE, oldCreatorStillOwnsItems, transitionDevKeychain } from "../packages/core/src/auth/dev-keychain-transition";
import { keychainUnlocked } from "../packages/core/src/auth/keychain-ffi";
import { isDefaultWinterHome } from "../packages/core/src/winter-dir";
import { resolvePlatformPackageWinter } from "../packages/core/src/runtime-sdk/executable";
import { DEV_DAEMON_IDENTIFIER, devCompileCommand, devDaemonHome, resolveDevSigningIdentity, signedFacts } from "./dev-daemon-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
const DEV_BINARY = join(REPO_ROOT, "dist", "dev", "winter-core");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "winter-core.entitlements");

function die(message: string): never {
  console.error(`dev:daemon: ${message}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function build(): void {
  if (process.platform !== "darwin") die("the signed dev daemon is macOS-only");
  const identity = resolveDevSigningIdentity({
    identitiesOutput: run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout,
    teamId: WINTER_TEAM_ID,
    override: process.env.WINTER_DEV_SIGN_IDENTITY,
    subjectOf: (name) => {
      const pem = run("security", ["find-certificate", "-c", name, "-p"]).stdout;
      if (pem === "") return undefined;
      const r = spawnSync("openssl", ["x509", "-noout", "-subject"], { input: pem, encoding: "utf8" });
      return r.status === 0 ? r.stdout : undefined;
    },
  });
  console.error(`dev:daemon: signing identity ${identity.name}`);
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };
  mkdirSync(dirname(DEV_BINARY), { recursive: true });
  const tmp = `${DEV_BINARY}.${process.pid}.tmp`;
  try {
    console.error("dev:daemon: compiling (compile:core → dist/dev/winter-core)…");
    const compiled = spawnSync("/bin/sh", ["-c", devCompileCommand(pkg.scripts["compile:core"] ?? "", tmp)], { cwd: CLI_DIR, stdio: ["ignore", "inherit", "inherit"] });
    if (compiled.status !== 0 || !existsSync(tmp)) die(`compile failed (exit ${compiled.status})`);
    const signed = run("codesign", ["--force", "--sign", identity.hash, "--identifier", DEV_DAEMON_IDENTIFIER, "--options", "runtime", "--timestamp=none", "--entitlements", ENTITLEMENTS, tmp]);
    if (signed.status !== 0) die(`codesign failed: ${signed.stderr.trim()}`);
    const facts = signedFacts(run("codesign", ["-dv", tmp]).stderr);
    if (facts.teamId !== WINTER_TEAM_ID || facts.identifier !== DEV_DAEMON_IDENTIFIER || !facts.runtime) {
      die(`the signature is not what the Keychain needs (team ${facts.teamId ?? "none"}, identifier ${facts.identifier ?? "none"}, hardened runtime ${facts.runtime}) — expected team ${WINTER_TEAM_ID}, ${DEV_DAEMON_IDENTIFIER}`);
    }
    // The 0.120.0 regression class: bun:ffi under the hardened runtime. Loads the libraries, reads no item.
    const probe = run(tmp, ["__keychain-ffi-probe"]);
    if (probe.status !== 0) die(`the signed binary cannot run bun:ffi (__keychain-ffi-probe exit ${probe.status}): ${probe.stderr.trim().slice(0, 300)}`);
    renameSync(tmp, DEV_BINARY);
    console.error(`dev:daemon: ${DEV_BINARY} (team ${facts.teamId}, ${facts.identifier}) — ${probe.stdout.trim()}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function devEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WINTER_HOME: home, WINTER_PROFILE: "dev" };
  // A test preload's override has no business here (and a default home ignores it anyway).
  delete env.WINTER_KEYCHAIN_SERVICE;
  if (!env.WINTER_RUNTIME_EXECUTABLE) {
    const winter = resolvePlatformPackageWinter();
    if (winter !== undefined) env.WINTER_RUNTIME_EXECUTABLE = winter;
    else console.error("dev:daemon: no `winter` runtime found (npm platform package) — code sessions will refuse until WINTER_RUNTIME_EXECUTABLE is set");
  }
  if (!env.WINTER_ANT_EXECUTABLE) {
    const ant = Bun.which("ant");
    if (ant !== null) env.WINTER_ANT_EXECUTABLE = ant;
  }
  return env;
}

async function main(): Promise<void> {
  // Leading `--no-build`/`--transition` are this script's; everything from the first other argument (or after
  // a `--`) goes to the binary (`bun run` itself swallows the first `--`).
  const argv = process.argv.slice(2);
  const flags: string[] = [];
  let i = 0;
  for (; i < argv.length && (argv[i] === "--no-build" || argv[i] === "--transition"); i++) flags.push(argv[i]!);
  if (argv[i] === "--") i++;
  const passthrough = argv.slice(i);
  if (flags.includes("--transition") && passthrough.length > 0) die("--transition takes no other arguments");
  let home: string;
  try {
    home = devDaemonHome(process.env);
  } catch (err) {
    die((err as Error).message);
  }
  if (!flags.includes("--no-build")) build();
  if (!existsSync(DEV_BINARY)) die(`${DEV_BINARY} does not exist — run without --no-build`);
  const env = devEnv(home);

  if (flags.includes("--transition")) {
    console.error(`dev:daemon: moving the dev Keychain items (${home}) from bun to ${DEV_BINARY} — the dev daemon must be stopped`);
    let outcome;
    try {
      outcome = await transitionDevKeychain({ binary: DEV_BINARY, home, env, log: (line) => console.error(`  ${line}`) });
    } catch (err) {
      die(`transition refused: ${(err as Error).message}`);
    }
    if (outcome.kind === "stopped") die(`transition stopped at ${outcome.account} (${outcome.reason}); ${outcome.adopted.length} adopted so far — run it again`);
    console.error(`dev:daemon: transition done — ${outcome.adopted.length} adopted, ${outcome.skipped.length} left as they were${outcome.skipped.length > 0 ? ` (${outcome.skipped.join(", ")})` : ""}${outcome.restored.length > 0 ? `, ${outcome.restored.length} restored from an earlier run` : ""}`);
    process.exit(0);
  }

  // Before the transition, every item on the dev home is bun's, and the signed binary's first read of each
  // would prompt: refuse and say what to run. (Only the default dev home holds the dev service's items.)
  if (isDefaultWinterHome(home, "dev") && keychainUnlocked(null) && oldCreatorStillOwnsItems({ keychain: null, service: DEV_KEYCHAIN_SERVICE })) {
    die("the dev Keychain items still belong to bun — stop any bun-run dev daemon, then run `bun run dev:daemon --transition` once");
  }

  const args = passthrough.length > 0 ? passthrough : ["daemon", "run"];
  const child = spawn(DEV_BINARY, args, { stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on("close", (code, signal) => process.exit(code ?? (signal !== null ? 1 : 0)));
}

await main();
