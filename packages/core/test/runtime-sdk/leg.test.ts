import { test, expect } from "bun:test";
import type { Settings } from "../../src/settings";
import { legForNewSession } from "../../src/runtime-sdk/leg";

const MODES = ["code", "dispatch", "chat"] as const;

/** Task 15 has not added `winterLeg` to the zod block yet, so a settings literal carrying one is
 *  structurally wider than the inferred `Settings` type — exactly the shape `legForNewSession`
 *  reads through. */
function settingsWith(leg: Record<string, boolean>): Settings {
  return { runtimes: { winterLeg: leg } } as unknown as Settings;
}

test("an ABSENT runtimes block answers the schema's per-mode defaults (Task 17: dispatch on the Winter leg)", () => {
  expect(legForNewSession("dispatch", {} as Settings)).toBe("winter");
  expect(legForNewSession("chat", {} as Settings)).toBe("engine");
  expect(legForNewSession("code", {} as Settings)).toBe("engine");
});

test("undefined settings entirely answers the same defaults", () => {
  expect(legForNewSession("dispatch", undefined)).toBe("winter");
  expect(legForNewSession("chat", undefined)).toBe("engine");
  expect(legForNewSession("code", undefined)).toBe("engine");
});

test("a runtimes block with NO winterLeg answers the schema's per-mode DEFAULTS (Task 17: dispatch is on the Winter leg; chat/code still on the engine)", () => {
  // The shipped shape before any flag was written: `runtimes` exists for retention/migrations and
  // knows nothing about a leg. The answer is the ONE defaults door's (`winterOptionsFromSettings`).
  const s = { runtimes: { retention: { deliveriesDays: 30, nameLeasesDays: 7 }, migrations: { memoryKeys: false } } } as unknown as Settings;
  expect(legForNewSession("dispatch", s)).toBe("winter");
  expect(legForNewSession("chat", s)).toBe("engine");
  expect(legForNewSession("code", s)).toBe("engine");
  // and an absent settings object altogether answers the same
  expect(legForNewSession("dispatch", undefined)).toBe("winter");
  expect(legForNewSession("chat", null)).toBe("engine");
});

test("a winterLeg with only SOME modes leaves the others on the engine", () => {
  const s = settingsWith({ chat: true, dispatch: false });
  expect(legForNewSession("chat", s)).toBe("winter");
  expect(legForNewSession("dispatch", s)).toBe("engine");
  expect(legForNewSession("code", s)).toBe("engine");
});

test("each mode's flag is read independently", () => {
  expect(legForNewSession("code", settingsWith({ code: true, chat: false, dispatch: false }))).toBe("winter");
  expect(legForNewSession("chat", settingsWith({ code: true, chat: false, dispatch: false }))).toBe("engine");
  expect(legForNewSession("dispatch", settingsWith({ code: true, chat: false, dispatch: false }))).toBe("engine");
  const all = settingsWith({ code: true, dispatch: true, chat: true });
  for (const m of MODES) expect(legForNewSession(m, all)).toBe("winter");
});

test("only a literal true moves a session — a hand-edited truthy value does not", () => {
  // A user who wrote `"yes"` or `1` into settings.json must not have their sessions silently moved
  // onto a leg they did not ask for.
  for (const v of ["yes", 1, "true", {}, []] as unknown[]) {
    expect(legForNewSession("code", settingsWith({ code: v as boolean }))).toBe("engine");
    // a default-ON leg is moved OFF by a hand-edited non-boolean too: only `true` is on
    expect(legForNewSession("dispatch", settingsWith({ dispatch: v as boolean }))).toBe("engine");
  }
  expect(legForNewSession("code", settingsWith({ code: false }))).toBe("engine");
  expect(legForNewSession("code", settingsWith({ code: true }))).toBe("winter");
  expect(legForNewSession("dispatch", settingsWith({ dispatch: false }))).toBe("engine");
});
