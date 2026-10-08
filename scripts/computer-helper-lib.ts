// ComputerV2: the pure half of the Winter Computer Use helper's build, signing and checks — shared by
// `scripts/dev-helper.ts` (`bun run dev:helper`), `scripts/verify-computer-helper.ts`
// (`bun run verify:computer-helper`) and `scripts/release.ts`. Unit-tested in `computer-helper-lib.test.ts`.
import { join } from "node:path";
import { signedFacts } from "./dev-daemon-lib";

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

/** `codesign` for a dev or test bundle: hardened runtime, no entitlements, the stable identifier and the stated
 *  requirement; no secure timestamp (a local build, offline-friendly — the dev daemon's posture). */
export function helperSignArgs(i: { identityHash: string; flavor: HelperFlavor; teamId: string; appPath: string }): string[] {
  const id = HELPER[i.flavor].identifier;
  return ["--force", "--sign", i.identityHash, "--identifier", id, "--options", "runtime", "--timestamp=none",
    `-r=designated => ${helperRequirement(id, i.teamId)}`, i.appPath];
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
 * identifier, Winter's team, the hardened runtime, EXACTLY the stated designated requirement, no entitlements
 * of any kind, an LSUIElement Info.plist at `version`, and test hooks compiled in only for the test flavor.
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
  if (entitlementKeys.length > 0) failures.push(`carries entitlements (${entitlementKeys.join(", ")}); it must carry none`);
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
