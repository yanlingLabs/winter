// Agent SDK 0.0.40 (user ruling 2026-10-02): `Computer` and `Browser` each run in their own CONCURRENCY
// LANE (`McpSdkServerConfig.toolLanes`): two `Computer` calls never overlap (the SDK keeps a lane's calls one
// at a time, in call order), but a `Computer` call, a `Browser` call and any read-only call may. Pinned here:
// the lanes the two servers declare (and that no other capability tool has one), and that the DAEMON side
// tolerates a `Computer` call and a `Browser` call in flight at the same time.
import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import type { BrowserToolDeps } from "../../src/agent/tools/browser";
import type { ComputerUseService, CuActResult } from "../../src/agent/computer-use";
import type { PanelCommandOutcome } from "../../src/panel/commands";
import type { PanelTabState } from "../../src/panel/store";
import { browserCapability } from "../../src/capabilities/browser";
import { computerCapability } from "../../src/capabilities/computer";
import { WINTER_CAPABILITY_TOOLS } from "../../src/capabilities/names";
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

  test("the runtime's cancel (the call's own signal) stops a running Browser and Computer call promptly", async () => {
    // Browser: the panel never settles the command; only the cancel can end the call.
    const deps: BrowserToolDeps = { ...browserDeps(), dispatch: () => ({ commandId: "pcmd_2", settled: new Promise<PanelCommandOutcome>(() => {}) }) };
    const browser = browserCapability(session(), { browser: deps }).instance as WinterMcpServerInstance;
    const browserCancel = new AbortController();
    const browserCall = browser.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" }, { signal: browserCancel.signal });
    await Bun.sleep(5);
    browserCancel.abort();
    const browserResult = await Promise.race([browserCall, Bun.sleep(2_000).then(() => "still running" as const)]);
    expect(browserResult).not.toBe("still running");

    // Computer: a 5 s `wait` ends on the cancel instead of running its full time.
    const computer = computerCapability(session({ computerUse: {} as ComputerUseService }), { computerUse: () => undefined }).instance as WinterMcpServerInstance;
    const computerCancel = new AbortController();
    const started = performance.now();
    const computerCall = computer.callTool("computer", { action: "wait", seconds: 5 }, { signal: computerCancel.signal });
    await Bun.sleep(5);
    computerCancel.abort();
    const computerResult = await computerCall;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(computerResult.content)).toContain("interrupted");
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
