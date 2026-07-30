import { z } from "zod";

export const RpcId = z.union([z.number(), z.string()]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcResponseId = z.union([z.number(), z.string(), z.null()]);
export type RpcResponseId = z.infer<typeof RpcResponseId>;

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string(),
  params: z.unknown().optional(),
  // Remote Gateway SP1 Task 2: an optional client-generated idempotency key, a top-level sibling
  // of id/method/params (NOT inside params, so no per-method schema change). A flaky mobile link
  // means a phone may resend a request whose ack was lost — the daemon dedups remote mutating
  // RPCs per-connection by this key (see server.ts's data() pump). Ignored by every existing path
  // that doesn't read it; harness/plugin/local callers never send it.
  commandId: z.string().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcNotification = z.looseObject({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
}).refine((m) => !("id" in m), { message: "notifications must not carry an id" })
  .transform(({ jsonrpc, method, params }) => ({ jsonrpc, method, params }));
export type RpcNotification = z.infer<typeof RpcNotification>;

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export type RpcSuccess = { jsonrpc: "2.0"; id: RpcResponseId; result: unknown };
export type RpcFailure = { jsonrpc: "2.0"; id: RpcResponseId; error: RpcError };
export type RpcResponseShape = RpcSuccess | RpcFailure;

const RpcSuccessResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcResponseId,
  result: z.unknown(),
});
const RpcErrorResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcResponseId,
  error: RpcError,
});

export const RpcResponse = z
  .union([RpcSuccessResponse, RpcErrorResponse])
  .superRefine((m, ctx) => {
    const hasResult = "result" in m && m.result !== undefined;
    const hasError = "error" in m;
    if (hasResult === hasError) {
      ctx.addIssue({ code: "custom", message: "response must carry exactly one of result | error" });
    }
  })
  .transform((m): RpcResponseShape =>
    "error" in m
      ? { jsonrpc: m.jsonrpc, id: m.id, error: (m as { error: RpcError }).error }
      : { jsonrpc: m.jsonrpc, id: m.id, result: (m as { result: unknown }).result },
  );
export type RpcResponse = z.infer<typeof RpcResponse>;

export type Incoming =
  | { kind: "request"; msg: RpcRequest }
  | { kind: "notification"; msg: RpcNotification }
  | { kind: "response"; msg: RpcResponse };

export function parseIncoming(raw: unknown): Incoming {
  const o = z.looseObject({ jsonrpc: z.literal("2.0") }).parse(raw);
  if ("method" in o && "id" in o) return { kind: "request", msg: RpcRequest.parse(raw) };
  if ("method" in o) return { kind: "notification", msg: RpcNotification.parse(raw) };
  return { kind: "response", msg: RpcResponse.parse(raw) };
}

// Error codes (spec §5): JSON-RPC reserved + Norma application codes.
export const ERR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
  VERSION_MISMATCH: -32002,
  NOT_FOUND: -32004,
  ALREADY_ATTACHED: -32005,
  // Chat Slice D task 2 (session sync): the pushing client's `baseSeq` does not match the daemon's
  // own `lastSeq` for that session — the two logs have diverged and the daemon will NEVER silently
  // overwrite its copy. The error's `data` carries `{ lastSeq }` (the daemon's current head) so the
  // client can decide: pull and fast-forward, or fork a new session at its own divergence point.
  // A distinct numeric code (not INVALID_PARAMS) precisely because a client must be able to branch
  // on it programmatically without string-matching a message.
  DIVERGED: -32006,
} as const;
