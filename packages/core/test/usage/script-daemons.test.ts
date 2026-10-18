// Every daemon booted OUTSIDE the tests and the real daemon — the probes, the verify gates, the live and e2e suites,
// `check:idle-wakeups` — must never read or spawn the user's own Codex / Claude Code / Antigravity / OpenCode, nor run
// the background plan beat (`docs/claude/usage.md`): an in-process `startDaemon({…})` names `usage:` (`USAGE_INERT`), a
// spawned `daemon run` carries `USAGE_INERT_ENV`. A source pin: a new entry that forgets it fails here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { USAGE_INERT, USAGE_INERT_ENV } from "../../src/usage/wiring";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
/** The real daemons: the CLI's `daemon run` and the dev daemon (the developer's own, on purpose). */
const REAL = new Set(["packages/cli/src/main.ts", "packages/core/src/daemon.ts", "scripts/dev-daemon.ts"]);

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

/** The text of each `startDaemon(…)` call's argument (brace-balanced from its opening parenthesis). */
function startDaemonCalls(text: string): string[] {
  const calls: string[] = [];
  for (const m of text.matchAll(/\bstartDaemon\(/g)) {
    // A declaration (`function startDaemon(`, `async function startDaemon(`) is not a call.
    if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    // Nor a mention in a comment (`// … startDaemon({ home }) …`, a doc comment's `* …`).
    const line = text.slice(text.lastIndexOf("\n", m.index!) + 1, m.index!);
    if (line.includes("//") || /^\s*\*/.test(line) || /^\s*\/\*/.test(line)) continue;
    let depth = 0;
    let i = m.index! + "startDaemon".length;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) break; }
    }
    calls.push(text.slice(start, i + 1));
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

  test("every in-process startDaemon outside the tests names usage:, every spawned `daemon run` carries USAGE_INERT_ENV", () => {
    const files = [...sources(join(REPO, "scripts")), ...sources(join(REPO, "packages", "core", "src")), ...sources(join(REPO, "packages", "cli", "src"))];
    const missing: string[] = [];
    let calls = 0;
    for (const file of files) {
      const rel = relative(REPO, file);
      if (REAL.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      // A file with a `startDaemon` of its own (office-agent-gate's spawns `daemon run`: the env rule below covers it).
      const own = /function\s+startDaemon\(/.test(text);
      for (const call of own ? [] : startDaemonCalls(text)) {
        calls++;
        if (!/\busage\s*:/.test(call)) missing.push(`${rel}: startDaemon${call.slice(0, 80)}`);
      }
      if (/["']daemon["'],\s*["']run["']/.test(text) && !text.includes("USAGE_INERT_ENV")) missing.push(`${rel}: spawns \`daemon run\` without USAGE_INERT_ENV`);
    }
    expect(missing).toEqual([]);
    // The probes, cu-live, the browser e2e and the idle gate: the scan found them (it is not looking at nothing).
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});
