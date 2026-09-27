// WS-27: MCP URL-mode elicitation — an MCP server asks the user to open a link (for example to finish
// an authorization with a third party). The agent SDK forwards the server's `elicitation/create` to
// `Options.onElicitation`; this module is that handler, one per session, plus the small broker the
// `elicitation.respond` RPC answers into.
//
// The rules, each enforced here and nowhere else:
//   - URL mode ONLY. A form-mode request (or one naming no mode) is declined deterministically, with
//     no card — Winter renders no forms for an MCP server.
//   - https only, a bounded url with no embedded credentials; anything else is declined without a card.
//   - A card, never an automatic open: `accept` means the USER chose to open the link, and the client
//     opens it (the Mac does). The daemon opens nothing.
//   - It is a connector prompt (WS-26): it cards in code, chat and dispatch sessions alike, while a
//     dispatch CHILD keeps its never-prompt rule and declines, as does a `dont-ask` session.
//   - The url may carry a one-time code, so no log line here ever names more than its origin.
//
// Its own broker rather than `ApprovalBroker`: `approval.respond` and `approval.list` are reachable
// from the phone (`REMOTE_ALLOWED_METHODS`), and neither may answer or list one of these — the phone
// cannot open a link on the Mac. `elicitation.respond` is local-only.

import type { NewSessionEvent } from "@yanlinglabs/winter-protocol";
import {
  ELICITATION_MESSAGE_MAX_LENGTH,
  ELICITATION_SERVER_NAME_MAX_LENGTH,
  ELICITATION_URL_MAX_LENGTH,
  ELICITATION_HOST_MAX_LENGTH,
} from "@yanlinglabs/winter-protocol";
import type { Options } from "@yanlinglabs/winter-agent-sdk";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { consoleBridgeLogger, type BridgeLogger } from "./bridge-common";

export type OnElicitation = NonNullable<Options["onElicitation"]>;
export type ElicitationAction = "accept" | "decline" | "cancel";
export interface ElicitationOutcome { action: ElicitationAction; by: string }

/** How long a card waits for an answer before the daemon cancels it. The runtime's own request has no
 *  deadline, and only the session's end aborts it, so this is what bounds a card nobody answers (the
 *  server's own request timeout usually ends the wait on its side well before). */
export const ELICITATION_CARD_TIMEOUT_MS = 10 * 60_000;

interface PendingEntry {
  sessionId: string;
  elicitationId: string;
  resolve: (o: ElicitationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-flight URL-mode elicitations, keyed by sessionId+elicitationId. First response wins, like
 *  `ApprovalBroker`; a second answer reports `alreadyResolved`. */
export class ElicitationBroker {
  private pending = new Map<string, PendingEntry>();

  private key(sessionId: string, elicitationId: string): string { return `${sessionId}:${elicitationId}`; }

  wait(sessionId: string, elicitationId: string, timeoutMs: number): Promise<ElicitationOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, elicitationId);
      const timer = setTimeout(() => {
        this.pending.delete(k);
        resolve({ action: "cancel", by: "timeout" });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(k, { sessionId, elicitationId, resolve, timer });
    });
  }

  respond(sessionId: string, elicitationId: string, action: ElicitationAction, by: string): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, elicitationId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ action, by });
    return { ok: true, alreadyResolved: false };
  }

  /** Cancels every card still pending for a session (its turn ended with them outstanding). */
  cancelSession(sessionId: string, by: string): number {
    let n = 0;
    for (const e of [...this.pending.values()]) {
      if (e.sessionId !== sessionId) continue;
      this.respond(sessionId, e.elicitationId, "cancel", by);
      n++;
    }
    return n;
  }

  /** The ids still pending for a session, oldest first. */
  pendingIds(sessionId: string): string[] {
    return [...this.pending.values()].filter((e) => e.sessionId === sessionId).map((e) => e.elicitationId);
  }
}

export type ElicitationUrlCheck =
  | { ok: true; url: string; host: string; origin: string }
  | { ok: false; reason: string };

/** Whether a URL-mode elicitation's url may be shown on a card. `reason` never contains the url
 *  itself (at most its scheme), because it is logged. The returned `url` is the parser's own
 *  serialization — what the card shows is exactly what the client opens. */
