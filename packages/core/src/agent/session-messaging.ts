// SendMessage / TaskStop between Winter sessions: the daemon's half of the agent SDK's `Options.hostMessaging`.
//
// WHY THIS EXISTS. A session's `SendMessage` runs inside its own runtime child (a `winter` process for a
// code session, a Worker for dispatch), and that child can resolve only what it holds: its own subagents
// and itself. Every other Winter session lives in another child, so before agent SDK 0.0.39 a message to
// one answered `not_found … is currently reachable` (dev, 2026-10-02: Dispatch could not follow up a single
// child). Since 0.0.39 the runtime asks its HOST for anything it cannot resolve in-process
// (`host_message_send`), for the rows ListAgents adds (`host_message_list`), and — for a `TaskStop` whose
// id names no task of its own — to stop a session (`host_session_stop`). This file answers all three, one
// handler per session, built in `session-driver.ts`'s `optionsFor` beside `onCredentialResolve`. The
// caller is the session whose handler fired — never a field of the request.
//
// USER RULINGS (2026-10-02), binding:
//   - SendMessage is the ONE tool that messages a session and resumes it; ManageSession is gone from
//     Dispatch. TaskStop stops a session's running turn (by `s_…` id) the way it stops a subagent.
//   - TARGETS are code and Cowork sessions only (`participatesInActivity` — the modes with a lifecycle,
//     which already names `cowork`). Chat and dispatch sessions are refused, typed.
//   - SENDERS are whoever has the tool. Chat does not (its allowed list dropped SendMessage, ListAgents and
//     ReadNotifications), and a chat caller is refused here too, defensively.
//   - A message runs at the TARGET's own approval policy, with no card for the message itself — a session
//     at `ask` can drive one at `bypass`. That escalation is the user's DELIBERATE decision (it was the
//     reviewer's HIGH finding #1), not an oversight.
//   - Approvals: a top-level code session messaging another forwards NOTHING — each shows its own cards in
//     its own window. Only Dispatch-spawned sessions forward cards through Dispatch, whoever messaged them
//     (`DispatchChildren`'s relay).
//   - ListAgents lists the subagents plus the peers RUNNING now: `working` (a turn or background work —
//     `makeSessionSignalsDeriver`) OR the `session.list` label `active` (a harness has it open), among
//     valid targets only. Never padded with idle ones (ListSessions finds those), and a cap is reported as
//     a count, never silently applied.
//
// WHAT A MESSAGE IS. The text goes in through the target's own driver (`send`, `clientName: "messaging"`),
// exactly as the user's `session.send` would: a live session reads it now or right after the turn it is
// running (`queued`), a finished resumable one is RESUMED for it through its driver (`ensure` — never the
// router's cold resume). Two renderings:
//   - Dispatch to its OWN child: the plain text, like the spawn's first prompt — Dispatch is the child's
//     delegate-user — and the child's turn is FOLLOWED (`DispatchChildren.expectFollowUp`, keyed on the
//     coordinator and the exact text: child_update running → completed and the coordinator's wake).
//   - Everyone else: an ATTRIBUTED turn (`<agent-message from="session:<sender>" …>`, the same frame the
//     runtime renders for an in-process peer), so the receiving model never mistakes another agent for its
//     human; it can answer with SendMessage to the sender's id. Not followed. (The Mac renders the wrapper
//     as "From session …", never raw.)
//
// ONE DELIVERY PER MESSAGE ID. A request is deduped on (caller, its runtime incarnation, runtime message
// id, target, text) for a
// while (`DELIVERY_DEDUPE_TTL_MS`): a re-sent request gets the first one's answer (in flight or settled),
// never a second delivery. A cancelled sender (the handler's `signal`) and a daemon that began shutting
// down are checked again right before anything is resumed or sent.
import { createHash } from "node:crypto";
import { buildSessionAddress, escapeAttributionText, type GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { HostMessageListAnswer, HostMessageSendAnswer, HostMessageSendRequest, HostMessagingHandler, HostReachableSession, HostSessionStopAnswer, HostSessionStopRequest } from "@yanlinglabs/winter-agent-sdk";
import type { Activity } from "../sessions/activity";
import { participatesInActivity } from "../sessions/activity";
import type { SessionRow } from "../sessions/store";
import { renderAttributedTurn } from "../runtime-sdk/messaging";
import { isSessionReplaced } from "../runtime-sdk/session-replaced";

/** The `clientName` a SendMessage delivery lands under in the target (`DispatchChildren`'s observer reads it). */
export const MESSAGING_CLIENT_NAME = "messaging";
/** A session id as the daemon mints it. */
const SESSION_ID = /^s_[0-9a-z]+$/i;
/** ListAgents shows at most this many sessions; the rest is reported as `omitted`. */
export const LIST_AGENTS_SESSION_MAX = 50;
/** How long a delivery's answer is remembered against its (caller, message id, target, text). */
export const DELIVERY_DEDUPE_TTL_MS = 10 * 60_000;
/** How many delivery answers are remembered at most (oldest dropped first). */
export const DELIVERY_DEDUPE_MAX = 500;

/** The refusal a chat session gets (it has no SendMessage; defensive). */
export const CHAT_SENDER_REFUSAL = "a chat session cannot message or stop other Winter sessions";
/** The refusal for a chat or dispatch TARGET (user ruling: only code and Cowork sessions). */
export const TARGET_MODE_REFUSAL = "only code and Cowork sessions can be messaged or stopped — not chat sessions or the dispatch session";

/** The slice of a session's live driver this file uses (`LegSession`). */
export interface MessagingDriverHandle {
  readonly turnRunning: boolean;
  /** `live` (a child is running), `resumable`, `ended` — absent on a test double, read as live. */
  readonly state?: "live" | "resumable" | "ended";
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  /** The session's own interrupt (`session.interrupt`, the Mac's stop button). Optional on a test double. */
  interrupt?(): Promise<{ wasRunning: boolean }>;
  /** Messages queued behind the running turn (`WinterSession.pendingSends`). Optional on a test double. */
  readonly pendingSends?: readonly string[];
}

export interface SessionMessagingDeps {
  store: {
    /** Throws for an unknown session. */
    meta(sessionId: string): { mode?: string; archived?: boolean; origin?: string; parentSessionId?: string; approvalPolicy?: string };
    list(): SessionRow[];
    getTitle?(sessionId: string): string | null;
  };
  /** THE activity derivation (`makeActivityDeriver`, what `session.list` and ListSessions stamp rows with). */
  derive: (row: SessionRow, sessionId: string, nowMs: number) => Activity | undefined;
  /** THE `working` signal (`makeSessionSignalsDeriver`: `turnRunning || bgWork`), what `session.list` reports per row. */
  working: (sessionId: string) => boolean;
  /** The driver table: `get` a live driver, `ensure` one (resuming a resumable session). */
  sessions: {
    get(sessionId: string): MessagingDriverHandle | undefined;
    ensure(sessionId: string): Promise<MessagingDriverHandle | undefined>;
  };
  /** Dispatch's follow-up hook (`DispatchChildren.expectFollowUp`): called before a coordinator's message
   *  to its OWN child; returns the undo for a send that fails. Absent until the daemon built it. */
  followUp?: () => { expectFollowUp(childId: string, coordinatorId: string, text: string): () => void } | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

type SendAnswer = HostMessageSendAnswer;

function refused(reason: string): SendAnswer {
  return { status: "refused", reason };
}

function senderClassOf(policy: string | undefined): GlobalAgentMessage["senderPermissionClass"] {
  if (policy === "bypass") return "bypasses";
  if (policy === undefined) return "unknown";
  return "prompts";
}

/** `s_x` or `session:s_x` (what ListAgents lists) → `s_x`; anything else → undefined. */
export function sessionIdFromAddress(to: string): string | undefined {
  const raw = to.trim();
  const id = raw.startsWith("session:") ? raw.slice("session:".length) : raw;
  return SESSION_ID.test(id) ? id : undefined;
}

type Meta = ReturnType<SessionMessagingDeps["store"]["meta"]>;

export class SessionMessaging {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private draining = false;
  /** (caller, message id, target, text digest) → the delivery's answer, in flight or settled. */
  private readonly deliveries = new Map<string, { at: number; answer: Promise<SendAnswer> }>();

  constructor(private readonly deps: SessionMessagingDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(`session-messaging: ${line}`));
  }

  /** Shutdown: nothing new is delivered (a message would resume a session into a daemon that is going away). */
  beginShutdown(): void {
    this.draining = true;
  }

  /**
   * `Options.hostMessaging` for the session `callerSessionId`. `incarnation` names the runtime child the
   * handler serves: its message ids (`msg-1`, `msg-2`, …) restart in every new process or Worker, so the
   * delivery dedupe is keyed on it too — a restarted coordinator's `msg-1` is a NEW message, never the
   * previous incarnation's.
   */
  handlerFor(callerSessionId: string, incarnation = ""): HostMessagingHandler {
    return {
      send: (request, opts) => this.send(callerSessionId, request, opts?.signal, incarnation),
      list: async () => this.list(callerSessionId),
      stop: (request, opts) => this.stop(callerSessionId, request, opts?.signal),
    };
  }

  /** The target checks every door shares: a session id, known, not the caller, code/Cowork. */
  private resolveTarget(callerSessionId: string, to: string): { id: string; meta: Meta } | { answer: { status: "refused" | "not_found"; reason: string } } {
    const id = sessionIdFromAddress(to);
    if (id === undefined) {
      return { answer: { status: "not_found", reason: `no agent or session named "${to}" is reachable — address a Winter session by its id (s_…), from SpawnSession, ListSessions or ListAgents` } };
    }
    if (id === callerSessionId) return { answer: { status: "refused", reason: "cannot target your own session" } };
    let meta: Meta;
    try { meta = this.deps.store.meta(id); } catch { return { answer: { status: "not_found", reason: `no Winter session '${id}'` } }; }
    if (!participatesInActivity(meta.mode)) return { answer: { status: "refused", reason: TARGET_MODE_REFUSAL } };
    return { id, meta };
  }

  /** One SendMessage the caller's runtime could not resolve in-process. Never throws. */
  send(callerSessionId: string, request: HostMessageSendRequest, signal?: AbortSignal, incarnation = ""): Promise<SendAnswer> {
    const key = [callerSessionId, incarnation, request.messageId, request.to.trim(), createHash("sha256").update(request.message).digest("hex")].join("\u0000");
    const at = this.now();
    for (const [k, v] of this.deliveries) {
      if (at - v.at <= DELIVERY_DEDUPE_TTL_MS && this.deliveries.size <= DELIVERY_DEDUPE_MAX) break;
      this.deliveries.delete(k);
    }
    const prior = this.deliveries.get(key);
    if (prior !== undefined && at - prior.at <= DELIVERY_DEDUPE_TTL_MS) return prior.answer;
    const answer = this.deliver(callerSessionId, request, signal);
    this.deliveries.set(key, { at, answer });
    // A delivery that never left the daemon (refused before anything ran, or cancelled) may be tried again.
    void answer.then((a) => { if (a.status === "unavailable" && a.retryable === true) this.deliveries.delete(key); });
    return answer;
  }

  private async deliver(callerSessionId: string, request: HostMessageSendRequest, signal: AbortSignal | undefined): Promise<SendAnswer> {
    const notDelivered = (why: string): SendAnswer => ({ status: "unavailable", reason: `${why}; nothing was delivered`, retryable: true });
    // A function, not a narrowed field: the signal can abort during the awaits below.
    const cancelled = (): boolean => signal?.aborted === true;
    if (this.draining) return notDelivered("Winter is shutting down");
    let caller: Meta;
    try { caller = this.deps.store.meta(callerSessionId); } catch { return refused("the sending session is not known to Winter"); }
    if (caller.mode === "chat") return refused(CHAT_SENDER_REFUSAL);

    const resolved = this.resolveTarget(callerSessionId, request.to);
    if ("answer" in resolved) return resolved.answer;
    const { id: targetId, meta: target } = resolved;
    if (target.archived === true) {
      return refused(`session '${targetId}' is archived — the user hid it, and a message never brings it back; only the user can restore it`);
    }
    if (request.message.trim() === "") return refused("the message is empty — write the session what you want it to do");

    // Dispatch following up its OWN child: plain text (the child's delegate-user), followed and woken.
    const ownChild = caller.mode === "dispatch" && target.origin === "dispatch-child" && target.parentSessionId === callerSessionId;
    // Plain, but never wrapper-shaped: any `<agent-message` sequence in Dispatch's own text is escaped the way an
    // attributed body is, so a model cannot write a "From session …" header the Mac would render as real.
    const text = ownChild ? escapeAttributionText(request.message) : renderAttributedTurn({
      messageId: request.messageId,
      from: buildSessionAddress(callerSessionId),
      fromGeneration: 0,
      to: buildSessionAddress(targetId),
      toGeneration: 0,
      body: request.message,
      ...(request.summary !== undefined ? { summary: request.summary } : {}),
      notifyWhenIdle: request.notifyWhenIdle === true,
      createdAt: this.now(),
      expiresAt: this.now(),
      hopCount: 0,
      senderPermissionClass: senderClassOf(caller.approvalPolicy),
    }, { winterSessionId: targetId });

    if (cancelled()) return notDelivered("the sender was interrupted");
    let driver: MessagingDriverHandle | undefined;
    let resumed = false;
    try {
      const live = this.deps.sessions.get(targetId);
      resumed = live === undefined || (live.state !== undefined && live.state !== "live");
      driver = live ?? await this.deps.sessions.ensure(targetId);
    } catch (err) {
      return { status: "unavailable", reason: `could not reopen session '${targetId}' to deliver the message: ${refusalText(err)}`, retryable: false };
    }
    if (driver === undefined) {
      return { status: "unavailable", reason: `session '${targetId}' has no runtime to resume, so it cannot be messaged`, retryable: false };
    }
    // Re-checked AFTER the (possibly long) resume: nothing goes in once the sender was cancelled or the
    // daemon began stopping while the target came up.
    if (this.draining) return notDelivered("Winter began shutting down");
    if (cancelled()) return notDelivered("the sender was interrupted");

    const undoFollowUp = ownChild ? this.deps.followUp?.()?.expectFollowUp(targetId, callerSessionId, text) : undefined;
    let sent: { queued: boolean };
    try {
      try {
        sent = await driver.send(text, MESSAGING_CLIENT_NAME);
      } catch (err) {
        // The target's runtime was replaced while it was starting (`session_replaced`): nothing was taken, so
        // the message goes ONCE to the session's next driver -- after the same shutdown/cancel re-checks.
        if (!isSessionReplaced(err)) throw err;
        const successor = this.deps.sessions.get(targetId) ?? await this.deps.sessions.ensure(targetId);
        if (successor === undefined || successor === driver) throw err;
        if (this.draining || cancelled()) throw err;
        resumed = resumed || (successor.state !== undefined && successor.state !== "live");
        sent = await successor.send(text, MESSAGING_CLIENT_NAME);
      }
    } catch (err) {
      undoFollowUp?.();
      this.log(`delivering a message from ${callerSessionId} to ${targetId} failed (${err instanceof Error ? err.name : "error"})`);
      // Still replaced after the retry (or nothing to retry on): transient -- the sender may simply send again.
      if (isSessionReplaced(err)) return notDelivered(`session '${targetId}' was restarting while the message was sent`);
      return { status: "unavailable", reason: `could not deliver the message to session '${targetId}': ${refusalText(err)}`, retryable: false };
    }

    const title = this.titleOf(targetId);
    const named = title === undefined ? `session ${targetId}` : `session ${targetId} ("${title}")`;
    const note = ownChild
      ? `${named} is your child: you'll be woken with a <child_update> when this turn finishes.`
      : `${named} is not one of your children, so you will not be told when it finishes${caller.mode === "dispatch" ? " — check on it with ListSessions" : ""}; it can answer you with SendMessage to ${callerSessionId}.`;
    const notify = request.notifyWhenIdle === true
      ? { refused: ownChild ? "no separate idle notice for a Winter session — the <child_update> wake is that notice" : "Winter sessions send no idle notice" }
      : undefined;
    return {
      status: sent.queued ? "queued" : resumed ? "resumed_and_delivered" : "delivered",
      note,
      ...(notify !== undefined ? { notify } : {}),
    };
  }

  /** `TaskStop` on a session id: interrupt its running turn (the Mac's stop button). Never throws. */
  async stop(callerSessionId: string, request: HostSessionStopRequest, signal?: AbortSignal): Promise<HostSessionStopAnswer> {
    if (this.draining) return { status: "unavailable", reason: "Winter is shutting down; nothing was stopped" };
    if (signal?.aborted === true) return { status: "unavailable", reason: "the caller was interrupted; nothing was stopped" };
    let caller: Meta;
    try { caller = this.deps.store.meta(callerSessionId); } catch { return { status: "refused", reason: "the calling session is not known to Winter" }; }
    if (caller.mode === "chat") return { status: "refused", reason: CHAT_SENDER_REFUSAL };
    const resolved = this.resolveTarget(callerSessionId, request.id);
    if ("answer" in resolved) {
      return resolved.answer.status === "not_found" ? { status: "not_found", reason: resolved.answer.reason } : { status: "refused", reason: resolved.answer.reason };
    }
    const driver = this.deps.sessions.get(resolved.id);
    if (driver === undefined || !driver.turnRunning || driver.interrupt === undefined) return { status: "not_running" };
    // What an interrupt does to the queue (`WinterSession.interrupt`: the drain is paused): messages held
    // behind the stopped turn do NOT run now — they stay in the session's log and run, in order, as soon
    // as the session receives its next message. Said in the answer, so the caller knows.
    const held = driver.pendingSends?.length ?? 0;
    try {
      const { wasRunning } = await driver.interrupt();
      if (!wasRunning) return { status: "not_running" };
      return held === 0
        ? { status: "stopped" }
        : { status: "stopped", note: `${held} message${held === 1 ? " was" : "s were"} queued behind that turn and did NOT run — ${held === 1 ? "it stays" : "they stay"} in the session's log and run${held === 1 ? "s" : ""}, in order, when the session receives its next message (SendMessage it to continue)` };
    } catch (err) {
      return { status: "unavailable", reason: `could not stop session '${resolved.id}': ${refusalText(err)}` };
    }
  }

  /** ListAgents' session rows for `callerSessionId`: the RUNNING code/Cowork peers (see the header), never itself. */
  list(callerSessionId: string): HostMessageListAnswer {
    let caller: { mode?: string };
    try { caller = this.deps.store.meta(callerSessionId); } catch { return { sessions: [] }; }
    if (caller.mode === "chat") return { sessions: [] };
    const at = this.now();
    const rows: SessionRow[] = [];
    for (const row of this.deps.store.list()) {
      if (row.sessionId === callerSessionId || !participatesInActivity(row.mode) || row.archived === true) continue;
      let activity: Activity | undefined;
      try { activity = this.deps.derive(row, row.sessionId, at); } catch { continue; }
      if (this.deps.working(row.sessionId) || activity === "active") rows.push(row);
    }
    const sessions: HostReachableSession[] = rows.slice(0, LIST_AGENTS_SESSION_MAX).map((row) => {
      const title = row.title?.replace(/\s+/g, " ").trim();
      return {
        address: `session:${row.sessionId}`,
        ...(title ? { name: title } : {}),
        status: this.deps.sessions.get(row.sessionId)?.turnRunning === true ? "running" : "idle",
        mode: row.mode ?? "code",
        ...(row.cwd ? { cwd: row.cwd } : {}),
      };
    });
    const omitted = rows.length - sessions.length;
    return { sessions, ...(omitted > 0 ? { omitted } : {}) };
  }

  private titleOf(sessionId: string): string | undefined {
    try { return this.deps.store.getTitle?.(sessionId) ?? undefined; } catch { return undefined; }
  }
}

/** A refusal's words for the model: the message plus its typed code (never a stack). */
function refusalText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code ?? (err as { data?: { code?: unknown } }).data?.code;
    return typeof code === "string" && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}
