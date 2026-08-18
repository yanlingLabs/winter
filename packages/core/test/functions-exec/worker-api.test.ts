import { describe, expect, test } from "bun:test";
import { ImageDetail, createWorkerHelpers } from "../../src/functions-exec/worker-api";

describe("functions-exec worker helper API", () => {
  test("emits validated text, image, audio, notification, and yield frames", async () => {
    const frames: unknown[] = [];
    const helpers = createWorkerHelpers({ emit: (frame) => frames.push(frame) });
    const image = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    const audio = `data:audio/mpeg;base64,${Buffer.from("audio").toString("base64")}`;

    helpers.text("hello");
    helpers.image({ image_url: image, detail: "high" });
    helpers.audio({ audio_url: audio });
    helpers.notify("finished");
    await helpers.yield();

    expect(frames).toEqual([
      { type: "text", text: "hello" },
      { type: "image", dataUrl: image, detail: ImageDetail.High },
      { type: "audio", dataUrl: audio },
      { type: "notification", text: "finished" },
      { type: "yield" },
    ]);
  });

  test("rejects invalid helper arguments and blocks media from durable store values", () => {
    const helpers = createWorkerHelpers({ emit: () => {} });
    expect(() => helpers.text({ text: "no" } as never)).toThrow(/string/i);
    expect(() => helpers.image("data:text/plain;base64,eA==")).toThrow(/image/i);
    expect(() => helpers.audio("data:audio/mpeg;base64,%%%%")).toThrow(/base64/i);
    expect(() => helpers.store("saved", { attachment: "data:image/png;base64,aGVsbG8=" })).toThrow(/media/i);
    expect(() => helpers.store("x".repeat(65), "ok")).toThrow(/key/i);
  });

  test("stores only bounded JSON values and returns an immutable copy", () => {
    const helpers = createWorkerHelpers({ emit: () => {} });
    helpers.store("result", { answer: "42" });
    const loaded = helpers.load("result") as { answer: string };
    loaded.answer = "mutated";

    expect(helpers.load("result")).toEqual({ answer: "42" });
    expect(helpers.load("missing")).toBeUndefined();
  });
});
