import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SYNC_PAGE_BYTES } from "../../src/ipc/sync";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// ================================================================================================
// Chat Slice D task 9 — the TS integration PROBE for the sync wire (the house pattern: a real daemon
// + a synthetic phone client in TypeScript, mirroring slice C's 49/49 drill). Where sync-core.test.ts
// pins each verb in isolation, this exercises the WHOLE reconciliation the Swift `SyncClient` drives,
// against a real daemon socket, to prove the daemon cooperates with the full realistic sequence:
//
//   create-on-phone → push → appears in the daemon list as a CHAT session (policy "chat")
//     → daemon-side (Mac) turns → phone pull → dual-append OFFLINE (both sides diverge)
//     → reconcile via FORK → EXACTLY 2 chat sessions on both sides, byte-compared.
//
//   ...plus a cursor-resumed MULTI-PAGE pull and an OVERSIZED single event (both byte-identical),
//   the two paging edge cases the phone store must survive.
//
// The phone half is modelled by `PhoneStore` — a tiny in-TS mirror of `LocalEventStore` (raw JSONL
// per session + a lastSyncedSeq watermark + the fork rewrite) — so this is a genuine end-to-end of
// the daemon SURFACE, with the client's algorithm reproduced here rather than driven from Swift.
// TS CAN touch the daemon; every run uses its own temp NORMA_HOME.
// ================================================================================================

/** Minimal raw NDJSON JSON-RPC client — duplicated from sync-core.test.ts (codebase convention:
 *  no shared test harness; every test/ipc/*.test.ts carries its own copy). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: any[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.event) { c.events.push(msg.params); continue; }
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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

  async hello(token: string, clientName: string, role = "remote"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

// --------------------------------------------------------------------------------------------
// Event/JSONL builders — the phone's byte producer (non-schema key order, so byte-identity means
// what it says: the daemon stores the client's exact bytes, not a re-serialization).
// --------------------------------------------------------------------------------------------

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
function asstMsg(sessionId: string, seq: number, text: string): Record<string, unknown> {
  return ev(sessionId, seq, { type: "assistant_message", threadId: "main", text });
}
function jsonlLine(e: Record<string, unknown>): Buffer { return Buffer.from(JSON.stringify(e) + "\n", "utf8"); }
function b64(buf: Buffer): string { return buf.toString("base64"); }
function uuid(): string { return crypto.randomUUID(); }

// --------------------------------------------------------------------------------------------
// PhoneStore — the in-TS mirror of the Swift LocalEventStore: raw JSONL bytes per session, a
// per-session lastSyncedSeq watermark, and the fork rewrite (byte-identical modulo the id).
// --------------------------------------------------------------------------------------------

class PhoneStore {
  private logs = new Map<string, Buffer>();     // sessionId -> raw JSONL
  private synced = new Map<string, number>();   // sessionId -> lastSyncedSeq

  append(sessionId: string, e: Record<string, unknown>): void {
    this.logs.set(sessionId, Buffer.concat([this.logs.get(sessionId) ?? Buffer.alloc(0), jsonlLine(e)]));
  }
  appendRaw(sessionId: string, raw: Buffer): void {
    this.logs.set(sessionId, Buffer.concat([this.logs.get(sessionId) ?? Buffer.alloc(0), raw]));
  }
  log(sessionId: string): Buffer { return this.logs.get(sessionId) ?? Buffer.alloc(0); }
  has(sessionId: string): boolean { return this.logs.has(sessionId); }
  ids(): string[] { return [...this.logs.keys()]; }
  lastSyncedSeq(sessionId: string): number { return this.synced.get(sessionId) ?? 0; }
  setSynced(sessionId: string, seq: number): void { this.synced.set(sessionId, seq); }

  /** The verbatim byte tail with seq > fromSeq — the exact bytes a push sends (mirrors rawTail). */
  rawTail(sessionId: string, fromSeq: number): Buffer {
    const kept = this.lines(sessionId).filter((l) => (JSON.parse(l) as { seq: number }).seq > fromSeq);
    return kept.length ? Buffer.from(kept.join("\n") + "\n", "utf8") : Buffer.alloc(0);
  }
  /** Truncate to seq <= toSeq (the fork's original-session reconciliation). */
  truncate(sessionId: string, toSeq: number): void {
    const kept = this.lines(sessionId).filter((l) => (JSON.parse(l) as { seq: number }).seq <= toSeq);
    this.logs.set(sessionId, kept.length ? Buffer.from(kept.join("\n") + "\n", "utf8") : Buffer.alloc(0));
  }
  /** Copy the whole log to a new id, rewriting every occurrence of the id (mirrors fork). */
  fork(originalId: string, newId: string): void {
    this.logs.set(newId, Buffer.from(this.log(originalId).toString("utf8").replaceAll(originalId, newId), "utf8"));
  }
  lastSeq(sessionId: string): number {
    const lines = this.lines(sessionId);
    return lines.length ? (JSON.parse(lines[lines.length - 1]!) as { seq: number }).seq : 0;
  }
  private lines(sessionId: string): string[] {
    return this.log(sessionId).toString("utf8").split("\n").filter((l) => l.length > 0);
  }
}

