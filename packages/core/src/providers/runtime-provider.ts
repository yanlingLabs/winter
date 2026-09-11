import {
  codexCredentialRef,
  createCodexOauthAdapter,
  createResponsesAdapter,
} from "@yanlinglabs/winter-provider-runtime";
import type {
  ContentBlockLike,
  ProviderAdapter,
  ProviderContext,
  ProviderEvent as RuntimeProviderEvent,
  ProviderMessageLike,
  TurnRequest as RuntimeTurnRequest,
} from "@yanlinglabs/winter-provider-runtime";
import type { SecretStore } from "../auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES } from "../auth/credential-material";
import { credentialStoreOverSecretStore } from "./credential-store";
import { CODEX_MODELS } from "./codex-config";
import type { ModelInfo, Provider, ProviderEvent, ToolSpec, TurnInputItem, TurnRequest } from "./types";

/**
 * P8c lane 5: the daemon's internal model calls (compactor/titler/bash-reviewer, and — through
 * `withQuota`'s usage/rate-limit tracking — the `quota`/`status` view) run over
 * `@yanlinglabs/winter-provider-runtime` adapters instead of Norma's own raw-HTTP request/SSE code
 * (`openai-compatible.ts`/`codex-oauth.ts`, kept — see this module's own header for the ruling).
 * `RuntimeBackedProvider` is the ONE adapter shape both provider types share: it implements Norma's
 * own `Provider` interface (`streamTurn`/`models`/`id`) over a provider-runtime `ProviderAdapter` +
 * `ProviderContext`, so every existing consumer (Compactor, SessionTitler, BashReviewer,
 * `providers/quota.ts`'s `withQuota`) needs no changes at all — they only ever depended on
 * `Provider`, never on the concrete class.
 *
 * SCOPE, STATED HONESTLY: the request/event mapping below covers exactly what the three internal
 * callers exercise today — a single `{type:"message",role:"user"|"assistant"}` turn, `tools: []`,
 * an optional `reasoningEffort`, and a `text_delta`/`done` read loop (see `agent/compactor.ts`,
 * `agent/titles.ts`, `agent/reviewer.ts`). `function_call`/`tool_result`/`image`/`reasoning`
 * `TurnInputItem`s and streamed tool calls are mapped too (best-effort, for a future caller), but
 * are UNEXERCISED by anything that ships today.
 */

const STALL_TIMEOUT_MS = 60_000;

// --- request mapping ---------------------------------------------------------------------------

function toRuntimeMessage(item: TurnInputItem): ProviderMessageLike | undefined {
  switch (item.type) {
    case "message":
      // Norma's own callers never emit `role: "system"` inside `input` (the system prompt is
      // `TurnRequest.instructions`, mapped to the runtime's separate `system` field below) — a
      // defensive collapse to `"user"` for the shape provider-runtime's `ProviderMessageLike`
      // does not have a slot for, rather than a silent drop.
      return { role: item.role === "system" ? "user" : item.role, content: item.content };
    case "function_call": {
      let input: unknown;
      try {
        input = JSON.parse(item.argsJson) as unknown;
      } catch {
        input = {};
      }
      return { role: "assistant", content: [{ type: "tool_use", id: item.callId, name: item.name, input }] };
    }
    case "tool_result":
      return { role: "tool", content: [{ type: "tool_result", tool_use_id: item.callId, content: item.output }] };
    case "reasoning":
      // Opaque provider state has no standalone-item home in `ProviderMessageLike` (it rides as a
      // whole `nativeState` array ON the assistant message it belongs to) and none of today's
      // three internal callers ever emits one — dropped rather than guessed at.
      return undefined;
    case "image": {
      const blocks: ContentBlockLike[] = [];
      if (item.alt) blocks.push({ type: "text", text: item.alt });
      blocks.push({ type: "image", source: parseDataUrl(item.imageUrl) });
      return { role: "user", content: blocks };
    }
  }
}

function parseDataUrl(url: string): Extract<ContentBlockLike, { type: "image" }>["source"] {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return { type: "base64", media_type: m?.[1] ?? "application/octet-stream", data: m?.[2] ?? "" };
}

function mapTools(tools: ToolSpec[] | undefined): RuntimeTurnRequest["tools"] {
  return (tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: (t.parameters ?? {}) as Record<string, unknown> }));
}

