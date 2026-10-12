import { homedir } from "node:os";
import { join } from "node:path";
import { hostStorageFenceOptions } from "../runtime-sdk/host-storage-fence";
import { CoworkFolderSelections, type FolderSelectionOptions } from "./folder-selections";
import { disabledCoworkHost, type CoworkHostPorts } from "./service";

/** Real local picker preparations feed the existing host-selection adapter. Provisioning remains
 * independently refused: ephemeral grants cannot be consumed as durable workspace sources yet. */
export function createMacCoworkHost(home: string, options?: FolderSelectionOptions): CoworkHostPorts {
  if (process.platform !== "darwin" && !options?.resolver) return disabledCoworkHost;
  const selections = new CoworkFolderSelections(options ?? { protectedRoots: () => {
    const fences = hostStorageFenceOptions(home), user = homedir();
    return [...fences.participatingHomes, fences.coordinationDir, join(user, ".ssh"), join(user, ".aws"), join(user, ".gnupg"), join(user, "Library/Keychains"), "/Library/Keychains"];
  } });
  return {
    ...disabledCoworkHost, selections,
    principal: connection => ["harness", "admin"].includes(connection.role) ? { kind: "local-user", id: `local-${connection.role}` } : undefined,
    selection: (principal, id, connection) => selections.selection(principal, connection.connectionId, id),
    grants: { folder: id => selections.folder(id), repository: () => undefined },
  };
}
