import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nameError, parseFactFile, parseIndexEntries, serializeIndex, factFileContent, type MemoryFact } from "./memory";
import { memoryDirFor, globalMemoryDirFor, type MemoryDirOptions } from "./memory-dir";
import type { TrustStore } from "./trust";

/**
 * T2 (design doc "migration importer"): a one-time, idempotent, best-effort import of Phase 5b's
 * `MemoryStore` facts into T1's per-project MEMDIR files. Runs at daemon boot whenever
 * `memory.enabled` is on (daemon.ts) — see task-22-report.md for why "idempotent, safe to re-run
 * every boot" was chosen over a one-shot marker file.
 *
 * The OLD store is NEVER modified or deleted here — only read. `memory.enabled: false` therefore
 * stays a full escape hatch back to the untouched original data, forever (T1's own concern #2,
 * now resolved: with `enabled: true` the facts are ALSO visible via MEMDIR, not "neither read nor
 * migrated").
 *
 * Two source kinds, both walked every call (cheap: a handful of `readdirSync`s plus the already-
 * memoized `repoRootFor` git spawn per trusted dir):
 *  - the legacy USER scope (`<winterHome>/memory/*.md`) — global, never tied to a repo, so its
 *    facts land in the "no project" bucket (`globalMemoryDirFor`) — this is the design doc's
 *    "facts that don't map to a project → a sensible default location" answer, and the SAME
 *    bucket the memory.* RPC rewire (ipc/server.ts) falls back to for a cwd-less request, so a
 *    fact migrated here is immediately visible to `winter memory list` (no `--project`) too.
 *  - every legacy PROJECT scope found under a currently-trusted directory
 *    (`<trustedDir>/.winter/memory/*.md`, `TrustStore.list()`) — each maps to its OWN project's
 *    MEMDIR via `memoryDirFor(trustedDir, ...)` (git-repo-root keyed), so two trusted dirs inside
 *    the same repo/worktree correctly converge on the SAME target instead of splitting.
 */
export interface MigrateMemoryDeps {
  winterHome: string;
  trust: Pick<TrustStore, "list">;
  /** `settings.memory.directory` override — same value `daemon.ts` threads into `memoryDirFor`/
   *  `globalMemoryDirFor` for every other MEMDIR consumer. */
  directory?: string;
  /** P8b-17's relocation lookup, threaded for the SAME reason every other MEMDIR consumer gets it:
   *  this importer writes into `memoryDirFor(trustedDir, …)`, and in a home whose §17 phase 5
   *  migration has run, the pre-migration key is a directory nothing reads any more. Absent in every
   *  home that never migrated, which is the default. */
  relocatedKey?: MemoryDirOptions["relocatedKey"];
}

export interface MigrateSourceResult {
  source: string;
  target: string;
  /** Fact names actually written this call (target file did not already exist). */
  migrated: string[];
  /** Fact names left alone because a file of that name already existed at `target` — either an
   *  earlier migration run, or a fact the user/model already saved there independently; this
   *  importer never overwrites either. */
  skipped: string[];
}

export interface MigrateMemoryResult {
  sources: MigrateSourceResult[];
}

/** Reads every valid `<name>.md` fact directly under `dir` — same tolerant "corrupt/invalid name →
 *  skip, never throw" contract `MemoryStore.list` uses (MEMORY.md itself, a non-.md `audit.jsonl`,
 *  and any file whose stem fails the slug jail are all naturally excluded). Returns `[]`, not an
 *  error, for a directory that doesn't exist (nothing to migrate). */
function readSourceFacts(dir: string): MemoryFact[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryFact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (nameError(name)) continue;
    const parsed = parseFactFile(join(dir, entry));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Migrates every fact found in `sourceDir` into `targetDir`. Idempotency rule: migrate a fact
 *  ONLY IF `targetDir/<name>.md` does not already exist — chosen over a `.migrated-from-store`
 *  marker (the design doc's other suggested option) because it tolerates re-runs, a daemon killed
 *  mid-migration, AND legacy facts added to the old store AFTER the first migration ran (they get
 *  picked up on the next boot too) — all without a marker file's single-bit "already ran" state
 *  ever risking staleness or double-writes. A pre-existing target file (from an earlier run, or a
 *  same-named fact the user/model already created directly in MEMDIR) is left untouched — this
 *  importer only ever ADDS, never overwrites. */
function migrateOneDir(sourceDir: string, targetDir: string): MigrateSourceResult {
  const facts = readSourceFacts(sourceDir);
  const migrated: string[] = [];
  const skipped: string[] = [];
  if (facts.length === 0) return { source: sourceDir, target: targetDir, migrated, skipped };

  const indexPath = join(targetDir, "MEMORY.md");
  const entries = parseIndexEntries(indexPath);
  let indexChanged = false;

  for (const fact of facts) {
    const targetFile = join(targetDir, `${fact.name}.md`);
    if (existsSync(targetFile)) {
      skipped.push(fact.name);
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, factFileContent(fact, fact.description), "utf8");
    if (!entries.some((e) => e.name === fact.name)) {
      entries.push({ name: fact.name, description: fact.description });
      indexChanged = true;
    }
    migrated.push(fact.name);
  }
  if (indexChanged) writeFileSync(indexPath, serializeIndex(entries), "utf8");
  return { source: sourceDir, target: targetDir, migrated, skipped };
}

export function migrateMemoryStore(deps: MigrateMemoryDeps): MigrateMemoryResult {
  const dirOpts: MemoryDirOptions = { winterHome: deps.winterHome, directory: deps.directory, relocatedKey: deps.relocatedKey };
  const sources: MigrateSourceResult[] = [];

  const userSource = join(deps.winterHome, "memory");
  sources.push(migrateOneDir(userSource, globalMemoryDirFor(dirOpts)));

  for (const trustedDir of deps.trust.list()) {
    const projectSource = join(trustedDir, ".winter", "memory");
    if (!existsSync(projectSource)) continue;
    sources.push(migrateOneDir(projectSource, memoryDirFor(trustedDir, dirOpts)));
  }

  return { sources };
}
