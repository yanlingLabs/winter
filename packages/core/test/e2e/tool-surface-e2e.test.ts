// THE TOOL SURFACE, end to end through a REAL daemon (the 2026-10-01 tool-surface ruling).
//
// A real `startDaemon` on a temp home and a real NDJSON client. Chat and dispatch run EMBEDDED (a Worker
// each, no binary); code runs the real `winter` binary (WINTER_RUNTIME_EXECUTABLE, else skipped). Every
// session runs `winter-test/calls`, the agent SDK's prompt-scripted double: the user message's
// `CALL <Tool> <json>` lines are the calls it makes, BY THE NAME THE MODEL IS SHOWN, one per round — so
// what is pinned here is what a model actually gets:
//
//   * `system/init.tools` — the EAGER set, exactly: chat's and dispatch's ALLOWED lists (`Options.tools`)
//     plus the eager capability tools; code's full built-in set;
//   * the DEFERRED set — `ToolSearch`'s own `total_deferred_tools`, and a `select:` that loads exactly the
//     deferred tools the ruling names (`Computer`, `Browser`, `CronList`, the office/LSP tools in code)
//     and nothing outside the mode's set;
//   * the renamed tools are reachable under their PLAIN names, and only those (`ListSessions` runs; the
//     old `mcp__winter__sessions__list_sessions` is not a tool the model is offered);
//   * the Exa key swaps `Search` for `WebSearch` in chat and dispatch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { EXA_API_KEY_SECRET } from "../../src/agent/exa-key";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { winterExecutableForTests } from "../helpers/winter-binary";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) c.events.push(msg.params as SessionEvent);
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 30_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error("timed out waiting for an event");
      await Bun.sleep(25);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

type Reported = Array<{ name: string | null; isError: boolean; content: string }>;
interface Surface { eager: string[]; results: Reported }

/** The modes' surfaces, by Exa-key state (`withExa` / `noExa` daemons). */
async function bootDaemon(withExa: boolean): Promise<{ home: string; daemon: RunningDaemon; client: TestClient }> {
  const home = mkdtempSync(join(tmpdir(), `winter-tool-surface-${withExa ? "exa" : "noexa"}-`));
  const bin = winterExecutableForTests();
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 3,
    provider: { model: "winter-test/calls" },
    // Computer use ON, so `Computer` is offered where the ruling offers it.
    computerUse: { enabled: true },
    runtimes: { winterIdleTimeoutSec: 10, ...(bin !== undefined ? { winterExecutable: bin } : {}) },
  }, null, 2));
  const secrets = new FileSecretStore(join(home, "test-secrets"));
  if (withExa) await secrets.set(EXA_API_KEY_SECRET, "exa-test-key-not-real");
  const daemon = await startDaemon({ home, secrets, agentProvider: null });
  const client = await TestClient.connect(daemon.socketPath);
  await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "e2e" });
  return { home, daemon, client };
}

async function surfaceOf(d: { daemon: RunningDaemon; client: TestClient }, sid: string, script: string): Promise<Surface> {
  await d.client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 }).catch(() => undefined);
  const before = d.client.events.length;
  await d.client.call(METHODS.sessionSend, { sessionId: sid, text: script });
  await d.client.waitFor((e) => d.client.events.indexOf(e) >= before && e.type === "turn_completed" && e.sessionId === sid);
  const answer = [...d.daemon.sessions.read(sid)].reverse().find((e) => e.type === "assistant_message" && (e as { threadId?: string }).threadId === "main") as { text?: string } | undefined;
  return { eager: [...(d.daemon.winter.get(sid)?.init?.tools ?? [])].sort(), results: JSON.parse(answer?.text ?? "[]") as Reported };
}

/** The deferred names the runtime announced to the model, read from the child's own transcript (its
 *  persisted `deferred_tools_delta` attachments, folded: added minus removed). */
function announcedDeferred(daemon: RunningDaemon, sid: string): string[] {
  const rt = daemon.runtimeState as { records?: { get(id: string): { backendRoot?: string } | undefined } };
  const root = rt.records?.get(sid)?.backendRoot;
  if (root === undefined || !existsSync(root)) return [];
  const announced = new Set<string>();
  for (const file of readdirSync(root).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
      if (!line.includes("deferred_tools_delta")) continue;
      const attachment = (JSON.parse(line) as { attachment?: { type?: string; addedNames?: string[]; removedNames?: string[] } }).attachment;
      if (attachment?.type !== "deferred_tools_delta") continue;
      for (const n of attachment.addedNames ?? []) announced.add(n);
      for (const n of attachment.removedNames ?? []) announced.delete(n);
    }
  }
  return [...announced].sort();
}

