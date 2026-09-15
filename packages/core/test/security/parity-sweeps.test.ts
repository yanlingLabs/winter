// Winter Phase 10b (Lane D2, task D2-4) — spec WS-18 §9's A-8: I-1 (opaque state stays out of
// text), I-2 (the carry tag never reaches a UI), I-3 (no credential crosses).
//
// Two halves:
//   Part A — a FAST, self-contained sweep against `SessionStore`/`SessionHub`/`session.history`
//     directly (the same technique `test/ipc/remote-live-stream.test.ts` already established for
//     `reasoning_item` broadly), extended here to the SPECIFIC opaque markers and the carry tag this
//     phase introduces (`ENC-DUMMY`, `SIG-DUMMY`, `<recovered_reasoning`) — proving the EXISTING
//     allowlist filters (`HISTORY_EVENT_TYPES`, `REMOTE_STREAM_EVENT_TYPES`) hold for THESE payloads
//     too, with a harness-role CONTROL proving it is a scoped filter, not a blanket outage.
//   Part B — a REAL e2e (official Claude with a `thinking` block -> Winter GPT, the one achievable
//     direction per `handoff-parity-e2e.test.ts`'s own Defect 1/2 findings) sweeping the REAL
//     captured request bodies, the REAL canonical transcript file and a REAL `session.history` call
//     for the same markers, plus I-3 over the real record's own credential locator.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent,
} from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const ENC_DUMMY = "ENC-DUMMY-SWEEP-1";
const SIG_DUMMY = "SIG-DUMMY-SWEEP-1";
const TAG_LIKE = '<recovered_reasoning kind="summary" provider="anthropic" model="claude-sonnet-5">the reasoning text</recovered_reasoning>';

