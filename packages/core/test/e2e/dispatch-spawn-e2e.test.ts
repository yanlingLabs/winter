// DISPATCH'S `session_spawn`, end to end, through a REAL daemon (the rebuild of the engine-era
// bridge — `agent/dispatch-children.ts`).
//
// A real `startDaemon` on a temp home and a real NDJSON client. The dispatch singleton runs EMBEDDED
// (no binary); its `session_spawn` is called through the daemon's OWN `sessions` capability server for
// that session (`daemon.buildSessionCapabilities`) — no test double scripts a `session_spawn` call, and
// the server is exactly what the runtime child calls. Every model is a `winter-test/<double>`.
//
//   (A) no `winter` binary: the spawn is refused TYPED (`winter_executable_unavailable`, from the same
//       creation transaction `session.create` runs) and leaves no child row
//   (B) the real `winter` binary (WINTER_RUNTIME_EXECUTABLE, or the installed platform package):
//       (1) an echo child is created linked to the coordinator, announced to every harness, runs its
//           turn, reports `completed` with its result, and WAKES the coordinator with a <child_update>
//       (2) a child's approval card is relayed onto the coordinator's log and answered at the child's id
//       (3) stopping a child (`session.interrupt` on it — the Mac's stop button) ends its turn and is
//           reported
//       (5) the coordinator's MODEL follows up a FINISHED child with `SendMessage {to: <its s_ id>}`
//           (agent SDK 0.0.39 `Options.hostMessaging`, answered by `agent/session-messaging.ts`): the
//           child is resumed through its driver, reports running → completed, and wakes the coordinator
//       (6) a CODE session (the spawned `winter` binary — the other topology) lists an active session in
//           ListAgents and messages a finished session by its `session:` address
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
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
  close(): void { try { this.socket.end(); } catch { /* already closed */ } }
}

