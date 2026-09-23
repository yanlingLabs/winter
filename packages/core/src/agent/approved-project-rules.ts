import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { approvedProjectRulesDir } from "./paths";

/**
 * **The daemon's own record of the rules a user approved "in this project"** (review I2, 2026-09-23).
 *
 * The card's "Allow … in this project" option has always written `<projectRoot>/.winter/
 * permissions.local.json` (`PermissionRules.append`, scope `"project"`). That file lives INSIDE the
 * repository, so a cloned repository can ship one (`git add -f`) — which is why the saved-rules
 * reader (`mode-options.ts`'s `persistedAllowRulesFor`) applies it only to a TRUSTED project. But the
 * Mac app never marks a project trusted, so for every Mac project the option was offered, answered,
 * written — and never applied.
 *
 * This record closes that without trusting the repository: it lives under `<home>` (write-fenced from
 * every tool on both legs, `controlPlaneDenyRules`/`sandboxConfigFor`), is keyed by the CANONICAL
 * project root, and is written ONLY by `approval.respond` when the user chose a project-scoped option
 * on a card — so everything in it is something the user actually approved for that project, which a
 * repository cannot forge. The reader applies it regardless of trust.
 *
 * Shape: `{ "version": 1, "projects": { "<realpath of the root>": ["Bash(npm test)", …] } }`.
 * Writes are atomic (tmp + rename); a missing, malformed or oversized file reads as "no rules" and is
 * never rewritten from a bad parse (a later `record` starts from what it can read, and a malformed file
 * is left for the user rather than silently replaced). Never throws from `rulesFor`.
 */
export class ApprovedProjectRules {
  private cache: { mtimeMs: number; size: number; projects: Record<string, string[]> } | undefined;

  constructor(private readonly deps: { winterHome: string }) {}

  /** The file, `<home>/permissions/projects.json`. */
  file(): string {
    return join(approvedProjectRulesDir(this.deps.winterHome), "projects.json");
  }

  /** Every rule recorded for `projectRoot` (canonicalised), in the order they were approved. */
  rulesFor(projectRoot: string): string[] {
    return [...(this.read().projects[canonical(projectRoot)] ?? [])];
  }

  /**
   * Record one approved rule for `projectRoot`. Deduped; atomic. Refuses (throws) when the existing
   * file cannot be parsed, so a user's hand-edited-but-broken file is never overwritten with a
   * one-rule replacement — the caller (`approval.respond`) logs that and still resolves the card.
   */
  record(projectRoot: string, rule: string): void {
    const current = this.readForWrite();
    const key = canonical(projectRoot);
    const rules = current.projects[key] ?? [];
    if (rules.includes(rule)) return;
    const next = { version: 1, projects: { ...current.projects, [key]: [...rules, rule] } };
    const dir = approvedProjectRulesDir(this.deps.winterHome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file()}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file());
    this.cache = undefined;
  }

  private read(): { projects: Record<string, string[]> } {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(this.file()); } catch { this.cache = undefined; return { projects: {} }; }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache;
    const parsed = st.size > MAX_BYTES ? null : parseFile(this.file());
    const projects = parsed ?? {};
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, projects };
    return this.cache;
  }

  private readForWrite(): { projects: Record<string, string[]> } {
    let exists = true;
    try { statSync(this.file()); } catch { exists = false; }
    if (!exists) return { projects: {} };
    const parsed = parseFile(this.file());
    if (parsed === null) throw new Error(`${this.file()} is not a readable approved-rules record — leaving it untouched`);
    return { projects: parsed };
  }
}

const MAX_BYTES = 1024 * 1024;

function canonical(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}

/** `null` for anything that is not the documented shape; string entries only. */
function parseFile(path: string): Record<string, string[]> | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { projects?: unknown };
    if (typeof raw !== "object" || raw === null || typeof raw.projects !== "object" || raw.projects === null || Array.isArray(raw.projects)) return null;
    const out: Record<string, string[]> = {};
    for (const [root, rules] of Object.entries(raw.projects as Record<string, unknown>)) {
      if (Array.isArray(rules)) out[root] = rules.filter((r): r is string => typeof r === "string");
    }
    return out;
  } catch {
    return null;
  }
}
