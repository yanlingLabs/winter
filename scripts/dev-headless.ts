/**
 * ComputerV2 Phase 4 — build and sign the DEV Winter Headless ("Winter Headless Dev", com.winter.headless.dev) into
 * `dist/dev/`, where a dev daemon finds it (`browser/headless/engines.ts`'s ladder).
 *
 *   bun run dev:headless               build and sign into dist/dev/Winter Headless Dev.app
 *   bun run dev:headless --out <dir>   build and sign into <dir> instead (dist/dev is never touched — a proof build)
 *
 * Self-contained: the dev helper carries its own copy of the CEF framework and the five "Winter Helper" bundles in its
 * Contents/Frameworks (the build's `WINTER_HEADLESS_SELF_CONTAINED=YES`; an APFS clone where the volume allows it), so
 * it runs with no Winter.app around it. The build signs the nested code with the team identity (the hardened runtime's
 * library validation needs the framework from the same team); this script then re-signs the OUTER bundle with a STATED
 * designated requirement — `identifier "com.winter.headless.dev" and anchor apple generic and certificate
 * leaf[subject.OU] = "<team>"` — the hardened runtime and no entitlements, which is exactly what the daemon checks the
 * spawned process against. Never `--deep`. The signing identity is the dev daemon's (`dev-daemon-lib.ts`'s
 * `resolveDevSigningIdentity`, `WINTER_DEV_SIGN_IDENTITY` overrides).
 *
 * Nothing is registered with LaunchServices (Xcode's own registration of the build product is undone): the daemon
 * spawns the helper by path, never through LaunchServices. Refuses while a dev headless helper is running (it names
 * the pid): the daemon's pool would keep the old build until its idle exit.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { LSREGISTER, pidsRunning } from "./computer-helper-lib";
import { resolveDevSigningIdentity } from "./dev-daemon-lib";
import {
  builtHeadlessPath, checkSignedHeadless, HEADLESS, headlessBuildArgs, headlessExecutable, headlessRequirement, headlessSignArgs,
} from "./headless-helper-lib";
import { readCanonical } from "./version-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPLE_DIR = join(REPO_ROOT, "apple", "Winter");
const OUT_DIR = join(REPO_ROOT, "out", "headless-helper");
export const DEV_HEADLESS_APP = join(REPO_ROOT, "dist", "dev", `${HEADLESS.dev.name}.app`);

function die(message: string): never {
  console.error(`dev:headless: ${message}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The team identity, by hash (the dev daemon's rule). */
