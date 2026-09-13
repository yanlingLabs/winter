// Fix for a shipped defect (measured live 2026-09-13, dev daemon): `resolveModelSelection`
// (ipc/server.ts) gated `session.create`/`session.setModel` on `engine.knownModels()` alone — the
// daemon's INTERNAL-calls provider's own fixed list (e.g. `CODEX_MODELS` for a `codex-oauth`
// deployment), which has never listed a Claude model. Every Claude-family model was refused
// INVALID_PARAMS at the RPC gate, so it could never even reach the runtime SDK's official-leg
// decision (`runtime-sdk/session-driver.ts`'s `decideRuntime`, `runtime-sdk/handoff.ts`'s
// `planAndApplySwitch`) — the caller got a bare INVALID_PARAMS with no `data.code`, never the leg's
// own typed `runtime_selection_refused` / `confirmation_required` / `handoff_disabled`.
//
// Fix: `resolveModelSelection` now also accepts a resolved id when the pinned catalog has a row
// for it (`catalogRowsFor`, `runtime-sdk/provider-selection.ts`), even when the internal provider's
// `knownModels` doesn't list it. This is still a MEMBERSHIP gate, not an availability one — a
// nonsense id that matches neither source is still refused.
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
 *  `providers/codex-config.ts`'s `CODEX_MODELS` (mirrored by `session-set-model.test.ts`'s own
 *  `CATALOGUE`), i.e. exactly what a `codex-oauth`-configured daemon's `engine.knownModels()`
 *  returns: never a Claude model. */
const CODEX_ONLY_CATALOGUE: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];

function fakeEngine(models: ModelInfo[]): any {
  return { knownModels: () => models, isRunning: () => false, hasBackgroundWork: () => false, interrupt: () => ({ wasRunning: false }) };
}

describe("resolveModelSelection accepts pinned-catalog models the internal provider doesn't list", () => {
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

  // (a) a Claude catalog model passes the gate even though `knownModels` (the Codex-only internal
  // provider list) never lists it — session.create.
  test("session.create: a Claude catalog canonical id passes when knownModels is Codex-only", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "claude-opus-4.5" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("claude-opus-4.5");
    c.close();
  });

  // (a) same, via session.setModel — and via a Claude catalog ALIAS ("haiku" → the catalog row
  // whose `aliases` include it), not just a bare canonical id, since `resolveModelAlias` leaves an
  // alias it can't match against `knownModels` UNCHANGED and only the catalog fallback saves it.
  test("session.setModel: a Claude catalog alias passes when knownModels is Codex-only", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "setter");
    const sessionId = store.createSession("global");

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "haiku" });
    expect(res.error).toBeUndefined();
    expect(store.meta(sessionId).model).toBe("haiku");
    c.close();
  });

  // (b) a nonsense id — matching neither `knownModels` nor any catalog row — still fails
  // INVALID_PARAMS. The catalog fallback must not widen the gate to arbitrary strings.
  test("session.create: a nonsense id (no knownModels/catalog match) is still refused INVALID_PARAMS", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "garbage-not-a-model-xyz" });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toContain("garbage-not-a-model-xyz");
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("session.setModel: a nonsense id (no knownModels/catalog match) is still refused INVALID_PARAMS", async () => {
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

  // (c) an internal-provider id still passes (control — the catalog fallback is additive, not a
  // replacement for the existing membership check).
  test("session.create: an internal-provider (Codex) id still passes, unaffected by the catalog fallback", async () => {
    const { store, socketPath, harnessToken } = await boot(CODEX_ONLY_CATALOGUE);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "creator");

    const res = await c.request(METHODS.sessionCreate, { scope: "global", model: "gpt-5.6-terra" });
    expect(res.error).toBeUndefined();
    expect(store.meta(res.result.sessionId).model).toBe("gpt-5.6-terra");
    c.close();
  });

  // (d) session.setModel to a Claude model, once past the (now-fixed) RPC gate, must reach
  // `opts.handoff.planAndApplySwitch` and surface ITS typed refusal code — not the bare
  // INVALID_PARAMS the RPC gate used to throw before the model could ever get there. Mocking
  // `opts.handoff` to refuse (as it would for a session whose persisted family is non-Claude and
  // no cross-runtime handoff is configured) proves the model now flows through unchanged.
  test("session.setModel: a Claude model that passes the gate reaches the handoff decision and surfaces ITS refusal code", async () => {
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

    const res = await c.request(METHODS.sessionSetModel, { sessionId, model: "claude-opus-4.5" });
    // The model reached the handoff decision UNCHANGED (resolveModelSelection didn't throw first).
    expect(seenModel).toBe("claude-opus-4.5");
    // And the RPC surfaces the handoff's OWN typed code — not a bare INVALID_PARAMS with no code.
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.data?.code).toBe("runtime_selection_refused");
    expect(store.meta(sessionId).model).toBeUndefined();
    c.close();
  });
});