// --------------------------------------------------------------------------------------------
// Phone sync primitives — chunked push, paged pull (the client algorithm, in TS).
// --------------------------------------------------------------------------------------------

async function pushChunked(c: TestClient, sessionId: string, baseSeq: number, raw: Buffer,
                           meta?: Record<string, unknown>): Promise<any> {
  const chunk = 256 * 1024;
  let last: any;
  for (let off = 0; off < raw.length; off += chunk) {
    const slice = raw.subarray(off, off + chunk);
    const complete = off + chunk >= raw.length;
    last = await c.request(METHODS.syncPush, {
      sessionId, baseSeq, data: b64(slice), complete, ...(complete && meta ? { meta } : {}),
    });
    if (last.error) return last;
  }
  return last;
}

async function pullAll(c: TestClient, sessionId: string, fromSeq: number): Promise<{ bytes: Buffer; pages: number }> {
  const chunks: Buffer[] = [];
  let cursor: number | undefined;
  let pages = 0;
  for (;;) {
    const res = await c.request(METHODS.syncPull, { sessionId, fromSeq, ...(cursor === undefined ? {} : { cursor }) });
    expect(res.error).toBeUndefined();
    pages++;
    chunks.push(Buffer.from(res.result.data, "base64"));
    if (res.result.complete) break;
    cursor = res.result.nextCursor;
    if (pages > 500) throw new Error("pull did not terminate");
  }
  return { bytes: Buffer.concat(chunks), pages };
}

