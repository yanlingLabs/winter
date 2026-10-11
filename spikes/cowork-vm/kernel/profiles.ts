import pins from "../pins.json";

export type KernelProfileID = keyof typeof pins.kernelProfiles;
export const DEFAULT_KERNEL_PROFILE: KernelProfileID = "kata-6.12.28";
export function getKernelProfile(id: string) {
  if (!Object.hasOwn(pins.kernelProfiles, id)) throw new Error(`Unknown kernel profile: ${id}`);
  return pins.kernelProfiles[id as KernelProfileID];
}

/** Linux sysfs prints bit 0 first, not a conventional most-significant-first number. */
export function decodeBalloonFeatures(text: string) {
  const bits = text.trim();
  if (!/^[01]{6,128}$/.test(bits)) throw new Error("Invalid negotiated virtio feature bitstring");
  return {
    raw: bits, bitOrder: "least-feature-index-first" as const,
    mustTellHost: bits[0] === "1", statsQueue: bits[1] === "1", deflateOnOOM: bits[2] === "1",
    freePageHint: bits[3] === "1", pagePoison: bits[4] === "1", freePageReporting: bits[5] === "1",
    hostReclaimVerified: false,
  };
}

export function parseGuestMemoryDiagnostics(text: string) {
  const rows = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const devices = rows.filter(row => row.kind === "virtio-balloon").map(row => ({ ...row, negotiated: decodeBalloonFeatures(row.features) }));
  return { rows, devices, reportingNegotiated: devices.some(row => row.negotiated.freePageReporting), hostReclaimVerified: false };
}
