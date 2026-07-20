import { describe, expect, test } from "bun:test";
import { READONLY_HEADS, READONLY_SUBCOMMANDS, readOnlyBash } from "../../src/agent/readonly-bash";

// SP-approvals Task 2: `readOnlyBash` — a deterministic classifier that proves a bash command is
// read-only (may run without a human approval card). SECURITY-SENSITIVE: fail-to-ask always — any
// doubt returns `false` ("no opinion", not "unsafe"; the caller's normal approval flow decides
// from there). This suite is the property-test matrix from the task brief, verbatim: every
// MUST-REJECT and MUST-ALLOW fixture gets its OWN `test()` (not a shared loop with one `expect()`
// inside it) so a regression is pinpointed to the exact fixture that broke, and so TDD's initial
// red run shows the complete failure picture in one go rather than stopping at the first one.

describe("readOnlyBash — MUST-REJECT fixtures (task brief's exact matrix)", () => {
  test("rm -rf /tmp/x — mutating command, not on any allow table", () => {
    expect(readOnlyBash("rm -rf /tmp/x")).toBe(false);
  });

  test("git push — git subcommand not in the read-only set", () => {
    expect(readOnlyBash("git push")).toBe(false);
  });

  test("sed -i '' s/a/b/ f — in-place stream editor, not on any allow table", () => {
    expect(readOnlyBash("sed -i '' s/a/b/ f")).toBe(false);
  });

  test("find . -delete — find's own action flag mutates", () => {
    expect(readOnlyBash("find . -delete")).toBe(false);
  });

  test("find . -exec rm {} \\; — -exec runs an arbitrary command per match", () => {
    expect(readOnlyBash("find . -exec rm {} \\;")).toBe(false);
  });

  test("find . -execdir rm {} \\; — same as -exec, run from the match's own directory", () => {
    expect(readOnlyBash("find . -execdir rm {} \\;")).toBe(false);
  });

  test("find . -ok rm {} \\; — same as -exec, just prompts first", () => {
    expect(readOnlyBash("find . -ok rm {} \\;")).toBe(false);
  });

  test("cat > f — unquoted redirect (overwrite)", () => {
    expect(readOnlyBash("cat > f")).toBe(false);
  });

  test("cat >> f — unquoted redirect (append)", () => {
    expect(readOnlyBash("cat >> f")).toBe(false);
  });

  test("cat < f > g — input AND output redirect", () => {
    expect(readOnlyBash("cat < f > g")).toBe(false);
  });

  test("ls 2>err — fd-prefixed redirect", () => {
    expect(readOnlyBash("ls 2>err")).toBe(false);
  });

  test("echo hi | tee f — pipeline's second segment writes to a file", () => {
    expect(readOnlyBash("echo hi | tee f")).toBe(false);
  });

  test("echo $(rm -rf x) — command substitution", () => {
    expect(readOnlyBash("echo $(rm -rf x)")).toBe(false);
  });

  test("backtick command substitution is rejected", () => {
    expect(readOnlyBash("echo `rm x`")).toBe(false);
  });

  test("diff <(ls) <(ls) — process substitution", () => {
    expect(readOnlyBash("diff <(ls) <(ls)")).toBe(false);
  });

  test("FOO=bar ls — leading environment assignment", () => {
    expect(readOnlyBash("FOO=bar ls")).toBe(false);
  });

  test("ls & — backgrounding", () => {
    expect(readOnlyBash("ls &")).toBe(false);
  });

  test("sudo ls — privilege escalation, hard deny-listed", () => {
    expect(readOnlyBash("sudo ls")).toBe(false);
  });

  test("xargs rm — builds and runs arbitrary commands, hard deny-listed", () => {
    expect(readOnlyBash("xargs rm")).toBe(false);
  });

  test("sh -c ls — shell, hard deny-listed", () => {
    expect(readOnlyBash("sh -c ls")).toBe(false);
  });

  test('bash -c "ls" — shell, hard deny-listed', () => {
    expect(readOnlyBash('bash -c "ls"')).toBe(false);
  });

  test("zsh -c ls — shell, hard deny-listed", () => {
    expect(readOnlyBash("zsh -c ls")).toBe(false);
  });

  test("eval ls — re-parses and executes its argument, hard deny-listed", () => {
    expect(readOnlyBash("eval ls")).toBe(false);
  });

  test("exec ls — replaces the process image, hard deny-listed", () => {
    expect(readOnlyBash("exec ls")).toBe(false);
  });

  test("git commit -m x — git subcommand not in the read-only set", () => {
    expect(readOnlyBash("git commit -m x")).toBe(false);
  });

  test("npm install — npm subcommand not in the read-only set", () => {
    expect(readOnlyBash("npm install")).toBe(false);
  });

  test("brew install jq — brew subcommand not in the read-only set", () => {
    expect(readOnlyBash("brew install jq")).toBe(false);
  });

  test("cat f; rm f — sequencer chains on a second, mutating command", () => {
    expect(readOnlyBash("cat f; rm f")).toBe(false);
  });

  test("ls && rm f — sequencer chains on a second, mutating command", () => {
    expect(readOnlyBash("ls && rm f")).toBe(false);
  });

  test('quoting trick: "r"m x — concatenated quoted parts still resolve argv0 to `rm`', () => {
    expect(readOnlyBash('"r"m x')).toBe(false);
  });

  test("quoting trick: 'rm' x — single-quoted argv0 still resolves to `rm`", () => {
    expect(readOnlyBash("'rm' x")).toBe(false);
  });

  test("ANSI-C quoting ($'...') is rejected in any $' form", () => {
    expect(readOnlyBash("cat $'\\x66'")).toBe(false);
  });

  test("heredoc redirect (<<EOF)", () => {
    expect(readOnlyBash("cat <<EOF")).toBe(false);
  });
});

