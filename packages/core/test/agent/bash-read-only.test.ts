// PORTED with `src/agent/bash-read-only.ts` from Winter's own agent SDK (yanlingLabs/winter-agent-sdk,
// packages/runtime/src/permissions/bash-read-only.test.ts, v0.0.53), verbatim but for the import path: the
// SDK's own cases pin that the daemon's copy of the classifier reads every command as the runtime does.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BashReadOnlyContext, containsVulnerableUncPath, isBashCommandReadOnly, isCurrentDirectoryBareGitRepo } from "../../src/agent/bash-read-only";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bash-read-only-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A fresh, empty directory: never a bare-repo lookalike, so the git checks are deterministic.
const home = tempDir();
const ctx: BashReadOnlyContext = { cwd: home, originalCwd: home, sandboxEnabled: false };
const readOnly = (command: string, context: BashReadOnlyContext = ctx): boolean => isBashCommandReadOnly(command, context);

describe("read-only commands", () => {
  const cases: string[] = [
    "ls -la",
    "ls",
    "cat a.txt",
    'cat "my file.txt"',
    "grep -rn foo src",
    "grep -A20 foo f",
    "grep -e foo -e bar f",
    "rg x",
    "rg -n --hidden -g '*.ts' foo src",
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git log -n 3 --format=%H",
    "git diff HEAD~1",
    "git diff --cached --stat",
    "git show HEAD",
    "git blame -L 1,10 f.ts",
    "git branch",
    "git branch -a",
    "git branch --merged main",
    "git tag",
    "git tag -l",
    "git tag -l 'v1.*'",
    "git reflog",
    "git reflog show",
    "git remote -v",
    "git remote show origin",
    "git rev-parse --show-toplevel",
    "git ls-files",
    "git stash list",
    "git config --get user.name",
    "git for-each-ref --sort=-committerdate refs/heads",
    "find . -name '*.ts'",
    "find . -type f -name \"*.md\"",
    "find src \\( -name a -o -name b \\)",
    "wc -l f",
    "head -n 5 f",
    "tail -f log.txt",
    "cat f | grep x | sort | uniq -c",
    "cat f | sort -u",
    "ls && pwd",
    "ls; pwd",
    "ls;",
    "ls || pwd",
    "pwd",
    "whoami",
    "echo hi",
    "echo 'hello world'",
    'echo "-n is fine for echo"',
    "echo hi 2>&1",
    "ls 2>/dev/null",
    "ls 2>&1",
    "ls > /dev/null",
    "ls >/dev/null 2>&1",
    "xargs grep x",
    "xargs -I {} grep x {}",
    "sed -n '1,5p' f",
    "sed -n 1p f",
    "sed 's/a/b/'",
    "sed -E 's/a+/b/g'",
    "date",
    "date +%Y",
    "date -u +%Y-%m-%dT%H:%M:%S",
    "hostname",
    "hostname -f",
    "ps aux",
    "ps -ef",
    "sort -n f",
    "sort -k 2 -t , f",
    "tree -L 2",
    "fd -e ts",
    "file a.png",
    "sha256sum f",
    "stat f",
    "du -sh .",
    "df -h",
    "diff a b",
    "jq '.a' f.json",
    "jq -r .name package.json",
    "uniq -c",
    "which bun",
    "node -v",
    "python3 --version",
    "cd src",
    "cd src && ls",
    "cut -d' ' -f1 f",
    "cut -d, -f1 f",
    "basename /a/b",
    "uname -a",
    "docker ps",
    "docker logs -f web",
    "git log --format=\"%h %s\"",
    "ls \\\n  -la",
  ];
  for (const command of cases) {
    test(JSON.stringify(command), () => expect(readOnly(command)).toBe(true));
  }
});

