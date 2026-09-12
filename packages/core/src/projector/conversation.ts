import { takeFileDiff } from "../runtime-sdk/diff-attach";
import type { ProjectedEvent, ProtocolSdkMessage } from "./types";

/**
 * ── WHY NOTHING HERE IS A `switch (msg.type)` ───────────────────────────────────────────────────
 *
 * The wire union's LAST member is `{ type: string; [k: string]: unknown }`
 * (`winter-agent-sdk/dist/protocol/frames.d.ts:595`). A catch-all with a `string` discriminant makes
 * the union non-discriminating: `switch (msg.type) { case "assistant": … }` narrows to
 * `AssistantFrame | CatchAll`, so every field access after it is `unknown` and every `default:`
 * branch silently swallows a real variant. So every read here goes through an explicit shape guard,
 * and an unrecognised `type` falls out the bottom as "log it, project nothing".
 *
 * The input type is deliberately the WIRE union `ProtocolSdkMessage` and never the narrow public
 * `SdkMessage` (G-8 / ruling P8b-8): `SdkMessage` is `Extract`ed down to `system | assistant |
 * result`, which would compile cleanly while dropping every `user` tool-result frame and every
 * `stream_event`.
 */

export const MAIN_THREAD = "main";

// ── shape guards ───────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface ContentBlock extends Rec { type: string }

/** `{type:"assistant", message:{content:[…]}, parent_tool_use_id?}` — `frames.d.ts:562`. */
export interface AssistantFrame { type: "assistant"; message: { content: ContentBlock[] }; parent_tool_use_id?: string | null }
/** `{type:"user", message:{role?, content:[…]}, parent_tool_use_id?}` — `frames.d.ts:574`.
 *  `role` is REQUIRED by the declared type and ABSENT from what a real child emits (measured
 *  2026-09-11 against `dist/winter`), so this guard must not test it. */
export interface UserFrame { type: "user"; message: { role?: string; content: ContentBlock[] }; parent_tool_use_id?: string | null }
/** `{type:"result", subtype, is_error?, result?, permission_denials, …}` — `frames.d.ts:585`. */
export interface ResultFrame extends Rec { type: "result"; subtype: string; permission_denials?: unknown[] }
/** `{type:"stream_event", event, parent_tool_use_id, uuid, session_id, …}` — `frames.d.ts:361-369`. */
export interface StreamEventFrame extends Rec { type: "stream_event"; event: Rec; parent_tool_use_id?: string | null }
/** `{type:"system", subtype:"init", model, tools, session_id, …}` — `frames.d.ts:546-561`. */
export interface InitFrame extends Rec { type: "system"; subtype: "init"; session_id?: string; model?: string; tools?: unknown }

/**
 * A mirror error on the OFFICIAL stream (P8c-11 / Task 2.2, WS-16 §13's "mirror row"): the
 * router's own JSONL mirror of the official runtime's session onto Winter's compat store fell out
 * of sync with what the child actually wrote. `runtime-state/recovery.ts`'s step-6 handoff check
 * already names the daemon-side consequence — `records.setTranscriptHealth(id, "repair-required")`
 * — for exactly this fact when IT detects the mismatch; this guard is the projector's OWN door for
 * the case where the mismatch is reported ON THE WIRE, inline in a live turn, rather than only
 * caught by a later handoff-time reconciliation pass.
 *
 * **NO PINNED SHAPE EXISTS for this today.** `@yanlinglabs/winter-runtime-sdk`'s
 * `official-sdk-shapes.d.ts` types `OfficialQuery` as `AsyncIterable<unknown>` precisely because
 * the router passes the official SDK's own message stream through verbatim (`OfficialSdkModule`'s
 * one method promises nothing else) — there is no seam-side contract to read a "mirror_error"
 * shape off of, and lane 1's e2e recordings (`test/fixtures/official/*.jsonl`) had not landed by
 * the time this lane ran. This guard is therefore **PROVISIONAL**: it recognises the two shapes a
 * frame family named "mirror error" would plausibly take, following this file's own `type`/
 * `subtype` convention (`kindOf`, `projector/hooks.ts`) — a top-level `{type:"mirror_error", …}`
 * frame, or a `system`-family `{type:"system", subtype:"mirror_error", …}` one — and reads an
 * optional `detail`/`reason` string field under either shape. The whole-branch review is expected
 * to re-verify this against a real recorded frame once one exists; until then this is best-effort,
 * never a claim that the real shape is confirmed.
 */
export interface MirrorErrorFrame extends Rec { detail?: string }

