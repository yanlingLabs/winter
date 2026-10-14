import { z } from "zod";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Label = z.string().min(1).max(200).refine(value => value.trim().length > 0 && !/[\0\r\n]/.test(value));
const Policy = z.enum(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);
export const CoworkCapabilityCeiling = z.object({
  toolClasses: z.array(Label).max(256), hostServices: z.array(Label).max(256),
  connectors: z.array(Label).max(256), network: z.enum(["none", "internet"]),
}).strict();
export const CoworkWorkspacePolicy = z.object({
  policyId: Id, workspaceId: Id, defaultPolicy: Policy,
  publication: z.enum(["github-only-feature-branches", "manual"]), ceiling: CoworkCapabilityCeiling,
  revision: Revision, defaultRevision: Revision, publicationRevision: Revision,
});
/** No host roots, bookmarks, backing paths, grant handles or authority references. */
export const CoworkSource = z.object({
  sourceId: Id, workspaceId: Id, locationId: Id, kind: z.enum(["folder", "githubRepository"]), label: Label,
  access: z.enum(["read-only", "read-write"]), desired: z.enum(["present", "removed"]),
  state: z.enum(["preparing", "ready", "unavailable", "removing", "detached"]), revision: Revision,
  ackRevision: Revision.nullable(), reason: z.enum(["access_revoked"]).nullable(), restartRequired: z.boolean(),
  trust: z.enum(["untrusted", "trusted", "revoked"]), createdAt: z.string(), updatedAt: z.string(),
});
export const CoworkWorkspaceRecord = z.object({
  workspaceId: Id, ownership: z.enum(["standalone", "project"]), ownerId: Id, title: Label,
  state: z.enum(["retained", "archived", "deleting", "deleted"]), configRevision: Revision,
  grantRevision: Revision, instructionRevision: Revision, leaseEpoch: z.number().int().nonnegative(),
  power: z.enum(["stopped", "starting", "running", "draining", "uncertain"]), createdAt: z.string(), updatedAt: z.string(),
});
export const CoworkPolicySummary = CoworkWorkspacePolicy.omit({ ceiling: true }).extend({
  capabilityCounts: z.object({ toolClasses: z.number().int().nonnegative(), hostServices: z.number().int().nonnegative(), connectors: z.number().int().nonnegative() }), network: z.enum(["none", "internet"]),
});
export const CoworkCompleteWorkspace = CoworkWorkspaceRecord.extend({
  detailState: z.literal("complete"), policy: CoworkWorkspacePolicy, sources: z.array(CoworkSource).max(100), automaticPublication: z.boolean(),
}).strict();
/** Summary fields are display/recovery metadata, never effective capability authority. */
export const CoworkSummaryWorkspace = CoworkWorkspaceRecord.extend({
  detailState: z.literal("summary"), detailReason: z.literal("response_limit"), policySummary: CoworkPolicySummary,
  sourceCount: z.number().int().nonnegative(), automaticPublication: z.boolean(),
  detailMethods: z.object({ sources: z.literal("workspace.source.list"), policy: z.literal("workspace.policy.get") }),
}).strict();
export const CoworkWorkspace = z.discriminatedUnion("detailState", [CoworkCompleteWorkspace, CoworkSummaryWorkspace]);
export const CoworkProject = z.object({ projectId: Id, workspace: CoworkWorkspace });
export const CoworkSelection = z.object({ selectionId: Id, kind: z.enum(["folder", "githubRepository"]) }).strict();
const NewWorkspace = z.object({ requestId: Id, ownership: z.enum(["standalone", "project"]), title: Label, selections: z.array(CoworkSelection).min(1).max(100) }).strict();
const NewProject = NewWorkspace.omit({ ownership: true });
const WorkspaceId = z.object({ workspaceId: Id }).strict();
const WorkspaceDetailPage = WorkspaceId.extend({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(100), expectedRevision: Revision.optional() }).strict();
const Mutation = WorkspaceId.extend({ requestId: Id, expectedRevision: Revision });
const ProjectId = z.object({ projectId: Id }).strict();
const Page = z.object({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict();
const receipt = <T extends z.ZodType>(value: T) => z.object({ operationId: Id, workspaceId: Id, revision: Revision, value });
export const CoworkWorkspaceReceipt = receipt(CoworkCompleteWorkspace);
export const CoworkWorkspaceUpdateReceipt = receipt(CoworkWorkspaceRecord);
export const CoworkSourceReceipt = receipt(CoworkSource);
export const CoworkPolicyValue = z.discriminatedUnion("detailState", [
  CoworkWorkspacePolicy.extend({ detailState: z.literal("complete") }).strict(),
  z.object({ detailState: z.literal("summary"), detailReason: z.literal("response_limit"), policySummary: CoworkPolicySummary, detailMethod: z.literal("workspace.policy.get") }).strict(),
]);
export const CoworkPolicyReceipt = receipt(CoworkPolicyValue);
export const CoworkCapabilities = z.object({ folderPreparation: z.boolean(), repositoryPreparation: z.literal(false), provisioning: z.literal(false), execution: z.literal(false) }).strict();
export const CoworkPreparedFolder = z.object({ selectionId: Id, kind: z.literal("folder"), label: Label, access: z.enum(["read-only", "read-write"]), state: z.literal("prepared"), expiresAt: z.string() }).strict();
export const CoworkScheduleDefinition = z.object({
  target: z.discriminatedUnion("kind", [z.object({ kind: z.literal("conversation"), sessionId: Id }).strict(), z.object({ kind: z.literal("project"), projectId: Id }).strict()]),
  sourceId: Id, prompt: z.string().min(1).max(8192).refine(value => !value.includes("\0")),
  timing: z.discriminatedUnion("kind", [z.object({ kind: z.literal("once"), at: z.number().int().nonnegative().max(8640000000000000) }).strict(), z.object({ kind: z.literal("recurring"), spec: z.string().min(1).max(200) }).strict()]),
  timezone: z.string().min(1).max(100), savedCeiling: CoworkCapabilityCeiling,
  policy: Policy, overlap: z.literal("one-active-one-pending"), branchPrecondition: z.string().min(1).max(200).optional(),
}).strict();
export const CoworkSchedule = z.object({ scheduleId: Id, workspaceId: Id, definition: CoworkScheduleDefinition,
  state: z.enum(["enabled", "cancelled", "handled"]), revision: Revision, nextDue: z.number().nullable(), createdAt: z.number() }).strict();
export const CoworkQuarantinedSchedule = z.object({ scheduleId: Id, workspaceId: Id, state: z.literal("quarantined"),
  revision: Revision, createdAt: z.number(), nextDue: z.null(), reason: z.literal("invalid_schedule"), cancelled: z.boolean() }).strict();
export const CoworkScheduleView = z.union([CoworkSchedule, CoworkQuarantinedSchedule]);
export type CoworkScheduleView = z.infer<typeof CoworkScheduleView>;
export const CoworkScheduleOccurrence = z.object({ occurrenceId: Id, scheduleId: Id, dueAt: z.number(), latestDueAt: z.number(), missedCount: z.number().int().nonnegative(),
  state: z.enum(["pending", "claimed", "dispatching", "uncertain", "handled", "cancelled"]),
  reason: z.enum(["execution_unavailable", "shutdown", "archived", "source_unavailable", "authority_denied", "branch_mismatch", "branch_state_unavailable", "recovery_required", "invalid_schedule"]).nullable() }).strict();
export type CoworkScheduleDefinition = z.infer<typeof CoworkScheduleDefinition>;
export type CoworkSchedule = z.infer<typeof CoworkSchedule>;
export type CoworkScheduleOccurrence = z.infer<typeof CoworkScheduleOccurrence>;
/** Host shared guidance is bounded UTF-8 user content, never capability authority. */
export const COWORK_INSTRUCTION_MAX_BYTES = 65536;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CoworkInstructionUpdate = WorkspaceId.extend({ requestId: Id, expectedInstructionRevision: Revision, expectedDigest: Digest,
  content: z.string().refine(value => !value.includes("\0") && new TextEncoder().encode(value).length <= COWORK_INSTRUCTION_MAX_BYTES && new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value),
}).strict();
export const CoworkInstructionMetadata = z.object({ workspaceId: Id, instructionRevision: Revision, digest: Digest, bytes: z.number().int().min(0).max(COWORK_INSTRUCTION_MAX_BYTES), refreshState: z.enum(["refresh-required", "unavailable"]) }).strict();
export const CoworkInstructionRead = CoworkInstructionMetadata.extend({ contentBase64: z.string().max(87384), encoding: z.literal("utf-8") }).strict();
export const CoworkInstructionProvenance = CoworkInstructionMetadata.extend({ entries: z.array(z.object({ kind: z.literal("workspace"), guestPath: z.literal("/workspace/.winter/WINTER.md"), digest: Digest }).strict()).length(1), sourceDiscovery: z.literal("unavailable") }).strict();
export const CoworkInstructionReceipt = receipt(CoworkInstructionMetadata);
/** Local recorded-output inventory only; this never enumerates filesystem entries. */
export const COWORK_FILE_CHUNK_MAX_BYTES = 256 * 1024;
// Conservative local response budget also stays below the existing 128 KiB service guard.
export const COWORK_FILE_CHUNK_DEFAULT_BYTES = 64 * 1024;
export const CoworkOutputLocation = z.object({ workspaceId: Id, sessionId: Id, locationId: Id,
  kind: z.literal("conversation-outputs"), revision: Revision }).strict();
export const CoworkOutputPage = z.object({ locations: z.array(CoworkOutputLocation).max(100), nextCursor: z.string().max(200).nullable() }).strict();
export const CoworkOutputPath = z.string().min(1).max(4096).refine(value => {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value) return false;
  const parts = value.split("/");
  return parts.length <= 32 && parts.every(part => part !== "" && part !== "." && part !== ".." && Buffer.byteLength(part, "utf8") <= 255);
});
const FileRequest = WorkspaceId.extend({ locationId: Id, relativePath: CoworkOutputPath, expectedLocationRevision: Revision }).strict();
export const CoworkOutputFileStat = z.object({ workspaceId: Id, locationId: Id, relativePath: CoworkOutputPath,
  locationRevision: Revision, generation: Digest, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), kind: z.literal("file") }).strict();