function mapTurnRequest(req: TurnRequest): RuntimeTurnRequest {
  const messages: ProviderMessageLike[] = [];
  for (const item of req.input) {
    const mapped = toRuntimeMessage(item);
    if (mapped) messages.push(mapped);
  }
  return {
    model: req.model,
    ...(req.instructions ? { system: req.instructions } : {}),
    messages,
    tools: mapTools(req.tools),
    // Cast, not a narrowed literal: with `descriptors: () => undefined` (both factories below), the
    // runtime's `mapEffortAgainst` descriptor-less arm passes a NAMED (non-numeric) effort through
    // VERBATIM regardless of value (`shared.ts`'s own doc comment) — including Norma's own
    // `REASONING_EFFORTS` member `"none"`, which is not in the runtime's narrower declared literal
    // union but is handled identically to every other named tier on this code path.
    ...(req.reasoningEffort ? { effort: req.reasoningEffort as RuntimeTurnRequest["effort"] } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  };
}

// --- event mapping -------------------------------------------------------------------------------

function mapErrorCode(
  code: Extract<RuntimeProviderEvent, { type: "error" }>["error"]["code"],
): Extract<ProviderEvent, { type: "error" }>["code"] {
  switch (code) {
    case "auth":
    case "rate_limit":
    case "server":
    case "network":
    case "bad_request":
      return code;
    // `timeout`/`stall`: the connection never produced a usable response — the closest of
    // Norma's five coarse codes is "network" (no server verdict was ever reached).
    case "timeout":
    case "stall":
      return "network";
    // `capability`: the request could not be represented on the wire at all (WS-13 §8.2) — a
    // client-side shape problem, closest to "bad_request".
    case "capability":
      return "bad_request";
    // `aborted` is handled by the caller before this function runs (mapped to `done`, not
    // `error` — see `translateEvents` below); reaching here would be a new runtime error code
    // this file has not been taught yet, so it falls back to the vaguest honest answer.
    default:
      return "server";
  }
}

/**
 * Translates one adapter's normalized event stream into Norma's own `ProviderEvent`s. A one-shot
 * per-turn accumulator (`calls`) folds the runtime's streamed `tool_call_start/delta/end` triple
 * into Norma's single complete `tool_call` event — unexercised today (every internal caller passes
 * `tools: []`) but mapped for a future caller rather than silently dropped.
 */
async function* translateEvents(events: AsyncIterable<RuntimeProviderEvent>): AsyncIterable<ProviderEvent> {
  const calls = new Map<string, { name: string; args: string }>();
  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        yield { type: "text_delta", delta: ev.text };
        break;
      case "native_thinking_block":
        // A complete, opaque, in-dialect block — carried verbatim, never inspected (matches the
        // session log's own treatment of `reasoning_item.itemJson`).
        yield { type: "reasoning_item", itemJson: JSON.stringify(ev.block) };
        break;
      case "tool_call_start":
        calls.set(ev.id, { name: ev.name, args: "" });
        break;
      case "tool_call_delta": {
        const call = calls.get(ev.id);
        if (call) call.args += ev.argumentsJsonDelta;
        break;
      }
      case "tool_call_end": {
        const call = calls.get(ev.id);
        calls.delete(ev.id);
        if (call) yield { type: "tool_call", callId: ev.id, name: call.name, argsJson: call.args };
        break;
      }
      case "usage":
        yield { type: "usage", inputTokens: Math.max(0, Math.trunc(ev.inputTokens)), outputTokens: Math.max(0, Math.trunc(ev.outputTokens)) };
        break;
      case "done":
        // Norma's `done.stopReason` is a 3-way enum (`end_turn`|`tool_calls`|`aborted`); the
        // runtime's is 5-way. `max_tokens`/`refusal` both fold to `end_turn` — the turn DID
        // complete, just not the way the caller hoped, and none of today's three internal
        // one-shot callers branch on anything but `aborted`.
        yield { type: "done", stopReason: ev.stopReason === "aborted" ? "aborted" : ev.stopReason === "tool_use" ? "tool_calls" : "end_turn" };
        return;
      case "error": {
        const err = ev.error;
        // Mirrors the pre-existing `signal?.aborted` -> `{type:"done",stopReason:"aborted"}` arms
        // in `openai-compatible.ts`/`codex-oauth.ts`'s own catch blocks — an abort is a
        // completion, not a failure, and no caller here treats it as one.
        if (err.code === "aborted") {
          yield { type: "done", stopReason: "aborted" };
          return;
        }
        yield {
          type: "error",
          code: mapErrorCode(err.code),
          message: err.message,
          ...(err.retryAfterMs !== undefined && err.retryAfterMs > 0 ? { retryAfterMs: Math.round(err.retryAfterMs) } : {}),
          ...(err.providerCode !== undefined ? { providerCode: err.providerCode } : {}),
        };
        return;
      }
      // `message_start`/`thinking_summary_delta`/`thinking_exposed_delta`/`native_state`/
      // `rate_limit`/`retry`/`auth_status`: no Norma `ProviderEvent` target for a one-shot
      // internal-model call — none of compactor/titler/bash-reviewer ever continues a turn
      // across provider-native state, and `providers/quota.ts`'s `QuotaManager` already tracks
      // rate limiting off the `error`+`usage` events above (the adapter's own `withRetry`
      // already retries a rate-limited request in-band before any of this is reached). Dropped
      // rather than guessed at — a carry if a future caller needs the subscription-quota detail.
      default:
        break;
    }
  }
}

