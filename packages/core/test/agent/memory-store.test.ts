import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type MemoryFact } from "../../src/agent/memory";
import { TrustStore } from "../../src/agent/trust";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-mem-"))); }

/** Always-trusted stub — most tests only need project scope to behave like user scope. */
const alwaysTrusted = { isTrusted: (_dir: string) => true };
/** Never-trusted stub for the explicit untrusted-project test. */
const neverTrusted = { isTrusted: (_dir: string) => false };

function setup(trust: { isTrusted: (dir: string) => boolean } = alwaysTrusted, nowMs?: () => number) {
  const home = realDir();
  const store = new MemoryStore({ winterHome: home, trust, ...(nowMs ? { nowMs } : {}) });
  return { home, store };
}

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return { name: "coffee-pref", description: "Likes oat milk lattes", type: "user", body: "User prefers oat milk lattes over regular.", ...overrides };
}

describe("MemoryStore", () => {
  test("write → read round-trip: frontmatter exact", async () => {
    const { home, store } = setup();
    const f = fact();
    const res = await store.write("user", f, { source: "tool" });
    expect(res.ok).toBe(true);

    const raw = readFileSync(join(home, "memory", "coffee-pref.md"), "utf8");
    expect(raw).toBe(
      "---\nname: coffee-pref\ndescription: Likes oat milk lattes\ntype: user\n---\n\nUser prefers oat milk lattes over regular.",
    );

    const read = store.read("user", "coffee-pref");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(f);
  });

  test("description newlines stripped in frontmatter", async () => {
    const { store } = setup();
    const res = await store.write("user", fact({ description: "Line one\nLine two" }), { source: "tool" });
    expect(res.ok).toBe(true);
    const read = store.read("user", "coffee-pref");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.description).not.toContain("\n");
  });

  test("whitespace-only description → ok:false kind:invalid, fs untouched; valid rewrite of same name then succeeds", async () => {
    // Wire/tool schemas validate the RAW description with min(1), so " " and "\n" pass them —
    // but normalization collapses both to "", which parseFactFile treats as corrupt: the write
    // would report ok while read() fails and MEMORY.md carries a blank-description line. The
    // store must fail fast on the NORMALIZED value, before any fs op.
    for (const ws of [" ", "\n", " \n "]) {
      const { home, store } = setup();
      const res = await store.write("user", fact({ name: "x", description: ws }), { source: "tool" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.kind).toBe("invalid");
        expect(res.error).toContain("non-empty description");
      }
      expect(existsSync(join(home, "memory"))).toBe(false); // no fact file, no index, no audit — nothing created

      const valid = await store.write("user", fact({ name: "x", description: "real description" }), { source: "tool" });
      expect(valid.ok).toBe(true);
      const read = store.read("user", "x");
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.description).toBe("real description");
    }
  });

  test("whitespace-only description on OVERWRITE leaves the existing fact + index unchanged", async () => {
    const { home, store } = setup();
    await store.write("user", fact({ name: "x", description: "original" }), { source: "tool" });
    const factBefore = readFileSync(join(home, "memory", "x.md"), "utf8");
    const indexBefore = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");

    const res = await store.write("user", fact({ name: "x", description: "  " }), { source: "tool" });
    expect(res.ok).toBe(false);
    expect(readFileSync(join(home, "memory", "x.md"), "utf8")).toBe(factBefore);
    expect(readFileSync(join(home, "memory", "MEMORY.md"), "utf8")).toBe(indexBefore);
  });

  test("overwrite keeps index position, updates description", async () => {
    const { home, store } = setup();
    await store.write("user", fact({ name: "a", description: "first" }), { source: "tool" });
    await store.write("user", fact({ name: "b", description: "second" }), { source: "tool" });
    await store.write("user", fact({ name: "a", description: "first-updated" }), { source: "tool" });

    const index = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");
    const lines = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [a](a.md) — first-updated",
      "- [b](b.md) — second",
    ]);
  });

  test("delete removes file + index line", async () => {
    const { home, store } = setup();
    await store.write("user", fact({ name: "a" }), { source: "tool" });
    await store.write("user", fact({ name: "b" }), { source: "tool" });
    const del = await store.delete("user", "a", { source: "tool" });
    expect(del.ok).toBe(true);

    expect(existsSync(join(home, "memory", "a.md"))).toBe(false);
    const index = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");
    expect(index).not.toContain("a.md");
    expect(index).toContain("b.md");
  });

  test("list: [] when dir missing", () => {
    const { store } = setup();
    const res = store.list("user");
    expect(res).toEqual({ ok: true, value: [] });
  });

  test("list skips corrupt file", async () => {
    const { home, store } = setup();
    await store.write("user", fact({ name: "good" }), { source: "tool" });
    writeFileSync(join(home, "memory", "corrupt.md"), "not frontmatter at all");
    const res = store.list("user");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.map((m) => m.name)).toEqual(["good"]);
  });

  test("list index format matches MEMORY.md header + one line per fact", async () => {
    const { home, store } = setup();
    await store.write("user", fact({ name: "a", description: "desc a" }), { source: "tool" });
    const index = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");
    expect(index.startsWith("# Memory index")).toBe(true);
    expect(index).toContain("- [a](a.md) — desc a");
  });

  describe("slug jail", () => {
    const badNames = ["../x", "a/b", "A_B", "x".repeat(65), ""];
    for (const bad of badNames) {
      test(`rejects "${bad}" on write, delete, read — fs untouched`, async () => {
        const { home, store } = setup();
        const w = await store.write("user", fact({ name: bad }), { source: "tool" });
        expect(w.ok).toBe(false);
        expect(existsSync(join(home, "memory"))).toBe(false); // no fs op happened at all

        const d = await store.delete("user", bad, { source: "tool" });
        expect(d.ok).toBe(false);

        const r = store.read("user", bad);
        expect(r.ok).toBe(false);
      });
    }

    test("64-char name is the boundary and IS accepted", async () => {
      const { store } = setup();
      const name = "x".repeat(64);
      const res = await store.write("user", fact({ name }), { source: "tool" });
      expect(res.ok).toBe(true);
    });
  });

  describe("reserved name: memory", () => {
    // On macOS's default case-insensitive/case-preserving APFS, `memory.md` and the `MEMORY.md`
    // index are the SAME file — an accepted fact named "memory" would clobber the index (and a
    // delete would unlink it). Reserved at validation time, BEFORE any fs op.
    test('write(name:"memory") → ok:false, fs untouched', async () => {
      const { home, store } = setup();
      const res = await store.write("user", fact({ name: "memory" }), { source: "tool" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("reserved");
      expect(existsSync(join(home, "memory"))).toBe(false); // no scope dir created at all
    });

    test("write/delete/read of 'memory' rejected; pre-existing fact + index unharmed", async () => {
      const { home, store } = setup();
      await store.write("user", fact({ name: "keep-me", description: "survivor" }), { source: "tool" });
      const indexBefore = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");

      const w = await store.write("user", fact({ name: "memory" }), { source: "tool" });
      expect(w.ok).toBe(false);
      const d = await store.delete("user", "memory", { source: "tool" }); // would unlink the INDEX on APFS
      expect(d.ok).toBe(false);
      const r = store.read("user", "memory");
      expect(r.ok).toBe(false);

      // index byte-identical, pre-existing fact still lists and reads
      expect(readFileSync(join(home, "memory", "MEMORY.md"), "utf8")).toBe(indexBefore);
      const list = store.list("user");
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.value.map((m) => m.name)).toEqual(["keep-me"]);
      const keep = store.read("user", "keep-me");
      expect(keep.ok).toBe(true);
      if (keep.ok) expect(keep.value.description).toBe("survivor");
    });
  });

  test("project scope: untrusted → ok:false with exact message", () => {
    const { store } = setup(neverTrusted);
    const cwd = realDir();
    const res = store.list("project", cwd);
    expect(res).toEqual({ ok: false, error: "project memory requires a trusted directory", kind: "trust" });
  });

  // T3 review Finding 2: failures carry a structural `kind` so the RPC boundary maps them to
  // JSON-RPC codes without string-matching error text (which embeds caller input verbatim —
  // a name like "why is this not found" must classify as invalid, not not_found).
  test("failure kinds: invalid name → 'invalid'; read/delete miss → 'not_found'; trust gate → 'trust'; fs failure → absent", async () => {
    const { store } = setup(neverTrusted);

    const invalid = store.read("user", "why is this not found");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.kind).toBe("invalid");
    const reserved = await store.write("user", fact({ name: "memory" }), { source: "tool" });
    if (!reserved.ok) expect(reserved.kind).toBe("invalid");

    const miss = store.read("user", "ghost");
    if (!miss.ok) expect(miss.kind).toBe("not_found");
    const delMiss = await store.delete("user", "ghost", { source: "tool" });
    if (!delMiss.ok) expect(delMiss.kind).toBe("not_found");

    const trust = await store.write("project", fact(), { source: "tool" }, realDir());
    if (!trust.ok) expect(trust.kind).toBe("trust");

    // fs failure (scope root collides with a plain file): wrapped error, deliberately unclassified
    const home = realDir();
    writeFileSync(join(home, "memory"), "not a directory");
    const fsStore = new MemoryStore({ winterHome: home, trust: alwaysTrusted });
    const fsFail = await fsStore.write("user", fact({ name: "a" }), { source: "tool" });
    expect(fsFail.ok).toBe(false);
    if (!fsFail.ok) expect(fsFail.kind).toBeUndefined();
  });

  test("project scope: missing cwd → ok:false", () => {
    const { store } = setup(neverTrusted);
    const res = store.list("project");
    expect(res.ok).toBe(false);
  });

  test("project scope: write when untrusted → ok:false, no fs op", async () => {
    const { store } = setup(neverTrusted);
    const cwd = realDir();
    const res = await store.write("project", fact(), { source: "tool" }, cwd);
    expect(res.ok).toBe(false);
    expect(existsSync(join(cwd, ".winter", "memory"))).toBe(false);
  });

  test("project scope: trusted round-trip (temp dirs + stub trust)", async () => {
    const cwd = realDir();
    const stubTrust = { isTrusted: (dir: string) => dir === cwd };
    const home = realDir();
    const store = new MemoryStore({ winterHome: home, trust: stubTrust });

    const w = await store.write("project", fact(), { source: "tool" }, cwd);
    expect(w.ok).toBe(true);
    expect(existsSync(join(cwd, ".winter", "memory", "coffee-pref.md"))).toBe(true);
    // audit always lands under winterHome, never under the project dir, for BOTH scopes
    expect(existsSync(join(home, "memory", "audit.jsonl"))).toBe(true);
    expect(existsSync(join(cwd, ".winter", "memory", "audit.jsonl"))).toBe(false);

    const r = store.read("project", "coffee-pref", cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(fact());
  });

  test("20 concurrent writes → index has all 20 lines, valid every parse", async () => {
    const { home, store } = setup();
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.write("user", fact({ name: `fact-${i}`, description: `desc ${i}` }), { source: "tool" }),
    );
    const results = await Promise.all(writes);
    expect(results.every((r) => r.ok)).toBe(true);

    const index = readFileSync(join(home, "memory", "MEMORY.md"), "utf8");
    const lines = index.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(20);

    const list = store.list("user");
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      const r = store.read("user", `fact-${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.description).toBe(`desc ${i}`);
    }
  });

  test("fs error during write → typed ok:false, never throws, later ops unaffected", async () => {
    const home = realDir();
    // Force the scope root path to collide with a plain file, so mkdirSync(recursive) throws.
    // This exercises doWrite's own try/catch (fs error → typed result); it does NOT exercise
    // enqueue's rejection isolation — no rejection ever reaches the queue on this path.
    writeFileSync(join(home, "memory"), "not a directory");
    const store = new MemoryStore({ winterHome: home, trust: alwaysTrusted });

    const first = await store.write("user", fact({ name: "a" }), { source: "tool" });
    expect(first.ok).toBe(false);

    const { statSync, unlinkSync } = await import("node:fs");
    if (statSync(join(home, "memory")).isFile()) unlinkSync(join(home, "memory"));
    const second = await store.write("user", fact({ name: "b" }), { source: "tool" });
    expect(second.ok).toBe(true);
  });

  test("throwing trust.isTrusted (outside doWrite's try) rejects that ONE call, queue not wedged", async () => {
    // The one path where an op can genuinely throw: caller-supplied deps invoked BEFORE the fs
    // try block. enqueue's `.catch` must isolate the queue so later mutations still run, while
    // the failing call itself still rejects loudly rather than being swallowed.
    const home = realDir();
    const bombTrust = { isTrusted: (_dir: string): boolean => { throw new Error("trust store exploded"); } };
    const store = new MemoryStore({ winterHome: home, trust: bombTrust });

    await expect(store.write("project", fact(), { source: "tool" }, realDir())).rejects.toThrow("trust store exploded");
    const after = await store.write("user", fact({ name: "b" }), { source: "tool" }); // user scope never consults trust
    expect(after.ok).toBe(true);
  });

  test("audit: line shape, order, corrupt-line skip", async () => {
    let t = 1000;
    const { home, store } = setup(alwaysTrusted, () => t++);
    await store.write("user", fact({ name: "a" }), { source: "tool", sessionId: "sess-1" });
    await store.write("user", fact({ name: "b" }), { source: "rpc" });
    await store.delete("user", "a", { source: "tool", sessionId: "sess-2" });

    // inject a corrupt line between valid ones
    const auditPath = join(home, "memory", "audit.jsonl");
    const before = readFileSync(auditPath, "utf8");
    writeFileSync(auditPath, before + "not json at all\n" + JSON.stringify({ ts: 9999, source: "tool", scope: "user", action: "write", name: "c" }) + "\n");

    const tail = store.auditTail();
    expect(tail).toHaveLength(4); // 3 real ops + the manually appended valid line; corrupt line skipped
    expect(tail[0]).toEqual({ ts: 1000, sessionId: "sess-1", source: "tool", scope: "user", action: "write", name: "a", description: "Likes oat milk lattes" });
    expect(tail[1]).toEqual({ ts: 1001, source: "rpc", scope: "user", action: "write", name: "b", description: "Likes oat milk lattes" });
    expect(tail[2]).toEqual({ ts: 1002, sessionId: "sess-2", source: "tool", scope: "user", action: "delete", name: "a" });
    expect(tail[3]!.name).toBe("c"); // newest LAST — the manually-appended line comes after the corrupt one in file order
  });

  test("auditTail(limit): 2 → last 2 newest-last; 0 → [] (slice(-0) trap); undefined → all", async () => {
    const { store } = setup();
    for (let i = 0; i < 5; i++) {
      await store.write("user", fact({ name: `f${i}` }), { source: "tool" });
    }
    const tail = store.auditTail(2);
    expect(tail).toHaveLength(2);
    expect(tail[0]!.name).toBe("f3");
    expect(tail[1]!.name).toBe("f4");

    // limit 0 is a valid nonnegative int on the wire (memory.audit {limit:0}) — must mean
    // "none", not the JS slice(-0)===slice(0) full-array trap.
    expect(store.auditTail(0)).toEqual([]);
    expect(store.auditTail(undefined)).toHaveLength(5);
    expect(store.auditTail()).toHaveLength(5);
  });

  test("audit file never contains fact bodies", async () => {
    const { home, store } = setup();
    const secretBody = "SECRET_BODY_MARKER_xyz123";
    await store.write("user", fact({ body: secretBody }), { source: "tool" });
    const raw = readFileSync(join(home, "memory", "audit.jsonl"), "utf8");
    expect(raw).not.toContain(secretBody);
  });

  test("mutations never throw, even for wildly invalid input", async () => {
    const { store } = setup();
    expect(async () => await store.write("user", fact({ name: "bad/../name" }), { source: "tool" })).not.toThrow();
    expect(() => store.read("user", "bad/../name")).not.toThrow();
    expect(async () => await store.delete("user", "bad/../name", { source: "tool" })).not.toThrow();
    expect(() => store.list("user")).not.toThrow();
  });
});
