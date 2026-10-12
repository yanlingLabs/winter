import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { processSatisfiesRequirement } from "../../computer-use/helper-verify";
import { GitReadError, type GitReadLimits } from "./read-types";
export type GitReadParseKind = "request" | "advertisement" | "response";
export interface GitReadParser {
  readonly admission: "native-confined";
  validate(kind: GitReadParseKind, bytes: Uint8Array, limits: GitReadLimits, signal?: AbortSignal): Promise<void>;
}
export interface GitReadParserConfiguration {
  /** Fixed protected signed bundle paths and requirements, supplied only by host packaging. */
  launcher: string; launcherRequirement: string; node: string; nodeRequirement: string;
  payload: string; payloadSha256: string; cwd: string;
  wallMs?: number; rssBytes?: number; sampleMs?: number; concurrent?: number;
}
const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
export function gitReadParserProfile(launcher: string, node: string, payload: string): string {
  launcher = realpathSync(launcher); node = realpathSync(node); payload = realpathSync(payload);
  return `(version 1)
(deny default)
(allow process-exec (literal "${quote(launcher)}") (literal "${quote(node)}"))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow process-info* (target self))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.bsd.dirhelper"))
(allow file-read-metadata)
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS/usr/lib") (literal "${quote(launcher)}") (literal "${quote(node)}"))
(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS/usr/lib") (literal "${quote(launcher)}") (literal "${quote(node)}") (literal "${quote(payload)}") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(deny file-write*)
(deny network*)
(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))`;
}
async function codeCheck(args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/codesign", ...args], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(); let output = "", size = 0;
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16_384) { child.kill(); throw new GitReadError("integration_unavailable"); } output += Buffer.from(part.value).toString(); }
      return output;
    };
    const [stdout, stderr, exit] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (exit !== 0) throw new GitReadError("integration_unavailable"); return stdout + stderr;
  } finally { clearTimeout(timer); }
}
function identity(path: string): string {
  const info = statSync(path); if (!info.isFile() || info.mode & 0o022) throw new GitReadError("integration_unavailable");
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
let readRss: ((pid: number) => number | undefined) | undefined;
function rss(pid: number): number | undefined {
  readRss ??= (() => {
    const lib = dlopen("/usr/lib/libproc.dylib", { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
    return (pid: number) => { const info = Buffer.alloc(96); return lib.symbols.proc_pidinfo(pid, 4, 0n, info, info.length) === info.length ? Number(info.readBigUInt64LE(8)) : undefined; };
  })();
  return readRss(pid);
}
/** One-shot stdio parser in an actually inspected signed/runtime Seatbelt launch.
 * RSS termination is reactive, not a hard reservation. Capacity stays held until owned exit. */
export class ConfinedGitReadParser implements GitReadParser {
  readonly admission = "native-confined" as const;
  private active = 0;
  private readonly identities: string[];
  readonly measurements = { peakObservedRssBytes: 0, memoryStops: 0, wallStops: 0, uncertainStops: 0 };
  private constructor(private readonly config: Required<GitReadParserConfiguration>) { this.identities = [config.launcher, config.node, config.payload].map(identity); }
  static async admit(config: GitReadParserConfiguration): Promise<ConfinedGitReadParser> {
    if (process.platform !== "darwin" || !config.launcherRequirement || !config.nodeRequirement || !/^[a-f0-9]{64}$/.test(config.payloadSha256)) throw new GitReadError("integration_unavailable");
    const owned = { ...config, wallMs: config.wallMs ?? 5_000, rssBytes: config.rssBytes ?? 268_435_456, sampleMs: config.sampleMs ?? 20, concurrent: config.concurrent ?? 4 };
    if (![owned.wallMs, owned.rssBytes, owned.sampleMs, owned.concurrent].every(n => Number.isSafeInteger(n) && n > 0)
      || owned.wallMs > 10_000 || owned.rssBytes > 536_870_912 || owned.sampleMs > 100 || owned.concurrent > 4) throw new GitReadError("invalid_request");
    for (const key of ["launcher", "node", "payload", "cwd"] as const) { if (!isAbsolute(owned[key])) throw new GitReadError("integration_unavailable"); owned[key] = realpathSync(owned[key]); }
    if (!statSync(owned.cwd).isDirectory() || statSync(owned.payload).size > 1_048_576 || createHash("sha256").update(readFileSync(owned.payload)).digest("hex") !== owned.payloadSha256) throw new GitReadError("integration_unavailable");
    const before = [owned.launcher, owned.node, owned.payload].map(identity);
    for (const [path, requirement] of [[owned.launcher, owned.launcherRequirement], [owned.node, owned.nodeRequirement]] as const) {
      identity(path); await codeCheck(["--verify", "--strict", "--all-architectures", "-R", `=${requirement}`, path]);
      const metadata = await codeCheck(["--display", "--verbose=4", "--entitlements", ":-", path]);
      const flags = /flags=0x([0-9a-f]+)/i.exec(metadata);
      if (!flags || !(parseInt(flags[1]!, 16) & 0x10000) || /com\.apple\.security\.(cs\.(allow-jit|allow-unsigned-executable-memory|disable-library-validation|allow-dyld-environment-variables)|get-task-allow)/.test(metadata)) throw new GitReadError("integration_unavailable");
    }
    if ([owned.launcher, owned.node, owned.payload].some((path, i) => identity(path) !== before[i])) throw new GitReadError("integration_unavailable");
    return new ConfinedGitReadParser(owned);
  }
  async validate(kind: GitReadParseKind, input: Uint8Array, limits: GitReadLimits, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new GitReadError("cancelled");
    const maximum = kind === "response" ? limits.responseBytes : kind === "advertisement" ? limits.advertisementBytes : limits.requestBytes;
    if (!(input instanceof Uint8Array) || !input.length || input.length > maximum || input.length > 67_108_864 || limits.objects > 10_000 || limits.expandedObjectBytes > 67_108_864) throw new GitReadError("budget_exceeded");
    if (this.active >= this.config.concurrent) throw new GitReadError("busy");
    if ([this.config.launcher, this.config.node, this.config.payload].some((path, i) => identity(path) !== this.identities[i])) throw new GitReadError("integration_unavailable");
    const bytes = Buffer.from(input); // Owned immutable copy, even when input is Buffer.
    const expectedDigest = createHash("sha256").update(bytes).digest();
    const header = Buffer.alloc(20); header.write("WGP1"); header[4] = ({ request: 1, advertisement: 2, response: 3 } as const)[kind]; header.writeUInt32BE(bytes.length, 8); header.writeUInt32BE(limits.objects, 12); header.writeUInt32BE(limits.expandedObjectBytes, 16);
    this.active++;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", gitReadParserProfile(this.config.launcher, this.config.node, this.config.payload), this.config.launcher, this.config.node, this.config.payload], { cwd: this.config.cwd, detached: true, env: { PATH: "/usr/bin:/bin", HOME: this.config.cwd, LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = Buffer.alloc(0), stderrBytes = 0, sent = false, exited = false, settled = false, failure: GitReadError | undefined;
      const finish = () => {
        if (settled) return; settled = true;
        clearTimeout(wall); clearTimeout(killTimer); clearInterval(monitor); signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (output.length !== 45 || output.subarray(0, 5).toString() !== "WGH1\n" || output.subarray(5, 9).toString() !== "WGR1" || !output.subarray(13).equals(expectedDigest)) reject(new GitReadError("invalid_response"));
        else { const status = output.readUInt32BE(9); if (!status) resolve(); else reject(new GitReadError(({ 1: "invalid_request", 2: "invalid_response", 3: "budget_exceeded" } as const)[status as 1 | 2 | 3] ?? "invalid_response")); }
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (code: GitReadError["code"]) => {
        failure ??= new GitReadError(code);
        if (child.pid && !exited) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Exit event still owns capacity release. */ } }
        killTimer ??= setTimeout(() => { if (!exited) this.measurements.uncertainStops++; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(); }, 1_000);
      };
      const abort = () => stop("cancelled"); signal?.addEventListener("abort", abort, { once: true });
      const wall = setTimeout(() => { this.measurements.wallStops++; stop("budget_exceeded"); }, this.config.wallMs);
      const monitor = setInterval(() => {
        if (!child.pid || exited) return;
        try { const used = rss(child.pid); if (used === undefined) { try { process.kill(child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; } stop("integration_unavailable"); return; } this.measurements.peakObservedRssBytes = Math.max(this.measurements.peakObservedRssBytes, used); if (used > this.config.rssBytes) { this.measurements.memoryStops++; stop("budget_exceeded"); } }
        catch { stop("integration_unavailable"); }
      }, this.config.sampleMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 45) { stop("invalid_response"); return; }
        output = Buffer.concat([output, chunk]);
        if (!sent && output.length >= 5) {
          if (output.subarray(0, 5).toString() !== "WGH1\n" || !child.pid || !processSatisfiesRequirement(child.pid, this.config.nodeRequirement)) { stop("integration_unavailable"); return; }
          try { const used = rss(child.pid); if (used === undefined) { stop("integration_unavailable"); return; } this.measurements.peakObservedRssBytes = Math.max(this.measurements.peakObservedRssBytes, used); if (used > this.config.rssBytes) { this.measurements.memoryStops++; stop("budget_exceeded"); return; } } catch { stop("integration_unavailable"); return; }
          sent = true; child.stdin.write(header); child.stdin.end(bytes);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4_096) stop("invalid_response"); });
      child.stdin.on("error", () => stop("invalid_response"));
      child.once("error", () => { if (!child.pid) { exited = true; this.active--; } stop("integration_unavailable"); finish(); });
      child.once("exit", code => { exited = true; this.active--; if (code !== 0) failure ??= new GitReadError(code === 77 ? "integration_unavailable" : "budget_exceeded"); });
      child.once("close", () => finish());
      if (signal?.aborted) abort();
    });
  }
}
