// The shell-command reading primitives the sandbox-escape floor and the protected-write check use
// (`hooks.ts`), shared with the edited-files index's Bash extractor (`sessions/bash-edits.ts`). Moved
// here VERBATIM from `hooks.ts` (2026-10-02) so a module outside the hook layer can import them without
// importing the hooks; no imports of its own on purpose.

/** Round 5: the shells whose `-c` string is a command. */
export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Words a command may be prefixed with and still be that command. */
export const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["sudo", "env", "exec", "command", "nohup", "time", "nice"]);

/** Round 5: one raw segment's words as the shell hands them to the program — split on unquoted whitespace,
 *  quotes removed, a backslash escaping the next character. */
export function shellWords(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | "\"" | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote === "'") { if (ch === "'") quote = undefined; else cur += ch; continue; }
    if (quote === "\"") {
      if (ch === "\"") quote = undefined;
      else if (ch === "\\" && i + 1 < raw.length && /["\\$`]/.test(raw[i + 1]!)) cur += raw[++i];
      else cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) { cur += raw[++i]; started = true; continue; }
    if (ch === "'" || ch === "\"") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) out.push(cur); cur = ""; started = false; continue; }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Round 5: the command strings a command line runs — a shell's `-c` string (`-c` alone or in a cluster such
 *  as `-lc`), `eval`'s arguments joined, and the same for a command `find -exec`/`-execdir`/`-ok`/`-okdir`
 *  runs. Words as `shellWords` gives them. */
export function nestedCommandStrings(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_PREFIXES.has(baseName(words[i]!)))) i += 1;
  const verb = baseName(words[i] ?? "");
  const rest = words.slice(i + 1);
  if (SHELLS.has(verb)) {
    const at = rest.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    return at >= 0 && rest[at + 1] !== undefined ? [rest[at + 1]!] : [];
  }
  if (verb === "eval") return rest.length === 0 ? [] : [rest.join(" ")];
  if (verb === "find") {
    const out: string[] = [];
    for (let j = 0; j < rest.length; j += 1) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[j]!)) continue;
      const sub: string[] = [];
      for (j += 1; j < rest.length && rest[j] !== "+" && rest[j] !== ";"; j += 1) sub.push(rest[j]!);
      out.push(...nestedCommandStrings(sub));
    }
    return out;
  }
  return [];
}

export const baseName = (w: string): string => w.slice(w.lastIndexOf("/") + 1).toLowerCase();


/** Round 3, minor 10: a command's shell segments — split on `;`, `&&`, `||`, `|`, `|&`, a background `&` and
 *  newlines, on the RAW text: a separator inside single or double quotes (or escaped) is text. Round 4: a
 *  command substitution's opening and closing (`$(`/`)`, a backtick) are boundaries too. */
export function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  // Round 4, minor 2: a COMMAND SUBSTITUTION (`$(…)`, `` `…` ``) is a segment of its own — outside quotes
  // and inside double quotes alike — so a `cd` inside one is seen and carried to what follows it.
  const stack: Array<"sq" | "dq" | "sub" | "paren" | "bt"> = [];
  const cut = (): void => { out.push(cur); cur = ""; };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const ctx = stack[stack.length - 1];
    if (ctx === "sq") { cur += ch; if (ch === "'") stack.pop(); continue; }
    if (ch === "\\" && i + 1 < command.length) { cur += ch + command[++i]; continue; }
    if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") { cut(); stack.push("sub"); i += 1; continue; }
    if (ch === "`") { cut(); if (ctx === "bt") stack.pop(); else stack.push("bt"); continue; }
    if (ctx === "dq") { cur += ch; if (ch === "\"") stack.pop(); continue; }
    if (ch === "'") { stack.push("sq"); cur += ch; continue; }
    if (ch === "\"") { stack.push("dq"); cur += ch; continue; }
    if (ch === "(" && (ctx === "sub" || ctx === "paren")) { stack.push("paren"); cur += ch; continue; }
    if (ch === ")" && ctx === "sub") { stack.pop(); cut(); continue; }
    if (ch === ")" && ctx === "paren") { stack.pop(); cur += ch; continue; }
    if (ch === "\n" || ch === ";") { cut(); continue; }
    // WS-24 fix round 2 (minor 1): `>|` is the clobber REDIRECT, not a pipe.
    if (ch === "|" && command[i - 1] === ">") { cur += ch; continue; }
    if (ch === "|") { if (command[i + 1] === "|" || command[i + 1] === "&") i += 1; cut(); continue; }
    if (ch === "&") {
      if (command[i + 1] === "&") { i += 1; cut(); continue; }
      if (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">") { cur += ch; continue; } // a redirect
      cut();
      continue;
    }
    cur += ch;
  }
  cut();
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A redirect or separator character INSIDE quotes is text: it becomes a space before the quotes are
 *  stripped, so `echo 'a > .winter/rules/x'` names no write target (a quoted PATH is kept as it is). */
export function quotedOperatorsAsText(raw: string): string {
  let out = "";
  let quote: "'" | "\"" | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote === undefined) {
      if (ch === "\\" && i + 1 < raw.length) { out += ch + raw[++i]; continue; }
      if (ch === "'" || ch === "\"") quote = ch;
      out += ch;
      continue;
    }
    if (ch === quote) { quote = undefined; out += ch; continue; }
    out += /[<>|;&()]/.test(ch) ? " " : ch;
  }
  return out;
}

/** WS-24 fix round 2 (minor): the FILES an in-place `sed`/`perl` edit names — every operand except its
 *  script: the word after `-e`/`--expression`/`-f` (a script, or a script file that is read), and, for `sed`
 *  with no `-e`/`-f`, the first operand (`sed -i '' s/a/b/ f` — the empty suffix vanishes with its quotes,
 *  so `s/a/b/` is that first operand). Without this a script like `s/a/b/` was judged as a path, and walked
 *  through a link named `s`. */
export function inPlaceFiles(verb: string, rest: readonly string[]): string[] {
  const out: string[] = [];
  let hasScriptFlag = false;
  for (let j = 0; j < rest.length; j += 1) {
    const w = rest[j]!;
    if (w === "-e" || w === "--expression" || w === "-f" || w === "--file") { hasScriptFlag = true; j += 1; continue; }
    if (/^-[a-z]*e$/.test(w) && verb === "perl") { hasScriptFlag = true; j += 1; continue; } // `-pie`, `-pe`
    if (w.startsWith("-")) continue;
    out.push(w);
  }
  return verb === "sed" && !hasScriptFlag ? out.slice(1) : out;
}
