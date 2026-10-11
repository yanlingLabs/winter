const NL = 0x0a;

/** The longest NDJSON line a daemon connection accepts (`LineDecoder`'s default). Anything a client
 *  sends in ONE request — a staged image's base64 included — must fit under it, envelope and all. */
export const NDJSON_MAX_LINE_BYTES = 8 * 1024 * 1024;

export function encodeLine(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg) + "\n");
}

/** Byte-accurate line splitter (safe across UTF-8 chunk boundaries).
 *
 *  Linear in the bytes pushed: each chunk is scanned ONCE for newlines (only the new bytes — never
 *  the partial line already held), and a partial line is held in ONE growable buffer whose capacity
 *  doubles, so appending is amortised O(1) per byte whatever the chunk size — a line fed one byte
 *  at a time costs neither a quadratic re-copy nor a per-chunk object. (The first shape re-merged and
 *  re-scanned the whole partial line on every chunk: a 7 MB request in 8 KB chunks spent over a
 *  second in this loop alone.) A buffer that grew past `SHRINK_ABOVE` is released once its line
 *  completes. Semantics are unchanged: blank lines are skipped, and a PARTIAL line held past
 *  `maxLine` resets the decoder and throws (a complete line in one chunk is not measured). */
export class LineDecoder {
  private buf: Uint8Array = new Uint8Array(0);
  private len = 0;
  private readonly decoder = new TextDecoder();
  private static readonly SHRINK_ABOVE = 64 * 1024;
  constructor(private readonly maxLine = NDJSON_MAX_LINE_BYTES) {}

  /** Appends a COPY of `bytes` (the caller may reuse its chunk buffer once `push` returns). */
  private append(bytes: Uint8Array): void {
    const need = this.len + bytes.length;
    if (need > this.buf.length) {
      const grown = new Uint8Array(Math.max(need, this.buf.length * 2, 256));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(bytes, this.len);
    this.len = need;
  }

  private reset(): void {
    this.len = 0;
    if (this.buf.length > LineDecoder.SHRINK_ABOVE) this.buf = new Uint8Array(0);
  }

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(NL, start);
    while (nl !== -1) {
      const tail = chunk.subarray(start, nl);
      let line: Uint8Array = tail;
      if (this.len > 0) {
        this.append(tail);
        line = this.buf.subarray(0, this.len);
      }
      // Blank lines are skipped: NDJSON has no use for them in JSON-RPC and JSON.parse("") throws downstream.
      if (line.length > 0) lines.push(this.decoder.decode(line));
      if (this.len > 0) this.reset();
      start = nl + 1;
      nl = chunk.indexOf(NL, start);
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
    if (this.len > this.maxLine) {
      this.len = 0;
      this.buf = new Uint8Array(0);
      throw new Error(`ndjson: line too long (> ${this.maxLine} bytes)`);
    }
    return lines;
  }
}
