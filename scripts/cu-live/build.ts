// Builds everything the live ComputerV2 suite runs, into `out/cu-live/` (git-ignored), and skips what is current:
//   - "Winter CU Fixture.app" (com.winter.cu-fixture) and "Winter CU User App.app" (com.winter.cu-fixture-user): ONE
//     Swift binary in two bundles, ad-hoc signed (nothing here needs an identity: the helper reads them through ITS
//     Accessibility grant);
//   - `cu-live-tool` (the focus/Space/HID monitor and the fixtures' command poster — needs no TCC grant at all);
//   - `cu-live-viewprobe`, signed `com.winter.app.dev` with Winter's team identity: the helper streams mirror frames
//     only to a peer satisfying Winter Dev's designated requirement (it is how the suite watches `view.*`);
//   - `winter-core-live` (`daemon-entry.ts` compiled), signed `com.winter.core.dev` like `bun run dev:daemon`: the
//     helper accepts only that daemon. A file secret store inside — it never touches the Keychain.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINTER_TEAM_ID } from "../../packages/core/src/auth/app-token-acl";
import { designatedRequirementOf, DEV_DAEMON_IDENTIFIER, devDaemonRequirement, resolveDevSigningIdentity, signedFacts, type SigningIdentity } from "../dev-daemon-lib";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = join(REPO_ROOT, "out", "cu-live");
const SWIFT_DIR = join(REPO_ROOT, "scripts", "cu-live", "swift");
const WEB_DIR = join(REPO_ROOT, "scripts", "cu-live", "fixture-web");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "winter-core.entitlements");

export const FIXTURE_MAIN = { name: "Winter CU Fixture", bundleId: "com.winter.cu-fixture" } as const;
export const FIXTURE_USER = { name: "Winter CU User App", bundleId: "com.winter.cu-fixture-user" } as const;
export const VIEW_PROBE_IDENTIFIER = "com.winter.app.dev";

export interface Built {
  fixtureMain: string;
  fixtureUser: string;
  tool: string;
  viewProbe: string;
  daemon: string;
}

export function appPath(app: { name: string }): string {
  return join(OUT_DIR, `${app.name}.app`);
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function must(r: { status: number | null; stderr: string; stdout: string }, what: string): void {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
}

/** The newest mtime under `paths` (files or directories, recursively). */
function newest(paths: string[]): number {
  let max = 0;
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const e of readdirSync(p)) walk(join(p, e)); return; }
    max = Math.max(max, st.mtimeMs);
  };
  for (const p of paths) walk(p);
  return max;
}

const current = (output: string, inputs: string[]): boolean => existsSync(output) && statSync(output).mtimeMs >= newest(inputs);

/** Winter's team identity (`bun run dev:daemon`'s rule; `WINTER_DEV_SIGN_IDENTITY` overrides). */
export function signingIdentity(): SigningIdentity {
  return resolveDevSigningIdentity({
    identitiesOutput: run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout,
    teamId: WINTER_TEAM_ID,
    override: process.env.WINTER_DEV_SIGN_IDENTITY,
    subjectOf: (name) => {
      const pem = run("security", ["find-certificate", "-c", name, "-p"]).stdout;
      if (pem === "") return undefined;
      const r = run("openssl", ["x509", "-noout", "-subject"], { input: pem });
      return r.status === 0 ? r.stdout : undefined;
    },
  });
}