export function asMirrorErrorFrame(m: ProtocolSdkMessage): MirrorErrorFrame | undefined {
  const r = m as Rec;
  const isMirrorError = r.type === "mirror_error" || (r.type === "system" && r.subtype === "mirror_error");
  if (!isMirrorError) return undefined;
  const detail = typeof r.detail === "string" ? r.detail : typeof r.reason === "string" ? r.reason : undefined;
  return detail !== undefined ? { detail } : {};
}

const hasContent = (m: unknown): m is { content: ContentBlock[] } =>
  isRec(m) && Array.isArray((m as Rec).content) && ((m as Rec).content as unknown[]).every((b) => isRec(b) && typeof (b as Rec).type === "string");

/**
 * The narrowings are `as<Frame>() => Frame | undefined` rather than `m is <Frame>` type predicates,
 * and that is forced by the union, not a style choice. A predicate's type must be assignable to its
 * parameter's type, and these local shapes are deliberately LOOSER than the SDK's declarations
 * (a real `user` frame omits `message.role`; a real `result` omits nothing but is read through the
 * index signature) — so a predicate would not compile, and narrowing `ProtocolSdkMessage` with the
 * SDK's own member types collapses several branches to `never` because of the catch-all member.
 * Returning the frame sidesteps both, and the shape test still happens exactly once per message.
 */
export function asAssistantFrame(m: ProtocolSdkMessage): AssistantFrame | undefined {
  return (m as Rec).type === "assistant" && hasContent((m as Rec).message) ? (m as unknown as AssistantFrame) : undefined;
}

export function asUserFrame(m: ProtocolSdkMessage): UserFrame | undefined {
  return (m as Rec).type === "user" && hasContent((m as Rec).message) ? (m as unknown as UserFrame) : undefined;
}

export function asResultFrame(m: ProtocolSdkMessage): ResultFrame | undefined {
  return (m as Rec).type === "result" && typeof (m as Rec).subtype === "string" ? (m as unknown as ResultFrame) : undefined;
}

export function asStreamEventFrame(m: ProtocolSdkMessage): StreamEventFrame | undefined {
  return (m as Rec).type === "stream_event" && isRec((m as Rec).event) ? (m as unknown as StreamEventFrame) : undefined;
}

export function asInitFrame(m: ProtocolSdkMessage): InitFrame | undefined {
  return (m as Rec).type === "system" && (m as Rec).subtype === "init" ? (m as unknown as InitFrame) : undefined;
}

// ── the thread a frame belongs to ──────────────────────────────────────────────────────────────

/**
 * `parent_tool_use_id` is the MESSAGE-STREAM child correlator (surface map §4.3) — never `agentID`,
 * which is a permission-time correlator on `canUseTool`'s options and on
 * `SDKPermissionDeniedMessage`. A main-thread frame carries an explicit `null` (on `stream_event`)
 * or omits it entirely (on `assistant`/`user`, measured), and both mean "main".
 *
 * The parent tool-use id IS the threadId — a decision Task 11 kept rather than replaced, for the
 * reasons in `children.ts`: it is stable for the life of the child, unique by construction (a model
 * never reuses a tool_use id), and it is the same id the child's completing `tool_result` carries,
 * so both ends of the thread come off the wire with no registry lookup.
 *
 * **CROSS-LANE CONTRACT (n9, review r2):** that id is also how Task 13's `PersistedWinterChild` and
 * Task 16's `Query.messaging.steerChild`/`resumeChild` must address the same child. The projector
 * opens a thread with the spawning `tool_use.id`; anything addressing that child by another id is
 * talking about a different thread as far as the session log is concerned.
 *
 * **Nothing asserts that agreement today** — the two sides are in different lanes and neither can
 * see the other. Keeping the two id choices in step is an OBLIGATION on the integration-time
 * tripwire the controller is adding, not a fact this file may claim. Until that tripwire exists,
 * the only thing holding the contract is this comment and the matching one in `children.ts`.
 */
export function threadIdOf(frame: { parent_tool_use_id?: string | null }): string {
  const parent = frame.parent_tool_use_id;
  return typeof parent === "string" && parent.length > 0 ? parent : MAIN_THREAD;
}

// ── block folds ────────────────────────────────────────────────────────────────────────────────

/** Concatenated `text` blocks of a final assistant message. `thinking` / `redacted_thinking` are
 *  NOT read: `redacted_thinking.data` is opaque provider state whose only sink is the session JSONL
 *  (and the projector has no branch that may write a `reasoning_item`), and a `thinking` block's
 *  text is not the assistant's answer. */
