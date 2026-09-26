// WS-24 — THE COMPACTION-ON-SWITCH PROMPT, END TO END, through a real daemon and the real `winter`
// binary, every provider a loopback fake.
//
// What WS-23 (reasoning-state, decision 5) added, and what this file drives from the wire in:
//   1. a provider-changing `session.setModel` whose history does not fit the target's window ASKS —
//      `handoff_confirmation_required`, carrying the review's `fit` ({fits, estimatedTokens, window});
//   2. confirmed (`confirmLossy`), the switch applies at once, and the live child COMPACTS ON ITS SOURCE
//      MODEL first (`runtime-sdk/handoff.ts`'s `compactFirst` → `WinterSession.compact`), announcing it in
//      the transcript (`continuity_warning`, warning `switch_compaction`) — the model being left pays for
//      the summary;
//   3. the child is then replaced, and the next turn goes to the TARGET, resuming from the compacted
//      transcript: the summary is in what the target is sent, the oversized history is not.
//
// The source is `openai/gpt-5.6-sol` (a 1.05M-token window, so it never compacts on its own here) on the
// Responses fake; the target is `zai/glm-5` (a 200k window) on a chat-completions fake. ~700k characters
// in the FIRST exchange (the review estimates ~240k tokens, five-hop part 2's measured shape), then five
// small exchanges, so the recent exchanges a compaction keeps verbatim are small ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiChatFake, openaiResponsesFake, startFake, type FakeServer } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { describeWithWinterBinary } from "../helpers/winter-binary";

const SOURCE_MODEL = "openai/gpt-5.6-sol";
const TARGET_MODEL = "zai/glm-5";
/** What the SOURCE's fake answers a compaction request with — distinctive, so the target's request body
 *  can be checked for it (and it can never be mistaken for an ordinary turn's reply). */
const SOURCE_SUMMARY = "SWITCH-SUMMARY-7f3a: the user pasted a long document of the letter a, then asked two short questions.";
/** An ordinary turn's reply from each side. */
const SOURCE_REPLY = "ok from gpt";
const TARGET_REPLY = "hello from glm";
/** The long first message's own marker, and a run of it long enough that finding it proves the raw
 *  history travelled. */
const LONG_RUN = "a".repeat(10_000);
/** Exchanges on the source before the switch: the oversized one plus five small ones. */
const SOURCE_TURNS = 6;

/** The runtime's compaction request (`compaction/summarizer.ts`: its instruction is the last user
 *  message, or the system prompt) — recognised on the wire by its own words. */
const isCompactionRequest = (body: string): boolean => body.includes("compacting a conversation") || body.includes("is being compacted");

