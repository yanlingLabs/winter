import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HostCodeOutputTransportFactory } from "./host-code-broker";

export const HOST_OUTPUT_PROTOCOL_VERSION = 1;
export const HOST_OUTPUT_IMPLEMENTATION_ID = "winter-host-output/v1";
export const HOST_OUTPUT_BUNDLE_SUBPATH = "native/host-output";
const ARTIFACT = "winter-host-output.node";
const TEAM = "37N77U9RSZ";
const SHA = /^[a-f0-9]{64}$/;
// Retain the handles, not just FD integers: FileHandle's GC must not release a
// dyld name or an image containing registered process-lifetime atfork callbacks.
const pinnedMappings: FileHandle[] = [];
let bundled: HostCodeOutputTransportFactory | undefined;

export class HostOutputUnavailable extends Error {
  constructor(readonly reason: string, readonly retryable = false) {
    super(`Host output unavailable: ${reason}`);
    this.name = "HostOutputUnavailable";
  }
}
interface Manifest {
  schema: 1;
  protocolVersion: 1;
  implementationId: typeof HOST_OUTPUT_IMPLEMENTATION_ID;
  sourceSha256: string;
  artifactSha256: string;
  artifact: typeof ARTIFACT;
  platform: "darwin";
  architecture: "arm64";
  minimumMacOS: "26.0";
}
interface Addon {
  protocolVersion: number;
  implementationId: string;
  sourceSha256: string;
  createOutputTransport: HostCodeOutputTransportFactory;
}
type SignatureVerifier = (app: string, core: string, addon: string) => boolean | Promise<boolean>;
const reasons = new Set([
  "manifest-size", "manifest-json", "manifest-identity", "artifact-protection", "artifact-truncated",
  "artifact-changed", "artifact-alias", "artifact-digest", "artifact-access", "bundle-layout", "signature",
  "core-hardening", "mapping-limit", "addon-identity", "addon-load", "codesign-timeout", "codesign-spawn",
  "codesign-exit", "codesign-output-limit", "loader-transient",
]);
function failure(error: unknown): HostOutputUnavailable {
  if (error instanceof HostOutputUnavailable && reasons.has(error.reason)) return error;
  const code = (error as { code?: string } | null)?.code;
  if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
    return new HostOutputUnavailable("artifact-access");
  }
  return new HostOutputUnavailable("loader-transient", true);
}
function manifest(bytes: Buffer): Manifest {
  if (bytes.length > 4096) throw new HostOutputUnavailable("manifest-size");
  let value: Partial<Manifest> | null;
  try { value = JSON.parse(bytes.toString()); }
  catch { throw new HostOutputUnavailable("manifest-json"); }
  if (!value || value.schema !== 1 || value.protocolVersion !== 1 || value.implementationId !== HOST_OUTPUT_IMPLEMENTATION_ID ||
      value.artifact !== ARTIFACT || value.platform !== "darwin" || value.architecture !== "arm64" || value.minimumMacOS !== "26.0" ||
      typeof value.sourceSha256 !== "string" || !SHA.test(value.sourceSha256) ||
      typeof value.artifactSha256 !== "string" || !SHA.test(value.artifactSha256)) {
    throw new HostOutputUnavailable("manifest-identity");
  }
  return value as Manifest;
}
async function ordinary(path: string, directory: boolean): Promise<Stats> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o022) !== 0 ||
      (!directory && stat.nlink !== 1) || ![0, process.getuid?.()].includes(stat.uid)) {
    throw new HostOutputUnavailable("artifact-protection");
  }
  return stat;
}
function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.uid === after.uid && before.gid === after.gid && before.nlink === after.nlink &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function descriptorBytes(handle: FileHandle, limit: number): Promise<{ stat: Stats; bytes: Buffer }> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit || (stat.mode & 0o022) !== 0 ||
      ![0, process.getuid?.()].includes(stat.uid)) throw new HostOutputUnavailable("artifact-protection");
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new HostOutputUnavailable("artifact-truncated");
    offset += bytesRead;
  }
  if (!unchanged(stat, await handle.stat())) throw new HostOutputUnavailable("artifact-changed");
  return { stat, bytes };
}
function nativeAddon(fd: number): Addon {
  const module = { exports: {} } as NodeJS.Module;
  process.dlopen(module, `/dev/fd/${fd}`);
  return module.exports as Addon;
}
function codesign(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/codesign", args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      // CLI nonzero status does not reliably distinguish bad signatures from
      // transient tool/loader failures. Keep it fail-closed but retryable.
      const code = error.code;
      const reason = error.killed || code === "ETIMEDOUT" ? "codesign-timeout" :
        code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "codesign-output-limit" :
        typeof code === "number" ? "codesign-exit" : "codesign-spawn";
      reject(new HostOutputUnavailable(reason, true));
    });
  });
}
const signatures: SignatureVerifier = async (app, core, addon) => {
  const team = `anchor apple generic and certificate leaf[subject.OU] = "${TEAM}"`;
  const flags = await codesign(["-dv", core]);
  const entitlements = await codesign(["-d", "--entitlements", ":-", core]);
  if (!/flags=0x[0-9a-f]+\([^\n]*runtime/.test(flags.stderr) ||
      /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(entitlements.stdout) ||
      /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(entitlements.stdout)) {
    throw new HostOutputUnavailable("core-hardening");
  }
  const verify = (path: string, requirement: string) => codesign(["--verify", "--strict", "-R", requirement, path]);
  await verify(core, team);
  await verify(addon, `(${team}) and identifier "com.winter.host-output"`);
  // Last: seal-check the manifest/image tree pinned before verification.
  await verify(app, `(${team}) and (identifier "com.winter.app" or identifier "com.winter.app.dev")`);
  return true;
};
async function load(corePath: string, verify: SignatureVerifier, loadAddon: (fd: number) => Addon, retainMapping: boolean): Promise<HostCodeOutputTransportFactory> {
  const core = await realpath(corePath), resources = dirname(core), contents = dirname(resources), app = dirname(contents);
  if (basename(core) !== "winter-core" || basename(resources) !== "Resources" || basename(contents) !== "Contents" || !app.endsWith(".app")) {
    throw new HostOutputUnavailable("bundle-layout");
  }
  const root = join(resources, HOST_OUTPUT_BUNDLE_SUBPATH), path = join(root, ARTIFACT), record = join(root, "manifest.json");
  const entries = [];
  for (const entry of [
    ...[app, contents, resources, join(resources, "native"), root].map(path => ({ path, directory: true })),
    ...[core, path, record].map(path => ({ path, directory: false })),
  ]) entries.push({ ...entry, stat: await ordinary(entry.path, entry.directory) });
  if (await realpath(path) !== path || await realpath(record) !== record) throw new HostOutputUnavailable("artifact-alias");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let recordHandle: FileHandle | undefined;
  let mapped = false;
  try {
    recordHandle = await open(record, constants.O_RDONLY | constants.O_NOFOLLOW);
    const image = await descriptorBytes(handle, 5 * 1024 * 1024), recordImage = await descriptorBytes(recordHandle, 4096);
    const pinned = manifest(recordImage.bytes);
    if (createHash("sha256").update(image.bytes).digest("hex") !== pinned.artifactSha256) throw new HostOutputUnavailable("artifact-digest");
    if (!await verify(app, core, path)) throw new HostOutputUnavailable("signature");
    for (const entry of entries) {
      if (!unchanged(entry.stat, await ordinary(entry.path, entry.directory))) throw new HostOutputUnavailable("artifact-changed");
    }
    const checkedImage = await descriptorBytes(handle, 5 * 1024 * 1024), checkedRecord = await descriptorBytes(recordHandle, 4096);
    if (!unchanged(image.stat, checkedImage.stat) || !unchanged(recordImage.stat, checkedRecord.stat) ||
        !image.bytes.equals(checkedImage.bytes) || !recordImage.bytes.equals(checkedRecord.bytes) ||
        !unchanged(await ordinary(path, false), image.stat) || !unchanged(await ordinary(record, false), recordImage.stat)) {
      throw new HostOutputUnavailable("artifact-changed");
    }
    if (retainMapping && pinnedMappings.length >= 8) throw new HostOutputUnavailable("mapping-limit");
    mapped = true;
    let addon: Addon;
    try { addon = loadAddon(handle.fd); }
    catch { throw new HostOutputUnavailable("addon-load"); }
    if (!addon || typeof addon !== "object" || addon.protocolVersion !== 1 || addon.implementationId !== pinned.implementationId || addon.sourceSha256 !== pinned.sourceSha256 || typeof addon.createOutputTransport !== "function") {
      throw new HostOutputUnavailable("addon-identity");
    }
    return async () => addon.createOutputTransport();
  } finally {
    // Preserve the name even when initialization failed after mapping began.
    if (mapped && retainMapping) pinnedMappings.push(handle);
    else await handle.close();
    await recordHandle?.close();
  }
}
function lazy(resolve: () => Promise<HostCodeOutputTransportFactory>, log?: (line: string) => void, now = () => performance.now()): HostCodeOutputTransportFactory {
  let ready: HostCodeOutputTransportFactory | undefined;
  let pending: Promise<HostCodeOutputTransportFactory> | undefined;
  let refusal: HostOutputUnavailable | undefined;
  let attempts = 0, retryAfter = 0;
  const logged = new Set<string>();
  return async () => {
    if (ready) return ready();
    if (refusal && (!refusal.retryable || now() < retryAfter)) throw refusal;
    if (!pending) {
      attempts = Math.min(attempts + 1, 6);
      pending = Promise.resolve().then(resolve).then(factory => {
        ready = factory;
        return factory;
      }, error => {
        refusal = failure(error);
        const cooldown = Math.min(30_000, 1000 * 2 ** (attempts - 1));
        retryAfter = now() + cooldown;
        if (!logged.has(refusal.reason)) {
          logged.add(refusal.reason);
          try { log?.(`[host-output] refused: ${refusal.reason}${refusal.retryable ? `; retry cooldown ${cooldown}ms (capped at 30000ms)` : "; cached until restart"}`); }
          catch { /* Observability must not change admission or retry ownership. */ }
        }
        throw refusal;
      }).finally(() => { pending = undefined; });
    }
    const factory = await pending;
    // Transport allocation errors do not invalidate the authenticated mapping.
    return factory();
  };
}
/** Cheap construction only. Verification starts on first protected output use.
 * Source Bun and standalone dist/dev binaries have no path/env fallback. */
export function loadBundledHostOutputFactory(log: (line: string) => void = line => console.error(line)): HostCodeOutputTransportFactory | undefined {
  if (bundled) return bundled;
  const core = process.execPath, resources = dirname(core), contents = dirname(resources), app = dirname(contents);
  if (process.platform !== "darwin" || process.arch !== "arm64" || basename(core) !== "winter-core" ||
      basename(resources) !== "Resources" || basename(contents) !== "Contents" || !app.endsWith(".app")) return undefined;
  return bundled = lazy(() => load(core, signatures, nativeAddon, true), log);
}
/** Explicit host-only fixture DI; never connected to production discovery. */
export async function loadFixtureHostOutputFactory(input: { corePath: string; verifySignature?: SignatureVerifier; loadAddon?: (fd: number) => Addon }): Promise<HostCodeOutputTransportFactory> {
  try { return await load(input.corePath, input.verifySignature ?? signatures, input.loadAddon ?? nativeAddon, input.loadAddon === undefined); }
  catch (error) { throw failure(error); }
}
/** Fixture-only clock/verifier injection tests the same production lazy state
 * machine without altering process identity, filesystem discovery or codesign. */
export function createFixtureLazyHostOutputFactory(input: Parameters<typeof loadFixtureHostOutputFactory>[0] & { log?: (line: string) => void; now?: () => number }): HostCodeOutputTransportFactory {
  return lazy(() => loadFixtureHostOutputFactory(input), input.log, input.now);
}
