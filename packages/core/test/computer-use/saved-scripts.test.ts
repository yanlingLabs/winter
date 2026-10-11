// ComputerV2 Phase 4 — session-saved scripts: the daemon's store and its limits, the worker's `scripts` (it reveals
// nothing; what runs is always the function re-created from its source), and the service around them — kept through a
// reset, the idle end, a crash; gone with the session; the metric and the audit line carry names only.
import { afterEach, describe, expect, test } from "bun:test";
import { SAVED_SCRIPTS_DAEMON_MAX_BYTES, SavedScripts } from "../../src/computer-use/saved-scripts";
import { savedScriptShapeOk } from "../../src/computer-use/worker/saved-shape";
import { SAVED_SCRIPT_MAX_BYTES, SAVED_SCRIPTS_MAX_COUNT, savedScriptNameOk, type WorkerToHost } from "../../src/computer-use/worker/bridge";
import { createAutomationRuntime, type AutomationRuntime } from "../../src/computer-use/worker/runtime";
import { computerV2Description, COMPUTER_V2_INPUT_SCHEMA } from "../../src/computer-use/description";
import { ComputerV2Service, normaliseScriptError } from "../../src/computer-use/service";
import type { ComputerPolicy } from "../../src/computer-use/policy";
import type { HelperClient } from "../../src/computer-use/helper-client";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { InProcessWorker, savedScriptsWorld, sleepMs, textOf } from "./saved-scripts-harness";

const services: ComputerV2Service[] = [];
afterEach(() => { for (const s of services.splice(0)) s.stop(); });
const world = (opts: { idleMs?: number } = {}) => { const w = savedScriptsWorld(opts); services.push(w.svc); return w; };

// ── the daemon's store ─────────────────────────────────────────────────────────────────────────────────────────

