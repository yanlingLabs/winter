// Every daemon booted OUTSIDE the tests and the real daemon — the probes, the verify gates, the live and e2e suites,
// `check:idle-wakeups` — must never read or spawn the user's own Codex / Claude Code / Antigravity / OpenCode, nor run
// the background plan beat (`docs/claude/usage.md`). A source pin over `scripts/` and `packages/*/src`, comments
// stripped by a small lexer (strings, templates and regex literals kept):
//   - an in-process `startDaemon({…})` passes `usage: USAGE_INERT`, or an object literal that itself sets
//     `background: false` and every root and executable to null / "off" (`usage: undefined` does not pass);
//   - a spawn that boots a daemon (`daemon run`, the cu-live daemon binary, a compiled probe route that boots one, a
//     `bun` probe file) passes an `env` that carries `USAGE_INERT_ENV` — in the call, or in the definition of the
//     variable or function it names (and any `Object.assign` onto it before the call);
//   - STRUCTURALLY, whatever the spawn's shape: every file under `scripts/` whose code names the daemon (`winter-core`,
//     `startDaemon`, `daemon run`) carries `USAGE_INERT_ENV` / `USAGE_INERT` / a `background: false` injection, or is
//     listed in `NO_DAEMON_OF_ITS_OWN` with its reason (no stale entries).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { USAGE_INERT, USAGE_INERT_ENV } from "../../src/usage/wiring";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
/** The real daemons: the CLI's `daemon run` and the dev daemon (the developer's own, on purpose). */
const REAL = new Set(["packages/cli/src/main.ts", "packages/core/src/daemon.ts", "scripts/dev-daemon.ts"]);