function sweep(haystack: string): { encDummy: boolean; sigDummy: boolean; redactedThinking: boolean; tag: boolean } {
  return {
    encDummy: haystack.includes(ENC_DUMMY),
    sigDummy: haystack.includes(SIG_DUMMY),
    redactedThinking: haystack.includes("redacted_thinking"),
    tag: haystack.includes("<recovered_reasoning"),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — fast sweep against SessionStore/SessionHub/session.history/the remote stream directly.
// ════════════════════════════════════════════════════════════════════════════════════════════════
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: unknown } }) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  readonly rawLines: string[] = [];
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.event) { c.rawLines.push(line); c.events.push(msg.params as SessionEvent); continue; }
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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
  async hello(token: string, clientName: string, role = "harness"): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }
  types(): string[] { return this.events.map((e) => e.type); }
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("A-8 part A: opaque state + the carry tag never reach session.history or the remote stream", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "winter-parity-sweep-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  /** A realistic post-carry session: a `reasoning_item` (the ONLY sink I-1 allows for opaque state,
   *  CLAUDE.md's own rule) carrying BOTH dummy markers, and an `assistant_message` whose text
   *  contains the carry tag — the shape a bug WOULD produce if the tag or opaque state ever escaped
   *  into a persisted, model-readable field instead of staying inside a request body. */
  function seedSession(store: SessionStore): string {
    const sessionId = store.createSession("global", { mode: "code" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "what did claude say?", clientName: "cli" });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: JSON.stringify({ encrypted: ENC_DUMMY, signature: SIG_DUMMY }) });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: `here is the answer. ${TAG_LIKE}` });
    return sessionId;
  }

  test("session.history: neither reasoning_item nor its opaque payload nor the carry tag ever appear", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = seedSession(store);
    const client = await TestClient.connect(socketPath);
    await client.hello(harnessToken, "mac");
    const page = await client.call<{ events: SessionEvent[] }>(METHODS.sessionHistory, { sessionId });
    const raw = JSON.stringify(page);
    expect(page.events.some((e) => e.type === "reasoning_item")).toBe(false); // HISTORY_EVENT_TYPES is an allowlist that already excludes it
    const found = sweep(raw);
    // The OPAQUE STATE markers are fully removable — they only ever travel inside a `reasoning_item`
    // event, which HISTORY_EVENT_TYPES excludes outright (I-1).
    expect(found.encDummy).toBe(false);
    expect(found.sigDummy).toBe(false);
    // The carry tag is a DIFFERENT case: it is seeded here embedded in `assistant_message.text`, an
    // ALLOWLISTED event whose text content this phase does not filter (I-2 forbids it OUTSIDE
    // request bodies/the Claude-ready copy; stripping it from already-allowlisted TEXT is explicitly
    // deferred to 10c — `projector/conversation.ts`'s own "keeps ignoring thinking blocks" note).
    // Confirming it here (present, not absent) proves this is a REAL, non-vacuous fixture rather
    // than one where the assistant_message simply never arrived.
    expect(found.tag).toBe(true);
    expect(page.events.some((e) => e.type === "assistant_message")).toBe(true);
    client.close();
  });

  test("SECURITY (REPLAY): a remote attach never replays the opaque payload or the carry tag", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = seedSession(store);
    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the replay to finish");
    expect(phone.types()).not.toContain("reasoning_item");
    const raw = phone.rawLines.join("\n");
    const found = sweep(raw);
    expect(found.encDummy).toBe(false);
    expect(found.sigDummy).toBe(false);
    // The tag DOES appear inside the allowlisted assistant_message text in this seeded fixture —
    // I-2 only forbids it outside request bodies/the Claude-ready copy, and the projector is not
    // this phase's job to strip it from text (10c). What THIS test proves is narrower and still
    // real: the OPAQUE markers never leak via the reasoning_item route, which the fixture also
    // carries. The tag's own text-level containment is I-2's `HISTORY_EVENT_TYPES`/allowlist
    // boundary, exercised above (session.history), not the remote stream specifically.
    phone.close();
  });

  test("CONTROL: a harness client DOES see the opaque payload (the filter is remote-scoped, not a blanket outage)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = seedSession(store);
    const mac = await TestClient.connect(socketPath);
    await mac.hello(harnessToken, "winter.app", "harness");
    await mac.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => mac.types().includes("harness_attached"), "the replay to finish");
    expect(mac.types()).toContain("reasoning_item");
    expect(mac.rawLines.join("\n")).toContain(ENC_DUMMY);
    mac.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — a REAL e2e (official Claude -> Winter GPT): sweep the REAL captured request bodies, the
