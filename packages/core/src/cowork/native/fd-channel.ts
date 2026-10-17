import { dlopen, FFIType, ptr, read } from "bun:ffi";

/*
 * Descriptor passing for the daemon end of L1 (docs/cowork-native-worker.md, section 4.3), over bun:ffi.
 *
 * Bun cannot do SCM_RIGHTS natively and its sockets hide the descriptor, so this module owns the raw calls: socketpair,
 * sendmsg and recvmsg with a single SCM_RIGHTS control message, poll, dup, shutdown and (variadic) fcntl, all against
 * libSystem on macOS arm64. `Bun.connect` is never used for this channel.
 *
 * SPIKE FINDINGS (Bun 1.3.14, macOS 26, arm64), pinned by tests:
 *  - `Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe", fdA, fdB] })` DOES pass a descriptor above 2: each numeric entry is
 *    dup2'd into that slot of the child (fdA to 3, fdB to 4) while every other descriptor of the daemon stays closed in the
 *    child (the runtime spawns with CLOEXEC_DEFAULT). The parent keeps its own numbers and must close the child's end itself,
 *    or the death of the launcher never produces EOF on this side.
 *  - `Bun.file(fd).stream()` reads a raw socket descriptor event-driven, but it installs rights (below), so it is NOT used for
 *    a channel. `net.Socket({ fd })` does not deliver data at all.
 *  - ON MACOS A PLAIN read() INSTALLS RIGHTS. A descriptor a peer attached to a stream is installed in the reader's table by an
 *    ordinary read(), `fs.read` and `Bun.file(fd).stream()` alike (observed with a C program and with Bun: one new descriptor
 *    per attached right, invisible to the reader). So EVERY reader of a descriptor-bearing socket, in any language and on both
 *    sides, must use recvmsg with a control buffer and close what it did not ask for. This module therefore never reads a channel
 *    any other way: `FdReceiver` pumps recvmsg on a worker thread and hands the daemon complete messages.
 *
 * Darwin arm64 layout (checked against clang): msghdr is 48 bytes (name 0, namelen 8, iov 16, iovlen 24, control 32,
 * controllen 40, flags 44), cmsghdr is 12 bytes (len 0, level 4, type 8) with its data at offset 12, CMSG_SPACE(n) is
 * 12 + 4n for n descriptors, SOL_SOCKET is 0xffff, SCM_RIGHTS 1, MSG_CTRUNC 0x20, MSG_TRUNC 0x10, MSG_DONTWAIT 0x80.
 */

const AF_UNIX = 1, SOCK_STREAM = 1, SOCK_DGRAM = 2, SOL_SOCKET = 0xffff, SCM_RIGHTS = 1;
const MSG_TRUNC = 0x10, MSG_CTRUNC = 0x20, MSG_DONTWAIT = 0x80;
const F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, FD_CLOEXEC = 1, O_NONBLOCK = 0x4;
const POLLIN = 0x1, POLLOUT = 0x4, POLLERR = 0x8, POLLHUP = 0x10, POLLNVAL = 0x20;
const SHUT_RDWR = 2, SO_NOSIGPIPE = 0x1022;
const EINTR = 4, EAGAIN = 35;
const CMSG_HEADER = 12;
export const FD_CHANNEL_MAX_RIGHTS = 16;

export type FdChannelFailure = "unsupported" | "syscall" | "rights_truncated" | "data_truncated" | "unexpected_rights" | "bad_control" | "closed" | "timeout" | "oversize" | "invalid";
/** `fatal` marks the one case where the kernel may have installed descriptors nobody can see (ancillary truncation): the
 * channel is unusable and the owner must tear the worker down rather than carry on, exactly as the fixture exits. */
export class FdChannelError extends Error {
  constructor(readonly code: FdChannelFailure, readonly errno = 0, readonly fatal = false) { super(`${code}${errno ? ` (errno ${errno})` : ""}`); this.name = "FdChannelError"; }
}

