// Code-mode image input: `session.send`/`session.steer`'s `images`. The stored `user_message` keeps
// the user's `[Image #n]` placeholders (the bubble shows them) and names each one's file in `images`;
// only the model is given the paths (winter-session.test.ts covers the push). Every entry is checked
// before anything is appended: the file is either one `session.stageImage` wrote for THIS session or
// (2026-10-10, raw image paths) the user's ORIGINAL image file — an absolute path resolving to a regular
// file of at most 64 MiB, an image by its magic bytes, outside the Read tool's read-deny set — and `n` is unique
// and present in the text, a code session, a local caller, a model that reads images.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConnWriter, DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS, ERR, HelloResult, IMAGE_FILE_MAX_BYTES, IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_FILE_UNREADABLE, IMAGE_INPUT_UNSUPPORTED, IMAGE_REFERENCE_INVALID, IMAGE_SESSION_NOT_CODE, IMAGE_SESSION_NO_MODEL,
  IMAGE_TOO_LARGE, IMAGE_TYPE_UNSUPPORTED, LineDecoder, METHODS, PROTOCOL_VERSION, SessionEvent,
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
const TEXT_TAG = loadCatalog().models.find((m) => !m.inputModalities.value.includes("image"))!.key;
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

  /** `withHome`: wire the daemon's `winterHome` (the "never under the home" rule needs one). */
  async function boot(winter?: WinterSessionDrivers, withHome = false) {
    const home = mkdtempSync(join(tmpdir(), "winter-sendimg-"));
    cleanup.push(home);
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      ...(winter === undefined ? {} : { winter }), ...(withHome ? { winterHome: home } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    return { store, socketPath, tokens, c, home };
  }

  /** A code session with one staged image, attached — answers the staged path. */
  async function staged(mode: "code" | "chat" = "code", withHome = false) {
    const b = await boot(undefined, withHome);
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
    // Planted by the agent (the folder is a sandbox writable root): a symlink to the staged file
    // under a name staging WOULD pick, and a subfolder under one too — both of the staged shape, so
    // both held to the strict staged rules.
    symlinkSync(path, join(imagesDir, "image_90.png"));
    mkdirSync(join(imagesDir, "image_91.png"));
    const before = store.read(sid).length;
    const bad: Array<{ text: string; images: Array<{ n: number; path: string }> }> = [
      { text: "no token here", images: [{ n: 1, path }] },
      { text: "[Image #1] [Image #2]", images: [{ n: 1, path }, { n: 2, path: join(imagesDir, "image_7.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path }, { n: 1, path }] },
      { text: "[Image #1]", images: [{ n: 1, path: join(imagesDir, "image_90.png") }] },
      { text: "[Image #1]", images: [{ n: 1, path: join(imagesDir, "image_91.png") }] },
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

  // ---- raw image paths (2026-10-10): the user's ORIGINAL file --------------------------------------

  /** A scratch folder OUTSIDE the daemon's home (so no home rule is in play), with a distinctive name no error may echo. */
  function userDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-userpics-SECRETNAME-")));
    cleanup.push(dir);
    return dir;
  }
  const PNG_FILE = Buffer.concat([Buffer.from(PNG), Buffer.alloc(64)]);

  test("an ORIGINAL image file is accepted as spelled — no copy, no staging, the model sees its own path", async () => {
    const { store, c, sid, path } = await staged();
    const dir = userDir();
    const photo = join(dir, "My Photo.png"); // a space: paths are not shell-escaped on the wire
    writeFileSync(photo, PNG_FILE);
    const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "look at [Image #1] and [Image #2]", images: [{ n: 1, path: photo }, { n: 2, path }] });
    expect(res.error).toBeUndefined();
    const [m] = userMessages(store, sid);
    expect(m).toMatchObject({ text: "look at [Image #1] and [Image #2]", images: [{ n: 1, path: photo }, { n: 2, path }] });
    expect(modelTextOf(m!)).toBe(`look at ${photo} and ${path}`);
    // A draft of ONLY original files never touches the session's staging folder.
    const fresh = store.createSession("global", { model: IMAGE_TAG });
    await c.request(METHODS.sessionAttach, { sessionId: fresh, fromSeq: 0 });
    expect((await c.request(METHODS.sessionSend, { sessionId: fresh, text: "[Image #1]", images: [{ n: 1, path: photo }] })).error).toBeUndefined();
    expect(realpathSync(photo)).toBe(photo);
    c.close();
  });

  test("every type the Read tool prepares is accepted (png/jpeg/gif/webp/heic/tiff/bmp) under the extension Read opens it by, in any case", async () => {
    const { c, sid } = await staged();
    const dir = userDir();
    const files: Array<[string, Uint8Array]> = [
      ["a.png", PNG], ["b.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])], ["b2.jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
      ["c.gif", new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0])],
      ["d.webp", new Uint8Array([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBPVP8 ")])],
      ["e.heic", new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0])],
      ["f.tiff", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])], ["f2.tif", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])],
      ["g.bmp", new Uint8Array([...Buffer.from("BM"), 0, 0, 0, 0, 0, 0])],
      ["UPPER.PNG", PNG], ["Mixed.JpEg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
      // The extension decides, not what the bytes are: a PNG called .jpg is Read's problem (it sniffs it), and is accepted.
      ["png-bytes.jpg", PNG],
    ];
    for (const [name, bytes] of files) {
      writeFileSync(join(dir, name), bytes);
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, name) }] });
      expect({ name, error: res.error }).toEqual({ name, error: undefined });
    }
    c.close();
  });

  // The runtime Read tool opens a file as an image by the EXTENSION of the path the model types
  // (`extname(resolve(path))`, lowercased — `IMAGE_EXTS` in its tools/impl/read.ts) and by nothing else: any
  // other extension falls through to its plain-text reader and hands the model binary junk. A real PNG called
  // `shot.dng` therefore must not be accepted as a path.
  test("Read decides by EXTENSION: an image file whose spelled extension Read does not open is refused, whatever its bytes are", async () => {
    const { store, c, sid } = await staged();
    const dir = userDir();
    const names = ["shot.dng", "shot.nef", "shot.cr2", "shot.arw", "shot.heif", "shot.hif", "shot.heics", "shot.jpe", "shot.jfif", "no-extension", "shot.png.txt", "shot.", ".png", "shot.pngx", "shot.svg"];
    for (const name of names) writeFileSync(join(dir, name), PNG_FILE); // real PNG bytes in every one
    const before = store.read(sid).length;
    for (const name of names) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, name) }] });
        expect({ name, method, code: res.error?.data?.code }).toEqual({ name, method, code: IMAGE_TYPE_UNSUPPORTED });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        expect(res.error.data.n).toBe(1);
        for (const secret of [join(dir, name), "SECRETNAME", dir]) expect(JSON.stringify(res.error)).not.toContain(secret);
      }
    }
    expect(store.read(sid).length).toBe(before);

    // The extension is judged AS SPELLED: Read never follows a link to choose its reader.
    writeFileSync(join(dir, "real.png"), PNG_FILE);
    writeFileSync(join(dir, "x.dng"), PNG_FILE);
    symlinkSync(join(dir, "x.dng"), join(dir, "link.png"));    // spelled .png, target .dng: fine
    symlinkSync(join(dir, "real.png"), join(dir, "alias.dng")); // spelled .dng, target .png: refused
    const ok = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "link.png") }] });
    expect(ok.error).toBeUndefined();
    const refused = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "alias.dng") }] });
    expect(refused.error.data.code).toBe(IMAGE_TYPE_UNSUPPORTED);
    c.close();
  });

  // Same standard as the elicitation cards (`url-elicitation.ts`): control and direction-changing characters
  // are refused, here refused rather than stripped (a stripped path names a different file). Leading or
  // trailing whitespace is refused too: Read trims the path the model types, so it names another file.
  test("a path with a control, line-separator or bidi character, or surrounding whitespace is refused typed — files that really exist, no echo", async () => {
    const { store, c, sid } = await staged();
    const dir = userDir();
    const names: Array<[string, string]> = [
      ["newline", "a\nb.png"], ["tab", "a\tb.png"], ["escape", "a\u001bb.png"], ["DEL", "a\u007fb.png"], ["C1 NEL", "a\u0085b.png"], ["C1 CSI", "a\u009bb.png"],
      ["LINE SEPARATOR", "a\u2028b.png"], ["PARAGRAPH SEPARATOR", "a\u2029b.png"],
      ["LRM", "a\u200eb.png"], ["RLM", "a\u200fb.png"],
      ["RLO", "gnp.\u202etxt.png"], ["LRE", "a\u202ab.png"], ["PDF", "a\u202cb.png"],
      ["LRI", "a\u2066b.png"], ["RLI", "a\u2067b.png"], ["FSI", "a\u2068b.png"], ["PDI", "a\u2069b.png"],
      ["leading newline", "\nlead2.png"],
    ];
    for (const [, name] of names) writeFileSync(join(dir, name), PNG_FILE);
    const before = store.read(sid).length;
    for (const [label, name] of names) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, name) }] });
        expect({ label, method, code: res.error?.data?.code }).toEqual({ label, method, code: IMAGE_REFERENCE_INVALID });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        const wire = JSON.stringify(res.error);
        for (const secret of [name, join(dir, name), "SECRETNAME"]) expect({ label, leaked: wire.includes(secret) }).toEqual({ label, leaked: false });
      }
    }
    // Whitespace around the WHOLE path: Read trims the path the model types, so it would open another file.
    for (const path of [` ${join(dir, "a.png")}`, `${join(dir, "a.png")} `, `${join(dir, "a.png")}\u00a0`, `\u3000${join(dir, "a.png")}`]) {
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
      expect({ path: JSON.stringify(path.replace(dir, "<dir>")), refused: res.error !== undefined }).toEqual({ path: JSON.stringify(path.replace(dir, "<dir>")), refused: true });
    }
    // A NUL cannot be in a file name at all; the daemon still refuses it before touching the disk.
    const nul = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: `${dir}/a\u0000b.png` }] });
    expect(nul.error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    expect(store.read(sid).length).toBe(before);
    // Ordinary non-ASCII is fine (accents, CJK, emoji, a space inside).
    for (const name of ["Écran 2026-10-10 à 14.02.png", "写真.png", "shot 🎉.png"]) {
      writeFileSync(join(dir, name), PNG_FILE);
      const ok = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, name) }] });
      expect({ name, error: ok.error }).toEqual({ name, error: undefined });
    }
    c.close();
  });

  test("a file the daemon cannot read AT ALL is image_file_unreadable, naming the placeholder — a vanished file, a withheld file, a withheld folder", async () => {
    const { store, c, sid } = await staged();
    const dir = userDir();
    writeFileSync(join(dir, "locked.png"), PNG_FILE);
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "inside.png"), PNG_FILE);
    chmodSync(join(dir, "locked.png"), 0o000);
    chmodSync(join(dir, "vault"), 0o000);
    try {
      const before = store.read(sid).length;
      for (const [label, path] of [["missing", join(dir, "gone.png")], ["no read permission", join(dir, "locked.png")], ["folder withheld", join(dir, "vault", "inside.png")]] as const) {
        for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
          const res = await c.request(method, { sessionId: sid, text: "x [Image #3]", images: [{ n: 3, path }] });
          expect({ label, method, code: res.error?.data?.code, n: res.error?.data?.n }).toEqual({ label, method, code: IMAGE_FILE_UNREADABLE, n: 3 });
          expect(res.error.code).toBe(ERR.INVALID_PARAMS);
          expect(res.error.message).toContain("[Image #3]");
          expect(res.error.message).toContain("Files & Folders"); // says what to check
          for (const secret of [path, "SECRETNAME", dir]) expect(JSON.stringify(res.error)).not.toContain(secret);
        }
      }
      expect(store.read(sid).length).toBe(before);
    } finally {
      chmodSync(join(dir, "vault"), 0o700);
      chmodSync(join(dir, "locked.png"), 0o600);
    }
    c.close();
  });

  test("a symlink to an image is fine (the TARGET is judged); a path spelled with .. is fine; the spelling is kept", async () => {
    const { store, c, sid } = await staged();
    const dir = userDir();
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "pic.png"), PNG_FILE);
    symlinkSync(join(dir, "real", "pic.png"), join(dir, "link.png"));
    symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    for (const spelled of [join(dir, "link.png"), join(dir, "linkdir", "pic.png"), `${dir}/real/../real/pic.png`]) {
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: spelled }] });
      expect({ spelled, error: res.error }).toEqual({ spelled, error: undefined });
      expect(userMessages(store, sid).at(-1)!.images).toEqual([{ n: 1, path: spelled }]);
    }
    // A symlink to a non-image is refused by its TARGET, however image-like its own name.
    writeFileSync(join(dir, "notes.txt"), "plain text");
    symlinkSync(join(dir, "notes.txt"), join(dir, "looks-like.png"));
    const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "looks-like.png") }] });
    expect(res.error.data.code).toBe(IMAGE_TYPE_UNSUPPORTED);
    c.close();
  });

  test("an original that is not an absolute path to a real, regular, small image refuses typed — and no refusal echoes the path", async () => {
    const { store, c, sid } = await staged();
    const dir = userDir();
    writeFileSync(join(dir, "notes.png"), "this is text with an image extension");
    writeFileSync(join(dir, "empty.png"), "");
    mkdirSync(join(dir, "folder.png"));
    // > 64 MiB without allocating it: a sparse file with a real PNG header.
    const big = join(dir, "huge.png");
    writeFileSync(big, PNG);
    truncateSync(big, IMAGE_FILE_MAX_BYTES + 1);
    // Exactly the cap is fine (checked below); a FIFO must be refused, never opened for a read that blocks.
    const exact = join(dir, "exact.png");
    writeFileSync(exact, PNG);
    truncateSync(exact, IMAGE_FILE_MAX_BYTES);
    const fifo = join(dir, "pipe.png");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const cases: Array<[string, string, string]> = [
      ["not an image", join(dir, "notes.png"), IMAGE_TYPE_UNSUPPORTED],
      ["empty", join(dir, "empty.png"), IMAGE_TYPE_UNSUPPORTED],
      ["missing", join(dir, "missing.png"), IMAGE_FILE_UNREADABLE],
      ["directory", join(dir, "folder.png"), IMAGE_REFERENCE_INVALID],
      ["fifo", fifo, IMAGE_REFERENCE_INVALID],
      ["over 64 MiB", big, IMAGE_TOO_LARGE],
      ["relative", "pics/shot.png", IMAGE_REFERENCE_INVALID],
      ["dot-relative", "./shot.png", IMAGE_REFERENCE_INVALID],
    ];
    const before = store.read(sid).length;
    for (const [label, path, code] of cases) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
        expect({ label, method, code: res.error?.data?.code }).toEqual({ label, method, code });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        const wire = JSON.stringify(res.error);
        for (const secret of [path, "SECRETNAME", dir, tmpBase]) expect({ label, leaked: wire.includes(secret) }).toEqual({ label, leaked: false });
      }
    }
    expect(store.read(sid).length).toBe(before);
    // The size refusal uses the shared wording; the cap itself is inclusive.
    const over = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: big }] });
    expect(over.error.message).toBe(IMAGE_FILE_TOO_LARGE_MESSAGE);
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: exact }] })).error).toBeUndefined();
    c.close();
  });

  /** An image file named `rel` under `root`, holding real PNG bytes — so only the DENY rule, never the
   *  sniff, can be what refuses it. */
  function plant(root: string, rel: string): string {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, PNG_FILE);
    return path;
  }

  test("only the Read tool's own read-deny set is refused under the home: outputs/ and the rest of it are fine", async () => {
    const { c, sid, home } = await staged("code", true);
    const dir = userDir();
    // The agent's outbox and other ordinary places under the home — a drag out of the outputs box works.
    const allowed = [
      plant(home, "outputs/s_abc123/chart.png"),
      plant(home, "shot.png"),
      plant(home, "memory/_assistant/diagram.png"),
      plant(home, "sdk/projects/-Users-me-repo/memory/pic.png"),
      plant(home, "cache/screenshots/one.png"), // under cache/, but not a run folder's generated config
      plant(home, "run-notes/pic.png"), // a sibling that merely STARTS with "run"
      plant(home, "runtimes-old/pic.png"), // …and one that starts with "runtimes"
    ];
    symlinkSync(allowed[0]!, join(dir, "outbox-link.png"));
    allowed.push(join(dir, "outbox-link.png"), `${dir}/../${home.split("/").pop()}/outputs/s_abc123/chart.png`);
    for (const path of allowed) {
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
      expect({ path: path.replace(home, "<home>"), error: res.error }).toEqual({ path: path.replace(home, "<home>"), error: undefined });
    }

    // The read-deny set: <home>/run, <home>/runtimes, sdk/.winter.json, a run folder's or staging root's
    // generated config files and their backups/. Each file holds real PNG bytes.
    const staging = join(realpathSync(tmpdir()), `claude-resume-${crypto.randomUUID()}`);
    cleanup.push(staging);
    // Every entry is a `.png`-spelled path (Read opens an image by extension), so only the DENY rule — never the
    // extension rule — can be what refuses it. The generated config files themselves are `.json`/dotfiles and so
    // are never image paths at all; they are reached through a `.png`-spelled symlink, which the RESOLVED check catches.
    const denied: Array<[string, string]> = [
      ["run", plant(home, "run/pic.png")],
      ["runtimes", plant(home, "runtimes/bin/winter.png")],
      ["run folder backups", plant(home, "cache/runs/abc/backups/shot.png")],
      ["staging backups", plant(staging, "backups/shot.png")],
    ];
    const config: Array<[string, string]> = [
      ["sdk/.winter.json", plant(home, "sdk/.winter.json")],
      ["run folder .winter.json", plant(home, "cache/runs/abc/.winter.json")],
      ["run folder .claude.json", plant(home, "cache/runs/abc/.claude.json")],
      ["run folder .credentials.json", plant(home, "cache/runs/abc/.credentials.json")],
      ["staging .claude.json", plant(staging, ".claude.json")],
    ];
    config.forEach(([label, target], i) => {
      symlinkSync(target, join(dir, `cfg-${i}.png`));
      denied.push([`${label} via a .png-spelled link`, join(dir, `cfg-${i}.png`)]);
    });
    mkdirSync(join(home, "outputs"), { recursive: true });
    symlinkSync(join(home, "run", "pic.png"), join(dir, "into-run.png"));
    symlinkSync(join(home, "runtimes"), join(dir, "runtimes-dir"));
    denied.push(["symlink into run", join(dir, "into-run.png")]);
    denied.push(["symlink through a dir into runtimes", join(dir, "runtimes-dir", "bin", "winter.png")]);
    denied.push(["run, spelled with ..", `${home}/outputs/../run/pic.png`]);
    denied.push(["run, upper-cased (a case-insensitive volume)", `${home}/RUN/pic.png`]);
    // …and the config files named directly are refused too (by extension — they are not image paths).
    for (const [label, path] of config) {
      const res = await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
      expect({ label, refused: res.error !== undefined }).toEqual({ label, refused: true });
    }
    for (const [label, path] of denied) {
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path }] });
        expect({ label, method, code: res.error?.data?.code }).toEqual({ label, method, code: IMAGE_REFERENCE_INVALID });
        expect(res.error.code).toBe(ERR.INVALID_PARAMS);
        const wire = JSON.stringify(res.error);
        for (const secret of [path, home, dir, staging]) expect({ label, leaked: wire.includes(secret) }).toEqual({ label, leaked: false });
      }
    }
    c.close();
  });

  // Version skew: a client holding a FILE stages nothing, so it cannot learn from `stageImage` whether the daemon
  // takes an original path in `images`. The hello answer says so, before anything is sent.
  test("hello announces that this daemon takes original image paths in images; an older daemon's answer (no features) still parses", async () => {
    const { socketPath, tokens } = await staged();
    const probe = await TestClient.connect(socketPath);
    const hello = await probe.hello(tokens.harness, "probe");
    expect(hello.result.features).toContain(DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS);
    expect(DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS).toBe("image-original-paths");
    expect(HelloResult.parse(hello.result).features).toEqual([DAEMON_FEATURE_IMAGE_ORIGINAL_PATHS]);
    expect(HelloResult.parse({ ok: true, serverVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION }).features).toBeUndefined();
    probe.close();
  });

  test("a daemon with no home wired cannot apply the home rule (the production daemon always has one)", async () => {
    const { c, sid } = await staged(); // no winterHome
    const dir = userDir();
    writeFileSync(join(dir, "ok.png"), PNG_FILE);
    expect((await c.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "ok.png") }] })).error).toBeUndefined();
    c.close();
  });

  test("the model backstop: a send carrying images to a text-only (or model-less) session refuses typed; nothing appended", async () => {
    const { store, c } = await boot();
    const dir = userDir();
    writeFileSync(join(dir, "ok.png"), PNG_FILE);
    const images = [{ n: 1, path: join(dir, "ok.png") }];
    const text = store.createSession("global", { model: TEXT_TAG });
    const switched = store.createSession("global", { model: IMAGE_TAG });
    store.setModel(switched, TEXT_TAG);
    const none = store.createSession("global", { model: "unstated/unstated" });
    for (const [sid, code] of [[text, IMAGE_INPUT_UNSUPPORTED], [switched, IMAGE_INPUT_UNSUPPORTED], [none, IMAGE_SESSION_NO_MODEL]] as const) {
      await c.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 }); // a client is attached to one session at a time
      const before = store.read(sid).length;
      for (const method of [METHODS.sessionSend, METHODS.sessionSteer]) {
        const res = await c.request(method, { sessionId: sid, text: "[Image #1]", images });
        expect({ method, code: res.error?.data?.code }).toEqual({ method, code });
      }
      expect(store.read(sid).length).toBe(before);
    }
    // Plain text to a text-only session is untouched.
    await c.request(METHODS.sessionAttach, { sessionId: text, fromSeq: 0 });
    expect((await c.request(METHODS.sessionSend, { sessionId: text, text: "hello" })).error).toBeUndefined();
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
    // Nor can it name a file on this Mac: an original image path is a local client's alone.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-remote-pic-")));
    cleanup.push(dir);
    writeFileSync(join(dir, "mine.png"), PNG);
    const original = await phone.request(METHODS.sessionSend, { sessionId: sid, text: "[Image #1]", images: [{ n: 1, path: join(dir, "mine.png") }] });
    expect(original.error.data.code).toBe(IMAGE_REFERENCE_INVALID);
    expect(original.error.message).not.toContain(dir);
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
