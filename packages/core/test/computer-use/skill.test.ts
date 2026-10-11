// The weak-model `computer-use` skill (packages/core/skills/computer-use/SKILL.md): worked recipes for the
// ComputerV2 tool, held to the API as `description.ts` and `worker/runtime.ts` declare it TODAY.
//
//   - it parses as a skill (name, description) and fits the skill loader's cap;
//   - every call, option key and error class it uses exists in the tool description (no invented members);
//   - it shows the vision-only members (`screenshot`, `show`, points, `appAt`) in ONE section, so a model
//     without image input can skip it;
//   - every example RUNS on the real automation runtime against a scripted host (no syntax slip, no call the
//     runtime does not have), on the happy path and on the branches that escalate;
//   - the recovery the errors section promises (StaleRef → `state({full:true})`, Uncertain → look first) is
//     what the script really does;
//   - no browser API is documented before it exists.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { TrustStore } from "../../src/agent/trust";
import { computerV2Description } from "../../src/computer-use/description";
import { AUTOMATION_ERROR_KINDS } from "../../src/computer-use/errors";
import { APP_PRIMITIVES, GLOBAL_PRIMITIVES, type WorkerToHost } from "../../src/computer-use/worker/bridge";
import { createAutomationRuntime, type AutomationRuntime } from "../../src/computer-use/worker/runtime";

const SKILL_FILE = join(import.meta.dir, "..", "..", "skills", "computer-use", "SKILL.md");
const raw = readFileSync(SKILL_FILE, "utf8");
const body = raw.slice(raw.indexOf("\n---", 3) + 4);

// ── the skill's text ───────────────────────────────────────────────────────────────────────────────
interface Section { title: string; text: string; blocks: string[] }
const sections: Section[] = body.split(/^## /m).map((chunk) => {
  const title = chunk.split("\n", 1)[0]!.trim();
  return { title, text: chunk, blocks: [...chunk.matchAll(/^```js\n([\s\S]*?)^```/gm)].map((m) => m[1]!) };
});
const allBlocks = sections.flatMap((s) => s.blocks);
const SCREENSHOTS = sections.find((s) => s.title.startsWith("7."))!;

// ── the API, as the tool description declares it ───────────────────────────────────────────────────
const full = computerV2Description({ vision: true });
const textOnly = computerV2Description({ vision: false });