export const fdChannelSupported = (): boolean => process.platform === "darwin" && process.arch === "arm64";

interface Libc {
  socketpair(type: number): [number, number];
  sendmsg(fd: number, data: Uint8Array, rights: readonly number[]): number;
  recvmsg(fd: number, buffer: Uint8Array, controlCapacity: number): { bytes: number; flags: number; controllen: number; control: Uint8Array };
  close(fd: number): number;
  dup(fd: number): number;
  shutdown(fd: number): number;
  noSigpipe(fd: number): number;
  fcntl(fd: number, cmd: number, arg?: number): number;
  poll(entries: readonly { fd: number; events: number }[], timeoutMs: number): number[] | number;
  errno(): number;
}
let libc: Libc | undefined;
function load(): Libc {
  if (libc) return libc;
  if (!fdChannelSupported()) throw new FdChannelError("unsupported");
  const P = FFIType.u64;
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    dup: { args: [FFIType.i32], returns: FFIType.i32 },
    shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    // fcntl is variadic: on Apple arm64 a variadic argument is passed on the STACK, so its int argument is bound as the NINTH
    // parameter (two fixed ones in x0 and x1, six pads for x2 to x7). The same binding computer-use/browser/fd-fs.ts uses for openat.
    fcntl: { args: [FFIType.i32, FFIType.i32, P, P, P, P, P, P, FFIType.i32], returns: FFIType.i32 },
    poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  const errno = () => { const e = lib.symbols.__error(); return e === null ? 0 : read.i32(e, 0); };
  libc = {
    errno,
    close: fd => lib.symbols.close(fd),
    dup: fd => lib.symbols.dup(fd),
    shutdown: fd => lib.symbols.shutdown(fd, SHUT_RDWR),
    // A write to a closed peer must be an EPIPE the caller sees, never a signal that takes the daemon down.
    noSigpipe: fd => lib.symbols.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, ptr(new Int32Array([1])), 4),
    fcntl: (fd, cmd, arg = 0) => lib.symbols.fcntl(fd, cmd, 0n, 0n, 0n, 0n, 0n, 0n, arg),
    socketpair: type => {
      const pair = new Int32Array(2);
      if (lib.symbols.socketpair(AF_UNIX, type, 0, ptr(pair)) !== 0) throw new FdChannelError("syscall", errno());
      for (const fd of pair) lib.symbols.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, ptr(new Int32Array([1])), 4);
      return [pair[0]!, pair[1]!];
    },
    poll: (entries, timeoutMs) => {
      const table = new ArrayBuffer(8 * entries.length), view = new DataView(table);
      entries.forEach((entry, index) => { view.setInt32(index * 8, entry.fd, true); view.setInt16(index * 8 + 4, entry.events, true); view.setInt16(index * 8 + 6, 0, true); });
      const result = lib.symbols.poll(ptr(new Uint8Array(table)), entries.length, timeoutMs);
      if (result < 0) return -errno();
      return entries.map((_, index) => view.getInt16(index * 8 + 6, true));
    },
    sendmsg: (fd, data, rights) => {
      const header = new ArrayBuffer(48), view = new DataView(header), iov = new ArrayBuffer(16), iovView = new DataView(iov);
      // Keep every backing buffer referenced until the call returns: the kernel reads them through raw pointers.
      const payload = data.length ? data : new Uint8Array(1);
      iovView.setBigUint64(0, BigInt(ptr(payload)), true); iovView.setBigUint64(8, BigInt(data.length), true);
      view.setBigUint64(16, BigInt(ptr(new Uint8Array(iov))), true); view.setInt32(24, 1, true);
      let control: Uint8Array | undefined;
      if (rights.length) {
        control = new Uint8Array(CMSG_HEADER + 4 * rights.length);
        const c = new DataView(control.buffer);
        c.setUint32(0, CMSG_HEADER + 4 * rights.length, true); c.setInt32(4, SOL_SOCKET, true); c.setInt32(8, SCM_RIGHTS, true);
        rights.forEach((descriptor, index) => c.setInt32(CMSG_HEADER + 4 * index, descriptor, true));
        view.setBigUint64(32, BigInt(ptr(control)), true); view.setUint32(40, control.length, true);
      }
      const sent = Number(lib.symbols.sendmsg(fd, ptr(new Uint8Array(header)), MSG_DONTWAIT));
      void payload; void control; void header; void iov;
      return sent < 0 ? -errno() : sent;
    },
    recvmsg: (fd, buffer, controlCapacity) => {
      const header = new ArrayBuffer(48), view = new DataView(header), iov = new ArrayBuffer(16), iovView = new DataView(iov), control = new Uint8Array(controlCapacity);
      iovView.setBigUint64(0, BigInt(ptr(buffer)), true); iovView.setBigUint64(8, BigInt(buffer.length), true);
      view.setBigUint64(16, BigInt(ptr(new Uint8Array(iov))), true); view.setInt32(24, 1, true);
      if (controlCapacity > 0) { view.setBigUint64(32, BigInt(ptr(control)), true); view.setUint32(40, controlCapacity, true); }
      const received = Number(lib.symbols.recvmsg(fd, ptr(new Uint8Array(header)), MSG_DONTWAIT));
      void iov;
      if (received < 0) return { bytes: -errno(), flags: 0, controllen: 0, control };
      return { bytes: received, flags: view.getInt32(44, true), controllen: view.getUint32(40, true), control };
    },
  };
  return libc;
}

