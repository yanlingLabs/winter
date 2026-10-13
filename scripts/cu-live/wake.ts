// The live suite's group `wake` (ComputerV2 wake triggers, the app half): a trigger armed on the fixture's Submit
// button, the USER's click on it, and the session woken — judged from the outside: the fixture's own log (the click
// landed), the helper's on-screen windows (its ring and pill were drawn while the fixture was in front, and went with
// the trigger), and the session's own events (the `computer-wake` turn, its text fencing what came from the screen).
// And the converse: Winter's own click on the watched button never wakes the session.
//
// The user's click is a REAL click (it moves the pointer, and back) from the live-test helper — `test.userClick`, which
// exists only on a live-test instance, stamped so that only a live-test instance's watches count it as the user's (the
// suite's runner has no Accessibility grant of its own, and must never ask for one). Data plus assertions; `run.ts`
// drives it (`Scenario.wake`).
import { COMPUTER_WAKE_CLIENT_NAME } from "../../packages/core/src/computer-use/wakes/types";
import { check, eventsSince, type Check } from "./lib";
import type { Scenario, VerifyContext } from "./scenarios";

/** What the runner saw of a wake: the ring's windows while armed, the user's click, the wake turn's message. */
export interface WakeObservation {
  /** NEW on-screen windows of the helper once the fixture was in front (the ring and the pill: 2). */
  ringWindows?: number;
  /** When fewer than 2 were counted: the fixture's own windows on screen then, front first (`onScreenSummary`) — a
   *  window over the watched one hides the ring (the full run's flake: the window macOS attaches to a captured one). */
  fixtureWindows?: string;
  /** Those windows were gone again after the trigger ended. */
  ringGone?: boolean;
  /** The live-test helper found the element and posted the click. */
  clicked?: boolean;
  /** The wake turn's `user_message` (`clientName: computer-wake`): its text, and how long after the click it came. */
  message?: string;
  clientName?: string;
  ms?: number;
  /** The scenario's cleanup turn ran and reported `cancelled: true`. */
  cleanedUp?: boolean;
  /** When the user switched to the fixture, when their click was done, and when the observation ended (the focus and
   *  pointer checks across the wake turn). */
  switchedAt?: number;
  clickEndAt?: number;
  endAt?: number;
}

/** The live-test helper's route for the user's click (PROTOCOL.md §9). */
export const USER_CLICK_METHOD = "test.userClick";
/** How long the runner waits for the wake after the user's click (the coalescing second, the delivery, a margin). */
export const WAKE_WITHIN_MS = 15_000;
/** How long the converse waits to be sure no wake comes. */
export const NO_WAKE_MS = 4_000;

/** `cu-live-tool windows <owner>`'s lines → the ids of the windows on screen. */
export function onScreenIds(stdout: string): Set<number> {
  return new Set(stdout.split("\n").flatMap((l) => {
    try {
      const w = JSON.parse(l) as { id?: unknown; onScreen?: unknown };
      return typeof w.id === "number" && w.onScreen === true ? [w.id] : [];
    } catch { return []; }
  }));
}

/** `cu-live-tool windows <owner>`'s lines → the windows on screen, front first, as "id L<layer> <w>×<h>". */
export function onScreenSummary(stdout: string): string {
  return stdout.split("\n").flatMap((l) => {
    try {
      const w = JSON.parse(l) as { id?: unknown; layer?: unknown; onScreen?: unknown; bounds?: unknown };
      if (typeof w.id !== "number" || w.onScreen !== true) return [];
      const b = Array.isArray(w.bounds) ? w.bounds as unknown[] : [];
      return [`${w.id} L${String(w.layer ?? "?")} ${String(b[2] ?? "?")}×${String(b[3] ?? "?")}`];
    } catch { return []; }
  }).join(", ");
}

const armedId = (ctx: VerifyContext): unknown => ctx.facts.armed;

/** The ring check's detail: how many were counted, and what of the fixture's was on screen when too few were. */
const ringDetail = (w: WakeObservation | undefined): string =>
  `${w?.ringWindows ?? 0} new helper window(s) on screen${w?.fixtureWindows === undefined ? "" : ` — the fixture's windows then, front first: ${w.fixtureWindows || "none"}`}`;
