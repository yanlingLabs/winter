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
