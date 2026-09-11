import { describe, expect, test } from "bun:test";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerDocsTool, type DocsToolDeps } from "../../src/agent/tools/docs";
import { registerSheetsTool } from "../../src/agent/tools/sheets";
import { registerSlidesTool } from "../../src/agent/tools/slides";
import type { PanelCommandOutcome } from "../../src/panel/commands";
import type { SessionDirs } from "../../src/sessions/dirs";
import { officeCapability } from "../../src/capabilities/office";
import type { CapabilitySession } from "../../src/capabilities/server";

/**
 * The `office` capability server (P8b Task 7) — `docs`, `sheets`, `slides` over the SAME fake
 * dispatch recorder `test/agent/tools/docs.test.ts` uses. No LibreOffice, no Mac app.
 */

const SID = "s_office";
const WORKDIR = "/repo";

interface Harness {
  deps: DocsToolDeps;
  recorded: Array<{ sessionId: string; action: string; args?: Record<string, unknown> }>;
  registry: ToolRegistry;
  instance: WinterMcpServerInstance;
  session: CapabilitySession;
}

function harness(sessionId: string = SID): Harness {
  const recorded: Harness["recorded"] = [];
  const h = { recorded, registry: new ToolRegistry() } as Harness;
  h.session = { sessionId, mode: "code", cwd: WORKDIR, roots: [WORKDIR] };
  h.deps = {
    dispatch: (cmd) => {
      recorded.push({ sessionId: cmd.sessionId, action: cmd.action, args: cmd.args });
      return { commandId: `pcmd_${recorded.length}`, settled: Promise.resolve<PanelCommandOutcome>({ kind: "result", ok: true, result: "did it" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
    dirsOf: () => [{ path: WORKDIR, locked: true }] as SessionDirs,
  };
  registerDocsTool(h.registry, h.deps);
  registerSheetsTool(h.registry, h.deps);
  registerSlidesTool(h.registry, h.deps);
  h.instance = officeCapability(h.session, { office: h.deps }).instance as WinterMcpServerInstance;
  return h;
}

function ctx(): ToolContext {
  return { cwd: WORKDIR, roots: [WORKDIR], sessionId: SID, mode: "code" } as ToolContext;
}

describe("officeCapability", () => {
  test("is an `sdk` server named `office` carrying all three tools", () => {
    const h = harness();
    const server = officeCapability(h.session, { office: h.deps });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("norma__office");
    expect(isWinterMcpServerInstance(server.instance)).toBe(true);
    expect((server.instance as WinterMcpServerInstance).listTools().map((t) => t.name).sort())
      .toEqual(["docs", "sheets", "slides"]);
  });

  test("every advertised schema is byte-identical to the registry's, and a JSON-Schema object", () => {
    const h = harness();
    for (const tool of h.instance.listTools()) {
      const spec = h.registry.specFor(tool.name, undefined, "code")!;
      expect(tool.description).toBe(spec.description);
      expect(tool.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });

  test("one callTool per tool answers exactly as the registry door answers", async () => {
    for (const [tool, args] of [
      ["docs", { verb: "info", path: `${WORKDIR}/notes.odt` }],
      ["sheets", { verb: "info", path: `${WORKDIR}/book.ods` }],
      ["slides", { verb: "info", path: `${WORKDIR}/deck.odp` }],
    ] as const) {
      const viaRegistryH = harness();
      const viaRegistry = await viaRegistryH.registry.execute(tool, args, ctx());
      const viaCapabilityH = harness();
      const viaCapability = await viaCapabilityH.instance.callTool(tool, args as unknown as Record<string, unknown>);
      expect(viaRegistry.isError, `${tool} failed on the registry door: ${viaRegistry.output}`).toBe(false);
      expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
      // The same command reached the same transport, with the same arguments.
      expect(viaCapabilityH.recorded).toEqual(viaRegistryH.recorded);
    }
  });

  test("a path outside the session's own dirs is refused identically on both doors", async () => {
    const viaRegistryH = harness();
    const viaRegistry = await viaRegistryH.registry.execute("docs", { verb: "info", path: "/elsewhere/secret.odt" }, ctx());
    const viaCapabilityH = harness();
    const viaCapability = await viaCapabilityH.instance.callTool("docs", { verb: "info", path: "/elsewhere/secret.odt" });
    expect(viaRegistry.isError).toBe(true);
    expect(viaCapability.isError).toBe(true);
    expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
    expect(viaCapabilityH.recorded.length).toBe(0);
  });

  test("every dispatched command carries the session the server was BUILT FOR (N4)", async () => {
    // The identity is a closure, not a lookup, so the id on the wire is the one this server was
    // constructed with — proved by building two servers with DIFFERENT ids and calling both.
    const one = harness("s_office_one");
    const two = harness("s_office_two");
    await one.instance.callTool("sheets", { verb: "info", path: `${WORKDIR}/book.ods` });
    await two.instance.callTool("docs", { verb: "info", path: `${WORKDIR}/notes.odt` });
    expect(one.recorded.map((r) => r.sessionId)).toEqual(["s_office_one"]);
    expect(two.recorded.map((r) => r.sessionId)).toEqual(["s_office_two"]);
  });
});