// --- the Provider ----------------------------------------------------------------------------

class RuntimeBackedProvider implements Provider {
  readonly id: string;
  private readonly adapter: ProviderAdapter;
  private readonly context: ProviderContext;
  private readonly modelsFn: () => ModelInfo[];

  constructor(cfg: { id: string; adapter: ProviderAdapter; context: ProviderContext; models: () => ModelInfo[] }) {
    this.id = cfg.id;
    this.adapter = cfg.adapter;
    this.context = cfg.context;
    this.modelsFn = cfg.models;
  }

  models(): ModelInfo[] {
    return this.modelsFn();
  }

  streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    return translateEvents(this.adapter.streamTurn(mapTurnRequest(req), this.context));
  }
}

/**
 * `settings.provider.type === "openai-compatible"`: `local: true` on the connection profile is a
 * DELIBERATE compatibility decision, not an oversight — provider-runtime's endpoint policy refuses
 * a plain-http or literal loopback/private-address base URL unless the connection declares itself
 * local (SSRF-shaped protection this package is new, and Norma's `openai-compatible` type has never
 * had an endpoint allowlist: "arbitrary API models are legitimate there", `manager.ts`'s own
 * doc comment). Declaring `local: true` unconditionally preserves that pre-existing unrestricted
 * behaviour for a self-hosted/LAN endpoint (Ollama, LM Studio, a local gateway) and is a no-op for
 * an ordinary public HTTPS endpoint (the local/loopback address-class check never triggers for one).
 */
export function createOpenAiCompatibleRuntimeProvider(secrets: SecretStore, baseUrl: string): Provider {
  const context: ProviderContext = {
    connection: { providerId: "openai-compatible", baseUrl, local: true },
    credentials: credentialStoreOverSecretStore(secrets),
    authRef: { kind: "keychain", account: CREDENTIAL_MATERIAL_NAMES.openai },
    stallTimeoutMs: STALL_TIMEOUT_MS,
    log: () => {},
  };
  const adapter = createResponsesAdapter({ descriptors: () => undefined });
  return new RuntimeBackedProvider({ id: "openai-compatible", adapter, context, models: () => [] });
}

/**
 * `settings.provider.type === "codex-oauth"`: one fixed `default` account
 * (`codexCredentialRef("default").account === "codex-oauth:default"`, the SAME record name
 * `auth/credential-material.ts`'s `CREDENTIAL_MATERIAL_NAMES.codexOauth` already names) — Norma has
 * no multi-account codex support, matching the pre-existing `CodexAuthStore` facade this replaces
 * as the live turn path (see this module's header for what stays).
 */
export function createCodexOauthRuntimeProvider(secrets: SecretStore): Provider {
  const context: ProviderContext = {
    connection: { providerId: "codex-oauth" },
    credentials: credentialStoreOverSecretStore(secrets),
    authRef: codexCredentialRef("default"),
    stallTimeoutMs: STALL_TIMEOUT_MS,
    log: () => {},
  };
  const adapter = createCodexOauthAdapter({ descriptors: () => undefined });
  return new RuntimeBackedProvider({ id: "codex-oauth", adapter, context, models: () => CODEX_MODELS });
}