describe("not read-only", () => {
  const cases: string[] = [
    // plain writers / unknown commands
    "rm x",
    "rm -rf /",
    "touch f",
    "mkdir d",
    "npm install",
    "bun test",
    "curl -o f u",
    "curl https://example.com",
    "tee f",
    "cat f | tee g",
    "python script.py",
    "node -v --run task",
    // redirections
    "echo hi > f",
    "cat f >> g",
    "ls >> /dev/null",
    "ls > out.txt",
    "ls &> /dev/null",
    "ls 1>&2",
    "ls 3>/dev/null",
    "cat < f",
    "cat < /dev/null",
    "cat <<'EOF'\nhi\nEOF",
    "jq . <<'EOF'\n{}\nEOF",
    "cat <<< hi",
    // substitutions, subshells, background
    "ls $(rm -rf /)",
    "ls `touch x`",
    'echo "$(whoami)"',
    "cat <(ls)",
    "(ls)",
    "{ ls; }",
    "ls &",
    "ls & rm x",
    "ls |& cat",
    "ls\nrm x",
    "ls # comment",
    "git status # note",
    // expansions and globs
    "ls *.ts",
    "cat $HOME/f",
    'cat "$HOME/f"',
    "ls ${HOME}",
    "grep 'foo$' f",
    "echo $PATH | cat",
    "ls {a,b}",
    "cat $'\\x2d'",
    // find
    "find . -delete",
    "find . -exec rm {} \\;",
    "find . -exec rm {} +",
    "find . -execdir rm {} +",
    "find . -fprint out",
    "find . -ok rm {} \\;",
    "find . -\\delete",
    "find . '-delete'",
    "find . -name x -fls out",
    // sed
    "sed -i s/a/b/ f",
    "sed -i '' s/a/b/ f",
    "sed 's/a/b/' f",
    "sed 's/a/b/w out' ",
    "sed -n '1w out' f",
    "sed 'e ls'",
    "sed -n '1p;w x' f",
    // git
    "git commit -m x",
    "git push",
    "git pull",
    "git checkout main",
    "git branch foo",
    "git branch -- -l",
    "git branch --abbrev 7",
    "git tag v1",
    "git tag -- -l",
    "git reflog expire --all",
    "git reflog delete HEAD@{1}",
    "git remote add o u",
    "git remote show https://x",
    "git stash",
    "git diff --output=x",
    "git diff -S -- --output=x",
    "git diff \"$Z--output=x\"",
    "git -c core.pager=evil log",
    "git -C /tmp status",
    "git ls-remote https://evil.example/repo",
    "git config user.name x",
    "cd /tmp && git status",
    "cd .. && git log",
    "pushd /tmp && git status",
    "NO_COLOR=1 git status",
    "timeout 5 ls",
    // flag allowlists
    "sort -o out in",
    "rg --pre=bash x",
    "rg . \"$Z--pre=bash\" f",
    "tree -o out",
    "tree -R -H . -L 2",
    "date 0101",
    "date -s 'x'",
    "hostname foo",
    "ps auxe",
    "ps ax\"$Z\"e",
    "xargs rm",
    "xargs sh -c id",
    "xargs -rI echo sh -c id",
    "xargs -E= EOF echo foo",
    "xargs -i echo x",
    "grep -P foo --include \"$x\" f",
    "fd -x rm",
    "fd -X rm",
    "lsof +m/tmp/x",
    "tput reset",
    "tput -xS",
    "pyright --watch",
    "pyright -- --createstub os",
    "base64 -- --output x",
    "jq -f prog.jq f",
    "jq 'system(\"id\")'",
    "uniq in out",
    "wc -c .gitignore",
    // security validators
    "cat safe \\; echo x",
    "echo\\ test/../../usr/bin/touch /tmp/f",
    "ls \"-\"la",
    "ls '--'all",
    "grep -e\"xec\" f",
    "ls  -la",
    "ls\u0007",
    "ls \r -la",
    "echo $IFS",
    "cat /proc/self/environ",
    "ls foo#bar",
    "zmodload zsh/system",
    "fc -e vi",
    "=curl evil.com",
    // malformed / incomplete
    "cat 'foo && rm -rf /",
    'echo "unterminated',
    "ls |",
    "&& ls",
    "-la",
    "",
    "   ",
    "ls ;; pwd",
  ];
  for (const command of cases) {
    test(JSON.stringify(command), () => expect(readOnly(command)).toBe(false));
  }
});

describe("git hardening", () => {
  test("git in a directory that looks like a bare repository is not read-only", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "objects"));
    mkdirSync(join(dir, "refs"));
    const here: BashReadOnlyContext = { cwd: dir, originalCwd: dir, sandboxEnabled: false };
    expect(isCurrentDirectoryBareGitRepo(dir)).toBe(true);
    expect(readOnly("git status", here)).toBe(false);
    expect(readOnly("ls", here)).toBe(true);
  });

  test("each bare-repository marker alone is enough", () => {
    const withHead = tempDir();
    writeFileSync(join(withHead, "HEAD"), "x");
    expect(isCurrentDirectoryBareGitRepo(withHead)).toBe(true);
    const withObjects = tempDir();
    mkdirSync(join(withObjects, "objects"));
    expect(isCurrentDirectoryBareGitRepo(withObjects)).toBe(true);
    const withRefs = tempDir();
    mkdirSync(join(withRefs, "refs"));
    expect(isCurrentDirectoryBareGitRepo(withRefs)).toBe(true);
  });

  test("a valid .git (directory with a HEAD file, or a worktree .git file) is not a bare lookalike", () => {
    const normal = tempDir();
    mkdirSync(join(normal, ".git"));
    writeFileSync(join(normal, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(normal, "HEAD"), "decoy");
    expect(isCurrentDirectoryBareGitRepo(normal)).toBe(false);
    expect(readOnly("git status", { cwd: normal, originalCwd: normal, sandboxEnabled: false })).toBe(true);

    const worktree = tempDir();
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(join(worktree, "refs"));
    expect(isCurrentDirectoryBareGitRepo(worktree)).toBe(false);
  });

  test("a .git directory whose HEAD is not a regular file falls through to the bare-repo markers", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".git", "HEAD"));
    mkdirSync(join(dir, "refs"));
    expect(isCurrentDirectoryBareGitRepo(dir)).toBe(true);
  });

  test("git outside the original cwd while sandboxed is not read-only", () => {
    const other = tempDir();
    const moved: BashReadOnlyContext = { cwd: other, originalCwd: home, sandboxEnabled: true };
    expect(readOnly("git status", moved)).toBe(false);
    expect(readOnly("ls", moved)).toBe(true);
    expect(readOnly("git status", { ...moved, sandboxEnabled: false })).toBe(true);
    expect(readOnly("git status", { cwd: home, originalCwd: home, sandboxEnabled: true })).toBe(true);
  });

  test("cd together with git is refused, cd alone is not", () => {
    expect(readOnly("cd src && ls")).toBe(true);
    expect(readOnly("cd src && git log")).toBe(false);
    expect(readOnly("git log; cd src")).toBe(false);
  });

  test("a command that creates git-internal paths and runs git is refused", () => {
    expect(readOnly("mkdir -p hooks && git status")).toBe(false);
    expect(readOnly("touch HEAD && git status")).toBe(false);
  });
});

