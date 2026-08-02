import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startDaemon, type RunningDaemon, CORE_VERSION } from "../src/daemon";
import { startIpcServer } from "../src/ipc/server";
import { SessionStore } from "../src/sessions/store";
import { FileSecretStore } from "../src/auth/secret-store";
import { TokenAuthority } from "../src/auth/tokens";
import { PluginStore } from "../src/agent/plugins";
import { ToolRegistry } from "../src/agent/tools/registry";
import { ApprovalBroker } from "../src/agent/approvals";
import { PermissionRules } from "../src/agent/permission-rules";
import { PluginSupervisor } from "../src/plugins/supervisor";
import { PluginContribRegistry } from "../src/plugins/contrib";
import type { Provider, ProviderEvent } from "../src/providers/types";
import { OPENAI_API_KEY_SECRET } from "../src/providers/manager";
import { setup as setupAgentEngine } from "./agent/engine-spawn.test";
import { TrustStore } from "../src/agent/trust";
import { WorkflowRuntime } from "../src/workflows/runtime";
import { WorkflowStore } from "../src/workflows/store";

/** Minimal raw test client speaking NDJSON JSON-RPC. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  readonly notifications: any[] = [];
  readonly errors: any[] = [];
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            } else if (msg.id === null && msg.error) {
              c.errors.push(msg);
            } else if (msg.method) {
              c.notifications.push(msg);
            }
          }
        },
        drain(_s) {
          c.writer.onDrain();
        },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }

  async waitForNotification(predicate: (n: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.notifications.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for notification");
  }
}

describe("daemon IPC", () => {
  let daemon: RunningDaemon;
  let harnessToken: string;
  // SP-approvals T10: captured so the web_fetch dangerous-domain full-loop test can read
  // settings.json directly (proving the REAL daemon's approval.respond handler persisted the rule
  // to disk) without RunningDaemon itself needing to expose its home directory.
  let daemonHome: string;

  async function boot(
    serverOpts: { helloTimeoutMs?: number; maxConnections?: number } = {},
    provider?: Provider,
    // Pre-seed settings.json (e.g. `{ reviewer: { enabled: false } }`) before the daemon reads
    // it — used by tests that exercise the "auto"-policy bash path with a scripted FakeProvider,
    // where the (default-on) safety reviewer would otherwise consume the same provider's
    // single-track script queue meant for the turn itself. Reviewer *behavior* has its own
    // dedicated coverage in test/agent/engine-reviewer.test.ts.
    settingsOverride?: Record<string, unknown>,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    daemonHome = home;
    if (settingsOverride) {
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "codex-oauth", model: "gpt-5.4" },
        ...settingsOverride,
      }));
    }
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({
      home, secrets, server: serverOpts,
      agentProvider: provider ? { provider, model: "fake-1" } : null,
    });
    harnessToken = daemon.tokens.harness;
  }

  afterEach(() => daemon?.stop());

  // Phase 4b Task 2: a self-contained bare IPC server (own SessionStore + TokenAuthority, no
  // AgentEngine/etc) for plugin-role tests that only need store+tokens — RunningDaemon doesn't
  // expose its SessionStore, so the shared boot()/daemon fixture can't mint plugin tokens.
  async function bootPluginTestServer(): Promise<{
    store: SessionStore; socketPath: string; harnessToken: string; adminToken: string; stop: () => void;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-role-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    return {
      store, socketPath, harnessToken: tokens.harness, adminToken: tokens.admin,
      stop: () => { server.stop(); store.close(); },
    };
  }

  test("methods before hello are rejected with UNAUTHORIZED", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.sessionCreate, { scope: "global" });
    expect(res.error.code).toBe(-32001);
    c.close();
  });

  test("hello with bad token rejected; with good token accepted", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    expect((await c.hello("nope", "bad")).error.code).toBe(-32001);
    const ok = await c.hello(harnessToken, "good");
    expect(ok.result.ok).toBe(true);
    expect(ok.result.protocolVersion).toBe(PROTOCOL_VERSION);
    c.close();
  });

  // Phase 4b Task 2: this test used to pin "fails closed by ABSENCE" (no plugin verification path
  // existed at all — TokenAuthority.verify had no "plugin" entry). Now that SessionStore.
  // mintPluginToken/verifyPluginToken exist, it flips to "fails closed by VERIFICATION" — every
  // rejection path is deliberate (missing pluginId, never-minted id, wrong token), and a real
  // minted token now succeeds. Kept as one test so the before/after contrast stays legible.
  test("plugin-role hello: rejected with no pluginId / unknown id / wrong token; succeeds once a token is minted for that id", async () => {
    const srv = await bootPluginTestServer();

    const noId = await TestClient.connect(srv.socketPath);
    const noIdRes = await noId.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "anything", clientName: "sample-echo",
    });
    expect(noIdRes.error.code).toBe(ERR.UNAUTHORIZED);
    noId.close();

    const unknownId = await TestClient.connect(srv.socketPath);
    const unknownIdRes = await unknownId.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "anything", clientName: "sample-echo", pluginId: "sample-echo",
    });
    expect(unknownIdRes.error.code).toBe(ERR.UNAUTHORIZED);
    unknownId.close();

    const raw = srv.store.mintPluginToken("sample-echo");

    const wrongToken = await TestClient.connect(srv.socketPath);
    const wrongTokenRes = await wrongToken.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: "0".repeat(64), clientName: "sample-echo", pluginId: "sample-echo",
    });
    expect(wrongTokenRes.error.code).toBe(ERR.UNAUTHORIZED);
    wrongToken.close();

    const c = await TestClient.connect(srv.socketPath);
    const res = await c.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
    });
    expect(res.result.ok).toBe(true);

    // Confirm the plugin connection is tagged role "plugin" (not "harness"): it never joined the
    // harness broadcast set, so a harness-created session_created event must not reach it (mirrors
    // the "G2" bad-harness-token assertion above).
    const harness = await TestClient.connect(srv.socketPath);
    await harness.hello(srv.harnessToken, "control-harness");
    await harness.request(METHODS.sessionCreate, { scope: "global" });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.notifications).toHaveLength(0);

    c.close(); harness.close(); srv.stop();
  });

  test("hello with wrong protocolVersion rejected with VERSION_MISMATCH", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.hello, {
      protocolVersion: 999, role: "harness", token: harnessToken, clientName: "future",
    });
    expect(res.error.code).toBe(-32002);
    c.close();
  });

  test("DONE GATE: two authenticated clients attach to one session and see each other's events", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    await b.hello(harnessToken, "client-b");

    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });
    await a.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await b.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    // a sees b's attachment
    await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "harness_attached" && n.params.clientName === "client-b");

    // b sends; a receives the user_message
    await b.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "hello from b" });
    const got = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message");
    expect(got.params.text).toBe("hello from b");
    expect(got.params.clientName).toBe("client-b");

    // b detaches; a sees it
    b.close();
    await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "harness_detached" && n.params.clientName === "client-b");
    a.close();
  });

  test("G2: session_created broadcasts to every authed harness (spec §4.4), even one attached to nothing", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    await b.hello(harnessToken, "client-b"); // b never attaches to anything

    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });

    // b, attached to nothing, still learns about the brand-new session (this is the live-gate bug:
    // previously only attachments received session_created, and a new session has none yet).
    const seenByB = await b.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "session_created" && n.params.sessionId === created.sessionId);
    expect(seenByB.params.scope).toBe("global");

    // a (the creator) gets it too — clients dedupe on sessionId/seq.
    const seenByA = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "session_created" && n.params.sessionId === created.sessionId);
    expect(seenByA.params.scope).toBe("global");

    a.close(); b.close();
  });

  test("G2: a harness whose hello failed never joins the broadcast set — receives no session_created", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const bad = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "client-a");
    const failed = await bad.hello("nope-bad-token", "never-authed");
    expect(failed.error.code).toBe(ERR.UNAUTHORIZED);

    await a.request(METHODS.sessionCreate, { scope: "global" });

    // Give the (nonexistent) delivery a beat, then confirm nothing arrived on the unauthed socket.
    await new Promise((r) => setTimeout(r, 100));
    expect(bad.notifications).toHaveLength(0);

    a.close(); bad.close();
  });

  test("attach to nonexistent session → NOT_FOUND; send without attach → NOT_FOUND", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "lost");
    const attach = await c.request(METHODS.sessionAttach, { sessionId: "s_nope", fromSeq: 0 });
    expect(attach.error.code).toBe(-32004);
    const send = await c.request(METHODS.sessionSend, { sessionId: "s_nope", text: "x" });
    expect(send.error.code).toBe(-32004);
    c.close();
  });

  test("session.list returns the index shape", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "lister");
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    const { result } = await c.request(METHODS.sessionList);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: created.result.sessionId, scope: "global", lastSeq: 1 });
    expect(result.sessions[0].createdAt).toBeGreaterThan(0);
    c.close();
  });

  // Phase 5 routines T3 (design doc §3): session.create's additive `origin` param round-trips
  // through session.list; a session created without one still lists fine (origin undefined).
  test("session.create origin round-trips through session.list; omitted origin is undefined", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "origin-lister");
    const withOrigin = await c.request(METHODS.sessionCreate, { scope: "routine", origin: "routine/abc123" });
    const plain = await c.request(METHODS.sessionCreate, { scope: "global" });
    const { result } = await c.request(METHODS.sessionList);
    const rowWith = result.sessions.find((s: any) => s.sessionId === withOrigin.result.sessionId);
    const rowPlain = result.sessions.find((s: any) => s.sessionId === plain.result.sessionId);
    expect(rowWith.origin).toBe("routine/abc123");
    expect(rowPlain.origin).toBeUndefined();
    c.close();
  });

  // session-activity-hygiene T2 (spec §1): `session.list` surfaces the derived activity state.
  // The derivation itself is exhaustively tested in test/sessions/activity.test.ts — what these
  // two cover is the WIRING: that the handler actually builds signals and stamps the field, and
  // that the "absent = none" half survives the trip (a chat row must carry no `activity` at all,
  // not `"idle"`).
  test("session.list stamps activity: a fresh code session is idle, chat carries none", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "activity-lister");
    const code = await c.request(METHODS.sessionCreate, { scope: "global" });
    const chat = await c.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    const { result } = await c.request(METHODS.sessionList);
    const codeRow = result.sessions.find((s: any) => s.sessionId === code.result.sessionId);
    const chatRow = result.sessions.find((s: any) => s.sessionId === chat.result.sessionId);
    // Nothing attached (this client never called session.attach), nothing running.
    expect(codeRow.activity).toBe("idle");
    expect(chatRow.activity).toBeUndefined();
    c.close();
  });

  test("session.list reports an attached code session as active", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "activity-attacher");
    const created = await c.request(METHODS.sessionCreate, { scope: "global" });
    await c.request(METHODS.sessionAttach, { sessionId: created.result.sessionId });
    const { result } = await c.request(METHODS.sessionList);
    expect(result.sessions.find((s: any) => s.sessionId === created.result.sessionId).activity).toBe("active");
    c.close();
  });

  test("bad params yield INVALID_PARAMS (-32602) with sanitized message", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "zod");
    const res = await c.request(METHODS.sessionCreate, { scope: "UPPER NOT VALID" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("invalid params");
    expect(res.error.message).not.toContain("regex"); // no internal zod dump
    c.close();
  });

  test("second hello on an authed connection is rejected with INVALID_REQUEST", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "once");
    const again = await c.hello(harnessToken, "twice");
    expect(again.error.code).toBe(-32600);
    // original auth still works:
    const list = await c.request(METHODS.sessionList);
    expect(list.result.sessions).toEqual([]);
    c.close();
  });

  test("malformed hello params yield INVALID_PARAMS", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    const res = await c.request(METHODS.hello, { protocolVersion: "nope", role: "harness", token: "t", clientName: "x" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("protocolVersion");
    c.close();
  });

  test("malformed JSON line gets an id:null error frame that our own schema accepts", async () => {
    await boot();
    const { RpcResponse } = await import("@norma/protocol");
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "garbler");
    (c as any).socket.write(new TextEncoder().encode("THIS IS NOT JSON\n"));
    await new Promise((r) => setTimeout(r, 50));
    const frame = c.errors[0];
    expect(frame).toBeTruthy();
    expect(frame.id).toBeNull();
    expect(() => RpcResponse.parse(frame)).not.toThrow();
    expect(frame.error.code).toBe(-32700);
    c.close();
  });

  test("pre-hello oversized line disconnects the client", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    // >64KiB without a newline, in 8KB writes (Bun caps a single write at 8192 bytes)
    const chunk = new TextEncoder().encode("x".repeat(8_000));
    for (let i = 0; i < 9; i++) {
      (c as any).socket.write(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 100));
    const hello = c.hello(harnessToken, "late");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    c.close();
  });

  test("no hello within the deadline disconnects the client", async () => {
    await boot({ helloTimeoutMs: 100 });
    const c = await TestClient.connect(daemon.socketPath);
    await new Promise((r) => setTimeout(r, 200));
    const hello = c.hello(harnessToken, "tooslow");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    c.close();
  });

  test("connection cap rejects the N+1th connection", async () => {
    await boot({ maxConnections: 2 });
    const c1 = await TestClient.connect(daemon.socketPath);
    const c2 = await TestClient.connect(daemon.socketPath);
    const c3 = await TestClient.connect(daemon.socketPath);
    await new Promise((r) => setTimeout(r, 50));
    const hello = c3.hello(harnessToken, "overflow");
    const result = await Promise.race([hello, new Promise((r) => setTimeout(() => r("dead"), 300))]);
    expect(result).toBe("dead");
    [c1, c2, c3].forEach((c) => c.close());
  });

  test("a >8KB frame is delivered intact (ConnWriter drain path)", async () => {
    await boot();
    const a = await TestClient.connect(daemon.socketPath);
    const b = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "big-a");
    await b.hello(harnessToken, "big-b");
    const { result: created } = await a.request(METHODS.sessionCreate, { scope: "global" });
    await a.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await b.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const big = "x".repeat(20_000);
    await b.request(METHODS.sessionSend, { sessionId: created.sessionId, text: big });
    const got = await a.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message");
    expect(got.params.text).toHaveLength(20_000);
    expect(got.params.text).toBe(big);
    a.close(); b.close();
  });

  test("user_message triggers an agent turn; events broadcast to attached harnesses", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([[
      { type: "text_delta", delta: "agent says hi" },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "asker");
    const cwd = mkdtempSync(join(tmpdir(), "norma-turn-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "hello?" });
    const msg = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "assistant_message");
    expect(msg.params.text).toBe("agent says hi");
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("approval.respond resolves a pending approval (first-wins over the wire)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    // SP-policies Task 7: an in-root write under `ask` is SILENT now (in-project-silent flip), so it
    // would raise no card to respond to. Target an OUT-OF-ROOT path instead — that still raises a
    // (grant-flavored) approval card, and approving it lands the write, so the approval round-trip
    // this test checks (card → approval.respond → resolved → effect observable on disk) is unchanged.
    const outside = mkdtempSync(join(tmpdir(), "norma-approve-oor-"));
    const target = join(outside, "f.txt");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target, content: "x" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "approver");
    const cwd = mkdtempSync(join(tmpdir(), "norma-approve-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write f" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");
    const res = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(readFileSync(target, "utf8")).toBe("x");
    c.close();
  });

  // SP-approvals Task 5: a rule-bearing optionId on approval.respond persists a CC-grammar
  // permission rule to the SESSION-CWD project file (Task 1's PermissionRules, written via
  // engine.ts's approvalOptionsFor + this handler's append) — this is the feature's whole point:
  // card → "always allow" → rule written → the NEXT identical call runs silently (proven by
  // permission-gate-order.test.ts's scenario 1, driven from the OTHER side of the same rule file).
  test("approval.respond with a rule-bearing optionId persists the rule to the session-cwd project file, then resolves", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push origin main" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "rule-approver");
    const cwd = mkdtempSync(join(tmpdir(), "norma-approve-rule-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "push" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");
    expect(ask.params.options).toEqual([
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" },
      { id: "allow_global", label: 'Allow "Bash(git push:*)" everywhere', rule: "Bash(git push:*)", scope: "global" },
      { id: "deny", label: "Deny" },
    ]);

    const res = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true, optionId: "allow_project" });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");

    expect(JSON.parse(readFileSync(join(cwd, ".norma", "permissions.local.json"), "utf8"))).toEqual({ allow: ["Bash(git push:*)"] });
    c.close();
  });

  test("approval.respond with a rule-bearing optionId but approved:false does NOT persist any rule", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push origin main" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "rule-denier");
    const cwd = mkdtempSync(join(tmpdir(), "norma-deny-rule-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "push" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");

    const res = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: false, optionId: "allow_project" });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");

    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false);
    c.close();
  });

  test("approval.respond with an unrecognized optionId resolves normally, persists no rule, and logs a warning once", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push origin main" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "rule-unknown-option");
    const cwd = mkdtempSync(join(tmpdir(), "norma-unknown-rule-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "push" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true, optionId: "not-a-real-option" });
      expect(res.result).toEqual({ ok: true, alreadyResolved: false });
      expect(errSpy).toHaveBeenCalled();
      expect(errSpy.mock.calls.some((call) => String(call[0]).includes("unknown optionId"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");

    expect(existsSync(join(cwd, ".norma", "permissions.local.json"))).toBe(false);
    c.close();
  });

  // Remote Gateway parity: the phone answers approvals through role:"remote" (REMOTE_ALLOWED_METHODS
  // already carries approval.respond) — an optionId-bearing respond from that role must persist a
  // rule exactly like a harness caller's, since the server-side handler doesn't special-case role.
  test("a remote-role connection's approval.respond with optionId persists the rule same as a harness caller (the phone path)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push origin main" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "phone-rule-driver");
    const cwd = mkdtempSync(join(tmpdir(), "norma-remote-rule-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "push" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");

    const remote = await TestClient.connect(daemon.socketPath);
    await remote.hello(daemon.tokens.remote, "phone", "remote");
    const res = await remote.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true, optionId: "allow_project" });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");

    expect(JSON.parse(readFileSync(join(cwd, ".norma", "permissions.local.json"), "utf8"))).toEqual({ allow: ["Bash(git push:*)"] });
    c.close(); remote.close();
  });

  // T4's broker->list() options passthrough, end to end over the wire (T4 itself only proved this
  // at the ApprovalBroker unit level) — a phone that reconnects and calls approval.list mid-card
  // must see the SAME options the approval_requested event it possibly missed would have carried.
  test("approval.list surfaces the SAME options the approval_requested event carried (T4 passthrough, end to end)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command: "git push origin main" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "list-options-driver");
    const cwd = mkdtempSync(join(tmpdir(), "norma-list-options-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "push" });
    const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");

    const listed = await c.request(METHODS.approvalList, { sessionId: created.sessionId });
    expect(listed.result.pending).toHaveLength(1);
    expect(listed.result.pending[0].options).toEqual(ask.params.options);
    expect(ask.params.options?.[0]).toEqual({ id: "allow_once", label: "Allow once" }); // sanity: really the bash set, not an empty passthrough

    await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  // SP-approvals Task 10 (spec §7): the "Always allow from this source" web_fetch option, over the
  // REAL wire, end to end — card shape, the REAL approval.respond handler persisting a
  // WebFetch(domain:...) rule to the daemon's OWN settings.json (global scope), and the REAL
  // daemon's live settings-watcher (settings-watcher.ts, 150ms debounce) picking it up so the NEXT
  // fetch to the same domain AND a subdomain both run cardless. `globalThis.fetch` is monkey-patched
  // for the duration (save/restore) so web_fetch never hits the real network — same technique as
  // providers/openai-compatible.test.ts's own "consumer break mid-stream" test.
  test("SP-approvals T10 full loop: dangerous web_fetch -> card -> respond allow_source -> rule persists globally -> next fetch to the same domain AND a subdomain run cardless", async () => {
    const origFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response("hi", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      const { FakeProvider } = await import("../src/agent/fake-provider");
      const fake = new FakeProvider([
        [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url: "https://uploads.transfer.sh/file1" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "done-1" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "tool_call", callId: "c2", name: "web_fetch", argsJson: JSON.stringify({ url: "https://transfer.sh/file2" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "done-2" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "tool_call", callId: "c3", name: "web_fetch", argsJson: JSON.stringify({ url: "https://another.transfer.sh/file3" }) }, { type: "done", stopReason: "tool_calls" }],
        [{ type: "text_delta", delta: "done-3" }, { type: "done", stopReason: "end_turn" }],
      ]);
      // toolSearch disabled: web_fetch is a `deferred: true` built-in (ToolSearch deferral is
      // default-ON in a real daemon boot, unlike setupEngine's test harness) — this test isn't
      // about ToolSearch, so it's turned off to call web_fetch directly, same idiom the
      // reviewer-disabling tests above use for their own out-of-scope machinery. titles disabled
      // too: SessionTitler.maybeTitle fires fire-and-forget on the session's first message against
      // this SAME FakeProvider instance (settings-hot-e2e.test.ts's writeSettingsFile doc comment
      // — "races the turn's own call for the SAME script queue"), which would otherwise silently
      // steal one of this test's carefully-ordered script entries.
      await boot({}, fake, { toolSearch: { enabled: false }, titles: { enabled: false } });
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "web-fetch-rule-driver");
      const cwd = mkdtempSync(join(tmpdir(), "norma-webfetch-rule-"));
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "ask" });
      await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

      // Turn 1: a SUBDOMAIN of the shipped "transfer.sh" entry -> card. MEDIUM-1 (SP-approvals T10
      // review): a subdomain hit's label reads "Always allow all of <matched-entry>", honestly
      // communicating that approving grants the whole family, not just this one subdomain.
      await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "fetch the paste" });
      const ask = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "approval_requested");
      expect(ask.params.options).toEqual([
        { id: "allow_once", label: "Allow" },
        { id: "allow_source", label: "Always allow all of transfer.sh", rule: "WebFetch(domain:transfer.sh)", scope: "global" },
        { id: "deny", label: "Deny" },
      ]);

      const respond = await c.request(METHODS.approvalRespond, {
        sessionId: created.sessionId, callId: ask.params.callId, approved: true, optionId: "allow_source",
      });
      expect(respond.result).toEqual({ ok: true, alreadyResolved: false });
      await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");

      // The REAL ipc/server.ts handler persisted the rule to the daemon's own settings.json, global scope.
      expect(JSON.parse(readFileSync(join(daemonHome, "settings.json"), "utf8")).permissions.allow).toEqual(["WebFetch(domain:transfer.sh)"]);

      // Give the daemon's live SettingsWatcher (150ms debounce) time to hot-reload the rule into
      // its in-memory settings before the next fetch's decision() check reads it — same "settled
      // write" cadence settings-hot-e2e.test.ts's own torn-write test uses (a fixed sleep past a
      // known debounce constant, comfortable headroom rather than a tight race).
      await new Promise((r) => setTimeout(r, 500));

      // Count-based waits (never a first-MATCH wait) — `waitForNotification` would otherwise
      // resolve INSTANTLY against the turn-1 `turn_completed` already sitting in `c.notifications`.
      // Mirrors settings-hot-e2e.test.ts's own `completedTurns()`/`driveTurn()` idiom.
      const turnCompletedCount = () => c.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length;
      const approvalRequestedCount = () => c.notifications.filter((n) => n.method === METHODS.event && n.params.type === "approval_requested").length;
      const waitForNextTurnCompleted = async (before: number): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (turnCompletedCount() <= before) {
          if (Date.now() > deadline) throw new Error("timed out waiting for the next turn_completed");
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      const approvalsAfterTurn1 = approvalRequestedCount();
      const completedAfterTurn1 = turnCompletedCount();

      // Turn 2: the BARE matched entry itself -> must run cardless.
      await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "fetch it again" });
      await waitForNextTurnCompleted(completedAfterTurn1);
      expect(approvalRequestedCount()).toBe(approvalsAfterTurn1);
      const completedAfterTurn2 = turnCompletedCount();

      // Turn 3: a DIFFERENT subdomain -> must ALSO run cardless.
      await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "fetch a related paste" });
      await waitForNextTurnCompleted(completedAfterTurn2);
      expect(approvalRequestedCount()).toBe(approvalsAfterTurn1);

      expect(fetchedUrls).toEqual(["https://uploads.transfer.sh/file1", "https://transfer.sh/file2", "https://another.transfer.sh/file3"]);
      c.close();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Edge case called out explicitly by the brief: a rule-bearing optionId with NO usable project
  // root (a null session cwd) must never hang or crash the respond — PermissionRules.append()
  // throws RuleAppendError for scope "project" with no root, and the handler's try/catch must
  // swallow it (log + still resolve). Unreachable through a REAL engine turn (a null-cwd session's
  // turn() bails before any tool call — engine.ts's `if (!meta.cwd)` guard — so no approval_requested
  // with options ever fires for one in practice); exercised here at the bare-server level instead,
  // fabricating the pending entry directly against the broker to drive the server-side code path in
  // isolation, same "own SessionStore + TokenAuthority, no AgentEngine" shape as
  // remote-role.test.ts's bootPluginTestServer sibling below.
  test("approval.respond: a rule-bearing optionId with no session cwd — RuleAppendError is caught, logged, and the approval still resolves", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-approve-nocwd-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const broker = new ApprovalBroker();
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, normaHome: home });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, broker, permissionRules });
    try {
      const sessionId = store.createSession("global", { approvalPolicy: "ask" }); // no cwd at all
      const options = [{ id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" as const }];
      void broker.wait(sessionId, "c1", 5000, { toolName: "bash", summary: "git push", issuedAt: Date.now(), expiresAt: Date.now() + 5000, options });

      const c = await TestClient.connect(socketPath);
      await c.hello(tokens.harness, "nocwd-approver");
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await c.request(METHODS.approvalRespond, { sessionId, callId: "c1", approved: true, optionId: "allow_project" });
        expect(res.result).toEqual({ ok: true, alreadyResolved: false });
        expect(errSpy).toHaveBeenCalled();
        expect(errSpy.mock.calls.some((call) => String(call[0]).includes("failed to persist permission rule"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
      c.close();
    } finally {
      server.stop();
      store.close();
    }
  });

  test("ask_user.respond round-trip + alreadyResolved; task.list snapshot", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify({
        questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }], multiSelect: false }],
      }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t1", name: "task_create", argsJson: JSON.stringify({ subject: "Ship it", description: "Ship the release" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "ask-tasker");
    const cwd = mkdtempSync(join(tmpdir(), "norma-askuser-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "ask, then track a task" });

    const asked = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "question_asked");
    const res1 = await c.request(METHODS.askUserRespond, { sessionId: created.sessionId, callId: asked.params.callId, answers: { "Pick one": "B" } });
    expect(res1.result).toEqual({ ok: true, alreadyResolved: false });
    const res2 = await c.request(METHODS.askUserRespond, { sessionId: created.sessionId, callId: asked.params.callId, answers: { "Pick one": "B" } });
    expect(res2.result).toEqual({ ok: true, alreadyResolved: true });

    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    const list = await c.request(METHODS.taskList, { sessionId: created.sessionId });
    expect(list.result).toEqual({ ok: true, tasks: [{ id: "1", subject: "Ship it", status: "pending" }] });
    c.close();
  });

  // CC AskUserQuestion parity (Task 2): ask_user.respond's optional `notes` param must reach the
  // QuestionBroker (server.ts's handler passes p.notes through) and end up both on the persisted
  // question_resolved event and folded into the model-visible tool_result.
  test("ask_user.respond with notes → question_resolved carries notes + tool result includes the note", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify({
        questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }], multiSelect: false }],
      }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "ask-noter");
    const cwd = mkdtempSync(join(tmpdir(), "norma-askuser-notes-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "ask, then note" });

    const asked = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "question_asked");
    const res1 = await c.request(METHODS.askUserRespond, {
      sessionId: created.sessionId, callId: asked.params.callId,
      answers: { "Pick one": "B" }, notes: { "Pick one": "prefer B for perf" },
    });
    expect(res1.result).toEqual({ ok: true, alreadyResolved: false });

    const resolved = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "question_resolved");
    expect(resolved.params).toMatchObject({ answers: { "Pick one": "B" }, notes: { "Pick one": "prefer B for perf" } });

    const toolResult = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "tool_result" && n.params.callId === "q1");
    expect(toolResult.params.output).toContain('[user note on "Pick one": prefer B for perf]');
    c.close();
  });

  test("plan.respond round-trip + alreadyResolved", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "e1", name: "exit_plan_mode", argsJson: JSON.stringify({ plan: "Step 1: ship it" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "planner");
    const cwd = mkdtempSync(join(tmpdir(), "norma-plan-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "plan" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "make a plan" });

    const presented = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plan_presented");
    const res1 = await c.request(METHODS.planRespond, { sessionId: created.sessionId, callId: presented.params.callId, approved: true, autoAccept: true });
    expect(res1.result).toEqual({ ok: true, alreadyResolved: false });
    const res2 = await c.request(METHODS.planRespond, { sessionId: created.sessionId, callId: presented.params.callId, approved: true, autoAccept: true });
    expect(res2.result).toEqual({ ok: true, alreadyResolved: true });

    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.setPolicy round-trip; NOT_FOUND on an unknown session", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "policy-setter");
    const cwd = mkdtempSync(join(tmpdir(), "norma-setpolicy-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "plan" });
    const setPolicy = await c.request(METHODS.sessionSetPolicy, { sessionId: created.sessionId, policy: "auto" });
    expect(setPolicy.result).toEqual({ ok: true });

    const bad = await c.request(METHODS.sessionSetPolicy, { sessionId: "s_does_not_exist", policy: "auto" });
    expect(bad.error).toBeTruthy();
    expect(bad.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // I1 review fix (Chat Slice D task 1): session.setModel used to validate nothing, so a bad slug
  // (a typo, or a since-deprecated model) succeeded at set time and then silently broke every
  // subsequent turn. Reuses spawn_agent's own `known.length > 0`-guarded idiom (engine.ts) — a
  // real AgentEngine must be wired (`boot({}, fake)`) so `opts.engine?.knownModels()` has a live
  // provider to enumerate.
  describe("session.setModel model validation (I1 review fix)", () => {
    test("rejects an unknown model when the provider CAN enumerate its models, naming the known list", async () => {
      const { FakeProvider } = await import("../src/agent/fake-provider");
      const models = [
        { id: "model-a", family: "fake", contextWindow: 100_000, supportsVision: false },
        { id: "model-b", family: "fake", contextWindow: 100_000, supportsVision: false },
      ];
      await boot({}, new FakeProvider([], models));
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "model-validator");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const res = await c.request(METHODS.sessionSetModel, { sessionId: created.sessionId, model: "nonexistent-model" });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.message).toContain("model-a");
      expect(res.error.message).toContain("model-b");

      // rejected — never stored (the reject path must leave no trace, same precedent as
      // session_spawn's own pre-flight rejections).
      const listed = await c.request(METHODS.sessionList, {});
      const row = listed.result.sessions.find((r: any) => r.sessionId === created.sessionId);
      expect(row.model).toBeUndefined();
      c.close();
    });

    test("accepts a KNOWN model id and stores it", async () => {
      const { FakeProvider } = await import("../src/agent/fake-provider");
      const models = [
        { id: "model-a", family: "fake", contextWindow: 100_000, supportsVision: false },
        { id: "model-b", family: "fake", contextWindow: 100_000, supportsVision: false },
      ];
      await boot({}, new FakeProvider([], models));
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "model-validator");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const res = await c.request(METHODS.sessionSetModel, { sessionId: created.sessionId, model: "model-b" });
      expect(res.error).toBeUndefined();
      expect(res.result).toEqual({});

      const listed = await c.request(METHODS.sessionList, {});
      const row = listed.result.sessions.find((r: any) => r.sessionId === created.sessionId);
      expect(row.model).toBe("model-b");
      c.close();
    });

    test("resolves a short alias against the known list before storing (same idiom as spawn_agent)", async () => {
      const { FakeProvider } = await import("../src/agent/fake-provider");
      const models = [{ id: "gpt-5.6-sol", family: "fake", contextWindow: 100_000, supportsVision: false }];
      await boot({}, new FakeProvider([], models));
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "model-validator");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const res = await c.request(METHODS.sessionSetModel, { sessionId: created.sessionId, model: "sol" });
      expect(res.error).toBeUndefined();

      const listed = await c.request(METHODS.sessionList, {});
      const row = listed.result.sessions.find((r: any) => r.sessionId === created.sessionId);
      expect(row.model).toBe("gpt-5.6-sol"); // canonicalized to the full id, not the raw alias
      c.close();
    });

    test("accepts ANY value when the provider CANNOT enumerate its models (empty models() list) — same fallback as spawn_agent", async () => {
      const { FakeProvider } = await import("../src/agent/fake-provider");
      await boot({}, new FakeProvider([], [])); // empty models() — can't enumerate
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "model-validator");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const res = await c.request(METHODS.sessionSetModel, { sessionId: created.sessionId, model: "anything-goes" });
      expect(res.error).toBeUndefined();

      const listed = await c.request(METHODS.sessionList, {});
      const row = listed.result.sessions.find((r: any) => r.sessionId === created.sessionId);
      expect(row.model).toBe("anything-goes");
      c.close();
    });

    test("without an engine wired at all, validates nothing (no known list to check against) — same as an unenumerable provider", async () => {
      await boot(); // no provider → no engine
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "model-validator-noeng");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const res = await c.request(METHODS.sessionSetModel, { sessionId: created.sessionId, model: "anything-goes" });
      expect(res.error).toBeUndefined();
      c.close();
    });
  });

  test("thread.list without an engine → empty threads", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "threader-noeng");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const noEngine = await c.request(METHODS.threadList, { sessionId: created.sessionId });
    expect(noEngine.result).toEqual({ ok: true, threads: [] });
    c.close();
  });

  test("thread.list with an engine → main thread seeded lazily on first read", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "threader");
    const cwd = mkdtempSync(join(tmpdir(), "norma-threadlist-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    const list = await c.request(METHODS.threadList, { sessionId: created.sessionId });
    expect(list.result).toEqual({ ok: true, threads: [{ threadId: "main", status: "running" }] });
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // child-transcript-view T1: thread.send / agent.stop. Unlike the `boot()`/`startDaemon` fixture
  // above (whose `RunningDaemon` deliberately hides its AgentEngine/BackgroundAgentRegistry), these
  // tests need direct access to both — to hand-register a RUNNING/TERMINAL bg-agent entry (the
  // "if driving that e2e is heavy" allowance the design doc's Testing section calls for, same
  // precedent as engine-resume.test.ts's own `bgAgents.register()`/`.complete()` fixtures) and to
  // inspect the engine's private steer queue after a `thread.send`. `setupAgentEngine` (this
  // file's own `setup()`, exported for engine-resume.test.ts already) builds a real AgentEngine +
  // BackgroundAgentRegistry directly; this helper just wraps a bare IpcServer around that SAME
  // instance, mirroring `bootPluginTestServer`'s "self-contained bare server" shape above.
  // -------------------------------------------------------------------------------------------
  async function bootAgentServer(script: ProviderEvent[][] = []): Promise<
    ReturnType<typeof setupAgentEngine> & { socketPath: string; harnessToken: string; stop: () => void }
  > {
    const s = setupAgentEngine(script);
    const home = mkdtempSync(join(tmpdir(), "norma-thread-send-"));
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store: s.store, hub: s.hub, engine: s.engine });
    return { ...s, socketPath, harnessToken: tokens.harness, stop: () => { server.stop(); s.store.close(); } };
  }

  describe("thread.send / agent.stop (child-transcript-view T1)", () => {
    test("thread.send to a RUNNING child → delivered:queued, text lands in the child's own steer queue", async () => {
      const srv = await bootAgentServer();
      srv.bgAgents.register({ agentId: "ag_worker", sessionId: srv.sessionId, threadId: "th_worker", name: "worker", abort: new AbortController() });

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "sender");
      const res = await c.request(METHODS.threadSend, { sessionId: srv.sessionId, agent: "worker", text: "keep going" });
      expect(res.result).toEqual({ ok: true, delivered: "queued", agentId: "ag_worker" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((srv.engine as any).threadSteerQueue.get("th_worker")).toEqual(["keep going"]);
      c.close();
      srv.stop();
    });

    test("thread.send to a FINISHED child → delivered:resumed, agent transitions running then back to a terminal status", async () => {
      const spawnNamed: ProviderEvent = {
        type: "tool_call", callId: "s1", name: "spawn_agent",
        argsJson: JSON.stringify({ prompt: "do the task", description: "task", name: "worker", run_in_background: false }),
      };
      const done = (reason: "end_turn" | "tool_calls"): ProviderEvent => ({ type: "done", stopReason: reason });
      const text = (t: string): ProviderEvent[] => [{ type: "text_delta", delta: t }, done("end_turn")];

      const srv = await bootAgentServer([
        [spawnNamed, done("tool_calls")], // main round 0: sync spawn (run_in_background:false)
        text("child done"),               // the child's own (sync) round + main's continuation clamp to this
      ]);
      await srv.engine.runTurn(srv.sessionId);
      expect(srv.bgAgents.get("worker", srv.sessionId)?.status).toBe("completed");
      const agentId = srv.bgAgents.get("worker", srv.sessionId)!.agentId;

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "sender");
      const res = await c.request(METHODS.threadSend, { sessionId: srv.sessionId, agent: "worker", text: "one more thing" });
      expect(res.result).toEqual({ ok: true, delivered: "resumed", agentId });
      // reopen() flips it back to running before the detached run kicks off, but the FakeProvider's
      // clamped script resolves near-instantly — poll rather than assert an exact intermediate state.
      for (let i = 0; i < 200 && srv.bgAgents.get("worker", srv.sessionId)?.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(srv.bgAgents.get("worker", srv.sessionId)?.status).toBe("completed");
      c.close();
      srv.stop();
    });

    test("thread.send to an unknown agent → NOT_FOUND RpcFailure", async () => {
      const srv = await bootAgentServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "sender");
      const res = await c.request(METHODS.threadSend, { sessionId: srv.sessionId, agent: "ghost", text: "hi" });
      expect(res.error.code).toBe(ERR.NOT_FOUND);
      expect(res.error.message).toContain("ghost");
      c.close();
      srv.stop();
    });

    test("agent.stop on a RUNNING agent → aborts it and reports status:stopped", async () => {
      const srv = await bootAgentServer();
      const abort = new AbortController();
      srv.bgAgents.register({ agentId: "ag_worker", sessionId: srv.sessionId, threadId: "th_worker", name: "worker", abort });

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "stopper");
      const res = await c.request(METHODS.agentStop, { sessionId: srv.sessionId, agent: "worker" });
      expect(res.result).toEqual({ ok: true, status: "stopped" });
      expect(abort.signal.aborted).toBe(true);
      expect(srv.bgAgents.get("worker", srv.sessionId)?.status).toBe("stopped");
      c.close();
      srv.stop();
    });

    test("agent.stop on an already-FINISHED agent → not an error, reports its current status", async () => {
      const srv = await bootAgentServer();
      srv.bgAgents.register({ agentId: "ag_worker", sessionId: srv.sessionId, threadId: "th_worker", name: "worker", abort: new AbortController() });
      srv.bgAgents.complete("ag_worker", { ok: true, result: "done" });

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "stopper");
      const res = await c.request(METHODS.agentStop, { sessionId: srv.sessionId, agent: "worker" });
      expect(res.result).toEqual({ ok: true, status: "completed" });
      c.close();
      srv.stop();
    });

    test("agent.stop on an unknown agent → NOT_FOUND RpcFailure", async () => {
      const srv = await bootAgentServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "stopper");
      const res = await c.request(METHODS.agentStop, { sessionId: srv.sessionId, agent: "ghost" });
      expect(res.error.code).toBe(ERR.NOT_FOUND);
      expect(res.error.message).toContain("ghost");
      c.close();
      srv.stop();
    });
  });

  // -------------------------------------------------------------------------------------------
  // Workflows (CC-parity phase 3, Track C Task C2): workflow.list/run/stop/get — the RPC surface
  // over WorkflowRuntime (live runs, A3+/B2) + WorkflowStore (saved `.norma/workflows/*.js`
  // scripts, C1). Local-only in v1 (Global Constraints) — deliberately NOT on
  // PLUGIN_ALLOWED_METHODS or REMOTE_ALLOWED_METHODS (see the two role-gate tests at the end of
  // this block + test/ipc/remote-role.test.ts's own "off-list verbs" coverage). A self-contained
  // bare IpcServer (own SessionStore/TrustStore/WorkflowRuntime/WorkflowStore, no AgentEngine) —
  // same shape as bootAgentServer/bootPluginTestServer above. The runtime is built with NO
  // `workerCommand` override — same "the real sandboxed-subprocess default transport is cheap
  // enough for a test" precedent as workflow-bridge.testkit.ts / workflows/runtime.test.ts — and a
  // `spawnAgent` that hangs until its AbortSignal fires, for the one test that needs a run to stay
  // "running" long enough to list/stop; every other script here never calls `agent(...)`.
  // -------------------------------------------------------------------------------------------
  describe("workflow.list/run/stop/get (CC-parity phase 3, Track C Task C2)", () => {
    async function bootWorkflowServer(): Promise<{
      store: SessionStore; trust: TrustStore; workflows: WorkflowRuntime; workflowStore: WorkflowStore;
      socketPath: string; harnessToken: string; remoteToken: string; normaHome: string; stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "norma-workflow-rpc-"));
      const store = new SessionStore(home);
      const trust = new TrustStore(join(home, "trust.json"));
      const workflowStore = new WorkflowStore({ normaHome: home, trust });
      const runsDir = mkdtempSync(join(tmpdir(), "norma-workflow-rpc-runs-"));
      const workflows = new WorkflowRuntime({
        onEvent: () => {},
        spawnAgent: (_sid, _prompt, _opts, signal) =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, result: "stopped" }))),
        runsDir,
      });
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, trust, workflows, workflowStore });
      return {
        store, trust, workflows, workflowStore, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote,
        normaHome: home, stop: () => { server.stop(); store.close(); },
      };
    }

    test("workflow.run with an inline script launches a run; workflow.get polls it through to completion", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const run = await c.request(METHODS.workflowRun, {
        sessionId: created.sessionId,
        script: `export const meta = {name:"t", description:"d"}; return "hello";`,
      });
      expect(run.error).toBeUndefined();
      expect(typeof run.result.runId).toBe("string");
      expect(run.result.status).toBe("running");

      let view: any;
      for (let i = 0; i < 300; i++) {
        const got = await c.request(METHODS.workflowGet, { runId: run.result.runId });
        view = got.result.run;
        if (view.status !== "running") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(view.status).toBe("completed");
      expect(view.result).toBe("hello");
      expect(view.sessionId).toBe(created.sessionId);
      c.close();
      srv.stop();
    });

    test("workflow.get on an unknown runId → NOT_FOUND", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const res = await c.request(METHODS.workflowGet, { runId: "wf_ghost" });
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      c.close();
      srv.stop();
    });

    test("workflow.list reports a session's own running runs and stays scoped per-session", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const { result: other } = await c.request(METHODS.sessionCreate, { scope: "global" });

      const run = await c.request(METHODS.workflowRun, {
        sessionId: created.sessionId,
        script: `await agent("forever"); return "unreachable";`,
      });
      await new Promise((r) => setTimeout(r, 100)); // let the run actually reach its agent() call

      const listMine = await c.request(METHODS.workflowList, { sessionId: created.sessionId });
      expect(listMine.result.running.map((r: any) => r.runId)).toEqual([run.result.runId]);
      expect(listMine.result.running[0].status).toBe("running");

      const listOther = await c.request(METHODS.workflowList, { sessionId: other.sessionId });
      expect(listOther.result.running).toEqual([]);

      await c.request(METHODS.workflowStop, { runId: run.result.runId }); // tidy up the hanging subprocess
      c.close();
      srv.stop();
    });

    test("workflow.stop stops a running run; stopping an unknown or already-stopped runId is a soft no-op (ok:true, stopped:false)", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const run = await c.request(METHODS.workflowRun, {
        sessionId: created.sessionId,
        script: `await agent("forever"); return "unreachable";`,
      });
      await new Promise((r) => setTimeout(r, 100));

      const stop = await c.request(METHODS.workflowStop, { runId: run.result.runId });
      expect(stop.result).toEqual({ ok: true, stopped: true });

      const ghost = await c.request(METHODS.workflowStop, { runId: "wf_ghost" });
      expect(ghost.result).toEqual({ ok: true, stopped: false });

      const again = await c.request(METHODS.workflowStop, { runId: run.result.runId });
      expect(again.result).toEqual({ ok: true, stopped: false });
      c.close();
      srv.stop();
    });

    test("workflow.run requires name or script → INVALID_PARAMS", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const res = await c.request(METHODS.workflowRun, { sessionId: created.sessionId });
      expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
      c.close();
      srv.stop();
    });

    test("workflow.run with an unknown sessionId → NOT_FOUND", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const res = await c.request(METHODS.workflowRun, { sessionId: "s_ghost", script: "return 1;" });
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      c.close();
      srv.stop();
    });

    test("workflow.run resolves a saved workflow by name via WorkflowStore, trust-gated to the session's own cwd", async () => {
      const srv = await bootWorkflowServer();
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-workflow-rpc-cwd-")));
      mkdirSync(join(cwd, ".norma", "workflows"), { recursive: true });
      writeFileSync(join(cwd, ".norma", "workflows", "hello.js"),
        `export const meta = {name:"hello", description:"says hi"}; return "hi from project";`);

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd });

      // Untrusted: the project workflow exists on disk but the cwd isn't trusted yet.
      const untrusted = await c.request(METHODS.workflowRun, { sessionId: created.sessionId, name: "hello" });
      expect(untrusted.error?.code).toBe(ERR.NOT_FOUND);

      srv.trust.trust(cwd);
      const run = await c.request(METHODS.workflowRun, { sessionId: created.sessionId, name: "hello" });
      expect(run.error).toBeUndefined();
      expect(run.result.status).toBe("running");

      let view: any;
      for (let i = 0; i < 300; i++) {
        const got = await c.request(METHODS.workflowGet, { runId: run.result.runId });
        view = got.result.run;
        if (view.status !== "running") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(view.status).toBe("completed");
      expect(view.result).toBe("hi from project");
      expect(view.name).toBe("hello");
      c.close();
      srv.stop();
    });

    test("workflow.run with an unresolvable name → NOT_FOUND", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const res = await c.request(METHODS.workflowRun, { sessionId: created.sessionId, name: "ghost" });
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      c.close();
      srv.stop();
    });

    test("workflow.list surfaces saved workflows from WorkflowStore alongside running runs", async () => {
      const srv = await bootWorkflowServer();
      mkdirSync(join(srv.normaHome, "workflows"), { recursive: true });
      writeFileSync(join(srv.normaHome, "workflows", "nightly.js"),
        `export const meta = {name:"nightly", description:"nightly sweep"}; return "ok";`);

      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "wf-tester");
      const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
      const list = await c.request(METHODS.workflowList, { sessionId: created.sessionId });
      expect(list.result.saved).toEqual([{ name: "nightly", description: "nightly sweep", source: "user" }]);
      expect(list.result.running).toEqual([]);
      c.close();
      srv.stop();
    });

    test("workflow.* is role-rejected for a plugin connection — local-only, never added to PLUGIN_ALLOWED_METHODS", async () => {
      const srv = await bootWorkflowServer();
      const raw = srv.store.mintPluginToken("wf-plugin");
      const c = await TestClient.connect(srv.socketPath);
      await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "wf-plugin", pluginId: "wf-plugin",
      });
      for (const method of [METHODS.workflowList, METHODS.workflowRun, METHODS.workflowStop, METHODS.workflowGet]) {
        const res = await c.request(method, {});
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
        expect(res.error?.message).toBe(`plugin role may not call ${method}`);
      }
      c.close();
      srv.stop();
    });

    test("workflow.* is role-rejected for a remote connection — local-only, never added to REMOTE_ALLOWED_METHODS", async () => {
      const srv = await bootWorkflowServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.remoteToken, "wf-phone", "remote");
      for (const method of [METHODS.workflowList, METHODS.workflowRun, METHODS.workflowStop, METHODS.workflowGet]) {
        const res = await c.request(method, {});
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
        expect(res.error?.message).toBe(`remote role may not call ${method}`);
      }
      c.close();
      srv.stop();
    });
  });

  test("without a provider, sessions behave as Phase 0 (echo only, no agent events)", async () => {
    await boot(); // no provider injected
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "plain");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "anyone home?" });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.notifications.some((n) => n.params?.type === "turn_started")).toBe(false);
    c.close();
  });

  test("bash tool runs end-to-end through a daemon-wired engine (auto policy)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const { existsSync } = await import("node:fs");
    if (process.platform !== "darwin") return; // sandbox-exec required
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: "echo hi > out.txt" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires bash, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "bash-runner");
    const cwd = mkdtempSync(join(tmpdir(), "norma-bashwire-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "make out.txt" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(cwd, "out.txt"))).toBe(true);
    c.close();
  });

  // Phase 5e T4: settings.reviewer.classes → EngineConfig.reviewerClasses, threaded through the
  // REAL daemon (loadSettings → startDaemon → AgentEngine), not a stubbed cfg. The reviewer stays
  // ON overall (no `reviewer.enabled:false`) but `classes.fs:false` turns off just the fs class —
  // a dotfile write (normally "unusual" and reviewed under auto policy, per 5e T3) must instead
  // execute directly. Only ONE script entry is needed: if the wiring were broken, the write would
  // route to reviewAndDispatch and consume this same single-track FakeProvider queue for a review
  // call instead, which would fail to find a JSON verdict and escalate to a human approval that
  // times out well past bun's default per-test timeout — i.e. a broken wire fails this test loudly.
  test("settings reviewer.classes.fs:false threads through the real daemon: dotfile write bypasses the AI reviewer and executes directly", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const { existsSync, readFileSync: rf } = await import("node:fs");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: ".env", content: "SECRET=1" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { classes: { fs: false } } }); // reviewer stays ON overall; only the fs class is off
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "fs-class-off");
    const cwd = mkdtempSync(join(tmpdir(), "norma-fsclassoff-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write .env" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(cwd, ".env"))).toBe(true);
    expect(rf(join(cwd, ".env"), "utf8")).toBe("SECRET=1");
    c.close();
  });

  test("session.addDir widens roots; bash can then write the added dir", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    if (process.platform !== "darwin") return; // sandbox-exec required
    const added = mkdtempSync(join(tmpdir(), "norma-added-"));
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: `echo hi > ${added}/f.txt` }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires addDir/bash, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "adder");
    const cwd = mkdtempSync(join(tmpdir(), "norma-adder-cwd-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const add = await c.request(METHODS.sessionAddDir, { sessionId: created.sessionId, path: added });
    expect(add.result.roots).toContain(realpathSync(added));
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write in added dir" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(added, "f.txt"))).toBe(true);
    c.close();
  });

  test("session.setCwd changes the dir a new turn runs in", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "moved.txt", content: "here" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mover");
    const cwd1 = mkdtempSync(join(tmpdir(), "norma-cwd1-"));
    const cwd2 = mkdtempSync(join(tmpdir(), "norma-cwd2-"));
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", cwd: cwd1, approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const setCwd = await c.request(METHODS.sessionSetCwd, { sessionId: created.sessionId, cwd: cwd2 });
    expect(setCwd.result).toEqual({ ok: true, cwd: cwd2 });
    await c.request(METHODS.sessionSend, { sessionId: created.sessionId, text: "write moved" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    expect(existsSync(join(cwd2, "moved.txt"))).toBe(true);
    c.close();
  });

  test("startIpcServer refuses an engine without a shared hub", () => {
    // Build a throwaway engine; we only need the constructor guard to fire.
    expect(() => {
      const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-guard-")));
      startIpcServer({
        socketPath: join(mkdtempSync(join(tmpdir(), "norma-guard-sock-")), "s.sock"),
        serverVersion: "test", tokens: {} as any, store,
        engine: {} as any, // engine present...
        // ...no hub
      });
    }).toThrow(/hub/);
  });

  test("session.create reports trusted=false for an untrusted dir, true after daemon.trustDir", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "truster");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-cwd-")));
    const created = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result;
    expect(created.trusted).toBe(false);
    const t = (await c.request(METHODS.trustDir, { path: cwd })).result;
    expect(t).toEqual({ ok: true, trusted: true });
    const created2 = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result;
    expect(created2.trusted).toBe(true); // now trusted (persisted)
    c.close();
  });

  test("committed additionalDirectories apply only after the folder is trusted", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "truster2");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-cwd2-")));
    const granted = realpathSync(mkdtempSync(join(tmpdir(), "norma-committed-")));
    mkdirSync(join(cwd, ".norma"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [granted] } }));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    // Untrusted: committed dir NOT in roots (roots come back via addDir echo of the full set)
    const before = (await c.request(METHODS.sessionAddDir, { sessionId: s, path: cwd })).result.roots; // add cwd (noop-ish), read roots
    expect(before).not.toContain(granted);
    await c.request(METHODS.trustDir, { path: cwd });
    const after = (await c.request(METHODS.sessionAddDir, { sessionId: s, path: cwd })).result.roots;
    expect(after).toContain(granted); // committed dir now present
    c.close();
  });

  test("session.addDir on an unknown session fails and adds no dangling entry", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "adder-bad");
    const res = await c.request(METHODS.sessionAddDir, {
      sessionId: "s_does_not_exist",
      path: realpathSync(mkdtempSync(join(tmpdir(), "norma-x-"))),
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("bg.list/peek/kill over the socket", async () => {
    if (process.platform !== "darwin") return;
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-bgsrv-")));
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "b1", name: "bash", argsJson: JSON.stringify({ command: "echo hi; sleep 2", runInBackground: true }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "started" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake, { reviewer: { enabled: false } }); // this test wires bg tasks, not the reviewer
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "bg");
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "run bg" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "bg_task_started");
    const list = (await c.request(METHODS.bgList, { sessionId: s })).result;
    expect(list.tasks.length).toBe(1);
    const taskId = list.tasks[0].taskId;
    await new Promise((r) => setTimeout(r, 300));
    const peek = (await c.request(METHODS.bgPeek, { sessionId: s, taskId })).result;
    expect(peek.chunk).toContain("hi");
    const kill = (await c.request(METHODS.bgKill, { sessionId: s, taskId })).result;
    expect(kill).toEqual({ ok: true });
    c.close();
  });

  test("session.interrupt aborts a running turn (wasRunning:true, turn_completed aborted)", async () => {
    const { AbortAwaitProvider } = await import("../src/agent/test-providers");
    await boot({}, new AbortAwaitProvider());
    const c = await TestClient.connect(daemon.socketPath); await c.hello(harnessToken, "int");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-int-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "go" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_started");
    const r = (await c.request(METHODS.sessionInterrupt, { sessionId: s })).result;
    expect(r).toEqual({ ok: true, wasRunning: true });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed" && n.params.stopReason === "aborted");
    c.close();
  });

  test("session.interrupt with no running turn is a no-op (wasRunning:false)", async () => {
    const { AbortAwaitProvider } = await import("../src/agent/test-providers");
    await boot({}, new AbortAwaitProvider());
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "int-idle");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-int-idle-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    const r = (await c.request(METHODS.sessionInterrupt, { sessionId: s })).result;
    expect(r).toEqual({ ok: true, wasRunning: false });
    c.close();
  });

  test("session.steer injects into a running turn (injected:true) and emits user_message", async () => {
    const { GatedProvider, deferred } = await import("../src/agent/test-providers");
    const gate = deferred();
    const gated = new GatedProvider(
      [
        [{ type: "text_delta", delta: "first" }, { type: "done", stopReason: "end_turn" }],
        [{ type: "text_delta", delta: "second" }, { type: "done", stopReason: "end_turn" }],
      ],
      [gate.promise, null],
    );
    await boot({}, gated);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "steerer");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-steer-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    await c.request(METHODS.sessionSend, { sessionId: s, text: "go" });
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_started");
    const r = (await c.request(METHODS.sessionSteer, { sessionId: s, text: "wait, actually..." })).result;
    expect(r).toEqual({ ok: true, injected: true });
    const msg = await c.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message" && n.params.clientName === "steer");
    expect(msg.params.text).toBe("wait, actually...");
    gate.resolve();
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.steer with no running turn starts one (injected:false) and emits user_message", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([[
      { type: "text_delta", delta: "sure" },
      { type: "done", stopReason: "end_turn" },
    ]]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "steerer-idle");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-steer-idle-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });
    const r = (await c.request(METHODS.sessionSteer, { sessionId: s, text: "start please" })).result;
    expect(r).toEqual({ ok: true, injected: false });
    const msg = await c.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "user_message" && n.params.clientName === "steer");
    expect(msg.params.text).toBe("start please");
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "turn_completed");
    c.close();
  });

  test("session.steer/interrupt without an engine degrade gracefully", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-engine");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const steer = (await c.request(METHODS.sessionSteer, { sessionId: created.sessionId, text: "hi" })).result;
    expect(steer).toEqual({ ok: true, injected: false });
    const interrupt = (await c.request(METHODS.sessionInterrupt, { sessionId: created.sessionId })).result;
    expect(interrupt).toEqual({ ok: true, wasRunning: false });
    c.close();
  });

  test("session.compact without an engine degrades gracefully", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-engine-compact");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global" });
    const r = (await c.request(METHODS.sessionCompact, { sessionId: created.sessionId })).result;
    expect(r).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 });
    c.close();
  });

  test("session.compact folds older turns into a checkpoint (over the socket)", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "compactor");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-compact-")));
    const s = (await c.request(METHODS.sessionCreate, { scope: "global", cwd, approvalPolicy: "auto" })).result.sessionId;
    await c.request(METHODS.sessionAttach, { sessionId: s, fromSeq: 0 });

    // 4 turns → 8 messages, past the Compactor's default keepTail(6) → compactable.
    // Sends must be serialized: a turn already running just queues history instead of starting a new one.
    for (let i = 0; i < 4; i++) {
      await c.request(METHODS.sessionSend, { sessionId: s, text: `turn ${i}` });
      const deadline = Date.now() + 2000;
      while (c.notifications.filter((n) => n.method === METHODS.event && n.params.type === "turn_completed").length <= i) {
        if (Date.now() > deadline) throw new Error("timed out waiting for turn_completed");
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    const r = (await c.request(METHODS.sessionCompact, { sessionId: s })).result;
    expect(r.ok).toBe(true);
    expect(r.compacted).toBe(true);
    expect(r.uptoSeq).toBeGreaterThan(0);
    expect(r.summaryChars).toBeGreaterThan(0);
    const checkpoint = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "checkpoint");
    expect(checkpoint.params.uptoSeq).toBe(r.uptoSeq);
    expect(checkpoint.params.summary.length).toBe(r.summaryChars);
    c.close();
  });

  test("skills.list returns only the shipped builtin when no user/project skills are installed", async () => {
    await boot(); // no provider → default temp home has no user/project skills
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-skills");
    const { result } = await c.request(METHODS.skillsList, {});
    expect(result.ok).toBe(true);
    // The writing-skills builtin (phase 5c) is always discovered, regardless of home — it ships
    // in-repo and is resolved relative to the module, not normaHome.
    expect(result.skills).toEqual([{ name: "writing-skills", description: expect.any(String), source: "builtin", path: expect.any(String) }]);
    c.close();
  });

  test("skills.list discovers a user skill over the socket (the daemon wires its one skillStore into the server)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    mkdirSync(join(home, "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Say hi\n---\nSay hello warmly.\n");
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "skills-lister");
    const { result } = await c.request(METHODS.skillsList, {});
    expect(result.ok).toBe(true);
    // greet (user) + the always-present writing-skills builtin.
    expect(result.skills).toHaveLength(2);
    expect(result.skills.find((s: { name: string }) => s.name === "greet")).toMatchObject({ name: "greet", description: "Say hi", source: "user" });
    expect(result.skills.find((s: { name: string }) => s.name === "writing-skills")).toMatchObject({ source: "builtin" });
    c.close();
  });

  test("mcp.list reports a connected MCP server started by the daemon at boot (spawns a real child process)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      mcpServers: { fake: { command: "bun", args: ["run", fixture] } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mcp-lister");
    const { result } = await c.request(METHODS.mcpList, {});
    expect(result).toEqual({ ok: true, servers: [{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }] });
    c.close();
  });

  test("mcp.list({cwd}) ensures + surfaces a trusted project's servers (source \"project\"); mcp.list({}) shows only user servers", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      mcpServers: { fake: { command: "bun", args: ["run", fixture] } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "norma-mcp-project-")));
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "bun", args: ["run", fixture] } } }));

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "mcp-lister-project");

    // No cwd: only the user-configured server.
    const noCwd = (await c.request(METHODS.mcpList, {})).result;
    expect(noCwd).toEqual({ ok: true, servers: [{ name: "fake", status: "connected", toolNames: ["echo"], source: "user" }] });

    // Untrusted project cwd: ensureProject is a no-op, so the project server is absent.
    const untrusted = (await c.request(METHODS.mcpList, { cwd: projectDir })).result;
    expect(untrusted.servers.find((s: any) => s.name === "proj")).toBeUndefined();

    await c.request(METHODS.trustDir, { path: projectDir });

    // Trusted now: mcp.list starts the project's servers (ensureProject) and shows them.
    const { result } = await c.request(METHODS.mcpList, { cwd: projectDir });
    expect(result.ok).toBe(true);
    expect(result.servers).toContainEqual({ name: "proj", status: "connected", toolNames: ["echo"], source: "project" });
    expect(result.servers).toContainEqual({ name: "fake", status: "connected", toolNames: ["echo"], source: "user" });

    c.close();
  });

  test("plugins.list returns [] when no PluginStore is wired into the server", async () => {
    await boot(); // no `plugins` opt passed by the daemon in this test's boot() helper
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-plugins");
    const { result } = await c.request(METHODS.pluginsList, {});
    expect(result).toEqual({ ok: true, plugins: [] });
    c.close();
  });

  test("plugins.list returns a PluginStore's plugins over the socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-plugins-ipc-"));
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
    const plugins = new PluginStore({ normaHome: home, plugins: { enabled: ["demo"] } });

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins });
    try {
      const c = await TestClient.connect(socketPath);
      await c.hello(tokens.harness, "plugin-lister");
      const { result } = await c.request(METHODS.pluginsList, {});
      expect(result.ok).toBe(true);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]).toMatchObject({
        name: "demo", skills: ["greet"], hasMcp: true, mcpEnabled: true, disabled: false,
        status: "na", // legacy plugin (no norma-plugin.json) — never tier "platform", never spawn-eligible
      });
      c.close();
    } finally {
      server.stop();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 4d-i Task 4: plugins.list enriches each entry with live PluginSupervisor runtime status
  // — a dashboard can't otherwise tell a Tier-2 plugin's actual running/crashed/circuit-open state
  // apart from static manifest/consent data. Tier-2 (`platform` + `entry`, pluginSpawnEligible) get
  // the real SupervisorStatus; Tier-1 (`capability`) never runs a process, so always "na".
  // ---------------------------------------------------------------------------------------------
  describe("plugins.list supervisor status (Phase 4d-i Task 4)", () => {
    test("Tier-2 plugin the supervisor reports \"running\" includes status:\"running\"; Tier-1 plugin includes status:\"na\"", async () => {
      const home = mkdtempSync(join(tmpdir(), "norma-plugins-status-"));
      // Tier-2 (platform) plugin — spawn-eligible: tier platform + entry + enabled + exec-consented.
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "norma-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      // Tier-1 (capability) plugin — never spawn-eligible, no process ever runs for it.
      mkdirSync(join(home, "plugins", "toolbox"), { recursive: true });
      writeFileSync(join(home, "plugins", "toolbox", "norma-plugin.json"), JSON.stringify({ id: "toolbox", tier: "capability" }));

      const plugins = new PluginStore({
        normaHome: home,
        plugins: { enabled: ["runner", "toolbox"] },
        consents: { runner: { exec: Date.now() } },
      });

      const secrets = new FileSecretStore(join(home, "test-secrets"));
      const authority = new TokenAuthority(secrets);
      const tokens = await authority.ensureTokens();
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      // Real PluginSupervisor, fake spawn/isAlivePid/signalPid — same injection precedent as
      // "plugin.restart"'s bootRestartServer below.
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"),
        socketPath,
        mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: 12345, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false,
        signalPid: () => {},
      });
      // Bring "runner" to "running" exactly like a real plugin process would over the wire:
      // startAll spawns it (fake), notifyRegistered (a fake connection) flips it to "running".
      supervisor.startAll([{ id: "runner", dir: join(home, "plugins", "runner"), entry: { command: "bun", args: ["index.ts"] } }]);
      expect(supervisor.notifyRegistered("runner", { push: () => true })).toBe(true);
      expect(supervisor.status("runner")).toBe("running");

      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins, supervisor });
      try {
        const c = await TestClient.connect(socketPath);
        await c.hello(tokens.harness, "plugin-status-lister");
        const { result } = await c.request(METHODS.pluginsList, {});
        expect(result.ok).toBe(true);
        const byName = Object.fromEntries(result.plugins.map((p: any) => [p.name, p]));
        expect(byName.runner).toMatchObject({ tier: "platform", status: "running" });
        expect(byName.toolbox).toMatchObject({ tier: "capability", status: "na" });
        c.close();
      } finally {
        supervisor.stopAll();
        server.stop();
      }
    });

    test("a spawn-eligible plugin the supervisor has never tracked reports status \"stopped\" (never \"na\")", async () => {
      const home = mkdtempSync(join(tmpdir(), "norma-plugins-status-untracked-"));
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "norma-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const plugins = new PluginStore({
        normaHome: home, plugins: { enabled: ["runner"] }, consents: { runner: { exec: Date.now() } },
      });
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      const authority = new TokenAuthority(secrets);
      const tokens = await authority.ensureTokens();
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      // A real supervisor IS wired, but startAll/reclaimOrphans was never called for "runner" — it
      // has no runtime tracked at all (never spawned this process lifetime).
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"), socketPath, mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: 1, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false, signalPid: () => {},
      });
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins, supervisor });
      try {
        const c = await TestClient.connect(socketPath);
        await c.hello(tokens.harness, "plugin-status-untracked");
        const { result } = await c.request(METHODS.pluginsList, {});
        expect(result.plugins[0]).toMatchObject({ name: "runner", status: "stopped" });
        c.close();
      } finally {
        server.stop();
      }
    });

    test("no supervisor wired at all: Tier-1 plugin still \"na\"; a spawn-eligible (Tier-2-shaped) plugin falls back to \"stopped\"", async () => {
      const home = mkdtempSync(join(tmpdir(), "norma-plugins-status-nosupervisor-"));
      mkdirSync(join(home, "plugins", "toolbox"), { recursive: true });
      writeFileSync(join(home, "plugins", "toolbox", "norma-plugin.json"), JSON.stringify({ id: "toolbox", tier: "capability" }));
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "norma-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const plugins = new PluginStore({
        normaHome: home, plugins: { enabled: ["toolbox", "runner"] }, consents: { runner: { exec: Date.now() } },
      });
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      const authority = new TokenAuthority(secrets);
      const tokens = await authority.ensureTokens();
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      // No `supervisor` option passed at all — mirrors "plugins.list returns [] when no PluginStore
      // is wired" above, but for the supervisor seam instead.
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins });
      try {
        const c = await TestClient.connect(socketPath);
        await c.hello(tokens.harness, "plugin-status-nosup");
        const { result } = await c.request(METHODS.pluginsList, {});
        const byName = Object.fromEntries(result.plugins.map((p: any) => [p.name, p]));
        expect(byName.toolbox).toMatchObject({ status: "na" });
        expect(byName.runner).toMatchObject({ status: "stopped" });
        c.close();
      } finally {
        server.stop();
      }
    });
  });

  // THE CONSENT SEAM: a plugin's skills are always live (SkillStore has no consent gate), but a
  // plugin's MCP servers only start when the user has opted in via settings.plugins.enabled —
  // and settings.plugins.disabled always wins over enabled (fully off: no skills, no MCP).
  function seedDemoPlugin(home: string, fixture: string): void {
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "bun", args: ["run", fixture] } } }));
  }

  test("CONSENT: a not-enabled plugin's skills are live but its MCP servers are NOT started", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-off");
    const skills = (await c.request(METHODS.skillsList, {})).result;
    expect(skills.skills.map((s: any) => s.name)).toContain("demo:greet"); // skills always live
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")).toBeUndefined(); // no consent → no server
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: false, disabled: false });
    c.close();
  });

  test("enabled in settings → the plugin's MCP server starts at boot (source plugin)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"] },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-on");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    const st = mcp.servers.find((s: any) => s.name === "demo:fake");
    expect(st?.source).toBe("plugin");
    expect(st?.status).toBe("connected");
    expect(st?.toolNames).toEqual(["echo"]); // tool registered + reachable through the registry
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: true, disabled: false });
    c.close();
  });

  test("disabled beats enabled → plugin fully off (skills gone, MCP not started)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedDemoPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"], disabled: ["demo"] },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-disabled");
    const skills = (await c.request(METHODS.skillsList, {})).result;
    expect(skills.skills.map((s: any) => s.name)).not.toContain("demo:greet");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")).toBeUndefined();
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({ name: "demo", hasMcp: true, mcpEnabled: false, disabled: true });
    c.close();
  });

  // -----------------------------------------------------------------------------------------
  // Task 2: per-class consent records enforce exec-gated plugin content, end-to-end through the
  // REAL daemon wiring (startDaemon → PluginStore(consents) → pluginMcpEligible filter →
  // McpManager.startPlugins). A manifest plugin declaring contributes.mcpServers requires "exec"
  // consent (plugin-manifest.ts#requiredConsentClasses); the legacy CONSENT tests above already
  // pin that a plugin.json-only plugin needs no consent record at all — this is the new gate.
  // -----------------------------------------------------------------------------------------
  function seedManifestPlugin(home: string, fixture: string): void {
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "bun", args: ["run", fixture] } } }));
    writeFileSync(join(home, "plugins", "demo", "norma-plugin.json"), JSON.stringify({
      id: "demo", tier: "capability",
      contributes: { mcpServers: [{ name: "fake", command: "bun", args: ["run", fixture] }] },
    }));
  }

  test("CONSENT (Task 2): manifest plugin enabled but unconsented — MCP not started + a log line names the missing class", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedManifestPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"] }, // enabled, but no consents record at all
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);

    const origError = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => { captured.push(String(args[0])); };
    try {
      daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    } finally {
      console.error = origError;
    }
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-unconsented");
    const skills = (await c.request(METHODS.skillsList, {})).result;
    expect(skills.skills.map((s: any) => s.name)).toContain("demo:greet"); // skills stay always-live
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")).toBeUndefined(); // exec unconsented → no server
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({
      name: "demo", hasMcp: true, mcpEnabled: true, disabled: false,
      requiredConsents: ["exec"], consented: [],
      // Task 3: the CLI consent flow's display data reaches the wire too (core → ipc passthrough
      // — no transform strips these; the protocol schema round-trip itself is covered by
      // packages/protocol/test/methods.test.ts).
      tier: "capability", legacy: false,
      execPayload: [`mcp: bun run ${fixture}`], tccPermissions: [], hardwarePermissions: [],
    });
    expect(captured.some((m) => m.includes("demo") && m.includes("exec"))).toBe(true); // the "why" log line
    c.close();
  });

  test("CONSENT (Task 2): manifest plugin enabled + exec consent recorded — MCP starts (source plugin)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedManifestPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"], consents: { demo: { exec: Date.now() } } },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "consent-granted");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    const st = mcp.servers.find((s: any) => s.name === "demo:fake");
    expect(st?.source).toBe("plugin");
    expect(st?.status).toBe("connected");
    expect(st?.toolNames).toEqual(["echo"]);
    const plugins = (await c.request(METHODS.pluginsList, {})).result;
    expect(plugins.plugins[0]).toMatchObject({
      name: "demo", mcpEnabled: true, requiredConsents: ["exec"], consented: ["exec"],
    });
    c.close();
  });

  // -----------------------------------------------------------------------------------------
  // Task 4: manifest-declared mcpServers through the REAL daemon wiring (startDaemon →
  // PluginStore → pluginMcpEligible → loadManifest → McpManager.startPlugins(manifestServers)).
  // The first test below is the T2 interim gap this task closes: T2/T3 could already GATE a
  // manifest-only plugin's eligibility, but nothing actually started its servers because
  // McpManager.startPlugins only ever read .mcp.json — a manifest-only plugin (no .mcp.json) was
  // eligible yet inert. Task 4 wires the manifest's contributes.mcpServers through so eligible
  // manifest-only plugins actually start.
  // -----------------------------------------------------------------------------------------
  function seedManifestOnlyPlugin(home: string, fixture: string): void {
    // Deliberately NO .mcp.json anywhere in this plugin dir.
    mkdirSync(join(home, "plugins", "demo"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "norma-plugin.json"), JSON.stringify({
      id: "demo", tier: "capability",
      contributes: { mcpServers: [{ name: "fake", command: "bun", args: ["run", fixture] }] },
    }));
  }

  test("Task 4: manifest-only plugin (no .mcp.json) enabled + consented — MCP starts from the manifest (closes T2 interim gap)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    seedManifestOnlyPlugin(home, fixture);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"], consents: { demo: { exec: Date.now() } } },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "manifest-only-mcp");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    const st = mcp.servers.find((s: any) => s.name === "demo:fake");
    expect(st?.source).toBe("plugin");
    expect(st?.status).toBe("connected");
    expect(st?.toolNames).toEqual(["echo"]);
    c.close();
  });

  test("Task 4: manifest + .mcp.json both present — manifest wins, .mcp.json server is NOT started", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "norma-plugin-consent-"));
    mkdirSync(join(home, "plugins", "demo"), { recursive: true });
    // .mcp.json declares a DIFFERENT server name than the manifest, so precedence is unambiguous.
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({
      mcpServers: { legacy: { command: "/nonexistent-legacy-server" } },
    }));
    writeFileSync(join(home, "plugins", "demo", "norma-plugin.json"), JSON.stringify({
      id: "demo", tier: "capability",
      contributes: { mcpServers: [{ name: "fake", command: "bun", args: ["run", fixture] }] },
    }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      plugins: { enabled: ["demo"], consents: { demo: { exec: Date.now() } } },
    }));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "manifest-wins-mcp");
    const mcp = (await c.request(METHODS.mcpList, {})).result;
    expect(mcp.servers.find((s: any) => s.name === "demo:fake")?.status).toBe("connected");
    expect(mcp.servers.find((s: any) => s.name === "demo:legacy")).toBeUndefined(); // .mcp.json ignored entirely
    c.close();
  });

  // -----------------------------------------------------------------------------------------
  // Phase 4d-cleanup Task 2: PluginSupervisor construction + the boot-time orphan-PID sweep are
  // hoisted OUT of `if (agentProvider)` in daemon.ts — a daemon booted with the agent DISABLED
  // (no provider configured, or a test injecting `agentProvider: null`, as here) must still reclaim
  // stale <runDir>/plugins/<id>.pid files left by a previous run, not just a daemon with an active
  // provider. Exercises the REAL `startDaemon` wiring end to end (no injected fakes for
  // isAlivePid/spawn — daemon.ts's own PluginSupervisor construction doesn't expose that seam), so
  // the PID file uses a definitely-dead pid: the sweep's "not alive" branch removes it without ever
  // needing the `ps -o lstart=` identity check, so this doesn't depend on any real process at all.
  // -----------------------------------------------------------------------------------------
  test("Phase 4d-cleanup Task 2: a daemon booted with NO agent provider still sweeps a stale orphaned plugin PID file at boot", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-no-provider-sweep-"));
    const pidDir = join(home, "run", "plugins");
    mkdirSync(pidDir, { recursive: true });
    const pidFile = join(pidDir, "ghost-plugin.pid");
    // A definitely-dead pid (no plugin named "ghost-plugin" is installed at all, so it's not in
    // the spawn-eligible set regardless — this is exactly the "plugin disabled/removed since last
    // run" case sweepOrphans exists for).
    writeFileSync(pidFile, JSON.stringify({ pid: 999999, pluginId: "ghost-plugin", startedAt: "Thu Jan  1 00:00:00 1970" }));
    expect(existsSync(pidFile)).toBe(true);

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null }); // no provider — the case under test

    // The sweep ran synchronously, before startDaemon's returned promise resolves (it's hoisted
    // ahead of every `await` gated on agentProvider) — no polling/waitFor needed.
    expect(existsSync(pidFile)).toBe(false);
  });

  // -----------------------------------------------------------------------------------------
  // Review-caught regression (post Phase 4d-cleanup Task 2): hoisting `PluginSupervisor`
  // construction out of `if (agentProvider)` (above) made `opts.supervisor` ALWAYS defined, which
  // silently widened `hotApplyStart` (ipc/server.ts) — its old guard was `!opts.supervisor ||
  // !opts.normaHome`, so a no-provider daemon fell through to a REAL `opts.supervisor.restart()`
  // spawn on `plugin.enable {consent:true}`, where before this task it always returned "stopped"
  // with no spawn. Fixed by also gating on `opts.registry` (only ever wired for a
  // provider-configured daemon — same signal `tool.register` already uses). This proves the FIX:
  // a spawn-eligible plugin's `plugin.enable{consent:true}` on a no-provider daemon still records
  // settings but genuinely never spawns. Exercises the REAL `startDaemon` wiring end to end (same
  // no-injectable-spawn-seam constraint as the sweep test above), with a real, harmless entry
  // (`bun --version`) — if the bug regressed, this WOULD spawn a real OS process.
  // -----------------------------------------------------------------------------------------
  test("Phase 4d-cleanup Task 2 fix: a daemon booted with NO agent provider does NOT hot-spawn on plugin.enable — settings recorded, status stays \"stopped\", no process spawned", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-no-provider-enable-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" }, // unused — agentProvider: null below forces no-provider
    }));
    // A Tier-2 (platform) plugin with an `entry` — spawn-eligible once enabled+consented, exactly
    // the shape `plugin.enable{consent:true}` would hot-spawn on a provider-configured daemon.
    mkdirSync(join(home, "plugins", "runner"), { recursive: true });
    writeFileSync(join(home, "plugins", "runner", "norma-plugin.json"), JSON.stringify({
      id: "runner", tier: "platform", entry: { command: "bun", args: ["--version"] },
    }));

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    daemon = await startDaemon({ home, secrets, agentProvider: null }); // no provider — the case under test
    harnessToken = daemon.tokens.harness;

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-provider-enabler");
    const res = await c.request(METHODS.pluginEnable, { name: "runner", consent: true });
    expect(res.result).toEqual({ ok: true, status: "stopped" }); // recorded, never hot-spawned

    // The strongest available proof of "never spawned": PluginSupervisor.writePidFile runs
    // SYNCHRONOUSLY inside spawnFresh, before restart() returns — so if hotApplyStart had reached
    // supervisor.restart() at all, this file would already exist by the time the RPC responded.
    expect(existsSync(join(home, "run", "plugins", "runner.pid"))).toBe(false);

    const list = await c.request(METHODS.pluginsList, {});
    const runner = list.result.plugins.find((p: any) => p.name === "runner");
    expect(runner).toMatchObject({ disabled: false, mcpEnabled: true, status: "stopped" }); // enabled, never running

    c.close();
  });

  // -----------------------------------------------------------------------------------------
  // Peripheral lease v1 (Phase 2f). `boot()` wires the REAL PeripheralBroker/AuditLog/
  // ProviderLink daemon.ts builds — these tests exercise the production wiring, not fakes.
  // -----------------------------------------------------------------------------------------

  test("peripheral.lease under auto policy grants immediately when a provider is connected", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "peripheral-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(res.result.leaseId).toBeTruthy();
    expect(res.result.token).toBeTruthy();
    expect(res.result.expiresAt).toBeGreaterThan(Date.now());

    const granted = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_granted");
    expect(granted.params.leaseId).toBe(res.result.leaseId);
    expect(granted.params.holder).toEqual({ kind: "session", id: created.sessionId });

    provider.close(); c.close();
  });

  test('peripheral.lease with no provider connected returns {code:"no_provider"}', async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-provider-leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(res.result).toEqual({ code: "no_provider" });
    c.close();
  });

  test("peripheral.lease under ask policy raises an approval card naming the class; approving grants", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "ask-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "ask-leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "ask" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    const leasePromise = c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    const ask = await c.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "approval_requested" && n.params.toolName === "peripheral.lease");
    expect(ask.params.summary).toBe(`Session ${created.sessionId} requests noop`);

    const respond = await c.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
    expect(respond.result).toEqual({ ok: true, alreadyResolved: false });

    const res = await leasePromise;
    expect(res.result.leaseId).toBeTruthy();
    await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_granted");
    provider.close(); c.close();
  });

  // Regression coverage for the deleted `peripheralClassHint` side-channel (a sessionId -> class
  // map ipc/server.ts used to `set()` synchronously right before calling `broker.lease()`, read
  // back by daemon.ts's ask-policy closure). That map was keyed ONLY by sessionId, so two
  // near-simultaneous lease() calls from the SAME session for DIFFERENT classes could clobber
  // each other's hint between the set() and the (possibly slow, ask-mode) policy read — a real
  // future bug even though it was race-free the day it was written. The fix threads the class
  // straight through as a policy(sessionId, cls) call argument, so each in-flight policy
  // invocation closes over its OWN class with nothing shared to race on. This test drives BOTH
  // approval cards into existence before resolving EITHER, so it would have caught the old
  // mislabeling bug.
  test("peripheral.lease concurrent same-session different-class requests under ask policy: each approval card names ITS OWN class", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "concurrent-ask-provider");
    await provider.request(METHODS.peripheralAdvertise, {
      classes: [{ class: "noop", tccGranted: true }, { class: "screenshot", tccGranted: true }],
    });

    const watcher = await TestClient.connect(daemon.socketPath);
    await watcher.hello(harnessToken, "concurrent-ask-watcher");
    const { result: created } = await watcher.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "ask" });
    await watcher.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    // Two SEPARATE connections issue the two lease requests — same session, different classes.
    // (Deliberately not both on one connection: this server's per-connection `data()` handler
    // awaits each RPC line's `handle()` before parsing the next line in the same read, so two
    // blocking ask-policy calls queued back-to-back on ONE socket would serialize instead of
    // actually overlapping — that would defeat the point of this test.)
    const reqA = await TestClient.connect(daemon.socketPath);
    await reqA.hello(harnessToken, "concurrent-ask-a");
    const reqB = await TestClient.connect(daemon.socketPath);
    await reqB.hello(harnessToken, "concurrent-ask-b");

    // Fire both requests before awaiting either — both policy() invocations are in flight
    // concurrently, parked on their own approvalBroker.wait().
    const leaseNoop = reqA.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    const leaseScreenshot = reqB.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "screenshot" });

    // Collect BOTH approval_requested cards before resolving either — this is exactly the window
    // where a shared sessionId-keyed hint could have been overwritten by the second request
    // before the first card's summary was built.
    const asks: any[] = [];
    while (asks.length < 2) {
      const n = await watcher.waitForNotification((notif) =>
        notif.method === METHODS.event && notif.params.type === "approval_requested" &&
        notif.params.toolName === "peripheral.lease" && !asks.some((a) => a.params.callId === notif.params.callId));
      asks.push(n);
    }

    const askNoop = asks.find((a) => a.params.summary === `Session ${created.sessionId} requests noop`);
    const askScreenshot = asks.find((a) => a.params.summary === `Session ${created.sessionId} requests screenshot`);
    expect(askNoop).toBeDefined();
    expect(askScreenshot).toBeDefined();

    // Resolve screenshot's card first (reverse of request order) so a same-session ordering
    // assumption can't accidentally paper over a mislabel.
    await watcher.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: askScreenshot.params.callId, approved: true });
    await watcher.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: askNoop.params.callId, approved: true });

    const resNoop = await leaseNoop;
    const resScreenshot = await leaseScreenshot;
    expect(resNoop.result.leaseId).toBeTruthy();
    expect(resScreenshot.result.leaseId).toBeTruthy();

    provider.close(); watcher.close(); reqA.close(); reqB.close();
  });

  // SP3 T4b: approval.list — queryable pending-approval STATE (a phone that missed the
  // approval_requested event in its replay window queries the live pending set). The remote role
  // is allowlisted for it (REMOTE_ALLOWED_METHODS grew 9→10); a non-allowlisted method stays
  // role-rejected. Drives a real pending broker entry via the peripheral.lease-under-ask path
  // (same recipe as the ask-policy lease test above), then queries and resolves it.
  test("approval.list returns the broker's pending approvals for a session (with expiresAt); a remote-role call is allowed, off-list methods stay rejected; resolving clears it", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "approval-list-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const leaser = await TestClient.connect(daemon.socketPath);
    await leaser.hello(harnessToken, "approval-list-leaser");
    const { result: created } = await leaser.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "ask" });
    await leaser.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    // Park a lease under ask → registers a pending broker entry + emits the approval_requested card.
    const leasePromise = leaser.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    const ask = await leaser.waitForNotification((n) =>
      n.method === METHODS.event && n.params.type === "approval_requested" && n.params.toolName === "peripheral.lease");
    expect(ask.params.expiresAt).toBeGreaterThan(ask.params.issuedAt);

    // A least-privileged remote connection may call approval.list (it's on REMOTE_ALLOWED_METHODS).
    const remote = await TestClient.connect(daemon.socketPath);
    await remote.hello(daemon.tokens.remote, "approval-list-phone", "remote");
    const listed = await remote.request(METHODS.approvalList, { sessionId: created.sessionId });
    expect(listed.result.pending).toEqual([{
      callId: ask.params.callId, toolName: "peripheral.lease",
      summary: `Session ${created.sessionId} requests noop`,
      issuedAt: ask.params.issuedAt, expiresAt: ask.params.expiresAt,
    }]);
    // A different session has nothing pending.
    const other = await remote.request(METHODS.approvalList, { sessionId: "s_none" });
    expect(other.result.pending).toEqual([]);

    // But an off-list method from the SAME remote connection is still role-rejected before dispatch.
    const offList = await remote.request(METHODS.trustDir, {});
    expect(offList.error.code).toBe(ERR.UNAUTHORIZED);
    expect(offList.error.message).toMatch(/remote role may not call/);

    // Resolving the approval removes it from the pending set.
    await leaser.request(METHODS.approvalRespond, { sessionId: created.sessionId, callId: ask.params.callId, approved: true });
    await leasePromise;
    const afterResolve = await remote.request(METHODS.approvalList, { sessionId: created.sessionId });
    expect(afterResolve.result.pending).toEqual([]);

    provider.close(); leaser.close(); remote.close();
  });

  test("peripheral.lease under plan policy is denied immediately (no approval card)", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "plan-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "plan-leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "plan" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });

    const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(res.result).toEqual({ code: "denied" });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.notifications.some((n) => n.params?.type === "approval_requested")).toBe(false);
    provider.close(); c.close();
  });

  test("peripheral.lease contention: the second requester gets lease_held with the first holder's identity", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "contention-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const a = await TestClient.connect(daemon.socketPath);
    await a.hello(harnessToken, "contender-a");
    const sa = (await a.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" })).result.sessionId;
    const grantA = await a.request(METHODS.peripheralLease, { sessionId: sa, class: "noop" });
    expect(grantA.result.leaseId).toBeTruthy();

    const b = await TestClient.connect(daemon.socketPath);
    await b.hello(harnessToken, "contender-b");
    const sb = (await b.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" })).result.sessionId;
    const grantB = await b.request(METHODS.peripheralLease, { sessionId: sb, class: "noop" });
    expect(grantB.result).toEqual({ code: "lease_held", holder: { kind: "session", id: sa } });

    provider.close(); a.close(); b.close();
  });

  // Phase 4b Task 2: this used to stub TokenAuthority to fake a "plugin"-role hello (no real
  // plugin auth existed) and pinned the handlers' OWN defensive `authedRole !== "harness"` denied
  // branch. Now that a real plugin-token path + a role→method allowlist exist, peripheral.lease/
  // renew/release are NOT among the six plugin-role verbs (Task 2 contract), so a plugin
  // connection is role-rejected by the allowlist gate BEFORE ever reaching those handlers — an
  // even stronger form of "never touching the broker" than the old typed-denied result.
  test("peripheral.lease/renew/release from a plugin-role connection are role-rejected before ever reaching the broker", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-peripheral-plugin-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const rawToken = store.mintPluginToken("plugin-client");
    // `tokens` is never consulted for a role:"plugin" hello (routed through store.verifyPluginToken
    // instead) — any object satisfying the type suffices.
    const stubTokens = { verify: async () => false } as any;
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: stubTokens, store });
    try {
      const c = await TestClient.connect(socketPath);
      const hello = await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: rawToken, clientName: "plugin-client", pluginId: "plugin-client",
      });
      expect(hello.result.ok).toBe(true);

      const lease = await c.request(METHODS.peripheralLease, { sessionId: "s_whatever", class: "noop" });
      expect(lease.error?.code).toBe(ERR.UNAUTHORIZED);
      const renew = await c.request(METHODS.peripheralRenew, { sessionId: "s_whatever", leaseId: "l1", token: "t1" });
      expect(renew.error?.code).toBe(ERR.UNAUTHORIZED);
      const release = await c.request(METHODS.peripheralRelease, { sessionId: "s_whatever", leaseId: "l1", token: "t1" });
      expect(release.error?.code).toBe(ERR.UNAUTHORIZED);

      c.close();
    } finally {
      server.stop();
    }
  });

  test("peripheral.advertise rejects a non-harness (admin) role", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "admin", token: daemon.tokens.admin, clientName: "admin-conn" });
    const res = await c.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });

  test("peripheral.revoke / peripheral.respond are rejected from a non-provider connection; the real provider can revoke", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "real-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const impostor = await TestClient.connect(daemon.socketPath);
    await impostor.hello(harnessToken, "impostor");
    const revoke = await impostor.request(METHODS.peripheralRevoke, { all: true, reason: "panic" });
    expect(revoke.error).toBeTruthy();
    expect(revoke.error.code).toBe(ERR.UNAUTHORIZED);
    const respond = await impostor.request(METHODS.peripheralRespond, { requestId: "req_whatever" });
    expect(respond.error).toBeTruthy();
    expect(respond.error.code).toBe(ERR.UNAUTHORIZED);

    const okRevoke = await provider.request(METHODS.peripheralRevoke, { all: true, reason: "panic" });
    expect(okRevoke.result).toEqual({ ok: true, revoked: 0 });

    provider.close(); impostor.close();
  });

  test("peripheral.advertise: the most recently advertising connection becomes THE provider (identity replaces)", async () => {
    await boot();
    const first = await TestClient.connect(daemon.socketPath);
    await first.hello(harnessToken, "first-provider");
    await first.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const second = await TestClient.connect(daemon.socketPath);
    await second.hello(harnessToken, "second-provider");
    await second.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const rejected = await first.request(METHODS.peripheralRevoke, { all: true, reason: "panic" });
    expect(rejected.error?.code).toBe(ERR.UNAUTHORIZED);

    const ok = await second.request(METHODS.peripheralRevoke, { all: true, reason: "panic" });
    expect(ok.result).toEqual({ ok: true, revoked: 0 });

    first.close(); second.close();
  });

  test("provider disconnect revokes its leases (lease_lost provider-gone); a later lease sees no_provider until re-advertised", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "disconnecting-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "disc-leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(grant.result.leaseId).toBeTruthy();

    provider.close();
    const lost = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost");
    expect(lost.params.reason).toBe("provider-gone");

    const res2 = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(res2.result).toEqual({ code: "no_provider" });

    c.close();
  });

  test("peripheral.renew extends expiresAt; without renewal the lease eventually expires (short settings override)", async () => {
    await boot({}, undefined, { peripheral: { expiryMs: 150, heartbeatMs: 20 } });
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "expiry-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "expiry-leaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    await c.request(METHODS.sessionAttach, { sessionId: created.sessionId, fromSeq: 0 });
    const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    const { leaseId, token, expiresAt } = grant.result;

    // Real elapsed time between grant and renew (rather than asserting strict inequality against
    // two `Date.now() + expiryMs` reads that could tie within the same millisecond tick).
    await new Promise((r) => setTimeout(r, 60));
    const renew = await c.request(METHODS.peripheralRenew, { sessionId: created.sessionId, leaseId, token });
    expect(renew.result.expiresAt).toBeGreaterThan(expiresAt);

    const lost = await c.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost", 3000);
    expect(lost.params.reason).toBe("expired");
    expect(lost.params.leaseId).toBe(leaseId);

    provider.close(); c.close();
  });

  test("peripheral.release round-trip; renew after release sees not_found", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "release-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "releaser");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    const grant = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    const { leaseId, token } = grant.result;

    const release = await c.request(METHODS.peripheralRelease, { sessionId: created.sessionId, leaseId, token });
    expect(release.result).toEqual({ ok: true });

    const badRenew = await c.request(METHODS.peripheralRenew, { sessionId: created.sessionId, leaseId, token });
    expect(badRenew.result).toEqual({ code: "not_found" });

    provider.close(); c.close();
  });

  test("noop capability call round-trips through the real provider connection (call() -> peripheral_call_requested -> peripheral.respond)", async () => {
    const { AuditLog } = await import("../src/peripheral/audit");
    const { PeripheralBroker } = await import("../src/peripheral/broker");
    const { ProviderLink } = await import("../src/peripheral/provider-link");

    const home = mkdtempSync(join(tmpdir(), "norma-peripheral-call-"));
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const providerLink = new ProviderLink();
    const broker = new PeripheralBroker({
      audit, heartbeatMs: 1000, expiryMs: 5000, callTimeoutMs: 2000,
      policy: async () => "granted",
      emitTransient: () => {},
      pushToProvider: (e) => providerLink.push(e),
    });

    const store = new SessionStore(home);
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, peripheral: broker, providerLink });
    try {
      const p = await TestClient.connect(socketPath);
      await p.hello(tokens.harness, "call-provider");
      await p.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

      const grant = await broker.lease({ sessionId: "s_direct", class: "noop" });
      if (!("leaseId" in grant)) throw new Error(`expected a grant, got ${JSON.stringify(grant)}`);

      const callPromise = broker.call({ leaseId: grant.leaseId, token: grant.token, class: "noop", payloadJson: JSON.stringify({ ping: 1 }) });
      const requested = await p.waitForNotification((n) => n.method === METHODS.event && n.params.type === "peripheral_call_requested");
      expect(requested.params.leaseId).toBe(grant.leaseId);
      expect(requested.params.token).toBe(grant.token);
      expect(requested.params.class).toBe("noop");
      expect(JSON.parse(requested.params.payloadJson)).toEqual({ ping: 1 });

      await p.request(METHODS.peripheralRespond, {
        requestId: requested.params.requestId,
        resultJson: JSON.stringify({ echo: { ping: 1 } }),
      });

      const callResult = await callPromise;
      expect("ok" in callResult && callResult.ok).toBe(true);
      if (!("ok" in callResult) || !callResult.ok) throw new Error(`expected ok, got ${JSON.stringify(callResult)}`);
      expect(JSON.parse(callResult.resultJson)).toEqual({ echo: { ping: 1 } });

      p.close();
    } finally {
      server.stop();
    }
  });

  // Regression coverage for the daemon.ts emitTransient fix (Task 4 context: the provider
  // connection is rarely attached to the requester's session, so broadcastTransient's
  // session-scoped fan-out alone would never reach it). The provider here deliberately never
  // attaches to ANY session — it must still see lease_granted (on acquire) and lease_lost (on
  // release) so it can track its own active-lease set purely from these pushed events.
  test("provider connection receives lease_granted/lease_lost even when not attached to the leasing session", async () => {
    await boot();
    const provider = await TestClient.connect(daemon.socketPath);
    await provider.hello(harnessToken, "unattached-provider");
    await provider.request(METHODS.peripheralAdvertise, { classes: [{ class: "noop", tccGranted: true }] });

    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "leaser-elsewhere");
    const { result: created } = await c.request(METHODS.sessionCreate, { scope: "global", approvalPolicy: "auto" });
    // Deliberately no sessionAttach for either connection — the provider must still be told.

    const res = await c.request(METHODS.peripheralLease, { sessionId: created.sessionId, class: "noop" });
    expect(res.result.leaseId).toBeTruthy();

    const granted = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_granted");
    expect(granted.params.leaseId).toBe(res.result.leaseId);
    expect(granted.params.holder).toEqual({ kind: "session", id: created.sessionId });

    const rel = await c.request(METHODS.peripheralRelease, { sessionId: created.sessionId, leaseId: res.result.leaseId, token: res.result.token });
    expect(rel.result).toEqual({ ok: true });

    const lost = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "lease_lost");
    expect(lost.params.leaseId).toBe(res.result.leaseId);
    expect(lost.params.reason).toBe("released");

    provider.close(); c.close();
  });

  // -----------------------------------------------------------------------------------------
  // Dashboard read methods (Phase 2f): daemon.status, quota.state, trust.list, trust.remove.
  // -----------------------------------------------------------------------------------------

  test("trust.list / trust.remove over the socket", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "trust-lister");
    const dirA = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-a-")));
    const dirB = realpathSync(mkdtempSync(join(tmpdir(), "norma-trust-b-")));
    await c.request(METHODS.trustDir, { path: dirA });
    await c.request(METHODS.trustDir, { path: dirB });

    const list1 = (await c.request(METHODS.trustList, {})).result;
    expect(list1.dirs).toContain(dirA);
    expect(list1.dirs).toContain(dirB);

    const removed = (await c.request(METHODS.trustRemove, { path: dirA })).result;
    expect(removed).toEqual({ removed: true });

    const list2 = (await c.request(METHODS.trustList, {})).result;
    expect(list2.dirs).not.toContain(dirA);
    expect(list2.dirs).toContain(dirB);

    const removedAgain = (await c.request(METHODS.trustRemove, { path: dirA })).result;
    expect(removedAgain).toEqual({ removed: false });

    c.close();
  });

  test("daemon.status shape (no provider): version/uptimeMs/socketPath/provider:null/sessionsCount/pluginsCount", async () => {
    await boot(); // no provider → no engine
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "status-checker");
    await c.request(METHODS.sessionCreate, { scope: "global" });
    const status = (await c.request(METHODS.daemonStatus, {})).result;
    expect(status.version).toBe(CORE_VERSION);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.socketPath).toBe(daemon.socketPath);
    expect(status.provider).toBeNull();
    expect(status.sessionsCount).toBe(1);
    expect(status.pluginsCount).toBe(0);
    c.close();
  });

  test("daemon.status reports the active provider's id/model when an agent is configured", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    await boot({}, fake);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "status-provider-checker");
    const status = (await c.request(METHODS.daemonStatus, {})).result;
    expect(status.provider).toEqual({ id: "fake", model: "fake-1" });
    c.close();
  });

  test("daemon.status pluginsCount reflects the real installed-plugin count (Phase 4d-i Task 4 — was hardcoded 0)", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-daemon-status-plugins-"));
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(home, "plugins", name), { recursive: true });
      writeFileSync(join(home, "plugins", name, "plugin.json"), JSON.stringify({ description: name }));
    }
    const plugins = new PluginStore({ normaHome: home });
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, plugins });
    try {
      const c = await TestClient.connect(socketPath);
      await c.hello(tokens.harness, "status-plugins-count");
      const status = (await c.request(METHODS.daemonStatus, {})).result;
      expect(status.pluginsCount).toBe(3);
      c.close();
    } finally {
      server.stop();
    }
  });

  test("quota.state shape: ok/zero usage when no real provider-wrapped QuotaManager is wired", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "quota-checker");
    const q = (await c.request(METHODS.quotaState, {})).result;
    expect(q).toEqual({ kind: "ok", inputTokens: 0, outputTokens: 0 });
    c.close();
  });

  // Sparkle T2: engine.activity is the update idle gate's poll — activeTurns off
  // AgentEngine.runningTurns, same accessor engine-activity.test.ts exercises directly. Here we
  // only need the idle (0) shape over the wire; the 0->1->0 transition is covered engine-side.
  test("engine.activity reports zero active turns when idle", async () => {
    const { FakeProvider } = await import("../src/agent/fake-provider");
    await boot({}, new FakeProvider([[{ type: "done", stopReason: "end_turn" }]]));
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "activity-checker");
    const r = (await c.request(METHODS.engineActivity, {})).result;
    expect(r.activeTurns).toBe(0);
    c.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 4b Task 2: role→method allowlist for plugin connections (spec §3) + plugin.revokeToken.
  // ---------------------------------------------------------------------------------------------
  describe("plugin role method allowlist", () => {
    async function setup(pluginId = "sample-echo"): Promise<{
      srv: Awaited<ReturnType<typeof bootPluginTestServer>>; plugin: TestClient;
    }> {
      const srv = await bootPluginTestServer();
      const raw = srv.store.mintPluginToken(pluginId);
      const plugin = await TestClient.connect(srv.socketPath);
      const hello = await plugin.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: pluginId, pluginId,
      });
      if (!hello.result?.ok) throw new Error(`test setup: plugin hello failed: ${JSON.stringify(hello.error)}`);
      return { srv, plugin };
    }

    test("the seven allowed verbs pass the role gate — never role-rejected (every handler rejects empty {} params as INVALID_PARAMS instead, which proves dispatch reached the handler, not the allowlist)", async () => {
      const { srv, plugin } = await setup();
      for (const method of [
        METHODS.pluginRegister, METHODS.toolRegister, METHODS.shortcutRegister,
        METHODS.tileUpdate, METHODS.providerRegister, METHODS.pluginToolResult,
        METHODS.hardwareRequest,
      ]) {
        const res = await plugin.request(method, {});
        expect(res.error?.code).not.toBe(ERR.UNAUTHORIZED);
      }
      plugin.close(); srv.stop();
    });

    // Phase 4c Task 1 (spec §5): hardware.respond is deliberately NOT on the plugin allowlist —
    // only the active provider connection (Norma.app) may answer a hardware_requested push, same
    // precedent as peripheral.respond. A plugin connection calling it is role-rejected before
    // dispatch ever reaches the (Task 2) handler.
    test("hardware.respond from a plugin connection is role-rejected — provider-only, not one of the seven plugin verbs", async () => {
      const { srv, plugin } = await setup();
      const res = await plugin.request(METHODS.hardwareRespond, { requestId: "req_1", resultJson: "{}" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      expect(res.error?.message).toMatch(/plugin role may not call/);
      plugin.close(); srv.stop();
    });

    test("a representative set of everything else — incl. approval.respond and session.send — is role-rejected before dispatch", async () => {
      const { srv, plugin } = await setup();
      const attempts: Array<[string, unknown]> = [
        [METHODS.sessionSend, { sessionId: "s_x", text: "hi" }],
        [METHODS.sessionCreate, { scope: "global" }],
        [METHODS.sessionList, {}],
        [METHODS.sessionAttach, { sessionId: "s_x" }],
        [METHODS.approvalRespond, { sessionId: "s_x", callId: "c_x", approved: true }],
        [METHODS.askUserRespond, { sessionId: "s_x", callId: "c_x", answers: {} }],
        [METHODS.peripheralLease, { sessionId: "s_x", class: "noop" }],
        [METHODS.peripheralAdvertise, { classes: [] }],
        [METHODS.daemonStatus, {}],
        [METHODS.trustList, {}],
        [METHODS.trustRemove, { path: "/tmp" }],
        [METHODS.pluginsList, {}],
        // CC-parity phase 3 (Workflows, Track C Task C2): local-only in v1 (Global Constraints) —
        // never added to PLUGIN_ALLOWED_METHODS.
        [METHODS.workflowList, { sessionId: "s_x" }],
        [METHODS.workflowRun, { sessionId: "s_x", script: "return 1;" }],
        [METHODS.workflowStop, { runId: "wf_x" }],
        [METHODS.workflowGet, { runId: "wf_x" }],
      ];
      for (const [method, params] of attempts) {
        const res = await plugin.request(method, params);
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      }
      plugin.close(); srv.stop();
    });

    // Phase 4b Task 4: now that plugin.register is wired, a harness connection reaching it is
    // rejected for a DIFFERENT reason than an allowlist rejection — the allowlist only restricts
    // plugin-role connections (never widens who else may call these six), so dispatch reaches the
    // handler; the handler's OWN identity check then fails closed because a harness connection's
    // `socket.data.pluginId` is always null (only a role:"plugin" hello ever sets it), which can
    // never match any wire `pluginId`. The message text (not just the code) distinguishes this from
    // the allowlist's own UNAUTHORIZED rejection, proving it's the handler, not the gate above it.
    test("plugin.register from a HARNESS connection is not role-rejected by the allowlist — it fails the handler's own pluginId-match check instead", async () => {
      const srv = await bootPluginTestServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "harness-trying-plugin-verb");
      const res = await c.request(METHODS.pluginRegister, { pluginId: "sample-echo" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      expect(res.error?.message).not.toMatch(/plugin role may not call/); // proves it wasn't the allowlist gate
      expect(res.error?.message).toContain("pluginId does not match");
      c.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // Hardware helper (Phase 4c Task 2, spec §5): plugin (or harness, dev/testing) → core →
  // Norma.app's XPC helper, via HardwareBroker + the SAME ProviderLink/PeripheralBroker.isProvider
  // gate peripheral.respond uses. Constructed directly here (AuditLog/PeripheralBroker/
  // ProviderLink/HardwareBroker/PluginStore), mirroring daemon.ts's own wiring exactly — same
  // precedent as "plugin tool bridge (Task 4)"'s bootBridgeServer and the "noop capability call
  // round-trips" test's inline PeripheralBroker/ProviderLink construction above.
  // -----------------------------------------------------------------------------------------
  describe("hardware.request / hardware.respond (Phase 4c Task 2, spec §5)", () => {
    async function bootHardwareServer(opts: {
      consents?: Record<string, { exec?: number; tcc?: number; hardware?: number }>;
      timeoutMs?: number;
    } = {}): Promise<{
      store: SessionStore; socketPath: string; harnessToken: string; home: string; stop: () => void;
    }> {
      const { AuditLog } = await import("../src/peripheral/audit");
      const { PeripheralBroker } = await import("../src/peripheral/broker");
      const { ProviderLink } = await import("../src/peripheral/provider-link");
      const { HardwareBroker } = await import("../src/peripheral/hardware");

      const home = mkdtempSync(join(tmpdir(), "norma-hardware-ipc-"));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();

      const audit = new AuditLog(join(home, "audit.jsonl"));
      const providerLink = new ProviderLink();
      // peripheral is wired ONLY so hardware.respond's isProvider() gate has something to check
      // against (ipc/server.ts reuses PeripheralBroker's provider-identity tracking) — no lease
      // machinery is exercised by these tests.
      const peripheral = new PeripheralBroker({
        audit, policy: async () => "granted", emitTransient: () => {},
        pushToProvider: (e) => providerLink.push(e),
      });
      const hardware = new HardwareBroker({
        audit, pushToProvider: (e) => providerLink.push(e), timeoutMs: opts.timeoutMs ?? 500,
      });
      const plugins = new PluginStore({ normaHome: home, consents: opts.consents });

      // Phase 4d-ii Task 2: `normaHome` wired (harmless for every EXISTING test here — no
      // settings.json exists at `home` unless a test writes one, so `livePlugins()`'s
      // `loadSettings` throws and it falls back to the `plugins` snapshot above, same as before
      // this change) — lets a dedicated regression test below prove `plugin.setConsent`'s hardware
      // grant is honored by `hardware.request` immediately, without a restart.
      const server = startIpcServer({
        socketPath, serverVersion: "test", tokens: authority, store, peripheral, providerLink, hardware, plugins,
        normaHome: home,
      });
      return {
        store, socketPath, harnessToken: tokens.harness, home,
        stop: () => { server.stop(); store.close(); },
      };
    }

    function seedBatteryPlugin(home: string, pluginId: string, permissions: { hardware?: string[] } = { hardware: ["battery"] }): void {
      mkdirSync(join(home, "plugins", pluginId), { recursive: true });
      writeFileSync(join(home, "plugins", pluginId, "norma-plugin.json"), JSON.stringify({
        id: pluginId, tier: "capability", permissions,
      }));
    }

    async function connectPlugin(store: SessionStore, socketPath: string, pluginId: string): Promise<TestClient> {
      const raw = store.mintPluginToken(pluginId);
      const c = await TestClient.connect(socketPath);
      const hello = await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: pluginId, pluginId,
      });
      if (!hello.result?.ok) throw new Error(`test setup: plugin hello failed: ${JSON.stringify(hello.error)}`);
      return c;
    }

    /** Connects a harness connection and advertises it as THE provider (peripheral.advertise —
     *  same connection ProviderLink then routes hardware_requested pushes to). */
    async function connectProvider(socketPath: string, harnessToken: string, clientName = "hw-provider"): Promise<TestClient> {
      const p = await TestClient.connect(socketPath);
      await p.hello(harnessToken, clientName);
      await p.request(METHODS.peripheralAdvertise, { classes: [] });
      return p;
    }

    test("no provider connected → typed no_provider (plugin caller, fully consented)", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "no_provider", message: "hardware features require Norma.app" });

      plugin.close(); srv.stop();
    });

    test("consented plugin round-trip: scripted provider answers hardware.request via hardware_requested/hardware.respond", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const provider = await connectProvider(srv.socketPath, srv.harnessToken);
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const reqPromise = plugin.request(METHODS.hardwareRequest, { verb: "setChargeLimit", argsJson: '{"percent":80}' });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "hardware_requested");
      expect(pushed.params.verb).toBe("setChargeLimit");
      expect(pushed.params.argsJson).toBe('{"percent":80}');

      const respond = await provider.request(METHODS.hardwareRespond, {
        requestId: pushed.params.requestId, resultJson: '{"percent":80}',
      });
      expect(respond.result).toEqual({ ok: true });

      const res = await reqPromise;
      expect(res.result).toEqual({ resultJson: '{"percent":80}' });

      provider.close(); plugin.close(); srv.stop();
    });

    test("unconsented plugin (manifest declares battery, but no hardware consent record) → typed consent_denied naming the missing consent class", async () => {
      const srv = await bootHardwareServer(); // no consents at all
      seedBatteryPlugin(srv.home, "battery-limiter");
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "hardware" });

      plugin.close(); srv.stop();
    });

    test("Phase 4d-ii Task 2 regression: plugin.setConsent hot-grants hardware consent — a live plugin's hardware.request sees it immediately, no restart required", async () => {
      const srv = await bootHardwareServer(); // no consents at all
      seedBatteryPlugin(srv.home, "battery-limiter");
      writeFileSync(join(srv.home, "settings.json"), JSON.stringify({
        schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" },
      }));
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const denied = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(denied.result).toEqual({ code: "consent_denied", missing: "hardware" });

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "cli-setconsent-hw");
      const setConsent = await harness.request(METHODS.pluginSetConsent, { name: "battery-limiter", classes: ["hardware"] });
      expect(setConsent.result).toEqual({ ok: true });

      const provider = await connectProvider(srv.socketPath, srv.harnessToken, "hw-provider-2");
      const reqPromise = plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "hardware_requested");
      await provider.request(METHODS.hardwareRespond, { requestId: pushed.params.requestId, resultJson: '{"percent":80}' });
      const res = await reqPromise;
      expect(res.result).toEqual({ resultJson: '{"percent":80}' }); // no longer consent_denied — hot-granted, no restart

      harness.close(); provider.close(); plugin.close(); srv.stop();
    });

    test("unconsented plugin (consented, but manifest doesn't declare the battery permission) → typed consent_denied naming the missing permission class", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter", {}); // permissions.hardware omitted entirely
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "battery" });

      plugin.close(); srv.stop();
    });

    test("a plugin with no PluginStore record at all (never installed) → typed consent_denied, fails closed", async () => {
      const srv = await bootHardwareServer();
      const plugin = await connectPlugin(srv.store, srv.socketPath, "ghost-plugin"); // no plugins/ghost-plugin dir at all
      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "battery" });
      plugin.close(); srv.stop();
    });

    test("unknown verb from a fully consented plugin → typed unknown_verb, bypassing consent entirely", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "setFanSpeed" });
      expect(res.result).toEqual({ code: "unknown_verb" });

      plugin.close(); srv.stop();
    });

    test("timeout: the provider is connected but never answers → typed timeout after the configured budget", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } }, timeoutMs: 50 });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const provider = await connectProvider(srv.socketPath, srv.harnessToken);
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "timeout" });

      provider.close(); plugin.close(); srv.stop();
    });

    test("hardware.respond from a non-provider connection is rejected; the real provider connection can respond", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const provider = await connectProvider(srv.socketPath, srv.harnessToken, "real-provider");
      const impostor = await TestClient.connect(srv.socketPath);
      await impostor.hello(srv.harnessToken, "impostor");

      const impostorRespond = await impostor.request(METHODS.hardwareRespond, { requestId: "req_whatever" });
      expect(impostorRespond.error?.code).toBe(ERR.UNAUTHORIZED);

      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");
      const reqPromise = plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "hardware_requested");
      const ok = await provider.request(METHODS.hardwareRespond, { requestId: pushed.params.requestId, resultJson: "{}" });
      expect(ok.result).toEqual({ ok: true });
      expect((await reqPromise).result).toEqual({ resultJson: "{}" });

      provider.close(); impostor.close(); plugin.close(); srv.stop();
    });

    test("harness-role caller skips consent entirely and round-trips; audited with a {kind:'harness'} requester", async () => {
      const srv = await bootHardwareServer(); // no PluginStore consents seeded at all
      const provider = await connectProvider(srv.socketPath, srv.harnessToken);
      const dev = await TestClient.connect(srv.socketPath);
      await dev.hello(srv.harnessToken, "dev-cli");

      const reqPromise = dev.request(METHODS.hardwareRequest, { verb: "setChargeLimit", argsJson: '{"percent":100}' });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "hardware_requested");
      await provider.request(METHODS.hardwareRespond, { requestId: pushed.params.requestId, resultJson: '{"percent":100}' });
      expect((await reqPromise).result).toEqual({ resultJson: '{"percent":100}' });

      const auditLines = readFileSync(join(srv.home, "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const hwLine = auditLines.find((l) => l.kind === "hardware" && l.verb === "setChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "setChargeLimit", requester: { kind: "harness", id: "dev-cli" },
        outcome: { resultJson: '{"percent":100}' },
      });
      expect(typeof hwLine.ts).toBe("number");

      provider.close(); dev.close(); srv.stop();
    });

    test("audit trail: a consented plugin's round-trip is audited with a {kind:'plugin'} requester naming the pluginId", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const provider = await connectProvider(srv.socketPath, srv.harnessToken);
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const reqPromise = plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      const pushed = await provider.waitForNotification((n) => n.method === METHODS.event && n.params.type === "hardware_requested");
      await provider.request(METHODS.hardwareRespond, { requestId: pushed.params.requestId, resultJson: '{"percent":80}' });
      await reqPromise;

      const auditLines = readFileSync(join(srv.home, "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const hwLine = auditLines.find((l) => l.kind === "hardware" && l.verb === "getChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "getChargeLimit", requester: { kind: "plugin", id: "battery-limiter" },
        outcome: { resultJson: '{"percent":80}' },
      });

      provider.close(); plugin.close(); srv.stop();
    });

    test("audit trail: unconsented plugin's denied request lands an audit line with consent_denied outcome", async () => {
      const srv = await bootHardwareServer(); // no consents at all
      seedBatteryPlugin(srv.home, "battery-limiter");
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "getChargeLimit" });
      expect(res.result).toEqual({ code: "consent_denied", missing: "hardware" });

      const auditLines = readFileSync(join(srv.home, "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const hwLine = auditLines.find((l) => l.kind === "hardware" && l.verb === "getChargeLimit");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "getChargeLimit", requester: { kind: "plugin", id: "battery-limiter" },
        outcome: { code: "consent_denied", missing: "hardware" },
      });
      expect(typeof hwLine.ts).toBe("number");

      plugin.close(); srv.stop();
    });

    test("audit trail: unknown_verb from a plugin lands an audit line with unknown_verb outcome", async () => {
      const srv = await bootHardwareServer({ consents: { "battery-limiter": { hardware: Date.now() } } });
      seedBatteryPlugin(srv.home, "battery-limiter");
      const plugin = await connectPlugin(srv.store, srv.socketPath, "battery-limiter");

      const res = await plugin.request(METHODS.hardwareRequest, { verb: "setFanSpeed" });
      expect(res.result).toEqual({ code: "unknown_verb" });

      const auditLines = readFileSync(join(srv.home, "audit.jsonl"), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      const hwLine = auditLines.find((l) => l.kind === "hardware" && l.verb === "setFanSpeed");
      expect(hwLine).toMatchObject({
        kind: "hardware", verb: "setFanSpeed", requester: { kind: "plugin", id: "battery-limiter" },
        outcome: { code: "unknown_verb" },
      });
      expect(typeof hwLine.ts).toBe("number");

      plugin.close(); srv.stop();
    });
  });

  describe("plugin.revokeToken", () => {
    test("harness role revokes a plugin's token; a subsequent plugin hello with the old raw token fails closed", async () => {
      const srv = await bootPluginTestServer();
      const raw = srv.store.mintPluginToken("sample-echo");
      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "cli-plugin-disable");
      const revoke = await harness.request(METHODS.pluginRevokeToken, { pluginId: "sample-echo" });
      expect(revoke.result).toEqual({ ok: true });

      const c = await TestClient.connect(srv.socketPath);
      const hello = await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
      });
      expect(hello.error.code).toBe(ERR.UNAUTHORIZED);
      harness.close(); c.close(); srv.stop();
    });

    test("revoking a never-minted plugin id is a no-op success (idempotent — disable/remove call this unconditionally)", async () => {
      const srv = await bootPluginTestServer();
      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "cli-plugin-disable");
      const res = await harness.request(METHODS.pluginRevokeToken, { pluginId: "never-existed" });
      expect(res.result).toEqual({ ok: true });
      harness.close(); srv.stop();
    });

    test("plugin.revokeToken requires harness role — a plugin connection is role-rejected (it's not one of the six verbs)", async () => {
      const srv = await bootPluginTestServer();
      const raw = srv.store.mintPluginToken("sample-echo");
      const c = await TestClient.connect(srv.socketPath);
      await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
      });
      const res = await c.request(METHODS.pluginRevokeToken, { pluginId: "sample-echo" });
      expect(res.error.code).toBe(ERR.UNAUTHORIZED);
      c.close(); srv.stop();
    });

    test("an admin-role connection is also rejected (harness-only, same precedent as trust.remove)", async () => {
      const srv = await bootPluginTestServer();
      const admin = await TestClient.connect(srv.socketPath);
      await admin.hello(srv.adminToken, "admin-conn", "admin");
      const res = await admin.request(METHODS.pluginRevokeToken, { pluginId: "sample-echo" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      admin.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // plugin.restart (final-review Fix 1): PluginSupervisor.restart() existed and was unit-tested
  // (test/plugins/supervisor.test.ts) but had no IPC caller — wired here against a REAL supervisor
  // (fake spawn/isAlivePid/signalPid, same injection precedent as "plugin tool bridge (Task 4)"
  // below) so a circuit-open plugin can actually be driven and observed re-spawning through the
  // wire, not just through the supervisor's own direct API.
  // -----------------------------------------------------------------------------------------
  describe("plugin.restart", () => {
    async function bootRestartServer(): Promise<{
      store: SessionStore; socketPath: string; harnessToken: string; adminToken: string;
      supervisor: PluginSupervisor; stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "norma-plugin-restart-"));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      let nextPid = 7000;
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"),
        socketPath,
        mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: nextPid++, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false,
        signalPid: () => {},
        // registrationTimeoutMs + circuitFailures:1 drives a fresh spawn straight to circuit-open
        // (the fake process never registers) fast — same recipe as
        // supervisor.test.ts's "restart() (manual restart rider)" describe block.
        settings: { registrationTimeoutMs: 10, backoffCapMs: 10, circuitFailures: 1, circuitWindowMs: 600_000 },
      });
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, supervisor });
      return {
        store, socketPath, harnessToken: tokens.harness, adminToken: tokens.admin, supervisor,
        stop: () => { supervisor.stopAll(); server.stop(); store.close(); },
      };
    }

    test("harness role restarts a circuit-open plugin — it respawns", async () => {
      const srv = await bootRestartServer();
      const pluginId = "sample-echo";
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun" } }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.supervisor.status(pluginId)).toBe("circuit-open");

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "cli-plugin-restart");
      const res = await harness.request(METHODS.pluginRestart, { pluginId });
      expect(res.result).toEqual({ ok: true });
      expect(srv.supervisor.status(pluginId)).toBe("starting"); // respawned — no longer stuck

      harness.close(); srv.stop();
    });

    test("an admin-role connection may also restart (harness/admin, like plugins.list — unlike plugin.revokeToken's harness-only gate)", async () => {
      const srv = await bootRestartServer();
      const pluginId = "sample-echo";
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun" } }]);
      await new Promise((r) => setTimeout(r, 50));
      expect(srv.supervisor.status(pluginId)).toBe("circuit-open");

      const admin = await TestClient.connect(srv.socketPath);
      await admin.hello(srv.adminToken, "admin-restart", "admin");
      const res = await admin.request(METHODS.pluginRestart, { pluginId });
      expect(res.result).toEqual({ ok: true });
      expect(srv.supervisor.status(pluginId)).toBe("starting");

      admin.close(); srv.stop();
    });

    test("restarting an unknown plugin id -> typed NOT_FOUND, never a crash", async () => {
      const srv = await bootRestartServer();
      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "cli-plugin-restart");
      const res = await harness.request(METHODS.pluginRestart, { pluginId: "never-existed" });
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      harness.close(); srv.stop();
    });

    test("plugin.restart is not one of the six plugin-role verbs — a plugin connection is role-rejected before dispatch", async () => {
      const srv = await bootRestartServer();
      const raw = srv.store.mintPluginToken("sample-echo");
      const c = await TestClient.connect(srv.socketPath);
      await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
      });
      const res = await c.request(METHODS.pluginRestart, { pluginId: "sample-echo" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      c.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // Plugin lifecycle RPCs (Phase 4d-ii Task 2): plugins.install/plugin.enable/disable/remove/
  // setConsent applied HOT to the running daemon — no restart, unlike the CLI's file-based flow.
  // A real PluginSupervisor (fake spawn/isAlivePid/signalPid, same injection precedent as
  // "plugin.restart"/"plugins.list supervisor status" above) + `normaHome` wired so the RPC
  // handlers can read/write settings.json and the plugins directory directly.
  // -----------------------------------------------------------------------------------------
  describe("plugin lifecycle RPCs (Task 2)", () => {
    async function bootLifecycleServer(): Promise<{
      home: string; settingsPath: string; pluginsRoot: string;
      store: SessionStore; socketPath: string; harnessToken: string;
      supervisor: PluginSupervisor; stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "norma-plugin-lifecycle-"));
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" },
      }));
      // A Tier-2 (platform) plugin with an `entry` — requiredConsentClasses derives "exec" for
      // any manifest with an entry point (plugin-manifest.ts), so this plugin always starts out
      // needing consent, exercising the two-step enable flow below.
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "norma-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      const plugins = new PluginStore({ normaHome: home });
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"),
        socketPath,
        mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: 9001, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false,
        signalPid: () => {},
      });
      // A ToolRegistry represents "this daemon has an agent runtime configured" (daemon.ts only
      // builds one inside `if (agentProvider)`) — hotApplyStart (ipc/server.ts) now gates the real
      // hot-spawn on `opts.registry`, not just `opts.supervisor` (which Phase 4d-cleanup Task 2
      // made always-present for the orphan sweep). This suite's tests (b)/(c)/(e) exercise a
      // provider-configured daemon's hot-start/hot-stop lifecycle, so a registry is wired here to
      // match — the dedicated no-provider case (registry omitted) is covered separately above.
      const registry = new ToolRegistry();
      const server = startIpcServer({
        socketPath, serverVersion: "test", tokens: authority, store, plugins, supervisor, registry, normaHome: home,
      });
      return {
        home, settingsPath: join(home, "settings.json"), pluginsRoot: join(home, "plugins"),
        store, socketPath, harnessToken: tokens.harness, supervisor,
        stop: () => { supervisor.stopAll(); server.stop(); store.close(); },
      };
    }

    test("(a) plugin.enable with outstanding consents and no `consent` flag -> needs_consent, settings UNCHANGED", async () => {
      const srv = await bootLifecycleServer();
      const before = readFileSync(srv.settingsPath, "utf8");
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-enable");

      const res = await c.request(METHODS.pluginEnable, { name: "runner" });
      expect(res.result.code).toBe("needs_consent");
      expect(res.result.requiredConsents).toEqual(["exec"]);
      expect(res.result.consentBlock[0]).toBe("plugin runner requests:");
      expect(res.result.consentBlock).toContain("entry: bun index.ts");
      expect(readFileSync(srv.settingsPath, "utf8")).toBe(before); // no mutation

      c.close(); srv.stop();
    });

    test("(b) plugin.enable {consent:true} grants consent, enables, hot-starts via the supervisor, and plugins.list reflects it", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-enable-consent");

      const res = await c.request(METHODS.pluginEnable, { name: "runner", consent: true });
      expect(res.result.ok).toBe(true);
      expect(res.result.status).toBe("starting"); // hot-spawned NOW, awaiting registration
      expect(srv.supervisor.status("runner")).toBe("starting"); // same supervisor instance — proves the RPC actually reached it

      const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
      expect(settings.plugins.enabled).toEqual(["runner"]);
      expect(settings.plugins.consents.runner.exec).toBeGreaterThan(0);

      const list = await c.request(METHODS.pluginsList, {});
      const runner = list.result.plugins.find((p: any) => p.name === "runner");
      expect(runner).toMatchObject({ disabled: false, mcpEnabled: true, status: "starting" });
      expect(runner.consented).toEqual(["exec"]);

      c.close(); srv.stop();
    });

    test("(c) plugin.disable strips `enabled`, strips consent, and hot-stops the running process", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-disable");
      await c.request(METHODS.pluginEnable, { name: "runner", consent: true });
      expect(srv.supervisor.status("runner")).toBe("starting");

      const res = await c.request(METHODS.pluginDisable, { name: "runner" });
      expect(res.result).toEqual({ ok: true });
      expect(srv.supervisor.status("runner")).toBe("stopped"); // hot-stop reached the running supervisor

      const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
      expect(settings.plugins.enabled).toEqual([]);
      expect(settings.plugins.disabled).toEqual(["runner"]);
      // Matches the CLI's `norma plugin disable` (main.ts, which composes
      // stripPluginConsents(setPluginEnabled(...))) and the design spec's fresh-consent semantics
      // (lifecycle.ts's stripPluginConsents doc, settings.ts:38-40): disable deletes the plugin's
      // whole consent record, so re-`plugin.enable` after a disable requires consenting again.
      expect(settings.plugins.consents?.runner).toBeUndefined();

      const list = await c.request(METHODS.pluginsList, {});
      expect(list.result.plugins.find((p: any) => p.name === "runner")).toMatchObject({ disabled: true, mcpEnabled: false });

      c.close(); srv.stop();
    });

    test("plugin.disable on an unknown plugin -> unknown_plugin", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-disable-unknown");
      const res = await c.request(METHODS.pluginDisable, { name: "ghost" });
      expect(res.result).toEqual({ code: "unknown_plugin" });
      c.close(); srv.stop();
    });

    test("(d) plugins.install copies a fixture dir and returns requiredConsents/hasMcp/consentBlock, never touching settings", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "norma-plugin-src-"));
      writeFileSync(join(src, "norma-plugin.json"), JSON.stringify({ id: "fresh", tier: "platform", entry: { command: "bun" } }));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install");

      const before = readFileSync(srv.settingsPath, "utf8");
      const res = await c.request(METHODS.pluginsInstall, { source: src, name: "fresh" });
      expect(res.result.ok).toBe(true);
      expect(res.result.name).toBe("fresh");
      expect(res.result.requiredConsents).toEqual(["exec"]);
      expect(res.result.hasMcp).toBe(false);
      expect(res.result.consentBlock[0]).toBe("plugin fresh requests:");
      expect(existsSync(join(srv.pluginsRoot, "fresh", "norma-plugin.json"))).toBe(true);
      expect(readFileSync(srv.settingsPath, "utf8")).toBe(before); // installed disabled+unconsented — settings untouched

      c.close(); srv.stop();
    });

    test("plugins.install derives the name from `source`'s basename when `name` is omitted", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "norma-plugin-derived-"));
      writeFileSync(join(src, "plugin.json"), JSON.stringify({ name: "derived" }));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install-derived");
      const derivedName = src.split("/").pop()!;

      const res = await c.request(METHODS.pluginsInstall, { source: src });
      expect(res.result.ok).toBe(true);
      expect(res.result.name).toBe(derivedName);
      expect(existsSync(join(srv.pluginsRoot, derivedName, "plugin.json"))).toBe(true);

      c.close(); srv.stop();
    });

    test("plugins.install on an already-installed name -> already_installed, no double copy", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "norma-plugin-src2-"));
      writeFileSync(join(src, "norma-plugin.json"), JSON.stringify({ id: "runner", tier: "capability" }));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install-dup");

      const res = await c.request(METHODS.pluginsInstall, { source: src, name: "runner" });
      expect(res.result).toEqual({ code: "already_installed", name: "runner" });
      // the pre-existing fixture (tier: platform) was never clobbered by the capability-tier source
      expect(JSON.parse(readFileSync(join(srv.pluginsRoot, "runner", "norma-plugin.json"), "utf8")).tier).toBe("platform");

      c.close(); srv.stop();
    });

    test("plugins.install on a source with no manifest -> invalid_source, nothing copied", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "norma-plugin-empty-"));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install-invalid");

      const res = await c.request(METHODS.pluginsInstall, { source: src, name: "nope" });
      expect(res.result).toEqual({ code: "invalid_source" });
      expect(existsSync(join(srv.pluginsRoot, "nope"))).toBe(false);

      c.close(); srv.stop();
    });

    test("(e) plugin.remove hot-stops, strips settings+consents, and deletes the plugin dir", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-remove");
      await c.request(METHODS.pluginEnable, { name: "runner", consent: true });
      expect(srv.supervisor.status("runner")).toBe("starting");

      const res = await c.request(METHODS.pluginRemove, { name: "runner" });
      expect(res.result).toEqual({ ok: true });
      expect(srv.supervisor.status("runner")).toBe("stopped"); // hot-stop reached the supervisor before the dir was deleted
      expect(existsSync(join(srv.pluginsRoot, "runner"))).toBe(false);

      const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
      expect(settings.plugins.enabled).toEqual([]);
      expect(settings.plugins.disabled).toEqual([]);
      expect(settings.plugins.consents).toEqual({});

      c.close(); srv.stop();
    });

    test("plugin.remove on an unknown plugin -> unknown_plugin, no crash", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-remove-unknown");
      const res = await c.request(METHODS.pluginRemove, { name: "ghost" });
      expect(res.result).toEqual({ code: "unknown_plugin" });
      c.close(); srv.stop();
    });

    test("plugin.setConsent grants a consent class without enabling", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-setconsent");

      const res = await c.request(METHODS.pluginSetConsent, { name: "runner", classes: ["exec"] });
      expect(res.result).toEqual({ ok: true });
      const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
      expect(settings.plugins.consents.runner.exec).toBeGreaterThan(0);
      expect(settings.plugins.enabled ?? []).not.toContain("runner");

      c.close(); srv.stop();
    });

    test("plugin.setConsent on an unknown plugin -> unknown_plugin", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-setconsent-unknown");
      const res = await c.request(METHODS.pluginSetConsent, { name: "ghost", classes: ["exec"] });
      expect(res.result).toEqual({ code: "unknown_plugin" });
      c.close(); srv.stop();
    });

    // -----------------------------------------------------------------------------------------
    // Phase 4d-cleanup Task 1: livePlugins() now caches the derived PluginInfo[] keyed on
    // settings.json's + the plugins dir's mtime, instead of re-deriving a fresh PluginStore().list()
    // (readdirSync + per-plugin loadManifest) on EVERY call — a hot path for `hardware.request`.
    // This proves the cache-HIT path: two `plugins.list` calls with no settings/plugin-dir write in
    // between only derive once. Not tautological — it spies on `node:fs`'s `readdirSync`, the REAL
    // I/O `PluginStore.list()` performs (agent/plugins.ts:79), and counts calls against the
    // PLUGINS ROOT specifically (list() also readdirSync's each plugin's own skills/ subdir, so a
    // raw total call count would over-count per plugin fixture) — if the cache were a no-op (always
    // re-deriving), this would see 2 root-dir listings, not 1.
    // -----------------------------------------------------------------------------------------
    test("livePlugins() cache-hit: two plugins.list calls with no settings/plugin-dir write between them only derive (readdirSync the plugins root) ONCE", async () => {
      const srv = await bootLifecycleServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cache-hit-check");

      const fs = await import("node:fs");
      const spy = spyOn(fs, "readdirSync");
      try {
        const first = await c.request(METHODS.pluginsList, {});
        expect(first.result.plugins).toHaveLength(1); // the "runner" fixture bootLifecycleServer seeds
        const second = await c.request(METHODS.pluginsList, {});
        expect(second.result).toEqual(first.result); // same settings-current view either way

        const rootListings = spy.mock.calls.filter((args) => args[0] === srv.pluginsRoot);
        expect(rootListings).toHaveLength(1); // the second call was served from cache — no re-derive
      } finally {
        spy.mockRestore();
      }

      c.close(); srv.stop();
    });

    test("(f) all five lifecycle RPCs are role-rejected for a plugin connection", async () => {
      const srv = await bootLifecycleServer();
      const raw = srv.store.mintPluginToken("runner");
      const c = await TestClient.connect(srv.socketPath);
      await c.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "runner", pluginId: "runner",
      });

      const calls: Array<[string, unknown]> = [
        [METHODS.pluginsInstall, { source: "/tmp/does-not-matter" }],
        [METHODS.pluginEnable, { name: "runner" }],
        [METHODS.pluginDisable, { name: "runner" }],
        [METHODS.pluginRemove, { name: "runner" }],
        [METHODS.pluginSetConsent, { name: "runner", classes: ["exec"] }],
      ];
      for (const [method, params] of calls) {
        const res = await c.request(method, params);
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      }

      c.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // Plugin tool bridge (Phase 4b Task 4, spec §3): plugin.register/tool.register/
  // plugin.toolResult wired to a real PluginSupervisor + ToolRegistry (constructed directly here,
  // mirroring daemon.ts's own wiring, exactly like the "noop capability call round-trips..." test
  // above constructs PeripheralBroker/ProviderLink directly instead of going through startDaemon);
  // shortcut.register/tile.update/provider.register wired to PluginContribRegistry.
  // -----------------------------------------------------------------------------------------
  describe("plugin tool bridge (Task 4)", () => {
    async function bootBridgeServer(): Promise<{
      store: SessionStore; socketPath: string; harnessToken: string;
      registry: ToolRegistry; supervisor: PluginSupervisor; contrib: PluginContribRegistry;
      stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "norma-plugin-bridge-"));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      const registry = new ToolRegistry();
      let nextPid = 9000;
      // Injected spawn/isAlivePid/signalPid — mirrors test/plugins/supervisor.test.ts's fixtures
      // (fakeProc/makeSpawnFn) so the supervisor's bookkeeping (PID files, backoff/circuit
      // failAttempt path) runs for real, but never touches an actual OS process. The "plugin
      // process" in every test below is really a scripted TestClient connecting over the real
      // socket — the fake spawn just gives the supervisor a runtime entry ("starting" status) for
      // plugin.register to transition out of.
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"),
        socketPath,
        mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: nextPid++, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false,
        signalPid: () => {},
        settings: { registrationTimeoutMs: 5000, backoffCapMs: 100, circuitFailures: 5, circuitWindowMs: 600_000 },
      });
      const contrib = new PluginContribRegistry();
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, registry, supervisor, contrib });
      return {
        store, socketPath, harnessToken: tokens.harness, registry, supervisor, contrib,
        stop: () => { supervisor.stopAll(); server.stop(); store.close(); },
      };
    }

    /** Spawns (fake) + hellos + plugin.registers a plugin connection — every test below starts
     *  from here, exactly mirroring the SDK's own hello → plugin.register sequence (Task 5). */
    async function registerAndHello(srv: Awaited<ReturnType<typeof bootBridgeServer>>, pluginId: string): Promise<TestClient> {
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun", args: ["index.ts"] } }]);
      const raw = srv.store.mintPluginToken(pluginId);
      const plugin = await TestClient.connect(srv.socketPath);
      const hello = await plugin.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: pluginId, pluginId,
      });
      if (!hello.result?.ok) throw new Error(`test setup: plugin hello failed: ${JSON.stringify(hello.error)}`);
      const reg = await plugin.request(METHODS.pluginRegister, { pluginId });
      expect(reg.result).toEqual({ ok: true });
      expect(srv.supervisor.status(pluginId)).toBe("running");
      return plugin;
    }

    test("register -> tool callable through registry.execute: round-trips to the plugin conn's plugin_tool_invoke and resolves via plugin.toolResult", async () => {
      const srv = await bootBridgeServer();
      const pluginId = "sample-echo";
      const plugin = await registerAndHello(srv, pluginId);

      const toolReg = await plugin.request(METHODS.toolRegister, { name: "echo", description: "echoes text back" });
      expect(toolReg.result.ok).toBe(true);
      expect(toolReg.result.registeredAs).toBe(`plugin__${pluginId}__echo`);
      expect(srv.registry.has(toolReg.result.registeredAs)).toBe(true);

      const execPromise = srv.registry.execute(
        toolReg.result.registeredAs,
        { text: "hi" },
        { cwd: "/", roots: ["/"], sessionId: "s1" },
      );

      const invoked = await plugin.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plugin_tool_invoke");
      expect(invoked.params.tool).toBe("echo");
      expect(JSON.parse(invoked.params.argsJson)).toEqual({ text: "hi" });

      const resolved = await plugin.request(METHODS.pluginToolResult, {
        requestId: invoked.params.requestId,
        resultJson: JSON.stringify({ echo: "hi" }),
      });
      expect(resolved.result).toEqual({ ok: true });

      const outcome = await execPromise;
      expect(outcome.isError).toBe(false);
      expect(JSON.parse(outcome.output)).toEqual({ echo: "hi" });

      plugin.close(); srv.stop();
    });

    test("a plugin's raw JSON schema rides verbatim as rawParameters (like MCP)", async () => {
      const srv = await bootBridgeServer();
      const plugin = await registerAndHello(srv, "sample-echo");
      const schema = { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] };
      const toolReg = await plugin.request(METHODS.toolRegister, { name: "sleep", description: "sleeps", parameters: schema });
      const spec = srv.registry.specFor(toolReg.result.registeredAs);
      expect(spec?.parameters).toEqual(schema);
      plugin.close(); srv.stop();
    });

    test("plugin crash mid-invoke (connection drop) -> the in-flight call resolves as a typed isError naming the plugin+tool, and its tools are unregistered", async () => {
      const srv = await bootBridgeServer();
      const pluginId = "sample-echo";
      const plugin = await registerAndHello(srv, pluginId);
      const toolReg = await plugin.request(METHODS.toolRegister, { name: "sleep", description: "sleeps" });
      const registeredAs = toolReg.result.registeredAs;
      expect(srv.registry.has(registeredAs)).toBe(true);

      const execPromise = srv.registry.execute(registeredAs, {}, { cwd: "/", roots: ["/"], sessionId: "s1" });
      await plugin.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plugin_tool_invoke");

      plugin.close(); // simulate the plugin process disappearing mid-call

      const outcome = await execPromise;
      expect(outcome.isError).toBe(true);
      expect(outcome.output).toBe(`plugin ${pluginId} crashed during sleep`);

      // the socket close() handler's unregister is synchronous with the close event, but give the
      // event loop a beat to be safe against any scheduling jitter.
      await new Promise((r) => setTimeout(r, 20));
      expect(srv.registry.has(registeredAs)).toBe(false);
      expect(srv.supervisor.status(pluginId)).not.toBe("running");

      srv.stop();
    });

    test("plugin.register requires the wire pluginId to match the authenticated connection", async () => {
      const srv = await bootBridgeServer();
      srv.supervisor.startAll([{ id: "sample-echo", dir: "/plugins/sample-echo", entry: { command: "bun" } }]);
      const raw = srv.store.mintPluginToken("sample-echo");
      const plugin = await TestClient.connect(srv.socketPath);
      await plugin.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
      });
      const res = await plugin.request(METHODS.pluginRegister, { pluginId: "someone-else" });
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      expect(srv.supervisor.status("sample-echo")).toBe("starting"); // never flipped to running
      plugin.close(); srv.stop();
    });

    test("tool.register rejects a duplicate tool name with a typed error, not a crash", async () => {
      const srv = await bootBridgeServer();
      const plugin = await registerAndHello(srv, "sample-echo");
      const first = await plugin.request(METHODS.toolRegister, { name: "dup", description: "d" });
      expect(first.result.ok).toBe(true);
      const second = await plugin.request(METHODS.toolRegister, { name: "dup", description: "d" });
      expect(second.error).toBeTruthy();
      expect(second.error.message).toContain("duplicate tool");
      plugin.close(); srv.stop();
    });

    test("tool.register rejects a \"__\"-bearing (or otherwise unsafe-charset) name with INVALID_PARAMS (final-review Fix 3)", async () => {
      const srv = await bootBridgeServer();
      const plugin = await registerAndHello(srv, "sample-echo");
      const collateral = await plugin.request(METHODS.toolRegister, { name: "evil__collateral", description: "d" });
      expect(collateral.error?.code).toBe(ERR.INVALID_PARAMS);
      const spacey = await plugin.request(METHODS.toolRegister, { name: "has space", description: "d" });
      expect(spacey.error?.code).toBe(ERR.INVALID_PARAMS);
      // a safe name still registers fine — this isn't a blanket tool.register regression.
      const ok = await plugin.request(METHODS.toolRegister, { name: "safe-name_ok", description: "d" });
      expect(ok.result?.ok).toBe(true);
      plugin.close(); srv.stop();
    });

    test("shortcut.register/tile.update/provider.register land in PluginContribRegistry (latest write wins)", async () => {
      const srv = await bootBridgeServer();
      const plugin = await registerAndHello(srv, "sample-echo");

      await plugin.request(METHODS.shortcutRegister, { shortcuts: [{ id: "toggle", description: "toggle it" }] });
      await plugin.request(METHODS.tileUpdate, { tile: { title: "Sample", value: "1" } });
      await plugin.request(METHODS.providerRegister, { info: { kind: "noop" } });

      const state = srv.contrib.get("sample-echo");
      expect(state?.shortcuts).toEqual([{ id: "toggle", description: "toggle it" }]);
      expect(state?.tile).toEqual({ title: "Sample", value: "1" });
      expect(state?.provider).toEqual({ kind: "noop" });

      await plugin.request(METHODS.tileUpdate, { tile: { title: "Sample", value: "2" } }); // latest write wins
      expect(srv.contrib.get("sample-echo")?.tile).toEqual({ title: "Sample", value: "2" });

      plugin.close(); srv.stop();
    });

    // Phase 4d Task 1 (spec §6/§7): the live READ + broadcast side of PluginContribRegistry —
    // plugins.contrib read RPC, plugin_tile_updated broadcast to every authed harness (a dashboard
    // connection is never attached to a session, so this must NOT go through the per-session hub),
    // and clearing a plugin's contributions (+ broadcasting tile:null) on disconnect.
    test("tile.update broadcasts plugin_tile_updated to every authed harness; plugins.contrib reflects it; disconnect clears + broadcasts tile:null", async () => {
      const srv = await bootBridgeServer();
      const pluginId = "sample-echo";

      // A harness (e.g. the dashboard) connects BEFORE the plugin pushes anything — mirrors the
      // G2 session_created precedent: harnessConns, not hub attachments, is what this broadcasts
      // through, so the harness needs no session.attach at all to receive it.
      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const plugin = await registerAndHello(srv, pluginId);
      await plugin.request(METHODS.tileUpdate, { tile: { title: "Sample", value: "1" } });

      const updated = await harness.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plugin_tile_updated");
      expect(updated.params.sessionId).toBe("$system"); // SYSTEM_SESSION_ID sentinel — session-less event
      expect(updated.params.pluginId).toBe(pluginId);
      expect(updated.params.tile).toEqual({ title: "Sample", value: "1" });
      expect(updated.params.threadId).toBeUndefined(); // extends Base, not ThreadBase

      const listed = await harness.request(METHODS.pluginsContrib, {});
      expect(listed.result.entries).toEqual([{ pluginId, tile: { title: "Sample", value: "1" } }]);

      harness.notifications.length = 0; // isolate the disconnect broadcast from the update above
      plugin.close();

      const cleared = await harness.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plugin_tile_updated");
      expect(cleared.params.pluginId).toBe(pluginId);
      expect(cleared.params.tile).toBeNull();

      const listedAfter = await harness.request(METHODS.pluginsContrib, {});
      expect(listedAfter.result.entries).toEqual([]);

      harness.close(); srv.stop();
    });

    // A plugin connection is role-gated to the six (now seven, +hardware.request) allowed verbs —
    // plugins.contrib was deliberately left off PLUGIN_ALLOWED_METHODS (a plugin never needs to
    // read the aggregate contrib state back over the wire; harness/admin connections do).
    test("plugins.contrib is not plugin-role callable", async () => {
      const srv = await bootBridgeServer();
      const plugin = await registerAndHello(srv, "sample-echo");
      const res = await plugin.request(METHODS.pluginsContrib, {});
      expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      plugin.close(); srv.stop();
    });

    test("disconnect unregisters every plugin__<id>__* tool and calls notifyDisconnected", async () => {
      const srv = await bootBridgeServer();
      const pluginId = "sample-echo";
      const plugin = await registerAndHello(srv, pluginId);
      await plugin.request(METHODS.toolRegister, { name: "a", description: "d" });
      await plugin.request(METHODS.toolRegister, { name: "b", description: "d" });
      expect(srv.registry.has(`plugin__${pluginId}__a`)).toBe(true);
      expect(srv.registry.has(`plugin__${pluginId}__b`)).toBe(true);
      expect(srv.supervisor.status(pluginId)).toBe("running");

      plugin.close();
      await new Promise((r) => setTimeout(r, 20));

      expect(srv.registry.has(`plugin__${pluginId}__a`)).toBe(false);
      expect(srv.registry.has(`plugin__${pluginId}__b`)).toBe(false);
      expect(srv.supervisor.status(pluginId)).not.toBe("running"); // notifyDisconnected ran

      srv.stop();
    });

    test("plugin.toolResult is caller-bound (final-review Fix 2): plugin B answering plugin A's requestId is a no-op; A's own answer works", async () => {
      const srv = await bootBridgeServer();
      const pluginA = "sample-echo";
      const pluginB = "sample-echo-2";
      const a = await registerAndHello(srv, pluginA);
      const b = await registerAndHello(srv, pluginB);

      await a.request(METHODS.toolRegister, { name: "echo", description: "d" });
      const registeredAs = `plugin__${pluginA}__echo`;

      const execPromise = srv.registry.execute(registeredAs, {}, { cwd: "/", roots: ["/"], sessionId: "s1" });
      const invoked = await a.waitForNotification((n) => n.method === METHODS.event && n.params.type === "plugin_tool_invoke");
      const requestId = invoked.params.requestId as string;

      // Plugin B — a DIFFERENT, correctly-authenticated connection — tries to answer A's requestId.
      const hijack = await b.request(METHODS.pluginToolResult, { requestId, resultJson: "\"hijacked\"" });
      expect(hijack.result).toEqual({ ok: true }); // never throws either way (safe-no-op wire contract)

      // A's own answer still works — B's attempt above never consumed/settled the pending entry.
      const legit = await a.request(METHODS.pluginToolResult, { requestId, resultJson: "\"legit\"" });
      expect(legit.result).toEqual({ ok: true });

      const outcome = await execPromise;
      expect(outcome.isError).toBe(false);
      expect(JSON.parse(outcome.output)).toBe("legit");

      a.close(); b.close(); srv.stop();
    });

    test("tool.register/shortcut.register/tile.update/provider.register all require an authenticated plugin connection (defensive — unreachable from a plugin conn, but not role-gated for other roles)", async () => {
      const srv = await bootBridgeServer();
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "harness-trying-plugin-verbs");
      const attempts: Array<[string, unknown]> = [
        [METHODS.toolRegister, { name: "x", description: "d" }],
        [METHODS.shortcutRegister, { shortcuts: [] }],
        [METHODS.tileUpdate, { tile: {} }],
        [METHODS.providerRegister, { info: {} }],
      ];
      for (const [method, params] of attempts) {
        const res = await c.request(method, params);
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      }
      c.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // shortcut.invoke / tile.action (Phase 4d Task 2, spec §6/§7): the reverse direction of Task
  // 1's plugin→core→dashboard tile broadcast above — a future UI fires a plugin's registered
  // shortcut or a tile-action button; core pushes a transient, session-less event straight to
  // that plugin's own connection. HARNESS-role (not in PLUGIN_ALLOWED_METHODS) — reuses the same
  // PluginSupervisor runtimes lookup plugin_tool_invoke's dispatch uses (`pushToPlugin`, sibling
  // of `invoke()` in "plugin tool bridge (Task 4)" above) but fire-and-forget: no
  // request/response correlation, no awaited answer.
  // -----------------------------------------------------------------------------------------
  describe("shortcut.invoke / tile.action (Task 2, Phase 4d)", () => {
    async function bootPushServer(): Promise<{
      store: SessionStore; socketPath: string; harnessToken: string; supervisor: PluginSupervisor;
      stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "norma-plugin-push-"));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      let nextPid = 9000;
      // Same fake-spawn injection as bootBridgeServer above — a "plugin process" here is really a
      // scripted TestClient connecting over the real socket.
      const supervisor = new PluginSupervisor({
        runDir: join(home, "run"),
        socketPath,
        mintToken: (id) => store.mintPluginToken(id),
        spawn: () => ({ pid: nextPid++, kill: () => {}, exited: new Promise<number>(() => {}) }),
        isAlivePid: () => false,
        signalPid: () => {},
        settings: { registrationTimeoutMs: 5000, backoffCapMs: 100, circuitFailures: 5, circuitWindowMs: 600_000 },
      });
      const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, supervisor });
      return {
        store, socketPath, harnessToken: tokens.harness, supervisor,
        stop: () => { supervisor.stopAll(); server.stop(); store.close(); },
      };
    }

    /** Spawns (fake) + hellos + plugin.registers a plugin connection — mirrors
     *  bootBridgeServer's registerAndHello above (duplicated here since that one is scoped inside
     *  the "plugin tool bridge (Task 4)" describe block). */
    async function registerAndHello(srv: Awaited<ReturnType<typeof bootPushServer>>, pluginId: string): Promise<TestClient> {
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun", args: ["index.ts"] } }]);
      const raw = srv.store.mintPluginToken(pluginId);
      const plugin = await TestClient.connect(srv.socketPath);
      const hello = await plugin.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: pluginId, pluginId,
      });
      if (!hello.result?.ok) throw new Error(`test setup: plugin hello failed: ${JSON.stringify(hello.error)}`);
      const reg = await plugin.request(METHODS.pluginRegister, { pluginId });
      expect(reg.result).toEqual({ ok: true });
      expect(srv.supervisor.status(pluginId)).toBe("running");
      return plugin;
    }

    test("shortcut.invoke pushes shortcut_invoke to the target plugin connection", async () => {
      const srv = await bootPushServer();
      const pluginId = "p1";
      const plugin = await registerAndHello(srv, pluginId);

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const res = await harness.request(METHODS.shortcutInvoke, { pluginId, shortcutId: "do-thing" });
      expect(res.result).toEqual({ ok: true });

      const invoked = await plugin.waitForNotification((n) => n.method === METHODS.event && n.params.type === "shortcut_invoke");
      expect(invoked.params.shortcutId).toBe("do-thing");
      expect(invoked.params.sessionId).toBe("$system"); // SYSTEM_SESSION_ID sentinel — session-less event
      expect(invoked.params.threadId).toBeUndefined(); // extends Base, not ThreadBase

      plugin.close(); harness.close(); srv.stop();
    });

    test("shortcut.invoke for a plugin with no live connection returns {code:'not_connected'}", async () => {
      const srv = await bootPushServer();
      const pluginId = "p1";
      // Tracked by the supervisor (startAll) but never hello'd/plugin.registered — no live conn.
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun" } }]);

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const res = await harness.request(METHODS.shortcutInvoke, { pluginId, shortcutId: "do-thing" });
      expect(res.result).toEqual({ code: "not_connected" });

      harness.close(); srv.stop();
    });

    test("tile.action pushes tile_action to the target plugin connection", async () => {
      const srv = await bootPushServer();
      const pluginId = "p1";
      const plugin = await registerAndHello(srv, pluginId);

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const res = await harness.request(METHODS.tileAction, { pluginId, actionId: "reconnect" });
      expect(res.result).toEqual({ ok: true });

      const fired = await plugin.waitForNotification((n) => n.method === METHODS.event && n.params.type === "tile_action");
      expect(fired.params.actionId).toBe("reconnect");
      expect(fired.params.sessionId).toBe("$system");
      expect(fired.params.threadId).toBeUndefined();

      plugin.close(); harness.close(); srv.stop();
    });

    test("tile.action for a plugin with no live connection returns {code:'not_connected'}", async () => {
      const srv = await bootPushServer();
      const pluginId = "p1";
      srv.supervisor.startAll([{ id: pluginId, dir: `/plugins/${pluginId}`, entry: { command: "bun" } }]);

      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const res = await harness.request(METHODS.tileAction, { pluginId, actionId: "reconnect" });
      expect(res.result).toEqual({ code: "not_connected" });

      harness.close(); srv.stop();
    });

    test("shortcut.invoke / tile.action for a completely unknown pluginId return {code:'unknown_plugin'}", async () => {
      const srv = await bootPushServer();
      const harness = await TestClient.connect(srv.socketPath);
      await harness.hello(srv.harnessToken, "dashboard");

      const a = await harness.request(METHODS.shortcutInvoke, { pluginId: "never-heard-of-it", shortcutId: "do-thing" });
      expect(a.result).toEqual({ code: "unknown_plugin" });
      const b = await harness.request(METHODS.tileAction, { pluginId: "never-heard-of-it", actionId: "reconnect" });
      expect(b.result).toEqual({ code: "unknown_plugin" });

      harness.close(); srv.stop();
    });

    test("shortcut.invoke / tile.action are not plugin-role callable", async () => {
      const srv = await bootPushServer();
      const plugin = await registerAndHello(srv, "p1");
      const a = await plugin.request(METHODS.shortcutInvoke, { pluginId: "p1", shortcutId: "do-thing" });
      expect(a.error?.code).toBe(ERR.UNAUTHORIZED);
      const b = await plugin.request(METHODS.tileAction, { pluginId: "p1", actionId: "reconnect" });
      expect(b.error?.code).toBe(ERR.UNAUTHORIZED);
      plugin.close(); srv.stop();
    });
  });

  // -----------------------------------------------------------------------------------------
  // Scheduled routines (Phase 5 routines T3, design doc §3): the four routines.* RPCs over the
  // daemon's real RoutineStore (wired unconditionally in daemon.ts, same precedent as peripheral/
  // hardware — `boot()` above always constructs one, provider or not). Role-gated exactly like
  // session.create/session.list — no additional harness-only check (see the "plugin role method
  // allowlist" describe block above for the plugin-role rejection coverage of one of these four).
  // -----------------------------------------------------------------------------------------
  describe("routines.* RPCs (Phase 5 routines T3)", () => {
    test("routines.create validates + persists; routines.list returns it", async () => {
      await boot();
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "routines-tester");

      const created = await c.request(METHODS.routinesCreate, { spec: "every 30m", prompt: "check inbox" });
      expect(created.error).toBeUndefined();
      expect(created.result.routine).toMatchObject({ spec: "every 30m", prompt: "check inbox", policy: "auto", enabled: true });
      expect(created.result.routine.id).toBeTruthy();

      const listed = await c.request(METHODS.routinesList, {});
      expect(listed.result.routines).toHaveLength(1);
      expect(listed.result.routines[0].id).toBe(created.result.routine.id);
      c.close();
    });

    test("routines.create rejects an invalid spec and policy \"ask\" with INVALID_PARAMS", async () => {
      await boot();
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "routines-tester");

      const badSpec = await c.request(METHODS.routinesCreate, { spec: "not a spec", prompt: "x" });
      expect(badSpec.error?.code).toBe(ERR.INVALID_PARAMS);

      const askPolicy = await c.request(METHODS.routinesCreate, { spec: "every 1h", prompt: "x", policy: "ask" });
      expect(askPolicy.error?.code).toBe(ERR.INVALID_PARAMS); // rejected at the wire zod schema, before ever reaching the store

      const listed = await c.request(METHODS.routinesList, {});
      expect(listed.result.routines).toHaveLength(0); // neither bad call left a row behind
      c.close();
    });

    test("routines.update patches an existing routine and re-validates a changed spec", async () => {
      await boot();
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "routines-tester");
      const created = (await c.request(METHODS.routinesCreate, { spec: "every 30m", prompt: "check inbox" })).result.routine;

      const disabled = await c.request(METHODS.routinesUpdate, { id: created.id, patch: { enabled: false } });
      expect(disabled.result.routine.enabled).toBe(false);

      const respec = await c.request(METHODS.routinesUpdate, { id: created.id, patch: { spec: "every 2h" } });
      expect(respec.result.routine.spec).toBe("every 2h");

      const badSpec = await c.request(METHODS.routinesUpdate, { id: created.id, patch: { spec: "garbage" } });
      expect(badSpec.error?.code).toBe(ERR.INVALID_PARAMS);
      c.close();
    });

    test("routines.update on an unknown id is NOT_FOUND", async () => {
      await boot();
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "routines-tester");
      const res = await c.request(METHODS.routinesUpdate, { id: "nope", patch: { enabled: false } });
      expect(res.error?.code).toBe(ERR.NOT_FOUND);
      c.close();
    });

    test("routines.delete removes a routine; deleting an unknown id reports removed:false, never errors", async () => {
      await boot();
      const c = await TestClient.connect(daemon.socketPath);
      await c.hello(harnessToken, "routines-tester");
      const created = (await c.request(METHODS.routinesCreate, { spec: "every 30m", prompt: "x" })).result.routine;

      const deleted = await c.request(METHODS.routinesDelete, { id: created.id });
      expect(deleted.result).toEqual({ ok: true, removed: true });

      const again = await c.request(METHODS.routinesDelete, { id: created.id });
      expect(again.result).toEqual({ ok: true, removed: false });

      const listed = await c.request(METHODS.routinesList, {});
      expect(listed.result.routines).toHaveLength(0);
      c.close();
    });

    // A plugin-role connection is role-rejected before dispatch, same as sessionCreate/sessionList
    // (see "plugin role method allowlist" describe block above — none of the four routines.* verbs
    // are in PLUGIN_ALLOWED_METHODS).
    test("routines.* verbs are role-rejected for a plugin connection, exactly like session.create/session.list", async () => {
      const srv = await bootPluginTestServer();
      const raw = srv.store.mintPluginToken("sample-echo");
      const plugin = await TestClient.connect(srv.socketPath);
      await plugin.request(METHODS.hello, {
        protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
      });
      for (const [method, params] of [
        [METHODS.routinesCreate, { spec: "every 30m", prompt: "x" }],
        [METHODS.routinesList, {}],
        [METHODS.routinesUpdate, { id: "r_1", patch: {} }],
        [METHODS.routinesDelete, { id: "r_1" }],
      ] as const) {
        const res = await plugin.request(method, params);
        expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
      }
      plugin.close(); srv.stop();
    });
  });
});

