// ComputerV2 Phase 4 — the daemon's end of Winter Headless's PIPE (the helper's half is
// apple/Winter/Sources/HeadlessHelper/HeadlessWire.swift). The daemon spawns the helper's executable directly with two
// extra descriptors: fd 3 carries the daemon's commands to it, fd 4 everything it says back, one JSON-RPC 2.0
// notification per line. No socket, no token: whoever is on the far end of a pipe the daemon made is the helper it
// spawned (and that process is checked against Winter's designated requirement before anything is sent).
//
// The vocabulary is the browser link's: `browserLink.command {linkId, cmdId, op, params}` answered by ONE
// `browserLink.result`, plus the helper's own `browserLink.events` and `browserLink.tabGone`. The helper speaks first
// (`headless.hello {protocol, linkId, pid, version}`), there is one more op, `context.dispose {sessionId}`, and one more
// message from the helper, `headless.notice {tabId, kind}` — a page tried something the helper refused (`popup`: to open
// a window; `local-network`: to reach a private address). Closing fd 3 is how the daemon stops it — and how a daemon
// that dies takes it along.
//
// Winter Headless exposes ONLY these link ops — no browser-level CDP command at all (no `Target.createTarget`, no
// `Browser.*`). A browser-level command list belongs to installed browsers run headless, a later stage.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createReadStream, write } from "node:fs";
import { CDP_ALLOWED_EVENTS } from "../cdp-allowlist";
import { cdpEventParams } from "../cdp-reduce";
import { TransportError, type CdpEvent, type TransportErrorCode } from "../transport";

/** The pipe's protocol — the helper's `HeadlessWire.protocolVersion` must equal it. */
export const HEADLESS_PIPE_PROTOCOL = 1;
/** The ops a command carries: the browser link's, plus `context.dispose`. */
export type HeadlessOp = "tab.ensure" | "tab.release" | "tab.close" | "tabs.live" | "cdp.send" | "cdp.subscribe" | "context.dispose";
/** The helper reads a command line of at most this many bytes. */
export const HEADLESS_COMMAND_MAX = 1024 * 1024;
/** The longest line read back (a result is at most 8 MiB plus its envelope). */
export const HEADLESS_LINE_MAX = 16 * 1024 * 1024;
export const HEADLESS_TIMEOUTS = { send: 15_000, screenshot: 20_000, ensure: 20_000, other: 15_000, hello: 30_000 } as const;
/** How long a helper whose pipe was closed has to exit before it is killed. */
export const HEADLESS_EXIT_GRACE_MS = 3_000;

const STOPPED = "Winter's headless browser stopped — open the page again";

/** The spawned helper, as the pipe sees it. */
export interface EngineChild {
  readonly pid: number;
  /** One line to the helper (fd 3); false once the pipe is closed. */
  write(line: string): boolean;
  onData(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Close fd 3: the helper sees EOF and exits. */
  closeInput(): void;
  kill(signal: NodeJS.Signals): void;
  /** The daemon's own two descriptors of the pipe (its write end, its read end), when it has them — for tests. */
  readonly daemonFds?: readonly [write: number, read: number];
}

export type SpawnEngine = (command: string, args: readonly string[]) => EngineChild;

/** `ioctl(fd, FIOCLEX)` / `ioctl(fd, FIONCLEX)`: set / clear close-on-exec. (`fcntl` is variadic, which an FFI call
 *  cannot pass on arm64; these take no third argument.) `_IO('f', 1)` and `_IO('f', 2)` in <sys/filio.h>. */
const FIOCLEX = 0x20006601;
const FIONCLEX = 0x20006602;

/** libc's `pipe(2)`, `close(2)` and `ioctl(2)` (bound once, lazily). */
let libc: { pipe(fds: Int32Array): number; close(fd: number): number; cloexec(fd: number, on: boolean): number } | undefined;
function pipes(): NonNullable<typeof libc> {
  if (libc === undefined) {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
    });
    libc = { pipe: (fds) => lib.symbols.pipe(ptr(fds)), close: (fd) => lib.symbols.close(fd), cloexec: (fd, on) => lib.symbols.ioctl(fd, on ? FIOCLEX : FIONCLEX) };
  }
  return libc;
}

/**
 * A pipe whose both ends are close-on-exec: no OTHER child the daemon starts inherits either (a child holding a copy of
 * the write end would keep the helper's fd 3 open after the daemon dies — no EOF, a helper left running). The helper
 * still gets its two: a spawn hands them over as fds 3 and 4 by `dup2`, and a duplicate does not carry the flag.
 */