describe("Windows UNC paths", () => {
  test("detected on Windows only, as claude", () => {
    expect(containsVulnerableUncPath("type \\\\server\\share\\f", "win32")).toBe(true);
    expect(containsVulnerableUncPath("cat //server/share/f", "win32")).toBe(true);
    expect(containsVulnerableUncPath("cat \\\\evil@SSL@8443\\x", "win32")).toBe(true);
    expect(containsVulnerableUncPath("cat \\\\server\\DavWWWRoot\\x", "win32")).toBe(true);
    expect(containsVulnerableUncPath("curl https://example.com/x", "win32")).toBe(false);
    expect(containsVulnerableUncPath("cat //server/share/f", "darwin")).toBe(false);
  });
});

describe("robustness", () => {
  test("over the parser limit", () => {
    expect(readOnly(`ls ${"a ".repeat(30_000)}`)).toBe(false);
  });

  test("over the read-only length limit (4096)", () => {
    expect(readOnly(`ls ${"a".repeat(4_000)}`)).toBe(true);
    expect(readOnly(`ls ${"a".repeat(4_100)}`)).toBe(false);
  });

  test("pathological input does not stall (every check is linear)", () => {
    const near = 4_090;
    const inputs = [
      `ls ${"{".repeat(near)}`,
      `ls ${"{a ".repeat(near / 3)}`,
      `jq "${";".repeat(near)}"x`,
      `find . -name ${'"'.repeat(near)}`,
      `cat ${"${".repeat(near / 2)}IFS`,
      `ls ${"\n".repeat(near)}x`,
      `cat ${"/proc/".repeat(near / 6)}`,
      `echo ${"'a' ".repeat(near / 4)}`,
      `jq ${"-a ".repeat(near / 3)}`,
      `find ${" -name x".repeat(near / 8)}`,
      `ls ${"{".repeat(40_000)}`,
      `jq "${";".repeat(40_000)}"x`,
      // An `ls` followed by thousands of newlines, and long backslash runs, used to take 15-120 ms.
      `ls ${"\n".repeat(4_093)}`,
      `ls ${"\\".repeat(4_093)}`,
      `ls${"\\\\".repeat(2_046)}`,
      `ls ${"'".repeat(4_093)}`,
      `ls\n${" ".repeat(4_092)}`,
      `git branch ${"\n".repeat(4_080)}`,
      `sed -n ${"\\\\".repeat(2_040)}`,
      `sort ${"''".repeat(2_040)}`,
      `grep ${"{,".repeat(2_040)}`,
      `ls ${"-name '".repeat(580)}`,
      `ls ${"$x>".repeat(1_360)}`,
      `ls ${" 2>&1".repeat(800)}`,
    ];
    for (const input of inputs) {
      readOnly(input);
      const start = performance.now();
      readOnly(input);
      expect(performance.now() - start).toBeLessThan(25);
    }
  });
});

// -----------------------------------------------------------------------------------------------------
// The specification of each part, pinned case by case
// -----------------------------------------------------------------------------------------------------

function expectAll(commands: readonly string[], expected: boolean): void {
  for (const command of commands) {
    test(`${expected ? "read-only" : "not read-only"}: ${JSON.stringify(command)}`, () => expect(readOnly(command)).toBe(expected));
  }
}