type RpcErrorLike = Error & { rpc?: { code: number; message: string; data?: { code?: string; fit?: { fits?: boolean; estimatedTokens?: number; window?: number } } } };

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
  async waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; saw: ${this.events.map((e) => e.type).join(",")}`);
      await Bun.sleep(25);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

describeWithWinterBinary("WS-24: the compaction-on-switch prompt, end to end (real daemon, real winter child, fake providers)", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let source: FakeServer | undefined;
  let target: FakeServer | undefined;
  /** Every request each fake answered, in order, with what kind it was. */
  const sourceLog: Array<{ kind: "compaction" | "turn"; model: string }> = [];
  const targetBodies: string[] = [];

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ws24-switch-compaction-")));
    source = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {},
      unknownModel: async (recorded) => {
        let model = "<unparseable>";
        try { model = String((JSON.parse(recorded.body) as { model?: unknown }).model); } catch { /* keep the marker */ }
        const kind = isCompactionRequest(recorded.body) ? "compaction" : "turn";
        sourceLog.push({ kind, model });
        return openaiResponsesFake.responsesStream({ text: [kind === "compaction" ? SOURCE_SUMMARY : SOURCE_REPLY] });
      },
    });
    target = await startFake({
      routes: [{
        path: "*",
        handler: (_req, recorded) => {
          if (!recorded.path.endsWith("/chat/completions")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          targetBodies.push(recorded.body);
          return openaiChatFake.chatStream({ text: [TARGET_REPLY], finishReason: "stop" });
        },
      }],
    });
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 3,
      provider: { model: SOURCE_MODEL },
      providers: { openai: { baseUrl: source.url }, zai: { baseUrl: `${target.url}/v1` } },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 120 },
    }, null, 2));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-ws24-openai" });
    await writeCredentialMaterial(secrets, "zai:default", { kind: "api-key", key: "sk-test-ws24-zai" });
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "e2e");
  });

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await source?.close();
    await target?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("prompt → confirm → the SOURCE model compacts → the next turn goes to the TARGET with the summary, not the raw history", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ws24-switch-compaction-cwd-")));
    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: SOURCE_MODEL, cwd });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const turns = (): number => client.events.filter((e) => e.type === "turn_completed" && e.sessionId === sessionId).length;

    // The oversized exchange first, then more small ones than a compaction keeps verbatim (the runtime
    // retains the most recent FOUR exchanges, `compaction/retention.ts`), so the oversized one is what the
    // source summarizes. (With fewer, it is retained, the conversation still does not fit, and the target's
    // own fit check compacts it on the target instead — the designed fallback, not what this file pins.)
    await client.call(METHODS.sessionSend, { sessionId, text: `a long document: ${"a".repeat(700_000)}` });
    await client.waitUntil(() => turns() >= 1, 90_000, "turn 1 on the source");
    for (let i = 2; i <= SOURCE_TURNS; i += 1) {
      await client.call(METHODS.sessionSend, { sessionId, text: `short question ${i}` });
      await client.waitUntil(() => turns() >= i, 60_000, `turn ${i} on the source`);
    }
    expect(sourceLog.filter((r) => r.kind === "turn")).toHaveLength(SOURCE_TURNS);
    expect(sourceLog.some((r) => r.kind === "compaction")).toBe(false); // the source never needed to compact on its own

    // 1. Unconfirmed: the switch ASKS, carrying the fit, and nothing moves.
    let caught: RpcErrorLike | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: TARGET_MODEL });
    } catch (err) { caught = err as RpcErrorLike; }
    expect(caught?.rpc?.data?.code).toBe("handoff_confirmation_required");
    expect(caught?.rpc?.data?.fit?.fits).toBe(false);
    expect(caught?.rpc?.data?.fit?.window).toBe(200_000);
    expect(caught?.rpc?.data?.fit?.estimatedTokens ?? 0).toBeGreaterThan(200_000);
    expect(d.runtimeState.records.get(sessionId)?.providerId).toBe("openai");

    // 2. Confirmed: applied at once (the compaction runs behind the reply, not before it).
    await client.call(METHODS.sessionSetModel, { sessionId, model: TARGET_MODEL, confirmLossy: true });
    expect(d.runtimeState.records.get(sessionId)?.providerId).toBe("zai");

    // A message sent right away is held while the source compacts, then answered by the target.
    await client.call(METHODS.sessionSend, { sessionId, text: "after the switch" });
    await client.waitUntil(() => turns() >= SOURCE_TURNS + 1, 120_000, "the first turn after the switch");

    // The source compacted — on the SOURCE model — before the target was ever reached.
    const compactions = sourceLog.filter((r) => r.kind === "compaction");
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    expect(compactions.every((r) => r.model === "gpt-5.6-sol")).toBe(true);
    // …and the transcript says so, in the words the handoff announces.
    const warning = client.events.find((e) => e.type === "continuity_warning" && e.sessionId === sessionId) as (SessionEvent & { warning?: string; text?: string }) | undefined;
    expect(warning?.warning).toBe("switch_compaction");
    expect(warning?.text).toContain("summarizing its older part before the switch");

    // 3. The next turn went to the target, resumed from the compacted transcript — which now FITS: the target
    // never had to compact anything itself (one request, an ordinary turn), and the one continuity warning is
    // the handoff's own.
    expect(targetBodies).toHaveLength(1);
    const last = targetBodies[0]!;
    expect(isCompactionRequest(last)).toBe(false);
    expect(last).toContain("SWITCH-SUMMARY-7f3a");
    expect(last).toContain(`short question ${SOURCE_TURNS}`); // the recent exchanges carried over verbatim
    expect(last).toContain("after the switch");
    expect(last.includes(LONG_RUN)).toBe(false);
    expect(client.events.filter((e) => e.type === "continuity_warning" && e.sessionId === sessionId)).toHaveLength(1);
    // The source was not asked for anything after its compaction: the post-switch turn is the target's.
    expect(sourceLog.filter((r) => r.kind === "turn")).toHaveLength(SOURCE_TURNS);
    const lastReply = [...client.events].reverse().find((e) => e.type === "assistant_message" && e.sessionId === sessionId) as (SessionEvent & { text?: string }) | undefined;
    expect(JSON.stringify(lastReply)).toContain(TARGET_REPLY);

    rmSync(cwd, { recursive: true, force: true });
  }, 300_000);
});