// REAL canonical transcript file, and a REAL session.history call.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("A-8 part B: real captures (official Claude -> Winter GPT)", (winterBin) => {
  describeWithClaudeRuntime("sweep the real request bodies + canonical file + session.history", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicRequests: Array<{ path: string; body: string }> = [];
    const anthropicScript: AnthropicTurnScript = {
      blocks: [
        { type: "thinking", chunks: ["reasoning about the sweep"], signature: SIG_DUMMY },
        { type: "text", chunks: ["the sweep answer"] },
      ],
      stopReason: "end_turn",
    };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "parity-sweep-b-")));
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {}, unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from gpt, after the handoff"] }),
      });
      openaiFakeRef = openaiFake;
      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const anthropicFakeServer = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => {
            anthropicRequests.push({ path: recorded.path, body: recorded.body });
            if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }],
      });
      anthropicFakeClose = () => anthropicFakeServer.close();
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: "openai/gpt-5.6-sol", baseUrl: openaiFake.url },
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 60, handoff: { crossRuntime: true } },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-sweep" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-sweep-anthropic" });
      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeServer.url }, authFamily: "custom" }),
      });
      if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
      client = await TestClient.connect(daemon.socketPath);
      await client.hello(daemon.tokens.harness, "e2e");
    });

    afterAll(async () => {
      try { client?.close(); } catch { /* closed */ }
      const stopping = daemon?.stop();
      daemon = undefined;
      await stopping;
      await openaiFakeRef?.close();
      await anthropicFakeClose?.();
      rmSync(home, { recursive: true, force: true });
    });

    test("SIG-DUMMY/redacted_thinking never leak into the foreign (openai) request; the canonical file and session.history are clean; I-3 holds", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;
      const PRIOR_TEXT = "remember P10B-SWEEP-1";
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: "claude-sonnet-5" });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("official");
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // I-1's designated sink: the fake's own `thinking`/`signature` block genuinely landed in the
      // canonical file (never a vacuous sweep) — asserted before the handoff, mirroring A-2's own
      // "first assert it landed" discipline.
      const record = rt.records.get(sessionId);
      if (record === undefined) throw new Error("no record");
      const findTranscriptFile = (root: string, backendSessionId: string): string | undefined => {
        if (!existsSync(root)) return undefined;
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name);
          if (entry.isDirectory()) {
            const found = findTranscriptFile(full, backendSessionId);
            if (found !== undefined) return found;
          } else if (entry.name === `${backendSessionId}.jsonl`) {
            return full;
          }
        }
        return undefined;
      };
      if (record.backendSessionId === undefined) throw new Error("no backendSessionId on the record");
      const transcriptFile = findTranscriptFile(home, record.backendSessionId);
      if (transcriptFile === undefined) throw new Error(`no canonical transcript file found for ${record.backendSessionId}`);
      const canonicalRaw = readFileSync(transcriptFile, "utf8");
      expect(canonicalRaw).toContain(SIG_DUMMY); // I-1's own designated sink — legitimately present here
      expect(canonicalRaw).not.toContain("<recovered_reasoning"); // I-2: the tag itself never persists

      // Prompt, confirmLossy, then the destination's own request.
      try { await client.call(METHODS.sessionSetModel, { sessionId, model: "openai/gpt-5.6-sol" }); } catch { /* expected to prompt */ }
      await client.call(METHODS.sessionSetModel, { sessionId, model: "openai/gpt-5.6-sol", confirmLossy: true });
      expect(d.winter.legOf(sessionId)).toBe("winter");

      // I-3: the destination's own credential locator names ONLY the fresh (openai) selection —
      // nothing from the anthropic source is merged in.
      const afterRecord = rt.records.get(sessionId);
      expect(afterRecord?.providerId).toBe("openai");
      expect(afterRecord?.authRef).toBe("keychain:openai:default");
      expect(afterRecord?.authRef).not.toContain("anthropic");

      // The destination's own outbound request (unaffected by Defect 2's event-drop — see
      // `handoff-parity-e2e.test.ts`'s header): SIG-DUMMY and redacted_thinking never appear.
      const before = openaiFakeRef!.requests.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "the last question" }).catch(() => { /* fire; see Defect 2 */ });
      {
        const t0 = Date.now();
        for (;;) {
          if (openaiFakeRef!.requests.length > before) break;
          if (Date.now() - t0 > 20_000) throw new Error("timed out waiting for the destination's request");
          await Bun.sleep(20);
        }
      }
      const lastReq = openaiFakeRef!.requests[openaiFakeRef!.requests.length - 1]!;
      const reqBody = JSON.stringify(lastReq.body ?? {});
      const found = sweep(reqBody);
      expect(found.sigDummy).toBe(false);
      expect(found.redactedThinking).toBe(false);
      // The prior text DOES carry (proving this is a real, populated request, not an empty one).
      expect(reqBody).toContain(PRIOR_TEXT);

      // session.history for this session, over the whole canonical run: same sweep, same result.
      const page = await client.call<{ events: SessionEvent[] }>(METHODS.sessionHistory, { sessionId });
      const historyRaw = JSON.stringify(page);
      const historyFound = sweep(historyRaw);
      expect(historyFound.sigDummy).toBe(false);
      expect(historyFound.redactedThinking).toBe(false);
      expect(historyFound.tag).toBe(false);
    }, 90_000);
  });
});
