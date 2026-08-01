import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { validateSyncMeta, effortsForModel } from "../../src/ipc/sync";
import { CLIENT_EFFORTS, REASONING_EFFORTS } from "../../src/settings";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { ModelInfo } from "../../src/providers/types";

// ================================================================================================
// provider-correctness T6 — per-session EFFORT replication through `sync.push`'s index-only `meta`.
//
// T4 review I2 named this exact gap: `SyncMeta` carried `title`/`model`/`forkedFrom` and no
// `effort`, so the moment the phone gets an effort control a phone-set effort reaches the Mac's
// index for `model` and is SILENTLY DROPPED for `effort`. The Mac then resolves that session at the
// global default while the phone's UI shows the override — a divergence whose only symptom is "the
// answers are different on the Mac".
//
// `sync.push` is a SECOND INGRESS. It gets its own validation, not a shared assumption:
//   * model-aware membership, `effortsForModel` — the SAME source `session.setEffort` checks and
//     `sync.config` advertises, so the daemon never accepts here what it refuses there;
//   * DROP-AND-LOG on refusal, never a failed push — verbatim the `model` half's precedent
//     (ipc/sync.ts): the events are the irreplaceable part, an override is a hint the user re-sets;
//   * a Norma-level TIER is ALWAYS dropped here. `sync.push` is chat-only fail-closed
//     (ipc/sync.ts:19-20 — every verb resolves the target's mode and refuses anything that isn't
//     exactly "chat", absent included), and a tier is code-sessions-only (`clientEffortEligible`),
//     so NO session reachable through this surface may ever hold one. This is the one rule that is
//     STRICTER here than at `session.setEffort`, and it is strictly derivable rather than a policy
//     invention: the two gates compose to "unreachable".
// ================================================================================================

/** Minimal raw NDJSON JSON-RPC client — this codebase's per-file convention (no shared harness). */
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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

