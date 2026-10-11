// ComputerV2 Phase 4 — the pure parts of building, signing and checking Winter Headless (apple/Winter/Sources/
// HeadlessHelper): its identities, its stated designated requirement, the codesign and xcodebuild arguments, and the
// one signature check every site runs (`dev:headless`, `verify:headless-helper`, release.ts) — so they cannot drift.
//
// Winter Headless is a background-only app the daemon SPAWNS (never through LaunchServices) and checks against its
// stated requirement before sending it anything (`processSatisfiesRequirement`). It holds no grants and needs no
// entitlements: hardened runtime, no entitlements at all. Two layouts:
//   - dist (Release): nested at Winter.app/Contents/Helpers/Winter Headless.app, it BORROWS Winter.app's Chromium —
//     it must carry no Contents/Frameworks of its own;
//   - dev (`bun run dev:headless`): self-contained in dist/dev/, its own copy of the CEF framework and the five
//     "Winter Helper" bundles in its Contents/Frameworks (signed by the build with the same team, which the hardened
//     runtime's library validation requires).
import { join } from "node:path";

export const HEADLESS = {
  dist: { identifier: "com.winter.headless", name: "Winter Headless" },
  dev: { identifier: "com.winter.headless.dev", name: "Winter Headless Dev" },
} as const;
export type HeadlessFlavor = keyof typeof HEADLESS;

/** Where a Release Winter.app carries it. */
export const HEADLESS_EMBED_RELATIVE = join("Contents", "Helpers", `${HEADLESS.dist.name}.app`);

/** identifier + Winter's team under Apple's anchor — the requirement the daemon checks the spawned process against. */
export function headlessRequirement(identifier: string, teamId: string): string {
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

export function headlessExecutable(appPath: string, flavor: HeadlessFlavor): string {
  return join(appPath, "Contents", "MacOS", HEADLESS[flavor].name);
}

/** xcodebuild for the dev helper: Debug, the dev identity, self-contained. Signed by the build (the nested framework
 *  and helper bundles need the team's signature), then re-signed with the stated requirement (`headlessSignArgs`). */
export function headlessBuildArgs(i: { derivedDataPath: string }): string[] {
  return [
    "-project", "Winter.xcodeproj",
    "-scheme", "WinterHeadless",
    "-configuration", "Debug",
    "-destination", "platform=macOS",
    "-derivedDataPath", i.derivedDataPath,
    `PRODUCT_BUNDLE_IDENTIFIER=${HEADLESS.dev.identifier}`,
    "WINTER_HEADLESS_SELF_CONTAINED=YES",
    "build",
  ];
}

/** Where xcodebuild leaves the dev helper. */
export function builtHeadlessPath(derivedDataPath: string): string {
  return join(derivedDataPath, "Build", "Products", "Debug", `${HEADLESS.dev.name}.app`);
}

/** codesign for the outer bundle: the stable identifier, the hardened runtime, NO entitlements (a re-sign drops the
 *  build's), the stated requirement. Never `--deep`: the nested code keeps its own signatures. */
export function headlessSignArgs(i: { identityHash: string; flavor: HeadlessFlavor; teamId: string; appPath: string; timestamp?: boolean }): string[] {
  return [
    "--force", "--sign", i.identityHash, "--identifier", HEADLESS[i.flavor].identifier, "--options", "runtime",
    i.timestamp === true ? "--timestamp" : "--timestamp=none",
    `-r=designated => ${headlessRequirement(HEADLESS[i.flavor].identifier, i.teamId)}`,
    i.appPath,
  ];
}

export interface SignedHeadlessFacts {
  /** `codesign -dvv <app>`'s output (stderr). */
  codesignDvv: string;
  /** `codesign -d -r- <app>`'s output. */
  codesignDr: string;
  /** `codesign -d --entitlements - --xml <app>`'s output. */
  entitlementsXml: string;
  infoPlist: Record<string, unknown>;
  /** Whether the bundle has a Contents/Frameworks of its own. */
  hasFrameworks: boolean;
}

/** The identifier, team and hardened-runtime flag out of `codesign -dvv`. */
export function signedFacts(dvv: string): { identifier?: string; teamId?: string; runtime: boolean } {
  const identifier = /^Identifier=(.+)$/m.exec(dvv)?.[1]?.trim();
  const teamId = /^TeamIdentifier=(.+)$/m.exec(dvv)?.[1]?.trim();
  const runtime = /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime/m.test(dvv);
  return { ...(identifier === undefined ? {} : { identifier }), ...(teamId === undefined || teamId === "not set" ? {} : { teamId }), runtime };
}

/** Everything a signed Winter Headless must be; the failures (empty = good). */
export function checkSignedHeadless(flavor: HeadlessFlavor, teamId: string, version: string, facts: SignedHeadlessFacts): string[] {
  const want = HEADLESS[flavor];
  const failures: string[] = [];
  const signed = signedFacts(facts.codesignDvv);
  if (signed.identifier !== want.identifier) failures.push(`codesign identifier is ${signed.identifier ?? "none"}, expected ${want.identifier}`);
  if (signed.teamId !== teamId) failures.push(`TeamIdentifier is ${signed.teamId ?? "not set"}, expected ${teamId}`);
  if (!signed.runtime) failures.push("not signed with the hardened runtime (--options runtime)");
  const recorded = /^designated => (.+)$/m.exec(facts.codesignDr)?.[1]?.trim();
  const stated = headlessRequirement(want.identifier, teamId);
  if (recorded !== stated) failures.push(`designated requirement is ${recorded ?? "none"}, expected the stated ${stated}`);
  const entitlementKeys = [...facts.entitlementsXml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  if (entitlementKeys.length > 0) failures.push(`carries entitlements (${entitlementKeys.join(", ")}); it must carry none`);
  const plist = facts.infoPlist;
  if (plist.CFBundleIdentifier !== want.identifier) failures.push(`Info.plist CFBundleIdentifier is ${String(plist.CFBundleIdentifier)}, expected ${want.identifier}`);
  if (plist.CFBundleName !== want.name) failures.push(`Info.plist CFBundleName is ${String(plist.CFBundleName)}, expected ${want.name}`);
  if (plist.LSBackgroundOnly !== true) failures.push("Info.plist LSBackgroundOnly is not true (it must have no Dock tile and no menu bar)");
  if (plist.CFBundleShortVersionString !== version) failures.push(`Info.plist CFBundleShortVersionString is ${String(plist.CFBundleShortVersionString)}, expected ${version}`);
  if (flavor === "dist" && facts.hasFrameworks) failures.push("it carries its own Contents/Frameworks — a release borrows Winter.app's Chromium (never a second copy)");
  if (flavor === "dev" && !facts.hasFrameworks) failures.push("it has no Contents/Frameworks — the dev helper is self-contained (WINTER_HEADLESS_SELF_CONTAINED=YES did not reach the build)");
  return failures;
}
