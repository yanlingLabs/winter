import { createReadStream, mkdirSync, existsSync, copyFileSync, mkdtempSync, statfsSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import pins from "./pins.json";
import { DEFAULT_KERNEL_PROFILE, getKernelProfile, type KernelProfileID } from "./kernel/profiles";

export const root = import.meta.dir;
export const out = join(root, "out");
export async function checked(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: "inherit" });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}
export async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(url: string, path: string, expected: string) {
  if (!existsSync(path)) {
    console.log(`Downloading pinned public asset: ${url}`);
    const partial = `${path}.${randomUUID()}.part`;
    try {
      await checked("/usr/bin/curl", ["-fL", "--retry", "2", "--output", partial, url]);
      if (await sha256(partial) !== expected) throw new Error(`checksum mismatch; refusing asset ${path}`);
      renameSync(partial, path);
    } finally { rmSync(partial, { force: true }); }
  }
  if (await sha256(path) !== expected) throw new Error(`checksum mismatch; refusing asset ${path}`);
}
async function extract(archive: string, member: string, path: string, expected: string) {
  if (!existsSync(path)) {
    const partial = `${path}.${randomUUID()}.part`;
    try {
      const proc = Bun.spawn(["/usr/bin/tar", "-xOf", archive, member], { stdout: Bun.file(partial), stderr: "inherit" });
      if (await proc.exited !== 0 || await sha256(partial) !== expected) throw new Error("kernel member extraction/digest verification failed");
      renameSync(partial, path);
    } finally { rmSync(partial, { force: true }); }
  }
  if (await sha256(path) !== expected) throw new Error("kernel member digest mismatch");
}

export async function build(options: { kernelProfile?: KernelProfileID } = {}) {
  const kernelProfileID = options.kernelProfile ?? DEFAULT_KERNEL_PROFILE;
  const kernelProfile = getKernelProfile(kernelProfileID);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS Apple Silicon required");
  const space = statfsSync(root);
  if (space.bavail * space.bsize < 4 * 1024 ** 3) throw new Error("less than 4 GiB available for probe build");
  mkdirSync(join(out, "tools"), { recursive: true }); mkdirSync(join(out, "assets"), { recursive: true });
  await download(pins.zig.url, join(out, "tools/zig.tar.xz"), pins.zig.sha256);
  const zig = join(out, "tools", pins.zig.directory, "zig");
  if (!existsSync(zig)) await checked("/usr/bin/tar", ["-xf", join(out, "tools/zig.tar.xz"), "-C", join(out, "tools")]);
  const archive = join(out, "assets", kernelProfile.archiveName);
  await download(kernelProfile.url, archive, kernelProfile.archiveSha256);
  const kernelPath = join(out, "assets", kernelProfileID === DEFAULT_KERNEL_PROFILE ? "vmlinux" : `vmlinux-${kernelProfileID}`);
  const kernelConfigPath = join(out, "assets", `config-${kernelProfileID}`);
  await extract(archive, kernelProfile.member, kernelPath, kernelProfile.binarySha256);
  await extract(archive, kernelProfile.configMember, kernelConfigPath, kernelProfile.configSha256);
  const buildRoot = mkdtempSync(join(out, "build-"));
  const helpers: Record<string, string> = {};
  for (const name of ["confine", "memprobe", "page-groups"]) await checked(zig, ["cc", "-target", "aarch64-linux-musl", "-O2", "-Wall", "-Wextra", "-Werror", "-static", join(root, name === "page-groups" ? "kernel" : "guest", `${name}.c`), "-o", helpers[name] = join(buildRoot, name)]);
  await checked("/usr/bin/xcrun", ["swift", "build", "--package-path", join(root, "native"), "--jobs", "4"]);
  const library = join(buildRoot, "libWinterCoworkVM.dylib"), binary = join(buildRoot, "winter-cowork-probe");
  copyFileSync(join(root, "native/.build/debug/libWinterCoworkVM.dylib"), library);
  await checked(process.execPath, ["build", "--compile", "--target=bun-darwin-arm64", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary, join(root, "probe.ts")]);
  await checked("/usr/bin/codesign", ["--force", "--sign", "-", library]);
  await checked("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", join(root, "probe.entitlements"), binary]);
  console.log(JSON.stringify({ built: { binary, library }, signing: "ad-hoc fixture only" }));
  return { binary, library, helpers, kernelPath, kernelConfigPath, kernelProfileID, kernelProfile };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) await build();
  else if (args.length === 2 && args[0] === "--kernel-profile") {
    getKernelProfile(args[1]!);
    await build({ kernelProfile: args[1] as KernelProfileID });
  } else throw new Error("Usage: build.ts [--kernel-profile kata-6.12.28|apple-6.18.35]");
}
