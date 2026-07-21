import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeatbeltProfile } from "../../src/agent/sandbox";

function realTmp(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-sb-"))); }

describe("buildSeatbeltProfile", () => {
  test("denies by default, allows read everywhere, writes only under writable roots", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain(`(subpath "${cwd}")`); // cwd is a writable root
    expect(p).toContain("(allow process-exec)");
    expect(p).toContain("(deny network*)"); // network denied by default
  });

  test("network can be explicitly allowed", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp(), allowNetwork: true });
    expect(p).toContain("(allow network*)");
    expect(p).not.toContain("(deny network*)");
  });

  test("extra writable roots are included and realpath-canonicalized", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra] });
    expect(p).toContain(`(subpath "${cwd}")`);
    expect(p).toContain(`(subpath "${extra}")`);
  });

  test("paths with quotes/backslashes are escaped in the profile", () => {
    // craft a fake path string with a quote — builder must escape it, not break the SBPL
    const p = buildSeatbeltProfile({ cwd: "/tmp/a", writableRoots: ['/tmp/we"ird', "/tmp/back\\slash"] });
    expect(p).toContain('(subpath "/tmp/we\\"ird")');
    expect(p).toContain('(subpath "/tmp/back\\\\slash")');
  });

  test("empty writableRoots yields exactly cwd as the sole writable root (bash tool's call shape)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [] });
    // exactly one subpath rule, and it is cwd (the ?? [tmpdir()] default must NOT fire on [])
    const subpaths = [...p.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]);
    expect(subpaths).toEqual([cwd]);
    expect(subpaths).toHaveLength(1);
  });

  test("sandboxAvailable reflects the platform", () => {
    const { sandboxAvailable } = require("../../src/agent/sandbox");
    expect(sandboxAvailable()).toBe(process.platform === "darwin");
  });
});

// SP-approvals final review (composition hole, HIGH, defense-in-depth): the engine's dispatch-loop
// hard error (engine.ts's permissionRulesFileTarget) only ever sees write/edit TOOL calls — a bash
// command (`echo x > .norma/permissions.local.json`) never goes through it at all. The seatbelt
// itself must independently deny that one exact file, for cwd AND every extra writable root (a
// project's `.norma/permissions.local.json` could exist under any of them), while leaving
// everything else in those same roots — including `.norma/memory/`, the MEMDIR — fully writable.
describe("buildSeatbeltProfile: permission-rules-file carve-out (SP-approvals final review)", () => {
  test("denies the permission-rules file under cwd, as a deny-after-allow line (SBPL last-match-wins)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    const allowIdx = p.indexOf("(allow file-write*");
    const denyIdx = p.indexOf(`(deny file-write* (literal "${join(cwd, ".norma", "permissions.local.json")}"))`);
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx); // AFTER the allow block — SBPL's last matching rule wins
  });

  test("denies the permission-rules file under EVERY extra writable root too, not just cwd", () => {
    const cwd = realTmp();
    const extra1 = realTmp();
    const extra2 = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra1, extra2] });
    for (const root of [cwd, extra1, extra2]) {
      expect(p).toContain(`(deny file-write* (literal "${join(root, ".norma", "permissions.local.json")}"))`);
    }
  });

  test("the carve-out is FILENAME-specific — no deny for the .norma dir itself or for .norma/memory (the MEMDIR)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".norma")}"))`);
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".norma", "memory")}"))`);
    expect(p).not.toMatch(/\(deny file-write\* \(subpath/); // never a blanket subpath deny, only literal single-file denies
  });

  test("the carve-out path is escaped the same way subpath roots are (quotes/backslashes)", () => {
    const p = buildSeatbeltProfile({ cwd: '/tmp/we"ird' });
    expect(p).toContain('(deny file-write* (literal "/tmp/we\\"ird/.norma/permissions.local.json"))');
  });

  test("empty writableRoots ([]) still carves out cwd's own rules file exactly once (no default-tmpdir carve-out sneaking in)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [] });
    const denyLines = [...p.matchAll(/\(deny file-write\* \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
    expect(denyLines).toEqual([join(cwd, ".norma", "permissions.local.json")]);
  });
});
