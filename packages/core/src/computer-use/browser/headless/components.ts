// ComputerV2 Phase 4 — Winter Headless's browser COMPONENTS, kept across helper runs.
//
// Every helper run gets a fresh cache root (`<home>/cache/headless-cef/<random>`, removed at exit), so Chromium's
// component updater — kept on on purpose: it brings the Chrome Root Store and the CRLSet — downloaded its whole set
// again in every run (about ten files, ~60 s after start), and each run spent its first minute on the root store the
// build compiled in. The components alone (and nothing else of a run: no cookies, no cache, no browsing data — those
// live in the per-session in-memory contexts and the run's own profile folder, which are never kept) are kept in
// `<home>/cache/headless-components`:
//   - before a run starts, each kept component is CLONED into the fresh cache root (APFS: no bytes written), so the
//     browser loads it at once and the updater only checks it;
//   - when the run's helper has ended, every component folder of the run's cache root replaces its kept copy.
// What counts as a component is what Chromium installs one as: a folder holding a version folder with a
// `manifest.json` — at the top of the cache root (`CertificateRevocation/10831/manifest.json`) or one level down
// (`Subresource Filter/Unindexed Rules/9.72.0/manifest.json`), never inside a profile folder (`Default`, …, where a
// browser keeps its own data). Never a link, never anything else of the cache root, and never more than
// `HEADLESS_COMPONENTS_MAX_BYTES` in all. The updater verifies what it installs (Google-signed
// packages); a folder only lands here after it installed it.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";

/** `<home>/cache/headless-components`: the kept components, one folder each. */
export function headlessComponentsDir(home: string): string { return join(home, "cache", "headless-components"); }

/** A run's components larger than this in all are not kept (a runaway or a mistake, never Chromium's ~30 MB). */
export const HEADLESS_COMPONENTS_MAX_BYTES = 256 * 1024 * 1024;

const VERSION = /^\d+(\.\d+)*$/;

/** Is `dir` (a real folder) a component Chromium installed: a version folder inside with a `manifest.json`? */
export function isComponentDir(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    return readdirSync(dir).some((v) => {
      if (!VERSION.test(v)) return false;
      const version = join(dir, v);
      const manifest = join(version, "manifest.json");
      return lstatSync(version).isDirectory() && existsSync(manifest) && lstatSync(manifest).isFile();
    });
  } catch { return false; }
}

/** Folders of a cache root that hold a browser profile's own data — never searched for components. */
const PROFILE_DIR = /^(Default|Profile \d+|System Profile|Guest Profile)$/;

/** The components under `root`, as paths relative to it: a component folder at the top, or one level down in a folder
 *  that is not a profile's. Links are never entered. */
export function componentPaths(root: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names.sort()) {
    if (name.startsWith(".") || PROFILE_DIR.test(name)) continue;
    const top = join(root, name);
    try { if (!lstatSync(top).isDirectory()) continue; } catch { continue; }
    if (isComponentDir(top)) { out.push(name); continue; }
    let children: string[] = [];
    try { children = readdirSync(top); } catch { continue; }
    for (const child of children.sort()) if (!child.startsWith(".") && isComponentDir(join(top, child))) out.push(join(name, child));
  }
  return out;
}

/** The bytes under `dir`, links not followed (stops counting past `limit`). */
function sizeOf(dir: string, limit: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= limit) {
    const d = stack.pop()!;
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const name of names) {
      const p = join(d, name);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(p); else total += st.size;
      } catch { /* gone */ }
    }
  }
  return total;
}

/** A clone of `src` at `dst`: real folders and files only, never a link (APFS: no bytes written). */
function cloneTree(src: string, dst: string): void {
  cpSync(src, dst, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (from) => { try { return !lstatSync(from).isSymbolicLink(); } catch { return false; } },
  });
}

/** Before a run: the kept components, cloned into its fresh cache root. Returns their names. Never throws. */
export function seedHeadlessComponents(store: string, runDir: string, log?: (line: string) => void): string[] {
  const seeded: string[] = [];
  for (const name of componentPaths(store)) {
    try {
      mkdirSync(join(runDir, name, ".."), { recursive: true });
      cloneTree(join(store, name), join(runDir, name));
      seeded.push(name);
    } catch (err) {
      log?.(`computer-use: a kept headless browser component could not be used (${name}: ${err instanceof Error ? err.message : "error"})`);
    }
  }
  return seeded;
}

/** After a run's helper ended: its components replace their kept copies. Returns their names. Never throws. */
export function harvestHeadlessComponents(runDir: string, store: string, log?: (line: string) => void): string[] {
  const components = componentPaths(runDir);
  if (components.length === 0) return [];
  const bytes = components.reduce((sum, n) => sum + sizeOf(join(runDir, n), HEADLESS_COMPONENTS_MAX_BYTES), 0);
  if (bytes > HEADLESS_COMPONENTS_MAX_BYTES) {
    log?.(`computer-use: the headless browser's components came to more than ${HEADLESS_COMPONENTS_MAX_BYTES / (1024 * 1024)} MB — not kept`);
    return [];
  }
  try { mkdirSync(store, { recursive: true, mode: 0o700 }); } catch { return []; }
  // A copy a crash left half-staged (`.<name>.<random>`) goes first.
  try { for (const n of readdirSync(store)) if (n.startsWith(".")) rmSync(join(store, n), { recursive: true, force: true }); } catch { /* best effort */ }
  const kept: string[] = [];
  for (const name of components) {
    const staged = join(store, `.${name.replace(/\//g, "_")}.${randomBytes(4).toString("hex")}`);
    try {
      cloneTree(join(runDir, name), staged);
      rmSync(join(store, name), { recursive: true, force: true });
      mkdirSync(join(store, name, ".."), { recursive: true });
      renameSync(staged, join(store, name));
      kept.push(name);
    } catch (err) {
      try { rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
      log?.(`computer-use: a headless browser component could not be kept (${name}: ${err instanceof Error ? err.message : "error"})`);
    }
  }
  return kept;
}
