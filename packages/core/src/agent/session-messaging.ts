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
//   - Host targets are Code sessions. Cowork peers additionally require active canonical
//     bindings to the same retained Project; activity participation is not authority.
//     Cowork creation/runtime execution is gated separately. Chat/dispatch targets are refused.
//   - Host SENDERS are whoever has the tool. Chat does not (its allowed list dropped SendMessage, ListAgents and
//     ReadNotifications), and a chat caller is refused here too, defensively.
//   - A message runs at the TARGET's own approval policy, with no card for the message itself — a session
//     at `ask` can drive one at `bypass`. That escalation is the user's DELIBERATE decision (it was the
//     reviewer's HIGH finding #1), not an oversight. This broader host-to-host ruling does
//     not allow Cowork to drive host sessions, or host sessions to drive Cowork without delegation.
//   - Approvals: a top-level code session messaging another forwards NOTHING — each shows its own cards in
//     its own window. Only Dispatch-spawned sessions forward cards through Dispatch, whoever messaged them
//     (`DispatchChildren`'s relay).
//   - ListAgents lists the subagents plus the peers RUNNING now: `working` (a turn or background work —
//     `makeSessionSignalsDeriver`) OR the `session.list` label `active` (a harness has it open), among
//     valid targets only. Never padded with idle ones (ListSessions finds those), and a cap is reported as
//     a count, never silently applied.
//
// WHAT A MESSAGE IS. The text goes in through the target's own driver under `clientName: "messaging"`. A
// session RUNNING a turn is STEERED (user ruling 2026-10-04, "fold the message into the running turn" —
// claude's behaviour): the text is pushed now and the child (agent SDK 0.0.44) folds it into that turn
// after its current tool call, or runs it as its next turn if the turn ends first — `delivered`, with a
// note saying so. NEVER past the session's own queue: when the daemon already holds sends behind the
// running turn (`pendingSends`), the message is `send`-queued behind them (FIFO, `queued`, the note says
// how many are ahead). An idle session gets it through `send`, exactly as the user's `session.send` would, and a
// finished resumable one is RESUMED for it through its driver (`ensure` — never the router's cold resume).
// A driver whose steer would not reach the running turn (`foldsQueuedInput` false: not live, ending, or a
// provider handoff pending, which holds a steer for the target) gets `send` (`queued`). Two
// renderings:
//   - Dispatch to its OWN child: the plain text, like the spawn's first prompt — Dispatch is the child's
//     delegate-user — and the child's turn is FOLLOWED (`DispatchChildren.expectFollowUp`, keyed on the
//     coordinator and the exact text: child_update running → completed and the coordinator's wake).
//   - Everyone else: an ATTRIBUTED turn (`<agent-message from="session:<sender>" …>`, the same frame the
//     runtime renders for an in-process peer), so the receiving model never mistakes another agent for its
//     human; it can answer with SendMessage to the sender's id. Not followed. (The Mac renders the wrapper
//     as "From session …", never raw.)
//
// COWORK PEERS GO THROUGH THE DURABLE PEER INBOX (docs/research/2026-10-18-cowork-peer-inbox-wiring.md). A SendMessage
// between two Cowork sessions of one Project is not pushed straight into the target: it is ACCEPTED by the receipt
// ledger (`cowork/peer-inbox.ts`, persisted before any answer, the body kept only while owed), then DELIVERED by
// `drainCoworkInbox` -- offer under the recipient driver's epoch, push through the same `deliverInto` (steer into a
// running turn, queue behind the daemon's own queue, resume a stopped one), and only then ACK, which deletes the
// body. An unacked offer is offered again (at-least-once). The inbox is an injected port (`deps.peerInbox`) that
// production does not supply while no Cowork session can exist; without it a Cowork pair fails closed. Code and
// Dispatch sessions never touch it: their path below is unchanged.
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
import { mayContactCoworkPeer, type CoworkMessagingRecords, type CoworkPeerOperation } from "../cowork/messaging-authority";
import { CoworkError } from "../cowork/types";
import type { CoworkPeerInbox, PeerEpoch } from "../cowork/peer-inbox";
import { CoworkHeldInputRefusal, coworkHoldToken, coworkHostMessageListAnswer, coworkHostMessageSendAnswer, type CoworkHeldInputVerbs } from "../cowork/held-input";
import { commitAndConfirm } from "../cowork/held-input-reconcile";

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
/** The refusal for a chat or dispatch TARGET, after the workspace authority check. */
export const TARGET_MODE_REFUSAL = "only code sessions can currently be messaged or stopped; chat and dispatch targets are unsupported";

