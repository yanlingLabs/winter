// PORTED from Winter's own agent SDK (yanlingLabs/winter-agent-sdk, packages/runtime/src/permissions,
// v0.0.53): `bash-read-only.ts`, plus the declarations it needs from `grammar.ts` and `shell-structure.ts`,
// merged into this one module (each part under its own "From …" banner, in source order, otherwise
// verbatim). The runtime classifies a Bash command as read-only to run it concurrently (agent SDK 0.0.40+,
// claude's rule) but does not export the classifier, so the daemon carries this copy: the bash safety
// reviewer's hook (`runtime-sdk/hooks.ts`) skips the review for a SANDBOXED command it accepts. Keep it in
// step with the SDK — a fix there belongs here too; `test/runtime-sdk/bash-read-only.test.ts` is the SDK's own
// test file, ported with it.
//
// ---- the SDK module's own header ----
//
// Is a Bash command provably READ-ONLY?
//
// The runtime asks this to decide whether a `Bash` call may run concurrently with its siblings: a
// read-only call runs alongside the others, anything else runs on its own. The user's ruling is to
// behave like Claude Code, which runs a Bash call concurrently when it classifies it as read-only.
// This module RE-DERIVES that behaviour from the observable rule and its tests -- it contains none of
// Claude Code's source code -- and REUSES interface DATA carried over from the earlier port: the
// per-command flag tables (`COMMAND_SPECS`), the read-only command list and command-pattern regexes
// (`READ_ONLY_REGEXES`), and the lists of zsh builtins, substitution spellings, tput capabilities,
// xargs targets and find actions.
//
// A command is read-only when, in this order of cost:
//   1. it is short enough, not empty, parseable, and passes the lexical pre-checks (`PRE_CHECKS`,
//      grouped by what the trick they catch would achieve) and, on Windows, names no UNC/WebDAV path;
//   2. it runs no subshell, command substitution or process substitution;
//   3. git, if it runs, runs without a directory change, outside a bare or planted repository, after
//      no command that creates git-internal paths, and -- sandboxed -- in the original directory;
//   4. every simple command passes the pre-checks again AND is read-only by its flag table or by the
//      read-only command patterns.
//
// A false "read-only" is the dangerous direction, so wherever this parser and bash could disagree it
// answers false. Additions to the reused flag tables:
//   - `respectsDoubleDash: false` for `git stash list`, `git stash show`, `git reflog`, `git ls-remote`,
//     `tree` and `lsof` (git forwards stash/reflog arguments, `--` included, to `git log`/`git diff`);
//   - the `attached` argument kind, for `date --iso-8601`/`--rfc-3339` and `git branch --abbrev`: the
//     value only as `--flag=VALUE`, so a detached word stays a positional;
//   - `base64` takes at most one input operand.
// Rules of this module's own, each refusing something the tables and patterns alone would accept:
//   - commands over 4096 characters, empty commands, unterminated quotes, here-documents and any
//     carriage return;
//   - a word that becomes a flag only after quote removal (`ls -\R`) never matches the raw-text
//     patterns;
//   - a word starting with a backslash that bash keeps inside double quotes, where a reader dropping
//     the backslash would see a different word (`keptBackslashMisleads`);
//   - a `-`-prefixed word must be an exact flag of the command: a Unicode dash (`-‐o`), punctuation
//     after the dash (`-.x`) and a flag cluster carrying `=` (`-nr=x`) are refused;
//   - `xargs` takes its first operand -- a bare `-` or an empty word included -- as the command it runs;
//   - `jq` with a short-option cluster holding `f` or `L` (`-nf FILE`);
//   - the sed, quoting and UNC rules below refuse some harmless spellings for simplicity (each noted
//     STRICTER where it is made).
//
// Two views of a command are used, and both must pass: the flag tables, the `$`/brace checks, the
// xargs target, the sed script and find's actions read each word AFTER bash's quote removal (what the
// program really receives -- `find . -\fls out` passes `-fls`); the raw-text patterns read the words as
// written.
import { statSync } from "node:fs";
import { join } from "node:path";


type Platform = typeof process.platform;

export interface BashReadOnlyContext {
  /** The session's current working directory (where the command runs). */
  cwd: string;
  /** The directory the session started in. */
  originalCwd: string;
  /** Whether the Bash sandbox is on for this call. */
  sandboxEnabled: boolean;
}

/**
 * STRICTER: a command longer than this is never read-only here. This runs synchronously on every
 * Bash call; a long command simply runs serially.
 */
const READ_ONLY_LENGTH_LIMIT = 4_096;

/** Questions about the whole command text; any "yes" makes it not read-only. */
const WHOLE_TEXT_REFUSALS: ReadonlyArray<(text: string, platform: Platform) => boolean> = [
  (text) => text.length > Math.min(PARSE_LIMIT, READ_ONLY_LENGTH_LIMIT),
  (text) => text.trim() === "", // STRICTER: an empty command has no subcommand to vouch for
  (text) => splitCompound(text) === null, // STRICTER: an unterminated quote is refused, never silently closed
  (text) => !passesSecurityValidators(text),
  (text, platform) => containsVulnerableUncPath(text, platform), // before anything rewrites backslashes
];

/** True when `command` is provably read-only, which is exactly when a Bash call may run concurrently. */
export function isBashCommandReadOnly(command: string, ctx: BashReadOnlyContext): boolean {
  const platform = process.platform;
  if (typeof command !== "string" || WHOLE_TEXT_REFUSALS.some((refuses) => refuses(command, platform))) return false;
  const joined = joinLineContinuations(command);
  // A subshell, command substitution or process substitution runs a command of its own; anything the
  // structure scan cannot read (null) is refused too.
  if ((substitutionBodies(joined) ?? [""]).length > 0) return false;
  const commands = readSimpleCommands(joined) ?? [];
  if (commands.length === 0 || gitRunsUnsafely(joined, commands, ctx)) return false;
  return commands.every((simple) => passesSecurityValidators(simple.text) && isSimpleCommandReadOnly(simple, platform));
}

// =====================================================================================================
// Reading the simple commands
// =====================================================================================================

interface Word {
  /** As written. */
  raw: string;
  /** After bash's quote removal. */
  value: string;
}

/** One simple command with its harmless redirections dropped. `text` is its words, as written, joined by one space. */
interface SimpleCommand {
  words: Word[];
  text: string;
}

/** Bash's control and redirection operators; the longest spelling at a position wins. */
const SHELL_OPERATORS: readonly string[] = ["<<<", "&&", "||", "|&", ";;", ";&", "&>", ">>", ">&", ">|", "<<", "<&", "<>", ">", "<", "&", "|", ";"];
/** The operators that end one simple command and start the next. */
const COMMAND_SEPARATORS: ReadonlySet<string> = new Set([";", "&&", "||", "|"]);

/**
 * A redirection that only throws output away: `>/dev/null` from stdin, stdout or stderr (no descriptor
 * means stdout), or stderr joined to stdout (`2>&1`). The target must be written plainly, unquoted.
 */
function throwsOutputAway(operator: string, descriptor: string | undefined, target: string): boolean {
  if (operator === ">") return target === "/dev/null" && (descriptor === undefined || ["0", "1", "2"].includes(descriptor));
  return operator === ">&" && descriptor === "2" && target === "1";
}

/**
 * The simple commands of `text` (one line; separated by `;`, `&&`, `||` or `|`), read in a single
 * pass over its lexed characters, with the redirections that only throw output away dropped. Null --
 * "not read-only" -- for anything this does not model exactly: an unterminated quote, a substitution
 * (`$(`, `${`, `$[`, a backtick), ANSI-C/locale quoting, a parenthesis, a comment, a carriage return, a
 * line break before more text, a trailing backslash, a background `&`, any other redirection (input
 * ones and here-documents included), or an empty command (`ls |`, `; ls` -- a single trailing `;` is fine).
 */
function readSimpleCommands(text: string): SimpleCommand[] | null {
  const lx = lex(text);
  if (lx.unterminated || text.includes("\r")) return null;
  let lastNonBlank = text.length - 1;
  while (lastNonBlank >= 0 && isBlank(text[lastNonBlank])) lastNonBlank--;

  const commands: SimpleCommand[] = [];
  let words: Word[] = [];
  let wordStart = -1;
  /** A redirection operator whose target word has not been read yet. */
  let awaiting: { operator: string; descriptor?: string } | undefined;
  let endedBySemicolon = false;

  /** Closes the word in progress; false when it was the target of a redirection that may write. */
  const closeWord = (end: number): boolean => {
    if (wordStart === -1) return true;
    const raw = text.slice(wordStart, end);
    wordStart = -1;
    if (awaiting !== undefined) {
      const harmless = throwsOutputAway(awaiting.operator, awaiting.descriptor, raw);
      awaiting = undefined;
      return harmless;
    }
    words.push({ raw, value: dequoteShellWord(raw) });
    return true;
  };

  /** `text[i]` is `$` and the next character opens a substitution (or, outside quotes, ANSI-C/locale quoting). */
  const opensSubstitution = (i: number, quoteForms: boolean): boolean => {
    const next = text[i + 1];
    return text[i] === "$" && next !== undefined && (next === "(" || next === "{" || next === "[" || (quoteForms && (next === "'" || next === '"')));
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!isBare(lx, i)) {
      // Quoted or escaped text belongs to the word; a live substitution inside double quotes does not.
      if (lx.role[i] === Role.Text && lx.quoting[i] === Quoting.Double && (ch === "`" || opensSubstitution(i, false))) return null;
      if (wordStart === -1) wordStart = i;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (!closeWord(i)) return null;
      if (ch === "\n" && i < lastNonBlank) return null; // a second command on the next line
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")" || ch === "\\") return null; // a bare backslash here has nothing left to escape
    if (opensSubstitution(i, true)) return null;
    if (ch === "#" && wordStart === -1) return null;
    if (!";&|<>".includes(ch)) {
      if (wordStart === -1) wordStart = i;
      continue;
    }

    const operator = SHELL_OPERATORS.find((op) => text.startsWith(op, i))!;
    const glued = wordStart === -1 ? undefined : text.slice(wordStart, i);
    let descriptor: string | undefined;
    if (glued !== undefined && /^\d+$/.test(glued) && (operator[0] === ">" || operator[0] === "<")) {
      descriptor = glued;
      wordStart = -1;
    } else if (!closeWord(i)) {
      return null;
    }
    i += operator.length - 1;
    if (awaiting !== undefined) return null; // an operator where a redirection target belongs
    if (descriptor === undefined && COMMAND_SEPARATORS.has(operator)) {
      if (words.length === 0) return null;
      commands.push({ words, text: words.map((w) => w.raw).join(" ") });
      words = [];
      endedBySemicolon = operator === ";";
      continue;
    }
    awaiting = descriptor === undefined ? { operator } : { operator, descriptor };
  }
  if (!closeWord(text.length) || awaiting !== undefined) return null;
  if (words.length > 0) commands.push({ words, text: words.map((w) => w.raw).join(" ") });
  else if (!(commands.length > 0 && endedBySemicolon)) return null;
  return commands;
}

// =====================================================================================================
// git hardening: git must not run after a directory change, in a cwd that looks like a bare (possibly
// planted) repository, after the command itself created git-internal paths, or -- sandboxed -- outside
// the directory the session started in
// =====================================================================================================

const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);

/**
 * The programs a simple command may run: its first word, the word left once leading assignments and
 * wrappers (`timeout 5`, `nice`, ...) are looked through, and -- for `xargs`, which runs whatever its
 * arguments name -- every one of its words.
 */
function programsRunBy(simple: SimpleCommand): Set<string> {
  const programs = new Set<string>([simple.words[0]!.value]);
  const inner = leadingWord(stripWrappers(simple.text, "denyAsk")).word;
  if (inner !== undefined) programs.add(dequoteShellWord(inner));
  if (simple.words[0]!.value === "xargs") for (const word of simple.words) programs.add(word.value);
  return programs;
}

/** What is at `path`: a regular file, a directory, something else, or nothing readable. */
function entryKind(path: string): "file" | "directory" | "other" | "missing" {
  try {
    const entry = statSync(path);
    return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/** The entries that make a directory a bare repository in git's eyes. */
const BARE_REPOSITORY_MARKERS: ReadonlyArray<readonly [string, "file" | "directory"]> = [
  ["HEAD", "file"],
  ["objects", "directory"],
  ["refs", "directory"],
];

/**
 * True when `cwd` holds a bare repository's own markers -- a `HEAD` file, an `objects/` or a `refs/`
 * directory -- and no working `.git` (a `.git` FILE, as in a worktree or submodule, or a `.git`
 * directory with a regular `HEAD` file) that git would find first. git would then use `cwd` itself as
 * the repository and could run hooks planted there.
 */
export function isCurrentDirectoryBareGitRepo(cwd: string): boolean {
  const dotGit = entryKind(join(cwd, ".git"));
  const workingRepository = dotGit === "file" || (dotGit === "directory" && entryKind(join(cwd, ".git", "HEAD")) === "file");
  if (workingRepository) return false;
  return BARE_REPOSITORY_MARKERS.some(([name, kind]) => entryKind(join(cwd, name)) === kind);
}

const GIT_INTERNAL_TOP_LEVEL: ReadonlySet<string> = new Set(["objects", "refs", "hooks"]);

/** `path` (relative to the cwd; any leading `./` and `/` ignored) names `HEAD` or something under `objects`, `refs` or `hooks`. */
function namesGitInternals(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  const top = segments[0];
  if (top === undefined) return false;
  return (top === "HEAD" && segments.length === 1) || GIT_INTERNAL_TOP_LEVEL.has(top);
}

/** Commands that create a file or directory at a path they are given. */
const CREATING_COMMANDS: ReadonlySet<string> = new Set(["mkdir", "touch", "cp", "mv"]);

function gitRunsUnsafely(joined: string, commands: readonly SimpleCommand[], ctx: BashReadOnlyContext): boolean {
  const programs = commands.map(programsRunBy);
  if (!programs.some((set) => set.has("git"))) return false;
  if (programs.some((set) => [...DIRECTORY_CHANGERS].some((changer) => set.has(changer)))) return true;
  if (isCurrentDirectoryBareGitRepo(ctx.cwd)) return true;
  if (extractRedirectTargets(joined).some(namesGitInternals)) return true;
  const createsInternals = commands.some(
    (simple) => CREATING_COMMANDS.has(simple.words[0]!.value) && simple.words.slice(1).some((w) => !w.value.startsWith("-") && namesGitInternals(w.value)),
  );
  return createsInternals || (ctx.sandboxEnabled && ctx.cwd !== ctx.originalCwd);
}


// =====================================================================================================
// Windows UNC / WebDAV paths (a no-op off Windows)
// =====================================================================================================

/** WebDAV spellings Windows resolves over the network (`host@SSL@443`, `host@443@SSL`, `DavWWWRoot`). */
const WEBDAV_MARKERS: readonly RegExp[] = [/@SSL@\d+/i, /@\d+@SSL/i, /DavWWWRoot/i];

const isPathSeparator = (ch: string | undefined): boolean => ch === "/" || ch === "\\";

/**
 * True on Windows when `text` names a UNC or WebDAV location, which Windows opens by reaching out over
 * the network (and authenticating). Any run of two or more path separators -- `\\`, `//`, or a mix
 * such as `/\\` -- followed directly by a host-like character counts, except the `//` of a URL scheme
 * (`https://…`). STRICTER: a mixed pair such as `/\host` counts too.
 */
export function containsVulnerableUncPath(text: string, platform: Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  if (WEBDAV_MARKERS.some((marker) => marker.test(text))) return true;
  let i = 0;
  while (i < text.length) {
    if (!isPathSeparator(text[i])) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < text.length && isPathSeparator(text[i])) i++;
    const host = text[i];
    if (i - runStart < 2 || host === undefined || /\s/.test(host)) continue;
    const urlScheme = i - runStart === 2 && text[runStart] === "/" && text[runStart + 1] === "/" && text[runStart - 1] === ":";
    if (!urlScheme) return true;
  }
  return false;
}

// =====================================================================================================
// Lexical pre-checks
//
// Every check below reads one character-level picture of the command, built in a single forward pass
// with bash's quoting rules: inside single quotes nothing is special; elsewhere a backslash escapes the
// next character; double quotes open and close as usual. Several checks deliberately look at the text
// the way a LESS careful shell parser would (counting quote marks inside words, cutting words at
// operators, dropping backslashes) -- a command is refused wherever such a reader and bash could read
// it differently, because the later per-command checks must see the words bash really runs.
// =====================================================================================================

const enum Quoting {
  None = 0,
  Single = 1,
  Double = 2,
}

const enum Role {
  /** An ordinary character. */
  Text = 0,
  /** A quote mark that opens or closes a quoted span (its quoting says which kind). */
  QuoteMark = 1,
  /** A backslash that escapes the next character. */
  Escape = 2,
  /** The character an escape applies to. */
  Escaped = 3,
}

interface Lexed {
  text: string;
  /** Per character: the quoting it sits in (a quote mark: the kind of span it opens or closes). */
  quoting: Uint8Array;
  role: Uint8Array;
  /** The text ends inside an open quote. */
  unterminated: boolean;
}

function lex(text: string): Lexed {
  const quoting = new Uint8Array(text.length);
  const role = new Uint8Array(text.length);
  let open: Quoting = Quoting.None;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (open === Quoting.Single) {
      quoting[i] = Quoting.Single;
      if (ch === "'") {
        role[i] = Role.QuoteMark;
        open = Quoting.None;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      quoting[i] = quoting[i + 1] = open;
      role[i] = Role.Escape;
      role[i + 1] = Role.Escaped;
      i++;
      continue;
    }
    if (open === Quoting.Double) {
      quoting[i] = Quoting.Double;
      if (ch === '"') {
        role[i] = Role.QuoteMark;
        open = Quoting.None;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      open = ch === "'" ? Quoting.Single : Quoting.Double;
      quoting[i] = open;
      role[i] = Role.QuoteMark;
    }
  }
  return { text, quoting, role, unterminated: open !== Quoting.None };
}

/** An ordinary character outside every quote: where blanks split words and operators operate. */
const isBare = (lx: Lexed, i: number): boolean => lx.quoting[i] === Quoting.None && lx.role[i] === Role.Text;

const isBlank = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** Projections of the command used by the text-level checks. */
interface Views {
  /** Single-quoted spans dropped; double-quoted text kept (its quote marks only when asked). */
  outsideSingle: string;
  /** Only what is outside every quote (quote marks dropped). */
  bare: string;
  /** What is outside every quote, plus every quote mark (`a"b c"d` reads `a""d`). */
  bareWithMarks: string;
}

function viewsOf(lx: Lexed, keepDoubleMarks: boolean): Views {
  let outsideSingle = "";
  let bare = "";
  let bareWithMarks = "";
  for (let i = 0; i < lx.text.length; i++) {
    const ch = lx.text[i]!;
    if (lx.role[i] === Role.QuoteMark) {
      bareWithMarks += ch;
      if (ch === '"' && keepDoubleMarks) outsideSingle += ch;
      continue;
    }
    if (lx.quoting[i] === Quoting.Single) continue;
    outsideSingle += ch;
    if (lx.quoting[i] === Quoting.None) {
      bare += ch;
      bareWithMarks += ch;
    }
  }
  return { outsideSingle, bare, bareWithMarks };
}

/** The words of the command: cut at blanks outside every quote. `start`/`end` index into the text. */
function wordSpans(lx: Lexed): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i <= lx.text.length; i++) {
    const cut = i === lx.text.length || (isBare(lx, i) && isBlank(lx.text[i]));
    if (cut) {
      if (start !== -1) spans.push({ start, end: i });
      start = -1;
    } else if (start === -1) start = i;
  }
  return spans;
}

