import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpStdioClient } from "../../../src/agent/mcp/client";

const FIXTURE = join(import.meta.dir, "fake-mcp-server.ts");
const TASK_FIXTURE = join(import.meta.dir, "fake-task-server.ts");
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

  test("callToolTask: a NON-task server still returns synchronously", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", FIXTURE] });
    await c.start();
    const out = await c.callToolTask("echo", { msg: "hi" });
    expect(out.kind).toBe("sync");
    if (out.kind !== "sync") throw new Error("unreachable");
    expect(out.blocks).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(out.isError).toBe(false);
    c.stop();
  });

  test("callToolTask: a task-capable server reports taskCreated, then settles", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", TASK_FIXTURE] });
    await c.start();
    let created: string | undefined;
    const out = await c.callToolTask("slow", {}, undefined, (id) => { created = id; });
    expect(out.kind).toBe("task");
    if (out.kind !== "task") throw new Error("unreachable");
    expect(created).toBeTruthy();
    expect(out.handle.taskId).toBe(created!);
    const settled = await out.handle.settled;
    expect(settled.ok).toBe(true);
    expect(settled.blocks).toEqual([{ type: "text", text: "slow work finished" }]);
    c.stop();
  });

  test("callToolTask: a failing task settles ok:false (the stream's `error` arm, not a throw)", async () => {
    const c = new McpStdioClient({ command: "bun", args: ["run", TASK_FIXTURE], env: { NORMA_FAKE_TASK_FAIL: "1" } });
    await c.start();
    const out = await c.callToolTask("slow", {});
    expect(out.kind).toBe("task");
    if (out.kind !== "task") throw new Error("unreachable");
    const settled = await out.handle.settled;
    expect(settled.ok).toBe(false);
    expect(settled.blocks.some((b) => b.type === "text" && /fail/i.test(b.text))).toBe(true);
    c.stop();
  });
});
