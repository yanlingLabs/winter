import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { assistantMemoryDirFor } from "../../src/agent/memory-dir";

// working-directories T6 (spec §2): the standing workspace block ("## Workspace", always for a
// code/cowork turn) + the workdir-less MEMDIR redirection (the SAME `workdirLess` input feeds
// both). Mirrors context-output-style.test.ts's "byte-identical when unset" bar and
// context-memory-dir.test.ts / context-assistant.test.ts's setup pattern (a real TrustStore +
// SkillStore, no `.norma/memory` legacy fixtures lying around to leak into the diff).

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-ctx-ws-"))); }

function setup() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  const skills = new SkillStore({ normaHome: home, trust });
  return { home, trust, skills };
}

describe("assemble() workspace block (working-directories T6)", () => {
  test("outDir absent: no block at all — byte-identical to before this field existed", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd });
    expect(out).not.toContain("## Workspace");
  });

  test("outDir present, workdirLess absent: the block is inserted as EXACTLY ONE extra section — everything else byte-identical (the output-styles byte-identical-when-unset bar)", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const withoutBlock = a.assemble({ cwd });
    const withBlock = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER" });

    // ContextAssembler joins its `sections` array with "\n\n" and no individual section here
    // contains a literal blank line (no project rules/memory fixtures exist in this harness), so
    // splitting on "\n\n" recovers the exact section list — proving the block is ONE clean
    // insertion with no side effect on any other section, not just a substring-presence check.
    const withParts = withBlock.split("\n\n");
    const withoutParts = withoutBlock.split("\n\n");
    expect(withParts.length).toBe(withoutParts.length + 1);
    const idx = withParts.findIndex((p) => p.startsWith("## Workspace"));
    expect(idx).toBeGreaterThan(-1);
    withParts.splice(idx, 1);
    expect(withParts).toEqual(withoutParts);
  });

  test("names $OUTDIR both ways: the env var (bash) and the literal absolute path (write/edit)", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER" });
    expect(out).toContain("$OUTDIR");
    expect(out).toContain("/tmp/OUTDIR-MARKER");
  });

  test("workdirLess: true — $OUTDIR is the DEFAULT DIRECTORY, scratch to $TMPDIR, don't ask to write elsewhere", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: true });
    expect(out).toContain("$TMPDIR");
    expect(out).toContain("no project directory");
    expect(out).toMatch(/do not ask to write elsewhere/i);
    expect(out).toMatch(/is your default directory/i);
  });

  // THE regression pin for s_bfadc28c2751: a session WITH a working directory built its entire
  // deliverable inside $OUTDIR because the block's one unconditional line ("anything you're
  // handing the user goes there") never named the working directory at all. The with-dirs branch
  // must now name it, prefer it, and demote $OUTDIR to a mailbox.
  test("workdirLess: false (with-dirs) NAMES the working directory and demotes $OUTDIR to a mailbox", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const withDirs = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false });
    // the working directory is named as a literal absolute path — the thing the old block never did
    expect(withDirs).toContain(`\`${cwd}\``);
    expect(withDirs).toMatch(/your working directory for this session is/i);
    expect(withDirs).toMatch(/Work there by DEFAULT, and strongly prefer it/);
    // $OUTDIR is still named both ways (a deliverable must still be reachable), but as a mailbox
    expect(withDirs).toContain("$OUTDIR");
    expect(withDirs).toContain("/tmp/OUTDIR-MARKER");
    expect(withDirs).toMatch(/MAILBOX, not a workspace/);
    expect(withDirs).toMatch(/only when the user asks you to send or deliver/i);
    // and the retired unconditional line is GONE from this branch — the exact wording that
    // steered s_bfadc28c2751 into the outbox
    expect(withDirs).not.toContain("anything you're handing the user goes there");
    // the workdir-less branch's own lines stay out of it
    expect(withDirs).not.toContain("no project directory");
    expect(withDirs).not.toContain("$TMPDIR");
  });

  test("the two branches are genuinely different text, not one plus extras", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const withDirs = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false });
    const workdirLess = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: true });
    const block = (s: string) => s.split("\n\n").find((p) => p.startsWith("## Workspace"))!;
    expect(block(withDirs)).not.toBe(block(workdirLess));
    // the workdir-less branch must NEVER name the cwd it was handed: engine.ts passes the session
    // TMP dir there (`primary ?? sessionTmpDir(sessionId)`), so naming it would advertise scratch
    // as the working directory — the exact inversion this branch exists to avoid.
    expect(workdirLess).not.toContain(cwd);
  });

  test("cwd null with workdirLess unset still renders the no-directory branch — never an `undefined` path in the prompt", () => {
    const { home, trust, skills } = setup();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd: null, outDir: "/tmp/OUTDIR-MARKER" });
    expect(out).toContain("no project directory");
    expect(out).not.toContain("undefined");
  });

  test("extraDirs: listed in the with-dirs branch only when the session actually has more than one", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const none = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false });
    expect(none).not.toMatch(/you may also write in/i);
    const some = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false, extraDirs: ["/tmp/DIR-B", "/tmp/DIR-C"] });
    expect(some).toMatch(/you may also write in/i);
    expect(some).toContain("/tmp/DIR-B");
    expect(some).toContain("/tmp/DIR-C");
  });

  test("extraDirs absent vs [] is byte-identical — the pre-existing-caller bar", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    expect(a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false }))
      .toBe(a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: false, extraDirs: [] }));
  });

  test("extraDirs never leak into the workdir-less branch — no directory to add them to", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", workdirLess: true, extraDirs: ["/tmp/DIR-B"] });
    expect(out).not.toContain("/tmp/DIR-B");
  });

  test("basePromptOverride set (dispatch/chat): no block at all, even with outDir present — dispatch/chat swap the base slot entirely", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", basePromptOverride: "DISPATCH_BASE" });
    expect(out).not.toContain("## Workspace");
  });

  test("skipOutputStyle (dispatch CHILD) does NOT suppress the block — orthogonal to style, a dispatch child is a real code session with a real $OUTDIR", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const a = new ContextAssembler({ normaHome: home, trust, skills });
    const out = a.assemble({ cwd, outDir: "/tmp/OUTDIR-MARKER", skipOutputStyle: true });
    expect(out).toContain("## Workspace");
  });
});

