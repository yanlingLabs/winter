// P8b Task 17 Step 1 — DISPATCH ON THE WINTER LEG, end to end, on the BUILT binary.
//
// A real `startDaemon` in a temp home whose settings carry NO `winterLeg` block (the engine is
// retired: every mode is the Winter leg), a real NDJSON client, the real `winter` child
// `WINTER_RUNTIME_EXECUTABLE` names (skipped when unset; required under WINTER_RUNTIME_REQUIRE_BINARY=1).
// Every model is a `winter-test/<double>`; nothing reaches the network.
//
//   (a) `session.dispatch` mints the singleton ON THE WINTER LEG by default; the card-free pin
//       (P8b-7): under `auto` the `tooluse` double's unclassified `test_tool` → a `tool_result`
//       carrying the never-prompts deny message and NO `approval_requested` anywhere
//   (b) the `subagent` double spawns a child → `thread_started`/`thread_completed`, the child's own
//       frames on its thread, and a `PersistedWinterChild` row (`runtime_children`) that survives a
//       simulated RESTART; after the restart the same singleton resumes (no second dispatch session,
//       `resumed === true`) and the double, seeing its earlier spawn in the transcript, spawns nothing
//   (c) a dispatch `session.send` while a turn runs is HELD (P8b-5/39): its `user_message` lands with
//       no `turn_started`; an interrupt leaves it owed for the next inbound action
//   (d) home isolation + zero `dist/winter` survivors
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@winter/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { RuntimeStateWiring } from "../../src/runtime-state";
import { neverPromptsMessage } from "../../src/runtime-sdk/approval-bridge";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { describeWithWinterBinary } from "../helpers/winter-binary";

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
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 20_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for an event; saw: ${this.events.map((e) => e.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* already closed */ } }
}

const REAL_HOMES = [join(homedir(), ".winter"), join(homedir(), ".winter-dev")];
function walkHome(dir: string, describe: (rel: string, st: Stats) => string): string {
  if (!existsSync(dir)) return `${dir}: absent`;
  const lines: string[] = [];
  const walk = (p: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(p).sort(); } catch { lines.push(`${rel}/ <unreadable>`); return; }
    for (const name of entries) {
      const child = join(p, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st: Stats;
      try { st = statSync(child); } catch { lines.push(`${childRel} <unreadable>`); continue; }
      lines.push(describe(childRel, st));
      if (st.isDirectory()) walk(child, childRel);
    }
  };
  walk(dir, "");
  return `${dir}: present\n${lines.join("\n")}`;
}
const homeSignature = (dir: string): string => walkHome(dir, (rel, st) => (st.isDirectory() ? `${rel}/` : rel));
const projectsSignature = (home: string): string => walkHome(join(home, "projects"), (rel, st) => `${rel} ${st.size} ${st.mtimeMs}`);
const winterSurvivors = (bin: string): string[] =>
  Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").map((l) => l.trim()).filter((l) => l.replace(/^\d+\s+/, "").startsWith(bin));
const winterChildren = (bin: string): string[] =>
  Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", bin]).stdout.toString().trim().split("\n").filter(Boolean);
const alive = (pid: string): boolean => Bun.spawnSync(["kill", "-0", pid]).exitCode === 0;
const types = (events: SessionEvent[]): string[] => events.map((e) => e.type);
const TURN = ["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed", "approval_requested", "thread_started", "thread_completed", "agent_error"];

