// ComputerV2 Phase 4 — the headless pool over a FAKE Winter Headless on a real pipe (`headless-fake-helper.ts`, run by
// bun with fds 3/4 exactly as the daemon runs the real helper): the lazy start, the budget and the memory guard, the
// signature and protocol checks, a crash, the idle exit, the setting turned off, a session's context disposed, the
// daemon's stop, and the boot sweep.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationFailure } from "../../src/computer-use/errors";
import {
  headlessCacheRoot, headlessPidPath, HeadlessPool, HEADLESS_TABS_GLOBAL, HEADLESS_TABS_PER_SESSION, sweepHeadless, type HeadlessPoolDeps,
} from "../../src/computer-use/browser/headless/pool";
import { spawnEngineProcess } from "../../src/computer-use/browser/headless/winter-engine";
import type { PrimitiveMetric } from "../../src/computer-use/telemetry";
import { TransportError } from "../../src/computer-use/browser/transport";

const FAKE = join(import.meta.dir, "headless-fake-helper.ts");

interface Rig {
  pool: HeadlessPool;
  home: string;
  log: string;
  spawned: number;
  metrics: PrimitiveMetric[];
  enabled: { on: boolean };
  commands(): Array<{ op: string; params: Record<string, unknown> }>;
}

const pools: HeadlessPool[] = [];
afterEach(() => { for (const p of pools.splice(0)) p.stop(); });

function rig(o: { mode?: string; verify?: boolean; rss?: number; idleExitMs?: number; enabledPollMs?: number; missing?: boolean } = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), "winter-headless-home-"));
  const log = join(home, "fake.log");
  const metrics: PrimitiveMetric[] = [];
  const enabled = { on: true };
  const r: Rig = {
    pool: undefined as unknown as HeadlessPool, home, log, spawned: 0, metrics, enabled,
    commands: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { op: string; params: Record<string, unknown> }) : []),
  };
  const deps: HeadlessPoolDeps = {
    home,
    enabled: () => enabled.on,
    resolve: () => (o.missing === true ? { missing: "Winter's headless browser is missing — reinstall Winter" } : { engine: "winter", app: "/fake/Winter Headless.app", executable: "/fake/Winter Headless.app/Contents/MacOS/Winter Headless", requirement: "fake requirement" }),
    spawn: (_cmd, args) => { r.spawned++; return spawnEngineProcess("/bin/sh", ["-c", 'exec "$0" "$@" 0<&3 1>&4 3<&- 4>&-', process.execPath, FAKE, `--fake-mode=${o.mode ?? "normal"}`, `--fake-log=${log}`, ...args]); },
    verify: () => o.verify ?? true,
    rssOf: () => o.rss ?? 100 * 1024 * 1024,
    metric: (m) => metrics.push(m),
    ...(o.idleExitMs === undefined ? {} : { idleExitMs: o.idleExitMs }),
    ...(o.enabledPollMs === undefined ? {} : { enabledPollMs: o.enabledPollMs }),
    timeouts: { hello: 5_000 },
  };
  r.pool = new HeadlessPool(deps);
  pools.push(r.pool);
  return r;
}

async function until(what: string, pred: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) { return err as Error; }
  throw new Error("expected a failure");
}

