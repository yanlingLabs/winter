// Fix wave, item 10 — THE BOUNDED PROBE (whole-branch review F6), now a PINNED MEASUREMENT: does a `{ type: "image" }` block
// in a capability server's `callTool` result reach the child, and does the child forward it toward
// the model? Measured on the BUILT binary through the driver table (no daemon): an `sdk` server
// named `t8mcpsdk` (the name the `mcpsdk` double calls — `mcp__t8mcpsdk__echo`) answers with a text
// block AND an image block. Two observations:
//   (1) the persisted `tool_result.output` — the projector renders a non-text block in the child's
//       `user` tool_result frame as `[<type>]`, so `[image]` in the output means the child carried
//       the block on the wire it hands the host;
//   (2) the child's OWN transcript JSONL under `<home>/projects/<key>/<backend>.jsonl` — the record
//       of what the model is given on the next round; an image block there is the block reaching
//       the model's input.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { PermissionGate } from "../../src/agent/gate";
import { QuestionBroker } from "../../src/agent/questions";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createNormaRuntimeSdk } from "../../src/runtime-sdk/create";
import { createWinterSessionDrivers } from "../../src/runtime-sdk/session-driver";
import { openRuntimeStateDb, ProjectionCheckpoints, RuntimeSessionRecords } from "../../src/runtime-state";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import type { Settings } from "../../src/settings";
import { describeWithWinterBinary } from "../helpers/winter-binary";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describeWithWinterBinary("item 10 probe: MCP image content through a capability server, on the built binary", (bin) => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

  test("a text+image callTool result: what the child forwards (tool_result output; the child's transcript)", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-image-probe-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-image-cwd-")));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const rs = openRuntimeStateDb(home);
    const records = new RuntimeSessionRecords(rs);
    const checkpoints = new ProjectionCheckpoints(rs);
    const settings = { runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 10 } } as unknown as Settings;
    const secrets = new FileSecretStore(join(home, "secrets.json"));
    const runtime = await createNormaRuntimeSdk({ home, settings: () => settings, secrets, capabilities: [] });
    const calls: Array<{ name: string; args: unknown }> = [];
    const drivers = createWinterSessionDrivers({
      home, settings: () => settings, runtime, records, checkpoints, store, hub, secrets,
      buildSessionCapabilities: () => ({}),
      // THE PROBE SERVER: named as the double expects; its one tool answers text + image.
      extraMcpServers: () => ({
        t8mcpsdk: {
          type: "sdk", name: "t8mcpsdk",
          instance: {
            listTools: () => [{ name: "echo", description: "probe", inputSchema: { type: "object", properties: { x: { type: "number" } } } }],
            callTool: async (name: string, args: Record<string, unknown>) => {
              calls.push({ name, args });
              return { content: [{ type: "text", text: "Screenshot captured (screen is 1×1)." }, { type: "image", data: TINY_PNG_B64, mimeType: "image/png" }], isError: false };
            },
          },
        },
      }),
      approvals: new ApprovalBroker(), questions: new QuestionBroker(), gate: new PermissionGate(),
      rootsOf: () => [cwd], tmpDirOf: () => cwd, outDirOf: () => cwd, memoryKeyOf: () => "k",
      idleTimeoutMs: () => 60_000, endGraceMs: 120,
      log: () => {},
    });
    cleanups.push(async () => {
      await drivers.endAll();
      await runtime.dispose();
      store.close(); rs.close();
      rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
    });
    const sid = store.createSession("probe", { mode: "code", model: "winter-test/mcpsdk", cwd, approvalPolicy: "auto" });
    const session = await drivers.create(sid);
    await session.send("call the tool", "probe");
    const t0 = Date.now();
    while (!store.read(sid).some((e) => e.type === "turn_completed") && Date.now() - t0 < 20_000) await Bun.sleep(25);
    const log: SessionEvent[] = store.read(sid);
    expect(log.map((e) => e.type)).toContain("turn_completed");
    // the double's call reached OUR server with its scripted args
    expect(calls).toEqual([{ name: "echo", args: { x: 1 } }]);
    const res = log.find((e) => e.type === "tool_result") as { output: string; isError: boolean } | undefined;
    expect(res).toBeDefined();
    // (1) the wire the child hands the host: the projector renders a non-text block as `[image]`
    // (2) the child's own transcript — the model's input record
    const record = records.get(sid)!;
    const dir = record.backendRoot;
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    const transcript = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const lines = transcript.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).filter(Boolean) as Array<Record<string, unknown>>;
    const toolResults = lines.filter((l) => JSON.stringify(l).includes("tool_result"));
    expect(files).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    // ── THE MEASUREMENT (2026-09-11, dist/winter @ v0.0.4) — pinned, so an SDK bump that changes
    // it is a loud signal rather than a silent one. The child FLATTENS the MCP content array to ONE
    // TEXT STRING: the transcript's `tool_result.content` is a string in which the non-text block
    // is JSON-serialized and joined with "\n" — `"Screenshot captured (…).\n{\"type\":\"image\",
    // \"data\":\"iVBOR…\",\"mimeType\":\"image/png\"}"`. No `{ type: "image" }` block reaches the
    // model's input; the bytes reach it as base64 TEXT, which no vision model reads as an image.
    // Verdict: `attachImage` cannot be shipped through MCP image content at 0.0.4 — the carry is
    // the SDK's (forward image blocks from `sdk_mcp_call` results as image content blocks in the
    // `tool_result`). THE DAY THE ASSERTIONS BELOW FLIP, item 10's fix becomes shippable:
    // `capabilities/server.ts` staging `ctx.attachImage` data URLs as `{ type: "image" }` blocks.
    const transcriptToolResultContent = (toolResults[0] as { message?: { content?: Array<{ content?: unknown }> } } | undefined)?.message?.content?.[0]?.content;
    expect(typeof transcriptToolResultContent).toBe("string");                 // flattened, not an array of blocks
    expect(String(transcriptToolResultContent)).toContain("Screenshot captured");
    expect(String(transcriptToolResultContent)).toContain('{"type":"image"');   // the block, serialized INTO the text
    expect(String(transcriptToolResultContent)).toContain(TINY_PNG_B64);        // the bytes, as text
    expect(toolResults.some((l) => JSON.stringify(l).includes('"type":"image","source"') || (l as { message?: { content?: Array<{ content?: unknown }> } }).message?.content?.some((b) => Array.isArray((b as { content?: unknown }).content)))).toBe(false);
    // and the host-side rendering agrees: the projector saw a STRING (no `[image]` marker)
    expect(res!.output).toContain("Screenshot captured");
    expect(res!.output).not.toContain("[image]");
    expect(res!.output).toContain('{"type":"image"');
    await session.end();
  }, 40_000);
});
