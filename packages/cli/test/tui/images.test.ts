// Code-mode image input (2026-09-29; raw image paths 2026-10-10): the TUI's pure helpers — placeholder
// bookkeeping, the file-vs-data attachments, submit-time resolution, pasted-path recognition, the file
// check, and the over-budget downscale. The clipboard reader itself is never run here (it would read the
// user's real clipboard); `<App>` takes an injected one (app.test.tsx).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_FILE_MAX_BYTES, STAGE_IMAGE_MAX_BYTES } from "@yanlinglabs/winter-protocol";
import { imageDimensions } from "@yanlinglabs/winter-core";
import {
  DraftImages, IMAGE_FILE_TOO_LARGE_MESSAGE, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE, inspectImageFile, imagePathFromPaste, imageToken,
  prepareDraftImage, referencedImageNumbers, stageDraftImages, substituteImageTokens, type DraftImage,
} from "../../src/tui/images";
import { makePng } from "../../../core/test/helpers/png-fixture";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const data = (bytes: Uint8Array, mediaType: string): Extract<DraftImage, { kind: "data" }> => ({ kind: "data", bytes, mediaType });
const file = (path: string): Extract<DraftImage, { kind: "file" }> => ({ kind: "file", path });

describe("TUI image placeholders", () => {
  test("the exact strings", () => {
    expect(imageToken(3)).toBe("[Image #3]");
    expect(IMAGE_INPUT_UNSUPPORTED_MESSAGE).toBe("The selected model doesn't support images");
    expect(IMAGE_TOO_LARGE_MESSAGE).toBe("The image is too large to attach");
    expect(IMAGE_FILE_TOO_LARGE_MESSAGE).toBe("Image files must be 64 MB or smaller");
  });

  test("referenced numbers: first-appearance order, each once", () => {
    expect(referencedImageNumbers("a [Image #2] b [Image #1] c [Image #2] [Image #x]")).toEqual([2, 1]);
    expect(referencedImageNumbers("no images")).toEqual([]);
  });

  test("substitution replaces only placeholders it has a path for", () => {
    const out = substituteImageTokens("[Image #1] and [Image #2] and [Image #1]", new Map([[1, "/t/image_4.png"]]));
    expect(out).toBe("/t/image_4.png and [Image #2] and /t/image_4.png");
  });

  test("numbers climb within a draft and never repeat; a sent draft's images go, the next draft restarts at #1", () => {
    const d = new DraftImages();
    expect(d.add(data(PNG, "image/png"))).toBe(1);
    expect(d.add(file("/Users/me/a.png"))).toBe(2);
    const mark = d.mark();
    // Attached to the NEXT draft while the first was still staging: survives the first's clear.
    expect(d.add(data(JPEG, "image/jpeg"))).toBe(3);
    d.clearBefore(mark);
    expect(d.get(1)).toBeUndefined();
    expect(d.get(3)).toEqual(data(JPEG, "image/jpeg"));
    d.clearBefore(d.mark());
    expect(d.add(data(PNG, "image/png"))).toBe(1);
    // …but never onto a number the draft text already shows (a message recalled from history).
    d.clearBefore(d.mark());
    expect(d.add(data(PNG, "image/png"), "recalled [Image #1] and [Image #4]")).toBe(5);
  });

  test("a refused send hands its attachments back: under their own numbers when free, under FRESH ones (rewritten in the text) when the user has reused them", () => {
    const d = new DraftImages();
    d.add(file("/Users/me/a.png"));
    d.add(data(PNG, "image/png"));
    d.add(file("/Users/me/c.png"));
    const text = "[Image #3] and [Image #1]"; // #2's placeholder was deleted
    const held = d.snapshot(text);
    expect(held.map(([n]) => n)).toEqual([3, 1]);
    d.clearBefore(d.mark());
    expect(d.referencedIn(text)).toEqual([]);
    // Meanwhile the user attached something new — the counter had restarted, so it is #1 again.
    expect(d.add(file("/Users/me/new.png"))).toBe(1);
    const back = d.restore(held, text);
    // #3 was free and keeps its number; #1 was TAKEN by new.png, so a.png comes back as #4 (past every number
    // in use here and in the text) and the handed-back text says so — "[Image #1]" must never mean new.png.
    expect(back).toBe("[Image #3] and [Image #4]");
    expect(d.get(1)).toEqual(file("/Users/me/new.png"));
    expect(d.get(3)).toEqual(file("/Users/me/c.png"));
    expect(d.get(4)).toEqual(file("/Users/me/a.png"));
    expect(d.add(file("/Users/me/after.png"))).toBe(5);
  });

  test("restore leaves the text untouched when nothing collides, and renumbers every occurrence of a taken number", () => {
    const d = new DraftImages();
    d.add(file("/a.png"));
    const held = d.snapshot("[Image #1] twice [Image #1] and [Image #01]");
    d.clearBefore(d.mark());
    expect(d.restore(held, "[Image #1]")).toBe("[Image #1]");
    expect(d.get(1)).toEqual(file("/a.png"));
    // Taken again: every spelling of #1 follows the attachment to its new number.
    const d2 = new DraftImages();
    d2.add(file("/a.png"));
    const held2 = d2.snapshot("[Image #1] twice [Image #1] and [Image #01]");
    d2.clearBefore(d2.mark());
    d2.add(file("/new.png"));
    expect(d2.restore(held2, "[Image #1] twice [Image #1] and [Image #01]")).toBe("[Image #2] twice [Image #2] and [Image #2]");
  });

  test("a FILE is its own path — nothing staged; DATA is staged; the text keeps the placeholders, images names the paths", async () => {
    const d = new DraftImages();
    d.add(file("/Users/me/My Shot.png"));
    d.add(data(JPEG, "image/jpeg"));
    d.add(data(PNG, "image/png"));
    const staged: string[] = [];
    const out = await stageDraftImages("see [Image #3] then [Image #1] ([Image #9])", d, async (img) => {
      staged.push(img.mediaType);
      return { path: `/t/image_${staged.length}.png`, imagesOnSend: true };
    });
    expect(staged).toEqual(["image/png"]); // #1 is a file, #2 was deleted from the text: only #3 is staged
    expect(out.text).toBe("see [Image #3] then [Image #1] ([Image #9])");
    expect(out.images).toEqual([{ n: 3, path: "/t/image_1.png" }, { n: 1, path: "/Users/me/My Shot.png" }]);
    expect(out.modelText).toBe("see /t/image_1.png then /Users/me/My Shot.png ([Image #9])");
    expect(out.imagesOnSend).toBe(true);
    await expect(stageDraftImages("[Image #3]", d, () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  });

  test("a daemon that did not announce original-path support (an older one) gets a FILE's path in the text, not in images", async () => {
    const d = new DraftImages();
    d.add(file("/Users/me/My Shot.png"));
    const out = await stageDraftImages("see [Image #1]", d, () => Promise.reject(new Error("a file is never staged")), { originalPaths: false });
    expect(out.imagesOnSend).toBe(false);
    expect(out.modelText).toBe("see /Users/me/My Shot.png");
    // Announced (or not asked): images carries it.
    const yes = await stageDraftImages("see [Image #1]", d, () => Promise.reject(new Error("never")), { originalPaths: true });
    expect(yes.imagesOnSend).toBe(true);
    expect(yes.images).toEqual([{ n: 1, path: "/Users/me/My Shot.png" }]);
    // Clipboard DATA alone does not need the capability: its path is one the daemon staged.
    const data1 = new DraftImages();
    data1.add(data(PNG, "image/png"));
    const staged = await stageDraftImages("[Image #1]", data1, async () => ({ path: "/t/image_1.png", imagesOnSend: true }), { originalPaths: false });
    expect(staged.imagesOnSend).toBe(true);
  });

  test("a draft of only FILES stages nothing at all", async () => {
    const d = new DraftImages();
    d.add(file("/a.png"));
    d.add(file("/b.heic"));
    const out = await stageDraftImages("[Image #1] [Image #2]", d, () => Promise.reject(new Error("must not stage")));
    expect(out.images).toEqual([{ n: 1, path: "/a.png" }, { n: 2, path: "/b.heic" }]);
    expect(out.imagesOnSend).toBe(true);
  });

  test("more than 20 referenced images is refused before anything is staged", async () => {
    const d = new DraftImages();
    let text = "";
    for (let i = 0; i < 21; i++) text += `[Image #${d.add(data(PNG, "image/png"))}] `;
    let staged = 0;
    await expect(stageDraftImages(text, d, async () => { staged++; return { path: "/t/x.png", imagesOnSend: true }; }))
      .rejects.toThrow("A message can carry at most 20 images");
    expect(staged).toBe(0);
  });

  test("one stage answer without imagesOnSend (an older daemon) turns the whole draft to substitution — files included", async () => {
    const d = new DraftImages();
    d.add(data(PNG, "image/png"));
    d.add(file("/Users/me/b.png"));
    d.add(data(PNG, "image/png"));
    let k = 0;
    const out = await stageDraftImages("[Image #1] [Image #2] [Image #3]", d, async () => (++k === 1 ? { path: "/t/a.png", imagesOnSend: true } : { path: "/t/c.png" }));
    expect(out.imagesOnSend).toBe(false);
    expect(out.modelText).toBe("/t/a.png /Users/me/b.png /t/c.png");
  });
});

describe("prepareDraftImage — clipboard DATA stays raw unless it cannot fit one request", () => {
  test("small images attach untouched; non-images are named", async () => {
    expect(await prepareDraftImage(JPEG)).toEqual(data(JPEG, "image/jpeg"));
    const small = makePng(800, 600);
    expect(await prepareDraftImage(small)).toEqual(data(small, "image/png"));
    expect(await prepareDraftImage(new TextEncoder().encode("hello"))).toBe("not-image");
  });

  test("a big image that FITS stays byte for byte as it is — a 4000×3000 PNG is not downscaled", async () => {
    const big = makePng(4000, 3000);
    expect(big.length).toBeLessThan(STAGE_IMAGE_MAX_BYTES);
    const out = await prepareDraftImage(big);
    if (typeof out === "string") throw new Error(`expected an image, got ${out}`);
    expect(out.kind).toBe("data");
    expect(out.bytes).toBe(big); // not even copied
    expect(imageDimensions(out.bytes)).toEqual({ width: 4000, height: 3000 });
  });

  test("raw TIFF, BMP and HEIC data are image data too (no conversion)", async () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
    expect(await prepareDraftImage(tiff)).toEqual(data(tiff, "image/tiff"));
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
    expect(await prepareDraftImage(heic)).toEqual(data(heic, "image/heic"));
  });

  // Real `sips` on a real, generated PNG — the over-budget fallback: ONLY an image that cannot fit is downscaled.
  test("an image over the request budget is downscaled to a 1568 px long edge so it fits", async () => {
    // 2400×2400 RGB noise is ~17 MB as PNG — over STAGE_IMAGE_MAX_BYTES; at 1568×1568 it is still ~7.4 MB, so only a JPEG fits.
    const noisy = makePng(2400, 2400, { noise: true });
    expect(noisy.length).toBeGreaterThan(STAGE_IMAGE_MAX_BYTES);
    const out = await prepareDraftImage(noisy);
    if (typeof out === "string") throw new Error(`expected an image, got ${out}`);
    expect(out.mediaType).toBe("image/jpeg");
    expect(imageDimensions(out.bytes)).toEqual({ width: 1568, height: 1568 });
    expect(out.bytes.length).toBeLessThanOrEqual(STAGE_IMAGE_MAX_BYTES);
  }, 90_000);
});

describe("inspectImageFile — the check a pasted / dragged file passes before it is attached as its own path", () => {
  const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "winter-inspect-"));
    try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("a regular image file is ok whatever it is called; a symlink is followed", () => withDir((dir) => {
    writeFileSync(join(dir, "a.png"), makePng(4, 4));
    writeFileSync(join(dir, "no-extension"), PNG);
    writeFileSync(join(dir, "b.heic"), new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0]));
    symlinkSync(join(dir, "a.png"), join(dir, "link.png"));
    for (const name of ["a.png", "no-extension", "b.heic", "link.png"]) expect({ name, r: inspectImageFile(join(dir, name)) }).toEqual({ name, r: "ok" });
  }));

  test("not-image: text with an image extension, an empty file, a directory, a missing path", () => withDir((dir) => {
    writeFileSync(join(dir, "fake.png"), "plain text, not an image");
    writeFileSync(join(dir, "empty.png"), "");
    mkdirSync(join(dir, "folder.png"));
    for (const name of ["fake.png", "empty.png", "folder.png", "missing.png"]) expect({ name, r: inspectImageFile(join(dir, name)) }).toEqual({ name, r: "not-image" });
  }));

  test("too-large: past the 64 MiB the runtime's Read tool prepares; exactly the cap is fine — and the file is never read", () => withDir((dir) => {
    const exact = join(dir, "exact.png");
    writeFileSync(exact, PNG);
    truncateSync(exact, IMAGE_FILE_MAX_BYTES);
    expect(inspectImageFile(exact)).toBe("ok");
    const over = join(dir, "over.png");
    writeFileSync(over, PNG);
    truncateSync(over, IMAGE_FILE_MAX_BYTES + 1);
    expect(inspectImageFile(over)).toBe("too-large");
  }));
});