function makePipe(): [read: number, write: number] {
  const fds = new Int32Array(2);
  if (pipes().pipe(fds) !== 0) throw new Error("pipe() failed");
  for (const fd of fds) pipes().cloexec(fd, true);
  return [fds[0]!, fds[1]!];
}

/**
 * The helper's environment: nothing of the daemon's (a dev daemon's shell may export keys) — a fixed PATH, the user's
 * HOME (Chromium reads it), and the temp directory when one is set.
 */
export function headlessHelperEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    ...(env.HOME === undefined ? {} : { HOME: env.HOME }),
    ...(env.TMPDIR === undefined ? {} : { TMPDIR: env.TMPDIR }),
  };
}

/**
 * The real spawn: the helper's executable with two PIPES of the daemon's own on fds 3 (its commands) and 4 (its
 * answers), nothing on stdin/stdout, stderr drained.
 *
 * Made with `pipe(2)` and handed to `Bun.spawn` as plain descriptors — not `node:child_process`'s extra "pipe" slots,
 * which under load sometimes left the child a descriptor whose far end was already closed (its first write: EPIPE),
 * nor `Bun.spawn`'s own extra slots, which only ever carry the parent's writes. The child's ends are closed here the
 * moment it has them, so the daemon holds only its own two — and when it closes fd 3's (or dies), the helper reads EOF.
 */
export const spawnEngineProcess: SpawnEngine = (command, args) => {
  const [childRead, daemonWrite] = makePipe();
  const [daemonRead, childWrite] = makePipe();
  // A child end that already IS its target number is not duplicated, so it must not be close-on-exec itself.
  if (childRead === 3) pipes().cloexec(childRead, false);
  if (childWrite === 4) pipes().cloexec(childWrite, false);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "pipe", childRead, childWrite], env: headlessHelperEnv() });
  } catch (err) {
    for (const fd of [childRead, daemonWrite, daemonRead, childWrite]) pipes().close(fd);
    throw err;
  }
  pipes().close(childRead);
  pipes().close(childWrite);

  let open = true;
  let writing = false;
  const queue: Buffer[] = [];
  const closeWrite = (): void => {
    if (!open) return;
    open = false;
    queue.length = 0;
    if (!writing) pipes().close(daemonWrite);
  };
  // One write in flight at a time, in order (the descriptor is blocking; each write runs off the event loop).
  const pump = (): void => {
    if (writing) return;
    const next = queue.shift();
    if (next === undefined) return;
    writing = true;
    write(daemonWrite, next, (err, n) => {
      writing = false;
      if (err !== null) { closeWrite(); return; }
      if (n < next.length) queue.unshift(next.subarray(n));
      if (!open) { pipes().close(daemonWrite); return; }
      pump();
    });
  };

  const input = createReadStream("", { fd: daemonRead, autoClose: true, highWaterMark: 1024 * 1024 });
  input.on("error", () => { /* the exit says what happened */ });
  const stderrListeners: Array<(chunk: Buffer) => void> = [];
  void (async () => {
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const b = Buffer.from(chunk);
        for (const l of stderrListeners) l(b);
      }
    } catch { /* gone */ }
  })();

  return {
    daemonFds: [daemonWrite, daemonRead] as const,
    get pid() { return proc.pid; },
    write(line) {
      if (!open) return false;
      queue.push(Buffer.from(line));
      pump();
      return true;
    },
    onData(listener) { input.on("data", (chunk) => listener(typeof chunk === "string" ? Buffer.from(chunk) : chunk)); },
    onStderr(listener) { stderrListeners.push(listener); },
    onExit(listener) {
      void proc.exited.then((code) => listener(proc.signalCode === null ? code : null, proc.signalCode ?? null));
    },
    closeInput() { closeWrite(); },
    kill(signal) { try { proc.kill(signal); } catch { /* gone */ } },
  };
};

