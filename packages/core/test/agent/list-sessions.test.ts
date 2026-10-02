import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import {
  registerListSessionsTools,
  LIST_SESSIONS_MAX_ROWS,
  LIST_SESSIONS_QUERY_MAX_ROWS,
  LIST_SESSIONS_RECENT_COMPLETED_CHILDREN,
  LIST_SESSIONS_TOOL,
  type ListSessionsStore,
} from "../../src/agent/tools/list-sessions";
import { makeActivityDeriver } from "../../src/sessions/activity";
import { SessionStore } from "../../src/sessions/store";
import { parseSessionQuery, rankSessions, type QueryableSession } from "../../src/sessions/session-query";

// Dispatch's `list_sessions`, rebuilt (user ruling 2026-10-02): the default listing (active + background +
// the newest completed spawned sessions) and the free-form `query` across every session, with the
// edited-files index. Driven through the REAL ToolRegistry against a REAL SessionStore in a temp home,
// with the SAME `makeActivityDeriver` production binds; only the clock and the per-session last-event
// times are injected, so ordering and dates are deterministic.

/** A fixed local-time "now": Friday 2026-10-02 15:00. */
const NOW = new Date(2026, 9, 2, 15, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

const homes: string[] = [];
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const home = mkdtempSync(join(tmpdir(), "winter-list-sessions-"));
  homes.push(home);
  const store = new SessionStore(home);
  const registry = new ToolRegistry();
  const attached = new Set<string>();
  const running = new Map<string, number>();
  const lastTs = new Map<string, number>();
  const view: ListSessionsStore = {
    list: () => store.list(),
    lastEventTs: (id) => lastTs.get(id) ?? store.lastEventTs(id),
    transcriptPath: (id) => store.transcriptPath(id),
    editedFiles: (id) => store.editedFiles(id),
    firstMessage: (id) => store.firstMessage(id),
    editedFilesBackfilled: () => store.editedFilesBackfilled(),
    backfillEditedFiles: () => store.backfillEditedFiles(),
  };
  const derive = makeActivityDeriver({
    attachedCount: (id) => (attached.has(id) ? 1 : 0),
    turnRunning: (id) => running.has(id),
    bgWork: () => false,
    lastEventTs: (id) => view.lastEventTs(id),
  });
  registerListSessionsTools(registry, { store: view, derive, turnStartedAt: (id) => running.get(id), now: () => NOW });
  const call = (args: unknown) => registry.execute(LIST_SESSIONS_TOOL, args, { cwd: home, roots: [home], sessionId: "s_dispatch", mode: "dispatch" });
  /** A code session, optionally titled, with a first message, created/last-active at given times. */
  const session = (o: { title?: string; first?: string; cwd?: string; origin?: string; parent?: string; last?: number; mode?: "code" | "chat" | "dispatch" } = {}) => {
    const id = store.createSession("global", { cwd: o.cwd ?? home, mode: o.mode ?? "code", ...(o.origin ? { origin: o.origin } : {}), ...(o.parent ? { parentSessionId: o.parent } : {}) });
    if (o.title) store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: o.title });
    if (o.first) store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: o.first, clientName: "mac" });
    if (o.last !== undefined) lastTs.set(id, o.last);
    return id;
  };
  const edit = (id: string, path: string) =>
    store.append(id, { type: "tool_result", sessionId: id, threadId: "main", callId: `c-${Math.random()}`, output: "ok", isError: false, fileDiff: { path, added: 1, removed: 0, diffId: "d1" } });
  return { home, store, attached, running, lastTs, call, session, edit };
}

const rowsOf = (out: string) => out.split("\n").filter((l) => l.startsWith("s_"));

