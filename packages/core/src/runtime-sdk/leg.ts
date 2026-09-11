import type { Settings } from "../settings";
import type { Mode as SessionMode } from "../agent/tools/registry";

/** Which engine a session runs on. Recorded at CREATION and never re-read: P8b-13's flag governs
 *  NEW sessions only, so a session runs to completion on the leg it was born on even if the setting
 *  flips mid-flight. */
export type SessionLeg = "engine" | "winter";

/** The shape Task 15 adds under `settings.runtimes`. Declared structurally here rather than
 *  imported, because the zod block does not carry `winterLeg` yet and this lane must not edit the
 *  settings schema (Task 15 owns it). When Task 15 lands, this cast becomes redundant but stays
 *  correct — the field names are pinned by the Interfaces block on both sides. */
type RuntimesWithLeg = { winterLeg?: Partial<Record<SessionMode, boolean>> } | undefined;

/**
 * **The leg a NEW session of this mode is created on** (P8b-13).
 *
 * Reads `settings.runtimes.winterLeg.<mode>` and defaults to `"engine"` — for an absent `runtimes`
 * block, an absent `winterLeg`, an absent per-mode key, and any value that is not literally `true`.
 * That default is the safety property of the whole phase: `settings.runtimes` is `.optional()` (it
 * is a top-level key like every other, deliberately not defaulted so `saveSettings` never stamps
 * today's values into every user's file), so **every existing install and every hand-built settings
 * literal in the codebase has no `runtimes` block at all** — and each must keep running on the
 * engine until a human turns a flag on.
 *
 * `=== true` rather than truthiness: a settings file hand-edited to `"yes"` or `1` must not move a
 * user's sessions onto a leg they did not ask for.
 */
export function legForNewSession(mode: SessionMode, settings: Settings | undefined): SessionLeg {
  const runtimes = settings?.runtimes as RuntimesWithLeg;
  return runtimes?.winterLeg?.[mode] === true ? "winter" : "engine";
}