describe("flag tables: how options are read", () => {
  describe("accepted forms", () => {
    expectAll(
      [
        "grep -rn foo .", // a cluster of argument-less flags
        "sort -nr f",
        "xargs -r0t echo",
        "grep -A 5 x f", // a valued flag with a separate value
        "sort --key 2 f",
        "git log --format=%H", // `--flag=value`
        "sort --key=2 f",
        "git log --max-count=5",
        "git rev-parse --short=8 HEAD",
        "fd -d=2 x",
        "grep -e=x f",
        "git log -5", // git's `-<count>`
        "grep -A20 foo f", // grep/rg's numeric value glued to its flag
        "grep -C3 x f",
        "grep -m1 x f",
        "rg -A2 x",
        "git branch -vv", // a multi-letter short entry of the table
        "git branch --sort=-committerdate", // git's --sort reverses with a leading `-`
        "git log -S foo",
        "sort -S 10M f",
        "fd -d 2 x",
        "xargs -d , grep x", // one character
        "xargs -I {} grep x {}", // exactly `{}`
        "xargs -E EOF grep x", // exactly `EOF`
        "xargs -0 -n 1 grep x",
        "xargs -- grep x",
        "xargs -0",
        "grep -- -o f", // after `--`, a dash word is an operand
        "sort -- -o",
        "git config --get -- user.name",
      ],
      true,
    );
  });
  describe("refused forms", () => {
    expectAll(
      [
        "sort -uo x f", // a cluster holding a flag that takes a value
        "grep -rA5 x f",
        "rg -nA2 x",
        "git log --oneline=x", // a no-argument flag given a value
        "git log -n abc", // a number that is not one
        "xargs -n x grep",
        "git log --max-count=x",
        "fd -d x",
        "sort --outp=x", // GNU abbreviations are never expanded
        "sort --out=x f",
        "git log --form=x",
        "sort --rev f",
        "sort '-r' f", // a quoted flag
        'sort "-r" f',
        "grep -e -x f", // a string value that looks like a flag
        "git branch --sort -committerdate",
        "xargs -d ab grep x",
        "xargs -I X grep",
        "xargs -E FOO grep x",
        "xargs -E= EOF echo foo", // `-E=` carries an EMPTY value
        "git diff -M50", // attached values are not read (except grep/rg counts)
        "git log -Sfoo",
        "sort -k2 f",
        // STRICTER (this rewrite): a cluster carrying `=`, a non-ASCII dash, any dash word that is not a flag.
        "sort -nr=x f",
        "grep -A20=x foo f",
        "sort -‐o x",
        "sort -.x x",
        "tree -=n x",
      ],
      false,
    );
  });
});

describe("`--` and programs that forward later words as options (fix A)", () => {
  describe("refused: git hands stash/reflog arguments on to git log / git diff, `--` included", () => {
    expectAll(
      [
        "git stash list -- --output=/tmp/x",
        "git stash list -- --output /tmp/x",
        "git stash list --oneline -- --format=%B --output=.git/config",
        "git stash list -- --ext-diff -p",
        "git stash list -n 1 -- --output=/tmp/x",
        "git stash show -- --output=/tmp/x",
        "git reflog show -- --output=/tmp/x",
        "git reflog -- expire",
        "git ls-remote -- --upload-pack=sh",
        "tree -- -o x",
        "lsof -- -Db",
        "base64 -- --output x",
        "pyright -- --createstub os",
      ],
      false,
    );
  });
  describe("still read-only", () => {
    expectAll(
      [
        "git log -- --output=x", // git log reads paths after `--`
        "git diff -- --output=x",
        "git show -- --output=x",
        "git stash list --",
        "git stash show -- -p",
        "git reflog show --",
        "git ls-remote -- origin",
        "tree -- x",
        "lsof -- x",
        "base64 -- f",
      ],
      true,
    );
  });
});

describe("date (fix B): only `+FORMAT` positionals", () => {
  describe("read-only", () => {
    expectAll(
      ["date", "date +%s", "date -u", "date -u +%s", 'date "+%s %N"', "date -d yesterday +%s", "date -r f", "date -r f +%s", "date --iso-8601=seconds", "date --rfc-3339=ns", "date -I", "date -- +%s"],
      true,
    );
  });
  describe("not read-only", () => {
    expectAll(
      [
        "date 1234",
        "date 0101010199",
        "date -u 0101000026",
        "date -- 0101000026",
        "date -s 2020",
        "date --set=2020",
        "date --set 2020",
        "date --se=2020",
        "date -us 2020",
        "date -f /tmp/x",
        "date --iso-8601 0101000026", // a detached word is a positional, not the flag's value
        "date --rfc-3339 0101000026",
        "date --iso-8601 seconds",
        "date --iso-8601", // the value is required, written `=VALUE`
        "date -Iseconds",
        "date -",
        'date "\\+%s"',
      ],
      false,
    );
  });
});

describe("xargs (fix C): the first operand is the command it runs", () => {
  expectAll(["xargs -", "xargs - echo", "xargs -0 -", "xargs -- -", "xargs --", "xargs '' echo", 'xargs -I "\\{}" echo x', "xargs -I{} echo {}"], false);
  expectAll(["xargs", "xargs echo", "xargs -- echo", "xargs -0 -n 1 echo", "xargs -I {} echo {}"], true);
});

