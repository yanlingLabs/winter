import { createReadStream, mkdirSync, existsSync, copyFileSync, mkdtempSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import pins from "./pins.json";

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
    await checked("/usr/bin/curl", ["-fL", "--retry", "2", "--output", path, url]);
  }
  if (await sha256(path) !== expected) throw new Error(`checksum mismatch; refusing asset ${path}`);
}
export async function build() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("macOS Apple Silicon required");
  const space = statfsSync(root);
  if (space.bavail * space.bsize < 4 * 1024 ** 3) throw new Error("less than 4 GiB available for probe build");
  mkdirSync(join(out, "tools"), { recursive: true }); mkdirSync(join(out, "assets"), { recursive: true });
  await download(pins.zig.url, join(out, "tools/zig.tar.xz"), pins.zig.sha256);
  const zig = join(out, "tools", pins.zig.directory, "zig");
  if (!existsSync(zig)) await checked("/usr/bin/tar", ["-xf", join(out, "tools/zig.tar.xz"), "-C", join(out, "tools")]);
  const archive = join(out, "assets/kata-static-3.17.0-arm64.tar.xz");
  await download(pins.kernelArchive.url, archive, pins.kernelArchive.sha256);
  if (!existsSync(join(out, "assets/vmlinux"))) {
    const proc = Bun.spawn(["/usr/bin/tar", "-xOf", archive, pins.kernelArchive.member], { stdout: Bun.file(join(out, "assets/vmlinux")), stderr: "inherit" });
    if (await proc.exited !== 0) throw new Error("kernel extraction failed");
  }
  if (await sha256(join(out, "assets/vmlinux")) !== "67bac9f416af4cdc9b151e4ba4962d6515e0ad7acc53816761cf964aa6af6ea0") throw new Error("kernel digest mismatch");
  const buildRoot = mkdtempSync(join(out, "build-"));
  const helpers: Record<string, string> = {};
  for (const name of ["confine", "memprobe"]) await checked(zig, ["cc", "-target", "aarch64-linux-musl", "-O2", "-Wall", "-Wextra", "-Werror", "-static", join(root, "guest", `${name}.c`), "-o", helpers[name] = join(buildRoot, name)]);
  await checked("/usr/bin/xcrun", ["swift", "build", "--package-path", join(root, "native"), "--jobs", "4"]);
  const library = join(buildRoot, "libWinterCoworkVM.dylib"), binary = join(buildRoot, "winter-cowork-probe");
  copyFileSync(join(root, "native/.build/debug/libWinterCoworkVM.dylib"), library);
  await checked(process.execPath, ["build", "--compile", "--target=bun-darwin-arm64", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary, join(root, "probe.ts")]);
  await checked("/usr/bin/codesign", ["--force", "--sign", "-", library]);
  await checked("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", join(root, "probe.entitlements"), binary]);
  console.log(JSON.stringify({ built: { binary, library }, signing: "ad-hoc fixture only" }));
  return { binary, library, helpers };
}
if (import.meta.main) await build();
