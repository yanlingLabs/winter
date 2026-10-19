import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { processSatisfiesRequirement } from "../../computer-use/helper-verify";
import type { ProcessTable } from "../native/admission-probes";
import { FdLineChannel, closeDescriptor, spawnWithChannel } from "../native/fd-channel";
import type { CoworkLauncherPort, CoworkLauncherSession } from "../native/host";
import { COWORK_NATIVE_LIMITS, parseCoworkNativeLauncherLine, serializeCoworkNativeLauncherLine, type CoworkNativeToDaemon, type CoworkNativeToLauncher } from "../native/protocol";
import { CoworkHostEnvError } from "./coordination";
import { processStartToken } from "./guards";

/*
 * The production `CoworkLauncherPort`: spawn `winter-cowork-launcher`, prove it is the signed launcher, read its `hello`, and wrap the L1 channel as a session.
 *
 * Trust, in order (contract section 2 and 4.1):
 *  - the launcher is a DIRECT CHILD that this port spawned, so its pid is the one the kernel gave the spawn;
 *  - the RUNNING process must satisfy the launcher's designated requirement (`processSatisfiesRequirement`, the Computer Use precedent: identifier + Winter's team).
 *    It is checked on the live pid, before a single byte is read or sent, so there is no time-of-check/time-of-use gap on the file. Residual: the process runs for a few
 *    milliseconds before it is checked, and the launcher's own check of ITS parent (by audit token, which Bun cannot read on this side) is the load-bearing one;
 *  - `hello` must be the first line and say `parentVerified: true`; any later `hello`, any unparseable line and any descriptor ends the channel.
 * L1 is read only through `FdLineChannel` (recvmsg with a control buffer, every unasked descriptor closed), never `Bun.connect`.
 * Argv is exactly `--worker-path` and `--receipt-dir`: no home, no profile, no environment but two locale variables.
 */

export interface SpawnedLauncher { readonly channel: number; readonly pid: number; kill(): void; readonly exited: Promise<unknown> }
export interface LauncherLineChannel { send(data: Uint8Array, rights?: readonly number[]): void; lines(): AsyncIterableIterator<string>; close(): Promise<void> }
export interface CoworkLauncherPortOptions {
  readonly launcherPath: string; readonly workerPath: string; readonly receiptDirectory: string;
  /** The launcher's designated requirement, checked against the running process. */
  readonly requirement: string;
  readonly processes: ProcessTable;
  /** Test seams; the defaults are the real spawn, the real channel and the real code-signature check. */
  readonly spawn?: (argv: string[]) => SpawnedLauncher;
  readonly openChannel?: (fd: number) => LauncherLineChannel;
  readonly closeChannelDescriptor?: (fd: number) => void;
  readonly verifyProcess?: (pid: number, requirement: string) => boolean;
  readonly checkExecutable?: (path: string) => boolean;
  readonly helloTimeoutMs?: number;
}

const fail = (code: string): never => { throw new CoworkHostEnvError(code); };
const absolute = (path: unknown): string => typeof path === "string" && path.startsWith("/") && !path.includes("\0") && path.length < 1024 ? path : fail("launcher_path_invalid");
const defaultCheckExecutable = (path: string): boolean => { try { accessSync(path, fsConstants.X_OK); return statSync(path).isFile(); } catch { return false; } };

