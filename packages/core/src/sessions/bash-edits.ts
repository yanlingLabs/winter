// The files a `Bash` call WROTE, read statically off its command text — the edited-files index's second
// source beside `tool_result.fileDiff` (ListSessions' `query`, `store.ts`'s `session_files`).
//
// It reuses the escape floor's shell reading (`runtime-sdk/shell-words.ts`: segments split on the raw
// text, quoted operators kept as text, `bash -c`/`eval`/`find -exec` strings read as commands of their
// own) but NOT its target rules: the floor is deliberately over-inclusive (fail-closed — every word after
// `git` or `curl` counts), while an index wants what was actually written. So the per-verb rules below are
// narrower, the text keeps its CASE (the floor folds it), and nothing a command only READS is recorded.
//
// What counts as written (a deliberate list, not "anything that might write"):
//   * the target of an output redirect — `>`, `>>`, `>|`, `&>`, `&>>` (never an fd dup like `2>&1`, never
//     `/dev/*`);
//   * `tee`'s files; `touch`, `mkdir`, `truncate`, `chmod` (after its mode);
//   * `rm`, `rmdir`, `unlink`, `shred` — DELETING a file is a change the user may search for ("the session
//     that removed the old config"), so a removal is recorded like an edit;
//   * `cp`/`install`/`ln`/`rsync`/`ditto`: the DESTINATION only (a source is read) — `dest/<source name>`
//     when the destination is a directory (`-t`, a trailing `/`, several sources, or one that exists);
//   * `mv` and `git mv`: the source AND the destination (the old name disappears — a rename is searched by
//     either); `git rm` (not `--cached`), `git restore`, `git checkout -- <paths>`;
//   * in-place editors: `sed -i`, `perl -i`, gawk's `-i inplace`; `ed`/`ex`, and `vi`/`vim`/`nvim` run
//     non-interactively (`-e`, `-es`, `-E`, `-c`, `+cmd`, `--headless`); `patch <file>` / `-o <file>`;
//     `dd of=`; `curl -o`/`--output`, `wget -O`/`--output-document`;
//   * formatters that rewrite the files they are given: `prettier --write`, `eslint --fix`, `black`,
//     `ruff format`/`ruff check --fix`, `gofmt -w`, `goimports -w`, `rustfmt`, `clang-format -i`,
//     `swiftformat`, `swift-format -i` — only operands that look like a path (a `/` or an extension).
//
// Paths resolve against the session's cwd, then every `cd`/`pushd` EARLIER IN THE SAME COMMAND (and
// `git -C <dir>` for that git command); `~`, `$HOME`/`${HOME}` and `$PWD`/`${PWD}` expand. Heredoc bodies
// are text, never commands.
//
// THE LIMITS, stated rather than guessed at: a static read of the command text, so a path the command
// ASSEMBLES at run time (`$(…)`, its own variables, a glob, `xargs`, a script it writes and then runs, an
// interpreter one-liner — `python3 -c "open('x','w')"`) is out of reach, as is a write whose path is not in
// the command at all (`git checkout <branch>`, `git apply`, `npm install`, `make`, `tar -x`). A `cd` made by
// an EARLIER Bash call is not carried (the runtime keeps one, but the log records no incarnation boundary,
// so a replay could not tell when it reset) — such a relative path resolves against the session's cwd.

import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { COMMAND_PREFIXES, baseName, inPlaceFiles, nestedCommandStrings, quotedOperatorsAsText, shellSegments, shellWords } from "../runtime-sdk/shell-words";

/** The longest path recorded (the same cap as `FileDiffSummary.path`). */
export const BASH_EDIT_PATH_MAX = 1024;
/** Nested `bash -c` / `eval` levels read, like the floor's. */
const MAX_DEPTH = 4;
/** Package runners a formatter may be invoked through (`npx prettier --write x`). */
const RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

/**
 * The absolute paths `command` writes, in order of appearance, deduplicated. `cwd` is where the command
 * starts (the session's cwd); without one, only absolute and `~`/`$HOME` targets are returned. Never throws.
 */
export function bashEditedPaths(command: string, cwd: string | undefined): string[] {
  const out = new Set<string>();
  try { walk(stripHeredocBodies(command), cwd, 0, out); } catch { /* a command this cannot read records nothing */ }
  return [...out];
}

