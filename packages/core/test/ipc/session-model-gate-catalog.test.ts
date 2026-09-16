// Fix for a shipped defect (measured live 2026-09-13, dev daemon): `resolveModelSelection`
// (ipc/server.ts) used to gate `session.create`/`session.setModel` on `engine.knownModels()` alone
// — the daemon's INTERNAL-calls provider's own fixed list (e.g. `CODEX_MODELS` for a `codex-oauth`
// deployment), which has never listed a Claude model. Every Claude-family model was refused
// INVALID_PARAMS at the RPC gate, so it could never even reach the runtime SDK's official-leg
// decision (`runtime-sdk/session-driver.ts`'s `decideRuntime`, `runtime-sdk/handoff.ts`'s
// `planAndApplySwitch`) — the caller got a bare INVALID_PARAMS with no `data.code`, never the leg's
// own typed `runtime_selection_refused` / `confirmation_required` / `handoff_disabled`.
//
// WS-20 rewrite: `resolveModelSelection` no longer consults `knownModels`, alias resolution, or
// `catalogRowsFor` (deleted; a tag names exactly its provider) at all. The fix this file originally
// proved is now the DEFAULT and only behavior: `engine.knownModels()` (the internal-calls
// provider's own small list) plays NO ROLE whatsoever in gating `session.create`/`session.setModel`
// any more. A bare id is refused at the wire SCHEMA (before the handler even runs,
// `ModelTagSchema`); a tag naming an unrecognized provider is refused by `parseModelTag`.
//
// WS-20 (review round 2, M4): the gate is a real catalog MEMBERSHIP check now, not just "is this a
// provider-qualified tag naming a real catalog provider" — `modelTagIsKnown` (model-tag.ts) also
// requires the tag be a REAL catalog row for its provider, unless a BYO `baseUrl` is configured for
// it. See `session-set-model.test.ts`/`sync-bounds.test.ts` for that half; every model used in
// THIS file is a real catalog row, so none of these tests exercise the narrower path.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { ModelInfo } from "../../src/providers/types";
import type { PlanSwitchOutcome } from "../../src/runtime-sdk/handoff";

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated per this codebase's convention
 *  (every test/ipc/*.test.ts carries its own copy; see session-set-model.test.ts). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
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
            }
          }
        },
        drain(_s) { c.writer.onDrain(); },
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

  async hello(token: string, clientName: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  close(): void { this.socket.end(); }
}

/** The Codex-only internal-provider catalogue — same production ids as
 *  `providers/codex-config.ts`'s (former) `CODEX_MODELS`. Kept only to prove `engine.knownModels()`
 *  plays NO role in the gate any more — every test below succeeds or fails purely off the tag's own
 *  shape/provider, regardless of what this list contains. */
const CODEX_ONLY_CATALOGUE: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];

function fakeEngine(models: ModelInfo[]): any {
  return { knownModels: () => models, isRunning: () => false, hasBackgroundWork: () => false, interrupt: () => ({ wasRunning: false }) };
}

describe("resolveModelSelection: tag shape + provider existence, engine.knownModels() plays no role (WS-20)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(models: ModelInfo[], handoff?: { planAndApplySwitch(sessionId: string, model: string | null, confirmLossy: boolean): Promise<PlanSwitchOutcome> }) {
    const home = mkdtempSync(join(tmpdir(), "winter-model-gate-catalog-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      engine: fakeEngine(models), hub: new SessionHub(store),
      ...(handoff ? { handoff } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  // A Claude tag passes the gate even though `knownModels` (the Codex-only internal provider list)
  // never lists it — session.create.
  test("session.create: a Claude tag passes when knownModels is Codex-only", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "anthropic/claude-opus-5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("anthropic/claude-opus-5");
    c.close();
  });

  // Same, via session.setModel.
  test("session.setModel: a Claude tag passes when knownModels is Codex-only", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-haiku-4-5-20251001" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("anthropic/claude-haiku-4-5-20251001");
    c.close();
  });

  // A bare (non-tag-shaped) id is refused at the WIRE SCHEMA — before the handler, and therefore
  // before `resolveModelSelection`, ever runs. There is no more alias table and no more catalog
  // fallback to save it: the door itself refuses the shape.
  test("session.create: a bare id is refused at the wire schema, before the handler runs", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "garbage-not-a-model-xyz" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("session.setModel: a bare id is refused at the wire schema, before the handler runs", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "garbage-not-a-model-xyz" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });

  // A tag-shaped model naming an UNRECOGNIZED provider is refused by the handler's own
  // resolveModelSelection call (parseModelTag), never by engine.knownModels().
  test("session.create: a tag naming an unrecognized provider is refused INVALID_PARAMS", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "nosuchprovider/garbage-not-a-model-xyz" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("nosuchprovider/garbage-not-a-model-xyz");
    expect(store.list().length).toBe(0);
    c.close();
  });

  // An internal-provider (Codex) tag still passes (control — `engine.knownModels()`, the
  // internal-calls engine's own small list, plays no role in the catalog-membership gate either
  // way; this row is real in the pinned catalog regardless of what the fake engine enumerates).
  test("session.create: an internal-provider (Codex) tag still passes, unaffected by knownModels", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "codex-oauth/gpt-5.6-terra" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("codex-oauth/gpt-5.6-terra");
    c.close();
  });

  // session.setModel to a Claude model reaches `opts.handoff.planAndApplySwitch` and surfaces ITS
  // typed refusal code — not a bare INVALID_PARAMS with no `data.code`. Mocking `opts.handoff` to
  // refuse (as it would for a session whose persisted family is non-Claude and no cross-runtime
  // handoff is configured) proves the model flows through to the handoff decision unchanged.
  test("session.setModel: a Claude tag reaches the handoff decision and surfaces ITS refusal code", async () => {
    let seenModel: string | null | undefined;
    const handoff = {
      planAndApplySwitch: async (_sessionId: string, model: string | null, _confirmLossy: boolean): Promise<PlanSwitchOutcome> => {
        seenModel = model;
        return { kind: "refused" as const, code: "runtime_selection_refused" as const, detail: "no Anthropic credential for the official leg" };
      },
    };
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE, handoff);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "anthropic/claude-opus-5" });
    // The model reached the handoff decision UNCHANGED (resolveModelSelection didn't throw first).
    expect(seenModel).toBe("anthropic/claude-opus-5");
    // And the RPC surfaces the handoff's OWN typed code — not a bare INVALID_PARAMS with no code.
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.data?.code).toBe("runtime_selection_refused");
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });
});
