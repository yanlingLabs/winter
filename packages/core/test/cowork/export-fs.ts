// Re-exports node:fs plus two tiny test-only helpers (a FIFO and a rename), kept out of the test files so their text stays plain.
import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
export * from "node:fs";
export function mkfifoSyncForTest(path: string): void { const result = spawnSync("/usr/bin/mkfifo", [path]); if (result.status !== 0) throw new Error("mkfifo failed"); }
export async function renameForTest(from: string, to: string): Promise<void> { renameSync(from, to); }
