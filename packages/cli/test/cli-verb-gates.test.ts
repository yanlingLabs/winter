import { describe, expect, test } from "bun:test";
import {
  runAddDirRoute, runBgKillRoute, runBgListRoute, runBgPeekRoute,
  runCdRoute, runCompactRoute, runInterruptRoute, runSteerRoute,
} from "../src/main";
import type { NormaClient } from "../src/client";

// Plan-immunity Task 2, fix round 1 (whole-branch review, Important): the send/watch/resume gate
// shipped in the first pass left EIGHT more session-targeted CLI verbs reaching chat/dispatch
// sessions with no check at all — add-dir, cd, steer, interrupt, compact, and bg's three sub-verbs
// (list/peek/kill). The reviewer proved this live against a real dev daemon (quoted in the ledger):
// `norma steer <chatSessionId> "..."` injected a real user_message into a chat session's JSONL;
// `norma steer <dispatchId> "..."` started a real dispatch turn from the terminal; `norma add-dir`/
// `norma cd` mutated a chat session's roots/cwd; `norma bg peek` read a chat session's task output
// into the terminal.
//
// Each verb's route logic is now extracted into its own testable function — client + params in, a
// plain discriminated result out (no console.log/process.exit inside) — mirroring tui/commands.ts's
// runner convention, so the gate is provable with a FAKE NormaClient (recorded calls, canned
// results — same double as tui/commands.test.ts's own `makeClient`) instead of only reachable by
// hand through a real CLI invocation against a real daemon (main.ts's `case` blocks stay thin,
// obviously-correct wrappers around these that print/exit on the result, unchanged in shape from
// before this fix).

type Impl = Record<string, (...args: unknown[]) => unknown>;

function makeClient(impl: Impl): { client: NormaClient; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const client: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(impl)) {
    client[name] = (...args: unknown[]) => {
      calls.push({ method: name, args });
      return Promise.resolve(fn(...args));
    };
  }
  return { client: client as unknown as NormaClient, calls };
}

const rows = [
  { sessionId: "s_code", scope: "global", lastSeq: 1, mode: "code" },
  { sessionId: "s_code_absent", scope: "global", lastSeq: 1 }, // absent mode = code too
  { sessionId: "s_chat", scope: "global", lastSeq: 5, mode: "chat" },
  { sessionId: "s_dispatch", scope: "global", lastSeq: 9, mode: "dispatch" },
];

describe("runAddDirRoute", () => {
  test("refuses a chat target — addDir is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), addDir: () => ["/x"] });
    const r = await runAddDirRoute(client, "s_chat", "/tmp", false);
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "addDir")).toBe(false);
  });

  test("refuses a dispatch target — addDir is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), addDir: () => ["/x"] });
    const r = await runAddDirRoute(client, "s_dispatch", "/tmp", false);
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "addDir")).toBe(false);
  });

  test("CONTROL: a code target proceeds — addDir fires, roots returned", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), addDir: () => ["/tmp", "/other"] });
    const r = await runAddDirRoute(client, "s_code", "/tmp", true);
    expect(r).toEqual({ ok: true, roots: ["/tmp", "/other"] });
    expect(calls).toEqual([{ method: "listSessions", args: [] }, { method: "addDir", args: ["s_code", "/tmp", true] }]);
  });
});

describe("runCdRoute", () => {
  test("refuses a chat target — setCwd is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), setCwd: () => "/tmp" });
    const r = await runCdRoute(client, "s_chat", "/tmp");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "setCwd")).toBe(false);
  });

  test("refuses a dispatch target — setCwd is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), setCwd: () => "/tmp" });
    const r = await runCdRoute(client, "s_dispatch", "/tmp");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "setCwd")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), setCwd: () => "/resolved" });
    const r = await runCdRoute(client, "s_code_absent", "/tmp");
    expect(r).toEqual({ ok: true, cwd: "/resolved" });
  });
});

