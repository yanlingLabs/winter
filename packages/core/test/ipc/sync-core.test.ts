import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SYNC_PAGE_BYTES, SyncPushBuffers } from "../../src/ipc/sync";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat Slice D task 2 — the sync wire: `sync.heads` / `sync.pull` / `sync.push`, the replication
// seam between a phone's local chat session logs and the daemon's own. Exercised over a REAL
// daemon socket (own temp NORMA_HOME + SessionStore + TokenAuthority, no AgentEngine) — the same
// harness shape as session-set-model.test.ts/remote-chat-gate.test.ts (this codebase's convention:
// no shared test-harness module, every test/ipc/*.test.ts carries its own copy).
//
// The contract under test:
//  - sync.heads {}                                  → { sessions: [{ sessionId, lastSeq, title, model?, forkedFrom? }] }
//  - sync.pull  { sessionId, fromSeq, cursor? }      → { data: base64 raw JSONL, nextCursor?, complete }
//  - sync.push  { sessionId, baseSeq, data, complete, meta? } → { applied, lastSeq, buffered }
// All three are CHAT-ONLY and fail closed on an absent/unknown mode (the plan-immunity
// composing-seam rule): `mode ?? "code"` is the store-wide convention, so an absent mode is a code
// session and is refused, never waved through.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated from session-set-model.test.ts. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  /** Every `event` notification this connection received (the harness broadcast stream). */
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

