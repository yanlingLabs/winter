// P8b Task 17 Step 2 — CODE ON THE WINTER LEG, end to end, on the BUILT binary.
//
// A real `startDaemon` in a temp home with `winterLeg: { code: true }`, a real NDJSON client, the
// real `winter` child. Every model is a `winter-test/<double>`; nothing reaches the network.
//
//   (a) `tooluse` under `ask` → an `approval_requested` carrying the phone's fields; `approval.respond`
//       allows; the `tool_result` follows (the double's unregistered tool → its own fallback text)
//   (b) the same call under `plan` → the plan-mode deny, no card, no mutation
//   (c) the per-session `computer` capability reaches the daemon's ComputerUseService (a spy) and is
//       code-only (NORMA_CAPABILITY_TOOLS: computer ∈ code, ∉ chat)
//   (d) P8b-27(c): a control-plane self-grant is DENIED — a Write to `<cwd>/.norma/settings.json`
//       (the host fence) and a Bash redirect to a path outside the session's write roots (the
//       sandbox). This case is the gate for `winterLeg.code`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { computerCapability } from "../../src/capabilities";
import { NORMA_CAPABILITY_TOOLS } from "../../src/capabilities/names";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { RuntimeStateWiring } from "../../src/runtime-state";
import { controlPlaneDenialMessage } from "../../src/runtime-sdk/control-plane";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
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
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw: ${this.events.map((e) => e.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

const REAL_HOMES = [join(homedir(), ".norma"), join(homedir(), ".norma-dev")];
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
const types = (events: SessionEvent[]): string[] => events.map((e) => e.type);

describeWithWinterBinary("code on the Winter leg — the built binary through a real daemon", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let rt: RuntimeStateWiring;
  let client: TestClient;
  const signaturesBefore = new Map<string, string>();
  const projectsBefore = new Map<string, string>();

  const writeSettings = (): void => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/tooluse", baseUrl: "http://127.0.0.1:9/v1" },
      computerUse: { enabled: true },
      runtimes: { winterExecutable: bin, winterLeg: { code: true }, winterIdleTimeoutSec: 10 },
    }, null, 2));
  };

  async function createCode(model: string, cwd: string, policy = "ask"): Promise<string> {
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: `winter-test/${model}`, cwd, approvalPolicy: policy });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    return sessionId;
  }
  const mainKinds = (sid: string): string[] => types(daemon!.sessions.read(sid).filter((e) => (e as { threadId?: string }).threadId === "main")).filter((t) => ["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed", "approval_requested", "agent_error"].includes(t));

  beforeAll(async () => {
    for (const h of REAL_HOMES) { signaturesBefore.set(h, homeSignature(h)); projectsBefore.set(h, projectsSignature(h)); }
    home = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-e2e-")));
    writeSettings();
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
    expect(daemon.winter.legForNewSession("code")).toBe("winter");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const pid of winterChildren(bin)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    rmSync(home, { recursive: true, force: true });
  });

  test("(a) tooluse under `ask` → approval_requested with the phone's fields; approval.respond allows; the tool_result follows", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-cwd-")));
    const sid = await createCode("tooluse", cwd, "ask");
    expect(sessionLegOf(rt.records.get(sid))).toBe("winter");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    const card = await client.waitFor((e) => e.type === "approval_requested" && e.sessionId === sid) as {
      callId: string; toolName: string; summary: string; issuedAt?: number; expiresAt?: number;
    };
    // the phone reads exactly these
    expect(card.callId.length).toBeGreaterThan(0);
    expect(card.toolName).toBe("test_tool");
    expect(card.summary.length).toBeGreaterThan(0);
    expect(typeof card.issuedAt).toBe("number");
    expect(typeof card.expiresAt).toBe("number");
    // nothing has resolved yet: no tool_result before the answer
    expect(daemon!.sessions.read(sid).some((e) => e.type === "tool_result")).toBe(false);
    await client.call(METHODS.approvalRespond, { sessionId: sid, callId: card.callId, approved: true });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    // the call proceeded past the card; a tool_result followed (the double's tool is unregistered,
    // so it is the child's own fallback — the point is that approval let it RUN)
    expect(mainKinds(sid).filter((t) => t !== "approval_requested")).toEqual(["user_message", "turn_started", "tool_call", "tool_result", "assistant_message", "turn_completed"]);
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "approval_requested")).toHaveLength(1);
    const res = daemon!.sessions.read(sid).find((e) => e.type === "tool_result") as { callId: string };
    expect(res.callId).toBe(card.callId);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(b) the same call under `plan` → the plan-mode deny, no card, no mutation", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-plan-")));
    const sid = await createCode("tooluse", cwd, "plan");
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "use the tool" });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    const res = daemon!.sessions.read(sid).find((e) => e.type === "tool_result") as { isError: boolean; output: string };
    expect(res.isError).toBe(true);
    // Winter's `plan` mode denies the mutation; whether the message is Winter's own or the bridge's,
    // it must READ as plan mode and NO card was raised
    expect(res.output.toLowerCase()).toContain("plan");
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(client.events.filter((e) => e.type === "approval_requested" && e.sessionId === sid)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(c) the per-session computer capability reaches the daemon's ComputerUseService (spy) and is code-only", async () => {
    // NORMA_CAPABILITY_TOOLS: computer is a code/dispatch tool, never chat.
    const modes = NORMA_CAPABILITY_TOOLS["mcp__norma__computer__computer"].modes as readonly string[];
    expect(modes).toContain("code");
    expect(modes).not.toContain("chat");
    // the daemon's own builder includes `computer` for a code session (computerUse.enabled: true)
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-cap-")));
    const record = daemon!.buildSessionCapabilities({ sessionId: "s_probe", mode: "code", cwd, roots: [cwd], tmpDir: cwd });
    expect(Object.keys(record)).toContain("norma__computer");
    // the server is built for every mode (P8b-36); the MODE scoping is `disallowedTools` (P8b-12)
    expect(disallowedToolsFor("chat")).toContain("mcp__norma__computer__computer");
    expect(disallowedToolsFor("code")).not.toContain("mcp__norma__computer__computer");
    // the tool reaches the service: build the capability with a spy and drive its instance
    const calls: Array<{ cls: string; payload: string }> = [];
    const spy = { act: async (_sid: string, cls: string, payload: string) => { calls.push({ cls, payload }); return { ok: true, resultJson: JSON.stringify({ text: "#0 window" }) }; } };
    const cap = computerCapability({ sessionId: "s_probe", mode: "code", cwd, roots: [cwd] }, { computerUse: () => spy as never });
    const out = await (cap as { instance: { callTool(name: string, args: unknown): Promise<{ content: unknown[]; isError?: boolean }> } }).instance.callTool("computer", { action: "ax_snapshot" });
    expect(out.isError ?? false).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cls).toBe("ax-read");
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);

  test("(d) P8b-27(c): a control-plane self-grant is DENIED — the host fence on a Write, the sandbox on a Bash redirect", async () => {
    // (d1) the HOST FENCE (P8b-27b): a Write to a `.norma/settings.json` never reaches the child's
    // filesystem. `p5checkpoint` reads then writes the path in the prompt's last line.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-grant-")));
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    const rules = join(cwd, ".norma", "settings.json");
    writeFileSync(rules, JSON.stringify({ before: true }));   // exists so the double's Read succeeds
    const sid = await createCode("p5checkpoint", cwd, "auto");
    await client.call(METHODS.sessionSend, { sessionId: sid, text: `write to this exact path:\n${rules}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    const writeRes = daemon!.sessions.read(sid).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as { isError: boolean; output: string } | undefined;
    expect(writeRes).toBeDefined();
    expect(writeRes!.isError).toBe(true);
    // MEASURED: Winter's stage-2 deny rule (P8b-27a, `Write(//**/.norma/settings.json)`) fires
    // BEFORE `canUseTool`, so the bridge's own fence (P8b-27b) is the second layer behind it —
    // either denial text is the invariant holding
    expect(writeRes!.output === controlPlaneDenialMessage("Write", rules) || /Denied by permission rule/.test(writeRes!.output)).toBe(true);
    expect(JSON.parse(readFileSync(rules, "utf8"))).toEqual({ before: true });   // untouched on disk

    // (d2) the SANDBOX: the double's Bash step (`printf ... > <path>.bash`) writes OUTSIDE the
    // session's write roots. The sandbox must deny it (the write never lands). This is the layer
    // P8b-27(c) can only prove against the real binary — the gate for `winterLeg.code`.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-winter-code-outside-"))); // NOT a root of `sid`
    const target = join(outside, "grant");   // the double appends ".bash"
    const sid2 = await createCode("p5checkpoint", cwd, "auto");
    writeFileSync(join(cwd, "seed.txt"), "seed");   // the double reads/writes this in-root file first
    await client.call(METHODS.sessionSend, { sessionId: sid2, text: `write to this exact path:\n${target}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid2);
    await Bun.sleep(50);
    const bashRes = daemon!.sessions.read(sid2).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-bash") as { isError: boolean; output: string } | undefined;
    expect(bashRes).toBeDefined();
    // the write outside the roots did not land (the sandbox fenced it)
    expect(existsSync(`${target}.bash`)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }, 60_000);

  test("(e) home isolation and zero survivors", async () => {
    client.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    for (const h of REAL_HOMES) {
      expect(homeSignature(h)).toBe(signaturesBefore.get(h)!);
      expect(projectsSignature(h)).toBe(projectsBefore.get(h)!);
    }
    const t0 = Date.now();
    while (winterSurvivors(bin).length > 0 && Date.now() - t0 < 3000) await Bun.sleep(50);
    expect(winterSurvivors(bin).map((l) => l.slice(0, 120))).toEqual([]);
  });
});
