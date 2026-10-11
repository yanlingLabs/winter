// The live suite's `adapters` group, without a screen: every script is valid JavaScript for the automation runtime,
// an AppleScript-backed scenario runs only when the live-test helper already holds the Automation grant (and the
// question is never one that asks), the dry run's plan writes nothing, and the fixture's test adapter is valid.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterProblems } from "../../packages/core/src/computer-use/adapters/registry";
import { ADAPTER_LIVE_DRILLS, adapterScenarios, automationSkip, automationStatus, FIXTURE_ADAPTER, type HelperDoor } from "./adapters";
import { scriptOf } from "./scenarios";

const compiles = (code: string): void => {
  expect(() => new Function("apps", "screen", "print", "sleep", "show", `return (async () => {${code}})`)).not.toThrow();
};

describe("the adapters group", () => {
  test("the fixture's test adapter is valid, and AX-only (no AppleScript)", () => {
    expect(adapterProblems([FIXTURE_ADAPTER])).toEqual([]);
    expect(FIXTURE_ADAPTER.bundleIds).toEqual(["dev.cu-live.fixture"]);
    expect(FIXTURE_ADAPTER.extras.map((e) => `${e.name}:${e.access}`)).toEqual(["fieldValue:view", "fill:full", "submit:click"]);
    for (const e of FIXTURE_ADAPTER.extras) expect(e.run.toString()).not.toContain("applescript");
  });

  test("every script, granted or skipped, with or without --real-apps, is valid JavaScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-live-adapters-"));
    for (const status of ["granted", "would_ask"]) {
      const door: HelperDoor = () => ({ result: { status } });
      for (const s of adapterScenarios({ door, realDir: dir })) {
        compiles(scriptOf(s));
        expect(s.group).toBe("adapters");
        expect(s.name.startsWith("adapters: ")).toBe(true);
      }
    }
    expect(existsSync(join(dir, "adapters", "trash-me.txt"))).toBe(true);
    expect(readFileSync(join(dir, "adapters", "reveal-me.txt"), "utf8")).toContain("adapters group");
  });

  test("an AppleScript-backed scenario asks the helper (test.automation, never asking the user) and skips unless granted", () => {
    const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
    let status = "would_ask";
    const door: HelperDoor = (method, params) => { asked.push({ method, params }); return { result: { status } }; };
    const dict = adapterScenarios({ door }).find((s) => s.name.includes("dict.markFixture"))!;
    expect(dict.code).toContain("skipped");
    expect(dict.code).toContain("macOS would ask the user first");
    expect(asked).toEqual([{ method: "test.automation", params: { bundleId: "dev.cu-live.fixture" } }]);
    // The fixture scenarios that never run AppleScript never ask.
    for (const s of adapterScenarios({ door }).filter((x) => !x.name.includes("dict.markFixture"))) expect(s.code).not.toContain("skipped");
    expect(automationStatus(door, "x.granted.later", 0)).toBe("would_ask");
    status = "granted";
    expect(automationStatus(door, "x.granted.later", 5_000)).toBe("would_ask"); // reused for a few seconds
    expect(automationStatus(door, "x.granted.later", 20_000)).toBe("granted");
    expect(automationSkip("Finder", "denied")).toContain("the user said no");
    // No helper at all: skipped.
    expect(adapterScenarios({}).find((s) => s.name.includes("dict.markFixture"))!.code).toContain("skipped");
  });

  test("with --real-apps the Finder and Safari scenarios are added, each gated on its own app", () => {
    const seen: string[] = [];
    const door: HelperDoor = (_m, p) => { seen.push(String(p.bundleId)); return { result: { status: "granted" } }; };
    const all = adapterScenarios({ door, realDir: mkdtempSync(join(tmpdir(), "cu-live-adapters-")) });
    expect(all.length).toBe(7);
    for (const s of all) void s.code;
    expect(new Set(seen)).toEqual(new Set(["dev.cu-live.fixture", "com.apple.finder", "com.apple.Safari"]));
    const safari = all.find((s) => s.name.includes("Safari"))!;
    // Its OWN window, made and bound by exact id; nothing acts in the page window it reached Safari through.
    expect(safari.code).toContain("anchor.extras.openWindow(");
    expect(safari.code).toContain('apps.open("com.apple.Safari", { window: own })');
    expect(safari.code).toContain("sf.extras.openURL(");
    expect(safari.code).toContain('sf.dict.close({ ref: "window id " + own })');
    expect(safari.code).not.toMatch(/anchor\.extras\.(openURL|pageText|tabs|currentURL)|front window|window 1\b/);
    const reveal = all.find((s) => s.name.includes("reveal"))!;
    expect(reveal.code).toContain("no extra was used there");
    const trash = all.find((s) => s.name.includes("trash"))!;
    expect(trash.code).toContain("trash-me.txt");
  });

  test("the plan names the scenarios and writes nothing", () => {
    const plan = adapterScenarios({ plan: true, realDir: "/nonexistent-cu-live-dir" });
    expect(plan.length).toBe(7);
    expect(existsSync("/nonexistent-cu-live-dir")).toBe(false);
  });

  test("the live-gate drills the review asked for are listed (and printed by the dry run)", () => {
    const all = ADAPTER_LIVE_DRILLS.join("\n");
    expect(all).toContain("openWindow() from a BACKGROUND Safari");
    expect(all).toContain("next cmd-L in Safari must land in THEIR window");
    expect(all).toContain("Mail compose(): the draft is in Drafts exactly once");
    expect(all).toContain("scriptingCommands at bind raises NO Automation prompt");
  });
});
