// CC AskUserQuestion parity: `notes` carries optional free-text notes keyed by question text
// (mirrors QuestionResolvedEvent.notes / AskUserRespondParams.notes, protocol/src/{events,methods}.ts).
// Optional/additive — omitted entirely (not just undefined) when no notes were given, so existing
// callers/tests comparing the resolved outcome by equality are unaffected.
export type AskOutcome = { answers: Record<string, string>; notes?: Record<string, string>; by: string } | { timedOut: true };

/** In-flight ask_user questions, keyed by sessionId+callId. First response wins (mirrors ApprovalBroker). */
export class QuestionBroker {
  private pending = new Map<string, { resolve: (o: AskOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  private key(sessionId: string, callId: string): string { return `${sessionId}:${callId}`; }

  wait(sessionId: string, callId: string, timeoutMs: number): Promise<AskOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, callId);
      const timer = setTimeout(() => { this.pending.delete(k); resolve({ timedOut: true }); }, timeoutMs);
      this.pending.set(k, { resolve, timer });
    });
  }

  /** Is this question still waiting for an answer? (The Winter island lists only what is.) */
  isPending(sessionId: string, callId: string): boolean {
    return this.pending.has(this.key(sessionId, callId));
  }

  respond(sessionId: string, callId: string, answers: Record<string, string>, by: string, notes?: Record<string, string>): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, callId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve(notes ? { answers, notes, by } : { answers, by });
    return { ok: true, alreadyResolved: false };
  }
}
