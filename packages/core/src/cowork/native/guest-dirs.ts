/*
 * The rules for the directories the host makes for a conversation (N2 S7B, DOOR's NEEDS from D3b and the plan view); the file-system code is `host-env/guest-dirs.ts`.
 *
 *  - The outputs directory: `<outputs share root>/<logicalSessionId>`, made on the HOST where the outputs share is served from (contract revision 3: the outputs share is a
 *    host directory under the workspace's `shared/`), before the conversation set that names it is sent. Idempotent, and it never follows a symlink: an existing entry that is
 *    not a real directory, or a root that is not one, refuses. It is opened with O_NOFOLLOW|O_DIRECTORY and checked on its own descriptor. The group ownership the guest
 *    sees is the folder server's mapping (the host user cannot chown to a guest gid), so no chown is attempted here.
 *  - The plan view `/workspace/plan/<logicalSessionId>/<epoch>` is a GUEST-side directory (it lives on the data disk, not on a share): PID 1 creates it root-side
 *    when the set names it. The host's part is the rule below: an epoch is never mounted again once a later one was.
 */

export class CoworkGuestDirectoryError extends Error {
  constructor(readonly code: "invalid_name" | "not_directory" | "wrong_owner" | "root_unusable" | "stale_epoch") { super(code); this.name = "CoworkGuestDirectoryError"; }
}

/** `/workspace/plan/<logicalSessionId>/<epoch>` (exactly that, epoch a canonical non-negative decimal), or null. */
export function parseCoworkPlanView(guestPath: string): { readonly logicalSessionId: string; readonly epoch: number } | null {
  const match = /^\/workspace\/plan\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(0|[1-9][0-9]{0,8})$/.exec(guestPath);
  return match ? { logicalSessionId: match[1]!, epoch: Number(match[2]) } : null;
}

/** An epoch is never mounted again once a later one was seen for the same workspace and conversation (a stale plan scratch must not come back). The same epoch is
 *  fine (a restart of the same plan). In memory, so this is defence in depth only: the DOOR policy machine holds the durable epoch and always passes the current one; after a daemon restart this guard starts empty and DOOR's record is the authority. */
export class CoworkPlanEpochGuard {
  private readonly seen = new Map<string, number>();
  admit(workspaceId: string, logicalSessionId: string, epoch: number): void {
    const key = `${workspaceId}\u0000${logicalSessionId}`, last = this.seen.get(key);
    if (last !== undefined && epoch < last) throw new CoworkGuestDirectoryError("stale_epoch");
    this.seen.set(key, Math.max(epoch, last ?? 0));
  }
}
