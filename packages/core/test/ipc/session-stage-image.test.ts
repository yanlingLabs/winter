// Code-mode image input (2026-09-29; raw image paths 2026-10-10): `session.stageImage` — a composer image
// with no file of its own staged AS IT IS into the session's own temp directory
// (`sessionTmpDir(sessionId)/images/image_<k>.<ext>`). Local clients only, code sessions only,
// image-capable models only, magic bytes decide the type (png/jpeg/gif/webp/heic/tiff/bmp), as many
// bytes as one request line can carry and no pixel limit, daemon-picked names created atomically and
// never over anything — and the daemon never writes through an agent-planted symlink (the session temp
// dir is a sandbox WRITABLE root).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, ERR, IMAGE_DATA_INVALID, IMAGE_INPUT_UNSUPPORTED, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_SESSION_NOT_CODE,
  IMAGE_SESSION_NO_MODEL, IMAGE_SESSION_NO_MODEL_MESSAGE, IMAGE_STAGE_FAILED, IMAGE_TOO_LARGE, IMAGE_TOO_LARGE_MESSAGE, IMAGE_TYPE_MISMATCH, IMAGE_TYPE_UNSUPPORTED, LineDecoder, METHODS, PROTOCOL_VERSION,
  IMAGE_FILE_EXTENSIONS, NDJSON_MAX_LINE_BYTES, STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_LINE_HEADROOM_BYTES, STAGE_IMAGE_MAX_BYTES, STAGE_IMAGE_MEDIA_TYPES, encodeLine, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { StageImageRefusal, decodeStrictBase64, imageDimensions, sniffImageMediaType, stageSessionImage } from "../../src/agent/stage-image";
