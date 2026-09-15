// Winter Phase 10b (Lane D1, fix round 3) — THE RUNTIME-DIRECTORY WINDOW, end to end.
//
// A session's `backendSessionId` is written SYNCHRONOUSLY (`session-driver.ts`'s `create()`, and
// `import-legacy.ts`'s engine-era conversion on the first `session.send`); its runtime-directory row
// is written only from inside a LIVE incarnation's own `attachMessaging()`, i.e. on the first real
// frame. Between those two moments the router refuses every `reviewSwitch`/`plan` with
// "it is not in the runtime directory", and fix round 2 read that as "this session has nothing to
// lose" — applying a cross-leg `session.setModel` silently while the durable record kept routing to
// the OLD leg. That was the round-2 CRITICAL; this file is its end-to-end proof, against the REAL
// `dist/winter` binary, the REAL platform `claude` binary and loopback Anthropic/OpenAI fakes.
//
// Three cases, per resume-d1-fix3.md item 1:
//   (i)   zero turns, gpt -> claude: NO prompt, and the next `session.send` reaches the ANTHROPIC
//         fake — not OpenAI. The silence is P10b-2/R-10b-8; the destination is the whole point.
//   (ii)  the reverse, claude -> gpt, also zero turns.
//   (iii) a session WITH a turn whose directory row is REMOVED (the import window, reproduced
//         deterministically): the cross-family move PROMPTS, and `confirmLossy` lands it on the new
//         leg with the prior text in the request body.
//
// The prompt/silence assertions and the leg assertions are DELIBERATELY BOTH MADE: a fix that made
// the move silent but left it on the source leg is exactly the defect being fixed, and would pass a
// prompt-only test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { SerializedRuntimeAddress } from "@yanlinglabs/winter-runtime-sdk";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { ANTHROPIC_CREDENTIAL_SECRET_NAME } from "../../src/runtime-sdk/keychain";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, type AnthropicTurnScript } from "../helpers/claude-runtime";

// The same two real, credentialed catalog rows `handoff-parity-e2e.test.ts` uses: `gpt-5.6-sol`
// carries `reasoning.continuation: "opaque-provider-state"` (it reasons, hidden), which is what
// makes a cross-family move away from it warned-lossy in case (iii) rather than silent.
const CATALOG_GPT_MODEL = "openai/gpt-5.6-sol";
const CATALOG_CLAUDE_MODEL = "claude-sonnet-5";

