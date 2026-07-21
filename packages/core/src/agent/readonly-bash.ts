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
 * to the real argv0 `rm` — it cannot hide a mutating command's name from the classifier).
 *
 * A path-qualified argv0 (containing `/`, e.g. `./cat` or `/tmp/evil/cat`) is rejected
 * IMMEDIATELY, before any table lookup (SP-approvals T2 review, FIX 3) — this classifier can only
 * vouch for a NAME being one of a known-safe set of binaries resolved off `PATH`; it has no way
 * to verify WHICH binary a relative or absolute path actually points at, and an attacker who
 * controls any writable directory can trivially place an executable there that merely shares a
 * trusted command's basename. So every argv0 that reaches a table lookup below is, by
 * construction, already a bare name — there is no separate "basename" concept left to compute.
 *
 * The (bare) argv0 must then name a known read-only tool: either it's in `READONLY_HEADS` (any
 * arguments after it are unrestricted — these are tools that are read-only regardless of flags),
 * or it is a key in `READONLY_SUBCOMMANDS` and argv1 is in that tool's allowed-subcommand set
 * (again, anything after argv1 is unrestricted, mirroring how a `Bash(...:*)` prefix rule allows
 * free continuation) — with two exceptions:
 *  - the two-token special case `git stash list` (argv2 must additionally be exactly `"list"` —
 *    `git stash` alone also covers `pop`/`apply`/`drop`/`clear`, all mutating);
 *  - git's `branch`/`tag`/`remote`, which additionally require `tightGitFormOk` to accept
 *    everything past argv1 (SP-approvals T2 review, FIX 1 — see that function's doc comment). A
 *    bare positional argument to any of the three (a branch/tag NAME, or one of remote's
 *    positional subcommands like `add`/`set-url`) always mutates, and argv0+argv1 matching alone
 *    could not tell that apart from the read-only bare/flags-only "list" form — this classifier
 *    originally shipped without that gate (see git history / the SP-approvals T2 report for the
 *    16 probe-confirmed silent-mutation fixtures that finding closed).
 *
 * `find` gets one more veto after passing the above: ANY of its own action flags (`-delete`,
 * `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprintf`, `-fls`) present anywhere in its
 * resolved argv rejects the whole segment — traversal-plus-print (find's default action) is the
 * only read-only shape.
 *
 * A hard-coded deny-list (`DENY_HEADS`) is also checked first, per segment, against argv0 alone
 * (never a substring-anywhere-in-argv scan, which would false-positive on e.g. `grep sh
 * file.txt`, where "sh" is an ARGUMENT, not the invoked command) — logically redundant with these
 * names simply being absent from the two allow tables (this classifier only ever allows what it
 * recognizes), kept explicit anyway as self-documentation and a guard against a future accidental
 * addition to either table. (FIX 3's blanket path-qualification rejection above also means a
 * path-qualified deny-listed name, e.g. `/bin/sh`, is already rejected before this check ever
 * runs — mooting what used to be a real, if minor, gap: this check alone couldn't see through a
 * path prefix either.)
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
//
// less/more are DELIBERATELY ABSENT (SP-approvals T2 review, FIX 2) despite being read-only
// viewers: both honor the LESSOPEN/LESSCLOSE environment variables, which can make either invoke
// an ARBITRARY preprocessor command when opening a file — a well-known pager hazard, empirically
// confirmed to fire under this classifier's exact no-TTY spawn shape, since the bash tool spreads
// the full daemon environment (bash.ts) rather than a clean one. No required fixture uses either;
// `cat`/`head`/`tail` already cover the "read a file" use case without that hook.
export const READONLY_HEADS = new Set<string>([
  "cat", "head", "tail",
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
    // branch/remote/tag: UNLIKE every other entry in this file's tables, "anything after argv1 is
    // unrestricted" does NOT hold for these three — readOnlySegment additionally requires
    // `tightGitFormOk(argv1, rest)` to pass (SP-approvals T2 review, FIX 1). A bare invocation (or
    // one with only recognized flags, e.g. `git branch -a`) lists existing refs/remotes and is
    // read-only, but a POSITIONAL argument here always mutates: `git branch <name>` creates a
    // branch (or `-d`/`-D` deletes one, `-m`/`-M` renames, `-c`/`-C` copies, ...), `git tag <name>`
    // creates a tag (or `-d` deletes, `-f` forces, `-a`/`-s` annotates/signs, ...), and
    // `git remote add <name> <url>` adds a remote (or `remove`/`rename`/`set-url`/`prune`/
    // `update`, all positional, all mutating). `tightGitFormOk` closes exactly this hole.
    "branch", "remote", "tag",
    "describe", "rev-parse", "ls-files", "blame", "shortlog",
  ]),
  npm: new Set(["ls", "view", "outdated"]),
  pnpm: new Set(["ls", "list"]),
  brew: new Set(["list", "info"]),
  swift: new Set(["--version"]),
  xcodebuild: new Set(["-version", "-showsdks", "-list"]),
};

// FIX 1 (SP-approvals T2 review): git branch/tag/remote flag allowlists, grounded in each
// subcommand's real `-h` output. Every trailing token must start with `-`, be in the relevant
// SAFE set, and not be in the DENY set (belt-and-braces — SAFE/DENY are disjoint by construction,
// so "not in SAFE" alone already rejects everything in DENY; kept as an explicit second check
// anyway). A bare (non-dash) token always fails the gate, with the sole exception of tag's
// -v/--verify value (see TAG_VALUE_FLAGS below) — a branch/tag NAME or one of remote's positional
// subcommands (add/remove/rename/set-url/prune/update) is exactly what real git treats as the
// mutating form, so refusing every other bare token is the point, not an over-restriction.
const BRANCH_SAFE_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-l", "--list", "--no-list", "-v", "--verbose", "-vv",
  "--no-verbose", "--show-current", "--no-show-current", "-i", "--ignore-case", "-q", "--quiet",
  "--no-quiet", "--color", "--no-color",
]);
const BRANCH_DENY = new Set([
  "-d", "-D", "--delete", "--no-delete", "-m", "-M", "--move", "--no-move", "-c", "-C", "--copy",
  "--no-copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream", "-t", "--track",
  "--no-track", "--edit-description", "--create-reflog", "--no-create-reflog",
]);
const TAG_SAFE = new Set(["-l", "--list", "-n", "-v", "--verify", "-i", "--ignore-case"]);
// NOTE: tag's -a/--annotate MEANS "create an annotated tag" — the exact opposite of branch's -a
// (list all). SAFE/DENY sets are kept separate per subcommand deliberately; never shared.
const TAG_DENY = new Set([
  "-d", "--delete", "-f", "--force", "-a", "--annotate", "--no-annotate", "-m", "--message", "-F",
  "--file", "-s", "--sign", "-u", "--local-user", "-e", "--edit", "--cleanup", "--create-reflog",
]);
// remote's mutations (add/remove/rename/set-url/prune/update) are all positional WORDS, not
// flags — the starts-with-"-" gate in tightGitFormOk alone already excludes every one of them, so
// no REMOTE_DENY set is needed; kept as an empty set purely so tightGitFormOk's switch below can
// treat all three subcommands uniformly.
const REMOTE_SAFE = new Set(["-v", "--verbose"]);
const REMOTE_DENY = new Set<string>();

