// P8b Task 16 — CHAT ON THE WINTER LEG, end to end, on the BUILT binary.
//
// A real `startDaemon` in a temp home with `runtimes.winterLeg.chat = true`, a real NDJSON client
// on its socket, and the real `winter` child `NORMA_WINTER_EXECUTABLE` names (the helper SKIPS this
// whole file when it is unset, and FAILS when `NORMA_WINTER_REQUIRE_BINARY=1`). Every model is a
// `winter-test/<double>` — nothing reaches the network.
//
// The brief's cases (a)–(h), reshaped where the binary's measured behaviour differs from the
// brief's premise (see `winter-session.ts`'s header and the Task 16 report):
//   (a) create → a Winter-leg record; send "hello" → user_message, turn_started, assistant_message,
//       turn_completed, in that order, ONE terminal
//   (b) tooluse → tool_call/tool_result/terminal with NORMA names, the fallback text on the result
//   (c) two sessions; a delivery through the router lands in B's JSONL and runs B's next turn
//   (d) steer during a hang, interrupt → the interrupted terminal, NO agent_error; the child stays
//       live and the same child takes the next send; then end() → resumable → a send RESUMES the
//       same backend session (init reports the same id)
//   (d2) the idle timeout ends the child (kill -0 fails) and a later send resumes it
//   (f) flag OFF (flipped hot) → the engine path; the record has no backend id (leg: engine)
//   (g) send to that engine-era record with the flag back on → session_predates_winter_leg
//   (tripwires) chat's init.tools = exactly the allowed built-ins ∪ chat's capability tools; a
//       code-shaped child advertises BASE ∪ MCP ∪ its capability tools minus the ToolSearch/
//       WaitForMcpServers half `toolSearchEnabled` excludes
//   (e) stop() with a HANGING live turn ends inside the grace and the child is gone
//   (h) ~/.norma and ~/.norma-dev have the same recursive NAME signature before and after
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { Options } from "@yanlinglabs/winter-agent-sdk";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { RuntimeStateWiring } from "../../src/runtime-state";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { CHAT_ALLOWED_WINTER_TOOLS, buildWinterOptions, disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
import { WINTER_ADVERTISED_MCP_TOOLS_0_0_4, WINTER_ADVERTISED_TOOLS_0_0_4_BASE } from "../../src/runtime-sdk/tool-names";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { NORMA_CAPABILITY_TOOLS } from "../../src/capabilities";
import { describeWithWinterBinary } from "../helpers/winter-binary";

// ── a raw NDJSON client that also collects the events it is streamed ─────────────────────────────

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
  /** Wait until an event satisfying `pred` has been streamed to this client. */
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

// ── the home-isolation signature (names only — see scripts/verify-runtime-state-compiled.ts) ────

const REAL_HOMES = [join(homedir(), ".norma"), join(homedir(), ".norma-dev")];
function homeSignature(dir: string): string {
  if (!existsSync(dir)) return `${dir}: absent`;
  const names: string[] = [];
  const walk = (p: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(p).sort(); } catch { names.push(`${rel}/ <unreadable>`); return; }
    for (const name of entries) {
      const child = join(p, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try { isDir = statSync(child).isDirectory(); } catch { names.push(`${childRel} <unreadable>`); continue; }
      names.push(isDir ? `${childRel}/` : childRel);
      if (isDir) walk(child, childRel);
    }
  };
  walk(dir, "");
  return `${dir}: present\n${names.join("\n")}`;
}

/** The child processes of THIS test process that are the winter binary. */
const winterChildren = (bin: string): string[] =>
  Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", bin]).stdout.toString().trim().split("\n").filter(Boolean);
const alive = (pid: string): boolean => Bun.spawnSync(["kill", "-0", pid]).exitCode === 0;

const types = (events: SessionEvent[]): string[] => events.map((e) => e.type);

describeWithWinterBinary("chat on the Winter leg — the built binary through a real daemon", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let rt: RuntimeStateWiring;
  let client: TestClient;
  const signaturesBefore = new Map<string, string>();
  const writeSettings = (chatFlag: boolean): void => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "gpt-x", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: bin, winterLeg: { chat: chatFlag }, winterIdleTimeoutSec: 10 },
    }, null, 2));
  };
  const record = (sid: string) => rt.records.get(sid);
  const backendOf = (sid: string): string => { const b = record(sid)?.backendSessionId; if (!b) throw new Error(`no backend id for ${sid}`); return b; };

  beforeAll(async () => {
    for (const h of REAL_HOMES) signaturesBefore.set(h, homeSignature(h));
    home = mkdtempSync(join(tmpdir(), "norma-winter-chat-e2e-"));
    mkdirSync(home, { recursive: true });
    writeSettings(true);
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const pid of winterChildren(bin)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    rmSync(home, { recursive: true, force: true });
  });

  /** create + attach a chat session on the given double; returns its id and ITS child's pid(s) —
   *  the winter children that appeared with this create (the spawn is synchronous inside
   *  `query()`, and this file creates sessions one at a time). */
  async function createChat(model: string): Promise<{ sid: string; pids: string[] }> {
    const before = new Set(winterChildren(bin));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: `winter-test/${model}` });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const pids = winterChildren(bin).filter((p) => !before.has(p));
    return { sid: sessionId, pids };
  }
  const goneWithin = async (pids: string[], ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (!pids.some(alive)) return true; await Bun.sleep(50); }
    return !pids.some(alive);
  };

  test("the boot order: recovery finished before the socket existed (no projector precedes the sweep)", () => {
    expect(new Date(rt.lastRecovery.finishedAt).getTime()).toBeLessThanOrEqual(statSync(daemon!.socketPath).ctimeMs);
  });

  test("(a) create → a Winter-leg record with a backend uuid; send 'hello' → the ordered turn with ONE terminal", async () => {
    const { sid, pids } = await createChat("echo");
    expect(pids).toHaveLength(1);   // one child per session (P8b-1, path (a))
    const rec = record(sid);
    expect(rec).toBeDefined();
    expect(sessionLegOf(rec)).toBe("winter");
    expect(rec!.backendSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec!.transcriptHealth).toBe("clean");
    expect(rec!.versionProvenance).toBe("recorded");
    expect(rec!.selection.reason).toContain("winter leg");
    const driver = daemon!.winter.get(sid);
    expect(driver?.state).toBe("live");
    expect(driver?.generation).toBe(1);

    const { seq } = await client.call<{ seq: number }>(METHODS.sessionSend, { sessionId: sid, text: "hello" });
    expect(seq).toBeGreaterThan(0);
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    const log = daemon!.sessions.read(sid);
    const turn = types(log).filter((t) => !["session_created", "harness_attached", "harness_detached"].includes(t));
    expect(turn).toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
    expect(log.find((e) => e.type === "user_message")).toMatchObject({ text: "hello", clientName: "e2e", threadId: "main" });
    expect(log.find((e) => e.type === "assistant_message")).toMatchObject({ threadId: "main" });
    expect(log.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "end_turn" });
    // init proved the child ran under the record's backend id
    expect(driver?.init?.sessionId).toBe(rec!.backendSessionId);
    expect(rec!.state === "ready" || record(sid)!.state === "idle").toBe(true);
    expect(record(sid)!.generation).toBe(1);
  }, 30_000);

  test("(tripwire) chat's system/init.tools = exactly the allowed built-ins the child advertises ∪ chat's capability tools", async () => {
    const { sid } = await createChat("echo");
    const driver = daemon!.winter.get(sid)!;
    const t0 = Date.now();
    while (driver.init === undefined && Date.now() - t0 < 10_000) await Bun.sleep(20);
    const chatCaps = Object.entries(NORMA_CAPABILITY_TOOLS).filter(([, f]) => (f.modes as readonly string[]).includes("chat")).map(([n]) => n);
    const disallowed = new Set(disallowedToolsFor("chat"));
    const expected = [...new Set([
      ...WINTER_ADVERTISED_TOOLS_0_0_4_BASE, ...WINTER_ADVERTISED_MCP_TOOLS_0_0_4, ...chatCaps,
    ])].filter((t) => !disallowed.has(t)).sort();
    expect([...driver.init!.tools].sort()).toEqual(expected);
    // and, stated plainly: the four Winter defaults the child advertises (`advisor` is not
    // advertised at 0.0.4), AskUserQuestion, and the three chat capability tools
    expect(expected).toEqual([...CHAT_ALLOWED_WINTER_TOOLS.filter((t) => t !== "advisor"), ...chatCaps].sort());
  }, 30_000);

  test("(b) tooluse → tool_call + tool_result + terminal, NORMA-shaped, and the child's fallback text on the unregistered tool", async () => {
    const { sid } = await createChat("tooluse");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    const log = daemon!.sessions.read(sid).filter((e) => (e as { threadId?: string }).threadId === "main");
    const kinds = types(log).filter((t) => !["harness_attached", "harness_detached"].includes(t));
    expect(kinds).toEqual(["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed"]);
    const call = log.find((e) => e.type === "tool_call") as { name: string; callId: string };
    const res = log.find((e) => e.type === "tool_result") as { callId: string; isError: boolean; output: string };
    expect(call.name).toBe("test_tool");      // no Norma name: the documented fail-open pass-through
    expect(res.callId).toBe(call.callId);
    expect(res.isError).toBe(true);           // the tool is not registered: the child's own denial text
    expect(res.output.length).toBeGreaterThan(0);
  }, 30_000);

  test("(c) a delivery through the router lands in B's JSONL as a user_message and runs B's next turn", async () => {
    const { sid: a } = await createChat("echo");
    const { sid: b } = await createChat("echo");
    for (const sid of [a, b]) { const d = daemon!.winter.get(sid)!; const t0 = Date.now(); while (d.init === undefined && Date.now() - t0 < 10_000) await Bun.sleep(20); }
    const outcome = await daemon!.runtimeSdk!.sdk.messaging.send({
      from: buildSessionAddress(backendOf(a)),
      to: serializeRuntimeAddress(buildSessionAddress(backendOf(b))),
      body: "the deploy is green",
      originToolCallId: "toolu_e2e_01",
    });
    expect(outcome.status).toBe("delivered");
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === b);
    await Bun.sleep(50);
    const log = daemon!.sessions.read(b);
    const um = log.find((e) => e.type === "user_message") as { text: string; clientName: string } | undefined;
    expect(um).toBeDefined();
    expect(um!.clientName).toBe("messaging");
    expect(um!.text).toContain("the deploy is green");
    expect(types(log).filter((t) => ["user_message", "turn_started", "assistant_message", "turn_completed"].includes(t)))
      .toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
    expect(daemon!.sessions.read(a).filter((e) => e.type === "user_message")).toEqual([]);
  }, 30_000);

  test("(d) steer during a hang + interrupt → the interrupted terminal, NO agent_error, the child stays live; end() then send resumes the SAME backend session", async () => {
    const { sid, pids } = await createChat("hang");
    const driver = daemon!.winter.get(sid)!;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hang please" });
    await Bun.sleep(400);
    const steer = await client.call<{ ok: boolean; injected: boolean }>(METHODS.sessionSteer, { sessionId: sid, text: "steer mid-turn" });
    expect(steer).toEqual({ ok: true, injected: true });
    const interrupted = await client.call<{ ok: boolean; wasRunning: boolean }>(METHODS.sessionInterrupt, { sessionId: sid });
    expect(interrupted).toEqual({ ok: true, wasRunning: true });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(100);
    const log = daemon!.sessions.read(sid);
    expect(log.filter((e) => e.type === "agent_error")).toEqual([]);
    expect(log.filter((e) => e.type === "turn_completed")).toHaveLength(1);
    expect(log.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "aborted" });
    // MEASURED on 0.0.4: the child is NOT gone after an interrupt — the same one is still live, and
    // the steered text it had already read became its next turn (a documented cross-leg divergence).
    expect(driver.state).toBe("live");
    expect(driver.generation).toBe(1);
    const firstInit = driver.init?.sessionId;
    expect(firstInit).toBe(backendOf(sid));

    // The resume path, proved explicitly: end() → resumable → the child is gone → a send reopens
    // under `options.resume` and init reports the SAME backend id, with a bumped generation.
    await driver.end();
    expect(driver.state).toBe("resumable");
    expect(await goneWithin(pids, 3000)).toBe(true);
    await client.call(METHODS.sessionSetModel, { sessionId: sid, model: "winter-test/echo" });
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "again" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    expect(driver.state).toBe("live");
    expect(driver.generation).toBe(2);
    expect(driver.init?.sessionId).toBe(firstInit);
    expect(record(sid)!.generation).toBe(2);
    expect(rt.records.generations(sid).map((g) => g.endReason ?? "open")).toEqual(["ended", "open"]);
  }, 40_000);

  test("(d2) the idle timeout ends an idle child (kill -0 fails) and a later send resumes it", async () => {
    const { sid, pids } = await createChat("echo");
    const driver = daemon!.winter.get(sid)!;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "one" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    expect(driver.state).toBe("live");
    expect(pids.some(alive)).toBe(true);
    // winterIdleTimeoutSec is 10 (the schema's floor); the child is reaped ~10 s after its last result
    const t0 = Date.now();
    while (driver.state === "live" && Date.now() - t0 < 14_000) await Bun.sleep(100);
    expect(driver.state).toBe("resumable");
    expect(await goneWithin(pids, 3000)).toBe(true);
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "two" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    expect(driver.state).toBe("live");
    expect(driver.init?.sessionId).toBe(backendOf(sid));
    expect(driver.generation).toBe(2);
    await driver.end();

    // (d3) the sessionPermissionClass seam (Task 12 → 16): a delivery to a RESUMABLE session is
    // answered `unavailable` from its DECLARED class — not held forever as an unknown receiver —
    // and never cold-resumes a child behind the daemon's back (the row was parked without its
    // backend id). The next `send` through the daemon is what resumes it.
    const { sid: sender } = await createChat("echo");
    { const s = daemon!.winter.get(sender)!; const t1 = Date.now(); while (s.init === undefined && Date.now() - t1 < 10_000) await Bun.sleep(20); }
    const before = winterChildren(bin);
    const outcome = await daemon!.runtimeSdk!.sdk.messaging.send({
      from: buildSessionAddress(backendOf(sender)),
      to: serializeRuntimeAddress(buildSessionAddress(backendOf(sid))),
      body: "anyone home?",
      originToolCallId: "toolu_e2e_02",
    });
    expect(outcome.status).toBe("unavailable");
    expect(driver.state).toBe("resumable");
    expect(driver.heldDeliveries).toEqual([]);
    expect(winterChildren(bin)).toEqual(before);
  }, 40_000);

  // (f)/(g) need the flag OFF and then ON again. The settings watcher is built only when an engine
  // exists (daemon.ts's `if (agentProvider)` gate), so on this no-provider daemon a hot flip cannot
  // land — each case boots its OWN daemon over the SAME home, which is also the truer scenario for
  // P8b-22: a session created before the flag, met again by a daemon that has it on.
  let engineSid: string;
  test("(f) with the flag OFF, session.create takes the engine path: a record with NO backend id (leg: engine)", async () => {
    client.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    writeSettings(false);
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    expect(daemon.settings()?.runtimes?.winterLeg?.chat).toBe(false);
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    const created = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: "winter-test/echo" });
    engineSid = created.sessionId;
    expect(daemon.winter.get(engineSid)).toBeUndefined();
    expect(winterChildren(bin)).toEqual([]);   // no child was spawned for an engine-leg create
    const rec = record(engineSid);
    expect(rec).toBeDefined();
    expect(sessionLegOf(rec)).toBe("engine");
    expect(rec!.backendSessionId).toBeUndefined();
    expect(rec!.transcriptHealth).toBe("unsupported");
    expect(rec!.versionProvenance).toBe("legacy-unknown");
    expect(rec!.selection.reason).toContain("engine leg");
    // the Winter-leg records from the first daemon survived that boot's recovery intact
    expect(rt.records.list().filter((r) => sessionLegOf(r) === "winter").length).toBeGreaterThan(0);
  }, 30_000);

  test("(g) with the flag back ON (a restart), session.send to that engine-era record → session_predates_winter_leg; history stays readable", async () => {
    client.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    writeSettings(true);
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    expect(sessionLegOf(record(engineSid))).toBe("engine");
    await client.call(METHODS.sessionAttach, { sessionId: engineSid, fromSeq: 0 });
    const refused = await client.request(METHODS.sessionSend, { sessionId: engineSid, text: "hello?" });
    expect(refused.error).toBeDefined();
    expect(refused.error!.data).toEqual({ code: "session_predates_winter_leg" });
    const steerRefused = await client.request(METHODS.sessionSteer, { sessionId: engineSid, text: "hello?" });
    expect(steerRefused.error?.data).toEqual({ code: "session_predates_winter_leg" });
    // history stays readable, and nothing was appended by the refusal
    expect(daemon.sessions.read(engineSid).filter((e) => e.type === "user_message")).toEqual([]);
    expect(winterChildren(bin)).toEqual([]);
  }, 30_000);

  test("(tripwire) a code-shaped child advertises BASE ∪ MCP ∪ its capability tools, minus the ToolSearch/WaitForMcpServers half toolSearchEnabled excludes", async () => {
    const handle = daemon!.runtimeSdk!;
    const sdk = handle.sdk;
    const sid = "s_tripwire_code";
    const cwd = mkdtempSync(join(tmpdir(), "norma-winter-tripwire-cwd-"));
    const caps = daemon!.buildSessionCapabilities({ sessionId: sid, mode: "code", cwd, roots: [cwd], tmpDir: cwd });
    const hook = handle.spawnHookFor("code");
    if (hook instanceof Error) throw hook;
    const abort = new AbortController();
    const options: Options = buildWinterOptions({
      mode: "code", policy: "auto", sessionId: crypto.randomUUID(), home, cwd, model: "winter-test/echo",
      credentials: { byProvider: {} }, spawn: hook, canUseTool: async () => ({ behavior: "deny", message: "tripwire" }), abort,
      capabilityTools: NORMA_CAPABILITY_TOOLS, capabilities: caps,
    });
    const queue = createHostPromptQueue();
    const q = sdk.query({ prompt: queue, options });
    let tools: string[] = [];
    try {
      for await (const m of q as AsyncIterable<{ type: string; subtype?: string; tools?: string[] }>) {
        if (m.type === "system" && m.subtype === "init") { tools = m.tools ?? []; break; }
      }
    } finally { queue.close(); abort.abort(); }
    const codeCaps = Object.entries(caps).flatMap(([server, cfg]) =>
      (cfg as { instance: { listTools(): Array<{ name: string }> } }).instance.listTools().map((t) => `mcp__${server}__${t.name}`));
    const union = new Set([...WINTER_ADVERTISED_TOOLS_0_0_4_BASE, ...WINTER_ADVERTISED_MCP_TOOLS_0_0_4, ...codeCaps]);
    const pair = ["ToolSearch", "WaitForMcpServers"];
    const advertisedPair = pair.filter((p) => tools.includes(p));
    expect(advertisedPair).toHaveLength(1);
    const expected = [...union].filter((t) => !pair.includes(t) || advertisedPair.includes(t)).sort();
    expect([...tools].sort()).toEqual(expected);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(e) stop() with a HANGING live turn ends inside the grace, and the child is gone", async () => {
    const { sid, pids } = await createChat("hang");
    const driver = daemon!.winter.get(sid)!;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hang forever" });
    await Bun.sleep(400);
    expect(driver.turnRunning).toBe(true);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids.some(alive)).toBe(true);
    client.close();
    const t0 = Date.now();
    const stopping = daemon!.stop();
    daemon = undefined;
    await stopping;
    const took = Date.now() - t0;
    expect(took).toBeLessThan(2000);          // the app's SIGKILL grace
    expect(driver.state).toBe("resumable");
    await Bun.sleep(200);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    // the aborted turn still got its terminal, appended before the store closed
    const store = new (await import("../../src/sessions/store")).SessionStore(home);
    try {
      const log = store.read(sid);
      expect(log.filter((e) => e.type === "agent_error")).toEqual([]);
      expect(log.find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "aborted" });
    } finally { store.close(); }
  }, 30_000);

  test("(h) home isolation: ~/.norma and ~/.norma-dev carry the same name signature as before this file ran", () => {
    for (const h of REAL_HOMES) expect(homeSignature(h)).toBe(signaturesBefore.get(h)!);
  });
});
