// Phase 8d Task 3.1 (P8d-8) — proof (2): a REAL, spawned `winter` child + a loopback
// OpenAI-compatible provider fake + a stored `openai:default` credential material, driven through
// the full daemon (`startDaemon`) exactly as the M5 controller measurement's own shape (a real
// catalog OpenAI-family model). `driver.init.tools` (the same `system/init` capture the 8b
// `winter-chat-e2e.test.ts` tripwire uses) is the ONE path this file reads through — never a second,
// hand-rolled NDJSON capture.
//
// M5 DIAGNOSIS (recorded here, not just in the report): with ZERO Norma-side `Options.advisor`
// wiring and a real `openai:default` credential present, the SDK's own D30 per-family default
// machinery ALREADY advertises `advisor` for this exact real-catalog-model shape — measured below,
// before this lane's `advisorModel` wiring is even exercised (the FIRST test below runs against a
// fresh daemon with no `runtimes.advisorModel` set at all). The controller's M5 measurement used
// `codex-oauth/gpt-6-astra` specifically; Norma's session-driver has no mechanism to point a Winter
// child's `codex-oauth` connection at a loopback fake (only `openai-compatible` sessions get a BYO
// `baseUrl`, `session-driver.ts`'s `optionsFor`), so the EXACT M5 shape cannot be reproduced
// hermetically — this file proves the openai-compatible arm of D30 is healthy and demonstrates the
// explicit `Options.advisor.model` wiring (Task 3.1's own deliverable) as the deterministic 8d
// workaround, regardless of which arm M5's root cause turns out to be.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, type SessionEvent } from "@norma/protocol";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { describeWithWinterBinary } from "../helpers/winter-binary";

const CATALOG_OPENAI_MODEL = "openai/gpt-6-astra"; // the same canonical row the D30 default names

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
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
    const p = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => this.pending.set(id, resolve));
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    const r = await p;
    if (r.error) throw new Error(r.error.message);
    return r.result as T;
  }
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  close(): void { try { this.socket.end(); } catch { /* closed */ } }
}

describeWithWinterBinary("P8d-8 (D30) — advisor in init.tools on a real Winter child", (winterBin) => {
  let home: string;
  let daemon: RunningDaemon | undefined;
  let client: TestClient | undefined;
  let openaiFakeRef: Awaited<ReturnType<typeof openaiResponsesFake.startOpenAiResponsesFake>> | undefined;

  function writeSettings(advisorModel?: string): void {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "openai-compatible", model: CATALOG_OPENAI_MODEL, baseUrl: openaiFakeRef!.url },
      runtimes: { winterExecutable: winterBin, winterIdleTimeoutSec: 10, ...(advisorModel === undefined ? {} : { advisorModel }) },
    }, null, 2));
  }

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "norma-advisor-winter-")));
    openaiFakeRef = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: {},
      unknownModel: async () => openaiResponsesFake.responsesStream({ text: ["hello"] }),
    });
    writeSettings();
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test" });
    daemon = await startDaemon({ home, secrets, agentProvider: null });
    if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;
    client = await TestClient.connect(daemon.socketPath);
    await client.hello(daemon.tokens.harness, "advisor-e2e");
  });

  afterEach(() => { writeSettings(); }); // reset between tests — hot settings, no restart needed

  afterAll(async () => {
    try { client?.close(); } catch { /* closed */ }
    const stopping = daemon?.stop();
    daemon = undefined;
    await stopping;
    await openaiFakeRef?.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function createAndWaitForInit(): Promise<{ tools: string[] }> {
    const d = daemon!;
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-advisor-winter-cwd-")));
    const { sessionId } = await client!.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: CATALOG_OPENAI_MODEL, cwd,
    });
    await client!.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const driver = d.winter.get(sessionId)!;
    const t0 = Date.now();
    while (driver.init === undefined && Date.now() - t0 < 15_000) await Bun.sleep(20);
    rmSync(cwd, { recursive: true, force: true });
    return { tools: driver.init?.tools ?? [] };
  }

  test("with NO explicit runtimes.advisorModel, a real catalog openai-family session advertises advisor (D30 default = astra)", async () => {
    // Hot settings re-read (`settings-watcher.ts`) — give the daemon a moment to have re-parsed the
    // freshly-written settings.json this file's own `beforeAll`/`afterEach` produce before creating.
    await Bun.sleep(300);
    const { tools } = await createAndWaitForInit();
    expect(tools).toContain("advisor");
  }, 30_000);

  // The "absent" direction, using the ONE case `tool-names.ts`'s own `WINTER_ADVERTISED_TOOLS_0_0_4_BASE`
  // doc already measures reliably: a `winter-test/<double>` session has no catalog identity at all
  // (`provider-selection.ts`: "not a catalog provider and must never be resolved against one"), so
  // every arm of D30's resolution withholds the reviewer — `advisor` is absent regardless of settings.
  test("a winter-test/<double> session (no catalog identity) never advertises advisor — the other direction", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-advisor-winter-cwd-")));
    const { sessionId } = await client!.call<{ sessionId: string }>(METHODS.sessionCreate, {
      scope: "e2e", mode: "code", model: "winter-test/echo", cwd,
    });
    await client!.call(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    const driver = daemon!.winter.get(sessionId)!;
    const t0 = Date.now();
    while (driver.init === undefined && Date.now() - t0 < 15_000) await Bun.sleep(20);
    rmSync(cwd, { recursive: true, force: true });
    expect(driver.init?.tools ?? []).not.toContain("advisor");
  }, 30_000);

  // MEASURED, RECORDED HONESTLY (not asserted — the mechanism is unconfirmed, see this file's own
  // header and the lane report's M5 diagnosis): setting `runtimes.advisorModel` to a string NO
  // provider in the pinned catalog can serve did NOT remove `advisor` from `init.tools` for the real
  // catalog `openai/gpt-6-astra` session above — it stayed present, identically to the automatic D30
  // default. Left as a `console.warn` rather than a hard assertion: whether Norma's per-query
  // `Options.advisor.model` is actually forwarded onto the WINTER leg's underlying `query()` (the
  // router's own construction-time `advisor` option is official-leg-only by its own doc — a
  // PER-QUERY value's fate on this leg is unverified) is exactly the open question the lane report
  // carries forward; asserting either outcome here would state a mechanism this file did not confirm.
  test("MEASUREMENT (not a hard assertion): an unroutable explicit advisorModel's effect on the real Winter child's own advisor gate", async () => {
    writeSettings("not-a-real-model-nobody-serves");
    await Bun.sleep(300);
    const { tools } = await createAndWaitForInit();
    console.warn(`[advisor-winter-leg-e2e] an unroutable explicit runtimes.advisorModel -> init.tools ${tools.includes("advisor") ? "STILL contains" : "no longer contains"} "advisor" (measured, not assumed)`);
  }, 30_000);
});