export function signingIdentity(): { hash: string; name: string } {
  return resolveDevSigningIdentity({
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
}

/** Builds the dev helper; its unsigned-for-us bundle's path (Xcode's LaunchServices registration undone). The log goes
 *  to `out/headless-helper/build.log` (its tail is printed on failure). */
export function buildHeadless(log: (line: string) => void): string {
  const generated = run("xcodegen", ["generate"], { cwd: APPLE_DIR });
  if (generated.status !== 0) throw new Error(`xcodegen generate failed: ${generated.stderr.trim() || generated.stdout.trim()}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const derivedDataPath = join(OUT_DIR, "dd");
  const logPath = join(OUT_DIR, "build.log");
  log(`building the dev headless helper (xcodebuild, log: ${logPath})…`);
  const built = spawnSync("/bin/sh", ["-c", `xcodebuild ${headlessBuildArgs({ derivedDataPath }).map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")} > '${logPath}' 2>&1`], { cwd: APPLE_DIR });
  const product = builtHeadlessPath(derivedDataPath);
  if (built.status !== 0 || !existsSync(product)) {
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => /error|BUILD/.test(l)).slice(-15).join("\n") : "";
    throw new Error(`xcodebuild failed (exit ${built.status}):\n${tail}`);
  }
  run(LSREGISTER, ["-u", product]);
  return product;
}

/** Signs the outer bundle and checks it; the failures (empty = good). */
export function signHeadless(appPath: string, identityHash: string): string[] {
  const signed = run("codesign", headlessSignArgs({ identityHash, flavor: "dev", teamId: WINTER_TEAM_ID, appPath }));
  if (signed.status !== 0) return [`codesign failed: ${signed.stderr.trim()}`];
  return inspectHeadless(appPath, "dev");
}

/** The signature, requirement, entitlements and Info.plist checks on a signed bundle, and a strict verify — nested code
 *  included — against the stated requirement. */
export function inspectHeadless(appPath: string, flavor: "dist" | "dev"): string[] {
  if (!existsSync(headlessExecutable(appPath, flavor))) return [`no executable at ${headlessExecutable(appPath, flavor)}`];
  const dr = run("codesign", ["-d", "-r-", appPath]);
  const plist = run("plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")]);
  const failures = checkSignedHeadless(flavor, WINTER_TEAM_ID, readCanonical(), {
    codesignDvv: run("codesign", ["-dvv", appPath]).stderr,
    codesignDr: `${dr.stdout}\n${dr.stderr}`,
    entitlementsXml: run("codesign", ["-d", "--entitlements", "-", "--xml", appPath]).stdout,
    infoPlist: plist.status === 0 ? (JSON.parse(plist.stdout) as Record<string, unknown>) : {},
    hasFrameworks: existsSync(join(appPath, "Contents", "Frameworks")),
  });
  const strict = run("codesign", ["--verify", "--deep", "--strict", `-R=${headlessRequirement(HEADLESS[flavor].identifier, WINTER_TEAM_ID)}`, appPath]);
  if (strict.status !== 0) failures.push(`codesign --verify --deep --strict against the stated requirement failed: ${strict.stderr.trim()}`);
  return failures;
}

function main(): void {
  if (process.platform !== "darwin") die("Winter Headless is macOS-only");
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const outDir = outIndex < 0 ? undefined : argv[outIndex + 1];
  if (outIndex >= 0 && (outDir === undefined || outDir.startsWith("--"))) die("--out needs a directory");
  const unknown = argv.filter((a, i) => !(a === "--out" || (outIndex >= 0 && i === outIndex + 1)));
  if (unknown.length > 0) die(`unknown argument ${unknown[0]} (only --out <dir>)`);
  const target = outDir === undefined ? DEV_HEADLESS_APP : join(resolve(outDir), `${HEADLESS.dev.name}.app`);

  const running = pidsRunning(run("ps", ["-axo", "pid=,command="]).stdout, headlessExecutable(target, "dev"));
  if (running.length > 0) die(`the dev headless helper is running (pid ${running.join(", ")}) — stop the dev daemon's headless browser first (it exits after 5 idle minutes, or kill ${running.join(" ")})`);

  const identity = signingIdentity();
  console.error(`dev:headless: signing identity ${identity.name}`);
  let product: string;
  try {
    product = buildHeadless((line) => console.error(`dev:headless: ${line}`));
  } catch (err) {
    die((err as Error).message);
  }

  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${HEADLESS.dev.name}.${process.pid}.tmp.app`);
  const old = join(dirname(target), `.${HEADLESS.dev.name}.${process.pid}.old.app`);
  let failure: string | undefined;
  try {
    rmSync(tmp, { recursive: true, force: true });
    if (run("ditto", [product, tmp]).status !== 0) throw new Error(`could not copy ${product}`);
    const failures = signHeadless(tmp, identity.hash);
    if (failures.length > 0) throw new Error(`the signed helper is not what the daemon needs:\n  ${failures.join("\n  ")}`);
    if (existsSync(target)) renameSync(target, old);
    renameSync(tmp, target);
    rmSync(old, { recursive: true, force: true });
  } catch (err) {
    failure = (err as Error).message;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failure !== undefined) die(failure);
  console.error(`dev:headless: ${target} — ${HEADLESS.dev.identifier}, team ${WINTER_TEAM_ID}, designated => ${headlessRequirement(HEADLESS.dev.identifier, WINTER_TEAM_ID)}, hardened runtime, no entitlements, self-contained`);
}

if (import.meta.main) main();
