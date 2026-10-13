// The live suite's `wake` group without a screen: its scripts are valid JavaScript for the automation runtime, the
// runner's window parsing, and both verdicts — a real wake passes, and every way one can fall short fails its check.
import { describe, expect, test } from "bun:test";
import type { FixtureEvent } from "./lib";
import { scriptOf, type VerifyContext } from "./scenarios";
import { NO_WAKE_MS, noWakeChecks, onScreenIds, onScreenSummary, USER_CLICK_METHOD, WAKE_SCENARIOS, WAKE_WITHIN_MS, wakeFiredChecks, type WakeObservation } from "./wake";

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
    // The user brings the WATCHED window forward, not just the app: the ring is drawn only while it is the front one.
    expect(WAKE_SCENARIOS[0]!.wake).toEqual({ userClicks: "Submit", window: "Fixture Form", withinMs: WAKE_WITHIN_MS });
    expect(WAKE_SCENARIOS[0]!.code).toContain("wakeWhen({ clicked: submit.ref }");
    // The converse: a REAL click carrying Winter's own mark (never an accessibility press, which sends no mouse event),
    // then a cleanup turn that cancels the trigger.
    expect(WAKE_SCENARIOS[1]!.wake).toEqual({ userClicks: "Submit", window: "Fixture Form", stamp: "winter", withinMs: NO_WAKE_MS, cleanup: "await WAKE_CONVERSE.cancel();\nreport({ cancelled: true });" });
    expect(WAKE_SCENARIOS[1]!.code).not.toContain(".click(");
    compiles(scriptOf({ code: WAKE_SCENARIOS[1]!.wake!.cleanup! }));
    expect(USER_CLICK_METHOD).toBe("test.userClick");
  });

  test("the helper's windows on screen, from cu-live-tool's lines", () => {
    expect([...onScreenIds('{"id":4,"onScreen":true}\n{"id":5,"onScreen":false}\nnot json\n{"id":"6","onScreen":true}\n')]).toEqual([4]);
    expect(onScreenIds("").size).toBe(0);
    // Front first, on-screen only: what the report says of the fixture when the ring was not counted.
    expect(onScreenSummary('{"id":148143,"layer":0,"onScreen":true,"bounds":[6,35,652,434]}\n{"id":147739,"layer":0,"onScreen":true,"bounds":[12,41,640,422]}\n'
      + '{"id":147753,"layer":0,"onScreen":false,"bounds":[0,0,1512,982]}\nnot json\n')).toBe("148143 L0 652×434, 147739 L0 640×422");
    expect(onScreenSummary("")).toBe("");
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

  test("the converse: a click carrying Winter's own mark never wakes the session", () => {
    const quietWake: WakeObservation = { ringWindows: 2, clicked: true, cleanedUp: true, ringGone: true };
    const quiet = ctx({ wake: quietWake });
    expect(failing(noWakeChecks(quiet))).toEqual([]);
    expect(failing(noWakeChecks({ ...quiet, wake: { ...quietWake, message: WAKE_TEXT, clientName: "computer-wake" } }))).toEqual(["Winter's own click never woke the session"]);
    expect(failing(noWakeChecks({ ...quiet, events: [] }))).toEqual(["a real click carrying Winter's own mark reached Submit (the fixture's own log)"]);
    expect(failing(noWakeChecks({ ...quiet, wake: { ...quietWake, cleanedUp: false } }))).toEqual(["the trigger was cancelled afterwards, and its ring went with it"]);
    expect(failing(noWakeChecks({ ...quiet, wake: { ...quietWake, ringWindows: 0 } }))).toEqual(["the ring and the pill were drawn while the fixture was in front"]);
  });

  test("a ring never counted (the full run's flake): the report names the fixture's windows and judges no ring gone or kept", () => {
    const quietWake: WakeObservation = { ringWindows: 0, fixtureWindows: "148143 L0 652×434, 147739 L0 640×422", clicked: true, cleanedUp: true, ringGone: false };
    const checks = noWakeChecks(ctx({ wake: quietWake }));
    expect(failing(checks)).toEqual(["the ring and the pill were drawn while the fixture was in front", "the trigger was cancelled afterwards, and its ring went with it"]);
    const detail = (name: string): string | undefined => (checks.find((c) => c.name === name) as { detail?: string } | undefined)?.detail;
    expect(detail("the ring and the pill were drawn while the fixture was in front"))
      .toBe("0 new helper window(s) on screen — the fixture's windows then, front first: 148143 L0 652×434, 147739 L0 640×422");
    expect(detail("the trigger was cancelled afterwards, and its ring went with it")).toBe("cleanup ran, ring never drawn, so not judged");
    // Counted, then left behind: still said as before.
    const kept = noWakeChecks(ctx({ wake: { ringWindows: 2, clicked: true, cleanedUp: true, ringGone: false } }));
    expect((kept.find((c) => c.name === "the trigger was cancelled afterwards, and its ring went with it") as { detail?: string }).detail).toBe("cleanup ran, ring still on screen");
    // No listing taken (an older runner): the count alone, as before.
    expect((wakeFiredChecks(ctx({ wake: { ...woke, ringWindows: 1 } })).find((c) => c.name === "the ring and the pill were drawn while the fixture was in front") as { detail?: string }).detail)
      .toBe("1 new helper window(s) on screen");
  });
});
