// M3 (review r1): the barrel exports BOTH `SdkMessage` (the narrow
// `Extract<…, system|assistant|result>` from `query.js`) and `SdkMessage as ProtocolSdkMessage`
// (the WIRE union from `protocol/frames.js`). Importing the first and renaming it to the second's
// name is precisely the trap G-8 / ruling P8b-8 exists to prevent: the declared contract then says
// `user` and `stream_event` frames cannot occur, while the runtime yields both. Import the real one.
import type { ProtocolSdkMessage } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeKind } from "@yanlinglabs/winter-runtime-sdk";
import type { NewSessionEvent, SessionEvent } from "@yanlinglabs/winter-protocol";

export type { ProtocolSdkMessage };

/** `code` | `dispatch` | `chat` — the same three the session store records (`sessions/store.ts`). */
export type SessionMode = "code" | "dispatch" | "chat";

/** The projector's logging surface. Structural and tiny on purpose: `packages/core` has no Logger
 *  type, every module logs through `console`, and a projector that took one would drag a new
 *  dependency into the one module the Winter leg cannot do without. Nothing here is ever handed
 *  opaque provider state, a credential, or a `reasoning_item` — see `logSkipped`. */
export interface Logger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** The (session, generation, source) triple 8a's `ProjectionCheckpoints` is keyed by. */
export interface ProjectionKey { winterSessionId: string; generation: number; sourceId: string }

/** The cursor half of a `complete`. Mirrors 8a's `ProjectionCursorInput`. */
export interface ProjectionCursorInput {
  runtimeKind: RuntimeKind;
  backendSessionId?: string;
  backendCursor: string;
  lastWinterSeq: number;
  sourceDigest?: string;
}

/**
 * The idempotency door the projector needs, expressed as the STRUCTURAL SUBSET it actually calls.
 *
 * 8a's concrete class is `runtime-state/checkpoints.ts`'s **`ProjectionCheckpoints`** (not
 * `CheckpointStore` — the plan's Interfaces block predates the code) and it satisfies this
 * interface as written, so `createProjector({ checkpoint: new ProjectionCheckpoints(db) })` type-
 * checks with no adapter. Declaring the subset rather than importing the class is what lets a test
 * hand in a counting fake without opening a SQLite file, and keeps `projector/` free of a
 * `runtime-state` import it would otherwise never use.
 */
export interface CheckpointStore {
  begin(key: ProjectionKey): "begun" | "already-committed" | "pending-elsewhere";
  complete(key: ProjectionKey, cursor: ProjectionCursorInput, seqs: { first: number; last: number }): unknown;
}

/**
 * A projection this projector DECLINED to make, surfaced instead of dropped (controller answer to
 * Task 10 concern 8). Today there is one reason: `pending-elsewhere` — a mark is open for the
 * source, so another projector holds it or one died between its append and its commit, and
 * re-projecting could double-append. Only 8a's recovery sweep can read the product log's tail and
 * decide, so the projector declines and says so. Task 16 surfaces these.
 */
export interface ProjectorRefusal {
  reason: "pending-elsewhere";
  sourceId: string;
  sessionId: string;
  winterSessionId: string;
  generation: number;
  at: string;
}

/**
 * The projector REFUSED to project a source, and says so by throwing (M2, review r1).
 *
 * A `pending-elsewhere` verdict means a mark is open for this source: another projector holds it,
 * or one died between its append and its commit. Re-projecting could double-append; not projecting
 * silently loses a tool call. Only 8a's recovery sweep (`pending()` + `resolvePending`) can read the
 * product log's tail and decide, so the projector refuses LOUDLY — an empty array would be
 * indistinguishable from "this message produced nothing", which is how a mis-wire stays invisible.
 *
 * **The driver's obligation (Task 16): run the 8a recovery sweep BEFORE constructing a projector for
 * a session.** A driver that would rather degrade than fail may catch this and continue; what it may
 * not do is never find out.
 */
export class ProjectorRefusedError extends Error {
  readonly code = "projector_refused" as const;
  constructor(
    readonly reason: "pending-elsewhere",
    readonly sourceId: string,
    readonly sessionId: string,
    readonly winterSessionId: string,
    readonly generation: number,
  ) {
    super(`projector refused ${sourceId} for ${winterSessionId}/${generation} (${reason}) — run the runtime-state recovery sweep before projecting this session`);
    this.name = "ProjectorRefusedError";
  }
}