const TS = 1_753_800_000_000;
function ev(sessionId: string, seq: number, rest: Record<string, unknown>): Record<string, unknown> {
  return { sessionId, seq, ts: TS + seq, ...rest };
}
function created(sessionId: string, scope = "global"): Record<string, unknown> {
  return ev(sessionId, 1, { type: "session_created", scope, mode: "chat" });
}
function userMsg(sessionId: string, seq: number, text: string): Record<string, unknown> {
  return ev(sessionId, seq, { type: "user_message", threadId: "main", text, clientName: "iphone" });
}
function jsonl(events: Record<string, unknown>[]): Buffer {
  return Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
function b64(buf: Buffer): string { return buf.toString("base64"); }
function uuid(): string { return crypto.randomUUID(); }

/** The `session.setModel`/`sync.push`/`sync.config` shape — the ONE catalogue source. */
function fakeEngine(models: ModelInfo[]): any {
  return { knownModels: () => models, isRunning: () => false };
}

const CATALOGUE: ModelInfo[] = [
  { id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
];

describe("sync.push meta.effort — the second ingress (provider-correctness T6)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(over: { models?: ModelInfo[]; liveModel?: () => string } = {}): Promise<{
    store: SessionStore; socketPath: string; harnessToken: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-effort-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      liveModel: over.liveModel,
      ...(over.models ? { engine: fakeEngine(over.models), hub: new SessionHub(store) } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  // ------------------------------------------------------------------------------------------
  // The replication itself (the T4-review I2 gap)
  // ------------------------------------------------------------------------------------------

  test("a pushed effort lands on the daemon's index — the T4-review I2 gap, closed", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "hi")])), complete: true,
      meta: { model: "gpt-5.6-luna", effort: "xhigh" },
    });
    expect(res.error).toBeUndefined();
    // Would fail before T6: `effort` was not in `SyncPushParams.meta`, was not in `SyncMeta`, and
    // `applySyncMeta` wrote no effort column — so this read came back undefined while `model` was set.
    expect(store.meta(id).effort).toBe("xhigh");
    expect(store.meta(id).model).toBe("gpt-5.6-luna");
    c.close();
  });

  test("sync.heads reports the effort back — replication is bidirectional or it is a new divergence", async () => {
    const { socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const withEffort = uuid();
    const without = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: withEffort, baseSeq: 0, data: b64(jsonl([created(withEffort)])), complete: true,
      meta: { effort: "low" },
    });
    await c.request(METHODS.syncPush, {
      sessionId: without, baseSeq: 0, data: b64(jsonl([created(without)])), complete: true,
    });

    const heads = await c.request(METHODS.syncHeads, {});
    const rows: any[] = heads.result.sessions;
    expect(rows.find((s) => s.sessionId === withEffort).effort).toBe("low");
    // OMITTED, not null — absent means "no override", which is a different fact from any level
    // (only `title` is explicitly nullable on this row).
    expect("effort" in rows.find((s) => s.sessionId === without)).toBe(false);
    c.close();
  });

  test("an omitted effort is UNCHANGED, never cleared — applySyncMeta's present-fields-only rule", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "one")])), complete: true,
      meta: { effort: "high" },
    });
    expect(store.meta(id).effort).toBe("high");

    // An incremental push carrying only a title must not wipe the effort (the exact bug the
    // present-fields-only rule exists for, restated for the new field).
    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 2, data: b64(jsonl([userMsg(id, 3, "two")])), complete: true,
      meta: { title: "just a title" },
    });
    expect(res.error).toBeUndefined();
    expect(store.meta(id).effort).toBe("high");
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Drop-and-log, mirroring the model half verbatim
  // ------------------------------------------------------------------------------------------

  test("a wire-INVALID effort is dropped and the log still replicates in full", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    // "minimal" is a real level the endpoint refuses PER MODEL — the model-aware half of the check.
    expect(REASONING_EFFORTS).not.toContain("minimal");
    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "hi")])), complete: true,
      meta: { model: "gpt-5.6-sol", effort: "minimal" },
    });
    expect(res.error).toBeUndefined();          // NEVER fails the push — the events are irreplaceable
    expect(store.lastSeq(id)).toBe(2);          // ...and they all landed
    expect(store.meta(id).effort).toBeUndefined();
    expect(store.meta(id).model).toBe("gpt-5.6-sol"); // the model half is unaffected by the effort drop
    c.close();
  });

  test("a dropped effort never OVERWRITES a good one already on the row", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "one")])), complete: true,
      meta: { effort: "high" },
    });
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 2, data: b64(jsonl([userMsg(id, 3, "two")])), complete: true,
      meta: { effort: "not-a-level" },
    });
    expect(store.meta(id).effort).toBe("high");
    expect(store.lastSeq(id)).toBe(3);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // The tier rule — always dropped at THIS ingress
  // ------------------------------------------------------------------------------------------

  test("a pushed TIER (ultra) is always dropped — no session reachable here may hold one", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    expect(CLIENT_EFFORTS).toContain("ultra");
    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "hi")])), complete: true,
      meta: { effort: "ultra" },
    });
    expect(res.error).toBeUndefined();
    expect(store.lastSeq(id)).toBe(2);
    // sync.push creates CHAT sessions and nothing else; a tier is code-sessions-only. The two gates
    // compose to "unreachable", so the drop is derived, not a policy invention.
    expect(store.meta(id).mode).toBe("chat");
    expect(store.meta(id).effort).toBeUndefined();
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // The CLEAR — a wire null (C6 ruling, fix round 1)
  // ------------------------------------------------------------------------------------------

  test("meta.effort: null CLEARS the override; absent leaves it alone", async () => {
    const { store, socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "one")])), complete: true,
      meta: { effort: "high" },
    });
    expect(store.meta(id).effort).toBe("high");

    // ABSENT — unchanged. The stale-client protection: a client that never learned about the
    // override must not be able to wipe it just by pushing events.
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 2, data: b64(jsonl([userMsg(id, 3, "two")])), complete: true,
      meta: { title: "a title" },
    });
    expect(store.meta(id).effort).toBe("high");

    // NULL — an explicit clear. The SAME vocabulary `session.setEffort` already uses for this exact
    // field (`SessionSetEffortParams.effort` is `.nullable()`), so there is no second magic value to
    // remember and no ""→NULL mapping anyone can miss.
    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 3, data: b64(jsonl([userMsg(id, 4, "three")])), complete: true,
      meta: { effort: null },
    });
    expect(res.error).toBeUndefined();
    expect(store.meta(id).effort).toBeUndefined();
    expect(store.lastSeq(id)).toBe(4);
    c.close();
  });

  test("a clear is never validated — it cannot be dropped, and it does not reach the tier gate", async () => {
    // Clearing restores the precedence chain, so there is no model whose list it could fail and no
    // mode it could be ineligible for. A `null` that fell into either branch would be un-clearable.
    const known = CATALOGUE.map((m) => m.id);
    const dropped: string[] = [];
    // A NON-EMPTY wire list on purpose: with an empty one the permissive carve-out would admit the
    // null by accident and this test would prove nothing.
    const out = validateSyncMeta({ effort: null }, known, undefined, {
      model: "gpt-5.6-sol", efforts: () => ["low", "high"], onDroppedEffort: (e) => dropped.push(e),
    });
    expect(out.effort).toBeNull();
    expect(dropped).toEqual([]);
  });

  test("session.list and sync.heads both stop reporting a cleared effort", async () => {
    const { socketPath, harnessToken } = await boot({ models: CATALOGUE });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true, meta: { effort: "low" },
    });
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([userMsg(id, 2, "x")])), complete: true, meta: { effort: null },
    });

    const heads = await c.request(METHODS.syncHeads, {});
    expect("effort" in heads.result.sessions.find((s: any) => s.sessionId === id)).toBe(false);
    const listed = await c.request(METHODS.sessionList, {});
    expect(listed.result.sessions.find((s: any) => s.sessionId === id).effort).toBeUndefined();
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // validateSyncMeta directly — the unit the handler delegates to
  // ------------------------------------------------------------------------------------------

  test("validateSyncMeta: model-aware acceptance, drop callback, tier always refused", () => {
    const known = CATALOGUE.map((m) => m.id);
    const dropped: { effort: string; reason: string }[] = [];
    const onDroppedEffort = (effort: string, reason: string) => { dropped.push({ effort, reason }); };

    // Accepted: a level the model's own list carries.
    expect(validateSyncMeta({ effort: "xhigh" }, known, undefined, { model: "gpt-5.6-sol", onDroppedEffort }).effort).toBe("xhigh");
    expect(dropped).toEqual([]);

    // Refused: outside the model's list.
    expect(validateSyncMeta({ effort: "minimal" }, known, undefined, { model: "gpt-5.6-sol", onDroppedEffort }).effort).toBeUndefined();
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.effort).toBe("minimal");

    // Refused: a tier, regardless of model — and for a DIFFERENT stated reason than "unsupported".
    dropped.length = 0;
    expect(validateSyncMeta({ effort: "ultra" }, known, undefined, { model: "gpt-5.6-sol", onDroppedEffort }).effort).toBeUndefined();
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.reason).not.toBe(dropped[0]!.effort);
    expect(dropped[0]!.reason.toLowerCase()).toContain("tier");
  });

  test("validateSyncMeta: an EFFECTIVE model that is a pushed one is what the effort is checked against", () => {
    const known = CATALOGUE.map((m) => m.id);
    // `effortsForModel` is uniform today; this pins the SEAM (the caller passes the session's
    // effective model, not a hardcoded ""), so a future per-model divergence is a data change here
    // rather than a re-plumb.
    for (const level of effortsForModel("gpt-5.6-luna")) {
      expect(validateSyncMeta({ effort: level }, known, undefined, { model: "gpt-5.6-luna" }).effort).toBe(level);
    }
  });

  // M4 (review): the THIRD precedence rung — `ctx.liveModel`. Nothing exercised it, so deleting the
  // `liveModel: opts.liveModel` wiring in ipc/server.ts left the suite green while every pushed
  // effort silently degraded to being validated against `""`.
  test("a pushed effort on a session with NO model override is validated against the daemon's LIVE model", async () => {
    const { store, socketPath, harnessToken } = await boot({
      models: CATALOGUE,
      // A model the catalogue knows, deliberately NOT the one any push names.
      liveModel: () => "gpt-5.6-luna",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true, meta: { effort: "high" },
    });
    expect(store.meta(id).effort).toBe("high");
    expect(store.meta(id).model).toBeUndefined(); // no override — the live model is what decided

    // `effortsForModel` is uniform today, so the ONE externally-visible proof that the rung was
    // consulted (rather than silently defaulting to `""`) is the drop reason the handler logs. Spy
    // on it: without the `liveModel: opts.liveModel` wiring in ipc/server.ts this reads
    // `by the configured provider` instead of naming the live model, and the test fails.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const res = await c.request(METHODS.syncPush, {
        sessionId: id, baseSeq: 1, data: b64(jsonl([userMsg(id, 2, "x")])), complete: true,
        meta: { effort: "minimal" },
      });
      expect(res.error).toBeUndefined();
    } finally {
      console.warn = realWarn;
    }
    expect(store.meta(id).effort).toBe("high"); // the bad push never overwrote the good value
    expect(warnings.join("\n")).toContain("by model 'gpt-5.6-luna'");
    c.close();
  });

  // M3 (review): the drop reason must MIRROR `assertEffortSelectable`'s wording, including its
  // no-model fallback — `by model ''` is not a sentence, and the two surfaces explaining the same
  // refusal differently is the drift this whole plan is about.
  test("the drop reason mirrors assertEffortSelectable's wording, including the no-model case", () => {
    const known = CATALOGUE.map((m) => m.id);
    let reason = "";
    validateSyncMeta({ effort: "minimal" }, known, undefined, { model: "gpt-5.6-sol", onDroppedEffort: (_e, r) => { reason = r; } });
    expect(reason).toContain("by model 'gpt-5.6-sol'");

    validateSyncMeta({ effort: "minimal" }, known, undefined, { model: "", onDroppedEffort: (_e, r) => { reason = r; } });
    expect(reason).toContain("by the configured provider");
    expect(reason).not.toContain("by model ''");
  });

  test("validateSyncMeta: a provider that cannot enumerate efforts accepts freely (the permissive direction)", () => {
    // Mirrors `session.setEffort`'s own documented carve-out (ipc/server.ts m2 review): an empty
    // allowed-list means "can't check", never "refuse everything". `effortsForModel` is uniform and
    // non-empty today, so the only way to reach that branch is the injection seam.
    const known = CATALOGUE.map((m) => m.id);
    expect(validateSyncMeta({ effort: "high" }, known, undefined, { model: "gpt-5.6-sol", efforts: () => [] }).effort).toBe("high");
    // ...but a TIER is still refused, because that refusal does not come from the wire list at all.
    expect(validateSyncMeta({ effort: "ultra" }, known, undefined, { model: "gpt-5.6-sol", efforts: () => [] }).effort).toBeUndefined();
  });
});