describe("sync phone drill (Chat Slice D task 9) — the full reconcile against a real daemon", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-drill-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, remoteToken: tokens.remote };
  }

  // ------------------------------------------------------------------------------------------
  // The full drill: create → push → list → daemon turns → pull → dual-append → reconcile.
  // ------------------------------------------------------------------------------------------

  test("create-on-phone → push → daemon turns → pull → dual-append → fork-reconcile → 2 sessions, byte-compared", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote"); // the phone is a REMOTE caller
    const phone = new PhoneStore();

    // --- Phase A: create on the phone, push it up ---
    const sA = uuid();
    for (const e of [created(sA), userMsg(sA, 2, "hello from the phone"), asstMsg(sA, 3, "hi back")]) phone.append(sA, e);
    const pushed = await pushChunked(c, sA, 0, phone.rawTail(sA, 0), { title: "Phone chat" });
    expect(pushed.error).toBeUndefined();
    expect(pushed.result.applied).toBe(true);
    expect(pushed.result.lastSeq).toBe(3);
    phone.setSynced(sA, 3);

    // ...it appears in the daemon list as a CHAT session with the fixed "chat" policy.
    const macMeta = store.meta(sA);
    expect(macMeta.mode).toBe("chat");
    expect(macMeta.approvalPolicy).toBe("chat");
    expect(store.list().filter((r) => r.mode === "chat").map((r) => r.sessionId)).toEqual([sA]);

    // --- Phase B: the Mac takes two turns on it (daemon-side authoring) ---
    store.append(sA, { type: "user_message", sessionId: sA, threadId: "main", text: "mac question", clientName: "cli" });
    store.append(sA, { type: "assistant_message", sessionId: sA, threadId: "main", text: "mac answer" });
    expect(store.lastSeq(sA)).toBe(5);

    // --- Phase C: the phone pulls the Mac's turns and becomes byte-identical ---
    const cAfterTurns = await pullAll(c, sA, phone.lastSyncedSeq(sA));
    phone.appendRaw(sA, cAfterTurns.bytes);
    phone.setSynced(sA, 5);
    expect(phone.lastSeq(sA)).toBe(5);
    // byte-identity: the phone's copy equals the daemon's file (pull the whole log and compare).
    const fullA = await pullAll(c, sA, 0);
    expect(phone.log(sA).equals(fullA.bytes)).toBe(true);

    // --- Phase D: BOTH sides append while offline (a genuine two-sided divergence) ---
    phone.append(sA, userMsg(sA, 6, "phone-only branch"));
    phone.append(sA, asstMsg(sA, 7, "phone-only reply"));
    store.append(sA, { type: "user_message", sessionId: sA, threadId: "main", text: "mac-only branch", clientName: "cli" });
    store.append(sA, { type: "assistant_message", sessionId: sA, threadId: "main", text: "mac-only reply" });
    expect(store.lastSeq(sA)).toBe(7);

    // --- Reconcile: push the phone branch → DIVERGED{lastSeq:7} → fork, then pull the Mac branch ---
    const diverged = await c.request(METHODS.syncPush, {
      sessionId: sA, baseSeq: phone.lastSyncedSeq(sA), data: b64(phone.rawTail(sA, phone.lastSyncedSeq(sA))), complete: true,
    });
    expect(diverged.error).toBeTruthy();
    expect(diverged.error.code).toBe(ERR.DIVERGED);
    expect(diverged.error.data.lastSeq).toBe(7); // non-zero → fork, not re-push

    // 1. fork the entire local log to a fresh id, byte-identical modulo the id rewrite.
    const sB = uuid();
    const preForkA = Buffer.from(phone.log(sA)); // the full local log (seq 1..7) the fork must copy
    phone.fork(sA, sB);
    expect(phone.log(sB).equals(Buffer.from(preForkA.toString("utf8").replaceAll(sA, sB), "utf8"))).toBe(true);

    // 2. push the fork as a NEW session (baseSeq 0), carrying its fork provenance.
    const forkPush = await pushChunked(c, sB, 0, phone.log(sB),
      { title: "Phone chat (offline copy)", forkedFrom: { sessionId: sA, atSeq: 5 } });
    expect(forkPush.error).toBeUndefined();
    expect(forkPush.result.applied).toBe(true);
    phone.setSynced(sB, phone.lastSeq(sB));

    // 3. reconcile the original: drop the divergent tail, pull the Mac's branch in its place.
    phone.truncate(sA, 5);
    const macBranch = await pullAll(c, sA, 5);
    phone.appendRaw(sA, macBranch.bytes);
    phone.setSynced(sA, 7);

    // ---- Postcondition: EXACTLY 2 chat sessions on BOTH sides, byte-identical ----
    const heads = await c.request(METHODS.syncHeads, {});
    const headIds = heads.result.sessions.map((s: any) => s.sessionId).sort();
    expect(headIds).toEqual([sA, sB].sort());
    expect(store.list().filter((r) => r.mode === "chat").length).toBe(2);
    expect(phone.ids().sort()).toEqual([sA, sB].sort());

    // fork provenance survived the round-trip.
    const forkRow = heads.result.sessions.find((s: any) => s.sessionId === sB);
    expect(forkRow.forkedFrom).toEqual({ sessionId: sA, atSeq: 5 });

    // byte-compare each session: daemon file === phone copy.
    const daemonA = await pullAll(c, sA, 0);
    const daemonB = await pullAll(c, sB, 0);
    expect(phone.log(sA).equals(daemonA.bytes)).toBe(true);
    expect(phone.log(sB).equals(daemonB.bytes)).toBe(true);

    // the original now carries the MAC branch; the fork carries the PHONE branch — the divergence
    // was preserved, not lost.
    expect(daemonA.bytes.toString("utf8")).toContain("mac-only branch");
    expect(daemonA.bytes.toString("utf8")).not.toContain("phone-only branch");
    expect(daemonB.bytes.toString("utf8")).toContain("phone-only branch");
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Cursor-resumed multi-page pull — a log larger than one page comes back over several pages,
  // byte-identical, exactly as the phone's paged pull reassembles it.
  // ------------------------------------------------------------------------------------------

  test("a multi-page session pulls back byte-identically over cursor-resumed pages", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const phone = new PhoneStore();
    const id = uuid();
    phone.append(id, created(id));
    for (let seq = 2; seq <= 41; seq++) phone.append(id, asstMsg(id, seq, "x".repeat(10 * 1024)));
    expect(phone.log(id).length).toBeGreaterThan(SYNC_PAGE_BYTES);

    const pushed = await pushChunked(c, id, 0, phone.log(id));
    expect(pushed.error).toBeUndefined();

    const pulled = await pullAll(c, id, 0);
    expect(pulled.pages).toBeGreaterThan(1);
    expect(pulled.bytes.equals(phone.log(id))).toBe(true);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // An oversized single event — larger than a whole page — survives push+pull byte-identically
  // (raw-JSONL-bytes paging makes it a non-problem: it just spans pages).
  // ------------------------------------------------------------------------------------------

  test("a single event larger than a page survives push+pull byte-identically", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const phone = new PhoneStore();
    const id = uuid();
    phone.append(id, created(id));
    phone.append(id, asstMsg(id, 2, "z".repeat(SYNC_PAGE_BYTES + 4096)));
    expect(phone.rawTail(id, 1).length).toBeGreaterThan(SYNC_PAGE_BYTES);

    const pushed = await pushChunked(c, id, 0, phone.log(id));
    expect(pushed.error).toBeUndefined();
    const pulled = await pullAll(c, id, 0);
    expect(pulled.pages).toBeGreaterThan(1);
    expect(pulled.bytes.equals(phone.log(id))).toBe(true);
    c.close();
  });
});