export interface ProjectorDeps {
  /** The WINTER session id every produced event is stamped with. */
  sessionId: string;
  mode: SessionMode;
  /** The store's next sequence number. Called once per PERSISTED event; transients never consume one. */
  nextSeq: () => number;
  checkpoint: CheckpointStore;
  /** ISO string for the event's `ts`. */
  now: () => string;
  log: Logger;
  /** Checkpoint key's session id. Defaults to `sessionId` — set it when the runtime record's
   *  `winterSessionId` differs from the product session id. */
  winterSessionId?: string;
  /**
   * The 8a record's generation — the session's incarnation counter, and half of every checkpoint
   * key. **REQUIRED (M2, review r1), and a resume MUST bump it.**
   *
   * Three of the five source-id forms are POSITIONAL (`as:<turn>:<round>`, `um:<turn>:<round>`,
   * `rs:<backend>:<turn>`) and every counter restarts at 0 in a fresh projector. A resume that
   * re-used the previous generation would therefore replay its first frames straight into
   * `already-committed` and project nothing — a silent transcript hole on the resume path, in the
   * one component whose whole job is not to lose events. An optional field defaulting to `1` made
   * that a forgettable caller detail; a required one makes it a decision at every call site.
   */
  generation: number;
  /** Recorded on the cursor row. Defaults to `"winter-agent"`. */
  runtimeKind?: RuntimeKind;
  /** Called for every refusal, in addition to `Projector.refusals` and a warn log. A throw from
   *  this handler is swallowed — a driver's own bookkeeping must never break the fold. */
  onRefusal?: (refusal: ProjectorRefusal) => void;
}

/**
 * What a projector call produced, split by SINK (m5, review r1).
 *
 * The obligation "append this, but BROADCAST that one" used to live in a doc comment, and a caller
 * that appended everything would write an `assistant_delta` into the session JSONL — the exact
 * prose-contract failure class CLAUDE.md's transient section documents. The split is now in the
 * type, so the wrong sink is a compile error rather than a code review.
 *
 * `broadcast` holds ONLY transients (`TRANSIENT_EVENT_TYPES`). No single call ever returns both
 * non-empty — a frame produces either a transient or persisted events, never a mix — which is what
 * lets a caller that wants one ordered stream concatenate them safely. A test pins that.
 */
export interface ProjectedBatch {
  /** Append these to the session store, in order. */
  persist: SessionEvent[];
  /** Hand these to `hub.broadcastTransient`. NEVER append them. */
  broadcast: SessionEvent[];
  /**
   * Winter Phase 8c (P8c-11 / Task 2.2): a SIDE EFFECT for the driver to apply, distinct from both
   * sinks above — it names neither a `SessionEvent` to persist nor one to broadcast, it is an
   * instruction to the 8a runtime record. Chosen over a `records` hook on `ProjectorDeps` (the
   * brief's other option) because the projector already returns everything else it produces
   * through this ONE batch type, and a side-channel callback would be a second door for the exact
   * same "this call produced something the caller must act on" fact `refusals`/`onRefusal` already
   * models — see this field's producer, `asMirrorErrorFrame`, in `conversation.ts`.
   *
   * Set ONLY by a mirror-error frame on the official stream; absent on every ordinary batch. The
   * driver applies it via `runtime-state/records.ts`'s `setTranscriptHealth(winterSessionId,
   * "repair-required")` — the SAME call `recovery.ts`'s step-6 handoff check makes for the
   * out-of-band version of the same fact (WS-16 §13's "mirror row"). Wiring that call is the
   * driver's job (session-driver.ts, lane 1/controller), not the projector's: the projector never
   * touches `runtime-state` directly (see `CheckpointStore`'s own doc comment on why).
   */
  transcriptHealth?: "repair-required";
}