function walk(command: string, startCwd: string | undefined, depth: number, out: Set<string>): void {
  let cwd = startCwd;
  for (const raw of shellSegments(command)) {
    if (depth < MAX_DEPTH) {
      // A shell's `-c` string, `eval`'s argument, `find -exec`'s command — its own `cd`s stay inside it.
      for (const nested of nestedCommandStrings(shellWords(raw))) walk(nested, cwd, depth + 1, out);
    }
    const seg = quotedOperatorsAsText(raw).replace(/^[\s({]+/, "").replace(/[\s)}]+$/, "");
    if (seg.length === 0) continue;
    const { targets: redirects, rest } = splitRedirects(seg);
    for (const t of redirects) add(out, t, cwd);
    const words = shellWords(rest);
    let i = 0;
    // Assignments, prefixes (`sudo`, `env`, …) and package runners, and a runner's own flags (`npx -y`).
    while (i < words.length) {
      const w = words[i]!;
      const prefix = /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || COMMAND_PREFIXES.has(baseName(w)) || RUNNERS.has(baseName(w));
      if (!prefix && !(w.startsWith("-") && i > 0 && RUNNERS.has(baseName(words[i - 1]!)))) break;
      i += 1;
    }
    const verb = baseName(words[i] ?? "");
    const args = words.slice(i + 1);
    if (verb === "cd" || verb === "pushd") { cwd = nextCwd(cwd, args.find((w) => !w.startsWith("-") || w === "-")); continue; }
    if (verb === "popd") { cwd = undefined; continue; }
    for (const target of verbTargets(verb, args, cwd)) add(out, target.path, target.cwd ?? cwd);
  }
}

/** Where a `cd` lands: its argument against the cwd so far; `cd` alone is home; `cd -` is unknown. */
function nextCwd(cwd: string | undefined, arg: string | undefined): string | undefined {
  if (arg === undefined || arg === "") return homedir();
  if (arg === "-") return undefined;
  const expanded = expand(arg, cwd);
  if (expanded === undefined) return undefined;
  if (isAbsolute(expanded)) return resolve(expanded);
  return cwd === undefined ? undefined : resolve(cwd, expanded);
}

// ── redirects ─────────────────────────────────────────────────────────────────────────────────────

/** A word as a redirect target may spell it: unquoted characters and whole quoted runs. */
const TARGET_WORD = String.raw`(?:[^\s<>&|;()"']|"[^"]*"|'[^']*')+`;
const OUTPUT_REDIRECT = new RegExp(String.raw`(\d*|&)(>{1,2})(\|?)(&?)\s*(${TARGET_WORD})?`, "g");
const INPUT_REDIRECT = new RegExp(String.raw`\d*<{1,3}-?\s*(?:${TARGET_WORD})?`, "g");

/** The segment's output-redirect targets, unquoted, and the segment with every redirect removed. */
function splitRedirects(seg: string): { targets: string[]; rest: string } {
  const targets: string[] = [];
  const rest = seg.replace(OUTPUT_REDIRECT, (_m, _fd: string, _op: string, _clobber: string, dup: string, word: string | undefined) => {
    if (word === undefined) return " ";
    const unquoted = shellWords(word)[0] ?? "";
    // `>&2`, `2>&1`, `>&-`: an fd duplicate, not a file.
    if (dup === "&" && /^(\d+|-)$/.test(unquoted)) return " ";
    if (unquoted.length > 0) targets.push(unquoted);
    return " ";
  }).replace(INPUT_REDIRECT, " ");
  return { targets, rest };
}

/** Heredoc BODIES are data for the command, never commands of their own (`cat > f <<EOF … rm x … EOF`
 *  must not record `x`): every line after a `<<WORD` (or `<<-WORD`, `<<'WORD'`, `<<"WORD"`) up to its
 *  terminator is dropped. A here-string (`<<<`) has no body. */
export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  const pending: Array<{ word: string; tabs: boolean }> = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const head = pending[0]!;
      const text = head.tabs ? line.replace(/^\t+/, "") : line;
      if (text === head.word) pending.shift();
      continue;
    }
    kept.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z0-9_.-]+)\2/g)) pending.push({ word: m[3]!, tabs: m[1] === "-" });
  }
  return kept.join("\n");
}

// ── per-verb rules ────────────────────────────────────────────────────────────────────────────────

interface Target { path: string; cwd?: string }

