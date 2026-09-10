import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { bootstrapNormaDir, type NormaDirs } from "../../src/norma-dir";
export async function withTempHome(fn: (home: string, dirs: NormaDirs) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "norma-8a-")); const dirs = bootstrapNormaDir(home);
  try { await fn(home, dirs); } finally { rmSync(home, { recursive: true, force: true }); }
}
export const ISO = () => new Date().toISOString();
