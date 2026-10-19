// N2 S2: the pure half of the Cowork native pair's build, signing and checks — the launcher (`winter-cowork-launcher`, Swift,
// apple/Cowork/WinterCoworkLauncher) and the VM worker (`winter-cowork-worker`, C, S3). Shared by
// `scripts/embed-cowork-native.sh` (the Embed phase of project.yml), the release gate in `release.ts`, `dev:cowork-native` and `verify:cowork-native`.
// Unit-tested in `embed-cowork-native.test.ts`. The feature is OFF in the daemon: shipping the pair activates nothing.
//
// Both binaries are nested tools the daemon spawns itself (never through LaunchServices), signed with the app's identity, the
// hardened runtime and a STATED designated requirement. The launcher carries NO entitlements. The worker carries exactly
// `com.apple.security.hypervisor` and nothing else (no allow-jit, no disable-library-validation, no debugger entitlement, no
// networking entitlement: there is no NIC).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signedFacts } from "./dev-daemon-lib";

/** Winter's Apple team (the signing certificate's OU), as `scripts/embed-computer-helper.sh` defaults it. */
export const COWORK_NATIVE_TEAM = "37N77U9RSZ";

export const COWORK_NATIVE = {
  /** `devIdentifier` is what the owner's dev flow signs the launcher as: the launcher reads which daemon it serves from ITS OWN signing
   *  identifier (no argument can switch it), so a dev launcher is a launcher signed with this one. */
  launcher: { identifier: "com.winter.cowork.launcher", devIdentifier: "com.winter.cowork.launcher.dev", name: "winter-cowork-launcher" },
  worker: { identifier: "com.winter.cowork.worker", name: "winter-cowork-worker" },
} as const;
export type CoworkNativeRole = keyof typeof COWORK_NATIVE;
/** "dev" differs only in the launcher's identifier (`devIdentifier`): the worker is the same program under the same identity in both. */
export type CoworkNativeFlavor = "dist" | "dev";
export const coworkNativeIdentifier = (role: CoworkNativeRole, flavor: CoworkNativeFlavor = "dist"): string =>
  role === "launcher" && flavor === "dev" ? COWORK_NATIVE.launcher.devIdentifier : COWORK_NATIVE[role].identifier;

/** Where the pair sits inside Winter.app. S7 wires the embed phase; the path is decided here so every check agrees. */
export const COWORK_NATIVE_EMBED_RELATIVE = join("Contents", "Helpers", "WinterCowork");

/** The worker's ONE entitlement. The launcher has none. */
export const COWORK_WORKER_ENTITLEMENT = "com.apple.security.hypervisor";

/** The compile condition that turns the launcher's test pin (a parent identified by cdhash) on: passed only on a test build's
 *  command line, never set in a manifest, and never reachable from an environment variable or an argument of a normal build. */
export const COWORK_TEST_BUILD_CONDITION = "WINTER_COWORK_TEST_BUILD";
/** Every test hook's argument name starts with this. A normal or release binary must contain none of it. */
export const COWORK_TEST_HOOK_MARKER = "WINTER_COWORK_TEST_";
/** The launcher's test pin builds a `cdhash H"…"` requirement; that text exists in the binary only under the test condition too. */
export const COWORK_TEST_PIN_MARKER = 'cdhash H"';

/** The Swift package of the launcher, relative to the repository root. */
export const COWORK_LAUNCHER_PACKAGE = join("apple", "Cowork", "WinterCoworkLauncher");

/** A stated designated requirement: the identifier and Winter's team under Apple's anchor — the shape of
 *  `scripts/computer-helper-lib.ts`, and what the launcher compiles for its worker (`WinterCodeIdentity.requirement`). */
