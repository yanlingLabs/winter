import type { CoworkSchedule, CoworkScheduleOccurrence } from "@yanlinglabs/winter-protocol";
import type { CapabilityCeiling } from "./types";

/*
 * Schedule dispatch boundary (types only).
 *
 * SOURCE ONLY. This module has no runtime code, no barrel export and NO production implementation of
 * CoworkScheduleDispatchPort: schedules.ts imports it with `import type` (erased at runtime), and the
 * daemon/service construct CoworkSchedules without a port, so production `beginDispatch` stays refused
 * with `unsupported_topology` and the RPC keeps reporting `execution: "unavailable"`. A fake port in a test
 * proves the host's durable state machine; it never proves that any work ran, a guest woke or a VM booted.
 *
 * The host owns the state machine (pending -> claimed -> dispatching -> handled | uncertain). The port only
 * answers "did you start this?" and can never write schedule state.
 */

/** Everything a port may act on. Built from typed protocol records, never raw rows; the occurrence is already durable as `dispatching`. */
export interface CoworkScheduleDispatchInput {
  readonly schedule: CoworkSchedule;
  readonly occurrence: CoworkScheduleOccurrence;
  /** Current grants intersected with the schedule's saved ceiling, recomputed in the same transaction that flipped to `dispatching`. */
  readonly effective: CapabilityCeiling;
}

/**
 * The port's acknowledgement. It must echo the occurrence and the claim token it was handed; `runRef` is an
 * opaque identifier of the started work. The host can check the echo only: whether the port really started
 * anything is the port's responsibility, and is not proven by this record. Receipts are not persisted.
 */
export interface CoworkScheduleStartReceipt { readonly occurrenceId: string; readonly token: string; readonly runRef: string }

/**
 * `started`: the work was launched and is acknowledged. `uncertain`: the port cannot say whether anything
 * launched (a timeout after the request left, a lost transport). Those are the ONLY two ways to report that
 * an effect may exist.
 */
export type CoworkScheduleStartResult = { readonly kind: "started"; readonly receipt: CoworkScheduleStartReceipt } | { readonly kind: "uncertain" };

export interface CoworkScheduleDispatchPort {
  /**
   * Launch the occurrence exactly once for this claim token. THROWING OR REJECTING ASSERTS THAT NOTHING WAS
   * LAUNCHED: the host then returns the occurrence to `pending` (`execution_unavailable`) and a later claim may
   * call `start` again with a fresh token. A port that cannot prove that must resolve `{ kind: "uncertain" }`
   * instead, never throw. Called outside every database transaction, after `dispatching` is durable.
   */
  start(occurrence: CoworkScheduleDispatchInput, token: string): CoworkScheduleStartResult | Promise<CoworkScheduleStartResult>;
}

/**
 * Host-issued proof that the port acknowledged this occurrence's claim in this process. Only
 * CoworkSchedules.beginDispatch can mint one (it is tracked in a private WeakMap, so a structurally similar
 * object is refused) and it is consumed by the one `handled` call it authorizes.
 */
export interface CoworkScheduleDispatchReceipt { readonly occurrenceId: string; readonly runRef: string }

/**
 * - `started`: durable `dispatching`, port acknowledged; the host awaits `handled` or `uncertain`.
 * - `blocked`: the begin-time recheck refused; the claim went back to `pending` carrying `reason`; the port was not called.
 * - `not_started`: the port threw, asserting nothing launched; back to `pending` with `execution_unavailable`.
 * - `uncertain`: an effect may exist; durable `uncertain`/`recovery_required` (also when cancel or recovery got there first). Never replayed.
 */
export type CoworkScheduleDispatchOutcome =
  | { readonly status: "started"; readonly receipt: CoworkScheduleDispatchReceipt }
  | { readonly status: "blocked"; readonly reason: NonNullable<CoworkScheduleOccurrence["reason"]> }
  | { readonly status: "not_started" }
  | { readonly status: "uncertain" };
