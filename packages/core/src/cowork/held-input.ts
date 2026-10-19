import { createHash } from "node:crypto";
import { CoworkError } from "./types";

/*
 * #92 N4, held-input messaging, the HOST's half (design section 4.5; the runtime half is agent-sdk #43, GM2): a peer
 * message for a Cowork conversation is HELD in the guest runtime's journal (invisible to the model), then COMMITTED (it
 * joins the conversation exactly once) or DISCARDED, and a committed tombstone is FORGOTTEN once the host recorded the
 * verdict. The host drives these four verbs; the runtime answers in closed shapes, and this module checks every one.
 *
 * GATED. A Cowork driver exposes these verbs only when (a) the runtime offered `held-input-v1` in its capability (an older
 * runtime refuses an unknown control subtype and that refusal is a hard stop) and (b) a host supplied
 * `CoworkSessionDriverDeps.heldInput`, which no production composition does (pinned structurally). The winter host SDK
 * (0.0.53) has no verbs yet: the query is read STRUCTURALLY, and a query without them refuses `unsupported_topology`.
 *
 * Literals mirror the SDK's (`packages/sdk/src/options.ts` on agent-sdk #43); a drift test pins them.
 */

export const COWORK_HELD_INPUT_CAPABILITY = "held-input-v1";
export const COWORK_HOST_INPUT_SUBTYPES = Object.freeze({ hold: "host_input_hold", commit: "host_input_commit", discard: "host_input_discard", forget: "host_input_forget" } as const);
/** The runtime's typed rejection codes. `unknown_input` is TERMINAL (no record, no tombstone, no transcript entry). */
export const COWORK_HELD_INPUT_ERRORS = Object.freeze(["conflict", "superseded", "committed", "unknown_input", "epoch", "invalid", "journal_full", "journal_failed"] as const);
export type CoworkHeldInputErrorCode = typeof COWORK_HELD_INPUT_ERRORS[number];

const HEX64 = /^[0-9a-f]{64}$/;
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TEXT_MAX_BYTES = 64 * 1024, CLIENT_MAX = 256;

/** The hold token: sha256("hold-v1|receiptId|incarnationId|leaseEpoch|offerCount"), lowercase hex. A new offer (or a new
 *  incarnation) is a new token, so a stale ack or commit can never land on a later offer. */
export function coworkHoldToken(receiptId: string, incarnationId: string, leaseEpoch: number, offerCount: number): string {
  if (!INPUT_ID.test(receiptId) || typeof incarnationId !== "string" || incarnationId.length === 0 || incarnationId.includes("|")
    || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1 || !Number.isSafeInteger(offerCount) || offerCount < 1) throw new CoworkError("invalid_request");
  return createHash("sha256").update(`hold-v1|${receiptId}|${incarnationId}|${leaseEpoch}|${offerCount}`).digest("hex");
}

export interface CoworkHoldRequest { readonly inputId: string; readonly holdToken: string; readonly epoch: { readonly incarnationId: string; readonly leaseEpoch: number }; readonly text: string; readonly clientName: string }
export type CoworkHoldAnswer = { readonly held: true; readonly again?: true } | { readonly held: false; readonly state: "committed" | "in_transcript" };
export type CoworkCommitAnswer = { readonly outcome: "folded" | "queued" | "started" | "already" };
export type CoworkDiscardAnswer = { readonly discarded: true } | { readonly discarded: false; readonly reason: "superseded" };
export type CoworkForgetAnswer = { readonly forgotten: boolean };
export interface CoworkHeldInputRecord { readonly inputId: string; readonly digest: string; readonly holdToken: string; readonly state: "held" | "committed" | "in_transcript" }

/** The host SDK query's verbs (agent-sdk #43's `Query.holdInput/commitInput/discardInput/forgetInput`), structurally. */
export interface CoworkHeldInputQuery {
  holdInput(request: CoworkHoldRequest): Promise<unknown>;
  commitInput(inputId: string, holdToken: string): Promise<unknown>;
  discardInput(inputId: string, holdToken: string): Promise<unknown>;
  forgetInput(inputId: string, holdToken: string): Promise<unknown>;
}