/** Operands: every word that is not an option, minus the values of `valued` options; everything after `--`. */
function operands(args: readonly string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  let ended = false;
  for (let j = 0; j < args.length; j += 1) {
    const w = args[j]!;
    if (ended) { out.push(w); continue; }
    if (w === "--") { ended = true; continue; }
    if (w.startsWith("-") && w.length > 1) { if (valued.has(w)) j += 1; continue; }
    out.push(w);
  }
  return out;
}

const plain = (paths: readonly string[]): Target[] => paths.map((path) => ({ path }));

/** A formatter's operand that names a file or directory (a `/` or an extension), not an option's value. */
const looksLikePath = (w: string): boolean => w !== "." && w !== "./" && (w.includes("/") || /\.[A-Za-z0-9]+$/.test(w));

function verbTargets(verb: string, args: readonly string[], cwd: string | undefined): Target[] {
  switch (verb) {
    case "tee":
      return plain(operands(args).filter((w) => w !== "-"));
    case "touch":
      return plain(operands(args, new Set(["-r", "-t", "-d", "--reference", "--date"])));
    case "mkdir":
      return plain(operands(args, new Set(["-m", "--mode"])));
    case "rm": case "rmdir": case "unlink": case "shred":
      return plain(operands(args, new Set(["-n", "--iterations", "-s", "--size"])));
    case "truncate":
      return plain(operands(args, new Set(["-s", "--size", "-r", "--reference"])));
    case "chmod":
      return plain(operands(args, new Set(["--reference"])).slice(1));
    case "cp": case "install": case "ln": case "rsync": case "ditto":
      if (verb === "install" && args.some((w) => w === "-d" || w === "--directory")) return plain(operands(args, new Set(["-m", "-o", "-g", "--mode", "--owner", "--group"])));
      return destinationTargets(args, cwd, verb === "rsync" ? new Set(["-e", "--rsh", "--exclude", "--include", "--filter", "-f"]) : new Set(["-S", "--suffix", "-m", "-o", "-g", "--mode", "--owner", "--group"]), false);
    case "mv":
      return destinationTargets(args, cwd, new Set(["-S", "--suffix"]), true);
    case "git":
      return gitTargets(args, cwd);
    case "sed": case "perl": {
      const words = args.filter((w) => w.length > 0);
      const at = words.findIndex((w) => /^(?:-[A-Za-z]*i\S*|--in-place\S*)$/.test(w));
      if (at < 0) return [];
      // BSD sed's `-i ''` vanished above (an empty word); its `-i .bak` takes the next word as the suffix.
      const rest = verb === "sed" && words[at] === "-i" && /^\.[^/]*$/.test(words[at + 1] ?? "") ? [...words.slice(0, at + 1), ...words.slice(at + 2)] : words;
      return plain(inPlaceFiles(verb, rest));
    }
    case "awk": case "gawk": {
      const inplace = args.some((w, j) => w === "-iinplace" || w === "--include=inplace" || ((w === "-i" || w === "--include") && args[j + 1] === "inplace"));
      if (!inplace) return [];
      const ops = operands(args, new Set(["-i", "--include", "-v", "--assign", "-F", "--field-separator", "-f", "--file"]));
      // The program is the first operand unless it came from `-f <file>` (read, never written).
      const hasProgramFile = args.some((w) => w === "-f" || w === "--file");
      return plain((hasProgramFile ? ops : ops.slice(1)).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)));
    }
    case "dd":
      return plain(args.filter((w) => w.startsWith("of=")).map((w) => w.slice("of=".length)));
    case "curl": {
      const out: string[] = [];
      for (let j = 0; j < args.length; j += 1) {
        const w = args[j]!;
        if ((w === "-o" || w === "--output") && args[j + 1] !== undefined) out.push(args[j + 1]!);
        else if (w.startsWith("--output=")) out.push(w.slice("--output=".length));
        else if (/^-o\S+$/.test(w)) out.push(w.slice(2));
      }
      return plain(out.filter((w) => w !== "-"));
    }
    case "wget": {
      const out: string[] = [];
      for (let j = 0; j < args.length; j += 1) {
        const w = args[j]!;
        if ((w === "-O" || w === "--output-document") && args[j + 1] !== undefined) out.push(args[j + 1]!);
        else if (w.startsWith("--output-document=")) out.push(w.slice("--output-document=".length));
        else if (/^-O\S+$/.test(w)) out.push(w.slice(2));
      }
      return plain(out.filter((w) => w !== "-"));
    }
    case "patch": {
      const out = args.findIndex((w) => w === "-o" || w === "--output");
      if (out >= 0 && args[out + 1] !== undefined) return plain([args[out + 1]!]);
      const first = operands(args, new Set(["-i", "--input", "-d", "--directory", "-D", "-F", "-p", "-r", "-B", "-V", "-Y", "-z", "--strip"]))[0];
      return first === undefined ? [] : plain([first]);
    }
    case "ed":
      return plain(operands(args, new Set(["-p", "--prompt"])).slice(0, 1));
    case "ex": case "vi": case "vim": case "nvim": {
      const scripted = verb === "ex" || args.some((w) => /^-(?:e|es|E|Es|c|s)$/.test(w) || w.startsWith("+") || w === "--headless");
      if (!scripted) return [];
      return plain(operands(args, new Set(["-c", "--cmd", "-S", "-u", "-U", "-i", "-T", "-W", "-w", "-s"])).filter((w) => !w.startsWith("+")));
    }
    default:
      return formatterTargets(verb, args);
  }
}