describe("runSteerRoute — the reviewer's exact live repro (inject-text-into-session)", () => {
  test("refuses a chat target — steer is never called (no user_message injected)", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), steer: () => ({ injected: true }) });
    const r = await runSteerRoute(client, "s_chat", "do this instead");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "steer")).toBe(false);
  });

  test("refuses a dispatch target — steer is never called (no real dispatch turn started)", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), steer: () => ({ injected: false }) });
    const r = await runSteerRoute(client, "s_dispatch", "x");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "steer")).toBe(false);
  });

  test("CONTROL: a code target proceeds — steer fires", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), steer: () => ({ injected: true }) });
    const r = await runSteerRoute(client, "s_code", "keep going");
    expect(r).toEqual({ ok: true, injected: true });
    expect(calls).toEqual([{ method: "listSessions", args: [] }, { method: "steer", args: ["s_code", "keep going"] }]);
  });
});

describe("runInterruptRoute", () => {
  test("refuses a chat target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), interrupt: () => ({ wasRunning: true }) });
    const r = await runInterruptRoute(client, "s_chat");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "interrupt")).toBe(false);
  });

  test("refuses a dispatch target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), interrupt: () => ({ wasRunning: true }) });
    const r = await runInterruptRoute(client, "s_dispatch");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "interrupt")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), interrupt: () => ({ wasRunning: false }) });
    const r = await runInterruptRoute(client, "s_code");
    expect(r).toEqual({ ok: true, wasRunning: false });
  });
});

describe("runCompactRoute", () => {
  test("refuses a chat target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), compact: () => ({ compacted: true, uptoSeq: 9, summaryChars: 100 }) });
    const r = await runCompactRoute(client, "s_chat");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "compact")).toBe(false);
  });

  test("refuses a dispatch target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), compact: () => ({ compacted: true, uptoSeq: 9, summaryChars: 100 }) });
    const r = await runCompactRoute(client, "s_dispatch");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "compact")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), compact: () => ({ compacted: false, uptoSeq: 0, summaryChars: 0 }) });
    const r = await runCompactRoute(client, "s_code");
    expect(r).toEqual({ ok: true, compacted: false, uptoSeq: 0, summaryChars: 0 });
  });
});

describe("runBgListRoute", () => {
  test("refuses a chat target — bgList is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgList: () => [] });
    const r = await runBgListRoute(client, "s_chat");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "bgList")).toBe(false);
  });

  test("refuses a dispatch target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgList: () => [] });
    const r = await runBgListRoute(client, "s_dispatch");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "bgList")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const tasks = [{ taskId: "t1", command: "ls", status: "running", exitCode: null, startedAt: 0 }];
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), bgList: () => tasks });
    const r = await runBgListRoute(client, "s_code");
    expect(r).toEqual({ ok: true, tasks });
  });
});

describe("runBgPeekRoute — the reviewer's exact live repro (read chat output into the terminal)", () => {
  test("refuses a chat target — bgPeek is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgPeek: () => ({ chunk: "secret output", status: "running", exitCode: null }) });
    const r = await runBgPeekRoute(client, "s_chat", "t1");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "bgPeek")).toBe(false);
  });

  test("refuses a dispatch target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgPeek: () => ({ chunk: "x", status: "running", exitCode: null }) });
    const r = await runBgPeekRoute(client, "s_dispatch", "t1");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "bgPeek")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), bgPeek: () => ({ chunk: "hi", status: "done", exitCode: 0 }) });
    const r = await runBgPeekRoute(client, "s_code", "t1");
    expect(r).toEqual({ ok: true, chunk: "hi", status: "done", exitCode: 0 });
  });
});

describe("runBgKillRoute", () => {
  test("refuses a chat target — bgKill is never called", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgKill: () => ({ ok: true }) });
    const r = await runBgKillRoute(client, "s_chat", "t1");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
    expect(calls.some((c) => c.method === "bgKill")).toBe(false);
  });

  test("refuses a dispatch target", async () => {
    const { client, calls } = makeClient({ listSessions: () => ({ sessions: rows }), bgKill: () => ({ ok: true }) });
    const r = await runBgKillRoute(client, "s_dispatch", "t1");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
    expect(calls.some((c) => c.method === "bgKill")).toBe(false);
  });

  test("CONTROL: a code target proceeds", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: rows }), bgKill: () => ({ ok: true }) });
    const r = await runBgKillRoute(client, "s_code", "t1");
    expect(r).toEqual({ ok: true });
  });
});