export function assistantText(frame: AssistantFrame): string {
  return frame.message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * One `tool_call` per `tool_use` block. `callId` = the block's `id`, which is the SAME id the
 * matching `tool_result` block carries as `tool_use_id` — the linkage the Mac/phone transcripts
 * fold on, and the projector's idempotency source id.
 *
 * `name` is the WINTER name (ruling P8b-25): the `SessionEvent` surface keeps Winter's tool
 * vocabulary because the Mac and iOS renderers key their tool rows on it and every past session in
 * `session.history` spells it that way. `renameTool` is the one translation point and it reads the
 * SHARED table, `runtime-sdk/tool-names.ts` — the same one the approval bridge gates by, so the
 * name on a card and the name in the transcript cannot drift. An unmapped Winter name falls through
 * unchanged rather than being dropped.
 */
export function toolCalls(frame: AssistantFrame, sessionId: string, threadId: string, renameTool: (winterName: string) => string): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  for (const b of frame.message.content) {
    if (b.type !== "tool_use") continue;
    const callId = str(b.id);
    const name = str(b.name);
    if (callId === undefined || callId.length === 0 || name === undefined || name.length === 0) continue;
    out.push({ type: "tool_call", sessionId, threadId, callId, name: renameTool(name), argsJson: JSON.stringify(b.input ?? {}) });
  }
  return out;
}

/** A `tool_result` block's `content` is `string | WireContentBlock[]` (`frames.ts:321-329`). The
 *  array form is flattened to its text blocks; a non-text block (an image, say) contributes its
 *  type name rather than its bytes, because `tool_result.output` is a string the transcript
 *  renders and the phone's history cap measures. */
export function toolResultOutput(block: ContentBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRec(b) && b.type === "text" && typeof b.text === "string" ? b.text : isRec(b) && typeof b.type === "string" ? `[${b.type}]` : ""))
    .join("");
}

/**
 * One `tool_result` event per `tool_result` block on a `user` frame.
 *
 * `isError` reads BOTH spellings the runtime uses: `is_error` (the declared field) and `denied`
 * (what a permission refusal actually sets — measured). A denial that arrived as `denied: true`
 * with no `is_error` would otherwise be recorded as a SUCCESSFUL tool result, which is the one
 * mis-fold in this file that would be invisible in every unit test that only feeds declared shapes.
 * `interrupted: true` (the in-flight block an interrupt cancels, `[interrupted]`) is likewise an
 * error result, not a success.
 *
 * M5 (whole-branch review): `fileDiff` is taken here — `takeFileDiff(sessionId, callId)`
 * (`runtime-sdk/diff-attach.ts`) — the ONE place a `tool_result` event is emitted for a completed
 * call, so it is also the one place the hooks lane's PostToolUse-produced diff summary (attached
 * under the SAME sessionId/toolUseId) can be handed to the persisted event. A take is destructive
 * (`diff-attach.ts`'s own doc), so a replayed `tool_result` never re-attaches a diff — the summary
 * rides the event exactly once, the same turn it was produced on.
 */
export function toolResults(frame: UserFrame, sessionId: string, threadId: string): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  for (const b of frame.message.content) {
    if (b.type !== "tool_result") continue;
    const callId = str(b.tool_use_id);
    if (callId === undefined || callId.length === 0) continue;
    const isError = b.is_error === true || b.denied === true || b.interrupted === true;
    const fileDiff = takeFileDiff(sessionId, callId);
    out.push({ type: "tool_result", sessionId, threadId, callId, output: toolResultOutput(b), isError, ...(fileDiff === undefined ? {} : { fileDiff }) });
  }
  return out;
}

/** The text blocks of a `user` frame that are NOT tool results — a delivered agent message rendered
 *  into the child's input (`<agent-message …>`, surface map §4.7), which is the only way a `user`
 *  frame reaches a host without the host having pushed it. */
export function userText(frame: UserFrame): string {
  return frame.message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

export const hasToolResults = (frame: UserFrame): boolean => frame.message.content.some((b) => b.type === "tool_result");

/**
 * The text of a `content_block_delta` / `text_delta` stream event, or undefined.
 *
 * `thinking_delta` and `signature_delta` are deliberately NOT projected: a `signature_delta` is
 * opaque provider state, and a thinking delta is not the assistant's answer. `input_json_delta`
 * (the partial arguments of a tool call) is not projected either — the complete `tool_use` block
 * arrives on the final `assistant` message, which is where `tool_call.argsJson` comes from.
 * `ping` never reaches a consumer at all (the runtime filters it, `frames.ts:313-315`).
 */
export function deltaText(frame: StreamEventFrame): string | undefined {
  const ev = frame.event;
  if (ev.type !== "content_block_delta") return undefined;
  const delta = ev.delta;
  if (!isRec(delta) || delta.type !== "text_delta") return undefined;
  const text = str(delta.text);
  return text !== undefined && text.length > 0 ? text : undefined;
}