export const socketPair = (kind: "stream" | "dgram"): [number, number] => load().socketpair(kind === "stream" ? SOCK_STREAM : SOCK_DGRAM);
export const setNoSigpipe = (fd: number): void => { if (load().noSigpipe(fd) !== 0) throw new FdChannelError("syscall", load().errno()); };
export function closeDescriptor(fd: number): void { if (fd >= 0) load().close(fd); }
export const duplicateDescriptor = (fd: number): number => { const copy = load().dup(fd); if (copy < 0) throw new FdChannelError("syscall", load().errno()); return copy; };
export const shutdownDescriptor = (fd: number): void => { load().shutdown(fd); };
export function setCloseOnExec(fd: number, on = true): void {
  const flags = load().fcntl(fd, F_GETFD);
  if (flags < 0 || load().fcntl(fd, F_SETFD, on ? flags | FD_CLOEXEC : flags & ~FD_CLOEXEC) < 0) throw new FdChannelError("syscall", load().errno());
}
export const hasCloseOnExec = (fd: number): boolean => { const flags = load().fcntl(fd, F_GETFD); if (flags < 0) throw new FdChannelError("syscall", load().errno()); return (flags & FD_CLOEXEC) !== 0; };
export function setNonBlocking(fd: number, on = true): void {
  const flags = load().fcntl(fd, F_GETFL);
  if (flags < 0 || load().fcntl(fd, F_SETFL, on ? flags | O_NONBLOCK : flags & ~O_NONBLOCK) < 0) throw new FdChannelError("syscall", load().errno());
}

/** Wait until `fd` has one of `events`, at most `timeoutMs` (bounded to one second per call). Returns the revents, 0 on timeout. */
function waitFor(fd: number, events: number, timeoutMs: number): number {
  const result = load().poll([{ fd, events }], Math.max(0, Math.min(timeoutMs, 1000)));
  if (typeof result === "number") { if (-result === EINTR) return 0; throw new FdChannelError("syscall", -result); }
  const revents = result[0]!;
  if (revents & (POLLERR | POLLNVAL)) throw new FdChannelError("closed");
  return revents;
}

