// N2 S2: the pure half of the Cowork native pair's build, signing and checks — the launcher (`winter-cowork-launcher`, Swift,
// apple/Cowork/WinterCoworkLauncher) and the VM worker (`winter-cowork-worker`, C, S3). Shared by
// `scripts/embed-cowork-native.sh`'s test today and by the dev script and the `verify:` gate S7 adds. Unit-tested in
// `embed-cowork-native.test.ts`. SOURCE ONLY and UNWIRED: nothing in the daemon, project.yml or release.ts uses it yet.
//
// Both binaries are nested tools the daemon spawns itself (never through LaunchServices), signed with the app's identity, the
// hardened runtime and a STATED designated requirement. The launcher carries NO entitlements. The worker carries exactly
// `com.apple.security.hypervisor` and nothing else (no allow-jit, no disable-library-validation, no debugger entitlement, no
// networking entitlement: there is no NIC).
import { join } from "node:path";
import { signedFacts } from "./dev-daemon-lib";

/** Winter's Apple team (the signing certificate's OU), as `scripts/embed-computer-helper.sh` defaults it. */
export const COWORK_NATIVE_TEAM = "37N77U9RSZ";

export const COWORK_NATIVE = {
  launcher: { identifier: "com.winter.cowork.launcher", name: "winter-cowork-launcher" },
  worker: { identifier: "com.winter.cowork.worker", name: "winter-cowork-worker" },
} as const;
export type CoworkNativeRole = keyof typeof COWORK_NATIVE;

/** Where the pair sits inside Winter.app. S7 wires the embed phase; the path is decided here so every check agrees. */
export const COWORK_NATIVE_EMBED_RELATIVE = join("Contents", "Helpers", "WinterCowork");

/** The worker's ONE entitlement. The launcher has none. */
export const COWORK_WORKER_ENTITLEMENT = "com.apple.security.hypervisor";

/** The compile condition that turns the launcher's test pin (a parent identified by cdhash) on: passed only on a test build's
 *  command line, never set in a manifest, and never reachable from an environment variable or an argument of a normal build. */
export const COWORK_TEST_BUILD_CONDITION = "WINTER_COWORK_TEST_BUILD";
/** Every test hook's argument name starts with this. A normal or release binary must contain none of it. */
export const COWORK_TEST_HOOK_MARKER = "WINTER_COWORK_TEST_";

/** The Swift package of the launcher, relative to the repository root. */
export const COWORK_LAUNCHER_PACKAGE = join("apple", "Cowork", "WinterCoworkLauncher");

/** A stated designated requirement: the identifier and Winter's team under Apple's anchor — the shape of
 *  `scripts/computer-helper-lib.ts`, and what the launcher compiles for its worker (`WinterCodeIdentity.requirement`). */
export function coworkRequirement(identifier: string, teamId: string = COWORK_NATIVE_TEAM): string {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Without these a release build carries the builder's absolute source paths (the linker's debug map), which the release name scan
 *  rejects: no debug info from swiftc, and `-S -x` at the link (measured: 903 kB offset of `/Users/…/Sources/…` paths gone). */
export const LAUNCHER_PATH_HYGIENE_FLAGS = ["-Xswiftc", "-gnone", "-Xlinker", "-S", "-Xlinker", "-x"] as const;

/** `swift build` for the launcher: release, into a scratch path the caller owns, product only. */
export function launcherBuildArgs(i: { packagePath: string; scratchPath: string; testBuild?: boolean }): string[] {
  return ["build", "--package-path", i.packagePath, "--scratch-path", i.scratchPath, "-c", "release", "--product", COWORK_NATIVE.launcher.name, ...LAUNCHER_PATH_HYGIENE_FLAGS,
    ...(i.testBuild === true ? ["-Xswiftc", `-D${COWORK_TEST_BUILD_CONDITION}`] : [])];
}

/** `codesign` for one of the pair, in the shape `embed-cowork-native.sh` uses for Release (hardened runtime, a secure timestamp,
 *  the stable identifier, the stated requirement; entitlements only when a file is given — the worker's). */
