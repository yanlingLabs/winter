import * as sdk from "@yanlinglabs/winter-agent-sdk";
import type { SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homeFenceFor } from "./home-fence";
import { controlPlaneFileTarget, homeFenceTarget, hostStorageReadTarget } from "./control-plane";
import { hostStorageFloorDescriptor, trackDaemonChildFloor, type HostStorageFloorDescriptor } from "./host-storage-fence";

/** Core retains credentials and cannot itself enter the tool sandbox. Apply the SAME host-owned
 * fence immediately before opening a model-selected path or dispatching it to a host consumer.
 * Explicit scan checks include ancestors; exact file/root checks retain ordinary files in a
 * broad granted root. LSP children separately inherit a kernel floor for descendant accesses.
 * This is defense in depth, not same-user disk confidentiality. */
export function assertDaemonPathAccess(home: string | undefined, path: string, cwd: string, access: "read" | "write" | "scan" = "read"): void {
  if (!home) return; // legacy standalone tool fixtures; every daemon consumer supplies its home
  const fence = homeFenceFor(home);
  const hit = hostStorageReadTarget(path, cwd, fence, access === "scan")
    ?? (access === "write" ? controlPlaneFileTarget(path, cwd) ?? homeFenceTarget(path, cwd, fence) : null);
  if (hit) throw new Error("Host file access refused: protected Winter storage is available only through trusted metadata and export services");
}

/** Check again AFTER an awaited server request and open without following a final-component link.
 * The opened descriptor's current name/identity is checked before any content is read. */
export function readDaemonTextFile(home: string | undefined, path: string): string {
  assertDaemonPathAccess(home, path, "/");
  const target = realpathSync(path);
  assertDaemonPathAccess(home, target, "/");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(target);
    if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("Host file changed before its content could be read");
    assertDaemonPathAccess(home, target, "/");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Ordinary approved escapes and plugin behavior keep their existing policy. This wraps only
 * retained Cowork/runtime-authority/coordination storage, and is inherited by child processes. */
const preparedFloors = new WeakMap<SpawnRuntimeOptions, { home: string; floor: HostStorageFloorDescriptor }>();
export function trackDaemonChildSpawn(home: string | undefined, options: SpawnRuntimeOptions, stop: () => void): () => void {
  if (!home) return () => {};
  const prepared = preparedFloors.get(options);
  if (!prepared || prepared.home !== home) throw new Error("Host child floor evidence missing");
  return trackDaemonChildFloor(home, prepared.floor, stop);
}
export type DaemonChildFloorApplier = (options: SpawnRuntimeOptions, floor: HostStorageFloorDescriptor) => SpawnRuntimeOptions;
export function daemonChildSpawnWithFloor(home: string | undefined, options: SpawnRuntimeOptions, applyFloor?: DaemonChildFloorApplier): SpawnRuntimeOptions {
  if (!home) return options;
  const floor = hostStorageFloorDescriptor(home);
  const remember = (result: SpawnRuntimeOptions) => {
    preparedFloors.set(result, { home, floor: structuredClone(floor) });
    return result;
  };
  if (!Object.values(floor).some(entries => entries.length)) return remember(options);
  if (applyFloor) return remember(applyFloor(options, floor)); // trusted integration-test adapter; daemon never supplies this
  const api = sdk as unknown as { MANDATORY_FLOOR_CONTRACT_VERSION?: number; applyMandatoryFloorToSpawnOptions?: (options: SpawnRuntimeOptions, floor: HostStorageFloorDescriptor) => SpawnRuntimeOptions };
  if (api.MANDATORY_FLOOR_CONTRACT_VERSION !== 1 || typeof api.applyMandatoryFloorToSpawnOptions !== "function") {
    throw new Error("Protected host child-process floor unavailable; refusing unprotected process creation");
  }
  return remember(api.applyMandatoryFloorToSpawnOptions(options, floor));
}
