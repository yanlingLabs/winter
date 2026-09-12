// Winter Phase 8c fix wave — M5 (whole-branch review): the projector's `tool_result` events must
// carry `fileDiff` for a real, mutating Write, and `diff-attach.ts`'s pending map must be cleared
// on session teardown. `hooks.test.ts`/`hooks-integration.e2e.test.ts` (the hooks lane's own tests,
// out of this fix wave's file scope) called `takeFileDiff` THEMSELVES to observe the hooks lane's
// PostToolUse producer — vacuous proof that the wiring in `runtime-sdk/hooks.ts`'s doc comment
// promises ("the projector's `takeFileDiff` consumes it") ever actually runs, since nothing but
// those tests ever called it. This file is the real proof: a REAL spawned `dist/winter` child, a
// REAL daemon (`startDaemon`), a REAL Write tool call, and the assertion is on the PERSISTED
// session log the projector itself wrote — never a direct call to `takeFileDiff`/`attachFileDiff`.
//
// The `p5checkpoint` winter-test double (`winter-code-e2e.test.ts`'s own fixture, reused verbatim
// here) reads a given path, then Writes "AFTER\n" to it, then Bash-redirects into "<path>.bash" —
// callId `p5-ckpt-write` names its Write step. A plain in-root, non-`.winter` target keeps every
// step silent under `auto` (no approval card), exactly as `winter-code-e2e.test.ts`'s own memory-dir
// case (m) proves for the same double.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { readStoredDiff } from "../../src/diffs/store";
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

describeWithWinterBinary("tool_result.fileDiff — the projector's REAL wiring (M5)", (bin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-filediff-e2e-")));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: "winter-test/p5checkpoint", baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: { winterExecutable: bin, winterLeg: { code: true }, winterIdleTimeoutSec: 10 },
    }, null, 2));
    daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    rmSync(home, { recursive: true, force: true });
  });

  test("a real Write through dist/winter yields a persisted tool_result with fileDiff", async () => {
    const d = daemon!;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-filediff-e2e-cwd-")));
    const target = join(cwd, "note.txt");
    writeFileSync(target, "BEFORE\n"); // the double Reads before it Writes (read-ladder)

    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/p5checkpoint", cwd, approvalPolicy: "auto",
    });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: `write to this exact path:\n${target}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 40_000);
    await Bun.sleep(50);

    const log = d.sessions.read(sessionId);
    // A plain in-root, non-`.winter` path: every step (Read, Write, the bash redirect into
    // `<target>.bash`) lands silently under `auto` — no card, exactly `winter-code-e2e.test.ts`'s
    // own case (m).
    expect(log.filter((e) => e.type === "approval_requested")).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("AFTER\n");

    const writeRes = log.find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as
      | { isError: boolean; output: string; fileDiff?: { path: string; added: number; removed: number; diffId: string } }
      | undefined;
    expect(writeRes).toBeDefined();
    expect(writeRes!.isError).toBe(false);

    // THE proof (M5): the hooks lane's PostToolUse producer attached a diff, and the PROJECTOR
    // itself — not this test — took it and stamped it onto the PERSISTED tool_result event.
    expect(writeRes!.fileDiff).toBeDefined();
    expect(writeRes!.fileDiff!.path).toBe(target);
    expect(writeRes!.fileDiff!.added).toBeGreaterThan(0);

    const stored = await readStoredDiff(home, sessionId, writeRes!.fileDiff!.diffId);
    expect(stored?.patch).toContain("+AFTER");
    expect(stored?.patch).toContain("-BEFORE");

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("a replayed tool_result never re-attaches a diff (destructive take) — session.history still carries the ONE it got", async () => {
    const d = daemon!;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-filediff-e2e-cwd2-")));
    const target = join(cwd, "note2.txt");
    writeFileSync(target, "BEFORE\n");

    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/p5checkpoint", cwd, approvalPolicy: "auto",
    });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: `write to this exact path:\n${target}` });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 40_000);
    await Bun.sleep(50);

    // Reading the log twice must never duplicate or re-mint the fileDiff — the store read is pure
    // replay of what was persisted once; nothing re-invokes `takeFileDiff`.
    const first = d.sessions.read(sessionId).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as { fileDiff?: { diffId: string } } | undefined;
    const second = d.sessions.read(sessionId).find((e) => e.type === "tool_result" && (e as { callId: string }).callId === "p5-ckpt-write") as { fileDiff?: { diffId: string } } | undefined;
    expect(first?.fileDiff?.diffId).toBeDefined();
    expect(second?.fileDiff?.diffId).toBe(first!.fileDiff!.diffId);

    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);
});
