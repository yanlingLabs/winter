import { describe, expect, test } from "bun:test";
import { resolveWinterExecutable, WinterExecutableUnavailable } from "../../src/runtime-sdk/executable";

const exists = (set: string[]) => (p: string) => set.includes(p);
const base = { env: {}, execPath: "/bundle/Contents/MacOS/norma-core", home: "/tmp/h" };

describe("resolveWinterExecutable (P8b-2 ladder)", () => {
  test("setting wins over everything", () => {
    const r = resolveWinterExecutable({ ...base, setting: "/s/winter", env: { NORMA_WINTER_EXECUTABLE: "/e/winter" }, exists: exists(["/s/winter", "/e/winter"]) });
    expect(r).toEqual({ ok: true, path: "/s/winter", source: "setting" });
  });
  test("env beats bundle and home", () => {
    const r = resolveWinterExecutable({ ...base, env: { NORMA_WINTER_EXECUTABLE: "/e/winter" }, exists: exists(["/e/winter", "/bundle/Contents/MacOS/winter"]) });
    expect(r).toEqual({ ok: true, path: "/e/winter", source: "env" });
  });
  test("bundle sibling of execPath, then <home>/runtimes/bin/winter", () => {
    expect(resolveWinterExecutable({ ...base, exists: exists(["/bundle/Contents/MacOS/winter"]) })).toEqual({ ok: true, path: "/bundle/Contents/MacOS/winter", source: "bundle" });
    expect(resolveWinterExecutable({ ...base, exists: exists(["/tmp/h/runtimes/bin/winter"]) })).toEqual({ ok: true, path: "/tmp/h/runtimes/bin/winter", source: "home" });
  });
  test("a configured path that does not exist is NOT skipped silently — it is the failure", () => {
    const r = resolveWinterExecutable({ ...base, setting: "/gone/winter", exists: exists(["/bundle/Contents/MacOS/winter"]) });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toBeInstanceOf(WinterExecutableUnavailable); expect(r.error.code).toBe("winter_executable_unavailable"); expect(r.error.tried).toEqual(["/gone/winter"]); }
  });
  test("nothing found → typed failure listing every path tried, never a throw", () => {
    const r = resolveWinterExecutable({ ...base, exists: () => false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.tried).toEqual(["/bundle/Contents/MacOS/winter", "/tmp/h/runtimes/bin/winter"]);
  });
});
