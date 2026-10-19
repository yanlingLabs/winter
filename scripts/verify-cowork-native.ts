/**
 * `bun run verify:cowork-native` — the compiled-artifact gate for the Cowork native pair's packaging. It assembles a SCRATCH bundle (a temp directory shaped like
 * `Winter.app/Contents`), runs the real build-phase script `embed-cowork-native.sh` into it with an ad-hoc identity, and proves:
 *
 *   1. the embed produced exactly the pair and the pin manifest, and `checkSignedNative` (identifier, hardened runtime, the stated designated requirement, the
 *      entitlements, platform dylibs only, no test hook) and `checkCoworkNativeBundle` (the manifest's CDHashes and pins against this checkout) accept it;
 *   2. the gate REFUSES each of: a binary swapped after embedding, a changed pin in the manifest, an extra file in the directory, a missing manifest, a wrong
 *      identifier, a worker carrying a second entitlement, and a test hook in a binary.
 *
 *   bun run verify:cowork-native [--launcher <file>] [--worker <file>] [--libkrun-include <dir> --libkrun-archive <file>]
 *
 * With no arguments it builds the REAL launcher (swift build, scratch path) and uses a stand-in worker (a copy of /usr/bin/true) because this repository does not
 * build S4's libkrun archive; with the libkrun inputs it also builds the real worker. It never runs either binary, never signs with a real identity, never touches the
 * Keychain, the notary, /Applications or any running Winter, and removes its scratch directory. The Developer ID team, the secure timestamp and notarization are
 * checked by release.ts on the real bundle, not here.
 */
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCoworkNative } from "./build-cowork-native";
import { COWORK_NATIVE, COWORK_NATIVE_EMBED_RELATIVE, COWORK_NATIVE_TEAM, COWORK_TEST_HOOK_MARKER, checkCoworkNativeBundle, readCoworkBundleFacts } from "./cowork-native-lib";
import { REPO_ROOT, WORKER_ENTITLEMENTS, inspectNative, run, signNative } from "./cowork-native-tools";

export interface VerifyResult { failures: string[]; lines: string[] }

