// Winter-shipped skills the child can LOAD: a managed copy of each into the user's skill tier,
// `<home>/sdk/skills/<name>/SKILL.md` — the one tier a session's run folder links.
//
// Why a copy: `packages/core/skills/` (the "builtin" tier `SkillStore` lists) is staged into no run folder, so
// a skill only there is listed, never loaded (`SkillStore.sessionAvailability`). The text is EMBEDDED (a bun
// text import) rather than read from that directory, because a compiled `winter-core` has no repo to read:
// `import.meta.url` there is a virtual path. The same file is still the source for the builtin listing.
//
// Every boot, on every home (beside the settings split, after the sdk home exists), per skill:
//
//   never seeded, target absent .......................... write it, record its hash
//   seeded, target untouched (hash == recorded), text new .. overwrite it (a newer Winter updates a copy
//                                                            nobody edited), record the new hash
//   seeded, target absent ................................ the user deleted it: NEVER re-create
//   seeded, target edited (hash != recorded) ............. leave it, one log line
//   never seeded, target present ......................... the user's own skill of that name: never touch it
//
// The record is `<home>/migration/builtin-skills.json`: `{ "<name>": { "seededHash": sha256-hex of the bytes
// last written } }`. Two cases leave the FILE alone and only repair the record: the target already holds
// exactly the bytes this Winter ships (a crash between the file's rename and the record's, or a lost
// record) — nothing is written, so a later update still finds an untouched copy. A symlinked skill dir or
// SKILL.md is the user's own arrangement and is never written through.
//
// Writes are atomic (`sdk-files.ts`: temp file, fsync, rename). Nothing here throws: a failure logs one line
// and boot goes on; the next boot retries.
/// <reference path="../ambient-md.ts" />
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import computerUseSkill from "../../skills/computer-use/SKILL.md" with { type: "text" };
import { sdkHomeFor } from "../agent/paths";
import { writeJsonAtomic, writeTextAtomic } from "../sdk-files";

/** A skill this Winter keeps a managed copy of: its directory name under `sdk/skills/` and its SKILL.md text. */
export interface SeededSkill { name: string; text: string }

/** The skills seeded at boot, in the order they are checked. Each is also a directory of `packages/core/skills/`. */
export const BUILTIN_SEEDED_SKILLS: readonly SeededSkill[] = [
  { name: "computer-use", text: computerUseSkill },
];

/** `<home>/migration/builtin-skills.json`. */
export function builtinSkillsRecordPath(home: string): string {
  return join(home, "migration", "builtin-skills.json");
}

/** `<home>/sdk/skills/<name>/SKILL.md`. */
export function seededSkillPath(home: string, name: string): string {
  return join(sdkHomeFor(home), "skills", name, "SKILL.md");
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export type SeedOutcome = "seeded" | "updated" | "recorded" | "unchanged" | "deleted-by-user" | "edited" | "not-ours" | "unreadable" | "failed";
export interface BuiltinSkillsReport { skills: Record<string, SeedOutcome> }

type Record_ = Record<string, { seededHash: string }>;

/** The record, `{}` when absent; `undefined` when it exists but is not a usable object (never overwritten then). */
function readRecord(home: string): Record_ | undefined {
  let raw: string;
  try { raw = readFileSync(builtinSkillsRecordPath(home), "utf8"); } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record_ = {};
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      const h = v !== null && typeof v === "object" ? (v as { seededHash?: unknown }).seededHash : undefined;
      if (typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) out[name] = { seededHash: h };
    }
    return out;
  } catch { return undefined; }
}

/** What is at `path`: `absent`, a regular file (its bytes), or something the user arranged (a symlink, a directory). */
function inspect(path: string): { kind: "absent" } | { kind: "file"; bytes: Buffer } | { kind: "other" } {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { kind: "other" };
    return { kind: "file", bytes: readFileSync(path) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "other" };
  }
}

