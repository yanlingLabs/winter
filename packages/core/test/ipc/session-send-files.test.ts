// Code-mode file attachments (2026-10-13): `session.send`/`session.steer`'s `files`. The stored `user_message`
// keeps the user's `[File #n]` placeholders (the Mac's bubble draws a chip per token) and names each one's file
// or folder in `files`; only the model is given the paths (`modelTextOf`). Every entry is checked before anything
// is appended: a local caller, a code session, an absolute path free of control/bidi characters and edge
// whitespace, outside the Read tool's read-deny set, that resolves to a regular file or a directory; `n` unique
// and present in the text; at most 20. Nothing is read, and no model capability is required.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, DAEMON_FEATURE_ATTACHMENT_FILES, DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS, ERR, FILE_REFERENCE_INVALID, FILE_SESSION_NOT_CODE, FILE_UNREADABLE,
  LineDecoder, METHODS, PROTOCOL_VERSION, SessionEvent, SessionSendParams, SessionSteerParams, USER_MESSAGE_FILES_MAX, encodeLine, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { readHistoryPage } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { fileTokenNumbers, modelTextOf, substituteFileTokens } from "../../src/sessions/model-text";
import { validateFileRefs } from "../../src/agent/stage-image";
import type { LegSession, WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";

/** Minimal raw NDJSON JSON-RPC client — the same per-file copy every test in test/ipc carries. */
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
        drain() { c.writer.onDrain(); },
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

  hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

const TEXT_TAG = loadCatalog().models.find((m) => !m.inputModalities.value.includes("image"))!.key;

describe("model text — [File #n]", () => {
  test("files are substituted beside images, in one pass; unknown tokens stay as typed", () => {
    const m = {
      text: "[Image #1] [File #2] [File #1] and [File #9]\nread these",
      images: [{ n: 1, path: "/a/[File #1].png" }],
      files: [{ n: 2, path: "/Users/me/My Report.pdf" }, { n: 1, path: "/Users/me/app" }],
    };
    // A substituted path that happens to spell a token is never rewritten again.
    expect(modelTextOf(m)).toBe("/a/[File #1].png /Users/me/My Report.pdf /Users/me/app and [File #9]\nread these");
    expect(modelTextOf({ text: "no files", files: [] })).toBe("no files");
    expect(fileTokenNumbers("[File #2] [File #02] [Image #1] [File #1]")).toEqual([2, 1]);
    expect(substituteFileTokens("[File #1] [Image #1]", new Map([[1, "/x"]]))).toBe("/x [Image #1]");
  });

  test("send and steer params accept files; the schema bounds them", () => {
    expect(SessionSendParams.parse({ sessionId: "s", text: "[File #1]", files: [{ n: 1, path: "/x" }] }).files).toEqual([{ n: 1, path: "/x" }]);
    expect(SessionSteerParams.parse({ sessionId: "s", text: "[File #1]", files: [{ n: 1, path: "/x" }] }).files).toEqual([{ n: 1, path: "/x" }]);
    const base = { type: "user_message", sessionId: "s", seq: 1, ts: 1, threadId: "main", text: "x", clientName: "orb" };
    expect(SessionEvent.safeParse({ ...base, files: [{ n: 1, path: "/p" }] }).success).toBe(true);
    expect(SessionEvent.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, files: Array.from({ length: USER_MESSAGE_FILES_MAX + 1 }, (_, i) => ({ n: i + 1, path: "/p" })) }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, files: [{ n: 1, path: "/" + "a".repeat(5000) }] }).success).toBe(false);
  });
});