function declaredMembers(description: string, header: RegExp, end: string): Map<string, string> {
  const lines = description.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const out = new Map<string, string>();
  for (let i = start + 1; i < lines.length && lines[i] !== end; i++) {
    const m = /^ {2}(\w+)\(/.exec(lines[i]!);
    if (m) out.set(m[1]!, lines[i]!.split("//")[0]!);
  }
  return out;
}
// An app's members: what every target shares (`interface Target`) and what an app adds (`interface App extends Target`).
const appMethods = new Map([...declaredMembers(full, /^interface Target \{/, "}"), ...declaredMembers(full, /^interface App extends Target \{/, "}")]);
const appsMembers = declaredMembers(full, /^declare const apps: \{/, "};");
const screenMembers = declaredMembers(full, /^declare const screen: \{/, "};");
const GLOBALS = new Set(["print", "show", "sleep", "timeLeft"]);
const VISION_ONLY = new Set(["screenshot", "show", "appAt"]);

/** The option keys a signature accepts: the keys of its `{ … }` groups, plus `emit` when it takes `Quiet`. */
function optionKeys(signature: string): Set<string> {
  const keys = new Set<string>();
  if (/\bQuiet\b/.test(signature)) keys.add("emit");
  for (const group of signature.matchAll(/\{([^{}]*)\}/g)) for (const k of group[1]!.matchAll(/(\w+)\??\s*:/g)) keys.add(k[1]!);
  return keys;
}

// ── a small lexer: strings and comments masked, so calls and keys are read from code only ──────────
function mask(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") { out += " "; i++; }
      i--;
    } else if (c === "'" || c === '"' || c === "`") {
      out += c;
      i++;
      while (i < code.length && code[i] !== c) {
        if (code[i] === "\\") { out += " "; i++; }
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += c;
    } else out += c;
  }
  return out;
}

/** The text between the parenthesis opened at `open` and its match. */
function argsAt(masked: string, open: number): string {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if ("([{".includes(masked[i]!)) depth++;
    else if (")]}".includes(masked[i]!) && --depth === 0) return masked.slice(open + 1, i);
  }
  return masked.slice(open + 1);
}

/** The keys of every object literal directly inside `args` (and in the objects nested in it). */
function literalKeys(args: string): string[] {
  const keys: string[] = [];
  const stack: string[] = [];
  let prev = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if ("([{".includes(c)) stack.push(c);
    else if (")]}".includes(c)) stack.pop();
    else if (stack[stack.length - 1] === "{" && (prev === "{" || prev === ",") && /[A-Za-z_]/.test(c)) {
      const m = /^([A-Za-z_]\w*)\s*:/.exec(args.slice(i));
      if (m) { keys.push(m[1]!); i += m[1]!.length - 1; }
    }
    if (!/\s/.test(c)) prev = c;
  }
  return keys;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "await", "typeof", "new"]);
interface Call { recv: string | undefined; name: string; keys: string[]; at: string }

/** Every call in a script: the receiver (when `recv.name(`), the name and the option keys among its arguments. */
function callsIn(code: string): Call[] {
  const masked = mask(code);
  const out: Call[] = [];
  for (const m of masked.matchAll(/(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[2]!;
    const before = masked.slice(0, m.index).trimEnd();
    // Not a call of ours: a keyword, a declaration, a constructor, or a method chained on an expression's result.
    if (KEYWORDS.has(name) || /\bfunction$/.test(before) || /\bnew$/.test(before) || (m[1] === undefined && before.endsWith("."))) continue;
    out.push({ recv: m[1], name, keys: literalKeys(argsAt(masked, m.index! + m[0].length - 1)), at: code.slice(m.index!, m.index! + 60).split("\n")[0]! });
  }
  return out;
}

/** The variables a block binds to an app. `app` is the helper's parameter, a bound app by another name. */
function appVars(code: string): Set<string> {
  const vars = new Set(["app"]);
  for (const m of mask(code).matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+(?:apps\.open|screen\.appAt)\(/g)) vars.add(m[1]!);
  return vars;
}

// ── the skill as a skill ───────────────────────────────────────────────────────────────────────────
describe("the computer-use skill file", () => {
  test("parses as a skill: name, one-line description, a body that fits the loader's cap, in a tight size", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-cu-skill-")));
    const store = new SkillStore({ winterHome: home, trust: new TrustStore(join(home, "trust.json")) });
    const meta = store.list({ cwd: null }).find((m) => m.name === "computer-use");
    expect(meta).toMatchObject({ name: "computer-use", source: "builtin" });
    expect(meta!.description.length).toBeGreaterThan(40);
    expect(meta!.description.length).toBeLessThan(400);
    expect(meta!.description).toContain("ComputerV2");
    const loaded = store.load("computer-use", { cwd: null })!;
    expect(loaded.body.trim()).toBe(body.trim());
    expect(loaded.body).not.toContain("[…truncated]");
    expect(Buffer.byteLength(raw)).toBeLessThan(24_000); // the loader's cap is 32768; a weak model reads all of it
  });

  test("documents every function the tool description has a section for: every error kind, wait, menu, other desktops, screenshots, timeLeft, print vs show", () => {
    for (const kind of AUTOMATION_ERROR_KINDS) expect(body).toContain(`\`${kind}\``);
    for (const m of ["waitFor", "waitForIdle", "menu", "useWindow", "requestForeground", "timeLeft", "setValue", "paste", "type", "find", "emit: false"]) expect(body).toContain(m);
    for (const label of ["freshness unknown", "live", "stale since", "likely current", "capture only"]) expect(body).toContain(label);
  });

  test("no browser API is documented before it exists: the browser section is a stub marked Phase 2", () => {
    expect(body).not.toMatch(/\bbrowsers\b/);
    expect(body).not.toMatch(/\bTab\b/);
    const browser = sections.find((s) => /^Browsers/.test(s.title))!;
    expect(browser.title).toContain("added with Phase 2");
    expect(browser.blocks).toEqual([]);
  });
});

// ── no invented members ────────────────────────────────────────────────────────────────────────────
describe("the skill uses only what the tool description declares", () => {
  const isBound = (recv: string, vars: Set<string>): boolean => vars.has(recv);

  test("every call in every example exists, and every option key it passes is one the signature accepts", () => {
    const problems: string[] = [];
    const findKeys = optionKeys(appMethods.get("find")!);
    for (const block of allBlocks) {
      const vars = appVars(block);
      for (const c of callsIn(block)) {
        if (c.recv === "apps" || c.recv === "screen") {
          const members = c.recv === "apps" ? appsMembers : screenMembers;
          const sig = members.get(c.name);
          if (sig === undefined) problems.push(`${c.recv}.${c.name} is not declared (${c.at})`);
          else for (const k of c.keys) if (!optionKeys(sig).has(k)) problems.push(`${c.recv}.${c.name}: option "${k}" is not in its signature (${c.at})`);
        } else if (c.recv !== undefined && isBound(c.recv, vars)) {
          const sig = appMethods.get(c.name);
          if (sig === undefined) problems.push(`${c.recv}.${c.name} is not an App method (${c.at})`);
          else for (const k of c.keys) if (!optionKeys(sig).has(k)) problems.push(`${c.recv}.${c.name}: option "${k}" is not in its signature (${c.at})`);
        } else if (c.recv === undefined && c.name === "refOf") {
          for (const k of c.keys) if (!findKeys.has(k)) problems.push(`refOf: query key "${k}" is not one find() takes (${c.at})`);
        } else if (c.recv === undefined && !GLOBALS.has(c.name) && c.name !== "refOf" && c.name !== "Error") {
          problems.push(`unknown function ${c.name}() (${c.at})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("every function the prose names in backticks exists too", () => {
    const problems: string[] = [];
    const prose = sections.map((s) => s.text.replace(/^```[\s\S]*?^```/gm, "")).join("\n");
    for (const span of prose.matchAll(/`([^`\n]+)`/g)) {
      for (const m of span[1]!.matchAll(/(?:\b(\w+)\.)?\b([A-Za-z_]\w*)\(/g)) {
        const [, recv, name] = m;
        if (recv === "apps") { if (!appsMembers.has(name!)) problems.push(`apps.${name}`); }
        else if (recv === "screen") { if (!screenMembers.has(name!)) problems.push(`screen.${name}`); }
        else if (recv === undefined || recv === "app" || recv === "safari" || recv === "notes") {
          if (!appMethods.has(name!) && !GLOBALS.has(name!) && name !== "refOf") problems.push(`${recv ? recv + "." : ""}${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("every error class named in an example (`instanceof`) is one the description lists", () => {
    const named = new Set(allBlocks.flatMap((b) => [...mask(b).matchAll(/instanceof\s+(\w+)/g)].map((m) => m[1]!)));
    expect(named.size).toBeGreaterThan(3);
    for (const n of named) {
      expect(AUTOMATION_ERROR_KINDS as readonly string[]).toContain(n);
      expect(full).toContain(`\`${n}\``);
    }
  });

  test("the vision-only members (screenshot, show, appAt, [x, y] points) appear in the Screenshots section alone, so a text-only model can skip it", () => {
    for (const s of sections) {
      if (s === SCREENSHOTS) continue;
      for (const block of s.blocks) {
        for (const c of callsIn(block)) expect([s.title, c.name, VISION_ONLY.has(c.name)]).toEqual([s.title, c.name, false]);
        expect([s.title, /\(\s*\[\s*\d+\s*,\s*\d+\s*\]/.test(block)]).toEqual([s.title, false]);
      }
    }
    // …and the text-only description really lacks them, which is what the section's heading tells the model to check.
    for (const name of VISION_ONLY) expect(textOnly).not.toContain(`${name}(`);
    expect(SCREENSHOTS.title).toContain("screenshot");
    expect(SCREENSHOTS.text).toContain("NotAllowed");
  });

  test("the primitives the examples reach are all ones the worker bridge defines", () => {
    const known = new Set<string>([...APP_PRIMITIVES, ...GLOBAL_PRIMITIVES]);
    for (const block of allBlocks) {
      const vars = appVars(block);
      for (const c of callsIn(block)) {
        if (c.recv !== undefined && vars.has(c.recv)) expect([c.name, known.has(c.name)]).toEqual([c.name, true]);
        if (c.recv === "apps" || c.recv === "screen") expect([c.name, known.has(`${c.recv}.${c.name}`)]).toEqual([c.name, true]);
      }
    }
  });
});

// ── the examples run ───────────────────────────────────────────────────────────────────────────────
type Call_ = Extract<WorkerToHost, { op: "call" }>;
type Answer = { ok: true; value?: unknown } | { ok: false; error: { kind: string; message: string } };
type Done = Extract<WorkerToHost, { op: "done" }>;

function harness(answer: (m: Call_) => Answer) {
  const out: WorkerToHost[] = [];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  let rt!: AutomationRuntime;
  rt = createAutomationRuntime({
    post: (m) => {
      out.push(m);
      if (m.op === "call") setTimeout(() => rt.handle({ op: "reply", id: m.id, ...answer(m) } as never), 0);
    },
    transpile: (code) => transpiler.transformSync(code),
  });
  let n = 0;
  const run = (code: string): Promise<{ done: Done; calls: Call_[]; prints: string[] }> => {
    const runId = `r${++n}`;
    const start = out.length;
    rt.handle({ op: "run", runId, code });
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        const mine = out.slice(start);
        const done = mine.find((m) => m.op === "done" && m.runId === runId) as Done | undefined;
        if (done === undefined) return;
        clearInterval(tick);
        resolve({ done, calls: mine.filter((m): m is Call_ => m.op === "call"), prints: mine.filter((m) => m.op === "print").map((m) => (m as { text: string }).text) });
      }, 2);
    });
  };
  return { run };
}

const text = (q: unknown): string => JSON.stringify(q);
/** A scripted Mac. `mode`: "happy" finds everything; "escalate" makes the checks the examples verify with come
 *  back empty (so the fallback branches run), the lists never end (so the time-left exit runs) and the page keeps
 *  changing; "refused" is "escalate" with the user saying no to a foreground request. */
function mac(mode: "happy" | "escalate" | "refused", seen: Call_[]): (m: Call_) => Answer {
  let clock = 20_000;
  let rowSeq = 0;
  return (m) => {
    seen.push(m);
    const a = m.args ?? {};
    switch (m.primitive) {
      case "apps.open": return { ok: true, value: { targetId: `t:${text(a.app)}`, name: String(a.app).split("/").pop()!, bundleId: "com.example.app" } };
      case "screen.appAt": return { ok: true, value: { targetId: "t:at", name: "Under", bundleId: "com.example.under" } };
      case "apps.list": return { ok: true, value: [{ name: "Notes", bundleId: "com.apple.Notes", running: true }] };
      case "screen.windows": return { ok: true, value: [{ app: "Safari", title: "Docs", frame: [0, 0, 1, 1], onScreen: false }] };
      case "screen.screenshot":
      case "screenshot": return { ok: true, value: { image: "i1", width: 800, height: 600 } };
      case "timeLeft": clock -= 8_000; return { ok: true, value: Math.max(clock, 0) };
      case "windows": return { ok: true, value: [{ id: 1, title: "A", focused: true }, { id: 2, title: "B", focused: false }] };
      case "requestForeground": return { ok: true, value: mode !== "refused" };
      case "waitForIdle": return { ok: true, value: { waitedMs: 40, settled: mode === "happy" } };
      case "waitFor": return { ok: true, value: { waitedMs: 40 } };
      case "find": {
        const q = text(a.query);
        const verifying = ["milk", "Loading", "Thank you", "winter coats"].some((w) => q.includes(w));
        if (mode !== "happy" && verifying) return { ok: true, value: [] };
        if (q.includes('"row"')) return { ok: true, value: [{ ref: 5, role: "row", name: mode === "happy" ? "Groceries" : `Row ${rowSeq++}` }] };
        return { ok: true, value: [{ ref: 7, role: "button", name: "Found" }] };
      }
      case "state": return { ok: true, value: "App — window \"W\" · settled 20 ms\n[1] window" };
      default: return { ok: true };
    }
  };
}

/** A runtime with the skill's setup block (section 0: `refOf`) already run, as the skill tells the model to. */
async function primed(mode: "happy" | "escalate" | "refused", seen: Call_[]) {
  const h = harness(mac(mode, seen));
  const setup = await h.run(allBlocks[0]!);
  expect(setup.done.error).toBeUndefined();
  return h;
}

describe("every example runs on the real automation runtime", () => {
  for (const mode of ["happy", "escalate", "refused"] as const) {
    test(`all blocks in order, one runtime, scripted Mac (${mode})`, async () => {
      const seen: Call_[] = [];
      const { run } = harness(mac(mode, seen));
      const failures: string[] = [];
      for (const [i, block] of allBlocks.entries()) {
        const r = await run(block);
        if (r.done.error !== undefined) failures.push(`block ${i + 1} (${block.split("\n", 1)[0]}): ${r.done.error.name}: ${r.done.error.message}`);
      }
      expect(failures).toEqual([]);
      expect(seen.length).toBeGreaterThan(40);
      // What the scripts asked for is only what the bridge knows.
      const known = new Set<string>([...APP_PRIMITIVES, ...GLOBAL_PRIMITIVES]);
      expect([...new Set(seen.map((c) => c.primitive))].filter((p) => !known.has(p))).toEqual([]);
    });
  }

  test("the escalation examples take their fallback branch: a failed check leads to requestForeground, a refusal ends with a message", async () => {
    for (const [mode, expectForeground, expectAsk] of [["escalate", true, false], ["refused", true, true]] as const) {
      const seen: Call_[] = [];
      const { run } = await primed(mode, seen);
      const block = allBlocks.find((b) => b.includes("fill the search field"))!;
      const r = await run(block);
      expect(r.done.error).toBeUndefined();
      expect(seen.some((c) => c.primitive === "requestForeground")).toBe(expectForeground);
      expect(r.prints.some((p) => p.includes("ask the user to fill the field"))).toBe(expectAsk);
      // Repeating a safe action only: setValue twice when the user allowed it, once when not.
      expect(seen.filter((c) => c.primitive === "setValue").length).toBe(mode === "escalate" ? 2 : 1);
    }
  });

  test("the loop examples stop on time: out of time is said, with what was read so far", async () => {
    const seen: Call_[] = [];
    const { run } = await primed("escalate", seen);
    const block = allBlocks.find((b) => b.includes("timeLeft()"))!;
    const r = await run(block);
    expect(r.done.error).toBeUndefined();
    expect(r.prints[0]).toContain("out of time after");
    expect(seen.filter((c) => c.primitive === "timeLeft").length).toBeGreaterThanOrEqual(2);
  });
});

// ── the recovery the skill promises is the recovery it performs ────────────────────────────────────
describe("the error-handling example does what the table says", () => {
  const block = allBlocks.find((b) => b.includes("e instanceof StaleRef"))!;

  async function failClickWith(kind: string): Promise<{ afterClick: Call_[]; prints: string[]; error: Done["error"] }> {
    const seen: Call_[] = [];
    const base = mac("happy", seen);
    const { run } = harness((m) => (m.primitive === "click" ? (seen.push(m), { ok: false, error: { kind, message: `${kind} message` } }) : base(m)));
    await run(allBlocks[0]!);
    const r = await run(block);
    const at = seen.findIndex((c) => c.primitive === "click");
    return { afterClick: seen.slice(at + 1), prints: r.prints, error: r.done.error };
  }

  test("StaleRef: re-read EVERYTHING, then pick a new ref", async () => {
    const r = await failClickWith("StaleRef");
    expect(r.error).toBeUndefined();
    expect(r.afterClick.map((c) => [c.primitive, c.args?.full])).toEqual([["state", true]]);
  });

  test("Uncertain: look at what changed (no full re-read, no repeat of the click)", async () => {
    const r = await failClickWith("Uncertain");
    expect(r.error).toBeUndefined();
    expect(r.afterClick.map((c) => [c.primitive, c.args?.full])).toEqual([["state", undefined]]);
  });

  test("NeedsForeground: asks the user, with a reason", async () => {
    const r = await failClickWith("NeedsForeground");
    expect(r.afterClick.map((c) => c.primitive)).toEqual(["requestForeground"]);
    expect(typeof r.afterClick[0]!.args?.reason).toBe("string");
    expect(r.prints).toEqual(["in front: repeat the step"]);
  });

  test("Refused: stops and says why; any other error is rethrown", async () => {
    const refused = await failClickWith("Refused");
    expect(refused.afterClick).toEqual([]);
    expect(refused.prints).toEqual(["stop: Refused message"]);
    const other = await failClickWith("PermissionMissing");
    expect(other.error?.name).toBe("PermissionMissing");
  });
});
