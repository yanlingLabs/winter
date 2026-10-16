import type { SessionEvent } from "@yanlinglabs/winter-protocol";

// The Winter island's daemon half (`docs/claude/island.md`): the Mac app shows every approval, question and URL-mode
// elicitation still pending in ANY session — its own windows attach to one session each, so no event stream gives it
// that. `island.pending` answers from here; `island.changed` tells the island clients to ask again.
//
// Pending-ness is the BROKERS' (`IslandPendingSources`): an entry the broker no longer holds is never listed, so a
// card that ended without a resolve event (a timeout, a restart, a broker that cleared it) cannot linger. The
// payload is the request event as the session's log holds it — the brokers keep no question text or server name.

export type IslandItemKind = "approval" | "question" | "elicitation";

/** Whether a card is still waiting, by the broker that owns it — the one source of truth for pending-ness. */
export interface IslandPendingSources {
  approval(sessionId: string, callId: string): boolean;
  question(sessionId: string, callId: string): boolean;
  elicitation(sessionId: string, elicitationId: string): boolean;
}

export interface IslandSessionFacts {
  mode?: string;
  origin?: string;
  parentSessionId?: string;
  title?: string;
}

export interface IslandHost {
  clientName: string;
  role?: string;
  tty?: string;
}

export interface IslandPendingItem {
  sessionId: string;
  answerSessionId: string;
  kind: IslandItemKind;
  event: SessionEvent;
  session: IslandSessionFacts;
  hosts: IslandHost[];
}

/** One connected island client: told (with no payload) that the pending set may have changed. */
export interface IslandClient {
  notify(): void;
  /** Told (no payload) that the island's activity — computer use, turn results, watches — may have changed
   *  (`island.activityChanged`, `island/activity.ts`). */
  notifyActivity?(): void;
}

export interface IslandRegistryDeps {
  pending: IslandPendingSources;
  /** The session's facts; undefined for a session the store does not know. */
  facts(sessionId: string): IslandSessionFacts | undefined;
  /** Every connection attached to the session now. */
  hosts(sessionId: string): IslandHost[];
  /** Bound on the entries held (oldest dropped first). */
  maxEntries?: number;
}

/** How many cards the registry keeps at most. Far above anything a person could be asked at once. */
export const ISLAND_MAX_ENTRIES = 256;

/** How long the desktop-switch prompt waits for the island client to say it SHOWS the card (`island.shown`) before
 *  the helper's own panel is asked as well — a Winter.app that is connected but hung shows nothing. */
export const ISLAND_SHOWN_ACK_MS = 2_000;

/** What the desktop-switch prompt asks of the island (`islandAwareDesktopPanel`, `computer-use/wiring.ts`). */
export interface IslandPresence {
  /** Is any island client connected now? */
  hasClient(): boolean;
  /** Called once when the LAST island client leaves (a quit, a crash, a dropped socket). Returns the unsubscribe. */
  onAllClientsGone(fn: () => void): () => void;
  /** Resolves true when an island client says it shows the card `id` (`island.shown`), false after `ms` — or at once
   *  when `signal` aborts (its timer cleared). */
  waitShown(id: string, ms: number, signal?: AbortSignal): Promise<boolean>;
}

interface Entry {
  kind: IslandItemKind;
  answerSessionId: string;
  id: string;
  event: SessionEvent;
  /** The event is a Dispatch MIRROR (it carries `childSessionId`); the child's own copy replaces it. */
  mirrored: boolean;
}

export class IslandRegistry implements IslandPresence {
  private readonly entries = new Map<string, Entry>();
  private readonly clients = new Set<IslandClient>();
  private notifyScheduled = false;
  private readonly goneListeners = new Set<() => void>();
  /** Card ids an island client said it shows, newest last (bounded), and the prompts waiting to hear it. */
  private readonly shown = new Set<string>();
  private readonly shownWaiters = new Map<string, Set<(shown: boolean) => void>>();

  constructor(private readonly deps: IslandRegistryDeps) {}

  /** A connection that advertised `CLIENT_CAPABILITY_ISLAND` in its hello. */
  addClient(client: IslandClient): void { this.clients.add(client); }
  removeClient(client: IslandClient): void {
    if (!this.clients.delete(client) || this.clients.size > 0) return;
    for (const fn of [...this.goneListeners]) {
      try { fn(); } catch { /* a listener's failure is its own */ }
    }
  }
  /** Is any island client connected now? (The desktop-switch prompt then skips the helper's own panel.) */
  hasClient(): boolean { return this.clients.size > 0; }

  onAllClientsGone(fn: () => void): () => void {
    this.goneListeners.add(fn);
    return () => { this.goneListeners.delete(fn); };
  }

