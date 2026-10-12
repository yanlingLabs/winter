/** Actual local SDK candidate + real provider adapters + byte packet helper. No native guest/startup claim. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoworkProviderBroker, type CoworkProviderRequest, type CoworkProviderScope } from "../../src/cowork/provider-broker";
import type { ResolvedModel } from "@yanlinglabs/winter-provider-runtime";
const candidate = process.env.COWORK_PROVIDER_PROXY_CANDIDATE;
const integration = candidate ? test : test.skip;
const KEY = "fixture-provider-secret-kept-on-host-only";
const scope: CoworkProviderScope = { homeId: "fixture-home", workspaceId: "fixture-workspace", sessionId: "logical-conversation", backendSessionId: "sdk-backend-session", taskId: "root-task", incarnationId: "incarnation", bootId: "guest-boot", leaseEpoch: 1, grantRevision: 1, accountRevision: 1, modelRevision: 1 };
const imports = async () => {
  const root = resolve(candidate!); const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  return { sdk: await load("packages/runtime/src/guest/provider-client.ts"), runtime: await load("packages/provider-runtime/src/index.ts"), catalog: await load("packages/provider-catalog/src/index.ts"), session: await load("packages/runtime/src/provider/session-provider.ts"), state: await load("packages/runtime/src/store/provider-state.ts") };
};
const sse = (values: Record<string, unknown>[]): Response => new Response(values.map(value => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const responseFrames = (first: boolean): Record<string, unknown>[] => first ? [
  { type: "response.created", response: { id: "response-first" } },
  { type: "response.reasoning_summary_text.delta", item_id: "reason-first", summary_index: 0, delta: "Readable summary" },
  { type: "response.output_item.done", output_index: 0, item: { id: "reason-first", type: "reasoning", summary: [], encrypted_content: "fixture-provider-opaque-continuation", status: "completed" } },
  { type: "response.output_item.added", output_index: 1, item: { id: "function-first", type: "function_call", call_id: "read-call", name: "Read", arguments: "" } },
  { type: "response.output_item.done", output_index: 1, item: { id: "function-first", type: "function_call", call_id: "read-call", name: "Read", arguments: '{"file_path":"fixture.txt"}' } },
  { type: "response.completed", response: { id: "response-first", status: "completed", usage: { input_tokens: 4, output_tokens: 3 }, output: [] } },
] : [
  { type: "response.created", response: { id: "response-second" } }, { type: "response.output_text.delta", delta: "Finished continuation" },
  { type: "response.completed", response: { id: "response-second", status: "completed", usage: { input_tokens: 9, output_tokens: 2 }, output: [] } },
];
const anthropicFrames = (first: boolean, model: string): Record<string, unknown>[] => [
  { type: "message_start", message: { id: first ? "message-first" : "message-second", model, usage: { input_tokens: 4, output_tokens: 0 } } },
  ...(first ? [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Signed fixture reasoning" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-real-provider-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "read-call", name: "Read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"fixture.txt"}' } }, { type: "content_block_stop", index: 1 },
  ] : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Finished continuation" } }, { type: "content_block_stop", index: 0 }]),
  { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" },
];
afterEach(() => { /* Every test owns and restores its fetch spy and Worker in finally. */ });

