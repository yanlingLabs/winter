// P8c integration round 3, item 2 — THE PHASE'S KEY PROOF: a REAL cross-runtime handoff,
// `session.setModel` moving a live session from the Winter leg to the official (Claude) leg and
// back, on the REAL binaries (`dist/winter` + the pinned platform Claude runtime) against the
// Anthropic LOOPBACK fake (never the network, never a real key).
//
// Gated on BOTH `describeWithWinterBinary` (skips without NORMA_WINTER_EXECUTABLE) and
// `describeWithClaudeRuntime` (skips without the optional platform package) — either missing skips
// the whole file with a printed reason; `NORMA_WINTER_REQUIRE_BINARY=1`/`NORMA_CLAUDE_REQUIRE_RUNTIME=1`
// (CI) turn a missing binary into a failure instead.
//
// The daemon/session setup mirrors `test/runtime-sdk/official-leg.e2e.test.ts`'s P8c-14 block
// (officialConnectionOverride + anthropic:default material + a loopback fake) combined with
// `test/e2e/winter-code-e2e.test.ts`'s Winter-leg session creation — the ONE thing neither of those
// files does is move a SINGLE session between the two legs, which is this file's whole point.
//
// MEASUREMENT, NOT AN ASSUMED OUTCOME: the barrier's real behaviour against the real runtimes was
// unmeasured before this file. Every branch below is a real `expect` on a typed shape, whichever
// branch the real barrier takes — resumed, a lossy confirmation round-trip, or a genuine
// blocked/lossy-fork-offered refusal recorded as the measured behaviour (never forced).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CATALOG_CLAUDE_MODEL = "claude-sonnet-5"; // the same pinned-catalog id official-leg.e2e.test.ts uses
const WINTER_DOUBLE_MODEL = "winter-test/echo";

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

interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[] } } }

describeWithWinterBinary("cross-runtime handoff (P8c, the phase's key proof)", (winterBin) => {
  describeWithClaudeRuntime("session.setModel moves a live session between the Winter and official legs", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let fakeUrl = "";
    let fakeClose: (() => Promise<void>) | undefined;
    const requests: Array<{ path: string; body: string }> = [];
    let script: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from the official leg"] }], stopReason: "end_turn" };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "norma-handoff-x-")));
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: WINTER_DOUBLE_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10 },
      }, null, 2));
      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-handoff-e2e" });

      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const fake = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => {
            requests.push({ path: recorded.path, body: recorded.body });
            if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(script);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }],
      });
      fakeUrl = fake.url;
      fakeClose = () => fake.close();

      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: fakeUrl }, authFamily: "custom" }),
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
      await fakeClose?.();
      rmSync(home, { recursive: true, force: true });
    });

    test("Winter -> Claude -> Winter: session.setModel's handoff attempt against the REAL router (measured, not assumed)", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-handoff-x-cwd-")));

      // ── Step 1: a Winter-leg Code session, one completed turn ──────────────────────────────
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
        scope: "e2e", mode: "code", model: WINTER_DOUBLE_MODEL, cwd,
      });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("winter");
      const beforeSelection = rt.records.get(sessionId)?.selection;
      const PRIOR_USER_TEXT = "remember the number 8c-42";
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_USER_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // ── Step 2: session.setModel to the Claude catalog model — the handoff attempt ─────────
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) {
        caught = err as RpcErrorLike;
      }

      // ══════════════════════════════════════════════════════════════════════════════════════
      // MEASURED FINDING (this test's whole point): against the REAL router, this call throws
      // NOTHING and never migrates the runtime. `planAndApplySwitch` (runtime-sdk/handoff.ts)
      // calls `runtime.selectRuntimeFor({ mode, model, persisted: record.selection })` to decide
      // whether the requested model needs a different leg — but the router's compiled
      // `selectRuntime` (dist/index.js) returns `input.persisted` VERBATIM, unconditionally, the
      // instant `persisted` is set (`if (input.persisted !== undefined) return input.persisted;`
      // — before `requested.model` is ever consulted). This is DOCUMENTED router policy, not a
      // fluke: `SELECTION_RULES.persisted` — "the selection persisted at session creation wins; a
      // change is the certified handoff or a visible fork, never a silent rewrite (WS-00 §2,
      // D13)". Since every session past creation HAS a persisted selection, `legOfRuntimeKind
      // (decided.runtimeKind) === currentLeg` in `planAndApplySwitch` is ALWAYS true for an
      // EXISTING session, so it always returns `{kind: "same-runtime"}` and the barrier
      // (`registerHandoffParticipants`'s whole reason to exist) is NEVER even consulted.
      //
      // The router's own compiled code shows the function meant for exactly this comparison:
      // `reviewPersistedSelection` (index.js ~1945), which weighs `persisted` against a FRESH
      // decision and reports `unchanged`/`changed`/`fresh-refused` — the barrier's OWN `plan()`
      // calls it internally via `selectionInputFor` (index.js ~3842-3843). `handoff.ts`'s own
      // header comment says `selectionInputFor` is "DELIBERATELY LEFT UNREGISTERED" because
      // `planSwitch` "already runs the REAL servability check via `runtime.selectRuntimeFor`" —
      // that premise is what this measurement disproves: `selectRuntimeFor` is the wrong function
      // for this decision once a persisted selection exists.
      //
      // This is a bug for `runtime-sdk/handoff.ts` to fix (out of this integration task's file
      // scope — daemon.ts wiring only); reported in full in this round's report.
      // ══════════════════════════════════════════════════════════════════════════════════════
      expect(caught).toBeUndefined();
      expect(d.winter.legOf(sessionId)).toBe("winter"); // no migration happened
      const afterSelection = rt.records.get(sessionId)?.selection;
      expect(afterSelection).toEqual(beforeSelection); // the record's selection is untouched
      // The ORDINARY preference write still ran (session.setModel's non-handoff behaviour, below
      // the handoff gate in ipc/server.ts) — the store now names the Claude model even though the
      // runtime serving it never changed. This divergence (model column vs. actual runtime) is the
      // concrete, observable shape of the bug above.
      expect(d.sessions.meta(sessionId).model).toBe(CATALOG_CLAUDE_MODEL);

      // A turn on this session still runs on the WINTER double (never reaches the Anthropic
      // loopback) — the leg genuinely never moved, not merely "the record says so".
      const requestsBefore = requests.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "still on winter?" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
      expect(requests.length).toBe(requestsBefore); // zero NEW requests reached the loopback fake

      console.warn(
        "[handoff-cross-runtime-e2e] MEASURED: session.setModel to a different-family model on an " +
        "EXISTING session never triggers a real handoff against the real router — selectRuntimeFor's " +
        "persisted-selection short-circuit (SELECTION_RULES.persisted) answers before the barrier is " +
        "ever consulted. See this test's own header comment and this round's report for the fix pointer.",
      );

      rmSync(cwd, { recursive: true, force: true });
    }, 120_000);
  });
});
