import type { SessionEvent } from "@norma/protocol";
import { createProjector } from "../../src/projector";
import type { CheckpointStore, ProjectionKey, Projector, ProjectorDeps, ProtocolSdkMessage } from "../../src/projector";

/** An in-memory `ProjectionCheckpoints` with the same three-verdict `begin` contract. The real
 *  class is exercised against SQLite by `test/runtime-state/checkpoints.test.ts`; what these tests
 *  need is the VERDICT sequence, which a Map states exactly and a temp database only obscures. */
export class FakeCheckpoints implements CheckpointStore {
  readonly marks = new Map<string, "pending" | "committed">();
  readonly completed: string[] = [];
  /** Every source the projector claimed, in order — the replay assertions read this. */
  readonly begun: string[] = [];

  private k(key: ProjectionKey): string { return `${key.winterSessionId}/${key.generation}/${key.sourceId}`; }

  begin(key: ProjectionKey): "begun" | "already-committed" | "pending-elsewhere" {
    const k = this.k(key);
    const state = this.marks.get(k);
    if (state === "committed") return "already-committed";
    if (state === "pending") return "pending-elsewhere";
    this.marks.set(k, "pending");
    this.begun.push(key.sourceId);
    return "begun";
  }

  complete(key: ProjectionKey): unknown {
    const k = this.k(key);
    this.marks.set(k, "committed");
    this.completed.push(key.sourceId);
    return {};
  }
}

export interface TestProjector { projector: Projector; checkpoints: FakeCheckpoints; warnings: string[]; debugs: string[] }

export function makeProjector(overrides: Partial<ProjectorDeps> = {}): TestProjector {
  const checkpoints = (overrides.checkpoint as FakeCheckpoints | undefined) ?? new FakeCheckpoints();
  const warnings: string[] = [];
  const debugs: string[] = [];
  let seq = 0;
  const projector = createProjector({
    sessionId: "s_test",
    mode: "code",
    nextSeq: () => ++seq,
    checkpoint: checkpoints,
    now: () => "2026-09-11T00:00:00.000Z",
    log: { warn: (m) => { warnings.push(m); }, debug: (m) => { debugs.push(m); } },
    ...overrides,
    // `checkpoint` must be the instance we return, whatever the spread did.
    ...(overrides.checkpoint === undefined ? { checkpoint: checkpoints } : {}),
  });
  return { projector, checkpoints, warnings, debugs };
}

/** Feed a whole stream and collect every produced event, in order. */
export function run(projector: Projector, messages: ProtocolSdkMessage[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const m of messages) out.push(...projector.accept(m));
  projector.flush();
  return out;
}

// ── wire-message builders (the measured shapes; see test/projector/fixtures/sdk/) ───────────────

export const init = (over: Record<string, unknown> = {}): ProtocolSdkMessage => ({
  type: "system", subtype: "init", session_id: "be-1", cwd: "/tmp/x", model: "winter-test/echo",
  permissionMode: "default", tools: [], slash_commands: [], output_style: "default", skills: [],
  plugins: [], apiKeySource: "none", ...over,
} as unknown as ProtocolSdkMessage);

export const assistantText = (text: string, parent?: string): ProtocolSdkMessage => ({
  type: "assistant", message: { content: [{ type: "text", text }] },
  ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
} as unknown as ProtocolSdkMessage);

export const assistantToolUse = (id: string, name: string, input: unknown, parent?: string): ProtocolSdkMessage => ({
  type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] },
  ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
} as unknown as ProtocolSdkMessage);

export const toolResult = (toolUseId: string, content: unknown, extra: Record<string, unknown> = {}, parent?: string): ProtocolSdkMessage => ({
  // `role` deliberately omitted — the shape a real child emits.
  type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...extra }] },
  ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
} as unknown as ProtocolSdkMessage);

export const userTextFrame = (text: string): ProtocolSdkMessage => ({
  type: "user", message: { role: "user", content: [{ type: "text", text }] },
} as unknown as ProtocolSdkMessage);

export const textDelta = (text: string, parent: string | null = null): ProtocolSdkMessage => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  parent_tool_use_id: parent, uuid: `u-${text}`, session_id: "be-1",
} as unknown as ProtocolSdkMessage);

export const modelUsage = (input: number, output: number, cacheRead = 0) => ({
  "winter-test/echo": {
    inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, canonicalModel: "winter-test/echo",
    costBasis: "list",
  },
});

export const result = (over: Record<string, unknown> = {}): ProtocolSdkMessage => ({
  type: "result", subtype: "success", is_error: false, result: "", permission_denials: [], ...over,
} as unknown as ProtocolSdkMessage);
