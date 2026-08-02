import { SessionEvent, type SessionActivity } from "@norma/protocol";
import type { SessionStore, EventInput } from "./store";

/** Default bound on `SessionHub`'s last-emitted-activity memo (see `emitActivity`). Sessions are
 *  unbounded over a daemon's lifetime, so a plain Map keyed by session id is a slow leak; this caps
 *  it. Safe to bound at ALL because the memo is a de-dupe cache, never state: evicting an entry can
 *  only cause one redundant re-statement of a state the client already holds — it can never cause a
 *  MISSED change (that would need a stale entry, and eviction removes entries). 512 is far above
 *  any plausible count of sessions changing state within one daemon run. */
export const ACTIVITY_MEMO_CAP = 512;

export interface HubClient {
  clientName: string;
  /** session-activity-hygiene T5: the hello ROLE this connection authenticated as, as recorded on
   *  `ConnState.authedRole` (ipc/server.ts). Optional because a HubClient is fundamentally a
   *  delivery sink and most producers of one don't have a role to state; carried here because the
   *  detach-time harness classification needs it and the client object is the ONLY identity the
   *  hub's removal paths hold. `"remote"` is what makes the phone's gateway app-kind by the
   *  daemon's own record rather than by string-matching its name (`harnessKindOf`). */
  role?: string | null;
  deliver(event: SessionEvent): boolean;
}

export class SessionHub {
  private attachments = new Map<string, Set<HubClient>>(); // sessionId -> clients
  private byClient = new Map<HubClient, string>();         // client -> sessionId

  // Set by the IPC server (Task 3): a narrow, additional broadcast path for event types that must
  // reach EVERY authed harness, not just clients attached to the session in question (mirrors the
  // session_created broadcast the server already does for its own reasons). session_titled is the
  // first (only) such type — a harness viewing the session list needs a session it isn't attached
  // to to pick up its title live.
  onGlobalEvent?: (event: SessionEvent) => void;

  // session-activity-hygiene T5: the hub RAISES the fact that a harness went away; it does not
  // decide what that means. Set by the IPC server (the `onGlobalEvent` precedent above), which wires
  // it to the activity enforcement — the policy needs `AgentEngine.isRunning`/`interrupt` and the
  // one `deriveActivity` closure, none of which the hub owns or should learn to.
  //
  // Fired from BOTH removal paths, which is the whole reason this is a hub hook rather than a line
  // in the server's `close()` handler: a client can also be dropped by `fanOut`'s dead-client
  // eviction (a broken socket found mid-broadcast), and that path never goes through `detach()`.
  // `remaining` is the attachment count AFTER the removal — the "was this the last one" question,
  // answered by the only object that can answer it.
  onDetached?: (sessionId: string, client: HubClient, remaining: number) => void;

  // Dispatch (Phase 7): lightweight in-process observers — fan-out of every appended/broadcast
  // event of EVERY session. Unlike HubClient attach, observing appends nothing (no
  // harness_attached), doesn't count toward attachedCount, and spans all sessions. Errors in an
  // observer are swallowed (an observer must never break the append path).
  private observers = new Set<(event: SessionEvent) => void>();

  /** session-activity-hygiene T4: the last `session_activity` value BROADCAST per session — the
   *  change filter behind `emitActivity`. Insertion-ordered, used as an LRU (see the cap). */
  private lastActivity = new Map<string, SessionActivity>();

  constructor(private readonly store: SessionStore, private readonly activityMemoCap = ACTIVITY_MEMO_CAP) {}

