import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR,
  SESSION_TITLE_MAX_CHARS, SYNC_MAX_CHUNK_B64, IROH_MAX_FRAME_BYTES,
  type WritableSocket,
} from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SyncPushBuffers, SYNC_PAGE_BYTES } from "../../src/ipc/sync";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat Slice D task 2, FIX ROUND (review 19d72576..c972e422, findings I1/I2/I3 + M1/M2/M4/M5).
//
// Everything here defends the SAME property from three directions: nothing a paired phone can put
// through `sync.push` may leave the daemon in a state its own responses cannot be delivered from,
// or a session it cannot run a turn on.
//
//   I1 — a pushed `meta.model` the provider does not know must never reach the model column. An
//        unvalidated slug bricks every subsequent turn on that session (AgentEngine.resolveSel
//        hands it straight to the provider) and the phone has no way to clear it. This is the exact
//        class Task 1's fix round closed for `session.setModel`; sync wrote the same column and
//        skipped all of it.
//   I2 — `title` is remote-settable on two new paths and both `sync.heads` and `session.list` are
//        UNPAGED, so two ~600 KiB titles would push every heads/list response past iroh's 1 MiB
//        frame limit — a PERSISTENT connection kill (the value lives in index.db and survives
//        restart) whose own repair call (`sync.heads`) is one of the broken ones.
//   I3 — the push chunk ceiling must be sized against the PHONE transport's 1 MiB frame, not the
//        local socket's 8 MiB line cap. Task 9 will read the schema max as "the chunk size the
//        daemon accepts"; at 4 MiB that guidance killed the connection with no RPC error to log.

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  /** Byte length of every response frame this client received — I2/I3's transport assertions. */
  readonly frameSizes: number[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            c.frameSizes.push(Buffer.byteLength(line, "utf8"));
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

  /** Returns the response AND the exact byte size of the frame it arrived in. */
  async requestSized(method: string, params?: unknown): Promise<{ msg: any; frameBytes: number }> {
    const before = this.frameSizes.length;
    const msg = await this.request(method, params);
    return { msg, frameBytes: this.frameSizes[before] ?? 0 };
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

const TS = 1_753_900_000_000;
function ev(sessionId: string, seq: number, rest: Record<string, unknown>): Record<string, unknown> {
  return { sessionId, seq, ts: TS + seq, ...rest };
}
function created(sessionId: string): Record<string, unknown> {
  return ev(sessionId, 1, { type: "session_created", scope: "global", mode: "chat" });
}
function asstMsg(sessionId: string, seq: number, text: string): Record<string, unknown> {
  return ev(sessionId, seq, { type: "assistant_message", threadId: "main", text });
}
function jsonl(events: Record<string, unknown>[]): Buffer {
  return Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
function b64(buf: Buffer): string { return buf.toString("base64"); }
function uuid(): string { return crypto.randomUUID(); }

/** Pushes `raw` split into chunks that each fit under `SYNC_MAX_CHUNK_B64`. This is how a hostile
 *  payload larger than one chunk actually arrives now that I3 bounds a single frame — the chunk cap
 *  limits ONE frame, not the 32 MiB a client may reassemble across many, so the title bound has to
 *  hold against the chunked path, not just the single-frame one. */
async function pushChunked(
  c: TestClient, sessionId: string, baseSeq: number, raw: Buffer, meta?: unknown,
): Promise<any> {
  const chunkRaw = 256 * 1024; // 349,528 base64 chars — under the 384 KiB ceiling
  let last: any;
  for (let off = 0; off < raw.length; off += chunkRaw) {
    const slice = raw.subarray(off, off + chunkRaw);
    const isLast = off + chunkRaw >= raw.length;
    last = await c.request(METHODS.syncPush, {
      sessionId, baseSeq, data: b64(slice), complete: isLast,
      ...(isLast && meta !== undefined ? { meta } : {}),
    });
    if (last.error) return last;
  }
  return last;
}

/** A stub engine exposing only what `session.setModel`/`sync.push` consult. */
function fakeEngine(ids: string[]): any {
  return { knownModels: () => ids.map((id) => ({ id })), isRunning: () => false };
}

describe("I1 — a pushed meta.model is validated exactly like session.setModel's", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(models: string[] | null): Promise<{ store: SessionStore; socketPath: string; token: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-model-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      // An engine requires a shared hub (startIpcServer enforces it); the stub only ever answers
      // knownModels(), which is all sync.push's validation consults.
      ...(models ? { engine: fakeEngine(models), hub: new SessionHub(store) } : {}),
    } as any);
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, token: tokens.harness };
  }

  test("a KNOWN model is stored", async () => {
    const { store, socketPath, token } = await boot(["claude-opus-5", "gpt-6"]);
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true,
      meta: { model: "claude-opus-5" },
    });
    expect(res.error).toBeUndefined();
    expect(store.meta(id).model).toBe("claude-opus-5");
    c.close();
  });

  test("an UNAMBIGUOUS ALIAS is resolved to the canonical id (session.setModel's idiom)", async () => {
    const { store, socketPath, token } = await boot(["claude-opus-5", "gpt-6"]);
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true,
      meta: { model: "5" }, // "claude-opus-5" is the only id ending in "-5"
    });
    expect(store.meta(id).model).toBe("claude-opus-5");
    c.close();
  });

  // The rejection POLICY, decided here and pinned: an unknown slug is DROPPED, not fatal. A model
  // mismatch between a phone and a Mac must never block log replication — the events are the
  // durable, irreplaceable half and the model is a hint. Dropping also cannot half-apply: the log
  // lands in full, and the column is simply left at whatever it already was.
  test("an UNKNOWN model is DROPPED — the events still land and the column stays clear", async () => {
    const { store, socketPath, token } = await boot(["claude-opus-5"]);
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), asstMsg(id, 2, "hi")])), complete: true,
      meta: { title: "kept", model: "phone-only-slug-the-mac-never-heard-of" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result.applied).toBe(true);
    expect(res.result.lastSeq).toBe(2);
    expect(store.lastSeq(id)).toBe(2);           // replication was NOT blocked
    expect(store.meta(id).model).toBeUndefined(); // ...and the bricking slug never landed
    expect(store.list().find((r) => r.sessionId === id)!.title).toBe("kept"); // the rest of meta applied
    c.close();
  });

  test("an UNKNOWN model never OVERWRITES a good one already on the row", async () => {
    const { store, socketPath, token } = await boot(["claude-opus-5"]);
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true, meta: { model: "claude-opus-5" },
    });

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([asstMsg(id, 2, "x")])), complete: true,
      meta: { model: "nonsense" },
    });
    expect(store.meta(id).model).toBe("claude-opus-5");
    c.close();
  });

  // Same fallback session.setModel takes: a provider that cannot enumerate its models cannot
  // validate anything, so the value is stored freely rather than rejected wholesale.
  test("with NO enumerable models the pushed value is stored freely (setModel's own fallback)", async () => {
    const { store, socketPath, token } = await boot(null); // no engine at all
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();

    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true,
      meta: { model: "some-byo-endpoint-model" },
    });
    expect(store.meta(id).model).toBe("some-byo-endpoint-model");
    c.close();
  });
});

