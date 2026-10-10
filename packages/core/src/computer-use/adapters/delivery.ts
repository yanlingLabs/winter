// ComputerV2 Phase 2 — WHICH apps' extras block (functions, dictionary line, guide) this session's model has seen. The
// block is printed once per session per bundle id; the set is forgotten when the model can no longer see it — a
// COMPACTION of the main thread (the `DiffBases.observe` rule), a reset or worker restart (`clearSession`), the
// session's end — so the next bind, or the next primitive touching the app, prints it again.
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

export class AdapterDelivery {
  private readonly delivered = new Map<string, Set<string>>();

  has(sessionId: string, bundleId: string): boolean {
    return this.delivered.get(sessionId)?.has(bundleId.toLowerCase()) === true;
  }

  mark(sessionId: string, bundleId: string): void {
    let s = this.delivered.get(sessionId);
    if (s === undefined) { s = new Set(); this.delivered.set(sessionId, s); }
    s.add(bundleId.toLowerCase());
  }

  clearSession(sessionId: string): void {
    this.delivered.delete(sessionId);
  }

  /** The hub observer: a main-thread compaction forgets what that session's model saw. */
  observe(event: SessionEvent): void {
    if (event.type !== "continuity_warning") return;
    const e = event as { warning?: string; threadId?: string; sessionId: string };
    if (e.warning !== "compacted") return;
    if (e.threadId !== undefined && e.threadId !== "main") return;
    this.clearSession(e.sessionId);
  }
}
