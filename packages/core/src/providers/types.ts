import { z } from "zod";

export const ProviderEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), callId: z.string().min(1), name: z.string().min(1), argsJson: z.string() }),
  z.object({ type: z.literal("reasoning_item"), itemJson: z.string() }),
  z.object({ type: z.literal("usage"), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
  z.object({ type: z.literal("done"), stopReason: z.enum(["end_turn", "tool_calls", "aborted"]) }),
  z.object({
    type: z.literal("error"),
    code: z.enum(["auth", "rate_limit", "server", "network", "bad_request"]),
    message: z.string(),
    retryAfterMs: z.number().int().positive().optional(),
    /** The PROVIDER's own structured error code, verbatim (OpenAI's `{"error":{…,"code":…}}`),
     *  when the body carried one — e.g. `context_length_exceeded`. The `code` field above is a
     *  coarse five-way classification the whole daemon shares; this is the un-flattened original,
     *  and it is the DURABLE carrier of it: `mapHttpError` caps the body text it embeds in
     *  `message` at 200 chars, and the envelope puts `code` AFTER the unbounded human message, so
     *  on real context-overflow bodies the code is truncated out of the prose. (Measured: today's
     *  two live forms happen to keep a matchable phrase inside the cap — the prose fallback would
     *  still fire — but that survives only until the wording changes; the structured code doesn't
     *  care. T1 review N2.) Parsed off the full
     *  body before that cap (providers/errors.ts). Core-internal — deliberately NOT mirrored onto
     *  the `agent_error` SessionEvent, so no protocol/Swift surface is engaged. */
    providerCode: z.string().optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export interface ModelInfo {
  id: string;
  family: string;
  contextWindow: number;
  supportsVision: boolean;
}

export type TurnInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; callId: string; name: string; argsJson: string }
  | { type: "tool_result"; callId: string; output: string; isError?: boolean }
  | { type: "reasoning"; itemJson: string }
  // A vision image fed to the model as a user message. `imageUrl` is a `data:image/png;base64,…`
  // URL — the EXACT `input_image` shape the CU spike verified against the Codex backend
  // (research/2026-07-03-cu-vision-spike.md). `alt` is optional caption text emitted as an
  // `input_text` part alongside the image. Originally Phase 5 CU-only (the `computer` tool's
  // screenshots); generalized (multimodal-read T1) to any vision-capable-model tool call — the
  // `read` tool's images and notebook image outputs ride the identical shape. Produced transiently
  // in-turn by the engine's image drain (never a persisted session event — see engine.ts's
  // pendingImages), so `eventToInput` has no case for it and cross-turn history never reconstructs
  // a past image.
  | { type: "image"; imageUrl: string; alt?: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema
}

export interface TurnRequest {
  model: string;
  instructions?: string;
  input: TurnInputItem[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  /** Reasoning-effort slug (settings.ts REASONING_EFFORTS: none/low/medium/high/xhigh/max — see
   *  that constant's own comment for why "ultra" is excluded and "minimal" was never added).
   *  Optional — omitted means no `reasoning` field is sent (openai-compatible.ts's
   *  buildRequestBody must stay byte-identical to today's body when this is unset). */
  reasoningEffort?: string;
}

export interface Provider {
  readonly id: string;
  models(): ModelInfo[];
  streamTurn(req: TurnRequest): AsyncIterable<ProviderEvent>;
}
