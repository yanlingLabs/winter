// Phase 8d Task 3.3 (P8d-9) — THE BOUNDED cross-runtime `resumed` attempt. ONE construction, ONE
// observed outcome, recorded verbatim; no fence change (`runtimes.handoff.crossRuntime` stays
// default OFF everywhere except this test's own temp settings).
//
// Construction per the brief: a loopback OpenAI-compatible fake, `settings.provider` naming a CLAUDE
// CATALOG model id ("claude-sonnet-5") under a `type: "openai-compatible"` (custom/non-Anthropic-
// protocol) row -> `session.create` (mode code) -> expected the Winter leg (D13: "non-Anthropic
// protocol -> Winter") -> `session.setModel` to a Claude model on the real Anthropic protocol with
// `confirmLossy: true` -> observe the barrier -> `resumed` or the exact refusal.
//
// MEASURED, NOT ASSUMED (see the single test's own body for the verbatim outcome), CORRECTED
// ATTRIBUTION (review fix F4 — the round-1 header named the wrong function): `session-driver.ts`'s
// `create()` calls `decideRuntime()` FIRST, which — because `catalogRowsFor("claude-sonnet-5")` is
// non-empty (bail-out #4 does not fire) — consults the ROUTER's OWN `selectRuntimeFor` (the real
// `selectRuntime`, fed `familyListingFromCatalog()` + `credentialPresenceFrom`). THAT call is what
// decides "claude-agent" here, because a real `anthropic:default` credential is configured (this
// construction needs one for a servable Claude destination to exist at all) — and `create()` then
// returns via `createOfficial` (session-driver.ts:778) BEFORE it ever reaches the WINTER-branch code
// at line ~793 that builds `Options.provider` through `provider-selection.ts#providerSelectionFor`.
// That function is a DIFFERENT, later-stage helper (it only runs for a session the router already
// decided is on the Winter leg) and was NEVER REACHED in this test at all — it played no part in the
// outcome. Controller ruling P8d-20: the construction is UNSATISFIABLE AS SPECIFIED — a servable
// Claude destination needs the exact Anthropic credential that routes the SOURCE session to the
// official leg too, so "a Claude catalog model id under a custom provider row, expected to land on
// the Winter leg" cannot coexist with "a genuine resumed destination" in this deployment's own
// selection order. Recorded as the measurement, not papered over.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CLAUDE_CATALOG_MODEL = "claude-sonnet-5"; // a real, pinned-catalog Claude canonical model id
const DESTINATION_CLAUDE_MODEL = "claude-sonnet-5"; // the destination is the SAME canonical id, on the real Anthropic protocol

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
    const p = new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve) => this.pending.set(id, resolve));
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    const r = await p;
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

describeWithWinterBinary("P8d-9 -- the bounded cross-runtime resumed attempt", (winterBin) => {
  describeWithClaudeRuntime("a Claude catalog model id served over a custom (non-Anthropic-protocol) provider row", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient | undefined;
    let openaiFakeUrl = "";
    let openaiFakeClose: (() => Promise<void>) | undefined;
    let anthropicFakeUrl = "";
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from the destination"] }], stopReason: "end_turn" };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "winter-p8d9-")));

      const { startFake: startOpenAiFake } = await import("@yanlinglabs/winter-provider-conformance");
      const openaiFake = await startOpenAiFake({ routes: [{ path: "*", handler: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) }] });
      openaiFakeUrl = openaiFake.url;
      openaiFakeClose = () => openaiFake.close();

      const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
      const anthropicFakeServer = await startFake({
        routes: [{
          path: "*",
          handler: async (_req, recorded) => {
            if (recorded.path === "/v1/messages" && recorded.method === "POST") return anthropicFake.anthropicTurnResponse(anthropicScript);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }],
      });
      anthropicFakeUrl = anthropicFakeServer.url;
      anthropicFakeClose = () => anthropicFakeServer.close();

      // Construction, per the brief: `settings.provider` is `openai-compatible` (a custom,
      // non-Anthropic-protocol row) naming the CLAUDE CATALOG model id.
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: CLAUDE_CATALOG_MODEL, baseUrl: openaiFakeUrl },
        runtimes: {
          winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10,
          handoff: { crossRuntime: true },
        },
      }, null, 2));

      const secrets = new FileSecretStore(join(home, "test-secrets"));
      // A REAL anthropic:default credential IS configured (needed for the destination leg to be
      // servable at all — a `resumed` round trip needs a genuine Anthropic-protocol destination).
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-p8d9" });

      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
      });
      if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
      client = await TestClient.connect(daemon.socketPath);
      await client.hello(daemon.tokens.harness, "p8d9");
    });

    afterAll(async () => {
      try { client?.close(); } catch { /* closed */ }
      const stopping = daemon?.stop();
      daemon = undefined;
      await stopping;
      await openaiFakeClose?.();
      await anthropicFakeClose?.();
      rmSync(home, { recursive: true, force: true });
    });

    test("ONE bounded attempt: construction -> session.create's actual leg -> session.setModel's barrier outcome, recorded verbatim", async () => {
      const d = daemon!;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-p8d9-cwd-")));

      const { sessionId } = await client!.call<{ sessionId: string }>(METHODS.sessionCreate, {
        scope: "e2e", mode: "code", model: CLAUDE_CATALOG_MODEL, cwd,
      });
      await client!.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const createdLeg = d.winter.legOf(sessionId);
      console.warn(`[p8d9] MEASURED: session.create with a Claude catalog model id under an openai-compatible provider row landed on leg="${createdLeg}" (the construction's own premise was "expect the Winter leg", D13 — see this file's header, corrected per review F4: the router's OWN selectRuntimeFor, via decideRuntime, made this call BEFORE providerSelectionFor's Winter-branch code is ever reached — P8d-20: unsatisfiable as specified).`);

      if (createdLeg === "official") {
        // MEASURED: the construction's premise did not hold — Winter's `providerSelectionFor`
        // resolved the bare catalog id to the credentialed "anthropic" row regardless of
        // `settings.provider.type`, so `decideRuntime` routed straight to the official leg at
        // CREATE time. There is no Winter-leg source session to attempt a handoff FROM — this is
        // the exact, honest blocker; the attempt stops here (ONE attempt, per the brief).
        console.warn("[p8d9] STOPPED (measured, not a bug): the source session is already on the official leg — no cross-runtime handoff to attempt. P8d-20: unsatisfiable as specified — see the file header.");
        expect(createdLeg).toBe("official"); // pin the measured fact
        rmSync(cwd, { recursive: true, force: true });
        return;
      }

      expect(createdLeg).toBe("winter");
      let caught: { rpc?: { message?: string; data?: { code?: string } } } | undefined;
      try {
        await client!.call(METHODS.sessionSetModel, { sessionId, model: DESTINATION_CLAUDE_MODEL, confirmLossy: true });
      } catch (err) {
        caught = err as typeof caught;
      }
      const legAfter = d.winter.legOf(sessionId);
      console.warn(`[p8d9] MEASURED: session.setModel outcome -- ${caught === undefined ? `SUCCESS, legAfter="${legAfter}"` : `refused code="${caught.rpc?.data?.code}" message="${caught.rpc?.message}"`}`);
      // Recorded verbatim -- no fence change, no second attempt, whichever branch this measures.
      rmSync(cwd, { recursive: true, force: true });
    }, 60_000);
  });
});
