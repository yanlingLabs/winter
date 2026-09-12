// P8c integration round 2, item 2 — proves daemon.ts's OWN construction of the hooks facade
// (`HookFacade`/`HookRunner`/`BashReviewer`, wired via `WinterLegDeps.hooksFor`) reaches a REAL
// spawned `dist/winter` child through a REAL `startDaemon`, not just the hand-assembled
// `sessionHooksFor(...)` unit/integration coverage in hooks.test.ts / hooks-integration.e2e.test.ts
// (both of which build the facade themselves and drive a bare `query()`, never `daemon.ts`).
//
// The seam: a `Bash` call whose command trips `bashLooksSafe` to false (a shell redirect, `>`)
// reaches `bashReviewerHook` under `auto` policy; the hook calls `deps.reviewer.review(...)`, which
// is `daemon.ts`'s own `BashReviewer` over a `FakeProvider` scripted to answer "unsafe". A
// `PreToolUse` deny blocks the call end-to-end — the resulting `tool_result` carries the FAKE
// reviewer's own reason text, never the command's stdout, which is only possible if `daemon.ts`'s
// wiring (not a test double, not a default) is what answered the hook.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@winter/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FakeProvider } from "../../src/agent/fake-provider";
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
  close(): void { this.socket.end(); }
}

describeWithWinterBinary("daemon.ts's hooksFor wiring — the BashReviewer reaches a real winter child", (bin) => {
  test("a PreToolUse deny from daemon.ts's OWN BashReviewer blocks a real Bash call end to end", async () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), "winter-hooks-wiring-"))), ".winter");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/p5checkpoint", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: bin, winterLeg: { code: true }, winterIdleTimeoutSec: 10 },
    }, null, 2));
    // Empty model list ⇒ `resolveModelSelection`'s "a BYO endpoint that cannot enumerate" skip —
    // `session.create` accepts the `winter-test/p5checkpoint` model verbatim, unrelated to this
    // provider's OWN (irrelevant) reviewer model.
    const reviewProvider = new FakeProvider([[
      { type: "text_delta", delta: '{"verdict":"unsafe","reason":"winter-hooks-wiring-test-forced-unsafe"}' },
      { type: "done", stopReason: "end_turn" },
    ]], []);
    const daemon: RunningDaemon = await startDaemon({
      home, secrets: new FileSecretStore(join(home, "test-secrets")),
      agentProvider: { provider: reviewProvider, model: "fake-1" },
    });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    const client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");

    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-hooks-wiring-cwd-")));
    const target = join(cwd, "target.txt");
    writeFileSync(target, "before"); // the p5checkpoint double reads this before writing
    const { sessionId: sid } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/p5checkpoint", cwd, approvalPolicy: "auto",
    });
    await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId: sid, text: `write to this exact path:\n${target}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sid, 40_000);
    await Bun.sleep(50);

    const bashResult = daemon.sessions.read(sid).find(
      (e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-bash",
    ) as { isError: boolean; output: string } | undefined;
    expect(bashResult).toBeDefined();
    // The reviewer's own reason, not the command's stdout — only reachable if daemon.ts's
    // constructed BashReviewer (over the FakeProvider injected as `agentProvider`) actually ran.
    expect(bashResult!.isError).toBe(true);
    expect(bashResult!.output).toContain("winter-hooks-wiring-test-forced-unsafe");
    expect(reviewProvider.requests.length).toBeGreaterThan(0);

    client.close();
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(join(home, ".."), { recursive: true, force: true });
  }, 60_000);
});
