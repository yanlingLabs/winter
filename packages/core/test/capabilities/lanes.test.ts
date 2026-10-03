// Agent SDK 0.0.40 (user ruling 2026-10-02): `Computer` and `Browser` each run in their own CONCURRENCY
// LANE (`McpSdkServerConfig.toolLanes`): two `Computer` calls never overlap (the SDK keeps a lane's calls one
// at a time, in call order), but a `Computer` call, a `Browser` call and any read-only call may. Pinned here:
// the lanes the two servers declare (and that no other capability tool has one), and that the DAEMON side
// tolerates a `Computer` call and a `Browser` call in flight at the same time.
import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { BROWSER_CANCEL_SETTLE_MS, type BrowserToolDeps } from "../../src/agent/tools/browser";
import type { ComputerUseService, CuActResult } from "../../src/agent/computer-use";
import type { PanelCommandOutcome } from "../../src/panel/commands";
import type { PanelTabState } from "../../src/panel/store";
import { browserCapability } from "../../src/capabilities/browser";
import { computerCapability } from "../../src/capabilities/computer";
import { WINTER_CAPABILITY_TOOLS } from "../../src/capabilities/names";
import { sessionsCapability } from "../../src/capabilities/sessions";
import type { ListSessionsDeps } from "../../src/agent/tools/list-sessions";
import type { CapabilitySession } from "../../src/capabilities/server";

const session = (over: Partial<CapabilitySession> = {}): CapabilitySession => ({ sessionId: "s_lanes", mode: "code", cwd: "/tmp", roots: ["/tmp"], ...over });

function browserDeps(): BrowserToolDeps {
  const tabs = { tabs: [{ tabId: "t1", kind: "web", url: "https://example.com" }], activeTabId: "t1" } as PanelTabState;
  return {
    tabs: () => tabs,
    openTab: () => "tab_1",
    dispatch: () => ({ commandId: "pcmd_1", settled: Promise.resolve<PanelCommandOutcome>({ kind: "result", ok: true, result: "clicked" }) }),
    harnesses: () => [{ clientName: "orb", role: "harness" }],
  };
}

