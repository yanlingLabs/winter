import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { approvedProjectRulesDir } from "./paths";

/**
 * WS-21 (spec §4.3): RETIRED AS A STORE — READ-ONLY NOW. A card's "in this project" answer is saved to
 * the trusted project's `.winter/settings.local.json` (`agent/saved-answers.ts`), where both runtimes
 * read it natively; nothing writes `<home>/permissions/projects.json` any more. What an older build
 * recorded is still READ — by the saved-rules reader on a build whose router does not apply run homes,
 * by `winter doctor` (which reports leftover entries) and by `winter migrate-project` (which moves them
 * into the project's `.winter/settings.local.json`). Migration C archives the directory.
 *
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
 * **Only the daemon's own directory and file count** (re-review R1). Because the record is applied
 * without a trust check, a `<home>/permissions` that is a LINK to a session-writable directory would
 * let any sandboxed session mint "user-approved" rules for any project (reproduced: one unsandboxed
 * `ln -s`, then `rulesFor()` answered a planted `["Bash"]`). So before every read and write the
 * directory must be a real directory whose realpath is `<realpath(home)>/permissions`, and
 * `projects.json` is opened with `O_NOFOLLOW` and must be a regular file. Anything else reads as "no
 * rules" with ONE log line per condition; nothing found there is ever removed — it is left for the
 * user. (Before WS-21 the daemon created the directory 0700 at boot and wrote the record itself.)
 *
 * Shape: `{ "version": 1, "projects": { "<realpath of the root>": ["Bash(npm test)", …] } }`. A missing,
 * malformed or oversized file reads as "no rules". Never throws from `rulesFor`.
 */
export class ApprovedProjectRules {
  private cache: { mtimeMs: number; size: number; projects: Record<string, string[]> } | undefined;
  /** The refusal last logged — so a standing condition is ONE log line, not one per spawn. */
  private refusal: string | undefined;

  constructor(private readonly deps: { winterHome: string; log?: (line: string) => void }) {}

  /** The file, `<home>/permissions/projects.json`. */
  file(): string {
    return join(approvedProjectRulesDir(this.deps.winterHome), "projects.json");
  }

  /** Every rule recorded for `projectRoot` (canonicalised), in the order they were approved. */
  rulesFor(projectRoot: string): string[] {
    return [...(this.read().projects[canonical(projectRoot)] ?? [])];
  }

  /**
   * `true` when `<home>/permissions` is the home's own real directory, `false` when it is absent
   * (nothing planted yet — the realpath it WILL have is the home's own), and throws when it is
   * anything else: a link, a non-directory, or a directory that resolves elsewhere.
   */
  private checkDir(): boolean {
    const dir = approvedProjectRulesDir(this.deps.winterHome);
    const expected = join(realpathSync(this.deps.winterHome), "permissions");
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`${dir} is a symbolic link`);
    if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
    const real = realpathSync(dir);
    if (real !== expected) throw new Error(`${dir} resolves to ${real}, not ${expected}`);
    return true;
  }

  private read(): { projects: Record<string, string[]> } {
    try {
      if (!this.checkDir()) { this.cache = undefined; this.refusal = undefined; return { projects: {} }; }
      const projects = this.readFile((st) => this.cache !== undefined && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size);
      this.refusal = undefined;
      if (projects === "absent") { this.cache = undefined; return { projects: {} }; }
      if (projects === "cached") return this.cache!;
      this.cache = { mtimeMs: projects.mtimeMs, size: projects.size, projects: projects.parsed ?? {} };
      return this.cache;
    } catch (err) {
      this.cache = undefined;
      this.refuse(err);
      return { projects: {} };
    }
  }

  /**
   * Open `projects.json` WITHOUT following a link (`O_NOFOLLOW`: a link there fails with ELOOP) and
   * require a regular file. `"absent"` when there is none; `"cached"` when `fresh(stat)` says the
   * cached parse still holds; otherwise the parse (`null` when malformed or oversized). Throws on a
   * link or a non-file.
   */
  private readFile(fresh: (st: { mtimeMs: number; size: number }) => boolean):
    "absent" | "cached" | { mtimeMs: number; size: number; parsed: Record<string, string[]> | null } {
    let fd: number;
    try { fd = openSync(this.file(), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "absent";
      if (code === "ELOOP") throw new Error(`${this.file()} is a symbolic link`);
      throw err;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`${this.file()} is not a regular file`);
      if (fresh(st)) return "cached";
      const parsed = st.size > MAX_BYTES ? null : parseText(readFileSync(fd, "utf8"));
      return { mtimeMs: st.mtimeMs, size: st.size, parsed };
    } finally {
      closeSync(fd);
    }
  }

  private refuse(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    if (this.refusal === reason) return;
    this.refusal = reason;
    (this.deps.log ?? console.error)(`approved-project-rules: not using ${approvedProjectRulesDir(this.deps.winterHome)} — ${reason}; the rules an older build recorded there are not applied until it is the daemon's own directory again`);
  }
}

const MAX_BYTES = 1024 * 1024;

function canonical(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}

/** `null` for anything that is not the documented shape; string entries only. */
function parseText(text: string): Record<string, string[]> | null {
  try {
    const raw = JSON.parse(text) as { projects?: unknown };
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
