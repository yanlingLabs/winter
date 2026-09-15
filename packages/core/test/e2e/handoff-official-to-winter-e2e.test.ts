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
// MEASURED, NOT ASSUMED (this file's own finding, P10a-h follow-up): driving this exact scenario
// against the real `dist/winter` + platform `claude` binaries surfaces a THIRD, separate,
// pre-existing defect. `OfficialSession.end()` (`runtime-sdk/official-session.ts`) has SINCE been
// fixed to fall back to aborting the incarnation's `AbortController` (SIGTERM-equivalent → bounded
// grace → give-up), mirroring `WinterSession.end()`'s exact shape — proven at the unit level
// (`official-session.test.ts`'s own "end() falls back to abort()" case, against a fake child that
// never exits on its own). That fix did NOT resolve this file's own real-binary failure, which
// measurement now shows is unrelated to whether the SOURCE's child process is alive at all: the
// real winter binary's own `resolveEngineSession` refuses the destination's resume attempt with
// `ResumeTargetError: session <id> is in use by another live process (pid <the DAEMON's own pid>)`
// — the reported "live process" is THIS TEST'S OWN DAEMON, not the official child, and it is (of
// course) still alive throughout, so no amount of ending or aborting the source's child process can
// ever satisfy this check. This points at the handoff barrier's own step 6 ("close the owner;
// persist the producer record, cursor and generation; TRANSFER THE WRITER LEASE") not actually
// releasing whatever ownership marker the winter runtime's resume gate reads for this backend uuid
// before `confirmInit` (step 8) ever runs — and since that marker is (as far as this measurement
// can tell) transferred only as PART OF a successful commit, which itself requires the destination
// to already have confirmed init, official → Winter looks like it may need the SAME-UUID resume
// door reworked at the `winter-runtime-sdk` level, not a daemon-side fix. Recorded here as an open,
// unresolved finding — deliberately not forced into a false green. What THIS file proves instead:
// (a) the fix's own init-confirmation gate (issue 1) correctly turns the real failure into a TYPED
// refusal with the record REVERTED, never a silent `applied` (first describe block, real binaries);
// (b) the SAME gate + revert, proven fast and deterministically with a STUBBED Winter executable
// that exits before ever speaking the wire protocol at all (second describe block) — the coordinator's
// own suggested technique for a controlled repro of "the dead child" that does not depend on any of
// the real winter binary's own internal resume-locking; (c) the model/provider threading fix (issue
// 2) is proven at the unit level (`test/runtime-sdk/handoff.test.ts`'s own confirmInit cases) and by
// direct measurement during this file's own development (the freshly-ensured Winter driver's
// `store.model`/`selection` were confirmed correct — `openai/gpt-5.4` / providerId `openai` — before
// the unrelated resume-lock error fired). The FULL round trip (official turn → setModel → applied →
// next send answers on Winter → session.list shows the destination providerId) remains BLOCKED on
// this machine by the resume-lock finding above; it is not something this file can fake past without
// hiding a real, unresolved defect.
//
// WINTER PHASE 10b (D2-1) ADDENDUM — MEASURED 2026-09-14, against router 0.0.5 / SDK 0.0.11: the
// resume-lock finding above IS RESOLVED. This file's FIRST describe block now reaches the
// `caught === undefined` ("resumed") branch every run: `session.setModel`'s destination attach
// succeeds, `d.winter.legOf(sessionId)` becomes `"winter"`, and `providerId`/`runtimeKind` patch to
// the destination correctly — the P10a-h fix and the P10b lease-release work both hold up against
// the real binaries.
//
// A NEW, DISTINCT defect blocks the LAST assertion in that same branch, though (never forced to a
// false green): the resumed Winter destination's very first turn after the handoff streams its
// `assistant_delta` correctly (the fake's scripted text arrives in full), but NO `assistant_message`
// or `turn_completed` event ever reaches the client — `session.send`'s own `waitForFrom` hangs to
// its timeout even though the record settles to `state: "idle"` (the runtime's own side believes the
// turn finished). The daemon log carries the smoking gun, TWICE, printed the instant the handoff's
// own destination attach opens: `[projector] source already projected — skipping; on a live stream
// this means a resume that did not bump \`generation\`` (`src/projector/index.ts:487-501`, the
// checkpoint dedup keyed on `{winterSessionId, generation, sourceId}`) — and `rt.records.get(sessionId)
// ?.generation` is measured to stay `1` from BEFORE the handoff through AFTER the hung send, never
// bumping to `2` the way `WinterSession.open()`'s own contract promises on every fresh incarnation
// (`src/runtime-sdk/winter-session.ts:512`: "bumps the 8a generation"). The most likely account: the
// destination's freshly-opened incarnation resets its OWN local turn/message counters to 0, so its
// first NEW turn computes the SAME `sourceId` (e.g. `"as:0:1"`) the projector already committed for
// the SOURCE leg's own last turn under the SAME un-bumped generation number during the handoff's own
// bootstrap replay (the two benign-looking warnings that precede this one) — the checkpoint then
// reads the genuinely-new turn's completion frames as "already committed" and silently drops them.
// `OfficialSession`'s own generation counter (`runtime-sdk/official-session.ts`: `private gen = 0`,
// `this.gen + 1` on `open()`) is ALSO purely local to the JS instance rather than reading or
// persisting the shared `RuntimeSessionRecords` column `WinterSession.open()` writes through
// `records.bumpGeneration()` — the two legs' generation bookkeeping are not the same clock, which is
// consistent with (though not itself proven to be the whole story behind) this symptom. This is
// reported to Lane D1/the controller rather than fixed here (out of scope: `packages/core/src/**`);
// the test below is left asserting the SPEC-required behaviour (A-3/A-4 need a working post-handoff
// turn), so it currently fails red on this defect rather than being weakened to pass around it.
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
        // (A further "the source leg is still usable after this" assertion is deliberately absent —
        // `official-session.ts`'s `end()` NOW falls back to aborting the source's own child, so THAT
        // half of the original gap is fixed, but measurement shows the resume-lock this file's own
        // header documents is keyed to the DAEMON's pid, not the child's aliveness, so a resume
        // attempt right after this one would plausibly hit the identical real "exited before init"
        // for the unrelated, still-open reason recorded there. This test's own job — the fix this
        // task owns — stops at "reverted, typed, never silently applied", proven below.)
        expect(d.winter.legOf(sessionId)).toBe("official");
        expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
        expect(rt.records.get(sessionId)?.providerId).toBe("anthropic");
      }
    }, 120_000);
  });
});