export interface FdSendOptions { readonly deadlineMs?: number }
/**
 * Send ALL of `data`, attaching `rights` (at most FD_CHANNEL_MAX_RIGHTS descriptors) to the FIRST sendmsg only, so on a
 * stream socket the descriptors belong to the first byte of this message and to nothing else. A datagram is one atomic
 * message and must go in a single call. The caller's descriptors stay the caller's: sending never closes them.
 */
export function sendMessage(fd: number, data: Uint8Array, rights: readonly number[] = [], options: FdSendOptions = {}): void {
  if (rights.length > FD_CHANNEL_MAX_RIGHTS || rights.some(descriptor => !Number.isInteger(descriptor) || descriptor < 0) || !(data instanceof Uint8Array) || (rights.length > 0 && data.length === 0)) throw new FdChannelError("invalid");
  const deadline = performance.now() + (options.deadlineMs ?? 5000);
  let offset = 0, first = true;
  while (offset < data.length || first) {
    const sent = load().sendmsg(fd, data.subarray(offset), first ? rights : []);
    if (sent >= 0) { offset += sent; first = false; if (data.length === 0) return; continue; }
    const error = -sent;
    if (error === EINTR) continue;
    if (error !== EAGAIN) throw new FdChannelError(error === 32 /* EPIPE */ || error === 57 /* ENOTCONN */ || error === 54 /* ECONNRESET */ ? "closed" : "syscall", error);
    if (performance.now() > deadline) throw new FdChannelError("timeout");
    waitFor(fd, POLLOUT, deadline - performance.now());
  }
}

export interface FdReceived { readonly data: Uint8Array; readonly rights: number[] }
/**
 * One nonblocking recvmsg. Returns null when nothing is ready; an empty `data` on a stream socket means the peer closed. Every descriptor received is given FD_CLOEXEC and returned for the caller to own; on ANY refusal below, every
 * descriptor that arrived has been closed first.
 *
 *  - MSG_CTRUNC: the control buffer was too small, so the kernel may have installed descriptors that cannot be seen:
 *    `rights_truncated`, FATAL. Never continue on this channel and never acknowledge anything received on it.
 *  - MSG_TRUNC: the datagram did not fit: `data_truncated`.
 *  - More than `maxRights` descriptors, or rights where `maxRights` is 0: `unexpected_rights`.
 *  - Anything other than exactly one SCM_RIGHTS control message of a whole number of descriptors: `bad_control`.
 */
export function receiveMessage(fd: number, maxBytes: number, maxRights = 0, controlSlots = FD_CHANNEL_MAX_RIGHTS + 1): FdReceived | null {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 || !Number.isInteger(maxRights) || maxRights < 0 || maxRights > FD_CHANNEL_MAX_RIGHTS || !Number.isInteger(controlSlots) || controlSlots < 0 || controlSlots > 2 * FD_CHANNEL_MAX_RIGHTS) throw new FdChannelError("invalid");
  const buffer = new Uint8Array(maxBytes);
  // `controlSlots` is a TEST HOOK that shrinks the control buffer to provoke ancillary truncation. Its default has room for one
  // descriptor more than the most any caller may accept, so an extra is SEEN (and refused) instead of silently truncated.
  const capacity = controlSlots === 0 ? 0 : CMSG_HEADER + 4 * controlSlots;
  const result = load().recvmsg(fd, buffer, capacity);
  if (result.bytes < 0) { const error = -result.bytes; if (error === EAGAIN || error === EINTR) return null; throw new FdChannelError(error === 54 ? "closed" : "syscall", error); }
  const control = new DataView(result.control.buffer), received: number[] = [];
  let bad = false, items = 0;
  for (let offset = 0; offset + CMSG_HEADER <= result.controllen;) {
    const length = control.getUint32(offset, true), level = control.getInt32(offset + 4, true), type = control.getInt32(offset + 8, true);
    if (length < CMSG_HEADER || offset + length > result.controllen) { bad = true; break; }
    if (level !== SOL_SOCKET || type !== SCM_RIGHTS) bad = true;
    else {
      items++;
      const payload = length - CMSG_HEADER;
      if (payload % 4 !== 0) bad = true;
      for (let at = 0; at + 4 <= payload; at += 4) received.push(control.getInt32(offset + CMSG_HEADER + at, true));
    }
    offset += (length + 3) & ~3;
  }
  const cleanup = (): void => { for (const descriptor of received) if (descriptor >= 0) load().close(descriptor); };
  if (result.flags & MSG_CTRUNC) { cleanup(); throw new FdChannelError("rights_truncated", 0, true); }
  if (bad || items > 1) { cleanup(); throw new FdChannelError("bad_control"); }
  if (received.length > maxRights) { cleanup(); throw new FdChannelError("unexpected_rights"); }
  if (result.flags & MSG_TRUNC) { cleanup(); throw new FdChannelError("data_truncated"); }
  try { for (const descriptor of received) setCloseOnExec(descriptor, true); } catch (error) { cleanup(); throw error; }
  return { data: buffer.slice(0, result.bytes), rights: received };
}
/** True when `fd` has data (or a hangup) waiting within `timeoutMs`. */
export const waitReadable = (fd: number, timeoutMs: number): boolean => waitFor(fd, POLLIN | POLLHUP, timeoutMs) !== 0;