describe("the headless pool's engine", () => {
  test("nothing starts to answer a listing; the first tab starts the helper once, over its pipe", async () => {
    const r = rig();
    expect(await r.pool.listTabs()).toEqual([]);
    expect(r.spawned).toBe(0);
    expect(r.pool.connected).toBe(true);
    const [a, b] = await Promise.all([
      r.pool.createTab({ sessionId: "s1", url: "https://a.example/" }),
      r.pool.createTab({ sessionId: "s1", url: "https://b.example/" }),
    ]);
    expect(r.spawned).toBe(1);
    expect(a.tabKey).toMatch(/^w-[0-9a-f]{12}$/);
    expect(a).toMatchObject({ url: "https://a.example/", agent: true, active: false, sessionId: "s1" });
    expect(b.tabKey).not.toBe(a.tabKey);
    expect(r.pool.running).toBe(true);
    // The helper got its own cache root under <home>/cache/headless-cef, and the pid file names it.
    const started = r.commands().find((c) => c.op === "started")!;
    expect(String(started.params.cacheRoot).startsWith(headlessCacheRoot(r.home))).toBe(true);
    const pidFile = JSON.parse(readFileSync(headlessPidPath(r.home), "utf8")) as { pid: number };
    expect(pidFile.pid).toBe(r.pool.pid!);
    expect(r.metrics.find((m) => m.primitive === "headless.launch")).toMatchObject({ headlessEngine: "winter", headlessVersion: "0.0.0-fake", backend: "headless" });
    // A tab of the session lists; another session sees none of it.
    expect((await r.pool.listTabs({ sessionId: "s1" })).map((t) => t.tabKey).sort()).toEqual([a.tabKey, b.tabKey].sort());
    expect(await r.pool.listTabs({ sessionId: "s2" })).toEqual([]);
    expect((await r.pool.listTabs({ sessionId: "s1" }))[0]!.title).toMatch(/^live /);
  });

  test("tab.ensure carries the url only when it creates; attach re-holds without one, in the tab's own session only", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    expect(await r.pool.attach(t.tabKey, { sessionId: "s1" })).toEqual({ viewport: [1280, 800], dpr: 1 });
    const ensures = r.commands().filter((c) => c.op === "tab.ensure");
    expect(ensures[0]!.params).toMatchObject({ sessionId: "s1", url: "https://a.example/" });
    expect(ensures[1]!.params.url).toBeUndefined();
    const other = await failure(r.pool.attach(t.tabKey, { sessionId: "s2" }));
    expect((other as TransportError).code).toBe("not_allowed");
    expect(((await failure(r.pool.attach("w-000000000000", { sessionId: "s1" }))) as TransportError).code).toBe("tab_gone");
  });

  test("sends stay on the allowlist; events leave only for the pool's own tabs, allowlisted and reduced", async () => {
    const r = rig();
    const t = await r.pool.createTab({ sessionId: "s1", url: "http://events.test/" });
    const events: Array<{ tabKey: string; method: string; cdpSessionId?: string }> = [];
    r.pool.onEvent((e) => events.push({ tabKey: e.tabKey, method: e.method, ...(e.cdpSessionId === undefined ? {} : { cdpSessionId: e.cdpSessionId }) }));
    await until("events", () => events.length >= 2);
    expect(events).toEqual([{ tabKey: t.tabKey, method: "Page.loadEventFired" }, { tabKey: t.tabKey, method: "Runtime.executionContextCreated", cdpSessionId: "S1" }]);
    expect(((await failure(r.pool.send(t.tabKey, "Browser.close"))) as TransportError).code).toBe("not_allowed");
    expect(r.commands().some((c) => c.op === "cdp.send" && c.params.method === "Browser.close")).toBe(false);
    expect(await r.pool.send<unknown>(t.tabKey, "Runtime.evaluate", { expression: "1+1", contextId: 3 })).toEqual({ result: { type: "number", value: 2 } });
    expect(((await failure(r.pool.subscribe(t.tabKey, ["Not.anEvent"]))) as TransportError).code).toBe("not_allowed");
  });

  test("an engine other than Winter's own is refused", async () => {
    const r = rig();
    expect(((await failure(r.pool.createTab({ sessionId: "s1", url: "https://a.example/", engine: "chrome" }))) as TransportError).code).toBe("not_allowed");
    expect(r.spawned).toBe(0);
  });
});