interface Pending { op: string; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

/** What a page tried that the helper refused, as `headless.notice` says it. */
export type HeadlessNoticeKind = "popup" | "local-network";

/** A helper error code → the transport's. `not_live` reads as the tab gone; a refusal marked `capacity` is the helper's
 *  own tab ceiling. */
export function headlessErrorToTransport(code: string, message: string, data: Record<string, unknown> = {}): TransportError {
  if (code === "not_allowed" && data.capacity === true) return new TransportError("capacity", message, data);
  const map: Record<string, TransportErrorCode> = {
    tab_gone: "tab_gone", not_live: "tab_gone", cdp_error: "cdp_error", not_allowed: "not_allowed", timeout: "timeout", quiescent: "tab_gone",
  };
  return new TransportError(map[code] ?? "cdp_error", message, data);
}

export interface HeadlessHello { linkId: string; protocol: number; pid?: number; version?: string }

/** One running Winter Headless and its pipe. */
export class WinterHeadlessProcess {
  private nextCmd = 1;
  private linkId: string | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(e: CdpEvent) => void>();
  private readonly goneListeners = new Set<(tabKey: string, reason: "closed" | "crashed" | "stopped") => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: string | null) => void>();
  private readonly noticeListeners = new Set<(tabKey: string, kind: HeadlessNoticeKind) => void>();
  private helloWaiter: { resolve(h: HeadlessHello): void; reject(e: Error): void } | undefined;
  private hello: HeadlessHello | undefined;
  private exited = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private stderrLines = 0;

  constructor(readonly child: EngineChild, private readonly opts: { timeouts?: Partial<Record<keyof typeof HEADLESS_TIMEOUTS, number>>; log?(line: string): void } = {}) {
    child.onData((chunk) => this.handleData(chunk));
    child.onStderr((chunk) => this.handleStderr(chunk));
    child.onExit((code, signal) => this.handleExit(code, signal));
  }

  get pid(): number { return this.child.pid; }
  get alive(): boolean { return !this.exited; }
  get version(): string | undefined { return this.hello?.version; }

  private timeout(kind: keyof typeof HEADLESS_TIMEOUTS): number { return this.opts.timeouts?.[kind] ?? HEADLESS_TIMEOUTS[kind]; }