import { makePng } from "../helpers/png-fixture";
import { execFileSync } from "node:child_process";

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
const TIFF = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
const TIFF_BE = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
const HEIC = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
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

  // The prompt's one static line tells the model a staged copy "sits inside a `winter-session-…/images/` folder" — so every
  // staged path, whatever the type, must really have that shape.
  test("every staged path has the shape the prompt line names: …/winter-session-<id>/images/image_<k>.<ext>", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    for (const [mediaType, bytes] of [["image/png", PNG], ["image/jpeg", JPEG], ["image/heic", HEIC], ["image/tiff", TIFF]] as const) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType, dataBase64: b64(bytes) });
      expect(res.result.path).toMatch(/\/winter-session-[A-Za-z0-9_-]+\/images\/image_\d+\.(png|jpg|gif|webp|heic|tiff|bmp)$/);
      // …and the extension is one the Read tool opens as an image (it dispatches on the extension alone).
      expect(IMAGE_FILE_EXTENSIONS as readonly string[]).toContain(`.${res.result.path.split(".").pop()}`);
    }
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

  test("the MAGIC BYTES decide: all seven types stage under their own extension; a mismatch and an unknown type refuse typed", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const types = [
      ["image/png", PNG, "png"], ["image/jpeg", JPEG, "jpg"], ["image/gif", GIF, "gif"], ["image/webp", WEBP, "webp"],
      ["image/heic", HEIC, "heic"], ["image/tiff", TIFF, "tiff"], ["image/bmp", BMP, "bmp"],
    ] as const;
    expect(types.map((t) => t[0])).toEqual([...STAGE_IMAGE_MEDIA_TYPES]);
    for (const [mediaType, bytes, ext] of types) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType, dataBase64: b64(bytes) });
      expect(res.error).toBeUndefined();
      expect(res.result.path.endsWith(`.${ext}`)).toBe(true);
      expect(Buffer.from(readFileSync(res.result.path)).equals(Buffer.from(bytes))).toBe(true);
    }
    // The big-endian TIFF is a TIFF too.
    expect(sniffImageMediaType(TIFF_BE)).toBe("image/tiff");
    // A declared type the bytes disagree with, and bytes that are no image at all.
    const mismatch = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(JPEG) });
    expect(mismatch.error.code).toBe(ERR.INVALID_PARAMS);
    expect(mismatch.error.data).toEqual({ code: IMAGE_TYPE_MISMATCH });
    const text = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(new TextEncoder().encode("hello, not an image")) });
    expect(text.error.data).toEqual({ code: IMAGE_TYPE_UNSUPPORTED });
    // A declared type outside the seven is refused at the params door.
    const svg = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/svg+xml", dataBase64: b64(PNG) });
    expect(svg.error.code).toBe(ERR.INVALID_PARAMS);
    expect(readdirSync(imagesDirOf(sid)).length).toBe(types.length);
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

  test("the cap is what one request line can carry: a max-size image stages over the REAL socket, UNCHANGED; anything more refuses image_too_large", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    // Derived from the 8 MiB line cap with explicit headroom, not from the runtime Read tool's
    // (smaller) per-image limit — Read shrinks and re-encodes a bigger source itself.
    expect(STAGE_IMAGE_B64_MAX_LENGTH).toBe(NDJSON_MAX_LINE_BYTES - STAGE_IMAGE_LINE_HEADROOM_BYTES);
    expect(STAGE_IMAGE_MAX_BYTES).toBe((STAGE_IMAGE_B64_MAX_LENGTH / 4) * 3);
    expect(STAGE_IMAGE_MAX_BYTES).toBeGreaterThan(5 * 1024 * 1024);
    const max = new Uint8Array(STAGE_IMAGE_MAX_BYTES);
    max.set(PNG);
    const maxB64 = b64(max);
    expect(maxB64.length).toBe(STAGE_IMAGE_B64_MAX_LENGTH);
    const frame = encodeLine({ jsonrpc: "2.0", id: 1, method: METHODS.sessionStageImage, params: { sessionId: sid, mediaType: "image/png", dataBase64: maxB64 } });
    expect(frame.length).toBeLessThan(NDJSON_MAX_LINE_BYTES - 128 * 1024); // real headroom under the line cap
    const ok = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: maxB64 });
    expect(ok.error).toBeUndefined();
    expect(lstatSync(ok.result.path).size).toBe(STAGE_IMAGE_MAX_BYTES);
    expect(new Uint8Array(readFileSync(ok.result.path))).toEqual(max); // byte for byte: nothing downscaled or re-encoded
    // One byte over, and well over (still inside the line cap, which would otherwise end the
    // connection): the same typed refusal and message, decided from the length.
    for (const size of [STAGE_IMAGE_MAX_BYTES + 1, STAGE_IMAGE_MAX_BYTES + 120_000]) {
      const over = new Uint8Array(size);
      over.set(PNG);
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(over) });
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.data).toEqual({ code: IMAGE_TOO_LARGE });
      expect(res.error.message).toBe(IMAGE_TOO_LARGE_MESSAGE);
    }
    expect(IMAGE_TOO_LARGE_MESSAGE).toBe("The image is too large to attach");
    expect(readdirSync(imagesDirOf(sid))).toEqual(["image_1.png"]);
    c.close();
  }, 30_000);

  test("no pixel limit: a header declaring a huge canvas stages untouched (the runtime's Read tool shrinks it)", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const header = (w: number, h: number) => {
      const png = makePng(4, 4);
      const view = new DataView(png.buffer, png.byteOffset);
      view.setUint32(16, w); view.setUint32(20, h);
      return png;
    };
    for (const [w, h] of [[8001, 10], [10, 20000], [40000, 40000]] as const) {
      const bytes = header(w, h);
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(bytes) });
      expect(res.error).toBeUndefined();
      expect(Buffer.from(readFileSync(res.result.path)).equals(Buffer.from(bytes))).toBe(true);
    }
    c.close();
  });

  test("sniffImageMediaType is the runtime's own sniffer: seven types by magic bytes, HEIC by its ftyp brand, nothing by name", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(GIF)).toBe("image/gif");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
    expect(sniffImageMediaType(BMP)).toBe("image/bmp");
    expect(sniffImageMediaType(TIFF)).toBe("image/tiff");
    expect(sniffImageMediaType(TIFF_BE)).toBe("image/tiff");
    for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]) {
      expect({ brand, t: sniffImageMediaType(new Uint8Array([0, 0, 0, 24, ...Buffer.from(`ftyp${brand}`), 0, 0, 0, 0])) }).toEqual({ brand, t: "image/heic" });
    }
    // An MP4/QuickTime container shares the `ftyp` box but not the brand; a short header is nothing.
    expect(sniffImageMediaType(new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypmp42"), 0, 0, 0, 0]))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftyphei")]))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
    expect(sniffImageMediaType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
  });

  test("imageDimensions reads PNG, JPEG, GIF and WebP headers without decoding", () => {
    expect(imageDimensions(makePng(640, 480))).toEqual({ width: 640, height: 480 });
    const dir = mkdtempSync(join(tmpdir(), "winter-dims-"));
    try {
      const src = join(dir, "a.png");
      writeFileSync(src, makePng(321, 123));
      for (const [format, ext] of [["jpeg", "jpg"], ["gif", "gif"]] as const) {
        const out = join(dir, `a.${ext}`);
        execFileSync("/usr/bin/sips", ["-s", "format", format, src, "--out", out], { stdio: "ignore" });
        expect(imageDimensions(new Uint8Array(readFileSync(out)))).toEqual({ width: 321, height: 123 });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // WebP's three header kinds, hand-built (sips cannot write WebP).
    const riff = (fourcc: string, body: number[]) => new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(fourcc), 0, 0, 0, 0, ...body]);
    // VP8X: 24-bit (w-1), (h-1) at 24..29.
    expect(imageDimensions(riff("VP8X", [0, 0, 0, 0, 0x3f, 0x01, 0, 0x1f, 0x03, 0]))).toEqual({ width: 320, height: 800 });
    // VP8 (lossy): frame tag + start code, then 14-bit w/h at 26..29.
    expect(imageDimensions(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0x20, 0x03]))).toEqual({ width: 320, height: 800 });
    // VP8L (lossless): signature 0x2f, then 14-bit (w-1), (h-1) packed from byte 21.
    const w = 320 - 1, h = 800 - 1;
    const bits = w | (h << 14);
    expect(imageDimensions(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff, 0, 0, 0, 0, 0]))).toEqual({ width: 320, height: 800 });
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
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

  test("local clients only: the remote, admin and plugin roles are refused, and the method is never remote-allowed", async () => {
    const { store, socketPath, tokens, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const phone = await TestClient.connect(socketPath);
    await phone.hello(tokens.remote, "iphone-gateway", "remote");
    const res = await phone.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    const admin = await TestClient.connect(socketPath);
    await admin.hello(tokens.admin, "cli-admin", "admin");
    expect((await admin.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).error.code).toBe(ERR.UNAUTHORIZED);
    const plugin = await TestClient.connect(socketPath);
    const pluginToken = store.mintPluginToken("p-stage");
    const helloed = await plugin.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "plugin", token: pluginToken, clientName: "p", pluginId: "p-stage" });
    expect(helloed.error).toBeUndefined();
    expect((await plugin.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) })).error.code).toBe(ERR.UNAUTHORIZED);
    plugin.close();
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

  test("the session directory swapped for a symlink right after its check: nothing is written through it", () => {
    const sid = "s_swap";
    const sessionDir = join(tmpBase, `winter-session-${sid}`);
    const elsewhere = mkdtempSync(join(tmpdir(), "winter-stage-elsewhere-"));
    mkdirSync(join(elsewhere, "images"));
    let caught: unknown;
    try {
      stageSessionImage({ sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) }, {
        // The sandboxed shell can replace a direct child of the temp dir at any moment: here, right
        // after the daemon has checked it (where the old `realpathSync(sessionDir)` then followed it).
        afterSessionDirCheck: () => {
          renameSync(sessionDir, `${sessionDir}-moved`);
          symlinkSync(elsewhere, sessionDir);
        },
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(StageImageRefusal);
    expect((caught as StageImageRefusal).code).toBe(IMAGE_STAGE_FAILED);
    expect(readdirSync(join(elsewhere, "images"))).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a planted image_9007199254740991.png (or any index past 9 digits) does not stop staging", async () => {
    const { store, c } = await boot();
    const sid = store.createSession("global", { model: IMAGE_TAG });
    const images = join(tmpBase, `winter-session-${sid}`, "images");
    mkdirSync(images, { recursive: true });
    writeFileSync(join(images, "image_9007199254740991.png"), "planted");
    writeFileSync(join(images, "image_10000000000.png"), "planted");
    for (const n of [1, 2]) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
      expect(res.result.path.endsWith(`/image_${n}.png`)).toBe(true);
    }
    c.close();
  });

  test("a session with no model at all gets its own refusal, not the images one", async () => {
    const { store, c } = await boot();
    const unstated = store.createSession("global", { model: "unstated/unstated" });
    const none = store.createSession("global", {}); // no override and no live default
    for (const sid of [unstated, none]) {
      const res = await c.request(METHODS.sessionStageImage, { sessionId: sid, mediaType: "image/png", dataBase64: b64(PNG) });
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      expect(res.error.data).toEqual({ code: IMAGE_SESSION_NO_MODEL });
      expect(res.error.message).toBe(IMAGE_SESSION_NO_MODEL_MESSAGE);
    }
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