// --------------------------------------------------------------------------------------------
// Event/JSONL builders — the phone's side of the wire. Note the deliberately NON-schema key order
// (sessionId first, `seq`/`ts` after): the byte-identity assertions below only mean something if
// the bytes the daemon stores are the bytes the client sent, not a re-serialization in zod's own
// shape order (which would put `seq` first).
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
/** The exact JSONL bytes a client would hold on disk (one compact JSON object per line). */
function jsonl(events: Record<string, unknown>[]): Buffer {
  return Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
function b64(buf: Buffer): string { return buf.toString("base64"); }

/** A v4 UUID, the id shape a phone mints for a session it created locally. */
function uuid(): string { return crypto.randomUUID(); }

/** Drains sync.pull page by page and returns the concatenated raw JSONL bytes. */
async function pullAll(c: TestClient, sessionId: string, fromSeq = 0): Promise<{ bytes: Buffer; pages: number }> {
  const chunks: Buffer[] = [];
  let cursor: number | undefined;
  let pages = 0;
  for (;;) {
    const res = await c.request(METHODS.syncPull, { sessionId, fromSeq, ...(cursor === undefined ? {} : { cursor }) });
    expect(res.error).toBeUndefined();
    pages++;
    chunks.push(Buffer.from(res.result.data, "base64"));
    if (res.result.complete) { expect(res.result.nextCursor).toBeUndefined(); break; }
    expect(typeof res.result.nextCursor).toBe("number");
    cursor = res.result.nextCursor;
    if (pages > 200) throw new Error("pull did not terminate");
  }
  return { bytes: Buffer.concat(chunks), pages };
}

describe("sync.heads / sync.pull / sync.push (Chat Slice D task 2)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; home: string; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-core-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };
    return { store, home, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  // ------------------------------------------------------------------------------------------
  // Fresh push: an unknown sessionId with baseSeq 0 CREATES the session
  // ------------------------------------------------------------------------------------------

  test("fresh push (unknown id + baseSeq 0) creates the chat session and lands every event", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const events = [created(id), userMsg(id, 2, "hello from the phone"), asstMsg(id, 3, "hi back")];

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl(events)), complete: true,
    });
    expect(res.error).toBeUndefined();
    expect(res.result.applied).toBe(true);
    expect(res.result.lastSeq).toBe(3);

    const meta = store.meta(id);
    expect(meta.mode).toBe("chat");
    expect(meta.approvalPolicy).toBe("chat");
    expect(meta.cwd).toBe(homedir());
    expect(store.lastSeq(id)).toBe(3);
    expect(store.read(id, 0).map((e) => e.type)).toEqual(["session_created", "user_message", "assistant_message"]);
    c.close();
  });

  test("a creating push stores the client's bytes VERBATIM (no re-serialization)", async () => {
    const { store, home, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "verbatim")]);

    const res = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    expect(res.error).toBeUndefined();

    const onDisk = readFileSync(join(home, "sessions", "global", `${id}.jsonl`));
    expect(onDisk.equals(raw)).toBe(true);
    expect(store.lastSeq(id)).toBe(2);
    c.close();
  });

  test("a creating push broadcasts session_created to every authed harness (the session.create signal)", async () => {
    const { socketPath, harnessToken } = await boot();
    // A watcher harness that is NOT attached to anything — exactly the sidebar case session.create's
    // own broadcast exists for. The ledgered `session.dispatch` gap (a new session nobody was told
    // about) must not be reproduced here.
    const watcher = await TestClient.connect(socketPath);
    await watcher.hello(harnessToken, "watcher");

    const pusher = await TestClient.connect(socketPath);
    await pusher.hello(harnessToken, "sync-client");
    const id = uuid();
    const res = await pusher.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "hi")])), complete: true,
    });
    expect(res.error).toBeUndefined();
    await Bun.sleep(50);

    const createdEvents = watcher.events.filter((e) => e.type === "session_created" && e.sessionId === id);
    expect(createdEvents.length).toBe(1);
    expect(createdEvents[0].mode).toBe("chat");
    // A push that only APPENDS must not re-announce the session.
    watcher.events.length = 0;
    await pusher.request(METHODS.syncPush, { sessionId: id, baseSeq: 2, data: b64(jsonl([asstMsg(id, 3, "more")])), complete: true });
    await Bun.sleep(50);
    expect(watcher.events.filter((e) => e.type === "session_created")).toEqual([]);
    watcher.close(); pusher.close();
  });

  test("a non-UUID session id is refused on the CREATE path (INVALID_PARAMS, nothing created)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = "../../escape";

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a creating push whose first event is not a chat session_created is refused (index-rebuild durability)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();

    // seq 1 is a user_message — a full index.db rebuild derives `mode` from the FIRST event, so a
    // log that doesn't open with a chat session_created would silently come back as a code session.
    const noCreate = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([userMsg(id, 1, "hi")])), complete: true,
    });
    expect(noCreate.error).toBeTruthy();
    expect(noCreate.error.code).toBe(ERR.INVALID_PARAMS);

    // ...and a session_created that claims a NON-chat mode is refused for the same reason: sync
    // creates chat sessions only.
    const codeMode = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0,
      data: b64(jsonl([ev(id, 1, { type: "session_created", scope: "global", mode: "code" })])),
      complete: true,
    });
    expect(codeMode.error).toBeTruthy();
    expect(codeMode.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.list().length).toBe(0);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Incremental push
  // ------------------------------------------------------------------------------------------

  test("incremental push appends onto an existing chat session", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "one")])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 2, data: b64(jsonl([asstMsg(id, 3, "two"), userMsg(id, 4, "three")])), complete: true,
    });
    expect(res.error).toBeUndefined();
    expect(res.result.lastSeq).toBe(4);
    expect(store.read(id, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    c.close();
  });

  test("a chunked push reassembles across calls and applies exactly once", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "chunked"), asstMsg(id, 3, "reassembled")]);
    const mid = Math.floor(raw.length / 2); // deliberately mid-LINE

    const first = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(0, mid)), complete: false });
    expect(first.error).toBeUndefined();
    expect(first.result.applied).toBe(false);
    expect(first.result.buffered).toBe(mid);
    expect(store.list().length).toBe(0); // nothing lands until `complete`

    const last = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(mid)), complete: true });
    expect(last.error).toBeUndefined();
    expect(last.result.applied).toBe(true);
    expect(last.result.lastSeq).toBe(3);
    expect(store.lastSeq(id)).toBe(3);
    c.close();
  });

  test("push meta {title, model, forkedFrom} is recorded and surfaces in sync.heads", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const parent = uuid();
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "forked")])), complete: true,
      meta: { title: "A forked chat", model: "claude-opus-5", forkedFrom: { sessionId: parent, atSeq: 7 } },
    });
    expect(res.error).toBeUndefined();
    expect(store.meta(id).model).toBe("claude-opus-5");

    const heads = await c.request(METHODS.syncHeads, {});
    const row = heads.result.sessions.find((s: any) => s.sessionId === id);
    expect(row).toBeTruthy();
    expect(row.lastSeq).toBe(2);
    expect(row.title).toBe("A forked chat");
    expect(row.model).toBe("claude-opus-5");
    expect(row.forkedFrom).toEqual({ sessionId: parent, atSeq: 7 });
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Divergence
  // ------------------------------------------------------------------------------------------

  test("divergent push (baseSeq behind the daemon) → DIVERGED carrying the daemon's lastSeq, nothing appended", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "a"), asstMsg(id, 3, "b")])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([userMsg(id, 2, "a DIFFERENT branch")])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.DIVERGED);
    expect(res.error.data).toEqual({ lastSeq: 3 });
    // Never a silent overwrite: the daemon's own three events are untouched.
    expect(store.read(id, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((store.read(id, 1)[0] as any).text).toBe("a");
    c.close();
  });

  test("a push for an UNKNOWN session with baseSeq > 0 → DIVERGED with lastSeq 0 (the daemon has nothing)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 5, data: b64(jsonl([userMsg(id, 6, "orphan")])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.DIVERGED);
    expect(res.error.data).toEqual({ lastSeq: 0 });
    expect(store.list().length).toBe(0);
    c.close();
  });

  test("a non-contiguous batch is refused atomically", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([userMsg(id, 2, "a"), asstMsg(id, 4, "gap!")])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.lastSeq(id)).toBe(1);
    c.close();
  });

  test("an event whose sessionId belongs to another session is refused atomically", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const other = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([userMsg(other, 2, "smuggled")])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.lastSeq(id)).toBe(1);
    c.close();
  });

  test("a malformed line rejects the WHOLE batch — nothing appended (atomicity)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    // Line 1 is a perfectly good event; line 2 is not JSON at all.
    const good = JSON.stringify(userMsg(id, 2, "would have been fine"));
    const bad = Buffer.from(`${good}\n{not json at all\n`, "utf8");
    const res = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 1, data: b64(bad), complete: true });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    // CONTROL for the data() pump's new `data` passthrough: an error that carries no structured
    // payload must stay byte-identical to what it always was — no empty `data` key appears.
    expect("data" in res.error).toBe(false);
    expect(store.lastSeq(id)).toBe(1);
    expect(store.read(id, 0).length).toBe(1);
    c.close();
  });

  test("a schema-invalid event (unknown type) rejects the whole batch", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 1, data: b64(jsonl([ev(id, 2, { type: "not_a_real_event_type", payload: "x" })])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.lastSeq(id)).toBe(1);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Pull
  // ------------------------------------------------------------------------------------------

  test("pull from 0 returns the whole log byte-identically to what was pushed", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "one"), asstMsg(id, 3, "two")]);
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });

    const { bytes, pages } = await pullAll(c, id, 0);
    expect(pages).toBe(1);
    expect(bytes.equals(raw)).toBe(true);
    c.close();
  });

  test("pull from a seq returns only the tail past it (fromSeq is EXCLUSIVE)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const all = [created(id), userMsg(id, 2, "one"), asstMsg(id, 3, "two")];
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl(all)), complete: true });

    const { bytes } = await pullAll(c, id, 2);
    expect(bytes.equals(jsonl([all[2]!]))).toBe(true);
    c.close();
  });

  test("pull past the head returns an empty, complete page", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 1 });
    expect(res.error).toBeUndefined();
    expect(res.result.data).toBe("");
    expect(res.result.complete).toBe(true);
    expect(res.result.nextCursor).toBeUndefined();
    c.close();
  });

  test("a log larger than one page is served over multiple cursor-resumed pages, byte-identically", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const events: Record<string, unknown>[] = [created(id)];
    for (let i = 2; i <= 41; i++) events.push(asstMsg(id, i, "x".repeat(10 * 1024)));
    const raw = jsonl(events);
    expect(raw.length).toBeGreaterThan(SYNC_PAGE_BYTES);

    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    const { bytes, pages } = await pullAll(c, id, 0);
    expect(pages).toBeGreaterThan(1);
    expect(bytes.length).toBe(raw.length);
    expect(bytes.equals(raw)).toBe(true);
    c.close();
  });

  test("no page ever exceeds SYNC_PAGE_BYTES", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const events: Record<string, unknown>[] = [created(id)];
    for (let i = 2; i <= 41; i++) events.push(asstMsg(id, i, "y".repeat(10 * 1024)));
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl(events)), complete: true });

    let cursor: number | undefined;
    for (;;) {
      const res = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0, ...(cursor === undefined ? {} : { cursor }) });
      expect(Buffer.from(res.result.data, "base64").length).toBeLessThanOrEqual(SYNC_PAGE_BYTES);
      if (res.result.complete) break;
      cursor = res.result.nextCursor;
    }
    c.close();
  });

  // Raw-JSONL-bytes paging makes an oversized single event a non-problem BY CONSTRUCTION — it just
  // spans pages. This is the reason pull pages bytes rather than events.
  test("a single event LARGER than a page survives pull+push byte-identically", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const huge = asstMsg(id, 2, "z".repeat(SYNC_PAGE_BYTES + 4096));
    const raw = jsonl([created(id), huge]);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(SYNC_PAGE_BYTES);

    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    const { bytes, pages } = await pullAll(c, id, 0);
    expect(pages).toBeGreaterThan(1);
    expect(bytes.equals(raw)).toBe(true);

    // ...and the pulled bytes push back into a SECOND daemon byte-for-byte (the replication loop).
    const id2 = uuid();
    const relabelled = Buffer.from(bytes.toString("utf8").replaceAll(id, id2), "utf8");
    const res = await c.request(METHODS.syncPush, { sessionId: id2, baseSeq: 0, data: b64(relabelled), complete: true });
    expect(res.error).toBeUndefined();
    const round = await pullAll(c, id2, 0);
    expect(round.bytes.equals(relabelled)).toBe(true);
    c.close();
  });

  test("pull on an unknown session → NOT_FOUND", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const res = await c.request(METHODS.syncPull, { sessionId: uuid(), fromSeq: 0 });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("a stale cursor past the end of the tail is refused, not silently emptied", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(jsonl([created(id)])), complete: true });

    const res = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0, cursor: 10_000_000 });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // heads
  // ------------------------------------------------------------------------------------------

  test("sync.heads lists CHAT sessions only — code/dispatch/absent-mode sessions never appear", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const chat = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
    const code = store.createSession("global", { mode: "code" });
    const dispatch = store.createSession("global", { mode: "dispatch" });
    const legacy = store.createSession("global"); // no mode at all → "code" by convention

    const heads = await c.request(METHODS.syncHeads, {});
    expect(heads.error).toBeUndefined();
    const ids = heads.result.sessions.map((s: any) => s.sessionId);
    expect(ids).toEqual([chat]);
    expect(ids).not.toContain(code);
    expect(ids).not.toContain(dispatch);
    expect(ids).not.toContain(legacy);
    c.close();
  });

  test("sync.heads reports lastSeq and a null title when the session has none", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const chat = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });

    const heads = await c.request(METHODS.syncHeads, {});
    const row = heads.result.sessions[0];
    expect(row.sessionId).toBe(chat);
    expect(row.lastSeq).toBe(1); // the session_created event
    expect(row.title).toBeNull();
    expect(row.model).toBeUndefined();
    expect(row.forkedFrom).toBeUndefined();
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Chat-only, fail-closed
  // ------------------------------------------------------------------------------------------

  test.each([
    ["code", { mode: "code" as const }],
    ["dispatch", { mode: "dispatch" as const }],
    ["absent (fails closed)", {}],
  ])("sync.pull refuses a %s session", async (_label, opts) => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = store.createSession("global", opts as any);

    const res = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0 });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toMatch(/chat/i);
    c.close();
  });

  test.each([
    ["code", { mode: "code" as const }],
    ["dispatch", { mode: "dispatch" as const }],
    ["absent (fails closed)", {}],
  ])("sync.push refuses a %s session", async (_label, opts) => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = store.createSession("global", opts as any);
    const before = store.lastSeq(id);

    const res = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: before, data: b64(jsonl([userMsg(id, before + 1, "nope")])), complete: true,
    });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toMatch(/chat/i);
    expect(store.lastSeq(id)).toBe(before);
    c.close();
  });

  test("a session whose mode is an UNKNOWN future value is refused too (allowlist, not denylist)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);

    const pull = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0 });
    expect(pull.error.code).toBe(ERR.INVALID_PARAMS);
    const heads = await c.request(METHODS.syncHeads, {});
    expect(heads.result.sessions.map((s: any) => s.sessionId)).not.toContain(id);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Reassembly buffer lifecycle
  // ------------------------------------------------------------------------------------------

  test("the reassembly buffer is DISCARDED when the connection closes", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "half a push")]);
    const mid = Math.floor(raw.length / 2);

    const first = await TestClient.connect(socketPath);
    await first.hello(harnessToken, "sync-client-a");
    const part = await first.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(0, mid)), complete: false });
    expect(part.error).toBeUndefined();
    first.close();
    await Bun.sleep(50);

    // A brand-new connection carries no buffer: the tail chunk alone starts mid-line and cannot parse.
    const second = await TestClient.connect(socketPath);
    await second.hello(harnessToken, "sync-client-b");
    const rest = await second.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(mid)), complete: true });
    expect(rest.error).toBeTruthy();
    expect(rest.error.code).toBe(ERR.INVALID_PARAMS);
    expect(store.list().length).toBe(0);

    // ...and the connection still works for a complete push afterwards.
    const whole = await second.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    expect(whole.error).toBeUndefined();
    expect(store.lastSeq(id)).toBe(2);
    second.close();
  });

  test("two connections buffering the SAME session id do not cross-contaminate", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "conn A's copy")]);
    const mid = Math.floor(raw.length / 2);

    const a = await TestClient.connect(socketPath);
    const b = await TestClient.connect(socketPath);
    await a.hello(harnessToken, "conn-a");
    await b.hello(harnessToken, "conn-b");

    await a.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(0, mid)), complete: false });
    // B pushes the WHOLE thing while A's half-buffer is still open — B must not see A's bytes.
    const bRes = await b.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    expect(bRes.error).toBeUndefined();
    expect(store.lastSeq(id)).toBe(2);

    a.close(); b.close();
  });

  test("a failed complete-push discards the buffer (the next push starts clean)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "sync-client");
    const id = uuid();
    const raw = jsonl([created(id), userMsg(id, 2, "clean slate")]);
    const mid = Math.floor(raw.length / 2);

    await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw.subarray(0, mid)), complete: false });
    // Complete with GARBAGE: the whole batch fails, and the half-buffer must go with it.
    const boom = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(Buffer.from("garbage\n")), complete: true });
    expect(boom.error).toBeTruthy();

    // If the failed buffer had survived, prefixing it to this whole-log push would corrupt it.
    const retry = await c.request(METHODS.syncPush, { sessionId: id, baseSeq: 0, data: b64(raw), complete: true });
    expect(retry.error).toBeUndefined();
    expect(store.lastSeq(id)).toBe(2);
    c.close();
  });

  // ------------------------------------------------------------------------------------------
  // Remote reachability
  // ------------------------------------------------------------------------------------------

  test("a REMOTE (phone) caller may drive all three sync verbs against a chat session", async () => {
    const { socketPath, remoteToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const id = uuid();

    const push = await c.request(METHODS.syncPush, {
      sessionId: id, baseSeq: 0, data: b64(jsonl([created(id), userMsg(id, 2, "from the phone")])), complete: true,
    });
    expect(push.error).toBeUndefined();
    const heads = await c.request(METHODS.syncHeads, {});
    expect(heads.error).toBeUndefined();
    expect(heads.result.sessions.map((s: any) => s.sessionId)).toContain(id);
    const pull = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0 });
    expect(pull.error).toBeUndefined();
    c.close();
  });

  test("a remote caller is refused against a Mac-local-only (cowork-shaped) session by the remote gate", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const id = store.createSession("global");
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);

    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");
    const res = await c.request(METHODS.syncPull, { sessionId: id, fromSeq: 0 });
    expect(res.error).toBeTruthy();
    expect(res.error.message).toMatch(/not available/i);
    c.close();
  });
});