describe("session.send / session.steer — files (code-mode file attachments)", () => {
  let stop: (() => void) | undefined;
  const cleanup: string[] = [];
  afterEach(() => {
    stop?.(); stop = undefined;
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(opts: { winter?: WinterSessionDrivers; withHome?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-sendfile-"));
    cleanup.push(home);
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      ...(opts.winter === undefined ? {} : { winter: opts.winter }), ...(opts.withHome ? { winterHome: home } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    return { store, socketPath, tokens, c, home };
  }

  /** A text-only CODE session, attached: files need no image-capable model. */
  async function session(mode: "code" | "chat" = "code", withHome = false) {
    const b = await boot({ withHome });
    const sid = b.store.createSession("global", { model: TEXT_TAG, mode });
    expect((await b.c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    return { ...b, sid };
  }

  /** A folder outside the daemon's home with a distinctive name no error may echo. */
  function userDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-userfiles-SECRETNAME-")));
    cleanup.push(dir);
    return dir;
  }

  const userMessages = (store: SessionStore, sid: string) =>
    store.read(sid).filter((e) => e.type === "user_message") as Array<Extract<SessionEvent, { type: "user_message" }>>;

  test("hello announces attachment-files beside image-original-paths", async () => {
    const { socketPath, tokens } = await session();
    const probe = await TestClient.connect(socketPath);
    const hello = await probe.hello(tokens.harness, "probe");
    expect(DAEMON_FEATURE_ATTACHMENT_FILES).toBe("attachment-files");
    expect(hello.result.features).toEqual([DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS, DAEMON_FEATURE_ATTACHMENT_FILES]);
    probe.close();
  });

  test("any file or folder is stored as spelled with its placeholder; the model is given the paths; a text-only model is fine", async () => {
    const { store, c, sid } = await session();
    const dir = userDir();
    const doc = join(dir, "My Report.pdf");
    writeFileSync(doc, "%PDF-1.7 not really");
    const code = join(dir, "main.swift");
    writeFileSync(code, "print(1)\n");
    mkdirSync(join(dir, "project"));
    symlinkSync(doc, join(dir, "link.pdf"));
    const files = [{ n: 2, path: doc }, { n: 1, path: join(dir, "project") }, { n: 3, path: code }, { n: 4, path: join(dir, "link.pdf") }];
    const text = "[File #2] [File #1] [File #3] [File #4]\nread these";
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text, files })).error).toBeUndefined();
    const [m] = userMessages(store, sid);
    expect(m).toMatchObject({ text, files });
    expect("images" in m!).toBe(false);
    expect(modelTextOf(m!)).toBe(`${doc} ${join(dir, "project")} ${code} ${join(dir, "link.pdf")}\nread these`);
    expect((await c.request(METHODS.sessionSteer, { sessionId: sid, text: "also [File #1]", files: [{ n: 1, path: doc }] })).error).toBeUndefined();
    // (A bare server's steer appends nothing — the Winter-leg test below covers the driver's steer.)
    // An empty array is no files: nothing stored under the key.
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "hi", files: [] })).error).toBeUndefined();
    expect("files" in userMessages(store, sid)[1]!).toBe(false);
    c.close();
  });

  test("every bad reference refuses typed file_reference_invalid, names the placeholder, never the path, and appends NOTHING", async () => {
    const { store, c, sid } = await session();
    const dir = userDir();
    const ok = join(dir, "ok.txt");
    writeFileSync(ok, "x");
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    writeFileSync(join(dir, "bidi‮txt.exe"), "x");
    const before = store.read(sid).length;
    const bad: Array<{ text: string; files: Array<{ n: number; path: string }> }> = [
      { text: "no token here", files: [{ n: 1, path: ok }] },
      { text: "[File #1]", files: [{ n: 1, path: ok }, { n: 1, path: ok }] },
      { text: "[File #1]", files: [{ n: 1, path: "relative/ok.txt" }] },
      { text: "[File #1]", files: [{ n: 1, path: ` ${ok}` }] },
      { text: "[File #1]", files: [{ n: 1, path: `${ok}\n` }] },
      { text: "[File #1]", files: [{ n: 1, path: join(dir, "bidi‮txt.exe") }] },
      { text: "[File #1]", files: [{ n: 1, path: fifo }] },
      { text: "[Image #1]", files: [{ n: 1, path: ok }] }, // an IMAGE token is not a file token
      {
        text: Array.from({ length: USER_MESSAGE_FILES_MAX + 1 }, (_, i) => `[File #${i + 1}]`).join(" "),
        files: Array.from({ length: USER_MESSAGE_FILES_MAX + 1 }, (_, i) => ({ n: i + 1, path: ok })),
      },
    ];
    for (const params of bad) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, ...params });
        expect({ method, text: params.text, code: res.error?.data?.code }).toEqual({ method, text: params.text, code: FILE_REFERENCE_INVALID });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        for (const secret of ["SECRETNAME", dir]) expect(JSON.stringify(res.error)).not.toContain(secret);
      }
    }
    expect(store.read(sid).length).toBe(before);
    c.close();
  });

  test("a path that does not resolve is file_unreadable with data.n, naming the placeholder, never the path", async () => {
    const { store, c, sid } = await session();
    const dir = userDir();
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "inside.txt"), "x");
    chmodSync(join(dir, "vault"), 0o000);
    try {
      const before = store.read(sid).length;
      for (const path of [join(dir, "gone.txt"), join(dir, "vault", "inside.txt")]) {
        const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "x [File #3]", files: [{ n: 3, path }] });
        expect({ code: res.error?.data?.code, n: res.error?.data?.n }).toEqual({ code: FILE_UNREADABLE, n: 3 });
        expect(res.error.message).toContain("[File #3]");
        for (const secret of [path, "SECRETNAME"]) expect(JSON.stringify(res.error)).not.toContain(secret);
      }
      expect(store.read(sid).length).toBe(before);
    } finally {
      chmodSync(join(dir, "vault"), 0o700);
    }
    c.close();
  });

  test("the Read tool's read-deny set is refused under the home (spelled or resolved); the rest of the home is fine", async () => {
    const { c, sid, home } = await session("code", true);
    const dir = userDir();
    mkdirSync(join(home, "run"), { recursive: true });
    mkdirSync(join(home, "outputs", "s_1"), { recursive: true });
    writeFileSync(join(home, "outputs", "s_1", "report.md"), "# hi");
    symlinkSync(join(home, "run"), join(dir, "into-run"));
    for (const path of [join(home, "run"), join(dir, "into-run"), join(home, "sdk", ".winter.json")]) {
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[File #1]", files: [{ n: 1, path }] });
      // sdk/.winter.json does not exist; the spelled check refuses it before any resolve.
      expect({ path: path.replace(home, "<home>"), code: res.error?.data?.code }).toEqual({ path: path.replace(home, "<home>"), code: FILE_REFERENCE_INVALID });
      expect(JSON.stringify(res.error)).not.toContain(home);
    }
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "[File #1]", files: [{ n: 1, path: join(home, "outputs", "s_1", "report.md") }] })).error).toBeUndefined();
    c.close();
  });

  test("a non-code session refuses file_session_not_code; a remote caller can never send files; nothing appended", async () => {
    const chat = await session("chat");
    const before = chat.store.read(chat.sid).length;
    const refused = await chat.c.request(METHODS.sessionSend, { sessionId: chat.sid, text: "[File #1]", files: [{ n: 1, path: "/tmp" }] });
    expect(refused.error.data.code).toBe(FILE_SESSION_NOT_CODE);
    expect(chat.store.read(chat.sid).length).toBe(before);
    chat.c.close(); stop?.(); stop = undefined;

    const { store, socketPath, tokens, c, sid } = await session();
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    expect((await phone.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    const n = store.read(sid).length;
    const res = await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[File #1]", files: [{ n: 1, path: "/tmp" }] });
    expect(res.error.data.code).toBe(FILE_REFERENCE_INVALID);
    expect(store.read(sid).length).toBe(n);
    phone.close(); c.close();
  });

  test("history and the remote stream give the phone each image and file by NAME — no `/` ever reaches a remote client", async () => {
    const { store, c, sid } = await session();
    const dir = userDir();
    writeFileSync(join(dir, "My Report.pdf"), "x");
    mkdirSync(join(dir, "app"));
    await c.request(METHODS.sessionSend, { sessionId: sid, text: "[File #2] [File #1]", files: [{ n: 2, path: join(dir, "My Report.pdf") }, { n: 1, path: join(dir, "app") + "/" }] });
    const stored = store.read(sid).find((e) => e.type === "user_message") as Extract<SessionEvent, { type: "user_message" }>;
    expect(stored.files).toEqual([{ n: 2, path: join(dir, "My Report.pdf") }, { n: 1, path: join(dir, "app") + "/" }]);
    const fromHistory = readHistoryPage(store, { sessionId: sid }).events.find((e) => e.type === "user_message") as typeof stored;
    const live = filterRemoteStreamEvent(stored) as typeof stored;
    for (const view of [fromHistory, live]) {
      expect(view.files).toEqual([{ n: 2, path: "My Report.pdf" }, { n: 1, path: "app" }]);
      expect(SessionEvent.safeParse(view).success).toBe(true); // the phone kit decodes `{n, path}` as before
    }
    // Both fields, any spelling: nothing with a `/` survives either phone path.
    const base = { type: "user_message" as const, sessionId: sid, seq: 99, ts: 1, threadId: "main", text: "[Image #1] [File #1]", clientName: "orb" };
    const event = { ...base, images: [{ n: 1, path: "/Users/me/a b/shot.png" }], files: [{ n: 1, path: "/" }] } as SessionEvent;
    const phone = filterRemoteStreamEvent(event) as typeof stored;
    for (const ref of [...phone.images!, ...phone.files!]) expect(ref.path).not.toContain("/");
    expect(phone.images).toEqual([{ n: 1, path: "shot.png" }]);
    expect(phone.files).toEqual([{ n: 1, path: "file" }]);
    expect(JSON.stringify(phone)).not.toContain("/Users/");
    c.close();
  });

  test("on the Winter leg the driver receives the checked files (send and steer); a refusal never resumes it", async () => {
    const calls: Array<{ door: string; text: string; images?: unknown; files?: unknown }> = [];
    let ensures = 0;
    const never = (): never => { throw new Error("not reached by this test"); };
    const leg: LegSession = {
      sessionId: "s", backendSessionId: "be", mode: "code", state: "live", generation: 1, resumed: true,
      init: undefined, turnRunning: false, turnStartedAt: undefined, done: Promise.resolve(), pendingSends: [], heldDeliveries: [],
      send: async (text, _clientName, images, files) => { calls.push({ door: "send", text, images, files }); return { seq: calls.length, queued: false }; },
      steer: async (text, _clientName, images, files) => { calls.push({ door: "steer", text, images, files }); return { seq: calls.length, injected: true }; },
      interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
    };
    const table: WinterSessionDrivers = {
      legForNewSession: () => "winter", legOf: () => "winter", assertAvailable: () => {}, create: async () => never(),
      get: () => leg, runTurn: async () => never(),
      ensure: async () => { ensures++; return leg; },
      evict: async () => {}, list: () => [], endAll: async () => {},
    };
    const { store, c } = await boot({ winter: table });
    const sid = store.createSession("global", { model: TEXT_TAG });
    await c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    const dir = userDir();
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "a [File #1]", files: [{ n: 1, path: dir }] })).error).toBeUndefined();
    expect((await c.request(METHODS.sessionSteer, { sessionId: sid, text: "b [File #1]", files: [{ n: 1, path: dir }] })).error).toBeUndefined();
    expect(calls).toEqual([
      { door: "send", text: "a [File #1]", images: undefined, files: [{ n: 1, path: dir }] },
      { door: "steer", text: "b [File #1]", images: undefined, files: [{ n: 1, path: dir }] },
    ]);
    const ensuresBefore = ensures;
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "no token", files: [{ n: 1, path: dir }] })).error.data.code).toBe(FILE_REFERENCE_INVALID);
    expect(ensures).toBe(ensuresBefore);
    c.close();
  });

  test("validateFileRefs without a home skips only the home rule", () => {
    const dir = userDir();
    expect(validateFileRefs("[File #1]", [{ n: 1, path: dir }])).toEqual([{ n: 1, path: dir }]);
    expect(validateFileRefs("x", undefined)).toBeUndefined();
    expect(validateFileRefs("x", [])).toBeUndefined();
  });
});