/** `cp`/`mv`-shaped: the destination (`-t DIR`, `--target-directory`, else the last operand), as
 *  `dest/<source name>` per source when it is a directory; with `withSources`, every source too. */
function destinationTargets(args: readonly string[], cwd: string | undefined, valued: ReadonlySet<string>, withSources: boolean): Target[] {
  let targetDir: string | undefined;
  const rest: string[] = [];
  for (let j = 0; j < args.length; j += 1) {
    const w = args[j]!;
    if ((w === "-t" || w === "--target-directory") && args[j + 1] !== undefined) { targetDir = args[j + 1]; j += 1; continue; }
    if (w.startsWith("--target-directory=")) { targetDir = w.slice("--target-directory=".length); continue; }
    rest.push(w);
  }
  const ops = operands(rest, valued).filter((w) => !/^[^/]*:/.test(w) || w.startsWith("/"));   // never an rsync `host:path`
  const sources = targetDir !== undefined ? ops : ops.slice(0, -1);
  const dest = targetDir ?? (ops.length >= 2 ? ops[ops.length - 1] : undefined);
  if (dest === undefined) return [];
  const intoDir = targetDir !== undefined || dest.endsWith("/") || sources.length > 1 || isDirectory(dest, cwd);
  const out: Target[] = intoDir ? sources.map((s) => ({ path: join(dest, basename(s.replace(/\/+$/, ""))) })) : [{ path: dest }];
  if (withSources) out.push(...plain(sources));
  return out;
}

function isDirectory(path: string, cwd: string | undefined): boolean {
  const abs = expand(path, cwd);
  if (abs === undefined) return false;
  const full = isAbsolute(abs) ? abs : cwd === undefined ? undefined : resolve(cwd, abs);
  if (full === undefined) return false;
  try { return statSync(full).isDirectory(); } catch { return false; }
}

const GIT_VALUED_GLOBALS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function gitTargets(args: readonly string[], cwd: string | undefined): Target[] {
  let at = cwd;
  let j = 0;
  while (j < args.length && args[j]!.startsWith("-")) {
    const w = args[j]!;
    if (w === "-C" && args[j + 1] !== undefined) at = nextCwd(at, args[j + 1]);
    j += GIT_VALUED_GLOBALS.has(w) ? 2 : 1;
  }
  const sub = args[j];
  const rest = args.slice(j + 1);
  const withCwd = (ts: Target[]): Target[] => ts.map((t) => ({ ...t, cwd: at }));
  switch (sub) {
    case "mv":
      return withCwd(destinationTargets(rest, at, new Set(), true));
    case "rm":
      return rest.includes("--cached") ? [] : withCwd(plain(operands(rest)));
    case "restore":
      return rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W") ? [] : withCwd(plain(operands(rest, new Set(["-s", "--source"]))));
    case "checkout": {
      const dashes = rest.indexOf("--");
      return dashes < 0 ? [] : withCwd(plain(rest.slice(dashes + 1)));
    }
    default:
      return [];
  }
}

