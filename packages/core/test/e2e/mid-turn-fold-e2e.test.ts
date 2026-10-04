// Agent SDK 0.0.44, end to end through a REAL daemon and a REAL `winter` binary (user ruling 2026-10-04,
// "lets fold the message into the running turn"): a message sent to a session while its turn runs reaches
// the model after the turn's current tool call, folded INTO that turn — no turn of its own.
//
// `winter-test/calls` is the SDK's prompt-scripted double: it runs the prompt's `CALL` lines as tool rounds,
// then answers with the round's tool results as JSON — which is exactly where the runtime folds a pending
// message (into the tool result it sends), so the answer text proves the model's next request carried it.
//
// (1) session.steer while a Bash sleeps → `host_input_folded`: ONE turn_completed, the steer's turn_started
//     mid-turn (after the tool_result), the model read the text, nothing left owed in the log.
// (2) SendMessage from another session to a RUNNING one is steered and folded the same way; the sender's
//     answer says so.
// Every scripted Bash waits on a SENTINEL file the test writes only once the message is in the target's log
// (or, for the stop, never before it) — an explicit sync point, never a race against a cold spawn.
// (3) TaskStop (another session's) on a session holding a pushed-but-pending steer: the steer is CLEARED
//     (never reaches the model), the stopped turn ends aborted, and the cleared message is closed in the log
//     after it (turn_started + an aborted turn_completed) — a resume owes nothing.
// Needs a 0.0.44 binary: WINTER_RUNTIME_EXECUTABLE (else the installed platform package, else skipped).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { unconsumedUserMessages } from "../../src/runtime-sdk/winter-session";
import { describeWithWinterBinary } from "../helpers/winter-binary";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
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
            else if (msg.method === METHODS.event) { c.events.push(msg.params as SessionEvent); c.onEvent?.(msg.params as SessionEvent); }
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
  async until(pred: () => boolean, what: string, ms = 40_000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

const main = (log: SessionEvent[]) => log.filter((e) => (e as { threadId?: string }).threadId === "main");
const count = (log: SessionEvent[], type: string) => main(log).filter((e) => e.type === type).length;

describeWithWinterBinary("a message sent mid-turn is FOLDED into the running turn (agent SDK 0.0.44)", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let cwd: string;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-fold-e2e-")));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-fold-e2e-cwd-")));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/calls" },
      runtimes: { winterExecutable: bin, winterIdleTimeoutSec: 30 },
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
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A code session attached to `on` (a client attaches to one session at a time — a second session gets its own). */
  const codeSession = async (on: TestClient = client): Promise<string> => {
    const { sessionId } = await on.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "winter-test/calls", cwd, approvalPolicy: "auto" });
    await on.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    return sessionId;
  };
  /** A Bash call that runs until the TEST says so (it writes the sentinel) — the explicit sync point, so a
   *  message is in the target's log while the tool still runs, however slow a cold sender is to start. */
  let gates = 0;
  const gatedBash = (): { text: string; release: () => void } => {
    const sentinel = join(cwd, `release-${++gates}`);
    const text = `CALL Bash ${JSON.stringify({ command: `while [ ! -f ${sentinel} ]; do sleep 0.05; done; echo first` })}`;
    return { text, release: () => writeFileSync(sentinel, "") };
  };
  const inTargetLog = (sid: string, pred: (e: SessionEvent) => boolean) => () => main(daemon!.sessions.read(sid)).some(pred);

  const secondClient = async (): Promise<TestClient> => {
    const c = await TestClient.connect(daemon!.socketPath);
    await c.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon!.tokens.harness, clientName: "e2e-2" });
    return c;
  };

  test("session.steer while a tool runs: folded — ONE turn_completed, its turn_started mid-turn, the model read it, nothing owed", async () => {
    const d = daemon!;
    const a = await codeSession();
    const steer = "also say the word marmalade";
    let steered: Promise<unknown> | undefined;
    client.onEvent = (e) => {
      if (steered === undefined && e.sessionId === a && e.type === "tool_call") steered = client.call(METHODS.sessionSteer, { sessionId: a, text: steer });
    };
    const gate = gatedBash();
    await client.call(METHODS.sessionSend, { sessionId: a, text: gate.text });
    await client.until(inTargetLog(a, (e) => e.type === "user_message" && (e as { text?: string }).text === steer), "the steer in the log");
    await steered;
    gate.release();                                            // only now may the tool round end
    await client.until(() => count(d.sessions.read(a), "turn_completed") >= 1, "the turn's end");
    await Bun.sleep(300);                                      // nothing else may follow
    client.onEvent = undefined;
    const log = d.sessions.read(a);
    expect(count(log, "turn_completed")).toBe(1);              // ONE terminal for both messages
    expect(count(log, "turn_started")).toBe(2);
    const types = main(log).map((e) => e.type);
    const firstResult = types.indexOf("tool_result");
    const foldStart = types.lastIndexOf("turn_started");
    expect(foldStart).toBeGreaterThan(firstResult);            // announced at the fold, mid-turn
    expect(foldStart).toBeLessThan(types.indexOf("turn_completed"));
    const answer = main(log).filter((e) => e.type === "assistant_message").at(-1) as { text: string };
    expect(answer.text).toContain("marmalade");                 // the next request carried the folded text
    expect(answer.text).toContain("The user sent a new message while you were working");
    expect(unconsumedUserMessages(log)).toEqual([]);           // a resume re-pushes nothing
    expect(main(log).filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text)).toEqual([gate.text, steer]);
  }, 60_000);

  test("SendMessage to a RUNNING session is steered and folded; the sender is told it reads it after its current tool call", async () => {
    const d = daemon!;
    const other = await secondClient();
    const target = await codeSession();
    const sender = await codeSession(other);
    let sent = false;
    client.onEvent = (e) => {
      if (sent || e.sessionId !== target || e.type !== "tool_call") return;
      sent = true;
      void other.call(METHODS.sessionSend, { sessionId: sender, text: `CALL SendMessage ${JSON.stringify({ to: target, message: "please also check the changelog", summary: "changelog" })}` });
    };
    const gate = gatedBash();
    await client.call(METHODS.sessionSend, { sessionId: target, text: gate.text });
    await client.until(inTargetLog(target, (e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "messaging"), "the message in the target's log", 60_000);
    gate.release();                                            // the round ends only once the message is pending
    await client.until(() => count(d.sessions.read(target), "turn_completed") >= 1 && count(d.sessions.read(sender), "turn_completed") >= 1, "both turns' ends");
    await Bun.sleep(300);
    client.onEvent = undefined;
    const tlog = d.sessions.read(target);
    expect(count(tlog, "turn_completed")).toBe(1);
    expect(count(tlog, "turn_started")).toBe(2);
    const delivered = main(tlog).find((e) => e.type === "user_message" && (e as { clientName?: string }).clientName === "messaging") as { text: string } | undefined;
    expect(delivered?.text).toContain("please also check the changelog");
    const answer = main(tlog).filter((e) => e.type === "assistant_message").at(-1) as { text: string };
    expect(answer.text).toContain("please also check the changelog");
    expect(unconsumedUserMessages(tlog)).toEqual([]);
    const sendResult = d.sessions.read(sender).find((e) => e.type === "tool_result") as { output: string; isError: boolean };
    expect(sendResult.isError).toBe(false);
    expect(sendResult.output).toContain("after its current tool call");
    other.close();
  }, 60_000);

  test("TaskStop on a session holding a pushed-but-pending steer: the steer is CLEARED (never reaches the model) and closed in the log after the stopped turn", async () => {
    const d = daemon!;
    const other = await secondClient();
    const target = await codeSession();
    const stopper = await codeSession(other);
    const steer = "this one must never run";
    let started = false;
    client.onEvent = (e) => {
      if (started || e.sessionId !== target || e.type !== "tool_call") return;
      started = true;
      void (async () => {
        await client.call(METHODS.sessionSteer, { sessionId: target, text: steer });
        await other.call(METHODS.sessionSend, { sessionId: stopper, text: `CALL TaskStop ${JSON.stringify({ task_id: target })}` });
      })();
    };
    // The gate is NEVER released before the stop: the tool runs until TaskStop interrupts it, so the steer is
    // still pending (not folded) when the clear arrives, however slow the stopper is to start.
    const gate = gatedBash();
    await client.call(METHODS.sessionSend, { sessionId: target, text: gate.text });
    try {
      await client.until(() => count(d.sessions.read(stopper), "turn_completed") >= 1, "the stopper's turn", 60_000);
      await client.until(() => count(d.sessions.read(target), "turn_completed") >= 2, "the stopped turn and the cleared message closed");
    } finally {
      gate.release();
    }
    await Bun.sleep(500);
    client.onEvent = undefined;
    const tlog = d.sessions.read(target);
    const stops = main(tlog).filter((e) => e.type === "turn_completed").map((e) => (e as { stopReason: string }).stopReason);
    expect(stops).toEqual(["aborted", "aborted"]);              // the stopped turn, then the cleared steer
    expect(count(tlog, "turn_started")).toBe(2);
    expect(unconsumedUserMessages(tlog)).toEqual([]);          // a resume never re-runs it
    // it never reached the model: no assistant answer mentions it, and no further turn ran
    expect(main(tlog).filter((e) => e.type === "assistant_message").some((e) => (e as { text: string }).text.includes(steer))).toBe(false);
    const stopResult = d.sessions.read(stopper).find((e) => e.type === "tool_result") as { output: string; isError: boolean };
    expect(stopResult.isError).toBe(false);
    expect(stopResult.output).toContain("stopped session");
    expect(stopResult.output).toContain("1 message was queued behind that turn");
    other.close();
  }, 60_000);
});
