// WS-21 round 3 (Important): THE CANONICAL-CWD RE-KEY. Both legs now key a session's transcript by the
// REALPATH of its cwd (L2 O-1: the Winter child keys by `realpath(cwd)`, the official store key derives from
// the canonical cwd), but a session made before that — any 0.116 session whose cwd went through a symlink
// (`/tmp/app` → `/private/tmp/app`) — has its files under the RAW cwd's key, where neither leg looks any
// more: its history would be silently lost. `moveTranscriptFiles` carries ONE session's files to the
// canonical key. Migration C runs it in bulk (recorded in its manifest, reversed by rollback) and the
// driver runs it lazily at every resume (a symlink made later, a record the bulk step never saw).
//
// ONE SESSION'S FILES, BY NAME: `<id>.jsonl` (the transcript), every `<id>.*` sidecar (`.provider-state.jsonl`,
// `.summary.json`, …) and `<id>/` (subagents, tool results). Anything else under the key — another session,
// the project's `memory/` — is never touched. The id is the backend session UUID.
//
// NEVER OVERWRITE: when the canonical key already holds ANY of those names, nothing moves (`collision`) —
// the caller marks the session `repair-required` and logs it. Same-volume renames only; never through a
// link (a key directory that is a symbolic link refuses). The transcript moves LAST, so a crash mid-move
// leaves it at the old key and running the move again finishes the job: what already moved is no longer at
// the old key, so it is no collision.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export type TranscriptMoveResult =
  /** The two keys are the same: nothing to do. */
  | { kind: "not-needed" }
  /** Moved (the names, in move order — the transcript last). EMPTY when nothing of this session was at the
   *  old key: the record is simply re-pointed at the key the legs use. */
  | { kind: "moved"; entries: string[] }
  /** The canonical key already holds these names — NOTHING was moved. */
  | { kind: "collision"; entries: string[] }
  /** A link in the way, or a rename that failed (whatever this call had moved was put back). */
  | { kind: "refused"; reason: string };

const isLink = (p: string): boolean => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
};

/** This session's names under `dir`, the transcript last; `[]` when the directory is absent. */
export function transcriptEntriesOf(dir: string, backendSessionId: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const own = names.filter((n) => n === backendSessionId || n.startsWith(`${backendSessionId}.`));
  const transcript = `${backendSessionId}.jsonl`;
  return [...own.filter((n) => n !== transcript).sort(), ...own.filter((n) => n === transcript)];
}

export function moveTranscriptFiles(projectsDir: string, backendSessionId: string, fromKey: string, toKey: string): TranscriptMoveResult {
  if (fromKey === toKey) return { kind: "not-needed" };
  const fromDir = join(projectsDir, fromKey);
  const toDir = join(projectsDir, toKey);
  for (const p of [projectsDir, fromDir, toDir]) {
    if (isLink(p)) return { kind: "refused", reason: `${p} is a symbolic link — a transcript is never moved through one` };
  }
  const entries = transcriptEntriesOf(fromDir, backendSessionId);
  if (entries.length === 0) return { kind: "moved", entries: [] };
  const taken = entries.filter((n) => existsSync(join(toDir, n)) || isLink(join(toDir, n)));
  if (taken.length > 0) return { kind: "collision", entries: taken };
  try { mkdirSync(toDir, { recursive: true, mode: 0o700 }); } catch (err) {
    return { kind: "refused", reason: `${toDir} could not be created (${(err as Error).name})` };
  }
  const moved: string[] = [];
  for (const name of entries) {
    try {
      if (existsSync(join(toDir, name))) throw new Error("appeared");   // never overwrite, even in a race
      renameSync(join(fromDir, name), join(toDir, name));
      moved.push(name);
    } catch (err) {
      for (const back of [...moved].reverse()) {
        try { if (!existsSync(join(fromDir, back))) renameSync(join(toDir, back), join(fromDir, back)); } catch { /* reported below */ }
      }
      return { kind: "refused", reason: `moving ${name} failed (${(err as Error).name}); ${moved.length} earlier move(s) put back` };
    }
  }
  return { kind: "moved", entries: moved };
}
