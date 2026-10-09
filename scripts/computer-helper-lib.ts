// ComputerV2: the pure half of the Winter Computer Use helper's build, signing and checks — shared by
// `scripts/dev-helper.ts` (`bun run dev:helper`), `scripts/verify-computer-helper.ts`
// (`bun run verify:computer-helper`) and `scripts/release.ts`. Unit-tested in `computer-helper-lib.test.ts`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedFacts } from "./dev-daemon-lib";

const REPO = join(import.meta.dir, "..");

/**
 * The helper's three identities. dist ships inside Winter.app; dev is what `bun run dev:helper` builds into
 * `dist/dev/`; test is built only by `bun run verify:computer-helper`, with the `WINTER_CU_TEST_BUILD`
 * compilation condition, and is never registered with LaunchServices or kept.
 */
export const HELPER = {
  dist: { identifier: "com.winter.computeruse", name: "Winter Computer Use" },
  dev: { identifier: "com.winter.computeruse.dev", name: "Winter Computer Use Dev" },
  test: { identifier: "com.winter.computeruse.test", name: "Winter Computer Use Test" },
} as const;
export type HelperFlavor = keyof typeof HELPER;

/** Where the dist helper sits inside Winter.app. */
export const HELPER_EMBED_RELATIVE = join("Contents", "Helpers", `${HELPER.dist.name}.app`);

/** The helper's ONE entitlement: sending Apple Events, for `applescript()` (the hardened runtime refuses them
 *  without it). Every signing site passes this file and every check expects exactly this key. */
export const HELPER_ENTITLEMENT = "com.apple.security.automation.apple-events";
export const HELPER_ENTITLEMENTS_FILE = join(REPO, "apple", "ComputerUse", "WinterComputerUse", "Support", "WinterComputerUse.entitlements");

// The helper's OWN version — semver, independent of Winter's #.###.# VERSION — lives in `apple/ComputerUse/VERSION`
// (bump rules: apple/ComputerUse/PROTOCOL.md). `syncHelperVersion` stamps it into the helper target's two lines of
// apple/Winter/project.yml (marked with `HELPER_VERSION_MARKER`, which Winter's own stamp skips) and into the
// generated Support/Info.plist; version:sync, dev:helper and verify:computer-helper run it, and release.ts and
// embed-computer-helper.sh check the built bundle against it. The helper reports it as `helperVersion`.
export const HELPER_VERSION_FILE = join(REPO, "apple", "ComputerUse", "VERSION");
export const HELPER_INFO_PLIST = join(REPO, "apple", "ComputerUse", "WinterComputerUse", "Support", "Info.plist");
const PROJECT_YML = join(REPO, "apple", "Winter", "project.yml");
export const HELPER_VERSION_MARKER = "# apple/ComputerUse/VERSION";
export const HELPER_VERSION_FORMAT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The helper version in `raw` (a VERSION file's content), or a throw naming the format. */
export function parseHelperVersion(raw: string): string {
  const v = raw.trim();
  if (!HELPER_VERSION_FORMAT.test(v)) throw new Error(`apple/ComputerUse/VERSION "${v}" is not a semver MAJOR.MINOR.PATCH (e.g. 1.0.0)`);
  return v;
}

export function readHelperVersion(path: string = HELPER_VERSION_FILE): string {
  return parseHelperVersion(readFileSync(path, "utf8"));
}

/** project.yml with the helper target's marked version lines set to `v` (exactly two marked lines, or a throw). */
export function stampHelperProjectYml(yml: string, v: string): string {
  const marker = HELPER_VERSION_MARKER.replace(/[/.]/g, (c) => `\\${c}`);
  const short = new RegExp(`(CFBundleShortVersionString: )"[^"]*"( ${marker})`, "g");
  const build = new RegExp(`(CFBundleVersion: )"[^"]*"( ${marker})`, "g");
  if ([...yml.matchAll(short)].length !== 1 || [...yml.matchAll(build)].length !== 1) {
    throw new Error(`apple/Winter/project.yml must carry the helper's CFBundleShortVersionString and CFBundleVersion once each, marked "${HELPER_VERSION_MARKER}"`);
  }
  return yml.replace(short, `$1"${v}"$2`).replace(build, `$1"${v}"$2`);
}

/** The helper's Info.plist with both version keys set to `v`. */
export function stampHelperInfoPlist(plist: string, v: string): string {
  return plist
    .replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${v}$2`)
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${v}$2`);
}

