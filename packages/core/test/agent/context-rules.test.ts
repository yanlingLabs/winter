import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";

// Mirrors context.test.ts's own harness: temp NORMA_HOME, a real TrustStore backed by a temp
// trust.json (trust.trust(cwd) marks a dir trusted), and a real SkillStore — never touches the
// live ~/.norma.
function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ctx-rules-"))); }
function setup() {
  const home = realDir();
  mkdirSync(join(home, "memory"), { recursive: true });
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("ContextAssembler — .norma/rules/*.md prose rules (CC-parity, trust-gated)", () => {
  test("trusted cwd: both rule bodies appear under 'Project rules', sorted a-before-b regardless of write order", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    // write b.md BEFORE a.md on disk — proves the `.sort()` orders output, not readdir's incidental listing order
    writeFileSync(join(cwd, ".norma", "rules", "b.md"), "RULE_B_BODY");
    writeFileSync(join(cwd, ".norma", "rules", "a.md"), "RULE_A_BODY");
    trust.trust(cwd);
    const a = new ContextAssembler({ normaHome: home, trust, skills: new SkillStore({ normaHome: home, trust }) });
    const out = a.assemble({ cwd });
    expect(out).toContain("## Project rules (.norma/rules/)");
    expect(out).toContain("### a.md\nRULE_A_BODY");
    expect(out).toContain("### b.md\nRULE_B_BODY");
    expect(out.indexOf("### a.md")).toBeLessThan(out.indexOf("### b.md"));
  });

  test("untrusted cwd: no 'Project rules' section at all, even though rule files exist", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "rules", "a.md"), "RULE_A_BODY");
    // deliberately NOT trusting cwd
    const a = new ContextAssembler({ normaHome: home, trust, skills: new SkillStore({ normaHome: home, trust }) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("Project rules");
    expect(out).not.toContain("RULE_A_BODY");
  });

  test("a literal <system-reminder> tag inside a rule body is neutralized before injection", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "rules", "a.md"), "before <system-reminder> after");
    trust.trust(cwd);
    const a = new ContextAssembler({ normaHome: home, trust, skills: new SkillStore({ normaHome: home, trust }) });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("<system-reminder>");
    expect(out).toContain("before [tag] after");
  });

  test("no rules dir: no 'Project rules' section, and assemble() never throws", () => {
    const { home, trust } = setup();
    const cwd = realDir(); // no .norma/rules created at all
    trust.trust(cwd);
    const a = new ContextAssembler({ normaHome: home, trust, skills: new SkillStore({ normaHome: home, trust }) });
    expect(() => a.assemble({ cwd })).not.toThrow();
    expect(a.assemble({ cwd })).not.toContain("Project rules");
  });

  test("non-.md entries and a directory literally named *.md are ignored without crashing", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "rules", "a.md"), "RULE_A_BODY");
    writeFileSync(join(cwd, ".norma", "rules", "notes.txt"), "NOT_MARKDOWN_SENTINEL"); // wrong extension
    mkdirSync(join(cwd, ".norma", "rules", "dir.md")); // a DIRECTORY named *.md — readCapped returns null for it
    trust.trust(cwd);
    const a = new ContextAssembler({ normaHome: home, trust, skills: new SkillStore({ normaHome: home, trust }) });
    expect(() => a.assemble({ cwd })).not.toThrow();
    const out = a.assemble({ cwd });
    expect(out).toContain("RULE_A_BODY");
    expect(out).not.toContain("NOT_MARKDOWN_SENTINEL");
    expect(out).not.toContain("### dir.md");
  });

  test("byte cap: rules payload total is bounded by instructionsBytes (+ one truncation-marker overshoot)", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "rules", "a.md"), "A".repeat(50));
    writeFileSync(join(cwd, ".norma", "rules", "b.md"), "B".repeat(5000));
    trust.trust(cwd);
    const a = new ContextAssembler({
      normaHome: home,
      trust,
      skills: new SkillStore({ normaHome: home, trust }),
      caps: { instructionsBytes: 64 },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain("A".repeat(50));      // a.md (50 bytes) fits whole inside the 64-byte budget
    expect(out).not.toContain("B".repeat(50));  // b.md is truncated well before 50 consecutive B's survive
    expect(out).toContain("[…truncated]");      // readCapped's own marker (context.ts TRUNC) fired
    const section = (out.split("## Project rules")[1] ?? "").split("\n\n## ")[0] ?? "";
    // Formal bound: sum of injected rule-body bytes <= instructionsBytes + byteLength(TRUNC) (only the
    // last file processed can overshoot the entering budget, by exactly the truncation marker's length,
    // before the loop's `budget <= 0` check breaks it). fix-wave E: the budget now also counts each
    // file's `### <filename>\n` header bytes (previously only the body was decremented, so headers
    // were unbounded-per-file — see the dedicated "many small files" test below for the proof), so
    // the slack this bound needs is much smaller than before; the modest margin left below just
    // covers the section's own OUTER "## Project rules (.norma/rules/)\n" prefix and the "\n\n"
    // joins between files, neither of which was ever part of the per-file budget, before or after.
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(64 + 50);
  });

  test("fix-wave E: header bytes count against the rules budget too — many small files can't balloon the payload past it", () => {
    const { home, trust } = setup();
    const cwd = realDir();
    mkdirSync(join(cwd, ".norma", "rules"), { recursive: true });
    // 20 files, each a single-byte body — under the OLD accounting (budget decremented by body
    // bytes only) essentially all 20 files' ~14-byte headers would land uncounted, blowing the
    // 20-byte budget many times over (bounded only by filename length × file count, per the
    // brief). Under the FIX, each file's header+body together count, so the loop's own `budget <=
    // 0` check now stops it after only a couple of files.
    for (let i = 1; i <= 20; i++) {
      writeFileSync(join(cwd, ".norma", "rules", `rule${String(i).padStart(2, "0")}.md`), "X");
    }
    trust.trust(cwd);
    const a = new ContextAssembler({
      normaHome: home,
      trust,
      skills: new SkillStore({ normaHome: home, trust }),
      caps: { instructionsBytes: 20 },
    });
    const out = a.assemble({ cwd });
    const section = (out.split("## Project rules")[1] ?? "").split("\n\n## ")[0] ?? "";
    // Generous but still tight-relative-to-the-bug bound: comfortably covers the outer prefix/joins
    // for the handful of files that now fit, yet is an order of magnitude below what the pre-fix
    // (header-uncounted) accounting would have produced for 20 files (~355 bytes for this fixture).
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(20 + 100);
  });
});