function swiftc(sources: string, output: string, frameworks: string[]): void {
  const files = readdirSync(sources).filter((f) => f.endsWith(".swift")).map((f) => join(sources, f));
  if (files.length === 0) throw new Error(`no Swift sources in ${sources}`);
  mkdirSync(dirname(output), { recursive: true });
  const tmp = `${output}.${process.pid}.tmp`;
  must(run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", tmp, ...files, ...frameworks.flatMap((f) => ["-framework", f])]), `swiftc ${sources}`);
  renameSync(tmp, output);
}

/** One fixture bundle around the shared binary: its own Info.plist (bundle id + name), the web page, ad-hoc signed. */
function wrapFixture(binary: string, app: { name: string; bundleId: string }): string {
  const bundle = appPath(app);
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  copyFileSync(binary, join(bundle, "Contents", "MacOS", "WinterCUFixture"));
  const plist = join(bundle, "Contents", "Info.plist");
  copyFileSync(join(SWIFT_DIR, "Fixture", "Info.plist"), plist);
  must(run("plutil", ["-replace", "CFBundleIdentifier", "-string", app.bundleId, plist]), "plutil CFBundleIdentifier");
  must(run("plutil", ["-replace", "CFBundleName", "-string", app.name, plist]), "plutil CFBundleName");
  must(run("plutil", ["-replace", "CFBundleExecutable", "-string", "WinterCUFixture", plist]), "plutil CFBundleExecutable");
  if (app.bundleId !== FIXTURE_MAIN.bundleId) {
    // Only the target fixture opens `.wcufix` documents: two bundles claiming one type would let LaunchServices pick either.
    for (const key of ["CFBundleDocumentTypes", "UTExportedTypeDeclarations"]) run("plutil", ["-remove", key, plist]);
  }
  for (const f of readdirSync(WEB_DIR)) copyFileSync(join(WEB_DIR, f), join(bundle, "Contents", "Resources", f));
  must(run("codesign", ["--force", "--sign", "-", "--timestamp=none", bundle]), `codesign ${app.name}`);
  return bundle;
}

export function buildFixtures(log: (l: string) => void): { main: string; user: string } {
  const binary = join(OUT_DIR, "WinterCUFixture.bin");
  const inputs = [join(SWIFT_DIR, "Fixture"), WEB_DIR];
  if (!current(binary, inputs)) {
    log("building the fixture app (swiftc)…");
    swiftc(join(SWIFT_DIR, "Fixture"), binary, ["AppKit", "WebKit"]);
  }
  const main = appPath(FIXTURE_MAIN);
  const user = appPath(FIXTURE_USER);
  if (!current(join(main, "Contents", "MacOS", "WinterCUFixture"), [binary]) || !current(join(user, "Contents", "MacOS", "WinterCUFixture"), [binary])) {
    wrapFixture(binary, FIXTURE_MAIN);
    wrapFixture(binary, FIXTURE_USER);
  }
  return { main, user };
}

export function buildTool(log: (l: string) => void): string {
  const out = join(OUT_DIR, "cu-live-tool");
  if (!current(out, [join(SWIFT_DIR, "Tool")])) {
    log("building cu-live-tool (swiftc)…");
    swiftc(join(SWIFT_DIR, "Tool"), out, ["AppKit", "IOKit"]);
    must(run("codesign", ["--force", "--sign", "-", "--timestamp=none", out]), "codesign cu-live-tool");
  }
  return out;
}

/** Winter Dev's stated requirement — what the helper demands of an app client. */
export function appClientRequirement(teamId = WINTER_TEAM_ID): string {
  return `identifier "${VIEW_PROBE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

export function buildViewProbe(identity: SigningIdentity, log: (l: string) => void): string {
  const out = join(OUT_DIR, "cu-live-viewprobe");
  if (current(out, [join(SWIFT_DIR, "ViewProbe")])) return out;
  log("building cu-live-viewprobe (swiftc, signed as an app client)…");
  swiftc(join(SWIFT_DIR, "ViewProbe"), out, ["AppKit", "ImageIO", "CoreGraphics"]);
  const requirement = appClientRequirement();
  must(run("codesign", ["--force", "--sign", identity.hash, "--identifier", VIEW_PROBE_IDENTIFIER, "--options", "runtime", "--timestamp=none", `-r=designated => ${requirement}`, out]), "codesign cu-live-viewprobe");
  must(run("codesign", ["--verify", "--strict", `-R=${requirement}`, out]), "the view probe's signature check");
  return out;
}

export function buildDaemon(identity: SigningIdentity, log: (l: string) => void): string {
  const out = join(OUT_DIR, "winter-core-live");
  const inputs = [join(REPO_ROOT, "scripts", "cu-live", "daemon-entry.ts"), join(REPO_ROOT, "packages", "core", "src"), join(REPO_ROOT, "packages", "protocol", "src")];
  if (current(out, inputs)) return out;
  log("compiling winter-core-live (bun build --compile)…");
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    must(run("bun", ["build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", join("scripts", "cu-live", "daemon-entry.ts"), "--outfile", tmp], { cwd: REPO_ROOT }), "bun build --compile");
    const requirement = devDaemonRequirement(WINTER_TEAM_ID);
    must(run("codesign", ["--force", "--sign", identity.hash, "--identifier", DEV_DAEMON_IDENTIFIER, "--options", "runtime", "--timestamp=none", "--entitlements", ENTITLEMENTS, `-r=designated => ${requirement}`, tmp]), "codesign winter-core-live");
    const shown = run("codesign", ["-d", "-r-", tmp]);
    if (designatedRequirementOf(`${shown.stdout}\n${shown.stderr}`) !== requirement) throw new Error("winter-core-live: the stated designated requirement did not take");
    const facts = signedFacts(run("codesign", ["-dv", tmp]).stderr);
    if (facts.teamId !== WINTER_TEAM_ID || facts.identifier !== DEV_DAEMON_IDENTIFIER || !facts.runtime) throw new Error(`winter-core-live is not signed as the dev daemon (team ${facts.teamId}, ${facts.identifier})`);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  return out;
}

export function buildAll(log: (l: string) => void): Built {
  if (process.platform !== "darwin") throw new Error("the live ComputerV2 suite is macOS-only");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "README.txt"), "Built by scripts/cu-live/build.ts for `bun run e2e:cu-live`. Safe to delete.\n");
  const identity = signingIdentity();
  log(`signing identity: ${identity.name}`);
  const { main, user } = buildFixtures(log);
  return { fixtureMain: main, fixtureUser: user, tool: buildTool(log), viewProbe: buildViewProbe(identity, log), daemon: buildDaemon(identity, log) };
}