// P10a-h follow-up: a DETERMINISTIC proof of the typed-refusal/revert path, independent of the real
// winter binary's own (separately tracked, unresolved) resume-lock behaviour documented above.
// `runtimes.winterExecutable` points at `/usr/bin/true` — a real, on-disk executable that exits(0)
// immediately without ever speaking a single frame of the wire protocol, so the SDK's own query()
// wrapper throws `CLIConnectionError("runtime exited before init")` deterministically, every run,
// with no real `dist/winter` dependency and no `describeWithWinterBinary` gating needed at all —
// exactly the coordinator's own suggested technique for a controlled "the dead child" repro.
describeWithClaudeRuntime("official -> Winter handoff, DETERMINISTIC dead-child case (P10a-h follow-up)", () => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient;
  let anthropicFakeUrl = "";
  let anthropicFakeClose: (() => Promise<void>) | undefined;
  const anthropicRequests: Array<{ path: string; body: string }> = [];
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["hello from the official leg"] }], stopReason: "end_turn" };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "winter-handoff-o2w-stub-")));

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
      provider: { type: "openai-compatible", model: CATALOG_OPENAI_MODEL, baseUrl: "http://127.0.0.1:9/v1" },
      runtimes: {
        // A real, on-disk executable that exits before ever reaching the wire protocol's own init
        // handshake — the deterministic "dead child" this describe block's whole point is proving
        // the fix's own gate catches, with no dependency on dist/winter's real internal behaviour.
        winterExecutable: "/usr/bin/true",
        claudeExecutable: claudeRuntimeForTests()!.executable,
        winterIdleTimeoutSec: 10,
        handoff: { crossRuntime: true },
      },
    }, null, 2));

    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-stub" });
    await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-stub-anthropic" });

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
    await anthropicFakeClose?.();
    rmSync(home, { recursive: true, force: true });
  });

  test("the destination's exited-before-init failure is a typed refusal with the record reverted, deterministically", async () => {
    const d = daemon!;
    if ("unavailable" in d.runtimeState) throw d.runtimeState.unavailable;
    const rt = d.runtimeState;

    const { sessionId } = await client.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL,
    });
    await client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    expect(d.winter.legOf(sessionId)).toBe("official");

    await client.call(METHODS.sessionSend, { sessionId, text: "remember the number stub-1" });
    await client.waitFor((e) => e.type === "turn_completed" && e.sessionId === sessionId, 45_000);
    expect(anthropicRequests.length).toBeGreaterThan(0);

    let caught: { rpc?: { message?: string; data?: { code?: string } } } | undefined;
    try {
      await client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_OPENAI_MODEL, confirmLossy: true });
    } catch (err) {
      caught = err as { rpc?: { message?: string; data?: { code?: string } } };
    }

    expect(caught).toBeDefined();
    expect(caught!.rpc?.data?.code).toBe("handoff_lossy_fork");
    // WS-19 lane rider x1 CHANGED THIS ASSERTION DELIBERATELY. The router's lossy-fork `reason` used
    // to be thrown verbatim as the RPC message, and it interpolates a caught `error.message` in most
    // of its cases — which is how an absolute path was reaching the user. The user copy is now one
    // neutral sentence for every reason, and the reason survives only in the daemon log, as a
    // category (`lossyForkCategoryFor` — this case's is `destination-exited-before-init`). What this
    // test is ABOUT is unchanged: the typed code, and the deterministic revert below.
    expect(caught!.rpc?.message).toBe("Couldn't switch models without losing part of the conversation; the session stays on claude-sonnet-5.");
    expect(caught!.rpc?.message).not.toContain("exited before it reached init");
    // Reverted: the record still names the SOURCE, deterministically, every run.
    expect(d.winter.legOf(sessionId)).toBe("official");
    expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
    expect(rt.records.get(sessionId)?.providerId).toBe("anthropic");
  }, 30_000);
});
