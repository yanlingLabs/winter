import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { canonicalizeDirPath, type SessionDirs } from "../../src/sessions/dirs";
import {
  setSessionDirs,
  lockDir,
  DIRS_MODE_REFUSAL,
  DIR_LOCKED_REFUSAL,
  DIR_DENIED_REFUSAL,
  DIR_REMOVE_PRIMARY_REFUSAL,
  type SetDirsDeps,
} from "../../src/sessions/set-dirs";

// -----------------------------------------------------------------------------------------
// working-directories T2: setSessionDirs — the one domain setter. Real SessionStore instances
// (the T1 test-file harness pattern), grantDenied injected/faked (the real predicate wires in T3).
// -----------------------------------------------------------------------------------------

function makeStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "norma-set-dirs-store-"));
  return { store: new SessionStore(dir), dir };
}

function makeDeps(store: SessionStore, grantDenied: (dir: string) => boolean = () => false): SetDirsDeps {
  return { store, grantDenied };
}

function fixtureBase(): string {
  return mkdtempSync(join(tmpdir(), "norma-set-dirs-fixture-"));
}

describe("setSessionDirs — NOT_FOUND (resolved first)", () => {
  test("unknown session id answers not_found", () => {
    const { store } = makeStore();
    const result = setSessionDirs(makeDeps(store), "s_nope", "setPrimary", "/tmp/x");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("not_found");
    expect(result.error).toContain("unknown session");
  });
});

describe("setSessionDirs — participation (DIRS_MODE_REFUSAL)", () => {
  test("chat session refuses setPrimary", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { mode: "chat" });
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", "/tmp/x");
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIRS_MODE_REFUSAL });
  });

  test("dispatch session refuses add", () => {
    const { store } = makeStore();
    const id = store.createSession("global", { mode: "dispatch" });
    const result = setSessionDirs(makeDeps(store), id, "add", "/tmp/x");
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIRS_MODE_REFUSAL });
  });
});

describe("setSessionDirs — op semantics", () => {
  test("setPrimary establishes the primary on an empty (workdir-less) set", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const path = join(base, "proj");
    mkdirSync(path);
    const canon = canonicalizeDirPath(path);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", path);
    expect(result).toEqual({ ok: true, dirs: [{ path: canon, locked: false }] });
    expect(store.dirs(id)).toEqual([{ path: canon, locked: false }]);
  });

  test("setPrimary replaces dirs[0] when unlocked, leaving the rest untouched", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const oldPrimary = join(base, "old"); mkdirSync(oldPrimary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    const newPrimary = join(base, "new"); mkdirSync(newPrimary);
    store.setDirsRaw(id, [
      { path: canonicalizeDirPath(oldPrimary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: true },
    ]);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", newPrimary);
    expect(result).toEqual({
      ok: true,
      dirs: [
        { path: canonicalizeDirPath(newPrimary), locked: false },
        { path: canonicalizeDirPath(secondary), locked: true },
      ],
    });
  });

  test("add appends an unlocked entry", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const added = join(base, "added"); mkdirSync(added);
    store.setDirsRaw(id, [{ path: canonicalizeDirPath(primary), locked: false }]);
    const result = setSessionDirs(makeDeps(store), id, "add", added);
    expect(result).toEqual({
      ok: true,
      dirs: [
        { path: canonicalizeDirPath(primary), locked: false },
        { path: canonicalizeDirPath(added), locked: false },
      ],
    });
  });

  test("add on an empty (workdir-less) set establishes the primary — the empty-set rule", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const path = join(base, "proj"); mkdirSync(path);
    const result = setSessionDirs(makeDeps(store), id, "add", path);
    expect(result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(path), locked: false }] });
  });

  test("remove drops an unlocked non-primary entry", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    store.setDirsRaw(id, [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: false },
    ]);
    const result = setSessionDirs(makeDeps(store), id, "remove", secondary);
    expect(result).toEqual({ ok: true, dirs: [{ path: canonicalizeDirPath(primary), locked: false }] });
  });

  test("removing a path not present is an idempotent ok with the unchanged set", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const notPresent = join(base, "not-present"); mkdirSync(notPresent);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: false }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "remove", notPresent);
    expect(result).toEqual({ ok: true, dirs: existing });
  });
});