describe("I2 — title is bounded at every ingress, so heads/list can never outgrow a frame", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; token: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-title-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, token: tokens.harness };
  }

  const HOSTILE = "T".repeat(600 * 1024);

  test("meta.title over the cap is refused at the wire schema (INVALID_PARAMS)", async () => {
    const { store, socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true, meta: { title: HOSTILE },
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.list().length).toBe(0); // nothing created
    c.close();
  });

  // The second ingress: a pushed `session_titled` EVENT. Its bytes are replicated verbatim (that is
  // the byte-identity contract and must not change), but the INDEX column it derives is clamped.
  test("a pushed session_titled event replicates verbatim yet lands CLAMPED in the index", async () => {
    const { store, socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    const raw = jsonl([created(id), ev(id, 2, { type: "session_titled", threadId: "main", title: HOSTILE })]);

    const res = await pushChunked(c, id, 0, raw);
    expect(res.error).toBeUndefined();

    // Byte-identity of the LOG is preserved — the hostile title is still in the replicated bytes...
    const chunks: Buffer[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0, ...(cursor === undefined ? {} : { cursor }) });
      chunks.push(Buffer.from(page.result.data, "base64"));
      if (page.result.complete) break;
      cursor = page.result.nextCursor;
    }
    expect(Buffer.concat(chunks).equals(raw)).toBe(true);

    // ...but the INDEX column, which is what heads/list serialize, is bounded.
    const row = store.list().find((r) => r.sessionId === id)!;
    expect(row.title!.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS + 1); // +1 for the ellipsis
    c.close();
  });

  // THE FINDING'S OWN SCENARIO, end to end: two hostile-title sessions used to make every
  // heads/list response exceed the phone transport's frame limit, permanently.
  test("two hostile-title pushes can no longer produce an oversized sync.heads or session.list response", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");

    for (let i = 0; i < 2; i++) {
      const id = uuid();
      const raw = jsonl([created(id), ev(id, 2, { type: "session_titled", threadId: "main", title: HOSTILE })]);
      const res = await pushChunked(c, id, 0, raw);
      expect(res.error).toBeUndefined();
    }

    const heads = await c.requestSized(METHODS.syncHeads, {});
    expect(heads.msg.error).toBeUndefined();
    expect(heads.msg.result.sessions.length).toBe(2);
    expect(heads.frameBytes).toBeLessThan(IROH_MAX_FRAME_BYTES);

    const list = await c.requestSized(METHODS.sessionList, {});
    expect(list.msg.error).toBeUndefined();
    expect(list.frameBytes).toBeLessThan(IROH_MAX_FRAME_BYTES);
    c.close();
  });

  // Defence for rows that predate this fix: `list()` is the ONE read point feeding both remote
  // surfaces, so clamping on read is what makes the bound structural rather than write-path-only.
  test("a hostile title written DIRECTLY to the index (pre-fix row) is still clamped on read", async () => {
    const { store, socketPath, token } = await boot();
    const id = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
    (store as any).db.run("UPDATE sessions SET title = ? WHERE session_id = ?", [HOSTILE, id]);

    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const heads = await c.requestSized(METHODS.syncHeads, {});
    expect(heads.msg.result.sessions[0].title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS + 1);
    expect(heads.frameBytes).toBeLessThan(IROH_MAX_FRAME_BYTES);
    c.close();
  });

  test("an ordinary title is untouched (control — the cap is far above every real writer)", async () => {
    const { store, socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true,
      meta: { title: "Planning the kitchen renovation" },
    });
    expect(store.list().find((r) => r.sessionId === id)!.title).toBe("Planning the kitchen renovation");
    c.close();
  });
});

