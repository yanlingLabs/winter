// ComputerV2 (2026-10-08) — the typed errors a script can catch, shared by the daemon (which decides them)
// and the automation worker (which exposes one class per kind as a global, so `e instanceof StaleRef`
// works). Pure: no I/O, imported by the sandboxed worker too.
//
// Each error carries ONE actionable sentence (spec §5) — written by the daemon, never by the helper's raw
// message alone, so the model always reads what to do next.

export const AUTOMATION_ERROR_KINDS = [
  "StaleRef",
  "TargetLost",
  "NoWindow",
  "TargetBusy",
  /** The action was sent but the app did not confirm it: it may have happened. Never retried automatically. */
  "Uncertain",
  "WaitTimeout",
  "NotAllowed",
  "Refused",
  "NeedsForeground",
  "HelperUnavailable",
  "PermissionMissing",
  "Cancelled",
] as const;

export type AutomationErrorKind = (typeof AUTOMATION_ERROR_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(AUTOMATION_ERROR_KINDS);
export const isAutomationErrorKind = (v: unknown): v is AutomationErrorKind => typeof v === "string" && KINDS.has(v);

/** A daemon-side primitive failure, carried to the worker as `{kind, message}` and thrown there as the
 *  matching class. `retryable` is informational (a `HelperUnavailable` the next call may cure). */
export class AutomationFailure extends Error {
  constructor(readonly kind: AutomationErrorKind, message: string, readonly retryable = false) {
    super(message);
    this.name = kind;
  }
}

export const isAutomationFailure = (e: unknown): e is AutomationFailure => e instanceof AutomationFailure;