describe("SavedScripts (the daemon's store, memory only)", () => {
  test("names: a lowercase letter, then letters, digits or _ (48 at most); never a built-in name", () => {
    for (const ok of ["exportCsv", "a", "fill_form2", `a${"b".repeat(47)}`]) expect(savedScriptNameOk(ok)).toBe(true);
    for (const bad of ["", "Export", "1x", "has-dash", "save", "then", "toString", "constructor", "toJSON", `a${"b".repeat(48)}`, 7, null]) expect(savedScriptNameOk(bad)).toBe(false);
    const s = new SavedScripts();
    expect(s.save("s1", "then", "() => 1")).toMatchObject({ refused: expect.stringContaining("lowercase letter") });
    expect(s.save("s1", "ok", "")).toMatchObject({ refused: expect.stringContaining("a function written in your script") });
    expect(s.save("s1", "ok", 42)).toMatchObject({ refused: expect.stringContaining("a function written in your script") });
  });

  test("limits: 32 KiB per script; 32 per session; 256 KiB in all — replacing a name is allowed within the 256 KiB", () => {
    const s = new SavedScripts();
    expect(s.save("s1", "big", `() => "${"x".repeat(SAVED_SCRIPT_MAX_BYTES)}"`)).toMatchObject({ refused: expect.stringContaining("at most 32 KiB") });
    // UTF-8 bytes count, not characters.
    expect(s.save("s1", "wide", `() => "${"日".repeat(11_000)}"`)).toMatchObject({ refused: expect.stringContaining("at most 32 KiB") });
    for (let i = 0; i < SAVED_SCRIPTS_MAX_COUNT; i++) expect(s.save("s1", `f${i}`, "() => 1")).toEqual({ ok: true, replaced: false });
    expect(s.save("s1", "oneMore", "() => 1")).toMatchObject({ refused: expect.stringContaining("at most 32 saved scripts") });
    expect(s.save("s1", "f3", "() => 2")).toEqual({ ok: true, replaced: true });
    // Another session has its own room.
    expect(s.save("s2", "oneMore", "() => 1")).toEqual({ ok: true, replaced: false });
    const t = new SavedScripts();
    const thirty = `() => "${"y".repeat(30 * 1024)}"`;
    for (let i = 0; i < 8; i++) expect(t.save("s1", `g${i}`, thirty)).toMatchObject({ ok: true });
    expect(t.save("s1", "g8", thirty)).toMatchObject({ refused: expect.stringContaining("256 KiB of saved scripts in all") });
    // Replacing one with a shorter text frees room.
    expect(t.save("s1", "g0", "() => 0")).toMatchObject({ ok: true, replaced: true });
    expect(t.save("s1", "g8", thirty)).toMatchObject({ ok: true, replaced: false });
    // A replacement that would take the session past the total says so in its own words.
    expect(t.save("s1", "g0", thirty)).toMatchObject({ refused: "replacing it would take this session's saved scripts past 256 KiB — save a shorter version or replace a bigger one" });
  });

  test("the shape: exactly one function or arrow expression — anything that would run code when re-created is refused", () => {
    const s = new SavedScripts();
    for (const ok of ["(x) => x", "x => x + 1", "async (a, b) => { return a }", "async x => x", "function f(a) { return a }", "async function* g() { yield 1 }",
      "function () {}", "({ a }, [b] = [1]) => a + b", "(x) => (print(x), x)", "x => `t ${x} ${`${x}`}`", "() => ({ a: 1 })", "async => async"]) {
      expect(s.save("s1", "ok", ok)).toMatchObject({ ok: true });
      expect(savedScriptShapeOk(ok)).toBe(true);
    }
    for (const bad of ["(setTimeout(() => {}, 0), (x) => x)", "(() => 1)()", "function f() {}()", "function f() {}.call(null)", "x => x, alert(1)",
      "(x) => x; y()", "m() { return 1 }", "class K {}", "1 + 1", "(x) => x)(y", "(x) => { }}", "`${(() => 1)()}`", "get x() { return 1 }", "() =>"]) {
      expect(savedScriptShapeOk(bad)).toBe(false);
      expect(s.save("s1", "bad", bad)).toMatchObject({ refused: expect.stringContaining("one function or arrow expression") });
    }
  });

  test("16 MiB across the daemon: the least recently USED other session's scripts are cleared (never the saver's), and it is told once", () => {
    const s = new SavedScripts(100);
    const src = (n: number) => `() => "${"x".repeat(n)}"`;      // 8 + n bytes
    expect(s.save("a", "one", src(32))).toMatchObject({ ok: true });   // a: 40
    expect(s.save("b", "one", src(32))).toMatchObject({ ok: true });   // b: 40
    s.ran("a");                                                        // a used after b
    expect(s.save("c", "one", src(32))).toMatchObject({ ok: true });   // 120 > 100: b (least recently used) goes
    expect(s.any("b")).toBe(false);
    expect(s.any("a")).toBe(true);
    expect(s.takeEvicted("b")).toBe(true);
    expect(s.takeEvicted("b")).toBe(false);
    expect(s.takeEvicted("a")).toBe(false);
    // The saver's own scripts are never cleared for itself: alone it may hold what the per-session caps allow.
    const t = new SavedScripts(60);
    expect(t.save("a", "one", src(40))).toMatchObject({ ok: true });
    expect(t.save("a", "two", src(40))).toMatchObject({ refused: expect.stringContaining("too many saved scripts") });
    expect(t.any("a")).toBe(true);
    expect(SAVED_SCRIPTS_DAEMON_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  test("per session; forInstall hands back name and source; clearSession and clearAll", () => {
    const s = new SavedScripts();
    s.save("s1", "a", "() => 1");
    s.save("s1", "b", "(x) => x");
    s.save("s2", "c", "() => 3");
    expect(s.any("s1")).toBe(true);
    expect(s.has("s1", "c")).toBe(false);
    expect(s.forInstall("s1")).toEqual([{ name: "a", source: "() => 1" }, { name: "b", source: "(x) => x" }]);
    s.clearSession("s1");
    expect(s.any("s1")).toBe(false);
    expect(s.any("s2")).toBe(true);
    s.clearAll();
    expect(s.any("s2")).toBe(false);
  });
});

// ── the worker's `scripts` ─────────────────────────────────────────────────────────────────────────────────────

type Answer = (m: Extract<WorkerToHost, { op: "call" }>) => { ok: true; value?: unknown } | { ok: false; error: { kind: string; message: string } };
function runtime(answer: Answer = () => ({ ok: true })) {
  const out: WorkerToHost[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let rt!: AutomationRuntime;
  rt = createAutomationRuntime({
    post: (m) => { out.push(m); if (m.op === "call") setTimeout(() => rt.handle({ op: "reply", id: m.id, ...answer(m) } as never), 1); },
    transpile: (code) => transpiler.transformSync(code),
  });
  const run = (code: string, install?: Array<{ name: string; source: string }>) => {
    const runId = `r${out.length}`;
    const start = out.length;
    rt.handle({ op: "run", runId, code, ...(install === undefined ? {} : { install }) });
    return new Promise<{ done: Extract<WorkerToHost, { op: "done" }>; prints: string[]; calls: Array<Extract<WorkerToHost, { op: "call" }>> }>((resolve) => {
      const tick = setInterval(() => {
        const mine = out.slice(start);
        const done = mine.find((m) => m.op === "done" && m.runId === runId) as Extract<WorkerToHost, { op: "done" }> | undefined;
        if (done === undefined) return;
        clearInterval(tick);
        resolve({ done, prints: mine.filter((m) => m.op === "print").map((m) => (m as { text: string }).text), calls: mine.filter((m) => m.op === "call") as never });
      }, 2);
    });
  };
  return { run };
}

describe("the worker's scripts", () => {
  test("scripts reveals nothing: no keys, no JSON, no for…in, no listing, no source — only save and the saved names answer", async () => {
    const { run } = runtime();
    await run(`await scripts.save("double", (x) => x * 2)`);
    const r = await run([
      "const keys = Object.keys(scripts); let seen = []; for (const k in scripts) seen.push(k)",
      "print(JSON.stringify(keys), JSON.stringify(seen), JSON.stringify(scripts), Object.getOwnPropertyNames(scripts).length)",
      "print('double' in scripts, 'save' in scripts, Object.getOwnPropertyDescriptor(scripts, 'double') === undefined)",
      "print(String(scripts.double), scripts.double.toString(), typeof scripts.save, typeof scripts.then, typeof scripts.toJSON)",
      "print(scripts)",
      "let frozen = 'no'; try { Object.freeze(scripts) } catch (e) { frozen = e.name }",
      "scripts.double = () => 'evil'; delete scripts.double; Object.defineProperty(scripts, 'x', { value: 1 })",
    ].join("\n")).catch((e) => e);
    // defineProperty answering false throws a TypeError — that is the script's own business; everything before it printed.
    expect(r.prints[0]).toBe("[] [] {} 0");
    expect(r.prints[1]).toBe("false true true");
    expect(r.prints[2]).toBe("function double() { [saved script] } function double() { [saved script] } function undefined undefined");
    expect(r.prints[3]).toBe("{}");
    const after = await run("print(await scripts.double(21), frozen)");
    expect(after.prints).toEqual(["42 TypeError"]);
  });

  test("an unsaved name is JavaScript's own TypeError, never a bridge call", async () => {
    const { run } = runtime();
    const r = await run("await scripts.exportCsv(1)");
    expect(r.done.error).toMatchObject({ name: "TypeError" });
    expect(r.done.error?.message).toContain("is not a function");
    expect(r.calls).toEqual([]);
  });

  test("save sends the name and the source; it is installed only on the daemon's yes; a run asks the daemon first", async () => {
    let refuse = true;
    const { run } = runtime((m) => (m.primitive === "scripts.save" && refuse ? { ok: false, error: { kind: "TypeError", message: "this session keeps at most 32 saved scripts — save over one you no longer need" } } : { ok: true }));
    const no = await run(`await scripts.save("fill", async (app, v) => { return v + "!" })`);
    expect(no.done.error).toMatchObject({ name: "TypeError", message: expect.stringContaining("at most 32 saved scripts") });
    expect(no.calls[0]).toMatchObject({ primitive: "scripts.save", args: { name: "fill", source: `async (app, v) => { return v + "!" }` } });
    expect((await run(`print(typeof scripts.fill)`)).prints).toEqual(["undefined"]);
    refuse = false;
    await run(`await scripts.save("fill", async (app, v) => { return v + "!" })`);
    const yes = await run(`print(await scripts.fill(null, "hi"))`);
    expect(yes.prints).toEqual(["hi!"]);
    expect(yes.calls.map((c) => [c.primitive, c.args])).toEqual([["scripts.run", { name: "fill" }]]);
  });

  test("what runs is the RE-CREATED function: a closed-over variable fails at its first call; top-level declarations and the API work", async () => {
    const { run } = runtime();
    const r = await run([
      "const base = 10",
      "{ const hidden = 5; await scripts.save('usesHidden', () => hidden) }",
      "await scripts.save('usesBase', (x) => { print('in saved'); return base + x })",
      "let caught = null; try { scripts.usesHidden; await scripts.usesHidden() } catch (e) { caught = e.name + ': ' + e.message }",
      "print(caught)",
      "print(await scripts.usesBase(1))",
    ].join("\n"));
    expect(r.done.error).toBeUndefined();
    expect(r.prints[0]).toMatch(/^ReferenceError: .*hidden/);
    expect(r.prints.slice(1)).toEqual(["in saved", "11"]);
    // The top-level name is read when it RUNS: a later redeclaration is what it sees.
    expect((await run("const base = 100\nprint(await scripts.usesBase(1))")).prints).toEqual(["in saved", "101"]);
  });

  test("save refuses what can't be re-created: a method shorthand, a class, a native or bound function, a bad name — before the bridge", async () => {
    const { run } = runtime();
    const cases: Array<[string, string]> = [
      [`const o = { m(a) { return a } }; await scripts.save("m", o.m)`, "arrow or function expression"],
      [`await scripts.save("k", class K {})`, "not a class"],
      [`await scripts.save("n", Math.max)`, "a function written in your script"],
      [`await scripts.save("b", ((x) => x).bind(null))`, "a function written in your script"],
      [`await scripts.save("Bad", () => 1)`, "lowercase letter"],
      [`await scripts.save("save", () => 1)`, "lowercase letter"],
      [`await scripts.save("x", 42)`, "a function written in your script"],
    ];
    for (const [code, words] of cases) {
      const r = await run(code);
      expect(r.done.error).toMatchObject({ name: "TypeError", message: expect.stringContaining(words) });
      expect(r.calls).toEqual([]);
    }
  });

  test("TypeScript: the transpiled source is what is saved; a function declaration saves too", async () => {
    const { run } = runtime();
    const r = await run("async function twice(n: number): Promise<number> { return n * 2 }\nawait scripts.save('twice', twice)");
    expect(r.done.error).toBeUndefined();
    expect(r.calls[0]!.args!.source).not.toContain(": number");
    expect((await run("print(await scripts.twice(4))")).prints).toEqual(["8"]);
  });

  test("installing is INERT: a fresh worker stores the daemon's copy and evaluates nothing; a wrong shape is left out and reported", async () => {
    const { run } = runtime();
    const r = await run("print(typeof scripts.add, typeof scripts.ghost, typeof scripts.broken)", [
      { name: "add", source: "(a, b) => a + b" },
      { name: "ghost", source: "(print('GHOST at install'), (x) => x)" },
      { name: "broken", source: "m() { return 1 }" },
      { name: "Bad", source: "() => 1" },
    ]);
    expect(r.prints).toEqual(["function undefined undefined"]);
    expect(r.done.installFailed).toEqual(["ghost", "broken"]);
    // Re-created at the first call, and only when its own source is exactly the stored text.
    expect((await run("print(await scripts.add(2, 3))")).prints).toEqual(["5"]);
  });

  test("a re-created function whose own source is not the stored text is never run, and is dropped", async () => {
    const { run } = runtime();
    const r = await run("let m; try { await scripts.spaced(1) } catch (e) { m = e.name + ': ' + e.message }\nprint(m, typeof scripts.spaced)", [{ name: "spaced", source: "(a) => a   " }]);
    expect(r.prints).toEqual(["TypeError: scripts.spaced could not be re-created in this runtime — save it again undefined"]);
    expect(r.calls).toEqual([]);
  });

  test("the source is read with Function.prototype.toString and Reflect.apply as they were before any script ran", async () => {
    const { run } = runtime();
    // (In-process: the overrides are this test process's own globals — the script puts them back.)
    const r = await run([
      "const t0 = Function.prototype.toString, a0 = Reflect.apply",
      "try {",
      "  Function.prototype.toString = function () { return '(print(\"GHOST\"), (x) => x)' }",
      "  Reflect.apply = () => '(print(\"GHOST2\"), (x) => x)'",
      "  await scripts.save('looksHarmless', (x) => x)",
      "  print(await scripts.looksHarmless(7))",
      "} finally { Function.prototype.toString = t0; Reflect.apply = a0 }",
    ].join("\n"));
    expect(r.done.error).toBeUndefined();
    expect(r.calls[0]!.args).toEqual({ name: "looksHarmless", source: "(x) => x" });
    expect(r.prints).toEqual(["7"]);
  });

  test("a saved script's own wrapper can't be saved again (its text is the runtime's, not the model's)", async () => {
    const { run } = runtime();
    const r = await run("await scripts.save('a', (x) => x * 2)\nawait scripts.save('b', scripts.a)");
    expect(r.done.error).toMatchObject({ name: "TypeError", message: expect.stringContaining("that is a saved script already") });
    expect(r.calls.filter((c) => c.primitive === "scripts.save").length).toBe(1);
  });

  test("a throw inside a saved script says which and where — a script named calibrate too", async () => {
    const { run } = runtime();
    await run("await scripts.save('boom', (x) => {\n  const y = x + 1\n  throw new RangeError('too far: ' + y)\n})");
    const r = await run("await scripts.boom(1)");
    expect(r.done.error).toMatchObject({ name: "RangeError", message: "too far: 2 (in saved script boom, line 3)", line: 1 });
    await run("await scripts.save('calibrate', () => {\n  throw new Error('c')\n})");
    expect((await run("await scripts.calibrate()")).done.error).toMatchObject({ message: "c (in saved script calibrate, line 2)" });
  });
});

// ── the service ────────────────────────────────────────────────────────────────────────────────────────────────

describe("saved scripts in the service", () => {
  test("kept through a reset, a crash and the idle end (re-installed into each fresh worker); the notices say so, never which", async () => {
    const w = world({ idleMs: 60 });
    const first = await w.run("await scripts.save('greet', (who) => 'hello ' + who)\nprint(await scripts.greet('a'))");
    expect(textOf(first)).toContain("hello a");
    // a reset
    const reset = await w.run("print(await scripts.greet('b'))", { reset: true });
    expect(textOf(reset)).toContain("The automation runtime was reset: earlier variables and bindings are gone (apps stay open). Saved scripts are kept.");
    expect(textOf(reset)).toContain("hello b");
    expect(w.latest().runs[0]!.install).toEqual([{ name: "greet", source: "(who) => 'hello ' + who" }]);
    // a crash (the worker process dies)
    w.latest().kill();
    const crash = await w.run("print(await scripts.greet('c'))");
    expect(textOf(crash)).toContain("The automation runtime restarted; earlier variables and bindings are gone. Saved scripts are kept.");
    expect(textOf(crash)).toContain("hello c");
    // the idle end deletes the session's runtime state — the saved scripts are not in it
    await sleepMs(150);
    expect(w.svc.workerPid("s1")).toBeUndefined();
    const idle = await w.run("print(await scripts.greet('d'))");
    expect(textOf(idle)).toContain("The automation runtime restarted after 1 second without use; earlier variables and bindings are gone. Saved scripts are kept.");
    expect(textOf(idle)).toContain("hello d");
    // A worker that is still alive is not re-told (only a fresh one installs).
    const again = await w.run("print(await scripts.greet('e'))");
    expect(w.latest().runs.at(-1)!.install).toBeUndefined();
    expect(textOf(again)).not.toContain("Saved scripts are kept");
  });

  test("deleting the session clears them: its next incarnation has none and gets no restart notice", async () => {
    const w = world();
    await w.run("await scripts.save('greet', () => 'hi')");
    w.svc.endSession("s1", "deleted");
    const r = await w.run("print(typeof scripts.greet)");
    expect(textOf(r)).toContain("undefined");
    expect(textOf(r)).not.toContain("restarted");
    expect(w.latest().runs[0]!.install).toBeUndefined();
  });

  test("sessions are apart; the daemon's stop drops every one (memory only)", async () => {
    const w = world();
    await w.run("await scripts.save('mine', () => 1)", { sessionId: "s1" });
    expect(textOf(await w.run("print(typeof scripts.mine)", { sessionId: "s2" }))).toContain("undefined");
    expect(w.svc.savedScripts.any("s1")).toBe(true);
    w.svc.stop();
    expect(w.svc.savedScripts.any("s1")).toBe(false);
  });

  test("the daemon re-checks every save (the worker is untrusted): a forged oversized source or a bad name is refused", async () => {
    const w = world();
    await w.run("print('warm')");
    const worker = w.latest();
    worker.forge = (runId) => [
      { op: "call", id: 90_001, runId, primitive: "scripts.save", args: { name: "huge", source: `() => "${"z".repeat(SAVED_SCRIPT_MAX_BYTES + 1)}"` } },
      { op: "call", id: 90_002, runId, primitive: "scripts.save", args: { name: "Not OK", source: "() => 1" } },
      { op: "call", id: 90_003, runId, primitive: "scripts.run", args: { name: "neverSaved" } },
      { op: "call", id: 90_004, runId, primitive: "scripts.save", args: { name: "helper", source: "(setTimeout(() => print('GHOST'), 5), () => 1)" } },
    ];
    await w.run("await sleep(20)");
    await sleepMs(20);
    const answers = Object.fromEntries(worker.replies.filter((r) => r.id > 90_000).map((r) => [r.id, r]));
    expect(answers[90_001]).toMatchObject({ ok: false, error: { kind: "TypeError", message: expect.stringContaining("at most 32 KiB") } });
    expect(answers[90_002]).toMatchObject({ ok: false, error: { kind: "TypeError", message: expect.stringContaining("lowercase letter") } });
    expect(answers[90_003]).toMatchObject({ ok: false, error: { kind: "TypeError", message: "no script was saved under that name in this session" } });
    expect(answers[90_004]).toMatchObject({ ok: false, error: { kind: "TypeError", message: expect.stringContaining("one function or arrow expression") } });
    expect(w.svc.savedScripts.any("s1")).toBe(false);
    // Nothing a forged save sent can run at a later worker's start: the reset's run prints only its own text.
    const after = await w.run("await sleep(30)\nprint('clean')", { reset: true });
    expect(textOf(after)).not.toContain("GHOST");
  });

  test("limits reach the script as a TypeError: too large (said by the worker, never sent) and too many (the daemon's)", async () => {
    const w = world();
    const big = await w.run(`await scripts.save("big", () => "${"q".repeat(SAVED_SCRIPT_MAX_BYTES)}")`);
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain("TypeError");
    expect(textOf(big)).toContain("a saved script is at most 32 KiB of source");
    expect(w.metrics().some((m) => m.primitive === "scripts.save")).toBe(false);
    const many = await w.run(`for (let i = 0; i < ${SAVED_SCRIPTS_MAX_COUNT}; i++) await scripts.save("f" + i, () => 1)\nawait scripts.save("oneMore", () => 1)`);
    expect(many.isError).toBe(true);
    expect(textOf(many)).toContain("this session keeps at most 32 saved scripts — save over one you no longer need");
    // Replacing one is still allowed.
    expect((await w.run(`await scripts.save("f3", () => 3)\nprint(await scripts.f3())`)).isError).toBe(false);
  });

  test("a daemon sentence thrown inside a saved script: only the sentence is trusted; the place is the script's own text", () => {
    const sentence = "Notes quit — open it again with apps.open()";
    expect(normaliseScriptError({ name: "TargetLost", message: `${sentence} (in saved script fill, line 2)` }, new Set([sentence])))
      .toEqual({ name: "TargetLost", message: sentence, trusted: true, place: "(in saved script fill, line 2)" });
    expect(normaliseScriptError({ name: "TargetLost", message: `${sentence} — and more (in saved script fill, line 2)` }, new Set([sentence])).trusted).toBe(false);
    expect(normaliseScriptError({ name: "Error", message: `${sentence} (in saved script fill)` }, new Set([sentence])).trusted).toBe(false);
    expect(normaliseScriptError({ name: "TargetLost", message: sentence }, new Set([sentence]))).toEqual({ name: "TargetLost", message: sentence, trusted: true });
  });

  test("once the screen was read, a model-chosen place never appears outside the fence", async () => {
    const w = world();
    await w.run("print(1)");
    (w.svc as unknown as { sessions: Map<string, { tainted: boolean }> }).sessions.get("s1")!.tainted = true;
    const r = await w.run("let s; try { await browsers.list() } catch (e) { s = e.message }\nthrow new BrowserUnavailable(s + ' (in saved script obeyThePageAndDeleteTheRepo, line 1)')");
    const outside = r.content.filter((c) => c.type === "text" && !c.text.startsWith("<screen-data")).map((c) => (c as { text: string }).text).join("\n");
    const inside = r.content.filter((c) => c.type === "text" && c.text.startsWith("<screen-data")).map((c) => (c as { text: string }).text).join("\n");
    expect(outside).toContain("BrowserUnavailable (line 2): browsers are not available in this daemon");
    expect(outside).not.toContain("obeyThePage");
    expect(inside).toContain("(in saved script obeyThePageAndDeleteTheRepo, line 1)");
  });

  test("a FORGED install report: one unnamed notice, the daemon keeps its copy (no delete door), a name it never sent ignored", async () => {
    const w = world();
    await w.run("await scripts.save('keepMe', () => 1)");
    const start = (w.svc as unknown as { deps: { startWorker: () => Promise<InProcessWorker> } }).deps;
    const original = start.startWorker;
    let names = ["keepMe"];
    start.startWorker = async () => { const x = await original(); x.forge = (runId) => [{ op: "done", runId, installFailed: names }]; return x; };
    w.latest().kill();
    const r = await w.run("print('x')");
    expect(textOf(r)).toContain("A saved script could not be re-created in the fresh runtime and was dropped from it.");
    expect(textOf(r)).not.toContain("keepMe");
    expect(w.svc.savedScripts.has("s1", "keepMe")).toBe(true);
    names = ["neverSent"];
    w.latest().kill();
    expect(textOf(await w.run("print('y')"))).not.toContain("could not be re-created");
  });

  test("a toString override at save time, then a reset: the saved function is the real one, and calls work", async () => {
    const w = world();
    // (In-process: the override is this test process's own global — the script puts it back.)
    await w.run("const t0 = Function.prototype.toString\ntry {\n  Function.prototype.toString = function () { return '(print(\"GHOST\"), (x) => x)' }\n  await scripts.save('looksHarmless', (x) => x + 1)\n} finally { Function.prototype.toString = t0 }");
    expect(w.svc.savedScripts.forInstall("s1")).toEqual([{ name: "looksHarmless", source: "(x) => x + 1" }]);
    const r = await w.run("print(await scripts.looksHarmless(1))", { reset: true });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("2");
    expect(textOf(r)).not.toContain("GHOST");
  });

  test("the daemon-wide cap clears another session's scripts, and that session is told at its next call", async () => {
    const w = savedScriptsWorld({ savedScripts: new SavedScripts(120) });
    services.push(w.svc);
    await w.run(`await scripts.save('one', () => "${"a".repeat(60)}")`, { sessionId: "older" });
    await w.run(`await scripts.save('two', () => "${"b".repeat(60)}")`, { sessionId: "newer" });
    const r = await w.run("print(typeof scripts.one)", { sessionId: "older", reset: true });
    expect(textOf(r)).toContain("This session's saved scripts were cleared to free memory — save them again.");
    expect(textOf(r)).toContain("undefined");
    expect(textOf(await w.run("print(2)", { sessionId: "older" }))).not.toContain("cleared to free memory");
  });

  test("metrics carry the NAME only; the audit line lists the names saved and run; no source anywhere", async () => {
    const w = world();
    await w.run("await scripts.save('secretShape', (a) => a + 'SOURCE-MARKER')\nawait scripts.secretShape('ARG-MARKER')");
    const lines = w.metrics().filter((m) => String(m.primitive).startsWith("scripts."));
    expect(lines.map((m) => [m.primitive, m.script])).toEqual([["scripts.save", "secretShape"], ["scripts.run", "secretShape"]]);
    const raw = JSON.stringify(w.metrics()) + JSON.stringify(w.audits);
    expect(raw).not.toContain("SOURCE-MARKER");
    expect(raw).not.toContain("ARG-MARKER");
    expect(w.audits.at(-1)).toMatchObject({ kind: "automation", scripts: { saved: ["secretShape"], ran: ["secretShape"] } });
    expect(w.audits.at(-1)!.primitives).toMatchObject({ "scripts.save": 1, "scripts.run": 1 });
  });

  test("allowed under every policy: neither primitive asks the policy", async () => {
    const w = world();
    let asked = 0;
    (w.svc as unknown as { deps: { policy: { authorize: () => Promise<void> } } }).deps.policy.authorize = async () => { asked++; };
    const r = await w.run("await scripts.save('noop', () => 41)\nprint(await scripts.noop() + 1)");
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("42");
    expect(asked).toBe(0);
  });

  test("a cancelled run stops a saved script before it starts", async () => {
    const w = world();
    await w.run("await scripts.save('marks', () => print('ran'))");
    const ctl = new AbortController();
    // The script swallows the cancel and calls the saved script anyway: its `scripts.run` is refused first.
    const p = w.svc.run({ sessionId: "s1", vision: true, model: "anthropic/claude-opus-5-5", signal: ctl.signal },
      { code: "try { await sleep(200) } catch {}\ntry { await scripts.marks() } catch (e) { print('stopped: ' + e.name) }" });
    await sleepMs(30);
    ctl.abort();
    const r = await p;
    expect(textOf(r)).not.toContain("ran");
    expect(textOf(r)).toContain("stopped: Cancelled");
  });
});

describe("through the REAL sandboxed worker (the bridge's own lines)", () => {
  const macOnly = sandboxAvailable() ? test : test.skip;
  macOnly("saved, reset, and still there: the install crosses the process boundary", async () => {
    const helper = { connected: false, generation: 0, tell: () => {} } as unknown as HelperClient;
    const policy = { clearSession: () => {}, persistentlyAllowed: () => false, authorize: async () => {} } as unknown as ComputerPolicy;
    const svc = new ComputerV2Service({ helper, policy, settings: () => null });
    services.push(svc);
    const call = (code: string, reset?: boolean) => svc.run({ sessionId: "real", vision: true }, { code, ...(reset === undefined ? {} : { reset }) });
    expect(textOf(await call("await scripts.save('area', (w, h) => w * h)\nprint(await scripts.area(3, 4))"))).toContain("12");
    const pid = svc.workerPid("real");
    const after = await call("print(await scripts.area(5, 6))", true);
    expect(svc.workerPid("real")).not.toBe(pid);
    expect(textOf(after)).toContain("Saved scripts are kept.");
    expect(textOf(after)).toContain("30");
  }, 30_000);
});

describe("through the REAL sandboxed worker: a replaced toString can't plant code that runs at every fresh worker", () => {
  const macOnly = sandboxAvailable() ? test : test.skip;
  macOnly("a toString that returns a stalling expression: the saved function is the real one, and resets keep working", async () => {
    const helper = { connected: false, generation: 0, tell: () => {} } as unknown as HelperClient;
    const policy = { clearSession: () => {}, persistentlyAllowed: () => false, authorize: async () => {} } as unknown as ComputerPolicy;
    const svc = new ComputerV2Service({ helper, policy, settings: () => null });
    services.push(svc);
    const call = (code: string, o: { reset?: boolean; timeoutMs?: number } = {}) => svc.run({ sessionId: "stall", vision: true }, { code, ...o });
    const saved = await call([
      "Function.prototype.toString = function () { return '(setTimeout(() => { const t = Date.now(); while (Date.now() - t < 4000) {} }, 0), (x) => x)' }",
      "await scripts.save('looksHarmless', (x) => x)",
      "print('saved')",
    ].join("\n"), { timeoutMs: 2000 });
    expect(textOf(saved)).toContain("saved");
    expect(svc.savedScripts.forInstall("stall")).toEqual([{ name: "looksHarmless", source: "(x) => x" }]);
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const r = await call("await sleep(100)\nprint('model code: hello', await scripts.looksHarmless(3))", { reset: true, timeoutMs: 2000 });
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain("model code: hello 3");
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  }, 30_000);
});

describe("the description and the schema", () => {
  for (const vision of [true, false]) {
    test(`declares scripts, explains it, names it as built-in (vision ${vision})`, () => {
      const d = computerV2Description({ vision });
      expect(d).toContain("declare const scripts: {");
      expect(d).toContain("  save(name: string, fn: (...args: any[]) => unknown): Promise<void>;");
      expect(d).toContain("Saved scripts can't be listed or read back: remember the names and parameters you will need.");
      expect(d).toContain("keeps a function for the rest of this session (until Winter restarts)");
      expect(d).toContain("(`apps`, `browsers`, `screen`, `scripts`, `print`, `sleep`, `timeLeft`)");
      expect(d.indexOf("declare const scripts")).toBeGreaterThan(d.indexOf("declare const browsers"));
    });
  }
  test("reset keeps saved scripts, and says so", () => {
    expect((COMPUTER_V2_INPUT_SCHEMA.properties as Record<string, { description: string }>).reset!.description)
      .toBe("Discard all runtime variables and bindings before running code. Apps and tabs stay open, and so do scripts saved with scripts.save().");
  });
});