describe("I3 — the push chunk ceiling is sized against the PHONE frame, not the local socket", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; token: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-chunk-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, token: tokens.harness };
  }

  test("the ceiling admits a full SYNC_PAGE_BYTES page re-encoded (pull and push are symmetric)", () => {
    const b64OfAFullPage = Math.ceil(SYNC_PAGE_BYTES / 3) * 4;
    expect(SYNC_MAX_CHUNK_B64).toBeGreaterThanOrEqual(b64OfAFullPage);
  });

  test("a SCHEMA-MAXIMAL chunk fits inside one iroh frame, envelope included", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");

    // The largest `data` the schema accepts, wrapped in the real JSON-RPC frame the client sends.
    const maximal = "A".repeat(SYNC_MAX_CHUNK_B64);
    const frame = encodeLine({
      jsonrpc: "2.0", id: 999, method: METHODS.syncPush,
      params: { sessionId: crypto.randomUUID(), baseSeq: 0, data: maximal, complete: false },
    });
    expect(Buffer.byteLength(frame as unknown as string, "utf8")).toBeLessThan(IROH_MAX_FRAME_BYTES);
    c.close();
  });

  test("a maximal-size REAL chunk round-trips: pushed in one frame, pulled back byte-identically", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    // One event big enough that its base64 lands just under the schema ceiling.
    const rawTarget = Math.floor((SYNC_MAX_CHUNK_B64 / 4) * 3) - 4096;
    const events = [created(id), asstMsg(id, 2, "Q".repeat(rawTarget - 200))];
    const raw = jsonl(events);
    const encoded = b64(raw);
    expect(encoded.length).toBeLessThanOrEqual(SYNC_MAX_CHUNK_B64);

    const res = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: encoded, complete: true });
    expect(res.error).toBeUndefined();
    expect(res.result.lastSeq).toBe(2);

    // ...and it comes back over multiple pull pages, each inside a frame.
    const chunks: Buffer[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await c.requestSized(METHODS.syncPull, { sessionId: id, fromSeq: 0, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.frameBytes).toBeLessThan(IROH_MAX_FRAME_BYTES);
      chunks.push(Buffer.from(page.msg.result.data, "base64"));
      if (page.msg.result.complete) break;
      cursor = page.msg.result.nextCursor;
    }
    expect(Buffer.concat(chunks).equals(raw)).toBe(true);
    c.close();
  });

  test("a chunk OVER the ceiling is a clean INVALID_PARAMS, not a dropped connection", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");

    const res = await c.request(METHODS.syncPush, {
      sessionId: uuid(), baseSeq: 0, data: "A".repeat(SYNC_MAX_CHUNK_B64 + 1), complete: false,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });
});

