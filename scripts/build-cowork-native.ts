/**
 * Build the Cowork native pair's UNSIGNED binaries into one directory (default `dist/cowork-native/`), where `embed-cowork-native.sh` and
 * `release.ts` read them.
 *
 *   bun run scripts/build-cowork-native.ts --libkrun-include <dir> --libkrun-archive <file> [--out <dir>] [--launcher-only]
 *
 * The launcher is `swift build` (release, no debug info, no linker symbols, so the builder's paths are not in it) into a scratch path. The worker is
 * `apple/Cowork/WinterCoworkHVFWorker/build.py worker`, which refuses unless the archive and header hash to the worker pins file's values. The libkrun
 * archive is S4's stripped production archive and header; this script never builds, downloads or fetches them (`COWORK_LIBKRUN_INCLUDE` and
 * `COWORK_LIBKRUN_ARCHIVE` are the environment spelling). Nothing it builds is run, signed or launched here.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COWORK_LAUNCHER_PACKAGE, COWORK_NATIVE, launcherBuildArgs } from "./cowork-native-lib";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_BUILD_SCRIPT = join("apple", "Cowork", "WinterCoworkHVFWorker", "build.py");

/** `python3 -I build.py worker --out <dir outside the repository> --libkrun-include … --libkrun-archive …` */
export function workerBuildArgs(i: { out: string; include: string; archive: string }): string[] {
  return ["-I", join(REPO, WORKER_BUILD_SCRIPT), "worker", "--out", i.out, "--libkrun-include", i.include, "--libkrun-archive", i.archive];
}

function fail(message: string): never {
  console.error(`build-cowork-native: ${message}`);
  process.exit(1);
}
function run(command: string, args: string[], label: string): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

export function buildCoworkNative(options: { out: string; include?: string; archive?: string; launcherOnly?: boolean; scratchRoot?: string }): { launcher: string; worker?: string } {
  const out = resolve(options.out);
  const scratch = options.scratchRoot ?? mkdtempSync(join(tmpdir(), "cowork-native-build-"));
  try {
    const packagePath = join(REPO, COWORK_LAUNCHER_PACKAGE), scratchPath = join(scratch, "launcher");
    run("swift", launcherBuildArgs({ packagePath, scratchPath }), "swift build of the launcher");
    const binDir = run("swift", ["build", "--package-path", packagePath, "--scratch-path", scratchPath, "-c", "release", "--show-bin-path"], "swift build --show-bin-path").trim();
    const launcherBuilt = join(binDir, COWORK_NATIVE.launcher.name);
    if (!existsSync(launcherBuilt)) fail(`the launcher was not produced at ${launcherBuilt}`);
    mkdirSync(out, { recursive: true });
    const result: { launcher: string; worker?: string } = { launcher: join(out, COWORK_NATIVE.launcher.name) };
    copyFileSync(launcherBuilt, result.launcher);
    if (options.launcherOnly !== true) {
      if (!options.include || !options.archive) fail("the worker needs --libkrun-include and --libkrun-archive (S4's header directory and stripped production archive); pass --launcher-only to build just the launcher");
      if (!existsSync(join(options.include, "libkrun.h")) || !existsSync(options.archive)) fail("--libkrun-include/libkrun.h or --libkrun-archive does not exist");
      const workerOut = join(scratch, "worker");
      run("python3", workerBuildArgs({ out: workerOut, include: resolve(options.include), archive: resolve(options.archive) }), "build.py worker");
      const workerBuilt = join(workerOut, "worker", COWORK_NATIVE.worker.name);
      if (!existsSync(workerBuilt)) fail(`the worker was not produced at ${workerBuilt}`);
      result.worker = join(out, COWORK_NATIVE.worker.name);
      copyFileSync(workerBuilt, result.worker);
    }
    return result;
  } finally {
    if (options.scratchRoot === undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const built = buildCoworkNative({
    out: value("--out") ?? join(REPO, "dist", "cowork-native"),
    include: value("--libkrun-include") ?? process.env.COWORK_LIBKRUN_INCLUDE,
    archive: value("--libkrun-archive") ?? process.env.COWORK_LIBKRUN_ARCHIVE,
    launcherOnly: args.includes("--launcher-only"),
  });
  console.log(`built: ${built.launcher}${built.worker ? `, ${built.worker}` : ""}`);
}
