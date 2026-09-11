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

test("an ABSENT runtimes block defaults every mode to the engine", () => {
  for (const m of MODES) expect(legForNewSession(m, {} as Settings)).toBe("engine");
});

test("undefined settings entirely defaults every mode to the engine", () => {
  for (const m of MODES) expect(legForNewSession(m, undefined)).toBe("engine");
});

test("a runtimes block with NO winterLeg defaults every mode to the engine", () => {
  // This is the shipped shape today: `runtimes` exists for retention/migrations and knows nothing
  // about a leg. Every existing install is here.
  const s = { runtimes: { retention: { deliveriesDays: 30, nameLeasesDays: 7 }, migrations: { memoryKeys: false } } } as unknown as Settings;
  for (const m of MODES) expect(legForNewSession(m, s)).toBe("engine");
});

test("a winterLeg with only SOME modes leaves the others on the engine", () => {
  const s = settingsWith({ chat: true });
  expect(legForNewSession("chat", s)).toBe("winter");
  expect(legForNewSession("dispatch", s)).toBe("engine");
  expect(legForNewSession("code", s)).toBe("engine");
});

test("each mode's flag is read independently", () => {
  expect(legForNewSession("code", settingsWith({ code: true, chat: false }))).toBe("winter");
  expect(legForNewSession("chat", settingsWith({ code: true, chat: false }))).toBe("engine");
  const all = settingsWith({ code: true, dispatch: true, chat: true });
  for (const m of MODES) expect(legForNewSession(m, all)).toBe("winter");
});

test("only a literal true moves a session — a hand-edited truthy value does not", () => {
  // A user who wrote `"yes"` or `1` into settings.json must not have their sessions silently moved
  // onto a leg they did not ask for.
  for (const v of ["yes", 1, "true", {}, []] as unknown[]) {
    expect(legForNewSession("code", settingsWith({ code: v as boolean }))).toBe("engine");
  }
  expect(legForNewSession("code", settingsWith({ code: false }))).toBe("engine");
  expect(legForNewSession("code", settingsWith({ code: true }))).toBe("winter");
});
