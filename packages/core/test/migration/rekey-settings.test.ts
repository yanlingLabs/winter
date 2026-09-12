import { describe, expect, test } from "bun:test";
import { rekeySettings } from "../../src/migration/rekey-settings";
import { LEGACY_CLAUDE_EXECUTABLE_ENV, LEGACY_DEV_HOME_DIR, LEGACY_HOME_DIR, LEGACY_HOME_ENV, LEGACY_PROFILE_ENV, LEGACY_TMPDIR_ENV, LEGACY_WINTER_EXECUTABLE_ENV } from "../../src/legacy-names";

describe("rekeySettings", () => {
  test("rewrites every P9b-8 env-var token inside string values", () => {
    const input = {
      runtimes: {
        winterExecutable: `$${LEGACY_WINTER_EXECUTABLE_ENV}`,
        claudeExecutable: `$${LEGACY_CLAUDE_EXECUTABLE_ENV}`,
      },
      note: `set ${LEGACY_HOME_ENV} and ${LEGACY_PROFILE_ENV} and ${LEGACY_TMPDIR_ENV} before launch`,
    };
    const { out, changes } = rekeySettings(input);
    expect(out).toEqual({
      runtimes: { winterExecutable: "$WINTER_RUNTIME_EXECUTABLE", claudeExecutable: "$WINTER_CLAUDE_EXECUTABLE" },
      note: "set WINTER_HOME and WINTER_PROFILE and WINTER_TMPDIR before launch",
    });
    expect(changes.length).toBe(3);
    expect(changes.map((c) => c.path).sort()).toEqual(["note", "runtimes.claudeExecutable", "runtimes.winterExecutable"]);
  });

  test("rewrites legacy home path segments, dev before dist, without corrupting the -dev suffix", () => {
    const input = {
      a: `/Users/x/${LEGACY_DEV_HOME_DIR}/settings.json`,
      b: `/Users/x/${LEGACY_HOME_DIR}/settings.json`,
      c: `~/${LEGACY_DEV_HOME_DIR}`,
      d: `~/${LEGACY_HOME_DIR}`,
    };
    const { out } = rekeySettings(input) as { out: Record<string, string> };
    expect(out.a).toBe("/Users/x/.winter-dev/settings.json");
    expect(out.b).toBe("/Users/x/.winter/settings.json");
    expect(out.c).toBe("~/.winter-dev");
    expect(out.d).toBe("~/.winter");
  });

  test("does not rename keys, only rewrites values", () => {
    const input = { [LEGACY_HOME_ENV]: "unrelated value with no legacy tokens" };
    const { out } = rekeySettings(input) as { out: Record<string, string> };
    expect(Object.keys(out)).toEqual([LEGACY_HOME_ENV]);
    expect(out[LEGACY_HOME_ENV]).toBe("unrelated value with no legacy tokens");
  });

  test("leaves untouched values alone and reports no changes for them", () => {
    const input = { schemaVersion: 1, enabled: true, nested: { list: ["a", "b"], nil: null } };
    const { out, changes } = rekeySettings(input);
    expect(out).toEqual(input);
    expect(changes).toEqual([]);
  });

  test("array entries are addressed by index in the change path", () => {
    const input = { permissions: { allow: ["fine", `$${LEGACY_HOME_ENV}/tool`] } };
    const { changes } = rekeySettings(input);
    expect(changes).toEqual([{ path: "permissions.allow[1]", from: `$${LEGACY_HOME_ENV}/tool`, to: "$WINTER_HOME/tool" }]);
  });

  test("no-op round trip: re-running rekeySettings on already-rekeyed output makes no further changes", () => {
    const input = {
      runtimes: { winterExecutable: `$${LEGACY_WINTER_EXECUTABLE_ENV}` },
      path: `/Users/x/${LEGACY_HOME_DIR}/runtimes/bin`,
    };
    const once = rekeySettings(input);
    const twice = rekeySettings(once.out);
    expect(twice.changes).toEqual([]);
    expect(twice.out).toEqual(once.out);
  });

  test("a __proto__ key is never traversed (prototype-pollution guard, matches project-settings.ts)", () => {
    const input = JSON.parse(`{"__proto__": {"polluted": true}, "safe": "ok"}`);
    const { out } = rekeySettings(input) as { out: Record<string, unknown> };
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(out.safe).toBe("ok");
  });
});
