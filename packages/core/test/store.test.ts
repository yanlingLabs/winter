import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, appendFileSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store";

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "norma-store-"));
  return { store: new SessionStore(dir), dir };
}

describe("SessionStore", () => {
  test("createSession returns id, appends session_created with seq 1", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    expect(id).toMatch(/^s_[a-z0-9]+$/);
    const events = store.read(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session_created", seq: 1, sessionId: id, scope: "global" });
  });

  test("append assigns monotonic seq and stamps ts", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const e2 = store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    const e3 = store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "b", clientName: "t" });
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(e2.ts).toBeGreaterThan(0);
  });

  test("read(fromSeq) returns only later events", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "b", clientName: "t" });
    const tail = store.read(id, 2);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.seq).toBe(3);
  });

  test("list reflects scope and lastSeq", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "a", clientName: "t" });
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: id, scope: "global", lastSeq: 2 });
  });

  test("invalid scope rejected (path-safety)", () => {
    const { store } = makeStore();
    expect(() => store.createSession("../evil")).toThrow();
    expect(() => store.createSession("UPPER")).toThrow();
  });

  test("recovery: truncated tail line is discarded, store stays writable, index rebuilt", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "ok", clientName: "t" });
    store.close();
    // Simulate a crash mid-write:
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    appendFileSync(logPath, '{"type":"user_message","seq":3,"sessio'); // no newline, truncated
    const reopened = new SessionStore(dir);
    const events = reopened.read(id);
    expect(events).toHaveLength(2); // truncated line gone
    const e = reopened.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "after", clientName: "t" });
    expect(e.seq).toBe(3); // seq continues from last GOOD event
    expect(readFileSync(logPath, "utf8").endsWith("\n")).toBe(true);
  });

  test("corrupt MIDDLE line: events after it survive, file repaired", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "one", clientName: "t" });
    store.close();
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const withCorrupt = [lines[0]!, "GARBAGE {{{ not json", ...lines.slice(1)].join("\n") + "\n";
    writeFileSync(logPath, withCorrupt);
    const reopened = new SessionStore(dir);
    const events = reopened.read(id);
    expect(events).toHaveLength(2); // both good events preserved
    expect(events[1]!).toMatchObject({ type: "user_message", text: "one" });
    expect(readFileSync(logPath, "utf8")).not.toContain("GARBAGE");
    reopened.close();
  });

  test("clean logs are not rewritten on open (mtime preserved)", async () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.close();
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    const before = statSync(logPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    new SessionStore(dir).close();
    expect(statSync(logPath).mtimeMs).toBe(before);
  });

  test("index.db deletion: sessions rediscovered from logs", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "x", clientName: "t" });
    store.close();
    rmSync(join(dir, "sessions", "index.db"));
    // Also remove WAL/SHM files if present
    for (const ext of ["-wal", "-shm"]) {
      const f = join(dir, "sessions", "index.db" + ext);
      try { rmSync(f); } catch { /* ignore if not present */ }
    }
    const reopened = new SessionStore(dir);
    const rows = reopened.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: id, scope: "global", lastSeq: 2 });
    expect(reopened.read(id)).toHaveLength(2);
    reopened.close();
  });

  test("createSession persists cwd and approvalPolicy; meta() returns them", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj", approvalPolicy: "auto" });
    expect(store.meta(id)).toEqual({ sessionId: id, scope: "global", cwd: "/tmp/proj", approvalPolicy: "auto" });
    const plain = store.createSession("global");
    expect(store.meta(plain)).toMatchObject({ cwd: null, approvalPolicy: "ask" });
  });

  // Phase 5 routines T3 (design doc §3): additive session-meta `origin` — persisted at create,
  // round-trips through list(). Same "index-only metadata" class as cwd/approvalPolicy above
  // (not derived from the event log, unlike title/first_message) — so it resets on index loss,
  // covered by the next test.
  test("createSession persists origin; list() round-trips it; omitted origin is undefined (not null)", () => {
    const { store } = makeStore();
    const id = store.createSession("routine", { cwd: "/tmp/proj", approvalPolicy: "auto", origin: "routine/abc123" });
    expect(store.list().find((r) => r.sessionId === id)?.origin).toBe("routine/abc123");
    const plain = store.createSession("global");
    expect(store.list().find((r) => r.sessionId === plain)?.origin).toBeUndefined();
  });

  test("origin resets on index rebuild (index-only metadata, same precedent as cwd/approvalPolicy)", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("routine", { origin: "routine/abc123" });
    store.close();
    rmSync(join(dir, "sessions", "index.db"));
    const reopened = new SessionStore(dir);
    expect(reopened.list().find((r) => r.sessionId === id)?.origin).toBeUndefined();
    reopened.close();
  });

  test("meta survives index rebuild only for known columns", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/x", approvalPolicy: "auto" });
    store.close();
    rmSync(join(dir, "sessions", "index.db"));
    const reopened = new SessionStore(dir);
    // cwd/policy are index-only metadata: after index loss they reset to defaults (documented).
    expect(reopened.meta(id)).toMatchObject({ cwd: null, approvalPolicy: "ask" });
    reopened.close();
  });

  test("constructor throws if index.db path is unusable", () => {
    const { store, dir } = makeStore();
    store.close();
    // Corrupt the index db into a directory so re-open's ALTER hits a real (non-duplicate) error.
    const { rmSync, mkdirSync } = require("node:fs");
    rmSync(join(dir, "sessions", "index.db"), { force: true });
    mkdirSync(join(dir, "sessions", "index.db")); // a directory where sqlite expects a file
    expect(() => new SessionStore(dir)).toThrow(); // must surface, not silently swallow
  });

  test("migration ALTER rethrows a genuine (non-duplicate-column) ALTER failure", () => {
    const { store, dir } = makeStore();
    store.close();
    const dbPath = join(dir, "sessions", "index.db");
    rmSync(dbPath, { force: true });
    const { Database } = require("bun:sqlite");
    const oldDb = new Database(dbPath);
    // Pre-migration schema: no cwd/approval_policy columns, so CREATE TABLE IF NOT EXISTS
    // is a no-op on reopen and the ALTER must actually run (and fail against the read-only file).
    oldDb.run(`CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, scope TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL
    )`);
    oldDb.close();
    const { chmodSync } = require("node:fs");
    chmodSync(dbPath, 0o444);
    try {
      expect(() => new SessionStore(dir)).toThrow(/readonly database/);
    } finally {
      chmodSync(dbPath, 0o644); // restore so tmpdir cleanup doesn't hit EACCES
    }
  });

  test("setApprovalPolicy round-trips all three values (THE TRAP: plan must not read back as ask)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    for (const p of ["auto", "plan", "ask"] as const) {
      store.setApprovalPolicy(id, p);
      expect(store.meta(id).approvalPolicy).toBe(p);
    }
  });

  // Plan-immunity (2026-07-28, USER-REVISED design): chat's fixed internal policy "chat" is a
  // first-class SessionApprovalPolicy value (gate.ts) that session.create persists verbatim for
  // every chat-mode session (server.ts's create-seam coercion) — THE SAME TRAP as the test above,
  // just for the newest value: meta()'s own hardcoded recognized-values array must include "chat"
  // or a chat session's stored policy would silently round-trip back as "ask", quietly breaking the
  // "coerce, don't reject" creation story the moment anything re-reads it from the store.
  test("createSession/meta round-trip 'chat' verbatim (THE TRAP: chat must not read back as ask)", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { approvalPolicy: "chat" as any });
    expect(store.meta(id).approvalPolicy).toBe("chat");
  });

  test("createSession with plan", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { approvalPolicy: "plan" });
    expect(store.meta(id).approvalPolicy).toBe("plan");
  });

  test("setApprovalPolicy on unknown session throws", () => {
    const { store } = makeStore();
    expect(() => store.setApprovalPolicy("nope", "plan")).toThrow();
  });

  test("read returns fully-typed events without a second parse (behavior unchanged)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "one", clientName: "t" });
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "two", clientName: "t" });
    const all = store.read(id);
    const tail = store.read(id, all[0]!.seq);
    expect(all.map((e) => e.type)).toEqual(["session_created", "user_message", "user_message"]);
    expect(tail.every((e) => e.seq > all[0]!.seq)).toBe(true);
    expect(tail).toHaveLength(2);
  });

  test("lastSeq returns the current last persisted seq; throws on unknown session", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "norma-store-")));
    const id = store.createSession("global");
    expect(store.lastSeq(id)).toBe(1); // session_created
    store.append(id, { type: "user_message", sessionId: id, threadId: "main", text: "hi", clientName: "t" });
    expect(store.lastSeq(id)).toBe(2);
    expect(() => store.lastSeq("s_nope")).toThrow("unknown session");
  });

  test("session_titled append sets title; list() returns it; getTitle only sees generated", () => {
    const { store } = makeStore();
    const sid = store.createSession("global");
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "help me fix the login flow please\nsecond line", clientName: "t" });
    expect(store.getTitle(sid)).toBeNull();
    expect(store.list().find(r => r.sessionId === sid)!.title).toBe("help me fix the login flow please"); // fallback: first line, ≤60
    store.append(sid, { type: "session_titled", sessionId: sid, threadId: "main", title: "Fixing the login flow" });
    expect(store.getTitle(sid)).toBe("Fixing the login flow");
    expect(store.list().find(r => r.sessionId === sid)!.title).toBe("Fixing the login flow");
  });

  test("fallback truncates to 60 chars with ellipsis; no messages → undefined title", () => {
    const { store } = makeStore();
    const sid = store.createSession("global");
    expect(store.list().find(r => r.sessionId === sid)!.title).toBeUndefined();
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "x".repeat(80), clientName: "t" });
    expect(store.list().find(r => r.sessionId === sid)!.title).toBe("x".repeat(59) + "…");
  });

  test("index rebuild from logs restores title and first_message", () => {
    const { store, dir } = makeStore();
    const sid = store.createSession("global");
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "hello there", clientName: "t" });
    store.append(sid, { type: "session_titled", sessionId: sid, threadId: "main", title: "Greeting session" });
    store.close();
    rmSync(join(dir, "sessions", "index.db"));
    for (const ext of ["-wal", "-shm"]) {
      const f = join(dir, "sessions", "index.db" + ext);
      try { rmSync(f); } catch { /* ignore if not present */ }
    }
    const reopened = new SessionStore(dir);
    expect(reopened.list().find(r => r.sessionId === sid)!.title).toBe("Greeting session");
    reopened.close();
  });
});

