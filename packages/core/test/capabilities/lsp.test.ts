// The `lsp` capability server (fix wave, whole-branch review F7): the single multi-purpose `lsp`
// tool over the daemon's one `LspManager`, reinstated on the Winter leg because the 0.0.4 child
// advertises no `LSP` of its own. Same obligations as the other capability servers: schema parity
// with the registry door BY CONSTRUCTION (one `ToolDefinition`), the fence checked BEFORE the
// manager is touched (with the registry door's own wording), code-only, hot-disable per call.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWinterMcpServerInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerLspTools } from "../../src/agent/tools/lsp";
import { LspManager } from "../../src/agent/lsp/manager";
import { lspCapability } from "../../src/capabilities/lsp";
import { WINTER_CAPABILITY_TOOLS, buildCapabilitiesFor, capabilityServerName, type CapabilityDeps, type CapabilitySession } from "../../src/capabilities";
import { CAPABILITY_TOOL_MODES, disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
import { gateClassFor, hostToolNameFor } from "../../src/runtime-sdk/tool-names";
import { PermissionGate } from "../../src/agent/gate";
import { PageCache } from "../../src/agent/tools/page-core";

const FIXTURE = join(import.meta.dir, "../agent/lsp/fake-server.ts");
const FAKE = { command: "bun", args: ["run", FIXTURE] };
const isMac = process.platform === "darwin";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-cap-lsp-"))); }

function harness(over: { manager?: LspManager | undefined } = {}) {
  const root = realDir();
  const outside = realDir();
  writeFileSync(join(outside, "secret.ts"), "const leaked = true;\n");
  writeFileSync(join(root, "usage.ts"), "import { target } from \"./target\";\ntarget();\n");
  writeFileSync(join(root, "target.ts"), "// line 0\n// line 1\n// line 2\nfunction target() {}\n// line 4\n");
  const manager = "manager" in over ? over.manager : new LspManager({ serverCommands: { typescript: FAKE, swift: FAKE } });
  const session: CapabilitySession = { sessionId: "s_lsp", mode: "code", cwd: root, roots: [root] };
  const server = lspCapability(session, { lsp: () => manager });
  const instance = server.instance as WinterMcpServerInstance;
  // the registry door over the SAME facts, for parity comparisons
  const registry = new ToolRegistry();
  if (manager !== undefined) registerLspTools(registry, { lsp: manager, cwdOf: () => root, rootsOf: () => [root] });
  const ctx = (): ToolContext => ({ cwd: root, roots: [root], sessionId: "s_lsp", mode: "code" } as ToolContext);
  const cleanup = (): void => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); };
  return { root, outside, manager, session, server, instance, registry, ctx, cleanup };
}

const text = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text;

describe("lspCapability: the server shape", () => {
  test("is an `sdk` server named `winter__lsp` carrying exactly the `lsp` tool", () => {
    const h = harness();
    try {
      expect(h.server.type).toBe("sdk");
      expect(h.server.name).toBe(capabilityServerName("lsp"));
      expect(h.server.name).toBe("winter__lsp");
      expect(isWinterMcpServerInstance(h.server.instance)).toBe(true);
      expect(h.instance.listTools().map((t) => t.name)).toEqual(["lsp"]);
    } finally { h.cleanup(); }
  });

  test("schema parity with the registry door — the same ToolDefinition, a JSON-Schema object", () => {
    const h = harness();
    try {
      const [tool] = h.instance.listTools();
      const spec = h.registry.specFor("lsp", undefined, "code")!;
      expect(tool!.description).toBe(spec.description);
      expect(tool!.inputSchema).toEqual(spec.parameters as Record<string, unknown>);
      expect(tool!.inputSchema["type"]).toBe("object");
      // the registry door defers it (ToolSearch); the capability serves it directly
      expect(h.registry.isDeferredBuiltin("lsp", true)).toBe(true);
    } finally { h.cleanup(); }
  });

  test("the tables agree: code-only, deferred on the registry door, classified READ_ONLY under the bare name `lsp`", () => {
    expect(WINTER_CAPABILITY_TOOLS["mcp__winter__lsp__lsp"]).toEqual({ modes: ["code"], deferred: true });
    expect(CAPABILITY_TOOL_MODES["mcp__winter__lsp__lsp"]).toEqual({ modes: ["code"] });
    expect(disallowedToolsFor("chat")).toContain("mcp__winter__lsp__lsp");
    expect(disallowedToolsFor("dispatch")).toContain("mcp__winter__lsp__lsp");
    expect(disallowedToolsFor("code")).not.toContain("mcp__winter__lsp__lsp");
    // the bridge's names: the wire name strips to `lsp` (the seventh capability key), which the
    // gate allows under every policy including `plan` — a read-only tool, exactly as before
    expect(hostToolNameFor("mcp__winter__lsp__lsp")).toBe("lsp");
    expect(gateClassFor("mcp__winter__lsp__lsp")).toBe("lsp");
    const gate = new PermissionGate();
    for (const policy of ["plan", "ask", "auto", "chat", "dont-ask"] as const) expect(gate.evaluate("lsp", policy)).toBe(policy === "chat" ? "allow" : "allow");
  });

  test("buildCapabilitiesFor includes `winter__lsp` for a code session and it advertises nothing in chat/dispatch (P8b-37)", () => {
    const panel = { dispatch: () => ({ commandId: "c", settled: Promise.resolve({ kind: "timeout" as const, deadlineMs: 1 }) }), harnesses: () => [] };
    const deps: CapabilityDeps = {
      sessions: { models: [], sessions: { store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "" } } as never },
      computer: { computerUse: () => undefined }, computerUseEnabled: () => false,
      browser: { browser: { tabs: () => ({ tabs: [], activeTabId: undefined }) as never, openTab: () => "t", ...panel } },
      office: { office: { ...panel, dirsOf: () => [] as never } },
      research: { search: {}, readPage: { cache: new PageCache() } },
      web: { web: {} },
      lsp: { lsp: () => undefined },
    };
    const base: CapabilitySession = { sessionId: "s", mode: "code", cwd: "/tmp", roots: ["/tmp"] };
    const tools = (mode: CapabilitySession["mode"]): string[] =>
      (buildCapabilitiesFor({ ...base, mode }, deps)["winter__lsp"]!.instance as WinterMcpServerInstance).listTools().map((t) => t.name);
    expect(tools("code")).toEqual(["lsp"]);
    expect(tools("dispatch")).toEqual([]);
    expect(tools("chat")).toEqual([]);
  });
});

