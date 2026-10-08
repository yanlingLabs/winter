// ComputerV2: the automation runtime INSIDE the worker (`computer-use/worker/runtime.ts`), driven in-process with
// a scripted bridge — persistence, redeclaration, TypeScript, typed errors, line placement, cancellation.
import { describe, expect, test } from "bun:test";
import { createAutomationRuntime, type AutomationRuntime } from "../../src/computer-use/worker/runtime";
import type { WorkerToHost } from "../../src/computer-use/worker/bridge";

type Answer = (m: Extract<WorkerToHost, { op: "call" }>) => { ok: true; value?: unknown } | { ok: false; error: { kind: string; message: string } } | undefined;

function harness(answer: Answer = () => ({ ok: true })) {
  const out: WorkerToHost[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let rt!: AutomationRuntime;
  rt = createAutomationRuntime({
    post: (m) => {
      out.push(m);
      if (m.op === "call") {
        const a = answer(m);
        if (a !== undefined) setTimeout(() => rt.handle({ op: "reply", id: m.id, ...a } as never), 1);
      }
    },
    transpile: (code) => transpiler.transformSync(code),
  });
  const run = (runId: string, code: string): Promise<{ done: Extract<WorkerToHost, { op: "done" }>; prints: string[]; calls: Array<Extract<WorkerToHost, { op: "call" }>> }> => {
    const start = out.length;
    rt.handle({ op: "run", runId, code });
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        const mine = out.slice(start);
        const done = mine.find((m) => m.op === "done" && m.runId === runId) as Extract<WorkerToHost, { op: "done" }> | undefined;
        if (done === undefined) return;
        clearInterval(tick);
        resolve({
          done,
          prints: mine.filter((m) => m.op === "print").map((m) => (m as { text: string }).text),
          calls: mine.filter((m) => m.op === "call") as Array<Extract<WorkerToHost, { op: "call" }>>,
        });
      }, 2);
    });
  };
  return { rt, out, run };
}

