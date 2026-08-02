import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import {
  registerListSessionsTools,
  LIST_SESSIONS_MAX_ROWS,
  LIST_SESSIONS_TOOL,
  MANAGE_SESSION_TOOL,
} from "../../src/agent/tools/list-sessions";
import { makeActivityDeriver } from "../../src/sessions/activity";
import { ACTIVITY_MODE_REFUSAL } from "../../src/sessions/set-activity";
import type { SessionActivity } from "@norma/protocol";
import { SessionStore } from "../../src/sessions/store";

// session-activity-hygiene T8: dispatch's management surface — `list_sessions` (the read) and
// `manage_session` (the write). Driven through the REAL ToolRegistry (`execute`, the same door the
// engine calls) against a REAL SessionStore in a temp NORMA_HOME, with the SAME
// `makeActivityDeriver` production binds — no hand-rolled state machine anywhere in this file, so a
// derivation change shows up here as a behaviour change rather than being mirrored twice.

const NOW = 1_770_000_000_000;

interface Harness {
  registry: ToolRegistry;
  store: SessionStore;
  home: string;
  attached: Set<string>;
  running: Map<string, number>;
  bgWork: Set<string>;
  emitted: Array<{ sessionId: string; activity: SessionActivity | undefined }>;
  interrupted: string[];
  now: number;
  call(name: string, args: unknown): Promise<{ output: string; isError: boolean }>;
}

const homes: string[] = [];

function harness(opts: { scanBytesPerSession?: number; scanBytesTotal?: number } = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "norma-list-sessions-"));
  homes.push(home);
  const store = new SessionStore(home);
  const registry = new ToolRegistry();
  const h: Harness = {
    registry, store, home,
    attached: new Set(),
    running: new Map(),
    bgWork: new Set(),
    emitted: [],
    interrupted: [],
    now: NOW,
    call: (name, args) =>
      registry.execute(name, args, { cwd: home, roots: [home], sessionId: "s_dispatch", mode: "dispatch" }),
  };
  const derive = makeActivityDeriver({
    attachedCount: (id) => (h.attached.has(id) ? 1 : 0),
    turnRunning: (id) => h.running.has(id),
    bgWork: (id) => h.bgWork.has(id),
    lastEventTs: (id) => store.lastEventTs(id),
  });
  registerListSessionsTools(registry, {
    store,
    derive,
    turnStartedAt: (id) => h.running.get(id),
    now: () => h.now,
    isRunning: (id) => h.running.has(id),
    interrupt: (id) => { h.interrupted.push(id); },
    emit: (sessionId, activity) => { h.emitted.push({ sessionId, activity }); },
    scanBytesPerSession: opts.scanBytesPerSession,
    scanBytesTotal: opts.scanBytesTotal,
  });
  return h;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory that actually exists — `canonDir` realpaths what it can, and on macOS /var is a
 *  symlink to /private/var, so a fixture cwd must be compared through the same resolution. */
function realDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `norma-ls-${label}-`));
}

