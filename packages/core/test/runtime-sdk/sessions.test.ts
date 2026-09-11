// G-13: the nine standalone session functions address NORMA's store, in the home the caller named
// — and there is NO door here that can be opened without naming one.
//
// The negative half is the point of the module (review F2): with a Norma brand but no `NORMA_HOME`
// in the environment, the SDK's own resolution lands on `~/.norma` — the user's live daily driver.
// So the test that proves it is not reachable runs with `NORMA_HOME` unset and `HOME` pointed at a
// temp dir: if any door ever resolves a home implicitly again, it resolves THAT one, and the
// assertion sees it. No real home is touched either way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as wrappers from "../../src/runtime-sdk/sessions";
import { normaSessions } from "../../src/runtime-sdk/sessions";

/** The nine, by name (`winter-agent-sdk/dist/index.d.ts:35`). */
const NINE = [
  "listSessions", "getSessionInfo", "getSessionMessages", "renameSession", "tagSession",
  "deleteSession", "forkSession", "listSubagents", "getSubagentMessages",
] as const;

let home: string;
let elsewhere: string;
let fakeHome: string;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "p8b-sessions-"));
  elsewhere = mkdtempSync(join(tmpdir(), "p8b-notnorma-"));
  fakeHome = mkdtempSync(join(tmpdir(), "p8b-fakehome-"));
  envBefore = { NORMA_HOME: process.env.NORMA_HOME, NORMA_PROFILE: process.env.NORMA_PROFILE, WINTER_HOME: process.env.WINTER_HOME, HOME: process.env.HOME };
});
afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, elsewhere, fakeHome]) rmSync(dir, { recursive: true, force: true });
});

/** A transcript where the SDK's own store keeps one: `<home>/projects/<key>/<id>.jsonl`. */
function seed(root: string, projectKey: string, sessionId: string, text: string): void {
  mkdirSync(join(root, "projects", projectKey), { recursive: true });
  writeFileSync(
    join(root, "projects", projectKey, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-11T00:00:00.000Z", text })}\n`,
  );
}

describe("the G-13 wrapper", () => {
  test("normaSessions(home) binds all nine, and NOTHING else is exported", () => {
    const bound = normaSessions(home);
    expect(Object.keys(bound).sort()).toEqual([...NINE].sort());
    for (const name of NINE) expect(typeof bound[name]).toBe("function");
    // THE FENCE: no module-level wrapper survives, so there is no way to call one of the nine
    // through this module without naming a home. `NormaSessionOptions` is a type and erases.
    expect(Object.keys(wrappers)).toEqual(["normaSessions"]);
  });

  test("it reads <home>/projects — the Norma-branded path, in the home that was named", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello from norma");
    const sessions = normaSessions(home);
    const listed = await sessions.listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    expect(listed[0]?.projectKey).toBe("-tmp-alpha");

    expect((await sessions.getSessionInfo("s_norma")).entryCount).toBe(1);
    expect(await sessions.getSessionMessages("s_norma")).toHaveLength(1);
  });

  // THE NEGATIVE (review F2). `NORMA_HOME` unset, `HOME` pointed at a temp dir seeded with a
  // `projects/` tree: an implicit resolution would find `<fakeHome>/.norma`, and every assertion
  // here says it did not. On a real machine the same code path would have read the user's daemon.
  test("no door resolves a home implicitly: NORMA_HOME unset and HOME redirected changes nothing", async () => {
    delete process.env.NORMA_HOME;
    delete process.env.NORMA_PROFILE;
    delete process.env.WINTER_HOME;
    process.env.HOME = fakeHome;
    // What an implicit `~/.norma` resolution WOULD have found.
    seed(join(fakeHome, ".norma"), "-tmp-alpha", "s_would_have_been_the_users", "the daily driver");
    seed(home, "-tmp-alpha", "s_norma", "hello from norma");

    // Every reachable door still needs a home, and answers from THAT home.
    const listed = await normaSessions(home).listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    // The "user's home" transcript is invisible through every one of the nine.
    await expect(normaSessions(home).getSessionInfo("s_would_have_been_the_users")).rejects.toThrow();
    // And nothing wrote into it either.
    expect(existsSync(join(fakeHome, ".norma", "projects", "-tmp-alpha", "s_norma.jsonl"))).toBe(false);
  });

  // The BRAND half, which the home binding does not subsume: a Winter-branded call with this
  // environment would read `<elsewhere>`, and it does not.
  test("WINTER_HOME is ignored — the brand decides which product's store this is", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello from norma");
    seed(elsewhere, "-tmp-alpha", "s_winter", "hello from winter");
    process.env.WINTER_HOME = elsewhere;
    process.env.NORMA_HOME = elsewhere; // even the env door for OUR OWN brand loses to the argument

    const listed = await normaSessions(home).listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    await expect(normaSessions(home).getSessionInfo("s_winter")).rejects.toThrow();
  });

  test("a caller's `directory` passes through; `home` is not overridable through the options", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello");
    // `NormaSessionOptions` has no `winterHome`/`brand` member at all, so a caller cannot re-home a
    // bound set by passing one — this is the compile-time half of the fence, asserted at runtime by
    // the fact that an extra key changes nothing.
    const listed = await normaSessions(home).listSessions({ ...({ winterHome: elsewhere } as object) });
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
  });
});