/** The runtime refused a verb with one of its typed codes. Anything else (a transport loss, a malformed answer) is
 *  UNCERTAIN and surfaces as `CoworkError("recovery_required")`: the caller decides nothing from it. */
export class CoworkHeldInputRefusal extends Error {
  constructor(readonly code: CoworkHeldInputErrorCode) { super(code); this.name = "CoworkHeldInputRefusal"; }
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const uncertain = (): never => { throw new CoworkError("recovery_required"); };

export function coworkHoldAnswer(value: unknown): CoworkHoldAnswer {
  if (!plain(value) || !keysWithin(value, ["held", "again", "state"])) return uncertain();
  if (value.held === true && value.state === undefined && (value.again === undefined || value.again === true)) return Object.freeze(value.again === true ? { held: true, again: true } : { held: true });
  if (value.held === false && value.again === undefined && (value.state === "committed" || value.state === "in_transcript")) return Object.freeze({ held: false, state: value.state });
  return uncertain();
}
export function coworkCommitAnswer(value: unknown): CoworkCommitAnswer {
  if (!plain(value) || !keysWithin(value, ["outcome"]) || !["folded", "queued", "started", "already"].includes(value.outcome as string)) return uncertain();
  return Object.freeze({ outcome: value.outcome as CoworkCommitAnswer["outcome"] });
}
export function coworkDiscardAnswer(value: unknown): CoworkDiscardAnswer {
  if (!plain(value) || !keysWithin(value, ["discarded", "reason"])) return uncertain();
  if (value.discarded === true && value.reason === undefined) return Object.freeze({ discarded: true });
  if (value.discarded === false && value.reason === "superseded") return Object.freeze({ discarded: false, reason: "superseded" });
  return uncertain();
}
export function coworkForgetAnswer(value: unknown): CoworkForgetAnswer {
  if (!plain(value) || !keysWithin(value, ["forgotten"]) || typeof value.forgotten !== "boolean") return uncertain();
  return Object.freeze({ forgotten: value.forgotten });
}
/** `system/held_inputs`: emitted exactly once after init, ALWAYS (empty included). A malformed list is uncertain. */
export function coworkHeldInputsEvent(value: unknown): readonly CoworkHeldInputRecord[] {
  if (!plain(value) || !keysWithin(value, ["inputs"]) || !Array.isArray(value.inputs)) return uncertain();
  const seen = new Set<string>();
  return Object.freeze(value.inputs.map(item => {
    if (!plain(item) || !keysWithin(item, ["inputId", "digest", "holdToken", "state"]) || typeof item.inputId !== "string" || !INPUT_ID.test(item.inputId) || seen.has(item.inputId)
      || typeof item.digest !== "string" || !HEX64.test(item.digest) || typeof item.holdToken !== "string" || !HEX64.test(item.holdToken)
      || !["held", "committed", "in_transcript"].includes(item.state as string)) return uncertain();
    seen.add(item.inputId);
    return Object.freeze({ inputId: item.inputId, digest: item.digest, holdToken: item.holdToken, state: item.state as CoworkHeldInputRecord["state"] });
  }));
}

/** A `system/held_inputs` message's records, or undefined when `message` is some other message. A malformed one throws
 *  `recovery_required` (the caller never publishes the epoch). */
export function coworkHeldInputsFrom(message: unknown): readonly CoworkHeldInputRecord[] | undefined {
  if (!plain(message) || message.type !== "system" || message.subtype !== "held_inputs") return undefined;
  return coworkHeldInputsEvent({ inputs: message.inputs });
}

/**
 * Observes the query's messages for `system/held_inputs` (emitted once after init, always) and hands the first to `onHeldInputs`.
 * Every message is passed on unchanged and in order; every other member of the query is the query's own.
 */
export function coworkTapHeldInputs<Q extends object>(query: Q, onHeldInputs: (message: unknown) => void): Q {
  return new Proxy(query, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return async function* tapped() {
          for await (const message of target as unknown as AsyncIterable<unknown>) {
            if (plain(message) && message.type === "system" && message.subtype === "held_inputs") onHeldInputs(message);
            yield message;
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The four verbs a Cowork driver exposes (gated; see the header). Every call is bound to the incarnation that is live. */
export interface CoworkHeldInputVerbs {
  hold(input: { readonly inputId: string; readonly holdToken: string; readonly text: string; readonly clientName: string }): Promise<CoworkHoldAnswer>;
  commit(inputId: string, holdToken: string): Promise<CoworkCommitAnswer>;
  discard(inputId: string, holdToken: string): Promise<CoworkDiscardAnswer>;
  forget(inputId: string, holdToken: string): Promise<CoworkForgetAnswer>;
}

/** Whether the runtime's capability offers held input (`runtimeCapability.capabilities`). */
export function coworkOffersHeldInput(runtimeCapability: { readonly capabilities: readonly string[] } | undefined): boolean {
  return Array.isArray(runtimeCapability?.capabilities) && runtimeCapability.capabilities.includes(COWORK_HELD_INPUT_CAPABILITY);
}

/**
 * The verbs over a live query, bound to `epoch()` (the incarnation the driver runs now; undefined when none is live, which
 * refuses `cold_resume_unavailable`). Requests are checked before they leave (closed shape, sizes, tokens); answers are
 * checked when they return. A runtime refusal with a known code is `CoworkHeldInputRefusal`; anything else is uncertain.
 */
export function coworkHeldInputVerbs(query: () => unknown, epoch: () => { readonly incarnationId: string; readonly leaseEpoch: number } | undefined): CoworkHeldInputVerbs {
  const live = (): CoworkHeldInputQuery => {
    const q = query() as Partial<CoworkHeldInputQuery> | undefined;
    if (q === undefined || q === null) throw new CoworkError("cold_resume_unavailable");
    if (typeof q.holdInput !== "function" || typeof q.commitInput !== "function" || typeof q.discardInput !== "function" || typeof q.forgetInput !== "function") throw new CoworkError("unsupported_topology");
    return q as CoworkHeldInputQuery;
  };
  const checkRef = (inputId: string, holdToken: string) => { if (typeof inputId !== "string" || !INPUT_ID.test(inputId) || typeof holdToken !== "string" || !HEX64.test(holdToken)) throw new CoworkError("invalid_request"); };
  const call = async <T>(run: () => Promise<unknown>, check: (value: unknown) => T): Promise<T> => {
    let answer: unknown;
    try { answer = await run(); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && (COWORK_HELD_INPUT_ERRORS as readonly string[]).includes(code)) throw new CoworkHeldInputRefusal(code as CoworkHeldInputErrorCode);
      throw new CoworkError("recovery_required");
    }
    return check(answer);
  };
  const verbs: CoworkHeldInputVerbs = {
    async hold(input) {
      checkRef(input?.inputId, input?.holdToken);
      // A leading `/` is a slash command to the host-query guest, which ends its runtime: refused here, like `guestText` does.
      if (typeof input.text !== "string" || input.text.length === 0 || input.text.trimStart().startsWith("/") || Buffer.byteLength(input.text, "utf8") > TEXT_MAX_BYTES) throw new CoworkError("invalid_request");
      if (typeof input.clientName !== "string" || input.clientName.length === 0 || input.clientName.length > CLIENT_MAX) throw new CoworkError("invalid_request");
      const now = epoch();
      if (now === undefined) throw new CoworkError("cold_resume_unavailable");
      const q = live();
      const request: CoworkHoldRequest = { inputId: input.inputId, holdToken: input.holdToken, epoch: { incarnationId: now.incarnationId, leaseEpoch: now.leaseEpoch }, text: input.text, clientName: input.clientName };
      return call(() => q.holdInput(request), coworkHoldAnswer);
    },
    async commit(inputId, holdToken) { checkRef(inputId, holdToken); if (epoch() === undefined) throw new CoworkError("cold_resume_unavailable"); const q = live(); return call(() => q.commitInput(inputId, holdToken), coworkCommitAnswer); },
    async discard(inputId, holdToken) { checkRef(inputId, holdToken); if (epoch() === undefined) throw new CoworkError("cold_resume_unavailable"); const q = live(); return call(() => q.discardInput(inputId, holdToken), coworkDiscardAnswer); },
    async forget(inputId, holdToken) { checkRef(inputId, holdToken); if (epoch() === undefined) throw new CoworkError("cold_resume_unavailable"); const q = live(); return call(() => q.forgetInput(inputId, holdToken), coworkForgetAnswer); },
  };
  return Object.freeze(verbs);
}

// ---------------------------------------------------------------------------------------------------- host messaging answers
/** `host_message_send`'s answer (agent-sdk `isHostMessageSendAnswer`), checked before the host replies, so a malformed
 *  answer never leaves the host (the runtime would refuse it and the guest call would hang to its timeout). */
const SEND_STATUSES = ["delivered", "queued", "resumed_and_delivered", "refused", "not_found", "unavailable", "delivery_uncertain"] as const;
const REASON_REQUIRED = ["refused", "not_found", "unavailable", "delivery_uncertain"];
export type CoworkHostMessageSendAnswer = {
  readonly status: typeof SEND_STATUSES[number]; readonly reason?: string; readonly retryable?: boolean; readonly note?: string;
  readonly notify?: { readonly subscribed?: true; readonly refused?: string };
};
export function coworkHostMessageSendAnswer(value: unknown): CoworkHostMessageSendAnswer {
  const bad = (): never => { throw new CoworkError("invalid_request"); };
  if (!plain(value) || !keysWithin(value, ["status", "reason", "retryable", "note", "notify"]) || !(SEND_STATUSES as readonly unknown[]).includes(value.status)) return bad();
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length === 0)) return bad();
  if (REASON_REQUIRED.includes(value.status as string) && value.reason === undefined) return bad();
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") return bad();
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 500)) return bad();
  if (value.notify !== undefined && (!plain(value.notify) || !keysWithin(value.notify, ["subscribed", "refused"])
    || (value.notify.subscribed !== undefined && value.notify.subscribed !== true) || (value.notify.refused !== undefined && typeof value.notify.refused !== "string"))) return bad();
  return Object.freeze({ ...value }) as CoworkHostMessageSendAnswer;
}
const LIST_STATUSES = ["starting", "running", "idle", "exited", "unavailable", "archived"];
export type CoworkHostMessageListAnswer = { readonly sessions: readonly { readonly address: string; readonly name?: string; readonly status: string; readonly mode: string; readonly cwd?: string }[]; readonly omitted?: number };
export function coworkHostMessageListAnswer(value: unknown): CoworkHostMessageListAnswer {
  const bad = (): never => { throw new CoworkError("invalid_request"); };
  if (!plain(value) || !keysWithin(value, ["sessions", "omitted"]) || !Array.isArray(value.sessions)) return bad();
  if (value.omitted !== undefined && (!Number.isSafeInteger(value.omitted) || (value.omitted as number) < 0)) return bad();
  const sessions = value.sessions.map(item => {
    if (!plain(item) || !keysWithin(item, ["address", "name", "status", "mode", "cwd"]) || typeof item.address !== "string" || item.address.length === 0
      || !LIST_STATUSES.includes(item.status as string) || typeof item.mode !== "string" || (item.name !== undefined && typeof item.name !== "string") || (item.cwd !== undefined && typeof item.cwd !== "string")) return bad();
    return Object.freeze({ ...item }) as CoworkHostMessageListAnswer["sessions"][number];
  });
  return Object.freeze({ sessions: Object.freeze(sessions), ...(value.omitted === undefined ? {} : { omitted: value.omitted as number }) });
}

/** The content of the note shown once per stall of a recipient's held-input queue (3 failed drains in a row on transport or
 *  malformed answers): fixed text, no sender, no message detail. */
export function coworkStalledInboxNotice(): { readonly warning: "peer_inbox_stalled"; readonly text: string } {
  return Object.freeze({ warning: "peer_inbox_stalled", text: "Messages from other sessions in this project are waiting to be delivered to this conversation; delivery is being retried." } as const);
}

/** The content of the note a recipient's conversation shows for a peer message that was accepted but lost (`unknown_input`,
 *  4.5): a `continuity_warning` event's `warning` and `text`. The composition appends it; the sender is not named, because
 *  the guest never saw the message. */
export function coworkLostInputNotice(): { readonly warning: "peer_message_lost"; readonly text: string } {
  return Object.freeze({ warning: "peer_message_lost", text: "A message from another session in this project was accepted but could not be delivered to this conversation." } as const);
}
