// Dispatch's children — the `session_spawn` door and everything that follows a spawned session.
//
// REBUILT on the Winter leg. The engine-era `DispatchChildren` (deleted with `agent/engine.ts` in
// Phase 8b Task 17) was driven by an engine BRIDGE that intercepted `session_spawn` before the tool
// registry ran; on the Winter leg the dispatch coordinator is a runtime child calling the daemon's
// `sessions` capability server (`capabilities/sessions.ts`), so the tool's own `run()` is the door
// and this file is what it calls. The behaviour is the old design's, re-seated on today's seams:
//
//   - **Spawn** (`spawn`) — a first-class CODE session in the requested dir (canonicalised first, as
//     every session creator does), minted through the SAME creation transaction `session.create` runs
//     (`ipc/server.ts`'s `createSessionInternal`, handed in as `deps.createSession`): own transcript,
//     in `session.list`, `session_created` broadcast to every harness, linked to its coordinator by
//     `parentSessionId` + `origin: "dispatch-child"`, at the coordinator's CURRENT approval policy
//     (`childPolicyFor`; fixed for the child's life), titled with the spawn's title (so the auto-titler leaves it alone and the pill keeps its
//     label). NOT backgrounded (user ruling 2026-10-02 — until then every child was flagged background
//     at birth and on each follow-up, which made every finished child look busy to ListSessions and
//     ListAgents). The prompt is its first message through the session's own
//     driver (`send`), and the tool returns as soon as the message is in — it never waits for the
//     child's turn. A `model` is stamped AT CREATION. A first message that cannot be delivered rolls
//     the child back like a refused creation does: nothing is left behind.
//     Several spawns of one coordinator round run AT ONCE (agent SDK 0.0.41's `concurrentTools`, user
//     ruling 2026-10-03 — claude runs several `Agent` calls of a round at once). Each call's state is its
//     own (its child id, its tracked entry, its rollback), so they cannot cross-wire; a spawn's call is
//     cancelled by an interrupted coordinator turn (`signal`): before its child exists nothing is created,
//     before the child got its prompt the child is removed, and once the prompt is in the child stays.
//   - **Status** — a hub observer follows every tracked child's turns: `turn_started` (running), an
//     approval or question (awaiting_approval / awaiting_input, and back to running when it resolves),
//     the main thread's last `assistant_message` and any `agent_error`. Each change lands on the
//     COORDINATOR's log as a `child_update` (what the Mac builds its child pills from), and a finished
//     turn — reported when the child's driver settles (`onTurnSettled`) — carries the result summary.
//     Only turns the coordinator started are followed: the spawn's own, and a follow-up it delivered
//     with `SendMessage` (`agent/session-messaging.ts` → `expectFollowUp`, then the child's own driver
//     `send` under `clientName: "messaging"`) — even to a child already forgotten, which its stored
//     parent link picks back up. A `messaging` turn that the coordinator did NOT send (another session's
//     SendMessage to its child) is not followed, and neither is a user working in a finished child —
//     but their cards are still RELAYED (below).
//   - **Relay** — a dispatch child's `approval_requested`/`question_asked` are MIRRORED onto the
//     coordinator's log WHOEVER started the turn (user ruling 2026-10-02: only Dispatch-spawned sessions
//     forward their cards, and they always do — the bridge already parks every dispatch-child card for
//     10 minutes as a relayed one, `cardsRelayedToDispatch`); an unfollowed turn's cards ride a
//     relay-only entry that reports no status and wakes no one. A followed turn's cards are the same:
//     coordinator's log with `childSessionId` (always on its main thread, whatever thread raised it
//     inside the child) and their resolutions after them, so a client watching only Dispatch sees the
//     card and answers it at the CHILD's id (`approval.respond`/`ask_user.respond` — the brokers are
//     daemon-global, keyed by session + call). Loop-safe by construction: a mirrored copy is appended
//     under the coordinator's id, which is never a child. The child raises the card at all because
//     `runtime-sdk/approval-bridge.ts` relays a dispatch child's "ask" instead of refusing it (approvals
//     and questions alike auto-deny after 10 minutes), and Dispatch's OWN calls still never prompt.
//   - **Wake** — a finished child queues a `<child_update>` for its coordinator. The queue is flushed
//     as ONE message (so several children finishing together wake Dispatch once — the old coalescing)
//     on a macrotask, and only while the coordinator is idle; a coordinator mid-turn gets it when that
//     turn settles; a failed delivery is retried a bounded number of times. The message goes in through
//     the coordinator's own driver `send` under `DISPATCH_WAKE_CLIENT_NAME`, which clients render as a
//     notice rather than a user bubble, and a resumable coordinator is resumed for it like any inbound
//     message. It also lists the children still at work — the old per-turn roster, carried where the
//     model actually reads it.
//   - **Bounded roster** — a finished child stays tracked until the coordinator turn that was told
//     about it ends; then it is forgotten (the coordinator lives forever, so the map must not grow).
//   - **Restart** — a turn that was running when the daemon stopped did not survive it, and no pending
//     card did either (the brokers are in memory). `start()` reads the coordinator's log once: it
//     closes every mirrored card left open (`approval_resolved`/`question_resolved`, `by: "restart"`)
//     and every child still shown in flight (a final `error` update). Those children — and only those —
//     are picked back up from their stored parent link at their next turn, so one the user resumes
//     still reports. On a graceful shutdown `beginShutdown()` stops reports and wakes but keeps
//     mirroring resolutions while the children drain, so the cards their aborted turns withdraw close
//     on the coordinator's log too.
//
// Stopping a child is the session's own interrupt — `session.interrupt` (the Mac's stop button on a
// child pill) and Dispatch's `TaskStop` with the child's `s_…` id (`agent/session-messaging.ts`'s
// `stop`) both reach the child's driver; the interrupted turn settles and is reported here like any
// other. (`manage_session stop` was the third door until ManageSession left Dispatch, 2026-10-02.)
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DISPATCH_WAKE_CLIENT_NAME, type SessionEvent } from "@yanlinglabs/winter-protocol";
import { canonicalSessionCwd } from "../sessions/dirs";
import { TurnOriginPairer } from "../sessions/turn-origins";