/**
 * `view` with the redirections that cannot write a file taken out: ` 2>&1`, `>/dev/null` (with an
 * optional 0/1/2 descriptor) and `</dev/null`. Each `<`/`>` is classified where it stands; one that
 * is not part of such a redirection stays, and the redirection check refuses it.
 */
function withoutHarmlessRedirections(view: string): string {
  const drop = new Uint8Array(view.length);
  const markFrom = (from: number, to: number): void => {
    for (let k = from; k < to; k++) drop[k] = 1;
  };
  const skipBlanks = (k: number): number => {
    while (isBlank(view[k])) k++;
    return k;
  };
  const endsWord = (k: number): boolean => k === view.length || isBlank(view[k]);
  const devNullAt = (k: number): number => (view.startsWith("/dev/null", k) && endsWord(k + 9) ? k + 9 : -1);
  for (let i = 0; i < view.length; i++) {
    const ch = view[i];
    if (ch === "<") {
      const end = devNullAt(skipBlanks(i + 1));
      if (end !== -1) markFrom(i, end);
    } else if (ch === ">" && view[i + 1] === "&") {
      // ` 2>&1`: blanks, a `2`, then `>&` and `1` (blanks allowed around `>&`).
      const one = skipBlanks(i + 2);
      let two = i - 1;
      while (two >= 0 && isBlank(view[two])) two--;
      if (view[one] === "1" && endsWord(one + 1) && view[two] === "2" && isBlank(view[two - 1])) markFrom(two, one + 1);
    } else if (ch === ">") {
      const end = devNullAt(skipBlanks(i + 1));
      if (end !== -1) markFrom(i, end);
    }
  }
  let out = "";
  for (let i = 0; i < view.length; i++) if (drop[i] === 0) out += view[i];
  return out;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const UNICODE_WHITESPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

/**
 * A single-quoted span that ENDS in backslashes: bash keeps them literally, but a parser that reads
 * `\'` as an escaped quote even inside single quotes runs the span on past its real end. Refused
 * when the trailing run is odd, or when any later quote mark could pair up differently.
 */
function singleQuoteEndsInBackslash(lx: Lexed): boolean {
  let lastSingleQuote = -1;
  for (let i = lx.text.length - 1; i >= 0; i--) {
    if (lx.text[i] === "'") {
      lastSingleQuote = i;
      break;
    }
  }
  let inside = false;
  let trailing = 0;
  for (let i = 0; i < lx.text.length; i++) {
    if (lx.quoting[i] !== Quoting.Single) continue;
    if (lx.role[i] === Role.QuoteMark) {
      if (inside && (trailing % 2 === 1 || (trailing > 0 && lastSingleQuote > i))) return true;
      inside = !inside;
      trailing = 0;
      continue;
    }
    trailing = lx.text[i] === "\\" ? trailing + 1 : 0;
  }
  return false;
}

/** Openings no complete command has: a flag, a separator or a redirection. */
const MIDWAY_OPENINGS: readonly string[] = ["-", ";", ">", "<", "&&", "||"];

/** A fragment of a command rather than a whole one: tab-indented, or opening with a flag or an operator. */
function startsMidway(text: string): boolean {
  const body = text.trimStart();
  const indentation = text.slice(0, text.length - body.length);
  return indentation.includes("\t") || MIDWAY_OPENINGS.some((opening) => body.startsWith(opening));
}

/** jq reading a program or library from a file (`-f`, `-L`, `--rawfile`, … -- short clusters too), or calling `system(`. */
function jqReachesBeyondItsFilter(text: string, base: string): boolean {
  if (base !== "jq") return false;
  for (let at = text.indexOf("system"); at !== -1; at = text.indexOf("system", at + 1)) {
    if (at > 0 && /\w/.test(text[at - 1]!)) continue;
    let k = at + 6;
    while (isBlank(text[k])) k++;
    if (text[k] === "(") return true;
  }
  const words = text.split(/\s+/).slice(1);
  return words.some((word) => {
    if (["--from-file", "--rawfile", "--slurpfile", "--library-path"].some((long) => word.startsWith(long))) return true;
    if (!word.startsWith("-") || word.startsWith("--")) return false;
    const letters = /^-([A-Za-z]*)/.exec(word)![1]!;
    return letters.includes("f") || letters.includes("L");
  });
}

const QUOTE_MARK = /['"]/;

/** Commands whose short option takes a glued value that is often quoted: the option, by command. */
const GLUED_QUOTED_VALUE_OPTION: Readonly<Record<string, string>> = { cut: "-d" };

/**
 * A quote mark inside a flag's name: `-n"umber"` reaches the program as `-number`, but a check that
 * reads the text as written sees no such flag. The name is the word from its dash up to its first
 * blank or `=`, and the FIRST quote mark in it decides: when the character after that mark could
 * carry the name on (a letter, digit, `_`, `-`, or another quote mark) the mark is inside the name;
 * otherwise it opens the flag's glued value (`-t','`, `-e'^x'`) -- as any quote after cut's `-d` does.
 */
function quoteInsideFlagName(text: string, start: number, base: string): boolean {
  let end = start;
  while (end < text.length && !isBlank(text[end]) && text[end] !== "=") end++;
  const head = text.slice(start, end);
  const mark = head.search(/['"]/);
  if (mark === -1) return false;
  if (Object.hasOwn(GLUED_QUOTED_VALUE_OPTION, base) && GLUED_QUOTED_VALUE_OPTION[base] === head.slice(0, mark)) return false;
  const follower = text[start + mark + 1];
  return follower === undefined || /[\w'"-]/.test(follower);
}

/**
 * Runs of quote marks that sit where a dash or a word begins: two or more opening a word (or right
 * after a `$`) with a `-` next (blanks between allowed: `'' -v`, `""-v`), three or more right before
 * a `-`, or three or more opening a word (`''""z`, `"'"`). Each is a way to make a word start with a
 * dash, or with a quote, that a check reading the text as written does not see. STRICTER: harmless
 * spellings of these shapes are refused too.
 */
function quoteRunNearDash(text: string): boolean {
  for (const run of text.matchAll(/['"]+/g)) {
    const before = text[run.index - 1];
    const after = run.index + run[0].length;
    const opensWord = before === undefined || isBlank(before);
    let solid = after;
    while (isBlank(text[solid])) solid++; // the blanks after one run end before the next run starts
    if (run[0].length >= 2 && (opensWord || before === "$") && text[solid] === "-") return true;
    if (run[0].length >= 3 && (opensWord || text[after] === "-")) return true;
  }
  return false;
}

/**
 * Quoting used to disguise a flag, so a check reading the text as written would miss it: ANSI-C or
 * locale quoting (`$'…'`, `$"…"`) anywhere; a quote run next to a dash (`quoteRunNearDash`); a word
 * that opens with a quote mark yet reaches the program starting with `-` (`'-v'`, `"-"v`, `""-name`;
 * STRICTER: a lone quoted dash too); or a quote mark inside a flag's name (`quoteInsideFlagName`).
 * An `echo` with no `|`, `&` or `;` is exempt: it prints its arguments and reads no flag that matters.
 */
function flagSpelledWithQuotes(lx: Lexed, base: string): boolean {
  const text = lx.text;
  if (base === "echo" && !/[|&;]/.test(text)) return false;
  if (text.includes("$'") || text.includes('$"') || quoteRunNearDash(text)) return true;
  return wordSpans(lx).some(({ start, end }) => {
    if (lx.role[start] === Role.QuoteMark) return dequoteShellWord(text.slice(start, end)).startsWith("-");
    return text[start] === "-" && quoteInsideFlagName(text, start, base);
  });
}

/** The index of the next `'` or `"` at or after `from` in `s`, or -1. */
function nextQuoteMark(s: string, from: number): number {
  for (let k = from; k < s.length; k++) if (s[k] === "'" || s[k] === '"') return k;
  return -1;
}

/**
 * A command separator (`;`, `&`) sitting inside a span delimited by quote marks as seen in
 * `outsideSingle` -- such as a single-quoted fragment inside double quotes, or (for jq, whose double
 * quote marks are kept) a double-quoted argument. A parser that mis-pairs the outer quotes would read the
 * separator as real. After find's `-name`/`-path`/`-iname`, a `|` counts too; after `-regex`, `;`/`&`.
 */
function separatorInsideQuoteMarks(outsideSingle: string): boolean {
  const s = outsideSingle;
  const spanHas = (open: number, chars: string, mustEndWord: boolean): boolean => {
    const close = nextQuoteMark(s, open + 1);
    if (close === -1) return false;
    if (mustEndWord && !(close + 1 === s.length || isBlank(s[close + 1]))) return false;
    for (let k = open + 1; k < close; k++) if (chars.includes(s[k]!)) return true;
    return false;
  };
  for (let i = 0; i < s.length; i++) {
    if ((s[i] === "'" || s[i] === '"') && (i === 0 || isBlank(s[i - 1])) && spanHas(i, ";&", true)) return true;
  }
  for (const [predicate, chars] of [["-name", ";|&"], ["-path", ";|&"], ["-iname", ";|&"], ["-regex", ";&"]] as const) {
    for (let at = s.indexOf(predicate); at !== -1; at = s.indexOf(predicate, at + 1)) {
      let k = at + predicate.length;
      if (!isBlank(s[k])) continue;
      while (isBlank(s[k])) k++;
      if ((s[k] === "'" || s[k] === '"') && spanHas(k, chars, false)) return true;
    }
  }
  return false;
}

/**
 * `$NAME` with a redirection or pipe as its nearest non-blank neighbour on either side (`> $f`, `$f|`):
 * where the output goes, or what runs next, is decided at run time.
 */
function variableBesideRedirectionOrPipe(view: string): boolean {
  // solidBefore[i]: the last non-blank character before i; solidFrom[i]: the first at or after i.
  const solidBefore: Array<string | undefined> = [];
  let last: string | undefined;
  for (let i = 0; i < view.length; i++) {
    solidBefore.push(last);
    if (!isBlank(view[i])) last = view[i];
  }
  const solidFrom: Array<string | undefined> = new Array(view.length + 1);
  for (let i = view.length - 1; i >= 0; i--) solidFrom[i] = isBlank(view[i]) ? solidFrom[i + 1] : view[i];
  const isRouting = (ch: string | undefined): boolean => ch === "<" || ch === ">" || ch === "|";
  for (const match of view.matchAll(/\$[A-Za-z_]\w*/g)) {
    if (isRouting(solidBefore[match.index]) || isRouting(solidFrom[match.index + match[0].length])) return true;
  }
  return false;
}

/** A `#` comment (outside quotes, unescaped) whose line holds a quote mark: quote tracking would desync after it. */
function commentHoldsQuoteMark(lx: Lexed): boolean {
  let inComment = false;
  for (let i = 0; i < lx.text.length; i++) {
    const ch = lx.text[i];
    if (inComment) {
      if (ch === "\n") inComment = false;
      else if (ch === "'" || ch === '"') return true;
      continue;
    }
    if (ch === "#" && isBare(lx, i)) inComment = true;
  }
  return false;
}

/** A newline inside quotes whose next line starts (after blanks) with `#`: line-based reading would drop it as a comment. */
function quotedNewlineBeforeCommentLine(lx: Lexed): boolean {
  if (!lx.text.includes("\n") || !lx.text.includes("#")) return false;
  for (let i = 0; i < lx.text.length; i++) {
    if (lx.text[i] !== "\n" || lx.quoting[i] === Quoting.None || lx.role[i] !== Role.Text) continue;
    let k = i + 1;
    while (k < lx.text.length && lx.text[k] !== "\n" && isBlank(lx.text[k])) k++;
    if (lx.text[k] === "#") return true;
  }
  return false;
}

/**
 * A line break outside quotes that starts another command: anything but blanks follows it, and it is
 * not a ` \`-continuation (a blank, a backslash, then the line break).
 */
function lineBreakStartsCommand(bare: string): boolean {
  let lastNonBlank = -1;
  for (let i = bare.length - 1; i >= 0; i--) {
    if (!isBlank(bare[i])) {
      lastNonBlank = i;
      break;
    }
  }
  for (let i = 0; i < lastNonBlank; i++) {
    if (bare[i] !== "\n" && bare[i] !== "\r") continue;
    const continuation = i >= 2 && bare[i - 1] === "\\" && isBlank(bare[i - 2]);
    if (!continuation) return true;
  }
  return false;
}

/**
 * The field separator named anywhere it could be expanded: `$IFS`, or `IFS` inside a `${…}` (some
 * stretch of text between `}`s holds a `${` with `IFS` after it).
 */
function mentionsIfs(text: string): boolean {
  if (text.includes("$IFS")) return true;
  return text.split("}").some((stretch) => {
    const open = stretch.indexOf("${");
    return open !== -1 && stretch.includes("IFS", open + 2);
  });
}

/** Another process's environment: a line naming `/proc/`, then (after it) `/environ`. */
function readsProcessEnvironment(text: string): boolean {
  return text.split(/[\n\r\u2028\u2029]/).some((line) => {
    const proc = line.indexOf("/proc/");
    return proc !== -1 && line.includes("/environ", proc + "/proc/".length);
  });
}

/** A backtick outside single quotes that is not escaped: command substitution. */
function hasLiveBacktick(lx: Lexed): boolean {
  for (let i = 0; i < lx.text.length; i++) {
    if (lx.text[i] === "`" && lx.quoting[i] !== Quoting.Single && lx.role[i] !== Role.Escaped) return true;
  }
  return false;
}

/** A backslash outside quotes in front of a blank (`ls\ -R` is a single word) or a shell operator (`head f \| sh` is one head). */
function escapesBlankOrOperator(lx: Lexed): boolean {
  for (let i = 0; i < lx.text.length; i++) {
    if (lx.role[i] !== Role.Escape || lx.quoting[i] !== Quoting.None) continue;
    const next = lx.text[i + 1]!;
    if (next === " " || next === "\t" || ";|&<>".includes(next)) return true;
  }
  return false;
}

/**
 * A `#` that is not the first character of its word (`v1#2`, `"k"#`): bash keeps it as text, a lax
 * parser starts a comment there. `${#var}` (a length expansion) is not counted. Checked with line
 * continuations both kept and joined, since joining can glue a `#` to the word before it.
 */
function hashInsideWord(bareWithMarks: string): boolean {
  const glued = (s: string): boolean =>
    s.split(/\s+/).some((word) => {
      for (let at = word.indexOf("#", 1); at !== -1; at = word.indexOf("#", at + 1)) {
        if (!word.slice(0, at).endsWith("${")) return true;
      }
      return false;
    });
  return glued(bareWithMarks) || glued(joinLineContinuations(bareWithMarks));
}

/**
 * Brace expansion outside quotes (`{a,b}`, `{1..5}`): a pair whose own level holds a `,` or `..`.
 * Also refused: more unescaped `}` than `{`, and a quoted lone brace (`'{'`) next to a real one --
 * both skew a parser that counts braces.
 */
function hasBraceExpansion(bare: string, text: string): boolean {
  // The view as a sequence of events: an unescaped `{` or `}` (escaped means: preceded by an odd run
  // of backslashes), or a `,` / `..` separator (escaped or not).
  type BraceEvent = "open" | "close" | "separator";
  const events: BraceEvent[] = [];
  let run = 0;
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i];
    const escaped = run % 2 === 1;
    run = ch === "\\" ? run + 1 : 0;
    if ((ch === "{" || ch === "}") && !escaped) events.push(ch === "{" ? "open" : "close");
    else if (ch === "," || (ch === "." && bare[i + 1] === ".")) events.push("separator");
  }
  const opens = events.filter((e) => e === "open").length;
  const closes = events.filter((e) => e === "close").length;
  if (opens > 0 && closes > opens) return true;

  // Each open brace is closed by the first `}` that is not closing a later one; a separator belongs
  // to the innermost brace still open. A pair that owns a separator expands.
  const owner: number[] = []; // ids of the braces still open, innermost last
  const ownsSeparator = new Set<number>();
  for (const [id, event] of events.entries()) {
    if (event === "open") owner.push(id);
    else if (event === "separator") {
      if (owner.length > 0) ownsSeparator.add(owner[owner.length - 1]!);
    } else if (owner.length > 0 && ownsSeparator.has(owner.pop()!)) return true;
  }

  // A quoted lone brace (`'{'`) beside real ones skews any parser that counts braces.
  if (opens === 0) return false;
  for (let i = 0; i + 2 < text.length; i++) {
    if ((text[i + 1] === "{" || text[i + 1] === "}") && QUOTE_MARK.test(text[i]!) && QUOTE_MARK.test(text[i + 2]!)) return true;
  }
  return false;
}

// zsh builtins that open files, sockets or modules, and the precommand words that may stand before them.
const ZSH_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  "zmodload", "emulate", "sysopen", "sysread", "syswrite", "sysseek", "zpty", "ztcp", "zsocket", "mapfile",
  "zf_rm", "zf_mv", "zf_ln", "zf_chmod", "zf_chown", "zf_mkdir", "zf_rmdir", "zf_chgrp",
]);
const ZSH_PRECOMMAND_MODIFIERS: ReadonlySet<string> = new Set(["command", "builtin", "noglob", "nocorrect"]);

/**
 * The program a command line names, with what follows it: leading `NAME=value` words and zsh's
 * precommand modifiers are peeled off the front first.
 */
const PROGRAM_AFTER_PREFIXES = new RegExp(`^\\s*(?:(?:[A-Za-z_]\\w*=\\S*|${[...ZSH_PRECOMMAND_MODIFIERS].join("|")})\\s+)*(\\S+)([\\s\\S]*)$`);

/** A zsh builtin that reaches files, sockets or modules, or `fc` with an option cluster holding `e` (it runs an editor). */
function runsZshBuiltin(text: string): boolean {
  const named = PROGRAM_AFTER_PREFIXES.exec(text);
  if (named === null) return false;
  const [, program, rest] = named;
  if (ZSH_DANGEROUS_COMMANDS.has(program!)) return true;
  return program === "fc" && rest!.split(/\s+/).some((option) => option[0] === "-" && option.indexOf("e", 1) !== -1);
}

const occurrences = (s: string, ch: string): number => {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
};
/** Quote marks in `s` that no backslash stands directly before. */
const unescapedOccurrences = (s: string, ch: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch && s[i - 1] !== "\\") n++;
  return n;
};

/**
 * Next to a command separator (`;`, `&&`, `||` outside quotes), a word whose brackets or quote marks do
 * not balance -- read the way a lax parser reads it: cut at blanks AND operator characters, the
 * backslash dropped before every character inside double quotes. Such a word is where two parsers
 * split the command differently.
 */
function unbalancedWordNearSeparator(lx: Lexed, bare: string): boolean {
  if (!(bare.includes(";") || bare.includes("&&") || bare.includes("||"))) return false;
  if (lx.unterminated) return true;
  let start = -1;
  for (let i = 0; i <= lx.text.length; i++) {
    const cut = i === lx.text.length || (isBare(lx, i) && (isBlank(lx.text[i]) || ";&|<>()".includes(lx.text[i]!)));
    if (!cut) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;
    const word = shellWords(lx.text.slice(start, i), false, "broad")[0]?.word ?? "";
    start = -1;
    if (
      occurrences(word, "{") !== occurrences(word, "}") ||
      occurrences(word, "(") !== occurrences(word, ")") ||
      occurrences(word, "[") !== occurrences(word, "]") ||
      unescapedOccurrences(word, '"') % 2 !== 0 ||
      unescapedOccurrences(word, "'") % 2 !== 0
    ) {
      return true;
    }
  }
  return false;
}

// Spellings that substitute, expand or run something (bash, zsh and PowerShell forms).
const SUBSTITUTION_PATTERNS: readonly RegExp[] = [
  /<\(/, // process substitution <()
  />\(/, // process substitution >()
  /=\(/, // zsh process substitution =()
  /(?:^|[\s;&|])=[a-zA-Z_]/, // zsh `=cmd` expansion
  /\$\(/, // $() command substitution
  /\$\{/, // ${} parameter substitution
  /\$\[/, // $[] arithmetic
  /~\[/, // zsh parameter expansion
  /\(e:/, // zsh glob qualifier
  /\(\+/, // zsh glob qualifier running a command
  /\}\s*always\s*\{/, // zsh try/always
  /<#/, // PowerShell comment
];

/** Everything a pre-check may read: the text, its character picture, its first space-separated word and the views. */
interface Scanned extends Views {
  text: string;
  lx: Lexed;
  base: string;
  /** `bare` with the redirections that cannot write a file taken out. */
  cleaned: string;
}

/**
 * The pre-checks, grouped by what the trick they catch would achieve. Any one firing means "not
 * read-only". A here-document is never read-only (STRICTER): its `<<` stays in the cleaned view, where
 * the operator group refuses it.
 */
const PRE_CHECKS: Readonly<Record<string, ReadonlyArray<(s: Scanned) => boolean>>> = {
  // Text no parser here models: control or Unicode blank characters, a carriage return (STRICTER:
  // quoted or not), or a fragment that cannot be the start of a command.
  unreadable: [
    (s) => s.text.includes("\r"),
    (s) => CONTROL_CHARACTERS.test(s.text) || UNICODE_WHITESPACE.test(s.text),
    (s) => startsMidway(s.text),
  ],
  // Quoting arranged so a word reads differently to a lax parser than to bash -- a hidden flag, a
  // quote run that pairs up differently, a `#` or quote that one parser treats as a comment.
  hidesAWord: [
    (s) => flagSpelledWithQuotes(s.lx, s.base),
    (s) => hashInsideWord(s.bareWithMarks),
    (s) => commentHoldsQuoteMark(s.lx),
    (s) => quotedNewlineBeforeCommentLine(s.lx),
    (s) => singleQuoteEndsInBackslash(s.lx),
    (s) => unbalancedWordNearSeparator(s.lx, s.bare),
  ],
  // A second command or a redirection slipped past the splitter: a live line break, an escaped blank
  // or operator, a separator inside quote marks, a redirection that can write, or one aimed by a variable.
  smugglesAnOperator: [
    (s) => lineBreakStartsCommand(s.bare),
    (s) => s.cleaned.includes("<") || s.cleaned.includes(">"),
    (s) => variableBesideRedirectionOrPipe(s.cleaned),
    (s) => escapesBlankOrOperator(s.lx),
    (s) => separatorInsideQuoteMarks(s.outsideSingle),
  ],
  // Text that becomes something else when bash runs it: substitutions, brace expansion, the field separator.
  expandsAtRunTime: [
    (s) => hasLiveBacktick(s.lx),
    (s) => SUBSTITUTION_PATTERNS.some((pattern) => pattern.test(s.outsideSingle)),
    (s) => hasBraceExpansion(s.bare, s.text),
    (s) => mentionsIfs(s.text),
  ],
  // A read that reaches past the command's own arguments: jq loading files, a zsh builtin, another
  // process's environment.
  reachesBeyondItsArguments: [
    (s) => jqReachesBeyondItsFilter(s.text, s.base),
    (s) => runsZshBuiltin(s.text),
    (s) => readsProcessEnvironment(s.text),
  ],
};

/** The lexical pre-checks: true when none of them fires on `command`. */
function passesSecurityValidators(command: string): boolean {
  // The leading space-free stretch names the program; jq's double-quoted programs keep their quote marks.
  const program = /^[^ ]*/.exec(command)![0];
  const lx = lex(command);
  const views = viewsOf(lx, /^jq$/.test(program));
  const scanned: Scanned = { ...views, text: command, lx, base: program, cleaned: withoutHarmlessRedirections(views.bare) };
  return Object.values(PRE_CHECKS).every((group) => group.every((fires) => !fires(scanned)));
}

// =====================================================================================================
// Per-command read-only recognition
// =====================================================================================================

/** What may follow `$` to make bash expand it: a name, a digit, or a special parameter. */
const PARAMETER_START = /[A-Za-z_@*#?!$0-9-]/;

/**
 * Text that bash expands at run time into words no check here saw (`wc ?` where a file is named `-c`):
 * a glob character (`*`, `?`, `[`, `]`) outside every quote, or -- outside single quotes --
 * a `$` that starts a parameter expansion. Escaped characters never expand.
 */
function expandsWhenRun(text: string): boolean {
  const lx = lex(text);
  for (let i = 0; i < text.length; i++) {
    if (lx.role[i] !== Role.Text) continue;
    const ch = text[i]!;
    if (lx.quoting[i] === Quoting.None && (ch === "*" || ch === "?" || ch === "[" || ch === "]")) return true;
    const next = text[i + 1];
    if (ch === "$" && lx.quoting[i] !== Quoting.Single && next !== undefined && PARAMETER_START.test(next)) return true;
  }
  return false;
}

/** Programs whose operands are regular expressions or globs, where a backslash is everyday syntax. */
function takesPatterns(simple: SimpleCommand): boolean {
  const [first, second] = simple.words.map((w) => w.value);
  return ["grep", "rg", "fd", "fdfind", "find", "sed"].includes(first ?? "") || (first === "git" && second === "grep");
}

/**
 * STRICTER: a word whose first character is a backslash that bash keeps inside double quotes
 * (`"\-o"`, `"\x"`). Bash passes the backslash on; a reader that drops it sees a different word. That
 * difference is refused where it can matter:
 *   - before `-` or `+` (an option, a date format) or `{`/`}` (xargs' placeholder), for every command;
 *   - anywhere, for a command that does not take patterns (a ref name, a capability, a path).
 * For grep, rg, git grep, fd, find and sed a pattern such as `"\bword\b"` or `"\d+"` is ordinary.
 * A backslash that is itself escaped (`"\\x"`) reads the same to every reader and is never refused.
 */
function keptBackslashMisleads(simple: SimpleCommand): boolean {
  const patterns = takesPatterns(simple);
  return simple.words.some((word) => {
    if (!word.value.startsWith("\\")) return false;
    const broad = shellWords(word.raw, false, "broad")[0]?.word ?? "";
    if (broad.startsWith("\\")) return false;
    const after = word.value[1];
    return !patterns || (after !== undefined && "-+{}".includes(after));
  });
}

/** git options that set configuration or paths able to run commands: `-c`, `--exec-path`, `--config-env`. */
const GIT_CONFIGURING_OPTION = /\s(?:-c|--exec-path|--config-env)[\s=]/;

/**
 * Read-only through the raw-text patterns (the read-only command list and command regexes, and `find`
 * without an action). STRICTER: a word that becomes a flag only after quote removal
 * (`ls -\R`) is refused, since the patterns read the text as written.
 */
function matchesReadOnlyPattern(simple: SimpleCommand): boolean {
  if (simple.words.some((w) => w.value.startsWith("-") && w.raw.includes("\\"))) return false;
  const matched = READ_ONLY_REGEXES.some((regex) => regex.test(simple.text)) || findOnlyLists(simple);
  return matched && !(simple.text.includes("git") && GIT_CONFIGURING_OPTION.test(simple.text));
}

function isSimpleCommandReadOnly(simple: SimpleCommand, platform: Platform): boolean {
  const refused = containsVulnerableUncPath(simple.text, platform) || expandsWhenRun(simple.text) || keptBackslashMisleads(simple);
  return !refused && (isSafeViaFlagAllowlist(simple, platform) || matchesReadOnlyPattern(simple));
}

// -----------------------------------------------------------------------------------------------------
// Per-command flag tables (Claude Code's command/flag data, reused verbatim, with the additions noted)
// -----------------------------------------------------------------------------------------------------

/**
 * What a flag takes: nothing, an integer, any string, one character, exactly `{}` / `EOF`, or
 * (`attached`) a value that must be given as `--flag=VALUE` -- a following word is never its value.
 */
type ArgKind = "none" | "number" | "string" | "char" | "{}" | "EOF" | "attached";
type FlagTable = Record<string, ArgKind>;

interface CommandSpec {
  flags: FlagTable;
  /** Run against the command as written; must match. */
  pattern?: RegExp;
  /** True when the arguments (after the command words) make the command NOT read-only. */
  dangerous?: (text: string, args: string[]) => boolean;
  /** false for a tool that keeps reading flags after `--`. */
  respectsDoubleDash?: boolean;
}

/** A table giving every flag in `names` the argument kind `kind`. */
const takes = (kind: ArgKind, ...names: string[]): FlagTable => Object.fromEntries(names.map((name) => [name, kind]));

const GIT_REF_SELECTION = takes("none", "--all", "--branches", "--tags", "--remotes");
const GIT_DATE_FILTERS = takes("string", "--since", "--after", "--until", "--before");
const GIT_LOG_DISPLAY = { ...takes("none", "--oneline", "--graph", "--decorate", "--no-decorate", "--relative-date"), ...takes("string", "--date") };
const GIT_COUNT = takes("number", "--max-count", "-n");
const GIT_STAT = takes("none", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status");
const GIT_COLOR = takes("none", "--color", "--no-color");
const GIT_PATCH = takes("none", "--patch", "-p", "--no-patch", "--no-ext-diff", "-s");
const GIT_AUTHOR_FILTERS = takes("string", "--author", "--committer", "--grep");

/** `git reflog expire|delete|exists` rewrite or probe the reflog. STRICTER: refused wherever such a word appears. */
const REFLOG_WRITING_SUBCOMMANDS: ReadonlySet<string> = new Set(["expire", "delete", "exists"]);
const reflogWrites = (_text: string, args: string[]): boolean => args.some((arg) => REFLOG_WRITING_SUBCOMMANDS.has(arg));

/**
 * `git tag` / `git branch` list refs, or CREATE one named by an operand. An operand creates a ref
 * unless list mode is already on when it is read (`-l`, `--list`, or a short cluster holding `l`) or
 * the option read last takes an optional value (`--merged <commit>`). Options whose table entry takes
 * a value consume the next word; after `--` every word is an operand; empty words are ignored.
 * STRICTER: a lone `-` is an operand.
 */
function namesNewRef(args: readonly string[], flags: FlagTable, optionalValue: ReadonlySet<string>): boolean {
  let listing = false;
  let optionsOver = false;
  let lastOption = "";
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "") continue;
    const word = optionsOver ? ({ form: "operand" } as const) : readOptionWord(token);
    if (word.form === "end-of-options") {
      optionsOver = true;
      lastOption = "";
    } else if (word.form === "operand") {
      if (!listing && !optionalValue.has(lastOption)) return true;
    } else {
      lastOption = word.form === "long" ? word.name : `-${word.letters}`;
      if (word.inline !== undefined) continue;
      if (lastOption === "--list" || (word.form === "short" && word.letters.includes("l"))) listing = true;
      const kind = kindOf(flags, lastOption);
      if (kind === "number" || kind === "string" || kind === "char") i++;
    }
  }
  return false;
}

/** `git branch --merged` / `--no-merged` take an optional commit: the word after them is not a new branch. */
const BRANCH_OPTIONAL_COMMIT: ReadonlySet<string> = new Set(["--merged", "--no-merged"]);

const GIT_TAG_FLAGS: FlagTable = {
  ...takes("none", "-l", "--list", "--column", "--no-column", "-i", "--ignore-case"),
  ...takes("number", "-n"),
  ...takes("string", "--contains", "--no-contains", "--merged", "--no-merged", "--sort", "--format", "--points-at"),
};

const GIT_BRANCH_FLAGS: FlagTable = {
  ...takes(
    "none",
    "-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--color", "--no-color", "--column",
    "--no-column", "--no-abbrev", "--merged", "--no-merged", "--show-current", "-i", "--ignore-case",
  ),
  // An addition: git takes `--abbrev`'s value only attached (`--abbrev=7`); a detached word names a branch.
  ...takes("attached", "--abbrev"),
  ...takes("string", "--contains", "--no-contains", "--points-at", "--sort"),
};

const BASE64_FLAGS: FlagTable = {
  ...takes("none", "-d", "-D", "--decode", "--ignore-garbage", "-h", "--help", "--version"),
  ...takes("number", "-b", "--break", "-w", "--wrap"),
  ...takes("string", "-i", "--input"),
};

// -s/--set and -f/--file (set the clock) are left out. `--iso-8601` and `--rfc-3339` are read as
// `attached` (an addition): their value must be written `=VALUE`, and a detached word after them is a
// positional (`date --iso-8601 0101000026` sets the clock), so it must be `+FORMAT` like any other.
const DATE_FLAGS: FlagTable = {
  ...takes("string", "-d", "--date", "-r", "--reference"),
  ...takes("attached", "--iso-8601", "--rfc-3339"),
  ...takes("none", "-u", "--utc", "--universal", "-I", "-R", "--rfc-email", "--debug", "--help", "--version"),
};

/** `date`'s positionals must each be `+FORMAT`; any other (`0101000026`, `1234`) SETS the clock. */
function dateSetsClock(_text: string, args: string[]): boolean {
  return operandsOf(args, DATE_FLAGS).some((operand) => !operand.startsWith("+"));
}

const TPUT_DANGEROUS_CAPABILITIES: ReadonlySet<string> = new Set([
  "init", "reset", "rs1", "rs2", "rs3", "is1", "is2", "is3", "iprog", "if", "rf", "clear", "flash",
  "mc0", "mc4", "mc5", "mc5i", "mc5p", "pfkey", "pfloc", "pfx", "pfxl", "smcup", "rmcup",
]);

const TPUT_FLAGS: FlagTable = { ...takes("string", "-T"), ...takes("none", "-V", "-x") };

/**
 * tput's effect, read from its sorted arguments (`partitionArguments`): a short option word whose
 * letters hold `S` makes it read capability names from stdin -- anything at all -- and an operand that
 * names a resetting or reprogramming capability changes the terminal directly.
 */
function tputChangesTerminal(_text: string, args: string[]): boolean {
  const { options, operands } = partitionArguments(args, TPUT_FLAGS);
  const readsStdin = options.some((option) => !option.startsWith("--") && option.split("=")[0]!.includes("S"));
  return readsStdin || operands.some((operand) => TPUT_DANGEROUS_CAPABILITIES.has(operand));
}

const REMOTE_NAME = /^[a-zA-Z0-9_-]+$/;

/** `git remote show` reads exactly one remote, named plainly (a URL would reach any host); `-n` aside. */
function remoteShowReachesBeyondOneRemote(_text: string, args: string[]): boolean {
  let names = 0;
  for (const arg of args) {
    if (arg === "-n") continue;
    if (!REMOTE_NAME.test(arg)) return true;
    names++;
  }
  return names !== 1;
}

const REMOTE_LISTING_OPTIONS: ReadonlySet<string> = new Set(["-v", "--verbose"]);
/** `git remote` only lists when every argument is `-v`/`--verbose`; any other word is a subcommand. */
const remoteDoesMoreThanList = (_text: string, args: string[]): boolean => !args.every((arg) => REMOTE_LISTING_OPTIONS.has(arg));

/** BSD-style `ps` letters without a dash: a group holding `e` prints every process's environment. */
const psPrintsEnvironments = (_text: string, args: string[]): boolean => args.some((arg) => /^[a-zA-Z]+$/.test(arg) && arg.includes("e"));

/** lsof's `+m` (optionally glued to a path) writes a mount supplement file. */
const lsofWritesMountSupplement = (_text: string, args: string[]): boolean => args.some((arg) => arg.slice(0, 2) === "+m");

/** pyright's watch mode keeps running and rewriting its output. */
const pyrightWatches = (_text: string, args: string[]): boolean => args.includes("--watch") || args.includes("-w");

const FD_FLAGS: FlagTable = {
  ...takes(
    "none",
    "-h", "--help", "-V", "--version", "-H", "--hidden", "-I", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent",
    "-s", "--case-sensitive", "-i", "--ignore-case", "-g", "--glob", "--regex", "-F", "--fixed-strings", "-a",
    "--absolute-path", "-L", "--follow", "-p", "--full-path", "-0", "--print0", "-1", "-q", "--quiet", "--show-errors",
    "--strip-cwd-prefix", "--one-file-system", "--prune", "--no-require-git",
  ),
  ...takes("number", "-d", "--max-depth", "--min-depth", "--exact-depth", "-j", "--threads", "--max-results", "--batch-size"),
  ...takes(
    "string",
    "-t", "--type", "-e", "--extension", "-S", "--size", "--changed-within", "--changed-before", "-o", "--owner", "-E",
    "--exclude", "--ignore-file", "-c", "--color", "--max-buffer-time", "--search-path", "--base-directory",
    "--path-separator", "--hyperlink", "--and", "--format",
  ),
  // -x/--exec, -X/--exec-batch (run commands) and -l/--list-details (runs `ls`) are left out.
};

const CHECKSUM_FLAGS: FlagTable = takes(
  "none",
  "-b", "--binary", "-t", "--text", "-c", "--check", "--ignore-missing", "--quiet", "--status", "--strict", "-w", "--warn",
  "--tag", "-z", "--zero", "--help", "--version",
);

/** Ordered: the first entry whose words prefix the command wins (`git remote show` before `git remote`). */
const COMMAND_SPECS: ReadonlyArray<readonly [string, CommandSpec]> = [
  [
    "xargs",
    {
      // -i/-e (optional ATTACHED argument in GNU getopt) are left out: `-i X` would make X the target.
      flags: { ...takes("{}", "-I"), ...takes("number", "-n", "-P", "-L", "-s"), ...takes("EOF", "-E"), ...takes("none", "-0", "-t", "-r", "-x"), ...takes("char", "-d") },
    },
  ],
  [
    "git diff",
    {
      flags: {
        ...GIT_STAT,
        ...GIT_COLOR,
        ...takes(
          "none",
          "--dirstat", "--summary", "--patch-with-stat", "--word-diff", "--color-words", "--no-renames", "--no-ext-diff",
          "--check", "--full-index", "--binary", "--break-rewrites", "--find-renames", "--find-copies",
          "--find-copies-harder", "--irreversible-delete", "--histogram", "--patience", "--minimal",
          "--ignore-space-at-eol", "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines",
          "--function-context", "--exit-code", "--quiet", "--cached", "--staged", "--pickaxe-regex", "--pickaxe-all",
          "--no-index", "-p", "-u", "-s", "-M", "-C", "-B", "-D", "-l", "-R",
        ),
        ...takes("string", "--word-diff-regex", "--ws-error-highlight", "--diff-algorithm", "--relative", "--diff-filter", "-S", "-G", "-O"),
        ...takes("number", "--abbrev", "--inter-hunk-context"),
      },
    },
  ],
  [
    "git log",
    {
      flags: {
        ...GIT_LOG_DISPLAY,
        ...GIT_REF_SELECTION,
        ...GIT_DATE_FILTERS,
        ...GIT_COUNT,
        ...GIT_STAT,
        ...GIT_COLOR,
        ...GIT_PATCH,
        ...GIT_AUTHOR_FILTERS,
        ...takes(
          "none",
          "--abbrev-commit", "--full-history", "--dense", "--sparse", "--simplify-merges", "--ancestry-path", "--source",
          "--first-parent", "--merges", "--no-merges", "--reverse", "--walk-reflogs", "--no-min-parents",
          "--no-max-parents", "--follow", "--no-walk", "--left-right", "--cherry-mark", "--cherry-pick", "--boundary",
          "--topo-order", "--date-order", "--author-date-order", "--pickaxe-regex", "--pickaxe-all",
        ),
        ...takes("number", "--skip", "--max-age", "--min-age"),
        ...takes("string", "--pretty", "--format", "--diff-filter", "-S", "-G"),
      },
    },
  ],
  [
    "git show",
    {
      flags: {
        ...GIT_LOG_DISPLAY,
        ...GIT_STAT,
        ...GIT_COLOR,
        ...GIT_PATCH,
        ...takes("none", "--abbrev-commit", "--word-diff", "--color-words", "--first-parent", "--raw", "-m", "--quiet"),
        ...takes("string", "--word-diff-regex", "--pretty", "--format", "--diff-filter"),
      },
    },
  ],
  [
    "git shortlog",
    {
      flags: {
        ...GIT_REF_SELECTION,
        ...GIT_DATE_FILTERS,
        ...takes("none", "-s", "--summary", "-n", "--numbered", "-e", "--email", "-c", "--committer", "--no-merges"),
        ...takes("string", "--group", "--format", "--author"),
      },
    },
  ],
  // `respectsDoubleDash: false` (an addition): git hands the arguments of `git stash list|show` and
  // `git reflog [show]` on to `git log`/`git diff`, `--` included, so `git stash list -- --output=F`
  // still writes F; and `git ls-remote` would read a word after `--` as the repository.
  ["git reflog", { respectsDoubleDash: false, flags: { ...GIT_LOG_DISPLAY, ...GIT_REF_SELECTION, ...GIT_DATE_FILTERS, ...GIT_COUNT, ...GIT_AUTHOR_FILTERS }, dangerous: reflogWrites }],
  ["git stash list", { respectsDoubleDash: false, flags: { ...GIT_LOG_DISPLAY, ...GIT_REF_SELECTION, ...GIT_COUNT } }],
  [
    "git ls-remote",
    {
      respectsDoubleDash: false,
      // --server-option/-o (sends data to the remote) are left out.
      flags: {
        ...takes("none", "--branches", "-b", "--tags", "-t", "--heads", "-h", "--refs", "--quiet", "-q", "--exit-code", "--get-url", "--symref"),
        ...takes("string", "--sort"),
      },
    },
  ],
  [
    "git status",
    {
      flags: {
        ...takes(
          "none",
          "--short", "-s", "--branch", "-b", "--porcelain", "--long", "--verbose", "-v", "--ignored", "--column",
          "--no-column", "--ahead-behind", "--no-ahead-behind", "--renames", "--no-renames",
        ),
        ...takes("string", "--untracked-files", "-u", "--ignore-submodules", "--find-renames", "-M"),
      },
    },
  ],
  [
    "git blame",
    {
      flags: {
        ...GIT_COLOR,
        ...takes("string", "-L", "--date", "--ignore-rev", "--ignore-revs-file"),
        ...takes(
          "none",
          "--porcelain", "-p", "--line-porcelain", "--incremental", "--root", "--show-stats", "--show-name",
          "--show-number", "-n", "--show-email", "-e", "-f", "-w", "-M", "-C", "--score-debug", "-s", "-l", "-t",
        ),
        ...takes("number", "--abbrev"),
      },
    },
  ],
  [
    "git ls-files",
    {
      flags: {
        ...takes(
          "none",
          "--cached", "-c", "--deleted", "-d", "--modified", "-m", "--others", "-o", "--ignored", "-i", "--stage", "-s",
          "--killed", "-k", "--unmerged", "-u", "--directory", "--no-empty-directory", "--eol", "--full-name", "--debug",
          "-z", "-t", "-v", "-f", "--exclude-standard", "--error-unmatch", "--recurse-submodules",
        ),
        ...takes("number", "--abbrev"),
        ...takes("string", "--exclude", "-x", "--exclude-from", "-X", "--exclude-per-directory"),
      },
    },
  ],
  [
    "git config --get",
    {
      flags: {
        ...takes(
          "none",
          "--local", "--global", "--system", "--worktree", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date",
          "-z", "--null", "--name-only", "--show-origin", "--show-scope",
        ),
        ...takes("string", "--default", "--type"),
      },
    },
  ],
  [
    "git remote show",
    {
      flags: takes("none", "-n"),
      dangerous: remoteShowReachesBeyondOneRemote,
    },
  ],
  ["git remote", { flags: takes("none", "-v", "--verbose"), dangerous: remoteDoesMoreThanList }],
  ["git merge-base", { flags: takes("none", "--is-ancestor", "--fork-point", "--octopus", "--independent", "--all") }],
  [
    "git rev-parse",
    {
      flags: {
        ...takes(
          "none",
          "--verify", "--abbrev-ref", "--symbolic", "--symbolic-full-name", "--show-toplevel", "--show-cdup",
          "--show-prefix", "--git-dir", "--git-common-dir", "--absolute-git-dir", "--show-superproject-working-tree",
          "--is-inside-work-tree", "--is-inside-git-dir", "--is-bare-repository", "--is-shallow-repository",
          "--is-shallow-update", "--path-prefix",
        ),
        ...takes("string", "--short"),
      },
    },
  ],
  [
    "git rev-list",
    {
      flags: {
        ...GIT_REF_SELECTION,
        ...GIT_DATE_FILTERS,
        ...GIT_COUNT,
        ...GIT_AUTHOR_FILTERS,
        ...takes(
          "none",
          "--count", "--reverse", "--first-parent", "--ancestry-path", "--merges", "--no-merges", "--no-min-parents",
          "--no-max-parents", "--walk-reflogs", "--oneline", "--abbrev-commit", "--full-history", "--dense", "--sparse",
          "--source", "--graph",
        ),
        ...takes("number", "--min-parents", "--max-parents", "--skip", "--max-age", "--min-age", "--abbrev"),
        ...takes("string", "--pretty", "--format"),
      },
    },
  ],
  [
    "git describe",
    {
      flags: {
        ...takes("none", "--tags", "--long", "--always", "--contains", "--first-match", "--exact-match", "--dirty", "--broken"),
        ...takes("string", "--match", "--exclude"),
        ...takes("number", "--abbrev", "--candidates"),
      },
    },
  ],
  // --batch (without -check) dumps arbitrary objects from stdin; left out.
  ["git cat-file", { flags: takes("none", "-t", "-s", "-p", "-e", "--batch-check", "--allow-undetermined-type") }],
  [
    "git for-each-ref",
    {
      flags: {
        ...takes("string", "--format", "--sort", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"),
        ...takes("number", "--count"),
      },
    },
  ],
  [
    "git grep",
    {
      flags: {
        ...takes("string", "-e"),
        ...takes(
          "none",
          "-E", "--extended-regexp", "-G", "--basic-regexp", "-F", "--fixed-strings", "-P", "--perl-regexp", "-i",
          "--ignore-case", "-v", "--invert-match", "-w", "--word-regexp", "-n", "--line-number", "-c", "--count", "-l",
          "--files-with-matches", "-L", "--files-without-match", "-h", "-H", "--heading", "--break", "--full-name",
          "--color", "--no-color", "-o", "--only-matching", "--and", "--or", "--not", "--untracked", "--no-index",
          "--recurse-submodules", "--cached", "-q", "--quiet",
        ),
        ...takes("number", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "--max-depth", "--threads"),
      },
    },
  ],
  [
    "git stash show",
    {
      respectsDoubleDash: false,
      flags: {
        ...GIT_STAT,
        ...GIT_COLOR,
        ...GIT_PATCH,
        ...takes("none", "--word-diff"),
        ...takes("string", "--word-diff-regex", "--diff-filter"),
        ...takes("number", "--abbrev"),
      },
    },
  ],
  ["git worktree list", { flags: { ...takes("none", "--porcelain", "-v", "--verbose"), ...takes("string", "--expire") } }],
  ["git tag", { flags: GIT_TAG_FLAGS, dangerous: (_text, args) => namesNewRef(args, GIT_TAG_FLAGS, new Set()) }],
  // --format is left out.
  ["git branch", { flags: GIT_BRANCH_FLAGS, dangerous: (_text, args) => namesNewRef(args, GIT_BRANCH_FLAGS, BRANCH_OPTIONAL_COMMIT) }],
  [
    "file",
    {
      flags: {
        ...takes(
          "none",
          "--brief", "-b", "--mime", "-i", "--mime-type", "--mime-encoding", "--apple", "--check-encoding", "-c",
          "--print0", "-0", "--help", "--version", "-v", "--no-dereference", "-h", "--dereference", "-L", "--keep-going",
          "-k", "--list", "-l", "--no-buffer", "-n", "--preserve-date", "-p", "--raw", "-r", "-s", "--special-files",
          "--uncompress", "-z",
        ),
        ...takes("string", "--exclude", "--exclude-quiet", "-f", "-F", "--separator", "--magic-file", "-m"),
      },
    },
  ],
  [
    "sed",
    {
      flags: {
        ...takes("string", "--expression", "-e"),
        ...takes(
          "none",
          "--quiet", "--silent", "-n", "--regexp-extended", "-r", "--posix", "-E", "--zero-terminated", "-z", "--separate",
          "-s", "--unbuffered", "-u", "--debug", "--help", "--version",
        ),
        ...takes("number", "--line-length", "-l"),
      },
      dangerous: (text, args) => !sedIsAllowed(text, args),
    },
  ],
  [
    "sort",
    {
      // -o/--output (writes a file) is left out.
      flags: {
        ...takes(
          "none",
          "--ignore-leading-blanks", "-b", "--dictionary-order", "-d", "--ignore-case", "-f", "--general-numeric-sort",
          "-g", "--human-numeric-sort", "-h", "--ignore-nonprinting", "-i", "--month-sort", "-M", "--numeric-sort", "-n",
          "--random-sort", "-R", "--reverse", "-r", "--stable", "-s", "--unique", "-u", "--version-sort", "-V",
          "--zero-terminated", "-z", "--check", "-c", "--check-char-order", "-C", "--merge", "-m", "--help", "--version",
        ),
        ...takes("string", "--sort", "--key", "-k", "--field-separator", "-t", "--buffer-size", "-S"),
        ...takes("number", "--parallel", "--batch-size"),
      },
    },
  ],
  ["man", { flags: { ...takes("none", "-a", "--all", "-d", "-f", "--whatis", "-h", "-k", "--apropos", "-w"), ...takes("string", "-l", "-S", "-s") } }],
  // Only bash's own `help` flags: `help` aliased to `man` would otherwise accept man's `-P` pager.
  ["help", { flags: takes("none", "-d", "-m", "-s") }],
  ["netstat", { flags: { ...takes("none", "-a", "-L", "-l", "-n", "-g", "-i", "-s", "-r", "-m", "-v"), ...takes("string", "-f", "-I") } }],
  [
    "ps",
    {
      flags: {
        ...takes(
          "none",
          "-e", "-A", "-a", "-d", "-N", "--deselect", "-f", "-F", "-l", "-j", "-y", "-w", "-ww", "-c", "-H", "--forest",
          "--headers", "--no-headers", "-L", "-T", "-m", "--help", "--info", "-V", "--version",
        ),
        ...takes("number", "--width"),
        ...takes(
          "string",
          "-n", "--sort", "-C", "-G", "-g", "-p", "--pid", "-q", "--quick-pid", "-s", "--sid", "-t", "--tty", "-U", "-u",
          "--user",
        ),
      },
      // BSD-style `e` (a dash-less letter group containing `e`) prints every process's environment.
      dangerous: psPrintsEnvironments,
    },
  ],
  [
    "base64",
    {
      respectsDoubleDash: false,
      flags: BASE64_FLAGS,
      // An addition: at most one input operand (a second one is never an input).
      dangerous: (_text, args) => operandsOf(args, BASE64_FLAGS).length > 1,
    },
  ],
  [
    "grep",
    {
      flags: {
        ...takes(
          "string",
          "-e", "--regexp", "-f", "--file", "--color", "--colour", "--label", "--group-separator", "--binary-files", "-D",
          "--devices", "-d", "--directories", "--exclude", "--exclude-from", "--exclude-dir", "--include",
        ),
        ...takes(
          "none",
          "-F", "--fixed-strings", "-G", "--basic-regexp", "-E", "--extended-regexp", "-P", "--perl-regexp", "-i",
          "--ignore-case", "--no-ignore-case", "-v", "--invert-match", "-w", "--word-regexp", "-x", "--line-regexp", "-c",
          "--count", "-L", "--files-without-match", "-l", "--files-with-matches", "-o", "--only-matching", "-q", "--quiet",
          "--silent", "-s", "--no-messages", "-b", "--byte-offset", "-H", "--with-filename", "-h", "--no-filename", "-n",
          "--line-number", "-T", "--initial-tab", "-u", "--unix-byte-offsets", "-Z", "--null", "-z", "--null-data",
          "--no-group-separator", "-a", "--text", "-r", "--recursive", "-R", "--dereference-recursive", "--line-buffered",
          "-U", "--binary", "--help", "-V", "--version",
        ),
        ...takes("number", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context", "-C", "--context"),
      },
    },
  ],
  [
    "rg",
    {
      // --pre (runs a command per file) is left out.
      flags: {
        ...takes("string", "-e", "--regexp", "-f", "-g", "--glob", "-t", "--type", "-T", "--type-not", "--color"),
        ...takes(
          "none",
          "-i", "--ignore-case", "-S", "--smart-case", "-F", "--fixed-strings", "-w", "--word-regexp", "-v",
          "--invert-match", "-c", "--count", "-l", "--files-with-matches", "--files-without-match", "-n", "--line-number",
          "-o", "--only-matching", "-H", "-h", "--heading", "--no-heading", "-q", "--quiet", "--column", "--type-list",
          "--hidden", "--no-ignore", "-u", "-a", "--text", "-z", "-L", "--follow", "--json", "--stats", "--help",
          "--version", "--debug", "--",
        ),
        ...takes("number", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-m", "--max-count", "-d", "--max-depth"),
      },
    },
  ],
  ["sha256sum", { flags: CHECKSUM_FLAGS }],
  ["sha1sum", { flags: CHECKSUM_FLAGS }],
  ["md5sum", { flags: CHECKSUM_FLAGS }],
  [
    "tree",
    {
      // An addition: tree versions differ on whether `--` ends its options; every word is checked.
      respectsDoubleDash: false,
      // -o/--output writes a file; -R reruns tree with `-o 00Tree.html` per directory. Both left out.
      flags: {
        ...takes(
          "none",
          "-a", "-d", "-l", "-f", "-x", "--gitignore", "--ignore-case", "--matchdirs", "--metafirst", "--prune", "--info",
          "--noreport", "-q", "-N", "-Q", "-p", "-u", "-g", "-s", "-h", "--si", "--du", "-D", "-F", "--inodes", "--device",
          "-v", "-t", "-c", "-U", "-r", "--dirsfirst", "--filesfirst", "-i", "-A", "-S", "-n", "-C", "-X", "-J",
          "--nolinks", "--hyperlink", "--fromfile", "--fromtabfile", "--fflinks", "--help", "--version",
        ),
        ...takes("number", "-L", "--filelimit"),
        ...takes(
          "string",
          "-P", "-I", "--gitfile", "--infofile", "--charset", "--timefmt", "--sort", "-H", "--hintro", "--houtro", "-T",
          "--scheme", "--authority",
        ),
      },
    },
  ],
  [
    "date",
    {
      flags: DATE_FLAGS,
      dangerous: dateSetsClock,
    },
  ],
  [
    "hostname",
    {
      flags: takes(
        "none",
        "-f", "--fqdn", "--long", "-s", "--short", "-i", "--ip-address", "-I", "--all-ip-addresses", "-a", "--alias", "-d",
        "--domain", "-A", "--all-fqdns", "-v", "--verbose", "-h", "--help", "-V", "--version",
      ),
      // No positional: `hostname NAME` sets it.
      pattern: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
    },
  ],
  [
    "info",
    {
      // -o/--output, --dribble, --init-file and --restore are left out.
      flags: {
        ...takes("string", "-f", "--file", "-d", "--directory", "-n", "--node", "-k", "--apropos"),
        ...takes("none", "-a", "--all", "-w", "--where", "--location", "--show-options", "--vi-keys", "--subnodes", "-h", "--help", "--usage", "--version"),
      },
    },
  ],
  [
    "lsof",
    {
      // An addition: lsof's own option parser does not treat `--` as the end of options.
      respectsDoubleDash: false,
      // -D (builds a device cache file) is left out.
      flags: {
        ...takes(
          "none",
          "-?", "-h", "-v", "-a", "-b", "-C", "-l", "-n", "-N", "-O", "-P", "-Q", "-R", "-t", "-U", "-V", "-X", "-H", "-E",
          "-F", "-g", "-i", "-K", "-L", "-o", "-r", "-s", "-S", "-T", "-x",
        ),
        ...takes("string", "-A", "-c", "-d", "-e", "-k", "-p", "-u"),
      },
      // `+m` creates a mount supplement file.
      dangerous: lsofWritesMountSupplement,
    },
  ],
  [
    "pgrep",
    {
      flags: {
        ...takes(
          "string",
          "-d", "--delimiter", "-g", "--pgroup", "-G", "--group", "-O", "--older", "-P", "--parent", "-s", "--session", "-t",
          "--terminal", "-u", "--euid", "-U", "--uid", "-F", "--pidfile", "-r", "--runstates", "--ns", "--nslist",
        ),
        ...takes(
          "none",
          "-l", "--list-name", "-a", "--list-full", "-v", "--inverse", "-w", "--lightweight", "-c", "--count", "-f",
          "--full", "-i", "--ignore-case", "-n", "--newest", "-o", "--oldest", "-x", "--exact", "-L", "--logpidfile",
          "--help", "-V", "--version",
        ),
      },
    },
  ],
  // -S (capability names from stdin) is left out.
  ["tput", { flags: TPUT_FLAGS, dangerous: tputChangesTerminal }],
  [
    "ss",
    {
      // -K/--kill, -D/--diag (dumps to a file), -F/--filter and -N/--net are left out.
      flags: {
        ...takes(
          "none",
          "-h", "--help", "-V", "--version", "-n", "--numeric", "-r", "--resolve", "-a", "--all", "-l", "--listening", "-o",
          "--options", "-e", "--extended", "-m", "--memory", "-p", "--processes", "-i", "--info", "-s", "--summary", "-4",
          "--ipv4", "-6", "--ipv6", "-0", "--packet", "-t", "--tcp", "-M", "--mptcp", "-S", "--sctp", "-u", "--udp", "-d",
          "--dccp", "-w", "--raw", "-x", "--unix", "--tipc", "--vsock", "-Z", "--context", "-z", "--contexts", "-b", "--bpf",
          "-E", "--events", "-H", "--no-header", "-O", "--oneline", "--tipcinfo", "--tos", "--cgroup", "--inet-sockopt",
        ),
        ...takes("string", "-f", "--family", "-A", "--query", "--socket"),
      },
    },
  ],
  ["fd", { flags: FD_FLAGS }],
  ["fdfind", { flags: FD_FLAGS }],
  [
    "pyright",
    {
      respectsDoubleDash: false,
      flags: {
        ...takes("none", "--outputjson", "--stats", "--verbose", "--version", "--dependencies", "--warnings"),
        ...takes("string", "--project", "-p", "--pythonversion", "--pythonplatform", "--typeshedpath", "--venvpath", "--level"),
      },
      dangerous: pyrightWatches,
    },
  ],
  ["docker logs", { flags: { ...takes("none", "--follow", "-f", "--timestamps", "-t", "--details"), ...takes("string", "--tail", "-n", "--since", "--until") } }],
  ["docker inspect", { flags: { ...takes("string", "--format", "-f", "--type"), ...takes("none", "--size", "-s") } }],
];

/** Targets xargs may run: none has a flag that writes, executes or reaches the network. */
const XARGS_SAFE_TARGETS: ReadonlySet<string> = new Set(["echo", "printf", "wc", "grep", "head", "tail"]);

// -----------------------------------------------------------------------------------------------------
// Reading a command's options against its flag table
// -----------------------------------------------------------------------------------------------------

/** One word of an argument list, read the way getopt-style parsers read it. */
type OptionWord =
  | { form: "end-of-options" } // `--`
  | { form: "operand" } // not an option: a path, a pattern, a revision; also a bare `-` and an empty word
  | { form: "long"; name: string; inline?: string } // `--name` or `--name=value`
  | { form: "short"; letters: string; inline?: string }; // `-abc`, `-a=value`

function readOptionWord(token: string): OptionWord {
  if (token === "--") return { form: "end-of-options" };
  if (token.length < 2 || !token.startsWith("-")) return { form: "operand" };
  const eq = token.indexOf("=");
  const head = eq === -1 ? token : token.slice(0, eq);
  const inline = eq === -1 ? undefined : token.slice(eq + 1);
  if (head.startsWith("--")) return inline === undefined ? { form: "long", name: head } : { form: "long", name: head, inline };
  const letters = head.slice(1);
  return inline === undefined ? { form: "short", letters } : { form: "short", letters, inline };
}

/** A word that the option parser would take as an option rather than as a value. */
const looksLikeOption = (token: string): boolean => token.length > 1 && token.startsWith("-");

function kindOf(flags: FlagTable, name: string): ArgKind | undefined {
  return Object.hasOwn(flags, name) ? flags[name] : undefined;
}

/** Whether `value` is an acceptable argument of kind `kind` for flag `flag` of `command`. */
function valueFits(kind: ArgKind, value: string, flag: string, command: string): boolean {
  switch (kind) {
    case "number":
      return /^\d+$/.test(value);
    case "string":
    case "attached":
      // A value that looks like a flag may not be consumed as a value at all; git's `--sort` takes a
      // leading `-` to reverse the order (`--sort=-committerdate`).
      return !value.startsWith("-") || (command === "git" && flag === "--sort" && /^-[a-zA-Z]/.test(value));
    case "char":
      return value.length === 1;
    case "{}":
    case "EOF":
      return value === kind;
    default:
      return false;
  }
}

/**
 * Checks the option at `tokens[i]` against `flags`. Returns how many words it used (itself, plus a
 * detached value), or null when the option is not an exact entry of the table used the way the
 * table allows.
 *
 *   - an exact table entry, long or short (`--stat`, `-n`, `-vv`): a no-argument flag must not carry
 *     `=value`; a valued flag takes `=value` or the next word (which must not look like an option);
 *     an `attached` flag takes its (required) value only as `=value`;
 *   - git's `-<number>` (a commit count) and grep/rg's `-A20` (a numeric value glued to a valued flag);
 *   - a cluster of short flags (`-nr`): every letter must be a no-argument flag, and no `=`.
 * Anything else -- a GNU abbreviation (`--outp`), an unknown letter, a dash that is not ASCII -- is
 * not accepted.
 */
function acceptOption(tokens: readonly string[], i: number, flags: FlagTable, command: string): number | null {
  const word = readOptionWord(tokens[i]!);
  if (word.form !== "long" && word.form !== "short") return null;
  const name = word.form === "long" ? word.name : `-${word.letters}`;
  const kind = kindOf(flags, name);
  if (kind !== undefined) {
    if (kind === "none") return word.inline === undefined ? 1 : null;
    if (kind === "attached") return word.inline !== undefined && valueFits(kind, word.inline, name, command) ? 1 : null;
    if (word.inline !== undefined) return valueFits(kind, word.inline, name, command) ? 1 : null;
    const value = tokens[i + 1];
    if (value === undefined || looksLikeOption(value)) return null;
    return valueFits(kind, value, name, command) ? 2 : null;
  }
  if (word.form === "long" || word.inline !== undefined) return null;
  if (command === "git" && /^\d+$/.test(word.letters)) return 1;
  if (command === "grep" || command === "rg") {
    const leading = kindOf(flags, `-${word.letters[0]}`);
    if ((leading === "number" || leading === "string") && /^\d+$/.test(word.letters.slice(1))) return 1;
  }
  for (const letter of word.letters) {
    if (kindOf(flags, `-${letter}`) !== "none") return null;
  }
  return 1;
}

/**
 * Every option in `tokens` from `start` on is accepted by `spec`. Operands are skipped. `--` ends the
 * check for a program that stops reading options there; for one that does not (`respectsDoubleDash:
 * false`), the words after it are still checked as options.
 */
function optionsAllowed(tokens: readonly string[], start: number, spec: CommandSpec, command: string): boolean {
  let i = start;
  while (i < tokens.length) {
    const word = readOptionWord(tokens[i]!);
    if (word.form === "operand") {
      i++;
      continue;
    }
    if (word.form === "end-of-options") {
      if (spec.respectsDoubleDash !== false) return true;
      i++;
      continue;
    }
    const used = acceptOption(tokens, i, spec.flags, command);
    if (used === null) return false;
    i += used;
  }
  return true;
}

/**
 * xargs: its own options, then the command it runs -- the first operand (a bare `-` and an empty word
 * included), or the word after `--`. That command's own arguments are not checked, so only a target
 * with no writing or executing flag at all qualifies. No command at all runs `echo`.
 */
function xargsAllowed(tokens: readonly string[], start: number, spec: CommandSpec): boolean {
  let i = start;
  while (i < tokens.length) {
    const word = readOptionWord(tokens[i]!);
    if (word.form === "end-of-options") {
      const target = tokens[i + 1];
      return target !== undefined && XARGS_SAFE_TARGETS.has(target);
    }
    if (word.form === "operand") return XARGS_SAFE_TARGETS.has(tokens[i]!);
    const used = acceptOption(tokens, i, spec.flags, "xargs");
    if (used === null) return false;
    i += used;
  }
  return true;
}

/** The operands in `args` (after `--`, every word), skipping the values of `flags`' valued options. */
function operandsOf(args: readonly string[], flags: FlagTable): string[] {
  return partitionArguments(args, flags).operands;
}

/**
 * `args` sorted into the option words (each as written, its detached value left out) and the operands,
 * by `flags`: an option whose entry takes a value consumes the next word unless it carries `=value`;
 * `--` is neither, and after it every word is an operand.
 */
function partitionArguments(args: readonly string[], flags: FlagTable): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let optionsOver = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const word = optionsOver ? ({ form: "operand" } as const) : readOptionWord(token);
    if (word.form === "end-of-options") optionsOver = true;
    else if (word.form === "operand") operands.push(token);
    else {
      options.push(token);
      const kind = word.inline === undefined ? kindOf(flags, word.form === "long" ? word.name : `-${word.letters}`) : undefined;
      if (kind === "number" || kind === "string" || kind === "char" || kind === "{}" || kind === "EOF") i++;
    }
  }
  return { options, operands };
}

/** The table, each entry's command name split into the words it must start with. */
const SPEC_LEADING_WORDS: ReadonlyArray<{ leading: readonly string[]; spec: CommandSpec }> = COMMAND_SPECS.map(([name, spec]) => ({ leading: name.split(" "), spec }));

/**
 * The first table entry whose command words open `tokens` (the table lists `git remote show` before
 * `git remote`, so the most specific entry wins). Not xargs on Windows: there a file holding a UNC path
 * turns `cat f | xargs cat` into a network request.
 */
function commandSpecFor(tokens: readonly string[], platform: Platform): { spec: CommandSpec; words: number } | undefined {
  const entry = SPEC_LEADING_WORDS.find(({ leading }) => leading.every((word, k) => tokens[k] === word) && !(leading[0] === "xargs" && platform === "win32"));
  return entry && { spec: entry.spec, words: entry.leading.length };
}

/** A `git ls-remote` operand that names a URL, an scp-style remote or an expansion: a network read to anywhere. */
const namesRemoteLocation = (token: string): boolean =>
  token.length > 0 && !token.startsWith("-") && (token.includes("://") || token.includes("@") || token.includes(":") || token.includes("$"));

/** A word that changes at run time: an expansion, or brace expansion (`{a,b}`, `{1..3}`). */
const expandsAtRunTime = (token: string): boolean => token.includes("$") || (token.includes("{") && (token.includes(",") || token.includes("..")));

/** Read-only through the per-command flag tables. */
function isSafeViaFlagAllowlist(sub: SimpleCommand, platform: Platform): boolean {
  const tokens = sub.words.map((w) => w.value);
  const match = commandSpecFor(tokens, platform);
  if (match === undefined) return false;
  const { spec, words } = match;
  const args = tokens.slice(words);
  if (args.some(expandsAtRunTime)) return false;
  if (tokens[0] === "git" && tokens[1] === "ls-remote" && args.some(namesRemoteLocation)) return false;
  const optionsOk = tokens[0] === "xargs" ? xargsAllowed(tokens, words, spec) : optionsAllowed(tokens, words, spec, tokens[0]!);
  if (!optionsOk) return false;
  if (spec.pattern !== undefined) {
    if (!spec.pattern.test(sub.text)) return false;
  } else if (sub.text.includes("`") || ((tokens[0] === "rg" || tokens[0] === "grep") && /[\n\r]/.test(sub.text))) {
    return false;
  }
  return !(spec.dangerous?.(sub.text, args) ?? false);
}

// -----------------------------------------------------------------------------------------------------
// sed: a `-n` print script, or one substitution printed to stdout
// -----------------------------------------------------------------------------------------------------
//
// sed writes files through `-i`/`--in-place`, the `w`/`W` commands and the `w` flag of `s`, and runs
// commands through `e` and the `e` flag of `s`. Rather than look for those, the script must be one of
// two shapes that can do neither, and every option must belong to that shape:
//
//   print:      quiet (`-n`/`--quiet`/`--silent`) plus only -E/-r/-z/--posix; the script is
//               `;`-separated `p`, `Np` or `N,Mp` (blanks around each allowed); any further operands
//               are input files.
//   substitute: only -E/-r/--posix; exactly one operand, the script `s/PATTERN/REPLACEMENT/FLAGS`
//               with `/` as the delimiter appearing exactly three times (so no escaped or bracketed
//               slash can move a delimiter), FLAGS drawn from g, p, i, I, m, M and one digit 1-9;
//               output to stdout only.
//
// `-e`/`--expression` (which can splice several scripts) is never accepted. On top of the shape, the
// substitution's text must avoid what would read differently to a sed that parses addresses, comments,
// blocks or command lists inside it: non-ASCII, a line break, `{`, `}`, `#`, `;`, `!`, `~`, a `,`
// followed by `+`/`-`, an `s` directly before a backslash, a backslash before `|`, `%` or `@`, a blank
// before `w`/`W`/`e`/`E`, or a `y` (followed by anything but a backslash) together with any of
// `w`/`W`/`e`/`E`. Over the whole argument text, `-e` glued to `w`/`W`/`e` or `-w` glued to `e`/`E`
// (a bundled option that would take a script or a file name) is refused too. STRICTER: some harmless
// substitutions (`s/key/value/`) and every regex address (`/x/p`) are refused; they simply run serially.

const SED_QUIET: readonly string[] = ["-n", "--quiet", "--silent"];
const SED_PRINT_OPTIONS = { long: ["--quiet", "--silent", "--regexp-extended", "--zero-terminated", "--posix"], letters: "nErz" };
const SED_SUBSTITUTE_OPTIONS = { long: ["--regexp-extended", "--posix"], letters: "Er" };

/** Every option is one of `allowed`'s long names or a cluster of its short letters. */
function sedOptionsWithin(options: readonly string[], allowed: { long: readonly string[]; letters: string }): boolean {
  return options.every((option) =>
    option.startsWith("--") ? allowed.long.includes(option) : option.length > 1 && [...option.slice(1)].every((letter) => allowed.letters.includes(letter)),
  );
}

/** One or more `p` / `Np` / `N,Mp` commands separated by `;`, blanks allowed around each. */
const SED_PRINT_SCRIPT = /^(?:\d+(?:,\d+)?)?p\s*(?:;\s*(?:\d+(?:,\d+)?)?p\s*)*$/;

function sedPrintScript(script: string): boolean {
  const trimmed = script.trim();
  return !trimmed.includes("\n") && SED_PRINT_SCRIPT.test(trimmed);
}

function sedSubstituteScript(script: string): boolean {
  const s = script.trim();
  if (!s.startsWith("s/") || occurrences(s, "/") !== 3) return false;
  // The three slashes must all be unescaped delimiters.
  const delimiters: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      if (s[i + 1] === "/") return false;
      i++;
      continue;
    }
    if (s[i] === "/") delimiters.push(i);
  }
  if (delimiters.length !== 3) return false;
  if (!/^[gpimIM]*[1-9]?[gpimIM]*$/.test(s.slice(delimiters[2]! + 1))) return false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    if (code === 0 || code > 0x7f) return false;
    if ("\n{}#;!~".includes(ch)) return false;
    if (ch === "\\" && s[i - 1] === "s") return false;
    if (ch === "\\" && "|#%@".includes(s[i + 1] ?? "")) return false;
    if (isBlank(ch) && "wWeE".includes(s[i + 1] ?? " ")) return false;
    if (ch === ",") {
      let k = i + 1;
      while (isBlank(s[k])) k++;
      if (s[k] === "+" || s[k] === "-") return false;
    }
  }
  const transliterates = /y[^\\\n]/.test(s);
  return !(transliterates && /[wWeE]/.test(s));
}

/** sed that only prints: a `-n` print script, or one substitution to stdout (see above). */
function sedIsAllowed(text: string, args: readonly string[]): boolean {
  if (!text.startsWith("sed ")) return false;
  const argumentText = text.slice(4);
  if (/-e[wWe]|-w[eE]/.test(argumentText)) return false;
  const options = args.filter((a) => a.startsWith("-") && a !== "--");
  const operands = args.filter((a) => !a.startsWith("-"));
  const script = operands[0];
  if (script === undefined) return false;
  const quiet = options.some((o) => SED_QUIET.includes(o) || (!o.startsWith("--") && o.includes("n")));
  if (quiet && sedOptionsWithin(options, SED_PRINT_OPTIONS)) return sedPrintScript(script);
  return operands.length === 1 && sedOptionsWithin(options, SED_SUBSTITUTE_OPTIONS) && sedSubstituteScript(script);
}

// -----------------------------------------------------------------------------------------------------
// Raw-text recognisers (Claude Code's read-only command list and command patterns, reused as data)
// -----------------------------------------------------------------------------------------------------

/** Commands with no flag that writes, executes or reaches the network: any arguments without shell syntax. */
const PLAIN_READ_ONLY_COMMANDS: readonly string[] = [
  "docker ps", "docker images",
  "cal", "uptime",
  "cat", "head", "tail", "wc", "stat", "strings", "hexdump", "od", "nl",
  "id", "uname", "free", "df", "du", "locale", "groups", "nproc",
  "basename", "dirname", "realpath",
  "cut", "paste", "tr", "column", "tac", "rev", "fold", "expand", "unexpand", "fmt", "comm", "cmp", "numfmt",
  "readlink", "diff", "true", "false",
  "sleep", "which", "type", "expr", "test", "getconf", "seq", "tsort", "pr",
];

/** The argument part of every plain read-only command's pattern: anything without shell syntax. */
const PLAIN_ARGUMENTS = "(?:\\s|$)[^<>()$`|{}&;\\n\\r]*$";

/** find's actions that delete, write a file or run a command. */
const FIND_ACTIONS = /-(?:delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)\b/;
/** Shell syntax that may not appear in a read-only `find` (its `\(` / `\)` grouping excepted). */
const FIND_FORBIDDEN_SYNTAX = "<>()$`|{}&;\n\r";

/**
 * `find` with none of `FIND_ACTIONS`, read both as written and after quote removal (`find . '-delete'`
 * deletes), and with no shell syntax beyond escaped parentheses for grouping.
 */
function findOnlyLists(simple: SimpleCommand): boolean {
  if (simple.words[0]!.raw !== "find") return false;
  const args = simple.text.slice("find".length);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "\\" && (args[i + 1] === "(" || args[i + 1] === ")")) {
      i++;
      continue;
    }
    if (FIND_FORBIDDEN_SYNTAX.includes(args[i]!)) return false;
  }
  return !FIND_ACTIONS.test(args) && simple.words.every((w) => !FIND_ACTIONS.test(w.value));
}

const READ_ONLY_REGEXES: readonly RegExp[] = [
  ...PLAIN_READ_ONLY_COMMANDS.map((name) => new RegExp("^" + name + PLAIN_ARGUMENTS)),
  // echo of literals only (no variables, no substitutions), optionally `2>&1`.
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,
  /^claude -h$/,
  /^claude --help$/,
  // uniq with flags only -- no input/output file.
  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/,
  /^pwd$/,
  /^whoami$/,
  // Exact version checks only (`node -v --run task` runs a package script).
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,
  /^history(?:\s+\d+)?\s*$/,
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/,
  /^ip addr$/,
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/,
  // jq with inline filters; never -f/--from-file, --rawfile, --slurpfile, --run-tests, -L/--library-path, env, $ENV.
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
];

// =====================================================================================================
// From grammar.ts
// =====================================================================================================


// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

// Provisional parser input-length cap (WS-07 §3: "commands over the parser limit... fall back to
// permission handling"). No public value is pinned anywhere in scope for this task; 50k chars is
// comfortably above any realistic single shell invocation while still bounding the scan cost of a
// pathological input. Revisit if a differential capture (WS-17) pins a real number.
//
// Fix round 1, Finding A / P2 fix-wave item 2 correction: this comment used to claim TWO things
// that are no longer (and, for the second, were never actually) true. (1) "Scoped to splitCompound
// only" -- false since fix round 1's own isRecognizedReadOnly guard (scanIfParseable, above) also
// consults it; both of scanIfParseable's two callers share this one cap. (2) "the other functions
// here ... simply do proportionally more linear work" -- also false as originally stated:
// stripWrappers/stripLeadingAssignments/extractRedirectTargets each had an internal loop that
// re-derived a fresh scanShellLike over an ever-shrinking SLICED substring once per
// wrapper/flag/redirect, making their worst case polynomial, not linear, for an input with many of
// those (e.g. many single-char flags, or many chained redirects) -- PARSE_LIMIT alone never bounded
// that cost, since it only bounds the INITIAL scan's own starting length, not how many times a
// downstream loop re-scans a shrinking tail of it. The fix-wave's own threading change
// (leadingWordAt/stripLeadingAssignmentsAt below, sharing ONE scan across a whole call via a plain
// integer offset into the unchanging original string, never a re-scanned slice) is what actually
// makes those three functions linear; this cap remains a separate, complementary bound on the
// scan's own starting length, orthogonal to that fix.
export const PARSE_LIMIT = 50_000;

// Fix round 1, Finding B / Ruling P2-C: env-variable NAMES whose assignment can change what a
// subsequent command actually does regardless of how innocuous the ASSIGNED VALUE looks
// syntactically -- e.g. `LD_PRELOAD=/tmp/evil.so cat /etc/passwd` has a value with no `$(`/
// backtick/`${` in it, so `isSafeAssignmentValue` alone would call it safe and strip it, but a
// real shell still loads the preload library before `cat` ever runs. A NAME match makes the
// assignment un-strippable on the ALLOW side regardless of its value; denyAsk's existing "look
// through ANY leading assignment" is unaffected (dangerous-by-name is a strict subset of "any").
// Matching is case-exact (env var names are case-sensitive in every shell/OS environ this targets)
// -- deliberately NOT normalized to upper/lower case before the `.has()` check. Exported,
// independently curated, and capture-noted: this list is not confirmed exhaustive against any
// pinned runtime, and P3/a future WS-17 differential capture may extend it.
const DANGEROUS_ASSIGNMENT_NAMES: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "PERL5LIB",
  "PYTHONPATH",
  "NODE_OPTIONS",
]);

// Fixed wrapper set (WS-07 §3, verbatim list) stripped for POSITIVE (allow) matching recognition;
// `xargs` is handled separately below because of its flag-free precondition.
const FIXED_WRAPPERS: ReadonlySet<string> = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
]);
const XARGS = "xargs";

// Judgment call: the fixed wrapper set is documented by name only (WS-07 §3 doesn't describe each
// wrapper's own argument shape). Stripping only the bare word "timeout" would leave its required
// positional duration argument (e.g. the "30" in `timeout 30 ls`) in front of the real command,
// defeating the entire point of wrapper-stripping (the remainder would never match a plain
// `Bash(ls *)` rule). `timeout` is the one fixed-set wrapper with a well-known REQUIRED positional
// argument; every other fixed wrapper is modeled as flags-only before the wrapped command begins.
const WRAPPERS_WITH_POSITIONAL_ARG: ReadonlySet<string> = new Set(["timeout"]);

// ---------------------------------------------------------------------------------------------
// Shared low-level shell-like scanner
// ---------------------------------------------------------------------------------------------
//
// One shared quote/paren-depth scan powers splitCompound, stripWrappers' word/assignment reading,
// and extractRedirectTargets' target reading, so quoting is handled identically everywhere. Known,
// deliberate limitations (not in this task's fixture corpus, flagged rather than built): brace
// expansion / `${...}` is not depth-tracked (only `(...)`, which also covers `$(...)` and process
// substitution `<(...)`/`>(...)` for free, since only the paren itself is special); a heredoc BODY
// is not excluded from the scan (only the introducing `<<` operator is recognized-and-skipped by
// `extractRedirectTargets`), so a body that itself contains a top-level `>`-family sequence could
// false-positive as a redirect target.
interface ScanInfo {
  // topLevel[i] === true means s[i] sits at paren-depth 0 and outside any quote/backtick span --
  // i.e. a position where an operator or whitespace is structurally meaningful. Positions inside
  // quotes or parens are always false, so callers naturally skip over them without special-casing.
  topLevel: boolean[];
  ok: boolean; // false => unterminated quote or unbalanced parens (unparseable)
}

function scanShellLike(s: string): ScanInfo {
  const topLevel: boolean[] = new Array<boolean>(s.length).fill(false);
  let depth = 0;
  // `$'` is bash's ANSI-C quoting: single-quoted, but `\'` does NOT end it. Treating it as a plain
  // single quote ended it early, and the rest of the string was read with the wrong quote parity.
  let quote: '"' | "'" | "`" | "$'" | null = null;
  let ok = true;
  let dollarAt = -2; // index of the last UNQUOTED, UNESCAPED `$`

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (quote === "'") {
        if (ch === "'") quote = null;
      } else if (quote === "$'") {
        if (ch === "\\" && i + 1 < s.length) {
          i++;
          continue;
        }
        if (ch === "'") quote = null;
      } else {
        // double-quote or backtick: backslash escapes the next character
        if (ch === "\\" && i + 1 < s.length) {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < s.length) i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch === "'" && dollarAt === i - 1 ? "$'" : ch;
      continue;
    }
    if (ch === "$") dollarAt = i;
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) ok = false;
      else depth--;
      continue;
    }
    if (depth === 0) topLevel[i] = true;
  }
  if (quote !== null) ok = false;
  if (depth !== 0) ok = false;
  return { topLevel, ok };
}

