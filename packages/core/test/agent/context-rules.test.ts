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
    // before the loop's `budget <= 0` check breaks it). Generous extra slack below covers the section's
    // own "## Project rules…"/"### x.md" markdown headers, which aren't part of that budget.
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(64 + 200);
  });
});
