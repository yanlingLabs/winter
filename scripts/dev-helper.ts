/**
 * ComputerV2 — build and sign the DEV Winter Computer Use helper ("Winter Computer Use Dev",
 * com.winter.computeruse.dev) into `dist/dev/`, and register it with LaunchServices.
 *
 *   bun run dev:helper                  build, sign, register, and write the dev Winter for Chrome host manifests
 *   bun run dev:helper --no-register    build and sign only (nothing touches LaunchServices)
 *   bun run dev:helper --no-manifests   leave the browsers' NativeMessagingHosts alone
 *   bun run dev:helper --out <dir>      build and sign into <dir> instead of dist/dev (implies --no-register and
 *                                       --no-manifests; the dev helper in dist/dev is never touched — a proof build)
 *   bun run dev:helper --manifests-root <dir>   write the manifests under <dir> instead of ~/Library/Application Support
 *
 * Why it is signed here, the `scripts/dev-daemon.ts` way: the helper holds its OWN Accessibility and Screen
 * Recording grants, and TCC keys a grant on the app's designated requirement. Xcode's derived requirement
 * names the signing certificate's common name, so a rebuild by another person (or after a certificate
 * renewal) would be a new app to TCC and lose its grants. This script states the requirement instead —
 * `identifier "com.winter.computeruse.dev" and anchor apple generic and certificate leaf[subject.OU] =
 * "<team>"` — which every Winter-team certificate satisfies, so a rebuild keeps them.
 *
 * Steps: `xcodegen generate`; xcodebuild of the WinterComputerUse scheme (Debug = the dev identity),
 * unsigned, into `out/computer-helper/dd`; the built bundle is unregistered from LaunchServices (Xcode
 * registers every app it builds — a second registered copy of com.winter.computeruse.dev would compete with
 * the real one) and copied to a temp name in `dist/dev/`; `codesign --identifier com.winter.computeruse.dev
 * --options runtime -r=<the stated requirement>` with the team identity (`dev-daemon-lib.ts`'s
 * `resolveDevSigningIdentity`, `WINTER_DEV_SIGN_IDENTITY` overrides); the checks (`checkSignedHelper`: the
 * recorded requirement is the stated one, team, identifier, hardened runtime, the Apple Events entitlement only, LSUIElement,
 * version, no test hooks) and `codesign --verify --deep --strict -R=<requirement>`; then the swap into
 * `dist/dev/Winter Computer Use Dev.app` and `lsregister -f`.
 *
 * Refuses while a dev helper is running (it names the pid): the running copy would keep serving the old
 * build until its idle quit. The daemon launches it through LaunchServices, never as a child.
 *
 * Winter for Chrome: the bundle carries `Contents/MacOS/winter-browser-host`, signed FIRST with its own identity
 * (`com.winter.browserhost.dev`, the hardened runtime, no entitlements, its stated requirement), then the helper around
 * it. Once the dev helper is in place, `com.winter.browser.dev.json` — the native-messaging manifest pointing Chrome at
 * that host for the dev extension id — is written into each Chromium browser's `NativeMessagingHosts/` whose support
 * directory exists (atomically, only when it differs, never deleting anything).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { allowedOrigins, EXTENSION_IDS, NATIVE_HOST_NAME } from "../packages/core/src/computer-use/browser/extension/extension-ids";
import { hostManifest, writeHostManifests } from "../packages/core/src/computer-use/browser/extension/manifest";
import {
  BROWSER_HOST, browserHostExecutable, browserHostSignArgs, checkSignedBrowserHost, checkSignedHelper, HELPER, helperBuildArgs, helperExecutable,
  helperRequirement, helperSignArgs, builtHelperPath, LSREGISTER, pidsRunning, readHelperVersion, syncHelperVersion, type HelperFlavor,
} from "./computer-helper-lib";
import { resolveDevSigningIdentity } from "./dev-daemon-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPLE_DIR = join(REPO_ROOT, "apple", "Winter");
const OUT_DIR = join(REPO_ROOT, "out", "computer-helper");
export const DEV_HELPER_APP = join(REPO_ROOT, "dist", "dev", `${HELPER.dev.name}.app`);

function die(message: string): never {
  console.error(`dev:helper: ${message}`);
  process.exit(1);
}

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
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

/**
 * Builds a flavor and returns the unsigned bundle's path, already unregistered from LaunchServices. The
 * xcodebuild log goes to `out/computer-helper/<flavor>-build.log` (its tail is printed on failure).
 */
