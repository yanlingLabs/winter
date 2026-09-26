// WS-24: the directories a daemon-side LISTING reads a trusted project's items from — the same walk a run
// home loads them along, so a listing names what a session actually gets.
//
// The listings (`agents.list`, output styles, workflows) and the project memory RPC used to check trust on
// the cwd's own path and read `<cwd>/.winter/…` only. In a linked worktree of a trusted repository that
// under-reported twice over: trust is keyed on the REPOSITORY (`projectScopeTrusted` — a worktree of a
// trusted repo is trusted, the worktree's own path is not in `trust.json`), and the run home walks from the
// cwd up to the project scope's root (`projectScopeRootFor`: the cwd's own git top, a worktree's own), not
// the cwd alone. This is that walk, for the daemon's readers. (The project MEMORY store keeps its cwd's
// own directory and takes only the trust half — `agent/memory.ts`.)
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { TrustStore } from "./trust";
import { projectScopeRootFor, projectScopeTrusted } from "../runtime-sdk/run-home-input";
import { projectWalk } from "../runtime-sdk/project-walk";

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The trusted project's walk for `cwd`: the (realpathed) cwd up to its project scope's root, NEAREST first,
 * never `$HOME` or above — `projectWalk`, the router's own run-home walk mirrored. `[]` when there is no cwd
 * or its project is not trusted (`projectScopeTrusted`). Each caller applies its kind's own precedence over
 * the walk, as the run home does (skills/commands: nearest wins; output styles: the root-most wins; agents:
 * nearest wins).
 */
export function trustedProjectWalk(cwd: string | null | undefined, trust: Pick<TrustStore, "isTrusted">): string[] {
  if (!cwd) return [];
  // realpath, not `path.resolve`: `projectScopeRootFor` answers with a realpathed git top, and `projectWalk`
  // compares the two textually — a cwd under a symlinked ancestor (`/tmp` → `/private/tmp` on macOS, a
  // linked checkout) would otherwise fall "outside" its own root and walk nothing. The router's run home
  // receives the session's recorded (physical) cwd, so the two walks name the same directories.
  const dir = real(cwd);
  if (!trustedAsGiven(cwd, dir, trust)) return [];
  return projectWalk(dir, projectScopeRootFor(dir), real(homedir()));
}

/** Trust asked of the cwd as the caller spelled it AND as realpathed — a `trust.json` entry, or a caller's
 *  own trust set, may hold either spelling (`/var/…` vs `/private/var/…` on macOS); the walk itself is
 *  always built from the real path, which is what `projectScopeRootFor` answers in. */
function trustedAsGiven(cwd: string, dir: string, trust: Pick<TrustStore, "isTrusted">): boolean {
  return projectScopeTrusted(dir, trust) || (cwd !== dir && projectScopeTrusted(cwd, trust));
}