describe("setSessionDirs — duplicate add is idempotent", () => {
  test("canonicalized-equal to an existing entry: ok, unchanged set, no write", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: true },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "add", secondary);
    expect(result).toEqual({ ok: true, dirs: existing });
    expect(store.dirs(id)).toEqual(existing); // unchanged, including the secondary's lock
  });

  test("duplicate detection canonicalizes the incoming path (symlink spelling matches)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(real), locked: false }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "add", link);
    expect(result).toEqual({ ok: true, dirs: existing });
  });

  // Mutation-probe follow-up (T2 review, probe 7): findByCanonical canonicalizes BOTH sides —
  // this pins the STORED side specifically. A raw string compare (`d.path === canonical`) would
  // stay green on every other fixture in this file because every OTHER stored entry here was
  // itself written through canonicalizeDirPath first — so only a fixture whose STORED path is a
  // deliberately non-canonical spelling (the "migration stores cwd VERBATIM" scenario, T1) can
  // catch a raw-compare regression on this side.
  test("stored-side canonicalization: a raw (non-canonical) stored spelling is recognized as a duplicate by its canonical twin", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    // Stored VERBATIM as the symlinked spelling — never itself canonicalized — mirroring how a
    // pre-branch `cwd` column (and any other legacy writer) can leave a non-canonical path sitting
    // in the `dirs` column for `setSessionDirs` to read back.
    const existing: SessionDirs = [{ path: link, locked: false }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "add", real);
    expect(result).toEqual({ ok: true, dirs: existing }); // recognized as the SAME entry, not appended
    expect(store.dirs(id)).toEqual(existing);
  });
});

describe("setSessionDirs — setPrimary dedupe-promote (whole-branch review I-1)", () => {
  test("setPrimary of the CURRENT primary (idx 0) is idempotent — ok, unchanged set, no write", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: true },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", primary);
    expect(result).toEqual({ ok: true, dirs: existing });
    expect(store.dirs(id)).toEqual(existing); // unchanged, no write
  });

  test("setPrimary of the CURRENT primary is idempotent-ok EVEN WHEN LOCKED (wd-m3) — no lock refusal fires", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: true }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", primary);
    expect(result).toEqual({ ok: true, dirs: existing });
    expect(store.dirs(id)).toEqual(existing);
  });

  test("setPrimary of an unlocked entry already at idx>0 PROMOTES it to 0 — no duplicate, old primary dropped", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    const third = join(base, "third"); mkdirSync(third);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: false },
      { path: canonicalizeDirPath(third), locked: false },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", secondary);
    expect(result).toEqual({
      ok: true,
      dirs: [
        { path: canonicalizeDirPath(secondary), locked: false },
        { path: canonicalizeDirPath(third), locked: false },
      ],
    });
    // the invariant: no two canonically-equal entries, ever
    const canon = result.ok ? result.dirs.map((d) => canonicalizeDirPath(d.path)) : [];
    expect(new Set(canon).size).toBe(canon.length);
  });

  test("setPrimary of a LOCKED entry already at idx>0 PROMOTES it to 0 — the lock survives the move", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const locked = join(base, "locked"); mkdirSync(locked);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(locked), locked: true },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", locked);
    expect(result).toEqual({
      ok: true,
      dirs: [{ path: canonicalizeDirPath(locked), locked: true }],
    });
    expect(store.dirs(id)).toEqual([{ path: canonicalizeDirPath(locked), locked: true }]);
  });

  test("setPrimary promote of an entry at idx>0 refuses when the CURRENT primary is locked — the displacing-call rule still fires", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: true },
      { path: canonicalizeDirPath(secondary), locked: false },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", secondary);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL });
    expect(store.dirs(id)).toEqual(existing); // no write happened
  });

  test("setPrimary promote canonicalizes the incoming path (symlink spelling still finds idx>0)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(real), locked: false },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", link);
    expect(result).toEqual({
      ok: true,
      dirs: [{ path: canonicalizeDirPath(real), locked: false }],
    });
  });

  // Cross-op invariant (the review's PLUS pin): no op in this state machine ever yields two
  // canonically-equal entries in the set — a duplicate is how a locked "ghost" entry becomes
  // permanently unremovable (I-1's root cause). Exercised across all three ops at once.
  test("invariant: no op ever yields two canonically-equal entries", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const a = join(base, "a"); mkdirSync(a);
    const b = join(base, "b"); mkdirSync(b);
    const c = join(base, "c"); mkdirSync(c);
    const deps = makeDeps(store);
    const assertNoDuplicates = () => {
      const canon = store.dirs(id).map((d) => canonicalizeDirPath(d.path));
      expect(new Set(canon).size).toBe(canon.length);
    };
    expect(setSessionDirs(deps, id, "setPrimary", a).ok).toBe(true); assertNoDuplicates();
    expect(setSessionDirs(deps, id, "add", b).ok).toBe(true); assertNoDuplicates();
    expect(setSessionDirs(deps, id, "add", c).ok).toBe(true); assertNoDuplicates();
    expect(setSessionDirs(deps, id, "setPrimary", c).ok).toBe(true); assertNoDuplicates(); // promote
    expect(setSessionDirs(deps, id, "setPrimary", c).ok).toBe(true); assertNoDuplicates(); // idx-0 idempotent
    expect(setSessionDirs(deps, id, "add", a).ok).toBe(true); assertNoDuplicates(); // duplicate add
    expect(setSessionDirs(deps, id, "remove", a).ok).toBe(true); assertNoDuplicates();
  });
});

