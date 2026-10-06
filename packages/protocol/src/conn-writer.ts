/** Minimal writable surface ConnWriter needs (Bun's TCP socket satisfies it). */
export interface WritableSocket {
  write(buf: Uint8Array): number;
  end(): void;
}

/**
 * Bounded outbound queue per connection (spec §5 backpressure).
 * Also handles Bun's per-write byte cap: partial writes are queued and
 * flushed on drain, so large frames are never silently truncated.
 * A consumer that can't keep up is disconnected — it resyncs from its last seq.
 */
export class ConnWriter {
  private queue: Uint8Array[] = [];
  private buffered = 0;
  private dead = false;
  /** Inside `beginBulk()`…`endBulk()`: the cap is not checked. */
  private bulk = false;
  /** The backlog a bulk run left behind, on top of the cap. It only ever SHRINKS (as the client
   *  drains), so it is a one-time allowance for that backlog, never extra room for live traffic. */
  private allowance = 0;

  constructor(private readonly socket: WritableSocket, private readonly capBytes = 4 * 1024 * 1024) {}

  get bufferedBytes(): number { return this.buffered; }

  /**
   * A bounded burst the caller is producing synchronously — an attach REPLAY of a session's whole
   * log. The slow-consumer cap guards against a client that stopped reading while LIVE traffic
   * piles up; a replay is different: it is enqueued in one synchronous loop before the socket has
   * had a single chance to drain, so a log past the cap (a long-lived Dispatch session reached
   * 4.1 MB live, 2026-10-06) killed EVERY attach to it, forever, and the client's reconnect loop
   * re-tried the same doomed replay. During a bulk run the cap is suspended; at its end the
   * remaining backlog becomes a shrinking allowance, so the client is cut off only once live
   * traffic grows `capBytes` past what it has not yet read.
   */
  beginBulk(): void { this.bulk = true; }

  endBulk(): void {
    this.bulk = false;
    this.allowance = Math.max(this.allowance, this.buffered);
    this.checkCap();
  }

  enqueue(buf: Uint8Array): boolean {
    if (this.dead) return false;
    if (this.buffered === 0) {
      const n = this.socket.write(buf);
      if (n >= buf.length) return true;
      buf = buf.subarray(Math.max(0, n));
    }
    this.buffered += buf.length;
    this.queue.push(buf);
    return this.bulk ? true : this.checkCap();
  }

  /** False (and the socket ended) when the backlog is past the cap plus any bulk allowance. */
  private checkCap(): boolean {
    if (this.buffered > this.capBytes + this.allowance) {
      this.dead = true;
      this.socket.end(); // slow consumer: disconnect, client resyncs from seq
      return false;
    }
    return true;
  }

  /** Wire to the socket's drain handler. */
  onDrain(): void {
    if (this.dead) return;
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const n = this.socket.write(head);
      const written = Math.max(0, n);
      this.buffered -= written;
      // A drained byte of the bulk backlog is never room again.
      this.allowance = Math.min(this.allowance, this.buffered);
      if (written < head.length) {
        this.queue[0] = head.subarray(written);
        return; // still blocked; wait for next drain
      }
      this.queue.shift();
    }
  }
}
