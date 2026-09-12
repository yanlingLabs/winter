import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@winter/protocol";
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
import { readOpenAiApiKey } from "../src/auth/credential-material";
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
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-role-"));
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


  // Phase 5 routines T3 (design doc §3): session.create's additive `origin` param round-trips
  // through session.list; a session created without one still lists fine (origin undefined).

  // session-activity-hygiene T2 (spec §1): `session.list` surfaces the derived activity state.
  // The derivation itself is exhaustively tested in test/sessions/activity.test.ts — what these
  // two cover is the WIRING: that the handler actually builds signals and stamps the field, and
  // that the "absent = none" half survives the trip (a chat row must carry no `activity` at all,
  // not `"idle"`).


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
    const { RpcResponse } = await import("@winter/protocol");
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




  // SP-approvals Task 5: a rule-bearing optionId on approval.respond persists a CC-grammar
  // permission rule to the SESSION-CWD project file (Task 1's PermissionRules, written via
  // engine.ts's approvalOptionsFor + this handler's append) — this is the feature's whole point:
  // card → "always allow" → rule written → the NEXT identical call runs silently (proven by
  // permission-gate-order.test.ts's scenario 1, driven from the OTHER side of the same rule file).



  // Remote Gateway parity: the phone answers approvals through role:"remote" (REMOTE_ALLOWED_METHODS
  // already carries approval.respond) — an optionId-bearing respond from that role must persist a
  // rule exactly like a harness caller's, since the server-side handler doesn't special-case role.

  // T4's broker->list() options passthrough, end to end over the wire (T4 itself only proved this
  // at the ApprovalBroker unit level) — a phone that reconnects and calls approval.list mid-card
  // must see the SAME options the approval_requested event it possibly missed would have carried.

  // SP-approvals Task 10 (spec §7): the "Always allow from this source" web_fetch option, over the
  // REAL wire, end to end — card shape, the REAL approval.respond handler persisting a
  // WebFetch(domain:...) rule to the daemon's OWN settings.json (global scope), and the REAL
  // daemon's live settings-watcher (settings-watcher.ts, 150ms debounce) picking it up so the NEXT
  // fetch to the same domain AND a subdomain both run cardless. `globalThis.fetch` is monkey-patched
  // for the duration (save/restore) so web_fetch never hits the real network.

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
    const home = mkdtempSync(join(tmpdir(), "winter-approve-nocwd-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const broker = new ApprovalBroker();
    const permissionRules = new PermissionRules({ globalAllow: () => undefined, winterHome: home });
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


  // CC AskUserQuestion parity (Task 2): ask_user.respond's optional `notes` param must reach the
  // QuestionBroker (server.ts's handler passes p.notes through) and end up both on the persisted
  // question_resolved event and folded into the model-visible tool_result.



  // I1 review fix (Chat Slice D task 1): session.setModel used to validate nothing, so a bad slug
  // (a typo, or a since-deprecated model) succeeded at set time and then silently broke every
  // subsequent turn. Reuses spawn_agent's own `known.length > 0`-guarded idiom (engine.ts) — a
  // real AgentEngine must be wired (`boot({}, fake)`) so `opts.engine?.knownModels()` has a live
  // provider to enumerate.
  describe("session.setModel model validation (I1 review fix)", () => {




  });



  // -------------------------------------------------------------------------------------------
  describe("workflow.list/run/stop/get (CC-parity phase 3, Track C Task C2)", () => {
    async function bootWorkflowServer(): Promise<{
      store: SessionStore; trust: TrustStore; workflows: WorkflowRuntime; workflowStore: WorkflowStore;
      socketPath: string; harnessToken: string; remoteToken: string; winterHome: string; stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "winter-workflow-rpc-"));
      const store = new SessionStore(home);
      const trust = new TrustStore(join(home, "trust.json"));
      const workflowStore = new WorkflowStore({ winterHome: home, trust });
      const runsDir = mkdtempSync(join(tmpdir(), "winter-workflow-rpc-runs-"));
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
        winterHome: home, stop: () => { server.stop(); store.close(); },
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
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-workflow-rpc-cwd-")));
      mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
      writeFileSync(join(cwd, ".winter", "workflows", "hello.js"),
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
      mkdirSync(join(srv.winterHome, "workflows"), { recursive: true });
      writeFileSync(join(srv.winterHome, "workflows", "nightly.js"),
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



  // Phase 5e T4: settings.reviewer.classes → EngineConfig.reviewerClasses, threaded through the
  // REAL daemon (loadSettings → startDaemon → AgentEngine), not a stubbed cfg. The reviewer stays
  // ON overall (no `reviewer.enabled:false`) but `classes.fs:false` turns off just the fs class —
  // a dotfile write (normally "unusual" and reviewed under auto policy, per 5e T3) must instead
  // execute directly. Only ONE script entry is needed: if the wiring were broken, the write would
  // route to reviewAndDispatch and consume this same single-track FakeProvider queue for a review
  // call instead, which would fail to find a JSON verdict and escalate to a human approval that
  // times out well past bun's default per-test timeout — i.e. a broken wire fails this test loudly.



  test("startIpcServer refuses an engine without a shared hub", () => {
    // Build a throwaway engine; we only need the constructor guard to fire.
    expect(() => {
      const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-guard-")));
      startIpcServer({
        socketPath: join(mkdtempSync(join(tmpdir(), "winter-guard-sock-")), "s.sock"),
        serverVersion: "test", tokens: {} as any, store,
        engine: {} as any, // engine present...
        // ...no hub
      });
    }).toThrow(/hub/);
  });



  test("session.addDir on an unknown session fails and adds no dangling entry", async () => {
    await boot({});
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "adder-bad");
    const res = await c.request(METHODS.sessionAddDir, {
      sessionId: "s_does_not_exist",
      path: realpathSync(mkdtempSync(join(tmpdir(), "winter-x-"))),
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });









  test("skills.list returns only the shipped builtin when no user/project skills are installed", async () => {
    await boot(); // no provider → default temp home has no user/project skills
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "no-skills");
    const { result } = await c.request(METHODS.skillsList, {});
    expect(result.ok).toBe(true);
    // The writing-skills builtin (phase 5c) is always discovered, regardless of home — it ships
    // in-repo and is resolved relative to the module, not winterHome.
    expect(result.skills).toEqual([{ name: "writing-skills", description: expect.any(String), source: "builtin", path: expect.any(String) }]);
    c.close();
  });

  test("skills.list discovers a user skill over the socket (the daemon wires its one skillStore into the server)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" },
      mcpServers: { fake: { command: "bun", args: ["run", fixture] } },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const fake = new FakeProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    daemon = await startDaemon({ home, secrets, agentProvider: { provider: fake, model: "fake-1" } });
    harnessToken = daemon.tokens.harness;

    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "winter-mcp-project-")));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugins-ipc-"));
    mkdirSync(join(home, "plugins", "demo", "skills", "greet"), { recursive: true });
    writeFileSync(join(home, "plugins", "demo", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: hi\n---\nbody");
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({ mcpServers: { fake: { command: "true" } } }));
    const plugins = new PluginStore({ winterHome: home, plugins: { enabled: ["demo"] } });

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
        status: "na", // legacy plugin (no winter-plugin.json) — never tier "platform", never spawn-eligible
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
      const home = mkdtempSync(join(tmpdir(), "winter-plugins-status-"));
      // Tier-2 (platform) plugin — spawn-eligible: tier platform + entry + enabled + exec-consented.
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "winter-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      // Tier-1 (capability) plugin — never spawn-eligible, no process ever runs for it.
      mkdirSync(join(home, "plugins", "toolbox"), { recursive: true });
      writeFileSync(join(home, "plugins", "toolbox", "winter-plugin.json"), JSON.stringify({ id: "toolbox", tier: "capability" }));

      const plugins = new PluginStore({
        winterHome: home,
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
      const home = mkdtempSync(join(tmpdir(), "winter-plugins-status-untracked-"));
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "winter-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const plugins = new PluginStore({
        winterHome: home, plugins: { enabled: ["runner"] }, consents: { runner: { exec: Date.now() } },
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
      const home = mkdtempSync(join(tmpdir(), "winter-plugins-status-nosupervisor-"));
      mkdirSync(join(home, "plugins", "toolbox"), { recursive: true });
      writeFileSync(join(home, "plugins", "toolbox", "winter-plugin.json"), JSON.stringify({ id: "toolbox", tier: "capability" }));
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "winter-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const plugins = new PluginStore({
        winterHome: home, plugins: { enabled: ["toolbox", "runner"] }, consents: { runner: { exec: Date.now() } },
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    writeFileSync(join(home, "plugins", "demo", "winter-plugin.json"), JSON.stringify({
      id: "demo", tier: "capability",
      contributes: { mcpServers: [{ name: "fake", command: "bun", args: ["run", fixture] }] },
    }));
  }

  test("CONSENT (Task 2): manifest plugin enabled but unconsented — MCP not started + a log line names the missing class", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    writeFileSync(join(home, "plugins", "demo", "winter-plugin.json"), JSON.stringify({
      id: "demo", tier: "capability",
      contributes: { mcpServers: [{ name: "fake", command: "bun", args: ["run", fixture] }] },
    }));
  }

  test("Task 4: manifest-only plugin (no .mcp.json) enabled + consented — MCP starts from the manifest (closes T2 interim gap)", async () => {
    if (process.platform !== "darwin") return; // spawns a child process
    const { FakeProvider } = await import("../src/agent/fake-provider");
    const fixture = join(import.meta.dir, "agent", "mcp", "fake-mcp-server.ts");
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
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
    const home = mkdtempSync(join(tmpdir(), "winter-plugin-consent-"));
    mkdirSync(join(home, "plugins", "demo"), { recursive: true });
    // .mcp.json declares a DIFFERENT server name than the manifest, so precedence is unambiguous.
    writeFileSync(join(home, "plugins", "demo", ".mcp.json"), JSON.stringify({
      mcpServers: { legacy: { command: "/nonexistent-legacy-server" } },
    }));
    writeFileSync(join(home, "plugins", "demo", "winter-plugin.json"), JSON.stringify({
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
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-no-provider-sweep-"));
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
  // !opts.winterHome`, so a no-provider daemon fell through to a REAL `opts.supervisor.restart()`
  // spawn on `plugin.enable {consent:true}`, where before this task it always returned "stopped"
  // with no spawn. Fixed by also gating on `opts.registry` (only ever wired for a
  // provider-configured daemon — same signal `tool.register` already uses). This proves the FIX:
  // a spawn-eligible plugin's `plugin.enable{consent:true}` on a no-provider daemon still records
  // settings but genuinely never spawns. Exercises the REAL `startDaemon` wiring end to end (same
  // no-injectable-spawn-seam constraint as the sweep test above), with a real, harmless entry
  // (`bun --version`) — if the bug regressed, this WOULD spawn a real OS process.
  // -----------------------------------------------------------------------------------------
  test("Phase 4d-cleanup Task 2 fix: a daemon booted with NO agent provider does NOT hot-spawn on plugin.enable — settings recorded, status stays \"stopped\", no process spawned", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-no-provider-enable-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model: "gpt-5.4" }, // unused — agentProvider: null below forces no-provider
    }));
    // A Tier-2 (platform) plugin with an `entry` — spawn-eligible once enabled+consented, exactly
    // the shape `plugin.enable{consent:true}` would hot-spawn on a provider-configured daemon.
    mkdirSync(join(home, "plugins", "runner"), { recursive: true });
    writeFileSync(join(home, "plugins", "runner", "winter-plugin.json"), JSON.stringify({
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

  // SP3 T4b: approval.list — queryable pending-approval STATE (a phone that missed the
  // approval_requested event in its replay window queries the live pending set). The remote role
  // is allowlisted for it (REMOTE_ALLOWED_METHODS grew 9→10); a non-allowlisted method stays
  // role-rejected. Drives a real pending broker entry via the peripheral.lease-under-ask path
  // (same recipe as the ask-policy lease test above), then queries and resolves it.



  // Phase 4b Task 2: this used to stub TokenAuthority to fake a "plugin"-role hello (no real
  // plugin auth existed) and pinned the handlers' OWN defensive `authedRole !== "harness"` denied
  // branch. Now that a real plugin-token path + a role→method allowlist exist, peripheral.lease/
  // renew/release are NOT among the six plugin-role verbs (Task 2 contract), so a plugin
  // connection is role-rejected by the allowlist gate BEFORE ever reaching those handlers — an
  // even stronger form of "never touching the broker" than the old typed-denied result.
  test("peripheral.lease/renew/release from a plugin-role connection are role-rejected before ever reaching the broker", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-peripheral-plugin-"));
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




  test("noop capability call round-trips through the real provider connection (call() -> peripheral_call_requested -> peripheral.respond)", async () => {
    const { AuditLog } = await import("../src/peripheral/audit");
    const { PeripheralBroker } = await import("../src/peripheral/broker");
    const { ProviderLink } = await import("../src/peripheral/provider-link");

    const home = mkdtempSync(join(tmpdir(), "winter-peripheral-call-"));
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

  // -----------------------------------------------------------------------------------------
  // Dashboard read methods (Phase 2f): daemon.status, quota.state, trust.list, trust.remove.
  // -----------------------------------------------------------------------------------------

  test("trust.list / trust.remove over the socket", async () => {
    await boot();
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(harnessToken, "trust-lister");
    const dirA = realpathSync(mkdtempSync(join(tmpdir(), "winter-trust-a-")));
    const dirB = realpathSync(mkdtempSync(join(tmpdir(), "winter-trust-b-")));
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
    const home = mkdtempSync(join(tmpdir(), "winter-daemon-status-plugins-"));
    for (const name of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(home, "plugins", name), { recursive: true });
      writeFileSync(join(home, "plugins", name, "plugin.json"), JSON.stringify({ description: name }));
    }
    const plugins = new PluginStore({ winterHome: home });
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
    // only the active provider connection (Winter.app) may answer a hardware_requested push, same
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
  // Winter.app's XPC helper, via HardwareBroker + the SAME ProviderLink/PeripheralBroker.isProvider
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

      const home = mkdtempSync(join(tmpdir(), "winter-hardware-ipc-"));
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
      const plugins = new PluginStore({ winterHome: home, consents: opts.consents });

      // Phase 4d-ii Task 2: `winterHome` wired (harmless for every EXISTING test here — no
      // settings.json exists at `home` unless a test writes one, so `livePlugins()`'s
      // `loadSettings` throws and it falls back to the `plugins` snapshot above, same as before
      // this change) — lets a dedicated regression test below prove `plugin.setConsent`'s hardware
      // grant is honored by `hardware.request` immediately, without a restart.
      const server = startIpcServer({
        socketPath, serverVersion: "test", tokens: authority, store, peripheral, providerLink, hardware, plugins,
        winterHome: home,
      });
      return {
        store, socketPath, harnessToken: tokens.harness, home,
        stop: () => { server.stop(); store.close(); },
      };
    }

    function seedBatteryPlugin(home: string, pluginId: string, permissions: { hardware?: string[] } = { hardware: ["battery"] }): void {
      mkdirSync(join(home, "plugins", pluginId), { recursive: true });
      writeFileSync(join(home, "plugins", pluginId, "winter-plugin.json"), JSON.stringify({
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
      expect(res.result).toEqual({ code: "no_provider", message: "hardware features require Winter.app" });

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
      const home = mkdtempSync(join(tmpdir(), "winter-plugin-restart-"));
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
  // "plugin.restart"/"plugins.list supervisor status" above) + `winterHome` wired so the RPC
  // handlers can read/write settings.json and the plugins directory directly.
  // -----------------------------------------------------------------------------------------
  describe("plugin lifecycle RPCs (Task 2)", () => {
    async function bootLifecycleServer(): Promise<{
      home: string; settingsPath: string; pluginsRoot: string;
      store: SessionStore; socketPath: string; harnessToken: string;
      supervisor: PluginSupervisor; stop: () => void;
    }> {
      const home = mkdtempSync(join(tmpdir(), "winter-plugin-lifecycle-"));
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" },
      }));
      // A Tier-2 (platform) plugin with an `entry` — requiredConsentClasses derives "exec" for
      // any manifest with an entry point (plugin-manifest.ts), so this plugin always starts out
      // needing consent, exercising the two-step enable flow below.
      mkdirSync(join(home, "plugins", "runner"), { recursive: true });
      writeFileSync(join(home, "plugins", "runner", "winter-plugin.json"), JSON.stringify({
        id: "runner", tier: "platform", entry: { command: "bun", args: ["index.ts"] },
      }));
      const store = new SessionStore(home);
      const socketPath = join(home, "core.sock");
      const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
      const tokens = await authority.ensureTokens();
      const plugins = new PluginStore({ winterHome: home });
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
        socketPath, serverVersion: "test", tokens: authority, store, plugins, supervisor, registry, winterHome: home,
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
      // Matches the CLI's `winter plugin disable` (main.ts, which composes
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
      const src = mkdtempSync(join(tmpdir(), "winter-plugin-src-"));
      writeFileSync(join(src, "winter-plugin.json"), JSON.stringify({ id: "fresh", tier: "platform", entry: { command: "bun" } }));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install");

      const before = readFileSync(srv.settingsPath, "utf8");
      const res = await c.request(METHODS.pluginsInstall, { source: src, name: "fresh" });
      expect(res.result.ok).toBe(true);
      expect(res.result.name).toBe("fresh");
      expect(res.result.requiredConsents).toEqual(["exec"]);
      expect(res.result.hasMcp).toBe(false);
      expect(res.result.consentBlock[0]).toBe("plugin fresh requests:");
      expect(existsSync(join(srv.pluginsRoot, "fresh", "winter-plugin.json"))).toBe(true);
      expect(readFileSync(srv.settingsPath, "utf8")).toBe(before); // installed disabled+unconsented — settings untouched

      c.close(); srv.stop();
    });

    test("plugins.install derives the name from `source`'s basename when `name` is omitted", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "winter-plugin-derived-"));
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
      const src = mkdtempSync(join(tmpdir(), "winter-plugin-src2-"));
      writeFileSync(join(src, "winter-plugin.json"), JSON.stringify({ id: "runner", tier: "capability" }));
      const c = await TestClient.connect(srv.socketPath);
      await c.hello(srv.harnessToken, "cli-install-dup");

      const res = await c.request(METHODS.pluginsInstall, { source: src, name: "runner" });
      expect(res.result).toEqual({ code: "already_installed", name: "runner" });
      // the pre-existing fixture (tier: platform) was never clobbered by the capability-tier source
      expect(JSON.parse(readFileSync(join(srv.pluginsRoot, "runner", "winter-plugin.json"), "utf8")).tier).toBe("platform");

      c.close(); srv.stop();
    });

    test("plugins.install on a source with no manifest -> invalid_source, nothing copied", async () => {
      const srv = await bootLifecycleServer();
      const src = mkdtempSync(join(tmpdir(), "winter-plugin-empty-"));
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
      const home = mkdtempSync(join(tmpdir(), "winter-plugin-bridge-"));
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
      const home = mkdtempSync(join(tmpdir(), "winter-plugin-push-"));
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
// `winterHome` + a `FileSecretStore` wired directly — same self-contained precedent as the "plugin
// lifecycle RPCs" describe block above — so assertions can read back both the secret store and
// settings.json without exposing `home` off the shared daemon fixture.
// -----------------------------------------------------------------------------------------
describe("provider.configure RPC (BYOK T1)", () => {
  async function bootProviderConfigServer(settingsSeed: Record<string, unknown> = {}): Promise<{
    home: string; settingsPath: string; socketPath: string; harnessToken: string;
    secrets: FileSecretStore; store: SessionStore; stop: () => void;
  }> {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-configure-"));
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
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
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

    // Hotfix (credential material, P8b): the RPC now writes the JSON material record the spawned
    // Winter child reads (openai:default), not the legacy raw openai-api-key string.
    expect(await readOpenAiApiKey(srv.secrets)).toBe("sk-test-123");
    // Review r1 m4: the legacy raw record is BLANKED (not left null) after a successful material write, so a
    // rotated key is never left live under the old name; blank reads as absent everywhere (presence, migration).
    expect(await srv.secrets.get(OPENAI_API_KEY_SECRET)).toBe("");

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
    const home = mkdtempSync(join(tmpdir(), "winter-provider-configure-nostore-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.4" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "auth-secrets")));
    const tokens = await authority.ensureTokens();
    // winterHome wired, secrets deliberately omitted.
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli-provider-configure-nostore");

    const res = await c.request(METHODS.providerConfigure, {
      type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-000",
    });
    expect(res.error?.code).toBe(ERR.INTERNAL);

    c.close(); server.stop(); store.close();
  });
});
