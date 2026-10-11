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
export const CoworkWorkspace = CoworkWorkspaceRecord.extend({
  policy: CoworkWorkspacePolicy, sources: z.array(CoworkSource).max(100), automaticPublication: z.boolean(),
});
export const CoworkProject = z.object({ projectId: Id, workspace: CoworkWorkspace });
export const CoworkSelection = z.object({ selectionId: Id, kind: z.enum(["folder", "githubRepository"]) }).strict();
const NewWorkspace = z.object({ requestId: Id, ownership: z.enum(["standalone", "project"]), title: Label, selections: z.array(CoworkSelection).min(1).max(100) }).strict();
const NewProject = NewWorkspace.omit({ ownership: true });
const WorkspaceId = z.object({ workspaceId: Id }).strict();
const Mutation = WorkspaceId.extend({ requestId: Id, expectedRevision: Revision });
const ProjectId = z.object({ projectId: Id }).strict();
const Page = z.object({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict();
const receipt = <T extends z.ZodType>(value: T) => z.object({ operationId: Id, workspaceId: Id, revision: Revision, value });
export const CoworkWorkspaceReceipt = receipt(CoworkWorkspace);
export const CoworkWorkspaceUpdateReceipt = receipt(CoworkWorkspaceRecord);
export const CoworkSourceReceipt = receipt(CoworkSource);
export const CoworkPolicyReceipt = receipt(CoworkWorkspacePolicy);
export const COWORK_RPC = {
  "workspace.list": { params: Page, result: z.object({ workspaces: z.array(CoworkWorkspace).max(100), nextCursor: Id.nullable() }) },
  "workspace.get": { params: WorkspaceId, result: CoworkWorkspace },
  "workspace.create": { params: NewWorkspace, result: CoworkWorkspaceReceipt },
  "workspace.update": { params: Mutation.extend({ title: Label }).strict(), result: CoworkWorkspaceUpdateReceipt },
  "project.list": { params: Page, result: z.object({ projects: z.array(CoworkProject).max(100), nextCursor: Id.nullable() }) },
  "project.get": { params: ProjectId, result: CoworkProject },
  "project.create": { params: NewProject, result: CoworkWorkspaceReceipt },
  "project.update": { params: ProjectId.extend({ requestId: Id, expectedRevision: Revision, title: Label }).strict(), result: CoworkWorkspaceUpdateReceipt },
  "workspace.source.list": { params: WorkspaceId, result: z.object({ sources: z.array(CoworkSource).max(100) }) },
  "workspace.source.get": { params: WorkspaceId.extend({ sourceId: Id }).strict(), result: CoworkSource },
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
  workspaceList: "workspace.list", workspaceGet: "workspace.get", workspaceCreate: "workspace.create", workspaceUpdate: "workspace.update",
  projectList: "project.list", projectGet: "project.get", projectCreate: "project.create", projectUpdate: "project.update",
  workspaceSourceList: "workspace.source.list", workspaceSourceGet: "workspace.source.get", workspaceSourceAddFolder: "workspace.source.addFolder",
  workspaceSourceAddRepository: "workspace.source.addRepository", workspaceSourceRemove: "workspace.source.remove", workspaceSourceRevoke: "workspace.source.revoke",
  workspaceSetDefaultPolicy: "workspace.setDefaultPolicy", projectSetDefaultPolicy: "project.setDefaultPolicy", workspaceSetCapabilityCeiling: "workspace.setCapabilityCeiling",
  workspaceSetPublicationPolicy: "workspace.setPublicationPolicy", workspaceOperationGet: "workspace.operation.get",
} as const;
/** Table membership permits routing only; current-record host authority remains mandatory. */
export const COWORK_REMOTE_METHODS = ["workspace.list", "workspace.get", "workspace.create", "workspace.update", "project.list", "project.get", "project.create", "project.update", "workspace.source.list", "workspace.source.get", "workspace.source.addRepository", "workspace.source.remove", "workspace.source.revoke", "workspace.operation.get"] as const;