// -v/--verify legitimately takes the tag name(s) to verify as a following bare (non-dash) value —
// read-only regardless of that value (verification never mutates, whatever string is passed), so
// unlike everything else `tightGitFormOk` checks, ONE bare token immediately after -v/--verify is
// tolerated, for "tag" only. Value-taking flags are otherwise deliberately excluded from every
// SAFE set entirely (fail to card, per the review) — -v/--verify is the sole named exception,
// required by the review's explicit `git tag -v v1` -> true test case.
const TAG_VALUE_FLAGS = new Set(["-v", "--verify"]);

/**
 * Is `git <argv1> ...rest` one of the three tightened subcommands' read-only forms? Bare
 * (`rest.length === 0`) is always fine — vacuously safe, matching the already-required fixture
 * `git branch -a`-style bare-and-flags-only forms this classifier allowed before this fix, and
 * still allows. Otherwise every token in `rest` must start with `-`, be in that subcommand's SAFE
 * set, and not be in its DENY set — EXCEPT for `tag`, where a single bare token directly
 * following `-v`/`--verify` is tolerated (see `TAG_VALUE_FLAGS` above). `argv1` values other than
 * branch/tag/remote return `false` (defensive — `readOnlySegment` only ever calls this for those
 * three).
 */
function tightGitFormOk(argv1: string, rest: string[]): boolean {
  if (rest.length === 0) return true; // bare form — vacuously safe

  let safe: ReadonlySet<string>;
  let deny: ReadonlySet<string>;
  switch (argv1) {
    case "branch": safe = BRANCH_SAFE_FLAGS; deny = BRANCH_DENY; break;
    case "tag": safe = TAG_SAFE; deny = TAG_DENY; break;
    case "remote": safe = REMOTE_SAFE; deny = REMOTE_DENY; break;
    default: return false; // not one of the three tightened subcommands
  }

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue; // unreachable — i < rest.length always yields a defined element
    if (tok.startsWith("-")) {
      if (!safe.has(tok) || deny.has(tok)) return false;
      continue;
    }
    // A bare (non-dash) token: real git only ever needs one here, as tag's verification target
    // immediately after -v/--verify (git tag -v <name> — read-only regardless of <name>). Every
    // other bare token — a branch/tag NAME, or one of remote's positional subcommands — refuses.
    const prev = i > 0 ? rest[i - 1] : undefined;
    if (argv1 === "tag" && prev !== undefined && TAG_VALUE_FLAGS.has(prev)) continue;
    return false;
  }
  return true;
}