describe("list_sessions (T8): what it shows", () => {
  test("chat and dispatch sessions NEVER appear — cowork and code only", async () => {
    const h = harness();
    const code = h.store.createSession("global", { cwd: realDir("code"), mode: "code" });
    const legacy = h.store.createSession("global", { cwd: realDir("legacy") }); // no mode = code
    const chat = h.store.createSession("global", { cwd: realDir("chat"), mode: "chat" });
    const dispatch = h.store.createSession("global", { cwd: realDir("disp"), mode: "dispatch" });

    const res = await h.call(LIST_SESSIONS_TOOL, {});
    expect(res.isError).toBe(false);
    expect(res.output).toContain(code);
    expect(res.output).toContain(legacy);
    expect(res.output).not.toContain(chat);
    expect(res.output).not.toContain(dispatch);
  });

  test("a row carries id, state, mode, cwd, title and the transcript file", async () => {
    const h = harness();
    const cwd = realDir("row");
    const id = h.store.createSession("global", { cwd, mode: "code" });
    h.store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Fix the reaper" });

    const res = await h.call(LIST_SESSIONS_TOOL, {});
    expect(res.output).toContain(id);
    expect(res.output).toContain("idle");
    expect(res.output).toContain("code");
    expect(res.output).toContain(cwd);
    expect(res.output).toContain('"Fix the reaper"');
    expect(res.output).toContain(h.store.transcriptPath(id));
  });

  test("the STATE column appears only for type 'all' — a filtered listing does not repeat the state it was asked for", async () => {
    const h = harness();
    const id = h.store.createSession("global", { cwd: realDir("state"), mode: "code" });
    h.store.setBackgrounded(id, true);

    const all = await h.call(LIST_SESSIONS_TOOL, { type: "all" });
    expect(all.output).toContain(`${id} | background | code`);

    const filtered = await h.call(LIST_SESSIONS_TOOL, { type: "background" });
    expect(filtered.output).toContain(`${id} | code`);
    expect(filtered.output).not.toContain("| background |");
  });

  test("type filters by the DERIVED state, not by the stored flags", async () => {
    const h = harness();
    const idle = h.store.createSession("global", { cwd: realDir("idle"), mode: "code" });
    const active = h.store.createSession("global", { cwd: realDir("active"), mode: "code" });
    const bg = h.store.createSession("global", { cwd: realDir("bg"), mode: "code" });
    const archived = h.store.createSession("global", { cwd: realDir("arch"), mode: "code" });
    h.attached.add(active);
    // No stored flag at all: a turn running with nothing attached IS background (the invisible
    // runner this whole lifecycle exists to surface).
    h.running.set(bg, NOW - 42_000);
    h.store.setArchived(archived, true);

    for (const [type, want, notWant] of [
      ["idle", idle, active],
      ["active", active, idle],
      ["background", bg, idle],
      ["archived", archived, idle],
    ] as const) {
      const res = await h.call(LIST_SESSIONS_TOOL, { type });
      expect(res.output).toContain(want);
      expect(res.output).not.toContain(notWant);
    }
  });

  test("a running turn shows its duration; an idle session shows none", async () => {
    const h = harness();
    const runner = h.store.createSession("global", { cwd: realDir("dur"), mode: "code" });
    const quiet = h.store.createSession("global", { cwd: realDir("quiet"), mode: "code" });
    h.running.set(runner, NOW - 125_000);

    const res = await h.call(LIST_SESSIONS_TOOL, {});
    const runnerLine = res.output.split("\n").find((l) => l.startsWith(runner))!;
    const quietLine = res.output.split("\n").find((l) => l.startsWith(quiet))!;
    expect(runnerLine).toContain("running 125s");
    expect(quietLine).not.toContain("running");
  });

  test("rows are capped at 50 with an EXPLICIT count of the rest — never a silent truncation", async () => {
    const h = harness();
    const cwd = realDir("many");
    for (let i = 0; i < LIST_SESSIONS_MAX_ROWS + 7; i++) h.store.createSession("global", { cwd, mode: "code" });

    const res = await h.call(LIST_SESSIONS_TOOL, {});
    const rowLines = res.output.split("\n").filter((l) => l.startsWith("s_"));
    expect(rowLines.length).toBe(LIST_SESSIONS_MAX_ROWS);
    expect(res.output).toContain("7 more matched");
  });

  test("nothing matched says so", async () => {
    const h = harness();
    h.store.createSession("global", { cwd: realDir("none"), mode: "code" });
    const res = await h.call(LIST_SESSIONS_TOOL, { type: "archived" });
    expect(res.output).toBe("no sessions matched");
  });
});

describe("list_sessions (T8): cwd matching", () => {
  test("matches sessions AT the directory and UNDER it, and normalizes trailing slashes", async () => {
    const h = harness();
    const base = realDir("base");
    const child = join(base, "pkg", "core");
    mkdirSync(child, { recursive: true });
    const outside = realDir("outside");
    const atBase = h.store.createSession("global", { cwd: base, mode: "code" });
    const underBase = h.store.createSession("global", { cwd: child, mode: "code" });
    const elsewhere = h.store.createSession("global", { cwd: outside, mode: "code" });

    for (const probe of [base, `${base}/`, `${base}/pkg/..`]) {
      const res = await h.call(LIST_SESSIONS_TOOL, { cwd: probe });
      expect(res.output).toContain(atBase);
      expect(res.output).toContain(underBase);
      expect(res.output).not.toContain(elsewhere);
    }
  });

  test("maxDepth bounds how far BELOW the directory a session may sit (default is deep, 0 means exactly here)", async () => {
    const h = harness();
    const base = realDir("depth");
    const oneDown = join(base, "a");
    const threeDown = join(base, "a", "b", "c");
    mkdirSync(threeDown, { recursive: true });
    const atBase = h.store.createSession("global", { cwd: base, mode: "code" });
    const one = h.store.createSession("global", { cwd: oneDown, mode: "code" });
    const three = h.store.createSession("global", { cwd: threeDown, mode: "code" });

    const deep = await h.call(LIST_SESSIONS_TOOL, { cwd: base });
    expect(deep.output).toContain(three);

    const shallow = await h.call(LIST_SESSIONS_TOOL, { cwd: base, maxDepth: 1 });
    expect(shallow.output).toContain(atBase);
    expect(shallow.output).toContain(one);
    expect(shallow.output).not.toContain(three);

    const exact = await h.call(LIST_SESSIONS_TOOL, { cwd: base, maxDepth: 0 });
    expect(exact.output).toContain(atBase);
    expect(exact.output).not.toContain(one);
  });

  test("`~` is expanded, so a home-relative probe finds a home-relative session", async () => {
    const h = harness();
    const inHome = h.store.createSession("global", { cwd: process.env.HOME!, mode: "code" });
    const res = await h.call(LIST_SESSIONS_TOOL, { cwd: "~" });
    expect(res.output).toContain(inHome);
  });
});