describeWithWinterBinary("dispatch on the Winter leg — the built binary through a real daemon", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let rt: RuntimeStateWiring;
  let client: TestClient;
  const signaturesBefore = new Map<string, string>();
  const projectsBefore = new Map<string, string>();
  let sid: string;

  const writeSettings = (): void => {
    // NO `winterLeg` block: the schema's per-mode defaults decide (Task 17 Step 1: dispatch on).
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/tooluse", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 10 },
    }, null, 2));
  };
  const bootDaemon = async (): Promise<void> => {
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  };
  const stopDaemon = async (): Promise<void> => {
    client.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
  };
  const goneWithin = async (pids: string[], ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (!pids.some(alive)) return true; await Bun.sleep(50); }
    return !pids.some(alive);
  };
  const mainLog = (): SessionEvent[] => daemon!.sessions.read(sid).filter((e) => (e as { threadId?: string }).threadId === "main" || (e as { threadId?: string }).threadId === undefined);
  const kinds = (log: SessionEvent[]): string[] => types(log).filter((t) => TURN.includes(t));
  /** Switch the singleton's double. `session.setModel` refuses a dispatch target (its model is a
   *  FIXED PIN, `DISPATCH_MODEL`), so the test writes the store directly — the one door the driver
   *  honours over the pin — and the model is re-read when the child reopens. */
  const switchDouble = async (model: string): Promise<void> => {
    await daemon!.winter.get(sid)?.end();
    daemon!.sessions.setModel(sid, model);
  };

  beforeAll(async () => {
    for (const h of REAL_HOMES) { signaturesBefore.set(h, homeSignature(h)); projectsBefore.set(h, projectsSignature(h)); }
    home = mkdtempSync(join(tmpdir(), "winter-dispatch-e2e-"));
    mkdirSync(home, { recursive: true });
    writeSettings();
    await bootDaemon();
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const pid of winterChildren(bin)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test("(a) session.dispatch mints the singleton on the Winter leg BY DEFAULT; the card-free pin: an unclassified tool under auto → a never-prompts tool_result, no approval_requested", async () => {
    expect(daemon!.winter.legForNewSession("dispatch")).toBe("winter");
    expect(daemon!.winter.legForNewSession("chat")).toBe("winter");   // Task 17 Step 4: every mode
    expect(daemon!.winter.legForNewSession("code")).toBe("winter");
    const before = winterChildren(bin);
    const minted = await client.call<{ sessionId: string; created: boolean }>(METHODS.sessionDispatch, {});
    expect(minted.created).toBe(true);
    sid = minted.sessionId;
    expect(winterChildren(bin).filter((p) => !before.includes(p))).toHaveLength(1);
    const rec = rt.records.get(sid);
    expect(sessionLegOf(rec)).toBe("winter");
    expect(rec!.backendSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(daemon!.sessions.meta(sid)).toMatchObject({ mode: "dispatch", approvalPolicy: "auto", origin: "dispatch" });
    const again = await client.call<{ sessionId: string; created: boolean }>(METHODS.sessionDispatch, {});
    expect(again).toEqual({ sessionId: sid, created: false });
    const driver = daemon!.winter.get(sid)!;
    expect(driver.state).toBe("live");
    expect(driver.mode).toBe("dispatch");
    // the pin: the singleton was minted on DISPATCH_MODEL (no per-session override exists)
    expect(daemon!.sessions.meta(sid).model).toBeUndefined();

    await switchDouble("winter-test/tooluse");
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    // (1) under `auto` — the SHIPPED dispatch policy, which is Winter's `default` mode since P8b-7
    // was amended (review F1): the unclassified call reaches THE BRIDGE, whose gate fails closed to
    // "ask" for an unclassified tool under every policy, and the dispatch session never prompts —
    // so the tool_result is P8b-7's own deny text and NO card exists on either side. (Before F1
    // this half passed for the wrong reason: Winter's `auto` mode ran its model-backed classifier
    // ahead of the bridge and blocked the call itself — "Blocked by classifier".)
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(100);
    let log = mainLog();
    expect(kinds(log)).toEqual(["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed"]);
    const call = log.find((e) => e.type === "tool_call") as { name: string; callId: string };
    const res = log.find((e) => e.type === "tool_result") as { callId: string; isError: boolean; output: string };
    expect(call.name).toBe("test_tool");
    expect(res.callId).toBe(call.callId);
    expect(res.isError).toBe(true);
    expect(res.output).toContain(neverPromptsMessage("test_tool", "dispatch", "auto"));
    expect(res.output).not.toContain("classifier");
    // (2) under `ask` (Winter's `default` mode, the bridge's door): P8b-7's own deny message — the
    // dispatch session never prompts — and still no card anywhere. The `tooluse` double scripts ONE
    // tool round per child process, so the child is reopened (the policy is re-read from the store
    // on reopen; the live `setPermissionMode` path is the driver unit test's).
    await daemon!.winter.get(sid)!.end();
    await client.call(METHODS.sessionSetPolicy, { sessionId: sid, policy: "ask" });
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool again" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(100);
    log = mainLog();
    expect(kinds(log).slice(-6)).toEqual(["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed"]);
    const res2 = log.filter((e) => e.type === "tool_result").at(-1) as { isError: boolean; output: string };
    expect(res2.isError).toBe(true);
    expect(res2.output).toContain(neverPromptsMessage("test_tool", "dispatch", "ask"));
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(client.events.filter((e) => e.type === "approval_requested")).toEqual([]);
    const errors = daemon!.sessions.read(sid).filter((e) => e.type === "agent_error") as Array<{ message: string }>;
    expect(errors.map((e) => e.message)).toEqual([]);
    await client.call(METHODS.sessionSetPolicy, { sessionId: sid, policy: "auto" });
  }, 40_000);

  test("(b) the subagent double spawns a child → thread_started/thread_completed + a PersistedWinterChild row that survives a simulated restart; the singleton resumes", async () => {
    await switchDouble("winter-test/subagent");
    // Under `auto` — the SHIPPED dispatch policy (the singleton is minted with it and (a) restored
    // it). Since review F1 (`auto → default`) the spawn reaches THE BRIDGE, whose gate allows
    // `spawn_agent` silently in dispatch; before F1 this round had to run under `ask` because
    // Winter's own classifier blocked the `Agent` call under its `auto` mode.
    expect(daemon!.sessions.meta(sid).approvalPolicy).toBe("auto");
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "run the subagent" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(100);
    const log = daemon!.sessions.read(sid);
    const started = log.find((e) => e.type === "thread_started") as { threadId: string; agentType: string; prompt: string; description?: string } | undefined;
    expect(started).toBeDefined();
    expect(started!.agentType).toBe("general-purpose");
    expect(started!.prompt).toBe("child probe text");
    expect(started!.description).toBe("equivalence probe");
    const completed = log.find((e) => e.type === "thread_completed") as { threadId: string; stopReason: string } | undefined;
    expect(completed).toMatchObject({ threadId: started!.threadId, stopReason: "end_turn" });
    // the child's own frames rode the parent's wire (`forwardSubagentText`) onto its thread
    expect(log.some((e) => (e as { threadId?: string }).threadId === started!.threadId && e.type === "assistant_message")).toBe(true);
    expect(log.filter((e) => e.type === "agent_error")).toEqual([]);
    // P8b-15: the persisted child, keyed by the spawning tool_use.id, completed
    const row = rt.children.get(sid, started!.threadId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("completed");
    expect(row!.completedAt).toBeDefined();
    expect(rt.children.list(sid)).toHaveLength(1);
    const driver = daemon!.winter.get(sid)!;
    expect(driver.generation).toBe(4);   // minted (1), tooluse under auto (2), tooluse under ask (3), subagent under auto (4)

    // the simulated restart
    const pids = winterChildren(bin);
    await stopDaemon();
    expect(await goneWithin(pids, 3000)).toBe(true);
    await bootDaemon();
    expect(rt.children.get(sid, started!.threadId)?.status).toBe("completed");
    expect(rt.children.list(sid)).toHaveLength(1);
    expect(sessionLegOf(rt.records.get(sid))).toBe("winter");
    expect(daemon!.winter.get(sid)).toBeUndefined();   // never cold-resumed at boot
    // the singleton is the same session, and the first RPC resumes it
    expect(await client.call<{ sessionId: string; created: boolean }>(METHODS.sessionDispatch, {})).toEqual({ sessionId: sid, created: false });
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    const ev2 = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "again" });
    const resumed = daemon!.winter.get(sid)!;
    expect(resumed.resumed).toBe(true);
    expect(resumed.generation).toBe(5);
    await client.waitFor((e) => client.events.indexOf(e) >= ev2 && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(100);
    // the double saw its earlier spawn in the resumed transcript: no second child
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "thread_started")).toHaveLength(1);
    expect(rt.children.list(sid)).toHaveLength(1);
    expect(resumed.init?.sessionId).toBe(rt.records.get(sid)!.backendSessionId);
    await client.call(METHODS.sessionSetPolicy, { sessionId: sid, policy: "auto" });
  }, 60_000);

  test("(c) a dispatch session.send while a turn runs is HELD (P8b-5/39): user_message with no turn_started; an interrupt leaves it owed", async () => {
    await switchDouble("winter-test/hang");
    const driver0 = daemon!.winter.get(sid);
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hang please" });
    const driver = daemon!.winter.get(sid)!;
    expect(driver0 === undefined || driver0 === driver).toBe(true);
    await Bun.sleep(400);
    expect(driver.turnRunning).toBe(true);
    const held = await client.call<{ seq: number }>(METHODS.sessionSend, { sessionId: sid, text: "held one" });
    expect(held.seq).toBeGreaterThan(0);
    expect(driver.pendingSends).toEqual(["held one"]);
    expect(kinds(mainLog()).slice(-3)).toEqual(["user_message", "turn_started", "user_message"]);
    await client.call(METHODS.sessionInterrupt, { sessionId: sid });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(200);
    expect(driver.pendingSends).toEqual(["held one"]);   // owed until the next inbound action
    expect(driver.turnRunning).toBe(false);
    expect(kinds(mainLog()).slice(-4)).toEqual(["user_message", "turn_started", "user_message", "turn_completed"]);
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "agent_error")).toEqual([]);
    await driver.end();
  }, 40_000);

  test("(d) home isolation: ~/.winter and ~/.winter-dev untouched (names; projects/ size+mtime), and no dist/winter survives", async () => {
    if (daemon !== undefined) await stopDaemon();
    for (const h of REAL_HOMES) {
      expect(homeSignature(h)).toBe(signaturesBefore.get(h)!);
      expect(projectsSignature(h)).toBe(projectsBefore.get(h)!);
    }
    const t0 = Date.now();
    while (winterSurvivors(bin).length > 0 && Date.now() - t0 < 3000) await Bun.sleep(50);
    expect(winterSurvivors(bin).map((l) => l.slice(0, 120))).toEqual([]);
  });
});
