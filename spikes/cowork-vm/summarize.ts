import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryObservation } from "./evidence";

const fixture = process.argv[2], output = process.argv[3];
if (!fixture || !output) throw new Error("usage: bun summarize.ts <fixture> <summary.json>");
const phases = ["prepare", "smoke", "resume", "direct", "memory", "memory-compact"];
const reports = phases.map(phase => JSON.parse(readFileSync(join(fixture, `${phase}-report.json`), "utf8")));
const config = JSON.parse(readFileSync(join(fixture, "config.json"), "utf8"));
function categoryExcerpt(sample: any) {
  const footprint = String(sample.categories?.footprintCategories ?? "").split("\n");
  const vmmap = String(sample.categories?.vmmapSummary ?? "").split("\n");
  return {
    label: sample.label,
    footprintColumns: footprint.find(line => /Dirty\s+\(Swapped\).*Reclaimable/.test(line))?.trim(),
    footprintAppTag: footprint.find(line => /^\s*\d+ B.*app-specific tag 1$/.test(line))?.trim(),
    vmmapColumns: vmmap.filter(line => /^\s*VIRTUAL RESIDENT|^REGION TYPE/.test(line)).map(line => line.trim()),
    vmmapTag: vmmap.find(line => /^Memory Tag 240\s+[\d.]/.test(line))?.trim(),
  };
}
const summary = {
  schema: 1,
  scope: "offline compiled-Bun/Swift embedding and disposable guest fixtures",
  gate1Passed: false,
  productionCoworkImplemented: false,
  measurementConditions: { nativeBuild: "Swift debug", hostCache: "warm", guestExecution: "one VM at a time, sequential tool views" },
  inputs: { containerizationRevision: config.containerizationRevision, initImage: config.initImage, rootImage: config.rootImage, kernelArchive: config.kernelArchive, payloadDigests: config.payloadDigests },
  phases: reports.map(report => {
    const memory = report.phase.startsWith("memory") ? memoryObservation(report) : undefined;
    const { backingPid: _omittedPid, ...safeMemory } = (memory ?? {}) as any;
    return {
      phase: report.phase, status: report.status, startedAt: report.startedAt, completedAt: report.completedAt,
      guestReadyMs: report.readyMs, maxHeartbeatDelayMs: report.maxHeartbeatDelayMs,
      network: report.phase === "prepare" ? "public host provisioning" : "no guest NIC",
      stop: report.stop === undefined ? undefined : { stopped: report.stop.stopped, vzStoppedObserved: report.stop.vzStoppedObserved, flushSucceeded: report.stop.flushSucceeded },
      confinementViews: report.confinementRecords?.filter((row: any) => row.kind === "summary"),
      directViews: report.directRecords?.filter((row: any) => row.kind === "summary"),
      denialClasses: report.confinementRecords ? Object.fromEntries(["EROFS", "EACCES", "EPERM", "ENOENT", "EXDEV", "EBUSY"].map(failureClass => [failureClass, report.confinementRecords.filter((row: any) => row.denial?.failureClass === failureClass).length])) : undefined,
      builtSharePolicy: report.checks.find((row: any) => row.name === "guest-ready")?.detail?.shares?.map(({ guestPath, readOnly }: any) => ({ guestPath, readOnly })),
      strictSourceMetadataUnchanged: report.directMetadata ? JSON.stringify(report.directMetadata.before) === JSON.stringify(report.directMetadata.after) : undefined,
      coldIdentityChangedAndContentVerified: report.phase === "resume" && report.status === "passed-selected-checks" ? true : undefined,
      ...(memory ? { memory: safeMemory } : {}),
      ...(memory ? { passiveCategoryCapture: report.samples.map((sample: any) => ({ label: sample.label, footprint: typeof sample.categories?.footprintCategories === "string" && !sample.categories.footprintCategories.startsWith("unavailable"), vmmap: typeof sample.categories?.vmmapSummary === "string" && !sample.categories.vmmapSummary.startsWith("unavailable") })) } : {}),
      ...(memory ? { passiveCategoryExcerpts: report.samples.map(categoryExcerpt) } : {}),
      ...(memory ? { guestMemorySamples: report.samples.map((sample: any) => ({ label: sample.label, counters: String(sample.guest).split("\n").filter(line => /^(MemTotal|MemAvailable|AnonPages|SwapFree):|^balloon_|^compact_(migrate_scanned|free_scanned)/.test(line)) })) } : {}),
    };
  }),
  limitations: [
    "Guest boot readiness excludes image provisioning, library loading and a real Winter agent runtime.",
    "Tool identities exercised sequentially; no concurrent Project conversation or multiple-VM claim.",
    "Host-backed owner-only source fixture; mixed ownership, ACLs, TCC and revocation untested.",
    "No guest NIC is not a validated outbound network enforcement boundary.",
    "Balloon guest compliance and host footprint are distinct; tested memory return was not demonstrated.",
    "Other host applications/VMs and compression/swap were present; not a controlled system-wide memory benchmark.",
    "Ad-hoc C ABI/FFI probe is not production Node-API/signing/daemon integration.",
  ],
};
writeFileSync(output, JSON.stringify(summary, null, 2) + "\n");
console.log(`Wrote sanitized measurement summary: ${output}`);
