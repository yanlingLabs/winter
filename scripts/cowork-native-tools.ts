// The shell-out half shared by `dev:cowork-native` and `verify:cowork-native` (the pure half is cowork-native-lib.ts). Everything here SIGNS or INSPECTS files in a
// directory the caller owns; nothing executes, loads or launches either binary (codesign, otool and strings-style reads only).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COWORK_NATIVE, checkSignedNative, coworkNativeIdentifier, coworkRequirement, coworkSignArgs, type CoworkNativeFlavor, type CoworkNativeRole } from "./cowork-native-lib";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_ENTITLEMENTS = join(REPO_ROOT, "apple", "Cowork", "WinterCoworkHVFWorker", "worker.entitlements");

export function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Signs one member of the pair in place (worker with the hypervisor entitlement, launcher with none). `identity` "-" is ad hoc. Returns failure lines. */
export function signNative(path: string, role: CoworkNativeRole, flavor: CoworkNativeFlavor, input: { identity: string; teamId?: string; timestamp: boolean; entitlementsFile?: string }): string[] {
  const signed = run("codesign", coworkSignArgs({ identity: input.identity, role, flavor, teamId: input.teamId, path, timestamp: input.timestamp, ...(role === "worker" ? { entitlementsFile: input.entitlementsFile ?? WORKER_ENTITLEMENTS } : {}) }));
  return signed.status === 0 ? [] : [`codesign of ${COWORK_NATIVE[role].name} failed: ${signed.stderr.trim()}`];
}

/** The signature, requirement, entitlement, library and test-hook checks on an already-signed member, plus (team-signed only) a strict verify against its own stated requirement. */
export function inspectNative(path: string, role: CoworkNativeRole, flavor: CoworkNativeFlavor, teamId: string | undefined): string[] {
  const dr = run("codesign", ["-d", "-r-", path]);
  const failures = checkSignedNative(role, teamId, {
    codesignDvv: run("codesign", ["-dvv", path]).stderr,
    codesignDr: `${dr.stdout}\n${dr.stderr}`,
    entitlementsXml: run("codesign", ["-d", "--entitlements", "-", "--xml", path]).stdout,
    otoolL: run("otool", ["-L", path]).stdout,
    executable: readFileSync(path),
  }, flavor);
  // An ad-hoc signature (no team) cannot satisfy a requirement that names a certificate's OU; only a team-signed member is verified against it.
  const strict = teamId === undefined ? { status: 0, stderr: "" } : run("codesign", ["--verify", "--strict", `-R=${coworkRequirement(coworkNativeIdentifier(role, flavor), teamId)}`, path]);
  if (strict.status !== 0) failures.push(`${COWORK_NATIVE[role].name} does not satisfy its own stated requirement: ${strict.stderr.trim()}`);
  return failures;
}