  /** `island.shown`: the client shows these cards (by their callId / elicitationId). */
  markShown(ids: readonly string[]): void {
    for (const id of ids) {
      this.shown.delete(id);
      this.shown.add(id);
      const waiters = this.shownWaiters.get(id);
      if (waiters !== undefined) {
        this.shownWaiters.delete(id);
        for (const w of waiters) w(true);
      }
    }
    while (this.shown.size > ISLAND_MAX_ENTRIES) this.shown.delete(this.shown.values().next().value as string);
  }

  waitShown(id: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.shown.has(id)) return Promise.resolve(true);
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      let set = this.shownWaiters.get(id);
      if (set === undefined) { set = new Set(); this.shownWaiters.set(id, set); }
      const waiters = set;
      const forget = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0 && this.shownWaiters.get(id) === waiters) this.shownWaiters.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = (shown: boolean): void => { forget(); resolve(shown); };
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(false), ms);
      (timer as { unref?: () => void }).unref?.();
      waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Test seam: prompts still waiting to hear `island.shown` (each holds a timer). */
  get shownWaiting(): number {
    let n = 0;
    for (const set of this.shownWaiters.values()) n += set.size;
    return n;
  }

  /** Every appended event of every session (`SessionHub.addObserver`). */
  observe(event: SessionEvent): void {
    switch (event.type) {
      case "approval_requested":
        this.add("approval", event.childSessionId ?? event.sessionId, event.callId, event, event.childSessionId !== undefined);
        return;
      case "question_asked":
        this.add("question", event.childSessionId ?? event.sessionId, event.callId, event, event.childSessionId !== undefined);
        return;
      case "elicitation_requested":
        this.add("elicitation", event.sessionId, event.elicitationId, event, false);
        return;
      case "approval_resolved":
        this.remove("approval", event.childSessionId ?? event.sessionId, event.callId);
        return;
      case "question_resolved":
        this.remove("question", event.childSessionId ?? event.sessionId, event.callId);
        return;
      case "elicitation_resolved":
        this.remove("elicitation", event.sessionId, event.elicitationId);
        return;
      case "harness_attached":
      case "harness_detached":
        // A session's hosts decide where its card shows (in front of its terminal or window, or not).
        for (const e of this.entries.values()) {
          if (e.answerSessionId === event.sessionId) { this.changed(); return; }
        }
        return;
      default:
        return;
    }
  }

  /** The cards still pending, oldest first, each with its session's facts and hosts. Prunes what the brokers no
   *  longer hold. */
  list(): IslandPendingItem[] {
    const out: IslandPendingItem[] = [];
    for (const [key, e] of [...this.entries]) {
      if (!this.stillPending(e)) { this.entries.delete(key); continue; }
      let facts: IslandSessionFacts | undefined;
      try { facts = this.deps.facts(e.answerSessionId); } catch { facts = undefined; }
      let hosts: IslandHost[] = [];
      try { hosts = this.deps.hosts(e.answerSessionId); } catch { hosts = []; }
      out.push({ sessionId: e.event.sessionId, answerSessionId: e.answerSessionId, kind: e.kind, event: e.event,
        session: facts ?? {}, hosts });
    }
    return out;
  }

  /** Test seam: the number of entries held (before pruning). */
  get size(): number { return this.entries.size; }

  private stillPending(e: Entry): boolean {
    try {
      switch (e.kind) {
        case "approval": return this.deps.pending.approval(e.answerSessionId, e.id);
        case "question": return this.deps.pending.question(e.answerSessionId, e.id);
        case "elicitation": return this.deps.pending.elicitation(e.answerSessionId, e.id);
      }
    } catch {
      return false;
    }
  }

  private key(kind: IslandItemKind, answerSessionId: string, id: string): string {
    return `${kind}\u0000${answerSessionId}\u0000${id}`;
  }

  private add(kind: IslandItemKind, answerSessionId: string, id: string, event: SessionEvent, mirrored: boolean): void {
    const k = this.key(kind, answerSessionId, id);
    const existing = this.entries.get(k);
    // The child's own card is the one kept: a mirror never replaces it, and it replaces a mirror.
    if (existing !== undefined && !existing.mirrored && mirrored) return;
    this.entries.delete(k);
    this.entries.set(k, { kind, answerSessionId, id, event, mirrored });
    const max = this.deps.maxEntries ?? ISLAND_MAX_ENTRIES;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    this.changed();
  }

  private remove(kind: IslandItemKind, answerSessionId: string, id: string): void {
    if (this.entries.delete(this.key(kind, answerSessionId, id))) this.changed();
  }

  /** Tells every island client, once per burst (one microtask): a mirror and its child's copy, or a resolve and the
   *  next card, arrive together. */
  private changed(): void {
    if (this.clients.size === 0 || this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const c of [...this.clients]) {
        try { c.notify(); } catch { /* a dead connection's close() removes it */ }
      }
    });
  }
}
