import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { canonicalizeDirPath, type SessionDirs } from "../../src/sessions/dirs";

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "norma-dirs-store-"));
  return { store: new SessionStore(dir), dir };
}

/** working-directories T6: `createSession` now writes the `dirs` column DIRECTLY at INSERT time
 *  (see its own doc comment), so a row it produces is never NULL to begin with — the lazy
 *  migration `SessionStore.dirs()` implements is reachable only by a row that predates T6 (or one
 *  a full index.db rebuild reset). This forces that shape by hand: a second sqlite connection to
 *  the SAME index.db, NULLing the column back out. Mirrors this file's own malformed-JSON pin
 *  below (raw sqlite UPDATE) and store.test.ts's plugin-token test (a second connection alongside
 *  a still-open store, safe for a synchronous, non-concurrent write like this one). */
function forcePreBranchRow(dir: string, sessionId: string): void {
  const raw = new Database(join(dir, "sessions", "index.db"));
  raw.run("UPDATE sessions SET dirs = NULL WHERE session_id = ?", [sessionId]);
  raw.close();
}

// -----------------------------------------------------------------------------------------
// working-directories T1: the `dirs` column + lazy migration inside the getter. T6 (below) makes
// `createSession` write this column directly, so every test in THIS describe block now forces a
// genuinely pre-branch row by hand (`forcePreBranchRow`) rather than relying on a plain
// `createSession` call to leave it NULL — see the pinned create-time behavior in the T6 describe
// block further down for the shape a FRESH row actually gets.
// -----------------------------------------------------------------------------------------
describe("SessionStore.dirs — lazy migration (pre-branch rows only, post-T6)", () => {
  test("cwd-bearing pre-branch row: dirs() derives a single GRANDFATHERED LOCKED primary", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    forcePreBranchRow(dir, id);
    expect(store.dirs(id)).toEqual([{ path: "/tmp/proj", locked: true }]);
  });

  test("cwd-less pre-branch row: dirs() derives an empty (workdir-less) set", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global");
    forcePreBranchRow(dir, id);
    expect(store.dirs(id)).toEqual([]);
  });

  test("already-written dirs JSON is parsed and returned verbatim (not re-derived from cwd)", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    const written: SessionDirs = [
      { path: "/tmp/proj", locked: true },
      { path: "/tmp/added", locked: false },
    ];
    store.setDirsRaw(id, written);
    expect(store.dirs(id)).toEqual(written);
  });

  test("malformed JSON in the dirs column falls back to the cwd derivation and logs once", () => {
    const { store, dir } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    store.close();
    const raw = new Database(join(dir, "sessions", "index.db"));
    raw.run("UPDATE sessions SET dirs = ? WHERE session_id = ?", ["{not valid json", id]);
    raw.close();
    const reopened = new SessionStore(dir);
    const originalError = console.error;
    let calls = 0;
    console.error = (...args: unknown[]) => { calls++; originalError(...args); };
    try {
      expect(reopened.dirs(id)).toEqual([{ path: "/tmp/proj", locked: true }]);
      expect(reopened.dirs(id)).toEqual([{ path: "/tmp/proj", locked: true }]); // second call: still falls back
      expect(calls).toBe(1); // logged ONCE, not once per call
    } finally {
      console.error = originalError;
    }
    reopened.close();
  });

  test("dirs() throws on an unknown session (the setModel/setApprovalPolicy precedent)", () => {
    const { store } = makeStore();
    expect(() => store.dirs("s_nope")).toThrow("unknown session");
  });
});

// -----------------------------------------------------------------------------------------
// working-directories T6 (spec §1/§4, "the create doors write the column at birth"): every row
// `createSession` produces from here on has a non-null `dirs` column from its very first INSERT —
// no lazy migration involved, this is the ACTUAL create-time write, pinned directly.
// -----------------------------------------------------------------------------------------
describe("SessionStore.createSession — writes dirs directly at birth (T6)", () => {
  test("a cwd becomes an UNLOCKED primary — deliberately NOT the migration's grandfathered-LOCKED shape", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    expect(store.dirs(id)).toEqual([{ path: "/tmp/proj", locked: false }]);
  });

  test("no cwd becomes [] explicitly — the same value the lazy migration would have derived, written up front instead of deferred", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    expect(store.dirs(id)).toEqual([]);
  });

  test("cwd is stored VERBATIM in dirs[0], matching the cwd column exactly — alias parity (T3) holds by construction, no second canonicalization pass", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "~/not-canonicalized" });
    expect(store.dirs(id)).toEqual([{ path: "~/not-canonicalized", locked: false }]);
    expect(store.meta(id).cwd).toBe("~/not-canonicalized");
    expect(store.dirs(id)[0]?.path).toBe(store.meta(id).cwd ?? undefined);
  });
});

describe("SessionStore.setDirsRaw", () => {
  test("round-trips a written SessionDirs array exactly", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const dirs: SessionDirs = [
      { path: "/a", locked: false },
      { path: "/b", locked: true },
    ];
    store.setDirsRaw(id, dirs);
    expect(store.dirs(id)).toEqual(dirs);
  });

  test("round-trips an explicit empty array (workdir-less by deliberate write, distinct from NULL)", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    store.setDirsRaw(id, []);
    expect(store.dirs(id)).toEqual([]); // NOT re-derived from cwd — an explicit [] was written
  });

  test("does NOT touch the cwd column", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    store.setDirsRaw(id, [{ path: "/elsewhere", locked: true }]);
    expect(store.meta(id).cwd).toBe("/tmp/proj");
  });

  test("throws on an unknown session", () => {
    const { store } = makeStore();
    expect(() => store.setDirsRaw("s_nope", [])).toThrow("unknown session");
  });
});

// -----------------------------------------------------------------------------------------
// working-directories T1: canonicalizeDirPath.
// -----------------------------------------------------------------------------------------
describe("canonicalizeDirPath", () => {
  test("tilde forms: ~ and ~/ expand to the real home directory", () => {
    const home = realpathSync(homedir());
    expect(canonicalizeDirPath("~")).toBe(home);
    expect(canonicalizeDirPath("~/")).toBe(home);
  });

  test("symlinked spellings resolve to the same canonical path", () => {
    const base = mkdtempSync(join(tmpdir(), "norma-dirs-canon-"));
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(canonicalizeDirPath(link)).toBe(canonicalizeDirPath(real));
    expect(canonicalizeDirPath(link)).toBe(realpathSync(real));
  });

  test("not-yet-existing leaf under an existing parent: realpaths the parent, rejoins the leaf", () => {
    const base = mkdtempSync(join(tmpdir(), "norma-dirs-canon-"));
    const leaf = join(base, "does-not-exist-yet");
    expect(canonicalizeDirPath(leaf)).toBe(join(realpathSync(base), "does-not-exist-yet"));
  });

  test("not-yet-existing leaf, multiple missing segments deep", () => {
    const base = mkdtempSync(join(tmpdir(), "norma-dirs-canon-"));
    const leaf = join(base, "a", "b", "c");
    expect(canonicalizeDirPath(leaf)).toBe(join(realpathSync(base), "a", "b", "c"));
  });

  test("relative paths throw", () => {
    expect(() => canonicalizeDirPath("relative/path")).toThrow();
    expect(() => canonicalizeDirPath("just-a-name")).toThrow();
  });
});
