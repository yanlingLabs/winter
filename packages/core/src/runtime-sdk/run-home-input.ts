// WS-21 (spec §3.1, §3.7; Contract A): the per-generation inputs the daemon hands the router's
// `buildRunHome`. The router builds the per-run folder from these and from `<home>/sdk`; the daemon
// supplies only what the folder cannot know by itself:
//
//   mode, dispatchChild, leg, cwd  the session's facts for THIS incarnation
//   trustedProjectRoot             `projectTierRootFor(cwd)` — the cwd's own git top, a linked worktree's
//                                  included (R.3 I-1) — when `projectTierTrusted(cwd)`, else null: no
//                                  project tier at all for an untrusted project (Q1)
//   gitRoot                        the canonical `git rev-parse --show-toplevel` (the local tier's
//                                  anchor, F17), cached per cwd
//   mcpDisabled                    Winter's own `mcp.disabled` (it stayed in settings.json, §4.1)
//   reservedMcpServerNames         every daemon capability-server name (`winter__<key>`)
//   memoryDir                      the ONE memory dir for this incarnation (§3.7): a code session's
//                                  project MEMDIR (the `autoMemoryDirectory` override and the
//                                  memory-key relocation honoured), the `_assistant` bucket for chat,
//                                  dispatch and a workdir-less code session — the same rule the
//                                  assembler's `memoryDirFor` has always applied.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { TrustStore } from "../agent/trust";
import { assistantMemoryDirFor, memoryDirFor, repoRootFor } from "../agent/memory-dir";
import { sdkAutoMemory, type Settings } from "../settings";
import type { RunHomeInput, RunLeg, RunMode } from "@yanlinglabs/winter-runtime-sdk";

export interface RunHomeInputDeps {
  /** The daemon's home. */
  home: string;
  trust: Pick<TrustStore, "isTrusted">;
  /** THE LIVE settings holder (read for `mcp.disabled`). */
  settings: () => Settings | null | undefined;
  /** Every daemon capability-server name (`capabilities/names.ts`'s `reservedMcpServerNames()`). */
  reservedMcpServerNames: readonly string[];
  /** The relocation-aware project MEMDIR for a cwd (the daemon's own `memoryDirOf`, which honours the
   *  memory-key relocation). Absent → `memoryDirFor` with the `autoMemoryDirectory` override. */
  memoryDirFor?: (cwd: string) => string;
  /** Test seam: the git root of a cwd. Absent → `gitRootFor` (cached `git rev-parse --show-toplevel`). */
  gitRootFor?: (cwd: string) => string | null;
}

export interface RunHomeSessionFacts {
  mode: RunMode;
  /** `meta.origin === "dispatch-child"`: a code session a dispatch coordinator spawned. */
  dispatchChild: boolean;
  leg: RunLeg;
  /** The directory the child runs in — the router refuses a run home built for another cwd. */
  cwd: string;
  /** A code session with no working directory of its own (its cwd is the session tmp dir): memory is
   *  the `_assistant` bucket, as `ContextAssembler.memoryDirFor` has always had it. */
  workdirLess?: boolean;
}

export function runHomeInputFor(deps: RunHomeInputDeps, s: RunHomeSessionFacts): RunHomeInput {
  const projectMemory = deps.memoryDirFor ?? ((cwd: string) => memoryDirFor(cwd, { winterHome: deps.home, directory: sdkAutoMemory(deps.home).directory }));
  const memoryDir = s.mode === "code" && s.workdirLess !== true ? projectMemory(s.cwd) : assistantMemoryDirFor({ winterHome: deps.home });
  return {
    home: deps.home,
    mode: s.mode,
    dispatchChild: s.dispatchChild,
    leg: s.leg,
    cwd: s.cwd,
    trustedProjectRoot: projectTierTrusted(s.cwd, deps.trust) ? projectTierRootFor(s.cwd, deps.gitRootFor ?? gitRootFor) : null,
    // The local tier's anchor — and, with `cwd`, the local MCP scope's key (`localScopeKeyFor` below is
    // the SAME rule, for every daemon-side reader and writer of that scope).
    gitRoot: (deps.gitRootFor ?? gitRootFor)(s.cwd),
    mcpDisabled: [...(deps.settings()?.mcp?.disabled ?? [])],
    reservedMcpServerNames: [...deps.reservedMcpServerNames],
    memoryDir,
  };
}