export interface Projector {
  /**
   * THE HOST→PROJECTOR TURN DOOR (M1, review r1). Called when the host pushes a user turn into the
   * prompt queue, AFTER it has appended its own `user_message` (P8b-5).
   *
   * It exists because the brief's terminal rule is PUSH-keyed — "a second `result` before a new
   * user push" — and a projector with no push input could only approximate it frame-keyed. The
   * approximation was wrong on the measured wire: a turn that emits no frame before its terminal
   * (the ordinary "user hits stop before the first token" path, and the second envelope of the
   * recorded tooluse run) was indistinguishable from a duplicate terminal, so its `turn_completed`
   * was dropped and the client's spinner hung forever with every unit test green.
   *
   * It returns the `turn_started` the host appends beside its `user_message` — **the host appends
   * THAT event and never synthesizes one of its own**, because two producers would write two rows
   * per turn into the session JSONL and, since `SUBAGENT_TRANSCRIPT_INCLUDE.turn_started` is
   * `true`, into every child's model-greppable transcript as well. It also records the pushed text
   * in the echo window, which is what makes `dedupe.ts` reachable at all.
   *
   * ── A MID-TURN STEER IS NOT A NEW BEGUN TURN ────────────────────────────────────────────────
   *
   * `session.send` and `session.steer` are both pushes into the same host-owned queue (P8b-5), but
   * they differ in exactly the way this door cares about: `send` starts a turn, while `steer` joins
   * the turn already running (the child drains it at its next round top). So the rule stays "ONE
   * `result` per begun turn", and **a steer must not call `beginTurn`** — under the current
   * understanding it produces no terminal of its own, and an extra `beginTurn` would leave
   * `openTurns` permanently >= 1, silently weakening the guard so a stray or duplicate `result` is
   * projected instead of dropped. It would also put a mid-turn `turn_started` in the log, which the
   * engine never emits.
   *
   * **THIS IS NOT MEASURED, AND IT IS A TASK 16 MEASUREMENT OBLIGATION.** Task 10's recording
   * deliberately gated its second envelope on the first `result` "so the turns stay separable", so
   * it says nothing about a mid-turn push. Drive a `steer` against the built binary and COUNT the
   * `result`s: if a steered-in message terminates on its own, the driver must call `beginTurn` for
   * the steer too — otherwise that terminal is dropped by the `openTurns === 0 && !sawFrame` guard
   * whenever the steer produced no frames first, which is the same defect this door was added to
   * fix, on the steer path.
   */
  beginTurn(input: { text: string; at?: string }): ProjectedBatch;
  /** Fold one wire message into zero or more `SessionEvent`s, in emission order. */
  accept(msg: ProtocolSdkMessage): ProjectedBatch;
  /** True between the first frame of a turn and its `result`. */
  readonly turnRunning: boolean;
  /** `ts` of the most recent terminal, or undefined before the first one. */
  readonly lastResultAt: string | undefined;
  /**
   * ADDED to the plan's Interfaces block (an addition, not a rename): commit the still-open
   * projection mark. `accept` commits the PREVIOUS message's mark, because only by then has the
   * caller had a chance to append what the previous call returned (8a's documented ordering is
   * begin → append → complete). The last message of a stream has no successor, so the driver calls
   * `flush()` once the iteration ends. Leaving it uncommitted is safe, not corrupt — the mark stays
   * `pending` and 8a's recovery sweep resolves it against the log tail — but it makes every
   * shutdown look like a crash.
   */
  flush(): void;
  /**
   * ADDED in Task 11 (an addition, not a rename): the door for an exception the driver's
   * `for await` caught. §4.8 item 3 — an error result is yielded AND THEN thrown, so a driver that
   * does not wrap its iteration gets an unhandled rejection. It wraps, hands the error here, and
   * gets back the terminal a turn that is still open needs (or `[]` when the turn already ended, or
   * when the throw is the "error-result-then-throw" pair of a result already projected).
   */
  acceptError(err: unknown): ProjectedBatch;
  /** Every projection this projector declined, in order. Never silently empty of a real refusal. */
  readonly refusals: readonly ProjectorRefusal[];
}

/** The event the projector produces, before `seq`/`ts` are stamped. The protocol's own
 *  distributive Omit — a plain `Omit` over a union collapses it to the shared keys. */
export type ProjectedEvent = NewSessionEvent;
