import { CoworkError, type WorkspaceSource } from "./types";

/** Canonical guest spellings only; never resolve a host filesystem path here. */
export function coworkGuestSourceRoot(source: WorkspaceSource): string {
  const segment = source.kind === "folder" ? source.detail.grantRef : source.detail.repositoryId;
  if (typeof segment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(segment)) throw new CoworkError("invalid_request");
  return source.kind === "folder" ? `/workspace/folders/${segment}` : `/workspace/repos/${segment}`;
}