describe("readOnlyBash — MUST-ALLOW fixtures (task brief's exact matrix)", () => {
  test("cat foo.txt", () => {
    expect(readOnlyBash("cat foo.txt")).toBe(true);
  });

  test("ls -la", () => {
    expect(readOnlyBash("ls -la")).toBe(true);
  });

  test("grep -rn TODO src", () => {
    expect(readOnlyBash("grep -rn TODO src")).toBe(true);
  });

  test('rg "foo" --json', () => {
    expect(readOnlyBash('rg "foo" --json')).toBe(true);
  });

  test("head -50 x | tail -10 — read-only pipeline", () => {
    expect(readOnlyBash("head -50 x | tail -10")).toBe(true);
  });

  test("git status", () => {
    expect(readOnlyBash("git status")).toBe(true);
  });

  test("git log --oneline -5", () => {
    expect(readOnlyBash("git log --oneline -5")).toBe(true);
  });

  test("git diff HEAD~1", () => {
    expect(readOnlyBash("git diff HEAD~1")).toBe(true);
  });

  test("git show abc123", () => {
    expect(readOnlyBash("git show abc123")).toBe(true);
  });

  test("git branch -a", () => {
    expect(readOnlyBash("git branch -a")).toBe(true);
  });

  test("git rev-parse HEAD", () => {
    expect(readOnlyBash("git rev-parse HEAD")).toBe(true);
  });

  test("git stash list — the two-token special case", () => {
    expect(readOnlyBash("git stash list")).toBe(true);
  });

  test('find . -name "*.ts"', () => {
    expect(readOnlyBash('find . -name "*.ts"')).toBe(true);
  });

  test("wc -l a b", () => {
    expect(readOnlyBash("wc -l a b")).toBe(true);
  });

  test("echo hello", () => {
    expect(readOnlyBash("echo hello")).toBe(true);
  });

  test("printf '%s\\n' hi", () => {
    expect(readOnlyBash("printf '%s\\n' hi")).toBe(true);
  });

  test("jq .name package.json", () => {
    expect(readOnlyBash("jq .name package.json")).toBe(true);
  });

  test("npm ls", () => {
    expect(readOnlyBash("npm ls")).toBe(true);
  });

  test("sort f | uniq -c | head — three-segment read-only pipeline", () => {
    expect(readOnlyBash("sort f | uniq -c | head")).toBe(true);
  });

  test("swift --version", () => {
    expect(readOnlyBash("swift --version")).toBe(true);
  });

  test("xcodebuild -version", () => {
    expect(readOnlyBash("xcodebuild -version")).toBe(true);
  });
});

describe("readOnlyBash — structural fixtures", () => {
  test("empty string -> false", () => {
    expect(readOnlyBash("")).toBe(false);
  });

  test("whitespace-only -> false", () => {
    expect(readOnlyBash("   ")).toBe(false);
    expect(readOnlyBash("\t")).toBe(false);
  });

  test("git with an unknown subcommand -> false", () => {
    expect(readOnlyBash("git checkout x")).toBe(false);
  });

  test("a pipe of an allowed segment into a rejected one -> false (the WHOLE pipeline must be read-only)", () => {
    expect(readOnlyBash("ls | xargs rm")).toBe(false);
  });
});

