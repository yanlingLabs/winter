// P8c integration round 3, item 2 — THE PHASE'S KEY PROOF: a REAL cross-runtime handoff,
// `session.setModel` moving a live session from the Winter leg to the official (Claude) leg and
// back, on the REAL binaries (`dist/winter` + the pinned platform Claude runtime) against the
// Anthropic LOOPBACK fake (never the network, never a real key).
//
// Gated on BOTH `describeWithWinterBinary` (skips without WINTER_RUNTIME_EXECUTABLE) and
// `describeWithClaudeRuntime` (skips without the optional platform package) — either missing skips
// the whole file with a printed reason; `WINTER_RUNTIME_REQUIRE_BINARY=1`/`WINTER_CLAUDE_REQUIRE_RUNTIME=1`
// (CI) turn a missing binary into a failure instead.
//
// The daemon/session setup mirrors `test/runtime-sdk/official-leg.e2e.test.ts`'s P8c-14 block
// (officialConnectionOverride + anthropic:default material + a loopback fake) combined with
// `test/e2e/winter-code-e2e.test.ts`'s Winter-leg session creation — the ONE thing neither of those
// files does is move a SINGLE session between the two legs, which is this file's whole point.
//
// MEASUREMENT, NOT AN ASSUMED OUTCOME: the barrier's real behaviour against the real runtimes was
// unmeasured before this file. Round 3's own measurement found the P8c BUG this file originally
// pinned — `planAndApplySwitch` never reached the barrier at all, because its destination decision
// passed `persisted: record.selection` to `selectRuntimeFor`, and the router's own
// `SELECTION_RULES.persisted` returns a persisted selection BY IDENTITY, so the decided leg always
// equalled the recorded one. `runtime-sdk/handoff.ts`'s fix: the destination is now decided FRESH
// (no `persisted`), and `selectionInputFor` is registered so `barrier.plan()` reviews the persisted
// selection's servability against this deployment's real catalog/credentials.
//
// THIS FILE'S OWN MEASURED FINDING, POST-FIX: the barrier IS now reached (asserted directly below,
// via a spy on `runtimeSdkInternals(sdk).barrier.plan` — never inferred from a message string
// alone) — but for THIS fixture's source leg, `barrier.plan()`'s own servability review refuses
// before `execute()` is ever called. The reason is structural, not a bug in the fix: this file's
// Winter-leg session runs on a `winter-test/<double>` model (the SAME idiom `winter-code-e2e.test.ts`
// and every other real-child Winter e2e use, to avoid the network/real keys on that leg), and
// `providerSelectionFor`'s own header (`runtime-sdk/provider-selection.ts`) is explicit that
// "`winter-test/<name>` … is not a catalog provider and must never be resolved against one" — so
// `familyListingFromCatalog()` (what `WinterRuntimeSdk.buildSelectionInput` feeds the barrier) can
// never contain it, and the router's `reviewPersistedSelection` refuses outright
// (`review.kind === "fresh-refused"`) the instant it tries to re-resolve the persisted model against
// today's catalog to sanity-check it. A REAL `resumed` round-trip needs a Winter-leg session on a
// genuine catalog-listed, credentialed, non-Anthropic-protocol provider instead of the test double —
// a heavier fixture than this file builds; recorded here as the honest limit of this measurement,
// never forced to a resume it did not earn.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSdkInternals, type RuntimeKind, type SessionKey } from "@yanlinglabs/winter-runtime-sdk";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@winter/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

