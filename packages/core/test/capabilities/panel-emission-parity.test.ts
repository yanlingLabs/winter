import { describe, expect, test } from "bun:test";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import type { NewSessionEvent } from "@winter/protocol";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerBrowserTool } from "../../src/agent/tools/browser";
import { registerDocsTool } from "../../src/agent/tools/docs";
import { mintPanelTab } from "../../src/panel/open-tab";
import { PanelCommandRegistry } from "../../src/panel/commands";
import type { SessionDirs } from "../../src/sessions/dirs";
import { browserCapability } from "../../src/capabilities/browser";
import { officeCapability } from "../../src/capabilities/office";

/**
 * P8b-20 — THE panel-emission parity proof.
 *
 * "A browser/office `callTool` emits the same `panel_tab_opened` / `panel_tab_activated` /
 * `panel_command` sequence the registered tool emits today; the emission test is byte-compared
 * against a recording of today's tool."
 *
 * ⚠️ IF THE TWO SEQUENCES EVER DIFFER, THE CAPABILITY IS WRONG, NOT THIS TEST. The failure this
 * guards against is the quiet one: every unit test green, and panel tabs simply stop opening on the
 * Winter leg because the capability was handed its own `mintPanelTab`/`PanelCommandRegistry` instead
 * of the daemon's.
 *
 * THE EMITTERS ARE REAL, not doubles. `mintPanelTab` is the one code path that mints a tab (two
 * appends — opened THEN activated, the second being what makes the tab active), and
 * `PanelCommandRegistry` is the real registry whose `emit` is `hub.broadcastTransient` in
 * production. Only the HUB is a recorder, and the sequence is compared with the minted ids
 * normalized — `tabId` is a `randomUUID` and `commandId` a `pcmd_<randomUUID>`, so two runs of the
 * same call are equal in every field EXCEPT those, by construction.
 */

const SID = "s_parity";
const WORKDIR = "/repo";

/** Replace minted ids with stable placeholders, so "identical but for the UUIDs" is checkable. */
function normalize(events: NewSessionEvent[]): unknown[] {
  const ids = new Map<string, string>();
  const stable = (v: string): string => {
    if (!ids.has(v)) ids.set(v, `#${ids.size}`);
    return ids.get(v)!;
  };
  return events.map((e) => {
    const copy = { ...e } as Record<string, unknown>;
    if (typeof copy["tabId"] === "string") copy["tabId"] = stable(copy["tabId"]);
    if (typeof copy["commandId"] === "string") copy["commandId"] = stable(copy["commandId"]);
    return copy;
  });
}

/** A recording hub + a REAL PanelCommandRegistry that answers every command immediately. */
function recorder(): {
  events: NewSessionEvent[];
  hub: Parameters<typeof mintPanelTab>[0];
  panelCommands: PanelCommandRegistry;
  dispatch: (cmd: Parameters<PanelCommandRegistry["dispatch"]>[0]) => ReturnType<PanelCommandRegistry["dispatch"]>;
} {
  const events: NewSessionEvent[] = [];
  const panelCommands = new PanelCommandRegistry({
    emit: (event) => { events.push(event); },
    log: () => {},
  });
  return {
    events,
    // `mintPanelTab` takes `Pick<SessionHub, "append">`, whose `append` RETURNS the stamped event;
    // the recorder returns the same object it captured (seq/ts are irrelevant to this comparison).
    hub: { append: ((_sessionId: string, event: NewSessionEvent) => { events.push(event); return event as never; }) as Parameters<typeof mintPanelTab>[0]["append"] },
    panelCommands,
    dispatch: (cmd) => {
      const out = panelCommands.dispatch(cmd);
      // Answer at once so the tool's `await settled` resolves without burning the real deadline.
      // `sessionId` is required — `resolve` rejects a result whose session does not match.
      queueMicrotask(() => { panelCommands.resolve({ sessionId: cmd.sessionId, commandId: out.commandId, ok: true, result: "did it" }); });
      return out;
    },
  };
}

/** The tab FOLD a real daemon would compute from the session's own event log — kept here as the
 *  list `mintPanelTab` appends into, so a follow-up verb can actually address the tab it opened. */
function browserDeps(rec: ReturnType<typeof recorder>) {
  const tabs: Array<{ tabId: string; kind: string; url?: string; title?: string }> = [];
  let activeTabId: string | undefined;
  return {
    tabs: () => ({ tabs, activeTabId }) as never,
    openTab: (p: Parameters<typeof mintPanelTab>[1]) => {
      const tabId = mintPanelTab(rec.hub, p);
      tabs.push({ tabId, kind: p.kind, url: p.url, title: p.title });
      activeTabId = tabId;
      return tabId;
    },
    dispatch: rec.dispatch,
    harnesses: () => [{ clientName: "orb", role: "harness" }],
  };
}