async function until<T>(probe: () => T | undefined, ms = 30_000, what = "a condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError: boolean };
type ChildUpdate = Extract<SessionEvent, { type: "child_update" }>;

function harnessFor(settings: (home: string) => Record<string, unknown>) {
  const s = {
    home: "", work: "", daemon: undefined as RunningDaemon | undefined, client: undefined as unknown as TestClient, dispatchId: "",
    async boot(): Promise<void> {
      s.home = mkdtempSync(join(tmpdir(), "winter-dispatch-spawn-e2e-"));
      s.work = join(s.home, "work");
      mkdirSync(s.work);
      writeFileSync(join(s.home, "settings.json"), JSON.stringify(settings(s.home), null, 2));
      s.daemon = await startDaemon({ home: s.home, secrets: new FileSecretStore(join(s.home, "test-secrets")), agentProvider: null });
      s.client = await TestClient.connect(s.daemon.socketPath);
      await s.client.hello(s.daemon.tokens.harness, "e2e");
      s.dispatchId = (await s.client.call<{ sessionId: string }>(METHODS.sessionDispatch, {})).sessionId;
      // Dispatch's model is a fixed pin; the store is the one door the driver honours over it.
      await s.daemon.winter.get(s.dispatchId)?.end();
      s.daemon.sessions.setModel(s.dispatchId, "winter-test/echo");
      await s.client.call(METHODS.sessionAttach, { sessionId: s.dispatchId, fromSeq: 0 });
    },
    async stop(): Promise<void> {
      try { s.client?.close(); } catch { /* closed */ }
      const stopping = s.daemon?.stop();
      s.daemon = undefined;
      await stopping;
      rmSync(s.home, { recursive: true, force: true });
    },
    async spawn(args: Record<string, unknown>): Promise<ToolResult> {
      const servers = s.daemon!.buildSessionCapabilities({ sessionId: s.dispatchId, mode: "dispatch", cwd: s.home, roots: [s.home] });
      const instance = servers["winter__sessions"]!.instance as WinterMcpServerInstance;
      return await instance.callTool("session_spawn", args) as ToolResult;
    },
    log: (sid: string): SessionEvent[] => s.daemon!.sessions.read(sid),
    updates: (): ChildUpdate[] => s.log(s.dispatchId).filter((e): e is ChildUpdate => e.type === "child_update"),
  };
  return s;
}

describe("(A) session_spawn with no winter binary", () => {
  const h = harnessFor((home) => ({
    schemaVersion: 3,
    provider: { model: "winter-test/echo" },
    runtimes: { winterExecutable: join(home, "no-such-winter-binary"), winterIdleTimeoutSec: 10 },
  }));
  beforeAll(async () => { await h.boot(); });
  afterAll(async () => { await h.stop(); });

  test("is refused typed by the creation transaction and leaves no child row", async () => {
    const res = await h.spawn({ dir: h.work, prompt: "do it", model: "winter-test/echo" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("could not start the child session");
    expect(res.content[0]!.text).toContain("winter_executable_unavailable");
    expect(h.daemon!.sessions.childrenOf(h.dispatchId)).toEqual([]);
    expect(h.updates()).toEqual([]);
  });

  test("a pre-flight refusal comes back as a tool error before anything is created", async () => {
    const res = await h.spawn({ dir: "relative/path", prompt: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("absolute directory path");
  });
});

describeWithWinterBinary("(B) session_spawn on the real winter binary", (bin) => {
  const h = harnessFor(() => ({
    schemaVersion: 3,
    provider: { model: "winter-test/echo" },
    runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 10 },
  }));
  beforeAll(async () => { await h.boot(); });
  afterAll(async () => { await h.stop(); });

  test("(1) an echo child runs, reports its result, and wakes the coordinator with a <child_update>", async () => {
    const t0 = Date.now();
    const res = await h.spawn({ dir: h.work, prompt: "hello from the coordinator", model: "winter-test/echo", title: "Echo kid" });
    expect(res.isError).toBe(false);
    const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)?.[1];
    expect(child).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(h.daemon!.sessions.meta(child!)).toMatchObject({ mode: "code", origin: "dispatch-child", parentSessionId: h.dispatchId, approvalPolicy: "auto", model: "winter-test/echo" });
    expect(h.daemon!.sessions.meta(child!).backgrounded).not.toBe(true); // user ruling 2026-10-02
    // Announced to every harness, like any session.create.
    await until(() => h.client.events.some((e) => e.type === "session_created" && e.sessionId === child) || undefined, 10_000, "the session_created broadcast");
    // The child's own transcript: the prompt under the dispatch client name, then its turn.
    const first = h.log(child!).find((e) => e.type === "user_message") as { text: string; clientName: string };
    expect(first).toMatchObject({ text: "hello from the coordinator", clientName: "dispatch" });
    // Titled with the spawn's title (the pill's label stays put), at the coordinator's policy.
    expect(h.daemon!.sessions.getTitle(child!)).toBe("Echo kid");
    expect(res.content[0]!.text).toContain("at your current approval policy (auto");
    const done = await until(() => h.updates().find((u) => u.childSessionId === child && u.status === "completed"), 30_000, "the child's completed update");
    expect(done.title).toBe("Echo kid");
    // The echo double echoes the child's whole first user message — the runtime's own system-reminder
    // attachments (agent listing, the deferred-tools announcement since 2026-10-01) included — so the
    // CAPPED summary is the echo's head; the child's own reply carries the prompt in full.
    expect(done.resultSummary ?? "").toStartWith("echo:");
    const childReply = h.log(child!).find((e) => e.type === "assistant_message") as { text?: string } | undefined;
    expect(childReply?.text ?? "").toContain("hello from the coordinator");
    expect(h.updates().filter((u) => u.childSessionId === child).map((u) => u.status)).toEqual(["running", "completed"]);
    // The coordinator is woken with ONE message carrying the update, and runs a turn for it.
    const wake = await until(() => h.log(h.dispatchId).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "dispatch-wake") as { text: string; seq: number } | undefined, 30_000, "the wake message");
    expect(wake.text).toContain("<child_update>");
    expect(wake.text).toContain(`session: ${child}`);
    expect(wake.text).toContain("status: completed");
    await until(() => h.log(h.dispatchId).some((e) => e.type === "turn_completed" && e.seq > wake.seq) || undefined, 30_000, "the coordinator's wake turn");
  }, 90_000);

  test("(1b) the MODEL spawns by the plain name it is shown — `SpawnSession`, through the runtime, not the server door", async () => {
    // The 2026-10-01 tool-surface ruling: the coordinator's model sees `SpawnSession`, never
    // `mcp__winter__sessions__session_spawn`. `winter-test/calls` makes the call exactly as a model
    // would, by that name; the runtime forwards it to the daemon's `sessions` server as `session_spawn`.
    await h.daemon!.winter.get(h.dispatchId)?.end();
    h.daemon!.sessions.setModel(h.dispatchId, "winter-test/calls");
    try {
      const before = h.client.events.length;
      const args = { dir: h.work, prompt: "hello from the model", model: "winter-test/echo", title: "Model kid" };
      await h.client.call(METHODS.sessionSend, { sessionId: h.dispatchId, text: `CALL SpawnSession ${JSON.stringify(args)}` });
      await until(() => h.client.events.some((e) => h.client.events.indexOf(e) >= before && e.type === "turn_completed" && e.sessionId === h.dispatchId) || undefined, 30_000, "the coordinator's spawning turn");
      const result = [...h.log(h.dispatchId)].reverse().find((e) => e.type === "tool_result") as { output: string; isError: boolean };
      expect(result.isError).toBe(false);
      const child = /spawned session (s_[0-9a-f]+)/.exec(result.output)?.[1];
      expect(child).toBeDefined();
      expect(h.daemon!.sessions.meta(child!)).toMatchObject({ mode: "code", origin: "dispatch-child", parentSessionId: h.dispatchId });
      // The projected call carries the HOST name the gate, the cards and the renderers key on.
      const call = [...h.log(h.dispatchId)].reverse().find((e) => e.type === "tool_call") as { name: string };
      expect(call.name).toBe("session_spawn");
      await until(() => h.updates().find((u) => u.childSessionId === child && u.status === "completed"), 30_000, "the model-spawned child's completed update");
    } finally {
      await h.daemon!.winter.get(h.dispatchId)?.end();
      h.daemon!.sessions.setModel(h.dispatchId, "winter-test/echo");
    }
  }, 90_000);

  test("(2) a child's approval card is relayed onto the coordinator's log and answered at the child's id", async () => {
    const res = await h.spawn({ dir: h.work, prompt: "use the tool", model: "winter-test/tooluse", title: "Tool kid" });
    expect(res.isError).toBe(false);
    const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)![1]!;
    const card = await until(() => h.log(h.dispatchId).find((e) => e.type === "approval_requested" && (e as { childSessionId?: string }).childSessionId === child) as { callId: string; toolName: string; expiresAt?: number; issuedAt?: number } | undefined, 30_000, "the relayed card");
    expect(card.toolName).toBe("test_tool");
    expect((card.expiresAt ?? 0) - (card.issuedAt ?? 0)).toBe(10 * 60_000);
    // The card lives on the child's own log too, where the broker keys it.
    expect(h.log(child).some((e) => e.type === "approval_requested" && (e as { callId: string }).callId === card.callId)).toBe(true);
    expect(h.updates().filter((u) => u.childSessionId === child).map((u) => u.status)).toContain("awaiting_approval");
    await h.client.call(METHODS.approvalRespond, { sessionId: child, callId: card.callId, approved: true });
    await until(() => h.log(h.dispatchId).find((e) => e.type === "approval_resolved" && (e as { childSessionId?: string }).childSessionId === child), 30_000, "the relayed resolution");
    await until(() => h.updates().find((u) => u.childSessionId === child && (u.status === "completed" || u.status === "error")), 30_000, "the child's end");
    const toolResult = h.log(child).find((e) => e.type === "tool_result") as { isError: boolean } | undefined;
    expect(toolResult).toBeDefined();
  }, 90_000);

  test("(4) a child takes Dispatch's policy as it is at spawn, through session.create's own door", async () => {
    await h.client.call(METHODS.sessionSetPolicy, { sessionId: h.dispatchId, policy: "accept-edits" });
    try {
      const res = await h.spawn({ dir: h.work, prompt: "policy probe", model: "winter-test/echo" });
      expect(res.isError).toBe(false);
      const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)![1]!;
      expect(h.daemon!.sessions.meta(child).approvalPolicy).toBe("accept-edits");
      await until(() => h.updates().find((u) => u.childSessionId === child && u.status !== "running"), 30_000, "the child's end");
    } finally {
      await h.client.call(METHODS.sessionSetPolicy, { sessionId: h.dispatchId, policy: "auto" });
    }
  }, 90_000);

  test("(5) the model follows up a FINISHED child with SendMessage by its s_ id: resumed, reported running → completed, and the coordinator is woken", async () => {
    const res = await h.spawn({ dir: h.work, prompt: "first task", model: "winter-test/echo", title: "Follow-up kid" });
    expect(res.isError).toBe(false);
    const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)![1]!;
    expect(res.content[0]!.text).toContain(`SendMessage it with to: "${child}"`);
    await until(() => h.updates().find((u) => u.childSessionId === child && u.status === "completed"), 30_000, "the first turn's completed update");
    const firstWake = await until(() => h.log(h.dispatchId).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "dispatch-wake" && (e as { text: string }).text.includes(child)) as { seq: number } | undefined, 30_000, "the first wake");
    await until(() => h.log(h.dispatchId).some((e) => e.type === "turn_completed" && e.seq > firstWake.seq) || undefined, 30_000, "the first wake turn");
    // FINISHED: its child process is gone, so the message must resume it (never the router's cold resume).
    const generation = h.daemon!.winter.get(child)?.generation ?? 0;
    await h.daemon!.winter.get(child)?.end();
    await h.daemon!.winter.get(h.dispatchId)?.end();
    h.daemon!.sessions.setModel(h.dispatchId, "winter-test/calls");
    try {
      const before = h.log(h.dispatchId).length;
      const call = { to: child, message: "second task: say more", summary: "second task" };
      await h.client.call(METHODS.sessionSend, { sessionId: h.dispatchId, text: `CALL SendMessage ${JSON.stringify(call)}` });
      const result = await until(() => h.log(h.dispatchId).slice(before).find((e) => e.type === "tool_result") as { output: string; isError: boolean } | undefined, 60_000, "SendMessage's result");
      expect(result.isError).toBe(false);
      const outcome = JSON.parse(result.output) as { status: string; note?: string };
      expect(outcome.status).toBe("resumed_and_delivered");
      expect(outcome.note).toContain("<child_update>");
      // The child got it as its next turn — plain text (Dispatch is its delegate-user), clientName messaging.
      const msg = await until(() => h.log(child).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "messaging") as { text: string } | undefined, 30_000, "the follow-up in the child's log");
      expect(msg.text).toBe("second task: say more");
      expect((h.daemon!.winter.get(child)?.generation ?? 0)).toBeGreaterThan(generation);
      // Followed: running → completed for the follow-up turn, then the coordinator is woken for it.
      const statuses = await until(() => {
        const s = h.updates().filter((u) => u.childSessionId === child).map((u) => u.status);
        return s.length >= 4 ? s : undefined;
      }, 60_000, "the follow-up's child_updates");
      expect(statuses).toEqual(["running", "completed", "running", "completed"]);
      const done = h.updates().filter((u) => u.childSessionId === child).at(-1)!;
      expect(done.resultSummary ?? "").toContain("second task: say more");
      const wake = await until(() => h.log(h.dispatchId).slice(before).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "dispatch-wake") as { text: string } | undefined, 60_000, "the follow-up wake");
      expect(wake.text).toContain(`session: ${child}`);
      expect(wake.text).toContain("status: completed");
    } finally {
      await h.daemon!.winter.get(h.dispatchId)?.end();
      h.daemon!.sessions.setModel(h.dispatchId, "winter-test/echo");
    }
  }, 150_000);

  test("(6) a CODE session (the spawned winter binary) lists an active session in ListAgents and messages a finished one by its session: address", async () => {
    // A finished session to message, and a RUNNING one (a child mid-turn, nobody attached) to be listed.
    const idle = await h.spawn({ dir: h.work, prompt: "be done", model: "winter-test/echo", title: "Done kid" });
    const idleId = /spawned session (s_[0-9a-f]+)/.exec(idle.content[0]!.text)![1]!;
    await until(() => h.updates().find((u) => u.childSessionId === idleId && u.status === "completed"), 30_000, "the finished session");
    await h.daemon!.winter.get(idleId)?.end();
    const busy = await h.spawn({ dir: h.work, prompt: "keep going", model: "winter-test/hang", title: "Busy kid" });
    const busyId = /spawned session (s_[0-9a-f]+)/.exec(busy.content[0]!.text)![1]!;
    await until(() => h.daemon!.winter.get(busyId)?.turnRunning || undefined, 30_000, "the busy child's turn");
    try {
      const code = (await h.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "global", cwd: h.work, approvalPolicy: "auto", model: "winter-test/calls" })).sessionId;
      await h.client.call(METHODS.sessionAttach, { sessionId: code, fromSeq: 0 });
      const script = ["CALL ListAgents {}", `CALL SendMessage ${JSON.stringify({ to: `session:${idleId}`, message: "a peer asks", summary: "peer" })}`].join("\n");
      await h.client.call(METHODS.sessionSend, { sessionId: code, text: script });
      await until(() => h.log(code).some((e) => e.type === "turn_completed") || undefined, 90_000, "the code session's turn");
      const results = h.log(code).filter((e) => e.type === "tool_result") as Array<{ output: string; isError: boolean }>;
      expect(results).toHaveLength(2);
      const listing = (JSON.parse(results[0]!.output) as { listing: string }).listing;
      expect(listing).toContain(`Busy kid (session:${busyId}) [session/winter-agent] status=running mode=code`);
      expect(listing).not.toContain(idleId);            // finished: not active, so not listed
      expect(listing).not.toContain(code);               // never itself
      expect(results[1]!.isError).toBe(false);
      expect(JSON.parse(results[1]!.output)).toMatchObject({ status: "resumed_and_delivered" });
      const received = await until(() => h.log(idleId).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "messaging") as { text: string } | undefined, 30_000, "the peer's message");
      expect(received.text).toStartWith(`<agent-message from="session:${code}"`);
      expect(received.text).toContain("a peer asks");
      // Not Dispatch's follow-up: the finished child's peer turn is not reported to the coordinator.
      await until(() => h.daemon!.winter.get(idleId)?.turnRunning === false || undefined, 30_000, "the peer turn's end");
      expect(h.updates().filter((u) => u.childSessionId === idleId).map((u) => u.status)).toEqual(["running", "completed"]);
    } finally {
      await h.client.call(METHODS.sessionInterrupt, { sessionId: busyId });
    }
  }, 180_000);

  test("(7) TaskStop stops a SESSION by its s_ id — from Dispatch (embedded) and from a code session (spawned binary)", async () => {
    // Dispatch (the embedded topology) stops its own running child: reported "Stopped before it finished".
    const res = await h.spawn({ dir: h.work, prompt: "spin", model: "winter-test/hang", title: "Spinner" });
    const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)![1]!;
    await until(() => h.daemon!.winter.get(child)?.turnRunning || undefined, 30_000, "the child's turn");
    await h.daemon!.winter.get(h.dispatchId)?.end();
    h.daemon!.sessions.setModel(h.dispatchId, "winter-test/calls");
    await h.client.call(METHODS.sessionAttach, { sessionId: h.dispatchId, fromSeq: 0 }); // (6) moved the client away
    try {
      const before = h.log(h.dispatchId).length;
      await h.client.call(METHODS.sessionSend, { sessionId: h.dispatchId, text: `CALL TaskStop ${JSON.stringify({ task_id: child })}` });
      const result = await until(() => h.log(h.dispatchId).slice(before).find((e) => e.type === "tool_result") as { output: string; isError: boolean } | undefined, 60_000, "TaskStop's result");
      expect({ isError: result.isError, output: result.output }).toMatchObject({ isError: false });
      expect(JSON.parse(result.output)).toMatchObject({ task_id: child, task_type: "session" });
      const end = await until(() => h.updates().find((u) => u.childSessionId === child && u.status !== "running"), 30_000, "the stopped child's update");
      expect(end.status).toBe("completed");
      expect(end.resultSummary ?? "").toContain("Stopped before it finished");
    } finally {
      await h.daemon!.winter.get(h.dispatchId)?.end();
      h.daemon!.sessions.setModel(h.dispatchId, "winter-test/echo");
    }
    // A code session (the spawned `winter` binary) stops another code session; the dispatch session is refused.
    const busy = await h.spawn({ dir: h.work, prompt: "spin too", model: "winter-test/hang", title: "Spinner 2" });
    const busyId = /spawned session (s_[0-9a-f]+)/.exec(busy.content[0]!.text)![1]!;
    await until(() => h.daemon!.winter.get(busyId)?.turnRunning || undefined, 30_000, "the second child's turn");
    const code = (await h.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "global", cwd: h.work, approvalPolicy: "auto", model: "winter-test/calls" })).sessionId;
    await h.client.call(METHODS.sessionAttach, { sessionId: code, fromSeq: 0 });
    await h.client.call(METHODS.sessionSend, { sessionId: code, text: [`CALL TaskStop ${JSON.stringify({ task_id: busyId })}`, `CALL TaskStop ${JSON.stringify({ task_id: h.dispatchId })}`].join("\n") });
    await until(() => h.log(code).some((e) => e.type === "turn_completed") || undefined, 90_000, "the code session's turn");
    const [stopped, refused] = h.log(code).filter((e) => e.type === "tool_result") as Array<{ output: string; isError: boolean }>;
    expect(stopped!.isError).toBe(false);
    expect(stopped!.output).toContain("stopped session");
    await until(() => h.daemon!.winter.get(busyId)?.turnRunning === false || undefined, 30_000, "the second child's stop");
    expect(refused!.isError).toBe(true);
    expect(refused!.output).toContain("only code and Cowork sessions");
  }, 180_000);

  test("(3) stopping a child interrupts its turn, and the stop is reported", async () => {
    const res = await h.spawn({ dir: h.work, prompt: "wait forever", model: "winter-test/hang", title: "Slow kid" });
    expect(res.isError).toBe(false);
    const child = /spawned session (s_[0-9a-f]+)/.exec(res.content[0]!.text)![1]!;
    await until(() => h.daemon!.winter.get(child)?.turnRunning || undefined, 30_000, "the child's turn to start");
    const stopped = await h.client.call<{ ok: boolean; wasRunning: boolean }>(METHODS.sessionInterrupt, { sessionId: child });
    expect(stopped.wasRunning).toBe(true);
    const end = await until(() => h.updates().find((u) => u.childSessionId === child && u.status !== "running"), 30_000, "the stopped child's update");
    expect(end.status).toBe("completed");
    expect(end.resultSummary ?? "").toContain("Stopped before it finished");
  }, 90_000);
});
