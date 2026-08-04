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

// -----------------------------------------------------------------------------------------
// working-directories T1: the `dirs` column + lazy migration inside the getter.
// -----------------------------------------------------------------------------------------
describe("SessionStore.dirs — lazy migration", () => {
  test("cwd-bearing pre-branch row: dirs() derives a single GRANDFATHERED LOCKED primary", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { cwd: "/tmp/proj" });
    expect(store.dirs(id)).toEqual([{ path: "/tmp/proj", locked: true }]);
  });

  test("cwd-less pre-branch row: dirs() derives an empty (workdir-less) set", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
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