describe("a backslash bash keeps inside double quotes (fix E)", () => {
  describe("a word that starts with one is refused", () => {
    expectAll(
      [
        'git branch "\\--contains" newbr',
        'date "\\-d" 0101000026',
        'tput "\\-T" reset',
        'git remote show "\\-n" origin',
        'git tag "\\-l" newtag',
        'git tag "\\--list" newtag',
        'sort "\\-o" x',
        'xargs "\\-0" sh',
        'xargs -I "\\{}" echo x',
        'git reflog "\\--since" expire',
        'lsof "\\-D" b',
        'git branch -l "\\x"',
        'sed -n "1\\p"',
        'sed "s/a/b/\\w x"',
        'sed -n "\\p"',
        "sed 's/a/b/' \"\\-i\"",
        'grep "\\-e" x',
        'tree "\\-o" x',
        'git diff "\\--output=x"',
        'date "\\+%s"',
        'date "\\-r" 0101000026',
        'git branch --merged "\\-D" x',
        // before `-`, `+`, `{` or `}` it is refused even for a pattern tool
        'grep "\\-v" f',
        'rg "\\+x" .',
        'rg "\\{}" .',
        'find . -name "\\-delete"',
        // for a command that takes no patterns, any leading kept backslash is refused
        'cat "\\x"',
        'git log "\\HEAD"',
        'ls "\\a"',
      ],
      false,
    );
  });
  describe("a regex or glob pattern for grep, rg, git grep, fd, find or sed keeps it", () => {
    expectAll(
      [
        'rg "\\bword\\b" .',
        'grep "\\d+" f',
        'grep -E "\\w+" f',
        'rg -n "\\s+x" src',
        'git grep "\\bfoo"',
        'fd "\\.ts"',
        'find . -name "\\*.ts"',
        'rg "\\\\.ts" .', // an escaped backslash reads the same to every reader
      ],
      true,
    );
  });
  describe("elsewhere in a word, single-quoted, or escaped, it is fine", () => {
    expectAll(['grep "foo\\.bar" f', "rg '\\bword\\b' .", 'grep "\\\\x" f', "grep 'a\\-b' f", 'cat "a\\b"'], true);
  });
  describe("a `$` in a pattern is still refused, as before (it may expand)", () => {
    expectAll(['rg "\\\\.ts$" .', "rg '\\.ts$' ."], false);
  });
});

describe("sed", () => {
  describe("read-only shapes", () => {
    expectAll(
      [
        "sed -n 1p f",
        "sed -n '1,5p' f",
        "sed -n p",
        "sed -n '1p;2p' f",
        "sed -n '1,5p;10p' f",
        "sed -n ' 1p '",
        "sed --quiet 1p f",
        "sed -nE 1p f",
        "sed -z -n 1p",
        "sed --posix -n 1p f",
        "sed -n -- 1p f",
        "sed 's/a/b/'",
        "sed 's/a/b/g'",
        "sed -E 's/a+/b/2g'",
        "sed 's/a/b/gI'",
        "sed 's/a/b/p'",
        "sed 's/a/b/3'",
        "sed 's/a/b/m'",
        "sed 's/a/b/' -E",
        "sed -r 's/(a)/\\1/'",
        "sed 's/a/\\n/'",
        "sed 's/\\\\/x/'",
      ],
      true,
    );
  });
  describe("writes, executes, or is not one of the two shapes", () => {
    expectAll(
      [
        "sed -i s/a/b/ f",
        "sed --in-place s/a/b/ f",
        "sed -n 'w /tmp/x'",
        "sed 's/a/b/w /tmp/x'",
        "sed 's/a/b/e'",
        "sed 's/a/b/W x'",
        "sed 's/a/b/w'",
        "sed -n '1w /tmp/x' f",
        "sed e",
        "sed -n 1e",
        "sed -n 'p;e'",
        "sed -n '1p;w x' f",
        "sed 's/a/b/;w x'",
        "sed 'y/a/b/;w x'",
        "sed -n '/x/w out'",
        "sed -n p -f script",
        "sed --file=script",
        "sed -n -e 1p -e 2p f", // -e/--expression is never accepted
        "sed -e 's/a/b/'",
        "sed -n --expression=1p f",
        "sed 's/a/b/' f", // a substitution reads stdin only
        "sed 's/a/b/;s/c/d/'",
        "sed 'y/a/b/'",
        "sed -n '$p' f",
        "sed -n '1,$p'",
        "sed -n '/x/p'",
        "sed 's|a|b|'",
        "sed 's/a\\/c/b/'", // an escaped delimiter
        "sed 's/[/]/x/'", // a bracketed delimiter
        "sed 's/a/b'",
        "sed 's/a/b/c/'",
        "sed 's/a/b/12'",
        "sed 's/a/b/1g2'",
        "sed 's/a/b/0'",
        "sed 's/#/x/'",
        "sed -n '1p #c'",
        "sed -n '1 p'",
        "sed -n '1p;'",
        "sed -n '1,2,3p'",
        "sed -n ''",
        "sed -n",
        "sed -n 'p' -u",
        "sed -s -n p f",
        "sed -n -s 1p f",
        "sed --debug -n 1p",
        "sed -l 5 -n 1p",
        "sed 's/a/b/' -n",
        "sed -n 's/a/b/p'",
        "sed -n 1p -- -i f",
        "sed 's/key/value/'", // STRICTER: `y` with `e`/`w` anywhere is refused, harmless or not
        "sed 's/a e/b/'",
        "sed 's/a/!/'",
        "sed 's/1~2/x/'",
        "sed 's/a,-/b/'",
        "sed 's/a\\|b/c/'",
      ],
      false,
    );
  });
});

