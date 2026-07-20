import { splitPipeline } from "./shell-scan";

/**
 * Deterministic, fail-to-ask classifier: `readOnlyBash(command)` returns `true` ONLY when the
 * command is PROVABLY read-only — safe to run without a human approval card. `false` means "no
 * opinion", not "unsafe"; the caller's normal approval flow decides from there (SP-approvals
 * Task 3's engine gate). SECURITY-SENSITIVE: a false "true" here silently runs a mutating command
 * with no human in the loop, so every check in this file is written to fail closed — any
 * ambiguity, or any construct this classifier cannot fully account for, returns `false`.
 *
 * Pipeline handling: a `|`-joined chain of read-only commands (`head f | tail -3`, `sort f |
 * uniq -c | head`) is still read-only, so `splitPipeline` (shell-scan.ts) is used here, NOT
 * `hasShellHazards` directly — `hasShellHazards` treats ANY unquoted `|` as a hazard (correct for
 * its own caller, `ruleMatches`, which only ever compares a single exact/prefix string), which
 * would wrongly reject every pipeline. `splitPipeline` returns `null` for anything that ISN'T a
 * clean `|`-only pipeline — `;`, `&&`, `||`, `&`, a literal newline, a redirect, a substitution
 * form, or an unterminated quote — and `readOnlyBash` treats a `null` split exactly like every
 * other hazard this file refuses to reason about: no opinion.
 *
 * Per-segment classification (`readOnlySegment` below): leading whitespace is stripped, a leading
 * `NAME=value` assignment rejects the segment outright (no attempt to parse "past" it —
 * `FOO=bar ls` could chain further assignments and there is no benefit to the extra complexity of
 * skipping over them), argv is extracted quote-aware (adjacent quoted/unquoted runs with no
 * separating whitespace concatenate into ONE token, so a quoting trick like `"r"m` still resolves
 * to the real argv0 `rm` — it cannot hide a mutating command's name from the classifier), and the
 * resolved argv0 must name a known read-only tool: either its basename is in `READONLY_HEADS`
 * (any arguments after it are unrestricted — these are tools that are read-only regardless of
 * flags), or it is a key in `READONLY_SUBCOMMANDS` and argv1 is in that tool's allowed-subcommand
 * set (again, anything after argv1 is unrestricted, mirroring how a `Bash(...:*)` prefix rule
 * allows free continuation) — except the one explicit two-token special case, `git stash list`,
 * which additionally requires argv2 to be exactly `"list"` (`git stash` alone also covers
 * `pop`/`apply`/`drop`/`clear`, all mutating). `find` gets one more veto after passing the above:
 * ANY of its own action flags (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`,
 * `-fprintf`, `-fls`) present anywhere in its resolved argv rejects the whole segment —
 * traversal-plus-print (find's default action) is the only read-only shape. A hard-coded
 * deny-list (`DENY_HEADS`) is also checked first, per segment, against argv0 alone (never a
 * substring-anywhere-in-argv scan, which would false-positive on e.g. `grep sh file.txt`, where
 * "sh" is an ARGUMENT, not the invoked command) — logically redundant with these names simply
 * being absent from the two allow tables (this classifier only ever allows what it recognizes),
 * kept explicit anyway as self-documentation and a guard against a future accidental addition to
 * either table.
 *
 * KNOWN GAP, deliberately not closed here (flagged in the SP-approvals T2 report instead): `git
 * branch`/`git tag`/`git remote` are read-only ONLY as a bare or flags-only invocation (`git
 * branch -a`) — the only form the required fixture matrix exercises — but this classifier's
 * algorithm (argv0+argv1 match, unrestricted trailing args, exactly as specified) does not
 * distinguish that from `git branch <name>` / `git tag <name>` / `git remote add <name> <url>`,
 * all of which MUTATE. See the rationale comment on those three entries in `READONLY_SUBCOMMANDS`
 * below.
 */
export function readOnlyBash(command: string): boolean {
  if (command.trim() === "") return false;

  const segments = splitPipeline(command);
  if (segments === null || segments.length === 0) return false;

  for (const segment of segments) {
    if (!readOnlySegment(segment)) return false;
  }
  return true;
}