// -----------------------------------------------------------------------------------------
// provider.configure RPC (BYOK T1, design doc `2026-07-16-byok-provider-setup-design.md` §1): the
// in-app "bring your own OpenAI API key" path. A bare `startIpcServer` (no full daemon/engine) with
// `normaHome` + a `FileSecretStore` wired directly — same self-contained precedent as the "plugin
// lifecycle RPCs" describe block above — so assertions can read back both the secret store and
// settings.json without exposing `home` off the shared daemon fixture.
// -----------------------------------------------------------------------------------------
describe("provider.configure RPC (BYOK T1)", () => {
  async function bootProviderConfigServer(settingsSeed: Record<string, unknown> = {}): Promise<{
    home: string; settingsPath: string; socketPath: string; harnessToken: string;
    secrets: FileSecretStore; store: SessionStore; stop: () => void;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-provider-configure-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      ...settingsSeed,
    }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    const secrets = new FileSecretStore(join(home, "provider-secrets"));
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, normaHome: home, secrets });
    return {
      home, settingsPath: join(home, "settings.json"), socketPath, harnessToken: tokens.harness,
      secrets, store,
      stop: () => { server.stop(); store.close(); },
    };
  }

  test("writes the API key via the SecretStore and the openai-compatible provider block, preserving other settings fields", async () => {
    const srv = await bootProviderConfigServer({ reviewer: { enabled: false } });
    const c = await TestClient.connect(srv.socketPath);
    await c.hello(srv.harnessToken, "cli-provider-configure");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-123", model: "gpt-4o-mini",
    });
    expect(res.result).toEqual({ ok: true });

    expect(await srv.secrets.get(OPENAI_API_KEY_SECRET)).toBe("sk-test-123");

    const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
    expect(settings.provider).toEqual({ type: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    expect(settings.reviewer).toEqual({ enabled: false }); // other top-level settings fields preserved
    expect(settings.schemaVersion).toBe(2);

    c.close(); srv.stop();
  });

  test("model omitted -> defaults to gpt-4o", async () => {
    const srv = await bootProviderConfigServer();
    const c = await TestClient.connect(srv.socketPath);
    await c.hello(srv.harnessToken, "cli-provider-configure-default-model");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-456",
    });
    expect(res.result).toEqual({ ok: true });

    const settings = JSON.parse(readFileSync(srv.settingsPath, "utf8"));
    expect(settings.provider).toEqual({ type: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });

    c.close(); srv.stop();
  });

  test("a malformed baseUrl is rejected as INVALID_PARAMS — settings and the secret store are left UNCHANGED", async () => {
    const srv = await bootProviderConfigServer();
    const before = readFileSync(srv.settingsPath, "utf8");
    const c = await TestClient.connect(srv.socketPath);
    await c.hello(srv.harnessToken, "cli-provider-configure-bad-url");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "not-a-url", apiKey: "sk-test-789",
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(readFileSync(srv.settingsPath, "utf8")).toBe(before);
    expect(await srv.secrets.get(OPENAI_API_KEY_SECRET)).toBeNull();

    c.close(); srv.stop();
  });

  test("an empty apiKey is rejected as INVALID_PARAMS", async () => {
    const srv = await bootProviderConfigServer();
    const c = await TestClient.connect(srv.socketPath);
    await c.hello(srv.harnessToken, "cli-provider-configure-empty-key");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "",
    });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(await srv.secrets.get(OPENAI_API_KEY_SECRET)).toBeNull();

    c.close(); srv.stop();
  });

  test("provider.configure is not one of the six plugin-role verbs — a plugin connection is role-rejected before dispatch", async () => {
    const srv = await bootProviderConfigServer();
    const raw = srv.store.mintPluginToken("sample-echo");
    const c = await TestClient.connect(srv.socketPath);
    await c.request(METHODS.hello, {
      protocolVersion: PROTOCOL_VERSION, role: "plugin", token: raw, clientName: "sample-echo", pluginId: "sample-echo",
    });
    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-999",
    });
    expect(res.error?.code).toBe(ERR.UNAUTHORIZED);

    c.close(); srv.stop();
  });

  test("a server with no secret store configured -> typed INTERNAL failure, never a crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-provider-configure-nostore-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    // normaHome wired, secrets deliberately omitted.
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, normaHome: home });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli-provider-configure-nostore");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-000",
    });
    expect(res.error?.code).toBe(ERR.INTERNAL);

    c.close(); server.stop(); store.close();
  });
});
