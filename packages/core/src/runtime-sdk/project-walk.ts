// WS-21 §3.4.2: the project walk, as its own leaf module so both the fences (`mode-options.ts`) and the
// protected paths (`protected-paths.ts`) can share it without an import cycle.
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Spec §3.4.2's PROJECT WALK — a mirror of the router's `projectWalk` (`src/run-home/walk.ts`, L2 fix
 * round 1 I2), so the directories whose items a run home LOADS and the ones this module PROTECTS cannot
 * differ: the cwd up to the trusted root, nearest first, never `$HOME` or above; nothing when there is
 * no trusted root or the cwd lies outside it.
 */
export function projectWalk(cwd: string, trustedProjectRoot: string | null, userHome: string): string[] {
  if (trustedProjectRoot === null) return [];
  const root = resolve(trustedProjectRoot);
  const start = resolve(cwd);
  const rel = relative(root, start);
  if (!(rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))) return [];
  const home = resolve(userHome);
  const walk: string[] = [];
  let current = start;
  for (;;) {
    if (current === home) break;
    walk.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return walk;
}