interface RpcErrorLike { rpc?: { message?: string; data?: { code?: string; warnings?: string[]; portable?: string[] } } }

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
  /** Counted from an index, never from the whole log: a PRIOR `turn_completed` is always sitting in
   *  `events` by the time a second turn is awaited (the trap A-1's own wait guards against). */
  async waitForAfter(sinceIdx: number, pred: (e: SessionEvent) => boolean, ms = 45_000): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.events.slice(sinceIdx).find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out; saw: ${this.events.slice(sinceIdx).map((e) => e.type).join(",")}`);
      await Bun.sleep(20);
    }
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

interface Bed {
  home: string;
  daemon: RunningDaemon;
  client: TestClient;
  openaiRequests: () => number;
  anthropicRequests: Array<{ path: string; body: string }>;
  close: () => Promise<void>;
}

/**
 * One daemon on a fresh temp home, wired to loopback fakes for BOTH providers and to the real
 * `winter`/`claude` binaries. Mirrors `handoff-parity-e2e.test.ts`'s own bed; each case gets its own
 * so a directory row deleted by one can never affect another.
 */
async function bootBed(winterBin: string, prefix: string, defaultModel: string, officialAuth?: "console"): Promise<Bed> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const openaiFake = await openaiResponsesFake.startOpenAiResponsesFake({
    scenarios: {},
    unknownModel: async () => openaiResponsesFake.responsesStream({
      text: ["answered by the openai fake"],
      // A hidden reasoning item, so a move AWAY from this model is genuinely warned-lossy (case iii).
      reasoningItems: [{ index: 0, encrypted: "ENC-DUMMY-DIRWIN", summaryText: "thinking" }],
    }),
  });
  const anthropicRequests: Array<{ path: string; body: string }> = [];
  const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance");
  const anthropicScript: AnthropicTurnScript = { blocks: [{ type: "text", chunks: ["answered by the anthropic fake"] }], stopReason: "end_turn" };
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
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    schemaVersion: 2,
    provider: { type: "openai-compatible", model: defaultModel, baseUrl: openaiFake.url },
    runtimes: {
      winterExecutable: winterBin, claudeExecutable: claudeRuntimeForTests()!.executable, winterIdleTimeoutSec: 60,
      handoff: { crossRuntime: true },
      // Fix round 4 (MINOR 4): `official.auth` is the ONE setting that makes `credentialRefFor`
      // answer differently with and without a `home`, which is what the authRef pin below reads.
      // Only the MINOR-4 bed sets it — a `console` arm would refuse to spawn a real `claude` child
      // (`console_profile_missing`), so that bed never sends a turn on the official leg.
      ...(officialAuth === undefined ? {} : { official: { auth: officialAuth } }),
    },
  }, null, 2));
  const secrets = new FileSecretStore(join(home, "test-secrets"));
  await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test-dirwin" });
  await writeCredentialMaterial(secrets, ANTHROPIC_CREDENTIAL_SECRET_NAME, { kind: "api-key", key: "sk-test-dirwin-anthropic" });
  const daemon = await startDaemon({
    home, secrets, agentProvider: null,
    officialConnectionOverride: () => ({ explicitConnectionEnv: { ANTHROPIC_BASE_URL: anthropicFakeServer.url }, authFamily: "custom" }),
  });
  if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
  const client = await TestClient.connect(daemon.socketPath);
  await client.hello(daemon.tokens.harness, "e2e");
  return {
    home, daemon, client,
    openaiRequests: () => openaiFake.requests.length,
    anthropicRequests,
    close: async () => {
      try { client.close(); } catch { /* closed */ }
      await daemon.stop();
      await openaiFake.close();
      await anthropicFakeServer.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const messagesPosts = (reqs: Array<{ path: string; body: string }>): number => reqs.filter((r) => r.path === "/v1/messages").length;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (i) + (ii) — ZERO TURNS, BOTH DIRECTIONS.
//
// `session.create` + `session.attach` allocate the backend id; no turn has run, so no directory row
// exists. The switch must be SILENT (P10b-2: nothing to lose ⇒ nothing to warn about) AND must
// actually move the session: the next send has to reach the DESTINATION's fake. Round 2 passed the
// first half and failed the second, invisibly.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("the runtime-directory window: a zero-turn session", (winterBin) => {
  describeWithClaudeRuntime("switches families silently AND actually lands on the destination leg", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-zero-", CATALOG_GPT_MODEL); });
    afterAll(async () => { await bed?.close(); });

    test("(i) gpt -> claude with zero turns: no prompt, and the next send reaches the ANTHROPIC fake", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-zero-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(bed.daemon.winter.legOf(sessionId)).toBe("winter");

      // NO `confirmLossy`. A prompt here is a failure: the RPC would reject with
      // `handoff_confirmation_required`, and `call` turns that into a throw.
      await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });

      // THE HALF ROUND 2 GOT WRONG: the record — what `resume()`/`ensure()` route on — must name
      // the official leg now, not merely `meta.model`.
      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
      expect(bed.daemon.winter.legOf(sessionId)).toBe("official");

      const openaiBefore = bed.openaiRequests();
      const anthropicBefore = messagesPosts(bed.anthropicRequests);
      const sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: "who is answering?" });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);
      expect(messagesPosts(bed.anthropicRequests)).toBeGreaterThan(anthropicBefore);
      expect(bed.openaiRequests()).toBe(openaiBefore); // never the source provider
    }, 120_000);
  });
});

describeWithWinterBinary("the runtime-directory window: a zero-turn session, the other direction", (winterBin) => {
  describeWithClaudeRuntime("claude -> gpt is equally silent and equally real", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-zero-rev-", CATALOG_CLAUDE_MODEL); });
    afterAll(async () => { await bed?.close(); });

    test("(ii) claude -> gpt with zero turns: no prompt, and the next send reaches the OPENAI fake", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-zero-rev-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_CLAUDE_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      expect(bed.daemon.winter.legOf(sessionId)).toBe("official");

      await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_GPT_MODEL });

      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      expect(rt.records.get(sessionId)?.runtimeKind).toBe("winter-agent");
      expect(bed.daemon.winter.legOf(sessionId)).toBe("winter");

      const openaiBefore = bed.openaiRequests();
      const anthropicBefore = messagesPosts(bed.anthropicRequests);
      const sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: "who is answering?" });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);
      expect(bed.openaiRequests()).toBeGreaterThan(openaiBefore);
      expect(messagesPosts(bed.anthropicRequests)).toBe(anthropicBefore);
    }, 120_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (iii) — A SESSION WITH TURNS, KEYED BUT NOT IN THE DIRECTORY.
//
// This is the window's dangerous inhabitant and the reason round 2's mapping was a CRITICAL: an
// engine-era import writes `backendSessionId` on the first `session.send` and the row only lands on
// the first frame, so a session carrying REAL prior turns can be keyed-but-invisible. Reproduced
// deterministically rather than by racing the import: run a turn, evict the driver (which parks the
// row), then `directory.forget` it. The session's transcript, record and prior text are all intact
// — only the router's view of it is missing, exactly as in the import window.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("the runtime-directory window: a session WITH turns", (winterBin) => {
  describeWithClaudeRuntime("still PROMPTS for a cross-family move, and confirmLossy lands it with the prior text", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-turns-", CATALOG_GPT_MODEL); });
    afterAll(async () => { await bed?.close(); });

    test("(iii) a keyed-but-unlisted session with one turn prompts, then carries", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-turns-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const PRIOR_TEXT = "remember P10B-DIRWIN-3";
      let sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: PRIOR_TEXT });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);

      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      const record = rt.records.get(sessionId);
      if (record?.backendSessionId === undefined) throw new Error("no backendSessionId after a completed turn");
      const address = serializeRuntimeAddress(buildSessionAddress(record.backendSessionId)) as SerializedRuntimeAddress;
      const directory = bed.daemon.runtimeSdk!.sdk.directory;

      // The row exists now — the turn's own frames wrote it. Prove that before removing it, or the
      // removal below proves nothing.
      expect(await directory.get(address)).toBeDefined();

      // Evict FIRST: `detach()` parks the row asynchronously (`attachWinterSession`'s own chain), so
      // forgetting before the park lands would race a write that re-creates it. Poll for the parked
      // shape, then forget, then poll for absence — no fixed sleeps.
      await bed.daemon.winter.evict(sessionId);
      const until = async (pred: () => Promise<boolean>, what: string): Promise<void> => {
        const t0 = Date.now();
        while (!(await pred())) {
          if (Date.now() - t0 > 20_000) throw new Error(`timed out waiting for ${what}`);
          await Bun.sleep(25);
        }
      };
      await until(async () => (await directory.get(address))?.status === "exited", "the row to park");
      await directory.forget(address);
      await until(async () => (await directory.get(address)) === undefined, "the row to disappear");

      // The session is now KEYED (a real backendSessionId, a real transcript, a real prior turn) and
      // INVISIBLE to the router — the import window, exactly. Round 2 answered this with a silent
      // apply; it must PROMPT, because a hidden-reasoning source crossing families is warned-lossy.
      let caught: RpcErrorLike | undefined;
      try {
        await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeDefined();
      expect(caught!.rpc?.data?.code).toBe("handoff_confirmation_required");
      // …and nothing moved on a mere prompt.
      expect(rt.records.get(sessionId)?.runtimeKind).toBe("winter-agent");

      // Confirming applies it for real.
      await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
      expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
      expect(bed.daemon.winter.legOf(sessionId)).toBe("official");

      const anthropicBefore = messagesPosts(bed.anthropicRequests);
      sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: "what did I ask you to remember?" });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);
      expect(messagesPosts(bed.anthropicRequests)).toBeGreaterThan(anthropicBefore);
      const lastBody = bed.anthropicRequests.filter((r) => r.path === "/v1/messages").at(-1)!.body;
      expect(lastBody).toContain(PRIOR_TEXT); // the conversation carried across the leg
      expect(lastBody).not.toContain("ENC-DUMMY-DIRWIN"); // opaque provider state never crosses
    }, 180_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// MINOR 4 — the DAEMON's own wiring passes `home` into `planAndApplySwitch`.
//
// `credentialRefFor` keeps the old unconditional `anthropic:default` account when it has no `home`,
// and consults `officialAuthFamilyFor` when it does. `confirmInit` has always had the home (through
// `registerHandoffParticipants`); `planAndApplySwitch` did not, so the two writers of the record's
// `authRef` column could persist different account names for the very same provider. This pins the
// fix at `daemon.ts`'s own construction site, not at a hand-built deps object.
//
// A zero-turn re-selection is the vehicle because it reaches the patch WITHOUT spawning anything on
// the destination — which matters here, since a `console` auth arm has no profile in a temp home
// and a real `claude` child would refuse (`console_profile_missing`). No turn is ever sent.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("MINOR 4: the daemon's own handoff wiring carries WINTER_HOME", (winterBin) => {
  describeWithClaudeRuntime("so the account persisted in the record is the one the official leg's auth mode names", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-authref-", CATALOG_GPT_MODEL, "console"); });
    afterAll(async () => { await bed?.close(); });

    test("a zero-turn re-selection onto an Anthropic model records the CONSOLE account, not the default one", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-authref-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL });

      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      const record = rt.records.get(sessionId);
      expect(record?.runtimeKind).toBe("claude-agent");
      // `keychain:anthropic:default` here is the pre-fix answer — a `planAndApplySwitch` with no
      // home. The account name is a LOCATOR, never material (records.ts's own rule).
      expect(record?.authRef).toBe("keychain:anthropic:console");
    }, 120_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 4, MAJOR 1(b) — A COMPACTED SESSION IS NEVER RE-SELECTED.
//
// `switchFactsFor` counts assistant entries only SINCE THE LAST COMPACTION BOUNDARY (carriage stops
// at a boundary by design, W18-16), so EVERY compacted session reports `sourceTurns: 0` until its
// next assistant reply — and `reviewModelSwitch` answers `skipped: "no-source-turns"` for it, the
// same verdict a session that has genuinely never run a turn gets. Round 3 carried that verdict into
// the execution path and would have re-selected a long conversation past the barrier's own staging.
//
// What separates the two is NOT the review: it is the transcript. A compacted session HAS a
// canonical file, so WS-05 §12 step 5 validates it and the barrier performs a REAL, staged handoff;
// only a session with no file at all produces the step-5 "nothing to validate" fork a re-selection
// may answer (fix round 4, MAJOR 2).
//
// THE DISCRIMINATOR IS THE DRIVER TABLE. A real handoff runs `confirmInit`, which evicts AND
// `ensure()`s, so the session is LIVE on the destination afterwards; a re-selection only evicts, so
// the table holds nothing. That is observable without reaching into either implementation.
//
// HONEST LIMITATION, worth reporting rather than asserting around: the spec's R-10b-8 would have
// this move PROMPT, and it does not — `reviewModelSwitch` returns its `no-source-turns` skip BEFORE
// `classifySwitch` ever runs, so `prompt` is false. That decision belongs to the router (the
// Interfaces block: "the ROUTER decides every skip"), and the daemon must not second-guess it. This
// test pins the half the daemon owns: a real staged handoff, never a re-selection.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("a COMPACTED session reports zero source turns", (winterBin) => {
  describeWithClaudeRuntime("but is handed off for real, never re-selected", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-compact-", CATALOG_GPT_MODEL); });
    afterAll(async () => { await bed?.close(); });

    test("a cross-family switch after a compaction boundary runs the barrier, and the session ends up LIVE on the destination", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-compact-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const PRIOR_TEXT = "remember P10B-COMPACT-4";
      const sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: PRIOR_TEXT });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);

      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      const record = rt.records.get(sessionId);
      if (record?.backendSessionId === undefined) throw new Error("no backendSessionId after a completed turn");

      // Append a REAL compaction boundary to the canonical transcript: `type: "compact_boundary"`
      // with a `compactMetadata` object, chained onto the file's own last entry. `preservedMessages`
      // is deliberately omitted — WS-05 §5.1's "unset when compaction summarizes everything", the
      // one shape `validateCompaction` accepts without naming any kept uuid, so step 5 still passes.
      const findTranscript = (root: string, backendSessionId: string): string | undefined => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name);
          if (entry.isDirectory()) {
            const hit = findTranscript(full, backendSessionId);
            if (hit !== undefined) return hit;
          } else if (entry.name === `${backendSessionId}.jsonl` && statSync(full).size > 0) {
            return full;
          }
        }
        return undefined;
      };
      const transcript = findTranscript(bed.home, record.backendSessionId);
      if (transcript === undefined) throw new Error(`no canonical transcript for ${record.backendSessionId} under ${bed.home}`);
      const lines = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]!) as { uuid?: string; cwd?: string; version?: string; sessionId?: string };
      if (typeof last.uuid !== "string") throw new Error("the canonical transcript's last entry carries no uuid");
      // `cwd`/`version` are copied from the real tail on purpose: the barrier's step-8 decoration
      // door takes them from the transcript's LAST entry, and a boundary without them refuses with
      // "a note with invented fields would claim a session that does not exist" — a property of this
      // synthetic fixture, never of compaction (a real compaction writes them).
      appendFileSync(transcript, `${JSON.stringify({
        type: "compact_boundary",
        uuid: "00000000-0000-4000-8000-00000000c0de",
        parentUuid: last.uuid,
        timestamp: new Date().toISOString(),
        compactMetadata: { trigger: "manual" },
        ...(last.cwd === undefined ? {} : { cwd: last.cwd }),
        ...(last.version === undefined ? {} : { version: last.version }),
        ...(last.sessionId === undefined ? {} : { sessionId: last.sessionId }),
      })}\n`);

      // Evict so the next read of this session goes through a fresh incarnation rather than a live
      // child holding its own view of the file.
      await bed.daemon.winter.evict(sessionId);
      expect(bed.daemon.winter.get(sessionId)).toBeUndefined();

      // `confirmLossy: true` so the assertion does not depend on whether the router prompts — the
      // claim under test is what the APPLY does, not whether it asked.
      await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });

      expect(rt.records.get(sessionId)?.runtimeKind).toBe("claude-agent");
      // THE DISCRIMINATOR: a real handoff's `confirmInit` evicted AND re-ensured, so a driver is in
      // the table. A re-selection would only have evicted, leaving nothing.
      expect(bed.daemon.winter.get(sessionId)).toBeDefined();
      expect(bed.daemon.winter.legOf(sessionId)).toBe("official");
    }, 180_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 4, MAJOR 1(b) — THE DISCRIMINATOR.
//
// The test above proves a compacted session whose handoff SUCCEEDS is handed off for real. It does
// not, on its own, prove the snapshot is gone: round 3 only re-selected when the barrier REFUSED.
// This is that case. Same compacted session, same `no-source-turns` verdict from the router — but
// the appended boundary deliberately omits the `cwd`/`version` the barrier's step-8 decoration door
// takes from the transcript's last entry, so the barrier refuses with a real `lossy-fork-offered`
// ("a note with invented fields would claim a session that does not exist", MEASURED).
//
// Round 3 answered that with a silent re-selection of a conversation carrying REAL prior content:
// `meta.model` committed, the record flipped, nothing staged. Round 4 re-asks the router at
// execution time and — because this is neither the step-5 "no transcript at all" fork (MAJOR 2) nor
// a session whose fresh verdict may be trusted blindly (MAJOR 1) — refuses, keeping the barrier's
// own typed outcome and writing nothing.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describeWithWinterBinary("a COMPACTED session whose handoff the barrier REFUSES", (winterBin) => {
  describeWithClaudeRuntime("is never silently re-selected", () => {
    let bed: Bed;
    beforeAll(async () => { bed = await bootBed(winterBin, "dirwin-compact-refuse-", CATALOG_GPT_MODEL); });
    afterAll(async () => { await bed?.close(); });

    test("the switch is refused typed, the record still names the source leg, and meta.model never moved", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "dirwin-compact-refuse-cwd-")));
      const { sessionId } = await bed.client.call<{ sessionId: string }>(METHODS.sessionCreate, { scope: "e2e", mode: "code", model: CATALOG_GPT_MODEL, cwd });
      await bed.client.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
      const sinceIdx = bed.client.events.length;
      await bed.client.call(METHODS.sessionSend, { sessionId, text: "remember P10B-COMPACT-REFUSE" });
      await bed.client.waitForAfter(sinceIdx, (e) => e.type === "turn_completed" && e.sessionId === sessionId);

      const rt = bed.daemon.runtimeState;
      if ("unavailable" in rt) throw rt.unavailable;
      const record = rt.records.get(sessionId);
      if (record?.backendSessionId === undefined) throw new Error("no backendSessionId after a completed turn");
      const findTranscript = (root: string, backendSessionId: string): string | undefined => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name);
          if (entry.isDirectory()) {
            const hit = findTranscript(full, backendSessionId);
            if (hit !== undefined) return hit;
          } else if (entry.name === `${backendSessionId}.jsonl` && statSync(full).size > 0) {
            return full;
          }
        }
        return undefined;
      };
      const transcript = findTranscript(bed.home, record.backendSessionId);
      if (transcript === undefined) throw new Error(`no canonical transcript for ${record.backendSessionId} under ${bed.home}`);
      const lines = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean);
      const lastUuid = (JSON.parse(lines[lines.length - 1]!) as { uuid?: string }).uuid;
      if (typeof lastUuid !== "string") throw new Error("the canonical transcript's last entry carries no uuid");
      // NO `cwd`/`version` — that omission is what makes the barrier refuse at step 8. Everything
      // `validateCompaction` requires is still present, so step 5 passes and this is genuinely a
      // "the transcript is fine, the handoff is not" refusal, never the no-transcript fork.
      appendFileSync(transcript, `${JSON.stringify({
        type: "compact_boundary",
        uuid: "00000000-0000-4000-8000-00000000c0de",
        parentUuid: lastUuid,
        timestamp: new Date().toISOString(),
        compactMetadata: { trigger: "manual" },
      })}\n`);
      await bed.daemon.winter.evict(sessionId);

      let caught: RpcErrorLike | undefined;
      try {
        await bed.client.call(METHODS.sessionSetModel, { sessionId, model: CATALOG_CLAUDE_MODEL, confirmLossy: true });
      } catch (err) { caught = err as RpcErrorLike; }
      expect(caught).toBeDefined();
      expect(caught!.rpc?.data?.code).toBe("handoff_lossy_fork");
      // Lane P's x1 neutral copy: never the router's raw reason, which carries internals.
      expect(caught!.rpc?.message).not.toMatch(/decoration|invented fields|step 8/i);
      // THE POINT: nothing moved. Round 3 flipped this to "claude-agent" and wrote meta.model.
      expect(rt.records.get(sessionId)?.runtimeKind).toBe("winter-agent");
      expect(bed.daemon.sessions.meta(sessionId).model).toBe(CATALOG_GPT_MODEL);
    }, 180_000);
  });
});