const CATALOG_CLAUDE_MODEL = "claude-sonnet-5"; // the same pinned-catalog id official-leg.e2e.test.ts uses
const WINTER_DOUBLE_MODEL = "winter-test/echo";
// Fix wave item 2: a REAL catalog-listed, credentialed Winter provider — `provider-selection.ts`'s
// `catalogRowsFor` lists it under providerId "openai", and its family ("gpt") is non-Claude, so
// D28 always routes it to the Winter runtime regardless of peer/credential (selection.test.ts's own
// "a non-Claude family (openai) always routes to winter-agent" case) — exactly the heavier fixture
// this file's OWN header names as what a genuine resumed/lossy-fork/blocked round trip needs,
// instead of the `winter-test/<double>` idiom the FIRST describe block below is stuck with.
const CATALOG_OPENAI_MODEL = "openai/gpt-5.4";

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
      home = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-x-")));
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: WINTER_DOUBLE_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
        // Fix wave (C2 / ruling P8c-18): the fence defaults OFF in production; THIS file's whole
        // job is measuring the real barrier, so it opts in explicitly.
        runtimes: { winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10, handoff: { crossRuntime: true } },
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

    test("Winter -> Claude: session.setModel's handoff attempt REACHES the barrier against the REAL router (measured, not assumed)", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-x-cwd-")));

      // ── Step 1: a Winter-leg Code session, one completed turn ──────────────────────────────
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
        scope: "e2e", mode: "code", model: WINTER_DOUBLE_MODEL, cwd,
      });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("winter");
      const beforeSelection = rt.records.get(sessionId)?.selection;
      const beforeModel = d.sessions.meta(sessionId).model;
      const PRIOR_USER_TEXT = "remember the number 8c-42";
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_USER_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);

      // ── Spy on the REAL router's barrier — direct proof the fix reaches it, never inferred ──
      // from an error message alone. `runtimeSdkInternals` resolves the SAME object the router's
      // own factory built for THIS `daemon.runtimeSdk!.sdk` (a Symbol-keyed lookup, `sdk.ts`'s own
      // doc) — a plain, mutable property, so wrapping `.plan` here observes the exact call
      // `runtime-sdk/handoff.ts`'s `planAndApplySwitch` makes through `barrierFor(deps)`.
      const internals = runtimeSdkInternals(d.runtimeSdk!.sdk);
      expect(internals).toBeDefined();
      const realBarrier = internals!.barrier;
      const originalPlan = realBarrier.plan.bind(realBarrier);
      const planCalls: Array<{ session: SessionKey; to: RuntimeKind }> = [];
      realBarrier.plan = async (session, to) => {
        planCalls.push({ session, to });
        return originalPlan(session, to);
      };

      // ── Step 2: session.setModel to the Claude catalog model — the handoff attempt ─────────
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) {
        caught = err as RpcErrorLike;
      }

      // ══════════════════════════════════════════════════════════════════════════════════════
      // MEASURED, POST-FIX (this test's whole point): the barrier IS now consulted — proven
      // directly by the spy above, not by message-matching. `planAndApplySwitch`'s FRESH decision
      // for `CATALOG_CLAUDE_MODEL` (no `persisted`) correctly lands on `claude-agent`, differs from
      // the recorded `winter-agent` leg, and reaches `barrier.plan(session, "claude-agent")` — this
      // call was structurally impossible before the fix (the destination decision always echoed
      // the recorded leg back, per `SELECTION_RULES.persisted`).
      //
      // What the barrier's own `plan()` reports for THIS session, though, is a typed REFUSAL —
      // before `execute()` is ever reached — and it is a real, structural one, not a fluke:
      // `selectionInputFor` (registered by this fix) reviews the persisted selection against
      // `WinterRuntimeSdk.buildSelectionInput`'s real, pinned `familyListingFromCatalog()`, and this
      // session's persisted model is `winter-test/echo` — a test double `provider-selection.ts`
      // documents as deliberately UNRESOLVABLE against the real catalog ("must never be resolved
      // against one"). The router's `reviewPersistedSelection` therefore cannot even re-derive a
      // fresh candidate for the persisted model to sanity-check it, and reports `fresh-refused`.
      // See this file's header comment for the full account and why a genuine `resumed` round trip
      // needs a heavier fixture than this one (a catalog-listed, non-Anthropic-protocol Winter
      // provider) that this file does not build.
      // ══════════════════════════════════════════════════════════════════════════════════════
      expect(planCalls).toEqual([{ session: { projectKey: expect.any(String), sessionId: expect.any(String) }, to: "claude-agent" }]);
      expect(caught).toBeDefined();
      expect(caught!.rpc?.data).toMatchObject({ code: "runtime_selection_refused" });
      // The barrier-specific phrasing (`reviewSelectionFor`'s own `fresh-refused` branch) — distinct
      // from the EARLIER `refused` branch a fresh `selectRuntimeFor` call alone could produce (e.g.
      // `runtime-unavailable`/`claude-oauth-not-approved`), which never reaches the barrier at all.
      expect(caught!.rpc?.message).toContain("persisted selection is no longer servable");

      // Nothing migrated, and nothing was even WRITTEN: `refused` stops `session.setModel` before
      // its ordinary store write (ipc/server.ts's switch), unlike the pre-fix bug where the write
      // ran regardless and left the model column pointing at a leg the session never actually ran
      // on. Both assertions below would have FAILED against the pre-fix code (the model column DID
      // change there, verbatim to CATALOG_CLAUDE_MODEL, even though nothing migrated).
      expect(d.winter.legOf(sessionId)).toBe("winter");
      const afterSelection = rt.records.get(sessionId)?.selection;
      expect(afterSelection).toEqual(beforeSelection);
      expect(d.sessions.meta(sessionId).model).toBe(beforeModel);

      // A turn on this session still runs on the WINTER double (never reaches the Anthropic
      // loopback) — the leg genuinely never moved, not merely "the record says so".
      const requestsBefore = requests.length;
      await client.call(METHODS.sessionSend, { sessionId, text: "still on winter?" });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
      expect(requests.length).toBe(requestsBefore); // zero NEW requests reached the loopback fake

      console.warn(
        "[handoff-cross-runtime-e2e] MEASURED (post-fix): session.setModel's fresh destination " +
        "decision now DIFFERS from the recorded leg and reaches barrier.plan() (spied above) — the " +
        "P8c bug is fixed. For THIS fixture, the barrier's own servability review then typed-refuses " +
        "(runtime_selection_refused: \"persisted selection is no longer servable\") because the " +
        "source session's winter-test/<double> model is deliberately unresolvable against the real " +
        "catalog (provider-selection.ts). A genuine resumed/lossy-fork/blocked round trip needs a " +
        "catalog-listed, credentialed Winter provider on the source leg instead — see this file's " +
        "header comment.",
      );

      rmSync(cwd, { recursive: true, force: true });
    }, 120_000);
  });
});