describe("list_sessions: the default listing", () => {
  test("shows active and background sessions and recent spawned ones — never chat, dispatch, idle or archived", async () => {
    const h = harness();
    const active = h.session({ title: "Attached" });
    h.attached.add(active);
    const bg = h.session({ title: "Running unattended" });
    h.running.set(bg, NOW - 125_000);
    const flagged = h.session({ title: "Flagged" });
    h.store.setBackgrounded(flagged, true);
    const idle = h.session({ title: "Idle one" });
    const archived = h.session({ title: "Archived one" });
    h.store.setArchived(archived, true);
    const chat = h.session({ mode: "chat" });
    h.attached.add(chat);
    const dispatch = h.session({ mode: "dispatch" });

    const res = await h.call({});
    expect(res.isError).toBe(false);
    const rows = rowsOf(res.output);
    expect(rows.find((l) => l.startsWith(active))).toContain(`${active} | active | code`);
    expect(rows.find((l) => l.startsWith(bg))).toContain("| background | code | running 125s |");
    expect(rows.find((l) => l.startsWith(flagged))).toContain("| background |");
    for (const hidden of [idle, archived, chat, dispatch]) expect(res.output).not.toContain(hidden);
    expect(res.output).toContain("2 other sessions (idle, archived) not listed — find one with query.");
    expect(res.output).toContain(h.store.transcriptPath(active));
    expect(res.output).toContain('"Attached"');
  });

  test(`inactive Dispatch-spawned sessions show as completed — the newest ${LIST_SESSIONS_RECENT_COMPLETED_CHILDREN} only`, async () => {
    const h = harness();
    const dispatch = h.session({ mode: "dispatch" });
    const kids = [1, 2, 3, 4, 5, 6].map((n) => h.session({ origin: "dispatch-child", parent: dispatch, title: `Kid ${n}`, last: at(2026, 10, n) }));
    const res = await h.call({});
    const rows = rowsOf(res.output);
    expect(rows.map((l) => l.split(" | ")[0])).toEqual([kids[5], kids[4], kids[3], kids[2]]);
    for (const l of rows) expect(l).toContain("| completed | code |");
    expect(res.output).toContain("older completed children");
    // A spawned session that is running shows by its live label, whatever its age.
    h.running.set(kids[0]!, NOW - 1000);
    expect(rowsOf((await h.call({})).output).some((l) => l.startsWith(`${kids[0]} | background`))).toBe(true);
  });

  test(`the listing is capped at ${LIST_SESSIONS_MAX_ROWS} with an explicit count — never a silent truncation`, async () => {
    const h = harness();
    for (let i = 0; i < LIST_SESSIONS_MAX_ROWS + 7; i++) h.store.setBackgrounded(h.session(), true);
    const res = await h.call({});
    expect(rowsOf(res.output).length).toBe(LIST_SESSIONS_MAX_ROWS);
    expect(res.output).toContain("(7 more active/background — narrow with query)");
  });

  test("nothing going on says so, and still counts what is hidden", async () => {
    const h = harness();
    h.session();
    const res = await h.call({});
    expect(res.output).toStartWith("no active, background or recently completed spawned sessions\n1 other session (idle, archived) not listed");
  });
});