describe("setSessionDirs — locked mutations (DIR_LOCKED_REFUSAL)", () => {
  test("setPrimary over a locked primary refuses", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const attempted = join(base, "attempted"); mkdirSync(attempted);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: true }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", attempted);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL });
    expect(store.dirs(id)).toEqual(existing); // no write happened
  });

  test("remove of a locked non-primary entry refuses", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const locked = join(base, "locked"); mkdirSync(locked);
    const existing: SessionDirs = [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(locked), locked: true },
    ];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "remove", locked);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL });
    expect(store.dirs(id)).toEqual(existing);
  });

  // Superseded by the I-1 dedupe-promote fix (wd-m3): a symlink spelling of the locked primary
  // canonicalizes to the SAME entry (idx 0), so this is the idempotent no-op case now, not a
  // refusal — asking to set the primary to a path it already IS can never be a mutation the lock
  // needs to protect against. See "setPrimary — dedupe-promote" above for the behavior pin; kept
  // here (beside its sibling locked-mutation tests) so the "canonicalizes before compare" angle
  // stays pinned, now against the correct (idempotent) outcome.
  test("symlink spelling of a locked primary is recognized as the SAME entry (idx 0) — idempotent ok, not a refusal", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(real), locked: true }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", link);
    expect(result).toEqual({ ok: true, dirs: existing });
    expect(store.dirs(id)).toEqual(existing); // no write happened
  });

  test("symlink spelling of a DIFFERENT, not-yet-present path still refuses over a locked primary — the dedupe compare canonicalizes but finds no match, so the lock refusal still fires", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: true }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "setPrimary", link);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_LOCKED_REFUSAL });
    expect(store.dirs(id)).toEqual(existing); // no write happened
  });
});

describe("setSessionDirs — removing the primary refuses, naming setPrimary", () => {
  test("remove of index 0 refuses even when unlocked", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: false }];
    store.setDirsRaw(id, existing);
    const result = setSessionDirs(makeDeps(store), id, "remove", primary);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_REMOVE_PRIMARY_REFUSAL });
    expect(DIR_REMOVE_PRIMARY_REFUSAL).toContain("setPrimary");
    expect(store.dirs(id)).toEqual(existing);
  });
});

describe("setSessionDirs — denylist (DIR_DENIED_REFUSAL)", () => {
  test("add refuses a grantDenied path", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const path = join(base, "forbidden"); mkdirSync(path);
    const result = setSessionDirs(makeDeps(store, () => true), id, "add", path);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_DENIED_REFUSAL });
    expect(store.dirs(id)).toEqual([]);
  });

  test("setPrimary refuses a grantDenied path", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const path = join(base, "forbidden"); mkdirSync(path);
    const result = setSessionDirs(makeDeps(store, () => true), id, "setPrimary", path);
    expect(result).toEqual({ ok: false, kind: "invalid", error: DIR_DENIED_REFUSAL });
  });

  test("grantDenied is consulted with the CANONICALIZED path", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    let seen: string | undefined;
    const deps = makeDeps(store, (dir) => { seen = dir; return false; });
    setSessionDirs(deps, id, "add", link);
    expect(seen).toBe(canonicalizeDirPath(real));
  });
});

describe("lockDir", () => {
  test("locks the matching entry", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const secondary = join(base, "secondary"); mkdirSync(secondary);
    store.setDirsRaw(id, [
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: false },
    ]);
    lockDir(makeDeps(store), id, secondary);
    expect(store.dirs(id)).toEqual([
      { path: canonicalizeDirPath(primary), locked: false },
      { path: canonicalizeDirPath(secondary), locked: true },
    ]);
  });

  test("idempotent on an absent path: no-op, no throw", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const elsewhere = join(base, "elsewhere"); mkdirSync(elsewhere);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: false }];
    store.setDirsRaw(id, existing);
    expect(() => lockDir(makeDeps(store), id, elsewhere)).not.toThrow();
    expect(store.dirs(id)).toEqual(existing);
  });

  test("idempotent on an already-locked entry", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const primary = join(base, "primary"); mkdirSync(primary);
    const existing: SessionDirs = [{ path: canonicalizeDirPath(primary), locked: true }];
    store.setDirsRaw(id, existing);
    lockDir(makeDeps(store), id, primary);
    expect(store.dirs(id)).toEqual(existing);
  });

  test("canonicalizes before matching (symlink spelling locks the canonical entry)", () => {
    const { store } = makeStore();
    const id = store.createSession("global");
    const base = fixtureBase();
    const real = join(base, "real"); mkdirSync(real);
    const link = join(base, "link"); symlinkSync(real, link);
    store.setDirsRaw(id, [{ path: canonicalizeDirPath(real), locked: false }]);
    lockDir(makeDeps(store), id, link);
    expect(store.dirs(id)).toEqual([{ path: canonicalizeDirPath(real), locked: true }]);
  });
});
