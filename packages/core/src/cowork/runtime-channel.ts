import { GUEST_RUNTIME_TRANSPORT_LIMITS, type GuestRuntimeChannel, type GuestRuntimeLaunch, type GuestRuntimeTermination } from "./guest-runtime";
import type { CoworkGuestRuntimeLink, CoworkGuestStopOutcome } from "./session-ports";
import { CoworkError } from "./types";

/*
 * Cowork session door D3: the supervisor's `GuestRuntimeChannel` over the native runtime class (mux class 2, conversation
 * 0) of a running incarnation. Bytes only: the link already enforces the 1 MiB in-flight window, and the guest relay owns
 * framing. Nothing here reads the provider class (3), opens a socket or spawns a process.
 *
 *   - OUT and ERR are decoded as UTF-8 STREAMS (a character may split across frames) into a byte-bounded queue; the queue
 *     is drained as the SDK reads, and overflowing it fails closed (the incarnation is asked to stop).
 *   - IN is sent in pieces of at most `chunkBytes`, one after another; `endInput` is the stream's end flag.
 *   - The runtime "exits" when OUT ends or the incarnation's stop outcome is known, whichever is first: the SDK awaits it
 *     when stdout closes without a terminal frame, and must not wait for a whole incarnation stop there.
 *   - `termination` is the incarnation's stop outcome: only a released outcome is `confirmed-stopped` with the store owner
 *     released; anything else (unreleased, or a failure to learn it) is `uncertain` and keeps the admission retained.
 */

/** Decoded OUT/ERR text held for a reader that has not caught up, per stream. Past it the channel fails closed. */
export const COWORK_RUNTIME_BUFFER_BYTES = 4 * GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes;

export interface CoworkRuntimeChannelInput {
  /** `run.runtime(0)` of the incarnation the launch was admitted for. */
  readonly link: CoworkGuestRuntimeLink;
  readonly launch: Readonly<GuestRuntimeLaunch>;
  /** Asks the native owner to stop the incarnation (one conversation per guest). Called on overflow and on `stop`. */
  stop(force: boolean): void;
  /** Test seam for `COWORK_RUNTIME_BUFFER_BYTES`. */
  readonly bufferBytes?: number;
}

/** `text` in pieces of at most `max` UTF-8 bytes, never splitting a character. */
function pieces(text: string, max: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= max) return [text];
  const out: string[] = [];
  let current = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > max) { out.push(current); current = ""; bytes = 0; }
    current += char; bytes += size;
  }
  if (current !== "") out.push(current);
  return out;
}

class DecodedStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffered = 0;
  private closed = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private opened = false;
  constructor(private readonly limit: number, private readonly overflow: () => void) {}
  get ended(): boolean { return this.closed; }
  push(bytes: Uint8Array, end: boolean): void {
    if (this.closed) return;
    let text: string;
    try { text = this.decoder.decode(bytes, { stream: !end }); } catch { this.fail(new CoworkError("invalid_request")); return; }
    for (const piece of text === "" ? [] : pieces(text, GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes)) {
      this.buffered += Buffer.byteLength(piece, "utf8");
      this.queue.push(piece);
    }
    if (this.buffered > this.limit) { this.fail(new CoworkError("response_too_large")); this.overflow(); return; }
    if (end) this.closed = true;
    this.notify();
  }
  /** The incarnation is over: whatever was not ended is ended now (an unflushed partial character is dropped). */
  close(): void { if (!this.closed) { this.closed = true; this.notify(); } }
  fail(error: Error): void { if (!this.closed) { this.failure = error; this.closed = true; this.queue.length = 0; this.buffered = 0; this.notify(); } }
  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.opened) throw new CoworkError("recovery_required");
    this.opened = true;
    for (;;) {
      if (this.queue.length > 0) {
        const piece = this.queue.shift()!;
        this.buffered -= Buffer.byteLength(piece, "utf8");
        yield piece;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

const terminationOf = (launch: Readonly<GuestRuntimeLaunch>, outcome: CoworkGuestStopOutcome | undefined): GuestRuntimeTermination =>
  outcome !== undefined && outcome.released === true
    ? { scope: launch.scope, launchId: launch.launchId, outcome: "confirmed-stopped", storeOwnerReleased: true }
    : { scope: launch.scope, launchId: launch.launchId, outcome: "uncertain", storeOwnerReleased: false };

export function coworkGuestRuntimeChannel(input: CoworkRuntimeChannelInput): GuestRuntimeChannel {
  const { link, launch } = input, limit = input.bufferBytes ?? COWORK_RUNTIME_BUFFER_BYTES;
  if (!link || typeof link.send !== "function" || typeof link.onData !== "function" || typeof link.ended?.then !== "function") throw new CoworkError("unsupported_topology");
  let stopping = false;
  const stopOnce = (force: boolean): void => {
    if (stopping && !force) return;
    stopping = true;
    try { input.stop(force); } catch { /* the native owner reports its own outcome through `ended` */ }
  };
  const stdout = new DecodedStream(limit, () => stopOnce(true)), stderr = new DecodedStream(limit, () => stopOnce(true));
  let exitedResolve!: (value: { code: number | null; signal: string | null }) => void;
  const runtimeExited = new Promise<{ code: number | null; signal: string | null }>(resolve => { exitedResolve = resolve; });
  const exit = (): void => exitedResolve({ code: null, signal: null });
  let unsubscribe: (() => void) | undefined;
  const settleStreams = (): void => { if (stdout.ended && stderr.ended) { try { unsubscribe?.(); } catch { /* already gone */ } unsubscribe = undefined; } };
  unsubscribe = link.onData((stream, bytes, end) => {
    if (stream === "out") { stdout.push(bytes, end); if (stdout.ended) exit(); }
    else if (stream === "err") stderr.push(bytes, end);
    else { stdout.fail(new CoworkError("invalid_request")); stderr.close(); exit(); stopOnce(true); }
    settleStreams();
  });
  const termination = link.ended.then(outcome => terminationOf(launch, outcome), () => terminationOf(launch, undefined));
  void termination.then(() => { stdout.close(); stderr.close(); exit(); settleStreams(); });
  let sends: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => { const next = sends.then(work); sends = next.catch(() => {}); return next; };
  return {
    protocolVersion: 1, scope: launch.scope, launchId: launch.launchId,
    stdout, stderr,
    send(chunk: string): Promise<void> {
      if (typeof chunk !== "string") return Promise.reject(new CoworkError("invalid_request"));
      const bytes = Buffer.from(chunk, "utf8");
      return enqueue(async () => {
        for (let at = 0; at < bytes.length; at += GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes) {
          await link.send(bytes.subarray(at, Math.min(bytes.length, at + GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes)));
        }
      });
    },
    endInput(): Promise<void> { return enqueue(() => link.send(new Uint8Array(0), true)); },
    stop(force: boolean): void { stopOnce(force); },
    runtimeExited,
    termination,
  };
}
