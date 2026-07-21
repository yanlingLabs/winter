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
  test("READONLY_HEADS contains exactly the brief's 48 heads (50 minus less/more, review FIX 2)", () => {
    const expected = [
      "cat", "head", "tail", "ls", "pwd", "wc", "file", "stat", "du", "df",
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

  test("review FIX 2: less/more are NOT in READONLY_HEADS (LESSOPEN/LESSCLOSE arbitrary-command preprocessing hook)", () => {
    expect(READONLY_HEADS.has("less")).toBe(false);
    expect(READONLY_HEADS.has("more")).toBe(false);
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

  test("review FIX 3 supersedes this: a path-qualified argv0 no longer resolves via basename — it is rejected outright", () => {
    expect(readOnlyBash("/bin/cat foo.txt")).toBe(false);
  });

  test("a path-qualified find is still rejected — now via the simpler FIX 3 path-qualification reason, not the find-flag veto", () => {
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

// SP-approvals T2 review (coordinator round): three probe-CONFIRMED allow-side holes. Each gets
// its own describe block below, with the review's exact named probe cases plus additional
// representative coverage, every one its own test() for the same pinpoint-a-regression reason as
// the rest of this file.

describe("readOnlyBash — review FIX 1: git branch/tag/remote require tightGitFormOk", () => {
  // The review's 4 named probe cases (all previously returned true — silent mutations).
  test("git branch newname — bare positional arg CREATES a branch", () => {
    expect(readOnlyBash("git branch newname")).toBe(false);
  });

  test("git branch -D x — force-delete", () => {
    expect(readOnlyBash("git branch -D x")).toBe(false);
  });

  test("git tag -f v1 — force (re-create/move a tag)", () => {
    expect(readOnlyBash("git tag -f v1")).toBe(false);
  });

  test("git remote set-url origin url — positional subcommand mutates the remote's URL", () => {
    expect(readOnlyBash("git remote set-url origin url")).toBe(false);
  });

  // Additional branch mutations (DENY-listed or simply not in the SAFE set).
  test("git branch -d oldname — delete", () => {
    expect(readOnlyBash("git branch -d oldname")).toBe(false);
  });

  test("git branch -m old new — rename", () => {
    expect(readOnlyBash("git branch -m old new")).toBe(false);
  });

  test("git branch -M old new — force-rename", () => {
    expect(readOnlyBash("git branch -M old new")).toBe(false);
  });

  test("git branch -c old new — copy", () => {
    expect(readOnlyBash("git branch -c old new")).toBe(false);
  });

  test("git branch -C old new — force-copy", () => {
    expect(readOnlyBash("git branch -C old new")).toBe(false);
  });

  test("git branch -f main HEAD~3 — force-move a branch pointer", () => {
    expect(readOnlyBash("git branch -f main HEAD~3")).toBe(false);
  });

  test("git branch -u origin/main — set upstream", () => {
    expect(readOnlyBash("git branch -u origin/main")).toBe(false);
  });

  test("git branch --set-upstream-to=origin/main — set upstream, long form", () => {
    expect(readOnlyBash("git branch --set-upstream-to=origin/main")).toBe(false);
  });

  test("git branch --unset-upstream", () => {
    expect(readOnlyBash("git branch --unset-upstream")).toBe(false);
  });

  test("git branch --edit-description", () => {
    expect(readOnlyBash("git branch --edit-description")).toBe(false);
  });

  test("git branch -t — track, not in the safe set", () => {
    expect(readOnlyBash("git branch -t")).toBe(false);
  });

  // Additional tag mutations.
  test("git tag -d v1 — delete", () => {
    expect(readOnlyBash("git tag -d v1")).toBe(false);
  });

  test('git tag -a v1 -m "msg" — create an annotated tag', () => {
    expect(readOnlyBash('git tag -a v1 -m "msg"')).toBe(false);
  });

  test("git tag -s v1 — create a signed tag", () => {
    expect(readOnlyBash("git tag -s v1")).toBe(false);
  });

  test('git tag -m "msg" v1 — message implies tag creation', () => {
    expect(readOnlyBash('git tag -m "msg" v1')).toBe(false);
  });

  // Additional remote mutations — all positional (no leading `-`), per the review's own note.
  test("git remote add origin url", () => {
    expect(readOnlyBash("git remote add origin url")).toBe(false);
  });

  test("git remote remove origin", () => {
    expect(readOnlyBash("git remote remove origin")).toBe(false);
  });

  test("git remote rename old new", () => {
    expect(readOnlyBash("git remote rename old new")).toBe(false);
  });

  test("git remote prune origin", () => {
    expect(readOnlyBash("git remote prune origin")).toBe(false);
  });

  test("git remote update", () => {
    expect(readOnlyBash("git remote update")).toBe(false);
  });

  // Must-allow: bare forms and flags-only forms stay allowed.
  test("git branch --all", () => {
    expect(readOnlyBash("git branch --all")).toBe(true);
  });

  test("git branch -r", () => {
    expect(readOnlyBash("git branch -r")).toBe(true);
  });

  test("git branch -vv", () => {
    expect(readOnlyBash("git branch -vv")).toBe(true);
  });

  test("git branch — bare form", () => {
    expect(readOnlyBash("git branch")).toBe(true);
  });

  test("git tag — bare form", () => {
    expect(readOnlyBash("git tag")).toBe(true);
  });

  test("git remote — bare form", () => {
    expect(readOnlyBash("git remote")).toBe(true);
  });

  test("git tag -v v1 — verify a tag's signature (the value-taking exception: -v/--verify legitimately takes the tag name)", () => {
    expect(readOnlyBash("git tag -v v1")).toBe(true);
  });

  test("git tag --verify v1 — same, long flag form", () => {
    expect(readOnlyBash("git tag --verify v1")).toBe(true);
  });

  test("git remote -v", () => {
    expect(readOnlyBash("git remote -v")).toBe(true);
  });

  // A little extra SAFE-set coverage beyond the named probes.
  test("git branch --show-current", () => {
    expect(readOnlyBash("git branch --show-current")).toBe(true);
  });

  test("git branch -q", () => {
    expect(readOnlyBash("git branch -q")).toBe(true);
  });

  test("git tag -l — bare list flag, no pattern", () => {
    expect(readOnlyBash("git tag -l")).toBe(true);
  });

  // Accepted over-block (per the review): a genuinely read-only positional remote subcommand
  // (`show`) is still refused, since the starts-with-"-" gate can't distinguish it from a
  // mutating positional word like `add`/`remove`. Documented, not a bug to fix here.
  test("git remote show origin — accepted over-block (positional, indistinguishable from a mutating remote subcommand by this gate)", () => {
    expect(readOnlyBash("git remote show origin")).toBe(false);
  });
});

describe("readOnlyBash — review FIX 2: less/more removed from READONLY_HEADS", () => {
  test("less f — LESSOPEN/LESSCLOSE can make less invoke an arbitrary preprocessor command; bash.ts spreads the full daemon env, so a configured LESSOPEN fires for real", () => {
    expect(readOnlyBash("less f")).toBe(false);
  });

  test("more f — same LESSOPEN/LESSCLOSE hook risk as less", () => {
    expect(readOnlyBash("more f")).toBe(false);
  });
});

describe("readOnlyBash — review FIX 3: path-qualified argv0 rejected before any table lookup", () => {
  test("./cat x — relative path, cannot verify which binary would actually run", () => {
    expect(readOnlyBash("./cat x")).toBe(false);
  });

  test("/tmp/evil/cat x — absolute path into an attacker-writable directory", () => {
    expect(readOnlyBash("/tmp/evil/cat x")).toBe(false);
  });

  test("../cat x — parent-relative path", () => {
    expect(readOnlyBash("../cat x")).toBe(false);
  });

  test("bin/cat x — any slash anywhere in argv0 rejects, not just a leading one", () => {
    expect(readOnlyBash("bin/cat x")).toBe(false);
  });

  test("a bare (slash-free) argv0 is unaffected — still classifies normally", () => {
    expect(readOnlyBash("cat foo.txt")).toBe(true);
  });
});

describe("readOnlyBash — review MINOR: argvOf's double-quote backslash only recognizes bash's real escape set", () => {
  test('"c\\at" foo — a backslash before a non-special character no longer gets silently consumed into resolving argv0 to `cat`', () => {
    expect(readOnlyBash('"c\\at" foo')).toBe(false);
  });

  test("a quote-concatenated argv0 with NO backslash involved still resolves correctly (sanity: the tightened escape handling doesn't regress plain quote-concatenation)", () => {
    expect(readOnlyBash('"c"at foo.txt')).toBe(true);
  });
});