// ---------------------------------------------------------------------------------------------------- launching

export interface FdChannelProcess {
  /** The daemon's end. Closing it, or the child's death, is what each side sees as EOF. */
  readonly channel: number;
  readonly subprocess: ReturnType<typeof Bun.spawn>;
}
/**
 * Start `argv` with one end of a fresh stream socketpair as its fd 3, and close the parent's copy of the child's end
 * immediately: the launcher's death must produce EOF on `channel`, which only happens once nothing else holds the other end.
 * No other descriptor reaches the child. `stdin` is ignored, `stdout` and `stderr` are whatever the caller asks.
 */
export function spawnWithChannel(argv: string[], options: { env?: Record<string, string>; cwd?: string; stdout?: "ignore" | "pipe" | "inherit"; stderr?: "ignore" | "pipe" | "inherit" } = {}): FdChannelProcess {
  const [daemonEnd, childEnd] = socketPair("stream");
  try {
    const subprocess = Bun.spawn(argv, { stdio: ["ignore", options.stdout ?? "ignore", options.stderr ?? "ignore", childEnd], env: options.env, cwd: options.cwd });
    closeDescriptor(childEnd);
    return { channel: daemonEnd, subprocess };
  } catch (error) { closeDescriptor(daemonEnd); closeDescriptor(childEnd); throw error; }
}

// ---------------------------------------------------------------------------------------------------- receiving

/** The blocking receive loop that runs on a worker thread (fd-receiver-worker.ts): poll the data socket and a wake socket,
 * recvmsg when data is ready, hand each message to `emit`. It ends on EOF, on a refusal (rights where none are allowed,
 * truncation) or when the wake socket becomes readable. It owns neither descriptor. */
export function runReceiveLoop(fd: number, wakeFd: number, maxBytes: number, maxRights: number, emit: (event: ReceiveEvent) => void): void {
  for (;;) {
    const result = load().poll([{ fd, events: POLLIN | POLLHUP }, { fd: wakeFd, events: POLLIN | POLLHUP }], -1);
    if (typeof result === "number") { if (-result === EINTR) continue; emit({ kind: "end", reason: "error", code: "syscall", errno: -result, fatal: false }); return; }
    if (result[1]! !== 0) { emit({ kind: "end", reason: "closed" }); return; }
    if (result[0]! & POLLNVAL) { emit({ kind: "end", reason: "error", code: "closed", errno: 0, fatal: false }); return; }
    if (result[0]! === 0) continue;
    try {
      const got = receiveMessage(fd, maxBytes, maxRights);
      if (got === null) continue;
      if (got.data.length === 0 && got.rights.length === 0) { emit({ kind: "end", reason: "eof" }); return; }
      emit({ kind: "data", data: got.data, rights: got.rights });
    } catch (error) {
      const failure = error instanceof FdChannelError ? error : new FdChannelError("syscall");
      emit({ kind: "end", reason: "error", code: failure.code, errno: failure.errno, fatal: failure.fatal }); return;
    }
  }
}
export type ReceiveEvent =
  | { readonly kind: "data"; readonly data: Uint8Array; readonly rights: number[] }
  | { readonly kind: "end"; readonly reason: "eof" | "closed" }
  | { readonly kind: "end"; readonly reason: "error"; readonly code: FdChannelFailure; readonly errno: number; readonly fatal: boolean };

