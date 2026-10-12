// ComputerV2 — WAKE TRIGGERS: the pinned shapes shared by the daemon's registry (`wakes/registry.ts`), the browser
// backend (the engine, its page runtime and Winter for Chrome) and the app backend (the Winter Computer Use helper).
// Changes only through the controller.
//
// A script arms a trigger on a bound target — `await tab.wakeWhen({ clicked: ref }, { note })` — and the turn ends. The
// trigger outlives the script and the turn. When the USER does what it waits for (never Winter's own input), the daemon
// wakes the session with one daemon-written message (client name `computer-wake`), and the model resumes its work.
// One-shot: an event ends the trigger. Pure types: imported by the daemon only, never by the sandboxed worker.

/** What a trigger waits for: exactly one condition. The public grammar mirrors `waitFor`'s where it overlaps. */
export type WakeCondition =
  /** The user clicks this element (or something inside it). */
  | { kind: "clicked"; ref: string }
  /** Tabs only: the user submits this form (or, without `ref`, any form of the page). */
  | { kind: "submitted"; ref?: string }
  /** Tabs only: the top-level URL changes — to one containing `url`, when given. A same-document change counts. */
  | { kind: "navigated"; url?: string }
  /** This text comes to be shown in the target. */
  | { kind: "appeared"; text: string }
  /** This element, or this text, is no longer shown. */
  | { kind: "gone"; ref?: string; text?: string }
  /** The user changes this field's value; fires once it has stopped changing for `settleMs`. */
  | { kind: "changed"; ref: string; settleMs: number }
  /** The window's or tab's title comes to contain `title`. */
  | { kind: "titled"; title: string };

export type WakeConditionKind = WakeCondition["kind"];

/** The conditions only a tab can watch. */
export const TAB_ONLY_WAKE_KINDS: ReadonlySet<WakeConditionKind> = new Set(["submitted", "navigated"]);

/** What the registry asks a backend to arm. */
export interface WakeArmRequest {
  /** `wk_<12 hex>`, minted by the registry. */
  wakeId: string;
  sessionId: string;
  /** The bound target: an app target id, or a tab binding's `bt_…` id. */
  targetId: string;
  condition: WakeCondition;
  /** Epoch ms. The registry expires the trigger; a backend may use it to bound its own resources. */
  expiresAt: number;
}

/** What a backend answers once armed. Every string here is SCREEN-DERIVED, so the daemon fences it for the model. */
export interface WakeArmed {
  /** The watched element as the user sees it — role and accessible name (redacted by the same rules as `state()`). */
  element?: { role: string; name: string };
  /** The target as the user sees it: "Chrome — Developer Dashboard", "Mail — Inbox" (titles redacted as in state). */
  targetLabel: string;
  /** How the model gets the target back after the wake (its worker may have restarted): `browsers.tab("…")`,
   *  `apps.bind("com.apple.mail")`. Daemon-written, not screen text. */
  rebind: string;
}

/** How a trigger ended. `fired` and `lost` come from a backend; the rest from the registry. */
export type WakeEndReason =
  | "fired"
  /** The target went: the tab closed, the app quit, the window closed, or (for a ref) the page changed under it. */
  | "lost"
  | "expired"
  /** The model (`wake.cancel()`/`wakes.cancel(id)`) or the user (the Mac's pill). */
  | "cancelled"
  /** The daemon stopped while it was armed; reported at the next boot. */
  | "restart"
  /** `computerUse.wakes` or `computerUse.enabled` turned off, or the session archived or deleted. */
  | "disabled";

/** A backend's report of the one event that ends a trigger. */
export interface WakeBackendEvent {
  wakeId: string;
  outcome: "fired" | "lost";
  /** Epoch ms of the user's action (or of the loss). */
  at: number;
  /** fired: what happened, in a few words — "clicked", "submitted the form", "now at <redacted url>", "appeared",
   *  "gone", "changed", "title now “…”". Never a value the user typed, never coordinates. Screen-derived: fenced. */
  detail?: string;
  /** lost: why, in the backend's own words ("the tab was closed", "the app quit", "the page changed"). */
  reason?: string;
}

/**
 * One backend per target kind: the browser engine for tab bindings, the helper for apps. Rules every backend keeps:
 *  - ONLY THE USER'S INPUT COUNTS: hardware input (apps) or a trusted DOM event (tabs) — never an event caused by any
 *    Winter session's own input to that target while it is being sent and for 500 ms after;
 *  - privacy: nothing the user typed, no coordinates, no screen text beyond `WakeArmed`'s labels and `detail`;
 *  - the floors: a secure field (or one inside a secure or payment frame) is never watched (`Refused`), a headless tab
 *    never (`NotAllowed`), a site behind the dangerous-domain floor never;
 *  - while armed, the user can SEE that Winter waits there (a ring and a pill on the page or around the element);
 *  - `arm` throws an `AutomationFailure` (`StaleRef`, `NotAllowed`, `Refused`, `TargetLost`, `TargetBusy`,
 *    `BrowserUnavailable`, `HelperUnavailable`) with its one actionable sentence, and arms nothing then.
 */
export interface WakeBackend {
  arm(req: WakeArmRequest, onEvent: (e: WakeBackendEvent) => void): Promise<WakeArmed>;
  /** Disarms. Idempotent, never throws; after the trigger's event it is a no-op. */
  disarm(wakeId: string): void;
}

/** The registry's limits and defaults (one place). */
export const WAKE_LIMITS = {
  perSession: 8,
  perDaemon: 32,
  defaultTimeoutMs: 60 * 60_000,
  maxTimeoutMs: 8 * 60 * 60_000,
  noteMaxChars: 500,
  /** `changed`'s default quiet period before it fires. */
  defaultSettleMs: 1_500,
  /** Events within this long of each other, for one session, are delivered as ONE wake message. */
  coalesceMs: 1_000,
  /** How long after Winter's own input to a target an event there is still taken as Winter's. */
  ownInputGraceMs: 500,
} as const;

/** The `user_message` client name a wake turn carries (`sessions/turn-origins.ts`'s automated origins include it). */
export const COMPUTER_WAKE_CLIENT_NAME = "computer-wake";
