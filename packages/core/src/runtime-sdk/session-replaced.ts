// `session_replaced`: a send (or steer, or a SendMessage delivery) joined an incarnation that was still
// OPENING when its driver was ended -- evicted (a credential or policy change, a model switch), deleted, or
// the daemon stopping. That open spawned nothing and appended nothing (`WinterSession.end`), so the message
// was never taken. The session itself is fine: its NEXT driver takes the message.
//
// Every door that sends retries ONCE on the session's next driver (`ipc/server.ts`'s `session.send` /
// `session.steer`, `agent/session-messaging.ts`'s delivery), so a client never sees this in the normal case.
// If it escapes anyway, it is a typed, RETRYABLE refusal (`ERR.RETRY` + `data.code: "session_replaced"`,
// `data.retryable: true` on the RPC; `retryable: true` on a SendMessage answer) -- never an internal error.

export const SESSION_REPLACED = "session_replaced";

/** Whether `err` is the `session_replaced` refusal (a `WinterLegRefusal`, or anything carrying its code). */
export function isSessionReplaced(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === SESSION_REPLACED;
}

/**
 * Run `send` on `first`; if it was refused `session_replaced`, run it ONCE more on the session's next driver
 * (`next()` -- `get ?? ensure`). A second `session_replaced`, or no different driver to retry on, rethrows.
 */
export async function withReplacementRetry<D, T>(first: D, next: () => Promise<D | undefined>, send: (driver: D) => Promise<T>): Promise<T> {
  try {
    return await send(first);
  } catch (err) {
    if (!isSessionReplaced(err)) throw err;
    const successor = await next();
    if (successor === undefined || successor === first) throw err;
    return await send(successor);
  }
}