// find's action flags: each one EXECUTES or MUTATES per matched file (runs a command, deletes it,
// writes a report to a file, ...) — traversal + a predicate/print alone (find's default action)
// is the only read-only shape.
const FIND_ACTION_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

// Rejected as argv0, per segment. See the module doc comment: this is redundant with these names
// being absent from READONLY_HEADS/READONLY_SUBCOMMANDS (an allowlist already defaults to false
// for anything unrecognized) — kept explicit as self-documentation and a guard against a future
// accidental addition to either table above. Checked against argv0 verbatim; FIX 3's blanket
// "any `/` in argv0 rejects" (in readOnlySegment, below) already runs before this, so a
// path-qualified deny-listed name (e.g. `/bin/sh`) never reaches this check needing its own
// basename handling in the first place.
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

/**
 * Quote-aware whitespace split of one pipeline segment into argv tokens. Adjacent quoted/
 * unquoted runs with no separating whitespace concatenate into a SINGLE token (`"r"m` resolves to
 * `rm`, not two tokens) — this is what stops a quoting trick from hiding a real argv0 from the
 * classifier. Quote characters are stripped from the resolved text; single-quoted spans are taken
 * verbatim with no escape processing at all (POSIX single quotes have none).
 *
 * Inside a double-quoted span, a backslash is recognized as an escape ONLY when immediately
 * followed by one of `$`, `` ` ``, `"`, or `\` — bash's own real double-quote escape set
 * (SP-approvals T2 review, MINOR fix: this previously treated ANY backslash as escaping the next
 * character, which let `"c\at" foo` wrongly resolve argv0 to `cat` — a genuine false-ALLOW risk,
 * not merely an over-conservative one, since an arbitrary non-special character after a backslash
 * could forge a match against any table entry). A backslash followed by anything else is a plain
 * literal character inside double quotes (matches real bash: `"\a"` is literally backslash-then-a,
 * never just `a`) — it is appended as-is, and the following character is processed normally on
 * the next loop iteration, never consumed as part of a (non-existent) escape.
 *
 * Callers must only pass a segment `splitPipeline` has already vetted as hazard-free and
 * quote-balanced — this function does no hazard scanning of its own and assumes every quote
 * closes within the segment.
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
      if (c === "\\") {
        const next = i + 1 < segment.length ? segment.charAt(i + 1) : "";
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          i++;
          current += next;
          continue;
        }
        // Not one of bash's recognized double-quote escapes — the backslash is itself literal,
        // and the following character (if any) is processed normally next iteration.
        current += c;
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
  // FIX 3 (SP-approvals T2 review): reject any path-qualified argv0 BEFORE any table lookup —
  // this classifier can only vouch for a NAME, never for which binary a path actually resolves
  // to. Every check below now sees a bare name by construction; `basenameOf` is gone as dead code.
  if (argv0.includes("/")) return false;
  if (DENY_HEADS.has(argv0)) return false;

  let allowed = READONLY_HEADS.has(argv0);

  if (!allowed) {
    const sub = READONLY_SUBCOMMANDS[argv0];
    const argv1 = argv[1];
    if (sub !== undefined && argv1 !== undefined) {
      if (sub.has(argv1)) {
        if (argv0 === "git" && (argv1 === "branch" || argv1 === "tag" || argv1 === "remote")) {
          allowed = tightGitFormOk(argv1, argv.slice(2)); // FIX 1 (SP-approvals T2 review)
        } else {
          allowed = true;
        }
      } else if (argv0 === "git" && argv1 === "stash" && argv[2] === "list") {
        allowed = true; // special-case: "stash" alone also covers pop/apply/drop/clear (mutating)
      }
    }
  }
  if (!allowed) return false;

  if (argv0 === "find" && argv.some((tok) => FIND_ACTION_FLAGS.has(tok))) return false;

  return true;
}
