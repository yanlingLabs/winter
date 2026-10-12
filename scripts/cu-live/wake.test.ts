// The live suite's `wake` group without a screen: its scripts are valid JavaScript for the automation runtime, the
// runner's window parsing, and both verdicts — a real wake passes, and every way one can fall short fails its check.
import { describe, expect, test } from "bun:test";
import type { FixtureEvent } from "./lib";
import { scriptOf, type VerifyContext } from "./scenarios";
import { NO_WAKE_MS, noWakeChecks, onScreenIds, USER_CLICK_METHOD, WAKE_SCENARIOS, WAKE_WITHIN_MS, wakeFiredChecks, type WakeObservation } from "./wake";

const compiles = (code: string): void => {
  expect(() => new Function("apps", "screen", "print", "sleep", "show", `return (async () => {${code}})`)).not.toThrow();
};

const since = 1_000;
const submit: FixtureEvent = { t: since + 500, role: "main", ev: "button", id: "submit" };
const ctx = (over: Partial<VerifyContext> & { wake?: WakeObservation }): VerifyContext => ({
  output: "Armed wk_0123456789ab …", isError: false, facts: { armed: "wk_0123456789ab" }, events: [submit], since,
  probe: [], metrics: [], shots: [], ...over,
});
const WAKE_TEXT = [
  "<computer-wake>",
  "A wake trigger you set has ended.",
  "- wk_0123456789ab fired at 12:41: the user <screen-data id=\"r9\">clicked button “Submit” in Winter CU Fixture — Fixture Form</screen-data>.",
  "</computer-wake>",
].join("\n");
const woke: WakeObservation = { ringWindows: 2, ringGone: true, clicked: true, message: WAKE_TEXT, clientName: "computer-wake", ms: 1_200 };
const failing = (checks: Array<{ name: string; ok: boolean }>): string[] => checks.filter((c) => !c.ok).map((c) => c.name);

describe("the wake group", () => {
  test("every script is valid JavaScript, in a fresh session; the user's click names Submit", () => {
    expect(WAKE_SCENARIOS.length).toBe(2);
    for (const s of WAKE_SCENARIOS) {
      compiles(scriptOf(s));
      expect(s.group).toBe("wake");
      expect(s.session).toBe("fresh");
      expect(s.name.startsWith("wake: ")).toBe(true);
    }
    expect(WAKE_SCENARIOS[0]!.wake).toEqual({ userClicks: "Submit", withinMs: WAKE_WITHIN_MS });
    expect(WAKE_SCENARIOS[0]!.code).toContain("wakeWhen({ clicked: submit.ref }");
    expect(WAKE_SCENARIOS[1]!.wake).toEqual({ withinMs: NO_WAKE_MS });
    expect(USER_CLICK_METHOD).toBe("test.userClick");
  });

  test("the helper's windows on screen, from cu-live-tool's lines", () => {
    expect([...onScreenIds('{"id":4,"onScreen":true}\n{"id":5,"onScreen":false}\nnot json\n{"id":"6","onScreen":true}\n')]).toEqual([4]);
    expect(onScreenIds("").size).toBe(0);
  });

  test("a real wake passes every check", () => {
    expect(failing(wakeFiredChecks(ctx({ wake: woke })))).toEqual([]);
  });

  test("each way a wake falls short fails its own check", () => {
    expect(failing(wakeFiredChecks(ctx({ wake: { ...woke, ringWindows: 0 } })))).toEqual(["the ring and the pill were drawn while the fixture was in front"]);
    expect(failing(wakeFiredChecks(ctx({ wake: { ...woke, ringGone: false } })))).toEqual(["the ring and the pill went with the trigger"]);
    expect(failing(wakeFiredChecks(ctx({ events: [] , wake: woke })))).toEqual(["the user's click reached Submit (the fixture's own log)"]);
    expect(failing(wakeFiredChecks(ctx({ wake: { ...woke, message: undefined, clientName: undefined } })))).toEqual([
      "the session was woken by a computer-wake turn", "the wake names the trigger and says the user clicked", "what came from the screen is fenced in the wake",
    ]);
    expect(failing(wakeFiredChecks(ctx({ wake: { ...woke, message: WAKE_TEXT.replace(/<screen-data[^>]*>|<\/screen-data>/g, "") } }))))
      .toEqual(["what came from the screen is fenced in the wake"]);
    expect(failing(wakeFiredChecks(ctx({ isError: true, wake: woke })))).toEqual(["the trigger was armed on Submit"]);
  });

  test("the converse: Winter's own click never wakes the session", () => {
    const quiet = ctx({ facts: { armed: "wk_0123456789ab", cancelled: true }, wake: {} });
    expect(failing(noWakeChecks(quiet))).toEqual([]);
    expect(failing(noWakeChecks({ ...quiet, wake: { message: WAKE_TEXT, clientName: "computer-wake" } }))).toEqual(["Winter's own click never woke the session"]);
    expect(failing(noWakeChecks({ ...quiet, events: [] }))).toEqual(["Winter's own click landed on Submit (the fixture's own log)"]);
  });
});
