// An answer too large for one bridge line (`BRIDGE_MAX_LINE`) — a `browsers.read` of a page of control characters
// once swelled past it in JSON — must reach the script as a typed error, never a dropped line that leaves its call
// waiting until the script's timeout. Both ends: the daemon sends a too-large answer as an error naming its size, and
// the worker, handed a runaway answer line anyway, fails the call it answers.
import { describe, expect, test } from "bun:test";
import { AutomationWorker } from "../../src/computer-use/worker-host";
import { BRIDGE_MAX_LINE } from "../../src/computer-use/worker/bridge";
import { sandboxAvailable } from "../../src/workflows/sandbox";

const macOnly = sandboxAvailable() ? test : test.skip;
const SCRIPT = "try { const x = await apps.list(); print('got', typeof x) } catch (e) { print('ERR', e.name, e.message) }";

describe("non-ASCII text across the bridge", () => {
  macOnly("an answer whose character is split between two pipe chunks reaches the script whole", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const stdin = (w as unknown as { child: { stdin: { write(b: Uint8Array): void } } }).child.stdin;
      const value = "日本語のテキスト。";
      const r = await w.run("r1", "const x = await apps.list(); print(x, x.length, [...x].filter((c) => c === '\\uFFFD').length)", {
        onCall: (m) => {
          const bytes = new TextEncoder().encode(`{"op":"reply","id":${m.id},"ok":true,"value":"${value}"}\n`);
          const cut = bytes.indexOf(0xe6) + 1; // inside the first character's three bytes
          stdin.write(bytes.subarray(0, cut));
          setTimeout(() => stdin.write(bytes.subarray(cut)), 60);
        },
        onPrint: (t) => prints.push(t), onShow: () => {},
      });
      expect(r).toEqual({ kind: "done" });
      expect(prints).toEqual([`${value} 9 0`]);
    } finally { w.kill(); }
  }, 30_000);

  macOnly("a long non-ASCII print reaches the daemon whole, however the pipe cuts it", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      // 180,000 characters (540 KB of UTF-8): under the worker's own print cap, cut by the pipe many times.
      const r = await w.run("r1", "print('日本語のテキスト。'.repeat(20000))", { onCall: () => {}, onPrint: (t) => prints.push(t), onShow: () => {} });
      expect(r).toEqual({ kind: "done" });
      expect(prints).toHaveLength(1);
      expect(prints[0]!).toBe("日本語のテキスト。".repeat(20000));
      expect(prints[0]!.includes("\uFFFD")).toBe(false);
    } finally { w.kill(); }
  }, 30_000);
});

describe("an answer too large for the bridge", () => {
  macOnly("the daemon sends it as a typed error naming its size", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const t0 = Date.now();
      const r = await w.run("r1", SCRIPT, {
        onCall: (m) => w.reply(m.id, { ok: true, value: "x".repeat(BRIDGE_MAX_LINE + 1024) }),
        onPrint: (t) => prints.push(t), onShow: () => {},
      });
      expect(r).toEqual({ kind: "done" });
      expect(prints).toHaveLength(1);
      expect(prints[0]).toMatch(/^ERR Error that answer is too large to hand to the script \(4\.\d MB as text\) — ask for less at once$/);
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally { w.kill(); }
  }, 30_000);

  macOnly("the worker, handed a runaway answer line, fails the call it answers and reads on", async () => {
    const w = await AutomationWorker.start();
    try {
      const prints: string[] = [];
      const stdin = (w as unknown as { child: { stdin: { write(s: string): void } } }).child.stdin;
      let writer: Promise<void> = Promise.resolve();
      const r = await w.run("r1", `${SCRIPT}\nconst y = await apps.list(); print('second', y)`, {
        onCall: (m) => {
          if (prints.length === 0) {
            // Past the guard on purpose: the raw line, in pieces that arrive apart (as a slow pipe delivers them) — the
            // worker sees a line grow past the limit with no end in sight.
            const line = `{"op":"reply","id":${m.id},"ok":true,"value":"${"x".repeat(BRIDGE_MAX_LINE + (2 << 20))}"}\n`;
            writer = (async () => {
              for (let i = 0; i < line.length; i += 1 << 20) {
                stdin.write(line.slice(i, i + (1 << 20)));
                await new Promise((res) => setTimeout(res, 40));
              }
            })();
          } else void writer.then(() => w.reply(m.id, { ok: true, value: "fine" })); // whole lines, as the daemon writes them
        },
        onPrint: (t) => prints.push(t), onShow: () => {},
      });
      expect(r).toEqual({ kind: "done" });
      expect(prints[0]).toBe("ERR Error that answer was too large to hand to the script — ask for less at once");
      expect(prints[1]).toBe("second fine");
    } finally { w.kill(); }
  }, 30_000);
});