for (const scenario of [{ providerId: "openai", partial: false }, { providerId: "anthropic", partial: false }, { providerId: "openai", partial: true }]) integration(`real ${scenario.providerId} adapter -> framed helper -> SDK fold (${scenario.partial ? "partial failure without replay" : "two-turn store continuation"})`, async () => {
  const { providerId, partial } = scenario;
  const { sdk, runtime, catalog: catalogModule, session, state } = await imports();
  const catalog = catalogModule.loadCatalog(); const row = catalog.models.find((value: any) => value.providerId === providerId && value.status !== "blocked" && value.status !== "deprecated"); expect(row).toBeDefined();
  const registry = runtime.createRegistry(catalog); for (const adapter of runtime.createShippedAdapters(catalog)) registry.register(adapter);
  const resolved = registry.resolve({ model: row.key }) as ResolvedModel; expect(resolved.adapter).toBeDefined();
  const secrets = { get: async () => JSON.stringify({ kind: "api-key", key: KEY }), set: async () => {}, delete: async () => false };
  const logs: unknown[] = [], frames: string[] = [], bodies: any[] = []; let requests = 0;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const url = String(input); expect(url).toBe(providerId === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers); expect(headers.get(providerId === "openai" ? "authorization" : "x-api-key")).toBe(providerId === "openai" ? `Bearer ${KEY}` : KEY);
    bodies.push(JSON.parse(String(init?.body))); const first = requests++ === 0;
    if (partial) return sse([{ type: "response.created", response: { id: "partial" } }, { type: "response.output_text.delta", delta: "Partial actual output" }, { type: "response.failed", response: { error: { message: KEY, code: "server_error" } } }]);
    return sse(providerId === "openai" ? responseFrames(first) : anthropicFrames(first, resolved.providerModelId));
  }) as typeof globalThis.fetch);
  const broker = new CoworkProviderBroker({ secrets, assertCurrent: () => {}, log: value => logs.push(value) }); const lease = broker.open({ scope, resolved, authRef: { kind: "keychain", account: "fixture-only-slot" }, connection: { providerId } });
  const helper = new Worker(new URL("./fixtures/provider-frame-helper.ts", import.meta.url).href); const waiting = new Map<string, { resolve(value: Uint8Array): void; reject(error: Error): void }>();
  helper.onmessage = event => {
    const value = event.data;
    if (value.request) void lease.handle(value.request as CoworkProviderRequest).then(response => { helper.postMessage({ id: value.id, response }); });
    else { const pending = waiting.get(value.id); waiting.delete(value.id); if (value.frame) { frames.push(Buffer.from(value.frame).toString()); pending?.resolve(value.frame); } else pending?.reject(new Error("fixture helper refused")); }
  };
  const directory = mkdtempSync(join(tmpdir(), "cowork-provider-fold-"));
  try {
    const client = sdk.createGuestProviderClient({ scope, selection: { providerId, modelKey: resolved.modelKey, providerModelId: resolved.providerModelId, family: resolved.adapter.family, protocol: resolved.adapter.protocol, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}), capabilities: resolved.adapter.capabilities(resolved.descriptor!) }, port: {
      exchange(frame: Uint8Array) { frames.push(Buffer.from(frame).toString()); const id = randomUUID(); return new Promise<Uint8Array>((resolve, reject) => { waiting.set(id, { resolve, reject }); helper.postMessage({ id, frame }); }); },
      close() { lease.close(); for (const pending of waiting.values()) pending.reject(new Error("fixture closed")); waiting.clear(); },
    } });
    const wiring = session.buildSessionProvider({ config: { sessionId: scope.backendSessionId, model: resolved.modelKey, cwd: directory, winterHome: directory, permissionMode: "auto", provider: { providerId, authRef: { kind: "none" } } }, env: {}, catalog, guestProvider: client, readKeychainSecret: async () => { throw new Error("guest keychain access forbidden"); } });
    const provider = wiring.buildProvider(resolved); const sinks: unknown[] = []; const messages: any[] = [{ role: "user", content: "Read the fixture then report" }]; const tools = [{ name: "Read", description: "Fixture Read", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }];
    const pending = provider.generate({ messages, tools, sink: { onStreamEvent: (value: unknown) => sinks.push(value), onRateLimit: (value: unknown) => sinks.push(value), onRetry: (value: unknown) => sinks.push(value), onAuthStatus: (value: unknown) => sinks.push(value), onReasoningSummary: (value: unknown) => sinks.push(value), onReasoningProgress: (value: unknown) => sinks.push(value) } });
    if (partial) {
      await expect(pending).rejects.toThrow("host provider request failed"); expect(requests).toBe(1); expect(JSON.stringify(sinks)).toContain("Partial actual output"); expect(JSON.stringify({ frames, logs, sinks })).not.toContain(KEY); client.close(); return;
    }
    const turn = await pending;
    expect(turn.kind).toBe("tool_use"); expect(turn.calls).toEqual([{ id: "read-call", name: "Read", input: { file_path: "fixture.txt" } }]);
    if (providerId === "openai") { expect(JSON.stringify(turn.nativeState)).toContain("fixture-provider-opaque-continuation"); expect(turn.thinking.summary).toBe("Readable summary"); expect(turn.nativeState.family).toBe("openai"); }
    else { expect(turn.thinking.blocks).toContainEqual({ type: "thinking", thinking: "Signed fixture reasoning", signature: "fixture-real-provider-signature" }); }
    const sidecar = join(directory, "fixture.provider-state.jsonl"), base = { sessionId: scope.backendSessionId, anchorUuid: "assistant-first", provider: providerId, model: resolved.modelKey, family: resolved.adapter.family, continuationDomain: resolved.continuationDomain, itemIndex: 0 };
    state.appendProviderState(sidecar, { ...base, kind: "origin", payload: {} });
    if (turn.nativeState) state.appendProviderState(sidecar, { ...base, itemIndex: 1, kind: "native-state", payload: { items: turn.nativeState.items } });
    if (turn.thinking?.blocks) state.appendProviderState(sidecar, { ...base, itemIndex: 1, kind: "reasoning-blocks", payload: { blocks: turn.thinking.blocks.map((block: unknown, at: number) => ({ at, block })) } });
    const chain = state.buildContinuationChain(state.readProviderState(sidecar), new Set(["assistant-first"])); const restored = chain.get("assistant-first");
    // Inline signed blocks otherwise mask whether disk-restored reasoning is consumed.
    // Keep ordinary assistant content, and require the replay-critical blocks from the sidecar.
    const content = JSON.parse(JSON.stringify(turn.content ?? [...(turn.text ? [{ type: "text", text: turn.text }] : []), ...turn.calls.map((call: any) => ({ type: "tool_use", ...call }))]))
      .filter((block: any) => block.type !== "thinking" && block.type !== "redacted_thinking");
    if (providerId === "anthropic") {
      expect(JSON.stringify(content)).not.toContain("fixture-real-provider-signature");
      expect(JSON.stringify(restored.nativeState)).toContain("fixture-real-provider-signature");
    }
    messages.push({ role: "assistant", uuid: "assistant-first", origin: restored.origin, content, ...(restored.nativeState ? { nativeState: restored.nativeState } : {}) }, { role: "tool", content: [{ type: "tool_result", tool_use_id: "read-call", content: "Fixture file bytes" }] });
    const resumed = await provider.generate({ messages, tools }); expect(resumed.kind).toBe("text"); expect(resumed.text).toBe("Finished continuation"); expect(requests).toBe(2);
    expect(JSON.stringify(bodies[1])).toContain("read-call"); expect(JSON.stringify(bodies[1])).toContain("Fixture file bytes");
    expect(JSON.stringify(bodies[1])).toContain(providerId === "openai" ? "fixture-provider-opaque-continuation" : "fixture-real-provider-signature");
    expect(JSON.stringify(sinks)).not.toContain("fixture-provider-opaque-continuation"); expect(JSON.stringify(sinks)).not.toContain("fixture-real-provider-signature");
    expect(JSON.stringify({ frames, logs, sinks, store: readFileSync(sidecar, "utf8") })).not.toContain(KEY); client.close();
  } finally { lease.close(); helper.terminate(); fetch.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
