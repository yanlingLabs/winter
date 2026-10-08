// ComputerV2 (2026-10-08) — the DIFF BASE per (session, target): the snapshotId of the last state the MODEL
// saw — a printed one, never an `emit:false` read (spec §6.3). The daemon hands it to the helper as `since`, so
// `state()` prints only what changed; with no base the helper sends the full tree.
//
// The base is forgotten (the next `state()` is full, spec §6.4) after a `reset`, a worker restart, an explicit
// `{full: true}` (which prints the full tree and makes IT the base), a window switch, and a COMPACTION — the
// model no longer has the old state in its context, so a diff against it would describe changes to something
// it cannot see. Compaction is read off the session log: a main-thread `continuity_warning` with
// `warning: "compacted"` (`projector/index.ts`).
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

export class DiffBases {
  private readonly bases = new Map<string, Map<string, string>>();

  get(sessionId: string, targetId: string): string | undefined {
    return this.bases.get(sessionId)?.get(targetId);
  }

  /** The model just SAW `snapshotId` for this target (a printed, whole-target state). */
  set(sessionId: string, targetId: string, snapshotId: string): void {
    let m = this.bases.get(sessionId);
    if (m === undefined) { m = new Map(); this.bases.set(sessionId, m); }
    m.set(targetId, snapshotId);
  }

  clearTarget(sessionId: string, targetId: string): void {
    this.bases.get(sessionId)?.delete(targetId);
  }

  /** Reset, worker restart, compaction, session end. */
  clearSession(sessionId: string): void {
    this.bases.delete(sessionId);
  }

  /** The hub observer: a main-thread compaction forgets every base of that session. */
  observe(event: SessionEvent): void {
    if (event.type !== "continuity_warning") return;
    const e = event as { warning?: string; threadId?: string; sessionId: string };
    if (e.warning !== "compacted") return;
    if (e.threadId !== undefined && e.threadId !== "main") return;
    this.clearSession(e.sessionId);
  }
}