// ----------------------------------------------------------------------------------------------
// The reassembly buffer itself — the 32 MiB hard cap, exercised directly with an injected small
// cap (pushing 32 MiB through a socket per test would be minutes of wall clock for no extra proof).
// ----------------------------------------------------------------------------------------------

describe("SyncPushBuffers (the per-(connId, sessionId) reassembly buffer)", () => {
  test("accumulates per (connId, sessionId) and reports the running total", () => {
    const b = new SyncPushBuffers();
    expect(b.append(1, "s1", Buffer.from("abc"))).toBe(3);
    expect(b.append(1, "s1", Buffer.from("de"))).toBe(5);
    expect(b.append(1, "s2", Buffer.from("x"))).toBe(1);   // a different session on the same conn
    expect(b.append(2, "s1", Buffer.from("yy"))).toBe(2);  // the same session on a different conn
    expect(b.take(1, "s1").toString()).toBe("abcde");
    expect(b.take(1, "s2").toString()).toBe("x");
    expect(b.take(2, "s1").toString()).toBe("yy");
  });

  test("take() drains: a second take sees nothing", () => {
    const b = new SyncPushBuffers();
    b.append(1, "s1", Buffer.from("abc"));
    expect(b.take(1, "s1").toString()).toBe("abc");
    expect(b.take(1, "s1").length).toBe(0);
  });

  test("exceeding the cap throws AND discards what was buffered", () => {
    const b = new SyncPushBuffers({ maxBytes: 8 });
    b.append(1, "s1", Buffer.from("12345"));
    expect(() => b.append(1, "s1", Buffer.from("6789"))).toThrow(/32 MiB|cap|too large/i);
    expect(b.take(1, "s1").length).toBe(0); // discarded, not left half-full
  });

  test("dropConnection clears every buffer for that connection only", () => {
    const b = new SyncPushBuffers();
    b.append(1, "s1", Buffer.from("a"));
    b.append(1, "s2", Buffer.from("b"));
    b.append(2, "s1", Buffer.from("c"));
    b.dropConnection(1);
    expect(b.take(1, "s1").length).toBe(0);
    expect(b.take(1, "s2").length).toBe(0);
    expect(b.take(2, "s1").toString()).toBe("c");
  });
});