/** Formatters that rewrite the files they are given — only in their writing form. */
function formatterTargets(verb: string, args: readonly string[]): Target[] {
  const has = (...flags: string[]): boolean => args.some((w) => flags.includes(w));
  let writes = false;
  let ops = args;
  switch (verb) {
    case "prettier": writes = has("--write", "-w"); break;
    case "eslint": writes = has("--fix"); break;
    case "black": case "rustfmt": case "swiftformat": writes = !has("--check", "--diff"); break;
    case "ruff": writes = args[0] === "format" ? !has("--check", "--diff") : args[0] === "check" && has("--fix"); ops = args.slice(1); break;
    case "gofmt": case "goimports": writes = has("-w"); break;
    case "clang-format": writes = has("-i"); break;
    case "swift-format": writes = has("-i", "--in-place"); break;
    default: return [];
  }
  return writes ? plain(ops.filter((w) => !w.startsWith("-") && looksLikePath(w))) : [];
}

// ── resolving a target ────────────────────────────────────────────────────────────────────────────

/** `~`, `$HOME`/`${HOME}` and `$PWD`/`${PWD}` at the start expanded; `undefined` for anything built at run
 *  time (another variable, a command substitution) or a glob. */
function expand(word: string, cwd: string | undefined): string | undefined {
  let w = word;
  if (w === "~" || w.startsWith("~/")) w = homedir() + w.slice(1);
  else if (/^\$(?:\{HOME\}|HOME)(?=\/|$)/.test(w)) w = w.replace(/^\$(?:\{HOME\}|HOME)/, homedir());
  else if (/^\$(?:\{PWD\}|PWD)(?=\/|$)/.test(w)) { if (cwd === undefined) return undefined; w = w.replace(/^\$(?:\{PWD\}|PWD)/, cwd); }
  if (/[$`*?[\]{}]/.test(w) || w.startsWith("~")) return undefined;
  return w;
}

function add(out: Set<string>, word: string, cwd: string | undefined): void {
  if (word.length === 0 || word === "-") return;
  const w = expand(word, cwd);
  if (w === undefined) return;
  const abs = isAbsolute(w) ? resolve(w) : cwd === undefined ? undefined : resolve(cwd, w);
  if (abs === undefined || abs === "/" || abs.startsWith("/dev/") || abs === "/dev" || abs.length > BASH_EDIT_PATH_MAX) return;
  out.add(abs);
}

// ── pairing a call with its result ─────────────────────────────────────────────────────────────────

/** The names a shell call is logged under: the projector's host name, and the runtime's own. */
const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "Bash"]);

/** The command of a `tool_call` event, when it is a Bash call. */
export function bashCommandOf(e: { type: string; name?: string; argsJson?: string }): string | undefined {
  if (e.type !== "tool_call" || e.name === undefined || !BASH_TOOL_NAMES.has(e.name) || e.argsJson === undefined) return undefined;
  try {
    const args = JSON.parse(e.argsJson) as { command?: unknown };
    return typeof args.command === "string" ? args.command : undefined;
  } catch { return undefined; }
}

/**
 * Pairs each Bash `tool_call` with its `tool_result`: the call's paths are read when the call is seen
 * (against the cwd the caller passes) and RECORDED only when its result says it ran — `isError: false`.
 * The runtime reports a non-zero exit as an ordinary result (`[exit N]` in the text), so `grep x f > out`
 * that matched nothing still counts; a denied, interrupted or never-executed call is an error result and
 * records nothing. Bounded: a call whose result never comes is forgotten after `max` newer calls.
 */
export class BashEditPairer {
  private readonly pending = new Map<string, string[]>();
  constructor(private readonly max = 1024) {}

  /** Feed one event; returns the paths to record (empty for every event but a successful Bash result). */
  observe(key: string, e: { type: string; name?: string; argsJson?: string; isError?: boolean }, cwd: string | undefined): string[] {
    if (e.type === "tool_call") {
      const command = bashCommandOf(e);
      if (command === undefined) return [];
      const paths = bashEditedPaths(command, cwd);
      if (paths.length === 0) return [];
      this.pending.delete(key);
      this.pending.set(key, paths);
      while (this.pending.size > this.max) this.pending.delete(this.pending.keys().next().value!);
      return [];
    }
    if (e.type !== "tool_result") return [];
    const paths = this.pending.get(key);
    if (paths === undefined) return [];
    this.pending.delete(key);
    return e.isError === false ? paths : [];
  }
}
