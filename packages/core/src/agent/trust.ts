import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";

interface TrustFile { version: 1; trustedDirs: string[] }

/** Per-directory trust, persisted to a JSON file. Trust inherits to subdirectories. */
export class TrustStore {
  private trusted: string[];
  private epoch = 0;
  authorityRevision(): number { return this.epoch; }
  constructor(private readonly path: string) {
    this.trusted = TrustStore.read(path);
  }

  private static read(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustFile>;
      return Array.isArray(raw?.trustedDirs) ? raw.trustedDirs.map(String) : [];
    } catch { return []; }
  }

  private canon(dir: string): string {
    try { return realpathSync(dir); } catch { return dir; }
  }

  isTrusted(dir: string): boolean {
    const c = this.canon(dir);
    return this.trusted.some((t) => c === t || c.startsWith(t + sep));
  }

  trust(dir: string): void {
    const c = this.canon(dir);
    if (!this.trusted.includes(c)) {
      this.trusted.push(c);
      this.epoch++;
      writeFileSync(this.path, JSON.stringify({ version: 1, trustedDirs: this.trusted }, null, 2) + "\n");
    }
  }

  /** Revoke trust for a directory (exact canonicalized match — does not cascade to
   *  subdirectories that were never independently trusted). Same atomic rewrite-the-whole-file
   *  style as `trust()`. Returns whether anything was actually removed (idempotent: removing an
   *  already-untrusted dir is a no-op that returns false, not an error). */
  remove(dir: string): boolean {
    const c = this.canon(dir);
    const idx = this.trusted.indexOf(c);
    if (idx === -1) return false;
    this.trusted.splice(idx, 1);
    this.epoch++;
    writeFileSync(this.path, JSON.stringify({ version: 1, trustedDirs: this.trusted }, null, 2) + "\n");
    return true;
  }

  list(): string[] { return [...this.trusted]; }
}
