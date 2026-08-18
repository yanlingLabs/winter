import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpStdioClient } from "../../../src/agent/mcp/client";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const isMac = process.platform === "darwin";

describe.if(isMac)("McpStdioClient", () => {
  test("handshake lists tools; callTool echoes", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    expect(c.tools().map((t) => t.name)).toEqual(["echo"]);
    expect(c.tools()[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(await c.callTool("echo", { msg: "hi" })).toBe("echo: hi");
    c.stop();
  });

  test("startup timeout → start() rejects (server never responds)", async () => {
    const c = new McpStdioClient({ command: "sleep", args: ["30"] }); // reads nothing, never replies
    await expect(c.start(300)).rejects.toThrow();
    c.stop();
  });

  test("after stop(), callTool rejects (not running)", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    c.stop();
    expect(c.dead).toBe(true);
    await expect(c.callTool("echo", { msg: "x" })).rejects.toThrow();
  });

  test("a bare `null` JSON-RPC line from the server is ignored, not a crash", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_NULL: "1" } });
    await c.start();
    expect(c.tools().map((t) => t.name)).toEqual(["echo"]);
    c.stop();
  });

  test("resourcesCapable() is false when the server's initialize capabilities omit resources", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    expect(c.resourcesCapable()).toBe(false);
    c.stop();
  });

  test("resourcesCapable() is true, listResources/readResource work, when the fixture opts in", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_RESOURCES: "1" } });
    await c.start();
    expect(c.resourcesCapable()).toBe(true);
    const resources = await c.listResources();
    expect(resources).toEqual([
      { uri: "fake://greeting", name: "greeting", description: "A greeting text resource", mimeType: "text/plain" },
      { uri: "fake://pixel", name: "pixel", description: "A tiny PNG", mimeType: "image/png" },
    ]);
    const text = await c.readResource("fake://greeting");
    expect(text).toEqual([{ uri: "fake://greeting", mimeType: "text/plain", text: "hello from fake resource" }]);
    const image = await c.readResource("fake://pixel");
    expect(image[0]!.mimeType).toBe("image/png");
    expect(typeof image[0]!.blob).toBe("string");
    await expect(c.readResource("fake://nope")).rejects.toThrow();
    c.stop();
  });

  test("tools/list pagination: every page is collected, not just the first", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_PAGES: "1" } });
    await c.start();
    expect(c.tools().map((t) => t.name)).toEqual(["echo", "page2tool"]);
    c.stop();
  });

  test("server stderr reaches the log callback", async () => {
    const lines: string[] = [];
    const c = new McpStdioClient(
      { command: "bun", args: ["run", FIXTURE], env: { NORMA_FAKE_STDERR: "1" } },
      (m) => lines.push(m),
    );
    await c.start();
    // stderr is asynchronous relative to the handshake; give the pipe a tick to drain.
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.some((l) => l.includes("fake server noise"))).toBe(true);
    c.stop();
  });
});