// ── workdir-less MEMDIR = the shared `_assistant` bucket (spec §2) ────────────────────────────

describe("assemble() workdir-less MEMDIR redirection (working-directories T6)", () => {
  test("workdirLess: true redirects the project memory branch to memory.assistantDir() — the SAME closure chat/dispatch's memoryBucket:\"assistant\" branch already reads, not a second computation", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    const projectDir = join(home, "projects", "some-project-key", "memory");
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => projectDir, assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd, workdirLess: true });
    // Unlike the read-only chat/dispatch branch (context-assistant.test.ts), a workdir-less CODE
    // session HAS write tools, so it gets the full protocol block — just pointed at the assistant
    // bucket's path instead of the project one.
    expect(out).toContain("NO dedicated memory tools"); // the protocol block IS present (has write tools)
    expect(out).toContain(assistantDir); // pointed at the shared bucket...
    expect(out).not.toContain(projectDir); // ...never the project one
  });

  test("workdirLess absent/false (with-dirs session): keeps memory.dirFor(cwd) — byte-identical to pre-T6", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    const projectDir = join(home, "projects", "some-project-key", "memory");
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => projectDir, assistantDir: () => assistantDir },
    });
    const out = a.assemble({ cwd });
    expect(out).toContain(projectDir);
    expect(out).not.toContain(assistantDir);
  });

  test("memoryBucket: \"assistant\" (chat/dispatch) is unaffected by workdirLess — mutually exclusive branches, the assistant-mode read-only shape survives untouched", () => {
    const { home, trust, skills } = setup();
    const cwd = realDir();
    const assistantDir = assistantMemoryDirFor({ normaHome: home });
    const projectDir = join(home, "projects", "some-project-key", "memory");
    mkdirSync(assistantDir, { recursive: true });
    writeFileSync(join(assistantDir, "MEMORY.md"), "- [Alex](alex.md) — builds Norma\n");
    const a = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => projectDir, assistantDir: () => assistantDir },
    });
    // workdirLess is TRUE here too — proving memoryBucket:"assistant" still wins first (the `else
    // if` ordering in context.ts) and stays in its own no-protocol shape regardless.
    const out = a.assemble({ cwd, memoryBucket: "assistant", workdirLess: true });
    expect(out).toContain("Assistant memory index");
    expect(out).not.toContain("NO dedicated memory tools");
  });
});
