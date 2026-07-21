import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** The user's GLOBAL git excludes. git honors `core.excludesfile`, else `$XDG_CONFIG_HOME/git/ignore`
 *  (default `~/.config/git/ignore`). We target the XDG default — Norma manages only its OWN personal
 *  patterns there, never a repo's `.gitignore`. */
function defaultGlobalGitignorePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length ? xdg : join(homedir(), ".config"), "git", "ignore");
}

/** Idempotently ensure each pattern is present in the user's global git excludes. Creates the file
 *  and its parent dir if absent; never clobbers existing lines; never throws (best-effort — a
 *  gitignore we can't write is a cosmetic loss, not a failure of the action that triggered it). */
export function ensureGlobalGitignore(patterns: string[], opts: { path?: string } = {}): void {
  const path = opts.path ?? defaultGlobalGitignorePath();
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const missing = patterns.filter((p) => !have.has(p));
    if (!missing.length) return;
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, missing.join("\n") + "\n");
      return;
    }
    const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(path, prefix + missing.join("\n") + "\n");
  } catch (err) {
    console.error(`ensureGlobalGitignore: could not update ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The personal `.norma/` patterns Norma manages in the global excludes (shared config stays committable). */
export const NORMA_PERSONAL_IGNORES = [
  "**/.norma/settings.local.json",
  "**/.norma/permissions.local.json",
  "**/.norma/worktrees/",
];
