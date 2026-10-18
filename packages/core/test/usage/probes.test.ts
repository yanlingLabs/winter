// The plan probes' safety rails (`docs/claude/usage.md`), FAKE executables only: the `/usage` latch (only a model-loop
// answer latches; an ordinary error is retried after the throttle), the latch persisted per exact binary, the hard
// bounds on the invocation, the scrubbed environment, the binary resolution order, and `~/.claude.json`'s re-parse
// and size rules.
import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService, binaryKey, removeProbeDir, type UsageServiceDeps } from "../../src/usage/service";
import { CLAUDE_USAGE_ARGS } from "../../src/usage/claude-code";
import { probeEnv, resolveExecutable } from "../../src/usage/spawn-lines";
import { claudeJson, fakeClaude, fakeCodex, probeRootIn, tempDir } from "./fixtures";

const pricer = new UsagePricer();
const NOW = Date.now();
/** An installed Claude Code that answers nothing (exits at once): the cache rung's tests. */
const FAILING = "/usr/bin/false";

function service(over: Partial<UsageServiceDeps> & { db?: UsageDb; home?: string } = {}) {
  const home = over.home ?? tempDir("home");
  const db = over.db ?? new UsageDb(join(home, "usage", "usage.db"));
  const logs: string[] = [];
  const svc = new UsageService({
    db, pricer, tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined, claudeExecutable: () => undefined,
    winterCodexWindows: () => [], probeRoot: () => probeRootIn(home), ingestEveryMs: 0, planWaitMs: 20_000,
    log: { warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`), info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`) },
    ...over,
  });
  return { home, db, svc, logs };
}

function marks(markerPath: string): Array<{ argv: string[]; cwd: string; env: string[] }> {
  // Claude Code's hourly `auth status` (the plan's name) is not a `/usage` run: not counted here.
  return existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((m: { argv: string[] }) => m.argv[0] !== "auth") : [];
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

  test("a result naming no command (an early startup error, 0 turns, 0 cost) is ordinary: never latched", async () => {
    const fake = fakeClaude(tempDir("bin"), "no-local-command");
    const { svc, db } = service({ claudeExecutable: () => fake.path });
    expect((await svc.claudeCodePlan()).source).toBe("none");
    expect(db.latch(binaryKey("claude", fake.path)!)).toBeUndefined();
  });

  test("the latch key names the binary by a hash, never its plaintext path", () => {
    const fake = fakeClaude(tempDir("bin"), "ok");
    const key = binaryKey("claude", fake.path)!;
    expect(key).toMatch(/^claude:[0-9a-f]{32}:\d+:\d+$/);
    expect(key.includes(fake.path)).toBe(false);
  });
});

describe("each probe runs in its own directory, and nothing outside it is ever deleted", () => {
  function outsideWithFiles(): string {
    const outside = tempDir("outside");
    writeFileSync(join(outside, "precious.txt"), "keep me");
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "also.txt"), "keep me too");
    return outside;
  }
  const intact = (outside: string) => {
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(outside, "sub", "also.txt"), "utf8")).toBe("keep me too");
  };

  test("a probe that plants a symlink to a directory outside: its own dir goes, the link's target stays whole", async () => {
    const outside = outsideWithFiles();
    const fake = fakeClaude(tempDir("bin"), "plant-symlink", outside);
    const { svc, home } = service({ claudeExecutable: () => fake.path });
    expect((await svc.claudeCodePlan()).source).toBe("claude-cli");
    const cwd = marks(fake.markerPath)[0]!.cwd;
    expect(existsSync(cwd)).toBe(false);
    intact(outside);
    expect(require("node:fs").readdirSync(join(home, "usage")).filter((n: string) => n.startsWith("probe-"))).toEqual([]);
  });

  test("a pre-existing `neutral` symlink under the usage dir is never used nor followed", async () => {
    const outside = outsideWithFiles();
    const home = tempDir("home");
    mkdirSync(join(home, "usage"), { recursive: true });
    require("node:fs").symlinkSync(outside, join(home, "usage", "neutral"));
    const fake = fakeClaude(tempDir("bin"), "ok");
    const { svc } = service({ home, claudeExecutable: () => fake.path });
    await svc.claudeCodePlan();
    expect(marks(fake.markerPath)[0]!.cwd.includes("neutral")).toBe(false);
    intact(outside);
  });

  test("removeProbeDir refuses a symlink and anything outside the root", () => {
    const root = tempDir("root");
    const outside = outsideWithFiles();
    const link = join(root, "probe-link");
    require("node:fs").symlinkSync(outside, link);
    expect(removeProbeDir(root, link)).toBe(false);
    expect(removeProbeDir(root, outside)).toBe(false);
    expect(removeProbeDir(root, root)).toBe(false);
    intact(outside);
    const own = join(root, "probe-own");
    mkdirSync(own);
    writeFileSync(join(own, "x"), "x");
    expect(removeProbeDir(root, own)).toBe(true);
    expect(existsSync(own)).toBe(false);
  });
});