export function createCoworkLauncherPort(options: CoworkLauncherPortOptions): CoworkLauncherPort {
  const launcherPath = absolute(options.launcherPath), workerPath = absolute(options.workerPath), receiptDirectory = absolute(options.receiptDirectory);
  const spawn = options.spawn ?? ((argv: string[]): SpawnedLauncher => { const child = spawnWithChannel(argv); return { channel: child.channel, pid: child.subprocess.pid, kill: () => { child.subprocess.kill(); }, exited: child.subprocess.exited }; });
  const openChannel = options.openChannel ?? ((fd: number): LauncherLineChannel => new FdLineChannel(fd, { maxLine: COWORK_NATIVE_LIMITS.muxLineBytes, maxRights: 0 }));
  const closeFd = options.closeChannelDescriptor ?? closeDescriptor;
  const verifyProcess = options.verifyProcess ?? processSatisfiesRequirement;
  const checkExecutable = options.checkExecutable ?? defaultCheckExecutable;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;

  return {
    async spawn(request) {
      if (!checkExecutable(launcherPath) || !checkExecutable(workerPath)) return fail("launcher_missing");
      const child = spawn([launcherPath, "--worker-path", workerPath, "--receipt-dir", receiptDirectory]);
      let channel: LauncherLineChannel | null = null;
      const abandon = async (code: string): Promise<never> => {
        // Only the subprocess handle this port owns is killed; nothing is signalled by a recorded pid.
        try { child.kill(); } catch { /* already gone */ }
        try { await channel?.close(); } catch { /* closed */ }
        closeFd(child.channel);
        return fail(code);
      };
      // 1. the running process is the signed launcher, before anything is read or sent
      let verified = false;
      try { verified = verifyProcess(child.pid, options.requirement) === true; } catch { verified = false; }
      if (!verified) return abandon("launcher_identity");
      const seen = options.processes.inspect(child.pid);
      if (seen.kind !== "present") return abandon("launcher_gone");
      const startToken = processStartToken(seen);
      channel = openChannel(child.channel);
      const iterator = channel.lines();
      // 2. hello, first, within the bound
      let firstLine: string;
      try {
        const timeout = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new CoworkHostEnvError("launcher_hello_timeout")), helloTimeoutMs); timer.unref?.(); });
        const next = await Promise.race([iterator.next(), timeout]);
        if (next.done) return abandon("launcher_hello_eof");
        firstLine = next.value;
      } catch { return abandon("launcher_hello_failed"); }
      let hello: CoworkNativeToDaemon;
      try { hello = parseCoworkNativeLauncherLine(firstLine, "to-daemon", 0) as CoworkNativeToDaemon; } catch { return abandon("launcher_hello_invalid"); }
      if (hello.t !== "hello" || hello.parentVerified !== true) return abandon("launcher_hello_invalid");
      return new LauncherSession(request, child, channel, iterator, closeFd, { launcherInstanceId: hello.launcherInstanceId, hostBootId: hello.hostBootId, pid: child.pid, startToken });
    },
  };
}

const BUFFER_LIMIT = 64;
class LauncherSession implements CoworkLauncherSession {
  readonly launcherInstanceId: string; readonly hostBootId: string; readonly pid: number; readonly startToken: string;
  private readonly handlers: ((message: CoworkNativeToDaemon) => void)[] = [];
  private readonly closers: (() => void)[] = [];
  private readonly buffered: CoworkNativeToDaemon[] = [];
  private ended = false; private released = false;
  constructor(_request: unknown, private readonly child: SpawnedLauncher, private readonly channel: LauncherLineChannel, iterator: AsyncIterableIterator<string>, private readonly closeFd: (fd: number) => void, identity: { launcherInstanceId: string; hostBootId: string; pid: number; startToken: string }) {
    this.launcherInstanceId = identity.launcherInstanceId; this.hostBootId = identity.hostBootId; this.pid = identity.pid; this.startToken = identity.startToken;
    void this.pump(iterator);
    void child.exited.then(() => this.end(), () => this.end());
  }
  isLive(): boolean { return !this.ended; }
  send(message: CoworkNativeToLauncher, rights: readonly number[] = []): void {
    if (this.ended) throw new CoworkHostEnvError("launcher_channel_closed");
    this.channel.send(Buffer.from(serializeCoworkNativeLauncherLine(message, "to-launcher"), "utf8"), rights);
  }
  onMessage(handler: (message: CoworkNativeToDaemon) => void): () => void {
    this.handlers.push(handler);
    for (const message of this.buffered.splice(0)) this.dispatch(message);
    return () => { const at = this.handlers.indexOf(handler); if (at >= 0) this.handlers.splice(at, 1); };
  }
  onClose(handler: () => void): () => void {
    if (this.ended) { queueMicrotask(handler); return () => {}; }
    this.closers.push(handler);
    return () => { const at = this.closers.indexOf(handler); if (at >= 0) this.closers.splice(at, 1); };
  }
  /** Closing the daemon's end is what the launcher sees as owner loss; it drains by itself. Nothing is killed here. */
  close(): void { this.end(); }
  private dispatch(message: CoworkNativeToDaemon): void { for (const handler of [...this.handlers]) { try { handler(message); } catch { /* a consumer's fault */ } } }
  private async pump(iterator: AsyncIterableIterator<string>): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const message = parseCoworkNativeLauncherLine(next.value, "to-daemon", 0) as CoworkNativeToDaemon;
        if (message.t === "hello") break; // a second hello is a violation
        if (this.handlers.length === 0) { if (this.buffered.length >= BUFFER_LIMIT) break; this.buffered.push(message); } else this.dispatch(message);
      }
    } catch { /* a refused line or descriptor, or a channel fault, ends the channel */ }
    this.end();
  }
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    void this.channel.close().catch(() => {}).finally(() => { if (!this.released) { this.released = true; this.closeFd(this.child.channel); } });
    for (const handler of this.closers.splice(0)) { try { handler(); } catch { /* a consumer's fault */ } }
  }
}
