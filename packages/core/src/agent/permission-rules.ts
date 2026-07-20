import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, type Stats, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

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
 *
 * Resilience: a project rules file that's malformed JSON, the wrong shape, or over 64KB is
 * ignored — the LAST good parse for that root is kept (empty if there never was one), and a
 * warning is logged via `console.error` at most once per root for this instance's lifetime (the
 * cache's mtime/size stamp is updated even on a failed parse, so an unchanged-but-still-bad file
 * is never re-parsed or re-logged on a later call). A rule string neither scope's list can parse
 * gets the same one-warning treatment, deduped by the raw string itself. `decision()` never
 * throws — every failure mode degrades to "ignore it", not an error thrown into the gate path.
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
// truth) rather than duplicated as a separate literal pattern.
const KNOWN_TOOLS = ["Bash", "Edit", "Computer", "Worktree"] as const;
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
    case "Bash": return "bash";
    case "Edit": return "edit";
    case "Computer": return "computer";
    case "Worktree": return "worktree";
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
 * whitespace-normalized). `ToolName` must be exactly one of Bash/Edit/Computer/Worktree
 * (case-sensitive) — anything else, an unterminated `(`, or an empty string returns `null` rather
 * than throwing; callers (the class below) treat `null` as "ignore this rule, warn once". An
 * empty value (`"Bash()"`, `"Bash(:*)"`) also returns `null` — a rule naming no command at all is
 * far more likely a typo than an intentional "match everything", and CC's own grammar has no such
 * wildcard-via-omission form either (bare `Bash` already covers "any bash call").
 */
export function parseRule(s: string): { tool: string; kind: "any" | "exact" | "prefix"; value?: string } | null {
  const m = RULE_GRAMMAR.exec(s);
  if (!m) return null;
  const tool = internalToolFor(m[1]!); // group 1 is mandatory in RULE_GRAMMAR — always set on a match
  const content = m[2];
  if (content === undefined) return { tool, kind: "any" }; // bare "Bash" / "Edit" / "Computer" / "Worktree"
  if (content.endsWith(":*")) {
    const value = normalizeWhitespace(content.slice(0, -2));
    return value ? { tool, kind: "prefix", value } : null;
  }
  const value = normalizeWhitespace(content);
  return value ? { tool, kind: "exact", value } : null;
}

/** The tool a runtime call NAME maps to, in `parseRule`'s vocabulary — `write` and `edit` both
 *  map to "edit" (an `Edit` rule covers both; CC's grammar has no separate `Write` rule),
 *  `enter_worktree` and `exit_worktree` both map to "worktree". Anything else (including tool
 *  names this grammar simply has no opinion on yet, e.g. `read`) maps to `null` and therefore
 *  never matches any rule. */
function toolForCallName(name: string): string | null {
  switch (name) {
    case "bash": return "bash";
    case "write":
    case "edit": return "edit";
    case "computer": return "computer";
    case "enter_worktree":
    case "exit_worktree": return "worktree";
    default: return null;
  }
}

/** Best-effort `command` extraction from a tool call's `argsJson`, whitespace-normalized the same
 *  way `parseRule` normalizes a rule's value — so "git   push x" and a rule's "git push" compare
 *  as equal tokens. Malformed JSON or a non-string/absent `command` field (true for every
 *  non-bash tool's args) yields `""`, which a non-empty exact/prefix rule value can never match —
 *  a safe default `ruleMatches` doesn't need to special-case. */
function normalizedCommand(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { command?: unknown };
    return typeof parsed.command === "string" ? normalizeWhitespace(parsed.command) : "";
  } catch {
    return "";
  }
}

/**
 * Does a parsed rule allow this call? Tool identity first (via `toolForCallName`), then by kind:
 * "any" matches every call mapping to that tool; "exact" requires the normalized `command` to
 * equal the rule's value exactly; "prefix" additionally allows the command to continue past the
 * value with a whitespace boundary (`cmd === value || cmd.startsWith(value + " ")` — "git push
 * origin" matches a "git push" prefix rule, "git pushx" does not).
 */
export function ruleMatches(parsed: NonNullable<ReturnType<typeof parseRule>>, call: { name: string; argsJson: string }): boolean {
  const tool = toolForCallName(call.name);
  if (tool === null || tool !== parsed.tool) return false;
  if (parsed.kind === "any") return true;
  if (parsed.value === undefined) return false; // malformed parsed rule (never produced by parseRule) — never matches
  const cmd = normalizedCommand(call.argsJson);
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
    const path = this.projectRulesFile(root);
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
    mkdirSync(dotNorma, { recursive: true });
    const path = this.projectRulesFile(root);
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
    const obj: any = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; // same untyped-any idiom as settings.ts's loadSettings
    obj.permissions ??= {};
    const list: string[] = Array.isArray(obj.permissions.allow) ? [...obj.permissions.allow] : [];
    if (!list.includes(rule)) list.push(rule);
    obj.permissions.allow = list;
    writeFileAtomic(path, JSON.stringify(obj, null, 2) + "\n");
  }
}