// Fix round 1, Finding A: the shared "is this command parseable at all" gate (WS-07 §3:
// "unparseable commands, commands over the parser limit... fall back to permission handling").
// Threads ONE scan result out to both `splitCompound` (structural decomposition) and
// `isRecognizedReadOnly` (a pre-approval shortcut that must not fire on text it can't confidently
// analyze) rather than each re-deriving the same length-check-then-scan inline, which would mean
// two full rescans of the same string for two callers checking the identical precondition. Returns
// `null` for "not parseable" (over limit, or scanShellLike reports unterminated
// quote/unbalanced parens); the caller never needs to call scanShellLike a second time on success.
function scanIfParseable(command: string): ScanInfo | null {
  if (command.length > PARSE_LIMIT) return null;
  const info = scanShellLike(command);
  return info.ok ? info : null;
}

// P2 fix-wave item 2 (Finding C / "O(n^2) worst case in stripWrappers/stripLeadingAssignments/
// extractRedirectTargets", refused at the trivial-bar during T3's own round): reads one
// whitespace-delimited "word" starting at `start` within `s`, using an ALREADY-COMPUTED ScanInfo
// for the FULL string `s` -- never re-scanned here. Returns the END index (exclusive), never a
// sliced "rest of string", so a caller walking `s` left-to-right in a loop (stripWrappers' own
// wrapper/flag-stripping loop, extractRedirectTargets' own operator loop) shares ONE scan across
// every word it reads, via a plain integer offset into the SAME unchanging string, instead of each
// call re-deriving topLevel/ok from scratch over an ever-shrinking SLICED tail substring. That
// repeated re-derivation was the actual O(n^2) shape: k words/flags/redirects in a command of
// length n cost O(n) each to (re)scan, O(n*k) total, k ~ n in the worst case (many chained
// single-char flags, or many chained "xargs xargs xargs ... cmd" wrappers, or many redirects).
//
// A word may itself contain top-level whitespace's OPPOSITE -- non-top-level spans (quoted/
// parenthesized) -- without ending; it only stops at whitespace that is itself top-level. Returns
// `undefined` word when nothing top-level remains from `start` onward.
function leadingWordAt(s: string, info: ScanInfo, start: number): { word: string | undefined; end: number } {
  const isTop = (i: number) => (info.ok ? info.topLevel[i] === true : true); // defensive fallback: plain whitespace split if the fragment itself is malformed
  let i = start;
  while (i < s.length && isTop(i) && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return { word: undefined, end: i };
  const wordStart = i;
  while (i < s.length && !(isTop(i) && /\s/.test(s[i]!))) i++;
  return { word: s.slice(wordStart, i), end: i };
}

// Single-shot convenience wrapper for a caller that reads AT MOST one or two words and never loops
// (isRecognizedReadOnly's own two call sites, below) -- scans once, reads once. Byte-identical
// public contract to the pre-fix-wave `leadingWord` this replaces; a looping caller should use
// `leadingWordAt` directly against one shared, precomputed ScanInfo instead of this wrapper.
// N4 (fix wave, P3 close-out): exported -- bash.ts's own `extractBashPaths` cd-tracking used a
// quote-UNAWARE regex (`/^cd\s+(\S+)/`) instead of this scanner, so `cd "my dir" && echo x > f`
// mis-based `f` (the regex's own `\S+` stops at the first whitespace, even inside quotes). This is
// the exact "single word, no loop" shape this wrapper was built for -- reused, not duplicated.
function leadingWord(s: string): { word: string | undefined; afterWord: string } {
  const { word, end } = leadingWordAt(s, scanShellLike(s), 0);
  return { word, afterWord: s.slice(end) };
}

// ---------------------------------------------------------------------------------------------
// Line continuations
// ---------------------------------------------------------------------------------------------

/**
 * Joins backslash-newline continuations the way bash does before it parses: an ODD run of
 * backslashes before a newline ends in a continuation (the last backslash and the newline vanish);
 * an even run is escaped backslashes followed by a real newline. Without this, `echo x >
 * \<newline>.git/config` read its target as `\<newline>.git/config` -- a name with no `.git`
 * segment -- while bash wrote `.git/config` (claude joins them before its own redirect scan).
 */
export function joinLineContinuations(command: string): string {
  if (!command.includes("\\\n")) return command;
  // One forward pass (a backtracking `\\+\n` regex is quadratic on a long backslash run with no
  // newline after it): measure each backslash run, then look at the character that ends it.
  let out = "";
  let i = 0;
  while (i < command.length) {
    if (command[i] !== "\\") {
      out += command[i];
      i++;
      continue;
    }
    let end = i;
    while (end < command.length && command[end] === "\\") end++;
    const run = end - i;
    if (command[end] === "\n" && run % 2 === 1) {
      out += "\\".repeat(run - 1);
      i = end + 1; // the escaping backslash and the newline both vanish
    } else {
      out += "\\".repeat(run);
      i = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// splitCompound
// ---------------------------------------------------------------------------------------------

function splitCompound(rawCommand: string): string[] | null {
  const command = joinLineContinuations(rawCommand);
  const info = scanIfParseable(command);
  if (!info) return null;
  const { topLevel } = info;

  const parts: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i < command.length) {
    if (!topLevel[i]) {
      i++;
      continue;
    }
    // `>|` is the noclobber-overriding REDIRECT, not a pipe: `echo x >| .git/config` is one command
    // writing `.git/config`, never `echo x >` piped into a command named `.git/config`.
    if (command[i] === "|" && i > 0 && topLevel[i - 1] && command[i - 1] === ">") {
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      parts.push(command.slice(segStart, i));
      i += 2;
      segStart = i;
      continue;
    }
    if (two === "&>") {
      // redirect-both-streams -- NOT the background operator; pass both characters through.
      i += 2;
      continue;
    }
    const ch = command[i]!;
    if (ch === "&") {
      // A `&` immediately after `>` is the second half of a `>&` dup-redirect (e.g. `2>&1`), not
      // the background operator -- `>` itself is ordinary/unspecial to this function, so by the
      // time we reach this `&` the `>` has already been walked over as plain text.
      if (command[i - 1] === ">") {
        i++;
        continue;
      }
      parts.push(command.slice(segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      parts.push(command.slice(segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    i++;
  }
  parts.push(command.slice(segStart));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------------------------
// stripWrappers
// ---------------------------------------------------------------------------------------------

function isSafeAssignmentValue(value: string): boolean {
  // "known-safe" (allow-direction) leading assignments: a plain literal/quoted literal with no
  // command execution or expansion hiding inside it. Anything with command substitution or
  // parameter/arithmetic expansion could make the ACTUAL executed text differ from what an allow
  // rule's glob was written against, so it is not safe to look through when deciding whether an
  // ALLOW rule applies.
  return !/\$\(|`|\$\{/.test(value);
}

// P2 fix-wave item 2: threaded sibling of stripLeadingAssignments (below) -- operates on `s`/`info`
// (the SAME string and precomputed scan stripWrappers' own loop shares across every wrapper/
// assignment/flag it strips) starting at `start`, returning the new offset rather than a sliced
// string. A STICKY (non-global, `y` flag) regex anchors the assignment-name match at exactly
// `start` without a fresh `.slice(pos)` allocation on every iteration, closing the identical rescan
// shape one level down (many chained leading assignments, e.g. "A=1 B=2 C=3 ... cmd").
const ASSIGNMENT_NAME_RE = /[A-Za-z_][A-Za-z0-9_]*=/y;
function stripLeadingAssignmentsAt(s: string, info: ScanInfo, start: number, direction: "allow" | "denyAsk"): number {
  const isTop = (i: number) => (info.ok ? info.topLevel[i] === true : true);
  let pos = start;
  for (;;) {
    while (pos < s.length && isTop(pos) && /\s/.test(s[pos]!)) pos++;
    if (pos >= s.length || !isTop(pos)) break;
    ASSIGNMENT_NAME_RE.lastIndex = pos;
    const nameMatch = ASSIGNMENT_NAME_RE.exec(s);
    if (!nameMatch) break;
    const name = nameMatch[0]!.slice(0, -1); // strip the trailing "="
    const eqEnd = pos + nameMatch[0]!.length;
    let vEnd = eqEnd;
    while (vEnd < s.length && !(isTop(vEnd) && /\s/.test(s[vEnd]!))) vEnd++;
    const value = s.slice(eqEnd, vEnd);
    // Fix round 1, Finding B / Ruling P2-C: a dangerous NAME is un-strippable on allow regardless
    // of its value's syntax; stop BEFORE this assignment either way, leaving it and everything
    // after it intact (denyAsk is unaffected -- it never reaches this branch at all).
    if (direction !== "denyAsk" && (DANGEROUS_ASSIGNMENT_NAMES.has(name) || !isSafeAssignmentValue(value))) break;
    pos = vEnd;
  }
  return pos;
}

/**
 * What `stripWrappers` found. `inner` is the command left once wrappers and assignments are looked
 * through; `carried` holds the file-writing redirections that sat inside the part looked through.
 * Words are consumed whitespace-delimited, so a redirection GLUED to a wrapper's word (`timeout
 * x>.git/config`, `nice -n5>f`, `A=1>f ls`) is consumed with that word -- bash still performs it, so
 * it is carried over onto the end of the result instead of being lost.
 */
interface WrapperStrip {
  inner: string;
  carried: string[];
  /**
   * An ALLOW-direction read where a word names a wrapper only in the broad reading (`"\timeout"`):
   * bash runs a different program than the one an allow rule's text would suggest, so no allow rule
   * may match it.
   */
  ambiguousForAllow: boolean;
}

function stripWrappersDetailed(rawCmd: string, direction: "allow" | "denyAsk"): WrapperStrip {
  const cmd = joinLineContinuations(rawCmd);
  // P2 fix-wave item 2: ONE scan for this whole call, threaded through every helper below via a
  // plain integer offset into this SAME, unchanging `cmd` string -- never a re-scan of a
  // progressively-sliced substring (see leadingWordAt/stripLeadingAssignmentsAt's own headers for
  // the O(n^2) shape this closes).
  const info = scanShellLike(cmd);
  const finish = (pos: number, ambiguousForAllow = false): WrapperStrip => {
    const carried = info.ok ? redirectWriteSpans(cmd, info).filter((span) => span.start < pos).map((span) => cmd.slice(span.start, span.end)) : [];
    return { inner: cmd.slice(pos), carried, ambiguousForAllow };
  };
  let pos = 0;
  for (;;) {
    pos = stripLeadingAssignmentsAt(cmd, info, pos, direction);
    const { word: rawWord, end: afterWordEnd } = leadingWordAt(cmd, info, pos);
    if (rawWord === undefined) return finish(pos);
    // After quote removal, as bash sees it: `'timeout' 5 rm -rf ~` runs `rm` under `timeout`. An
    // allow only looks through what bash itself would run as the wrapper; a deny/ask also looks
    // through a word that names one in the broad reading (`"\timeout" 5 rm …`), never less than before.
    const isWrapperName = (r: string): boolean => r === XARGS || FIXED_WRAPPERS.has(r);
    const readings = shellWordReadings(rawWord);
    const exact = readings[0]!;
    if (direction === "allow" && !isWrapperName(exact) && readings.some(isWrapperName)) return finish(pos, true);
    const word = direction === "allow" ? exact : (readings.find(isWrapperName) ?? exact);

    if (word === XARGS) {
      const { word: next } = leadingWordAt(cmd, info, afterWordEnd);
      if (next !== undefined && next.startsWith("-")) return finish(pos); // not flag-free -- stop stripping
      pos = afterWordEnd;
      continue;
    }

    if (!FIXED_WRAPPERS.has(word)) return finish(pos);

    let remainderPos = afterWordEnd;
    for (;;) {
      const { word: flag, end: afterFlagEnd } = leadingWordAt(cmd, info, remainderPos);
      if (flag === undefined || !flag.startsWith("-")) break;
      remainderPos = afterFlagEnd;
    }
    if (WRAPPERS_WITH_POSITIONAL_ARG.has(word)) {
      const { word: posArg, end: afterPosEnd } = leadingWordAt(cmd, info, remainderPos);
      if (posArg !== undefined && !posArg.startsWith("-")) remainderPos = afterPosEnd;
    }
    pos = remainderPos;
  }
}

/** The command once leading assignments and wrappers are looked through, carried-over redirections appended. */
const joinedStrip = (strip: WrapperStrip): string => [strip.inner, ...strip.carried].filter((part) => part !== "").join(" ");

/**
 * The command a wrapper-prefixed (sub)command really runs: leading assignments and the fixed wrappers
 * (`timeout 5`, `nice -n 5`, flag-free `xargs`, ...) looked through, per `direction` (see the module
 * header). Any file-writing redirection that was part of the looked-through words is appended, so
 * every redirect scan of the result still sees it. For an allow whose wrapper word is spelled so that
 * only the broad reading names a wrapper (`"\timeout" …`), the command is returned as written.
 */
function stripWrappers(rawCmd: string, direction: "allow" | "denyAsk"): string {
  const strip = stripWrappersDetailed(rawCmd, direction);
  return strip.ambiguousForAllow ? joinLineContinuations(rawCmd).trimStart() : joinedStrip(strip);
}

// ---------------------------------------------------------------------------------------------
// extractRedirectTargets
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Shell words: bash's quote removal, the ONE implementation every path is derived through
// ---------------------------------------------------------------------------------------------
//
// bash removes EVERY quote and backslash inside a word, not a pair around the whole of it: `'.git'/config`,
// `.g"i"t/config`, `.\git/config`, `''.git/config` and `.git''/config` all name `.git/config`. A path
// derived any other way can name a different file than the one bash writes, and the protected floor,
// the deny rules and the working-directory check then judge the wrong file.

/** One word of a command: its text after quote removal, as written, and whether any of it was quoted. */
export interface ShellWord {
  word: string;
  raw: string;
  quoted: boolean;
}

const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Decodes the escape at `s[i]` (just after a backslash) inside `$'…'`; returns the text and the next index. */
function decodeAnsiCEscape(s: string, i: number): { text: string; next: number } {
  const ch = s[i];
  if (ch === undefined) return { text: "\\", next: i };
  const simple = ANSI_C_SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return { text: simple, next: i + 1 };
  const numeric = (pattern: RegExp, radix: number): { text: string; next: number } | undefined => {
    const m = pattern.exec(s.slice(i + 1));
    if (m === null || m[0].length === 0) return undefined;
    return { text: String.fromCodePoint(Number.parseInt(m[0], radix) % 0x110000), next: i + 1 + m[0].length };
  };
  if (ch === "x") return numeric(/^[0-9a-fA-F]{1,2}/, 16) ?? { text: "\\x", next: i + 1 };
  if (ch === "u") return numeric(/^[0-9a-fA-F]{1,4}/, 16) ?? { text: "\\u", next: i + 1 };
  if (ch === "U") return numeric(/^[0-9a-fA-F]{1,8}/, 16) ?? { text: "\\U", next: i + 1 };
  if (/[0-7]/.test(ch)) {
    const m = /^[0-7]{1,3}/.exec(s.slice(i))!;
    return { text: String.fromCharCode(Number.parseInt(m[0], 8) & 0xff), next: i + m[0].length };
  }
  if (ch === "c" && s[i + 1] !== undefined) return { text: String.fromCharCode(s.charCodeAt(i + 1) & 0x1f), next: i + 2 };
  return { text: `\\${ch}`, next: i + 1 };
}

/**
 * How a backslash inside double quotes is read.
 *
 * - `"bash"`: exactly as bash does. Inside `"…"` a backslash escapes only `$`, `` ` ``, `"`, `\` and a
 *   newline (backslash-newline is a line continuation: both characters vanish); before any other
 *   character the backslash is kept, so `"\-o"` is the word `\-o` and `"a\b"` is `a\b`.
 * - `"broad"`: the backslash is dropped before every character, so `"\-o"` reads `-o`. Not what bash
 *   runs, but a superset view for the permission layer's deny rules and write floors: a spelling
 *   like `"\.git/config"` or `sort "\-o"` is still matched against `.git/config` / `sort -o`.
 *
 * Outside quotes a backslash escapes the next character (backslash-newline vanishes) and inside single
 * quotes nothing is special, in both readings.
 */
type QuoteReading = "bash" | "broad";

/** Inside double quotes, the characters a backslash escapes in bash. */
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/**
 * bash's quote removal (and, with `split`, its word splitting at unquoted blanks) over one command's
 * text: single quotes, double quotes (a backslash inside them per `reading` -- see `QuoteReading`;
 * the default `"broad"` is what the permission layer's deny rules and write floors read), backslash
 * escapes, ANSI-C `$'…'` (decoded) and locale `$"…"` (as double quotes). Expansions are left as
 * written. An unterminated quote runs to the end.
 */
function shellWords(s: string, split = true, reading: QuoteReading = "broad"): ShellWord[] {
  const words: ShellWord[] = [];
  let cur = "";
  let start = -1;
  let quoted = false;
  let quote: '"' | "'" | "$'" | null = null;
  const end = (i: number): void => {
    if (start !== -1) words.push({ word: cur, raw: s.slice(start, i), quoted });
    cur = "";
    start = -1;
    quoted = false;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      i++;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") {
        quote = null;
        i++;
      } else if (ch === "\\") {
        const decoded = decodeAnsiCEscape(s, i + 1);
        cur += decoded.text;
        i = decoded.next;
      } else {
        cur += ch;
        i++;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1]!;
        if (reading === "bash" && !DOUBLE_QUOTE_ESCAPABLE.has(next)) cur += ch + next;
        else if (next !== "\n") cur += next;
        i++;
      } else cur += ch;
      i++;
      continue;
    }
    if (split && /\s/.test(ch)) {
      end(i);
      i++;
      continue;
    }
    if (start === -1) start = i;
    if (ch === "\\") {
      quoted = true;
      if (i + 1 < s.length && s[i + 1] !== "\n") cur += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) {
      quote = s[i + 1] === "'" ? "$'" : '"';
      quoted = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  end(s.length);
  return words;
}

/** `word` after bash's quote removal, exactly as bash reads it, as ONE word (blanks inside it are kept). */
function dequoteShellWord(word: string): string {
  return shellWords(word, false, "bash")[0]?.word ?? "";
}

/**
 * `word` in bash's reading and, when it differs, the broad one (see `QuoteReading`) -- for deny-side
 * checks and write floors, which must judge every file the word could be taken to name.
 */
function shellWordReadings(word: string): string[] {
  const exact = dequoteShellWord(word);
  const broad = shellWords(word, false, "broad")[0]?.word ?? "";
  return broad === exact ? [exact] : [exact, broad];
}

/** One file-writing redirection: the target word as written (`raw`) and after bash's quote removal. */
interface RedirectWrite {
  raw: string;
  target: string;
}

const REDIRECT_WORD_STOP = /[\s;&|<>()]/;

/** The word starting at `start` (after blanks), ended by top-level whitespace or an operator char. */
function redirectWordAt(s: string, info: ScanInfo, start: number): { word: string | undefined; end: number } {
  let i = start;
  while (i < s.length && info.topLevel[i] === true && (s[i] === " " || s[i] === "\t")) i++;
  const wordStart = i;
  while (i < s.length && !(info.topLevel[i] === true && REDIRECT_WORD_STOP.test(s[i]!))) i++;
  return { word: i > wordStart ? s.slice(wordStart, i) : undefined, end: i };
}

/**
 * Every FILE-writing redirection at the top level of one (sub)command -- the operators bash writes a
 * file through: `>`, `>>`, `>|` (noclobber override), `&>`, `&>>`, `<>` (read-write open), any of them
 * fd-prefixed (`2>`), and `>&word` / `N>&word` whose word is NOT a descriptor (`>&file` is the old
 * spelling of `&>file`; `2>&1`, `>&2`, `>&-` stay descriptor copies). `<<`/`<<<` feed input and
 * `>(`/`<(` are process substitutions -- neither is a file target (the permission layer asks for a
 * process substitution separately). Bash runs without history expansion here, so a target that
 * begins with `!` is ALSO read with the `!` removed (zsh's `>!` clobber), which only adds a path.
 *
 * An unparseable command yields `[]` here; every security caller asks for such a command on its own
 * (`shellWriteConstraint`), because a scan it could not complete proves nothing about its writes.
 */
function extractRedirectWrites(rawCommand: string): RedirectWrite[] {
  const command = joinLineContinuations(rawCommand);
  const info = scanShellLike(command);
  if (!info.ok) return [];
  const writes: RedirectWrite[] = [];
  // bash's own reading of the target, plus the broad one when it differs (`"\.git/config"` names
  // `\.git/config` to bash; the floors also judge `.git/config`) -- each extra reading only adds a path.
  const pushReadings = (raw: string): void => {
    for (const target of shellWordReadings(raw)) writes.push({ raw, target });
  };
  for (const { target: raw } of redirectWriteSpans(command, info)) {
    pushReadings(raw);
    if (raw.length > 1 && raw.startsWith("!")) pushReadings(raw.slice(1));
  }
  return writes;
}

/** One file-writing redirection in a command: where it starts (its descriptor digits included), where it ends, and its target as written. */
interface RedirectWriteSpan {
  start: number;
  end: number;
  target: string;
}

/** The file-writing redirections of `command` (see `extractRedirectWrites`), with their positions. */
function redirectWriteSpans(command: string, info: ScanInfo): RedirectWriteSpan[] {
  const { topLevel } = info;
  const spans: RedirectWriteSpan[] = [];
  const push = (start: number, target: string, end: number): void => {
    spans.push({ start, end, target });
  };
  let i = 0;
  while (i < command.length) {
    if (!topLevel[i]) {
      i++;
      continue;
    }
    if (command.startsWith("<<", i)) {
      // here-doc / here-string -- input, never a file write (WS-07 §3).
      i += command[i + 2] === "<" ? 3 : 2;
      continue;
    }
    // An fd prefix (`2>`, `10>>`) is a digit run directly before the operator.
    let k = i;
    while (k < command.length && topLevel[k] && /[0-9]/.test(command[k]!)) k++;
    let opEnd = -1;
    let descriptorCopy = false;
    if (command[i] === "&" && command[i + 1] === ">") {
      opEnd = command[i + 2] === ">" ? i + 3 : i + 2; // &>> / &>
    } else if (command[k] === "<" && command[k + 1] === ">") {
      opEnd = k + 2; // <> opens for writing
    } else if (command[k] === ">") {
      const next = command[k + 1];
      if (next === "(") {
        i = k + 1; // `>(`: a process substitution, not a file
        continue;
      }
      if (next === ">") opEnd = k + 2;
      else if (next === "|") opEnd = k + 2;
      else if (next === "&") {
        opEnd = k + 2;
        descriptorCopy = true;
      } else opEnd = k + 1;
    } else {
      i = k > i ? k : i + 1;
      continue;
    }

    const { word, end } = redirectWordAt(command, info, opEnd);
    if (word === undefined) {
      i = opEnd;
      continue;
    }
    if (!(descriptorCopy && /^(?:[0-9]+|-)$/.test(dequoteShellWord(word)))) push(i, word, end);
    i = end;
  }
  return spans;
}

/** `extractRedirectWrites`, target paths only (quotes removed). */
function extractRedirectTargets(command: string): string[] {
  return extractRedirectWrites(command).map((w) => w.target);
}

// =====================================================================================================
// From shell-structure.ts
// =====================================================================================================
 // `$'…'`: single-quoted, but `\'` does not end it

/** Is the `'` at `i` the opening of an ANSI-C `$'…'` quote (its `$` unescaped)? */
function opensAnsiQuote(s: string, i: number): boolean {
  if (s[i - 1] !== "$") return false;
  let backslashes = 0;
  for (let j = i - 2; j >= 0 && s[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 0;
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text and nested substitutions; -1 if none. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | "$'" | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" && s[i + 1] === "(") {
        const close = matchingParen(s, i + 1);
        if (close === -1) return -1;
        i = close;
      }
      continue;
    }
    if (quote === "`") {
      if (ch === "`") quote = null;
      continue;
    }
    if (ch === "'") {
      quote = opensAnsiQuote(s, i) ? "$'" : "'";
      continue;
    }
    if (ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the backtick closing the one at `open`; -1 if none. */
function closingBacktick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return -1;
}

/** Index of the `'` closing a single (or, `ansi`, ANSI-C) quote opened at `open`; -1 if none. */
function closingSingleQuote(s: string, open: number, ansi: boolean): number {
  for (let i = open + 1; i < s.length; i++) {
    if (ansi && s[i] === "\\") i++;
    else if (s[i] === "'") return i;
  }
  return -1;
}

/**
 * The bodies of every command-running construct directly inside `text`: `$(…)`, backticks, `(…)`
 * subshells, and `<(…)` / `>(…)` process substitutions (bash, so `=(…)` is an array, not zsh's
 * process substitution). `doubleQuoted` scans text bash treats
 * like the inside of double quotes (an unquoted here-document body), where only `$(…)` and backticks
 * run. Null when a construct is not closed.
 */
function substitutionBodies(text: string, doubleQuoted = false): string[] | null {
  const bodies: string[] = [];
  let inDouble = doubleQuoted;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!inDouble && ch === "'") {
      const close = closingSingleQuote(text, i, opensAnsiQuote(text, i));
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === '"' && !doubleQuoted) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (ch === "`") {
      const close = closingBacktick(text, i);
      if (close === -1) return null;
      bodies.push(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const substitution = ch === "$" && text[i + 1] === "(";
    const processSubstitution = !inDouble && (ch === "<" || ch === ">") && text[i + 1] === "(";
    if (substitution || processSubstitution || (!inDouble && ch === "(")) {
      const open = ch === "(" ? i : i + 1;
      const close = matchingParen(text, open);
      if (close === -1) return null;
      // `name=(a b)` is a bash ARRAY assignment, not a subshell: its words run nothing.
      if (!(ch === "(" && text[i - 1] === "=")) bodies.push(text.slice(open + 1, close));
      i = close + 1;
      continue;
    }
    i++;
  }
  return inDouble && !doubleQuoted ? null : bodies;
}