describe("fix-round minors (M1/M2/M4/M5)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; token: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-minors-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, token: tokens.harness };
  }

  // M1: Buffer.from(s, "base64") silently drops non-alphabet characters instead of throwing, so the
  // old catch was dead code and garbage surfaced as a confusing "line 1 is not valid JSON".
  test("M1 — non-base64 data is reported AS non-base64, not as bad JSON", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");

    const res = await c.request(METHODS.syncPush, {
      sessionId: uuid(), baseSeq: 0, data: "!!!! not base64 @@@@", complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toMatch(/base64/i);
    expect(res.error.message).not.toMatch(/valid JSON/i);
    c.close();
  });

  // M2: the "must open with a chat session_created" guard was keyed on `creating`, so a row left at
  // last_seq 0 (the one window where createSynced succeeds and appendSynced then throws) took the
  // incremental branch and skipped the check entirely. Keying on `first.seq === 1` closes it.
  test("M2 — a seq-1 batch is guarded even when the row already exists at last_seq 0", async () => {
    const { store, socketPath, token } = await boot();
    const id = crypto.randomUUID();
    // Reproduce the stranded row directly — the state the narrow failure window produces.
    store.createSynced(id, { scope: "global", cwd: "/tmp", approvalPolicy: "chat", mode: "chat" });
    expect(store.lastSeq(id)).toBe(0);

    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([ev(id, 1, { type: "user_message", threadId: "main", text: "no header", clientName: "p" })])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.lastSeq(id)).toBe(0);

    // ...and a properly-headed batch still completes the stranded row.
    const ok = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });
    expect(ok.error).toBeUndefined();
    expect(store.lastSeq(id)).toBe(1);
    c.close();
  });

  // M5: a client already behind used to be able to stream up to 32 MiB of chunks before being told
  // on the FINAL chunk that it had diverged.
  test("M5 — divergence is reported on the FIRST chunk, not after the whole batch is buffered", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), asstMsg(id, 2, "a")])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(Buffer.from("{partial")), complete: false, // NOT the final chunk
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.DIVERGED);
    expect(res.error.data).toEqual({ lastSeq: 2 });
    c.close();
  });

  test("M5 — a matching baseSeq on a non-final chunk still buffers normally (control)", async () => {
    const { socketPath, token } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 1, data: b64(Buffer.from("{par")), complete: false });
    expect(res.error).toBeUndefined();
    expect(res.result.applied).toBe(false);
    expect(res.result.buffered).toBe(4);
    c.close();
  });
});

// M4: the one cap added out of brief and the only one nobody pinned.
describe("M4 — SyncPushBuffers bounds the NUMBER of concurrent buffers per connection", () => {
  test("a connection may not open more than maxOpen buffers at once", () => {
    const b = new SyncPushBuffers({ maxOpen: 2 });
    b.append(1, "s1", Buffer.from("a"));
    b.append(1, "s2", Buffer.from("b"));
    expect(() => b.append(1, "s3", Buffer.from("c"))).toThrow(/too many concurrent/i);
    // ...an ALREADY-open buffer still accepts more, and a different connection is unaffected.
    expect(b.append(1, "s1", Buffer.from("a"))).toBe(2);
    expect(b.append(2, "s3", Buffer.from("c"))).toBe(1);
  });

  test("draining a buffer frees a slot", () => {
    const b = new SyncPushBuffers({ maxOpen: 2 });
    b.append(1, "s1", Buffer.from("a"));
    b.append(1, "s2", Buffer.from("b"));
    b.take(1, "s1");
    expect(b.append(1, "s3", Buffer.from("c"))).toBe(1);
  });
});
