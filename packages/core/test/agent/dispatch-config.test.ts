import { describe, expect, test } from "bun:test";
import { DISPATCH_EFFORT, dispatchEffortFor, dispatchPinMessage } from "../../src/agent/dispatch-config";
import { Settings } from "../../src/settings";

// 2026-09-18: `DISPATCH_EFFORT` became the DEFAULT for `settings.roleEfforts["pins.dispatch"]`. What the
// child is actually SPAWNED with is asserted end to end in runtime-sdk/session-driver.test.ts; this
// file pins the two pure functions that path (and the two RPC refusals) read.
const settingsOf = (over: Record<string, unknown>): Settings =>
  Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...over });

describe("dispatchEffortFor", () => {
  test("nothing stored → DISPATCH_EFFORT, mapped onto the row as it has been since 2026-09-17", () => {
    expect(dispatchEffortFor(settingsOf({}), "codex-oauth/gpt-5.6-terra")).toBe(DISPATCH_EFFORT);
    expect(dispatchEffortFor(null, "codex-oauth/gpt-5.6-terra")).toBe(DISPATCH_EFFORT);
    // R.1 (catalog refresh): DeepSeek's row lists none/low/high/max and now DECLARES a default (`high`), so
    // `medium` maps onto it; no live row lists a vocabulary without `medium` AND without a default any more.
    expect(dispatchEffortFor(settingsOf({}), "deepseek/deepseek-flash")).toBe("high");
    expect(dispatchEffortFor(settingsOf({}), "winter-test/echo")).toBe(DISPATCH_EFFORT);
  });

  test("a stored role effort wins, mapped — and never throws for a row that does not offer it", () => {
    const s = settingsOf({ roleEfforts: { "pins.dispatch": "xhigh" } });
    expect(dispatchEffortFor(s, "codex-oauth/gpt-5.6-terra")).toBe("xhigh");
    expect(dispatchEffortFor(s, "openai/o4-mini")).toBe("medium");
    expect(dispatchEffortFor(s, "openai/gpt-4.1")).toBeUndefined(); // a row with no reasoning vocabulary at all
  });

  test("only ITS role's effort: the daemon's default effort and the other roles' are not dispatch's", () => {
    const s = settingsOf({ provider: { model: "codex-oauth/gpt-5.6-sol", reasoningEffort: "max" }, roleEfforts: { "pins.dream": "high" } });
    expect(dispatchEffortFor(s, "codex-oauth/gpt-5.6-terra")).toBe(DISPATCH_EFFORT);
  });
});

describe("dispatchPinMessage", () => {
  test("nothing stored → names DISPATCH_EFFORT verbatim, byte-identical to before", () => {
    expect(dispatchPinMessage(settingsOf({}))).toBe(`dispatch runs a fixed model: codex-oauth/gpt-5.6-terra at ${DISPATCH_EFFORT}`);
  });

  test("a stored role effort → names what is actually SPENT on the live pin", () => {
    expect(dispatchPinMessage(settingsOf({ roleEfforts: { "pins.dispatch": "high" } }))).toBe("dispatch runs a fixed model: codex-oauth/gpt-5.6-terra at high");
    expect(dispatchPinMessage(settingsOf({ pins: { dispatch: "openai/gpt-4.1" }, roleEfforts: { "pins.dispatch": "high" } })))
      .toBe("dispatch runs a fixed model: openai/gpt-4.1 at its provider's default effort");
  });
});
