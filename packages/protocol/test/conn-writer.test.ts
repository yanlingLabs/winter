import { describe, expect, test } from "bun:test";
import { ConnWriter } from "../src/conn-writer";

function mockSocket(acceptBytes: number) {
  const accepted: number[] = [];
  let ended = false;
  return {
    accepted, get ended() { return ended; },
    write(buf: Uint8Array): number {
      const n = Math.min(acceptBytes, buf.length);
      accepted.push(n);
      return n;
    },
    end() { ended = true; },
    setAccept(n: number) { acceptBytes = n; },
  };
}

describe("ConnWriter", () => {
  test("writes through when the socket accepts everything", () => {
    const s = mockSocket(Infinity);
    const w = new ConnWriter(s, 1024);
    expect(w.enqueue(new Uint8Array(10))).toBe(true);
    expect(w.bufferedBytes).toBe(0);
  });

  test("buffers partial writes and flushes on drain", () => {
    const s = mockSocket(4);
    const w = new ConnWriter(s, 1024);
    w.enqueue(new Uint8Array(10)); // 4 accepted, 6 buffered
    expect(w.bufferedBytes).toBe(6);
    s.setAccept(Infinity);
    w.onDrain();
    expect(w.bufferedBytes).toBe(0);
  });

  test("queues subsequent writes while blocked, preserving order", () => {
    const s = mockSocket(0);
    const w = new ConnWriter(s, 1024);
    w.enqueue(new TextEncoder().encode("AAAA"));
    w.enqueue(new TextEncoder().encode("BBBB"));
    const flushed: string[] = [];
    s.setAccept(Infinity);
    const origWrite = s.write.bind(s);
    (s as any).write = (b: Uint8Array) => { flushed.push(new TextDecoder().decode(b)); return origWrite(b); };
    w.onDrain();
    expect(flushed.join("")).toBe("AAAABBBB");
    expect(w.bufferedBytes).toBe(0);
  });

  test("ends the connection when the buffer cap is exceeded", () => {
    const s = mockSocket(0); // accepts nothing
    const w = new ConnWriter(s, 16);
    w.enqueue(new Uint8Array(10));
    expect(s.ended).toBe(false);
    w.enqueue(new Uint8Array(10)); // 20 > 16 cap
    expect(s.ended).toBe(true);
    expect(w.enqueue(new Uint8Array(1))).toBe(false); // post-end writes refused
  });

  // 2026-10-06: a Dispatch log reached 4.1 MB, so its attach replay (enqueued in one synchronous
  // loop) tripped the 4 MiB cap every time and the session could never be attached again.
  test("a bulk burst past the cap is kept; the backlog becomes a one-time allowance", () => {
    const s = mockSocket(0); // the client has not read a byte yet
    const w = new ConnWriter(s, 16);
    w.beginBulk();
    for (let i = 0; i < 10; i++) expect(w.enqueue(new Uint8Array(10))).toBe(true); // 100 > 16
    w.endBulk();
    expect(s.ended).toBe(false);
    expect(w.bufferedBytes).toBe(100);
    // Live traffic gets the cap ON TOP of the unread backlog: 100 + 16 is still fine…
    expect(w.enqueue(new Uint8Array(16))).toBe(true);
    expect(s.ended).toBe(false);
    // …one byte more is a stuck client.
    expect(w.enqueue(new Uint8Array(1))).toBe(false);
    expect(s.ended).toBe(true);
  });

  test("the allowance shrinks as the client drains — never room for live traffic again", () => {
    const s = mockSocket(0);
    const w = new ConnWriter(s, 16);
    w.beginBulk();
    w.enqueue(new Uint8Array(100));
    w.endBulk();
    s.setAccept(90); // the client reads 90 of the 100
    w.onDrain();
    expect(w.bufferedBytes).toBe(10);
    s.setAccept(0);
    // Allowance is now 10 (the unread remainder): 10 + 16 is the most the backlog may reach.
    expect(w.enqueue(new Uint8Array(16))).toBe(true);
    expect(w.enqueue(new Uint8Array(1))).toBe(false);
    expect(s.ended).toBe(true);
  });
});