/**
 * Event-driven receiver for one socket. A worker thread blocks in poll(2) and recvmsg(2), so the daemon's event loop never
 * waits on the peer and never wakes while the channel is idle. The receiver works on a PRIVATE DUP of `fd` and closes it
 * itself, after the worker has stopped; the caller keeps ownership of `fd`. `onEvent` runs on the main thread.
 *
 * Bun 1.3.14 leaves ONE descriptor open per Worker it ever started, even after terminate() (reproduced with a Worker that does
 * nothing, so it is not this module's). A receiver per workspace launch therefore costs one descriptor for the life of the
 * process, the same cost the daemon's per-session chat Workers already pay. A shared receiver hub would cap it at one; that
 * is an S7 decision once the real launcher port exists.
 *
 * `maxRights` 0 means the peer may never send a descriptor: if one arrives it is closed and the channel ends with
 * `unexpected_rights`. Ancillary truncation ends it with a `fatal` `rights_truncated`.
 */
export class FdReceiver {
  private worker: Worker | undefined;
  private readonly dataFd: number;
  private readonly wake: [number, number];
  private stopped = false;
  private finished = false;
  readonly done: Promise<void>;
  /** The descriptors this receiver made and will close (its private dup and its wake pair), for tests and diagnostics. */
  get descriptors(): readonly number[] { return [this.dataFd, this.wake[0], this.wake[1]]; }
  constructor(fd: number, options: { maxBytes: number; maxRights: number }, private readonly onEvent: (event: ReceiveEvent) => void) {
    this.dataFd = duplicateDescriptor(fd);
    try { this.wake = socketPair("stream"); } catch (error) { closeDescriptor(this.dataFd); throw error; }
    let finish!: () => void;
    this.done = new Promise<void>(resolve => { finish = resolve; });
    const worker = new Worker(new URL("./fd-receiver-worker.ts", import.meta.url).href);
    this.worker = worker;
    const settle = (): void => {
      if (this.finished) return; this.finished = true;
      worker.terminate();
      // The worker is gone: nothing can be in poll on these any more.
      closeDescriptor(this.dataFd); closeDescriptor(this.wake[0]); closeDescriptor(this.wake[1]);
      this.worker = undefined; finish();
    };
    worker.onmessage = (message: MessageEvent<ReceiveEvent>) => {
      const event = message.data;
      if (!this.finished) this.onEvent(event);
      if (event.kind === "end") settle();
    };
    worker.onerror = () => { if (!this.finished) this.onEvent({ kind: "end", reason: "error", code: "syscall", errno: 0, fatal: false }); settle(); };
    worker.postMessage({ fd: this.dataFd, wake: this.wake[0], maxBytes: options.maxBytes, maxRights: options.maxRights });
  }
  /** Ask the worker to stop. Resolves once the private descriptors are closed. Safe to call more than once. */
  close(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      if (!this.finished) { try { sendMessage(this.wake[1], new Uint8Array([1])); } catch { /* the worker already ended */ } }
    }
    return this.done;
  }
}

