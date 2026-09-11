// P8b Task 17 Step 4 — the engine is retired: `legForNewSession` answers `winter` for every mode,
// whatever `settings.runtimes.winterLeg` says. The block is ACCEPTED for one release (the
// `migrations.memoryKeys` pattern): a written `false` is reported (`winterLegDisabledKeys`) by
// settings-apply and the boot log, never obeyed.
import { expect, test } from "bun:test";
import { legForNewSession } from "../../src/runtime-sdk/leg";
import { winterLegDisabledKeys, winterOptionsFromSettings, type Settings } from "../../src/settings";

const MODES = ["code", "dispatch", "chat"] as const;
function settingsWith(leg: Partial<Record<"code" | "dispatch" | "chat", boolean>>): Settings {
  return { runtimes: { winterLeg: leg } } as unknown as Settings;
}

test("every mode is on the Winter leg with no settings at all", () => {
  for (const m of MODES) expect(legForNewSession(m, undefined)).toBe("winter");
  for (const m of MODES) expect(legForNewSession(m, null)).toBe("winter");
  for (const m of MODES) expect(legForNewSession(m, {} as Settings)).toBe("winter");
});

test("a runtimes block with NO winterLeg: every mode on the Winter leg", () => {
  const s = { runtimes: { retention: { deliveriesDays: 30, nameLeasesDays: 7 }, migrations: { memoryKeys: false } } } as unknown as Settings;
  for (const m of MODES) expect(legForNewSession(m, s)).toBe("winter");
});

test("a written `false` (or any hand-edited value) is IGNORED — the engine leg no longer exists", () => {
  for (const v of [false, "yes", 1, "true", {}, []] as unknown[]) {
    for (const m of MODES) expect(legForNewSession(m, settingsWith({ [m]: v as boolean }))).toBe("winter");
  }
  expect(winterOptionsFromSettings(settingsWith({ chat: false, code: false })).winterLeg).toEqual({ chat: true, dispatch: true, code: true });
});

test("winterLegDisabledKeys names exactly the keys a file sets to false — what the logs report", () => {
  expect(winterLegDisabledKeys(undefined)).toEqual([]);
  expect(winterLegDisabledKeys({} as Settings)).toEqual([]);
  expect(winterLegDisabledKeys(settingsWith({ chat: true }))).toEqual([]);
  expect(winterLegDisabledKeys(settingsWith({ chat: false, code: false }))).toEqual(["chat", "code"]);
  expect(winterLegDisabledKeys(settingsWith({ dispatch: false }))).toEqual(["dispatch"]);
});
