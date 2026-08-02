import type { ModelInfo, Provider, ProviderEvent, TurnInputItem, TurnRequest, ToolSpec } from "./types";
import { ResponsesSseParser } from "./responses-sse";
import { parseProviderErrorCode } from "./errors";

export interface OpenAICompatibleConfig {
  baseUrl: string;            // e.g. https://api.openai.com/v1
  apiKey: string;
  models?: ModelInfo[];       // optional static list — when NON-EMPTY it is also an ALLOW-LIST: the
                              // engine's spawn bridge rejects spawn_agent model overrides not in it
                              // (4e F9). Leave unset/empty for arbitrary-endpoint passthrough.
  extraHeaders?: Record<string, string>;
}

/**
 * Map TurnInputItem[] to the structured Responses API `input` array.
 *
 * Shape verified live 2026-06-13 against https://chatgpt.com/backend-api/codex/responses:
 *   messages  → {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
 *   tool_result → {type:"function_call_output", call_id, output}
 *
 * The flat-string content form ({role, content:"string"}) was rejected with HTTP 400
 * by the codex backend; structured content items are required.
 *
 * function_call → {type:"function_call", call_id, name, arguments} follows the same
 * Responses API ResponseItem shape (not yet live-verified against the codex backend;
 * the parity doc only covers message/function_call_output — Task 12's live gate confirms).
 */
export function mapInput(items: TurnInputItem[]): unknown[] {
  return items.map((i) => {
    if (i.type === "message") {
      // Map role to the appropriate content item type per the Responses API schema.
      // assistant messages use output_text; user/system messages use input_text.
      const contentType = i.role === "assistant" ? "output_text" : "input_text";
      return { type: "message", role: i.role, content: [{ type: contentType, text: i.content }] };
    }
    if (i.type === "function_call") {
      return { type: "function_call", call_id: i.callId, name: i.name, arguments: i.argsJson };
    }
    if (i.type === "reasoning") return JSON.parse(i.itemJson); // opaque passthrough — never inspected
    // Computer-use image (Phase 5 CU): a user message carrying an input_image. This is the ONLY
    // image shape the CU spike verified against the Codex backend — a structured user message with
    // `input_image` + `image_url` as a plain data-URL string (NOT the chat-completions
    // `{image_url:{url}}` object form). The optional `alt` rides as a leading input_text part.
    if (i.type === "image") {
      const content: unknown[] = [];
      if (i.alt) content.push({ type: "input_text", text: i.alt });
      content.push({ type: "input_image", image_url: i.imageUrl });
      return { type: "message", role: "user", content };
    }
    return { type: "function_call_output", call_id: i.callId, output: i.output };
  });
}

export function mapTools(tools: ToolSpec[] | undefined): unknown[] {
  return (tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

/**
 * Build the standard Responses API request body.
 *
 * Required fields verified live 2026-06-13 (codex-rs ResponsesApiRequest @216dee1):
 *   tools, tool_choice, parallel_tool_calls, store, include — all required by backend;
 *   omitting them causes HTTP 400.
 * instructions: codex-rs skips when empty string; we always send a default so the
 *   field is never absent when the caller omits it.
 * reasoning: omitted entirely when req.reasoningEffort is unset — the body must stay
 *   byte-identical to the pre-reasoning-effort shape (test-pinned in openai-compatible.test.ts)
 *   so existing callers/backends that never set it see no change at all.
 */
export function buildRequestBody(req: TurnRequest): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.instructions ?? "You are a helpful assistant.",
    input: mapInput(req.input),
    tools: mapTools(req.tools),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    // Codex parity: encrypted reasoning state is requested whenever reasoning is configured, so
    // reasoning items are replayable on later store:false requests. Effort unset → [] (byte-identical
    // pre-change shape, test-pinned).
    include: req.reasoningEffort ? ["reasoning.encrypted_content"] : [],
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
  };
}

export async function mapHttpError(status: number, retryAfterHeader: string | null, body: Promise<string>): Promise<ProviderEvent> {
  const raw = await body.catch(() => "");
  const snippet = raw.slice(0, 200);
  const suffix = snippet ? ` — ${snippet}` : "";
  // The provider's structured `error.code` is read off the FULL body, BEFORE the 200-char cap —
  // the envelope puts `code` after the unbounded human message, so on a real context-overflow body
  // the cap eats exactly the field a consumer wants (see providers/errors.ts). Spread as an
  // optional so every error with no structured code keeps its pre-existing shape byte-identical.
  const providerCode = parseProviderErrorCode(raw);
  const extra = providerCode ? { providerCode } : {};
  if (status === 401 || status === 403) return { type: "error", code: "auth", message: `HTTP ${status}${suffix}`, ...extra };
  if (status === 429) {
    const secs = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    // HTTP-date form of Retry-After (RFC 7231 §7.1.3) → NaN → omit retryAfterMs; QuotaManager applies fallback.
    // secs <= 0 treated as absent (a "retry immediately" hint still gets default backoff).
    return {
      type: "error", code: "rate_limit", message: `HTTP 429${suffix}`, ...extra,
      ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: Math.round(secs * 1000) } : {}),
    };
  }
  if (status >= 400 && status < 500) return { type: "error", code: "bad_request", message: `HTTP ${status}${suffix}`, ...extra };
  return { type: "error", code: "server", message: `HTTP ${status}${suffix}`, ...extra };
}

export class OpenAICompatibleProvider implements Provider {
  readonly id = "openai-compatible";
  constructor(private readonly cfg: OpenAICompatibleConfig) {}

  models(): ModelInfo[] { return this.cfg.models ?? []; }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...this.cfg.extraHeaders,
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
      return;
    }
    if (!res.ok) { yield await mapHttpError(res.status, res.headers.get("retry-after"), res.text()); return; }

    const parser = new ResponsesSseParser();
    const reader = res.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(value)) yield e;
      }
      for (const e of parser.finish()) yield e;
    } catch (err) {
      if (req.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield { type: "error", code: "network", message: (err as Error).message };
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