describe("list_sessions: query", () => {
  test("finds the session that EDITED a file — by full path, ~ path, trailing path or file name — across idle and archived sessions", async () => {
    const h = harness();
    const editor = h.session({ title: "Tidy configs" });
    h.edit(editor, "/Users/someone/projects/winter/config.toml");
    h.store.setArchived(editor, true);
    const other = h.session({ title: "Something else" });
    h.edit(other, "/Users/someone/projects/other/config.yaml");
    for (const q of [
      "the session that edited /Users/someone/projects/winter/config.toml",
      "winter/config.toml",
      "config.toml",
    ]) {
      const res = await h.call({ query: q });
      const rows = rowsOf(res.output);
      expect(rows[0]).toStartWith(`${editor} | archived`);
      expect(rows[0]).toContain("matched: edited /Users/someone/projects/winter/config.toml");
      expect(res.output).not.toContain(other);
    }
  });

  test("words rank title over first message; an unmatched query says so", async () => {
    const h = harness();
    const byTitle = h.session({ title: "Fix login bug", last: at(2026, 9, 20) });
    const byFirst = h.session({ title: "Form work", first: "please look at the login form", last: at(2026, 9, 21) });
    h.session({ title: "Refactor reaper" });
    const res = await h.call({ query: "login" });
    expect(rowsOf(res.output).map((l) => l.split(" | ")[0])).toEqual([byTitle, byFirst]);
    expect(rowsOf(res.output)[0]).toContain("matched: title: login");
    expect(rowsOf(res.output)[1]).toContain("matched: first message: login");
    expect((await h.call({ query: "zebra quokka" })).output).toStartWith('no sessions matched "zebra quokka"');
  });

  test(`returns at most ${LIST_SESSIONS_QUERY_MAX_ROWS} matches, best first, and counts the rest`, async () => {
    const h = harness();
    for (let i = 0; i < LIST_SESSIONS_QUERY_MAX_ROWS + 3; i++) h.session({ title: `build fix ${i}` });
    const res = await h.call({ query: "build" });
    expect(rowsOf(res.output).length).toBe(LIST_SESSIONS_QUERY_MAX_ROWS);
    expect(res.output).toContain("(3 more matched — refine the query to reach them)");
  });

  test("the edited-files index is BACKFILLED once from logs written before it existed", async () => {
    const h = harness();
    const old = h.session({ title: "Legacy" });
    // Write an edit straight into the log, bypassing `append` (as a pre-index daemon left it), and drop the index rows.
    const ev = { type: "tool_result", sessionId: old, threadId: "main", callId: "x", output: "ok", isError: false, seq: 99, ts: at(2026, 9, 1), fileDiff: { path: "/srv/app/main.ts", added: 2, removed: 1, diffId: "d2" } };
    appendFileSync(h.store.transcriptPath(old), JSON.stringify(ev) + "\n");
    expect(h.store.editedFiles(old)).toEqual([]);
    expect(h.store.editedFilesBackfilled()).toBe(false);
    const res = await h.call({ query: "app/main.ts" });
    expect(rowsOf(res.output)[0]).toStartWith(old);
    expect(h.store.editedFiles(old)).toEqual(["/srv/app/main.ts"]);
    expect(h.store.editedFilesBackfilled()).toBe(true);
    expect(h.store.backfillEditedFiles()).toBe(0); // marked: never again
    // Live edits are indexed as they are appended.
    h.edit(old, "/srv/app/util.ts");
    expect(h.store.editedFiles(old)).toContain("/srv/app/util.ts");
    // A deleted session takes its index rows with it.
    h.store.deleteSession(old);
    expect(h.store.editedFiles(old)).toEqual([]);
  });
});

