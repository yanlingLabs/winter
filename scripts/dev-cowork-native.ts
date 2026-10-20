/**
 * Stage and sign the DEV Cowork native pair for the dev daemon. The dev daemon is `dist/dev/winter-core`; the environment looks for the pair at
 * `<dirname(executable)>/../Helpers/WinterCowork`, so the default target is `dist/Helpers/WinterCowork/` (the app's `Contents/Helpers/WinterCowork` seen from
 * `Contents/Resources/winter-core`, with `dist` standing in for `Contents`).
 *
 *   bun run dev:cowork-native                         sign the pair staged in dist/cowork-native with the dev identity (WINTER_DEV_SIGN_IDENTITY overrides)
 *   bun run dev:cowork-native --build --libkrun-include <dir> --libkrun-archive <file>
 *                                                     build the unsigned pair first (scripts/build-cowork-native.ts), then sign
 *   bun run dev:cowork-native --identity - --out <dir> [--launcher <f> --worker <f>]
 *                                                     ad-hoc, into a scratch directory: a proof build. It touches nothing else.
 *
 * The launcher is signed as `com.winter.cowork.launcher.dev` (the launcher reads which daemon it serves from its OWN signing identifier, so no argument can
 * switch it), the worker as `com.winter.cowork.worker` with the hypervisor entitlement only, each with its STATED designated requirement, the hardened runtime
 * and no secure timestamp (a dev build needs no network). Checks are `checkSignedNative`'s. NOTHING IN THIS SCRIPT RUNS EITHER BINARY, and it never launches an app,
 * touches the user's daemon or the dist home. The feature is still OFF in the daemon (the activation seam answers undefined).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WINTER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { buildCoworkNative } from "./build-cowork-native";
import { COWORK_NATIVE, coworkRequirement } from "./cowork-native-lib";
import { inspectNative, REPO_ROOT, run, signNative } from "./cowork-native-tools";
import { resolveDevSigningIdentity } from "./dev-daemon-lib";

export const DEV_PAIR_DIR = join(REPO_ROOT, "dist", "Helpers", "WinterCowork");

function die(message: string): never {
  console.error(`dev:cowork-native: ${message}`);
  process.exit(1);
}

/** Copies the two inputs into a sibling temp directory, signs and inspects them there, then swaps the directory in. Returns failure lines (the target is untouched then). */
export function stageDevPair(input: { launcher: string; worker: string; target: string; identity: string; teamId: string | undefined }): string[] {
  mkdirSync(dirname(input.target), { recursive: true });
  const tmp = mkdtempSync(join(dirname(input.target), ".WinterCowork-"));
  const failures: string[] = [];
  try {
    const launcher = join(tmp, COWORK_NATIVE.launcher.name), worker = join(tmp, COWORK_NATIVE.worker.name);
    copyFileSync(input.worker, worker); copyFileSync(input.launcher, launcher);
    // Nested code first, each with its own identity, never --deep.
    failures.push(...signNative(worker, "worker", "dev", { identity: input.identity, teamId: input.teamId, timestamp: false }));
    failures.push(...signNative(launcher, "launcher", "dev", { identity: input.identity, teamId: input.teamId, timestamp: false }));
    if (failures.length === 0) {
      failures.push(...inspectNative(worker, "worker", "dev", input.teamId), ...inspectNative(launcher, "launcher", "dev", input.teamId));
    }
    if (failures.length === 0) {
      const old = `${input.target}.old-${process.pid}`;
      if (existsSync(input.target)) renameSync(input.target, old);
      renameSync(tmp, input.target);
      rmSync(old, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return failures;
}

function main(): void {
  if (process.platform !== "darwin") die("macOS only");
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`${flag} needs a value`);
    return v;
  };
  const known = new Set(["--build", "--out", "--launcher", "--worker", "--identity", "--libkrun-include", "--libkrun-archive"]);
  const values = new Set(["--out", "--launcher", "--worker", "--identity", "--libkrun-include", "--libkrun-archive"].map(valueOf).filter((v): v is string => v !== undefined));
  const unknown = argv.filter((a) => !known.has(a) && !values.has(a));
  if (unknown.length > 0) die(`unknown argument ${unknown[0]}`);

  let launcher = valueOf("--launcher") ?? join(REPO_ROOT, "dist", "cowork-native", COWORK_NATIVE.launcher.name);
  let worker = valueOf("--worker") ?? join(REPO_ROOT, "dist", "cowork-native", COWORK_NATIVE.worker.name);
  if (argv.includes("--build")) {
    const built = buildCoworkNative({ out: join(REPO_ROOT, "dist", "cowork-native"), include: valueOf("--libkrun-include") ?? process.env.COWORK_LIBKRUN_INCLUDE, archive: valueOf("--libkrun-archive") ?? process.env.COWORK_LIBKRUN_ARCHIVE });
    launcher = built.launcher; worker = built.worker!;
  }
  for (const input of [launcher, worker]) if (!existsSync(input)) die(`${input} does not exist — pass --build with the libkrun inputs, or --launcher/--worker`);

  const identityFlag = valueOf("--identity");
  const adHoc = identityFlag === "-";
  const identity = adHoc ? "-" : identityFlag ?? resolveDevSigningIdentity({
    identitiesOutput: run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout, teamId: WINTER_TEAM_ID, override: process.env.WINTER_DEV_SIGN_IDENTITY,
    subjectOf: (name) => { const pem = run("security", ["find-certificate", "-c", name, "-p"]).stdout; if (pem === "") return undefined; const r = Bun.spawnSync(["openssl", "x509", "-noout", "-subject"], { stdin: new TextEncoder().encode(pem) }); return r.exitCode === 0 ? r.stdout.toString() : undefined; },
  }).hash;
  // An ad-hoc signature carries no team, so it is only ever allowed into an explicit scratch directory (--out), never the dev daemon's own pair directory.
  if (adHoc && valueOf("--out") === undefined) die("--identity - (ad hoc) needs --out <scratch dir>: the dev daemon's pair must be signed with the team identity");
  const target = valueOf("--out") === undefined ? DEV_PAIR_DIR : resolve(valueOf("--out")!);
  const failures = stageDevPair({ launcher, worker, target, identity, teamId: adHoc ? undefined : WINTER_TEAM_ID });
  if (failures.length > 0) die(`the signed pair is not what the daemon needs:\n  ${failures.join("\n  ")}`);
  console.error(`dev:cowork-native: ${target} — ${COWORK_NATIVE.launcher.devIdentifier} (no entitlements) and ${COWORK_NATIVE.worker.identifier} (the hypervisor entitlement only), designated => ${coworkRequirement(COWORK_NATIVE.launcher.devIdentifier, adHoc ? undefined : WINTER_TEAM_ID)}${adHoc ? " (ad hoc: scratch proof only)" : ""}. Nothing was run.`);
}

if (import.meta.main) main();
