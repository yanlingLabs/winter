import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "../../src/agent/trust";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-trust-"))); }
function storeFile(): string { return join(realDir(), "trust.json"); }

describe("TrustStore", () => {
  test("untrusted by default; trust() then isTrusted() true and persisted", () => {
    const f = storeFile();
    const dir = realDir();
    const ts = new TrustStore(f);
    expect(ts.isTrusted(dir)).toBe(false);
    ts.trust(dir);
    expect(ts.isTrusted(dir)).toBe(true);
    expect(existsSync(f)).toBe(true);
    // reload from disk → still trusted
    expect(new TrustStore(f).isTrusted(dir)).toBe(true);
  });

  test("trust inherits to subdirectories, not to parents/siblings", () => {
    const f = storeFile();
    const base = realDir();
    const child = join(base, "sub"); mkdirSync(child);
    const ts = new TrustStore(f);
    ts.trust(base);
    expect(ts.isTrusted(child)).toBe(true);      // subdir inherits
    expect(ts.isTrusted(base)).toBe(true);
    const sibling = realDir();
    expect(ts.isTrusted(sibling)).toBe(false);   // unrelated dir not trusted
    // prefix-collision: /base-foo must NOT be trusted by trusting /base
    const cousin = base + "-foo"; mkdirSync(cousin);
    expect(ts.isTrusted(cousin)).toBe(false);
  });

  test("dedup + list", () => {
    const f = storeFile(); const dir = realDir();
    const ts = new TrustStore(f);
    ts.trust(dir); ts.trust(dir);
    expect(ts.list().filter((d) => d === dir)).toHaveLength(1);
  });

  test("missing file → untrusted; corrupt file → untrusted, no throw", () => {
    const dir = realDir();
    expect(new TrustStore(join(realDir(), "nope.json")).isTrusted(dir)).toBe(false);
    const f = storeFile(); writeFileSync(f, "{ not json");
    expect(() => new TrustStore(f).isTrusted(dir)).not.toThrow();
    expect(new TrustStore(f).isTrusted(dir)).toBe(false);
  });

  test("remove() revokes a trusted dir, persists, and returns whether it removed anything", () => {
    const f = storeFile();
    const dir = realDir();
    const ts = new TrustStore(f);
    ts.trust(dir);
    expect(ts.isTrusted(dir)).toBe(true);
    expect(ts.remove(dir)).toBe(true);
    expect(ts.isTrusted(dir)).toBe(false);
    // persisted: reload from disk → still untrusted
    expect(new TrustStore(f).isTrusted(dir)).toBe(false);
    // idempotent: removing again is a no-op that reports false, not an error
    expect(ts.remove(dir)).toBe(false);
  });

  test("remove() on a never-trusted dir is a no-op (false, no throw, no file created)", () => {
    const f = storeFile();
    const dir = realDir();
    const ts = new TrustStore(f);
    expect(() => ts.remove(dir)).not.toThrow();
    expect(ts.remove(dir)).toBe(false);
    expect(existsSync(f)).toBe(false); // trust() has never run — no file written yet
  });

  test("remove() only drops the exact dir — sibling/subdirectory trust is untouched", () => {
    const f = storeFile();
    const base = realDir();
    const child = join(base, "sub"); mkdirSync(child);
    const sibling = realDir();
    const ts = new TrustStore(f);
    ts.trust(base); ts.trust(sibling);
    ts.remove(base);
    expect(ts.isTrusted(base)).toBe(false);
    expect(ts.isTrusted(child)).toBe(false); // no longer inherits — base was the only grant
    expect(ts.isTrusted(sibling)).toBe(true); // untouched
  });
});