export { DISPATCH_WAKE_CLIENT_NAME };
/** The `clientName` of the child's first prompt (visible in the child's own transcript as its task). */
export const DISPATCH_CLIENT_NAME = "dispatch";
/** The `clientName` a SendMessage delivery lands under in the target (`agent/session-messaging.ts`). */
const MESSAGING_CLIENT_NAME = "messaging";
/** The projector's own pass-through `user_message` (never a host push, never a turn's origin). */
const PROJECTOR_PASSTHROUGH_CLIENT = "winter";
/** The status vocabulary of `child_update` (`packages/protocol/src/events.ts`). */
export type ChildStatus = "running" | "awaiting_approval" | "awaiting_input" | "completed" | "error";
/** A result summary (on `child_update` and in the wake) is the child's last main-thread message, cut. */
export const CHILD_RESULT_SUMMARY_MAX = 2000;
/** The `by` a boot sweep closes a dead mirrored card with. */
export const RESTART_RESOLUTION_BY = "restart";
/** A failed wake is retried after each of these delays, then left for the coordinator's next settle. */
export const WAKE_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];
/** `notification_requested.title`'s own schema bound. */
const NOTIFICATION_TITLE_MAX = 100;
/** `session_titled` is index-capped by the store; keep the spawn title within a sane label length. */
const CHILD_TITLE_MAX = 120;

const TERMINAL: ReadonlySet<ChildStatus> = new Set(["completed", "error"]);

/** A code session's approval policies — what a child can be created at. */
export type ChildPolicy = "plan" | "dont-ask" | "ask" | "accept-edits" | "auto" | "bypass";
const CODE_POLICIES: ReadonlySet<string> = new Set<ChildPolicy>(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);

/**
 * The policy a child is created at: its coordinator's CURRENT policy (user ruling, 2026-10-01 — "if
 * it's auto, children also go through auto mode"). Every policy a dispatch session can hold
 * (`session.setPolicy` lets it hold everything but `plan`) is also a code policy, so the map is the
 * identity; anything else (an unreadable or legacy row) falls back to `auto`, dispatch's own default.
 * A `bypass` child gets bypass exactly the way `session.create` gives it: the policy is stored at
 * creation, so its first incarnation is spawned with it (`bypassAllowedAtSpawn`). Fixed at spawn: a
 * later change of the coordinator's policy does not reach children already running.
 */
export function childPolicyFor(coordinatorPolicy: string | undefined): ChildPolicy {
  return coordinatorPolicy !== undefined && CODE_POLICIES.has(coordinatorPolicy) ? coordinatorPolicy as ChildPolicy : "auto";
}

/** The arguments `session_spawn` takes (its zod schema, `agent/tools/session-spawn.ts`). */
export interface SessionSpawnArgs {
  dir: string;
  prompt: string;
  model?: string;
  type?: "code" | "cowork";
  title?: string;
}

/** The slice of a session's live driver this file uses (`LegSession`). */
export interface DispatchDriverHandle {
  readonly turnRunning: boolean;
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
}