describe("lspCapability: the fence and the guards run BEFORE the manager, with the registry door's wording", () => {
  test("an outside-roots file_path is refused identically on both doors, and clientFor is never called", async () => {
    const h = harness();
    try {
      const spy = spyOn(h.manager!, "clientFor");
      const viaCapability = await h.instance.callTool("lsp", { action: "diagnostics", file_path: join(h.outside, "secret.ts") });
      const viaRegistry = await h.registry.execute("lsp", { action: "diagnostics", file_path: join(h.outside, "secret.ts") }, h.ctx());
      expect(viaCapability.isError).toBe(true);
      expect(viaRegistry.isError).toBe(true);
      expect(viaRegistry.output).toContain("outside the allowed directories");
      expect(viaCapability.content).toEqual([{ type: "text", text: viaRegistry.output }]);
      expect(spy).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  test("a missing required param and an unsupported extension are the registry door's typed errors, manager untouched", async () => {
    const h = harness();
    try {
      const spy = spyOn(h.manager!, "clientFor");
      const missing = await h.instance.callTool("lsp", { action: "definition", file_path: "usage.ts" });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toBe("action 'definition' requires file_path, line, character");
      writeFileSync(join(h.root, "notes.md"), "hello\n");
      const unsupported = await h.instance.callTool("lsp", { action: "diagnostics", file_path: "notes.md" });
      expect(unsupported.isError).toBe(true);
      expect(text(unsupported)).toContain("unsupported");
      expect(spy).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  test("HOT: with `settings.lsp.enabled` off (the holder answers undefined) the tool refuses per call — the server is still advertised", async () => {
    let manager: LspManager | undefined = undefined;
    const root = realDir();
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      const server = lspCapability({ sessionId: "s", mode: "code", cwd: root, roots: [root] }, { lsp: () => manager });
      const instance = server.instance as WinterMcpServerInstance;
      expect(instance.listTools().map((t) => t.name)).toEqual(["lsp"]);
      const off = await instance.callTool("lsp", { action: "diagnostics", file_path: "a.ts" });
      expect(off.isError).toBe(true);
      expect(text(off)).toContain("lsp is not available in this session");
      // the guards still run first when it is off: a fenced path is the fence's error, not the toggle's
      const fenced = await instance.callTool("lsp", { action: "diagnostics", file_path: "/etc/hosts.ts" });
      expect(text(fenced)).toContain("outside the allowed directories");
      // and a re-enable (the holder reassigned) reaches the NEXT call with no rebuild
      manager = new LspManager({ serverCommands: { typescript: FAKE, swift: FAKE } });
      const spy = spyOn(manager, "clientFor").mockImplementation(async () => { throw new Error("reached the manager"); });
      const on = await instance.callTool("lsp", { action: "diagnostics", file_path: "a.ts" });
      expect(text(on)).toBe("reached the manager");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe.if(isMac)("lspCapability: a real fake language server through the capability door", () => {
  test("action 'definition' round-trips the 1-based position convention and previews in-fence locations", async () => {
    const h = harness();
    const prev = process.env.WINTER_LSP_FAKE_DEFINITION;
    process.env.WINTER_LSP_FAKE_DEFINITION = JSON.stringify([{ uri: `file://${encodeURI(join(h.root, "target.ts"))}`, range: { start: { line: 3, character: 9 }, end: { line: 3, character: 15 } } }]);
    try {
      const res = await h.instance.callTool("lsp", { action: "definition", file_path: "usage.ts", line: 1, character: 10 });
      expect(res.isError).toBe(false);
      expect(text(res)).toBe(`${join(h.root, "target.ts")}:4:10  function target() {}`);
      // byte-identical to the registry door
      const viaRegistry = await h.registry.execute("lsp", { action: "definition", file_path: "usage.ts", line: 1, character: 10 }, h.ctx());
      expect(viaRegistry.output).toBe(text(res));
    } finally {
      if (prev === undefined) delete process.env.WINTER_LSP_FAKE_DEFINITION; else process.env.WINTER_LSP_FAKE_DEFINITION = prev;
      await h.manager!.stopAll();
      h.cleanup();
    }
  }, 20_000);
});
