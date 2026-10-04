// Which `user_message` started which turn — and so WHO started a session's running turn.
//
// A session's log carries the host's main-thread `user_message`s and the projector's `turn_started`s,
// but not which message each turn answers. `WinterSession` pushes in exactly two shapes:
//   - DIRECT: the message is appended and its turn begun at once (`send` on an idle child, `steer`, a
//     delivery) — its `turn_started` is the very next main-thread event after it;
//   - QUEUED: the message is appended while a turn runs and begun later, one per `result`, oldest first
//     (`pending`, P8b-5) — its `turn_started` comes after other events.
// So a `turn_started` that directly follows an unpaired message answers THAT message; any other answers
// the OLDEST unpaired one. That is the pairing this class replays, incrementally (DispatchChildren's
// observer) or over a whole log (`runningTurnOrigin`).
//
// CONTINUATION (agent SDK 0.0.44, user ruling 2026-10-04): a main `turn_started` that arrives while a main
// turn is OPEN on the log (a `turn_started` since the last `turn_completed`) is a message the child took
// INTO the running turn at its next tool round — or one C2 announced ahead of its turn, right before a
// younger message landed. Either way it pairs by ADJACENCY, like `unconsumedUserMessages`: with the
// NEAREST PRECEDING unpaired message, never the oldest — the driver announces any held push before the
// next message is appended (`appendUser`), so a pushed message is always the youngest unpaired one when
// its continuation lands, and a daemon-held `send` queued earlier keeps its own place. From then on the
// running turn's origin reads as the folded message's: a peer's message folded into a human turn makes
// it automated, the user's steer folded into Dispatch's turn makes it human.
import type { SessionEvent } from "@yanlinglabs/winter-protocol";

/** The projector's own pass-through `user_message` (it echoes the child's view; never a host push). */
const PROJECTOR_PASSTHROUGH_CLIENT = "winter";

export class TurnOriginPairer<T> {
  private readonly unpaired: T[] = [];
  private lastWasMessage = false;

  /** A main-thread host `user_message`, tagged. */
  message(tag: T): void {
    this.unpaired.push(tag);
    this.lastWasMessage = true;
  }

  /** A main-thread `turn_started`: the tag of the message it answers (undefined when none is owed).
   *  `continuation`: a main turn is open on the log (see the header) — it pairs by adjacency. */
  turnStarted(continuation = false): T | undefined {
    const tag = this.lastWasMessage || continuation ? this.unpaired.pop() : this.unpaired.shift();
    this.lastWasMessage = false;
    return tag;
  }

  /** Any other main-thread event. */
  other(): void {
    this.lastWasMessage = false;
  }

  get empty(): boolean {
    return this.unpaired.length === 0;
  }
}

/** The clientName of the message that started the session's LATEST turn, from its log (undefined: none). */
export function runningTurnOrigin(events: readonly SessionEvent[]): string | undefined {
  const pairer = new TurnOriginPairer<string>();
  let origin: string | undefined;
  let open = false;
  for (const e of events) {
    if ((e as { threadId?: string }).threadId !== "main") continue;
    if (e.type === "user_message") {
      if (e.clientName === PROJECTOR_PASSTHROUGH_CLIENT) continue;
      pairer.message(e.clientName ?? "session");
    } else if (e.type === "turn_started") {
      origin = pairer.turnStarted(open);
      open = true;
    } else {
      if (e.type === "turn_completed") open = false;
      pairer.other();
    }
  }
  return origin;
}

/** Turns started by the daemon on someone else's behalf — never "owned" by a terminal that merely
 *  attached to watch (`activity-enforcement.ts`): another session's SendMessage, Dispatch's spawn
 *  prompt and its own wake. */
export const AUTOMATED_TURN_ORIGINS: ReadonlySet<string> = new Set(["messaging", "dispatch", "dispatch-wake"]);

/** Was a turn of this origin started by a HUMAN — a known client's message (the Mac, the TUI, the phone, a
 *  client that named itself nothing, `"session"`) rather than one of `AUTOMATED_TURN_ORIGINS`? An unknown
 *  origin (`undefined`: no paired message) is NOT human. */
export function isHumanTurnOrigin(origin: string | undefined): boolean {
  return origin !== undefined && origin !== PROJECTOR_PASSTHROUGH_CLIENT && !AUTOMATED_TURN_ORIGINS.has(origin);
}