export function checkElicitationUrl(raw: unknown): ElicitationUrlCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "no url" };
  // Capped BEFORE parsing: a parser is not handed an unbounded string.
  if (raw.length > ELICITATION_URL_MAX_LENGTH) return { ok: false, reason: `url longer than ${ELICITATION_URL_MAX_LENGTH} characters` };
  // No whitespace or control characters at all: the parser would silently strip some of them, and a
  // url that is not what it looks like has no place on a card.
  if (/[\u0000- \u007f-\u009f]/.test(raw)) return { ok: false, reason: "url contains whitespace or control characters" };
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return { ok: false, reason: "url does not parse" }; }
  if (parsed.protocol !== "https:") return { ok: false, reason: `scheme ${JSON.stringify(parsed.protocol)} is not https` };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "url carries credentials before its host" };
  if (parsed.hostname === "") return { ok: false, reason: "url names no host" };
  const url = parsed.href;
  if (url.length > ELICITATION_URL_MAX_LENGTH) return { ok: false, reason: `url longer than ${ELICITATION_URL_MAX_LENGTH} characters` };
  if (parsed.host.length > ELICITATION_HOST_MAX_LENGTH) return { ok: false, reason: "host too long" };
  return { ok: true, url, host: parsed.host, origin: parsed.origin };
}

/** Bounds a display string, marking a cut with an ellipsis (inside the cap). */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A server name for a log line or a card: one line, bounded, never empty. */
function displayServerName(name: string): string {
  const oneLine = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return capText(oneLine === "" ? "unnamed server" : oneLine, ELICITATION_SERVER_NAME_MAX_LENGTH);
}

export interface UrlElicitationDeps {
  sessionId: string;
  mode: SessionMode;
  /** `SessionMeta.origin`; `"dispatch-child"` never prompts. */
  origin?: string;
  /** Live: `session.setPolicy` mid-session is seen by the next request. */
  policy: () => SessionApprovalPolicy | undefined;
  broker: ElicitationBroker;
  emit: (event: NewSessionEvent) => void;
  log?: BridgeLogger;
  now?: () => number;
  timeoutMs?: number;
  threadId?: string;
}

const DECLINE = { action: "decline" } as const;

/** `Options.onElicitation` for one session. Never throws: every failure is a decline or a cancel. */
export function elicitationHandlerFor(deps: UrlElicitationDeps): OnElicitation {
  const log = deps.log ?? consoleBridgeLogger;
  const now = deps.now ?? Date.now;
  const threadId = deps.threadId ?? "main";
  const { sessionId } = deps;
  return async (request, { signal, requestId }) => {
    const server = displayServerName(typeof request.serverName === "string" ? request.serverName : "");
    const declineBecause = (why: string) => {
      log.info(`elicitation: declined session=${sessionId} server=${JSON.stringify(server)} reason=${why}`);
      return DECLINE;
    };
    // Form mode (and a request naming no mode, which MCP reads as form) is never shown.
    if (request.mode !== "url") return declineBecause(`${request.mode === undefined ? "no" : "form"} mode — only URL-mode elicitation is supported`);
    const check = checkElicitationUrl(request.url);
    if (!check.ok) return declineBecause(check.reason);
    if (deps.origin === "dispatch-child") return declineBecause("a dispatch child never prompts");
    if (deps.policy() === "dont-ask") return declineBecause("policy dont-ask declines every prompt");
    if (signal.aborted) return { action: "cancel" };

    const elicitationId = `el_${requestId}`;
    const message = capText(typeof request.message === "string" ? request.message : "", ELICITATION_MESSAGE_MAX_LENGTH);
    const timeoutMs = deps.timeoutMs ?? ELICITATION_CARD_TIMEOUT_MS;
    const issuedAt = now();
    // Wait registered BEFORE the emit: the append is synchronous, and a client answering the moment
    // it sees the card would otherwise answer an unregistered wait.
    const waiting = deps.broker.wait(sessionId, elicitationId, timeoutMs);
    try {
      deps.emit({
        type: "elicitation_requested", sessionId, threadId, elicitationId, mode: "url",
        serverName: server, message, url: check.url, host: check.host,
        issuedAt, expiresAt: issuedAt + timeoutMs,
      });
    } catch (err) {
      deps.broker.respond(sessionId, elicitationId, "decline", "emit-failure");
      await waiting;
      log.error(`elicitation: could not raise a card session=${sessionId} server=${JSON.stringify(server)}: ${(err as Error).name}`);
      return DECLINE;
    }
    log.info(`elicitation: card raised session=${sessionId} id=${elicitationId} server=${JSON.stringify(server)} origin=${check.origin}`);

    const onAbort = () => { deps.broker.respond(sessionId, elicitationId, "cancel", "aborted"); };
    signal.addEventListener("abort", onAbort, { once: true });
    let outcome: ElicitationOutcome;
    try {
      outcome = await waiting;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      deps.emit({ type: "elicitation_resolved", sessionId, threadId, elicitationId, action: outcome.action, by: outcome.by });
    } catch (err) {
      // The answer stands: a card that cannot be marked resolved is a display problem, not a reason
      // to tell the server something the user did not say.
      log.error(`elicitation: could not record the outcome session=${sessionId} id=${elicitationId}: ${(err as Error).name}`);
    }
    log.info(`elicitation: ${outcome.action} session=${sessionId} id=${elicitationId} by=${outcome.by}`);
    return { action: outcome.action };
  };
}