describe("pasted paths", () => {
  test("shell-escaped, quoted, file:// and ~/ forms; anything else is not a path", () => {
    expect(imagePathFromPaste("/Users/me/My\\ Shot.png")).toBe("/Users/me/My Shot.png");
    expect(imagePathFromPaste("'/Users/me/My Shot.JPG'")).toBe("/Users/me/My Shot.JPG");
    expect(imagePathFromPaste('"/tmp/a b.webp" ')).toBe("/tmp/a b.webp");
    expect(imagePathFromPaste("file:///tmp/a%20b.gif")).toBe("/tmp/a b.gif");
    expect(imagePathFromPaste("~/Desktop/x.jpeg")).toBe(join(homedir(), "Desktop/x.jpeg"));
    expect(imagePathFromPaste("relative/x.png")).toBeUndefined();
    expect(imagePathFromPaste("/tmp/notes.txt")).toBeUndefined();
    expect(imagePathFromPaste("/tmp/a.png\n/tmp/b.png")).toBeUndefined();
    expect(imagePathFromPaste("please look at /tmp/a.png")).toBeUndefined();
  });

  test("every extension the Read tool prepares is a path: heic, tif, tiff and bmp too", () => {
    for (const ext of ["heic", "HEIC", "tif", "tiff", "bmp", "png", "jpg", "jpeg", "gif", "webp"]) {
      expect({ ext, p: imagePathFromPaste(`/tmp/x.${ext}`) }).toEqual({ ext, p: `/tmp/x.${ext}` });
    }
    expect(imagePathFromPaste("/tmp/x.svg")).toBeUndefined();
    expect(imagePathFromPaste("/tmp/x.pdf")).toBeUndefined();
  });
});