const toolSearchResult = (s: Surface, i = 0): { matches: string[]; total_deferred_tools: number } => {
  const searches = s.results.filter((r) => r.name === "ToolSearch");
  return JSON.parse(searches[i]!.content) as { matches: string[]; total_deferred_tools: number };
};

/** Every name a mode could conceivably be offered — a `select:` over it loads exactly what the mode has. */
const PROBE = [
  "Computer", "Browser", "CronList", "SpawnSession", "ListSessions", "ManageSession",
  "mcp__winter__office__docs", "mcp__winter__office__sheets", "mcp__winter__office__slides", "mcp__winter__lsp__lsp",
  "mcp__winter__computer__computer", "mcp__winter__browser__browser", "mcp__winter__sessions__session_spawn",
  "Edit", "Write", "Agent", "Glob", "Grep", "Monitor", "ListAgents",
].join(",");

/** The STANDING server's alias twins of `SendMessage`/`ListAgents` (the agent SDK's WS-09 §10 design: a
 *  model that knows the canonical spelling may still select it). Deferred wherever their native is
 *  offered, hidden wherever it is not; same executor, so no new capability. */
const SEND_MESSAGE_TWIN = "mcp__winter__send_message";
const LIST_AGENTS_TWIN = "mcp__winter__list_agents";

describe("the tool surface (Exa key stored)", () => {
  let d: Awaited<ReturnType<typeof bootDaemon>>;
  beforeAll(async () => { d = await bootDaemon(true); }, 60_000);
  afterAll(async () => { d.client.close(); await d.daemon.stop(); rmSync(d.home, { recursive: true, force: true }); });

  test("DISPATCH: exactly the ruling's allowed set up front; Computer/Browser/CronList deferred; the renamed tools run by their plain names", async () => {
    const { sessionId } = await d.client.call<{ sessionId: string }>(METHODS.sessionDispatch, {});
    await d.daemon.winter.get(sessionId)?.end();
    d.daemon.sessions.setModel(sessionId, "winter-test/calls");
    const s = await surfaceOf(d, sessionId, [
      `CALL ToolSearch {"query":"select:${PROBE}"}`,
      `CALL ListSessions {}`,
      `CALL mcp__winter__sessions__list_sessions {}`,
      `CALL Edit {"file_path":"/tmp/x","old_string":"a","new_string":"b"}`,
    ].join("\n"));
    expect(s.eager).toEqual([
      "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "ListSessions", "ManageSession", "PushNotification", "Read",
      "ScheduleWakeup", "Search", "SendMessage", "SpawnSession", "TaskStop", "ToolSearch", "WebFetch",
    ]);
    const search = toolSearchResult(s);
    expect([...search.matches].sort()).toEqual(["Browser", "Computer", "CronList", "ListSessions", "ManageSession", "SpawnSession"]);
    // The deferred pool: the three the ruling names, plus SendMessage's standing twin (see above).
    expect(search.total_deferred_tools).toBe(4);
    // `ListSessions` runs (a real listing); the OLD spelling — what a resumed coordinator's history may
    // teach the model — still runs as the same tool; and a built-in outside the allowed list is refused
    // as no such tool.
    const [, listed, oldSpelling, edit] = s.results;
    expect(listed).toMatchObject({ name: "ListSessions", isError: false });
    expect(oldSpelling).toMatchObject({ name: "mcp__winter__sessions__list_sessions", isError: false });
    expect(oldSpelling!.content).toBe(listed!.content);
    // Refused by the fail-closed deny list first (every known built-in dispatch's allowed list leaves out),
    // ahead of the runtime's own "No such tool" for a built-in outside `Options.tools`.
    expect(edit!.content).toBe("Denied by permission rule: Edit");
    // The projector records the call under the HOST name the renderers and the gate key on.
    const calls = d.daemon.sessions.read(sessionId).filter((e) => e.type === "tool_call") as Array<{ name: string }>;
    expect(calls.map((c) => c.name)).toContain("list_sessions");
    // The MODEL is told which tools are deferred: the runtime's persisted `deferred_tools_delta` names
    // exactly the three the ruling defers (never the standing server's twin of SendMessage).
    expect(announcedDeferred(d.daemon, sessionId)).toEqual(["Browser", "Computer", "CronList"]);
    // The incarnation passed the fail-closed init check (nothing outside its allowed list was offered).
    expect(d.daemon.sessions.read(sessionId).filter((e) => e.type === "agent_error")).toEqual([]);
    void SEND_MESSAGE_TWIN;
  }, 60_000);

  test("CHAT: its set unchanged apart from ToolSearch (Browser deferred), Search not WebSearch", async () => {
    const { sessionId } = await d.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: "winter-test/calls" });
    const s = await surfaceOf(d, sessionId, [
      `CALL ToolSearch {"query":"select:${PROBE}"}`,
      // Loaded, then CALLED by its plain name: it runs (chat's read-only verb set), through the gate and
      // the connector floor — a plain-named capability tool is not a connector action.
      `CALL Browser {"verb":"tabs"}`,
    ].join("\n"));
    // `advisor` is chat-allowed but advertised only when a reviewer resolves (none for a test double).
    expect(s.eager).toEqual(["AskUserQuestion", "ListAgents", "ReadNotifications", "Search", "SendMessage", "ToolSearch", "WebFetch"]);
    const search = toolSearchResult(s);
    expect([...search.matches].sort()).toEqual(["Browser", "ListAgents"]);
    // Browser, plus the two standing twins of chat's SendMessage/ListAgents.
    expect(search.total_deferred_tools).toBe(3);
    const browsed = s.results[1]!;
    expect(browsed.name).toBe("Browser");
    expect(browsed.content).not.toContain("No such tool");
    expect(browsed.content).not.toContain("deferred tool that has not been loaded");
    expect(d.daemon.sessions.read(sessionId).filter((e) => e.type === "approval_requested")).toEqual([]);
    const calls = d.daemon.sessions.read(sessionId).filter((e) => e.type === "tool_call") as Array<{ name: string }>;
    expect(calls.map((c) => c.name)).toEqual(["ToolSearch", "browser"]);
    expect(d.daemon.sessions.read(sessionId).filter((e) => e.type === "agent_error")).toEqual([]);
    void LIST_AGENTS_TWIN;
  }, 60_000);
});

