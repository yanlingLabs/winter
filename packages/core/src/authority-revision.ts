import { statSync } from "node:fs";
import { resolve } from "node:path";

// Incarnation-local epochs: receipts never survive a daemon/query incarnation. Successful host
// mutations advance the epoch even when a value is immediately restored before the next read.
const epochs = new Map<string, number>();
const signatures = new Map<string, string>();
export function advanceAuthorityRevision(key: string): void {
  key = resolve(key);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
}
export function authorityRevision(key: string): number {
  return epochs.get(resolve(key)) ?? 0;
}
/** External edits additionally invalidate on observed file identity changes; this is metadata only.
 * Daemon watchers advance on every observed event, before debounce can coalesce restored values. */
export function authorityFileRevision(path: string): number {
  path = resolve(path);
  let signature: string;
  try {
    const st = statSync(path, { bigint: true });
    signature = `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mtimeNs}:${st.size}`;
  } catch (error) {
    signature = `unavailable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
  if (signatures.get(path) !== signature) {
    signatures.set(path, signature);
    advanceAuthorityRevision(path);
  }
  return authorityRevision(path);
}
