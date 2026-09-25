// WS-23 (ruling R2), end to end: a session the retired official `claude` leg created — a
// `claude-agent` runtime record, the `claude` binary's own transcript — resumes on the Winter runtime
// through the REAL daemon and the REAL `winter` child, and the model is sent the history claude wrote.
//
// The bed is planted exactly as an upgrading home would hold it, BEFORE the daemon boots: the session
// row, a `claude-agent` record keyed by the session's cwd, and a two-entry transcript in claude's own
// entry shapes (`message.model` on the assistant entry) under the shared runtime home. The only
// network the child reaches is an Anthropic loopback fake (`settings.providers.anthropic.baseUrl`),
// whose recorded request body is the proof that the prior turns were carried.
//
// `session-driver.test.ts`'s own WS-23 block pins the adoption's record rewrite, the re-key and every
// typed refusal against a fake child; this file is the one proof that the Winter runtime itself reads
// what claude wrote.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import { anthropicFake, startFake, type FakeServer } from "@yanlinglabs/winter-provider-conformance";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { storeProjectsDir } from "../../src/agent/paths";
import { openRuntimeStateDb, RuntimeSessionRecords } from "../../src/runtime-state";
import { SessionStore } from "../../src/sessions/store";
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
  async call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    const r = await new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve) => this.pending.set(id, resolve));
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async waitFor(pred: (e: SessionEvent) => boolean, ms = 45_000): Promise<SessionEvent> {
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

const MODEL = "anthropic/claude-sonnet-5";
const PRIOR_USER = "remember the word PAPAYA";
const PRIOR_ASSISTANT = "Noted: PAPAYA.";

describeWithWinterBinary("WS-23: a legacy claude-agent session resumes on the Winter runtime with claude's history", (winterBin) => {
  let home: string;
  let cwd: string;
  let sessionId: string;
  let backendId: string;
  let fake: FakeServer;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ws23-adopt-")));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws23-adopt-cwd-")));
    fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => (recorded.path === "/v1/messages" && recorded.method === "POST"
          ? anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["PAPAYA"] }], stopReason: "end_turn" })
          : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
      }],
    });
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: MODEL },
      providers: { anthropic: { baseUrl: fake.url } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 60 },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-ant-test-ws23-adopt" });

    // ── the upgrading home, planted before boot ──────────────────────────────────────────────
    const store = new SessionStore(home);
    sessionId = store.createSession("e2e", { mode: "code", model: MODEL, cwd });
    store.close();
    backendId = crypto.randomUUID();
    const key = transcriptProjectKey(cwd);
    const projects = storeProjectsDir(home);
    mkdirSync(join(projects, key), { recursive: true });
    writeFileSync(join(projects, key, `${backendId}.jsonl`), [
      { type: "user", uuid: "u-claude-1", parentUuid: null, sessionId: backendId, cwd, version: "2.1.250", timestamp: "2026-09-20T10:00:00.000Z", message: { role: "user", content: PRIOR_USER } },
      { type: "assistant", uuid: "a-claude-1", parentUuid: "u-claude-1", sessionId: backendId, cwd, version: "2.1.250", timestamp: "2026-09-20T10:00:01.000Z", message: { id: "msg_legacy_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: PRIOR_ASSISTANT }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const rs = openRuntimeStateDb(home);
    try {
      const records = new RuntimeSessionRecords(rs);
      records.create({
        winterSessionId: sessionId, runtimeKind: "claude-agent", backendSessionId: backendId,
        providerId: "anthropic", modelRef: MODEL, authRef: "keychain:anthropic:default",
        backendRoot: join(projects, key), effectiveTempDir: home,
        transcriptProjectKey: key, memoryProjectKey: key, tempProjectKey: key,
        transcriptDialect: "claude-code-jsonl", transcriptHealth: "clean", compatibilityLevel: "agent-state",
        conformanceCorpusVersion: "unverified", versionProvenance: "recorded", sdkVersion: "0.3.250", engineVersion: "0.3.250",
        providerCatalogVersion: "t", providerAdapterVersion: "unstated", capabilities: ["message", "resume"],
        selection: { runtimeKind: "claude-agent", providerId: "anthropic", modelRef: MODEL, family: "claude", authFamily: "api-key", sdkVersion: "0.3.250", reason: "D13-2", decidedAt: "2026-09-20T10:00:00.000Z" },
      });
      records.transition(sessionId, "ready");
    } finally { rs.close(); }

    daemon = await startDaemon({ home, secrets, agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token: daemon.tokens.harness, clientName: "e2e" });
  });

  afterAll(async () => {
    client?.close();
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await fake?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("the next turn runs on the Winter runtime, and the model is sent the turns claude wrote", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    expect(d.winter.legOf(sessionId)).toBe("official");

    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await client.call(METHODS.sessionSend, { sessionId, text: "which word did I ask you to remember?" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId);

    // The record now names the Winter leg, on the SAME backend transcript.
    const record = d.runtimeState.records.get(sessionId)!;
    expect(record.runtimeKind).toBe("winter-agent");
    expect(record.selection.runtimeKind).toBe("winter-agent");
    expect(record.backendSessionId).toBe(backendId);
    expect(d.winter.legOf(sessionId)).toBe("winter");

    // The history reached the model: the request body carries claude's two entries, in order, before
    // the new question.
    const bodies = fake.requests.filter((r) => r.path === "/v1/messages").map((r) => r.body);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.at(-1)!;
    const at = (needle: string): number => body.indexOf(needle);
    expect(at(PRIOR_USER)).toBeGreaterThan(-1);
    expect(at(PRIOR_ASSISTANT)).toBeGreaterThan(at(PRIOR_USER));
    expect(at("which word did I ask you to remember?")).toBeGreaterThan(at(PRIOR_ASSISTANT));
  }, 90_000);
});
