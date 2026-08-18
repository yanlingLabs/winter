// Task-capable MCP stdio server for tests, built on the SDK's OWN server half (already installed
// with @modelcontextprotocol/sdk, so the task test story costs no new dependency).
//
// THREE things are required to make a task actually happen, and each fails differently:
//   1. the tool declares `execution: { taskSupport: "required" }` — without it the client's
//      cacheToolMetadata never records the tool as task-capable;
//   2. the SERVER declares a `tasks.requests.tools.call` capability — without it
//      client/index.js's isToolTask returns false EARLY and the call silently runs synchronously
//      (the stream yields only `result`, with no error to tell you why);
//   3. the server is constructed with `taskStore` in its ProtocolOptions — without it
//      server/mcp.js throws before ever reaching the handler below, surfacing as a confusing
//      "Invalid task creation result: task undefined" on the client.
// Verified sequence with all three in place:
//   taskCreated -> taskStatus(working) -> taskStatus(completed) -> result
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";

const store = new InMemoryTaskStore();
const server = new McpServer(
  { name: "fake-task", version: "1" },
  { capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } }, taskStore: store },
);

const FAIL = process.env.NORMA_FAKE_TASK_FAIL === "1";
const DELAY = Number(process.env.NORMA_FAKE_TASK_DELAY_MS ?? 50);

server.experimental.tasks.registerToolTask(
  "slow",
  { description: "A tool that runs as a task", inputSchema: {}, execution: { taskSupport: "required" } },
  {
    createTask: async (_args: unknown, extra: any) => {
      const task = await store.createTask({ ttl: 60_000 }, extra.requestId, extra.request);
      // background work: settle the task after DELAY, then park the result for tasks/result
      void (async () => {
        await new Promise((r) => setTimeout(r, DELAY));
        await store.storeTaskResult(
          task.taskId,
          FAIL ? "failed" : "completed",
          FAIL
            ? { content: [{ type: "text", text: "task blew up" }], isError: true }
            : { content: [{ type: "text", text: "slow work finished" }] },
        );
      })();
      return { task };
    },
    getTask: async (_args: unknown, extra: any) => {
      const t = await store.getTask(extra.taskId);
      if (!t) throw new Error(`unknown task: ${extra.taskId}`);
      return t;
    },
    getTaskResult: async (_args: unknown, extra: any) => await store.getTaskResult(extra.taskId) as any,
  },
);

await server.connect(new StdioServerTransport());
