// Agent SDK 0.0.40, end to end through a REAL daemon and a REAL `winter` binary: when the model makes
// several tool calls in one turn, each call's `tool_result` is projected the moment THAT call finishes —
// not when the whole batch has. Before 0.0.40 the runtime sent the round's results in one frame after the
// last call, so the Mac showed every call of a parallel batch as running until the slowest was done
// (the dev-home logs: three web_search and five web_fetch results all stamped +69 s).
//
// `winter-test/calls` is the SDK's prompt-scripted double; `+CALL` joins the previous call's round.
//
// (1) SERIAL calls, one round: a Write (instant, and the hooks lane diffs it), then a Bash that sleeps.
//   * two `tool_result`s, exactly one per callId, on the persisted log;
//   * the Write's is stamped a whole sleep BEFORE the Bash's, and reached the client live before it;
//   * the Write's still carries the hooks lane's `fileDiff` (the PostToolUse producer runs inside the
//     call, before the runtime sends that call's frame).
// (2) PARALLEL reads, one round: three calls of a user MCP server's tool listed `readOnlyHint: true`
//     (the stdio fake, `WINTER_FAKE_SLOW_TOOL`), taking 1500 / 300 / 800 ms.
//   * they overlap (the round takes about the slowest, not the sum);
//   * their `tool_result`s land in COMPLETION order, staggered, one per callId;
//   * the model still gets the three results in CALL order.
// Needs a 0.0.40+ binary: WINTER_RUNTIME_EXECUTABLE (else the installed platform package, else skipped).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** Every live event, with the moment the CLIENT received it. */
  readonly events: Array<{ at: number; event: SessionEvent }> = [];
  /** Called the moment each live event arrives, so a test can look at the world AT that moment. */
  onEvent: ((e: SessionEvent) => void) | undefined;
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) { c.events.push({ at: performance.now(), event: msg.params as SessionEvent }); c.onEvent?.(msg.params as SessionEvent); }
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
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 40_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.find((e) => pred(e.event));
      if (hit) return hit.event;
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw: ${this.events.map((e) => e.event.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

const SLEEP_SECONDS = 1.5;
type ToolResultEvent = SessionEvent & { type: "tool_result"; callId: string; ts: number; isError: boolean; output: string; fileDiff?: { path: string; added: number; removed: number; diffId: string } };

describeWithWinterBinary("tool results are projected as each call of a batch finishes (agent SDK 0.0.40)", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  /** The fake MCP server's `<label>.started` / `<label>.done` files (`WINTER_FAKE_MARKER_DIR`). */
  let markers: string;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-per-call-e2e-")));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/calls" },
      runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 10 },
    }, null, 2));
    // A user-scope stdio MCP server whose `wait` tool is listed read-only (claude's format, `sdk/.winter.json`).
    mkdirSync(join(home, "sdk"), { recursive: true });
    markers = join(home, "markers");
    mkdirSync(markers);
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({
      mcpServers: { slow: { command: process.execPath, args: [join(import.meta.dir, "..", "agent", "mcp", "fake-mcp-server.ts")], env: { WINTER_FAKE_SLOW_TOOL: "1", WINTER_FAKE_MARKER_DIR: markers } } },
    }, null, 2));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "e2e" });
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    rmSync(home, { recursive: true, force: true });
  });

  test("a Write and a sleeping Bash in ONE round: two tool_results, one per call, the Write's before the Bash had finished, still carrying its fileDiff", async () => {
    const d = daemon!;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-per-call-e2e-cwd-")));
    const target = join(cwd, "quick.txt");
    // The Bash writes a marker only AFTER its sleep: the Write's result arriving while the marker is still
    // absent proves it arrived before the Bash finished -- causal, not a millisecond gap.
    const marker = join(cwd, "bash-finished");
    const script = [
      `CALL Write ${JSON.stringify({ file_path: target, content: "written first\n" })}`,
      `+CALL Bash ${JSON.stringify({ command: `sleep ${SLEEP_SECONDS}; touch ${marker}; echo slow-one` })}`,
    ].join("\n");
    let markerWhenWriteArrived: boolean | undefined;
    client.onEvent = (e) => {
      if (markerWhenWriteArrived === undefined && e.type === "tool_result" && (e as ToolResultEvent).fileDiff !== undefined) markerWhenWriteArrived = existsSync(marker);
    };

    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: "auto",
    });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: script });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId);
    await Bun.sleep(50);

    const log = d.sessions.read(sessionId);
    expect(log.filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("written first\n");

    // ONE round: both calls came in one model turn (the double numbers a joined call `<round id>-2`).
    const calls = log.filter((e) => e.type === "tool_call") as Array<SessionEvent & { callId: string; name: string }>;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.callId).toBe(`${calls[0]!.callId}-2`);
    const ids = calls.map((c) => c.callId);

    // Exactly one tool_result per call.
    const results = log.filter((e) => e.type === "tool_result") as ToolResultEvent[];
    expect(results.map((r) => r.callId)).toEqual(ids);
    const [write, bash] = results as [ToolResultEvent, ToolResultEvent];
    expect(write.isError).toBe(false);
    expect(bash.isError).toBe(false);
    expect(bash.output).toContain("slow-one");

    // THE fix: the Write's result reached the attached client live BEFORE the Bash had finished, in order.
    const live = client.events.filter((e) => e.event.type === "tool_result" && e.event.sessionId === sessionId);
    expect(live.map((e) => (e.event as ToolResultEvent).callId)).toEqual(ids);
    expect(markerWhenWriteArrived).toBe(false);
    expect(existsSync(marker)).toBe(true);
    client.onEvent = undefined;

    // The hooks lane's diff rides the early event — nothing was lost by projecting it before the round ended.
    expect(write.fileDiff).toBeDefined();
    expect(write.fileDiff!.path).toBe(target);
    expect(write.fileDiff!.added).toBeGreaterThan(0);

    // The model was still handed both results together, in call order (the double answers with them).
    const answer = [...log].reverse().find((e) => e.type === "assistant_message") as { text?: string } | undefined;
    const reported = JSON.parse(answer?.text ?? "[]") as Array<{ name: string; isError: boolean; content: string }>;
    expect(reported.map((r) => r.name)).toEqual(["Write", "Bash"]);
    expect(reported[1]!.content).toContain("slow-one");

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("three read-only MCP calls in ONE round run at once: staggered tool_results in completion order, one per call, the model's results in call order", async () => {
    const d = daemon!;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-per-call-e2e-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: "auto",
    });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    // Turn 1 loads the deferred MCP tool (every MCP tool starts deferred); turn 2 is the parallel batch.
    await client.call(METHODS.sessionSend, { sessionId, text: `CALL ToolSearch ${JSON.stringify({ query: "select:mcp__slow__wait" })}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId);
    const turnsBefore = d.sessions.read(sessionId).filter((e) => e.type === "turn_completed").length;
    const wait = (label: string, ms: number, joined: boolean) => `${joined ? "+" : ""}CALL mcp__slow__wait ${JSON.stringify({ label, ms })}`;
    // What the fake server's marker files said at the moment b's result reached the client.
    let worldWhenFirstArrived: { aStarted: boolean; cStarted: boolean; aDone: boolean } | undefined;
    client.onEvent = (e) => {
      if (worldWhenFirstArrived === undefined && e.type === "tool_result" && (e as ToolResultEvent).output === "b done") {
        worldWhenFirstArrived = { aStarted: existsSync(join(markers, "a.started")), cStarted: existsSync(join(markers, "c.started")), aDone: existsSync(join(markers, "a.done")) };
      }
    };
    await client.call(METHODS.sessionSend, { sessionId, text: [wait("a", 1500, false), wait("b", 300, true), wait("c", 800, true)].join("\n") });
    await client.waitFor(() => d.sessions.read(sessionId).filter((e) => e.type === "turn_completed").length > turnsBefore, 40_000);
    await Bun.sleep(50);

    const log = d.sessions.read(sessionId);
    expect(log.filter((e) => e.type === "approval_requested")).toEqual([]);
    const calls = log.filter((e) => e.type === "tool_call" && (e as { name: string }).name !== "ToolSearch" && (e as { name: string }).name !== "tool_search") as Array<SessionEvent & { callId: string; argsJson: string; ts: number }>;
    expect(calls.map((c) => (JSON.parse(c.argsJson) as { label: string }).label)).toEqual(["a", "b", "c"]);
    const labelOf = new Map(calls.map((c) => [c.callId, (JSON.parse(c.argsJson) as { label: string }).label]));

    // One tool_result per call, in COMPLETION order (b 300 ms, c 800 ms, a 1500 ms).
    const results = log.filter((e) => e.type === "tool_result" && labelOf.has((e as ToolResultEvent).callId)) as ToolResultEvent[];
    expect(results.map((r) => labelOf.get(r.callId))).toEqual(["b", "c", "a"]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.map((r) => r.output)).toEqual(["b done", "c done", "a done"]);
    // …each reached the attached client live, in that same order…
    const live = client.events.filter((e) => e.event.type === "tool_result" && labelOf.has((e.event as ToolResultEvent).callId));
    expect(live.map((e) => labelOf.get((e.event as ToolResultEvent).callId))).toEqual(["b", "c", "a"]);
    // …and they ran AT THE SAME TIME, proved causally: when b's result arrived, a and c had both started
    // and a had not yet finished (the fake server's marker files) -- not a millisecond gap.
    expect(worldWhenFirstArrived).toEqual({ aStarted: true, cStarted: true, aDone: false });
    client.onEvent = undefined;

    // The model got the three results together, in CALL order.
    const answer = [...log].reverse().find((e) => e.type === "assistant_message") as { text?: string } | undefined;
    const reported = JSON.parse(answer?.text ?? "[]") as Array<{ content: string }>;
    expect(reported.map((r) => r.content)).toEqual(["a done", "b done", "c done"]);

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);
});