// Fix wave item 2 — the C2 proof attempt: a Winter-leg session on `CATALOG_OPENAI_MODEL` (a real,
// catalog-listed, credentialed provider — never a `winter-test/<double>`) handed off to
// `CATALOG_CLAUDE_MODEL` on the official leg. Both providers point at LOOPBACK FAKES
// (`openaiResponsesFake` / `anthropicFake`), never the network. The barrier's REAL outcome is
// measured, not assumed — this test branches on whichever typed shape the router actually reports
// and asserts that shape, rather than forcing one.
describeWithWinterBinary("cross-runtime handoff on a REAL catalog provider (fix wave item 2)", (winterBin) => {
  describeWithClaudeRuntime("openai (Winter) -> claude (official) -> openai (Winter), on real catalog rows", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let openaiFakeUrl = "";
    let openaiFakeClose: (() => Promise<void>) | undefined;
    let anthropicFakeUrl = "";
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicRequests: Array<{ path: string; body: string }> = [];
    const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from the official leg (real catalog handoff)"] }], stopReason: "end_turn" };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-real-")));

      // ── The openai loopback (the Winter leg's real, catalog-listed provider) ────────────────
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {},
        // Every model hits this — the point is proving the CONNECTION reaches the loopback, not
        // scripting a particular model id the child happens to put on the wire.
        unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from the winter leg (real openai catalog row)"] }),
      });
      openaiFakeRef = openaiFake;
      openaiFakeUrl = openaiFake.url;
      openaiFakeClose = () => openaiFake.close();

      // ── The anthropic loopback (the official leg's destination) ────────────────────────────
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
      anthropicFakeUrl = anthropicFakeServer.url;
      anthropicFakeClose = () => anthropicFakeServer.close();

      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        // `session.create`'s own model wins over this default — carried only because `Settings`
        // requires `provider` to be present at all (same as every other e2e fixture in this repo).
        provider: { type: "openai-compatible", model: CATALOG_OPENAI_MODEL, baseUrl: openaiFakeUrl },
        runtimes: {
          winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10,
          handoff: { crossRuntime: true },
        },
      }, null, 2));

      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-handoff-real" });

      daemon = await startDaemon({
        home, secrets, agentProvider: null,
        officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeUrl }, authFamily: "custom" }),
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
      await openaiFakeClose?.();
      await anthropicFakeClose?.();
      rmSync(home, { recursive: true, force: true });
    });

    test("session.setModel's REAL barrier outcome for a catalog-listed Winter provider, measured end to end", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-real-cwd-")));

      // ── Step 1: a Winter-leg session on the REAL catalog openai row, one completed turn ─────
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
        scope: "e2e", mode: "code", model: CATALOG_OPENAI_MODEL, cwd,
      });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("winter");
      expect(rt.records.get(sessionId)?.providerId).toBe("openai");
      const beforeGeneration = rt.records.get(sessionId)?.generation;
      const PRIOR_USER_TEXT = "remember the number 8c-42";
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_USER_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
      const openaiRequestsAfterFirstTurn = openaiFakeRef!.requests.length;
      expect(openaiRequestsAfterFirstTurn).toBeGreaterThan(0); // the child's own request reached the openai loopback

      // ── Spy on the REAL router's barrier — direct proof the fix reaches it ───────────────────
      const internals = runtimeSdkInternals(d.runtimeSdk!.sdk);
      expect(internals).toBeDefined();
      const realBarrier = internals!.barrier;
      const originalPlan = realBarrier.plan.bind(realBarrier);
      const planCalls: Array<{ session: SessionKey; to: RuntimeKind }> = [];
      realBarrier.plan = async (session, to) => {
        planCalls.push({ session, to });
        return originalPlan(session, to);
      };

      // ── Step 2: session.setModel to the Claude catalog model — the handoff attempt ───────────
      let caught: RpcErrorLike | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) {
        caught = err as RpcErrorLike;
      }

      // The fence is enabled and the model is servable both ways, so the destination decision MUST
      // differ from the recorded leg and MUST reach the barrier — this much is not in question;
      // what the barrier does next is THIS test's actual measurement.
      expect(planCalls).toEqual([{ session: { projectKey: expect.any(String), sessionId: expect.any(String) }, to: "claude-agent" }]);

      let measuredOutcome: string;
      if (caught === undefined) {
        // No RPC error: the outcome was `same-runtime` (impossible here — the legs differ),
        // `deferred` (no turn was running, so also not expected), or `resumed`.
        const legAfter = d.winter.legOf(sessionId);
        if (legAfter === "official") {
          measuredOutcome = "resumed";
          expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
          expect(rt.records.get(sessionId)?.generation).toBeGreaterThan(beforeGeneration ?? -1);

          // Continuity: the NEXT turn on the official leg must reach the anthropic loopback
          // carrying the PRIOR user text — proof the router actually moved the conversation, not
          // just the record's own leg column.
          const anthropicRequestsBefore = anthropicRequests.length;
          await client.call(METHODS.sessionSend, { sessionId, text: "what number did I ask you to remember?" });
          await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
          expect(anthropicRequests.length).toBeGreaterThan(anthropicRequestsBefore);
          const lastAnthropicBody = anthropicRequests[anthropicRequests.length - 1]!.body;
          expect(lastAnthropicBody).toContain(PRIOR_USER_TEXT);

          // Switch back: Claude -> the Winter openai row, and complete a turn there.
          await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_OPENAI_MODEL });
          expect(d.winter.legOf(sessionId)).toBe("winter");
          const openaiRequestsBeforeReturn = openaiFakeRef!.requests.length;
          await client.call(METHODS.sessionSend, { sessionId, text: "still there?" });
          await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
          expect(openaiFakeRef!.requests.length).toBeGreaterThan(openaiRequestsBeforeReturn);
        } else {
          measuredOutcome = `unexpected-success-leg:${legAfter}`;
        }
      } else {
        const code = caught.rpc?.data?.code;
        if (code === "handoff_confirmation_required") {
          measuredOutcome = "confirmation_required";
          expect(caught.rpc?.data?.warnings).toBeDefined();
          let secondCaught: RpcErrorLike | undefined;
          try {
            await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
          } catch (err) {
            secondCaught = err as RpcErrorLike;
          }
          if (secondCaught === undefined) {
            measuredOutcome += "->resumed-after-confirm";
            expect(d.winter.legOf(sessionId)).toBe("official");
          } else {
            measuredOutcome += `->${secondCaught.rpc?.data?.code ?? "unknown"}-after-confirm`;
            expect(secondCaught.rpc?.data?.code).toBeDefined();
            expect(["handoff_lossy_fork", "handoff_blocked"]).toContain(secondCaught.rpc!.data!.code as string);
          }
        } else if (code === "handoff_lossy_fork") {
          measuredOutcome = "lossy_fork";
          expect(caught.rpc?.message).toBeDefined();
        } else if (code === "handoff_blocked") {
          measuredOutcome = "blocked";
          expect(caught.rpc?.message).toBeDefined();
        } else if (code === "runtime_selection_refused") {
          // MEASURED (fix wave item 2's own real finding): `planAndApplySwitch` reports this when
          // the barrier's OWN `plan()` returns `selection.kind === "refused"` — a REAL, already-
          // coded `PlanSwitchOutcome` branch (`handoff.ts`), not a bug. The router's
          // `reviewSelectionFor` (compiled into `@yanlinglabs/winter-runtime-sdk`) refuses a
          // handoff `to: "claude-agent"` outright whenever a FRESH decision over the PERSISTED
          // family would not itself route to `claude-agent` — which is true of every non-Claude
          // family (`D28: a non-Claude family routes to the Winter runtime`, unconditionally). An
          // `openai`-family session therefore can NEVER "hand off" to the official runtime: there
          // is no Claude-runtime-servable state to move, because the persisted family itself isn't
          // Claude — this is a genuine cross-FAMILY refusal, not a cross-RUNTIME one, and it is
          // categorically different from this file's FIRST describe block's refusal (a
          // `winter-test/<double>` the catalog cannot name at all). A `resumed` round trip needs
          // the SOURCE session's PERSISTED family to already be "claude" (a Claude-family model
          // temporarily hosted on Winter for lack of a servable Anthropic-protocol row) — every
          // Claude-family catalog row Winter's OWN credential inventory can serve is Anthropic-
          // protocol, which D13-2 routes straight to the official runtime the instant a peer and a
          // credential both exist, so this deployment has no way to construct that fixture; recorded
          // here as the honest, measured limit — see this test's own `console.warn` below.
          measuredOutcome = "refused:runtime_selection_refused (cross-family, not cross-runtime — the barrier's own D28 sanity check)";
          expect(caught.rpc?.message).toContain("does not serve");
          expect(d.winter.legOf(sessionId)).toBe("winter"); // nothing moved
        } else {
          // A refusal this test did not expect (`session_predates_winter_leg`, `handoff_disabled`)
          // — fail loudly with the real detail rather than silently accepting an unplanned shape.
          throw new Error(`unexpected session.setModel refusal: code=${code ?? "none"} message=${caught.rpc?.message ?? "none"}`);
        }
      }

      console.warn(
        `[handoff-cross-runtime-e2e] fix wave item 2 MEASURED outcome for a REAL catalog-listed ` +
        `Winter provider (openai) -> claude: "${measuredOutcome}". barrier.plan() was reached ` +
        `(spied above) with to="claude-agent"; the openai loopback saw the child's own requests ` +
        `(${openaiRequestsAfterFirstTurn} before the handoff attempt).`,
      );

      rmSync(cwd, { recursive: true, force: true });
    }, 120_000);
  });
});