describe("the tool surface (NO Exa key)", () => {
  let d: Awaited<ReturnType<typeof bootDaemon>>;
  beforeAll(async () => { d = await bootDaemon(false); }, 60_000);
  afterAll(async () => { d.client.close(); await d.daemon.stop(); rmSync(d.home, { recursive: true, force: true }); });

  test("chat and dispatch get WebSearch INSTEAD of Search — and Search is not even loadable", async () => {
    const { sessionId: chat } = await d.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: "winter-test/calls" });
    const c = await surfaceOf(d, chat, `CALL ToolSearch {"query":"select:Search,WebSearch"}`);
    expect(c.eager).toContain("WebSearch");
    expect(c.eager).not.toContain("Search");
    expect(toolSearchResult(c).matches).toEqual(["WebSearch"]);
    const { sessionId: dispatch } = await d.client.call<{ sessionId: string }>(METHODS.sessionDispatch, {});
    await d.daemon.winter.get(dispatch)?.end();
    d.daemon.sessions.setModel(dispatch, "winter-test/calls");
    const s = await surfaceOf(d, dispatch, `CALL ToolSearch {"query":"select:Search,WebSearch"}`);
    expect(s.eager).toContain("WebSearch");
    expect(s.eager).not.toContain("Search");
  }, 60_000);
});

const bin = winterExecutableForTests();
(bin === undefined ? describe.skip : describe)("the tool surface — CODE (the real winter binary)", () => {
  let d: Awaited<ReturnType<typeof bootDaemon>>;
  beforeAll(async () => { d = await bootDaemon(true); }, 60_000);
  afterAll(async () => { d.client.close(); await d.daemon.stop(); rmSync(d.home, { recursive: true, force: true }); });

  test("CODE keeps its full built-in set; ToolSearch replaces WaitForMcpServers; every capability tool and CronList start deferred", async () => {
    const { sessionId } = await d.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", cwd: d.home, model: "winter-test/calls" });
    const s = await surfaceOf(d, sessionId, `CALL ToolSearch {"query":"select:${PROBE}"}`);
    expect(s.eager).toEqual([
      "Agent", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode",
      "ExitWorktree", "Glob", "Grep", "ListAgents", "ListMcpResourcesTool", "Monitor", "NotebookEdit", "PushNotification", "Read",
      "ReadMcpResourceDirTool", "ReadMcpResourceTool", "ReadNotifications", "RefreshMcpTools", "ReportFindings", "ScheduleWakeup",
      "SendMessage", "Skill", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch",
      "WebSearch", "Workflow", "Write",
    ]);
    const search = toolSearchResult(s);
    expect([...search.matches].sort()).toEqual([
      "Agent", "Browser", "Computer", "CronList", "Edit", "Glob", "Grep", "ListAgents", "Monitor", "Write",
      "mcp__winter__lsp__lsp", "mcp__winter__office__docs", "mcp__winter__office__sheets", "mcp__winter__office__slides",
    ]);
    // Browser, Computer, CronList, the three office tools, LSP — and the two standing twins.
    expect(search.total_deferred_tools).toBe(9);
  }, 60_000);
});
