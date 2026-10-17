// Who started a session's RUNNING turn, kept in memory — so a card does not re-read a long-lived log.
//
// `runningTurnOrigin` over `store.read(sessionId)` parses the WHOLE log, and the bridges ask it on every
// card of a dispatch session or a dispatch child (`approval-bridge.ts`'s `dispatchCardTimeoutMs`) and on
// every computer-use card. Dispatch is the singleton that lives for months, so that read grew without
// bound. This index answers from memory instead:
//   - a session is TRACKED from its first question: seeded once from a bounded TAIL of its log
//     (`SessionStore.readTail`, `SEED_TAIL_BYTES`) — exact whenever the log is smaller than that, and
//     otherwise exact unless messages older than the window are still unpaired (a queue deeper than the
//     window, which a real session does not hold);
//   - from then on it is FED every event the hub appends for it (`hub.addObserver`), in seq order;
//   - it is DROPPED (re-seeded at the next question) the moment it can no longer be trusted: an event that
//     skips a seq (something appended to the store without the hub), or a store `lastSeq` ahead of what
//     it saw when asked;
//   - at most `MAX_TRACKED` sessions are held, least recently asked evicted first.
// Every failure answers `undefined` — an UNKNOWN origin, which every caller already treats as "not a
// person" (bounded), today's conservative reading.
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { TurnOriginTracker } from "./turn-origins";

/** How much of a log a first question reads — far more than any turn's start sits back from its cards. */
export const SEED_TAIL_BYTES = 512 * 1024;
const MAX_TRACKED = 64;

export interface TurnOriginStore {
  readTail(sessionId: string, maxBytes: number): SessionEvent[];
  lastSeq(sessionId: string): number;
}
export interface TurnOriginHub {
  addObserver?(fn: (event: SessionEvent) => void): () => void;
}

export class TurnOriginIndex {
  private readonly tracked = new Map<string, TurnOriginTracker>();

  constructor(private readonly store: TurnOriginStore) {}

  /** Feed one appended event (the hub observer). Ignores sessions nobody has asked about. */
  observe(e: SessionEvent): void {
    const t = this.tracked.get(e.sessionId);
    if (t === undefined) return;
    if (e.seq !== t.lastSeq + 1) { this.tracked.delete(e.sessionId); return; }   // a gap: re-seed when asked
    t.feed(e);
  }

  /** The clientName that started `sessionId`'s running turn, or `undefined` (none, or unknown). */
  origin(sessionId: string): string | undefined {
    try {
      let t = this.tracked.get(sessionId);
      if (t !== undefined && this.store.lastSeq(sessionId) !== t.lastSeq) { this.tracked.delete(sessionId); t = undefined; }
      if (t === undefined) {
        t = new TurnOriginTracker();
        for (const e of this.store.readTail(sessionId, SEED_TAIL_BYTES)) t.feed(e);
        if (t.lastSeq === 0) t.lastSeq = this.store.lastSeq(sessionId);   // an empty log: start from the row
      } else {
        this.tracked.delete(sessionId);   // re-inserted below: most recently asked last
      }
      this.tracked.set(sessionId, t);
      while (this.tracked.size > MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
      return t.current;
    } catch {
      this.tracked.delete(sessionId);
      return undefined;
    }
  }
}

const byHub = new WeakMap<object, TurnOriginIndex>();

/** The one index for a hub, registered as its observer on first use. A hub without observers (a test
 *  double) gets an index that is re-seeded from the bounded tail on every question — never a whole-log read. */
export function turnOriginIndexFor(hub: TurnOriginHub, store: TurnOriginStore): TurnOriginIndex {
  const existing = byHub.get(hub);
  if (existing !== undefined) return existing;
  const index = new TurnOriginIndex(store);
  if (typeof hub.addObserver === "function") hub.addObserver((e) => index.observe(e));
  else index.observe = () => {};   // never fed: `origin`'s lastSeq check re-seeds each time
  byHub.set(hub, index);
  return index;
}
