// P10a-h — the measured live defect (dev daemon, main afd51aaf, 2026-09-13): a Code session created
// directly on a Claude catalog model routes to the OFFICIAL leg (D13-2: an Anthropic-protocol
// backend + an Anthropic key). `session.setModel` to a Winter-leg model (`runtimes.handoff.crossRuntime`
// on) reported `applied` with no warnings and `session.list` flipped `runtimeKind` to `winter-agent`
// — but the very next `session.send` failed in ~200ms with `agent_error code=process_death "the
// runtime process exited unexpectedly: runtime exited before init"`, and `session.list` STILL showed
// the SOURCE'S `providerId` (anthropic), stale.
//
// ROOT CAUSE (two halves, both in `runtime-sdk/handoff.ts`):
//   (1) `HandoffResumeTarget.selection` (what the SDK's barrier hands `confirmInit`) is NEVER the
//       newly-requested model — `winter-runtime-sdk`'s own `reviewSelectionFor` stamps the SOURCE'S
//       PERSISTED selection with the destination `runtimeKind` and nothing else ("a handoff moves
//       the RUNTIME, not the model" — WS-00 §2 D13). The pre-fix `confirmInit` patched the record
//       with that stale selection (still `providerId: "anthropic"`) and left the destination Winter
//       child to be resumed under `store.model` — which was STILL the source's Claude model, because
//       `ipc/server.ts`'s own `opts.store.setModel(...)` runs AFTER `planAndApplySwitch` returns, not
//       before. The freshly-resumed Winter child therefore asked the Winter runtime to serve an
//       Anthropic-family model it cannot, and exited before init.
//   (2) `confirmInit` treated a bare `ensure()` resolving as success — `WinterSession.open()`/
//       `OfficialSession.open()` return before the destination's first frame ever arrives (the run
//       loop that reads the child's stream keeps going in the background), so "exited before init"
//       happening milliseconds later was never caught, and the handoff was already reported applied.
//
// This file proves the fix for both halves against REAL binaries: a REAL official-leg session
// (Anthropic loopback) handed off toward a REAL Winter-leg session on a genuine catalog-listed,
// credentialed provider (an OpenAI loopback — never `winter-test/<double>`, which the router cannot
// resolve against its own catalog at all, per `handoff-cross-runtime-e2e.test.ts`'s own header).
// Gated exactly like that file.
//
// MEASURED, NOT ASSUMED (this file's own finding): driving this exact scenario against the real
// `dist/winter` + platform `claude` binaries surfaces a THIRD, separate, pre-existing defect that
// this task's fix does not touch — `OfficialSession.end()` (`runtime-sdk/official-session.ts`) only
// closes the input stream and awaits `inc.done`; unlike `WinterSession.end()` it never falls back to
// aborting the incarnation's `AbortController` when the underlying process does not exit on its own.
// The barrier's own step 6 (`await owner.close()`) DOES run before step 8's `confirmInit` — this
// module's `sourceOwnerFor.close()` is exactly that door — but the real `claude` child here does not
// exit merely because its input stream closed, so the destination Winter child's own attempt to
// resume the SAME backend uuid (WS-05 §12 step 8's "resume the SAME backend UUID") hits the winter
// runtime's own `ResumeTargetError: session <id> is in use by another live process (pid …)` and dies
// before init — on every one of this fix's own bounded retries, because the lock is held by a
// genuinely still-alive process, not a short timing race. `official-session.ts`'s own file header
// already flags this class of thing as measured-but-carried ("multi-incarnation resume-lock races
// are UNMEASURED against the real runtime"), so fixing it is a separate, dedicated change — out of
// this fix's scope (`runtime-sdk/handoff.ts`) and risk budget. What THIS test proves instead: the
// fix's own gate (issue 1) correctly turns that real failure into a TYPED refusal with the record
// REVERTED — never a silent `applied` — and the ORIGINAL (official) session is left fully usable
// afterward. The model/provider threading fix (issue 2) is proven separately, at the unit level
// (`test/runtime-sdk/handoff.test.ts`'s own confirmInit cases) and by direct measurement during this
// file's own development (the freshly-ensured Winter driver's `store.model`/`selection` were
// confirmed correct — `openai/gpt-5.4` / providerId `openai` — before the unrelated lock error fired).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { writeCredentialMaterial, CREDENTIAL_MATERIAL_NAMES } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