/** Stamps `apple/ComputerUse/VERSION` into project.yml and the helper's Info.plist; writes only what changes (an
 *  unchanged source keeps its mtime, so a build after it is not dirtied). Returns the files written. */
export function syncHelperVersion(paths: { versionFile?: string; projectYml?: string; infoPlist?: string } = {}): string[] {
  const v = readHelperVersion(paths.versionFile);
  const written: string[] = [];
  for (const [path, stamp] of [
    [paths.projectYml ?? PROJECT_YML, stampHelperProjectYml],
    [paths.infoPlist ?? HELPER_INFO_PLIST, stampHelperInfoPlist],
  ] as const) {
    const before = readFileSync(path, "utf8");
    const after = stamp(before, v);
    if (after !== before) {
      writeFileSync(path, after);
      written.push(path);
    }
  }
  return written;
}

/** `<WINTER_HOME>/run/<this>`. */
export const HELPER_SOCKET_NAME = "computer-use.sock";

/** The compilation condition that compiles the test hooks in; passed only on the test flavor's command line. */
export const HELPER_TEST_BUILD_CONDITION = "WINTER_CU_TEST_BUILD";
/** Every test hook's environment variable starts with this. A dev or release binary must not contain it. */
export const HELPER_TEST_HOOK_MARKER = "WINTER_CU_TEST_";