describe("session-query: the interpreter (pure, deterministic)", () => {
  const s = (id: string, o: Partial<QueryableSession>): QueryableSession => ({ sessionId: id, createdAt: o.createdAt ?? at(2026, 9, 1), lastEventTs: o.lastEventTs ?? at(2026, 9, 1), editedFiles: o.editedFiles ?? [], ...o });

  test("relative dates resolve against now, in local time", () => {
    const labels = (q: string) => parseSessionQuery(q, NOW).ranges.map((r) => [r.label, new Date(r.from).toDateString(), new Date(r.to).toDateString()]);
    expect(labels("yesterday")).toEqual([["yesterday", "Thu Oct 01 2026", "Fri Oct 02 2026"]]);
    expect(labels("today")).toEqual([["today", "Fri Oct 02 2026", "Sat Oct 03 2026"]]);
    expect(labels("last week")).toEqual([["last week", "Mon Sep 21 2026", "Mon Sep 28 2026"]]);
    expect(labels("this week")).toEqual([["this week", "Mon Sep 28 2026", "Mon Oct 05 2026"]]);
    expect(labels("monday")).toEqual([["monday", "Mon Sep 28 2026", "Tue Sep 29 2026"]]);
    expect(labels("on friday")).toEqual([["friday", "Fri Oct 02 2026", "Sat Oct 03 2026"]]);
    expect(labels("3 days ago")).toEqual([["3 days ago", "Tue Sep 29 2026", "Wed Sep 30 2026"]]);
    expect(labels("in september")).toEqual([["september", "Tue Sep 01 2026", "Thu Oct 01 2026"]]);
    expect(labels("2026-09-15")).toEqual([["2026-09-15", "Tue Sep 15 2026", "Wed Sep 16 2026"]]);
    expect(labels("last month")).toEqual([["last month", "Tue Sep 01 2026", "Thu Oct 01 2026"]]);
  });

  test("paths, words and filler are told apart", () => {
    const p = parseSessionQuery("the session that edited ~/projects/winter/config.toml about the reaper yesterday", NOW);
    expect(p.paths).toEqual([`${require("node:os").homedir()}/projects/winter/config.toml`]);
    expect(p.words).toEqual(["reaper"]);
    expect(p.ranges.map((r) => r.label)).toEqual(["yesterday"]);
  });

  test("a date query keeps only sessions whose span overlaps it; ranking is stable", () => {
    const sessions = [
      s("s_a", { title: "reaper", createdAt: at(2026, 9, 30), lastEventTs: at(2026, 10, 1, 9) }),
      s("s_b", { title: "reaper", createdAt: at(2026, 9, 20), lastEventTs: at(2026, 9, 22) }),
      s("s_c", { title: "other", createdAt: at(2026, 10, 1, 8), lastEventTs: at(2026, 10, 1, 20) }),
    ];
    expect(rankSessions(sessions, parseSessionQuery("yesterday", NOW)).map((r) => r.session.sessionId)).toEqual(["s_c", "s_a"]);
    const both = rankSessions(sessions, parseSessionQuery("reaper yesterday", NOW));
    expect(both.map((r) => [r.session.sessionId, r.why])).toEqual([
      ["s_a", ["active yesterday", "title: reaper"]],
      ["s_c", ["active yesterday"]],
      ["s_b", ["title: reaper"]],
    ]);
  });

  test("an exact edited path outranks a basename match and a cwd match", () => {
    const sessions = [
      s("s_base", { editedFiles: ["/elsewhere/config.toml"] }),
      s("s_exact", { editedFiles: ["/p/winter/config.toml"] }),
      s("s_cwd", { cwd: "/p/winter" }),
    ];
    // The file sits inside s_cwd's directory, so it is a (weaker) match too.
    expect(rankSessions(sessions, parseSessionQuery("/p/winter/config.toml", NOW)).map((r) => r.session.sessionId)).toEqual(["s_exact", "s_cwd"]);
    expect(rankSessions(sessions, parseSessionQuery("config.toml", NOW)).map((r) => r.session.sessionId).sort()).toEqual(["s_base", "s_exact"]);
    expect(rankSessions(sessions, parseSessionQuery("/p/winter", NOW)).map((r) => r.session.sessionId)).toEqual(["s_cwd"]);
  });
});

describe("the per-mode registry", () => {
  test("list_sessions is dispatch-only; manage_session no longer exists", () => {
    const registry = new ToolRegistry();
    registerListSessionsTools(registry, { store: { list: () => [], lastEventTs: () => 0, transcriptPath: () => "", editedFiles: () => [], firstMessage: () => undefined }, derive: () => undefined, turnStartedAt: () => undefined });
    expect(registry.namesForMode("dispatch").has(LIST_SESSIONS_TOOL)).toBe(true);
    expect(registry.namesForMode("code").has(LIST_SESSIONS_TOOL)).toBe(false);
    expect(registry.namesForMode("chat").has(LIST_SESSIONS_TOOL)).toBe(false);
    expect(registry.namesForMode("dispatch").has("manage_session")).toBe(false);
  });
});