describe("the probes' environment is an allowlist", () => {
  const leaky = {
    ANTHROPIC_API_KEY: "sk-decoy-6e1d", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "https://example.invalid", CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", OPENAI_API_KEY: "sk-decoy", OPENAI_BASE_URL: "https://example.invalid",
    WINTER_HOME: "/nowhere", WINTER_PROFILE: "dev",
  };
  const allowed = new Set(["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
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

  test("proxy and CA settings DO reach the probe", async () => {
    const claude = fakeClaude(tempDir("bin"), "ok");
    await withEnv({ HTTPS_PROXY: "http://proxy.invalid:3128", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" }, async () => {
      const { svc } = service({ claudeExecutable: () => claude.path });
      await svc.claudeCodePlan();
    });
    const env = marks(claude.markerPath)[0]!.env;
    for (const k of ["HTTPS_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS"]) expect(env).toContain(k);
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
    const { svc } = service({ claudeJsonPath: path, claudeExecutable: () => FAILING });
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

  test("the cap holds on the bytes actually read, and the warning is logged once per process", async () => {
    const path = join(tempDir("cj"), ".claude.json");
    claudeJson(path, NOW - 60_000, util);
    const { claudePlanFromCacheFile } = await import("../../src/usage/claude-code");
    expect(await claudePlanFromCacheFile(path, NOW, 64)).toBe("over-cap");
    expect(typeof (await claudePlanFromCacheFile(path, NOW, 1 << 20))).toBe("object");
    const { svc, logs } = service({ claudeJsonPath: path, claudeJsonMaxBytes: 64, claudeExecutable: () => FAILING });
    await svc.claudeCodePlan();
    // Changed (still over): no second line.
    claudeJson(path, NOW - 30_000, { ...util, seven_day: { utilization: 1, resets_at: util.five_hour.resets_at } });
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    await svc.claudeCodePlan();
    expect(logs.filter((l) => l.includes("size cap"))).toHaveLength(1);
  });

  test("over the size cap it is not read at all, with one fixed log line", async () => {
    const path = join(tempDir("cj"), ".claude.json");
    claudeJson(path, NOW - 60_000, util);
    const { svc, logs } = service({ claudeJsonPath: path, claudeJsonMaxBytes: 64, claudeExecutable: () => FAILING });
    expect((await svc.claudeCodePlan()).source).toBe("none");
    expect(svc.claudeFileParses).toBe(0);
    expect(logs.filter((l) => !l.includes("claude /usage gave no plan reading"))).toEqual(["[usage] Claude Code's config file is over the size cap; its plan cache is not read {}"]);
    await svc.claudeCodePlan();
    expect(logs.filter((l) => l.includes("size cap"))).toHaveLength(1);
  });
});
