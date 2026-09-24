import { join } from "node:path";
import { CONTROL_PLANE_FILENAMES, type HomeFence } from "./control-plane";
import { selfGrantDenyWrite } from "./mode-options";

/**
 * **What no agent may write under Winter's home — ONE list, three fences** (whole-branch review,
 * 2026-09-23, lane C).
 *
 * The fences:
 *  1. the Bash sandbox (`sandboxConfigFor(home).filesystem.denyWrite`, `mode-options.ts`) — the seatbelt
 *     every SANDBOXED command runs under;
 *  2. the escape floor (`hooks.ts` §2a) — the same targets for a command that asked to leave that
 *     seatbelt (`dangerouslyDisableSandbox: true`), denied under every policy, bypass included;
 *  3. the bridge's control-plane fence for the write-class tools (`control-plane.ts`'s
 *     `controlPlaneTargetForCall`, called from `approval-bridge.ts` (2)).
 *
 * The sandbox's `denyWrite` is the SOURCE: it is read here rather than copied, so an entry added
 * there (a new store the daemon keeps under `<home>`) reaches the other two fences with no second
 * edit. Only what the sandbox does not name is added below, each for a stated reason — and an entry
 * the sandbox later names too is simply deduplicated.
 */

/**
 * The fenced DIRECTORIES (absolute; a fence covers each and everything under it): the sandbox's own
 * `denyWrite`, plus
 *  - `<home>/agents` — agent definitions are a permission-bearing surface (their `permissionMode`/
 *    `tools` are a grant); the write-tool deny rules fence it (`controlPlaneDenyRules`), the sandbox
 *    does not name it;
 *  - `<home>/cache` — wholesale: the run folders and the router's quarantine live there (WS-21), and
 *    nothing legitimate writes the cache through a tool.
 */
export function homeFencedDirs(home: string): string[] {
  // The sandbox's SELF-GRANT list — never its protected-path entries (review I7: those are a card for a
  // write tool, and this list is the write-tool fence's hard deny).
  // LITERAL real paths, never `childSandboxConfigFor`'s `[[]` glob spelling (C-1): both consumers compare real paths.
  const fromSandbox = selfGrantDenyWrite(home);
  return [...new Set([...fromSandbox, join(home, "agents"), join(home, "cache")])];
}

/**
 * The fenced home subtrees the model is POINTED AT to read and execute — plugin skill content, and the
 * skill-plugin views under `cache` (whole-branch review N1). The sandbox and the write-tool fence treat
 * every fenced path alike (they only ever fence writes); the escape floor, which matches a command's
 * text, refuses these only in a write-shaped position, and every other fenced path on any mention.
 *
 * PATH PREFIXES relative to `<home>`, one or more segments (WS-21 §7.1: `sdk/plugins` is where the
 * installed plugins live now); a fenced path is write-only when its relative path equals a prefix or
 * lies under one (`isHomeWriteOnly`).
 */
export const HOME_WRITE_ONLY_FENCED: readonly string[] = ["cache", "plugins", "sdk/plugins"];

/** Whether a fenced path, relative to `<home>`, is one the escape floor refuses in a write-shaped
 *  position only. */
export function isHomeWriteOnly(relativeToHome: string): boolean {
  return HOME_WRITE_ONLY_FENCED.some((p) => relativeToHome === p || relativeToHome.startsWith(`${p}/`));
}

/** Fenced single FILES under `<home>` (absolute): the directory-trust store — writing it trusts a
 *  project, whose overlay then grants itself permissions. */
export function homeFencedFiles(home: string): string[] {
  return [join(home, "trust.json")];
}

/** Fenced wherever they appear, in any project: every `.winter/agents/` directory (the project tier of
 *  the agent definitions), matched as a path segment. */
export const PROJECT_FENCED_SEGMENTS: readonly string[] = [".winter/agents/"];

/** The filenames the escape floor refuses to see named at all (its match is a conservative substring):
 *  the three control-plane files plus `trust.json`, and (WS-21 §7.1, "any mention") `.winter.json` —
 *  `sdk/.winter.json` is the user's MCP server list. The write-tool fence is precise instead
 *  (`controlPlaneFileTarget` + `homeFencedFiles`). */
export const ESCAPE_FENCED_FILENAMES: readonly string[] = [...CONTROL_PLANE_FILENAMES, "trust.json", ".winter.json"];

export function homeFenceFor(home: string): HomeFence {
  return { dirs: homeFencedDirs(home), files: homeFencedFiles(home), segments: PROJECT_FENCED_SEGMENTS };
}
