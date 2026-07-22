import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BridgeRequest, BridgeResponse, WorkerInit } from "./bridge";

const ENTRY = join(import.meta.dir, "subprocess-entry.ts");

/** Spawns the entry as a REAL child process — `bun subprocess-entry.ts`, no sandbox wrapping (that's
 *  the runtime's concern, A3′; this test only exercises the stdio↔runWorkflow bridge). Writes `init`
 *  as the first NDJSON line, auto-replies to every `agent` request with `[<prompt>]` (mirrors
 *  worker-harness.test.ts's fake agent), and resolves once the child's stdio closes with every
 *  BridgeRequest line it emitted plus its exit code. */
function runChild(init: WorkerInit): Promise<{ messages: BridgeRequest[]; exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    const messages: BridgeRequest[] = [];
    let buf = "";
    let stderr = "";
    const write = (m: WorkerInit | BridgeResponse) => child.stdin!.write(`${JSON.stringify(m)}\n`);

    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as BridgeRequest;
        messages.push(msg);
        if (msg.op === "agent") write({ callId: msg.callId, ok: true, value: `[${msg.prompt}]` });
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ messages, exitCode: code, stderr }));

    write(init);
  });
}

test("agent() round-trips twice over stdio NDJSON; phase + done (script's return value) arrive; exits 0", async () => {
  const { messages, exitCode, stderr } = await runChild({
    source: `
      const a = await agent("hi");
      const b = await agent("hi");
      phase("greeted");
      return { a, b };
    `,
    args: null,
    concurrency: 4,
  });

  const agentReqs = messages.filter((m) => m.op === "agent");
  expect(agentReqs.length).toBe(2); // both agent("hi") calls reached the bridge as {op:"agent"}

  const phaseMsg = messages.find((m) => m.op === "phase");
  expect(phaseMsg).toEqual({ op: "phase", title: "greeted" });

  const doneMsg = messages.find((m) => m.op === "done") as Extract<BridgeRequest, { op: "done" }> | undefined;
  expect(doneMsg).toBeDefined();
  expect(doneMsg!.result).toEqual({ a: "[hi]", b: "[hi]" });

  expect(messages.some((m) => m.op === "error")).toBe(false);
  expect(exitCode).toBe(0);
  void stderr;
});

test('a syntactically broken source yields {op:"error"}, and the process still exits 0', async () => {
  const { messages, exitCode } = await runChild({ source: `return (;`, args: null, concurrency: 4 });

  const errMsg = messages.find((m) => m.op === "error") as Extract<BridgeRequest, { op: "error" }> | undefined;
  expect(errMsg).toBeDefined();
  expect(errMsg!.message).toBeTruthy();
  expect(messages.some((m) => m.op === "done")).toBe(false);
  expect(exitCode).toBe(0);
});