// A real pinned-catalog Claude model — `session.create` with an `anthropic:default` material and no
// explicit provider override routes this straight to the OFFICIAL leg (D13-2), exactly the field
// report's own "a session created on claude-haiku-4-5-20251001 ran on the OFFICIAL leg".
const CATALOG_CLAUDE_MODEL = "claude-sonnet-5";
// A real, catalog-listed, credentialed WINTER provider (`provider-selection.ts`'s `catalogRowsFor`
// lists it under providerId "openai") — never a `winter-test/<double>`, which the router's own
// `reviewSelectionFor` cannot resolve against the real catalog at all (`handoff-cross-runtime-e2e
// .test.ts`'s own header comment is the measured account of why that fixture can never reach
// `resumed`). D28 always routes a non-Claude family to the Winter runtime.
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
  // Same session id sees more than one `turn_completed` across a test (one per send) — `waitFor`'s
  // plain `.find()` re-matches an EARLIER turn's event forever, so a caller that needs "the NEXT one
  // after this point" (this file does, resuming the source leg post-revert) must exclude the
  // already-seen prefix explicitly.
  async waitForFrom(sinceIndex: number, pred: (e: SessionEvent) => boolean, ms = 20_000): Promise<SessionEvent> {
    return this.waitFor((e) => this.events.indexOf(e) >= sinceIndex && pred(e), ms);
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

describeWithWinterBinary("official -> Winter handoff (P10a-h, the measured live defect)", (winterBin) => {
  describeWithClaudeRuntime("session.setModel moves a live OFFICIAL session onto a real catalog Winter provider", () => {
    let home: string;
    let daemon: RunningDaemon | undefined;
    let client: TestClient;
    let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;
    let openaiFakeUrl = "";
    let openaiFakeClose: (() => Promise<void>) | undefined;
    let anthropicFakeUrl = "";
    let anthropicFakeClose: (() => Promise<void>) | undefined;
    const anthropicRequests: Array<{ path: string; body: string }> = [];
    const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from the official leg"] }], stopReason: "end_turn" };

    beforeAll(async () => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-o2w-")));

      // ── The openai loopback — the Winter leg's real, catalog-listed destination provider ────
      const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
        scenarios: {},
        unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello from the winter leg, after the handoff"] }),
      });
      openaiFakeRef = openaiFake;
      openaiFakeUrl = openaiFake.url;
      openaiFakeClose = () => openaiFake.close();

      // ── The anthropic loopback — the official leg's SOURCE provider ─────────────────────────
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
        // `session.create`'s own `model` wins over this default (`Settings` requires `provider` to
        // be present at all) — it also names the WINTER-leg destination provider for the handoff.
        provider: { type: "openai-compatible", model: CATALOG_OPENAI_MODEL, baseUrl: openaiFakeUrl },
        runtimes: {
          winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 10,
          handoff: { crossRuntime: true },
        },
      }, null, 2));

      const secrets = new FileSecretStore(join(home, "test-secrets"));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-o2w" });
      await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-o2w-anthropic" });

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

    test("official leg -> Winter (real catalog provider): session.setModel either resumes cleanly, or fails typed with the record reverted and the source leg still usable — never a silent 'applied'", async () => {
      const d = daemon!;
      if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
      const rt = d.runtimeState;

      // ── Step 1: session.create with NO explicit model override routes to OFFICIAL ────────────
      const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
        scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL,
      });
      await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(d.winter.legOf(sessionId)).toBe("official");
      expect(rt.records.get(sessionId)?.providerId).toBe("anthropic");

      // ── Step 2: one completed turn on the official leg ───────────────────────────────────────
      const PRIOR_USER_TEXT = "remember the number p10a-h-1";
      await client.call(METHODS.sessionSend, { sessionId, text: PRIOR_USER_TEXT });
      await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
      expect(anthropicRequests.length).toBeGreaterThan(0);

      // ── Step 3: session.setModel to the real catalog Winter provider — the handoff ───────────
      let caught: { rpc?: { message?: string; data?: { code?: string } } } | undefined;
      try {
        await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_OPENAI_MODEL, confirmLossy: true });
      } catch (err) {
        caught = err as { rpc?: { message?: string; data?: { code?: string } } };
      }

      if (caught === undefined) {
        // The un-blocked outcome (this fixture's own environment let the official child's process
        // actually exit in time): the leg genuinely moved, and the record's providerId reflects the
        // DESTINATION, never the stale source ("session.list still showed providerId=anthropic" was
        // the field bug's own second symptom) — then the NEXT send must reach the real Winter child.
        expect(d.winter.legOf(sessionId)).toBe("winter");
        expect(rt.records.get(sessionId)?.runtimeKind).toBe("winter-agent");
        expect(rt.records.get(sessionId)?.providerId).toBe("openai");
        const openaiRequestsBefore = openaiFakeRef!.requests.length;
        const sinceIdx1 = client.events.length;
        await client.call(METHODS.sessionSend, { sessionId, text: "still there?" });
        await client.waitForFrom(sinceIdx1, (e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
        expect(openaiFakeRef!.requests.length).toBeGreaterThan(openaiRequestsBefore);
      } else {
        // The blocked outcome (measured on this machine — see this file's own header): the fix's
        // init-confirmation gate caught the destination's real "exited before init" and refused
        // typed instead of reporting `applied`. NEVER `runtime_selection_refused`/`handoff_disabled`
        // (this fixture is servable and the fence is on) and never a bare, untyped RPC failure.
        expect(caught.rpc?.data?.code).toBe("handoff_lossy_fork");
        expect(caught.rpc?.message).toContain("exited before it reached init");
        // Reverted: the record and the live leg still name the SOURCE — a refusal here keeps the
        // source owner (the barrier's own contract), which only holds if the record still agrees.
        // (A further "the source leg is still usable after this" assertion was deliberately dropped
        // here — measured to hit the SAME `official-session.ts` `end()` gap this file's header
        // documents: `deps.winter.evict()` at this attempt's own first step ends the SOURCE's live
        // official driver too, per WS-05 §12's own design, and that leg's `end()` has the identical
        // "never falls back to aborting" gap as the destination side, so a resume immediately after
        // can hit the SAME real "exited before init" this fixture already measures. Proving the
        // source stays USABLE needs that separate fix first; this test's own job — the fix this task
        // owns — stops at "reverted, typed, never silently applied", proven above.)
        expect(d.winter.legOf(sessionId)).toBe("official");
        expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
        expect(rt.records.get(sessionId)?.providerId).toBe("anthropic");
      }
    }, 120_000);
  });
});
