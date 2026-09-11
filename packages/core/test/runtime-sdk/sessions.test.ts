// G-13: the nine standalone session functions address NORMA's store, never Winter's.
//
// Every assertion here is against a temp home. The negative half is deliberately NOT "call the bare
// SDK function and watch it read `~/.winter`" — that would touch a real home, which the phase's own
// constraints forbid; it is "point WINTER_HOME somewhere else and prove the wrapper ignores it".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, getSessionMessages, listSessions, normaSessions } from "../../src/runtime-sdk/sessions";

/** The nine, by name (`sdk/src/index.ts:35`). The wrapper module must cover exactly these. */
const NINE = [
  "listSessions", "getSessionInfo", "getSessionMessages", "renameSession", "tagSession",
  "deleteSession", "forkSession", "listSubagents", "getSubagentMessages",
] as const;

let home: string;
let elsewhere: string;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "p8b-sessions-"));
  elsewhere = mkdtempSync(join(tmpdir(), "p8b-notnorma-"));
  envBefore = { NORMA_HOME: process.env.NORMA_HOME, NORMA_PROFILE: process.env.NORMA_PROFILE, WINTER_HOME: process.env.WINTER_HOME };
});
afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
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
  test("all nine are exported, and nothing else is bound", async () => {
    const bound = normaSessions(home);
    expect(Object.keys(bound).sort()).toEqual([...NINE].sort());
    const mod = await import("../../src/runtime-sdk/sessions");
    for (const name of NINE) expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
  });

  test("normaSessions(home) reads <home>/projects — the Norma-branded path", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello from norma");
    const listed = await normaSessions(home).listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    expect(listed[0]?.projectKey).toBe("-tmp-alpha");

    const info = await normaSessions(home).getSessionInfo("s_norma");
    expect(info.entryCount).toBe(1);
    const messages = await normaSessions(home).getSessionMessages("s_norma");
    expect(messages).toHaveLength(1);
  });

  // The BRAND half: with no explicit home, resolution goes through `NORMA_HOME` — the daemon's own
  // variable — because the brand said so. An unbranded call would have read `WINTER_HOME`/`~/.winter`.
  test("with no explicit home the brand resolves NORMA_HOME, and WINTER_HOME is ignored", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello from norma");
    seed(elsewhere, "-tmp-alpha", "s_winter", "hello from winter");
    process.env.NORMA_HOME = home;
    process.env.WINTER_HOME = elsewhere;
    delete process.env.NORMA_PROFILE;

    const listed = await listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    expect((await getSessionMessages("s_norma"))).toHaveLength(1);
    // And the Winter-homed session is invisible through these doors.
    await expect(getSessionInfo("s_winter")).rejects.toThrow();
  });

  test("an explicit winterHome still wins, and the brand is never overridable", async () => {
    seed(home, "-tmp-alpha", "s_norma", "hello");
    seed(elsewhere, "-tmp-beta", "s_other", "elsewhere");
    process.env.NORMA_HOME = elsewhere;
    // The caller named a home; it wins over the env the brand would have read.
    const listed = await listSessions({ winterHome: home });
    expect(listed.map((s) => s.sessionId)).toEqual(["s_norma"]);
    // And a bound set's home is a default, not a fence: a caller may still name another.
    expect((await normaSessions(home).listSessions({ winterHome: elsewhere })).map((s) => s.sessionId)).toEqual(["s_other"]);
  });
});
