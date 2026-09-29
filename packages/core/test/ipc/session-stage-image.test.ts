// Code-mode image input (2026-09-29): `session.stageImage` — a composer image staged into the
// session's own temp directory (`sessionTmpDir(sessionId)/images/image_<k>.<ext>`). Local clients
// only, code sessions only, image-capable models only, magic bytes decide the type, 5 MiB decoded,
// daemon-picked names created atomically and never over anything — and the daemon never writes
// through an agent-planted symlink (the session temp dir is a sandbox WRITABLE root).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, ERR, IMAGE_DATA_INVALID, IMAGE_INPUT_UNSUPPORTED, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_SESSION_NOT_CODE,
  IMAGE_STAGE_FAILED, IMAGE_TOO_LARGE, IMAGE_TYPE_MISMATCH, IMAGE_TYPE_UNSUPPORTED, LineDecoder, METHODS, PROTOCOL_VERSION,
  STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_MAX_BYTES, encodeLine, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { decodeStrictBase64, sniffImageMediaType } from "../../src/agent/stage-image";

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

// Picked from the pinned catalog rather than hand-named, so a catalog refresh cannot silently turn
// either into the other.
const catalog = loadCatalog();
const IMAGE_TAG = catalog.models.find((m) => m.inputModalities.value.includes("image"))!.key;
const TEXT_TAG = catalog.models.find((m) => !m.inputModalities.value.includes("image"))!.key;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]);
const BMP = new Uint8Array([...Buffer.from("BM"), 0, 0, 0, 0, 0, 0]);
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("session.stageImage (code-mode image input)", () => {
  let stop: (() => void) | undefined;
  let tmpBase = "";
  let savedTmp: string | undefined;
  beforeEach(() => {
    savedTmp = process.env.WINTER_TMPDIR;
    tmpBase = mkdtempSync(join(tmpdir(), "winter-stage-tmp-"));
    process.env.WINTER_TMPDIR = tmpBase;
  });
  afterEach(() => {
    stop?.(); stop = undefined;
    if (savedTmp === undefined) delete process.env.WINTER_TMPDIR; else process.env.WINTER_TMPDIR = savedTmp;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  async function boot(liveModel?: string) {
    const home = mkdtempSync(join(tmpdir(), "winter-stage-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      ...(liveModel === undefined ? {} : { liveModel: () => liveModel }),
    });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    return { store, socketPath, tokens, c };
  }

  const imagesDirOf = (sid: string) => join(realpathSync(tmpBase), `winter-session-${sid}`, "images");

  test("stages a png under the session's temp dir as image_1.png, 0600, the exact bytes, and returns its realpath", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error).toBeUndefined();
    expect(res.result.path).toBe(join(imagesDirOf(sid), "image_1.png"));
    expect(realpathSync(res.result.path)).toBe(res.result.path);
    expect(new Uint8Array(readFileSync(res.result.path))).toEqual(PNG);
    expect(lstatSync(res.result.path).mode & 0o777).toBe(0o600);
    c.close();
  });

  test("names climb past every existing file and never overwrite one", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const first = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    const second = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/jpeg", dataBase64: b64(JPEG) });
    expect(first.result.path.endsWith("/image_1.png")).toBe(true);
    expect(second.result.path.endsWith("/image_2.jpg")).toBe(true);
    // Something else (the agent, say) already holds a higher number: the next one goes past it, and
    // the existing file is untouched.
    writeFileSync(join(imagesDirOf(sid), "image_7.gif"), "keep me");
    const third = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/gif", dataBase64: b64(GIF) });
    expect(third.result.path.endsWith("/image_8.gif")).toBe(true);
    expect(readFileSync(join(imagesDirOf(sid), "image_7.gif"), "utf8")).toBe("keep me");
    expect(new Uint8Array(readFileSync(first.result.path))).toEqual(PNG);
    c.close();
  });

  test("the MAGIC BYTES decide: all four types stage; a mismatch and an unknown type refuse typed", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    for (const [mediaType, bytes, ext] of [["image/png", PNG, "png"], ["image/jpeg", JPEG, "jpg"], ["image/gif", GIF, "gif"], ["image/webp", WEBP, "webp"]] as const) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType, dataBase64: b64(bytes) });
      expect(res.result.path.endsWith(`.${ext}`)).toBe(true);
    }
    const mismatch = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(JPEG) });
    expect(mismatch.error.code).toBe(ERR.INVALID_PARAMS);
    expect(mismatch.error.data).toEqual({ code: IMAGE_TYPE_MISMATCH });
    const bmp = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(BMP) });
    expect(bmp.error.data).toEqual({ code: IMAGE_TYPE_UNSUPPORTED });
    // A declared type outside the four is refused at the params door.
    const tiff = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/tiff", dataBase64: b64(PNG) });
    expect(tiff.error.code).toBe(ERR.INVALID_PARAMS);
    expect(readdirSync(imagesDirOf(sid)).length).toBe(4);
    c.close();
  });

  test("strict base64: stray characters, bad length and empty data refuse image_data_invalid; nothing is echoed", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    for (const dataBase64 of [`${b64(PNG).slice(0, -4)}!!!!`, `${b64(PNG)}A`, "===="]) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64 });
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.data).toEqual({ code: IMAGE_DATA_INVALID });
      expect(JSON.stringify(res.error)).not.toContain(dataBase64);
    }
    expect(decodeStrictBase64("iVBO R")).toBeUndefined();
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    c.close();
  });

  test("the cap: exactly 5 MiB stages over the REAL socket (it fits the 8 MiB line cap); one byte more refuses image_too_large", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const max = new Uint8Array(STAGE_IMAGE_MAX_BYTES);
    max.set(PNG);
    const maxB64 = b64(max);
    expect(maxB64.length).toBeLessThanOrEqual(STAGE_IMAGE_B64_MAX_LENGTH);
    const ok = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: maxB64 });
    expect(ok.error).toBeUndefined();
    expect(lstatSync(ok.result.path).size).toBe(STAGE_IMAGE_MAX_BYTES);
    // One byte over still encodes within the schema's length bound (no padding), so the DECODED
    // check is what refuses it — typed.
    const over = new Uint8Array(STAGE_IMAGE_MAX_BYTES + 1);
    over.set(PNG);
    const overB64 = b64(over);
    expect(overB64.length).toBe(STAGE_IMAGE_B64_MAX_LENGTH);
    const tooBig = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: overB64 });
    expect(tooBig.error.code).toBe(ERR.INVALID_PARAMS);
    expect(tooBig.error.data).toEqual({ code: IMAGE_TOO_LARGE });
    // Anything longer is refused at the params door, before any decode.
    const farOver = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(new Uint8Array(STAGE_IMAGE_MAX_BYTES + 3)) });
    expect(farOver.error.code).toBe(ERR.INVALID_PARAMS);
    expect(readdirSync(imagesDirOf(sid))).toEqual(["image_1.png"]);
    c.close();
  });

  test("code sessions only: a chat or dispatch session refuses image_session_not_code; an absent mode is code", async () => {
    const { store, c } = await boot();
    for (const mode of ["chat", "dispatch"] as const) {
      const sid = store.createSession("global", { mode, model: IMAGE_TAG });
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.data).toEqual({ code: IMAGE_SESSION_NOT_CODE });
      expect(existsSync(join(tmpBase, `winter-session-${sid}`, "images"))).toBe(false);
    }
    const code = store.createSession("global", { mode: "code", model: IMAGE_TAG });
    expect((await c.request(METHODS.sessionStageImage, { sessionId: code, mediaType: "image/png", dataBase64: b64(PNG) })).error).toBeUndefined();
    c.close();
  });

  test("the session's CURRENT model must take images — exact message, typed code; the live default counts when unset", async () => {
    const { store, c } = await boot(TEXT_TAG);
    const text = store.createSession("global", { model: TEXT_TAG });
    const res = await c.request(METHODS.sessionStageImage, { sessionId: text, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.code).toBe(ERR.INVALID_PARAMS);
    expect(res.error.message).toBe(IMAGE_INPUT_UNSUPPORTED_MESSAGE);
    expect(IMAGE_INPUT_UNSUPPORTED_MESSAGE).toBe("The selected model doesn't support images");
    expect(res.error.data).toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    // No override: the daemon's live default (text-only here) decides.
    const unset = store.createSession("global", {});
    expect((await c.request(METHODS.sessionStageImage, { sessionId: unset, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    // A model switched after the image was attached is caught here — the backstop.
    const switched = store.createSession("global", { model: IMAGE_TAG });
    store.setModel(switched, TEXT_TAG);
    expect((await c.request(METHODS.sessionStageImage, { sessionId: switched, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    // A tag with no catalog row at all has no evidence it reads images.
    const unknown = store.createSession("global", { model: "winter-test/echo" });
    expect((await c.request(METHODS.sessionStageImage, { sessionId: unknown, mediaType: "image/png", dataBase64: b64(PNG) })).error.data)
      .toEqual({ code: IMAGE_INPUT_UNSUPPORTED });
    c.close();
  });

  test("an unknown session is NOT_FOUND", async () => {
    const { c } = await boot();
    const res = await c.request(METHODS.sessionStageImage, { sessionId: "s_nope", mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  test("local clients only: the remote role is refused, and the method is never remote-allowed", async () => {
    const { store, socketPath, tokens, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    const res = await phone.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    const admin = await TestClient.connect(socketPath);
    await admin.hello(tokens.admin, "cli-admin", "admin");
    expect((await admin.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).error.code).toBe(ERR.UNAUTHORIZED);
    expect(existsSync(join(tmpBase, `winter-session-${sid}`, "images"))).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.sessionStageImage)).toBe(false);
    phone.close(); admin.close(); c.close();
  });

  test("an agent-planted `images` symlink is refused and nothing is written through it", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const sessionDir = join(tmpBase, `winter-session-${sid}`);
    const target = mkdtempSync(join(tmpdir(), "winter-stage-target-"));
    mkdirSync(sessionDir, { recursive: true });
    symlinkSync(target, join(sessionDir, "images"));
    const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.code).toBe(ERR.INTERNAL);
    expect(res.error.data).toEqual({ code: IMAGE_STAGE_FAILED });
    expect(readdirSync(target)).toEqual([]);
    rmSync(target, { recursive: true, force: true });
    c.close();
  });

  test("a symlinked session directory is refused too", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const target = mkdtempSync(join(tmpdir(), "winter-stage-target-"));
    symlinkSync(target, join(tmpBase, `winter-session-${sid}`));
    const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.data).toEqual({ code: IMAGE_STAGE_FAILED });
    expect(readdirSync(target)).toEqual([]);
    rmSync(target, { recursive: true, force: true });
    c.close();
  });

  test("a pre-planted image file symlink is never followed or overwritten — the name is skipped", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const images = join(tmpBase, `winter-session-${sid}`, "images");
    mkdirSync(images, { recursive: true });
    const victim = join(mkdtempSync(join(tmpdir(), "winter-stage-victim-")), "victim.txt");
    writeFileSync(victim, "original");
    // A dangling-or-not symlink with a name the daemon might pick: `readdirSync` sees it, so the
    // counter climbs past it; even were it picked, O_EXCL|O_NOFOLLOW refuses to open through it.
    symlinkSync(victim, join(images, "image_1.png"));
    const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.result.path.endsWith("/image_2.png")).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("original");
    c.close();
  });
});
