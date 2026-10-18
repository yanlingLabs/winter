// The plan probes' safety rails (`docs/claude/usage.md`), FAKE executables only: the `/usage` latch (only a model-loop
// answer latches; an ordinary error is retried after the throttle), the latch persisted per exact binary, the hard
// bounds on the invocation, the scrubbed environment, the binary resolution order, and `~/.claude.json`'s re-parse
// and size rules.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, binaryKey, type UsageServiceDeps } from "../../src/usage/service";
import { CLAUDE_USAGE_ARGS } from "../../src/usage/claude-code";
import { probeEnv, resolveExecutable } from "../../src/usage/spawn-lines";
import { claudeJson, fakeClaude, fakeCodex, neutralIn, tempDir } from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.now();

function service(over: Partial<UsageServiceDeps> & { db?: UsageDb; home?: string } = {}) {
  const home = over.home ?? tempDir("home");
  const db = over.db ?? new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true }), codexExecutable: () => undefined, claudeExecutable: () => undefined,
    winterCodexWindows: () => [], neutralCwd: () => neutralIn(home), ingestEveryMs: 0, planWaitMs: 20_000,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...over,
  });
  return { home, db, svc, logs };
}

function marks(markerPath: string): Array<{ argv: string[]; cwd: string; env: string[] }> {
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe("the /usage latch", () => {
  test("a plain is_error (logged out, offline) is an ordinary failure: cached for the throttle — one spawn — then retried, never latched", async () => {
    const fake = fakeClaude(tempDir("bin"), "is-error");
    let now = NOW;
    const { svc, db, logs } = service({ claudeExecutable: () => fake.path, now: () => now });
    expect((await svc.claudeCodePlan()).source).toBe("none");
    now += 60_000;
    expect((await svc.claudeCodePlan()).source).toBe("none");
    expect(marks(fake.markerPath)).toHaveLength(1);
    expect(db.latch(binaryKey("claude", fake.path)!)).toBeUndefined();
    expect(logs.some((l) => l.includes("\"reason\":\"error\""))).toBe(true);
    now += 5 * 60_000;
    await svc.claudeCodePlan();
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  test("a model-loop answer latches the binary in usage.db: a restart does not ask again, an updated binary does", async () => {
    const bin = tempDir("bin");
    const fake = fakeClaude(bin, "cost");
    const home = tempDir("home");
    let now = NOW;
    const first = service({ home, claudeExecutable: () => fake.path, now: () => now });
    await first.svc.claudeCodePlan();
    expect(first.db.latch(binaryKey("claude", fake.path)!)?.reason).toBe("guard");
    first.db.close();
    // A restart: a new service on the same usage.db.
    now += 3_600_000;
    const second = service({ home, db: new UsageDb(join(home, "usage", "usage.db")), claudeExecutable: () => fake.path, now: () => now });
    expect((await second.svc.claudeCodePlan()).source).toBe("none");
    expect(marks(fake.markerPath)).toHaveLength(1);
    // Claude Code updated (the binary changed): asked again.
    appendFileSync(fake.path, "\n// updated\n");
    now += 3_600_000;
    await second.svc.claudeCodePlan();
    expect(marks(fake.markerPath)).toHaveLength(2);
  });

  test("a run that shows a model turn and then hangs (killed) or exits without a result latches too", async () => {
    for (const mode of ["model-turn-hang", "tool-use-exit"] as const) {
      const fake = fakeClaude(tempDir("bin"), mode);
      const { svc, db } = service({ claudeExecutable: () => fake.path, claudeCliTimeoutMs: 1_500 });
      expect((await svc.claudeCodePlan()).source).toBe("none");
      expect(db.latch(binaryKey("claude", fake.path)!)?.reason).toBe("guard-model-turn");
    }
  });

  test("the invocation carries the hard bounds: at most one turn, no tools", () => {
    const args = [...CLAUDE_USAGE_ARGS];
    expect(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "1"]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).not.toContain("--bare");
  });

  test("the neutral cwd is emptied after each probe", async () => {
    const fake = fakeClaude(tempDir("bin"), "ok");
    const { svc, home } = service({ claudeExecutable: () => fake.path });
    writeFileSync(join(neutralIn(home), "left-behind.txt"), "x");
    await svc.claudeCodePlan();
    expect(require("node:fs").readdirSync(join(home, "neutral"))).toEqual([]);
  });
});

describe("the probes' environment is an allowlist", () => {
  const leaky = {
    ANTHROPIC_API_KEY: "sk-decoy-6e1d", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", OPENAI_API_KEY: "sk-decoy", OPENAI_BASE_URL: "https://example.invalid",
    WINTER_HOME: "/nowhere", WINTER_PROFILE: "dev",
  };
  const allowed = new Set(["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    // added by the OS/runtime to every process, not inherited
    "__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_", "OLDPWD"]);

  test("neither spawn sees an API key, a base URL, a nested-session marker or WINTER_*", async () => {
    const claude = fakeClaude(tempDir("bin"), "ok");
    const codex = fakeCodex(tempDir("bin"), "ok");
    await withEnv(leaky, async () => {
      const { svc } = service({ claudeExecutable: () => claude.path, codexExecutable: () => codex.path });
      expect((await svc.claudeCodePlan()).source).toBe("claude-cli");
      expect((await svc.codexPlan()).source).toBe("codex-app-server");
    });
    for (const m of [...marks(claude.markerPath), ...marks(codex.markerPath)]) {
      for (const k of Object.keys(leaky)) expect(m.env).not.toContain(k);
      for (const k of m.env) expect(allowed.has(k) || k.startsWith("BUN_") || k.startsWith("__")).toBe(true);
    }
  });

  test("probeEnv keeps only the allowlist and the tool's own config dir", () => {
    expect(probeEnv(["CODEX_HOME"], { HOME: "/h", PATH: "/bin", OPENAI_API_KEY: "k", CODEX_HOME: "/c", CODEX_SANDBOX: "x", WINTER_X: "1" }))
      .toEqual({ HOME: "/h", PATH: "/bin", CODEX_HOME: "/c" });
  });
});

describe("binary resolution", () => {
  function exe(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  }

  test("absolute install places first, then ABSOLUTE PATH entries; a relative PATH entry is never searched", () => {
    const root = tempDir("resolve");
    const installed = exe(join(root, "install"), "codex");
    const onPath = exe(join(root, "path"), "codex");
    exe(join(process.cwd(), "node_modules", ".winter-test-relative"), "codex-rel");
    expect(resolveExecutable("codex", undefined, [installed], join(root, "path"))).toBe(installed);
    expect(resolveExecutable("codex", undefined, [join(root, "missing", "codex")], join(root, "path"))).toBe(onPath);
    expect(resolveExecutable("codex-rel", undefined, [], `node_modules/.winter-test-relative:${join(root, "nothing")}`)).toBeUndefined();
    expect(resolveExecutable("codex", undefined, ["relative/codex"], "")).toBeUndefined();
    // An explicit path is authoritative: missing, relative or "off" is none (never a fall-through).
    expect(resolveExecutable("codex", "off", [installed], join(root, "path"))).toBeUndefined();
    expect(resolveExecutable("codex", "relative/codex", [installed], "")).toBeUndefined();
    expect(resolveExecutable("codex", onPath, [installed], "")).toBe(onPath);
    require("node:fs").rmSync(join(process.cwd(), "node_modules", ".winter-test-relative"), { recursive: true, force: true });
  });
});

describe("~/.claude.json", () => {
  const util = { five_hour: { utilization: 42, resets_at: new Date(NOW + 3_600_000).toISOString() } };

  test("re-parsed only when its mtime or size changes", async () => {
    const path = join(tempDir("cj"), ".claude.json");
    claudeJson(path, NOW - 60_000, util);
    const { svc } = service({ claudeJsonPath: path });
    expect((await svc.claudeCodePlan()).windows[0]!.usedPercent).toBe(42);
    await svc.claudeCodePlan();
    expect(svc.claudeFileParses).toBe(1);
    // Same size, same mtime (a rewrite restored to the old stamp): not parsed again.
    const st = require("node:fs").statSync(path);
    claudeJson(path, NOW - 60_000, { five_hour: { utilization: 43, resets_at: util.five_hour.resets_at } });
    utimesSync(path, st.atime, st.mtime);
    expect((await svc.claudeCodePlan()).windows[0]!.usedPercent).toBe(42);
    expect(svc.claudeFileParses).toBe(1);
    // Changed: parsed again.
    claudeJson(path, NOW - 30_000, { five_hour: { utilization: 77, resets_at: util.five_hour.resets_at } });
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect((await svc.claudeCodePlan()).windows[0]!.usedPercent).toBe(77);
    expect(svc.claudeFileParses).toBe(2);
  });

  test("over the size cap it is not read at all, with one fixed log line", async () => {
    const path = join(tempDir("cj"), ".claude.json");
    claudeJson(path, NOW - 60_000, util);
    const { svc, logs } = service({ claudeJsonPath: path, claudeJsonMaxBytes: 64 });
    expect((await svc.claudeCodePlan()).source).toBe("none");
    expect(svc.claudeFileParses).toBe(0);
    expect(logs).toEqual(["[usage] Claude Code's config file is over the size cap; its plan cache is not read {}"]);
    await svc.claudeCodePlan();
    expect(logs).toHaveLength(1);
  });
});
