// Code-mode image input (2026-09-29): the TUI's pure helpers — placeholder bookkeeping, submit-time
// substitution, and pasted-path recognition. The clipboard reader itself is never run here (it would
// read the user's real clipboard); `<App>` takes an injected one (app.test.tsx).
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { imageDimensions } from "@yanlinglabs/winter-core";
import {
  DraftImages, IMAGE_INPUT_UNSUPPORTED_MESSAGE, IMAGE_TOO_LARGE_MESSAGE, imagePathFromPaste, imageToken,
  prepareDraftImage, referencedImageNumbers, stageDraftImages, substituteImageTokens,
} from "../../src/tui/images";
import { makePng } from "../../../core/test/helpers/png-fixture";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe("TUI image placeholders", () => {
  test("the exact strings", () => {
    expect(imageToken(3)).toBe("[Image #3]");
    expect(IMAGE_INPUT_UNSUPPORTED_MESSAGE).toBe("The selected model doesn't support images");
    expect(IMAGE_TOO_LARGE_MESSAGE).toBe("Images must be 3.75 MB or smaller");
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
    expect(d.add({ bytes: PNG, mediaType: "image/png" })).toBe(1);
    expect(d.add({ bytes: PNG, mediaType: "image/png" })).toBe(2);
    const mark = d.mark();
    // Attached to the NEXT draft while the first was still staging: survives the first's clear.
    expect(d.add({ bytes: JPEG, mediaType: "image/jpeg" })).toBe(3);
    d.clearBefore(mark);
    expect(d.get(1)).toBeUndefined();
    expect(d.get(3)?.mediaType).toBe("image/jpeg");
    d.clearBefore(d.mark());
    expect(d.add({ bytes: PNG, mediaType: "image/png" })).toBe(1);
    // …but never onto a number the draft text already shows (a message recalled from history).
    d.clearBefore(d.mark());
    expect(d.add({ bytes: PNG, mediaType: "image/png" }, "recalled [Image #1] and [Image #4]")).toBe(5);
  });

  test("staging stages only the placeholders still in the text, in order, then substitutes", async () => {
    const d = new DraftImages();
    d.add({ bytes: PNG, mediaType: "image/png" });
    d.add({ bytes: JPEG, mediaType: "image/jpeg" });
    d.add({ bytes: PNG, mediaType: "image/png" });
    const staged: string[] = [];
    const text = await stageDraftImages("see [Image #3] then [Image #1] ([Image #9])", d, async (img) => {
      staged.push(img.mediaType);
      return `/t/image_${staged.length}.${img.mediaType === "image/png" ? "png" : "jpg"}`;
    });
    expect(staged).toEqual(["image/png", "image/png"]); // #2 was deleted from the text: never staged
    expect(text).toBe("see /t/image_1.png then /t/image_2.png ([Image #9])");
    await expect(stageDraftImages("[Image #1]", d, () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
  });

  test("small images attach untouched; non-images are named", async () => {
    expect(await prepareDraftImage(JPEG)).toEqual({ bytes: JPEG, mediaType: "image/jpeg" });
    const small = makePng(800, 600);
    expect(await prepareDraftImage(small)).toEqual({ bytes: small, mediaType: "image/png" });
    expect(await prepareDraftImage(new TextEncoder().encode("hello"))).toBe("not-image");
  });

  // Real `sips` on a real, generated PNG — the attach-time downscale a Retina screenshot takes.
  test("a 4000×3000 PNG is downscaled to a 1568 px long edge and stays PNG", async () => {
    const big = makePng(4000, 3000);
    const out = await prepareDraftImage(big);
    if (typeof out === "string") throw new Error(`expected an image, got ${out}`);
    expect(out.mediaType).toBe("image/png");
    expect(imageDimensions(out.bytes)).toEqual({ width: 1568, height: 1176 });
    expect(out.bytes.length).toBeLessThanOrEqual(3_932_160);
  }, 30_000);

  test("a PNG still over 3.75 MB after the downscale is re-encoded as JPEG", async () => {
    // Noise barely compresses: 1568×1176 RGB noise is ~5.5 MB as PNG, so only a JPEG fits.
    const noisy = makePng(2400, 1800, { noise: true });
    const out = await prepareDraftImage(noisy);
    if (typeof out === "string") throw new Error(`expected an image, got ${out}`);
    expect(out.mediaType).toBe("image/jpeg");
    expect(imageDimensions(out.bytes)).toEqual({ width: 1568, height: 1176 });
    expect(out.bytes.length).toBeLessThanOrEqual(3_932_160);
  }, 60_000);

  test("pasted paths: shell-escaped, quoted, file:// and ~/ forms; anything else is not a path", () => {
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
});
