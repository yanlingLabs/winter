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
    expect(() => helpers.store("saved", { attachment: "data%3Aimage%2Fpng%3Bbase64%2CaGVsbG8%3D" })).toThrow(/media/i);
    expect(() => helpers.store("saved", { attachment: "d\\\\u0061ta:image/png;base64,aGVsbG8=" })).toThrow(/media/i);
    expect(() => helpers.store("saved", { note: "attachment=data:image/png;base64,aGVsbG8=" })).toThrow(/media/i);
    expect(() => helpers.store("data:image/png;base64,aGVsbG8=", "ok")).toThrow(/media/i);
    expect(() => helpers.store("x".repeat(65), "ok")).toThrow(/key/i);
  });

  test("takes a canonical snapshot without invoking hostile getters, toJSON, or prototype hooks", () => {
    const helpers = createWorkerHelpers({ emit: () => {} });
    let getterCalls = 0;
    let toJsonCalls = 0;
    let prototypeCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "attachment", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "data:image/png;base64,aGVsbG8=";
      },
    });
    const toJson = {
      toJSON() {
        toJsonCalls += 1;
        return "data:image/png;base64,aGVsbG8=";
      },
    };
    const proxied = new Proxy({ answer: "42" }, {
      get() {
        getterCalls += 1;
        throw new Error("must not read through a proxy getter");
      },
      getPrototypeOf() {
        prototypeCalls += 1;
        throw new Error("must not read a prototype");
      },
    });

    expect(() => helpers.store("accessor", accessor as never)).toThrow();
    expect(() => helpers.store("to-json", toJson as never)).toThrow(/JSON/i);
    helpers.store("proxied", proxied as never);

    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(prototypeCalls).toBe(0);
    expect(helpers.load("proxied")).toEqual({ answer: "42" });
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
