import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";

function freshStore() { return new SessionStore(mkdtempSync(join(tmpdir(), "winter-test-"))); }

/** Deletes index.db (+ WAL/SHM sidecars) so the next `new SessionStore(dir)` must rebuild the
 *  index purely from the on-disk JSONL logs — same technique as store.test.ts's
 *  "index.db deletion" / "origin resets on index rebuild" tests. */
function loseIndex(dir: string): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try { rmSync(join(dir, "sessions", "index.db" + ext)); } catch { /* ignore if not present */ }
  }
}

describe("dispatch session store", () => {
  test("createSession persists mode and parentSessionId; list and meta carry them", () => {
    const store = freshStore();
    const d = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto", origin: "dispatch", mode: "dispatch" });
    const c = store.createSession("global", { cwd: "/tmp", approvalPolicy: "auto", origin: "dispatch-child", mode: "code", parentSessionId: d });
    const rows = store.list();
    expect(rows.find((r) => r.sessionId === d)?.mode).toBe("dispatch");
    expect(rows.find((r) => r.sessionId === c)?.parentSessionId).toBe(d);
    expect(store.meta(d).mode).toBe("dispatch");
    expect(store.meta(c).origin).toBe("dispatch-child");
    expect(store.meta(c).parentSessionId).toBe(d);
  });
  test("dispatchSessionId finds the singleton; childrenOf lists children", () => {
    const store = freshStore();
    expect(store.dispatchSessionId()).toBeUndefined();
    const d = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const c1 = store.createSession("global", { parentSessionId: d, origin: "dispatch-child" });
    store.createSession("global", {}); // unrelated
    expect(store.dispatchSessionId()).toBe(d);
    expect(store.childrenOf(d).map((r) => r.sessionId)).toEqual([c1]);
  });

  // THE INVARIANT (durability follow-up): dispatchSessionId()'s SELECT WHERE mode='dispatch' is
  // how session.dispatch's get-or-create finds the ONE permanent dispatch session. Before this
  // fix, a full index rebuild reset mode to NULL for every session, so the next session.dispatch
  // call would mint a SECOND dispatch session and orphan the original's whole conversation
  // history. mode now rides the session_created event (events.ts's SessionCreatedEvent), so
  // recoverAll's pass-2 INSERT can restore it.
  test("dispatch singleton survives a full index rebuild", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-test-"));
    const store = new SessionStore(dir);
    const d = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const codeSession = store.createSession("global", {}); // plain session, no mode option — absent means "code"
    store.close();
    loseIndex(dir);
    const reopened = new SessionStore(dir);
    expect(reopened.dispatchSessionId()).toBe(d);
    expect(reopened.meta(codeSession).mode).toBeUndefined();
    reopened.close();
  });

  test("old-format session_created (no mode field) rebuilds fine: mode NULL, no crash, no invention", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-test-"));
    const store = new SessionStore(dir);
    const id = store.createSession("global"); // creates the scope dir + a real log file
    store.close();
    // Overwrite with a hand-crafted log line shaped like an event recorded before this feature
    // existed: session_created present, but with no `mode` key at all (not even `mode: null`).
    const logPath = join(dir, "sessions", "global", `${id}.jsonl`);
    writeFileSync(logPath, JSON.stringify({ type: "session_created", seq: 1, sessionId: id, ts: Date.now(), scope: "global" }) + "\n");
    loseIndex(dir);
    const reopened = new SessionStore(dir);
    expect(reopened.list().find((r) => r.sessionId === id)?.mode).toBeUndefined();
    expect(reopened.dispatchSessionId()).toBeUndefined();
    reopened.close();
  });
});