export function coworkSignArgs(i: { identity: string; role: CoworkNativeRole; teamId?: string; path: string; entitlementsFile?: string; timestamp?: boolean }): string[] {
  const id = COWORK_NATIVE[i.role].identifier;
  return ["--force", "--sign", i.identity, "--identifier", id, "--options", "runtime", i.timestamp === false ? "--timestamp=none" : "--timestamp",
    ...(i.entitlementsFile !== undefined ? ["--entitlements", i.entitlementsFile] : []), `-r=designated => ${coworkRequirement(id, i.teamId)}`, i.path];
}

/** Dylibs named by `otool -L <binary>` (the first line is the binary itself, the rest are `\t<path> (compatibility …)`). */
export function linkedLibraries(otoolOutput: string): string[] {
  return otoolOutput.split("\n").slice(1).map((line) => /^\s+(\S.*?)\s+\(/.exec(line)?.[1]).filter((path): path is string => path !== undefined);
}
/** A platform dylib lives under /usr/lib or /System/Library (the Swift runtime's /usr/lib/swift included). Anything else — a
 *  Homebrew path, an @rpath library, a vendored framework — would have to be signed and shipped with the pair, and is refused. */
export function nonPlatformLibraries(libraries: readonly string[]): string[] {
  return libraries.filter((path) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"));
}

/** The entitlement keys in `codesign -d --entitlements - --xml` output ("" when the binary carries none). */
export function entitlementKeys(entitlementsXml: string): string[] {
  return [...entitlementsXml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] as string);
}

export interface SignedNativeFacts {
  /** stderr of `codesign -dvv <binary>`. */
  codesignDvv: string;
  /** stdout+stderr of `codesign -d -r- <binary>`. */
  codesignDr: string;
  /** stdout of `codesign -d --entitlements - --xml <binary>` ("" when none). */
  entitlementsXml: string;
  /** stdout of `otool -L <binary>`. */
  otoolL: string;
  /** The executable's bytes. */
  executable: Uint8Array;
}

/**
 * Everything a signed member of the pair must be, as failure lines (empty = good): its identifier, Winter's team (`teamId`
 * undefined means an ad-hoc test signature, which has none), the hardened runtime, EXACTLY the stated designated requirement,
 * the right entitlements (none for the launcher, exactly the hypervisor key for the worker), platform dylibs only, and no test hook
 * anywhere in the bytes.
 */
export function checkSignedNative(role: CoworkNativeRole, teamId: string | undefined, facts: SignedNativeFacts): string[] {
  const want = COWORK_NATIVE[role];
  const failures: string[] = [];
  const signed = signedFacts(facts.codesignDvv);
  if (signed.identifier !== want.identifier) failures.push(`${want.name}: codesign identifier is ${signed.identifier ?? "none"}, expected ${want.identifier}`);
  if (teamId !== undefined && signed.teamId !== teamId) failures.push(`${want.name}: TeamIdentifier is ${signed.teamId ?? "not set"}, expected ${teamId}`);
  if (!signed.runtime) failures.push(`${want.name}: not signed with the hardened runtime (--options runtime)`);
  const recorded = /^designated => (.+)$/m.exec(facts.codesignDr)?.[1]?.trim();
  const stated = coworkRequirement(want.identifier, teamId ?? COWORK_NATIVE_TEAM);
  if (recorded !== stated) failures.push(`${want.name}: designated requirement is ${recorded ?? "none"}, expected the stated ${stated}`);
  const keys = entitlementKeys(facts.entitlementsXml);
  const expected = role === "worker" ? [COWORK_WORKER_ENTITLEMENT] : [];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    failures.push(`${want.name}: entitlements are [${keys.join(", ")}], expected exactly [${expected.join(", ")}]`);
  } else if (role === "worker" && !new RegExp(`<key>${COWORK_WORKER_ENTITLEMENT.replace(/\./g, "\\.")}</key>\\s*<true\\s*/>`).test(facts.entitlementsXml)) {
    failures.push(`${want.name}: ${COWORK_WORKER_ENTITLEMENT} is not set to true`);
  }
  const foreign = nonPlatformLibraries(linkedLibraries(facts.otoolL));
  if (foreign.length > 0) failures.push(`${want.name}: links non-platform libraries (${foreign.join(", ")})`);
  if (Buffer.from(facts.executable).includes(COWORK_TEST_HOOK_MARKER)) failures.push(`${want.name}: contains test hooks (${COWORK_TEST_HOOK_MARKER}…) — they compile only under ${COWORK_TEST_BUILD_CONDITION}`);
  return failures;
}