describe("Windows UNC paths: more shapes", () => {
  const unc = (text: string): boolean => containsVulnerableUncPath(text, "win32");
  test("network locations", () => {
    for (const text of ["type \\\\1.2.3.4\\x", "type //1.2.3.4/x", "type \\\\[::1]\\x", "cat //[fe80::1]/x", "cat x@443@SSL", "cat /\\\\server", "cat \\\\/server", "cat a//b", "cat http:///x", "cat C:\\\\x"]) {
      expect(unc(text)).toBe(true);
    }
    // STRICTER: a mixed pair of separators counts as one.
    expect(unc("cat /\\a")).toBe(true);
  });
  test("not network locations", () => {
    for (const text of ["curl https://example.com/x", "cat a/b", "cat a\\b", "ls //", "ls \\\\ x", "cat ./x"]) {
      expect(unc(text)).toBe(false);
    }
  });
  test("refuses the command on Windows only", () => {
    expect(containsVulnerableUncPath("cat \\\\server\\share", "linux")).toBe(false);
  });
});

describe("lexical pre-checks, one by one", () => {
  describe("refused", () => {
    expectAll(
      [
        "ls \u0001", // a control character
        "ls 'x\\'", // a single-quoted span ending in an odd backslash run
        "ls 'x\\\\' 'y'", // ...or in any run, with another quote mark after it
        "\tls", // starts with a tab
        "; ls", // starts with an operator
        "jq -L x .", // jq reading files
        "jq -nf x",
        "jq --rawfile a f .",
        "jq --slurpfile a f .",
        "jq '. | system (\"x\")'",
        'grep -e"foo" f', // a quote mark inside a flag's name
        "ls -l'a'",
        'ls -"l"a',
        "ls ''-la", // quote marks glued to a dash
        "ls '' -la",
        "grep -e '' -r .",
        'ls "-"', // STRICTER: a word opening with a quote whose value starts with `-`
        'echo "-n" | cat',
        "ls $'x'", // ANSI-C / locale quoting
        'ls $"x"',
        "tr -d \"'\"", // three quote marks opening a word
        "grep \"x 'a;b' y\" f", // a separator inside quote marks
        "find . -name \"'a|b'\"",
        'jq ".a;.b" f',
        "cat f | grep $x", // a variable next to a pipe
        "echo $x | cat",
        "ls >/dev/nullx", // not a harmless redirection
        "ls >/dev/null</dev/null",
        "ls 2 >& 1",
        "ls # it's", // a comment holding a quote mark
        "ls 'a\n#b'", // a quoted line break before a comment line
        'ls "a\n # b"',
        "ls\\\n-la", // a line break that is not a ` \`-continuation
        "ls $IFS",
        "cat /proc/1/environ",
        'ls "`id`"', // a live backtick
        "ls x\\ y", // an escaped blank / operator outside quotes
        "ls x\\;y",
        "ls \\#a", // a `#` glued to a word
        "ls a\\#",
        "ls {1..3}", // brace expansion
        "ls '{' x",
        "command zmodload x", // zsh builtins
        "X=1 zmodload x",
        "fc -le",
        'ls "a{" ; ls', // an unbalanced word next to a separator
        "ls 'a\"' ; ls",
        "ls =(x)", // substitution spellings
        "ls x =y",
        "ls x<#y",
      ],
      false,
    );
  });
  describe("accepted", () => {
    expectAll(
      [
        "ls 'x\\\\'",
        "  ls",
        "ls -la\n",
        "ls \\\n-la",
        "jq -nr . f",
        "cut -d'\"' -f1 f", // after `cut -d`, a quote begins the value
        "cut -d',' -f1 f",
        "ls -l'.'", // a quote followed by a non-name character begins a value
        "ls --color=\"auto\"",
        'git log --format="%h %s"',
        'git log --format=""',
        "grep '' f",
        'echo "-n is fine"',
        'grep "a;b" f',
        "jq '.a;.b' f",
        "cat f 2>/dev/null",
        "cat f 2> /dev/null",
        "cat f 2 >/dev/null",
        "ls >/dev/null 2>&1",
        "ls 2>&1 >/dev/null",
        "ls 2>& 1",
        "ls a'#'",
        'ls a"#"b',
        "git log @{1}",
        "git reflog show HEAD@{1}",
        'ls "x\\ y"',
        "cat /proc/environ",
      ],
      true,
    );
  });
});

