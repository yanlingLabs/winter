// `McpManager` — since WS-24 a STATUS PROBE for `mcp.list` (see `agent/mcp/manager.ts`'s header): each
// server is connected, its `tools/list` read, and closed again. It registers nothing anywhere (no session
// ever read the `mcp__…` rows it used to write into the daemon's shared registry) and leaves nothing
// running (every session's child connects its own copy).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { McpManager } from "../../../src/agent/mcp/manager";
import { TrustStore } from "../../../src/agent/trust";

// WS-21: the project MCP file is `<root>/.winter/mcp.json` (the repo-root `.mcp.json` is never read).
const writeProjectMcp = (root: string, body: string): void => {
  mkdirSync(join(root, ".winter"), { recursive: true });
  writeFileSync(join(root, ".winter", "mcp.json"), body);
};

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const isMac = process.platform === "darwin";
function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "mcp-mgr-"))); }
const trustNone = (): TrustStore => new TrustStore(join(realDir(), "trust.json"));

/** Whether `pid` is still a live process, waited on briefly (a closed stdio server exits on its own time). */
async function stillRunning(pid: number, withinMs = 3_000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return false; }
    if (Date.now() - t0 > withinMs) return true;
    await Bun.sleep(25);
  }
}

describe.if(isMac)("McpManager (a status probe)", () => {
  test("startAll reports a connected server with its tool names — and leaves nothing running (WS-24)", async () => {
    const pidFile = join(realDir(), "pid");
    const mgr = new McpManager({ trust: trustNone() });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE], env: { WINTER_FAKE_PID_FILE: pidFile } } });
    expect(mgr.list()).toEqual([{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }]);
    expect(existsSync(pidFile)).toBe(true); // it really ran…
    expect(await stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false); // …and the probe closed it
  });

  test("a wrapper-launched server (an npx-style grandchild) is ended with its whole process group", async () => {
    const pidFile = join(realDir(), "pid");
    const mgr = new McpManager({ trust: trustNone() });
    // `sh` stays the parent (the trailing `; true`), so the real server is its CHILD — our grandchild.
    await mgr.startAll({ wrapped: { command: "sh", args: ["-c", `bun run '${FIXTURE}'; true`], env: { WINTER_FAKE_PID_FILE: pidFile } } });
    expect(mgr.list().find((s) => s.name === "wrapped")?.status).toBe("connected");
    expect(await stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test("a server that never answers the handshake is a failed probe within the start timeout, and is killed", async () => {
    const pidFile = join(realDir(), "pid");
    const prev = process.env.WINTER_MCP_START_TIMEOUT_MS;
    process.env.WINTER_MCP_START_TIMEOUT_MS = "500";
    try {
      const mgr = new McpManager({ trust: trustNone() });
      const t0 = Date.now();
      await mgr.startAll({ hung: { command: "sh", args: ["-c", `echo $$ > '${pidFile}'; exec sleep 60`] } });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(mgr.list().find((s) => s.name === "hung")?.status).toBe("failed");
      expect(await stillRunning(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.WINTER_MCP_START_TIMEOUT_MS; else process.env.WINTER_MCP_START_TIMEOUT_MS = prev;
    }
  });

  test("a bad-command server is reported failed; a good one still connects (one bad ≠ dead)", async () => {
    const mgr = new McpManager({ trust: trustNone() });
    await mgr.startAll({ good: { command: "bun", args: ["run", FIXTURE] }, bad: { command: "this-command-does-not-exist-xyz" } });
    expect(mgr.list().find((s) => s.name === "bad")!.status).toBe("failed");
    expect(mgr.list().find((s) => s.name === "good")!.status).toBe("connected");
  });

  test("a server that completes the handshake but hangs on tools/list is a failed probe within the ONE budget (WS-25 fix round 1, I2)", async () => {
    const pidFile = join(realDir(), "pid");
    const prev = process.env.WINTER_MCP_START_TIMEOUT_MS;
    process.env.WINTER_MCP_START_TIMEOUT_MS = "800";
    try {
      const mgr = new McpManager({ trust: trustNone() });
      const t0 = Date.now();
      await mgr.startAll({ slow: { command: "bun", args: ["run", FIXTURE], env: { WINTER_FAKE_HANG_TOOLS_LIST: "1", WINTER_FAKE_PID_FILE: pidFile } } });
      expect(Date.now() - t0).toBeLessThan(5_000); // never the MCP client's 60 s request timeout
      expect(mgr.list()).toEqual([{ name: "slow", status: "failed", toolNames: [], source: "user" }]);
      expect(await stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false); // and it was closed
    } finally {
      if (prev === undefined) delete process.env.WINTER_MCP_START_TIMEOUT_MS; else process.env.WINTER_MCP_START_TIMEOUT_MS = prev;
    }
  });

  test("a server whose tool list repeats a name still probes connected — the probe registers nothing to collide (WS-24)", async () => {
    const mgr = new McpManager({ trust: trustNone() });
    await mgr.startAll({ dup: { command: "bun", args: ["run", FIXTURE], env: { WINTER_FAKE_DUP: "1" } } });
    // WS-25: the probe speaks through the runtime's own MCP client, which keeps the FIRST of a repeated
    // tool name (the listing a session's child sees) — so the status line reports what a session gets.
    expect(mgr.list().find((s) => s.name === "dup")).toMatchObject({ status: "connected", toolNames: ["echo"] });
  });
});

function projDir(withServer = true, env?: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-proj-")));
  if (withServer) writeProjectMcp(dir, JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", FIXTURE], ...(env ? { env } : {}) } } }));
  return dir;
}

describe.if(isMac)("McpManager.ensureProject", () => {
  test("UNTRUSTED project → nothing probed or recorded (SECURITY); probed after trust", async () => {
    const dir = projDir();
    const trust = trustNone();
    const mgr = new McpManager({ trust });
    await mgr.ensureProject(dir);
    expect(mgr.list(dir)).toEqual([]); // not spawned while untrusted
    // and NOT recorded — retries after trust:
    trust.trust(dir);
    await mgr.ensureProject(dir);
    expect(mgr.list(dir)).toEqual([{ name: "proj", status: "connected", toolNames: ["echo"], source: "project" }]);
  });

  test("TRUSTED project → probed connected, and not left running", async () => {
    const pidFile = join(realDir(), "pid");
    const dir = projDir(true, { WINTER_FAKE_PID_FILE: pidFile });
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust });
    await mgr.ensureProject(dir);
    expect(mgr.list(dir).find((s) => s.name === "proj")).toMatchObject({ status: "connected", toolNames: ["echo"], source: "project" });
    expect(await stillRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test("malformed .winter/mcp.json → skip, no throw; idempotent 2nd call", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-bad-")));
    writeProjectMcp(dir, "{ not json");
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust });
    await expect(mgr.ensureProject(dir)).resolves.toBeUndefined();
    await mgr.ensureProject(dir); // idempotent
    expect(mgr.list(dir)).toEqual([]);
  });

  // PARITY FIX (controller-directed): `doEnsureProject` used to validate the WHOLE `mcpServers` map
  // in one `.parse()` call (stdio-only) — a single http/sse (or otherwise malformed) entry anywhere
  // failed the whole parse and silently dropped every OTHER configured project server. Per-entry
  // validation (`parseProjectMcpServers`) fixes that: the stdio entry below still probes despite its siblings.
  test("mixed file (stdio + http + sse + one malformed entry): the stdio entry is probed; http/sse are recognized but not probed (no in-daemon client); the malformed one is skipped — one log line each", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-mixed-")));
    writeProjectMcp(dir, JSON.stringify({
      mcpServers: {
        proj: { command: "bun", args: ["run", FIXTURE] },
        httpOne: { type: "http", url: "https://example.com/mcp" },
        sseOne: { type: "sse", url: "https://example.com/sse" },
        broken: { type: "stdio" }, // missing `command` — invalid
      },
    }));
    const trust = trustNone(); trust.trust(dir);
    const logs: string[] = [];
    const mgr = new McpManager({ trust, log: (m) => logs.push(m) });
    await mgr.ensureProject(dir);
    expect(mgr.list(dir).find((s) => s.name === "proj")?.status).toBe("connected");
    expect(mgr.list(dir).find((s) => s.name === "httpOne")).toBeUndefined();
    expect(mgr.list(dir).find((s) => s.name === "sseOne")).toBeUndefined();
    expect(mgr.list(dir).find((s) => s.name === "broken")).toBeUndefined();
    expect(logs.filter((m) => m.includes("httpOne")).length).toBe(1);
    expect(logs.filter((m) => m.includes("sseOne")).length).toBe(1);
    expect(logs.filter((m) => m.includes("broken")).length).toBe(1);
  });

  test("the SAME mixed file, untrusted, still probes nothing at all — the trust gate is unchanged by the per-entry fix", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-mixed-untrusted-")));
    writeProjectMcp(dir, JSON.stringify({
      mcpServers: {
        proj: { command: "bun", args: ["run", FIXTURE] },
        httpOne: { type: "http", url: "https://example.com/mcp" },
        broken: { type: "stdio" },
      },
    }));
    const mgr = new McpManager({ trust: trustNone() }); // never trusted
    await mgr.ensureProject(dir);
    expect(mgr.list(dir)).toEqual([]);
  });

  test("concurrent ensureProject for the same dir shares one in-flight run (no double probe)", async () => {
    const dir = projDir();
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust });
    const p1 = mgr.ensureProject(dir);
    const p2 = mgr.ensureProject(dir);
    expect(p2).toBe(p1); // second call JOINS the first (in-flight guard)
    await Promise.all([p1, p2]);
    expect(mgr.list(dir).filter((s) => s.name === "proj").length).toBe(1);
  });

  // MEDIUM (fix wave, pre-merge review, finding 3): `ensureProject` is called merely to RENDER
  // `mcp.list {cwd}` (`ipc/server.ts`'s `mcpList` handler) — it must never spawn a disabled server.
  test("a name in settings.mcp.disabled is NEVER spawned by ensureProject, even in a trusted project", async () => {
    const pidFile = join(realDir(), "pid");
    const dir = projDir(true, { WINTER_FAKE_PID_FILE: pidFile });
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust, disabled: () => new Set(["proj"]) });
    await mgr.ensureProject(dir);
    expect(existsSync(pidFile)).toBe(false); // never spawned
    // Still reported, so mcp.list's own settings overlay has a row to rewrite to "disabled".
    expect(mgr.list(dir).find((s) => s.name === "proj")?.status).not.toBe("connected");
  });

  test("mcp.disabled on an http/sse project entry changes nothing — never probed either way (no placeholder row)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-disabled-http-")));
    writeProjectMcp(dir, JSON.stringify({
      mcpServers: { httpDisabled: { type: "http", url: "https://example.com/mcp" }, httpEnabled: { type: "http", url: "https://example.com/mcp2" } },
    }));
    const trust = trustNone(); trust.trust(dir);
    const logs: string[] = [];
    const mgr = new McpManager({ trust, log: (m) => logs.push(m), disabled: () => new Set(["httpDisabled"]) });
    await mgr.ensureProject(dir);
    expect(mgr.list(dir).find((s) => s.name === "httpDisabled")).toBeUndefined();
    expect(mgr.list(dir).find((s) => s.name === "httpEnabled")).toBeUndefined();
    expect(logs.filter((m) => m.includes("httpDisabled")).length).toBe(1);
    expect(logs.filter((m) => m.includes("httpEnabled")).length).toBe(1);
  });

  test("a name NOT in settings.mcp.disabled still probes normally (the filter is name-specific)", async () => {
    const dir = projDir();
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust, disabled: () => new Set(["some-other-server"]) });
    await mgr.ensureProject(dir);
    expect(mgr.list(dir).find((s) => s.name === "proj")?.status).toBe("connected");
  });
});

