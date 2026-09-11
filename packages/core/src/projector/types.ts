import type { SdkMessage as ProtocolSdkMessage } from "@yanlinglabs/winter-agent-sdk";
import type { RuntimeKind } from "@yanlinglabs/winter-runtime-sdk";
import type { NewSessionEvent, SessionEvent } from "@norma/protocol";

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

export interface ProjectorDeps {
  /** The NORMA session id every produced event is stamped with. */
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
  /** Checkpoint key's generation (the record's incarnation counter). Defaults to 1. */
  generation?: number;
  /** Recorded on the cursor row. Defaults to `"winter-agent"`. */
  runtimeKind?: RuntimeKind;
}

export interface Projector {
  /** Fold one wire message into zero or more `SessionEvent`s, in emission order. */
  accept(msg: ProtocolSdkMessage): SessionEvent[];
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
}

/** The event the projector produces, before `seq`/`ts` are stamped. The protocol's own
 *  distributive Omit — a plain `Omit` over a union collapses it to the shared keys. */
export type ProjectedEvent = NewSessionEvent;
