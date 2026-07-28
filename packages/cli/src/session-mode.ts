// Plan-immunity Task 2 (mode×surface matrix, ledger .superpowers/sdd/2026-07-28-plan-immunity/
// progress.md, USER DIRECTIVE 2026-07-28): code = TUI + macOS app + iOS app; chat/cowork = apps
// only; dispatch = apps + orb. The TUI/CLI is CODE-ONLY. `mode` is absent on every pre-existing
// session and every plain `session.create` call that doesn't pass one (the R-slice convention:
// absent = code) — `isCodeMode` below is the one predicate every surface in this package uses so
// that convention is never re-derived ad hoc.
//
// Two different session SURFACES need two different treatments of a non-code row, and conflating
// them was an explicit thing to avoid (see the task brief):
//   - a PICKER (the TUI's `/sessions`, and `norma resume` with no id) exists purely to choose a
//     session to attach/resume INTO — and attach unconditionally refuses non-code (below), so
//     showing a row here that would immediately be refused is the "shown-but-broken" shape this
//     slice keeps closing (same reasoning as Part B's orb-sidebar fix). These HIDE non-code rows
//     via `filterCodeSessions`.
//   - a LISTING (`norma sessions`) is a plain inventory — its job is to stay a truthful account of
//     every session that exists, chat/dispatch included, just visibly flagged as not-for-here. This
//     MARKS non-code rows via `sessionModeMarker` rather than hiding them.
//
// `nonCodeRefusalMessage` is the third piece: what attach/send/watch/resume print INSTEAD of
// performing the action when a session turns out to be non-code (reached even without the picker
// filters above — e.g. a stale/cached session id, or a plain `norma send <chatSessionId> ...`).
//
// CLIENT-SIDE ONLY: this is a product-surface rule among same-user local clients (TUI/CLI here,
// the Mac app, the orb) — NOT a security boundary. The daemon-side gate is reserved for the
// REMOTE role (packages/core/src/ipc/server.ts filters `mode==="chat"` out of `session.list` only
// for `socket.data.authedRole==="remote"`); nobody should later "simplify" these into one mechanism.

export function isCodeMode(mode?: string): boolean {
  return (mode ?? "code") === "code";
}

/** The picker filter — hides every row whose mode isn't code. Generic so callers keep whatever
 *  extra fields their row shape carries (scope/lastSeq/title/…). */
export function filterCodeSessions<T extends { mode?: string }>(rows: T[]): T[] {
  return rows.filter((r) => isCodeMode(r.mode));
}

/** `norma sessions`' inventory tag — "" for code, the spec's exact wording for chat/dispatch, and
 *  a generic "<mode> — app only" for cowork or any future/unknown mode so a new mode never falls
 *  through to a blank or stale-sounding marker. */
export function sessionModeMarker(mode?: string): string {
  if (isCodeMode(mode)) return "";
  const m = mode as string;
  if (m === "dispatch") return " [dispatch — orb/app only]";
  return ` [${m} — app only]`; // chat, cowork, and any future/unknown mode
}

/** Attach/send/watch/resume refusal text — distinct per mode (chat/dispatch get the spec's exact
 *  wording), with a generic apps-only fallback covering cowork and any future/unknown mode so this
 *  never needs a new branch as new modes are added. */
export function nonCodeRefusalMessage(mode: string): string {
  if (mode === "chat") return "chat sessions live in the Norma app";
  if (mode === "dispatch") return "dispatch lives in the orb and the app";
  return `${mode} sessions are app-only`; // cowork, and any future/unknown mode
}

/** Shared gate for the CLI's direct-attach surfaces (send/watch/resume's existingSessionId path):
 *  looks the target up by id (attach/send/watch don't otherwise learn `mode`) and either returns
 *  the found row or a message to print instead of proceeding. The not-found message is
 *  byte-identical to each call site's pre-existing "no such session: …" wording — this doesn't
 *  change that behavior, only adds the mode check alongside it. */
export function checkCodeSession<T extends { sessionId: string; mode?: string }>(
  rows: T[],
  sessionId: string,
): { ok: true; row: T } | { ok: false; message: string } {
  const row = rows.find((r) => r.sessionId === sessionId);
  if (!row) return { ok: false, message: `no such session: ${sessionId}` };
  if (!isCodeMode(row.mode)) return { ok: false, message: nonCodeRefusalMessage(row.mode ?? "code") };
  return { ok: true, row };
}
