// A1 fix round: the rule `login-shell-path.ts` states — a spawn that needs the user's tools must pass
// an env derived from `process.env` AT SPAWN TIME, because under Bun a spawn without an `env` keeps
// the process's ORIGINAL environment after `process.env.PATH` changes. `buildChildEnv` is how the
// Winter child (and through it its Bash tool and stdio MCP servers) gets PATH, so it must read
// `process.env.PATH` when it is CALLED, never a copy cached at module load.
import { afterEach, describe, expect, test } from "bun:test";
import { buildChildEnv, type WinterOptionsInput } from "../../src/runtime-sdk/mode-options";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

describe("buildChildEnv — PATH is read from process.env at call time", () => {
  test("a PATH change after module load (the boot-time login-shell merge) reaches the next child", () => {
    const input = { home: "/tmp/winter-child-env-test-home", model: "codex-oauth/gpt-5.6-terra" } as unknown as WinterOptionsInput;
    process.env.PATH = "/usr/bin:/bin";
    expect(buildChildEnv(input).PATH).toBe("/usr/bin:/bin");
    process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
    expect(buildChildEnv(input).PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });
});
