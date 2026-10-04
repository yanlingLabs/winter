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
  /**
   * The session's to-do rows as already persisted (its folded `task_updated` history), read ONCE,
   * lazily, the first time a `TaskCreate`/`TaskUpdate` result resolves. A projector lives for one
   * child incarnation, so without this a `TaskUpdate` after a respawn (idle eviction, credential
   * swap, resume) would find no tracked row and be dropped. Absent → start empty.
   */
  priorTodos?: () => readonly { id: string; subject: string; status: string; activeForm?: string }[];
  /**
   * 2026-09-22 (C2): the child has produced a `tool_result` for these call ids (any thread), so
   * nothing may still be waiting on a HUMAN for them — an approval card or a question for such a call
   * is moot. Called BEFORE the frame's events are stamped, so whatever the driver appends here (the
   * bridge's `approval_resolved`/`question_resolved` withdrawal) lands ahead of the `tool_result`
   * and the stamped seqs stay exact.
   *
   * WHY IT EXISTS: an interrupt abandons a pending permission request inside the Winter child (agent
   * SDK 0.0.17 `engine.ts`'s `raceInterrupt` around `evaluateWithFreshPolicy`) WITHOUT cancelling the
   * host's `canUseTool` — the SDK has no `control_cancel_request` (claude's CLI sends one and the
   * claude SDK aborts the callback's signal) — so the card stayed pending forever. The child's own
   * padded `[interrupted]` result is the one fact on the wire that says it gave up.
   *
   * Called on a replayed prefix too (harmless: nothing is pending then). A throw is swallowed.
   */
  onToolResults?: (callIds: readonly string[]) => void;
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
   * ── A MID-TURN PUSH IS FOLDED INTO THE RUNNING TURN, OR IS THE NEXT TURN ───────────────────
   *
   * MEASURED (P8b-38, `test/projector/real-child.test.ts`'s steer measurement against the built
   * binary): up to agent SDK 0.0.43 a push made while a turn runs — a `steer`, a messaging delivery —
   * yields its OWN `result`, because the child queues it as its next envelope. Since 0.0.44 (user ruling
   * 2026-10-04, "fold the message into the running turn") the child FOLDS every pending push into the
   * running turn at its next tool round — claude's behaviour — and says so on the stream
   * (`system/host_input_folded`, `count` = its N earliest pending pushes): those pushes never get a
   * `result`, and the running turn's ONE terminal closes them. A push still pending when the running
   * turn ends (no tool round left) is still its own next turn with its own `result`. So the driver calls
   * `beginTurn` for every push, a steer included, and the rule is "ONE `result` per begun turn that was
   * not folded".
   *
   * Since C2 (2026-09-22) such a push's `turn_started` is NOT returned here: it is held until the child
   * takes the push up — announced by the fold frame (mid-turn: the message joins the running turn), or
   * right after the running turn's `turn_completed` (it is the next turn) — or earlier through
   * `announceQueuedTurns`. Whether "a turn is running" is the projector's own push count (`openTurns`),
   * so the hold rests on the child accounting for every push: a `result`, or a place in a fold's
   * `count`. A child that silently absorbed a push (claude, the retired official leg) would leave its
   * `turn_started` waiting for a terminal that never comes; the official leg never holds.
   */
  beginTurn(input: { text: string; at?: string }): ProjectedBatch;
  /**
   * TaskStop (user ruling 2026-10-04): the child dropped `count` pending pushes before they ran (agent
   * SDK 0.0.44 `Query.clearQueuedInput`). They leave the held queue from its TAIL (the head may already
   * have started, if the running turn ended while the clear was in flight) and are no longer owed a
   * terminal. Returns the `turn_started` of each that was still unannounced — appended NOW, while those
   * pushes are still the youngest messages in the log (the adjacency pairing) — and how many left; the
   * DRIVER closes each with an `aborted` `turn_completed` once the stopped turn has ended.
   */
  clearQueued(count: number): { batch: ProjectedBatch; cleared: number };
  /** The pushes still held (C2), oldest first, and whether each one's `turn_started` is out — a copy.
   *  The driver snapshots it when it SENDS a clear (TaskStop), to close exactly what the clear dropped. */
  readonly pendingPushes: readonly { announced: boolean }[];
  /**
   * 2026-09-22 (C2): announce NOW every push whose `turn_started` `beginTurn` is still holding.
   *
   * On the Winter leg a push made while one of the host's turns is still open (a steer, a delivery,
   * a held send released at a `result` while a steer runs) returns NO `turn_started` from `beginTurn`:
   * the child holds it pending, so it is announced when the child takes it up — folded into the running
   * turn (0.0.44's `host_input_folded`) or right after the running turn's `turn_completed`, one per
   * terminal — the log's turn boundaries in the order they happen.
   *
   * The durable queue's adjacency pairing (`winter-session.ts`'s `unconsumedUserMessages`: a
   * `turn_started` pairs with the NEAREST PRECEDING unpaired `user_message`) needs a pushed message
   * and its `turn_started` never to be separated by a YOUNGER `user_message`. So the driver calls this
   * before it appends any `user_message`: a push still unannounced at that moment is announced there
   * (the order then degrades to the pre-C2 shape for that one push, and the pairing stays exact).
   * Idempotent; empty when nothing is held.
   */
  announceQueuedTurns(): ProjectedBatch;
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
