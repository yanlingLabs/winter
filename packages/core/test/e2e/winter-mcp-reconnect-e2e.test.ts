// WS-25 live failure (dev daemon, 2026-09-27), reproduced on the BUILT binary through a real daemon: a CODE
// session's live `winter` child is connected to a signed-in OAuth http server (a user-scope server in
// `sdk/.winter.json`); the user signs out, then in again, through the daemon's doors. Each door asks the live
// child to reconnect the server (`agent/mcp/reconnect.ts` -> `WinterSession.reconnectMcpServer` -> the
// runtime's `mcp_reconnect`). Live, BOTH reconnects failed after exactly MCP_TIMEOUT (30 s), the second queued
// behind the first, and the tools never came back:
//
//   12:21:45 mcp: signed out of 'github'
//   12:22:15 mcp: s_… reconnected 'github', which did not connect (WinterRpcError)   <- the SIGN-OUT's reconnect
//   12:22:45 mcp: s_… reconnected 'github', which did not connect (WinterRpcError)   <- the SIGN-IN's
//
// Root cause (agent SDK <= 0.0.31, runtime `engine.ts`): the engine's input pump awaited `mcp_reconnect`
// INLINE, and a brokered reconnect's preflight reads the sign-in over `credential_resolve`, whose answer only
// that same pump can route back -- so the answer sat unread until the preflight's bound fired ("the sign-in
// check exceeded 30000ms"). Fixed in the SDK (`fix/mcp-reconnect`); this test stays RED until the pinned
// runtime carries it.
//
// What must hold: the sign-out's reconnect answers promptly that the server is not connected (needs sign-in,
// not a timeout), and the sign-in's reconnect CONNECTS promptly -- the child re-lists the server's tools with
// the new token (a fresh MCP request at the fixture), in the session that is already open.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { startFixtureAs, type FixtureAs } from "../fixtures/mcp-oauth-fixture-as";

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
  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    const r = await new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve) => this.pending.set(id, resolve));
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
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

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!(await check())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

describeWithWinterBinary("WS-25: a live code child reconnects a signed-out-then-signed-in OAuth server (built binary, real daemon)", (bin) => {
  const SERVER = "gh";
  let home: string;
  let cwd: string;
  let fx: FixtureAs;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  const lines: Array<{ at: number; line: string }> = [];
  let errorSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    // The daemon's reconnect verdicts are its own log lines (`console.error`); keep them, print nothing.
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push({ at: Date.now(), line: args.map(String).join(" ") }); });
    fx = startFixtureAs();
    home = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-reconnect-e2e-"))), ".winter");
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-reconnect-cwd-")));
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/echo", baseUrl: "http://127.0.0.1:9/v1" },
      // A long idle timeout: the red run spends ~60 s in reconnects, and an idle-ended child would turn the
      // second reconnect into `WinterLegUnsupported` rather than the failure under test.
      runtimes: { winterExecutable: bin, winterLeg: { code: true }, winterIdleTimeoutSec: 600 },
    }, null, 2));
    // The user-scope OAuth http server, like the live `github` entry.
    writeFileSync(join(home, "sdk", ".winter.json"), JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: fx.mcpUrl } } }, null, 2));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    client = await TestClient.connect(daemon.socketPath);
    await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "mcp-reconnect-e2e" });
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    fx?.close();
    errorSpy?.mockRestore();
    rmSync(join(home, ".."), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  async function signIn(): Promise<void> {
    const start = await client.call<{ loginId: string; authUrl: string }>(METHODS.mcpLogin, { name: SERVER });
    await fx.approve(start.authUrl);
    await until(async () => (await client.call<{ state: string }>(METHODS.mcpLoginStatus, { loginId: start.loginId })).state === "done", 10_000, "the sign-in to finish");
  }

  const reconnectLines = (sid: string): Array<{ at: number; line: string }> => lines.filter((l) => l.line.startsWith(`mcp: ${sid} reconnected '${SERVER}'`));

  test("connected -> sign-out (reconnect: not connected, promptly) -> sign-in (reconnect: CONNECTED, promptly, tools re-listed)", async () => {
    await signIn();
    // A live child: one turn on the echo double. The child connects the server at spawn with the sign-in.
    const { sessionId: sid } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "winter-test/echo", cwd, approvalPolicy: "auto" });
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId: sid, text: "hello" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid, 30_000);
    await until(() => fx.mcpRequests > 0, 15_000, "the child to connect the server with the first sign-in");
    expect(daemon!.winter.list().find((s) => s.sessionId === sid)?.mcpServerNamesFor?.(fx.mcpUrl)).toEqual([SERVER]);

    // SIGN-OUT through the door: the live child is asked to reconnect, and must answer promptly.
    const signOutAt = Date.now();
    await client.call(METHODS.mcpLogout, { name: SERVER });
    await until(() => reconnectLines(sid).length >= 1, 70_000, "the sign-out's reconnect verdict");
    const signOut = reconnectLines(sid)[0]!;
    expect(signOut.line).toContain("which did not connect");
    expect(signOut.line).not.toContain("sign-in check exceeded"); // the deadlock's fingerprint (visible since reconnect.ts logs the message)
    expect(signOut.at - signOutAt).toBeLessThan(10_000);

    // SIGN-IN through the door: the reconnect must CONNECT, with the new token, in the open session.
    const requestsBefore = fx.mcpRequests;
    const signInAt = Date.now();
    await signIn();
    await until(() => reconnectLines(sid).length >= 2, 70_000, "the sign-in's reconnect verdict");
    const signInLine = reconnectLines(sid)[1]!;
    expect(signInLine.line).toBe(`mcp: ${sid} reconnected '${SERVER}'`);
    expect(signInLine.at - signInAt).toBeLessThan(15_000);
    expect(fx.mcpRequests).toBeGreaterThan(requestsBefore); // the child re-initialised and re-listed with the new token
  }, 180_000);
});
