import type { RuntimeStateDb } from "../../runtime-state/db";
import type { CoworkPrincipal } from "../authority";
import { CoworkError } from "../types";
import { timeMachineVolumeBackup, type CoworkVolumeBackup } from "../volume-backup";
import { CoworkVolumes, type CoworkVolumeAuthority, type CoworkVolumeError } from "../volumes";

import type { CoworkGuestRuntimeOffer, CoworkProvisioningPort } from "../session-ports";
import type { CoworkNativeGuestRecords } from "../native/guest-records";
import { ensureSharedDirectories } from "./guest-dirs";

/*
 * The guest offer and the provisioning port (N2 S7B part 1, items 7 and 8; part 3 types them by the session door's own ports). The shapes are DOOR's
 * (`cowork/session-ports.ts`, imported here), so what this module returns is exactly what the door's service calls.
 *
 * NOTHING in the daemon builds either unless the production native environment exists (the activation seam is off). The offer is derived from the VERIFIED image the
 * host will launch (the digest pin and the facts that image's manifest proves), never from a constant: an image that is not verified, or that does not prove the
 * confined posture, offers nothing, so no tool that needs the guest compartment is ever named.
 */

export type { CoworkGuestRuntimeOffer, CoworkProvisioningPort };
/** What the installed, signature-verified runtime image proves about itself. The reader that produces it (the image lane's manifest check) is injected; this module trusts nothing else. */
export interface CoworkVerifiedGuestImage {
  readonly baseImageDigest: string;
  readonly runtimeImageDigest: string;
  readonly runtimeCapability: { readonly protocolVersion: number; readonly capabilities: readonly string[]; readonly supportsConfinedGuestExecution: boolean };
}
export const COWORK_CONFINED_POSTURE_CAPABILITY = "confined-guest-posture-v1";

/** Null (no offer) unless the image proves protocol 1 AND the confined guest posture, the same two facts `GuestRuntime` itself requires of a guest's hello. */
export function coworkGuestRuntimeOffer(image: CoworkVerifiedGuestImage | null): CoworkGuestRuntimeOffer | null {
  const capability = image?.runtimeCapability;
  if (!image || capability?.protocolVersion !== 1 || capability.supportsConfinedGuestExecution !== true || !Array.isArray(capability.capabilities) || !capability.capabilities.includes(COWORK_CONFINED_POSTURE_CAPABILITY)) return null;
  const capabilities = [...new Set(capability.capabilities.filter((name): name is string => typeof name === "string"))].sort();
  return { profile: "host-query-v1", readiness: ["guest-compartment"], runtimeCapability: { protocolVersion: 1, capabilities, supportsConfinedGuestExecution: true } };
}

/**
 * The allocate authority. The native `CoworkVolumeAuthority` refuses `allocate` on purpose (a launch never creates disks), so provisioning gets its own, which
 * permits `allocate` and nothing else: it cannot claim, open or release a disk, and it never confirms a stop.
 */
export const coworkAllocateAuthority: CoworkVolumeAuthority = { authorize: action => action === "allocate", verifyStopped: () => false };

/** Sparse images (their blocks are allocated as the guest writes): 8 GiB of data, 4 GiB for the environment. Both are multiples of 4096 and inside the volume store's bounds. */
export const COWORK_PROVISION_CAPACITIES = Object.freeze({ data: 8 * 1024 ** 3, environment: 4 * 1024 ** 3 });
const PROVISION_OWNER = { controllerInstanceId: "provision", workerInstanceId: "provision", incarnationId: "provision", leaseEpoch: 1 } as const;

export interface CoworkProvisioningOptions {
  readonly db: RuntimeStateDb;
  readonly home: string;
  /** False until the production native environment exists; the port is only as available as this says. */
  readonly environmentActive: () => boolean;
  /** The installed image's verified facts, or null. */
  readonly image: () => CoworkVerifiedGuestImage | null;
  /** Records the pin (the lifecycle authority behind it is the caller's). Idempotent for the same digests, a mismatch throws. */
  readonly pin: (workspaceId: string, digests: { baseImageDigest: string; runtimeImageDigest: string }) => unknown;
  readonly backup?: CoworkVolumeBackup;
  /** Keeps the data volume's filesystem UUID per workspace (write-once; CR4 step 9). Absent: not kept here (the first start keeps it). */
  readonly guestRecords?: Pick<CoworkNativeGuestRecords, "recordStoreVolumeUuid">;
  readonly capacities?: { data: number; environment: number };
}

export function createCoworkProvisioningPort(options: CoworkProvisioningOptions): CoworkProvisioningPort {
  const volumes = new CoworkVolumes(options.db, options.home, coworkAllocateAuthority, options.backup ?? timeMachineVolumeBackup);
  const capacities = options.capacities ?? COWORK_PROVISION_CAPACITIES;
  const available = (): boolean => { try { return options.environmentActive() === true && coworkGuestRuntimeOffer(options.image()) !== null; } catch { return false; } };
  return {
    available,
    admit() { if (!available()) throw new CoworkError("unsupported_topology"); },
    async provision(workspaceId, _operationId) {
      const image = options.image();
      if (!available() || image === null) return { status: "failed", reason: "unsupported_topology" };
      try {
        // Idempotent per workspace: an already-allocated pair is left exactly as it is (the operation id only names the retry).
        const existing = volumes.records(workspaceId);
        if (existing.length !== 2 || existing.some(volume => volume.state !== "allocated")) {
          volumes.allocate({ workspaceId, proof: {}, owner: { ...PROVISION_OWNER, runtimeImageDigest: image.runtimeImageDigest } }, capacities);
        }
        // The shared directories the host-backed shares are served from (guidance, memory, outputs), made once, owned by this user, never through a symlink.
        ensureSharedDirectories(options.home, workspaceId);
        const data = volumes.records(workspaceId).find(volume => volume.purpose === "data");
        if (options.guestRecords !== undefined && data?.filesystemUUID != null && options.guestRecords.recordStoreVolumeUuid(workspaceId, data.filesystemUUID) === "mismatch") return { status: "failed", reason: "store_volume_mismatch" };
        options.pin(workspaceId, { baseImageDigest: image.baseImageDigest, runtimeImageDigest: image.runtimeImageDigest });
        return { status: "applied" };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        return { status: "failed", reason: typeof code === "string" ? code : "provision_failed" };
      }
    },
  };
}