const WAKE_ID = /^wk_[0-9a-f]{12}$/;

export function wakeFiredChecks(ctx: VerifyContext): Check[] {
  const w = ctx.wake;
  const id = armedId(ctx);
  const msg = w?.message ?? "";
  return [
    check("the trigger was armed on Submit", !ctx.isError && typeof id === "string" && WAKE_ID.test(id), ctx.output.slice(-300)),
    check("the ring and the pill were drawn while the fixture was in front", (w?.ringWindows ?? 0) >= 2, ringDetail(w)),
    check("the user's click reached Submit (the fixture's own log)", w?.clicked === true
      && eventsSince(ctx.events, ctx.since, "button").some((e) => e.id === "submit"), w?.clicked === true ? "no button submit event" : "the helper found no Submit to click"),
    check("the session was woken by a computer-wake turn", w?.clientName === COMPUTER_WAKE_CLIENT_NAME && msg.includes("<computer-wake>"),
      w?.message === undefined ? "no wake message" : msg.slice(0, 300)),
    check("the wake names the trigger and says the user clicked", typeof id === "string" && msg.includes(id) && /fired/.test(msg) && /clicked/.test(msg), msg.slice(0, 300)),
    check("what came from the screen is fenced in the wake", /<screen-data id="[^"]+">/.test(msg), msg.slice(0, 300)),
    check("the ring and the pill went with the trigger", w?.ringGone === true,
      (w?.ringWindows ?? 0) === 0 ? "never drawn, so not judged" : "still on screen after the wake"),
  ];
}

export function noWakeChecks(ctx: VerifyContext): Check[] {
  const id = armedId(ctx);
  const w = ctx.wake;
  return [
    check("the trigger was armed on Submit", !ctx.isError && typeof id === "string" && WAKE_ID.test(id), ctx.output.slice(-300)),
    check("the ring and the pill were drawn while the fixture was in front", (w?.ringWindows ?? 0) >= 2, ringDetail(w)),
    check("a real click carrying Winter's own mark reached Submit (the fixture's own log)", w?.clicked === true
      && eventsSince(ctx.events, ctx.since, "button").some((e) => e.id === "submit"), w?.clicked === true ? "no button submit event" : "the helper found no Submit to click"),
    check("Winter's own click never woke the session", w !== undefined && w.message === undefined, (w?.message ?? "").slice(0, 300)),
    check("the trigger was cancelled afterwards, and its ring went with it", w?.cleanedUp === true && w.ringGone === true,
      // A ring never counted is not judged gone or kept (the full run's report said "still on screen" of an empty list).
      `cleanup ${w?.cleanedUp === true ? "ran" : "failed"}, ring ${(w?.ringWindows ?? 0) === 0 ? "never drawn, so not judged" : w?.ringGone === true ? "gone" : "still on screen"}`),
  ];
}

export const WAKE_SCENARIOS: Scenario[] = [
  {
    name: "wake: the user's click on Submit wakes the session", group: "wake", session: "fresh",
    code: `
const form = await win("Fixture Form");
const submit = await pick(form, "Submit", "button");
const w = await form.wakeWhen({ clicked: submit.ref }, { note: "cu-live: continue once Submit is clicked" });
report({ armed: w.id });
`,
    wake: { userClicks: "Submit", window: "Fixture Form", withinMs: WAKE_WITHIN_MS },
    verify: wakeFiredChecks,
  },
  {
    // A REAL click that reaches the tap, carrying Winter's own mark (review L7: an accessibility press sends no mouse
    // event at all, so it proved nothing): the watch must ignore it. The cleanup turn cancels the trigger.
    name: "wake: a click carrying Winter's own mark never wakes the session", group: "wake", session: "fresh",
    code: `
const form = await win("Fixture Form");
const submit = await pick(form, "Submit", "button");
var WAKE_CONVERSE = await form.wakeWhen({ clicked: submit.ref });
report({ armed: WAKE_CONVERSE.id });
`,
    wake: { userClicks: "Submit", window: "Fixture Form", stamp: "winter", withinMs: NO_WAKE_MS, cleanup: "await WAKE_CONVERSE.cancel();\nreport({ cancelled: true });" },
    verify: noWakeChecks,
  },
];