describe("the budget (D3)", () => {
  test(`at most ${HEADLESS_TABS_PER_SESSION} open tabs per session and ${HEADLESS_TABS_GLOBAL} in all — capacity, nothing closed`, async () => {
    const r = rig();
    await Promise.all(Array.from({ length: HEADLESS_TABS_PER_SESSION }, (_, i) => r.pool.createTab({ sessionId: "s1", url: `https://a.example/${i}` })));
    const over = await failure(r.pool.createTab({ sessionId: "s1", url: "https://a.example/over" }));
    expect((over as TransportError).code).toBe("capacity");
    expect(over.message).toMatch(/this session already has 8 headless tabs open — close one with tab\.close\(\)/);
    for (const s of ["s2", "s3"]) {
      await Promise.all(Array.from({ length: HEADLESS_TABS_PER_SESSION }, (_, i) => r.pool.createTab({ sessionId: s, url: `https://b.example/${i}` })));
    }
    expect(r.pool.tabCount()).toBe(HEADLESS_TABS_GLOBAL);
    const global = await failure(r.pool.createTab({ sessionId: "s4", url: "https://c.example/" }));
    expect((global as TransportError).code).toBe("capacity");
    expect(global.message).toMatch(/already has 24 tabs open/);
    expect(r.pool.tabCount()).toBe(HEADLESS_TABS_GLOBAL);
  });

  test("concurrent opens can't pass the per-session budget together", async () => {
    const r = rig();
    const results = await Promise.allSettled(Array.from({ length: HEADLESS_TABS_PER_SESSION + 3 }, (_, i) => r.pool.createTab({ sessionId: "s1", url: `https://a.example/${i}` })));
    expect(results.filter((x) => x.status === "fulfilled").length).toBe(HEADLESS_TABS_PER_SESSION);
    expect(results.filter((x) => x.status === "rejected").every((x) => ((x as PromiseRejectedResult).reason as TransportError).code === "capacity")).toBe(true);
  });

  test("past 3 GB in the helper's process tree a new tab is refused", async () => {
    const r = rig({ rss: 4 * 1024 * 1024 * 1024 });
    await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const e = await failure(r.pool.createTab({ sessionId: "s1", url: "https://b.example/" }));
    expect((e as TransportError).code).toBe("capacity");
    expect(e.message).toMatch(/using too much memory — close some tabs/);
  });
});

describe("the checks before anything is sent", () => {
  test("a process that is not Winter's signed helper is killed and refused", async () => {
    const r = rig({ verify: false });
    const e = await failure(r.pool.createTab({ sessionId: "s1", url: "https://a.example/" }));
    expect((e as AutomationFailure).kind).toBe("BrowserUnavailable");
    expect(e.message).toMatch(/not signed by Winter — reinstall Winter/);
    expect(r.pool.running).toBe(false);
    expect(r.commands().some((c) => c.op === "tab.ensure")).toBe(false);
  });

  test("a helper of another protocol is refused", async () => {
    const r = rig({ mode: "bad-protocol" });
    const e = await failure(r.pool.createTab({ sessionId: "s1", url: "https://a.example/" }));
    expect(e.message).toMatch(/another version of Winter/);
  });

  test("a helper that never says hello is refused in time", async () => {
    const r = rig({ mode: "no-hello" });
    (r.pool as unknown as { deps: HeadlessPoolDeps }).deps.timeouts = { hello: 300 };
    const e = await failure(r.pool.createTab({ sessionId: "s1", url: "https://a.example/" }));
    expect(e.message).toMatch(/did not start/);
  });

  test("missing, or turned off: not offered, with its reason, and nothing starts", async () => {
    const missing = rig({ missing: true });
    expect(missing.pool.connected).toBe(false);
    expect(missing.pool.reason).toBe("Winter's headless browser is missing — reinstall Winter");
    expect(((await failure(missing.pool.createTab({ sessionId: "s1", url: "https://a.example/" }))) as TransportError).code).toBe("disconnected");
    const off = rig();
    off.enabled.on = false;
    expect(off.pool.connected).toBe(false);
    expect(off.pool.reason).toBe("turned off in Settings");
    expect(off.spawned + missing.spawned).toBe(0);
  });
});

