import { describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerBrowserTool, type BrowserToolDeps } from "../../src/agent/tools/browser";
import type { PanelCommandOutcome } from "../../src/panel/commands";
import type { PanelTabState } from "../../src/panel/store";
import { browserCapability } from "../../src/capabilities/browser";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `browser` capability server (P8b Task 7), over the SAME fake dispatch recorder
 * `test/agent/tools/browser.test.ts` uses — no Mac app, no CEF, no network.
 *
 * The interesting property here is the one no other capability has: chat sees a READ-ONLY verb set,
 * and it is enforced INSIDE the server (there is one `browser` tool, and `disallowedTools` names
 * whole tools). Both doors resolve `argsByMode` from the caller's mode, so the refusal is argument
 * validation with the registry's own wording — proven by comparing the two doors' output text.
 */

const SID = "s_browser";

interface Harness {
  deps: BrowserToolDeps;
  recorded: Array<{ action: string; tabId?: string; url?: string }>;
  opened: Array<{ sessionId: string; kind: string; url?: string }>;
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession | undefined;
}

function harness(mode: CapabilitySession["mode"] = "code"): Harness {
  const recorded: Harness["recorded"] = [];
  const opened: Harness["opened"] = [];
  const tabs: PanelTabState = { tabs: [{ tabId: "t1", kind: "web", url: "https://example.com" }], activeTabId: "t1" } as PanelTabState;
  const h = { recorded, opened, registry: new ToolRegistry() } as Harness;
  h.session = { sessionId: SID, mode, cwd: "/tmp", roots: ["/tmp"] };
  h.deps = {
    tabs: () => tabs,
    openTab: (p) => { opened.push({ sessionId: p.sessionId, kind: p.kind, url: p.url }); return `tab_${opened.length}`; },
    dispatch: (cmd) => {
      recorded.push({ action: cmd.action, tabId: cmd.tabId, url: cmd.url });
      return { commandId: `pcmd_${recorded.length}`, settled: Promise.resolve<PanelCommandOutcome>({ kind: "result", ok: true, result: "did it" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
  };
  registerBrowserTool(h.registry, h.deps);
  h.instance = browserCapability({ currentSession: () => h.session, browser: h.deps }).instance as WinterMcpServerInstance;
  return h;
}

function ctx(mode: CapabilitySession["mode"]): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: SID, mode } as ToolContext;
}

describe("browserCapability: the server shape", () => {
  test("is an `sdk` server named `browser` with a callable instance", () => {
    const h = harness();
    const server = browserCapability({ currentSession: () => h.session, browser: h.deps });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("browser");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
  });

  test("listTools advertises the WIDEST schema (code), not the fail-closed chat one", () => {
    const h = harness();
    const [tool] = h.instance.listTools();
    expect(tool!.name).toBe("browser");
    expect(tool!.inputSchema["type"]).toBe("object");
    // Byte-identical to what the registry advertises a code session.
    const spec = h.registry.specFor("browser", undefined, "code")!;
    expect(tool!.description).toBe(spec.description);
    expect(tool!.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
    // And NOT the chat schema — which is the silent narrowing this guards against.
    const chatSpec = h.registry.specFor("browser", undefined, "chat")!;
    expect(tool!.inputSchema).not.toEqual(chatSpec.parameters as Record<string, unknown>);
  });
});

describe("browserCapability: callTool", () => {
  test("a read verb answers exactly as the registry door answers", async () => {
    const h = harness();
    const viaRegistry = await h.registry.execute("browser", { verb: "tabs" }, ctx("code"));
    const viaCapability = await h.instance.callTool("browser", { verb: "tabs" });
    expect(viaRegistry.isError).toBe(false);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
  });

  test("an interact verb works in code and is REFUSED in chat, with the registry's own message", async () => {
    const code = harness("code");
    const okRes = await code.instance.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" });
    expect(okRes.isError).toBe(false);
    expect(code.recorded.map((r) => r.action)).toEqual(["click"]);

    const chat = harness("chat");
    const viaRegistry = await chat.registry.execute("browser", { verb: "click", tabId: "t1", selector: "#go" }, ctx("chat"));
    const viaCapability = await chat.instance.callTool("browser", { verb: "click", tabId: "t1", selector: "#go" });
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.isError).toBe(true);
    // THE PARITY THAT MATTERS: identical text, because both doors ran the same `argsByMode`
    // resolution and the same zod failure formatting.
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
    // And nothing was dispatched — the refusal is before the transport, not after it.
    expect(chat.recorded.length).toBe(0);
  });

  test("chat KEEPS the read verbs — the refusal is per-action, not per-tool", async () => {
    const chat = harness("chat");
    const res = await chat.instance.callTool("browser", { verb: "tabs" });
    expect(res.isError).toBe(false);
  });

  test("no bound session refuses before the tool runs", async () => {
    const h = harness();
    h.session = undefined;
    const res = await h.instance.callTool("browser", { verb: "open", url: "https://example.com" });
    expect(res.isError).toBe(true);
    expect(h.opened.length).toBe(0);
  });
});
