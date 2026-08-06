/** Phase 3d Task 1 — the pure in-chat slash-command registry + runners. Each runner mirrors ONE
 *  main.ts subcommand route's client calls + output wording (cited in commands.ts per-runner);
 *  this file drives them through a fake `NormaClient` that only records calls + returns canned
 *  results, following app.test.tsx's `fakeClient()` precedent (recorded calls array, no real I/O)
 *  — except `/model`, which (like its main.ts route) never touches the client at all: it reads/
 *  writes `settings.json` directly under `NORMA_HOME` (an env var this suite points at a tmpdir
 *  per test so it never touches the real `~/.norma`). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMANDS, filterCommands, helpText, parseSlashInput, runCommand,
  type CommandCtx,
} from "../../src/tui/commands";
import type { ChoiceRequest } from "../../src/tui/choice-menu";
import { formatRoutineLine } from "../../src/routines-cli";
import { formatMemoryList } from "../../src/memory-cli";
import type { NormaClient } from "../../src/client";

// ---- fake client (mirrors test/tui/app.test.tsx's fakeClient — recorded calls, canned results) ----
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

function makeCtx(client: NormaClient, overrides: Partial<Omit<CommandCtx, "client" | "appendNote">> = {}) {
  const notes: string[] = [];
  const ctx: CommandCtx = {
    client,
    ...overrides, // optional callbacks (onCwdChanged, T5's onModelChanged) thread through
    sessionId: overrides.sessionId ?? "sess-1",
    cwd: overrides.cwd ?? "/work/dir",
    appendNote: (text: string) => notes.push(text),
  };
  return { ctx, notes };
}

describe("parseSlashInput", () => {
  test.each([
    ["/compact", { cmd: "compact", argText: "" }],
    ["/model gpt-5.6-luna", { cmd: "model", argText: "gpt-5.6-luna" }],
    ["/add-dir /tmp/foo --persist", { cmd: "add-dir", argText: "/tmp/foo --persist" }],
    ["  /status  ", { cmd: "status", argText: "" }],
    ["/bg peek abc123", { cmd: "bg", argText: "peek abc123" }],
  ])("%s -> %j", (input, expected) => {
    expect(parseSlashInput(input as string)).toEqual(expected as { cmd: string; argText: string });
  });

  test("non-slash text -> null", () => {
    expect(parseSlashInput("hello there")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });
});

describe("filterCommands", () => {
  test("prefix matches come before fuzzy matches, both in registry order", () => {
    // "s" is a prefix of "status", "sessions", "skills" (registry order: status, sessions, ...
    // skills — see COMMANDS below) and a fuzzy subsequence-only hit of "compact"? no — "compact"
    // has no "s". Use "c" instead: prefix of "compact", "cd"; fuzzy-only (contains "c" not at
    // start) of "mcp".
    const names = filterCommands("c").map((c) => c.name);
    const prefixNames = COMMANDS.filter((c) => c.name.startsWith("c")).map((c) => c.name);
    const fuzzyOnlyNames = COMMANDS.filter((c) => !c.name.startsWith("c") && c.name.includes("c")).map((c) => c.name);
    expect(names).toEqual([...prefixNames, ...fuzzyOnlyNames]);
  });

  test("empty query returns every command in registry order", () => {
    expect(filterCommands("").map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  test("no duplicates: a command matching both prefix and fuzzy appears once", () => {
    const names = filterCommands("s").map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("fuzzy subsequence: 'mp' matches 'mcp' (m...p) but not 'model' style prefix hits duplicated", () => {
    const names = filterCommands("mp").map((c) => c.name);
    expect(names).toContain("mcp");
  });

  test("no match -> empty array", () => {
    expect(filterCommands("zzzznotacommand")).toEqual([]);
  });
});

describe("runCommand — dispatch", () => {
  test("non-slash input returns false and never touches the client", () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    return runCommand(ctx, "just chatting").then((handled) => {
      expect(handled).toBe(false);
      expect(calls).toEqual([]);
      expect(notes).toEqual([]);
    });
  });

  test("unknown slash command -> note + handled (true)", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/nope");
    expect(handled).toBe(true);
    expect(notes).toEqual(["Unknown command: /nope — /help lists commands"]);
  });

  test("a runner that throws is caught — never crashes the shell", async () => {
    const { client } = makeClient({ compact: () => { throw new Error("boom"); } });
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/compact");
    expect(handled).toBe(true);
    expect(notes).toEqual(["/compact failed: boom"]);
  });
});

describe("helpText", () => {
  test("contains every command name and the full keybinding list", () => {
    const text = helpText();
    for (const c of COMMANDS) expect(text).toContain(`/${c.name}`);
    for (const key of [
      "enter send", "esc interrupt", "Esc-Esc clear", "shift+tab cycle modes", "history",
      "PgUp/PgDn scroll", "ctrl+u half-page up", "Home/End", "ctrl+o expand outputs",
      "ctrl+t tasks", "ctrl+a agents", "ctrl+c/ctrl+d", "/ commands", "@ files",
    ]) {
      expect(text).toContain(key);
    }
  });

  test("descriptions stay under 60 chars (registry contract)", () => {
    for (const c of COMMANDS) expect(c.description.length).toBeLessThanOrEqual(60);
  });
});

describe("runners — mirror main.ts's routes", () => {
  test("/help appends helpText() as one note, no client calls", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/help");
    expect(calls).toEqual([]);
    expect(notes).toEqual([helpText()]);
  });

  test("/compact — mirrors `case \"compact\"`: calls client.compact(sessionId), reports uptoSeq+chars", async () => {
    const { client, calls } = makeClient({ compact: () => ({ compacted: true, uptoSeq: 42, summaryChars: 900 }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/compact");
    expect(calls).toEqual([{ method: "compact", args: ["sess-9"] }]);
    expect(notes).toEqual(["compacted (through seq 42, 900 char summary)"]);
  });

  test("/compact — nothing to compact yet", async () => {
    const { client } = makeClient({ compact: () => ({ compacted: false, uptoSeq: 0, summaryChars: 0 }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/compact");
    expect(notes).toEqual(["nothing to compact yet"]);
  });

  test("/status — mirrors `case \"status\"`: calls daemonStatus, no-provider phrasing", async () => {
    const { client, calls } = makeClient({
      daemonStatus: () => ({ version: "0.0.1", uptimeMs: 61_000, socketPath: "/tmp/core.sock", provider: null, sessionsCount: 2, pluginsCount: 0 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/status");
    expect(calls).toEqual([{ method: "daemonStatus", args: [] }]);
    expect(notes[0]).toContain("norma-core v0.0.1");
    expect(notes[0]).toContain("1m 1s");
    expect(notes[0]).toContain("(none configured)");
    expect(notes[0]).toContain("sessions: 2");
    expect(notes[0]).toContain("plugins: 0");
  });

  test("/status — configured provider shows id (model)", async () => {
    const { client } = makeClient({
      daemonStatus: () => ({ version: "0.0.1", uptimeMs: 1000, socketPath: "/x", provider: { id: "codex-oauth", model: "gpt-5.6-sol" }, sessionsCount: 1, pluginsCount: 3 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/status");
    expect(notes[0]).toContain("codex-oauth (gpt-5.6-sol)");
  });

  test("/quota — mirrors `case \"quota\"`: ok state", async () => {
    const { client, calls } = makeClient({
      quotaState: () => ({ kind: "ok", inputTokens: 500, outputTokens: 12_400 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/quota");
    expect(calls).toEqual([{ method: "quotaState", args: [] }]);
    expect(notes).toEqual(["quota: ok 500 in / 12.4k out"]);
  });

  test("/quota — limited state includes resume phrasing", async () => {
    const { client } = makeClient({
      quotaState: () => ({ kind: "limited", resumeAt: 0, inputTokens: 0, outputTokens: 0 }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/quota");
    expect(notes[0]).toContain("limited (resumes");
  });

  test("/sessions — mirrors `case \"sessions\"`: one line per session", async () => {
    const { client, calls } = makeClient({
      listSessions: () => ({ sessions: [{ sessionId: "s1", scope: "global", lastSeq: 12, createdAt: 0 }, { sessionId: "s2", scope: "global", lastSeq: 3, createdAt: 0 }] }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(calls).toEqual([{ method: "listSessions", args: [] }]);
    expect(notes).toEqual(["s1 global · 12 events\ns2 global · 3 events"]);
  });

  test("/sessions — empty list note", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: [] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(notes).toEqual(["(no sessions)"]);
  });

  // Plan-immunity Task 2: the TUI is CODE-ONLY (mode×surface matrix) — /sessions is the resume
  // PICKER, so it HIDES non-code rows entirely rather than marking them (contrast `norma sessions`,
  // a plain inventory — see session-mode.ts's file doc). Absent mode = code (the R-slice
  // convention); "code" explicit also counts.
  test("/sessions — hides chat/dispatch/cowork rows, keeps absent-mode and explicit-code rows", async () => {
    const { client } = makeClient({
      listSessions: () => ({
        sessions: [
          { sessionId: "s1", scope: "global", lastSeq: 12, createdAt: 0 },
          { sessionId: "s2", scope: "global", lastSeq: 3, createdAt: 0, mode: "code" },
          { sessionId: "s3", scope: "global", lastSeq: 7, createdAt: 0, mode: "chat" },
          { sessionId: "s4", scope: "global", lastSeq: 1, createdAt: 0, mode: "dispatch" },
          { sessionId: "s5", scope: "global", lastSeq: 2, createdAt: 0, mode: "cowork" },
        ],
      }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(notes).toEqual(["s1 global · 12 events\ns2 global · 3 events"]);
  });

  test("/sessions — every visible row is non-code -> \"(no sessions)\", not a blank note", async () => {
    const { client } = makeClient({
      listSessions: () => ({ sessions: [{ sessionId: "s1", scope: "global", lastSeq: 1, createdAt: 0, mode: "chat" }] }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/sessions");
    expect(notes).toEqual(["(no sessions)"]);
  });

  test("/add-dir — mirrors `case \"add-dir\"`: path + persist flag forwarded", async () => {
    const { client, calls } = makeClient({ addDir: () => ["/a", "/b", "/c"] });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-5" });
    await runCommand(ctx, "/add-dir /some/path --persist");
    expect(calls).toEqual([{ method: "addDir", args: ["sess-5", "/some/path", true] }]);
    expect(notes).toEqual(["+ dir /some/path → 3 roots"]);
  });

  test("/add-dir — no persist flag defaults to false", async () => {
    const { client, calls } = makeClient({ addDir: () => ["/a"] });
    const { ctx } = makeCtx(client);
    await runCommand(ctx, "/add-dir /some/path");
    expect(calls).toEqual([{ method: "addDir", args: ["sess-1", "/some/path", false] }]);
  });

  test("/add-dir — missing path is a usage note, no client call", async () => {
    const { client, calls } = makeClient({ addDir: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/add-dir");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/cd — mirrors `case \"cd\"`: forwards sessionId + path, reports resolved cwd", async () => {
    const { client, calls } = makeClient({ setCwd: () => "/resolved/path" });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-7" });
    await runCommand(ctx, "/cd ../elsewhere");
    expect(calls).toEqual([{ method: "setCwd", args: ["sess-7", "../elsewhere"] }]);
    expect(notes).toEqual(["cwd → /resolved/path"]);
  });

  test("/cd — missing path is a usage note", async () => {
    const { client, calls } = makeClient({ setCwd: () => "" });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/cd");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/cd — fires onCwdChanged with the DAEMON-CONFIRMED cwd (T2 review item 3)", async () => {
    const { client } = makeClient({ setCwd: () => "/resolved/path" });
    const { ctx } = makeCtx(client);
    const seen: string[] = [];
    ctx.onCwdChanged = (newCwd: string) => seen.push(newCwd);
    await runCommand(ctx, "/cd ../elsewhere");
    expect(seen).toEqual(["/resolved/path"]); // the resolved path, never the raw "../elsewhere" arg
  });

  test("/skills — mirrors `case \"skills\"`: uses ctx.cwd, lists name/source/description", async () => {
    const { client, calls } = makeClient({ listSkills: () => [{ name: "brainstorm", description: "Explore ideas", source: "user", path: "/x" }] });
    const { ctx, notes } = makeCtx(client, { cwd: "/my/proj" });
    await runCommand(ctx, "/skills");
    expect(calls).toEqual([{ method: "listSkills", args: ["/my/proj"] }]);
    expect(notes).toEqual(["brainstorm (user) — Explore ideas"]);
  });

  test("/skills — none installed", async () => {
    const { client } = makeClient({ listSkills: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/skills");
    expect(notes).toEqual(["no skills installed"]);
  });

  test("/mcp — mirrors `case \"mcp\"`: uses ctx.cwd, lists status + namespaced tool names", async () => {
    const { client, calls } = makeClient({ listMcp: () => [{ name: "github", status: "connected", source: "user", toolNames: ["search", "get_file"] }] });
    const { ctx, notes } = makeCtx(client, { cwd: "/my/proj" });
    await runCommand(ctx, "/mcp");
    expect(calls).toEqual([{ method: "listMcp", args: ["/my/proj"] }]);
    expect(notes).toEqual(["github (user, connected) mcp__github__search, mcp__github__get_file"]);
  });

  test("/mcp — none configured", async () => {
    const { client } = makeClient({ listMcp: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/mcp");
    expect(notes).toEqual(["no MCP servers configured"]);
  });

  test("/bg (no args) — defaults to list, mirrors `bg list`", async () => {
    const { client, calls } = makeClient({ bgList: () => [{ taskId: "t1", status: "running", command: "npm test", exitCode: null, startedAt: 0 }] });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg");
    expect(calls).toEqual([{ method: "bgList", args: ["sess-3"] }]);
    expect(notes).toEqual(["t1 running · npm test"]);
  });

  test("/bg list — empty", async () => {
    const { client } = makeClient({ bgList: () => [] });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg list");
    expect(notes).toEqual(["(no bg tasks)"]);
  });

  test("/bg peek <taskId> — mirrors `bg peek`, includes chunk when present", async () => {
    const { client, calls } = makeClient({ bgPeek: () => ({ status: "running", exitCode: null, chunk: "hello output" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg peek t1");
    expect(calls).toEqual([{ method: "bgPeek", args: ["sess-3", "t1"] }]);
    expect(notes[0]).toContain("running exit=-");
    expect(notes[0]).toContain("hello output");
  });

  test("/bg peek — missing taskId is a usage note", async () => {
    const { client, calls } = makeClient({ bgPeek: () => ({}) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg peek");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/bg kill <taskId> — mirrors `bg kill`", async () => {
    const { client, calls } = makeClient({ bgKill: () => ({ ok: true }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-3" });
    await runCommand(ctx, "/bg kill t9");
    expect(calls).toEqual([{ method: "bgKill", args: ["sess-3", "t9"] }]);
    expect(notes).toEqual(["killed t9"]);
  });

  test("/bg bogus-sub — usage note, no client call", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/bg bogus");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  // Phase 5 routines T4: /routines is list-only (design doc §5 — create/delete/enable/disable
  // stay CLI/tool-only in v1). Mirrors main.ts `case "routines"`'s default (list) branch:
  // client.routinesList(), one line per routine via formatRoutineLine (routines-cli.ts).
  test("/routines — one line per routine, via formatRoutineLine", async () => {
    const routine = {
      id: "r_1", spec: "every 30m", prompt: "check the inbox", policy: "auto" as const,
      cwd: "/work", enabled: true, lastRunAt: null, nextRunAt: Date.UTC(2026, 6, 13), createdAt: 0,
      lastResult: null, deferAttempts: 0,
    };
    const { client, calls } = makeClient({ routinesList: () => ({ routines: [routine] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/routines");
    expect(calls).toEqual([{ method: "routinesList", args: [] }]);
    expect(notes).toEqual([formatRoutineLine(routine)]);
  });

  test("/routines — empty list note", async () => {
    const { client } = makeClient({ routinesList: () => ({ routines: [] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/routines");
    expect(notes).toEqual(["(no routines)"]);
  });

  test("/routines — multiple routines join with newlines, in list order", async () => {
    const r1 = {
      id: "r_1", spec: "every 30m", prompt: "check the inbox", policy: "auto" as const,
      cwd: "/work", enabled: true, lastRunAt: null, nextRunAt: Date.UTC(2026, 6, 13), createdAt: 0,
      lastResult: null, deferAttempts: 0,
    };
    const r2 = {
      id: "r_2", spec: "0 9 * * 1-5", prompt: "morning standup summary", policy: "plan" as const,
      cwd: "/work", enabled: false, lastRunAt: null, nextRunAt: Date.UTC(2026, 6, 14), createdAt: 0,
      lastResult: null, deferAttempts: 0,
    };
    const { client } = makeClient({ routinesList: () => ({ routines: [r1, r2] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/routines");
    expect(notes).toEqual([[formatRoutineLine(r1), formatRoutineLine(r2)].join("\n")]);
  });

  // Phase 5b Task 4: /memory is list-only, "user" scope (design doc §4 — write/delete stay
  // CLI/tool-only in v1, same precedent as /routines above). Mirrors main.ts `case "memory"`'s
  // default (no --project → "user" scope) list branch: client.memoryList("user"), formatted via
  // formatMemoryList (memory-cli.ts) — the exact plain content the CLI's colored list wraps
  // AQUA/DIM around.
  test("/memory — one line per fact, via formatMemoryList", async () => {
    const facts = [
      { name: "captain", description: "prefers concise replies", type: "user" },
      { name: "stack", description: "monorepo, bun workspaces", type: "project" },
    ];
    const { client, calls } = makeClient({ memoryList: () => ({ facts }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/memory");
    expect(calls).toEqual([{ method: "memoryList", args: ["user"] }]);
    expect(notes).toEqual([formatMemoryList(facts).join("\n")]);
  });

  test("/memory — empty list note", async () => {
    const { client } = makeClient({ memoryList: () => ({ facts: [] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/memory");
    expect(notes).toEqual(["(no memory facts)"]);
  });

  // CC-parity phase 3 (Workflows) Track C Task C4: /workflows mirrors `norma workflow`'s CLI shape
  // (main.ts `case "workflow"`, C3) — no-arg lists saved (WorkflowStore, via workflowList's
  // `.saved`) then running (`.running`) under a "running:" header; `run <name> [json]` / `stop
  // <runId>` mirror /bg's sub-token dispatch, forwarding to client.workflowRun/workflowStop.
  test("/workflows — lists saved workflows then running runs under a header", async () => {
    const saved = [{ name: "triage", description: "triage inbox", source: "user" }];
    const running = [{
      runId: "run_1", sessionId: "sess-1", name: "triage", status: "running" as const,
      counts: { running: 1, completed: 0, total: 2 }, startedAt: 0,
    }];
    const { client, calls } = makeClient({ workflowList: () => ({ saved, running }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-1", cwd: "/my/proj" });
    await runCommand(ctx, "/workflows");
    expect(calls).toEqual([{ method: "workflowList", args: ["sess-1", "/my/proj"] }]);
    expect(notes).toEqual(["triage (user) — triage inbox\nrunning:\nrun_1 triage · running"]);
  });

  test("/workflows list — the explicit sub-token lists identically to the bare form (mirrors /bg's default-to-list)", async () => {
    const saved = [{ name: "triage", description: "triage inbox", source: "user" }];
    const { client, calls } = makeClient({ workflowList: () => ({ saved, running: [] }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-1", cwd: "/my/proj" });
    await runCommand(ctx, "/workflows list");
    expect(calls).toEqual([{ method: "workflowList", args: ["sess-1", "/my/proj"] }]);
    expect(notes).toEqual(["triage (user) — triage inbox"]);
  });

  test("/workflows — an inline (unnamed) running run falls back to '(inline script)'", async () => {
    const running = [{
      runId: "run_2", sessionId: "sess-1", status: "running" as const,
      counts: { running: 1, completed: 0, total: 1 }, startedAt: 0,
    }];
    const { client } = makeClient({ workflowList: () => ({ saved: [], running }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows");
    expect(notes).toEqual(["running:\nrun_2 (inline script) · running"]);
  });

  test("/workflows — empty (no saved, no running) note", async () => {
    const { client } = makeClient({ workflowList: () => ({ saved: [], running: [] }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows");
    expect(notes).toEqual(["(no workflows)"]);
  });

  test("/workflows run <name> — mirrors the CLI's run route, reports the new runId", async () => {
    const { client, calls } = makeClient({ workflowRun: () => ({ runId: "run_9", status: "running" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-4" });
    await runCommand(ctx, "/workflows run triage");
    expect(calls).toEqual([{ method: "workflowRun", args: [{ sessionId: "sess-4", name: "triage", args: undefined }] }]);
    expect(notes).toEqual(["run_9 running"]);
  });

  test("/workflows run <name> <json> — JSON args are parsed and forwarded", async () => {
    const { client, calls } = makeClient({ workflowRun: () => ({ runId: "run_9", status: "running" }) });
    const { ctx } = makeCtx(client, { sessionId: "sess-4" });
    await runCommand(ctx, '/workflows run triage {"files":["a"]}');
    expect(calls).toEqual([{ method: "workflowRun", args: [{ sessionId: "sess-4", name: "triage", args: { files: ["a"] } }] }]);
  });

  test("/workflows run <name> <bad-json> — invalid JSON args is a note, no client call", async () => {
    const { client, calls } = makeClient({ workflowRun: () => ({ runId: "run_9", status: "running" }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows run triage {not-json}");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("invalid JSON args");
  });

  test("/workflows run — missing name is a usage note, no client call", async () => {
    const { client, calls } = makeClient({ workflowRun: () => ({ runId: "x", status: "running" }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows run");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/workflows stop <runId> — mirrors workflowStop, reports it stopped", async () => {
    const { client, calls } = makeClient({ workflowStop: () => ({ ok: true, stopped: true }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows stop run_9");
    expect(calls).toEqual([{ method: "workflowStop", args: ["run_9"] }]);
    expect(notes).toEqual(["stopped run_9"]);
  });

  test("/workflows stop <runId> — soft false (unknown/already-terminal) is reported, not an error", async () => {
    const { client } = makeClient({ workflowStop: () => ({ ok: true, stopped: false }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows stop run_stale");
    expect(notes).toEqual(["run_stale was not running"]);
  });

  test("/workflows stop — missing runId is a usage note, no client call", async () => {
    const { client, calls } = makeClient({ workflowStop: () => ({ ok: true, stopped: true }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows stop");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  test("/workflows bogus-sub — usage note, no client call", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/workflows bogus");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  // session-activity-hygiene T3: the two lifecycle verbs. Both drive the ONE `session.setActivity`
  // RPC against the CURRENT session, and both REPORT THE DAEMON'S DERIVED ANSWER rather than
  // restating the request — the whole reason that field is on the result. `off` is how the null
  // (clear-both-flags) half of the RPC is reachable from the shell at all.
  test("/background — sets the current session's activity, reports the DERIVED state back", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "background" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/background");
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "sess-9", activity: "background" }] }]);
    expect(notes).toEqual(["activity → background"]);
  });

  test("/archive — same shape, the archived value", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "archived" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/archive");
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "sess-9", activity: "archived" }] }]);
    expect(notes).toEqual(["activity → archived"]);
  });

  // activity-verb-semantics ruling 6: each toggle's OFF is the clear of ITS OWN flag, never the
  // other one's. `/background off` sends `unbackground`; `/archive off` sends `null` (RESUME), which
  // clears the archive bit only. Before this round both sent `null` and `null` cleared both, so
  // `/background off` on an archived session silently un-archived it and `/archive off` silently
  // un-backgrounded it — each toggle quietly answering a question the user did not ask.
  test("/background off — sends the unbackground CLEAR, not a resume", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "idle" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/background off");
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "sess-9", activity: "unbackground" }] }]);
    expect(notes).toEqual(["activity → idle"]);
  });

  test("/archive off — still sends null: resume is what un-archiving means everywhere", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "idle" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/archive off");
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "sess-9", activity: null }] }]);
    expect(notes).toEqual(["activity → idle"]);
  });

  test("/background on — the explicit form of the default", async () => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "background" }) });
    const { ctx } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/background on");
    expect(calls).toEqual([{ method: "sessionSetActivity", args: [{ sessionId: "sess-9", activity: "background" }] }]);
  });

  // The derived answer is NOT the value that was sent: clearing a session whose detached bash task
  // is still writing reads back "background". A runner that echoed its own request would print
  // "idle" here and quietly lie about what the daemon did.
  test("/background off — reports what the daemon DERIVED, not what was asked for", async () => {
    const { client } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "background" }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/background off");
    expect(notes).toEqual(["activity → background"]);
  });

  test.each(["/background bogus", "/archive nope"])("%s — usage note, no client call", async (input) => {
    const { client, calls } = makeClient({ sessionSetActivity: () => ({ ok: true, activity: "idle" }) });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, input as string);
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("usage:");
  });

  // A refused set (chat/dispatch target, or archiving a running turn) surfaces as runCommand's
  // standard failure note — the daemon's own message, never swallowed into a false success.
  test("/archive — a daemon refusal surfaces verbatim, not as a success note", async () => {
    const { client } = makeClient({
      sessionSetActivity: () => { throw new Error("stop or background it first"); },
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/archive");
    expect(notes).toEqual(["/archive failed: stop or background it first"]);
  });
});

// working-directories T7: `/dirs` family — bare `/dirs` reads the current session's row off
// `listSessions()` (the only surface `dirs` rides — no single-session `session.get`); the three
// mutating sub-verbs drive `sessionSetDirs` and display its POST-WRITE `dirs`, never an echo of the
// request (same contract `sessionSetActivity`'s `activity` follows above). Display: one line per
// entry, `*` marks the primary (position 0), `🔒` marks locked; an empty set prints the
// workdir-less notice naming `$OUTDIR` — never a blank note.
describe("/dirs — the working-directories family (working-directories T7)", () => {
  test("/dirs (bare) — prints the current session's set, * on the primary, 🔒 on locked entries", async () => {
    const { client, calls } = makeClient({
      listSessions: () => ({
        sessions: [
          { sessionId: "other", scope: "global", lastSeq: 1, createdAt: 0, dirs: [{ path: "/nope", locked: true }] },
          {
            sessionId: "sess-9",
            scope: "global",
            lastSeq: 5,
            createdAt: 0,
            dirs: [
              { path: "/repo/primary", locked: true },
              { path: "/repo/extra", locked: false },
            ],
          },
        ],
      }),
    });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs");
    expect(calls).toEqual([{ method: "listSessions", args: [] }]);
    expect(notes).toEqual(["* 🔒 /repo/primary\n    /repo/extra"]);
  });

  test("/dirs (bare) — an empty set prints the workdir-less notice naming $OUTDIR, never a blank note", async () => {
    const { client } = makeClient({
      listSessions: () => ({ sessions: [{ sessionId: "sess-9", scope: "global", lastSeq: 1, createdAt: 0, dirs: [] }] }),
    });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs");
    expect(notes.length).toBe(1);
    expect(notes[0]).not.toBe("");
    expect(notes[0]).toContain("$OUTDIR");
  });

  test("/dirs (bare) — current session absent from the list (edge case) is treated as workdir-less, not a crash", async () => {
    const { client } = makeClient({ listSessions: () => ({ sessions: [] }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs");
    expect(notes[0]).toContain("$OUTDIR");
  });

  test("/dirs add <path> — drives sessionSetDirs({op:'add'}), prints the resulting set", async () => {
    const { client, calls } = makeClient({
      sessionSetDirs: () => ({ ok: true, dirs: [{ path: "/repo", locked: true }, { path: "/tmp/extra", locked: false }] }),
    });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs add /tmp/extra");
    expect(calls).toEqual([{ method: "sessionSetDirs", args: [{ sessionId: "sess-9", op: "add", path: "/tmp/extra" }] }]);
    expect(notes).toEqual(["* 🔒 /repo\n    /tmp/extra"]);
  });

  test("/dirs primary <path> — drives sessionSetDirs({op:'setPrimary'})", async () => {
    const { client, calls } = makeClient({
      sessionSetDirs: () => ({ ok: true, dirs: [{ path: "/new/primary", locked: false }] }),
    });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs primary /new/primary");
    expect(calls).toEqual([{ method: "sessionSetDirs", args: [{ sessionId: "sess-9", op: "setPrimary", path: "/new/primary" }] }]);
    expect(notes).toEqual(["*   /new/primary"]);
  });

  test("/dirs remove <path> — drives sessionSetDirs({op:'remove'})", async () => {
    const { client, calls } = makeClient({
      sessionSetDirs: () => ({ ok: true, dirs: [{ path: "/repo", locked: true }] }),
    });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-9" });
    await runCommand(ctx, "/dirs remove /tmp/extra");
    expect(calls).toEqual([{ method: "sessionSetDirs", args: [{ sessionId: "sess-9", op: "remove", path: "/tmp/extra" }] }]);
    expect(notes).toEqual(["* 🔒 /repo"]);
  });

  test.each(["/dirs add", "/dirs primary", "/dirs remove", "/dirs bogus /some/path"])(
    "%s — usage note, no client call",
    async (input) => {
      const { client, calls } = makeClient({ sessionSetDirs: () => ({ ok: true, dirs: [] }) });
      const { ctx, notes } = makeCtx(client);
      await runCommand(ctx, input as string);
      expect(calls).toEqual([]);
      expect(notes[0]).toContain("usage:");
    },
  );

  // The manage_session precedent (see /archive above): a daemon refusal is left UNCAUGHT by the
  // runner and surfaces through runCommand's shared catch, verbatim — never re-worded, never
  // silently swallowed into a false success.
  test("/dirs add <path> — a daemon refusal surfaces verbatim, not as a success note", async () => {
    const { client } = makeClient({
      sessionSetDirs: () => { throw new Error("that directory can never be a working directory"); },
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/dirs add /etc");
    expect(notes).toEqual(["/dirs failed: that directory can never be a working directory"]);
  });

  test("/dirs primary <path> — the locked refusal surfaces verbatim", async () => {
    const { client } = makeClient({
      sessionSetDirs: () => { throw new Error("that directory is locked for this session"); },
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/dirs primary /repo/locked");
    expect(notes).toEqual(["/dirs failed: that directory is locked for this session"]);
  });

  test("/dirs remove <path> — the remove-primary refusal surfaces verbatim", async () => {
    const { client } = makeClient({
      sessionSetDirs: () => { throw new Error("the primary directory can't be removed — use setPrimary to replace it instead"); },
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/dirs remove /repo/primary");
    expect(notes).toEqual(["/dirs failed: the primary directory can't be removed — use setPrimary to replace it instead"]);
  });

  // `session.list` (bare `/dirs`'s only RPC) never throws DIRS_MODE_REFUSAL itself — that refusal
  // is `session.setDirs`'s own (a mode gate on the WRITE side); a non-participating row simply has
  // no `dirs` field at all, which the bare-read branch above already treats as workdir-less. The
  // mutating verbs are where this daemon message is actually reachable — pinned via `sessionSetDirs`
  // like the other refusals above.
  test("/dirs add <path> — the mode refusal (chat/dispatch target) surfaces verbatim", async () => {
    const { client } = makeClient({
      sessionSetDirs: () => { throw new Error("working directories apply to code and cowork sessions only"); },
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/dirs add /repo");
    expect(notes).toEqual(["/dirs failed: working directories apply to code and cowork sessions only"]);
  });
});

describe("runCommand — saved-workflow /name dispatch (CC-parity phase 3 Track C Task C4)", () => {
  test("/<savedName> (not a registered command) runs it via client.workflowRun, reports the runId", async () => {
    const { client, calls } = makeClient({ workflowRun: () => ({ runId: "run_7", status: "running" }) });
    const { ctx, notes } = makeCtx(client, { sessionId: "sess-2" });
    const handled = await runCommand(ctx, "/triage");
    expect(handled).toBe(true);
    expect(calls).toEqual([{ method: "workflowRun", args: [{ sessionId: "sess-2", name: "triage" }] }]);
    expect(notes).toEqual(["run_7 running"]);
  });

  test("/<name> that is NEITHER a registered command NOR a resolvable workflow falls through to the ordinary 'Unknown command' note", async () => {
    const { client, calls } = makeClient({
      workflowRun: () => { throw new Error("unknown workflow: reallynotarealworkflow (code -32004)"); },
    });
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/reallynotarealworkflow");
    expect(handled).toBe(true);
    expect(calls).toEqual([{ method: "workflowRun", args: [{ sessionId: "sess-1", name: "reallynotarealworkflow" }] }]);
    expect(notes).toEqual(["Unknown command: /reallynotarealworkflow — /help lists commands"]);
  });

  test("a registered command is NEVER shadowed by the workflow-name fallback, even if client.workflowRun is wired", async () => {
    const { client, calls } = makeClient({
      compact: () => ({ compacted: true, uptoSeq: 1, summaryChars: 10 }),
      workflowRun: () => ({ runId: "should-not-be-called", status: "running" }),
    });
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/compact");
    expect(calls).toEqual([{ method: "compact", args: ["sess-1"] }]);
    expect(notes).toEqual(["compacted (through seq 1, 10 char summary)"]);
  });

  test("a client exposing no workflowRun at all (e.g. a bare fake) still yields the plain 'Unknown command' note — same as pre-workflow behavior", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    const handled = await runCommand(ctx, "/nope");
    expect(handled).toBe(true);
    expect(notes).toEqual(["Unknown command: /nope — /help lists commands"]);
  });
});

describe("/model — mirrors `case \"model\"` (direct settings.json I/O under NORMA_HOME, no client)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "norma-cli-cmd-model-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    prevHome = process.env.NORMA_HOME;
    process.env.NORMA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORMA_HOME;
    else process.env.NORMA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("no args -> show, marks the active model, never touches the client", async () => {
    const { client, calls } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model");
    expect(calls).toEqual([]);
    expect(notes[0]).toContain("gpt-5.6-sol");
    expect(notes[0]).toContain("* gpt-5.6-sol");
    expect(notes[0]).toContain("gpt-5.6-terra");
  });

  test("a valid slug -> switches the model, mirrors the write-path note", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model gpt-5.6-luna");
    expect(notes[0]).toContain("model gpt-5.6-luna");
    expect(notes[0]).toContain("no daemon restart needed");

    const { ctx: ctx2, notes: notes2 } = makeCtx(client);
    await runCommand(ctx2, "/model");
    expect(notes2[0]).toContain("* gpt-5.6-luna");
  });

  test("an invalid slug -> validation note, no write", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model not-a-real-model");
    expect(notes[0]).toContain("invalid model");

    const { ctx: ctx2, notes: notes2 } = makeCtx(client);
    await runCommand(ctx2, "/model");
    expect(notes2[0]).toContain("gpt-5.6-sol"); // unchanged
  });

  test("--effort switches reasoning effort", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model --effort high");
    expect(notes[0]).toContain("effort high");
  });

  test("bad usage (--effort with no value) -> usage note", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/model --effort");
    expect(notes[0]).toContain("usage:");
  });

  // TUI renderer T5 — the status chrome's live model source: a SUCCESSFUL write reports the new
  // resolved global model+effort through `onModelChanged` (the same optional-callback shape as
  // `onCwdChanged`), so the App's footer flips the moment /model lands instead of showing the
  // mount-time snapshot forever.
  test("(T5) a successful switch fires onModelChanged with the new model AND effort", async () => {
    const { client } = makeClient({});
    const changes: Array<[string, string | undefined]> = [];
    const { ctx } = makeCtx(client, { onModelChanged: (m, e) => changes.push([m, e]) });
    await runCommand(ctx, "/model gpt-5.6-luna --effort high");
    expect(changes).toEqual([["gpt-5.6-luna", "high"]]);
  });

  test("(T5) an effort-only switch still reports both axes (model unchanged, new effort)", async () => {
    const { client } = makeClient({});
    const changes: Array<[string, string | undefined]> = [];
    const { ctx } = makeCtx(client, { onModelChanged: (m, e) => changes.push([m, e]) });
    await runCommand(ctx, "/model --effort medium");
    expect(changes).toEqual([["gpt-5.6-sol", "medium"]]);
  });

  test("(T5) show / invalid slug / usage error never fire onModelChanged (nothing changed)", async () => {
    const { client } = makeClient({});
    const changes: unknown[] = [];
    const { ctx } = makeCtx(client, { onModelChanged: (...a: unknown[]) => changes.push(a) });
    await runCommand(ctx, "/model");
    await runCommand(ctx, "/model not-a-real-model");
    await runCommand(ctx, "/model --effort");
    expect(changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bugfix-pass B2 — choice-shaped no-arg replies open the BOTTOM PICKER (`CommandCtx.openChoice`)
// instead of dumping the list into the transcript (the user-reported `/model` bug). The optional-
// callback discipline mirrors `onCwdChanged`/`onModelChanged`: a ctx WITHOUT `openChoice` (headless,
// every pre-B2 test above) keeps the historical transcript note byte-identical — those suites stay
// green untouched, which is itself the fallback pin.
// ---------------------------------------------------------------------------------------------

describe("B2 — /model (no args) opens the model picker when openChoice is wired", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "norma-cli-cmd-choice-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    prevHome = process.env.NORMA_HOME;
    process.env.NORMA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORMA_HOME;
    else process.env.NORMA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("opens ONE picker over the codex catalogue (current marked), appends NO note, never touches the client", async () => {
    const { client, calls } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/model");
    expect(calls).toEqual([]);
    expect(notes).toEqual([]); // the bug: this used to be the transcript dump
    expect(requests).toHaveLength(1);
    expect(requests[0]!.title).toContain("model");
    expect(requests[0]!.options.map((o) => o.value)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(requests[0]!.options.filter((o) => o.current).map((o) => o.value)).toEqual(["gpt-5.6-sol"]);
  });

  test("the effort knob stays direct-form-only — the picker title discloses it", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol", reasoningEffort: "high" } }));
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/model");
    expect(requests[0]!.title).toContain("effort: high");
    expect(requests[0]!.title).toContain("--effort");
  });

  test("onPick takes the SAME write path as `/model <slug>`: settings write + onModelChanged + the identical note", async () => {
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const changes: Array<[string, string | undefined]> = [];
    const { ctx, notes } = makeCtx(client, {
      openChoice: (r) => requests.push(r),
      onModelChanged: (m, e) => changes.push([m, e]),
    });
    await runCommand(ctx, "/model");
    await requests[0]!.onPick("gpt-5.6-luna");
    expect(changes).toEqual([["gpt-5.6-luna", undefined]]);
    expect(notes).toEqual(["updated (model gpt-5.6-luna) — takes effect next turn, no daemon restart needed"]);
    // The write really landed: a re-show marks luna as current.
    const requests2: ChoiceRequest[] = [];
    const { ctx: ctx2 } = makeCtx(client, { openChoice: (r) => requests2.push(r) });
    await runCommand(ctx2, "/model");
    expect(requests2[0]!.options.filter((o) => o.current).map((o) => o.value)).toEqual(["gpt-5.6-luna"]);
  });

  test("`/model <slug>` and `/model --effort <level>` (direct forms) NEVER open the picker", async () => {
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/model gpt-5.6-terra");
    await runCommand(ctx, "/model --effort medium");
    expect(requests).toEqual([]);
    expect(notes[0]).toContain("model gpt-5.6-terra");
    expect(notes[1]).toContain("effort medium");
  });

  test("a non-codex provider has no catalogue to pick from — falls back to the note even with openChoice wired", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "openai-compatible", model: "local-model", baseUrl: "http://localhost:1234/v1" } }));
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/model");
    expect(requests).toEqual([]);
    expect(notes).toEqual(["local-model"]);
  });
});

describe("B2 — /output-style (no args) opens the style picker when openChoice is wired", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "norma-cli-cmd-style-choice-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ schemaVersion: 2, provider: { type: "codex-oauth", model: "gpt-5.6-sol" } }));
    prevHome = process.env.NORMA_HOME;
    process.env.NORMA_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.NORMA_HOME;
    else process.env.NORMA_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("opens ONE picker over the resolvable styles (built-ins; current marked; descriptions as hints), no note", async () => {
    const { client, calls } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/output-style");
    expect(calls).toEqual([]);
    expect(notes).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.title).toContain("output style");
    const byValue = new Map(requests[0]!.options.map((o) => [o.value, o]));
    for (const name of ["default", "proactive", "explanatory", "learning"]) expect(byValue.has(name)).toBe(true);
    expect(requests[0]!.options.filter((o) => o.current).map((o) => o.value)).toEqual(["default"]);
    expect(byValue.get("proactive")!.hint).toBeTruthy(); // the description rides as the hint
  });

  test("onPick takes the SAME write path as `/output-style <name>`: settings.outputStyle set + the identical note", async () => {
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/output-style");
    await requests[0]!.onPick("explanatory");
    expect(notes).toEqual(["Output style set to: explanatory"]);
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { outputStyle?: string };
    expect(settings.outputStyle).toBe("explanatory");
  });

  test("`/output-style <name>` (direct form) NEVER opens the picker", async () => {
    const { client } = makeClient({});
    const requests: ChoiceRequest[] = [];
    const { ctx, notes } = makeCtx(client, { openChoice: (r) => requests.push(r) });
    await runCommand(ctx, "/output-style learning");
    expect(requests).toEqual([]);
    expect(notes).toEqual(["Output style set to: learning"]);
  });

  test("without openChoice the historical transcript list note is byte-identical (headless fallback)", async () => {
    const { client } = makeClient({});
    const { ctx, notes } = makeCtx(client);
    await runCommand(ctx, "/output-style");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("* default");
    expect(notes[0]).toContain("proactive");
  });
});