describe("the helper's life", () => {
  test("a crash loses every tab (crashed), and the next tab starts a fresh helper", async () => {
    const r = rig();
    const gone: Array<[string, string]> = [];
    r.pool.onTabGone((k, why) => gone.push([k, why]));
    const a = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const b = await r.pool.createTab({ sessionId: "s2", url: "http://crash.test/" });
    await until("the crash", () => !r.pool.running);
    expect(gone.sort()).toEqual(([[a.tabKey, "crashed"], [b.tabKey, "crashed"]] as Array<[string, string]>).sort());
    expect(r.metrics.find((m) => m.primitive === "headless.exit")).toMatchObject({ exitReason: "crash" });
    expect(existsSync(headlessPidPath(r.home))).toBe(false);
    expect(((await failure(r.pool.send(a.tabKey, "Page.enable"))) as TransportError).code).toBe("tab_gone");
    await r.pool.createTab({ sessionId: "s1", url: "https://again.example/" });
    expect(r.spawned).toBe(2);
  });

  test("a renderer crash loses only its tab", async () => {
    const r = rig();
    const gone: Array<[string, string]> = [];
    r.pool.onTabGone((k, why) => gone.push([k, why]));
    const keep = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const lost = await r.pool.createTab({ sessionId: "s1", url: "http://renderer.test/" });
    await until("the renderer crash", () => gone.length === 1);
    expect(gone).toEqual([[lost.tabKey, "crashed"]]);
    expect(r.pool.running).toBe(true);
    expect((await r.pool.listTabs({ sessionId: "s1" })).map((t) => t.tabKey)).toEqual([keep.tabKey]);
  });

  test("with no tab for the idle time the helper exits on its pipe's EOF — still offered, started again on demand", async () => {
    const r = rig({ idleExitMs: 100 });
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const cache = readdirSync(headlessCacheRoot(r.home));
    expect(cache.length).toBe(1);
    await r.pool.closeTab(t.tabKey);
    expect(r.commands().some((c) => c.op === "tab.close")).toBe(true);
    await until("the idle exit", () => !r.pool.running);
    expect(r.metrics.find((m) => m.primitive === "headless.exit")).toMatchObject({ exitReason: "idle" });
    expect(readdirSync(headlessCacheRoot(r.home))).toEqual([]);
    expect(r.pool.connected).toBe(true);
    await r.pool.createTab({ sessionId: "s1", url: "https://b.example/" });
    expect(r.spawned).toBe(2);
  });

  test("turned off in Settings while running: the helper stops and its tabs read closed", async () => {
    const r = rig({ enabledPollMs: 50 });
    const gone: Array<[string, string]> = [];
    r.pool.onTabGone((k, why) => gone.push([k, why]));
    const t = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    r.enabled.on = false;
    await until("the stop", () => !r.pool.running);
    expect(gone).toEqual([[t.tabKey, "closed"]]);
    expect(r.metrics.find((m) => m.primitive === "headless.exit")).toMatchObject({ exitReason: "disabled" });
  });

  test("a session's runtime ending disposes its context and forgets only its tabs", async () => {
    const r = rig();
    const gone: string[] = [];
    r.pool.onTabGone((k) => gone.push(k));
    const mine = await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    const theirs = await r.pool.createTab({ sessionId: "s2", url: "https://b.example/" });
    r.pool.disposeSession("s1");
    expect(gone).toEqual([mine.tabKey]);
    await until("context.dispose", () => r.commands().some((c) => c.op === "context.dispose"));
    expect(r.commands().find((c) => c.op === "context.dispose")!.params).toEqual({ sessionId: "s1" });
    expect((await r.pool.listTabs()).map((t) => t.tabKey)).toEqual([theirs.tabKey]);
  });

  test("the daemon's stop kills it at once and removes what this run made", async () => {
    const r = rig();
    await r.pool.createTab({ sessionId: "s1", url: "https://a.example/" });
    r.pool.stop();
    expect(existsSync(headlessPidPath(r.home))).toBe(false);
    expect(readdirSync(headlessCacheRoot(r.home))).toEqual([]);
    await until("the exit", () => !r.pool.running);
    expect(r.pool.connected).toBe(false);
    expect(r.metrics.find((m) => m.primitive === "headless.exit")).toMatchObject({ exitReason: "stop" });
  });
});

describe("the boot sweep", () => {
  test("kills the helper an earlier daemon left (pid and start time both match) and clears the cache", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-headless-sweep-"));
    mkdirSync(join(home, "run"), { recursive: true });
    mkdirSync(join(headlessCacheRoot(home), "abc"), { recursive: true });
    writeFileSync(headlessPidPath(home), JSON.stringify({ pid: 4242, startSec: 1000 }));
    const killed: number[] = [];
    sweepHeadless(home, { startOf: () => 1000, kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([4242]);
    expect(existsSync(headlessPidPath(home))).toBe(false);
    expect(existsSync(headlessCacheRoot(home))).toBe(false);
  });

  test("a pid reused since (another start time), or gone, is never killed", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-headless-sweep-"));
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(headlessPidPath(home), JSON.stringify({ pid: 4242, startSec: 1000 }));
    const killed: number[] = [];
    sweepHeadless(home, { startOf: () => 2000, kill: (pid) => killed.push(pid) });
    writeFileSync(headlessPidPath(home), JSON.stringify({ pid: 4242, startSec: 1000 }));
    sweepHeadless(home, { startOf: () => undefined, kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([]);
  });
});