export function coworkRequirement(identifier: string, teamId: string = COWORK_NATIVE_TEAM): string {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Without these a release build carries the builder's absolute source paths (the linker's debug map), which the release name scan
 *  rejects: no debug info from swiftc, and `-S -x` at the link (measured: without them the binary carries absolute source paths under the builder's home; with them it carries none). */
export const LAUNCHER_PATH_HYGIENE_FLAGS = ["-Xswiftc", "-gnone", "-Xlinker", "-S", "-Xlinker", "-x"] as const;

/** `swift build` for the launcher: release, into a scratch path the caller owns, product only. */
export function launcherBuildArgs(i: { packagePath: string; scratchPath: string; testBuild?: boolean }): string[] {
  return ["build", "--package-path", i.packagePath, "--scratch-path", i.scratchPath, "-c", "release", "--product", COWORK_NATIVE.launcher.name, ...LAUNCHER_PATH_HYGIENE_FLAGS,
    ...(i.testBuild === true ? ["-Xswiftc", `-D${COWORK_TEST_BUILD_CONDITION}`] : [])];
}

/** `codesign` for one of the pair, in the shape `embed-cowork-native.sh` uses for Release (hardened runtime, a secure timestamp,
 *  the stable identifier, the stated requirement; entitlements only when a file is given — the worker's). */
export function coworkSignArgs(i: { identity: string; role: CoworkNativeRole; flavor?: CoworkNativeFlavor; teamId?: string; path: string; entitlementsFile?: string; timestamp?: boolean }): string[] {
  const id = coworkNativeIdentifier(i.role, i.flavor);
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
export function checkSignedNative(role: CoworkNativeRole, teamId: string | undefined, facts: SignedNativeFacts, flavor: CoworkNativeFlavor = "dist"): string[] {
  const want = { ...COWORK_NATIVE[role], identifier: coworkNativeIdentifier(role, flavor) };
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
  for (const marker of [COWORK_TEST_HOOK_MARKER, COWORK_TEST_PIN_MARKER]) {
    if (Buffer.from(facts.executable).includes(marker)) failures.push(`${want.name}: contains test hooks (${marker}…) — they compile only under ${COWORK_TEST_BUILD_CONDITION}`);
  }
  return failures;
}


// ---------------------------------------------------------------------------------------------------------------------------------
// The bundle gate: what a Winter.app must hold for the pair, checked by release.ts and verify:cowork-native on the SAME function.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The manifest `embed-cowork-native.sh` writes after signing. Nothing in the daemon reads it. */
export const COWORK_NATIVE_MANIFEST_RELATIVE = join("Contents", "Resources", "cowork-native-pins.json");
export const COWORK_WORKER_PINS_FILE = join("apple", "Cowork", "WinterCoworkHVFWorker", "pins.json");
export const COWORK_GUEST_ARTIFACT_PINS_FILE = join("scripts", "cowork-guest-artifact", "pins.json");

export interface CoworkNativePins {
  /** The libkrun archive and header the worker is linked and compiled against (the worker pins file's `libkrun` block). */
  libkrunArchiveSha256: string;
  libkrunHeaderSha256: string;
  /** The whole worker pins file and the whole guest artifact pins file: any edit to either is a different set of pins. */
  workerPinsSha256: string;
  guestArtifactPinsSha256: string;
}
export interface CoworkNativeManifest {
  formatVersion: 1;
  launcher: { identifier: string; cdhash: string };
  worker: { identifier: string; cdhash: string };
  pins: CoworkNativePins;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** The pins as the repository states them right now. */
export function readCoworkRepoPins(repo: string): CoworkNativePins {
  const workerBytes = readFileSync(join(repo, COWORK_WORKER_PINS_FILE));
  const libkrun = (JSON.parse(workerBytes.toString("utf8")) as { libkrun?: { archiveSha256?: unknown; headerSha256?: unknown } }).libkrun;
  const archive = libkrun?.archiveSha256, header = libkrun?.headerSha256;
  if (typeof archive !== "string" || typeof header !== "string") throw new Error(`${COWORK_WORKER_PINS_FILE} has no libkrun archive and header hash`);
  return { libkrunArchiveSha256: archive, libkrunHeaderSha256: header, workerPinsSha256: sha256Hex(workerBytes), guestArtifactPinsSha256: sha256Hex(readFileSync(join(repo, COWORK_GUEST_ARTIFACT_PINS_FILE))) };
}

/** `CDHash=<40 hex>` from `codesign -dvvv` output (three v: `-dvv` omits it). */
export function parseCdHash(codesignDvv: string): string | undefined {
  return /^CDHash=([0-9a-f]{40})$/m.exec(codesignDvv)?.[1];
}

const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/;
const sameKeys = (value: object, keys: string[]): boolean => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

/** Strict parse of the manifest: exactly these keys, these shapes. Null with a reason in `problems` when it is anything else. */
export function parseCoworkNativeManifest(text: string, problems: string[]): CoworkNativeManifest | null {
  let value: any;
  try { value = JSON.parse(text); } catch { problems.push("the pin manifest is not JSON"); return null; }
  const member = (v: any) => v && typeof v === "object" && sameKeys(v, ["identifier", "cdhash"]) && typeof v.identifier === "string" && HEX40.test(v.cdhash);
  const pinKeys = ["libkrunArchiveSha256", "libkrunHeaderSha256", "workerPinsSha256", "guestArtifactPinsSha256"];
  if (!value || typeof value !== "object" || !sameKeys(value, ["formatVersion", "launcher", "worker", "pins"]) || value.formatVersion !== 1 || !member(value.launcher) || !member(value.worker)
    || !value.pins || typeof value.pins !== "object" || !sameKeys(value.pins, pinKeys) || pinKeys.some((key) => !HEX64.test(value.pins[key]))) {
    problems.push("the pin manifest does not have exactly the expected shape (formatVersion 1, launcher, worker, four pin hashes)");
    return null;
  }
  return value as CoworkNativeManifest;
}

export interface CoworkNativeBundleFacts {
  /** The names directly inside Contents/Helpers/WinterCowork ([] when the directory is missing). */
  entries: readonly string[];
  /** Contents/Resources/cowork-native-pins.json, or null when absent. */
  manifestText: string | null;
  /** The CDHash `codesign -dvvv` reports for each binary in the bundle right now. */
  liveCdhash: { launcher: string | undefined; worker: string | undefined };
  /** `readCoworkRepoPins` of the checkout the bundle is being released from. */
  repoPins: CoworkNativePins;
}

/**
 * Refuses a bundle whose launcher, worker or pins do not match: the directory holds exactly the two binaries; the manifest has the exact shape and
 * the two identifiers; the manifest's CDHashes are the live signed binaries' (a swapped or re-signed binary is a different CDHash); and every pin hash in
 * the manifest is the repository's (the bundle was built against these libkrun inputs and these pin files, not some other set). Failure lines; empty = good.
 */
export function checkCoworkNativeBundle(facts: CoworkNativeBundleFacts): string[] {
  const failures: string[] = [];
  const want = [COWORK_NATIVE.launcher.name, COWORK_NATIVE.worker.name].sort();
  const have = [...facts.entries].sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) failures.push(`Helpers/WinterCowork holds [${have.join(", ")}], expected exactly [${want.join(", ")}]`);
  if (facts.manifestText === null) { failures.push("the pin manifest cowork-native-pins.json is missing"); return failures; }
  const problems: string[] = [];
  const manifest = parseCoworkNativeManifest(facts.manifestText, problems);
  failures.push(...problems);
  if (manifest === null) return failures;
  for (const role of ["launcher", "worker"] as const) {
    const name = COWORK_NATIVE[role].name;
    if (manifest[role].identifier !== COWORK_NATIVE[role].identifier) failures.push(`${name}: the manifest names identifier ${manifest[role].identifier}, expected ${COWORK_NATIVE[role].identifier}`);
    const live = facts.liveCdhash[role];
    if (live === undefined) failures.push(`${name}: no CDHash could be read from the signed binary`);
    else if (live !== manifest[role].cdhash) failures.push(`${name}: the signed binary's CDHash ${live} is not the manifest's ${manifest[role].cdhash} (the binary changed after it was embedded)`);
  }
  for (const key of Object.keys(facts.repoPins) as (keyof CoworkNativePins)[]) {
    if (manifest.pins[key] !== facts.repoPins[key]) failures.push(`pin ${key}: the bundle was built against ${manifest.pins[key]}, the repository now says ${facts.repoPins[key]}`);
  }
  return failures;
}

/** The facts for a bundle on disk, by shelling out through the caller's `run` (stdout+stderr of a command). The caller is release.ts or a verify script. */
export function readCoworkBundleFacts(input: { appContents: string; repo: string; listDirectory: (path: string) => string[]; readText: (path: string) => string | null; codesignDvvv: (path: string) => string }): CoworkNativeBundleFacts {
  const dir = join(input.appContents, "Helpers", "WinterCowork");
  return {
    entries: input.listDirectory(dir),
    manifestText: input.readText(join(input.appContents, "Resources", "cowork-native-pins.json")),
    liveCdhash: { launcher: parseCdHash(input.codesignDvvv(join(dir, COWORK_NATIVE.launcher.name))), worker: parseCdHash(input.codesignDvvv(join(dir, COWORK_NATIVE.worker.name))) },
    repoPins: readCoworkRepoPins(input.repo),
  };
}


// ---------------------------------------------------------------------------------------------------------------------------------
// The release choice: ship the pair (with the libkrun inputs) or omit it, explicitly. Never an accident.
// ---------------------------------------------------------------------------------------------------------------------------------

export type CoworkNativeReleasePlan =
  | { mode: "build"; include: string; archive: string }
  | { mode: "omit" }
  | { mode: "refuse"; message: string };

/**
 * `COWORK_LIBKRUN_INCLUDE` + `COWORK_LIBKRUN_ARCHIVE` (both) build and ship the pair; `COWORK_NATIVE=omit` ships none; anything else refuses, with a message that names both ways out.
 * Giving the inputs AND omit is contradictory, one input alone is half a build, and any other value of COWORK_NATIVE is a typo: all refuse. Winter releases must not block on an archive
 * that does not exist yet, which is what `omit` is for; it is never the default.
 */
export function coworkNativeReleasePlan(env: Readonly<Record<string, string | undefined>>): CoworkNativeReleasePlan {
  const include = env.COWORK_LIBKRUN_INCLUDE?.trim() || undefined, archive = env.COWORK_LIBKRUN_ARCHIVE?.trim() || undefined, choice = env.COWORK_NATIVE?.trim();
  const way = "set COWORK_LIBKRUN_INCLUDE and COWORK_LIBKRUN_ARCHIVE (S4's header directory and stripped production archive) to ship the Cowork native pair, or COWORK_NATIVE=omit to release without it";
  if (choice !== undefined && choice !== "" && choice !== "omit") return { mode: "refuse", message: `COWORK_NATIVE=${choice} is not a choice (the only value is "omit"); ${way}` };
  if (choice === "omit") {
    return include !== undefined || archive !== undefined
      ? { mode: "refuse", message: "COWORK_NATIVE=omit contradicts the libkrun inputs that are also set; give one or the other" }
      : { mode: "omit" };
  }
  if (include === undefined && archive === undefined) return { mode: "refuse", message: `the Cowork native pair has neither its inputs nor an explicit omit: ${way}` };
  if (include === undefined || archive === undefined) return { mode: "refuse", message: `only one of COWORK_LIBKRUN_INCLUDE and COWORK_LIBKRUN_ARCHIVE is set; ${way}` };
  return { mode: "build", include, archive };
}

export interface CoworkNativeOmittedFacts {
  /** Whether Contents/Helpers/WinterCowork exists at all (even empty). */
  helpersDirectoryExists: boolean;
  /** Contents/Resources/cowork-native-pins.json, or null when absent. */
  manifestText: string | null;
}
/** An omitted bundle carries no WinterCowork helpers and no pins file. Failure lines; empty = good. */
export function checkCoworkNativeOmitted(facts: CoworkNativeOmittedFacts): string[] {
  const failures: string[] = [];
  if (facts.helpersDirectoryExists) failures.push("Contents/Helpers/WinterCowork exists, but the release omits the Cowork native pair");
  if (facts.manifestText !== null) failures.push("Contents/Resources/cowork-native-pins.json exists, but the release omits the Cowork native pair");
  return failures;
}
