// SendMessage between Winter sessions: the daemon's half of the agent SDK's `Options.hostMessaging`.
//
// WHY THIS EXISTS. A session's `SendMessage` runs inside its own runtime child (a `winter` process for a
// code session, a Worker for chat and dispatch), and that child can resolve only what it holds: its own
// subagents and itself. Every other Winter session lives in another child, so before agent SDK 0.0.39 a
// message to one answered `not_found … is currently reachable` (dev, 2026-10-02: Dispatch could not
// follow up a single child). Since 0.0.39 the runtime asks its HOST for anything it cannot resolve
// in-process (`host_message_send`) and for the rows ListAgents adds (`host_message_list`). This file
// answers both, one handler per session, built in `session-driver.ts`'s `optionsFor` beside
// `onCredentialResolve`. The caller is the session whose handler fired — never a field of the request.
//
// USER RULINGS (2026-10-02). SendMessage is the ONE tool that sends a message to a session and resumes
// it (ManageSession never does). It can reach anyone: its own subagents (in-process, never here) and any
// recorded session, finished ones included — a session id from ListSessions must work even though
// ListAgents would not list it. ListAgents lists the subagents plus the peer sessions that are RUNNING
// right now, by the daemon's OWN two definitions in `sessions/activity.ts` (no third notion of "active"):
// a session whose lifecycle label (`activityFor`, what `session.list` and ListSessions show) is `active`
// (a harness has it open), or `background` AND `working` (`makeSessionSignalsDeriver`'s `working`: a turn
// or background work in flight). Never idle, archived, or a background-flagged session doing nothing —
// every dispatch child carries that flag from birth, finished or not.
//
// WHAT A MESSAGE IS. The text goes in through the target's own driver (`send`, `clientName:
// "messaging"`), exactly as the user's `session.send` would: a live session reads it now or right after
// the turn it is running (`queued`), a finished resumable one is RESUMED for it through its driver
// (`ensure` — never the router's cold resume). It runs at the TARGET's own approval policy; nothing about
// the sender's policy travels with it. Two renderings:
//   - Dispatch to its OWN child: the plain text, like the spawn's first prompt — Dispatch is the child's
//     delegate-user — and the child's turn is FOLLOWED (`DispatchChildren.expectFollowUp`: child_update
//     running → completed and the coordinator's wake), with the child put back on background duty first.
//   - Everyone else: an ATTRIBUTED turn (`<agent-message from="session:<sender>" …>`, the same frame the
//     runtime renders for an in-process peer), so the receiving model never mistakes another agent for
//     its human; it can answer with SendMessage to the sender's id. Not followed.
//
// WHO MAY MESSAGE WHOM. Any code/cowork/dispatch session may message any other session that is not
// archived (the user hid it; resume it first) and not itself. CHAT may message no other session
// (decided conservatively: a chat session has no files, no shell and never asks for approval, and
// letting it drive a code session at that session's policy would hand chat exactly those tools by proxy);
// its ListAgents lists no sessions either.
import { buildSessionAddress, type GlobalAgentMessage } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { HostMessageListAnswer, HostMessageSendAnswer, HostMessageSendRequest, HostMessagingHandler, HostReachableSession } from "@yanlinglabs/winter-agent-sdk";
import type { Activity } from "../sessions/activity";
import { participatesInActivity } from "../sessions/activity";
import type { SessionRow } from "../sessions/store";
import { renderAttributedTurn } from "../runtime-sdk/messaging";

/** The `clientName` a SendMessage delivery lands under in the target (`DispatchChildren`'s observer reads it). */
export const MESSAGING_CLIENT_NAME = "messaging";
/** A session id as the daemon mints it. */
const SESSION_ID = /^s_[0-9a-z]+$/i;
/** ListAgents shows at most this many sessions (the SDK caps a host listing at 200; this is the daemon's own, smaller bound). */
export const LIST_AGENTS_SESSION_MAX = 50;

/** The refusal a chat session gets (its reach is none, see the header). */
export const CHAT_SENDER_REFUSAL = "a chat session cannot message other Winter sessions";

/** The slice of a session's live driver this file uses (`LegSession`). */
export interface MessagingDriverHandle {
  readonly turnRunning: boolean;
  /** `live` (a child is running), `resumable`, `ended` — absent on a test double, read as live. */
  readonly state?: "live" | "resumable" | "ended";
  send(text: string, clientName?: string): Promise<{ seq: number; queued: boolean }>;
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
  followUp?: () => { expectFollowUp(childId: string, coordinatorId: string): () => void } | undefined;
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

export class SessionMessaging {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private draining = false;