export interface DispatchChildrenDeps {
  store: {
    meta(sessionId: string): { mode?: string; origin?: string; parentSessionId?: string; approvalPolicy?: string; backgrounded?: boolean };
    setBackgrounded(sessionId: string, on: boolean): void;
    getTitle?(sessionId: string): string | null;
    dispatchSessionId(): string | undefined;
    read(sessionId: string, fromSeq?: number): SessionEvent[];
  };
  hub: {
    addObserver(fn: (event: SessionEvent) => void): () => void;
    append(sessionId: string, input: never): SessionEvent;
    attachedCount(sessionId: string): number;
  };
  /** THE creation transaction (`ipc/server.ts`'s `createSessionInternal`, published through
   *  `onSessionCreator`). Throws a typed `WinterLegRefusal` (`code`, `message`) or an `RpcFailure`
   *  (a model the catalog cannot resolve). Undefined until the IPC server is up. */
  createSession: () => ((input: {
    scope: string; cwd: string; approvalPolicy: ChildPolicy; origin: "dispatch-child"; mode: "code";
    parentSessionId: string; model?: string;
  }) => Promise<{ sessionId: string }>) | undefined;
  /** Delete a session the spawn could not start — the creation-refusal rollback's own two steps
   *  (`store.deleteSession` + the daemon's `onSessionDeleted`, which ends its driver and runtime rows). */
  deleteSession?: (sessionId: string) => void;
  /** The driver table (`WinterSessionDrivers`): `get` a live driver, `ensure` one (resuming a
   *  resumable session). */
  sessions: {
    get(sessionId: string): DispatchDriverHandle | undefined;
    ensure(sessionId: string): Promise<DispatchDriverHandle | undefined>;
  };
  /** The LIVE picker list (`pickerModels()` over the current credentials) — the authoritative model
   *  check; the tool schema's enum is a boot snapshot and only steers. Absent or empty: not checked. */
  models?: () => Promise<readonly string[]> | readonly string[];
  /** Announce a session's activity after its background flag changed (`hub.emitActivity` with the
   *  `session.list` derivation). Optional. */
  announceActivity?: (sessionId: string) => void;
  /** The headless notification fallback (`agent/notify-fallback.ts`) for an unattended coordinator. */
  notifyFallback?: (title: string, message: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How a flush is deferred — a macrotask by default (tests may inject). */
  defer?: (fn: () => void) => void;
  /** How a wake retry is scheduled (an unref'd timer by default; tests may inject). */
  schedule?: (fn: () => void, ms: number) => void;
  retryDelaysMs?: readonly number[];
}

/** One tracked child. `status` is what the roster and every update read; the rest is the current
 *  turn's scratch state, reset each time a turn is reported. */
interface ChildState {
  dispatchId: string;
  title: string;
  dir: string;
  spawnedAt: number;
  status: ChildStatus;
  /** A followed turn began since the last report — what makes a settle a reportable turn end (a
   *  driver also settles when its idle child is ended, which reports nothing). */
  turnOpen: boolean;
  /** The `clientName` of the child's latest main-thread `user_message` — who asked for the next turn. */
  /** The next turn is followed whatever its origin — a child a restart interrupted, picked back up. */
  followNext?: boolean;
  lastAssistant?: string;
  sawError?: boolean;
  aborted?: boolean;
  /** The coordinator has been sent the wake carrying this child's terminal status. */
  reported: boolean;
  /** Call ids whose card was mirrored and has not been resolved on the coordinator's log yet. */
  openAsks: Set<string>;
  /** Tracked only to relay an unfollowed turn's cards (ruling 4): reports no status and wakes no one. */
  relayOnly?: boolean;
}

/** One queued wake entry. */
interface WakeEntry {
  childId: string;
  title: string;
  dir: string;
  status: ChildStatus;
  summary?: string;
}

/** A pre-flight refusal: the tool returns it as an error result, and nothing was created. */
export class SessionSpawnRefusal extends Error {
  constructor(message: string) { super(message); this.name = "SessionSpawnRefusal"; }
}

/** The spawn's call was cancelled (an interrupted coordinator turn) before its child got its prompt. */
class SpawnCancelled extends Error {
  constructor(message: string) { super(message); this.name = "SpawnCancelled"; }
}

/**
 * A cancelled spawn stops where it is. Before the child exists: a refusal, nothing created. After (`created`):
 * thrown inside the delivery `try`, so the child is rolled back with it.
 */
function throwIfCancelled(signal: AbortSignal | undefined, created: boolean): void {
  if (signal?.aborted !== true) return;
  const message = created
    ? "SpawnSession was cancelled before the child session got its prompt — the child was removed."
    : "SpawnSession was cancelled — nothing was created.";
  if (created) throw new SpawnCancelled(message);
  throw new SessionSpawnRefusal(message);
}

export class DispatchChildren {
  private readonly children = new Map<string, ChildState>();
  private readonly wakes = new Map<string, WakeEntry[]>();
  private readonly scheduled = new Set<string>();
  private readonly flushing = new Set<string>();
  private readonly retries = new Map<string, number>();
  /** Children the boot sweep closed (in flight across a restart): the only untracked children that
   *  are picked back up when they run again. */
  private readonly interruptedByRestart = new Map<string, { dispatchId: string; title: string }>();
  /** Child → coordinator: a SendMessage follow-up the coordinator is delivering right now
   *  (`expectFollowUp`), consumed by the child's next `messaging` `user_message`. */
  private readonly expectedFollowUps = new Map<string, Array<{ coordinatorId: string; text: string }>>();
  private off?: () => void;
  /** `beginShutdown()`: only resolutions are mirrored now. */
  private draining = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly defer: (fn: () => void) => void;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: DispatchChildrenDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(`dispatch-children: ${line}`));
    this.defer = deps.defer ?? ((fn) => { setTimeout(fn, 0); });
    this.schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); });
    this.retryDelaysMs = deps.retryDelaysMs ?? WAKE_RETRY_DELAYS_MS;
  }

  /** Subscribe to every session's events, then settle what a restart left open. */
  start(): void {
    this.off = this.deps.hub.addObserver((e) => this.onEvent(e));
    try { this.closeWhatARestartLeftOpen(); } catch (err) { this.log(`restart sweep failed: ${err instanceof Error ? err.name : "unknown"}`); }
  }

  /** Shutdown, step one (before the children drain): no more reports, wakes or new cards — but a
   *  draining child's withdrawn cards still close on the coordinator's log. */
  beginShutdown(): void {
    this.draining = true;
  }

  /** Shutdown, last step (after the children drained, before the store closes). */
  stop(): void {
    this.draining = true;
    this.stopped = true;
    this.off?.();
    this.off = undefined;
  }

  /** Test/diagnostic view: the tracked children, in spawn order. */
  roster(): Array<{ sessionId: string; dispatchId: string; title: string; status: ChildStatus }> {
    return [...this.children.entries()].map(([sessionId, c]) => ({ sessionId, dispatchId: c.dispatchId, title: c.title, status: c.status }));
  }

  /**
   * `session_spawn`, for the session `callerSessionId`. Resolves to the tool's result text; rejects
   * with an `Error` whose message IS the tool's error text (the registry turns a throw into an
   * `isError` result). Every pre-flight refusal happens before anything is created, and a spawn that
   * fails after creation removes what it created.
   */
  async spawn(callerSessionId: string, args: SessionSpawnArgs, opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.draining) throw new SessionSpawnRefusal("SpawnSession is not available — Winter is shutting down.");
    // Stamped when the call BEGINS (several spawns of one round run at once since agent SDK 0.0.41, so the
    // child that finishes being created first is not necessarily the one asked for first).
    const startedAt = this.now();
    const { signal } = opts;
    throwIfCancelled(signal, false);
    let caller: { mode?: string; approvalPolicy?: string };
    try { caller = this.deps.store.meta(callerSessionId); } catch { throw new SessionSpawnRefusal("SpawnSession is only available in the dispatch session."); }
    if (caller.mode !== "dispatch") throw new SessionSpawnRefusal("SpawnSession is only available in the dispatch session.");
    const type = args.type ?? "code";
    if (type === "cowork") throw new SessionSpawnRefusal("type 'cowork' is not yet available — use 'code'.");
    const raw = typeof args.dir === "string" ? args.dir.trim() : "";
    // Canonical FIRST (the transcript key every session creator stores — `canonicalSessionCwd`), so
    // `/x/..` is judged as the `/` it is and a symlinked spelling lands on its real directory.
    const dir = raw === "" ? "" : canonicalSessionCwd(raw);
    if (!isAbsolute(dir) || dir === "/") throw new SessionSpawnRefusal("dir must be an absolute directory path (not '/').");
    if (!isDirectory(dir)) throw new SessionSpawnRefusal(`dir '${raw}' does not exist or is not a directory — pass the absolute path of an existing directory.`);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) throw new SessionSpawnRefusal("prompt is required — write the child a complete, self-contained task.");
    const model = typeof args.model === "string" && args.model.trim() !== "" ? args.model.trim() : undefined;
    if (model !== undefined && this.deps.models !== undefined) {
      const known = await this.deps.models();
      if (known.length > 0 && !known.includes(model)) {
        throw new SessionSpawnRefusal(`unknown model '${model}' — available models: ${known.join(", ")}; omit \`model\` to inherit the default model`);
      }
    }
    const title = (typeof args.title === "string" && args.title.trim() !== "" ? args.title.trim() : prompt).slice(0, typeof args.title === "string" && args.title.trim() !== "" ? CHILD_TITLE_MAX : 60);
    const policy = childPolicyFor(caller.approvalPolicy);
    const create = this.deps.createSession();
    if (create === undefined) throw new SessionSpawnRefusal("SpawnSession is not ready yet — the daemon is still starting; try again in a moment.");
    // The model check above may have awaited: an interrupt that landed meanwhile creates nothing.
    throwIfCancelled(signal, false);

    let childId: string;
    try {
      ({ sessionId: childId } = await create({
        scope: "global", cwd: dir, approvalPolicy: policy, origin: "dispatch-child", mode: "code",
        parentSessionId: callerSessionId,
        ...(model === undefined ? {} : { model }),
      }));
    } catch (err) {
      throw new SessionSpawnRefusal(`could not start the child session: ${refusalText(err)}`);
    }
    // The spawn's title is the session's own title: the pill and the session list agree, and the
    // auto-titler (which skips a titled session) does not rename it under the user.
    this.safeAppend(childId, { type: "session_titled", sessionId: childId, threadId: "main", title });
    // Tracked BEFORE the send, so its `turn_started` and every later event find it; announced on the
    // coordinator's log only once the prompt is in.
    this.children.set(childId, newChild(callerSessionId, title, dir, startedAt));
    try {
      // Interrupted while the child was being created (the runtime cancels the call — agent SDK 0.0.40 —
      // and has already answered it `[interrupted]` to the model): the child never gets its prompt, so it is
      // removed like a child whose first message could not be delivered. Once the prompt is in, the child is
      // working and stays (it reports, and wakes the coordinator, like any other).
      throwIfCancelled(signal, true);
      const driver = this.deps.sessions.get(childId) ?? await this.deps.sessions.ensure(childId);
      if (driver === undefined) throw new Error("the child session has no runtime driver");
      throwIfCancelled(signal, true);
      await driver.send(prompt, DISPATCH_CLIENT_NAME);
    } catch (err) {
      const cancelled = err instanceof SpawnCancelled;
      const why = refusalText(err);
      this.log(`the first message to child ${childId} ${cancelled ? "was cancelled" : `failed (${err instanceof Error ? err.name : "unknown"})`} — the child is removed`);
      this.children.delete(childId);
      try { this.deps.deleteSession?.(childId); } catch { /* best effort; the refusal still stands */ }
      if (cancelled) throw new SessionSpawnRefusal(err.message);
      throw new SessionSpawnRefusal(`could not start the child session: its first message could not be delivered: ${why}`);
    }
    this.update(childId, "running");
    const modelNote = model === undefined ? "" : ` on ${model}`;
    return `spawned session ${childId} ("${title}") in ${dir}${modelNote}, at your current approval policy (${policy}; it keeps it even if yours changes later) — it is working on it now; you'll be woken with a <child_update> when it finishes. To tell it more later — even after it has finished — SendMessage it with to: "${childId}".`;
  }

  /**
   * SendMessage from the coordinator `coordinatorId` to its OWN child `childId` (`agent/session-messaging.ts`),
   * called just before `text` goes in through the child's driver. The child's `messaging` `user_message`
   * carrying exactly that text (own-child messages are sent verbatim) is the coordinator's follow-up: its
   * turn is followed (`child_update` running → completed, the wake) — a forgotten child is picked back up
   * from its stored link. Keyed on (coordinator, text), so a peer's message queued ahead of it is never
   * mistaken for it. Returns the undo for a message that could not be delivered. The child's background
   * flag is left alone (user ruling 2026-10-02).
   */
  expectFollowUp(childId: string, coordinatorId: string, text: string): () => void {
    const entry = { coordinatorId, text };
    const list = this.expectedFollowUps.get(childId) ?? [];
    list.push(entry);
    this.expectedFollowUps.set(childId, list);
    return () => { this.consumeFollowUp(childId, (x) => x === entry); };
  }

  /** Remove (and report) the first expectation on `childId` that `match` accepts. */
  private consumeFollowUp(childId: string, match: (x: { coordinatorId: string; text: string }) => boolean): { coordinatorId: string; text: string } | undefined {
    const list = this.expectedFollowUps.get(childId);
    if (list === undefined) return undefined;
    const at = list.findIndex(match);
    if (at < 0) return undefined;
    const [hit] = list.splice(at, 1);
    if (list.length === 0) this.expectedFollowUps.delete(childId);
    return hit;
  }

  /** Every session's driver calls this when its turn queue goes idle (or its child ends). */
  onTurnSettled(sessionId: string): void {
    if (this.draining) return;
    const child = this.children.get(sessionId);
    if (child !== undefined && child.turnOpen) this.reportTurnEnd(sessionId, child);
    // A coordinator's own turn ended: forget the children it has now been told about (the bounded
    // roster), then deliver anything that queued up while it was busy.
    if (this.isCoordinator(sessionId)) {
      for (const [id, c] of this.children) {
        if (c.dispatchId === sessionId && c.reported && TERMINAL.has(c.status) && c.openAsks.size === 0) this.children.delete(id);
      }
      this.scheduleFlush(sessionId);
    }
  }

  // ── the observer ─────────────────────────────────────────────────────────────────────────────

  /**
   * Which message started which turn, per session (`sessions/turn-origins.ts`): each main-thread
   * `user_message` is tagged FOLLOWED (Dispatch's spawn prompt, or the coordinator's own SendMessage
   * follow-up — `expectFollowUp`, matched by its exact text) or not, and each `turn_started` takes the
   * tag of the message it answers. One FIFO per session rather than a "last client" slot: every held
   * message is its own later turn, so a follow-up queued behind a peer's turn keeps its own tag (and
   * its wake). Kept for every session (a forgotten child's queue must already be right when Dispatch
   * picks it back up); an entry goes when its last owed message has started.
   */
  private readonly turnOrigins = new Map<string, TurnOriginPairer<boolean>>();

  /** Feed one main-thread event into its session's pairer; the tag a `turn_started` takes, or of a new message. */
  private trackOrigin(e: SessionEvent): boolean | undefined {
    if (e.type === "user_message") {
      if (e.clientName === PROJECTOR_PASSTHROUGH_CLIENT) return undefined;
      const followed = e.clientName === DISPATCH_CLIENT_NAME
        || (e.clientName === MESSAGING_CLIENT_NAME && this.consumeFollowUp(e.sessionId, (x) => x.text === e.text) !== undefined);
      let pairer = this.turnOrigins.get(e.sessionId);
      if (pairer === undefined) { pairer = new TurnOriginPairer<boolean>(); this.turnOrigins.set(e.sessionId, pairer); }
      pairer.message(followed);
      return followed;
    }
    const pairer = this.turnOrigins.get(e.sessionId);
    if (pairer === undefined) return undefined;
    if (e.type !== "turn_started") { pairer.other(); return undefined; }
    const tag = pairer.turnStarted();
    if (pairer.empty) this.turnOrigins.delete(e.sessionId);
    return tag;
  }

  private onEvent(e: SessionEvent): void {
    if (this.stopped) return;
    const main = (e as { threadId?: string }).threadId === "main";
    const originTag = main ? this.trackOrigin(e) : undefined;
    let c = this.children.get(e.sessionId);
    if (c === undefined) {
      // Picked back up: a child a restart interrupted, at its next turn; a forgotten child the
      // COORDINATOR messages again (its follow-up's `user_message` — `messaging`/`dispatch` — lands
      // before the turn it starts). A user typing in a forgotten child directly is never picked up.
      if (this.draining) return;
      // A card from a dispatch child's turn nobody follows (a peer's message, the user typing in it): relayed
      // all the same, on a relay-only entry (any thread — a subagent's card too).
      if (e.type === "approval_requested" || e.type === "question_asked") c = this.relayOnlyFromLink(e.sessionId);
      else if (!main) return;
      else if (e.type === "turn_started") c = this.retrack(e.sessionId);
      else if (e.type === "user_message" && originTag === true) c = this.retrackFromLink(e.sessionId);
      if (c === undefined) return;
    }
    if (this.draining) {
      // Shutdown: the children's aborted turns withdraw their cards — close the mirrors too.
      if (e.type === "approval_resolved" || e.type === "question_resolved") this.mirrorResolution(c, e);
      return;
    }
    switch (e.type) {
      case "user_message":
        return;   // tagged above (`trackOrigin`)
      case "turn_started": {
        if (!main) return;
        // Ongoing delegated work, or a turn Dispatch started (its spawn prompt, its follow-up); a peer's
        // message or a user working in a finished child directly is not Dispatch's to report.
        const followed = !TERMINAL.has(c.status) || originTag === true || c.followNext === true;
        c.followNext = false;
        if (!followed) return;
        c.relayOnly = false;
        c.turnOpen = true;
        c.lastAssistant = undefined; c.sawError = false; c.aborted = false;
        if (c.status !== "running") { c.status = "running"; c.reported = false; this.update(e.sessionId, "running"); }
        return;
      }
      case "assistant_message":
        if (main && c.turnOpen) c.lastAssistant = e.text;
        return;
      case "agent_error":
        if (main && c.turnOpen) c.sawError = true;
        return;
      case "turn_completed":
        if (main && c.turnOpen && e.stopReason === "aborted") c.aborted = true;
        if (main && c.turnOpen && e.stopReason === "error") c.sawError = true;
        return;
      case "approval_requested":
        // Relayed whoever started the turn (ruling 4); only a followed turn's status moves.
        this.mirrorAsk(c, e);
        if (c.turnOpen) this.setStatus(e.sessionId, c, "awaiting_approval");
        this.notifyUnattended(c, "needs your approval", e.sessionId);
        return;
      case "question_asked":
        this.mirrorAsk(c, e);
        if (c.turnOpen) this.setStatus(e.sessionId, c, "awaiting_input");
        this.notifyUnattended(c, "has a question for you", e.sessionId);
        return;
      case "approval_resolved":
      case "question_resolved":
        if (!this.mirrorResolution(c, e)) return;
        if (c.turnOpen && (c.status === "awaiting_approval" || c.status === "awaiting_input") && c.openAsks.size === 0) this.setStatus(e.sessionId, c, "running");
        // A relay-only entry exists for its cards alone: gone once they are all resolved.
        if (c.relayOnly && c.openAsks.size === 0) this.children.delete(e.sessionId);
        return;
      default:
        return;
    }
  }

  private retrack(sessionId: string): ChildState | undefined {
    const interrupted = this.interruptedByRestart.get(sessionId);
    if (interrupted === undefined) return undefined;
    this.interruptedByRestart.delete(sessionId);
    const state = newChild(interrupted.dispatchId, interrupted.title, "", this.now());
    state.status = "error";
    state.followNext = true;   // the turn resumes the coordinator's own work
    this.children.set(sessionId, state);
    return state;
  }

  /** A relay-only entry for a dispatch child nobody is following (its cards still go to Dispatch). */
  private relayOnlyFromLink(sessionId: string): ChildState | undefined {
    const state = this.retrackFromLink(sessionId);
    if (state !== undefined) state.relayOnly = true;
    return state;
  }

  /** A forgotten child, from its stored link: a `dispatch-child` whose parent is a dispatch session. */
  private retrackFromLink(sessionId: string): ChildState | undefined {
    let meta: { origin?: string; parentSessionId?: string };
    try { meta = this.deps.store.meta(sessionId); } catch { return undefined; }
    if (meta.origin !== "dispatch-child" || meta.parentSessionId === undefined) return undefined;
    try { if (this.deps.store.meta(meta.parentSessionId).mode !== "dispatch") return undefined; } catch { return undefined; }
    let title = "child session";
    try { title = this.deps.store.getTitle?.(sessionId) ?? title; } catch { /* keep the fallback */ }
    const state = newChild(meta.parentSessionId, title, "", this.now());
    state.status = "completed";   // its last reported turn ended; this follow-up starts the next
    state.reported = true;
    this.children.set(sessionId, state);
    return state;
  }

  private setStatus(childId: string, c: ChildState, status: ChildStatus): void {
    if (c.status === status) return;
    c.status = status;
    this.update(childId, status);
  }

  private reportTurnEnd(childId: string, c: ChildState): void {
    const status: ChildStatus = c.sawError ? "error" : "completed";
    const last = c.lastAssistant?.trim() ? c.lastAssistant.trim() : undefined;
    const summary = c.aborted
      ? `Stopped before it finished.${last ? ` Its last message: ${last}` : ""}`
      : last;
    const cut = summary === undefined ? undefined : summary.slice(0, CHILD_RESULT_SUMMARY_MAX);
    c.status = status;
    c.turnOpen = false;
    c.reported = false;
    c.lastAssistant = undefined; c.sawError = false; c.aborted = false;
    this.update(childId, status, cut);
    this.notifyUnattended(c, status === "error" ? "hit an error" : "finished");
    const queue = this.wakes.get(c.dispatchId) ?? [];
    // A second report for the same child before the coordinator was told replaces the first.
    const kept = queue.filter((w) => w.childId !== childId);
    kept.push({ childId, title: c.title, dir: c.dir, status, ...(cut === undefined ? {} : { summary: cut }) });
    this.wakes.set(c.dispatchId, kept);
    this.scheduleFlush(c.dispatchId);
  }

  // ── the wake ─────────────────────────────────────────────────────────────────────────────────

  private scheduleFlush(dispatchId: string): void {
    if (this.draining || this.scheduled.has(dispatchId) || (this.wakes.get(dispatchId)?.length ?? 0) === 0) return;
    this.scheduled.add(dispatchId);
    this.defer(() => {
      this.scheduled.delete(dispatchId);
      void this.flush(dispatchId);
    });
  }

  private async flush(dispatchId: string): Promise<void> {
    if (this.draining || this.flushing.has(dispatchId)) return;
    const queue = this.wakes.get(dispatchId);
    if (queue === undefined || queue.length === 0) return;
    // Mid-turn: its settle flushes. (A held send would also run after the turn, but one message per
    // finished child is not coalescing — the batch is taken only while the coordinator is idle.)
    if (this.deps.sessions.get(dispatchId)?.turnRunning) return;
    this.flushing.add(dispatchId);
    let batch: WakeEntry[] = [];
    try {
      const driver = this.deps.sessions.get(dispatchId) ?? await this.deps.sessions.ensure(dispatchId);
      if (driver === undefined) throw new Error("the coordinator has no runtime driver");
      if (driver.turnRunning) return;
      batch = queue.splice(0);
      for (const w of batch) {
        const c = this.children.get(w.childId);
        if (c !== undefined && TERMINAL.has(c.status)) c.reported = true;
      }
      await driver.send(this.wakeText(dispatchId, batch), DISPATCH_WAKE_CLIENT_NAME);
      this.retries.delete(dispatchId);
    } catch (err) {
      const rest = this.wakes.get(dispatchId) ?? [];
      this.wakes.set(dispatchId, [...batch, ...rest]);
      for (const w of batch) { const c = this.children.get(w.childId); if (c !== undefined) c.reported = false; }
      const attempt = this.retries.get(dispatchId) ?? 0;
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined) {
        this.retries.delete(dispatchId);
        this.log(`waking coordinator ${dispatchId} failed (${err instanceof Error ? err.name : "unknown"}) after ${attempt} retr(ies) — the update(s) wait for its next turn`);
      } else {
        this.retries.set(dispatchId, attempt + 1);
        this.log(`waking coordinator ${dispatchId} failed (${err instanceof Error ? err.name : "unknown"}) — retrying in ${delay} ms`);
        this.schedule(() => { this.scheduleFlush(dispatchId); }, delay);
      }
    } finally {
      this.flushing.delete(dispatchId);
    }
  }

  /** The wake message: one `<child_update>` block per finished child, then the children still at work. */
  private wakeText(dispatchId: string, batch: readonly WakeEntry[]): string {
    const blocks = batch.map((w) => [
      "<child_update>",
      `session: ${w.childId}`,
      `title: ${w.title}`,
      ...(w.dir ? [`dir: ${w.dir}`] : []),
      `status: ${w.status}`,
      ...(w.summary === undefined ? ["result: (the child ended its turn without a final message)"] : ["result:", w.summary]),
      "</child_update>",
    ].join("\n"));
    const batchIds = new Set(batch.map((w) => w.childId));
    const working = [...this.children.entries()]
      .filter(([id, c]) => c.dispatchId === dispatchId && !batchIds.has(id) && !TERMINAL.has(c.status))
      .map(([id, c]) => `- ${id} "${c.title}"${c.dir ? ` (${c.dir})` : ""} — ${c.status}, ${Math.max(0, Math.round((this.now() - c.spawnedAt) / 1000))}s`);
    const roster = working.length === 0 ? "No other child sessions are working." : `Still working:\n${working.join("\n")}`;
    return `${blocks.join("\n\n")}\n\n${roster}`;
  }

  // ── events onto the coordinator's log ────────────────────────────────────────────────────────

  private update(childId: string, status: ChildStatus, resultSummary?: string): void {
    const c = this.children.get(childId);
    if (c === undefined) return;
    this.safeAppend(c.dispatchId, {
      type: "child_update", sessionId: c.dispatchId, threadId: "main",
      childSessionId: childId, status, title: c.title,
      ...(resultSummary === undefined ? {} : { resultSummary }),
    });
  }

  /** A child's card, re-stamped onto the coordinator's MAIN thread with `childSessionId` — whatever
   *  thread raised it inside the child (a subagent's card is still answered at the child's id). */
  private mirrorAsk(c: ChildState, e: SessionEvent): void {
    const callId = (e as { callId: string }).callId;
    c.openAsks.add(callId);
    const { seq: _seq, ts: _ts, ...rest } = e as SessionEvent & { seq: number; ts: number };
    this.safeAppend(c.dispatchId, { ...rest, sessionId: c.dispatchId, threadId: "main", childSessionId: e.sessionId });
  }

  /** Mirror a resolution only for a card this file mirrored. True when it did. */
  private mirrorResolution(c: ChildState, e: SessionEvent): boolean {
    const callId = (e as { callId: string }).callId;
    if (!c.openAsks.delete(callId)) return false;
    const { seq: _seq, ts: _ts, ...rest } = e as SessionEvent & { seq: number; ts: number };
    this.safeAppend(c.dispatchId, { ...rest, sessionId: c.dispatchId, threadId: "main", childSessionId: e.sessionId });
    return true;
  }

  /** `askingChildId`: for a card — when the user has the CHILD itself open, they are looking at the card
   *  already (a turn they typed into it, say), so no "needs your approval" notification on top. */
  private notifyUnattended(c: ChildState, message: string, askingChildId?: string): void {
    try {
      if (this.deps.hub.attachedCount(c.dispatchId) > 0) return;
      if (askingChildId !== undefined && this.deps.hub.attachedCount(askingChildId) > 0) return;
    } catch { return; }
    const title = c.title.slice(0, NOTIFICATION_TITLE_MAX) || "Dispatch";
    this.safeAppend(c.dispatchId, { type: "notification_requested", sessionId: c.dispatchId, threadId: "main", title, message });
    try { this.deps.notifyFallback?.(title, message); } catch { /* a notification is best effort */ }
  }

  private safeAppend(sessionId: string, event: Record<string, unknown>): void {
    try {
      this.deps.hub.append(sessionId, event as never);
    } catch (err) {
      this.log(`could not append ${String(event.type)} to ${sessionId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
  }

  private isCoordinator(sessionId: string): boolean {
    if (this.wakes.has(sessionId)) return true;
    for (const c of this.children.values()) if (c.dispatchId === sessionId) return true;
    return false;
  }

  /**
   * Restart: no turn and no pending card survives the process that ran it (the approval and question
   * brokers are in memory). One read of the coordinator's log finds what it still shows open — a
   * mirrored card with no mirrored resolution, a child whose last update is not terminal — and
   * closes it, so the Mac (which keeps a child's card past the coordinator's turn by design) does not
   * show a dead card or a "running" pill forever.
   *
   * The read is the whole log, once per boot. There is no cheaper bound to hand: the store keeps no
   * roster of open children or cards (they live only in this log), and the coordinator is a
   * singleton, so this is one file — the same one the dreamer already reads.
   */
  private closeWhatARestartLeftOpen(): void {
    const dispatchId = this.deps.store.dispatchSessionId();
    if (dispatchId === undefined) return;
    const last = new Map<string, { status: ChildStatus; title: string }>();
    const open = new Map<string, { kind: "approval" | "question"; childId: string; callId: string }>();
    for (const e of this.deps.store.read(dispatchId)) {
      const child = (e as { childSessionId?: string }).childSessionId;
      if (e.type === "child_update") last.set(e.childSessionId, { status: e.status, title: e.title });
      else if (child === undefined) continue;
      else if (e.type === "approval_requested") open.set(`${child}:${e.callId}`, { kind: "approval", childId: child, callId: e.callId });
      else if (e.type === "question_asked") open.set(`${child}:${e.callId}`, { kind: "question", childId: child, callId: e.callId });
      else if (e.type === "approval_resolved" || e.type === "question_resolved") open.delete(`${child}:${e.callId}`);
    }
    for (const ask of open.values()) {
      this.safeAppend(dispatchId, ask.kind === "approval"
        ? { type: "approval_resolved", sessionId: dispatchId, threadId: "main", callId: ask.callId, approved: false, by: RESTART_RESOLUTION_BY, childSessionId: ask.childId }
        : { type: "question_resolved", sessionId: dispatchId, threadId: "main", callId: ask.callId, answers: {}, by: RESTART_RESOLUTION_BY, childSessionId: ask.childId });
    }
    for (const [childId, { status, title }] of last) {
      if (TERMINAL.has(status) || this.children.has(childId)) continue;
      this.interruptedByRestart.set(childId, { dispatchId, title });
      this.safeAppend(dispatchId, {
        type: "child_update", sessionId: dispatchId, threadId: "main", childSessionId: childId, status: "error", title,
        resultSummary: "Winter restarted while this session was working, so that turn was stopped. The session is kept — open it or send it a message to continue.",
      });
    }
  }
}

function newChild(dispatchId: string, title: string, dir: string, now: number): ChildState {
  return { dispatchId, title, dir, spawnedAt: now, status: "running", turnOpen: false, reported: false, openAsks: new Set() };
}

function isDirectory(dir: string): boolean {
  try { return existsSync(dir) && statSync(dir).isDirectory(); } catch { return false; }
}

/** A refusal's words for the model: the message plus its typed code (never a stack). */
function refusalText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code ?? (err as { data?: { code?: unknown } }).data?.code;
    return typeof code === "string" && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