describe("the automation runtime", () => {
  test("top-level declarations persist across runs and may be redeclared", async () => {
    const { run } = harness();
    await run("r1", "const x = 41\nlet { a, b: [c] } = { a: 1, b: [2] }\nfunction twice(v) { return v * 2 }\nclass K { v() { return 'k' } }");
    const r2 = await run("r2", "print(x + 1, a, c, twice(4), new K().v())");
    expect(r2.done.error).toBeUndefined();
    expect(r2.prints).toEqual(["42 1 2 8 k"]);
    const r3 = await run("r3", "const x = 'again'\nfunction twice(v) { return v * 3 }\nprint(x, twice(2))");
    expect(r3.prints).toEqual(["again 6"]);
  });

  test("top-level await works; a nested declaration stays local", async () => {
    const { run } = harness();
    await run("r1", "const v = await Promise.resolve(5)\nif (true) { const hidden = 1 }");
    const r2 = await run("r2", "print(v, typeof hidden)");
    expect(r2.prints).toEqual(["5 undefined"]);
  });

  test("TypeScript syntax is stripped, and its declarations persist too", async () => {
    const { run } = harness();
    const r1 = await run("r1", "interface P { n: number }\nconst p: P = { n: 3 }\nconst label = (p.n as number).toString()");
    expect(r1.done.error).toBeUndefined();
    const r2 = await run("r2", "print(label, p.n)");
    expect(r2.prints).toEqual(["3 3"]);
  });

  test("every API call is one bridge request; a typed failure is thrown as its class", async () => {
    const { run } = harness((m) => (m.primitive === "apps.open"
      ? { ok: true, value: { targetId: "t1", name: "Notes", bundleId: "com.apple.Notes" } }
      : { ok: false, error: { kind: "StaleRef", message: "[12] is gone — call state()" } }));
    const r = await run("r1", "const app = await apps.open('Notes')\ntry { await app.click(12) } catch (e) { print(e instanceof StaleRef, e instanceof AutomationError, e.name, e.message) }");
    expect(r.prints).toEqual(["true true StaleRef [12] is gone — call state()"]);
    expect(r.calls.map((c) => [c.primitive, c.target, c.args])).toEqual([
      ["apps.open", undefined, { app: "Notes" }],
      ["click", "t1", { target: 12 }],
    ]);
  });

  test("every error class is a global", async () => {
    const { run } = harness();
    const r = await run("r1", "print([StaleRef, TargetLost, TargetBusy, WaitTimeout, NotAllowed, Refused, NeedsForeground, HelperUnavailable, PermissionMissing, Cancelled].map((c) => c.name).join(','))");
    expect(r.prints).toEqual(["StaleRef,TargetLost,TargetBusy,WaitTimeout,NotAllowed,Refused,NeedsForeground,HelperUnavailable,PermissionMissing,Cancelled"]);
  });

  test("an escaping error is placed on its script line — a throw, and a failed API call", async () => {
    const { run } = harness(() => ({ ok: false, error: { kind: "TargetLost", message: "Notes is gone" } }));
    const r1 = await run("r1", "const a = 1\n\nnull.x");
    expect(r1.done.error).toMatchObject({ name: "TypeError", line: 3 });
    const r2 = await run("r2", "print('x')\nawait apps.list()");
    expect(r2.done.error).toEqual({ name: "TargetLost", message: "Notes is gone", line: 2 });
  });

  test("a syntax error is reported, not run", async () => {
    const { run } = harness();
    const r = await run("r1", "const s = await app.state(\nprint(s)");
    expect(r.done.error?.name).toBe("SyntaxError");
    expect(r.prints).toEqual([]);
  });

  test("cancel rejects the in-flight call and every later one with Cancelled; sleeps too", async () => {
    const { rt, run } = harness(() => undefined); // never answers
    const p = run("r1", "try { await apps.list() } catch (e) { print('first', e.name) }\ntry { await sleep(5) } catch (e) { print('sleep', e.name) }\nawait apps.list()");
    setTimeout(() => rt.handle({ op: "cancel", runId: "r1", reason: "the turn was interrupted" }), 20);
    const r = await p;
    expect(r.prints).toEqual(["first Cancelled", "sleep Cancelled"]);
    expect(r.done.error).toMatchObject({ name: "Cancelled", message: "the turn was interrupted" });
  });

  test("a cancelled sleep stops waiting at once", async () => {
    const { rt, run } = harness();
    const t0 = Date.now();
    const p = run("r1", "await sleep(30000)");
    setTimeout(() => rt.handle({ op: "cancel", runId: "r1" }), 20);
    const r = await p;
    expect(r.done.error?.name).toBe("Cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("ambient names are SHADOWED only — defense in depth; the sandbox is what makes them useless", async () => {
    const { run } = harness();
    const r = await run("r1", [
      "print(typeof process, typeof Bun, typeof fetch, typeof require)",
      // Review I2: shadowing a NAME stops nothing a script can reach another way. In-process (no sandbox here)
      // these three succeed; worker-process.test.ts proves that inside the real worker they are useless — an
      // empty environment, every read outside the allowlist denied, no network, no Keychain.
      "print(typeof this.process, typeof (0, Function)('return process')(), typeof (await import('node:fs')).readFileSync)",
      "print({ a: [1, 2] }, 3n, undefined, new Error('boom'))",
    ].join("\n"));
    expect(r.prints[0]).toBe("undefined undefined undefined undefined");
    expect(r.prints[1]).toBe("object object function");
    expect(r.prints[2]).toBe('{\n  "a": [\n    1,\n    2\n  ]\n} 3n undefined Error: boom');
  });

  test("show() takes only an image from screenshot()", async () => {
    const { run } = harness((m) => (m.primitive === "screen.screenshot" ? { ok: true, value: { image: "img_1", width: 10, height: 5 } } : { ok: true }));
    const r = await run("r1", "const img = await screen.screenshot({ emit: false })\nshow(img)\nprint(String(img), img.width)\nshow({ image: 'forged' })");
    expect(r.done.error).toMatchObject({ name: "TypeError", line: 4 });
  });

  test("an un-awaited call does not outlive its script (no unhandled rejection)", async () => {
    const { run } = harness(() => undefined);
    const r = await run("r1", "apps.list()\nprint('done')");
    expect(r.done.error).toBeUndefined();
    expect(r.prints).toEqual(["done"]);
  });
});