/**
 * R.3 I-1 (controller ruling) — THE project root a run home loads the project tier from (its walk's top:
 * `WINTER.md`, rules, skills, commands, output styles, agents, the project settings and MCP list), and so
 * the root every fence that protects what the run home loads must use too (`project-walk.ts`: the two
 * cannot differ): the cwd's OWN git top (`gitRootFor`, claude's `git rev-parse --show-toplevel` — for a
 * linked worktree the worktree itself, never the main checkout `repoRootFor` follows it to, whose walk
 * from a worktree cwd is empty), accepted only when it CONTAINS the cwd (`repoRootFor`'s own re-review
 * M-b/N3 rule: a forged `.git` file borrows no other project's root); else `repoRootFor(cwd)` (outside
 * git: the cwd itself). Trust is a separate question — `projectTierTrusted`.
 */
export function projectTierRootFor(cwd: string, gitRoot: (cwd: string) => string | null = gitRootFor): string {
  const own = gitRoot(cwd);
  if (own !== null) {
    let at = cwd;
    try { at = realpathSync(cwd); } catch { /* a vanished cwd: compare its spelling */ }
    if (at === own || at.startsWith(own.endsWith(sep) ? own : own + sep)) return own;
  }
  return repoRootFor(cwd);
}

/**
 * R.3 I-1 (controller ruling): whether the cwd's project tier loads at all. The trust decision stays keyed
 * on `repoRootFor(cwd)` — a linked worktree of a trusted repository is trusted, and the approved-rules
 * store keeps its key — and a directory the user trusted by its own path (or under one) stays trusted.
 */
export function projectTierTrusted(cwd: string, trust: Pick<TrustStore, "isTrusted">): boolean {
  if (trust.isTrusted(cwd)) return true;
  try { return trust.isTrusted(repoRootFor(cwd)); } catch { return false; }
}

const gitRoots = new Map<string, string | null>();

/**
 * The canonical `git rev-parse --show-toplevel` of `cwd` (a worktree's OWN top, unlike `repoRootFor`,
 * which follows a worktree to its main checkout), or `null` outside a repository. Cached per canonical
 * cwd for the process's life, like `repoRootFor`. Read-only: never writes git config.
 */
export function gitRootFor(cwd: string): string | null {
  let key = cwd;
  try { key = realpathSync(cwd); } catch { /* a vanished cwd: ask git about the spelling given */ }
  const hit = gitRoots.get(key);
  if (hit !== undefined || gitRoots.has(key)) return hit ?? null;
  let root: string | null = null;
  try {
    const p = Bun.spawnSync(["git", "-C", key, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
    const out = p.exitCode === 0 ? p.stdout.toString().trim() : "";
    if (out !== "") {
      try { root = realpathSync(out); } catch { root = out; }
    }
  } catch { root = null; }
  gitRoots.set(key, root);
  return root;
}

/**
 * Review I5 (controller ruling) — THE key of claude's LOCAL scope for a project: `sdk/.winter.json`'s
 * `projects[<key>]` (MCP servers) and the local settings tier's directory. Exactly what the run home reads:
 * `RunHomeInput.gitRoot` (`gitRootFor`, a linked worktree's OWN realpathed top-level — never `repoRootFor`,
 * which follows a worktree to its main checkout), else the realpathed cwd (the router's `gitRoot ?? cwd`
 * fallback; a session's recorded cwd is the physical path in practice — see the lane report). Every
 * daemon-side read and write of the local scope goes through this one function; exported for the CLI.
 */
export function localScopeKeyFor(cwd: string): string {
  const root = gitRootFor(cwd);
  if (root !== null) return root;
  try { return realpathSync(cwd); } catch { return cwd; }
}

/** Test only: forget cached git roots. */
export function _clearGitRootCacheForTests(): void {
  gitRoots.clear();
}
