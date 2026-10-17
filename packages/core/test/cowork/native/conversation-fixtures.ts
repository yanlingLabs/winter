import type { CoworkNativeConversation, CoworkNativeConversationRoot } from "../../../src/cowork/native/protocol";
import type { CoworkNativeConversationContext, CoworkNativeConversationSet } from "../../../src/cowork/native/host";
import { sortedCanonical } from "../../../src/cowork/native/protocol";

// Synthetic conversation sets bound to a host context, for the host adapter tests (contract section 6.1). Nothing here is a real id.
const provider = (context: CoworkNativeConversationContext, logical: string, backend: string) => sortedCanonical({
  scope: { accountRevision: 7, backendSessionId: backend, bootId: context.guestBootId, grantRevision: 5, homeId: "home-fixture", incarnationId: context.incarnationId, leaseEpoch: context.leaseEpoch, modelRevision: 8, sessionId: logical, taskId: "task-0001", workspaceId: context.workspaceId },
  selection: { capabilities: ["tools", "streaming"], family: "family-alpha", modelKey: "model-alpha", protocol: "protocol-alpha", providerId: "provider-alpha", providerModelId: "provider-model-alpha" },
}) as Record<string, unknown>;
const authority = (context: CoworkNativeConversationContext, backend: string) => ({ workspaceId: context.workspaceId, sessionId: backend, incarnationId: context.incarnationId, leaseEpoch: context.leaseEpoch, configRevision: 4, grantRevision: 5, policyRevision: 6 });
const roots = (logical: string): CoworkNativeConversationRoot[] => [
  { id: "root-notes", guestPath: "/workspace/folders/notes", source: "/workspace/folders/notes", readOnly: false },
  { id: "root-outputs", guestPath: `/workspace/outputs/${logical}`, source: `/workspace/outputs/${logical}`, readOnly: false }];
export const guidedConversation = (context: CoworkNativeConversationContext, logical: string, backend: string, uid: number): CoworkNativeConversation => ({
  logicalSessionId: logical, authority: authority(context, backend), runtimeUid: uid, toolUid: uid + 1, workspaceGid: uid + 5000, policy: "auto", roots: roots(logical),
  runtime: { model: "model-alpha", timeoutMs: 600000, toolClasses: ["read", "write", "execute"], provider: provider(context, logical, backend), guided: { bindingId: "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b", generation: 1 } } });
export const guidedSet = (context: CoworkNativeConversationContext): CoworkNativeConversationSet => ({ profile: "host-query-guided-v1", conversations: [guidedConversation(context, "conv-0001", "backend-0001", 20000)] });
export const twoGuidedSet = (context: CoworkNativeConversationContext): CoworkNativeConversationSet => ({ profile: "host-query-guided-v1", conversations: [guidedConversation(context, "conv-0001", "backend-0001", 20000), guidedConversation(context, "conv-0002", "backend-0002", 20010)] });
export const toolsOnlySet = (context: CoworkNativeConversationContext): CoworkNativeConversationSet => ({ profile: null, conversations: ["conv-0001", "conv-0002"].map((logical, index) => ({
  logicalSessionId: logical, authority: authority(context, `backend-000${index + 1}`), runtimeUid: 20000 + index * 10, toolUid: 20001 + index * 10, workspaceGid: 25000 + index, policy: "plan" as const,
  roots: [{ id: "root-app", guestPath: "/workspace/repos/app", source: "/workspace/repos/app", readOnly: true }], runtime: null })) });
/** A guided set whose single conversation is padded past the 20,480 byte ceiling (many long root names). */
export const oversizedSet = (context: CoworkNativeConversationContext): CoworkNativeConversationSet => {
  const base = guidedConversation(context, "conv-0001", "backend-0001", 20000);
  const many = Array.from({ length: 16 }, (_, index) => ({ id: `root-${index}`, guestPath: `/workspace/folders/${"d".repeat(900)}${index}`, source: `/workspace/folders/${"s".repeat(900)}${index}`, readOnly: false }));
  return { profile: "host-query-guided-v1", conversations: [{ ...base, roots: many }] };
};
