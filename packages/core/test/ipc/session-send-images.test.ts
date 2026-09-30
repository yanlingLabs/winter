// Code-mode image input: `session.send`/`session.steer`'s `images`. The stored `user_message` keeps
// the user's `[Image #n]` placeholders (the bubble shows them) and names each one's staged path in
// `images`; only the model is given the paths (winter-session.test.ts covers the push). Every entry is
// checked before anything is appended: the file must be one `session.stageImage` wrote for THIS
// session, `n` unique and present in the text, a code session, a local caller.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, ERR, IMAGE_REFERENCE_INVALID, IMAGE_SESSION_NOT_CODE, LineDecoder, METHODS, PROTOCOL_VERSION, SessionEvent,
  USER_MESSAGE_IMAGES_MAX, encodeLine, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { capEvent, readHistoryPage } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { modelTextOf } from "../../src/sessions/model-text";
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
    // A 16 MiB outbound cap: the default 4 MiB slow-consumer cap would end this socket on the
    // max-size request itself (the CLI's own client raises it the same way).
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket, 16 * 1024 * 1024);
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

const IMAGE_TAG = loadCatalog().models.find((m) => m.inputModalities.value.includes("image"))!.key;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("session.send / session.steer — images (code-mode image input)", () => {
  let stop: (() => void) | undefined;
  let tmpBase = "";
  let savedTmp: string | undefined;
  const cleanup: string[] = [];
  beforeEach(() => {
    savedTmp = process.env.WINTER_TMPDIR;
    tmpBase = mkdtempSync(join(tmpdir(), "winter-sendimg-tmp-"));
    process.env.WINTER_TMPDIR = tmpBase;
  });
  afterEach(() => {
    stop?.(); stop = undefined;
    if (savedTmp === undefined) delete process.env.WINTER_TMPDIR; else process.env.WINTER_TMPDIR = savedTmp;
    rmSync(tmpBase, { recursive: true, force: true });
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(winter?: WinterSessionDrivers) {
    const home = mkdtempSync(join(tmpdir(), "winter-sendimg-"));
    cleanup.push(home);
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, ...(winter === undefined ? {} : { winter }) });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    return { store, socketPath, tokens, c };
  }

  /** A code session with one staged image, attached — answers the staged path. */
  async function staged(mode: "code" | "chat" = "code") {
    const b = await boot();
    const sid = b.store.createSession("global", { model: IMAGE_TAG, mode });
    let path = "";
    if (mode === "code") {
      const res = await b.c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
      expect(res.result.imagesOnSend).toBe(true);
      path = res.result.path;
    }
    expect((await b.c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    return { ...b, sid, path };
  }

  const userMessages = (store: SessionStore, sid: string) =>
    store.read(sid).filter((e) => e.type === "user_message") as Array<Extract<SessionEvent, { type: "user_message" }>>;

  test("stageImage says the daemon takes images on send; the stored message keeps the placeholder and names the path", async () => {
    const { store, c, sid, path } = await staged();
    const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "what is in [Image #1]?", images: [{ n: 1, path }] });
    expect(res.error).toBeUndefined();
    const [m] = userMessages(store, sid);
    expect(m).toMatchObject({ text: "what is in [Image #1]?", clientName: "orb", images: [{ n: 1, path }] });
    expect(modelTextOf(m!)).toBe(`what is in ${path}?`);
    c.close();
  });

  test("an empty images array is no images: nothing stored under the key", async () => {
    const { store, c, sid } = await staged();
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "hi", images: [] })).error).toBeUndefined();
    expect("images" in userMessages(store, sid)[0]!).toBe(false);
    c.close();
  });

  test("every bad reference refuses typed image_reference_invalid and appends NOTHING", async () => {
    const { store, c, sid, path } = await staged();
    const imagesDir = join(realpathSync(tmpBase), `winter-session-${sid}`, "images");
    // Planted by the agent (the folder is a sandbox writable root): a symlink to the staged file, a
    // file with a name staging never picks, and a subfolder.
    symlinkSync(path, join(imagesDir, "image_90.png"));
    writeFileSync(join(imagesDir, "evil.png"), PNG);
    mkdirSync(join(imagesDir, "image_91.png"));
    // Another session's staged image.
    const other = store.createSession("global", { model: IMAGE_TAG });
    const otherPath = (await c.request(METHODS.sessionStageImage, { sessionId: other, mediaType: "image/png", dataBase64: b64(PNG) })).result.path;
    const outside = join(mkdtempSync(join(tmpdir(), "winter-sendimg-out-")), "image_1.png");
    cleanup.push(join(outside, ".."));
    writeFileSync(outside, PNG);
    const before = store.read(sid).length;
    const bad: Array<{ text: string; images: Array<{ n: number; path: string }> }> = [
      { text: "no token here", images: [{ n: 1, path }] },
      { text: "[Image #1] [Image #2]", images: [{ n: 1, path }, { n: 2, path: join(imagesDir, "image_7.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path }, { n: 1, path }] },
      { text: "[Image #1]", images: [{ n: 1, path: outside }] },
      { text: "[Image #1]", images: [{ n: 1, path: otherPath }] },
      { text: "[Image #1]", images: [{ n: 1, path: join(imagesDir, "image_90.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path: join(imagesDir, "evil.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path: join(imagesDir, "image_91.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path: `${imagesDir}/../images/image_1.png` }] },
      { text: "[Image #1]", images: [{ n: 1, path: "images/image_1.png" }] },
      {
        text: Array.from({ length: USER_MESSAGE_IMAGES_MAX + 1 }, (_, i) => `[Image #${i + 1}]`).join(" "),
        images: Array.from({ length: USER_MESSAGE_IMAGES_MAX + 1 }, (_, i) => ({ n: i + 1, path })),
      },
    ];
    for (const params of bad) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, ...params });
        expect({ method, text: params.text, code: res.error?.data?.code }).toEqual({ method, text: params.text, code: IMAGE_REFERENCE_INVALID });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        expect(res.error.message).not.toContain(tmpBase); // no path echoed back
      }
    }
    expect(store.read(sid).length).toBe(before);
    c.close();
  });

  test("[Image #01] names placeholder 1, the same grammar the substitution uses", async () => {
    const { store, c, sid, path } = await staged();
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "see [Image #01]", images: [{ n: 1, path }] })).error).toBeUndefined();
    expect(modelTextOf(userMessages(store, sid)[0]!)).toBe(`see ${path}`);
    c.close();
  });

  test("a non-code session refuses image_session_not_code; nothing appended", async () => {
    const { store, c, sid } = await staged("chat");
    const before = store.read(sid).length;
    const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: "/tmp/x/images/image_1.png" }] });
    expect(res.error.data.code).toBe(IMAGE_SESSION_NOT_CODE);
    expect(store.read(sid).length).toBe(before);
    c.close();
  });

  test("a remote caller (the phone) can never send images — typed, nothing appended; plain text still goes", async () => {
    const { store, socketPath, tokens, c, sid, path } = await staged();
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    expect((await phone.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    const before = store.read(sid).length;
    const res = await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
    expect(res.error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    // (session.steer is not remote-allowed at all; were it ever, the images check refuses it too.)
    expect((await phone.request(METHODS.sessionSteer, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] })).error).toBeDefined();
    expect(store.read(sid).length).toBe(before);
    expect((await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]" })).error).toBeUndefined();
    phone.close(); c.close();
  });

  test("history and the remote stream carry images like any field, bounded by the schema and the caps", async () => {
    const { store, c, sid, path } = await staged();
    await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
    const page = readHistoryPage(store, { sessionId: sid });
    const m = page.events.find((e) => e.type === "user_message") as Extract<SessionEvent, { type: "user_message" }>;
    expect(m.images).toEqual([{ n: 1, path }]);
    expect(m.text).toBe("[Image #1]");
    expect((filterRemoteStreamEvent(m) as typeof m).images).toEqual([{ n: 1, path }]);
    // The schema bounds the array and each path; the per-string cap holds whatever a path is.
    const base = { type: "user_message", sessionId: sid, seq: 1, ts: 1, threadId: "main", text: "x", clientName: "orb" };
    expect(SessionEvent.safeParse({ ...base, images: Array.from({ length: USER_MESSAGE_IMAGES_MAX + 1 }, (_, i) => ({ n: i + 1, path: "/p" })) }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, images: [{ n: 1, path: "/" + "a".repeat(5000) }] }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, images: [] }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, images: [{ n: 0, path: "/p" }] }).success).toBe(false);
    const huge = { ...base, images: [{ n: 1, path: "/" + "a".repeat(200_000) }] } as unknown as SessionEvent;
    expect(JSON.stringify(capEvent(huge)).length).toBeLessThan(160 * 1024);
    c.close();
  });

  test("on the Winter leg the driver receives the text as written plus the checked images (send and steer); a refusal never resumes it", async () => {
    const calls: Array<{ door: string; text: string; clientName?: string; images?: unknown }> = [];
    let ensures = 0;
    const never = (): never => { throw new Error("not reached by this test"); };
    const session: LegSession = {
      sessionId: "s", backendSessionId: "be", mode: "code", state: "live", generation: 1, resumed: true,
      init: undefined, turnRunning: false, turnStartedAt: undefined, done: Promise.resolve(), pendingSends: [], heldDeliveries: [],
      send: async (text, clientName, images) => { calls.push({ door: "send", text, clientName, images }); return { seq: calls.length, queued: false }; },
      steer: async (text, clientName, images) => { calls.push({ door: "steer", text, clientName, images }); return { seq: calls.length, injected: true }; },
      interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
    };
    const table: WinterSessionDrivers = {
      legForNewSession: () => "winter", legOf: () => "winter", assertAvailable: () => {}, create: async () => never(),
      get: () => session, runTurn: async () => never(),
      ensure: async () => { ensures++; return session; },
      evict: async () => {}, list: () => [], endAll: async () => {},
    };
    const { store, c } = await boot(table);
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const path = (await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).result.path;
    await c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "a [Image #1]", images: [{ n: 1, path }] })).error).toBeUndefined();
    expect((await c.request(METHODS.sessionSteer, { sessionId: sid, text: "b [Image #1]", images: [{ n: 1, path }] })).error).toBeUndefined();
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "plain" })).error).toBeUndefined();
    expect(calls).toEqual([
      { door: "send", text: "a [Image #1]", clientName: "orb", images: [{ n: 1, path }] },
      { door: "steer", text: "b [Image #1]", clientName: undefined, images: [{ n: 1, path }] },
      { door: "send", text: "plain", clientName: "orb", images: undefined },
    ]);
    const ensuresBefore = ensures;
    const refused = await c.request(METHODS.sessionSend, { sessionId: sid, text: "no token", images: [{ n: 1, path }] });
    expect(refused.error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    expect((await c.request(METHODS.sessionSteer, { sessionId: sid, text: "no token", images: [{ n: 1, path }] })).error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    expect(ensures).toBe(ensuresBefore);
    expect(calls).toHaveLength(3);
    c.close();
  });
});
