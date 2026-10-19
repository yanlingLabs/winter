// Dispatch image and file attachments (2026-10-19): the Dispatch session takes `[Image #n]` and `[File #n]` exactly as
// a code session does — `session.stageImage` stages clipboard data into its own temp folder, `session.send` /
// `session.steer` carry `images` and `files`, the stored `user_message` keeps the placeholders and only the model is
// given the paths (`modelTextOf`). The image model check is the DISPATCH PIN's (`pinsFor(settings).dispatch` —
// `session.setModel` refuses a dispatch target, so that is the model it runs), never the code default. Chat still
// refuses; a remote caller (the phone) still never sends or stages either; the phone still sees names only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, ERR, FILE_REFERENCE_INVALID, FILE_SESSION_NOT_CODE, IMAGE_INPUT_UNSUPPORTED, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_REFERENCE_INVALID,
  IMAGE_SESSION_NOT_CODE, LineDecoder, METHODS, PROTOCOL_VERSION, SessionEvent, encodeLine, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { sessionTakesAttachments, startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { readHistoryPage } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { modelTextOf } from "../../src/sessions/model-text";
import { Settings, saveSettings } from "../../src/settings";
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

const catalog = loadCatalog();
const IMAGE_TAG = catalog.models.find((m) => m.inputModalities.value.includes("image"))!.key;
const TEXT_TAG = catalog.models.find((m) => !m.inputModalities.value.includes("image"))!.key;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

test("one predicate decides which modes take attachments: code (an absent mode too) and dispatch, never chat", () => {
  expect(sessionTakesAttachments(undefined)).toBe(true);
  expect(sessionTakesAttachments(null)).toBe(true);
  expect(sessionTakesAttachments("code")).toBe(true);
  expect(sessionTakesAttachments("dispatch")).toBe(true);
  expect(sessionTakesAttachments("chat")).toBe(false);
  expect(sessionTakesAttachments("cowork")).toBe(false);
});

describe("Dispatch takes image and file attachments (2026-10-19)", () => {
  let stop: (() => void) | undefined;
  let tmpBase = "";
  let savedTmp: string | undefined;
  const cleanup: string[] = [];
  beforeEach(() => {
    savedTmp = process.env.WINTER_TMPDIR;
    tmpBase = mkdtempSync(join(tmpdir(), "winter-dispatch-att-tmp-"));
    process.env.WINTER_TMPDIR = tmpBase;
  });
  afterEach(() => {
    stop?.(); stop = undefined;
    if (savedTmp === undefined) delete process.env.WINTER_TMPDIR; else process.env.WINTER_TMPDIR = savedTmp;
    rmSync(tmpBase, { recursive: true, force: true });
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A daemon on a temp home whose settings name the code default (`provider.model`, also the live model) and the
   *  dispatch pin (`pins.dispatch`) — the image check must read the pin for a dispatch session. */
  async function boot(models: { code: string; dispatch: string }, winter?: WinterSessionDrivers) {
    const home = mkdtempSync(join(tmpdir(), "winter-dispatch-att-"));
    cleanup.push(home);
    saveSettings(join(home, "settings.json"), Settings.parse({ schemaVersion: 3, provider: { model: models.code }, pins: { dispatch: models.dispatch } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, liveModel: () => models.code,
      ...(winter === undefined ? {} : { winter }),
    });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    return { store, socketPath, tokens, c, home };
  }

  /** The Dispatch session as the daemon mints it: `mode: "dispatch"` and NO model of its own (the pin runs it). */
  async function dispatchSession(models: { code: string; dispatch: string }, winter?: WinterSessionDrivers) {
    const b = await boot(models, winter);
    const sid = b.store.createSession("global", { mode: "dispatch", approvalPolicy: "auto" });
    expect(b.store.meta(sid).model).toBeUndefined();
    expect((await b.c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    return { ...b, sid };
  }

  /** The user's own files, outside the daemon's home. */
  function userDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-dispatch-userfiles-")));
    cleanup.push(dir);
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "plan.md"), "# plan");
    mkdirSync(join(dir, "project"));
    return dir;
  }

  const userMessages = (store: SessionStore, sid: string) =>
    store.read(sid).filter((e) => e.type === "user_message") as Array<Extract<SessionEvent, { type: "user_message" }>>;

  test("stageImage, then a send carrying a staged image, an original image and a file (and a folder): stored with placeholders, the model is given the paths", async () => {
    const { store, c, sid } = await dispatchSession({ code: TEXT_TAG, dispatch: IMAGE_TAG });
    const dir = userDir();
    const staged = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(staged.error).toBeUndefined();
    expect(staged.result).toEqual({ path: join(realpathSync(tmpBase), `winter-session-${sid}`, "images", "image_1.png"), imagesOnSend: true });
    const text = "compare [Image #1] with [Image #2], then check [File #1] in [File #2]";
    const images = [{ n: 1, path: staged.result.path }, { n: 2, path: join(dir, "shot.png") }];
    const files = [{ n: 1, path: join(dir, "plan.md") }, { n: 2, path: join(dir, "project") }];
    const res = await c.request(METHODS.sessionSend, { sessionId: sid, text, images, files });
    expect(res.error).toBeUndefined();
    const [m] = userMessages(store, sid);
    expect(m).toMatchObject({ text, clientName: "orb", images, files });
    expect(modelTextOf(m!)).toBe(`compare ${staged.result.path} with ${join(dir, "shot.png")}, then check ${join(dir, "plan.md")} in ${join(dir, "project")}`);
    c.close();
  });

  test("on the Winter leg a dispatch session's driver receives the checked images and files — send and steer (the mid-turn fold's door)", async () => {
    const calls: Array<{ door: string; text: string; images?: unknown; files?: unknown }> = [];
    const never = (): never => { throw new Error("not reached by this test"); };
    const leg: LegSession = {
      sessionId: "s", backendSessionId: "be", mode: "dispatch", state: "live", generation: 1, resumed: true,
      init: undefined, turnRunning: true, turnStartedAt: undefined, done: Promise.resolve(), pendingSends: [], heldDeliveries: [],
      send: async (text, _clientName, images, files) => { calls.push({ door: "send", text, images, files }); return { seq: calls.length, queued: false }; },
      steer: async (text, _clientName, images, files) => { calls.push({ door: "steer", text, images, files }); return { seq: calls.length, injected: true }; },
      interrupt: never, compact: never, setModel: never, setPolicy: never,
      end: async () => {}, deliver: never, open: async () => {}, idle: async () => {},
    };
    const table: WinterSessionDrivers = {
      legForNewSession: () => "winter", legOf: () => "winter", assertAvailable: () => {}, create: async () => never(),
      get: () => leg, runTurn: async () => never(), ensure: async () => leg,
      evict: async () => {}, list: () => [], endAll: async () => {},
    };
    const { c, sid } = await dispatchSession({ code: TEXT_TAG, dispatch: IMAGE_TAG }, table);
    const dir = userDir();
    const images = [{ n: 1, path: join(dir, "shot.png") }];
    const files = [{ n: 1, path: join(dir, "plan.md") }];
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "see [Image #1] and [File #1]", images, files })).error).toBeUndefined();
    const steered = await c.request(METHODS.sessionSteer, { sessionId: sid, text: "also [Image #1] and [File #1]", images, files });
    expect(steered.error).toBeUndefined();
    expect(steered.result).toEqual({ ok: true, injected: true });
    expect(calls).toEqual([
      { door: "send", text: "see [Image #1] and [File #1]", images, files },
      { door: "steer", text: "also [Image #1] and [File #1]", images, files },
    ]);
    c.close();
  });

  test("the image check is the DISPATCH PIN's: a text-only pin refuses (stage and send, exact message) even when the code default takes images; files need no capability", async () => {
    const { store, c, sid } = await dispatchSession({ code: IMAGE_TAG, dispatch: TEXT_TAG });
    const dir = userDir();
    const before = store.read(sid).length;
    const stage = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(stage.error.code).toBe(ERR.INVALID_PARAMS);
    expect(stage.error.message).toBe(IMAGE_INPUT_UNSUPPORTED_MESSAGE);
    expect(stage.error.data).toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
      const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "shot.png") }] });
      expect(res.error.data).toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    }
    expect(store.read(sid).length).toBe(before);
    // A FILE is a path given as text: no model capability is asked for.
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "[File #1]", files: [{ n: 1, path: join(dir, "plan.md") }] })).error).toBeUndefined();
    // …and a CODE session on the same daemon runs the (image-capable) default: it stages.
    const code = store.createSession("global", {});
    expect((await c.request(METHODS.sessionStageImage, { sessionId: code, mediaType: "image/png", dataBase64: b64(PNG) })).error).toBeUndefined();
    c.close();
  });

  test("…and an image-capable pin accepts, even when the code default is text-only (which still refuses a code session)", async () => {
    const { store, c, sid } = await dispatchSession({ code: TEXT_TAG, dispatch: IMAGE_TAG });
    expect((await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).error).toBeUndefined();
    const code = store.createSession("global", {});
    expect((await c.request(METHODS.sessionStageImage, { sessionId: code, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    // A stored override on the dispatch row (a harness's door only — setModel refuses dispatch) wins over the pin, as the driver spawns it.
    const pinned = store.createSession("global", { mode: "dispatch", model: TEXT_TAG });
    expect((await c.request(METHODS.sessionStageImage, { sessionId: pinned, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    c.close();
  });

  test("chat still refuses both kinds — stage, send and steer — with nothing appended", async () => {
    const { store, c } = await boot({ code: IMAGE_TAG, dispatch: IMAGE_TAG });
    const dir = userDir();
    const chat = store.createSession("global", { mode: "chat", model: IMAGE_TAG });
    expect((await c.request(METHODS.sessionAttach, { sessionId: chat, fromSeq: 0 })).error).toBeUndefined();
    const before = store.read(chat).length;
    expect((await c.request(METHODS.sessionStageImage, { sessionId: chat, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_SESSION_NOT_CODE });
    for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
      expect((await c.request(method, { sessionId: chat, text: "[Image #1]", images: [{ n: 1, path: join(dir, "shot.png") }] })).error.data.code).toBe(IMAGE_SESSION_NOT_CODE);
      expect((await c.request(method, { sessionId: chat, text: "[File #1]", files: [{ n: 1, path: join(dir, "plan.md") }] })).error.data.code).toBe(FILE_SESSION_NOT_CODE);
    }
    expect(store.read(chat).length).toBe(before);
    c.close();
  });

  test("a remote caller (the phone) never stages or sends attachments to Dispatch — typed, nothing appended; plain text still goes", async () => {
    const { store, socketPath, tokens, c, sid } = await dispatchSession({ code: IMAGE_TAG, dispatch: IMAGE_TAG });
    const dir = userDir();
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    expect((await phone.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 })).error).toBeUndefined();
    const before = store.read(sid).length;
    const stage = await phone.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(stage.error).toBeDefined();
    const image = await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "shot.png") }] });
    expect(image.error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    const file = await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[File #1]", files: [{ n: 1, path: join(dir, "plan.md") }] });
    expect(file.error.data.code).toBe(FILE_REFERENCE_INVALID);
    expect(JSON.stringify([image.error, file.error])).not.toContain(dir);
    expect(store.read(sid).length).toBe(before);
    expect((await phone.request(METHODS.sessionSend, { sessionId: sid, text: "hello from the phone" })).error).toBeUndefined();
    phone.close(); c.close();
  });

  test("the phone sees a Dispatch message's attachments by NAME only — no `/` reaches a remote client on either path", async () => {
    const { store, c, sid } = await dispatchSession({ code: IMAGE_TAG, dispatch: IMAGE_TAG });
    const dir = userDir();
    const staged = (await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).result.path as string;
    expect((await c.request(METHODS.sessionSend, {
      sessionId: sid, text: "[Image #1] [Image #2] [File #1]",
      images: [{ n: 1, path: staged }, { n: 2, path: join(dir, "shot.png") }], files: [{ n: 1, path: join(dir, "project") }],
    })).error).toBeUndefined();
    const [stored] = userMessages(store, sid);
    const fromHistory = readHistoryPage(store, { sessionId: sid }).events.find((e) => e.type === "user_message") as typeof stored;
    const live = filterRemoteStreamEvent(stored!) as typeof stored;
    for (const view of [fromHistory!, live!]) {
      expect(view.images).toEqual([{ n: 1, path: "image_1.png" }, { n: 2, path: "shot.png" }]);
      expect(view.files).toEqual([{ n: 1, path: "project" }]);
      for (const ref of [...view.images!, ...view.files!]) expect(ref.path).not.toContain("/");
      expect(SessionEvent.safeParse(view).success).toBe(true);
    }
    c.close();
  });
});