describe("list_sessions (T8): the BOUNDED keyword scan", () => {
  const say = (store: SessionStore, id: string, text: string) =>
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text, clientName: "t" });

  test("matches ALL whitespace-separated terms, case-insensitively", async () => {
    const h = harness();
    const hit = h.store.createSession("global", { cwd: realDir("hit"), mode: "code" });
    const partial = h.store.createSession("global", { cwd: realDir("partial"), mode: "code" });
    const miss = h.store.createSession("global", { cwd: realDir("miss"), mode: "code" });
    say(h.store, hit, "the Reaper deletes empty SESSIONS");
    say(h.store, partial, "the reaper is asleep");
    say(h.store, miss, "nothing to see");

    const res = await h.call(LIST_SESSIONS_TOOL, { keywords: "REAPER sessions" });
    expect(res.output).toContain(hit);
    expect(res.output).not.toContain(partial);
    expect(res.output).not.toContain(miss);
  });

  test("the per-session budget is real: head and tail are scanned, the middle of a long transcript is not", async () => {
    // 1000 bytes per session, so 500 of head and 500 of tail of a ~4.5KB transcript.
    const h = harness({ scanBytesPerSession: 1000 });
    const id = h.store.createSession("global", { cwd: realDir("bounded"), mode: "code" });
    say(h.store, id, "OPENINGWORD");
    say(h.store, id, "x".repeat(2000) + "BURIEDWORD" + "y".repeat(2000));
    say(h.store, id, "CLOSINGWORD");

    expect((await h.call(LIST_SESSIONS_TOOL, { keywords: "OPENINGWORD" })).output).toContain(id);
    expect((await h.call(LIST_SESSIONS_TOOL, { keywords: "CLOSINGWORD" })).output).toContain(id);
    // Honest bound, not a silent one — the tool description states the cap.
    expect((await h.call(LIST_SESSIONS_TOOL, { keywords: "BURIEDWORD" })).output).toBe("no sessions matched");
  });

  test("when the TOTAL budget runs out the answer says how many sessions went unscanned", async () => {
    // Four ~1.2KB transcripts against a 2KB total budget: the two newest are scanned, the rest are
    // reported as unscanned rather than silently reported as non-matching.
    const h = harness({ scanBytesPerSession: 2000, scanBytesTotal: 2000 });
    const cwd = realDir("budget");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = h.store.createSession("global", { cwd, mode: "code" });
      say(h.store, id, "FINDME " + "z".repeat(1000));
      ids.push(id);
      Bun.sleepSync(12); // distinct mtimes: the scan order (newest first) is what the budget follows
    }

    const res = await h.call(LIST_SESSIONS_TOOL, { keywords: "FINDME" });
    expect(res.output).toMatch(/2 sessions were not scanned for keywords \(budget spent\)/);
    // Newest-first: the LAST sessions created are the ones the budget reached.
    expect(res.output).toContain(ids[3]!);
    expect(res.output).not.toContain(ids[0]!);
  });
});

