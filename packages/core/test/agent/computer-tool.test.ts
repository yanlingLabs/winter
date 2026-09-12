import { describe, expect, test } from "bun:test";
import { ToolRegistry, type ToolContext } from "../../src/agent/tools/registry";
import { registerComputerTool } from "../../src/agent/tools/computer";
import type { CuActResult } from "../../src/agent/computer-use";

/** A fake ComputerUseService capturing act() calls and returning a scripted result. */
function fakeCu(result: CuActResult | ((cls: string, payload: string) => CuActResult)) {
  const calls: Array<{ cls: string; payload: string }> = [];
  const act = async (_sid: string, cls: string, payload: string) => {
    calls.push({ cls, payload });
    return typeof result === "function" ? result(cls, payload) : result;
  };
  return { calls, service: { act } as any };
}

function ctx(over: Partial<ToolContext>): ToolContext {
  return { cwd: "/tmp", roots: ["/tmp"], sessionId: "s1", ...over } as ToolContext;
}

async function run(reg: ToolRegistry, args: unknown, c: ToolContext) {
  return reg.execute("computer", args, c);
}

describe("computer tool", () => {
  test("ax_snapshot → ax-read class, returns the tree text", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ text: "#0 window\n#1 button 'Save' @ (840,620)" }) });
    const out = await run(reg, { action: "ax_snapshot" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(false);
    expect(out.output).toContain("button 'Save'");
    expect(cu.calls[0]!).toEqual({ cls: "ax-read", payload: JSON.stringify({ op: "ax_snapshot" }) });
  });

  test("screenshot → screenshot class, stages the image via attachImage, needs vision", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const staged: string[] = [];
    const dataUrl = "data:image/png;base64,ABC";
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ dataUrl, width: 1512, height: 982, scaledWidth: 1280, scaledHeight: 831 }) });
    const out = await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, attachImage: (u) => staged.push(u), visionCapable: true }));
    expect(out.isError).toBe(false);
    expect(staged).toEqual([dataUrl]);
    expect(out.output).toContain("1512×982");
    expect(out.output).toContain("1280×831");
    expect(cu.calls[0]!.cls).toBe("screenshot");
  });

  test("screenshot refused on a non-vision model, and never leases", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, visionCapable: false }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("vision-capable");
    expect(cu.calls.length).toBe(0);
  });

  test("click by element_id → input-drive with an elementId target", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ detail: "clicked element #3" }) });
    const out = await run(reg, { action: "click", element_id: 3 }, ctx({ computerUse: cu.service }));
    expect(out.output).toBe("clicked element #3");
    expect(cu.calls[0]!.cls).toBe("input-drive");
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { elementId: 3 }, button: "left", clicks: 1 });
  });

  test("click by x,y with clicks:2 → coordinate target, 2 clicks", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "click", x: 100, y: 200, clicks: 2, button: "right" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { x: 100, y: 200 }, button: "right", clicks: 2 });
  });

  test("triple-click and middle button ride the payload", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "click", element_id: 4, clicks: 3 }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { elementId: 4 }, button: "left", clicks: 3 });
    await run(reg, { action: "click", x: 10, y: 20, button: "middle" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[1]!.payload)).toEqual({ op: "click", target: { x: 10, y: 20 }, button: "middle", clicks: 1 });
  });

  test("clicks outside 1-3 are rejected by the schema", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "click", element_id: 1, clicks: 4 }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(cu.calls.length).toBe(0);
  });

  test("modifiers ride the click payload (modifier-click)", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "click", element_id: 2, modifiers: ["shift", "cmd"] }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "click", target: { elementId: 2 }, button: "left", clicks: 1, modifiers: ["shift", "cmd"] });
  });

  test("drag → input-drive with from/to targets (element and coordinate forms)", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ detail: "dragged" }) });
    const out = await run(reg, { action: "drag", element_id: 3, to_x: 500, to_y: 300 }, ctx({ computerUse: cu.service }));
    expect(out.output).toBe("dragged");
    expect(cu.calls[0]!.cls).toBe("input-drive");
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "drag", from: { elementId: 3 }, to: { x: 500, y: 300 } });
    await run(reg, { action: "drag", x: 1, y: 2, to_element_id: 9, modifiers: ["shift"] }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[1]!.payload)).toEqual({ op: "drag", from: { x: 1, y: 2 }, to: { elementId: 9 }, modifiers: ["shift"] });
  });

  test("drag without a destination → typed error, no lease", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "drag", element_id: 3 }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("destination");
    expect(cu.calls.length).toBe(0);
  });

  test("wait is purely local: no lease, no peripheral call, abort returns early", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const started = Date.now();
    const out = await run(reg, { action: "wait", seconds: 0.02 }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(false);
    expect(out.output).toBe("waited 0.02s");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(cu.calls.length).toBe(0); // never touched the peripheral
    // an already-aborted signal returns immediately (no real 5s wait) and reports the truth
    const clamped = await run(reg, { action: "wait", seconds: 99 }, ctx({ computerUse: cu.service, signal: AbortSignal.abort() }));
    expect(clamped.output).toBe("wait interrupted");
  });

  test("wait without seconds → typed error", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "wait" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(cu.calls.length).toBe(0);
  });

  test("zoom → screenshot class with the region, stages the image, adds the origin note", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg, { screenshotMaxDim: 1280 });
    const staged: string[] = [];
    const cu = fakeCu({
      ok: true,
      resultJson: JSON.stringify({ dataUrl: "data:image/png;base64,Z", width: 400, height: 300, scaledWidth: 400, scaledHeight: 300, originX: 850, originY: 400 }),
    });
    const out = await run(reg, { action: "zoom", x: 850, y: 400, width: 400, height: 300 }, ctx({ computerUse: cu.service, attachImage: (u) => staged.push(u), visionCapable: true }));
    expect(cu.calls[0]!.cls).toBe("screenshot");
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "zoom", x: 850, y: 400, width: 400, height: 300, maxDim: 1280 });
    expect(staged).toEqual(["data:image/png;base64,Z"]);
    expect(out.output).toContain("(850,400)");
    expect(out.output).toContain("ADD the region origin");
  });

  test("zoom without a full region → typed error, no lease; zoom is vision-gated like screenshot", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "zoom", x: 10, y: 10, width: 100 }, ctx({ computerUse: cu.service, visionCapable: true }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("region");
    const blocked = await run(reg, { action: "zoom", x: 0, y: 0, width: 10, height: 10 }, ctx({ computerUse: cu.service, visionCapable: false }));
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain("vision-capable");
    expect(cu.calls.length).toBe(0);
  });

  test("click with no target → typed error, no lease", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    const out = await run(reg, { action: "click" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("needs a target");
    expect(cu.calls.length).toBe(0);
  });

  test("type → op type with text", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "type", text: "hello" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "type", text: "hello" });
  });

  test("key → op key with the chord", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "key", keys: "cmd+s" }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "key", keys: "cmd+s" });
  });

  test("scroll with a target and deltas", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "scroll", x: 10, y: 20, dy: -120 }, ctx({ computerUse: cu.service }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "scroll", target: { x: 10, y: 20 }, dx: 0, dy: -120 });
  });

  test("scroll without a target scrolls at the current position", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: true, resultJson: "{}" });
    await run(reg, { action: "scroll", dy: 100 }, ctx({ computerUse: cu.service }));
    const p = JSON.parse(cu.calls[0]!.payload);
    expect(p.op).toBe("scroll");
    expect(p.dy).toBe(100);
    expect(p.target).toBeUndefined();
  });

  test("an act failure surfaces as an isError tool_result with the message", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const cu = fakeCu({ ok: false, kind: "unavailable", message: "computer use unavailable — Winter.app not running" });
    const out = await run(reg, { action: "ax_snapshot" }, ctx({ computerUse: cu.service }));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("computer use unavailable — Winter.app not running");
  });

  test("no computerUse wired → typed error", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg);
    const out = await run(reg, { action: "ax_snapshot" }, ctx({}));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("not available");
  });

  test("screenshotMaxDim from registration rides the payload", async () => {
    const reg = new ToolRegistry();
    registerComputerTool(reg, { screenshotMaxDim: 1024 });
    const cu = fakeCu({ ok: true, resultJson: JSON.stringify({ dataUrl: "data:,x" }) });
    await run(reg, { action: "screenshot" }, ctx({ computerUse: cu.service, attachImage: () => {}, visionCapable: true }));
    expect(JSON.parse(cu.calls[0]!.payload)).toEqual({ op: "screenshot", maxDim: 1024 });
  });
});
