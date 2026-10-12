import type { CoworkRepository } from "./repository";

export type CoworkPeerOperation = "send" | "list" | "stop";
export type CoworkMessagingRecords = Pick<CoworkRepository, "binding" | "project" | "get">;

/** Host records only: session metadata/tool arguments cannot assert Project membership.
 * SDK descendants remain under the runtime's own child authority. Membership never
 * authorizes stopping another top-level conversation. Cross-workspace and host
 * delegation stay refused until a separate host grant service is implemented. */
export function mayContactCoworkPeer(
  records: CoworkMessagingRecords | undefined,
  callerSessionId: string,
  targetSessionId: string,
  operation: CoworkPeerOperation,
): boolean {
  if (!records || operation === "stop" || callerSessionId === targetSessionId) return false;
  try {
    const caller = records.binding(callerSessionId), target = records.binding(targetSessionId);
    if (caller.sessionId !== callerSessionId || target.sessionId !== targetSessionId
      || caller.state !== "active" || target.state !== "active"
      || !caller.projectId || caller.projectId !== target.projectId
      || caller.workspaceId !== target.workspaceId) return false;
    const project = records.project(caller.projectId);
    return project.ownership === "project" && project.state === "retained"
      && project.ownerId === caller.projectId && project.workspaceId === caller.workspaceId;
  } catch { return false; }
}