/** The slice of a session's live driver this file uses (`LegSession`). */
export interface MessagingDriverHandle {
  readonly turnRunning: boolean;
  /** `live` (a child is running), `resumable`, `ended` — absent on a test double, read as live. */
  readonly state?: "live" | "resumable" | "ended";
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
  /** Push into the RUNNING turn now (`WinterSession.steer`). Optional on a test double. */
  steer?(text: string, clientName?: string): Promise<{ seq: number; injected: boolean }>;
  /** A steer now reaches the running turn (`WinterSession.foldsQueuedInput`). Absent: false. */
  readonly foldsQueuedInput?: boolean;
  /** The session's own interrupt (`session.interrupt`, the Mac's stop button); `discardQueued` also drops
   *  the messages held behind the stopped turn. Optional on a test double. */
  interrupt?(opts?: { discardQueued?: boolean }): Promise<{ wasRunning: boolean; discarded?: number }>;
  /** Messages queued behind the running turn (`WinterSession.pendingSends`). Optional on a test double. */
  readonly pendingSends?: readonly string[];
  /** A COWORK driver only: the recipient workspace's guest incarnation and lease epoch this driver was started under.
   *  The peer inbox fences every offer and ack on it. Absent (a Code/Dispatch driver, or a Cowork driver that has no
   *  epoch yet): nothing is offered and the message stays owed. */
  readonly coworkEpoch?: PeerEpoch;
  /** A COWORK driver only (#92 N4): the held-input verbs, present only behind the host's gate and for a runtime that offered
   *  `held-input-v1`. With them a message is HELD in the guest, acknowledged in the ledger, then committed (4.5); without
   *  them the driver takes `deliverInto` as before. */
  readonly heldInput?: CoworkHeldInputVerbs;
}

/** The slice of the receipt ledger this file uses. Not supplied by production while Cowork is refused. */
export type SessionMessagingPeerInbox = Pick<CoworkPeerInbox, "accept" | "lookup" | "owed" | "settle" | "offer" | "ack" | "block"> & Partial<Pick<CoworkPeerInbox, "verdict" | "confirmCommitted" | "deliveredUnconfirmed">>;