// -----------------------------------------------------------------------------------------
// Plugin role tokens (Phase 4b Task 2, spec §3 "Plugin role tokens").
// -----------------------------------------------------------------------------------------
describe("SessionStore plugin tokens", () => {
  test("mint returns a 64-hex-char raw token; verify accepts it for the same id", () => {
    const { store } = makeStore();
    const raw = store.mintPluginToken("sample-echo");
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(store.verifyPluginToken("sample-echo", raw)).toBe(true);
  });

  test("verify rejects a wrong token, an unknown/never-minted plugin id, and id-bound cross-use", () => {
    const { store } = makeStore();
    const raw = store.mintPluginToken("sample-echo");
    expect(store.verifyPluginToken("sample-echo", "0".repeat(64))).toBe(false);
    expect(store.verifyPluginToken("never-minted", raw)).toBe(false);
    store.mintPluginToken("other-plugin");
    // A token minted for "sample-echo" must never verify for a DIFFERENT plugin id (id-bound).
    expect(store.verifyPluginToken("other-plugin", raw)).toBe(false);
  });

  test("re-minting rotates the token: the previously issued raw value no longer verifies", () => {
    const { store } = makeStore();
    const first = store.mintPluginToken("sample-echo");
    const second = store.mintPluginToken("sample-echo");
    expect(second).not.toBe(first);
    expect(store.verifyPluginToken("sample-echo", first)).toBe(false);
    expect(store.verifyPluginToken("sample-echo", second)).toBe(true);
  });

  test("revoke invalidates the token; verify fails closed after", () => {
    const { store } = makeStore();
    const raw = store.mintPluginToken("sample-echo");
    store.revokePluginToken("sample-echo");
    expect(store.verifyPluginToken("sample-echo", raw)).toBe(false);
  });

  test("revoking a never-minted plugin id is a no-op, not a throw", () => {
    const { store } = makeStore();
    expect(() => store.revokePluginToken("never-existed")).not.toThrow();
  });

  test("the sqlite row persists the HASH, never the raw token", () => {
    const { store, dir } = makeStore();
    const raw = store.mintPluginToken("sample-echo");
    const db = new Database(join(dir, "sessions", "index.db"));
    const row = db.query("SELECT token_hash FROM plugin_tokens WHERE plugin_id = ?").get("sample-echo") as { token_hash: string };
    expect(row.token_hash).not.toBe(raw);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  test("a minted token survives a store reopen (same homeDir)", () => {
    const { store, dir } = makeStore();
    const raw = store.mintPluginToken("sample-echo");
    store.close();
    const reopened = new SessionStore(dir);
    expect(reopened.verifyPluginToken("sample-echo", raw)).toBe(true);
    reopened.close();
  });
});