describe("tokenizing, git hardening, expansions and per-command rules (pinned before they were re-derived)", () => {
  describe("read-only", () => {
    expectAll(
      [
      "ls | grep x",
      "ls && pwd || whoami; uname",
      "ls;",
      "ls 2>/dev/null",
      "ls 0>/dev/null",
      "ls 1>/dev/null",
      "ls > /dev/null",
      "ls 2>&1 | cat",
      "ls \"#x\"",
      "ls '#'",
      "ls",
      "ls\t-la",
      "ls  -la",
      "ls -la",
      "cat f|grep x",
      "cat f&&ls",
      "ls \"*\"",
      "ls '*'",
      "ls \\*",
      "ls ~",
      "ls ~/x",
      "git status",
      "ls && cd x",
      "cd x",
      "cd 'my dir'",
      "cd \"x\" && ls",
      "git tag",
      "git tag -l",
      "git tag --list",
      "git tag -l v1",
      "git tag -n 5",
      "git tag --sort=-v:refname",
      "git tag --contains HEAD",
      "git tag --merged HEAD",
      "git tag -l -- v1",
      "git tag ''",
      "git tag -l --format=x",
      "git tag --format x",
      "git tag -i -l v",
      "git branch",
      "git branch -a",
      "git branch -r",
      "git branch -vv",
      "git branch -l x",
      "git branch --list x",
      "git branch --merged",
      "git branch --merged main",
      "git branch --merged main x",
      "git branch --no-merged main x",
      "git branch --contains HEAD",
      "git branch --sort refname",
      "git branch --abbrev=7",
      "git branch -al",
      "git branch -la x",
      "git branch --points-at HEAD",
      "git reflog",
      "git reflog show",
      "git reflog show HEAD",
      "git reflog -n 5",
      "tput cols",
      "tput lines",
      "tput -T xterm cols",
      "tput -T reset cols",
      "tput -- -S",
      "tput setaf 1",
      "tput sgr0",
      "tput -V",
      "find .",
      "find . -name '*.ts'",
      "find . -type f -name x -print",
      "find . -deleted",
      "find src \\( -name a -o -name b \\)",
      "find . -newer f",
      "find . -print0",
      "find . -printf %p",
      "find . -name x -or -name y",
      "find . -regex '.*\\.ts'",
      "find . -name x | xargs grep y",
      "find -L .",
      "find . -maxdepth 1",
      "find",
      "ps aux",
      "ps -e",
      "ps -ef",
      "ps ax",
      "ps axww",
      "ps -p 1",
      "ps x",
      "git remote",
      "git remote -v",
      "git remote --verbose",
      "git remote show origin",
      "git remote show -n origin",
      "lsof",
      "lsof -i",
      "lsof -p 1",
      "lsof +D x",
      "pyright",
      "pyright src",
      "pyright -p x",
      "pyright -p x --outputjson",
      "base64 f",
      "base64 -d f",
      "cat a.txt",
      "head -n 5 f",
      "tail -f x",
      "wc -l f",
      "cat \"a b\"",
      "id",
      "uname -a",
      "true",
      "false",
      "sleep 1",
      "which bun",
      "type ls",
      "expr 1 + 1",
      "test -f x",
      "seq 10",
      "stat -f %z f",
      "du -sh .",
      "df -h",
      "diff a b",
      "cmp a b",
      "readlink f",
      "realpath f",
      "basename /a/b",
      "dirname /a/b",
      "cut -d, -f1 f",
      "tr a b",
      "docker ps",
      "docker images",
      "docker ps -a",
      "echo hi",
      "echo 'a b'",
      "echo \"a b\"",
      "echo a 2>&1",
      "pwd",
      "whoami",
      "node -v",
      "node --version",
      "python3 --version",
      "python --version",
      "claude -h",
      "history",
      "history 5",
      "alias",
      "arch",
      "arch -h",
      "ip addr",
      "ifconfig",
      "ifconfig en0",
      "jq . f",
      "jq -r .a f",
      "jq '.a' f",
      "cd",
      "cd ..",
      "cd ~/x",
      "ls -la /tmp",
      "uniq",
      "uniq -c",
      "uniq -f 1",
      "uniq --skip-fields=1",
      "git diff --stat",
      "git show HEAD:x",
      "git ls-files",
      "git rev-parse HEAD",
      "git describe --tags",
      "git cat-file -p HEAD",
      "git for-each-ref",
      "git grep foo",
      "git shortlog -s",
      "git worktree list",
      "git merge-base a b",
      "git config --get x",
      "git blame f",
      "git stash list",
      "git ls-remote origin",
      "git rev-list --count HEAD",
      ],
      true,
    );
  });
  describe("not read-only", () => {
    expectAll(
      [
      "ls; ;",
      "ls;;",
      "ls ;; pwd",
      "; ls",
      "ls |",
      "ls &&",
      "ls ||",
      "ls & pwd",
      "ls |& cat",
      "ls 3>/dev/null",
      "ls 12>/dev/null",
      "ls 2>'/dev/null'",
      "ls 2>\"/dev/null\"",
      "ls >/dev/null; pwd",
      "ls 1>&2",
      "ls >&2",
      "ls 2>&1x",
      "ls 2>&",
      "ls >",
      "ls > ;",
      "ls 2>/dev/null>/dev/null",
      "ls <<< x",
      "ls < f",
      "ls <> f",
      "ls >| f",
      "ls &> /dev/null",
      "ls >> /dev/null",
      "ls #x",
      "ls x#y",
      "ls $'x'",
      "ls $\"x\"",
      "ls \"$(id)\"",
      "ls \"${x}\"",
      "ls \"$[1]\"",
      "ls \"a$\"",
      "ls a$",
      "ls \\$x",
      "ls \"\\$x\"",
      "ls '$(x)'",
      "ls (x)",
      "ls \"(x)\"",
      "ls '(x)'",
      "ls \\(x\\)",
      "ls x\\",
      "ls 'x",
      "ls \"x",
      "ls\npwd",
      "ls \"a\nb\"",
      "ls 'a\nb'",
      "ls a\\\nb",
      "ls *",
      "ls ?",
      "ls [ab]",
      "ls a]",
      "ls \"$x\"",
      "ls '$x'",
      "ls \"$1\"",
      "ls $@",
      "ls \"$@\"",
      "ls $#",
      "ls $?",
      "ls $!",
      "ls $$",
      "ls $-",
      "ls $0",
      "ls \"$_\"",
      "ls $.",
      "ls \"a$ b\"",
      "xargs git status",
      "xargs -0 git log",
      "timeout 5 git status",
      "nice git log",
      "FOO=1 git status",
      "cd x && git status",
      "pushd x; git log",
      "popd; git log",
      "git log; cd x",
      "mkdir hooks && git status",
      "mkdir -p ./refs/x && git status",
      "mkdir /objects && git status",
      "touch HEAD && git status",
      "touch ./HEAD && git status",
      "touch HEADS && git status",
      "touch HEAD/x && git status",
      "cp a hooks/pre-commit && git log",
      "mv a refs && git log",
      "ls > hooks/x && git status",
      "git status > objects/x",
      "ls > hooks/x",
      "mkdir hooks",
      "echo x > refs && git log",
      "mkdir -- hooks && git status",
      "mkdir -p a/hooks && git status",
      "rm hooks && git status",
      "git tag v1",
      "git tag v1 -l",
      "git tag -n 5 v1",
      "git tag -ln",
      "git tag -nl v1",
      "git tag -n5 v1",
      "git tag --sort -v:refname",
      "git tag --contains HEAD v1",
      "git tag --merged HEAD v1",
      "git tag -- -l",
      "git tag --format x v1",
      "git branch x",
      "git branch --contains HEAD x",
      "git branch --sort refname x",
      "git branch --abbrev 7",
      "git branch -- x",
      "git branch -v x",
      "git reflog expire",
      "git reflog delete x",
      "git reflog exists x",
      "git reflog --all expire",
      "git reflog --since=x expire",
      "git reflog -- expire",
      "git reflog '' expire",
      "tput -Txterm cols",
      "tput reset",
      "tput -S",
      "tput -xS",
      "tput -Sx",
      "tput -T -S cols",
      "tput -- reset",
      "tput -x clear",
      "tput init",
      "tput rmcup",
      "find . -delete",
      "find . -name x -delete",
      "find . -exec ls {} \\;",
      "find . -execdir ls {} +",
      "find . -ok ls {} \\;",
      "find . -okdir ls {} \\;",
      "find . -fprint x",
      "find . -fprint0 x",
      "find . -fprintf x %p",
      "find . -fls x",
      "find . -name -delete",
      "find . -name \"-delete\"",
      "find . '-delete'",
      "find . -de\\lete",
      "find src \\\\( -name a",
      "find src ( -name a )",
      "find . -name a\\;",
      "find . -name '$x'",
      "finder .",
      "ps auxe",
      "ps e",
      "ps -p 1 e",
      "ps -o pid",
      "ps eww",
      "git remote -v show",
      "git remote add x y",
      "git remote show",
      "git remote show origin upstream",
      "git remote show https://x",
      "git remote show org/x",
      "git remote show -n",
      "lsof +m",
      "lsof +mx",
      "pyright --watch",
      "pyright -w",
      "cat f > x",
      "cat $(x)",
      "cat {a,b}",
      "cat a&b",
      "cat a;b",
      "cat a|b",
      "docker run x",
      "echo $x",
      "echo a!",
      "echo a#b",
      "echo {}",
      "echo a\\b",
      "pwd -P",
      "jq",
      "jq -n env",
      "jq '$ENV'",
      "jq --run-tests x",
      "uniq a",
      "git -c x=y status",
      "git --exec-path=/x status",
      "git --config-env=a=b status",
      "git log -c",
      ],
      false,
    );
  });
  describe("STRICTER after the re-derivation", () => {
    expectAll(
      [
        "git branch -", // a lone dash is an operand: it would name a branch
        "git reflog --since x expire", // any expire/delete/exists word, wherever it sits
        "git reflog -n 5 expire",
        "git reflog show expire",
      ],
      false,
    );
  });
});
