// WS-24: the directories a daemon-side LISTING reads a trusted project's items from — the same walk a run
// home loads them along, so a listing names what a session actually gets.
//
// The listings (`agents.list`, output styles, workflows) and the project memory RPC used to check trust on
// the cwd's own path and read `<cwd>/.winter/…` only. In a linked worktree of a trusted repository that
// under-reported twice over: trust is keyed on the REPOSITORY (`projectScopeTrusted` — a worktree of a
// trusted repo is trusted, the worktree's own path is not in `trust.json`), and the run home walks from the
// cwd up to the project scope's root (`projectScopeRootFor`: the cwd's own git top, a worktree's own), not
// the cwd alone. This is that walk, for the daemon's readers.
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
  const dir = real(cwd);
  if (!projectScopeTrusted(dir, trust)) return [];
  return projectWalk(dir, projectScopeRootFor(dir), real(homedir()));
}

/** The trusted project's scope ROOT for `cwd` (`projectScopeRootFor`), or `null` when there is no cwd or its
 *  project is not trusted — for a reader that keeps ONE project directory (the project memory store). */
export function trustedProjectRoot(cwd: string | null | undefined, trust: Pick<TrustStore, "isTrusted">): string | null {
  if (!cwd) return null;
  const dir = real(cwd);
  return projectScopeTrusted(dir, trust) ? projectScopeRootFor(dir) : null;
}