// argv0s that are read-only NO MATTER what flags/arguments follow — pure readers, filters, and
// info/introspection tools with no write mode at all.
export const READONLY_HEADS = new Set<string>([
  "cat", "head", "tail",
  // less/more: pagers — read-only viewers. This classifier's only caller (the agent's bash tool)
  // always runs non-interactively with stdout captured, never a live TTY, so both degrade to
  // streaming their input straight out, the same as `cat` — no interactive-editing mode to worry
  // about (that's `vi`/`nano`, deliberately NOT on this list).
  "less", "more",
  "ls", "pwd",
  "wc", "file", "stat", "du", "df",
  "which", "whereis",
  "whoami", "id",
  "date", "uptime", "uname", "sw_vers", "hostname",
  // printenv: never mutates anything (read-only in the narrow "does it mutate" sense this
  // classifier cares about), but env vars can carry secrets — its OUTPUT deserves the same
  // handling any other secret-revealing read would get, even though the command itself needs no
  // approval card.
  "printenv",
  "basename", "dirname", "realpath", "readlink",
  "echo", "printf",
  "grep", "rg", "fgrep", "egrep",
  // find: bare traversal is read-only, but several of find's OWN flags execute or mutate
  // (-delete, -exec, ...) — see FIND_ACTION_FLAGS and the dedicated veto in readOnlySegment
  // below, applied IN ADDITION to this table membership, never instead of it.
  "find", "fd", "tree",
  // tr/cut: despite the mutation-sounding names ("translate", "cut"), both are pure stdin->stdout
  // filters — neither takes a file operand to modify, so neither can ever mutate anything on disk.
  "sort", "uniq", "cut", "tr", "column",
  // diff/cmp/comm: report differences between their operands; despite taking two (or more) file
  // operands, none of the three ever writes to any of them.
  "diff", "cmp", "comm",
  // md5/shasum: hash computation only. `shasum -c` READS a checksum file to verify against — it
  // never writes one.
  "md5", "shasum",
  "od", "xxd", "strings",
  "jq", "yq",
]);

// argv0 -> the argv1 values that keep it read-only. Anything after argv1 is unrestricted (same
// "free continuation" shape as a Bash prefix rule) UNLESS a rationale comment below says
// otherwise.
export const READONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    "status", "log", "diff", "show",
    // branch/remote/tag: a BARE invocation (or one with only flags, e.g. `git branch -a`) lists
    // existing refs/remotes and is read-only — the only form the required fixture matrix
    // exercises. CAVEAT (flagged for a follow-up review, not fixed here — the brief specifies
    // this classifier's algorithm as exactly "argv0 in this map AND argv1 in its set", with no
    // further-argument constraint other than the git-stash-list special case below):
    // `git branch <name>` CREATES a branch, `git tag <name>` CREATES a tag, and `git remote add
    // <name> <url>` ADDS a remote — all mutating — and none of those are distinguished from the
    // read-only "list" form by argv0+argv1 alone. Tightening this (e.g. requiring argv2, if
    // present, to look like a flag) would not break any required fixture, but goes beyond the
    // brief's literal, verbatim-specified algorithm, so it's called out here rather than done
    // unilaterally.
    "branch", "remote", "tag",
    "describe", "rev-parse", "ls-files", "blame", "shortlog",
  ]),
  npm: new Set(["ls", "view", "outdated"]),
  pnpm: new Set(["ls", "list"]),
  brew: new Set(["list", "info"]),
  swift: new Set(["--version"]),
  xcodebuild: new Set(["-version", "-showsdks", "-list"]),
};

// find's action flags: each one EXECUTES or MUTATES per matched file (runs a command, deletes it,
// writes a report to a file, ...) — traversal + a predicate/print alone (find's default action)
// is the only read-only shape.
const FIND_ACTION_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

// Rejected as argv0, per segment. See the module doc comment: this is redundant with these names
// being absent from READONLY_HEADS/READONLY_SUBCOMMANDS (an allowlist already defaults to false
// for anything unrecognized) — kept explicit as self-documentation and a guard against a future
// accidental addition to either table above.
const DENY_HEADS = new Set([
  "sudo", // privilege escalation — runs anything as another (usually root) user
  "xargs", // builds and runs arbitrary commands from its input; argv0 opaque to this classifier
  "sh", "bash", "zsh", // shells — reopen the entire hazard surface this classifier exists to close
  "eval", // re-parses and executes its argument as shell code
  "exec", // replaces the current process image with an arbitrary command
  "env", // `env NAME=val cmd...` (or bare `env cmd...`) runs an arbitrary command
  "tee", // writes its stdin to a file — the write hole a read-only pipeline could otherwise hide
  "script", // records a shell session by spawning an interactive shell of its own
]);