function embed(inputs: { launcher: string; worker: string; entitlements?: string }, builtProducts: string): { ok: boolean; output: string } {
  const result = spawnSync("bash", [join(REPO_ROOT, "scripts", "embed-cowork-native.sh")], {
    encoding: "utf8", timeout: 180_000,
    env: { ...process.env, CONFIGURATION: "Release", BUILT_PRODUCTS_DIR: builtProducts, CONTENTS_FOLDER_PATH: "Winter.app/Contents", EXPANDED_CODE_SIGN_IDENTITY: "-", DEVELOPMENT_TEAM: COWORK_NATIVE_TEAM,
      COWORK_LAUNCHER_BINARY: inputs.launcher, COWORK_WORKER_BINARY: inputs.worker, COWORK_WORKER_ENTITLEMENTS: inputs.entitlements ?? WORKER_ENTITLEMENTS },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function bundleFailures(contents: string): string[] {
  return checkCoworkNativeBundle(readCoworkBundleFacts({
    appContents: contents, repo: REPO_ROOT,
    listDirectory: (path) => (existsSync(path) ? readdirSync(path) : []),
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    codesignDvvv: (path) => { const r = run("codesign", ["-dvvv", path]); return `${r.stdout}\n${r.stderr}`; },
  }));
}
function memberFailures(contents: string): string[] {
  const dir = join(contents, "Helpers", "WinterCowork");
  return (["launcher", "worker"] as const).flatMap((role) => { const path = join(dir, COWORK_NATIVE[role].name); return existsSync(path) ? inspectNative(path, role, "dist", undefined) : [`${COWORK_NATIVE[role].name} is missing`]; });
}

/** Copies the good bundle, applies `mutate`, and returns the failures the gate reports (a good gate reports at least one). */
function refusal(good: string, scratch: string, name: string, mutate: (contents: string) => void): { name: string; failures: string[] } {
  const copy = join(scratch, `mutant-${name.replace(/\W+/g, "-")}`);
  cpSync(good, copy, { recursive: true });
  const contents = join(copy, "Winter.app", "Contents");
  mutate(contents);
  return { name, failures: [...memberFailures(contents), ...bundleFailures(contents)] };
}

export function verifyCoworkNative(input: { launcher: string; worker: string; scratchRoot?: string }): VerifyResult {
  const scratch = input.scratchRoot ?? mkdtempSync(join(tmpdir(), "verify-cowork-native-"));
  const failures: string[] = [], lines: string[] = [];
  try {
    const good = join(scratch, "good");
    const embedded = embed(input, good);
    if (!embedded.ok) return { failures: [`the embed phase failed:\n${embedded.output.trim()}`], lines };
    const contents = join(good, "Winter.app", "Contents");
    failures.push(...memberFailures(contents), ...bundleFailures(contents));
    lines.push(failures.length === 0 ? "good bundle: both members and the pin manifest accepted" : "good bundle: REFUSED (see failures)");
    if (failures.length > 0) return { failures, lines };

    const dir = (c: string) => join(c, "Helpers", "WinterCowork");
    const mutants: { name: string; failures: string[] }[] = [
      refusal(good, scratch, "a binary swapped after embedding", (c) => { // a different program, re-signed the same way: valid signature, different CDHash
        const worker = join(dir(c), COWORK_NATIVE.worker.name);
        copyFileSync("/bin/echo", worker); signNative(worker, "worker", "dist", { identity: "-", timestamp: false });
      }),
      refusal(good, scratch, "a changed pin in the manifest", (c) => { const m = join(c, "Resources", "cowork-native-pins.json"); writeFileSync(m, readFileSync(m, "utf8").replace(/"libkrunArchiveSha256": "[0-9a-f]/, (x) => x.slice(0, -1) + (x.endsWith("0") ? "1" : "0"))); }),
      refusal(good, scratch, "an extra file next to the pair", (c) => writeFileSync(join(dir(c), "extra"), "x")),
      refusal(good, scratch, "a missing manifest", (c) => rmSync(join(c, "Resources", "cowork-native-pins.json"))),
      refusal(good, scratch, "a wrong launcher identifier", (c) => { const l = join(dir(c), COWORK_NATIVE.launcher.name); run("codesign", ["--force", "--sign", "-", "--identifier", "com.example.not-the-launcher", "--options", "runtime", l]); }),
      refusal(good, scratch, "a worker with a second entitlement", (c) => {
        const ents = join(scratch, "extra.entitlements");
        writeFileSync(ents, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
        signNative(join(dir(c), COWORK_NATIVE.worker.name), "worker", "dist", { identity: "-", timestamp: false, entitlementsFile: ents });
      }),
      refusal(good, scratch, "a test hook in a binary", (c) => { const l = join(dir(c), COWORK_NATIVE.launcher.name); appendFileSync(l, `${COWORK_TEST_HOOK_MARKER}PIN`); signNative(l, "launcher", "dist", { identity: "-", timestamp: false }); }),
    ];
    for (const mutant of mutants) {
      if (mutant.failures.length === 0) failures.push(`the gate ACCEPTED ${mutant.name}`);
      lines.push(`${mutant.failures.length > 0 ? "refused" : "ACCEPTED"}: ${mutant.name}${mutant.failures.length > 0 ? ` (${mutant.failures[0]!.slice(0, 110)})` : ""}`);
    }
    return { failures, lines };
  } finally {
    if (input.scratchRoot === undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.platform !== "darwin") { console.error("verify:cowork-native: macOS only"); process.exit(1); }
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const scratch = mkdtempSync(join(tmpdir(), "verify-cowork-native-in-"));
  try {
    let launcher = valueOf("--launcher"), worker = valueOf("--worker");
    if (launcher === undefined || worker === undefined) {
      const include = valueOf("--libkrun-include") ?? process.env.COWORK_LIBKRUN_INCLUDE, archive = valueOf("--libkrun-archive") ?? process.env.COWORK_LIBKRUN_ARCHIVE;
      const built = buildCoworkNative({ out: join(scratch, "built"), include, archive, launcherOnly: !(include && archive) });
      launcher = launcher ?? built.launcher;
      if (worker === undefined) {
        if (built.worker !== undefined) worker = built.worker;
        else { worker = join(scratch, "stand-in-worker"); copyFileSync("/usr/bin/true", worker); console.error("verify:cowork-native: no libkrun inputs, so the worker is a STAND-IN (a copy of /usr/bin/true); the launcher is the real build"); }
      }
    }
    const result = verifyCoworkNative({ launcher: resolve(launcher), worker: resolve(worker) });
    for (const line of result.lines) console.error(`verify:cowork-native: ${line}`);
    if (result.failures.length > 0) { console.error(`verify:cowork-native: FAILED\n  ${result.failures.join("\n  ")}`); process.exit(1); }
    console.error("verify:cowork-native: ok");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