export const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** The daemon identities the helper accepts: the shipped `winter-core` (signed without `--identifier`, so it
 *  carries the file's name) and the signed dev daemon. */
export const DAEMON_IDENTIFIER = { dist: "winter-core", dev: "com.winter.core.dev" } as const;

/**
 * A stated designated requirement — identifier + Winter's team (the certificate's OU) under Apple's anchor —
 * the `scripts/dev-daemon-lib.ts` shape. TCC keys the helper's grants on it, so stating it (instead of letting
 * codesign derive one naming the certificate's common name) keeps the grants across rebuilds and signers.
 */
export function helperRequirement(identifier: string, teamId: string): string {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** The app bundle's executable. */
export function helperExecutable(appPath: string, flavor: HelperFlavor): string {
  return join(appPath, "Contents", "MacOS", HELPER[flavor].name);
}

/**
 * xcodebuild for the dev or test flavor: the WinterComputerUse scheme only (no CEF, no app), Debug, unsigned
 * — the scripts sign it themselves with the stated requirement. The bundle id is always given here: project.yml's
 * Debug id is a placeholder (`com.winter.computeruse.xcode-debug`) so an ordinary Debug Winter build never
 * registers a second com.winter.computeruse.dev with LaunchServices. The test flavor also takes its own name and
 * the test-hook compilation condition, so it can never be mistaken for, or replace, the dev helper.
 */
export function helperBuildArgs(i: { flavor: "dev" | "test"; derivedDataPath: string }): string[] {
  const args = [
    "-project", "Winter.xcodeproj",
    "-scheme", "WinterComputerUse",
    "-configuration", "Debug",
    "-destination", "platform=macOS",
    "-derivedDataPath", i.derivedDataPath,
    "CODE_SIGNING_ALLOWED=NO",
    `PRODUCT_BUNDLE_IDENTIFIER=${HELPER[i.flavor].identifier}`,
  ];
  if (i.flavor === "test") {
    args.push(
      `WINTER_CU_APP_NAME=${HELPER.test.name}`,
      `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG ${HELPER_TEST_BUILD_CONDITION}`,
    );
  }
  args.push("build");
  return args;
}

/** Where xcodebuild leaves a flavor's bundle. */
export function builtHelperPath(derivedDataPath: string, flavor: "dev" | "test"): string {
  return join(derivedDataPath, "Build", "Products", "Debug", `${HELPER[flavor].name}.app`);
}

/** `codesign` for a dev or test bundle: hardened runtime, exactly the Apple Events entitlement, the stable
 *  identifier and the stated requirement; no secure timestamp (a local build, offline-friendly — the dev daemon's
 *  posture). */
export function helperSignArgs(i: { identityHash: string; flavor: HelperFlavor; teamId: string; appPath: string }): string[] {
  const id = HELPER[i.flavor].identifier;
  return ["--force", "--sign", i.identityHash, "--identifier", id, "--options", "runtime", "--timestamp=none",
    "--entitlements", HELPER_ENTITLEMENTS_FILE, `-r=designated => ${helperRequirement(id, i.teamId)}`, i.appPath];
}

export interface SignedHelperFacts {
  /** stderr of `codesign -dvv <app>`. */
  codesignDvv: string;
  /** stdout+stderr of `codesign -d -r- <app>`. */
  codesignDr: string;
  /** stdout of `codesign -d --entitlements - --xml <app>` ("" when none). */
  entitlementsXml: string;
  /** The bundle's Info.plist, as JSON (`plutil -convert json -o - …`). */
  infoPlist: Record<string, unknown>;
  /** The main executable's bytes. */
  executable: Uint8Array;
}

/**
 * Everything a signed helper bundle must be, as failure lines (empty = good): the flavor's bundle id and
 * identifier, Winter's team, the hardened runtime, EXACTLY the stated designated requirement, exactly one
 * entitlement (Apple Events, set to true), an LSUIElement Info.plist at `version` that says why it sends Apple
 * Events, and test hooks compiled in only for the test flavor.
 */
export function checkSignedHelper(flavor: HelperFlavor, teamId: string, version: string, facts: SignedHelperFacts): string[] {
  const want = HELPER[flavor];
  const failures: string[] = [];
  const signed = signedFacts(facts.codesignDvv);
  if (signed.identifier !== want.identifier) failures.push(`codesign identifier is ${signed.identifier ?? "none"}, expected ${want.identifier}`);
  if (signed.teamId !== teamId) failures.push(`TeamIdentifier is ${signed.teamId ?? "not set"}, expected ${teamId}`);
  if (!signed.runtime) failures.push("not signed with the hardened runtime (--options runtime)");
  const recorded = /^designated => (.+)$/m.exec(facts.codesignDr)?.[1]?.trim();
  const stated = helperRequirement(want.identifier, teamId);
  if (recorded !== stated) failures.push(`designated requirement is ${recorded ?? "none"}, expected the stated ${stated}`);
  const entitlementKeys = [...facts.entitlementsXml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  const extra = entitlementKeys.filter((k) => k !== HELPER_ENTITLEMENT);
  if (extra.length > 0) failures.push(`carries entitlements beyond ${HELPER_ENTITLEMENT} (${extra.join(", ")}); it must carry only that one`);
  if (!new RegExp(`<key>${HELPER_ENTITLEMENT.replace(/\./g, "\\.")}</key>\\s*<true\\s*/>`).test(facts.entitlementsXml)) {
    failures.push(`does not carry ${HELPER_ENTITLEMENT} = true (applescript() needs it under the hardened runtime)`);
  }
  if (typeof facts.infoPlist.NSAppleEventsUsageDescription !== "string" || facts.infoPlist.NSAppleEventsUsageDescription.length === 0) {
    failures.push("Info.plist has no NSAppleEventsUsageDescription (macOS would refuse Apple Events without asking)");
  }
  const plist = facts.infoPlist;
  if (plist.CFBundleIdentifier !== want.identifier) failures.push(`Info.plist CFBundleIdentifier is ${String(plist.CFBundleIdentifier)}, expected ${want.identifier}`);
  if (plist.CFBundleName !== want.name) failures.push(`Info.plist CFBundleName is ${String(plist.CFBundleName)}, expected ${want.name}`);
  if (plist.LSUIElement !== true) failures.push("Info.plist LSUIElement is not true (it must be an agent app: no Dock icon)");
  if (plist.CFBundleShortVersionString !== version) failures.push(`Info.plist CFBundleShortVersionString is ${String(plist.CFBundleShortVersionString)}, expected ${version}`);
  const hasHooks = Buffer.from(facts.executable).includes(HELPER_TEST_HOOK_MARKER);
  if (flavor === "test" && !hasHooks) failures.push(`the test flavor has no test hooks compiled in (${HELPER_TEST_BUILD_CONDITION} did not reach the build)`);
  if (flavor !== "test" && hasHooks) failures.push(`the ${flavor} binary contains test hooks (${HELPER_TEST_HOOK_MARKER}…) — they compile only under ${HELPER_TEST_BUILD_CONDITION}`);
  return failures;
}

/** The pids in `ps -axo pid=,command=` output whose command runs `executable`. */
export function pidsRunning(psOutput: string, executable: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m !== null && (m[2] === executable || m[2]!.startsWith(`${executable} `))) pids.push(Number(m[1]));
  }
  return pids;
}
