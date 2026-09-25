// WS-23 (ruling R1) — CHAT AND DISPATCH RUN EMBEDDED, end to end, through a REAL daemon.
//
// A real `startDaemon` on a temp home and a real NDJSON client on its socket; every model is a
// `winter-test/<double>` (nothing reaches a network or a Keychain). The Winter executable is set to a
// path that DOES NOT EXIST: a code session therefore refuses typed (`winter_executable_unavailable` —
// code still resolves the binary ladder), while chat and dispatch run anyway, in a Bun Worker each
// (`runtime-sdk/embedded.ts`), observed through `daemon.embedded` by their backend session ids. That
// contrast is the proof that no binary is involved, and why this file needs no WINTER_RUNTIME_EXECUTABLE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { RuntimeStateWiring } from "../../src/runtime-state";

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

const TURN = ["user_message", "turn_started", "assistant_message", "turn_completed"];
const turnKinds = (log: SessionEvent[]): string[] => log.map((e) => e.type).filter((t) => TURN.includes(t));

describe("chat and dispatch run embedded — a Worker per session inside a real daemon", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let rt: RuntimeStateWiring;
  let client: TestClient;
  const missingBinary = (): string => join(home, "no-such-winter-binary");

  const bootDaemon = async (): Promise<void> => {
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    rt = daemon.runtimeState;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  };
  const backendOf = (sid: string): string => {
    const b = rt.records.get(sid)?.backendSessionId;
    if (!b) throw new Error(`no backend id for ${sid}`);
    return b;
  };
  const workerLive = (sid: string): boolean => daemon!.embedded.live().includes(backendOf(sid));
  const workerGoneWithin = async (host: RunningDaemon["embedded"], backend: string, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (!host.live().includes(backend)) return true; await Bun.sleep(20); }
    return !host.live().includes(backend);
  };
  async function createChat(model: string): Promise<string> {
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: `winter-test/${model}` });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    return sessionId;
  }
  async function sendAndSettle(sid: string, text: string): Promise<void> {
    const evCount = client.events.length;
    await client.call(METHODS.sessionSend, { sessionId: sid, text });
    await client.waitFor((e) => client.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "winter-embedded-e2e-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: "winter-test/echo" },
      providers: { openai: { baseUrl: "http://127.0.0.1:9/v1" } },
      runtimes: { winterExecutable: join(home, "no-such-winter-binary"), winterIdleTimeoutSec: 10 },
    }, null, 2));
    await bootDaemon();
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    rmSync(home, { recursive: true, force: true });
  });

  test("a chat session runs its turn in a Worker (no binary exists), with the ordinary event shape", async () => {
    const sid = await createChat("echo");
    const backend = backendOf(sid);
    expect(daemon!.embedded.live()).toContain(backend);
    await sendAndSettle(sid, "hello");
    await Bun.sleep(50);
    expect(turnKinds(daemon!.sessions.read(sid))).toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
    const driver = daemon!.winter.get(sid)!;
    expect(driver.state).toBe("live");
    expect(driver.init?.sessionId).toBe(backend);
    // The Worker runs on a router-built per-run folder (WS-21), exactly as a spawned child does — the
    // disposal check at the end of this file is only meaningful because this is not empty.
    expect(readdirSync(join(home, "cache", "runs")).length).toBeGreaterThan(0);
    // The chat surface is the same one a spawned child advertised: WebFetch, never Bash.
    expect(driver.init?.tools).toContain("WebFetch");
    expect(driver.init?.tools).not.toContain("Bash");
  }, 30_000);

  test("a CODE session on the same daemon still resolves the binary ladder — and refuses the missing one typed", async () => {
    const r = await client.request(METHODS.sessionCreate, { scope: "e2e", mode: "code", cwd: home, model: "winter-test/echo" });
    let refusal = r.error;
    if (refusal === undefined) {
      // The refusal may land at the first incarnation rather than at create — either way it is typed.
      const { sessionId } = r.result as { sessionId: string };
      refusal = (await client.request(METHODS.sessionSend, { sessionId, text: "hello" })).error;
    }
    expect(refusal).toBeDefined();
    expect((refusal!.data as { code?: string }).code).toBe("winter_executable_unavailable");
    expect(refusal!.message).toContain(missingBinary());
  }, 30_000);

  test("a DISPATCH session runs embedded too", async () => {
    const { sessionId: sid } = await client.call<{ sessionId: string; created: boolean }>(METHODS.sessionDispatch, {});
    // Dispatch's model is a pin; the store column is the one door the driver honours over it.
    await daemon!.winter.get(sid)?.end();
    daemon!.sessions.setModel(sid, "winter-test/echo");
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    await sendAndSettle(sid, "hello dispatch");
    expect(daemon!.winter.get(sid)?.mode).toBe("dispatch");
    expect(workerLive(sid)).toBe(true);
    const log = daemon!.sessions.read(sid);
    expect(turnKinds(log).slice(-4)).toEqual(["user_message", "turn_started", "assistant_message", "turn_completed"]);
    // Dispatch strips no built-ins: the Worker's session advertises Bash, which runs from the daemon's process.
    expect(daemon!.winter.get(sid)?.init?.tools).toContain("Bash");
    // ...and it RUNS: the `lanec` double's `echo` goes through the real Bash tool, spawned by the
    // Worker thread on the Worker's env (what the router laid on `Options.env`) — a PATH-less or
    // home-less Worker env would fail here, not in a unit test.
    await daemon!.winter.get(sid)?.end();
    daemon!.sessions.setModel(sid, "winter-test/lanec");
    await sendAndSettle(sid, "run the shell");
    const shellLog = daemon!.sessions.read(sid);
    const lastResult = shellLog.filter((e) => e.type === "tool_result").at(-1);
    expect(lastResult).toBeDefined();
    expect(JSON.stringify(lastResult)).toContain("winter-t8-lanec");
    expect(shellLog.filter((e) => e.type === "agent_error")).toEqual([]);
  }, 30_000);

  test("end() ends the Worker; the next send starts a NEW Worker that resumes the SAME backend session", async () => {
    const sid = await createChat("echo");
    await sendAndSettle(sid, "one");
    const driver = daemon!.winter.get(sid)!;
    const backend = backendOf(sid);
    const firstInit = driver.init?.sessionId;
    await driver.end();
    expect(driver.state).toBe("resumable");
    expect(await workerGoneWithin(daemon!.embedded, backend, 3000)).toBe(true);
    await sendAndSettle(sid, "two");
    expect(driver.state).toBe("live");
    expect(driver.resumed).toBe(true);
    expect(driver.generation).toBe(2);
    expect(driver.init?.sessionId).toBe(firstInit);
    expect(workerLive(sid)).toBe(true);
    expect(rt.records.generations(sid).map((g) => g.endReason ?? "open")).toEqual(["ended", "open"]);
    expect(turnKinds(daemon!.sessions.read(sid))).toEqual([...TURN, ...TURN]);
  }, 40_000);

  test("an interrupt ends a hanging turn and the SAME Worker stays live for the next send", async () => {
    const sid = await createChat("hang");
    const driver = daemon!.winter.get(sid)!;
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hang please" });
    await Bun.sleep(300);
    expect(await client.call<{ ok: boolean; wasRunning: boolean }>(METHODS.sessionInterrupt, { sessionId: sid })).toEqual({ ok: true, wasRunning: true });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid);
    await Bun.sleep(50);
    expect(daemon!.sessions.read(sid).find((e) => e.type === "turn_completed")).toMatchObject({ stopReason: "aborted" });
    expect(daemon!.sessions.read(sid).filter((e) => e.type === "agent_error")).toEqual([]);
    expect(driver.state).toBe("live");
    expect(driver.generation).toBe(1);
    expect(workerLive(sid)).toBe(true);
    await driver.end();
  }, 30_000);

  test("two concurrent chat sessions: two Workers live at once, both turns complete, each in its own log", async () => {
    // A harness client is attached to one session at a time, so each session gets its own client.
    const a = await createChat("echo");
    const second = await TestClient.connect(daemon!.socketPath);
    await second.hello(daemon!.tokens.harness, "e2e-b");
    const { sessionId: b } = await second.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "chat", model: "winter-test/echo" });
    await second.call(METHODS.sessionAttach, { sessionId: b, fromSeq: 0 });
    expect(daemon!.embedded.live()).toEqual(expect.arrayContaining([backendOf(a), backendOf(b)]));
    const sendOn = async (c: TestClient, sid: string, text: string): Promise<void> => {
      const evCount = c.events.length;
      await c.call(METHODS.sessionSend, { sessionId: sid, text });
      await c.waitFor((e) => c.events.indexOf(e) >= evCount && e.type === "turn_completed" && e.sessionId === sid);
    };
    await Promise.all([sendOn(client, a, "from a"), sendOn(second, b, "from b")]);
    second.close();
    for (const [sid, text] of [[a, "from a"], [b, "from b"]] as const) {
      const log = daemon!.sessions.read(sid);
      expect(turnKinds(log)).toEqual(TURN);
      expect(log.filter((e) => e.type === "user_message").map((e) => (e as { text: string }).text)).toEqual([text]);
    }
  }, 30_000);

  test("stop() with a HANGING embedded turn ends every Worker inside the shutdown budget; a restarted daemon resumes the session", async () => {
    const sid = await createChat("hang");
    const backend = backendOf(sid);
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hang please" });
    await Bun.sleep(300);
    const host = daemon!.embedded;
    expect(host.live()).toContain(backend);
    client.close();
    const t0 = Date.now();
    const stopping = daemon!.stop();
    daemon = undefined;
    await stopping;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(host.live()).toEqual([]);
    // The record's generation was closed while runtime-state.db was still open (the Worker ended first).
    await bootDaemon();
    expect(rt.records.generations(sid).every((g) => g.endReason !== undefined)).toBe(true);
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    await client.call(METHODS.sessionSetModel, { sessionId: sid, model: "winter-test/echo" });
    await sendAndSettle(sid, "after restart");
    expect(daemon!.winter.get(sid)?.init?.sessionId).toBe(backend);
    expect(daemon!.embedded.live()).toContain(backend);
  }, 60_000);

  test("WS-21 × WS-23: once every Worker has ended, every per-run folder was judged safe and disposed — none quarantined", async () => {
    // The router reports a Winter run home `safe` when the iteration ends; a Worker-run session must
    // reach that verdict exactly as a spawned child does, or its folder is kept (and quarantined) silently.
    client.close();
    const stopping = daemon!.stop();
    daemon = undefined;
    await stopping;
    const runs = join(home, "cache", "runs");
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    expect(existsSync(join(home, "cache", "quarantine"))).toBe(false);
  }, 30_000);
});