  /** The helper's `headless.hello` (it speaks first, once CEF is up). */
  ready(): Promise<HeadlessHello> {
    if (this.hello !== undefined) return Promise.resolve(this.hello);
    if (this.exited) return Promise.reject(new TransportError("disconnected", STOPPED));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = undefined;
        reject(new TransportError("timeout", "Winter's headless browser did not start in time"));
      }, this.timeout("hello"));
      this.helloWaiter = {
        resolve: (h) => { clearTimeout(timer); resolve(h); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /** One command, answered by one result (or a timeout; there is no cancel op). */
  command(op: HeadlessOp, params: Record<string, unknown>, timeoutMs: number = this.timeout("other")): Promise<unknown> {
    if (this.exited || this.linkId === undefined) return Promise.reject(new TransportError("tab_gone", STOPPED));
    const cmdId = `c${this.nextCmd++}`;
    let line: string;
    try { line = `${JSON.stringify({ jsonrpc: "2.0", method: "browserLink.command", params: { linkId: this.linkId, cmdId, op, params } })}\n`; } catch {
      return Promise.reject(new TransportError("not_allowed", "the command can't be encoded"));
    }
    const size = Buffer.byteLength(line);
    if (size > HEADLESS_COMMAND_MAX) return Promise.reject(new TransportError("not_allowed", `the command is too large for Winter's headless browser (${size} bytes)`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmdId);
        reject(new TransportError("timeout", `Winter's headless browser did not answer ${op} in time`));
      }, timeoutMs);
      this.pending.set(cmdId, { op, resolve, reject, timer });
      if (!this.child.write(line)) {
        clearTimeout(timer);
        this.pending.delete(cmdId);
        reject(new TransportError("tab_gone", STOPPED));
      }
    });
  }

  onEvent(listener: (e: CdpEvent) => void): () => void { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener); }; }
  onTabGone(listener: (tabKey: string, reason: "closed" | "crashed" | "stopped") => void): () => void { this.goneListeners.add(listener); return () => { this.goneListeners.delete(listener); }; }
  onNotice(listener: (tabKey: string, kind: HeadlessNoticeKind) => void): () => void { this.noticeListeners.add(listener); return () => { this.noticeListeners.delete(listener); }; }
  onExit(listener: (code: number | null, signal: string | null) => void): () => void {
    if (this.exited) { listener(null, null); return () => {}; }
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /** Stop it: the pipe closed (it exits on EOF), and killed if it is still there after the grace. */
  close(graceMs: number = HEADLESS_EXIT_GRACE_MS): void {
    if (this.exited) return;
    this.child.closeInput();
    if (this.killTimer === undefined) {
      this.killTimer = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, graceMs);
      (this.killTimer as { unref?: () => void }).unref?.();
    }
  }

  /** At once (the daemon is stopping and will not wait). */
  kill(): void {
    if (this.exited) return;
    this.child.closeInput();
    this.child.kill("SIGKILL");
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (let nl = this.buffer.indexOf(0x0a); nl >= 0; nl = this.buffer.indexOf(0x0a)) {
      const line = this.buffer.subarray(0, nl);
      this.buffer = this.buffer.subarray(nl + 1);
      if (line.length > 0) this.onLine(line);
    }
    if (this.buffer.length > HEADLESS_LINE_MAX) {
      this.opts.log?.(`computer-use: Winter's headless browser sent a line over ${HEADLESS_LINE_MAX} bytes — dropped`);
      this.buffer = Buffer.alloc(0);
    }
  }

  private onLine(line: Buffer): void {
    let message: { method?: unknown; params?: unknown };
    try { message = JSON.parse(line.toString("utf8")) as typeof message; } catch { return; }
    const p = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "headless.hello": {
        if (typeof p.linkId !== "string" || this.hello !== undefined) return;
        this.linkId = p.linkId;
        this.hello = {
          linkId: p.linkId, protocol: typeof p.protocol === "number" ? p.protocol : 0,
          ...(typeof p.pid === "number" ? { pid: p.pid } : {}), ...(typeof p.version === "string" ? { version: p.version } : {}),
        };
        this.helloWaiter?.resolve(this.hello);
        this.helloWaiter = undefined;
        return;
      }
      case "browserLink.result": {
        if (p.linkId !== this.linkId || typeof p.cmdId !== "string") return;
        const pending = this.pending.get(p.cmdId);
        if (pending === undefined) return;
        this.pending.delete(p.cmdId);
        clearTimeout(pending.timer);
        if (p.ok === true) { pending.resolve(p.result); return; }
        const err = (p.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(headlessErrorToTransport(typeof err.code === "string" ? err.code : "cdp_error",
          typeof err.message === "string" ? err.message : `${pending.op} failed`,
          err.data !== null && typeof err.data === "object" ? err.data as Record<string, unknown> : {}));
        return;
      }
      case "browserLink.events": {
        if (p.linkId !== this.linkId || !Array.isArray(p.events)) return;
        for (const e of p.events as Array<Record<string, unknown>>) {
          if (typeof e.tabId !== "string" || typeof e.method !== "string" || !CDP_ALLOWED_EVENTS.includes(e.method)) continue;
          const params = e.params !== null && typeof e.params === "object" ? e.params as Record<string, unknown> : {};
          const ev: CdpEvent = { tabKey: e.tabId, method: e.method, params: cdpEventParams(e.method, params), ...(typeof e.cdpSessionId === "string" ? { cdpSessionId: e.cdpSessionId } : {}) };
          for (const l of [...this.eventListeners]) {
            try { l(ev); } catch (err) { this.opts.log?.(`computer-use: a headless event listener failed (${err instanceof Error ? err.message : "error"})`); }
          }
        }
        return;
      }
      case "headless.notice": {
        if (p.linkId !== this.linkId || typeof p.tabId !== "string" || (p.kind !== "popup" && p.kind !== "local-network")) return;
        for (const l of [...this.noticeListeners]) {
          try { l(p.tabId, p.kind); } catch { /* a listener never breaks the pipe */ }
        }
        return;
      }
      case "browserLink.tabGone": {
        if (p.linkId !== this.linkId || typeof p.tabId !== "string") return;
        const reason = p.reason === "crashed" || p.reason === "stopped" ? p.reason : "closed";
        for (const l of [...this.goneListeners]) {
          try { l(p.tabId, reason); } catch { /* a listener never breaks the pipe */ }
        }
        return;
      }
      default:
        return;
    }
  }

  /** The helper's own log lines, into the daemon's log — bounded (a page can't flood it), never page content. */
  private handleStderr(chunk: Buffer): void {
    if (this.stderrLines >= 200) return;
    for (const raw of chunk.toString("utf8").split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || !/^Winter(CEF|Headless):/.test(line)) continue;
      if (++this.stderrLines > 200) { this.opts.log?.("computer-use: headless: (further helper log lines dropped)"); return; }
      this.opts.log?.(`computer-use: headless: ${line.slice(0, 300)}`);
    }
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    if (this.killTimer !== undefined) clearTimeout(this.killTimer);
    // The daemon's write end goes with the process (a crash would otherwise leave it open).
    this.child.closeInput();
    this.helloWaiter?.reject(new TransportError("disconnected", `Winter's headless browser exited before it was ready (${signal ?? `exit ${code ?? "?"}`})`));
    this.helloWaiter = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError("tab_gone", STOPPED));
      this.pending.delete(id);
    }
    for (const l of [...this.exitListeners]) {
      try { l(code, signal); } catch { /* a listener never breaks the exit */ }
    }
    this.exitListeners.clear();
  }
}