/** A spawn that boots a daemon, by what it runs. */
const DAEMON_LAUNCH = [
  /["']daemon["']\s*,\s*["']run["']/,
  /\bbuilt\.daemon\b/,
  /["']__(?:runtime-state|embedded)-probe["']/,
  /\[\s*["']bun["']\s*,\s*probe\s*\]/,
];
/** …unless it runs a client route of the daemon binary (a socket client, no daemon of its own) or a plain tool that
 *  only names a probe route (`grep -ac __runtime-state-probe <binary>`). */
const NOT_A_DAEMON = [
  /["']__(?:helper-call|helper-freshness|peer-hello)["']/,
  /^\(\s*\[?\s*["'](?:grep|codesign|strings|otool|nm|file|pgrep)["']/,
];
const SPAWN_CALL = /\b(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|execFileSync|execFile|runChild)\(/g;

/** The structural rule's subject: a script that names the daemon binary (`winter-core`, `winter-core-live`, a
 *  `dist/dev/winter-core`, never the `@yanlinglabs/winter-core` package), `startDaemon` or `daemon run`… */
const NAMES_A_DAEMON = /(?<!@yanlinglabs\/)\bwinter-core\b|\bstartDaemon\b|\bdaemon run\b|["']daemon["']\s*,\s*["']run["']/;
/** …carries the usage-inert switch somewhere in its code (not a comment)… */
const CARRIES_INERT = /\bUSAGE_INERT_ENV\b|\bUSAGE_INERT\b|\busage\s*:\s*\{[^}]*\bbackground\s*:\s*false\b/;
/** …or is one of these, each for its reason. A NEW script naming the daemon fails until it is one or the other, so a
 *  spawn shape the call scan below does not know is still caught. */
const NO_DAEMON_OF_ITS_OWN: Record<string, string> = {
  "scripts/dev-daemon.ts": "the developer's own dev daemon — real, on purpose",
  "scripts/dev-daemon-lib.ts": "the dev daemon's helpers (paths, signing, the transition)",
  "scripts/dev-daemon.test.ts": "tests the dev daemon's helpers; boots none",
  "scripts/computer-helper-lib.ts": "names the daemon's code-signing identities for the helper's allowlist",
  "scripts/cu-live/build.ts": "compiles and signs winter-core-live; runs it never",
  "scripts/verify-automation-worker-compiled.ts": "runs only the `__automation-worker` route (a worker, no daemon)",
  "scripts/verify-workflow-compiled.ts": "runs only the `__workflow-worker` route (a worker, no daemon)",
  "scripts/verify-runtimes-compiled.ts": "runs only `__runtimes-probe` (resolves the bundled runtimes, no daemon)",
  "scripts/release.ts": "builds, signs and notarizes winter-core; runs only `__keychain-ffi-probe` (an ffi check, no daemon)",
  "scripts/release.test.ts": "tests the release's helpers; boots none",
  "scripts/release-lib.test.ts": "tests the release's helpers; boots none",
  "scripts/rename/codemod.test.ts": "the rename codemod's fixtures (strings)",
  "scripts/embed-cowork-native.test.ts": "tests the Cowork native embed script's helpers; names winter-core as a string, boots none",
};

/** Every script file (any language this repo writes them in), tests included. */
function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...scriptFiles(path));
    else if (/\.(?:[cm]?[jt]s|sh|zsh|py)$/.test(name)) out.push(path);
  }
  return out;
}

/** Comments out: the lexer for JS/TS, `#` lines for the shells and Python (a shebang is a comment too). */
function codeOf(path: string): string {
  const src = readFileSync(path, "utf8");
  return /\.(?:sh|zsh|py)$/.test(path) ? src.replace(/^\s*#.*$/gm, "") : stripComments(src);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** PURE: the source with its comments blanked (newlines kept) — strings, template literals (and their `${…}` code) and
 *  regex literals kept as they are. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  // Template nesting: "tpl" inside a template's text, a number (its brace depth) inside a `${…}`.
  const stack: Array<"tpl" | number> = [];
  let last = "";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === "tpl") {
      if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
      if (c === "`") { stack.pop(); out += c; i++; last = "`"; continue; }
      if (c === "$" && n === "{") { stack.push(0); out += "${"; i += 2; last = "{"; continue; }
      out += c; i++; continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      last = c;
      continue;
    }
    if (c === "`") { stack.push("tpl"); out += c; i++; continue; }
    if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|in|of)\s*$/.test(out))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = "/";
      continue;
    }
    if (typeof top === "number") {
      if (c === "{") stack[stack.length - 1] = top + 1;
      else if (c === "}") {
        if (top === 0) { stack.pop(); out += c; i++; last = "}"; continue; }
        stack[stack.length - 1] = top - 1;
      }
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

/** The balanced text from `open` (an opening bracket) to its match, quoted strings skipped. */
function balanced(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  return code.slice(open);
}

/** The expression after `key:` inside an object's text — up to the next `,` or the closing bracket at its own depth. */
function valueOf(text: string, key: string): string | undefined {
  const m = new RegExp(`(?<![\\w$.])${key}\\s*:`).exec(text);
  if (m === null) return undefined;
  let depth = 0;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return text.slice(m.index + m[0].length, i).trim(); depth--; }
    else if (c === "," && depth === 0) return text.slice(m.index + m[0].length, i).trim();
  }
  return text.slice(m.index + m[0].length).trim();
}

/** PURE: a `usage:` injection that keeps the daemon away from the user's apps. */
export function inertInjection(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "USAGE_INERT") return true;
  if (!value.startsWith("{")) return false;
  const off = (key: string): boolean => /^(?:null|["']off["'])$/.test(valueOf(value, key) ?? "");
  return valueOf(value, "background") === "false"
    && ["codexHome", "claudeHome", "claudeJsonPath", "codexExecutable", "claudeExecutable", "agyExecutable", "opencodeExecutable"].every(off);
}

/** The definition of `name` nearest before `at` (a const/let/var, or a function), and every `Object.assign(name, …)`
 *  between it and `at`. */
function definitionsOf(code: string, name: string, at: number): string[] {
  const out: string[] = [];
  let defAt = -1;
  for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b|\\bfunction\\s+${name}\\s*\\(`, "g"))) {
    if (m.index! < at) defAt = m.index!;
  }
  if (defAt >= 0) {
    // The statement: its brackets balanced, ending at `;` or a newline at depth 0 once one bracket opened.
    let depth = 0;
    let opened = false;
    let end = code.length;
    for (let i = defAt; i < code.length; i++) {
      const c = code[i]!;
      if ("([{".includes(c)) { depth++; opened = true; } else if (")]}".includes(c)) depth--;
      else if (depth === 0 && opened && (c === ";" || c === "\n") && !/[:=]\s*$/.test(code.slice(defAt, i))) { end = i; break; }
    }
    out.push(code.slice(defAt, end));
  }
  for (const m of code.matchAll(new RegExp(`\\bObject\\.assign\\(\\s*${name}\\b`, "g"))) {
    if (m.index! > defAt && m.index! < at) out.push(balanced(code, m.index! + "Object.assign".length));
  }
  return out;
}

/** PURE: a daemon spawn's `env` carries `USAGE_INERT_ENV` (in the call, or in what it names). */
export function inertSpawn(code: string, call: string, at: number): boolean {
  const options = valueOf(call, "env") ?? (/(?<![\w$.])env(?![\w$:])/.test(call) ? "env" : undefined);
  if (options === undefined) return false;
  if (options.includes("USAGE_INERT_ENV")) return true;
  const names = [...options.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!).filter((n) => n !== "process");
  return names.some((n) => definitionsOf(code, n, at).some((d) => d.includes("USAGE_INERT_ENV")));
}

/** Each `startDaemon(…)` call's argument text and position (declarations are not calls). */
function startDaemonCalls(code: string): string[] {
  const calls: string[] = [];
  for (const m of code.matchAll(/\bstartDaemon\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    calls.push(balanced(code, m.index! + "startDaemon".length));
  }
  return calls;
}

describe("script and probe daemons are usage-inert", () => {
  test("USAGE_INERT and USAGE_INERT_ENV switch everything off", () => {
    expect(USAGE_INERT).toMatchObject({ codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: null, claudeExecutable: null,
      agyExecutable: null, opencodeExecutable: null, catchUp: false, background: false });
    for (const k of ["CODEX_HOME", "CLAUDE_HOME", "CLAUDE_JSON", "CODEX_EXECUTABLE", "CLAUDE_EXECUTABLE", "AGY_EXECUTABLE", "OPENCODE_EXECUTABLE", "BACKGROUND", "CATCH_UP"]) {
      expect(USAGE_INERT_ENV[`WINTER_USAGE_${k}`]).toBe("off");
    }
  });

  test("the pin itself is not fooled: comments, `usage: undefined`, a half-off literal, an env that never reaches the spawn", () => {
    expect(stripComments("a(); // startDaemon({ home })\nb(/\\/\\//, '//x', `//${c /* d */}`);/* e */")).toBe(
      "a();                         \nb(/\\/\\//, '//x', `//${c        }`);       ");
    expect(inertInjection("USAGE_INERT")).toBe(true);
    expect(inertInjection("undefined")).toBe(false);
    expect(inertInjection("{ background: false }")).toBe(false);
    expect(inertInjection("{ codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: null, claudeExecutable: \"off\", agyExecutable: null, opencodeExecutable: null, background: false }")).toBe(true);
    expect(inertInjection("{ codexHome: null, claudeHome: null, claudeJsonPath: null, codexExecutable: fake, claudeExecutable: null, agyExecutable: null, opencodeExecutable: null, background: false }")).toBe(false);
    // The env named in the file but not passed to the spawn; a spawn with no env at all; one passed through a variable.
    const unused = "const env = { ...USAGE_INERT_ENV };\nspawn(x, [\"daemon\", \"run\"], { stdio: \"pipe\" });";
    expect(inertSpawn(unused, unused.slice(unused.indexOf("(x")), unused.indexOf("spawn("))).toBe(false);
    const other = "const env = { ...USAGE_INERT_ENV };\nconst e2 = { A: 1 };\nspawn(x, [\"daemon\", \"run\"], { env: e2 });";
    expect(inertSpawn(other, "(x, [\"daemon\", \"run\"], { env: e2 })", other.indexOf("spawn("))).toBe(false);
    const passed = "const env: Record<string, string> = {};\nObject.assign(env, { ...USAGE_INERT_ENV });\nspawn(x, [\"daemon\", \"run\"], { env, detached: true });";
    expect(inertSpawn(passed, "(x, [\"daemon\", \"run\"], { env, detached: true })", passed.indexOf("spawn("))).toBe(true);
  });

  test("structurally: every script naming the daemon carries the usage-inert switch, or is listed with its reason", () => {
    const unexplained: string[] = [];
    const named = new Set<string>();
    for (const file of scriptFiles(join(REPO, "scripts"))) {
      const rel = relative(REPO, file);
      const code = codeOf(file);
      if (!NAMES_A_DAEMON.test(code)) continue;
      named.add(rel);
      if (!CARRIES_INERT.test(code) && NO_DAEMON_OF_ITS_OWN[rel] === undefined) unexplained.push(rel);
    }
    expect(unexplained).toEqual([]);
    // No stale entry: each listed script still names the daemon and still lacks the switch (one that gained it, or
    // stopped naming the daemon, leaves the list).
    const stale = Object.keys(NO_DAEMON_OF_ITS_OWN).filter((rel) => !named.has(rel) || CARRIES_INERT.test(codeOf(join(REPO, rel))));
    expect(stale).toEqual([]);
    // The daemons the switch is for are among the subjects.
    for (const rel of ["scripts/check-idle-wakeups.ts", "scripts/cu-live/run.ts", "scripts/cu-live/daemon-entry.ts", "scripts/office-agent-gate.ts",
      "scripts/verify-embedded-compiled.ts", "scripts/verify-runtime-state-compiled.ts", "scripts/browser-e2e/extension/run.ts"]) {
      expect(named.has(rel)).toBe(true);
    }
  });

  test("every in-process startDaemon and every daemon spawn outside the tests is usage-inert", () => {
    const files = [...sources(join(REPO, "scripts")), ...sources(join(REPO, "packages", "core", "src")), ...sources(join(REPO, "packages", "cli", "src"))];
    const missing: string[] = [];
    let calls = 0;
    let spawns = 0;
    for (const file of files) {
      const rel = relative(REPO, file);
      if (REAL.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      // A file with a `startDaemon` of its own (office-agent-gate's spawns `daemon run`: the spawn rule covers it).
      const own = /function\s+startDaemon\(/.test(code);
      for (const call of own ? [] : startDaemonCalls(code)) {
        calls++;
        if (!inertInjection(valueOf(call, "usage"))) missing.push(`${rel}: startDaemon${call.slice(0, 100)}`);
      }
      for (const m of code.matchAll(SPAWN_CALL)) {
        const call = balanced(code, m.index! + m[0].length - 1);
        if (!DAEMON_LAUNCH.some((re) => re.test(call)) || NOT_A_DAEMON.some((re) => re.test(call))) continue;
        spawns++;
        if (!inertSpawn(code, call, m.index!)) missing.push(`${rel}: ${m[0]}${call.slice(1, 100)} — its env does not carry USAGE_INERT_ENV`);
      }
    }
    expect(missing).toEqual([]);
    // Not looking at nothing: the probes, cu-live, the browser e2e and the idle gate; and the gates' daemon spawns.
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(spawns).toBeGreaterThanOrEqual(5);
  });
});