// A leading `NAME=value` environment assignment, e.g. `FOO=bar ls`. Rejected outright rather than
// stripped-and-reevaluated: assignments can chain (`FOO=1 BAR=2 ls`), and there is no benefit to
// the added complexity of skipping over them when "no opinion" is always a safe fallback.
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basenameOf(argv0: string): string {
  const idx = argv0.lastIndexOf("/");
  return idx === -1 ? argv0 : argv0.slice(idx + 1);
}

/**
 * Quote-aware whitespace split of one pipeline segment into argv tokens. Adjacent quoted/
 * unquoted runs with no separating whitespace concatenate into a SINGLE token (`"r"m` resolves to
 * `rm`, not two tokens) — this is what stops a quoting trick from hiding a real argv0 from the
 * classifier. Quote characters are stripped from the resolved text; a backslash inside a
 * double-quoted span escapes the next character (mirrors `hasShellHazards`'s own double-quote
 * handling in shell-scan.ts) and single-quoted spans are taken verbatim with no escape processing
 * at all (POSIX single quotes have none). Callers must only pass a segment `splitPipeline` has
 * already vetted as hazard-free and quote-balanced — this function does no hazard scanning of its
 * own and assumes every quote closes within the segment.
 *
 * Uses `.charAt()` rather than bracket indexing for character access (unlike shell-scan.ts's
 * scanners, which only ever COMPARE a character): this function builds a new string by
 * concatenation, and under this repo's `noUncheckedIndexedAccess` a bracket-indexed character is
 * typed `string | undefined` — `.charAt()` is always `string` (empty past the end), which is both
 * simpler to type and correct here (an out-of-range read concatenating "" is a no-op, never the
 * literal text "undefined" a stray `undefined` would produce).
 *
 * Deliberately, like `hasShellHazards`, does NOT strip a backslash appearing OUTSIDE quotes (real
 * bash removes it and treats the next character literally, so e.g. `ca\t` really runs `cat`) —
 * here that means such a backslash is kept as a literal character in the resolved token instead
 * of being consumed. That can only make a resolved argv0 fail to match a table entry it
 * genuinely should (a real-but-obfuscated `cat` reads as the unrecognized string `ca\t`, one
 * extra approval-card prompt for an unusual idiom nobody writes this way on purpose) — it can
 * never do the reverse and produce a false MATCH, since the retained backslash character always
 * makes the resolved token differ from every clean table entry. Fail-to-ask, not a security hole.
 */
function argvOf(segment: string): string[] {
  const argv: string[] = [];
  let current = "";
  let haveCurrent = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i++) {
    const c = segment.charAt(i);

    if (inSingle) {
      if (c === "'") { inSingle = false; continue; }
      current += c;
      continue;
    }
    if (inDouble) {
      if (c === "\\" && i + 1 < segment.length) {
        i++;
        current += segment.charAt(i);
        continue;
      }
      if (c === '"') { inDouble = false; continue; }
      current += c;
      continue;
    }
    if (c === "'") { inSingle = true; haveCurrent = true; continue; }
    if (c === '"') { inDouble = true; haveCurrent = true; continue; }
    if (c === " " || c === "\t") {
      if (haveCurrent) argv.push(current);
      current = "";
      haveCurrent = false;
      continue;
    }
    current += c;
    haveCurrent = true;
  }
  if (haveCurrent) argv.push(current);
  return argv;
}

function readOnlySegment(segment: string): boolean {
  const trimmed = segment.replace(/^[ \t]+/, "");
  if (trimmed === "") return false;
  if (LEADING_ASSIGNMENT.test(trimmed)) return false;

  const argv = argvOf(trimmed);
  const argv0 = argv[0];
  if (argv0 === undefined || argv0 === "") return false;
  if (DENY_HEADS.has(argv0)) return false;

  const basename = basenameOf(argv0);
  let allowed = READONLY_HEADS.has(basename);

  if (!allowed) {
    const sub = READONLY_SUBCOMMANDS[argv0];
    const argv1 = argv[1];
    if (sub !== undefined && argv1 !== undefined) {
      if (sub.has(argv1)) {
        allowed = true;
      } else if (argv0 === "git" && argv1 === "stash" && argv[2] === "list") {
        allowed = true; // special-case: "stash" alone also covers pop/apply/drop/clear (mutating)
      }
    }
  }
  if (!allowed) return false;

  if (basename === "find" && argv.some((tok) => FIND_ACTION_FLAGS.has(tok))) return false;

  return true;
}