describe("manage_session (T8): the write half, with session.setActivity's own semantics", () => {
  test("background / archive / resume drive the stored flags and ANNOUNCE the derived state", async () => {
    const h = harness();
    const id = h.store.createSession("global", { cwd: realDir("manage"), mode: "code" });

    const bg = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "background" });
    expect(bg.isError).toBe(false);
    expect(bg.output).toBe(`session '${id}' is now background`);
    expect(h.store.meta(id).backgrounded).toBe(true);
    expect(h.emitted.at(-1)).toEqual({ sessionId: id, activity: "background" });

    const arch = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "archive" });
    expect(arch.output).toBe(`session '${id}' is now archived`);
    expect(h.store.meta(id).archived).toBe(true);
    // Independent columns: archiving leaves the background flag alone.
    expect(h.store.meta(id).backgrounded).toBe(true);
    expect(h.emitted.at(-1)).toEqual({ sessionId: id, activity: "archived" });

    const resumed = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "resume" });
    expect(resumed.output).toBe(`session '${id}' is now idle`);
    expect(h.store.meta(id).archived).toBeUndefined();
    expect(h.store.meta(id).backgrounded).toBeUndefined();
    expect(h.emitted.at(-1)).toEqual({ sessionId: id, activity: "idle" });
  });

  test("background on an ARCHIVED session un-archives it (the target names a STATE, not a flag)", async () => {
    const h = harness();
    const id = h.store.createSession("global", { cwd: realDir("unarchive"), mode: "code" });
    h.store.setArchived(id, true);

    const res = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "background" });
    expect(res.output).toBe(`session '${id}' is now background`);
    expect(h.store.meta(id).archived).toBeUndefined();
  });

  test("archiving a RUNNING session is refused with the same two ways out the RPC names", async () => {
    const h = harness();
    const id = h.store.createSession("global", { cwd: realDir("running"), mode: "code" });
    h.running.set(id, NOW - 1000);

    const res = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "archive" });
    expect(res.isError).toBe(true);
    expect(res.output).toBe("stop or background it first");
    expect(h.store.meta(id).archived).toBeUndefined();
    expect(h.emitted).toHaveLength(0);
    // Backgrounding a running session is the whole point of that flag — never refused.
    const bg = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "background" });
    expect(bg.isError).toBe(false);
  });

  test("chat and dispatch targets are refused for EVERY action — including the coordinator's own session", async () => {
    const h = harness();
    const chat = h.store.createSession("global", { cwd: realDir("chat2"), mode: "chat" });
    const dispatch = h.store.createSession("global", { cwd: realDir("disp2"), mode: "dispatch" });
    h.running.set(dispatch, NOW - 10_000);

    for (const target of [chat, dispatch]) {
      for (const action of ["stop", "background", "archive", "resume"] as const) {
        const res = await h.call(MANAGE_SESSION_TOOL, { sessionId: target, action });
        expect(res.isError).toBe(true);
        expect(res.output).toBe(ACTIVITY_MODE_REFUSAL);
      }
    }
    expect(h.interrupted).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
  });

  test("an unknown session is UNKNOWN, never a state refusal", async () => {
    const h = harness();
    for (const action of ["stop", "background", "archive", "resume"] as const) {
      const res = await h.call(MANAGE_SESSION_TOOL, { sessionId: "s_nope", action });
      expect(res.isError).toBe(true);
      expect(res.output).toMatch(/unknown session/);
    }
  });

  test("stop aborts a running turn through the engine's own interrupt, and is a no-op message when nothing runs", async () => {
    const h = harness();
    const id = h.store.createSession("global", { cwd: realDir("stop"), mode: "code" });

    const quiet = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "stop" });
    expect(quiet.isError).toBe(false);
    expect(quiet.output).toMatch(/no turn running/);
    expect(h.interrupted).toHaveLength(0);

    h.running.set(id, NOW - 5_000);
    const stopped = await h.call(MANAGE_SESSION_TOOL, { sessionId: id, action: "stop" });
    expect(stopped.isError).toBe(false);
    expect(h.interrupted).toEqual([id]);
    // Stopping is not archiving: no flag is written, nothing is announced.
    expect(h.store.meta(id).archived).toBeUndefined();
    expect(h.emitted).toHaveLength(0);
  });
});

describe("the per-mode registry (T8)", () => {
  test("both tools are dispatch-only — declared, not inherited", async () => {
    const h = harness();
    for (const name of [LIST_SESSIONS_TOOL, MANAGE_SESSION_TOOL]) {
      expect(h.registry.namesForMode("dispatch").has(name)).toBe(true);
      expect(h.registry.namesForMode("code").has(name)).toBe(false);
      expect(h.registry.namesForMode("chat").has(name)).toBe(false);
    }
  });
});
