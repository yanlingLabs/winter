// WS-21 (spec §3.1, §3.7; Contract A): the per-generation inputs the daemon hands the router's
// `buildRunHome`. The router builds the per-run folder from these and from `<home>/sdk`; the daemon
// supplies only what the folder cannot know by itself:
//
//   mode, dispatchChild, leg, cwd  the session's facts for THIS incarnation
//   trustedProjectRoot             `repoRootFor(cwd)` when the cwd is trusted, else null — no project
//                                  tier at all for an untrusted project (Q1)
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
import type { TrustStore } from "../agent/trust";
import { assistantMemoryDirFor, memoryDirFor, repoRootFor } from "../agent/memory-dir";
import { sdkAutoMemory, type Settings } from "../settings";
import type { RunHomeInput, RunLeg, RunMode } from "./run-home-contract";

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
    trustedProjectRoot: deps.trust.isTrusted(s.cwd) ? repoRootFor(s.cwd) : null,
    gitRoot: (deps.gitRootFor ?? gitRootFor)(s.cwd),
    mcpDisabled: [...(deps.settings()?.mcp?.disabled ?? [])],
    reservedMcpServerNames: [...deps.reservedMcpServerNames],
    memoryDir,
  };
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

/** Test only: forget cached git roots. */
export function _clearGitRootCacheForTests(): void {
  gitRoots.clear();
}