describe("capability concurrency lanes", () => {
  test("Computer and Browser each declare their own lane; no other capability tool has one", () => {
    const withLane = Object.entries(WINTER_CAPABILITY_TOOLS).filter(([, facts]) => "lane" in facts).map(([name, facts]) => [name, (facts as { lane: string }).lane]);
    expect(withLane).toEqual([
      ["mcp__winter__computer__computer", "computer"],
      ["mcp__winter__browser__browser", "browser"],
    ]);
    expect(computerCapability(session(), { computerUse: () => undefined }).toolLanes).toEqual({ computer: "computer" });
    expect(browserCapability(session(), { browser: browserDeps() }).toolLanes).toEqual({ browser: "browser" });
  });

  test("an interrupted Browser call returns only once its panel command has settled -- the lane is never freed under it", async () => {
    // The panel settles the command 300 ms after the cancel; the call must not return before that.
    let settle!: (o: PanelCommandOutcome) => void;
    let settledAt = 0;
    const settled = new Promise<PanelCommandOutcome>((r) => (settle = r)).then((o) => { settledAt = performance.now(); return o; });
    const deps: BrowserToolDeps = { ...browserDeps(), dispatch: () => ({ commandId: "pcmd_2", settled }) };
    const browser = browserCapability(session(), { browser: deps }).instance as WinterMcpServerInstance;
    const cancel = new AbortController();
    const call = browser.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" }, { signal: cancel.signal });
    await Bun.sleep(5);
    cancel.abort();
    setTimeout(() => settle({ kind: "result", ok: true, result: "clicked" }), 300);
    const result = await call;
    const returnedAt = performance.now();
    expect(settledAt).toBeGreaterThan(0);
    expect(returnedAt).toBeGreaterThanOrEqual(settledAt);
    expect(JSON.stringify(result.content)).toContain("clicked"); // what the panel really did (the model already got [interrupted])
  });

  test("an interrupted Browser call whose command never settles is released after BROWSER_CANCEL_SETTLE_MS, not before", async () => {
    const deps: BrowserToolDeps = { ...browserDeps(), dispatch: () => ({ commandId: "pcmd_3", settled: new Promise<PanelCommandOutcome>(() => {}) }) };
    const browser = browserCapability(session(), { browser: deps }).instance as WinterMcpServerInstance;
    const cancel = new AbortController();
    const call = browser.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" }, { signal: cancel.signal });
    await Bun.sleep(5);
    const abortedAt = performance.now();
    cancel.abort();
    await call;
    const waited = performance.now() - abortedAt;
    expect(waited).toBeGreaterThanOrEqual(BROWSER_CANCEL_SETTLE_MS - 50);
    expect(waited).toBeLessThan(BROWSER_CANCEL_SETTLE_MS + 1_500);
  }, 10_000);

  test("a Browser call in a session that is ENDING returns at once (nothing will run after it)", async () => {
    const deps: BrowserToolDeps = { ...browserDeps(), dispatch: () => ({ commandId: "pcmd_4", settled: new Promise<PanelCommandOutcome>(() => {}) }) };
    const ending = new AbortController();
    const browser = browserCapability(session({ signal: ending.signal }), { browser: deps }).instance as WinterMcpServerInstance;
    const call = browser.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" });
    await Bun.sleep(5);
    const started = performance.now();
    ending.abort();
    await call;
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the runtime's cancel stops a Computer wait at once (a pure timer: nothing is left running)", async () => {
    const computer = computerCapability(session({ computerUse: {} as ComputerUseService }), { computerUse: () => undefined }).instance as WinterMcpServerInstance;
    const cancel = new AbortController();
    const started = performance.now();
    const call = computer.callTool("computer", { action: "wait", seconds: 5 }, { signal: cancel.signal });
    await Bun.sleep(5);
    cancel.abort();
    const result = await call;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(result.content)).toContain("interrupted");
  });

  test("the sessions server: SpawnSession is concurrency-safe (concurrentTools), ListSessions is read-only (readOnlyHint) — neither is the other", () => {
    const sessions = sessionsCapability(session({ mode: "dispatch" }), { sessions: {} as ListSessionsDeps });
    expect(sessions.concurrentTools).toEqual(["session_spawn"]);
    expect(sessions.toolLanes).toBeUndefined();
    const listed = (sessions.instance as WinterMcpServerInstance).listTools();
    const byName = new Map(listed.map((t) => [t.name, t]));
    // A spawn is never stated read-only: concurrency is a scheduling statement only (agent SDK 0.0.41).
    expect(byName.get("session_spawn")!.annotations).toBeUndefined();
    expect(byName.get("list_sessions")!.annotations).toEqual({ readOnlyHint: true });
    // A code session's sessions server offers neither tool, so it declares nothing.
    const code = sessionsCapability(session({ mode: "code" }), { sessions: {} as ListSessionsDeps });
    expect(code.concurrentTools).toBeUndefined();
    expect((code.instance as WinterMcpServerInstance).listTools()).toEqual([]);
    // No other capability server declares a concurrent tool or a read-only one.
    expect(computerCapability(session(), { computerUse: () => undefined }).concurrentTools).toBeUndefined();
    expect(browserCapability(session(), { browser: browserDeps() }).concurrentTools).toBeUndefined();
    for (const t of (browserCapability(session(), { browser: browserDeps() }).instance as WinterMcpServerInstance).listTools()) expect(t.annotations).toBeUndefined();
  });

  test("the daemon runs several SpawnSession calls at the same time, each with its own call signal", async () => {
    const releases: Array<() => void> = [];
    const signals: Array<AbortSignal | undefined> = [];
    let inFlight = 0;
    let peak = 0;
    const sessions = sessionsCapability(session({ mode: "dispatch" }), {
      sessions: {} as ListSessionsDeps,
      spawn: async (args, ctx) => {
        signals.push(ctx.signal);
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => releases.push(r));
        inFlight--;
        return `spawned for ${args.prompt}`;
      },
    });
    const instance = sessions.instance as WinterMcpServerInstance;
    const cancels = [new AbortController(), new AbortController(), new AbortController()];
    const calls = cancels.map((c, i) => instance.callTool("session_spawn", { dir: "/tmp", prompt: `p${i}` }, { signal: c.signal }));
    for (let n = 0; n < 50 && releases.length < 3; n++) await Bun.sleep(2);
    expect(peak).toBe(3);
    cancels[1]!.abort();
    expect(signals.map((s) => s?.aborted)).toEqual([false, true, false]);
    for (const r of releases) r();
    const results = await Promise.all(calls);
    expect(results.map((r) => JSON.stringify(r.content))).toEqual([0, 1, 2].map((i) => JSON.stringify([{ type: "text", text: `spawned for p${i}` }])));
  });

  test("the daemon runs a Computer call and a Browser call at the same time", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let computerStarted = false;
    const cu = {
      act: async (): Promise<CuActResult> => {
        computerStarted = true;
        await held; // the Computer call stays in flight...
        return { ok: true, resultJson: JSON.stringify({ text: "#0 window" }) } as CuActResult;
      },
    } as unknown as ComputerUseService;
    const computer = computerCapability(session({ computerUse: cu }), { computerUse: () => undefined }).instance as WinterMcpServerInstance;
    const browser = browserCapability(session(), { browser: browserDeps() }).instance as WinterMcpServerInstance;

    const computerCall = computer.callTool("computer", { action: "ax_snapshot" });
    for (let n = 0; n < 50 && !computerStarted; n++) await Bun.sleep(2);
    expect(computerStarted).toBe(true);
    // ...while a Browser call runs to completion beside it.
    const browserResult = await browser.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" });
    expect(browserResult.isError).toBeFalsy();
    release();
    const computerResult = await computerCall;
    expect(computerResult.isError).toBe(false);
  });
});