export interface SessionMessagingDeps {
  /** Canonical host DB bindings, never runtime-supplied workspace/project fields. */
  cowork?: CoworkMessagingRecords;
  /** The durable same-Project peer inbox (receipt ledger over its SQLite store). Absent: a Cowork-to-Cowork send is
   *  refused as unavailable and nothing is delivered. */
  peerInbox?: SessionMessagingPeerInbox;
  /** #92 4.5: a held peer message the guest turned out to have no record of (`unknown_input`, terminal). The composition shows
   *  it on the recipient's conversation (`coworkLostInputNotice` is the event's content). Absent: logged only. */
  noteLostPeerMessage?: (recipientSessionId: string, receiptId: string) => void;
  /** A recipient's held-input queue failed on transport or malformed answers `STALL_LIMIT` times in a row. Called once per stall
   *  (a success re-arms it); the composition shows `coworkStalledInboxNotice()` on that conversation. Absent: logged only. */
  noteStalledPeerInbox?: (recipientSessionId: string) => void;
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
  followUp?: () => {
    expectFollowUp(childId: string, coordinatorId: string, text: string): () => void;
    /** A stop door's note of who stopped a child's turn (`DispatchChildren.noteStop`) — TaskStop says the caller. */
    noteStop?(sessionId: string, by: { kind: "user" } | { kind: "session"; sessionId: string }): void;
  } | undefined;
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
  private authorityReadFaultLogged = false;
  /** (caller, message id, target, text digest) → the delivery's answer, in flight or settled. */
  private readonly deliveries = new Map<string, { at: number; answer: Promise<SendAnswer> }>();
  /** Cowork: the tail of each recipient's drain chain (one drain at a time per recipient). */
  private readonly drains = new Map<string, Promise<unknown>>();
  /** Cowork: how a receipt was delivered by a drain of this process (for the sender's answer), bounded. */
  private readonly stallCounts = new Map<string, number>();
  private readonly stalled = new Set<string>();
  private readonly commitRefusals = new Map<string, number>();
  private readonly coworkOutcomes = new Map<string, { queued: boolean; steered: boolean; behind: number; resumed: boolean }>();

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
    // A Cowork caller's answers leave through the DOOR validators (the guest's runtime refuses a malformed answer, and the call
    // would hang to its timeout): a send that cannot be shaped is `delivery_uncertain`, a list is empty.
    const cowork = (): boolean => { try { return this.deps.store.meta(callerSessionId).mode === "cowork"; } catch { return false; } };
    return {
      send: async (request, opts) => {
        const answer = await this.send(callerSessionId, request, opts?.signal, incarnation);
        if (!cowork()) return answer;
        try { return coworkHostMessageSendAnswer(answer) as SendAnswer; }
        catch { return { status: "delivery_uncertain", reason: "the host could not form a valid answer", retryable: false }; }
      },
      list: async () => {
        const answer = this.list(callerSessionId);
        if (!cowork()) return answer;
        try { return coworkHostMessageListAnswer(answer) as HostMessageListAnswer; } catch { return { sessions: [] }; }
      },
      stop: (request, opts) => this.stop(callerSessionId, request, opts?.signal),
    };
  }

  /** The target checks every door shares: a session id, known, not the caller, lifecycle-participating
   *  (code today; the predicate also reserves cowork). */
  private resolveTarget(callerSessionId: string, to: string, operation: CoworkPeerOperation = "send"): { id: string; meta: Meta } | { answer: { status: "refused" | "not_found"; reason: string } } {
    const id = sessionIdFromAddress(to);
    if (id === undefined) {
      return { answer: { status: "not_found", reason: `no agent or session named "${to}" is reachable — address a Winter session by its id (s_…), from SpawnSession, ListSessions or ListAgents` } };
    }
    if (id === callerSessionId) return { answer: { status: "refused", reason: "cannot target your own session" } };
    let meta: Meta, caller: Meta;
    const hidden = { answer: { status: "not_found" as const, reason: `no reachable Winter session '${id}'` } };
    try { caller = this.deps.store.meta(callerSessionId); } catch { return hidden; }
    try { meta = this.deps.store.meta(id); } catch {
      return caller.mode === "cowork" ? hidden : { answer: { status: "not_found", reason: `no Winter session '${id}'` } };
    }
    if (!this.mayContact(callerSessionId, caller, id, meta, operation)) return hidden;
    if (!participatesInActivity(meta.mode)) return { answer: { status: "refused", reason: TARGET_MODE_REFUSAL } };
    return { id, meta };
  }

  private mayContact(callerId: string, caller: Meta, targetId: string, target: Meta, operation: CoworkPeerOperation): boolean {
    if (caller.mode !== undefined && caller.mode !== "code" && caller.mode !== "dispatch" && caller.mode !== "cowork") return false;
    if (!this.consistentMode(callerId, caller) || !this.consistentMode(targetId, target)) return false;
    if (caller.mode !== "cowork" && target.mode !== "cowork") return true;
    if (caller.mode !== "cowork" || target.mode !== "cowork") return false;
    return mayContactCoworkPeer(this.deps.cowork, callerId, targetId, operation);
  }

  /** A stale/rebuilt session index cannot downgrade a canonical guest binding to host authority. */
  private consistentMode(sessionId: string, meta: Meta): boolean {
    if (!this.deps.cowork) return meta.mode !== "cowork";
    try { this.deps.cowork.binding(sessionId); return meta.mode === "cowork"; }
    catch (error) {
      if (error instanceof CoworkError && error.code === "not_found") return meta.mode !== "cowork";
      if (!this.authorityReadFaultLogged) {
        this.authorityReadFaultLogged = true;
        this.log("session_authority_unavailable: canonical conversation records could not be read; Cowork sessions are hidden until they can be");
      }
      // Messaging does not depend on the Cowork tables: only a row that CLAIMS to be Cowork degrades (hidden / refused). A Code or Dispatch
      // row stays listed and reachable, so a fault in tables no production daemon fills cannot take down ordinary messaging.
      return meta.mode !== "cowork";
    }
  }

  /** All-session discovery uses the same authority before query/count/path projection.
   * Listing oneself is permitted; it never authorizes send/stop to oneself. */
  mayList(callerSessionId: string, targetSessionId: string): boolean {
    try {
      const caller = this.deps.store.meta(callerSessionId), target = this.deps.store.meta(targetSessionId);
      if (caller.mode === "chat" || !participatesInActivity(target.mode)) return false;
      if (!this.consistentMode(callerSessionId, caller) || !this.consistentMode(targetSessionId, target)) return false;
      if (callerSessionId === targetSessionId && caller.mode === "cowork") {
        const binding = this.deps.cowork?.binding(callerSessionId);
        return binding?.sessionId === callerSessionId && binding.state === "active"
          && this.deps.cowork?.get(binding.workspaceId).state === "retained";
      }
      return this.mayContact(callerSessionId, caller, targetSessionId, target, "list");
    } catch { return false; }
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
    const answer = this.deliver(callerSessionId, request, signal, incarnation);
    this.deliveries.set(key, { at, answer });
    // A delivery that never left the daemon (refused before anything ran, or cancelled) may be tried again.
    void answer.then((a) => { if (a.status === "unavailable" && a.retryable === true) this.deliveries.delete(key); });
    return answer;
  }

  private async deliver(callerSessionId: string, request: HostMessageSendRequest, signal: AbortSignal | undefined, incarnation = ""): Promise<SendAnswer> {
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
    // A Cowork-to-Cowork pair (the only pair `mayContact` lets through when either end is Cowork) goes through the durable inbox.
    if (caller.mode === "cowork" && target.mode === "cowork") return this.deliverViaPeerInbox(callerSessionId, targetId, request, signal, incarnation);

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
    const current = this.resolveTarget(callerSessionId, targetId);
    if ("answer" in current) return current.answer;
    if (current.meta.archived) return refused("the receiving session was archived; nothing was delivered");

    const undoFollowUp = ownChild ? this.deps.followUp?.()?.expectFollowUp(targetId, callerSessionId, text) : undefined;
    let sent: { queued: boolean; steered: boolean; behind: number };
    try {
      try {
        sent = await deliverInto(driver, text);
      } catch (err) {
        // The target's runtime was replaced while it was starting (`session_replaced`): nothing was taken, so
        // the message goes ONCE to the session's next driver -- after the same shutdown/cancel re-checks.
        if (!isSessionReplaced(err)) throw err;
        const beforeRetry = this.resolveTarget(callerSessionId, targetId);
        if ("answer" in beforeRetry || beforeRetry.meta.archived) throw new Error("session messaging authority changed");
        const successor = this.deps.sessions.get(targetId) ?? await this.deps.sessions.ensure(targetId);
        if (successor === undefined || successor === driver) throw err;
        if (this.draining || cancelled()) throw err;
        const afterRetry = this.resolveTarget(callerSessionId, targetId);
        if ("answer" in afterRetry || afterRetry.meta.archived) throw new Error("session messaging authority changed");
        resumed = resumed || (successor.state !== undefined && successor.state !== "live");
        sent = await deliverInto(successor, text);
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
    const notOwn = `not one of your children, so you will not be told when it finishes${caller.mode === "dispatch" ? " — check on it with ListSessions" : ""}; it can answer you with SendMessage to ${callerSessionId}.`;
    // Steered (user ruling 2026-10-04): the running turn takes the message in at its next tool round.
    const note = sent.steered
      ? `${named} is working right now: it reads your message after its current tool call, as part of the turn it is running (or as its next turn, if that turn ends first). ${ownChild ? "You'll be woken with a <child_update> when that turn finishes." : `It is ${notOwn}`}`
      : sent.behind > 0
        ? `${named} is working right now and has ${sent.behind} message${sent.behind === 1 ? "" : "s"} queued ahead of yours, so yours runs after ${sent.behind === 1 ? "it" : "them"}, in order, once its current turn ends. ${ownChild ? "You'll be woken with a <child_update> when your message's turn finishes." : `It is ${notOwn}`}`
        : ownChild
        ? `${named} is your child: you'll be woken with a <child_update> when this turn finishes.`
        : `${named} is ${notOwn}`;
    const notify = request.notifyWhenIdle === true
      ? { refused: ownChild ? "no separate idle notice for a Winter session — the <child_update> wake is that notice" : "Winter sessions send no idle notice" }
      : undefined;
    return {
      status: sent.steered ? "delivered" : sent.queued ? "queued" : resumed ? "resumed_and_delivered" : "delivered",
      note,
      ...(notify !== undefined ? { notify } : {}),
    };
  }

  // ---- Cowork: the durable peer inbox ------------------------------------------------------------------------

  /** Accept (persist) first, then deliver what is owed to the recipient, then answer truthfully: delivered only if THIS
   *  message was acknowledged by the recipient, otherwise queued under its receipt. Never throws. */
  private async deliverViaPeerInbox(callerSessionId: string, targetId: string, request: HostMessageSendRequest, signal: AbortSignal | undefined, incarnation: string): Promise<SendAnswer> {
    const inbox = this.deps.peerInbox;
    const notDelivered = (why: string): SendAnswer => ({ status: "unavailable", reason: `${why}; nothing was delivered`, retryable: true });
    if (inbox === undefined) return { status: "unavailable", reason: "the Cowork peer inbox is not available; nothing was delivered", retryable: false };
    if (this.draining) return notDelivered("Winter is shutting down");
    // A restarted sender's message ids restart too: without its runtime incarnation a replay would be swallowed as a retry.
    if (incarnation === "") return refused("the sender's runtime identity is unknown; a Cowork message cannot be accepted without it");
    if (signal?.aborted === true) return notDelivered("the sender was interrupted");
    let receiptId: string;
    try {
      const accepted = inbox.accept({ senderSessionId: callerSessionId, senderIncarnation: incarnation, sendId: request.messageId, recipientSessionId: targetId, text: encodePeerEnvelope(request) });
      if (accepted.outcome === "refused") {
        switch (accepted.reason) {
          case "not_found": return { status: "not_found", reason: `no reachable Winter session '${targetId}'` };
          case "recipient_archived": return refused(`session '${targetId}' is archived — a message never brings it back; only the user can restore it`);
          default: return { status: "unavailable", reason: `session '${targetId}' cannot take more messages right now (${accepted.reason}); nothing was accepted`, retryable: true };
        }
      }
      receiptId = accepted.receipt.receiptId;
    } catch (err) {
      const code = err instanceof CoworkError ? err.code : undefined;
      if (code === "invalid_request") return refused("the message cannot be accepted (too large or malformed)");
      if (code === "request_conflict") return refused("this message id was already used for a different message");
      this.log(`accepting a Cowork peer message from ${callerSessionId} to ${targetId} failed (${code ?? (err instanceof Error ? err.name : "error")})`);
      return notDelivered("the peer inbox could not persist the message");
    }
    // Accepted: the daemon owes delivery from here on. A later failure leaves the receipt owed, never "not delivered".
    await this.drainCoworkInbox(targetId);
    let state: string, reason: string | null = null;
    try { const receipt = inbox.lookup({ senderSessionId: callerSessionId, senderIncarnation: incarnation, sendId: request.messageId }); state = receipt?.state ?? "accepted"; reason = receipt?.reason ?? null; }
    catch { state = "accepted"; }
    const title = this.titleOf(targetId);
    const named = title === undefined ? `session ${targetId}` : `session ${targetId} ("${title}")`;
    const notOwn = `not one of your children, so you will not be told when it finishes; it can answer you with SendMessage to ${callerSessionId}.`;
    const notify = request.notifyWhenIdle === true ? { refused: "Winter sessions send no idle notice" } : undefined;
    // Authority was lost between accept and delivery: the sender learns only the uniform answer; the record stays parked and visible.
    if (state === "blocked" && reason === "authority") return { status: "not_found", reason: `no reachable Winter session '${targetId}'` };
    if (state === "refused") return refused(`the message ${receiptId} was ended (${reason ?? "refused"}) before it was delivered`);
    if (state !== "delivered") {
      return { status: "queued", note: `${named} cannot take the message right now: the daemon holds it as receipt ${receiptId} and delivers it, in order, when the session is running again (it is not lost).`, ...(notify !== undefined ? { notify } : {}) };
    }
    const sent = this.coworkOutcomes.get(receiptId);
    const note = sent?.steered
      ? `${named} is working right now: it reads your message after its current tool call, as part of the turn it is running (or as its next turn, if that turn ends first). It is ${notOwn}`
      : sent !== undefined && sent.behind > 0
        ? `${named} is working right now and has ${sent.behind} message${sent.behind === 1 ? "" : "s"} queued ahead of yours, so yours runs after ${sent.behind === 1 ? "it" : "them"}, in order, once its current turn ends. It is ${notOwn}`
        : `${named} is ${notOwn}`;
    return { status: sent?.steered ? "delivered" : sent?.queued ? "queued" : sent?.resumed ? "resumed_and_delivered" : "delivered", note, ...(notify !== undefined ? { notify } : {}) };
  }

  /**
   * Deliver what the peer inbox owes `recipientSessionId`, oldest first, one at a time (a chain per recipient, so two
   * concurrent drains never offer the same head twice). Each message is offered under the recipient DRIVER's epoch,
   * pushed through `deliverInto` (the steer / queue / resume rules above) and only then acknowledged, which deletes its
   * body. Stops at the first message that cannot be delivered, leaving it (and everything behind it) owed. This is what
   * the workspace start and the daemon boot must call for every Cowork conversation so owed messages survive a
   * restart; it is a no-op without a peer inbox. Never throws.
   */
  drainCoworkInbox(recipientSessionId: string): Promise<void> {
    const previous = this.drains.get(recipientSessionId) ?? Promise.resolve();
    const run = previous.then(() => this.drainOnce(recipientSessionId)).catch((err) => {
      this.log(`draining the Cowork peer inbox of ${recipientSessionId} failed (${err instanceof Error ? err.name : "error"})`);
    });
    this.drains.set(recipientSessionId, run);
    void run.then(() => { if (this.drains.get(recipientSessionId) === run) this.drains.delete(recipientSessionId); });
    return run;
  }

  private async drainOnce(recipientId: string): Promise<void> {
    const inbox = this.deps.peerInbox;
    if (inbox === undefined) return;
    let replacedOnce = false;
    // Rule 3 (#92 4.5): finish what is already delivered before offering anything new.
    if (!(await this.repairHeldCommits(recipientId))) return;
    for (let delivered = 0; delivered < COWORK_DRAIN_MAX; delivered++) {
      if (this.draining) return;
      // Park or end what authority no longer allows, then: nothing runnable owed (empty, archived recipient, revoked pair) wakes nothing.
      try { inbox.settle(recipientId); if (inbox.owed(recipientId).runnable === 0) return; } catch { return; }
      let driver: MessagingDriverHandle | undefined, resumed = false;
      try {
        const live = this.deps.sessions.get(recipientId);
        resumed = live === undefined || (live.state !== undefined && live.state !== "live");
        driver = live ?? await this.deps.sessions.ensure(recipientId);
      } catch { return; }
      // The fence is the DRIVER's epoch, never a re-read of the database: a driver from a previous incarnation cannot ack.
      const epoch = driver?.coworkEpoch;
      if (driver === undefined || epoch === undefined || this.draining) return;
      let offer: ReturnType<SessionMessagingPeerInbox["offer"]>;
      try { offer = inbox.offer(recipientId, epoch); } catch { return; } // stale epoch or a store fault: stays owed
      if (offer === undefined) return;
      const envelope = parsePeerEnvelope(offer.body);
      if (envelope === undefined) { try { inbox.block(offer.receipt.receiptId, epoch, "recovery"); } catch { /* stays owed */ } return; }
      let policy: string | undefined;
      try { policy = this.deps.store.meta(offer.receipt.senderSessionId).approvalPolicy; } catch { policy = undefined; }
      const text = renderAttributedTurn({
        messageId: offer.receipt.sendId,
        from: buildSessionAddress(offer.receipt.senderSessionId),
        fromGeneration: 0,
        to: buildSessionAddress(recipientId),
        toGeneration: 0,
        body: envelope.message,
        ...(envelope.summary !== undefined ? { summary: envelope.summary } : {}),
        notifyWhenIdle: envelope.notifyWhenIdle,
        // From the receipt, so a re-offer after a restart renders the same frame.
        createdAt: offer.receipt.acceptedAt,
        expiresAt: offer.receipt.acceptedAt,
        hopCount: 0,
        senderPermissionClass: senderClassOf(policy),
      }, { winterSessionId: recipientId });
      if (driver.heldInput !== undefined) {
        // Two-phase delivery into a held-input guest: hold, ack (the commit point), then commit. Never `deliverInto`.
        if (!(await this.deliverHeld(recipientId, driver, driver.heldInput, epoch, offer, text, resumed))) return;
        continue;
      }
      let sent: { queued: boolean; steered: boolean; behind: number };
      try { sent = await deliverInto(driver, text); }
      catch (err) {
        // The recipient's runtime was replaced while the push was in flight: nothing was taken, so offer it ONCE more under the
        // successor (the offer re-checks authority and the successor's epoch first), as the Code path does.
        if (isSessionReplaced(err) && !replacedOnce) { replacedOnce = true; delivered--; continue; }
        this.log(`delivering a Cowork peer message to ${recipientId} failed (${err instanceof Error ? err.name : "error"}); it stays owed`);
        return;
      }
      try { inbox.ack({ receiptId: offer.receipt.receiptId, recipientSessionId: recipientId, epoch }); }
      catch (err) { this.log(`acknowledging a Cowork peer message to ${recipientId} failed (${err instanceof CoworkError ? err.code : "error"}); it stays owed`); return; }
      this.coworkOutcomes.set(offer.receipt.receiptId, { ...sent, resumed });
      while (this.coworkOutcomes.size > DELIVERY_DEDUPE_MAX) this.coworkOutcomes.delete(this.coworkOutcomes.keys().next().value as string);
    }
  }

  /** A typed refusal of a commit the ledger says was delivered (superseded, conflict, ...) cannot succeed by repetition. After
   *  COMMIT_REFUSAL_LIMIT of them the receipt is ended `lost` (surfaced, never retried) so the queue behind it is not stalled
   *  forever. A transport error is not a refusal and retries as before. True: it was ended. */
  private endRefusedCommit(recipientId: string, receiptId: string, err: unknown): boolean {
    // Only PERMANENT refusals count: a transient one (journal_full, journal_failed, epoch) says nothing about the input, which the
    // guest may still hold -- noting it lost would let a later reconcile deliver it anyway.
    if (!(err instanceof CoworkHeldInputRefusal) || !PERMANENT_COMMIT_REFUSALS.includes(err.code)) return false;
    const count = (this.commitRefusals.get(receiptId) ?? 0) + 1;
    this.commitRefusals.set(receiptId, count);
    if (count < COMMIT_REFUSAL_LIMIT) return false;
    try { this.deps.peerInbox?.confirmCommitted?.(receiptId, "lost"); } catch { return false; }
    this.commitRefusals.delete(receiptId);
    this.log(`a Cowork peer message ${receiptId} to ${recipientId} was refused ${err.code} ${count} times and is ended as lost`);
    this.noteLost(recipientId, receiptId);
    return true;
  }

  /** A failed step of a recipient's held-input queue (transport, malformed answer, a transient refusal). */
  private stallFailure(recipientId: string): void {
    const count = (this.stallCounts.get(recipientId) ?? 0) + 1;
    this.stallCounts.set(recipientId, count);
    if (count < STALL_LIMIT || this.stalled.has(recipientId)) return;
    this.stalled.add(recipientId);
    this.log(`the Cowork peer inbox of ${recipientId} has failed ${count} times in a row`);
    try { this.deps.noteStalledPeerInbox?.(recipientId); } catch { /* best effort */ }
  }
  private stallOk(recipientId: string): void { this.stallCounts.delete(recipientId); this.stalled.delete(recipientId); }

  private noteLost(recipientId: string, receiptId: string): void {
    try { this.deps.noteLostPeerMessage?.(recipientId, receiptId); } catch { /* the note is best effort; the ledger already says lost */ }
  }

  /** Rule 3: re-send `commit` for this recipient's delivered-but-unconfirmed held inputs, oldest first. False: stop the drain. */
  private async repairHeldCommits(recipientId: string): Promise<boolean> {
    const inbox = this.deps.peerInbox;
    const held = this.deps.sessions.get(recipientId)?.heldInput;
    if (inbox?.deliveredUnconfirmed === undefined || inbox.confirmCommitted === undefined || held === undefined) return true;
    try {
      for (const entry of inbox.deliveredUnconfirmed(recipientId)) {
        if (this.draining) return false;
        try {
          if ((await commitAndConfirm(inbox as Required<Pick<SessionMessagingPeerInbox, "confirmCommitted">>, held, entry.receiptId, entry.ackedHoldToken)) === "lost") {
            this.log(`a Cowork peer message ${entry.receiptId} to ${recipientId} was accepted but the guest had no record of it; it is not retried`);
            this.noteLost(recipientId, entry.receiptId);
          }
        } catch (err) { if (!this.endRefusedCommit(recipientId, entry.receiptId, err)) throw err; }
        this.stallOk(recipientId);
      }
      return true;
    } catch (err) {
      this.stallFailure(recipientId);
      this.log(`confirming held Cowork peer messages to ${recipientId} failed (${err instanceof CoworkError ? err.code : "error"}); nothing newer is offered`);
      return false;
    }
  }

  /** One offered message into a held-input guest (#92 4.5). True: it was committed (or ended as lost) and the drain goes on. */
  private async deliverHeld(recipientId: string, driver: MessagingDriverHandle, held: CoworkHeldInputVerbs, epoch: PeerEpoch, offer: NonNullable<ReturnType<SessionMessagingPeerInbox["offer"]>>, text: string, resumed: boolean): Promise<boolean> {
    const inbox = this.deps.peerInbox;
    if (inbox?.verdict === undefined || inbox.confirmCommitted === undefined) return false; // a ledger without the held-input methods cannot do this
    const receiptId = offer.receipt.receiptId;
    let token: string, answer: Awaited<ReturnType<CoworkHeldInputVerbs["hold"]>>;
    try {
      token = coworkHoldToken(receiptId, epoch.incarnationId, epoch.leaseEpoch, offer.offerCount);
      answer = await held.hold({ inputId: receiptId, holdToken: token, text, clientName: MESSAGING_CLIENT_NAME });
    } catch (err) {
      const code = err instanceof CoworkError ? err.code : undefined;
      // A message the guest can never hold (too large for its frame) must not wedge the queue behind it: parked for recovery.
      if (code === "invalid_request") { try { inbox.block(receiptId, epoch, "recovery"); } catch { /* stays owed */ } }
      else if (!(err instanceof CoworkHeldInputRefusal && err.code !== "epoch" && err.code !== "journal_full" && err.code !== "journal_failed")) this.stallFailure(recipientId);
      this.log(`holding a Cowork peer message for ${recipientId} failed (${code ?? (err instanceof Error ? err.name : "error")}); it stays owed`);
      return false;
    }
    const discard = async (): Promise<void> => {
      // Never discard what the guest already holds as committed or in its transcript.
      if (answer.held === true) { try { await held.discard(receiptId, token); } catch { /* best effort: reconciliation decides it later */ } }
    };
    let ackedToken = token;
    try { inbox.ack({ receiptId, recipientSessionId: recipientId, epoch, holdToken: token }); }
    catch (err) {
      if (err instanceof CoworkError && err.code === "authority_denied") { await discard(); return false; }
      // Any other throw: the ledger says whether the ack landed. If that cannot be read either, decide nothing.
      let verdict: ReturnType<NonNullable<SessionMessagingPeerInbox["verdict"]>>;
      try { verdict = inbox.verdict(receiptId, recipientId); } catch { return false; }
      if (verdict.action !== "commit") { await discard(); return false; }
      ackedToken = verdict.ackedHoldToken;
    }
    // The guest already owns it (committed or in its transcript): the ack landed, so it is confirmed `already` WITHOUT a commit
    // (a commit under the new token would be refused `superseded` forever). Never discarded.
    if (answer.held === false) {
      try { inbox.confirmCommitted(receiptId, "already"); } catch (err) { this.log(`confirming a Cowork peer message to ${recipientId} failed (${err instanceof CoworkError ? err.code : "error"}); the next drain repeats it`); return false; }
      this.coworkOutcomes.set(receiptId, { queued: false, steered: false, behind: 0, resumed });
      return true;
    }
    let result: Awaited<ReturnType<typeof commitAndConfirm>>;
    try { result = await commitAndConfirm(inbox as Required<Pick<SessionMessagingPeerInbox, "confirmCommitted">>, held, receiptId, ackedToken); }
    catch (err) {
      if (this.endRefusedCommit(recipientId, receiptId, err)) return true;
      this.stallFailure(recipientId); this.log(`committing a Cowork peer message to ${recipientId} failed (${err instanceof CoworkError ? err.code : "error"}); the next drain repeats it`); return false; }
    if (result === "lost") { this.log(`a Cowork peer message ${receiptId} to ${recipientId} was accepted but the guest had no record of it; it is not retried`); this.noteLost(recipientId, receiptId); return true; }
    this.stallOk(recipientId);
    this.coworkOutcomes.set(receiptId, { queued: result === "queued", steered: result === "folded", behind: 0, resumed });
    while (this.coworkOutcomes.size > DELIVERY_DEDUPE_MAX) this.coworkOutcomes.delete(this.coworkOutcomes.keys().next().value as string);
    return true;
  }

  /** `TaskStop` on a session id: interrupt its running turn and clear what was queued behind it. Never throws. */
  async stop(callerSessionId: string, request: HostSessionStopRequest, signal?: AbortSignal): Promise<HostSessionStopAnswer> {
    if (this.draining) return { status: "unavailable", reason: "Winter is shutting down; nothing was stopped" };
    if (signal?.aborted === true) return { status: "unavailable", reason: "the caller was interrupted; nothing was stopped" };
    let caller: Meta;
    try { caller = this.deps.store.meta(callerSessionId); } catch { return { status: "refused", reason: "the calling session is not known to Winter" }; }
    if (caller.mode === "chat") return { status: "refused", reason: CHAT_SENDER_REFUSAL };
    const resolved = this.resolveTarget(callerSessionId, request.id, "stop");
    if ("answer" in resolved) {
      return resolved.answer.status === "not_found" ? { status: "not_found", reason: resolved.answer.reason } : { status: "refused", reason: resolved.answer.reason };
    }
    const driver = this.deps.sessions.get(resolved.id);
    if (driver === undefined || !driver.turnRunning || driver.interrupt === undefined) return { status: "not_running" };
    // A stop clears the queue too (user ruling 2026-10-04): the messages queued behind the stopped turn are
    // dropped — the ones the daemon holds once the turn has ended, and the steered-in ones the child holds
    // pending (agent SDK 0.0.44 `clearQueuedInput`, cleared BEFORE the interrupt, which would keep them) —
    // so the next message the session gets runs straight away, never a stale one first. Said in the
    // answer, so the caller knows. (A message already folded into the stopped turn was read; nothing to drop.)
    // Said before the interrupt, so a Dispatch child's report names the stopper ("Stopped by you (TaskStop).").
    try { this.deps.followUp?.()?.noteStop?.(resolved.id, { kind: "session", sessionId: callerSessionId }); } catch { /* the stop goes on */ }
    try {
      const { wasRunning, discarded = 0 } = await driver.interrupt({ discardQueued: true });
      if (!wasRunning) return { status: "not_running" };
      return discarded === 0
        ? { status: "stopped" }
        : { status: "stopped", note: `${discarded} message${discarded === 1 ? " was" : "s were"} queued behind that turn — ${discarded === 1 ? "it was" : "they were"} cleared and will not run. SendMessage the session to give it new work.` };
    } catch (err) {
      return { status: "unavailable", reason: `could not stop session '${resolved.id}': ${refusalText(err)}` };
    }
  }

  /** ListAgents' running, authorized peers. Cowork membership is read from the host DB. */
  list(callerSessionId: string): HostMessageListAnswer {
    let caller: Meta;
    try { caller = this.deps.store.meta(callerSessionId); } catch { return { sessions: [] }; }
    if (caller.mode === "chat") return { sessions: [] };
    const at = this.now();
    const rows: SessionRow[] = [];
    for (const row of this.deps.store.list()) {
      if (row.sessionId === callerSessionId || !participatesInActivity(row.mode) || row.archived === true) continue;
      let target: Meta;
      try { target = this.deps.store.meta(row.sessionId); } catch { continue; }
      if (!this.mayContact(callerSessionId, caller, row.sessionId, target, "list")) continue;
      let activity: Activity | undefined;
      try { activity = this.deps.derive(row, row.sessionId, at); } catch { continue; }
      if (this.deps.working(row.sessionId) || activity === "active") rows.push({ ...row, mode: target.mode });
    }
    const sessions: HostReachableSession[] = rows.slice(0, LIST_AGENTS_SESSION_MAX).map((row) => {
      const title = row.title?.replace(/\s+/g, " ").trim();
      return {
        address: `session:${row.sessionId}`,
        ...(title ? { name: title } : {}),
        status: this.deps.sessions.get(row.sessionId)?.turnRunning === true ? "running" : "idle",
        mode: row.mode ?? "code",
        ...(row.cwd && row.mode !== "cowork" ? { cwd: row.cwd } : {}),
      };
    });
    const omitted = rows.length - sessions.length;
    return { sessions, ...(omitted > 0 ? { omitted } : {}) };
  }

  private titleOf(sessionId: string): string | undefined {
    try { return this.deps.store.getTitle?.(sessionId) ?? undefined; } catch { return undefined; }
  }
}

/**
 * One delivery into `driver` (user ruling 2026-10-04, "fold the message into the running turn"): a target
 * RUNNING a turn on a child that folds (agent SDK 0.0.44) is STEERED — the message is pushed now and the
 * child takes it into that turn after its current tool call (or runs it as its next turn, if the turn ends
 * first); anything else — an idle or finished target, or one whose steer would not reach the running turn
 * (`foldsQueuedInput` false) — goes through `send`, the session's own queue. The same door rules carry a ComputerV2
 * wake trigger's message (`computer-use/wakes/delivery.ts`, under its own `clientName`).
 */
export async function deliverInto(driver: MessagingDriverHandle, text: string, clientName: string = MESSAGING_CLIENT_NAME): Promise<{ queued: boolean; steered: boolean; behind: number }> {
  const live = driver.state === undefined || driver.state === "live";
  // FIFO with the session's own queue: messages the daemon already holds behind the running turn (the
  // user's queued sends) run first, so a message is never steered PAST them — it queues behind them.
  const behind = driver.pendingSends?.length ?? 0;
  if (live && driver.turnRunning && behind === 0 && driver.foldsQueuedInput === true && driver.steer !== undefined) {
    // What actually happened, not what was asked: a steer that found no running turn (it ended meanwhile)
    // or was held for a provider switch is not "in the running turn".
    const { injected } = await driver.steer(text, clientName);
    return { queued: false, steered: injected, behind: 0 };
  }
  const { queued } = await driver.send(text, clientName);
  return { queued, steered: false, behind: queued ? behind : 0 };
}

/** A refusal's words for the model: the message plus its typed code (never a stack). */
function refusalText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code ?? (err as { data?: { code?: unknown } }).data?.code;
    return typeof code === "string" && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/** At most this many owed messages are delivered by one drain (a runaway guard; the rest stay owed for the next). */
const COWORK_DRAIN_MAX = 1_024;
/** How many typed refusals of one delivered commit end its receipt as lost. */
const COMMIT_REFUSAL_LIMIT = 3;
const PERMANENT_COMMIT_REFUSALS: readonly string[] = ["superseded", "conflict", "committed", "invalid"];
/** Consecutive failed drains of one recipient's held-input queue before the user is told. */
const STALL_LIMIT = 3;

/** What the peer inbox stores for one Cowork message: the text AND the fields the model later sees, versioned. The
 *  rendered frame is never stored (it carries timestamps), so a retry digests to the same bytes and a restart loses
 *  neither `summary` nor `notifyWhenIdle`. */
interface PeerEnvelope { v: 1; message: string; summary?: string; notifyWhenIdle: boolean }
function encodePeerEnvelope(request: HostMessageSendRequest): string {
  const envelope: PeerEnvelope = { v: 1, message: request.message, ...(request.summary !== undefined ? { summary: request.summary } : {}), notifyWhenIdle: request.notifyWhenIdle === true };
  return JSON.stringify(envelope);
}
function parsePeerEnvelope(body: string): PeerEnvelope | undefined {
  try {
    const value = JSON.parse(body) as Partial<PeerEnvelope> | null;
    if (value !== null && typeof value === "object" && value.v === 1 && typeof value.message === "string" && value.message.trim() !== ""
      && (value.summary === undefined || typeof value.summary === "string") && typeof value.notifyWhenIdle === "boolean") return value as PeerEnvelope;
  } catch { /* damaged */ }
  return undefined;
}