export const CoworkOutputFileChunk = CoworkOutputFileStat.extend({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), eof: z.boolean(), contentBase64: z.string().max(349528).refine(value => Buffer.from(value, "base64").toString("base64") === value && Buffer.from(value, "base64").length <= COWORK_FILE_CHUNK_MAX_BYTES), encoding: z.literal("base64") }).strict().refine(value => value.nextOffset >= value.offset && value.nextOffset <= value.bytes && value.nextOffset - value.offset === Buffer.from(value.contentBase64, "base64").length && value.eof === (value.nextOffset === value.bytes));
const FileReadRequest = FileRequest.extend({ expectedGeneration: Digest, maxBytes: z.number().int().min(1).max(COWORK_FILE_CHUNK_MAX_BYTES).default(COWORK_FILE_CHUNK_DEFAULT_BYTES) }).strict();
export const COWORK_RPC = {
  "workspace.output.list": { params: WorkspaceId.extend({ cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), result: CoworkOutputPage },
  "workspace.file.stat": { params: FileRequest, result: CoworkOutputFileStat },
  "workspace.file.read": { params: FileReadRequest, result: CoworkOutputFileChunk },
  "workspace.file.readRange": { params: FileReadRequest.extend({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(), result: CoworkOutputFileChunk },
  "workspace.instructions.get": { params: WorkspaceId, result: CoworkInstructionRead },
  "workspace.instructions.provenance": { params: WorkspaceId, result: CoworkInstructionProvenance },
  "workspace.instructions.update": { params: CoworkInstructionUpdate, result: CoworkInstructionReceipt },
  "workspace.schedule.create": { params: WorkspaceId.extend({ requestId: Id, definition: CoworkScheduleDefinition }).strict(), result: CoworkSchedule },
  "workspace.schedule.list": { params: WorkspaceId.extend({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), result: z.object({ schedules: z.array(CoworkScheduleView).max(100), nextCursor: Id.nullable() }).strict() },
  "workspace.schedule.cancel": { params: WorkspaceId.extend({ scheduleId: Id, expectedRevision: Revision }).strict(), result: CoworkScheduleView },
  "workspace.schedule.status": { params: WorkspaceId.extend({ scheduleId: Id }).strict(), result: z.object({ schedule: CoworkScheduleView, occurrences: z.array(CoworkScheduleOccurrence).max(100), execution: z.literal("unavailable") }).strict() },
  "workspace.capabilities.get": { params: z.object({}).strict(), result: CoworkCapabilities },
  "workspace.selection.prepareFolder": { params: z.object({ requestId: Id, bookmarkBase64: z.string().min(4).max(87384).regex(/^[A-Za-z0-9+/]+={0,2}$/), label: Label, access: z.enum(["read-only", "read-write"]) }).strict(), result: CoworkPreparedFolder },
  "workspace.selection.revoke": { params: z.object({ selectionId: Id }).strict(), result: z.object({ revoked: z.literal(true) }).strict() },
  "workspace.list": { params: Page, result: z.object({ workspaces: z.array(CoworkWorkspace).max(100), nextCursor: Id.nullable() }) },
  "workspace.get": { params: WorkspaceId, result: CoworkWorkspace },
  "workspace.create": { params: NewWorkspace, result: CoworkWorkspaceReceipt },
  "workspace.update": { params: Mutation.extend({ title: Label }).strict(), result: CoworkWorkspaceUpdateReceipt },
  "project.list": { params: Page, result: z.object({ projects: z.array(CoworkProject).max(100), nextCursor: Id.nullable() }) },
  "project.get": { params: ProjectId, result: CoworkProject },
  "project.create": { params: NewProject, result: CoworkWorkspaceReceipt },
  "project.update": { params: ProjectId.extend({ requestId: Id, expectedRevision: Revision, title: Label }).strict(), result: CoworkWorkspaceUpdateReceipt },
  "workspace.source.list": { params: WorkspaceDetailPage, result: z.object({ sources: z.array(CoworkSource).max(100), nextCursor: Id.nullable() }) },
  "workspace.source.get": { params: WorkspaceId.extend({ sourceId: Id }).strict(), result: CoworkSource },
  "workspace.policy.get": { params: WorkspaceDetailPage, result: z.object({ policy: CoworkPolicySummary, entries: z.array(z.object({ kind: z.enum(["toolClasses", "hostServices", "connectors"]), name: Label })).max(100), nextCursor: Id.nullable() }) },
  "workspace.source.addFolder": { params: Mutation.extend({ selectionId: Id }).strict(), result: CoworkSourceReceipt },
  "workspace.source.addRepository": { params: Mutation.extend({ selectionId: Id }).strict(), result: CoworkSourceReceipt },
  "workspace.source.remove": { params: Mutation.extend({ sourceId: Id }).strict(), result: CoworkSourceReceipt },
  "workspace.source.revoke": { params: Mutation.extend({ sourceId: Id }).strict(), result: CoworkSourceReceipt },
  "workspace.setDefaultPolicy": { params: Mutation.extend({ defaultPolicy: Policy }).strict(), result: CoworkPolicyReceipt },
  "project.setDefaultPolicy": { params: ProjectId.extend({ requestId: Id, expectedRevision: Revision, defaultPolicy: Policy }).strict(), result: CoworkPolicyReceipt },
  "workspace.setCapabilityCeiling": { params: Mutation.extend({ ceiling: CoworkCapabilityCeiling }).strict(), result: CoworkPolicyReceipt },
  "workspace.setPublicationPolicy": { params: Mutation.extend({ publication: z.enum(["github-only-feature-branches", "manual"]) }).strict(), result: CoworkPolicyReceipt },
  "workspace.operation.get": { params: WorkspaceId.extend({ operationId: Id }).strict(), result: z.object({ operationId: Id, workspaceId: Id, revision: Revision, status: z.enum(["pending", "applied", "blocked", "failed", "superseded"]), terminal: z.boolean() }) },
} as const;
export type CoworkMethod = keyof typeof COWORK_RPC;
export type CoworkParams<M extends CoworkMethod> = z.input<(typeof COWORK_RPC)[M]["params"]>;
export type CoworkResult<M extends CoworkMethod> = z.output<(typeof COWORK_RPC)[M]["result"]>;
export type CoworkWorkspaceRecord = z.infer<typeof CoworkWorkspaceRecord>;
export type CoworkWorkspace = z.infer<typeof CoworkWorkspace>;
export type CoworkSource = z.infer<typeof CoworkSource>;
export type CoworkWorkspacePolicy = z.infer<typeof CoworkWorkspacePolicy>;
export const COWORK_METHODS = {
  workspaceOutputList: "workspace.output.list", workspaceFileStat: "workspace.file.stat", workspaceFileRead: "workspace.file.read", workspaceFileReadRange: "workspace.file.readRange",
  workspaceInstructionsGet: "workspace.instructions.get", workspaceInstructionsProvenance: "workspace.instructions.provenance", workspaceInstructionsUpdate: "workspace.instructions.update",
  workspaceScheduleCreate: "workspace.schedule.create", workspaceScheduleList: "workspace.schedule.list", workspaceScheduleCancel: "workspace.schedule.cancel", workspaceScheduleStatus: "workspace.schedule.status",
  workspaceCapabilitiesGet: "workspace.capabilities.get", workspaceSelectionPrepareFolder: "workspace.selection.prepareFolder", workspaceSelectionRevoke: "workspace.selection.revoke",
  workspaceList: "workspace.list", workspaceGet: "workspace.get", workspaceCreate: "workspace.create", workspaceUpdate: "workspace.update",
  projectList: "project.list", projectGet: "project.get", projectCreate: "project.create", projectUpdate: "project.update",
  workspaceSourceList: "workspace.source.list", workspaceSourceGet: "workspace.source.get", workspaceSourceAddFolder: "workspace.source.addFolder",
  workspaceSourceAddRepository: "workspace.source.addRepository", workspaceSourceRemove: "workspace.source.remove", workspaceSourceRevoke: "workspace.source.revoke",
  workspaceSetDefaultPolicy: "workspace.setDefaultPolicy", projectSetDefaultPolicy: "project.setDefaultPolicy", workspaceSetCapabilityCeiling: "workspace.setCapabilityCeiling",
  workspaceSetPublicationPolicy: "workspace.setPublicationPolicy", workspaceOperationGet: "workspace.operation.get",
  workspacePolicyGet: "workspace.policy.get",
} as const;
/** Table membership permits routing only; current-record host authority remains mandatory. */
export const COWORK_REMOTE_METHODS = ["workspace.list", "workspace.get", "workspace.create", "workspace.update", "project.list", "project.get", "project.create", "project.update", "workspace.source.list", "workspace.source.get", "workspace.policy.get", "workspace.source.addRepository", "workspace.source.remove", "workspace.source.revoke", "workspace.operation.get"] as const;