/** Splits received chunks into complete newline-terminated lines and refuses a line over `maxLine` bytes. Pure. */
export class FdLineSplitter {
  private pending = new Uint8Array(0);
  // ignoreBOM keeps a leading U+FEFF in the line (the default strips it silently), so a byte order mark makes the line malformed instead of invisible.
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  constructor(private readonly maxLine: number) {}
  push(chunk: Uint8Array): string[] {
    const next = new Uint8Array(this.pending.length + chunk.length); next.set(this.pending); next.set(chunk, this.pending.length); this.pending = next;
    const lines: string[] = [];
    for (let newline = this.pending.indexOf(10); newline >= 0; newline = this.pending.indexOf(10)) {
      if (newline + 1 > this.maxLine) throw new FdChannelError("oversize");
      lines.push(this.decoder.decode(this.pending.subarray(0, newline + 1))); this.pending = this.pending.slice(newline + 1);
    }
    if (this.pending.length > this.maxLine) throw new FdChannelError("oversize");
    return lines;
  }
  /** Bytes of an unterminated line still held. A peer that closes with any is truncating a line. */
  get partial(): number { return this.pending.length; }
}

/**
 * A line channel: send lines (and, on the one line type that allows it, descriptors) and iterate the lines that arrive. It
 * wraps an FdReceiver and an FdLineSplitter, so every read goes through recvmsg. Iteration ends at EOF; a refusal (a line over
 * the bound, rights where none are allowed, truncation, a half line at EOF) ends it by throwing the FdChannelError.
 */
export class FdLineChannel {
  private readonly queue: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private rejecting: ((error: unknown) => void) | undefined;
  private ended: { error?: FdChannelError } | undefined;
  private readonly splitter: FdLineSplitter;
  private readonly receiver: FdReceiver;
  constructor(readonly fd: number, options: { maxLine: number; maxRights?: number }) {
    this.splitter = new FdLineSplitter(options.maxLine);
    this.receiver = new FdReceiver(fd, { maxBytes: Math.min(options.maxLine, 1 << 20), maxRights: options.maxRights ?? 0 }, event => this.receive(event));
  }
  private receive(event: ReceiveEvent): void {
    if (this.ended) return;
    try {
      if (event.kind === "data") {
        for (const line of this.splitter.push(event.data)) this.queue.push(line);
        // Rights are only legal where the owner asked for them; this channel's owner takes none from the stream.
        event.rights.forEach(closeDescriptor);
      } else if (event.kind === "end") {
        if (event.reason === "error") this.ended = { error: new FdChannelError(event.code, event.errno, event.fatal) };
        else this.ended = this.splitter.partial > 0 ? { error: new FdChannelError("closed") } : {};
      }
    } catch (error) { this.ended = { error: error instanceof FdChannelError ? error : new FdChannelError("syscall") }; }
    this.flush();
    if (this.ended) void this.receiver.close();
  }
  private flush(): void {
    if (this.waiting && this.queue.length) { const resolve = this.waiting; this.waiting = this.rejecting = undefined; resolve({ value: this.queue.shift()!, done: false }); }
    else if (this.waiting && this.ended) {
      const resolve = this.waiting, reject = this.rejecting; this.waiting = this.rejecting = undefined;
      if (this.ended.error) reject?.(this.ended.error); else resolve({ value: undefined, done: true });
    }
  }
  /** Send one message on the caller's descriptor. Descriptors listed here are NOT closed. */
  send(data: Uint8Array, rights: readonly number[] = []): void { sendMessage(this.fd, data, rights); }
  [Symbol.asyncIterator](): AsyncIterableIterator<string> { return this.lines(); }
  lines(): AsyncIterableIterator<string> {
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise<IteratorResult<string>>((resolve, reject) => {
        if (self.queue.length) return resolve({ value: self.queue.shift()!, done: false });
        if (self.ended) return self.ended.error ? reject(self.ended.error) : resolve({ value: undefined, done: true });
        self.waiting = resolve; self.rejecting = reject;
      }),
      return: async () => { await self.close(); return { value: undefined, done: true }; },
    };
  }
  close(): Promise<void> { return this.receiver.close(); }
}
