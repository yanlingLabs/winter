/** N2 S6 (UNWIRED): the production `observeResources()` for `CoworkAdmissionLedger` (`../admission`).
 *
 * The ledger calls `observeResources` synchronously inside its reservation transaction, so this observer does
 * only bounded, read-only sysctl reads and a read of the pressure guard's LAST snapshot. It never samples a
 * filesystem and never calls a halt port itself.
 *
 * Fail closed throughout: an unreadable memory-pressure level, a guard that has not evaluated, watches nothing,
 * or whose last evaluation is stale all give `pressure: "unknown"` and `admitNew: false`, which the ledger refuses.
 *
 * The BUDGET (how many guests, how much accounted memory and CPU) is product policy this slice does not invent:
 * it is an injected function of the host's physical memory and CPU count. */
import type { ResourceCommitment, ResourceObservation } from "../admission";
import type { SysctlReader } from "./admission-probes";

/** PROVISIONAL: how long one observation stays valid for the ledger's freshness check. */
export const RESOURCE_OBSERVATION_VALIDITY_MS = 5_000;
/** PROVISIONAL: the oldest guard evaluation the observer will trust before reporting `unknown` disk pressure. */
export const RESOURCE_DISK_SAMPLE_MAX_AGE_MS = 15_000;

export type ObservedPressure = ResourceObservation["pressure"];
export interface HostResourceFacts { readonly physicalMemoryBytes: number; readonly logicalCpus: number }
/** Returns the accounting budget, or null for "no budget decided". Chosen by the host, not here. */
export type ResourceBudgetPolicy = (facts: HostResourceFacts) => (ResourceCommitment & { guestLimit: number }) | null;
/** What the observer needs from `CoworkPressureGuard.snapshot()`. */
export interface DiskPressureSource {
  snapshot(): { readonly evaluatedAt: number | null; readonly entries: readonly { readonly state: "clear" | "blocked"; readonly observed: boolean }[] };
}
export interface ResourceObserverOptions {
  readonly sysctl: SysctlReader;
  readonly disk: DiskPressureSource;
  readonly budget: ResourceBudgetPolicy;
  readonly now?: () => number;
  readonly validityMs?: number;
  readonly maxDiskSampleAgeMs?: number;
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. Everything else is unknown. */
export function memoryPressureFromLevel(level: number | null): ObservedPressure {
  return level === 1 ? "normal" : level === 2 ? "elevated" : level === 4 ? "critical" : "unknown";
}
export function diskPressureFromSnapshot(snapshot: ReturnType<DiskPressureSource["snapshot"]>, now: number, maxAgeMs: number): ObservedPressure {
  if (!snapshot || snapshot.evaluatedAt === null || snapshot.entries.length === 0 || now < snapshot.evaluatedAt || now - snapshot.evaluatedAt > maxAgeMs || snapshot.entries.some(entry => !entry.observed)) return "unknown";
  return snapshot.entries.some(entry => entry.state === "blocked") ? "critical" : "normal";
}
const RANK: Record<ObservedPressure, number> = { normal: 0, elevated: 1, critical: 2, unknown: 3 };

export function createCoworkResourceObserver(options: ResourceObserverOptions): () => ResourceObservation | null {
  if (!options || typeof options.sysctl?.uint64 !== "function" || typeof options.disk?.snapshot !== "function" || typeof options.budget !== "function") throw new TypeError("resource_observer_ports");
  const now = options.now ?? Date.now, validity = options.validityMs ?? RESOURCE_OBSERVATION_VALIDITY_MS, maxAge = options.maxDiskSampleAgeMs ?? RESOURCE_DISK_SAMPLE_MAX_AGE_MS;
  if (!Number.isSafeInteger(validity) || validity < 1 || !Number.isSafeInteger(maxAge) || maxAge < 1) throw new RangeError("resource_observer_options");
  return () => {
    try {
      const memory = options.sysctl.uint64("hw.memsize"), cpus = options.sysctl.int32("hw.ncpu");
      if (memory === null || memory < 1n || memory > BigInt(Number.MAX_SAFE_INTEGER) || cpus === null || cpus < 1) return null;
      const budget = options.budget({ physicalMemoryBytes: Number(memory), logicalCpus: cpus });
      if (!budget || !Number.isSafeInteger(budget.memoryBytes) || budget.memoryBytes < 0 || !Number.isSafeInteger(budget.cpuUnits) || budget.cpuUnits < 0 || !Number.isSafeInteger(budget.guestLimit) || budget.guestLimit < 0 || budget.guestLimit > 4096) return null;
      let level: number | null = null;
      try { level = options.sysctl.int32("kern.memorystatus_vm_pressure_level"); } catch { level = null; } // an unreadable level is "unknown", not a missing observation
      const observedAt = now(), memoryPressure = memoryPressureFromLevel(level);
      const diskPressure = diskPressureFromSnapshot(options.disk.snapshot(), observedAt, maxAge);
      const pressure = RANK[memoryPressure] >= RANK[diskPressure] ? memoryPressure : diskPressure;
      return {
        budget: { memoryBytes: budget.memoryBytes, cpuUnits: budget.cpuUnits, guestLimit: budget.guestLimit },
        pressure, admitNew: pressure === "normal" || pressure === "elevated", observedAt, validUntil: observedAt + validity,
      };
    } catch { return null; }
  };
}
