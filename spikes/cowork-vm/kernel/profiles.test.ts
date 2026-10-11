import { expect, test } from "bun:test";
import { DEFAULT_KERNEL_PROFILE, decodeBalloonFeatures, getKernelProfile, parseGuestMemoryDiagnostics } from "./profiles";

test("profiles retain historical default and pin the released matching recommendation", () => {
  expect(DEFAULT_KERNEL_PROFILE).toBe("kata-6.12.28");
  const kernel = getKernelProfile("apple-6.18.35");
  expect(kernel.version).toBe("6.18.35-197-debug");
  expect(kernel.archiveSha256).toBe("8736c054d9223974735394f822000823baef509e1c33405ec798240fa9b6e4b5");
  expect(() => getKernelProfile("../../arbitrary" )).toThrow();
  expect(() => getKernelProfile("toString")).toThrow();
});

test("Linux negotiated sysfs feature bits are indexed left to right", () => {
  const features = decodeBalloonFeatures("110001" + "0".repeat(58));
  expect(features.mustTellHost).toBe(true);
  expect(features.statsQueue).toBe(true);
  expect(features.freePageHint).toBe(false);
  expect(features.freePageReporting).toBe(true);
  expect(features.hostReclaimVerified).toBe(false);
  expect(decodeBalloonFeatures("000100" + "0".repeat(58)).freePageHint).toBe(true);
  expect(() => decodeBalloonFeatures("0x20")).toThrow();
});

test("diagnostics distinguish reporting negotiation from host reclaim", () => {
  const result = parseGuestMemoryDiagnostics('{"kind":"kernel","release":"6.18.35"}\n{"kind":"virtio-balloon","features":"000001' + "0".repeat(58) + '"}\n');
  expect(result.devices).toHaveLength(1);
  expect(result.reportingNegotiated).toBe(true);
  expect(result.hostReclaimVerified).toBe(false);
  expect(parseGuestMemoryDiagnostics('{"kind":"balloon-discovery","found":false}\n').reportingNegotiated).toBe(false);
});