/** Is the skill's own DIRECTORY a symlink (the user keeps their copy elsewhere)? A missing one is not. */
function skillDirIsLink(home: string, name: string): boolean {
  try { return lstatSync(join(sdkHomeFor(home), "skills", name)).isSymbolicLink(); } catch { return false; }
}

/**
 * Apply the rules above to every seeded skill. Never throws. `skills` defaults to the shipped list; a test
 * passes its own text to play a newer or older Winter.
 */
export function seedBuiltinSkills(home: string, opts: { skills?: readonly SeededSkill[]; log?: (line: string) => void } = {}): BuiltinSkillsReport {
  const report: BuiltinSkillsReport = { skills: {} };
  const log = opts.log ?? (() => {});
  const skills = opts.skills ?? BUILTIN_SEEDED_SKILLS;
  try {
    const record = readRecord(home);
    if (record === undefined) {
      for (const s of skills) report.skills[s.name] = "unreadable";
      log(`builtin skills: ${builtinSkillsRecordPath(home)} is not a readable JSON object — nothing seeded or updated; fix or remove it`);
      return report;
    }
    let recordChanged = false;
    for (const skill of skills) {
      try {
        const outcome = seedOne(home, skill, record, log);
        report.skills[skill.name] = outcome.outcome;
        if (outcome.recordChanged) recordChanged = true;
      } catch (err) {
        report.skills[skill.name] = "failed";
        log(`builtin skills: ${skill.name} not seeded (${(err as Error).message}) — retried at the next boot`);
      }
    }
    if (recordChanged) {
      try { writeJsonAtomic(builtinSkillsRecordPath(home), record); } catch (err) {
        log(`builtin skills: the record was not written (${(err as Error).message}) — retried at the next boot`);
      }
    }
  } catch (err) {
    log(`builtin skills: not checked (${(err as Error).message})`);
  }
  return report;
}

function seedOne(home: string, skill: SeededSkill, record: Record_, log: (line: string) => void): { outcome: SeedOutcome; recordChanged: boolean } {
  const path = seededSkillPath(home, skill.name);
  const shipped = sha256Hex(skill.text);
  const seeded = record[skill.name]?.seededHash;
  if (skillDirIsLink(home, skill.name)) return { outcome: "not-ours", recordChanged: false };
  const at = inspect(path);
  const write = (): void => { writeTextAtomic(path, skill.text); record[skill.name] = { seededHash: shipped }; };

  if (at.kind === "other") {
    log(`builtin skills: ${path} is not a plain file — left alone`);
    return { outcome: "not-ours", recordChanged: false };
  }
  if (seeded === undefined) {
    if (at.kind === "absent") {
      write();
      log(`builtin skills: ${skill.name} seeded into ${path}`);
      return { outcome: "seeded", recordChanged: true };
    }
    if (sha256Hex(at.bytes) === shipped) { // exactly what this Winter ships: adopt it, so later updates reach it
      record[skill.name] = { seededHash: shipped };
      return { outcome: "recorded", recordChanged: true };
    }
    return { outcome: "not-ours", recordChanged: false }; // the user's own skill of this name
  }
  if (at.kind === "absent") return { outcome: "deleted-by-user", recordChanged: false };
  const onDisk = sha256Hex(at.bytes);
  if (onDisk === seeded) {
    if (seeded === shipped) return { outcome: "unchanged", recordChanged: false };
    write();
    log(`builtin skills: ${skill.name} updated in ${path}`);
    return { outcome: "updated", recordChanged: true };
  }
  if (onDisk === shipped) { // already the shipped text (an interrupted update): only the record is behind
    record[skill.name] = { seededHash: shipped };
    return { outcome: "recorded", recordChanged: true };
  }
  log(`builtin skills: ${skill.name} at ${path} was edited — left as it is (to get Winter's copy again, delete that file and the \`${skill.name}\` entry in ${builtinSkillsRecordPath(home)})`);
  return { outcome: "edited", recordChanged: false };
}