describe("READONLY_HEADS / READONLY_SUBCOMMANDS — exported tables", () => {
  test("READONLY_HEADS contains exactly the brief's 50 heads", () => {
    const expected = [
      "cat", "head", "tail", "less", "more", "ls", "pwd", "wc", "file", "stat", "du", "df",
      "which", "whereis", "whoami", "id", "date", "uptime", "uname", "sw_vers", "hostname",
      "printenv", "basename", "dirname", "realpath", "readlink", "echo", "printf",
      "grep", "rg", "fgrep", "egrep", "find", "fd", "tree",
      "sort", "uniq", "cut", "tr", "column",
      "diff", "cmp", "comm", "md5", "shasum", "od", "xxd", "strings", "jq", "yq",
    ];
    for (const head of expected) {
      expect(READONLY_HEADS.has(head)).toBe(true);
    }
    expect(READONLY_HEADS.size).toBe(expected.length);
  });

  test("mutating/dangerous commands are never in READONLY_HEADS", () => {
    for (const head of ["rm", "mv", "cp", "chmod", "chown", "chgrp", "mkdir", "rmdir", "kill", "sed", "sudo", "sh", "bash", "zsh", "eval", "exec", "tee", "xargs"]) {
      expect(READONLY_HEADS.has(head)).toBe(false);
    }
  });

  test("READONLY_SUBCOMMANDS has exactly the brief's keys", () => {
    expect(Object.keys(READONLY_SUBCOMMANDS).sort()).toEqual(["brew", "git", "npm", "pnpm", "swift", "xcodebuild"]);
  });

  test("git's read-only subcommand set matches the brief exactly", () => {
    const git = READONLY_SUBCOMMANDS.git;
    expect(git).toBeDefined();
    const expected = ["status", "log", "diff", "show", "branch", "remote", "tag", "describe", "rev-parse", "ls-files", "blame", "shortlog"];
    for (const sub of expected) expect(git!.has(sub)).toBe(true);
    expect(git!.size).toBe(expected.length);
  });

  test("git's mutating subcommands are never in the read-only set ('stash' alone included — only 'git stash list' is allowed, via the special-case)", () => {
    const git = READONLY_SUBCOMMANDS.git!;
    for (const sub of ["push", "commit", "checkout", "merge", "rebase", "reset", "clean", "add", "stash", "pull", "fetch", "apply", "cherry-pick"]) {
      expect(git.has(sub)).toBe(false);
    }
  });

  test("npm/pnpm/brew read-only subcommand sets match the brief exactly", () => {
    expect(READONLY_SUBCOMMANDS.npm!.size).toBe(3);
    for (const sub of ["ls", "view", "outdated"]) expect(READONLY_SUBCOMMANDS.npm!.has(sub)).toBe(true);
    expect(READONLY_SUBCOMMANDS.npm!.has("install")).toBe(false);

    expect(READONLY_SUBCOMMANDS.pnpm!.size).toBe(2);
    for (const sub of ["ls", "list"]) expect(READONLY_SUBCOMMANDS.pnpm!.has(sub)).toBe(true);

    expect(READONLY_SUBCOMMANDS.brew!.size).toBe(2);
    for (const sub of ["list", "info"]) expect(READONLY_SUBCOMMANDS.brew!.has(sub)).toBe(true);
    expect(READONLY_SUBCOMMANDS.brew!.has("install")).toBe(false);
  });

  test("swift/xcodebuild read-only subcommand sets match the brief exactly", () => {
    expect(READONLY_SUBCOMMANDS.swift!.size).toBe(1);
    expect(READONLY_SUBCOMMANDS.swift!.has("--version")).toBe(true);

    expect(READONLY_SUBCOMMANDS.xcodebuild!.size).toBe(3);
    for (const sub of ["-version", "-showsdks", "-list"]) expect(READONLY_SUBCOMMANDS.xcodebuild!.has(sub)).toBe(true);
  });
});

// Beyond the required matrix: cheap extra regression coverage for the algorithm's documented
// edge cases (deny-list entries not directly exercised by the brief's fixtures, argv0-path
// basenames, and a multi-hazard belt-and-braces check). None of these loosen or replace a
// required fixture above.
describe("readOnlyBash — additional regression coverage (beyond the required matrix)", () => {
  test("env and script are hard deny-listed too (named in the brief's algorithm, not in its fixture list)", () => {
    expect(readOnlyBash("env ls")).toBe(false);
    expect(readOnlyBash("env FOO=bar ls")).toBe(false);
    expect(readOnlyBash("script -q /dev/null")).toBe(false);
  });

  test("a path-qualified argv0 still resolves via basename for READONLY_HEADS", () => {
    expect(readOnlyBash("/bin/cat foo.txt")).toBe(true);
  });

  test("a path-qualified find is still subject to the action-flag veto (basename-based, not exact-string)", () => {
    expect(readOnlyBash("/usr/bin/find . -delete")).toBe(false);
  });

  test("git push chained via && after a read-only command is still fully rejected", () => {
    expect(readOnlyBash("git status && git push")).toBe(false);
  });

  test("a lone unterminated quote anywhere in the command is never read-only", () => {
    expect(readOnlyBash("cat 'unterminated")).toBe(false);
    expect(readOnlyBash('cat "unterminated')).toBe(false);
  });

  test("multiple assignments before a command are still rejected (not just the single-assignment fixture)", () => {
    expect(readOnlyBash("FOO=1 BAR=2 ls")).toBe(false);
  });
});
