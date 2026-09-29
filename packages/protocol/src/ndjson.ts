const NL = 0x0a;

export function encodeLine(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg) + "\n");
}

/** Byte-accurate line splitter (safe across UTF-8 chunk boundaries).
 *
 *  Linear in the bytes pushed: each chunk is scanned ONCE for newlines (only the new bytes — never
 *  the partial line already held), and a partial line is kept as a list of chunk copies joined once
 *  when its newline arrives. The previous shape re-merged and re-scanned the whole partial line on
 *  every chunk, which is quadratic: a 7 MB request (a max-size `session.stageImage`) arriving in
 *  8 KB chunks spent over a second in this loop alone, a real share of a client's 5 s request
 *  timeout. Semantics are unchanged: blank lines are skipped, and a PARTIAL line held past `maxLine`
 *  resets the decoder and throws (a complete line in one chunk is not measured, as before). */
export class LineDecoder {
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private readonly decoder = new TextDecoder();
  constructor(private readonly maxLine = 8 * 1024 * 1024) {}

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(NL, start);
    while (nl !== -1) {
      const tail = chunk.subarray(start, nl);
      let line: Uint8Array = tail;
      if (this.partBytes > 0) {
        line = new Uint8Array(this.partBytes + tail.length);
        let off = 0;
        for (const part of this.parts) { line.set(part, off); off += part.length; }
        line.set(tail, off);
        this.parts = [];
        this.partBytes = 0;
      }
      // Blank lines are skipped: NDJSON has no use for them in JSON-RPC and JSON.parse("") throws downstream.
      if (line.length > 0) lines.push(this.decoder.decode(line));
      start = nl + 1;
      nl = chunk.indexOf(NL, start);
    }
    if (start < chunk.length) {
      // A COPY: the caller may reuse its chunk buffer once this returns.
      this.parts.push(chunk.slice(start));
      this.partBytes += chunk.length - start;
    }
    if (this.partBytes > this.maxLine) {
      this.parts = [];
      this.partBytes = 0;
      throw new Error(`ndjson: line too long (> ${this.maxLine} bytes)`);
    }
    return lines;
  }
}
