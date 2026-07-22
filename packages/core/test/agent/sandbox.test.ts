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
// hard error (engine.ts's controlPlaneFileTarget, renamed from permissionRulesFileTarget in the
// CC-parity Task 6.5 pass) only ever sees write/edit TOOL calls — a bash command
// (`echo x > .norma/permissions.local.json`) never goes through it at all. The seatbelt
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

  // CC-parity Task 6.5: this array grew from 1 entry to 3 (permissions.local.json +
  // settings.json + settings.local.json) when the per-root literal denies were generalized to
  // ALL THREE control-plane filenames (see buildSeatbeltProfile's own doc comment) — the test's
  // actual invariant (exactly ONE root contributes literals, i.e. writableRoots: [] does NOT fall
  // back to the default [tmpdir()]) is unchanged; only the per-root count did.
  test("empty writableRoots ([]) still carves out cwd's own control-plane files exactly once each (no default-tmpdir carve-out sneaking in)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [] });
    const denyLines = [...p.matchAll(/\(deny file-write\* \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
    expect(denyLines).toEqual([
      join(cwd, ".norma", "permissions.local.json"),
      join(cwd, ".norma", "settings.json"),
      join(cwd, ".norma", "settings.local.json"),
    ]);
  });
});

// CC-parity Task 6.5 (controller-added): Task 7 wires ProjectSettingsResolver's permissions.allow
// into the live gate, making `.norma/settings.json` and `.norma/settings.local.json` rule-bearing
// control-plane files exactly like permissions.local.json above. The seatbelt must independently
// carve out these two filenames too, for the SAME bash-invoked-write reason (see this file's own
// doc comment on buildSeatbeltProfile) — mirrors the describe block just above, filename for
// filename, rather than inventing a new harness.
describe("buildSeatbeltProfile: settings-overlay carve-out (CC-parity Task 6.5)", () => {
  test("denies settings.json AND settings.local.json under cwd, both as deny-after-allow lines (SBPL last-match-wins)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    const allowIdx = p.indexOf("(allow file-write*");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    for (const f of ["settings.json", "settings.local.json"]) {
      const denyIdx = p.indexOf(`(deny file-write* (literal "${join(cwd, ".norma", f)}"))`);
      expect(denyIdx).toBeGreaterThan(allowIdx);
    }
  });

  test("denies both settings filenames under EVERY extra writable root too, not just cwd", () => {
    const cwd = realTmp();
    const extra1 = realTmp();
    const extra2 = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra1, extra2] });
    for (const root of [cwd, extra1, extra2]) {
      for (const f of ["settings.json", "settings.local.json"]) {
        expect(p).toContain(`(deny file-write* (literal "${join(root, ".norma", f)}"))`);
      }
    }
  });

  // Pins the exact flatMap ordering (roots × filenames, root-major) with TWO explicit roots — not
  // the default writableRoots (which falls back to [tmpdir()] and would add a THIRD root's own
  // three literals, muddying an exact-array assertion) and not writableRoots: [] (that variant, one
  // root only, is covered by the describe block above).
  test("literal denies are grouped per root — each root's three filenames together, root-by-root in `roots` order", () => {
    const cwd = realTmp();
    const extra = realTmp();
    const p = buildSeatbeltProfile({ cwd, writableRoots: [extra] });
    const denyLines = [...p.matchAll(/\(deny file-write\* \(literal "([^"]*)"\)\)/g)].map((m) => m[1]);
    expect(denyLines).toEqual([
      join(cwd, ".norma", "permissions.local.json"),
      join(cwd, ".norma", "settings.json"),
      join(cwd, ".norma", "settings.local.json"),
      join(extra, ".norma", "permissions.local.json"),
      join(extra, ".norma", "settings.json"),
      join(extra, ".norma", "settings.local.json"),
    ]);
  });

  test("the carve-out stays FILENAME-specific — no deny for .norma itself, .norma/memory (the MEMDIR), or .norma/rules (the prose-rules dir)", () => {
    const cwd = realTmp();
    const p = buildSeatbeltProfile({ cwd });
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".norma")}"))`);
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".norma", "memory")}"))`);
    expect(p).not.toContain(`(deny file-write* (literal "${join(cwd, ".norma", "rules")}"))`);
    expect(p).not.toMatch(/\(deny file-write\* \(subpath/); // never a blanket subpath deny
  });

  test("the settings carve-out paths are escaped the same way the rules-file carve-out is (quotes/backslashes)", () => {
    const p = buildSeatbeltProfile({ cwd: '/tmp/we"ird' });
    expect(p).toContain('(deny file-write* (literal "/tmp/we\\"ird/.norma/settings.json"))');
    expect(p).toContain('(deny file-write* (literal "/tmp/we\\"ird/.norma/settings.local.json"))');
  });

  // Part B step 2: TWO SEPARATE regex deny lines, never one combined via alternation (the shipped
  // verification only covers plain per-character char-class regexes — see RULES_FILE_REGEX's own
  // comment in sandbox.ts). Asserted independently, and that neither regex collapses into the
  // other or into RULES_FILE_REGEX.
  test("both settings regexes appear as SEPARATE deny lines alongside the rules-file regex — three regex denies total, no alternation", () => {
    const p = buildSeatbeltProfile({ cwd: realTmp() });
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Nn][Oo][Rr][Mm][Aa]/[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Nn][Oo][Rr][Mm][Aa]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Jj][Ss][Oo][Nn]$"))`);
    expect(p).toContain(String.raw`(deny file-write* (regex #"/\.[Nn][Oo][Rr][Mm][Aa]/[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]\.[Ll][Oo][Cc][Aa][Ll]\.[Jj][Ss][Oo][Nn]$"))`);
    const regexDenyCount = [...p.matchAll(/\(deny file-write\* \(regex/g)].length;
    expect(regexDenyCount).toBe(3); // rules file + settings.json + settings.local.json — never merged
    expect(p).not.toContain("|"); // SBPL alternation marker never appears anywhere in the profile
  });
});