export function buildHelper(flavor: "dev" | "test", log: (line: string) => void): string {
  // The helper's own version (apple/ComputerUse/VERSION) into project.yml and its Info.plist first.
  for (const file of syncHelperVersion()) log(`stamped Winter Computer Use ${readHelperVersion()} into ${file}`);
  const generated = run("xcodegen", ["generate"], { cwd: APPLE_DIR });
  if (generated.status !== 0) throw new Error(`xcodegen generate failed: ${generated.stderr.trim() || generated.stdout.trim()}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const derivedDataPath = join(OUT_DIR, flavor === "dev" ? "dd" : "dd-test");
  const logPath = join(OUT_DIR, `${flavor}-build.log`);
  log(`building the ${flavor} helper (xcodebuild, log: ${logPath})…`);
  const built = spawnSync("/bin/sh", ["-c", `xcodebuild ${helperBuildArgs({ flavor, derivedDataPath }).map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")} > '${logPath}' 2>&1`], { cwd: APPLE_DIR });
  const product = builtHelperPath(derivedDataPath, flavor);
  if (built.status !== 0 || !existsSync(product)) {
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => /error|BUILD/.test(l)).slice(-15).join("\n") : "";
    throw new Error(`xcodebuild failed (exit ${built.status}):\n${tail}`);
  }
  // Xcode registered the product with LaunchServices as it built it; this copy is never the one to launch.
  run(LSREGISTER, ["-u", product]);
  return product;
}

/** Signs `appPath` as `flavor` — the nested winter-browser-host first, with its own identity, then the helper around it
 *  (never `--deep`) — and returns the check failures (empty = good). */
export function signHelper(appPath: string, flavor: HelperFlavor, identityHash: string): string[] {
  const host = browserHostExecutable(appPath);
  if (!existsSync(host)) return [`no winter-browser-host at ${host} — the WinterBrowserHost target did not build into the helper`];
  const hostSigned = run("codesign", browserHostSignArgs({ identityHash, flavor, teamId: WINTER_TEAM_ID, path: host }));
  if (hostSigned.status !== 0) return [`codesign of winter-browser-host failed: ${hostSigned.stderr.trim()}`];
  const signed = run("codesign", helperSignArgs({ identityHash, flavor, teamId: WINTER_TEAM_ID, appPath }));
  if (signed.status !== 0) return [`codesign failed: ${signed.stderr.trim()}`];
  return inspectHelper(appPath, flavor);
}

/** The signature, requirement, entitlements and Info.plist checks on an already-signed bundle. */
export function inspectHelper(appPath: string, flavor: HelperFlavor): string[] {
  const exe = helperExecutable(appPath, flavor);
  if (!existsSync(exe)) return [`no executable at ${exe}`];
  const dr = run("codesign", ["-d", "-r-", appPath]);
  const plist = run("plutil", ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")]);
  const failures = checkSignedHelper(flavor, WINTER_TEAM_ID, readHelperVersion(), {
    codesignDvv: run("codesign", ["-dvv", appPath]).stderr,
    codesignDr: `${dr.stdout}\n${dr.stderr}`,
    entitlementsXml: run("codesign", ["-d", "--entitlements", "-", "--xml", appPath]).stdout,
    infoPlist: plist.status === 0 ? (JSON.parse(plist.stdout) as Record<string, unknown>) : {},
    executable: readFileSync(exe),
  });
  const strict = run("codesign", ["--verify", "--deep", "--strict", `-R=${helperRequirement(HELPER[flavor].identifier, WINTER_TEAM_ID)}`, appPath]);
  if (strict.status !== 0) failures.push(`codesign --verify --deep --strict against the stated requirement failed: ${strict.stderr.trim()}`);
  failures.push(...inspectBrowserHost(appPath, flavor));
  return failures;
}

/** The nested winter-browser-host's signature checks (its own identifier, team, runtime, stated requirement, no
 *  entitlements, test hooks only in the test flavor) plus a strict verify against its stated requirement. */
export function inspectBrowserHost(appPath: string, flavor: HelperFlavor): string[] {
  const host = browserHostExecutable(appPath);
  if (!existsSync(host)) return [`no winter-browser-host at ${host}`];
  const dr = run("codesign", ["-d", "-r-", host]);
  const failures = checkSignedBrowserHost(flavor, WINTER_TEAM_ID, {
    codesignDvv: run("codesign", ["-dvv", host]).stderr,
    codesignDr: `${dr.stdout}\n${dr.stderr}`,
    entitlementsXml: run("codesign", ["-d", "--entitlements", "-", "--xml", host]).stdout,
    executable: readFileSync(host),
  });
  const strict = run("codesign", ["--verify", "--strict", `-R=${helperRequirement(BROWSER_HOST[flavor].identifier, WINTER_TEAM_ID)}`, host]);
  if (strict.status !== 0) failures.push(`winter-browser-host does not satisfy its stated requirement: ${strict.stderr.trim()}`);
  return failures;
}

/** Writes `com.winter.browser.dev.json`, pointing at the dev helper's host, into every Chromium browser's
 *  NativeMessagingHosts under `supportRoot` whose support directory exists. Returns one line per browser written. */
export function writeDevHostManifests(appPath: string, supportRoot: string): string[] {
  const manifest = hostManifest({ name: NATIVE_HOST_NAME.dev, path: browserHostExecutable(appPath), allowedOrigins: allowedOrigins(EXTENSION_IDS.dev) });
  return writeHostManifests(supportRoot, manifest).filter((o) => o.outcome !== "skipped").map((o) => `${o.dir}: ${o.outcome}`);
}

function main(): void {
  if (process.platform !== "darwin") die("the helper is macOS-only");
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`${flag} needs a directory`);
    return v;
  };
  const outDir = valueOf("--out");
  const manifestsRoot = valueOf("--manifests-root");
  const known = new Set(["--no-register", "--no-manifests", "--out", "--manifests-root", outDir, manifestsRoot]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) die(`unknown argument ${unknown[0]} (only --no-register, --no-manifests, --out <dir>, --manifests-root <dir>)`);
  // A proof build elsewhere never registers anything and never points a browser at itself.
  const target = outDir === undefined ? DEV_HELPER_APP : join(resolve(outDir), `${HELPER.dev.name}.app`);
  const register = outDir === undefined && !argv.includes("--no-register");
  const manifests = (outDir === undefined || manifestsRoot !== undefined) && !argv.includes("--no-manifests");

  const running = pidsRunning(run("ps", ["-axo", "pid=,command="]).stdout, helperExecutable(target, "dev"));
  if (running.length > 0) die(`the dev helper is running (pid ${running.join(", ")}) — quit it first (kill ${running.join(" ")}); it relaunches on the next ComputerV2 call`);

  const identity = signingIdentity();
  console.error(`dev:helper: signing identity ${identity.name}`);
  let product: string;
  try {
    product = buildHelper("dev", (line) => console.error(`dev:helper: ${line}`));
  } catch (err) {
    die((err as Error).message);
  }

  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${HELPER.dev.name}.${process.pid}.tmp.app`);
  const old = join(dirname(target), `.${HELPER.dev.name}.${process.pid}.old.app`);
  let failure: string | undefined;
  try {
    rmSync(tmp, { recursive: true, force: true });
    if (run("ditto", [product, tmp]).status !== 0) throw new Error(`could not copy ${product}`);
    rmSync(product, { recursive: true, force: true });
    const failures = signHelper(tmp, "dev", identity.hash);
    if (failures.length > 0) throw new Error(`the signed helper is not what TCC and the daemon need:\n  ${failures.join("\n  ")}`);
    // Swap in: the old bundle aside, the new one in, the old one gone — never a moment with a half-copied
    // bundle at the registered path.
    if (existsSync(target)) {
      if (register) run(LSREGISTER, ["-u", target]);
      renameSync(target, old);
    }
    renameSync(tmp, target);
    rmSync(old, { recursive: true, force: true });
  } catch (err) {
    failure = (err as Error).message;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failure !== undefined) die(failure);

  if (register) {
    const registered = run(LSREGISTER, ["-f", target]);
    if (registered.status !== 0) die(`lsregister -f failed: ${registered.stderr.trim()}`);
  }
  console.error(
    `dev:helper: ${target} — ${HELPER.dev.identifier}, team ${WINTER_TEAM_ID}, designated => ${helperRequirement(HELPER.dev.identifier, WINTER_TEAM_ID)}` +
      (register ? "; registered with LaunchServices" : "; NOT registered") +
      `; winter-browser-host => ${helperRequirement(BROWSER_HOST.dev.identifier, WINTER_TEAM_ID)}`,
  );
  if (manifests) {
    const root = manifestsRoot === undefined ? join(homedir(), "Library", "Application Support") : resolve(manifestsRoot);
    const written = writeDevHostManifests(target, root);
    console.error(`dev:helper: Winter for Chrome host manifest ${NATIVE_HOST_NAME.dev}.json under ${root}: ${written.length === 0 ? "no Chromium browser found" : written.join(", ")}`);
  } else {
    console.error("dev:helper: Winter for Chrome host manifests NOT written");
  }
}

if (import.meta.main) main();
