// Phase 9c Migration B (WS-16 §18) — the manifest shape, its on-disk paths, and the ONE reader
// (`readMigrationManifest`). Kept as its own leaf module so `daemon.ts`'s boot hook, `migrate-b.ts`'s
// executor, the CLI's `--status`, and `runtime-state/doctor.ts`'s migration row can all import just
// this file's tiny surface without pulling in the executor's fs/crypto machinery.
//
// Crash-safety contract (advisor-reviewed): the manifest is written to disk via a tmp-file +
// `renameSync` (POSIX rename is atomic on the same volume, so a reader never observes a torn write)
// AFTER EVERY entry the executor completes — never batched — so an interrupted run always leaves
// EITHER no manifest at all (nothing started yet) OR a manifest whose `entries`/`keychain` arrays
// name exactly the work that is actually done on disk. `readMigrationManifest` itself stays
// deliberately permissive (absent OR unparsable both read as `null`, matching the pinned public
// signature `MigrationManifest | null`); the boot hook's FAIL-CLOSED distinction between "no manifest
// file" and "a manifest file exists but will not parse" lives in `manifestFileState` below, which
// `readMigrationManifest` is defined in terms of.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { WinterProfile } from "../profile";

export type MigrationEntryStatus = "copied" | "skipped" | "rekeyed" | "rebuilt";

export interface MigrationFileEntry {
  src: string;
  dest: string;
  sha256: string;
  bytes: number;
  status: MigrationEntryStatus;
}

export type MigrationKeychainStatus = "copied" | "skipped-existing" | "absent";

export interface MigrationKeychainEntry {
  name: string;
  from: string;
  to: string;
  status: MigrationKeychainStatus;
}

export interface MigrationManifest {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  legacyHome: string;
  home: string;
  profile: WinterProfile;
  status: "in-progress" | "complete" | "rolled-back";
  entries: MigrationFileEntry[];
  keychain: MigrationKeychainEntry[];
}

/** `<home>/migration/` — every artifact Migration B writes lives under this one subdirectory, so
 *  `rollbackMigrationB` can clear its bookkeeping with a single, well-scoped removal. */
export function migrationDir(home: string): string {
  return join(home, "migration");
}

export function manifestPath(home: string): string {
  return join(migrationDir(home), "manifest.json");
}

/** Touched LAST, after the manifest itself is written with `status: "complete"` — a secondary,
 *  file-presence signal for anything that wants "did Migration B ever finish" without parsing JSON
 *  (nothing in this lane reads it today; it exists because the Interfaces block pins it). */
export function completeMarkerPath(home: string): string {
  return join(migrationDir(home), "COMPLETE");
}

/** Where `rollbackMigrationB` leaves its final record after clearing the working manifest. */
export function rolledBackManifestPath(home: string): string {
  return join(migrationDir(home), "manifest.rolled-back.json");
}

/** Atomic write: a same-directory temp file + `renameSync` so a reader never observes a torn file
 *  and a crash mid-write leaves the PREVIOUS manifest (or nothing) rather than a corrupt one. */
export function writeManifestAtomic(home: string, manifest: MigrationManifest): void {
  const dir = migrationDir(home);
  mkdirSync(dir, { recursive: true });
  const target = manifestPath(home);
  const tmp = join(dir, `.manifest.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
}

function isManifestShaped(v: unknown): v is MigrationManifest {
  return (
    !!v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).schemaVersion === 1 &&
    typeof (v as Record<string, unknown>).status === "string" &&
    Array.isArray((v as Record<string, unknown>).entries) &&
    Array.isArray((v as Record<string, unknown>).keychain)
  );
}

/** The fail-closed variant the boot hook uses: distinguishes "no manifest file" (safe to proceed)
 *  from "a manifest file exists but is unreadable/malformed" (must refuse exactly like an
 *  in-progress one — a torn or corrupt manifest is evidence a previous run was interrupted mid
 *  write, not evidence nothing happened). */
export function manifestFileState(home: string): { kind: "absent" } | { kind: "unreadable" } | { kind: "parsed"; manifest: MigrationManifest } {
  const p = manifestPath(home);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!isManifestShaped(parsed)) return { kind: "unreadable" };
    return { kind: "parsed", manifest: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Public reader (Interfaces block, pinned signature): absent OR unparsable both read as `null`. */
export function readMigrationManifest(home: string): MigrationManifest | null {
  const state = manifestFileState(home);
  return state.kind === "parsed" ? state.manifest : null;
}

/** `rollbackMigrationB`'s final step: clear the working manifest/COMPLETE marker and leave only the
 *  rolled-back record behind, inside the SAME `migration/` directory. */
export function clearWorkingManifest(home: string): void {
  const dir = migrationDir(home);
  for (const p of [manifestPath(home), completeMarkerPath(home)]) {
    try { unlinkSync(p); } catch { /* absent — fine */ }
  }
  // Directory itself is left in place (it now holds, or is about to hold, manifest.rolled-back.json).
  mkdirSync(dir, { recursive: true });
}