function officeDeps(rec: ReturnType<typeof recorder>) {
  return {
    dispatch: rec.dispatch,
    harnesses: () => [{ clientName: "orb", role: "harness" }],
    dirsOf: () => [{ path: WORKDIR, locked: true }] as SessionDirs,
  };
}

function ctx(): ToolContext {
  return { cwd: WORKDIR, roots: [WORKDIR], sessionId: SID, mode: "code" } as ToolContext;
}

describe("P8b-20: browser `open` emits the identical panel sequence on both doors", () => {
  const args = { verb: "open", url: "https://example.com", title: "Example" };

  test("the registry door and the capability door produce the same events", async () => {
    const viaRegistryRec = recorder();
    const registry = new ToolRegistry();
    registerBrowserTool(registry, browserDeps(viaRegistryRec));
    const registryOut = await registry.execute("browser", args, ctx());

    const viaCapabilityRec = recorder();
    const instance = browserCapability(
      { sessionId: SID, mode: "code", cwd: WORKDIR, roots: [WORKDIR] },
      { browser: browserDeps(viaCapabilityRec) },
    ).instance as WinterMcpServerInstance;
    const capabilityOut = await instance.callTool("browser", args);

    expect(registryOut.isError).toBe(false);
    expect(capabilityOut.isError).toBe(false);
    // The sequence itself — types in order, then every field but the minted ids.
    expect(viaRegistryRec.events.map((e) => e.type)).toEqual(["panel_tab_opened", "panel_tab_activated"]);
    expect(normalize(viaCapabilityRec.events)).toEqual(normalize(viaRegistryRec.events));
    // And the model-visible text is the same once the minted tab id is normalized out of it (the
    // `open` result names the tab it just minted, so the raw strings differ by a UUID and nothing
    // else — which is the same normalization the event comparison above applies).
    const strip = (t: string): string => t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<tab>");
    expect(strip((capabilityOut.content[0] as { text: string }).text)).toBe(strip(registryOut.output));
  });

  test("a follow-up interact verb emits the identical panel_command on both doors", async () => {
    const openThenClick = async (run: (tool: string, a: Record<string, unknown>) => Promise<unknown>, rec: ReturnType<typeof recorder>) => {
      await run("browser", args);
      const tabId = (rec.events.find((e) => e.type === "panel_tab_opened") as { tabId: string }).tabId;
      await run("browser", { verb: "click", tabId, selector: "#go" });
    };

    const viaRegistryRec = recorder();
    const registry = new ToolRegistry();
    registerBrowserTool(registry, browserDeps(viaRegistryRec));
    await openThenClick((tool, a) => registry.execute(tool, a, ctx()), viaRegistryRec);

    const viaCapabilityRec = recorder();
    const instance = browserCapability(
      { sessionId: SID, mode: "code", cwd: WORKDIR, roots: [WORKDIR] },
      { browser: browserDeps(viaCapabilityRec) },
    ).instance as WinterMcpServerInstance;
    await openThenClick((tool, a) => instance.callTool(tool, a), viaCapabilityRec);

    expect(viaRegistryRec.events.map((e) => e.type))
      .toEqual(["panel_tab_opened", "panel_tab_activated", "panel_command"]);
    expect(normalize(viaCapabilityRec.events)).toEqual(normalize(viaRegistryRec.events));
  });
});

describe("P8b-20: docs emits the identical panel sequence on both doors", () => {
  const args = { verb: "info", path: `${WORKDIR}/notes.odt` };

  test("the registry door and the capability door produce the same panel_command", async () => {
    const viaRegistryRec = recorder();
    const registry = new ToolRegistry();
    registerDocsTool(registry, officeDeps(viaRegistryRec));
    const registryOut = await registry.execute("docs", args, ctx());

    const viaCapabilityRec = recorder();
    const instance = officeCapability(
      { sessionId: SID, mode: "code", cwd: WORKDIR, roots: [WORKDIR] },
      { office: officeDeps(viaCapabilityRec) },
    ).instance as WinterMcpServerInstance;
    const capabilityOut = await instance.callTool("docs", args);

    expect(registryOut.isError).toBe(false);
    expect(capabilityOut.isError).toBe(false);
    // Office mints no tab — `panel_command` only (Winter map §3.1).
    expect(viaRegistryRec.events.map((e) => e.type)).toEqual(["panel_command"]);
    expect(normalize(viaCapabilityRec.events)).toEqual(normalize(viaRegistryRec.events));
    expect(capabilityOut.content).toEqual([{ type: "text", text: registryOut.output }]);
  });
});