describe.if(isMac)("McpManager.stopServer / startOneUserServer (mcp.disable / mcp.enable)", () => {
  test("stopServer drops a USER-tier server's recorded status", async () => {
    const mgr = new McpManager({ trust: trustNone() });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    mgr.stopServer("fake");
    expect(mgr.list().find((s) => s.name === "fake")).toBeUndefined();
  });

  test("stopServer drops a PROJECT-tier server's recorded row", async () => {
    const dir = projDir();
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust });
    await mgr.ensureProject(dir);
    mgr.stopServer("proj");
    expect(mgr.list(dir).find((s) => s.name === "proj")).toBeUndefined();
  });

  test("a name with no record anywhere is a no-op — never throws", () => {
    const mgr = new McpManager({ trust: trustNone() });
    expect(() => mgr.stopServer("never-existed")).not.toThrow();
  });

  test("startOneUserServer re-probes: an already-known server stays connected, a dropped one comes back", async () => {
    const mgr = new McpManager({ trust: trustNone() });
    const cfg = { command: "bun", args: ["run", FIXTURE] };
    await mgr.startAll({ fake: cfg });
    await mgr.startOneUserServer("fake", cfg); // never disabled — must not turn into "failed"
    expect(mgr.list().find((s) => s.name === "fake")?.status).toBe("connected");
    mgr.stopServer("fake");
    await mgr.startOneUserServer("fake", cfg);
    expect(mgr.list()).toEqual([{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }]);
  });
});

describe.if(isMac)("McpManager.list(cwd) + stopAll", () => {
  test("list(trusted cwd) includes the project server (source project); list() only user; stopAll forgets both", async () => {
    const dir = projDir();
    const trust = trustNone(); trust.trust(dir);
    const mgr = new McpManager({ trust });
    await mgr.startAll({ fake: { command: "bun", args: ["run", FIXTURE] } });
    await mgr.ensureProject(dir);
    expect(mgr.list().some((s) => s.source === "project")).toBe(false); // no cwd → no project
    expect(mgr.list(dir).find((s) => s.name === "proj")).toMatchObject({ status: "connected", source: "project" });
    mgr.stopAll();
    expect(mgr.list(dir)).toEqual([]);
  });
});