  addObserver(fn: (event: SessionEvent) => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  private notifyObservers(event: SessionEvent): void {
    for (const fn of this.observers) { try { fn(event); } catch { /* observer bug must not break append */ } }
  }

  attach(client: HubClient, sessionId: string, fromSeq: number): number {
    // Defense-in-depth: a client can only be attached to one session — re-attach = move.
    const prev = this.byClient.get(client);
    if (prev && prev !== sessionId) this.detach(client);
    let lastSeq = fromSeq;
    for (const e of this.store.read(sessionId, fromSeq)) {
      // A client that dies mid-replay (e.g. a slow-consumer backlog cap trips) was never
      // really attached — don't add it, don't announce it. Return the seq of the last event
      // it successfully received so the caller still gets a coherent, non-sentinel lastSeq.
      if (!client.deliver(e)) return lastSeq;
      lastSeq = e.seq;
    }
    let set = this.attachments.get(sessionId);
    if (!set) { set = new Set(); this.attachments.set(sessionId, set); }
    set.add(client);
    this.byClient.set(client, sessionId);
    const e = this.appendAndBroadcast(sessionId, {
      type: "harness_attached", sessionId, clientName: client.clientName,
    });
    return e.seq;
  }

  detach(client: HubClient): void {
    const sessionId = this.byClient.get(client);
    if (!sessionId) return;
    this.attachments.get(sessionId)?.delete(client);
    this.byClient.delete(client);
    this.appendAndBroadcast(sessionId, {
      type: "harness_detached", sessionId, clientName: client.clientName,
    });
    this.raiseDetached(sessionId, client);
  }

  /** session-activity-hygiene T5: hand the detach fact to whoever is enforcing the lifecycle, AFTER
   *  the removal and its `harness_detached` are done — so a hook that turns around and derives this
   *  session's activity sees the finished state, not a half-removed one. Errors are logged and
   *  swallowed on the `notifyObservers` precedent: an enforcement bug must never break the detach
   *  path (a client that fails to come off the fan-out would be re-delivered to forever). */
  private raiseDetached(sessionId: string, client: HubClient): void {
    try { this.onDetached?.(sessionId, client, this.attachedCount(sessionId)); }
    catch (err) { console.error(`[hub] detach hook failed for ${sessionId}:`, err); }
  }

  send(client: HubClient, sessionId: string, text: string): number {
    if (this.byClient.get(client) !== sessionId) {
      throw new Error(`client ${client.clientName} not attached to ${sessionId}`);
    }
    return this.appendAndBroadcast(sessionId, {
      type: "user_message", sessionId, threadId: "main", text, clientName: client.clientName,
    }).seq;
  }

  /** Append an event and broadcast it — for server-side producers (agent engine). */
  append(sessionId: string, input: EventInput): SessionEvent {
    return this.appendAndBroadcast(sessionId, input);
  }

  /** How many clients are currently attached to `sessionId` — read-only, no side effects. Used by
   *  the `push_notification` tool's engine bridge (task-30): when this is `0` at the moment the
   *  tool fires, nothing live is attached to render the `notification_requested` event that was
   *  just emitted (no CLI harness, no app window), so the caller falls back to a headless
   *  `osascript` notification (see `agent/notify-fallback.ts`). Zero is a real, common case — a
   *  scheduled routine (Phase 5 routines) runs completely unattended. */
  attachedCount(sessionId: string): number {
    return this.attachments.get(sessionId)?.size ?? 0;
  }

  private appendAndBroadcast(sessionId: string, input: EventInput): SessionEvent {
    const event = this.store.append(sessionId, input);
    this.fanOut(sessionId, event);
    // Narrow on purpose: session_created already has its own server-side broadcast, and every
    // other event type is scoped to a session's own attachments.
    if (event.type === "session_titled") this.onGlobalEvent?.(event);
    this.notifyObservers(event);
    return event;
  }

  /** Broadcast-only TRANSIENT event: fanned out to attached clients, NEVER persisted — absent
   *  from the JSONL log and from attach replay. Stamped with seq = the store's CURRENT lastSeq
   *  (it is not itself sequenced): monotonic-safe for naive lastSeq tracking, but clients must
   *  exempt transient events from seq-based dedupe. Used for assistant_delta streaming.
   *  Deliberately does NOT call notifyObservers (Phase 7 dispatch): transient deltas are noise
   *  for the registry — observers only ever see persisted, appended events. */
  broadcastTransient(sessionId: string, input: EventInput): SessionEvent {
    const event = SessionEvent.parse({ ...input, seq: this.store.lastSeq(sessionId), ts: Date.now() });
    this.fanOut(sessionId, event);
    return event;
  }

  /** session-activity-hygiene T4: broadcast the session's DERIVED lifecycle state — but only when
   *  it is actually a change. This is the live signal that lets an open UI flip without re-polling
   *  `session.list`; every producer of a lifecycle transition calls it (`session.setActivity` after
   *  its flag write, `session.attach`'s archived-clear, and T5's enforcement transitions).
   *
   *  Takes the state rather than deriving one: the derivation needs signals the hub does not own
   *  (`AgentEngine.isRunning`/`hasBackgroundWork`) and there is exactly ONE place that wires them
   *  (`deriveActivity` in ipc/server.ts). A hub that re-derived would be a second wiring — the
   *  precise divergence T3 already had to fix once, when a private hub made `session.list` report
   *  "idle" for a session with a live harness on it.
   *
   *  `undefined` — what the derivation returns for a chat/dispatch session — emits NOTHING. Absence
   *  means "this session has no lifecycle", and that is not a state to announce; it also lets a
   *  caller pipe a derivation result straight through without re-testing participation.
   *
   *  ONLY ON CHANGE, against `lastActivity`: an idempotent `session.setActivity` (background on an
   *  already-backgrounded session) and any future per-tick sweep must not put a frame on every
   *  attached socket for a state nobody moved. The FIRST publish for a session always fires — the
   *  hub cannot know what a process that never ran published, and a re-statement is idempotent for
   *  every client, whereas a suppressed first change would be invisible forever.
   *
   *  Deliberately NOT conditioned on `attachedCount > 0`, even though `fanOut` to an empty set is a
   *  no-op today: that would bake "nobody is listening" into the memo, and the next global fan-out
   *  path (T9's `norma agents` roster is the plan's own candidate, on the `session_titled`
   *  `onGlobalEvent` precedent) would then silently miss every change made while a session sat
   *  unattached. The contract here is about the STATE changing, not about who hears it.
   *
   *  Returns the broadcast event, or `null` when nothing was emitted. */
  emitActivity(sessionId: string, activity: SessionActivity | undefined): SessionEvent | null {
    if (activity === undefined) return null;
    if (this.lastActivity.get(sessionId) === activity) return null;
    // BROADCAST FIRST, memo second. The memo records the last state actually DELIVERED, and that is
    // only true if a failed broadcast leaves it untouched: `broadcastTransient` reads
    // `store.lastSeq(sessionId)`, which throws for a session whose row is gone — reachable from T5's
    // detach/sweep call sites (a detach racing a delete). Writing the memo first would record a
    // state nobody ever received, and the next attempt at that same state would be suppressed as a
    // repeat — a permanently missed update, silently.
    const event = this.broadcastTransient(sessionId, { type: "session_activity", sessionId, activity });
    // Re-insert to move this session to the young end (Map iterates in insertion order), so the
    // eviction below drops the least-recently-CHANGED session rather than the oldest-known one.
    this.lastActivity.delete(sessionId);
    this.lastActivity.set(sessionId, activity);
    if (this.lastActivity.size > this.activityMemoCap) {
      const oldest = this.lastActivity.keys().next().value;
      if (oldest !== undefined) this.lastActivity.delete(oldest);
    }
    return event;
  }

  private fanOut(sessionId: string, event: SessionEvent): void {
    const dead: HubClient[] = [];
    for (const c of this.attachments.get(sessionId) ?? []) {
      let alive = false;
      try { alive = c.deliver(event); }
      catch { alive = false; } // a broken deliver (e.g. dead socket) must not poison the fan-out
      if (!alive) dead.push(c);
    }
    for (const c of dead) {
      // May already be gone if a nested broadcast (triggered by this same drain) evicted it —
      // e.g. two clients die in the same round; the first eviction's recursive harness_detached
      // fan-out can itself find the second dead and evict it. Without this guard the outer loop
      // would then process the second client again, double-evicting/double-announcing it.
      const set = this.attachments.get(sessionId);
      if (!set?.has(c)) continue;
      set.delete(c);
      this.byClient.delete(c);
      this.appendAndBroadcast(sessionId, {
        type: "harness_detached", sessionId, clientName: c.clientName,
      }); // bounded recursion: each level evicts at least one client
      // A socket that died is a detach like any other — and for a CLI harness mid-turn it is the
      // COMMON one (the terminal was closed). Missing it here would make the enforcement fire only
      // for orderly disconnects.
      this.raiseDetached(sessionId, c);
    }
  }
}