  constructor(private readonly deps: SessionMessagingDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.error(`session-messaging: ${line}`));
  }

  /** Shutdown: nothing new is delivered (a message would resume a session into a daemon that is going away). */
  beginShutdown(): void {
    this.draining = true;
  }

  /** `Options.hostMessaging` for the session `callerSessionId`. */
  handlerFor(callerSessionId: string): HostMessagingHandler {
    return {
      send: (request) => this.send(callerSessionId, request),
      list: async () => this.list(callerSessionId),
    };
  }

  /** One SendMessage the caller's runtime could not resolve in-process. Never throws. */
  async send(callerSessionId: string, request: HostMessageSendRequest): Promise<SendAnswer> {
    if (this.draining) return { status: "unavailable", reason: "Winter is shutting down; nothing was delivered", retryable: true };
    let caller: ReturnType<SessionMessagingDeps["store"]["meta"]>;
    try { caller = this.deps.store.meta(callerSessionId); } catch { return refused("the sending session is not known to Winter"); }
    if (caller.mode === "chat") return refused(CHAT_SENDER_REFUSAL);

    const targetId = sessionIdFromAddress(request.to);
    if (targetId === undefined) {
      return { status: "not_found", reason: `no agent or session named "${request.to}" is reachable — address a Winter session by its id (s_…), from SpawnSession, ListSessions or ListAgents` };
    }
    if (targetId === callerSessionId) return refused("cannot SendMessage to your own session");
    let target: ReturnType<SessionMessagingDeps["store"]["meta"]>;
    try { target = this.deps.store.meta(targetId); } catch { return { status: "not_found", reason: `no Winter session '${targetId}'` }; }
    if (target.archived === true) {
      return refused(`session '${targetId}' is archived — the user hid it, and a message never brings it back; it has to be resumed (un-archived) first, and only if the user wants it back`);
    }
    if (request.message.trim() === "") {
      return refused("notify_when_idle on its own is not supported for Winter sessions — send a message");
    }

    // Dispatch following up its OWN child: plain text (the child's delegate-user), followed and woken.
    const ownChild = caller.mode === "dispatch" && target.origin === "dispatch-child" && target.parentSessionId === callerSessionId;
    const text = ownChild ? request.message : renderAttributedTurn({
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

    const undoFollowUp = ownChild ? this.deps.followUp?.()?.expectFollowUp(targetId, callerSessionId) : undefined;
    let sent: { queued: boolean };
    try {
      sent = await driver.send(text, MESSAGING_CLIENT_NAME);
    } catch (err) {
      undoFollowUp?.();
      this.log(`delivering a message from ${callerSessionId} to ${targetId} failed (${err instanceof Error ? err.name : "error"})`);
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

  /** ListAgents' session rows for `callerSessionId`: the RUNNING peers (active, or background and working — see the header), never itself. */
  list(callerSessionId: string): HostMessageListAnswer {
    let caller: { mode?: string };
    try { caller = this.deps.store.meta(callerSessionId); } catch { return { sessions: [] }; }
    if (caller.mode === "chat") return { sessions: [] };
    const at = this.now();
    const rows: Array<{ row: SessionRow; activity: Activity }> = [];
    for (const row of this.deps.store.list()) {
      if (row.sessionId === callerSessionId || !participatesInActivity(row.mode)) continue;
      let activity: Activity | undefined;
      try { activity = this.deps.derive(row, row.sessionId, at); } catch { continue; }
      if (activity === "active" || (activity === "background" && this.deps.working(row.sessionId))) rows.push({ row, activity });
    }
    const sessions: HostReachableSession[] = rows.slice(0, LIST_AGENTS_SESSION_MAX).map(({ row }) => {
      const title = row.title?.replace(/\s+/g, " ").trim();
      return {
        address: `session:${row.sessionId}`,
        ...(title ? { name: title } : {}),
        status: this.deps.sessions.get(row.sessionId)?.turnRunning === true ? "running" : "idle",
        mode: row.mode ?? "code",
        ...(row.cwd ? { cwd: row.cwd } : {}),
      };
    });
    return { sessions };
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
